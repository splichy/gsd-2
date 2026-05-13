import { theme } from "../../modes/interactive/theme/theme.js";
const RESERVED_ACTIONS_FOR_EXTENSION_CONFLICTS = [
  "interrupt",
  "clear",
  "exit",
  "suspend",
  "cycleThinkingLevel",
  "cycleModelForward",
  "cycleModelBackward",
  "selectModel",
  "expandTools",
  "toggleThinking",
  "externalEditor",
  "followUp",
  "submit",
  "selectConfirm",
  "selectCancel",
  "copy",
  "deleteToLineEnd"
];
const buildBuiltinKeybindings = (effectiveKeybindings) => {
  const builtinKeybindings = {};
  for (const [action, keys] of Object.entries(effectiveKeybindings)) {
    const keyAction = action;
    const keyList = Array.isArray(keys) ? keys : [keys];
    const restrictOverride = RESERVED_ACTIONS_FOR_EXTENSION_CONFLICTS.includes(keyAction);
    for (const key of keyList) {
      const normalizedKey = key.toLowerCase();
      builtinKeybindings[normalizedKey] = {
        action: keyAction,
        restrictOverride
      };
    }
  }
  return builtinKeybindings;
};
const PROTECTED_EXTENSION_COMMANDS = /* @__PURE__ */ new Set(["gsd"]);
function isProtectedCommandOwner(commandName, extensionPath) {
  if (!PROTECTED_EXTENSION_COMMANDS.has(commandName)) return false;
  const normalized = extensionPath.replace(/\\/g, "/");
  return /\/extensions\/gsd\/(?:index\.[cm]?[jt]s|dist\/.*)$/.test(normalized) || /\/extensions\/gsd\/?$/.test(normalized);
}
const noOpUIContext = {
  select: async () => void 0,
  confirm: async () => false,
  input: async () => void 0,
  notify: () => {
  },
  onTerminalInput: () => () => {
  },
  setStatus: () => {
  },
  setWorkingMessage: () => {
  },
  setWidget: () => {
  },
  setFooter: () => {
  },
  setHeader: () => {
  },
  setTitle: () => {
  },
  custom: async () => void 0,
  pasteToEditor: () => {
  },
  setEditorText: () => {
  },
  getEditorText: () => "",
  editor: async () => void 0,
  setEditorComponent: () => {
  },
  get theme() {
    return theme;
  },
  getAllThemes: () => [],
  getTheme: () => void 0,
  setTheme: (_theme) => ({ success: false, error: "UI not available" }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => {
  }
};
class ExtensionRunner {
  constructor(extensions, runtime, cwd, sessionManager, modelRegistry) {
    this.errorListeners = /* @__PURE__ */ new Set();
    this.getModel = () => void 0;
    this.isIdleFn = () => true;
    this.waitForIdleFn = async () => {
    };
    this.abortFn = () => {
    };
    this.hasPendingMessagesFn = () => false;
    this.getContextUsageFn = () => void 0;
    this.compactFn = () => {
    };
    this.getSystemPromptFn = () => "";
    this.setCompactionThresholdOverrideFn = () => {
    };
    this.newSessionHandler = async () => {
      throw new Error("Command context not yet bound: newSession is unavailable during early lifecycle");
    };
    this.forkHandler = async () => {
      throw new Error("Command context not yet bound: fork is unavailable during early lifecycle");
    };
    this.navigateTreeHandler = async () => {
      throw new Error("Command context not yet bound: navigateTree is unavailable during early lifecycle");
    };
    this.switchSessionHandler = async () => {
      throw new Error("Command context not yet bound: switchSession is unavailable during early lifecycle");
    };
    this.reloadHandler = async () => {
      throw new Error("Command context not yet bound: reload is unavailable during early lifecycle");
    };
    this.shutdownHandler = () => {
    };
    this.shortcutDiagnostics = [];
    this.commandDiagnostics = [];
    this.extensions = extensions;
    this.runtime = runtime;
    this.uiContext = noOpUIContext;
    this.cwd = cwd;
    this.sessionManager = sessionManager;
    this.modelRegistry = modelRegistry;
    this.runtime.emitBeforeModelSelect = (event) => this.emitBeforeModelSelect(event);
    this.runtime.emitAdjustToolSet = (event) => this.emitAdjustToolSet(event);
    this.runtime.emitExtensionEvent = (event) => this.emitExtensionEventDynamic(event);
  }
  currentCwd() {
    return this.cwd;
  }
  /**
   * Dispatch an ExtensionEvent by type. Used by extensions to emit the
   * post-plan Layer 2 events (git lifecycle, verify, budget, milestone,
   * unit, notification, stop, session_end) without a bespoke method per
   * type. Returns the handler chain's aggregate result where meaningful.
   */
  async emitExtensionEventDynamic(event) {
    switch (event.type) {
      case "notification":
        return this.emitNotification({ kind: event.kind, message: event.message, details: event.details });
      case "stop":
        return this.emitStop({ reason: event.reason, lastMessage: event.lastMessage });
      case "session_end":
        return this.emitSessionEnd({ reason: event.reason, sessionFile: event.sessionFile });
      case "before_commit":
        return this.emitBeforeCommit({
          message: event.message,
          files: event.files,
          cwd: event.cwd,
          author: event.author
        });
      case "commit":
        return this.emitCommit({ sha: event.sha, message: event.message, files: event.files, cwd: event.cwd });
      case "before_push":
        return this.emitBeforePush({ remote: event.remote, branch: event.branch, cwd: event.cwd });
      case "push":
        return this.emitPush({ remote: event.remote, branch: event.branch, cwd: event.cwd });
      case "before_pr":
        return this.emitBeforePr({
          branch: event.branch,
          targetBranch: event.targetBranch,
          title: event.title,
          body: event.body,
          cwd: event.cwd
        });
      case "pr_opened":
        return this.emitPrOpened({
          url: event.url,
          branch: event.branch,
          targetBranch: event.targetBranch,
          cwd: event.cwd
        });
      case "before_verify":
        return this.emitBeforeVerify({ unitType: event.unitType, unitId: event.unitId, cwd: event.cwd });
      case "verify_result":
        return this.emitVerifyResult({
          passed: event.passed,
          failures: event.failures,
          unitType: event.unitType,
          unitId: event.unitId,
          cwd: event.cwd
        });
      case "budget_threshold":
        return this.emitBudgetThreshold({
          fraction: event.fraction,
          spent: event.spent,
          limit: event.limit,
          currency: event.currency
        });
      case "milestone_start":
        return this.emitMilestoneStart({ milestoneId: event.milestoneId, title: event.title, cwd: event.cwd });
      case "milestone_end":
        return this.emitMilestoneEnd({
          milestoneId: event.milestoneId,
          status: event.status,
          cwd: event.cwd
        });
      case "unit_start":
        return this.emitUnitStart({
          unitType: event.unitType,
          unitId: event.unitId,
          milestoneId: event.milestoneId,
          cwd: event.cwd
        });
      case "unit_end":
        return this.emitUnitEnd({
          unitType: event.unitType,
          unitId: event.unitId,
          milestoneId: event.milestoneId,
          status: event.status,
          cwd: event.cwd
        });
      default:
        return void 0;
    }
  }
  /**
   * Install a synthetic "extension" that only provides event handlers.
   * Used by the Layer 0 hooks-runner to bridge shell hooks onto the
   * extension event bus without requiring a full extension module. The
   * returned disposer removes the synthetic extension.
   */
  installHookBridge(path, handlers) {
    const synthetic = {
      path,
      resolvedPath: path,
      handlers,
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
    this.extensions.push(synthetic);
    return () => {
      const index = this.extensions.indexOf(synthetic);
      if (index >= 0) this.extensions.splice(index, 1);
    };
  }
  bindCore(actions, contextActions) {
    this.runtime.sendMessage = actions.sendMessage;
    this.runtime.sendUserMessage = actions.sendUserMessage;
    this.runtime.retryLastTurn = actions.retryLastTurn;
    this.runtime.appendEntry = actions.appendEntry;
    this.runtime.setSessionName = actions.setSessionName;
    this.runtime.getSessionName = actions.getSessionName;
    this.runtime.setLabel = actions.setLabel;
    this.runtime.getActiveTools = actions.getActiveTools;
    this.runtime.getAllTools = actions.getAllTools;
    this.runtime.setActiveTools = actions.setActiveTools;
    this.runtime.getVisibleSkills = actions.getVisibleSkills;
    this.runtime.setVisibleSkills = actions.setVisibleSkills;
    this.runtime.refreshTools = actions.refreshTools;
    this.runtime.getCommands = actions.getCommands;
    this.runtime.setModel = actions.setModel;
    this.runtime.getThinkingLevel = actions.getThinkingLevel;
    this.runtime.setThinkingLevel = actions.setThinkingLevel;
    this.getModel = contextActions.getModel;
    this.isIdleFn = contextActions.isIdle;
    this.abortFn = contextActions.abort;
    this.hasPendingMessagesFn = contextActions.hasPendingMessages;
    this.shutdownHandler = contextActions.shutdown;
    this.getContextUsageFn = contextActions.getContextUsage;
    this.compactFn = contextActions.compact;
    this.getSystemPromptFn = contextActions.getSystemPrompt;
    this.setCompactionThresholdOverrideFn = contextActions.setCompactionThresholdOverride;
    for (const { name, config } of this.runtime.pendingProviderRegistrations) {
      this.modelRegistry.registerProvider(name, config);
    }
    this.runtime.pendingProviderRegistrations = [];
    this.runtime.registerProvider = (name, config) => this.modelRegistry.registerProvider(name, config);
    this.runtime.unregisterProvider = (name) => this.modelRegistry.unregisterProvider(name);
  }
  bindCommandContext(actions) {
    if (actions) {
      this.waitForIdleFn = actions.waitForIdle;
      this.newSessionHandler = actions.newSession;
      this.forkHandler = actions.fork;
      this.navigateTreeHandler = actions.navigateTree;
      this.switchSessionHandler = actions.switchSession;
      this.reloadHandler = actions.reload;
      return;
    }
    this.waitForIdleFn = async () => {
    };
    this.newSessionHandler = async () => ({ cancelled: false });
    this.forkHandler = async () => ({ cancelled: false });
    this.navigateTreeHandler = async () => ({ cancelled: false });
    this.switchSessionHandler = async () => ({ cancelled: false });
    this.reloadHandler = async () => {
    };
  }
  setUIContext(uiContext) {
    this.uiContext = uiContext ?? noOpUIContext;
  }
  getUIContext() {
    return this.uiContext;
  }
  hasUI() {
    return this.uiContext !== noOpUIContext;
  }
  getExtensionPaths() {
    return this.extensions.map((e) => e.path);
  }
  /** Get all registered tools from all extensions (first registration per name wins). */
  getAllRegisteredTools() {
    const toolsByName = /* @__PURE__ */ new Map();
    for (const ext of this.extensions) {
      for (const tool of ext.tools.values()) {
        if (!toolsByName.has(tool.definition.name)) {
          toolsByName.set(tool.definition.name, tool);
        }
      }
    }
    return Array.from(toolsByName.values());
  }
  /** Get a tool definition by name. Returns undefined if not found. */
  getToolDefinition(toolName) {
    for (const ext of this.extensions) {
      const tool = ext.tools.get(toolName);
      if (tool) {
        return tool.definition;
      }
    }
    return void 0;
  }
  getFlags() {
    const allFlags = /* @__PURE__ */ new Map();
    for (const ext of this.extensions) {
      for (const [name, flag] of ext.flags) {
        if (!allFlags.has(name)) {
          allFlags.set(name, flag);
        }
      }
    }
    return allFlags;
  }
  setFlagValue(name, value) {
    this.runtime.flagValues.set(name, value);
  }
  getFlagValues() {
    return new Map(this.runtime.flagValues);
  }
  getShortcuts(effectiveKeybindings) {
    this.shortcutDiagnostics = [];
    const builtinKeybindings = buildBuiltinKeybindings(effectiveKeybindings);
    const extensionShortcuts = /* @__PURE__ */ new Map();
    const addDiagnostic = (message, extensionPath) => {
      this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
      if (!this.hasUI()) {
        console.warn(message);
      }
    };
    for (const ext of this.extensions) {
      for (const [key, shortcut] of ext.shortcuts) {
        const normalizedKey = key.toLowerCase();
        const builtInKeybinding = builtinKeybindings[normalizedKey];
        if (builtInKeybinding?.restrictOverride === true) {
          addDiagnostic(
            `Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
            shortcut.extensionPath
          );
          continue;
        }
        if (builtInKeybinding?.restrictOverride === false) {
          addDiagnostic(
            `Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.action} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
            shortcut.extensionPath
          );
        }
        const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
        if (existingExtensionShortcut) {
          addDiagnostic(
            `Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
            shortcut.extensionPath
          );
        }
        extensionShortcuts.set(normalizedKey, shortcut);
      }
    }
    return extensionShortcuts;
  }
  getShortcutDiagnostics() {
    return this.shortcutDiagnostics;
  }
  onError(listener) {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
  emitError(error) {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
  hasHandlers(eventType) {
    for (const ext of this.extensions) {
      const handlers = ext.handlers.get(eventType);
      if (handlers && handlers.length > 0) {
        return true;
      }
    }
    return false;
  }
  getMessageRenderer(customType) {
    for (const ext of this.extensions) {
      const renderer = ext.messageRenderers.get(customType);
      if (renderer) {
        return renderer;
      }
    }
    return void 0;
  }
  getRegisteredCommands(reserved) {
    this.commandDiagnostics = [];
    const commands = [];
    const commandOwners = /* @__PURE__ */ new Map();
    const protectedOwners = /* @__PURE__ */ new Map();
    for (const ext of this.extensions) {
      for (const command of ext.commands.values()) {
        if (isProtectedCommandOwner(command.name, ext.path)) {
          protectedOwners.set(command.name, ext.path);
        }
      }
    }
    for (const ext of this.extensions) {
      for (const command of ext.commands.values()) {
        if (reserved?.has(command.name)) {
          const message = `Extension command '${command.name}' from ${ext.path} conflicts with built-in commands. Skipping.`;
          this.commandDiagnostics.push({ type: "warning", message, path: ext.path });
          if (!this.hasUI()) {
            console.warn(message);
          }
          continue;
        }
        const protectedOwner = protectedOwners.get(command.name);
        if (protectedOwner && protectedOwner !== ext.path) {
          const message = `Extension command '${command.name}' from ${ext.path} conflicts with protected command owner ${protectedOwner}. Skipping.`;
          this.commandDiagnostics.push({ type: "warning", message, path: ext.path });
          if (!this.hasUI()) {
            console.warn(message);
          }
          continue;
        }
        const existingOwner = commandOwners.get(command.name);
        if (existingOwner) {
          const message = `Extension command '${command.name}' from ${ext.path} conflicts with ${existingOwner}. Skipping.`;
          this.commandDiagnostics.push({ type: "warning", message, path: ext.path });
          if (!this.hasUI()) {
            console.warn(message);
          }
          continue;
        }
        commandOwners.set(command.name, ext.path);
        commands.push(command);
      }
    }
    return commands;
  }
  getCommandDiagnostics() {
    return this.commandDiagnostics;
  }
  getRegisteredCommandsWithPaths() {
    const result = [];
    for (const ext of this.extensions) {
      for (const command of ext.commands.values()) {
        result.push({ command, extensionPath: ext.path });
      }
    }
    return result;
  }
  getCommand(name) {
    let protectedCommand;
    for (const ext of this.extensions) {
      const command = ext.commands.get(name);
      if (command) {
        if (isProtectedCommandOwner(name, ext.path)) {
          protectedCommand = command;
          break;
        }
        if (PROTECTED_EXTENSION_COMMANDS.has(name)) {
          continue;
        }
        return command;
      }
    }
    return protectedCommand;
  }
  /**
   * Request a graceful shutdown. Called by extension tools and event handlers.
   * The actual shutdown behavior is provided by the mode via bindExtensions().
   */
  shutdown() {
    this.shutdownHandler();
  }
  /**
   * Create an ExtensionContext for use in event handlers and tool execution.
   * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
   */
  createContext() {
    const getModel = this.getModel;
    return {
      ui: this.uiContext,
      hasUI: this.hasUI(),
      cwd: this.currentCwd(),
      sessionManager: this.sessionManager,
      modelRegistry: this.modelRegistry,
      get model() {
        return getModel();
      },
      isIdle: () => this.isIdleFn(),
      abort: () => this.abortFn(),
      hasPendingMessages: () => this.hasPendingMessagesFn(),
      shutdown: () => this.shutdownHandler(),
      getContextUsage: () => this.getContextUsageFn(),
      compact: (options) => this.compactFn(options),
      getSystemPrompt: () => this.getSystemPromptFn(),
      setCompactionThresholdOverride: (percent) => this.setCompactionThresholdOverrideFn(percent)
    };
  }
  createEventContext(eventType) {
    return {
      ...this.createContext(),
      shutdown: () => {
        throw new Error(`Extension event '${eventType}' cannot request TUI shutdown`);
      }
    };
  }
  isShutdownGuardedEvent(eventType) {
    return eventType === "agent_end" || eventType === "stop" || eventType === "session_end";
  }
  createCommandContext() {
    return {
      ...this.createContext(),
      waitForIdle: () => this.waitForIdleFn(),
      newSession: (options) => this.newSessionHandler(options),
      fork: (entryId) => this.forkHandler(entryId),
      navigateTree: (targetId, options) => this.navigateTreeHandler(targetId, options),
      switchSession: (sessionPath) => this.switchSessionHandler(sessionPath),
      reload: () => this.reloadHandler()
    };
  }
  isSessionBeforeEvent(event) {
    return event.type === "session_before_switch" || event.type === "session_before_fork" || event.type === "session_before_compact" || event.type === "session_before_tree";
  }
  /**
   * Shared handler invocation loop.
   *
   * Iterates every handler registered for `eventType` across all extensions,
   * calling each inside a try/catch that emits an ExtensionError on failure.
   *
   * `getEvent` builds the event object for each handler call — callers that
   * mutate state between calls (e.g. context, before_provider_request) supply
   * a function; callers with a fixed event can pass a constant.
   *
   * `processResult` receives each handler's return value and the owning
   * extension's path. It returns `{ done: true }` to short-circuit
   * or `{ done: false }` to keep iterating.
   */
  async invokeHandlers(eventType, getEvent, processResult) {
    const ctx = this.isShutdownGuardedEvent(eventType) ? this.createEventContext(eventType) : this.createContext();
    for (const ext of this.extensions) {
      const handlers = ext.handlers.get(eventType);
      if (!handlers || handlers.length === 0) continue;
      for (const handler of handlers) {
        try {
          const event = getEvent();
          const handlerResult = await handler(event, ctx);
          const action = processResult(handlerResult, ext.path);
          if (action.done) return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : void 0;
          this.emitError({
            extensionPath: ext.path,
            event: eventType,
            error: message,
            stack
          });
        }
      }
    }
  }
  async emit(event) {
    let result;
    const isSessionBefore = this.isSessionBeforeEvent(event);
    await this.invokeHandlers(event.type, () => event, (handlerResult) => {
      if (isSessionBefore && handlerResult) {
        result = handlerResult;
        if (result.cancel) return { done: true };
      }
      return { done: false };
    });
    return result;
  }
  async emitToolResult(event) {
    const currentEvent = { ...event };
    let modified = false;
    await this.invokeHandlers("tool_result", () => currentEvent, (handlerResult) => {
      const r = handlerResult;
      if (!r) return { done: false };
      if (r.content !== void 0) {
        currentEvent.content = r.content;
        modified = true;
      }
      if (r.details !== void 0) {
        currentEvent.details = r.details;
        modified = true;
      }
      if (r.isError !== void 0) {
        currentEvent.isError = r.isError;
        modified = true;
      }
      return { done: false };
    });
    if (!modified) return void 0;
    return { content: currentEvent.content, details: currentEvent.details, isError: currentEvent.isError };
  }
  async emitToolCall(event) {
    let result;
    await this.invokeHandlers("tool_call", () => event, (handlerResult) => {
      if (handlerResult) {
        result = handlerResult;
        if (result.block) return { done: true };
      }
      return { done: false };
    });
    return result;
  }
  async emitBashTransform(command, cwd) {
    if (!this.hasHandlers("bash_transform")) return command;
    let current = command;
    await this.invokeHandlers(
      "bash_transform",
      () => ({ type: "bash_transform", command: current, cwd }),
      (handlerResult) => {
        const result = handlerResult;
        if (result?.command && result.command.trim()) {
          current = result.command;
        }
        return { done: false };
      }
    );
    return current;
  }
  async emitUserBash(event) {
    let result;
    await this.invokeHandlers("user_bash", () => event, (handlerResult) => {
      if (handlerResult) {
        result = handlerResult;
        return { done: true };
      }
      return { done: false };
    });
    return result;
  }
  async emitContext(messages) {
    let currentMessages = structuredClone(messages);
    await this.invokeHandlers("context", () => ({ type: "context", messages: currentMessages }), (handlerResult) => {
      if (handlerResult && handlerResult.messages) {
        currentMessages = handlerResult.messages;
      }
      return { done: false };
    });
    return currentMessages;
  }
  async emitBeforeProviderRequest(payload, model) {
    let currentPayload = payload;
    await this.invokeHandlers("before_provider_request", () => ({
      type: "before_provider_request",
      payload: currentPayload,
      model
    }), (handlerResult) => {
      if (handlerResult !== void 0) currentPayload = handlerResult;
      return { done: false };
    });
    return currentPayload;
  }
  async emitBeforeModelSelect(event) {
    let result;
    await this.invokeHandlers("before_model_select", () => ({
      type: "before_model_select",
      ...event
    }), (handlerResult) => {
      if (handlerResult) {
        result = handlerResult;
        return { done: true };
      }
      return { done: false };
    });
    return result;
  }
  async emitAdjustToolSet(event) {
    let result;
    await this.invokeHandlers("adjust_tool_set", () => ({
      type: "adjust_tool_set",
      ...event
    }), (handlerResult) => {
      if (handlerResult) {
        result = handlerResult;
        return { done: true };
      }
      return { done: false };
    });
    return result;
  }
  async emitBeforeAgentStart(prompt, images, systemPrompt) {
    const messages = [];
    let currentSystemPrompt = systemPrompt;
    let systemPromptModified = false;
    await this.invokeHandlers("before_agent_start", () => ({
      type: "before_agent_start",
      prompt,
      images,
      systemPrompt: currentSystemPrompt
    }), (handlerResult) => {
      if (handlerResult) {
        const r = handlerResult;
        if (r.message) messages.push(r.message);
        if (r.systemPrompt !== void 0) {
          currentSystemPrompt = r.systemPrompt;
          systemPromptModified = true;
        }
      }
      return { done: false };
    });
    if (messages.length > 0 || systemPromptModified) {
      return {
        messages: messages.length > 0 ? messages : void 0,
        systemPrompt: systemPromptModified ? currentSystemPrompt : void 0
      };
    }
    return void 0;
  }
  async emitResourcesDiscover(cwd, reason) {
    const skillPaths = [];
    const promptPaths = [];
    const themePaths = [];
    await this.invokeHandlers("resources_discover", () => ({
      type: "resources_discover",
      cwd,
      reason
    }), (handlerResult, extensionPath) => {
      const r = handlerResult;
      if (r?.skillPaths?.length) skillPaths.push(...r.skillPaths.map((path) => ({ path, extensionPath })));
      if (r?.promptPaths?.length) promptPaths.push(...r.promptPaths.map((path) => ({ path, extensionPath })));
      if (r?.themePaths?.length) themePaths.push(...r.themePaths.map((path) => ({ path, extensionPath })));
      return { done: false };
    });
    return { skillPaths, promptPaths, themePaths };
  }
  /** Emit input event. Transforms chain, "handled" short-circuits. */
  async emitInput(text, images, source) {
    let currentText = text;
    let currentImages = images;
    let handled;
    await this.invokeHandlers("input", () => ({
      type: "input",
      text: currentText,
      images: currentImages,
      source
    }), (handlerResult) => {
      const r = handlerResult;
      if (r?.action === "handled") {
        handled = r;
        return { done: true };
      }
      if (r?.action === "transform") {
        currentText = r.text;
        currentImages = r.images ?? currentImages;
      }
      return { done: false };
    });
    if (handled) return handled;
    return currentText !== text || currentImages !== images ? { action: "transform", text: currentText, images: currentImages } : { action: "continue" };
  }
  // =========================================================================
  // Layer 2 event emitters (notification, stop, session_end, git, verify,
  // budget, milestone / unit). Fire-and-observe except where a handler result
  // can veto or rewrite the pending action.
  // =========================================================================
  async emitStop(event) {
    await this.invokeHandlers(
      "stop",
      () => ({ type: "stop", ...event }),
      () => ({ done: false })
    );
  }
  async emitNotification(event) {
    await this.invokeHandlers(
      "notification",
      () => ({ type: "notification", ...event }),
      () => ({ done: false })
    );
  }
  async emitSessionEnd(event) {
    await this.invokeHandlers(
      "session_end",
      () => ({ type: "session_end", ...event }),
      () => ({ done: false })
    );
  }
  async emitBeforeCommit(event) {
    let result;
    let message = event.message;
    await this.invokeHandlers(
      "before_commit",
      () => ({ type: "before_commit", ...event, message }),
      (handlerResult) => {
        const r = handlerResult;
        if (!r) return { done: false };
        if (r.cancel) {
          result = { cancel: true, reason: r.reason };
          return { done: true };
        }
        if (r.message !== void 0) {
          message = r.message;
          result = { ...result ?? {}, message };
        }
        return { done: false };
      }
    );
    return result;
  }
  async emitCommit(event) {
    await this.invokeHandlers(
      "commit",
      () => ({ type: "commit", ...event }),
      () => ({ done: false })
    );
  }
  async emitBeforePush(event) {
    let result;
    await this.invokeHandlers(
      "before_push",
      () => ({ type: "before_push", ...event }),
      (handlerResult) => {
        const r = handlerResult;
        if (r?.cancel) {
          result = r;
          return { done: true };
        }
        return { done: false };
      }
    );
    return result;
  }
  async emitPush(event) {
    await this.invokeHandlers(
      "push",
      () => ({ type: "push", ...event }),
      () => ({ done: false })
    );
  }
  async emitBeforePr(event) {
    let result;
    let title = event.title;
    let body = event.body;
    await this.invokeHandlers(
      "before_pr",
      () => ({ type: "before_pr", ...event, title, body }),
      (handlerResult) => {
        const r = handlerResult;
        if (!r) return { done: false };
        if (r.cancel) {
          result = { cancel: true, reason: r.reason };
          return { done: true };
        }
        if (r.title !== void 0) title = r.title;
        if (r.body !== void 0) body = r.body;
        if (r.title !== void 0 || r.body !== void 0) {
          result = { ...result ?? {}, title, body };
        }
        return { done: false };
      }
    );
    return result;
  }
  async emitPrOpened(event) {
    await this.invokeHandlers(
      "pr_opened",
      () => ({ type: "pr_opened", ...event }),
      () => ({ done: false })
    );
  }
  async emitBeforeVerify(event) {
    let result;
    await this.invokeHandlers(
      "before_verify",
      () => ({ type: "before_verify", ...event }),
      (handlerResult) => {
        const r = handlerResult;
        if (r?.cancel) {
          result = r;
          return { done: true };
        }
        return { done: false };
      }
    );
    return result;
  }
  async emitVerifyResult(event) {
    await this.invokeHandlers(
      "verify_result",
      () => ({ type: "verify_result", ...event }),
      () => ({ done: false })
    );
  }
  async emitBudgetThreshold(event) {
    let result;
    await this.invokeHandlers(
      "budget_threshold",
      () => ({ type: "budget_threshold", ...event }),
      (handlerResult) => {
        const r = handlerResult;
        if (r?.action) {
          result = r;
          return { done: true };
        }
        return { done: false };
      }
    );
    return result;
  }
  async emitMilestoneStart(event) {
    await this.invokeHandlers(
      "milestone_start",
      () => ({ type: "milestone_start", ...event }),
      () => ({ done: false })
    );
  }
  async emitMilestoneEnd(event) {
    await this.invokeHandlers(
      "milestone_end",
      () => ({ type: "milestone_end", ...event }),
      () => ({ done: false })
    );
  }
  async emitUnitStart(event) {
    await this.invokeHandlers(
      "unit_start",
      () => ({ type: "unit_start", ...event }),
      () => ({ done: false })
    );
  }
  async emitUnitEnd(event) {
    await this.invokeHandlers(
      "unit_end",
      () => ({ type: "unit_end", ...event }),
      () => ({ done: false })
    );
  }
}
export {
  ExtensionRunner
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2V4dGVuc2lvbnMvcnVubmVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEV4dGVuc2lvbiBydW5uZXIgLSBleGVjdXRlcyBleHRlbnNpb25zIGFuZCBtYW5hZ2VzIHRoZWlyIGxpZmVjeWNsZS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEFnZW50TWVzc2FnZSB9IGZyb20gXCJAZ3NkL3BpLWFnZW50LWNvcmVcIjtcbmltcG9ydCB0eXBlIHsgSW1hZ2VDb250ZW50LCBNb2RlbCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgdHlwZSB7IEtleUlkIH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgeyB0eXBlIFRoZW1lLCB0aGVtZSB9IGZyb20gXCIuLi8uLi9tb2Rlcy9pbnRlcmFjdGl2ZS90aGVtZS90aGVtZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBSZXNvdXJjZURpYWdub3N0aWMgfSBmcm9tIFwiLi4vZGlhZ25vc3RpY3MuanNcIjtcbmltcG9ydCB0eXBlIHsgS2V5QWN0aW9uLCBLZXliaW5kaW5nc0NvbmZpZyB9IGZyb20gXCIuLi9rZXliaW5kaW5ncy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBNb2RlbFJlZ2lzdHJ5IH0gZnJvbSBcIi4uL21vZGVsLXJlZ2lzdHJ5LmpzXCI7XG5pbXBvcnQgdHlwZSB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSBcIi4uL3Nlc3Npb24tbWFuYWdlci5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRBZGp1c3RUb29sU2V0RXZlbnQsXG5cdEFkanVzdFRvb2xTZXRSZXN1bHQsXG5cdEJlZm9yZUFnZW50U3RhcnRFdmVudCxcblx0QmVmb3JlQWdlbnRTdGFydEV2ZW50UmVzdWx0LFxuXHRCZWZvcmVDb21taXRFdmVudCxcblx0QmVmb3JlQ29tbWl0RXZlbnRSZXN1bHQsXG5cdEJlZm9yZU1vZGVsU2VsZWN0RXZlbnQsXG5cdEJlZm9yZU1vZGVsU2VsZWN0UmVzdWx0LFxuXHRCZWZvcmVQckV2ZW50LFxuXHRCZWZvcmVQckV2ZW50UmVzdWx0LFxuXHRCZWZvcmVQcm92aWRlclJlcXVlc3RFdmVudCxcblx0QmVmb3JlUHVzaEV2ZW50LFxuXHRCZWZvcmVQdXNoRXZlbnRSZXN1bHQsXG5cdEJlZm9yZVZlcmlmeUV2ZW50LFxuXHRCZWZvcmVWZXJpZnlFdmVudFJlc3VsdCxcblx0QnVkZ2V0VGhyZXNob2xkRXZlbnQsXG5cdEJ1ZGdldFRocmVzaG9sZEV2ZW50UmVzdWx0LFxuXHRDb21taXRFdmVudCxcblx0Q29tcGFjdE9wdGlvbnMsXG5cdENvbnRleHRFdmVudCxcblx0Q29udGV4dEV2ZW50UmVzdWx0LFxuXHRDb250ZXh0VXNhZ2UsXG5cdEV4dGVuc2lvbixcblx0RXh0ZW5zaW9uQWN0aW9ucyxcblx0RXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG5cdEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0QWN0aW9ucyxcblx0RXh0ZW5zaW9uQ29udGV4dCxcblx0RXh0ZW5zaW9uQ29udGV4dEFjdGlvbnMsXG5cdEV4dGVuc2lvbkVycm9yLFxuXHRFeHRlbnNpb25FdmVudCxcblx0RXh0ZW5zaW9uRmxhZyxcblx0RXh0ZW5zaW9uUnVudGltZSxcblx0RXh0ZW5zaW9uU2hvcnRjdXQsXG5cdEV4dGVuc2lvblVJQ29udGV4dCxcblx0SW5wdXRFdmVudCxcblx0SW5wdXRFdmVudFJlc3VsdCxcblx0SW5wdXRTb3VyY2UsXG5cdE1lc3NhZ2VSZW5kZXJlcixcblx0TWlsZXN0b25lRW5kRXZlbnQsXG5cdE1pbGVzdG9uZVN0YXJ0RXZlbnQsXG5cdE5vdGlmaWNhdGlvbkV2ZW50LFxuXHRQck9wZW5lZEV2ZW50LFxuXHRQdXNoRXZlbnQsXG5cdFJlZ2lzdGVyZWRDb21tYW5kLFxuXHRSZWdpc3RlcmVkVG9vbCxcblx0UmVzb3VyY2VzRGlzY292ZXJFdmVudCxcblx0UmVzb3VyY2VzRGlzY292ZXJSZXN1bHQsXG5cdFNlc3Npb25CZWZvcmVDb21wYWN0UmVzdWx0LFxuXHRTZXNzaW9uQmVmb3JlRm9ya1Jlc3VsdCxcblx0U2Vzc2lvbkJlZm9yZVN3aXRjaFJlc3VsdCxcblx0U2Vzc2lvbkJlZm9yZVRyZWVSZXN1bHQsXG5cdFNlc3Npb25FbmRFdmVudCxcblx0U3RvcEV2ZW50LFxuXHRUb29sQ2FsbEV2ZW50LFxuXHRUb29sQ2FsbEV2ZW50UmVzdWx0LFxuXHRUb29sUmVzdWx0RXZlbnQsXG5cdFRvb2xSZXN1bHRFdmVudFJlc3VsdCxcblx0VW5pdEVuZEV2ZW50LFxuXHRVbml0U3RhcnRFdmVudCxcblx0VXNlckJhc2hFdmVudCxcblx0VXNlckJhc2hFdmVudFJlc3VsdCxcblx0VmVyaWZ5RmFpbHVyZSxcblx0VmVyaWZ5UmVzdWx0RXZlbnQsXG59IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5cbi8vIEtleWJpbmRpbmdzIGZvciB0aGVzZSBhY3Rpb25zIGNhbm5vdCBiZSBvdmVycmlkZGVuIGJ5IGV4dGVuc2lvbnNcbmNvbnN0IFJFU0VSVkVEX0FDVElPTlNfRk9SX0VYVEVOU0lPTl9DT05GTElDVFM6IFJlYWRvbmx5QXJyYXk8S2V5QWN0aW9uPiA9IFtcblx0XCJpbnRlcnJ1cHRcIixcblx0XCJjbGVhclwiLFxuXHRcImV4aXRcIixcblx0XCJzdXNwZW5kXCIsXG5cdFwiY3ljbGVUaGlua2luZ0xldmVsXCIsXG5cdFwiY3ljbGVNb2RlbEZvcndhcmRcIixcblx0XCJjeWNsZU1vZGVsQmFja3dhcmRcIixcblx0XCJzZWxlY3RNb2RlbFwiLFxuXHRcImV4cGFuZFRvb2xzXCIsXG5cdFwidG9nZ2xlVGhpbmtpbmdcIixcblx0XCJleHRlcm5hbEVkaXRvclwiLFxuXHRcImZvbGxvd1VwXCIsXG5cdFwic3VibWl0XCIsXG5cdFwic2VsZWN0Q29uZmlybVwiLFxuXHRcInNlbGVjdENhbmNlbFwiLFxuXHRcImNvcHlcIixcblx0XCJkZWxldGVUb0xpbmVFbmRcIixcbl07XG5cbnR5cGUgQnVpbHRJbktleUJpbmRpbmdzID0gUGFydGlhbDxSZWNvcmQ8S2V5SWQsIHsgYWN0aW9uOiBLZXlBY3Rpb247IHJlc3RyaWN0T3ZlcnJpZGU6IGJvb2xlYW4gfT4+O1xuXG5jb25zdCBidWlsZEJ1aWx0aW5LZXliaW5kaW5ncyA9IChlZmZlY3RpdmVLZXliaW5kaW5nczogUmVxdWlyZWQ8S2V5YmluZGluZ3NDb25maWc+KTogQnVpbHRJbktleUJpbmRpbmdzID0+IHtcblx0Y29uc3QgYnVpbHRpbktleWJpbmRpbmdzID0ge30gYXMgQnVpbHRJbktleUJpbmRpbmdzO1xuXHRmb3IgKGNvbnN0IFthY3Rpb24sIGtleXNdIG9mIE9iamVjdC5lbnRyaWVzKGVmZmVjdGl2ZUtleWJpbmRpbmdzKSkge1xuXHRcdGNvbnN0IGtleUFjdGlvbiA9IGFjdGlvbiBhcyBLZXlBY3Rpb247XG5cdFx0Y29uc3Qga2V5TGlzdCA9IEFycmF5LmlzQXJyYXkoa2V5cykgPyBrZXlzIDogW2tleXNdO1xuXHRcdGNvbnN0IHJlc3RyaWN0T3ZlcnJpZGUgPSBSRVNFUlZFRF9BQ1RJT05TX0ZPUl9FWFRFTlNJT05fQ09ORkxJQ1RTLmluY2x1ZGVzKGtleUFjdGlvbik7XG5cdFx0Zm9yIChjb25zdCBrZXkgb2Yga2V5TGlzdCkge1xuXHRcdFx0Y29uc3Qgbm9ybWFsaXplZEtleSA9IGtleS50b0xvd2VyQ2FzZSgpIGFzIEtleUlkO1xuXHRcdFx0YnVpbHRpbktleWJpbmRpbmdzW25vcm1hbGl6ZWRLZXldID0ge1xuXHRcdFx0XHRhY3Rpb246IGtleUFjdGlvbixcblx0XHRcdFx0cmVzdHJpY3RPdmVycmlkZTogcmVzdHJpY3RPdmVycmlkZSxcblx0XHRcdH07XG5cdFx0fVxuXHR9XG5cdHJldHVybiBidWlsdGluS2V5YmluZGluZ3M7XG59O1xuXG5jb25zdCBQUk9URUNURURfRVhURU5TSU9OX0NPTU1BTkRTID0gbmV3IFNldChbXCJnc2RcIl0pO1xuXG5mdW5jdGlvbiBpc1Byb3RlY3RlZENvbW1hbmRPd25lcihjb21tYW5kTmFtZTogc3RyaW5nLCBleHRlbnNpb25QYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcblx0aWYgKCFQUk9URUNURURfRVhURU5TSU9OX0NPTU1BTkRTLmhhcyhjb21tYW5kTmFtZSkpIHJldHVybiBmYWxzZTtcblx0Y29uc3Qgbm9ybWFsaXplZCA9IGV4dGVuc2lvblBhdGgucmVwbGFjZSgvXFxcXC9nLCBcIi9cIik7XG5cdHJldHVybiAvXFwvZXh0ZW5zaW9uc1xcL2dzZFxcLyg/OmluZGV4XFwuW2NtXT9banRdc3xkaXN0XFwvLiopJC8udGVzdChub3JtYWxpemVkKVxuXHRcdHx8IC9cXC9leHRlbnNpb25zXFwvZ3NkXFwvPyQvLnRlc3Qobm9ybWFsaXplZCk7XG59XG5cbi8qKiBDb21iaW5lZCByZXN1bHQgZnJvbSBhbGwgYmVmb3JlX2FnZW50X3N0YXJ0IGhhbmRsZXJzICovXG5pbnRlcmZhY2UgQmVmb3JlQWdlbnRTdGFydENvbWJpbmVkUmVzdWx0IHtcblx0bWVzc2FnZXM/OiBOb25OdWxsYWJsZTxCZWZvcmVBZ2VudFN0YXJ0RXZlbnRSZXN1bHRbXCJtZXNzYWdlXCJdPltdO1xuXHRzeXN0ZW1Qcm9tcHQ/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogRXZlbnRzIGhhbmRsZWQgYnkgdGhlIGdlbmVyaWMgZW1pdCgpIG1ldGhvZC5cbiAqIEV2ZW50cyB3aXRoIGRlZGljYXRlZCBlbWl0WHh4KCkgbWV0aG9kcyBhcmUgZXhjbHVkZWQgZm9yIHN0cm9uZ2VyIHR5cGUgc2FmZXR5LlxuICovXG50eXBlIFJ1bm5lckVtaXRFdmVudCA9IEV4Y2x1ZGU8XG5cdEV4dGVuc2lvbkV2ZW50LFxuXHR8IFRvb2xDYWxsRXZlbnRcblx0fCBUb29sUmVzdWx0RXZlbnRcblx0fCBVc2VyQmFzaEV2ZW50XG5cdHwgQ29udGV4dEV2ZW50XG5cdHwgQmVmb3JlUHJvdmlkZXJSZXF1ZXN0RXZlbnRcblx0fCBCZWZvcmVBZ2VudFN0YXJ0RXZlbnRcblx0fCBSZXNvdXJjZXNEaXNjb3ZlckV2ZW50XG5cdHwgSW5wdXRFdmVudFxuPjtcblxudHlwZSBTZXNzaW9uQmVmb3JlRXZlbnQgPSBFeHRyYWN0PFxuXHRSdW5uZXJFbWl0RXZlbnQsXG5cdHsgdHlwZTogXCJzZXNzaW9uX2JlZm9yZV9zd2l0Y2hcIiB8IFwic2Vzc2lvbl9iZWZvcmVfZm9ya1wiIHwgXCJzZXNzaW9uX2JlZm9yZV9jb21wYWN0XCIgfCBcInNlc3Npb25fYmVmb3JlX3RyZWVcIiB9XG4+O1xuXG50eXBlIFNlc3Npb25CZWZvcmVFdmVudFJlc3VsdCA9XG5cdHwgU2Vzc2lvbkJlZm9yZVN3aXRjaFJlc3VsdFxuXHR8IFNlc3Npb25CZWZvcmVGb3JrUmVzdWx0XG5cdHwgU2Vzc2lvbkJlZm9yZUNvbXBhY3RSZXN1bHRcblx0fCBTZXNzaW9uQmVmb3JlVHJlZVJlc3VsdDtcblxudHlwZSBSdW5uZXJFbWl0UmVzdWx0PFRFdmVudCBleHRlbmRzIFJ1bm5lckVtaXRFdmVudD4gPSBURXZlbnQgZXh0ZW5kcyB7IHR5cGU6IFwic2Vzc2lvbl9iZWZvcmVfc3dpdGNoXCIgfVxuXHQ/IFNlc3Npb25CZWZvcmVTd2l0Y2hSZXN1bHQgfCB1bmRlZmluZWRcblx0OiBURXZlbnQgZXh0ZW5kcyB7IHR5cGU6IFwic2Vzc2lvbl9iZWZvcmVfZm9ya1wiIH1cblx0XHQ/IFNlc3Npb25CZWZvcmVGb3JrUmVzdWx0IHwgdW5kZWZpbmVkXG5cdFx0OiBURXZlbnQgZXh0ZW5kcyB7IHR5cGU6IFwic2Vzc2lvbl9iZWZvcmVfY29tcGFjdFwiIH1cblx0XHRcdD8gU2Vzc2lvbkJlZm9yZUNvbXBhY3RSZXN1bHQgfCB1bmRlZmluZWRcblx0XHRcdDogVEV2ZW50IGV4dGVuZHMgeyB0eXBlOiBcInNlc3Npb25fYmVmb3JlX3RyZWVcIiB9XG5cdFx0XHRcdD8gU2Vzc2lvbkJlZm9yZVRyZWVSZXN1bHQgfCB1bmRlZmluZWRcblx0XHRcdFx0OiB1bmRlZmluZWQ7XG5cbmV4cG9ydCB0eXBlIEV4dGVuc2lvbkVycm9yTGlzdGVuZXIgPSAoZXJyb3I6IEV4dGVuc2lvbkVycm9yKSA9PiB2b2lkO1xuXG5leHBvcnQgdHlwZSBOZXdTZXNzaW9uSGFuZGxlciA9IChvcHRpb25zPzoge1xuXHRwYXJlbnRTZXNzaW9uPzogc3RyaW5nO1xuXHRzZXR1cD86IChzZXNzaW9uTWFuYWdlcjogU2Vzc2lvbk1hbmFnZXIpID0+IFByb21pc2U8dm9pZD47XG5cdC8qKiBFeHBsaWNpdCB3b3Jrc3BhY2Ugcm9vdCBmb3IgdGhlIG5ldyBzZXNzaW9uL3Rvb2wgcnVudGltZS4gKi9cblx0d29ya3NwYWNlUm9vdD86IHN0cmluZztcblx0LyoqIFNlZSBFeHRlbnNpb25Db21tYW5kQ29udGV4dC5uZXdTZXNzaW9uIGZvciBkb2NzICgjMzczMSkuICovXG5cdGFib3J0U2lnbmFsPzogQWJvcnRTaWduYWw7XG59KSA9PiBQcm9taXNlPHsgY2FuY2VsbGVkOiBib29sZWFuIH0+O1xuXG5leHBvcnQgdHlwZSBGb3JrSGFuZGxlciA9IChlbnRyeUlkOiBzdHJpbmcpID0+IFByb21pc2U8eyBjYW5jZWxsZWQ6IGJvb2xlYW4gfT47XG5cbmV4cG9ydCB0eXBlIE5hdmlnYXRlVHJlZUhhbmRsZXIgPSAoXG5cdHRhcmdldElkOiBzdHJpbmcsXG5cdG9wdGlvbnM/OiB7IHN1bW1hcml6ZT86IGJvb2xlYW47IGN1c3RvbUluc3RydWN0aW9ucz86IHN0cmluZzsgcmVwbGFjZUluc3RydWN0aW9ucz86IGJvb2xlYW47IGxhYmVsPzogc3RyaW5nIH0sXG4pID0+IFByb21pc2U8eyBjYW5jZWxsZWQ6IGJvb2xlYW4gfT47XG5cbmV4cG9ydCB0eXBlIFN3aXRjaFNlc3Npb25IYW5kbGVyID0gKHNlc3Npb25QYXRoOiBzdHJpbmcpID0+IFByb21pc2U8eyBjYW5jZWxsZWQ6IGJvb2xlYW4gfT47XG5cbmV4cG9ydCB0eXBlIFJlbG9hZEhhbmRsZXIgPSAoKSA9PiBQcm9taXNlPHZvaWQ+O1xuXG5leHBvcnQgdHlwZSBTaHV0ZG93bkhhbmRsZXIgPSAoKSA9PiB2b2lkO1xuXG5cbmNvbnN0IG5vT3BVSUNvbnRleHQ6IEV4dGVuc2lvblVJQ29udGV4dCA9IHtcblx0c2VsZWN0OiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG5cdGNvbmZpcm06IGFzeW5jICgpID0+IGZhbHNlLFxuXHRpbnB1dDogYXN5bmMgKCkgPT4gdW5kZWZpbmVkLFxuXHRub3RpZnk6ICgpID0+IHt9LFxuXHRvblRlcm1pbmFsSW5wdXQ6ICgpID0+ICgpID0+IHt9LFxuXHRzZXRTdGF0dXM6ICgpID0+IHt9LFxuXHRzZXRXb3JraW5nTWVzc2FnZTogKCkgPT4ge30sXG5cdHNldFdpZGdldDogKCkgPT4ge30sXG5cdHNldEZvb3RlcjogKCkgPT4ge30sXG5cdHNldEhlYWRlcjogKCkgPT4ge30sXG5cdHNldFRpdGxlOiAoKSA9PiB7fSxcblx0Y3VzdG9tOiBhc3luYyAoKSA9PiB1bmRlZmluZWQgYXMgbmV2ZXIsXG5cdHBhc3RlVG9FZGl0b3I6ICgpID0+IHt9LFxuXHRzZXRFZGl0b3JUZXh0OiAoKSA9PiB7fSxcblx0Z2V0RWRpdG9yVGV4dDogKCkgPT4gXCJcIixcblx0ZWRpdG9yOiBhc3luYyAoKSA9PiB1bmRlZmluZWQsXG5cdHNldEVkaXRvckNvbXBvbmVudDogKCkgPT4ge30sXG5cdGdldCB0aGVtZSgpIHtcblx0XHRyZXR1cm4gdGhlbWU7XG5cdH0sXG5cdGdldEFsbFRoZW1lczogKCkgPT4gW10sXG5cdGdldFRoZW1lOiAoKSA9PiB1bmRlZmluZWQsXG5cdHNldFRoZW1lOiAoX3RoZW1lOiBzdHJpbmcgfCBUaGVtZSkgPT4gKHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBcIlVJIG5vdCBhdmFpbGFibGVcIiB9KSxcblx0Z2V0VG9vbHNFeHBhbmRlZDogKCkgPT4gZmFsc2UsXG5cdHNldFRvb2xzRXhwYW5kZWQ6ICgpID0+IHt9LFxufTtcblxuZXhwb3J0IGNsYXNzIEV4dGVuc2lvblJ1bm5lciB7XG5cdHByaXZhdGUgZXh0ZW5zaW9uczogRXh0ZW5zaW9uW107XG5cdHByaXZhdGUgcnVudGltZTogRXh0ZW5zaW9uUnVudGltZTtcblx0cHJpdmF0ZSB1aUNvbnRleHQ6IEV4dGVuc2lvblVJQ29udGV4dDtcblx0cHJpdmF0ZSBjd2Q6IHN0cmluZztcblx0cHJpdmF0ZSBzZXNzaW9uTWFuYWdlcjogU2Vzc2lvbk1hbmFnZXI7XG5cdHByaXZhdGUgbW9kZWxSZWdpc3RyeTogTW9kZWxSZWdpc3RyeTtcblx0cHJpdmF0ZSBlcnJvckxpc3RlbmVyczogU2V0PEV4dGVuc2lvbkVycm9yTGlzdGVuZXI+ID0gbmV3IFNldCgpO1xuXHRwcml2YXRlIGdldE1vZGVsOiAoKSA9PiBNb2RlbDxhbnk+IHwgdW5kZWZpbmVkID0gKCkgPT4gdW5kZWZpbmVkO1xuXHRwcml2YXRlIGlzSWRsZUZuOiAoKSA9PiBib29sZWFuID0gKCkgPT4gdHJ1ZTtcblx0cHJpdmF0ZSB3YWl0Rm9ySWRsZUZuOiAoKSA9PiBQcm9taXNlPHZvaWQ+ID0gYXN5bmMgKCkgPT4ge307XG5cdHByaXZhdGUgYWJvcnRGbjogKCkgPT4gdm9pZCA9ICgpID0+IHt9O1xuXHRwcml2YXRlIGhhc1BlbmRpbmdNZXNzYWdlc0ZuOiAoKSA9PiBib29sZWFuID0gKCkgPT4gZmFsc2U7XG5cdHByaXZhdGUgZ2V0Q29udGV4dFVzYWdlRm46ICgpID0+IENvbnRleHRVc2FnZSB8IHVuZGVmaW5lZCA9ICgpID0+IHVuZGVmaW5lZDtcblx0cHJpdmF0ZSBjb21wYWN0Rm46IChvcHRpb25zPzogQ29tcGFjdE9wdGlvbnMpID0+IHZvaWQgPSAoKSA9PiB7fTtcblx0cHJpdmF0ZSBnZXRTeXN0ZW1Qcm9tcHRGbjogKCkgPT4gc3RyaW5nID0gKCkgPT4gXCJcIjtcblx0cHJpdmF0ZSBzZXRDb21wYWN0aW9uVGhyZXNob2xkT3ZlcnJpZGVGbjogKHBlcmNlbnQ6IG51bWJlciB8IHVuZGVmaW5lZCkgPT4gdm9pZCA9ICgpID0+IHt9O1xuXHRwcml2YXRlIG5ld1Nlc3Npb25IYW5kbGVyOiBOZXdTZXNzaW9uSGFuZGxlciA9IGFzeW5jICgpID0+IHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJDb21tYW5kIGNvbnRleHQgbm90IHlldCBib3VuZDogbmV3U2Vzc2lvbiBpcyB1bmF2YWlsYWJsZSBkdXJpbmcgZWFybHkgbGlmZWN5Y2xlXCIpO1xuXHR9O1xuXHRwcml2YXRlIGZvcmtIYW5kbGVyOiBGb3JrSGFuZGxlciA9IGFzeW5jICgpID0+IHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJDb21tYW5kIGNvbnRleHQgbm90IHlldCBib3VuZDogZm9yayBpcyB1bmF2YWlsYWJsZSBkdXJpbmcgZWFybHkgbGlmZWN5Y2xlXCIpO1xuXHR9O1xuXHRwcml2YXRlIG5hdmlnYXRlVHJlZUhhbmRsZXI6IE5hdmlnYXRlVHJlZUhhbmRsZXIgPSBhc3luYyAoKSA9PiB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiQ29tbWFuZCBjb250ZXh0IG5vdCB5ZXQgYm91bmQ6IG5hdmlnYXRlVHJlZSBpcyB1bmF2YWlsYWJsZSBkdXJpbmcgZWFybHkgbGlmZWN5Y2xlXCIpO1xuXHR9O1xuXHRwcml2YXRlIHN3aXRjaFNlc3Npb25IYW5kbGVyOiBTd2l0Y2hTZXNzaW9uSGFuZGxlciA9IGFzeW5jICgpID0+IHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoXCJDb21tYW5kIGNvbnRleHQgbm90IHlldCBib3VuZDogc3dpdGNoU2Vzc2lvbiBpcyB1bmF2YWlsYWJsZSBkdXJpbmcgZWFybHkgbGlmZWN5Y2xlXCIpO1xuXHR9O1xuXHRwcml2YXRlIHJlbG9hZEhhbmRsZXI6IFJlbG9hZEhhbmRsZXIgPSBhc3luYyAoKSA9PiB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKFwiQ29tbWFuZCBjb250ZXh0IG5vdCB5ZXQgYm91bmQ6IHJlbG9hZCBpcyB1bmF2YWlsYWJsZSBkdXJpbmcgZWFybHkgbGlmZWN5Y2xlXCIpO1xuXHR9O1xuXHRwcml2YXRlIHNodXRkb3duSGFuZGxlcjogU2h1dGRvd25IYW5kbGVyID0gKCkgPT4ge307XG5cdHByaXZhdGUgc2hvcnRjdXREaWFnbm9zdGljczogUmVzb3VyY2VEaWFnbm9zdGljW10gPSBbXTtcblx0cHJpdmF0ZSBjb21tYW5kRGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdID0gW107XG5cblx0Y29uc3RydWN0b3IoXG5cdFx0ZXh0ZW5zaW9uczogRXh0ZW5zaW9uW10sXG5cdFx0cnVudGltZTogRXh0ZW5zaW9uUnVudGltZSxcblx0XHRjd2Q6IHN0cmluZyxcblx0XHRzZXNzaW9uTWFuYWdlcjogU2Vzc2lvbk1hbmFnZXIsXG5cdFx0bW9kZWxSZWdpc3RyeTogTW9kZWxSZWdpc3RyeSxcblx0KSB7XG5cdFx0dGhpcy5leHRlbnNpb25zID0gZXh0ZW5zaW9ucztcblx0XHR0aGlzLnJ1bnRpbWUgPSBydW50aW1lO1xuXHRcdHRoaXMudWlDb250ZXh0ID0gbm9PcFVJQ29udGV4dDtcblx0XHR0aGlzLmN3ZCA9IGN3ZDtcblx0XHR0aGlzLnNlc3Npb25NYW5hZ2VyID0gc2Vzc2lvbk1hbmFnZXI7XG5cdFx0dGhpcy5tb2RlbFJlZ2lzdHJ5ID0gbW9kZWxSZWdpc3RyeTtcblx0XHQvLyBCaW5kIGVtaXQgbWV0aG9kcyBpbnRvIHRoZSBzaGFyZWQgcnVudGltZSBzbyBjcmVhdGVFeHRlbnNpb25BUEkgY2FuIGRlbGVnYXRlIHRvIHRoZW0uXG5cdFx0dGhpcy5ydW50aW1lLmVtaXRCZWZvcmVNb2RlbFNlbGVjdCA9IChldmVudCkgPT4gdGhpcy5lbWl0QmVmb3JlTW9kZWxTZWxlY3QoZXZlbnQpO1xuXHRcdHRoaXMucnVudGltZS5lbWl0QWRqdXN0VG9vbFNldCA9IChldmVudCkgPT4gdGhpcy5lbWl0QWRqdXN0VG9vbFNldChldmVudCk7XG5cdFx0dGhpcy5ydW50aW1lLmVtaXRFeHRlbnNpb25FdmVudCA9IChldmVudCkgPT4gdGhpcy5lbWl0RXh0ZW5zaW9uRXZlbnREeW5hbWljKGV2ZW50KTtcblx0fVxuXG5cdHByaXZhdGUgY3VycmVudEN3ZCgpOiBzdHJpbmcge1xuXHRcdHJldHVybiB0aGlzLmN3ZDtcblx0fVxuXG5cdC8qKlxuXHQgKiBEaXNwYXRjaCBhbiBFeHRlbnNpb25FdmVudCBieSB0eXBlLiBVc2VkIGJ5IGV4dGVuc2lvbnMgdG8gZW1pdCB0aGVcblx0ICogcG9zdC1wbGFuIExheWVyIDIgZXZlbnRzIChnaXQgbGlmZWN5Y2xlLCB2ZXJpZnksIGJ1ZGdldCwgbWlsZXN0b25lLFxuXHQgKiB1bml0LCBub3RpZmljYXRpb24sIHN0b3AsIHNlc3Npb25fZW5kKSB3aXRob3V0IGEgYmVzcG9rZSBtZXRob2QgcGVyXG5cdCAqIHR5cGUuIFJldHVybnMgdGhlIGhhbmRsZXIgY2hhaW4ncyBhZ2dyZWdhdGUgcmVzdWx0IHdoZXJlIG1lYW5pbmdmdWwuXG5cdCAqL1xuXHRwcml2YXRlIGFzeW5jIGVtaXRFeHRlbnNpb25FdmVudER5bmFtaWMoZXZlbnQ6IEV4dGVuc2lvbkV2ZW50KTogUHJvbWlzZTx1bmtub3duPiB7XG5cdFx0c3dpdGNoIChldmVudC50eXBlKSB7XG5cdFx0XHRjYXNlIFwibm90aWZpY2F0aW9uXCI6XG5cdFx0XHRcdHJldHVybiB0aGlzLmVtaXROb3RpZmljYXRpb24oeyBraW5kOiBldmVudC5raW5kLCBtZXNzYWdlOiBldmVudC5tZXNzYWdlLCBkZXRhaWxzOiBldmVudC5kZXRhaWxzIH0pO1xuXHRcdFx0Y2FzZSBcInN0b3BcIjpcblx0XHRcdFx0cmV0dXJuIHRoaXMuZW1pdFN0b3AoeyByZWFzb246IGV2ZW50LnJlYXNvbiwgbGFzdE1lc3NhZ2U6IGV2ZW50Lmxhc3RNZXNzYWdlIH0pO1xuXHRcdFx0Y2FzZSBcInNlc3Npb25fZW5kXCI6XG5cdFx0XHRcdHJldHVybiB0aGlzLmVtaXRTZXNzaW9uRW5kKHsgcmVhc29uOiBldmVudC5yZWFzb24sIHNlc3Npb25GaWxlOiBldmVudC5zZXNzaW9uRmlsZSB9KTtcblx0XHRcdGNhc2UgXCJiZWZvcmVfY29tbWl0XCI6XG5cdFx0XHRcdHJldHVybiB0aGlzLmVtaXRCZWZvcmVDb21taXQoe1xuXHRcdFx0XHRcdG1lc3NhZ2U6IGV2ZW50Lm1lc3NhZ2UsXG5cdFx0XHRcdFx0ZmlsZXM6IGV2ZW50LmZpbGVzLFxuXHRcdFx0XHRcdGN3ZDogZXZlbnQuY3dkLFxuXHRcdFx0XHRcdGF1dGhvcjogZXZlbnQuYXV0aG9yLFxuXHRcdFx0XHR9KTtcblx0XHRcdGNhc2UgXCJjb21taXRcIjpcblx0XHRcdFx0cmV0dXJuIHRoaXMuZW1pdENvbW1pdCh7IHNoYTogZXZlbnQuc2hhLCBtZXNzYWdlOiBldmVudC5tZXNzYWdlLCBmaWxlczogZXZlbnQuZmlsZXMsIGN3ZDogZXZlbnQuY3dkIH0pO1xuXHRcdFx0Y2FzZSBcImJlZm9yZV9wdXNoXCI6XG5cdFx0XHRcdHJldHVybiB0aGlzLmVtaXRCZWZvcmVQdXNoKHsgcmVtb3RlOiBldmVudC5yZW1vdGUsIGJyYW5jaDogZXZlbnQuYnJhbmNoLCBjd2Q6IGV2ZW50LmN3ZCB9KTtcblx0XHRcdGNhc2UgXCJwdXNoXCI6XG5cdFx0XHRcdHJldHVybiB0aGlzLmVtaXRQdXNoKHsgcmVtb3RlOiBldmVudC5yZW1vdGUsIGJyYW5jaDogZXZlbnQuYnJhbmNoLCBjd2Q6IGV2ZW50LmN3ZCB9KTtcblx0XHRcdGNhc2UgXCJiZWZvcmVfcHJcIjpcblx0XHRcdFx0cmV0dXJuIHRoaXMuZW1pdEJlZm9yZVByKHtcblx0XHRcdFx0XHRicmFuY2g6IGV2ZW50LmJyYW5jaCxcblx0XHRcdFx0XHR0YXJnZXRCcmFuY2g6IGV2ZW50LnRhcmdldEJyYW5jaCxcblx0XHRcdFx0XHR0aXRsZTogZXZlbnQudGl0bGUsXG5cdFx0XHRcdFx0Ym9keTogZXZlbnQuYm9keSxcblx0XHRcdFx0XHRjd2Q6IGV2ZW50LmN3ZCxcblx0XHRcdFx0fSk7XG5cdFx0XHRjYXNlIFwicHJfb3BlbmVkXCI6XG5cdFx0XHRcdHJldHVybiB0aGlzLmVtaXRQck9wZW5lZCh7XG5cdFx0XHRcdFx0dXJsOiBldmVudC51cmwsXG5cdFx0XHRcdFx0YnJhbmNoOiBldmVudC5icmFuY2gsXG5cdFx0XHRcdFx0dGFyZ2V0QnJhbmNoOiBldmVudC50YXJnZXRCcmFuY2gsXG5cdFx0XHRcdFx0Y3dkOiBldmVudC5jd2QsXG5cdFx0XHRcdH0pO1xuXHRcdFx0Y2FzZSBcImJlZm9yZV92ZXJpZnlcIjpcblx0XHRcdFx0cmV0dXJuIHRoaXMuZW1pdEJlZm9yZVZlcmlmeSh7IHVuaXRUeXBlOiBldmVudC51bml0VHlwZSwgdW5pdElkOiBldmVudC51bml0SWQsIGN3ZDogZXZlbnQuY3dkIH0pO1xuXHRcdFx0Y2FzZSBcInZlcmlmeV9yZXN1bHRcIjpcblx0XHRcdFx0cmV0dXJuIHRoaXMuZW1pdFZlcmlmeVJlc3VsdCh7XG5cdFx0XHRcdFx0cGFzc2VkOiBldmVudC5wYXNzZWQsXG5cdFx0XHRcdFx0ZmFpbHVyZXM6IGV2ZW50LmZhaWx1cmVzLFxuXHRcdFx0XHRcdHVuaXRUeXBlOiBldmVudC51bml0VHlwZSxcblx0XHRcdFx0XHR1bml0SWQ6IGV2ZW50LnVuaXRJZCxcblx0XHRcdFx0XHRjd2Q6IGV2ZW50LmN3ZCxcblx0XHRcdFx0fSk7XG5cdFx0XHRjYXNlIFwiYnVkZ2V0X3RocmVzaG9sZFwiOlxuXHRcdFx0XHRyZXR1cm4gdGhpcy5lbWl0QnVkZ2V0VGhyZXNob2xkKHtcblx0XHRcdFx0XHRmcmFjdGlvbjogZXZlbnQuZnJhY3Rpb24sXG5cdFx0XHRcdFx0c3BlbnQ6IGV2ZW50LnNwZW50LFxuXHRcdFx0XHRcdGxpbWl0OiBldmVudC5saW1pdCxcblx0XHRcdFx0XHRjdXJyZW5jeTogZXZlbnQuY3VycmVuY3ksXG5cdFx0XHRcdH0pO1xuXHRcdFx0Y2FzZSBcIm1pbGVzdG9uZV9zdGFydFwiOlxuXHRcdFx0XHRyZXR1cm4gdGhpcy5lbWl0TWlsZXN0b25lU3RhcnQoeyBtaWxlc3RvbmVJZDogZXZlbnQubWlsZXN0b25lSWQsIHRpdGxlOiBldmVudC50aXRsZSwgY3dkOiBldmVudC5jd2QgfSk7XG5cdFx0XHRjYXNlIFwibWlsZXN0b25lX2VuZFwiOlxuXHRcdFx0XHRyZXR1cm4gdGhpcy5lbWl0TWlsZXN0b25lRW5kKHtcblx0XHRcdFx0XHRtaWxlc3RvbmVJZDogZXZlbnQubWlsZXN0b25lSWQsXG5cdFx0XHRcdFx0c3RhdHVzOiBldmVudC5zdGF0dXMsXG5cdFx0XHRcdFx0Y3dkOiBldmVudC5jd2QsXG5cdFx0XHRcdH0pO1xuXHRcdFx0Y2FzZSBcInVuaXRfc3RhcnRcIjpcblx0XHRcdFx0cmV0dXJuIHRoaXMuZW1pdFVuaXRTdGFydCh7XG5cdFx0XHRcdFx0dW5pdFR5cGU6IGV2ZW50LnVuaXRUeXBlLFxuXHRcdFx0XHRcdHVuaXRJZDogZXZlbnQudW5pdElkLFxuXHRcdFx0XHRcdG1pbGVzdG9uZUlkOiBldmVudC5taWxlc3RvbmVJZCxcblx0XHRcdFx0XHRjd2Q6IGV2ZW50LmN3ZCxcblx0XHRcdFx0fSk7XG5cdFx0XHRjYXNlIFwidW5pdF9lbmRcIjpcblx0XHRcdFx0cmV0dXJuIHRoaXMuZW1pdFVuaXRFbmQoe1xuXHRcdFx0XHRcdHVuaXRUeXBlOiBldmVudC51bml0VHlwZSxcblx0XHRcdFx0XHR1bml0SWQ6IGV2ZW50LnVuaXRJZCxcblx0XHRcdFx0XHRtaWxlc3RvbmVJZDogZXZlbnQubWlsZXN0b25lSWQsXG5cdFx0XHRcdFx0c3RhdHVzOiBldmVudC5zdGF0dXMsXG5cdFx0XHRcdFx0Y3dkOiBldmVudC5jd2QsXG5cdFx0XHRcdH0pO1xuXHRcdFx0ZGVmYXVsdDpcblx0XHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogSW5zdGFsbCBhIHN5bnRoZXRpYyBcImV4dGVuc2lvblwiIHRoYXQgb25seSBwcm92aWRlcyBldmVudCBoYW5kbGVycy5cblx0ICogVXNlZCBieSB0aGUgTGF5ZXIgMCBob29rcy1ydW5uZXIgdG8gYnJpZGdlIHNoZWxsIGhvb2tzIG9udG8gdGhlXG5cdCAqIGV4dGVuc2lvbiBldmVudCBidXMgd2l0aG91dCByZXF1aXJpbmcgYSBmdWxsIGV4dGVuc2lvbiBtb2R1bGUuIFRoZVxuXHQgKiByZXR1cm5lZCBkaXNwb3NlciByZW1vdmVzIHRoZSBzeW50aGV0aWMgZXh0ZW5zaW9uLlxuXHQgKi9cblx0aW5zdGFsbEhvb2tCcmlkZ2UoXG5cdFx0cGF0aDogc3RyaW5nLFxuXHRcdGhhbmRsZXJzOiBNYXA8c3RyaW5nLCBBcnJheTwoZXZlbnQ6IHVua25vd24sIGN0eDogdW5rbm93bikgPT4gUHJvbWlzZTx1bmtub3duPj4+LFxuXHQpOiAoKSA9PiB2b2lkIHtcblx0XHRjb25zdCBzeW50aGV0aWM6IEV4dGVuc2lvbiA9IHtcblx0XHRcdHBhdGgsXG5cdFx0XHRyZXNvbHZlZFBhdGg6IHBhdGgsXG5cdFx0XHRoYW5kbGVyczogaGFuZGxlcnMgYXMgdW5rbm93biBhcyBFeHRlbnNpb25bXCJoYW5kbGVyc1wiXSxcblx0XHRcdHRvb2xzOiBuZXcgTWFwKCksXG5cdFx0XHRtZXNzYWdlUmVuZGVyZXJzOiBuZXcgTWFwKCksXG5cdFx0XHRjb21tYW5kczogbmV3IE1hcCgpLFxuXHRcdFx0ZmxhZ3M6IG5ldyBNYXAoKSxcblx0XHRcdHNob3J0Y3V0czogbmV3IE1hcCgpLFxuXHRcdFx0bGlmZWN5Y2xlSG9va3M6IHtcblx0XHRcdFx0YmVmb3JlSW5zdGFsbDogW10sXG5cdFx0XHRcdGFmdGVySW5zdGFsbDogW10sXG5cdFx0XHRcdGJlZm9yZVJlbW92ZTogW10sXG5cdFx0XHRcdGFmdGVyUmVtb3ZlOiBbXSxcblx0XHRcdH0sXG5cdFx0fTtcblx0XHR0aGlzLmV4dGVuc2lvbnMucHVzaChzeW50aGV0aWMpO1xuXHRcdHJldHVybiAoKSA9PiB7XG5cdFx0XHRjb25zdCBpbmRleCA9IHRoaXMuZXh0ZW5zaW9ucy5pbmRleE9mKHN5bnRoZXRpYyk7XG5cdFx0XHRpZiAoaW5kZXggPj0gMCkgdGhpcy5leHRlbnNpb25zLnNwbGljZShpbmRleCwgMSk7XG5cdFx0fTtcblx0fVxuXG5cdGJpbmRDb3JlKGFjdGlvbnM6IEV4dGVuc2lvbkFjdGlvbnMsIGNvbnRleHRBY3Rpb25zOiBFeHRlbnNpb25Db250ZXh0QWN0aW9ucyk6IHZvaWQge1xuXHRcdC8vIENvcHkgYWN0aW9ucyBpbnRvIHRoZSBzaGFyZWQgcnVudGltZSAoYWxsIGV4dGVuc2lvbiBBUElzIHJlZmVyZW5jZSB0aGlzKVxuXHRcdHRoaXMucnVudGltZS5zZW5kTWVzc2FnZSA9IGFjdGlvbnMuc2VuZE1lc3NhZ2U7XG5cdFx0dGhpcy5ydW50aW1lLnNlbmRVc2VyTWVzc2FnZSA9IGFjdGlvbnMuc2VuZFVzZXJNZXNzYWdlO1xuXHRcdHRoaXMucnVudGltZS5yZXRyeUxhc3RUdXJuID0gYWN0aW9ucy5yZXRyeUxhc3RUdXJuO1xuXHRcdHRoaXMucnVudGltZS5hcHBlbmRFbnRyeSA9IGFjdGlvbnMuYXBwZW5kRW50cnk7XG5cdFx0dGhpcy5ydW50aW1lLnNldFNlc3Npb25OYW1lID0gYWN0aW9ucy5zZXRTZXNzaW9uTmFtZTtcblx0XHR0aGlzLnJ1bnRpbWUuZ2V0U2Vzc2lvbk5hbWUgPSBhY3Rpb25zLmdldFNlc3Npb25OYW1lO1xuXHRcdHRoaXMucnVudGltZS5zZXRMYWJlbCA9IGFjdGlvbnMuc2V0TGFiZWw7XG5cdFx0dGhpcy5ydW50aW1lLmdldEFjdGl2ZVRvb2xzID0gYWN0aW9ucy5nZXRBY3RpdmVUb29scztcblx0XHR0aGlzLnJ1bnRpbWUuZ2V0QWxsVG9vbHMgPSBhY3Rpb25zLmdldEFsbFRvb2xzO1xuXHRcdHRoaXMucnVudGltZS5zZXRBY3RpdmVUb29scyA9IGFjdGlvbnMuc2V0QWN0aXZlVG9vbHM7XG5cdFx0dGhpcy5ydW50aW1lLmdldFZpc2libGVTa2lsbHMgPSBhY3Rpb25zLmdldFZpc2libGVTa2lsbHM7XG5cdFx0dGhpcy5ydW50aW1lLnNldFZpc2libGVTa2lsbHMgPSBhY3Rpb25zLnNldFZpc2libGVTa2lsbHM7XG5cdFx0dGhpcy5ydW50aW1lLnJlZnJlc2hUb29scyA9IGFjdGlvbnMucmVmcmVzaFRvb2xzO1xuXHRcdHRoaXMucnVudGltZS5nZXRDb21tYW5kcyA9IGFjdGlvbnMuZ2V0Q29tbWFuZHM7XG5cdFx0dGhpcy5ydW50aW1lLnNldE1vZGVsID0gYWN0aW9ucy5zZXRNb2RlbDtcblx0XHR0aGlzLnJ1bnRpbWUuZ2V0VGhpbmtpbmdMZXZlbCA9IGFjdGlvbnMuZ2V0VGhpbmtpbmdMZXZlbDtcblx0XHR0aGlzLnJ1bnRpbWUuc2V0VGhpbmtpbmdMZXZlbCA9IGFjdGlvbnMuc2V0VGhpbmtpbmdMZXZlbDtcblxuXHRcdC8vIENvbnRleHQgYWN0aW9ucyAocmVxdWlyZWQpXG5cdFx0dGhpcy5nZXRNb2RlbCA9IGNvbnRleHRBY3Rpb25zLmdldE1vZGVsO1xuXHRcdHRoaXMuaXNJZGxlRm4gPSBjb250ZXh0QWN0aW9ucy5pc0lkbGU7XG5cdFx0dGhpcy5hYm9ydEZuID0gY29udGV4dEFjdGlvbnMuYWJvcnQ7XG5cdFx0dGhpcy5oYXNQZW5kaW5nTWVzc2FnZXNGbiA9IGNvbnRleHRBY3Rpb25zLmhhc1BlbmRpbmdNZXNzYWdlcztcblx0XHR0aGlzLnNodXRkb3duSGFuZGxlciA9IGNvbnRleHRBY3Rpb25zLnNodXRkb3duO1xuXHRcdHRoaXMuZ2V0Q29udGV4dFVzYWdlRm4gPSBjb250ZXh0QWN0aW9ucy5nZXRDb250ZXh0VXNhZ2U7XG5cdFx0dGhpcy5jb21wYWN0Rm4gPSBjb250ZXh0QWN0aW9ucy5jb21wYWN0O1xuXHRcdHRoaXMuZ2V0U3lzdGVtUHJvbXB0Rm4gPSBjb250ZXh0QWN0aW9ucy5nZXRTeXN0ZW1Qcm9tcHQ7XG5cdFx0dGhpcy5zZXRDb21wYWN0aW9uVGhyZXNob2xkT3ZlcnJpZGVGbiA9IGNvbnRleHRBY3Rpb25zLnNldENvbXBhY3Rpb25UaHJlc2hvbGRPdmVycmlkZTtcblxuXHRcdC8vIEZsdXNoIHByb3ZpZGVyIHJlZ2lzdHJhdGlvbnMgcXVldWVkIGR1cmluZyBleHRlbnNpb24gbG9hZGluZ1xuXHRcdGZvciAoY29uc3QgeyBuYW1lLCBjb25maWcgfSBvZiB0aGlzLnJ1bnRpbWUucGVuZGluZ1Byb3ZpZGVyUmVnaXN0cmF0aW9ucykge1xuXHRcdFx0dGhpcy5tb2RlbFJlZ2lzdHJ5LnJlZ2lzdGVyUHJvdmlkZXIobmFtZSwgY29uZmlnKTtcblx0XHR9XG5cdFx0dGhpcy5ydW50aW1lLnBlbmRpbmdQcm92aWRlclJlZ2lzdHJhdGlvbnMgPSBbXTtcblxuXHRcdC8vIEZyb20gdGhpcyBwb2ludCBvbiwgcHJvdmlkZXIgcmVnaXN0cmF0aW9uL3VucmVnaXN0cmF0aW9uIHRha2VzIGVmZmVjdCBpbW1lZGlhdGVseVxuXHRcdC8vIHdpdGhvdXQgcmVxdWlyaW5nIGEgL3JlbG9hZC5cblx0XHR0aGlzLnJ1bnRpbWUucmVnaXN0ZXJQcm92aWRlciA9IChuYW1lLCBjb25maWcpID0+IHRoaXMubW9kZWxSZWdpc3RyeS5yZWdpc3RlclByb3ZpZGVyKG5hbWUsIGNvbmZpZyk7XG5cdFx0dGhpcy5ydW50aW1lLnVucmVnaXN0ZXJQcm92aWRlciA9IChuYW1lKSA9PiB0aGlzLm1vZGVsUmVnaXN0cnkudW5yZWdpc3RlclByb3ZpZGVyKG5hbWUpO1xuXHR9XG5cblx0YmluZENvbW1hbmRDb250ZXh0KGFjdGlvbnM/OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dEFjdGlvbnMpOiB2b2lkIHtcblx0XHRpZiAoYWN0aW9ucykge1xuXHRcdFx0dGhpcy53YWl0Rm9ySWRsZUZuID0gYWN0aW9ucy53YWl0Rm9ySWRsZTtcblx0XHRcdHRoaXMubmV3U2Vzc2lvbkhhbmRsZXIgPSBhY3Rpb25zLm5ld1Nlc3Npb247XG5cdFx0XHR0aGlzLmZvcmtIYW5kbGVyID0gYWN0aW9ucy5mb3JrO1xuXHRcdFx0dGhpcy5uYXZpZ2F0ZVRyZWVIYW5kbGVyID0gYWN0aW9ucy5uYXZpZ2F0ZVRyZWU7XG5cdFx0XHR0aGlzLnN3aXRjaFNlc3Npb25IYW5kbGVyID0gYWN0aW9ucy5zd2l0Y2hTZXNzaW9uO1xuXHRcdFx0dGhpcy5yZWxvYWRIYW5kbGVyID0gYWN0aW9ucy5yZWxvYWQ7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0dGhpcy53YWl0Rm9ySWRsZUZuID0gYXN5bmMgKCkgPT4ge307XG5cdFx0dGhpcy5uZXdTZXNzaW9uSGFuZGxlciA9IGFzeW5jICgpID0+ICh7IGNhbmNlbGxlZDogZmFsc2UgfSk7XG5cdFx0dGhpcy5mb3JrSGFuZGxlciA9IGFzeW5jICgpID0+ICh7IGNhbmNlbGxlZDogZmFsc2UgfSk7XG5cdFx0dGhpcy5uYXZpZ2F0ZVRyZWVIYW5kbGVyID0gYXN5bmMgKCkgPT4gKHsgY2FuY2VsbGVkOiBmYWxzZSB9KTtcblx0XHR0aGlzLnN3aXRjaFNlc3Npb25IYW5kbGVyID0gYXN5bmMgKCkgPT4gKHsgY2FuY2VsbGVkOiBmYWxzZSB9KTtcblx0XHR0aGlzLnJlbG9hZEhhbmRsZXIgPSBhc3luYyAoKSA9PiB7fTtcblx0fVxuXG5cdHNldFVJQ29udGV4dCh1aUNvbnRleHQ/OiBFeHRlbnNpb25VSUNvbnRleHQpOiB2b2lkIHtcblx0XHR0aGlzLnVpQ29udGV4dCA9IHVpQ29udGV4dCA/PyBub09wVUlDb250ZXh0O1xuXHR9XG5cblx0Z2V0VUlDb250ZXh0KCk6IEV4dGVuc2lvblVJQ29udGV4dCB7XG5cdFx0cmV0dXJuIHRoaXMudWlDb250ZXh0O1xuXHR9XG5cblx0aGFzVUkoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMudWlDb250ZXh0ICE9PSBub09wVUlDb250ZXh0O1xuXHR9XG5cblx0Z2V0RXh0ZW5zaW9uUGF0aHMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiB0aGlzLmV4dGVuc2lvbnMubWFwKChlKSA9PiBlLnBhdGgpO1xuXHR9XG5cblx0LyoqIEdldCBhbGwgcmVnaXN0ZXJlZCB0b29scyBmcm9tIGFsbCBleHRlbnNpb25zIChmaXJzdCByZWdpc3RyYXRpb24gcGVyIG5hbWUgd2lucykuICovXG5cdGdldEFsbFJlZ2lzdGVyZWRUb29scygpOiBSZWdpc3RlcmVkVG9vbFtdIHtcblx0XHRjb25zdCB0b29sc0J5TmFtZSA9IG5ldyBNYXA8c3RyaW5nLCBSZWdpc3RlcmVkVG9vbD4oKTtcblx0XHRmb3IgKGNvbnN0IGV4dCBvZiB0aGlzLmV4dGVuc2lvbnMpIHtcblx0XHRcdGZvciAoY29uc3QgdG9vbCBvZiBleHQudG9vbHMudmFsdWVzKCkpIHtcblx0XHRcdFx0aWYgKCF0b29sc0J5TmFtZS5oYXModG9vbC5kZWZpbml0aW9uLm5hbWUpKSB7XG5cdFx0XHRcdFx0dG9vbHNCeU5hbWUuc2V0KHRvb2wuZGVmaW5pdGlvbi5uYW1lLCB0b29sKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0b29sc0J5TmFtZS52YWx1ZXMoKSk7XG5cdH1cblxuXHQvKiogR2V0IGEgdG9vbCBkZWZpbml0aW9uIGJ5IG5hbWUuIFJldHVybnMgdW5kZWZpbmVkIGlmIG5vdCBmb3VuZC4gKi9cblx0Z2V0VG9vbERlZmluaXRpb24odG9vbE5hbWU6IHN0cmluZyk6IFJlZ2lzdGVyZWRUb29sW1wiZGVmaW5pdGlvblwiXSB8IHVuZGVmaW5lZCB7XG5cdFx0Zm9yIChjb25zdCBleHQgb2YgdGhpcy5leHRlbnNpb25zKSB7XG5cdFx0XHRjb25zdCB0b29sID0gZXh0LnRvb2xzLmdldCh0b29sTmFtZSk7XG5cdFx0XHRpZiAodG9vbCkge1xuXHRcdFx0XHRyZXR1cm4gdG9vbC5kZWZpbml0aW9uO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0Z2V0RmxhZ3MoKTogTWFwPHN0cmluZywgRXh0ZW5zaW9uRmxhZz4ge1xuXHRcdGNvbnN0IGFsbEZsYWdzID0gbmV3IE1hcDxzdHJpbmcsIEV4dGVuc2lvbkZsYWc+KCk7XG5cdFx0Zm9yIChjb25zdCBleHQgb2YgdGhpcy5leHRlbnNpb25zKSB7XG5cdFx0XHRmb3IgKGNvbnN0IFtuYW1lLCBmbGFnXSBvZiBleHQuZmxhZ3MpIHtcblx0XHRcdFx0aWYgKCFhbGxGbGFncy5oYXMobmFtZSkpIHtcblx0XHRcdFx0XHRhbGxGbGFncy5zZXQobmFtZSwgZmxhZyk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdFx0cmV0dXJuIGFsbEZsYWdzO1xuXHR9XG5cblx0c2V0RmxhZ1ZhbHVlKG5hbWU6IHN0cmluZywgdmFsdWU6IGJvb2xlYW4gfCBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLnJ1bnRpbWUuZmxhZ1ZhbHVlcy5zZXQobmFtZSwgdmFsdWUpO1xuXHR9XG5cblx0Z2V0RmxhZ1ZhbHVlcygpOiBNYXA8c3RyaW5nLCBib29sZWFuIHwgc3RyaW5nPiB7XG5cdFx0cmV0dXJuIG5ldyBNYXAodGhpcy5ydW50aW1lLmZsYWdWYWx1ZXMpO1xuXHR9XG5cblx0Z2V0U2hvcnRjdXRzKGVmZmVjdGl2ZUtleWJpbmRpbmdzOiBSZXF1aXJlZDxLZXliaW5kaW5nc0NvbmZpZz4pOiBNYXA8S2V5SWQsIEV4dGVuc2lvblNob3J0Y3V0PiB7XG5cdFx0dGhpcy5zaG9ydGN1dERpYWdub3N0aWNzID0gW107XG5cdFx0Y29uc3QgYnVpbHRpbktleWJpbmRpbmdzID0gYnVpbGRCdWlsdGluS2V5YmluZGluZ3MoZWZmZWN0aXZlS2V5YmluZGluZ3MpO1xuXHRcdGNvbnN0IGV4dGVuc2lvblNob3J0Y3V0cyA9IG5ldyBNYXA8S2V5SWQsIEV4dGVuc2lvblNob3J0Y3V0PigpO1xuXG5cdFx0Y29uc3QgYWRkRGlhZ25vc3RpYyA9IChtZXNzYWdlOiBzdHJpbmcsIGV4dGVuc2lvblBhdGg6IHN0cmluZykgPT4ge1xuXHRcdFx0dGhpcy5zaG9ydGN1dERpYWdub3N0aWNzLnB1c2goeyB0eXBlOiBcIndhcm5pbmdcIiwgbWVzc2FnZSwgcGF0aDogZXh0ZW5zaW9uUGF0aCB9KTtcblx0XHRcdGlmICghdGhpcy5oYXNVSSgpKSB7XG5cdFx0XHRcdGNvbnNvbGUud2FybihtZXNzYWdlKTtcblx0XHRcdH1cblx0XHR9O1xuXG5cdFx0Zm9yIChjb25zdCBleHQgb2YgdGhpcy5leHRlbnNpb25zKSB7XG5cdFx0XHRmb3IgKGNvbnN0IFtrZXksIHNob3J0Y3V0XSBvZiBleHQuc2hvcnRjdXRzKSB7XG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRLZXkgPSBrZXkudG9Mb3dlckNhc2UoKSBhcyBLZXlJZDtcblxuXHRcdFx0XHRjb25zdCBidWlsdEluS2V5YmluZGluZyA9IGJ1aWx0aW5LZXliaW5kaW5nc1tub3JtYWxpemVkS2V5XTtcblx0XHRcdFx0aWYgKGJ1aWx0SW5LZXliaW5kaW5nPy5yZXN0cmljdE92ZXJyaWRlID09PSB0cnVlKSB7XG5cdFx0XHRcdFx0YWRkRGlhZ25vc3RpYyhcblx0XHRcdFx0XHRcdGBFeHRlbnNpb24gc2hvcnRjdXQgJyR7a2V5fScgZnJvbSAke3Nob3J0Y3V0LmV4dGVuc2lvblBhdGh9IGNvbmZsaWN0cyB3aXRoIGJ1aWx0LWluIHNob3J0Y3V0LiBTa2lwcGluZy5gLFxuXHRcdFx0XHRcdFx0c2hvcnRjdXQuZXh0ZW5zaW9uUGF0aCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKGJ1aWx0SW5LZXliaW5kaW5nPy5yZXN0cmljdE92ZXJyaWRlID09PSBmYWxzZSkge1xuXHRcdFx0XHRcdGFkZERpYWdub3N0aWMoXG5cdFx0XHRcdFx0XHRgRXh0ZW5zaW9uIHNob3J0Y3V0IGNvbmZsaWN0OiAnJHtrZXl9JyBpcyBidWlsdC1pbiBzaG9ydGN1dCBmb3IgJHtidWlsdEluS2V5YmluZGluZy5hY3Rpb259IGFuZCAke3Nob3J0Y3V0LmV4dGVuc2lvblBhdGh9LiBVc2luZyAke3Nob3J0Y3V0LmV4dGVuc2lvblBhdGh9LmAsXG5cdFx0XHRcdFx0XHRzaG9ydGN1dC5leHRlbnNpb25QYXRoLFxuXHRcdFx0XHRcdCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb25zdCBleGlzdGluZ0V4dGVuc2lvblNob3J0Y3V0ID0gZXh0ZW5zaW9uU2hvcnRjdXRzLmdldChub3JtYWxpemVkS2V5KTtcblx0XHRcdFx0aWYgKGV4aXN0aW5nRXh0ZW5zaW9uU2hvcnRjdXQpIHtcblx0XHRcdFx0XHRhZGREaWFnbm9zdGljKFxuXHRcdFx0XHRcdFx0YEV4dGVuc2lvbiBzaG9ydGN1dCBjb25mbGljdDogJyR7a2V5fScgcmVnaXN0ZXJlZCBieSBib3RoICR7ZXhpc3RpbmdFeHRlbnNpb25TaG9ydGN1dC5leHRlbnNpb25QYXRofSBhbmQgJHtzaG9ydGN1dC5leHRlbnNpb25QYXRofS4gVXNpbmcgJHtzaG9ydGN1dC5leHRlbnNpb25QYXRofS5gLFxuXHRcdFx0XHRcdFx0c2hvcnRjdXQuZXh0ZW5zaW9uUGF0aCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGV4dGVuc2lvblNob3J0Y3V0cy5zZXQobm9ybWFsaXplZEtleSwgc2hvcnRjdXQpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gZXh0ZW5zaW9uU2hvcnRjdXRzO1xuXHR9XG5cblx0Z2V0U2hvcnRjdXREaWFnbm9zdGljcygpOiBSZXNvdXJjZURpYWdub3N0aWNbXSB7XG5cdFx0cmV0dXJuIHRoaXMuc2hvcnRjdXREaWFnbm9zdGljcztcblx0fVxuXG5cdG9uRXJyb3IobGlzdGVuZXI6IEV4dGVuc2lvbkVycm9yTGlzdGVuZXIpOiAoKSA9PiB2b2lkIHtcblx0XHR0aGlzLmVycm9yTGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG5cdFx0cmV0dXJuICgpID0+IHRoaXMuZXJyb3JMaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcblx0fVxuXG5cdGVtaXRFcnJvcihlcnJvcjogRXh0ZW5zaW9uRXJyb3IpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIHRoaXMuZXJyb3JMaXN0ZW5lcnMpIHtcblx0XHRcdGxpc3RlbmVyKGVycm9yKTtcblx0XHR9XG5cdH1cblxuXHRoYXNIYW5kbGVycyhldmVudFR5cGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGZvciAoY29uc3QgZXh0IG9mIHRoaXMuZXh0ZW5zaW9ucykge1xuXHRcdFx0Y29uc3QgaGFuZGxlcnMgPSBleHQuaGFuZGxlcnMuZ2V0KGV2ZW50VHlwZSk7XG5cdFx0XHRpZiAoaGFuZGxlcnMgJiYgaGFuZGxlcnMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH1cblx0XHR9XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0Z2V0TWVzc2FnZVJlbmRlcmVyKGN1c3RvbVR5cGU6IHN0cmluZyk6IE1lc3NhZ2VSZW5kZXJlciB8IHVuZGVmaW5lZCB7XG5cdFx0Zm9yIChjb25zdCBleHQgb2YgdGhpcy5leHRlbnNpb25zKSB7XG5cdFx0XHRjb25zdCByZW5kZXJlciA9IGV4dC5tZXNzYWdlUmVuZGVyZXJzLmdldChjdXN0b21UeXBlKTtcblx0XHRcdGlmIChyZW5kZXJlcikge1xuXHRcdFx0XHRyZXR1cm4gcmVuZGVyZXI7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblxuXHRnZXRSZWdpc3RlcmVkQ29tbWFuZHMocmVzZXJ2ZWQ/OiBTZXQ8c3RyaW5nPik6IFJlZ2lzdGVyZWRDb21tYW5kW10ge1xuXHRcdHRoaXMuY29tbWFuZERpYWdub3N0aWNzID0gW107XG5cblx0XHRjb25zdCBjb21tYW5kczogUmVnaXN0ZXJlZENvbW1hbmRbXSA9IFtdO1xuXHRcdGNvbnN0IGNvbW1hbmRPd25lcnMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuXHRcdGNvbnN0IHByb3RlY3RlZE93bmVycyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cdFx0Zm9yIChjb25zdCBleHQgb2YgdGhpcy5leHRlbnNpb25zKSB7XG5cdFx0XHRmb3IgKGNvbnN0IGNvbW1hbmQgb2YgZXh0LmNvbW1hbmRzLnZhbHVlcygpKSB7XG5cdFx0XHRcdGlmIChpc1Byb3RlY3RlZENvbW1hbmRPd25lcihjb21tYW5kLm5hbWUsIGV4dC5wYXRoKSkge1xuXHRcdFx0XHRcdHByb3RlY3RlZE93bmVycy5zZXQoY29tbWFuZC5uYW1lLCBleHQucGF0aCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHRmb3IgKGNvbnN0IGV4dCBvZiB0aGlzLmV4dGVuc2lvbnMpIHtcblx0XHRcdGZvciAoY29uc3QgY29tbWFuZCBvZiBleHQuY29tbWFuZHMudmFsdWVzKCkpIHtcblx0XHRcdFx0aWYgKHJlc2VydmVkPy5oYXMoY29tbWFuZC5uYW1lKSkge1xuXHRcdFx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBgRXh0ZW5zaW9uIGNvbW1hbmQgJyR7Y29tbWFuZC5uYW1lfScgZnJvbSAke2V4dC5wYXRofSBjb25mbGljdHMgd2l0aCBidWlsdC1pbiBjb21tYW5kcy4gU2tpcHBpbmcuYDtcblx0XHRcdFx0XHR0aGlzLmNvbW1hbmREaWFnbm9zdGljcy5wdXNoKHsgdHlwZTogXCJ3YXJuaW5nXCIsIG1lc3NhZ2UsIHBhdGg6IGV4dC5wYXRoIH0pO1xuXHRcdFx0XHRcdGlmICghdGhpcy5oYXNVSSgpKSB7XG5cdFx0XHRcdFx0XHRjb25zb2xlLndhcm4obWVzc2FnZSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y29uc3QgcHJvdGVjdGVkT3duZXIgPSBwcm90ZWN0ZWRPd25lcnMuZ2V0KGNvbW1hbmQubmFtZSk7XG5cdFx0XHRcdGlmIChwcm90ZWN0ZWRPd25lciAmJiBwcm90ZWN0ZWRPd25lciAhPT0gZXh0LnBhdGgpIHtcblx0XHRcdFx0XHRjb25zdCBtZXNzYWdlID0gYEV4dGVuc2lvbiBjb21tYW5kICcke2NvbW1hbmQubmFtZX0nIGZyb20gJHtleHQucGF0aH0gY29uZmxpY3RzIHdpdGggcHJvdGVjdGVkIGNvbW1hbmQgb3duZXIgJHtwcm90ZWN0ZWRPd25lcn0uIFNraXBwaW5nLmA7XG5cdFx0XHRcdFx0dGhpcy5jb21tYW5kRGlhZ25vc3RpY3MucHVzaCh7IHR5cGU6IFwid2FybmluZ1wiLCBtZXNzYWdlLCBwYXRoOiBleHQucGF0aCB9KTtcblx0XHRcdFx0XHRpZiAoIXRoaXMuaGFzVUkoKSkge1xuXHRcdFx0XHRcdFx0Y29uc29sZS53YXJuKG1lc3NhZ2UpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGV4aXN0aW5nT3duZXIgPSBjb21tYW5kT3duZXJzLmdldChjb21tYW5kLm5hbWUpO1xuXHRcdFx0XHRpZiAoZXhpc3RpbmdPd25lcikge1xuXHRcdFx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBgRXh0ZW5zaW9uIGNvbW1hbmQgJyR7Y29tbWFuZC5uYW1lfScgZnJvbSAke2V4dC5wYXRofSBjb25mbGljdHMgd2l0aCAke2V4aXN0aW5nT3duZXJ9LiBTa2lwcGluZy5gO1xuXHRcdFx0XHRcdHRoaXMuY29tbWFuZERpYWdub3N0aWNzLnB1c2goeyB0eXBlOiBcIndhcm5pbmdcIiwgbWVzc2FnZSwgcGF0aDogZXh0LnBhdGggfSk7XG5cdFx0XHRcdFx0aWYgKCF0aGlzLmhhc1VJKCkpIHtcblx0XHRcdFx0XHRcdGNvbnNvbGUud2FybihtZXNzYWdlKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjb21tYW5kT3duZXJzLnNldChjb21tYW5kLm5hbWUsIGV4dC5wYXRoKTtcblx0XHRcdFx0Y29tbWFuZHMucHVzaChjb21tYW5kKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0cmV0dXJuIGNvbW1hbmRzO1xuXHR9XG5cblx0Z2V0Q29tbWFuZERpYWdub3N0aWNzKCk6IFJlc291cmNlRGlhZ25vc3RpY1tdIHtcblx0XHRyZXR1cm4gdGhpcy5jb21tYW5kRGlhZ25vc3RpY3M7XG5cdH1cblxuXHRnZXRSZWdpc3RlcmVkQ29tbWFuZHNXaXRoUGF0aHMoKTogQXJyYXk8eyBjb21tYW5kOiBSZWdpc3RlcmVkQ29tbWFuZDsgZXh0ZW5zaW9uUGF0aDogc3RyaW5nIH0+IHtcblx0XHRjb25zdCByZXN1bHQ6IEFycmF5PHsgY29tbWFuZDogUmVnaXN0ZXJlZENvbW1hbmQ7IGV4dGVuc2lvblBhdGg6IHN0cmluZyB9PiA9IFtdO1xuXHRcdGZvciAoY29uc3QgZXh0IG9mIHRoaXMuZXh0ZW5zaW9ucykge1xuXHRcdFx0Zm9yIChjb25zdCBjb21tYW5kIG9mIGV4dC5jb21tYW5kcy52YWx1ZXMoKSkge1xuXHRcdFx0XHRyZXN1bHQucHVzaCh7IGNvbW1hbmQsIGV4dGVuc2lvblBhdGg6IGV4dC5wYXRoIH0pO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG5cblx0Z2V0Q29tbWFuZChuYW1lOiBzdHJpbmcpOiBSZWdpc3RlcmVkQ29tbWFuZCB8IHVuZGVmaW5lZCB7XG5cdFx0bGV0IHByb3RlY3RlZENvbW1hbmQ6IFJlZ2lzdGVyZWRDb21tYW5kIHwgdW5kZWZpbmVkO1xuXHRcdGZvciAoY29uc3QgZXh0IG9mIHRoaXMuZXh0ZW5zaW9ucykge1xuXHRcdFx0Y29uc3QgY29tbWFuZCA9IGV4dC5jb21tYW5kcy5nZXQobmFtZSk7XG5cdFx0XHRpZiAoY29tbWFuZCkge1xuXHRcdFx0XHRpZiAoaXNQcm90ZWN0ZWRDb21tYW5kT3duZXIobmFtZSwgZXh0LnBhdGgpKSB7XG5cdFx0XHRcdFx0cHJvdGVjdGVkQ29tbWFuZCA9IGNvbW1hbmQ7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKFBST1RFQ1RFRF9FWFRFTlNJT05fQ09NTUFORFMuaGFzKG5hbWUpKSB7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIGNvbW1hbmQ7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHJldHVybiBwcm90ZWN0ZWRDb21tYW5kO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlcXVlc3QgYSBncmFjZWZ1bCBzaHV0ZG93bi4gQ2FsbGVkIGJ5IGV4dGVuc2lvbiB0b29scyBhbmQgZXZlbnQgaGFuZGxlcnMuXG5cdCAqIFRoZSBhY3R1YWwgc2h1dGRvd24gYmVoYXZpb3IgaXMgcHJvdmlkZWQgYnkgdGhlIG1vZGUgdmlhIGJpbmRFeHRlbnNpb25zKCkuXG5cdCAqL1xuXHRzaHV0ZG93bigpOiB2b2lkIHtcblx0XHR0aGlzLnNodXRkb3duSGFuZGxlcigpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENyZWF0ZSBhbiBFeHRlbnNpb25Db250ZXh0IGZvciB1c2UgaW4gZXZlbnQgaGFuZGxlcnMgYW5kIHRvb2wgZXhlY3V0aW9uLlxuXHQgKiBDb250ZXh0IHZhbHVlcyBhcmUgcmVzb2x2ZWQgYXQgY2FsbCB0aW1lLCBzbyBjaGFuZ2VzIHZpYSBiaW5kQ29yZS9iaW5kVUkgYXJlIHJlZmxlY3RlZC5cblx0ICovXG5cdGNyZWF0ZUNvbnRleHQoKTogRXh0ZW5zaW9uQ29udGV4dCB7XG5cdFx0Y29uc3QgZ2V0TW9kZWwgPSB0aGlzLmdldE1vZGVsO1xuXHRcdHJldHVybiB7XG5cdFx0XHR1aTogdGhpcy51aUNvbnRleHQsXG5cdFx0XHRoYXNVSTogdGhpcy5oYXNVSSgpLFxuXHRcdFx0Y3dkOiB0aGlzLmN1cnJlbnRDd2QoKSxcblx0XHRcdHNlc3Npb25NYW5hZ2VyOiB0aGlzLnNlc3Npb25NYW5hZ2VyLFxuXHRcdFx0bW9kZWxSZWdpc3RyeTogdGhpcy5tb2RlbFJlZ2lzdHJ5LFxuXHRcdFx0Z2V0IG1vZGVsKCkge1xuXHRcdFx0XHRyZXR1cm4gZ2V0TW9kZWwoKTtcblx0XHRcdH0sXG5cdFx0XHRpc0lkbGU6ICgpID0+IHRoaXMuaXNJZGxlRm4oKSxcblx0XHRcdGFib3J0OiAoKSA9PiB0aGlzLmFib3J0Rm4oKSxcblx0XHRcdGhhc1BlbmRpbmdNZXNzYWdlczogKCkgPT4gdGhpcy5oYXNQZW5kaW5nTWVzc2FnZXNGbigpLFxuXHRcdFx0c2h1dGRvd246ICgpID0+IHRoaXMuc2h1dGRvd25IYW5kbGVyKCksXG5cdFx0XHRnZXRDb250ZXh0VXNhZ2U6ICgpID0+IHRoaXMuZ2V0Q29udGV4dFVzYWdlRm4oKSxcblx0XHRcdGNvbXBhY3Q6IChvcHRpb25zKSA9PiB0aGlzLmNvbXBhY3RGbihvcHRpb25zKSxcblx0XHRcdGdldFN5c3RlbVByb21wdDogKCkgPT4gdGhpcy5nZXRTeXN0ZW1Qcm9tcHRGbigpLFxuXHRcdFx0c2V0Q29tcGFjdGlvblRocmVzaG9sZE92ZXJyaWRlOiAocGVyY2VudCkgPT4gdGhpcy5zZXRDb21wYWN0aW9uVGhyZXNob2xkT3ZlcnJpZGVGbihwZXJjZW50KSxcblx0XHR9O1xuXHR9XG5cblx0cHJpdmF0ZSBjcmVhdGVFdmVudENvbnRleHQoZXZlbnRUeXBlOiBzdHJpbmcpOiBFeHRlbnNpb25Db250ZXh0IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4udGhpcy5jcmVhdGVDb250ZXh0KCksXG5cdFx0XHRzaHV0ZG93bjogKCkgPT4ge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEV4dGVuc2lvbiBldmVudCAnJHtldmVudFR5cGV9JyBjYW5ub3QgcmVxdWVzdCBUVUkgc2h1dGRvd25gKTtcblx0XHRcdH0sXG5cdFx0fTtcblx0fVxuXG5cdHByaXZhdGUgaXNTaHV0ZG93bkd1YXJkZWRFdmVudChldmVudFR5cGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiBldmVudFR5cGUgPT09IFwiYWdlbnRfZW5kXCIgfHwgZXZlbnRUeXBlID09PSBcInN0b3BcIiB8fCBldmVudFR5cGUgPT09IFwic2Vzc2lvbl9lbmRcIjtcblx0fVxuXG5cdGNyZWF0ZUNvbW1hbmRDb250ZXh0KCk6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4udGhpcy5jcmVhdGVDb250ZXh0KCksXG5cdFx0XHR3YWl0Rm9ySWRsZTogKCkgPT4gdGhpcy53YWl0Rm9ySWRsZUZuKCksXG5cdFx0XHRuZXdTZXNzaW9uOiAob3B0aW9ucykgPT4gdGhpcy5uZXdTZXNzaW9uSGFuZGxlcihvcHRpb25zKSxcblx0XHRcdGZvcms6IChlbnRyeUlkKSA9PiB0aGlzLmZvcmtIYW5kbGVyKGVudHJ5SWQpLFxuXHRcdFx0bmF2aWdhdGVUcmVlOiAodGFyZ2V0SWQsIG9wdGlvbnMpID0+IHRoaXMubmF2aWdhdGVUcmVlSGFuZGxlcih0YXJnZXRJZCwgb3B0aW9ucyksXG5cdFx0XHRzd2l0Y2hTZXNzaW9uOiAoc2Vzc2lvblBhdGgpID0+IHRoaXMuc3dpdGNoU2Vzc2lvbkhhbmRsZXIoc2Vzc2lvblBhdGgpLFxuXHRcdFx0cmVsb2FkOiAoKSA9PiB0aGlzLnJlbG9hZEhhbmRsZXIoKSxcblx0XHR9O1xuXHR9XG5cblx0cHJpdmF0ZSBpc1Nlc3Npb25CZWZvcmVFdmVudChldmVudDogUnVubmVyRW1pdEV2ZW50KTogZXZlbnQgaXMgU2Vzc2lvbkJlZm9yZUV2ZW50IHtcblx0XHRyZXR1cm4gKFxuXHRcdFx0ZXZlbnQudHlwZSA9PT0gXCJzZXNzaW9uX2JlZm9yZV9zd2l0Y2hcIiB8fFxuXHRcdFx0ZXZlbnQudHlwZSA9PT0gXCJzZXNzaW9uX2JlZm9yZV9mb3JrXCIgfHxcblx0XHRcdGV2ZW50LnR5cGUgPT09IFwic2Vzc2lvbl9iZWZvcmVfY29tcGFjdFwiIHx8XG5cdFx0XHRldmVudC50eXBlID09PSBcInNlc3Npb25fYmVmb3JlX3RyZWVcIlxuXHRcdCk7XG5cdH1cblxuXHQvKipcblx0ICogU2hhcmVkIGhhbmRsZXIgaW52b2NhdGlvbiBsb29wLlxuXHQgKlxuXHQgKiBJdGVyYXRlcyBldmVyeSBoYW5kbGVyIHJlZ2lzdGVyZWQgZm9yIGBldmVudFR5cGVgIGFjcm9zcyBhbGwgZXh0ZW5zaW9ucyxcblx0ICogY2FsbGluZyBlYWNoIGluc2lkZSBhIHRyeS9jYXRjaCB0aGF0IGVtaXRzIGFuIEV4dGVuc2lvbkVycm9yIG9uIGZhaWx1cmUuXG5cdCAqXG5cdCAqIGBnZXRFdmVudGAgYnVpbGRzIHRoZSBldmVudCBvYmplY3QgZm9yIGVhY2ggaGFuZGxlciBjYWxsIFx1MjAxNCBjYWxsZXJzIHRoYXRcblx0ICogbXV0YXRlIHN0YXRlIGJldHdlZW4gY2FsbHMgKGUuZy4gY29udGV4dCwgYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3QpIHN1cHBseVxuXHQgKiBhIGZ1bmN0aW9uOyBjYWxsZXJzIHdpdGggYSBmaXhlZCBldmVudCBjYW4gcGFzcyBhIGNvbnN0YW50LlxuXHQgKlxuXHQgKiBgcHJvY2Vzc1Jlc3VsdGAgcmVjZWl2ZXMgZWFjaCBoYW5kbGVyJ3MgcmV0dXJuIHZhbHVlIGFuZCB0aGUgb3duaW5nXG5cdCAqIGV4dGVuc2lvbidzIHBhdGguIEl0IHJldHVybnMgYHsgZG9uZTogdHJ1ZSB9YCB0byBzaG9ydC1jaXJjdWl0XG5cdCAqIG9yIGB7IGRvbmU6IGZhbHNlIH1gIHRvIGtlZXAgaXRlcmF0aW5nLlxuXHQgKi9cblx0cHJpdmF0ZSBhc3luYyBpbnZva2VIYW5kbGVycyhcblx0XHRldmVudFR5cGU6IHN0cmluZyxcblx0XHRnZXRFdmVudDogKCkgPT4gdW5rbm93bixcblx0XHRwcm9jZXNzUmVzdWx0OiAoaGFuZGxlclJlc3VsdDogdW5rbm93biwgZXh0ZW5zaW9uUGF0aDogc3RyaW5nKSA9PiB7IGRvbmU6IGJvb2xlYW4gfSxcblx0KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgY3R4ID0gdGhpcy5pc1NodXRkb3duR3VhcmRlZEV2ZW50KGV2ZW50VHlwZSlcblx0XHRcdD8gdGhpcy5jcmVhdGVFdmVudENvbnRleHQoZXZlbnRUeXBlKVxuXHRcdFx0OiB0aGlzLmNyZWF0ZUNvbnRleHQoKTtcblxuXHRcdGZvciAoY29uc3QgZXh0IG9mIHRoaXMuZXh0ZW5zaW9ucykge1xuXHRcdFx0Y29uc3QgaGFuZGxlcnMgPSBleHQuaGFuZGxlcnMuZ2V0KGV2ZW50VHlwZSk7XG5cdFx0XHRpZiAoIWhhbmRsZXJzIHx8IGhhbmRsZXJzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG5cblx0XHRcdGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IGV2ZW50ID0gZ2V0RXZlbnQoKTtcblx0XHRcdFx0XHRjb25zdCBoYW5kbGVyUmVzdWx0ID0gYXdhaXQgaGFuZGxlcihldmVudCwgY3R4KTtcblx0XHRcdFx0XHRjb25zdCBhY3Rpb24gPSBwcm9jZXNzUmVzdWx0KGhhbmRsZXJSZXN1bHQsIGV4dC5wYXRoKTtcblx0XHRcdFx0XHRpZiAoYWN0aW9uLmRvbmUpIHJldHVybjtcblx0XHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdFx0Y29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdFx0XHRjb25zdCBzdGFjayA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRcdHRoaXMuZW1pdEVycm9yKHtcblx0XHRcdFx0XHRcdGV4dGVuc2lvblBhdGg6IGV4dC5wYXRoLFxuXHRcdFx0XHRcdFx0ZXZlbnQ6IGV2ZW50VHlwZSxcblx0XHRcdFx0XHRcdGVycm9yOiBtZXNzYWdlLFxuXHRcdFx0XHRcdFx0c3RhY2ssXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRhc3luYyBlbWl0PFRFdmVudCBleHRlbmRzIFJ1bm5lckVtaXRFdmVudD4oZXZlbnQ6IFRFdmVudCk6IFByb21pc2U8UnVubmVyRW1pdFJlc3VsdDxURXZlbnQ+PiB7XG5cdFx0bGV0IHJlc3VsdDogU2Vzc2lvbkJlZm9yZUV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGlzU2Vzc2lvbkJlZm9yZSA9IHRoaXMuaXNTZXNzaW9uQmVmb3JlRXZlbnQoZXZlbnQpO1xuXG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhldmVudC50eXBlLCAoKSA9PiBldmVudCwgKGhhbmRsZXJSZXN1bHQpID0+IHtcblx0XHRcdGlmIChpc1Nlc3Npb25CZWZvcmUgJiYgaGFuZGxlclJlc3VsdCkge1xuXHRcdFx0XHRyZXN1bHQgPSBoYW5kbGVyUmVzdWx0IGFzIFNlc3Npb25CZWZvcmVFdmVudFJlc3VsdDtcblx0XHRcdFx0aWYgKHJlc3VsdC5jYW5jZWwpIHJldHVybiB7IGRvbmU6IHRydWUgfTtcblx0XHRcdH1cblx0XHRcdHJldHVybiB7IGRvbmU6IGZhbHNlIH07XG5cdFx0fSk7XG5cblx0XHRyZXR1cm4gcmVzdWx0IGFzIFJ1bm5lckVtaXRSZXN1bHQ8VEV2ZW50Pjtcblx0fVxuXG5cdGFzeW5jIGVtaXRUb29sUmVzdWx0KGV2ZW50OiBUb29sUmVzdWx0RXZlbnQpOiBQcm9taXNlPFRvb2xSZXN1bHRFdmVudFJlc3VsdCB8IHVuZGVmaW5lZD4ge1xuXHRcdGNvbnN0IGN1cnJlbnRFdmVudDogVG9vbFJlc3VsdEV2ZW50ID0geyAuLi5ldmVudCB9O1xuXHRcdGxldCBtb2RpZmllZCA9IGZhbHNlO1xuXG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhcInRvb2xfcmVzdWx0XCIsICgpID0+IGN1cnJlbnRFdmVudCwgKGhhbmRsZXJSZXN1bHQpID0+IHtcblx0XHRcdGNvbnN0IHIgPSBoYW5kbGVyUmVzdWx0IGFzIFRvb2xSZXN1bHRFdmVudFJlc3VsdCB8IHVuZGVmaW5lZDtcblx0XHRcdGlmICghcikgcmV0dXJuIHsgZG9uZTogZmFsc2UgfTtcblxuXHRcdFx0aWYgKHIuY29udGVudCAhPT0gdW5kZWZpbmVkKSB7IGN1cnJlbnRFdmVudC5jb250ZW50ID0gci5jb250ZW50OyBtb2RpZmllZCA9IHRydWU7IH1cblx0XHRcdGlmIChyLmRldGFpbHMgIT09IHVuZGVmaW5lZCkgeyBjdXJyZW50RXZlbnQuZGV0YWlscyA9IHIuZGV0YWlsczsgbW9kaWZpZWQgPSB0cnVlOyB9XG5cdFx0XHRpZiAoci5pc0Vycm9yICE9PSB1bmRlZmluZWQpIHsgY3VycmVudEV2ZW50LmlzRXJyb3IgPSByLmlzRXJyb3I7IG1vZGlmaWVkID0gdHJ1ZTsgfVxuXHRcdFx0cmV0dXJuIHsgZG9uZTogZmFsc2UgfTtcblx0XHR9KTtcblxuXHRcdGlmICghbW9kaWZpZWQpIHJldHVybiB1bmRlZmluZWQ7XG5cdFx0cmV0dXJuIHsgY29udGVudDogY3VycmVudEV2ZW50LmNvbnRlbnQsIGRldGFpbHM6IGN1cnJlbnRFdmVudC5kZXRhaWxzLCBpc0Vycm9yOiBjdXJyZW50RXZlbnQuaXNFcnJvciB9O1xuXHR9XG5cblx0YXN5bmMgZW1pdFRvb2xDYWxsKGV2ZW50OiBUb29sQ2FsbEV2ZW50KTogUHJvbWlzZTxUb29sQ2FsbEV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkPiB7XG5cdFx0bGV0IHJlc3VsdDogVG9vbENhbGxFdmVudFJlc3VsdCB8IHVuZGVmaW5lZDtcblxuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXCJ0b29sX2NhbGxcIiwgKCkgPT4gZXZlbnQsIChoYW5kbGVyUmVzdWx0KSA9PiB7XG5cdFx0XHRpZiAoaGFuZGxlclJlc3VsdCkge1xuXHRcdFx0XHRyZXN1bHQgPSBoYW5kbGVyUmVzdWx0IGFzIFRvb2xDYWxsRXZlbnRSZXN1bHQ7XG5cdFx0XHRcdGlmIChyZXN1bHQuYmxvY2spIHJldHVybiB7IGRvbmU6IHRydWUgfTtcblx0XHRcdH1cblx0XHRcdHJldHVybiB7IGRvbmU6IGZhbHNlIH07XG5cdFx0fSk7XG5cblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG5cblx0YXN5bmMgZW1pdEJhc2hUcmFuc2Zvcm0oY29tbWFuZDogc3RyaW5nLCBjd2Q6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG5cdFx0aWYgKCF0aGlzLmhhc0hhbmRsZXJzKFwiYmFzaF90cmFuc2Zvcm1cIikpIHJldHVybiBjb21tYW5kO1xuXG5cdFx0bGV0IGN1cnJlbnQgPSBjb21tYW5kO1xuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXG5cdFx0XHRcImJhc2hfdHJhbnNmb3JtXCIsXG5cdFx0XHQoKSA9PiAoeyB0eXBlOiBcImJhc2hfdHJhbnNmb3JtXCIgYXMgY29uc3QsIGNvbW1hbmQ6IGN1cnJlbnQsIGN3ZCB9KSxcblx0XHRcdChoYW5kbGVyUmVzdWx0KSA9PiB7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGhhbmRsZXJSZXN1bHQgYXMgaW1wb3J0KFwiLi90eXBlcy5qc1wiKS5CYXNoVHJhbnNmb3JtRXZlbnRSZXN1bHQgfCB1bmRlZmluZWQ7XG5cdFx0XHRcdGlmIChyZXN1bHQ/LmNvbW1hbmQgJiYgcmVzdWx0LmNvbW1hbmQudHJpbSgpKSB7XG5cdFx0XHRcdFx0Y3VycmVudCA9IHJlc3VsdC5jb21tYW5kO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB7IGRvbmU6IGZhbHNlIH07IC8vIGNoYWluIGFsbCBoYW5kbGVyc1xuXHRcdFx0fSxcblx0XHQpO1xuXHRcdHJldHVybiBjdXJyZW50O1xuXHR9XG5cblx0YXN5bmMgZW1pdFVzZXJCYXNoKGV2ZW50OiBVc2VyQmFzaEV2ZW50KTogUHJvbWlzZTxVc2VyQmFzaEV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkPiB7XG5cdFx0bGV0IHJlc3VsdDogVXNlckJhc2hFdmVudFJlc3VsdCB8IHVuZGVmaW5lZDtcblxuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXCJ1c2VyX2Jhc2hcIiwgKCkgPT4gZXZlbnQsIChoYW5kbGVyUmVzdWx0KSA9PiB7XG5cdFx0XHRpZiAoaGFuZGxlclJlc3VsdCkge1xuXHRcdFx0XHRyZXN1bHQgPSBoYW5kbGVyUmVzdWx0IGFzIFVzZXJCYXNoRXZlbnRSZXN1bHQ7XG5cdFx0XHRcdHJldHVybiB7IGRvbmU6IHRydWUgfTtcblx0XHRcdH1cblx0XHRcdHJldHVybiB7IGRvbmU6IGZhbHNlIH07XG5cdFx0fSk7XG5cblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG5cblx0YXN5bmMgZW1pdENvbnRleHQobWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdKTogUHJvbWlzZTxBZ2VudE1lc3NhZ2VbXT4ge1xuXHRcdGxldCBjdXJyZW50TWVzc2FnZXMgPSBzdHJ1Y3R1cmVkQ2xvbmUobWVzc2FnZXMpO1xuXG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhcImNvbnRleHRcIiwgKCkgPT4gKHsgdHlwZTogXCJjb250ZXh0XCIsIG1lc3NhZ2VzOiBjdXJyZW50TWVzc2FnZXMgfSBzYXRpc2ZpZXMgQ29udGV4dEV2ZW50KSwgKGhhbmRsZXJSZXN1bHQpID0+IHtcblx0XHRcdGlmIChoYW5kbGVyUmVzdWx0ICYmIChoYW5kbGVyUmVzdWx0IGFzIENvbnRleHRFdmVudFJlc3VsdCkubWVzc2FnZXMpIHtcblx0XHRcdFx0Y3VycmVudE1lc3NhZ2VzID0gKGhhbmRsZXJSZXN1bHQgYXMgQ29udGV4dEV2ZW50UmVzdWx0KS5tZXNzYWdlcyE7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4geyBkb25lOiBmYWxzZSB9O1xuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIGN1cnJlbnRNZXNzYWdlcztcblx0fVxuXG5cdGFzeW5jIGVtaXRCZWZvcmVQcm92aWRlclJlcXVlc3QoXG5cdFx0cGF5bG9hZDogdW5rbm93bixcblx0XHRtb2RlbD86IHsgcHJvdmlkZXI6IHN0cmluZzsgaWQ6IHN0cmluZzsgYXBpPzogc3RyaW5nIH0sXG5cdCk6IFByb21pc2U8dW5rbm93bj4ge1xuXHRcdGxldCBjdXJyZW50UGF5bG9hZCA9IHBheWxvYWQ7XG5cblx0XHRhd2FpdCB0aGlzLmludm9rZUhhbmRsZXJzKFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIiwgKCkgPT4gKHtcblx0XHRcdHR5cGU6IFwiYmVmb3JlX3Byb3ZpZGVyX3JlcXVlc3RcIixcblx0XHRcdHBheWxvYWQ6IGN1cnJlbnRQYXlsb2FkLFxuXHRcdFx0bW9kZWwsXG5cdFx0fSBzYXRpc2ZpZXMgQmVmb3JlUHJvdmlkZXJSZXF1ZXN0RXZlbnQpLCAoaGFuZGxlclJlc3VsdCkgPT4ge1xuXHRcdFx0aWYgKGhhbmRsZXJSZXN1bHQgIT09IHVuZGVmaW5lZCkgY3VycmVudFBheWxvYWQgPSBoYW5kbGVyUmVzdWx0O1xuXHRcdFx0cmV0dXJuIHsgZG9uZTogZmFsc2UgfTtcblx0XHR9KTtcblxuXHRcdHJldHVybiBjdXJyZW50UGF5bG9hZDtcblx0fVxuXG5cdGFzeW5jIGVtaXRCZWZvcmVNb2RlbFNlbGVjdChldmVudDogT21pdDxCZWZvcmVNb2RlbFNlbGVjdEV2ZW50LCBcInR5cGVcIj4pOiBQcm9taXNlPEJlZm9yZU1vZGVsU2VsZWN0UmVzdWx0IHwgdW5kZWZpbmVkPiB7XG5cdFx0bGV0IHJlc3VsdDogQmVmb3JlTW9kZWxTZWxlY3RSZXN1bHQgfCB1bmRlZmluZWQ7XG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhcImJlZm9yZV9tb2RlbF9zZWxlY3RcIiwgKCkgPT4gKHtcblx0XHRcdHR5cGU6IFwiYmVmb3JlX21vZGVsX3NlbGVjdFwiIGFzIGNvbnN0LFxuXHRcdFx0Li4uZXZlbnQsXG5cdFx0fSBzYXRpc2ZpZXMgQmVmb3JlTW9kZWxTZWxlY3RFdmVudCksIChoYW5kbGVyUmVzdWx0KSA9PiB7XG5cdFx0XHRpZiAoaGFuZGxlclJlc3VsdCkge1xuXHRcdFx0XHRyZXN1bHQgPSBoYW5kbGVyUmVzdWx0IGFzIEJlZm9yZU1vZGVsU2VsZWN0UmVzdWx0O1xuXHRcdFx0XHRyZXR1cm4geyBkb25lOiB0cnVlIH07IC8vIGZpcnN0IG92ZXJyaWRlIHdpbnNcblx0XHRcdH1cblx0XHRcdHJldHVybiB7IGRvbmU6IGZhbHNlIH07XG5cdFx0fSk7XG5cdFx0cmV0dXJuIHJlc3VsdDtcblx0fVxuXG5cdGFzeW5jIGVtaXRBZGp1c3RUb29sU2V0KGV2ZW50OiBPbWl0PEFkanVzdFRvb2xTZXRFdmVudCwgXCJ0eXBlXCI+KTogUHJvbWlzZTxBZGp1c3RUb29sU2V0UmVzdWx0IHwgdW5kZWZpbmVkPiB7XG5cdFx0bGV0IHJlc3VsdDogQWRqdXN0VG9vbFNldFJlc3VsdCB8IHVuZGVmaW5lZDtcblx0XHRhd2FpdCB0aGlzLmludm9rZUhhbmRsZXJzKFwiYWRqdXN0X3Rvb2xfc2V0XCIsICgpID0+ICh7XG5cdFx0XHR0eXBlOiBcImFkanVzdF90b29sX3NldFwiIGFzIGNvbnN0LFxuXHRcdFx0Li4uZXZlbnQsXG5cdFx0fSBzYXRpc2ZpZXMgQWRqdXN0VG9vbFNldEV2ZW50KSwgKGhhbmRsZXJSZXN1bHQpID0+IHtcblx0XHRcdGlmIChoYW5kbGVyUmVzdWx0KSB7XG5cdFx0XHRcdHJlc3VsdCA9IGhhbmRsZXJSZXN1bHQgYXMgQWRqdXN0VG9vbFNldFJlc3VsdDtcblx0XHRcdFx0cmV0dXJuIHsgZG9uZTogdHJ1ZSB9OyAvLyBmaXJzdCBvdmVycmlkZSB3aW5zXG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4geyBkb25lOiBmYWxzZSB9O1xuXHRcdH0pO1xuXHRcdHJldHVybiByZXN1bHQ7XG5cdH1cblxuXHRhc3luYyBlbWl0QmVmb3JlQWdlbnRTdGFydChcblx0XHRwcm9tcHQ6IHN0cmluZyxcblx0XHRpbWFnZXM6IEltYWdlQ29udGVudFtdIHwgdW5kZWZpbmVkLFxuXHRcdHN5c3RlbVByb21wdDogc3RyaW5nLFxuXHQpOiBQcm9taXNlPEJlZm9yZUFnZW50U3RhcnRDb21iaW5lZFJlc3VsdCB8IHVuZGVmaW5lZD4ge1xuXHRcdGNvbnN0IG1lc3NhZ2VzOiBOb25OdWxsYWJsZTxCZWZvcmVBZ2VudFN0YXJ0RXZlbnRSZXN1bHRbXCJtZXNzYWdlXCJdPltdID0gW107XG5cdFx0bGV0IGN1cnJlbnRTeXN0ZW1Qcm9tcHQgPSBzeXN0ZW1Qcm9tcHQ7XG5cdFx0bGV0IHN5c3RlbVByb21wdE1vZGlmaWVkID0gZmFsc2U7XG5cblx0XHRhd2FpdCB0aGlzLmludm9rZUhhbmRsZXJzKFwiYmVmb3JlX2FnZW50X3N0YXJ0XCIsICgpID0+ICh7XG5cdFx0XHR0eXBlOiBcImJlZm9yZV9hZ2VudF9zdGFydFwiLFxuXHRcdFx0cHJvbXB0LFxuXHRcdFx0aW1hZ2VzLFxuXHRcdFx0c3lzdGVtUHJvbXB0OiBjdXJyZW50U3lzdGVtUHJvbXB0LFxuXHRcdH0gc2F0aXNmaWVzIEJlZm9yZUFnZW50U3RhcnRFdmVudCksIChoYW5kbGVyUmVzdWx0KSA9PiB7XG5cdFx0XHRpZiAoaGFuZGxlclJlc3VsdCkge1xuXHRcdFx0XHRjb25zdCByID0gaGFuZGxlclJlc3VsdCBhcyBCZWZvcmVBZ2VudFN0YXJ0RXZlbnRSZXN1bHQ7XG5cdFx0XHRcdGlmIChyLm1lc3NhZ2UpIG1lc3NhZ2VzLnB1c2goci5tZXNzYWdlKTtcblx0XHRcdFx0aWYgKHIuc3lzdGVtUHJvbXB0ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRjdXJyZW50U3lzdGVtUHJvbXB0ID0gci5zeXN0ZW1Qcm9tcHQ7XG5cdFx0XHRcdFx0c3lzdGVtUHJvbXB0TW9kaWZpZWQgPSB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4geyBkb25lOiBmYWxzZSB9O1xuXHRcdH0pO1xuXG5cdFx0aWYgKG1lc3NhZ2VzLmxlbmd0aCA+IDAgfHwgc3lzdGVtUHJvbXB0TW9kaWZpZWQpIHtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdG1lc3NhZ2VzOiBtZXNzYWdlcy5sZW5ndGggPiAwID8gbWVzc2FnZXMgOiB1bmRlZmluZWQsXG5cdFx0XHRcdHN5c3RlbVByb21wdDogc3lzdGVtUHJvbXB0TW9kaWZpZWQgPyBjdXJyZW50U3lzdGVtUHJvbXB0IDogdW5kZWZpbmVkLFxuXHRcdFx0fTtcblx0XHR9XG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxuXG5cdGFzeW5jIGVtaXRSZXNvdXJjZXNEaXNjb3Zlcihcblx0XHRjd2Q6IHN0cmluZyxcblx0XHRyZWFzb246IFJlc291cmNlc0Rpc2NvdmVyRXZlbnRbXCJyZWFzb25cIl0sXG5cdCk6IFByb21pc2U8e1xuXHRcdHNraWxsUGF0aHM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBleHRlbnNpb25QYXRoOiBzdHJpbmcgfT47XG5cdFx0cHJvbXB0UGF0aHM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBleHRlbnNpb25QYXRoOiBzdHJpbmcgfT47XG5cdFx0dGhlbWVQYXRoczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGV4dGVuc2lvblBhdGg6IHN0cmluZyB9Pjtcblx0fT4ge1xuXHRcdGNvbnN0IHNraWxsUGF0aHM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBleHRlbnNpb25QYXRoOiBzdHJpbmcgfT4gPSBbXTtcblx0XHRjb25zdCBwcm9tcHRQYXRoczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGV4dGVuc2lvblBhdGg6IHN0cmluZyB9PiA9IFtdO1xuXHRcdGNvbnN0IHRoZW1lUGF0aHM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBleHRlbnNpb25QYXRoOiBzdHJpbmcgfT4gPSBbXTtcblxuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXCJyZXNvdXJjZXNfZGlzY292ZXJcIiwgKCkgPT4gKHtcblx0XHRcdHR5cGU6IFwicmVzb3VyY2VzX2Rpc2NvdmVyXCIsXG5cdFx0XHRjd2QsXG5cdFx0XHRyZWFzb24sXG5cdFx0fSBzYXRpc2ZpZXMgUmVzb3VyY2VzRGlzY292ZXJFdmVudCksIChoYW5kbGVyUmVzdWx0LCBleHRlbnNpb25QYXRoKSA9PiB7XG5cdFx0XHRjb25zdCByID0gaGFuZGxlclJlc3VsdCBhcyBSZXNvdXJjZXNEaXNjb3ZlclJlc3VsdCB8IHVuZGVmaW5lZDtcblx0XHRcdGlmIChyPy5za2lsbFBhdGhzPy5sZW5ndGgpIHNraWxsUGF0aHMucHVzaCguLi5yLnNraWxsUGF0aHMubWFwKChwYXRoKSA9PiAoeyBwYXRoLCBleHRlbnNpb25QYXRoIH0pKSk7XG5cdFx0XHRpZiAocj8ucHJvbXB0UGF0aHM/Lmxlbmd0aCkgcHJvbXB0UGF0aHMucHVzaCguLi5yLnByb21wdFBhdGhzLm1hcCgocGF0aCkgPT4gKHsgcGF0aCwgZXh0ZW5zaW9uUGF0aCB9KSkpO1xuXHRcdFx0aWYgKHI/LnRoZW1lUGF0aHM/Lmxlbmd0aCkgdGhlbWVQYXRocy5wdXNoKC4uLnIudGhlbWVQYXRocy5tYXAoKHBhdGgpID0+ICh7IHBhdGgsIGV4dGVuc2lvblBhdGggfSkpKTtcblx0XHRcdHJldHVybiB7IGRvbmU6IGZhbHNlIH07XG5cdFx0fSk7XG5cblx0XHRyZXR1cm4geyBza2lsbFBhdGhzLCBwcm9tcHRQYXRocywgdGhlbWVQYXRocyB9O1xuXHR9XG5cblx0LyoqIEVtaXQgaW5wdXQgZXZlbnQuIFRyYW5zZm9ybXMgY2hhaW4sIFwiaGFuZGxlZFwiIHNob3J0LWNpcmN1aXRzLiAqL1xuXHRhc3luYyBlbWl0SW5wdXQodGV4dDogc3RyaW5nLCBpbWFnZXM6IEltYWdlQ29udGVudFtdIHwgdW5kZWZpbmVkLCBzb3VyY2U6IElucHV0U291cmNlKTogUHJvbWlzZTxJbnB1dEV2ZW50UmVzdWx0PiB7XG5cdFx0bGV0IGN1cnJlbnRUZXh0ID0gdGV4dDtcblx0XHRsZXQgY3VycmVudEltYWdlcyA9IGltYWdlcztcblx0XHRsZXQgaGFuZGxlZDogSW5wdXRFdmVudFJlc3VsdCB8IHVuZGVmaW5lZDtcblxuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXCJpbnB1dFwiLCAoKSA9PiAoe1xuXHRcdFx0dHlwZTogXCJpbnB1dFwiLFxuXHRcdFx0dGV4dDogY3VycmVudFRleHQsXG5cdFx0XHRpbWFnZXM6IGN1cnJlbnRJbWFnZXMsXG5cdFx0XHRzb3VyY2UsXG5cdFx0fSBzYXRpc2ZpZXMgSW5wdXRFdmVudCksIChoYW5kbGVyUmVzdWx0KSA9PiB7XG5cdFx0XHRjb25zdCByID0gaGFuZGxlclJlc3VsdCBhcyBJbnB1dEV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkO1xuXHRcdFx0aWYgKHI/LmFjdGlvbiA9PT0gXCJoYW5kbGVkXCIpIHtcblx0XHRcdFx0aGFuZGxlZCA9IHI7XG5cdFx0XHRcdHJldHVybiB7IGRvbmU6IHRydWUgfTtcblx0XHRcdH1cblx0XHRcdGlmIChyPy5hY3Rpb24gPT09IFwidHJhbnNmb3JtXCIpIHtcblx0XHRcdFx0Y3VycmVudFRleHQgPSByLnRleHQ7XG5cdFx0XHRcdGN1cnJlbnRJbWFnZXMgPSByLmltYWdlcyA/PyBjdXJyZW50SW1hZ2VzO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHsgZG9uZTogZmFsc2UgfTtcblx0XHR9KTtcblxuXHRcdGlmIChoYW5kbGVkKSByZXR1cm4gaGFuZGxlZDtcblx0XHRyZXR1cm4gY3VycmVudFRleHQgIT09IHRleHQgfHwgY3VycmVudEltYWdlcyAhPT0gaW1hZ2VzXG5cdFx0XHQ/IHsgYWN0aW9uOiBcInRyYW5zZm9ybVwiLCB0ZXh0OiBjdXJyZW50VGV4dCwgaW1hZ2VzOiBjdXJyZW50SW1hZ2VzIH1cblx0XHRcdDogeyBhY3Rpb246IFwiY29udGludWVcIiB9O1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBMYXllciAyIGV2ZW50IGVtaXR0ZXJzIChub3RpZmljYXRpb24sIHN0b3AsIHNlc3Npb25fZW5kLCBnaXQsIHZlcmlmeSxcblx0Ly8gYnVkZ2V0LCBtaWxlc3RvbmUgLyB1bml0KS4gRmlyZS1hbmQtb2JzZXJ2ZSBleGNlcHQgd2hlcmUgYSBoYW5kbGVyIHJlc3VsdFxuXHQvLyBjYW4gdmV0byBvciByZXdyaXRlIHRoZSBwZW5kaW5nIGFjdGlvbi5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdGFzeW5jIGVtaXRTdG9wKGV2ZW50OiBPbWl0PFN0b3BFdmVudCwgXCJ0eXBlXCI+KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhcblx0XHRcdFwic3RvcFwiLFxuXHRcdFx0KCkgPT4gKHsgdHlwZTogXCJzdG9wXCIgYXMgY29uc3QsIC4uLmV2ZW50IH0gc2F0aXNmaWVzIFN0b3BFdmVudCksXG5cdFx0XHQoKSA9PiAoeyBkb25lOiBmYWxzZSB9KSxcblx0XHQpO1xuXHR9XG5cblx0YXN5bmMgZW1pdE5vdGlmaWNhdGlvbihldmVudDogT21pdDxOb3RpZmljYXRpb25FdmVudCwgXCJ0eXBlXCI+KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhcblx0XHRcdFwibm90aWZpY2F0aW9uXCIsXG5cdFx0XHQoKSA9PiAoeyB0eXBlOiBcIm5vdGlmaWNhdGlvblwiIGFzIGNvbnN0LCAuLi5ldmVudCB9IHNhdGlzZmllcyBOb3RpZmljYXRpb25FdmVudCksXG5cdFx0XHQoKSA9PiAoeyBkb25lOiBmYWxzZSB9KSxcblx0XHQpO1xuXHR9XG5cblx0YXN5bmMgZW1pdFNlc3Npb25FbmQoZXZlbnQ6IE9taXQ8U2Vzc2lvbkVuZEV2ZW50LCBcInR5cGVcIj4pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLmludm9rZUhhbmRsZXJzKFxuXHRcdFx0XCJzZXNzaW9uX2VuZFwiLFxuXHRcdFx0KCkgPT4gKHsgdHlwZTogXCJzZXNzaW9uX2VuZFwiIGFzIGNvbnN0LCAuLi5ldmVudCB9IHNhdGlzZmllcyBTZXNzaW9uRW5kRXZlbnQpLFxuXHRcdFx0KCkgPT4gKHsgZG9uZTogZmFsc2UgfSksXG5cdFx0KTtcblx0fVxuXG5cdGFzeW5jIGVtaXRCZWZvcmVDb21taXQoXG5cdFx0ZXZlbnQ6IE9taXQ8QmVmb3JlQ29tbWl0RXZlbnQsIFwidHlwZVwiPixcblx0KTogUHJvbWlzZTxCZWZvcmVDb21taXRFdmVudFJlc3VsdCB8IHVuZGVmaW5lZD4ge1xuXHRcdGxldCByZXN1bHQ6IEJlZm9yZUNvbW1pdEV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkO1xuXHRcdGxldCBtZXNzYWdlID0gZXZlbnQubWVzc2FnZTtcblx0XHRhd2FpdCB0aGlzLmludm9rZUhhbmRsZXJzKFxuXHRcdFx0XCJiZWZvcmVfY29tbWl0XCIsXG5cdFx0XHQoKSA9PiAoeyB0eXBlOiBcImJlZm9yZV9jb21taXRcIiBhcyBjb25zdCwgLi4uZXZlbnQsIG1lc3NhZ2UgfSBzYXRpc2ZpZXMgQmVmb3JlQ29tbWl0RXZlbnQpLFxuXHRcdFx0KGhhbmRsZXJSZXN1bHQpID0+IHtcblx0XHRcdFx0Y29uc3QgciA9IGhhbmRsZXJSZXN1bHQgYXMgQmVmb3JlQ29tbWl0RXZlbnRSZXN1bHQgfCB1bmRlZmluZWQ7XG5cdFx0XHRcdGlmICghcikgcmV0dXJuIHsgZG9uZTogZmFsc2UgfTtcblx0XHRcdFx0aWYgKHIuY2FuY2VsKSB7XG5cdFx0XHRcdFx0cmVzdWx0ID0geyBjYW5jZWw6IHRydWUsIHJlYXNvbjogci5yZWFzb24gfTtcblx0XHRcdFx0XHRyZXR1cm4geyBkb25lOiB0cnVlIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKHIubWVzc2FnZSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0bWVzc2FnZSA9IHIubWVzc2FnZTtcblx0XHRcdFx0XHRyZXN1bHQgPSB7IC4uLihyZXN1bHQgPz8ge30pLCBtZXNzYWdlIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHsgZG9uZTogZmFsc2UgfTtcblx0XHRcdH0sXG5cdFx0KTtcblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG5cblx0YXN5bmMgZW1pdENvbW1pdChldmVudDogT21pdDxDb21taXRFdmVudCwgXCJ0eXBlXCI+KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhcblx0XHRcdFwiY29tbWl0XCIsXG5cdFx0XHQoKSA9PiAoeyB0eXBlOiBcImNvbW1pdFwiIGFzIGNvbnN0LCAuLi5ldmVudCB9IHNhdGlzZmllcyBDb21taXRFdmVudCksXG5cdFx0XHQoKSA9PiAoeyBkb25lOiBmYWxzZSB9KSxcblx0XHQpO1xuXHR9XG5cblx0YXN5bmMgZW1pdEJlZm9yZVB1c2goXG5cdFx0ZXZlbnQ6IE9taXQ8QmVmb3JlUHVzaEV2ZW50LCBcInR5cGVcIj4sXG5cdCk6IFByb21pc2U8QmVmb3JlUHVzaEV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkPiB7XG5cdFx0bGV0IHJlc3VsdDogQmVmb3JlUHVzaEV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkO1xuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXG5cdFx0XHRcImJlZm9yZV9wdXNoXCIsXG5cdFx0XHQoKSA9PiAoeyB0eXBlOiBcImJlZm9yZV9wdXNoXCIgYXMgY29uc3QsIC4uLmV2ZW50IH0gc2F0aXNmaWVzIEJlZm9yZVB1c2hFdmVudCksXG5cdFx0XHQoaGFuZGxlclJlc3VsdCkgPT4ge1xuXHRcdFx0XHRjb25zdCByID0gaGFuZGxlclJlc3VsdCBhcyBCZWZvcmVQdXNoRXZlbnRSZXN1bHQgfCB1bmRlZmluZWQ7XG5cdFx0XHRcdGlmIChyPy5jYW5jZWwpIHtcblx0XHRcdFx0XHRyZXN1bHQgPSByO1xuXHRcdFx0XHRcdHJldHVybiB7IGRvbmU6IHRydWUgfTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4geyBkb25lOiBmYWxzZSB9O1xuXHRcdFx0fSxcblx0XHQpO1xuXHRcdHJldHVybiByZXN1bHQ7XG5cdH1cblxuXHRhc3luYyBlbWl0UHVzaChldmVudDogT21pdDxQdXNoRXZlbnQsIFwidHlwZVwiPik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXG5cdFx0XHRcInB1c2hcIixcblx0XHRcdCgpID0+ICh7IHR5cGU6IFwicHVzaFwiIGFzIGNvbnN0LCAuLi5ldmVudCB9IHNhdGlzZmllcyBQdXNoRXZlbnQpLFxuXHRcdFx0KCkgPT4gKHsgZG9uZTogZmFsc2UgfSksXG5cdFx0KTtcblx0fVxuXG5cdGFzeW5jIGVtaXRCZWZvcmVQcihcblx0XHRldmVudDogT21pdDxCZWZvcmVQckV2ZW50LCBcInR5cGVcIj4sXG5cdCk6IFByb21pc2U8QmVmb3JlUHJFdmVudFJlc3VsdCB8IHVuZGVmaW5lZD4ge1xuXHRcdGxldCByZXN1bHQ6IEJlZm9yZVByRXZlbnRSZXN1bHQgfCB1bmRlZmluZWQ7XG5cdFx0bGV0IHRpdGxlID0gZXZlbnQudGl0bGU7XG5cdFx0bGV0IGJvZHkgPSBldmVudC5ib2R5O1xuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXG5cdFx0XHRcImJlZm9yZV9wclwiLFxuXHRcdFx0KCkgPT4gKHsgdHlwZTogXCJiZWZvcmVfcHJcIiBhcyBjb25zdCwgLi4uZXZlbnQsIHRpdGxlLCBib2R5IH0gc2F0aXNmaWVzIEJlZm9yZVByRXZlbnQpLFxuXHRcdFx0KGhhbmRsZXJSZXN1bHQpID0+IHtcblx0XHRcdFx0Y29uc3QgciA9IGhhbmRsZXJSZXN1bHQgYXMgQmVmb3JlUHJFdmVudFJlc3VsdCB8IHVuZGVmaW5lZDtcblx0XHRcdFx0aWYgKCFyKSByZXR1cm4geyBkb25lOiBmYWxzZSB9O1xuXHRcdFx0XHRpZiAoci5jYW5jZWwpIHtcblx0XHRcdFx0XHRyZXN1bHQgPSB7IGNhbmNlbDogdHJ1ZSwgcmVhc29uOiByLnJlYXNvbiB9O1xuXHRcdFx0XHRcdHJldHVybiB7IGRvbmU6IHRydWUgfTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoci50aXRsZSAhPT0gdW5kZWZpbmVkKSB0aXRsZSA9IHIudGl0bGU7XG5cdFx0XHRcdGlmIChyLmJvZHkgIT09IHVuZGVmaW5lZCkgYm9keSA9IHIuYm9keTtcblx0XHRcdFx0aWYgKHIudGl0bGUgIT09IHVuZGVmaW5lZCB8fCByLmJvZHkgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdHJlc3VsdCA9IHsgLi4uKHJlc3VsdCA/PyB7fSksIHRpdGxlLCBib2R5IH07XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHsgZG9uZTogZmFsc2UgfTtcblx0XHRcdH0sXG5cdFx0KTtcblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG5cblx0YXN5bmMgZW1pdFByT3BlbmVkKGV2ZW50OiBPbWl0PFByT3BlbmVkRXZlbnQsIFwidHlwZVwiPik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXG5cdFx0XHRcInByX29wZW5lZFwiLFxuXHRcdFx0KCkgPT4gKHsgdHlwZTogXCJwcl9vcGVuZWRcIiBhcyBjb25zdCwgLi4uZXZlbnQgfSBzYXRpc2ZpZXMgUHJPcGVuZWRFdmVudCksXG5cdFx0XHQoKSA9PiAoeyBkb25lOiBmYWxzZSB9KSxcblx0XHQpO1xuXHR9XG5cblx0YXN5bmMgZW1pdEJlZm9yZVZlcmlmeShcblx0XHRldmVudDogT21pdDxCZWZvcmVWZXJpZnlFdmVudCwgXCJ0eXBlXCI+LFxuXHQpOiBQcm9taXNlPEJlZm9yZVZlcmlmeUV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkPiB7XG5cdFx0bGV0IHJlc3VsdDogQmVmb3JlVmVyaWZ5RXZlbnRSZXN1bHQgfCB1bmRlZmluZWQ7XG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhcblx0XHRcdFwiYmVmb3JlX3ZlcmlmeVwiLFxuXHRcdFx0KCkgPT4gKHsgdHlwZTogXCJiZWZvcmVfdmVyaWZ5XCIgYXMgY29uc3QsIC4uLmV2ZW50IH0gc2F0aXNmaWVzIEJlZm9yZVZlcmlmeUV2ZW50KSxcblx0XHRcdChoYW5kbGVyUmVzdWx0KSA9PiB7XG5cdFx0XHRcdGNvbnN0IHIgPSBoYW5kbGVyUmVzdWx0IGFzIEJlZm9yZVZlcmlmeUV2ZW50UmVzdWx0IHwgdW5kZWZpbmVkO1xuXHRcdFx0XHRpZiAocj8uY2FuY2VsKSB7XG5cdFx0XHRcdFx0cmVzdWx0ID0gcjtcblx0XHRcdFx0XHRyZXR1cm4geyBkb25lOiB0cnVlIH07XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHsgZG9uZTogZmFsc2UgfTtcblx0XHRcdH0sXG5cdFx0KTtcblx0XHRyZXR1cm4gcmVzdWx0O1xuXHR9XG5cblx0YXN5bmMgZW1pdFZlcmlmeVJlc3VsdChldmVudDogT21pdDxWZXJpZnlSZXN1bHRFdmVudCwgXCJ0eXBlXCI+KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhcblx0XHRcdFwidmVyaWZ5X3Jlc3VsdFwiLFxuXHRcdFx0KCkgPT4gKHsgdHlwZTogXCJ2ZXJpZnlfcmVzdWx0XCIgYXMgY29uc3QsIC4uLmV2ZW50IH0gc2F0aXNmaWVzIFZlcmlmeVJlc3VsdEV2ZW50KSxcblx0XHRcdCgpID0+ICh7IGRvbmU6IGZhbHNlIH0pLFxuXHRcdCk7XG5cdH1cblxuXHRhc3luYyBlbWl0QnVkZ2V0VGhyZXNob2xkKFxuXHRcdGV2ZW50OiBPbWl0PEJ1ZGdldFRocmVzaG9sZEV2ZW50LCBcInR5cGVcIj4sXG5cdCk6IFByb21pc2U8QnVkZ2V0VGhyZXNob2xkRXZlbnRSZXN1bHQgfCB1bmRlZmluZWQ+IHtcblx0XHRsZXQgcmVzdWx0OiBCdWRnZXRUaHJlc2hvbGRFdmVudFJlc3VsdCB8IHVuZGVmaW5lZDtcblx0XHRhd2FpdCB0aGlzLmludm9rZUhhbmRsZXJzKFxuXHRcdFx0XCJidWRnZXRfdGhyZXNob2xkXCIsXG5cdFx0XHQoKSA9PiAoeyB0eXBlOiBcImJ1ZGdldF90aHJlc2hvbGRcIiBhcyBjb25zdCwgLi4uZXZlbnQgfSBzYXRpc2ZpZXMgQnVkZ2V0VGhyZXNob2xkRXZlbnQpLFxuXHRcdFx0KGhhbmRsZXJSZXN1bHQpID0+IHtcblx0XHRcdFx0Y29uc3QgciA9IGhhbmRsZXJSZXN1bHQgYXMgQnVkZ2V0VGhyZXNob2xkRXZlbnRSZXN1bHQgfCB1bmRlZmluZWQ7XG5cdFx0XHRcdGlmIChyPy5hY3Rpb24pIHtcblx0XHRcdFx0XHRyZXN1bHQgPSByO1xuXHRcdFx0XHRcdHJldHVybiB7IGRvbmU6IHRydWUgfTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4geyBkb25lOiBmYWxzZSB9O1xuXHRcdFx0fSxcblx0XHQpO1xuXHRcdHJldHVybiByZXN1bHQ7XG5cdH1cblxuXHRhc3luYyBlbWl0TWlsZXN0b25lU3RhcnQoZXZlbnQ6IE9taXQ8TWlsZXN0b25lU3RhcnRFdmVudCwgXCJ0eXBlXCI+KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5pbnZva2VIYW5kbGVycyhcblx0XHRcdFwibWlsZXN0b25lX3N0YXJ0XCIsXG5cdFx0XHQoKSA9PiAoeyB0eXBlOiBcIm1pbGVzdG9uZV9zdGFydFwiIGFzIGNvbnN0LCAuLi5ldmVudCB9IHNhdGlzZmllcyBNaWxlc3RvbmVTdGFydEV2ZW50KSxcblx0XHRcdCgpID0+ICh7IGRvbmU6IGZhbHNlIH0pLFxuXHRcdCk7XG5cdH1cblxuXHRhc3luYyBlbWl0TWlsZXN0b25lRW5kKGV2ZW50OiBPbWl0PE1pbGVzdG9uZUVuZEV2ZW50LCBcInR5cGVcIj4pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLmludm9rZUhhbmRsZXJzKFxuXHRcdFx0XCJtaWxlc3RvbmVfZW5kXCIsXG5cdFx0XHQoKSA9PiAoeyB0eXBlOiBcIm1pbGVzdG9uZV9lbmRcIiBhcyBjb25zdCwgLi4uZXZlbnQgfSBzYXRpc2ZpZXMgTWlsZXN0b25lRW5kRXZlbnQpLFxuXHRcdFx0KCkgPT4gKHsgZG9uZTogZmFsc2UgfSksXG5cdFx0KTtcblx0fVxuXG5cdGFzeW5jIGVtaXRVbml0U3RhcnQoZXZlbnQ6IE9taXQ8VW5pdFN0YXJ0RXZlbnQsIFwidHlwZVwiPik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuaW52b2tlSGFuZGxlcnMoXG5cdFx0XHRcInVuaXRfc3RhcnRcIixcblx0XHRcdCgpID0+ICh7IHR5cGU6IFwidW5pdF9zdGFydFwiIGFzIGNvbnN0LCAuLi5ldmVudCB9IHNhdGlzZmllcyBVbml0U3RhcnRFdmVudCksXG5cdFx0XHQoKSA9PiAoeyBkb25lOiBmYWxzZSB9KSxcblx0XHQpO1xuXHR9XG5cblx0YXN5bmMgZW1pdFVuaXRFbmQoZXZlbnQ6IE9taXQ8VW5pdEVuZEV2ZW50LCBcInR5cGVcIj4pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLmludm9rZUhhbmRsZXJzKFxuXHRcdFx0XCJ1bml0X2VuZFwiLFxuXHRcdFx0KCkgPT4gKHsgdHlwZTogXCJ1bml0X2VuZFwiIGFzIGNvbnN0LCAuLi5ldmVudCB9IHNhdGlzZmllcyBVbml0RW5kRXZlbnQpLFxuXHRcdFx0KCkgPT4gKHsgZG9uZTogZmFsc2UgfSksXG5cdFx0KTtcblx0fVxufVxuXG4vKiogSGVscGVyIHJlLWV4cG9ydCBmb3IgY2FsbGVycyB3aXJpbmcgdmVyaWZpY2F0aW9uIGZhaWx1cmVzLiAqL1xuZXhwb3J0IHR5cGUgeyBWZXJpZnlGYWlsdXJlIH07XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFxQixhQUFhO0FBd0VsQyxNQUFNLDJDQUFxRTtBQUFBLEVBQzFFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNEO0FBSUEsTUFBTSwwQkFBMEIsQ0FBQyx5QkFBMEU7QUFDMUcsUUFBTSxxQkFBcUIsQ0FBQztBQUM1QixhQUFXLENBQUMsUUFBUSxJQUFJLEtBQUssT0FBTyxRQUFRLG9CQUFvQixHQUFHO0FBQ2xFLFVBQU0sWUFBWTtBQUNsQixVQUFNLFVBQVUsTUFBTSxRQUFRLElBQUksSUFBSSxPQUFPLENBQUMsSUFBSTtBQUNsRCxVQUFNLG1CQUFtQix5Q0FBeUMsU0FB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
