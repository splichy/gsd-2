import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, sessionsDir, authFilePath } from "./app-paths.js";
import { initResources, buildResourceLoader, getNewerManagedResourceVersion } from "./resource-loader.js";
import { ensureManagedTools } from "./tool-bootstrap.js";
import { loadStoredEnvKeys } from "./wizard.js";
import { migratePiCredentials } from "./pi-migration.js";
import { shouldRunOnboarding, runOnboarding } from "./onboarding.js";
import chalk from "chalk";
import { checkForUpdates } from "./update-check.js";
import { shouldBypassManagedResourceMismatchGate } from "./cli-policy.js";
import { shouldRedirectAutoToHeadless } from "./cli-auto-routing.js";
import { printHelp, printSubcommandHelp } from "./help-text.js";
import { applySecurityOverrides } from "./security-overrides.js";
import { validateConfiguredModel } from "./startup-model-validation.js";
import { migrateAnthropicDefaultToClaudeCode } from "./provider-migrations.js";
import {
  buildHeadlessAutoArgs,
  parseCliArgs,
  runWebCliBranch,
  migrateLegacyFlatSessions
} from "./cli-web-branch.js";
import { stopWebMode } from "./web-mode.js";
import { getProjectSessionsDir } from "./project-sessions.js";
import { markStartup, printStartupTimings } from "./startup-timings.js";
import { applyRtkProcessEnv, GSD_RTK_DISABLED_ENV, isTruthy } from "./rtk-shared.js";
let piCodingAgentModulePromise;
function loadPiCodingAgentModule() {
  return piCodingAgentModulePromise ??= import("@gsd/pi-coding-agent");
}
if (parseInt(process.versions.node) >= 22) {
  process.env.NODE_COMPILE_CACHE ??= join(agentDir, ".compile-cache");
}
function exitIfManagedResourcesAreNewer(currentAgentDir) {
  const currentVersion = process.env.GSD_VERSION || "0.0.0";
  const managedVersion = getNewerManagedResourceVersion(currentAgentDir, currentVersion);
  if (!managedVersion) {
    return;
  }
  process.stderr.write(
    `[gsd] ${chalk.yellow("Version mismatch detected")}
[gsd] Synced resources are from ${chalk.bold(`v${managedVersion}`)}, but this \`gsd\` binary is ${chalk.dim(`v${currentVersion}`)}.
[gsd] Run ${chalk.bold("npm install -g gsd-pi@latest")} or ${chalk.bold("gsd update")}, then try again.
`
  );
  process.exit(1);
}
function printNonTtyErrorAndExit(missing, includeWebHint) {
  const suffix = missing ? ` but ${missing} not a TTY` : "";
  process.stderr.write(`[gsd] Error: Interactive mode requires a terminal (TTY)${suffix}.
`);
  process.stderr.write("[gsd] Non-interactive alternatives:\n");
  process.stderr.write("[gsd]   gsd auto                       Auto-mode (pipeable, no TUI)\n");
  process.stderr.write('[gsd]   gsd --print "your message"     Single-shot prompt\n');
  if (includeWebHint) {
    process.stderr.write("[gsd]   gsd --web [path]               Browser-only web mode\n");
  }
  process.stderr.write("[gsd]   gsd --mode rpc                 JSON-RPC over stdin/stdout\n");
  process.stderr.write("[gsd]   gsd --mode mcp                 MCP server over stdin/stdout\n");
  process.stderr.write('[gsd]   gsd --mode text "message"      Text output mode\n');
  if (includeWebHint) {
    process.stderr.write("[gsd]   gsd headless                   Auto-mode without TUI\n");
  }
  process.exit(1);
}
function printExtensionErrors(errors) {
  for (const err of errors) {
    const isConflict = err.error.includes("supersedes") || err.error.includes("conflicts with");
    const prefix = isConflict ? "Extension conflict" : "Extension load error";
    process.stderr.write(`[gsd] ${prefix}: ${err.error}
`);
  }
}
function printExtensionWarnings(warnings) {
  if (!warnings) return;
  for (const w of warnings) {
    process.stderr.write(`[gsd] Extension warning: ${w.message}
`);
  }
}
async function reapplyValidatedModelOnFallback(session2, modelRegistry2, settingsManager2, fallbackMessage) {
  if (!fallbackMessage) return;
  const validatedProvider = settingsManager2.getDefaultProvider();
  const validatedModelId = settingsManager2.getDefaultModel();
  if (!validatedProvider || !validatedModelId) return;
  const correctModel = modelRegistry2.getAvailable().find((m) => m.provider === validatedProvider && m.id === validatedModelId);
  if (!correctModel) return;
  try {
    await session2.setModel(correctModel);
  } catch {
  }
}
const cliFlags = parseCliArgs(process.argv);
const isPrintMode = cliFlags.print || cliFlags.mode !== void 0;
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  const helpSubcommand = cliFlags.messages[0];
  const version = process.env.GSD_VERSION || "0.0.0";
  if (!helpSubcommand || !printSubcommandHelp(helpSubcommand, version)) {
    printHelp(version);
  }
  process.exit(0);
}
let rtkBootstrapPromise;
async function doRtkBootstrap() {
  let rtkStatus;
  let rtkDisabled = isTruthy(process.env[GSD_RTK_DISABLED_ENV]);
  if (!rtkDisabled) {
    const { loadEffectiveGSDPreferences } = await import("./resources/extensions/gsd/preferences.js");
    const prefs = loadEffectiveGSDPreferences();
    const rtkEnabled = prefs?.preferences.experimental?.rtk === true;
    if (!rtkEnabled) {
      process.env[GSD_RTK_DISABLED_ENV] = "1";
      rtkDisabled = true;
    }
  }
  markStartup("rtkPreferenceCheck");
  if (rtkDisabled) {
    applyRtkProcessEnv(process.env);
    rtkStatus = {
      enabled: false,
      supported: true,
      available: false,
      source: "disabled",
      reason: `${GSD_RTK_DISABLED_ENV} is set`
    };
  } else {
    const { bootstrapRtk } = await import("./rtk.js");
    rtkStatus = await bootstrapRtk();
  }
  markStartup("bootstrapRtk");
  if (!rtkStatus.available && rtkStatus.supported && rtkStatus.enabled && rtkStatus.reason) {
    process.stderr.write(`[gsd] Warning: RTK unavailable \u2014 continuing without shell-command compression (${rtkStatus.reason}).
`);
  }
}
function ensureRtkBootstrap() {
  if (!rtkBootstrapPromise) {
    markStartup("preRtkBootstrap");
    rtkBootstrapPromise = doRtkBootstrap();
  }
  return rtkBootstrapPromise;
}
if (shouldBypassManagedResourceMismatchGate(cliFlags.messages[0])) {
  const { runUpdate } = await import("./update-cmd.js");
  await runUpdate();
  process.exit(0);
}
if (cliFlags.messages[0] === "graph") {
  const sub = cliFlags.messages[1];
  const { buildGraph, writeGraph, graphStatus, graphQuery, graphDiff, resolveGsdRoot } = await import("@gsd-build/mcp-server");
  const projectDir = process.cwd();
  const gsdRoot = resolveGsdRoot(projectDir);
  if (!sub || sub === "build") {
    try {
      const graph = await buildGraph(projectDir);
      await writeGraph(gsdRoot, graph);
      process.stdout.write(`Graph built: ${graph.nodes.length} nodes, ${graph.edges.length} edges
`);
    } catch (err) {
      process.stderr.write(`[gsd] graph build failed: ${err instanceof Error ? err.message : String(err)}
`);
      process.exit(1);
    }
  } else if (sub === "status") {
    try {
      const result = await graphStatus(projectDir);
      if (!result.exists) {
        process.stdout.write("Graph: not built yet. Run: gsd graph build\n");
      } else {
        process.stdout.write(`Graph status:
`);
        process.stdout.write(`  exists:    ${result.exists}
`);
        process.stdout.write(`  nodes:     ${result.nodeCount}
`);
        process.stdout.write(`  edges:     ${result.edgeCount}
`);
        process.stdout.write(`  stale:     ${result.stale}
`);
        process.stdout.write(`  ageHours:  ${result.ageHours !== void 0 ? result.ageHours.toFixed(2) : "n/a"}
`);
        process.stdout.write(`  lastBuild: ${result.lastBuild ?? "n/a"}
`);
      }
    } catch (err) {
      process.stderr.write(`[gsd] graph status failed: ${err instanceof Error ? err.message : String(err)}
`);
      process.exit(1);
    }
  } else if (sub === "query") {
    const term = cliFlags.messages[2];
    if (!term) {
      process.stderr.write("Usage: gsd graph query <term>\n");
      process.exit(1);
    }
    try {
      const result = await graphQuery(projectDir, term);
      if (result.nodes.length === 0) {
        process.stdout.write(`No nodes found for term: "${term}"
`);
      } else {
        process.stdout.write(`Query results for "${term}" (${result.nodes.length} nodes, ${result.edges.length} edges):
`);
        for (const node of result.nodes) {
          process.stdout.write(`  [${node.type}] ${node.label} (${node.confidence})
`);
        }
      }
    } catch (err) {
      process.stderr.write(`[gsd] graph query failed: ${err instanceof Error ? err.message : String(err)}
`);
      process.exit(1);
    }
  } else if (sub === "diff") {
    try {
      const result = await graphDiff(projectDir);
      process.stdout.write(`Graph diff:
`);
      process.stdout.write(`  nodes added:    ${result.nodes.added.length}
`);
      process.stdout.write(`  nodes removed:  ${result.nodes.removed.length}
`);
      process.stdout.write(`  nodes changed:  ${result.nodes.changed.length}
`);
      process.stdout.write(`  edges added:    ${result.edges.added.length}
`);
      process.stdout.write(`  edges removed:  ${result.edges.removed.length}
`);
    } catch (err) {
      process.stderr.write(`[gsd] graph diff failed: ${err instanceof Error ? err.message : String(err)}
`);
      process.exit(1);
    }
  } else {
    process.stderr.write(`Unknown graph command: ${sub}
`);
    process.stderr.write("Commands: build, status, query <term>, diff\n");
    process.exit(1);
  }
  process.exit(0);
}
exitIfManagedResourcesAreNewer(agentDir);
const hasSubcommand = cliFlags.messages.length > 0;
if (!process.stdin.isTTY && !isPrintMode && !hasSubcommand && !cliFlags.listModels && !cliFlags.web) {
  printNonTtyErrorAndExit(void 0, false);
}
const packageCommandNames = /* @__PURE__ */ new Set(["install", "remove", "list"]);
if (packageCommandNames.has(cliFlags.messages[0])) {
  const { runPackageCommand } = await loadPiCodingAgentModule();
  const packageCommand = await runPackageCommand({
    appName: "gsd",
    args: process.argv.slice(2),
    cwd: process.cwd(),
    agentDir,
    stdout: process.stdout,
    stderr: process.stderr,
    allowedCommands: packageCommandNames
  });
  if (packageCommand.handled) {
    process.exit(packageCommand.exitCode);
  }
}
if (cliFlags.messages[0] === "config") {
  const { AuthStorage: AuthStorage2 } = await loadPiCodingAgentModule();
  const authStorage2 = AuthStorage2.create(authFilePath);
  loadStoredEnvKeys(authStorage2);
  await runOnboarding(authStorage2);
  process.exit(0);
}
if (cliFlags.messages[0] === "web" && cliFlags.messages[1] === "stop") {
  const webBranch = await runWebCliBranch(cliFlags, {
    stopWebMode,
    stderr: process.stderr,
    baseSessionsDir: sessionsDir,
    agentDir
  });
  if (webBranch.handled) {
    process.exit(webBranch.exitCode);
  }
}
if (cliFlags.web || cliFlags.messages[0] === "web" && cliFlags.messages[1] !== "stop") {
  await ensureRtkBootstrap();
  const webBranch = await runWebCliBranch(cliFlags, {
    stderr: process.stderr,
    baseSessionsDir: sessionsDir,
    agentDir
  });
  if (webBranch.handled) {
    process.exit(webBranch.exitCode);
  }
}
if (cliFlags.messages[0] === "sessions") {
  const { SessionManager: SessionManager2 } = await loadPiCodingAgentModule();
  const cwd2 = process.cwd();
  const safePath = `--${cwd2.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const projectSessionsDir2 = join(sessionsDir, safePath);
  process.stderr.write(chalk.dim(`Loading sessions for ${cwd2}...
`));
  const sessions = await SessionManager2.list(cwd2, projectSessionsDir2);
  if (sessions.length === 0) {
    process.stderr.write(chalk.yellow("No sessions found for this directory.\n"));
    process.exit(0);
  }
  process.stderr.write(chalk.bold(`
  Sessions (${sessions.length}):

`));
  const maxShow = 20;
  const toShow = sessions.slice(0, maxShow);
  for (let i = 0; i < toShow.length; i++) {
    const s = toShow[i];
    const date = s.modified.toLocaleString();
    const msgs = s.messageCount;
    const name = s.name ? ` ${chalk.cyan(s.name)}` : "";
    const preview = s.firstMessage ? s.firstMessage.replace(/\n/g, " ").substring(0, 80) : chalk.dim("(empty)");
    const num = String(i + 1).padStart(3);
    process.stderr.write(`  ${chalk.bold(num)}. ${chalk.green(date)} ${chalk.dim(`(${msgs} msgs)`)}${name}
`);
    process.stderr.write(`       ${chalk.dim(preview)}

`);
  }
  if (sessions.length > maxShow) {
    process.stderr.write(chalk.dim(`  ... and ${sessions.length - maxShow} more

`));
  }
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => {
    rl.question(chalk.bold("  Enter session number to resume (or q to quit): "), resolve);
  });
  rl.close();
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("keypress");
  if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  process.stdin.pause();
  const choice = parseInt(answer, 10);
  if (isNaN(choice) || choice < 1 || choice > toShow.length) {
    process.stderr.write(chalk.dim("Cancelled.\n"));
    process.exit(0);
  }
  const selected = toShow[choice - 1];
  process.stderr.write(chalk.green(`
Resuming session from ${selected.modified.toLocaleString()}...

`));
  cliFlags.continue = true;
  cliFlags._selectedSessionPath = selected.path;
}
if (cliFlags.messages[0] === "headless") {
  await ensureRtkBootstrap();
  initResources(agentDir);
  const { runHeadless, parseHeadlessArgs } = await import("./headless.js");
  await runHeadless(parseHeadlessArgs(process.argv));
  process.exit(0);
}
async function runHeadlessFromAuto(headlessArgs) {
  await ensureRtkBootstrap();
  const { runHeadless, parseHeadlessArgs } = await import("./headless.js");
  const argv = [process.argv[0], process.argv[1], "headless", ...headlessArgs];
  await runHeadless(parseHeadlessArgs(argv));
  process.exit(0);
}
function flushPendingProviderRegistrations(resourceLoader2, modelRegistry2) {
  const { runtime } = resourceLoader2.getExtensions();
  for (const { name, config } of runtime.pendingProviderRegistrations) {
    modelRegistry2.registerProvider(name, config);
  }
  runtime.pendingProviderRegistrations = [];
}
if (shouldRedirectAutoToHeadless(cliFlags.messages[0], process.stdin.isTTY, process.stdout.isTTY)) {
  await runHeadlessFromAuto(buildHeadlessAutoArgs(cliFlags));
}
if (!isPrintMode && cliFlags.listModels === void 0 && (cliFlags.messages[0] === "worktree" || cliFlags.messages[0] === "wt")) {
  const { handleList, handleMerge, handleClean, handleRemove } = await import("./worktree-cli.js");
  const sub = cliFlags.messages[1];
  const subArgs = cliFlags.messages.slice(2);
  if (!sub || sub === "list") {
    await handleList(process.cwd());
  } else if (sub === "merge") {
    await handleMerge(process.cwd(), subArgs);
  } else if (sub === "clean") {
    await handleClean(process.cwd());
  } else if (sub === "remove" || sub === "rm") {
    await handleRemove(process.cwd(), subArgs);
  } else {
    process.stderr.write(`Unknown worktree command: ${sub}
`);
    process.stderr.write("Commands: list, merge [name], clean, remove <name>\n");
  }
  process.exit(0);
}
const {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  createAgentSession,
  InteractiveMode,
  runPrintMode,
  runRpcMode
} = await loadPiCodingAgentModule();
markStartup("loadPiCodingAgent");
ensureManagedTools(join(agentDir, "bin"));
markStartup("ensureManagedTools");
const authStorage = AuthStorage.create(authFilePath);
markStartup("AuthStorage.create");
loadStoredEnvKeys(authStorage);
migratePiCredentials(authStorage);
const { resolveModelsJsonPath } = await import("./models-resolver.js");
const modelsJsonPath = resolveModelsJsonPath();
const modelRegistry = new ModelRegistry(authStorage, modelsJsonPath);
markStartup("ModelRegistry");
const settingsManager = SettingsManager.create(process.cwd(), agentDir);
applySecurityOverrides(settingsManager);
markStartup("SettingsManager.create");
if (!isPrintMode && shouldRunOnboarding(authStorage, settingsManager.getDefaultProvider())) {
  await runOnboarding(authStorage);
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("keypress");
  if (process.stdin.setRawMode) process.stdin.setRawMode(false);
  process.stdin.pause();
}
if (!isPrintMode) {
  checkForUpdates().catch(() => {
  });
}
if (!isPrintMode && process.stdout.columns && process.stdout.columns < 40) {
  process.stderr.write(
    chalk.yellow(`[gsd] Terminal width is ${process.stdout.columns} columns (minimum recommended: 40). Output may be unreadable.
`)
  );
}
if (cliFlags.listModels !== void 0) {
  exitIfManagedResourcesAreNewer(agentDir);
  initResources(agentDir);
  const listModelsLoader = new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths: cliFlags.extensions.length > 0 ? cliFlags.extensions : void 0
  });
  await listModelsLoader.reload();
  flushPendingProviderRegistrations(listModelsLoader, modelRegistry);
  const models = modelRegistry.getAvailable();
  if (models.length === 0) {
    console.log("No models available. Set API keys in environment variables.");
    process.exit(0);
  }
  const searchPattern = typeof cliFlags.listModels === "string" ? cliFlags.listModels : void 0;
  let filtered = models;
  if (searchPattern) {
    const q = searchPattern.toLowerCase();
    filtered = models.filter((m) => `${m.provider} ${m.id} ${m.name}`.toLowerCase().includes(q));
  }
  filtered.sort((a, b) => {
    const nameCmp = b.name.localeCompare(a.name);
    if (nameCmp !== 0) return nameCmp;
    const provCmp = a.provider.localeCompare(b.provider);
    if (provCmp !== 0) return provCmp;
    return a.id.localeCompare(b.id);
  });
  const fmt = (n) => n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}K` : `${n}`;
  const rows = filtered.map((m) => [
    m.provider,
    m.id,
    m.name,
    fmt(m.contextWindow),
    fmt(m.maxTokens),
    m.reasoning ? "yes" : "no"
  ]);
  const hdrs = ["provider", "model", "name", "context", "max-out", "thinking"];
  const widths = hdrs.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const pad = (s, w) => s.padEnd(w);
  console.log(hdrs.map((h, i) => pad(h, widths[i])).join("  "));
  for (const row of rows) {
    console.log(row.map((c, i) => pad(c, widths[i])).join("  "));
  }
  process.exit(0);
}
if (!settingsManager.getQuietStartup()) {
  settingsManager.setQuietStartup(true);
}
if (!settingsManager.getCollapseChangelog()) {
  settingsManager.setCollapseChangelog(true);
}
markStartup("startupSettings");
if (isPrintMode) {
  await ensureRtkBootstrap();
  const sessionManager2 = cliFlags.noSession ? SessionManager.inMemory() : SessionManager.create(process.cwd());
  let appendSystemPrompt;
  if (cliFlags.appendSystemPrompt) {
    try {
      appendSystemPrompt = readFileSync(cliFlags.appendSystemPrompt, "utf-8");
    } catch {
      appendSystemPrompt = cliFlags.appendSystemPrompt;
    }
  }
  exitIfManagedResourcesAreNewer(agentDir);
  initResources(agentDir);
  markStartup("initResources");
  const resourceLoader2 = new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths: cliFlags.extensions.length > 0 ? cliFlags.extensions : void 0,
    appendSystemPrompt
  });
  await resourceLoader2.reload();
  markStartup("resourceLoader.reload");
  flushPendingProviderRegistrations(resourceLoader2, modelRegistry);
  migrateAnthropicDefaultToClaudeCode({
    authStorage,
    isClaudeCodeReady: () => modelRegistry.isProviderRequestReady("claude-code"),
    settingsManager,
    modelRegistry
  });
  const { session: session2, extensionsResult: extensionsResult2, modelFallbackMessage } = await createAgentSession({
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager: sessionManager2,
    resourceLoader: resourceLoader2,
    isClaudeCodeReady: () => modelRegistry.isProviderRequestReady("claude-code")
  });
  markStartup("createAgentSession");
  validateConfiguredModel(modelRegistry, settingsManager);
  await reapplyValidatedModelOnFallback(session2, modelRegistry, settingsManager, modelFallbackMessage);
  printExtensionErrors(extensionsResult2.errors);
  printExtensionWarnings(extensionsResult2.warnings);
  if (cliFlags.model) {
    const available = modelRegistry.getAvailable();
    const match = available.find((m) => m.id === cliFlags.model) || available.find((m) => `${m.provider}/${m.id}` === cliFlags.model);
    if (match) {
      session2.setModel(match);
    }
  }
  const mode = cliFlags.mode || "text";
  if (mode === "rpc") {
    printStartupTimings();
    await runRpcMode(session2);
    process.exit(0);
  }
  if (mode === "mcp") {
    printStartupTimings();
    const { startMcpServer } = await import("./mcp-server.js");
    const allToolNames = session2.getAllTools().map((t) => t.name);
    session2.setActiveToolsByName(allToolNames);
    await startMcpServer({
      tools: session2.agent.state.tools ?? [],
      version: process.env.GSD_VERSION || "0.0.0"
    });
    await new Promise(() => {
    });
  }
  printStartupTimings();
  await runPrintMode(session2, {
    mode,
    messages: cliFlags.messages
  });
  process.exit(0);
}
if (cliFlags.worktree) {
  const { handleWorktreeFlag } = await import("./worktree-cli.js");
  await handleWorktreeFlag(cliFlags.worktree);
}
if (!cliFlags.worktree && !isPrintMode) {
  try {
    const { showWorktreeStatusBanner } = await import("./worktree-status-banner.js");
    showWorktreeStatusBanner(process.cwd());
  } catch {
  }
}
markStartup("worktreeStatusBanner");
await ensureRtkBootstrap();
const cwd = process.cwd();
const projectSessionsDir = getProjectSessionsDir(cwd);
migrateLegacyFlatSessions(sessionsDir, projectSessionsDir);
const sessionManager = cliFlags._selectedSessionPath ? SessionManager.open(cliFlags._selectedSessionPath, projectSessionsDir) : cliFlags.continue ? SessionManager.continueRecent(cwd, projectSessionsDir) : SessionManager.create(cwd, projectSessionsDir);
exitIfManagedResourcesAreNewer(agentDir);
initResources(agentDir);
markStartup("initResources");
const resourceLoader = await buildResourceLoader(agentDir, {
  additionalExtensionPaths: cliFlags.extensions.length > 0 ? cliFlags.extensions : void 0
});
const resourceLoadPromise = resourceLoader.reload();
await resourceLoadPromise;
markStartup("resourceLoader.reload");
flushPendingProviderRegistrations(resourceLoader, modelRegistry);
migrateAnthropicDefaultToClaudeCode({
  authStorage,
  isClaudeCodeReady: () => modelRegistry.isProviderRequestReady("claude-code"),
  settingsManager,
  modelRegistry
});
markStartup("providerMigrations");
const { session, extensionsResult, modelFallbackMessage: interactiveFallbackMsg } = await createAgentSession({
  authStorage,
  modelRegistry,
  settingsManager,
  sessionManager,
  resourceLoader,
  isClaudeCodeReady: () => modelRegistry.isProviderRequestReady("claude-code")
});
markStartup("createAgentSession");
validateConfiguredModel(modelRegistry, settingsManager);
await reapplyValidatedModelOnFallback(session, modelRegistry, settingsManager, interactiveFallbackMsg);
printExtensionErrors(extensionsResult.errors);
printExtensionWarnings(extensionsResult.warnings);
const enabledModelPatterns = settingsManager.getEnabledModels();
if (enabledModelPatterns && enabledModelPatterns.length > 0) {
  const availableModels = modelRegistry.getAvailable();
  const scopedModels = [];
  const seen = /* @__PURE__ */ new Set();
  for (const pattern of enabledModelPatterns) {
    const slashIdx = pattern.indexOf("/");
    if (slashIdx !== -1) {
      const provider = pattern.substring(0, slashIdx);
      const modelId = pattern.substring(slashIdx + 1);
      const model = availableModels.find((m) => m.provider === provider && m.id === modelId);
      if (model) {
        const key = `${model.provider}/${model.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          scopedModels.push({ model });
        }
      }
    } else {
      const model = availableModels.find((m) => m.id === pattern);
      if (model) {
        const key = `${model.provider}/${model.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          scopedModels.push({ model });
        }
      }
    }
  }
  if (scopedModels.length > 0 && scopedModels.length < availableModels.length) {
    session.setScopedModels(scopedModels);
  }
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  const missing = !process.stdin.isTTY && !process.stdout.isTTY ? "stdin and stdout are" : !process.stdin.isTTY ? "stdin is" : "stdout is";
  printNonTtyErrorAndExit(missing, true);
}
const interactiveMode = new InteractiveMode(session);
markStartup("InteractiveMode");
printStartupTimings();
await interactiveMode.run();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NsaS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHR5cGUge1xuICBEZWZhdWx0UmVzb3VyY2VMb2FkZXIgYXMgRGVmYXVsdFJlc291cmNlTG9hZGVySW5zdGFuY2UsXG4gIE1vZGVsUmVnaXN0cnkgYXMgTW9kZWxSZWdpc3RyeUluc3RhbmNlLFxuICBQYWNrYWdlQ29tbWFuZCxcbiAgU2V0dGluZ3NNYW5hZ2VyIGFzIFNldHRpbmdzTWFuYWdlckluc3RhbmNlLFxufSBmcm9tICdAZ3NkL3BpLWNvZGluZy1hZ2VudCdcbmltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gJ25vZGU6ZnMnXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJ1xuaW1wb3J0IHsgYWdlbnREaXIsIHNlc3Npb25zRGlyLCBhdXRoRmlsZVBhdGggfSBmcm9tICcuL2FwcC1wYXRocy5qcydcbmltcG9ydCB7IGluaXRSZXNvdXJjZXMsIGJ1aWxkUmVzb3VyY2VMb2FkZXIsIGdldE5ld2VyTWFuYWdlZFJlc291cmNlVmVyc2lvbiB9IGZyb20gJy4vcmVzb3VyY2UtbG9hZGVyLmpzJ1xuaW1wb3J0IHsgZW5zdXJlTWFuYWdlZFRvb2xzIH0gZnJvbSAnLi90b29sLWJvb3RzdHJhcC5qcydcbmltcG9ydCB7IGxvYWRTdG9yZWRFbnZLZXlzIH0gZnJvbSAnLi93aXphcmQuanMnXG5pbXBvcnQgeyBtaWdyYXRlUGlDcmVkZW50aWFscyB9IGZyb20gJy4vcGktbWlncmF0aW9uLmpzJ1xuaW1wb3J0IHsgc2hvdWxkUnVuT25ib2FyZGluZywgcnVuT25ib2FyZGluZyB9IGZyb20gJy4vb25ib2FyZGluZy5qcydcbmltcG9ydCBjaGFsayBmcm9tICdjaGFsaydcbmltcG9ydCB7IGNoZWNrRm9yVXBkYXRlcyB9IGZyb20gJy4vdXBkYXRlLWNoZWNrLmpzJ1xuaW1wb3J0IHsgc2hvdWxkQnlwYXNzTWFuYWdlZFJlc291cmNlTWlzbWF0Y2hHYXRlIH0gZnJvbSAnLi9jbGktcG9saWN5LmpzJ1xuaW1wb3J0IHsgc2hvdWxkUmVkaXJlY3RBdXRvVG9IZWFkbGVzcyB9IGZyb20gJy4vY2xpLWF1dG8tcm91dGluZy5qcydcbmltcG9ydCB7IHByaW50SGVscCwgcHJpbnRTdWJjb21tYW5kSGVscCB9IGZyb20gJy4vaGVscC10ZXh0LmpzJ1xuaW1wb3J0IHsgYXBwbHlTZWN1cml0eU92ZXJyaWRlcyB9IGZyb20gJy4vc2VjdXJpdHktb3ZlcnJpZGVzLmpzJ1xuaW1wb3J0IHsgdmFsaWRhdGVDb25maWd1cmVkTW9kZWwgfSBmcm9tICcuL3N0YXJ0dXAtbW9kZWwtdmFsaWRhdGlvbi5qcydcbmltcG9ydCB7IG1pZ3JhdGVBbnRocm9waWNEZWZhdWx0VG9DbGF1ZGVDb2RlIH0gZnJvbSAnLi9wcm92aWRlci1taWdyYXRpb25zLmpzJ1xuaW1wb3J0IHtcbiAgYnVpbGRIZWFkbGVzc0F1dG9BcmdzLFxuICBwYXJzZUNsaUFyZ3MsXG4gIHJ1bldlYkNsaUJyYW5jaCxcbiAgbWlncmF0ZUxlZ2FjeUZsYXRTZXNzaW9ucyxcbn0gZnJvbSAnLi9jbGktd2ViLWJyYW5jaC5qcydcbmltcG9ydCB7IHN0b3BXZWJNb2RlIH0gZnJvbSAnLi93ZWItbW9kZS5qcydcbmltcG9ydCB7IGdldFByb2plY3RTZXNzaW9uc0RpciB9IGZyb20gJy4vcHJvamVjdC1zZXNzaW9ucy5qcydcbmltcG9ydCB7IG1hcmtTdGFydHVwLCBwcmludFN0YXJ0dXBUaW1pbmdzIH0gZnJvbSAnLi9zdGFydHVwLXRpbWluZ3MuanMnXG5pbXBvcnQgeyBhcHBseVJ0a1Byb2Nlc3NFbnYsIEdTRF9SVEtfRElTQUJMRURfRU5WLCBpc1RydXRoeSB9IGZyb20gJy4vcnRrLXNoYXJlZC5qcydcbmltcG9ydCB0eXBlIHsgRW5zdXJlUnRrUmVzdWx0IH0gZnJvbSAnLi9ydGsuanMnXG5cbnR5cGUgUGlDb2RpbmdBZ2VudE1vZHVsZSA9IHR5cGVvZiBpbXBvcnQoJ0Bnc2QvcGktY29kaW5nLWFnZW50JylcblxubGV0IHBpQ29kaW5nQWdlbnRNb2R1bGVQcm9taXNlOiBQcm9taXNlPFBpQ29kaW5nQWdlbnRNb2R1bGU+IHwgdW5kZWZpbmVkXG5cbmZ1bmN0aW9uIGxvYWRQaUNvZGluZ0FnZW50TW9kdWxlKCk6IFByb21pc2U8UGlDb2RpbmdBZ2VudE1vZHVsZT4ge1xuICByZXR1cm4gKHBpQ29kaW5nQWdlbnRNb2R1bGVQcm9taXNlID8/PSBpbXBvcnQoJ0Bnc2QvcGktY29kaW5nLWFnZW50JykpXG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVjggY29tcGlsZSBjYWNoZSBcdTIwMTQgTm9kZSAyMisgY2FuIGNhY2hlIGNvbXBpbGVkIGJ5dGVjb2RlIGFjcm9zcyBydW5zLFxuLy8gZWxpbWluYXRpbmcgcmVwZWF0ZWQgcGFyc2UvY29tcGlsZSBvdmVyaGVhZCBmb3IgdW5jaGFuZ2VkIG1vZHVsZXMuXG4vLyBNdXN0IGJlIHNldCBlYXJseSBzbyBkeW5hbWljIGltcG9ydHMgKGV4dGVuc2lvbnMsIGxhenkgc3ViY29tbWFuZHMpIGJlbmVmaXQuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmlmIChwYXJzZUludChwcm9jZXNzLnZlcnNpb25zLm5vZGUpID49IDIyKSB7XG4gIHByb2Nlc3MuZW52Lk5PREVfQ09NUElMRV9DQUNIRSA/Pz0gam9pbihhZ2VudERpciwgJy5jb21waWxlLWNhY2hlJylcbn1cblxuZnVuY3Rpb24gZXhpdElmTWFuYWdlZFJlc291cmNlc0FyZU5ld2VyKGN1cnJlbnRBZ2VudERpcjogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGN1cnJlbnRWZXJzaW9uID0gcHJvY2Vzcy5lbnYuR1NEX1ZFUlNJT04gfHwgJzAuMC4wJ1xuICBjb25zdCBtYW5hZ2VkVmVyc2lvbiA9IGdldE5ld2VyTWFuYWdlZFJlc291cmNlVmVyc2lvbihjdXJyZW50QWdlbnREaXIsIGN1cnJlbnRWZXJzaW9uKVxuICBpZiAoIW1hbmFnZWRWZXJzaW9uKSB7XG4gICAgcmV0dXJuXG4gIH1cblxuICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICBgW2dzZF0gJHtjaGFsay55ZWxsb3coJ1ZlcnNpb24gbWlzbWF0Y2ggZGV0ZWN0ZWQnKX1cXG5gICtcbiAgICBgW2dzZF0gU3luY2VkIHJlc291cmNlcyBhcmUgZnJvbSAke2NoYWxrLmJvbGQoYHYke21hbmFnZWRWZXJzaW9ufWApfSwgYnV0IHRoaXMgXFxgZ3NkXFxgIGJpbmFyeSBpcyAke2NoYWxrLmRpbShgdiR7Y3VycmVudFZlcnNpb259YCl9LlxcbmAgK1xuICAgIGBbZ3NkXSBSdW4gJHtjaGFsay5ib2xkKCducG0gaW5zdGFsbCAtZyBnc2QtcGlAbGF0ZXN0Jyl9IG9yICR7Y2hhbGsuYm9sZCgnZ3NkIHVwZGF0ZScpfSwgdGhlbiB0cnkgYWdhaW4uXFxuYCxcbiAgKVxuICBwcm9jZXNzLmV4aXQoMSlcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTaGFyZWQgaGVscGVycyB1c2VkIGJ5IGJvdGggdGhlIHByaW50IGFuZCBpbnRlcmFjdGl2ZSBjb2RlIHBhdGhzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBQcmludCB0aGUgbm9uLWludGVyYWN0aXZlLW1vZGUgZXJyb3IgYW5kIGV4aXQuIENhbGxlZCBib3RoIGZyb20gdGhlIGVhcmx5XG4gKiBUVFkgZ2F0ZSAoYmVmb3JlIGhlYXZ5IGluaXQpIGFuZCBmcm9tIHRoZSBpbnRlcmFjdGl2ZS1tb2RlIFRUWSBnYXRlIHJpZ2h0XG4gKiBiZWZvcmUgYEludGVyYWN0aXZlTW9kZS5ydW4oKWAuIFRoZSBgaW5jbHVkZVdlYkhpbnRgIHZhcmlhbnQgYWxzbyBsaXN0c1xuICogYC0td2ViYCBhbmQgYGhlYWRsZXNzYCBhcyBhbHRlcm5hdGl2ZXMuXG4gKi9cbmZ1bmN0aW9uIHByaW50Tm9uVHR5RXJyb3JBbmRFeGl0KG1pc3Npbmc6IHN0cmluZyB8IHVuZGVmaW5lZCwgaW5jbHVkZVdlYkhpbnQ6IGJvb2xlYW4pOiBuZXZlciB7XG4gIGNvbnN0IHN1ZmZpeCA9IG1pc3NpbmcgPyBgIGJ1dCAke21pc3Npbmd9IG5vdCBhIFRUWWAgOiAnJ1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2dzZF0gRXJyb3I6IEludGVyYWN0aXZlIG1vZGUgcmVxdWlyZXMgYSB0ZXJtaW5hbCAoVFRZKSR7c3VmZml4fS5cXG5gKVxuICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnW2dzZF0gTm9uLWludGVyYWN0aXZlIGFsdGVybmF0aXZlczpcXG4nKVxuICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnW2dzZF0gICBnc2QgYXV0byAgICAgICAgICAgICAgICAgICAgICAgQXV0by1tb2RlIChwaXBlYWJsZSwgbm8gVFVJKVxcbicpXG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbZ3NkXSAgIGdzZCAtLXByaW50IFwieW91ciBtZXNzYWdlXCIgICAgIFNpbmdsZS1zaG90IHByb21wdFxcbicpXG4gIGlmIChpbmNsdWRlV2ViSGludCkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbZ3NkXSAgIGdzZCAtLXdlYiBbcGF0aF0gICAgICAgICAgICAgICBCcm93c2VyLW9ubHkgd2ViIG1vZGVcXG4nKVxuICB9XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbZ3NkXSAgIGdzZCAtLW1vZGUgcnBjICAgICAgICAgICAgICAgICBKU09OLVJQQyBvdmVyIHN0ZGluL3N0ZG91dFxcbicpXG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbZ3NkXSAgIGdzZCAtLW1vZGUgbWNwICAgICAgICAgICAgICAgICBNQ1Agc2VydmVyIG92ZXIgc3RkaW4vc3Rkb3V0XFxuJylcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoJ1tnc2RdICAgZ3NkIC0tbW9kZSB0ZXh0IFwibWVzc2FnZVwiICAgICAgVGV4dCBvdXRwdXQgbW9kZVxcbicpXG4gIGlmIChpbmNsdWRlV2ViSGludCkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbZ3NkXSAgIGdzZCBoZWFkbGVzcyAgICAgICAgICAgICAgICAgICBBdXRvLW1vZGUgd2l0aG91dCBUVUlcXG4nKVxuICB9XG4gIHByb2Nlc3MuZXhpdCgxKVxufVxuXG4vKipcbiAqIFByaW50IGV4dGVuc2lvbiBsb2FkL2NvbmZsaWN0IGVycm9ycyBmcm9tIGFuIGV4dGVuc2lvbnMgcmVzdWx0LiBEb3duZ3JhZGVzXG4gKiBjb25mbGljdHMgd2l0aCBidWlsdC1pbiB0b29scyB0byB3YXJuaW5ncyAoIzEzNDcpLlxuICovXG5mdW5jdGlvbiBwcmludEV4dGVuc2lvbkVycm9ycyhlcnJvcnM6IFJlYWRvbmx5QXJyYXk8eyBlcnJvcjogc3RyaW5nIH0+KTogdm9pZCB7XG4gIGZvciAoY29uc3QgZXJyIG9mIGVycm9ycykge1xuICAgIGNvbnN0IGlzQ29uZmxpY3QgPSBlcnIuZXJyb3IuaW5jbHVkZXMoJ3N1cGVyc2VkZXMnKSB8fCBlcnIuZXJyb3IuaW5jbHVkZXMoJ2NvbmZsaWN0cyB3aXRoJylcbiAgICBjb25zdCBwcmVmaXggPSBpc0NvbmZsaWN0ID8gJ0V4dGVuc2lvbiBjb25mbGljdCcgOiAnRXh0ZW5zaW9uIGxvYWQgZXJyb3InXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtnc2RdICR7cHJlZml4fTogJHtlcnIuZXJyb3J9XFxuYClcbiAgfVxufVxuXG4vKipcbiAqIFByaW50IGV4dGVuc2lvbiBsb2FkIHdhcm5pbmdzIChub24tZmF0YWwsIGUuZy4gbWlzc2luZyBkZWNsYXJlZCBkZXBzIGZyb21cbiAqIHRoZSB0b3BvbG9naWNhbCBzb3J0KS4gQ29tcGxlbWVudHMgcHJpbnRFeHRlbnNpb25FcnJvcnMgXHUyMDE0IGZhdGFsIGVycm9ycyBnb1xuICogdGhlcmUsIGFkdmlzb3J5IHdhcm5pbmdzIGdvIGhlcmUuXG4gKi9cbmZ1bmN0aW9uIHByaW50RXh0ZW5zaW9uV2FybmluZ3Mod2FybmluZ3M6IFJlYWRvbmx5QXJyYXk8eyBtZXNzYWdlOiBzdHJpbmcgfT4gfCB1bmRlZmluZWQpOiB2b2lkIHtcbiAgaWYgKCF3YXJuaW5ncykgcmV0dXJuXG4gIGZvciAoY29uc3QgdyBvZiB3YXJuaW5ncykge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBbZ3NkXSBFeHRlbnNpb24gd2FybmluZzogJHt3Lm1lc3NhZ2V9XFxuYClcbiAgfVxufVxuXG4vKipcbiAqIFJlLWFwcGx5IHRoZSB2YWxpZGF0ZWQgbW9kZWwgdG8gdGhlIHNlc3Npb24gd2hlbiBgY3JlYXRlQWdlbnRTZXNzaW9uKClgXG4gKiByZXBvcnRzIHRoYXQgaXQgaGFkIHRvIHVzZSBhIGZhbGxiYWNrLiBQcmV2ZW50cyBzaWxlbnRseSBvdmVycmlkaW5nIHRoZVxuICogcGVyc2lzdGVkIG1vZGVsIG9mIHJlc3VtZWQgY29udmVyc2F0aW9ucyAoIzM1MzQpLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWFwcGx5VmFsaWRhdGVkTW9kZWxPbkZhbGxiYWNrKFxuICBzZXNzaW9uOiB7IHNldE1vZGVsKG1vZGVsOiB7IHByb3ZpZGVyOiBzdHJpbmc7IGlkOiBzdHJpbmcgfSk6IHVua25vd24gfCBQcm9taXNlPHVua25vd24+IH0sXG4gIG1vZGVsUmVnaXN0cnk6IE1vZGVsUmVnaXN0cnlJbnN0YW5jZSxcbiAgc2V0dGluZ3NNYW5hZ2VyOiBTZXR0aW5nc01hbmFnZXJJbnN0YW5jZSxcbiAgZmFsbGJhY2tNZXNzYWdlOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFmYWxsYmFja01lc3NhZ2UpIHJldHVyblxuICBjb25zdCB2YWxpZGF0ZWRQcm92aWRlciA9IHNldHRpbmdzTWFuYWdlci5nZXREZWZhdWx0UHJvdmlkZXIoKVxuICBjb25zdCB2YWxpZGF0ZWRNb2RlbElkID0gc2V0dGluZ3NNYW5hZ2VyLmdldERlZmF1bHRNb2RlbCgpXG4gIGlmICghdmFsaWRhdGVkUHJvdmlkZXIgfHwgIXZhbGlkYXRlZE1vZGVsSWQpIHJldHVyblxuICBjb25zdCBjb3JyZWN0TW9kZWwgPSBtb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpXG4gICAgLmZpbmQoKG0pID0+IG0ucHJvdmlkZXIgPT09IHZhbGlkYXRlZFByb3ZpZGVyICYmIG0uaWQgPT09IHZhbGlkYXRlZE1vZGVsSWQpXG4gIGlmICghY29ycmVjdE1vZGVsKSByZXR1cm5cbiAgdHJ5IHtcbiAgICBhd2FpdCBzZXNzaW9uLnNldE1vZGVsKGNvcnJlY3RNb2RlbClcbiAgfSBjYXRjaCB7XG4gICAgLy8gUHJvdmlkZXIgbm90IHJlYWR5IFx1MjAxNCBsZWF2ZSBzZXNzaW9uIG9uIGl0cyBjdXJyZW50IG1vZGVsXG4gIH1cbn1cblxuY29uc3QgY2xpRmxhZ3MgPSBwYXJzZUNsaUFyZ3MocHJvY2Vzcy5hcmd2KVxuY29uc3QgaXNQcmludE1vZGUgPSBjbGlGbGFncy5wcmludCB8fCBjbGlGbGFncy5tb2RlICE9PSB1bmRlZmluZWRcblxuLy8gYGdzZCBbc3ViY29tbWFuZF0gLS1oZWxwYCAvIGAtaGAgXHUyMDE0IHByaW50IGhlbHAgYmVmb3JlIGFueSBzdWJjb21tYW5kIHJ1bnMuXG4vLyBsb2FkZXIudHMgb25seSBjYXRjaGVzIC0taGVscC8taCBhcyB0aGUgKmZpcnN0KiBhcmc7IGhlcmUgd2UgaGFuZGxlIHRoZVxuLy8gY2FzZSB3aGVyZSBpdCBhcHBlYXJzIGxhdGVyIChlLmcuIGBnc2QgdXBkYXRlIC0taGVscGAsIGBnc2QgLS1mb28gLS1oZWxwYCkuXG4vLyBQcmVmZXIgc3ViY29tbWFuZC1zcGVjaWZpYyBoZWxwIHdoZW4gdGhlIGZpcnN0IHBvc2l0aW9uYWwgaXMgYSBrbm93blxuLy8gc3ViY29tbWFuZCwgb3RoZXJ3aXNlIGZhbGwgYmFjayB0byBnZW5lcmFsIGhlbHAuXG5pZiAocHJvY2Vzcy5hcmd2LmluY2x1ZGVzKCctLWhlbHAnKSB8fCBwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoJy1oJykpIHtcbiAgY29uc3QgaGVscFN1YmNvbW1hbmQgPSBjbGlGbGFncy5tZXNzYWdlc1swXVxuICBjb25zdCB2ZXJzaW9uID0gcHJvY2Vzcy5lbnYuR1NEX1ZFUlNJT04gfHwgJzAuMC4wJ1xuICBpZiAoIWhlbHBTdWJjb21tYW5kIHx8ICFwcmludFN1YmNvbW1hbmRIZWxwKGhlbHBTdWJjb21tYW5kLCB2ZXJzaW9uKSkge1xuICAgIHByaW50SGVscCh2ZXJzaW9uKVxuICB9XG4gIHByb2Nlc3MuZXhpdCgwKVxufVxuXG4vLyBSVEsgYm9vdHN0cmFwIFx1MjAxNCBydW5zIG9uY2UgcGVyIHByb2Nlc3MsIG1lbW9pemVkIHZpYSBhIG1vZHVsZS1sZXZlbCBwcm9taXNlXG4vLyBzbyBjb25jdXJyZW50IGNhbGxlcnMgYXdhaXQgdGhlIHNhbWUgaW5pdGlhbGl6YXRpb24uXG5sZXQgcnRrQm9vdHN0cmFwUHJvbWlzZTogUHJvbWlzZTx2b2lkPiB8IHVuZGVmaW5lZFxuYXN5bmMgZnVuY3Rpb24gZG9SdGtCb290c3RyYXAoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGxldCBydGtTdGF0dXM6IEVuc3VyZVJ0a1Jlc3VsdCB8IHVuZGVmaW5lZFxuICBsZXQgcnRrRGlzYWJsZWQgPSBpc1RydXRoeShwcm9jZXNzLmVudltHU0RfUlRLX0RJU0FCTEVEX0VOVl0pXG5cbiAgLy8gUlRLIGlzIG9wdC1pbiB2aWEgZXhwZXJpbWVudGFsLnJ0ayBwcmVmZXJlbmNlLiBEZWZhdWx0OiBkaXNhYmxlZC5cbiAgLy8gSG9ub3IgR1NEX1JUS19ESVNBQkxFRCBpZiBhbHJlYWR5IGV4cGxpY2l0bHkgc2V0IGluIHRoZSBlbnZpcm9ubWVudFxuICAvLyAoZW52IHZhciB0YWtlcyBwcmVjZWRlbmNlIG92ZXIgcHJlZmVyZW5jZXMgZm9yIG1hbnVhbCBvdmVycmlkZSkuXG4gIGlmICghcnRrRGlzYWJsZWQpIHtcbiAgICBjb25zdCB7IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyB9ID0gYXdhaXQgaW1wb3J0KCcuL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcmVmZXJlbmNlcy5qcycpXG4gICAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKVxuICAgIGNvbnN0IHJ0a0VuYWJsZWQgPSBwcmVmcz8ucHJlZmVyZW5jZXMuZXhwZXJpbWVudGFsPy5ydGsgPT09IHRydWVcbiAgICBpZiAoIXJ0a0VuYWJsZWQpIHtcbiAgICAgIHByb2Nlc3MuZW52W0dTRF9SVEtfRElTQUJMRURfRU5WXSA9ICcxJ1xuICAgICAgcnRrRGlzYWJsZWQgPSB0cnVlXG4gICAgfVxuICB9XG4gIG1hcmtTdGFydHVwKCdydGtQcmVmZXJlbmNlQ2hlY2snKVxuXG4gIGlmIChydGtEaXNhYmxlZCkge1xuICAgIGFwcGx5UnRrUHJvY2Vzc0Vudihwcm9jZXNzLmVudilcbiAgICBydGtTdGF0dXMgPSB7XG4gICAgICBlbmFibGVkOiBmYWxzZSxcbiAgICAgIHN1cHBvcnRlZDogdHJ1ZSxcbiAgICAgIGF2YWlsYWJsZTogZmFsc2UsXG4gICAgICBzb3VyY2U6ICdkaXNhYmxlZCcsXG4gICAgICByZWFzb246IGAke0dTRF9SVEtfRElTQUJMRURfRU5WfSBpcyBzZXRgLFxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBjb25zdCB7IGJvb3RzdHJhcFJ0ayB9ID0gYXdhaXQgaW1wb3J0KCcuL3J0ay5qcycpXG4gICAgcnRrU3RhdHVzID0gYXdhaXQgYm9vdHN0cmFwUnRrKClcbiAgfVxuICBtYXJrU3RhcnR1cCgnYm9vdHN0cmFwUnRrJylcbiAgaWYgKCFydGtTdGF0dXMuYXZhaWxhYmxlICYmIHJ0a1N0YXR1cy5zdXBwb3J0ZWQgJiYgcnRrU3RhdHVzLmVuYWJsZWQgJiYgcnRrU3RhdHVzLnJlYXNvbikge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBbZ3NkXSBXYXJuaW5nOiBSVEsgdW5hdmFpbGFibGUgXHUyMDE0IGNvbnRpbnVpbmcgd2l0aG91dCBzaGVsbC1jb21tYW5kIGNvbXByZXNzaW9uICgke3J0a1N0YXR1cy5yZWFzb259KS5cXG5gKVxuICB9XG59XG5mdW5jdGlvbiBlbnN1cmVSdGtCb290c3RyYXAoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghcnRrQm9vdHN0cmFwUHJvbWlzZSkge1xuICAgIG1hcmtTdGFydHVwKCdwcmVSdGtCb290c3RyYXAnKVxuICAgIHJ0a0Jvb3RzdHJhcFByb21pc2UgPSBkb1J0a0Jvb3RzdHJhcCgpXG4gIH1cbiAgcmV0dXJuIHJ0a0Jvb3RzdHJhcFByb21pc2Vcbn1cblxuLy8gYGdzZCB1cGRhdGVgIFx1MjAxNCB1cGRhdGUgdG8gdGhlIGxhdGVzdCB2ZXJzaW9uIHZpYSBucG0uXG4vLyBNVVNUIHJ1biBiZWZvcmUgZXhpdElmTWFuYWdlZFJlc291cmNlc0FyZU5ld2VyKCk6IHdoZW4gdGhlIGJ1bmRsZWQgcmVzb3VyY2Vcbi8vIG1hbmlmZXN0IGlzIGZyb20gYSBuZXdlciB2ZXJzaW9uIHRoYW4gdGhlIHJ1bm5pbmcgYmluYXJ5LCBldmVyeSBvdGhlclxuLy8gY29tbWFuZCBpcyBibG9ja2VkIFx1MjAxNCBvbmx5IGB1cGRhdGVgIHNob3VsZCBieXBhc3MgdGhlIGdhdGUgc28gdGhlIHVzZXIgY2FuXG4vLyBhY3R1YWxseSB1cGdyYWRlIG91dCBvZiB0aGUgYnJva2VuIHN0YXRlLiBTZWUgc2hvdWxkQnlwYXNzTWFuYWdlZFJlc291cmNlTWlzbWF0Y2hHYXRlLlxuaWYgKHNob3VsZEJ5cGFzc01hbmFnZWRSZXNvdXJjZU1pc21hdGNoR2F0ZShjbGlGbGFncy5tZXNzYWdlc1swXSkpIHtcbiAgY29uc3QgeyBydW5VcGRhdGUgfSA9IGF3YWl0IGltcG9ydCgnLi91cGRhdGUtY21kLmpzJylcbiAgYXdhaXQgcnVuVXBkYXRlKClcbiAgcHJvY2Vzcy5leGl0KDApXG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gR3JhcGggc3ViY29tbWFuZCBcdTIwMTQgYGdzZCBncmFwaCBidWlsZHxzdGF0dXN8cXVlcnl8ZGlmZmBcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuaWYgKGNsaUZsYWdzLm1lc3NhZ2VzWzBdID09PSAnZ3JhcGgnKSB7XG4gIGNvbnN0IHN1YiA9IGNsaUZsYWdzLm1lc3NhZ2VzWzFdXG4gIGNvbnN0IHsgYnVpbGRHcmFwaCwgd3JpdGVHcmFwaCwgZ3JhcGhTdGF0dXMsIGdyYXBoUXVlcnksIGdyYXBoRGlmZiwgcmVzb2x2ZUdzZFJvb3QgfSA9IGF3YWl0IGltcG9ydCgnQGdzZC1idWlsZC9tY3Atc2VydmVyJylcblxuICBjb25zdCBwcm9qZWN0RGlyID0gcHJvY2Vzcy5jd2QoKVxuICBjb25zdCBnc2RSb290ID0gcmVzb2x2ZUdzZFJvb3QocHJvamVjdERpcilcblxuICBpZiAoIXN1YiB8fCBzdWIgPT09ICdidWlsZCcpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZ3JhcGggPSBhd2FpdCBidWlsZEdyYXBoKHByb2plY3REaXIpXG4gICAgICBhd2FpdCB3cml0ZUdyYXBoKGdzZFJvb3QsIGdyYXBoKVxuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYEdyYXBoIGJ1aWx0OiAke2dyYXBoLm5vZGVzLmxlbmd0aH0gbm9kZXMsICR7Z3JhcGguZWRnZXMubGVuZ3RofSBlZGdlc1xcbmApXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2dzZF0gZ3JhcGggYnVpbGQgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1cXG5gKVxuICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgfVxuICB9IGVsc2UgaWYgKHN1YiA9PT0gJ3N0YXR1cycpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhTdGF0dXMocHJvamVjdERpcilcbiAgICAgIGlmICghcmVzdWx0LmV4aXN0cykge1xuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZSgnR3JhcGg6IG5vdCBidWlsdCB5ZXQuIFJ1bjogZ3NkIGdyYXBoIGJ1aWxkXFxuJylcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBHcmFwaCBzdGF0dXM6XFxuYClcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCAgZXhpc3RzOiAgICAke3Jlc3VsdC5leGlzdHN9XFxuYClcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCAgbm9kZXM6ICAgICAke3Jlc3VsdC5ub2RlQ291bnR9XFxuYClcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCAgZWRnZXM6ICAgICAke3Jlc3VsdC5lZGdlQ291bnR9XFxuYClcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCAgc3RhbGU6ICAgICAke3Jlc3VsdC5zdGFsZX1cXG5gKVxuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgICBhZ2VIb3VyczogICR7cmVzdWx0LmFnZUhvdXJzICE9PSB1bmRlZmluZWQgPyByZXN1bHQuYWdlSG91cnMudG9GaXhlZCgyKSA6ICduL2EnfVxcbmApXG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAgIGxhc3RCdWlsZDogJHtyZXN1bHQubGFzdEJ1aWxkID8/ICduL2EnfVxcbmApXG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2dzZF0gZ3JhcGggc3RhdHVzIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9XFxuYClcbiAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgIH1cbiAgfSBlbHNlIGlmIChzdWIgPT09ICdxdWVyeScpIHtcbiAgICBjb25zdCB0ZXJtID0gY2xpRmxhZ3MubWVzc2FnZXNbMl1cbiAgICBpZiAoIXRlcm0pIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdVc2FnZTogZ3NkIGdyYXBoIHF1ZXJ5IDx0ZXJtPlxcbicpXG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBoUXVlcnkocHJvamVjdERpciwgdGVybSlcbiAgICAgIGlmIChyZXN1bHQubm9kZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBObyBub2RlcyBmb3VuZCBmb3IgdGVybTogXCIke3Rlcm19XCJcXG5gKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYFF1ZXJ5IHJlc3VsdHMgZm9yIFwiJHt0ZXJtfVwiICgke3Jlc3VsdC5ub2Rlcy5sZW5ndGh9IG5vZGVzLCAke3Jlc3VsdC5lZGdlcy5sZW5ndGh9IGVkZ2VzKTpcXG5gKVxuICAgICAgICBmb3IgKGNvbnN0IG5vZGUgb2YgcmVzdWx0Lm5vZGVzKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCAgWyR7bm9kZS50eXBlfV0gJHtub2RlLmxhYmVsfSAoJHtub2RlLmNvbmZpZGVuY2V9KVxcbmApXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBbZ3NkXSBncmFwaCBxdWVyeSBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfVxcbmApXG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICB9XG4gIH0gZWxzZSBpZiAoc3ViID09PSAnZGlmZicpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhEaWZmKHByb2plY3REaXIpXG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgR3JhcGggZGlmZjpcXG5gKVxuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCAgbm9kZXMgYWRkZWQ6ICAgICR7cmVzdWx0Lm5vZGVzLmFkZGVkLmxlbmd0aH1cXG5gKVxuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCAgbm9kZXMgcmVtb3ZlZDogICR7cmVzdWx0Lm5vZGVzLnJlbW92ZWQubGVuZ3RofVxcbmApXG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgICBub2RlcyBjaGFuZ2VkOiAgJHtyZXN1bHQubm9kZXMuY2hhbmdlZC5sZW5ndGh9XFxuYClcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAgIGVkZ2VzIGFkZGVkOiAgICAke3Jlc3VsdC5lZGdlcy5hZGRlZC5sZW5ndGh9XFxuYClcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAgIGVkZ2VzIHJlbW92ZWQ6ICAke3Jlc3VsdC5lZGdlcy5yZW1vdmVkLmxlbmd0aH1cXG5gKVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtnc2RdIGdyYXBoIGRpZmYgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1cXG5gKVxuICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBVbmtub3duIGdyYXBoIGNvbW1hbmQ6ICR7c3VifVxcbmApXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoJ0NvbW1hbmRzOiBidWlsZCwgc3RhdHVzLCBxdWVyeSA8dGVybT4sIGRpZmZcXG4nKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG4gIHByb2Nlc3MuZXhpdCgwKVxufVxuXG5leGl0SWZNYW5hZ2VkUmVzb3VyY2VzQXJlTmV3ZXIoYWdlbnREaXIpXG5cbi8vIEVhcmx5IFRUWSBjaGVjayBcdTIwMTQgbXVzdCBjb21lIGJlZm9yZSBoZWF2eSBpbml0aWFsaXphdGlvbiB0byBhdm9pZCBkYW5nbGluZ1xuLy8gaGFuZGxlcyB0aGF0IHByZXZlbnQgcHJvY2Vzcy5leGl0KCkgZnJvbSBjb21wbGV0aW5nIHByb21wdGx5LlxuY29uc3QgaGFzU3ViY29tbWFuZCA9IGNsaUZsYWdzLm1lc3NhZ2VzLmxlbmd0aCA+IDBcbmlmICghcHJvY2Vzcy5zdGRpbi5pc1RUWSAmJiAhaXNQcmludE1vZGUgJiYgIWhhc1N1YmNvbW1hbmQgJiYgIWNsaUZsYWdzLmxpc3RNb2RlbHMgJiYgIWNsaUZsYWdzLndlYikge1xuICBwcmludE5vblR0eUVycm9yQW5kRXhpdCh1bmRlZmluZWQsIGZhbHNlKVxufVxuXG5jb25zdCBwYWNrYWdlQ29tbWFuZE5hbWVzOiBSZWFkb25seVNldDxQYWNrYWdlQ29tbWFuZD4gPSBuZXcgU2V0KFsnaW5zdGFsbCcsICdyZW1vdmUnLCAnbGlzdCddKVxuaWYgKHBhY2thZ2VDb21tYW5kTmFtZXMuaGFzKGNsaUZsYWdzLm1lc3NhZ2VzWzBdIGFzIFBhY2thZ2VDb21tYW5kKSkge1xuICBjb25zdCB7IHJ1blBhY2thZ2VDb21tYW5kIH0gPSBhd2FpdCBsb2FkUGlDb2RpbmdBZ2VudE1vZHVsZSgpXG4gIGNvbnN0IHBhY2thZ2VDb21tYW5kID0gYXdhaXQgcnVuUGFja2FnZUNvbW1hbmQoe1xuICAgIGFwcE5hbWU6ICdnc2QnLFxuICAgIGFyZ3M6IHByb2Nlc3MuYXJndi5zbGljZSgyKSxcbiAgICBjd2Q6IHByb2Nlc3MuY3dkKCksXG4gICAgYWdlbnREaXIsXG4gICAgc3Rkb3V0OiBwcm9jZXNzLnN0ZG91dCxcbiAgICBzdGRlcnI6IHByb2Nlc3Muc3RkZXJyLFxuICAgIGFsbG93ZWRDb21tYW5kczogcGFja2FnZUNvbW1hbmROYW1lcyxcbiAgfSlcbiAgaWYgKHBhY2thZ2VDb21tYW5kLmhhbmRsZWQpIHtcbiAgICBwcm9jZXNzLmV4aXQocGFja2FnZUNvbW1hbmQuZXhpdENvZGUpXG4gIH1cbn1cblxuLy8gYGdzZCBjb25maWdgIFx1MjAxNCByZXBsYXkgdGhlIHNldHVwIHdpemFyZCBhbmQgZXhpdFxuaWYgKGNsaUZsYWdzLm1lc3NhZ2VzWzBdID09PSAnY29uZmlnJykge1xuICBjb25zdCB7IEF1dGhTdG9yYWdlIH0gPSBhd2FpdCBsb2FkUGlDb2RpbmdBZ2VudE1vZHVsZSgpXG4gIGNvbnN0IGF1dGhTdG9yYWdlID0gQXV0aFN0b3JhZ2UuY3JlYXRlKGF1dGhGaWxlUGF0aClcbiAgbG9hZFN0b3JlZEVudktleXMoYXV0aFN0b3JhZ2UpXG4gIGF3YWl0IHJ1bk9uYm9hcmRpbmcoYXV0aFN0b3JhZ2UpXG4gIHByb2Nlc3MuZXhpdCgwKVxufVxuXG4vLyBgZ3NkIHdlYiBzdG9wIFtwYXRofGFsbF1gIFx1MjAxNCBzdG9wIHdlYiBzZXJ2ZXIgYmVmb3JlIGFueXRoaW5nIGVsc2VcbmlmIChjbGlGbGFncy5tZXNzYWdlc1swXSA9PT0gJ3dlYicgJiYgY2xpRmxhZ3MubWVzc2FnZXNbMV0gPT09ICdzdG9wJykge1xuICBjb25zdCB3ZWJCcmFuY2ggPSBhd2FpdCBydW5XZWJDbGlCcmFuY2goY2xpRmxhZ3MsIHtcbiAgICBzdG9wV2ViTW9kZSxcbiAgICBzdGRlcnI6IHByb2Nlc3Muc3RkZXJyLFxuICAgIGJhc2VTZXNzaW9uc0Rpcjogc2Vzc2lvbnNEaXIsXG4gICAgYWdlbnREaXIsXG4gIH0pXG4gIGlmICh3ZWJCcmFuY2guaGFuZGxlZCkge1xuICAgIHByb2Nlc3MuZXhpdCh3ZWJCcmFuY2guZXhpdENvZGUpXG4gIH1cbn1cblxuLy8gYGdzZCAtLXdlYiBbcGF0aF1gIG9yIGBnc2Qgd2ViIFtzdGFydF0gW3BhdGhdYCBcdTIwMTQgbGF1bmNoIGJyb3dzZXItb25seSB3ZWIgbW9kZVxuaWYgKGNsaUZsYWdzLndlYiB8fCAoY2xpRmxhZ3MubWVzc2FnZXNbMF0gPT09ICd3ZWInICYmIGNsaUZsYWdzLm1lc3NhZ2VzWzFdICE9PSAnc3RvcCcpKSB7XG4gIGF3YWl0IGVuc3VyZVJ0a0Jvb3RzdHJhcCgpXG4gIGNvbnN0IHdlYkJyYW5jaCA9IGF3YWl0IHJ1bldlYkNsaUJyYW5jaChjbGlGbGFncywge1xuICAgIHN0ZGVycjogcHJvY2Vzcy5zdGRlcnIsXG4gICAgYmFzZVNlc3Npb25zRGlyOiBzZXNzaW9uc0RpcixcbiAgICBhZ2VudERpcixcbiAgfSlcbiAgaWYgKHdlYkJyYW5jaC5oYW5kbGVkKSB7XG4gICAgcHJvY2Vzcy5leGl0KHdlYkJyYW5jaC5leGl0Q29kZSlcbiAgfVxufVxuXG5cbi8vIGBnc2Qgc2Vzc2lvbnNgIFx1MjAxNCBsaXN0IHBhc3Qgc2Vzc2lvbnMgYW5kIHBpY2sgb25lIHRvIHJlc3VtZVxuaWYgKGNsaUZsYWdzLm1lc3NhZ2VzWzBdID09PSAnc2Vzc2lvbnMnKSB7XG4gIGNvbnN0IHsgU2Vzc2lvbk1hbmFnZXIgfSA9IGF3YWl0IGxvYWRQaUNvZGluZ0FnZW50TW9kdWxlKClcbiAgY29uc3QgY3dkID0gcHJvY2Vzcy5jd2QoKVxuICBjb25zdCBzYWZlUGF0aCA9IGAtLSR7Y3dkLnJlcGxhY2UoL15bL1xcXFxdLywgJycpLnJlcGxhY2UoL1svXFxcXDpdL2csICctJyl9LS1gXG4gIGNvbnN0IHByb2plY3RTZXNzaW9uc0RpciA9IGpvaW4oc2Vzc2lvbnNEaXIsIHNhZmVQYXRoKVxuXG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbShgTG9hZGluZyBzZXNzaW9ucyBmb3IgJHtjd2R9Li4uXFxuYCkpXG4gIGNvbnN0IHNlc3Npb25zID0gYXdhaXQgU2Vzc2lvbk1hbmFnZXIubGlzdChjd2QsIHByb2plY3RTZXNzaW9uc0RpcilcblxuICBpZiAoc2Vzc2lvbnMubGVuZ3RoID09PSAwKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsueWVsbG93KCdObyBzZXNzaW9ucyBmb3VuZCBmb3IgdGhpcyBkaXJlY3RvcnkuXFxuJykpXG4gICAgcHJvY2Vzcy5leGl0KDApXG4gIH1cblxuICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5ib2xkKGBcXG4gIFNlc3Npb25zICgke3Nlc3Npb25zLmxlbmd0aH0pOlxcblxcbmApKVxuXG4gIGNvbnN0IG1heFNob3cgPSAyMFxuICBjb25zdCB0b1Nob3cgPSBzZXNzaW9ucy5zbGljZSgwLCBtYXhTaG93KVxuICBmb3IgKGxldCBpID0gMDsgaSA8IHRvU2hvdy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHMgPSB0b1Nob3dbaV1cbiAgICBjb25zdCBkYXRlID0gcy5tb2RpZmllZC50b0xvY2FsZVN0cmluZygpXG4gICAgY29uc3QgbXNncyA9IHMubWVzc2FnZUNvdW50XG4gICAgY29uc3QgbmFtZSA9IHMubmFtZSA/IGAgJHtjaGFsay5jeWFuKHMubmFtZSl9YCA6ICcnXG4gICAgY29uc3QgcHJldmlldyA9IHMuZmlyc3RNZXNzYWdlXG4gICAgICA/IHMuZmlyc3RNZXNzYWdlLnJlcGxhY2UoL1xcbi9nLCAnICcpLnN1YnN0cmluZygwLCA4MClcbiAgICAgIDogY2hhbGsuZGltKCcoZW1wdHkpJylcbiAgICBjb25zdCBudW0gPSBTdHJpbmcoaSArIDEpLnBhZFN0YXJ0KDMpXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCAgJHtjaGFsay5ib2xkKG51bSl9LiAke2NoYWxrLmdyZWVuKGRhdGUpfSAke2NoYWxrLmRpbShgKCR7bXNnc30gbXNncylgKX0ke25hbWV9XFxuYClcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgICAgICAgICR7Y2hhbGsuZGltKHByZXZpZXcpfVxcblxcbmApXG4gIH1cblxuICBpZiAoc2Vzc2lvbnMubGVuZ3RoID4gbWF4U2hvdykge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGNoYWxrLmRpbShgICAuLi4gYW5kICR7c2Vzc2lvbnMubGVuZ3RoIC0gbWF4U2hvd30gbW9yZVxcblxcbmApKVxuICB9XG5cbiAgLy8gSW50ZXJhY3RpdmUgc2VsZWN0aW9uXG4gIGNvbnN0IHJlYWRsaW5lID0gYXdhaXQgaW1wb3J0KCdub2RlOnJlYWRsaW5lJylcbiAgY29uc3QgcmwgPSByZWFkbGluZS5jcmVhdGVJbnRlcmZhY2UoeyBpbnB1dDogcHJvY2Vzcy5zdGRpbiwgb3V0cHV0OiBwcm9jZXNzLnN0ZGVyciB9KVxuICBjb25zdCBhbnN3ZXIgPSBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXNvbHZlKSA9PiB7XG4gICAgcmwucXVlc3Rpb24oY2hhbGsuYm9sZCgnICBFbnRlciBzZXNzaW9uIG51bWJlciB0byByZXN1bWUgKG9yIHEgdG8gcXVpdCk6ICcpLCByZXNvbHZlKVxuICB9KVxuICBybC5jbG9zZSgpXG5cbiAgLy8gQ2xlYW4gdXAgc3RkaW4gc3RhdGUgbGVmdCBieSByZWFkbGluZS5jcmVhdGVJbnRlcmZhY2UoKS5cbiAgLy8gV2l0aG91dCB0aGlzLCBkb3duc3RyZWFtIFRVSSBpbml0aWFsaXphdGlvbiBnZXRzIGNvcnJ1cHRlZCBsaXN0ZW5lcnMgYW5kIGV4aGliaXRzXG4gIC8vIGR1cGxpY2F0ZSB0ZXJtaW5hbCBJL08uIE1hdGNoIHRoZSBwYXR0ZXJuIHVzZWQgYWZ0ZXIgb25ib2FyZGluZyBjbGVhbnVwLlxuICBwcm9jZXNzLnN0ZGluLnJlbW92ZUFsbExpc3RlbmVycygnZGF0YScpXG4gIHByb2Nlc3Muc3RkaW4ucmVtb3ZlQWxsTGlzdGVuZXJzKCdrZXlwcmVzcycpXG4gIGlmIChwcm9jZXNzLnN0ZGluLnNldFJhd01vZGUpIHByb2Nlc3Muc3RkaW4uc2V0UmF3TW9kZShmYWxzZSlcbiAgcHJvY2Vzcy5zdGRpbi5wYXVzZSgpXG5cbiAgY29uc3QgY2hvaWNlID0gcGFyc2VJbnQoYW5zd2VyLCAxMClcbiAgaWYgKGlzTmFOKGNob2ljZSkgfHwgY2hvaWNlIDwgMSB8fCBjaG9pY2UgPiB0b1Nob3cubGVuZ3RoKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsuZGltKCdDYW5jZWxsZWQuXFxuJykpXG4gICAgcHJvY2Vzcy5leGl0KDApXG4gIH1cblxuICBjb25zdCBzZWxlY3RlZCA9IHRvU2hvd1tjaG9pY2UgLSAxXVxuICBwcm9jZXNzLnN0ZGVyci53cml0ZShjaGFsay5ncmVlbihgXFxuUmVzdW1pbmcgc2Vzc2lvbiBmcm9tICR7c2VsZWN0ZWQubW9kaWZpZWQudG9Mb2NhbGVTdHJpbmcoKX0uLi5cXG5cXG5gKSlcblxuICAvLyBNYXJrIGZvciB0aGUgaW50ZXJhY3RpdmUgc2Vzc2lvbiBiZWxvdyB0byBvcGVuIHRoaXMgc3BlY2lmaWMgc2Vzc2lvblxuICBjbGlGbGFncy5jb250aW51ZSA9IHRydWVcbiAgY2xpRmxhZ3MuX3NlbGVjdGVkU2Vzc2lvblBhdGggPSBzZWxlY3RlZC5wYXRoXG59XG5cbi8vIGBnc2QgaGVhZGxlc3NgIFx1MjAxNCBydW4gYXV0by1tb2RlIHdpdGhvdXQgVFVJXG5pZiAoY2xpRmxhZ3MubWVzc2FnZXNbMF0gPT09ICdoZWFkbGVzcycpIHtcbiAgYXdhaXQgZW5zdXJlUnRrQm9vdHN0cmFwKClcbiAgLy8gU3luYyBidW5kbGVkIHJlc291cmNlcyBiZWZvcmUgaGVhZGxlc3MgcnVucyAoIzM0NzEpLiBXaXRob3V0IHRoaXMsXG4gIC8vIGhlYWRsZXNzLXF1ZXJ5IGxvYWRzIGZyb20gc3JjL3Jlc291cmNlcy8gd2hpbGUgYXV0by9pbnRlcmFjdGl2ZSBsb2FkXG4gIC8vIGZyb20gfi8uZ3NkL2FnZW50L2V4dGVuc2lvbnMvIFx1MjAxNCBkaWZmZXJlbnQgZXh0ZW5zaW9uIGNvcGllcyBkaXZlcmdlLlxuICBpbml0UmVzb3VyY2VzKGFnZW50RGlyKVxuICBjb25zdCB7IHJ1bkhlYWRsZXNzLCBwYXJzZUhlYWRsZXNzQXJncyB9ID0gYXdhaXQgaW1wb3J0KCcuL2hlYWRsZXNzLmpzJylcbiAgYXdhaXQgcnVuSGVhZGxlc3MocGFyc2VIZWFkbGVzc0FyZ3MocHJvY2Vzcy5hcmd2KSlcbiAgcHJvY2Vzcy5leGl0KDApXG59XG5cbi8qKlxuICogUnVuIGEgaGVhZGxlc3MgY29tbWFuZCBieSBpbnZva2luZyB0aGUgaGVhZGxlc3MgZW50cnlwb2ludCB3aXRoIGEgc3ludGhldGljXG4gKiBhcmd2LiBTaGFyZWQgYnkgdGhlIGBhdXRvYCBzaG9ydGhhbmQgKCMyNzMyKSBhbmQgdGhlIGF1dG8tcGlwZWQtc3Rkb3V0XG4gKiByZWRpcmVjdCBzbyB0aGV5IHVzZSB0aGUgc2FtZSBib290c3RyYXAgKyBkeW5hbWljLWltcG9ydCBkYW5jZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcnVuSGVhZGxlc3NGcm9tQXV0byhoZWFkbGVzc0FyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxuZXZlcj4ge1xuICBhd2FpdCBlbnN1cmVSdGtCb290c3RyYXAoKVxuICBjb25zdCB7IHJ1bkhlYWRsZXNzLCBwYXJzZUhlYWRsZXNzQXJncyB9ID0gYXdhaXQgaW1wb3J0KCcuL2hlYWRsZXNzLmpzJylcbiAgY29uc3QgYXJndiA9IFtwcm9jZXNzLmFyZ3ZbMF0sIHByb2Nlc3MuYXJndlsxXSwgJ2hlYWRsZXNzJywgLi4uaGVhZGxlc3NBcmdzXVxuICBhd2FpdCBydW5IZWFkbGVzcyhwYXJzZUhlYWRsZXNzQXJncyhhcmd2KSlcbiAgcHJvY2Vzcy5leGl0KDApXG59XG5cbmZ1bmN0aW9uIGZsdXNoUGVuZGluZ1Byb3ZpZGVyUmVnaXN0cmF0aW9ucyhyZXNvdXJjZUxvYWRlcjogRGVmYXVsdFJlc291cmNlTG9hZGVySW5zdGFuY2UsIG1vZGVsUmVnaXN0cnk6IE1vZGVsUmVnaXN0cnlJbnN0YW5jZSk6IHZvaWQge1xuICBjb25zdCB7IHJ1bnRpbWUgfSA9IHJlc291cmNlTG9hZGVyLmdldEV4dGVuc2lvbnMoKVxuICBmb3IgKGNvbnN0IHsgbmFtZSwgY29uZmlnIH0gb2YgcnVudGltZS5wZW5kaW5nUHJvdmlkZXJSZWdpc3RyYXRpb25zKSB7XG4gICAgbW9kZWxSZWdpc3RyeS5yZWdpc3RlclByb3ZpZGVyKG5hbWUsIGNvbmZpZylcbiAgfVxuICBydW50aW1lLnBlbmRpbmdQcm92aWRlclJlZ2lzdHJhdGlvbnMgPSBbXVxufVxuXG4vLyBgZ3NkIGF1dG8gW2FyZ3MuLi5dYCB3aXRoIHBpcGVkIHN0ZGluL3N0ZG91dCBcdTIwMTQgc2hvcnRoYW5kIGZvclxuLy8gYGdzZCBoZWFkbGVzcyBhdXRvIFthcmdzLi4uXWAgKCMyNzMyKS4gS2VlcCB0ZXJtaW5hbCBUVFkgbGF1bmNoZXMgaW4gdGhlXG4vLyBpbnRlcmFjdGl2ZSBwYXRoIHNvIFdhcnAvaVRlcm0vVGVybWluYWwgcmV0YWluIGZvcmVncm91bmQgb3duZXJzaGlwLlxuaWYgKHNob3VsZFJlZGlyZWN0QXV0b1RvSGVhZGxlc3MoY2xpRmxhZ3MubWVzc2FnZXNbMF0sIHByb2Nlc3Muc3RkaW4uaXNUVFksIHByb2Nlc3Muc3Rkb3V0LmlzVFRZKSkge1xuICBhd2FpdCBydW5IZWFkbGVzc0Zyb21BdXRvKGJ1aWxkSGVhZGxlc3NBdXRvQXJncyhjbGlGbGFncykpXG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gV29ya3RyZWUgc3ViY29tbWFuZCBcdTIwMTQgYGdzZCB3b3JrdHJlZSA8bGlzdHxtZXJnZXxjbGVhbnxyZW1vdmU+YFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5pZiAoXG4gICFpc1ByaW50TW9kZSAmJlxuICBjbGlGbGFncy5saXN0TW9kZWxzID09PSB1bmRlZmluZWQgJiZcbiAgKGNsaUZsYWdzLm1lc3NhZ2VzWzBdID09PSAnd29ya3RyZWUnIHx8IGNsaUZsYWdzLm1lc3NhZ2VzWzBdID09PSAnd3QnKVxuKSB7XG4gIGNvbnN0IHsgaGFuZGxlTGlzdCwgaGFuZGxlTWVyZ2UsIGhhbmRsZUNsZWFuLCBoYW5kbGVSZW1vdmUgfSA9IGF3YWl0IGltcG9ydCgnLi93b3JrdHJlZS1jbGkuanMnKVxuICBjb25zdCBzdWIgPSBjbGlGbGFncy5tZXNzYWdlc1sxXVxuICBjb25zdCBzdWJBcmdzID0gY2xpRmxhZ3MubWVzc2FnZXMuc2xpY2UoMilcblxuICBpZiAoIXN1YiB8fCBzdWIgPT09ICdsaXN0Jykge1xuICAgIGF3YWl0IGhhbmRsZUxpc3QocHJvY2Vzcy5jd2QoKSlcbiAgfSBlbHNlIGlmIChzdWIgPT09ICdtZXJnZScpIHtcbiAgICBhd2FpdCBoYW5kbGVNZXJnZShwcm9jZXNzLmN3ZCgpLCBzdWJBcmdzKVxuICB9IGVsc2UgaWYgKHN1YiA9PT0gJ2NsZWFuJykge1xuICAgIGF3YWl0IGhhbmRsZUNsZWFuKHByb2Nlc3MuY3dkKCkpXG4gIH0gZWxzZSBpZiAoc3ViID09PSAncmVtb3ZlJyB8fCBzdWIgPT09ICdybScpIHtcbiAgICBhd2FpdCBoYW5kbGVSZW1vdmUocHJvY2Vzcy5jd2QoKSwgc3ViQXJncylcbiAgfSBlbHNlIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgVW5rbm93biB3b3JrdHJlZSBjb21tYW5kOiAke3N1Yn1cXG5gKVxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdDb21tYW5kczogbGlzdCwgbWVyZ2UgW25hbWVdLCBjbGVhbiwgcmVtb3ZlIDxuYW1lPlxcbicpXG4gIH1cbiAgcHJvY2Vzcy5leGl0KDApXG59XG5cbmNvbnN0IHtcbiAgQXV0aFN0b3JhZ2UsXG4gIERlZmF1bHRSZXNvdXJjZUxvYWRlcixcbiAgTW9kZWxSZWdpc3RyeSxcbiAgU2V0dGluZ3NNYW5hZ2VyLFxuICBTZXNzaW9uTWFuYWdlcixcbiAgY3JlYXRlQWdlbnRTZXNzaW9uLFxuICBJbnRlcmFjdGl2ZU1vZGUsXG4gIHJ1blByaW50TW9kZSxcbiAgcnVuUnBjTW9kZSxcbn0gPSBhd2FpdCBsb2FkUGlDb2RpbmdBZ2VudE1vZHVsZSgpXG5tYXJrU3RhcnR1cCgnbG9hZFBpQ29kaW5nQWdlbnQnKVxuXG4vLyBQaSdzIHRvb2wgYm9vdHN0cmFwIGNhbiBtaXMtZGV0ZWN0IGFscmVhZHktaW5zdGFsbGVkIGZkL3JnIG9uIHNvbWUgc3lzdGVtc1xuLy8gYmVjYXVzZSBzcGF3blN5bmMoLi4uLCBbXCItLXZlcnNpb25cIl0pIHJldHVybnMgRVBFUk0gZGVzcGl0ZSBhIHplcm8gZXhpdCBjb2RlLlxuLy8gUHJvdmlzaW9uIGxvY2FsIG1hbmFnZWQgYmluYXJpZXMgZmlyc3Qgc28gUGkgc2VlcyB0aGVtIHdpdGhvdXQgcHJvYmluZyBQQVRILlxuZW5zdXJlTWFuYWdlZFRvb2xzKGpvaW4oYWdlbnREaXIsICdiaW4nKSlcbm1hcmtTdGFydHVwKCdlbnN1cmVNYW5hZ2VkVG9vbHMnKVxuXG5jb25zdCBhdXRoU3RvcmFnZSA9IEF1dGhTdG9yYWdlLmNyZWF0ZShhdXRoRmlsZVBhdGgpXG5tYXJrU3RhcnR1cCgnQXV0aFN0b3JhZ2UuY3JlYXRlJylcbmxvYWRTdG9yZWRFbnZLZXlzKGF1dGhTdG9yYWdlKVxubWlncmF0ZVBpQ3JlZGVudGlhbHMoYXV0aFN0b3JhZ2UpXG5cbi8vIFJlc29sdmUgbW9kZWxzLmpzb24gcGF0aCB3aXRoIGZhbGxiYWNrIHRvIH4vLnBpL2FnZW50L21vZGVscy5qc29uXG5jb25zdCB7IHJlc29sdmVNb2RlbHNKc29uUGF0aCB9ID0gYXdhaXQgaW1wb3J0KCcuL21vZGVscy1yZXNvbHZlci5qcycpXG5jb25zdCBtb2RlbHNKc29uUGF0aCA9IHJlc29sdmVNb2RlbHNKc29uUGF0aCgpXG5cbmNvbnN0IG1vZGVsUmVnaXN0cnkgPSBuZXcgTW9kZWxSZWdpc3RyeShhdXRoU3RvcmFnZSwgbW9kZWxzSnNvblBhdGgpXG5tYXJrU3RhcnR1cCgnTW9kZWxSZWdpc3RyeScpXG5jb25zdCBzZXR0aW5nc01hbmFnZXIgPSBTZXR0aW5nc01hbmFnZXIuY3JlYXRlKHByb2Nlc3MuY3dkKCksIGFnZW50RGlyKVxuYXBwbHlTZWN1cml0eU92ZXJyaWRlcyhzZXR0aW5nc01hbmFnZXIpXG5tYXJrU3RhcnR1cCgnU2V0dGluZ3NNYW5hZ2VyLmNyZWF0ZScpXG5cbi8vIFJ1biBvbmJvYXJkaW5nIHdpemFyZCBvbiBmaXJzdCBsYXVuY2ggKG5vIExMTSBwcm92aWRlciBjb25maWd1cmVkKVxuaWYgKCFpc1ByaW50TW9kZSAmJiBzaG91bGRSdW5PbmJvYXJkaW5nKGF1dGhTdG9yYWdlLCBzZXR0aW5nc01hbmFnZXIuZ2V0RGVmYXVsdFByb3ZpZGVyKCkpKSB7XG4gIGF3YWl0IHJ1bk9uYm9hcmRpbmcoYXV0aFN0b3JhZ2UpXG5cbiAgLy8gQ2xlYW4gdXAgc3RkaW4gc3RhdGUgbGVmdCBieSBAY2xhY2svcHJvbXB0cy5cbiAgLy8gcmVhZGxpbmUuZW1pdEtleXByZXNzRXZlbnRzKCkgYWRkcyBhIHBlcm1hbmVudCBkYXRhIGxpc3RlbmVyIGFuZFxuICAvLyByZWFkbGluZS5jcmVhdGVJbnRlcmZhY2UoKSBtYXkgbGVhdmUgc3RkaW4gcGF1c2VkLiBSZW1vdmUgc3RhbGVcbiAgLy8gbGlzdGVuZXJzIGFuZCBwYXVzZSBzdGRpbiBzbyB0aGUgVFVJIGNhbiBzdGFydCB3aXRoIGEgY2xlYW4gc2xhdGUuXG4gIHByb2Nlc3Muc3RkaW4ucmVtb3ZlQWxsTGlzdGVuZXJzKCdkYXRhJylcbiAgcHJvY2Vzcy5zdGRpbi5yZW1vdmVBbGxMaXN0ZW5lcnMoJ2tleXByZXNzJylcbiAgaWYgKHByb2Nlc3Muc3RkaW4uc2V0UmF3TW9kZSkgcHJvY2Vzcy5zdGRpbi5zZXRSYXdNb2RlKGZhbHNlKVxuICBwcm9jZXNzLnN0ZGluLnBhdXNlKClcbn1cblxuLy8gVXBkYXRlIGNoZWNrIFx1MjAxNCBub24tYmxvY2tpbmcgYmFubmVyIGNoZWNrOyBpbnRlcmFjdGl2ZSBwcm9tcHQgZGVmZXJyZWQgdG8gYXZvaWRcbi8vIGJsb2NraW5nIHN0YXJ0dXAuIFRoZSBwYXNzaXZlIGNoZWNrRm9yVXBkYXRlcygpIHByaW50cyBhIGJhbm5lciBpZiBhbiB1cGRhdGUgaXNcbi8vIGF2YWlsYWJsZSAodXNpbmcgY2FjaGVkIGRhdGEgb3IgYSBiYWNrZ3JvdW5kIGZldGNoKSB3aXRob3V0IGJsb2NraW5nIHRoZSBUVUkuXG5pZiAoIWlzUHJpbnRNb2RlKSB7XG4gIGNoZWNrRm9yVXBkYXRlcygpLmNhdGNoKCgpID0+IHt9KVxufVxuXG4vLyBXYXJuIGlmIHRlcm1pbmFsIGlzIHRvbyBuYXJyb3cgZm9yIHJlYWRhYmxlIG91dHB1dFxuaWYgKCFpc1ByaW50TW9kZSAmJiBwcm9jZXNzLnN0ZG91dC5jb2x1bW5zICYmIHByb2Nlc3Muc3Rkb3V0LmNvbHVtbnMgPCA0MCkge1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICBjaGFsay55ZWxsb3coYFtnc2RdIFRlcm1pbmFsIHdpZHRoIGlzICR7cHJvY2Vzcy5zdGRvdXQuY29sdW1uc30gY29sdW1ucyAobWluaW11bSByZWNvbW1lbmRlZDogNDApLiBPdXRwdXQgbWF5IGJlIHVucmVhZGFibGUuXFxuYCksXG4gIClcbn1cblxuLy8gLS1saXN0LW1vZGVsczogbG9hZCBleHRlbnNpb25zIHNvIHRoYXQgZXh0ZW5zaW9uLXJlZ2lzdGVyZWQgcHJvdmlkZXJzIChlLmcuXG4vLyBwaS1jbGF1ZGUtY2xpKSBhcHBlYXIgaW4gdGhlIGxpc3RpbmcsIHRoZW4gZmx1c2ggdGhlaXIgcGVuZGluZyByZWdpc3RyYXRpb25zXG4vLyBpbnRvIHRoZSBtb2RlbCByZWdpc3RyeSBiZWZvcmUgcHJpbnRpbmcuXG5pZiAoY2xpRmxhZ3MubGlzdE1vZGVscyAhPT0gdW5kZWZpbmVkKSB7XG4gIGV4aXRJZk1hbmFnZWRSZXNvdXJjZXNBcmVOZXdlcihhZ2VudERpcilcbiAgaW5pdFJlc291cmNlcyhhZ2VudERpcilcbiAgY29uc3QgbGlzdE1vZGVsc0xvYWRlciA9IG5ldyBEZWZhdWx0UmVzb3VyY2VMb2FkZXIoe1xuICAgIGFnZW50RGlyLFxuICAgIGFkZGl0aW9uYWxFeHRlbnNpb25QYXRoczogY2xpRmxhZ3MuZXh0ZW5zaW9ucy5sZW5ndGggPiAwID8gY2xpRmxhZ3MuZXh0ZW5zaW9ucyA6IHVuZGVmaW5lZCxcbiAgfSlcbiAgYXdhaXQgbGlzdE1vZGVsc0xvYWRlci5yZWxvYWQoKVxuICBmbHVzaFBlbmRpbmdQcm92aWRlclJlZ2lzdHJhdGlvbnMobGlzdE1vZGVsc0xvYWRlciwgbW9kZWxSZWdpc3RyeSlcblxuICBjb25zdCBtb2RlbHMgPSBtb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpXG4gIGlmIChtb2RlbHMubGVuZ3RoID09PSAwKSB7XG4gICAgY29uc29sZS5sb2coJ05vIG1vZGVscyBhdmFpbGFibGUuIFNldCBBUEkga2V5cyBpbiBlbnZpcm9ubWVudCB2YXJpYWJsZXMuJylcbiAgICBwcm9jZXNzLmV4aXQoMClcbiAgfVxuXG4gIGNvbnN0IHNlYXJjaFBhdHRlcm4gPSB0eXBlb2YgY2xpRmxhZ3MubGlzdE1vZGVscyA9PT0gJ3N0cmluZycgPyBjbGlGbGFncy5saXN0TW9kZWxzIDogdW5kZWZpbmVkXG4gIGxldCBmaWx0ZXJlZCA9IG1vZGVsc1xuICBpZiAoc2VhcmNoUGF0dGVybikge1xuICAgIGNvbnN0IHEgPSBzZWFyY2hQYXR0ZXJuLnRvTG93ZXJDYXNlKClcbiAgICBmaWx0ZXJlZCA9IG1vZGVscy5maWx0ZXIoKG0pID0+IGAke20ucHJvdmlkZXJ9ICR7bS5pZH0gJHttLm5hbWV9YC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKVxuICB9XG5cbiAgLy8gU29ydCBieSBuYW1lIGRlc2NlbmRpbmcgKG5ld2VzdCBmaXJzdCksIHRoZW4gcHJvdmlkZXIsIHRoZW4gaWRcbiAgZmlsdGVyZWQuc29ydCgoYSwgYikgPT4ge1xuICAgIGNvbnN0IG5hbWVDbXAgPSBiLm5hbWUubG9jYWxlQ29tcGFyZShhLm5hbWUpXG4gICAgaWYgKG5hbWVDbXAgIT09IDApIHJldHVybiBuYW1lQ21wXG4gICAgY29uc3QgcHJvdkNtcCA9IGEucHJvdmlkZXIubG9jYWxlQ29tcGFyZShiLnByb3ZpZGVyKVxuICAgIGlmIChwcm92Q21wICE9PSAwKSByZXR1cm4gcHJvdkNtcFxuICAgIHJldHVybiBhLmlkLmxvY2FsZUNvbXBhcmUoYi5pZClcbiAgfSlcblxuICBjb25zdCBmbXQgPSAobjogbnVtYmVyKSA9PiBuID49IDFfMDAwXzAwMCA/IGAke24gLyAxXzAwMF8wMDB9TWAgOiBuID49IDFfMDAwID8gYCR7biAvIDFfMDAwfUtgIDogYCR7bn1gXG4gIGNvbnN0IHJvd3MgPSBmaWx0ZXJlZC5tYXAoKG0pID0+IFtcbiAgICBtLnByb3ZpZGVyLFxuICAgIG0uaWQsXG4gICAgbS5uYW1lLFxuICAgIGZtdChtLmNvbnRleHRXaW5kb3cpLFxuICAgIGZtdChtLm1heFRva2VucyksXG4gICAgbS5yZWFzb25pbmcgPyAneWVzJyA6ICdubycsXG4gIF0pXG4gIGNvbnN0IGhkcnMgPSBbJ3Byb3ZpZGVyJywgJ21vZGVsJywgJ25hbWUnLCAnY29udGV4dCcsICdtYXgtb3V0JywgJ3RoaW5raW5nJ11cbiAgY29uc3Qgd2lkdGhzID0gaGRycy5tYXAoKGgsIGkpID0+IE1hdGgubWF4KGgubGVuZ3RoLCAuLi5yb3dzLm1hcCgocikgPT4gcltpXS5sZW5ndGgpKSlcbiAgY29uc3QgcGFkID0gKHM6IHN0cmluZywgdzogbnVtYmVyKSA9PiBzLnBhZEVuZCh3KVxuICBjb25zb2xlLmxvZyhoZHJzLm1hcCgoaCwgaSkgPT4gcGFkKGgsIHdpZHRoc1tpXSkpLmpvaW4oJyAgJykpXG4gIGZvciAoY29uc3Qgcm93IG9mIHJvd3MpIHtcbiAgICBjb25zb2xlLmxvZyhyb3cubWFwKChjLCBpKSA9PiBwYWQoYywgd2lkdGhzW2ldKSkuam9pbignICAnKSlcbiAgfVxuICBwcm9jZXNzLmV4aXQoMClcbn1cblxuLy8gR1NEIGFsd2F5cyB1c2VzIHF1aWV0IHN0YXJ0dXAgXHUyMDE0IHRoZSBnc2QgZXh0ZW5zaW9uIHJlbmRlcnMgaXRzIG93biBicmFuZGVkIGhlYWRlclxuaWYgKCFzZXR0aW5nc01hbmFnZXIuZ2V0UXVpZXRTdGFydHVwKCkpIHtcbiAgc2V0dGluZ3NNYW5hZ2VyLnNldFF1aWV0U3RhcnR1cCh0cnVlKVxufVxuXG4vLyBDb2xsYXBzZSBjaGFuZ2Vsb2cgYnkgZGVmYXVsdCBcdTIwMTQgYXZvaWQgd2FsbCBvZiB0ZXh0IG9uIHVwZGF0ZXNcbmlmICghc2V0dGluZ3NNYW5hZ2VyLmdldENvbGxhcHNlQ2hhbmdlbG9nKCkpIHtcbiAgc2V0dGluZ3NNYW5hZ2VyLnNldENvbGxhcHNlQ2hhbmdlbG9nKHRydWUpXG59XG5tYXJrU3RhcnR1cCgnc3RhcnR1cFNldHRpbmdzJylcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQcmludCAvIHN1YmFnZW50IG1vZGUgXHUyMDE0IHNpbmdsZS1zaG90IGV4ZWN1dGlvbiwgbm8gVFRZIHJlcXVpcmVkXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmlmIChpc1ByaW50TW9kZSkge1xuICBhd2FpdCBlbnN1cmVSdGtCb290c3RyYXAoKVxuICBjb25zdCBzZXNzaW9uTWFuYWdlciA9IGNsaUZsYWdzLm5vU2Vzc2lvblxuICAgID8gU2Vzc2lvbk1hbmFnZXIuaW5NZW1vcnkoKVxuICAgIDogU2Vzc2lvbk1hbmFnZXIuY3JlYXRlKHByb2Nlc3MuY3dkKCkpXG5cbiAgLy8gUmVhZCAtLWFwcGVuZC1zeXN0ZW0tcHJvbXB0IGZpbGUgY29udGVudCAoc3ViYWdlbnQgd3JpdGVzIGFnZW50IHN5c3RlbSBwcm9tcHRzIHRvIHRlbXAgZmlsZXMpXG4gIGxldCBhcHBlbmRTeXN0ZW1Qcm9tcHQ6IHN0cmluZyB8IHVuZGVmaW5lZFxuICBpZiAoY2xpRmxhZ3MuYXBwZW5kU3lzdGVtUHJvbXB0KSB7XG4gICAgdHJ5IHtcbiAgICAgIGFwcGVuZFN5c3RlbVByb21wdCA9IHJlYWRGaWxlU3luYyhjbGlGbGFncy5hcHBlbmRTeXN0ZW1Qcm9tcHQsICd1dGYtOCcpXG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBJZiBpdCdzIG5vdCBhIGZpbGUgcGF0aCwgdHJlYXQgaXQgYXMgbGl0ZXJhbCB0ZXh0XG4gICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHQgPSBjbGlGbGFncy5hcHBlbmRTeXN0ZW1Qcm9tcHRcbiAgICB9XG4gIH1cblxuICBleGl0SWZNYW5hZ2VkUmVzb3VyY2VzQXJlTmV3ZXIoYWdlbnREaXIpXG4gIGluaXRSZXNvdXJjZXMoYWdlbnREaXIpXG4gIG1hcmtTdGFydHVwKCdpbml0UmVzb3VyY2VzJylcbiAgY29uc3QgcmVzb3VyY2VMb2FkZXIgPSBuZXcgRGVmYXVsdFJlc291cmNlTG9hZGVyKHtcbiAgICBhZ2VudERpcixcbiAgICBhZGRpdGlvbmFsRXh0ZW5zaW9uUGF0aHM6IGNsaUZsYWdzLmV4dGVuc2lvbnMubGVuZ3RoID4gMCA/IGNsaUZsYWdzLmV4dGVuc2lvbnMgOiB1bmRlZmluZWQsXG4gICAgYXBwZW5kU3lzdGVtUHJvbXB0LFxuICB9KVxuICBhd2FpdCByZXNvdXJjZUxvYWRlci5yZWxvYWQoKVxuICBtYXJrU3RhcnR1cCgncmVzb3VyY2VMb2FkZXIucmVsb2FkJylcbiAgZmx1c2hQZW5kaW5nUHJvdmlkZXJSZWdpc3RyYXRpb25zKHJlc291cmNlTG9hZGVyLCBtb2RlbFJlZ2lzdHJ5KVxuICBtaWdyYXRlQW50aHJvcGljRGVmYXVsdFRvQ2xhdWRlQ29kZSh7XG4gICAgYXV0aFN0b3JhZ2UsXG4gICAgaXNDbGF1ZGVDb2RlUmVhZHk6ICgpID0+IG1vZGVsUmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeSgnY2xhdWRlLWNvZGUnKSxcbiAgICBzZXR0aW5nc01hbmFnZXIsXG4gICAgbW9kZWxSZWdpc3RyeSxcbiAgfSlcblxuICBjb25zdCB7IHNlc3Npb24sIGV4dGVuc2lvbnNSZXN1bHQsIG1vZGVsRmFsbGJhY2tNZXNzYWdlIH0gPSBhd2FpdCBjcmVhdGVBZ2VudFNlc3Npb24oe1xuICAgIGF1dGhTdG9yYWdlLFxuICAgIG1vZGVsUmVnaXN0cnksXG4gICAgc2V0dGluZ3NNYW5hZ2VyLFxuICAgIHNlc3Npb25NYW5hZ2VyLFxuICAgIHJlc291cmNlTG9hZGVyLFxuICAgIGlzQ2xhdWRlQ29kZVJlYWR5OiAoKSA9PiBtb2RlbFJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkoJ2NsYXVkZS1jb2RlJyksXG4gIH0pXG4gIG1hcmtTdGFydHVwKCdjcmVhdGVBZ2VudFNlc3Npb24nKVxuXG4gIC8vIFZhbGlkYXRlIGNvbmZpZ3VyZWQgbW9kZWwgQUZURVIgZXh0ZW5zaW9ucyBoYXZlIHJlZ2lzdGVyZWQgdGhlaXIgbW9kZWxzICgjMjYyNikuXG4gIC8vIEJlZm9yZSB0aGlzLCBleHRlbnNpb24tcHJvdmlkZWQgbW9kZWxzIChlLmcuIGNsYXVkZS1jb2RlLyopIHdlcmUgbm90IHlldCBpbiB0aGVcbiAgLy8gcmVnaXN0cnksIGNhdXNpbmcgdGhlIHVzZXIncyB2YWxpZCBjaG9pY2UgdG8gYmUgc2lsZW50bHkgb3ZlcndyaXR0ZW4uXG4gIHZhbGlkYXRlQ29uZmlndXJlZE1vZGVsKG1vZGVsUmVnaXN0cnksIHNldHRpbmdzTWFuYWdlcilcbiAgYXdhaXQgcmVhcHBseVZhbGlkYXRlZE1vZGVsT25GYWxsYmFjayhzZXNzaW9uLCBtb2RlbFJlZ2lzdHJ5LCBzZXR0aW5nc01hbmFnZXIsIG1vZGVsRmFsbGJhY2tNZXNzYWdlKVxuICBwcmludEV4dGVuc2lvbkVycm9ycyhleHRlbnNpb25zUmVzdWx0LmVycm9ycylcbiAgcHJpbnRFeHRlbnNpb25XYXJuaW5ncyhleHRlbnNpb25zUmVzdWx0Lndhcm5pbmdzKVxuXG4gIC8vIEFwcGx5IC0tbW9kZWwgb3ZlcnJpZGUgaWYgc3BlY2lmaWVkXG4gIGlmIChjbGlGbGFncy5tb2RlbCkge1xuICAgIGNvbnN0IGF2YWlsYWJsZSA9IG1vZGVsUmVnaXN0cnkuZ2V0QXZhaWxhYmxlKClcbiAgICBjb25zdCBtYXRjaCA9XG4gICAgICBhdmFpbGFibGUuZmluZCgobSkgPT4gbS5pZCA9PT0gY2xpRmxhZ3MubW9kZWwpIHx8XG4gICAgICBhdmFpbGFibGUuZmluZCgobSkgPT4gYCR7bS5wcm92aWRlcn0vJHttLmlkfWAgPT09IGNsaUZsYWdzLm1vZGVsKVxuICAgIGlmIChtYXRjaCkge1xuICAgICAgc2Vzc2lvbi5zZXRNb2RlbChtYXRjaClcbiAgICB9XG4gIH1cblxuICBjb25zdCBtb2RlID0gY2xpRmxhZ3MubW9kZSB8fCAndGV4dCdcblxuICBpZiAobW9kZSA9PT0gJ3JwYycpIHtcbiAgICBwcmludFN0YXJ0dXBUaW1pbmdzKClcbiAgICBhd2FpdCBydW5ScGNNb2RlKHNlc3Npb24pXG4gICAgcHJvY2Vzcy5leGl0KDApXG4gIH1cblxuICBpZiAobW9kZSA9PT0gJ21jcCcpIHtcbiAgICBwcmludFN0YXJ0dXBUaW1pbmdzKClcbiAgICBjb25zdCB7IHN0YXJ0TWNwU2VydmVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vbWNwLXNlcnZlci5qcycpXG5cbiAgICAvLyBBY3RpdmF0ZSBldmVyeSByZWdpc3RlcmVkIHRvb2wgYmVmb3JlIHN0YXJ0aW5nIHRoZSBNQ1AgdHJhbnNwb3J0LlxuICAgIC8vIGBzZXNzaW9uLmFnZW50LnN0YXRlLnRvb2xzYCBpcyB0aGUgKmFjdGl2ZSogc3Vic2V0LCBub3QgdGhlIGZ1bGxcbiAgICAvLyByZWdpc3RyeSBcdTIwMTQgaWYgd2UgZXhwb3NlIG9ubHkgdGhlIGFjdGl2ZSBzZXQsIGV4dGVuc2lvbi1yZWdpc3RlcmVkXG4gICAgLy8gdG9vbHMgKGdzZCB3b3JrZmxvdywgYnJvd3Nlci10b29scywgbWFjLXRvb2xzLCBzZWFyY2gtdGhlLXdlYiwgXHUyMDI2KVxuICAgIC8vIGFyZSBpbnZpc2libGUgdG8gTUNQIGNsaWVudHMuIEZsaXBwaW5nIHRoZSBhY3RpdmUgc2V0IHRvIGV2ZXJ5XG4gICAgLy8ga25vd24gdG9vbCBuYW1lIG1ha2VzIGBzdGF0ZS50b29sc2AgbWlycm9yIHRoZSBmdWxsIHJlZ2lzdHJ5IGZvclxuICAgIC8vIHRoaXMgTUNQIHNlc3Npb24sIHdoaWNoIGlzIHdoYXQgYW4gZXh0ZXJuYWwgY2xpZW50IGV4cGVjdHMuXG4gICAgY29uc3QgYWxsVG9vbE5hbWVzID0gc2Vzc2lvbi5nZXRBbGxUb29scygpLm1hcCgodCkgPT4gdC5uYW1lKVxuICAgIHNlc3Npb24uc2V0QWN0aXZlVG9vbHNCeU5hbWUoYWxsVG9vbE5hbWVzKVxuXG4gICAgYXdhaXQgc3RhcnRNY3BTZXJ2ZXIoe1xuICAgICAgdG9vbHM6IHNlc3Npb24uYWdlbnQuc3RhdGUudG9vbHMgPz8gW10sXG4gICAgICB2ZXJzaW9uOiBwcm9jZXNzLmVudi5HU0RfVkVSU0lPTiB8fCAnMC4wLjAnLFxuICAgIH0pXG4gICAgLy8gTUNQIHNlcnZlciBydW5zIHVudGlsIHRoZSB0cmFuc3BvcnQgY2xvc2VzOyBrZWVwIGFsaXZlXG4gICAgYXdhaXQgbmV3IFByb21pc2UoKCkgPT4ge30pXG4gIH1cblxuICBwcmludFN0YXJ0dXBUaW1pbmdzKClcbiAgYXdhaXQgcnVuUHJpbnRNb2RlKHNlc3Npb24sIHtcbiAgICBtb2RlOiBtb2RlIGFzICd0ZXh0JyB8ICdqc29uJyxcbiAgICBtZXNzYWdlczogY2xpRmxhZ3MubWVzc2FnZXMsXG4gIH0pXG4gIHByb2Nlc3MuZXhpdCgwKVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFdvcmt0cmVlIGZsYWcgKC13KSBcdTIwMTQgY3JlYXRlL3Jlc3VtZSBhIHdvcmt0cmVlIGZvciB0aGUgaW50ZXJhY3RpdmUgc2Vzc2lvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5pZiAoY2xpRmxhZ3Mud29ya3RyZWUpIHtcbiAgY29uc3QgeyBoYW5kbGVXb3JrdHJlZUZsYWcgfSA9IGF3YWl0IGltcG9ydCgnLi93b3JrdHJlZS1jbGkuanMnKVxuICBhd2FpdCBoYW5kbGVXb3JrdHJlZUZsYWcoY2xpRmxhZ3Mud29ya3RyZWUpXG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQWN0aXZlIHdvcmt0cmVlIGJhbm5lciBcdTIwMTQgcmVtaW5kIHVzZXIgb2YgdW5tZXJnZWQgd29ya3RyZWVzIG9uIG5vcm1hbCBsYXVuY2hcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuaWYgKCFjbGlGbGFncy53b3JrdHJlZSAmJiAhaXNQcmludE1vZGUpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHNob3dXb3JrdHJlZVN0YXR1c0Jhbm5lciB9ID0gYXdhaXQgaW1wb3J0KCcuL3dvcmt0cmVlLXN0YXR1cy1iYW5uZXIuanMnKVxuICAgIHNob3dXb3JrdHJlZVN0YXR1c0Jhbm5lcihwcm9jZXNzLmN3ZCgpKVxuICB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cbn1cbm1hcmtTdGFydHVwKCd3b3JrdHJlZVN0YXR1c0Jhbm5lcicpXG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gSW50ZXJhY3RpdmUgbW9kZSBcdTIwMTQgbm9ybWFsIFRUWSBzZXNzaW9uXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuYXdhaXQgZW5zdXJlUnRrQm9vdHN0cmFwKClcblxuLy8gUGVyLWRpcmVjdG9yeSBzZXNzaW9uIHN0b3JhZ2UgXHUyMDE0IHNhbWUgZW5jb2RpbmcgYXMgdGhlIHVwc3RyZWFtIFNESyBzbyB0aGF0XG4vLyAvcmVzdW1lIG9ubHkgc2hvd3Mgc2Vzc2lvbnMgZnJvbSB0aGUgY3VycmVudCB3b3JraW5nIGRpcmVjdG9yeS5cbmNvbnN0IGN3ZCA9IHByb2Nlc3MuY3dkKClcbmNvbnN0IHByb2plY3RTZXNzaW9uc0RpciA9IGdldFByb2plY3RTZXNzaW9uc0Rpcihjd2QpXG5cbi8vIE1pZ3JhdGUgbGVnYWN5IGZsYXQgc2Vzc2lvbnM6IGJlZm9yZSBwZXItZGlyZWN0b3J5IHNjb3BpbmcsIGFsbCAuanNvbmwgc2Vzc2lvblxuLy8gZmlsZXMgbGl2ZWQgZGlyZWN0bHkgaW4gfi8uZ3NkL3Nlc3Npb25zLy4gTW92ZSB0aGVtIGludG8gdGhlIGNvcnJlY3QgcGVyLWN3ZFxuLy8gc3ViZGlyZWN0b3J5IHNvIC9yZXN1bWUgY2FuIGZpbmQgdGhlbS5cbm1pZ3JhdGVMZWdhY3lGbGF0U2Vzc2lvbnMoc2Vzc2lvbnNEaXIsIHByb2plY3RTZXNzaW9uc0RpcilcblxuY29uc3Qgc2Vzc2lvbk1hbmFnZXIgPSBjbGlGbGFncy5fc2VsZWN0ZWRTZXNzaW9uUGF0aFxuICA/IFNlc3Npb25NYW5hZ2VyLm9wZW4oY2xpRmxhZ3MuX3NlbGVjdGVkU2Vzc2lvblBhdGgsIHByb2plY3RTZXNzaW9uc0RpcilcbiAgOiBjbGlGbGFncy5jb250aW51ZVxuICAgID8gU2Vzc2lvbk1hbmFnZXIuY29udGludWVSZWNlbnQoY3dkLCBwcm9qZWN0U2Vzc2lvbnNEaXIpXG4gICAgOiBTZXNzaW9uTWFuYWdlci5jcmVhdGUoY3dkLCBwcm9qZWN0U2Vzc2lvbnNEaXIpXG5cbmV4aXRJZk1hbmFnZWRSZXNvdXJjZXNBcmVOZXdlcihhZ2VudERpcilcbmluaXRSZXNvdXJjZXMoYWdlbnREaXIpXG5tYXJrU3RhcnR1cCgnaW5pdFJlc291cmNlcycpXG5cbi8vIE92ZXJsYXAgcmVzb3VyY2UgbG9hZGluZyB3aXRoIHNlc3Npb24gbWFuYWdlciBzZXR1cCBcdTIwMTQgYm90aCBhcmUgaW5kZXBlbmRlbnQuXG4vLyByZXNvdXJjZUxvYWRlci5yZWxvYWQoKSBpcyB0aGUgbW9zdCBleHBlbnNpdmUgc3RlcCAoaml0aSBjb21waWxhdGlvbiksIHNvXG4vLyBzdGFydGluZyBpdCBlYXJseSBzaGF2ZXMgfjUwLTIwMG1zIG9mZiBpbnRlcmFjdGl2ZSBzdGFydHVwLlxuY29uc3QgcmVzb3VyY2VMb2FkZXIgPSBhd2FpdCBidWlsZFJlc291cmNlTG9hZGVyKGFnZW50RGlyLCB7XG4gIGFkZGl0aW9uYWxFeHRlbnNpb25QYXRoczogY2xpRmxhZ3MuZXh0ZW5zaW9ucy5sZW5ndGggPiAwID8gY2xpRmxhZ3MuZXh0ZW5zaW9ucyA6IHVuZGVmaW5lZCxcbn0pXG5jb25zdCByZXNvdXJjZUxvYWRQcm9taXNlID0gcmVzb3VyY2VMb2FkZXIucmVsb2FkKClcblxuLy8gV2hpbGUgcmVzb3VyY2VzIGxvYWQsIGxldCBzZXNzaW9uIG1hbmFnZXIgZmluaXNoIGFueSBhc3luYyBJL08gaXQgbmVlZHMuXG4vLyBUaGVuIGF3YWl0IHRoZSByZXNvdXJjZSBwcm9taXNlIGJlZm9yZSBjcmVhdGluZyB0aGUgYWdlbnQgc2Vzc2lvbi5cbmF3YWl0IHJlc291cmNlTG9hZFByb21pc2Vcbm1hcmtTdGFydHVwKCdyZXNvdXJjZUxvYWRlci5yZWxvYWQnKVxuZmx1c2hQZW5kaW5nUHJvdmlkZXJSZWdpc3RyYXRpb25zKHJlc291cmNlTG9hZGVyLCBtb2RlbFJlZ2lzdHJ5KVxubWlncmF0ZUFudGhyb3BpY0RlZmF1bHRUb0NsYXVkZUNvZGUoe1xuICBhdXRoU3RvcmFnZSxcbiAgaXNDbGF1ZGVDb2RlUmVhZHk6ICgpID0+IG1vZGVsUmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeSgnY2xhdWRlLWNvZGUnKSxcbiAgc2V0dGluZ3NNYW5hZ2VyLFxuICBtb2RlbFJlZ2lzdHJ5LFxufSlcbm1hcmtTdGFydHVwKCdwcm92aWRlck1pZ3JhdGlvbnMnKVxuXG5jb25zdCB7IHNlc3Npb24sIGV4dGVuc2lvbnNSZXN1bHQsIG1vZGVsRmFsbGJhY2tNZXNzYWdlOiBpbnRlcmFjdGl2ZUZhbGxiYWNrTXNnIH0gPSBhd2FpdCBjcmVhdGVBZ2VudFNlc3Npb24oe1xuICBhdXRoU3RvcmFnZSxcbiAgbW9kZWxSZWdpc3RyeSxcbiAgc2V0dGluZ3NNYW5hZ2VyLFxuICBzZXNzaW9uTWFuYWdlcixcbiAgcmVzb3VyY2VMb2FkZXIsXG4gIGlzQ2xhdWRlQ29kZVJlYWR5OiAoKSA9PiBtb2RlbFJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkoJ2NsYXVkZS1jb2RlJyksXG59KVxubWFya1N0YXJ0dXAoJ2NyZWF0ZUFnZW50U2Vzc2lvbicpXG5cbi8vIFZhbGlkYXRlIGNvbmZpZ3VyZWQgbW9kZWwgQUZURVIgZXh0ZW5zaW9ucyBoYXZlIHJlZ2lzdGVyZWQgdGhlaXIgbW9kZWxzICgjMjYyNikuXG4vLyBCZWZvcmUgdGhpcywgZXh0ZW5zaW9uLXByb3ZpZGVkIG1vZGVscyAoZS5nLiBjbGF1ZGUtY29kZS8qKSB3ZXJlIG5vdCB5ZXQgaW4gdGhlXG4vLyByZWdpc3RyeSwgY2F1c2luZyB0aGUgdXNlcidzIHZhbGlkIGNob2ljZSB0byBiZSBzaWxlbnRseSBvdmVyd3JpdHRlbi5cbnZhbGlkYXRlQ29uZmlndXJlZE1vZGVsKG1vZGVsUmVnaXN0cnksIHNldHRpbmdzTWFuYWdlcilcbmF3YWl0IHJlYXBwbHlWYWxpZGF0ZWRNb2RlbE9uRmFsbGJhY2soc2Vzc2lvbiwgbW9kZWxSZWdpc3RyeSwgc2V0dGluZ3NNYW5hZ2VyLCBpbnRlcmFjdGl2ZUZhbGxiYWNrTXNnKVxucHJpbnRFeHRlbnNpb25FcnJvcnMoZXh0ZW5zaW9uc1Jlc3VsdC5lcnJvcnMpXG5wcmludEV4dGVuc2lvbldhcm5pbmdzKGV4dGVuc2lvbnNSZXN1bHQud2FybmluZ3MpXG5cbi8vIFJlc3RvcmUgc2NvcGVkIG1vZGVscyBmcm9tIHNldHRpbmdzIG9uIHN0YXJ0dXAuXG4vLyBUaGUgdXBzdHJlYW0gSW50ZXJhY3RpdmVNb2RlIHJlYWRzIGVuYWJsZWRNb2RlbHMgZnJvbSBzZXR0aW5ncyB3aGVuIC9zY29wZWQtbW9kZWxzIGlzIG9wZW5lZCxcbi8vIGJ1dCBkb2Vzbid0IGFwcGx5IHRoZW0gdG8gdGhlIHNlc3Npb24gYXQgc3RhcnR1cCBcdTIwMTQgc28gQ3RybCtQIGN5Y2xlcyBhbGwgbW9kZWxzIGluc3RlYWQgb2Zcbi8vIGp1c3QgdGhlIHNhdmVkIHNlbGVjdGlvbiB1bnRpbCB0aGUgdXNlciByZS1ydW5zIC9zY29wZWQtbW9kZWxzLlxuY29uc3QgZW5hYmxlZE1vZGVsUGF0dGVybnMgPSBzZXR0aW5nc01hbmFnZXIuZ2V0RW5hYmxlZE1vZGVscygpXG5pZiAoZW5hYmxlZE1vZGVsUGF0dGVybnMgJiYgZW5hYmxlZE1vZGVsUGF0dGVybnMubGVuZ3RoID4gMCkge1xuICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBtb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpXG4gIGNvbnN0IHNjb3BlZE1vZGVsczogQXJyYXk8eyBtb2RlbDogKHR5cGVvZiBhdmFpbGFibGVNb2RlbHMpW251bWJlcl0gfT4gPSBbXVxuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KClcblxuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgZW5hYmxlZE1vZGVsUGF0dGVybnMpIHtcbiAgICAvLyBQYXR0ZXJucyBhcmUgXCJwcm92aWRlci9tb2RlbElkXCIgZXhhY3Qgc3RyaW5ncyBzYXZlZCBieSAvc2NvcGVkLW1vZGVsc1xuICAgIGNvbnN0IHNsYXNoSWR4ID0gcGF0dGVybi5pbmRleE9mKCcvJylcbiAgICBpZiAoc2xhc2hJZHggIT09IC0xKSB7XG4gICAgICBjb25zdCBwcm92aWRlciA9IHBhdHRlcm4uc3Vic3RyaW5nKDAsIHNsYXNoSWR4KVxuICAgICAgY29uc3QgbW9kZWxJZCA9IHBhdHRlcm4uc3Vic3RyaW5nKHNsYXNoSWR4ICsgMSlcbiAgICAgIGNvbnN0IG1vZGVsID0gYXZhaWxhYmxlTW9kZWxzLmZpbmQoKG0pID0+IG0ucHJvdmlkZXIgPT09IHByb3ZpZGVyICYmIG0uaWQgPT09IG1vZGVsSWQpXG4gICAgICBpZiAobW9kZWwpIHtcbiAgICAgICAgY29uc3Qga2V5ID0gYCR7bW9kZWwucHJvdmlkZXJ9LyR7bW9kZWwuaWR9YFxuICAgICAgICBpZiAoIXNlZW4uaGFzKGtleSkpIHtcbiAgICAgICAgICBzZWVuLmFkZChrZXkpXG4gICAgICAgICAgc2NvcGVkTW9kZWxzLnB1c2goeyBtb2RlbCB9KVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEZhbGxiYWNrOiBtYXRjaCBieSBtb2RlbCBpZCBhbG9uZVxuICAgICAgY29uc3QgbW9kZWwgPSBhdmFpbGFibGVNb2RlbHMuZmluZCgobSkgPT4gbS5pZCA9PT0gcGF0dGVybilcbiAgICAgIGlmIChtb2RlbCkge1xuICAgICAgICBjb25zdCBrZXkgPSBgJHttb2RlbC5wcm92aWRlcn0vJHttb2RlbC5pZH1gXG4gICAgICAgIGlmICghc2Vlbi5oYXMoa2V5KSkge1xuICAgICAgICAgIHNlZW4uYWRkKGtleSlcbiAgICAgICAgICBzY29wZWRNb2RlbHMucHVzaCh7IG1vZGVsIH0pXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBPbmx5IGFwcGx5IGlmIHdlIHJlc29sdmVkIHNvbWUgbW9kZWxzIGFuZCBpdCdzIGEgZ2VudWluZSBzdWJzZXRcbiAgaWYgKHNjb3BlZE1vZGVscy5sZW5ndGggPiAwICYmIHNjb3BlZE1vZGVscy5sZW5ndGggPCBhdmFpbGFibGVNb2RlbHMubGVuZ3RoKSB7XG4gICAgc2Vzc2lvbi5zZXRTY29wZWRNb2RlbHMoc2NvcGVkTW9kZWxzKVxuICB9XG59XG5cbmlmICghcHJvY2Vzcy5zdGRpbi5pc1RUWSB8fCAhcHJvY2Vzcy5zdGRvdXQuaXNUVFkpIHtcbiAgY29uc3QgbWlzc2luZyA9ICFwcm9jZXNzLnN0ZGluLmlzVFRZICYmICFwcm9jZXNzLnN0ZG91dC5pc1RUWVxuICAgID8gJ3N0ZGluIGFuZCBzdGRvdXQgYXJlJ1xuICAgIDogIXByb2Nlc3Muc3RkaW4uaXNUVFlcbiAgICAgID8gJ3N0ZGluIGlzJ1xuICAgICAgOiAnc3Rkb3V0IGlzJ1xuICBwcmludE5vblR0eUVycm9yQW5kRXhpdChtaXNzaW5nLCB0cnVlKVxufVxuXG5jb25zdCBpbnRlcmFjdGl2ZU1vZGUgPSBuZXcgSW50ZXJhY3RpdmVNb2RlKHNlc3Npb24pXG5tYXJrU3RhcnR1cCgnSW50ZXJhY3RpdmVNb2RlJylcbnByaW50U3RhcnR1cFRpbWluZ3MoKVxuYXdhaXQgaW50ZXJhY3RpdmVNb2RlLnJ1bigpXG4iXSwKICAibWFwcGluZ3MiOiAiQUFNQSxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFlB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R0FBRztBQUMzRCxRQUFNLGtCQUFrQixjQUFjLGFBQWE7QUFDbkQsUUFBTSxlQUFtRSxDQUFDO0FBQzFFLFFBQU0sT0FBTyxvQkFBSSxJQUFZO0FBRTdCLGFBQVcsV0FBVyxzQkFBc0I7QUFFMUMsVUFBTSxXQUFXLFFBQVEsUUFBUSxHQUFHO0FBQ3BDLFFBQUksYUFBYSxJQUFJO0FBQ25CLFlBQU0sV0FBVyxRQUFRLFVBQVUsR0FBRyxRQUFRO0FBQzlDLFlBQU0sVUFBVSxRQUFRLFVBQVUsV0FBVyxDQUFDO0FBQzlDLFlBQU0sUUFBUSxnQkFBZ0IsS0FBSyxDQUFDLE1BQU0sRUFBRSxhQUFhLFlBQVksRUFBRSxPQUFPLE9BQU87QUFDckYsVUFBSSxPQUFPO0FBQ1QsY0FBTSxNQUFNLEdBQUcsTUFBTSxRQUFRLElBQUksTUFBTSxFQUFFO0FBQ3pDLFlBQUksQ0FBQyxLQUFLLElBQUksR0FBRyxHQUFHO0FBQ2xCLGVBQUssSUFBSSxHQUFHO0FBQ1osdUJBQWEsS0FBSyxFQUFFLE1BQU0sQ0FBQztBQUFBLFFBQzdCO0FBQUEsTUFDRjtBQUFBLElBQ0YsT0FBTztBQUVMLFlBQU0sUUFBUSxnQkFBZ0IsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLE9BQU87QUFDMUQsVUFBSSxPQUFPO0FBQ1QsY0FBTSxNQUFNLEdBQUcsTUFBTSxRQUFRLElBQUksTUFBTSxFQUFFO0FBQ3pDLFlBQUksQ0FBQyxLQUFLLElBQUksR0FBRyxHQUFHO0FBQ2xCLGVBQUssSUFBSSxHQUFHO0FBQ1osdUJBQWEsS0FBSyxFQUFFLE1BQU0sQ0FBQztBQUFBLFFBQzdCO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBR0EsTUFBSSxhQUFhLFNBQVMsS0FBSyxhQUFhLFNBQVMsZ0JBQWdCLFFBQVE7QUFDM0UsWUFBUSxnQkFBZ0IsWUFBWTtBQUFBLEVBQ3RDO0FBQ0Y7QUFFQSxJQUFJLENBQUMsUUFBUSxNQUFNLFNBQVMsQ0FBQyxRQUFRLE9BQU8sT0FBTztBQUNqRCxRQUFNLFVBQVUsQ0FBQyxRQUFRLE1BQU0sU0FBUyxDQUFDLFFBQVEsT0FBTyxRQUNwRCx5QkFDQSxDQUFDLFFBQVEsTUFBTSxRQUNiLGFBQ0E7QUFDTiwwQkFBd0IsU0FBUyxJQUFJO0FBQ3ZDO0FBRUEsTUFBTSxrQkFBa0IsSUFBSSxnQkFBZ0IsT0FBTztBQUNuRCxZQUFZLGlCQUFpQjtBQUM3QixvQkFBb0I7QUFDcEIsTUFBTSxnQkFBZ0IsSUFBSTsiLAogICJuYW1lcyI6IFsic2Vzc2lvbiIsICJtb2RlbFJlZ2lzdHJ5IiwgInNldHRpbmdzTWFuYWdlciIsICJBdXRoU3RvcmFnZSIsICJhdXRoU3RvcmFnZSIsICJTZXNzaW9uTWFuYWdlciIsICJjd2QiLCAicHJvamVjdFNlc3Npb25zRGlyIiwgInJlc291cmNlTG9hZGVyIiwgInNlc3Npb25NYW5hZ2VyIiwgImV4dGVuc2lvbnNSZXN1bHQiXQp9Cg==
