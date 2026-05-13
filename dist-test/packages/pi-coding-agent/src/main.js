import { modelsAreEqual, supportsXhigh } from "@gsd/pi-ai";
import chalk from "chalk";
import { createInterface } from "readline";
import { parseArgs, printHelp } from "./cli/args.js";
import { selectConfig } from "./cli/config-selector.js";
import { processFileArguments } from "./cli/file-processor.js";
import { discoverAndPrintModels, listModels } from "./cli/list-models.js";
import { selectSession } from "./cli/session-picker.js";
import { APP_NAME, getAgentDir, getModelsPath, VERSION } from "./config.js";
import { AuthStorage } from "./core/auth-storage.js";
import { exportFromFile } from "./core/export-html/index.js";
import { KeybindingsManager } from "./core/keybindings.js";
import { ModelRegistry } from "./core/model-registry.js";
import { resolveCliModel, resolveModelScope } from "./core/model-resolver.js";
import { runPackageCommand } from "./core/package-commands.js";
import { DefaultPackageManager } from "./core/package-manager.js";
import { DefaultResourceLoader } from "./core/resource-loader.js";
import { createAgentSession } from "./core/sdk.js";
import { SessionManager } from "./core/session-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, time } from "./core/timings.js";
import { allTools } from "./core/tools/index.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.js";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
async function readPipedStdin() {
  if (process.stdin.isTTY) {
    return void 0;
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim() || void 0);
    });
    process.stdin.resume();
  });
}
function reportSettingsErrors(settingsManager, context) {
  const errors = settingsManager.drainErrors();
  for (const { scope, error } of errors) {
    console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
    if (error.stack) {
      console.error(chalk.dim(error.stack));
    }
  }
}
function isTruthyEnvFlag(value) {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
async function prepareInitialMessage(parsed, autoResizeImages) {
  if (parsed.fileArgs.length === 0) {
    return {};
  }
  const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
  let initialMessage;
  if (parsed.messages.length > 0) {
    initialMessage = text + parsed.messages[0];
    parsed.messages.shift();
  } else {
    initialMessage = text;
  }
  return {
    initialMessage,
    initialImages: images.length > 0 ? images : void 0
  };
}
async function resolveSessionPath(sessionArg, cwd, sessionDir) {
  if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
    return { type: "path", path: sessionArg };
  }
  const localSessions = await SessionManager.list(cwd, sessionDir);
  const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));
  if (localMatches.length >= 1) {
    return { type: "local", path: localMatches[0].path };
  }
  const allSessions = await SessionManager.listAll();
  const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));
  if (globalMatches.length >= 1) {
    const match = globalMatches[0];
    return { type: "global", path: match.path, cwd: match.cwd };
  }
  return { type: "not_found", arg: sessionArg };
}
async function promptConfirm(message) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}
async function callSessionDirectoryHook(extensions, cwd) {
  let customSessionDir;
  for (const ext of extensions.extensions) {
    const handlers = ext.handlers.get("session_directory");
    if (!handlers || handlers.length === 0) continue;
    for (const handler of handlers) {
      try {
        const event = { type: "session_directory", cwd };
        const result = await handler(event);
        if (result?.sessionDir) {
          customSessionDir = result.sessionDir;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Extension "${ext.path}" session_directory handler failed: ${message}`));
      }
    }
  }
  return customSessionDir;
}
async function createSessionManager(parsed, cwd, extensions) {
  if (parsed.noSession) {
    return SessionManager.inMemory();
  }
  let effectiveSessionDir = parsed.sessionDir;
  if (!effectiveSessionDir) {
    effectiveSessionDir = await callSessionDirectoryHook(extensions, cwd);
  }
  if (parsed.session) {
    const resolved = await resolveSessionPath(parsed.session, cwd, effectiveSessionDir);
    switch (resolved.type) {
      case "path":
      case "local":
        return SessionManager.open(resolved.path, effectiveSessionDir);
      case "global": {
        console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
        const shouldFork = await promptConfirm("Fork this session into current directory?");
        if (!shouldFork) {
          console.log(chalk.dim("Aborted."));
          process.exit(0);
        }
        return SessionManager.forkFrom(resolved.path, cwd, effectiveSessionDir);
      }
      case "not_found":
        console.error(chalk.red(`No session found matching '${resolved.arg}'`));
        process.exit(1);
    }
  }
  if (parsed.continue) {
    return SessionManager.continueRecent(cwd, effectiveSessionDir);
  }
  if (effectiveSessionDir) {
    return SessionManager.create(cwd, effectiveSessionDir);
  }
  return void 0;
}
function buildSessionOptions(parsed, scopedModels, sessionManager, modelRegistry, settingsManager) {
  const options = {};
  let cliThinkingFromModel = false;
  if (sessionManager) {
    options.sessionManager = sessionManager;
  }
  if (parsed.model) {
    const resolved = resolveCliModel({
      cliProvider: parsed.provider,
      cliModel: parsed.model,
      modelRegistry
    });
    if (resolved.warning) {
      console.warn(chalk.yellow(`Warning: ${resolved.warning}`));
    }
    if (resolved.error) {
      console.error(chalk.red(resolved.error));
      process.exit(1);
    }
    if (resolved.model) {
      options.model = resolved.model;
      if (!parsed.thinking && resolved.thinkingLevel) {
        options.thinkingLevel = resolved.thinkingLevel;
        cliThinkingFromModel = true;
      }
    }
  }
  if (!options.model && scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
    const savedProvider = settingsManager.getDefaultProvider();
    const savedModelId = settingsManager.getDefaultModel();
    const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : void 0;
    const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : void 0;
    if (savedInScope) {
      options.model = savedInScope.model;
      if (!parsed.thinking && savedInScope.thinkingLevel) {
        options.thinkingLevel = savedInScope.thinkingLevel;
      }
    } else {
      options.model = scopedModels[0].model;
      if (!parsed.thinking && scopedModels[0].thinkingLevel) {
        options.thinkingLevel = scopedModels[0].thinkingLevel;
      }
    }
  }
  if (parsed.thinking) {
    options.thinkingLevel = parsed.thinking;
  }
  if (scopedModels.length > 0) {
    options.scopedModels = scopedModels.map((sm) => ({
      model: sm.model,
      thinkingLevel: sm.thinkingLevel
    }));
  }
  if (parsed.noTools) {
    if (parsed.tools && parsed.tools.length > 0) {
      options.tools = parsed.tools.map((name) => allTools[name]);
    } else {
      options.tools = [];
    }
  } else if (parsed.tools) {
    options.tools = parsed.tools.map((name) => allTools[name]);
  }
  if (parsed.extraToolNames && parsed.extraToolNames.length > 0) {
    options.extraActiveToolNames = parsed.extraToolNames;
  }
  return { options, cliThinkingFromModel };
}
async function handleConfigCommand(args) {
  if (args[0] !== "config") {
    return false;
  }
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  reportSettingsErrors(settingsManager, "config command");
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolvedPaths = await packageManager.resolve();
  await selectConfig({
    resolvedPaths,
    settingsManager,
    cwd,
    agentDir
  });
  process.exit(0);
}
async function main(args) {
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    console.error(`
Fatal: unhandled promise rejection
${message}`);
    process.exitCode = 1;
  });
  const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
  if (offlineMode) {
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
  }
  const packageCommand = await runPackageCommand({
    appName: APP_NAME,
    args,
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    stdout: process.stdout,
    stderr: process.stderr
  });
  if (packageCommand.handled) {
    process.exitCode = packageCommand.exitCode;
    return;
  }
  if (await handleConfigCommand(args)) {
    return;
  }
  const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(process.cwd());
  const firstPass = parseArgs(args);
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  reportSettingsErrors(settingsManager, "startup");
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
  if (offlineMode) {
    if (!modelRegistry.isAllLocalChain()) {
      const remoteModel = modelRegistry.getAll().find((m) => !ModelRegistry.isLocalModel(m));
      if (remoteModel) {
        console.error(
          `Error: --offline requires all configured models to be local. Found remote model: ${remoteModel.name} (${remoteModel.baseUrl || "cloud API"})`
        );
        process.exit(1);
      }
    }
  } else if (modelRegistry.isAllLocalChain() && modelRegistry.getAll().length > 0) {
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    console.log("[gsd] All configured models are local \u2014 enabling offline mode automatically.");
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: firstPass.extensions,
    additionalSkillPaths: firstPass.skills,
    additionalPromptTemplatePaths: firstPass.promptTemplates,
    additionalThemePaths: firstPass.themes,
    noExtensions: firstPass.noExtensions,
    noSkills: firstPass.noSkills || firstPass.bare,
    noPromptTemplates: firstPass.noPromptTemplates || firstPass.bare,
    noThemes: firstPass.noThemes || firstPass.bare,
    systemPrompt: firstPass.systemPrompt,
    appendSystemPrompt: firstPass.appendSystemPrompt,
    // --bare: suppress CLAUDE.md/AGENTS.md ancestor walk
    ...firstPass.bare ? { agentsFilesOverride: () => ({ agentsFiles: [] }) } : {}
  });
  await resourceLoader.reload();
  time("resourceLoader.reload");
  const extensionsResult = resourceLoader.getExtensions();
  for (const { path, error } of extensionsResult.errors) {
    console.error(chalk.red(`Failed to load extension "${path}": ${error}`));
  }
  for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
    modelRegistry.registerProvider(name, config);
  }
  extensionsResult.runtime.pendingProviderRegistrations = [];
  const extensionFlags = /* @__PURE__ */ new Map();
  for (const ext of extensionsResult.extensions) {
    for (const [name, flag] of ext.flags) {
      extensionFlags.set(name, { type: flag.type });
    }
  }
  const parsed = parseArgs(args, extensionFlags);
  for (const [name, value] of parsed.unknownFlags) {
    extensionsResult.runtime.flagValues.set(name, value);
  }
  if (parsed.version) {
    console.log(VERSION);
    process.exit(0);
  }
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  if (parsed.addProvider) {
    const { ModelsJsonWriter } = await import("./core/models-json-writer.js");
    const writer = new ModelsJsonWriter();
    writer.setProvider(parsed.addProvider, {
      baseUrl: parsed.addProviderBaseUrl,
      apiKey: parsed.apiKey
    });
    console.log(`Provider "${parsed.addProvider}" added to models.json`);
    process.exit(0);
  }
  if (parsed.discoverModels !== void 0) {
    const provider = typeof parsed.discoverModels === "string" ? parsed.discoverModels : void 0;
    await discoverAndPrintModels(modelRegistry, provider);
    process.exit(0);
  }
  if (parsed.listModels !== void 0) {
    const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : void 0;
    await listModels(modelRegistry, { searchPattern, discover: parsed.discover });
    process.exit(0);
  }
  if (parsed.mode !== "rpc") {
    const stdinContent = await readPipedStdin();
    if (stdinContent !== void 0) {
      parsed.print = true;
      parsed.messages.unshift(stdinContent);
    }
  }
  if (parsed.export) {
    let result;
    try {
      const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : void 0;
      result = await exportFromFile(parsed.export, outputPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to export session";
      console.error(chalk.red(`Error: ${message}`));
      process.exit(1);
    }
    console.log(`Exported to: ${result}`);
    process.exit(0);
  }
  if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
    console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
    process.exit(1);
  }
  const { initialMessage, initialImages } = await prepareInitialMessage(parsed, settingsManager.getImageAutoResize());
  const isInteractive = !parsed.print && parsed.mode === void 0;
  const mode = parsed.mode || "text";
  initTheme(settingsManager.getTheme(), isInteractive);
  if (isInteractive && deprecationWarnings.length > 0) {
    await showDeprecationWarnings(deprecationWarnings);
  }
  let scopedModels = [];
  const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
  if (modelPatterns && modelPatterns.length > 0) {
    scopedModels = await resolveModelScope(modelPatterns, modelRegistry);
  }
  let sessionManager = await createSessionManager(parsed, cwd, extensionsResult);
  if (parsed.resume) {
    KeybindingsManager.create();
    const effectiveSessionDir = parsed.sessionDir || await callSessionDirectoryHook(extensionsResult, cwd);
    const selectedPath = await selectSession(
      (onProgress) => SessionManager.list(cwd, effectiveSessionDir, onProgress),
      SessionManager.listAll
    );
    if (!selectedPath) {
      console.log(chalk.dim("No session selected"));
      stopThemeWatcher();
      process.exit(0);
    }
    sessionManager = SessionManager.open(selectedPath, effectiveSessionDir);
  }
  const { options: sessionOptions, cliThinkingFromModel } = buildSessionOptions(
    parsed,
    scopedModels,
    sessionManager,
    modelRegistry,
    settingsManager
  );
  sessionOptions.authStorage = authStorage;
  sessionOptions.modelRegistry = modelRegistry;
  sessionOptions.resourceLoader = resourceLoader;
  if (parsed.apiKey) {
    if (!sessionOptions.model) {
      console.error(
        chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models")
      );
      process.exit(1);
    }
    authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
  }
  const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);
  if (!isInteractive && !session.model) {
    console.error(chalk.red("No models available."));
    console.error(chalk.yellow("\nSet an API key environment variable:"));
    console.error("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.");
    console.error(chalk.yellow(`
Or create ${getModelsPath()}`));
    process.exit(1);
  }
  const cliThinkingOverride = parsed.thinking !== void 0 || cliThinkingFromModel;
  if (session.model && cliThinkingOverride) {
    let effectiveThinking = session.thinkingLevel;
    if (!session.model.reasoning) {
      effectiveThinking = "off";
    } else if (effectiveThinking === "xhigh" && !supportsXhigh(session.model)) {
      effectiveThinking = "high";
    }
    if (effectiveThinking !== session.thinkingLevel) {
      session.setThinkingLevel(effectiveThinking);
    }
  }
  if (mode === "rpc") {
    await runRpcMode(session);
  } else if (isInteractive) {
    if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
      const modelList = scopedModels.map((sm) => {
        const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
        return `${sm.model.id}${thinkingStr}`;
      }).join(", ");
      console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
    }
    printTimings();
    const mode2 = new InteractiveMode(session, {
      migratedProviders,
      modelFallbackMessage,
      initialMessage,
      initialImages,
      initialMessages: parsed.messages,
      verbose: parsed.verbose
    });
    await mode2.run();
  } else {
    await runPrintMode(session, {
      mode,
      messages: parsed.messages,
      initialMessage,
      initialImages
    });
    stopThemeWatcher();
    if (process.stdout.writableLength > 0) {
      await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    process.exit(0);
  }
}
export {
  main
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tYWluLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIE1haW4gZW50cnkgcG9pbnQgZm9yIHRoZSBjb2RpbmcgYWdlbnQgQ0xJLlxuICpcbiAqIFRoaXMgZmlsZSBoYW5kbGVzIENMSSBhcmd1bWVudCBwYXJzaW5nIGFuZCB0cmFuc2xhdGVzIHRoZW0gaW50b1xuICogY3JlYXRlQWdlbnRTZXNzaW9uKCkgb3B0aW9ucy4gVGhlIFNESyBkb2VzIHRoZSBoZWF2eSBsaWZ0aW5nLlxuICovXG5cbmltcG9ydCB7IHR5cGUgSW1hZ2VDb250ZW50LCBtb2RlbHNBcmVFcXVhbCwgc3VwcG9ydHNYaGlnaCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgY2hhbGsgZnJvbSBcImNoYWxrXCI7XG5pbXBvcnQgeyBjcmVhdGVJbnRlcmZhY2UgfSBmcm9tIFwicmVhZGxpbmVcIjtcbmltcG9ydCB7IHR5cGUgQXJncywgcGFyc2VBcmdzLCBwcmludEhlbHAgfSBmcm9tIFwiLi9jbGkvYXJncy5qc1wiO1xuaW1wb3J0IHsgc2VsZWN0Q29uZmlnIH0gZnJvbSBcIi4vY2xpL2NvbmZpZy1zZWxlY3Rvci5qc1wiO1xuaW1wb3J0IHsgcHJvY2Vzc0ZpbGVBcmd1bWVudHMgfSBmcm9tIFwiLi9jbGkvZmlsZS1wcm9jZXNzb3IuanNcIjtcbmltcG9ydCB7IGRpc2NvdmVyQW5kUHJpbnRNb2RlbHMsIGxpc3RNb2RlbHMgfSBmcm9tIFwiLi9jbGkvbGlzdC1tb2RlbHMuanNcIjtcbmltcG9ydCB7IHNlbGVjdFNlc3Npb24gfSBmcm9tIFwiLi9jbGkvc2Vzc2lvbi1waWNrZXIuanNcIjtcbmltcG9ydCB7IEFQUF9OQU1FLCBnZXRBZ2VudERpciwgZ2V0TW9kZWxzUGF0aCwgVkVSU0lPTiB9IGZyb20gXCIuL2NvbmZpZy5qc1wiO1xuaW1wb3J0IHsgQXV0aFN0b3JhZ2UgfSBmcm9tIFwiLi9jb3JlL2F1dGgtc3RvcmFnZS5qc1wiO1xuaW1wb3J0IHsgZXhwb3J0RnJvbUZpbGUgfSBmcm9tIFwiLi9jb3JlL2V4cG9ydC1odG1sL2luZGV4LmpzXCI7XG5pbXBvcnQgdHlwZSB7IExvYWRFeHRlbnNpb25zUmVzdWx0IH0gZnJvbSBcIi4vY29yZS9leHRlbnNpb25zL2luZGV4LmpzXCI7XG5pbXBvcnQgeyBLZXliaW5kaW5nc01hbmFnZXIgfSBmcm9tIFwiLi9jb3JlL2tleWJpbmRpbmdzLmpzXCI7XG5pbXBvcnQgeyBNb2RlbFJlZ2lzdHJ5IH0gZnJvbSBcIi4vY29yZS9tb2RlbC1yZWdpc3RyeS5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUNsaU1vZGVsLCByZXNvbHZlTW9kZWxTY29wZSwgdHlwZSBTY29wZWRNb2RlbCB9IGZyb20gXCIuL2NvcmUvbW9kZWwtcmVzb2x2ZXIuanNcIjtcbmltcG9ydCB7IHJ1blBhY2thZ2VDb21tYW5kIH0gZnJvbSBcIi4vY29yZS9wYWNrYWdlLWNvbW1hbmRzLmpzXCI7XG5pbXBvcnQgeyBEZWZhdWx0UGFja2FnZU1hbmFnZXIgfSBmcm9tIFwiLi9jb3JlL3BhY2thZ2UtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgRGVmYXVsdFJlc291cmNlTG9hZGVyIH0gZnJvbSBcIi4vY29yZS9yZXNvdXJjZS1sb2FkZXIuanNcIjtcbmltcG9ydCB7IHR5cGUgQ3JlYXRlQWdlbnRTZXNzaW9uT3B0aW9ucywgY3JlYXRlQWdlbnRTZXNzaW9uIH0gZnJvbSBcIi4vY29yZS9zZGsuanNcIjtcbmltcG9ydCB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSBcIi4vY29yZS9zZXNzaW9uLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IFNldHRpbmdzTWFuYWdlciB9IGZyb20gXCIuL2NvcmUvc2V0dGluZ3MtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgcHJpbnRUaW1pbmdzLCB0aW1lIH0gZnJvbSBcIi4vY29yZS90aW1pbmdzLmpzXCI7XG5pbXBvcnQgeyBhbGxUb29scyB9IGZyb20gXCIuL2NvcmUvdG9vbHMvaW5kZXguanNcIjtcbmltcG9ydCB7IHJ1bk1pZ3JhdGlvbnMsIHNob3dEZXByZWNhdGlvbldhcm5pbmdzIH0gZnJvbSBcIi4vbWlncmF0aW9ucy5qc1wiO1xuaW1wb3J0IHsgSW50ZXJhY3RpdmVNb2RlLCBydW5QcmludE1vZGUsIHJ1blJwY01vZGUgfSBmcm9tIFwiLi9tb2Rlcy9pbmRleC5qc1wiO1xuaW1wb3J0IHsgaW5pdFRoZW1lLCBzdG9wVGhlbWVXYXRjaGVyIH0gZnJvbSBcIi4vbW9kZXMvaW50ZXJhY3RpdmUvdGhlbWUvdGhlbWUuanNcIjtcblxuLyoqXG4gKiBSZWFkIGFsbCBjb250ZW50IGZyb20gcGlwZWQgc3RkaW4uXG4gKiBSZXR1cm5zIHVuZGVmaW5lZCBpZiBzdGRpbiBpcyBhIFRUWSAoaW50ZXJhY3RpdmUgdGVybWluYWwpLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWFkUGlwZWRTdGRpbigpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuXHQvLyBJZiBzdGRpbiBpcyBhIFRUWSwgd2UncmUgcnVubmluZyBpbnRlcmFjdGl2ZWx5IC0gZG9uJ3QgcmVhZCBzdGRpblxuXHRpZiAocHJvY2Vzcy5zdGRpbi5pc1RUWSkge1xuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblxuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcblx0XHRsZXQgZGF0YSA9IFwiXCI7XG5cdFx0cHJvY2Vzcy5zdGRpbi5zZXRFbmNvZGluZyhcInV0ZjhcIik7XG5cdFx0cHJvY2Vzcy5zdGRpbi5vbihcImRhdGFcIiwgKGNodW5rKSA9PiB7XG5cdFx0XHRkYXRhICs9IGNodW5rO1xuXHRcdH0pO1xuXHRcdHByb2Nlc3Muc3RkaW4ub24oXCJlbmRcIiwgKCkgPT4ge1xuXHRcdFx0cmVzb2x2ZShkYXRhLnRyaW0oKSB8fCB1bmRlZmluZWQpO1xuXHRcdH0pO1xuXHRcdHByb2Nlc3Muc3RkaW4ucmVzdW1lKCk7XG5cdH0pO1xufVxuXG5mdW5jdGlvbiByZXBvcnRTZXR0aW5nc0Vycm9ycyhzZXR0aW5nc01hbmFnZXI6IFNldHRpbmdzTWFuYWdlciwgY29udGV4dDogc3RyaW5nKTogdm9pZCB7XG5cdGNvbnN0IGVycm9ycyA9IHNldHRpbmdzTWFuYWdlci5kcmFpbkVycm9ycygpO1xuXHRmb3IgKGNvbnN0IHsgc2NvcGUsIGVycm9yIH0gb2YgZXJyb3JzKSB7XG5cdFx0Y29uc29sZS5lcnJvcihjaGFsay55ZWxsb3coYFdhcm5pbmcgKCR7Y29udGV4dH0sICR7c2NvcGV9IHNldHRpbmdzKTogJHtlcnJvci5tZXNzYWdlfWApKTtcblx0XHRpZiAoZXJyb3Iuc3RhY2spIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoY2hhbGsuZGltKGVycm9yLnN0YWNrKSk7XG5cdFx0fVxuXHR9XG59XG5cbmZ1bmN0aW9uIGlzVHJ1dGh5RW52RmxhZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG5cdGlmICghdmFsdWUpIHJldHVybiBmYWxzZTtcblx0cmV0dXJuIHZhbHVlID09PSBcIjFcIiB8fCB2YWx1ZS50b0xvd2VyQ2FzZSgpID09PSBcInRydWVcIiB8fCB2YWx1ZS50b0xvd2VyQ2FzZSgpID09PSBcInllc1wiO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcmVwYXJlSW5pdGlhbE1lc3NhZ2UoXG5cdHBhcnNlZDogQXJncyxcblx0YXV0b1Jlc2l6ZUltYWdlczogYm9vbGVhbixcbik6IFByb21pc2U8e1xuXHRpbml0aWFsTWVzc2FnZT86IHN0cmluZztcblx0aW5pdGlhbEltYWdlcz86IEltYWdlQ29udGVudFtdO1xufT4ge1xuXHRpZiAocGFyc2VkLmZpbGVBcmdzLmxlbmd0aCA9PT0gMCkge1xuXHRcdHJldHVybiB7fTtcblx0fVxuXG5cdGNvbnN0IHsgdGV4dCwgaW1hZ2VzIH0gPSBhd2FpdCBwcm9jZXNzRmlsZUFyZ3VtZW50cyhwYXJzZWQuZmlsZUFyZ3MsIHsgYXV0b1Jlc2l6ZUltYWdlcyB9KTtcblxuXHRsZXQgaW5pdGlhbE1lc3NhZ2U6IHN0cmluZztcblx0aWYgKHBhcnNlZC5tZXNzYWdlcy5sZW5ndGggPiAwKSB7XG5cdFx0aW5pdGlhbE1lc3NhZ2UgPSB0ZXh0ICsgcGFyc2VkLm1lc3NhZ2VzWzBdO1xuXHRcdHBhcnNlZC5tZXNzYWdlcy5zaGlmdCgpO1xuXHR9IGVsc2Uge1xuXHRcdGluaXRpYWxNZXNzYWdlID0gdGV4dDtcblx0fVxuXG5cdHJldHVybiB7XG5cdFx0aW5pdGlhbE1lc3NhZ2UsXG5cdFx0aW5pdGlhbEltYWdlczogaW1hZ2VzLmxlbmd0aCA+IDAgPyBpbWFnZXMgOiB1bmRlZmluZWQsXG5cdH07XG59XG5cbi8qKiBSZXN1bHQgZnJvbSByZXNvbHZpbmcgYSBzZXNzaW9uIGFyZ3VtZW50ICovXG50eXBlIFJlc29sdmVkU2Vzc2lvbiA9XG5cdHwgeyB0eXBlOiBcInBhdGhcIjsgcGF0aDogc3RyaW5nIH0gLy8gRGlyZWN0IGZpbGUgcGF0aFxuXHR8IHsgdHlwZTogXCJsb2NhbFwiOyBwYXRoOiBzdHJpbmcgfSAvLyBGb3VuZCBpbiBjdXJyZW50IHByb2plY3Rcblx0fCB7IHR5cGU6IFwiZ2xvYmFsXCI7IHBhdGg6IHN0cmluZzsgY3dkOiBzdHJpbmcgfSAvLyBGb3VuZCBpbiBkaWZmZXJlbnQgcHJvamVjdFxuXHR8IHsgdHlwZTogXCJub3RfZm91bmRcIjsgYXJnOiBzdHJpbmcgfTsgLy8gTm90IGZvdW5kIGFueXdoZXJlXG5cbi8qKlxuICogUmVzb2x2ZSBhIHNlc3Npb24gYXJndW1lbnQgdG8gYSBmaWxlIHBhdGguXG4gKiBJZiBpdCBsb29rcyBsaWtlIGEgcGF0aCwgdXNlIGFzLWlzLiBPdGhlcndpc2UgdHJ5IHRvIG1hdGNoIGFzIHNlc3Npb24gSUQgcHJlZml4LlxuICovXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlU2Vzc2lvblBhdGgoc2Vzc2lvbkFyZzogc3RyaW5nLCBjd2Q6IHN0cmluZywgc2Vzc2lvbkRpcj86IHN0cmluZyk6IFByb21pc2U8UmVzb2x2ZWRTZXNzaW9uPiB7XG5cdC8vIElmIGl0IGxvb2tzIGxpa2UgYSBmaWxlIHBhdGgsIHVzZSBhcy1pc1xuXHRpZiAoc2Vzc2lvbkFyZy5pbmNsdWRlcyhcIi9cIikgfHwgc2Vzc2lvbkFyZy5pbmNsdWRlcyhcIlxcXFxcIikgfHwgc2Vzc2lvbkFyZy5lbmRzV2l0aChcIi5qc29ubFwiKSkge1xuXHRcdHJldHVybiB7IHR5cGU6IFwicGF0aFwiLCBwYXRoOiBzZXNzaW9uQXJnIH07XG5cdH1cblxuXHQvLyBUcnkgdG8gbWF0Y2ggYXMgc2Vzc2lvbiBJRCBpbiBjdXJyZW50IHByb2plY3QgZmlyc3Rcblx0Y29uc3QgbG9jYWxTZXNzaW9ucyA9IGF3YWl0IFNlc3Npb25NYW5hZ2VyLmxpc3QoY3dkLCBzZXNzaW9uRGlyKTtcblx0Y29uc3QgbG9jYWxNYXRjaGVzID0gbG9jYWxTZXNzaW9ucy5maWx0ZXIoKHMpID0+IHMuaWQuc3RhcnRzV2l0aChzZXNzaW9uQXJnKSk7XG5cblx0aWYgKGxvY2FsTWF0Y2hlcy5sZW5ndGggPj0gMSkge1xuXHRcdHJldHVybiB7IHR5cGU6IFwibG9jYWxcIiwgcGF0aDogbG9jYWxNYXRjaGVzWzBdLnBhdGggfTtcblx0fVxuXG5cdC8vIFRyeSBnbG9iYWwgc2VhcmNoIGFjcm9zcyBhbGwgcHJvamVjdHNcblx0Y29uc3QgYWxsU2Vzc2lvbnMgPSBhd2FpdCBTZXNzaW9uTWFuYWdlci5saXN0QWxsKCk7XG5cdGNvbnN0IGdsb2JhbE1hdGNoZXMgPSBhbGxTZXNzaW9ucy5maWx0ZXIoKHMpID0+IHMuaWQuc3RhcnRzV2l0aChzZXNzaW9uQXJnKSk7XG5cblx0aWYgKGdsb2JhbE1hdGNoZXMubGVuZ3RoID49IDEpIHtcblx0XHRjb25zdCBtYXRjaCA9IGdsb2JhbE1hdGNoZXNbMF07XG5cdFx0cmV0dXJuIHsgdHlwZTogXCJnbG9iYWxcIiwgcGF0aDogbWF0Y2gucGF0aCwgY3dkOiBtYXRjaC5jd2QgfTtcblx0fVxuXG5cdC8vIE5vdCBmb3VuZCBhbnl3aGVyZVxuXHRyZXR1cm4geyB0eXBlOiBcIm5vdF9mb3VuZFwiLCBhcmc6IHNlc3Npb25BcmcgfTtcbn1cblxuLyoqIFByb21wdCB1c2VyIGZvciB5ZXMvbm8gY29uZmlybWF0aW9uICovXG5hc3luYyBmdW5jdGlvbiBwcm9tcHRDb25maXJtKG1lc3NhZ2U6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcblx0XHRjb25zdCBybCA9IGNyZWF0ZUludGVyZmFjZSh7XG5cdFx0XHRpbnB1dDogcHJvY2Vzcy5zdGRpbixcblx0XHRcdG91dHB1dDogcHJvY2Vzcy5zdGRvdXQsXG5cdFx0fSk7XG5cdFx0cmwucXVlc3Rpb24oYCR7bWVzc2FnZX0gW3kvTl0gYCwgKGFuc3dlcikgPT4ge1xuXHRcdFx0cmwuY2xvc2UoKTtcblx0XHRcdHJlc29sdmUoYW5zd2VyLnRvTG93ZXJDYXNlKCkgPT09IFwieVwiIHx8IGFuc3dlci50b0xvd2VyQ2FzZSgpID09PSBcInllc1wiKTtcblx0XHR9KTtcblx0fSk7XG59XG5cbi8qKiBIZWxwZXIgdG8gY2FsbCBDTEktb25seSBzZXNzaW9uX2RpcmVjdG9yeSBoYW5kbGVycyBiZWZvcmUgdGhlIGluaXRpYWwgc2Vzc2lvbiBtYW5hZ2VyIGlzIGNyZWF0ZWQgKi9cbmFzeW5jIGZ1bmN0aW9uIGNhbGxTZXNzaW9uRGlyZWN0b3J5SG9vayhleHRlbnNpb25zOiBMb2FkRXh0ZW5zaW9uc1Jlc3VsdCwgY3dkOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuXHRsZXQgY3VzdG9tU2Vzc2lvbkRpcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG5cdGZvciAoY29uc3QgZXh0IG9mIGV4dGVuc2lvbnMuZXh0ZW5zaW9ucykge1xuXHRcdGNvbnN0IGhhbmRsZXJzID0gZXh0LmhhbmRsZXJzLmdldChcInNlc3Npb25fZGlyZWN0b3J5XCIpO1xuXHRcdGlmICghaGFuZGxlcnMgfHwgaGFuZGxlcnMubGVuZ3RoID09PSAwKSBjb250aW51ZTtcblxuXHRcdGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgZXZlbnQgPSB7IHR5cGU6IFwic2Vzc2lvbl9kaXJlY3RvcnlcIiBhcyBjb25zdCwgY3dkIH07XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IChhd2FpdCBoYW5kbGVyKGV2ZW50KSkgYXMgeyBzZXNzaW9uRGlyPzogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG5cblx0XHRcdFx0aWYgKHJlc3VsdD8uc2Vzc2lvbkRpcikge1xuXHRcdFx0XHRcdGN1c3RvbVNlc3Npb25EaXIgPSByZXN1bHQuc2Vzc2lvbkRpcjtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoY2hhbGsucmVkKGBFeHRlbnNpb24gXCIke2V4dC5wYXRofVwiIHNlc3Npb25fZGlyZWN0b3J5IGhhbmRsZXIgZmFpbGVkOiAke21lc3NhZ2V9YCkpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdHJldHVybiBjdXN0b21TZXNzaW9uRGlyO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVTZXNzaW9uTWFuYWdlcihcblx0cGFyc2VkOiBBcmdzLFxuXHRjd2Q6IHN0cmluZyxcblx0ZXh0ZW5zaW9uczogTG9hZEV4dGVuc2lvbnNSZXN1bHQsXG4pOiBQcm9taXNlPFNlc3Npb25NYW5hZ2VyIHwgdW5kZWZpbmVkPiB7XG5cdGlmIChwYXJzZWQubm9TZXNzaW9uKSB7XG5cdFx0cmV0dXJuIFNlc3Npb25NYW5hZ2VyLmluTWVtb3J5KCk7XG5cdH1cblxuXHQvLyBDTEkgZmxhZyB0YWtlcyBwcmVjZWRlbmNlLCBvdGhlcndpc2UgYXNrIGV4dGVuc2lvbnMgZm9yIGN1c3RvbSBzZXNzaW9uIGRpcmVjdG9yeVxuXHRsZXQgZWZmZWN0aXZlU2Vzc2lvbkRpciA9IHBhcnNlZC5zZXNzaW9uRGlyO1xuXHRpZiAoIWVmZmVjdGl2ZVNlc3Npb25EaXIpIHtcblx0XHRlZmZlY3RpdmVTZXNzaW9uRGlyID0gYXdhaXQgY2FsbFNlc3Npb25EaXJlY3RvcnlIb29rKGV4dGVuc2lvbnMsIGN3ZCk7XG5cdH1cblxuXHRpZiAocGFyc2VkLnNlc3Npb24pIHtcblx0XHRjb25zdCByZXNvbHZlZCA9IGF3YWl0IHJlc29sdmVTZXNzaW9uUGF0aChwYXJzZWQuc2Vzc2lvbiwgY3dkLCBlZmZlY3RpdmVTZXNzaW9uRGlyKTtcblxuXHRcdHN3aXRjaCAocmVzb2x2ZWQudHlwZSkge1xuXHRcdFx0Y2FzZSBcInBhdGhcIjpcblx0XHRcdGNhc2UgXCJsb2NhbFwiOlxuXHRcdFx0XHRyZXR1cm4gU2Vzc2lvbk1hbmFnZXIub3BlbihyZXNvbHZlZC5wYXRoLCBlZmZlY3RpdmVTZXNzaW9uRGlyKTtcblxuXHRcdFx0Y2FzZSBcImdsb2JhbFwiOiB7XG5cdFx0XHRcdC8vIFNlc3Npb24gZm91bmQgaW4gZGlmZmVyZW50IHByb2plY3QgLSBhc2sgdXNlciBpZiB0aGV5IHdhbnQgdG8gZm9ya1xuXHRcdFx0XHRjb25zb2xlLmxvZyhjaGFsay55ZWxsb3coYFNlc3Npb24gZm91bmQgaW4gZGlmZmVyZW50IHByb2plY3Q6ICR7cmVzb2x2ZWQuY3dkfWApKTtcblx0XHRcdFx0Y29uc3Qgc2hvdWxkRm9yayA9IGF3YWl0IHByb21wdENvbmZpcm0oXCJGb3JrIHRoaXMgc2Vzc2lvbiBpbnRvIGN1cnJlbnQgZGlyZWN0b3J5P1wiKTtcblx0XHRcdFx0aWYgKCFzaG91bGRGb3JrKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coY2hhbGsuZGltKFwiQWJvcnRlZC5cIikpO1xuXHRcdFx0XHRcdHByb2Nlc3MuZXhpdCgwKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4gU2Vzc2lvbk1hbmFnZXIuZm9ya0Zyb20ocmVzb2x2ZWQucGF0aCwgY3dkLCBlZmZlY3RpdmVTZXNzaW9uRGlyKTtcblx0XHRcdH1cblxuXHRcdFx0Y2FzZSBcIm5vdF9mb3VuZFwiOlxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGNoYWxrLnJlZChgTm8gc2Vzc2lvbiBmb3VuZCBtYXRjaGluZyAnJHtyZXNvbHZlZC5hcmd9J2ApKTtcblx0XHRcdFx0cHJvY2Vzcy5leGl0KDEpO1xuXHRcdH1cblx0fVxuXHRpZiAocGFyc2VkLmNvbnRpbnVlKSB7XG5cdFx0cmV0dXJuIFNlc3Npb25NYW5hZ2VyLmNvbnRpbnVlUmVjZW50KGN3ZCwgZWZmZWN0aXZlU2Vzc2lvbkRpcik7XG5cdH1cblx0Ly8gLS1yZXN1bWUgaXMgaGFuZGxlZCBzZXBhcmF0ZWx5IChuZWVkcyBwaWNrZXIgVUkpXG5cdC8vIElmIGVmZmVjdGl2ZSBzZXNzaW9uIGRpciBpcyBzZXQsIGNyZWF0ZSBuZXcgc2Vzc2lvbiB0aGVyZVxuXHRpZiAoZWZmZWN0aXZlU2Vzc2lvbkRpcikge1xuXHRcdHJldHVybiBTZXNzaW9uTWFuYWdlci5jcmVhdGUoY3dkLCBlZmZlY3RpdmVTZXNzaW9uRGlyKTtcblx0fVxuXHQvLyBEZWZhdWx0IGNhc2UgKG5ldyBzZXNzaW9uKSByZXR1cm5zIHVuZGVmaW5lZCwgU0RLIHdpbGwgY3JlYXRlIG9uZVxuXHRyZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBidWlsZFNlc3Npb25PcHRpb25zKFxuXHRwYXJzZWQ6IEFyZ3MsXG5cdHNjb3BlZE1vZGVsczogU2NvcGVkTW9kZWxbXSxcblx0c2Vzc2lvbk1hbmFnZXI6IFNlc3Npb25NYW5hZ2VyIHwgdW5kZWZpbmVkLFxuXHRtb2RlbFJlZ2lzdHJ5OiBNb2RlbFJlZ2lzdHJ5LFxuXHRzZXR0aW5nc01hbmFnZXI6IFNldHRpbmdzTWFuYWdlcixcbik6IHsgb3B0aW9uczogQ3JlYXRlQWdlbnRTZXNzaW9uT3B0aW9uczsgY2xpVGhpbmtpbmdGcm9tTW9kZWw6IGJvb2xlYW4gfSB7XG5cdGNvbnN0IG9wdGlvbnM6IENyZWF0ZUFnZW50U2Vzc2lvbk9wdGlvbnMgPSB7fTtcblx0bGV0IGNsaVRoaW5raW5nRnJvbU1vZGVsID0gZmFsc2U7XG5cblx0aWYgKHNlc3Npb25NYW5hZ2VyKSB7XG5cdFx0b3B0aW9ucy5zZXNzaW9uTWFuYWdlciA9IHNlc3Npb25NYW5hZ2VyO1xuXHR9XG5cblx0Ly8gTW9kZWwgZnJvbSBDTElcblx0Ly8gLSBzdXBwb3J0cyAtLXByb3ZpZGVyIDxuYW1lPiAtLW1vZGVsIDxwYXR0ZXJuPlxuXHQvLyAtIHN1cHBvcnRzIC0tbW9kZWwgPHByb3ZpZGVyPi88cGF0dGVybj5cblx0aWYgKHBhcnNlZC5tb2RlbCkge1xuXHRcdGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZUNsaU1vZGVsKHtcblx0XHRcdGNsaVByb3ZpZGVyOiBwYXJzZWQucHJvdmlkZXIsXG5cdFx0XHRjbGlNb2RlbDogcGFyc2VkLm1vZGVsLFxuXHRcdFx0bW9kZWxSZWdpc3RyeSxcblx0XHR9KTtcblx0XHRpZiAocmVzb2x2ZWQud2FybmluZykge1xuXHRcdFx0Y29uc29sZS53YXJuKGNoYWxrLnllbGxvdyhgV2FybmluZzogJHtyZXNvbHZlZC53YXJuaW5nfWApKTtcblx0XHR9XG5cdFx0aWYgKHJlc29sdmVkLmVycm9yKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGNoYWxrLnJlZChyZXNvbHZlZC5lcnJvcikpO1xuXHRcdFx0cHJvY2Vzcy5leGl0KDEpO1xuXHRcdH1cblx0XHRpZiAocmVzb2x2ZWQubW9kZWwpIHtcblx0XHRcdG9wdGlvbnMubW9kZWwgPSByZXNvbHZlZC5tb2RlbDtcblx0XHRcdC8vIEFsbG93IFwiLS1tb2RlbCA8cGF0dGVybj46PHRoaW5raW5nPlwiIGFzIGEgc2hvcnRoYW5kLlxuXHRcdFx0Ly8gRXhwbGljaXQgLS10aGlua2luZyBzdGlsbCB0YWtlcyBwcmVjZWRlbmNlIChhcHBsaWVkIGxhdGVyKS5cblx0XHRcdGlmICghcGFyc2VkLnRoaW5raW5nICYmIHJlc29sdmVkLnRoaW5raW5nTGV2ZWwpIHtcblx0XHRcdFx0b3B0aW9ucy50aGlua2luZ0xldmVsID0gcmVzb2x2ZWQudGhpbmtpbmdMZXZlbDtcblx0XHRcdFx0Y2xpVGhpbmtpbmdGcm9tTW9kZWwgPSB0cnVlO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdGlmICghb3B0aW9ucy5tb2RlbCAmJiBzY29wZWRNb2RlbHMubGVuZ3RoID4gMCAmJiAhcGFyc2VkLmNvbnRpbnVlICYmICFwYXJzZWQucmVzdW1lKSB7XG5cdFx0Ly8gQ2hlY2sgaWYgc2F2ZWQgZGVmYXVsdCBpcyBpbiBzY29wZWQgbW9kZWxzIC0gdXNlIGl0IGlmIHNvLCBvdGhlcndpc2UgZmlyc3Qgc2NvcGVkIG1vZGVsXG5cdFx0Y29uc3Qgc2F2ZWRQcm92aWRlciA9IHNldHRpbmdzTWFuYWdlci5nZXREZWZhdWx0UHJvdmlkZXIoKTtcblx0XHRjb25zdCBzYXZlZE1vZGVsSWQgPSBzZXR0aW5nc01hbmFnZXIuZ2V0RGVmYXVsdE1vZGVsKCk7XG5cdFx0Y29uc3Qgc2F2ZWRNb2RlbCA9IHNhdmVkUHJvdmlkZXIgJiYgc2F2ZWRNb2RlbElkID8gbW9kZWxSZWdpc3RyeS5maW5kKHNhdmVkUHJvdmlkZXIsIHNhdmVkTW9kZWxJZCkgOiB1bmRlZmluZWQ7XG5cdFx0Y29uc3Qgc2F2ZWRJblNjb3BlID0gc2F2ZWRNb2RlbCA/IHNjb3BlZE1vZGVscy5maW5kKChzbSkgPT4gbW9kZWxzQXJlRXF1YWwoc20ubW9kZWwsIHNhdmVkTW9kZWwpKSA6IHVuZGVmaW5lZDtcblxuXHRcdGlmIChzYXZlZEluU2NvcGUpIHtcblx0XHRcdG9wdGlvbnMubW9kZWwgPSBzYXZlZEluU2NvcGUubW9kZWw7XG5cdFx0XHQvLyBVc2UgdGhpbmtpbmcgbGV2ZWwgZnJvbSBzY29wZWQgbW9kZWwgY29uZmlnIGlmIGV4cGxpY2l0bHkgc2V0XG5cdFx0XHRpZiAoIXBhcnNlZC50aGlua2luZyAmJiBzYXZlZEluU2NvcGUudGhpbmtpbmdMZXZlbCkge1xuXHRcdFx0XHRvcHRpb25zLnRoaW5raW5nTGV2ZWwgPSBzYXZlZEluU2NvcGUudGhpbmtpbmdMZXZlbDtcblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0b3B0aW9ucy5tb2RlbCA9IHNjb3BlZE1vZGVsc1swXS5tb2RlbDtcblx0XHRcdC8vIFVzZSB0aGlua2luZyBsZXZlbCBmcm9tIGZpcnN0IHNjb3BlZCBtb2RlbCBpZiBleHBsaWNpdGx5IHNldFxuXHRcdFx0aWYgKCFwYXJzZWQudGhpbmtpbmcgJiYgc2NvcGVkTW9kZWxzWzBdLnRoaW5raW5nTGV2ZWwpIHtcblx0XHRcdFx0b3B0aW9ucy50aGlua2luZ0xldmVsID0gc2NvcGVkTW9kZWxzWzBdLnRoaW5raW5nTGV2ZWw7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0Ly8gVGhpbmtpbmcgbGV2ZWwgZnJvbSBDTEkgKHRha2VzIHByZWNlZGVuY2Ugb3ZlciBzY29wZWQgbW9kZWwgdGhpbmtpbmcgbGV2ZWxzIHNldCBhYm92ZSlcblx0aWYgKHBhcnNlZC50aGlua2luZykge1xuXHRcdG9wdGlvbnMudGhpbmtpbmdMZXZlbCA9IHBhcnNlZC50aGlua2luZztcblx0fVxuXG5cdC8vIFNjb3BlZCBtb2RlbHMgZm9yIEN0cmwrUCBjeWNsaW5nXG5cdC8vIEtlZXAgdGhpbmtpbmcgbGV2ZWwgdW5kZWZpbmVkIHdoZW4gbm90IGV4cGxpY2l0bHkgc2V0IGluIHRoZSBtb2RlbCBwYXR0ZXJuLlxuXHQvLyBVbmRlZmluZWQgbWVhbnMgXCJpbmhlcml0IGN1cnJlbnQgc2Vzc2lvbiB0aGlua2luZyBsZXZlbFwiIGR1cmluZyBjeWNsaW5nLlxuXHRpZiAoc2NvcGVkTW9kZWxzLmxlbmd0aCA+IDApIHtcblx0XHRvcHRpb25zLnNjb3BlZE1vZGVscyA9IHNjb3BlZE1vZGVscy5tYXAoKHNtKSA9PiAoe1xuXHRcdFx0bW9kZWw6IHNtLm1vZGVsLFxuXHRcdFx0dGhpbmtpbmdMZXZlbDogc20udGhpbmtpbmdMZXZlbCxcblx0XHR9KSk7XG5cdH1cblxuXHQvLyBBUEkga2V5IGZyb20gQ0xJIC0gc2V0IGluIGF1dGhTdG9yYWdlXG5cdC8vIChoYW5kbGVkIGJ5IGNhbGxlciBiZWZvcmUgY3JlYXRlQWdlbnRTZXNzaW9uKVxuXG5cdC8vIFRvb2xzXG5cdGlmIChwYXJzZWQubm9Ub29scykge1xuXHRcdC8vIC0tbm8tdG9vbHM6IHN0YXJ0IHdpdGggbm8gYnVpbHQtaW4gdG9vbHNcblx0XHQvLyAtLXRvb2xzIGNhbiBzdGlsbCBhZGQgc3BlY2lmaWMgb25lcyBiYWNrXG5cdFx0aWYgKHBhcnNlZC50b29scyAmJiBwYXJzZWQudG9vbHMubGVuZ3RoID4gMCkge1xuXHRcdFx0b3B0aW9ucy50b29scyA9IHBhcnNlZC50b29scy5tYXAoKG5hbWUpID0+IGFsbFRvb2xzW25hbWVdKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0b3B0aW9ucy50b29scyA9IFtdO1xuXHRcdH1cblx0fSBlbHNlIGlmIChwYXJzZWQudG9vbHMpIHtcblx0XHRvcHRpb25zLnRvb2xzID0gcGFyc2VkLnRvb2xzLm1hcCgobmFtZSkgPT4gYWxsVG9vbHNbbmFtZV0pO1xuXHR9XG5cblx0aWYgKHBhcnNlZC5leHRyYVRvb2xOYW1lcyAmJiBwYXJzZWQuZXh0cmFUb29sTmFtZXMubGVuZ3RoID4gMCkge1xuXHRcdG9wdGlvbnMuZXh0cmFBY3RpdmVUb29sTmFtZXMgPSBwYXJzZWQuZXh0cmFUb29sTmFtZXM7XG5cdH1cblxuXHRyZXR1cm4geyBvcHRpb25zLCBjbGlUaGlua2luZ0Zyb21Nb2RlbCB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVDb25maWdDb21tYW5kKGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdGlmIChhcmdzWzBdICE9PSBcImNvbmZpZ1wiKSB7XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0Y29uc3QgY3dkID0gcHJvY2Vzcy5jd2QoKTtcblx0Y29uc3QgYWdlbnREaXIgPSBnZXRBZ2VudERpcigpO1xuXHRjb25zdCBzZXR0aW5nc01hbmFnZXIgPSBTZXR0aW5nc01hbmFnZXIuY3JlYXRlKGN3ZCwgYWdlbnREaXIpO1xuXHRyZXBvcnRTZXR0aW5nc0Vycm9ycyhzZXR0aW5nc01hbmFnZXIsIFwiY29uZmlnIGNvbW1hbmRcIik7XG5cdGNvbnN0IHBhY2thZ2VNYW5hZ2VyID0gbmV3IERlZmF1bHRQYWNrYWdlTWFuYWdlcih7IGN3ZCwgYWdlbnREaXIsIHNldHRpbmdzTWFuYWdlciB9KTtcblxuXHRjb25zdCByZXNvbHZlZFBhdGhzID0gYXdhaXQgcGFja2FnZU1hbmFnZXIucmVzb2x2ZSgpO1xuXG5cdGF3YWl0IHNlbGVjdENvbmZpZyh7XG5cdFx0cmVzb2x2ZWRQYXRocyxcblx0XHRzZXR0aW5nc01hbmFnZXIsXG5cdFx0Y3dkLFxuXHRcdGFnZW50RGlyLFxuXHR9KTtcblxuXHRwcm9jZXNzLmV4aXQoMCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKGFyZ3M6IHN0cmluZ1tdKSB7XG5cdC8vIENhdGNoIHVuaGFuZGxlZCBwcm9taXNlIHJlamVjdGlvbnMgc28gdGhlIHByb2Nlc3MgZG9lc24ndCBzaWxlbnRseSBkaXNhcHBlYXJcblx0cHJvY2Vzcy5vbihcInVuaGFuZGxlZFJlamVjdGlvblwiLCAocmVhc29uKSA9PiB7XG5cdFx0Y29uc3QgbWVzc2FnZSA9IHJlYXNvbiBpbnN0YW5jZW9mIEVycm9yID8gcmVhc29uLnN0YWNrID8/IHJlYXNvbi5tZXNzYWdlIDogU3RyaW5nKHJlYXNvbik7XG5cdFx0Y29uc29sZS5lcnJvcihgXFxuRmF0YWw6IHVuaGFuZGxlZCBwcm9taXNlIHJlamVjdGlvblxcbiR7bWVzc2FnZX1gKTtcblx0XHRwcm9jZXNzLmV4aXRDb2RlID0gMTtcblx0fSk7XG5cblx0Y29uc3Qgb2ZmbGluZU1vZGUgPSBhcmdzLmluY2x1ZGVzKFwiLS1vZmZsaW5lXCIpIHx8IGlzVHJ1dGh5RW52RmxhZyhwcm9jZXNzLmVudi5QSV9PRkZMSU5FKTtcblx0aWYgKG9mZmxpbmVNb2RlKSB7XG5cdFx0cHJvY2Vzcy5lbnYuUElfT0ZGTElORSA9IFwiMVwiO1xuXHRcdHByb2Nlc3MuZW52LlBJX1NLSVBfVkVSU0lPTl9DSEVDSyA9IFwiMVwiO1xuXHR9XG5cblx0Y29uc3QgcGFja2FnZUNvbW1hbmQgPSBhd2FpdCBydW5QYWNrYWdlQ29tbWFuZCh7XG5cdFx0YXBwTmFtZTogQVBQX05BTUUsXG5cdFx0YXJncyxcblx0XHRjd2Q6IHByb2Nlc3MuY3dkKCksXG5cdFx0YWdlbnREaXI6IGdldEFnZW50RGlyKCksXG5cdFx0c3Rkb3V0OiBwcm9jZXNzLnN0ZG91dCxcblx0XHRzdGRlcnI6IHByb2Nlc3Muc3RkZXJyLFxuXHR9KTtcblx0aWYgKHBhY2thZ2VDb21tYW5kLmhhbmRsZWQpIHtcblx0XHRwcm9jZXNzLmV4aXRDb2RlID0gcGFja2FnZUNvbW1hbmQuZXhpdENvZGU7XG5cdFx0cmV0dXJuO1xuXHR9XG5cblx0aWYgKGF3YWl0IGhhbmRsZUNvbmZpZ0NvbW1hbmQoYXJncykpIHtcblx0XHRyZXR1cm47XG5cdH1cblxuXHQvLyBSdW4gbWlncmF0aW9ucyAocGFzcyBjd2QgZm9yIHByb2plY3QtbG9jYWwgbWlncmF0aW9ucylcblx0Y29uc3QgeyBtaWdyYXRlZEF1dGhQcm92aWRlcnM6IG1pZ3JhdGVkUHJvdmlkZXJzLCBkZXByZWNhdGlvbldhcm5pbmdzIH0gPSBydW5NaWdyYXRpb25zKHByb2Nlc3MuY3dkKCkpO1xuXG5cdC8vIEZpcnN0IHBhc3M6IHBhcnNlIGFyZ3MgdG8gZ2V0IC0tZXh0ZW5zaW9uIHBhdGhzXG5cdGNvbnN0IGZpcnN0UGFzcyA9IHBhcnNlQXJncyhhcmdzKTtcblxuXHQvLyBFYXJseSBsb2FkIGV4dGVuc2lvbnMgdG8gZGlzY292ZXIgdGhlaXIgQ0xJIGZsYWdzXG5cdGNvbnN0IGN3ZCA9IHByb2Nlc3MuY3dkKCk7XG5cdGNvbnN0IGFnZW50RGlyID0gZ2V0QWdlbnREaXIoKTtcblx0Y29uc3Qgc2V0dGluZ3NNYW5hZ2VyID0gU2V0dGluZ3NNYW5hZ2VyLmNyZWF0ZShjd2QsIGFnZW50RGlyKTtcblx0cmVwb3J0U2V0dGluZ3NFcnJvcnMoc2V0dGluZ3NNYW5hZ2VyLCBcInN0YXJ0dXBcIik7XG5cdGNvbnN0IGF1dGhTdG9yYWdlID0gQXV0aFN0b3JhZ2UuY3JlYXRlKCk7XG5cdGNvbnN0IG1vZGVsUmVnaXN0cnkgPSBuZXcgTW9kZWxSZWdpc3RyeShhdXRoU3RvcmFnZSwgZ2V0TW9kZWxzUGF0aCgpKTtcblxuXHQvLyBPZmZsaW5lIG1vZGUgdmFsaWRhdGlvbiAvIGF1dG8tZGV0ZWN0aW9uXG5cdGlmIChvZmZsaW5lTW9kZSkge1xuXHRcdC8vIC0tb2ZmbGluZSBmbGFnOiB2YWxpZGF0ZSBhbGwgbW9kZWxzIGFyZSBsb2NhbFxuXHRcdGlmICghbW9kZWxSZWdpc3RyeS5pc0FsbExvY2FsQ2hhaW4oKSkge1xuXHRcdFx0Y29uc3QgcmVtb3RlTW9kZWwgPSBtb2RlbFJlZ2lzdHJ5LmdldEFsbCgpLmZpbmQoKG0pID0+ICFNb2RlbFJlZ2lzdHJ5LmlzTG9jYWxNb2RlbChtKSk7XG5cdFx0XHRpZiAocmVtb3RlTW9kZWwpIHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihcblx0XHRcdFx0XHRgRXJyb3I6IC0tb2ZmbGluZSByZXF1aXJlcyBhbGwgY29uZmlndXJlZCBtb2RlbHMgdG8gYmUgbG9jYWwuIEZvdW5kIHJlbW90ZSBtb2RlbDogJHtyZW1vdGVNb2RlbC5uYW1lfSAoJHtyZW1vdGVNb2RlbC5iYXNlVXJsIHx8IFwiY2xvdWQgQVBJXCJ9KWAsXG5cdFx0XHRcdCk7XG5cdFx0XHRcdHByb2Nlc3MuZXhpdCgxKTtcblx0XHRcdH1cblx0XHR9XG5cdH0gZWxzZSBpZiAobW9kZWxSZWdpc3RyeS5pc0FsbExvY2FsQ2hhaW4oKSAmJiBtb2RlbFJlZ2lzdHJ5LmdldEFsbCgpLmxlbmd0aCA+IDApIHtcblx0XHQvLyBBdXRvLWRldGVjdDogYWxsIG1vZGVscyBhcmUgbG9jYWwsIGVuYWJsZSBvZmZsaW5lIG1vZGVcblx0XHRwcm9jZXNzLmVudi5QSV9PRkZMSU5FID0gXCIxXCI7XG5cdFx0cHJvY2Vzcy5lbnYuUElfU0tJUF9WRVJTSU9OX0NIRUNLID0gXCIxXCI7XG5cdFx0Y29uc29sZS5sb2coXCJbZ3NkXSBBbGwgY29uZmlndXJlZCBtb2RlbHMgYXJlIGxvY2FsIFxcdTIwMTQgZW5hYmxpbmcgb2ZmbGluZSBtb2RlIGF1dG9tYXRpY2FsbHkuXCIpO1xuXHR9XG5cblx0Y29uc3QgcmVzb3VyY2VMb2FkZXIgPSBuZXcgRGVmYXVsdFJlc291cmNlTG9hZGVyKHtcblx0XHRjd2QsXG5cdFx0YWdlbnREaXIsXG5cdFx0c2V0dGluZ3NNYW5hZ2VyLFxuXHRcdGFkZGl0aW9uYWxFeHRlbnNpb25QYXRoczogZmlyc3RQYXNzLmV4dGVuc2lvbnMsXG5cdFx0YWRkaXRpb25hbFNraWxsUGF0aHM6IGZpcnN0UGFzcy5za2lsbHMsXG5cdFx0YWRkaXRpb25hbFByb21wdFRlbXBsYXRlUGF0aHM6IGZpcnN0UGFzcy5wcm9tcHRUZW1wbGF0ZXMsXG5cdFx0YWRkaXRpb25hbFRoZW1lUGF0aHM6IGZpcnN0UGFzcy50aGVtZXMsXG5cdFx0bm9FeHRlbnNpb25zOiBmaXJzdFBhc3Mubm9FeHRlbnNpb25zLFxuXHRcdG5vU2tpbGxzOiBmaXJzdFBhc3Mubm9Ta2lsbHMgfHwgZmlyc3RQYXNzLmJhcmUsXG5cdFx0bm9Qcm9tcHRUZW1wbGF0ZXM6IGZpcnN0UGFzcy5ub1Byb21wdFRlbXBsYXRlcyB8fCBmaXJzdFBhc3MuYmFyZSxcblx0XHRub1RoZW1lczogZmlyc3RQYXNzLm5vVGhlbWVzIHx8IGZpcnN0UGFzcy5iYXJlLFxuXHRcdHN5c3RlbVByb21wdDogZmlyc3RQYXNzLnN5c3RlbVByb21wdCxcblx0XHRhcHBlbmRTeXN0ZW1Qcm9tcHQ6IGZpcnN0UGFzcy5hcHBlbmRTeXN0ZW1Qcm9tcHQsXG5cdFx0Ly8gLS1iYXJlOiBzdXBwcmVzcyBDTEFVREUubWQvQUdFTlRTLm1kIGFuY2VzdG9yIHdhbGtcblx0XHQuLi4oZmlyc3RQYXNzLmJhcmUgPyB7IGFnZW50c0ZpbGVzT3ZlcnJpZGU6ICgpID0+ICh7IGFnZW50c0ZpbGVzOiBbXSB9KSB9IDoge30pLFxuXHR9KTtcblx0YXdhaXQgcmVzb3VyY2VMb2FkZXIucmVsb2FkKCk7XG5cdHRpbWUoXCJyZXNvdXJjZUxvYWRlci5yZWxvYWRcIik7XG5cblx0Y29uc3QgZXh0ZW5zaW9uc1Jlc3VsdDogTG9hZEV4dGVuc2lvbnNSZXN1bHQgPSByZXNvdXJjZUxvYWRlci5nZXRFeHRlbnNpb25zKCk7XG5cdGZvciAoY29uc3QgeyBwYXRoLCBlcnJvciB9IG9mIGV4dGVuc2lvbnNSZXN1bHQuZXJyb3JzKSB7XG5cdFx0Y29uc29sZS5lcnJvcihjaGFsay5yZWQoYEZhaWxlZCB0byBsb2FkIGV4dGVuc2lvbiBcIiR7cGF0aH1cIjogJHtlcnJvcn1gKSk7XG5cdH1cblxuXHQvLyBBcHBseSBwZW5kaW5nIHByb3ZpZGVyIHJlZ2lzdHJhdGlvbnMgZnJvbSBleHRlbnNpb25zIGltbWVkaWF0ZWx5XG5cdC8vIHNvIHRoZXkncmUgYXZhaWxhYmxlIGZvciBtb2RlbCByZXNvbHV0aW9uIGJlZm9yZSBBZ2VudFNlc3Npb24gaXMgY3JlYXRlZFxuXHRmb3IgKGNvbnN0IHsgbmFtZSwgY29uZmlnIH0gb2YgZXh0ZW5zaW9uc1Jlc3VsdC5ydW50aW1lLnBlbmRpbmdQcm92aWRlclJlZ2lzdHJhdGlvbnMpIHtcblx0XHRtb2RlbFJlZ2lzdHJ5LnJlZ2lzdGVyUHJvdmlkZXIobmFtZSwgY29uZmlnKTtcblx0fVxuXHRleHRlbnNpb25zUmVzdWx0LnJ1bnRpbWUucGVuZGluZ1Byb3ZpZGVyUmVnaXN0cmF0aW9ucyA9IFtdO1xuXG5cdGNvbnN0IGV4dGVuc2lvbkZsYWdzID0gbmV3IE1hcDxzdHJpbmcsIHsgdHlwZTogXCJib29sZWFuXCIgfCBcInN0cmluZ1wiIH0+KCk7XG5cdGZvciAoY29uc3QgZXh0IG9mIGV4dGVuc2lvbnNSZXN1bHQuZXh0ZW5zaW9ucykge1xuXHRcdGZvciAoY29uc3QgW25hbWUsIGZsYWddIG9mIGV4dC5mbGFncykge1xuXHRcdFx0ZXh0ZW5zaW9uRmxhZ3Muc2V0KG5hbWUsIHsgdHlwZTogZmxhZy50eXBlIH0pO1xuXHRcdH1cblx0fVxuXG5cdC8vIFNlY29uZCBwYXNzOiBwYXJzZSBhcmdzIHdpdGggZXh0ZW5zaW9uIGZsYWdzXG5cdGNvbnN0IHBhcnNlZCA9IHBhcnNlQXJncyhhcmdzLCBleHRlbnNpb25GbGFncyk7XG5cblx0Ly8gUGFzcyBmbGFnIHZhbHVlcyB0byBleHRlbnNpb25zIHZpYSBydW50aW1lXG5cdGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBwYXJzZWQudW5rbm93bkZsYWdzKSB7XG5cdFx0ZXh0ZW5zaW9uc1Jlc3VsdC5ydW50aW1lLmZsYWdWYWx1ZXMuc2V0KG5hbWUsIHZhbHVlKTtcblx0fVxuXG5cdGlmIChwYXJzZWQudmVyc2lvbikge1xuXHRcdGNvbnNvbGUubG9nKFZFUlNJT04pO1xuXHRcdHByb2Nlc3MuZXhpdCgwKTtcblx0fVxuXG5cdGlmIChwYXJzZWQuaGVscCkge1xuXHRcdHByaW50SGVscCgpO1xuXHRcdHByb2Nlc3MuZXhpdCgwKTtcblx0fVxuXG5cdGlmIChwYXJzZWQuYWRkUHJvdmlkZXIpIHtcblx0XHRjb25zdCB7IE1vZGVsc0pzb25Xcml0ZXIgfSA9IGF3YWl0IGltcG9ydChcIi4vY29yZS9tb2RlbHMtanNvbi13cml0ZXIuanNcIik7XG5cdFx0Y29uc3Qgd3JpdGVyID0gbmV3IE1vZGVsc0pzb25Xcml0ZXIoKTtcblx0XHR3cml0ZXIuc2V0UHJvdmlkZXIocGFyc2VkLmFkZFByb3ZpZGVyLCB7XG5cdFx0XHRiYXNlVXJsOiBwYXJzZWQuYWRkUHJvdmlkZXJCYXNlVXJsLFxuXHRcdFx0YXBpS2V5OiBwYXJzZWQuYXBpS2V5LFxuXHRcdH0pO1xuXHRcdGNvbnNvbGUubG9nKGBQcm92aWRlciBcIiR7cGFyc2VkLmFkZFByb3ZpZGVyfVwiIGFkZGVkIHRvIG1vZGVscy5qc29uYCk7XG5cdFx0cHJvY2Vzcy5leGl0KDApO1xuXHR9XG5cblx0aWYgKHBhcnNlZC5kaXNjb3Zlck1vZGVscyAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0Y29uc3QgcHJvdmlkZXIgPSB0eXBlb2YgcGFyc2VkLmRpc2NvdmVyTW9kZWxzID09PSBcInN0cmluZ1wiID8gcGFyc2VkLmRpc2NvdmVyTW9kZWxzIDogdW5kZWZpbmVkO1xuXHRcdGF3YWl0IGRpc2NvdmVyQW5kUHJpbnRNb2RlbHMobW9kZWxSZWdpc3RyeSwgcHJvdmlkZXIpO1xuXHRcdHByb2Nlc3MuZXhpdCgwKTtcblx0fVxuXG5cdGlmIChwYXJzZWQubGlzdE1vZGVscyAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0Y29uc3Qgc2VhcmNoUGF0dGVybiA9IHR5cGVvZiBwYXJzZWQubGlzdE1vZGVscyA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlZC5saXN0TW9kZWxzIDogdW5kZWZpbmVkO1xuXHRcdGF3YWl0IGxpc3RNb2RlbHMobW9kZWxSZWdpc3RyeSwgeyBzZWFyY2hQYXR0ZXJuLCBkaXNjb3ZlcjogcGFyc2VkLmRpc2NvdmVyIH0pO1xuXHRcdHByb2Nlc3MuZXhpdCgwKTtcblx0fVxuXG5cdC8vIFJlYWQgcGlwZWQgc3RkaW4gY29udGVudCAoaWYgYW55KSAtIHNraXAgZm9yIFJQQyBtb2RlIHdoaWNoIHVzZXMgc3RkaW4gZm9yIEpTT04tUlBDXG5cdGlmIChwYXJzZWQubW9kZSAhPT0gXCJycGNcIikge1xuXHRcdGNvbnN0IHN0ZGluQ29udGVudCA9IGF3YWl0IHJlYWRQaXBlZFN0ZGluKCk7XG5cdFx0aWYgKHN0ZGluQ29udGVudCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHQvLyBGb3JjZSBwcmludCBtb2RlIHNpbmNlIGludGVyYWN0aXZlIG1vZGUgcmVxdWlyZXMgYSBUVFkgZm9yIGtleWJvYXJkIGlucHV0XG5cdFx0XHRwYXJzZWQucHJpbnQgPSB0cnVlO1xuXHRcdFx0Ly8gUHJlcGVuZCBzdGRpbiBjb250ZW50IHRvIG1lc3NhZ2VzXG5cdFx0XHRwYXJzZWQubWVzc2FnZXMudW5zaGlmdChzdGRpbkNvbnRlbnQpO1xuXHRcdH1cblx0fVxuXG5cdGlmIChwYXJzZWQuZXhwb3J0KSB7XG5cdFx0bGV0IHJlc3VsdDogc3RyaW5nO1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBvdXRwdXRQYXRoID0gcGFyc2VkLm1lc3NhZ2VzLmxlbmd0aCA+IDAgPyBwYXJzZWQubWVzc2FnZXNbMF0gOiB1bmRlZmluZWQ7XG5cdFx0XHRyZXN1bHQgPSBhd2FpdCBleHBvcnRGcm9tRmlsZShwYXJzZWQuZXhwb3J0LCBvdXRwdXRQYXRoKTtcblx0XHR9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuXHRcdFx0Y29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogXCJGYWlsZWQgdG8gZXhwb3J0IHNlc3Npb25cIjtcblx0XHRcdGNvbnNvbGUuZXJyb3IoY2hhbGsucmVkKGBFcnJvcjogJHttZXNzYWdlfWApKTtcblx0XHRcdHByb2Nlc3MuZXhpdCgxKTtcblx0XHR9XG5cdFx0Y29uc29sZS5sb2coYEV4cG9ydGVkIHRvOiAke3Jlc3VsdH1gKTtcblx0XHRwcm9jZXNzLmV4aXQoMCk7XG5cdH1cblxuXHRpZiAocGFyc2VkLm1vZGUgPT09IFwicnBjXCIgJiYgcGFyc2VkLmZpbGVBcmdzLmxlbmd0aCA+IDApIHtcblx0XHRjb25zb2xlLmVycm9yKGNoYWxrLnJlZChcIkVycm9yOiBAZmlsZSBhcmd1bWVudHMgYXJlIG5vdCBzdXBwb3J0ZWQgaW4gUlBDIG1vZGVcIikpO1xuXHRcdHByb2Nlc3MuZXhpdCgxKTtcblx0fVxuXG5cdGNvbnN0IHsgaW5pdGlhbE1lc3NhZ2UsIGluaXRpYWxJbWFnZXMgfSA9IGF3YWl0IHByZXBhcmVJbml0aWFsTWVzc2FnZShwYXJzZWQsIHNldHRpbmdzTWFuYWdlci5nZXRJbWFnZUF1dG9SZXNpemUoKSk7XG5cdGNvbnN0IGlzSW50ZXJhY3RpdmUgPSAhcGFyc2VkLnByaW50ICYmIHBhcnNlZC5tb2RlID09PSB1bmRlZmluZWQ7XG5cdGNvbnN0IG1vZGUgPSBwYXJzZWQubW9kZSB8fCBcInRleHRcIjtcblx0aW5pdFRoZW1lKHNldHRpbmdzTWFuYWdlci5nZXRUaGVtZSgpLCBpc0ludGVyYWN0aXZlKTtcblxuXHQvLyBTaG93IGRlcHJlY2F0aW9uIHdhcm5pbmdzIGluIGludGVyYWN0aXZlIG1vZGVcblx0aWYgKGlzSW50ZXJhY3RpdmUgJiYgZGVwcmVjYXRpb25XYXJuaW5ncy5sZW5ndGggPiAwKSB7XG5cdFx0YXdhaXQgc2hvd0RlcHJlY2F0aW9uV2FybmluZ3MoZGVwcmVjYXRpb25XYXJuaW5ncyk7XG5cdH1cblxuXHRsZXQgc2NvcGVkTW9kZWxzOiBTY29wZWRNb2RlbFtdID0gW107XG5cdGNvbnN0IG1vZGVsUGF0dGVybnMgPSBwYXJzZWQubW9kZWxzID8/IHNldHRpbmdzTWFuYWdlci5nZXRFbmFibGVkTW9kZWxzKCk7XG5cdGlmIChtb2RlbFBhdHRlcm5zICYmIG1vZGVsUGF0dGVybnMubGVuZ3RoID4gMCkge1xuXHRcdHNjb3BlZE1vZGVscyA9IGF3YWl0IHJlc29sdmVNb2RlbFNjb3BlKG1vZGVsUGF0dGVybnMsIG1vZGVsUmVnaXN0cnkpO1xuXHR9XG5cblx0Ly8gQ3JlYXRlIHNlc3Npb24gbWFuYWdlciBiYXNlZCBvbiBDTEkgZmxhZ3Ncblx0bGV0IHNlc3Npb25NYW5hZ2VyID0gYXdhaXQgY3JlYXRlU2Vzc2lvbk1hbmFnZXIocGFyc2VkLCBjd2QsIGV4dGVuc2lvbnNSZXN1bHQpO1xuXG5cdC8vIEhhbmRsZSAtLXJlc3VtZTogc2hvdyBzZXNzaW9uIHBpY2tlclxuXHRpZiAocGFyc2VkLnJlc3VtZSkge1xuXHRcdC8vIEluaXRpYWxpemUga2V5YmluZGluZ3Mgc28gc2Vzc2lvbiBwaWNrZXIgcmVzcGVjdHMgdXNlciBjb25maWdcblx0XHRLZXliaW5kaW5nc01hbmFnZXIuY3JlYXRlKCk7XG5cblx0XHQvLyBDb21wdXRlIGVmZmVjdGl2ZSBzZXNzaW9uIGRpciBmb3IgcmVzdW1lIChzYW1lIGxvZ2ljIGFzIGNyZWF0ZVNlc3Npb25NYW5hZ2VyKVxuXHRcdGNvbnN0IGVmZmVjdGl2ZVNlc3Npb25EaXIgPSBwYXJzZWQuc2Vzc2lvbkRpciB8fCAoYXdhaXQgY2FsbFNlc3Npb25EaXJlY3RvcnlIb29rKGV4dGVuc2lvbnNSZXN1bHQsIGN3ZCkpO1xuXG5cdFx0Y29uc3Qgc2VsZWN0ZWRQYXRoID0gYXdhaXQgc2VsZWN0U2Vzc2lvbihcblx0XHRcdChvblByb2dyZXNzKSA9PiBTZXNzaW9uTWFuYWdlci5saXN0KGN3ZCwgZWZmZWN0aXZlU2Vzc2lvbkRpciwgb25Qcm9ncmVzcyksXG5cdFx0XHRTZXNzaW9uTWFuYWdlci5saXN0QWxsLFxuXHRcdCk7XG5cdFx0aWYgKCFzZWxlY3RlZFBhdGgpIHtcblx0XHRcdGNvbnNvbGUubG9nKGNoYWxrLmRpbShcIk5vIHNlc3Npb24gc2VsZWN0ZWRcIikpO1xuXHRcdFx0c3RvcFRoZW1lV2F0Y2hlcigpO1xuXHRcdFx0cHJvY2Vzcy5leGl0KDApO1xuXHRcdH1cblx0XHRzZXNzaW9uTWFuYWdlciA9IFNlc3Npb25NYW5hZ2VyLm9wZW4oc2VsZWN0ZWRQYXRoLCBlZmZlY3RpdmVTZXNzaW9uRGlyKTtcblx0fVxuXG5cdGNvbnN0IHsgb3B0aW9uczogc2Vzc2lvbk9wdGlvbnMsIGNsaVRoaW5raW5nRnJvbU1vZGVsIH0gPSBidWlsZFNlc3Npb25PcHRpb25zKFxuXHRcdHBhcnNlZCxcblx0XHRzY29wZWRNb2RlbHMsXG5cdFx0c2Vzc2lvbk1hbmFnZXIsXG5cdFx0bW9kZWxSZWdpc3RyeSxcblx0XHRzZXR0aW5nc01hbmFnZXIsXG5cdCk7XG5cdHNlc3Npb25PcHRpb25zLmF1dGhTdG9yYWdlID0gYXV0aFN0b3JhZ2U7XG5cdHNlc3Npb25PcHRpb25zLm1vZGVsUmVnaXN0cnkgPSBtb2RlbFJlZ2lzdHJ5O1xuXHRzZXNzaW9uT3B0aW9ucy5yZXNvdXJjZUxvYWRlciA9IHJlc291cmNlTG9hZGVyO1xuXG5cdC8vIEhhbmRsZSBDTEkgLS1hcGkta2V5IGFzIHJ1bnRpbWUgb3ZlcnJpZGUgKG5vdCBwZXJzaXN0ZWQpXG5cdGlmIChwYXJzZWQuYXBpS2V5KSB7XG5cdFx0aWYgKCFzZXNzaW9uT3B0aW9ucy5tb2RlbCkge1xuXHRcdFx0Y29uc29sZS5lcnJvcihcblx0XHRcdFx0Y2hhbGsucmVkKFwiLS1hcGkta2V5IHJlcXVpcmVzIGEgbW9kZWwgdG8gYmUgc3BlY2lmaWVkIHZpYSAtLW1vZGVsLCAtLXByb3ZpZGVyLy0tbW9kZWwsIG9yIC0tbW9kZWxzXCIpLFxuXHRcdFx0KTtcblx0XHRcdHByb2Nlc3MuZXhpdCgxKTtcblx0XHR9XG5cdFx0YXV0aFN0b3JhZ2Uuc2V0UnVudGltZUFwaUtleShzZXNzaW9uT3B0aW9ucy5tb2RlbC5wcm92aWRlciwgcGFyc2VkLmFwaUtleSk7XG5cdH1cblxuXHRjb25zdCB7IHNlc3Npb24sIG1vZGVsRmFsbGJhY2tNZXNzYWdlIH0gPSBhd2FpdCBjcmVhdGVBZ2VudFNlc3Npb24oc2Vzc2lvbk9wdGlvbnMpO1xuXG5cdGlmICghaXNJbnRlcmFjdGl2ZSAmJiAhc2Vzc2lvbi5tb2RlbCkge1xuXHRcdGNvbnNvbGUuZXJyb3IoY2hhbGsucmVkKFwiTm8gbW9kZWxzIGF2YWlsYWJsZS5cIikpO1xuXHRcdGNvbnNvbGUuZXJyb3IoY2hhbGsueWVsbG93KFwiXFxuU2V0IGFuIEFQSSBrZXkgZW52aXJvbm1lbnQgdmFyaWFibGU6XCIpKTtcblx0XHRjb25zb2xlLmVycm9yKFwiICBBTlRIUk9QSUNfQVBJX0tFWSwgT1BFTkFJX0FQSV9LRVksIEdFTUlOSV9BUElfS0VZLCBldGMuXCIpO1xuXHRcdGNvbnNvbGUuZXJyb3IoY2hhbGsueWVsbG93KGBcXG5PciBjcmVhdGUgJHtnZXRNb2RlbHNQYXRoKCl9YCkpO1xuXHRcdHByb2Nlc3MuZXhpdCgxKTtcblx0fVxuXG5cdC8vIENsYW1wIHRoaW5raW5nIGxldmVsIHRvIG1vZGVsIGNhcGFiaWxpdGllcyBmb3IgQ0xJLXByb3ZpZGVkIHRoaW5raW5nIGxldmVscy5cblx0Ly8gVGhpcyBjb3ZlcnMgYm90aCAtLXRoaW5raW5nIDxsZXZlbD4gYW5kIC0tbW9kZWwgPHBhdHRlcm4+Ojx0aGlua2luZz4uXG5cdGNvbnN0IGNsaVRoaW5raW5nT3ZlcnJpZGUgPSBwYXJzZWQudGhpbmtpbmcgIT09IHVuZGVmaW5lZCB8fCBjbGlUaGlua2luZ0Zyb21Nb2RlbDtcblx0aWYgKHNlc3Npb24ubW9kZWwgJiYgY2xpVGhpbmtpbmdPdmVycmlkZSkge1xuXHRcdGxldCBlZmZlY3RpdmVUaGlua2luZyA9IHNlc3Npb24udGhpbmtpbmdMZXZlbDtcblx0XHRpZiAoIXNlc3Npb24ubW9kZWwucmVhc29uaW5nKSB7XG5cdFx0XHRlZmZlY3RpdmVUaGlua2luZyA9IFwib2ZmXCI7XG5cdFx0fSBlbHNlIGlmIChlZmZlY3RpdmVUaGlua2luZyA9PT0gXCJ4aGlnaFwiICYmICFzdXBwb3J0c1hoaWdoKHNlc3Npb24ubW9kZWwpKSB7XG5cdFx0XHRlZmZlY3RpdmVUaGlua2luZyA9IFwiaGlnaFwiO1xuXHRcdH1cblx0XHRpZiAoZWZmZWN0aXZlVGhpbmtpbmcgIT09IHNlc3Npb24udGhpbmtpbmdMZXZlbCkge1xuXHRcdFx0c2Vzc2lvbi5zZXRUaGlua2luZ0xldmVsKGVmZmVjdGl2ZVRoaW5raW5nKTtcblx0XHR9XG5cdH1cblxuXHRpZiAobW9kZSA9PT0gXCJycGNcIikge1xuXHRcdGF3YWl0IHJ1blJwY01vZGUoc2Vzc2lvbik7XG5cdH0gZWxzZSBpZiAoaXNJbnRlcmFjdGl2ZSkge1xuXHRcdGlmIChzY29wZWRNb2RlbHMubGVuZ3RoID4gMCAmJiAocGFyc2VkLnZlcmJvc2UgfHwgIXNldHRpbmdzTWFuYWdlci5nZXRRdWlldFN0YXJ0dXAoKSkpIHtcblx0XHRcdGNvbnN0IG1vZGVsTGlzdCA9IHNjb3BlZE1vZGVsc1xuXHRcdFx0XHQubWFwKChzbSkgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IHRoaW5raW5nU3RyID0gc20udGhpbmtpbmdMZXZlbCA/IGA6JHtzbS50aGlua2luZ0xldmVsfWAgOiBcIlwiO1xuXHRcdFx0XHRcdHJldHVybiBgJHtzbS5tb2RlbC5pZH0ke3RoaW5raW5nU3RyfWA7XG5cdFx0XHRcdH0pXG5cdFx0XHRcdC5qb2luKFwiLCBcIik7XG5cdFx0XHRjb25zb2xlLmxvZyhjaGFsay5kaW0oYE1vZGVsIHNjb3BlOiAke21vZGVsTGlzdH0gJHtjaGFsay5ncmF5KFwiKEN0cmwrUCB0byBjeWNsZSlcIil9YCkpO1xuXHRcdH1cblxuXHRcdHByaW50VGltaW5ncygpO1xuXHRcdGNvbnN0IG1vZGUgPSBuZXcgSW50ZXJhY3RpdmVNb2RlKHNlc3Npb24sIHtcblx0XHRcdG1pZ3JhdGVkUHJvdmlkZXJzLFxuXHRcdFx0bW9kZWxGYWxsYmFja01lc3NhZ2UsXG5cdFx0XHRpbml0aWFsTWVzc2FnZSxcblx0XHRcdGluaXRpYWxJbWFnZXMsXG5cdFx0XHRpbml0aWFsTWVzc2FnZXM6IHBhcnNlZC5tZXNzYWdlcyxcblx0XHRcdHZlcmJvc2U6IHBhcnNlZC52ZXJib3NlLFxuXHRcdH0pO1xuXHRcdGF3YWl0IG1vZGUucnVuKCk7XG5cdH0gZWxzZSB7XG5cdFx0YXdhaXQgcnVuUHJpbnRNb2RlKHNlc3Npb24sIHtcblx0XHRcdG1vZGUsXG5cdFx0XHRtZXNzYWdlczogcGFyc2VkLm1lc3NhZ2VzLFxuXHRcdFx0aW5pdGlhbE1lc3NhZ2UsXG5cdFx0XHRpbml0aWFsSW1hZ2VzLFxuXHRcdH0pO1xuXHRcdHN0b3BUaGVtZVdhdGNoZXIoKTtcblx0XHRpZiAocHJvY2Vzcy5zdGRvdXQud3JpdGFibGVMZW5ndGggPiAwKSB7XG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gcHJvY2Vzcy5zdGRvdXQub25jZShcImRyYWluXCIsIHJlc29sdmUpKTtcblx0XHR9XG5cdFx0cHJvY2Vzcy5leGl0KDApO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUE0QixnQkFBZ0IscUJBQXFCO0FBQ2pFLE9BQU8sV0FBVztBQUNsQixTQUFTLHVCQUF1QjtBQUNoQyxTQUFvQixXQUFXLGlCQUFpQjtBQUNoRCxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLDRCQUE0QjtBQUNyQyxTQUFTLHdCQUF3QixrQkFBa0I7QUFDbkQsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxVQUFVLGFBQWEsZUFBZSxlQUFlO0FBQzlELFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsc0JBQXNCO0FBRS9CLFNBQVMsMEJB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
