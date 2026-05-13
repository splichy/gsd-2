import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";
import * as _bundledPiAgentCore from "@gsd/pi-agent-core";
import * as _bundledPiAi from "@gsd/pi-ai";
import * as _bundledPiAiOauth from "@gsd/pi-ai/oauth";
import * as _bundledPiTui from "@gsd/pi-tui";
import * as _bundledTypebox from "@sinclair/typebox";
import * as _bundledYaml from "yaml";
import * as _bundledMcpClient from "@modelcontextprotocol/sdk/client";
import * as _bundledMcpStdio from "@modelcontextprotocol/sdk/client/stdio.js";
import * as _bundledMcpStreamableHttp from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as _bundledMcpSse from "@modelcontextprotocol/sdk/client/sse.js";
import * as _bundledMcpServer from "@modelcontextprotocol/sdk/server";
import * as _bundledMcpServerStdio from "@modelcontextprotocol/sdk/server/stdio.js";
import * as _bundledMcpServerSse from "@modelcontextprotocol/sdk/server/sse.js";
import * as _bundledMcpServerStreamableHttp from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as _bundledMcpTypes from "@modelcontextprotocol/sdk/types.js";
import { getAgentDir, isBunBinary } from "../../config.js";
import * as _bundledPiCodingAgent from "../../index.js";
import { createEventBus } from "../event-bus.js";
import { execCommand } from "../exec.js";
import { getUntrustedExtensionPaths } from "./project-trust.js";
import { isProjectTrusted, trustProject, getUntrustedExtensionPaths as getUntrustedExtensionPaths2 } from "./project-trust.js";
import { registerToolCompatibility } from "../tools/tool-compatibility-registry.js";
import { mergeExtensionEntryPaths } from "./extension-discovery.js";
import { sortExtensionPaths } from "./extension-sort.js";
const STATIC_BUNDLED_MODULES = {
  "@sinclair/typebox": _bundledTypebox,
  "@gsd/pi-agent-core": _bundledPiAgentCore,
  "@gsd/pi-tui": _bundledPiTui,
  "@gsd/pi-ai": _bundledPiAi,
  "@gsd/pi-ai/oauth": _bundledPiAiOauth,
  "@gsd/pi-coding-agent": _bundledPiCodingAgent,
  "yaml": _bundledYaml,
  "@modelcontextprotocol/sdk/client": _bundledMcpClient,
  "@modelcontextprotocol/sdk/client/stdio": _bundledMcpStdio,
  "@modelcontextprotocol/sdk/client/stdio.js": _bundledMcpStdio,
  "@modelcontextprotocol/sdk/client/streamableHttp": _bundledMcpStreamableHttp,
  "@modelcontextprotocol/sdk/client/streamableHttp.js": _bundledMcpStreamableHttp,
  "@modelcontextprotocol/sdk/client/sse": _bundledMcpSse,
  "@modelcontextprotocol/sdk/client/sse.js": _bundledMcpSse,
  "@modelcontextprotocol/sdk/server": _bundledMcpServer,
  "@modelcontextprotocol/sdk/server/stdio": _bundledMcpServerStdio,
  "@modelcontextprotocol/sdk/server/stdio.js": _bundledMcpServerStdio,
  "@modelcontextprotocol/sdk/server/sse": _bundledMcpServerSse,
  "@modelcontextprotocol/sdk/server/sse.js": _bundledMcpServerSse,
  "@modelcontextprotocol/sdk/server/streamableHttp": _bundledMcpServerStreamableHttp,
  "@modelcontextprotocol/sdk/server/streamableHttp.js": _bundledMcpServerStreamableHttp,
  "@modelcontextprotocol/sdk/types": _bundledMcpTypes,
  "@modelcontextprotocol/sdk/types.js": _bundledMcpTypes,
  // Aliases for external PI ecosystem packages that import from the original scope
  "@mariozechner/pi-agent-core": _bundledPiAgentCore,
  "@mariozechner/pi-tui": _bundledPiTui,
  "@mariozechner/pi-ai": _bundledPiAi,
  "@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
  "@mariozechner/pi-coding-agent": _bundledPiCodingAgent
};
const VIRTUAL_MODULES = { ...STATIC_BUNDLED_MODULES };
const require2 = createRequire(import.meta.url);
const EXTENSION_TIMING_ENABLED = process.env.GSD_STARTUP_TIMING === "1" || process.env.PI_TIMING === "1";
const BUNDLED_PACKAGES_WITH_EXPORTS = [
  "@modelcontextprotocol/sdk",
  "yaml"
];
function resolveSubpathExports(packageName) {
  const aliases = {};
  let packageJsonPath;
  try {
    packageJsonPath = require2.resolve(`${packageName}/package.json`);
  } catch {
    try {
      const anyEntry = require2.resolve(packageName);
      let dir = path.dirname(anyEntry);
      while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, "package.json");
        if (fs.existsSync(candidate)) {
          try {
            const pkg2 = JSON.parse(fs.readFileSync(candidate, "utf-8"));
            if (pkg2.name === packageName) {
              packageJsonPath = candidate;
              break;
            }
          } catch {
          }
        }
        dir = path.dirname(dir);
      }
    } catch {
      return aliases;
    }
    if (!packageJsonPath) return aliases;
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return aliases;
  }
  const exports = pkg.exports;
  if (!exports || typeof exports !== "object") return aliases;
  const packageDir = path.dirname(packageJsonPath);
  for (const [subpath, target] of Object.entries(exports)) {
    if (subpath === ".") continue;
    if (subpath.includes("*")) {
      resolveWildcardExports(packageName, packageDir, subpath, target, aliases);
      continue;
    }
    const specifier = `${packageName}/${subpath.replace(/^\.\//, "")}`;
    try {
      const resolved = require2.resolve(specifier);
      aliases[specifier] = resolved;
      if (!specifier.endsWith(".js")) {
        const jsSpecifier = `${specifier}.js`;
        try {
          const jsResolved = require2.resolve(jsSpecifier);
          aliases[jsSpecifier] = jsResolved;
        } catch {
        }
      }
      if (specifier.endsWith(".js")) {
        const bareSpecifier = specifier.slice(0, -3);
        try {
          const bareResolved = require2.resolve(bareSpecifier);
          aliases[bareSpecifier] = bareResolved;
        } catch {
        }
      }
    } catch {
    }
  }
  return aliases;
}
function resolveWildcardExports(packageName, packageDir, subpathPattern, target, aliases) {
  let targetDir = null;
  if (typeof target === "string") {
    targetDir = target.replace(/\/\*$/, "").replace(/^\.\//, "");
  } else if (target && typeof target === "object") {
    const targetObj = target;
    const resolved = targetObj.require ?? targetObj.import ?? targetObj.default;
    if (typeof resolved === "string") {
      targetDir = resolved.replace(/\/\*$/, "").replace(/^\.\//, "");
    }
  }
  if (!targetDir) return;
  const fullTargetDir = path.join(packageDir, targetDir);
  if (!fs.existsSync(fullTargetDir)) return;
  const subpathPrefix = subpathPattern.replace(/\/?\*$/, "").replace(/^\.\//, "");
  scanDirForExports(packageName, fullTargetDir, subpathPrefix, aliases);
}
function scanDirForExports(packageName, dir, relativePath, aliases) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "examples" || entry.name === "__tests__" || entry.name === "test") continue;
      scanDirForExports(packageName, path.join(dir, entry.name), entryRelative, aliases);
    } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".d.js")) {
      const filePath = path.join(dir, entry.name);
      const specifier = `${packageName}/${entryRelative}`;
      if (!(specifier in aliases)) {
        aliases[specifier] = filePath;
      }
      const bareSpecifier = specifier.replace(/\.js$/, "");
      if (!(bareSpecifier in aliases)) {
        aliases[bareSpecifier] = filePath;
      }
    }
  }
}
function logExtensionTiming(extensionPath, ms, outcome) {
  if (!EXTENSION_TIMING_ENABLED) return;
  console.error(`[startup] extension ${outcome}: ${extensionPath} (${ms}ms)`);
}
let _aliases = null;
function getAliases() {
  if (_aliases) return _aliases;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const packageIndex = path.resolve(__dirname, "../..", "index.js");
  const typeboxEntry = require2.resolve("@sinclair/typebox");
  const typeboxRoot = typeboxEntry.replace(/[\\/]build[\\/]cjs[\\/]index\.js$/, "");
  const yamlEntry = require2.resolve("yaml");
  const yamlRoot = yamlEntry.replace(/[\\/]dist[\\/]index\.js$/, "");
  const packagesRoot = path.resolve(__dirname, "../../../../");
  const resolveWorkspaceOrImport = (workspaceRelativePath, specifier) => {
    const workspacePath = path.join(packagesRoot, workspaceRelativePath);
    if (fs.existsSync(workspacePath)) {
      return workspacePath;
    }
    return fileURLToPath(import.meta.resolve(specifier));
  };
  const autoDiscovered = {};
  for (const packageName of BUNDLED_PACKAGES_WITH_EXPORTS) {
    const subpathAliases = resolveSubpathExports(packageName);
    Object.assign(autoDiscovered, subpathAliases);
  }
  _aliases = {
    // Auto-discovered subpath exports (lowest priority — overridden by manual entries below)
    ...autoDiscovered,
    // Manual entries for workspace packages and packages needing special resolution
    "@gsd/pi-coding-agent": packageIndex,
    "@gsd/pi-agent-core": resolveWorkspaceOrImport("agent/dist/index.js", "@gsd/pi-agent-core"),
    "@gsd/pi-tui": resolveWorkspaceOrImport("tui/dist/index.js", "@gsd/pi-tui"),
    "@gsd/pi-ai": resolveWorkspaceOrImport("ai/dist/index.js", "@gsd/pi-ai"),
    "@gsd/pi-ai/oauth": resolveWorkspaceOrImport("ai/dist/oauth.js", "@gsd/pi-ai/oauth"),
    "@sinclair/typebox": typeboxRoot,
    "yaml": yamlRoot,
    // Aliases for external PI ecosystem packages that import from the original scope
    "@mariozechner/pi-coding-agent": packageIndex,
    "@mariozechner/pi-agent-core": resolveWorkspaceOrImport("agent/dist/index.js", "@gsd/pi-agent-core"),
    "@mariozechner/pi-tui": resolveWorkspaceOrImport("tui/dist/index.js", "@gsd/pi-tui"),
    "@mariozechner/pi-ai": resolveWorkspaceOrImport("ai/dist/index.js", "@gsd/pi-ai"),
    "@mariozechner/pi-ai/oauth": resolveWorkspaceOrImport("ai/dist/oauth.js", "@gsd/pi-ai/oauth")
  };
  return _aliases;
}
function getJitiOptions() {
  return isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() };
}
const _moduleImporters = /* @__PURE__ */ new Map();
function getModuleImporter(parentModuleUrl) {
  let importer = _moduleImporters.get(parentModuleUrl);
  if (!importer) {
    importer = createJiti(parentModuleUrl, {
      moduleCache: true,
      ...getJitiOptions()
    });
    _moduleImporters.set(parentModuleUrl, importer);
  }
  return importer;
}
async function importExtensionModule(parentModuleUrl, specifier) {
  const importer = getModuleImporter(parentModuleUrl);
  const resolvedPath = fileURLToPath(new URL(specifier, parentModuleUrl));
  return importer.import(resolvedPath);
}
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
function normalizeUnicodeSpaces(str) {
  return str.replace(UNICODE_SPACES, " ");
}
function expandPath(p) {
  const normalized = normalizeUnicodeSpaces(p);
  if (normalized.startsWith("~/")) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("~")) {
    return path.join(os.homedir(), normalized.slice(1));
  }
  return normalized;
}
function resolvePath(extPath, cwd) {
  const expanded = expandPath(extPath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}
function createExtensionRuntime() {
  const notInitialized = () => {
    throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
  };
  const runtime = {
    sendMessage: notInitialized,
    sendUserMessage: notInitialized,
    retryLastTurn: notInitialized,
    appendEntry: notInitialized,
    setSessionName: notInitialized,
    getSessionName: notInitialized,
    setLabel: notInitialized,
    getActiveTools: notInitialized,
    getAllTools: notInitialized,
    setActiveTools: notInitialized,
    getVisibleSkills: notInitialized,
    setVisibleSkills: notInitialized,
    // registerTool() is valid during extension load; refresh is only needed post-bind.
    refreshTools: () => {
    },
    getCommands: notInitialized,
    setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
    getThinkingLevel: notInitialized,
    setThinkingLevel: notInitialized,
    flagValues: /* @__PURE__ */ new Map(),
    pendingProviderRegistrations: [],
    // Pre-bind: queue registrations so bindCore() can flush them once the
    // model registry is available. bindCore() replaces both with direct calls.
    registerProvider: (name, config) => {
      runtime.pendingProviderRegistrations.push({ name, config });
    },
    unregisterProvider: (name) => {
      runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
    },
    // Stubs replaced by ExtensionRunner at construction time via bindEmitMethods().
    emitBeforeModelSelect: async () => void 0,
    emitAdjustToolSet: async () => void 0,
    emitExtensionEvent: async () => void 0
  };
  return runtime;
}
function createExtensionAPI(extension, runtime, cwd, eventBus) {
  const api = {
    // Registration methods - write to extension
    on(event, handler) {
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },
    registerTool(tool) {
      extension.tools.set(tool.name, {
        definition: tool,
        extensionPath: extension.path
      });
      if (tool.compatibility) {
        registerToolCompatibility(tool.name, tool.compatibility);
      }
      runtime.refreshTools();
    },
    registerCommand(name, options) {
      extension.commands.set(name, { name, ...options });
    },
    registerBeforeInstall(handler) {
      extension.lifecycleHooks.beforeInstall.push(handler);
    },
    registerAfterInstall(handler) {
      extension.lifecycleHooks.afterInstall.push(handler);
    },
    registerBeforeRemove(handler) {
      extension.lifecycleHooks.beforeRemove.push(handler);
    },
    registerAfterRemove(handler) {
      extension.lifecycleHooks.afterRemove.push(handler);
    },
    registerShortcut(shortcut, options) {
      extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
    },
    registerFlag(name, options) {
      extension.flags.set(name, { name, extensionPath: extension.path, ...options });
      if (options.default !== void 0 && !runtime.flagValues.has(name)) {
        runtime.flagValues.set(name, options.default);
      }
    },
    registerMessageRenderer(customType, renderer) {
      extension.messageRenderers.set(customType, renderer);
    },
    // Flag access - checks extension registered it, reads from runtime
    getFlag(name) {
      if (!extension.flags.has(name)) return void 0;
      return runtime.flagValues.get(name);
    },
    // Action methods - delegate to shared runtime
    sendMessage(message, options) {
      runtime.sendMessage(message, options);
    },
    sendUserMessage(content, options) {
      runtime.sendUserMessage(content, options);
    },
    retryLastTurn() {
      runtime.retryLastTurn();
    },
    appendEntry(customType, data) {
      runtime.appendEntry(customType, data);
    },
    setSessionName(name) {
      runtime.setSessionName(name);
    },
    getSessionName() {
      return runtime.getSessionName();
    },
    setLabel(entryId, label) {
      runtime.setLabel(entryId, label);
    },
    exec(command, args, options) {
      return execCommand(command, args, options?.cwd ?? cwd, options);
    },
    getActiveTools() {
      return runtime.getActiveTools();
    },
    getAllTools() {
      return runtime.getAllTools();
    },
    setActiveTools(toolNames) {
      runtime.setActiveTools(toolNames);
    },
    getVisibleSkills() {
      return runtime.getVisibleSkills();
    },
    setVisibleSkills(skillNames) {
      runtime.setVisibleSkills(skillNames);
    },
    getCommands() {
      return runtime.getCommands();
    },
    setModel(model) {
      return runtime.setModel(model);
    },
    getThinkingLevel() {
      return runtime.getThinkingLevel();
    },
    setThinkingLevel(level) {
      runtime.setThinkingLevel(level);
    },
    registerProvider(name, config) {
      runtime.registerProvider(name, config);
    },
    unregisterProvider(name) {
      runtime.unregisterProvider(name);
    },
    async emitBeforeModelSelect(event) {
      return runtime.emitBeforeModelSelect(event);
    },
    async emitAdjustToolSet(event) {
      return runtime.emitAdjustToolSet(event);
    },
    async emitExtensionEvent(event) {
      return runtime.emitExtensionEvent(event);
    },
    events: eventBus
  };
  return api;
}
const TS_SYNTAX_PATTERNS = [
  // Variable type annotations: const name: string, let count: number
  /\b(?:const|let|var)\s+\w+\s*:\s*(?:string|number|boolean|any|void|never|unknown|object|bigint|symbol|undefined|null)\b/,
  // Parameter type annotations: (api: ExtensionAPI)
  /\(\s*\w+\s*:\s*[A-Z]\w*/,
  // Return type annotations: ): Promise<void> {  or  ): string =>
  /\)\s*:\s*(?:Promise|string|number|boolean|void|any|never|unknown)\b/,
  // Interface declarations
  /\binterface\s+[A-Z]\w*\s*(?:<[^>]*>)?\s*\{/,
  // Type alias declarations
  /\btype\s+[A-Z]\w*\s*(?:<[^>]*>)?\s*=/,
  // Angle-bracket type assertions: <Type>value
  /(?:as\s+\w+(?:<[^>]*>)?)\s*[;,)\]}]/,
  // Generic type parameters on functions: function foo<T>
  /\bfunction\s+\w+\s*<[^>]+>/,
  // Enum declarations
  /\benum\s+[A-Z]\w*\s*\{/
];
function containsTypeScriptSyntax(source) {
  return TS_SYNTAX_PATTERNS.some((pattern) => pattern.test(source));
}
let _extensionLoaderJiti = null;
const _loadedExtensionPaths = /* @__PURE__ */ new Set();
const _extensionRequire = createRequire(import.meta.url);
function resetExtensionLoaderCache() {
  _extensionLoaderJiti = null;
  const exact = /* @__PURE__ */ new Set();
  const signatures = /* @__PURE__ */ new Set();
  const makeSignature = (p) => {
    const normalized = p.replace(/\\/g, "/").toLowerCase();
    const slash = normalized.lastIndexOf("/");
    const base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const parent = slash >= 0 ? normalized.slice(0, slash) : "";
    const parentSlash = parent.lastIndexOf("/");
    const parentSeg = parentSlash >= 0 ? parent.slice(parentSlash + 1) : parent;
    return `${parentSeg}/${base}`;
  };
  for (const raw of _loadedExtensionPaths) {
    exact.add(raw);
    try {
      exact.add(_extensionRequire.resolve(raw));
    } catch {
    }
    try {
      exact.add(fs.realpathSync(raw));
    } catch {
    }
    signatures.add(makeSignature(raw));
  }
  for (const key of Object.keys(_extensionRequire.cache)) {
    if (exact.has(key) || signatures.has(makeSignature(key))) {
      try {
        delete _extensionRequire.cache[key];
      } catch {
      }
    }
  }
  _loadedExtensionPaths.clear();
}
function getExtensionLoaderJiti() {
  if (!_extensionLoaderJiti) {
    _extensionLoaderJiti = createJiti(import.meta.url, {
      moduleCache: true,
      ...getJitiOptions()
    });
  }
  return _extensionLoaderJiti;
}
async function loadExtensionModule(extensionPath) {
  if (extensionPath.endsWith(".ts")) {
    const jsPath = extensionPath.replace(/\.ts$/, ".js");
    try {
      const [tsStat, jsStat] = [fs.statSync(extensionPath), fs.statSync(jsPath)];
      if (jsStat.mtimeMs >= tsStat.mtimeMs) {
        const module2 = await import(jsPath);
        const factory2 = module2.default ?? module2;
        return typeof factory2 !== "function" ? void 0 : factory2;
      }
    } catch {
    }
  }
  const jiti = getExtensionLoaderJiti();
  const module = await jiti.import(extensionPath, { default: true });
  _loadedExtensionPaths.add(extensionPath);
  const factory = module;
  return typeof factory !== "function" ? void 0 : factory;
}
function isNonExtensionLibrary(resolvedPath) {
  let dir = path.dirname(resolvedPath);
  const root = path.parse(dir).root;
  while (dir !== root) {
    const packageJsonPath = path.join(dir, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const content = fs.readFileSync(packageJsonPath, "utf-8");
        const pkg = JSON.parse(content);
        if (pkg.pi && typeof pkg.pi === "object") {
          const extensions = pkg.pi.extensions;
          if (!Array.isArray(extensions) || extensions.length === 0) {
            return true;
          }
        }
      } catch {
      }
      break;
    }
    dir = path.dirname(dir);
  }
  return false;
}
function createExtension(extensionPath, resolvedPath) {
  return {
    path: extensionPath,
    resolvedPath,
    handlers: /* @__PURE__ */ new Map(),
    tools: /* @__PURE__ */ new Map(),
    messageRenderers: /* @__PURE__ */ new Map(),
    commands: /* @__PURE__ */ new Map(),
    flags: /* @__PURE__ */ new Map(),
    shortcuts: /* @__PURE__ */ new Map(),
    lifecycleHooks: {
      beforeInstall: [],
      afterInstall: [],
      beforeRemove: [],
      afterRemove: []
    }
  };
}
async function loadExtension(extensionPath, cwd, eventBus, runtime) {
  const resolvedPath = resolvePath(extensionPath, cwd);
  const start = Date.now();
  try {
    const factory = await loadExtensionModule(resolvedPath);
    if (!factory) {
      if (isNonExtensionLibrary(resolvedPath)) {
        return { extension: null, error: null };
      }
      logExtensionTiming(extensionPath, Date.now() - start, "failed");
      if (resolvedPath.endsWith(".js")) {
        try {
          const source = fs.readFileSync(resolvedPath, "utf-8");
          if (containsTypeScriptSyntax(source)) {
            return {
              extension: null,
              error: `Extension file "${extensionPath}" appears to contain TypeScript syntax but has a .js extension. Rename it to .ts so the loader can compile it.`
            };
          }
        } catch {
        }
      }
      return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
    }
    const extension = createExtension(extensionPath, resolvedPath);
    const api = createExtensionAPI(extension, runtime, cwd, eventBus);
    await factory(api);
    logExtensionTiming(extensionPath, Date.now() - start, "loaded");
    return { extension, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logExtensionTiming(extensionPath, Date.now() - start, "failed");
    if (resolvedPath.endsWith(".js")) {
      try {
        const source = fs.readFileSync(resolvedPath, "utf-8");
        if (containsTypeScriptSyntax(source)) {
          return {
            extension: null,
            error: `Extension file "${extensionPath}" appears to contain TypeScript syntax but has a .js extension. Rename it to .ts so the loader can compile it.`
          };
        }
      } catch {
      }
    }
    return { extension: null, error: `Failed to load extension: ${message}` };
  }
}
async function loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath = "<inline>") {
  const extension = createExtension(extensionPath, extensionPath);
  const api = createExtensionAPI(extension, runtime, cwd, eventBus);
  await factory(api);
  return extension;
}
async function loadExtensions(paths, cwd, eventBus) {
  const resolvedEventBus = eventBus ?? createEventBus();
  const runtime = createExtensionRuntime();
  const extensions = [];
  const errors = [];
  for (const extPath of paths) {
    const { extension, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);
    if (error) {
      errors.push({ path: extPath, error });
    } else if (extension) {
      extensions.push(extension);
    }
  }
  return {
    extensions,
    errors,
    warnings: [],
    runtime
  };
}
function readPiManifest(packageJsonPath) {
  try {
    const content = fs.readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);
    if (pkg.pi && typeof pkg.pi === "object") {
      return pkg.pi;
    }
    return null;
  } catch {
    return null;
  }
}
function isExtensionFile(name) {
  return name.endsWith(".ts") || name.endsWith(".js");
}
function resolveExtensionEntries(dir) {
  const packageJsonPath = path.join(dir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const manifest = readPiManifest(packageJsonPath);
    if (manifest) {
      if (!manifest.extensions?.length) {
        return null;
      }
      const entries = [];
      for (const extPath of manifest.extensions) {
        const resolvedExtPath = path.resolve(dir, extPath);
        if (fs.existsSync(resolvedExtPath)) {
          entries.push(resolvedExtPath);
        }
      }
      return entries.length > 0 ? entries : null;
    }
  }
  const indexTs = path.join(dir, "index.ts");
  const indexJs = path.join(dir, "index.js");
  if (fs.existsSync(indexTs)) {
    return [indexTs];
  }
  if (fs.existsSync(indexJs)) {
    return [indexJs];
  }
  return null;
}
function discoverExtensionsInDir(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const discovered = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
        discovered.push(entryPath);
        continue;
      }
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const entries2 = resolveExtensionEntries(entryPath);
        if (entries2) {
          discovered.push(...entries2);
        }
      }
    }
  } catch {
    return [];
  }
  return discovered;
}
async function discoverAndLoadExtensions(configuredPaths, cwd, agentDir = getAgentDir(), eventBus) {
  const allPaths = [];
  const seen = /* @__PURE__ */ new Set();
  const addPaths = (paths) => {
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        allPaths.push(p);
      }
    }
  };
  const localExtDir = path.join(cwd, ".pi", "extensions");
  const localDiscovered = discoverExtensionsInDir(localExtDir);
  if (localDiscovered.length > 0) {
    const untrusted = getUntrustedExtensionPaths(cwd, localDiscovered, agentDir);
    if (untrusted.length > 0) {
      process.stderr.write(
        `[pi] Skipping ${untrusted.length} project-local extension(s) in ${localExtDir} \u2014 project not trusted. Use trustProject() to enable.
`
      );
    }
    const trusted = localDiscovered.filter((p) => !untrusted.includes(p));
    addPaths(trusted);
  }
  const globalExtDir = path.join(agentDir, "extensions");
  const installedExtDir = path.join(path.dirname(agentDir), "extensions");
  const globalPaths = discoverExtensionsInDir(globalExtDir);
  const mergedPaths = mergeExtensionEntryPaths(globalPaths, installedExtDir);
  addPaths(mergedPaths);
  for (const p of configuredPaths) {
    const resolved = resolvePath(p, cwd);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      const entries = resolveExtensionEntries(resolved);
      if (entries) {
        addPaths(entries);
        continue;
      }
      addPaths(discoverExtensionsInDir(resolved));
      continue;
    }
    addPaths([resolved]);
  }
  const { sortedPaths, warnings: sortWarnings } = sortExtensionPaths(allPaths);
  for (const w of sortWarnings) {
    process.stderr.write(`[gsd] ${w.message}
`);
  }
  const result = await loadExtensions(sortedPaths, cwd, eventBus);
  result.warnings.push(...sortWarnings);
  return result;
}
export {
  containsTypeScriptSyntax,
  createExtensionRuntime,
  discoverAndLoadExtensions,
  getUntrustedExtensionPaths2 as getUntrustedExtensionPaths,
  importExtensionModule,
  isProjectTrusted,
  loadExtensionFromFactory,
  loadExtensions,
  resetExtensionLoaderCache,
  trustProject
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2V4dGVuc2lvbnMvbG9hZGVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEV4dGVuc2lvbiBsb2FkZXIgLSBsb2FkcyBUeXBlU2NyaXB0IGV4dGVuc2lvbiBtb2R1bGVzIHVzaW5nIGppdGkuXG4gKlxuICogVXNlcyBAbWFyaW96ZWNobmVyL2ppdGkgZm9yayB3aXRoIHZpcnR1YWxNb2R1bGVzIHN1cHBvcnQgZm9yIGNvbXBpbGVkIEJ1biBiaW5hcmllcy5cbiAqL1xuXG5pbXBvcnQgKiBhcyBmcyBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgY3JlYXRlUmVxdWlyZSB9IGZyb20gXCJub2RlOm1vZHVsZVwiO1xuaW1wb3J0ICogYXMgb3MgZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgY3JlYXRlSml0aSB9IGZyb20gXCJAbWFyaW96ZWNobmVyL2ppdGlcIjtcbmltcG9ydCAqIGFzIF9idW5kbGVkUGlBZ2VudENvcmUgZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0ICogYXMgX2J1bmRsZWRQaUFpIGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgKiBhcyBfYnVuZGxlZFBpQWlPYXV0aCBmcm9tIFwiQGdzZC9waS1haS9vYXV0aFwiO1xuaW1wb3J0IHR5cGUgeyBLZXlJZCB9IGZyb20gXCJAZ3NkL3BpLXR1aVwiO1xuaW1wb3J0ICogYXMgX2J1bmRsZWRQaVR1aSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbi8vIFN0YXRpYyBpbXBvcnRzIG9mIHBhY2thZ2VzIHRoYXQgZXh0ZW5zaW9ucyBtYXkgdXNlLlxuLy8gVGhlc2UgTVVTVCBiZSBzdGF0aWMgc28gQnVuIGJ1bmRsZXMgdGhlbSBpbnRvIHRoZSBjb21waWxlZCBiaW5hcnkuXG4vLyBUaGUgdmlydHVhbE1vZHVsZXMgb3B0aW9uIHRoZW4gbWFrZXMgdGhlbSBhdmFpbGFibGUgdG8gZXh0ZW5zaW9ucy5cbmltcG9ydCAqIGFzIF9idW5kbGVkVHlwZWJveCBmcm9tIFwiQHNpbmNsYWlyL3R5cGVib3hcIjtcbmltcG9ydCAqIGFzIF9idW5kbGVkWWFtbCBmcm9tIFwieWFtbFwiO1xuaW1wb3J0ICogYXMgX2J1bmRsZWRNY3BDbGllbnQgZnJvbSBcIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvY2xpZW50XCI7XG5pbXBvcnQgKiBhcyBfYnVuZGxlZE1jcFN0ZGlvIGZyb20gXCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL2NsaWVudC9zdGRpby5qc1wiO1xuaW1wb3J0ICogYXMgX2J1bmRsZWRNY3BTdHJlYW1hYmxlSHR0cCBmcm9tIFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9jbGllbnQvc3RyZWFtYWJsZUh0dHAuanNcIjtcbmltcG9ydCAqIGFzIF9idW5kbGVkTWNwU3NlIGZyb20gXCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL2NsaWVudC9zc2UuanNcIjtcbmltcG9ydCAqIGFzIF9idW5kbGVkTWNwU2VydmVyIGZyb20gXCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL3NlcnZlclwiO1xuaW1wb3J0ICogYXMgX2J1bmRsZWRNY3BTZXJ2ZXJTdGRpbyBmcm9tIFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9zZXJ2ZXIvc3RkaW8uanNcIjtcbmltcG9ydCAqIGFzIF9idW5kbGVkTWNwU2VydmVyU3NlIGZyb20gXCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL3NlcnZlci9zc2UuanNcIjtcbmltcG9ydCAqIGFzIF9idW5kbGVkTWNwU2VydmVyU3RyZWFtYWJsZUh0dHAgZnJvbSBcIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvc2VydmVyL3N0cmVhbWFibGVIdHRwLmpzXCI7XG5pbXBvcnQgKiBhcyBfYnVuZGxlZE1jcFR5cGVzIGZyb20gXCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBnZXRBZ2VudERpciwgaXNCdW5CaW5hcnkgfSBmcm9tIFwiLi4vLi4vY29uZmlnLmpzXCI7XG4vLyBOT1RFOiBUaGlzIGltcG9ydCB3b3JrcyBiZWNhdXNlIGxvYWRlci50cyBleHBvcnRzIGFyZSBOT1QgcmUtZXhwb3J0ZWQgZnJvbSBpbmRleC50cyxcbi8vIGF2b2lkaW5nIGEgY2lyY3VsYXIgZGVwZW5kZW5jeS4gRXh0ZW5zaW9ucyBjYW4gaW1wb3J0IGZyb20gQGdzZC9waS1jb2RpbmctYWdlbnQuXG5pbXBvcnQgKiBhcyBfYnVuZGxlZFBpQ29kaW5nQWdlbnQgZnJvbSBcIi4uLy4uL2luZGV4LmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVFdmVudEJ1cywgdHlwZSBFdmVudEJ1cyB9IGZyb20gXCIuLi9ldmVudC1idXMuanNcIjtcbmltcG9ydCB0eXBlIHsgRXhlY09wdGlvbnMgfSBmcm9tIFwiLi4vZXhlYy5qc1wiO1xuaW1wb3J0IHsgZXhlY0NvbW1hbmQgfSBmcm9tIFwiLi4vZXhlYy5qc1wiO1xuaW1wb3J0IHsgZ2V0VW50cnVzdGVkRXh0ZW5zaW9uUGF0aHMgfSBmcm9tIFwiLi9wcm9qZWN0LXRydXN0LmpzXCI7XG5leHBvcnQgeyBpc1Byb2plY3RUcnVzdGVkLCB0cnVzdFByb2plY3QsIGdldFVudHJ1c3RlZEV4dGVuc2lvblBhdGhzIH0gZnJvbSBcIi4vcHJvamVjdC10cnVzdC5qc1wiO1xuaW1wb3J0IHsgcmVnaXN0ZXJUb29sQ29tcGF0aWJpbGl0eSB9IGZyb20gXCIuLi90b29scy90b29sLWNvbXBhdGliaWxpdHktcmVnaXN0cnkuanNcIjtcbmltcG9ydCB7IG1lcmdlRXh0ZW5zaW9uRW50cnlQYXRocyB9IGZyb20gXCIuL2V4dGVuc2lvbi1kaXNjb3ZlcnkuanNcIjtcbmltcG9ydCB7IHNvcnRFeHRlbnNpb25QYXRocyB9IGZyb20gXCIuL2V4dGVuc2lvbi1zb3J0LmpzXCI7XG5pbXBvcnQgdHlwZSB7XG5cdEV4dGVuc2lvbixcblx0RXh0ZW5zaW9uQVBJLFxuXHRFeHRlbnNpb25GYWN0b3J5LFxuXHRMaWZlY3ljbGVIb29rSGFuZGxlcixcblx0RXh0ZW5zaW9uUnVudGltZSxcblx0TG9hZEV4dGVuc2lvbnNSZXN1bHQsXG5cdE1lc3NhZ2VSZW5kZXJlcixcblx0UHJvdmlkZXJDb25maWcsXG5cdFJlZ2lzdGVyZWRDb21tYW5kLFxuXHRUb29sRGVmaW5pdGlvbixcbn0gZnJvbSBcIi4vdHlwZXMuanNcIjtcblxuLyoqXG4gKiBTdGF0aWNhbGx5IGltcG9ydGVkIG1vZHVsZXMgZm9yIEJ1biBiaW5hcnkgdmlydHVhbE1vZHVsZXMuXG4gKiBNYXBzIHNwZWNpZmllciAtPiBtb2R1bGUgb2JqZWN0IGZvciBzdWJwYXRocyB0aGF0IG11c3QgYmUgYXZhaWxhYmxlIGluIGNvbXBpbGVkIGJpbmFyaWVzLlxuICovXG5jb25zdCBTVEFUSUNfQlVORExFRF9NT0RVTEVTOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcblx0XCJAc2luY2xhaXIvdHlwZWJveFwiOiBfYnVuZGxlZFR5cGVib3gsXG5cdFwiQGdzZC9waS1hZ2VudC1jb3JlXCI6IF9idW5kbGVkUGlBZ2VudENvcmUsXG5cdFwiQGdzZC9waS10dWlcIjogX2J1bmRsZWRQaVR1aSxcblx0XCJAZ3NkL3BpLWFpXCI6IF9idW5kbGVkUGlBaSxcblx0XCJAZ3NkL3BpLWFpL29hdXRoXCI6IF9idW5kbGVkUGlBaU9hdXRoLFxuXHRcIkBnc2QvcGktY29kaW5nLWFnZW50XCI6IF9idW5kbGVkUGlDb2RpbmdBZ2VudCxcblx0XCJ5YW1sXCI6IF9idW5kbGVkWWFtbCxcblx0XCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL2NsaWVudFwiOiBfYnVuZGxlZE1jcENsaWVudCxcblx0XCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL2NsaWVudC9zdGRpb1wiOiBfYnVuZGxlZE1jcFN0ZGlvLFxuXHRcIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvY2xpZW50L3N0ZGlvLmpzXCI6IF9idW5kbGVkTWNwU3RkaW8sXG5cdFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9jbGllbnQvc3RyZWFtYWJsZUh0dHBcIjogX2J1bmRsZWRNY3BTdHJlYW1hYmxlSHR0cCxcblx0XCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL2NsaWVudC9zdHJlYW1hYmxlSHR0cC5qc1wiOiBfYnVuZGxlZE1jcFN0cmVhbWFibGVIdHRwLFxuXHRcIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvY2xpZW50L3NzZVwiOiBfYnVuZGxlZE1jcFNzZSxcblx0XCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL2NsaWVudC9zc2UuanNcIjogX2J1bmRsZWRNY3BTc2UsXG5cdFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9zZXJ2ZXJcIjogX2J1bmRsZWRNY3BTZXJ2ZXIsXG5cdFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9zZXJ2ZXIvc3RkaW9cIjogX2J1bmRsZWRNY3BTZXJ2ZXJTdGRpbyxcblx0XCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL3NlcnZlci9zdGRpby5qc1wiOiBfYnVuZGxlZE1jcFNlcnZlclN0ZGlvLFxuXHRcIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvc2VydmVyL3NzZVwiOiBfYnVuZGxlZE1jcFNlcnZlclNzZSxcblx0XCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL3NlcnZlci9zc2UuanNcIjogX2J1bmRsZWRNY3BTZXJ2ZXJTc2UsXG5cdFwiQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9zZXJ2ZXIvc3RyZWFtYWJsZUh0dHBcIjogX2J1bmRsZWRNY3BTZXJ2ZXJTdHJlYW1hYmxlSHR0cCxcblx0XCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL3NlcnZlci9zdHJlYW1hYmxlSHR0cC5qc1wiOiBfYnVuZGxlZE1jcFNlcnZlclN0cmVhbWFibGVIdHRwLFxuXHRcIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvdHlwZXNcIjogX2J1bmRsZWRNY3BUeXBlcyxcblx0XCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrL3R5cGVzLmpzXCI6IF9idW5kbGVkTWNwVHlwZXMsXG5cdC8vIEFsaWFzZXMgZm9yIGV4dGVybmFsIFBJIGVjb3N5c3RlbSBwYWNrYWdlcyB0aGF0IGltcG9ydCBmcm9tIHRoZSBvcmlnaW5hbCBzY29wZVxuXHRcIkBtYXJpb3plY2huZXIvcGktYWdlbnQtY29yZVwiOiBfYnVuZGxlZFBpQWdlbnRDb3JlLFxuXHRcIkBtYXJpb3plY2huZXIvcGktdHVpXCI6IF9idW5kbGVkUGlUdWksXG5cdFwiQG1hcmlvemVjaG5lci9waS1haVwiOiBfYnVuZGxlZFBpQWksXG5cdFwiQG1hcmlvemVjaG5lci9waS1haS9vYXV0aFwiOiBfYnVuZGxlZFBpQWlPYXV0aCxcblx0XCJAbWFyaW96ZWNobmVyL3BpLWNvZGluZy1hZ2VudFwiOiBfYnVuZGxlZFBpQ29kaW5nQWdlbnQsXG59O1xuXG4vKiogTW9kdWxlcyBhdmFpbGFibGUgdG8gZXh0ZW5zaW9ucyB2aWEgdmlydHVhbE1vZHVsZXMgKGZvciBjb21waWxlZCBCdW4gYmluYXJ5KSAqL1xuY29uc3QgVklSVFVBTF9NT0RVTEVTOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgLi4uU1RBVElDX0JVTkRMRURfTU9EVUxFUyB9O1xuXG5jb25zdCByZXF1aXJlID0gY3JlYXRlUmVxdWlyZShpbXBvcnQubWV0YS51cmwpO1xuY29uc3QgRVhURU5TSU9OX1RJTUlOR19FTkFCTEVEID0gcHJvY2Vzcy5lbnYuR1NEX1NUQVJUVVBfVElNSU5HID09PSBcIjFcIiB8fCBwcm9jZXNzLmVudi5QSV9USU1JTkcgPT09IFwiMVwiO1xuXG4vKipcbiAqIEJ1bmRsZWQgbnBtIHBhY2thZ2VzIHdob3NlIHN1YnBhdGggZXhwb3J0cyBzaG91bGQgYmUgYXV0by1yZXNvbHZlZCBmb3IgZXh0ZW5zaW9ucy5cbiAqIEVhY2ggcGFja2FnZSBsaXN0ZWQgaGVyZSB3aWxsIGhhdmUgaXRzIGBleHBvcnRzYCBmaWVsZCByZWFkIGZyb20gcGFja2FnZS5qc29uLFxuICogYW5kIGFsbCBzdWJwYXRoIGV4cG9ydHMgd2lsbCBiZSByZWdpc3RlcmVkIGFzIGppdGkgYWxpYXNlcyAoTm9kZS5qcyBtb2RlKSBzbyB0aGF0XG4gKiBleHRlbnNpb25zIGNhbiBpbXBvcnQgYW55IHN0YW5kYXJkIHN1YnBhdGggd2l0aG91dCBoaXR0aW5nIGppdGkncyBDSlMgZG91YmxlLXJlc29sdmUgYnVnLlxuICovXG5jb25zdCBCVU5ETEVEX1BBQ0tBR0VTX1dJVEhfRVhQT1JUUyA9IFtcblx0XCJAbW9kZWxjb250ZXh0cHJvdG9jb2wvc2RrXCIsXG5cdFwieWFtbFwiLFxuXTtcblxuLyoqXG4gKiBSZWFkIGEgcGFja2FnZSdzIGBleHBvcnRzYCBmaWVsZCBhbmQgcmV0dXJuIGFsaWFzIGVudHJpZXMgbWFwcGluZ1xuICogc3BlY2lmaWVycyAoZS5nLiBgQG1vZGVsY29udGV4dHByb3RvY29sL3Nkay9zZXJ2ZXJgKSB0byByZXNvbHZlZCBmaWxlIHBhdGhzLlxuICpcbiAqIEhhbmRsZXM6XG4gKiAtIEV4cGxpY2l0IHN1YnBhdGggZXhwb3J0czogYC4vY2xpZW50YCAtPiBgQHBrZy9jbGllbnRgXG4gKiAtIFdpbGRjYXJkIGV4cG9ydHMgKGAuLypgKTogc2NhbnMgdGhlIHBhY2thZ2UncyBkaXN0IGRpcmVjdG9yeSBmb3IgYWN0dWFsIGZpbGVzXG4gKiAtIEJvdGggYC5qc2Atc3VmZml4ZWQgYW5kIGJhcmUgc3BlY2lmaWVycyBmb3IgZWFjaCBzdWJwYXRoXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVTdWJwYXRoRXhwb3J0cyhwYWNrYWdlTmFtZTogc3RyaW5nKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG5cdGNvbnN0IGFsaWFzZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcblxuXHRsZXQgcGFja2FnZUpzb25QYXRoOiBzdHJpbmc7XG5cdHRyeSB7XG5cdFx0Ly8gUmVzb2x2ZSB0aGUgcGFja2FnZSdzIHJvb3QgZGlyZWN0b3J5IHZpYSBpdHMgcGFja2FnZS5qc29uXG5cdFx0cGFja2FnZUpzb25QYXRoID0gcmVxdWlyZS5yZXNvbHZlKGAke3BhY2thZ2VOYW1lfS9wYWNrYWdlLmpzb25gKTtcblx0fSBjYXRjaCB7XG5cdFx0Ly8gUGFja2FnZSBkb2Vzbid0IGFsbG93IGltcG9ydGluZyBwYWNrYWdlLmpzb24gdmlhIGV4cG9ydHMgXHUyMDE0IGZpbmQgaXQgbWFudWFsbHlcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgYW55RW50cnkgPSByZXF1aXJlLnJlc29sdmUocGFja2FnZU5hbWUpO1xuXHRcdFx0Ly8gV2FsayB1cCBmcm9tIHRoZSByZXNvbHZlZCBlbnRyeSB0byBmaW5kIHBhY2thZ2UuanNvblxuXHRcdFx0bGV0IGRpciA9IHBhdGguZGlybmFtZShhbnlFbnRyeSk7XG5cdFx0XHR3aGlsZSAoZGlyICE9PSBwYXRoLmRpcm5hbWUoZGlyKSkge1xuXHRcdFx0XHRjb25zdCBjYW5kaWRhdGUgPSBwYXRoLmpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKTtcblx0XHRcdFx0aWYgKGZzLmV4aXN0c1N5bmMoY2FuZGlkYXRlKSkge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRjb25zdCBwa2cgPSBKU09OLnBhcnNlKGZzLnJlYWRGaWxlU3luYyhjYW5kaWRhdGUsIFwidXRmLThcIikpO1xuXHRcdFx0XHRcdFx0aWYgKHBrZy5uYW1lID09PSBwYWNrYWdlTmFtZSkge1xuXHRcdFx0XHRcdFx0XHRwYWNrYWdlSnNvblBhdGggPSBjYW5kaWRhdGU7XG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdFx0Ly8gbm90IHZhbGlkIEpTT04sIGtlZXAgd2Fsa2luZ1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRkaXIgPSBwYXRoLmRpcm5hbWUoZGlyKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdHJldHVybiBhbGlhc2VzO1xuXHRcdH1cblx0XHRpZiAoIXBhY2thZ2VKc29uUGF0aCEpIHJldHVybiBhbGlhc2VzO1xuXHR9XG5cblx0bGV0IHBrZzogeyBleHBvcnRzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfTtcblx0dHJ5IHtcblx0XHRwa2cgPSBKU09OLnBhcnNlKGZzLnJlYWRGaWxlU3luYyhwYWNrYWdlSnNvblBhdGgsIFwidXRmLThcIikpO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm4gYWxpYXNlcztcblx0fVxuXG5cdGNvbnN0IGV4cG9ydHMgPSBwa2cuZXhwb3J0cztcblx0aWYgKCFleHBvcnRzIHx8IHR5cGVvZiBleHBvcnRzICE9PSBcIm9iamVjdFwiKSByZXR1cm4gYWxpYXNlcztcblxuXHRjb25zdCBwYWNrYWdlRGlyID0gcGF0aC5kaXJuYW1lKHBhY2thZ2VKc29uUGF0aCk7XG5cblx0Zm9yIChjb25zdCBbc3VicGF0aCwgdGFyZ2V0XSBvZiBPYmplY3QuZW50cmllcyhleHBvcnRzKSkge1xuXHRcdGlmIChzdWJwYXRoID09PSBcIi5cIikgY29udGludWU7IC8vIFJvb3QgZXhwb3J0IGhhbmRsZWQgYnkgc3RhdGljIGltcG9ydHNcblxuXHRcdC8vIEhhbmRsZSB3aWxkY2FyZCBleHBvcnRzIGxpa2UgXCIuLypcIlxuXHRcdGlmIChzdWJwYXRoLmluY2x1ZGVzKFwiKlwiKSkge1xuXHRcdFx0cmVzb2x2ZVdpbGRjYXJkRXhwb3J0cyhwYWNrYWdlTmFtZSwgcGFja2FnZURpciwgc3VicGF0aCwgdGFyZ2V0LCBhbGlhc2VzKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdC8vIEV4cGxpY2l0IHN1YnBhdGg6IFwiLi9jbGllbnRcIiAtPiBcIkBwa2cvY2xpZW50XCJcblx0XHRjb25zdCBzcGVjaWZpZXIgPSBgJHtwYWNrYWdlTmFtZX0vJHtzdWJwYXRoLnJlcGxhY2UoL15cXC5cXC8vLCBcIlwiKX1gO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHJlc29sdmVkID0gcmVxdWlyZS5yZXNvbHZlKHNwZWNpZmllcik7XG5cdFx0XHRhbGlhc2VzW3NwZWNpZmllcl0gPSByZXNvbHZlZDtcblxuXHRcdFx0Ly8gQWRkIC5qcy1zdWZmaXhlZCB2YXJpYW50IGlmIHRoZSBzcGVjaWZpZXIgZG9lc24ndCBhbHJlYWR5IGVuZCBpbiAuanNcblx0XHRcdGlmICghc3BlY2lmaWVyLmVuZHNXaXRoKFwiLmpzXCIpKSB7XG5cdFx0XHRcdGNvbnN0IGpzU3BlY2lmaWVyID0gYCR7c3BlY2lmaWVyfS5qc2A7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Y29uc3QganNSZXNvbHZlZCA9IHJlcXVpcmUucmVzb2x2ZShqc1NwZWNpZmllcik7XG5cdFx0XHRcdFx0YWxpYXNlc1tqc1NwZWNpZmllcl0gPSBqc1Jlc29sdmVkO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHQvLyAuanMgdmFyaWFudCBkb2Vzbid0IHJlc29sdmUgXHUyMDE0IHRoYXQncyBmaW5lXG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gQWRkIGJhcmUgdmFyaWFudCAod2l0aG91dCAuanMpIGlmIGl0IGVuZHMgaW4gLmpzXG5cdFx0XHRpZiAoc3BlY2lmaWVyLmVuZHNXaXRoKFwiLmpzXCIpKSB7XG5cdFx0XHRcdGNvbnN0IGJhcmVTcGVjaWZpZXIgPSBzcGVjaWZpZXIuc2xpY2UoMCwgLTMpO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IGJhcmVSZXNvbHZlZCA9IHJlcXVpcmUucmVzb2x2ZShiYXJlU3BlY2lmaWVyKTtcblx0XHRcdFx0XHRhbGlhc2VzW2JhcmVTcGVjaWZpZXJdID0gYmFyZVJlc29sdmVkO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHQvLyBiYXJlIHZhcmlhbnQgZG9lc24ndCByZXNvbHZlIFx1MjAxNCB0aGF0J3MgZmluZVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBTdWJwYXRoIGRvZXNuJ3QgcmVzb2x2ZSBcdTIwMTQgc2tpcCBpdFxuXHRcdH1cblx0fVxuXG5cdHJldHVybiBhbGlhc2VzO1xufVxuXG4vKipcbiAqIFJlc29sdmUgd2lsZGNhcmQgZXhwb3J0IHBhdHRlcm5zIChlLmcuIGAuLypgKSBieSBzY2FubmluZyB0aGUgcGFja2FnZSdzXG4gKiBmaWxlIHN0cnVjdHVyZSB0byBmaW5kIGFsbCBtYXRjaGluZyBmaWxlcyBhbmQgZ2VuZXJhdGUgYWxpYXMgZW50cmllcy5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZVdpbGRjYXJkRXhwb3J0cyhcblx0cGFja2FnZU5hbWU6IHN0cmluZyxcblx0cGFja2FnZURpcjogc3RyaW5nLFxuXHRzdWJwYXRoUGF0dGVybjogc3RyaW5nLFxuXHR0YXJnZXQ6IHVua25vd24sXG5cdGFsaWFzZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4pOiB2b2lkIHtcblx0Ly8gRXh0cmFjdCB0aGUgdGFyZ2V0IGRpcmVjdG9yeSBwYXR0ZXJuIGZyb20gdGhlIGV4cG9ydCB0YXJnZXRcblx0Ly8gZS5nLiB7IFwicmVxdWlyZVwiOiBcIi4vZGlzdC9janMvKlwiIH0gLT4gXCJkaXN0L2Nqc1wiXG5cdGxldCB0YXJnZXREaXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5cdGlmICh0eXBlb2YgdGFyZ2V0ID09PSBcInN0cmluZ1wiKSB7XG5cdFx0dGFyZ2V0RGlyID0gdGFyZ2V0LnJlcGxhY2UoL1xcL1xcKiQvLCBcIlwiKS5yZXBsYWNlKC9eXFwuXFwvLywgXCJcIik7XG5cdH0gZWxzZSBpZiAodGFyZ2V0ICYmIHR5cGVvZiB0YXJnZXQgPT09IFwib2JqZWN0XCIpIHtcblx0XHRjb25zdCB0YXJnZXRPYmogPSB0YXJnZXQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cdFx0Ly8gUHJlZmVyIFwicmVxdWlyZVwiIGZvciBDSlMgY29tcGF0aWJpbGl0eSB3aXRoIGppdGksIGZhbGwgYmFjayB0byBcImltcG9ydFwiXG5cdFx0Y29uc3QgcmVzb2x2ZWQgPSB0YXJnZXRPYmoucmVxdWlyZSA/PyB0YXJnZXRPYmouaW1wb3J0ID8/IHRhcmdldE9iai5kZWZhdWx0O1xuXHRcdGlmICh0eXBlb2YgcmVzb2x2ZWQgPT09IFwic3RyaW5nXCIpIHtcblx0XHRcdHRhcmdldERpciA9IHJlc29sdmVkLnJlcGxhY2UoL1xcL1xcKiQvLCBcIlwiKS5yZXBsYWNlKC9eXFwuXFwvLywgXCJcIik7XG5cdFx0fVxuXHR9XG5cblx0aWYgKCF0YXJnZXREaXIpIHJldHVybjtcblxuXHRjb25zdCBmdWxsVGFyZ2V0RGlyID0gcGF0aC5qb2luKHBhY2thZ2VEaXIsIHRhcmdldERpcik7XG5cdGlmICghZnMuZXhpc3RzU3luYyhmdWxsVGFyZ2V0RGlyKSkgcmV0dXJuO1xuXG5cdC8vIFNjYW4gZm9yIC5qcyBmaWxlcyBhbmQgZ2VuZXJhdGUgc3BlY2lmaWVyc1xuXHRjb25zdCBzdWJwYXRoUHJlZml4ID0gc3VicGF0aFBhdHRlcm4ucmVwbGFjZSgvXFwvP1xcKiQvLCBcIlwiKS5yZXBsYWNlKC9eXFwuXFwvLywgXCJcIik7XG5cdHNjYW5EaXJGb3JFeHBvcnRzKHBhY2thZ2VOYW1lLCBmdWxsVGFyZ2V0RGlyLCBzdWJwYXRoUHJlZml4LCBhbGlhc2VzKTtcbn1cblxuLyoqXG4gKiBSZWN1cnNpdmVseSBzY2FuIGEgZGlyZWN0b3J5IGZvciAuanMgZmlsZXMgYW5kIHJlZ2lzdGVyIHRoZW0gYXMgYWxpYXNlcy5cbiAqL1xuZnVuY3Rpb24gc2NhbkRpckZvckV4cG9ydHMoXG5cdHBhY2thZ2VOYW1lOiBzdHJpbmcsXG5cdGRpcjogc3RyaW5nLFxuXHRyZWxhdGl2ZVBhdGg6IHN0cmluZyxcblx0YWxpYXNlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbik6IHZvaWQge1xuXHRsZXQgZW50cmllczogZnMuRGlyZW50W107XG5cdHRyeSB7XG5cdFx0ZW50cmllcyA9IGZzLnJlYWRkaXJTeW5jKGRpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcblx0XHRjb25zdCBlbnRyeVJlbGF0aXZlID0gcmVsYXRpdmVQYXRoID8gYCR7cmVsYXRpdmVQYXRofS8ke2VudHJ5Lm5hbWV9YCA6IGVudHJ5Lm5hbWU7XG5cblx0XHRpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSkge1xuXHRcdFx0Ly8gU2tpcCBleGFtcGxlcy90ZXN0IGRpcmVjdG9yaWVzIFx1MjAxNCBleHRlbnNpb25zIGRvbid0IG5lZWQgdGhlbVxuXHRcdFx0aWYgKGVudHJ5Lm5hbWUgPT09IFwiZXhhbXBsZXNcIiB8fCBlbnRyeS5uYW1lID09PSBcIl9fdGVzdHNfX1wiIHx8IGVudHJ5Lm5hbWUgPT09IFwidGVzdFwiKSBjb250aW51ZTtcblx0XHRcdHNjYW5EaXJGb3JFeHBvcnRzKHBhY2thZ2VOYW1lLCBwYXRoLmpvaW4oZGlyLCBlbnRyeS5uYW1lKSwgZW50cnlSZWxhdGl2ZSwgYWxpYXNlcyk7XG5cdFx0fSBlbHNlIGlmIChlbnRyeS5uYW1lLmVuZHNXaXRoKFwiLmpzXCIpICYmICFlbnRyeS5uYW1lLmVuZHNXaXRoKFwiLmQuanNcIikpIHtcblx0XHRcdGNvbnN0IGZpbGVQYXRoID0gcGF0aC5qb2luKGRpciwgZW50cnkubmFtZSk7XG5cdFx0XHRjb25zdCBzcGVjaWZpZXIgPSBgJHtwYWNrYWdlTmFtZX0vJHtlbnRyeVJlbGF0aXZlfWA7XG5cdFx0XHQvLyBPbmx5IGFkZCBpZiBub3QgYWxyZWFkeSBjb3ZlcmVkIGJ5IGFuIGV4cGxpY2l0IGV4cG9ydFxuXHRcdFx0aWYgKCEoc3BlY2lmaWVyIGluIGFsaWFzZXMpKSB7XG5cdFx0XHRcdGFsaWFzZXNbc3BlY2lmaWVyXSA9IGZpbGVQYXRoO1xuXHRcdFx0fVxuXHRcdFx0Ly8gQWxzbyBhZGQgYmFyZSAobm8gLmpzKSB2YXJpYW50XG5cdFx0XHRjb25zdCBiYXJlU3BlY2lmaWVyID0gc3BlY2lmaWVyLnJlcGxhY2UoL1xcLmpzJC8sIFwiXCIpO1xuXHRcdFx0aWYgKCEoYmFyZVNwZWNpZmllciBpbiBhbGlhc2VzKSkge1xuXHRcdFx0XHRhbGlhc2VzW2JhcmVTcGVjaWZpZXJdID0gZmlsZVBhdGg7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGxvZ0V4dGVuc2lvblRpbWluZyhleHRlbnNpb25QYXRoOiBzdHJpbmcsIG1zOiBudW1iZXIsIG91dGNvbWU6IFwibG9hZGVkXCIgfCBcImZhaWxlZFwiKTogdm9pZCB7XG5cdGlmICghRVhURU5TSU9OX1RJTUlOR19FTkFCTEVEKSByZXR1cm47XG5cdGNvbnNvbGUuZXJyb3IoYFtzdGFydHVwXSBleHRlbnNpb24gJHtvdXRjb21lfTogJHtleHRlbnNpb25QYXRofSAoJHttc31tcylgKTtcbn1cblxuLyoqXG4gKiBHZXQgYWxpYXNlcyBmb3Igaml0aSAodXNlZCBpbiBOb2RlLmpzL2RldmVsb3BtZW50IG1vZGUpLlxuICogSW4gQnVuIGJpbmFyeSBtb2RlLCB2aXJ0dWFsTW9kdWxlcyBpcyB1c2VkIGluc3RlYWQuXG4gKi9cbmxldCBfYWxpYXNlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IG51bGwgPSBudWxsO1xuZnVuY3Rpb24gZ2V0QWxpYXNlcygpOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcblx0aWYgKF9hbGlhc2VzKSByZXR1cm4gX2FsaWFzZXM7XG5cblx0Y29uc3QgX19kaXJuYW1lID0gcGF0aC5kaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5cdGNvbnN0IHBhY2thZ2VJbmRleCA9IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi4vLi5cIiwgXCJpbmRleC5qc1wiKTtcblxuXHRjb25zdCB0eXBlYm94RW50cnkgPSByZXF1aXJlLnJlc29sdmUoXCJAc2luY2xhaXIvdHlwZWJveFwiKTtcblx0Y29uc3QgdHlwZWJveFJvb3QgPSB0eXBlYm94RW50cnkucmVwbGFjZSgvW1xcXFwvXWJ1aWxkW1xcXFwvXWNqc1tcXFxcL11pbmRleFxcLmpzJC8sIFwiXCIpO1xuXG5cdGNvbnN0IHlhbWxFbnRyeSA9IHJlcXVpcmUucmVzb2x2ZShcInlhbWxcIik7XG5cdGNvbnN0IHlhbWxSb290ID0geWFtbEVudHJ5LnJlcGxhY2UoL1tcXFxcL11kaXN0W1xcXFwvXWluZGV4XFwuanMkLywgXCJcIik7XG5cblx0Y29uc3QgcGFja2FnZXNSb290ID0gcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgXCIuLi8uLi8uLi8uLi9cIik7XG5cdGNvbnN0IHJlc29sdmVXb3Jrc3BhY2VPckltcG9ydCA9ICh3b3Jrc3BhY2VSZWxhdGl2ZVBhdGg6IHN0cmluZywgc3BlY2lmaWVyOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuXHRcdGNvbnN0IHdvcmtzcGFjZVBhdGggPSBwYXRoLmpvaW4ocGFja2FnZXNSb290LCB3b3Jrc3BhY2VSZWxhdGl2ZVBhdGgpO1xuXHRcdGlmIChmcy5leGlzdHNTeW5jKHdvcmtzcGFjZVBhdGgpKSB7XG5cdFx0XHRyZXR1cm4gd29ya3NwYWNlUGF0aDtcblx0XHR9XG5cdFx0cmV0dXJuIGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEucmVzb2x2ZShzcGVjaWZpZXIpKTtcblx0fTtcblxuXHQvLyBBdXRvLWRpc2NvdmVyIHN1YnBhdGggZXhwb3J0cyBmcm9tIGJ1bmRsZWQgbnBtIHBhY2thZ2VzLlxuXHQvLyBUaGlzIGVuc3VyZXMgZXh0ZW5zaW9ucyBjYW4gaW1wb3J0IGFueSBzdGFuZGFyZCBzdWJwYXRoIChlLmcuIEBtb2RlbGNvbnRleHRwcm90b2NvbC9zZGsvc2VydmVyKVxuXHQvLyB3aXRob3V0IGhpdHRpbmcgaml0aSdzIENKUyBkb3VibGUtcmVzb2x2ZSBidWcuXG5cdGNvbnN0IGF1dG9EaXNjb3ZlcmVkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG5cdGZvciAoY29uc3QgcGFja2FnZU5hbWUgb2YgQlVORExFRF9QQUNLQUdFU19XSVRIX0VYUE9SVFMpIHtcblx0XHRjb25zdCBzdWJwYXRoQWxpYXNlcyA9IHJlc29sdmVTdWJwYXRoRXhwb3J0cyhwYWNrYWdlTmFtZSk7XG5cdFx0T2JqZWN0LmFzc2lnbihhdXRvRGlzY292ZXJlZCwgc3VicGF0aEFsaWFzZXMpO1xuXHR9XG5cblx0X2FsaWFzZXMgPSB7XG5cdFx0Ly8gQXV0by1kaXNjb3ZlcmVkIHN1YnBhdGggZXhwb3J0cyAobG93ZXN0IHByaW9yaXR5IFx1MjAxNCBvdmVycmlkZGVuIGJ5IG1hbnVhbCBlbnRyaWVzIGJlbG93KVxuXHRcdC4uLmF1dG9EaXNjb3ZlcmVkLFxuXHRcdC8vIE1hbnVhbCBlbnRyaWVzIGZvciB3b3Jrc3BhY2UgcGFja2FnZXMgYW5kIHBhY2thZ2VzIG5lZWRpbmcgc3BlY2lhbCByZXNvbHV0aW9uXG5cdFx0XCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiOiBwYWNrYWdlSW5kZXgsXG5cdFx0XCJAZ3NkL3BpLWFnZW50LWNvcmVcIjogcmVzb2x2ZVdvcmtzcGFjZU9ySW1wb3J0KFwiYWdlbnQvZGlzdC9pbmRleC5qc1wiLCBcIkBnc2QvcGktYWdlbnQtY29yZVwiKSxcblx0XHRcIkBnc2QvcGktdHVpXCI6IHJlc29sdmVXb3Jrc3BhY2VPckltcG9ydChcInR1aS9kaXN0L2luZGV4LmpzXCIsIFwiQGdzZC9waS10dWlcIiksXG5cdFx0XCJAZ3NkL3BpLWFpXCI6IHJlc29sdmVXb3Jrc3BhY2VPckltcG9ydChcImFpL2Rpc3QvaW5kZXguanNcIiwgXCJAZ3NkL3BpLWFpXCIpLFxuXHRcdFwiQGdzZC9waS1haS9vYXV0aFwiOiByZXNvbHZlV29ya3NwYWNlT3JJbXBvcnQoXCJhaS9kaXN0L29hdXRoLmpzXCIsIFwiQGdzZC9waS1haS9vYXV0aFwiKSxcblx0XHRcIkBzaW5jbGFpci90eXBlYm94XCI6IHR5cGVib3hSb290LFxuXHRcdFwieWFtbFwiOiB5YW1sUm9vdCxcblx0XHQvLyBBbGlhc2VzIGZvciBleHRlcm5hbCBQSSBlY29zeXN0ZW0gcGFja2FnZXMgdGhhdCBpbXBvcnQgZnJvbSB0aGUgb3JpZ2luYWwgc2NvcGVcblx0XHRcIkBtYXJpb3plY2huZXIvcGktY29kaW5nLWFnZW50XCI6IHBhY2thZ2VJbmRleCxcblx0XHRcIkBtYXJpb3plY2huZXIvcGktYWdlbnQtY29yZVwiOiByZXNvbHZlV29ya3NwYWNlT3JJbXBvcnQoXCJhZ2VudC9kaXN0L2luZGV4LmpzXCIsIFwiQGdzZC9waS1hZ2VudC1jb3JlXCIpLFxuXHRcdFwiQG1hcmlvemVjaG5lci9waS10dWlcIjogcmVzb2x2ZVdvcmtzcGFjZU9ySW1wb3J0KFwidHVpL2Rpc3QvaW5kZXguanNcIiwgXCJAZ3NkL3BpLXR1aVwiKSxcblx0XHRcIkBtYXJpb3plY2huZXIvcGktYWlcIjogcmVzb2x2ZVdvcmtzcGFjZU9ySW1wb3J0KFwiYWkvZGlzdC9pbmRleC5qc1wiLCBcIkBnc2QvcGktYWlcIiksXG5cdFx0XCJAbWFyaW96ZWNobmVyL3BpLWFpL29hdXRoXCI6IHJlc29sdmVXb3Jrc3BhY2VPckltcG9ydChcImFpL2Rpc3Qvb2F1dGguanNcIiwgXCJAZ3NkL3BpLWFpL29hdXRoXCIpLFxuXHR9O1xuXG5cdHJldHVybiBfYWxpYXNlcztcbn1cblxuZnVuY3Rpb24gZ2V0Sml0aU9wdGlvbnMoKSB7XG5cdHJldHVybiBpc0J1bkJpbmFyeSA/IHsgdmlydHVhbE1vZHVsZXM6IFZJUlRVQUxfTU9EVUxFUywgdHJ5TmF0aXZlOiBmYWxzZSB9IDogeyBhbGlhczogZ2V0QWxpYXNlcygpIH07XG59XG5cbmNvbnN0IF9tb2R1bGVJbXBvcnRlcnMgPSBuZXcgTWFwPHN0cmluZywgUmV0dXJuVHlwZTx0eXBlb2YgY3JlYXRlSml0aT4+KCk7XG5cbmZ1bmN0aW9uIGdldE1vZHVsZUltcG9ydGVyKHBhcmVudE1vZHVsZVVybDogc3RyaW5nKSB7XG5cdGxldCBpbXBvcnRlciA9IF9tb2R1bGVJbXBvcnRlcnMuZ2V0KHBhcmVudE1vZHVsZVVybCk7XG5cdGlmICghaW1wb3J0ZXIpIHtcblx0XHRpbXBvcnRlciA9IGNyZWF0ZUppdGkocGFyZW50TW9kdWxlVXJsLCB7XG5cdFx0XHRtb2R1bGVDYWNoZTogdHJ1ZSxcblx0XHRcdC4uLmdldEppdGlPcHRpb25zKCksXG5cdFx0fSk7XG5cdFx0X21vZHVsZUltcG9ydGVycy5zZXQocGFyZW50TW9kdWxlVXJsLCBpbXBvcnRlcik7XG5cdH1cblx0cmV0dXJuIGltcG9ydGVyO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW1wb3J0RXh0ZW5zaW9uTW9kdWxlPFQgPSB1bmtub3duPihwYXJlbnRNb2R1bGVVcmw6IHN0cmluZywgc3BlY2lmaWVyOiBzdHJpbmcpOiBQcm9taXNlPFQ+IHtcblx0Y29uc3QgaW1wb3J0ZXIgPSBnZXRNb2R1bGVJbXBvcnRlcihwYXJlbnRNb2R1bGVVcmwpO1xuXHRjb25zdCByZXNvbHZlZFBhdGggPSBmaWxlVVJMVG9QYXRoKG5ldyBVUkwoc3BlY2lmaWVyLCBwYXJlbnRNb2R1bGVVcmwpKTtcblx0cmV0dXJuIGltcG9ydGVyLmltcG9ydChyZXNvbHZlZFBhdGgpIGFzIFByb21pc2U8VD47XG59XG5cbmNvbnN0IFVOSUNPREVfU1BBQ0VTID0gL1tcXHUwMEEwXFx1MTY4MFxcdTIwMDAtXFx1MjAwQVxcdTIwMkZcXHUyMDVGXFx1MzAwMF0vZztcblxuZnVuY3Rpb24gbm9ybWFsaXplVW5pY29kZVNwYWNlcyhzdHI6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBzdHIucmVwbGFjZShVTklDT0RFX1NQQUNFUywgXCIgXCIpO1xufVxuXG5mdW5jdGlvbiBleHBhbmRQYXRoKHA6IHN0cmluZyk6IHN0cmluZyB7XG5cdGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVVbmljb2RlU3BhY2VzKHApO1xuXHRpZiAobm9ybWFsaXplZC5zdGFydHNXaXRoKFwifi9cIikpIHtcblx0XHRyZXR1cm4gcGF0aC5qb2luKG9zLmhvbWVkaXIoKSwgbm9ybWFsaXplZC5zbGljZSgyKSk7XG5cdH1cblx0aWYgKG5vcm1hbGl6ZWQuc3RhcnRzV2l0aChcIn5cIikpIHtcblx0XHRyZXR1cm4gcGF0aC5qb2luKG9zLmhvbWVkaXIoKSwgbm9ybWFsaXplZC5zbGljZSgxKSk7XG5cdH1cblx0cmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVQYXRoKGV4dFBhdGg6IHN0cmluZywgY3dkOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBleHBhbmRlZCA9IGV4cGFuZFBhdGgoZXh0UGF0aCk7XG5cdGlmIChwYXRoLmlzQWJzb2x1dGUoZXhwYW5kZWQpKSB7XG5cdFx0cmV0dXJuIGV4cGFuZGVkO1xuXHR9XG5cdHJldHVybiBwYXRoLnJlc29sdmUoY3dkLCBleHBhbmRlZCk7XG59XG5cbnR5cGUgSGFuZGxlckZuID0gKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gUHJvbWlzZTx1bmtub3duPjtcblxuLyoqXG4gKiBDcmVhdGUgYSBydW50aW1lIHdpdGggdGhyb3dpbmcgc3R1YnMgZm9yIGFjdGlvbiBtZXRob2RzLlxuICogUnVubmVyLmJpbmRDb3JlKCkgcmVwbGFjZXMgdGhlc2Ugd2l0aCByZWFsIGltcGxlbWVudGF0aW9ucy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUV4dGVuc2lvblJ1bnRpbWUoKTogRXh0ZW5zaW9uUnVudGltZSB7XG5cdGNvbnN0IG5vdEluaXRpYWxpemVkID0gKCkgPT4ge1xuXHRcdHRocm93IG5ldyBFcnJvcihcIkV4dGVuc2lvbiBydW50aW1lIG5vdCBpbml0aWFsaXplZC4gQWN0aW9uIG1ldGhvZHMgY2Fubm90IGJlIGNhbGxlZCBkdXJpbmcgZXh0ZW5zaW9uIGxvYWRpbmcuXCIpO1xuXHR9O1xuXG5cdGNvbnN0IHJ1bnRpbWU6IEV4dGVuc2lvblJ1bnRpbWUgPSB7XG5cdFx0c2VuZE1lc3NhZ2U6IG5vdEluaXRpYWxpemVkLFxuXHRcdHNlbmRVc2VyTWVzc2FnZTogbm90SW5pdGlhbGl6ZWQsXG5cdFx0cmV0cnlMYXN0VHVybjogbm90SW5pdGlhbGl6ZWQsXG5cdFx0YXBwZW5kRW50cnk6IG5vdEluaXRpYWxpemVkLFxuXHRcdHNldFNlc3Npb25OYW1lOiBub3RJbml0aWFsaXplZCxcblx0XHRnZXRTZXNzaW9uTmFtZTogbm90SW5pdGlhbGl6ZWQsXG5cdFx0c2V0TGFiZWw6IG5vdEluaXRpYWxpemVkLFxuXHRcdGdldEFjdGl2ZVRvb2xzOiBub3RJbml0aWFsaXplZCxcblx0XHRnZXRBbGxUb29sczogbm90SW5pdGlhbGl6ZWQsXG5cdFx0c2V0QWN0aXZlVG9vbHM6IG5vdEluaXRpYWxpemVkLFxuXHRcdGdldFZpc2libGVTa2lsbHM6IG5vdEluaXRpYWxpemVkLFxuXHRcdHNldFZpc2libGVTa2lsbHM6IG5vdEluaXRpYWxpemVkLFxuXHRcdC8vIHJlZ2lzdGVyVG9vbCgpIGlzIHZhbGlkIGR1cmluZyBleHRlbnNpb24gbG9hZDsgcmVmcmVzaCBpcyBvbmx5IG5lZWRlZCBwb3N0LWJpbmQuXG5cdFx0cmVmcmVzaFRvb2xzOiAoKSA9PiB7fSxcblx0XHRnZXRDb21tYW5kczogbm90SW5pdGlhbGl6ZWQsXG5cdFx0c2V0TW9kZWw6ICgpID0+IFByb21pc2UucmVqZWN0KG5ldyBFcnJvcihcIkV4dGVuc2lvbiBydW50aW1lIG5vdCBpbml0aWFsaXplZFwiKSksXG5cdFx0Z2V0VGhpbmtpbmdMZXZlbDogbm90SW5pdGlhbGl6ZWQsXG5cdFx0c2V0VGhpbmtpbmdMZXZlbDogbm90SW5pdGlhbGl6ZWQsXG5cdFx0ZmxhZ1ZhbHVlczogbmV3IE1hcCgpLFxuXHRcdHBlbmRpbmdQcm92aWRlclJlZ2lzdHJhdGlvbnM6IFtdLFxuXHRcdC8vIFByZS1iaW5kOiBxdWV1ZSByZWdpc3RyYXRpb25zIHNvIGJpbmRDb3JlKCkgY2FuIGZsdXNoIHRoZW0gb25jZSB0aGVcblx0XHQvLyBtb2RlbCByZWdpc3RyeSBpcyBhdmFpbGFibGUuIGJpbmRDb3JlKCkgcmVwbGFjZXMgYm90aCB3aXRoIGRpcmVjdCBjYWxscy5cblx0XHRyZWdpc3RlclByb3ZpZGVyOiAobmFtZSwgY29uZmlnKSA9PiB7XG5cdFx0XHRydW50aW1lLnBlbmRpbmdQcm92aWRlclJlZ2lzdHJhdGlvbnMucHVzaCh7IG5hbWUsIGNvbmZpZyB9KTtcblx0XHR9LFxuXHRcdHVucmVnaXN0ZXJQcm92aWRlcjogKG5hbWUpID0+IHtcblx0XHRcdHJ1bnRpbWUucGVuZGluZ1Byb3ZpZGVyUmVnaXN0cmF0aW9ucyA9IHJ1bnRpbWUucGVuZGluZ1Byb3ZpZGVyUmVnaXN0cmF0aW9ucy5maWx0ZXIoKHIpID0+IHIubmFtZSAhPT0gbmFtZSk7XG5cdFx0fSxcblx0XHQvLyBTdHVicyByZXBsYWNlZCBieSBFeHRlbnNpb25SdW5uZXIgYXQgY29uc3RydWN0aW9uIHRpbWUgdmlhIGJpbmRFbWl0TWV0aG9kcygpLlxuXHRcdGVtaXRCZWZvcmVNb2RlbFNlbGVjdDogYXN5bmMgKCkgPT4gdW5kZWZpbmVkLFxuXHRcdGVtaXRBZGp1c3RUb29sU2V0OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG5cdFx0ZW1pdEV4dGVuc2lvbkV2ZW50OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG5cdH07XG5cblx0cmV0dXJuIHJ1bnRpbWU7XG59XG5cbi8qKlxuICogQ3JlYXRlIHRoZSBFeHRlbnNpb25BUEkgZm9yIGFuIGV4dGVuc2lvbi5cbiAqIFJlZ2lzdHJhdGlvbiBtZXRob2RzIHdyaXRlIHRvIHRoZSBleHRlbnNpb24gb2JqZWN0LlxuICogQWN0aW9uIG1ldGhvZHMgZGVsZWdhdGUgdG8gdGhlIHNoYXJlZCBydW50aW1lLlxuICovXG5mdW5jdGlvbiBjcmVhdGVFeHRlbnNpb25BUEkoXG5cdGV4dGVuc2lvbjogRXh0ZW5zaW9uLFxuXHRydW50aW1lOiBFeHRlbnNpb25SdW50aW1lLFxuXHRjd2Q6IHN0cmluZyxcblx0ZXZlbnRCdXM6IEV2ZW50QnVzLFxuKTogRXh0ZW5zaW9uQVBJIHtcblx0Y29uc3QgYXBpID0ge1xuXHRcdC8vIFJlZ2lzdHJhdGlvbiBtZXRob2RzIC0gd3JpdGUgdG8gZXh0ZW5zaW9uXG5cdFx0b24oZXZlbnQ6IHN0cmluZywgaGFuZGxlcjogSGFuZGxlckZuKTogdm9pZCB7XG5cdFx0XHRjb25zdCBsaXN0ID0gZXh0ZW5zaW9uLmhhbmRsZXJzLmdldChldmVudCkgPz8gW107XG5cdFx0XHRsaXN0LnB1c2goaGFuZGxlcik7XG5cdFx0XHRleHRlbnNpb24uaGFuZGxlcnMuc2V0KGV2ZW50LCBsaXN0KTtcblx0XHR9LFxuXG5cdFx0cmVnaXN0ZXJUb29sKHRvb2w6IFRvb2xEZWZpbml0aW9uKTogdm9pZCB7XG5cdFx0XHRleHRlbnNpb24udG9vbHMuc2V0KHRvb2wubmFtZSwge1xuXHRcdFx0XHRkZWZpbml0aW9uOiB0b29sLFxuXHRcdFx0XHRleHRlbnNpb25QYXRoOiBleHRlbnNpb24ucGF0aCxcblx0XHRcdH0pO1xuXHRcdFx0Ly8gQURSLTAwNTogYXV0by1yZWdpc3RlciB0b29sIGNvbXBhdGliaWxpdHkgbWV0YWRhdGFcblx0XHRcdGlmICh0b29sLmNvbXBhdGliaWxpdHkpIHtcblx0XHRcdFx0cmVnaXN0ZXJUb29sQ29tcGF0aWJpbGl0eSh0b29sLm5hbWUsIHRvb2wuY29tcGF0aWJpbGl0eSk7XG5cdFx0XHR9XG5cdFx0XHRydW50aW1lLnJlZnJlc2hUb29scygpO1xuXHRcdH0sXG5cblx0XHRyZWdpc3RlckNvbW1hbmQobmFtZTogc3RyaW5nLCBvcHRpb25zOiBPbWl0PFJlZ2lzdGVyZWRDb21tYW5kLCBcIm5hbWVcIj4pOiB2b2lkIHtcblx0XHRcdGV4dGVuc2lvbi5jb21tYW5kcy5zZXQobmFtZSwgeyBuYW1lLCAuLi5vcHRpb25zIH0pO1xuXHRcdH0sXG5cblx0XHRyZWdpc3RlckJlZm9yZUluc3RhbGwoaGFuZGxlcjogTGlmZWN5Y2xlSG9va0hhbmRsZXIpOiB2b2lkIHtcblx0XHRcdGV4dGVuc2lvbi5saWZlY3ljbGVIb29rcy5iZWZvcmVJbnN0YWxsLnB1c2goaGFuZGxlcik7XG5cdFx0fSxcblxuXHRcdHJlZ2lzdGVyQWZ0ZXJJbnN0YWxsKGhhbmRsZXI6IExpZmVjeWNsZUhvb2tIYW5kbGVyKTogdm9pZCB7XG5cdFx0XHRleHRlbnNpb24ubGlmZWN5Y2xlSG9va3MuYWZ0ZXJJbnN0YWxsLnB1c2goaGFuZGxlcik7XG5cdFx0fSxcblxuXHRcdHJlZ2lzdGVyQmVmb3JlUmVtb3ZlKGhhbmRsZXI6IExpZmVjeWNsZUhvb2tIYW5kbGVyKTogdm9pZCB7XG5cdFx0XHRleHRlbnNpb24ubGlmZWN5Y2xlSG9va3MuYmVmb3JlUmVtb3ZlLnB1c2goaGFuZGxlcik7XG5cdFx0fSxcblxuXHRcdHJlZ2lzdGVyQWZ0ZXJSZW1vdmUoaGFuZGxlcjogTGlmZWN5Y2xlSG9va0hhbmRsZXIpOiB2b2lkIHtcblx0XHRcdGV4dGVuc2lvbi5saWZlY3ljbGVIb29rcy5hZnRlclJlbW92ZS5wdXNoKGhhbmRsZXIpO1xuXHRcdH0sXG5cblx0XHRyZWdpc3RlclNob3J0Y3V0KFxuXHRcdFx0c2hvcnRjdXQ6IEtleUlkLFxuXHRcdFx0b3B0aW9uczoge1xuXHRcdFx0XHRkZXNjcmlwdGlvbj86IHN0cmluZztcblx0XHRcdFx0aGFuZGxlcjogKGN0eDogaW1wb3J0KFwiLi90eXBlcy5qc1wiKS5FeHRlbnNpb25Db250ZXh0KSA9PiBQcm9taXNlPHZvaWQ+IHwgdm9pZDtcblx0XHRcdH0sXG5cdFx0KTogdm9pZCB7XG5cdFx0XHRleHRlbnNpb24uc2hvcnRjdXRzLnNldChzaG9ydGN1dCwgeyBzaG9ydGN1dCwgZXh0ZW5zaW9uUGF0aDogZXh0ZW5zaW9uLnBhdGgsIC4uLm9wdGlvbnMgfSk7XG5cdFx0fSxcblxuXHRcdHJlZ2lzdGVyRmxhZyhcblx0XHRcdG5hbWU6IHN0cmluZyxcblx0XHRcdG9wdGlvbnM6IHsgZGVzY3JpcHRpb24/OiBzdHJpbmc7IHR5cGU6IFwiYm9vbGVhblwiIHwgXCJzdHJpbmdcIjsgZGVmYXVsdD86IGJvb2xlYW4gfCBzdHJpbmcgfSxcblx0XHQpOiB2b2lkIHtcblx0XHRcdGV4dGVuc2lvbi5mbGFncy5zZXQobmFtZSwgeyBuYW1lLCBleHRlbnNpb25QYXRoOiBleHRlbnNpb24ucGF0aCwgLi4ub3B0aW9ucyB9KTtcblx0XHRcdGlmIChvcHRpb25zLmRlZmF1bHQgIT09IHVuZGVmaW5lZCAmJiAhcnVudGltZS5mbGFnVmFsdWVzLmhhcyhuYW1lKSkge1xuXHRcdFx0XHRydW50aW1lLmZsYWdWYWx1ZXMuc2V0KG5hbWUsIG9wdGlvbnMuZGVmYXVsdCk7XG5cdFx0XHR9XG5cdFx0fSxcblxuXHRcdHJlZ2lzdGVyTWVzc2FnZVJlbmRlcmVyPFQ+KGN1c3RvbVR5cGU6IHN0cmluZywgcmVuZGVyZXI6IE1lc3NhZ2VSZW5kZXJlcjxUPik6IHZvaWQge1xuXHRcdFx0ZXh0ZW5zaW9uLm1lc3NhZ2VSZW5kZXJlcnMuc2V0KGN1c3RvbVR5cGUsIHJlbmRlcmVyIGFzIE1lc3NhZ2VSZW5kZXJlcik7XG5cdFx0fSxcblxuXHRcdC8vIEZsYWcgYWNjZXNzIC0gY2hlY2tzIGV4dGVuc2lvbiByZWdpc3RlcmVkIGl0LCByZWFkcyBmcm9tIHJ1bnRpbWVcblx0XHRnZXRGbGFnKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4gfCBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRcdFx0aWYgKCFleHRlbnNpb24uZmxhZ3MuaGFzKG5hbWUpKSByZXR1cm4gdW5kZWZpbmVkO1xuXHRcdFx0cmV0dXJuIHJ1bnRpbWUuZmxhZ1ZhbHVlcy5nZXQobmFtZSk7XG5cdFx0fSxcblxuXHRcdC8vIEFjdGlvbiBtZXRob2RzIC0gZGVsZWdhdGUgdG8gc2hhcmVkIHJ1bnRpbWVcblx0XHRzZW5kTWVzc2FnZShtZXNzYWdlLCBvcHRpb25zKTogdm9pZCB7XG5cdFx0XHRydW50aW1lLnNlbmRNZXNzYWdlKG1lc3NhZ2UsIG9wdGlvbnMpO1xuXHRcdH0sXG5cblx0XHRzZW5kVXNlck1lc3NhZ2UoY29udGVudCwgb3B0aW9ucyk6IHZvaWQge1xuXHRcdFx0cnVudGltZS5zZW5kVXNlck1lc3NhZ2UoY29udGVudCwgb3B0aW9ucyk7XG5cdFx0fSxcblxuXHRcdHJldHJ5TGFzdFR1cm4oKTogdm9pZCB7XG5cdFx0XHRydW50aW1lLnJldHJ5TGFzdFR1cm4oKTtcblx0XHR9LFxuXG5cdFx0YXBwZW5kRW50cnkoY3VzdG9tVHlwZTogc3RyaW5nLCBkYXRhPzogdW5rbm93bik6IHZvaWQge1xuXHRcdFx0cnVudGltZS5hcHBlbmRFbnRyeShjdXN0b21UeXBlLCBkYXRhKTtcblx0XHR9LFxuXG5cdFx0c2V0U2Vzc2lvbk5hbWUobmFtZTogc3RyaW5nKTogdm9pZCB7XG5cdFx0XHRydW50aW1lLnNldFNlc3Npb25OYW1lKG5hbWUpO1xuXHRcdH0sXG5cblx0XHRnZXRTZXNzaW9uTmFtZSgpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuXHRcdFx0cmV0dXJuIHJ1bnRpbWUuZ2V0U2Vzc2lvbk5hbWUoKTtcblx0XHR9LFxuXG5cdFx0c2V0TGFiZWwoZW50cnlJZDogc3RyaW5nLCBsYWJlbDogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG5cdFx0XHRydW50aW1lLnNldExhYmVsKGVudHJ5SWQsIGxhYmVsKTtcblx0XHR9LFxuXG5cdFx0ZXhlYyhjb21tYW5kOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBvcHRpb25zPzogRXhlY09wdGlvbnMpIHtcblx0XHRcdHJldHVybiBleGVjQ29tbWFuZChjb21tYW5kLCBhcmdzLCBvcHRpb25zPy5jd2QgPz8gY3dkLCBvcHRpb25zKTtcblx0XHR9LFxuXG5cdFx0Z2V0QWN0aXZlVG9vbHMoKTogc3RyaW5nW10ge1xuXHRcdFx0cmV0dXJuIHJ1bnRpbWUuZ2V0QWN0aXZlVG9vbHMoKTtcblx0XHR9LFxuXG5cdFx0Z2V0QWxsVG9vbHMoKSB7XG5cdFx0XHRyZXR1cm4gcnVudGltZS5nZXRBbGxUb29scygpO1xuXHRcdH0sXG5cblx0XHRzZXRBY3RpdmVUb29scyh0b29sTmFtZXM6IHN0cmluZ1tdKTogdm9pZCB7XG5cdFx0XHRydW50aW1lLnNldEFjdGl2ZVRvb2xzKHRvb2xOYW1lcyk7XG5cdFx0fSxcblxuXHRcdGdldFZpc2libGVTa2lsbHMoKTogc3RyaW5nW10gfCB1bmRlZmluZWQge1xuXHRcdFx0cmV0dXJuIHJ1bnRpbWUuZ2V0VmlzaWJsZVNraWxscygpO1xuXHRcdH0sXG5cblx0XHRzZXRWaXNpYmxlU2tpbGxzKHNraWxsTmFtZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkKTogdm9pZCB7XG5cdFx0XHRydW50aW1lLnNldFZpc2libGVTa2lsbHMoc2tpbGxOYW1lcyk7XG5cdFx0fSxcblxuXHRcdGdldENvbW1hbmRzKCkge1xuXHRcdFx0cmV0dXJuIHJ1bnRpbWUuZ2V0Q29tbWFuZHMoKTtcblx0XHR9LFxuXG5cdFx0c2V0TW9kZWwobW9kZWwpIHtcblx0XHRcdHJldHVybiBydW50aW1lLnNldE1vZGVsKG1vZGVsKTtcblx0XHR9LFxuXG5cdFx0Z2V0VGhpbmtpbmdMZXZlbCgpIHtcblx0XHRcdHJldHVybiBydW50aW1lLmdldFRoaW5raW5nTGV2ZWwoKTtcblx0XHR9LFxuXG5cdFx0c2V0VGhpbmtpbmdMZXZlbChsZXZlbCkge1xuXHRcdFx0cnVudGltZS5zZXRUaGlua2luZ0xldmVsKGxldmVsKTtcblx0XHR9LFxuXG5cdFx0cmVnaXN0ZXJQcm92aWRlcihuYW1lOiBzdHJpbmcsIGNvbmZpZzogUHJvdmlkZXJDb25maWcpIHtcblx0XHRcdHJ1bnRpbWUucmVnaXN0ZXJQcm92aWRlcihuYW1lLCBjb25maWcpO1xuXHRcdH0sXG5cblx0XHR1bnJlZ2lzdGVyUHJvdmlkZXIobmFtZTogc3RyaW5nKSB7XG5cdFx0XHRydW50aW1lLnVucmVnaXN0ZXJQcm92aWRlcihuYW1lKTtcblx0XHR9LFxuXG5cdFx0YXN5bmMgZW1pdEJlZm9yZU1vZGVsU2VsZWN0KGV2ZW50OiBPbWl0PGltcG9ydChcIi4vdHlwZXMuanNcIikuQmVmb3JlTW9kZWxTZWxlY3RFdmVudCwgXCJ0eXBlXCI+KTogUHJvbWlzZTxpbXBvcnQoXCIuL3R5cGVzLmpzXCIpLkJlZm9yZU1vZGVsU2VsZWN0UmVzdWx0IHwgdW5kZWZpbmVkPiB7XG5cdFx0XHRyZXR1cm4gcnVudGltZS5lbWl0QmVmb3JlTW9kZWxTZWxlY3QoZXZlbnQpO1xuXHRcdH0sXG5cblx0XHRhc3luYyBlbWl0QWRqdXN0VG9vbFNldChldmVudDogT21pdDxpbXBvcnQoXCIuL3R5cGVzLmpzXCIpLkFkanVzdFRvb2xTZXRFdmVudCwgXCJ0eXBlXCI+KTogUHJvbWlzZTxpbXBvcnQoXCIuL3R5cGVzLmpzXCIpLkFkanVzdFRvb2xTZXRSZXN1bHQgfCB1bmRlZmluZWQ+IHtcblx0XHRcdHJldHVybiBydW50aW1lLmVtaXRBZGp1c3RUb29sU2V0KGV2ZW50KTtcblx0XHR9LFxuXG5cdFx0YXN5bmMgZW1pdEV4dGVuc2lvbkV2ZW50KGV2ZW50OiBpbXBvcnQoXCIuL3R5cGVzLmpzXCIpLkV4dGVuc2lvbkV2ZW50KTogUHJvbWlzZTx1bmtub3duPiB7XG5cdFx0XHRyZXR1cm4gcnVudGltZS5lbWl0RXh0ZW5zaW9uRXZlbnQoZXZlbnQpO1xuXHRcdH0sXG5cblx0XHRldmVudHM6IGV2ZW50QnVzLFxuXHR9IGFzIEV4dGVuc2lvbkFQSTtcblxuXHRyZXR1cm4gYXBpO1xufVxuXG4vKipcbiAqIEhldXJpc3RpYyBwYXR0ZXJucyB0aGF0IGluZGljYXRlIFR5cGVTY3JpcHQgc3ludGF4IGluIGEgc291cmNlIGZpbGUuXG4gKiBVc2VkIHRvIGRldGVjdCB3aGVuIGEgLmpzIGZpbGUgYWNjaWRlbnRhbGx5IGNvbnRhaW5zIFR5cGVTY3JpcHQgY29kZVxuICogYW5kIHByb3ZpZGUgYSBoZWxwZnVsIGVycm9yIG1lc3NhZ2UgaW5zdGVhZCBvZiBhIGNyeXB0aWMgcGFyc2UgZmFpbHVyZS5cbiAqL1xuY29uc3QgVFNfU1lOVEFYX1BBVFRFUk5TOiBSZWdFeHBbXSA9IFtcblx0Ly8gVmFyaWFibGUgdHlwZSBhbm5vdGF0aW9uczogY29uc3QgbmFtZTogc3RyaW5nLCBsZXQgY291bnQ6IG51bWJlclxuXHQvXFxiKD86Y29uc3R8bGV0fHZhcilcXHMrXFx3K1xccyo6XFxzKig/OnN0cmluZ3xudW1iZXJ8Ym9vbGVhbnxhbnl8dm9pZHxuZXZlcnx1bmtub3dufG9iamVjdHxiaWdpbnR8c3ltYm9sfHVuZGVmaW5lZHxudWxsKVxcYi8sXG5cdC8vIFBhcmFtZXRlciB0eXBlIGFubm90YXRpb25zOiAoYXBpOiBFeHRlbnNpb25BUEkpXG5cdC9cXChcXHMqXFx3K1xccyo6XFxzKltBLVpdXFx3Ki8sXG5cdC8vIFJldHVybiB0eXBlIGFubm90YXRpb25zOiApOiBQcm9taXNlPHZvaWQ+IHsgIG9yICApOiBzdHJpbmcgPT5cblx0L1xcKVxccyo6XFxzKig/OlByb21pc2V8c3RyaW5nfG51bWJlcnxib29sZWFufHZvaWR8YW55fG5ldmVyfHVua25vd24pXFxiLyxcblx0Ly8gSW50ZXJmYWNlIGRlY2xhcmF0aW9uc1xuXHQvXFxiaW50ZXJmYWNlXFxzK1tBLVpdXFx3KlxccyooPzo8W14+XSo+KT9cXHMqXFx7Lyxcblx0Ly8gVHlwZSBhbGlhcyBkZWNsYXJhdGlvbnNcblx0L1xcYnR5cGVcXHMrW0EtWl1cXHcqXFxzKig/OjxbXj5dKj4pP1xccyo9Lyxcblx0Ly8gQW5nbGUtYnJhY2tldCB0eXBlIGFzc2VydGlvbnM6IDxUeXBlPnZhbHVlXG5cdC8oPzphc1xccytcXHcrKD86PFtePl0qPik/KVxccypbOywpXFxdfV0vLFxuXHQvLyBHZW5lcmljIHR5cGUgcGFyYW1ldGVycyBvbiBmdW5jdGlvbnM6IGZ1bmN0aW9uIGZvbzxUPlxuXHQvXFxiZnVuY3Rpb25cXHMrXFx3K1xccyo8W14+XSs+Lyxcblx0Ly8gRW51bSBkZWNsYXJhdGlvbnNcblx0L1xcYmVudW1cXHMrW0EtWl1cXHcqXFxzKlxcey8sXG5dO1xuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBzb3VyY2Ugc3RyaW5nIGxpa2VseSBjb250YWlucyBUeXBlU2NyaXB0IHN5bnRheC5cbiAqIFRoaXMgaXMgYSBoZXVyaXN0aWMgXHUyMDE0IGl0IG1heSBwcm9kdWNlIGZhbHNlIHBvc2l0aXZlcyBmb3IgdW51c3VhbCBKUyxcbiAqIGJ1dCBpcyB0dW5lZCB0byBjYXRjaCB0aGUgbW9zdCBjb21tb24gVFMtaW4tSlMgbWlzdGFrZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250YWluc1R5cGVTY3JpcHRTeW50YXgoc291cmNlOiBzdHJpbmcpOiBib29sZWFuIHtcblx0cmV0dXJuIFRTX1NZTlRBWF9QQVRURVJOUy5zb21lKChwYXR0ZXJuKSA9PiBwYXR0ZXJuLnRlc3Qoc291cmNlKSk7XG59XG5cbi8qKlxuICogU2hhcmVkIGppdGkgaW5zdGFuY2UgZm9yIGxvYWRpbmcgZXh0ZW5zaW9uIG1vZHVsZXMuXG4gKlxuICogQmVmb3JlIHRoaXMgZml4ICgjMjEwOCksIGVhY2ggZXh0ZW5zaW9uIGNyZWF0ZWQgYSBORVcgaml0aSBpbnN0YW5jZSB3aXRoXG4gKiBgbW9kdWxlQ2FjaGU6IGZhbHNlYCwgY2F1c2luZyBzaGFyZWQgZGVwZW5kZW5jaWVzIChlLmcuIEBnc2QvcGktYWdlbnQtY29yZSlcbiAqIHRvIGJlIHJlY29tcGlsZWQgZm9yIGV2ZXJ5IGV4dGVuc2lvbiBcdTIwMTQgdHVybmluZyBhIH4zcyBwYXJhbGxlbCBsb2FkIGludG8gYVxuICogfjE1LTMwcyBzZXJpYWwgY29tcGlsYXRpb24gYm90dGxlbmVjay5cbiAqXG4gKiBVc2luZyBhIHNpbmdsZSBzaGFyZWQgaW5zdGFuY2Ugd2l0aCBgbW9kdWxlQ2FjaGU6IHRydWVgIG1lYW5zIHNoYXJlZCBtb2R1bGVzXG4gKiBhcmUgY29tcGlsZWQgb25jZSBhbmQgcmV1c2VkIGFjcm9zcyBhbGwgZXh0ZW5zaW9ucy5cbiAqL1xubGV0IF9leHRlbnNpb25Mb2FkZXJKaXRpOiBSZXR1cm5UeXBlPHR5cGVvZiBjcmVhdGVKaXRpPiB8IG51bGwgPSBudWxsO1xuLy8gVHJhY2tzIGV2ZXJ5IGV4dGVuc2lvbi1tb2R1bGUgcGF0aCB0aGF0IGppdGkgaGFzIGNvbXBpbGVkIHRocm91Z2ggdGhlIHNoYXJlZFxuLy8gc2luZ2xldG9uIHNvIHJlc2V0RXh0ZW5zaW9uTG9hZGVyQ2FjaGUoKSBjYW4gYWxzbyBldmljdCBOb2RlJ3MgZ2xvYmFsXG4vLyByZXF1aXJlLmNhY2hlIGVudHJpZXMgZm9yIHRob3NlIG1vZHVsZXMuIGppdGkgc3RvcmVzIGNvbXBpbGVkIG1vZHVsZXMgdW5kZXJcbi8vIGBuYXRpdmVSZXF1aXJlLmNhY2hlW2ZpbGVuYW1lXWAgd2hlbiBgbW9kdWxlQ2FjaGU6IHRydWVgLCBzbyBhIG5ldyBzaW5nbGV0b25cbi8vIHN0aWxsIHJldHVybnMgdGhlIHN0YWxlIGNhY2hlZCBtb2R1bGUgb24gcmUtaW1wb3J0IHdpdGhvdXQgdGhpcyBldmljdGlvbi5cbmNvbnN0IF9sb2FkZWRFeHRlbnNpb25QYXRocyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuY29uc3QgX2V4dGVuc2lvblJlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cbi8qKlxuICogUmVzZXQgdGhlIHNoYXJlZCBqaXRpIHNpbmdsZXRvbiBzbyB0aGUgbmV4dCBjYWxsIHRvIGdldEV4dGVuc2lvbkxvYWRlckppdGkoKVxuICogY3JlYXRlcyBhIGZyZXNoIGluc3RhbmNlLiAgVGhpcyBwcmV2ZW50cyBtZW1vcnkgbGVha3MgaW4gbG9uZy1ydW5uaW5nIGRhZW1vblxuICogcHJvY2Vzc2VzIChldmVyeSBsb2FkZWQgbW9kdWxlIHN0YXlzIGNhY2hlZCBmb3JldmVyKSBhbmQgZW5zdXJlcyBzdGFsZSBtb2R1bGVzXG4gKiBhcmUgbm90IHJldHVybmVkIHdoZW4gZXh0ZW5zaW9uIHNvdXJjZSBjaGFuZ2VzIG9uIGRpc2suXG4gKlxuICogIzM2MTY6IHJlc2V0dGluZyB0aGUgc2luZ2xldG9uIGFsb25lIGlzIGluc3VmZmljaWVudCBcdTIwMTQgaml0aSBzdG9yZXMgY29tcGlsZWRcbiAqIG1vZHVsZXMgaW4gTm9kZSdzIGdsb2JhbCByZXF1aXJlLmNhY2hlIHdoZW4gYG1vZHVsZUNhY2hlOiB0cnVlYCwgd2hpY2ggaXNcbiAqIHNoYXJlZCBhY3Jvc3Mgc2luZ2xldG9ucy4gV2UgYWxzbyBldmljdCBjYWNoZWQgZW50cmllcyBmb3IgZXZlcnkgZXh0ZW5zaW9uXG4gKiBwYXRoIHdlJ3ZlIHByZXZpb3VzbHkgbG9hZGVkIHNvIHRoZSBuZXh0IGltcG9ydCByZWNvbXBpbGVzIGZyb20gZGlzay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0RXh0ZW5zaW9uTG9hZGVyQ2FjaGUoKTogdm9pZCB7XG5cdF9leHRlbnNpb25Mb2FkZXJKaXRpID0gbnVsbDtcblx0Ly8gQnVpbGQgYSBzZXQgb2YgZXhhY3QgY2FjaGUga2V5cyB3ZSBleHBlY3QgKHJhdyBwYXRoLCByZXNvbHZlZCBwYXRoLFxuXHQvLyByZWFscGF0aCkgQU5EIGEgc2V0IG9mIChiYXNlbmFtZSwgY29udGFpbmluZy1kaXJlY3RvcnkpIHBhaXJzIHNvIHdlXG5cdC8vIGNhbiBhbHNvIGNhdGNoIGVudHJpZXMgdGhhdCBqaXRpL05vZGUgd3JvdGUgdW5kZXIgYSBjYW5vbmljYWxpemVkXG5cdC8vIGZvcm0gKFdpbmRvd3MgZHJpdmUtbGV0dGVyIGNhc2UsIHNlcGFyYXRvciBzd2FwLCBVTkMgcHJlZml4LCBzeW1saW5rXG5cdC8vIHJlc29sdXRpb24pLiByZXF1aXJlLmNhY2hlIGlzIHNoYXJlZCBhY3Jvc3MgYWxsIGNyZWF0ZVJlcXVpcmVcblx0Ly8gaW5zdGFuY2VzIGZvciBDSlMsIHNvIGl0ZXJhdGluZyBhbnkgaW5zdGFuY2UncyBjYWNoZSBjb3ZlcnMgaml0aSdzXG5cdC8vIGludGVybmFsIGBuYXRpdmVSZXF1aXJlLmNhY2hlYCB3cml0ZXMuXG5cdGNvbnN0IGV4YWN0ID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdGNvbnN0IHNpZ25hdHVyZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0Y29uc3QgbWFrZVNpZ25hdHVyZSA9IChwOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuXHRcdGNvbnN0IG5vcm1hbGl6ZWQgPSBwLnJlcGxhY2UoL1xcXFwvZywgXCIvXCIpLnRvTG93ZXJDYXNlKCk7XG5cdFx0Y29uc3Qgc2xhc2ggPSBub3JtYWxpemVkLmxhc3RJbmRleE9mKFwiL1wiKTtcblx0XHRjb25zdCBiYXNlID0gc2xhc2ggPj0gMCA/IG5vcm1hbGl6ZWQuc2xpY2Uoc2xhc2ggKyAxKSA6IG5vcm1hbGl6ZWQ7XG5cdFx0Ly8gVXNlIHRoZSB0cmFpbGluZyB0d28gcGF0aCBzZWdtZW50cyBhcyB0aGUgc2lnbmF0dXJlIFx1MjAxNCB1bmlxdWVcblx0XHQvLyBlbm91Z2ggdG8gYXZvaWQgY29sbGlzaW9ucyBpbiB0eXBpY2FsIGZpbGVzeXN0ZW1zIHdoaWxlIHRvbGVyYXRpbmdcblx0XHQvLyBkcml2ZS1sZXR0ZXIgLyBzZXBhcmF0b3IgdmFyaWF0aW9ucyB0aGF0IGRpZmZlciBpbiB0aGUgcHJlZml4LlxuXHRcdGNvbnN0IHBhcmVudCA9IHNsYXNoID49IDAgPyBub3JtYWxpemVkLnNsaWNlKDAsIHNsYXNoKSA6IFwiXCI7XG5cdFx0Y29uc3QgcGFyZW50U2xhc2ggPSBwYXJlbnQubGFzdEluZGV4T2YoXCIvXCIpO1xuXHRcdGNvbnN0IHBhcmVudFNlZyA9IHBhcmVudFNsYXNoID49IDAgPyBwYXJlbnQuc2xpY2UocGFyZW50U2xhc2ggKyAxKSA6IHBhcmVudDtcblx0XHRyZXR1cm4gYCR7cGFyZW50U2VnfS8ke2Jhc2V9YDtcblx0fTtcblx0Zm9yIChjb25zdCByYXcgb2YgX2xvYWRlZEV4dGVuc2lvblBhdGhzKSB7XG5cdFx0ZXhhY3QuYWRkKHJhdyk7XG5cdFx0dHJ5IHtcblx0XHRcdGV4YWN0LmFkZChfZXh0ZW5zaW9uUmVxdWlyZS5yZXNvbHZlKHJhdykpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gdW5yZXNvbHZhYmxlIFx1MjAxNCBmYWxsIHRocm91Z2g7IHNpZ25hdHVyZSBzY2FuIG1heSBzdGlsbCBoaXQgaXRcblx0XHR9XG5cdFx0dHJ5IHtcblx0XHRcdGV4YWN0LmFkZChmcy5yZWFscGF0aFN5bmMocmF3KSk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBmaWxlIG1heSBoYXZlIGJlZW4gZGVsZXRlZCBhbHJlYWR5OyBpZ25vcmVcblx0XHR9XG5cdFx0c2lnbmF0dXJlcy5hZGQobWFrZVNpZ25hdHVyZShyYXcpKTtcblx0fVxuXHRmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhfZXh0ZW5zaW9uUmVxdWlyZS5jYWNoZSkpIHtcblx0XHRpZiAoZXhhY3QuaGFzKGtleSkgfHwgc2lnbmF0dXJlcy5oYXMobWFrZVNpZ25hdHVyZShrZXkpKSkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0ZGVsZXRlIF9leHRlbnNpb25SZXF1aXJlLmNhY2hlW2tleV07XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0Ly8gcmVxdWlyZS5jYWNoZSBpcyBiZXN0LWVmZm9ydDsgaWdub3JlIGZhaWx1cmVzIChlLmcuIGZyb3plbiBjYWNoZSkuXG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cdF9sb2FkZWRFeHRlbnNpb25QYXRocy5jbGVhcigpO1xufVxuXG5mdW5jdGlvbiBnZXRFeHRlbnNpb25Mb2FkZXJKaXRpKCkge1xuXHRpZiAoIV9leHRlbnNpb25Mb2FkZXJKaXRpKSB7XG5cdFx0X2V4dGVuc2lvbkxvYWRlckppdGkgPSBjcmVhdGVKaXRpKGltcG9ydC5tZXRhLnVybCwge1xuXHRcdFx0bW9kdWxlQ2FjaGU6IHRydWUsXG5cdFx0XHQuLi5nZXRKaXRpT3B0aW9ucygpLFxuXHRcdH0pO1xuXHR9XG5cdHJldHVybiBfZXh0ZW5zaW9uTG9hZGVySml0aTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZEV4dGVuc2lvbk1vZHVsZShleHRlbnNpb25QYXRoOiBzdHJpbmcpIHtcblx0Ly8gUHJlLWNvbXBpbGVkIGV4dGVuc2lvbiBsb2FkaW5nOiBpZiB0aGUgc291cmNlIGlzIC50cyBhbmQgYSBzaWJsaW5nIC5qc1xuXHQvLyBmaWxlIGV4aXN0cyB3aXRoIG1hdGNoaW5nIG9yIG5ld2VyIG10aW1lLCB1c2UgbmF0aXZlIGltcG9ydCgpIHRvIHNraXBcblx0Ly8gaml0aSBKSVQgY29tcGlsYXRpb24gZW50aXJlbHkuICBUaGlzIGlzIHRoZSBiaWdnZXN0IHN0YXJ0dXAgd2luIGZvclxuXHQvLyBidW5kbGVkIGV4dGVuc2lvbnMgdGhhdCBoYXZlIGFscmVhZHkgYmVlbiBidWlsdC5cblx0aWYgKGV4dGVuc2lvblBhdGguZW5kc1dpdGgoXCIudHNcIikpIHtcblx0XHRjb25zdCBqc1BhdGggPSBleHRlbnNpb25QYXRoLnJlcGxhY2UoL1xcLnRzJC8sIFwiLmpzXCIpO1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBbdHNTdGF0LCBqc1N0YXRdID0gW2ZzLnN0YXRTeW5jKGV4dGVuc2lvblBhdGgpLCBmcy5zdGF0U3luYyhqc1BhdGgpXTtcblx0XHRcdGlmIChqc1N0YXQubXRpbWVNcyA+PSB0c1N0YXQubXRpbWVNcykge1xuXHRcdFx0XHRjb25zdCBtb2R1bGUgPSBhd2FpdCBpbXBvcnQoanNQYXRoKTtcblx0XHRcdFx0Y29uc3QgZmFjdG9yeSA9IChtb2R1bGUuZGVmYXVsdCA/PyBtb2R1bGUpIGFzIEV4dGVuc2lvbkZhY3Rvcnk7XG5cdFx0XHRcdHJldHVybiB0eXBlb2YgZmFjdG9yeSAhPT0gXCJmdW5jdGlvblwiID8gdW5kZWZpbmVkIDogZmFjdG9yeTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIC5qcyBmaWxlIGRvZXNuJ3QgZXhpc3Qgb3Igc3RhdCBmYWlsZWQgXHUyMDE0IGZhbGwgdGhyb3VnaCB0byBqaXRpXG5cdFx0fVxuXHR9XG5cblx0Y29uc3Qgaml0aSA9IGdldEV4dGVuc2lvbkxvYWRlckppdGkoKTtcblxuXHRjb25zdCBtb2R1bGUgPSBhd2FpdCBqaXRpLmltcG9ydChleHRlbnNpb25QYXRoLCB7IGRlZmF1bHQ6IHRydWUgfSk7XG5cdF9sb2FkZWRFeHRlbnNpb25QYXRocy5hZGQoZXh0ZW5zaW9uUGF0aCk7XG5cdGNvbnN0IGZhY3RvcnkgPSBtb2R1bGUgYXMgRXh0ZW5zaW9uRmFjdG9yeTtcblx0cmV0dXJuIHR5cGVvZiBmYWN0b3J5ICE9PSBcImZ1bmN0aW9uXCIgPyB1bmRlZmluZWQgOiBmYWN0b3J5O1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBtb2R1bGUgcGF0aCBiZWxvbmdzIHRvIGEgbm9uLWV4dGVuc2lvbiBsaWJyYXJ5IHRoYXQgc2hvdWxkXG4gKiBiZSBzaWxlbnRseSBza2lwcGVkIHJhdGhlciB0aGFuIHJlcG9ydGVkIGFzIGFuIGVycm9yLlxuICpcbiAqIEEgZGlyZWN0b3J5IGlzIGEgbm9uLWV4dGVuc2lvbiBsaWJyYXJ5IHdoZW4gaXRzIHBhY2thZ2UuanNvbiBoYXMgYSBcInBpXCJcbiAqIG1hbmlmZXN0IHRoYXQgZGVjbGFyZXMgbm8gZXh0ZW5zaW9ucyAoZS5nLiBgXCJwaVwiOiB7fWApLiBUaGlzIGlzIHRoZVxuICogb3B0LW91dCBjb252ZW50aW9uIHVzZWQgYnkgc2hhcmVkIGxpYnJhcmllcyBsaWtlIGNtdXggdGhhdCBsaXZlIGluc2lkZVxuICogdGhlIGV4dGVuc2lvbnMvIGRpcmVjdG9yeSBidXQgYXJlIG5vdCBleHRlbnNpb25zIHRoZW1zZWx2ZXMuXG4gKlxuICogVGhpcyBzZXJ2ZXMgYXMgYSBkZWZlbnNlLWluLWRlcHRoIGNoZWNrOiBldmVuIGlmIHRoZSB1cHN0cmVhbSBkaXNjb3ZlcnlcbiAqIGxheWVycyBmYWlsIHRvIGZpbHRlciBvdXQgdGhlIGxpYnJhcnksIHRoZSBsb2FkZXIgaXRzZWxmIHdpbGwgbm90IGVtaXRcbiAqIGEgc3B1cmlvdXMgZXJyb3IuXG4gKi9cbmZ1bmN0aW9uIGlzTm9uRXh0ZW5zaW9uTGlicmFyeShyZXNvbHZlZFBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHQvLyBXYWxrIHVwIGZyb20gdGhlIHJlc29sdmVkIGZpbGUgdG8gZmluZCB0aGUgbmVhcmVzdCBwYWNrYWdlLmpzb25cblx0bGV0IGRpciA9IHBhdGguZGlybmFtZShyZXNvbHZlZFBhdGgpO1xuXHRjb25zdCByb290ID0gcGF0aC5wYXJzZShkaXIpLnJvb3Q7XG5cdHdoaWxlIChkaXIgIT09IHJvb3QpIHtcblx0XHRjb25zdCBwYWNrYWdlSnNvblBhdGggPSBwYXRoLmpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKTtcblx0XHRpZiAoZnMuZXhpc3RzU3luYyhwYWNrYWdlSnNvblBhdGgpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gZnMucmVhZEZpbGVTeW5jKHBhY2thZ2VKc29uUGF0aCwgXCJ1dGYtOFwiKTtcblx0XHRcdFx0Y29uc3QgcGtnID0gSlNPTi5wYXJzZShjb250ZW50KTtcblx0XHRcdFx0aWYgKHBrZy5waSAmJiB0eXBlb2YgcGtnLnBpID09PSBcIm9iamVjdFwiKSB7XG5cdFx0XHRcdFx0Ly8gSGFzIGEgcGkgbWFuaWZlc3QgXHUyMDE0IGNoZWNrIGlmIGl0IGRlY2xhcmVzIGFueSBleHRlbnNpb25zXG5cdFx0XHRcdFx0Y29uc3QgZXh0ZW5zaW9ucyA9IHBrZy5waS5leHRlbnNpb25zO1xuXHRcdFx0XHRcdGlmICghQXJyYXkuaXNBcnJheShleHRlbnNpb25zKSB8fCBleHRlbnNpb25zLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0Ly8gTWFsZm9ybWVkIHBhY2thZ2UuanNvbiBcdTIwMTQgbm90IGEga25vd24gbGlicmFyeVxuXHRcdFx0fVxuXHRcdFx0YnJlYWs7XG5cdFx0fVxuXHRcdGRpciA9IHBhdGguZGlybmFtZShkaXIpO1xuXHR9XG5cdHJldHVybiBmYWxzZTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgYW4gRXh0ZW5zaW9uIG9iamVjdCB3aXRoIGVtcHR5IGNvbGxlY3Rpb25zLlxuICovXG5mdW5jdGlvbiBjcmVhdGVFeHRlbnNpb24oZXh0ZW5zaW9uUGF0aDogc3RyaW5nLCByZXNvbHZlZFBhdGg6IHN0cmluZyk6IEV4dGVuc2lvbiB7XG5cdHJldHVybiB7XG5cdFx0cGF0aDogZXh0ZW5zaW9uUGF0aCxcblx0XHRyZXNvbHZlZFBhdGgsXG5cdFx0aGFuZGxlcnM6IG5ldyBNYXAoKSxcblx0XHR0b29sczogbmV3IE1hcCgpLFxuXHRcdG1lc3NhZ2VSZW5kZXJlcnM6IG5ldyBNYXAoKSxcblx0XHRjb21tYW5kczogbmV3IE1hcCgpLFxuXHRcdGZsYWdzOiBuZXcgTWFwKCksXG5cdFx0c2hvcnRjdXRzOiBuZXcgTWFwKCksXG5cdFx0bGlmZWN5Y2xlSG9va3M6IHtcblx0XHRcdGJlZm9yZUluc3RhbGw6IFtdLFxuXHRcdFx0YWZ0ZXJJbnN0YWxsOiBbXSxcblx0XHRcdGJlZm9yZVJlbW92ZTogW10sXG5cdFx0XHRhZnRlclJlbW92ZTogW10sXG5cdFx0fSxcblx0fTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZEV4dGVuc2lvbihcblx0ZXh0ZW5zaW9uUGF0aDogc3RyaW5nLFxuXHRjd2Q6IHN0cmluZyxcblx0ZXZlbnRCdXM6IEV2ZW50QnVzLFxuXHRydW50aW1lOiBFeHRlbnNpb25SdW50aW1lLFxuKTogUHJvbWlzZTx7IGV4dGVuc2lvbjogRXh0ZW5zaW9uIHwgbnVsbDsgZXJyb3I6IHN0cmluZyB8IG51bGwgfT4ge1xuXHRjb25zdCByZXNvbHZlZFBhdGggPSByZXNvbHZlUGF0aChleHRlbnNpb25QYXRoLCBjd2QpO1xuXHRjb25zdCBzdGFydCA9IERhdGUubm93KCk7XG5cblx0dHJ5IHtcblx0XHRjb25zdCBmYWN0b3J5ID0gYXdhaXQgbG9hZEV4dGVuc2lvbk1vZHVsZShyZXNvbHZlZFBhdGgpO1xuXHRcdGlmICghZmFjdG9yeSkge1xuXHRcdFx0Ly8gRGVmZW5zZS1pbi1kZXB0aDogaWYgdGhlIG1vZHVsZSBpcyBpbnNpZGUgYSBkaXJlY3RvcnkgdGhhdCBoYXNcblx0XHRcdC8vIGV4cGxpY2l0bHkgb3B0ZWQgb3V0IG9mIGV4dGVuc2lvbiBsb2FkaW5nIHZpYSBpdHMgcGkgbWFuaWZlc3QsXG5cdFx0XHQvLyBzaWxlbnRseSBza2lwIGl0IGluc3RlYWQgb2YgcmVwb3J0aW5nIGEgc3B1cmlvdXMgZXJyb3IuXG5cdFx0XHRpZiAoaXNOb25FeHRlbnNpb25MaWJyYXJ5KHJlc29sdmVkUGF0aCkpIHtcblx0XHRcdFx0cmV0dXJuIHsgZXh0ZW5zaW9uOiBudWxsLCBlcnJvcjogbnVsbCB9O1xuXHRcdFx0fVxuXHRcdFx0bG9nRXh0ZW5zaW9uVGltaW5nKGV4dGVuc2lvblBhdGgsIERhdGUubm93KCkgLSBzdGFydCwgXCJmYWlsZWRcIik7XG5cblx0XHRcdC8vIENoZWNrIGlmIGEgLmpzIGZpbGUgY29udGFpbnMgVHlwZVNjcmlwdCBzeW50YXhcblx0XHRcdGlmIChyZXNvbHZlZFBhdGguZW5kc1dpdGgoXCIuanNcIikpIHtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRjb25zdCBzb3VyY2UgPSBmcy5yZWFkRmlsZVN5bmMocmVzb2x2ZWRQYXRoLCBcInV0Zi04XCIpO1xuXHRcdFx0XHRcdGlmIChjb250YWluc1R5cGVTY3JpcHRTeW50YXgoc291cmNlKSkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0ZXh0ZW5zaW9uOiBudWxsLFxuXHRcdFx0XHRcdFx0XHRlcnJvcjogYEV4dGVuc2lvbiBmaWxlIFwiJHtleHRlbnNpb25QYXRofVwiIGFwcGVhcnMgdG8gY29udGFpbiBUeXBlU2NyaXB0IHN5bnRheCBidXQgaGFzIGEgLmpzIGV4dGVuc2lvbi4gUmVuYW1lIGl0IHRvIC50cyBzbyB0aGUgbG9hZGVyIGNhbiBjb21waWxlIGl0LmAsXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0Ly8gQ291bGQgbm90IHJlYWQgZmlsZSBcdTIwMTQgZmFsbCB0aHJvdWdoIHRvIGdlbmVyaWMgZXJyb3Jcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4geyBleHRlbnNpb246IG51bGwsIGVycm9yOiBgRXh0ZW5zaW9uIGRvZXMgbm90IGV4cG9ydCBhIHZhbGlkIGZhY3RvcnkgZnVuY3Rpb246ICR7ZXh0ZW5zaW9uUGF0aH1gIH07XG5cdFx0fVxuXG5cdFx0Y29uc3QgZXh0ZW5zaW9uID0gY3JlYXRlRXh0ZW5zaW9uKGV4dGVuc2lvblBhdGgsIHJlc29sdmVkUGF0aCk7XG5cdFx0Y29uc3QgYXBpID0gY3JlYXRlRXh0ZW5zaW9uQVBJKGV4dGVuc2lvbiwgcnVudGltZSwgY3dkLCBldmVudEJ1cyk7XG5cdFx0YXdhaXQgZmFjdG9yeShhcGkpO1xuXHRcdGxvZ0V4dGVuc2lvblRpbWluZyhleHRlbnNpb25QYXRoLCBEYXRlLm5vdygpIC0gc3RhcnQsIFwibG9hZGVkXCIpO1xuXG5cdFx0cmV0dXJuIHsgZXh0ZW5zaW9uLCBlcnJvcjogbnVsbCB9O1xuXHR9IGNhdGNoIChlcnIpIHtcblx0XHRjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdGxvZ0V4dGVuc2lvblRpbWluZyhleHRlbnNpb25QYXRoLCBEYXRlLm5vdygpIC0gc3RhcnQsIFwiZmFpbGVkXCIpO1xuXG5cdFx0Ly8gQ2hlY2sgaWYgYSAuanMgZmlsZSBjb250YWlucyBUeXBlU2NyaXB0IHN5bnRheCBcdTIwMTQgdGhlIHBhcnNlIGVycm9yIGZyb21cblx0XHQvLyBqaXRpL05vZGUgaXMgb2Z0ZW4gY3J5cHRpYywgc28gc3VyZmFjZSBhIGNsZWFyZXIgZGlhZ25vc3RpYy5cblx0XHRpZiAocmVzb2x2ZWRQYXRoLmVuZHNXaXRoKFwiLmpzXCIpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBzb3VyY2UgPSBmcy5yZWFkRmlsZVN5bmMocmVzb2x2ZWRQYXRoLCBcInV0Zi04XCIpO1xuXHRcdFx0XHRpZiAoY29udGFpbnNUeXBlU2NyaXB0U3ludGF4KHNvdXJjZSkpIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0ZXh0ZW5zaW9uOiBudWxsLFxuXHRcdFx0XHRcdFx0ZXJyb3I6IGBFeHRlbnNpb24gZmlsZSBcIiR7ZXh0ZW5zaW9uUGF0aH1cIiBhcHBlYXJzIHRvIGNvbnRhaW4gVHlwZVNjcmlwdCBzeW50YXggYnV0IGhhcyBhIC5qcyBleHRlbnNpb24uIFJlbmFtZSBpdCB0byAudHMgc28gdGhlIGxvYWRlciBjYW4gY29tcGlsZSBpdC5gLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBDb3VsZCBub3QgcmVhZCBmaWxlIFx1MjAxNCBmYWxsIHRocm91Z2ggdG8gZ2VuZXJpYyBlcnJvclxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiB7IGV4dGVuc2lvbjogbnVsbCwgZXJyb3I6IGBGYWlsZWQgdG8gbG9hZCBleHRlbnNpb246ICR7bWVzc2FnZX1gIH07XG5cdH1cbn1cblxuLyoqXG4gKiBDcmVhdGUgYW4gRXh0ZW5zaW9uIGZyb20gYW4gaW5saW5lIGZhY3RvcnkgZnVuY3Rpb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkRXh0ZW5zaW9uRnJvbUZhY3RvcnkoXG5cdGZhY3Rvcnk6IEV4dGVuc2lvbkZhY3RvcnksXG5cdGN3ZDogc3RyaW5nLFxuXHRldmVudEJ1czogRXZlbnRCdXMsXG5cdHJ1bnRpbWU6IEV4dGVuc2lvblJ1bnRpbWUsXG5cdGV4dGVuc2lvblBhdGggPSBcIjxpbmxpbmU+XCIsXG4pOiBQcm9taXNlPEV4dGVuc2lvbj4ge1xuXHRjb25zdCBleHRlbnNpb24gPSBjcmVhdGVFeHRlbnNpb24oZXh0ZW5zaW9uUGF0aCwgZXh0ZW5zaW9uUGF0aCk7XG5cdGNvbnN0IGFwaSA9IGNyZWF0ZUV4dGVuc2lvbkFQSShleHRlbnNpb24sIHJ1bnRpbWUsIGN3ZCwgZXZlbnRCdXMpO1xuXHRhd2FpdCBmYWN0b3J5KGFwaSk7XG5cdHJldHVybiBleHRlbnNpb247XG59XG5cbi8qKlxuICogTG9hZCBleHRlbnNpb25zIGZyb20gcGF0aHMuXG4gKlxuICogUGF0aHMgYXJlIGV4cGVjdGVkIHRvIGJlIHRvcG9sb2dpY2FsbHkgc29ydGVkIGJ5IGNhbGxlciAoc2VlIHNvcnRFeHRlbnNpb25QYXRocykuXG4gKiBGYWN0b3JpZXMgYXJlIGF3YWl0ZWQgc2VxdWVudGlhbGx5IHNvIGEgZGVwZW5kZW5jeSdzIGZhY3RvcnkgZnVsbHkgaW5pdGlhbGl6ZXNcbiAqIChyZWdpc3RlcnMgdG9vbHMsIGNvbW1hbmRzLCBob29rcyBvbiBgcGlgKSBiZWZvcmUgYW55IGRlcGVuZGVudCdzIGZhY3RvcnkgcnVucy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWRFeHRlbnNpb25zKHBhdGhzOiBzdHJpbmdbXSwgY3dkOiBzdHJpbmcsIGV2ZW50QnVzPzogRXZlbnRCdXMpOiBQcm9taXNlPExvYWRFeHRlbnNpb25zUmVzdWx0PiB7XG5cdGNvbnN0IHJlc29sdmVkRXZlbnRCdXMgPSBldmVudEJ1cyA/PyBjcmVhdGVFdmVudEJ1cygpO1xuXHRjb25zdCBydW50aW1lID0gY3JlYXRlRXh0ZW5zaW9uUnVudGltZSgpO1xuXG5cdGNvbnN0IGV4dGVuc2lvbnM6IEV4dGVuc2lvbltdID0gW107XG5cdGNvbnN0IGVycm9yczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGVycm9yOiBzdHJpbmcgfT4gPSBbXTtcblxuXHRmb3IgKGNvbnN0IGV4dFBhdGggb2YgcGF0aHMpIHtcblx0XHRjb25zdCB7IGV4dGVuc2lvbiwgZXJyb3IgfSA9IGF3YWl0IGxvYWRFeHRlbnNpb24oZXh0UGF0aCwgY3dkLCByZXNvbHZlZEV2ZW50QnVzLCBydW50aW1lKTtcblx0XHRpZiAoZXJyb3IpIHtcblx0XHRcdGVycm9ycy5wdXNoKHsgcGF0aDogZXh0UGF0aCwgZXJyb3IgfSk7XG5cdFx0fSBlbHNlIGlmIChleHRlbnNpb24pIHtcblx0XHRcdGV4dGVuc2lvbnMucHVzaChleHRlbnNpb24pO1xuXHRcdH1cblx0fVxuXG5cdHJldHVybiB7XG5cdFx0ZXh0ZW5zaW9ucyxcblx0XHRlcnJvcnMsXG5cdFx0d2FybmluZ3M6IFtdLFxuXHRcdHJ1bnRpbWUsXG5cdH07XG59XG5cbmludGVyZmFjZSBQaU1hbmlmZXN0IHtcblx0ZXh0ZW5zaW9ucz86IHN0cmluZ1tdO1xuXHR0aGVtZXM/OiBzdHJpbmdbXTtcblx0c2tpbGxzPzogc3RyaW5nW107XG5cdHByb21wdHM/OiBzdHJpbmdbXTtcbn1cblxuZnVuY3Rpb24gcmVhZFBpTWFuaWZlc3QocGFja2FnZUpzb25QYXRoOiBzdHJpbmcpOiBQaU1hbmlmZXN0IHwgbnVsbCB7XG5cdHRyeSB7XG5cdFx0Y29uc3QgY29udGVudCA9IGZzLnJlYWRGaWxlU3luYyhwYWNrYWdlSnNvblBhdGgsIFwidXRmLThcIik7XG5cdFx0Y29uc3QgcGtnID0gSlNPTi5wYXJzZShjb250ZW50KTtcblx0XHRpZiAocGtnLnBpICYmIHR5cGVvZiBwa2cucGkgPT09IFwib2JqZWN0XCIpIHtcblx0XHRcdHJldHVybiBwa2cucGkgYXMgUGlNYW5pZmVzdDtcblx0XHR9XG5cdFx0cmV0dXJuIG51bGw7XG5cdH0gY2F0Y2gge1xuXHRcdHJldHVybiBudWxsO1xuXHR9XG59XG5cbmZ1bmN0aW9uIGlzRXh0ZW5zaW9uRmlsZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcblx0cmV0dXJuIG5hbWUuZW5kc1dpdGgoXCIudHNcIikgfHwgbmFtZS5lbmRzV2l0aChcIi5qc1wiKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIGV4dGVuc2lvbiBlbnRyeSBwb2ludHMgZnJvbSBhIGRpcmVjdG9yeS5cbiAqXG4gKiBDaGVja3MgZm9yOlxuICogMS4gcGFja2FnZS5qc29uIHdpdGggXCJwaS5leHRlbnNpb25zXCIgZmllbGQgLT4gcmV0dXJucyBkZWNsYXJlZCBwYXRoc1xuICogMi4gaW5kZXgudHMgb3IgaW5kZXguanMgLT4gcmV0dXJucyB0aGUgaW5kZXggZmlsZVxuICpcbiAqIFJldHVybnMgcmVzb2x2ZWQgcGF0aHMgb3IgbnVsbCBpZiBubyBlbnRyeSBwb2ludHMgZm91bmQuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVFeHRlbnNpb25FbnRyaWVzKGRpcjogc3RyaW5nKTogc3RyaW5nW10gfCBudWxsIHtcblx0Ly8gQ2hlY2sgZm9yIHBhY2thZ2UuanNvbiB3aXRoIFwicGlcIiBmaWVsZCBmaXJzdFxuXHRjb25zdCBwYWNrYWdlSnNvblBhdGggPSBwYXRoLmpvaW4oZGlyLCBcInBhY2thZ2UuanNvblwiKTtcblx0aWYgKGZzLmV4aXN0c1N5bmMocGFja2FnZUpzb25QYXRoKSkge1xuXHRcdGNvbnN0IG1hbmlmZXN0ID0gcmVhZFBpTWFuaWZlc3QocGFja2FnZUpzb25QYXRoKTtcblx0XHRpZiAobWFuaWZlc3QpIHtcblx0XHRcdC8vIFdoZW4gYSBwaSBtYW5pZmVzdCBleGlzdHMsIGl0IGlzIGF1dGhvcml0YXRpdmUgXHUyMDE0IGRvbid0IGZhbGwgdGhyb3VnaFxuXHRcdFx0Ly8gdG8gaW5kZXgudHMvaW5kZXguanMgYXV0by1kZXRlY3Rpb24uIFRoaXMgYWxsb3dzIGxpYnJhcnkgZGlyZWN0b3JpZXNcblx0XHRcdC8vIChsaWtlIGNtdXgpIHRvIG9wdCBvdXQgYnkgZGVjbGFyaW5nIFwicGlcIjoge30gd2l0aCBubyBleHRlbnNpb25zLlxuXHRcdFx0aWYgKCFtYW5pZmVzdC5leHRlbnNpb25zPy5sZW5ndGgpIHtcblx0XHRcdFx0cmV0dXJuIG51bGw7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBlbnRyaWVzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0Zm9yIChjb25zdCBleHRQYXRoIG9mIG1hbmlmZXN0LmV4dGVuc2lvbnMpIHtcblx0XHRcdFx0Y29uc3QgcmVzb2x2ZWRFeHRQYXRoID0gcGF0aC5yZXNvbHZlKGRpciwgZXh0UGF0aCk7XG5cdFx0XHRcdGlmIChmcy5leGlzdHNTeW5jKHJlc29sdmVkRXh0UGF0aCkpIHtcblx0XHRcdFx0XHRlbnRyaWVzLnB1c2gocmVzb2x2ZWRFeHRQYXRoKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIGVudHJpZXMubGVuZ3RoID4gMCA/IGVudHJpZXMgOiBudWxsO1xuXHRcdH1cblx0fVxuXG5cdC8vIENoZWNrIGZvciBpbmRleC50cyBvciBpbmRleC5qc1xuXHRjb25zdCBpbmRleFRzID0gcGF0aC5qb2luKGRpciwgXCJpbmRleC50c1wiKTtcblx0Y29uc3QgaW5kZXhKcyA9IHBhdGguam9pbihkaXIsIFwiaW5kZXguanNcIik7XG5cdGlmIChmcy5leGlzdHNTeW5jKGluZGV4VHMpKSB7XG5cdFx0cmV0dXJuIFtpbmRleFRzXTtcblx0fVxuXHRpZiAoZnMuZXhpc3RzU3luYyhpbmRleEpzKSkge1xuXHRcdHJldHVybiBbaW5kZXhKc107XG5cdH1cblxuXHRyZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBEaXNjb3ZlciBleHRlbnNpb25zIGluIGEgZGlyZWN0b3J5LlxuICpcbiAqIERpc2NvdmVyeSBydWxlczpcbiAqIDEuIERpcmVjdCBmaWxlczogYGV4dGVuc2lvbnMvKi50c2Agb3IgYCouanNgIFx1MjE5MiBsb2FkXG4gKiAyLiBTdWJkaXJlY3Rvcnkgd2l0aCBpbmRleDogYGV4dGVuc2lvbnMvKiAvaW5kZXgudHNgIG9yIGBpbmRleC5qc2AgXHUyMTkyIGxvYWRcbiAqIDMuIFN1YmRpcmVjdG9yeSB3aXRoIHBhY2thZ2UuanNvbjogYGV4dGVuc2lvbnMvKiAvcGFja2FnZS5qc29uYCB3aXRoIFwicGlcIiBmaWVsZCBcdTIxOTIgbG9hZCB3aGF0IGl0IGRlY2xhcmVzXG4gKlxuICogTm8gcmVjdXJzaW9uIGJleW9uZCBvbmUgbGV2ZWwuIENvbXBsZXggcGFja2FnZXMgbXVzdCB1c2UgcGFja2FnZS5qc29uIG1hbmlmZXN0LlxuICovXG5mdW5jdGlvbiBkaXNjb3ZlckV4dGVuc2lvbnNJbkRpcihkaXI6IHN0cmluZyk6IHN0cmluZ1tdIHtcblx0aWYgKCFmcy5leGlzdHNTeW5jKGRpcikpIHtcblx0XHRyZXR1cm4gW107XG5cdH1cblxuXHRjb25zdCBkaXNjb3ZlcmVkOiBzdHJpbmdbXSA9IFtdO1xuXG5cdHRyeSB7XG5cdFx0Y29uc3QgZW50cmllcyA9IGZzLnJlYWRkaXJTeW5jKGRpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuXG5cdFx0Zm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG5cdFx0XHRjb25zdCBlbnRyeVBhdGggPSBwYXRoLmpvaW4oZGlyLCBlbnRyeS5uYW1lKTtcblxuXHRcdFx0Ly8gMS4gRGlyZWN0IGZpbGVzOiAqLnRzIG9yICouanNcblx0XHRcdGlmICgoZW50cnkuaXNGaWxlKCkgfHwgZW50cnkuaXNTeW1ib2xpY0xpbmsoKSkgJiYgaXNFeHRlbnNpb25GaWxlKGVudHJ5Lm5hbWUpKSB7XG5cdFx0XHRcdGRpc2NvdmVyZWQucHVzaChlbnRyeVBhdGgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gMiAmIDMuIFN1YmRpcmVjdG9yaWVzXG5cdFx0XHRpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSB8fCBlbnRyeS5pc1N5bWJvbGljTGluaygpKSB7XG5cdFx0XHRcdGNvbnN0IGVudHJpZXMgPSByZXNvbHZlRXh0ZW5zaW9uRW50cmllcyhlbnRyeVBhdGgpO1xuXHRcdFx0XHRpZiAoZW50cmllcykge1xuXHRcdFx0XHRcdGRpc2NvdmVyZWQucHVzaCguLi5lbnRyaWVzKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0fSBjYXRjaCB7XG5cdFx0cmV0dXJuIFtdO1xuXHR9XG5cblx0cmV0dXJuIGRpc2NvdmVyZWQ7XG59XG5cbi8qKlxuICogRGlzY292ZXIgYW5kIGxvYWQgZXh0ZW5zaW9ucyBmcm9tIHN0YW5kYXJkIGxvY2F0aW9ucy5cbiAqXG4gKiBAZGVwcmVjYXRlZCBVc2UgRGVmYXVsdFJlc291cmNlTG9hZGVyLnJlbG9hZCgpIGluc3RlYWQgXHUyMDE0IHRoaXMgZnVuY3Rpb24gaXNcbiAqIG5vdCBjYWxsZWQgaW4gdGhlIEdTRCBsb2FkaW5nIGZsb3cuIEV4dGVuc2lvbiBkaXNjb3ZlcnkgaGFwcGVucyB0aHJvdWdoXG4gKiBEZWZhdWx0UGFja2FnZU1hbmFnZXIucmVzb2x2ZSgpIFx1MjE5MiBhZGRBdXRvRGlzY292ZXJlZFJlc291cmNlcygpLiBLZXB0IGZvclxuICogYmFja3dhcmRzIGNvbXBhdGliaWxpdHkgd2l0aCBkaXJlY3QgcGktY29kaW5nLWFnZW50IGNvbnN1bWVycy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRpc2NvdmVyQW5kTG9hZEV4dGVuc2lvbnMoXG5cdGNvbmZpZ3VyZWRQYXRoczogc3RyaW5nW10sXG5cdGN3ZDogc3RyaW5nLFxuXHRhZ2VudERpcjogc3RyaW5nID0gZ2V0QWdlbnREaXIoKSxcblx0ZXZlbnRCdXM/OiBFdmVudEJ1cyxcbik6IFByb21pc2U8TG9hZEV4dGVuc2lvbnNSZXN1bHQ+IHtcblx0Y29uc3QgYWxsUGF0aHM6IHN0cmluZ1tdID0gW107XG5cdGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuXHRjb25zdCBhZGRQYXRocyA9IChwYXRoczogc3RyaW5nW10pID0+IHtcblx0XHRmb3IgKGNvbnN0IHAgb2YgcGF0aHMpIHtcblx0XHRcdGNvbnN0IHJlc29sdmVkID0gcGF0aC5yZXNvbHZlKHApO1xuXHRcdFx0aWYgKCFzZWVuLmhhcyhyZXNvbHZlZCkpIHtcblx0XHRcdFx0c2Vlbi5hZGQocmVzb2x2ZWQpO1xuXHRcdFx0XHRhbGxQYXRocy5wdXNoKHApO1xuXHRcdFx0fVxuXHRcdH1cblx0fTtcblxuXHQvLyAxLiBQcm9qZWN0LWxvY2FsIGV4dGVuc2lvbnM6IGN3ZC8ucGkvZXh0ZW5zaW9ucy9cblx0Ly8gT25seSBsb2FkZWQgd2hlbiB0aGUgcHJvamVjdCBwYXRoIGhhcyBiZWVuIGV4cGxpY2l0bHkgdHJ1c3RlZCAoVE9GVSBtb2RlbCkuXG5cdGNvbnN0IGxvY2FsRXh0RGlyID0gcGF0aC5qb2luKGN3ZCwgXCIucGlcIiwgXCJleHRlbnNpb25zXCIpO1xuXHRjb25zdCBsb2NhbERpc2NvdmVyZWQgPSBkaXNjb3ZlckV4dGVuc2lvbnNJbkRpcihsb2NhbEV4dERpcik7XG5cdGlmIChsb2NhbERpc2NvdmVyZWQubGVuZ3RoID4gMCkge1xuXHRcdGNvbnN0IHVudHJ1c3RlZCA9IGdldFVudHJ1c3RlZEV4dGVuc2lvblBhdGhzKGN3ZCwgbG9jYWxEaXNjb3ZlcmVkLCBhZ2VudERpcik7XG5cdFx0aWYgKHVudHJ1c3RlZC5sZW5ndGggPiAwKSB7XG5cdFx0XHRwcm9jZXNzLnN0ZGVyci53cml0ZShcblx0XHRcdFx0YFtwaV0gU2tpcHBpbmcgJHt1bnRydXN0ZWQubGVuZ3RofSBwcm9qZWN0LWxvY2FsIGV4dGVuc2lvbihzKSBpbiAke2xvY2FsRXh0RGlyfSBcdTIwMTQgcHJvamVjdCBub3QgdHJ1c3RlZC4gVXNlIHRydXN0UHJvamVjdCgpIHRvIGVuYWJsZS5cXG5gLFxuXHRcdFx0KTtcblx0XHR9XG5cdFx0Y29uc3QgdHJ1c3RlZCA9IGxvY2FsRGlzY292ZXJlZC5maWx0ZXIoKHApID0+ICF1bnRydXN0ZWQuaW5jbHVkZXMocCkpO1xuXHRcdGFkZFBhdGhzKHRydXN0ZWQpO1xuXHR9XG5cblx0Ly8gMi4gR2xvYmFsIGV4dGVuc2lvbnM6IGFnZW50RGlyL2V4dGVuc2lvbnMvXG5cdGNvbnN0IGdsb2JhbEV4dERpciA9IHBhdGguam9pbihhZ2VudERpciwgXCJleHRlbnNpb25zXCIpO1xuXHQvLyAyYi4gSW5zdGFsbGVkIGV4dGVuc2lvbnM6IH4vLmdzZC9leHRlbnNpb25zLyBtZXJnZWQgd2l0aCBidW5kbGVkIChELTE0LCBELTE1KVxuXHQvLyBEaXNjb3ZlcnkgaGFuZGxlcyBJRC1iYXNlZCBtZXJnZSBcdTIwMTQgbG9hZGVyIHN0YXlzIGR1bWIuXG5cdGNvbnN0IGluc3RhbGxlZEV4dERpciA9IHBhdGguam9pbihwYXRoLmRpcm5hbWUoYWdlbnREaXIpLCBcImV4dGVuc2lvbnNcIik7XG5cdGNvbnN0IGdsb2JhbFBhdGhzID0gZGlzY292ZXJFeHRlbnNpb25zSW5EaXIoZ2xvYmFsRXh0RGlyKTtcblx0Y29uc3QgbWVyZ2VkUGF0aHMgPSBtZXJnZUV4dGVuc2lvbkVudHJ5UGF0aHMoZ2xvYmFsUGF0aHMsIGluc3RhbGxlZEV4dERpcik7XG5cdGFkZFBhdGhzKG1lcmdlZFBhdGhzKTtcblxuXHQvLyAzLiBFeHBsaWNpdGx5IGNvbmZpZ3VyZWQgcGF0aHNcblx0Zm9yIChjb25zdCBwIG9mIGNvbmZpZ3VyZWRQYXRocykge1xuXHRcdGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZVBhdGgocCwgY3dkKTtcblx0XHRpZiAoZnMuZXhpc3RzU3luYyhyZXNvbHZlZCkgJiYgZnMuc3RhdFN5bmMocmVzb2x2ZWQpLmlzRGlyZWN0b3J5KCkpIHtcblx0XHRcdC8vIENoZWNrIGZvciBwYWNrYWdlLmpzb24gd2l0aCBwaSBtYW5pZmVzdCBvciBpbmRleC50c1xuXHRcdFx0Y29uc3QgZW50cmllcyA9IHJlc29sdmVFeHRlbnNpb25FbnRyaWVzKHJlc29sdmVkKTtcblx0XHRcdGlmIChlbnRyaWVzKSB7XG5cdFx0XHRcdGFkZFBhdGhzKGVudHJpZXMpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdC8vIE5vIGV4cGxpY2l0IGVudHJpZXMgLSBkaXNjb3ZlciBpbmRpdmlkdWFsIGZpbGVzIGluIGRpcmVjdG9yeVxuXHRcdFx0YWRkUGF0aHMoZGlzY292ZXJFeHRlbnNpb25zSW5EaXIocmVzb2x2ZWQpKTtcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblxuXHRcdGFkZFBhdGhzKFtyZXNvbHZlZF0pO1xuXHR9XG5cblx0Ly8gVG9wb2xvZ2ljYWwgc29ydDogZW5zdXJlIGRlY2xhcmVkIGRlcGVuZGVuY2llcyBsb2FkIGZpcnN0IChELTA2LCBELTA3KVxuXHRjb25zdCB7IHNvcnRlZFBhdGhzLCB3YXJuaW5nczogc29ydFdhcm5pbmdzIH0gPSBzb3J0RXh0ZW5zaW9uUGF0aHMoYWxsUGF0aHMpXG5cdC8vIEVtaXQgd2FybmluZ3MgdG8gc3RkZXJyIGltbWVkaWF0ZWx5IFx1MjAxNCBsb2FkZXIgcnVucyBiZWZvcmUgY3R4LnVpIGlzIHJlYWR5IChELTA4KVxuXHRmb3IgKGNvbnN0IHcgb2Ygc29ydFdhcm5pbmdzKSB7XG5cdFx0cHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtnc2RdICR7dy5tZXNzYWdlfVxcbmApXG5cdH1cblx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgbG9hZEV4dGVuc2lvbnMoc29ydGVkUGF0aHMsIGN3ZCwgZXZlbnRCdXMpXG5cdHJlc3VsdC53YXJuaW5ncy5wdXNoKC4uLnNvcnRXYXJuaW5ncylcblx0cmV0dXJuIHJlc3VsdFxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBTUEsWUFBWSxRQUFRO0FBQ3BCLFNBQVMscUJBQXFCO0FBQzlCLFlBQVksUUFBUTtBQUNwQixZQUFZLFVBQVU7QUFDdEIsU0FBUyxx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
