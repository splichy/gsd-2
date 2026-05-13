import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listDescendants } from "@gsd/native";
import {
  CombinedAutocompleteProvider,
  Container,
  fuzzyFilter,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TruncatedText,
  TUI,
  visibleWidth
} from "@gsd/pi-tui";
import { spawn, spawnSync } from "child_process";
import {
  APP_NAME,
  getAuthPath,
  getDebugLogPath,
  getUpdateInstruction,
  VERSION
} from "../../config.js";
import { parseSkillBlock } from "../../core/agent-session.js";
import { FooterDataProvider } from "../../core/footer-data-provider.js";
import { KeybindingsManager } from "../../core/keybindings.js";
import { createCompactionSummaryMessage } from "../../core/messages.js";
import { resolveModelScope } from "../../core/model-resolver.js";
import { SessionManager } from "../../core/session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.js";
import { readClipboardImage } from "../../utils/clipboard-image.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { AdaptiveLayoutComponent } from "./components/adaptive-layout.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { appKey, appKeyHint, keyHint, rawKeyHint } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { ModelSelectorComponent, providerDisplayName } from "./components/model-selector.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
import { ProviderManagerComponent } from "./components/provider-manager.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import { ContextualTips } from "../../core/contextual-tips.js";
import { getAppKeyDisplay } from "./slash-command-handlers.js";
import { handleAgentEvent } from "./controllers/chat-controller.js";
import { createExtensionUIContext as buildExtensionUIContext } from "./controllers/extension-ui-controller.js";
import { setupEditorSubmitHandler as setupEditorSubmitHandlerController } from "./controllers/input-controller.js";
import {
  findExactModelMatch as findExactModelMatchController,
  getModelCandidates as getModelCandidatesController,
  handleModelCommand as handleModelCommandController,
  updateAvailableProviderCount as updateAvailableProviderCountController
} from "./controllers/model-controller.js";
import {
  getAvailableThemes,
  getEditorTheme,
  getMarkdownTheme,
  initTheme,
  onThemeChange,
  stopThemeWatcher,
  setRegisteredThemes,
  setTheme,
  theme
} from "./theme/theme.js";
function isExpandable(obj) {
  return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}
function buildAssistantReplaySegments(contentBlocks) {
  const segments = [];
  let runStart = -1;
  for (let i = 0; i < contentBlocks.length; i++) {
    const block = contentBlocks[i];
    const isAssistantText = block?.type === "text" || block?.type === "thinking";
    const isTool = block?.type === "toolCall" || block?.type === "serverToolUse";
    if (isAssistantText) {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart !== -1) {
      segments.push({ kind: "assistant", startIndex: runStart, endIndex: i - 1 });
      runStart = -1;
    }
    if (isTool) {
      segments.push({ kind: "tool", contentIndex: i });
    }
  }
  if (runStart !== -1) {
    segments.push({ kind: "assistant", startIndex: runStart, endIndex: contentBlocks.length - 1 });
  }
  return segments;
}
function shouldRenderExtensionNotifyInChat(type) {
  return type !== "warning";
}
function renderExtensionNotifyInChat(chatContainer, message, type) {
  if (!shouldRenderExtensionNotifyInChat(type)) {
    return { rendered: false };
  }
  const spacer = new Spacer(1);
  chatContainer.addChild(spacer);
  if (type === "error") {
    chatContainer.addChild(new Text(theme.fg("error", `Error: ${message}`), 1, 0));
    return { rendered: true };
  }
  if (type === "success") {
    chatContainer.addChild(new DynamicBorder((text) => theme.fg("success", text)));
    chatContainer.addChild(new Text(theme.fg("success", message), 1, 0));
    chatContainer.addChild(new DynamicBorder((text) => theme.fg("success", text)));
    chatContainer.addChild(new Spacer(1));
    return { rendered: true };
  }
  const statusText = new Text(theme.fg("dim", message), 1, 0);
  chatContainer.addChild(statusText);
  return { rendered: true, statusSpacer: spacer, statusText };
}
function renderBlockingErrorBanner(container, message) {
  container.clear();
  if (message === void 0) return;
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("error", `Error: ${message}`), 1, 0));
}
class InteractiveMode {
  constructor(session, options = {}) {
    this.options = options;
    this.isInitialized = false;
    this.loadingAnimation = void 0;
    this.pendingWorkingMessage = void 0;
    this.defaultWorkingMessage = "Working...";
    this.lastBlockingError = void 0;
    this.lastSigintTime = 0;
    this.lastEscapeTime = 0;
    this.changelogMarkdown = void 0;
    // Status line tracking (for mutating immediately-sequential status updates)
    this.lastStatusSpacer = void 0;
    this.lastStatusText = void 0;
    // Streaming message tracking
    this.streamingComponent = void 0;
    this.streamingMessage = void 0;
    // Tool execution tracking: toolCallId -> component
    this.pendingTools = /* @__PURE__ */ new Map();
    // Tool output expansion state
    this.toolOutputExpanded = false;
    // Pasted image tracking
    this.pendingImages = [];
    // Thinking block visibility state
    this.hideThinkingBlock = false;
    // Skill commands: command name -> skill file path
    this.skillCommands = /* @__PURE__ */ new Map();
    // Track if editor is in bash mode (text starts with !)
    this.isBashMode = false;
    // Contextual tips — session-scoped, non-intrusive hints
    this.contextualTips = new ContextualTips();
    // Track current bash execution component
    this.bashComponent = void 0;
    // Track pending bash components (shown in pending area, moved to chat on submit)
    this.pendingBashComponents = [];
    // Auto-compaction state
    this.autoCompactionLoader = void 0;
    // Auto-retry state
    this.retryLoader = void 0;
    // Messages queued while compaction is running
    this.compactionQueuedMessages = [];
    // Shutdown state
    this.shutdownRequested = false;
    // Extension UI state
    this.extensionSelector = void 0;
    this.extensionInput = void 0;
    this.extensionEditor = void 0;
    this.extensionTerminalInputUnsubscribers = /* @__PURE__ */ new Set();
    // Extension widgets (components rendered above/below the editor)
    this.extensionWidgetsAbove = /* @__PURE__ */ new Map();
    this.extensionWidgetsBelow = /* @__PURE__ */ new Map();
    // Custom footer from extension (undefined = use built-in footer)
    this.customFooter = void 0;
    // Built-in header (logo + keybinding hints + changelog)
    this.builtInHeader = void 0;
    // Custom header from extension (undefined = use built-in header)
    this.customHeader = void 0;
    /**
     * Gracefully shutdown the agent.
     * Emits shutdown event to extensions, then exits.
     */
    this.isShuttingDown = false;
    this.session = session;
    this.version = VERSION;
    this.ui = new TUI(options.terminal ?? new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
    this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
    this.headerContainer = new Container();
    this.chatContainer = new Container();
    this.pendingMessagesContainer = new Container();
    this.adaptiveLayout = new AdaptiveLayoutComponent(() => ({
      override: this.settingsManager.getAdaptiveMode(),
      activeToolCount: this.pendingTools.size,
      gsdPhase: this.pendingWorkingMessage,
      lastError: this.lastBlockingError,
      sessionName: this.sessionManager.getSessionName(),
      cwd: process.cwd()
    }));
    this.statusContainer = new Container();
    this.pinnedMessageContainer = new Container();
    this.blockingErrorContainer = new Container();
    this.widgetContainerAbove = new Container();
    this.widgetContainerBelow = new Container();
    this.keybindings = KeybindingsManager.create();
    const editorPaddingX = this.settingsManager.getEditorPaddingX();
    const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
    this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
      paddingX: editorPaddingX,
      autocompleteMaxVisible
    });
    this.editor = this.defaultEditor;
    this.editorContainer = new Container();
    this.editorContainer.addChild(this.editor);
    this.footerDataProvider = new FooterDataProvider();
    this.footer = new FooterComponent(session, this.footerDataProvider);
    this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
    this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
    setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
    initTheme(this.settingsManager.getTheme(), true);
  }
  static {
    // Cap rendered chat components to prevent unbounded memory/CPU growth.
    // Only render-components are removed — session transcript stays on disk.
    this.MAX_CHAT_COMPONENTS = 100;
  }
  // Convenience accessors
  get agent() {
    return this.session.agent;
  }
  get sessionManager() {
    return this.session.sessionManager;
  }
  get settingsManager() {
    return this.session.settingsManager;
  }
  setupAutocomplete() {
    const slashCommands = BUILTIN_SLASH_COMMANDS.map((command) => ({
      name: command.name,
      description: command.description
    }));
    const modelCommand = slashCommands.find((command) => command.name === "model");
    if (modelCommand) {
      modelCommand.getArgumentCompletions = (prefix) => {
        const models = this.session.scopedModels.length > 0 ? this.session.scopedModels.map((s) => s.model) : this.session.modelRegistry.getAvailable();
        if (models.length === 0) return null;
        const items = models.map((m) => ({
          id: m.id,
          provider: m.provider,
          label: `${m.provider}/${m.id}`
        }));
        const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);
        if (filtered.length === 0) return null;
        return filtered.map((item) => ({
          value: item.label,
          label: item.id,
          description: providerDisplayName(item.provider)
        }));
      };
    }
    const thinkingCommand = slashCommands.find((command) => command.name === "thinking");
    if (thinkingCommand) {
      thinkingCommand.getArgumentCompletions = (prefix) => {
        const levels = [
          { value: "off", label: "off", description: "Disable extended thinking" },
          { value: "minimal", label: "minimal", description: "Minimal thinking budget" },
          { value: "low", label: "low", description: "Low thinking budget" },
          { value: "medium", label: "medium", description: "Medium thinking budget" },
          { value: "high", label: "high", description: "High thinking budget" },
          { value: "xhigh", label: "xhigh", description: "Maximum thinking budget" }
        ];
        const filtered = levels.filter((l) => l.value.startsWith(prefix.trim().toLowerCase()));
        return filtered.length > 0 ? filtered : null;
      };
    }
    const templateCommands = this.session.promptTemplates.map((cmd) => ({
      name: cmd.name,
      description: cmd.description
    }));
    const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
    const extensionCommands = (this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []).map((cmd) => ({
      name: cmd.name,
      description: cmd.description ?? "(extension command)",
      getArgumentCompletions: cmd.getArgumentCompletions
    }));
    this.skillCommands.clear();
    const skillCommandList = [];
    if (this.settingsManager.getEnableSkillCommands()) {
      for (const skill of this.session.resourceLoader.getSkills().skills) {
        const commandName = `skill:${skill.name}`;
        this.skillCommands.set(commandName, skill.filePath);
        skillCommandList.push({ name: commandName, description: skill.description });
      }
    }
    this.autocompleteProvider = new CombinedAutocompleteProvider(
      [...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
      process.cwd(),
      {
        respectGitignore: this.settingsManager.getRespectGitignoreInPicker(),
        excludeDirs: this.settingsManager.getSearchExcludeDirs()
      }
    );
    this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
    if (this.editor !== this.defaultEditor) {
      this.editor.setAutocompleteProvider?.(this.autocompleteProvider);
    }
  }
  async init() {
    if (this.isInitialized) return;
    this.changelogMarkdown = this.getChangelogForDisplay();
    await ensureTool("rg");
    this.ui.addChild(this.headerContainer);
    if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
      const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${this.version}`);
      const kb = this.keybindings;
      const hint = (action, desc) => appKeyHint(kb, action, desc);
      const instructions = [
        hint("interrupt", "to interrupt"),
        hint("clear", "to clear"),
        rawKeyHint(`${appKey(kb, "clear")} twice`, "to exit"),
        hint("exit", "to exit (empty)"),
        hint("suspend", "to suspend"),
        keyHint("deleteToLineEnd", "to delete to end"),
        hint("cycleThinkingLevel", "to cycle thinking level"),
        rawKeyHint(`${appKey(kb, "cycleModelForward")}/${appKey(kb, "cycleModelBackward")}`, "to cycle models"),
        hint("selectModel", "to select model"),
        hint("expandTools", "to expand tools"),
        hint("toggleThinking", "to expand thinking"),
        hint("externalEditor", "for external editor"),
        rawKeyHint("/", "for commands"),
        rawKeyHint("!", "to run bash"),
        rawKeyHint("!!", "to run bash (no context)"),
        hint("followUp", "to queue follow-up"),
        hint("dequeue", "to edit all queued messages"),
        hint("pasteImage", "to paste image"),
        rawKeyHint("drop files", "to attach")
      ].join("\n");
      this.builtInHeader = new Text(`${logo}
${instructions}`, 1, 0);
      this.headerContainer.addChild(new Spacer(1));
      this.headerContainer.addChild(this.builtInHeader);
      this.headerContainer.addChild(new Spacer(1));
      if (this.changelogMarkdown) {
        this.headerContainer.addChild(new DynamicBorder());
        if (this.settingsManager.getCollapseChangelog()) {
          const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
          const latestVersion = versionMatch ? versionMatch[1] : this.version;
          const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
          this.headerContainer.addChild(new Text(condensedText, 1, 0));
        } else {
          this.headerContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
          this.headerContainer.addChild(new Spacer(1));
          this.headerContainer.addChild(
            new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings())
          );
          this.headerContainer.addChild(new Spacer(1));
        }
        this.headerContainer.addChild(new DynamicBorder());
      }
    } else {
      this.builtInHeader = new Text("", 0, 0);
      this.headerContainer.addChild(this.builtInHeader);
      if (this.changelogMarkdown) {
        this.headerContainer.addChild(new Spacer(1));
        const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
        const latestVersion = versionMatch ? versionMatch[1] : this.version;
        const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
        this.headerContainer.addChild(new Text(condensedText, 1, 0));
      }
    }
    this.ui.addChild(this.adaptiveLayout);
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(this.pendingMessagesContainer);
    this.ui.addChild(this.statusContainer);
    this.ui.addChild(this.pinnedMessageContainer);
    this.ui.addChild(this.blockingErrorContainer);
    this.renderWidgets();
    this.ui.addChild(this.widgetContainerAbove);
    this.ui.addChild(this.editorContainer);
    this.ui.addChild(this.widgetContainerBelow);
    this.ui.addChild(this.footer);
    this.ui.setFocus(this.editor);
    this.setupKeyHandlers();
    this.setupEditorSubmitHandler();
    await this.initExtensions();
    this.renderInitialMessages();
    this.ui.start();
    this.isInitialized = true;
    this.updateTerminalTitle();
    this.subscribeToAgent();
    onThemeChange(() => {
      this.ui.invalidate();
      this.updateEditorBorderColor();
      this.ui.requestRender();
    });
    this._branchChangeUnsub = this.footerDataProvider.onBranchChange(() => {
      this.ui.requestRender();
    });
    await this.updateAvailableProviderCount();
  }
  /**
   * Update terminal title with session name and cwd.
   */
  updateTerminalTitle() {
    const cwdBasename = path.basename(process.cwd());
    const sessionName = this.sessionManager.getSessionName();
    if (sessionName) {
      this.ui.terminal.setTitle(`\u03C0 - ${sessionName} - ${cwdBasename}`);
    } else {
      this.ui.terminal.setTitle(`\u03C0 - ${cwdBasename}`);
    }
  }
  /**
   * Run the interactive mode. This is the main entry point.
   * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
   */
  async run() {
    await this.init();
    this.checkForNewVersion().then((newVersion) => {
      if (newVersion) {
        this.showNewVersionNotification(newVersion);
      }
    });
    this.checkTmuxKeyboardSetup().then((warning) => {
      if (warning) {
        this.showWarning(warning);
      }
    });
    const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;
    if (migratedProviders && migratedProviders.length > 0) {
      this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
    }
    const modelsJsonError = this.session.modelRegistry.getError();
    if (modelsJsonError) {
      this.showError(`models.json error: ${modelsJsonError}`);
    }
    if (modelFallbackMessage) {
      this.showWarning(modelFallbackMessage);
    }
    if (initialMessage) {
      try {
        await this.session.prompt(initialMessage, { images: initialImages });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        this.showError(errorMessage);
      }
    }
    if (initialMessages) {
      for (const message of initialMessages) {
        try {
          await this.session.prompt(message);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
          this.showError(errorMessage);
        }
      }
    }
    while (true) {
      const userInput = await this.getUserInput();
      const images = this.pendingImages.length > 0 ? [...this.pendingImages] : void 0;
      this.pendingImages.length = 0;
      try {
        await this.session.prompt(userInput, { images });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        this.showError(errorMessage);
      }
    }
  }
  /**
   * Check npm registry for a newer version.
   */
  async checkForNewVersion() {
    if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return void 0;
    try {
      const response = await fetch("https://registry.npmjs.org/@gsd/pi-coding-agent/latest", {
        signal: AbortSignal.timeout(1e4)
      });
      if (!response.ok) return void 0;
      const data = await response.json();
      const latestVersion = data.version;
      if (latestVersion && latestVersion !== this.version) {
        return latestVersion;
      }
      return void 0;
    } catch {
      return void 0;
    }
  }
  async checkTmuxKeyboardSetup() {
    if (!process.env.TMUX) return void 0;
    const runTmuxShow = (option) => {
      return new Promise((resolve) => {
        const proc = spawn("tmux", ["show", "-gv", option], {
          stdio: ["ignore", "pipe", "ignore"]
        });
        let stdout = "";
        const timer = setTimeout(() => {
          proc.kill();
          resolve(void 0);
        }, 2e3);
        proc.stdout?.on("data", (data) => {
          stdout += data.toString();
        });
        proc.on("error", () => {
          clearTimeout(timer);
          resolve(void 0);
        });
        proc.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? stdout.trim() : void 0);
        });
      });
    };
    const [extendedKeys, extendedKeysFormat] = await Promise.all([
      runTmuxShow("extended-keys"),
      runTmuxShow("extended-keys-format")
    ]);
    if (extendedKeys !== "on" && extendedKeys !== "always") {
      return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
    }
    if (extendedKeysFormat === "xterm") {
      return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
    }
    return void 0;
  }
  /**
   * Get changelog entries to display on startup.
   * Only shows new entries since last seen version, skips for resumed sessions.
   */
  getChangelogForDisplay() {
    if (this.session.state.messages.length > 0) {
      return void 0;
    }
    const lastVersion = this.settingsManager.getLastChangelogVersion();
    const changelogPath = getChangelogPath();
    const entries = parseChangelog(changelogPath);
    if (!lastVersion) {
      this.settingsManager.setLastChangelogVersion(VERSION);
      return void 0;
    } else {
      const newEntries = getNewEntries(entries, lastVersion);
      if (newEntries.length > 0) {
        this.settingsManager.setLastChangelogVersion(VERSION);
        return newEntries.map((e) => e.content).join("\n\n");
      }
    }
    return void 0;
  }
  getMarkdownThemeWithSettings() {
    return {
      ...getMarkdownTheme(),
      codeBlockIndent: this.settingsManager.getCodeBlockIndent()
    };
  }
  // =========================================================================
  // Extension System
  // =========================================================================
  formatDisplayPath(p) {
    const home = os.homedir();
    let result = p;
    if (result.startsWith(home)) {
      result = `~${result.slice(home.length)}`;
    }
    return result;
  }
  /**
   * Get a short path relative to the package root for display.
   */
  getShortPath(fullPath, source) {
    const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
    if (npmMatch && source.startsWith("npm:")) {
      return npmMatch[2];
    }
    const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
    if (gitMatch && source.startsWith("git:")) {
      return gitMatch[1];
    }
    return this.formatDisplayPath(fullPath);
  }
  getDisplaySourceInfo(source, scope) {
    if (source === "local") {
      if (scope === "user") {
        return { label: "user", color: "muted" };
      }
      if (scope === "project") {
        return { label: "project", color: "muted" };
      }
      if (scope === "temporary") {
        return { label: "path", scopeLabel: "temp", color: "muted" };
      }
      return { label: "path", color: "muted" };
    }
    if (source === "cli") {
      return { label: "path", scopeLabel: scope === "temporary" ? "temp" : void 0, color: "muted" };
    }
    const scopeLabel = scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : void 0;
    return { label: source, scopeLabel, color: "accent" };
  }
  getScopeGroup(source, scope) {
    if (source === "cli" || scope === "temporary") return "path";
    if (scope === "user") return "user";
    if (scope === "project") return "project";
    return "path";
  }
  isPackageSource(source) {
    return source.startsWith("npm:") || source.startsWith("git:");
  }
  buildScopeGroups(paths, metadata) {
    const groups = {
      user: { scope: "user", paths: [], packages: /* @__PURE__ */ new Map() },
      project: { scope: "project", paths: [], packages: /* @__PURE__ */ new Map() },
      path: { scope: "path", paths: [], packages: /* @__PURE__ */ new Map() }
    };
    for (const p of paths) {
      const meta = this.findMetadata(p, metadata);
      const source = meta?.source ?? "local";
      const scope = meta?.scope ?? "project";
      const groupKey = this.getScopeGroup(source, scope);
      const group = groups[groupKey];
      if (this.isPackageSource(source)) {
        const list = group.packages.get(source) ?? [];
        list.push(p);
        group.packages.set(source, list);
      } else {
        group.paths.push(p);
      }
    }
    return [groups.project, groups.user, groups.path].filter(
      (group) => group.paths.length > 0 || group.packages.size > 0
    );
  }
  formatScopeGroups(groups, options) {
    const lines = [];
    for (const group of groups) {
      lines.push(`  ${theme.fg("accent", group.scope)}`);
      const sortedPaths = [...group.paths].sort((a, b) => a.localeCompare(b));
      for (const p of sortedPaths) {
        lines.push(theme.fg("dim", `    ${options.formatPath(p)}`));
      }
      const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
      for (const [source, paths] of sortedPackages) {
        lines.push(`    ${theme.fg("mdLink", source)}`);
        const sortedPackagePaths = [...paths].sort((a, b) => a.localeCompare(b));
        for (const p of sortedPackagePaths) {
          lines.push(theme.fg("dim", `      ${options.formatPackagePath(p, source)}`));
        }
      }
    }
    return lines.join("\n");
  }
  /**
   * Find metadata for a path, checking parent directories if exact match fails.
   * Package manager stores metadata for directories, but we display file paths.
   */
  findMetadata(p, metadata) {
    const exact = metadata.get(p);
    if (exact) return exact;
    let current = p;
    let parent = path.dirname(current);
    while (parent !== current) {
      const meta = metadata.get(parent);
      if (meta) return meta;
      current = parent;
      parent = path.dirname(current);
    }
    return void 0;
  }
  /**
   * Format a path with its source/scope info from metadata.
   */
  formatPathWithSource(p, metadata) {
    const meta = this.findMetadata(p, metadata);
    if (meta) {
      const shortPath = this.getShortPath(p, meta.source);
      const { label, scopeLabel } = this.getDisplaySourceInfo(meta.source, meta.scope);
      const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
      return `${labelText} ${shortPath}`;
    }
    return this.formatDisplayPath(p);
  }
  /**
   * Format resource diagnostics with nice collision display using metadata.
   */
  formatDiagnostics(diagnostics, metadata) {
    const lines = [];
    const collisions = /* @__PURE__ */ new Map();
    const otherDiagnostics = [];
    for (const d of diagnostics) {
      if (d.type === "collision" && d.collision) {
        const list = collisions.get(d.collision.name) ?? [];
        list.push(d);
        collisions.set(d.collision.name, list);
      } else {
        otherDiagnostics.push(d);
      }
    }
    for (const [name, collisionList] of collisions) {
      const first = collisionList[0]?.collision;
      if (!first) continue;
      lines.push(theme.fg("warning", `  "${name}" collision:`));
      lines.push(
        theme.fg("dim", `    ${theme.fg("success", "\u2713")} ${this.formatPathWithSource(first.winnerPath, metadata)}`)
      );
      for (const d of collisionList) {
        if (d.collision) {
          lines.push(
            theme.fg(
              "dim",
              `    ${theme.fg("warning", "\u2717")} ${this.formatPathWithSource(d.collision.loserPath, metadata)} (skipped)`
            )
          );
        }
      }
    }
    for (const d of otherDiagnostics) {
      if (d.path) {
        const sourceInfo = this.formatPathWithSource(d.path, metadata);
        lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${sourceInfo}`));
        lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
      } else {
        lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
      }
    }
    return lines.join("\n");
  }
  showLoadedResources(options) {
    const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
    const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
    if (!showListing && !showDiagnostics) {
      return;
    }
    const metadata = this.session.resourceLoader.getPathMetadata();
    const sectionHeader = (name, color = "mdHeading") => theme.fg(color, `[${name}]`);
    const skillsResult = this.session.resourceLoader.getSkills();
    const promptsResult = this.session.resourceLoader.getPrompts();
    const themesResult = this.session.resourceLoader.getThemes();
    if (showListing) {
      const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles;
      if (contextFiles.length > 0) {
        this.chatContainer.addChild(new Spacer(1));
        const contextList = contextFiles.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`)).join("\n");
        this.chatContainer.addChild(new Text(`${sectionHeader("Context")}
${contextList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }
      const skills = skillsResult.skills;
      if (skills.length > 0) {
        const skillPaths = skills.map((s) => s.filePath);
        const groups = this.buildScopeGroups(skillPaths, metadata);
        const skillList = this.formatScopeGroups(groups, {
          formatPath: (p) => this.formatDisplayPath(p),
          formatPackagePath: (p, source) => this.getShortPath(p, source)
        });
        this.chatContainer.addChild(new Text(`${sectionHeader("Skills")}
${skillList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }
      const templates = this.session.promptTemplates;
      if (templates.length > 0) {
        const templatePaths = templates.map((t) => t.filePath);
        const groups = this.buildScopeGroups(templatePaths, metadata);
        const templateByPath = new Map(templates.map((t) => [t.filePath, t]));
        const templateList = this.formatScopeGroups(groups, {
          formatPath: (p) => {
            const template = templateByPath.get(p);
            return template ? `/${template.name}` : this.formatDisplayPath(p);
          },
          formatPackagePath: (p) => {
            const template = templateByPath.get(p);
            return template ? `/${template.name}` : this.formatDisplayPath(p);
          }
        });
        this.chatContainer.addChild(new Text(`${sectionHeader("Prompts")}
${templateList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }
      const extensionPaths = options?.extensionPaths ?? [];
      if (extensionPaths.length > 0) {
        const groups = this.buildScopeGroups(extensionPaths, metadata);
        const extList = this.formatScopeGroups(groups, {
          formatPath: (p) => this.formatDisplayPath(p),
          formatPackagePath: (p, source) => this.getShortPath(p, source)
        });
        this.chatContainer.addChild(new Text(`${sectionHeader("Extensions", "mdHeading")}
${extList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }
      const loadedThemes = themesResult.themes;
      const customThemes = loadedThemes.filter((t) => t.sourcePath);
      if (customThemes.length > 0) {
        const themePaths = customThemes.map((t) => t.sourcePath);
        const groups = this.buildScopeGroups(themePaths, metadata);
        const themeList = this.formatScopeGroups(groups, {
          formatPath: (p) => this.formatDisplayPath(p),
          formatPackagePath: (p, source) => this.getShortPath(p, source)
        });
        this.chatContainer.addChild(new Text(`${sectionHeader("Themes")}
${themeList}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }
    }
    if (showDiagnostics) {
      const skillDiagnostics = skillsResult.diagnostics;
      if (skillDiagnostics.length > 0) {
        const collisionDiags = skillDiagnostics.filter((d) => d.type === "collision");
        const issueDiags = skillDiagnostics.filter((d) => d.type !== "collision");
        if (collisionDiags.length > 0) {
          const collisionLines = this.formatDiagnostics(collisionDiags, metadata);
          this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}
${collisionLines}`, 0, 0));
          this.chatContainer.addChild(new Spacer(1));
        }
        if (issueDiags.length > 0) {
          const issueLines = this.formatDiagnostics(issueDiags, metadata);
          this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill issues]")}
${issueLines}`, 0, 0));
          this.chatContainer.addChild(new Spacer(1));
        }
      }
      const promptDiagnostics = promptsResult.diagnostics;
      if (promptDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(promptDiagnostics, metadata);
        this.chatContainer.addChild(
          new Text(`${theme.fg("warning", "[Prompt conflicts]")}
${warningLines}`, 0, 0)
        );
        this.chatContainer.addChild(new Spacer(1));
      }
      const extensionDiagnostics = [];
      const extensionErrors = this.session.resourceLoader.getExtensions().errors;
      if (extensionErrors.length > 0) {
        for (const error of extensionErrors) {
          extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
        }
      }
      const commandDiagnostics = this.session.extensionRunner?.getCommandDiagnostics() ?? [];
      extensionDiagnostics.push(...commandDiagnostics);
      const shortcutDiagnostics = this.session.extensionRunner?.getShortcutDiagnostics() ?? [];
      extensionDiagnostics.push(...shortcutDiagnostics);
      if (extensionDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(extensionDiagnostics, metadata);
        this.chatContainer.addChild(
          new Text(`${theme.fg("warning", "[Extension issues]")}
${warningLines}`, 0, 0)
        );
        this.chatContainer.addChild(new Spacer(1));
      }
      const themeDiagnostics = themesResult.diagnostics;
      if (themeDiagnostics.length > 0) {
        const warningLines = this.formatDiagnostics(themeDiagnostics, metadata);
        this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}
${warningLines}`, 0, 0));
        this.chatContainer.addChild(new Spacer(1));
      }
    }
  }
  /**
   * Initialize the extension system with TUI-based UI context.
   */
  async initExtensions() {
    if (this.options.bindExtensions !== false) {
      const uiContext = this.createExtensionUIContext();
      await this.session.bindExtensions({
        uiContext,
        commandContextActions: {
          waitForIdle: () => this.session.agent.waitForIdle(),
          newSession: async (options) => {
            if (this.loadingAnimation) {
              this.loadingAnimation.stop();
              this.loadingAnimation = void 0;
            }
            this.statusContainer.clear();
            const success = await this.session.newSession(options);
            if (!success) {
              return { cancelled: true };
            }
            this.chatContainer.clear();
            this.pendingMessagesContainer.clear();
            this.compactionQueuedMessages = [];
            this.streamingComponent = void 0;
            this.streamingMessage = void 0;
            this.pendingTools.clear();
            this.clearBlockingError();
            this.renderInitialMessages();
            this.ui.requestRender();
            return { cancelled: false };
          },
          fork: async (entryId) => {
            const result = await this.session.fork(entryId);
            if (result.cancelled) {
              return { cancelled: true };
            }
            this.chatContainer.clear();
            this.renderInitialMessages();
            this.editor.setText(result.selectedText);
            this.showStatus("Forked to new session");
            return { cancelled: false };
          },
          navigateTree: async (targetId, options) => {
            const result = await this.session.navigateTree(targetId, {
              summarize: options?.summarize,
              customInstructions: options?.customInstructions,
              replaceInstructions: options?.replaceInstructions,
              label: options?.label
            });
            if (result.cancelled) {
              return { cancelled: true };
            }
            this.chatContainer.clear();
            this.renderInitialMessages();
            if (result.editorText && !this.editor.getText().trim()) {
              this.editor.setText(result.editorText);
            }
            this.showStatus("Navigated to selected point");
            return { cancelled: false };
          },
          switchSession: async (sessionPath) => {
            await this.handleResumeSession(sessionPath);
            return { cancelled: false };
          },
          reload: async () => {
            await this.handleReloadCommand();
          }
        },
        shutdownHandler: () => {
          this.shutdownRequested = true;
          if (!this.session.isStreaming) {
            void this.shutdown();
          }
        },
        onError: (error) => {
          this.showExtensionError(error.extensionPath, error.error, error.stack);
        }
      });
    }
    setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
    this.setupAutocomplete();
    const extensionRunner = this.session.extensionRunner;
    if (!extensionRunner) {
      this.showLoadedResources({ extensionPaths: [], force: false });
      return;
    }
    this.setupExtensionShortcuts(extensionRunner);
    this.showLoadedResources({ extensionPaths: extensionRunner.getExtensionPaths(), force: false });
  }
  /**
   * Get a tool definition by name (for custom rendering).
   */
  getRegisteredToolDefinition(toolName) {
    return this.session.getRenderableToolDefinition(toolName);
  }
  /**
   * Format web search result content for display in the TUI.
   */
  formatWebSearchResult(content) {
    if (!content) return "Web search completed";
    if (typeof content === "object" && "type" in content && content.type === "web_search_tool_result_error") {
      const error = content;
      return `Search error: ${error.error_code || "unknown"}`;
    }
    if (Array.isArray(content)) {
      const results = content.filter((r) => r.type === "web_search_result");
      if (results.length === 0) return "No results found";
      return results.map((r) => {
        const title = r.title || "Untitled";
        const url = r.url || "";
        return `${title}
  ${url}`;
      }).join("\n");
    }
    return "Web search completed";
  }
  /**
   * Set up keyboard shortcuts registered by extensions.
   */
  setupExtensionShortcuts(extensionRunner) {
    const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
    if (shortcuts.size === 0) return;
    const createContext = () => ({
      ui: this.createExtensionUIContext(),
      hasUI: true,
      cwd: process.cwd(),
      sessionManager: this.sessionManager,
      modelRegistry: this.session.modelRegistry,
      model: this.session.model,
      isIdle: () => !this.session.isStreaming,
      abort: () => this.session.abort({ origin: "user" }),
      hasPendingMessages: () => this.session.pendingMessageCount > 0,
      shutdown: () => {
        this.shutdownRequested = true;
      },
      getContextUsage: () => this.session.getContextUsage(),
      compact: (options) => {
        void (async () => {
          try {
            const result = await this.executeCompaction(options?.customInstructions, false);
            if (result) {
              options?.onComplete?.(result);
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            options?.onError?.(err);
          }
        })();
      },
      getSystemPrompt: () => this.session.systemPrompt,
      setCompactionThresholdOverride: (percent) => {
        this.session.settingsManager.setCompactionThresholdOverride(percent);
      }
    });
    this.defaultEditor.onExtensionShortcut = (data) => {
      for (const [shortcutStr, shortcut] of shortcuts) {
        if (matchesKey(data, shortcutStr)) {
          Promise.resolve(shortcut.handler(createContext())).catch((err) => {
            this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
          });
          return true;
        }
      }
      return false;
    };
  }
  /**
   * Set extension status text in the footer.
   */
  setExtensionStatus(key, text) {
    this.footerDataProvider.setExtensionStatus(key, text);
    this.ui.requestRender();
  }
  /**
   * Set an extension widget (string array or custom component).
   */
  setExtensionWidget(key, content, options) {
    const placement = options?.placement ?? "aboveEditor";
    const removeExisting = (map) => {
      const existing = map.get(key);
      if (existing?.dispose) existing.dispose();
      map.delete(key);
    };
    removeExisting(this.extensionWidgetsAbove);
    removeExisting(this.extensionWidgetsBelow);
    if (content === void 0) {
      this.renderWidgets();
      return;
    }
    let component;
    if (Array.isArray(content)) {
      const container = new Container();
      for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
        container.addChild(new Text(line, 1, 0));
      }
      if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
        container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
      }
      component = container;
    } else {
      component = content(this.ui, theme);
    }
    const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
    targetMap.set(key, component);
    this.renderWidgets();
  }
  clearExtensionWidgets() {
    for (const widget of this.extensionWidgetsAbove.values()) {
      widget.dispose?.();
    }
    for (const widget of this.extensionWidgetsBelow.values()) {
      widget.dispose?.();
    }
    this.extensionWidgetsAbove.clear();
    this.extensionWidgetsBelow.clear();
    this.renderWidgets();
  }
  resetExtensionUI() {
    if (this.extensionSelector) {
      this.hideExtensionSelector();
    }
    if (this.extensionInput) {
      this.hideExtensionInput();
    }
    if (this.extensionEditor) {
      this.hideExtensionEditor();
    }
    this.ui.hideOverlay();
    this.clearExtensionTerminalInputListeners();
    this.setExtensionFooter(void 0);
    this.setExtensionHeader(void 0);
    this.clearExtensionWidgets();
    this.footerDataProvider.clearExtensionStatuses();
    this.footer.invalidate();
    this.setCustomEditorComponent(void 0);
    this.defaultEditor.onExtensionShortcut = void 0;
    this.updateTerminalTitle();
    if (this.loadingAnimation) {
      this.loadingAnimation.setMessage(
        `${this.defaultWorkingMessage} (${appKey(this.keybindings, "interrupt")} to interrupt)`
      );
    }
  }
  static {
    // Maximum total widget lines to prevent viewport overflow
    this.MAX_WIDGET_LINES = 10;
  }
  /**
   * Render all extension widgets to the widget container.
   */
  renderWidgets() {
    if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
    this.widgetContainerAbove.detachChildren();
    const pinned = this.pinnedMessageContainer;
    this.widgetContainerAbove.addChild({
      render: () => pinned.children.length > 0 ? [] : [""],
      invalidate: () => {
      }
    });
    for (const component of this.extensionWidgetsAbove.values()) {
      this.widgetContainerAbove.addChild(component);
    }
    this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
    this.ui.requestRender();
  }
  renderWidgetContainer(container, widgets, spacerWhenEmpty, leadingSpacer) {
    container.detachChildren();
    if (widgets.size === 0) {
      if (spacerWhenEmpty) {
        container.addChild(new Spacer(1));
      }
      return;
    }
    if (leadingSpacer) {
      container.addChild(new Spacer(1));
    }
    for (const component of widgets.values()) {
      container.addChild(component);
    }
  }
  /**
   * Set a custom footer component, or restore the built-in footer.
   */
  setExtensionFooter(factory) {
    if (this.customFooter?.dispose) {
      this.customFooter.dispose();
    }
    if (this.customFooter) {
      this.ui.removeChild(this.customFooter);
    } else {
      this.ui.removeChild(this.footer);
    }
    if (factory) {
      this.customFooter = factory(this.ui, theme, this.footerDataProvider);
      this.ui.addChild(this.customFooter);
    } else {
      this.customFooter = void 0;
      this.ui.addChild(this.footer);
    }
    this.ui.requestRender();
  }
  /**
   * Set a custom header component, or restore the built-in header.
   */
  setExtensionHeader(factory) {
    if (!this.builtInHeader) {
      return;
    }
    if (this.customHeader?.dispose) {
      this.customHeader.dispose();
    }
    const currentHeader = this.customHeader || this.builtInHeader;
    const index = this.headerContainer.children.indexOf(currentHeader);
    if (factory) {
      this.customHeader = factory(this.ui, theme);
      if (index !== -1) {
        this.headerContainer.children[index] = this.customHeader;
      } else {
        this.headerContainer.children.unshift(this.customHeader);
      }
    } else {
      this.customHeader = void 0;
      if (index !== -1) {
        this.headerContainer.children[index] = this.builtInHeader;
      }
    }
    this.ui.requestRender();
  }
  addExtensionTerminalInputListener(handler) {
    const unsubscribe = this.ui.addInputListener(handler);
    this.extensionTerminalInputUnsubscribers.add(unsubscribe);
    return () => {
      unsubscribe();
      this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
    };
  }
  clearExtensionTerminalInputListeners() {
    for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
      unsubscribe();
    }
    this.extensionTerminalInputUnsubscribers.clear();
  }
  /**
   * Create the ExtensionUIContext for extensions.
   */
  createExtensionUIContext() {
    return buildExtensionUIContext(this);
  }
  getExtensionUIContext() {
    return this.createExtensionUIContext();
  }
  /**
   * Show a selector for extensions.
   */
  showExtensionSelector(title, options, opts) {
    if (this.extensionSelector) {
      this.hideExtensionSelector();
    }
    return new Promise((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(void 0);
        return;
      }
      const onAbort = () => {
        this.hideExtensionSelector();
        resolve(void 0);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      this.extensionSelector = new ExtensionSelectorComponent(
        title,
        options,
        (option) => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionSelector();
          resolve(option);
        },
        () => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionSelector();
          resolve(void 0);
        },
        { tui: this.ui, timeout: opts?.timeout }
      );
      this.editorContainer.clear();
      this.editorContainer.addChild(this.extensionSelector);
      this.ui.setFocus(this.extensionSelector);
      this.ui.requestRender();
    });
  }
  /**
   * Hide the extension selector.
   */
  hideExtensionSelector() {
    this.extensionSelector?.dispose();
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.extensionSelector = void 0;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }
  /**
   * Show a confirmation dialog for extensions.
   */
  async showExtensionConfirm(title, message, opts) {
    const result = await this.showExtensionSelector(`${title}
${message}`, ["Yes", "No"], opts);
    return result === "Yes";
  }
  /**
   * Show a text input for extensions.
   */
  showExtensionInput(title, placeholder, opts) {
    return new Promise((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(void 0);
        return;
      }
      const onAbort = () => {
        this.hideExtensionInput();
        resolve(void 0);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      this.extensionInput = new ExtensionInputComponent(
        title,
        placeholder,
        (value) => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionInput();
          resolve(value);
        },
        () => {
          opts?.signal?.removeEventListener("abort", onAbort);
          this.hideExtensionInput();
          resolve(void 0);
        },
        { tui: this.ui, timeout: opts?.timeout, secure: opts?.secure }
      );
      this.editorContainer.clear();
      this.editorContainer.addChild(this.extensionInput);
      this.ui.setFocus(this.extensionInput);
      this.ui.requestRender();
    });
  }
  /**
   * Hide the extension input.
   */
  hideExtensionInput() {
    this.extensionInput?.dispose();
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.extensionInput = void 0;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }
  /**
   * Show a multi-line editor for extensions (with Ctrl+G support).
   */
  showExtensionEditor(title, prefill) {
    return new Promise((resolve) => {
      this.extensionEditor = new ExtensionEditorComponent(
        this.ui,
        this.keybindings,
        title,
        prefill,
        (value) => {
          this.hideExtensionEditor();
          resolve(value);
        },
        () => {
          this.hideExtensionEditor();
          resolve(void 0);
        }
      );
      this.editorContainer.clear();
      this.editorContainer.addChild(this.extensionEditor);
      this.ui.setFocus(this.extensionEditor);
      this.ui.requestRender();
    });
  }
  /**
   * Hide the extension editor.
   */
  hideExtensionEditor() {
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.extensionEditor = void 0;
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }
  /**
   * Set a custom editor component from an extension.
   * Pass undefined to restore the default editor.
   */
  setCustomEditorComponent(factory) {
    const currentText = this.editor.getText();
    this.editorContainer.clear();
    if (factory) {
      const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);
      newEditor.onSubmit = this.defaultEditor.onSubmit;
      newEditor.onChange = this.defaultEditor.onChange;
      newEditor.setText(currentText);
      if (newEditor.borderColor !== void 0) {
        newEditor.borderColor = this.defaultEditor.borderColor;
      }
      if (newEditor.setPaddingX !== void 0) {
        newEditor.setPaddingX(this.defaultEditor.getPaddingX());
      }
      if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
        newEditor.setAutocompleteProvider(this.autocompleteProvider);
      }
      const customEditor = newEditor;
      if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
        if (!customEditor.onEscape) {
          customEditor.onEscape = () => this.defaultEditor.onEscape?.();
        }
        if (!customEditor.onCtrlD) {
          customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
        }
        if (!customEditor.onPasteImage) {
          customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
        }
        if (!customEditor.onExtensionShortcut) {
          customEditor.onExtensionShortcut = (data) => this.defaultEditor.onExtensionShortcut?.(data);
        }
        for (const [action, handler] of this.defaultEditor.actionHandlers) {
          customEditor.actionHandlers.set(action, handler);
        }
      }
      this.editor = newEditor;
    } else {
      this.defaultEditor.setText(currentText);
      this.editor = this.defaultEditor;
    }
    if (!this.editor.onPasteImagePath) {
      this.editor.onPasteImagePath = (filePath) => {
        this.handlePastedImagePath(filePath);
      };
    }
    this.editorContainer.addChild(this.editor);
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }
  /**
   * Show a notification for extensions.
   */
  showExtensionNotify(message, type) {
    if (type === "error") {
      this.lastBlockingError = message;
      renderBlockingErrorBanner(this.blockingErrorContainer, this.lastBlockingError);
    }
    const result = renderExtensionNotifyInChat(this.chatContainer, message, type);
    if (!result.rendered) {
      return;
    }
    if (result.statusSpacer && result.statusText) {
      this.lastStatusSpacer = result.statusSpacer;
      this.lastStatusText = result.statusText;
    }
    this.ui.requestRender();
  }
  /** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
  async showExtensionCustom(factory, options) {
    const savedText = this.editor.getText();
    const isOverlay = options?.overlay ?? false;
    const restoreEditor = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.editor.setText(savedText);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };
    return new Promise((resolve, reject) => {
      let component;
      let closed = false;
      const close = (result) => {
        if (closed) return;
        closed = true;
        if (isOverlay) this.ui.hideOverlay();
        else restoreEditor();
        resolve(result);
        try {
          component?.dispose?.();
        } catch {
        }
      };
      Promise.resolve(factory(this.ui, theme, this.keybindings, close)).then((c) => {
        if (closed) return;
        component = c;
        if (isOverlay) {
          const resolveOptions = () => {
            if (options?.overlayOptions) {
              const opts = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
              return opts;
            }
            const w = component.width;
            return w ? { width: w } : void 0;
          };
          const handle = this.ui.showOverlay(component, resolveOptions());
          options?.onHandle?.(handle);
        } else {
          this.editorContainer.clear();
          this.editorContainer.addChild(component);
          this.ui.setFocus(component);
          this.ui.requestRender();
        }
      }).catch((err) => {
        if (closed) return;
        if (!isOverlay) restoreEditor();
        reject(err);
      });
    });
  }
  /**
   * Show an extension error in the UI.
   */
  showExtensionError(extensionPath, error, stack) {
    const errorMsg = `Extension "${extensionPath}" error: ${error}`;
    const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
    this.chatContainer.addChild(errorText);
    if (stack) {
      const stackLines = stack.split("\n").slice(1).map((line) => theme.fg("dim", `  ${line.trim()}`)).join("\n");
      if (stackLines) {
        this.chatContainer.addChild(new Text(stackLines, 1, 0));
      }
    }
    this.ui.requestRender();
  }
  // =========================================================================
  // Key Handlers
  // =========================================================================
  setupKeyHandlers() {
    this.defaultEditor.onEscape = () => {
      if (this.loadingAnimation) {
        this.restoreQueuedMessagesToEditor({ abort: true });
      } else if (this.session.isBashRunning) {
        this.session.abortBash();
      } else if (this.isBashMode) {
        this.editor.setText("");
        this.pendingImages.length = 0;
        this.isBashMode = false;
        this.updateEditorBorderColor();
      } else if (!this.editor.getText().trim()) {
        const action = this.settingsManager.getDoubleEscapeAction();
        if (action !== "none") {
          const now = Date.now();
          if (now - this.lastEscapeTime < 500) {
            if (action === "tree") {
              this.showTreeSelector();
            } else {
              this.showUserMessageSelector();
            }
            this.lastEscapeTime = 0;
          } else {
            this.lastEscapeTime = now;
          }
        }
      }
    };
    this.defaultEditor.onAction("clear", () => this.handleCtrlC());
    this.defaultEditor.onCtrlD = () => this.handleCtrlD();
    this.defaultEditor.onAction("suspend", () => this.handleCtrlZ());
    this.defaultEditor.onAction("cycleThinkingLevel", () => this.cycleThinkingLevel());
    this.defaultEditor.onAction("cycleModelForward", () => this.cycleModel("forward"));
    this.defaultEditor.onAction("cycleModelBackward", () => this.cycleModel("backward"));
    this.ui.onDebug = () => this.handleDebugCommand();
    this.defaultEditor.onAction("selectModel", () => this.showModelSelector());
    this.defaultEditor.onAction("expandTools", () => this.toggleToolOutputExpansion());
    this.defaultEditor.onAction("toggleThinking", () => this.toggleThinkingBlockVisibility());
    this.defaultEditor.onAction("externalEditor", () => this.openExternalEditor());
    this.defaultEditor.onAction("followUp", () => this.handleFollowUp());
    this.defaultEditor.onAction("dequeue", () => this.handleDequeue());
    this.defaultEditor.onAction("newSession", () => this.handleClearCommand());
    this.defaultEditor.onAction("tree", () => this.showTreeSelector());
    this.defaultEditor.onAction("fork", () => this.showUserMessageSelector());
    this.defaultEditor.onAction("resume", () => this.showSessionSelector());
    this.defaultEditor.onChange = (text) => {
      const wasBashMode = this.isBashMode;
      this.isBashMode = text.trimStart().startsWith("!");
      if (wasBashMode !== this.isBashMode) {
        this.updateEditorBorderColor();
      }
    };
    this.defaultEditor.onPasteImage = () => {
      this.handleClipboardImagePaste();
    };
    this.defaultEditor.onPasteImagePath = (filePath) => {
      this.handlePastedImagePath(filePath);
    };
  }
  async handleClipboardImagePaste() {
    try {
      const image = await readClipboardImage();
      if (!image) {
        return;
      }
      const imageContent = {
        type: "image",
        data: Buffer.from(image.bytes).toString("base64"),
        mimeType: image.mimeType
      };
      this.pendingImages.push(imageContent);
      const imageNum = this.pendingImages.length;
      this.editor.insertTextAtCursor?.(`[Image #${imageNum}]`);
      this.ui.requestRender();
    } catch {
    }
  }
  static {
    // MIME types restricted to formats commonly accepted by AI vision APIs.
    // SVG is excluded — it is XML/JS-bearing and not safe to forward as image content.
    // TIFF/HEIC/HEIF/AVIF are excluded for compatibility; users can convert before pasting.
    this.MIME_BY_EXT = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp"
    };
  }
  // Magic-byte signatures used to verify file content matches its extension,
  // preventing arbitrary-file-read via crafted paste of e.g. "/etc/passwd.png".
  static matchesImageSignature(buf, mimeType) {
    if (buf.length < 12) return false;
    switch (mimeType) {
      case "image/png":
        return buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71;
      case "image/jpeg":
        return buf[0] === 255 && buf[1] === 216 && buf[2] === 255;
      case "image/gif":
        return buf[0] === 71 && buf[1] === 73 && buf[2] === 70 && buf[3] === 56 && (buf[4] === 55 || buf[4] === 57) && buf[5] === 97;
      case "image/webp":
        return buf[0] === 82 && buf[1] === 73 && buf[2] === 70 && buf[3] === 70 && buf[8] === 87 && buf[9] === 69 && buf[10] === 66 && buf[11] === 80;
      default:
        return false;
    }
  }
  handlePastedImagePath(filePath) {
    try {
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mimeType = InteractiveMode.MIME_BY_EXT[ext];
      if (!mimeType) {
        this.editor.insertTextAtCursor?.(filePath);
        this.ui.requestRender();
        return;
      }
      const lst = fs.lstatSync(filePath);
      if (!lst.isFile()) {
        this.editor.insertTextAtCursor?.(filePath);
        this.ui.requestRender();
        return;
      }
      const data = fs.readFileSync(filePath);
      if (!InteractiveMode.matchesImageSignature(data, mimeType)) {
        this.editor.insertTextAtCursor?.(filePath);
        this.ui.requestRender();
        return;
      }
      this.pendingImages.push({
        type: "image",
        data: data.toString("base64"),
        mimeType
      });
      const imageNum = this.pendingImages.length;
      this.editor.insertTextAtCursor?.(`[Image #${imageNum}]`);
      this.ui.requestRender();
    } catch {
      this.editor.insertTextAtCursor?.(filePath);
      this.ui.requestRender();
    }
  }
  getSlashCommandContext() {
    return {
      session: this.session,
      ui: this.ui,
      keybindings: this.keybindings,
      chatContainer: this.chatContainer,
      statusContainer: this.statusContainer,
      editorContainer: this.editorContainer,
      headerContainer: this.headerContainer,
      pendingMessagesContainer: this.pendingMessagesContainer,
      editor: this.editor,
      defaultEditor: this.defaultEditor,
      sessionManager: this.sessionManager,
      settingsManager: this.settingsManager,
      invalidateFooter: () => this.footer.invalidate(),
      showStatus: (msg) => this.showStatus(msg),
      showError: (msg) => this.showError(msg),
      showWarning: (msg) => this.showWarning(msg),
      showSelector: (create) => this.showSelector(create),
      updateEditorBorderColor: () => this.updateEditorBorderColor(),
      getMarkdownThemeWithSettings: () => this.getMarkdownThemeWithSettings(),
      requestRender: () => this.ui.requestRender(),
      updateTerminalTitle: () => this.updateTerminalTitle(),
      showSettingsSelector: () => this.showSettingsSelector(),
      showModelsSelector: () => this.showModelsSelector(),
      handleModelCommand: (searchTerm) => this.handleModelCommand(searchTerm),
      showUserMessageSelector: () => this.showUserMessageSelector(),
      showTreeSelector: () => this.showTreeSelector(),
      showProviderManager: () => this.showProviderManager(),
      showOAuthSelector: (mode) => this.showOAuthSelector(mode),
      showSessionSelector: () => this.showSessionSelector(),
      handleClearCommand: () => this.handleClearCommand(),
      handleReloadCommand: () => this.handleReloadCommand(),
      handleDebugCommand: () => this.handleDebugCommand(),
      shutdown: () => this.shutdown(),
      executeCompaction: (instructions, isAuto) => this.executeCompaction(instructions, isAuto),
      handleBashCommand: (command, options) => this.handleBashCommand(command, options?.excludeFromContext, options?.displayCommand, options?.loginShell)
    };
  }
  setupEditorSubmitHandler() {
    setupEditorSubmitHandlerController(this);
  }
  subscribeToAgent() {
    let eventQueue = Promise.resolve();
    this.unsubscribe = this.session.subscribe((event) => {
      eventQueue = eventQueue.then(() => this.handleEvent(event)).catch(() => {
      });
    });
  }
  async handleEvent(event) {
    await handleAgentEvent(this, event);
  }
  /** Extract text content from a user message */
  getUserMessageText(message) {
    if (message.role !== "user") return "";
    const textBlocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.filter((c) => c.type === "text");
    return textBlocks.map((c) => c.text).join("");
  }
  /**
   * Show a status message in the chat.
   *
   * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
   * we update the previous status line instead of appending new ones to avoid log spam.
   */
  showStatus(message, options) {
    const append = options?.append ?? false;
    const children = this.chatContainer.children;
    const last = children.length > 0 ? children[children.length - 1] : void 0;
    const secondLast = children.length > 1 ? children[children.length - 2] : void 0;
    if (!append && last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
      this.lastStatusText.setText(theme.fg("dim", message));
      this.ui.requestRender();
      return;
    }
    const spacer = new Spacer(1);
    const text = new Text(theme.fg("dim", message), 1, 0);
    this.chatContainer.addChild(spacer);
    this.chatContainer.addChild(text);
    this.lastStatusSpacer = spacer;
    this.lastStatusText = text;
    this.ui.requestRender();
  }
  addMessageToChat(message, options) {
    const timestampFormat = this.settingsManager.getTimestampFormat();
    switch (message.role) {
      case "bashExecution": {
        const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
        if (message.output) {
          component.appendOutput(message.output);
        }
        component.setComplete(
          message.exitCode,
          message.cancelled,
          message.truncated ? { truncated: true } : void 0,
          message.fullOutputPath
        );
        this.chatContainer.addChild(component);
        break;
      }
      case "custom": {
        if (message.display) {
          const renderer = this.session.extensionRunner?.getMessageRenderer(message.customType);
          const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
          component.setExpanded(this.toolOutputExpanded);
          this.chatContainer.addChild(component);
        }
        break;
      }
      case "compactionSummary": {
        this.chatContainer.addChild(new Spacer(1));
        const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
        component.setExpanded(this.toolOutputExpanded);
        this.chatContainer.addChild(component);
        break;
      }
      case "branchSummary": {
        this.chatContainer.addChild(new Spacer(1));
        const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
        component.setExpanded(this.toolOutputExpanded);
        this.chatContainer.addChild(component);
        break;
      }
      case "user": {
        const textContent = this.getUserMessageText(message);
        if (textContent) {
          const skillBlock = parseSkillBlock(textContent);
          if (skillBlock) {
            this.chatContainer.addChild(new Spacer(1));
            const component = new SkillInvocationMessageComponent(
              skillBlock,
              this.getMarkdownThemeWithSettings()
            );
            component.setExpanded(this.toolOutputExpanded);
            this.chatContainer.addChild(component);
            if (skillBlock.userMessage) {
              const userComponent = new UserMessageComponent(
                skillBlock.userMessage,
                this.getMarkdownThemeWithSettings(),
                message.timestamp,
                timestampFormat
              );
              this.chatContainer.addChild(userComponent);
            }
          } else {
            const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings(), message.timestamp, timestampFormat);
            this.chatContainer.addChild(userComponent);
          }
          if (options?.populateHistory) {
            this.editor.addToHistory?.(textContent);
          }
        }
        break;
      }
      case "assistant": {
        const assistantComponent = new AssistantMessageComponent(
          message,
          this.hideThinkingBlock,
          this.getMarkdownThemeWithSettings(),
          timestampFormat
        );
        this.chatContainer.addChild(assistantComponent);
        break;
      }
      case "toolResult": {
        break;
      }
      default: {
        const _exhaustive = message;
      }
    }
    this.trimChatHistory();
  }
  /**
   * Remove oldest components when chat exceeds MAX_CHAT_COMPONENTS.
   * Only render-components are removed — session data stays in SessionManager.
   */
  trimChatHistory() {
    while (this.chatContainer.children.length > InteractiveMode.MAX_CHAT_COMPONENTS) {
      const oldest = this.chatContainer.children[0];
      this.chatContainer.removeChild(oldest);
    }
  }
  /**
   * Render session context to chat. Used for initial load and rebuild after compaction.
   * @param sessionContext Session context to render
   * @param options.updateFooter Update footer state
   * @param options.populateHistory Add user messages to editor history
   */
  renderSessionContext(sessionContext, options = {}) {
    this.pendingTools.clear();
    const timestampFormat = this.settingsManager.getTimestampFormat();
    if (options.updateFooter) {
      this.footer.invalidate();
      this.updateEditorBorderColor();
    }
    for (const message of sessionContext.messages) {
      if (message.role === "assistant") {
        const hasToolBlocks = message.content.some((c) => c.type === "toolCall" || c.type === "serverToolUse");
        if (!hasToolBlocks) {
          this.addMessageToChat(message);
          continue;
        }
        const assistantSegments = [];
        const replaySegments = buildAssistantReplaySegments(message.content);
        for (const segment of replaySegments) {
          if (segment.kind === "assistant") {
            const assistantComponent = new AssistantMessageComponent(
              message,
              this.hideThinkingBlock,
              this.getMarkdownThemeWithSettings(),
              timestampFormat,
              { startIndex: segment.startIndex, endIndex: segment.endIndex }
            );
            this.chatContainer.addChild(assistantComponent);
            assistantSegments.push(assistantComponent);
            continue;
          }
          const content = message.content[segment.contentIndex];
          if (content.type === "toolCall") {
            const component = new ToolExecutionComponent(
              content.name,
              content.arguments,
              { showImages: this.settingsManager.getShowImages() },
              this.getRegisteredToolDefinition(content.name),
              this.ui
            );
            component.setExpanded(this.toolOutputExpanded);
            this.chatContainer.addChild(component);
            if (message.stopReason === "aborted" || message.stopReason === "error") {
              let errorMessage;
              if (message.stopReason === "aborted") {
                const retryAttempt = this.session.retryAttempt;
                errorMessage = retryAttempt > 0 ? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}` : "Operation aborted";
              } else {
                errorMessage = message.errorMessage || "Error";
              }
              component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
            } else {
              this.pendingTools.set(content.id, component);
            }
          } else if (content.type === "serverToolUse") {
            const component = new ToolExecutionComponent(
              content.name,
              content.input ?? {},
              { showImages: this.settingsManager.getShowImages() },
              void 0,
              this.ui
            );
            component.setExpanded(this.toolOutputExpanded);
            this.chatContainer.addChild(component);
            const resultBlock = message.content.find(
              (c) => c.type === "webSearchResult" && c.toolUseId === content.id
            );
            if (resultBlock && resultBlock.type === "webSearchResult") {
              const searchContent = resultBlock.content;
              const isError = searchContent && typeof searchContent === "object" && "type" in searchContent && searchContent.type === "web_search_tool_result_error";
              const resultText = this.formatWebSearchResult(searchContent);
              component.updateResult({
                content: [{ type: "text", text: resultText }],
                isError: !!isError
              });
            } else {
              this.pendingTools.set(content.id, component);
            }
          }
        }
        const lastAssistantSegment = assistantSegments[assistantSegments.length - 1];
        lastAssistantSegment?.setShowMetadata(true);
      } else if (message.role === "toolResult") {
        const component = this.pendingTools.get(message.toolCallId);
        if (component) {
          component.updateResult(message);
          this.pendingTools.delete(message.toolCallId);
        }
      } else {
        this.addMessageToChat(message, options);
      }
    }
    for (const component of this.pendingTools.values()) {
      component.markHistoricalNoResult();
    }
    this.pendingTools.clear();
    this.trimChatHistory();
    this.ui.requestRender();
  }
  renderInitialMessages() {
    const context = this.sessionManager.buildSessionContext();
    this.renderSessionContext(context, {
      updateFooter: true,
      populateHistory: true
    });
    this.populatePinnedFromMessages(context.messages);
    const allEntries = this.sessionManager.getEntries();
    const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
    if (compactionCount > 0) {
      const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
      this.showStatus(`Session compacted ${times}`);
    }
  }
  async getUserInput() {
    return new Promise((resolve) => {
      this.onInputCallback = (text) => {
        this.onInputCallback = void 0;
        resolve(text);
      };
    });
  }
  rebuildChatFromMessages() {
    this.chatContainer.clear();
    this.pinnedMessageContainer.clear();
    const context = this.sessionManager.buildSessionContext();
    this.renderSessionContext(context);
  }
  /**
   * After rebuilding chat from messages, pin the last assistant text above the
   * editor if tool results would otherwise push it out of the viewport.
   */
  populatePinnedFromMessages(messages) {
    this.pinnedMessageContainer.clear();
    let lastAssistant;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && "role" in msg && msg.role === "assistant") {
        lastAssistant = msg;
        break;
      }
    }
    if (!lastAssistant) return;
    const content = lastAssistant.content;
    let lastTextIndex = -1;
    let hasToolAfterText = false;
    for (let i = 0; i < content.length; i++) {
      if (content[i].type === "text") lastTextIndex = i;
    }
    if (lastTextIndex >= 0) {
      for (let i = lastTextIndex + 1; i < content.length; i++) {
        if (content[i].type === "toolCall" || content[i].type === "serverToolUse") {
          hasToolAfterText = true;
          break;
        }
      }
    }
    if (!hasToolAfterText || lastTextIndex < 0) return;
    const textBlock = content[lastTextIndex];
    const text = textBlock.text?.trim();
    if (!text) return;
    this.pinnedMessageContainer.addChild(
      new DynamicBorder((str) => theme.fg("dim", str), "Latest Output")
    );
    this.pinnedMessageContainer.addChild(
      new Markdown(text, 1, 0, this.getMarkdownThemeWithSettings())
    );
  }
  // =========================================================================
  // Key handlers
  // =========================================================================
  handleCtrlC() {
    const now = Date.now();
    if (now - this.lastSigintTime < 500) {
      void this.shutdown();
    } else {
      this.clearEditor();
      this.lastSigintTime = now;
    }
  }
  handleCtrlD() {
    void this.shutdown();
  }
  async shutdown() {
    const shutdownBehavior = this.options.shutdownBehavior ?? "exit_process";
    if (shutdownBehavior === "ignore") {
      this.showStatus("Quit is unavailable in the browser-attached terminal");
      return;
    }
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    await this.settingsManager.flush();
    const extensionRunner = this.session.extensionRunner;
    if (extensionRunner?.hasHandlers("session_shutdown")) {
      await extensionRunner.emit({
        type: "session_shutdown"
      });
    }
    await new Promise((resolve) => process.nextTick(resolve));
    await this.ui.terminal.drainInput(1e3);
    this.stop();
    if (shutdownBehavior === "stop_ui") {
      return;
    }
    try {
      const descendants = listDescendants(process.pid);
      for (const childPid of descendants) {
        try {
          process.kill(childPid, "SIGTERM");
        } catch {
        }
      }
      if (descendants.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        for (const childPid of descendants) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
          }
        }
      }
    } catch {
    }
    process.exit(0);
  }
  /**
   * Check if shutdown was requested and perform shutdown if so.
   */
  async checkShutdownRequested() {
    if (!this.shutdownRequested) return;
    await this.shutdown();
  }
  handleCtrlZ() {
    if (process.platform === "win32") {
      return;
    }
    const ignoreSigint = () => {
    };
    process.on("SIGINT", ignoreSigint);
    try {
      process.once("SIGCONT", () => {
        process.removeListener("SIGINT", ignoreSigint);
        this.ui.start();
        this.ui.requestRender(true);
      });
      this.ui.stop();
      process.kill(0, "SIGTSTP");
    } catch {
      process.removeListener("SIGINT", ignoreSigint);
    }
  }
  async handleFollowUp() {
    const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
    if (!text) return;
    if (text.startsWith("/") && !this.isKnownSlashCommand(text)) {
      const command = text.split(/\s/)[0];
      this.showError(`Unknown command: ${command}. Use slash autocomplete to see available commands.`);
      return;
    }
    const images = this.pendingImages.length > 0 ? [...this.pendingImages] : void 0;
    this.pendingImages.length = 0;
    if (this.session.isCompacting) {
      if (this.isExtensionCommand(text)) {
        this.editor.addToHistory?.(text);
        this.editor.setText("");
        await this.session.prompt(text, { images });
      } else {
        this.queueCompactionMessage(text, "followUp");
      }
      return;
    }
    if (this.session.isStreaming) {
      this.editor.addToHistory?.(text);
      this.editor.setText("");
      await this.session.prompt(text, { streamingBehavior: "followUp", images });
      this.updatePendingMessagesDisplay();
      this.ui.requestRender();
    } else if (this.editor.onSubmit) {
      this.editor.onSubmit(text);
    }
  }
  handleDequeue() {
    const restored = this.restoreQueuedMessagesToEditor();
    if (restored === 0) {
      this.showStatus("No queued messages to restore");
    } else {
      this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
    }
  }
  updateEditorBorderColor() {
    if (this.isBashMode) {
      this.editor.borderColor = theme.getBashModeBorderColor();
    } else {
      const level = this.session.thinkingLevel || "off";
      this.editor.borderColor = theme.getThinkingBorderColor(level);
    }
    this.ui.requestRender();
  }
  cycleThinkingLevel() {
    const newLevel = this.session.cycleThinkingLevel();
    if (newLevel === void 0) {
      this.showStatus("Current model does not support thinking");
    } else {
      this.footer.invalidate();
      this.updateEditorBorderColor();
      this.showStatus(`Thinking level: ${newLevel}`);
    }
  }
  async cycleModel(direction) {
    try {
      const result = await this.session.cycleModel(direction);
      if (result === void 0) {
        const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
        this.showStatus(msg);
      } else {
        this.footer.invalidate();
        this.updateEditorBorderColor();
        const thinkingStr = result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
        this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
      }
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }
  toggleToolOutputExpansion() {
    this.setToolsExpanded(!this.toolOutputExpanded);
  }
  setToolsExpanded(expanded) {
    this.toolOutputExpanded = expanded;
    for (const child of this.chatContainer.children) {
      if (isExpandable(child)) {
        child.setExpanded(expanded);
      }
    }
    this.ui.requestRender();
  }
  toggleThinkingBlockVisibility() {
    this.hideThinkingBlock = !this.hideThinkingBlock;
    this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);
    this.chatContainer.clear();
    this.rebuildChatFromMessages();
    if (this.streamingComponent && this.streamingMessage) {
      this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
      this.streamingComponent.updateContent(this.streamingMessage);
      this.chatContainer.addChild(this.streamingComponent);
    }
    this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
  }
  openExternalEditor() {
    const editorCmd = process.env.VISUAL || process.env.EDITOR;
    if (!editorCmd) {
      let msg = "No editor configured. Set $VISUAL or $EDITOR environment variable.";
      if (process.env.TERM_PROGRAM === "iTerm.app") {
        msg += '\n\nTip: If you meant to open the GSD dashboard (Ctrl+Alt+G), set Left Option Key to "Esc+" in iTerm2 \u2192 Profiles \u2192 Keys. With the default "Normal" setting, Ctrl+Alt+G sends Ctrl+G instead.';
      }
      this.showWarning(msg);
      return;
    }
    const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
    const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);
    try {
      fs.writeFileSync(tmpFile, currentText, "utf-8");
      this.ui.stop();
      const [editor, ...editorArgs] = editorCmd.split(" ");
      const result = spawnSync(editor, [...editorArgs, tmpFile], {
        stdio: "inherit",
        shell: process.platform === "win32"
      });
      if (result.status === 0) {
        const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
        this.editor.setText(newContent);
      }
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
      }
      this.ui.start();
      this.ui.requestRender(true);
    }
  }
  // =========================================================================
  // UI helpers
  // =========================================================================
  clearEditor() {
    this.editor.setText("");
    this.ui.requestRender();
  }
  showError(errorMessage) {
    this.lastBlockingError = errorMessage;
    renderBlockingErrorBanner(this.blockingErrorContainer, this.lastBlockingError);
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
    this.ui.requestRender();
  }
  clearBlockingError() {
    this.lastBlockingError = void 0;
    renderBlockingErrorBanner(this.blockingErrorContainer, void 0);
    this.ui.requestRender();
  }
  showWarning(warningMessage) {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
    this.ui.requestRender();
  }
  showSuccess(successMessage) {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("success", text)));
    this.chatContainer.addChild(
      new Text(theme.fg("success", successMessage), 1, 0)
    );
    this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("success", text)));
    this.chatContainer.addChild(new Spacer(1));
    this.ui.requestRender();
  }
  showTip(message) {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(theme.fg("dim", `\u{1F4A1} ${message}`), 1, 0));
    this.ui.requestRender();
  }
  getContextPercent() {
    return this.session.getContextUsage()?.percent ?? void 0;
  }
  showNewVersionNotification(newVersion) {
    const action = theme.fg("accent", getUpdateInstruction("@gsd/pi-coding-agent"));
    const updateInstruction = theme.fg("muted", `New version ${newVersion} is available. `) + action;
    const changelogUrl = theme.fg(
      "accent",
      "https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md"
    );
    const changelogLine = theme.fg("muted", "Changelog: ") + changelogUrl;
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
    this.chatContainer.addChild(
      new Text(
        `${theme.bold(theme.fg("warning", "Update Available"))}
${updateInstruction}
${changelogLine}`,
        1,
        0
      )
    );
    this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
    this.ui.requestRender();
  }
  /**
   * Get all queued messages (read-only).
   * Combines session queue and compaction queue.
   */
  getAllQueuedMessages() {
    return {
      steering: [
        ...this.session.getSteeringMessages(),
        ...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text)
      ],
      followUp: [
        ...this.session.getFollowUpMessages(),
        ...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text)
      ]
    };
  }
  /**
   * Clear all queued messages and return their contents.
   * Clears both session queue and compaction queue.
   */
  clearAllQueues() {
    const { steering, followUp } = this.session.clearQueue();
    const compactionSteering = this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text);
    const compactionFollowUp = this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text);
    this.compactionQueuedMessages = [];
    return {
      steering: [...steering, ...compactionSteering],
      followUp: [...followUp, ...compactionFollowUp]
    };
  }
  updatePendingMessagesDisplay() {
    this.pendingMessagesContainer.clear();
    const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
    if (steeringMessages.length > 0 || followUpMessages.length > 0) {
      this.pendingMessagesContainer.addChild(new Spacer(1));
      for (const message of steeringMessages) {
        const text = theme.fg("dim", `Steering: ${message}`);
        this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
      }
      for (const message of followUpMessages) {
        const text = theme.fg("dim", `Follow-up: ${message}`);
        this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
      }
      const dequeueHint = getAppKeyDisplay(this.keybindings, "dequeue");
      const hintText = theme.fg("dim", `\u21B3 ${dequeueHint} to edit all queued messages`);
      this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
    }
  }
  restoreQueuedMessagesToEditor(options) {
    const { steering, followUp } = this.clearAllQueues();
    const allQueued = [...steering, ...followUp];
    if (allQueued.length === 0) {
      this.updatePendingMessagesDisplay();
      if (options?.abort) {
        this.agent.abort("user");
      }
      return 0;
    }
    const queuedText = allQueued.join("\n\n");
    const currentText = options?.currentText ?? this.editor.getText();
    const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
    this.editor.setText(combinedText);
    this.updatePendingMessagesDisplay();
    if (options?.abort) {
      this.agent.abort("user");
    }
    return allQueued.length;
  }
  queueCompactionMessage(text, mode) {
    if (text.startsWith("/") && !this.isKnownSlashCommand(text)) {
      const command = text.split(/\s/)[0];
      this.showError(`Unknown command: ${command}. Use slash autocomplete to see available commands.`);
      return;
    }
    this.compactionQueuedMessages.push({ text, mode });
    this.editor.addToHistory?.(text);
    this.editor.setText("");
    this.updatePendingMessagesDisplay();
    this.showStatus("Queued message for after compaction");
  }
  isExtensionCommand(text) {
    if (!text.startsWith("/")) return false;
    const extensionRunner = this.session.extensionRunner;
    if (!extensionRunner) return false;
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return !!extensionRunner.getCommand(commandName);
  }
  isKnownSlashCommand(text) {
    if (!text.startsWith("/")) return false;
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    if (BUILTIN_SLASH_COMMANDS.some((command) => command.name === commandName)) {
      return true;
    }
    if (this.isExtensionCommand(text)) {
      return true;
    }
    if (this.session.promptTemplates.some((template) => template.name === commandName)) {
      return true;
    }
    if (commandName.startsWith("skill:") && this.settingsManager.getEnableSkillCommands()) {
      const skillName = commandName.slice("skill:".length);
      return this.session.resourceLoader.getSkills().skills.some((skill) => skill.name === skillName);
    }
    return false;
  }
  async flushCompactionQueue(options) {
    if (this.compactionQueuedMessages.length === 0) {
      return;
    }
    const queuedMessages = [...this.compactionQueuedMessages];
    this.compactionQueuedMessages = [];
    this.updatePendingMessagesDisplay();
    const restoreQueue = (error) => {
      this.session.clearQueue();
      this.compactionQueuedMessages = queuedMessages;
      this.updatePendingMessagesDisplay();
      this.showError(
        `Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)}`
      );
    };
    try {
      if (options?.willRetry) {
        for (const message of queuedMessages) {
          if (this.isExtensionCommand(message.text)) {
            await this.session.prompt(message.text);
          } else if (message.mode === "followUp") {
            await this.session.followUp(message.text);
          } else {
            await this.session.steer(message.text);
          }
        }
        this.updatePendingMessagesDisplay();
        return;
      }
      const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
      if (firstPromptIndex === -1) {
        for (const message of queuedMessages) {
          await this.session.prompt(message.text);
        }
        return;
      }
      const preCommands = queuedMessages.slice(0, firstPromptIndex);
      const firstPrompt = queuedMessages[firstPromptIndex];
      const rest = queuedMessages.slice(firstPromptIndex + 1);
      for (const message of preCommands) {
        await this.session.prompt(message.text);
      }
      const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
        restoreQueue(error);
      });
      for (const message of rest) {
        if (this.isExtensionCommand(message.text)) {
          await this.session.prompt(message.text);
        } else if (message.mode === "followUp") {
          await this.session.followUp(message.text);
        } else {
          await this.session.steer(message.text);
        }
      }
      this.updatePendingMessagesDisplay();
      void promptPromise;
    } catch (error) {
      restoreQueue(error);
    }
  }
  /** Move pending bash components from pending area to chat */
  flushPendingBashComponents() {
    for (const component of this.pendingBashComponents) {
      this.pendingMessagesContainer.removeChild(component);
      this.chatContainer.addChild(component);
    }
    this.pendingBashComponents = [];
  }
  // =========================================================================
  // Selectors
  // =========================================================================
  /**
   * Shows a selector component in place of the editor.
   * @param create Factory that receives a `done` callback and returns the component and focus target
   */
  showSelector(create) {
    const done = () => {
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
    };
    const { component, focus } = create(done);
    this.editorContainer.clear();
    this.editorContainer.addChild(component);
    this.ui.setFocus(focus);
    this.ui.requestRender();
  }
  showSettingsSelector() {
    this.showSelector((done) => {
      const selector = new SettingsSelectorComponent(
        {
          autoCompact: this.session.autoCompactionEnabled,
          showImages: this.settingsManager.getShowImages(),
          autoResizeImages: this.settingsManager.getImageAutoResize(),
          blockImages: this.settingsManager.getBlockImages(),
          enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
          steeringMode: this.session.steeringMode,
          followUpMode: this.session.followUpMode,
          transport: this.settingsManager.getTransport(),
          thinkingLevel: this.session.thinkingLevel,
          availableThinkingLevels: this.session.getAvailableThinkingLevels(),
          currentTheme: this.settingsManager.getTheme() || "dark",
          availableThemes: getAvailableThemes(),
          hideThinkingBlock: this.hideThinkingBlock,
          collapseChangelog: this.settingsManager.getCollapseChangelog(),
          doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
          treeFilterMode: this.settingsManager.getTreeFilterMode(),
          showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
          editorPaddingX: this.settingsManager.getEditorPaddingX(),
          autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
          respectGitignoreInPicker: this.settingsManager.getRespectGitignoreInPicker(),
          quietStartup: this.settingsManager.getQuietStartup(),
          clearOnShrink: this.settingsManager.getClearOnShrink(),
          timestampFormat: this.settingsManager.getTimestampFormat(),
          adaptiveMode: this.settingsManager.getAdaptiveMode()
        },
        {
          onAutoCompactChange: (enabled) => {
            this.session.setAutoCompactionEnabled(enabled);
            this.footer.setAutoCompactEnabled(enabled);
          },
          onShowImagesChange: (enabled) => {
            this.settingsManager.setShowImages(enabled);
            for (const child of this.chatContainer.children) {
              if (child instanceof ToolExecutionComponent) {
                child.setShowImages(enabled);
              }
            }
          },
          onAutoResizeImagesChange: (enabled) => {
            this.settingsManager.setImageAutoResize(enabled);
          },
          onBlockImagesChange: (blocked) => {
            this.settingsManager.setBlockImages(blocked);
          },
          onEnableSkillCommandsChange: (enabled) => {
            this.settingsManager.setEnableSkillCommands(enabled);
            this.setupAutocomplete();
          },
          onSteeringModeChange: (mode) => {
            this.session.setSteeringMode(mode);
          },
          onFollowUpModeChange: (mode) => {
            this.session.setFollowUpMode(mode);
          },
          onTransportChange: (transport) => {
            this.settingsManager.setTransport(transport);
            this.session.agent.setTransport(transport);
          },
          onThinkingLevelChange: (level) => {
            this.session.setThinkingLevel(level);
            this.footer.invalidate();
            this.updateEditorBorderColor();
          },
          onThemeChange: (themeName) => {
            const result = setTheme(themeName, true);
            this.settingsManager.setTheme(themeName);
            this.ui.invalidate();
            if (!result.success) {
              this.showError(`Failed to load theme "${themeName}": ${result.error}
Fell back to dark theme.`);
            }
          },
          onThemePreview: (themeName) => {
            const result = setTheme(themeName, true);
            if (result.success) {
              this.ui.invalidate();
              this.ui.requestRender();
            }
          },
          onHideThinkingBlockChange: (hidden) => {
            this.hideThinkingBlock = hidden;
            this.settingsManager.setHideThinkingBlock(hidden);
            for (const child of this.chatContainer.children) {
              if (child instanceof AssistantMessageComponent) {
                child.setHideThinkingBlock(hidden);
              }
            }
            this.chatContainer.clear();
            this.rebuildChatFromMessages();
          },
          onCollapseChangelogChange: (collapsed) => {
            this.settingsManager.setCollapseChangelog(collapsed);
          },
          onQuietStartupChange: (enabled) => {
            this.settingsManager.setQuietStartup(enabled);
          },
          onDoubleEscapeActionChange: (action) => {
            this.settingsManager.setDoubleEscapeAction(action);
          },
          onTreeFilterModeChange: (mode) => {
            this.settingsManager.setTreeFilterMode(mode);
          },
          onShowHardwareCursorChange: (enabled) => {
            this.settingsManager.setShowHardwareCursor(enabled);
            this.ui.setShowHardwareCursor(enabled);
          },
          onEditorPaddingXChange: (padding) => {
            this.settingsManager.setEditorPaddingX(padding);
            this.defaultEditor.setPaddingX(padding);
            if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== void 0) {
              this.editor.setPaddingX(padding);
            }
          },
          onAutocompleteMaxVisibleChange: (maxVisible) => {
            this.settingsManager.setAutocompleteMaxVisible(maxVisible);
            this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
            if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== void 0) {
              this.editor.setAutocompleteMaxVisible(maxVisible);
            }
          },
          onClearOnShrinkChange: (enabled) => {
            this.settingsManager.setClearOnShrink(enabled);
            this.ui.setClearOnShrink(enabled);
          },
          onRespectGitignoreInPickerChange: (enabled) => {
            this.settingsManager.setRespectGitignoreInPicker(enabled);
            this.autocompleteProvider?.setRespectGitignore(enabled);
          },
          onTimestampFormatChange: (format) => {
            this.settingsManager.setTimestampFormat(format);
          },
          onAdaptiveModeChange: (mode) => {
            this.settingsManager.setAdaptiveMode(mode);
            this.ui.requestRender();
          },
          onCancel: () => {
            done();
            this.ui.requestRender();
          }
        }
      );
      return { component: selector, focus: selector.getSettingsList() };
    });
  }
  async handleModelCommand(searchTerm) {
    await handleModelCommandController(this, searchTerm);
  }
  async findExactModelMatch(searchTerm) {
    return findExactModelMatchController(this, searchTerm);
  }
  async getModelCandidates() {
    return getModelCandidatesController(this);
  }
  /** Update the footer's available provider count from current model candidates */
  async updateAvailableProviderCount() {
    await updateAvailableProviderCountController(this);
  }
  showModelSelector(initialSearchInput) {
    this.showSelector((done) => {
      const selector = new ModelSelectorComponent(
        this.ui,
        this.session.model,
        this.settingsManager,
        this.session.modelRegistry,
        this.session.scopedModels,
        async (model) => {
          try {
            await this.session.setModel(model);
            this.footer.invalidate();
            this.updateEditorBorderColor();
            done();
            this.showStatus(`Model: ${model.id}`);
            this.checkDaxnutsEasterEgg(model);
          } catch (error) {
            done();
            this.showError(error instanceof Error ? error.message : String(error));
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
        initialSearchInput
      );
      return { component: selector, focus: selector };
    });
  }
  async showModelsSelector() {
    this.session.modelRegistry.refresh();
    const allModels = this.session.modelRegistry.getAvailable();
    if (allModels.length === 0) {
      this.showStatus("No models available");
      return;
    }
    const sessionScopedModels = this.session.scopedModels;
    const hasSessionScope = sessionScopedModels.length > 0;
    const enabledModelIds = /* @__PURE__ */ new Set();
    let hasFilter = false;
    if (hasSessionScope) {
      for (const sm of sessionScopedModels) {
        enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
      }
      hasFilter = true;
    } else {
      const patterns = this.settingsManager.getEnabledModels();
      if (patterns !== void 0 && patterns.length > 0) {
        hasFilter = true;
        const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
        for (const sm of scopedModels) {
          enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
        }
      }
    }
    const currentEnabledIds = new Set(enabledModelIds);
    let currentHasFilter = hasFilter;
    const updateSessionModels = async (enabledIds) => {
      if (enabledIds.size > 0 && enabledIds.size < allModels.length) {
        const newScopedModels = await resolveModelScope(Array.from(enabledIds), this.session.modelRegistry);
        this.session.setScopedModels(
          newScopedModels.map((sm) => ({
            model: sm.model,
            thinkingLevel: sm.thinkingLevel
          }))
        );
      } else {
        this.session.setScopedModels([]);
      }
      await this.updateAvailableProviderCount();
      this.ui.requestRender();
    };
    this.showSelector((done) => {
      const selector = new ScopedModelsSelectorComponent(
        {
          allModels,
          enabledModelIds: currentEnabledIds,
          hasEnabledModelsFilter: currentHasFilter
        },
        {
          onModelToggle: async (modelId, enabled) => {
            if (enabled) {
              currentEnabledIds.add(modelId);
            } else {
              currentEnabledIds.delete(modelId);
            }
            currentHasFilter = true;
            await updateSessionModels(currentEnabledIds);
          },
          onEnableAll: async (allModelIds) => {
            currentEnabledIds.clear();
            for (const id of allModelIds) {
              currentEnabledIds.add(id);
            }
            currentHasFilter = false;
            await updateSessionModels(currentEnabledIds);
          },
          onClearAll: async () => {
            currentEnabledIds.clear();
            currentHasFilter = true;
            await updateSessionModels(currentEnabledIds);
          },
          onToggleProvider: async (_provider, modelIds, enabled) => {
            for (const id of modelIds) {
              if (enabled) {
                currentEnabledIds.add(id);
              } else {
                currentEnabledIds.delete(id);
              }
            }
            currentHasFilter = true;
            await updateSessionModels(currentEnabledIds);
          },
          onPersist: (enabledIds) => {
            const newPatterns = enabledIds.length === allModels.length ? void 0 : enabledIds;
            this.settingsManager.setEnabledModels(newPatterns);
            this.showStatus("Model selection saved to settings");
          },
          onCancel: () => {
            done();
            this.ui.requestRender();
          }
        }
      );
      return { component: selector, focus: selector };
    });
  }
  showUserMessageSelector() {
    const userMessages = this.session.getUserMessagesForForking();
    if (userMessages.length === 0) {
      this.showStatus("No messages to fork from");
      return;
    }
    this.showSelector((done) => {
      const selector = new UserMessageSelectorComponent(
        userMessages.map((m) => ({ id: m.entryId, text: m.text })),
        async (entryId) => {
          const result = await this.session.fork(entryId);
          if (result.cancelled) {
            done();
            this.ui.requestRender();
            return;
          }
          this.chatContainer.clear();
          this.renderInitialMessages();
          this.editor.setText(result.selectedText);
          done();
          this.showStatus("Branched to new session");
        },
        () => {
          done();
          this.ui.requestRender();
        }
      );
      return { component: selector, focus: selector.getMessageList() };
    });
  }
  showTreeSelector(initialSelectedId) {
    const tree = this.sessionManager.getTree();
    const realLeafId = this.sessionManager.getLeafId();
    const initialFilterMode = this.settingsManager.getTreeFilterMode();
    if (tree.length === 0) {
      this.showStatus("No entries in session");
      return;
    }
    this.showSelector((done) => {
      const selector = new TreeSelectorComponent(
        tree,
        realLeafId,
        this.ui.terminal.rows,
        async (entryId) => {
          if (entryId === realLeafId) {
            done();
            this.showStatus("Already at this point");
            return;
          }
          done();
          let wantsSummary = false;
          let customInstructions;
          if (!this.settingsManager.getBranchSummarySkipPrompt()) {
            while (true) {
              const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
                "No summary",
                "Summarize",
                "Summarize with custom prompt"
              ]);
              if (summaryChoice === void 0) {
                this.showTreeSelector(entryId);
                return;
              }
              wantsSummary = summaryChoice !== "No summary";
              if (summaryChoice === "Summarize with custom prompt") {
                customInstructions = await this.showExtensionEditor("Custom summarization instructions");
                if (customInstructions === void 0) {
                  continue;
                }
              }
              break;
            }
          }
          let summaryLoader;
          const originalOnEscape = this.defaultEditor.onEscape;
          if (wantsSummary) {
            this.defaultEditor.onEscape = () => {
              this.session.abortBranchSummary();
            };
            this.chatContainer.addChild(new Spacer(1));
            summaryLoader = new Loader(
              this.ui,
              (spinner) => theme.fg("accent", spinner),
              (text) => theme.fg("muted", text),
              `Summarizing branch... (${appKey(this.keybindings, "interrupt")} to cancel)`
            );
            this.statusContainer.addChild(summaryLoader);
            this.ui.requestRender();
          }
          try {
            const result = await this.session.navigateTree(entryId, {
              summarize: wantsSummary,
              customInstructions
            });
            if (result.aborted) {
              this.showStatus("Branch summarization cancelled");
              this.showTreeSelector(entryId);
              return;
            }
            if (result.cancelled) {
              this.showStatus("Navigation cancelled");
              return;
            }
            this.chatContainer.clear();
            this.renderInitialMessages();
            if (result.editorText && !this.editor.getText().trim()) {
              this.editor.setText(result.editorText);
            }
            this.showStatus("Navigated to selected point");
          } catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
          } finally {
            if (summaryLoader) {
              summaryLoader.stop();
              this.statusContainer.clear();
            }
            this.defaultEditor.onEscape = originalOnEscape;
          }
        },
        () => {
          done();
          this.ui.requestRender();
        },
        (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
          this.ui.requestRender();
        },
        initialSelectedId,
        initialFilterMode
      );
      return { component: selector, focus: selector };
    });
  }
  showSessionSelector() {
    this.showSelector((done) => {
      const selector = new SessionSelectorComponent(
        (onProgress) => SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
        SessionManager.listAll,
        async (sessionPath) => {
          done();
          await this.handleResumeSession(sessionPath);
        },
        () => {
          done();
          this.ui.requestRender();
        },
        () => {
          void this.shutdown();
        },
        () => this.ui.requestRender(),
        {
          renameSession: async (sessionFilePath, nextName) => {
            const next = (nextName ?? "").trim();
            if (!next) return;
            const mgr = SessionManager.open(sessionFilePath);
            mgr.appendSessionInfo(next);
          },
          showRenameHint: true,
          keybindings: this.keybindings
        },
        this.sessionManager.getSessionFile()
      );
      return { component: selector, focus: selector };
    });
  }
  async handleResumeSession(sessionPath) {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = void 0;
    }
    this.statusContainer.clear();
    this.pendingMessagesContainer.clear();
    this.compactionQueuedMessages = [];
    this.streamingComponent = void 0;
    this.streamingMessage = void 0;
    this.pendingTools.clear();
    this.clearBlockingError();
    await this.session.switchSession(sessionPath);
    this.chatContainer.clear();
    this.renderInitialMessages();
    if (this.session.sessionManager.wasInterrupted()) {
      this.showStatus("Resumed session (previous session ended unexpectedly \u2014 last action may be incomplete)");
    } else {
      this.showStatus("Resumed session");
    }
  }
  showProviderManager() {
    this.showSelector((done) => {
      const component = new ProviderManagerComponent(
        this.ui,
        this.session.modelRegistry.authStorage,
        this.session.modelRegistry,
        () => {
          done();
          this.ui.requestRender();
        },
        async (provider) => {
          this.showStatus(`Discovering models for ${provider}...`);
          try {
            const results = await this.session.modelRegistry.discoverModels([provider]);
            const result = results[0];
            if (result?.error) {
              this.showError(`Discovery failed: ${result.error}`);
            } else {
              this.showStatus(`Discovered ${result?.models.length ?? 0} models from ${provider}`);
            }
          } catch (error) {
            this.showError(error instanceof Error ? error.message : String(error));
          }
          done();
          this.ui.requestRender();
        },
        async (provider) => {
          const isOAuthProvider = this.session.modelRegistry.authStorage.getOAuthProviders().some((p) => p.id === provider);
          if (!isOAuthProvider) {
            done();
            this.showStatus(`${provider} uses external CLI auth \u2014 use /model to select a model or run the provider's own auth command.`);
            return;
          }
          done();
          await this.showLoginDialog(provider);
        }
      );
      return { component, focus: component };
    });
  }
  async showOAuthSelector(mode) {
    if (mode === "logout") {
      const providers = this.session.modelRegistry.authStorage.list();
      const loggedInProviders = providers.filter(
        (p) => this.session.modelRegistry.authStorage.get(p)?.type === "oauth"
      );
      if (loggedInProviders.length === 0) {
        this.showStatus("No OAuth providers logged in. Use /login first.");
        return;
      }
    }
    this.showSelector((done) => {
      const selector = new OAuthSelectorComponent(
        mode,
        this.session.modelRegistry.authStorage,
        (providerId) => {
          done();
          const handleAsync = async () => {
            if (mode === "login") {
              await this.showLoginDialog(providerId);
            } else {
              const providerInfo = this.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
              const providerName = providerInfo?.name || providerId;
              try {
                this.session.modelRegistry.authStorage.logout(providerId);
                this.session.modelRegistry.refresh();
                await this.updateAvailableProviderCount();
                const currentModel = this.session.model;
                if (currentModel?.provider === providerId) {
                  try {
                    const available = this.session.modelRegistry.getAvailable();
                    const fallback = available.find((m) => m.provider !== providerId);
                    if (fallback) {
                      await this.session.setModel(fallback);
                    }
                  } catch {
                  }
                }
                this.showStatus(`Logged out of ${providerName}`);
              } catch (error) {
                this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          };
          handleAsync().catch(() => {
          });
        },
        () => {
          done();
          this.ui.requestRender();
        }
      );
      return { component: selector, focus: selector };
    });
  }
  async showLoginDialog(providerId) {
    const providerInfo = this.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
    const providerName = providerInfo?.name || providerId;
    const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;
    const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {
    });
    this.editorContainer.clear();
    this.editorContainer.addChild(dialog);
    this.ui.setFocus(dialog);
    this.ui.requestRender();
    const restoreEditor = () => {
      dialog.dispose();
      this.editorContainer.clear();
      this.editorContainer.addChild(this.editor);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    };
    try {
      await this.session.modelRegistry.authStorage.login(providerId, {
        onAuth: (info) => {
          dialog.showAuth(info.url, info.instructions);
          if (!usesCallbackServer && providerId === "github-copilot") {
            dialog.showWaiting("Waiting for browser authentication...");
          }
        },
        onPrompt: async (prompt) => {
          return dialog.showPrompt(prompt.message, prompt.placeholder);
        },
        onProgress: (message) => {
          dialog.showProgress(message);
        },
        // Callback-server providers race browser callback with pasted redirect URL.
        // Keep manual-input promise ownership inside provider flow to avoid
        // orphaned rejections when the callback is not consumed.
        onManualCodeInput: usesCallbackServer ? () => dialog.showManualInput("Paste redirect URL below, or complete login in browser:") : void 0,
        signal: dialog.signal
      });
      restoreEditor();
      this.session.modelRegistry.refresh();
      await this.updateAvailableProviderCount();
      try {
        const currentModel = this.session.model;
        if (currentModel) {
          const currentKey = await this.session.modelRegistry.getApiKey(currentModel);
          if (!currentKey) {
            const available = this.session.modelRegistry.getAvailable();
            const newProviderModel = available.find((m) => m.provider === providerId);
            if (newProviderModel) {
              await this.session.setModel(newProviderModel);
            } else if (available.length > 0) {
              await this.session.setModel(available[0]);
            }
          }
        }
      } catch (error) {
      }
      this.showStatus(`Logged in to ${providerName}. Credentials saved to ${getAuthPath()}`);
    } catch (error) {
      restoreEditor();
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg !== "Login cancelled" && !errorMsg.includes("Superseded") && !errorMsg.includes("disposed")) {
        this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
      }
    }
  }
  // =========================================================================
  // Command handlers
  // =========================================================================
  async handleReloadCommand() {
    if (this.session.isStreaming) {
      this.showWarning("Wait for the current response to finish before reloading.");
      return;
    }
    if (this.session.isCompacting) {
      this.showWarning("Wait for compaction to finish before reloading.");
      return;
    }
    this.resetExtensionUI();
    const loader = new BorderedLoader(this.ui, theme, "Reloading extensions, skills, prompts, themes...", {
      cancellable: false
    });
    const previousEditor = this.editor;
    this.editorContainer.clear();
    this.editorContainer.addChild(loader);
    this.ui.setFocus(loader);
    this.ui.requestRender();
    const dismissLoader = (editor) => {
      loader.dispose();
      this.editorContainer.clear();
      this.editorContainer.addChild(editor);
      this.ui.setFocus(editor);
      this.ui.requestRender();
    };
    try {
      await this.session.reload();
      setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
      this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
      const themeName = this.settingsManager.getTheme();
      const themeResult = themeName ? setTheme(themeName, true) : { success: true };
      if (!themeResult.success) {
        this.showError(`Failed to load theme "${themeName}": ${themeResult.error}
Fell back to dark theme.`);
      }
      const editorPaddingX = this.settingsManager.getEditorPaddingX();
      const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
      this.defaultEditor.setPaddingX(editorPaddingX);
      this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
      if (this.editor !== this.defaultEditor) {
        this.editor.setPaddingX?.(editorPaddingX);
        this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
      }
      this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
      this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
      this.setupAutocomplete();
      const runner = this.session.extensionRunner;
      if (runner) {
        this.setupExtensionShortcuts(runner);
      }
      this.rebuildChatFromMessages();
      dismissLoader(this.editor);
      this.showLoadedResources({
        extensionPaths: runner?.getExtensionPaths() ?? [],
        force: false,
        showDiagnosticsWhenQuiet: true
      });
      const modelsJsonError = this.session.modelRegistry.getError();
      if (modelsJsonError) {
        this.showError(`models.json error: ${modelsJsonError}`);
      }
      this.showStatus("Reloaded extensions, skills, prompts, themes");
    } catch (error) {
      dismissLoader(previousEditor);
      this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async handleClearCommand() {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = void 0;
    }
    this.statusContainer.clear();
    await this.session.newSession();
    this.headerContainer.clear();
    this.chatContainer.clear();
    this.pendingMessagesContainer.clear();
    this.compactionQueuedMessages = [];
    this.streamingComponent = void 0;
    this.streamingMessage = void 0;
    this.pendingTools.clear();
    this.pendingImages.length = 0;
    this.clearBlockingError();
    this.contextualTips.reset();
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new Text(`${theme.fg("accent", "\u2713 New session started")}`, 1, 1));
    this.ui.requestRender();
  }
  handleDebugCommand() {
    const width = this.ui.terminal.columns;
    const height = this.ui.terminal.rows;
    const allLines = this.ui.render(width);
    const debugLogPath = getDebugLogPath();
    const debugData = [
      `Debug output at ${(/* @__PURE__ */ new Date()).toISOString()}`,
      `Terminal: ${width}x${height}`,
      `Total lines: ${allLines.length}`,
      "",
      "=== All rendered lines with visible widths ===",
      ...allLines.map((line, idx) => {
        const vw = visibleWidth(line);
        const escaped = JSON.stringify(line);
        return `[${idx}] (w=${vw}) ${escaped}`;
      }),
      "",
      "=== Agent messages (JSONL) ===",
      ...this.session.messages.map((msg) => JSON.stringify(msg)),
      ""
    ].join("\n");
    fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
    fs.writeFileSync(debugLogPath, debugData);
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(
      new Text(`${theme.fg("accent", "\u2713 Debug log written")}
${theme.fg("muted", debugLogPath)}`, 1, 1)
    );
    this.ui.requestRender();
  }
  handleDaxnuts() {
    this.chatContainer.addChild(new Spacer(1));
    this.chatContainer.addChild(new DaxnutsComponent(this.ui));
    this.ui.requestRender();
  }
  checkDaxnutsEasterEgg(model) {
    if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
      this.handleDaxnuts();
    }
  }
  async handleBashCommand(command, excludeFromContext = false, displayCommand, loginShell) {
    const extensionRunner = this.session.extensionRunner;
    const label = displayCommand || command;
    const eventResult = extensionRunner ? await extensionRunner.emitUserBash({
      type: "user_bash",
      command,
      excludeFromContext,
      cwd: process.cwd()
    }) : void 0;
    if (eventResult?.result) {
      const result = eventResult.result;
      this.bashComponent = new BashExecutionComponent(label, this.ui, excludeFromContext);
      if (this.session.isStreaming) {
        this.pendingMessagesContainer.addChild(this.bashComponent);
        this.pendingBashComponents.push(this.bashComponent);
      } else {
        this.chatContainer.addChild(this.bashComponent);
      }
      if (result.output) {
        this.bashComponent.appendOutput(result.output);
      }
      this.bashComponent.setComplete(
        result.exitCode,
        result.cancelled,
        result.truncated ? { truncated: true, content: result.output } : void 0,
        result.fullOutputPath
      );
      this.session.recordBashResult(command, result, { excludeFromContext });
      this.bashComponent = void 0;
      this.ui.requestRender();
      return;
    }
    const isDeferred = this.session.isStreaming;
    this.bashComponent = new BashExecutionComponent(label, this.ui, excludeFromContext);
    if (isDeferred) {
      this.pendingMessagesContainer.addChild(this.bashComponent);
      this.pendingBashComponents.push(this.bashComponent);
    } else {
      this.chatContainer.addChild(this.bashComponent);
    }
    this.ui.requestRender();
    try {
      const result = await this.session.executeBash(
        command,
        (chunk) => {
          if (this.bashComponent) {
            this.bashComponent.appendOutput(chunk);
            this.ui.requestRender();
          }
        },
        { excludeFromContext, operations: eventResult?.operations, loginShell }
      );
      if (this.bashComponent) {
        this.bashComponent.setComplete(
          result.exitCode,
          result.cancelled,
          result.truncated ? { truncated: true, content: result.output } : void 0,
          result.fullOutputPath
        );
      }
    } catch (error) {
      if (this.bashComponent) {
        this.bashComponent.setComplete(void 0, false);
      }
      this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    this.bashComponent = void 0;
    this.ui.requestRender();
  }
  async executeCompaction(customInstructions, isAuto = false) {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = void 0;
    }
    this.statusContainer.clear();
    const originalOnEscape = this.defaultEditor.onEscape;
    this.defaultEditor.onEscape = () => {
      this.session.abortCompaction();
    };
    this.chatContainer.addChild(new Spacer(1));
    const cancelHint = `(${appKey(this.keybindings, "interrupt")} to cancel)`;
    const label = isAuto ? `Auto-compacting context... ${cancelHint}` : `Compacting context... ${cancelHint}`;
    const compactingLoader = new Loader(
      this.ui,
      (spinner) => theme.fg("accent", spinner),
      (text) => theme.fg("muted", text),
      label
    );
    this.statusContainer.addChild(compactingLoader);
    this.ui.requestRender();
    let result;
    try {
      result = await this.session.compact(customInstructions);
      this.rebuildChatFromMessages();
      const msg = createCompactionSummaryMessage(result.summary, result.tokensBefore, (/* @__PURE__ */ new Date()).toISOString());
      this.addMessageToChat(msg);
      this.footer.invalidate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "Compaction cancelled" || error instanceof Error && error.name === "AbortError") {
        this.showError("Compaction cancelled");
      } else {
        this.showError(`Compaction failed: ${message}`);
      }
    } finally {
      compactingLoader.stop();
      this.statusContainer.clear();
      this.defaultEditor.onEscape = originalOnEscape;
    }
    void this.flushCompactionQueue({ willRetry: false });
    return result;
  }
  requestRender(force = false) {
    if (!this.isInitialized) return;
    this.ui.requestRender(force);
  }
  stop() {
    if (this.loadingAnimation) {
      this.loadingAnimation.stop();
      this.loadingAnimation = void 0;
    }
    this.clearExtensionTerminalInputListeners();
    this._branchChangeUnsub?.();
    this._branchChangeUnsub = void 0;
    onThemeChange(() => {
    });
    stopThemeWatcher();
    if (this.onInputCallback) {
      this.onInputCallback("");
      this.onInputCallback = void 0;
    }
    this.clearExtensionWidgets();
    if (this.customFooter?.dispose) {
      this.customFooter.dispose();
    }
    this.customFooter = void 0;
    if (this.customHeader?.dispose) {
      this.customHeader.dispose();
    }
    this.customHeader = void 0;
    this.autocompleteProvider = void 0;
    this.footer.dispose();
    this.footerDataProvider.dispose();
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    if (this.isInitialized) {
      this.ui.stop();
      this.isInitialized = false;
    }
  }
}
export {
  InteractiveMode,
  buildAssistantReplaySegments,
  renderBlockingErrorBanner,
  renderExtensionNotifyInChat,
  shouldRenderExtensionNotifyInChat
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9pbnRlcmFjdGl2ZS9pbnRlcmFjdGl2ZS1tb2RlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogSW50ZXJhY3RpdmUgVFVJIG1vZGUgYW5kIHNlc3Npb24gVUkgcmVuZGVyaW5nLlxuLy8gR1NEMiAtIEludGVyYWN0aXZlIFRVSSBtb2RlIGZvciBjb2RpbmctYWdlbnQgc2Vzc2lvbnMuXG4vKipcbiAqIEludGVyYWN0aXZlIG1vZGUgZm9yIHRoZSBjb2RpbmcgYWdlbnQuXG4gKiBIYW5kbGVzIFRVSSByZW5kZXJpbmcgYW5kIHVzZXIgaW50ZXJhY3Rpb24sIGRlbGVnYXRpbmcgYnVzaW5lc3MgbG9naWMgdG8gQWdlbnRTZXNzaW9uLlxuICovXG5cbmltcG9ydCAqIGFzIGZzIGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgKiBhcyBvcyBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBsaXN0RGVzY2VuZGFudHMgfSBmcm9tIFwiQGdzZC9uYXRpdmVcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRNZXNzYWdlIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHR5cGUgeyBBc3Npc3RhbnRNZXNzYWdlLCBJbWFnZUNvbnRlbnQsIE1lc3NhZ2UsIE1vZGVsLCBPQXV0aFByb3ZpZGVySWQgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHR5cGUge1xuXHRBdXRvY29tcGxldGVJdGVtLFxuXHRFZGl0b3JDb21wb25lbnQsXG5cdEVkaXRvclRoZW1lLFxuXHRLZXlJZCxcblx0TWFya2Rvd25UaGVtZSxcblx0T3ZlcmxheUhhbmRsZSxcblx0T3ZlcmxheU9wdGlvbnMsXG5cdFNsYXNoQ29tbWFuZCxcbn0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQge1xuXHRDb21iaW5lZEF1dG9jb21wbGV0ZVByb3ZpZGVyLFxuXHR0eXBlIENvbXBvbmVudCxcblx0Q29udGFpbmVyLFxuXHRmdXp6eUZpbHRlcixcblx0TG9hZGVyLFxuXHRNYXJrZG93bixcblx0bWF0Y2hlc0tleSxcblx0UHJvY2Vzc1Rlcm1pbmFsLFxuXHRTcGFjZXIsXG5cdHR5cGUgVGVybWluYWwgYXMgVHVpVGVybWluYWwsXG5cdFRleHQsXG5cdFRydW5jYXRlZFRleHQsXG5cdFRVSSxcblx0dmlzaWJsZVdpZHRoLFxufSBmcm9tIFwiQGdzZC9waS10dWlcIjtcbmltcG9ydCB7IHNwYXduLCBzcGF3blN5bmMgfSBmcm9tIFwiY2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcblx0QVBQX05BTUUsXG5cdGdldEF1dGhQYXRoLFxuXHRnZXREZWJ1Z0xvZ1BhdGgsXG5cdGdldFVwZGF0ZUluc3RydWN0aW9uLFxuXHRWRVJTSU9OLFxufSBmcm9tIFwiLi4vLi4vY29uZmlnLmpzXCI7XG5pbXBvcnQgeyB0eXBlIEFnZW50U2Vzc2lvbiwgdHlwZSBBZ2VudFNlc3Npb25FdmVudCwgcGFyc2VTa2lsbEJsb2NrIH0gZnJvbSBcIi4uLy4uL2NvcmUvYWdlbnQtc2Vzc2lvbi5qc1wiO1xuaW1wb3J0IHR5cGUgeyBDb21wYWN0aW9uUmVzdWx0IH0gZnJvbSBcIi4uLy4uL2NvcmUvY29tcGFjdGlvbi9pbmRleC5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRFeHRlbnNpb25Db250ZXh0LFxuXHRFeHRlbnNpb25SdW5uZXIsXG5cdEV4dGVuc2lvblVJQ29udGV4dCxcblx0RXh0ZW5zaW9uVUlEaWFsb2dPcHRpb25zLFxuXHRFeHRlbnNpb25XaWRnZXRPcHRpb25zLFxufSBmcm9tIFwiLi4vLi4vY29yZS9leHRlbnNpb25zL2luZGV4LmpzXCI7XG5pbXBvcnQgeyBGb290ZXJEYXRhUHJvdmlkZXIsIHR5cGUgUmVhZG9ubHlGb290ZXJEYXRhUHJvdmlkZXIgfSBmcm9tIFwiLi4vLi4vY29yZS9mb290ZXItZGF0YS1wcm92aWRlci5qc1wiO1xuaW1wb3J0IHsgdHlwZSBBcHBBY3Rpb24sIEtleWJpbmRpbmdzTWFuYWdlciB9IGZyb20gXCIuLi8uLi9jb3JlL2tleWJpbmRpbmdzLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVDb21wYWN0aW9uU3VtbWFyeU1lc3NhZ2UgfSBmcm9tIFwiLi4vLi4vY29yZS9tZXNzYWdlcy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1vZGVsU2NvcGUgfSBmcm9tIFwiLi4vLi4vY29yZS9tb2RlbC1yZXNvbHZlci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBSZXNvdXJjZURpYWdub3N0aWMgfSBmcm9tIFwiLi4vLi4vY29yZS9yZXNvdXJjZS1sb2FkZXIuanNcIjtcbmltcG9ydCB7IHR5cGUgU2Vzc2lvbkNvbnRleHQsIFNlc3Npb25NYW5hZ2VyIH0gZnJvbSBcIi4uLy4uL2NvcmUvc2Vzc2lvbi1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyBCVUlMVElOX1NMQVNIX0NPTU1BTkRTIH0gZnJvbSBcIi4uLy4uL2NvcmUvc2xhc2gtY29tbWFuZHMuanNcIjtcbmltcG9ydCB0eXBlIHsgVHJ1bmNhdGlvblJlc3VsdCB9IGZyb20gXCIuLi8uLi9jb3JlL3Rvb2xzL3RydW5jYXRlLmpzXCI7XG5pbXBvcnQgeyBnZXRDaGFuZ2Vsb2dQYXRoLCBnZXROZXdFbnRyaWVzLCBwYXJzZUNoYW5nZWxvZyB9IGZyb20gXCIuLi8uLi91dGlscy9jaGFuZ2Vsb2cuanNcIjtcbmltcG9ydCB7IHJlYWRDbGlwYm9hcmRJbWFnZSB9IGZyb20gXCIuLi8uLi91dGlscy9jbGlwYm9hcmQtaW1hZ2UuanNcIjtcbmltcG9ydCB7IGVuc3VyZVRvb2wgfSBmcm9tIFwiLi4vLi4vdXRpbHMvdG9vbHMtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvYXNzaXN0YW50LW1lc3NhZ2UuanNcIjtcbmltcG9ydCB7IEFkYXB0aXZlTGF5b3V0Q29tcG9uZW50IH0gZnJvbSBcIi4vY29tcG9uZW50cy9hZGFwdGl2ZS1sYXlvdXQuanNcIjtcbmltcG9ydCB7IEJhc2hFeGVjdXRpb25Db21wb25lbnQgfSBmcm9tIFwiLi9jb21wb25lbnRzL2Jhc2gtZXhlY3V0aW9uLmpzXCI7XG5pbXBvcnQgeyBCb3JkZXJlZExvYWRlciB9IGZyb20gXCIuL2NvbXBvbmVudHMvYm9yZGVyZWQtbG9hZGVyLmpzXCI7XG5pbXBvcnQgeyBCcmFuY2hTdW1tYXJ5TWVzc2FnZUNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvYnJhbmNoLXN1bW1hcnktbWVzc2FnZS5qc1wiO1xuaW1wb3J0IHsgQ29tcGFjdGlvblN1bW1hcnlNZXNzYWdlQ29tcG9uZW50IH0gZnJvbSBcIi4vY29tcG9uZW50cy9jb21wYWN0aW9uLXN1bW1hcnktbWVzc2FnZS5qc1wiO1xuaW1wb3J0IHsgQ3VzdG9tRWRpdG9yIH0gZnJvbSBcIi4vY29tcG9uZW50cy9jdXN0b20tZWRpdG9yLmpzXCI7XG5pbXBvcnQgeyBDdXN0b21NZXNzYWdlQ29tcG9uZW50IH0gZnJvbSBcIi4vY29tcG9uZW50cy9jdXN0b20tbWVzc2FnZS5qc1wiO1xuaW1wb3J0IHsgRGF4bnV0c0NvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvZGF4bnV0cy5qc1wiO1xuaW1wb3J0IHsgRHluYW1pY0JvcmRlciB9IGZyb20gXCIuL2NvbXBvbmVudHMvZHluYW1pYy1ib3JkZXIuanNcIjtcbmltcG9ydCB7IEV4dGVuc2lvbkVkaXRvckNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvZXh0ZW5zaW9uLWVkaXRvci5qc1wiO1xuaW1wb3J0IHsgRXh0ZW5zaW9uSW5wdXRDb21wb25lbnQgfSBmcm9tIFwiLi9jb21wb25lbnRzL2V4dGVuc2lvbi1pbnB1dC5qc1wiO1xuaW1wb3J0IHsgRXh0ZW5zaW9uU2VsZWN0b3JDb21wb25lbnQgfSBmcm9tIFwiLi9jb21wb25lbnRzL2V4dGVuc2lvbi1zZWxlY3Rvci5qc1wiO1xuaW1wb3J0IHsgRm9vdGVyQ29tcG9uZW50IH0gZnJvbSBcIi4vY29tcG9uZW50cy9mb290ZXIuanNcIjtcbmltcG9ydCB7IGFwcEtleSwgYXBwS2V5SGludCwgZWRpdG9yS2V5LCBmb3JtYXRLZXlGb3JEaXNwbGF5LCBrZXlIaW50LCByYXdLZXlIaW50IH0gZnJvbSBcIi4vY29tcG9uZW50cy9rZXliaW5kaW5nLWhpbnRzLmpzXCI7XG5pbXBvcnQgeyBMb2dpbkRpYWxvZ0NvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvbG9naW4tZGlhbG9nLmpzXCI7XG5pbXBvcnQgeyBNb2RlbFNlbGVjdG9yQ29tcG9uZW50LCBwcm92aWRlckRpc3BsYXlOYW1lIH0gZnJvbSBcIi4vY29tcG9uZW50cy9tb2RlbC1zZWxlY3Rvci5qc1wiO1xuaW1wb3J0IHsgT0F1dGhTZWxlY3RvckNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvb2F1dGgtc2VsZWN0b3IuanNcIjtcbmltcG9ydCB7IFByb3ZpZGVyTWFuYWdlckNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvcHJvdmlkZXItbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgU2NvcGVkTW9kZWxzU2VsZWN0b3JDb21wb25lbnQgfSBmcm9tIFwiLi9jb21wb25lbnRzL3Njb3BlZC1tb2RlbHMtc2VsZWN0b3IuanNcIjtcbmltcG9ydCB7IFNlc3Npb25TZWxlY3RvckNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvc2Vzc2lvbi1zZWxlY3Rvci5qc1wiO1xuaW1wb3J0IHsgU2V0dGluZ3NTZWxlY3RvckNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvc2V0dGluZ3Mtc2VsZWN0b3IuanNcIjtcbmltcG9ydCB7IFNraWxsSW52b2NhdGlvbk1lc3NhZ2VDb21wb25lbnQgfSBmcm9tIFwiLi9jb21wb25lbnRzL3NraWxsLWludm9jYXRpb24tbWVzc2FnZS5qc1wiO1xuaW1wb3J0IHsgVG9vbEV4ZWN1dGlvbkNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvdG9vbC1leGVjdXRpb24uanNcIjtcbmltcG9ydCB7IFRyZWVTZWxlY3RvckNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvdHJlZS1zZWxlY3Rvci5qc1wiO1xuaW1wb3J0IHsgVXNlck1lc3NhZ2VDb21wb25lbnQgfSBmcm9tIFwiLi9jb21wb25lbnRzL3VzZXItbWVzc2FnZS5qc1wiO1xuaW1wb3J0IHsgVXNlck1lc3NhZ2VTZWxlY3RvckNvbXBvbmVudCB9IGZyb20gXCIuL2NvbXBvbmVudHMvdXNlci1tZXNzYWdlLXNlbGVjdG9yLmpzXCI7XG5pbXBvcnQgeyBDb250ZXh0dWFsVGlwcyB9IGZyb20gXCIuLi8uLi9jb3JlL2NvbnRleHR1YWwtdGlwcy5qc1wiO1xuaW1wb3J0IHsgdHlwZSBTbGFzaENvbW1hbmRDb250ZXh0LCBkaXNwYXRjaFNsYXNoQ29tbWFuZCwgZ2V0QXBwS2V5RGlzcGxheSB9IGZyb20gXCIuL3NsYXNoLWNvbW1hbmQtaGFuZGxlcnMuanNcIjtcbmltcG9ydCB7IGhhbmRsZUFnZW50RXZlbnQgfSBmcm9tIFwiLi9jb250cm9sbGVycy9jaGF0LWNvbnRyb2xsZXIuanNcIjtcbmltcG9ydCB7IGNyZWF0ZUV4dGVuc2lvblVJQ29udGV4dCBhcyBidWlsZEV4dGVuc2lvblVJQ29udGV4dCB9IGZyb20gXCIuL2NvbnRyb2xsZXJzL2V4dGVuc2lvbi11aS1jb250cm9sbGVyLmpzXCI7XG5pbXBvcnQgeyBzZXR1cEVkaXRvclN1Ym1pdEhhbmRsZXIgYXMgc2V0dXBFZGl0b3JTdWJtaXRIYW5kbGVyQ29udHJvbGxlciB9IGZyb20gXCIuL2NvbnRyb2xsZXJzL2lucHV0LWNvbnRyb2xsZXIuanNcIjtcbmltcG9ydCB7XG5cdGZpbmRFeGFjdE1vZGVsTWF0Y2ggYXMgZmluZEV4YWN0TW9kZWxNYXRjaENvbnRyb2xsZXIsXG5cdGdldE1vZGVsQ2FuZGlkYXRlcyBhcyBnZXRNb2RlbENhbmRpZGF0ZXNDb250cm9sbGVyLFxuXHRoYW5kbGVNb2RlbENvbW1hbmQgYXMgaGFuZGxlTW9kZWxDb21tYW5kQ29udHJvbGxlcixcblx0dXBkYXRlQXZhaWxhYmxlUHJvdmlkZXJDb3VudCBhcyB1cGRhdGVBdmFpbGFibGVQcm92aWRlckNvdW50Q29udHJvbGxlcixcbn0gZnJvbSBcIi4vY29udHJvbGxlcnMvbW9kZWwtY29udHJvbGxlci5qc1wiO1xuaW1wb3J0IHtcblx0Z2V0QXZhaWxhYmxlVGhlbWVzLFxuXHRnZXRBdmFpbGFibGVUaGVtZXNXaXRoUGF0aHMsXG5cdGdldEVkaXRvclRoZW1lLFxuXHRnZXRNYXJrZG93blRoZW1lLFxuXHRnZXRUaGVtZUJ5TmFtZSxcblx0aW5pdFRoZW1lLFxuXHRvblRoZW1lQ2hhbmdlLFxuXHRzdG9wVGhlbWVXYXRjaGVyLFxuXHRzZXRSZWdpc3RlcmVkVGhlbWVzLFxuXHRzZXRUaGVtZSxcblx0c2V0VGhlbWVJbnN0YW5jZSxcblx0VGhlbWUsXG5cdHR5cGUgVGhlbWVDb2xvcixcblx0dGhlbWUsXG59IGZyb20gXCIuL3RoZW1lL3RoZW1lLmpzXCI7XG5cbi8qKiBJbnRlcmZhY2UgZm9yIGNvbXBvbmVudHMgdGhhdCBjYW4gYmUgZXhwYW5kZWQvY29sbGFwc2VkICovXG5pbnRlcmZhY2UgRXhwYW5kYWJsZSB7XG5cdHNldEV4cGFuZGVkKGV4cGFuZGVkOiBib29sZWFuKTogdm9pZDtcbn1cblxuZnVuY3Rpb24gaXNFeHBhbmRhYmxlKG9iajogdW5rbm93bik6IG9iaiBpcyBFeHBhbmRhYmxlIHtcblx0cmV0dXJuIHR5cGVvZiBvYmogPT09IFwib2JqZWN0XCIgJiYgb2JqICE9PSBudWxsICYmIFwic2V0RXhwYW5kZWRcIiBpbiBvYmogJiYgdHlwZW9mIG9iai5zZXRFeHBhbmRlZCA9PT0gXCJmdW5jdGlvblwiO1xufVxuXG5leHBvcnQgdHlwZSBBc3Npc3RhbnRSZXBsYXlTZWdtZW50ID1cblx0fCB7IGtpbmQ6IFwiYXNzaXN0YW50XCI7IHN0YXJ0SW5kZXg6IG51bWJlcjsgZW5kSW5kZXg6IG51bWJlciB9XG5cdHwgeyBraW5kOiBcInRvb2xcIjsgY29udGVudEluZGV4OiBudW1iZXIgfTtcblxuLyoqXG4gKiBCdWlsZCByZXBsYXkgc2VnbWVudHMgZm9yIGhpc3RvcmljYWwgYXNzaXN0YW50IG1lc3NhZ2VzIHNvIHJlYnVpbGQgcGF0aHNcbiAqIHByZXNlcnZlIHRoZSBvcmlnaW5hbCBjb250ZW50W10gb3JkZXJpbmcgYmV0d2VlbiBhc3Npc3RhbnQgcHJvc2UgYW5kIHRvb2xzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRBc3Npc3RhbnRSZXBsYXlTZWdtZW50cyhjb250ZW50QmxvY2tzOiBBcnJheTxhbnk+KTogQXNzaXN0YW50UmVwbGF5U2VnbWVudFtdIHtcblx0Y29uc3Qgc2VnbWVudHM6IEFzc2lzdGFudFJlcGxheVNlZ21lbnRbXSA9IFtdO1xuXHRsZXQgcnVuU3RhcnQgPSAtMTtcblxuXHRmb3IgKGxldCBpID0gMDsgaSA8IGNvbnRlbnRCbG9ja3MubGVuZ3RoOyBpKyspIHtcblx0XHRjb25zdCBibG9jayA9IGNvbnRlbnRCbG9ja3NbaV07XG5cdFx0Y29uc3QgaXNBc3Npc3RhbnRUZXh0ID0gYmxvY2s/LnR5cGUgPT09IFwidGV4dFwiIHx8IGJsb2NrPy50eXBlID09PSBcInRoaW5raW5nXCI7XG5cdFx0Y29uc3QgaXNUb29sID0gYmxvY2s/LnR5cGUgPT09IFwidG9vbENhbGxcIiB8fCBibG9jaz8udHlwZSA9PT0gXCJzZXJ2ZXJUb29sVXNlXCI7XG5cblx0XHRpZiAoaXNBc3Npc3RhbnRUZXh0KSB7XG5cdFx0XHRpZiAocnVuU3RhcnQgPT09IC0xKSBydW5TdGFydCA9IGk7XG5cdFx0XHRjb250aW51ZTtcblx0XHR9XG5cblx0XHRpZiAocnVuU3RhcnQgIT09IC0xKSB7XG5cdFx0XHRzZWdtZW50cy5wdXNoKHsga2luZDogXCJhc3Npc3RhbnRcIiwgc3RhcnRJbmRleDogcnVuU3RhcnQsIGVuZEluZGV4OiBpIC0gMSB9KTtcblx0XHRcdHJ1blN0YXJ0ID0gLTE7XG5cdFx0fVxuXG5cdFx0aWYgKGlzVG9vbCkge1xuXHRcdFx0c2VnbWVudHMucHVzaCh7IGtpbmQ6IFwidG9vbFwiLCBjb250ZW50SW5kZXg6IGkgfSk7XG5cdFx0fVxuXHR9XG5cblx0aWYgKHJ1blN0YXJ0ICE9PSAtMSkge1xuXHRcdHNlZ21lbnRzLnB1c2goeyBraW5kOiBcImFzc2lzdGFudFwiLCBzdGFydEluZGV4OiBydW5TdGFydCwgZW5kSW5kZXg6IGNvbnRlbnRCbG9ja3MubGVuZ3RoIC0gMSB9KTtcblx0fVxuXG5cdHJldHVybiBzZWdtZW50cztcbn1cblxudHlwZSBDb21wYWN0aW9uUXVldWVkTWVzc2FnZSA9IHtcblx0dGV4dDogc3RyaW5nO1xuXHRtb2RlOiBcInN0ZWVyXCIgfCBcImZvbGxvd1VwXCI7XG59O1xuXG5leHBvcnQgdHlwZSBFeHRlbnNpb25Ob3RpZnlUeXBlID0gXCJpbmZvXCIgfCBcIndhcm5pbmdcIiB8IFwiZXJyb3JcIiB8IFwic3VjY2Vzc1wiIHwgdW5kZWZpbmVkO1xuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkUmVuZGVyRXh0ZW5zaW9uTm90aWZ5SW5DaGF0KHR5cGU6IEV4dGVuc2lvbk5vdGlmeVR5cGUpOiBib29sZWFuIHtcblx0cmV0dXJuIHR5cGUgIT09IFwid2FybmluZ1wiO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEV4dGVuc2lvbk5vdGlmeVJlbmRlclJlc3VsdCB7XG5cdHJlbmRlcmVkOiBib29sZWFuO1xuXHRzdGF0dXNTcGFjZXI/OiBTcGFjZXI7XG5cdHN0YXR1c1RleHQ/OiBUZXh0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyRXh0ZW5zaW9uTm90aWZ5SW5DaGF0KFxuXHRjaGF0Q29udGFpbmVyOiBDb250YWluZXIsXG5cdG1lc3NhZ2U6IHN0cmluZyxcblx0dHlwZT86IEV4dGVuc2lvbk5vdGlmeVR5cGUsXG4pOiBFeHRlbnNpb25Ob3RpZnlSZW5kZXJSZXN1bHQge1xuXHRpZiAoIXNob3VsZFJlbmRlckV4dGVuc2lvbk5vdGlmeUluQ2hhdCh0eXBlKSkge1xuXHRcdHJldHVybiB7IHJlbmRlcmVkOiBmYWxzZSB9O1xuXHR9XG5cblx0Y29uc3Qgc3BhY2VyID0gbmV3IFNwYWNlcigxKTtcblx0Y2hhdENvbnRhaW5lci5hZGRDaGlsZChzcGFjZXIpO1xuXG5cdGlmICh0eXBlID09PSBcImVycm9yXCIpIHtcblx0XHRjaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KHRoZW1lLmZnKFwiZXJyb3JcIiwgYEVycm9yOiAke21lc3NhZ2V9YCksIDEsIDApKTtcblx0XHRyZXR1cm4geyByZW5kZXJlZDogdHJ1ZSB9O1xuXHR9XG5cdGlmICh0eXBlID09PSBcInN1Y2Nlc3NcIikge1xuXHRcdGNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IER5bmFtaWNCb3JkZXIoKHRleHQpID0+IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCB0ZXh0KSkpO1xuXHRcdGNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJzdWNjZXNzXCIsIG1lc3NhZ2UpLCAxLCAwKSk7XG5cdFx0Y2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigodGV4dCkgPT4gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIHRleHQpKSk7XG5cdFx0Y2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRyZXR1cm4geyByZW5kZXJlZDogdHJ1ZSB9O1xuXHR9XG5cblx0Y29uc3Qgc3RhdHVzVGV4dCA9IG5ldyBUZXh0KHRoZW1lLmZnKFwiZGltXCIsIG1lc3NhZ2UpLCAxLCAwKTtcblx0Y2hhdENvbnRhaW5lci5hZGRDaGlsZChzdGF0dXNUZXh0KTtcblx0cmV0dXJuIHsgcmVuZGVyZWQ6IHRydWUsIHN0YXR1c1NwYWNlcjogc3BhY2VyLCBzdGF0dXNUZXh0IH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJCbG9ja2luZ0Vycm9yQmFubmVyKGNvbnRhaW5lcjogQ29udGFpbmVyLCBtZXNzYWdlOiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcblx0Y29udGFpbmVyLmNsZWFyKCk7XG5cdGlmIChtZXNzYWdlID09PSB1bmRlZmluZWQpIHJldHVybjtcblxuXHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcImVycm9yXCIsIGBFcnJvcjogJHttZXNzYWdlfWApLCAxLCAwKSk7XG59XG5cbi8qKlxuICogT3B0aW9ucyBmb3IgSW50ZXJhY3RpdmVNb2RlIGluaXRpYWxpemF0aW9uLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEludGVyYWN0aXZlTW9kZU9wdGlvbnMge1xuXHQvKiogUHJvdmlkZXJzIHRoYXQgd2VyZSBtaWdyYXRlZCB0byBhdXRoLmpzb24gKHNob3dzIHdhcm5pbmcpICovXG5cdG1pZ3JhdGVkUHJvdmlkZXJzPzogc3RyaW5nW107XG5cdC8qKiBXYXJuaW5nIG1lc3NhZ2UgaWYgc2Vzc2lvbiBtb2RlbCBjb3VsZG4ndCBiZSByZXN0b3JlZCAqL1xuXHRtb2RlbEZhbGxiYWNrTWVzc2FnZT86IHN0cmluZztcblx0LyoqIEluaXRpYWwgbWVzc2FnZSB0byBzZW5kIG9uIHN0YXJ0dXAgKGNhbiBpbmNsdWRlIEBmaWxlIGNvbnRlbnQpICovXG5cdGluaXRpYWxNZXNzYWdlPzogc3RyaW5nO1xuXHQvKiogSW1hZ2VzIHRvIGF0dGFjaCB0byB0aGUgaW5pdGlhbCBtZXNzYWdlICovXG5cdGluaXRpYWxJbWFnZXM/OiBJbWFnZUNvbnRlbnRbXTtcblx0LyoqIEFkZGl0aW9uYWwgbWVzc2FnZXMgdG8gc2VuZCBhZnRlciB0aGUgaW5pdGlhbCBtZXNzYWdlICovXG5cdGluaXRpYWxNZXNzYWdlcz86IHN0cmluZ1tdO1xuXHQvKiogRm9yY2UgdmVyYm9zZSBzdGFydHVwIChvdmVycmlkZXMgcXVpZXRTdGFydHVwIHNldHRpbmcpICovXG5cdHZlcmJvc2U/OiBib29sZWFuO1xuXHQvKiogT3ZlcnJpZGUgdGhlIHRlcm1pbmFsIGltcGxlbWVudGF0aW9uIHVzZWQgYnkgdGhlIFRVSS4gKi9cblx0dGVybWluYWw/OiBUdWlUZXJtaW5hbDtcblx0LyoqIFdoZW4gZmFsc2UsIHJldXNlIHRoZSBzZXNzaW9uJ3MgZXhpc3RpbmcgZXh0ZW5zaW9uIGJpbmRpbmdzIGluc3RlYWQgb2YgcmViaW5kaW5nIHRoZW0gZm9yIFRVSSBtb2RlLiAqL1xuXHRiaW5kRXh0ZW5zaW9ucz86IGJvb2xlYW47XG5cdC8qKiBTdWJtaXQgZWRpdG9yIHByb21wdHMgZGlyZWN0bHkgdG8gQWdlbnRTZXNzaW9uIGluc3RlYWQgb2YgdXNpbmcgdGhlIGludGVyYWN0aXZlIHByb21wdCBsb29wLiAqL1xuXHRzdWJtaXRQcm9tcHRzRGlyZWN0bHk/OiBib29sZWFuO1xuXHQvKiogQ29udHJvbCB3aGF0IGhhcHBlbnMgd2hlbiB0aGUgdXNlciByZXF1ZXN0cyBzaHV0ZG93biBmcm9tIHRoZSBUVUkuICovXG5cdHNodXRkb3duQmVoYXZpb3I/OiBcImV4aXRfcHJvY2Vzc1wiIHwgXCJzdG9wX3VpXCIgfCBcImlnbm9yZVwiO1xufVxuXG5leHBvcnQgY2xhc3MgSW50ZXJhY3RpdmVNb2RlIHtcblx0Ly8gQ2FwIHJlbmRlcmVkIGNoYXQgY29tcG9uZW50cyB0byBwcmV2ZW50IHVuYm91bmRlZCBtZW1vcnkvQ1BVIGdyb3d0aC5cblx0Ly8gT25seSByZW5kZXItY29tcG9uZW50cyBhcmUgcmVtb3ZlZCBcdTIwMTQgc2Vzc2lvbiB0cmFuc2NyaXB0IHN0YXlzIG9uIGRpc2suXG5cdHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IE1BWF9DSEFUX0NPTVBPTkVOVFMgPSAxMDA7XG5cblx0cHJpdmF0ZSBzZXNzaW9uOiBBZ2VudFNlc3Npb247XG5cdHByaXZhdGUgdWk6IFRVSTtcblx0cHJpdmF0ZSBjaGF0Q29udGFpbmVyOiBDb250YWluZXI7XG5cdHByaXZhdGUgcGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyOiBDb250YWluZXI7XG5cdHByaXZhdGUgYWRhcHRpdmVMYXlvdXQ6IEFkYXB0aXZlTGF5b3V0Q29tcG9uZW50O1xuXHRwcml2YXRlIHN0YXR1c0NvbnRhaW5lcjogQ29udGFpbmVyO1xuXHRwcml2YXRlIHBpbm5lZE1lc3NhZ2VDb250YWluZXI6IENvbnRhaW5lcjtcblx0cHJpdmF0ZSBibG9ja2luZ0Vycm9yQ29udGFpbmVyOiBDb250YWluZXI7XG5cdHByaXZhdGUgZGVmYXVsdEVkaXRvcjogQ3VzdG9tRWRpdG9yO1xuXHRwcml2YXRlIGVkaXRvcjogRWRpdG9yQ29tcG9uZW50O1xuXHRwcml2YXRlIGF1dG9jb21wbGV0ZVByb3ZpZGVyOiBDb21iaW5lZEF1dG9jb21wbGV0ZVByb3ZpZGVyIHwgdW5kZWZpbmVkO1xuXHRwcml2YXRlIGVkaXRvckNvbnRhaW5lcjogQ29udGFpbmVyO1xuXHRwcml2YXRlIGZvb3RlcjogRm9vdGVyQ29tcG9uZW50O1xuXHRwcml2YXRlIGZvb3RlckRhdGFQcm92aWRlcjogRm9vdGVyRGF0YVByb3ZpZGVyO1xuXHRwcml2YXRlIGtleWJpbmRpbmdzOiBLZXliaW5kaW5nc01hbmFnZXI7XG5cdHByaXZhdGUgdmVyc2lvbjogc3RyaW5nO1xuXHRwcml2YXRlIGlzSW5pdGlhbGl6ZWQgPSBmYWxzZTtcblx0cHJpdmF0ZSBvbklucHV0Q2FsbGJhY2s/OiAodGV4dDogc3RyaW5nKSA9PiB2b2lkO1xuXHRwcml2YXRlIGxvYWRpbmdBbmltYXRpb246IExvYWRlciB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblx0cHJpdmF0ZSBwZW5kaW5nV29ya2luZ01lc3NhZ2U6IHN0cmluZyB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblx0cHJpdmF0ZSByZWFkb25seSBkZWZhdWx0V29ya2luZ01lc3NhZ2UgPSBcIldvcmtpbmcuLi5cIjtcblx0cHJpdmF0ZSBsYXN0QmxvY2tpbmdFcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXG5cdHByaXZhdGUgbGFzdFNpZ2ludFRpbWUgPSAwO1xuXHRwcml2YXRlIGxhc3RFc2NhcGVUaW1lID0gMDtcblx0cHJpdmF0ZSBjaGFuZ2Vsb2dNYXJrZG93bjogc3RyaW5nIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXG5cdC8vIFN0YXR1cyBsaW5lIHRyYWNraW5nIChmb3IgbXV0YXRpbmcgaW1tZWRpYXRlbHktc2VxdWVudGlhbCBzdGF0dXMgdXBkYXRlcylcblx0cHJpdmF0ZSBsYXN0U3RhdHVzU3BhY2VyOiBTcGFjZXIgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cdHByaXZhdGUgbGFzdFN0YXR1c1RleHQ6IFRleHQgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cblx0Ly8gU3RyZWFtaW5nIG1lc3NhZ2UgdHJhY2tpbmdcblx0cHJpdmF0ZSBzdHJlYW1pbmdDb21wb25lbnQ6IEFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnQgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cdHByaXZhdGUgc3RyZWFtaW5nTWVzc2FnZTogQXNzaXN0YW50TWVzc2FnZSB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblxuXHQvLyBUb29sIGV4ZWN1dGlvbiB0cmFja2luZzogdG9vbENhbGxJZCAtPiBjb21wb25lbnRcblx0cHJpdmF0ZSBwZW5kaW5nVG9vbHMgPSBuZXcgTWFwPHN0cmluZywgVG9vbEV4ZWN1dGlvbkNvbXBvbmVudD4oKTtcblxuXHQvLyBUb29sIG91dHB1dCBleHBhbnNpb24gc3RhdGVcblx0cHJpdmF0ZSB0b29sT3V0cHV0RXhwYW5kZWQgPSBmYWxzZTtcblxuXHQvLyBQYXN0ZWQgaW1hZ2UgdHJhY2tpbmdcblx0cHJpdmF0ZSBwZW5kaW5nSW1hZ2VzOiBJbWFnZUNvbnRlbnRbXSA9IFtdO1xuXG5cdC8vIFRoaW5raW5nIGJsb2NrIHZpc2liaWxpdHkgc3RhdGVcblx0cHJpdmF0ZSBoaWRlVGhpbmtpbmdCbG9jayA9IGZhbHNlO1xuXG5cdC8vIFNraWxsIGNvbW1hbmRzOiBjb21tYW5kIG5hbWUgLT4gc2tpbGwgZmlsZSBwYXRoXG5cdHByaXZhdGUgc2tpbGxDb21tYW5kcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG5cblx0Ly8gQWdlbnQgc3Vic2NyaXB0aW9uIHVuc3Vic2NyaWJlIGZ1bmN0aW9uXG5cdHByaXZhdGUgdW5zdWJzY3JpYmU/OiAoKSA9PiB2b2lkO1xuXG5cdC8vIEJyYW5jaCBjaGFuZ2UgbGlzdGVuZXIgdW5zdWJzY3JpYmUgZnVuY3Rpb25cblx0cHJpdmF0ZSBfYnJhbmNoQ2hhbmdlVW5zdWI/OiAoKSA9PiB2b2lkO1xuXG5cdC8vIFRyYWNrIGlmIGVkaXRvciBpcyBpbiBiYXNoIG1vZGUgKHRleHQgc3RhcnRzIHdpdGggISlcblx0cHJpdmF0ZSBpc0Jhc2hNb2RlID0gZmFsc2U7XG5cblx0Ly8gQ29udGV4dHVhbCB0aXBzIFx1MjAxNCBzZXNzaW9uLXNjb3BlZCwgbm9uLWludHJ1c2l2ZSBoaW50c1xuXHRwcml2YXRlIGNvbnRleHR1YWxUaXBzID0gbmV3IENvbnRleHR1YWxUaXBzKCk7XG5cblx0Ly8gVHJhY2sgY3VycmVudCBiYXNoIGV4ZWN1dGlvbiBjb21wb25lbnRcblx0cHJpdmF0ZSBiYXNoQ29tcG9uZW50OiBCYXNoRXhlY3V0aW9uQ29tcG9uZW50IHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXG5cdC8vIFRyYWNrIHBlbmRpbmcgYmFzaCBjb21wb25lbnRzIChzaG93biBpbiBwZW5kaW5nIGFyZWEsIG1vdmVkIHRvIGNoYXQgb24gc3VibWl0KVxuXHRwcml2YXRlIHBlbmRpbmdCYXNoQ29tcG9uZW50czogQmFzaEV4ZWN1dGlvbkNvbXBvbmVudFtdID0gW107XG5cblx0Ly8gQXV0by1jb21wYWN0aW9uIHN0YXRlXG5cdHByaXZhdGUgYXV0b0NvbXBhY3Rpb25Mb2FkZXI6IExvYWRlciB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblx0cHJpdmF0ZSBhdXRvQ29tcGFjdGlvbkVzY2FwZUhhbmRsZXI/OiAoKSA9PiB2b2lkO1xuXG5cdC8vIEF1dG8tcmV0cnkgc3RhdGVcblx0cHJpdmF0ZSByZXRyeUxvYWRlcjogTG9hZGVyIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXHRwcml2YXRlIHJldHJ5RXNjYXBlSGFuZGxlcj86ICgpID0+IHZvaWQ7XG5cblx0Ly8gTWVzc2FnZXMgcXVldWVkIHdoaWxlIGNvbXBhY3Rpb24gaXMgcnVubmluZ1xuXHRwcml2YXRlIGNvbXBhY3Rpb25RdWV1ZWRNZXNzYWdlczogQ29tcGFjdGlvblF1ZXVlZE1lc3NhZ2VbXSA9IFtdO1xuXG5cdC8vIFNodXRkb3duIHN0YXRlXG5cdHByaXZhdGUgc2h1dGRvd25SZXF1ZXN0ZWQgPSBmYWxzZTtcblxuXHQvLyBFeHRlbnNpb24gVUkgc3RhdGVcblx0cHJpdmF0ZSBleHRlbnNpb25TZWxlY3RvcjogRXh0ZW5zaW9uU2VsZWN0b3JDb21wb25lbnQgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQ7XG5cdHByaXZhdGUgZXh0ZW5zaW9uSW5wdXQ6IEV4dGVuc2lvbklucHV0Q29tcG9uZW50IHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXHRwcml2YXRlIGV4dGVuc2lvbkVkaXRvcjogRXh0ZW5zaW9uRWRpdG9yQ29tcG9uZW50IHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXHRwcml2YXRlIGV4dGVuc2lvblRlcm1pbmFsSW5wdXRVbnN1YnNjcmliZXJzID0gbmV3IFNldDwoKSA9PiB2b2lkPigpO1xuXG5cdC8vIEV4dGVuc2lvbiB3aWRnZXRzIChjb21wb25lbnRzIHJlbmRlcmVkIGFib3ZlL2JlbG93IHRoZSBlZGl0b3IpXG5cdHByaXZhdGUgZXh0ZW5zaW9uV2lkZ2V0c0Fib3ZlID0gbmV3IE1hcDxzdHJpbmcsIENvbXBvbmVudCAmIHsgZGlzcG9zZT8oKTogdm9pZCB9PigpO1xuXHRwcml2YXRlIGV4dGVuc2lvbldpZGdldHNCZWxvdyA9IG5ldyBNYXA8c3RyaW5nLCBDb21wb25lbnQgJiB7IGRpc3Bvc2U/KCk6IHZvaWQgfT4oKTtcblx0cHJpdmF0ZSB3aWRnZXRDb250YWluZXJBYm92ZSE6IENvbnRhaW5lcjtcblx0cHJpdmF0ZSB3aWRnZXRDb250YWluZXJCZWxvdyE6IENvbnRhaW5lcjtcblxuXHQvLyBDdXN0b20gZm9vdGVyIGZyb20gZXh0ZW5zaW9uICh1bmRlZmluZWQgPSB1c2UgYnVpbHQtaW4gZm9vdGVyKVxuXHRwcml2YXRlIGN1c3RvbUZvb3RlcjogKENvbXBvbmVudCAmIHsgZGlzcG9zZT8oKTogdm9pZCB9KSB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblxuXHQvLyBIZWFkZXIgY29udGFpbmVyIHRoYXQgaG9sZHMgdGhlIGJ1aWx0LWluIG9yIGN1c3RvbSBoZWFkZXJcblx0cHJpdmF0ZSBoZWFkZXJDb250YWluZXI6IENvbnRhaW5lcjtcblxuXHQvLyBCdWlsdC1pbiBoZWFkZXIgKGxvZ28gKyBrZXliaW5kaW5nIGhpbnRzICsgY2hhbmdlbG9nKVxuXHRwcml2YXRlIGJ1aWx0SW5IZWFkZXI6IENvbXBvbmVudCB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblxuXHQvLyBDdXN0b20gaGVhZGVyIGZyb20gZXh0ZW5zaW9uICh1bmRlZmluZWQgPSB1c2UgYnVpbHQtaW4gaGVhZGVyKVxuXHRwcml2YXRlIGN1c3RvbUhlYWRlcjogKENvbXBvbmVudCAmIHsgZGlzcG9zZT8oKTogdm9pZCB9KSB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblxuXHQvLyBDb252ZW5pZW5jZSBhY2Nlc3NvcnNcblx0cHJpdmF0ZSBnZXQgYWdlbnQoKSB7XG5cdFx0cmV0dXJuIHRoaXMuc2Vzc2lvbi5hZ2VudDtcblx0fVxuXHRwcml2YXRlIGdldCBzZXNzaW9uTWFuYWdlcigpIHtcblx0XHRyZXR1cm4gdGhpcy5zZXNzaW9uLnNlc3Npb25NYW5hZ2VyO1xuXHR9XG5cdHByaXZhdGUgZ2V0IHNldHRpbmdzTWFuYWdlcigpIHtcblx0XHRyZXR1cm4gdGhpcy5zZXNzaW9uLnNldHRpbmdzTWFuYWdlcjtcblx0fVxuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdHNlc3Npb246IEFnZW50U2Vzc2lvbixcblx0XHRwcml2YXRlIG9wdGlvbnM6IEludGVyYWN0aXZlTW9kZU9wdGlvbnMgPSB7fSxcblx0KSB7XG5cdFx0dGhpcy5zZXNzaW9uID0gc2Vzc2lvbjtcblx0XHR0aGlzLnZlcnNpb24gPSBWRVJTSU9OO1xuXHRcdHRoaXMudWkgPSBuZXcgVFVJKG9wdGlvbnMudGVybWluYWwgPz8gbmV3IFByb2Nlc3NUZXJtaW5hbCgpLCB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRTaG93SGFyZHdhcmVDdXJzb3IoKSk7XG5cdFx0dGhpcy51aS5zZXRDbGVhck9uU2hyaW5rKHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldENsZWFyT25TaHJpbmsoKSk7XG5cdFx0dGhpcy5oZWFkZXJDb250YWluZXIgPSBuZXcgQ29udGFpbmVyKCk7XG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyID0gbmV3IENvbnRhaW5lcigpO1xuXHRcdHRoaXMucGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyID0gbmV3IENvbnRhaW5lcigpO1xuXHRcdHRoaXMuYWRhcHRpdmVMYXlvdXQgPSBuZXcgQWRhcHRpdmVMYXlvdXRDb21wb25lbnQoKCkgPT4gKHtcblx0XHRcdG92ZXJyaWRlOiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRBZGFwdGl2ZU1vZGUoKSxcblx0XHRcdGFjdGl2ZVRvb2xDb3VudDogdGhpcy5wZW5kaW5nVG9vbHMuc2l6ZSxcblx0XHRcdGdzZFBoYXNlOiB0aGlzLnBlbmRpbmdXb3JraW5nTWVzc2FnZSxcblx0XHRcdGxhc3RFcnJvcjogdGhpcy5sYXN0QmxvY2tpbmdFcnJvcixcblx0XHRcdHNlc3Npb25OYW1lOiB0aGlzLnNlc3Npb25NYW5hZ2VyLmdldFNlc3Npb25OYW1lKCksXG5cdFx0XHRjd2Q6IHByb2Nlc3MuY3dkKCksXG5cdFx0fSkpO1xuXHRcdHRoaXMuc3RhdHVzQ29udGFpbmVyID0gbmV3IENvbnRhaW5lcigpO1xuXHRcdHRoaXMucGlubmVkTWVzc2FnZUNvbnRhaW5lciA9IG5ldyBDb250YWluZXIoKTtcblx0XHR0aGlzLmJsb2NraW5nRXJyb3JDb250YWluZXIgPSBuZXcgQ29udGFpbmVyKCk7XG5cdFx0dGhpcy53aWRnZXRDb250YWluZXJBYm92ZSA9IG5ldyBDb250YWluZXIoKTtcblx0XHR0aGlzLndpZGdldENvbnRhaW5lckJlbG93ID0gbmV3IENvbnRhaW5lcigpO1xuXHRcdHRoaXMua2V5YmluZGluZ3MgPSBLZXliaW5kaW5nc01hbmFnZXIuY3JlYXRlKCk7XG5cdFx0Y29uc3QgZWRpdG9yUGFkZGluZ1ggPSB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRFZGl0b3JQYWRkaW5nWCgpO1xuXHRcdGNvbnN0IGF1dG9jb21wbGV0ZU1heFZpc2libGUgPSB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRBdXRvY29tcGxldGVNYXhWaXNpYmxlKCk7XG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yID0gbmV3IEN1c3RvbUVkaXRvcih0aGlzLnVpLCBnZXRFZGl0b3JUaGVtZSgpLCB0aGlzLmtleWJpbmRpbmdzLCB7XG5cdFx0XHRwYWRkaW5nWDogZWRpdG9yUGFkZGluZ1gsXG5cdFx0XHRhdXRvY29tcGxldGVNYXhWaXNpYmxlLFxuXHRcdH0pO1xuXHRcdHRoaXMuZWRpdG9yID0gdGhpcy5kZWZhdWx0RWRpdG9yO1xuXHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyID0gbmV3IENvbnRhaW5lcigpO1xuXHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmFkZENoaWxkKHRoaXMuZWRpdG9yIGFzIENvbXBvbmVudCk7XG5cdFx0dGhpcy5mb290ZXJEYXRhUHJvdmlkZXIgPSBuZXcgRm9vdGVyRGF0YVByb3ZpZGVyKCk7XG5cdFx0dGhpcy5mb290ZXIgPSBuZXcgRm9vdGVyQ29tcG9uZW50KHNlc3Npb24sIHRoaXMuZm9vdGVyRGF0YVByb3ZpZGVyKTtcblx0XHR0aGlzLmZvb3Rlci5zZXRBdXRvQ29tcGFjdEVuYWJsZWQoc2Vzc2lvbi5hdXRvQ29tcGFjdGlvbkVuYWJsZWQpO1xuXG5cdFx0Ly8gTG9hZCBoaWRlIHRoaW5raW5nIGJsb2NrIHNldHRpbmdcblx0XHR0aGlzLmhpZGVUaGlua2luZ0Jsb2NrID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0SGlkZVRoaW5raW5nQmxvY2soKTtcblxuXHRcdC8vIFJlZ2lzdGVyIHRoZW1lcyBmcm9tIHJlc291cmNlIGxvYWRlciBhbmQgaW5pdGlhbGl6ZVxuXHRcdHNldFJlZ2lzdGVyZWRUaGVtZXModGhpcy5zZXNzaW9uLnJlc291cmNlTG9hZGVyLmdldFRoZW1lcygpLnRoZW1lcyk7XG5cdFx0aW5pdFRoZW1lKHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldFRoZW1lKCksIHRydWUpO1xuXHR9XG5cblx0cHJpdmF0ZSBzZXR1cEF1dG9jb21wbGV0ZSgpOiB2b2lkIHtcblx0XHQvLyBEZWZpbmUgY29tbWFuZHMgZm9yIGF1dG9jb21wbGV0ZVxuXHRcdGNvbnN0IHNsYXNoQ29tbWFuZHM6IFNsYXNoQ29tbWFuZFtdID0gQlVJTFRJTl9TTEFTSF9DT01NQU5EUy5tYXAoKGNvbW1hbmQpID0+ICh7XG5cdFx0XHRuYW1lOiBjb21tYW5kLm5hbWUsXG5cdFx0XHRkZXNjcmlwdGlvbjogY29tbWFuZC5kZXNjcmlwdGlvbixcblx0XHR9KSk7XG5cblx0XHRjb25zdCBtb2RlbENvbW1hbmQgPSBzbGFzaENvbW1hbmRzLmZpbmQoKGNvbW1hbmQpID0+IGNvbW1hbmQubmFtZSA9PT0gXCJtb2RlbFwiKTtcblx0XHRpZiAobW9kZWxDb21tYW5kKSB7XG5cdFx0XHRtb2RlbENvbW1hbmQuZ2V0QXJndW1lbnRDb21wbGV0aW9ucyA9IChwcmVmaXg6IHN0cmluZyk6IEF1dG9jb21wbGV0ZUl0ZW1bXSB8IG51bGwgPT4ge1xuXHRcdFx0XHQvLyBHZXQgYXZhaWxhYmxlIG1vZGVscyAoc2NvcGVkIG9yIGZyb20gcmVnaXN0cnkpXG5cdFx0XHRcdGNvbnN0IG1vZGVscyA9XG5cdFx0XHRcdFx0dGhpcy5zZXNzaW9uLnNjb3BlZE1vZGVscy5sZW5ndGggPiAwXG5cdFx0XHRcdFx0XHQ/IHRoaXMuc2Vzc2lvbi5zY29wZWRNb2RlbHMubWFwKChzKSA9PiBzLm1vZGVsKVxuXHRcdFx0XHRcdFx0OiB0aGlzLnNlc3Npb24ubW9kZWxSZWdpc3RyeS5nZXRBdmFpbGFibGUoKTtcblxuXHRcdFx0XHRpZiAobW9kZWxzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cblx0XHRcdFx0Ly8gQ3JlYXRlIGl0ZW1zIHdpdGggcHJvdmlkZXIvaWQgZm9ybWF0XG5cdFx0XHRcdGNvbnN0IGl0ZW1zID0gbW9kZWxzLm1hcCgobSkgPT4gKHtcblx0XHRcdFx0XHRpZDogbS5pZCxcblx0XHRcdFx0XHRwcm92aWRlcjogbS5wcm92aWRlcixcblx0XHRcdFx0XHRsYWJlbDogYCR7bS5wcm92aWRlcn0vJHttLmlkfWAsXG5cdFx0XHRcdH0pKTtcblxuXHRcdFx0XHQvLyBGdXp6eSBmaWx0ZXIgYnkgbW9kZWwgSUQgKyBwcm92aWRlciAoYWxsb3dzIFwib3B1cyBhbnRocm9waWNcIiB0byBtYXRjaClcblx0XHRcdFx0Y29uc3QgZmlsdGVyZWQgPSBmdXp6eUZpbHRlcihpdGVtcywgcHJlZml4LCAoaXRlbSkgPT4gYCR7aXRlbS5pZH0gJHtpdGVtLnByb3ZpZGVyfWApO1xuXG5cdFx0XHRcdGlmIChmaWx0ZXJlZC5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuXG5cdFx0XHRcdHJldHVybiBmaWx0ZXJlZC5tYXAoKGl0ZW0pID0+ICh7XG5cdFx0XHRcdFx0dmFsdWU6IGl0ZW0ubGFiZWwsXG5cdFx0XHRcdFx0bGFiZWw6IGl0ZW0uaWQsXG5cdFx0XHRcdFx0ZGVzY3JpcHRpb246IHByb3ZpZGVyRGlzcGxheU5hbWUoaXRlbS5wcm92aWRlciksXG5cdFx0XHRcdH0pKTtcblx0XHRcdH07XG5cdFx0fVxuXG5cdFx0Ly8gQWRkIGFyZ3VtZW50IGNvbXBsZXRpb25zIGZvciAvdGhpbmtpbmdcblx0XHRjb25zdCB0aGlua2luZ0NvbW1hbmQgPSBzbGFzaENvbW1hbmRzLmZpbmQoKGNvbW1hbmQpID0+IGNvbW1hbmQubmFtZSA9PT0gXCJ0aGlua2luZ1wiKTtcblx0XHRpZiAodGhpbmtpbmdDb21tYW5kKSB7XG5cdFx0XHR0aGlua2luZ0NvbW1hbmQuZ2V0QXJndW1lbnRDb21wbGV0aW9ucyA9IChwcmVmaXg6IHN0cmluZyk6IEF1dG9jb21wbGV0ZUl0ZW1bXSB8IG51bGwgPT4ge1xuXHRcdFx0XHRjb25zdCBsZXZlbHMgPSBbXG5cdFx0XHRcdFx0eyB2YWx1ZTogXCJvZmZcIiwgbGFiZWw6IFwib2ZmXCIsIGRlc2NyaXB0aW9uOiBcIkRpc2FibGUgZXh0ZW5kZWQgdGhpbmtpbmdcIiB9LFxuXHRcdFx0XHRcdHsgdmFsdWU6IFwibWluaW1hbFwiLCBsYWJlbDogXCJtaW5pbWFsXCIsIGRlc2NyaXB0aW9uOiBcIk1pbmltYWwgdGhpbmtpbmcgYnVkZ2V0XCIgfSxcblx0XHRcdFx0XHR7IHZhbHVlOiBcImxvd1wiLCBsYWJlbDogXCJsb3dcIiwgZGVzY3JpcHRpb246IFwiTG93IHRoaW5raW5nIGJ1ZGdldFwiIH0sXG5cdFx0XHRcdFx0eyB2YWx1ZTogXCJtZWRpdW1cIiwgbGFiZWw6IFwibWVkaXVtXCIsIGRlc2NyaXB0aW9uOiBcIk1lZGl1bSB0aGlua2luZyBidWRnZXRcIiB9LFxuXHRcdFx0XHRcdHsgdmFsdWU6IFwiaGlnaFwiLCBsYWJlbDogXCJoaWdoXCIsIGRlc2NyaXB0aW9uOiBcIkhpZ2ggdGhpbmtpbmcgYnVkZ2V0XCIgfSxcblx0XHRcdFx0XHR7IHZhbHVlOiBcInhoaWdoXCIsIGxhYmVsOiBcInhoaWdoXCIsIGRlc2NyaXB0aW9uOiBcIk1heGltdW0gdGhpbmtpbmcgYnVkZ2V0XCIgfSxcblx0XHRcdFx0XTtcblx0XHRcdFx0Y29uc3QgZmlsdGVyZWQgPSBsZXZlbHMuZmlsdGVyKChsKSA9PiBsLnZhbHVlLnN0YXJ0c1dpdGgocHJlZml4LnRyaW0oKS50b0xvd2VyQ2FzZSgpKSk7XG5cdFx0XHRcdHJldHVybiBmaWx0ZXJlZC5sZW5ndGggPiAwID8gZmlsdGVyZWQgOiBudWxsO1xuXHRcdFx0fTtcblx0XHR9XG5cblx0XHQvLyBDb252ZXJ0IHByb21wdCB0ZW1wbGF0ZXMgdG8gU2xhc2hDb21tYW5kIGZvcm1hdCBmb3IgYXV0b2NvbXBsZXRlXG5cdFx0Y29uc3QgdGVtcGxhdGVDb21tYW5kczogU2xhc2hDb21tYW5kW10gPSB0aGlzLnNlc3Npb24ucHJvbXB0VGVtcGxhdGVzLm1hcCgoY21kKSA9PiAoe1xuXHRcdFx0bmFtZTogY21kLm5hbWUsXG5cdFx0XHRkZXNjcmlwdGlvbjogY21kLmRlc2NyaXB0aW9uLFxuXHRcdH0pKTtcblxuXHRcdC8vIENvbnZlcnQgZXh0ZW5zaW9uIGNvbW1hbmRzIHRvIFNsYXNoQ29tbWFuZCBmb3JtYXRcblx0XHRjb25zdCBidWlsdGluQ29tbWFuZE5hbWVzID0gbmV3IFNldChzbGFzaENvbW1hbmRzLm1hcCgoYykgPT4gYy5uYW1lKSk7XG5cdFx0Y29uc3QgZXh0ZW5zaW9uQ29tbWFuZHM6IFNsYXNoQ29tbWFuZFtdID0gKFxuXHRcdFx0dGhpcy5zZXNzaW9uLmV4dGVuc2lvblJ1bm5lcj8uZ2V0UmVnaXN0ZXJlZENvbW1hbmRzKGJ1aWx0aW5Db21tYW5kTmFtZXMpID8/IFtdXG5cdFx0KS5tYXAoKGNtZCkgPT4gKHtcblx0XHRcdG5hbWU6IGNtZC5uYW1lLFxuXHRcdFx0ZGVzY3JpcHRpb246IGNtZC5kZXNjcmlwdGlvbiA/PyBcIihleHRlbnNpb24gY29tbWFuZClcIixcblx0XHRcdGdldEFyZ3VtZW50Q29tcGxldGlvbnM6IGNtZC5nZXRBcmd1bWVudENvbXBsZXRpb25zLFxuXHRcdH0pKTtcblxuXHRcdC8vIEJ1aWxkIHNraWxsIGNvbW1hbmRzIGZyb20gc2Vzc2lvbi5za2lsbHMgKGlmIGVuYWJsZWQpXG5cdFx0dGhpcy5za2lsbENvbW1hbmRzLmNsZWFyKCk7XG5cdFx0Y29uc3Qgc2tpbGxDb21tYW5kTGlzdDogU2xhc2hDb21tYW5kW10gPSBbXTtcblx0XHRpZiAodGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0RW5hYmxlU2tpbGxDb21tYW5kcygpKSB7XG5cdFx0XHRmb3IgKGNvbnN0IHNraWxsIG9mIHRoaXMuc2Vzc2lvbi5yZXNvdXJjZUxvYWRlci5nZXRTa2lsbHMoKS5za2lsbHMpIHtcblx0XHRcdFx0Y29uc3QgY29tbWFuZE5hbWUgPSBgc2tpbGw6JHtza2lsbC5uYW1lfWA7XG5cdFx0XHRcdHRoaXMuc2tpbGxDb21tYW5kcy5zZXQoY29tbWFuZE5hbWUsIHNraWxsLmZpbGVQYXRoKTtcblx0XHRcdFx0c2tpbGxDb21tYW5kTGlzdC5wdXNoKHsgbmFtZTogY29tbWFuZE5hbWUsIGRlc2NyaXB0aW9uOiBza2lsbC5kZXNjcmlwdGlvbiB9KTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBTZXR1cCBhdXRvY29tcGxldGVcblx0XHR0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyID0gbmV3IENvbWJpbmVkQXV0b2NvbXBsZXRlUHJvdmlkZXIoXG5cdFx0XHRbLi4uc2xhc2hDb21tYW5kcywgLi4udGVtcGxhdGVDb21tYW5kcywgLi4uZXh0ZW5zaW9uQ29tbWFuZHMsIC4uLnNraWxsQ29tbWFuZExpc3RdLFxuXHRcdFx0cHJvY2Vzcy5jd2QoKSxcblx0XHRcdHtcblx0XHRcdFx0cmVzcGVjdEdpdGlnbm9yZTogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0UmVzcGVjdEdpdGlnbm9yZUluUGlja2VyKCksXG5cdFx0XHRcdGV4Y2x1ZGVEaXJzOiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRTZWFyY2hFeGNsdWRlRGlycygpLFxuXHRcdFx0fSxcblx0XHQpO1xuXHRcdHRoaXMuZGVmYXVsdEVkaXRvci5zZXRBdXRvY29tcGxldGVQcm92aWRlcih0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyKTtcblx0XHRpZiAodGhpcy5lZGl0b3IgIT09IHRoaXMuZGVmYXVsdEVkaXRvcikge1xuXHRcdFx0dGhpcy5lZGl0b3Iuc2V0QXV0b2NvbXBsZXRlUHJvdmlkZXI/Lih0aGlzLmF1dG9jb21wbGV0ZVByb3ZpZGVyKTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBpbml0KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLmlzSW5pdGlhbGl6ZWQpIHJldHVybjtcblxuXHRcdC8vIExvYWQgY2hhbmdlbG9nIChvbmx5IHNob3cgbmV3IGVudHJpZXMsIHNraXAgZm9yIHJlc3VtZWQgc2Vzc2lvbnMpXG5cdFx0dGhpcy5jaGFuZ2Vsb2dNYXJrZG93biA9IHRoaXMuZ2V0Q2hhbmdlbG9nRm9yRGlzcGxheSgpO1xuXG5cdFx0Ly8gRW5zdXJlIHJnIGlzIGF2YWlsYWJsZSAoZG93bmxvYWRzIGlmIG1pc3NpbmcsIGFkZHMgdG8gUEFUSCB2aWEgZ2V0QmluRGlyKVxuXHRcdC8vIHJnIGlzIG5lZWRlZCBmb3IgZ3JlcCB0b29sIGFuZCBiYXNoIGNvbW1hbmRzXG5cdFx0YXdhaXQgZW5zdXJlVG9vbChcInJnXCIpO1xuXG5cdFx0Ly8gQWRkIGhlYWRlciBjb250YWluZXIgYXMgZmlyc3QgY2hpbGRcblx0XHR0aGlzLnVpLmFkZENoaWxkKHRoaXMuaGVhZGVyQ29udGFpbmVyKTtcblxuXHRcdC8vIEFkZCBoZWFkZXIgd2l0aCBrZXliaW5kaW5ncyBmcm9tIGNvbmZpZyAodW5sZXNzIHNpbGVuY2VkKVxuXHRcdGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZSB8fCAhdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0UXVpZXRTdGFydHVwKCkpIHtcblx0XHRcdGNvbnN0IGxvZ28gPSB0aGVtZS5ib2xkKHRoZW1lLmZnKFwiYWNjZW50XCIsIEFQUF9OQU1FKSkgKyB0aGVtZS5mZyhcImRpbVwiLCBgIHYke3RoaXMudmVyc2lvbn1gKTtcblxuXHRcdFx0Ly8gQnVpbGQgc3RhcnR1cCBpbnN0cnVjdGlvbnMgdXNpbmcga2V5YmluZGluZyBoaW50IGhlbHBlcnNcblx0XHRcdGNvbnN0IGtiID0gdGhpcy5rZXliaW5kaW5ncztcblx0XHRcdGNvbnN0IGhpbnQgPSAoYWN0aW9uOiBBcHBBY3Rpb24sIGRlc2M6IHN0cmluZykgPT4gYXBwS2V5SGludChrYiwgYWN0aW9uLCBkZXNjKTtcblxuXHRcdFx0Y29uc3QgaW5zdHJ1Y3Rpb25zID0gW1xuXHRcdFx0XHRoaW50KFwiaW50ZXJydXB0XCIsIFwidG8gaW50ZXJydXB0XCIpLFxuXHRcdFx0XHRoaW50KFwiY2xlYXJcIiwgXCJ0byBjbGVhclwiKSxcblx0XHRcdFx0cmF3S2V5SGludChgJHthcHBLZXkoa2IsIFwiY2xlYXJcIil9IHR3aWNlYCwgXCJ0byBleGl0XCIpLFxuXHRcdFx0XHRoaW50KFwiZXhpdFwiLCBcInRvIGV4aXQgKGVtcHR5KVwiKSxcblx0XHRcdFx0aGludChcInN1c3BlbmRcIiwgXCJ0byBzdXNwZW5kXCIpLFxuXHRcdFx0XHRrZXlIaW50KFwiZGVsZXRlVG9MaW5lRW5kXCIsIFwidG8gZGVsZXRlIHRvIGVuZFwiKSxcblx0XHRcdFx0aGludChcImN5Y2xlVGhpbmtpbmdMZXZlbFwiLCBcInRvIGN5Y2xlIHRoaW5raW5nIGxldmVsXCIpLFxuXHRcdFx0XHRyYXdLZXlIaW50KGAke2FwcEtleShrYiwgXCJjeWNsZU1vZGVsRm9yd2FyZFwiKX0vJHthcHBLZXkoa2IsIFwiY3ljbGVNb2RlbEJhY2t3YXJkXCIpfWAsIFwidG8gY3ljbGUgbW9kZWxzXCIpLFxuXHRcdFx0XHRoaW50KFwic2VsZWN0TW9kZWxcIiwgXCJ0byBzZWxlY3QgbW9kZWxcIiksXG5cdFx0XHRcdGhpbnQoXCJleHBhbmRUb29sc1wiLCBcInRvIGV4cGFuZCB0b29sc1wiKSxcblx0XHRcdFx0aGludChcInRvZ2dsZVRoaW5raW5nXCIsIFwidG8gZXhwYW5kIHRoaW5raW5nXCIpLFxuXHRcdFx0XHRoaW50KFwiZXh0ZXJuYWxFZGl0b3JcIiwgXCJmb3IgZXh0ZXJuYWwgZWRpdG9yXCIpLFxuXHRcdFx0XHRyYXdLZXlIaW50KFwiL1wiLCBcImZvciBjb21tYW5kc1wiKSxcblx0XHRcdFx0cmF3S2V5SGludChcIiFcIiwgXCJ0byBydW4gYmFzaFwiKSxcblx0XHRcdFx0cmF3S2V5SGludChcIiEhXCIsIFwidG8gcnVuIGJhc2ggKG5vIGNvbnRleHQpXCIpLFxuXHRcdFx0XHRoaW50KFwiZm9sbG93VXBcIiwgXCJ0byBxdWV1ZSBmb2xsb3ctdXBcIiksXG5cdFx0XHRcdGhpbnQoXCJkZXF1ZXVlXCIsIFwidG8gZWRpdCBhbGwgcXVldWVkIG1lc3NhZ2VzXCIpLFxuXHRcdFx0XHRoaW50KFwicGFzdGVJbWFnZVwiLCBcInRvIHBhc3RlIGltYWdlXCIpLFxuXHRcdFx0XHRyYXdLZXlIaW50KFwiZHJvcCBmaWxlc1wiLCBcInRvIGF0dGFjaFwiKSxcblx0XHRcdF0uam9pbihcIlxcblwiKTtcblx0XHRcdHRoaXMuYnVpbHRJbkhlYWRlciA9IG5ldyBUZXh0KGAke2xvZ299XFxuJHtpbnN0cnVjdGlvbnN9YCwgMSwgMCk7XG5cblx0XHRcdC8vIFNldHVwIFVJIGxheW91dFxuXHRcdFx0dGhpcy5oZWFkZXJDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0XHR0aGlzLmhlYWRlckNvbnRhaW5lci5hZGRDaGlsZCh0aGlzLmJ1aWx0SW5IZWFkZXIpO1xuXHRcdFx0dGhpcy5oZWFkZXJDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cblx0XHRcdC8vIEFkZCBjaGFuZ2Vsb2cgaWYgcHJvdmlkZWRcblx0XHRcdGlmICh0aGlzLmNoYW5nZWxvZ01hcmtkb3duKSB7XG5cdFx0XHRcdHRoaXMuaGVhZGVyQ29udGFpbmVyLmFkZENoaWxkKG5ldyBEeW5hbWljQm9yZGVyKCkpO1xuXHRcdFx0XHRpZiAodGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0Q29sbGFwc2VDaGFuZ2Vsb2coKSkge1xuXHRcdFx0XHRcdGNvbnN0IHZlcnNpb25NYXRjaCA9IHRoaXMuY2hhbmdlbG9nTWFya2Rvd24ubWF0Y2goLyMjXFxzK1xcWz8oXFxkK1xcLlxcZCtcXC5cXGQrKVxcXT8vKTtcblx0XHRcdFx0XHRjb25zdCBsYXRlc3RWZXJzaW9uID0gdmVyc2lvbk1hdGNoID8gdmVyc2lvbk1hdGNoWzFdIDogdGhpcy52ZXJzaW9uO1xuXHRcdFx0XHRcdGNvbnN0IGNvbmRlbnNlZFRleHQgPSBgVXBkYXRlZCB0byB2JHtsYXRlc3RWZXJzaW9ufS4gVXNlICR7dGhlbWUuYm9sZChcIi9jaGFuZ2Vsb2dcIil9IHRvIHZpZXcgZnVsbCBjaGFuZ2Vsb2cuYDtcblx0XHRcdFx0XHR0aGlzLmhlYWRlckNvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dChjb25kZW5zZWRUZXh0LCAxLCAwKSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0dGhpcy5oZWFkZXJDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuYm9sZCh0aGVtZS5mZyhcImFjY2VudFwiLCBcIldoYXQncyBOZXdcIikpLCAxLCAwKSk7XG5cdFx0XHRcdFx0dGhpcy5oZWFkZXJDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0XHRcdFx0dGhpcy5oZWFkZXJDb250YWluZXIuYWRkQ2hpbGQoXG5cdFx0XHRcdFx0XHRuZXcgTWFya2Rvd24odGhpcy5jaGFuZ2Vsb2dNYXJrZG93bi50cmltKCksIDEsIDAsIHRoaXMuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncygpKSxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdHRoaXMuaGVhZGVyQ29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHRoaXMuaGVhZGVyQ29udGFpbmVyLmFkZENoaWxkKG5ldyBEeW5hbWljQm9yZGVyKCkpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBNaW5pbWFsIGhlYWRlciB3aGVuIHNpbGVuY2VkXG5cdFx0XHR0aGlzLmJ1aWx0SW5IZWFkZXIgPSBuZXcgVGV4dChcIlwiLCAwLCAwKTtcblx0XHRcdHRoaXMuaGVhZGVyQ29udGFpbmVyLmFkZENoaWxkKHRoaXMuYnVpbHRJbkhlYWRlcik7XG5cdFx0XHRpZiAodGhpcy5jaGFuZ2Vsb2dNYXJrZG93bikge1xuXHRcdFx0XHQvLyBTdGlsbCBzaG93IGNoYW5nZWxvZyBub3RpZmljYXRpb24gZXZlbiBpbiBzaWxlbnQgbW9kZVxuXHRcdFx0XHR0aGlzLmhlYWRlckNvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdFx0Y29uc3QgdmVyc2lvbk1hdGNoID0gdGhpcy5jaGFuZ2Vsb2dNYXJrZG93bi5tYXRjaCgvIyNcXHMrXFxbPyhcXGQrXFwuXFxkK1xcLlxcZCspXFxdPy8pO1xuXHRcdFx0XHRjb25zdCBsYXRlc3RWZXJzaW9uID0gdmVyc2lvbk1hdGNoID8gdmVyc2lvbk1hdGNoWzFdIDogdGhpcy52ZXJzaW9uO1xuXHRcdFx0XHRjb25zdCBjb25kZW5zZWRUZXh0ID0gYFVwZGF0ZWQgdG8gdiR7bGF0ZXN0VmVyc2lvbn0uIFVzZSAke3RoZW1lLmJvbGQoXCIvY2hhbmdlbG9nXCIpfSB0byB2aWV3IGZ1bGwgY2hhbmdlbG9nLmA7XG5cdFx0XHRcdHRoaXMuaGVhZGVyQ29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KGNvbmRlbnNlZFRleHQsIDEsIDApKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHR0aGlzLnVpLmFkZENoaWxkKHRoaXMuYWRhcHRpdmVMYXlvdXQpO1xuXHRcdHRoaXMudWkuYWRkQ2hpbGQodGhpcy5jaGF0Q29udGFpbmVyKTtcblx0XHR0aGlzLnVpLmFkZENoaWxkKHRoaXMucGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyKTtcblx0XHR0aGlzLnVpLmFkZENoaWxkKHRoaXMuc3RhdHVzQ29udGFpbmVyKTtcblx0XHR0aGlzLnVpLmFkZENoaWxkKHRoaXMucGlubmVkTWVzc2FnZUNvbnRhaW5lcik7XG5cdFx0dGhpcy51aS5hZGRDaGlsZCh0aGlzLmJsb2NraW5nRXJyb3JDb250YWluZXIpO1xuXHRcdHRoaXMucmVuZGVyV2lkZ2V0cygpOyAvLyBJbml0aWFsaXplIHdpdGggZGVmYXVsdCBzcGFjZXJcblx0XHR0aGlzLnVpLmFkZENoaWxkKHRoaXMud2lkZ2V0Q29udGFpbmVyQWJvdmUpO1xuXHRcdHRoaXMudWkuYWRkQ2hpbGQodGhpcy5lZGl0b3JDb250YWluZXIpO1xuXHRcdHRoaXMudWkuYWRkQ2hpbGQodGhpcy53aWRnZXRDb250YWluZXJCZWxvdyk7XG5cdFx0dGhpcy51aS5hZGRDaGlsZCh0aGlzLmZvb3Rlcik7XG5cdFx0dGhpcy51aS5zZXRGb2N1cyh0aGlzLmVkaXRvcik7XG5cblx0XHR0aGlzLnNldHVwS2V5SGFuZGxlcnMoKTtcblx0XHR0aGlzLnNldHVwRWRpdG9yU3VibWl0SGFuZGxlcigpO1xuXG5cdFx0Ly8gSW5pdGlhbGl6ZSBleHRlbnNpb25zIGZpcnN0IHNvIHJlc291cmNlcyBhcmUgc2hvd24gYmVmb3JlIG1lc3NhZ2VzXG5cdFx0YXdhaXQgdGhpcy5pbml0RXh0ZW5zaW9ucygpO1xuXG5cdFx0Ly8gUmVuZGVyIGluaXRpYWwgbWVzc2FnZXMgQUZURVIgc2hvd2luZyBsb2FkZWQgcmVzb3VyY2VzXG5cdFx0dGhpcy5yZW5kZXJJbml0aWFsTWVzc2FnZXMoKTtcblxuXHRcdC8vIFN0YXJ0IHRoZSBVSVxuXHRcdHRoaXMudWkuc3RhcnQoKTtcblx0XHR0aGlzLmlzSW5pdGlhbGl6ZWQgPSB0cnVlO1xuXG5cdFx0Ly8gU2V0IHRlcm1pbmFsIHRpdGxlXG5cdFx0dGhpcy51cGRhdGVUZXJtaW5hbFRpdGxlKCk7XG5cblx0XHQvLyBTdWJzY3JpYmUgdG8gYWdlbnQgZXZlbnRzXG5cdFx0dGhpcy5zdWJzY3JpYmVUb0FnZW50KCk7XG5cblx0XHQvLyBTZXQgdXAgdGhlbWUgZmlsZSB3YXRjaGVyXG5cdFx0b25UaGVtZUNoYW5nZSgoKSA9PiB7XG5cdFx0XHR0aGlzLnVpLmludmFsaWRhdGUoKTtcblx0XHRcdHRoaXMudXBkYXRlRWRpdG9yQm9yZGVyQ29sb3IoKTtcblx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdH0pO1xuXG5cdFx0Ly8gU2V0IHVwIGdpdCBicmFuY2ggd2F0Y2hlciAodXNlcyBwcm92aWRlciBpbnN0ZWFkIG9mIGZvb3Rlcilcblx0XHR0aGlzLl9icmFuY2hDaGFuZ2VVbnN1YiA9IHRoaXMuZm9vdGVyRGF0YVByb3ZpZGVyLm9uQnJhbmNoQ2hhbmdlKCgpID0+IHtcblx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdH0pO1xuXG5cdFx0Ly8gSW5pdGlhbGl6ZSBhdmFpbGFibGUgcHJvdmlkZXIgY291bnQgZm9yIGZvb3RlciBkaXNwbGF5XG5cdFx0YXdhaXQgdGhpcy51cGRhdGVBdmFpbGFibGVQcm92aWRlckNvdW50KCk7XG5cdH1cblxuXHQvKipcblx0ICogVXBkYXRlIHRlcm1pbmFsIHRpdGxlIHdpdGggc2Vzc2lvbiBuYW1lIGFuZCBjd2QuXG5cdCAqL1xuXHRwcml2YXRlIHVwZGF0ZVRlcm1pbmFsVGl0bGUoKTogdm9pZCB7XG5cdFx0Y29uc3QgY3dkQmFzZW5hbWUgPSBwYXRoLmJhc2VuYW1lKHByb2Nlc3MuY3dkKCkpO1xuXHRcdGNvbnN0IHNlc3Npb25OYW1lID0gdGhpcy5zZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uTmFtZSgpO1xuXHRcdGlmIChzZXNzaW9uTmFtZSkge1xuXHRcdFx0dGhpcy51aS50ZXJtaW5hbC5zZXRUaXRsZShgXHUwM0MwIC0gJHtzZXNzaW9uTmFtZX0gLSAke2N3ZEJhc2VuYW1lfWApO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLnVpLnRlcm1pbmFsLnNldFRpdGxlKGBcdTAzQzAgLSAke2N3ZEJhc2VuYW1lfWApO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBSdW4gdGhlIGludGVyYWN0aXZlIG1vZGUuIFRoaXMgaXMgdGhlIG1haW4gZW50cnkgcG9pbnQuXG5cdCAqIEluaXRpYWxpemVzIHRoZSBVSSwgc2hvd3Mgd2FybmluZ3MsIHByb2Nlc3NlcyBpbml0aWFsIG1lc3NhZ2VzLCBhbmQgc3RhcnRzIHRoZSBpbnRlcmFjdGl2ZSBsb29wLlxuXHQgKi9cblx0YXN5bmMgcnVuKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuaW5pdCgpO1xuXG5cdFx0Ly8gU3RhcnQgdmVyc2lvbiBjaGVjayBhc3luY2hyb25vdXNseVxuXHRcdHRoaXMuY2hlY2tGb3JOZXdWZXJzaW9uKCkudGhlbigobmV3VmVyc2lvbikgPT4ge1xuXHRcdFx0aWYgKG5ld1ZlcnNpb24pIHtcblx0XHRcdFx0dGhpcy5zaG93TmV3VmVyc2lvbk5vdGlmaWNhdGlvbihuZXdWZXJzaW9uKTtcblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdC8vIENoZWNrIHRtdXgga2V5Ym9hcmQgc2V0dXAgYXN5bmNocm9ub3VzbHlcblx0XHR0aGlzLmNoZWNrVG11eEtleWJvYXJkU2V0dXAoKS50aGVuKCh3YXJuaW5nKSA9PiB7XG5cdFx0XHRpZiAod2FybmluZykge1xuXHRcdFx0XHR0aGlzLnNob3dXYXJuaW5nKHdhcm5pbmcpO1xuXHRcdFx0fVxuXHRcdH0pO1xuXG5cdFx0Ly8gU2hvdyBzdGFydHVwIHdhcm5pbmdzXG5cdFx0Y29uc3QgeyBtaWdyYXRlZFByb3ZpZGVycywgbW9kZWxGYWxsYmFja01lc3NhZ2UsIGluaXRpYWxNZXNzYWdlLCBpbml0aWFsSW1hZ2VzLCBpbml0aWFsTWVzc2FnZXMgfSA9IHRoaXMub3B0aW9ucztcblxuXHRcdGlmIChtaWdyYXRlZFByb3ZpZGVycyAmJiBtaWdyYXRlZFByb3ZpZGVycy5sZW5ndGggPiAwKSB7XG5cdFx0XHR0aGlzLnNob3dXYXJuaW5nKGBNaWdyYXRlZCBjcmVkZW50aWFscyB0byBhdXRoLmpzb246ICR7bWlncmF0ZWRQcm92aWRlcnMuam9pbihcIiwgXCIpfWApO1xuXHRcdH1cblxuXHRcdGNvbnN0IG1vZGVsc0pzb25FcnJvciA9IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmdldEVycm9yKCk7XG5cdFx0aWYgKG1vZGVsc0pzb25FcnJvcikge1xuXHRcdFx0dGhpcy5zaG93RXJyb3IoYG1vZGVscy5qc29uIGVycm9yOiAke21vZGVsc0pzb25FcnJvcn1gKTtcblx0XHR9XG5cblx0XHRpZiAobW9kZWxGYWxsYmFja01lc3NhZ2UpIHtcblx0XHRcdHRoaXMuc2hvd1dhcm5pbmcobW9kZWxGYWxsYmFja01lc3NhZ2UpO1xuXHRcdH1cblxuXHRcdC8vIFByb2Nlc3MgaW5pdGlhbCBtZXNzYWdlc1xuXHRcdGlmIChpbml0aWFsTWVzc2FnZSkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgdGhpcy5zZXNzaW9uLnByb21wdChpbml0aWFsTWVzc2FnZSwgeyBpbWFnZXM6IGluaXRpYWxJbWFnZXMgfSk7XG5cdFx0XHR9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuXHRcdFx0XHRjb25zdCBlcnJvck1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFwiVW5rbm93biBlcnJvciBvY2N1cnJlZFwiO1xuXHRcdFx0XHR0aGlzLnNob3dFcnJvcihlcnJvck1lc3NhZ2UpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGlmIChpbml0aWFsTWVzc2FnZXMpIHtcblx0XHRcdGZvciAoY29uc3QgbWVzc2FnZSBvZiBpbml0aWFsTWVzc2FnZXMpIHtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnNlc3Npb24ucHJvbXB0KG1lc3NhZ2UpO1xuXHRcdFx0XHR9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuXHRcdFx0XHRcdGNvbnN0IGVycm9yTWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogXCJVbmtub3duIGVycm9yIG9jY3VycmVkXCI7XG5cdFx0XHRcdFx0dGhpcy5zaG93RXJyb3IoZXJyb3JNZXNzYWdlKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIE1haW4gaW50ZXJhY3RpdmUgbG9vcFxuXHRcdHdoaWxlICh0cnVlKSB7XG5cdFx0XHRjb25zdCB1c2VySW5wdXQgPSBhd2FpdCB0aGlzLmdldFVzZXJJbnB1dCgpO1xuXHRcdFx0Y29uc3QgaW1hZ2VzID0gdGhpcy5wZW5kaW5nSW1hZ2VzLmxlbmd0aCA+IDAgPyBbLi4udGhpcy5wZW5kaW5nSW1hZ2VzXSA6IHVuZGVmaW5lZDtcblx0XHRcdHRoaXMucGVuZGluZ0ltYWdlcy5sZW5ndGggPSAwO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0YXdhaXQgdGhpcy5zZXNzaW9uLnByb21wdCh1c2VySW5wdXQsIHsgaW1hZ2VzIH0pO1xuXHRcdFx0fSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcblx0XHRcdFx0Y29uc3QgZXJyb3JNZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBcIlVua25vd24gZXJyb3Igb2NjdXJyZWRcIjtcblx0XHRcdFx0dGhpcy5zaG93RXJyb3IoZXJyb3JNZXNzYWdlKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2sgbnBtIHJlZ2lzdHJ5IGZvciBhIG5ld2VyIHZlcnNpb24uXG5cdCAqL1xuXHRwcml2YXRlIGFzeW5jIGNoZWNrRm9yTmV3VmVyc2lvbigpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuXHRcdGlmIChwcm9jZXNzLmVudi5QSV9TS0lQX1ZFUlNJT05fQ0hFQ0sgfHwgcHJvY2Vzcy5lbnYuUElfT0ZGTElORSkgcmV0dXJuIHVuZGVmaW5lZDtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiaHR0cHM6Ly9yZWdpc3RyeS5ucG1qcy5vcmcvQGdzZC9waS1jb2RpbmctYWdlbnQvbGF0ZXN0XCIsIHtcblx0XHRcdFx0c2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDEwMDAwKSxcblx0XHRcdH0pO1xuXHRcdFx0aWYgKCFyZXNwb25zZS5vaykgcmV0dXJuIHVuZGVmaW5lZDtcblxuXHRcdFx0Y29uc3QgZGF0YSA9IChhd2FpdCByZXNwb25zZS5qc29uKCkpIGFzIHsgdmVyc2lvbj86IHN0cmluZyB9O1xuXHRcdFx0Y29uc3QgbGF0ZXN0VmVyc2lvbiA9IGRhdGEudmVyc2lvbjtcblxuXHRcdFx0aWYgKGxhdGVzdFZlcnNpb24gJiYgbGF0ZXN0VmVyc2lvbiAhPT0gdGhpcy52ZXJzaW9uKSB7XG5cdFx0XHRcdHJldHVybiBsYXRlc3RWZXJzaW9uO1xuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGNoZWNrVG11eEtleWJvYXJkU2V0dXAoKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcblx0XHRpZiAoIXByb2Nlc3MuZW52LlRNVVgpIHJldHVybiB1bmRlZmluZWQ7XG5cblx0XHRjb25zdCBydW5UbXV4U2hvdyA9IChvcHRpb246IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiA9PiB7XG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcblx0XHRcdFx0Y29uc3QgcHJvYyA9IHNwYXduKFwidG11eFwiLCBbXCJzaG93XCIsIFwiLWd2XCIsIG9wdGlvbl0sIHtcblx0XHRcdFx0XHRzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGxldCBzdGRvdXQgPSBcIlwiO1xuXHRcdFx0XHRjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRcdHByb2Mua2lsbCgpO1xuXHRcdFx0XHRcdHJlc29sdmUodW5kZWZpbmVkKTtcblx0XHRcdFx0fSwgMjAwMCk7XG5cblx0XHRcdFx0cHJvYy5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoZGF0YSkgPT4ge1xuXHRcdFx0XHRcdHN0ZG91dCArPSBkYXRhLnRvU3RyaW5nKCk7XG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRwcm9jLm9uKFwiZXJyb3JcIiwgKCkgPT4ge1xuXHRcdFx0XHRcdGNsZWFyVGltZW91dCh0aW1lcik7XG5cdFx0XHRcdFx0cmVzb2x2ZSh1bmRlZmluZWQpO1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0cHJvYy5vbihcImNsb3NlXCIsIChjb2RlKSA9PiB7XG5cdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVyKTtcblx0XHRcdFx0XHRyZXNvbHZlKGNvZGUgPT09IDAgPyBzdGRvdXQudHJpbSgpIDogdW5kZWZpbmVkKTtcblx0XHRcdFx0fSk7XG5cdFx0XHR9KTtcblx0XHR9O1xuXG5cdFx0Y29uc3QgW2V4dGVuZGVkS2V5cywgZXh0ZW5kZWRLZXlzRm9ybWF0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcblx0XHRcdHJ1blRtdXhTaG93KFwiZXh0ZW5kZWQta2V5c1wiKSxcblx0XHRcdHJ1blRtdXhTaG93KFwiZXh0ZW5kZWQta2V5cy1mb3JtYXRcIiksXG5cdFx0XSk7XG5cblx0XHRpZiAoZXh0ZW5kZWRLZXlzICE9PSBcIm9uXCIgJiYgZXh0ZW5kZWRLZXlzICE9PSBcImFsd2F5c1wiKSB7XG5cdFx0XHRyZXR1cm4gXCJ0bXV4IGV4dGVuZGVkLWtleXMgaXMgb2ZmLiBNb2RpZmllZCBFbnRlciBrZXlzIG1heSBub3Qgd29yay4gQWRkIGBzZXQgLWcgZXh0ZW5kZWQta2V5cyBvbmAgdG8gfi8udG11eC5jb25mIGFuZCByZXN0YXJ0IHRtdXguXCI7XG5cdFx0fVxuXG5cdFx0aWYgKGV4dGVuZGVkS2V5c0Zvcm1hdCA9PT0gXCJ4dGVybVwiKSB7XG5cdFx0XHRyZXR1cm4gXCJ0bXV4IGV4dGVuZGVkLWtleXMtZm9ybWF0IGlzIHh0ZXJtLiBQaSB3b3JrcyBiZXN0IHdpdGggY3NpLXUuIEFkZCBgc2V0IC1nIGV4dGVuZGVkLWtleXMtZm9ybWF0IGNzaS11YCB0byB+Ly50bXV4LmNvbmYgYW5kIHJlc3RhcnQgdG11eC5cIjtcblx0XHR9XG5cblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBjaGFuZ2Vsb2cgZW50cmllcyB0byBkaXNwbGF5IG9uIHN0YXJ0dXAuXG5cdCAqIE9ubHkgc2hvd3MgbmV3IGVudHJpZXMgc2luY2UgbGFzdCBzZWVuIHZlcnNpb24sIHNraXBzIGZvciByZXN1bWVkIHNlc3Npb25zLlxuXHQgKi9cblx0cHJpdmF0ZSBnZXRDaGFuZ2Vsb2dGb3JEaXNwbGF5KCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0Ly8gU2tpcCBjaGFuZ2Vsb2cgZm9yIHJlc3VtZWQvY29udGludWVkIHNlc3Npb25zIChhbHJlYWR5IGhhdmUgbWVzc2FnZXMpXG5cdFx0aWYgKHRoaXMuc2Vzc2lvbi5zdGF0ZS5tZXNzYWdlcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHRcdH1cblxuXHRcdGNvbnN0IGxhc3RWZXJzaW9uID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0TGFzdENoYW5nZWxvZ1ZlcnNpb24oKTtcblx0XHRjb25zdCBjaGFuZ2Vsb2dQYXRoID0gZ2V0Q2hhbmdlbG9nUGF0aCgpO1xuXHRcdGNvbnN0IGVudHJpZXMgPSBwYXJzZUNoYW5nZWxvZyhjaGFuZ2Vsb2dQYXRoKTtcblxuXHRcdGlmICghbGFzdFZlcnNpb24pIHtcblx0XHRcdC8vIEZyZXNoIGluc3RhbGwgLSBqdXN0IHJlY29yZCB0aGUgdmVyc2lvbiwgZG9uJ3Qgc2hvdyBjaGFuZ2Vsb2dcblx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldExhc3RDaGFuZ2Vsb2dWZXJzaW9uKFZFUlNJT04pO1xuXHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgbmV3RW50cmllcyA9IGdldE5ld0VudHJpZXMoZW50cmllcywgbGFzdFZlcnNpb24pO1xuXHRcdFx0aWYgKG5ld0VudHJpZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRMYXN0Q2hhbmdlbG9nVmVyc2lvbihWRVJTSU9OKTtcblx0XHRcdFx0cmV0dXJuIG5ld0VudHJpZXMubWFwKChlKSA9PiBlLmNvbnRlbnQpLmpvaW4oXCJcXG5cXG5cIik7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0fVxuXG5cdHByaXZhdGUgZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncygpOiBNYXJrZG93blRoZW1lIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0Li4uZ2V0TWFya2Rvd25UaGVtZSgpLFxuXHRcdFx0Y29kZUJsb2NrSW5kZW50OiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRDb2RlQmxvY2tJbmRlbnQoKSxcblx0XHR9O1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBFeHRlbnNpb24gU3lzdGVtXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHRwcml2YXRlIGZvcm1hdERpc3BsYXlQYXRoKHA6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3QgaG9tZSA9IG9zLmhvbWVkaXIoKTtcblx0XHRsZXQgcmVzdWx0ID0gcDtcblxuXHRcdC8vIFJlcGxhY2UgaG9tZSBkaXJlY3Rvcnkgd2l0aCB+XG5cdFx0aWYgKHJlc3VsdC5zdGFydHNXaXRoKGhvbWUpKSB7XG5cdFx0XHRyZXN1bHQgPSBgfiR7cmVzdWx0LnNsaWNlKGhvbWUubGVuZ3RoKX1gO1xuXHRcdH1cblxuXHRcdHJldHVybiByZXN1bHQ7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGEgc2hvcnQgcGF0aCByZWxhdGl2ZSB0byB0aGUgcGFja2FnZSByb290IGZvciBkaXNwbGF5LlxuXHQgKi9cblx0cHJpdmF0ZSBnZXRTaG9ydFBhdGgoZnVsbFBhdGg6IHN0cmluZywgc291cmNlOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdC8vIEZvciBucG0gcGFja2FnZXMsIHNob3cgcGF0aCByZWxhdGl2ZSB0byBub2RlX21vZHVsZXMvcGtnL1xuXHRcdGNvbnN0IG5wbU1hdGNoID0gZnVsbFBhdGgubWF0Y2goL25vZGVfbW9kdWxlc1xcLyhAP1teL10rKD86XFwvW14vXSspPylcXC8oLiopLyk7XG5cdFx0aWYgKG5wbU1hdGNoICYmIHNvdXJjZS5zdGFydHNXaXRoKFwibnBtOlwiKSkge1xuXHRcdFx0cmV0dXJuIG5wbU1hdGNoWzJdO1xuXHRcdH1cblxuXHRcdC8vIEZvciBnaXQgcGFja2FnZXMsIHNob3cgcGF0aCByZWxhdGl2ZSB0byByZXBvIHJvb3Rcblx0XHRjb25zdCBnaXRNYXRjaCA9IGZ1bGxQYXRoLm1hdGNoKC9naXRcXC9bXi9dK1xcL1teL10rXFwvKC4qKS8pO1xuXHRcdGlmIChnaXRNYXRjaCAmJiBzb3VyY2Uuc3RhcnRzV2l0aChcImdpdDpcIikpIHtcblx0XHRcdHJldHVybiBnaXRNYXRjaFsxXTtcblx0XHR9XG5cblx0XHQvLyBGb3IgbG9jYWwvYXV0bywganVzdCB1c2UgZm9ybWF0RGlzcGxheVBhdGhcblx0XHRyZXR1cm4gdGhpcy5mb3JtYXREaXNwbGF5UGF0aChmdWxsUGF0aCk7XG5cdH1cblxuXHRwcml2YXRlIGdldERpc3BsYXlTb3VyY2VJbmZvKFxuXHRcdHNvdXJjZTogc3RyaW5nLFxuXHRcdHNjb3BlOiBzdHJpbmcsXG5cdCk6IHsgbGFiZWw6IHN0cmluZzsgc2NvcGVMYWJlbD86IHN0cmluZzsgY29sb3I6IFwiYWNjZW50XCIgfCBcIm11dGVkXCIgfSB7XG5cdFx0aWYgKHNvdXJjZSA9PT0gXCJsb2NhbFwiKSB7XG5cdFx0XHRpZiAoc2NvcGUgPT09IFwidXNlclwiKSB7XG5cdFx0XHRcdHJldHVybiB7IGxhYmVsOiBcInVzZXJcIiwgY29sb3I6IFwibXV0ZWRcIiB9O1xuXHRcdFx0fVxuXHRcdFx0aWYgKHNjb3BlID09PSBcInByb2plY3RcIikge1xuXHRcdFx0XHRyZXR1cm4geyBsYWJlbDogXCJwcm9qZWN0XCIsIGNvbG9yOiBcIm11dGVkXCIgfTtcblx0XHRcdH1cblx0XHRcdGlmIChzY29wZSA9PT0gXCJ0ZW1wb3JhcnlcIikge1xuXHRcdFx0XHRyZXR1cm4geyBsYWJlbDogXCJwYXRoXCIsIHNjb3BlTGFiZWw6IFwidGVtcFwiLCBjb2xvcjogXCJtdXRlZFwiIH07XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4geyBsYWJlbDogXCJwYXRoXCIsIGNvbG9yOiBcIm11dGVkXCIgfTtcblx0XHR9XG5cblx0XHRpZiAoc291cmNlID09PSBcImNsaVwiKSB7XG5cdFx0XHRyZXR1cm4geyBsYWJlbDogXCJwYXRoXCIsIHNjb3BlTGFiZWw6IHNjb3BlID09PSBcInRlbXBvcmFyeVwiID8gXCJ0ZW1wXCIgOiB1bmRlZmluZWQsIGNvbG9yOiBcIm11dGVkXCIgfTtcblx0XHR9XG5cblx0XHRjb25zdCBzY29wZUxhYmVsID1cblx0XHRcdHNjb3BlID09PSBcInVzZXJcIiA/IFwidXNlclwiIDogc2NvcGUgPT09IFwicHJvamVjdFwiID8gXCJwcm9qZWN0XCIgOiBzY29wZSA9PT0gXCJ0ZW1wb3JhcnlcIiA/IFwidGVtcFwiIDogdW5kZWZpbmVkO1xuXHRcdHJldHVybiB7IGxhYmVsOiBzb3VyY2UsIHNjb3BlTGFiZWwsIGNvbG9yOiBcImFjY2VudFwiIH07XG5cdH1cblxuXHRwcml2YXRlIGdldFNjb3BlR3JvdXAoc291cmNlOiBzdHJpbmcsIHNjb3BlOiBzdHJpbmcpOiBcInVzZXJcIiB8IFwicHJvamVjdFwiIHwgXCJwYXRoXCIge1xuXHRcdGlmIChzb3VyY2UgPT09IFwiY2xpXCIgfHwgc2NvcGUgPT09IFwidGVtcG9yYXJ5XCIpIHJldHVybiBcInBhdGhcIjtcblx0XHRpZiAoc2NvcGUgPT09IFwidXNlclwiKSByZXR1cm4gXCJ1c2VyXCI7XG5cdFx0aWYgKHNjb3BlID09PSBcInByb2plY3RcIikgcmV0dXJuIFwicHJvamVjdFwiO1xuXHRcdHJldHVybiBcInBhdGhcIjtcblx0fVxuXG5cdHByaXZhdGUgaXNQYWNrYWdlU291cmNlKHNvdXJjZTogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHNvdXJjZS5zdGFydHNXaXRoKFwibnBtOlwiKSB8fCBzb3VyY2Uuc3RhcnRzV2l0aChcImdpdDpcIik7XG5cdH1cblxuXHRwcml2YXRlIGJ1aWxkU2NvcGVHcm91cHMoXG5cdFx0cGF0aHM6IHN0cmluZ1tdLFxuXHRcdG1ldGFkYXRhOiBNYXA8c3RyaW5nLCB7IHNvdXJjZTogc3RyaW5nOyBzY29wZTogc3RyaW5nOyBvcmlnaW46IHN0cmluZyB9Pixcblx0KTogQXJyYXk8eyBzY29wZTogXCJ1c2VyXCIgfCBcInByb2plY3RcIiB8IFwicGF0aFwiOyBwYXRoczogc3RyaW5nW107IHBhY2thZ2VzOiBNYXA8c3RyaW5nLCBzdHJpbmdbXT4gfT4ge1xuXHRcdGNvbnN0IGdyb3VwczogUmVjb3JkPFxuXHRcdFx0XCJ1c2VyXCIgfCBcInByb2plY3RcIiB8IFwicGF0aFwiLFxuXHRcdFx0eyBzY29wZTogXCJ1c2VyXCIgfCBcInByb2plY3RcIiB8IFwicGF0aFwiOyBwYXRoczogc3RyaW5nW107IHBhY2thZ2VzOiBNYXA8c3RyaW5nLCBzdHJpbmdbXT4gfVxuXHRcdD4gPSB7XG5cdFx0XHR1c2VyOiB7IHNjb3BlOiBcInVzZXJcIiwgcGF0aHM6IFtdLCBwYWNrYWdlczogbmV3IE1hcCgpIH0sXG5cdFx0XHRwcm9qZWN0OiB7IHNjb3BlOiBcInByb2plY3RcIiwgcGF0aHM6IFtdLCBwYWNrYWdlczogbmV3IE1hcCgpIH0sXG5cdFx0XHRwYXRoOiB7IHNjb3BlOiBcInBhdGhcIiwgcGF0aHM6IFtdLCBwYWNrYWdlczogbmV3IE1hcCgpIH0sXG5cdFx0fTtcblxuXHRcdGZvciAoY29uc3QgcCBvZiBwYXRocykge1xuXHRcdFx0Y29uc3QgbWV0YSA9IHRoaXMuZmluZE1ldGFkYXRhKHAsIG1ldGFkYXRhKTtcblx0XHRcdGNvbnN0IHNvdXJjZSA9IG1ldGE/LnNvdXJjZSA/PyBcImxvY2FsXCI7XG5cdFx0XHRjb25zdCBzY29wZSA9IG1ldGE/LnNjb3BlID8/IFwicHJvamVjdFwiO1xuXHRcdFx0Y29uc3QgZ3JvdXBLZXkgPSB0aGlzLmdldFNjb3BlR3JvdXAoc291cmNlLCBzY29wZSk7XG5cdFx0XHRjb25zdCBncm91cCA9IGdyb3Vwc1tncm91cEtleV07XG5cblx0XHRcdGlmICh0aGlzLmlzUGFja2FnZVNvdXJjZShzb3VyY2UpKSB7XG5cdFx0XHRcdGNvbnN0IGxpc3QgPSBncm91cC5wYWNrYWdlcy5nZXQoc291cmNlKSA/PyBbXTtcblx0XHRcdFx0bGlzdC5wdXNoKHApO1xuXHRcdFx0XHRncm91cC5wYWNrYWdlcy5zZXQoc291cmNlLCBsaXN0KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGdyb3VwLnBhdGhzLnB1c2gocCk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIFtncm91cHMucHJvamVjdCwgZ3JvdXBzLnVzZXIsIGdyb3Vwcy5wYXRoXS5maWx0ZXIoXG5cdFx0XHQoZ3JvdXApID0+IGdyb3VwLnBhdGhzLmxlbmd0aCA+IDAgfHwgZ3JvdXAucGFja2FnZXMuc2l6ZSA+IDAsXG5cdFx0KTtcblx0fVxuXG5cdHByaXZhdGUgZm9ybWF0U2NvcGVHcm91cHMoXG5cdFx0Z3JvdXBzOiBBcnJheTx7IHNjb3BlOiBcInVzZXJcIiB8IFwicHJvamVjdFwiIHwgXCJwYXRoXCI7IHBhdGhzOiBzdHJpbmdbXTsgcGFja2FnZXM6IE1hcDxzdHJpbmcsIHN0cmluZ1tdPiB9Pixcblx0XHRvcHRpb25zOiB7XG5cdFx0XHRmb3JtYXRQYXRoOiAocDogc3RyaW5nKSA9PiBzdHJpbmc7XG5cdFx0XHRmb3JtYXRQYWNrYWdlUGF0aDogKHA6IHN0cmluZywgc291cmNlOiBzdHJpbmcpID0+IHN0cmluZztcblx0XHR9LFxuXHQpOiBzdHJpbmcge1xuXHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0Zm9yIChjb25zdCBncm91cCBvZiBncm91cHMpIHtcblx0XHRcdGxpbmVzLnB1c2goYCAgJHt0aGVtZS5mZyhcImFjY2VudFwiLCBncm91cC5zY29wZSl9YCk7XG5cblx0XHRcdGNvbnN0IHNvcnRlZFBhdGhzID0gWy4uLmdyb3VwLnBhdGhzXS5zb3J0KChhLCBiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpO1xuXHRcdFx0Zm9yIChjb25zdCBwIG9mIHNvcnRlZFBhdGhzKSB7XG5cdFx0XHRcdGxpbmVzLnB1c2godGhlbWUuZmcoXCJkaW1cIiwgYCAgICAke29wdGlvbnMuZm9ybWF0UGF0aChwKX1gKSk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHNvcnRlZFBhY2thZ2VzID0gQXJyYXkuZnJvbShncm91cC5wYWNrYWdlcy5lbnRyaWVzKCkpLnNvcnQoKFthXSwgW2JdKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpO1xuXHRcdFx0Zm9yIChjb25zdCBbc291cmNlLCBwYXRoc10gb2Ygc29ydGVkUGFja2FnZXMpIHtcblx0XHRcdFx0bGluZXMucHVzaChgICAgICR7dGhlbWUuZmcoXCJtZExpbmtcIiwgc291cmNlKX1gKTtcblx0XHRcdFx0Y29uc3Qgc29ydGVkUGFja2FnZVBhdGhzID0gWy4uLnBhdGhzXS5zb3J0KChhLCBiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpO1xuXHRcdFx0XHRmb3IgKGNvbnN0IHAgb2Ygc29ydGVkUGFja2FnZVBhdGhzKSB7XG5cdFx0XHRcdFx0bGluZXMucHVzaCh0aGVtZS5mZyhcImRpbVwiLCBgICAgICAgJHtvcHRpb25zLmZvcm1hdFBhY2thZ2VQYXRoKHAsIHNvdXJjZSl9YCkpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG5cdH1cblxuXHQvKipcblx0ICogRmluZCBtZXRhZGF0YSBmb3IgYSBwYXRoLCBjaGVja2luZyBwYXJlbnQgZGlyZWN0b3JpZXMgaWYgZXhhY3QgbWF0Y2ggZmFpbHMuXG5cdCAqIFBhY2thZ2UgbWFuYWdlciBzdG9yZXMgbWV0YWRhdGEgZm9yIGRpcmVjdG9yaWVzLCBidXQgd2UgZGlzcGxheSBmaWxlIHBhdGhzLlxuXHQgKi9cblx0cHJpdmF0ZSBmaW5kTWV0YWRhdGEoXG5cdFx0cDogc3RyaW5nLFxuXHRcdG1ldGFkYXRhOiBNYXA8c3RyaW5nLCB7IHNvdXJjZTogc3RyaW5nOyBzY29wZTogc3RyaW5nOyBvcmlnaW46IHN0cmluZyB9Pixcblx0KTogeyBzb3VyY2U6IHN0cmluZzsgc2NvcGU6IHN0cmluZzsgb3JpZ2luOiBzdHJpbmcgfSB8IHVuZGVmaW5lZCB7XG5cdFx0Ly8gVHJ5IGV4YWN0IG1hdGNoIGZpcnN0XG5cdFx0Y29uc3QgZXhhY3QgPSBtZXRhZGF0YS5nZXQocCk7XG5cdFx0aWYgKGV4YWN0KSByZXR1cm4gZXhhY3Q7XG5cblx0XHQvLyBUcnkgcGFyZW50IGRpcmVjdG9yaWVzIChwYWNrYWdlIG1hbmFnZXIgc3RvcmVzIGRpcmVjdG9yeSBwYXRocylcblx0XHRsZXQgY3VycmVudCA9IHA7XG5cdFx0bGV0IHBhcmVudCA9IHBhdGguZGlybmFtZShjdXJyZW50KTtcblx0XHR3aGlsZSAocGFyZW50ICE9PSBjdXJyZW50KSB7XG5cdFx0XHRjb25zdCBtZXRhID0gbWV0YWRhdGEuZ2V0KHBhcmVudCk7XG5cdFx0XHRpZiAobWV0YSkgcmV0dXJuIG1ldGE7XG5cdFx0XHRjdXJyZW50ID0gcGFyZW50O1xuXHRcdFx0cGFyZW50ID0gcGF0aC5kaXJuYW1lKGN1cnJlbnQpO1xuXHRcdH1cblxuXHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdH1cblxuXHQvKipcblx0ICogRm9ybWF0IGEgcGF0aCB3aXRoIGl0cyBzb3VyY2Uvc2NvcGUgaW5mbyBmcm9tIG1ldGFkYXRhLlxuXHQgKi9cblx0cHJpdmF0ZSBmb3JtYXRQYXRoV2l0aFNvdXJjZShcblx0XHRwOiBzdHJpbmcsXG5cdFx0bWV0YWRhdGE6IE1hcDxzdHJpbmcsIHsgc291cmNlOiBzdHJpbmc7IHNjb3BlOiBzdHJpbmc7IG9yaWdpbjogc3RyaW5nIH0+LFxuXHQpOiBzdHJpbmcge1xuXHRcdGNvbnN0IG1ldGEgPSB0aGlzLmZpbmRNZXRhZGF0YShwLCBtZXRhZGF0YSk7XG5cdFx0aWYgKG1ldGEpIHtcblx0XHRcdGNvbnN0IHNob3J0UGF0aCA9IHRoaXMuZ2V0U2hvcnRQYXRoKHAsIG1ldGEuc291cmNlKTtcblx0XHRcdGNvbnN0IHsgbGFiZWwsIHNjb3BlTGFiZWwgfSA9IHRoaXMuZ2V0RGlzcGxheVNvdXJjZUluZm8obWV0YS5zb3VyY2UsIG1ldGEuc2NvcGUpO1xuXHRcdFx0Y29uc3QgbGFiZWxUZXh0ID0gc2NvcGVMYWJlbCA/IGAke2xhYmVsfSAoJHtzY29wZUxhYmVsfSlgIDogbGFiZWw7XG5cdFx0XHRyZXR1cm4gYCR7bGFiZWxUZXh0fSAke3Nob3J0UGF0aH1gO1xuXHRcdH1cblx0XHRyZXR1cm4gdGhpcy5mb3JtYXREaXNwbGF5UGF0aChwKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBGb3JtYXQgcmVzb3VyY2UgZGlhZ25vc3RpY3Mgd2l0aCBuaWNlIGNvbGxpc2lvbiBkaXNwbGF5IHVzaW5nIG1ldGFkYXRhLlxuXHQgKi9cblx0cHJpdmF0ZSBmb3JtYXREaWFnbm9zdGljcyhcblx0XHRkaWFnbm9zdGljczogcmVhZG9ubHkgUmVzb3VyY2VEaWFnbm9zdGljW10sXG5cdFx0bWV0YWRhdGE6IE1hcDxzdHJpbmcsIHsgc291cmNlOiBzdHJpbmc7IHNjb3BlOiBzdHJpbmc7IG9yaWdpbjogc3RyaW5nIH0+LFxuXHQpOiBzdHJpbmcge1xuXHRcdGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0Ly8gR3JvdXAgY29sbGlzaW9uIGRpYWdub3N0aWNzIGJ5IG5hbWVcblx0XHRjb25zdCBjb2xsaXNpb25zID0gbmV3IE1hcDxzdHJpbmcsIFJlc291cmNlRGlhZ25vc3RpY1tdPigpO1xuXHRcdGNvbnN0IG90aGVyRGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdID0gW107XG5cblx0XHRmb3IgKGNvbnN0IGQgb2YgZGlhZ25vc3RpY3MpIHtcblx0XHRcdGlmIChkLnR5cGUgPT09IFwiY29sbGlzaW9uXCIgJiYgZC5jb2xsaXNpb24pIHtcblx0XHRcdFx0Y29uc3QgbGlzdCA9IGNvbGxpc2lvbnMuZ2V0KGQuY29sbGlzaW9uLm5hbWUpID8/IFtdO1xuXHRcdFx0XHRsaXN0LnB1c2goZCk7XG5cdFx0XHRcdGNvbGxpc2lvbnMuc2V0KGQuY29sbGlzaW9uLm5hbWUsIGxpc3QpO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0b3RoZXJEaWFnbm9zdGljcy5wdXNoKGQpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIEZvcm1hdCBjb2xsaXNpb24gZGlhZ25vc3RpY3MgZ3JvdXBlZCBieSBuYW1lXG5cdFx0Zm9yIChjb25zdCBbbmFtZSwgY29sbGlzaW9uTGlzdF0gb2YgY29sbGlzaW9ucykge1xuXHRcdFx0Y29uc3QgZmlyc3QgPSBjb2xsaXNpb25MaXN0WzBdPy5jb2xsaXNpb247XG5cdFx0XHRpZiAoIWZpcnN0KSBjb250aW51ZTtcblx0XHRcdGxpbmVzLnB1c2godGhlbWUuZmcoXCJ3YXJuaW5nXCIsIGAgIFwiJHtuYW1lfVwiIGNvbGxpc2lvbjpgKSk7XG5cdFx0XHQvLyBTaG93IHdpbm5lclxuXHRcdFx0bGluZXMucHVzaChcblx0XHRcdFx0dGhlbWUuZmcoXCJkaW1cIiwgYCAgICAke3RoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlx1MjcxM1wiKX0gJHt0aGlzLmZvcm1hdFBhdGhXaXRoU291cmNlKGZpcnN0Lndpbm5lclBhdGgsIG1ldGFkYXRhKX1gKSxcblx0XHRcdCk7XG5cdFx0XHQvLyBTaG93IGFsbCBsb3NlcnNcblx0XHRcdGZvciAoY29uc3QgZCBvZiBjb2xsaXNpb25MaXN0KSB7XG5cdFx0XHRcdGlmIChkLmNvbGxpc2lvbikge1xuXHRcdFx0XHRcdGxpbmVzLnB1c2goXG5cdFx0XHRcdFx0XHR0aGVtZS5mZyhcblx0XHRcdFx0XHRcdFx0XCJkaW1cIixcblx0XHRcdFx0XHRcdFx0YCAgICAke3RoZW1lLmZnKFwid2FybmluZ1wiLCBcIlx1MjcxN1wiKX0gJHt0aGlzLmZvcm1hdFBhdGhXaXRoU291cmNlKGQuY29sbGlzaW9uLmxvc2VyUGF0aCwgbWV0YWRhdGEpfSAoc2tpcHBlZClgLFxuXHRcdFx0XHRcdFx0KSxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gRm9ybWF0IG90aGVyIGRpYWdub3N0aWNzIChza2lsbCBuYW1lIGNvbGxpc2lvbnMsIHBhcnNlIGVycm9ycywgZXRjLilcblx0XHRmb3IgKGNvbnN0IGQgb2Ygb3RoZXJEaWFnbm9zdGljcykge1xuXHRcdFx0aWYgKGQucGF0aCkge1xuXHRcdFx0XHQvLyBVc2UgbWV0YWRhdGEtYXdhcmUgZm9ybWF0dGluZyBmb3IgcGF0aHNcblx0XHRcdFx0Y29uc3Qgc291cmNlSW5mbyA9IHRoaXMuZm9ybWF0UGF0aFdpdGhTb3VyY2UoZC5wYXRoLCBtZXRhZGF0YSk7XG5cdFx0XHRcdGxpbmVzLnB1c2godGhlbWUuZmcoZC50eXBlID09PSBcImVycm9yXCIgPyBcImVycm9yXCIgOiBcIndhcm5pbmdcIiwgYCAgJHtzb3VyY2VJbmZvfWApKTtcblx0XHRcdFx0bGluZXMucHVzaCh0aGVtZS5mZyhkLnR5cGUgPT09IFwiZXJyb3JcIiA/IFwiZXJyb3JcIiA6IFwid2FybmluZ1wiLCBgICAgICR7ZC5tZXNzYWdlfWApKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGxpbmVzLnB1c2godGhlbWUuZmcoZC50eXBlID09PSBcImVycm9yXCIgPyBcImVycm9yXCIgOiBcIndhcm5pbmdcIiwgYCAgJHtkLm1lc3NhZ2V9YCkpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xuXHR9XG5cblx0cHJpdmF0ZSBzaG93TG9hZGVkUmVzb3VyY2VzKG9wdGlvbnM/OiB7XG5cdFx0ZXh0ZW5zaW9uUGF0aHM/OiBzdHJpbmdbXTtcblx0XHRmb3JjZT86IGJvb2xlYW47XG5cdFx0c2hvd0RpYWdub3N0aWNzV2hlblF1aWV0PzogYm9vbGVhbjtcblx0fSk6IHZvaWQge1xuXHRcdGNvbnN0IHNob3dMaXN0aW5nID0gb3B0aW9ucz8uZm9yY2UgfHwgdGhpcy5vcHRpb25zLnZlcmJvc2UgfHwgIXRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldFF1aWV0U3RhcnR1cCgpO1xuXHRcdGNvbnN0IHNob3dEaWFnbm9zdGljcyA9IHNob3dMaXN0aW5nIHx8IG9wdGlvbnM/LnNob3dEaWFnbm9zdGljc1doZW5RdWlldCA9PT0gdHJ1ZTtcblx0XHRpZiAoIXNob3dMaXN0aW5nICYmICFzaG93RGlhZ25vc3RpY3MpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBtZXRhZGF0YSA9IHRoaXMuc2Vzc2lvbi5yZXNvdXJjZUxvYWRlci5nZXRQYXRoTWV0YWRhdGEoKTtcblx0XHRjb25zdCBzZWN0aW9uSGVhZGVyID0gKG5hbWU6IHN0cmluZywgY29sb3I6IFRoZW1lQ29sb3IgPSBcIm1kSGVhZGluZ1wiKSA9PiB0aGVtZS5mZyhjb2xvciwgYFske25hbWV9XWApO1xuXG5cdFx0Y29uc3Qgc2tpbGxzUmVzdWx0ID0gdGhpcy5zZXNzaW9uLnJlc291cmNlTG9hZGVyLmdldFNraWxscygpO1xuXHRcdGNvbnN0IHByb21wdHNSZXN1bHQgPSB0aGlzLnNlc3Npb24ucmVzb3VyY2VMb2FkZXIuZ2V0UHJvbXB0cygpO1xuXHRcdGNvbnN0IHRoZW1lc1Jlc3VsdCA9IHRoaXMuc2Vzc2lvbi5yZXNvdXJjZUxvYWRlci5nZXRUaGVtZXMoKTtcblxuXHRcdGlmIChzaG93TGlzdGluZykge1xuXHRcdFx0Y29uc3QgY29udGV4dEZpbGVzID0gdGhpcy5zZXNzaW9uLnJlc291cmNlTG9hZGVyLmdldEFnZW50c0ZpbGVzKCkuYWdlbnRzRmlsZXM7XG5cdFx0XHRpZiAoY29udGV4dEZpbGVzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0XHRjb25zdCBjb250ZXh0TGlzdCA9IGNvbnRleHRGaWxlc1xuXHRcdFx0XHRcdC5tYXAoKGYpID0+IHRoZW1lLmZnKFwiZGltXCIsIGAgICR7dGhpcy5mb3JtYXREaXNwbGF5UGF0aChmLnBhdGgpfWApKVxuXHRcdFx0XHRcdC5qb2luKFwiXFxuXCIpO1xuXHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQoYCR7c2VjdGlvbkhlYWRlcihcIkNvbnRleHRcIil9XFxuJHtjb250ZXh0TGlzdH1gLCAwLCAwKSk7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3Qgc2tpbGxzID0gc2tpbGxzUmVzdWx0LnNraWxscztcblx0XHRcdGlmIChza2lsbHMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb25zdCBza2lsbFBhdGhzID0gc2tpbGxzLm1hcCgocykgPT4gcy5maWxlUGF0aCk7XG5cdFx0XHRcdGNvbnN0IGdyb3VwcyA9IHRoaXMuYnVpbGRTY29wZUdyb3Vwcyhza2lsbFBhdGhzLCBtZXRhZGF0YSk7XG5cdFx0XHRcdGNvbnN0IHNraWxsTGlzdCA9IHRoaXMuZm9ybWF0U2NvcGVHcm91cHMoZ3JvdXBzLCB7XG5cdFx0XHRcdFx0Zm9ybWF0UGF0aDogKHApID0+IHRoaXMuZm9ybWF0RGlzcGxheVBhdGgocCksXG5cdFx0XHRcdFx0Zm9ybWF0UGFja2FnZVBhdGg6IChwLCBzb3VyY2UpID0+IHRoaXMuZ2V0U2hvcnRQYXRoKHAsIHNvdXJjZSksXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQoYCR7c2VjdGlvbkhlYWRlcihcIlNraWxsc1wiKX1cXG4ke3NraWxsTGlzdH1gLCAwLCAwKSk7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgdGVtcGxhdGVzID0gdGhpcy5zZXNzaW9uLnByb21wdFRlbXBsYXRlcztcblx0XHRcdGlmICh0ZW1wbGF0ZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb25zdCB0ZW1wbGF0ZVBhdGhzID0gdGVtcGxhdGVzLm1hcCgodCkgPT4gdC5maWxlUGF0aCk7XG5cdFx0XHRcdGNvbnN0IGdyb3VwcyA9IHRoaXMuYnVpbGRTY29wZUdyb3Vwcyh0ZW1wbGF0ZVBhdGhzLCBtZXRhZGF0YSk7XG5cdFx0XHRcdGNvbnN0IHRlbXBsYXRlQnlQYXRoID0gbmV3IE1hcCh0ZW1wbGF0ZXMubWFwKCh0KSA9PiBbdC5maWxlUGF0aCwgdF0pKTtcblx0XHRcdFx0Y29uc3QgdGVtcGxhdGVMaXN0ID0gdGhpcy5mb3JtYXRTY29wZUdyb3Vwcyhncm91cHMsIHtcblx0XHRcdFx0XHRmb3JtYXRQYXRoOiAocCkgPT4ge1xuXHRcdFx0XHRcdFx0Y29uc3QgdGVtcGxhdGUgPSB0ZW1wbGF0ZUJ5UGF0aC5nZXQocCk7XG5cdFx0XHRcdFx0XHRyZXR1cm4gdGVtcGxhdGUgPyBgLyR7dGVtcGxhdGUubmFtZX1gIDogdGhpcy5mb3JtYXREaXNwbGF5UGF0aChwKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdGZvcm1hdFBhY2thZ2VQYXRoOiAocCkgPT4ge1xuXHRcdFx0XHRcdFx0Y29uc3QgdGVtcGxhdGUgPSB0ZW1wbGF0ZUJ5UGF0aC5nZXQocCk7XG5cdFx0XHRcdFx0XHRyZXR1cm4gdGVtcGxhdGUgPyBgLyR7dGVtcGxhdGUubmFtZX1gIDogdGhpcy5mb3JtYXREaXNwbGF5UGF0aChwKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KGAke3NlY3Rpb25IZWFkZXIoXCJQcm9tcHRzXCIpfVxcbiR7dGVtcGxhdGVMaXN0fWAsIDAsIDApKTtcblx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBleHRlbnNpb25QYXRocyA9IG9wdGlvbnM/LmV4dGVuc2lvblBhdGhzID8/IFtdO1xuXHRcdFx0aWYgKGV4dGVuc2lvblBhdGhzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0Y29uc3QgZ3JvdXBzID0gdGhpcy5idWlsZFNjb3BlR3JvdXBzKGV4dGVuc2lvblBhdGhzLCBtZXRhZGF0YSk7XG5cdFx0XHRcdGNvbnN0IGV4dExpc3QgPSB0aGlzLmZvcm1hdFNjb3BlR3JvdXBzKGdyb3Vwcywge1xuXHRcdFx0XHRcdGZvcm1hdFBhdGg6IChwKSA9PiB0aGlzLmZvcm1hdERpc3BsYXlQYXRoKHApLFxuXHRcdFx0XHRcdGZvcm1hdFBhY2thZ2VQYXRoOiAocCwgc291cmNlKSA9PiB0aGlzLmdldFNob3J0UGF0aChwLCBzb3VyY2UpLFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KGAke3NlY3Rpb25IZWFkZXIoXCJFeHRlbnNpb25zXCIsIFwibWRIZWFkaW5nXCIpfVxcbiR7ZXh0TGlzdH1gLCAwLCAwKSk7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gU2hvdyBsb2FkZWQgdGhlbWVzIChleGNsdWRpbmcgYnVpbHQtaW4pXG5cdFx0XHRjb25zdCBsb2FkZWRUaGVtZXMgPSB0aGVtZXNSZXN1bHQudGhlbWVzO1xuXHRcdFx0Y29uc3QgY3VzdG9tVGhlbWVzID0gbG9hZGVkVGhlbWVzLmZpbHRlcigodCkgPT4gdC5zb3VyY2VQYXRoKTtcblx0XHRcdGlmIChjdXN0b21UaGVtZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb25zdCB0aGVtZVBhdGhzID0gY3VzdG9tVGhlbWVzLm1hcCgodCkgPT4gdC5zb3VyY2VQYXRoISk7XG5cdFx0XHRcdGNvbnN0IGdyb3VwcyA9IHRoaXMuYnVpbGRTY29wZUdyb3Vwcyh0aGVtZVBhdGhzLCBtZXRhZGF0YSk7XG5cdFx0XHRcdGNvbnN0IHRoZW1lTGlzdCA9IHRoaXMuZm9ybWF0U2NvcGVHcm91cHMoZ3JvdXBzLCB7XG5cdFx0XHRcdFx0Zm9ybWF0UGF0aDogKHApID0+IHRoaXMuZm9ybWF0RGlzcGxheVBhdGgocCksXG5cdFx0XHRcdFx0Zm9ybWF0UGFja2FnZVBhdGg6IChwLCBzb3VyY2UpID0+IHRoaXMuZ2V0U2hvcnRQYXRoKHAsIHNvdXJjZSksXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQoYCR7c2VjdGlvbkhlYWRlcihcIlRoZW1lc1wiKX1cXG4ke3RoZW1lTGlzdH1gLCAwLCAwKSk7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRpZiAoc2hvd0RpYWdub3N0aWNzKSB7XG5cdFx0XHRjb25zdCBza2lsbERpYWdub3N0aWNzID0gc2tpbGxzUmVzdWx0LmRpYWdub3N0aWNzO1xuXHRcdFx0aWYgKHNraWxsRGlhZ25vc3RpY3MubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb25zdCBjb2xsaXNpb25EaWFncyA9IHNraWxsRGlhZ25vc3RpY3MuZmlsdGVyKGQgPT4gZC50eXBlID09PSBcImNvbGxpc2lvblwiKTtcblx0XHRcdFx0Y29uc3QgaXNzdWVEaWFncyA9IHNraWxsRGlhZ25vc3RpY3MuZmlsdGVyKGQgPT4gZC50eXBlICE9PSBcImNvbGxpc2lvblwiKTtcblxuXHRcdFx0XHRpZiAoY29sbGlzaW9uRGlhZ3MubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdGNvbnN0IGNvbGxpc2lvbkxpbmVzID0gdGhpcy5mb3JtYXREaWFnbm9zdGljcyhjb2xsaXNpb25EaWFncywgbWV0YWRhdGEpO1xuXHRcdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dChgJHt0aGVtZS5mZyhcIndhcm5pbmdcIiwgXCJbU2tpbGwgY29uZmxpY3RzXVwiKX1cXG4ke2NvbGxpc2lvbkxpbmVzfWAsIDAsIDApKTtcblx0XHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoaXNzdWVEaWFncy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0Y29uc3QgaXNzdWVMaW5lcyA9IHRoaXMuZm9ybWF0RGlhZ25vc3RpY3MoaXNzdWVEaWFncywgbWV0YWRhdGEpO1xuXHRcdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dChgJHt0aGVtZS5mZyhcIndhcm5pbmdcIiwgXCJbU2tpbGwgaXNzdWVzXVwiKX1cXG4ke2lzc3VlTGluZXN9YCwgMCwgMCkpO1xuXHRcdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBwcm9tcHREaWFnbm9zdGljcyA9IHByb21wdHNSZXN1bHQuZGlhZ25vc3RpY3M7XG5cdFx0XHRpZiAocHJvbXB0RGlhZ25vc3RpY3MubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb25zdCB3YXJuaW5nTGluZXMgPSB0aGlzLmZvcm1hdERpYWdub3N0aWNzKHByb21wdERpYWdub3N0aWNzLCBtZXRhZGF0YSk7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdFx0XHRuZXcgVGV4dChgJHt0aGVtZS5mZyhcIndhcm5pbmdcIiwgXCJbUHJvbXB0IGNvbmZsaWN0c11cIil9XFxuJHt3YXJuaW5nTGluZXN9YCwgMCwgMCksXG5cdFx0XHRcdCk7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZXh0ZW5zaW9uRGlhZ25vc3RpY3M6IFJlc291cmNlRGlhZ25vc3RpY1tdID0gW107XG5cdFx0XHRjb25zdCBleHRlbnNpb25FcnJvcnMgPSB0aGlzLnNlc3Npb24ucmVzb3VyY2VMb2FkZXIuZ2V0RXh0ZW5zaW9ucygpLmVycm9ycztcblx0XHRcdGlmIChleHRlbnNpb25FcnJvcnMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRmb3IgKGNvbnN0IGVycm9yIG9mIGV4dGVuc2lvbkVycm9ycykge1xuXHRcdFx0XHRcdGV4dGVuc2lvbkRpYWdub3N0aWNzLnB1c2goeyB0eXBlOiBcImVycm9yXCIsIG1lc3NhZ2U6IGVycm9yLmVycm9yLCBwYXRoOiBlcnJvci5wYXRoIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGNvbW1hbmREaWFnbm9zdGljcyA9IHRoaXMuc2Vzc2lvbi5leHRlbnNpb25SdW5uZXI/LmdldENvbW1hbmREaWFnbm9zdGljcygpID8/IFtdO1xuXHRcdFx0ZXh0ZW5zaW9uRGlhZ25vc3RpY3MucHVzaCguLi5jb21tYW5kRGlhZ25vc3RpY3MpO1xuXG5cdFx0XHRjb25zdCBzaG9ydGN1dERpYWdub3N0aWNzID0gdGhpcy5zZXNzaW9uLmV4dGVuc2lvblJ1bm5lcj8uZ2V0U2hvcnRjdXREaWFnbm9zdGljcygpID8/IFtdO1xuXHRcdFx0ZXh0ZW5zaW9uRGlhZ25vc3RpY3MucHVzaCguLi5zaG9ydGN1dERpYWdub3N0aWNzKTtcblxuXHRcdFx0aWYgKGV4dGVuc2lvbkRpYWdub3N0aWNzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0Y29uc3Qgd2FybmluZ0xpbmVzID0gdGhpcy5mb3JtYXREaWFnbm9zdGljcyhleHRlbnNpb25EaWFnbm9zdGljcywgbWV0YWRhdGEpO1xuXHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQoXG5cdFx0XHRcdFx0bmV3IFRleHQoYCR7dGhlbWUuZmcoXCJ3YXJuaW5nXCIsIFwiW0V4dGVuc2lvbiBpc3N1ZXNdXCIpfVxcbiR7d2FybmluZ0xpbmVzfWAsIDAsIDApLFxuXHRcdFx0XHQpO1xuXHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHRoZW1lRGlhZ25vc3RpY3MgPSB0aGVtZXNSZXN1bHQuZGlhZ25vc3RpY3M7XG5cdFx0XHRpZiAodGhlbWVEaWFnbm9zdGljcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGNvbnN0IHdhcm5pbmdMaW5lcyA9IHRoaXMuZm9ybWF0RGlhZ25vc3RpY3ModGhlbWVEaWFnbm9zdGljcywgbWV0YWRhdGEpO1xuXHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQoYCR7dGhlbWUuZmcoXCJ3YXJuaW5nXCIsIFwiW1RoZW1lIGNvbmZsaWN0c11cIil9XFxuJHt3YXJuaW5nTGluZXN9YCwgMCwgMCkpO1xuXHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIEluaXRpYWxpemUgdGhlIGV4dGVuc2lvbiBzeXN0ZW0gd2l0aCBUVUktYmFzZWQgVUkgY29udGV4dC5cblx0ICovXG5cdHByaXZhdGUgYXN5bmMgaW5pdEV4dGVuc2lvbnMoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMub3B0aW9ucy5iaW5kRXh0ZW5zaW9ucyAhPT0gZmFsc2UpIHtcblx0XHRcdGNvbnN0IHVpQ29udGV4dCA9IHRoaXMuY3JlYXRlRXh0ZW5zaW9uVUlDb250ZXh0KCk7XG5cdFx0XHRhd2FpdCB0aGlzLnNlc3Npb24uYmluZEV4dGVuc2lvbnMoe1xuXHRcdFx0XHR1aUNvbnRleHQsXG5cdFx0XHRcdGNvbW1hbmRDb250ZXh0QWN0aW9uczoge1xuXHRcdFx0XHRcdHdhaXRGb3JJZGxlOiAoKSA9PiB0aGlzLnNlc3Npb24uYWdlbnQud2FpdEZvcklkbGUoKSxcblx0XHRcdFx0XHRuZXdTZXNzaW9uOiBhc3luYyAob3B0aW9ucykgPT4ge1xuXHRcdFx0XHRcdFx0aWYgKHRoaXMubG9hZGluZ0FuaW1hdGlvbikge1xuXHRcdFx0XHRcdFx0XHR0aGlzLmxvYWRpbmdBbmltYXRpb24uc3RvcCgpO1xuXHRcdFx0XHRcdFx0XHR0aGlzLmxvYWRpbmdBbmltYXRpb24gPSB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR0aGlzLnN0YXR1c0NvbnRhaW5lci5jbGVhcigpO1xuXG5cdFx0XHRcdFx0XHQvLyBEZWxlZ2F0ZSB0byBBZ2VudFNlc3Npb24gKGhhbmRsZXMgc2V0dXAgKyBhZ2VudCBzdGF0ZSBzeW5jKVxuXHRcdFx0XHRcdFx0Y29uc3Qgc3VjY2VzcyA9IGF3YWl0IHRoaXMuc2Vzc2lvbi5uZXdTZXNzaW9uKG9wdGlvbnMpO1xuXHRcdFx0XHRcdFx0aWYgKCFzdWNjZXNzKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7IGNhbmNlbGxlZDogdHJ1ZSB9O1xuXHRcdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0XHQvLyBDbGVhciBVSSBzdGF0ZVxuXHRcdFx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHRcdFx0XHR0aGlzLnBlbmRpbmdNZXNzYWdlc0NvbnRhaW5lci5jbGVhcigpO1xuXHRcdFx0XHRcdFx0dGhpcy5jb21wYWN0aW9uUXVldWVkTWVzc2FnZXMgPSBbXTtcblx0XHRcdFx0XHRcdHRoaXMuc3RyZWFtaW5nQ29tcG9uZW50ID0gdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0dGhpcy5zdHJlYW1pbmdNZXNzYWdlID0gdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0dGhpcy5wZW5kaW5nVG9vbHMuY2xlYXIoKTtcblx0XHRcdFx0XHRcdHRoaXMuY2xlYXJCbG9ja2luZ0Vycm9yKCk7XG5cblx0XHRcdFx0XHRcdC8vIFJlbmRlciBhbnkgbWVzc2FnZXMgYWRkZWQgdmlhIHNldHVwLCBvciBzaG93IGVtcHR5IHNlc3Npb25cblx0XHRcdFx0XHRcdHRoaXMucmVuZGVySW5pdGlhbE1lc3NhZ2VzKCk7XG5cdFx0XHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblxuXHRcdFx0XHRcdFx0cmV0dXJuIHsgY2FuY2VsbGVkOiBmYWxzZSB9O1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0Zm9yazogYXN5bmMgKGVudHJ5SWQpID0+IHtcblx0XHRcdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuc2Vzc2lvbi5mb3JrKGVudHJ5SWQpO1xuXHRcdFx0XHRcdFx0aWYgKHJlc3VsdC5jYW5jZWxsZWQpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIHsgY2FuY2VsbGVkOiB0cnVlIH07XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5jbGVhcigpO1xuXHRcdFx0XHRcdFx0dGhpcy5yZW5kZXJJbml0aWFsTWVzc2FnZXMoKTtcblx0XHRcdFx0XHRcdHRoaXMuZWRpdG9yLnNldFRleHQocmVzdWx0LnNlbGVjdGVkVGV4dCk7XG5cdFx0XHRcdFx0XHR0aGlzLnNob3dTdGF0dXMoXCJGb3JrZWQgdG8gbmV3IHNlc3Npb25cIik7XG5cblx0XHRcdFx0XHRcdHJldHVybiB7IGNhbmNlbGxlZDogZmFsc2UgfTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG5hdmlnYXRlVHJlZTogYXN5bmMgKHRhcmdldElkLCBvcHRpb25zKSA9PiB7XG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnNlc3Npb24ubmF2aWdhdGVUcmVlKHRhcmdldElkLCB7XG5cdFx0XHRcdFx0XHRcdHN1bW1hcml6ZTogb3B0aW9ucz8uc3VtbWFyaXplLFxuXHRcdFx0XHRcdFx0XHRjdXN0b21JbnN0cnVjdGlvbnM6IG9wdGlvbnM/LmN1c3RvbUluc3RydWN0aW9ucyxcblx0XHRcdFx0XHRcdFx0cmVwbGFjZUluc3RydWN0aW9uczogb3B0aW9ucz8ucmVwbGFjZUluc3RydWN0aW9ucyxcblx0XHRcdFx0XHRcdFx0bGFiZWw6IG9wdGlvbnM/LmxhYmVsLFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHRpZiAocmVzdWx0LmNhbmNlbGxlZCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4geyBjYW5jZWxsZWQ6IHRydWUgfTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHRcdFx0XHR0aGlzLnJlbmRlckluaXRpYWxNZXNzYWdlcygpO1xuXHRcdFx0XHRcdFx0aWYgKHJlc3VsdC5lZGl0b3JUZXh0ICYmICF0aGlzLmVkaXRvci5nZXRUZXh0KCkudHJpbSgpKSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMuZWRpdG9yLnNldFRleHQocmVzdWx0LmVkaXRvclRleHQpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0dGhpcy5zaG93U3RhdHVzKFwiTmF2aWdhdGVkIHRvIHNlbGVjdGVkIHBvaW50XCIpO1xuXG5cdFx0XHRcdFx0XHRyZXR1cm4geyBjYW5jZWxsZWQ6IGZhbHNlIH07XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRzd2l0Y2hTZXNzaW9uOiBhc3luYyAoc2Vzc2lvblBhdGgpID0+IHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMuaGFuZGxlUmVzdW1lU2Vzc2lvbihzZXNzaW9uUGF0aCk7XG5cdFx0XHRcdFx0XHRyZXR1cm4geyBjYW5jZWxsZWQ6IGZhbHNlIH07XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRyZWxvYWQ6IGFzeW5jICgpID0+IHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMuaGFuZGxlUmVsb2FkQ29tbWFuZCgpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHNodXRkb3duSGFuZGxlcjogKCkgPT4ge1xuXHRcdFx0XHRcdHRoaXMuc2h1dGRvd25SZXF1ZXN0ZWQgPSB0cnVlO1xuXHRcdFx0XHRcdGlmICghdGhpcy5zZXNzaW9uLmlzU3RyZWFtaW5nKSB7XG5cdFx0XHRcdFx0XHR2b2lkIHRoaXMuc2h1dGRvd24oKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0sXG5cdFx0XHRcdG9uRXJyb3I6IChlcnJvcikgPT4ge1xuXHRcdFx0XHRcdHRoaXMuc2hvd0V4dGVuc2lvbkVycm9yKGVycm9yLmV4dGVuc2lvblBhdGgsIGVycm9yLmVycm9yLCBlcnJvci5zdGFjayk7XG5cdFx0XHRcdH0sXG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHRzZXRSZWdpc3RlcmVkVGhlbWVzKHRoaXMuc2Vzc2lvbi5yZXNvdXJjZUxvYWRlci5nZXRUaGVtZXMoKS50aGVtZXMpO1xuXHRcdHRoaXMuc2V0dXBBdXRvY29tcGxldGUoKTtcblxuXHRcdGNvbnN0IGV4dGVuc2lvblJ1bm5lciA9IHRoaXMuc2Vzc2lvbi5leHRlbnNpb25SdW5uZXI7XG5cdFx0aWYgKCFleHRlbnNpb25SdW5uZXIpIHtcblx0XHRcdHRoaXMuc2hvd0xvYWRlZFJlc291cmNlcyh7IGV4dGVuc2lvblBhdGhzOiBbXSwgZm9yY2U6IGZhbHNlIH0pO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRoaXMuc2V0dXBFeHRlbnNpb25TaG9ydGN1dHMoZXh0ZW5zaW9uUnVubmVyKTtcblx0XHR0aGlzLnNob3dMb2FkZWRSZXNvdXJjZXMoeyBleHRlbnNpb25QYXRoczogZXh0ZW5zaW9uUnVubmVyLmdldEV4dGVuc2lvblBhdGhzKCksIGZvcmNlOiBmYWxzZSB9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgYSB0b29sIGRlZmluaXRpb24gYnkgbmFtZSAoZm9yIGN1c3RvbSByZW5kZXJpbmcpLlxuXHQgKi9cblx0cHJpdmF0ZSBnZXRSZWdpc3RlcmVkVG9vbERlZmluaXRpb24odG9vbE5hbWU6IHN0cmluZykge1xuXHRcdHJldHVybiB0aGlzLnNlc3Npb24uZ2V0UmVuZGVyYWJsZVRvb2xEZWZpbml0aW9uKHRvb2xOYW1lKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBGb3JtYXQgd2ViIHNlYXJjaCByZXN1bHQgY29udGVudCBmb3IgZGlzcGxheSBpbiB0aGUgVFVJLlxuXHQgKi9cblx0cHJpdmF0ZSBmb3JtYXRXZWJTZWFyY2hSZXN1bHQoY29udGVudDogdW5rbm93bik6IHN0cmluZyB7XG5cdFx0aWYgKCFjb250ZW50KSByZXR1cm4gXCJXZWIgc2VhcmNoIGNvbXBsZXRlZFwiO1xuXG5cdFx0Ly8gRXJyb3IgcmVzdWx0XG5cdFx0aWYgKHR5cGVvZiBjb250ZW50ID09PSBcIm9iamVjdFwiICYmIFwidHlwZVwiIGluIChjb250ZW50IGFzIGFueSkgJiYgKGNvbnRlbnQgYXMgYW55KS50eXBlID09PSBcIndlYl9zZWFyY2hfdG9vbF9yZXN1bHRfZXJyb3JcIikge1xuXHRcdFx0Y29uc3QgZXJyb3IgPSBjb250ZW50IGFzIGFueTtcblx0XHRcdHJldHVybiBgU2VhcmNoIGVycm9yOiAke2Vycm9yLmVycm9yX2NvZGUgfHwgXCJ1bmtub3duXCJ9YDtcblx0XHR9XG5cblx0XHQvLyBBcnJheSBvZiBzZWFyY2ggcmVzdWx0c1xuXHRcdGlmIChBcnJheS5pc0FycmF5KGNvbnRlbnQpKSB7XG5cdFx0XHRjb25zdCByZXN1bHRzID0gY29udGVudC5maWx0ZXIoKHI6IGFueSkgPT4gci50eXBlID09PSBcIndlYl9zZWFyY2hfcmVzdWx0XCIpO1xuXHRcdFx0aWYgKHJlc3VsdHMubGVuZ3RoID09PSAwKSByZXR1cm4gXCJObyByZXN1bHRzIGZvdW5kXCI7XG5cdFx0XHRyZXR1cm4gcmVzdWx0c1xuXHRcdFx0XHQubWFwKChyOiBhbnkpID0+IHtcblx0XHRcdFx0XHRjb25zdCB0aXRsZSA9IHIudGl0bGUgfHwgXCJVbnRpdGxlZFwiO1xuXHRcdFx0XHRcdGNvbnN0IHVybCA9IHIudXJsIHx8IFwiXCI7XG5cdFx0XHRcdFx0cmV0dXJuIGAke3RpdGxlfVxcbiAgJHt1cmx9YDtcblx0XHRcdFx0fSlcblx0XHRcdFx0LmpvaW4oXCJcXG5cIik7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIFwiV2ViIHNlYXJjaCBjb21wbGV0ZWRcIjtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgdXAga2V5Ym9hcmQgc2hvcnRjdXRzIHJlZ2lzdGVyZWQgYnkgZXh0ZW5zaW9ucy5cblx0ICovXG5cdHByaXZhdGUgc2V0dXBFeHRlbnNpb25TaG9ydGN1dHMoZXh0ZW5zaW9uUnVubmVyOiBFeHRlbnNpb25SdW5uZXIpOiB2b2lkIHtcblx0XHRjb25zdCBzaG9ydGN1dHMgPSBleHRlbnNpb25SdW5uZXIuZ2V0U2hvcnRjdXRzKHRoaXMua2V5YmluZGluZ3MuZ2V0RWZmZWN0aXZlQ29uZmlnKCkpO1xuXHRcdGlmIChzaG9ydGN1dHMuc2l6ZSA9PT0gMCkgcmV0dXJuO1xuXG5cdFx0Ly8gQ3JlYXRlIGEgY29udGV4dCBmb3Igc2hvcnRjdXQgaGFuZGxlcnNcblx0XHRjb25zdCBjcmVhdGVDb250ZXh0ID0gKCk6IEV4dGVuc2lvbkNvbnRleHQgPT4gKHtcblx0XHRcdHVpOiB0aGlzLmNyZWF0ZUV4dGVuc2lvblVJQ29udGV4dCgpLFxuXHRcdFx0aGFzVUk6IHRydWUsXG5cdFx0XHRjd2Q6IHByb2Nlc3MuY3dkKCksXG5cdFx0XHRzZXNzaW9uTWFuYWdlcjogdGhpcy5zZXNzaW9uTWFuYWdlcixcblx0XHRcdG1vZGVsUmVnaXN0cnk6IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LFxuXHRcdFx0bW9kZWw6IHRoaXMuc2Vzc2lvbi5tb2RlbCxcblx0XHRcdGlzSWRsZTogKCkgPT4gIXRoaXMuc2Vzc2lvbi5pc1N0cmVhbWluZyxcblx0XHRcdFx0YWJvcnQ6ICgpID0+IHRoaXMuc2Vzc2lvbi5hYm9ydCh7IG9yaWdpbjogXCJ1c2VyXCIgfSksXG5cdFx0XHRoYXNQZW5kaW5nTWVzc2FnZXM6ICgpID0+IHRoaXMuc2Vzc2lvbi5wZW5kaW5nTWVzc2FnZUNvdW50ID4gMCxcblx0XHRcdHNodXRkb3duOiAoKSA9PiB7XG5cdFx0XHRcdHRoaXMuc2h1dGRvd25SZXF1ZXN0ZWQgPSB0cnVlO1xuXHRcdFx0fSxcblx0XHRcdGdldENvbnRleHRVc2FnZTogKCkgPT4gdGhpcy5zZXNzaW9uLmdldENvbnRleHRVc2FnZSgpLFxuXHRcdFx0Y29tcGFjdDogKG9wdGlvbnMpID0+IHtcblx0XHRcdFx0dm9pZCAoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVDb21wYWN0aW9uKG9wdGlvbnM/LmN1c3RvbUluc3RydWN0aW9ucywgZmFsc2UpO1xuXHRcdFx0XHRcdFx0aWYgKHJlc3VsdCkge1xuXHRcdFx0XHRcdFx0XHRvcHRpb25zPy5vbkNvbXBsZXRlPy4ocmVzdWx0KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRcdFx0Y29uc3QgZXJyID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFN0cmluZyhlcnJvcikpO1xuXHRcdFx0XHRcdFx0b3B0aW9ucz8ub25FcnJvcj8uKGVycik7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9KSgpO1xuXHRcdFx0fSxcblx0XHRcdGdldFN5c3RlbVByb21wdDogKCkgPT4gdGhpcy5zZXNzaW9uLnN5c3RlbVByb21wdCxcblx0XHRcdHNldENvbXBhY3Rpb25UaHJlc2hvbGRPdmVycmlkZTogKHBlcmNlbnQpID0+IHtcblx0XHRcdFx0dGhpcy5zZXNzaW9uLnNldHRpbmdzTWFuYWdlci5zZXRDb21wYWN0aW9uVGhyZXNob2xkT3ZlcnJpZGUocGVyY2VudCk7XG5cdFx0XHR9LFxuXHRcdH0pO1xuXG5cdFx0Ly8gU2V0IHVwIHRoZSBleHRlbnNpb24gc2hvcnRjdXQgaGFuZGxlciBvbiB0aGUgZGVmYXVsdCBlZGl0b3Jcblx0XHR0aGlzLmRlZmF1bHRFZGl0b3Iub25FeHRlbnNpb25TaG9ydGN1dCA9IChkYXRhOiBzdHJpbmcpID0+IHtcblx0XHRcdGZvciAoY29uc3QgW3Nob3J0Y3V0U3RyLCBzaG9ydGN1dF0gb2Ygc2hvcnRjdXRzKSB7XG5cdFx0XHRcdC8vIENhc3QgdG8gS2V5SWQgLSBleHRlbnNpb24gc2hvcnRjdXRzIHVzZSB0aGUgc2FtZSBmb3JtYXRcblx0XHRcdFx0aWYgKG1hdGNoZXNLZXkoZGF0YSwgc2hvcnRjdXRTdHIgYXMgS2V5SWQpKSB7XG5cdFx0XHRcdFx0Ly8gUnVuIGhhbmRsZXIgYXN5bmMsIGRvbid0IGJsb2NrIGlucHV0XG5cdFx0XHRcdFx0UHJvbWlzZS5yZXNvbHZlKHNob3J0Y3V0LmhhbmRsZXIoY3JlYXRlQ29udGV4dCgpKSkuY2F0Y2goKGVycikgPT4ge1xuXHRcdFx0XHRcdFx0dGhpcy5zaG93RXJyb3IoYFNob3J0Y3V0IGhhbmRsZXIgZXJyb3I6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgZXh0ZW5zaW9uIHN0YXR1cyB0ZXh0IGluIHRoZSBmb290ZXIuXG5cdCAqL1xuXHRwcml2YXRlIHNldEV4dGVuc2lvblN0YXR1cyhrZXk6IHN0cmluZywgdGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkKTogdm9pZCB7XG5cdFx0dGhpcy5mb290ZXJEYXRhUHJvdmlkZXIuc2V0RXh0ZW5zaW9uU3RhdHVzKGtleSwgdGV4dCk7XG5cdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGFuIGV4dGVuc2lvbiB3aWRnZXQgKHN0cmluZyBhcnJheSBvciBjdXN0b20gY29tcG9uZW50KS5cblx0ICovXG5cdHByaXZhdGUgc2V0RXh0ZW5zaW9uV2lkZ2V0KFxuXHRcdGtleTogc3RyaW5nLFxuXHRcdGNvbnRlbnQ6IHN0cmluZ1tdIHwgKCh0dWk6IFRVSSwgdGhtOiBUaGVtZSkgPT4gQ29tcG9uZW50ICYgeyBkaXNwb3NlPygpOiB2b2lkIH0pIHwgdW5kZWZpbmVkLFxuXHRcdG9wdGlvbnM/OiBFeHRlbnNpb25XaWRnZXRPcHRpb25zLFxuXHQpOiB2b2lkIHtcblx0XHRjb25zdCBwbGFjZW1lbnQgPSBvcHRpb25zPy5wbGFjZW1lbnQgPz8gXCJhYm92ZUVkaXRvclwiO1xuXHRcdGNvbnN0IHJlbW92ZUV4aXN0aW5nID0gKG1hcDogTWFwPHN0cmluZywgQ29tcG9uZW50ICYgeyBkaXNwb3NlPygpOiB2b2lkIH0+KSA9PiB7XG5cdFx0XHRjb25zdCBleGlzdGluZyA9IG1hcC5nZXQoa2V5KTtcblx0XHRcdGlmIChleGlzdGluZz8uZGlzcG9zZSkgZXhpc3RpbmcuZGlzcG9zZSgpO1xuXHRcdFx0bWFwLmRlbGV0ZShrZXkpO1xuXHRcdH07XG5cblx0XHRyZW1vdmVFeGlzdGluZyh0aGlzLmV4dGVuc2lvbldpZGdldHNBYm92ZSk7XG5cdFx0cmVtb3ZlRXhpc3RpbmcodGhpcy5leHRlbnNpb25XaWRnZXRzQmVsb3cpO1xuXG5cdFx0aWYgKGNvbnRlbnQgPT09IHVuZGVmaW5lZCkge1xuXHRcdFx0dGhpcy5yZW5kZXJXaWRnZXRzKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0bGV0IGNvbXBvbmVudDogQ29tcG9uZW50ICYgeyBkaXNwb3NlPygpOiB2b2lkIH07XG5cblx0XHRpZiAoQXJyYXkuaXNBcnJheShjb250ZW50KSkge1xuXHRcdFx0Ly8gV3JhcCBzdHJpbmcgYXJyYXkgaW4gYSBDb250YWluZXIgd2l0aCBUZXh0IGNvbXBvbmVudHNcblx0XHRcdGNvbnN0IGNvbnRhaW5lciA9IG5ldyBDb250YWluZXIoKTtcblx0XHRcdGZvciAoY29uc3QgbGluZSBvZiBjb250ZW50LnNsaWNlKDAsIEludGVyYWN0aXZlTW9kZS5NQVhfV0lER0VUX0xJTkVTKSkge1xuXHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQobGluZSwgMSwgMCkpO1xuXHRcdFx0fVxuXHRcdFx0aWYgKGNvbnRlbnQubGVuZ3RoID4gSW50ZXJhY3RpdmVNb2RlLk1BWF9XSURHRVRfTElORVMpIHtcblx0XHRcdFx0Y29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KHRoZW1lLmZnKFwibXV0ZWRcIiwgXCIuLi4gKHdpZGdldCB0cnVuY2F0ZWQpXCIpLCAxLCAwKSk7XG5cdFx0XHR9XG5cdFx0XHRjb21wb25lbnQgPSBjb250YWluZXI7XG5cdFx0fSBlbHNlIHtcblx0XHRcdC8vIEZhY3RvcnkgZnVuY3Rpb24gLSBjcmVhdGUgY29tcG9uZW50XG5cdFx0XHRjb21wb25lbnQgPSBjb250ZW50KHRoaXMudWksIHRoZW1lKTtcblx0XHR9XG5cblx0XHRjb25zdCB0YXJnZXRNYXAgPSBwbGFjZW1lbnQgPT09IFwiYmVsb3dFZGl0b3JcIiA/IHRoaXMuZXh0ZW5zaW9uV2lkZ2V0c0JlbG93IDogdGhpcy5leHRlbnNpb25XaWRnZXRzQWJvdmU7XG5cdFx0dGFyZ2V0TWFwLnNldChrZXksIGNvbXBvbmVudCk7XG5cdFx0dGhpcy5yZW5kZXJXaWRnZXRzKCk7XG5cdH1cblxuXHRwcml2YXRlIGNsZWFyRXh0ZW5zaW9uV2lkZ2V0cygpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IHdpZGdldCBvZiB0aGlzLmV4dGVuc2lvbldpZGdldHNBYm92ZS52YWx1ZXMoKSkge1xuXHRcdFx0d2lkZ2V0LmRpc3Bvc2U/LigpO1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IHdpZGdldCBvZiB0aGlzLmV4dGVuc2lvbldpZGdldHNCZWxvdy52YWx1ZXMoKSkge1xuXHRcdFx0d2lkZ2V0LmRpc3Bvc2U/LigpO1xuXHRcdH1cblx0XHR0aGlzLmV4dGVuc2lvbldpZGdldHNBYm92ZS5jbGVhcigpO1xuXHRcdHRoaXMuZXh0ZW5zaW9uV2lkZ2V0c0JlbG93LmNsZWFyKCk7XG5cdFx0dGhpcy5yZW5kZXJXaWRnZXRzKCk7XG5cdH1cblxuXHRwcml2YXRlIHJlc2V0RXh0ZW5zaW9uVUkoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuZXh0ZW5zaW9uU2VsZWN0b3IpIHtcblx0XHRcdHRoaXMuaGlkZUV4dGVuc2lvblNlbGVjdG9yKCk7XG5cdFx0fVxuXHRcdGlmICh0aGlzLmV4dGVuc2lvbklucHV0KSB7XG5cdFx0XHR0aGlzLmhpZGVFeHRlbnNpb25JbnB1dCgpO1xuXHRcdH1cblx0XHRpZiAodGhpcy5leHRlbnNpb25FZGl0b3IpIHtcblx0XHRcdHRoaXMuaGlkZUV4dGVuc2lvbkVkaXRvcigpO1xuXHRcdH1cblx0XHR0aGlzLnVpLmhpZGVPdmVybGF5KCk7XG5cdFx0dGhpcy5jbGVhckV4dGVuc2lvblRlcm1pbmFsSW5wdXRMaXN0ZW5lcnMoKTtcblx0XHR0aGlzLnNldEV4dGVuc2lvbkZvb3Rlcih1bmRlZmluZWQpO1xuXHRcdHRoaXMuc2V0RXh0ZW5zaW9uSGVhZGVyKHVuZGVmaW5lZCk7XG5cdFx0dGhpcy5jbGVhckV4dGVuc2lvbldpZGdldHMoKTtcblx0XHR0aGlzLmZvb3RlckRhdGFQcm92aWRlci5jbGVhckV4dGVuc2lvblN0YXR1c2VzKCk7XG5cdFx0dGhpcy5mb290ZXIuaW52YWxpZGF0ZSgpO1xuXHRcdHRoaXMuc2V0Q3VzdG9tRWRpdG9yQ29tcG9uZW50KHVuZGVmaW5lZCk7XG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uRXh0ZW5zaW9uU2hvcnRjdXQgPSB1bmRlZmluZWQ7XG5cdFx0dGhpcy51cGRhdGVUZXJtaW5hbFRpdGxlKCk7XG5cdFx0aWYgKHRoaXMubG9hZGluZ0FuaW1hdGlvbikge1xuXHRcdFx0dGhpcy5sb2FkaW5nQW5pbWF0aW9uLnNldE1lc3NhZ2UoXG5cdFx0XHRcdGAke3RoaXMuZGVmYXVsdFdvcmtpbmdNZXNzYWdlfSAoJHthcHBLZXkodGhpcy5rZXliaW5kaW5ncywgXCJpbnRlcnJ1cHRcIil9IHRvIGludGVycnVwdClgLFxuXHRcdFx0KTtcblx0XHR9XG5cdH1cblxuXHQvLyBNYXhpbXVtIHRvdGFsIHdpZGdldCBsaW5lcyB0byBwcmV2ZW50IHZpZXdwb3J0IG92ZXJmbG93XG5cdHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IE1BWF9XSURHRVRfTElORVMgPSAxMDtcblxuXHQvKipcblx0ICogUmVuZGVyIGFsbCBleHRlbnNpb24gd2lkZ2V0cyB0byB0aGUgd2lkZ2V0IGNvbnRhaW5lci5cblx0ICovXG5cdHByaXZhdGUgcmVuZGVyV2lkZ2V0cygpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMud2lkZ2V0Q29udGFpbmVyQWJvdmUgfHwgIXRoaXMud2lkZ2V0Q29udGFpbmVyQmVsb3cpIHJldHVybjtcblxuXHRcdC8vIHdpZGdldENvbnRhaW5lckFib3ZlOiBzcGFjZXIgY29sbGFwc2VzIHdoZW4gcGlubmVkIGNvbnRlbnQgaXMgdmlzaWJsZVxuXHRcdC8vIHNvIHRoZXJlJ3Mgbm8gZXh0cmEgYmxhbmsgbGluZSBiZXR3ZWVuIHBpbm5lZCBvdXRwdXQgYW5kIHRoZSBlZGl0b3IgYm9yZGVyLlxuXHRcdC8vIFVzZSBkZXRhY2hDaGlsZHJlbigpIChub3QgY2xlYXIoKSkgXHUyMDE0IHRoZSBleHRlbnNpb25XaWRnZXRzQWJvdmUgbWFwIG93bnNcblx0XHQvLyBkaXNwb3NhbDsgY2xlYXIoKSB3b3VsZCBkaXNwb3NlIGV2ZXJ5IG1vdW50ZWQgd2lkZ2V0IG9uIGV2ZXJ5IHJlLXJlbmRlci5cblx0XHR0aGlzLndpZGdldENvbnRhaW5lckFib3ZlLmRldGFjaENoaWxkcmVuKCk7XG5cdFx0Y29uc3QgcGlubmVkID0gdGhpcy5waW5uZWRNZXNzYWdlQ29udGFpbmVyO1xuXHRcdHRoaXMud2lkZ2V0Q29udGFpbmVyQWJvdmUuYWRkQ2hpbGQoe1xuXHRcdFx0cmVuZGVyOiAoKSA9PiBwaW5uZWQuY2hpbGRyZW4ubGVuZ3RoID4gMCA/IFtdIDogW1wiXCJdLFxuXHRcdFx0aW52YWxpZGF0ZTogKCkgPT4ge30sXG5cdFx0fSk7XG5cdFx0Zm9yIChjb25zdCBjb21wb25lbnQgb2YgdGhpcy5leHRlbnNpb25XaWRnZXRzQWJvdmUudmFsdWVzKCkpIHtcblx0XHRcdHRoaXMud2lkZ2V0Q29udGFpbmVyQWJvdmUuYWRkQ2hpbGQoY29tcG9uZW50KTtcblx0XHR9XG5cblx0XHR0aGlzLnJlbmRlcldpZGdldENvbnRhaW5lcih0aGlzLndpZGdldENvbnRhaW5lckJlbG93LCB0aGlzLmV4dGVuc2lvbldpZGdldHNCZWxvdywgZmFsc2UsIGZhbHNlKTtcblx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdHByaXZhdGUgcmVuZGVyV2lkZ2V0Q29udGFpbmVyKFxuXHRcdGNvbnRhaW5lcjogQ29udGFpbmVyLFxuXHRcdHdpZGdldHM6IE1hcDxzdHJpbmcsIENvbXBvbmVudCAmIHsgZGlzcG9zZT8oKTogdm9pZCB9Pixcblx0XHRzcGFjZXJXaGVuRW1wdHk6IGJvb2xlYW4sXG5cdFx0bGVhZGluZ1NwYWNlcjogYm9vbGVhbixcblx0KTogdm9pZCB7XG5cdFx0Ly8gRGV0YWNoIHdpdGhvdXQgZGlzcG9zaW5nIFx1MjAxNCB0aGUgd2lkZ2V0cyBtYXAgb3ducyBsaWZlY3ljbGU7IGRpc3Bvc2luZ1xuXHRcdC8vIGhlcmUgd291bGQga2lsbCByZWZyZXNoIHRpbWVycyBhbmQgc3Vic2NyaXB0aW9ucyBvbiBldmVyeSByZS1yZW5kZXIuXG5cdFx0Y29udGFpbmVyLmRldGFjaENoaWxkcmVuKCk7XG5cblx0XHRpZiAod2lkZ2V0cy5zaXplID09PSAwKSB7XG5cdFx0XHRpZiAoc3BhY2VyV2hlbkVtcHR5KSB7XG5cdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRpZiAobGVhZGluZ1NwYWNlcikge1xuXHRcdFx0Y29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiB3aWRnZXRzLnZhbHVlcygpKSB7XG5cdFx0XHRjb250YWluZXIuYWRkQ2hpbGQoY29tcG9uZW50KTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGEgY3VzdG9tIGZvb3RlciBjb21wb25lbnQsIG9yIHJlc3RvcmUgdGhlIGJ1aWx0LWluIGZvb3Rlci5cblx0ICovXG5cdHByaXZhdGUgc2V0RXh0ZW5zaW9uRm9vdGVyKFxuXHRcdGZhY3Rvcnk6XG5cdFx0XHR8ICgodHVpOiBUVUksIHRobTogVGhlbWUsIGZvb3RlckRhdGE6IFJlYWRvbmx5Rm9vdGVyRGF0YVByb3ZpZGVyKSA9PiBDb21wb25lbnQgJiB7IGRpc3Bvc2U/KCk6IHZvaWQgfSlcblx0XHRcdHwgdW5kZWZpbmVkLFxuXHQpOiB2b2lkIHtcblx0XHQvLyBEaXNwb3NlIGV4aXN0aW5nIGN1c3RvbSBmb290ZXJcblx0XHRpZiAodGhpcy5jdXN0b21Gb290ZXI/LmRpc3Bvc2UpIHtcblx0XHRcdHRoaXMuY3VzdG9tRm9vdGVyLmRpc3Bvc2UoKTtcblx0XHR9XG5cblx0XHQvLyBSZW1vdmUgY3VycmVudCBmb290ZXIgZnJvbSBVSVxuXHRcdGlmICh0aGlzLmN1c3RvbUZvb3Rlcikge1xuXHRcdFx0dGhpcy51aS5yZW1vdmVDaGlsZCh0aGlzLmN1c3RvbUZvb3Rlcik7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMudWkucmVtb3ZlQ2hpbGQodGhpcy5mb290ZXIpO1xuXHRcdH1cblxuXHRcdGlmIChmYWN0b3J5KSB7XG5cdFx0XHQvLyBDcmVhdGUgYW5kIGFkZCBjdXN0b20gZm9vdGVyLCBwYXNzaW5nIHRoZSBkYXRhIHByb3ZpZGVyXG5cdFx0XHR0aGlzLmN1c3RvbUZvb3RlciA9IGZhY3RvcnkodGhpcy51aSwgdGhlbWUsIHRoaXMuZm9vdGVyRGF0YVByb3ZpZGVyKTtcblx0XHRcdHRoaXMudWkuYWRkQ2hpbGQodGhpcy5jdXN0b21Gb290ZXIpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBSZXN0b3JlIGJ1aWx0LWluIGZvb3RlclxuXHRcdFx0dGhpcy5jdXN0b21Gb290ZXIgPSB1bmRlZmluZWQ7XG5cdFx0XHR0aGlzLnVpLmFkZENoaWxkKHRoaXMuZm9vdGVyKTtcblx0XHR9XG5cblx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgYSBjdXN0b20gaGVhZGVyIGNvbXBvbmVudCwgb3IgcmVzdG9yZSB0aGUgYnVpbHQtaW4gaGVhZGVyLlxuXHQgKi9cblx0cHJpdmF0ZSBzZXRFeHRlbnNpb25IZWFkZXIoZmFjdG9yeTogKCh0dWk6IFRVSSwgdGhtOiBUaGVtZSkgPT4gQ29tcG9uZW50ICYgeyBkaXNwb3NlPygpOiB2b2lkIH0pIHwgdW5kZWZpbmVkKTogdm9pZCB7XG5cdFx0Ly8gSGVhZGVyIG1heSBub3QgYmUgaW5pdGlhbGl6ZWQgeWV0IGlmIGNhbGxlZCBkdXJpbmcgZWFybHkgaW5pdGlhbGl6YXRpb25cblx0XHRpZiAoIXRoaXMuYnVpbHRJbkhlYWRlcikge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIERpc3Bvc2UgZXhpc3RpbmcgY3VzdG9tIGhlYWRlclxuXHRcdGlmICh0aGlzLmN1c3RvbUhlYWRlcj8uZGlzcG9zZSkge1xuXHRcdFx0dGhpcy5jdXN0b21IZWFkZXIuZGlzcG9zZSgpO1xuXHRcdH1cblxuXHRcdC8vIEZpbmQgdGhlIGluZGV4IG9mIHRoZSBjdXJyZW50IGhlYWRlciBpbiB0aGUgaGVhZGVyIGNvbnRhaW5lclxuXHRcdGNvbnN0IGN1cnJlbnRIZWFkZXIgPSB0aGlzLmN1c3RvbUhlYWRlciB8fCB0aGlzLmJ1aWx0SW5IZWFkZXI7XG5cdFx0Y29uc3QgaW5kZXggPSB0aGlzLmhlYWRlckNvbnRhaW5lci5jaGlsZHJlbi5pbmRleE9mKGN1cnJlbnRIZWFkZXIpO1xuXG5cdFx0aWYgKGZhY3RvcnkpIHtcblx0XHRcdC8vIENyZWF0ZSBhbmQgYWRkIGN1c3RvbSBoZWFkZXJcblx0XHRcdHRoaXMuY3VzdG9tSGVhZGVyID0gZmFjdG9yeSh0aGlzLnVpLCB0aGVtZSk7XG5cdFx0XHRpZiAoaW5kZXggIT09IC0xKSB7XG5cdFx0XHRcdHRoaXMuaGVhZGVyQ29udGFpbmVyLmNoaWxkcmVuW2luZGV4XSA9IHRoaXMuY3VzdG9tSGVhZGVyO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gSWYgbm90IGZvdW5kIChlLmcuIGJ1aWx0SW5IZWFkZXIgd2FzIG5ldmVyIGFkZGVkKSwgYWRkIGF0IHRoZSB0b3Bcblx0XHRcdFx0dGhpcy5oZWFkZXJDb250YWluZXIuY2hpbGRyZW4udW5zaGlmdCh0aGlzLmN1c3RvbUhlYWRlcik7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIHtcblx0XHRcdC8vIFJlc3RvcmUgYnVpbHQtaW4gaGVhZGVyXG5cdFx0XHR0aGlzLmN1c3RvbUhlYWRlciA9IHVuZGVmaW5lZDtcblx0XHRcdGlmIChpbmRleCAhPT0gLTEpIHtcblx0XHRcdFx0dGhpcy5oZWFkZXJDb250YWluZXIuY2hpbGRyZW5baW5kZXhdID0gdGhpcy5idWlsdEluSGVhZGVyO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0cHJpdmF0ZSBhZGRFeHRlbnNpb25UZXJtaW5hbElucHV0TGlzdGVuZXIoXG5cdFx0aGFuZGxlcjogKGRhdGE6IHN0cmluZykgPT4geyBjb25zdW1lPzogYm9vbGVhbjsgZGF0YT86IHN0cmluZyB9IHwgdW5kZWZpbmVkLFxuXHQpOiAoKSA9PiB2b2lkIHtcblx0XHRjb25zdCB1bnN1YnNjcmliZSA9IHRoaXMudWkuYWRkSW5wdXRMaXN0ZW5lcihoYW5kbGVyKTtcblx0XHR0aGlzLmV4dGVuc2lvblRlcm1pbmFsSW5wdXRVbnN1YnNjcmliZXJzLmFkZCh1bnN1YnNjcmliZSk7XG5cdFx0cmV0dXJuICgpID0+IHtcblx0XHRcdHVuc3Vic2NyaWJlKCk7XG5cdFx0XHR0aGlzLmV4dGVuc2lvblRlcm1pbmFsSW5wdXRVbnN1YnNjcmliZXJzLmRlbGV0ZSh1bnN1YnNjcmliZSk7XG5cdFx0fTtcblx0fVxuXG5cdHByaXZhdGUgY2xlYXJFeHRlbnNpb25UZXJtaW5hbElucHV0TGlzdGVuZXJzKCk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgdW5zdWJzY3JpYmUgb2YgdGhpcy5leHRlbnNpb25UZXJtaW5hbElucHV0VW5zdWJzY3JpYmVycykge1xuXHRcdFx0dW5zdWJzY3JpYmUoKTtcblx0XHR9XG5cdFx0dGhpcy5leHRlbnNpb25UZXJtaW5hbElucHV0VW5zdWJzY3JpYmVycy5jbGVhcigpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENyZWF0ZSB0aGUgRXh0ZW5zaW9uVUlDb250ZXh0IGZvciBleHRlbnNpb25zLlxuXHQgKi9cblx0cHJpdmF0ZSBjcmVhdGVFeHRlbnNpb25VSUNvbnRleHQoKTogRXh0ZW5zaW9uVUlDb250ZXh0IHtcblx0XHRyZXR1cm4gYnVpbGRFeHRlbnNpb25VSUNvbnRleHQodGhpcyk7XG5cdH1cblxuXHRnZXRFeHRlbnNpb25VSUNvbnRleHQoKTogRXh0ZW5zaW9uVUlDb250ZXh0IHtcblx0XHRyZXR1cm4gdGhpcy5jcmVhdGVFeHRlbnNpb25VSUNvbnRleHQoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTaG93IGEgc2VsZWN0b3IgZm9yIGV4dGVuc2lvbnMuXG5cdCAqL1xuXHRwcml2YXRlIHNob3dFeHRlbnNpb25TZWxlY3Rvcihcblx0XHR0aXRsZTogc3RyaW5nLFxuXHRcdG9wdGlvbnM6IHN0cmluZ1tdLFxuXHRcdG9wdHM/OiBFeHRlbnNpb25VSURpYWxvZ09wdGlvbnMsXG5cdCk6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG5cdFx0Ly8gSWYgYSBwcmV2aW91cyBzZWxlY3RvciBpcyBzdGlsbCBhY3RpdmUsIGRpc3Bvc2UgaXQgYmVmb3JlIGNyZWF0aW5nIGFcblx0XHQvLyBuZXcgb25lLiAgVGhpcyBhdm9pZHMgbGVha2luZyB0aGUgcHJldmlvdXMgcHJvbWlzZSBhbmQgRE9NIHN0YXRlIHdoZW5cblx0XHQvLyBzaG93RXh0ZW5zaW9uU2VsZWN0b3IgaXMgY2FsbGVkIHJhcGlkbHkuXG5cdFx0aWYgKHRoaXMuZXh0ZW5zaW9uU2VsZWN0b3IpIHtcblx0XHRcdHRoaXMuaGlkZUV4dGVuc2lvblNlbGVjdG9yKCk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG5cdFx0XHRpZiAob3B0cz8uc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdHJlc29sdmUodW5kZWZpbmVkKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBvbkFib3J0ID0gKCkgPT4ge1xuXHRcdFx0XHR0aGlzLmhpZGVFeHRlbnNpb25TZWxlY3RvcigpO1xuXHRcdFx0XHRyZXNvbHZlKHVuZGVmaW5lZCk7XG5cdFx0XHR9O1xuXHRcdFx0b3B0cz8uc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuXG5cdFx0XHR0aGlzLmV4dGVuc2lvblNlbGVjdG9yID0gbmV3IEV4dGVuc2lvblNlbGVjdG9yQ29tcG9uZW50KFxuXHRcdFx0XHR0aXRsZSxcblx0XHRcdFx0b3B0aW9ucyxcblx0XHRcdFx0KG9wdGlvbikgPT4ge1xuXHRcdFx0XHRcdG9wdHM/LnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRcdHRoaXMuaGlkZUV4dGVuc2lvblNlbGVjdG9yKCk7XG5cdFx0XHRcdFx0cmVzb2x2ZShvcHRpb24pO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHQoKSA9PiB7XG5cdFx0XHRcdFx0b3B0cz8uc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0dGhpcy5oaWRlRXh0ZW5zaW9uU2VsZWN0b3IoKTtcblx0XHRcdFx0XHRyZXNvbHZlKHVuZGVmaW5lZCk7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdHsgdHVpOiB0aGlzLnVpLCB0aW1lb3V0OiBvcHRzPy50aW1lb3V0IH0sXG5cdFx0XHQpO1xuXG5cdFx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5jbGVhcigpO1xuXHRcdFx0dGhpcy5lZGl0b3JDb250YWluZXIuYWRkQ2hpbGQodGhpcy5leHRlbnNpb25TZWxlY3Rvcik7XG5cdFx0XHR0aGlzLnVpLnNldEZvY3VzKHRoaXMuZXh0ZW5zaW9uU2VsZWN0b3IpO1xuXHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fSk7XG5cdH1cblxuXHQvKipcblx0ICogSGlkZSB0aGUgZXh0ZW5zaW9uIHNlbGVjdG9yLlxuXHQgKi9cblx0cHJpdmF0ZSBoaWRlRXh0ZW5zaW9uU2VsZWN0b3IoKTogdm9pZCB7XG5cdFx0dGhpcy5leHRlbnNpb25TZWxlY3Rvcj8uZGlzcG9zZSgpO1xuXHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy5lZGl0b3JDb250YWluZXIuYWRkQ2hpbGQodGhpcy5lZGl0b3IpO1xuXHRcdHRoaXMuZXh0ZW5zaW9uU2VsZWN0b3IgPSB1bmRlZmluZWQ7XG5cdFx0dGhpcy51aS5zZXRGb2N1cyh0aGlzLmVkaXRvcik7XG5cdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHQvKipcblx0ICogU2hvdyBhIGNvbmZpcm1hdGlvbiBkaWFsb2cgZm9yIGV4dGVuc2lvbnMuXG5cdCAqL1xuXHRwcml2YXRlIGFzeW5jIHNob3dFeHRlbnNpb25Db25maXJtKFxuXHRcdHRpdGxlOiBzdHJpbmcsXG5cdFx0bWVzc2FnZTogc3RyaW5nLFxuXHRcdG9wdHM/OiBFeHRlbnNpb25VSURpYWxvZ09wdGlvbnMsXG5cdCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuc2hvd0V4dGVuc2lvblNlbGVjdG9yKGAke3RpdGxlfVxcbiR7bWVzc2FnZX1gLCBbXCJZZXNcIiwgXCJOb1wiXSwgb3B0cyk7XG5cdFx0cmV0dXJuIHJlc3VsdCA9PT0gXCJZZXNcIjtcblx0fVxuXG5cdC8qKlxuXHQgKiBTaG93IGEgdGV4dCBpbnB1dCBmb3IgZXh0ZW5zaW9ucy5cblx0ICovXG5cdHByaXZhdGUgc2hvd0V4dGVuc2lvbklucHV0KFxuXHRcdHRpdGxlOiBzdHJpbmcsXG5cdFx0cGxhY2Vob2xkZXI/OiBzdHJpbmcsXG5cdFx0b3B0cz86IEV4dGVuc2lvblVJRGlhbG9nT3B0aW9ucyxcblx0KTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcblx0XHRcdGlmIChvcHRzPy5zaWduYWw/LmFib3J0ZWQpIHtcblx0XHRcdFx0cmVzb2x2ZSh1bmRlZmluZWQpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IG9uQWJvcnQgPSAoKSA9PiB7XG5cdFx0XHRcdHRoaXMuaGlkZUV4dGVuc2lvbklucHV0KCk7XG5cdFx0XHRcdHJlc29sdmUodW5kZWZpbmVkKTtcblx0XHRcdH07XG5cdFx0XHRvcHRzPy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkFib3J0LCB7IG9uY2U6IHRydWUgfSk7XG5cblx0XHRcdHRoaXMuZXh0ZW5zaW9uSW5wdXQgPSBuZXcgRXh0ZW5zaW9uSW5wdXRDb21wb25lbnQoXG5cdFx0XHRcdHRpdGxlLFxuXHRcdFx0XHRwbGFjZWhvbGRlcixcblx0XHRcdFx0KHZhbHVlKSA9PiB7XG5cdFx0XHRcdFx0b3B0cz8uc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdFx0dGhpcy5oaWRlRXh0ZW5zaW9uSW5wdXQoKTtcblx0XHRcdFx0XHRyZXNvbHZlKHZhbHVlKTtcblx0XHRcdFx0fSxcblx0XHRcdFx0KCkgPT4ge1xuXHRcdFx0XHRcdG9wdHM/LnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuXHRcdFx0XHRcdHRoaXMuaGlkZUV4dGVuc2lvbklucHV0KCk7XG5cdFx0XHRcdFx0cmVzb2x2ZSh1bmRlZmluZWQpO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHR7IHR1aTogdGhpcy51aSwgdGltZW91dDogb3B0cz8udGltZW91dCwgc2VjdXJlOiBvcHRzPy5zZWN1cmUgfSxcblx0XHRcdCk7XG5cblx0XHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5hZGRDaGlsZCh0aGlzLmV4dGVuc2lvbklucHV0KTtcblx0XHRcdHRoaXMudWkuc2V0Rm9jdXModGhpcy5leHRlbnNpb25JbnB1dCk7XG5cdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBIaWRlIHRoZSBleHRlbnNpb24gaW5wdXQuXG5cdCAqL1xuXHRwcml2YXRlIGhpZGVFeHRlbnNpb25JbnB1dCgpOiB2b2lkIHtcblx0XHR0aGlzLmV4dGVuc2lvbklucHV0Py5kaXNwb3NlKCk7XG5cdFx0dGhpcy5lZGl0b3JDb250YWluZXIuY2xlYXIoKTtcblx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5hZGRDaGlsZCh0aGlzLmVkaXRvcik7XG5cdFx0dGhpcy5leHRlbnNpb25JbnB1dCA9IHVuZGVmaW5lZDtcblx0XHR0aGlzLnVpLnNldEZvY3VzKHRoaXMuZWRpdG9yKTtcblx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTaG93IGEgbXVsdGktbGluZSBlZGl0b3IgZm9yIGV4dGVuc2lvbnMgKHdpdGggQ3RybCtHIHN1cHBvcnQpLlxuXHQgKi9cblx0cHJpdmF0ZSBzaG93RXh0ZW5zaW9uRWRpdG9yKHRpdGxlOiBzdHJpbmcsIHByZWZpbGw/OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4ge1xuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuXHRcdFx0dGhpcy5leHRlbnNpb25FZGl0b3IgPSBuZXcgRXh0ZW5zaW9uRWRpdG9yQ29tcG9uZW50KFxuXHRcdFx0XHR0aGlzLnVpLFxuXHRcdFx0XHR0aGlzLmtleWJpbmRpbmdzLFxuXHRcdFx0XHR0aXRsZSxcblx0XHRcdFx0cHJlZmlsbCxcblx0XHRcdFx0KHZhbHVlKSA9PiB7XG5cdFx0XHRcdFx0dGhpcy5oaWRlRXh0ZW5zaW9uRWRpdG9yKCk7XG5cdFx0XHRcdFx0cmVzb2x2ZSh2YWx1ZSk7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdCgpID0+IHtcblx0XHRcdFx0XHR0aGlzLmhpZGVFeHRlbnNpb25FZGl0b3IoKTtcblx0XHRcdFx0XHRyZXNvbHZlKHVuZGVmaW5lZCk7XG5cdFx0XHRcdH0sXG5cdFx0XHQpO1xuXG5cdFx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5jbGVhcigpO1xuXHRcdFx0dGhpcy5lZGl0b3JDb250YWluZXIuYWRkQ2hpbGQodGhpcy5leHRlbnNpb25FZGl0b3IpO1xuXHRcdFx0dGhpcy51aS5zZXRGb2N1cyh0aGlzLmV4dGVuc2lvbkVkaXRvcik7XG5cdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBIaWRlIHRoZSBleHRlbnNpb24gZWRpdG9yLlxuXHQgKi9cblx0cHJpdmF0ZSBoaWRlRXh0ZW5zaW9uRWRpdG9yKCk6IHZvaWQge1xuXHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy5lZGl0b3JDb250YWluZXIuYWRkQ2hpbGQodGhpcy5lZGl0b3IpO1xuXHRcdHRoaXMuZXh0ZW5zaW9uRWRpdG9yID0gdW5kZWZpbmVkO1xuXHRcdHRoaXMudWkuc2V0Rm9jdXModGhpcy5lZGl0b3IpO1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldCBhIGN1c3RvbSBlZGl0b3IgY29tcG9uZW50IGZyb20gYW4gZXh0ZW5zaW9uLlxuXHQgKiBQYXNzIHVuZGVmaW5lZCB0byByZXN0b3JlIHRoZSBkZWZhdWx0IGVkaXRvci5cblx0ICovXG5cdHByaXZhdGUgc2V0Q3VzdG9tRWRpdG9yQ29tcG9uZW50KFxuXHRcdGZhY3Rvcnk6ICgodHVpOiBUVUksIHRoZW1lOiBFZGl0b3JUaGVtZSwga2V5YmluZGluZ3M6IEtleWJpbmRpbmdzTWFuYWdlcikgPT4gRWRpdG9yQ29tcG9uZW50KSB8IHVuZGVmaW5lZCxcblx0KTogdm9pZCB7XG5cdFx0Ly8gU2F2ZSB0ZXh0IGZyb20gY3VycmVudCBlZGl0b3IgYmVmb3JlIHN3aXRjaGluZ1xuXHRcdGNvbnN0IGN1cnJlbnRUZXh0ID0gdGhpcy5lZGl0b3IuZ2V0VGV4dCgpO1xuXG5cdFx0dGhpcy5lZGl0b3JDb250YWluZXIuY2xlYXIoKTtcblxuXHRcdGlmIChmYWN0b3J5KSB7XG5cdFx0XHQvLyBDcmVhdGUgdGhlIGN1c3RvbSBlZGl0b3Igd2l0aCB0dWksIHRoZW1lLCBhbmQga2V5YmluZGluZ3Ncblx0XHRcdGNvbnN0IG5ld0VkaXRvciA9IGZhY3RvcnkodGhpcy51aSwgZ2V0RWRpdG9yVGhlbWUoKSwgdGhpcy5rZXliaW5kaW5ncyk7XG5cblx0XHRcdC8vIFdpcmUgdXAgY2FsbGJhY2tzIGZyb20gdGhlIGRlZmF1bHQgZWRpdG9yXG5cdFx0XHRuZXdFZGl0b3Iub25TdWJtaXQgPSB0aGlzLmRlZmF1bHRFZGl0b3Iub25TdWJtaXQ7XG5cdFx0XHRuZXdFZGl0b3Iub25DaGFuZ2UgPSB0aGlzLmRlZmF1bHRFZGl0b3Iub25DaGFuZ2U7XG5cblx0XHRcdC8vIENvcHkgdGV4dCBmcm9tIHByZXZpb3VzIGVkaXRvclxuXHRcdFx0bmV3RWRpdG9yLnNldFRleHQoY3VycmVudFRleHQpO1xuXG5cdFx0XHQvLyBDb3B5IGFwcGVhcmFuY2Ugc2V0dGluZ3MgaWYgc3VwcG9ydGVkXG5cdFx0XHRpZiAobmV3RWRpdG9yLmJvcmRlckNvbG9yICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0bmV3RWRpdG9yLmJvcmRlckNvbG9yID0gdGhpcy5kZWZhdWx0RWRpdG9yLmJvcmRlckNvbG9yO1xuXHRcdFx0fVxuXHRcdFx0aWYgKG5ld0VkaXRvci5zZXRQYWRkaW5nWCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdG5ld0VkaXRvci5zZXRQYWRkaW5nWCh0aGlzLmRlZmF1bHRFZGl0b3IuZ2V0UGFkZGluZ1goKSk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFNldCBhdXRvY29tcGxldGUgaWYgc3VwcG9ydGVkXG5cdFx0XHRpZiAobmV3RWRpdG9yLnNldEF1dG9jb21wbGV0ZVByb3ZpZGVyICYmIHRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIpIHtcblx0XHRcdFx0bmV3RWRpdG9yLnNldEF1dG9jb21wbGV0ZVByb3ZpZGVyKHRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBJZiBleHRlbmRpbmcgQ3VzdG9tRWRpdG9yLCBjb3B5IGFwcC1sZXZlbCBoYW5kbGVyc1xuXHRcdFx0Ly8gVXNlIGR1Y2sgdHlwaW5nIHNpbmNlIGluc3RhbmNlb2YgZmFpbHMgYWNyb3NzIGppdGkgbW9kdWxlIGJvdW5kYXJpZXNcblx0XHRcdGNvbnN0IGN1c3RvbUVkaXRvciA9IG5ld0VkaXRvciBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXHRcdFx0aWYgKFwiYWN0aW9uSGFuZGxlcnNcIiBpbiBjdXN0b21FZGl0b3IgJiYgY3VzdG9tRWRpdG9yLmFjdGlvbkhhbmRsZXJzIGluc3RhbmNlb2YgTWFwKSB7XG5cdFx0XHRcdGlmICghY3VzdG9tRWRpdG9yLm9uRXNjYXBlKSB7XG5cdFx0XHRcdFx0Y3VzdG9tRWRpdG9yLm9uRXNjYXBlID0gKCkgPT4gdGhpcy5kZWZhdWx0RWRpdG9yLm9uRXNjYXBlPy4oKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoIWN1c3RvbUVkaXRvci5vbkN0cmxEKSB7XG5cdFx0XHRcdFx0Y3VzdG9tRWRpdG9yLm9uQ3RybEQgPSAoKSA9PiB0aGlzLmRlZmF1bHRFZGl0b3Iub25DdHJsRD8uKCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKCFjdXN0b21FZGl0b3Iub25QYXN0ZUltYWdlKSB7XG5cdFx0XHRcdFx0Y3VzdG9tRWRpdG9yLm9uUGFzdGVJbWFnZSA9ICgpID0+IHRoaXMuZGVmYXVsdEVkaXRvci5vblBhc3RlSW1hZ2U/LigpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmICghY3VzdG9tRWRpdG9yLm9uRXh0ZW5zaW9uU2hvcnRjdXQpIHtcblx0XHRcdFx0XHRjdXN0b21FZGl0b3Iub25FeHRlbnNpb25TaG9ydGN1dCA9IChkYXRhOiBzdHJpbmcpID0+IHRoaXMuZGVmYXVsdEVkaXRvci5vbkV4dGVuc2lvblNob3J0Y3V0Py4oZGF0YSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gQ29weSBhY3Rpb24gaGFuZGxlcnMgKGNsZWFyLCBzdXNwZW5kLCBtb2RlbCBzd2l0Y2hpbmcsIGV0Yy4pXG5cdFx0XHRcdGZvciAoY29uc3QgW2FjdGlvbiwgaGFuZGxlcl0gb2YgdGhpcy5kZWZhdWx0RWRpdG9yLmFjdGlvbkhhbmRsZXJzKSB7XG5cdFx0XHRcdFx0KGN1c3RvbUVkaXRvci5hY3Rpb25IYW5kbGVycyBhcyBNYXA8c3RyaW5nLCAoKSA9PiB2b2lkPikuc2V0KGFjdGlvbiwgaGFuZGxlcik7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0dGhpcy5lZGl0b3IgPSBuZXdFZGl0b3I7XG5cdFx0fSBlbHNlIHtcblx0XHRcdC8vIFJlc3RvcmUgZGVmYXVsdCBlZGl0b3Igd2l0aCB0ZXh0IGZyb20gY3VzdG9tIGVkaXRvclxuXHRcdFx0dGhpcy5kZWZhdWx0RWRpdG9yLnNldFRleHQoY3VycmVudFRleHQpO1xuXHRcdFx0dGhpcy5lZGl0b3IgPSB0aGlzLmRlZmF1bHRFZGl0b3I7XG5cdFx0fVxuXG5cdFx0Ly8gRW5zdXJlIHBhc3RlZCBpbWFnZSBwYXRoIGhhbmRsZXIgaXMgc2V0IG9uIHRoZSBhY3RpdmUgZWRpdG9yXG5cdFx0aWYgKCF0aGlzLmVkaXRvci5vblBhc3RlSW1hZ2VQYXRoKSB7XG5cdFx0XHR0aGlzLmVkaXRvci5vblBhc3RlSW1hZ2VQYXRoID0gKGZpbGVQYXRoOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0dGhpcy5oYW5kbGVQYXN0ZWRJbWFnZVBhdGgoZmlsZVBhdGgpO1xuXHRcdFx0fTtcblx0XHR9XG5cblx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5hZGRDaGlsZCh0aGlzLmVkaXRvciBhcyBDb21wb25lbnQpO1xuXHRcdHRoaXMudWkuc2V0Rm9jdXModGhpcy5lZGl0b3IgYXMgQ29tcG9uZW50KTtcblx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTaG93IGEgbm90aWZpY2F0aW9uIGZvciBleHRlbnNpb25zLlxuXHQgKi9cblx0cHJpdmF0ZSBzaG93RXh0ZW5zaW9uTm90aWZ5KG1lc3NhZ2U6IHN0cmluZywgdHlwZT86IEV4dGVuc2lvbk5vdGlmeVR5cGUpOiB2b2lkIHtcblx0XHRpZiAodHlwZSA9PT0gXCJlcnJvclwiKSB7XG5cdFx0XHR0aGlzLmxhc3RCbG9ja2luZ0Vycm9yID0gbWVzc2FnZTtcblx0XHRcdHJlbmRlckJsb2NraW5nRXJyb3JCYW5uZXIodGhpcy5ibG9ja2luZ0Vycm9yQ29udGFpbmVyLCB0aGlzLmxhc3RCbG9ja2luZ0Vycm9yKTtcblx0XHR9XG5cdFx0Y29uc3QgcmVzdWx0ID0gcmVuZGVyRXh0ZW5zaW9uTm90aWZ5SW5DaGF0KHRoaXMuY2hhdENvbnRhaW5lciwgbWVzc2FnZSwgdHlwZSk7XG5cdFx0aWYgKCFyZXN1bHQucmVuZGVyZWQpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKHJlc3VsdC5zdGF0dXNTcGFjZXIgJiYgcmVzdWx0LnN0YXR1c1RleHQpIHtcblx0XHRcdHRoaXMubGFzdFN0YXR1c1NwYWNlciA9IHJlc3VsdC5zdGF0dXNTcGFjZXI7XG5cdFx0XHR0aGlzLmxhc3RTdGF0dXNUZXh0ID0gcmVzdWx0LnN0YXR1c1RleHQ7XG5cdFx0fVxuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0LyoqIFNob3cgYSBjdXN0b20gY29tcG9uZW50IHdpdGgga2V5Ym9hcmQgZm9jdXMuIE92ZXJsYXkgbW9kZSByZW5kZXJzIG9uIHRvcCBvZiBleGlzdGluZyBjb250ZW50LiAqL1xuXHRwcml2YXRlIGFzeW5jIHNob3dFeHRlbnNpb25DdXN0b208VD4oXG5cdFx0ZmFjdG9yeTogKFxuXHRcdFx0dHVpOiBUVUksXG5cdFx0XHR0aGVtZTogVGhlbWUsXG5cdFx0XHRrZXliaW5kaW5nczogS2V5YmluZGluZ3NNYW5hZ2VyLFxuXHRcdFx0ZG9uZTogKHJlc3VsdDogVCkgPT4gdm9pZCxcblx0XHQpID0+IChDb21wb25lbnQgJiB7IGRpc3Bvc2U/KCk6IHZvaWQgfSkgfCBQcm9taXNlPENvbXBvbmVudCAmIHsgZGlzcG9zZT8oKTogdm9pZCB9Pixcblx0XHRvcHRpb25zPzoge1xuXHRcdFx0b3ZlcmxheT86IGJvb2xlYW47XG5cdFx0XHRvdmVybGF5T3B0aW9ucz86IE92ZXJsYXlPcHRpb25zIHwgKCgpID0+IE92ZXJsYXlPcHRpb25zKTtcblx0XHRcdG9uSGFuZGxlPzogKGhhbmRsZTogT3ZlcmxheUhhbmRsZSkgPT4gdm9pZDtcblx0XHR9LFxuXHQpOiBQcm9taXNlPFQ+IHtcblx0XHRjb25zdCBzYXZlZFRleHQgPSB0aGlzLmVkaXRvci5nZXRUZXh0KCk7XG5cdFx0Y29uc3QgaXNPdmVybGF5ID0gb3B0aW9ucz8ub3ZlcmxheSA/PyBmYWxzZTtcblxuXHRcdGNvbnN0IHJlc3RvcmVFZGl0b3IgPSAoKSA9PiB7XG5cdFx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5jbGVhcigpO1xuXHRcdFx0dGhpcy5lZGl0b3JDb250YWluZXIuYWRkQ2hpbGQodGhpcy5lZGl0b3IpO1xuXHRcdFx0dGhpcy5lZGl0b3Iuc2V0VGV4dChzYXZlZFRleHQpO1xuXHRcdFx0dGhpcy51aS5zZXRGb2N1cyh0aGlzLmVkaXRvcik7XG5cdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9O1xuXG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdGxldCBjb21wb25lbnQ6IENvbXBvbmVudCAmIHsgZGlzcG9zZT8oKTogdm9pZCB9O1xuXHRcdFx0bGV0IGNsb3NlZCA9IGZhbHNlO1xuXG5cdFx0XHRjb25zdCBjbG9zZSA9IChyZXN1bHQ6IFQpID0+IHtcblx0XHRcdFx0aWYgKGNsb3NlZCkgcmV0dXJuO1xuXHRcdFx0XHRjbG9zZWQgPSB0cnVlO1xuXHRcdFx0XHRpZiAoaXNPdmVybGF5KSB0aGlzLnVpLmhpZGVPdmVybGF5KCk7XG5cdFx0XHRcdGVsc2UgcmVzdG9yZUVkaXRvcigpO1xuXHRcdFx0XHQvLyBOb3RlOiBib3RoIGJyYW5jaGVzIGFib3ZlIGFscmVhZHkgY2FsbCByZXF1ZXN0UmVuZGVyXG5cdFx0XHRcdHJlc29sdmUocmVzdWx0KTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRjb21wb25lbnQ/LmRpc3Bvc2U/LigpO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHQvKiBpZ25vcmUgZGlzcG9zZSBlcnJvcnMgKi9cblx0XHRcdFx0fVxuXHRcdFx0fTtcblxuXHRcdFx0UHJvbWlzZS5yZXNvbHZlKGZhY3RvcnkodGhpcy51aSwgdGhlbWUsIHRoaXMua2V5YmluZGluZ3MsIGNsb3NlKSlcblx0XHRcdFx0LnRoZW4oKGMpID0+IHtcblx0XHRcdFx0XHRpZiAoY2xvc2VkKSByZXR1cm47XG5cdFx0XHRcdFx0Y29tcG9uZW50ID0gYztcblx0XHRcdFx0XHRpZiAoaXNPdmVybGF5KSB7XG5cdFx0XHRcdFx0XHQvLyBSZXNvbHZlIG92ZXJsYXkgb3B0aW9ucyAtIGNhbiBiZSBzdGF0aWMgb3IgZHluYW1pYyBmdW5jdGlvblxuXHRcdFx0XHRcdFx0Y29uc3QgcmVzb2x2ZU9wdGlvbnMgPSAoKTogT3ZlcmxheU9wdGlvbnMgfCB1bmRlZmluZWQgPT4ge1xuXHRcdFx0XHRcdFx0XHRpZiAob3B0aW9ucz8ub3ZlcmxheU9wdGlvbnMpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBvcHRzID1cblx0XHRcdFx0XHRcdFx0XHRcdHR5cGVvZiBvcHRpb25zLm92ZXJsYXlPcHRpb25zID09PSBcImZ1bmN0aW9uXCJcblx0XHRcdFx0XHRcdFx0XHRcdFx0PyBvcHRpb25zLm92ZXJsYXlPcHRpb25zKClcblx0XHRcdFx0XHRcdFx0XHRcdFx0OiBvcHRpb25zLm92ZXJsYXlPcHRpb25zO1xuXHRcdFx0XHRcdFx0XHRcdHJldHVybiBvcHRzO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdC8vIEZhbGxiYWNrOiB1c2UgY29tcG9uZW50J3Mgd2lkdGggcHJvcGVydHkgaWYgYXZhaWxhYmxlXG5cdFx0XHRcdFx0XHRcdGNvbnN0IHcgPSAoY29tcG9uZW50IGFzIHsgd2lkdGg/OiBudW1iZXIgfSkud2lkdGg7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB3ID8geyB3aWR0aDogdyB9IDogdW5kZWZpbmVkO1xuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdGNvbnN0IGhhbmRsZSA9IHRoaXMudWkuc2hvd092ZXJsYXkoY29tcG9uZW50LCByZXNvbHZlT3B0aW9ucygpKTtcblx0XHRcdFx0XHRcdC8vIEV4cG9zZSBoYW5kbGUgdG8gY2FsbGVyIGZvciB2aXNpYmlsaXR5IGNvbnRyb2xcblx0XHRcdFx0XHRcdG9wdGlvbnM/Lm9uSGFuZGxlPy4oaGFuZGxlKTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0dGhpcy5lZGl0b3JDb250YWluZXIuY2xlYXIoKTtcblx0XHRcdFx0XHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmFkZENoaWxkKGNvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHR0aGlzLnVpLnNldEZvY3VzKGNvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0pXG5cdFx0XHRcdC5jYXRjaCgoZXJyKSA9PiB7XG5cdFx0XHRcdFx0aWYgKGNsb3NlZCkgcmV0dXJuO1xuXHRcdFx0XHRcdGlmICghaXNPdmVybGF5KSByZXN0b3JlRWRpdG9yKCk7XG5cdFx0XHRcdFx0cmVqZWN0KGVycik7XG5cdFx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNob3cgYW4gZXh0ZW5zaW9uIGVycm9yIGluIHRoZSBVSS5cblx0ICovXG5cdHByaXZhdGUgc2hvd0V4dGVuc2lvbkVycm9yKGV4dGVuc2lvblBhdGg6IHN0cmluZywgZXJyb3I6IHN0cmluZywgc3RhY2s/OiBzdHJpbmcpOiB2b2lkIHtcblx0XHRjb25zdCBlcnJvck1zZyA9IGBFeHRlbnNpb24gXCIke2V4dGVuc2lvblBhdGh9XCIgZXJyb3I6ICR7ZXJyb3J9YDtcblx0XHRjb25zdCBlcnJvclRleHQgPSBuZXcgVGV4dCh0aGVtZS5mZyhcImVycm9yXCIsIGVycm9yTXNnKSwgMSwgMCk7XG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKGVycm9yVGV4dCk7XG5cdFx0aWYgKHN0YWNrKSB7XG5cdFx0XHQvLyBTaG93IHN0YWNrIHRyYWNlIGluIGRpbSBjb2xvciwgaW5kZW50ZWRcblx0XHRcdGNvbnN0IHN0YWNrTGluZXMgPSBzdGFja1xuXHRcdFx0XHQuc3BsaXQoXCJcXG5cIilcblx0XHRcdFx0LnNsaWNlKDEpIC8vIFNraXAgZmlyc3QgbGluZSAoZHVwbGljYXRlcyBlcnJvciBtZXNzYWdlKVxuXHRcdFx0XHQubWFwKChsaW5lKSA9PiB0aGVtZS5mZyhcImRpbVwiLCBgICAke2xpbmUudHJpbSgpfWApKVxuXHRcdFx0XHQuam9pbihcIlxcblwiKTtcblx0XHRcdGlmIChzdGFja0xpbmVzKSB7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dChzdGFja0xpbmVzLCAxLCAwKSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBLZXkgSGFuZGxlcnNcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdHByaXZhdGUgc2V0dXBLZXlIYW5kbGVycygpOiB2b2lkIHtcblx0XHQvLyBTZXQgdXAgaGFuZGxlcnMgb24gZGVmYXVsdEVkaXRvciAtIHRoZXkgdXNlIHRoaXMuZWRpdG9yIGZvciB0ZXh0IGFjY2Vzc1xuXHRcdC8vIHNvIHRoZXkgd29yayBjb3JyZWN0bHkgcmVnYXJkbGVzcyBvZiB3aGljaCBlZGl0b3IgaXMgYWN0aXZlXG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uRXNjYXBlID0gKCkgPT4ge1xuXHRcdFx0aWYgKHRoaXMubG9hZGluZ0FuaW1hdGlvbikge1xuXHRcdFx0XHR0aGlzLnJlc3RvcmVRdWV1ZWRNZXNzYWdlc1RvRWRpdG9yKHsgYWJvcnQ6IHRydWUgfSk7XG5cdFx0XHR9IGVsc2UgaWYgKHRoaXMuc2Vzc2lvbi5pc0Jhc2hSdW5uaW5nKSB7XG5cdFx0XHRcdHRoaXMuc2Vzc2lvbi5hYm9ydEJhc2goKTtcblx0XHRcdH0gZWxzZSBpZiAodGhpcy5pc0Jhc2hNb2RlKSB7XG5cdFx0XHRcdHRoaXMuZWRpdG9yLnNldFRleHQoXCJcIik7XG5cdFx0XHRcdHRoaXMucGVuZGluZ0ltYWdlcy5sZW5ndGggPSAwO1xuXHRcdFx0XHR0aGlzLmlzQmFzaE1vZGUgPSBmYWxzZTtcblx0XHRcdFx0dGhpcy51cGRhdGVFZGl0b3JCb3JkZXJDb2xvcigpO1xuXHRcdFx0fSBlbHNlIGlmICghdGhpcy5lZGl0b3IuZ2V0VGV4dCgpLnRyaW0oKSkge1xuXHRcdFx0XHQvLyBEb3VibGUtZXNjYXBlIHdpdGggZW1wdHkgZWRpdG9yIHRyaWdnZXJzIC90cmVlLCAvZm9yaywgb3Igbm90aGluZyBiYXNlZCBvbiBzZXR0aW5nXG5cdFx0XHRcdGNvbnN0IGFjdGlvbiA9IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldERvdWJsZUVzY2FwZUFjdGlvbigpO1xuXHRcdFx0XHRpZiAoYWN0aW9uICE9PSBcIm5vbmVcIikge1xuXHRcdFx0XHRcdGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cdFx0XHRcdFx0aWYgKG5vdyAtIHRoaXMubGFzdEVzY2FwZVRpbWUgPCA1MDApIHtcblx0XHRcdFx0XHRcdGlmIChhY3Rpb24gPT09IFwidHJlZVwiKSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMuc2hvd1RyZWVTZWxlY3RvcigpO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0dGhpcy5zaG93VXNlck1lc3NhZ2VTZWxlY3RvcigpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0dGhpcy5sYXN0RXNjYXBlVGltZSA9IDA7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHRoaXMubGFzdEVzY2FwZVRpbWUgPSBub3c7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fTtcblxuXHRcdC8vIFJlZ2lzdGVyIGFwcCBhY3Rpb24gaGFuZGxlcnNcblx0XHR0aGlzLmRlZmF1bHRFZGl0b3Iub25BY3Rpb24oXCJjbGVhclwiLCAoKSA9PiB0aGlzLmhhbmRsZUN0cmxDKCkpO1xuXHRcdHRoaXMuZGVmYXVsdEVkaXRvci5vbkN0cmxEID0gKCkgPT4gdGhpcy5oYW5kbGVDdHJsRCgpO1xuXHRcdHRoaXMuZGVmYXVsdEVkaXRvci5vbkFjdGlvbihcInN1c3BlbmRcIiwgKCkgPT4gdGhpcy5oYW5kbGVDdHJsWigpKTtcblx0XHR0aGlzLmRlZmF1bHRFZGl0b3Iub25BY3Rpb24oXCJjeWNsZVRoaW5raW5nTGV2ZWxcIiwgKCkgPT4gdGhpcy5jeWNsZVRoaW5raW5nTGV2ZWwoKSk7XG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uQWN0aW9uKFwiY3ljbGVNb2RlbEZvcndhcmRcIiwgKCkgPT4gdGhpcy5jeWNsZU1vZGVsKFwiZm9yd2FyZFwiKSk7XG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uQWN0aW9uKFwiY3ljbGVNb2RlbEJhY2t3YXJkXCIsICgpID0+IHRoaXMuY3ljbGVNb2RlbChcImJhY2t3YXJkXCIpKTtcblxuXHRcdC8vIEdsb2JhbCBkZWJ1ZyBoYW5kbGVyIG9uIFRVSSAod29ya3MgcmVnYXJkbGVzcyBvZiBmb2N1cylcblx0XHR0aGlzLnVpLm9uRGVidWcgPSAoKSA9PiB0aGlzLmhhbmRsZURlYnVnQ29tbWFuZCgpO1xuXHRcdHRoaXMuZGVmYXVsdEVkaXRvci5vbkFjdGlvbihcInNlbGVjdE1vZGVsXCIsICgpID0+IHRoaXMuc2hvd01vZGVsU2VsZWN0b3IoKSk7XG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uQWN0aW9uKFwiZXhwYW5kVG9vbHNcIiwgKCkgPT4gdGhpcy50b2dnbGVUb29sT3V0cHV0RXhwYW5zaW9uKCkpO1xuXHRcdHRoaXMuZGVmYXVsdEVkaXRvci5vbkFjdGlvbihcInRvZ2dsZVRoaW5raW5nXCIsICgpID0+IHRoaXMudG9nZ2xlVGhpbmtpbmdCbG9ja1Zpc2liaWxpdHkoKSk7XG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uQWN0aW9uKFwiZXh0ZXJuYWxFZGl0b3JcIiwgKCkgPT4gdGhpcy5vcGVuRXh0ZXJuYWxFZGl0b3IoKSk7XG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uQWN0aW9uKFwiZm9sbG93VXBcIiwgKCkgPT4gdGhpcy5oYW5kbGVGb2xsb3dVcCgpKTtcblx0XHR0aGlzLmRlZmF1bHRFZGl0b3Iub25BY3Rpb24oXCJkZXF1ZXVlXCIsICgpID0+IHRoaXMuaGFuZGxlRGVxdWV1ZSgpKTtcblx0XHR0aGlzLmRlZmF1bHRFZGl0b3Iub25BY3Rpb24oXCJuZXdTZXNzaW9uXCIsICgpID0+IHRoaXMuaGFuZGxlQ2xlYXJDb21tYW5kKCkpO1xuXHRcdHRoaXMuZGVmYXVsdEVkaXRvci5vbkFjdGlvbihcInRyZWVcIiwgKCkgPT4gdGhpcy5zaG93VHJlZVNlbGVjdG9yKCkpO1xuXHRcdHRoaXMuZGVmYXVsdEVkaXRvci5vbkFjdGlvbihcImZvcmtcIiwgKCkgPT4gdGhpcy5zaG93VXNlck1lc3NhZ2VTZWxlY3RvcigpKTtcblx0XHR0aGlzLmRlZmF1bHRFZGl0b3Iub25BY3Rpb24oXCJyZXN1bWVcIiwgKCkgPT4gdGhpcy5zaG93U2Vzc2lvblNlbGVjdG9yKCkpO1xuXG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uQ2hhbmdlID0gKHRleHQ6IHN0cmluZykgPT4ge1xuXHRcdFx0Y29uc3Qgd2FzQmFzaE1vZGUgPSB0aGlzLmlzQmFzaE1vZGU7XG5cdFx0XHR0aGlzLmlzQmFzaE1vZGUgPSB0ZXh0LnRyaW1TdGFydCgpLnN0YXJ0c1dpdGgoXCIhXCIpO1xuXHRcdFx0aWYgKHdhc0Jhc2hNb2RlICE9PSB0aGlzLmlzQmFzaE1vZGUpIHtcblx0XHRcdFx0dGhpcy51cGRhdGVFZGl0b3JCb3JkZXJDb2xvcigpO1xuXHRcdFx0fVxuXHRcdH07XG5cblx0XHQvLyBIYW5kbGUgY2xpcGJvYXJkIGltYWdlIHBhc3RlICh0cmlnZ2VyZWQgb24gQ3RybCtWKVxuXHRcdHRoaXMuZGVmYXVsdEVkaXRvci5vblBhc3RlSW1hZ2UgPSAoKSA9PiB7XG5cdFx0XHR0aGlzLmhhbmRsZUNsaXBib2FyZEltYWdlUGFzdGUoKTtcblx0XHR9O1xuXG5cdFx0Ly8gSGFuZGxlIGltYWdlIGZpbGUgcGF0aHMgcGFzdGVkIHZpYSB0ZXJtaW5hbCBlbXVsYXRvciAoZS5nLiBpVGVybTIpLlxuXHRcdC8vIFNldCBvbiBkZWZhdWx0RWRpdG9yIGhlcmU7IHNldEN1c3RvbUVkaXRvckNvbXBvbmVudCBndWFyZHMgcmUtYXNzaWdubWVudCBmb3IgY3VzdG9tIGVkaXRvcnMuXG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uUGFzdGVJbWFnZVBhdGggPSAoZmlsZVBhdGg6IHN0cmluZykgPT4ge1xuXHRcdFx0dGhpcy5oYW5kbGVQYXN0ZWRJbWFnZVBhdGgoZmlsZVBhdGgpO1xuXHRcdH07XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGhhbmRsZUNsaXBib2FyZEltYWdlUGFzdGUoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGltYWdlID0gYXdhaXQgcmVhZENsaXBib2FyZEltYWdlKCk7XG5cdFx0XHRpZiAoIWltYWdlKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Ly8gU3RvcmUgaW1hZ2UgYXMgYmFzZTY0IEltYWdlQ29udGVudCBmb3Igc2VuZGluZyB3aXRoIHRoZSBwcm9tcHRcblx0XHRcdGNvbnN0IGltYWdlQ29udGVudDogSW1hZ2VDb250ZW50ID0ge1xuXHRcdFx0XHR0eXBlOiBcImltYWdlXCIsXG5cdFx0XHRcdGRhdGE6IEJ1ZmZlci5mcm9tKGltYWdlLmJ5dGVzKS50b1N0cmluZyhcImJhc2U2NFwiKSxcblx0XHRcdFx0bWltZVR5cGU6IGltYWdlLm1pbWVUeXBlLFxuXHRcdFx0fTtcblx0XHRcdHRoaXMucGVuZGluZ0ltYWdlcy5wdXNoKGltYWdlQ29udGVudCk7XG5cblx0XHRcdC8vIEluc2VydCBmcmllbmRseSBwbGFjZWhvbGRlciBpbnN0ZWFkIG9mIGZpbGUgcGF0aFxuXHRcdFx0Y29uc3QgaW1hZ2VOdW0gPSB0aGlzLnBlbmRpbmdJbWFnZXMubGVuZ3RoO1xuXHRcdFx0dGhpcy5lZGl0b3IuaW5zZXJ0VGV4dEF0Q3Vyc29yPy4oYFtJbWFnZSAjJHtpbWFnZU51bX1dYCk7XG5cdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIFNpbGVudGx5IGlnbm9yZSBjbGlwYm9hcmQgZXJyb3JzIChtYXkgbm90IGhhdmUgcGVybWlzc2lvbiwgZXRjLilcblx0XHR9XG5cdH1cblxuXHQvLyBNSU1FIHR5cGVzIHJlc3RyaWN0ZWQgdG8gZm9ybWF0cyBjb21tb25seSBhY2NlcHRlZCBieSBBSSB2aXNpb24gQVBJcy5cblx0Ly8gU1ZHIGlzIGV4Y2x1ZGVkIFx1MjAxNCBpdCBpcyBYTUwvSlMtYmVhcmluZyBhbmQgbm90IHNhZmUgdG8gZm9yd2FyZCBhcyBpbWFnZSBjb250ZW50LlxuXHQvLyBUSUZGL0hFSUMvSEVJRi9BVklGIGFyZSBleGNsdWRlZCBmb3IgY29tcGF0aWJpbGl0eTsgdXNlcnMgY2FuIGNvbnZlcnQgYmVmb3JlIHBhc3RpbmcuXG5cdHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IE1JTUVfQllfRVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuXHRcdHBuZzogXCJpbWFnZS9wbmdcIixcblx0XHRqcGc6IFwiaW1hZ2UvanBlZ1wiLFxuXHRcdGpwZWc6IFwiaW1hZ2UvanBlZ1wiLFxuXHRcdGdpZjogXCJpbWFnZS9naWZcIixcblx0XHR3ZWJwOiBcImltYWdlL3dlYnBcIixcblx0fTtcblxuXHQvLyBNYWdpYy1ieXRlIHNpZ25hdHVyZXMgdXNlZCB0byB2ZXJpZnkgZmlsZSBjb250ZW50IG1hdGNoZXMgaXRzIGV4dGVuc2lvbixcblx0Ly8gcHJldmVudGluZyBhcmJpdHJhcnktZmlsZS1yZWFkIHZpYSBjcmFmdGVkIHBhc3RlIG9mIGUuZy4gXCIvZXRjL3Bhc3N3ZC5wbmdcIi5cblx0cHJpdmF0ZSBzdGF0aWMgbWF0Y2hlc0ltYWdlU2lnbmF0dXJlKGJ1ZjogQnVmZmVyLCBtaW1lVHlwZTogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0aWYgKGJ1Zi5sZW5ndGggPCAxMikgcmV0dXJuIGZhbHNlO1xuXHRcdHN3aXRjaCAobWltZVR5cGUpIHtcblx0XHRcdGNhc2UgXCJpbWFnZS9wbmdcIjpcblx0XHRcdFx0cmV0dXJuIGJ1ZlswXSA9PT0gMHg4OSAmJiBidWZbMV0gPT09IDB4NTAgJiYgYnVmWzJdID09PSAweDRlICYmIGJ1ZlszXSA9PT0gMHg0Nztcblx0XHRcdGNhc2UgXCJpbWFnZS9qcGVnXCI6XG5cdFx0XHRcdHJldHVybiBidWZbMF0gPT09IDB4ZmYgJiYgYnVmWzFdID09PSAweGQ4ICYmIGJ1ZlsyXSA9PT0gMHhmZjtcblx0XHRcdGNhc2UgXCJpbWFnZS9naWZcIjpcblx0XHRcdFx0cmV0dXJuIChcblx0XHRcdFx0XHRidWZbMF0gPT09IDB4NDcgJiYgYnVmWzFdID09PSAweDQ5ICYmIGJ1ZlsyXSA9PT0gMHg0NiAmJiBidWZbM10gPT09IDB4MzggJiZcblx0XHRcdFx0XHQoYnVmWzRdID09PSAweDM3IHx8IGJ1Zls0XSA9PT0gMHgzOSkgJiYgYnVmWzVdID09PSAweDYxXG5cdFx0XHRcdCk7XG5cdFx0XHRjYXNlIFwiaW1hZ2Uvd2VicFwiOlxuXHRcdFx0XHRyZXR1cm4gKFxuXHRcdFx0XHRcdGJ1ZlswXSA9PT0gMHg1MiAmJiBidWZbMV0gPT09IDB4NDkgJiYgYnVmWzJdID09PSAweDQ2ICYmIGJ1ZlszXSA9PT0gMHg0NiAmJlxuXHRcdFx0XHRcdGJ1Zls4XSA9PT0gMHg1NyAmJiBidWZbOV0gPT09IDB4NDUgJiYgYnVmWzEwXSA9PT0gMHg0MiAmJiBidWZbMTFdID09PSAweDUwXG5cdFx0XHRcdCk7XG5cdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVQYXN0ZWRJbWFnZVBhdGgoZmlsZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBleHQgPSBwYXRoLmV4dG5hbWUoZmlsZVBhdGgpLnNsaWNlKDEpLnRvTG93ZXJDYXNlKCk7XG5cdFx0XHRjb25zdCBtaW1lVHlwZSA9IEludGVyYWN0aXZlTW9kZS5NSU1FX0JZX0VYVFtleHRdO1xuXHRcdFx0aWYgKCFtaW1lVHlwZSkge1xuXHRcdFx0XHQvLyBVbnN1cHBvcnRlZCAvIHVuc2FmZSBleHRlbnNpb24gXHUyMDE0IGZhbGwgYmFjayB0byBpbnNlcnRpbmcgcmF3IHBhdGguXG5cdFx0XHRcdHRoaXMuZWRpdG9yLmluc2VydFRleHRBdEN1cnNvcj8uKGZpbGVQYXRoKTtcblx0XHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Ly8gUmVqZWN0IHN5bWxpbmtzIHRvIHByZXZlbnQgcmVhZGluZyBzZW5zaXRpdmUgZmlsZXMgdmlhIGEgc3ltbGlua2VkXG5cdFx0XHQvLyBgLnBuZ2AgdGhhdCBwb2ludHMgYXQgZS5nLiB+Ly5zc2gvaWRfcnNhLlxuXHRcdFx0Y29uc3QgbHN0ID0gZnMubHN0YXRTeW5jKGZpbGVQYXRoKTtcblx0XHRcdGlmICghbHN0LmlzRmlsZSgpKSB7XG5cdFx0XHRcdHRoaXMuZWRpdG9yLmluc2VydFRleHRBdEN1cnNvcj8uKGZpbGVQYXRoKTtcblx0XHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZGF0YSA9IGZzLnJlYWRGaWxlU3luYyhmaWxlUGF0aCk7XG5cblx0XHRcdC8vIE1hZ2ljLWJ5dGUgY2hlY2sgXHUyMDE0IGNvbmZpcm1zIGZpbGUgY29udGVudCBhY3R1YWxseSBtYXRjaGVzIHRoZVxuXHRcdFx0Ly8gZXh0ZW5zaW9uIGJlZm9yZSB3ZSBmb3J3YXJkIGJ5dGVzIHRvIGEgbW9kZWwuXG5cdFx0XHRpZiAoIUludGVyYWN0aXZlTW9kZS5tYXRjaGVzSW1hZ2VTaWduYXR1cmUoZGF0YSwgbWltZVR5cGUpKSB7XG5cdFx0XHRcdHRoaXMuZWRpdG9yLmluc2VydFRleHRBdEN1cnNvcj8uKGZpbGVQYXRoKTtcblx0XHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0dGhpcy5wZW5kaW5nSW1hZ2VzLnB1c2goe1xuXHRcdFx0XHR0eXBlOiBcImltYWdlXCIsXG5cdFx0XHRcdGRhdGE6IGRhdGEudG9TdHJpbmcoXCJiYXNlNjRcIiksXG5cdFx0XHRcdG1pbWVUeXBlLFxuXHRcdFx0fSk7XG5cblx0XHRcdGNvbnN0IGltYWdlTnVtID0gdGhpcy5wZW5kaW5nSW1hZ2VzLmxlbmd0aDtcblx0XHRcdHRoaXMuZWRpdG9yLmluc2VydFRleHRBdEN1cnNvcj8uKGBbSW1hZ2UgIyR7aW1hZ2VOdW19XWApO1xuXHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBGYWxsIGJhY2sgdG8gaW5zZXJ0aW5nIHRoZSByYXcgcGF0aCBpZiBmaWxlIGNhbid0IGJlIHJlYWRcblx0XHRcdHRoaXMuZWRpdG9yLmluc2VydFRleHRBdEN1cnNvcj8uKGZpbGVQYXRoKTtcblx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgZ2V0U2xhc2hDb21tYW5kQ29udGV4dCgpOiBTbGFzaENvbW1hbmRDb250ZXh0IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0c2Vzc2lvbjogdGhpcy5zZXNzaW9uLFxuXHRcdFx0dWk6IHRoaXMudWksXG5cdFx0XHRrZXliaW5kaW5nczogdGhpcy5rZXliaW5kaW5ncyxcblx0XHRcdGNoYXRDb250YWluZXI6IHRoaXMuY2hhdENvbnRhaW5lcixcblx0XHRcdHN0YXR1c0NvbnRhaW5lcjogdGhpcy5zdGF0dXNDb250YWluZXIsXG5cdFx0XHRlZGl0b3JDb250YWluZXI6IHRoaXMuZWRpdG9yQ29udGFpbmVyLFxuXHRcdFx0aGVhZGVyQ29udGFpbmVyOiB0aGlzLmhlYWRlckNvbnRhaW5lcixcblx0XHRcdHBlbmRpbmdNZXNzYWdlc0NvbnRhaW5lcjogdGhpcy5wZW5kaW5nTWVzc2FnZXNDb250YWluZXIsXG5cdFx0XHRlZGl0b3I6IHRoaXMuZWRpdG9yLFxuXHRcdFx0ZGVmYXVsdEVkaXRvcjogdGhpcy5kZWZhdWx0RWRpdG9yLFxuXHRcdFx0c2Vzc2lvbk1hbmFnZXI6IHRoaXMuc2Vzc2lvbk1hbmFnZXIsXG5cdFx0XHRzZXR0aW5nc01hbmFnZXI6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLFxuXHRcdFx0aW52YWxpZGF0ZUZvb3RlcjogKCkgPT4gdGhpcy5mb290ZXIuaW52YWxpZGF0ZSgpLFxuXHRcdFx0c2hvd1N0YXR1czogKG1zZykgPT4gdGhpcy5zaG93U3RhdHVzKG1zZyksXG5cdFx0XHRzaG93RXJyb3I6IChtc2cpID0+IHRoaXMuc2hvd0Vycm9yKG1zZyksXG5cdFx0XHRzaG93V2FybmluZzogKG1zZykgPT4gdGhpcy5zaG93V2FybmluZyhtc2cpLFxuXHRcdFx0c2hvd1NlbGVjdG9yOiAoY3JlYXRlKSA9PiB0aGlzLnNob3dTZWxlY3RvcihjcmVhdGUpLFxuXHRcdFx0dXBkYXRlRWRpdG9yQm9yZGVyQ29sb3I6ICgpID0+IHRoaXMudXBkYXRlRWRpdG9yQm9yZGVyQ29sb3IoKSxcblx0XHRcdGdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3M6ICgpID0+IHRoaXMuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncygpLFxuXHRcdFx0cmVxdWVzdFJlbmRlcjogKCkgPT4gdGhpcy51aS5yZXF1ZXN0UmVuZGVyKCksXG5cdFx0XHR1cGRhdGVUZXJtaW5hbFRpdGxlOiAoKSA9PiB0aGlzLnVwZGF0ZVRlcm1pbmFsVGl0bGUoKSxcblx0XHRcdHNob3dTZXR0aW5nc1NlbGVjdG9yOiAoKSA9PiB0aGlzLnNob3dTZXR0aW5nc1NlbGVjdG9yKCksXG5cdFx0XHRzaG93TW9kZWxzU2VsZWN0b3I6ICgpID0+IHRoaXMuc2hvd01vZGVsc1NlbGVjdG9yKCksXG5cdFx0XHRoYW5kbGVNb2RlbENvbW1hbmQ6IChzZWFyY2hUZXJtKSA9PiB0aGlzLmhhbmRsZU1vZGVsQ29tbWFuZChzZWFyY2hUZXJtKSxcblx0XHRcdHNob3dVc2VyTWVzc2FnZVNlbGVjdG9yOiAoKSA9PiB0aGlzLnNob3dVc2VyTWVzc2FnZVNlbGVjdG9yKCksXG5cdFx0XHRzaG93VHJlZVNlbGVjdG9yOiAoKSA9PiB0aGlzLnNob3dUcmVlU2VsZWN0b3IoKSxcblx0XHRcdHNob3dQcm92aWRlck1hbmFnZXI6ICgpID0+IHRoaXMuc2hvd1Byb3ZpZGVyTWFuYWdlcigpLFxuXHRcdFx0c2hvd09BdXRoU2VsZWN0b3I6IChtb2RlKSA9PiB0aGlzLnNob3dPQXV0aFNlbGVjdG9yKG1vZGUpLFxuXHRcdFx0c2hvd1Nlc3Npb25TZWxlY3RvcjogKCkgPT4gdGhpcy5zaG93U2Vzc2lvblNlbGVjdG9yKCksXG5cdFx0XHRoYW5kbGVDbGVhckNvbW1hbmQ6ICgpID0+IHRoaXMuaGFuZGxlQ2xlYXJDb21tYW5kKCksXG5cdFx0XHRoYW5kbGVSZWxvYWRDb21tYW5kOiAoKSA9PiB0aGlzLmhhbmRsZVJlbG9hZENvbW1hbmQoKSxcblx0XHRcdGhhbmRsZURlYnVnQ29tbWFuZDogKCkgPT4gdGhpcy5oYW5kbGVEZWJ1Z0NvbW1hbmQoKSxcblx0XHRcdHNodXRkb3duOiAoKSA9PiB0aGlzLnNodXRkb3duKCksXG5cdFx0XHRleGVjdXRlQ29tcGFjdGlvbjogKGluc3RydWN0aW9ucywgaXNBdXRvKSA9PiB0aGlzLmV4ZWN1dGVDb21wYWN0aW9uKGluc3RydWN0aW9ucywgaXNBdXRvKSxcblx0XHRcdGhhbmRsZUJhc2hDb21tYW5kOiAoY29tbWFuZCwgb3B0aW9ucykgPT4gdGhpcy5oYW5kbGVCYXNoQ29tbWFuZChjb21tYW5kLCBvcHRpb25zPy5leGNsdWRlRnJvbUNvbnRleHQsIG9wdGlvbnM/LmRpc3BsYXlDb21tYW5kLCBvcHRpb25zPy5sb2dpblNoZWxsKSxcblx0XHR9O1xuXHR9XG5cblx0cHJpdmF0ZSBzZXR1cEVkaXRvclN1Ym1pdEhhbmRsZXIoKTogdm9pZCB7XG5cdFx0c2V0dXBFZGl0b3JTdWJtaXRIYW5kbGVyQ29udHJvbGxlcih0aGlzIGFzIGFueSk7XG5cdH1cblxuXHRwcml2YXRlIHN1YnNjcmliZVRvQWdlbnQoKTogdm9pZCB7XG5cdFx0bGV0IGV2ZW50UXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblx0XHR0aGlzLnVuc3Vic2NyaWJlID0gdGhpcy5zZXNzaW9uLnN1YnNjcmliZSgoZXZlbnQpID0+IHtcblx0XHRcdGV2ZW50UXVldWUgPSBldmVudFF1ZXVlLnRoZW4oKCkgPT4gdGhpcy5oYW5kbGVFdmVudChldmVudCkpLmNhdGNoKCgpID0+IHt9KTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgaGFuZGxlRXZlbnQoZXZlbnQ6IEFnZW50U2Vzc2lvbkV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgaGFuZGxlQWdlbnRFdmVudCh0aGlzIGFzIGFueSwgZXZlbnQpO1xuXHR9XG5cblx0LyoqIEV4dHJhY3QgdGV4dCBjb250ZW50IGZyb20gYSB1c2VyIG1lc3NhZ2UgKi9cblx0cHJpdmF0ZSBnZXRVc2VyTWVzc2FnZVRleHQobWVzc2FnZTogTWVzc2FnZSk6IHN0cmluZyB7XG5cdFx0aWYgKG1lc3NhZ2Uucm9sZSAhPT0gXCJ1c2VyXCIpIHJldHVybiBcIlwiO1xuXHRcdGNvbnN0IHRleHRCbG9ja3MgPVxuXHRcdFx0dHlwZW9mIG1lc3NhZ2UuY29udGVudCA9PT0gXCJzdHJpbmdcIlxuXHRcdFx0XHQ/IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBtZXNzYWdlLmNvbnRlbnQgfV1cblx0XHRcdFx0OiBtZXNzYWdlLmNvbnRlbnQuZmlsdGVyKChjOiB7IHR5cGU6IHN0cmluZyB9KSA9PiBjLnR5cGUgPT09IFwidGV4dFwiKTtcblx0XHRyZXR1cm4gdGV4dEJsb2Nrcy5tYXAoKGMpID0+IChjIGFzIHsgdGV4dDogc3RyaW5nIH0pLnRleHQpLmpvaW4oXCJcIik7XG5cdH1cblxuXHQvKipcblx0ICogU2hvdyBhIHN0YXR1cyBtZXNzYWdlIGluIHRoZSBjaGF0LlxuXHQgKlxuXHQgKiBJZiBtdWx0aXBsZSBzdGF0dXMgbWVzc2FnZXMgYXJlIGVtaXR0ZWQgYmFjay10by1iYWNrICh3aXRob3V0IGFueXRoaW5nIGVsc2UgYmVpbmcgYWRkZWQgdG8gdGhlIGNoYXQpLFxuXHQgKiB3ZSB1cGRhdGUgdGhlIHByZXZpb3VzIHN0YXR1cyBsaW5lIGluc3RlYWQgb2YgYXBwZW5kaW5nIG5ldyBvbmVzIHRvIGF2b2lkIGxvZyBzcGFtLlxuXHQgKi9cblx0cHJpdmF0ZSBzaG93U3RhdHVzKG1lc3NhZ2U6IHN0cmluZywgb3B0aW9ucz86IHsgYXBwZW5kPzogYm9vbGVhbiB9KTogdm9pZCB7XG5cdFx0Y29uc3QgYXBwZW5kID0gb3B0aW9ucz8uYXBwZW5kID8/IGZhbHNlO1xuXHRcdGNvbnN0IGNoaWxkcmVuID0gdGhpcy5jaGF0Q29udGFpbmVyLmNoaWxkcmVuO1xuXHRcdGNvbnN0IGxhc3QgPSBjaGlsZHJlbi5sZW5ndGggPiAwID8gY2hpbGRyZW5bY2hpbGRyZW4ubGVuZ3RoIC0gMV0gOiB1bmRlZmluZWQ7XG5cdFx0Y29uc3Qgc2Vjb25kTGFzdCA9IGNoaWxkcmVuLmxlbmd0aCA+IDEgPyBjaGlsZHJlbltjaGlsZHJlbi5sZW5ndGggLSAyXSA6IHVuZGVmaW5lZDtcblxuXHRcdGlmICghYXBwZW5kICYmIGxhc3QgJiYgc2Vjb25kTGFzdCAmJiBsYXN0ID09PSB0aGlzLmxhc3RTdGF0dXNUZXh0ICYmIHNlY29uZExhc3QgPT09IHRoaXMubGFzdFN0YXR1c1NwYWNlcikge1xuXHRcdFx0dGhpcy5sYXN0U3RhdHVzVGV4dC5zZXRUZXh0KHRoZW1lLmZnKFwiZGltXCIsIG1lc3NhZ2UpKTtcblx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHNwYWNlciA9IG5ldyBTcGFjZXIoMSk7XG5cdFx0Y29uc3QgdGV4dCA9IG5ldyBUZXh0KHRoZW1lLmZnKFwiZGltXCIsIG1lc3NhZ2UpLCAxLCAwKTtcblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQoc3BhY2VyKTtcblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQodGV4dCk7XG5cdFx0dGhpcy5sYXN0U3RhdHVzU3BhY2VyID0gc3BhY2VyO1xuXHRcdHRoaXMubGFzdFN0YXR1c1RleHQgPSB0ZXh0O1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0cHJpdmF0ZSBhZGRNZXNzYWdlVG9DaGF0KG1lc3NhZ2U6IEFnZW50TWVzc2FnZSwgb3B0aW9ucz86IHsgcG9wdWxhdGVIaXN0b3J5PzogYm9vbGVhbiB9KTogdm9pZCB7XG5cdFx0Y29uc3QgdGltZXN0YW1wRm9ybWF0ID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0VGltZXN0YW1wRm9ybWF0KCk7XG5cdFx0c3dpdGNoIChtZXNzYWdlLnJvbGUpIHtcblx0XHRcdGNhc2UgXCJiYXNoRXhlY3V0aW9uXCI6IHtcblx0XHRcdFx0Y29uc3QgY29tcG9uZW50ID0gbmV3IEJhc2hFeGVjdXRpb25Db21wb25lbnQobWVzc2FnZS5jb21tYW5kLCB0aGlzLnVpLCBtZXNzYWdlLmV4Y2x1ZGVGcm9tQ29udGV4dCk7XG5cdFx0XHRcdGlmIChtZXNzYWdlLm91dHB1dCkge1xuXHRcdFx0XHRcdGNvbXBvbmVudC5hcHBlbmRPdXRwdXQobWVzc2FnZS5vdXRwdXQpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbXBvbmVudC5zZXRDb21wbGV0ZShcblx0XHRcdFx0XHRtZXNzYWdlLmV4aXRDb2RlLFxuXHRcdFx0XHRcdG1lc3NhZ2UuY2FuY2VsbGVkLFxuXHRcdFx0XHRcdG1lc3NhZ2UudHJ1bmNhdGVkID8gKHsgdHJ1bmNhdGVkOiB0cnVlIH0gYXMgVHJ1bmNhdGlvblJlc3VsdCkgOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0bWVzc2FnZS5mdWxsT3V0cHV0UGF0aCxcblx0XHRcdFx0KTtcblx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKGNvbXBvbmVudCk7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0Y2FzZSBcImN1c3RvbVwiOiB7XG5cdFx0XHRcdGlmIChtZXNzYWdlLmRpc3BsYXkpIHtcblx0XHRcdFx0XHRjb25zdCByZW5kZXJlciA9IHRoaXMuc2Vzc2lvbi5leHRlbnNpb25SdW5uZXI/LmdldE1lc3NhZ2VSZW5kZXJlcihtZXNzYWdlLmN1c3RvbVR5cGUpO1xuXHRcdFx0XHRcdGNvbnN0IGNvbXBvbmVudCA9IG5ldyBDdXN0b21NZXNzYWdlQ29tcG9uZW50KG1lc3NhZ2UsIHJlbmRlcmVyLCB0aGlzLmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MoKSk7XG5cdFx0XHRcdFx0Y29tcG9uZW50LnNldEV4cGFuZGVkKHRoaXMudG9vbE91dHB1dEV4cGFuZGVkKTtcblx0XHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQoY29tcG9uZW50KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJjb21wYWN0aW9uU3VtbWFyeVwiOiB7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdFx0Y29uc3QgY29tcG9uZW50ID0gbmV3IENvbXBhY3Rpb25TdW1tYXJ5TWVzc2FnZUNvbXBvbmVudChtZXNzYWdlLCB0aGlzLmdldE1hcmtkb3duVGhlbWVXaXRoU2V0dGluZ3MoKSk7XG5cdFx0XHRcdGNvbXBvbmVudC5zZXRFeHBhbmRlZCh0aGlzLnRvb2xPdXRwdXRFeHBhbmRlZCk7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChjb21wb25lbnQpO1xuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJicmFuY2hTdW1tYXJ5XCI6IHtcblx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0XHRjb25zdCBjb21wb25lbnQgPSBuZXcgQnJhbmNoU3VtbWFyeU1lc3NhZ2VDb21wb25lbnQobWVzc2FnZSwgdGhpcy5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzKCkpO1xuXHRcdFx0XHRjb21wb25lbnQuc2V0RXhwYW5kZWQodGhpcy50b29sT3V0cHV0RXhwYW5kZWQpO1xuXHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQoY29tcG9uZW50KTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwidXNlclwiOiB7XG5cdFx0XHRcdGNvbnN0IHRleHRDb250ZW50ID0gdGhpcy5nZXRVc2VyTWVzc2FnZVRleHQobWVzc2FnZSk7XG5cdFx0XHRcdGlmICh0ZXh0Q29udGVudCkge1xuXHRcdFx0XHRcdGNvbnN0IHNraWxsQmxvY2sgPSBwYXJzZVNraWxsQmxvY2sodGV4dENvbnRlbnQpO1xuXHRcdFx0XHRcdGlmIChza2lsbEJsb2NrKSB7XG5cdFx0XHRcdFx0XHQvLyBSZW5kZXIgc2tpbGwgYmxvY2sgKGNvbGxhcHNpYmxlKVxuXHRcdFx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0XHRcdFx0Y29uc3QgY29tcG9uZW50ID0gbmV3IFNraWxsSW52b2NhdGlvbk1lc3NhZ2VDb21wb25lbnQoXG5cdFx0XHRcdFx0XHRcdHNraWxsQmxvY2ssXG5cdFx0XHRcdFx0XHRcdHRoaXMuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncygpLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdGNvbXBvbmVudC5zZXRFeHBhbmRlZCh0aGlzLnRvb2xPdXRwdXRFeHBhbmRlZCk7XG5cdFx0XHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQoY29tcG9uZW50KTtcblx0XHRcdFx0XHRcdC8vIFJlbmRlciB1c2VyIG1lc3NhZ2Ugc2VwYXJhdGVseSBpZiBwcmVzZW50XG5cdFx0XHRcdFx0XHRpZiAoc2tpbGxCbG9jay51c2VyTWVzc2FnZSkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCB1c2VyQ29tcG9uZW50ID0gbmV3IFVzZXJNZXNzYWdlQ29tcG9uZW50KFxuXHRcdFx0XHRcdFx0XHRcdHNraWxsQmxvY2sudXNlck1lc3NhZ2UsXG5cdFx0XHRcdFx0XHRcdFx0dGhpcy5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzKCksXG5cdFx0XHRcdFx0XHRcdFx0bWVzc2FnZS50aW1lc3RhbXAsXG5cdFx0XHRcdFx0XHRcdFx0dGltZXN0YW1wRm9ybWF0LFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQodXNlckNvbXBvbmVudCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdGNvbnN0IHVzZXJDb21wb25lbnQgPSBuZXcgVXNlck1lc3NhZ2VDb21wb25lbnQodGV4dENvbnRlbnQsIHRoaXMuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncygpLCBtZXNzYWdlLnRpbWVzdGFtcCwgdGltZXN0YW1wRm9ybWF0KTtcblx0XHRcdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZCh1c2VyQ29tcG9uZW50KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0aWYgKG9wdGlvbnM/LnBvcHVsYXRlSGlzdG9yeSkge1xuXHRcdFx0XHRcdFx0dGhpcy5lZGl0b3IuYWRkVG9IaXN0b3J5Py4odGV4dENvbnRlbnQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdGNhc2UgXCJhc3Npc3RhbnRcIjoge1xuXHRcdFx0XHRjb25zdCBhc3Npc3RhbnRDb21wb25lbnQgPSBuZXcgQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudChcblx0XHRcdFx0XHRtZXNzYWdlLFxuXHRcdFx0XHRcdHRoaXMuaGlkZVRoaW5raW5nQmxvY2ssXG5cdFx0XHRcdFx0dGhpcy5nZXRNYXJrZG93blRoZW1lV2l0aFNldHRpbmdzKCksXG5cdFx0XHRcdFx0dGltZXN0YW1wRm9ybWF0LFxuXHRcdFx0XHQpO1xuXHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQoYXNzaXN0YW50Q29tcG9uZW50KTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0XHRjYXNlIFwidG9vbFJlc3VsdFwiOiB7XG5cdFx0XHRcdC8vIFRvb2wgcmVzdWx0cyBhcmUgcmVuZGVyZWQgaW5saW5lIHdpdGggdG9vbCBjYWxscywgaGFuZGxlZCBzZXBhcmF0ZWx5XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0ZGVmYXVsdDoge1xuXHRcdFx0XHRjb25zdCBfZXhoYXVzdGl2ZTogbmV2ZXIgPSBtZXNzYWdlO1xuXHRcdFx0fVxuXHRcdH1cblx0XHR0aGlzLnRyaW1DaGF0SGlzdG9yeSgpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlbW92ZSBvbGRlc3QgY29tcG9uZW50cyB3aGVuIGNoYXQgZXhjZWVkcyBNQVhfQ0hBVF9DT01QT05FTlRTLlxuXHQgKiBPbmx5IHJlbmRlci1jb21wb25lbnRzIGFyZSByZW1vdmVkIFx1MjAxNCBzZXNzaW9uIGRhdGEgc3RheXMgaW4gU2Vzc2lvbk1hbmFnZXIuXG5cdCAqL1xuXHRwcml2YXRlIHRyaW1DaGF0SGlzdG9yeSgpOiB2b2lkIHtcblx0XHR3aGlsZSAodGhpcy5jaGF0Q29udGFpbmVyLmNoaWxkcmVuLmxlbmd0aCA+IEludGVyYWN0aXZlTW9kZS5NQVhfQ0hBVF9DT01QT05FTlRTKSB7XG5cdFx0XHRjb25zdCBvbGRlc3QgPSB0aGlzLmNoYXRDb250YWluZXIuY2hpbGRyZW5bMF07XG5cdFx0XHR0aGlzLmNoYXRDb250YWluZXIucmVtb3ZlQ2hpbGQob2xkZXN0KTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogUmVuZGVyIHNlc3Npb24gY29udGV4dCB0byBjaGF0LiBVc2VkIGZvciBpbml0aWFsIGxvYWQgYW5kIHJlYnVpbGQgYWZ0ZXIgY29tcGFjdGlvbi5cblx0ICogQHBhcmFtIHNlc3Npb25Db250ZXh0IFNlc3Npb24gY29udGV4dCB0byByZW5kZXJcblx0ICogQHBhcmFtIG9wdGlvbnMudXBkYXRlRm9vdGVyIFVwZGF0ZSBmb290ZXIgc3RhdGVcblx0ICogQHBhcmFtIG9wdGlvbnMucG9wdWxhdGVIaXN0b3J5IEFkZCB1c2VyIG1lc3NhZ2VzIHRvIGVkaXRvciBoaXN0b3J5XG5cdCAqL1xuXHRwcml2YXRlIHJlbmRlclNlc3Npb25Db250ZXh0KFxuXHRcdHNlc3Npb25Db250ZXh0OiBTZXNzaW9uQ29udGV4dCxcblx0XHRvcHRpb25zOiB7IHVwZGF0ZUZvb3Rlcj86IGJvb2xlYW47IHBvcHVsYXRlSGlzdG9yeT86IGJvb2xlYW4gfSA9IHt9LFxuXHQpOiB2b2lkIHtcblx0XHR0aGlzLnBlbmRpbmdUb29scy5jbGVhcigpO1xuXHRcdGNvbnN0IHRpbWVzdGFtcEZvcm1hdCA9IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldFRpbWVzdGFtcEZvcm1hdCgpO1xuXG5cdFx0aWYgKG9wdGlvbnMudXBkYXRlRm9vdGVyKSB7XG5cdFx0XHR0aGlzLmZvb3Rlci5pbnZhbGlkYXRlKCk7XG5cdFx0XHR0aGlzLnVwZGF0ZUVkaXRvckJvcmRlckNvbG9yKCk7XG5cdFx0fVxuXG5cdFx0Zm9yIChjb25zdCBtZXNzYWdlIG9mIHNlc3Npb25Db250ZXh0Lm1lc3NhZ2VzKSB7XG5cdFx0XHQvLyBBc3Npc3RhbnQgbWVzc2FnZXMgbmVlZCBzcGVjaWFsIGhhbmRsaW5nIGZvciB0b29sIGNhbGxzXG5cdFx0XHRpZiAobWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRcdGNvbnN0IGhhc1Rvb2xCbG9ja3MgPSBtZXNzYWdlLmNvbnRlbnQuc29tZSgoYykgPT4gYy50eXBlID09PSBcInRvb2xDYWxsXCIgfHwgYy50eXBlID09PSBcInNlcnZlclRvb2xVc2VcIik7XG5cdFx0XHRcdGlmICghaGFzVG9vbEJsb2Nrcykge1xuXHRcdFx0XHRcdHRoaXMuYWRkTWVzc2FnZVRvQ2hhdChtZXNzYWdlKTtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGFzc2lzdGFudFNlZ21lbnRzOiBBc3Npc3RhbnRNZXNzYWdlQ29tcG9uZW50W10gPSBbXTtcblx0XHRcdFx0Y29uc3QgcmVwbGF5U2VnbWVudHMgPSBidWlsZEFzc2lzdGFudFJlcGxheVNlZ21lbnRzKG1lc3NhZ2UuY29udGVudCk7XG5cblx0XHRcdFx0Zm9yIChjb25zdCBzZWdtZW50IG9mIHJlcGxheVNlZ21lbnRzKSB7XG5cdFx0XHRcdFx0aWYgKHNlZ21lbnQua2luZCA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0XHRcdFx0Y29uc3QgYXNzaXN0YW50Q29tcG9uZW50ID0gbmV3IEFzc2lzdGFudE1lc3NhZ2VDb21wb25lbnQoXG5cdFx0XHRcdFx0XHRcdG1lc3NhZ2UsXG5cdFx0XHRcdFx0XHRcdHRoaXMuaGlkZVRoaW5raW5nQmxvY2ssXG5cdFx0XHRcdFx0XHRcdHRoaXMuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncygpLFxuXHRcdFx0XHRcdFx0XHR0aW1lc3RhbXBGb3JtYXQsXG5cdFx0XHRcdFx0XHRcdHsgc3RhcnRJbmRleDogc2VnbWVudC5zdGFydEluZGV4LCBlbmRJbmRleDogc2VnbWVudC5lbmRJbmRleCB9LFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChhc3Npc3RhbnRDb21wb25lbnQpO1xuXHRcdFx0XHRcdFx0YXNzaXN0YW50U2VnbWVudHMucHVzaChhc3Npc3RhbnRDb21wb25lbnQpO1xuXHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgY29udGVudCA9IG1lc3NhZ2UuY29udGVudFtzZWdtZW50LmNvbnRlbnRJbmRleF07XG5cdFx0XHRcdFx0aWYgKGNvbnRlbnQudHlwZSA9PT0gXCJ0b29sQ2FsbFwiKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBjb21wb25lbnQgPSBuZXcgVG9vbEV4ZWN1dGlvbkNvbXBvbmVudChcblx0XHRcdFx0XHRcdFx0Y29udGVudC5uYW1lLFxuXHRcdFx0XHRcdFx0XHRjb250ZW50LmFyZ3VtZW50cyxcblx0XHRcdFx0XHRcdFx0eyBzaG93SW1hZ2VzOiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRTaG93SW1hZ2VzKCkgfSxcblx0XHRcdFx0XHRcdFx0dGhpcy5nZXRSZWdpc3RlcmVkVG9vbERlZmluaXRpb24oY29udGVudC5uYW1lKSxcblx0XHRcdFx0XHRcdFx0dGhpcy51aSxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRjb21wb25lbnQuc2V0RXhwYW5kZWQodGhpcy50b29sT3V0cHV0RXhwYW5kZWQpO1xuXHRcdFx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKGNvbXBvbmVudCk7XG5cblx0XHRcdFx0XHRcdGlmIChtZXNzYWdlLnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiIHx8IG1lc3NhZ2Uuc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiKSB7XG5cdFx0XHRcdFx0XHRcdGxldCBlcnJvck1lc3NhZ2U6IHN0cmluZztcblx0XHRcdFx0XHRcdFx0aWYgKG1lc3NhZ2Uuc3RvcFJlYXNvbiA9PT0gXCJhYm9ydGVkXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCByZXRyeUF0dGVtcHQgPSB0aGlzLnNlc3Npb24ucmV0cnlBdHRlbXB0O1xuXHRcdFx0XHRcdFx0XHRcdGVycm9yTWVzc2FnZSA9XG5cdFx0XHRcdFx0XHRcdFx0XHRyZXRyeUF0dGVtcHQgPiAwXG5cdFx0XHRcdFx0XHRcdFx0XHRcdD8gYEFib3J0ZWQgYWZ0ZXIgJHtyZXRyeUF0dGVtcHR9IHJldHJ5IGF0dGVtcHQke3JldHJ5QXR0ZW1wdCA+IDEgPyBcInNcIiA6IFwiXCJ9YFxuXHRcdFx0XHRcdFx0XHRcdFx0XHQ6IFwiT3BlcmF0aW9uIGFib3J0ZWRcIjtcblx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0XHRlcnJvck1lc3NhZ2UgPSBtZXNzYWdlLmVycm9yTWVzc2FnZSB8fCBcIkVycm9yXCI7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0Y29tcG9uZW50LnVwZGF0ZVJlc3VsdCh7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBlcnJvck1lc3NhZ2UgfV0sIGlzRXJyb3I6IHRydWUgfSk7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHR0aGlzLnBlbmRpbmdUb29scy5zZXQoY29udGVudC5pZCwgY29tcG9uZW50KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9IGVsc2UgaWYgKGNvbnRlbnQudHlwZSA9PT0gXCJzZXJ2ZXJUb29sVXNlXCIpIHtcblx0XHRcdFx0XHRcdC8vIFNlcnZlci1zaWRlIHRvb2wgKGUuZy4sIG5hdGl2ZSB3ZWIgc2VhcmNoKVxuXHRcdFx0XHRcdFx0Y29uc3QgY29tcG9uZW50ID0gbmV3IFRvb2xFeGVjdXRpb25Db21wb25lbnQoXG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQubmFtZSxcblx0XHRcdFx0XHRcdFx0Y29udGVudC5pbnB1dCA/PyB7fSxcblx0XHRcdFx0XHRcdFx0eyBzaG93SW1hZ2VzOiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRTaG93SW1hZ2VzKCkgfSxcblx0XHRcdFx0XHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0XHR0aGlzLnVpLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRcdGNvbXBvbmVudC5zZXRFeHBhbmRlZCh0aGlzLnRvb2xPdXRwdXRFeHBhbmRlZCk7XG5cdFx0XHRcdFx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQoY29tcG9uZW50KTtcblx0XHRcdFx0XHRcdC8vIEZpbmQgbWF0Y2hpbmcgd2ViU2VhcmNoUmVzdWx0IGluIHRoaXMgbWVzc2FnZSdzIGNvbnRlbnRcblx0XHRcdFx0XHRcdGNvbnN0IHJlc3VsdEJsb2NrID0gbWVzc2FnZS5jb250ZW50LmZpbmQoXG5cdFx0XHRcdFx0XHRcdChjKSA9PiBjLnR5cGUgPT09IFwid2ViU2VhcmNoUmVzdWx0XCIgJiYgYy50b29sVXNlSWQgPT09IGNvbnRlbnQuaWQsXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdFx0aWYgKHJlc3VsdEJsb2NrICYmIHJlc3VsdEJsb2NrLnR5cGUgPT09IFwid2ViU2VhcmNoUmVzdWx0XCIpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgc2VhcmNoQ29udGVudCA9IHJlc3VsdEJsb2NrLmNvbnRlbnQ7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGlzRXJyb3IgPSBzZWFyY2hDb250ZW50ICYmIHR5cGVvZiBzZWFyY2hDb250ZW50ID09PSBcIm9iamVjdFwiICYmIFwidHlwZVwiIGluIChzZWFyY2hDb250ZW50IGFzIGFueSkgJiYgKHNlYXJjaENvbnRlbnQgYXMgYW55KS50eXBlID09PSBcIndlYl9zZWFyY2hfdG9vbF9yZXN1bHRfZXJyb3JcIjtcblx0XHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0VGV4dCA9IHRoaXMuZm9ybWF0V2ViU2VhcmNoUmVzdWx0KHNlYXJjaENvbnRlbnQpO1xuXHRcdFx0XHRcdFx0XHRjb21wb25lbnQudXBkYXRlUmVzdWx0KHtcblx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogcmVzdWx0VGV4dCB9XSxcblx0XHRcdFx0XHRcdFx0XHRpc0Vycm9yOiAhIWlzRXJyb3IsXG5cdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0Ly8gTm8gcmVzdWx0IHlldCAoYWJvcnRlZCBzdHJlYW0/KSBcdTIwMTQgc2hvdyBhcyBwZW5kaW5nXG5cdFx0XHRcdFx0XHRcdHRoaXMucGVuZGluZ1Rvb2xzLnNldChjb250ZW50LmlkLCBjb21wb25lbnQpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIE1hdGNoIHN0cmVhbWluZy1tb2RlIGJlaGF2aW9yOiBzaG93IG1ldGFkYXRhIG9uY2Ugb24gdGhlIGZpbmFsXG5cdFx0XHRcdC8vIGFzc2lzdGFudCBwcm9zZSBzZWdtZW50IGZvciB0aGlzIG1lc3NhZ2UuXG5cdFx0XHRcdGNvbnN0IGxhc3RBc3Npc3RhbnRTZWdtZW50ID0gYXNzaXN0YW50U2VnbWVudHNbYXNzaXN0YW50U2VnbWVudHMubGVuZ3RoIC0gMV07XG5cdFx0XHRcdGxhc3RBc3Npc3RhbnRTZWdtZW50Py5zZXRTaG93TWV0YWRhdGEodHJ1ZSk7XG5cdFx0XHR9IGVsc2UgaWYgKG1lc3NhZ2Uucm9sZSA9PT0gXCJ0b29sUmVzdWx0XCIpIHtcblx0XHRcdFx0Ly8gTWF0Y2ggdG9vbCByZXN1bHRzIHRvIHBlbmRpbmcgdG9vbCBjb21wb25lbnRzXG5cdFx0XHRcdGNvbnN0IGNvbXBvbmVudCA9IHRoaXMucGVuZGluZ1Rvb2xzLmdldChtZXNzYWdlLnRvb2xDYWxsSWQpO1xuXHRcdFx0XHRpZiAoY29tcG9uZW50KSB7XG5cdFx0XHRcdFx0Y29tcG9uZW50LnVwZGF0ZVJlc3VsdChtZXNzYWdlKTtcblx0XHRcdFx0XHR0aGlzLnBlbmRpbmdUb29scy5kZWxldGUobWVzc2FnZS50b29sQ2FsbElkKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gQWxsIG90aGVyIG1lc3NhZ2VzIHVzZSBzdGFuZGFyZCByZW5kZXJpbmdcblx0XHRcdFx0dGhpcy5hZGRNZXNzYWdlVG9DaGF0KG1lc3NhZ2UsIG9wdGlvbnMpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdC8vIEFueSBwZW5kaW5nVG9vbHMgZW50cmllcyBsZWZ0IG92ZXIgYWZ0ZXIgcmVwbGF5IGFyZSBoaXN0b3JpY2FsIHRvb2xcblx0XHQvLyBjYWxscyB3aG9zZSByZXN1bHRzIHdlcmUgc3F1YXNoZWQgb3V0IG9mIHNlc3Npb24gY29udGV4dCAoY29tbW9ubHkgYnlcblx0XHQvLyBjb21wYWN0aW9uKS4gTWFyayB0aGVtIGZpbmlzaGVkIHNvIHRoZSBmcmFtZSBzdG9wcyBzaG93aW5nIFwiUnVubmluZ1wiLlxuXHRcdGZvciAoY29uc3QgY29tcG9uZW50IG9mIHRoaXMucGVuZGluZ1Rvb2xzLnZhbHVlcygpKSB7XG5cdFx0XHRjb21wb25lbnQubWFya0hpc3RvcmljYWxOb1Jlc3VsdCgpO1xuXHRcdH1cblx0XHR0aGlzLnBlbmRpbmdUb29scy5jbGVhcigpO1xuXHRcdHRoaXMudHJpbUNoYXRIaXN0b3J5KCk7XG5cdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHRyZW5kZXJJbml0aWFsTWVzc2FnZXMoKTogdm9pZCB7XG5cdFx0Ly8gR2V0IGFsaWduZWQgbWVzc2FnZXMgYW5kIGVudHJpZXMgZnJvbSBzZXNzaW9uIGNvbnRleHRcblx0XHRjb25zdCBjb250ZXh0ID0gdGhpcy5zZXNzaW9uTWFuYWdlci5idWlsZFNlc3Npb25Db250ZXh0KCk7XG5cdFx0dGhpcy5yZW5kZXJTZXNzaW9uQ29udGV4dChjb250ZXh0LCB7XG5cdFx0XHR1cGRhdGVGb290ZXI6IHRydWUsXG5cdFx0XHRwb3B1bGF0ZUhpc3Rvcnk6IHRydWUsXG5cdFx0fSk7XG5cdFx0dGhpcy5wb3B1bGF0ZVBpbm5lZEZyb21NZXNzYWdlcyhjb250ZXh0Lm1lc3NhZ2VzKTtcblxuXHRcdC8vIFNob3cgY29tcGFjdGlvbiBpbmZvIGlmIHNlc3Npb24gd2FzIGNvbXBhY3RlZFxuXHRcdGNvbnN0IGFsbEVudHJpZXMgPSB0aGlzLnNlc3Npb25NYW5hZ2VyLmdldEVudHJpZXMoKTtcblx0XHRjb25zdCBjb21wYWN0aW9uQ291bnQgPSBhbGxFbnRyaWVzLmZpbHRlcigoZSkgPT4gZS50eXBlID09PSBcImNvbXBhY3Rpb25cIikubGVuZ3RoO1xuXHRcdGlmIChjb21wYWN0aW9uQ291bnQgPiAwKSB7XG5cdFx0XHRjb25zdCB0aW1lcyA9IGNvbXBhY3Rpb25Db3VudCA9PT0gMSA/IFwiMSB0aW1lXCIgOiBgJHtjb21wYWN0aW9uQ291bnR9IHRpbWVzYDtcblx0XHRcdHRoaXMuc2hvd1N0YXR1cyhgU2Vzc2lvbiBjb21wYWN0ZWQgJHt0aW1lc31gKTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBnZXRVc2VySW5wdXQoKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcblx0XHRcdHRoaXMub25JbnB1dENhbGxiYWNrID0gKHRleHQ6IHN0cmluZykgPT4ge1xuXHRcdFx0XHR0aGlzLm9uSW5wdXRDYWxsYmFjayA9IHVuZGVmaW5lZDtcblx0XHRcdFx0cmVzb2x2ZSh0ZXh0KTtcblx0XHRcdH07XG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIHJlYnVpbGRDaGF0RnJvbU1lc3NhZ2VzKCk6IHZvaWQge1xuXHRcdHRoaXMuY2hhdENvbnRhaW5lci5jbGVhcigpO1xuXHRcdHRoaXMucGlubmVkTWVzc2FnZUNvbnRhaW5lci5jbGVhcigpO1xuXHRcdGNvbnN0IGNvbnRleHQgPSB0aGlzLnNlc3Npb25NYW5hZ2VyLmJ1aWxkU2Vzc2lvbkNvbnRleHQoKTtcblx0XHR0aGlzLnJlbmRlclNlc3Npb25Db250ZXh0KGNvbnRleHQpO1xuXHRcdC8vIFBpbm5lZCBjb250ZW50IE5PVCByZS1wb3B1bGF0ZWQgaGVyZSBcdTIwMTQgdGhlIHN0cmVhbWluZyBsaWZlY3ljbGUgaW5cblx0XHQvLyBjaGF0LWNvbnRyb2xsZXIudHMgbWFuYWdlcyB0aGUgcGlubmVkIHpvbmUgZHVyaW5nIGFjdGl2ZSB3b3JrLlxuXHRcdC8vIHBvcHVsYXRlUGlubmVkRnJvbU1lc3NhZ2VzKCkgcmVtYWlucyBpbiByZW5kZXJJbml0aWFsTWVzc2FnZXMoKVxuXHRcdC8vIGZvciB0aGUgc2Vzc2lvbi1yZXN1bWUgY2FzZSBhdCBzdGFydHVwLlxuXHR9XG5cblx0LyoqXG5cdCAqIEFmdGVyIHJlYnVpbGRpbmcgY2hhdCBmcm9tIG1lc3NhZ2VzLCBwaW4gdGhlIGxhc3QgYXNzaXN0YW50IHRleHQgYWJvdmUgdGhlXG5cdCAqIGVkaXRvciBpZiB0b29sIHJlc3VsdHMgd291bGQgb3RoZXJ3aXNlIHB1c2ggaXQgb3V0IG9mIHRoZSB2aWV3cG9ydC5cblx0ICovXG5cdHByaXZhdGUgcG9wdWxhdGVQaW5uZWRGcm9tTWVzc2FnZXMobWVzc2FnZXM6IEFnZW50TWVzc2FnZVtdKTogdm9pZCB7XG5cdFx0dGhpcy5waW5uZWRNZXNzYWdlQ29udGFpbmVyLmNsZWFyKCk7XG5cblx0XHQvLyBXYWxrIGJhY2t3YXJkcyB0byBmaW5kIHRoZSBsYXN0IGFzc2lzdGFudCBtZXNzYWdlXG5cdFx0bGV0IGxhc3RBc3Npc3RhbnQ6IEFzc2lzdGFudE1lc3NhZ2UgfCB1bmRlZmluZWQ7XG5cdFx0Zm9yIChsZXQgaSA9IG1lc3NhZ2VzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG5cdFx0XHRjb25zdCBtc2cgPSBtZXNzYWdlc1tpXTtcblx0XHRcdGlmIChtc2cgJiYgXCJyb2xlXCIgaW4gbXNnICYmIG1zZy5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRcdGxhc3RBc3Npc3RhbnQgPSBtc2cgYXMgQXNzaXN0YW50TWVzc2FnZTtcblx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGlmICghbGFzdEFzc2lzdGFudCkgcmV0dXJuO1xuXG5cdFx0Ly8gQ2hlY2sgaWYgYW55IHRvb2wgY2FsbHMgZm9sbG93IHRoZSBsYXN0IHRleHQgYmxvY2tcblx0XHRjb25zdCBjb250ZW50ID0gbGFzdEFzc2lzdGFudC5jb250ZW50O1xuXHRcdGxldCBsYXN0VGV4dEluZGV4ID0gLTE7XG5cdFx0bGV0IGhhc1Rvb2xBZnRlclRleHQgPSBmYWxzZTtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGNvbnRlbnQubGVuZ3RoOyBpKyspIHtcblx0XHRcdGlmIChjb250ZW50W2ldLnR5cGUgPT09IFwidGV4dFwiKSBsYXN0VGV4dEluZGV4ID0gaTtcblx0XHR9XG5cdFx0aWYgKGxhc3RUZXh0SW5kZXggPj0gMCkge1xuXHRcdFx0Zm9yIChsZXQgaSA9IGxhc3RUZXh0SW5kZXggKyAxOyBpIDwgY29udGVudC5sZW5ndGg7IGkrKykge1xuXHRcdFx0XHRpZiAoY29udGVudFtpXS50eXBlID09PSBcInRvb2xDYWxsXCIgfHwgY29udGVudFtpXS50eXBlID09PSBcInNlcnZlclRvb2xVc2VcIikge1xuXHRcdFx0XHRcdGhhc1Rvb2xBZnRlclRleHQgPSB0cnVlO1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGlmICghaGFzVG9vbEFmdGVyVGV4dCB8fCBsYXN0VGV4dEluZGV4IDwgMCkgcmV0dXJuO1xuXG5cdFx0Y29uc3QgdGV4dEJsb2NrID0gY29udGVudFtsYXN0VGV4dEluZGV4XSBhcyB7IHR5cGU6IFwidGV4dFwiOyB0ZXh0OiBzdHJpbmcgfTtcblx0XHRjb25zdCB0ZXh0ID0gdGV4dEJsb2NrLnRleHQ/LnRyaW0oKTtcblx0XHRpZiAoIXRleHQpIHJldHVybjtcblxuXHRcdHRoaXMucGlubmVkTWVzc2FnZUNvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdG5ldyBEeW5hbWljQm9yZGVyKChzdHI6IHN0cmluZykgPT4gdGhlbWUuZmcoXCJkaW1cIiwgc3RyKSwgXCJMYXRlc3QgT3V0cHV0XCIpLFxuXHRcdCk7XG5cdFx0dGhpcy5waW5uZWRNZXNzYWdlQ29udGFpbmVyLmFkZENoaWxkKFxuXHRcdFx0bmV3IE1hcmtkb3duKHRleHQsIDEsIDAsIHRoaXMuZ2V0TWFya2Rvd25UaGVtZVdpdGhTZXR0aW5ncygpKSxcblx0XHQpO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBLZXkgaGFuZGxlcnNcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdHByaXZhdGUgaGFuZGxlQ3RybEMoKTogdm9pZCB7XG5cdFx0Y29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblx0XHRpZiAobm93IC0gdGhpcy5sYXN0U2lnaW50VGltZSA8IDUwMCkge1xuXHRcdFx0dm9pZCB0aGlzLnNodXRkb3duKCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMuY2xlYXJFZGl0b3IoKTtcblx0XHRcdHRoaXMubGFzdFNpZ2ludFRpbWUgPSBub3c7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVDdHJsRCgpOiB2b2lkIHtcblx0XHQvLyBPbmx5IGNhbGxlZCB3aGVuIGVkaXRvciBpcyBlbXB0eSAoZW5mb3JjZWQgYnkgQ3VzdG9tRWRpdG9yKVxuXHRcdHZvaWQgdGhpcy5zaHV0ZG93bigpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdyYWNlZnVsbHkgc2h1dGRvd24gdGhlIGFnZW50LlxuXHQgKiBFbWl0cyBzaHV0ZG93biBldmVudCB0byBleHRlbnNpb25zLCB0aGVuIGV4aXRzLlxuXHQgKi9cblx0cHJpdmF0ZSBpc1NodXR0aW5nRG93biA9IGZhbHNlO1xuXG5cdHByaXZhdGUgYXN5bmMgc2h1dGRvd24oKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3Qgc2h1dGRvd25CZWhhdmlvciA9IHRoaXMub3B0aW9ucy5zaHV0ZG93bkJlaGF2aW9yID8/IFwiZXhpdF9wcm9jZXNzXCI7XG5cdFx0aWYgKHNodXRkb3duQmVoYXZpb3IgPT09IFwiaWdub3JlXCIpIHtcblx0XHRcdHRoaXMuc2hvd1N0YXR1cyhcIlF1aXQgaXMgdW5hdmFpbGFibGUgaW4gdGhlIGJyb3dzZXItYXR0YWNoZWQgdGVybWluYWxcIik7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0aWYgKHRoaXMuaXNTaHV0dGluZ0Rvd24pIHJldHVybjtcblx0XHR0aGlzLmlzU2h1dHRpbmdEb3duID0gdHJ1ZTtcblxuXHRcdC8vIEZsdXNoIGFueSBxdWV1ZWQgc2V0dGluZ3Mgd3JpdGVzIGJlZm9yZSBzaHV0ZG93blxuXHRcdGF3YWl0IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmZsdXNoKCk7XG5cblx0XHQvLyBFbWl0IHNodXRkb3duIGV2ZW50IHRvIGV4dGVuc2lvbnNcblx0XHRjb25zdCBleHRlbnNpb25SdW5uZXIgPSB0aGlzLnNlc3Npb24uZXh0ZW5zaW9uUnVubmVyO1xuXHRcdGlmIChleHRlbnNpb25SdW5uZXI/Lmhhc0hhbmRsZXJzKFwic2Vzc2lvbl9zaHV0ZG93blwiKSkge1xuXHRcdFx0YXdhaXQgZXh0ZW5zaW9uUnVubmVyLmVtaXQoe1xuXHRcdFx0XHR0eXBlOiBcInNlc3Npb25fc2h1dGRvd25cIixcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdC8vIFdhaXQgZm9yIGFueSBwZW5kaW5nIHJlbmRlcnMgdG8gY29tcGxldGVcblx0XHQvLyByZXF1ZXN0UmVuZGVyKCkgdXNlcyBwcm9jZXNzLm5leHRUaWNrKCksIHNvIHdlIHdhaXQgb25lIHRpY2tcblx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gcHJvY2Vzcy5uZXh0VGljayhyZXNvbHZlKSk7XG5cblx0XHQvLyBEcmFpbiBhbnkgaW4tZmxpZ2h0IEtpdHR5IGtleSByZWxlYXNlIGV2ZW50cyBiZWZvcmUgc3RvcHBpbmcuXG5cdFx0Ly8gVGhpcyBwcmV2ZW50cyBlc2NhcGUgc2VxdWVuY2VzIGZyb20gbGVha2luZyB0byB0aGUgcGFyZW50IHNoZWxsIG92ZXIgc2xvdyBTU0guXG5cdFx0YXdhaXQgdGhpcy51aS50ZXJtaW5hbC5kcmFpbklucHV0KDEwMDApO1xuXG5cdFx0dGhpcy5zdG9wKCk7XG5cdFx0aWYgKHNodXRkb3duQmVoYXZpb3IgPT09IFwic3RvcF91aVwiKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gS2lsbCBBTEwgZGVzY2VuZGFudCBwcm9jZXNzZXMgdG8gcHJldmVudCBvcnBoYW5zIChuZXh0LXNlcnZlciwgcG5wbSBkZXYsIGV0Yy4pXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGRlc2NlbmRhbnRzID0gbGlzdERlc2NlbmRhbnRzKHByb2Nlc3MucGlkKTtcblx0XHRcdGZvciAoY29uc3QgY2hpbGRQaWQgb2YgZGVzY2VuZGFudHMpIHtcblx0XHRcdFx0dHJ5IHsgcHJvY2Vzcy5raWxsKGNoaWxkUGlkLCBcIlNJR1RFUk1cIik7IH0gY2F0Y2gge31cblx0XHRcdH1cblx0XHRcdGlmIChkZXNjZW5kYW50cy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCA1MDApKTtcblx0XHRcdFx0Zm9yIChjb25zdCBjaGlsZFBpZCBvZiBkZXNjZW5kYW50cykge1xuXHRcdFx0XHRcdHRyeSB7IHByb2Nlc3Mua2lsbChjaGlsZFBpZCwgXCJTSUdLSUxMXCIpOyB9IGNhdGNoIHt9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGNhdGNoIHt9XG5cblx0XHRwcm9jZXNzLmV4aXQoMCk7XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2sgaWYgc2h1dGRvd24gd2FzIHJlcXVlc3RlZCBhbmQgcGVyZm9ybSBzaHV0ZG93biBpZiBzby5cblx0ICovXG5cdHByaXZhdGUgYXN5bmMgY2hlY2tTaHV0ZG93blJlcXVlc3RlZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAoIXRoaXMuc2h1dGRvd25SZXF1ZXN0ZWQpIHJldHVybjtcblx0XHRhd2FpdCB0aGlzLnNodXRkb3duKCk7XG5cdH1cblxuXHRwcml2YXRlIGhhbmRsZUN0cmxaKCk6IHZvaWQge1xuXHRcdC8vIE9uIFdpbmRvd3MsIFNJR1RTVFAgZG9lc24ndCBleGlzdCAtIEN0cmwrWiBpcyBub3Qgc3VwcG9ydGVkXG5cdFx0aWYgKHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIikge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIElnbm9yZSBTSUdJTlQgd2hpbGUgc3VzcGVuZGVkIHNvIEN0cmwrQyBpbiB0aGUgdGVybWluYWwgZG9lcyBub3Rcblx0XHQvLyBraWxsIHRoZSBiYWNrZ3JvdW5kZWQgcHJvY2Vzcy4gVGhlIGhhbmRsZXIgaXMgcmVtb3ZlZCBvbiByZXN1bWUuXG5cdFx0Y29uc3QgaWdub3JlU2lnaW50ID0gKCkgPT4ge307XG5cdFx0cHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBpZ25vcmVTaWdpbnQpO1xuXG5cdFx0dHJ5IHtcblx0XHRcdC8vIFNldCB1cCBoYW5kbGVyIHRvIHJlc3RvcmUgVFVJIHdoZW4gcmVzdW1lZFxuXHRcdFx0cHJvY2Vzcy5vbmNlKFwiU0lHQ09OVFwiLCAoKSA9PiB7XG5cdFx0XHRcdHByb2Nlc3MucmVtb3ZlTGlzdGVuZXIoXCJTSUdJTlRcIiwgaWdub3JlU2lnaW50KTtcblx0XHRcdFx0dGhpcy51aS5zdGFydCgpO1xuXHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIodHJ1ZSk7XG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gU3RvcCB0aGUgVFVJIChyZXN0b3JlIHRlcm1pbmFsIHRvIG5vcm1hbCBtb2RlKVxuXHRcdFx0dGhpcy51aS5zdG9wKCk7XG5cblx0XHRcdC8vIFNlbmQgU0lHVFNUUCB0byBwcm9jZXNzIGdyb3VwIChwaWQ9MCBtZWFucyBhbGwgcHJvY2Vzc2VzIGluIGdyb3VwKVxuXHRcdFx0cHJvY2Vzcy5raWxsKDAsIFwiU0lHVFNUUFwiKTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIElmIHN1c3BlbmQgZmFpbHMgKGUuZy4gU0lHVFNUUCBub3Qgc3VwcG9ydGVkKSwgZW5zdXJlIHRoZVxuXHRcdFx0Ly8gU0lHSU5UIGxpc3RlbmVyIGRvZXNuJ3QgbGVhay5cblx0XHRcdHByb2Nlc3MucmVtb3ZlTGlzdGVuZXIoXCJTSUdJTlRcIiwgaWdub3JlU2lnaW50KTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGhhbmRsZUZvbGxvd1VwKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHRleHQgPSAodGhpcy5lZGl0b3IuZ2V0RXhwYW5kZWRUZXh0Py4oKSA/PyB0aGlzLmVkaXRvci5nZXRUZXh0KCkpLnRyaW0oKTtcblx0XHRpZiAoIXRleHQpIHJldHVybjtcblxuXHRcdGlmICh0ZXh0LnN0YXJ0c1dpdGgoXCIvXCIpICYmICF0aGlzLmlzS25vd25TbGFzaENvbW1hbmQodGV4dCkpIHtcblx0XHRcdGNvbnN0IGNvbW1hbmQgPSB0ZXh0LnNwbGl0KC9cXHMvKVswXTtcblx0XHRcdHRoaXMuc2hvd0Vycm9yKGBVbmtub3duIGNvbW1hbmQ6ICR7Y29tbWFuZH0uIFVzZSBzbGFzaCBhdXRvY29tcGxldGUgdG8gc2VlIGF2YWlsYWJsZSBjb21tYW5kcy5gKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDb25zdW1lIHBlbmRpbmcgaW1hZ2VzXG5cdFx0Y29uc3QgaW1hZ2VzID0gdGhpcy5wZW5kaW5nSW1hZ2VzLmxlbmd0aCA+IDAgPyBbLi4udGhpcy5wZW5kaW5nSW1hZ2VzXSA6IHVuZGVmaW5lZDtcblx0XHR0aGlzLnBlbmRpbmdJbWFnZXMubGVuZ3RoID0gMDtcblxuXHRcdC8vIFF1ZXVlIGlucHV0IGR1cmluZyBjb21wYWN0aW9uIChleHRlbnNpb24gY29tbWFuZHMgZXhlY3V0ZSBpbW1lZGlhdGVseSlcblx0XHRpZiAodGhpcy5zZXNzaW9uLmlzQ29tcGFjdGluZykge1xuXHRcdFx0aWYgKHRoaXMuaXNFeHRlbnNpb25Db21tYW5kKHRleHQpKSB7XG5cdFx0XHRcdHRoaXMuZWRpdG9yLmFkZFRvSGlzdG9yeT8uKHRleHQpO1xuXHRcdFx0XHR0aGlzLmVkaXRvci5zZXRUZXh0KFwiXCIpO1xuXHRcdFx0XHRhd2FpdCB0aGlzLnNlc3Npb24ucHJvbXB0KHRleHQsIHsgaW1hZ2VzIH0pO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGhpcy5xdWV1ZUNvbXBhY3Rpb25NZXNzYWdlKHRleHQsIFwiZm9sbG93VXBcIik7XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gQWx0K0VudGVyIHF1ZXVlcyBhIGZvbGxvdy11cCBtZXNzYWdlICh3YWl0cyB1bnRpbCBhZ2VudCBmaW5pc2hlcylcblx0XHQvLyBUaGlzIGhhbmRsZXMgZXh0ZW5zaW9uIGNvbW1hbmRzIChleGVjdXRlIGltbWVkaWF0ZWx5KSwgcHJvbXB0IHRlbXBsYXRlIGV4cGFuc2lvbiwgYW5kIHF1ZXVlaW5nXG5cdFx0aWYgKHRoaXMuc2Vzc2lvbi5pc1N0cmVhbWluZykge1xuXHRcdFx0dGhpcy5lZGl0b3IuYWRkVG9IaXN0b3J5Py4odGV4dCk7XG5cdFx0XHR0aGlzLmVkaXRvci5zZXRUZXh0KFwiXCIpO1xuXHRcdFx0YXdhaXQgdGhpcy5zZXNzaW9uLnByb21wdCh0ZXh0LCB7IHN0cmVhbWluZ0JlaGF2aW9yOiBcImZvbGxvd1VwXCIsIGltYWdlcyB9KTtcblx0XHRcdHRoaXMudXBkYXRlUGVuZGluZ01lc3NhZ2VzRGlzcGxheSgpO1xuXHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fVxuXHRcdC8vIElmIG5vdCBzdHJlYW1pbmcsIEFsdCtFbnRlciBhY3RzIGxpa2UgcmVndWxhciBFbnRlciAodHJpZ2dlciBvblN1Ym1pdClcblx0XHRlbHNlIGlmICh0aGlzLmVkaXRvci5vblN1Ym1pdCkge1xuXHRcdFx0dGhpcy5lZGl0b3Iub25TdWJtaXQodGV4dCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVEZXF1ZXVlKCk6IHZvaWQge1xuXHRcdGNvbnN0IHJlc3RvcmVkID0gdGhpcy5yZXN0b3JlUXVldWVkTWVzc2FnZXNUb0VkaXRvcigpO1xuXHRcdGlmIChyZXN0b3JlZCA9PT0gMCkge1xuXHRcdFx0dGhpcy5zaG93U3RhdHVzKFwiTm8gcXVldWVkIG1lc3NhZ2VzIHRvIHJlc3RvcmVcIik7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMuc2hvd1N0YXR1cyhgUmVzdG9yZWQgJHtyZXN0b3JlZH0gcXVldWVkIG1lc3NhZ2Uke3Jlc3RvcmVkID4gMSA/IFwic1wiIDogXCJcIn0gdG8gZWRpdG9yYCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSB1cGRhdGVFZGl0b3JCb3JkZXJDb2xvcigpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5pc0Jhc2hNb2RlKSB7XG5cdFx0XHR0aGlzLmVkaXRvci5ib3JkZXJDb2xvciA9IHRoZW1lLmdldEJhc2hNb2RlQm9yZGVyQ29sb3IoKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgbGV2ZWwgPSB0aGlzLnNlc3Npb24udGhpbmtpbmdMZXZlbCB8fCBcIm9mZlwiO1xuXHRcdFx0dGhpcy5lZGl0b3IuYm9yZGVyQ29sb3IgPSB0aGVtZS5nZXRUaGlua2luZ0JvcmRlckNvbG9yKGxldmVsKTtcblx0XHR9XG5cdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHRwcml2YXRlIGN5Y2xlVGhpbmtpbmdMZXZlbCgpOiB2b2lkIHtcblx0XHRjb25zdCBuZXdMZXZlbCA9IHRoaXMuc2Vzc2lvbi5jeWNsZVRoaW5raW5nTGV2ZWwoKTtcblx0XHRpZiAobmV3TGV2ZWwgPT09IHVuZGVmaW5lZCkge1xuXHRcdFx0dGhpcy5zaG93U3RhdHVzKFwiQ3VycmVudCBtb2RlbCBkb2VzIG5vdCBzdXBwb3J0IHRoaW5raW5nXCIpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLmZvb3Rlci5pbnZhbGlkYXRlKCk7XG5cdFx0XHR0aGlzLnVwZGF0ZUVkaXRvckJvcmRlckNvbG9yKCk7XG5cdFx0XHR0aGlzLnNob3dTdGF0dXMoYFRoaW5raW5nIGxldmVsOiAke25ld0xldmVsfWApO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgY3ljbGVNb2RlbChkaXJlY3Rpb246IFwiZm9yd2FyZFwiIHwgXCJiYWNrd2FyZFwiKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuc2Vzc2lvbi5jeWNsZU1vZGVsKGRpcmVjdGlvbik7XG5cdFx0XHRpZiAocmVzdWx0ID09PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0Y29uc3QgbXNnID0gdGhpcy5zZXNzaW9uLnNjb3BlZE1vZGVscy5sZW5ndGggPiAwID8gXCJPbmx5IG9uZSBtb2RlbCBpbiBzY29wZVwiIDogXCJPbmx5IG9uZSBtb2RlbCBhdmFpbGFibGVcIjtcblx0XHRcdFx0dGhpcy5zaG93U3RhdHVzKG1zZyk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR0aGlzLmZvb3Rlci5pbnZhbGlkYXRlKCk7XG5cdFx0XHRcdHRoaXMudXBkYXRlRWRpdG9yQm9yZGVyQ29sb3IoKTtcblx0XHRcdFx0Y29uc3QgdGhpbmtpbmdTdHIgPVxuXHRcdFx0XHRcdHJlc3VsdC5tb2RlbC5yZWFzb25pbmcgJiYgcmVzdWx0LnRoaW5raW5nTGV2ZWwgIT09IFwib2ZmXCIgPyBgICh0aGlua2luZzogJHtyZXN1bHQudGhpbmtpbmdMZXZlbH0pYCA6IFwiXCI7XG5cdFx0XHRcdHRoaXMuc2hvd1N0YXR1cyhgU3dpdGNoZWQgdG8gJHtyZXN1bHQubW9kZWwubmFtZSB8fCByZXN1bHQubW9kZWwuaWR9JHt0aGlua2luZ1N0cn1gKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0dGhpcy5zaG93RXJyb3IoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHRvZ2dsZVRvb2xPdXRwdXRFeHBhbnNpb24oKTogdm9pZCB7XG5cdFx0dGhpcy5zZXRUb29sc0V4cGFuZGVkKCF0aGlzLnRvb2xPdXRwdXRFeHBhbmRlZCk7XG5cdH1cblxuXHRwcml2YXRlIHNldFRvb2xzRXhwYW5kZWQoZXhwYW5kZWQ6IGJvb2xlYW4pOiB2b2lkIHtcblx0XHR0aGlzLnRvb2xPdXRwdXRFeHBhbmRlZCA9IGV4cGFuZGVkO1xuXHRcdGZvciAoY29uc3QgY2hpbGQgb2YgdGhpcy5jaGF0Q29udGFpbmVyLmNoaWxkcmVuKSB7XG5cdFx0XHRpZiAoaXNFeHBhbmRhYmxlKGNoaWxkKSkge1xuXHRcdFx0XHRjaGlsZC5zZXRFeHBhbmRlZChleHBhbmRlZCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0cHJpdmF0ZSB0b2dnbGVUaGlua2luZ0Jsb2NrVmlzaWJpbGl0eSgpOiB2b2lkIHtcblx0XHR0aGlzLmhpZGVUaGlua2luZ0Jsb2NrID0gIXRoaXMuaGlkZVRoaW5raW5nQmxvY2s7XG5cdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0SGlkZVRoaW5raW5nQmxvY2sodGhpcy5oaWRlVGhpbmtpbmdCbG9jayk7XG5cblx0XHQvLyBSZWJ1aWxkIGNoYXQgZnJvbSBzZXNzaW9uIG1lc3NhZ2VzXG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy5yZWJ1aWxkQ2hhdEZyb21NZXNzYWdlcygpO1xuXG5cdFx0Ly8gSWYgc3RyZWFtaW5nLCByZS1hZGQgdGhlIHN0cmVhbWluZyBjb21wb25lbnQgd2l0aCB1cGRhdGVkIHZpc2liaWxpdHkgYW5kIHJlLXJlbmRlclxuXHRcdGlmICh0aGlzLnN0cmVhbWluZ0NvbXBvbmVudCAmJiB0aGlzLnN0cmVhbWluZ01lc3NhZ2UpIHtcblx0XHRcdHRoaXMuc3RyZWFtaW5nQ29tcG9uZW50LnNldEhpZGVUaGlua2luZ0Jsb2NrKHRoaXMuaGlkZVRoaW5raW5nQmxvY2spO1xuXHRcdFx0dGhpcy5zdHJlYW1pbmdDb21wb25lbnQudXBkYXRlQ29udGVudCh0aGlzLnN0cmVhbWluZ01lc3NhZ2UpO1xuXHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKHRoaXMuc3RyZWFtaW5nQ29tcG9uZW50KTtcblx0XHR9XG5cblx0XHR0aGlzLnNob3dTdGF0dXMoYFRoaW5raW5nIGJsb2NrczogJHt0aGlzLmhpZGVUaGlua2luZ0Jsb2NrID8gXCJoaWRkZW5cIiA6IFwidmlzaWJsZVwifWApO1xuXHR9XG5cblx0cHJpdmF0ZSBvcGVuRXh0ZXJuYWxFZGl0b3IoKTogdm9pZCB7XG5cdFx0Ly8gRGV0ZXJtaW5lIGVkaXRvciAocmVzcGVjdCAkVklTVUFMLCB0aGVuICRFRElUT1IpXG5cdFx0Y29uc3QgZWRpdG9yQ21kID0gcHJvY2Vzcy5lbnYuVklTVUFMIHx8IHByb2Nlc3MuZW52LkVESVRPUjtcblx0XHRpZiAoIWVkaXRvckNtZCkge1xuXHRcdFx0bGV0IG1zZyA9IFwiTm8gZWRpdG9yIGNvbmZpZ3VyZWQuIFNldCAkVklTVUFMIG9yICRFRElUT1IgZW52aXJvbm1lbnQgdmFyaWFibGUuXCI7XG5cdFx0XHRpZiAocHJvY2Vzcy5lbnYuVEVSTV9QUk9HUkFNID09PSBcImlUZXJtLmFwcFwiKSB7XG5cdFx0XHRcdG1zZyArPVxuXHRcdFx0XHRcdFwiXFxuXFxuVGlwOiBJZiB5b3UgbWVhbnQgdG8gb3BlbiB0aGUgR1NEIGRhc2hib2FyZCAoQ3RybCtBbHQrRyksIHNldCBMZWZ0IE9wdGlvbiBLZXkgdG9cIiArXG5cdFx0XHRcdFx0XCIgXFxcIkVzYytcXFwiIGluIGlUZXJtMiBcdTIxOTIgUHJvZmlsZXMgXHUyMTkyIEtleXMuIFdpdGggdGhlIGRlZmF1bHQgXFxcIk5vcm1hbFxcXCIgc2V0dGluZyxcIiArXG5cdFx0XHRcdFx0XCIgQ3RybCtBbHQrRyBzZW5kcyBDdHJsK0cgaW5zdGVhZC5cIjtcblx0XHRcdH1cblx0XHRcdHRoaXMuc2hvd1dhcm5pbmcobXNnKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBjdXJyZW50VGV4dCA9IHRoaXMuZWRpdG9yLmdldEV4cGFuZGVkVGV4dD8uKCkgPz8gdGhpcy5lZGl0b3IuZ2V0VGV4dCgpO1xuXHRcdGNvbnN0IHRtcEZpbGUgPSBwYXRoLmpvaW4ob3MudG1wZGlyKCksIGBwaS1lZGl0b3ItJHtEYXRlLm5vdygpfS5waS5tZGApO1xuXG5cdFx0dHJ5IHtcblx0XHRcdC8vIFdyaXRlIGN1cnJlbnQgY29udGVudCB0byB0ZW1wIGZpbGVcblx0XHRcdGZzLndyaXRlRmlsZVN5bmModG1wRmlsZSwgY3VycmVudFRleHQsIFwidXRmLThcIik7XG5cblx0XHRcdC8vIFN0b3AgVFVJIHRvIHJlbGVhc2UgdGVybWluYWxcblx0XHRcdHRoaXMudWkuc3RvcCgpO1xuXG5cdFx0XHQvLyBTcGxpdCBieSBzcGFjZSB0byBzdXBwb3J0IGVkaXRvciBhcmd1bWVudHMgKGUuZy4sIFwiY29kZSAtLXdhaXRcIilcblx0XHRcdGNvbnN0IFtlZGl0b3IsIC4uLmVkaXRvckFyZ3NdID0gZWRpdG9yQ21kLnNwbGl0KFwiIFwiKTtcblxuXHRcdFx0Ly8gU3Bhd24gZWRpdG9yIHN5bmNocm9ub3VzbHkgd2l0aCBpbmhlcml0ZWQgc3RkaW8gZm9yIGludGVyYWN0aXZlIGVkaXRpbmdcblx0XHRcdGNvbnN0IHJlc3VsdCA9IHNwYXduU3luYyhlZGl0b3IsIFsuLi5lZGl0b3JBcmdzLCB0bXBGaWxlXSwge1xuXHRcdFx0XHRzdGRpbzogXCJpbmhlcml0XCIsXG5cdFx0XHRcdHNoZWxsOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIsXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gT24gc3VjY2Vzc2Z1bCBleGl0IChzdGF0dXMgMCksIHJlcGxhY2UgZWRpdG9yIGNvbnRlbnRcblx0XHRcdGlmIChyZXN1bHQuc3RhdHVzID09PSAwKSB7XG5cdFx0XHRcdGNvbnN0IG5ld0NvbnRlbnQgPSBmcy5yZWFkRmlsZVN5bmModG1wRmlsZSwgXCJ1dGYtOFwiKS5yZXBsYWNlKC9cXG4kLywgXCJcIik7XG5cdFx0XHRcdHRoaXMuZWRpdG9yLnNldFRleHQobmV3Q29udGVudCk7XG5cdFx0XHR9XG5cdFx0XHQvLyBPbiBub24temVybyBleGl0LCBrZWVwIG9yaWdpbmFsIHRleHQgKG5vIGFjdGlvbiBuZWVkZWQpXG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdC8vIENsZWFuIHVwIHRlbXAgZmlsZVxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0ZnMudW5saW5rU3luYyh0bXBGaWxlKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBJZ25vcmUgY2xlYW51cCBlcnJvcnNcblx0XHRcdH1cblxuXHRcdFx0Ly8gUmVzdGFydCBUVUlcblx0XHRcdHRoaXMudWkuc3RhcnQoKTtcblx0XHRcdC8vIEZvcmNlIGZ1bGwgcmUtcmVuZGVyIHNpbmNlIGV4dGVybmFsIGVkaXRvciB1c2VzIGFsdGVybmF0ZSBzY3JlZW5cblx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcih0cnVlKTtcblx0XHR9XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIFVJIGhlbHBlcnNcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdGNsZWFyRWRpdG9yKCk6IHZvaWQge1xuXHRcdHRoaXMuZWRpdG9yLnNldFRleHQoXCJcIik7XG5cdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHRzaG93RXJyb3IoZXJyb3JNZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLmxhc3RCbG9ja2luZ0Vycm9yID0gZXJyb3JNZXNzYWdlO1xuXHRcdHJlbmRlckJsb2NraW5nRXJyb3JCYW5uZXIodGhpcy5ibG9ja2luZ0Vycm9yQ29udGFpbmVyLCB0aGlzLmxhc3RCbG9ja2luZ0Vycm9yKTtcblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KHRoZW1lLmZnKFwiZXJyb3JcIiwgYEVycm9yOiAke2Vycm9yTWVzc2FnZX1gKSwgMSwgMCkpO1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0Y2xlYXJCbG9ja2luZ0Vycm9yKCk6IHZvaWQge1xuXHRcdHRoaXMubGFzdEJsb2NraW5nRXJyb3IgPSB1bmRlZmluZWQ7XG5cdFx0cmVuZGVyQmxvY2tpbmdFcnJvckJhbm5lcih0aGlzLmJsb2NraW5nRXJyb3JDb250YWluZXIsIHVuZGVmaW5lZCk7XG5cdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHRzaG93V2FybmluZyh3YXJuaW5nTWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcIndhcm5pbmdcIiwgYFdhcm5pbmc6ICR7d2FybmluZ01lc3NhZ2V9YCksIDEsIDApKTtcblx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdHNob3dTdWNjZXNzKHN1Y2Nlc3NNZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBEeW5hbWljQm9yZGVyKCh0ZXh0KSA9PiB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgdGV4dCkpKTtcblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQoXG5cdFx0XHRuZXcgVGV4dCh0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgc3VjY2Vzc01lc3NhZ2UpLCAxLCAwKSxcblx0XHQpO1xuXHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgRHluYW1pY0JvcmRlcigodGV4dCkgPT4gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIHRleHQpKSk7XG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0c2hvd1RpcChtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KHRoZW1lLmZnKFwiZGltXCIsIGBcdUQ4M0RcdURDQTEgJHttZXNzYWdlfWApLCAxLCAwKSk7XG5cdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHRnZXRDb250ZXh0UGVyY2VudCgpOiBudW1iZXIgfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLnNlc3Npb24uZ2V0Q29udGV4dFVzYWdlKCk/LnBlcmNlbnQgPz8gdW5kZWZpbmVkO1xuXHR9XG5cblx0c2hvd05ld1ZlcnNpb25Ob3RpZmljYXRpb24obmV3VmVyc2lvbjogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3QgYWN0aW9uID0gdGhlbWUuZmcoXCJhY2NlbnRcIiwgZ2V0VXBkYXRlSW5zdHJ1Y3Rpb24oXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiKSk7XG5cdFx0Y29uc3QgdXBkYXRlSW5zdHJ1Y3Rpb24gPSB0aGVtZS5mZyhcIm11dGVkXCIsIGBOZXcgdmVyc2lvbiAke25ld1ZlcnNpb259IGlzIGF2YWlsYWJsZS4gYCkgKyBhY3Rpb247XG5cdFx0Y29uc3QgY2hhbmdlbG9nVXJsID0gdGhlbWUuZmcoXG5cdFx0XHRcImFjY2VudFwiLFxuXHRcdFx0XCJodHRwczovL2dpdGh1Yi5jb20vYmFkbG9naWMvcGktbW9uby9ibG9iL21haW4vcGFja2FnZXMvY29kaW5nLWFnZW50L0NIQU5HRUxPRy5tZFwiLFxuXHRcdCk7XG5cdFx0Y29uc3QgY2hhbmdlbG9nTGluZSA9IHRoZW1lLmZnKFwibXV0ZWRcIiwgXCJDaGFuZ2Vsb2c6IFwiKSArIGNoYW5nZWxvZ1VybDtcblxuXHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IER5bmFtaWNCb3JkZXIoKHRleHQpID0+IHRoZW1lLmZnKFwid2FybmluZ1wiLCB0ZXh0KSkpO1xuXHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdG5ldyBUZXh0KFxuXHRcdFx0XHRgJHt0aGVtZS5ib2xkKHRoZW1lLmZnKFwid2FybmluZ1wiLCBcIlVwZGF0ZSBBdmFpbGFibGVcIikpfVxcbiR7dXBkYXRlSW5zdHJ1Y3Rpb259XFxuJHtjaGFuZ2Vsb2dMaW5lfWAsXG5cdFx0XHRcdDEsXG5cdFx0XHRcdDAsXG5cdFx0XHQpLFxuXHRcdCk7XG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBEeW5hbWljQm9yZGVyKCh0ZXh0KSA9PiB0aGVtZS5mZyhcIndhcm5pbmdcIiwgdGV4dCkpKTtcblx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgYWxsIHF1ZXVlZCBtZXNzYWdlcyAocmVhZC1vbmx5KS5cblx0ICogQ29tYmluZXMgc2Vzc2lvbiBxdWV1ZSBhbmQgY29tcGFjdGlvbiBxdWV1ZS5cblx0ICovXG5cdHByaXZhdGUgZ2V0QWxsUXVldWVkTWVzc2FnZXMoKTogeyBzdGVlcmluZzogc3RyaW5nW107IGZvbGxvd1VwOiBzdHJpbmdbXSB9IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0c3RlZXJpbmc6IFtcblx0XHRcdFx0Li4udGhpcy5zZXNzaW9uLmdldFN0ZWVyaW5nTWVzc2FnZXMoKSxcblx0XHRcdFx0Li4udGhpcy5jb21wYWN0aW9uUXVldWVkTWVzc2FnZXMuZmlsdGVyKChtc2cpID0+IG1zZy5tb2RlID09PSBcInN0ZWVyXCIpLm1hcCgobXNnKSA9PiBtc2cudGV4dCksXG5cdFx0XHRdLFxuXHRcdFx0Zm9sbG93VXA6IFtcblx0XHRcdFx0Li4udGhpcy5zZXNzaW9uLmdldEZvbGxvd1VwTWVzc2FnZXMoKSxcblx0XHRcdFx0Li4udGhpcy5jb21wYWN0aW9uUXVldWVkTWVzc2FnZXMuZmlsdGVyKChtc2cpID0+IG1zZy5tb2RlID09PSBcImZvbGxvd1VwXCIpLm1hcCgobXNnKSA9PiBtc2cudGV4dCksXG5cdFx0XHRdLFxuXHRcdH07XG5cdH1cblxuXHQvKipcblx0ICogQ2xlYXIgYWxsIHF1ZXVlZCBtZXNzYWdlcyBhbmQgcmV0dXJuIHRoZWlyIGNvbnRlbnRzLlxuXHQgKiBDbGVhcnMgYm90aCBzZXNzaW9uIHF1ZXVlIGFuZCBjb21wYWN0aW9uIHF1ZXVlLlxuXHQgKi9cblx0cHJpdmF0ZSBjbGVhckFsbFF1ZXVlcygpOiB7IHN0ZWVyaW5nOiBzdHJpbmdbXTsgZm9sbG93VXA6IHN0cmluZ1tdIH0ge1xuXHRcdGNvbnN0IHsgc3RlZXJpbmcsIGZvbGxvd1VwIH0gPSB0aGlzLnNlc3Npb24uY2xlYXJRdWV1ZSgpO1xuXHRcdGNvbnN0IGNvbXBhY3Rpb25TdGVlcmluZyA9IHRoaXMuY29tcGFjdGlvblF1ZXVlZE1lc3NhZ2VzXG5cdFx0XHQuZmlsdGVyKChtc2cpID0+IG1zZy5tb2RlID09PSBcInN0ZWVyXCIpXG5cdFx0XHQubWFwKChtc2cpID0+IG1zZy50ZXh0KTtcblx0XHRjb25zdCBjb21wYWN0aW9uRm9sbG93VXAgPSB0aGlzLmNvbXBhY3Rpb25RdWV1ZWRNZXNzYWdlc1xuXHRcdFx0LmZpbHRlcigobXNnKSA9PiBtc2cubW9kZSA9PT0gXCJmb2xsb3dVcFwiKVxuXHRcdFx0Lm1hcCgobXNnKSA9PiBtc2cudGV4dCk7XG5cdFx0dGhpcy5jb21wYWN0aW9uUXVldWVkTWVzc2FnZXMgPSBbXTtcblx0XHRyZXR1cm4ge1xuXHRcdFx0c3RlZXJpbmc6IFsuLi5zdGVlcmluZywgLi4uY29tcGFjdGlvblN0ZWVyaW5nXSxcblx0XHRcdGZvbGxvd1VwOiBbLi4uZm9sbG93VXAsIC4uLmNvbXBhY3Rpb25Gb2xsb3dVcF0sXG5cdFx0fTtcblx0fVxuXG5cdHByaXZhdGUgdXBkYXRlUGVuZGluZ01lc3NhZ2VzRGlzcGxheSgpOiB2b2lkIHtcblx0XHR0aGlzLnBlbmRpbmdNZXNzYWdlc0NvbnRhaW5lci5jbGVhcigpO1xuXHRcdGNvbnN0IHsgc3RlZXJpbmc6IHN0ZWVyaW5nTWVzc2FnZXMsIGZvbGxvd1VwOiBmb2xsb3dVcE1lc3NhZ2VzIH0gPSB0aGlzLmdldEFsbFF1ZXVlZE1lc3NhZ2VzKCk7XG5cdFx0aWYgKHN0ZWVyaW5nTWVzc2FnZXMubGVuZ3RoID4gMCB8fCBmb2xsb3dVcE1lc3NhZ2VzLmxlbmd0aCA+IDApIHtcblx0XHRcdHRoaXMucGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0Zm9yIChjb25zdCBtZXNzYWdlIG9mIHN0ZWVyaW5nTWVzc2FnZXMpIHtcblx0XHRcdFx0Y29uc3QgdGV4dCA9IHRoZW1lLmZnKFwiZGltXCIsIGBTdGVlcmluZzogJHttZXNzYWdlfWApO1xuXHRcdFx0XHR0aGlzLnBlbmRpbmdNZXNzYWdlc0NvbnRhaW5lci5hZGRDaGlsZChuZXcgVHJ1bmNhdGVkVGV4dCh0ZXh0LCAxLCAwKSk7XG5cdFx0XHR9XG5cdFx0XHRmb3IgKGNvbnN0IG1lc3NhZ2Ugb2YgZm9sbG93VXBNZXNzYWdlcykge1xuXHRcdFx0XHRjb25zdCB0ZXh0ID0gdGhlbWUuZmcoXCJkaW1cIiwgYEZvbGxvdy11cDogJHttZXNzYWdlfWApO1xuXHRcdFx0XHR0aGlzLnBlbmRpbmdNZXNzYWdlc0NvbnRhaW5lci5hZGRDaGlsZChuZXcgVHJ1bmNhdGVkVGV4dCh0ZXh0LCAxLCAwKSk7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBkZXF1ZXVlSGludCA9IGdldEFwcEtleURpc3BsYXkodGhpcy5rZXliaW5kaW5ncywgXCJkZXF1ZXVlXCIpO1xuXHRcdFx0Y29uc3QgaGludFRleHQgPSB0aGVtZS5mZyhcImRpbVwiLCBgXHUyMUIzICR7ZGVxdWV1ZUhpbnR9IHRvIGVkaXQgYWxsIHF1ZXVlZCBtZXNzYWdlc2ApO1xuXHRcdFx0dGhpcy5wZW5kaW5nTWVzc2FnZXNDb250YWluZXIuYWRkQ2hpbGQobmV3IFRydW5jYXRlZFRleHQoaGludFRleHQsIDEsIDApKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHJlc3RvcmVRdWV1ZWRNZXNzYWdlc1RvRWRpdG9yKG9wdGlvbnM/OiB7IGFib3J0PzogYm9vbGVhbjsgY3VycmVudFRleHQ/OiBzdHJpbmcgfSk6IG51bWJlciB7XG5cdFx0Y29uc3QgeyBzdGVlcmluZywgZm9sbG93VXAgfSA9IHRoaXMuY2xlYXJBbGxRdWV1ZXMoKTtcblx0XHRjb25zdCBhbGxRdWV1ZWQgPSBbLi4uc3RlZXJpbmcsIC4uLmZvbGxvd1VwXTtcblx0XHRpZiAoYWxsUXVldWVkLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dGhpcy51cGRhdGVQZW5kaW5nTWVzc2FnZXNEaXNwbGF5KCk7XG5cdFx0XHRpZiAob3B0aW9ucz8uYWJvcnQpIHtcblx0XHRcdFx0XHR0aGlzLmFnZW50LmFib3J0KFwidXNlclwiKTtcblx0XHRcdH1cblx0XHRcdHJldHVybiAwO1xuXHRcdH1cblx0XHRjb25zdCBxdWV1ZWRUZXh0ID0gYWxsUXVldWVkLmpvaW4oXCJcXG5cXG5cIik7XG5cdFx0Y29uc3QgY3VycmVudFRleHQgPSBvcHRpb25zPy5jdXJyZW50VGV4dCA/PyB0aGlzLmVkaXRvci5nZXRUZXh0KCk7XG5cdFx0Y29uc3QgY29tYmluZWRUZXh0ID0gW3F1ZXVlZFRleHQsIGN1cnJlbnRUZXh0XS5maWx0ZXIoKHQpID0+IHQudHJpbSgpKS5qb2luKFwiXFxuXFxuXCIpO1xuXHRcdHRoaXMuZWRpdG9yLnNldFRleHQoY29tYmluZWRUZXh0KTtcblx0XHR0aGlzLnVwZGF0ZVBlbmRpbmdNZXNzYWdlc0Rpc3BsYXkoKTtcblx0XHRpZiAob3B0aW9ucz8uYWJvcnQpIHtcblx0XHRcdFx0dGhpcy5hZ2VudC5hYm9ydChcInVzZXJcIik7XG5cdFx0fVxuXHRcdHJldHVybiBhbGxRdWV1ZWQubGVuZ3RoO1xuXHR9XG5cblx0cHJpdmF0ZSBxdWV1ZUNvbXBhY3Rpb25NZXNzYWdlKHRleHQ6IHN0cmluZywgbW9kZTogXCJzdGVlclwiIHwgXCJmb2xsb3dVcFwiKTogdm9pZCB7XG5cdFx0aWYgKHRleHQuc3RhcnRzV2l0aChcIi9cIikgJiYgIXRoaXMuaXNLbm93blNsYXNoQ29tbWFuZCh0ZXh0KSkge1xuXHRcdFx0Y29uc3QgY29tbWFuZCA9IHRleHQuc3BsaXQoL1xccy8pWzBdO1xuXHRcdFx0dGhpcy5zaG93RXJyb3IoYFVua25vd24gY29tbWFuZDogJHtjb21tYW5kfS4gVXNlIHNsYXNoIGF1dG9jb21wbGV0ZSB0byBzZWUgYXZhaWxhYmxlIGNvbW1hbmRzLmApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRoaXMuY29tcGFjdGlvblF1ZXVlZE1lc3NhZ2VzLnB1c2goeyB0ZXh0LCBtb2RlIH0pO1xuXHRcdHRoaXMuZWRpdG9yLmFkZFRvSGlzdG9yeT8uKHRleHQpO1xuXHRcdHRoaXMuZWRpdG9yLnNldFRleHQoXCJcIik7XG5cdFx0dGhpcy51cGRhdGVQZW5kaW5nTWVzc2FnZXNEaXNwbGF5KCk7XG5cdFx0dGhpcy5zaG93U3RhdHVzKFwiUXVldWVkIG1lc3NhZ2UgZm9yIGFmdGVyIGNvbXBhY3Rpb25cIik7XG5cdH1cblxuXHRwcml2YXRlIGlzRXh0ZW5zaW9uQ29tbWFuZCh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcblx0XHRpZiAoIXRleHQuc3RhcnRzV2l0aChcIi9cIikpIHJldHVybiBmYWxzZTtcblxuXHRcdGNvbnN0IGV4dGVuc2lvblJ1bm5lciA9IHRoaXMuc2Vzc2lvbi5leHRlbnNpb25SdW5uZXI7XG5cdFx0aWYgKCFleHRlbnNpb25SdW5uZXIpIHJldHVybiBmYWxzZTtcblxuXHRcdGNvbnN0IHNwYWNlSW5kZXggPSB0ZXh0LmluZGV4T2YoXCIgXCIpO1xuXHRcdGNvbnN0IGNvbW1hbmROYW1lID0gc3BhY2VJbmRleCA9PT0gLTEgPyB0ZXh0LnNsaWNlKDEpIDogdGV4dC5zbGljZSgxLCBzcGFjZUluZGV4KTtcblx0XHRyZXR1cm4gISFleHRlbnNpb25SdW5uZXIuZ2V0Q29tbWFuZChjb21tYW5kTmFtZSk7XG5cdH1cblxuXHRwcml2YXRlIGlzS25vd25TbGFzaENvbW1hbmQodGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0aWYgKCF0ZXh0LnN0YXJ0c1dpdGgoXCIvXCIpKSByZXR1cm4gZmFsc2U7XG5cblx0XHRjb25zdCBzcGFjZUluZGV4ID0gdGV4dC5pbmRleE9mKFwiIFwiKTtcblx0XHRjb25zdCBjb21tYW5kTmFtZSA9IHNwYWNlSW5kZXggPT09IC0xID8gdGV4dC5zbGljZSgxKSA6IHRleHQuc2xpY2UoMSwgc3BhY2VJbmRleCk7XG5cblx0XHRpZiAoQlVJTFRJTl9TTEFTSF9DT01NQU5EUy5zb21lKChjb21tYW5kKSA9PiBjb21tYW5kLm5hbWUgPT09IGNvbW1hbmROYW1lKSkge1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fVxuXG5cdFx0aWYgKHRoaXMuaXNFeHRlbnNpb25Db21tYW5kKHRleHQpKSB7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9XG5cblx0XHRpZiAodGhpcy5zZXNzaW9uLnByb21wdFRlbXBsYXRlcy5zb21lKCh0ZW1wbGF0ZSkgPT4gdGVtcGxhdGUubmFtZSA9PT0gY29tbWFuZE5hbWUpKSB7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9XG5cblx0XHRpZiAoY29tbWFuZE5hbWUuc3RhcnRzV2l0aChcInNraWxsOlwiKSAmJiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRFbmFibGVTa2lsbENvbW1hbmRzKCkpIHtcblx0XHRcdGNvbnN0IHNraWxsTmFtZSA9IGNvbW1hbmROYW1lLnNsaWNlKFwic2tpbGw6XCIubGVuZ3RoKTtcblx0XHRcdHJldHVybiB0aGlzLnNlc3Npb24ucmVzb3VyY2VMb2FkZXIuZ2V0U2tpbGxzKCkuc2tpbGxzLnNvbWUoKHNraWxsKSA9PiBza2lsbC5uYW1lID09PSBza2lsbE5hbWUpO1xuXHRcdH1cblxuXHRcdHJldHVybiBmYWxzZTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgZmx1c2hDb21wYWN0aW9uUXVldWUob3B0aW9ucz86IHsgd2lsbFJldHJ5PzogYm9vbGVhbiB9KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMuY29tcGFjdGlvblF1ZXVlZE1lc3NhZ2VzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHF1ZXVlZE1lc3NhZ2VzID0gWy4uLnRoaXMuY29tcGFjdGlvblF1ZXVlZE1lc3NhZ2VzXTtcblx0XHR0aGlzLmNvbXBhY3Rpb25RdWV1ZWRNZXNzYWdlcyA9IFtdO1xuXHRcdHRoaXMudXBkYXRlUGVuZGluZ01lc3NhZ2VzRGlzcGxheSgpO1xuXG5cdFx0Y29uc3QgcmVzdG9yZVF1ZXVlID0gKGVycm9yOiB1bmtub3duKSA9PiB7XG5cdFx0XHR0aGlzLnNlc3Npb24uY2xlYXJRdWV1ZSgpO1xuXHRcdFx0dGhpcy5jb21wYWN0aW9uUXVldWVkTWVzc2FnZXMgPSBxdWV1ZWRNZXNzYWdlcztcblx0XHRcdHRoaXMudXBkYXRlUGVuZGluZ01lc3NhZ2VzRGlzcGxheSgpO1xuXHRcdFx0dGhpcy5zaG93RXJyb3IoXG5cdFx0XHRcdGBGYWlsZWQgdG8gc2VuZCBxdWV1ZWQgbWVzc2FnZSR7cXVldWVkTWVzc2FnZXMubGVuZ3RoID4gMSA/IFwic1wiIDogXCJcIn06ICR7XG5cdFx0XHRcdFx0ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpXG5cdFx0XHRcdH1gLFxuXHRcdFx0KTtcblx0XHR9O1xuXG5cdFx0dHJ5IHtcblx0XHRcdGlmIChvcHRpb25zPy53aWxsUmV0cnkpIHtcblx0XHRcdFx0Ly8gV2hlbiByZXRyeSBpcyBwZW5kaW5nLCBxdWV1ZSBtZXNzYWdlcyBmb3IgdGhlIHJldHJ5IHR1cm5cblx0XHRcdFx0Zm9yIChjb25zdCBtZXNzYWdlIG9mIHF1ZXVlZE1lc3NhZ2VzKSB7XG5cdFx0XHRcdFx0aWYgKHRoaXMuaXNFeHRlbnNpb25Db21tYW5kKG1lc3NhZ2UudGV4dCkpIHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMuc2Vzc2lvbi5wcm9tcHQobWVzc2FnZS50ZXh0KTtcblx0XHRcdFx0XHR9IGVsc2UgaWYgKG1lc3NhZ2UubW9kZSA9PT0gXCJmb2xsb3dVcFwiKSB7XG5cdFx0XHRcdFx0XHRhd2FpdCB0aGlzLnNlc3Npb24uZm9sbG93VXAobWVzc2FnZS50ZXh0KTtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0YXdhaXQgdGhpcy5zZXNzaW9uLnN0ZWVyKG1lc3NhZ2UudGV4dCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdHRoaXMudXBkYXRlUGVuZGluZ01lc3NhZ2VzRGlzcGxheSgpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdC8vIEZpbmQgZmlyc3Qgbm9uLWV4dGVuc2lvbi1jb21tYW5kIG1lc3NhZ2UgdG8gdXNlIGFzIHByb21wdFxuXHRcdFx0Y29uc3QgZmlyc3RQcm9tcHRJbmRleCA9IHF1ZXVlZE1lc3NhZ2VzLmZpbmRJbmRleCgobWVzc2FnZSkgPT4gIXRoaXMuaXNFeHRlbnNpb25Db21tYW5kKG1lc3NhZ2UudGV4dCkpO1xuXHRcdFx0aWYgKGZpcnN0UHJvbXB0SW5kZXggPT09IC0xKSB7XG5cdFx0XHRcdC8vIEFsbCBleHRlbnNpb24gY29tbWFuZHMgLSBleGVjdXRlIHRoZW0gYWxsXG5cdFx0XHRcdGZvciAoY29uc3QgbWVzc2FnZSBvZiBxdWV1ZWRNZXNzYWdlcykge1xuXHRcdFx0XHRcdGF3YWl0IHRoaXMuc2Vzc2lvbi5wcm9tcHQobWVzc2FnZS50ZXh0KTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdC8vIEV4ZWN1dGUgYW55IGV4dGVuc2lvbiBjb21tYW5kcyBiZWZvcmUgdGhlIGZpcnN0IHByb21wdFxuXHRcdFx0Y29uc3QgcHJlQ29tbWFuZHMgPSBxdWV1ZWRNZXNzYWdlcy5zbGljZSgwLCBmaXJzdFByb21wdEluZGV4KTtcblx0XHRcdGNvbnN0IGZpcnN0UHJvbXB0ID0gcXVldWVkTWVzc2FnZXNbZmlyc3RQcm9tcHRJbmRleF07XG5cdFx0XHRjb25zdCByZXN0ID0gcXVldWVkTWVzc2FnZXMuc2xpY2UoZmlyc3RQcm9tcHRJbmRleCArIDEpO1xuXG5cdFx0XHRmb3IgKGNvbnN0IG1lc3NhZ2Ugb2YgcHJlQ29tbWFuZHMpIHtcblx0XHRcdFx0YXdhaXQgdGhpcy5zZXNzaW9uLnByb21wdChtZXNzYWdlLnRleHQpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBTZW5kIGZpcnN0IHByb21wdCAoc3RhcnRzIHN0cmVhbWluZylcblx0XHRcdGNvbnN0IHByb21wdFByb21pc2UgPSB0aGlzLnNlc3Npb24ucHJvbXB0KGZpcnN0UHJvbXB0LnRleHQpLmNhdGNoKChlcnJvcikgPT4ge1xuXHRcdFx0XHRyZXN0b3JlUXVldWUoZXJyb3IpO1xuXHRcdFx0fSk7XG5cblx0XHRcdC8vIFF1ZXVlIHJlbWFpbmluZyBtZXNzYWdlc1xuXHRcdFx0Zm9yIChjb25zdCBtZXNzYWdlIG9mIHJlc3QpIHtcblx0XHRcdFx0aWYgKHRoaXMuaXNFeHRlbnNpb25Db21tYW5kKG1lc3NhZ2UudGV4dCkpIHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnNlc3Npb24ucHJvbXB0KG1lc3NhZ2UudGV4dCk7XG5cdFx0XHRcdH0gZWxzZSBpZiAobWVzc2FnZS5tb2RlID09PSBcImZvbGxvd1VwXCIpIHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnNlc3Npb24uZm9sbG93VXAobWVzc2FnZS50ZXh0KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnNlc3Npb24uc3RlZXIobWVzc2FnZS50ZXh0KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0dGhpcy51cGRhdGVQZW5kaW5nTWVzc2FnZXNEaXNwbGF5KCk7XG5cdFx0XHR2b2lkIHByb21wdFByb21pc2U7XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdHJlc3RvcmVRdWV1ZShlcnJvcik7XG5cdFx0fVxuXHR9XG5cblx0LyoqIE1vdmUgcGVuZGluZyBiYXNoIGNvbXBvbmVudHMgZnJvbSBwZW5kaW5nIGFyZWEgdG8gY2hhdCAqL1xuXHRwcml2YXRlIGZsdXNoUGVuZGluZ0Jhc2hDb21wb25lbnRzKCk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgY29tcG9uZW50IG9mIHRoaXMucGVuZGluZ0Jhc2hDb21wb25lbnRzKSB7XG5cdFx0XHR0aGlzLnBlbmRpbmdNZXNzYWdlc0NvbnRhaW5lci5yZW1vdmVDaGlsZChjb21wb25lbnQpO1xuXHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKGNvbXBvbmVudCk7XG5cdFx0fVxuXHRcdHRoaXMucGVuZGluZ0Jhc2hDb21wb25lbnRzID0gW107XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIFNlbGVjdG9yc1xuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIFNob3dzIGEgc2VsZWN0b3IgY29tcG9uZW50IGluIHBsYWNlIG9mIHRoZSBlZGl0b3IuXG5cdCAqIEBwYXJhbSBjcmVhdGUgRmFjdG9yeSB0aGF0IHJlY2VpdmVzIGEgYGRvbmVgIGNhbGxiYWNrIGFuZCByZXR1cm5zIHRoZSBjb21wb25lbnQgYW5kIGZvY3VzIHRhcmdldFxuXHQgKi9cblx0cHJpdmF0ZSBzaG93U2VsZWN0b3IoY3JlYXRlOiAoZG9uZTogKCkgPT4gdm9pZCkgPT4geyBjb21wb25lbnQ6IENvbXBvbmVudDsgZm9jdXM6IENvbXBvbmVudCB9KTogdm9pZCB7XG5cdFx0Y29uc3QgZG9uZSA9ICgpID0+IHtcblx0XHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5hZGRDaGlsZCh0aGlzLmVkaXRvcik7XG5cdFx0XHR0aGlzLnVpLnNldEZvY3VzKHRoaXMuZWRpdG9yKTtcblx0XHR9O1xuXHRcdGNvbnN0IHsgY29tcG9uZW50LCBmb2N1cyB9ID0gY3JlYXRlKGRvbmUpO1xuXHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy5lZGl0b3JDb250YWluZXIuYWRkQ2hpbGQoY29tcG9uZW50KTtcblx0XHR0aGlzLnVpLnNldEZvY3VzKGZvY3VzKTtcblx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0fVxuXG5cdHByaXZhdGUgc2hvd1NldHRpbmdzU2VsZWN0b3IoKTogdm9pZCB7XG5cdFx0dGhpcy5zaG93U2VsZWN0b3IoKGRvbmUpID0+IHtcblx0XHRcdGNvbnN0IHNlbGVjdG9yID0gbmV3IFNldHRpbmdzU2VsZWN0b3JDb21wb25lbnQoXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRhdXRvQ29tcGFjdDogdGhpcy5zZXNzaW9uLmF1dG9Db21wYWN0aW9uRW5hYmxlZCxcblx0XHRcdFx0XHRzaG93SW1hZ2VzOiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRTaG93SW1hZ2VzKCksXG5cdFx0XHRcdFx0YXV0b1Jlc2l6ZUltYWdlczogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0SW1hZ2VBdXRvUmVzaXplKCksXG5cdFx0XHRcdFx0YmxvY2tJbWFnZXM6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldEJsb2NrSW1hZ2VzKCksXG5cdFx0XHRcdFx0ZW5hYmxlU2tpbGxDb21tYW5kczogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0RW5hYmxlU2tpbGxDb21tYW5kcygpLFxuXHRcdFx0XHRcdHN0ZWVyaW5nTW9kZTogdGhpcy5zZXNzaW9uLnN0ZWVyaW5nTW9kZSxcblx0XHRcdFx0XHRmb2xsb3dVcE1vZGU6IHRoaXMuc2Vzc2lvbi5mb2xsb3dVcE1vZGUsXG5cdFx0XHRcdFx0dHJhbnNwb3J0OiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRUcmFuc3BvcnQoKSxcblx0XHRcdFx0XHR0aGlua2luZ0xldmVsOiB0aGlzLnNlc3Npb24udGhpbmtpbmdMZXZlbCxcblx0XHRcdFx0XHRhdmFpbGFibGVUaGlua2luZ0xldmVsczogdGhpcy5zZXNzaW9uLmdldEF2YWlsYWJsZVRoaW5raW5nTGV2ZWxzKCksXG5cdFx0XHRcdFx0Y3VycmVudFRoZW1lOiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRUaGVtZSgpIHx8IFwiZGFya1wiLFxuXHRcdFx0XHRcdGF2YWlsYWJsZVRoZW1lczogZ2V0QXZhaWxhYmxlVGhlbWVzKCksXG5cdFx0XHRcdFx0aGlkZVRoaW5raW5nQmxvY2s6IHRoaXMuaGlkZVRoaW5raW5nQmxvY2ssXG5cdFx0XHRcdFx0Y29sbGFwc2VDaGFuZ2Vsb2c6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldENvbGxhcHNlQ2hhbmdlbG9nKCksXG5cdFx0XHRcdFx0ZG91YmxlRXNjYXBlQWN0aW9uOiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXREb3VibGVFc2NhcGVBY3Rpb24oKSxcblx0XHRcdFx0XHR0cmVlRmlsdGVyTW9kZTogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0VHJlZUZpbHRlck1vZGUoKSxcblx0XHRcdFx0XHRzaG93SGFyZHdhcmVDdXJzb3I6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldFNob3dIYXJkd2FyZUN1cnNvcigpLFxuXHRcdFx0XHRcdGVkaXRvclBhZGRpbmdYOiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRFZGl0b3JQYWRkaW5nWCgpLFxuXHRcdFx0XHRcdGF1dG9jb21wbGV0ZU1heFZpc2libGU6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldEF1dG9jb21wbGV0ZU1heFZpc2libGUoKSxcblx0XHRcdFx0XHRyZXNwZWN0R2l0aWdub3JlSW5QaWNrZXI6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldFJlc3BlY3RHaXRpZ25vcmVJblBpY2tlcigpLFxuXHRcdFx0XHRcdHF1aWV0U3RhcnR1cDogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0UXVpZXRTdGFydHVwKCksXG5cdFx0XHRcdFx0Y2xlYXJPblNocmluazogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0Q2xlYXJPblNocmluaygpLFxuXHRcdFx0XHRcdHRpbWVzdGFtcEZvcm1hdDogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0VGltZXN0YW1wRm9ybWF0KCksXG5cdFx0XHRcdFx0YWRhcHRpdmVNb2RlOiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRBZGFwdGl2ZU1vZGUoKSxcblx0XHRcdFx0fSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdG9uQXV0b0NvbXBhY3RDaGFuZ2U6IChlbmFibGVkKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLnNlc3Npb24uc2V0QXV0b0NvbXBhY3Rpb25FbmFibGVkKGVuYWJsZWQpO1xuXHRcdFx0XHRcdFx0dGhpcy5mb290ZXIuc2V0QXV0b0NvbXBhY3RFbmFibGVkKGVuYWJsZWQpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25TaG93SW1hZ2VzQ2hhbmdlOiAoZW5hYmxlZCkgPT4ge1xuXHRcdFx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0U2hvd0ltYWdlcyhlbmFibGVkKTtcblx0XHRcdFx0XHRcdGZvciAoY29uc3QgY2hpbGQgb2YgdGhpcy5jaGF0Q29udGFpbmVyLmNoaWxkcmVuKSB7XG5cdFx0XHRcdFx0XHRcdGlmIChjaGlsZCBpbnN0YW5jZW9mIFRvb2xFeGVjdXRpb25Db21wb25lbnQpIHtcblx0XHRcdFx0XHRcdFx0XHRjaGlsZC5zZXRTaG93SW1hZ2VzKGVuYWJsZWQpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRvbkF1dG9SZXNpemVJbWFnZXNDaGFuZ2U6IChlbmFibGVkKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRJbWFnZUF1dG9SZXNpemUoZW5hYmxlZCk7XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRvbkJsb2NrSW1hZ2VzQ2hhbmdlOiAoYmxvY2tlZCkgPT4ge1xuXHRcdFx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0QmxvY2tJbWFnZXMoYmxvY2tlZCk7XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRvbkVuYWJsZVNraWxsQ29tbWFuZHNDaGFuZ2U6IChlbmFibGVkKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRFbmFibGVTa2lsbENvbW1hbmRzKGVuYWJsZWQpO1xuXHRcdFx0XHRcdFx0dGhpcy5zZXR1cEF1dG9jb21wbGV0ZSgpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25TdGVlcmluZ01vZGVDaGFuZ2U6IChtb2RlKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLnNlc3Npb24uc2V0U3RlZXJpbmdNb2RlKG1vZGUpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25Gb2xsb3dVcE1vZGVDaGFuZ2U6IChtb2RlKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLnNlc3Npb24uc2V0Rm9sbG93VXBNb2RlKG1vZGUpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25UcmFuc3BvcnRDaGFuZ2U6ICh0cmFuc3BvcnQpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldFRyYW5zcG9ydCh0cmFuc3BvcnQpO1xuXHRcdFx0XHRcdFx0dGhpcy5zZXNzaW9uLmFnZW50LnNldFRyYW5zcG9ydCh0cmFuc3BvcnQpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25UaGlua2luZ0xldmVsQ2hhbmdlOiAobGV2ZWwpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMuc2Vzc2lvbi5zZXRUaGlua2luZ0xldmVsKGxldmVsKTtcblx0XHRcdFx0XHRcdHRoaXMuZm9vdGVyLmludmFsaWRhdGUoKTtcblx0XHRcdFx0XHRcdHRoaXMudXBkYXRlRWRpdG9yQm9yZGVyQ29sb3IoKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG9uVGhlbWVDaGFuZ2U6ICh0aGVtZU5hbWUpID0+IHtcblx0XHRcdFx0XHRcdGNvbnN0IHJlc3VsdCA9IHNldFRoZW1lKHRoZW1lTmFtZSwgdHJ1ZSk7XG5cdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRUaGVtZSh0aGVtZU5hbWUpO1xuXHRcdFx0XHRcdFx0dGhpcy51aS5pbnZhbGlkYXRlKCk7XG5cdFx0XHRcdFx0XHRpZiAoIXJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMuc2hvd0Vycm9yKGBGYWlsZWQgdG8gbG9hZCB0aGVtZSBcIiR7dGhlbWVOYW1lfVwiOiAke3Jlc3VsdC5lcnJvcn1cXG5GZWxsIGJhY2sgdG8gZGFyayB0aGVtZS5gKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG9uVGhlbWVQcmV2aWV3OiAodGhlbWVOYW1lKSA9PiB7XG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBzZXRUaGVtZSh0aGVtZU5hbWUsIHRydWUpO1xuXHRcdFx0XHRcdFx0aWYgKHJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMudWkuaW52YWxpZGF0ZSgpO1xuXHRcdFx0XHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG9uSGlkZVRoaW5raW5nQmxvY2tDaGFuZ2U6IChoaWRkZW4pID0+IHtcblx0XHRcdFx0XHRcdHRoaXMuaGlkZVRoaW5raW5nQmxvY2sgPSBoaWRkZW47XG5cdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRIaWRlVGhpbmtpbmdCbG9jayhoaWRkZW4pO1xuXHRcdFx0XHRcdFx0Zm9yIChjb25zdCBjaGlsZCBvZiB0aGlzLmNoYXRDb250YWluZXIuY2hpbGRyZW4pIHtcblx0XHRcdFx0XHRcdFx0aWYgKGNoaWxkIGluc3RhbmNlb2YgQXNzaXN0YW50TWVzc2FnZUNvbXBvbmVudCkge1xuXHRcdFx0XHRcdFx0XHRcdGNoaWxkLnNldEhpZGVUaGlua2luZ0Jsb2NrKGhpZGRlbik7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5jbGVhcigpO1xuXHRcdFx0XHRcdFx0dGhpcy5yZWJ1aWxkQ2hhdEZyb21NZXNzYWdlcygpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25Db2xsYXBzZUNoYW5nZWxvZ0NoYW5nZTogKGNvbGxhcHNlZCkgPT4ge1xuXHRcdFx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0Q29sbGFwc2VDaGFuZ2Vsb2coY29sbGFwc2VkKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG9uUXVpZXRTdGFydHVwQ2hhbmdlOiAoZW5hYmxlZCkgPT4ge1xuXHRcdFx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0UXVpZXRTdGFydHVwKGVuYWJsZWQpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25Eb3VibGVFc2NhcGVBY3Rpb25DaGFuZ2U6IChhY3Rpb24pID0+IHtcblx0XHRcdFx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldERvdWJsZUVzY2FwZUFjdGlvbihhY3Rpb24pO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25UcmVlRmlsdGVyTW9kZUNoYW5nZTogKG1vZGUpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldFRyZWVGaWx0ZXJNb2RlKG1vZGUpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25TaG93SGFyZHdhcmVDdXJzb3JDaGFuZ2U6IChlbmFibGVkKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRTaG93SGFyZHdhcmVDdXJzb3IoZW5hYmxlZCk7XG5cdFx0XHRcdFx0XHR0aGlzLnVpLnNldFNob3dIYXJkd2FyZUN1cnNvcihlbmFibGVkKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG9uRWRpdG9yUGFkZGluZ1hDaGFuZ2U6IChwYWRkaW5nKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRFZGl0b3JQYWRkaW5nWChwYWRkaW5nKTtcblx0XHRcdFx0XHRcdHRoaXMuZGVmYXVsdEVkaXRvci5zZXRQYWRkaW5nWChwYWRkaW5nKTtcblx0XHRcdFx0XHRcdGlmICh0aGlzLmVkaXRvciAhPT0gdGhpcy5kZWZhdWx0RWRpdG9yICYmIHRoaXMuZWRpdG9yLnNldFBhZGRpbmdYICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRcdFx0dGhpcy5lZGl0b3Iuc2V0UGFkZGluZ1gocGFkZGluZyk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRvbkF1dG9jb21wbGV0ZU1heFZpc2libGVDaGFuZ2U6IChtYXhWaXNpYmxlKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRBdXRvY29tcGxldGVNYXhWaXNpYmxlKG1heFZpc2libGUpO1xuXHRcdFx0XHRcdFx0dGhpcy5kZWZhdWx0RWRpdG9yLnNldEF1dG9jb21wbGV0ZU1heFZpc2libGUobWF4VmlzaWJsZSk7XG5cdFx0XHRcdFx0XHRpZiAodGhpcy5lZGl0b3IgIT09IHRoaXMuZGVmYXVsdEVkaXRvciAmJiB0aGlzLmVkaXRvci5zZXRBdXRvY29tcGxldGVNYXhWaXNpYmxlICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRcdFx0dGhpcy5lZGl0b3Iuc2V0QXV0b2NvbXBsZXRlTWF4VmlzaWJsZShtYXhWaXNpYmxlKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG9uQ2xlYXJPblNocmlua0NoYW5nZTogKGVuYWJsZWQpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldENsZWFyT25TaHJpbmsoZW5hYmxlZCk7XG5cdFx0XHRcdFx0XHR0aGlzLnVpLnNldENsZWFyT25TaHJpbmsoZW5hYmxlZCk7XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRvblJlc3BlY3RHaXRpZ25vcmVJblBpY2tlckNoYW5nZTogKGVuYWJsZWQpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldFJlc3BlY3RHaXRpZ25vcmVJblBpY2tlcihlbmFibGVkKTtcblx0XHRcdFx0XHRcdHRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXI/LnNldFJlc3BlY3RHaXRpZ25vcmUoZW5hYmxlZCk7XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRvblRpbWVzdGFtcEZvcm1hdENoYW5nZTogKGZvcm1hdCkgPT4ge1xuXHRcdFx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0VGltZXN0YW1wRm9ybWF0KGZvcm1hdCk7XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRvbkFkYXB0aXZlTW9kZUNoYW5nZTogKG1vZGUpID0+IHtcblx0XHRcdFx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldEFkYXB0aXZlTW9kZShtb2RlKTtcblx0XHRcdFx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25DYW5jZWw6ICgpID0+IHtcblx0XHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0sXG5cdFx0XHQpO1xuXHRcdFx0cmV0dXJuIHsgY29tcG9uZW50OiBzZWxlY3RvciwgZm9jdXM6IHNlbGVjdG9yLmdldFNldHRpbmdzTGlzdCgpIH07XG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGhhbmRsZU1vZGVsQ29tbWFuZChzZWFyY2hUZXJtPzogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgaGFuZGxlTW9kZWxDb21tYW5kQ29udHJvbGxlcih0aGlzLCBzZWFyY2hUZXJtKTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgZmluZEV4YWN0TW9kZWxNYXRjaChzZWFyY2hUZXJtOiBzdHJpbmcpOiBQcm9taXNlPE1vZGVsPGFueT4gfCB1bmRlZmluZWQ+IHtcblx0XHRyZXR1cm4gZmluZEV4YWN0TW9kZWxNYXRjaENvbnRyb2xsZXIodGhpcywgc2VhcmNoVGVybSk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGdldE1vZGVsQ2FuZGlkYXRlcygpOiBQcm9taXNlPE1vZGVsPGFueT5bXT4ge1xuXHRcdHJldHVybiBnZXRNb2RlbENhbmRpZGF0ZXNDb250cm9sbGVyKHRoaXMpO1xuXHR9XG5cblx0LyoqIFVwZGF0ZSB0aGUgZm9vdGVyJ3MgYXZhaWxhYmxlIHByb3ZpZGVyIGNvdW50IGZyb20gY3VycmVudCBtb2RlbCBjYW5kaWRhdGVzICovXG5cdHByaXZhdGUgYXN5bmMgdXBkYXRlQXZhaWxhYmxlUHJvdmlkZXJDb3VudCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB1cGRhdGVBdmFpbGFibGVQcm92aWRlckNvdW50Q29udHJvbGxlcih0aGlzKTtcblx0fVxuXG5cdHByaXZhdGUgc2hvd01vZGVsU2VsZWN0b3IoaW5pdGlhbFNlYXJjaElucHV0Pzogc3RyaW5nKTogdm9pZCB7XG5cdFx0dGhpcy5zaG93U2VsZWN0b3IoKGRvbmUpID0+IHtcblx0XHRcdGNvbnN0IHNlbGVjdG9yID0gbmV3IE1vZGVsU2VsZWN0b3JDb21wb25lbnQoXG5cdFx0XHRcdHRoaXMudWksXG5cdFx0XHRcdHRoaXMuc2Vzc2lvbi5tb2RlbCxcblx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIsXG5cdFx0XHRcdHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LFxuXHRcdFx0XHR0aGlzLnNlc3Npb24uc2NvcGVkTW9kZWxzLFxuXHRcdFx0XHRhc3luYyAobW9kZWwpID0+IHtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0YXdhaXQgdGhpcy5zZXNzaW9uLnNldE1vZGVsKG1vZGVsKTtcblx0XHRcdFx0XHRcdHRoaXMuZm9vdGVyLmludmFsaWRhdGUoKTtcblx0XHRcdFx0XHRcdHRoaXMudXBkYXRlRWRpdG9yQm9yZGVyQ29sb3IoKTtcblx0XHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHRcdHRoaXMuc2hvd1N0YXR1cyhgTW9kZWw6ICR7bW9kZWwuaWR9YCk7XG5cdFx0XHRcdFx0XHR0aGlzLmNoZWNrRGF4bnV0c0Vhc3RlckVnZyhtb2RlbCk7XG5cdFx0XHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHRcdHRoaXMuc2hvd0Vycm9yKGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9LFxuXHRcdFx0XHQoKSA9PiB7XG5cdFx0XHRcdFx0ZG9uZSgpO1xuXHRcdFx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRpbml0aWFsU2VhcmNoSW5wdXQsXG5cdFx0XHQpO1xuXHRcdFx0cmV0dXJuIHsgY29tcG9uZW50OiBzZWxlY3RvciwgZm9jdXM6IHNlbGVjdG9yIH07XG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIHNob3dNb2RlbHNTZWxlY3RvcigpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHQvLyBHZXQgYWxsIGF2YWlsYWJsZSBtb2RlbHNcblx0XHR0aGlzLnNlc3Npb24ubW9kZWxSZWdpc3RyeS5yZWZyZXNoKCk7XG5cdFx0Y29uc3QgYWxsTW9kZWxzID0gdGhpcy5zZXNzaW9uLm1vZGVsUmVnaXN0cnkuZ2V0QXZhaWxhYmxlKCk7XG5cblx0XHRpZiAoYWxsTW9kZWxzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dGhpcy5zaG93U3RhdHVzKFwiTm8gbW9kZWxzIGF2YWlsYWJsZVwiKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDaGVjayBpZiBzZXNzaW9uIGhhcyBzY29wZWQgbW9kZWxzIChmcm9tIHByZXZpb3VzIHNlc3Npb24tb25seSBjaGFuZ2VzIG9yIENMSSAtLW1vZGVscylcblx0XHRjb25zdCBzZXNzaW9uU2NvcGVkTW9kZWxzID0gdGhpcy5zZXNzaW9uLnNjb3BlZE1vZGVscztcblx0XHRjb25zdCBoYXNTZXNzaW9uU2NvcGUgPSBzZXNzaW9uU2NvcGVkTW9kZWxzLmxlbmd0aCA+IDA7XG5cblx0XHQvLyBCdWlsZCBlbmFibGVkIG1vZGVsIElEcyBmcm9tIHNlc3Npb24gc3RhdGUgb3Igc2V0dGluZ3Ncblx0XHRjb25zdCBlbmFibGVkTW9kZWxJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRsZXQgaGFzRmlsdGVyID0gZmFsc2U7XG5cblx0XHRpZiAoaGFzU2Vzc2lvblNjb3BlKSB7XG5cdFx0XHQvLyBVc2UgY3VycmVudCBzZXNzaW9uJ3Mgc2NvcGVkIG1vZGVsc1xuXHRcdFx0Zm9yIChjb25zdCBzbSBvZiBzZXNzaW9uU2NvcGVkTW9kZWxzKSB7XG5cdFx0XHRcdGVuYWJsZWRNb2RlbElkcy5hZGQoYCR7c20ubW9kZWwucHJvdmlkZXJ9LyR7c20ubW9kZWwuaWR9YCk7XG5cdFx0XHR9XG5cdFx0XHRoYXNGaWx0ZXIgPSB0cnVlO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBGYWxsIGJhY2sgdG8gc2V0dGluZ3Ncblx0XHRcdGNvbnN0IHBhdHRlcm5zID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0RW5hYmxlZE1vZGVscygpO1xuXHRcdFx0aWYgKHBhdHRlcm5zICE9PSB1bmRlZmluZWQgJiYgcGF0dGVybnMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRoYXNGaWx0ZXIgPSB0cnVlO1xuXHRcdFx0XHRjb25zdCBzY29wZWRNb2RlbHMgPSBhd2FpdCByZXNvbHZlTW9kZWxTY29wZShwYXR0ZXJucywgdGhpcy5zZXNzaW9uLm1vZGVsUmVnaXN0cnkpO1xuXHRcdFx0XHRmb3IgKGNvbnN0IHNtIG9mIHNjb3BlZE1vZGVscykge1xuXHRcdFx0XHRcdGVuYWJsZWRNb2RlbElkcy5hZGQoYCR7c20ubW9kZWwucHJvdmlkZXJ9LyR7c20ubW9kZWwuaWR9YCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBUcmFjayBjdXJyZW50IGVuYWJsZWQgc3RhdGUgKHNlc3Npb24tb25seSB1bnRpbCBwZXJzaXN0ZWQpXG5cdFx0Y29uc3QgY3VycmVudEVuYWJsZWRJZHMgPSBuZXcgU2V0KGVuYWJsZWRNb2RlbElkcyk7XG5cdFx0bGV0IGN1cnJlbnRIYXNGaWx0ZXIgPSBoYXNGaWx0ZXI7XG5cblx0XHQvLyBIZWxwZXIgdG8gdXBkYXRlIHNlc3Npb24ncyBzY29wZWQgbW9kZWxzIChzZXNzaW9uLW9ubHksIG5vIHBlcnNpc3QpXG5cdFx0Y29uc3QgdXBkYXRlU2Vzc2lvbk1vZGVscyA9IGFzeW5jIChlbmFibGVkSWRzOiBTZXQ8c3RyaW5nPikgPT4ge1xuXHRcdFx0aWYgKGVuYWJsZWRJZHMuc2l6ZSA+IDAgJiYgZW5hYmxlZElkcy5zaXplIDwgYWxsTW9kZWxzLmxlbmd0aCkge1xuXHRcdFx0XHRjb25zdCBuZXdTY29wZWRNb2RlbHMgPSBhd2FpdCByZXNvbHZlTW9kZWxTY29wZShBcnJheS5mcm9tKGVuYWJsZWRJZHMpLCB0aGlzLnNlc3Npb24ubW9kZWxSZWdpc3RyeSk7XG5cdFx0XHRcdHRoaXMuc2Vzc2lvbi5zZXRTY29wZWRNb2RlbHMoXG5cdFx0XHRcdFx0bmV3U2NvcGVkTW9kZWxzLm1hcCgoc20pID0+ICh7XG5cdFx0XHRcdFx0XHRtb2RlbDogc20ubW9kZWwsXG5cdFx0XHRcdFx0XHR0aGlua2luZ0xldmVsOiBzbS50aGlua2luZ0xldmVsLFxuXHRcdFx0XHRcdH0pKSxcblx0XHRcdFx0KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdC8vIEFsbCBlbmFibGVkIG9yIG5vbmUgZW5hYmxlZCA9IG5vIGZpbHRlclxuXHRcdFx0XHR0aGlzLnNlc3Npb24uc2V0U2NvcGVkTW9kZWxzKFtdKTtcblx0XHRcdH1cblx0XHRcdGF3YWl0IHRoaXMudXBkYXRlQXZhaWxhYmxlUHJvdmlkZXJDb3VudCgpO1xuXHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fTtcblxuXHRcdHRoaXMuc2hvd1NlbGVjdG9yKChkb25lKSA9PiB7XG5cdFx0XHRjb25zdCBzZWxlY3RvciA9IG5ldyBTY29wZWRNb2RlbHNTZWxlY3RvckNvbXBvbmVudChcblx0XHRcdFx0e1xuXHRcdFx0XHRcdGFsbE1vZGVscyxcblx0XHRcdFx0XHRlbmFibGVkTW9kZWxJZHM6IGN1cnJlbnRFbmFibGVkSWRzLFxuXHRcdFx0XHRcdGhhc0VuYWJsZWRNb2RlbHNGaWx0ZXI6IGN1cnJlbnRIYXNGaWx0ZXIsXG5cdFx0XHRcdH0sXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRvbk1vZGVsVG9nZ2xlOiBhc3luYyAobW9kZWxJZCwgZW5hYmxlZCkgPT4ge1xuXHRcdFx0XHRcdFx0aWYgKGVuYWJsZWQpIHtcblx0XHRcdFx0XHRcdFx0Y3VycmVudEVuYWJsZWRJZHMuYWRkKG1vZGVsSWQpO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0Y3VycmVudEVuYWJsZWRJZHMuZGVsZXRlKG1vZGVsSWQpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0Y3VycmVudEhhc0ZpbHRlciA9IHRydWU7XG5cdFx0XHRcdFx0XHRhd2FpdCB1cGRhdGVTZXNzaW9uTW9kZWxzKGN1cnJlbnRFbmFibGVkSWRzKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG9uRW5hYmxlQWxsOiBhc3luYyAoYWxsTW9kZWxJZHMpID0+IHtcblx0XHRcdFx0XHRcdGN1cnJlbnRFbmFibGVkSWRzLmNsZWFyKCk7XG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGlkIG9mIGFsbE1vZGVsSWRzKSB7XG5cdFx0XHRcdFx0XHRcdGN1cnJlbnRFbmFibGVkSWRzLmFkZChpZCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjdXJyZW50SGFzRmlsdGVyID0gZmFsc2U7XG5cdFx0XHRcdFx0XHRhd2FpdCB1cGRhdGVTZXNzaW9uTW9kZWxzKGN1cnJlbnRFbmFibGVkSWRzKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG9uQ2xlYXJBbGw6IGFzeW5jICgpID0+IHtcblx0XHRcdFx0XHRcdGN1cnJlbnRFbmFibGVkSWRzLmNsZWFyKCk7XG5cdFx0XHRcdFx0XHRjdXJyZW50SGFzRmlsdGVyID0gdHJ1ZTtcblx0XHRcdFx0XHRcdGF3YWl0IHVwZGF0ZVNlc3Npb25Nb2RlbHMoY3VycmVudEVuYWJsZWRJZHMpO1xuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0b25Ub2dnbGVQcm92aWRlcjogYXN5bmMgKF9wcm92aWRlciwgbW9kZWxJZHMsIGVuYWJsZWQpID0+IHtcblx0XHRcdFx0XHRcdGZvciAoY29uc3QgaWQgb2YgbW9kZWxJZHMpIHtcblx0XHRcdFx0XHRcdFx0aWYgKGVuYWJsZWQpIHtcblx0XHRcdFx0XHRcdFx0XHRjdXJyZW50RW5hYmxlZElkcy5hZGQoaWQpO1xuXHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdGN1cnJlbnRFbmFibGVkSWRzLmRlbGV0ZShpZCk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGN1cnJlbnRIYXNGaWx0ZXIgPSB0cnVlO1xuXHRcdFx0XHRcdFx0YXdhaXQgdXBkYXRlU2Vzc2lvbk1vZGVscyhjdXJyZW50RW5hYmxlZElkcyk7XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRvblBlcnNpc3Q6IChlbmFibGVkSWRzKSA9PiB7XG5cdFx0XHRcdFx0XHQvLyBQZXJzaXN0IHRvIHNldHRpbmdzXG5cdFx0XHRcdFx0XHRjb25zdCBuZXdQYXR0ZXJucyA9XG5cdFx0XHRcdFx0XHRcdGVuYWJsZWRJZHMubGVuZ3RoID09PSBhbGxNb2RlbHMubGVuZ3RoXG5cdFx0XHRcdFx0XHRcdFx0PyB1bmRlZmluZWQgLy8gQWxsIGVuYWJsZWQgPSBjbGVhciBmaWx0ZXJcblx0XHRcdFx0XHRcdFx0XHQ6IGVuYWJsZWRJZHM7XG5cdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRFbmFibGVkTW9kZWxzKG5ld1BhdHRlcm5zKTtcblx0XHRcdFx0XHRcdHRoaXMuc2hvd1N0YXR1cyhcIk1vZGVsIHNlbGVjdGlvbiBzYXZlZCB0byBzZXR0aW5nc1wiKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdG9uQ2FuY2VsOiAoKSA9PiB7XG5cdFx0XHRcdFx0XHRkb25lKCk7XG5cdFx0XHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHR9LFxuXHRcdFx0KTtcblx0XHRcdHJldHVybiB7IGNvbXBvbmVudDogc2VsZWN0b3IsIGZvY3VzOiBzZWxlY3RvciB9O1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBzaG93VXNlck1lc3NhZ2VTZWxlY3RvcigpOiB2b2lkIHtcblx0XHRjb25zdCB1c2VyTWVzc2FnZXMgPSB0aGlzLnNlc3Npb24uZ2V0VXNlck1lc3NhZ2VzRm9yRm9ya2luZygpO1xuXG5cdFx0aWYgKHVzZXJNZXNzYWdlcy5sZW5ndGggPT09IDApIHtcblx0XHRcdHRoaXMuc2hvd1N0YXR1cyhcIk5vIG1lc3NhZ2VzIHRvIGZvcmsgZnJvbVwiKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHR0aGlzLnNob3dTZWxlY3RvcigoZG9uZSkgPT4ge1xuXHRcdFx0Y29uc3Qgc2VsZWN0b3IgPSBuZXcgVXNlck1lc3NhZ2VTZWxlY3RvckNvbXBvbmVudChcblx0XHRcdFx0dXNlck1lc3NhZ2VzLm1hcCgobSkgPT4gKHsgaWQ6IG0uZW50cnlJZCwgdGV4dDogbS50ZXh0IH0pKSxcblx0XHRcdFx0YXN5bmMgKGVudHJ5SWQpID0+IHtcblx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnNlc3Npb24uZm9yayhlbnRyeUlkKTtcblx0XHRcdFx0XHRpZiAocmVzdWx0LmNhbmNlbGxlZCkge1xuXHRcdFx0XHRcdFx0Ly8gRXh0ZW5zaW9uIGNhbmNlbGxlZCB0aGUgZm9ya1xuXHRcdFx0XHRcdFx0ZG9uZSgpO1xuXHRcdFx0XHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHRcdFx0dGhpcy5yZW5kZXJJbml0aWFsTWVzc2FnZXMoKTtcblx0XHRcdFx0XHR0aGlzLmVkaXRvci5zZXRUZXh0KHJlc3VsdC5zZWxlY3RlZFRleHQpO1xuXHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHR0aGlzLnNob3dTdGF0dXMoXCJCcmFuY2hlZCB0byBuZXcgc2Vzc2lvblwiKTtcblx0XHRcdFx0fSxcblx0XHRcdFx0KCkgPT4ge1xuXHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0fSxcblx0XHRcdCk7XG5cdFx0XHRyZXR1cm4geyBjb21wb25lbnQ6IHNlbGVjdG9yLCBmb2N1czogc2VsZWN0b3IuZ2V0TWVzc2FnZUxpc3QoKSB9O1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBzaG93VHJlZVNlbGVjdG9yKGluaXRpYWxTZWxlY3RlZElkPzogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3QgdHJlZSA9IHRoaXMuc2Vzc2lvbk1hbmFnZXIuZ2V0VHJlZSgpO1xuXHRcdGNvbnN0IHJlYWxMZWFmSWQgPSB0aGlzLnNlc3Npb25NYW5hZ2VyLmdldExlYWZJZCgpO1xuXHRcdGNvbnN0IGluaXRpYWxGaWx0ZXJNb2RlID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0VHJlZUZpbHRlck1vZGUoKTtcblxuXHRcdGlmICh0cmVlLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dGhpcy5zaG93U3RhdHVzKFwiTm8gZW50cmllcyBpbiBzZXNzaW9uXCIpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRoaXMuc2hvd1NlbGVjdG9yKChkb25lKSA9PiB7XG5cdFx0XHRjb25zdCBzZWxlY3RvciA9IG5ldyBUcmVlU2VsZWN0b3JDb21wb25lbnQoXG5cdFx0XHRcdHRyZWUsXG5cdFx0XHRcdHJlYWxMZWFmSWQsXG5cdFx0XHRcdHRoaXMudWkudGVybWluYWwucm93cyxcblx0XHRcdFx0YXN5bmMgKGVudHJ5SWQpID0+IHtcblx0XHRcdFx0XHQvLyBTZWxlY3RpbmcgdGhlIGN1cnJlbnQgbGVhZiBpcyBhIG5vLW9wIChhbHJlYWR5IHRoZXJlKVxuXHRcdFx0XHRcdGlmIChlbnRyeUlkID09PSByZWFsTGVhZklkKSB7XG5cdFx0XHRcdFx0XHRkb25lKCk7XG5cdFx0XHRcdFx0XHR0aGlzLnNob3dTdGF0dXMoXCJBbHJlYWR5IGF0IHRoaXMgcG9pbnRcIik7XG5cdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gQXNrIGFib3V0IHN1bW1hcml6YXRpb25cblx0XHRcdFx0XHRkb25lKCk7IC8vIENsb3NlIHNlbGVjdG9yIGZpcnN0XG5cblx0XHRcdFx0XHQvLyBMb29wIHVudGlsIHVzZXIgbWFrZXMgYSBjb21wbGV0ZSBjaG9pY2Ugb3IgY2FuY2VscyB0byB0cmVlXG5cdFx0XHRcdFx0bGV0IHdhbnRzU3VtbWFyeSA9IGZhbHNlO1xuXHRcdFx0XHRcdGxldCBjdXN0b21JbnN0cnVjdGlvbnM6IHN0cmluZyB8IHVuZGVmaW5lZDtcblxuXHRcdFx0XHRcdC8vIENoZWNrIGlmIHdlIHNob3VsZCBza2lwIHRoZSBwcm9tcHQgKHVzZXIgcHJlZmVyZW5jZSB0byBhbHdheXMgZGVmYXVsdCB0byBubyBzdW1tYXJ5KVxuXHRcdFx0XHRcdGlmICghdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0QnJhbmNoU3VtbWFyeVNraXBQcm9tcHQoKSkge1xuXHRcdFx0XHRcdFx0d2hpbGUgKHRydWUpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgc3VtbWFyeUNob2ljZSA9IGF3YWl0IHRoaXMuc2hvd0V4dGVuc2lvblNlbGVjdG9yKFwiU3VtbWFyaXplIGJyYW5jaD9cIiwgW1xuXHRcdFx0XHRcdFx0XHRcdFwiTm8gc3VtbWFyeVwiLFxuXHRcdFx0XHRcdFx0XHRcdFwiU3VtbWFyaXplXCIsXG5cdFx0XHRcdFx0XHRcdFx0XCJTdW1tYXJpemUgd2l0aCBjdXN0b20gcHJvbXB0XCIsXG5cdFx0XHRcdFx0XHRcdF0pO1xuXG5cdFx0XHRcdFx0XHRcdGlmIChzdW1tYXJ5Q2hvaWNlID09PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0XHRcdFx0XHQvLyBVc2VyIHByZXNzZWQgZXNjYXBlIC0gcmUtc2hvdyB0cmVlIHNlbGVjdG9yIHdpdGggc2FtZSBzZWxlY3Rpb25cblx0XHRcdFx0XHRcdFx0XHR0aGlzLnNob3dUcmVlU2VsZWN0b3IoZW50cnlJZCk7XG5cdFx0XHRcdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0d2FudHNTdW1tYXJ5ID0gc3VtbWFyeUNob2ljZSAhPT0gXCJObyBzdW1tYXJ5XCI7XG5cblx0XHRcdFx0XHRcdFx0aWYgKHN1bW1hcnlDaG9pY2UgPT09IFwiU3VtbWFyaXplIHdpdGggY3VzdG9tIHByb21wdFwiKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y3VzdG9tSW5zdHJ1Y3Rpb25zID0gYXdhaXQgdGhpcy5zaG93RXh0ZW5zaW9uRWRpdG9yKFwiQ3VzdG9tIHN1bW1hcml6YXRpb24gaW5zdHJ1Y3Rpb25zXCIpO1xuXHRcdFx0XHRcdFx0XHRcdGlmIChjdXN0b21JbnN0cnVjdGlvbnMgPT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdFx0XHRcdFx0Ly8gVXNlciBjYW5jZWxsZWQgLSBsb29wIGJhY2sgdG8gc3VtbWFyeSBzZWxlY3RvclxuXHRcdFx0XHRcdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdFx0Ly8gVXNlciBtYWRlIGEgY29tcGxldGUgY2hvaWNlXG5cdFx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIFNldCB1cCBlc2NhcGUgaGFuZGxlciBhbmQgbG9hZGVyIGlmIHN1bW1hcml6aW5nXG5cdFx0XHRcdFx0bGV0IHN1bW1hcnlMb2FkZXI6IExvYWRlciB8IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRjb25zdCBvcmlnaW5hbE9uRXNjYXBlID0gdGhpcy5kZWZhdWx0RWRpdG9yLm9uRXNjYXBlO1xuXG5cdFx0XHRcdFx0aWYgKHdhbnRzU3VtbWFyeSkge1xuXHRcdFx0XHRcdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uRXNjYXBlID0gKCkgPT4ge1xuXHRcdFx0XHRcdFx0XHR0aGlzLnNlc3Npb24uYWJvcnRCcmFuY2hTdW1tYXJ5KCk7XG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0XHRcdFx0c3VtbWFyeUxvYWRlciA9IG5ldyBMb2FkZXIoXG5cdFx0XHRcdFx0XHRcdHRoaXMudWksXG5cdFx0XHRcdFx0XHRcdChzcGlubmVyKSA9PiB0aGVtZS5mZyhcImFjY2VudFwiLCBzcGlubmVyKSxcblx0XHRcdFx0XHRcdFx0KHRleHQpID0+IHRoZW1lLmZnKFwibXV0ZWRcIiwgdGV4dCksXG5cdFx0XHRcdFx0XHRcdGBTdW1tYXJpemluZyBicmFuY2guLi4gKCR7YXBwS2V5KHRoaXMua2V5YmluZGluZ3MsIFwiaW50ZXJydXB0XCIpfSB0byBjYW5jZWwpYCxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHR0aGlzLnN0YXR1c0NvbnRhaW5lci5hZGRDaGlsZChzdW1tYXJ5TG9hZGVyKTtcblx0XHRcdFx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnNlc3Npb24ubmF2aWdhdGVUcmVlKGVudHJ5SWQsIHtcblx0XHRcdFx0XHRcdFx0c3VtbWFyaXplOiB3YW50c1N1bW1hcnksXG5cdFx0XHRcdFx0XHRcdGN1c3RvbUluc3RydWN0aW9ucyxcblx0XHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0XHRpZiAocmVzdWx0LmFib3J0ZWQpIHtcblx0XHRcdFx0XHRcdFx0Ly8gU3VtbWFyaXphdGlvbiBhYm9ydGVkIC0gcmUtc2hvdyB0cmVlIHNlbGVjdG9yIHdpdGggc2FtZSBzZWxlY3Rpb25cblx0XHRcdFx0XHRcdFx0dGhpcy5zaG93U3RhdHVzKFwiQnJhbmNoIHN1bW1hcml6YXRpb24gY2FuY2VsbGVkXCIpO1xuXHRcdFx0XHRcdFx0XHR0aGlzLnNob3dUcmVlU2VsZWN0b3IoZW50cnlJZCk7XG5cdFx0XHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGlmIChyZXN1bHQuY2FuY2VsbGVkKSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMuc2hvd1N0YXR1cyhcIk5hdmlnYXRpb24gY2FuY2VsbGVkXCIpO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdC8vIFVwZGF0ZSBVSVxuXHRcdFx0XHRcdFx0dGhpcy5jaGF0Q29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHRcdFx0XHR0aGlzLnJlbmRlckluaXRpYWxNZXNzYWdlcygpO1xuXHRcdFx0XHRcdFx0aWYgKHJlc3VsdC5lZGl0b3JUZXh0ICYmICF0aGlzLmVkaXRvci5nZXRUZXh0KCkudHJpbSgpKSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMuZWRpdG9yLnNldFRleHQocmVzdWx0LmVkaXRvclRleHQpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0dGhpcy5zaG93U3RhdHVzKFwiTmF2aWdhdGVkIHRvIHNlbGVjdGVkIHBvaW50XCIpO1xuXHRcdFx0XHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRcdFx0XHR0aGlzLnNob3dFcnJvcihlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikpO1xuXHRcdFx0XHRcdH0gZmluYWxseSB7XG5cdFx0XHRcdFx0XHRpZiAoc3VtbWFyeUxvYWRlcikge1xuXHRcdFx0XHRcdFx0XHRzdW1tYXJ5TG9hZGVyLnN0b3AoKTtcblx0XHRcdFx0XHRcdFx0dGhpcy5zdGF0dXNDb250YWluZXIuY2xlYXIoKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdHRoaXMuZGVmYXVsdEVkaXRvci5vbkVzY2FwZSA9IG9yaWdpbmFsT25Fc2NhcGU7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9LFxuXHRcdFx0XHQoKSA9PiB7XG5cdFx0XHRcdFx0ZG9uZSgpO1xuXHRcdFx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHQoZW50cnlJZCwgbGFiZWwpID0+IHtcblx0XHRcdFx0XHR0aGlzLnNlc3Npb25NYW5hZ2VyLmFwcGVuZExhYmVsQ2hhbmdlKGVudHJ5SWQsIGxhYmVsKTtcblx0XHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0fSxcblx0XHRcdFx0aW5pdGlhbFNlbGVjdGVkSWQsXG5cdFx0XHRcdGluaXRpYWxGaWx0ZXJNb2RlLFxuXHRcdFx0KTtcblx0XHRcdHJldHVybiB7IGNvbXBvbmVudDogc2VsZWN0b3IsIGZvY3VzOiBzZWxlY3RvciB9O1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBzaG93U2Vzc2lvblNlbGVjdG9yKCk6IHZvaWQge1xuXHRcdHRoaXMuc2hvd1NlbGVjdG9yKChkb25lKSA9PiB7XG5cdFx0XHRjb25zdCBzZWxlY3RvciA9IG5ldyBTZXNzaW9uU2VsZWN0b3JDb21wb25lbnQoXG5cdFx0XHRcdChvblByb2dyZXNzKSA9PlxuXHRcdFx0XHRcdFNlc3Npb25NYW5hZ2VyLmxpc3QodGhpcy5zZXNzaW9uTWFuYWdlci5nZXRDd2QoKSwgdGhpcy5zZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uRGlyKCksIG9uUHJvZ3Jlc3MpLFxuXHRcdFx0XHRTZXNzaW9uTWFuYWdlci5saXN0QWxsLFxuXHRcdFx0XHRhc3luYyAoc2Vzc2lvblBhdGgpID0+IHtcblx0XHRcdFx0XHRkb25lKCk7XG5cdFx0XHRcdFx0YXdhaXQgdGhpcy5oYW5kbGVSZXN1bWVTZXNzaW9uKHNlc3Npb25QYXRoKTtcblx0XHRcdFx0fSxcblx0XHRcdFx0KCkgPT4ge1xuXHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0fSxcblx0XHRcdFx0KCkgPT4ge1xuXHRcdFx0XHRcdHZvaWQgdGhpcy5zaHV0ZG93bigpO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHQoKSA9PiB0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKSxcblx0XHRcdFx0e1xuXHRcdFx0XHRcdHJlbmFtZVNlc3Npb246IGFzeW5jIChzZXNzaW9uRmlsZVBhdGg6IHN0cmluZywgbmV4dE5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4ge1xuXHRcdFx0XHRcdFx0Y29uc3QgbmV4dCA9IChuZXh0TmFtZSA/PyBcIlwiKS50cmltKCk7XG5cdFx0XHRcdFx0XHRpZiAoIW5leHQpIHJldHVybjtcblx0XHRcdFx0XHRcdGNvbnN0IG1nciA9IFNlc3Npb25NYW5hZ2VyLm9wZW4oc2Vzc2lvbkZpbGVQYXRoKTtcblx0XHRcdFx0XHRcdG1nci5hcHBlbmRTZXNzaW9uSW5mbyhuZXh0KTtcblx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdHNob3dSZW5hbWVIaW50OiB0cnVlLFxuXHRcdFx0XHRcdGtleWJpbmRpbmdzOiB0aGlzLmtleWJpbmRpbmdzLFxuXHRcdFx0XHR9LFxuXG5cdFx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbkZpbGUoKSxcblx0XHRcdCk7XG5cdFx0XHRyZXR1cm4geyBjb21wb25lbnQ6IHNlbGVjdG9yLCBmb2N1czogc2VsZWN0b3IgfTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgaGFuZGxlUmVzdW1lU2Vzc2lvbihzZXNzaW9uUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Ly8gU3RvcCBsb2FkaW5nIGFuaW1hdGlvblxuXHRcdGlmICh0aGlzLmxvYWRpbmdBbmltYXRpb24pIHtcblx0XHRcdHRoaXMubG9hZGluZ0FuaW1hdGlvbi5zdG9wKCk7XG5cdFx0XHR0aGlzLmxvYWRpbmdBbmltYXRpb24gPSB1bmRlZmluZWQ7XG5cdFx0fVxuXHRcdHRoaXMuc3RhdHVzQ29udGFpbmVyLmNsZWFyKCk7XG5cblx0XHQvLyBDbGVhciBVSSBzdGF0ZVxuXHRcdHRoaXMucGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy5jb21wYWN0aW9uUXVldWVkTWVzc2FnZXMgPSBbXTtcblx0XHR0aGlzLnN0cmVhbWluZ0NvbXBvbmVudCA9IHVuZGVmaW5lZDtcblx0XHR0aGlzLnN0cmVhbWluZ01lc3NhZ2UgPSB1bmRlZmluZWQ7XG5cdFx0dGhpcy5wZW5kaW5nVG9vbHMuY2xlYXIoKTtcblx0XHR0aGlzLmNsZWFyQmxvY2tpbmdFcnJvcigpO1xuXG5cdFx0Ly8gU3dpdGNoIHNlc3Npb24gdmlhIEFnZW50U2Vzc2lvbiAoZW1pdHMgZXh0ZW5zaW9uIHNlc3Npb24gZXZlbnRzKVxuXHRcdGF3YWl0IHRoaXMuc2Vzc2lvbi5zd2l0Y2hTZXNzaW9uKHNlc3Npb25QYXRoKTtcblxuXHRcdC8vIENsZWFyIGFuZCByZS1yZW5kZXIgdGhlIGNoYXRcblx0XHR0aGlzLmNoYXRDb250YWluZXIuY2xlYXIoKTtcblx0XHR0aGlzLnJlbmRlckluaXRpYWxNZXNzYWdlcygpO1xuXG5cdFx0aWYgKHRoaXMuc2Vzc2lvbi5zZXNzaW9uTWFuYWdlci53YXNJbnRlcnJ1cHRlZCgpKSB7XG5cdFx0XHR0aGlzLnNob3dTdGF0dXMoXCJSZXN1bWVkIHNlc3Npb24gKHByZXZpb3VzIHNlc3Npb24gZW5kZWQgdW5leHBlY3RlZGx5IFx1MjAxNCBsYXN0IGFjdGlvbiBtYXkgYmUgaW5jb21wbGV0ZSlcIik7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMuc2hvd1N0YXR1cyhcIlJlc3VtZWQgc2Vzc2lvblwiKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHNob3dQcm92aWRlck1hbmFnZXIoKTogdm9pZCB7XG5cdFx0dGhpcy5zaG93U2VsZWN0b3IoKGRvbmUpID0+IHtcblx0XHRcdGNvbnN0IGNvbXBvbmVudCA9IG5ldyBQcm92aWRlck1hbmFnZXJDb21wb25lbnQoXG5cdFx0XHRcdHRoaXMudWksXG5cdFx0XHRcdHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLFxuXHRcdFx0XHR0aGlzLnNlc3Npb24ubW9kZWxSZWdpc3RyeSxcblx0XHRcdFx0KCkgPT4ge1xuXHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0fSxcblx0XHRcdFx0YXN5bmMgKHByb3ZpZGVyOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0XHR0aGlzLnNob3dTdGF0dXMoYERpc2NvdmVyaW5nIG1vZGVscyBmb3IgJHtwcm92aWRlcn0uLi5gKTtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0cyA9IGF3YWl0IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmRpc2NvdmVyTW9kZWxzKFtwcm92aWRlcl0pO1xuXHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gcmVzdWx0c1swXTtcblx0XHRcdFx0XHRcdGlmIChyZXN1bHQ/LmVycm9yKSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMuc2hvd0Vycm9yKGBEaXNjb3ZlcnkgZmFpbGVkOiAke3Jlc3VsdC5lcnJvcn1gKTtcblx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMuc2hvd1N0YXR1cyhgRGlzY292ZXJlZCAke3Jlc3VsdD8ubW9kZWxzLmxlbmd0aCA/PyAwfSBtb2RlbHMgZnJvbSAke3Byb3ZpZGVyfWApO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRcdFx0XHR0aGlzLnNob3dFcnJvcihlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRkb25lKCk7XG5cdFx0XHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdGFzeW5jIChwcm92aWRlcjogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdFx0Ly8gRW50ZXIga2V5IFx1MjE5MiBhdXRoIHNldHVwIGZvciBzZWxlY3RlZCBwcm92aWRlciAoIzM1NzkpLlxuXHRcdFx0XHRcdC8vIE9ubHkgT0F1dGggcHJvdmlkZXJzIHN1cHBvcnQgdGhlIGxvZ2luIGRpYWxvZyBmbG93LlxuXHRcdFx0XHRcdC8vIGV4dGVybmFsQ2xpIHByb3ZpZGVycyAoZS5nLiBjbGF1ZGUtY29kZSkgYXV0aGVudGljYXRlIHRocm91Z2hcblx0XHRcdFx0XHQvLyB0aGVpciBvd24gQ0xJIFx1MjAxNCBzZW5kaW5nIHRoZW0gdG8gdGhlIE9BdXRoIGRpYWxvZyBwcm9kdWNlc1xuXHRcdFx0XHRcdC8vIFwiVW5rbm93biBPQXV0aCBwcm92aWRlcjogY2xhdWRlLWNvZGVcIiAoIzQ1NDgpLlxuXHRcdFx0XHRcdGNvbnN0IGlzT0F1dGhQcm92aWRlciA9IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlXG5cdFx0XHRcdFx0XHQuZ2V0T0F1dGhQcm92aWRlcnMoKVxuXHRcdFx0XHRcdFx0LnNvbWUoKHApID0+IHAuaWQgPT09IHByb3ZpZGVyKTtcblx0XHRcdFx0XHRpZiAoIWlzT0F1dGhQcm92aWRlcikge1xuXHRcdFx0XHRcdFx0ZG9uZSgpO1xuXHRcdFx0XHRcdFx0dGhpcy5zaG93U3RhdHVzKGAke3Byb3ZpZGVyfSB1c2VzIGV4dGVybmFsIENMSSBhdXRoIFx1MjAxNCB1c2UgL21vZGVsIHRvIHNlbGVjdCBhIG1vZGVsIG9yIHJ1biB0aGUgcHJvdmlkZXIncyBvd24gYXV0aCBjb21tYW5kLmApO1xuXHRcdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRkb25lKCk7XG5cdFx0XHRcdFx0YXdhaXQgdGhpcy5zaG93TG9naW5EaWFsb2cocHJvdmlkZXIpO1xuXHRcdFx0XHR9LFxuXHRcdFx0KTtcblx0XHRcdHJldHVybiB7IGNvbXBvbmVudCwgZm9jdXM6IGNvbXBvbmVudCB9O1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBzaG93T0F1dGhTZWxlY3Rvcihtb2RlOiBcImxvZ2luXCIgfCBcImxvZ291dFwiKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKG1vZGUgPT09IFwibG9nb3V0XCIpIHtcblx0XHRcdGNvbnN0IHByb3ZpZGVycyA9IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLmxpc3QoKTtcblx0XHRcdGNvbnN0IGxvZ2dlZEluUHJvdmlkZXJzID0gcHJvdmlkZXJzLmZpbHRlcihcblx0XHRcdFx0KHApID0+IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLmdldChwKT8udHlwZSA9PT0gXCJvYXV0aFwiLFxuXHRcdFx0KTtcblx0XHRcdGlmIChsb2dnZWRJblByb3ZpZGVycy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0dGhpcy5zaG93U3RhdHVzKFwiTm8gT0F1dGggcHJvdmlkZXJzIGxvZ2dlZCBpbi4gVXNlIC9sb2dpbiBmaXJzdC5cIik7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHR9XG5cblx0XHR0aGlzLnNob3dTZWxlY3RvcigoZG9uZSkgPT4ge1xuXHRcdFx0Y29uc3Qgc2VsZWN0b3IgPSBuZXcgT0F1dGhTZWxlY3RvckNvbXBvbmVudChcblx0XHRcdFx0bW9kZSxcblx0XHRcdFx0dGhpcy5zZXNzaW9uLm1vZGVsUmVnaXN0cnkuYXV0aFN0b3JhZ2UsXG5cdFx0XHRcdChwcm92aWRlcklkOiBzdHJpbmcpID0+IHtcblx0XHRcdFx0XHRkb25lKCk7XG5cblx0XHRcdFx0XHQvLyBPQXV0aFNlbGVjdG9yQ29tcG9uZW50IGNhbGxzIHRoaXMgc3luY2hyb25vdXNseSAobm8gYXdhaXQpLFxuXHRcdFx0XHRcdC8vIHNvIHdlIG11c3QgY2F0Y2ggYXN5bmMgZXJyb3JzIGhlcmUgdG8gcHJldmVudCB1bmhhbmRsZWQgcmVqZWN0aW9uc1xuXHRcdFx0XHRcdC8vIHdoZW4gdGhlIHVzZXIgY2FuY2VscyB0aGUgbG9naW4gZGlhbG9nICgjODIxKS5cblx0XHRcdFx0XHRjb25zdCBoYW5kbGVBc3luYyA9IGFzeW5jICgpID0+IHtcblx0XHRcdFx0XHRcdGlmIChtb2RlID09PSBcImxvZ2luXCIpIHtcblx0XHRcdFx0XHRcdFx0YXdhaXQgdGhpcy5zaG93TG9naW5EaWFsb2cocHJvdmlkZXJJZCk7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0Ly8gTG9nb3V0IGZsb3dcblx0XHRcdFx0XHRcdGNvbnN0IHByb3ZpZGVySW5mbyA9IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlXG5cdFx0XHRcdFx0XHRcdC5nZXRPQXV0aFByb3ZpZGVycygpXG5cdFx0XHRcdFx0XHRcdC5maW5kKChwKSA9PiBwLmlkID09PSBwcm92aWRlcklkKTtcblx0XHRcdFx0XHRcdGNvbnN0IHByb3ZpZGVyTmFtZSA9IHByb3ZpZGVySW5mbz8ubmFtZSB8fCBwcm92aWRlcklkO1xuXG5cdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHR0aGlzLnNlc3Npb24ubW9kZWxSZWdpc3RyeS5hdXRoU3RvcmFnZS5sb2dvdXQocHJvdmlkZXJJZCk7XG5cdFx0XHRcdFx0XHRcdHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LnJlZnJlc2goKTtcblx0XHRcdFx0XHRcdFx0YXdhaXQgdGhpcy51cGRhdGVBdmFpbGFibGVQcm92aWRlckNvdW50KCk7XG5cblx0XHRcdFx0XHRcdFx0Ly8gQXV0by1zd2l0Y2ggbW9kZWwgaWYgY3VycmVudCBtb2RlbCBiZWxvbmdzIHRvIHRoZSBsb2dnZWQtb3V0IHByb3ZpZGVyXG5cdFx0XHRcdFx0XHRcdGNvbnN0IGN1cnJlbnRNb2RlbCA9IHRoaXMuc2Vzc2lvbi5tb2RlbDtcblx0XHRcdFx0XHRcdFx0aWYgKGN1cnJlbnRNb2RlbD8ucHJvdmlkZXIgPT09IHByb3ZpZGVySWQpIHtcblx0XHRcdFx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0XHRcdFx0Y29uc3QgYXZhaWxhYmxlID0gdGhpcy5zZXNzaW9uLm1vZGVsUmVnaXN0cnkuZ2V0QXZhaWxhYmxlKCk7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb25zdCBmYWxsYmFjayA9IGF2YWlsYWJsZS5maW5kKChtKSA9PiBtLnByb3ZpZGVyICE9PSBwcm92aWRlcklkKTtcblx0XHRcdFx0XHRcdFx0XHRcdGlmIChmYWxsYmFjaykge1xuXHRcdFx0XHRcdFx0XHRcdFx0XHRhd2FpdCB0aGlzLnNlc3Npb24uc2V0TW9kZWwoZmFsbGJhY2spO1xuXHRcdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdFx0XHRcdFx0Ly8gTW9kZWwgc3dpdGNoIGZhaWxlZCBcdTIwMTQgdXNlciBjYW4gbWFudWFsbHkgc3dpdGNoIHZpYSAvbW9kZWxcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHR0aGlzLnNob3dTdGF0dXMoYExvZ2dlZCBvdXQgb2YgJHtwcm92aWRlck5hbWV9YCk7XG5cdFx0XHRcdFx0XHR9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuXHRcdFx0XHRcdFx0XHR0aGlzLnNob3dFcnJvcihgTG9nb3V0IGZhaWxlZDogJHtlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcil9YCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0aGFuZGxlQXN5bmMoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdFx0XHQvLyBTd2FsbG93IFx1MjAxNCBzaG93TG9naW5EaWFsb2cgYWxyZWFkeSBoYW5kbGVzIGl0cyBvd24gZXJyb3JzLlxuXHRcdFx0XHRcdFx0Ly8gVGhpcyBwcmV2ZW50cyB1bmhhbmRsZWQgcmVqZWN0aW9ucyB3aGVuIGxvZ2luIGlzIGNhbmNlbGxlZC5cblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fSxcblx0XHRcdFx0KCkgPT4ge1xuXHRcdFx0XHRcdGRvbmUoKTtcblx0XHRcdFx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblx0XHRcdFx0fSxcblx0XHRcdCk7XG5cdFx0XHRyZXR1cm4geyBjb21wb25lbnQ6IHNlbGVjdG9yLCBmb2N1czogc2VsZWN0b3IgfTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgc2hvd0xvZ2luRGlhbG9nKHByb3ZpZGVySWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHByb3ZpZGVySW5mbyA9IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmF1dGhTdG9yYWdlLmdldE9BdXRoUHJvdmlkZXJzKCkuZmluZCgocCkgPT4gcC5pZCA9PT0gcHJvdmlkZXJJZCk7XG5cdFx0Y29uc3QgcHJvdmlkZXJOYW1lID0gcHJvdmlkZXJJbmZvPy5uYW1lIHx8IHByb3ZpZGVySWQ7XG5cblx0XHQvLyBQcm92aWRlcnMgdGhhdCB1c2UgY2FsbGJhY2sgc2VydmVycyAoY2FuIHBhc3RlIHJlZGlyZWN0IFVSTClcblx0XHRjb25zdCB1c2VzQ2FsbGJhY2tTZXJ2ZXIgPSBwcm92aWRlckluZm8/LnVzZXNDYWxsYmFja1NlcnZlciA/PyBmYWxzZTtcblxuXHRcdC8vIENyZWF0ZSBsb2dpbiBkaWFsb2cgY29tcG9uZW50XG5cdFx0Y29uc3QgZGlhbG9nID0gbmV3IExvZ2luRGlhbG9nQ29tcG9uZW50KHRoaXMudWksIHByb3ZpZGVySWQsIChfc3VjY2VzcywgX21lc3NhZ2UpID0+IHtcblx0XHRcdC8vIENvbXBsZXRpb24gaGFuZGxlZCBiZWxvd1xuXHRcdH0pO1xuXG5cdFx0Ly8gU2hvdyBkaWFsb2cgaW4gZWRpdG9yIGNvbnRhaW5lclxuXHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy5lZGl0b3JDb250YWluZXIuYWRkQ2hpbGQoZGlhbG9nKTtcblx0XHR0aGlzLnVpLnNldEZvY3VzKGRpYWxvZyk7XG5cdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cblx0XHQvLyBSZXN0b3JlIGVkaXRvciBoZWxwZXIgXHUyMDE0IGFsc28gZGlzcG9zZXMgdGhlIGRpYWxvZyB0byByZWplY3QgYW55XG5cdFx0Ly8gZGFuZ2xpbmcgcHJvbWlzZXMgYW5kIHByZXZlbnQgdGhlIFVJIGZyb20gZ2V0dGluZyBzdHVjay5cblx0XHRjb25zdCByZXN0b3JlRWRpdG9yID0gKCkgPT4ge1xuXHRcdFx0ZGlhbG9nLmRpc3Bvc2UoKTtcblx0XHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5hZGRDaGlsZCh0aGlzLmVkaXRvcik7XG5cdFx0XHR0aGlzLnVpLnNldEZvY3VzKHRoaXMuZWRpdG9yKTtcblx0XHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHRcdH07XG5cblx0XHR0cnkge1xuXHRcdFx0YXdhaXQgdGhpcy5zZXNzaW9uLm1vZGVsUmVnaXN0cnkuYXV0aFN0b3JhZ2UubG9naW4ocHJvdmlkZXJJZCBhcyBPQXV0aFByb3ZpZGVySWQsIHtcblx0XHRcdFx0b25BdXRoOiAoaW5mbzogeyB1cmw6IHN0cmluZzsgaW5zdHJ1Y3Rpb25zPzogc3RyaW5nIH0pID0+IHtcblx0XHRcdFx0XHRkaWFsb2cuc2hvd0F1dGgoaW5mby51cmwsIGluZm8uaW5zdHJ1Y3Rpb25zKTtcblxuXHRcdFx0XHRcdGlmICghdXNlc0NhbGxiYWNrU2VydmVyICYmIHByb3ZpZGVySWQgPT09IFwiZ2l0aHViLWNvcGlsb3RcIikge1xuXHRcdFx0XHRcdFx0Ly8gR2l0SHViIENvcGlsb3QgcG9sbHMgYWZ0ZXIgb25BdXRoXG5cdFx0XHRcdFx0XHRkaWFsb2cuc2hvd1dhaXRpbmcoXCJXYWl0aW5nIGZvciBicm93c2VyIGF1dGhlbnRpY2F0aW9uLi4uXCIpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHQvLyBGb3IgQW50aHJvcGljOiBvblByb21wdCBpcyBjYWxsZWQgaW1tZWRpYXRlbHkgYWZ0ZXJcblx0XHRcdFx0fSxcblxuXHRcdFx0XHRvblByb21wdDogYXN5bmMgKHByb21wdDogeyBtZXNzYWdlOiBzdHJpbmc7IHBsYWNlaG9sZGVyPzogc3RyaW5nIH0pID0+IHtcblx0XHRcdFx0XHRyZXR1cm4gZGlhbG9nLnNob3dQcm9tcHQocHJvbXB0Lm1lc3NhZ2UsIHByb21wdC5wbGFjZWhvbGRlcik7XG5cdFx0XHRcdH0sXG5cblx0XHRcdFx0b25Qcm9ncmVzczogKG1lc3NhZ2U6IHN0cmluZykgPT4ge1xuXHRcdFx0XHRcdGRpYWxvZy5zaG93UHJvZ3Jlc3MobWVzc2FnZSk7XG5cdFx0XHRcdH0sXG5cblx0XHRcdFx0Ly8gQ2FsbGJhY2stc2VydmVyIHByb3ZpZGVycyByYWNlIGJyb3dzZXIgY2FsbGJhY2sgd2l0aCBwYXN0ZWQgcmVkaXJlY3QgVVJMLlxuXHRcdFx0XHQvLyBLZWVwIG1hbnVhbC1pbnB1dCBwcm9taXNlIG93bmVyc2hpcCBpbnNpZGUgcHJvdmlkZXIgZmxvdyB0byBhdm9pZFxuXHRcdFx0XHQvLyBvcnBoYW5lZCByZWplY3Rpb25zIHdoZW4gdGhlIGNhbGxiYWNrIGlzIG5vdCBjb25zdW1lZC5cblx0XHRcdFx0b25NYW51YWxDb2RlSW5wdXQ6IHVzZXNDYWxsYmFja1NlcnZlclxuXHRcdFx0XHRcdD8gKCkgPT4gZGlhbG9nLnNob3dNYW51YWxJbnB1dChcIlBhc3RlIHJlZGlyZWN0IFVSTCBiZWxvdywgb3IgY29tcGxldGUgbG9naW4gaW4gYnJvd3NlcjpcIilcblx0XHRcdFx0XHQ6IHVuZGVmaW5lZCxcblxuXHRcdFx0XHRzaWduYWw6IGRpYWxvZy5zaWduYWwsXG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gU3VjY2Vzc1xuXHRcdFx0cmVzdG9yZUVkaXRvcigpO1xuXHRcdFx0dGhpcy5zZXNzaW9uLm1vZGVsUmVnaXN0cnkucmVmcmVzaCgpO1xuXHRcdFx0YXdhaXQgdGhpcy51cGRhdGVBdmFpbGFibGVQcm92aWRlckNvdW50KCk7XG5cblx0XHRcdC8vIEF1dG8tc3dpdGNoIG1vZGVsIGlmIGN1cnJlbnQgbW9kZWwgaGFzIG5vIHZhbGlkIEFQSSBrZXlcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGN1cnJlbnRNb2RlbCA9IHRoaXMuc2Vzc2lvbi5tb2RlbDtcblx0XHRcdFx0aWYgKGN1cnJlbnRNb2RlbCkge1xuXHRcdFx0XHRcdGNvbnN0IGN1cnJlbnRLZXkgPSBhd2FpdCB0aGlzLnNlc3Npb24ubW9kZWxSZWdpc3RyeS5nZXRBcGlLZXkoY3VycmVudE1vZGVsKTtcblx0XHRcdFx0XHRpZiAoIWN1cnJlbnRLZXkpIHtcblx0XHRcdFx0XHRcdGNvbnN0IGF2YWlsYWJsZSA9IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpO1xuXHRcdFx0XHRcdFx0Y29uc3QgbmV3UHJvdmlkZXJNb2RlbCA9IGF2YWlsYWJsZS5maW5kKChtKSA9PiBtLnByb3ZpZGVyID09PSBwcm92aWRlcklkKTtcblx0XHRcdFx0XHRcdGlmIChuZXdQcm92aWRlck1vZGVsKSB7XG5cdFx0XHRcdFx0XHRcdGF3YWl0IHRoaXMuc2Vzc2lvbi5zZXRNb2RlbChuZXdQcm92aWRlck1vZGVsKTtcblx0XHRcdFx0XHRcdH0gZWxzZSBpZiAoYXZhaWxhYmxlLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRcdFx0YXdhaXQgdGhpcy5zZXNzaW9uLnNldE1vZGVsKGF2YWlsYWJsZVswXSk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuXHRcdFx0XHQvLyBNb2RlbCBzd2l0Y2ggZmFpbGVkIFx1MjAxNCB1c2VyIGNhbiBtYW51YWxseSBzd2l0Y2ggdmlhIC9tb2RlbFxuXHRcdFx0fVxuXG5cdFx0XHR0aGlzLnNob3dTdGF0dXMoYExvZ2dlZCBpbiB0byAke3Byb3ZpZGVyTmFtZX0uIENyZWRlbnRpYWxzIHNhdmVkIHRvICR7Z2V0QXV0aFBhdGgoKX1gKTtcblx0XHR9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuXHRcdFx0cmVzdG9yZUVkaXRvcigpO1xuXHRcdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdFx0XHRpZiAoZXJyb3JNc2cgIT09IFwiTG9naW4gY2FuY2VsbGVkXCIgJiYgIWVycm9yTXNnLmluY2x1ZGVzKFwiU3VwZXJzZWRlZFwiKSAmJiAhZXJyb3JNc2cuaW5jbHVkZXMoXCJkaXNwb3NlZFwiKSkge1xuXHRcdFx0XHR0aGlzLnNob3dFcnJvcihgRmFpbGVkIHRvIGxvZ2luIHRvICR7cHJvdmlkZXJOYW1lfTogJHtlcnJvck1zZ31gKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIENvbW1hbmQgaGFuZGxlcnNcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdHByaXZhdGUgYXN5bmMgaGFuZGxlUmVsb2FkQ29tbWFuZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5zZXNzaW9uLmlzU3RyZWFtaW5nKSB7XG5cdFx0XHR0aGlzLnNob3dXYXJuaW5nKFwiV2FpdCBmb3IgdGhlIGN1cnJlbnQgcmVzcG9uc2UgdG8gZmluaXNoIGJlZm9yZSByZWxvYWRpbmcuXCIpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAodGhpcy5zZXNzaW9uLmlzQ29tcGFjdGluZykge1xuXHRcdFx0dGhpcy5zaG93V2FybmluZyhcIldhaXQgZm9yIGNvbXBhY3Rpb24gdG8gZmluaXNoIGJlZm9yZSByZWxvYWRpbmcuXCIpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdHRoaXMucmVzZXRFeHRlbnNpb25VSSgpO1xuXG5cdFx0Y29uc3QgbG9hZGVyID0gbmV3IEJvcmRlcmVkTG9hZGVyKHRoaXMudWksIHRoZW1lLCBcIlJlbG9hZGluZyBleHRlbnNpb25zLCBza2lsbHMsIHByb21wdHMsIHRoZW1lcy4uLlwiLCB7XG5cdFx0XHRjYW5jZWxsYWJsZTogZmFsc2UsXG5cdFx0fSk7XG5cdFx0Y29uc3QgcHJldmlvdXNFZGl0b3IgPSB0aGlzLmVkaXRvcjtcblx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5jbGVhcigpO1xuXHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmFkZENoaWxkKGxvYWRlcik7XG5cdFx0dGhpcy51aS5zZXRGb2N1cyhsb2FkZXIpO1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXG5cdFx0Y29uc3QgZGlzbWlzc0xvYWRlciA9IChlZGl0b3I6IENvbXBvbmVudCkgPT4ge1xuXHRcdFx0bG9hZGVyLmRpc3Bvc2UoKTtcblx0XHRcdHRoaXMuZWRpdG9yQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHR0aGlzLmVkaXRvckNvbnRhaW5lci5hZGRDaGlsZChlZGl0b3IpO1xuXHRcdFx0dGhpcy51aS5zZXRGb2N1cyhlZGl0b3IpO1xuXHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0fTtcblxuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCB0aGlzLnNlc3Npb24ucmVsb2FkKCk7XG5cdFx0XHRzZXRSZWdpc3RlcmVkVGhlbWVzKHRoaXMuc2Vzc2lvbi5yZXNvdXJjZUxvYWRlci5nZXRUaGVtZXMoKS50aGVtZXMpO1xuXHRcdFx0dGhpcy5oaWRlVGhpbmtpbmdCbG9jayA9IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldEhpZGVUaGlua2luZ0Jsb2NrKCk7XG5cdFx0XHRjb25zdCB0aGVtZU5hbWUgPSB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRUaGVtZSgpO1xuXHRcdFx0Y29uc3QgdGhlbWVSZXN1bHQgPSB0aGVtZU5hbWUgPyBzZXRUaGVtZSh0aGVtZU5hbWUsIHRydWUpIDogeyBzdWNjZXNzOiB0cnVlIH07XG5cdFx0XHRpZiAoIXRoZW1lUmVzdWx0LnN1Y2Nlc3MpIHtcblx0XHRcdFx0dGhpcy5zaG93RXJyb3IoYEZhaWxlZCB0byBsb2FkIHRoZW1lIFwiJHt0aGVtZU5hbWV9XCI6ICR7dGhlbWVSZXN1bHQuZXJyb3J9XFxuRmVsbCBiYWNrIHRvIGRhcmsgdGhlbWUuYCk7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBlZGl0b3JQYWRkaW5nWCA9IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldEVkaXRvclBhZGRpbmdYKCk7XG5cdFx0XHRjb25zdCBhdXRvY29tcGxldGVNYXhWaXNpYmxlID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0QXV0b2NvbXBsZXRlTWF4VmlzaWJsZSgpO1xuXHRcdFx0dGhpcy5kZWZhdWx0RWRpdG9yLnNldFBhZGRpbmdYKGVkaXRvclBhZGRpbmdYKTtcblx0XHRcdHRoaXMuZGVmYXVsdEVkaXRvci5zZXRBdXRvY29tcGxldGVNYXhWaXNpYmxlKGF1dG9jb21wbGV0ZU1heFZpc2libGUpO1xuXHRcdFx0aWYgKHRoaXMuZWRpdG9yICE9PSB0aGlzLmRlZmF1bHRFZGl0b3IpIHtcblx0XHRcdFx0dGhpcy5lZGl0b3Iuc2V0UGFkZGluZ1g/LihlZGl0b3JQYWRkaW5nWCk7XG5cdFx0XHRcdHRoaXMuZWRpdG9yLnNldEF1dG9jb21wbGV0ZU1heFZpc2libGU/LihhdXRvY29tcGxldGVNYXhWaXNpYmxlKTtcblx0XHRcdH1cblx0XHRcdHRoaXMudWkuc2V0U2hvd0hhcmR3YXJlQ3Vyc29yKHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldFNob3dIYXJkd2FyZUN1cnNvcigpKTtcblx0XHRcdHRoaXMudWkuc2V0Q2xlYXJPblNocmluayh0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRDbGVhck9uU2hyaW5rKCkpO1xuXHRcdFx0dGhpcy5zZXR1cEF1dG9jb21wbGV0ZSgpO1xuXHRcdFx0Y29uc3QgcnVubmVyID0gdGhpcy5zZXNzaW9uLmV4dGVuc2lvblJ1bm5lcjtcblx0XHRcdGlmIChydW5uZXIpIHtcblx0XHRcdFx0dGhpcy5zZXR1cEV4dGVuc2lvblNob3J0Y3V0cyhydW5uZXIpO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5yZWJ1aWxkQ2hhdEZyb21NZXNzYWdlcygpO1xuXHRcdFx0ZGlzbWlzc0xvYWRlcih0aGlzLmVkaXRvciBhcyBDb21wb25lbnQpO1xuXHRcdFx0dGhpcy5zaG93TG9hZGVkUmVzb3VyY2VzKHtcblx0XHRcdFx0ZXh0ZW5zaW9uUGF0aHM6IHJ1bm5lcj8uZ2V0RXh0ZW5zaW9uUGF0aHMoKSA/PyBbXSxcblx0XHRcdFx0Zm9yY2U6IGZhbHNlLFxuXHRcdFx0XHRzaG93RGlhZ25vc3RpY3NXaGVuUXVpZXQ6IHRydWUsXG5cdFx0XHR9KTtcblx0XHRcdGNvbnN0IG1vZGVsc0pzb25FcnJvciA9IHRoaXMuc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmdldEVycm9yKCk7XG5cdFx0XHRpZiAobW9kZWxzSnNvbkVycm9yKSB7XG5cdFx0XHRcdHRoaXMuc2hvd0Vycm9yKGBtb2RlbHMuanNvbiBlcnJvcjogJHttb2RlbHNKc29uRXJyb3J9YCk7XG5cdFx0XHR9XG5cdFx0XHR0aGlzLnNob3dTdGF0dXMoXCJSZWxvYWRlZCBleHRlbnNpb25zLCBza2lsbHMsIHByb21wdHMsIHRoZW1lc1wiKTtcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0ZGlzbWlzc0xvYWRlcihwcmV2aW91c0VkaXRvciBhcyBDb21wb25lbnQpO1xuXHRcdFx0dGhpcy5zaG93RXJyb3IoYFJlbG9hZCBmYWlsZWQ6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfWApO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgaGFuZGxlQ2xlYXJDb21tYW5kKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdC8vIFN0b3AgbG9hZGluZyBhbmltYXRpb25cblx0XHRpZiAodGhpcy5sb2FkaW5nQW5pbWF0aW9uKSB7XG5cdFx0XHR0aGlzLmxvYWRpbmdBbmltYXRpb24uc3RvcCgpO1xuXHRcdFx0dGhpcy5sb2FkaW5nQW5pbWF0aW9uID0gdW5kZWZpbmVkO1xuXHRcdH1cblx0XHR0aGlzLnN0YXR1c0NvbnRhaW5lci5jbGVhcigpO1xuXG5cdFx0Ly8gTmV3IHNlc3Npb24gdmlhIHNlc3Npb24gKGVtaXRzIGV4dGVuc2lvbiBzZXNzaW9uIGV2ZW50cylcblx0XHRhd2FpdCB0aGlzLnNlc3Npb24ubmV3U2Vzc2lvbigpO1xuXG5cdFx0Ly8gQ2xlYXIgVUkgc3RhdGVcblx0XHR0aGlzLmhlYWRlckNvbnRhaW5lci5jbGVhcigpO1xuXHRcdHRoaXMuY2hhdENvbnRhaW5lci5jbGVhcigpO1xuXHRcdHRoaXMucGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0dGhpcy5jb21wYWN0aW9uUXVldWVkTWVzc2FnZXMgPSBbXTtcblx0XHR0aGlzLnN0cmVhbWluZ0NvbXBvbmVudCA9IHVuZGVmaW5lZDtcblx0XHR0aGlzLnN0cmVhbWluZ01lc3NhZ2UgPSB1bmRlZmluZWQ7XG5cdFx0dGhpcy5wZW5kaW5nVG9vbHMuY2xlYXIoKTtcblx0XHR0aGlzLnBlbmRpbmdJbWFnZXMubGVuZ3RoID0gMDtcblx0XHR0aGlzLmNsZWFyQmxvY2tpbmdFcnJvcigpO1xuXG5cdFx0Ly8gUmVzZXQgY29udGV4dHVhbCB0aXBzIGZvciB0aGUgbmV3IHNlc3Npb25cblx0XHR0aGlzLmNvbnRleHR1YWxUaXBzLnJlc2V0KCk7XG5cblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KGAke3RoZW1lLmZnKFwiYWNjZW50XCIsIFwiXHUyNzEzIE5ldyBzZXNzaW9uIHN0YXJ0ZWRcIil9YCwgMSwgMSkpO1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVEZWJ1Z0NvbW1hbmQoKTogdm9pZCB7XG5cdFx0Y29uc3Qgd2lkdGggPSB0aGlzLnVpLnRlcm1pbmFsLmNvbHVtbnM7XG5cdFx0Y29uc3QgaGVpZ2h0ID0gdGhpcy51aS50ZXJtaW5hbC5yb3dzO1xuXHRcdGNvbnN0IGFsbExpbmVzID0gdGhpcy51aS5yZW5kZXIod2lkdGgpO1xuXG5cdFx0Y29uc3QgZGVidWdMb2dQYXRoID0gZ2V0RGVidWdMb2dQYXRoKCk7XG5cdFx0Y29uc3QgZGVidWdEYXRhID0gW1xuXHRcdFx0YERlYnVnIG91dHB1dCBhdCAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1gLFxuXHRcdFx0YFRlcm1pbmFsOiAke3dpZHRofXgke2hlaWdodH1gLFxuXHRcdFx0YFRvdGFsIGxpbmVzOiAke2FsbExpbmVzLmxlbmd0aH1gLFxuXHRcdFx0XCJcIixcblx0XHRcdFwiPT09IEFsbCByZW5kZXJlZCBsaW5lcyB3aXRoIHZpc2libGUgd2lkdGhzID09PVwiLFxuXHRcdFx0Li4uYWxsTGluZXMubWFwKChsaW5lLCBpZHgpID0+IHtcblx0XHRcdFx0Y29uc3QgdncgPSB2aXNpYmxlV2lkdGgobGluZSk7XG5cdFx0XHRcdGNvbnN0IGVzY2FwZWQgPSBKU09OLnN0cmluZ2lmeShsaW5lKTtcblx0XHRcdFx0cmV0dXJuIGBbJHtpZHh9XSAodz0ke3Z3fSkgJHtlc2NhcGVkfWA7XG5cdFx0XHR9KSxcblx0XHRcdFwiXCIsXG5cdFx0XHRcIj09PSBBZ2VudCBtZXNzYWdlcyAoSlNPTkwpID09PVwiLFxuXHRcdFx0Li4udGhpcy5zZXNzaW9uLm1lc3NhZ2VzLm1hcCgobXNnKSA9PiBKU09OLnN0cmluZ2lmeShtc2cpKSxcblx0XHRcdFwiXCIsXG5cdFx0XS5qb2luKFwiXFxuXCIpO1xuXG5cdFx0ZnMubWtkaXJTeW5jKHBhdGguZGlybmFtZShkZWJ1Z0xvZ1BhdGgpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblx0XHRmcy53cml0ZUZpbGVTeW5jKGRlYnVnTG9nUGF0aCwgZGVidWdEYXRhKTtcblxuXHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQoXG5cdFx0XHRuZXcgVGV4dChgJHt0aGVtZS5mZyhcImFjY2VudFwiLCBcIlx1MjcxMyBEZWJ1ZyBsb2cgd3JpdHRlblwiKX1cXG4ke3RoZW1lLmZnKFwibXV0ZWRcIiwgZGVidWdMb2dQYXRoKX1gLCAxLCAxKSxcblx0XHQpO1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVEYXhudXRzKCk6IHZvaWQge1xuXHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHR0aGlzLmNoYXRDb250YWluZXIuYWRkQ2hpbGQobmV3IERheG51dHNDb21wb25lbnQodGhpcy51aSkpO1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXHR9XG5cblx0cHJpdmF0ZSBjaGVja0RheG51dHNFYXN0ZXJFZ2cobW9kZWw6IHsgcHJvdmlkZXI6IHN0cmluZzsgaWQ6IHN0cmluZyB9KTogdm9pZCB7XG5cdFx0aWYgKG1vZGVsLnByb3ZpZGVyID09PSBcIm9wZW5jb2RlXCIgJiYgbW9kZWwuaWQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImtpbWktazIuNVwiKSkge1xuXHRcdFx0dGhpcy5oYW5kbGVEYXhudXRzKCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBoYW5kbGVCYXNoQ29tbWFuZChjb21tYW5kOiBzdHJpbmcsIGV4Y2x1ZGVGcm9tQ29udGV4dCA9IGZhbHNlLCBkaXNwbGF5Q29tbWFuZD86IHN0cmluZywgbG9naW5TaGVsbD86IGJvb2xlYW4pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBleHRlbnNpb25SdW5uZXIgPSB0aGlzLnNlc3Npb24uZXh0ZW5zaW9uUnVubmVyO1xuXHRcdGNvbnN0IGxhYmVsID0gZGlzcGxheUNvbW1hbmQgfHwgY29tbWFuZDtcblxuXHRcdC8vIEVtaXQgdXNlcl9iYXNoIGV2ZW50IHRvIGxldCBleHRlbnNpb25zIGludGVyY2VwdFxuXHRcdGNvbnN0IGV2ZW50UmVzdWx0ID0gZXh0ZW5zaW9uUnVubmVyXG5cdFx0XHQ/IGF3YWl0IGV4dGVuc2lvblJ1bm5lci5lbWl0VXNlckJhc2goe1xuXHRcdFx0XHRcdHR5cGU6IFwidXNlcl9iYXNoXCIsXG5cdFx0XHRcdFx0Y29tbWFuZCxcblx0XHRcdFx0XHRleGNsdWRlRnJvbUNvbnRleHQsXG5cdFx0XHRcdFx0Y3dkOiBwcm9jZXNzLmN3ZCgpLFxuXHRcdFx0XHR9KVxuXHRcdFx0OiB1bmRlZmluZWQ7XG5cblx0XHQvLyBJZiBleHRlbnNpb24gcmV0dXJuZWQgYSBmdWxsIHJlc3VsdCwgdXNlIGl0IGRpcmVjdGx5XG5cdFx0aWYgKGV2ZW50UmVzdWx0Py5yZXN1bHQpIHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGV2ZW50UmVzdWx0LnJlc3VsdDtcblxuXHRcdFx0Ly8gQ3JlYXRlIFVJIGNvbXBvbmVudCBmb3IgZGlzcGxheVxuXHRcdFx0dGhpcy5iYXNoQ29tcG9uZW50ID0gbmV3IEJhc2hFeGVjdXRpb25Db21wb25lbnQobGFiZWwsIHRoaXMudWksIGV4Y2x1ZGVGcm9tQ29udGV4dCk7XG5cdFx0XHRpZiAodGhpcy5zZXNzaW9uLmlzU3RyZWFtaW5nKSB7XG5cdFx0XHRcdHRoaXMucGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyLmFkZENoaWxkKHRoaXMuYmFzaENvbXBvbmVudCk7XG5cdFx0XHRcdHRoaXMucGVuZGluZ0Jhc2hDb21wb25lbnRzLnB1c2godGhpcy5iYXNoQ29tcG9uZW50KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZCh0aGlzLmJhc2hDb21wb25lbnQpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBTaG93IG91dHB1dCBhbmQgY29tcGxldGVcblx0XHRcdGlmIChyZXN1bHQub3V0cHV0KSB7XG5cdFx0XHRcdHRoaXMuYmFzaENvbXBvbmVudC5hcHBlbmRPdXRwdXQocmVzdWx0Lm91dHB1dCk7XG5cdFx0XHR9XG5cdFx0XHR0aGlzLmJhc2hDb21wb25lbnQuc2V0Q29tcGxldGUoXG5cdFx0XHRcdHJlc3VsdC5leGl0Q29kZSxcblx0XHRcdFx0cmVzdWx0LmNhbmNlbGxlZCxcblx0XHRcdFx0cmVzdWx0LnRydW5jYXRlZCA/ICh7IHRydW5jYXRlZDogdHJ1ZSwgY29udGVudDogcmVzdWx0Lm91dHB1dCB9IGFzIFRydW5jYXRpb25SZXN1bHQpIDogdW5kZWZpbmVkLFxuXHRcdFx0XHRyZXN1bHQuZnVsbE91dHB1dFBhdGgsXG5cdFx0XHQpO1xuXG5cdFx0XHQvLyBSZWNvcmQgdGhlIHJlc3VsdCBpbiBzZXNzaW9uXG5cdFx0XHR0aGlzLnNlc3Npb24ucmVjb3JkQmFzaFJlc3VsdChjb21tYW5kLCByZXN1bHQsIHsgZXhjbHVkZUZyb21Db250ZXh0IH0pO1xuXHRcdFx0dGhpcy5iYXNoQ29tcG9uZW50ID0gdW5kZWZpbmVkO1xuXHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gTm9ybWFsIGV4ZWN1dGlvbiBwYXRoIChwb3NzaWJseSB3aXRoIGN1c3RvbSBvcGVyYXRpb25zKVxuXHRcdGNvbnN0IGlzRGVmZXJyZWQgPSB0aGlzLnNlc3Npb24uaXNTdHJlYW1pbmc7XG5cdFx0dGhpcy5iYXNoQ29tcG9uZW50ID0gbmV3IEJhc2hFeGVjdXRpb25Db21wb25lbnQobGFiZWwsIHRoaXMudWksIGV4Y2x1ZGVGcm9tQ29udGV4dCk7XG5cblx0XHRpZiAoaXNEZWZlcnJlZCkge1xuXHRcdFx0Ly8gU2hvdyBpbiBwZW5kaW5nIGFyZWEgd2hlbiBhZ2VudCBpcyBzdHJlYW1pbmdcblx0XHRcdHRoaXMucGVuZGluZ01lc3NhZ2VzQ29udGFpbmVyLmFkZENoaWxkKHRoaXMuYmFzaENvbXBvbmVudCk7XG5cdFx0XHR0aGlzLnBlbmRpbmdCYXNoQ29tcG9uZW50cy5wdXNoKHRoaXMuYmFzaENvbXBvbmVudCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdC8vIFNob3cgaW4gY2hhdCBpbW1lZGlhdGVseSB3aGVuIGFnZW50IGlzIGlkbGVcblx0XHRcdHRoaXMuY2hhdENvbnRhaW5lci5hZGRDaGlsZCh0aGlzLmJhc2hDb21wb25lbnQpO1xuXHRcdH1cblx0XHR0aGlzLnVpLnJlcXVlc3RSZW5kZXIoKTtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnNlc3Npb24uZXhlY3V0ZUJhc2goXG5cdFx0XHRcdGNvbW1hbmQsXG5cdFx0XHRcdChjaHVuaykgPT4ge1xuXHRcdFx0XHRcdGlmICh0aGlzLmJhc2hDb21wb25lbnQpIHtcblx0XHRcdFx0XHRcdHRoaXMuYmFzaENvbXBvbmVudC5hcHBlbmRPdXRwdXQoY2h1bmspO1xuXHRcdFx0XHRcdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9LFxuXHRcdFx0XHR7IGV4Y2x1ZGVGcm9tQ29udGV4dCwgb3BlcmF0aW9uczogZXZlbnRSZXN1bHQ/Lm9wZXJhdGlvbnMsIGxvZ2luU2hlbGwgfSxcblx0XHRcdCk7XG5cblx0XHRcdGlmICh0aGlzLmJhc2hDb21wb25lbnQpIHtcblx0XHRcdFx0dGhpcy5iYXNoQ29tcG9uZW50LnNldENvbXBsZXRlKFxuXHRcdFx0XHRcdHJlc3VsdC5leGl0Q29kZSxcblx0XHRcdFx0XHRyZXN1bHQuY2FuY2VsbGVkLFxuXHRcdFx0XHRcdHJlc3VsdC50cnVuY2F0ZWQgPyAoeyB0cnVuY2F0ZWQ6IHRydWUsIGNvbnRlbnQ6IHJlc3VsdC5vdXRwdXQgfSBhcyBUcnVuY2F0aW9uUmVzdWx0KSA6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRyZXN1bHQuZnVsbE91dHB1dFBhdGgsXG5cdFx0XHRcdCk7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdGlmICh0aGlzLmJhc2hDb21wb25lbnQpIHtcblx0XHRcdFx0dGhpcy5iYXNoQ29tcG9uZW50LnNldENvbXBsZXRlKHVuZGVmaW5lZCwgZmFsc2UpO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5zaG93RXJyb3IoYEJhc2ggY29tbWFuZCBmYWlsZWQ6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBcIlVua25vd24gZXJyb3JcIn1gKTtcblx0XHR9XG5cblx0XHR0aGlzLmJhc2hDb21wb25lbnQgPSB1bmRlZmluZWQ7XG5cdFx0dGhpcy51aS5yZXF1ZXN0UmVuZGVyKCk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGV4ZWN1dGVDb21wYWN0aW9uKGN1c3RvbUluc3RydWN0aW9ucz86IHN0cmluZywgaXNBdXRvID0gZmFsc2UpOiBQcm9taXNlPENvbXBhY3Rpb25SZXN1bHQgfCB1bmRlZmluZWQ+IHtcblx0XHQvLyBTdG9wIGxvYWRpbmcgYW5pbWF0aW9uXG5cdFx0aWYgKHRoaXMubG9hZGluZ0FuaW1hdGlvbikge1xuXHRcdFx0dGhpcy5sb2FkaW5nQW5pbWF0aW9uLnN0b3AoKTtcblx0XHRcdHRoaXMubG9hZGluZ0FuaW1hdGlvbiA9IHVuZGVmaW5lZDtcblx0XHR9XG5cdFx0dGhpcy5zdGF0dXNDb250YWluZXIuY2xlYXIoKTtcblxuXHRcdC8vIFNldCB1cCBlc2NhcGUgaGFuZGxlciBkdXJpbmcgY29tcGFjdGlvblxuXHRcdGNvbnN0IG9yaWdpbmFsT25Fc2NhcGUgPSB0aGlzLmRlZmF1bHRFZGl0b3Iub25Fc2NhcGU7XG5cdFx0dGhpcy5kZWZhdWx0RWRpdG9yLm9uRXNjYXBlID0gKCkgPT4ge1xuXHRcdFx0dGhpcy5zZXNzaW9uLmFib3J0Q29tcGFjdGlvbigpO1xuXHRcdH07XG5cblx0XHQvLyBTaG93IGNvbXBhY3Rpbmcgc3RhdHVzXG5cdFx0dGhpcy5jaGF0Q29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdGNvbnN0IGNhbmNlbEhpbnQgPSBgKCR7YXBwS2V5KHRoaXMua2V5YmluZGluZ3MsIFwiaW50ZXJydXB0XCIpfSB0byBjYW5jZWwpYDtcblx0XHRjb25zdCBsYWJlbCA9IGlzQXV0byA/IGBBdXRvLWNvbXBhY3RpbmcgY29udGV4dC4uLiAke2NhbmNlbEhpbnR9YCA6IGBDb21wYWN0aW5nIGNvbnRleHQuLi4gJHtjYW5jZWxIaW50fWA7XG5cdFx0Y29uc3QgY29tcGFjdGluZ0xvYWRlciA9IG5ldyBMb2FkZXIoXG5cdFx0XHR0aGlzLnVpLFxuXHRcdFx0KHNwaW5uZXIpID0+IHRoZW1lLmZnKFwiYWNjZW50XCIsIHNwaW5uZXIpLFxuXHRcdFx0KHRleHQpID0+IHRoZW1lLmZnKFwibXV0ZWRcIiwgdGV4dCksXG5cdFx0XHRsYWJlbCxcblx0XHQpO1xuXHRcdHRoaXMuc3RhdHVzQ29udGFpbmVyLmFkZENoaWxkKGNvbXBhY3RpbmdMb2FkZXIpO1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcigpO1xuXG5cdFx0bGV0IHJlc3VsdDogQ29tcGFjdGlvblJlc3VsdCB8IHVuZGVmaW5lZDtcblxuXHRcdHRyeSB7XG5cdFx0XHRyZXN1bHQgPSBhd2FpdCB0aGlzLnNlc3Npb24uY29tcGFjdChjdXN0b21JbnN0cnVjdGlvbnMpO1xuXG5cdFx0XHQvLyBSZWJ1aWxkIFVJXG5cdFx0XHR0aGlzLnJlYnVpbGRDaGF0RnJvbU1lc3NhZ2VzKCk7XG5cblx0XHRcdC8vIEFkZCBjb21wYWN0aW9uIGNvbXBvbmVudCBhdCBib3R0b20gc28gdXNlciBzZWVzIGl0IHdpdGhvdXQgc2Nyb2xsaW5nXG5cdFx0XHRjb25zdCBtc2cgPSBjcmVhdGVDb21wYWN0aW9uU3VtbWFyeU1lc3NhZ2UocmVzdWx0LnN1bW1hcnksIHJlc3VsdC50b2tlbnNCZWZvcmUsIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSk7XG5cdFx0XHR0aGlzLmFkZE1lc3NhZ2VUb0NoYXQobXNnKTtcblxuXHRcdFx0dGhpcy5mb290ZXIuaW52YWxpZGF0ZSgpO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuXHRcdFx0aWYgKG1lc3NhZ2UgPT09IFwiQ29tcGFjdGlvbiBjYW5jZWxsZWRcIiB8fCAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvciAmJiBlcnJvci5uYW1lID09PSBcIkFib3J0RXJyb3JcIikpIHtcblx0XHRcdFx0dGhpcy5zaG93RXJyb3IoXCJDb21wYWN0aW9uIGNhbmNlbGxlZFwiKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMuc2hvd0Vycm9yKGBDb21wYWN0aW9uIGZhaWxlZDogJHttZXNzYWdlfWApO1xuXHRcdFx0fVxuXHRcdH0gZmluYWxseSB7XG5cdFx0XHRjb21wYWN0aW5nTG9hZGVyLnN0b3AoKTtcblx0XHRcdHRoaXMuc3RhdHVzQ29udGFpbmVyLmNsZWFyKCk7XG5cdFx0XHR0aGlzLmRlZmF1bHRFZGl0b3Iub25Fc2NhcGUgPSBvcmlnaW5hbE9uRXNjYXBlO1xuXHRcdH1cblx0XHR2b2lkIHRoaXMuZmx1c2hDb21wYWN0aW9uUXVldWUoeyB3aWxsUmV0cnk6IGZhbHNlIH0pO1xuXHRcdHJldHVybiByZXN1bHQ7XG5cdH1cblxuXHRyZXF1ZXN0UmVuZGVyKGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcblx0XHRpZiAoIXRoaXMuaXNJbml0aWFsaXplZCkgcmV0dXJuO1xuXHRcdHRoaXMudWkucmVxdWVzdFJlbmRlcihmb3JjZSk7XG5cdH1cblxuXHRzdG9wKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLmxvYWRpbmdBbmltYXRpb24pIHtcblx0XHRcdHRoaXMubG9hZGluZ0FuaW1hdGlvbi5zdG9wKCk7XG5cdFx0XHR0aGlzLmxvYWRpbmdBbmltYXRpb24gPSB1bmRlZmluZWQ7XG5cdFx0fVxuXHRcdHRoaXMuY2xlYXJFeHRlbnNpb25UZXJtaW5hbElucHV0TGlzdGVuZXJzKCk7XG5cblx0XHQvLyBDbGVhbiB1cCBicmFuY2ggY2hhbmdlIGxpc3RlbmVyIChGaXggMSlcblx0XHR0aGlzLl9icmFuY2hDaGFuZ2VVbnN1Yj8uKCk7XG5cdFx0dGhpcy5fYnJhbmNoQ2hhbmdlVW5zdWIgPSB1bmRlZmluZWQ7XG5cblx0XHQvLyBDbGVhbiB1cCB0aGVtZSBjaGFuZ2UgbGlzdGVuZXIgYW5kIHdhdGNoZXIgKEZpeCAyKVxuXHRcdG9uVGhlbWVDaGFuZ2UoKCkgPT4ge30pO1xuXHRcdHN0b3BUaGVtZVdhdGNoZXIoKTtcblxuXHRcdC8vIFJlc29sdmUgYW55IHBlbmRpbmcgZ2V0VXNlcklucHV0IHByb21pc2Ugc28gdGhlIHJ1bigpIGxvb3AgY2FuIGV4aXQgKEZpeCAzKVxuXHRcdGlmICh0aGlzLm9uSW5wdXRDYWxsYmFjaykge1xuXHRcdFx0dGhpcy5vbklucHV0Q2FsbGJhY2soXCJcIik7XG5cdFx0XHR0aGlzLm9uSW5wdXRDYWxsYmFjayA9IHVuZGVmaW5lZDtcblx0XHR9XG5cblx0XHQvLyBEaXNwb3NlIGV4dGVuc2lvbiB3aWRnZXRzLCBjdXN0b20gZm9vdGVyLCBhbmQgY3VzdG9tIGhlYWRlciAoRml4IDQpXG5cdFx0dGhpcy5jbGVhckV4dGVuc2lvbldpZGdldHMoKTtcblx0XHRpZiAodGhpcy5jdXN0b21Gb290ZXI/LmRpc3Bvc2UpIHtcblx0XHRcdHRoaXMuY3VzdG9tRm9vdGVyLmRpc3Bvc2UoKTtcblx0XHR9XG5cdFx0dGhpcy5jdXN0b21Gb290ZXIgPSB1bmRlZmluZWQ7XG5cdFx0aWYgKHRoaXMuY3VzdG9tSGVhZGVyPy5kaXNwb3NlKSB7XG5cdFx0XHR0aGlzLmN1c3RvbUhlYWRlci5kaXNwb3NlKCk7XG5cdFx0fVxuXHRcdHRoaXMuY3VzdG9tSGVhZGVyID0gdW5kZWZpbmVkO1xuXHRcdHRoaXMuYXV0b2NvbXBsZXRlUHJvdmlkZXIgPSB1bmRlZmluZWQ7XG5cblx0XHR0aGlzLmZvb3Rlci5kaXNwb3NlKCk7XG5cdFx0dGhpcy5mb290ZXJEYXRhUHJvdmlkZXIuZGlzcG9zZSgpO1xuXHRcdGlmICh0aGlzLnVuc3Vic2NyaWJlKSB7XG5cdFx0XHR0aGlzLnVuc3Vic2NyaWJlKCk7XG5cdFx0fVxuXHRcdGlmICh0aGlzLmlzSW5pdGlhbGl6ZWQpIHtcblx0XHRcdHRoaXMudWkuc3RvcCgpO1xuXHRcdFx0dGhpcy5pc0luaXRpYWxpemVkID0gZmFsc2U7XG5cdFx0fVxuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxZQUFZLFFBQVE7QUFDcEIsWUFBWSxRQUFRO0FBQ3BCLFlBQVksVUFBVTtBQUN0QixTQUFTLHVCQUF1QjtBQWFoQztBQUFBLEVBQ0M7QUFBQSxFQUVBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVB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
