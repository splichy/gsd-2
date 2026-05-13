import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSubprocessModule, buildSubprocessPrefixArgs } from "./ts-subprocess-flags.js";
import { safePackageRootFromImportUrl } from "./safe-import-meta-resolve.js";
import {
  SESSION_BROWSER_SCOPE,
  normalizeSessionBrowserQuery
} from "../../web/lib/session-browser-contract.js";
import { authFilePath } from "../app-paths.js";
import { getProjectSessionsDir } from "../project-sessions.js";
import {
  collectOnboardingState,
  registerOnboardingBridgeAuthRefresher
} from "./onboarding-service.js";
import {
  collectAuthoritativeAutoDashboardData,
  collectTestOnlyFallbackAutoDashboardData
} from "./auto-dashboard-service.js";
import { resolveGsdCliEntry } from "./cli-entry.js";
let _defaultPackageRoot;
function getDefaultPackageRoot() {
  if (_defaultPackageRoot !== void 0) return _defaultPackageRoot;
  _defaultPackageRoot = safePackageRootFromImportUrl(import.meta.url) ?? process.cwd();
  return _defaultPackageRoot;
}
function resetDefaultPackageRootForTests() {
  _defaultPackageRoot = void 0;
}
const RESPONSE_TIMEOUT_MS = 3e4;
const START_TIMEOUT_MS = 15e4;
const MAX_STDERR_BUFFER = 8e3;
const WORKSPACE_INDEX_CACHE_TTL_MS = 3e4;
const READ_ONLY_RPC_COMMAND_TYPES = /* @__PURE__ */ new Set([
  "get_state",
  "get_available_models",
  "get_session_stats",
  "get_messages",
  "get_last_assistant_text",
  "get_fork_messages",
  "get_commands"
]);
function fuzzyMatch(query, text) {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const matchQuery = (normalizedQuery) => {
    if (normalizedQuery.length === 0) {
      return { matches: true, score: 0 };
    }
    if (normalizedQuery.length > textLower.length) {
      return { matches: false, score: 0 };
    }
    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;
    for (let index = 0; index < textLower.length && queryIndex < normalizedQuery.length; index++) {
      if (textLower[index] !== normalizedQuery[queryIndex]) continue;
      const isWordBoundary = index === 0 || /[\s\-_./:]/.test(textLower[index - 1]);
      if (lastMatchIndex === index - 1) {
        consecutiveMatches++;
        score -= consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
        if (lastMatchIndex >= 0) {
          score += (index - lastMatchIndex - 1) * 2;
        }
      }
      if (isWordBoundary) {
        score -= 10;
      }
      score += index * 0.1;
      lastMatchIndex = index;
      queryIndex++;
    }
    if (queryIndex < normalizedQuery.length) {
      return { matches: false, score: 0 };
    }
    return { matches: true, score };
  };
  const primaryMatch = matchQuery(queryLower);
  if (primaryMatch.matches) {
    return primaryMatch;
  }
  const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumericMatch ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}` : numericAlphaMatch ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}` : "";
  if (!swappedQuery) {
    return primaryMatch;
  }
  const swappedMatch = matchQuery(swappedQuery);
  if (!swappedMatch.matches) {
    return primaryMatch;
  }
  return { matches: true, score: swappedMatch.score + 5 };
}
function normalizeWhitespaceLower(text) {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
function getSessionSearchText(session) {
  return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}
function hasSessionName(session) {
  return Boolean(session.name?.trim());
}
function parseSessionSearchQuery(query) {
  const trimmed = query.trim();
  if (!trimmed) {
    return { mode: "tokens", tokens: [], regex: null };
  }
  if (trimmed.startsWith("re:")) {
    const pattern = trimmed.slice(3).trim();
    if (!pattern) {
      return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
    }
    try {
      return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { mode: "regex", tokens: [], regex: null, error: message };
    }
  }
  const tokens = [];
  let buffer = "";
  let inQuote = false;
  let hadUnclosedQuote = false;
  const flush = (kind) => {
    const value = buffer.trim();
    buffer = "";
    if (!value) return;
    tokens.push({ kind, value });
  };
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index];
    if (!character) continue;
    if (character === '"') {
      if (inQuote) {
        flush("phrase");
        inQuote = false;
      } else {
        flush("fuzzy");
        inQuote = true;
      }
      continue;
    }
    if (!inQuote && /\s/.test(character)) {
      flush("fuzzy");
      continue;
    }
    buffer += character;
  }
  if (inQuote) {
    hadUnclosedQuote = true;
  }
  if (hadUnclosedQuote) {
    return {
      mode: "tokens",
      tokens: trimmed.split(/\s+/).map((value) => value.trim()).filter((value) => value.length > 0).map((value) => ({ kind: "fuzzy", value })),
      regex: null
    };
  }
  flush(inQuote ? "phrase" : "fuzzy");
  return { mode: "tokens", tokens, regex: null };
}
function matchSessionSearch(session, parsed) {
  const text = getSessionSearchText(session);
  if (parsed.mode === "regex") {
    if (!parsed.regex) {
      return { matches: false, score: 0 };
    }
    const index = text.search(parsed.regex);
    if (index < 0) {
      return { matches: false, score: 0 };
    }
    return { matches: true, score: index * 0.1 };
  }
  if (parsed.tokens.length === 0) {
    return { matches: true, score: 0 };
  }
  let totalScore = 0;
  let normalizedText = null;
  for (const token of parsed.tokens) {
    if (token.kind === "phrase") {
      if (normalizedText === null) {
        normalizedText = normalizeWhitespaceLower(text);
      }
      const phrase = normalizeWhitespaceLower(token.value);
      if (!phrase) continue;
      const index = normalizedText.indexOf(phrase);
      if (index < 0) {
        return { matches: false, score: 0 };
      }
      totalScore += index * 0.1;
      continue;
    }
    const fuzzy = fuzzyMatch(token.value, text);
    if (!fuzzy.matches) {
      return { matches: false, score: 0 };
    }
    totalScore += fuzzy.score;
  }
  return { matches: true, score: totalScore };
}
function filterAndSortSessions(sessions, query, sortMode, nameFilter) {
  const nameFiltered = nameFilter === "all" ? sessions : sessions.filter((session) => hasSessionName(session));
  const trimmed = query.trim();
  if (!trimmed) {
    return nameFiltered;
  }
  const parsed = parseSessionSearchQuery(query);
  if (parsed.error) {
    return [];
  }
  if (sortMode === "recent") {
    const filtered = [];
    for (const session of nameFiltered) {
      const result = matchSessionSearch(session, parsed);
      if (result.matches) {
        filtered.push(session);
      }
    }
    return filtered;
  }
  const scored = [];
  for (const session of nameFiltered) {
    const result = matchSessionSearch(session, parsed);
    if (!result.matches) continue;
    scored.push({ session, score: result.score });
  }
  scored.sort((left, right) => {
    if (left.score !== right.score) {
      return left.score - right.score;
    }
    return right.session.modified.getTime() - left.session.modified.getTime();
  });
  return scored.map((entry) => entry.session);
}
function detectMonorepo(dirPath, checkExists) {
  const exists = checkExists ?? (getBridgeDeps().existsSync ?? existsSync);
  if (exists(join(dirPath, "pnpm-workspace.yaml"))) return true;
  if (exists(join(dirPath, "lerna.json"))) return true;
  if (exists(join(dirPath, "rush.json"))) return true;
  if (exists(join(dirPath, "nx.json"))) return true;
  if (exists(join(dirPath, "turbo.json"))) return true;
  const packageJsonPath = join(dirPath, "package.json");
  if (exists(packageJsonPath)) {
    try {
      const raw = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.workspaces != null) return true;
    } catch {
    }
  }
  return false;
}
function detectProjectKind(projectCwd) {
  const checkExists = getBridgeDeps().existsSync ?? existsSync;
  const hasGsdFolder = checkExists(join(projectCwd, ".gsd"));
  const hasPlanningFolder = checkExists(join(projectCwd, ".planning"));
  const hasGitRepo = checkExists(join(projectCwd, ".git"));
  const hasPackageJson = checkExists(join(projectCwd, "package.json"));
  const hasCargo = checkExists(join(projectCwd, "Cargo.toml"));
  const hasGoMod = checkExists(join(projectCwd, "go.mod"));
  const hasPyproject = checkExists(join(projectCwd, "pyproject.toml"));
  const isMonorepo = detectMonorepo(projectCwd, checkExists);
  let fileCount = 0;
  try {
    const entries = readdirSync(projectCwd);
    fileCount = entries.filter((e) => !e.startsWith(".")).length;
  } catch {
  }
  const signals = {
    hasGsdFolder,
    hasPlanningFolder,
    hasGitRepo,
    hasPackageJson,
    hasCargo,
    hasGoMod,
    hasPyproject,
    isMonorepo,
    fileCount
  };
  let kind;
  if (hasGsdFolder) {
    const milestonesDir = join(projectCwd, ".gsd", "milestones");
    let hasMilestones = false;
    try {
      const dirs = readdirSync(milestonesDir, { withFileTypes: true });
      hasMilestones = dirs.some((d) => d.isDirectory());
    } catch {
    }
    kind = hasMilestones ? "active-gsd" : "empty-gsd";
  } else if (hasPlanningFolder) {
    kind = "v1-legacy";
  } else if (hasPackageJson || hasCargo || hasGoMod || hasPyproject || fileCount > 2 || hasGitRepo && fileCount > 0) {
    kind = "brownfield";
  } else {
    kind = "blank";
  }
  return { kind, signals };
}
const defaultBridgeServiceDeps = {
  spawn: (command, args, options) => spawn(command, args, options),
  existsSync,
  execPath: process.execPath,
  env: process.env,
  indexWorkspace: (basePath) => fallbackWorkspaceIndex(basePath),
  getAutoDashboardData: async () => {
    const deps = getBridgeDeps();
    const env = deps.env ?? process.env;
    const config = resolveBridgeRuntimeConfig(env);
    return await collectAuthoritativeAutoDashboardData(config.packageRoot, {
      execPath: deps.execPath ?? process.execPath,
      env,
      existsSync: deps.existsSync ?? existsSync
    });
  },
  listSessions: async (projectSessionsDir) => listProjectSessions(projectSessionsDir)
};
let bridgeServiceOverrides = null;
const projectBridgeRegistry = /* @__PURE__ */ new Map();
const workspaceIndexCache = /* @__PURE__ */ new Map();
async function loadSessionBrowserSessionsViaChildProcess(config) {
  const deps = getBridgeDeps();
  const sessionManagerModulePath = join(config.packageRoot, "packages", "pi-coding-agent", "dist", "core", "session-manager.js");
  const checkExists = deps.existsSync ?? existsSync;
  if (!checkExists(sessionManagerModulePath)) {
    throw new Error(`session manager module not found; checked=${sessionManagerModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    "const mod = await import(pathToFileURL(process.env.GSD_SESSION_MANAGER_MODULE).href);",
    "const sessions = await mod.SessionManager.list(process.env.GSD_SESSION_BROWSER_CWD, process.env.GSD_SESSION_BROWSER_DIR);",
    "process.stdout.write(JSON.stringify(sessions.map((session) => ({ ...session, created: session.created.toISOString(), modified: session.modified.toISOString() }))));"
  ].join(" ");
  return await new Promise((resolveResult, reject) => {
    execFile(
      deps.execPath ?? process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: config.packageRoot,
        env: {
          ...deps.env ?? process.env,
          GSD_SESSION_MANAGER_MODULE: sessionManagerModulePath,
          GSD_SESSION_BROWSER_CWD: config.projectCwd,
          GSD_SESSION_BROWSER_DIR: config.projectSessionsDir
        },
        maxBuffer: 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`session list subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolveResult(
            parsed.map((session) => ({
              ...session,
              created: new Date(session.created),
              modified: new Date(session.modified)
            }))
          );
        } catch (parseError) {
          reject(
            new Error(
              `session list subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`
            )
          );
        }
      }
    );
  });
}
async function appendSessionInfoViaChildProcess(config, sessionPath, name) {
  const deps = getBridgeDeps();
  const sessionManagerModulePath = join(config.packageRoot, "packages", "pi-coding-agent", "dist", "core", "session-manager.js");
  const checkExists = deps.existsSync ?? existsSync;
  if (!checkExists(sessionManagerModulePath)) {
    throw new Error(`session manager module not found; checked=${sessionManagerModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    "const mod = await import(pathToFileURL(process.env.GSD_SESSION_MANAGER_MODULE).href);",
    "const manager = mod.SessionManager.open(process.env.GSD_TARGET_SESSION_PATH, process.env.GSD_SESSION_BROWSER_DIR);",
    "manager.appendSessionInfo(process.env.GSD_TARGET_SESSION_NAME);"
  ].join(" ");
  await new Promise((resolveResult, reject) => {
    execFile(
      deps.execPath ?? process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: config.packageRoot,
        env: {
          ...deps.env ?? process.env,
          GSD_SESSION_MANAGER_MODULE: sessionManagerModulePath,
          GSD_SESSION_BROWSER_DIR: config.projectSessionsDir,
          GSD_TARGET_SESSION_PATH: sessionPath,
          GSD_TARGET_SESSION_NAME: name
        },
        maxBuffer: 1024 * 1024,
        windowsHide: true
      },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`session rename subprocess failed: ${stderr || error.message}`));
          return;
        }
        resolveResult();
      }
    );
  });
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function serializeJsonLine(value) {
  return `${JSON.stringify(value)}
`;
}
function attachJsonLineReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emitLine = (line) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const onData = (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };
  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}
function redactSensitiveText(value) {
  return value.replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]").replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]").replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET)["'=:\s]+)([^\s,;"']+)/gi, "$1[redacted]");
}
function sanitizeErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(raw).replace(/\s+/g, " ").trim();
}
function captureStderr(buffer, chunk) {
  const next = `${buffer}${chunk}`;
  return next.length <= MAX_STDERR_BUFFER ? next : next.slice(next.length - MAX_STDERR_BUFFER);
}
function buildExitMessage(code, signal, stderrBuffer) {
  const base = `RPC bridge exited${code !== null ? ` with code ${code}` : ""}${signal ? ` (${signal})` : ""}`;
  const stderr = redactSensitiveText(stderrBuffer).trim();
  return stderr ? `${base}. stderr=${stderr}` : base;
}
function destroyChildStreams(child) {
  try {
    child?.stdin?.destroy();
  } catch {
  }
  try {
    child?.stdout?.destroy();
  } catch {
  }
  try {
    child?.stderr?.destroy();
  } catch {
  }
}
function getBridgeDeps() {
  return { ...defaultBridgeServiceDeps, ...bridgeServiceOverrides ?? {} };
}
function cloneWorkspaceIndex(index) {
  return structuredClone(index);
}
function invalidateWorkspaceIndexCache(basePath) {
  if (basePath) {
    workspaceIndexCache.delete(basePath);
    return;
  }
  workspaceIndexCache.clear();
}
async function loadCachedWorkspaceIndex(basePath, loader) {
  const cached = workspaceIndexCache.get(basePath);
  const now = Date.now();
  if (cached?.value && cached.expiresAt > now) {
    return cloneWorkspaceIndex(cached.value);
  }
  if (cached?.promise) {
    return cloneWorkspaceIndex(await cached.promise);
  }
  const promise = loader().then((index) => {
    workspaceIndexCache.set(basePath, {
      value: cloneWorkspaceIndex(index),
      expiresAt: Date.now() + WORKSPACE_INDEX_CACHE_TTL_MS,
      promise: null
    });
    return index;
  }).catch((error) => {
    workspaceIndexCache.delete(basePath);
    throw error;
  });
  workspaceIndexCache.set(basePath, {
    value: cached?.value ?? null,
    expiresAt: 0,
    promise
  });
  return cloneWorkspaceIndex(await promise);
}
async function loadWorkspaceIndexViaChildProcess(basePath, packageRoot) {
  const deps = getBridgeDeps();
  const checkExists = deps.existsSync ?? existsSync;
  const resolveTsLoader = join(packageRoot, "src", "resources", "extensions", "gsd", "tests", "resolve-ts.mjs");
  const moduleResolution = resolveSubprocessModule(
    packageRoot,
    "resources/extensions/gsd/workspace-index.ts",
    checkExists
  );
  const workspaceModulePath = moduleResolution.modulePath;
  if (!moduleResolution.useCompiledJs && (!checkExists(resolveTsLoader) || !checkExists(workspaceModulePath))) {
    throw new Error(`workspace index loader not found; checked=${resolveTsLoader},${workspaceModulePath}`);
  }
  if (moduleResolution.useCompiledJs && !checkExists(workspaceModulePath)) {
    throw new Error(`workspace index module not found; checked=${workspaceModulePath}`);
  }
  const script = [
    'const { pathToFileURL } = await import("node:url");',
    "const mod = await import(pathToFileURL(process.env.GSD_WORKSPACE_MODULE).href);",
    "const result = await mod.indexWorkspace(process.env.GSD_WORKSPACE_BASE);",
    "process.stdout.write(JSON.stringify(result));"
  ].join(" ");
  const prefixArgs = buildSubprocessPrefixArgs(
    packageRoot,
    moduleResolution,
    pathToFileURL(resolveTsLoader).href
  );
  return await new Promise((resolveResult, reject) => {
    execFile(
      deps.execPath ?? process.execPath,
      [
        ...prefixArgs,
        "--eval",
        script
      ],
      {
        cwd: packageRoot,
        env: {
          ...deps.env ?? process.env,
          GSD_WORKSPACE_MODULE: workspaceModulePath,
          GSD_WORKSPACE_BASE: basePath
        },
        maxBuffer: 1024 * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`workspace index subprocess failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`workspace index subprocess returned invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
        }
      }
    );
  });
}
function legacyOnboardingStateFromNeeded(onboardingNeeded) {
  return {
    status: onboardingNeeded ? "blocked" : "ready",
    locked: onboardingNeeded,
    lockReason: onboardingNeeded ? "required_setup" : null,
    required: {
      blocking: true,
      skippable: false,
      satisfied: !onboardingNeeded,
      satisfiedBy: onboardingNeeded ? null : { providerId: "legacy", source: "runtime" },
      providers: []
    },
    optional: {
      blocking: false,
      skippable: true,
      sections: []
    },
    lastValidation: null,
    activeFlow: null,
    bridgeAuthRefresh: {
      phase: "idle",
      strategy: null,
      startedAt: null,
      completedAt: null,
      error: null
    }
  };
}
function parseSessionInfo(path) {
  try {
    const lines = readFileSync(path, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean);
    let id = "";
    let cwd = "";
    let name;
    let created = statSync(path).birthtime;
    let messageCount = 0;
    for (const line of lines) {
      const parsed = JSON.parse(line);
      if (parsed.type === "session") {
        id = typeof parsed.id === "string" ? parsed.id : id;
        cwd = typeof parsed.cwd === "string" ? parsed.cwd : cwd;
        if (typeof parsed.timestamp === "string") {
          created = new Date(parsed.timestamp);
        }
      } else if (parsed.type === "session_info" && typeof parsed.name === "string") {
        name = parsed.name;
      } else if (parsed.type === "message") {
        messageCount += 1;
      }
    }
    if (!id) return null;
    return {
      path,
      id,
      cwd,
      name,
      created,
      modified: statSync(path).mtime,
      messageCount
    };
  } catch {
    return null;
  }
}
function listProjectSessions(projectSessionsDir) {
  if (!existsSync(projectSessionsDir)) return [];
  const sessions = readdirSync(projectSessionsDir).filter((entry) => entry.endsWith(".jsonl")).map((entry) => parseSessionInfo(join(projectSessionsDir, entry))).filter((entry) => entry !== null);
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}
async function fallbackWorkspaceIndex(basePath) {
  const packageRoot = resolveBridgeRuntimeConfig().packageRoot;
  return await loadWorkspaceIndexViaChildProcess(basePath, packageRoot);
}
function resolveBridgeRuntimeConfig(env = getBridgeDeps().env ?? process.env, projectCwdOverride) {
  const projectCwd = projectCwdOverride || env.GSD_WEB_PROJECT_CWD || process.cwd();
  const projectSessionsDir = env.GSD_WEB_PROJECT_SESSIONS_DIR || getProjectSessionsDir(projectCwd);
  const packageRoot = env.GSD_WEB_PACKAGE_ROOT || getDefaultPackageRoot();
  return { projectCwd, projectSessionsDir, packageRoot };
}
function resolveBridgeCliEntry(config, deps) {
  return resolveGsdCliEntry({
    packageRoot: config.packageRoot,
    cwd: config.projectCwd,
    execPath: deps.execPath ?? process.execPath,
    hostKind: (deps.env ?? process.env).GSD_WEB_HOST_KIND,
    mode: "rpc",
    sessionDir: config.projectSessionsDir,
    existsSync: deps.existsSync ?? existsSync
  });
}
function isRpcExtensionUiResponse(input) {
  return input.type === "extension_ui_response";
}
function isReadOnlyBridgeInput(input) {
  if (isRpcExtensionUiResponse(input)) {
    return false;
  }
  return READ_ONLY_RPC_COMMAND_TYPES.has(input.type);
}
function buildBridgeLockedResponse(input, onboarding) {
  const reason = onboarding.lockReason ?? "required_setup";
  const error = reason === "bridge_refresh_failed" ? "Workspace is locked because bridge auth refresh failed after setup" : reason === "bridge_refresh_pending" ? "Workspace is still locked while bridge auth refresh completes" : "Workspace is locked until required onboarding completes";
  return {
    type: "response",
    command: input.type,
    success: false,
    error,
    code: "onboarding_locked",
    details: {
      reason,
      onboarding: {
        locked: onboarding.locked,
        lockReason: onboarding.lockReason,
        required: onboarding.required,
        lastValidation: onboarding.lastValidation,
        bridgeAuthRefresh: onboarding.bridgeAuthRefresh
      }
    }
  };
}
function sanitizeRpcResponse(response) {
  if (response.success) return response;
  return { ...response, error: redactSensitiveText(response.error) };
}
function sanitizeEventPayload(payload) {
  if (typeof payload === "object" && payload !== null && "type" in payload && payload.type === "extension_error") {
    const extensionError = payload;
    return { ...extensionError, error: redactSensitiveText(extensionError.error) };
  }
  return payload;
}
function uniqueLiveStateDomains(domains) {
  return [...new Set(domains)];
}
function buildLiveStateInvalidationEvent(descriptor) {
  return {
    type: "live_state_invalidation",
    at: nowIso(),
    reason: descriptor.reason,
    source: descriptor.source,
    domains: uniqueLiveStateDomains(descriptor.domains),
    workspaceIndexCacheInvalidated: Boolean(descriptor.workspaceIndexCacheInvalidated)
  };
}
function createLiveStateInvalidationFromBridgeEvent(event) {
  if (typeof event !== "object" || event === null || !("type" in event)) {
    return null;
  }
  switch (event.type) {
    case "agent_end":
      return {
        reason: "agent_end",
        source: "bridge_event",
        domains: ["auto", "workspace", "recovery"],
        workspaceIndexCacheInvalidated: true
      };
    case "turn_end":
      return {
        reason: "turn_end",
        source: "bridge_event",
        domains: ["workspace"],
        workspaceIndexCacheInvalidated: true
      };
    case "auto_retry_start":
      return {
        reason: "auto_retry_start",
        source: "bridge_event",
        domains: ["auto", "recovery"]
      };
    case "auto_retry_end":
      return {
        reason: "auto_retry_end",
        source: "bridge_event",
        domains: ["auto", "recovery"]
      };
    case "auto_compaction_start":
      return {
        reason: "auto_compaction_start",
        source: "bridge_event",
        domains: ["auto", "recovery"]
      };
    case "auto_compaction_end":
      return {
        reason: "auto_compaction_end",
        source: "bridge_event",
        domains: ["auto", "recovery"]
      };
    default:
      return null;
  }
}
function createLiveStateInvalidationFromCommand(input, response) {
  if (!response.success) {
    return null;
  }
  switch (input.type) {
    case "new_session":
      return response.command === "new_session" && response.data.cancelled === false ? {
        reason: "new_session",
        source: "rpc_command",
        domains: ["resumable_sessions", "recovery"]
      } : null;
    case "switch_session":
      return response.command === "switch_session" && response.data.cancelled === false ? {
        reason: "switch_session",
        source: "rpc_command",
        domains: ["resumable_sessions", "recovery"]
      } : null;
    case "fork":
      return response.command === "fork" && response.data.cancelled === false ? {
        reason: "fork",
        source: "rpc_command",
        domains: ["resumable_sessions", "recovery"]
      } : null;
    case "set_session_name":
      return response.command === "set_session_name" ? {
        reason: "set_session_name",
        source: "rpc_command",
        domains: ["resumable_sessions"]
      } : null;
    default:
      return null;
  }
}
function isBridgeTerminalOutputEvent(value) {
  return typeof value === "object" && value !== null && "type" in value && value.type === "terminal_output" && typeof value.data === "string";
}
function isBridgeSessionStateChangedEvent(value) {
  return typeof value === "object" && value !== null && "type" in value && value.type === "session_state_changed" && typeof value.reason === "string";
}
function createLiveStateInvalidationFromSessionStateChange(reason) {
  switch (reason) {
    case "new_session":
      return {
        reason: "new_session",
        source: "bridge_event",
        domains: ["resumable_sessions", "recovery"]
      };
    case "switch_session":
      return {
        reason: "switch_session",
        source: "bridge_event",
        domains: ["resumable_sessions", "recovery"]
      };
    case "fork":
      return {
        reason: "fork",
        source: "bridge_event",
        domains: ["resumable_sessions", "recovery"]
      };
    case "set_session_name":
      return {
        reason: "set_session_name",
        source: "bridge_event",
        domains: ["resumable_sessions"]
      };
    default:
      return null;
  }
}
class BridgeService {
  subscribers = /* @__PURE__ */ new Set();
  terminalSubscribers = /* @__PURE__ */ new Set();
  pendingRequests = /* @__PURE__ */ new Map();
  config;
  deps;
  process = null;
  detachStdoutReader = null;
  startPromise = null;
  refreshPromise = null;
  authRefreshPromise = null;
  requestCounter = 0;
  stderrBuffer = "";
  snapshot;
  constructor(config, deps) {
    this.config = config;
    this.deps = deps;
    this.snapshot = {
      phase: "idle",
      projectCwd: config.projectCwd,
      projectSessionsDir: config.projectSessionsDir,
      packageRoot: config.packageRoot,
      startedAt: null,
      updatedAt: nowIso(),
      connectionCount: 0,
      lastCommandType: null,
      activeSessionId: null,
      activeSessionFile: null,
      sessionState: null,
      lastError: null
    };
  }
  getSnapshot() {
    return structuredClone(this.snapshot);
  }
  publishLiveStateInvalidation(descriptor) {
    const event = buildLiveStateInvalidationEvent(descriptor);
    if (event.workspaceIndexCacheInvalidated) {
      invalidateWorkspaceIndexCache(this.config.projectCwd);
    }
    this.emit(event);
    return event;
  }
  async ensureStarted() {
    if (this.process && this.snapshot.phase === "ready") return;
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }
  async sendInput(input) {
    await this.ensureStarted();
    if (!this.process?.stdin) {
      throw new Error(this.snapshot.lastError?.message || "RPC bridge is not connected");
    }
    if (isRpcExtensionUiResponse(input)) {
      this.process.stdin.write(serializeJsonLine(input));
      return null;
    }
    const response = sanitizeRpcResponse(await this.requestResponse(input));
    this.snapshot.lastCommandType = input.type;
    this.snapshot.updatedAt = nowIso();
    if (!response.success) {
      this.recordError(response.error, this.snapshot.phase, { commandType: input.type });
      this.broadcastStatus();
      return response;
    }
    if (input.type === "get_state" && response.success && response.command === "get_state") {
      this.applySessionState(response.data);
      this.broadcastStatus();
      return response;
    }
    const liveStateInvalidation = createLiveStateInvalidationFromCommand(input, response);
    if (liveStateInvalidation) {
      this.publishLiveStateInvalidation(liveStateInvalidation);
    }
    void this.queueStateRefresh();
    this.broadcastStatus();
    return response;
  }
  async refreshAuth() {
    if (this.authRefreshPromise) {
      return await this.authRefreshPromise;
    }
    this.authRefreshPromise = this.refreshAuthInternal().finally(() => {
      this.authRefreshPromise = null;
    });
    await this.authRefreshPromise;
  }
  async refreshAuthInternal() {
    if (this.startPromise) {
      await this.startPromise;
    }
    if (this.process && this.snapshot.phase === "ready") {
      this.resetProcessForAuthRefresh();
    }
    await this.ensureStarted();
  }
  resetProcessForAuthRefresh() {
    const child = this.process;
    this.process = null;
    this.detachStdoutReader?.();
    this.detachStdoutReader = null;
    this.stderrBuffer = "";
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("RPC bridge restarting to reload auth"));
    }
    this.pendingRequests.clear();
    if (child) {
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      child.kill("SIGTERM");
      destroyChildStreams(child);
    }
    this.snapshot.phase = "idle";
    this.snapshot.updatedAt = nowIso();
    this.snapshot.lastError = null;
    this.broadcastStatus();
  }
  subscribe(listener) {
    this.subscribers.add(listener);
    this.snapshot.connectionCount = this.subscribers.size;
    this.snapshot.updatedAt = nowIso();
    this.broadcastStatus();
    return () => {
      this.subscribers.delete(listener);
      this.snapshot.connectionCount = this.subscribers.size;
      this.snapshot.updatedAt = nowIso();
      if (this.subscribers.size > 0) {
        this.broadcastStatus();
      }
    };
  }
  subscribeTerminal(listener) {
    this.terminalSubscribers.add(listener);
    return () => {
      this.terminalSubscribers.delete(listener);
    };
  }
  async sendTerminalInput(data) {
    await this.sendTerminalCommand({ type: "terminal_input", data });
  }
  async resizeTerminal(cols, rows) {
    await this.sendTerminalCommand({ type: "terminal_resize", cols, rows });
  }
  async redrawTerminal() {
    await this.sendTerminalCommand({ type: "terminal_redraw" });
  }
  async sendTerminalCommand(command) {
    await this.ensureStarted();
    const response = sanitizeRpcResponse(await this.requestResponse(command));
    if (!response.success) {
      this.recordError(response.error, this.snapshot.phase, { commandType: command.type });
      this.broadcastStatus();
      throw new Error(response.error);
    }
  }
  async dispose() {
    this.detachStdoutReader?.();
    this.detachStdoutReader = null;
    this.terminalSubscribers.clear();
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("RPC bridge disposed"));
    }
    this.pendingRequests.clear();
    if (this.process) {
      this.process.removeAllListeners();
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.snapshot.phase = "idle";
    this.snapshot.connectionCount = 0;
    this.snapshot.updatedAt = nowIso();
  }
  async startInternal() {
    this.snapshot.phase = "starting";
    this.snapshot.startedAt = nowIso();
    this.snapshot.updatedAt = this.snapshot.startedAt;
    this.snapshot.lastError = null;
    this.broadcastStatus();
    let cliEntry;
    try {
      cliEntry = resolveBridgeCliEntry(this.config, this.deps);
    } catch (error) {
      this.snapshot.phase = "failed";
      this.recordError(error, "starting");
      throw error;
    }
    const spawnChild = this.deps.spawn ?? ((command, args, options) => spawn(command, args, options));
    const childEnv = { ...this.deps.env ?? process.env };
    delete childEnv.GSD_CODING_AGENT_DIR;
    childEnv.GSD_WEB_BRIDGE_TUI = "1";
    const child = spawnChild(cliEntry.command, cliEntry.args, {
      cwd: cliEntry.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.process = child;
    this.stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      this.stderrBuffer = captureStderr(this.stderrBuffer, chunk.toString());
    });
    this.detachStdoutReader = attachJsonLineReader(child.stdout, (line) => this.handleStdoutLine(line));
    child.once("exit", (code, signal) => this.handleProcessExit(code, signal));
    child.once("error", (error) => this.handleProcessExit(null, null, error));
    let startupTimeout;
    const timeout = new Promise((_, reject) => {
      startupTimeout = setTimeout(() => reject(new Error(`RPC bridge startup timed out after ${START_TIMEOUT_MS}ms`)), START_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.refreshState(true), timeout]);
      this.snapshot.phase = "ready";
      this.snapshot.updatedAt = nowIso();
      this.snapshot.lastError = null;
      this.broadcastStatus();
    } catch (error) {
      this.snapshot.phase = "failed";
      this.recordError(error, "starting");
      this.broadcastStatus();
      throw error;
    } finally {
      if (startupTimeout) {
        clearTimeout(startupTimeout);
      }
    }
  }
  async queueStateRefresh() {
    if (this.refreshPromise) return await this.refreshPromise;
    this.refreshPromise = this.refreshState(false).catch((error) => {
      this.recordError(error, this.snapshot.phase, { commandType: "get_state" });
    }).finally(() => {
      this.refreshPromise = null;
    });
    await this.refreshPromise;
  }
  async refreshState(strict) {
    const timeout = strict ? START_TIMEOUT_MS : void 0;
    const response = sanitizeRpcResponse(await this.requestResponse({ type: "get_state" }, timeout));
    if (!response.success) {
      throw new Error(response.error);
    }
    if (response.command === "get_state") {
      this.applySessionState(response.data);
    }
    this.snapshot.updatedAt = nowIso();
    if (!strict) {
      this.broadcastStatus();
    }
  }
  applySessionState(state) {
    this.snapshot.sessionState = state;
    this.snapshot.activeSessionId = state.sessionId;
    this.snapshot.activeSessionFile = state.sessionFile ?? null;
  }
  requestResponse(command, timeoutMs) {
    if (!this.process?.stdin) {
      return Promise.reject(new Error("RPC bridge is not connected"));
    }
    const id = command.id ?? `web_${++this.requestCounter}`;
    const payload = { ...command, id };
    const effectiveTimeout = timeoutMs ?? RESPONSE_TIMEOUT_MS;
    return new Promise((resolve2, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for RPC response to ${payload.type}`));
      }, effectiveTimeout);
      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve2(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout
      });
      this.process.stdin.write(serializeJsonLine(payload));
    });
  }
  handleStdoutLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (isBridgeTerminalOutputEvent(parsed)) {
      this.emitTerminal(parsed.data);
      return;
    }
    if (typeof parsed === "object" && parsed !== null && "type" in parsed && parsed.type === "response") {
      const response = sanitizeRpcResponse(parsed);
      if (response.id && this.pendingRequests.has(response.id)) {
        const pending = this.pendingRequests.get(response.id);
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
        return;
      }
    }
    const event = sanitizeEventPayload(parsed);
    this.emit(event);
    if (isBridgeSessionStateChangedEvent(event)) {
      const liveStateInvalidation2 = createLiveStateInvalidationFromSessionStateChange(event.reason);
      if (liveStateInvalidation2) {
        this.publishLiveStateInvalidation(liveStateInvalidation2);
      }
      void this.queueStateRefresh();
      return;
    }
    const liveStateInvalidation = createLiveStateInvalidationFromBridgeEvent(event);
    if (liveStateInvalidation) {
      this.publishLiveStateInvalidation(liveStateInvalidation);
    }
    if (typeof event === "object" && event !== null && "type" in event) {
      const eventType = event.type;
      if (eventType === "agent_end" || eventType === "turn_end" || eventType === "auto_retry_start" || eventType === "auto_retry_end" || eventType === "auto_compaction_start" || eventType === "auto_compaction_end") {
        void this.queueStateRefresh();
      }
    }
  }
  handleProcessExit(code, signal, error) {
    this.detachStdoutReader?.();
    this.detachStdoutReader = null;
    this.process = null;
    const exitError = new Error(buildExitMessage(code, signal, this.stderrBuffer));
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(exitError);
    }
    this.pendingRequests.clear();
    this.snapshot.phase = "failed";
    this.snapshot.updatedAt = nowIso();
    this.recordError(error ?? exitError, this.snapshot.activeSessionId ? "ready" : "starting");
    this.broadcastStatus();
  }
  recordError(error, phase, options = {}) {
    this.snapshot.lastError = {
      message: sanitizeErrorMessage(error),
      at: nowIso(),
      phase,
      afterSessionAttachment: Boolean(this.snapshot.activeSessionId),
      commandType: options.commandType
    };
    this.snapshot.updatedAt = this.snapshot.lastError.at;
  }
  emit(event) {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
      }
    }
  }
  emitTerminal(data) {
    for (const subscriber of this.terminalSubscribers) {
      try {
        subscriber(data);
      } catch {
      }
    }
  }
  broadcastStatus() {
    if (this.subscribers.size === 0) return;
    this.emit({ type: "bridge_status", bridge: this.getSnapshot() });
  }
}
function getProjectBridgeServiceForCwd(projectCwd) {
  const resolvedPath = resolve(projectCwd);
  const existing = projectBridgeRegistry.get(resolvedPath);
  if (existing) return existing;
  const config = resolveBridgeRuntimeConfig(void 0, resolvedPath);
  const deps = getBridgeDeps();
  const service = new BridgeService(config, deps);
  projectBridgeRegistry.set(resolvedPath, service);
  return service;
}
function resolveProjectCwd(request) {
  try {
    const url = new URL(request.url);
    const projectParam = url.searchParams.get("project");
    if (projectParam) return decodeURIComponent(projectParam);
  } catch {
  }
  return (getBridgeDeps().env ?? process.env).GSD_WEB_PROJECT_CWD || null;
}
function requireProjectCwd(request) {
  const cwd = resolveProjectCwd(request);
  if (!cwd) {
    throw new NoProjectError();
  }
  return cwd;
}
class NoProjectError extends Error {
  constructor() {
    super("No project selected");
    this.name = "NoProjectError";
  }
}
function getProjectBridgeService() {
  const config = resolveBridgeRuntimeConfig();
  return getProjectBridgeServiceForCwd(config.projectCwd);
}
function toBootResumableSession(session, activeSessionFile) {
  return {
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    name: session.name,
    createdAt: session.created.toISOString(),
    modifiedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
    isActive: Boolean(activeSessionFile && session.path === activeSessionFile)
  };
}
function buildSessionBrowserTree(sessions) {
  const byPath = /* @__PURE__ */ new Map();
  for (const session of sessions) {
    byPath.set(session.path, { session, children: [] });
  }
  const roots = [];
  for (const session of sessions) {
    const node = byPath.get(session.path);
    if (!node) continue;
    const parentPath = session.parentSessionPath;
    if (parentPath && byPath.has(parentPath)) {
      byPath.get(parentPath).children.push(node);
      continue;
    }
    roots.push(node);
  }
  const sortNodes = (nodes) => {
    nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };
  sortNodes(roots);
  return roots;
}
function flattenSessionBrowserTree(roots) {
  const result = [];
  const walk = (node, depth, ancestorHasNextSibling, isLastInThread) => {
    result.push({
      session: node.session,
      depth,
      isLastInThread,
      ancestorHasNextSibling
    });
    for (let index = 0; index < node.children.length; index++) {
      const child = node.children[index];
      if (!child) continue;
      const childIsLast = index === node.children.length - 1;
      const continues = depth > 0 ? !isLastInThread : false;
      walk(child, depth + 1, [...ancestorHasNextSibling, continues], childIsLast);
    }
  };
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (!root) continue;
    walk(root, 0, [], index === roots.length - 1);
  }
  return result;
}
function toSessionBrowserSession(node, activeSessionFile) {
  const { session } = node;
  const isActive = Boolean(activeSessionFile && resolve(session.path) === resolve(activeSessionFile));
  return {
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    name: session.name,
    createdAt: session.created.toISOString(),
    modifiedAt: session.modified.toISOString(),
    messageCount: session.messageCount,
    parentSessionPath: session.parentSessionPath,
    firstMessage: session.firstMessage,
    isActive,
    depth: node.depth,
    isLastInThread: node.isLastInThread,
    ancestorHasNextSibling: [...node.ancestorHasNextSibling]
  };
}
function buildFlatSessionBrowserNodes(sessions, query) {
  if (query.sortMode === "threaded" && !query.query) {
    const filteredSessions = query.nameFilter === "named" ? sessions.filter((session) => hasSessionName(session)) : sessions;
    return flattenSessionBrowserTree(buildSessionBrowserTree(filteredSessions));
  }
  return filterAndSortSessions(sessions, query.query, query.sortMode, query.nameFilter).map((session) => ({
    session,
    depth: 0,
    isLastInThread: true,
    ancestorHasNextSibling: []
  }));
}
function findCurrentProjectSession(sessions, sessionPath) {
  const normalizedPath = resolve(sessionPath);
  return sessions.find((session) => resolve(session.path) === normalizedPath);
}
function buildSessionManageError(code, error, details = {}) {
  return {
    success: false,
    action: "rename",
    scope: SESSION_BROWSER_SCOPE,
    code,
    error,
    ...details
  };
}
async function collectSessionBrowserPayload(query = {}, projectCwd) {
  const deps = getBridgeDeps();
  const env = deps.env ?? process.env;
  const config = resolveBridgeRuntimeConfig(env, projectCwd);
  const bridge = projectCwd ? getProjectBridgeServiceForCwd(projectCwd) : getProjectBridgeService();
  try {
    await bridge.ensureStarted();
  } catch {
  }
  const bridgeSnapshot = bridge.getSnapshot();
  const sessions = await loadSessionBrowserSessionsViaChildProcess(config);
  const normalizedQuery = normalizeSessionBrowserQuery(query);
  const browserSessions = buildFlatSessionBrowserNodes(sessions, normalizedQuery).map(
    (node) => toSessionBrowserSession(node, bridgeSnapshot.activeSessionFile)
  );
  return {
    project: {
      scope: SESSION_BROWSER_SCOPE,
      cwd: config.projectCwd,
      sessionsDir: config.projectSessionsDir,
      activeSessionPath: bridgeSnapshot.activeSessionFile
    },
    query: normalizedQuery,
    totalSessions: sessions.length,
    returnedSessions: browserSessions.length,
    sessions: browserSessions
  };
}
async function renameSessionInCurrentProject(request, projectCwd) {
  const deps = getBridgeDeps();
  const env = deps.env ?? process.env;
  const config = resolveBridgeRuntimeConfig(env, projectCwd);
  const nextName = request.name.trim();
  if (!nextName) {
    return buildSessionManageError("invalid_request", "Session name cannot be empty", {
      sessionPath: request.sessionPath,
      name: request.name
    });
  }
  const sessions = await loadSessionBrowserSessionsViaChildProcess(config);
  const targetSession = findCurrentProjectSession(sessions, request.sessionPath);
  if (!targetSession) {
    return buildSessionManageError("not_found", "Session is not available in the current project browser", {
      sessionPath: request.sessionPath,
      name: nextName
    });
  }
  const bridge = projectCwd ? getProjectBridgeServiceForCwd(projectCwd) : getProjectBridgeService();
  try {
    await bridge.ensureStarted();
  } catch (error) {
    return buildSessionManageError("rename_failed", sanitizeErrorMessage(error), {
      sessionPath: targetSession.path,
      name: nextName
    });
  }
  const activeSessionFile = bridge.getSnapshot().activeSessionFile;
  const isActiveSession = Boolean(activeSessionFile && resolve(activeSessionFile) === resolve(targetSession.path));
  if (isActiveSession) {
    const response = await sendBridgeInput({ type: "set_session_name", name: nextName }, projectCwd);
    if (response === null) {
      return buildSessionManageError("rename_failed", "Active session rename did not return a response", {
        sessionPath: targetSession.path,
        name: nextName,
        isActiveSession: true,
        mutation: "rpc"
      });
    }
    if (!response.success) {
      const failureCode = response.code;
      return buildSessionManageError(
        failureCode === "onboarding_locked" ? "onboarding_locked" : "rename_failed",
        response.error,
        {
          sessionPath: targetSession.path,
          name: nextName,
          isActiveSession: true,
          mutation: "rpc"
        }
      );
    }
    return {
      success: true,
      action: "rename",
      scope: SESSION_BROWSER_SCOPE,
      sessionPath: targetSession.path,
      name: nextName,
      isActiveSession: true,
      mutation: "rpc"
    };
  }
  try {
    await appendSessionInfoViaChildProcess(config, targetSession.path, nextName);
    bridge.publishLiveStateInvalidation({
      reason: "set_session_name",
      source: "session_manage",
      domains: ["resumable_sessions"]
    });
    return {
      success: true,
      action: "rename",
      scope: SESSION_BROWSER_SCOPE,
      sessionPath: targetSession.path,
      name: nextName,
      isActiveSession: false,
      mutation: "session_file"
    };
  } catch (error) {
    return buildSessionManageError("rename_failed", sanitizeErrorMessage(error), {
      sessionPath: targetSession.path,
      name: nextName,
      isActiveSession: false,
      mutation: "session_file"
    });
  }
}
async function resolveBootOnboardingState(deps, env) {
  if (deps.getOnboardingState) {
    return await deps.getOnboardingState();
  }
  if (deps.getOnboardingNeeded) {
    return legacyOnboardingStateFromNeeded(await deps.getOnboardingNeeded(authFilePath, env));
  }
  return await collectOnboardingState();
}
async function collectCurrentProjectOnboardingState(projectCwd) {
  const deps = getBridgeDeps();
  const env = deps.env ?? process.env;
  return await resolveBootOnboardingState(deps, env);
}
async function collectSelectiveLiveStatePayload(domains = ["auto", "workspace", "resumable_sessions"], projectCwd) {
  const deps = getBridgeDeps();
  const env = deps.env ?? process.env;
  const config = resolveBridgeRuntimeConfig(env, projectCwd);
  const bridge = projectCwd ? getProjectBridgeServiceForCwd(projectCwd) : getProjectBridgeService();
  try {
    await bridge.ensureStarted();
  } catch {
  }
  const bridgeSnapshot = bridge.getSnapshot();
  const uniqueDomains = [...new Set(domains)];
  const payload = {
    bridge: bridgeSnapshot
  };
  if (uniqueDomains.includes("workspace")) {
    payload.workspace = await loadCachedWorkspaceIndex(
      config.projectCwd,
      async () => await (deps.indexWorkspace ?? fallbackWorkspaceIndex)(config.projectCwd)
    );
  }
  if (uniqueDomains.includes("auto")) {
    const getAutoDashboardData = deps.getAutoDashboardData ?? (() => collectTestOnlyFallbackAutoDashboardData());
    payload.auto = await Promise.resolve(getAutoDashboardData());
  }
  if (uniqueDomains.includes("resumable_sessions")) {
    const sessions = await (deps.listSessions ?? (async (dir) => listProjectSessions(dir)))(config.projectSessionsDir);
    payload.resumableSessions = sessions.map((session) => toBootResumableSession(session, bridgeSnapshot.activeSessionFile));
  }
  return payload;
}
async function collectBootPayload(projectCwd) {
  const deps = getBridgeDeps();
  const env = deps.env ?? process.env;
  const config = resolveBridgeRuntimeConfig(env, projectCwd);
  const getAutoDashboardData = deps.getAutoDashboardData ?? (() => collectTestOnlyFallbackAutoDashboardData());
  const listSessions = deps.listSessions ?? (async (dir) => listProjectSessions(dir));
  const projectDetection = detectProjectKind(config.projectCwd);
  const onboarding = await resolveBootOnboardingState(deps, env);
  if (onboarding.locked && env.GSD_WEB_HOST_KIND === "packaged-standalone") {
    return {
      project: {
        cwd: config.projectCwd,
        sessionsDir: config.projectSessionsDir,
        packageRoot: config.packageRoot
      },
      workspace: {
        milestones: [],
        active: {
          phase: "pre-planning"
        },
        scopes: [
          {
            scope: "project",
            label: "project",
            kind: "project"
          }
        ],
        validationIssues: []
      },
      auto: collectTestOnlyFallbackAutoDashboardData(),
      onboarding,
      onboardingNeeded: true,
      resumableSessions: [],
      bridge: {
        phase: "idle",
        projectCwd: config.projectCwd,
        projectSessionsDir: config.projectSessionsDir,
        packageRoot: config.packageRoot,
        startedAt: null,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        connectionCount: 0,
        lastCommandType: null,
        activeSessionId: null,
        activeSessionFile: null,
        sessionState: null,
        lastError: null
      },
      projectDetection
    };
  }
  const bridge = projectCwd ? getProjectBridgeServiceForCwd(projectCwd) : getProjectBridgeService();
  const workspacePromise = loadCachedWorkspaceIndex(
    config.projectCwd,
    async () => await (deps.indexWorkspace ?? fallbackWorkspaceIndex)(config.projectCwd)
  );
  const autoPromise = Promise.resolve(getAutoDashboardData());
  const sessionsPromise = listSessions(config.projectSessionsDir);
  try {
    await bridge.ensureStarted();
  } catch {
  }
  const bridgeSnapshot = bridge.getSnapshot();
  const [workspace, auto, sessions] = await Promise.all([
    workspacePromise,
    autoPromise,
    sessionsPromise
  ]);
  return {
    project: {
      cwd: config.projectCwd,
      sessionsDir: config.projectSessionsDir,
      packageRoot: config.packageRoot
    },
    workspace,
    auto,
    onboarding,
    onboardingNeeded: onboarding.locked,
    resumableSessions: sessions.map((session) => toBootResumableSession(session, bridgeSnapshot.activeSessionFile)),
    bridge: bridgeSnapshot,
    projectDetection
  };
}
function buildBridgeFailureResponse(commandType, error) {
  return {
    type: "response",
    command: commandType,
    success: false,
    error: sanitizeErrorMessage(error)
  };
}
async function refreshProjectBridgeAuth(projectCwd) {
  const bridge = projectCwd ? getProjectBridgeServiceForCwd(projectCwd) : getProjectBridgeService();
  await bridge.refreshAuth();
}
registerOnboardingBridgeAuthRefresher(async () => {
  await refreshProjectBridgeAuth();
});
function emitProjectLiveStateInvalidation(descriptor, projectCwd) {
  const bridge = projectCwd ? getProjectBridgeServiceForCwd(projectCwd) : getProjectBridgeService();
  return bridge.publishLiveStateInvalidation(descriptor);
}
async function sendBridgeInput(input, projectCwd) {
  if (!isReadOnlyBridgeInput(input)) {
    const onboarding = await collectOnboardingState();
    if (onboarding.locked) {
      return buildBridgeLockedResponse(input, onboarding);
    }
  }
  const bridge = projectCwd ? getProjectBridgeServiceForCwd(projectCwd) : getProjectBridgeService();
  return await bridge.sendInput(input);
}
function configureBridgeServiceForTests(overrides) {
  bridgeServiceOverrides = overrides;
  invalidateWorkspaceIndexCache();
}
async function resetBridgeServiceForTests() {
  const disposePromises = [];
  for (const service of projectBridgeRegistry.values()) {
    disposePromises.push(service.dispose());
  }
  await Promise.all(disposePromises);
  projectBridgeRegistry.clear();
  bridgeServiceOverrides = null;
  invalidateWorkspaceIndexCache();
}
export {
  BridgeService,
  NoProjectError,
  buildBridgeFailureResponse,
  collectBootPayload,
  collectCurrentProjectOnboardingState,
  collectSelectiveLiveStatePayload,
  collectSessionBrowserPayload,
  configureBridgeServiceForTests,
  detectMonorepo,
  detectProjectKind,
  emitProjectLiveStateInvalidation,
  getProjectBridgeService,
  getProjectBridgeServiceForCwd,
  refreshProjectBridgeAuth,
  renameSessionInCurrentProject,
  requireProjectCwd,
  resetBridgeServiceForTests,
  resetDefaultPackageRootForTests,
  resolveBridgeRuntimeConfig,
  resolveProjectCwd,
  sendBridgeInput
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vc3JjL3dlYi9icmlkZ2Utc2VydmljZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgZXhlY0ZpbGUsIHNwYXduLCB0eXBlIENoaWxkUHJvY2VzcywgdHlwZSBTcGF3bk9wdGlvbnMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkZGlyU3luYywgcmVhZEZpbGVTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBTdHJpbmdEZWNvZGVyIH0gZnJvbSBcIm5vZGU6c3RyaW5nX2RlY29kZXJcIjtcbmltcG9ydCB0eXBlIHsgUmVhZGFibGUgfSBmcm9tIFwibm9kZTpzdHJlYW1cIjtcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyByZXNvbHZlVHlwZVN0cmlwcGluZ0ZsYWcsIHJlc29sdmVTdWJwcm9jZXNzTW9kdWxlLCBidWlsZFN1YnByb2Nlc3NQcmVmaXhBcmdzIH0gZnJvbSBcIi4vdHMtc3VicHJvY2Vzcy1mbGFncy50c1wiO1xuaW1wb3J0IHsgc2FmZVBhY2thZ2VSb290RnJvbUltcG9ydFVybCB9IGZyb20gXCIuL3NhZmUtaW1wb3J0LW1ldGEtcmVzb2x2ZS50c1wiO1xuXG5pbXBvcnQgdHlwZSB7IEFnZW50U2Vzc2lvbkV2ZW50LCBTZXNzaW9uU3RhdGVDaGFuZ2VSZWFzb24gfSBmcm9tIFwiLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2FnZW50LXNlc3Npb24udHNcIjtcbmltcG9ydCB0eXBlIHtcbiAgUnBjQ29tbWFuZCxcbiAgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0LFxuICBScGNFeHRlbnNpb25VSVJlc3BvbnNlLFxuICBScGNSZXNwb25zZSxcbiAgUnBjU2Vzc2lvblN0YXRlLFxufSBmcm9tIFwiQGdzZC1idWlsZC9jb250cmFjdHNcIjtcbmltcG9ydCB0eXBlIHtcbiAgV29ya3NwYWNlSW5kZXggYXMgR1NEV29ya3NwYWNlSW5kZXgsXG4gIFdvcmtzcGFjZU1pbGVzdG9uZVRhcmdldCBhcyBHU0RXb3Jrc3BhY2VNaWxlc3RvbmVUYXJnZXQsXG4gIFdvcmtzcGFjZVNjb3BlVGFyZ2V0IGFzIEdTRFdvcmtzcGFjZVNjb3BlVGFyZ2V0LFxuICBXb3Jrc3BhY2VTbGljZVRhcmdldCBhcyBHU0RXb3Jrc3BhY2VTbGljZVRhcmdldCxcbiAgV29ya3NwYWNlVGFza1RhcmdldCBhcyBHU0RXb3Jrc3BhY2VUYXNrVGFyZ2V0LFxufSBmcm9tIFwiLi4vc2hhcmVkL3dvcmtzcGFjZS10eXBlcy50c1wiO1xuaW1wb3J0IHtcbiAgU0VTU0lPTl9CUk9XU0VSX1NDT1BFLFxuICBub3JtYWxpemVTZXNzaW9uQnJvd3NlclF1ZXJ5LFxuICB0eXBlIFJlbmFtZVNlc3Npb25SZXF1ZXN0LFxuICB0eXBlIFNlc3Npb25Ccm93c2VyUXVlcnksXG4gIHR5cGUgU2Vzc2lvbkJyb3dzZXJSZXNwb25zZSxcbiAgdHlwZSBTZXNzaW9uQnJvd3NlclNlc3Npb24sXG4gIHR5cGUgU2Vzc2lvbk1hbmFnZUVycm9yQ29kZSxcbiAgdHlwZSBTZXNzaW9uTWFuYWdlRXJyb3JSZXNwb25zZSxcbiAgdHlwZSBTZXNzaW9uTWFuYWdlUmVzcG9uc2UsXG59IGZyb20gXCIuLi8uLi93ZWIvbGliL3Nlc3Npb24tYnJvd3Nlci1jb250cmFjdC50c1wiO1xuaW1wb3J0IHsgYXV0aEZpbGVQYXRoIH0gZnJvbSBcIi4uL2FwcC1wYXRocy50c1wiO1xuaW1wb3J0IHsgZ2V0UHJvamVjdFNlc3Npb25zRGlyIH0gZnJvbSBcIi4uL3Byb2plY3Qtc2Vzc2lvbnMudHNcIjtcbmltcG9ydCB7XG4gIGNvbGxlY3RPbmJvYXJkaW5nU3RhdGUsXG4gIHJlZ2lzdGVyT25ib2FyZGluZ0JyaWRnZUF1dGhSZWZyZXNoZXIsXG4gIHR5cGUgT25ib2FyZGluZ0xvY2tSZWFzb24sXG4gIHR5cGUgT25ib2FyZGluZ1N0YXRlLFxufSBmcm9tIFwiLi9vbmJvYXJkaW5nLXNlcnZpY2UudHNcIjtcbmltcG9ydCB7XG4gIGNvbGxlY3RBdXRob3JpdGF0aXZlQXV0b0Rhc2hib2FyZERhdGEsXG4gIGNvbGxlY3RUZXN0T25seUZhbGxiYWNrQXV0b0Rhc2hib2FyZERhdGEsXG59IGZyb20gXCIuL2F1dG8tZGFzaGJvYXJkLXNlcnZpY2UudHNcIjtcbmltcG9ydCB0eXBlIHsgQXV0b0Rhc2hib2FyZERhdGEsIFJ0a1Nlc3Npb25TYXZpbmdzIH0gZnJvbSBcIi4vYXV0by1kYXNoYm9hcmQtdHlwZXMudHNcIjtcbmltcG9ydCB7IHJlc29sdmVHc2RDbGlFbnRyeSB9IGZyb20gXCIuL2NsaS1lbnRyeS50c1wiO1xuXG4vLyBUaGUgc3RhbmRhbG9uZSBOZXh0LmpzIGJ1bmRsZSBiYWtlcyBpbXBvcnQubWV0YS51cmwgYXQgYnVpbGQgdGltZSB3aXRoIHRoZVxuLy8gQ0kgcnVubmVyJ3MgYWJzb2x1dGUgcGF0aC4gIE9uIFdpbmRvd3MsIGZpbGVVUkxUb1BhdGgoKSByZWplY3RzIGEgTGludXhcbi8vIGZpbGU6Ly8gVVJMIGF0IG1vZHVsZSBsb2FkIHRpbWUuICBVc2UgYSBsYXp5IGdldHRlciBzbyB0aGUgZGVyaXZhdGlvbiBpc1xuLy8gZGVmZXJyZWQgdG8gZmlyc3QgdXNlIChub3QgbW9kdWxlIGxvYWQpIGFuZCBmYWxscyBiYWNrIHRvIGN3ZCBvbiBmYWlsdXJlLlxubGV0IF9kZWZhdWx0UGFja2FnZVJvb3Q6IHN0cmluZyB8IHVuZGVmaW5lZDtcbmZ1bmN0aW9uIGdldERlZmF1bHRQYWNrYWdlUm9vdCgpOiBzdHJpbmcge1xuICBpZiAoX2RlZmF1bHRQYWNrYWdlUm9vdCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gX2RlZmF1bHRQYWNrYWdlUm9vdDtcbiAgX2RlZmF1bHRQYWNrYWdlUm9vdCA9IHNhZmVQYWNrYWdlUm9vdEZyb21JbXBvcnRVcmwoaW1wb3J0Lm1ldGEudXJsKSA/PyBwcm9jZXNzLmN3ZCgpO1xuICByZXR1cm4gX2RlZmF1bHRQYWNrYWdlUm9vdDtcbn1cblxuLyoqIEBpbnRlcm5hbCBcdTIwMTQgdGVzdC1vbmx5OiByZXNldCB0aGUgbWVtb2l6ZWQgZGVmYXVsdCBwYWNrYWdlIHJvb3QgKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldERlZmF1bHRQYWNrYWdlUm9vdEZvclRlc3RzKCk6IHZvaWQge1xuICBfZGVmYXVsdFBhY2thZ2VSb290ID0gdW5kZWZpbmVkO1xufVxuXG5jb25zdCBSRVNQT05TRV9USU1FT1VUX01TID0gMzBfMDAwO1xuY29uc3QgU1RBUlRfVElNRU9VVF9NUyA9IDE1MF8wMDA7XG5jb25zdCBNQVhfU1RERVJSX0JVRkZFUiA9IDhfMDAwO1xuY29uc3QgV09SS1NQQUNFX0lOREVYX0NBQ0hFX1RUTF9NUyA9IDMwXzAwMDtcblxudHlwZSBCcmlkZ2VMaWZlY3ljbGVQaGFzZSA9IFwiaWRsZVwiIHwgXCJzdGFydGluZ1wiIHwgXCJyZWFkeVwiIHwgXCJmYWlsZWRcIjtcbnR5cGUgQnJpZGdlSW5wdXQgPSBScGNDb21tYW5kIHwgUnBjRXh0ZW5zaW9uVUlSZXNwb25zZTtcbnR5cGUgQnJpZGdlVGVybWluYWxDb21tYW5kID0gRXh0cmFjdDxScGNDb21tYW5kLCB7IHR5cGU6IFwidGVybWluYWxfaW5wdXRcIiB8IFwidGVybWluYWxfcmVzaXplXCIgfCBcInRlcm1pbmFsX3JlZHJhd1wiIH0+O1xudHlwZSBCcmlkZ2VUZXJtaW5hbE91dHB1dEV2ZW50ID0geyB0eXBlOiBcInRlcm1pbmFsX291dHB1dFwiOyBkYXRhOiBzdHJpbmcgfTtcbnR5cGUgQnJpZGdlU2Vzc2lvblN0YXRlQ2hhbmdlZEV2ZW50ID0geyB0eXBlOiBcInNlc3Npb25fc3RhdGVfY2hhbmdlZFwiOyByZWFzb246IFNlc3Npb25TdGF0ZUNoYW5nZVJlYXNvbiB9O1xuXG50eXBlIEJyaWRnZUNvbW1hbmRGYWlsdXJlUmVzcG9uc2UgPSBScGNSZXNwb25zZSAmIHtcbiAgY29kZT86IFwib25ib2FyZGluZ19sb2NrZWRcIjtcbiAgZGV0YWlscz86IHtcbiAgICByZWFzb246IE9uYm9hcmRpbmdMb2NrUmVhc29uO1xuICAgIG9uYm9hcmRpbmc6IFBpY2s8XG4gICAgICBPbmJvYXJkaW5nU3RhdGUsXG4gICAgICBcImxvY2tlZFwiIHwgXCJsb2NrUmVhc29uXCIgfCBcInJlcXVpcmVkXCIgfCBcImxhc3RWYWxpZGF0aW9uXCIgfCBcImJyaWRnZUF1dGhSZWZyZXNoXCJcbiAgICA+O1xuICB9O1xufTtcblxuY29uc3QgUkVBRF9PTkxZX1JQQ19DT01NQU5EX1RZUEVTID0gbmV3IFNldDxScGNDb21tYW5kW1widHlwZVwiXT4oW1xuICBcImdldF9zdGF0ZVwiLFxuICBcImdldF9hdmFpbGFibGVfbW9kZWxzXCIsXG4gIFwiZ2V0X3Nlc3Npb25fc3RhdHNcIixcbiAgXCJnZXRfbWVzc2FnZXNcIixcbiAgXCJnZXRfbGFzdF9hc3Npc3RhbnRfdGV4dFwiLFxuICBcImdldF9mb3JrX21lc3NhZ2VzXCIsXG4gIFwiZ2V0X2NvbW1hbmRzXCIsXG5dKTtcblxudHlwZSBCcmlkZ2VFeHRlbnNpb25FcnJvckV2ZW50ID0ge1xuICB0eXBlOiBcImV4dGVuc2lvbl9lcnJvclwiO1xuICBleHRlbnNpb25QYXRoPzogc3RyaW5nO1xuICBldmVudD86IHN0cmluZztcbiAgZXJyb3I6IHN0cmluZztcbn07XG5cbnR5cGUgTG9jYWxTZXNzaW9uSW5mbyA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICBpZDogc3RyaW5nO1xuICBjd2Q6IHN0cmluZztcbiAgbmFtZT86IHN0cmluZztcbiAgY3JlYXRlZDogRGF0ZTtcbiAgbW9kaWZpZWQ6IERhdGU7XG4gIG1lc3NhZ2VDb3VudDogbnVtYmVyO1xufTtcblxudHlwZSBTZXNzaW9uSW5mbyA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICBpZDogc3RyaW5nO1xuICBjd2Q6IHN0cmluZztcbiAgbmFtZT86IHN0cmluZztcbiAgcGFyZW50U2Vzc2lvblBhdGg/OiBzdHJpbmc7XG4gIGNyZWF0ZWQ6IERhdGU7XG4gIG1vZGlmaWVkOiBEYXRlO1xuICBtZXNzYWdlQ291bnQ6IG51bWJlcjtcbiAgZmlyc3RNZXNzYWdlOiBzdHJpbmc7XG4gIGFsbE1lc3NhZ2VzVGV4dDogc3RyaW5nO1xufTtcblxudHlwZSBTZXNzaW9uQnJvd3NlclRyZWVOb2RlID0ge1xuICBzZXNzaW9uOiBTZXNzaW9uSW5mbztcbiAgY2hpbGRyZW46IFNlc3Npb25Ccm93c2VyVHJlZU5vZGVbXTtcbn07XG5cbnR5cGUgRmxhdFNlc3Npb25Ccm93c2VyTm9kZSA9IHtcbiAgc2Vzc2lvbjogU2Vzc2lvbkluZm87XG4gIGRlcHRoOiBudW1iZXI7XG4gIGlzTGFzdEluVGhyZWFkOiBib29sZWFuO1xuICBhbmNlc3Rvckhhc05leHRTaWJsaW5nOiBib29sZWFuW107XG59O1xuXG50eXBlIFBhcnNlZFNlc3Npb25TZWFyY2hRdWVyeSA9IHtcbiAgbW9kZTogXCJ0b2tlbnNcIiB8IFwicmVnZXhcIjtcbiAgdG9rZW5zOiBBcnJheTx7IGtpbmQ6IFwiZnV6enlcIiB8IFwicGhyYXNlXCI7IHZhbHVlOiBzdHJpbmcgfT47XG4gIHJlZ2V4OiBSZWdFeHAgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZztcbn07XG5cbmZ1bmN0aW9uIGZ1enp5TWF0Y2gocXVlcnk6IHN0cmluZywgdGV4dDogc3RyaW5nKTogeyBtYXRjaGVzOiBib29sZWFuOyBzY29yZTogbnVtYmVyIH0ge1xuICBjb25zdCBxdWVyeUxvd2VyID0gcXVlcnkudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgdGV4dExvd2VyID0gdGV4dC50b0xvd2VyQ2FzZSgpO1xuXG4gIGNvbnN0IG1hdGNoUXVlcnkgPSAobm9ybWFsaXplZFF1ZXJ5OiBzdHJpbmcpOiB7IG1hdGNoZXM6IGJvb2xlYW47IHNjb3JlOiBudW1iZXIgfSA9PiB7XG4gICAgaWYgKG5vcm1hbGl6ZWRRdWVyeS5sZW5ndGggPT09IDApIHtcbiAgICAgIHJldHVybiB7IG1hdGNoZXM6IHRydWUsIHNjb3JlOiAwIH07XG4gICAgfVxuXG4gICAgaWYgKG5vcm1hbGl6ZWRRdWVyeS5sZW5ndGggPiB0ZXh0TG93ZXIubGVuZ3RoKSB7XG4gICAgICByZXR1cm4geyBtYXRjaGVzOiBmYWxzZSwgc2NvcmU6IDAgfTtcbiAgICB9XG5cbiAgICBsZXQgcXVlcnlJbmRleCA9IDA7XG4gICAgbGV0IHNjb3JlID0gMDtcbiAgICBsZXQgbGFzdE1hdGNoSW5kZXggPSAtMTtcbiAgICBsZXQgY29uc2VjdXRpdmVNYXRjaGVzID0gMDtcblxuICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCB0ZXh0TG93ZXIubGVuZ3RoICYmIHF1ZXJ5SW5kZXggPCBub3JtYWxpemVkUXVlcnkubGVuZ3RoOyBpbmRleCsrKSB7XG4gICAgICBpZiAodGV4dExvd2VyW2luZGV4XSAhPT0gbm9ybWFsaXplZFF1ZXJ5W3F1ZXJ5SW5kZXhdKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgaXNXb3JkQm91bmRhcnkgPSBpbmRleCA9PT0gMCB8fCAvW1xcc1xcLV8uLzpdLy50ZXN0KHRleHRMb3dlcltpbmRleCAtIDFdISk7XG4gICAgICBpZiAobGFzdE1hdGNoSW5kZXggPT09IGluZGV4IC0gMSkge1xuICAgICAgICBjb25zZWN1dGl2ZU1hdGNoZXMrKztcbiAgICAgICAgc2NvcmUgLT0gY29uc2VjdXRpdmVNYXRjaGVzICogNTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnNlY3V0aXZlTWF0Y2hlcyA9IDA7XG4gICAgICAgIGlmIChsYXN0TWF0Y2hJbmRleCA+PSAwKSB7XG4gICAgICAgICAgc2NvcmUgKz0gKGluZGV4IC0gbGFzdE1hdGNoSW5kZXggLSAxKSAqIDI7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKGlzV29yZEJvdW5kYXJ5KSB7XG4gICAgICAgIHNjb3JlIC09IDEwO1xuICAgICAgfVxuXG4gICAgICBzY29yZSArPSBpbmRleCAqIDAuMTtcbiAgICAgIGxhc3RNYXRjaEluZGV4ID0gaW5kZXg7XG4gICAgICBxdWVyeUluZGV4Kys7XG4gICAgfVxuXG4gICAgaWYgKHF1ZXJ5SW5kZXggPCBub3JtYWxpemVkUXVlcnkubGVuZ3RoKSB7XG4gICAgICByZXR1cm4geyBtYXRjaGVzOiBmYWxzZSwgc2NvcmU6IDAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4geyBtYXRjaGVzOiB0cnVlLCBzY29yZSB9O1xuICB9O1xuXG4gIGNvbnN0IHByaW1hcnlNYXRjaCA9IG1hdGNoUXVlcnkocXVlcnlMb3dlcik7XG4gIGlmIChwcmltYXJ5TWF0Y2gubWF0Y2hlcykge1xuICAgIHJldHVybiBwcmltYXJ5TWF0Y2g7XG4gIH1cblxuICBjb25zdCBhbHBoYU51bWVyaWNNYXRjaCA9IHF1ZXJ5TG93ZXIubWF0Y2goL14oPzxsZXR0ZXJzPlthLXpdKykoPzxkaWdpdHM+WzAtOV0rKSQvKTtcbiAgY29uc3QgbnVtZXJpY0FscGhhTWF0Y2ggPSBxdWVyeUxvd2VyLm1hdGNoKC9eKD88ZGlnaXRzPlswLTldKykoPzxsZXR0ZXJzPlthLXpdKykkLyk7XG4gIGNvbnN0IHN3YXBwZWRRdWVyeSA9IGFscGhhTnVtZXJpY01hdGNoXG4gICAgPyBgJHthbHBoYU51bWVyaWNNYXRjaC5ncm91cHM/LmRpZ2l0cyA/PyBcIlwifSR7YWxwaGFOdW1lcmljTWF0Y2guZ3JvdXBzPy5sZXR0ZXJzID8/IFwiXCJ9YFxuICAgIDogbnVtZXJpY0FscGhhTWF0Y2hcbiAgICAgID8gYCR7bnVtZXJpY0FscGhhTWF0Y2guZ3JvdXBzPy5sZXR0ZXJzID8/IFwiXCJ9JHtudW1lcmljQWxwaGFNYXRjaC5ncm91cHM/LmRpZ2l0cyA/PyBcIlwifWBcbiAgICAgIDogXCJcIjtcblxuICBpZiAoIXN3YXBwZWRRdWVyeSkge1xuICAgIHJldHVybiBwcmltYXJ5TWF0Y2g7XG4gIH1cblxuICBjb25zdCBzd2FwcGVkTWF0Y2ggPSBtYXRjaFF1ZXJ5KHN3YXBwZWRRdWVyeSk7XG4gIGlmICghc3dhcHBlZE1hdGNoLm1hdGNoZXMpIHtcbiAgICByZXR1cm4gcHJpbWFyeU1hdGNoO1xuICB9XG5cbiAgcmV0dXJuIHsgbWF0Y2hlczogdHJ1ZSwgc2NvcmU6IHN3YXBwZWRNYXRjaC5zY29yZSArIDUgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplV2hpdGVzcGFjZUxvd2VyKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBnZXRTZXNzaW9uU2VhcmNoVGV4dChzZXNzaW9uOiBTZXNzaW9uSW5mbyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtzZXNzaW9uLmlkfSAke3Nlc3Npb24ubmFtZSA/PyBcIlwifSAke3Nlc3Npb24uYWxsTWVzc2FnZXNUZXh0fSAke3Nlc3Npb24uY3dkfWA7XG59XG5cbmZ1bmN0aW9uIGhhc1Nlc3Npb25OYW1lKHNlc3Npb246IFNlc3Npb25JbmZvKTogYm9vbGVhbiB7XG4gIHJldHVybiBCb29sZWFuKHNlc3Npb24ubmFtZT8udHJpbSgpKTtcbn1cblxuZnVuY3Rpb24gcGFyc2VTZXNzaW9uU2VhcmNoUXVlcnkocXVlcnk6IHN0cmluZyk6IFBhcnNlZFNlc3Npb25TZWFyY2hRdWVyeSB7XG4gIGNvbnN0IHRyaW1tZWQgPSBxdWVyeS50cmltKCk7XG4gIGlmICghdHJpbW1lZCkge1xuICAgIHJldHVybiB7IG1vZGU6IFwidG9rZW5zXCIsIHRva2VuczogW10sIHJlZ2V4OiBudWxsIH07XG4gIH1cblxuICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwicmU6XCIpKSB7XG4gICAgY29uc3QgcGF0dGVybiA9IHRyaW1tZWQuc2xpY2UoMykudHJpbSgpO1xuICAgIGlmICghcGF0dGVybikge1xuICAgICAgcmV0dXJuIHsgbW9kZTogXCJyZWdleFwiLCB0b2tlbnM6IFtdLCByZWdleDogbnVsbCwgZXJyb3I6IFwiRW1wdHkgcmVnZXhcIiB9O1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICByZXR1cm4geyBtb2RlOiBcInJlZ2V4XCIsIHRva2VuczogW10sIHJlZ2V4OiBuZXcgUmVnRXhwKHBhdHRlcm4sIFwiaVwiKSB9O1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgcmV0dXJuIHsgbW9kZTogXCJyZWdleFwiLCB0b2tlbnM6IFtdLCByZWdleDogbnVsbCwgZXJyb3I6IG1lc3NhZ2UgfTtcbiAgICB9XG4gIH1cblxuICBjb25zdCB0b2tlbnM6IEFycmF5PHsga2luZDogXCJmdXp6eVwiIHwgXCJwaHJhc2VcIjsgdmFsdWU6IHN0cmluZyB9PiA9IFtdO1xuICBsZXQgYnVmZmVyID0gXCJcIjtcbiAgbGV0IGluUXVvdGUgPSBmYWxzZTtcbiAgbGV0IGhhZFVuY2xvc2VkUXVvdGUgPSBmYWxzZTtcblxuICBjb25zdCBmbHVzaCA9IChraW5kOiBcImZ1enp5XCIgfCBcInBocmFzZVwiKSA9PiB7XG4gICAgY29uc3QgdmFsdWUgPSBidWZmZXIudHJpbSgpO1xuICAgIGJ1ZmZlciA9IFwiXCI7XG4gICAgaWYgKCF2YWx1ZSkgcmV0dXJuO1xuICAgIHRva2Vucy5wdXNoKHsga2luZCwgdmFsdWUgfSk7XG4gIH07XG5cbiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHRyaW1tZWQubGVuZ3RoOyBpbmRleCsrKSB7XG4gICAgY29uc3QgY2hhcmFjdGVyID0gdHJpbW1lZFtpbmRleF07XG4gICAgaWYgKCFjaGFyYWN0ZXIpIGNvbnRpbnVlO1xuXG4gICAgaWYgKGNoYXJhY3RlciA9PT0gJ1wiJykge1xuICAgICAgaWYgKGluUXVvdGUpIHtcbiAgICAgICAgZmx1c2goXCJwaHJhc2VcIik7XG4gICAgICAgIGluUXVvdGUgPSBmYWxzZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZsdXNoKFwiZnV6enlcIik7XG4gICAgICAgIGluUXVvdGUgPSB0cnVlO1xuICAgICAgfVxuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKCFpblF1b3RlICYmIC9cXHMvLnRlc3QoY2hhcmFjdGVyKSkge1xuICAgICAgZmx1c2goXCJmdXp6eVwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGJ1ZmZlciArPSBjaGFyYWN0ZXI7XG4gIH1cblxuICBpZiAoaW5RdW90ZSkge1xuICAgIGhhZFVuY2xvc2VkUXVvdGUgPSB0cnVlO1xuICB9XG5cbiAgaWYgKGhhZFVuY2xvc2VkUXVvdGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgbW9kZTogXCJ0b2tlbnNcIixcbiAgICAgIHRva2VuczogdHJpbW1lZFxuICAgICAgICAuc3BsaXQoL1xccysvKVxuICAgICAgICAubWFwKCh2YWx1ZSkgPT4gdmFsdWUudHJpbSgpKVxuICAgICAgICAuZmlsdGVyKCh2YWx1ZSkgPT4gdmFsdWUubGVuZ3RoID4gMClcbiAgICAgICAgLm1hcCgodmFsdWUpID0+ICh7IGtpbmQ6IFwiZnV6enlcIiBhcyBjb25zdCwgdmFsdWUgfSkpLFxuICAgICAgcmVnZXg6IG51bGwsXG4gICAgfTtcbiAgfVxuXG4gIGZsdXNoKGluUXVvdGUgPyBcInBocmFzZVwiIDogXCJmdXp6eVwiKTtcbiAgcmV0dXJuIHsgbW9kZTogXCJ0b2tlbnNcIiwgdG9rZW5zLCByZWdleDogbnVsbCB9O1xufVxuXG5mdW5jdGlvbiBtYXRjaFNlc3Npb25TZWFyY2goc2Vzc2lvbjogU2Vzc2lvbkluZm8sIHBhcnNlZDogUGFyc2VkU2Vzc2lvblNlYXJjaFF1ZXJ5KTogeyBtYXRjaGVzOiBib29sZWFuOyBzY29yZTogbnVtYmVyIH0ge1xuICBjb25zdCB0ZXh0ID0gZ2V0U2Vzc2lvblNlYXJjaFRleHQoc2Vzc2lvbik7XG5cbiAgaWYgKHBhcnNlZC5tb2RlID09PSBcInJlZ2V4XCIpIHtcbiAgICBpZiAoIXBhcnNlZC5yZWdleCkge1xuICAgICAgcmV0dXJuIHsgbWF0Y2hlczogZmFsc2UsIHNjb3JlOiAwIH07XG4gICAgfVxuXG4gICAgY29uc3QgaW5kZXggPSB0ZXh0LnNlYXJjaChwYXJzZWQucmVnZXgpO1xuICAgIGlmIChpbmRleCA8IDApIHtcbiAgICAgIHJldHVybiB7IG1hdGNoZXM6IGZhbHNlLCBzY29yZTogMCB9O1xuICAgIH1cblxuICAgIHJldHVybiB7IG1hdGNoZXM6IHRydWUsIHNjb3JlOiBpbmRleCAqIDAuMSB9O1xuICB9XG5cbiAgaWYgKHBhcnNlZC50b2tlbnMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHsgbWF0Y2hlczogdHJ1ZSwgc2NvcmU6IDAgfTtcbiAgfVxuXG4gIGxldCB0b3RhbFNjb3JlID0gMDtcbiAgbGV0IG5vcm1hbGl6ZWRUZXh0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBmb3IgKGNvbnN0IHRva2VuIG9mIHBhcnNlZC50b2tlbnMpIHtcbiAgICBpZiAodG9rZW4ua2luZCA9PT0gXCJwaHJhc2VcIikge1xuICAgICAgaWYgKG5vcm1hbGl6ZWRUZXh0ID09PSBudWxsKSB7XG4gICAgICAgIG5vcm1hbGl6ZWRUZXh0ID0gbm9ybWFsaXplV2hpdGVzcGFjZUxvd2VyKHRleHQpO1xuICAgICAgfVxuICAgICAgY29uc3QgcGhyYXNlID0gbm9ybWFsaXplV2hpdGVzcGFjZUxvd2VyKHRva2VuLnZhbHVlKTtcbiAgICAgIGlmICghcGhyYXNlKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGluZGV4ID0gbm9ybWFsaXplZFRleHQuaW5kZXhPZihwaHJhc2UpO1xuICAgICAgaWYgKGluZGV4IDwgMCkge1xuICAgICAgICByZXR1cm4geyBtYXRjaGVzOiBmYWxzZSwgc2NvcmU6IDAgfTtcbiAgICAgIH1cbiAgICAgIHRvdGFsU2NvcmUgKz0gaW5kZXggKiAwLjE7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBmdXp6eSA9IGZ1enp5TWF0Y2godG9rZW4udmFsdWUsIHRleHQpO1xuICAgIGlmICghZnV6enkubWF0Y2hlcykge1xuICAgICAgcmV0dXJuIHsgbWF0Y2hlczogZmFsc2UsIHNjb3JlOiAwIH07XG4gICAgfVxuICAgIHRvdGFsU2NvcmUgKz0gZnV6enkuc2NvcmU7XG4gIH1cblxuICByZXR1cm4geyBtYXRjaGVzOiB0cnVlLCBzY29yZTogdG90YWxTY29yZSB9O1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJBbmRTb3J0U2Vzc2lvbnMoXG4gIHNlc3Npb25zOiBTZXNzaW9uSW5mb1tdLFxuICBxdWVyeTogc3RyaW5nLFxuICBzb3J0TW9kZTogUmV0dXJuVHlwZTx0eXBlb2Ygbm9ybWFsaXplU2Vzc2lvbkJyb3dzZXJRdWVyeT5bXCJzb3J0TW9kZVwiXSxcbiAgbmFtZUZpbHRlcjogUmV0dXJuVHlwZTx0eXBlb2Ygbm9ybWFsaXplU2Vzc2lvbkJyb3dzZXJRdWVyeT5bXCJuYW1lRmlsdGVyXCJdLFxuKTogU2Vzc2lvbkluZm9bXSB7XG4gIGNvbnN0IG5hbWVGaWx0ZXJlZCA9IG5hbWVGaWx0ZXIgPT09IFwiYWxsXCIgPyBzZXNzaW9ucyA6IHNlc3Npb25zLmZpbHRlcigoc2Vzc2lvbikgPT4gaGFzU2Vzc2lvbk5hbWUoc2Vzc2lvbikpO1xuICBjb25zdCB0cmltbWVkID0gcXVlcnkudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICByZXR1cm4gbmFtZUZpbHRlcmVkO1xuICB9XG5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VTZXNzaW9uU2VhcmNoUXVlcnkocXVlcnkpO1xuICBpZiAocGFyc2VkLmVycm9yKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG5cbiAgaWYgKHNvcnRNb2RlID09PSBcInJlY2VudFwiKSB7XG4gICAgY29uc3QgZmlsdGVyZWQ6IFNlc3Npb25JbmZvW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHNlc3Npb24gb2YgbmFtZUZpbHRlcmVkKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBtYXRjaFNlc3Npb25TZWFyY2goc2Vzc2lvbiwgcGFyc2VkKTtcbiAgICAgIGlmIChyZXN1bHQubWF0Y2hlcykge1xuICAgICAgICBmaWx0ZXJlZC5wdXNoKHNlc3Npb24pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZmlsdGVyZWQ7XG4gIH1cblxuICBjb25zdCBzY29yZWQ6IEFycmF5PHsgc2Vzc2lvbjogU2Vzc2lvbkluZm87IHNjb3JlOiBudW1iZXIgfT4gPSBbXTtcbiAgZm9yIChjb25zdCBzZXNzaW9uIG9mIG5hbWVGaWx0ZXJlZCkge1xuICAgIGNvbnN0IHJlc3VsdCA9IG1hdGNoU2Vzc2lvblNlYXJjaChzZXNzaW9uLCBwYXJzZWQpO1xuICAgIGlmICghcmVzdWx0Lm1hdGNoZXMpIGNvbnRpbnVlO1xuICAgIHNjb3JlZC5wdXNoKHsgc2Vzc2lvbiwgc2NvcmU6IHJlc3VsdC5zY29yZSB9KTtcbiAgfVxuXG4gIHNjb3JlZC5zb3J0KChsZWZ0LCByaWdodCkgPT4ge1xuICAgIGlmIChsZWZ0LnNjb3JlICE9PSByaWdodC5zY29yZSkge1xuICAgICAgcmV0dXJuIGxlZnQuc2NvcmUgLSByaWdodC5zY29yZTtcbiAgICB9XG4gICAgcmV0dXJuIHJpZ2h0LnNlc3Npb24ubW9kaWZpZWQuZ2V0VGltZSgpIC0gbGVmdC5zZXNzaW9uLm1vZGlmaWVkLmdldFRpbWUoKTtcbiAgfSk7XG5cbiAgcmV0dXJuIHNjb3JlZC5tYXAoKGVudHJ5KSA9PiBlbnRyeS5zZXNzaW9uKTtcbn1cblxuZXhwb3J0IHR5cGUgeyBBdXRvRGFzaGJvYXJkRGF0YSwgUnRrU2Vzc2lvblNhdmluZ3MgfTtcblxuZXhwb3J0IGludGVyZmFjZSBCcmlkZ2VMYXN0RXJyb3Ige1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIGF0OiBzdHJpbmc7XG4gIHBoYXNlOiBCcmlkZ2VMaWZlY3ljbGVQaGFzZTtcbiAgYWZ0ZXJTZXNzaW9uQXR0YWNobWVudDogYm9vbGVhbjtcbiAgY29tbWFuZFR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQnJpZGdlUnVudGltZVNuYXBzaG90IHtcbiAgcGhhc2U6IEJyaWRnZUxpZmVjeWNsZVBoYXNlO1xuICBwcm9qZWN0Q3dkOiBzdHJpbmc7XG4gIHByb2plY3RTZXNzaW9uc0Rpcjogc3RyaW5nO1xuICBwYWNrYWdlUm9vdDogc3RyaW5nO1xuICBzdGFydGVkQXQ6IHN0cmluZyB8IG51bGw7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xuICBjb25uZWN0aW9uQ291bnQ6IG51bWJlcjtcbiAgbGFzdENvbW1hbmRUeXBlOiBzdHJpbmcgfCBudWxsO1xuICBhY3RpdmVTZXNzaW9uSWQ6IHN0cmluZyB8IG51bGw7XG4gIGFjdGl2ZVNlc3Npb25GaWxlOiBzdHJpbmcgfCBudWxsO1xuICBzZXNzaW9uU3RhdGU6IFJwY1Nlc3Npb25TdGF0ZSB8IG51bGw7XG4gIGxhc3RFcnJvcjogQnJpZGdlTGFzdEVycm9yIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCcmlkZ2VSdW50aW1lQ29uZmlnIHtcbiAgcHJvamVjdEN3ZDogc3RyaW5nO1xuICBwcm9qZWN0U2Vzc2lvbnNEaXI6IHN0cmluZztcbiAgcGFja2FnZVJvb3Q6IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCb290UmVzdW1hYmxlU2Vzc2lvbiB7XG4gIGlkOiBzdHJpbmc7XG4gIHBhdGg6IHN0cmluZztcbiAgY3dkOiBzdHJpbmc7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIGNyZWF0ZWRBdDogc3RyaW5nO1xuICBtb2RpZmllZEF0OiBzdHJpbmc7XG4gIG1lc3NhZ2VDb3VudDogbnVtYmVyO1xuICBpc0FjdGl2ZTogYm9vbGVhbjtcbn1cblxuZXhwb3J0IHR5cGUge1xuICBHU0RXb3Jrc3BhY2VUYXNrVGFyZ2V0LFxuICBHU0RXb3Jrc3BhY2VTbGljZVRhcmdldCxcbiAgR1NEV29ya3NwYWNlTWlsZXN0b25lVGFyZ2V0LFxuICBHU0RXb3Jrc3BhY2VTY29wZVRhcmdldCxcbiAgR1NEV29ya3NwYWNlSW5kZXgsXG59O1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJvamVjdCBEZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCB0eXBlIFByb2plY3REZXRlY3Rpb25LaW5kID1cbiAgfCBcImFjdGl2ZS1nc2RcIiAgICAvLyAuZ3NkIHdpdGggbWlsZXN0b25lcyBcdTIwMTQgbm9ybWFsIG9wZXJhdGlvblxuICB8IFwiZW1wdHktZ3NkXCIgICAgIC8vIC5nc2QgZXhpc3RzIGJ1dCBubyBtaWxlc3RvbmVzIChmcmVzaGx5IGJvb3RzdHJhcHBlZClcbiAgfCBcInYxLWxlZ2FjeVwiICAgICAvLyAucGxhbm5pbmcvIGV4aXN0cywgbm8gLmdzZFxuICB8IFwiYnJvd25maWVsZFwiICAgIC8vIGV4aXN0aW5nIGNvZGUgKGdpdCwgcGFja2FnZS5qc29uLCBmaWxlcykgYnV0IG5vIC5nc2RcbiAgfCBcImJsYW5rXCI7ICAgICAgICAvLyBlbXB0eS9uZWFyLWVtcHR5IGZvbGRlclxuXG5leHBvcnQgaW50ZXJmYWNlIFByb2plY3REZXRlY3Rpb25TaWduYWxzIHtcbiAgaGFzR3NkRm9sZGVyOiBib29sZWFuO1xuICBoYXNQbGFubmluZ0ZvbGRlcjogYm9vbGVhbjtcbiAgaGFzR2l0UmVwbzogYm9vbGVhbjtcbiAgaGFzUGFja2FnZUpzb246IGJvb2xlYW47XG4gIGhhc0NhcmdvPzogYm9vbGVhbjtcbiAgaGFzR29Nb2Q/OiBib29sZWFuO1xuICBoYXNQeXByb2plY3Q/OiBib29sZWFuO1xuICAvKiogVHJ1ZSB3aGVuIHRoZSBkaXJlY3RvcnkgbG9va3MgbGlrZSBhIG1vbm9yZXBvIHJvb3QgKHdvcmtzcGFjZXMsIGxlcm5hLCBwbnBtLXdvcmtzcGFjZSwgZXRjLikgKi9cbiAgaXNNb25vcmVwbz86IGJvb2xlYW47XG4gIGZpbGVDb3VudDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFByb2plY3REZXRlY3Rpb24ge1xuICBraW5kOiBQcm9qZWN0RGV0ZWN0aW9uS2luZDtcbiAgc2lnbmFsczogUHJvamVjdERldGVjdGlvblNpZ25hbHM7XG59XG5cbi8qKlxuICogRGV0ZWN0IHdoZXRoZXIgYSBkaXJlY3RvcnkgbG9va3MgbGlrZSBhIG1vbm9yZXBvIHJvb3QuXG4gKlxuICogQ2hlY2tzIGZvciBjb21tb24gbW9ub3JlcG8gaW5kaWNhdG9yczpcbiAqIC0gYHBucG0td29ya3NwYWNlLnlhbWxgIChwbnBtIHdvcmtzcGFjZXMpXG4gKiAtIGBsZXJuYS5qc29uYCAoTGVybmEpXG4gKiAtIGBwYWNrYWdlLmpzb25gIHdpdGggYSBgd29ya3NwYWNlc2AgZmllbGQgKG5wbS95YXJuIHdvcmtzcGFjZXMpXG4gKiAtIGBydXNoLmpzb25gIChSdXNoKVxuICogLSBgbnguanNvbmAgKE54KVxuICogLSBgdHVyYm8uanNvbmAgKFR1cmJvcmVwbylcbiAqXG4gKiBUaGlzIGlzIGludGVudGlvbmFsbHkgY2hlYXAgXHUyMDE0IGZpbGUgZXhpc3RlbmNlIGNoZWNrcyBvbmx5LCB3aXRoIGEgc2luZ2xlXG4gKiBKU09OIHBhcnNlIGZvciBgcGFja2FnZS5qc29uYCB3b3Jrc3BhY2VzICh3aGljaCB3ZSdyZSBhbHJlYWR5IHJlYWRpbmdcbiAqIGluIG1hbnkgY29kZSBwYXRocykuIE5vIGRlZXAgZGlyZWN0b3J5IHNjYW5uaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0TW9ub3JlcG8oZGlyUGF0aDogc3RyaW5nLCBjaGVja0V4aXN0cz86IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgZXhpc3RzID0gY2hlY2tFeGlzdHMgPz8gKGdldEJyaWRnZURlcHMoKS5leGlzdHNTeW5jID8/IGV4aXN0c1N5bmMpO1xuXG4gIC8vIEZhc3QgY2hlY2tzIFx1MjAxNCBmaWxlIGV4aXN0ZW5jZSBvbmx5XG4gIGlmIChleGlzdHMoam9pbihkaXJQYXRoLCBcInBucG0td29ya3NwYWNlLnlhbWxcIikpKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKGV4aXN0cyhqb2luKGRpclBhdGgsIFwibGVybmEuanNvblwiKSkpIHJldHVybiB0cnVlO1xuICBpZiAoZXhpc3RzKGpvaW4oZGlyUGF0aCwgXCJydXNoLmpzb25cIikpKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKGV4aXN0cyhqb2luKGRpclBhdGgsIFwibnguanNvblwiKSkpIHJldHVybiB0cnVlO1xuICBpZiAoZXhpc3RzKGpvaW4oZGlyUGF0aCwgXCJ0dXJiby5qc29uXCIpKSkgcmV0dXJuIHRydWU7XG5cbiAgLy8gQ2hlY2sgcGFja2FnZS5qc29uIGZvciB3b3Jrc3BhY2VzIGZpZWxkIChucG0veWFybiB3b3Jrc3BhY2VzKVxuICBjb25zdCBwYWNrYWdlSnNvblBhdGggPSBqb2luKGRpclBhdGgsIFwicGFja2FnZS5qc29uXCIpO1xuICBpZiAoZXhpc3RzKHBhY2thZ2VKc29uUGF0aCkpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKHBhY2thZ2VKc29uUGF0aCwgXCJ1dGYtOFwiKTtcbiAgICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmIChwa2cud29ya3NwYWNlcyAhPSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE1hbGZvcm1lZCBKU09OIG9yIHVucmVhZGFibGUgXHUyMDE0IG5vdCBhIG1vbm9yZXBvIGluZGljYXRvclxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdFByb2plY3RLaW5kKHByb2plY3RDd2Q6IHN0cmluZyk6IFByb2plY3REZXRlY3Rpb24ge1xuICBjb25zdCBjaGVja0V4aXN0cyA9IGdldEJyaWRnZURlcHMoKS5leGlzdHNTeW5jID8/IGV4aXN0c1N5bmM7XG5cbiAgY29uc3QgaGFzR3NkRm9sZGVyID0gY2hlY2tFeGlzdHMoam9pbihwcm9qZWN0Q3dkLCBcIi5nc2RcIikpO1xuICBjb25zdCBoYXNQbGFubmluZ0ZvbGRlciA9IGNoZWNrRXhpc3RzKGpvaW4ocHJvamVjdEN3ZCwgXCIucGxhbm5pbmdcIikpO1xuICBjb25zdCBoYXNHaXRSZXBvID0gY2hlY2tFeGlzdHMoam9pbihwcm9qZWN0Q3dkLCBcIi5naXRcIikpO1xuICBjb25zdCBoYXNQYWNrYWdlSnNvbiA9IGNoZWNrRXhpc3RzKGpvaW4ocHJvamVjdEN3ZCwgXCJwYWNrYWdlLmpzb25cIikpO1xuICBjb25zdCBoYXNDYXJnbyA9IGNoZWNrRXhpc3RzKGpvaW4ocHJvamVjdEN3ZCwgXCJDYXJnby50b21sXCIpKTtcbiAgY29uc3QgaGFzR29Nb2QgPSBjaGVja0V4aXN0cyhqb2luKHByb2plY3RDd2QsIFwiZ28ubW9kXCIpKTtcbiAgY29uc3QgaGFzUHlwcm9qZWN0ID0gY2hlY2tFeGlzdHMoam9pbihwcm9qZWN0Q3dkLCBcInB5cHJvamVjdC50b21sXCIpKTtcbiAgY29uc3QgaXNNb25vcmVwbyA9IGRldGVjdE1vbm9yZXBvKHByb2plY3RDd2QsIGNoZWNrRXhpc3RzKTtcblxuICAvLyBDb3VudCB0b3AtbGV2ZWwgbm9uLWRvdCBlbnRyaWVzIChjaGVhcCBoZXVyaXN0aWMgZm9yIFwiaGFzIGNvZGVcIilcbiAgbGV0IGZpbGVDb3VudCA9IDA7XG4gIHRyeSB7XG4gICAgY29uc3QgZW50cmllcyA9IHJlYWRkaXJTeW5jKHByb2plY3RDd2QpO1xuICAgIGZpbGVDb3VudCA9IGVudHJpZXMuZmlsdGVyKGUgPT4gIWUuc3RhcnRzV2l0aChcIi5cIikpLmxlbmd0aDtcbiAgfSBjYXRjaCB7XG4gICAgLy8gQ2FuJ3QgcmVhZCBkaXIgXHUyMDE0IHRyZWF0IGFzIGJsYW5rXG4gIH1cblxuICBjb25zdCBzaWduYWxzOiBQcm9qZWN0RGV0ZWN0aW9uU2lnbmFscyA9IHtcbiAgICBoYXNHc2RGb2xkZXIsXG4gICAgaGFzUGxhbm5pbmdGb2xkZXIsXG4gICAgaGFzR2l0UmVwbyxcbiAgICBoYXNQYWNrYWdlSnNvbixcbiAgICBoYXNDYXJnbyxcbiAgICBoYXNHb01vZCxcbiAgICBoYXNQeXByb2plY3QsXG4gICAgaXNNb25vcmVwbyxcbiAgICBmaWxlQ291bnQsXG4gIH07XG5cbiAgbGV0IGtpbmQ6IFByb2plY3REZXRlY3Rpb25LaW5kO1xuXG4gIGlmIChoYXNHc2RGb2xkZXIpIHtcbiAgICAvLyBDaGVjayBpZiBtaWxlc3RvbmVzIGV4aXN0XG4gICAgY29uc3QgbWlsZXN0b25lc0RpciA9IGpvaW4ocHJvamVjdEN3ZCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiKTtcbiAgICBsZXQgaGFzTWlsZXN0b25lcyA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkaXJzID0gcmVhZGRpclN5bmMobWlsZXN0b25lc0RpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuICAgICAgaGFzTWlsZXN0b25lcyA9IGRpcnMuc29tZShkID0+IGQuaXNEaXJlY3RvcnkoKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBObyBtaWxlc3RvbmVzIGRpciBvciBjYW4ndCByZWFkIGl0XG4gICAgfVxuICAgIGtpbmQgPSBoYXNNaWxlc3RvbmVzID8gXCJhY3RpdmUtZ3NkXCIgOiBcImVtcHR5LWdzZFwiO1xuICB9IGVsc2UgaWYgKGhhc1BsYW5uaW5nRm9sZGVyKSB7XG4gICAga2luZCA9IFwidjEtbGVnYWN5XCI7XG4gIH0gZWxzZSBpZiAoaGFzUGFja2FnZUpzb24gfHwgaGFzQ2FyZ28gfHwgaGFzR29Nb2QgfHwgaGFzUHlwcm9qZWN0IHx8IGZpbGVDb3VudCA+IDIgfHwgKGhhc0dpdFJlcG8gJiYgZmlsZUNvdW50ID4gMCkpIHtcbiAgICBraW5kID0gXCJicm93bmZpZWxkXCI7XG4gIH0gZWxzZSB7XG4gICAga2luZCA9IFwiYmxhbmtcIjtcbiAgfVxuXG4gIHJldHVybiB7IGtpbmQsIHNpZ25hbHMgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEJvb3QgUGF5bG9hZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBCcmlkZ2VCb290UGF5bG9hZCB7XG4gIHByb2plY3Q6IHtcbiAgICBjd2Q6IHN0cmluZztcbiAgICBzZXNzaW9uc0Rpcjogc3RyaW5nO1xuICAgIHBhY2thZ2VSb290OiBzdHJpbmc7XG4gIH07XG4gIHdvcmtzcGFjZTogR1NEV29ya3NwYWNlSW5kZXg7XG4gIGF1dG86IEF1dG9EYXNoYm9hcmREYXRhO1xuICBvbmJvYXJkaW5nOiBPbmJvYXJkaW5nU3RhdGU7XG4gIG9uYm9hcmRpbmdOZWVkZWQ6IGJvb2xlYW47XG4gIHJlc3VtYWJsZVNlc3Npb25zOiBCb290UmVzdW1hYmxlU2Vzc2lvbltdO1xuICBicmlkZ2U6IEJyaWRnZVJ1bnRpbWVTbmFwc2hvdDtcbiAgcHJvamVjdERldGVjdGlvbjogUHJvamVjdERldGVjdGlvbjtcbn1cblxuZXhwb3J0IHR5cGUgQnJpZGdlU3RhdHVzRXZlbnQgPSB7XG4gIHR5cGU6IFwiYnJpZGdlX3N0YXR1c1wiO1xuICBicmlkZ2U6IEJyaWRnZVJ1bnRpbWVTbmFwc2hvdDtcbn07XG5cbmV4cG9ydCB0eXBlIEJyaWRnZUxpdmVTdGF0ZURvbWFpbiA9IFwiYXV0b1wiIHwgXCJ3b3Jrc3BhY2VcIiB8IFwicmVjb3ZlcnlcIiB8IFwicmVzdW1hYmxlX3Nlc3Npb25zXCI7XG5leHBvcnQgdHlwZSBCcmlkZ2VMaXZlU3RhdGVJbnZhbGlkYXRpb25Tb3VyY2UgPSBcImJyaWRnZV9ldmVudFwiIHwgXCJycGNfY29tbWFuZFwiIHwgXCJzZXNzaW9uX21hbmFnZVwiO1xuZXhwb3J0IHR5cGUgQnJpZGdlTGl2ZVN0YXRlSW52YWxpZGF0aW9uUmVhc29uID1cbiAgfCBcImFnZW50X2VuZFwiXG4gIHwgXCJ0dXJuX2VuZFwiXG4gIHwgXCJhdXRvX3JldHJ5X3N0YXJ0XCJcbiAgfCBcImF1dG9fcmV0cnlfZW5kXCJcbiAgfCBcImF1dG9fY29tcGFjdGlvbl9zdGFydFwiXG4gIHwgXCJhdXRvX2NvbXBhY3Rpb25fZW5kXCJcbiAgfCBcIm5ld19zZXNzaW9uXCJcbiAgfCBcInN3aXRjaF9zZXNzaW9uXCJcbiAgfCBcImZvcmtcIlxuICB8IFwic2V0X3Nlc3Npb25fbmFtZVwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvbkV2ZW50IHtcbiAgdHlwZTogXCJsaXZlX3N0YXRlX2ludmFsaWRhdGlvblwiO1xuICBhdDogc3RyaW5nO1xuICByZWFzb246IEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvblJlYXNvbjtcbiAgc291cmNlOiBCcmlkZ2VMaXZlU3RhdGVJbnZhbGlkYXRpb25Tb3VyY2U7XG4gIGRvbWFpbnM6IEJyaWRnZUxpdmVTdGF0ZURvbWFpbltdO1xuICB3b3Jrc3BhY2VJbmRleENhY2hlSW52YWxpZGF0ZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIEJyaWRnZUV2ZW50ID1cbiAgfCBBZ2VudFNlc3Npb25FdmVudFxuICB8IFJwY0V4dGVuc2lvblVJUmVxdWVzdFxuICB8IEJyaWRnZUV4dGVuc2lvbkVycm9yRXZlbnRcbiAgfCBCcmlkZ2VTdGF0dXNFdmVudFxuICB8IEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvbkV2ZW50O1xuXG5pbnRlcmZhY2UgQnJpZGdlQ2xpRW50cnkge1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGFyZ3M6IHN0cmluZ1tdO1xuICBjd2Q6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFNwYXduZWRScGNDaGlsZCBleHRlbmRzIENoaWxkUHJvY2VzcyB7XG4gIHN0ZGluOiBOb25OdWxsYWJsZTxDaGlsZFByb2Nlc3NbXCJzdGRpblwiXT47XG4gIHN0ZG91dDogTm9uTnVsbGFibGU8Q2hpbGRQcm9jZXNzW1wic3Rkb3V0XCJdPjtcbiAgc3RkZXJyOiBOb25OdWxsYWJsZTxDaGlsZFByb2Nlc3NbXCJzdGRlcnJcIl0+O1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ1JwY1JlcXVlc3Qge1xuICByZXNvbHZlOiAocmVzcG9uc2U6IFJwY1Jlc3BvbnNlKSA9PiB2b2lkO1xuICByZWplY3Q6IChlcnJvcjogRXJyb3IpID0+IHZvaWQ7XG4gIHRpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+O1xufVxuXG5pbnRlcmZhY2UgQnJpZGdlU2VydmljZURlcHMge1xuICBzcGF3bj86IChjb21tYW5kOiBzdHJpbmcsIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLCBvcHRpb25zOiBTcGF3bk9wdGlvbnMpID0+IENoaWxkUHJvY2VzcztcbiAgZXhpc3RzU3luYz86IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIGV4ZWNQYXRoPzogc3RyaW5nO1xuICBlbnY/OiBOb2RlSlMuUHJvY2Vzc0VudjtcbiAgaW5kZXhXb3Jrc3BhY2U/OiAoYmFzZVBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTxHU0RXb3Jrc3BhY2VJbmRleD47XG4gIGdldEF1dG9EYXNoYm9hcmREYXRhPzogKCkgPT4gQXV0b0Rhc2hib2FyZERhdGEgfCBQcm9taXNlPEF1dG9EYXNoYm9hcmREYXRhPjtcbiAgbGlzdFNlc3Npb25zPzogKHByb2plY3RTZXNzaW9uc0Rpcjogc3RyaW5nKSA9PiBQcm9taXNlPExvY2FsU2Vzc2lvbkluZm9bXT47XG4gIGdldE9uYm9hcmRpbmdTdGF0ZT86ICgpID0+IE9uYm9hcmRpbmdTdGF0ZSB8IFByb21pc2U8T25ib2FyZGluZ1N0YXRlPjtcbiAgZ2V0T25ib2FyZGluZ05lZWRlZD86IChhdXRoUGF0aDogc3RyaW5nLCBlbnY6IE5vZGVKUy5Qcm9jZXNzRW52KSA9PiBib29sZWFuIHwgUHJvbWlzZTxib29sZWFuPjtcbn1cblxudHlwZSBXb3Jrc3BhY2VJbmRleENhY2hlRW50cnkgPSB7XG4gIHZhbHVlOiBHU0RXb3Jrc3BhY2VJbmRleCB8IG51bGw7XG4gIGV4cGlyZXNBdDogbnVtYmVyO1xuICBwcm9taXNlOiBQcm9taXNlPEdTRFdvcmtzcGFjZUluZGV4PiB8IG51bGw7XG59O1xuXG5jb25zdCBkZWZhdWx0QnJpZGdlU2VydmljZURlcHM6IEJyaWRnZVNlcnZpY2VEZXBzID0ge1xuICBzcGF3bjogKGNvbW1hbmQsIGFyZ3MsIG9wdGlvbnMpID0+IHNwYXduKGNvbW1hbmQsIGFyZ3MsIG9wdGlvbnMpLFxuICBleGlzdHNTeW5jLFxuICBleGVjUGF0aDogcHJvY2Vzcy5leGVjUGF0aCxcbiAgZW52OiBwcm9jZXNzLmVudixcbiAgaW5kZXhXb3Jrc3BhY2U6IChiYXNlUGF0aDogc3RyaW5nKSA9PiBmYWxsYmFja1dvcmtzcGFjZUluZGV4KGJhc2VQYXRoKSxcbiAgZ2V0QXV0b0Rhc2hib2FyZERhdGE6IGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBkZXBzID0gZ2V0QnJpZGdlRGVwcygpO1xuICAgIGNvbnN0IGVudiA9IGRlcHMuZW52ID8/IHByb2Nlc3MuZW52O1xuICAgIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKGVudik7XG4gICAgcmV0dXJuIGF3YWl0IGNvbGxlY3RBdXRob3JpdGF0aXZlQXV0b0Rhc2hib2FyZERhdGEoY29uZmlnLnBhY2thZ2VSb290LCB7XG4gICAgICBleGVjUGF0aDogZGVwcy5leGVjUGF0aCA/PyBwcm9jZXNzLmV4ZWNQYXRoLFxuICAgICAgZW52LFxuICAgICAgZXhpc3RzU3luYzogZGVwcy5leGlzdHNTeW5jID8/IGV4aXN0c1N5bmMsXG4gICAgfSk7XG4gIH0sXG4gIGxpc3RTZXNzaW9uczogYXN5bmMgKHByb2plY3RTZXNzaW9uc0Rpcjogc3RyaW5nKSA9PiBsaXN0UHJvamVjdFNlc3Npb25zKHByb2plY3RTZXNzaW9uc0RpciksXG59O1xuXG5sZXQgYnJpZGdlU2VydmljZU92ZXJyaWRlczogUGFydGlhbDxCcmlkZ2VTZXJ2aWNlRGVwcz4gfCBudWxsID0gbnVsbDtcbmNvbnN0IHByb2plY3RCcmlkZ2VSZWdpc3RyeSA9IG5ldyBNYXA8c3RyaW5nLCBCcmlkZ2VTZXJ2aWNlPigpO1xuY29uc3Qgd29ya3NwYWNlSW5kZXhDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBXb3Jrc3BhY2VJbmRleENhY2hlRW50cnk+KCk7XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRTZXNzaW9uQnJvd3NlclNlc3Npb25zVmlhQ2hpbGRQcm9jZXNzKGNvbmZpZzogQnJpZGdlUnVudGltZUNvbmZpZyk6IFByb21pc2U8U2Vzc2lvbkluZm9bXT4ge1xuICBjb25zdCBkZXBzID0gZ2V0QnJpZGdlRGVwcygpO1xuICBjb25zdCBzZXNzaW9uTWFuYWdlck1vZHVsZVBhdGggPSBqb2luKGNvbmZpZy5wYWNrYWdlUm9vdCwgXCJwYWNrYWdlc1wiLCBcInBpLWNvZGluZy1hZ2VudFwiLCBcImRpc3RcIiwgXCJjb3JlXCIsIFwic2Vzc2lvbi1tYW5hZ2VyLmpzXCIpO1xuICBjb25zdCBjaGVja0V4aXN0cyA9IGRlcHMuZXhpc3RzU3luYyA/PyBleGlzdHNTeW5jO1xuICBpZiAoIWNoZWNrRXhpc3RzKHNlc3Npb25NYW5hZ2VyTW9kdWxlUGF0aCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHNlc3Npb24gbWFuYWdlciBtb2R1bGUgbm90IGZvdW5kOyBjaGVja2VkPSR7c2Vzc2lvbk1hbmFnZXJNb2R1bGVQYXRofWApO1xuICB9XG5cbiAgY29uc3Qgc2NyaXB0ID0gW1xuICAgICdjb25zdCB7IHBhdGhUb0ZpbGVVUkwgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6dXJsXCIpOycsXG4gICAgJ2NvbnN0IG1vZCA9IGF3YWl0IGltcG9ydChwYXRoVG9GaWxlVVJMKHByb2Nlc3MuZW52LkdTRF9TRVNTSU9OX01BTkFHRVJfTU9EVUxFKS5ocmVmKTsnLFxuICAgICdjb25zdCBzZXNzaW9ucyA9IGF3YWl0IG1vZC5TZXNzaW9uTWFuYWdlci5saXN0KHByb2Nlc3MuZW52LkdTRF9TRVNTSU9OX0JST1dTRVJfQ1dELCBwcm9jZXNzLmVudi5HU0RfU0VTU0lPTl9CUk9XU0VSX0RJUik7JyxcbiAgICAncHJvY2Vzcy5zdGRvdXQud3JpdGUoSlNPTi5zdHJpbmdpZnkoc2Vzc2lvbnMubWFwKChzZXNzaW9uKSA9PiAoeyAuLi5zZXNzaW9uLCBjcmVhdGVkOiBzZXNzaW9uLmNyZWF0ZWQudG9JU09TdHJpbmcoKSwgbW9kaWZpZWQ6IHNlc3Npb24ubW9kaWZpZWQudG9JU09TdHJpbmcoKSB9KSkpKTsnLFxuICBdLmpvaW4oXCIgXCIpO1xuXG4gIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxTZXNzaW9uSW5mb1tdPigocmVzb2x2ZVJlc3VsdCwgcmVqZWN0KSA9PiB7XG4gICAgZXhlY0ZpbGUoXG4gICAgICBkZXBzLmV4ZWNQYXRoID8/IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbXCItLWlucHV0LXR5cGU9bW9kdWxlXCIsIFwiLS1ldmFsXCIsIHNjcmlwdF0sXG4gICAgICB7XG4gICAgICAgIGN3ZDogY29uZmlnLnBhY2thZ2VSb290LFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi4oZGVwcy5lbnYgPz8gcHJvY2Vzcy5lbnYpLFxuICAgICAgICAgIEdTRF9TRVNTSU9OX01BTkFHRVJfTU9EVUxFOiBzZXNzaW9uTWFuYWdlck1vZHVsZVBhdGgsXG4gICAgICAgICAgR1NEX1NFU1NJT05fQlJPV1NFUl9DV0Q6IGNvbmZpZy5wcm9qZWN0Q3dkLFxuICAgICAgICAgIEdTRF9TRVNTSU9OX0JST1dTRVJfRElSOiBjb25maWcucHJvamVjdFNlc3Npb25zRGlyLFxuICAgICAgICB9LFxuICAgICAgICBtYXhCdWZmZXI6IDEwMjQgKiAxMDI0LFxuICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICAoZXJyb3IsIHN0ZG91dCwgc3RkZXJyKSA9PiB7XG4gICAgICAgIGlmIChlcnJvcikge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYHNlc3Npb24gbGlzdCBzdWJwcm9jZXNzIGZhaWxlZDogJHtzdGRlcnIgfHwgZXJyb3IubWVzc2FnZX1gKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHN0ZG91dCkgYXMgQXJyYXk8T21pdDxTZXNzaW9uSW5mbywgXCJjcmVhdGVkXCIgfCBcIm1vZGlmaWVkXCI+ICYgeyBjcmVhdGVkOiBzdHJpbmc7IG1vZGlmaWVkOiBzdHJpbmcgfT47XG4gICAgICAgICAgcmVzb2x2ZVJlc3VsdChcbiAgICAgICAgICAgIHBhcnNlZC5tYXAoKHNlc3Npb24pID0+ICh7XG4gICAgICAgICAgICAgIC4uLnNlc3Npb24sXG4gICAgICAgICAgICAgIGNyZWF0ZWQ6IG5ldyBEYXRlKHNlc3Npb24uY3JlYXRlZCksXG4gICAgICAgICAgICAgIG1vZGlmaWVkOiBuZXcgRGF0ZShzZXNzaW9uLm1vZGlmaWVkKSxcbiAgICAgICAgICAgIH0pKSxcbiAgICAgICAgICApO1xuICAgICAgICB9IGNhdGNoIChwYXJzZUVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KFxuICAgICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgICBgc2Vzc2lvbiBsaXN0IHN1YnByb2Nlc3MgcmV0dXJuZWQgaW52YWxpZCBKU09OOiAke3BhcnNlRXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IHBhcnNlRXJyb3IubWVzc2FnZSA6IFN0cmluZyhwYXJzZUVycm9yKX1gLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICk7XG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhcHBlbmRTZXNzaW9uSW5mb1ZpYUNoaWxkUHJvY2VzcyhcbiAgY29uZmlnOiBCcmlkZ2VSdW50aW1lQ29uZmlnLFxuICBzZXNzaW9uUGF0aDogc3RyaW5nLFxuICBuYW1lOiBzdHJpbmcsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZGVwcyA9IGdldEJyaWRnZURlcHMoKTtcbiAgY29uc3Qgc2Vzc2lvbk1hbmFnZXJNb2R1bGVQYXRoID0gam9pbihjb25maWcucGFja2FnZVJvb3QsIFwicGFja2FnZXNcIiwgXCJwaS1jb2RpbmctYWdlbnRcIiwgXCJkaXN0XCIsIFwiY29yZVwiLCBcInNlc3Npb24tbWFuYWdlci5qc1wiKTtcbiAgY29uc3QgY2hlY2tFeGlzdHMgPSBkZXBzLmV4aXN0c1N5bmMgPz8gZXhpc3RzU3luYztcbiAgaWYgKCFjaGVja0V4aXN0cyhzZXNzaW9uTWFuYWdlck1vZHVsZVBhdGgpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBzZXNzaW9uIG1hbmFnZXIgbW9kdWxlIG5vdCBmb3VuZDsgY2hlY2tlZD0ke3Nlc3Npb25NYW5hZ2VyTW9kdWxlUGF0aH1gKTtcbiAgfVxuXG4gIGNvbnN0IHNjcmlwdCA9IFtcbiAgICAnY29uc3QgeyBwYXRoVG9GaWxlVVJMIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnVybFwiKTsnLFxuICAgICdjb25zdCBtb2QgPSBhd2FpdCBpbXBvcnQocGF0aFRvRmlsZVVSTChwcm9jZXNzLmVudi5HU0RfU0VTU0lPTl9NQU5BR0VSX01PRFVMRSkuaHJlZik7JyxcbiAgICAnY29uc3QgbWFuYWdlciA9IG1vZC5TZXNzaW9uTWFuYWdlci5vcGVuKHByb2Nlc3MuZW52LkdTRF9UQVJHRVRfU0VTU0lPTl9QQVRILCBwcm9jZXNzLmVudi5HU0RfU0VTU0lPTl9CUk9XU0VSX0RJUik7JyxcbiAgICAnbWFuYWdlci5hcHBlbmRTZXNzaW9uSW5mbyhwcm9jZXNzLmVudi5HU0RfVEFSR0VUX1NFU1NJT05fTkFNRSk7JyxcbiAgXS5qb2luKFwiIFwiKTtcblxuICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVJlc3VsdCwgcmVqZWN0KSA9PiB7XG4gICAgZXhlY0ZpbGUoXG4gICAgICBkZXBzLmV4ZWNQYXRoID8/IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbXCItLWlucHV0LXR5cGU9bW9kdWxlXCIsIFwiLS1ldmFsXCIsIHNjcmlwdF0sXG4gICAgICB7XG4gICAgICAgIGN3ZDogY29uZmlnLnBhY2thZ2VSb290LFxuICAgICAgICBlbnY6IHtcbiAgICAgICAgICAuLi4oZGVwcy5lbnYgPz8gcHJvY2Vzcy5lbnYpLFxuICAgICAgICAgIEdTRF9TRVNTSU9OX01BTkFHRVJfTU9EVUxFOiBzZXNzaW9uTWFuYWdlck1vZHVsZVBhdGgsXG4gICAgICAgICAgR1NEX1NFU1NJT05fQlJPV1NFUl9ESVI6IGNvbmZpZy5wcm9qZWN0U2Vzc2lvbnNEaXIsXG4gICAgICAgICAgR1NEX1RBUkdFVF9TRVNTSU9OX1BBVEg6IHNlc3Npb25QYXRoLFxuICAgICAgICAgIEdTRF9UQVJHRVRfU0VTU0lPTl9OQU1FOiBuYW1lLFxuICAgICAgICB9LFxuICAgICAgICBtYXhCdWZmZXI6IDEwMjQgKiAxMDI0LFxuICAgICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICAoZXJyb3IsIF9zdGRvdXQsIHN0ZGVycikgPT4ge1xuICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICByZWplY3QobmV3IEVycm9yKGBzZXNzaW9uIHJlbmFtZSBzdWJwcm9jZXNzIGZhaWxlZDogJHtzdGRlcnIgfHwgZXJyb3IubWVzc2FnZX1gKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJlc29sdmVSZXN1bHQoKTtcbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIG5vd0lzbygpOiBzdHJpbmcge1xuICByZXR1cm4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiBzZXJpYWxpemVKc29uTGluZSh2YWx1ZTogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9XFxuYDtcbn1cblxuZnVuY3Rpb24gYXR0YWNoSnNvbkxpbmVSZWFkZXIoc3RyZWFtOiBSZWFkYWJsZSwgb25MaW5lOiAobGluZTogc3RyaW5nKSA9PiB2b2lkKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IGRlY29kZXIgPSBuZXcgU3RyaW5nRGVjb2RlcihcInV0ZjhcIik7XG4gIGxldCBidWZmZXIgPSBcIlwiO1xuXG4gIGNvbnN0IGVtaXRMaW5lID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG9uTGluZShsaW5lLmVuZHNXaXRoKFwiXFxyXCIpID8gbGluZS5zbGljZSgwLCAtMSkgOiBsaW5lKTtcbiAgfTtcblxuICBjb25zdCBvbkRhdGEgPSAoY2h1bms6IHN0cmluZyB8IEJ1ZmZlcikgPT4ge1xuICAgIGJ1ZmZlciArPSB0eXBlb2YgY2h1bmsgPT09IFwic3RyaW5nXCIgPyBjaHVuayA6IGRlY29kZXIud3JpdGUoY2h1bmspO1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBjb25zdCBuZXdsaW5lSW5kZXggPSBidWZmZXIuaW5kZXhPZihcIlxcblwiKTtcbiAgICAgIGlmIChuZXdsaW5lSW5kZXggPT09IC0xKSByZXR1cm47XG4gICAgICBlbWl0TGluZShidWZmZXIuc2xpY2UoMCwgbmV3bGluZUluZGV4KSk7XG4gICAgICBidWZmZXIgPSBidWZmZXIuc2xpY2UobmV3bGluZUluZGV4ICsgMSk7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IG9uRW5kID0gKCkgPT4ge1xuICAgIGJ1ZmZlciArPSBkZWNvZGVyLmVuZCgpO1xuICAgIGlmIChidWZmZXIubGVuZ3RoID4gMCkge1xuICAgICAgZW1pdExpbmUoYnVmZmVyKTtcbiAgICAgIGJ1ZmZlciA9IFwiXCI7XG4gICAgfVxuICB9O1xuXG4gIHN0cmVhbS5vbihcImRhdGFcIiwgb25EYXRhKTtcbiAgc3RyZWFtLm9uKFwiZW5kXCIsIG9uRW5kKTtcblxuICByZXR1cm4gKCkgPT4ge1xuICAgIHN0cmVhbS5vZmYoXCJkYXRhXCIsIG9uRGF0YSk7XG4gICAgc3RyZWFtLm9mZihcImVuZFwiLCBvbkVuZCk7XG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlZGFjdFNlbnNpdGl2ZVRleHQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZVxuICAgIC5yZXBsYWNlKC9zay1bQS1aYS16MC05Xy1dezYsfS9nLCBcIltyZWRhY3RlZF1cIilcbiAgICAucmVwbGFjZSgveG94W2JhcHJzXS1bQS1aYS16MC05LV0rL2csIFwiW3JlZGFjdGVkXVwiKVxuICAgIC5yZXBsYWNlKC9CZWFyZXJcXHMrW15cXHNdKy9naSwgXCJCZWFyZXIgW3JlZGFjdGVkXVwiKVxuICAgIC5yZXBsYWNlKC8oW0EtWjAtOV9dKig/OkFQSVtfLV0/S0VZfFRPS0VOfFNFQ1JFVClbXCInPTpcXHNdKykoW15cXHMsO1wiJ10rKS9naSwgXCIkMVtyZWRhY3RlZF1cIik7XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplRXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3ID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICByZXR1cm4gcmVkYWN0U2Vuc2l0aXZlVGV4dChyYXcpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gY2FwdHVyZVN0ZGVycihidWZmZXI6IHN0cmluZywgY2h1bms6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5leHQgPSBgJHtidWZmZXJ9JHtjaHVua31gO1xuICByZXR1cm4gbmV4dC5sZW5ndGggPD0gTUFYX1NUREVSUl9CVUZGRVIgPyBuZXh0IDogbmV4dC5zbGljZShuZXh0Lmxlbmd0aCAtIE1BWF9TVERFUlJfQlVGRkVSKTtcbn1cblxuZnVuY3Rpb24gYnVpbGRFeGl0TWVzc2FnZShjb2RlOiBudW1iZXIgfCBudWxsLCBzaWduYWw6IE5vZGVKUy5TaWduYWxzIHwgbnVsbCwgc3RkZXJyQnVmZmVyOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gYFJQQyBicmlkZ2UgZXhpdGVkJHtjb2RlICE9PSBudWxsID8gYCB3aXRoIGNvZGUgJHtjb2RlfWAgOiBcIlwifSR7c2lnbmFsID8gYCAoJHtzaWduYWx9KWAgOiBcIlwifWA7XG4gIGNvbnN0IHN0ZGVyciA9IHJlZGFjdFNlbnNpdGl2ZVRleHQoc3RkZXJyQnVmZmVyKS50cmltKCk7XG4gIHJldHVybiBzdGRlcnIgPyBgJHtiYXNlfS4gc3RkZXJyPSR7c3RkZXJyfWAgOiBiYXNlO1xufVxuXG5mdW5jdGlvbiBkZXN0cm95Q2hpbGRTdHJlYW1zKGNoaWxkOiBQYXJ0aWFsPFNwYXduZWRScGNDaGlsZD4gfCBudWxsIHwgdW5kZWZpbmVkKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgY2hpbGQ/LnN0ZGluPy5kZXN0cm95KCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIElnbm9yZSBjbGVhbnVwIGZhaWx1cmVzLlxuICB9XG4gIHRyeSB7XG4gICAgY2hpbGQ/LnN0ZG91dD8uZGVzdHJveSgpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBJZ25vcmUgY2xlYW51cCBmYWlsdXJlcy5cbiAgfVxuICB0cnkge1xuICAgIGNoaWxkPy5zdGRlcnI/LmRlc3Ryb3koKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gSWdub3JlIGNsZWFudXAgZmFpbHVyZXMuXG4gIH1cbn1cblxuZnVuY3Rpb24gZ2V0QnJpZGdlRGVwcygpOiBCcmlkZ2VTZXJ2aWNlRGVwcyB7XG4gIHJldHVybiB7IC4uLmRlZmF1bHRCcmlkZ2VTZXJ2aWNlRGVwcywgLi4uKGJyaWRnZVNlcnZpY2VPdmVycmlkZXMgPz8ge30pIH07XG59XG5cbmZ1bmN0aW9uIGNsb25lV29ya3NwYWNlSW5kZXgoaW5kZXg6IEdTRFdvcmtzcGFjZUluZGV4KTogR1NEV29ya3NwYWNlSW5kZXgge1xuICByZXR1cm4gc3RydWN0dXJlZENsb25lKGluZGV4KTtcbn1cblxuZnVuY3Rpb24gaW52YWxpZGF0ZVdvcmtzcGFjZUluZGV4Q2FjaGUoYmFzZVBhdGg/OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKGJhc2VQYXRoKSB7XG4gICAgd29ya3NwYWNlSW5kZXhDYWNoZS5kZWxldGUoYmFzZVBhdGgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHdvcmtzcGFjZUluZGV4Q2FjaGUuY2xlYXIoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZENhY2hlZFdvcmtzcGFjZUluZGV4KFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBsb2FkZXI6ICgpID0+IFByb21pc2U8R1NEV29ya3NwYWNlSW5kZXg+LFxuKTogUHJvbWlzZTxHU0RXb3Jrc3BhY2VJbmRleD4ge1xuICBjb25zdCBjYWNoZWQgPSB3b3Jrc3BhY2VJbmRleENhY2hlLmdldChiYXNlUGF0aCk7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cbiAgaWYgKGNhY2hlZD8udmFsdWUgJiYgY2FjaGVkLmV4cGlyZXNBdCA+IG5vdykge1xuICAgIHJldHVybiBjbG9uZVdvcmtzcGFjZUluZGV4KGNhY2hlZC52YWx1ZSk7XG4gIH1cblxuICBpZiAoY2FjaGVkPy5wcm9taXNlKSB7XG4gICAgcmV0dXJuIGNsb25lV29ya3NwYWNlSW5kZXgoYXdhaXQgY2FjaGVkLnByb21pc2UpO1xuICB9XG5cbiAgY29uc3QgcHJvbWlzZSA9IGxvYWRlcigpXG4gICAgLnRoZW4oKGluZGV4KSA9PiB7XG4gICAgICB3b3Jrc3BhY2VJbmRleENhY2hlLnNldChiYXNlUGF0aCwge1xuICAgICAgICB2YWx1ZTogY2xvbmVXb3Jrc3BhY2VJbmRleChpbmRleCksXG4gICAgICAgIGV4cGlyZXNBdDogRGF0ZS5ub3coKSArIFdPUktTUEFDRV9JTkRFWF9DQUNIRV9UVExfTVMsXG4gICAgICAgIHByb21pc2U6IG51bGwsXG4gICAgICB9KTtcbiAgICAgIHJldHVybiBpbmRleDtcbiAgICB9KVxuICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgIHdvcmtzcGFjZUluZGV4Q2FjaGUuZGVsZXRlKGJhc2VQYXRoKTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH0pO1xuXG4gIHdvcmtzcGFjZUluZGV4Q2FjaGUuc2V0KGJhc2VQYXRoLCB7XG4gICAgdmFsdWU6IGNhY2hlZD8udmFsdWUgPz8gbnVsbCxcbiAgICBleHBpcmVzQXQ6IDAsXG4gICAgcHJvbWlzZSxcbiAgfSk7XG5cbiAgcmV0dXJuIGNsb25lV29ya3NwYWNlSW5kZXgoYXdhaXQgcHJvbWlzZSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRXb3Jrc3BhY2VJbmRleFZpYUNoaWxkUHJvY2VzcyhiYXNlUGF0aDogc3RyaW5nLCBwYWNrYWdlUm9vdDogc3RyaW5nKTogUHJvbWlzZTxHU0RXb3Jrc3BhY2VJbmRleD4ge1xuICBjb25zdCBkZXBzID0gZ2V0QnJpZGdlRGVwcygpO1xuICBjb25zdCBjaGVja0V4aXN0cyA9IGRlcHMuZXhpc3RzU3luYyA/PyBleGlzdHNTeW5jO1xuICBjb25zdCByZXNvbHZlVHNMb2FkZXIgPSBqb2luKHBhY2thZ2VSb290LCBcInNyY1wiLCBcInJlc291cmNlc1wiLCBcImV4dGVuc2lvbnNcIiwgXCJnc2RcIiwgXCJ0ZXN0c1wiLCBcInJlc29sdmUtdHMubWpzXCIpO1xuICBjb25zdCBtb2R1bGVSZXNvbHV0aW9uID0gcmVzb2x2ZVN1YnByb2Nlc3NNb2R1bGUoXG4gICAgcGFja2FnZVJvb3QsXG4gICAgXCJyZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2Qvd29ya3NwYWNlLWluZGV4LnRzXCIsXG4gICAgY2hlY2tFeGlzdHMsXG4gICk7XG4gIGNvbnN0IHdvcmtzcGFjZU1vZHVsZVBhdGggPSBtb2R1bGVSZXNvbHV0aW9uLm1vZHVsZVBhdGg7XG4gIGlmICghbW9kdWxlUmVzb2x1dGlvbi51c2VDb21waWxlZEpzICYmICghY2hlY2tFeGlzdHMocmVzb2x2ZVRzTG9hZGVyKSB8fCAhY2hlY2tFeGlzdHMod29ya3NwYWNlTW9kdWxlUGF0aCkpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGB3b3Jrc3BhY2UgaW5kZXggbG9hZGVyIG5vdCBmb3VuZDsgY2hlY2tlZD0ke3Jlc29sdmVUc0xvYWRlcn0sJHt3b3Jrc3BhY2VNb2R1bGVQYXRofWApO1xuICB9XG4gIGlmIChtb2R1bGVSZXNvbHV0aW9uLnVzZUNvbXBpbGVkSnMgJiYgIWNoZWNrRXhpc3RzKHdvcmtzcGFjZU1vZHVsZVBhdGgpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGB3b3Jrc3BhY2UgaW5kZXggbW9kdWxlIG5vdCBmb3VuZDsgY2hlY2tlZD0ke3dvcmtzcGFjZU1vZHVsZVBhdGh9YCk7XG4gIH1cblxuICBjb25zdCBzY3JpcHQgPSBbXG4gICAgJ2NvbnN0IHsgcGF0aFRvRmlsZVVSTCB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1cmxcIik7JyxcbiAgICAnY29uc3QgbW9kID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocHJvY2Vzcy5lbnYuR1NEX1dPUktTUEFDRV9NT0RVTEUpLmhyZWYpOycsXG4gICAgJ2NvbnN0IHJlc3VsdCA9IGF3YWl0IG1vZC5pbmRleFdvcmtzcGFjZShwcm9jZXNzLmVudi5HU0RfV09SS1NQQUNFX0JBU0UpOycsXG4gICAgJ3Byb2Nlc3Muc3Rkb3V0LndyaXRlKEpTT04uc3RyaW5naWZ5KHJlc3VsdCkpOycsXG4gIF0uam9pbignICcpO1xuXG4gIGNvbnN0IHByZWZpeEFyZ3MgPSBidWlsZFN1YnByb2Nlc3NQcmVmaXhBcmdzKFxuICAgIHBhY2thZ2VSb290LFxuICAgIG1vZHVsZVJlc29sdXRpb24sXG4gICAgcGF0aFRvRmlsZVVSTChyZXNvbHZlVHNMb2FkZXIpLmhyZWYsXG4gICk7XG5cbiAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlPEdTRFdvcmtzcGFjZUluZGV4PigocmVzb2x2ZVJlc3VsdCwgcmVqZWN0KSA9PiB7XG4gICAgZXhlY0ZpbGUoXG4gICAgICBkZXBzLmV4ZWNQYXRoID8/IHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgICBbXG4gICAgICAgIC4uLnByZWZpeEFyZ3MsXG4gICAgICAgIFwiLS1ldmFsXCIsXG4gICAgICAgIHNjcmlwdCxcbiAgICAgIF0sXG4gICAgICB7XG4gICAgICAgIGN3ZDogcGFja2FnZVJvb3QsXG4gICAgICAgIGVudjoge1xuICAgICAgICAgIC4uLihkZXBzLmVudiA/PyBwcm9jZXNzLmVudiksXG4gICAgICAgICAgR1NEX1dPUktTUEFDRV9NT0RVTEU6IHdvcmtzcGFjZU1vZHVsZVBhdGgsXG4gICAgICAgICAgR1NEX1dPUktTUEFDRV9CQVNFOiBiYXNlUGF0aCxcbiAgICAgICAgfSxcbiAgICAgICAgbWF4QnVmZmVyOiAxMDI0ICogMTAyNCxcbiAgICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgICB9LFxuICAgICAgKGVycm9yLCBzdGRvdXQsIHN0ZGVycikgPT4ge1xuICAgICAgICBpZiAoZXJyb3IpIHtcbiAgICAgICAgICByZWplY3QobmV3IEVycm9yKGB3b3Jrc3BhY2UgaW5kZXggc3VicHJvY2VzcyBmYWlsZWQ6ICR7c3RkZXJyIHx8IGVycm9yLm1lc3NhZ2V9YCkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVzb2x2ZVJlc3VsdChKU09OLnBhcnNlKHN0ZG91dCkgYXMgR1NEV29ya3NwYWNlSW5kZXgpO1xuICAgICAgICB9IGNhdGNoIChwYXJzZUVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgd29ya3NwYWNlIGluZGV4IHN1YnByb2Nlc3MgcmV0dXJuZWQgaW52YWxpZCBKU09OOiAke3BhcnNlRXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IHBhcnNlRXJyb3IubWVzc2FnZSA6IFN0cmluZyhwYXJzZUVycm9yKX1gKSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGxlZ2FjeU9uYm9hcmRpbmdTdGF0ZUZyb21OZWVkZWQob25ib2FyZGluZ05lZWRlZDogYm9vbGVhbik6IE9uYm9hcmRpbmdTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgc3RhdHVzOiBvbmJvYXJkaW5nTmVlZGVkID8gXCJibG9ja2VkXCIgOiBcInJlYWR5XCIsXG4gICAgbG9ja2VkOiBvbmJvYXJkaW5nTmVlZGVkLFxuICAgIGxvY2tSZWFzb246IG9uYm9hcmRpbmdOZWVkZWQgPyBcInJlcXVpcmVkX3NldHVwXCIgOiBudWxsLFxuICAgIHJlcXVpcmVkOiB7XG4gICAgICBibG9ja2luZzogdHJ1ZSxcbiAgICAgIHNraXBwYWJsZTogZmFsc2UsXG4gICAgICBzYXRpc2ZpZWQ6ICFvbmJvYXJkaW5nTmVlZGVkLFxuICAgICAgc2F0aXNmaWVkQnk6IG9uYm9hcmRpbmdOZWVkZWQgPyBudWxsIDogeyBwcm92aWRlcklkOiBcImxlZ2FjeVwiLCBzb3VyY2U6IFwicnVudGltZVwiIH0sXG4gICAgICBwcm92aWRlcnM6IFtdLFxuICAgIH0sXG4gICAgb3B0aW9uYWw6IHtcbiAgICAgIGJsb2NraW5nOiBmYWxzZSxcbiAgICAgIHNraXBwYWJsZTogdHJ1ZSxcbiAgICAgIHNlY3Rpb25zOiBbXSxcbiAgICB9LFxuICAgIGxhc3RWYWxpZGF0aW9uOiBudWxsLFxuICAgIGFjdGl2ZUZsb3c6IG51bGwsXG4gICAgYnJpZGdlQXV0aFJlZnJlc2g6IHtcbiAgICAgIHBoYXNlOiBcImlkbGVcIixcbiAgICAgIHN0cmF0ZWd5OiBudWxsLFxuICAgICAgc3RhcnRlZEF0OiBudWxsLFxuICAgICAgY29tcGxldGVkQXQ6IG51bGwsXG4gICAgICBlcnJvcjogbnVsbCxcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZVNlc3Npb25JbmZvKHBhdGg6IHN0cmluZyk6IExvY2FsU2Vzc2lvbkluZm8gfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBsaW5lcyA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0Zi04XCIpXG4gICAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAgIC5tYXAoKGxpbmUpID0+IGxpbmUudHJpbSgpKVxuICAgICAgLmZpbHRlcihCb29sZWFuKTtcblxuICAgIGxldCBpZCA9IFwiXCI7XG4gICAgbGV0IGN3ZCA9IFwiXCI7XG4gICAgbGV0IG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgY3JlYXRlZCA9IHN0YXRTeW5jKHBhdGgpLmJpcnRodGltZTtcbiAgICBsZXQgbWVzc2FnZUNvdW50ID0gMDtcblxuICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmIChwYXJzZWQudHlwZSA9PT0gXCJzZXNzaW9uXCIpIHtcbiAgICAgICAgaWQgPSB0eXBlb2YgcGFyc2VkLmlkID09PSBcInN0cmluZ1wiID8gcGFyc2VkLmlkIDogaWQ7XG4gICAgICAgIGN3ZCA9IHR5cGVvZiBwYXJzZWQuY3dkID09PSBcInN0cmluZ1wiID8gcGFyc2VkLmN3ZCA6IGN3ZDtcbiAgICAgICAgaWYgKHR5cGVvZiBwYXJzZWQudGltZXN0YW1wID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgY3JlYXRlZCA9IG5ldyBEYXRlKHBhcnNlZC50aW1lc3RhbXApO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHBhcnNlZC50eXBlID09PSBcInNlc3Npb25faW5mb1wiICYmIHR5cGVvZiBwYXJzZWQubmFtZSA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBuYW1lID0gcGFyc2VkLm5hbWU7XG4gICAgICB9IGVsc2UgaWYgKHBhcnNlZC50eXBlID09PSBcIm1lc3NhZ2VcIikge1xuICAgICAgICBtZXNzYWdlQ291bnQgKz0gMTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIWlkKSByZXR1cm4gbnVsbDtcblxuICAgIHJldHVybiB7XG4gICAgICBwYXRoLFxuICAgICAgaWQsXG4gICAgICBjd2QsXG4gICAgICBuYW1lLFxuICAgICAgY3JlYXRlZCxcbiAgICAgIG1vZGlmaWVkOiBzdGF0U3luYyhwYXRoKS5tdGltZSxcbiAgICAgIG1lc3NhZ2VDb3VudCxcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBsaXN0UHJvamVjdFNlc3Npb25zKHByb2plY3RTZXNzaW9uc0Rpcjogc3RyaW5nKTogTG9jYWxTZXNzaW9uSW5mb1tdIHtcbiAgaWYgKCFleGlzdHNTeW5jKHByb2plY3RTZXNzaW9uc0RpcikpIHJldHVybiBbXTtcbiAgY29uc3Qgc2Vzc2lvbnMgPSByZWFkZGlyU3luYyhwcm9qZWN0U2Vzc2lvbnNEaXIpXG4gICAgLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LmVuZHNXaXRoKFwiLmpzb25sXCIpKVxuICAgIC5tYXAoKGVudHJ5KSA9PiBwYXJzZVNlc3Npb25JbmZvKGpvaW4ocHJvamVjdFNlc3Npb25zRGlyLCBlbnRyeSkpKVxuICAgIC5maWx0ZXIoKGVudHJ5KTogZW50cnkgaXMgTG9jYWxTZXNzaW9uSW5mbyA9PiBlbnRyeSAhPT0gbnVsbCk7XG5cbiAgc2Vzc2lvbnMuc29ydCgoYSwgYikgPT4gYi5tb2RpZmllZC5nZXRUaW1lKCkgLSBhLm1vZGlmaWVkLmdldFRpbWUoKSk7XG4gIHJldHVybiBzZXNzaW9ucztcbn1cblxuYXN5bmMgZnVuY3Rpb24gZmFsbGJhY2tXb3Jrc3BhY2VJbmRleChiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTxHU0RXb3Jrc3BhY2VJbmRleD4ge1xuICBjb25zdCBwYWNrYWdlUm9vdCA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKCkucGFja2FnZVJvb3Q7XG4gIHJldHVybiBhd2FpdCBsb2FkV29ya3NwYWNlSW5kZXhWaWFDaGlsZFByb2Nlc3MoYmFzZVBhdGgsIHBhY2thZ2VSb290KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKGVudjogTm9kZUpTLlByb2Nlc3NFbnYgPSBnZXRCcmlkZ2VEZXBzKCkuZW52ID8/IHByb2Nlc3MuZW52LCBwcm9qZWN0Q3dkT3ZlcnJpZGU/OiBzdHJpbmcpOiBCcmlkZ2VSdW50aW1lQ29uZmlnIHtcbiAgY29uc3QgcHJvamVjdEN3ZCA9IHByb2plY3RDd2RPdmVycmlkZSB8fCBlbnYuR1NEX1dFQl9QUk9KRUNUX0NXRCB8fCBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCBwcm9qZWN0U2Vzc2lvbnNEaXIgPSBlbnYuR1NEX1dFQl9QUk9KRUNUX1NFU1NJT05TX0RJUiB8fCBnZXRQcm9qZWN0U2Vzc2lvbnNEaXIocHJvamVjdEN3ZCk7XG4gIGNvbnN0IHBhY2thZ2VSb290ID0gZW52LkdTRF9XRUJfUEFDS0FHRV9ST09UIHx8IGdldERlZmF1bHRQYWNrYWdlUm9vdCgpO1xuICByZXR1cm4geyBwcm9qZWN0Q3dkLCBwcm9qZWN0U2Vzc2lvbnNEaXIsIHBhY2thZ2VSb290IH07XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVCcmlkZ2VDbGlFbnRyeShjb25maWc6IEJyaWRnZVJ1bnRpbWVDb25maWcsIGRlcHM6IEJyaWRnZVNlcnZpY2VEZXBzKTogQnJpZGdlQ2xpRW50cnkge1xuICByZXR1cm4gcmVzb2x2ZUdzZENsaUVudHJ5KHtcbiAgICBwYWNrYWdlUm9vdDogY29uZmlnLnBhY2thZ2VSb290LFxuICAgIGN3ZDogY29uZmlnLnByb2plY3RDd2QsXG4gICAgZXhlY1BhdGg6IGRlcHMuZXhlY1BhdGggPz8gcHJvY2Vzcy5leGVjUGF0aCxcbiAgICBob3N0S2luZDogKGRlcHMuZW52ID8/IHByb2Nlc3MuZW52KS5HU0RfV0VCX0hPU1RfS0lORCxcbiAgICBtb2RlOiBcInJwY1wiLFxuICAgIHNlc3Npb25EaXI6IGNvbmZpZy5wcm9qZWN0U2Vzc2lvbnNEaXIsXG4gICAgZXhpc3RzU3luYzogZGVwcy5leGlzdHNTeW5jID8/IGV4aXN0c1N5bmMsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBpc1JwY0V4dGVuc2lvblVpUmVzcG9uc2UoaW5wdXQ6IEJyaWRnZUlucHV0KTogaW5wdXQgaXMgUnBjRXh0ZW5zaW9uVUlSZXNwb25zZSB7XG4gIHJldHVybiBpbnB1dC50eXBlID09PSBcImV4dGVuc2lvbl91aV9yZXNwb25zZVwiO1xufVxuXG5mdW5jdGlvbiBpc1JlYWRPbmx5QnJpZGdlSW5wdXQoaW5wdXQ6IEJyaWRnZUlucHV0KTogYm9vbGVhbiB7XG4gIGlmIChpc1JwY0V4dGVuc2lvblVpUmVzcG9uc2UoaW5wdXQpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiBSRUFEX09OTFlfUlBDX0NPTU1BTkRfVFlQRVMuaGFzKGlucHV0LnR5cGUpO1xufVxuXG5mdW5jdGlvbiBidWlsZEJyaWRnZUxvY2tlZFJlc3BvbnNlKGlucHV0OiBCcmlkZ2VJbnB1dCwgb25ib2FyZGluZzogT25ib2FyZGluZ1N0YXRlKTogQnJpZGdlQ29tbWFuZEZhaWx1cmVSZXNwb25zZSB7XG4gIGNvbnN0IHJlYXNvbiA9IG9uYm9hcmRpbmcubG9ja1JlYXNvbiA/PyBcInJlcXVpcmVkX3NldHVwXCI7XG4gIGNvbnN0IGVycm9yID1cbiAgICByZWFzb24gPT09IFwiYnJpZGdlX3JlZnJlc2hfZmFpbGVkXCJcbiAgICAgID8gXCJXb3Jrc3BhY2UgaXMgbG9ja2VkIGJlY2F1c2UgYnJpZGdlIGF1dGggcmVmcmVzaCBmYWlsZWQgYWZ0ZXIgc2V0dXBcIlxuICAgICAgOiByZWFzb24gPT09IFwiYnJpZGdlX3JlZnJlc2hfcGVuZGluZ1wiXG4gICAgICAgID8gXCJXb3Jrc3BhY2UgaXMgc3RpbGwgbG9ja2VkIHdoaWxlIGJyaWRnZSBhdXRoIHJlZnJlc2ggY29tcGxldGVzXCJcbiAgICAgICAgOiBcIldvcmtzcGFjZSBpcyBsb2NrZWQgdW50aWwgcmVxdWlyZWQgb25ib2FyZGluZyBjb21wbGV0ZXNcIjtcblxuICByZXR1cm4ge1xuICAgIHR5cGU6IFwicmVzcG9uc2VcIixcbiAgICBjb21tYW5kOiBpbnB1dC50eXBlLFxuICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgIGVycm9yLFxuICAgIGNvZGU6IFwib25ib2FyZGluZ19sb2NrZWRcIixcbiAgICBkZXRhaWxzOiB7XG4gICAgICByZWFzb24sXG4gICAgICBvbmJvYXJkaW5nOiB7XG4gICAgICAgIGxvY2tlZDogb25ib2FyZGluZy5sb2NrZWQsXG4gICAgICAgIGxvY2tSZWFzb246IG9uYm9hcmRpbmcubG9ja1JlYXNvbixcbiAgICAgICAgcmVxdWlyZWQ6IG9uYm9hcmRpbmcucmVxdWlyZWQsXG4gICAgICAgIGxhc3RWYWxpZGF0aW9uOiBvbmJvYXJkaW5nLmxhc3RWYWxpZGF0aW9uLFxuICAgICAgICBicmlkZ2VBdXRoUmVmcmVzaDogb25ib2FyZGluZy5icmlkZ2VBdXRoUmVmcmVzaCxcbiAgICAgIH0sXG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gc2FuaXRpemVScGNSZXNwb25zZShyZXNwb25zZTogUnBjUmVzcG9uc2UpOiBScGNSZXNwb25zZSB7XG4gIGlmIChyZXNwb25zZS5zdWNjZXNzKSByZXR1cm4gcmVzcG9uc2U7XG4gIHJldHVybiB7IC4uLnJlc3BvbnNlLCBlcnJvcjogcmVkYWN0U2Vuc2l0aXZlVGV4dChyZXNwb25zZS5lcnJvcikgfSBzYXRpc2ZpZXMgUnBjUmVzcG9uc2U7XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplRXZlbnRQYXlsb2FkKHBheWxvYWQ6IHVua25vd24pOiBCcmlkZ2VFdmVudCB7XG4gIGlmIChcbiAgICB0eXBlb2YgcGF5bG9hZCA9PT0gXCJvYmplY3RcIiAmJlxuICAgIHBheWxvYWQgIT09IG51bGwgJiZcbiAgICBcInR5cGVcIiBpbiBwYXlsb2FkICYmXG4gICAgKHBheWxvYWQgYXMgeyB0eXBlPzogc3RyaW5nIH0pLnR5cGUgPT09IFwiZXh0ZW5zaW9uX2Vycm9yXCJcbiAgKSB7XG4gICAgY29uc3QgZXh0ZW5zaW9uRXJyb3IgPSBwYXlsb2FkIGFzIEJyaWRnZUV4dGVuc2lvbkVycm9yRXZlbnQ7XG4gICAgcmV0dXJuIHsgLi4uZXh0ZW5zaW9uRXJyb3IsIGVycm9yOiByZWRhY3RTZW5zaXRpdmVUZXh0KGV4dGVuc2lvbkVycm9yLmVycm9yKSB9O1xuICB9XG4gIHJldHVybiBwYXlsb2FkIGFzIEJyaWRnZUV2ZW50O1xufVxuXG50eXBlIEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvbkRlc2NyaXB0b3IgPSB7XG4gIHJlYXNvbjogQnJpZGdlTGl2ZVN0YXRlSW52YWxpZGF0aW9uUmVhc29uO1xuICBzb3VyY2U6IEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvblNvdXJjZTtcbiAgZG9tYWluczogQnJpZGdlTGl2ZVN0YXRlRG9tYWluW107XG4gIHdvcmtzcGFjZUluZGV4Q2FjaGVJbnZhbGlkYXRlZD86IGJvb2xlYW47XG59O1xuXG5mdW5jdGlvbiB1bmlxdWVMaXZlU3RhdGVEb21haW5zKGRvbWFpbnM6IEJyaWRnZUxpdmVTdGF0ZURvbWFpbltdKTogQnJpZGdlTGl2ZVN0YXRlRG9tYWluW10ge1xuICByZXR1cm4gWy4uLm5ldyBTZXQoZG9tYWlucyldO1xufVxuXG5mdW5jdGlvbiBidWlsZExpdmVTdGF0ZUludmFsaWRhdGlvbkV2ZW50KFxuICBkZXNjcmlwdG9yOiBCcmlkZ2VMaXZlU3RhdGVJbnZhbGlkYXRpb25EZXNjcmlwdG9yLFxuKTogQnJpZGdlTGl2ZVN0YXRlSW52YWxpZGF0aW9uRXZlbnQge1xuICByZXR1cm4ge1xuICAgIHR5cGU6IFwibGl2ZV9zdGF0ZV9pbnZhbGlkYXRpb25cIixcbiAgICBhdDogbm93SXNvKCksXG4gICAgcmVhc29uOiBkZXNjcmlwdG9yLnJlYXNvbixcbiAgICBzb3VyY2U6IGRlc2NyaXB0b3Iuc291cmNlLFxuICAgIGRvbWFpbnM6IHVuaXF1ZUxpdmVTdGF0ZURvbWFpbnMoZGVzY3JpcHRvci5kb21haW5zKSxcbiAgICB3b3Jrc3BhY2VJbmRleENhY2hlSW52YWxpZGF0ZWQ6IEJvb2xlYW4oZGVzY3JpcHRvci53b3Jrc3BhY2VJbmRleENhY2hlSW52YWxpZGF0ZWQpLFxuICB9O1xufVxuXG5mdW5jdGlvbiBjcmVhdGVMaXZlU3RhdGVJbnZhbGlkYXRpb25Gcm9tQnJpZGdlRXZlbnQoXG4gIGV2ZW50OiBCcmlkZ2VFdmVudCxcbik6IEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvbkRlc2NyaXB0b3IgfCBudWxsIHtcbiAgaWYgKHR5cGVvZiBldmVudCAhPT0gXCJvYmplY3RcIiB8fCBldmVudCA9PT0gbnVsbCB8fCAhKFwidHlwZVwiIGluIGV2ZW50KSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgc3dpdGNoIChldmVudC50eXBlKSB7XG4gICAgY2FzZSBcImFnZW50X2VuZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVhc29uOiBcImFnZW50X2VuZFwiLFxuICAgICAgICBzb3VyY2U6IFwiYnJpZGdlX2V2ZW50XCIsXG4gICAgICAgIGRvbWFpbnM6IFtcImF1dG9cIiwgXCJ3b3Jrc3BhY2VcIiwgXCJyZWNvdmVyeVwiXSxcbiAgICAgICAgd29ya3NwYWNlSW5kZXhDYWNoZUludmFsaWRhdGVkOiB0cnVlLFxuICAgICAgfTtcbiAgICBjYXNlIFwidHVybl9lbmRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHJlYXNvbjogXCJ0dXJuX2VuZFwiLFxuICAgICAgICBzb3VyY2U6IFwiYnJpZGdlX2V2ZW50XCIsXG4gICAgICAgIGRvbWFpbnM6IFtcIndvcmtzcGFjZVwiXSxcbiAgICAgICAgd29ya3NwYWNlSW5kZXhDYWNoZUludmFsaWRhdGVkOiB0cnVlLFxuICAgICAgfTtcbiAgICBjYXNlIFwiYXV0b19yZXRyeV9zdGFydFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVhc29uOiBcImF1dG9fcmV0cnlfc3RhcnRcIixcbiAgICAgICAgc291cmNlOiBcImJyaWRnZV9ldmVudFwiLFxuICAgICAgICBkb21haW5zOiBbXCJhdXRvXCIsIFwicmVjb3ZlcnlcIl0sXG4gICAgICB9O1xuICAgIGNhc2UgXCJhdXRvX3JldHJ5X2VuZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVhc29uOiBcImF1dG9fcmV0cnlfZW5kXCIsXG4gICAgICAgIHNvdXJjZTogXCJicmlkZ2VfZXZlbnRcIixcbiAgICAgICAgZG9tYWluczogW1wiYXV0b1wiLCBcInJlY292ZXJ5XCJdLFxuICAgICAgfTtcbiAgICBjYXNlIFwiYXV0b19jb21wYWN0aW9uX3N0YXJ0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICByZWFzb246IFwiYXV0b19jb21wYWN0aW9uX3N0YXJ0XCIsXG4gICAgICAgIHNvdXJjZTogXCJicmlkZ2VfZXZlbnRcIixcbiAgICAgICAgZG9tYWluczogW1wiYXV0b1wiLCBcInJlY292ZXJ5XCJdLFxuICAgICAgfTtcbiAgICBjYXNlIFwiYXV0b19jb21wYWN0aW9uX2VuZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVhc29uOiBcImF1dG9fY29tcGFjdGlvbl9lbmRcIixcbiAgICAgICAgc291cmNlOiBcImJyaWRnZV9ldmVudFwiLFxuICAgICAgICBkb21haW5zOiBbXCJhdXRvXCIsIFwicmVjb3ZlcnlcIl0sXG4gICAgICB9O1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVMaXZlU3RhdGVJbnZhbGlkYXRpb25Gcm9tQ29tbWFuZChcbiAgaW5wdXQ6IFJwY0NvbW1hbmQsXG4gIHJlc3BvbnNlOiBScGNSZXNwb25zZSxcbik6IEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvbkRlc2NyaXB0b3IgfCBudWxsIHtcbiAgaWYgKCFyZXNwb25zZS5zdWNjZXNzKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBzd2l0Y2ggKGlucHV0LnR5cGUpIHtcbiAgICBjYXNlIFwibmV3X3Nlc3Npb25cIjpcbiAgICAgIHJldHVybiByZXNwb25zZS5jb21tYW5kID09PSBcIm5ld19zZXNzaW9uXCIgJiYgcmVzcG9uc2UuZGF0YS5jYW5jZWxsZWQgPT09IGZhbHNlXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhc29uOiBcIm5ld19zZXNzaW9uXCIsXG4gICAgICAgICAgICBzb3VyY2U6IFwicnBjX2NvbW1hbmRcIixcbiAgICAgICAgICAgIGRvbWFpbnM6IFtcInJlc3VtYWJsZV9zZXNzaW9uc1wiLCBcInJlY292ZXJ5XCJdLFxuICAgICAgICAgIH1cbiAgICAgICAgOiBudWxsO1xuICAgIGNhc2UgXCJzd2l0Y2hfc2Vzc2lvblwiOlxuICAgICAgcmV0dXJuIHJlc3BvbnNlLmNvbW1hbmQgPT09IFwic3dpdGNoX3Nlc3Npb25cIiAmJiByZXNwb25zZS5kYXRhLmNhbmNlbGxlZCA9PT0gZmFsc2VcbiAgICAgICAgPyB7XG4gICAgICAgICAgICByZWFzb246IFwic3dpdGNoX3Nlc3Npb25cIixcbiAgICAgICAgICAgIHNvdXJjZTogXCJycGNfY29tbWFuZFwiLFxuICAgICAgICAgICAgZG9tYWluczogW1wicmVzdW1hYmxlX3Nlc3Npb25zXCIsIFwicmVjb3ZlcnlcIl0sXG4gICAgICAgICAgfVxuICAgICAgICA6IG51bGw7XG4gICAgY2FzZSBcImZvcmtcIjpcbiAgICAgIHJldHVybiByZXNwb25zZS5jb21tYW5kID09PSBcImZvcmtcIiAmJiByZXNwb25zZS5kYXRhLmNhbmNlbGxlZCA9PT0gZmFsc2VcbiAgICAgICAgPyB7XG4gICAgICAgICAgICByZWFzb246IFwiZm9ya1wiLFxuICAgICAgICAgICAgc291cmNlOiBcInJwY19jb21tYW5kXCIsXG4gICAgICAgICAgICBkb21haW5zOiBbXCJyZXN1bWFibGVfc2Vzc2lvbnNcIiwgXCJyZWNvdmVyeVwiXSxcbiAgICAgICAgICB9XG4gICAgICAgIDogbnVsbDtcbiAgICBjYXNlIFwic2V0X3Nlc3Npb25fbmFtZVwiOlxuICAgICAgcmV0dXJuIHJlc3BvbnNlLmNvbW1hbmQgPT09IFwic2V0X3Nlc3Npb25fbmFtZVwiXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhc29uOiBcInNldF9zZXNzaW9uX25hbWVcIixcbiAgICAgICAgICAgIHNvdXJjZTogXCJycGNfY29tbWFuZFwiLFxuICAgICAgICAgICAgZG9tYWluczogW1wicmVzdW1hYmxlX3Nlc3Npb25zXCJdLFxuICAgICAgICAgIH1cbiAgICAgICAgOiBudWxsO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc0JyaWRnZVRlcm1pbmFsT3V0cHV0RXZlbnQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBCcmlkZ2VUZXJtaW5hbE91dHB1dEV2ZW50IHtcbiAgcmV0dXJuIChcbiAgICB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiZcbiAgICB2YWx1ZSAhPT0gbnVsbCAmJlxuICAgIFwidHlwZVwiIGluIHZhbHVlICYmXG4gICAgKHZhbHVlIGFzIHsgdHlwZT86IHVua25vd24gfSkudHlwZSA9PT0gXCJ0ZXJtaW5hbF9vdXRwdXRcIiAmJlxuICAgIHR5cGVvZiAodmFsdWUgYXMgeyBkYXRhPzogdW5rbm93biB9KS5kYXRhID09PSBcInN0cmluZ1wiXG4gICk7XG59XG5cbmZ1bmN0aW9uIGlzQnJpZGdlU2Vzc2lvblN0YXRlQ2hhbmdlZEV2ZW50KHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgQnJpZGdlU2Vzc2lvblN0YXRlQ2hhbmdlZEV2ZW50IHtcbiAgcmV0dXJuIChcbiAgICB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiZcbiAgICB2YWx1ZSAhPT0gbnVsbCAmJlxuICAgIFwidHlwZVwiIGluIHZhbHVlICYmXG4gICAgKHZhbHVlIGFzIHsgdHlwZT86IHVua25vd24gfSkudHlwZSA9PT0gXCJzZXNzaW9uX3N0YXRlX2NoYW5nZWRcIiAmJlxuICAgIHR5cGVvZiAodmFsdWUgYXMgeyByZWFzb24/OiB1bmtub3duIH0pLnJlYXNvbiA9PT0gXCJzdHJpbmdcIlxuICApO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVMaXZlU3RhdGVJbnZhbGlkYXRpb25Gcm9tU2Vzc2lvblN0YXRlQ2hhbmdlKFxuICByZWFzb246IFNlc3Npb25TdGF0ZUNoYW5nZVJlYXNvbixcbik6IEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvbkRlc2NyaXB0b3IgfCBudWxsIHtcbiAgc3dpdGNoIChyZWFzb24pIHtcbiAgICBjYXNlIFwibmV3X3Nlc3Npb25cIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHJlYXNvbjogXCJuZXdfc2Vzc2lvblwiLFxuICAgICAgICBzb3VyY2U6IFwiYnJpZGdlX2V2ZW50XCIsXG4gICAgICAgIGRvbWFpbnM6IFtcInJlc3VtYWJsZV9zZXNzaW9uc1wiLCBcInJlY292ZXJ5XCJdLFxuICAgICAgfTtcbiAgICBjYXNlIFwic3dpdGNoX3Nlc3Npb25cIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHJlYXNvbjogXCJzd2l0Y2hfc2Vzc2lvblwiLFxuICAgICAgICBzb3VyY2U6IFwiYnJpZGdlX2V2ZW50XCIsXG4gICAgICAgIGRvbWFpbnM6IFtcInJlc3VtYWJsZV9zZXNzaW9uc1wiLCBcInJlY292ZXJ5XCJdLFxuICAgICAgfTtcbiAgICBjYXNlIFwiZm9ya1wiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVhc29uOiBcImZvcmtcIixcbiAgICAgICAgc291cmNlOiBcImJyaWRnZV9ldmVudFwiLFxuICAgICAgICBkb21haW5zOiBbXCJyZXN1bWFibGVfc2Vzc2lvbnNcIiwgXCJyZWNvdmVyeVwiXSxcbiAgICAgIH07XG4gICAgY2FzZSBcInNldF9zZXNzaW9uX25hbWVcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHJlYXNvbjogXCJzZXRfc2Vzc2lvbl9uYW1lXCIsXG4gICAgICAgIHNvdXJjZTogXCJicmlkZ2VfZXZlbnRcIixcbiAgICAgICAgZG9tYWluczogW1wicmVzdW1hYmxlX3Nlc3Npb25zXCJdLFxuICAgICAgfTtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIEJyaWRnZVNlcnZpY2Uge1xuICBwcml2YXRlIHJlYWRvbmx5IHN1YnNjcmliZXJzID0gbmV3IFNldDwoZXZlbnQ6IEJyaWRnZUV2ZW50KSA9PiB2b2lkPigpO1xuICBwcml2YXRlIHJlYWRvbmx5IHRlcm1pbmFsU3Vic2NyaWJlcnMgPSBuZXcgU2V0PChkYXRhOiBzdHJpbmcpID0+IHZvaWQ+KCk7XG4gIHByaXZhdGUgcmVhZG9ubHkgcGVuZGluZ1JlcXVlc3RzID0gbmV3IE1hcDxzdHJpbmcsIFBlbmRpbmdScGNSZXF1ZXN0PigpO1xuICBwcml2YXRlIHJlYWRvbmx5IGNvbmZpZzogQnJpZGdlUnVudGltZUNvbmZpZztcbiAgcHJpdmF0ZSByZWFkb25seSBkZXBzOiBCcmlkZ2VTZXJ2aWNlRGVwcztcbiAgcHJpdmF0ZSBwcm9jZXNzOiBTcGF3bmVkUnBjQ2hpbGQgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBkZXRhY2hTdGRvdXRSZWFkZXI6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHN0YXJ0UHJvbWlzZTogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHJlZnJlc2hQcm9taXNlOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgYXV0aFJlZnJlc2hQcm9taXNlOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgcmVxdWVzdENvdW50ZXIgPSAwO1xuICBwcml2YXRlIHN0ZGVyckJ1ZmZlciA9IFwiXCI7XG4gIHByaXZhdGUgc25hcHNob3Q6IEJyaWRnZVJ1bnRpbWVTbmFwc2hvdDtcblxuICBjb25zdHJ1Y3Rvcihjb25maWc6IEJyaWRnZVJ1bnRpbWVDb25maWcsIGRlcHM6IEJyaWRnZVNlcnZpY2VEZXBzKSB7XG4gICAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gICAgdGhpcy5kZXBzID0gZGVwcztcbiAgICB0aGlzLnNuYXBzaG90ID0ge1xuICAgICAgcGhhc2U6IFwiaWRsZVwiLFxuICAgICAgcHJvamVjdEN3ZDogY29uZmlnLnByb2plY3RDd2QsXG4gICAgICBwcm9qZWN0U2Vzc2lvbnNEaXI6IGNvbmZpZy5wcm9qZWN0U2Vzc2lvbnNEaXIsXG4gICAgICBwYWNrYWdlUm9vdDogY29uZmlnLnBhY2thZ2VSb290LFxuICAgICAgc3RhcnRlZEF0OiBudWxsLFxuICAgICAgdXBkYXRlZEF0OiBub3dJc28oKSxcbiAgICAgIGNvbm5lY3Rpb25Db3VudDogMCxcbiAgICAgIGxhc3RDb21tYW5kVHlwZTogbnVsbCxcbiAgICAgIGFjdGl2ZVNlc3Npb25JZDogbnVsbCxcbiAgICAgIGFjdGl2ZVNlc3Npb25GaWxlOiBudWxsLFxuICAgICAgc2Vzc2lvblN0YXRlOiBudWxsLFxuICAgICAgbGFzdEVycm9yOiBudWxsLFxuICAgIH07XG4gIH1cblxuICBnZXRTbmFwc2hvdCgpOiBCcmlkZ2VSdW50aW1lU25hcHNob3Qge1xuICAgIHJldHVybiBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5zbmFwc2hvdCk7XG4gIH1cblxuICBwdWJsaXNoTGl2ZVN0YXRlSW52YWxpZGF0aW9uKFxuICAgIGRlc2NyaXB0b3I6IEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvbkRlc2NyaXB0b3IsXG4gICk6IEJyaWRnZUxpdmVTdGF0ZUludmFsaWRhdGlvbkV2ZW50IHtcbiAgICBjb25zdCBldmVudCA9IGJ1aWxkTGl2ZVN0YXRlSW52YWxpZGF0aW9uRXZlbnQoZGVzY3JpcHRvcik7XG4gICAgaWYgKGV2ZW50LndvcmtzcGFjZUluZGV4Q2FjaGVJbnZhbGlkYXRlZCkge1xuICAgICAgaW52YWxpZGF0ZVdvcmtzcGFjZUluZGV4Q2FjaGUodGhpcy5jb25maWcucHJvamVjdEN3ZCk7XG4gICAgfVxuICAgIHRoaXMuZW1pdChldmVudCk7XG4gICAgcmV0dXJuIGV2ZW50O1xuICB9XG5cbiAgYXN5bmMgZW5zdXJlU3RhcnRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5wcm9jZXNzICYmIHRoaXMuc25hcHNob3QucGhhc2UgPT09IFwicmVhZHlcIikgcmV0dXJuO1xuICAgIGlmICh0aGlzLnN0YXJ0UHJvbWlzZSkgcmV0dXJuIGF3YWl0IHRoaXMuc3RhcnRQcm9taXNlO1xuXG4gICAgdGhpcy5zdGFydFByb21pc2UgPSB0aGlzLnN0YXJ0SW50ZXJuYWwoKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgdGhpcy5zdGFydFByb21pc2U7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHRoaXMuc3RhcnRQcm9taXNlID0gbnVsbDtcbiAgICB9XG4gIH1cblxuICBhc3luYyBzZW5kSW5wdXQoaW5wdXQ6IEJyaWRnZUlucHV0KTogUHJvbWlzZTxScGNSZXNwb25zZSB8IG51bGw+IHtcbiAgICBhd2FpdCB0aGlzLmVuc3VyZVN0YXJ0ZWQoKTtcbiAgICBpZiAoIXRoaXMucHJvY2Vzcz8uc3RkaW4pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcih0aGlzLnNuYXBzaG90Lmxhc3RFcnJvcj8ubWVzc2FnZSB8fCBcIlJQQyBicmlkZ2UgaXMgbm90IGNvbm5lY3RlZFwiKTtcbiAgICB9XG5cbiAgICBpZiAoaXNScGNFeHRlbnNpb25VaVJlc3BvbnNlKGlucHV0KSkge1xuICAgICAgdGhpcy5wcm9jZXNzLnN0ZGluLndyaXRlKHNlcmlhbGl6ZUpzb25MaW5lKGlucHV0KSk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCByZXNwb25zZSA9IHNhbml0aXplUnBjUmVzcG9uc2UoYXdhaXQgdGhpcy5yZXF1ZXN0UmVzcG9uc2UoaW5wdXQpKTtcbiAgICB0aGlzLnNuYXBzaG90Lmxhc3RDb21tYW5kVHlwZSA9IGlucHV0LnR5cGU7XG4gICAgdGhpcy5zbmFwc2hvdC51cGRhdGVkQXQgPSBub3dJc28oKTtcblxuICAgIGlmICghcmVzcG9uc2Uuc3VjY2Vzcykge1xuICAgICAgdGhpcy5yZWNvcmRFcnJvcihyZXNwb25zZS5lcnJvciwgdGhpcy5zbmFwc2hvdC5waGFzZSwgeyBjb21tYW5kVHlwZTogaW5wdXQudHlwZSB9KTtcbiAgICAgIHRoaXMuYnJvYWRjYXN0U3RhdHVzKCk7XG4gICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgfVxuXG4gICAgaWYgKGlucHV0LnR5cGUgPT09IFwiZ2V0X3N0YXRlXCIgJiYgcmVzcG9uc2Uuc3VjY2VzcyAmJiByZXNwb25zZS5jb21tYW5kID09PSBcImdldF9zdGF0ZVwiKSB7XG4gICAgICB0aGlzLmFwcGx5U2Vzc2lvblN0YXRlKHJlc3BvbnNlLmRhdGEpO1xuICAgICAgdGhpcy5icm9hZGNhc3RTdGF0dXMoKTtcbiAgICAgIHJldHVybiByZXNwb25zZTtcbiAgICB9XG5cbiAgICBjb25zdCBsaXZlU3RhdGVJbnZhbGlkYXRpb24gPSBjcmVhdGVMaXZlU3RhdGVJbnZhbGlkYXRpb25Gcm9tQ29tbWFuZChpbnB1dCwgcmVzcG9uc2UpO1xuICAgIGlmIChsaXZlU3RhdGVJbnZhbGlkYXRpb24pIHtcbiAgICAgIHRoaXMucHVibGlzaExpdmVTdGF0ZUludmFsaWRhdGlvbihsaXZlU3RhdGVJbnZhbGlkYXRpb24pO1xuICAgIH1cblxuICAgIHZvaWQgdGhpcy5xdWV1ZVN0YXRlUmVmcmVzaCgpO1xuICAgIHRoaXMuYnJvYWRjYXN0U3RhdHVzKCk7XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9XG5cbiAgYXN5bmMgcmVmcmVzaEF1dGgoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMuYXV0aFJlZnJlc2hQcm9taXNlKSB7XG4gICAgICByZXR1cm4gYXdhaXQgdGhpcy5hdXRoUmVmcmVzaFByb21pc2U7XG4gICAgfVxuXG4gICAgdGhpcy5hdXRoUmVmcmVzaFByb21pc2UgPSB0aGlzLnJlZnJlc2hBdXRoSW50ZXJuYWwoKS5maW5hbGx5KCgpID0+IHtcbiAgICAgIHRoaXMuYXV0aFJlZnJlc2hQcm9taXNlID0gbnVsbDtcbiAgICB9KTtcblxuICAgIGF3YWl0IHRoaXMuYXV0aFJlZnJlc2hQcm9taXNlO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZWZyZXNoQXV0aEludGVybmFsKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLnN0YXJ0UHJvbWlzZSkge1xuICAgICAgYXdhaXQgdGhpcy5zdGFydFByb21pc2U7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMucHJvY2VzcyAmJiB0aGlzLnNuYXBzaG90LnBoYXNlID09PSBcInJlYWR5XCIpIHtcbiAgICAgIHRoaXMucmVzZXRQcm9jZXNzRm9yQXV0aFJlZnJlc2goKTtcbiAgICB9XG5cbiAgICBhd2FpdCB0aGlzLmVuc3VyZVN0YXJ0ZWQoKTtcbiAgfVxuXG4gIHByaXZhdGUgcmVzZXRQcm9jZXNzRm9yQXV0aFJlZnJlc2goKTogdm9pZCB7XG4gICAgY29uc3QgY2hpbGQgPSB0aGlzLnByb2Nlc3M7XG4gICAgdGhpcy5wcm9jZXNzID0gbnVsbDtcbiAgICB0aGlzLmRldGFjaFN0ZG91dFJlYWRlcj8uKCk7XG4gICAgdGhpcy5kZXRhY2hTdGRvdXRSZWFkZXIgPSBudWxsO1xuICAgIHRoaXMuc3RkZXJyQnVmZmVyID0gXCJcIjtcblxuICAgIGZvciAoY29uc3QgcGVuZGluZyBvZiB0aGlzLnBlbmRpbmdSZXF1ZXN0cy52YWx1ZXMoKSkge1xuICAgICAgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZW91dCk7XG4gICAgICBwZW5kaW5nLnJlamVjdChuZXcgRXJyb3IoXCJSUEMgYnJpZGdlIHJlc3RhcnRpbmcgdG8gcmVsb2FkIGF1dGhcIikpO1xuICAgIH1cbiAgICB0aGlzLnBlbmRpbmdSZXF1ZXN0cy5jbGVhcigpO1xuXG4gICAgaWYgKGNoaWxkKSB7XG4gICAgICBjaGlsZC5yZW1vdmVBbGxMaXN0ZW5lcnMoXCJleGl0XCIpO1xuICAgICAgY2hpbGQucmVtb3ZlQWxsTGlzdGVuZXJzKFwiZXJyb3JcIik7XG4gICAgICBjaGlsZC5raWxsKFwiU0lHVEVSTVwiKTtcbiAgICAgIGRlc3Ryb3lDaGlsZFN0cmVhbXMoY2hpbGQpO1xuICAgIH1cblxuICAgIHRoaXMuc25hcHNob3QucGhhc2UgPSBcImlkbGVcIjtcbiAgICB0aGlzLnNuYXBzaG90LnVwZGF0ZWRBdCA9IG5vd0lzbygpO1xuICAgIHRoaXMuc25hcHNob3QubGFzdEVycm9yID0gbnVsbDtcbiAgICB0aGlzLmJyb2FkY2FzdFN0YXR1cygpO1xuICB9XG5cbiAgc3Vic2NyaWJlKGxpc3RlbmVyOiAoZXZlbnQ6IEJyaWRnZUV2ZW50KSA9PiB2b2lkKTogKCkgPT4gdm9pZCB7XG4gICAgdGhpcy5zdWJzY3JpYmVycy5hZGQobGlzdGVuZXIpO1xuICAgIHRoaXMuc25hcHNob3QuY29ubmVjdGlvbkNvdW50ID0gdGhpcy5zdWJzY3JpYmVycy5zaXplO1xuICAgIHRoaXMuc25hcHNob3QudXBkYXRlZEF0ID0gbm93SXNvKCk7XG4gICAgdGhpcy5icm9hZGNhc3RTdGF0dXMoKTtcblxuICAgIHJldHVybiAoKSA9PiB7XG4gICAgICB0aGlzLnN1YnNjcmliZXJzLmRlbGV0ZShsaXN0ZW5lcik7XG4gICAgICB0aGlzLnNuYXBzaG90LmNvbm5lY3Rpb25Db3VudCA9IHRoaXMuc3Vic2NyaWJlcnMuc2l6ZTtcbiAgICAgIHRoaXMuc25hcHNob3QudXBkYXRlZEF0ID0gbm93SXNvKCk7XG4gICAgICBpZiAodGhpcy5zdWJzY3JpYmVycy5zaXplID4gMCkge1xuICAgICAgICB0aGlzLmJyb2FkY2FzdFN0YXR1cygpO1xuICAgICAgfVxuICAgIH07XG4gIH1cblxuICBzdWJzY3JpYmVUZXJtaW5hbChsaXN0ZW5lcjogKGRhdGE6IHN0cmluZykgPT4gdm9pZCk6ICgpID0+IHZvaWQge1xuICAgIHRoaXMudGVybWluYWxTdWJzY3JpYmVycy5hZGQobGlzdGVuZXIpO1xuICAgIHJldHVybiAoKSA9PiB7XG4gICAgICB0aGlzLnRlcm1pbmFsU3Vic2NyaWJlcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICB9O1xuICB9XG5cbiAgYXN5bmMgc2VuZFRlcm1pbmFsSW5wdXQoZGF0YTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5zZW5kVGVybWluYWxDb21tYW5kKHsgdHlwZTogXCJ0ZXJtaW5hbF9pbnB1dFwiLCBkYXRhIH0pO1xuICB9XG5cbiAgYXN5bmMgcmVzaXplVGVybWluYWwoY29sczogbnVtYmVyLCByb3dzOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLnNlbmRUZXJtaW5hbENvbW1hbmQoeyB0eXBlOiBcInRlcm1pbmFsX3Jlc2l6ZVwiLCBjb2xzLCByb3dzIH0pO1xuICB9XG5cbiAgYXN5bmMgcmVkcmF3VGVybWluYWwoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgYXdhaXQgdGhpcy5zZW5kVGVybWluYWxDb21tYW5kKHsgdHlwZTogXCJ0ZXJtaW5hbF9yZWRyYXdcIiB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc2VuZFRlcm1pbmFsQ29tbWFuZChjb21tYW5kOiBCcmlkZ2VUZXJtaW5hbENvbW1hbmQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBhd2FpdCB0aGlzLmVuc3VyZVN0YXJ0ZWQoKTtcbiAgICBjb25zdCByZXNwb25zZSA9IHNhbml0aXplUnBjUmVzcG9uc2UoYXdhaXQgdGhpcy5yZXF1ZXN0UmVzcG9uc2UoY29tbWFuZCkpO1xuICAgIGlmICghcmVzcG9uc2Uuc3VjY2Vzcykge1xuICAgICAgdGhpcy5yZWNvcmRFcnJvcihyZXNwb25zZS5lcnJvciwgdGhpcy5zbmFwc2hvdC5waGFzZSwgeyBjb21tYW5kVHlwZTogY29tbWFuZC50eXBlIH0pO1xuICAgICAgdGhpcy5icm9hZGNhc3RTdGF0dXMoKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihyZXNwb25zZS5lcnJvcik7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgZGlzcG9zZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0aGlzLmRldGFjaFN0ZG91dFJlYWRlcj8uKCk7XG4gICAgdGhpcy5kZXRhY2hTdGRvdXRSZWFkZXIgPSBudWxsO1xuICAgIHRoaXMudGVybWluYWxTdWJzY3JpYmVycy5jbGVhcigpO1xuICAgIGZvciAoY29uc3QgcGVuZGluZyBvZiB0aGlzLnBlbmRpbmdSZXF1ZXN0cy52YWx1ZXMoKSkge1xuICAgICAgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZW91dCk7XG4gICAgICBwZW5kaW5nLnJlamVjdChuZXcgRXJyb3IoXCJSUEMgYnJpZGdlIGRpc3Bvc2VkXCIpKTtcbiAgICB9XG4gICAgdGhpcy5wZW5kaW5nUmVxdWVzdHMuY2xlYXIoKTtcbiAgICBpZiAodGhpcy5wcm9jZXNzKSB7XG4gICAgICB0aGlzLnByb2Nlc3MucmVtb3ZlQWxsTGlzdGVuZXJzKCk7XG4gICAgICB0aGlzLnByb2Nlc3Mua2lsbChcIlNJR1RFUk1cIik7XG4gICAgICB0aGlzLnByb2Nlc3MgPSBudWxsO1xuICAgIH1cbiAgICB0aGlzLnNuYXBzaG90LnBoYXNlID0gXCJpZGxlXCI7XG4gICAgdGhpcy5zbmFwc2hvdC5jb25uZWN0aW9uQ291bnQgPSAwO1xuICAgIHRoaXMuc25hcHNob3QudXBkYXRlZEF0ID0gbm93SXNvKCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIHN0YXJ0SW50ZXJuYWwoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5zbmFwc2hvdC5waGFzZSA9IFwic3RhcnRpbmdcIjtcbiAgICB0aGlzLnNuYXBzaG90LnN0YXJ0ZWRBdCA9IG5vd0lzbygpO1xuICAgIHRoaXMuc25hcHNob3QudXBkYXRlZEF0ID0gdGhpcy5zbmFwc2hvdC5zdGFydGVkQXQ7XG4gICAgdGhpcy5zbmFwc2hvdC5sYXN0RXJyb3IgPSBudWxsO1xuICAgIHRoaXMuYnJvYWRjYXN0U3RhdHVzKCk7XG5cbiAgICBsZXQgY2xpRW50cnk6IEJyaWRnZUNsaUVudHJ5O1xuICAgIHRyeSB7XG4gICAgICBjbGlFbnRyeSA9IHJlc29sdmVCcmlkZ2VDbGlFbnRyeSh0aGlzLmNvbmZpZywgdGhpcy5kZXBzKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgdGhpcy5zbmFwc2hvdC5waGFzZSA9IFwiZmFpbGVkXCI7XG4gICAgICB0aGlzLnJlY29yZEVycm9yKGVycm9yLCBcInN0YXJ0aW5nXCIpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuXG4gICAgY29uc3Qgc3Bhd25DaGlsZCA9IHRoaXMuZGVwcy5zcGF3biA/PyAoKGNvbW1hbmQsIGFyZ3MsIG9wdGlvbnMpID0+IHNwYXduKGNvbW1hbmQsIGFyZ3MsIG9wdGlvbnMpKTtcbiAgICBjb25zdCBjaGlsZEVudiA9IHsgLi4uKHRoaXMuZGVwcy5lbnYgPz8gcHJvY2Vzcy5lbnYpIH07XG4gICAgZGVsZXRlIGNoaWxkRW52LkdTRF9DT0RJTkdfQUdFTlRfRElSO1xuICAgIGNoaWxkRW52LkdTRF9XRUJfQlJJREdFX1RVSSA9IFwiMVwiO1xuXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bkNoaWxkKGNsaUVudHJ5LmNvbW1hbmQsIGNsaUVudHJ5LmFyZ3MsIHtcbiAgICAgIGN3ZDogY2xpRW50cnkuY3dkLFxuICAgICAgZW52OiBjaGlsZEVudixcbiAgICAgIHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICB3aW5kb3dzSGlkZTogdHJ1ZSxcbiAgICB9KSBhcyBTcGF3bmVkUnBjQ2hpbGQ7XG5cbiAgICB0aGlzLnByb2Nlc3MgPSBjaGlsZDtcbiAgICB0aGlzLnN0ZGVyckJ1ZmZlciA9IFwiXCI7XG4gICAgY2hpbGQuc3RkZXJyLm9uKFwiZGF0YVwiLCAoY2h1bmspID0+IHtcbiAgICAgIHRoaXMuc3RkZXJyQnVmZmVyID0gY2FwdHVyZVN0ZGVycih0aGlzLnN0ZGVyckJ1ZmZlciwgY2h1bmsudG9TdHJpbmcoKSk7XG4gICAgfSk7XG4gICAgdGhpcy5kZXRhY2hTdGRvdXRSZWFkZXIgPSBhdHRhY2hKc29uTGluZVJlYWRlcihjaGlsZC5zdGRvdXQsIChsaW5lKSA9PiB0aGlzLmhhbmRsZVN0ZG91dExpbmUobGluZSkpO1xuICAgIGNoaWxkLm9uY2UoXCJleGl0XCIsIChjb2RlLCBzaWduYWwpID0+IHRoaXMuaGFuZGxlUHJvY2Vzc0V4aXQoY29kZSwgc2lnbmFsKSk7XG4gICAgY2hpbGQub25jZShcImVycm9yXCIsIChlcnJvcikgPT4gdGhpcy5oYW5kbGVQcm9jZXNzRXhpdChudWxsLCBudWxsLCBlcnJvcikpO1xuXG4gICAgbGV0IHN0YXJ0dXBUaW1lb3V0OiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCB0aW1lb3V0ID0gbmV3IFByb21pc2U8bmV2ZXI+KChfLCByZWplY3QpID0+IHtcbiAgICAgIHN0YXJ0dXBUaW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiByZWplY3QobmV3IEVycm9yKGBSUEMgYnJpZGdlIHN0YXJ0dXAgdGltZWQgb3V0IGFmdGVyICR7U1RBUlRfVElNRU9VVF9NU31tc2ApKSwgU1RBUlRfVElNRU9VVF9NUyk7XG4gICAgfSk7XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgUHJvbWlzZS5yYWNlKFt0aGlzLnJlZnJlc2hTdGF0ZSh0cnVlKSwgdGltZW91dF0pO1xuICAgICAgdGhpcy5zbmFwc2hvdC5waGFzZSA9IFwicmVhZHlcIjtcbiAgICAgIHRoaXMuc25hcHNob3QudXBkYXRlZEF0ID0gbm93SXNvKCk7XG4gICAgICB0aGlzLnNuYXBzaG90Lmxhc3RFcnJvciA9IG51bGw7XG4gICAgICB0aGlzLmJyb2FkY2FzdFN0YXR1cygpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICB0aGlzLnNuYXBzaG90LnBoYXNlID0gXCJmYWlsZWRcIjtcbiAgICAgIHRoaXMucmVjb3JkRXJyb3IoZXJyb3IsIFwic3RhcnRpbmdcIik7XG4gICAgICB0aGlzLmJyb2FkY2FzdFN0YXR1cygpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmIChzdGFydHVwVGltZW91dCkge1xuICAgICAgICBjbGVhclRpbWVvdXQoc3RhcnR1cFRpbWVvdXQpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcXVldWVTdGF0ZVJlZnJlc2goKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKHRoaXMucmVmcmVzaFByb21pc2UpIHJldHVybiBhd2FpdCB0aGlzLnJlZnJlc2hQcm9taXNlO1xuICAgIHRoaXMucmVmcmVzaFByb21pc2UgPSB0aGlzLnJlZnJlc2hTdGF0ZShmYWxzZSlcbiAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgdGhpcy5yZWNvcmRFcnJvcihlcnJvciwgdGhpcy5zbmFwc2hvdC5waGFzZSwgeyBjb21tYW5kVHlwZTogXCJnZXRfc3RhdGVcIiB9KTtcbiAgICAgIH0pXG4gICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIHRoaXMucmVmcmVzaFByb21pc2UgPSBudWxsO1xuICAgICAgfSk7XG4gICAgYXdhaXQgdGhpcy5yZWZyZXNoUHJvbWlzZTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgcmVmcmVzaFN0YXRlKHN0cmljdDogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIC8vIER1cmluZyBzdGFydHVwIChzdHJpY3Q9dHJ1ZSksIHRoZSBSUEMgY2hpbGQgbWF5IG5lZWQgc2lnbmlmaWNhbnQgdGltZSB0b1xuICAgIC8vIGluaXRpYWxpc2UgXHUyMDE0IGxvYWRpbmcgZXh0ZW5zaW9ucywgY3JlYXRpbmcgdGhlIGFnZW50IHNlc3Npb24sIGV0Yy4gIFVzZVxuICAgIC8vIHRoZSBvdmVyYWxsIFNUQVJUX1RJTUVPVVRfTVMgaW5zdGVhZCBvZiB0aGUgc2hvcnQgcGVyLXJlcXVlc3QgdGltZW91dCBzb1xuICAgIC8vIHRoZSBmaXJzdCBnZXRfc3RhdGUgZG9lc24ndCByYWNlIGFnYWluc3QgY29sZC1zdGFydCBpbml0aWFsaXNhdGlvbi5cbiAgICBjb25zdCB0aW1lb3V0ID0gc3RyaWN0ID8gU1RBUlRfVElNRU9VVF9NUyA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCByZXNwb25zZSA9IHNhbml0aXplUnBjUmVzcG9uc2UoYXdhaXQgdGhpcy5yZXF1ZXN0UmVzcG9uc2UoeyB0eXBlOiBcImdldF9zdGF0ZVwiIH0sIHRpbWVvdXQpKTtcbiAgICBpZiAoIXJlc3BvbnNlLnN1Y2Nlc3MpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihyZXNwb25zZS5lcnJvcik7XG4gICAgfVxuICAgIGlmIChyZXNwb25zZS5jb21tYW5kID09PSBcImdldF9zdGF0ZVwiKSB7XG4gICAgICB0aGlzLmFwcGx5U2Vzc2lvblN0YXRlKHJlc3BvbnNlLmRhdGEpO1xuICAgIH1cbiAgICB0aGlzLnNuYXBzaG90LnVwZGF0ZWRBdCA9IG5vd0lzbygpO1xuICAgIGlmICghc3RyaWN0KSB7XG4gICAgICB0aGlzLmJyb2FkY2FzdFN0YXR1cygpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYXBwbHlTZXNzaW9uU3RhdGUoc3RhdGU6IFJwY1Nlc3Npb25TdGF0ZSk6IHZvaWQge1xuICAgIHRoaXMuc25hcHNob3Quc2Vzc2lvblN0YXRlID0gc3RhdGU7XG4gICAgdGhpcy5zbmFwc2hvdC5hY3RpdmVTZXNzaW9uSWQgPSBzdGF0ZS5zZXNzaW9uSWQ7XG4gICAgdGhpcy5zbmFwc2hvdC5hY3RpdmVTZXNzaW9uRmlsZSA9IHN0YXRlLnNlc3Npb25GaWxlID8/IG51bGw7XG4gIH1cblxuICBwcml2YXRlIHJlcXVlc3RSZXNwb25zZShjb21tYW5kOiBScGNDb21tYW5kLCB0aW1lb3V0TXM/OiBudW1iZXIpOiBQcm9taXNlPFJwY1Jlc3BvbnNlPiB7XG4gICAgaWYgKCF0aGlzLnByb2Nlc3M/LnN0ZGluKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QobmV3IEVycm9yKFwiUlBDIGJyaWRnZSBpcyBub3QgY29ubmVjdGVkXCIpKTtcbiAgICB9XG5cbiAgICBjb25zdCBpZCA9IGNvbW1hbmQuaWQgPz8gYHdlYl8keysrdGhpcy5yZXF1ZXN0Q291bnRlcn1gO1xuICAgIGNvbnN0IHBheWxvYWQgPSB7IC4uLmNvbW1hbmQsIGlkIH0gc2F0aXNmaWVzIFJwY0NvbW1hbmQ7XG4gICAgY29uc3QgZWZmZWN0aXZlVGltZW91dCA9IHRpbWVvdXRNcyA/PyBSRVNQT05TRV9USU1FT1VUX01TO1xuXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPFJwY1Jlc3BvbnNlPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHRoaXMucGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShpZCk7XG4gICAgICAgIHJlamVjdChuZXcgRXJyb3IoYFRpbWVkIG91dCB3YWl0aW5nIGZvciBSUEMgcmVzcG9uc2UgdG8gJHtwYXlsb2FkLnR5cGV9YCkpO1xuICAgICAgfSwgZWZmZWN0aXZlVGltZW91dCk7XG5cbiAgICAgIHRoaXMucGVuZGluZ1JlcXVlc3RzLnNldChpZCwge1xuICAgICAgICByZXNvbHZlOiAocmVzcG9uc2UpID0+IHtcbiAgICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG4gICAgICAgICAgcmVzb2x2ZShyZXNwb25zZSk7XG4gICAgICAgIH0sXG4gICAgICAgIHJlamVjdDogKGVycm9yKSA9PiB7XG4gICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgICAgIHJlamVjdChlcnJvcik7XG4gICAgICAgIH0sXG4gICAgICAgIHRpbWVvdXQsXG4gICAgICB9KTtcblxuICAgICAgdGhpcy5wcm9jZXNzIS5zdGRpbi53cml0ZShzZXJpYWxpemVKc29uTGluZShwYXlsb2FkKSk7XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZVN0ZG91dExpbmUobGluZTogc3RyaW5nKTogdm9pZCB7XG4gICAgbGV0IHBhcnNlZDogdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoaXNCcmlkZ2VUZXJtaW5hbE91dHB1dEV2ZW50KHBhcnNlZCkpIHtcbiAgICAgIHRoaXMuZW1pdFRlcm1pbmFsKHBhcnNlZC5kYXRhKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoXG4gICAgICB0eXBlb2YgcGFyc2VkID09PSBcIm9iamVjdFwiICYmXG4gICAgICBwYXJzZWQgIT09IG51bGwgJiZcbiAgICAgIFwidHlwZVwiIGluIHBhcnNlZCAmJlxuICAgICAgKHBhcnNlZCBhcyB7IHR5cGU/OiBzdHJpbmcgfSkudHlwZSA9PT0gXCJyZXNwb25zZVwiXG4gICAgKSB7XG4gICAgICBjb25zdCByZXNwb25zZSA9IHNhbml0aXplUnBjUmVzcG9uc2UocGFyc2VkIGFzIFJwY1Jlc3BvbnNlKTtcbiAgICAgIGlmIChyZXNwb25zZS5pZCAmJiB0aGlzLnBlbmRpbmdSZXF1ZXN0cy5oYXMocmVzcG9uc2UuaWQpKSB7XG4gICAgICAgIGNvbnN0IHBlbmRpbmcgPSB0aGlzLnBlbmRpbmdSZXF1ZXN0cy5nZXQocmVzcG9uc2UuaWQpITtcbiAgICAgICAgdGhpcy5wZW5kaW5nUmVxdWVzdHMuZGVsZXRlKHJlc3BvbnNlLmlkKTtcbiAgICAgICAgcGVuZGluZy5yZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGV2ZW50ID0gc2FuaXRpemVFdmVudFBheWxvYWQocGFyc2VkKTtcbiAgICB0aGlzLmVtaXQoZXZlbnQpO1xuXG4gICAgaWYgKGlzQnJpZGdlU2Vzc2lvblN0YXRlQ2hhbmdlZEV2ZW50KGV2ZW50KSkge1xuICAgICAgY29uc3QgbGl2ZVN0YXRlSW52YWxpZGF0aW9uID0gY3JlYXRlTGl2ZVN0YXRlSW52YWxpZGF0aW9uRnJvbVNlc3Npb25TdGF0ZUNoYW5nZShldmVudC5yZWFzb24pO1xuICAgICAgaWYgKGxpdmVTdGF0ZUludmFsaWRhdGlvbikge1xuICAgICAgICB0aGlzLnB1Ymxpc2hMaXZlU3RhdGVJbnZhbGlkYXRpb24obGl2ZVN0YXRlSW52YWxpZGF0aW9uKTtcbiAgICAgIH1cbiAgICAgIHZvaWQgdGhpcy5xdWV1ZVN0YXRlUmVmcmVzaCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGxpdmVTdGF0ZUludmFsaWRhdGlvbiA9IGNyZWF0ZUxpdmVTdGF0ZUludmFsaWRhdGlvbkZyb21CcmlkZ2VFdmVudChldmVudCk7XG4gICAgaWYgKGxpdmVTdGF0ZUludmFsaWRhdGlvbikge1xuICAgICAgdGhpcy5wdWJsaXNoTGl2ZVN0YXRlSW52YWxpZGF0aW9uKGxpdmVTdGF0ZUludmFsaWRhdGlvbik7XG4gICAgfVxuXG4gICAgaWYgKFxuICAgICAgdHlwZW9mIGV2ZW50ID09PSBcIm9iamVjdFwiICYmXG4gICAgICBldmVudCAhPT0gbnVsbCAmJlxuICAgICAgXCJ0eXBlXCIgaW4gZXZlbnRcbiAgICApIHtcbiAgICAgIGNvbnN0IGV2ZW50VHlwZSA9IChldmVudCBhcyB7IHR5cGU/OiBzdHJpbmcgfSkudHlwZTtcbiAgICAgIGlmIChcbiAgICAgICAgZXZlbnRUeXBlID09PSBcImFnZW50X2VuZFwiIHx8XG4gICAgICAgIGV2ZW50VHlwZSA9PT0gXCJ0dXJuX2VuZFwiIHx8XG4gICAgICAgIGV2ZW50VHlwZSA9PT0gXCJhdXRvX3JldHJ5X3N0YXJ0XCIgfHxcbiAgICAgICAgZXZlbnRUeXBlID09PSBcImF1dG9fcmV0cnlfZW5kXCIgfHxcbiAgICAgICAgZXZlbnRUeXBlID09PSBcImF1dG9fY29tcGFjdGlvbl9zdGFydFwiIHx8XG4gICAgICAgIGV2ZW50VHlwZSA9PT0gXCJhdXRvX2NvbXBhY3Rpb25fZW5kXCJcbiAgICAgICkge1xuICAgICAgICB2b2lkIHRoaXMucXVldWVTdGF0ZVJlZnJlc2goKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGhhbmRsZVByb2Nlc3NFeGl0KGNvZGU6IG51bWJlciB8IG51bGwsIHNpZ25hbDogTm9kZUpTLlNpZ25hbHMgfCBudWxsLCBlcnJvcj86IHVua25vd24pOiB2b2lkIHtcbiAgICB0aGlzLmRldGFjaFN0ZG91dFJlYWRlcj8uKCk7XG4gICAgdGhpcy5kZXRhY2hTdGRvdXRSZWFkZXIgPSBudWxsO1xuICAgIHRoaXMucHJvY2VzcyA9IG51bGw7XG5cbiAgICBjb25zdCBleGl0RXJyb3IgPSBuZXcgRXJyb3IoYnVpbGRFeGl0TWVzc2FnZShjb2RlLCBzaWduYWwsIHRoaXMuc3RkZXJyQnVmZmVyKSk7XG4gICAgZm9yIChjb25zdCBwZW5kaW5nIG9mIHRoaXMucGVuZGluZ1JlcXVlc3RzLnZhbHVlcygpKSB7XG4gICAgICBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lb3V0KTtcbiAgICAgIHBlbmRpbmcucmVqZWN0KGV4aXRFcnJvcik7XG4gICAgfVxuICAgIHRoaXMucGVuZGluZ1JlcXVlc3RzLmNsZWFyKCk7XG5cbiAgICB0aGlzLnNuYXBzaG90LnBoYXNlID0gXCJmYWlsZWRcIjtcbiAgICB0aGlzLnNuYXBzaG90LnVwZGF0ZWRBdCA9IG5vd0lzbygpO1xuICAgIHRoaXMucmVjb3JkRXJyb3IoZXJyb3IgPz8gZXhpdEVycm9yLCB0aGlzLnNuYXBzaG90LmFjdGl2ZVNlc3Npb25JZCA/IFwicmVhZHlcIiA6IFwic3RhcnRpbmdcIik7XG4gICAgdGhpcy5icm9hZGNhc3RTdGF0dXMoKTtcbiAgfVxuXG4gIHByaXZhdGUgcmVjb3JkRXJyb3IoZXJyb3I6IHVua25vd24sIHBoYXNlOiBCcmlkZ2VMaWZlY3ljbGVQaGFzZSwgb3B0aW9uczogeyBjb21tYW5kVHlwZT86IHN0cmluZyB9ID0ge30pOiB2b2lkIHtcbiAgICB0aGlzLnNuYXBzaG90Lmxhc3RFcnJvciA9IHtcbiAgICAgIG1lc3NhZ2U6IHNhbml0aXplRXJyb3JNZXNzYWdlKGVycm9yKSxcbiAgICAgIGF0OiBub3dJc28oKSxcbiAgICAgIHBoYXNlLFxuICAgICAgYWZ0ZXJTZXNzaW9uQXR0YWNobWVudDogQm9vbGVhbih0aGlzLnNuYXBzaG90LmFjdGl2ZVNlc3Npb25JZCksXG4gICAgICBjb21tYW5kVHlwZTogb3B0aW9ucy5jb21tYW5kVHlwZSxcbiAgICB9O1xuICAgIHRoaXMuc25hcHNob3QudXBkYXRlZEF0ID0gdGhpcy5zbmFwc2hvdC5sYXN0RXJyb3IuYXQ7XG4gIH1cblxuICBwcml2YXRlIGVtaXQoZXZlbnQ6IEJyaWRnZUV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBzdWJzY3JpYmVyIG9mIHRoaXMuc3Vic2NyaWJlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN1YnNjcmliZXIoZXZlbnQpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFN1YnNjcmliZXIgZmFpbHVyZXMgc2hvdWxkIG5vdCBicmVhayBkZWxpdmVyeS5cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGVtaXRUZXJtaW5hbChkYXRhOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IHN1YnNjcmliZXIgb2YgdGhpcy50ZXJtaW5hbFN1YnNjcmliZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBzdWJzY3JpYmVyKGRhdGEpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFN1YnNjcmliZXIgZmFpbHVyZXMgc2hvdWxkIG5vdCBicmVhayBkZWxpdmVyeS5cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGJyb2FkY2FzdFN0YXR1cygpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zdWJzY3JpYmVycy5zaXplID09PSAwKSByZXR1cm47XG4gICAgdGhpcy5lbWl0KHsgdHlwZTogXCJicmlkZ2Vfc3RhdHVzXCIsIGJyaWRnZTogdGhpcy5nZXRTbmFwc2hvdCgpIH0pO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRQcm9qZWN0QnJpZGdlU2VydmljZUZvckN3ZChwcm9qZWN0Q3dkOiBzdHJpbmcpOiBCcmlkZ2VTZXJ2aWNlIHtcbiAgY29uc3QgcmVzb2x2ZWRQYXRoID0gcmVzb2x2ZShwcm9qZWN0Q3dkKTtcbiAgY29uc3QgZXhpc3RpbmcgPSBwcm9qZWN0QnJpZGdlUmVnaXN0cnkuZ2V0KHJlc29sdmVkUGF0aCk7XG4gIGlmIChleGlzdGluZykgcmV0dXJuIGV4aXN0aW5nO1xuXG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKHVuZGVmaW5lZCwgcmVzb2x2ZWRQYXRoKTtcbiAgY29uc3QgZGVwcyA9IGdldEJyaWRnZURlcHMoKTtcbiAgY29uc3Qgc2VydmljZSA9IG5ldyBCcmlkZ2VTZXJ2aWNlKGNvbmZpZywgZGVwcyk7XG4gIHByb2plY3RCcmlkZ2VSZWdpc3RyeS5zZXQocmVzb2x2ZWRQYXRoLCBzZXJ2aWNlKTtcbiAgcmV0dXJuIHNlcnZpY2U7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgcHJvamVjdCBDV0QgZnJvbSB0aGUgcmVxdWVzdCBxdWVyeSBwYXJhbSBvciBlbnYuXG4gKiBSZXR1cm5zIG51bGwgd2hlbiBubyBwcm9qZWN0IGlzIGNvbmZpZ3VyZWQgKHByZS1wcm9qZWN0LXNlbGVjdGlvbiBzdGF0ZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUHJvamVjdEN3ZChyZXF1ZXN0OiBSZXF1ZXN0KTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXF1ZXN0LnVybCk7XG4gICAgY29uc3QgcHJvamVjdFBhcmFtID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJwcm9qZWN0XCIpO1xuICAgIGlmIChwcm9qZWN0UGFyYW0pIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQocHJvamVjdFBhcmFtKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTWFsZm9ybWVkIFVSTCBcdTIwMTQgZmFsbCB0aHJvdWdoIHRvIGVudi1iYXNlZCBkZWZhdWx0LlxuICB9XG4gIHJldHVybiAoZ2V0QnJpZGdlRGVwcygpLmVudiA/PyBwcm9jZXNzLmVudikuR1NEX1dFQl9QUk9KRUNUX0NXRCB8fCBudWxsO1xufVxuXG4vKipcbiAqIExpa2UgcmVzb2x2ZVByb2plY3RDd2QgYnV0IHRocm93cyBhIDQwMC1zdHlsZSBlcnJvciB3aGVuIG5vIHByb2plY3QgaXMgc2V0LlxuICogVXNlIGluIEFQSSByb3V0ZXMgdGhhdCByZXF1aXJlIGEgcHJvamVjdCBjb250ZXh0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVxdWlyZVByb2plY3RDd2QocmVxdWVzdDogUmVxdWVzdCk6IHN0cmluZyB7XG4gIGNvbnN0IGN3ZCA9IHJlc29sdmVQcm9qZWN0Q3dkKHJlcXVlc3QpO1xuICBpZiAoIWN3ZCkge1xuICAgIHRocm93IG5ldyBOb1Byb2plY3RFcnJvcigpO1xuICB9XG4gIHJldHVybiBjd2Q7XG59XG5cbmV4cG9ydCBjbGFzcyBOb1Byb2plY3RFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoXCJObyBwcm9qZWN0IHNlbGVjdGVkXCIpO1xuICAgIHRoaXMubmFtZSA9IFwiTm9Qcm9qZWN0RXJyb3JcIjtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UHJvamVjdEJyaWRnZVNlcnZpY2UoKTogQnJpZGdlU2VydmljZSB7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKCk7XG4gIHJldHVybiBnZXRQcm9qZWN0QnJpZGdlU2VydmljZUZvckN3ZChjb25maWcucHJvamVjdEN3ZCk7XG59XG5cbmZ1bmN0aW9uIHRvQm9vdFJlc3VtYWJsZVNlc3Npb24oc2Vzc2lvbjogTG9jYWxTZXNzaW9uSW5mbywgYWN0aXZlU2Vzc2lvbkZpbGU6IHN0cmluZyB8IG51bGwpOiBCb290UmVzdW1hYmxlU2Vzc2lvbiB7XG4gIHJldHVybiB7XG4gICAgaWQ6IHNlc3Npb24uaWQsXG4gICAgcGF0aDogc2Vzc2lvbi5wYXRoLFxuICAgIGN3ZDogc2Vzc2lvbi5jd2QsXG4gICAgbmFtZTogc2Vzc2lvbi5uYW1lLFxuICAgIGNyZWF0ZWRBdDogc2Vzc2lvbi5jcmVhdGVkLnRvSVNPU3RyaW5nKCksXG4gICAgbW9kaWZpZWRBdDogc2Vzc2lvbi5tb2RpZmllZC50b0lTT1N0cmluZygpLFxuICAgIG1lc3NhZ2VDb3VudDogc2Vzc2lvbi5tZXNzYWdlQ291bnQsXG4gICAgaXNBY3RpdmU6IEJvb2xlYW4oYWN0aXZlU2Vzc2lvbkZpbGUgJiYgc2Vzc2lvbi5wYXRoID09PSBhY3RpdmVTZXNzaW9uRmlsZSksXG4gIH07XG59XG5cbmZ1bmN0aW9uIGJ1aWxkU2Vzc2lvbkJyb3dzZXJUcmVlKHNlc3Npb25zOiBTZXNzaW9uSW5mb1tdKTogU2Vzc2lvbkJyb3dzZXJUcmVlTm9kZVtdIHtcbiAgY29uc3QgYnlQYXRoID0gbmV3IE1hcDxzdHJpbmcsIFNlc3Npb25Ccm93c2VyVHJlZU5vZGU+KCk7XG5cbiAgZm9yIChjb25zdCBzZXNzaW9uIG9mIHNlc3Npb25zKSB7XG4gICAgYnlQYXRoLnNldChzZXNzaW9uLnBhdGgsIHsgc2Vzc2lvbiwgY2hpbGRyZW46IFtdIH0pO1xuICB9XG5cbiAgY29uc3Qgcm9vdHM6IFNlc3Npb25Ccm93c2VyVHJlZU5vZGVbXSA9IFtdO1xuXG4gIGZvciAoY29uc3Qgc2Vzc2lvbiBvZiBzZXNzaW9ucykge1xuICAgIGNvbnN0IG5vZGUgPSBieVBhdGguZ2V0KHNlc3Npb24ucGF0aCk7XG4gICAgaWYgKCFub2RlKSBjb250aW51ZTtcblxuICAgIGNvbnN0IHBhcmVudFBhdGggPSBzZXNzaW9uLnBhcmVudFNlc3Npb25QYXRoO1xuICAgIGlmIChwYXJlbnRQYXRoICYmIGJ5UGF0aC5oYXMocGFyZW50UGF0aCkpIHtcbiAgICAgIGJ5UGF0aC5nZXQocGFyZW50UGF0aCkhLmNoaWxkcmVuLnB1c2gobm9kZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICByb290cy5wdXNoKG5vZGUpO1xuICB9XG5cbiAgY29uc3Qgc29ydE5vZGVzID0gKG5vZGVzOiBTZXNzaW9uQnJvd3NlclRyZWVOb2RlW10pOiB2b2lkID0+IHtcbiAgICBub2Rlcy5zb3J0KChhLCBiKSA9PiBiLnNlc3Npb24ubW9kaWZpZWQuZ2V0VGltZSgpIC0gYS5zZXNzaW9uLm1vZGlmaWVkLmdldFRpbWUoKSk7XG4gICAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgICBzb3J0Tm9kZXMobm9kZS5jaGlsZHJlbik7XG4gICAgfVxuICB9O1xuXG4gIHNvcnROb2Rlcyhyb290cyk7XG4gIHJldHVybiByb290cztcbn1cblxuZnVuY3Rpb24gZmxhdHRlblNlc3Npb25Ccm93c2VyVHJlZShyb290czogU2Vzc2lvbkJyb3dzZXJUcmVlTm9kZVtdKTogRmxhdFNlc3Npb25Ccm93c2VyTm9kZVtdIHtcbiAgY29uc3QgcmVzdWx0OiBGbGF0U2Vzc2lvbkJyb3dzZXJOb2RlW10gPSBbXTtcblxuICBjb25zdCB3YWxrID0gKFxuICAgIG5vZGU6IFNlc3Npb25Ccm93c2VyVHJlZU5vZGUsXG4gICAgZGVwdGg6IG51bWJlcixcbiAgICBhbmNlc3Rvckhhc05leHRTaWJsaW5nOiBib29sZWFuW10sXG4gICAgaXNMYXN0SW5UaHJlYWQ6IGJvb2xlYW4sXG4gICk6IHZvaWQgPT4ge1xuICAgIHJlc3VsdC5wdXNoKHtcbiAgICAgIHNlc3Npb246IG5vZGUuc2Vzc2lvbixcbiAgICAgIGRlcHRoLFxuICAgICAgaXNMYXN0SW5UaHJlYWQsXG4gICAgICBhbmNlc3Rvckhhc05leHRTaWJsaW5nLFxuICAgIH0pO1xuXG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IG5vZGUuY2hpbGRyZW4ubGVuZ3RoOyBpbmRleCsrKSB7XG4gICAgICBjb25zdCBjaGlsZCA9IG5vZGUuY2hpbGRyZW5baW5kZXhdO1xuICAgICAgaWYgKCFjaGlsZCkgY29udGludWU7XG4gICAgICBjb25zdCBjaGlsZElzTGFzdCA9IGluZGV4ID09PSBub2RlLmNoaWxkcmVuLmxlbmd0aCAtIDE7XG4gICAgICBjb25zdCBjb250aW51ZXMgPSBkZXB0aCA+IDAgPyAhaXNMYXN0SW5UaHJlYWQgOiBmYWxzZTtcbiAgICAgIHdhbGsoY2hpbGQsIGRlcHRoICsgMSwgWy4uLmFuY2VzdG9ySGFzTmV4dFNpYmxpbmcsIGNvbnRpbnVlc10sIGNoaWxkSXNMYXN0KTtcbiAgICB9XG4gIH07XG5cbiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHJvb3RzLmxlbmd0aDsgaW5kZXgrKykge1xuICAgIGNvbnN0IHJvb3QgPSByb290c1tpbmRleF07XG4gICAgaWYgKCFyb290KSBjb250aW51ZTtcbiAgICB3YWxrKHJvb3QsIDAsIFtdLCBpbmRleCA9PT0gcm9vdHMubGVuZ3RoIC0gMSk7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiB0b1Nlc3Npb25Ccm93c2VyU2Vzc2lvbihcbiAgbm9kZTogRmxhdFNlc3Npb25Ccm93c2VyTm9kZSxcbiAgYWN0aXZlU2Vzc2lvbkZpbGU6IHN0cmluZyB8IG51bGwsXG4pOiBTZXNzaW9uQnJvd3NlclNlc3Npb24ge1xuICBjb25zdCB7IHNlc3Npb24gfSA9IG5vZGU7XG4gIGNvbnN0IGlzQWN0aXZlID0gQm9vbGVhbihhY3RpdmVTZXNzaW9uRmlsZSAmJiByZXNvbHZlKHNlc3Npb24ucGF0aCkgPT09IHJlc29sdmUoYWN0aXZlU2Vzc2lvbkZpbGUpKTtcbiAgcmV0dXJuIHtcbiAgICBpZDogc2Vzc2lvbi5pZCxcbiAgICBwYXRoOiBzZXNzaW9uLnBhdGgsXG4gICAgY3dkOiBzZXNzaW9uLmN3ZCxcbiAgICBuYW1lOiBzZXNzaW9uLm5hbWUsXG4gICAgY3JlYXRlZEF0OiBzZXNzaW9uLmNyZWF0ZWQudG9JU09TdHJpbmcoKSxcbiAgICBtb2RpZmllZEF0OiBzZXNzaW9uLm1vZGlmaWVkLnRvSVNPU3RyaW5nKCksXG4gICAgbWVzc2FnZUNvdW50OiBzZXNzaW9uLm1lc3NhZ2VDb3VudCxcbiAgICBwYXJlbnRTZXNzaW9uUGF0aDogc2Vzc2lvbi5wYXJlbnRTZXNzaW9uUGF0aCxcbiAgICBmaXJzdE1lc3NhZ2U6IHNlc3Npb24uZmlyc3RNZXNzYWdlLFxuICAgIGlzQWN0aXZlLFxuICAgIGRlcHRoOiBub2RlLmRlcHRoLFxuICAgIGlzTGFzdEluVGhyZWFkOiBub2RlLmlzTGFzdEluVGhyZWFkLFxuICAgIGFuY2VzdG9ySGFzTmV4dFNpYmxpbmc6IFsuLi5ub2RlLmFuY2VzdG9ySGFzTmV4dFNpYmxpbmddLFxuICB9O1xufVxuXG5mdW5jdGlvbiBidWlsZEZsYXRTZXNzaW9uQnJvd3Nlck5vZGVzKFxuICBzZXNzaW9uczogU2Vzc2lvbkluZm9bXSxcbiAgcXVlcnk6IFJldHVyblR5cGU8dHlwZW9mIG5vcm1hbGl6ZVNlc3Npb25Ccm93c2VyUXVlcnk+LFxuKTogRmxhdFNlc3Npb25Ccm93c2VyTm9kZVtdIHtcbiAgaWYgKHF1ZXJ5LnNvcnRNb2RlID09PSBcInRocmVhZGVkXCIgJiYgIXF1ZXJ5LnF1ZXJ5KSB7XG4gICAgY29uc3QgZmlsdGVyZWRTZXNzaW9ucyA9IHF1ZXJ5Lm5hbWVGaWx0ZXIgPT09IFwibmFtZWRcIiA/IHNlc3Npb25zLmZpbHRlcigoc2Vzc2lvbikgPT4gaGFzU2Vzc2lvbk5hbWUoc2Vzc2lvbikpIDogc2Vzc2lvbnM7XG4gICAgcmV0dXJuIGZsYXR0ZW5TZXNzaW9uQnJvd3NlclRyZWUoYnVpbGRTZXNzaW9uQnJvd3NlclRyZWUoZmlsdGVyZWRTZXNzaW9ucykpO1xuICB9XG5cbiAgcmV0dXJuIGZpbHRlckFuZFNvcnRTZXNzaW9ucyhzZXNzaW9ucywgcXVlcnkucXVlcnksIHF1ZXJ5LnNvcnRNb2RlLCBxdWVyeS5uYW1lRmlsdGVyKS5tYXAoKHNlc3Npb24pID0+ICh7XG4gICAgc2Vzc2lvbixcbiAgICBkZXB0aDogMCxcbiAgICBpc0xhc3RJblRocmVhZDogdHJ1ZSxcbiAgICBhbmNlc3Rvckhhc05leHRTaWJsaW5nOiBbXSxcbiAgfSkpO1xufVxuXG5mdW5jdGlvbiBmaW5kQ3VycmVudFByb2plY3RTZXNzaW9uKHNlc3Npb25zOiBTZXNzaW9uSW5mb1tdLCBzZXNzaW9uUGF0aDogc3RyaW5nKTogU2Vzc2lvbkluZm8gfCB1bmRlZmluZWQge1xuICBjb25zdCBub3JtYWxpemVkUGF0aCA9IHJlc29sdmUoc2Vzc2lvblBhdGgpO1xuICByZXR1cm4gc2Vzc2lvbnMuZmluZCgoc2Vzc2lvbikgPT4gcmVzb2x2ZShzZXNzaW9uLnBhdGgpID09PSBub3JtYWxpemVkUGF0aCk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkU2Vzc2lvbk1hbmFnZUVycm9yKFxuICBjb2RlOiBTZXNzaW9uTWFuYWdlRXJyb3JDb2RlLFxuICBlcnJvcjogc3RyaW5nLFxuICBkZXRhaWxzOiBPbWl0PFBhcnRpYWw8U2Vzc2lvbk1hbmFnZUVycm9yUmVzcG9uc2U+LCBcInN1Y2Nlc3NcIiB8IFwiY29kZVwiIHwgXCJlcnJvclwiIHwgXCJhY3Rpb25cIiB8IFwic2NvcGVcIj4gPSB7fSxcbik6IFNlc3Npb25NYW5hZ2VFcnJvclJlc3BvbnNlIHtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICBhY3Rpb246IFwicmVuYW1lXCIsXG4gICAgc2NvcGU6IFNFU1NJT05fQlJPV1NFUl9TQ09QRSxcbiAgICBjb2RlLFxuICAgIGVycm9yLFxuICAgIC4uLmRldGFpbHMsXG4gIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb2xsZWN0U2Vzc2lvbkJyb3dzZXJQYXlsb2FkKHF1ZXJ5OiBTZXNzaW9uQnJvd3NlclF1ZXJ5ID0ge30sIHByb2plY3RDd2Q/OiBzdHJpbmcpOiBQcm9taXNlPFNlc3Npb25Ccm93c2VyUmVzcG9uc2U+IHtcbiAgY29uc3QgZGVwcyA9IGdldEJyaWRnZURlcHMoKTtcbiAgY29uc3QgZW52ID0gZGVwcy5lbnYgPz8gcHJvY2Vzcy5lbnY7XG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVCcmlkZ2VSdW50aW1lQ29uZmlnKGVudiwgcHJvamVjdEN3ZCk7XG4gIGNvbnN0IGJyaWRnZSA9IHByb2plY3RDd2QgPyBnZXRQcm9qZWN0QnJpZGdlU2VydmljZUZvckN3ZChwcm9qZWN0Q3dkKSA6IGdldFByb2plY3RCcmlkZ2VTZXJ2aWNlKCk7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBicmlkZ2UuZW5zdXJlU3RhcnRlZCgpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBTZXNzaW9uIGJyb3dzaW5nIGNhbiBzdGlsbCBmYWxsIGJhY2sgdG8gdGhlIGN1cnJlbnQgcHJvamVjdCBzZXNzaW9uIGRpcmVjdG9yeS5cbiAgfVxuXG4gIGNvbnN0IGJyaWRnZVNuYXBzaG90ID0gYnJpZGdlLmdldFNuYXBzaG90KCk7XG4gIGNvbnN0IHNlc3Npb25zID0gYXdhaXQgbG9hZFNlc3Npb25Ccm93c2VyU2Vzc2lvbnNWaWFDaGlsZFByb2Nlc3MoY29uZmlnKTtcbiAgY29uc3Qgbm9ybWFsaXplZFF1ZXJ5ID0gbm9ybWFsaXplU2Vzc2lvbkJyb3dzZXJRdWVyeShxdWVyeSk7XG4gIGNvbnN0IGJyb3dzZXJTZXNzaW9ucyA9IGJ1aWxkRmxhdFNlc3Npb25Ccm93c2VyTm9kZXMoc2Vzc2lvbnMsIG5vcm1hbGl6ZWRRdWVyeSkubWFwKChub2RlKSA9PlxuICAgIHRvU2Vzc2lvbkJyb3dzZXJTZXNzaW9uKG5vZGUsIGJyaWRnZVNuYXBzaG90LmFjdGl2ZVNlc3Npb25GaWxlKSxcbiAgKTtcblxuICByZXR1cm4ge1xuICAgIHByb2plY3Q6IHtcbiAgICAgIHNjb3BlOiBTRVNTSU9OX0JST1dTRVJfU0NPUEUsXG4gICAgICBjd2Q6IGNvbmZpZy5wcm9qZWN0Q3dkLFxuICAgICAgc2Vzc2lvbnNEaXI6IGNvbmZpZy5wcm9qZWN0U2Vzc2lvbnNEaXIsXG4gICAgICBhY3RpdmVTZXNzaW9uUGF0aDogYnJpZGdlU25hcHNob3QuYWN0aXZlU2Vzc2lvbkZpbGUsXG4gICAgfSxcbiAgICBxdWVyeTogbm9ybWFsaXplZFF1ZXJ5LFxuICAgIHRvdGFsU2Vzc2lvbnM6IHNlc3Npb25zLmxlbmd0aCxcbiAgICByZXR1cm5lZFNlc3Npb25zOiBicm93c2VyU2Vzc2lvbnMubGVuZ3RoLFxuICAgIHNlc3Npb25zOiBicm93c2VyU2Vzc2lvbnMsXG4gIH07XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW5hbWVTZXNzaW9uSW5DdXJyZW50UHJvamVjdChyZXF1ZXN0OiBSZW5hbWVTZXNzaW9uUmVxdWVzdCwgcHJvamVjdEN3ZD86IHN0cmluZyk6IFByb21pc2U8U2Vzc2lvbk1hbmFnZVJlc3BvbnNlPiB7XG4gIGNvbnN0IGRlcHMgPSBnZXRCcmlkZ2VEZXBzKCk7XG4gIGNvbnN0IGVudiA9IGRlcHMuZW52ID8/IHByb2Nlc3MuZW52O1xuICBjb25zdCBjb25maWcgPSByZXNvbHZlQnJpZGdlUnVudGltZUNvbmZpZyhlbnYsIHByb2plY3RDd2QpO1xuICBjb25zdCBuZXh0TmFtZSA9IHJlcXVlc3QubmFtZS50cmltKCk7XG5cbiAgaWYgKCFuZXh0TmFtZSkge1xuICAgIHJldHVybiBidWlsZFNlc3Npb25NYW5hZ2VFcnJvcihcImludmFsaWRfcmVxdWVzdFwiLCBcIlNlc3Npb24gbmFtZSBjYW5ub3QgYmUgZW1wdHlcIiwge1xuICAgICAgc2Vzc2lvblBhdGg6IHJlcXVlc3Quc2Vzc2lvblBhdGgsXG4gICAgICBuYW1lOiByZXF1ZXN0Lm5hbWUsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBzZXNzaW9ucyA9IGF3YWl0IGxvYWRTZXNzaW9uQnJvd3NlclNlc3Npb25zVmlhQ2hpbGRQcm9jZXNzKGNvbmZpZyk7XG4gIGNvbnN0IHRhcmdldFNlc3Npb24gPSBmaW5kQ3VycmVudFByb2plY3RTZXNzaW9uKHNlc3Npb25zLCByZXF1ZXN0LnNlc3Npb25QYXRoKTtcbiAgaWYgKCF0YXJnZXRTZXNzaW9uKSB7XG4gICAgcmV0dXJuIGJ1aWxkU2Vzc2lvbk1hbmFnZUVycm9yKFwibm90X2ZvdW5kXCIsIFwiU2Vzc2lvbiBpcyBub3QgYXZhaWxhYmxlIGluIHRoZSBjdXJyZW50IHByb2plY3QgYnJvd3NlclwiLCB7XG4gICAgICBzZXNzaW9uUGF0aDogcmVxdWVzdC5zZXNzaW9uUGF0aCxcbiAgICAgIG5hbWU6IG5leHROYW1lLFxuICAgIH0pO1xuICB9XG5cbiAgY29uc3QgYnJpZGdlID0gcHJvamVjdEN3ZCA/IGdldFByb2plY3RCcmlkZ2VTZXJ2aWNlRm9yQ3dkKHByb2plY3RDd2QpIDogZ2V0UHJvamVjdEJyaWRnZVNlcnZpY2UoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBicmlkZ2UuZW5zdXJlU3RhcnRlZCgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBidWlsZFNlc3Npb25NYW5hZ2VFcnJvcihcInJlbmFtZV9mYWlsZWRcIiwgc2FuaXRpemVFcnJvck1lc3NhZ2UoZXJyb3IpLCB7XG4gICAgICBzZXNzaW9uUGF0aDogdGFyZ2V0U2Vzc2lvbi5wYXRoLFxuICAgICAgbmFtZTogbmV4dE5hbWUsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBhY3RpdmVTZXNzaW9uRmlsZSA9IGJyaWRnZS5nZXRTbmFwc2hvdCgpLmFjdGl2ZVNlc3Npb25GaWxlO1xuICBjb25zdCBpc0FjdGl2ZVNlc3Npb24gPSBCb29sZWFuKGFjdGl2ZVNlc3Npb25GaWxlICYmIHJlc29sdmUoYWN0aXZlU2Vzc2lvbkZpbGUpID09PSByZXNvbHZlKHRhcmdldFNlc3Npb24ucGF0aCkpO1xuXG4gIGlmIChpc0FjdGl2ZVNlc3Npb24pIHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHNlbmRCcmlkZ2VJbnB1dCh7IHR5cGU6IFwic2V0X3Nlc3Npb25fbmFtZVwiLCBuYW1lOiBuZXh0TmFtZSB9LCBwcm9qZWN0Q3dkKTtcbiAgICBpZiAocmVzcG9uc2UgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiBidWlsZFNlc3Npb25NYW5hZ2VFcnJvcihcInJlbmFtZV9mYWlsZWRcIiwgXCJBY3RpdmUgc2Vzc2lvbiByZW5hbWUgZGlkIG5vdCByZXR1cm4gYSByZXNwb25zZVwiLCB7XG4gICAgICAgIHNlc3Npb25QYXRoOiB0YXJnZXRTZXNzaW9uLnBhdGgsXG4gICAgICAgIG5hbWU6IG5leHROYW1lLFxuICAgICAgICBpc0FjdGl2ZVNlc3Npb246IHRydWUsXG4gICAgICAgIG11dGF0aW9uOiBcInJwY1wiLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKCFyZXNwb25zZS5zdWNjZXNzKSB7XG4gICAgICBjb25zdCBmYWlsdXJlQ29kZSA9IChyZXNwb25zZSBhcyB7IGNvZGU/OiBzdHJpbmcgfSkuY29kZVxuICAgICAgcmV0dXJuIGJ1aWxkU2Vzc2lvbk1hbmFnZUVycm9yKFxuICAgICAgICBmYWlsdXJlQ29kZSA9PT0gXCJvbmJvYXJkaW5nX2xvY2tlZFwiID8gXCJvbmJvYXJkaW5nX2xvY2tlZFwiIDogXCJyZW5hbWVfZmFpbGVkXCIsXG4gICAgICAgIHJlc3BvbnNlLmVycm9yLFxuICAgICAgICB7XG4gICAgICAgICAgc2Vzc2lvblBhdGg6IHRhcmdldFNlc3Npb24ucGF0aCxcbiAgICAgICAgICBuYW1lOiBuZXh0TmFtZSxcbiAgICAgICAgICBpc0FjdGl2ZVNlc3Npb246IHRydWUsXG4gICAgICAgICAgbXV0YXRpb246IFwicnBjXCIsXG4gICAgICAgIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgYWN0aW9uOiBcInJlbmFtZVwiLFxuICAgICAgc2NvcGU6IFNFU1NJT05fQlJPV1NFUl9TQ09QRSxcbiAgICAgIHNlc3Npb25QYXRoOiB0YXJnZXRTZXNzaW9uLnBhdGgsXG4gICAgICBuYW1lOiBuZXh0TmFtZSxcbiAgICAgIGlzQWN0aXZlU2Vzc2lvbjogdHJ1ZSxcbiAgICAgIG11dGF0aW9uOiBcInJwY1wiLFxuICAgIH07XG4gIH1cblxuICB0cnkge1xuICAgIGF3YWl0IGFwcGVuZFNlc3Npb25JbmZvVmlhQ2hpbGRQcm9jZXNzKGNvbmZpZywgdGFyZ2V0U2Vzc2lvbi5wYXRoLCBuZXh0TmFtZSk7XG4gICAgYnJpZGdlLnB1Ymxpc2hMaXZlU3RhdGVJbnZhbGlkYXRpb24oe1xuICAgICAgcmVhc29uOiBcInNldF9zZXNzaW9uX25hbWVcIixcbiAgICAgIHNvdXJjZTogXCJzZXNzaW9uX21hbmFnZVwiLFxuICAgICAgZG9tYWluczogW1wicmVzdW1hYmxlX3Nlc3Npb25zXCJdLFxuICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgYWN0aW9uOiBcInJlbmFtZVwiLFxuICAgICAgc2NvcGU6IFNFU1NJT05fQlJPV1NFUl9TQ09QRSxcbiAgICAgIHNlc3Npb25QYXRoOiB0YXJnZXRTZXNzaW9uLnBhdGgsXG4gICAgICBuYW1lOiBuZXh0TmFtZSxcbiAgICAgIGlzQWN0aXZlU2Vzc2lvbjogZmFsc2UsXG4gICAgICBtdXRhdGlvbjogXCJzZXNzaW9uX2ZpbGVcIixcbiAgICB9O1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBidWlsZFNlc3Npb25NYW5hZ2VFcnJvcihcInJlbmFtZV9mYWlsZWRcIiwgc2FuaXRpemVFcnJvck1lc3NhZ2UoZXJyb3IpLCB7XG4gICAgICBzZXNzaW9uUGF0aDogdGFyZ2V0U2Vzc2lvbi5wYXRoLFxuICAgICAgbmFtZTogbmV4dE5hbWUsXG4gICAgICBpc0FjdGl2ZVNlc3Npb246IGZhbHNlLFxuICAgICAgbXV0YXRpb246IFwic2Vzc2lvbl9maWxlXCIsXG4gICAgfSk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUJvb3RPbmJvYXJkaW5nU3RhdGUoZGVwczogQnJpZGdlU2VydmljZURlcHMsIGVudjogTm9kZUpTLlByb2Nlc3NFbnYpOiBQcm9taXNlPE9uYm9hcmRpbmdTdGF0ZT4ge1xuICBpZiAoZGVwcy5nZXRPbmJvYXJkaW5nU3RhdGUpIHtcbiAgICByZXR1cm4gYXdhaXQgZGVwcy5nZXRPbmJvYXJkaW5nU3RhdGUoKTtcbiAgfVxuICBpZiAoZGVwcy5nZXRPbmJvYXJkaW5nTmVlZGVkKSB7XG4gICAgcmV0dXJuIGxlZ2FjeU9uYm9hcmRpbmdTdGF0ZUZyb21OZWVkZWQoYXdhaXQgZGVwcy5nZXRPbmJvYXJkaW5nTmVlZGVkKGF1dGhGaWxlUGF0aCwgZW52KSk7XG4gIH1cbiAgcmV0dXJuIGF3YWl0IGNvbGxlY3RPbmJvYXJkaW5nU3RhdGUoKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbGxlY3RDdXJyZW50UHJvamVjdE9uYm9hcmRpbmdTdGF0ZShwcm9qZWN0Q3dkPzogc3RyaW5nKTogUHJvbWlzZTxPbmJvYXJkaW5nU3RhdGU+IHtcbiAgY29uc3QgZGVwcyA9IGdldEJyaWRnZURlcHMoKTtcbiAgY29uc3QgZW52ID0gZGVwcy5lbnYgPz8gcHJvY2Vzcy5lbnY7XG4gIHJldHVybiBhd2FpdCByZXNvbHZlQm9vdE9uYm9hcmRpbmdTdGF0ZShkZXBzLCBlbnYpO1xufVxuXG5leHBvcnQgdHlwZSBCcmlkZ2VTZWxlY3RpdmVMaXZlU3RhdGVEb21haW4gPSBcImF1dG9cIiB8IFwid29ya3NwYWNlXCIgfCBcInJlc3VtYWJsZV9zZXNzaW9uc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEJyaWRnZVNlbGVjdGl2ZUxpdmVTdGF0ZVBheWxvYWQge1xuICBhdXRvPzogQXV0b0Rhc2hib2FyZERhdGE7XG4gIHdvcmtzcGFjZT86IEdTRFdvcmtzcGFjZUluZGV4O1xuICByZXN1bWFibGVTZXNzaW9ucz86IEJvb3RSZXN1bWFibGVTZXNzaW9uW107XG4gIGJyaWRnZTogQnJpZGdlUnVudGltZVNuYXBzaG90O1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29sbGVjdFNlbGVjdGl2ZUxpdmVTdGF0ZVBheWxvYWQoXG4gIGRvbWFpbnM6IEJyaWRnZVNlbGVjdGl2ZUxpdmVTdGF0ZURvbWFpbltdID0gW1wiYXV0b1wiLCBcIndvcmtzcGFjZVwiLCBcInJlc3VtYWJsZV9zZXNzaW9uc1wiXSxcbiAgcHJvamVjdEN3ZD86IHN0cmluZyxcbik6IFByb21pc2U8QnJpZGdlU2VsZWN0aXZlTGl2ZVN0YXRlUGF5bG9hZD4ge1xuICBjb25zdCBkZXBzID0gZ2V0QnJpZGdlRGVwcygpO1xuICBjb25zdCBlbnYgPSBkZXBzLmVudiA/PyBwcm9jZXNzLmVudjtcbiAgY29uc3QgY29uZmlnID0gcmVzb2x2ZUJyaWRnZVJ1bnRpbWVDb25maWcoZW52LCBwcm9qZWN0Q3dkKTtcbiAgY29uc3QgYnJpZGdlID0gcHJvamVjdEN3ZCA/IGdldFByb2plY3RCcmlkZ2VTZXJ2aWNlRm9yQ3dkKHByb2plY3RDd2QpIDogZ2V0UHJvamVjdEJyaWRnZVNlcnZpY2UoKTtcblxuICB0cnkge1xuICAgIGF3YWl0IGJyaWRnZS5lbnN1cmVTdGFydGVkKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIFNlbGVjdGl2ZSBsaXZlIHN0YXRlIHN0aWxsIHJldHVybnMgdGhlIGxhdGVzdCBicmlkZ2UgZmFpbHVyZSBzbmFwc2hvdCBmb3IgaW5zcGVjdGlvbi5cbiAgfVxuXG4gIGNvbnN0IGJyaWRnZVNuYXBzaG90ID0gYnJpZGdlLmdldFNuYXBzaG90KCk7XG4gIGNvbnN0IHVuaXF1ZURvbWFpbnMgPSBbLi4ubmV3IFNldChkb21haW5zKV07XG4gIGNvbnN0IHBheWxvYWQ6IEJyaWRnZVNlbGVjdGl2ZUxpdmVTdGF0ZVBheWxvYWQgPSB7XG4gICAgYnJpZGdlOiBicmlkZ2VTbmFwc2hvdCxcbiAgfTtcblxuICBpZiAodW5pcXVlRG9tYWlucy5pbmNsdWRlcyhcIndvcmtzcGFjZVwiKSkge1xuICAgIHBheWxvYWQud29ya3NwYWNlID0gYXdhaXQgbG9hZENhY2hlZFdvcmtzcGFjZUluZGV4KFxuICAgICAgY29uZmlnLnByb2plY3RDd2QsXG4gICAgICBhc3luYyAoKSA9PiBhd2FpdCAoZGVwcy5pbmRleFdvcmtzcGFjZSA/PyBmYWxsYmFja1dvcmtzcGFjZUluZGV4KShjb25maWcucHJvamVjdEN3ZCksXG4gICAgKTtcbiAgfVxuXG4gIGlmICh1bmlxdWVEb21haW5zLmluY2x1ZGVzKFwiYXV0b1wiKSkge1xuICAgIGNvbnN0IGdldEF1dG9EYXNoYm9hcmREYXRhID0gZGVwcy5nZXRBdXRvRGFzaGJvYXJkRGF0YSA/PyAoKCkgPT4gY29sbGVjdFRlc3RPbmx5RmFsbGJhY2tBdXRvRGFzaGJvYXJkRGF0YSgpKTtcbiAgICBwYXlsb2FkLmF1dG8gPSBhd2FpdCBQcm9taXNlLnJlc29sdmUoZ2V0QXV0b0Rhc2hib2FyZERhdGEoKSk7XG4gIH1cblxuICBpZiAodW5pcXVlRG9tYWlucy5pbmNsdWRlcyhcInJlc3VtYWJsZV9zZXNzaW9uc1wiKSkge1xuICAgIGNvbnN0IHNlc3Npb25zID0gYXdhaXQgKGRlcHMubGlzdFNlc3Npb25zID8/IChhc3luYyAoZGlyOiBzdHJpbmcpID0+IGxpc3RQcm9qZWN0U2Vzc2lvbnMoZGlyKSkpKGNvbmZpZy5wcm9qZWN0U2Vzc2lvbnNEaXIpO1xuICAgIHBheWxvYWQucmVzdW1hYmxlU2Vzc2lvbnMgPSBzZXNzaW9ucy5tYXAoKHNlc3Npb24pID0+IHRvQm9vdFJlc3VtYWJsZVNlc3Npb24oc2Vzc2lvbiwgYnJpZGdlU25hcHNob3QuYWN0aXZlU2Vzc2lvbkZpbGUpKTtcbiAgfVxuXG4gIHJldHVybiBwYXlsb2FkO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29sbGVjdEJvb3RQYXlsb2FkKHByb2plY3RDd2Q/OiBzdHJpbmcpOiBQcm9taXNlPEJyaWRnZUJvb3RQYXlsb2FkPiB7XG4gIGNvbnN0IGRlcHMgPSBnZXRCcmlkZ2VEZXBzKCk7XG4gIGNvbnN0IGVudiA9IGRlcHMuZW52ID8/IHByb2Nlc3MuZW52O1xuICBjb25zdCBjb25maWcgPSByZXNvbHZlQnJpZGdlUnVudGltZUNvbmZpZyhlbnYsIHByb2plY3RDd2QpO1xuICBjb25zdCBnZXRBdXRvRGFzaGJvYXJkRGF0YSA9IGRlcHMuZ2V0QXV0b0Rhc2hib2FyZERhdGEgPz8gKCgpID0+IGNvbGxlY3RUZXN0T25seUZhbGxiYWNrQXV0b0Rhc2hib2FyZERhdGEoKSk7XG4gIGNvbnN0IGxpc3RTZXNzaW9ucyA9IGRlcHMubGlzdFNlc3Npb25zID8/IChhc3luYyAoZGlyOiBzdHJpbmcpID0+IGxpc3RQcm9qZWN0U2Vzc2lvbnMoZGlyKSk7XG4gIGNvbnN0IHByb2plY3REZXRlY3Rpb24gPSBkZXRlY3RQcm9qZWN0S2luZChjb25maWcucHJvamVjdEN3ZCk7XG5cbiAgY29uc3Qgb25ib2FyZGluZyA9IGF3YWl0IHJlc29sdmVCb290T25ib2FyZGluZ1N0YXRlKGRlcHMsIGVudik7XG5cbiAgaWYgKG9uYm9hcmRpbmcubG9ja2VkICYmIGVudi5HU0RfV0VCX0hPU1RfS0lORCA9PT0gXCJwYWNrYWdlZC1zdGFuZGFsb25lXCIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgcHJvamVjdDoge1xuICAgICAgICBjd2Q6IGNvbmZpZy5wcm9qZWN0Q3dkLFxuICAgICAgICBzZXNzaW9uc0RpcjogY29uZmlnLnByb2plY3RTZXNzaW9uc0RpcixcbiAgICAgICAgcGFja2FnZVJvb3Q6IGNvbmZpZy5wYWNrYWdlUm9vdCxcbiAgICAgIH0sXG4gICAgICB3b3Jrc3BhY2U6IHtcbiAgICAgICAgbWlsZXN0b25lczogW10sXG4gICAgICAgIGFjdGl2ZToge1xuICAgICAgICAgIHBoYXNlOiBcInByZS1wbGFubmluZ1wiLFxuICAgICAgICB9LFxuICAgICAgICBzY29wZXM6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICBsYWJlbDogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICBraW5kOiBcInByb2plY3RcIixcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgICB2YWxpZGF0aW9uSXNzdWVzOiBbXSxcbiAgICAgIH0sXG4gICAgICBhdXRvOiBjb2xsZWN0VGVzdE9ubHlGYWxsYmFja0F1dG9EYXNoYm9hcmREYXRhKCksXG4gICAgICBvbmJvYXJkaW5nLFxuICAgICAgb25ib2FyZGluZ05lZWRlZDogdHJ1ZSxcbiAgICAgIHJlc3VtYWJsZVNlc3Npb25zOiBbXSxcbiAgICAgIGJyaWRnZToge1xuICAgICAgICBwaGFzZTogXCJpZGxlXCIsXG4gICAgICAgIHByb2plY3RDd2Q6IGNvbmZpZy5wcm9qZWN0Q3dkLFxuICAgICAgICBwcm9qZWN0U2Vzc2lvbnNEaXI6IGNvbmZpZy5wcm9qZWN0U2Vzc2lvbnNEaXIsXG4gICAgICAgIHBhY2thZ2VSb290OiBjb25maWcucGFja2FnZVJvb3QsXG4gICAgICAgIHN0YXJ0ZWRBdDogbnVsbCxcbiAgICAgICAgdXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIGNvbm5lY3Rpb25Db3VudDogMCxcbiAgICAgICAgbGFzdENvbW1hbmRUeXBlOiBudWxsLFxuICAgICAgICBhY3RpdmVTZXNzaW9uSWQ6IG51bGwsXG4gICAgICAgIGFjdGl2ZVNlc3Npb25GaWxlOiBudWxsLFxuICAgICAgICBzZXNzaW9uU3RhdGU6IG51bGwsXG4gICAgICAgIGxhc3RFcnJvcjogbnVsbCxcbiAgICAgIH0sXG4gICAgICBwcm9qZWN0RGV0ZWN0aW9uLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBicmlkZ2UgPSBwcm9qZWN0Q3dkID8gZ2V0UHJvamVjdEJyaWRnZVNlcnZpY2VGb3JDd2QocHJvamVjdEN3ZCkgOiBnZXRQcm9qZWN0QnJpZGdlU2VydmljZSgpO1xuXG4gIGNvbnN0IHdvcmtzcGFjZVByb21pc2UgPSBsb2FkQ2FjaGVkV29ya3NwYWNlSW5kZXgoXG4gICAgY29uZmlnLnByb2plY3RDd2QsXG4gICAgYXN5bmMgKCkgPT4gYXdhaXQgKGRlcHMuaW5kZXhXb3Jrc3BhY2UgPz8gZmFsbGJhY2tXb3Jrc3BhY2VJbmRleCkoY29uZmlnLnByb2plY3RDd2QpLFxuICApO1xuICBjb25zdCBhdXRvUHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZShnZXRBdXRvRGFzaGJvYXJkRGF0YSgpKTtcbiAgY29uc3Qgc2Vzc2lvbnNQcm9taXNlID0gbGlzdFNlc3Npb25zKGNvbmZpZy5wcm9qZWN0U2Vzc2lvbnNEaXIpO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgYnJpZGdlLmVuc3VyZVN0YXJ0ZWQoKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gQm9vdCBzdGlsbCByZXR1cm5zIHRoZSBicmlkZ2UgZmFpbHVyZSBzbmFwc2hvdCBmb3IgaW5zcGVjdGlvbi5cbiAgfVxuXG4gIGNvbnN0IGJyaWRnZVNuYXBzaG90ID0gYnJpZGdlLmdldFNuYXBzaG90KCk7XG4gIGNvbnN0IFt3b3Jrc3BhY2UsIGF1dG8sIHNlc3Npb25zXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICB3b3Jrc3BhY2VQcm9taXNlLFxuICAgIGF1dG9Qcm9taXNlLFxuICAgIHNlc3Npb25zUHJvbWlzZSxcbiAgXSk7XG5cbiAgcmV0dXJuIHtcbiAgICBwcm9qZWN0OiB7XG4gICAgICBjd2Q6IGNvbmZpZy5wcm9qZWN0Q3dkLFxuICAgICAgc2Vzc2lvbnNEaXI6IGNvbmZpZy5wcm9qZWN0U2Vzc2lvbnNEaXIsXG4gICAgICBwYWNrYWdlUm9vdDogY29uZmlnLnBhY2thZ2VSb290LFxuICAgIH0sXG4gICAgd29ya3NwYWNlLFxuICAgIGF1dG8sXG4gICAgb25ib2FyZGluZyxcbiAgICBvbmJvYXJkaW5nTmVlZGVkOiBvbmJvYXJkaW5nLmxvY2tlZCxcbiAgICByZXN1bWFibGVTZXNzaW9uczogc2Vzc2lvbnMubWFwKChzZXNzaW9uKSA9PiB0b0Jvb3RSZXN1bWFibGVTZXNzaW9uKHNlc3Npb24sIGJyaWRnZVNuYXBzaG90LmFjdGl2ZVNlc3Npb25GaWxlKSksXG4gICAgYnJpZGdlOiBicmlkZ2VTbmFwc2hvdCxcbiAgICBwcm9qZWN0RGV0ZWN0aW9uLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRCcmlkZ2VGYWlsdXJlUmVzcG9uc2UoY29tbWFuZFR5cGU6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiBCcmlkZ2VDb21tYW5kRmFpbHVyZVJlc3BvbnNlIHtcbiAgcmV0dXJuIHtcbiAgICB0eXBlOiBcInJlc3BvbnNlXCIsXG4gICAgY29tbWFuZDogY29tbWFuZFR5cGUsXG4gICAgc3VjY2VzczogZmFsc2UsXG4gICAgZXJyb3I6IHNhbml0aXplRXJyb3JNZXNzYWdlKGVycm9yKSxcbiAgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hQcm9qZWN0QnJpZGdlQXV0aChwcm9qZWN0Q3dkPzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGJyaWRnZSA9IHByb2plY3RDd2QgPyBnZXRQcm9qZWN0QnJpZGdlU2VydmljZUZvckN3ZChwcm9qZWN0Q3dkKSA6IGdldFByb2plY3RCcmlkZ2VTZXJ2aWNlKCk7XG4gIGF3YWl0IGJyaWRnZS5yZWZyZXNoQXV0aCgpO1xufVxuXG5yZWdpc3Rlck9uYm9hcmRpbmdCcmlkZ2VBdXRoUmVmcmVzaGVyKGFzeW5jICgpID0+IHtcbiAgYXdhaXQgcmVmcmVzaFByb2plY3RCcmlkZ2VBdXRoKCk7XG59KTtcblxuZXhwb3J0IGZ1bmN0aW9uIGVtaXRQcm9qZWN0TGl2ZVN0YXRlSW52YWxpZGF0aW9uKFxuICBkZXNjcmlwdG9yOiBCcmlkZ2VMaXZlU3RhdGVJbnZhbGlkYXRpb25EZXNjcmlwdG9yLFxuICBwcm9qZWN0Q3dkPzogc3RyaW5nLFxuKTogQnJpZGdlTGl2ZVN0YXRlSW52YWxpZGF0aW9uRXZlbnQge1xuICBjb25zdCBicmlkZ2UgPSBwcm9qZWN0Q3dkID8gZ2V0UHJvamVjdEJyaWRnZVNlcnZpY2VGb3JDd2QocHJvamVjdEN3ZCkgOiBnZXRQcm9qZWN0QnJpZGdlU2VydmljZSgpO1xuICByZXR1cm4gYnJpZGdlLnB1Ymxpc2hMaXZlU3RhdGVJbnZhbGlkYXRpb24oZGVzY3JpcHRvcik7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZW5kQnJpZGdlSW5wdXQoaW5wdXQ6IEJyaWRnZUlucHV0LCBwcm9qZWN0Q3dkPzogc3RyaW5nKTogUHJvbWlzZTxScGNSZXNwb25zZSB8IG51bGw+IHtcbiAgaWYgKCFpc1JlYWRPbmx5QnJpZGdlSW5wdXQoaW5wdXQpKSB7XG4gICAgY29uc3Qgb25ib2FyZGluZyA9IGF3YWl0IGNvbGxlY3RPbmJvYXJkaW5nU3RhdGUoKTtcbiAgICBpZiAob25ib2FyZGluZy5sb2NrZWQpIHtcbiAgICAgIHJldHVybiBidWlsZEJyaWRnZUxvY2tlZFJlc3BvbnNlKGlucHV0LCBvbmJvYXJkaW5nKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBicmlkZ2UgPSBwcm9qZWN0Q3dkID8gZ2V0UHJvamVjdEJyaWRnZVNlcnZpY2VGb3JDd2QocHJvamVjdEN3ZCkgOiBnZXRQcm9qZWN0QnJpZGdlU2VydmljZSgpO1xuICByZXR1cm4gYXdhaXQgYnJpZGdlLnNlbmRJbnB1dChpbnB1dCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjb25maWd1cmVCcmlkZ2VTZXJ2aWNlRm9yVGVzdHMob3ZlcnJpZGVzOiBQYXJ0aWFsPEJyaWRnZVNlcnZpY2VEZXBzPiB8IG51bGwpOiB2b2lkIHtcbiAgYnJpZGdlU2VydmljZU92ZXJyaWRlcyA9IG92ZXJyaWRlcztcbiAgaW52YWxpZGF0ZVdvcmtzcGFjZUluZGV4Q2FjaGUoKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc2V0QnJpZGdlU2VydmljZUZvclRlc3RzKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBkaXNwb3NlUHJvbWlzZXM6IFByb21pc2U8dm9pZD5bXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNlcnZpY2Ugb2YgcHJvamVjdEJyaWRnZVJlZ2lzdHJ5LnZhbHVlcygpKSB7XG4gICAgZGlzcG9zZVByb21pc2VzLnB1c2goc2VydmljZS5kaXNwb3NlKCkpO1xuICB9XG4gIGF3YWl0IFByb21pc2UuYWxsKGRpc3Bvc2VQcm9taXNlcyk7XG4gIHByb2plY3RCcmlkZ2VSZWdpc3RyeS5jbGVhcigpO1xuICBicmlkZ2VTZXJ2aWNlT3ZlcnJpZGVzID0gbnVsbDtcbiAgaW52YWxpZGF0ZVdvcmtzcGFjZUluZGV4Q2FjaGUoKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUFBLFNBQVMsVUFBVSxhQUFtRDtBQUN0RSxTQUFTLFlBQVksYUFBYSxjQUFjLGdCQUFnQjtBQUNoRSxTQUFTLHFCQUFxQjtBQUU5QixTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLHFCQUFxQjtBQUM5QixTQUFtQyx5QkFBeUIsaUNBQWlDO0FBQzdGLFNBQVMs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QixnQkFBZ0IsT0FBb0IsWUFBa0Q7QUFDMUcsTUFBSSxDQUFDLHNCQUFzQixLQUFLLEdBQUc7QUFDakMsVUFBTSxhQUFhLE1BQU0sdUJBQXVCO0FBQ2hELFFBQUksV0FBVyxRQUFRO0FBQ3JCLGFBQU8sMEJBQTBCLE9BQU8sVUFBVTtBQUFBLElBQ3BEO0FBQUEsRUFDRjtBQUVBLFFBQU0sU0FBUyxhQUFhLDhCQUE4QixVQUFVLElBQUksd0JBQXdCO0FBQ2hHLFNBQU8sTUFBTSxPQUFPLFVBQVUsS0FBSztBQUNyQztBQUVPLFNBQVMsK0JBQStCLFdBQW9EO0FBQ2pHLDJCQUF5QjtBQUN6QixnQ0FBOEI7QUFDaEM7QUFFQSxlQUFzQiw2QkFBNEM7QUFDaEUsUUFBTSxrQkFBbUMsQ0FBQztBQUMxQyxhQUFXLFdBQVcsc0JBQXNCLE9BQU8sR0FBRztBQUNwRCxvQkFBZ0IsS0FBSyxRQUFRLFFBQVEsQ0FBQztBQUFBLEVBQ3hDO0FBQ0EsUUFBTSxRQUFRLElBQUksZUFBZTtBQUNqQyx3QkFBc0IsTUFBTTtBQUM1QiwyQkFBeUI7QUFDekIsZ0NBQThCO0FBQ2hDOyIsCiAgIm5hbWVzIjogWyJyZXNvbHZlIiwgImxpdmVTdGF0ZUludmFsaWRhdGlvbiJdCn0K
