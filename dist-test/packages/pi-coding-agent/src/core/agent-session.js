import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { modelsAreEqual, resetApiProviders, supportsXhigh } from "@gsd/pi-ai";
import { Type } from "@sinclair/typebox";
import { getDocsPath } from "../config.js";
import { getErrorMessage } from "../utils/error.js";
import { theme } from "../modes/interactive/theme/theme.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { executeBash as executeBashCommand, executeBashWithOperations } from "./bash-executor.js";
import {
  calculateContextTokens,
  collectEntriesForBranchSummary,
  estimateContextTokens,
  generateBranchSummary
} from "./compaction/index.js";
import { CompactionOrchestrator } from "./compaction-orchestrator.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { exportSessionToHtml } from "./export-html/index.js";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.js";
import {
  ExtensionRunner,
  wrapRegisteredTools
} from "./extensions/index.js";
import { FallbackResolver } from "./fallback-resolver.js";
import { expandPromptTemplate } from "./prompt-templates.js";
import { RetryHandler } from "./retry-handler.js";
import { isImageDimensionError, downsizeConversationImages } from "./image-overflow-recovery.js";
import { getLatestCompactionEntry } from "./session-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { emitTokenTelemetry } from "./token-telemetry.js";
import { createAllTools } from "./tools/index.js";
function parseSkillBlock(text) {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return null;
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() || void 0
  };
}
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
const THINKING_LEVELS_WITH_XHIGH = ["off", "minimal", "low", "medium", "high", "xhigh"];
class AgentSession {
  constructor(config) {
    this._eventListeners = [];
    this._agentEventQueue = Promise.resolve();
    /** Tracks pending steering messages for UI display. Removed when delivered. */
    this._steeringMessages = [];
    /** Tracks pending follow-up messages for UI display. Removed when delivered. */
    this._followUpMessages = [];
    /** Messages queued to be included with the next user prompt as context ("asides"). */
    this._pendingNextTurnMessages = [];
    // Cumulative session stats — survives compaction (#1423)
    this._cumulativeCost = 0;
    this._cumulativeInputTokens = 0;
    this._cumulativeOutputTokens = 0;
    this._cumulativeToolCalls = 0;
    /** Cost of the most recent assistant response (for per-prompt display). */
    this._lastTurnCost = 0;
    // Bash execution state
    this._bashAbortController = void 0;
    this._pendingBashMessages = [];
    // Extension system
    this._extensionRunner = void 0;
    this._turnIndex = 0;
    this._processingAgentEnd = false;
    /** True while newSession()/switchSession() is in progress; signals agent_end
     * post-handlers to bail rather than corrupt new-session state. */
    this._sessionSwitchPending = false;
    this._processingQueuedAgentEnd = false;
    this._sessionTransitionStartedDuringAgentEnd = false;
    this._baseToolRegistry = /* @__PURE__ */ new Map();
    // Tool registry for extension getTools/setTools
    this._toolRegistry = /* @__PURE__ */ new Map();
    this._toolPromptSnippets = /* @__PURE__ */ new Map();
    this._toolPromptGuidelines = /* @__PURE__ */ new Map();
    // Base system prompt (without extension appends) - used to apply fresh appends each turn
    this._baseSystemPrompt = "";
    // Optional prompt-only skill catalog filter. Skills remain loaded and invocable by name.
    this._visibleSkillNames = void 0;
    // Track last assistant message for auto-compaction check
    this._lastAssistantMessage = void 0;
    /** Internal handler for agent events - shared by subscribe and reconnect */
    this._handleAgentEvent = (event) => {
      this._createRetryPromiseForAgentEnd(event);
      this._agentEventQueue = this._agentEventQueue.then(
        () => this._processAgentEvent(event),
        () => this._processAgentEvent(event)
      );
      this._agentEventQueue.catch(() => {
      });
    };
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this.settingsManager = config.settingsManager;
    this._scopedModels = config.scopedModels ?? [];
    this._resourceLoader = config.resourceLoader;
    this._customTools = config.customTools ?? [];
    this._cwd = config.cwd;
    this._modelRegistry = config.modelRegistry;
    this._fallbackResolver = new FallbackResolver(
      this.settingsManager,
      this._modelRegistry.authStorage,
      this._modelRegistry
    );
    this._extensionRunnerRef = config.extensionRunnerRef;
    this._workspaceRootRef = config.workspaceRootRef;
    if (this._workspaceRootRef) {
      this._workspaceRootRef.current = this._cwd;
    }
    this._initialActiveToolNames = config.initialActiveToolNames;
    this._baseToolsOverride = config.baseToolsOverride;
    this._retryHandler = new RetryHandler({
      agent: this.agent,
      settingsManager: this.settingsManager,
      modelRegistry: this._modelRegistry,
      fallbackResolver: this._fallbackResolver,
      getModel: () => this.model,
      getSessionId: () => this.sessionId,
      emit: (event) => this._emit(event),
      onModelChange: (model) => this.sessionManager.appendModelChange(model.provider, model.id),
      isClaudeCodeReady: config.isClaudeCodeReady
    });
    this._compactionOrchestrator = new CompactionOrchestrator({
      agent: this.agent,
      sessionManager: this.sessionManager,
      settingsManager: this.settingsManager,
      modelRegistry: this._modelRegistry,
      getModel: () => this.model,
      getSessionId: () => this.sessionId,
      getExtensionRunner: () => this._extensionRunner,
      emit: (event) => this._emit(event),
      disconnectFromAgent: () => this._disconnectFromAgent(),
      reconnectToAgent: () => this._reconnectToAgent(),
      abort: () => this.abort({ origin: "user" })
    });
    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
    this._installAgentToolHooks();
    this._buildRuntime({
      activeToolNames: this._initialActiveToolNames,
      includeAllExtensionTools: true
    });
  }
  /** Model registry for API key resolution and model discovery */
  get modelRegistry() {
    return this._modelRegistry;
  }
  /** Fallback resolver for cross-provider fallback */
  get fallbackResolver() {
    return this._fallbackResolver;
  }
  // =========================================================================
  // Event Subscription
  // =========================================================================
  /** Emit an event to all listeners */
  _emit(event) {
    for (const l of this._eventListeners) {
      l(event);
    }
  }
  _emitSessionStateChanged(reason) {
    this._emit({ type: "session_state_changed", reason });
  }
  _createRetryPromiseForAgentEnd(event) {
    if (event.type !== "agent_end") return;
    this._retryHandler.createRetryPromiseForAgentEnd(event.messages);
  }
  async _processAgentEvent(event) {
    if (event.type === "message_start" && event.message.role === "user") {
      this._compactionOrchestrator.resetOverflowRecovery();
      const messageText = this._getUserMessageText(event.message);
      if (messageText) {
        const steeringIndex = this._steeringMessages.indexOf(messageText);
        if (steeringIndex !== -1) {
          this._steeringMessages.splice(steeringIndex, 1);
        } else {
          const followUpIndex = this._followUpMessages.indexOf(messageText);
          if (followUpIndex !== -1) {
            this._followUpMessages.splice(followUpIndex, 1);
          }
        }
      }
    }
    let skipAgentEndPostHandlers = false;
    if (event.type === "agent_end") {
      this._processingQueuedAgentEnd = true;
      try {
        await this._emitExtensionEvent(event);
      } finally {
        this._processingQueuedAgentEnd = false;
        skipAgentEndPostHandlers = this._sessionTransitionStartedDuringAgentEnd;
        this._sessionTransitionStartedDuringAgentEnd = false;
      }
      if (skipAgentEndPostHandlers) {
        return;
      }
    } else {
      await this._emitExtensionEvent(event);
    }
    this._emit(event);
    if (event.type === "message_end") {
      if (event.message.role === "custom") {
        this.sessionManager.appendCustomMessageEntry(
          event.message.customType,
          event.message.content,
          event.message.display,
          event.message.details
        );
      } else if (event.message.role === "user" || event.message.role === "assistant" || event.message.role === "toolResult") {
        this.sessionManager.appendMessage(event.message);
      }
      if (event.message.role === "assistant") {
        this._lastAssistantMessage = event.message;
        const assistantMsg = event.message;
        this._lastTurnCost = assistantMsg.usage?.cost?.total ?? 0;
        this._cumulativeCost += assistantMsg.usage?.cost?.total ?? 0;
        this._cumulativeInputTokens += assistantMsg.usage?.input ?? 0;
        this._cumulativeOutputTokens += assistantMsg.usage?.output ?? 0;
        this._cumulativeToolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
        emitTokenTelemetry(assistantMsg);
        if (assistantMsg.stopReason !== "error") {
          this._compactionOrchestrator.clearOverflowRecovery();
        }
        if (assistantMsg.stopReason !== "error") {
          this._retryHandler.handleSuccessfulResponse();
        }
      }
    }
    if (event.type === "agent_end" && this._lastAssistantMessage) {
      if (this._sessionSwitchPending) {
        this._lastAssistantMessage = void 0;
        return;
      }
      const msg = this._lastAssistantMessage;
      this._lastAssistantMessage = void 0;
      if (this._retryHandler.isRetryableError(msg)) {
        const didRetry = await this._retryHandler.handleRetryableError(msg);
        if (didRetry) return;
      }
      if (msg.stopReason === "error" && isImageDimensionError(msg.errorMessage)) {
        const messages = this.agent.state.messages;
        const result = downsizeConversationImages(messages);
        if (result.processed) {
          if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
            this.agent.replaceMessages(messages.slice(0, -1));
          }
          this._emit({
            type: "image_overflow_recovery",
            strippedCount: result.strippedCount,
            imageCount: result.imageCount
          });
          setTimeout(() => {
            this.agent.continue().catch(() => {
            });
          }, 0);
          return;
        }
      }
      await this._compactionOrchestrator.checkCompaction(msg);
    }
  }
  /**
   * Install beforeToolCall/afterToolCall hooks on the Agent.
   *
   * These hooks await `_agentEventQueue` before emitting extension events,
   * ensuring that all prior events (including `message_end` which appends
   * the assistant message) have fully settled. This prevents a race condition
   * in parallel tool execution where extension `tool_call` handlers could
   * see stale agent state.
   */
  _installAgentToolHooks() {
    this.agent.setBeforeToolCall(async ({ toolCall, args }) => {
      await this._agentEventQueue;
      if (!this._extensionRunner?.hasHandlers("tool_call")) return void 0;
      try {
        const callResult = await this._extensionRunner.emitToolCall({
          type: "tool_call",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          input: args
        });
        if (callResult?.block) {
          return {
            block: true,
            reason: callResult.reason || "Tool execution was blocked by an extension"
          };
        }
      } catch (err) {
        return { block: true, reason: err instanceof Error ? err.message : `Extension failed, blocking execution: ${String(err)}` };
      }
      return void 0;
    });
    this.agent.setAfterToolCall(async ({ toolCall, args, result, isError }) => {
      await this._agentEventQueue;
      if (!this._extensionRunner?.hasHandlers("tool_result")) return void 0;
      const resultResult = await this._extensionRunner.emitToolResult({
        type: "tool_result",
        toolName: toolCall.name,
        toolCallId: toolCall.id,
        input: args,
        content: result.content,
        details: result.details,
        isError
      });
      if (resultResult) {
        return {
          content: resultResult.content ?? void 0,
          details: resultResult.details ?? void 0
        };
      }
      return void 0;
    });
  }
  /** Extract text content from a message */
  _getUserMessageText(message) {
    if (message.role !== "user") return "";
    const content = message.content;
    if (typeof content === "string") return content;
    const textBlocks = content.filter((c) => c.type === "text");
    return textBlocks.map((c) => c.text).join("");
  }
  /** Find the last assistant message in agent state (including aborted ones) */
  _findLastAssistantMessage() {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        return msg;
      }
    }
    return void 0;
  }
  /** Emit extension events based on agent events */
  async _emitExtensionEvent(event) {
    const extensionRunner = this._extensionRunner;
    if (!extensionRunner) return;
    if (event.type === "agent_start") {
      this._turnIndex = 0;
      await extensionRunner.emit({
        type: "agent_start",
        sessionId: event.sessionId,
        turnId: event.turnId
      });
    } else if (event.type === "agent_end") {
      this._processingAgentEnd = true;
      try {
        await extensionRunner.emit({
          type: "agent_end",
          messages: event.messages,
          sessionId: event.sessionId,
          turnId: event.turnId,
          abortOrigin: event.abortOrigin
        });
        const last = event.messages[event.messages.length - 1];
        const stopReason = last?.role === "assistant" ? last.stopReason === "aborted" ? "cancelled" : last.stopReason === "error" ? "error" : "completed" : "completed";
        await extensionRunner.emitStop({
          reason: stopReason,
          lastMessage: last,
          sessionId: event.sessionId,
          turnId: event.turnId,
          abortOrigin: event.abortOrigin
        });
      } finally {
        this._processingAgentEnd = false;
      }
    } else if (event.type === "turn_start") {
      const extensionEvent = {
        type: "turn_start",
        turnIndex: this._turnIndex,
        timestamp: Date.now(),
        sessionId: event.sessionId,
        turnId: event.turnId
      };
      await extensionRunner.emit(extensionEvent);
    } else if (event.type === "turn_end") {
      const extensionEvent = {
        type: "turn_end",
        turnIndex: this._turnIndex,
        message: event.message,
        toolResults: event.toolResults,
        sessionId: event.sessionId,
        turnId: event.turnId
      };
      await extensionRunner.emit(extensionEvent);
      this._turnIndex++;
    } else if (event.type === "message_start") {
      const extensionEvent = {
        type: "message_start",
        message: event.message,
        sessionId: event.sessionId,
        turnId: event.turnId
      };
      await extensionRunner.emit(extensionEvent);
    } else if (event.type === "message_update") {
      const extensionEvent = {
        type: "message_update",
        message: event.message,
        assistantMessageEvent: event.assistantMessageEvent,
        sessionId: event.sessionId,
        turnId: event.turnId
      };
      await extensionRunner.emit(extensionEvent);
    } else if (event.type === "message_end") {
      const extensionEvent = {
        type: "message_end",
        message: event.message,
        sessionId: event.sessionId,
        turnId: event.turnId
      };
      await extensionRunner.emit(extensionEvent);
    } else if (event.type === "tool_execution_start") {
      const extensionEvent = {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args
      };
      await extensionRunner.emit(extensionEvent);
    } else if (event.type === "tool_execution_update") {
      const extensionEvent = {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult
      };
      await extensionRunner.emit(extensionEvent);
    } else if (event.type === "tool_execution_end") {
      const extensionEvent = {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError
      };
      await extensionRunner.emit(extensionEvent);
    }
  }
  /**
   * Subscribe to agent events.
   * Session persistence is handled internally (saves messages on message_end).
   * Multiple listeners can be added. Returns unsubscribe function for this listener.
   */
  subscribe(listener) {
    this._eventListeners.push(listener);
    return () => {
      const index = this._eventListeners.indexOf(listener);
      if (index !== -1) {
        this._eventListeners.splice(index, 1);
      }
    };
  }
  /**
   * Temporarily disconnect from agent events.
   * User listeners are preserved and will receive events again after resubscribe().
   * Used internally during operations that need to pause event processing.
   */
  _disconnectFromAgent() {
    if (this._unsubscribeAgent) {
      this._unsubscribeAgent();
      this._unsubscribeAgent = void 0;
    }
  }
  /**
   * Reconnect to agent events after _disconnectFromAgent().
   * Preserves all existing listeners.
   */
  _reconnectToAgent() {
    if (this._unsubscribeAgent) return;
    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
  }
  /**
   * Remove all listeners and disconnect from agent.
   * Call this when completely done with the session.
   */
  dispose() {
    this._extensionErrorUnsubscriber?.();
    this._extensionErrorUnsubscriber = void 0;
    this._disconnectFromAgent();
    this._eventListeners = [];
  }
  // =========================================================================
  // Read-only State Access
  // =========================================================================
  /** Full agent state */
  get state() {
    return this.agent.state;
  }
  /** Current model (may be undefined if not yet selected) */
  get model() {
    return this.agent.state.model;
  }
  /** Current thinking level */
  get thinkingLevel() {
    return this.agent.state.thinkingLevel;
  }
  /** Whether agent is currently streaming a response */
  get isStreaming() {
    return this.agent.state.isStreaming;
  }
  /** Current effective system prompt (includes any per-turn extension modifications) */
  get systemPrompt() {
    return this.agent.state.systemPrompt;
  }
  /** Current retry attempt (0 if not retrying) */
  get retryAttempt() {
    return this._retryHandler.retryAttempt;
  }
  /**
   * Get the names of currently active tools.
   * Returns the names of tools currently set on the agent.
   */
  getActiveToolNames() {
    return this.agent.state.tools.map((t) => t.name);
  }
  /**
   * Get all configured tools with name, description, and parameter schema.
   */
  getAllTools() {
    return Array.from(this._toolRegistry.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));
  }
  /**
   * Set active tools by name.
   * Only tools in the registry can be enabled. Unknown tool names are ignored.
   * Also rebuilds the system prompt to reflect the new tool set.
   * Changes take effect on the next agent turn.
   */
  setActiveToolsByName(toolNames) {
    const requestedToolNames = [.../* @__PURE__ */ new Set([...toolNames, ...this._getBuiltinToolNames()])];
    const tools = [];
    const validToolNames = [];
    for (const name of requestedToolNames) {
      const tool = this._toolRegistry.get(name);
      if (tool) {
        tools.push(tool);
        validToolNames.push(name);
      }
    }
    this.agent.setTools(tools);
    this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
    this.agent.setSystemPrompt(this._baseSystemPrompt);
  }
  /**
   * Set or clear a prompt-only filter for the <available_skills> catalog.
   *
   * This does not unload skills or disable the Skill tool. It only controls
   * which loaded skills are advertised in the system prompt on rebuild.
   */
  setVisibleSkillsByName(skillNames) {
    this._visibleSkillNames = skillNames === void 0 ? void 0 : new Set(skillNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
    this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
    this.agent.setSystemPrompt(this._baseSystemPrompt);
  }
  /** Get the current prompt-only skill catalog filter, if one is active. */
  getVisibleSkillNames() {
    return this._visibleSkillNames ? [...this._visibleSkillNames] : void 0;
  }
  /** Whether compaction or branch summarization is currently running */
  get isCompacting() {
    return this._compactionOrchestrator.isCompacting;
  }
  /**
   * Switch edit mode between standard (text-match) and hashline (LINE#ID anchors).
   * Swaps the active read/edit tools and rebuilds the system prompt.
   */
  setEditMode(mode) {
    this.settingsManager.setEditMode(mode);
    const currentKeys = /* @__PURE__ */ new Set();
    for (const [key, tool] of this._toolRegistry.entries()) {
      if (this.agent.state.tools.includes(tool)) {
        currentKeys.add(key);
      }
    }
    if (mode === "hashline") {
      currentKeys.delete("read");
      currentKeys.add("hashline_read");
      currentKeys.delete("edit");
      currentKeys.add("hashline_edit");
    } else {
      currentKeys.delete("hashline_read");
      currentKeys.add("read");
      currentKeys.delete("hashline_edit");
      currentKeys.add("edit");
    }
    this.setActiveToolsByName([...currentKeys]);
  }
  /** Current edit mode */
  get editMode() {
    return this.settingsManager.getEditMode();
  }
  /** All messages including custom types like BashExecutionMessage */
  get messages() {
    return this.agent.state.messages;
  }
  /** Current steering mode */
  get steeringMode() {
    return this.agent.getSteeringMode();
  }
  /** Current follow-up mode */
  get followUpMode() {
    return this.agent.getFollowUpMode();
  }
  /** Current session file path, or undefined if sessions are disabled */
  get sessionFile() {
    return this.sessionManager.getSessionFile();
  }
  /** Current session ID */
  get sessionId() {
    return this.sessionManager.getSessionId();
  }
  /** Current session display name, if set */
  get sessionName() {
    return this.sessionManager.getSessionName();
  }
  /** Scoped models for cycling (from --models flag) */
  get scopedModels() {
    return this._scopedModels;
  }
  /** Update scoped models for cycling */
  setScopedModels(scopedModels) {
    this._scopedModels = scopedModels;
  }
  /** File-based prompt templates */
  get promptTemplates() {
    return this._resourceLoader.getPrompts().prompts;
  }
  _normalizePromptSnippet(text) {
    if (!text) return void 0;
    const oneLine = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return oneLine.length > 0 ? oneLine : void 0;
  }
  _normalizePromptGuidelines(guidelines) {
    if (!guidelines || guidelines.length === 0) {
      return [];
    }
    const unique = /* @__PURE__ */ new Set();
    for (const guideline of guidelines) {
      const normalized = guideline.trim();
      if (normalized.length > 0) {
        unique.add(normalized);
      }
    }
    return Array.from(unique);
  }
  _findSkillByName(skillName) {
    return this.resourceLoader.getSkills().skills.find((skill) => skill.name === skillName);
  }
  _formatMissingSkillMessage(skillName) {
    const availableSkills = this.resourceLoader.getSkills().skills.map((skill) => skill.name).join(", ") || "(none)";
    return `Skill "${skillName}" not found. Available skills: ${availableSkills}`;
  }
  _emitSkillExpansionError(skillFilePath, err) {
    this._extensionRunner?.emitError({
      extensionPath: skillFilePath,
      event: "skill_expansion",
      error: getErrorMessage(err)
    });
  }
  _renderSkillInvocation(skill, args) {
    const content = readFileSync(skill.filePath, "utf-8");
    const body = stripFrontmatter(content).trim();
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${skill.baseDir}.

${body}
</skill>`;
    return args && args.trim() ? `${skillBlock}

${args.trim()}` : skillBlock;
  }
  _expandSkillByName(skillName, args) {
    const skill = this._findSkillByName(skillName);
    if (!skill) {
      throw new Error(this._formatMissingSkillMessage(skillName));
    }
    try {
      return this._renderSkillInvocation(skill, args);
    } catch (err) {
      this._emitSkillExpansionError(skill.filePath, err);
      throw err;
    }
  }
  _formatSkillInvocation(skillName, args) {
    return this._expandSkillByName(skillName, args);
  }
  _rebuildSystemPrompt(toolNames) {
    const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
    const toolSnippets = {};
    const promptGuidelines = [];
    for (const name of validToolNames) {
      const snippet = this._toolPromptSnippets.get(name);
      if (snippet) {
        toolSnippets[name] = snippet;
      }
      const toolGuidelines = this._toolPromptGuidelines.get(name);
      if (toolGuidelines) {
        promptGuidelines.push(...toolGuidelines);
      }
    }
    const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
    const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
    const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : void 0;
    const loadedSkills = this._resourceLoader.getSkills().skills;
    const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;
    return buildSystemPrompt({
      cwd: this._cwd,
      skills: loadedSkills,
      skillFilter: this._visibleSkillNames ? (skill) => this._visibleSkillNames.has(skill.name.trim().toLowerCase()) : void 0,
      contextFiles: loadedContextFiles,
      customPrompt: loaderSystemPrompt,
      appendSystemPrompt,
      selectedTools: validToolNames,
      toolSnippets,
      promptGuidelines
    });
  }
  // =========================================================================
  // Prompting
  // =========================================================================
  /**
   * Send a prompt to the agent.
   * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
   * - Expands file-based prompt templates by default
   * - During streaming, queues via steer() or followUp() based on streamingBehavior option
   * - Validates model and API key before sending (when not streaming)
   * @throws Error if streaming and no streamingBehavior specified
   * @throws Error if no model selected or no API key available (when not streaming)
   */
  async prompt(text, options) {
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;
    if (expandPromptTemplates && text.startsWith("/")) {
      const handled = await this._tryExecuteExtensionCommand(text);
      if (handled) {
        return;
      }
    }
    let currentText = text;
    let currentImages = options?.images;
    if (this._extensionRunner?.hasHandlers("input")) {
      const inputResult = await this._extensionRunner.emitInput(
        currentText,
        currentImages,
        options?.source ?? "interactive"
      );
      if (inputResult.action === "handled") {
        return;
      }
      if (inputResult.action === "transform") {
        currentText = inputResult.text;
        currentImages = inputResult.images ?? currentImages;
      }
    }
    let expandedText = currentText;
    if (expandPromptTemplates) {
      expandedText = this._expandSkillCommand(expandedText);
      expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
    }
    if (this.isStreaming) {
      if (!options?.streamingBehavior) {
        throw new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
        );
      }
      if (options.streamingBehavior === "followUp") {
        await this._queueFollowUp(expandedText, currentImages);
      } else {
        await this._queueSteer(expandedText, currentImages);
      }
      return;
    }
    this._flushPendingBashMessages();
    if (!this.model) {
      throw new Error(
        `No model selected.

Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}

Then use /model to select a model.`
      );
    }
    const restoration = await this._fallbackResolver.checkForRestoration(this.model);
    if (restoration) {
      const previousProvider = `${this.model.provider}/${this.model.id}`;
      this.agent.setModel(restoration.model);
      this.sessionManager.appendModelChange(restoration.model.provider, restoration.model.id);
      this._emit({
        type: "fallback_provider_restored",
        provider: `${restoration.model.provider}/${restoration.model.id}`,
        reason: `Restored from ${previousProvider}`
      });
    }
    if (!this._modelRegistry.isProviderRequestReady(this.model.provider)) {
      const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
      if (isOAuth) {
        throw new Error(
          `Authentication failed for "${this.model.provider}". Credentials may have expired or network is unavailable. Run '/login ${this.model.provider}' to re-authenticate.`
        );
      }
      throw new Error(
        `No API key found for ${this.model.provider}.

Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}`
      );
    }
    const lastAssistant = this._findLastAssistantMessage();
    if (lastAssistant) {
      await this._compactionOrchestrator.checkCompaction(lastAssistant, false);
    }
    const messages = [];
    const userContent = [{ type: "text", text: expandedText }];
    if (currentImages) {
      userContent.push(...currentImages);
    }
    messages.push({
      role: "user",
      content: userContent,
      timestamp: Date.now()
    });
    for (const msg of this._pendingNextTurnMessages) {
      messages.push(msg);
    }
    this._pendingNextTurnMessages = [];
    if (this._extensionRunner) {
      const result = await this._extensionRunner.emitBeforeAgentStart(
        expandedText,
        currentImages,
        this._baseSystemPrompt
      );
      if (result?.messages) {
        for (const msg of result.messages) {
          messages.push({
            role: "custom",
            customType: msg.customType,
            content: msg.content,
            display: msg.display,
            details: msg.details,
            timestamp: Date.now()
          });
        }
      }
      if (result?.systemPrompt) {
        this.agent.setSystemPrompt(result.systemPrompt);
      } else {
        this.agent.setSystemPrompt(this._baseSystemPrompt);
      }
    }
    await this.agent.prompt(messages);
    await this._retryHandler.waitForRetry();
  }
  /**
   * Try to execute an extension command. Returns true if command was found and executed.
   */
  async _tryExecuteExtensionCommand(text) {
    if (!this._extensionRunner) return false;
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
    const command = this._extensionRunner.getCommand(commandName);
    if (!command) return false;
    const ctx = this._extensionRunner.createCommandContext();
    try {
      await command.handler(args, ctx);
      return true;
    } catch (err) {
      this._extensionRunner.emitError({
        extensionPath: `command:${commandName}`,
        event: "command",
        error: getErrorMessage(err)
      });
      return true;
    }
  }
  /**
   * Expand skill commands (/skill:name args) to their full content.
   * Returns the expanded text, or the original text if not a skill command or skill not found.
   * Emits errors via extension runner if file read fails.
   */
  _expandSkillCommand(text) {
    if (!text.startsWith("/skill:")) return text;
    const spaceIndex = text.indexOf(" ");
    const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
    if (!this._findSkillByName(skillName)) return text;
    try {
      return this._formatSkillInvocation(skillName, args);
    } catch {
      return text;
    }
  }
  _createBuiltInSkillTool() {
    const skillSchema = Type.Object({
      skill: Type.String({ description: "The skill name. E.g., 'commit', 'review-pr', or 'pdf'" }),
      args: Type.Optional(Type.String({ description: "Optional arguments for the skill" }))
    });
    return {
      name: "Skill",
      label: "Skill",
      description: "Execute a skill within the main conversation. Use this tool when users ask for a slash command or reference a skill by name. Returns the expanded skill block and appends args after it.",
      parameters: skillSchema,
      execute: async (_toolCallId, params) => {
        const input = params;
        try {
          return {
            content: [
              {
                type: "text",
                text: this._expandSkillByName(input.skill, input.args)
              }
            ],
            details: void 0
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: getErrorMessage(err) }],
            details: void 0
          };
        }
      }
    };
  }
  _getBuiltinToolNames() {
    return this._getBuiltinTools().map((tool) => tool.name);
  }
  _getBuiltinTools() {
    return [this._createBuiltInSkillTool()];
  }
  _getRegisteredToolDefinitions() {
    const registeredTools = this._extensionRunner?.getAllRegisteredTools() ?? [];
    return registeredTools.map((tool) => tool.definition);
  }
  _getBuiltinToolDefinitions() {
    return this._getBuiltinTools().map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: async () => ({ content: [], details: void 0 })
    }));
  }
  getRenderableToolDefinition(toolName) {
    const normalizedToolName = toolName.toLowerCase();
    return [...this._getBuiltinToolDefinitions(), ...this._getRegisteredToolDefinitions()].find(
      (tool) => tool.name.toLowerCase() === normalizedToolName
    );
  }
  /**
   * Queue a steering message to interrupt the agent mid-run.
   * Delivered after current tool execution, skips remaining tools.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @throws Error if text is an extension command
   */
  async steer(text, images) {
    if (text.startsWith("/")) {
      this._throwIfExtensionCommand(text);
    }
    let expandedText = this._expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
    await this._queueSteer(expandedText, images);
  }
  /**
   * Queue a follow-up message to be processed after the agent finishes.
   * Delivered only when agent has no more tool calls or steering messages.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @throws Error if text is an extension command
   */
  async followUp(text, images) {
    if (text.startsWith("/")) {
      this._throwIfExtensionCommand(text);
    }
    let expandedText = this._expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
    await this._queueFollowUp(expandedText, images);
  }
  /**
   * Internal: Queue a steering message (already expanded, no extension command check).
   */
  async _queueSteer(text, images) {
    this._steeringMessages.push(text);
    const content = [{ type: "text", text }];
    if (images) {
      content.push(...images);
    }
    this.agent.steer(
      {
        role: "user",
        content,
        timestamp: Date.now()
      },
      "user"
    );
  }
  /**
   * Internal: Queue a follow-up message (already expanded, no extension command check).
   */
  async _queueFollowUp(text, images) {
    this._followUpMessages.push(text);
    const content = [{ type: "text", text }];
    if (images) {
      content.push(...images);
    }
    this.agent.followUp(
      {
        role: "user",
        content,
        timestamp: Date.now()
      },
      "user"
    );
  }
  /**
   * Throw an error if the text is an extension command.
   */
  _throwIfExtensionCommand(text) {
    if (!this._extensionRunner) return;
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const command = this._extensionRunner.getCommand(commandName);
    if (command) {
      throw new Error(
        `Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`
      );
    }
  }
  /**
   * Send a custom message to the session. Creates a CustomMessageEntry.
   *
   * Handles three cases:
   * - Streaming: queues message, processed when loop pulls from queue
   * - Not streaming + triggerTurn: appends to state/session, starts new turn
   * - Not streaming + no trigger: appends to state/session, no turn
   *
   * @param message Custom message with customType, content, display, details
   * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
   * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
   */
  async sendCustomMessage(message, options) {
    const appMessage = {
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      timestamp: Date.now()
    };
    if (options?.deliverAs === "nextTurn") {
      this._pendingNextTurnMessages.push(appMessage);
    } else if (this.isStreaming) {
      if (options?.deliverAs === "followUp") {
        this.agent.followUp(appMessage);
      } else {
        this.agent.steer(appMessage);
      }
    } else if (options?.triggerTurn) {
      await this.agent.prompt(appMessage);
    } else {
      this.agent.appendMessage(appMessage);
      this.sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details
      );
      this._emit({ type: "message_start", message: appMessage });
      this._emit({ type: "message_end", message: appMessage });
    }
  }
  /**
   * Send a user message to the agent. Always triggers a turn.
   * When the agent is streaming, use deliverAs to specify how to queue the message.
   *
   * @param content User message content (string or content array)
   * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
   */
  async sendUserMessage(content, options) {
    let text;
    let images;
    if (typeof content === "string") {
      text = content;
    } else {
      const textParts = [];
      images = [];
      for (const part of content) {
        if (part.type === "text") {
          textParts.push(part.text);
        } else {
          images.push(part);
        }
      }
      text = textParts.join("\n");
      if (images.length === 0) images = void 0;
    }
    await this.prompt(text, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      images,
      source: "extension"
    });
  }
  /**
   * Clear all queued messages and return them.
   * Useful for restoring to editor when user aborts.
   * @returns Object with steering and followUp arrays
   */
  clearQueue() {
    const userMessages = this.agent.drainUserMessages();
    const extractText = (m) => {
      if (!("content" in m) || !Array.isArray(m.content)) return "";
      const textPart = m.content.find((c) => c.type === "text");
      return textPart && "text" in textPart ? textPart.text : "";
    };
    const preservedSteering = userMessages.steering.map(extractText).filter((t) => t.length > 0);
    const preservedFollowUp = userMessages.followUp.map(extractText).filter((t) => t.length > 0);
    const steering = [...this._steeringMessages, ...preservedSteering];
    const followUp = [...this._followUpMessages, ...preservedFollowUp];
    this._steeringMessages = [];
    this._followUpMessages = [];
    this.agent.clearAllQueues();
    return { steering, followUp };
  }
  /** Number of pending messages (includes both steering and follow-up) */
  get pendingMessageCount() {
    return this._steeringMessages.length + this._followUpMessages.length;
  }
  /** Get pending steering messages (read-only) */
  getSteeringMessages() {
    return this._steeringMessages;
  }
  /** Get pending follow-up messages (read-only) */
  getFollowUpMessages() {
    return this._followUpMessages;
  }
  get resourceLoader() {
    return this._resourceLoader;
  }
  /**
   * Abort current operation and wait for agent to become idle.
   */
  async abort(options) {
    this._retryHandler.abortRetry();
    this.agent.abort(options?.origin);
    await this.agent.waitForIdle();
    if (!this.isStreaming && this._extensionRunner) {
      const wasProcessingAgentEnd = this._processingAgentEnd;
      this._processingAgentEnd = true;
      try {
        const messages = this.agent.state.messages;
        await this._extensionRunner.emit({
          type: "agent_end",
          messages,
          sessionId: this.sessionId,
          abortOrigin: options?.origin
        });
        const last = messages[messages.length - 1];
        const stopReason = last?.role === "assistant" ? last.stopReason === "aborted" ? "cancelled" : last.stopReason === "error" ? "error" : "completed" : "cancelled";
        await this._extensionRunner.emitStop({
          reason: stopReason,
          lastMessage: last,
          sessionId: this.sessionId,
          abortOrigin: options?.origin
        });
      } finally {
        this._processingAgentEnd = wasProcessingAgentEnd;
      }
    }
  }
  async _settleCurrentTurnForSessionTransition() {
    if (this._processingAgentEnd) {
      await this.agent.waitForIdle();
      if (this._processingQueuedAgentEnd) {
        this._sessionTransitionStartedDuringAgentEnd = true;
        this._lastAssistantMessage = void 0;
      }
      return;
    }
    if (!this.agent.state.isStreaming) {
      this._retryHandler.abortRetry();
      await this.agent.waitForIdle();
      return;
    }
    await this.abort({ origin: "session-transition" });
  }
  /**
   * Start a new session, optionally with initial messages and parent tracking.
   * Clears all messages and starts a new session.
   * Listeners are preserved and will continue receiving events.
   * @param options.parentSession - Optional parent session path for tracking
   * @param options.setup - Optional callback to initialize session (e.g., append messages)
   * @returns true if completed, false if cancelled by extension
   */
  async newSession(options) {
    const previousSessionFile = this.sessionFile;
    if (this._extensionRunner?.hasHandlers("session_before_switch")) {
      const result = await this._extensionRunner.emit({
        type: "session_before_switch",
        reason: "new"
      });
      if (result?.cancel) {
        return false;
      }
    }
    this._sessionSwitchPending = true;
    try {
      await this._settleCurrentTurnForSessionTransition();
      if (options?.abortSignal?.aborted) {
        return false;
      }
      this._disconnectFromAgent();
      this.agent.reset();
    } finally {
      this._sessionSwitchPending = false;
    }
    const previousCwd = this._cwd;
    this._cwd = options?.workspaceRoot ?? process.cwd();
    if (this._workspaceRootRef) {
      this._workspaceRootRef.current = this._cwd;
    }
    this.sessionManager.newSession({ parentSession: options?.parentSession });
    this.agent.sessionId = this.sessionManager.getSessionId();
    this._steeringMessages = [];
    this._followUpMessages = [];
    this._pendingNextTurnMessages = [];
    this._visibleSkillNames = void 0;
    this.sessionManager.appendThinkingLevelChange(this.thinkingLevel);
    if (this._cwd !== previousCwd) {
      this._buildRuntime({
        activeToolNames: this.getActiveToolNames(),
        includeAllExtensionTools: true
      });
    } else {
      this._refreshToolRegistry({
        activeToolNames: this.getActiveToolNames(),
        includeAllExtensionTools: true
      });
    }
    if (options?.setup) {
      await options.setup(this.sessionManager);
      const sessionContext = this.sessionManager.buildSessionContext();
      this.agent.replaceMessages(sessionContext.messages);
    }
    this._reconnectToAgent();
    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        type: "session_switch",
        reason: "new",
        previousSessionFile
      });
    }
    this._emitSessionStateChanged("new_session");
    return true;
  }
  // =========================================================================
  // Model Management
  // =========================================================================
  async _emitModelSelect(nextModel, previousModel, source) {
    if (!this._extensionRunner) return;
    if (modelsAreEqual(previousModel, nextModel)) return;
    await this._extensionRunner.emit({
      type: "model_select",
      model: nextModel,
      previousModel,
      source
    });
  }
  /**
   * Apply a model change: set the model on the agent, persist to session/settings,
   * re-clamp thinking level, and emit the model_select event.
   */
  async _applyModelChange(model, thinkingLevel, source, options) {
    const previousModel = this.model;
    this._retryHandler.abortRetry();
    this.agent.setModel(model);
    this.sessionManager.appendModelChange(model.provider, model.id);
    if (options?.persist !== false) {
      this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
    }
    this.setThinkingLevel(thinkingLevel);
    await this._emitModelSelect(model, previousModel, source);
    this._emitSessionStateChanged("set_model");
  }
  /**
   * Set model directly.
   * Validates provider readiness, saves to session and settings.
   * @throws Error if provider is not ready (missing credentials for apiKey/oauth providers)
   */
  async setModel(model, options) {
    if (!this._modelRegistry.isProviderRequestReady(model.provider)) {
      throw new Error(`No API key for ${model.provider}/${model.id}`);
    }
    const thinkingLevel = this._getThinkingLevelForModelSwitch();
    await this._applyModelChange(model, thinkingLevel, "set", options);
  }
  /**
   * Cycle to next/previous model.
   * Uses scoped models (from --models flag) if available, otherwise all available models.
   * @param direction - "forward" (default) or "backward"
   * @returns The new model info, or undefined if only one model available
   */
  async cycleModel(direction = "forward", options) {
    if (this._scopedModels.length > 0) {
      return this._cycleScopedModel(direction, options);
    }
    return this._cycleAvailableModel(direction, options);
  }
  _getReadyScopedModels() {
    return this._scopedModels.filter(
      (scoped) => this._modelRegistry.isProviderRequestReady(scoped.model.provider)
    );
  }
  async _cycleScopedModel(direction, options) {
    const scopedModels = this._getReadyScopedModels();
    if (scopedModels.length <= 1) return void 0;
    const currentModel = this.model;
    let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));
    if (currentIndex === -1) currentIndex = 0;
    const len = scopedModels.length;
    const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
    const next = scopedModels[nextIndex];
    const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);
    await this._applyModelChange(next.model, thinkingLevel, "cycle", options);
    return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
  }
  async _cycleAvailableModel(direction, options) {
    const availableModels = await this._modelRegistry.getAvailable();
    if (availableModels.length <= 1) return void 0;
    const currentModel = this.model;
    let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));
    if (currentIndex === -1) currentIndex = 0;
    const len = availableModels.length;
    const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
    const nextModel = availableModels[nextIndex];
    const thinkingLevel = this._getThinkingLevelForModelSwitch();
    await this._applyModelChange(nextModel, thinkingLevel, "cycle", options);
    return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
  }
  // =========================================================================
  // Thinking Level Management
  // =========================================================================
  /**
   * Set thinking level.
   * Clamps to model capabilities based on available thinking levels.
   * Saves to session and settings only if the level actually changes.
   */
  setThinkingLevel(level) {
    const availableLevels = this.getAvailableThinkingLevels();
    const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);
    const isChanging = effectiveLevel !== this.agent.state.thinkingLevel;
    this.agent.setThinkingLevel(effectiveLevel);
    if (isChanging) {
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
      if (effectiveLevel !== "off") {
        this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
      }
      this._emitSessionStateChanged("set_thinking_level");
    }
  }
  /**
   * Cycle to next thinking level.
   * @returns New level, or undefined if model doesn't support thinking
   */
  cycleThinkingLevel() {
    if (!this.supportsThinking()) return void 0;
    const levels = this.getAvailableThinkingLevels();
    const currentIndex = levels.indexOf(this.thinkingLevel);
    const nextIndex = (currentIndex + 1) % levels.length;
    const nextLevel = levels[nextIndex];
    this.setThinkingLevel(nextLevel);
    return nextLevel;
  }
  /**
   * Get available thinking levels for current model.
   * The provider will clamp to what the specific model supports internally.
   */
  getAvailableThinkingLevels() {
    if (!this.supportsThinking()) return ["off"];
    return this.supportsXhighThinking() ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
  }
  /**
   * Check if current model supports xhigh thinking level.
   */
  supportsXhighThinking() {
    return this.model ? supportsXhigh(this.model) : false;
  }
  /**
   * Check if current model supports thinking/reasoning.
   */
  supportsThinking() {
    return !!this.model?.reasoning;
  }
  _getThinkingLevelForModelSwitch(explicitLevel) {
    if (explicitLevel !== void 0) {
      return explicitLevel;
    }
    if (!this.supportsThinking()) {
      return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
    }
    return this.thinkingLevel;
  }
  _clampThinkingLevel(level, availableLevels) {
    const ordered = THINKING_LEVELS_WITH_XHIGH;
    const available = new Set(availableLevels);
    const requestedIndex = ordered.indexOf(level);
    if (requestedIndex === -1) {
      return availableLevels[0] ?? "off";
    }
    for (let i = requestedIndex; i < ordered.length; i++) {
      const candidate = ordered[i];
      if (available.has(candidate)) return candidate;
    }
    for (let i = requestedIndex - 1; i >= 0; i--) {
      const candidate = ordered[i];
      if (available.has(candidate)) return candidate;
    }
    return availableLevels[0] ?? "off";
  }
  // =========================================================================
  // Queue Mode Management
  // =========================================================================
  /**
   * Set steering message mode.
   * Saves to settings.
   */
  setSteeringMode(mode) {
    this.agent.setSteeringMode(mode);
    this.settingsManager.setSteeringMode(mode);
    this._emitSessionStateChanged("set_steering_mode");
  }
  /**
   * Set follow-up message mode.
   * Saves to settings.
   */
  setFollowUpMode(mode) {
    this.agent.setFollowUpMode(mode);
    this.settingsManager.setFollowUpMode(mode);
    this._emitSessionStateChanged("set_follow_up_mode");
  }
  // =========================================================================
  // Compaction
  // =========================================================================
  /**
   * Manually compact the session context.
   * Aborts current agent operation first.
   * @param customInstructions Optional instructions for the compaction summary
   */
  async compact(customInstructions) {
    return this._compactionOrchestrator.compact(customInstructions);
  }
  /** Cancel in-progress compaction (manual or auto) */
  abortCompaction() {
    this._compactionOrchestrator.abortCompaction();
  }
  /** Cancel in-progress branch summarization */
  abortBranchSummary() {
    this._compactionOrchestrator.abortBranchSummary();
  }
  /** Toggle auto-compaction setting */
  setAutoCompactionEnabled(enabled) {
    this._compactionOrchestrator.setAutoCompactionEnabled(enabled);
    this._emitSessionStateChanged("set_auto_compaction");
  }
  /** Whether auto-compaction is enabled */
  get autoCompactionEnabled() {
    return this._compactionOrchestrator.autoCompactionEnabled;
  }
  async bindExtensions(bindings) {
    if (bindings.uiContext !== void 0) {
      this._extensionUIContext = bindings.uiContext;
    }
    if (bindings.commandContextActions !== void 0) {
      this._extensionCommandContextActions = bindings.commandContextActions;
    }
    if (bindings.shutdownHandler !== void 0) {
      this._extensionShutdownHandler = bindings.shutdownHandler;
    }
    if (bindings.onError !== void 0) {
      this._extensionErrorListener = bindings.onError;
    }
    if (this._extensionRunner) {
      this._applyExtensionBindings(this._extensionRunner);
      await this._extensionRunner.emit({ type: "session_start" });
      await this.extendResourcesFromExtensions("startup");
    }
  }
  async extendResourcesFromExtensions(reason) {
    if (!this._extensionRunner?.hasHandlers("resources_discover")) {
      return;
    }
    const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
      this._cwd,
      reason
    );
    if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
      return;
    }
    const extensionPaths = {
      skillPaths: this.buildExtensionResourcePaths(skillPaths),
      promptPaths: this.buildExtensionResourcePaths(promptPaths),
      themePaths: this.buildExtensionResourcePaths(themePaths)
    };
    this._resourceLoader.extendResources(extensionPaths);
    this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
    this.agent.setSystemPrompt(this._baseSystemPrompt);
  }
  buildExtensionResourcePaths(entries) {
    return entries.map((entry) => {
      const source = this.getExtensionSourceLabel(entry.extensionPath);
      const baseDir = entry.extensionPath.startsWith("<") ? void 0 : dirname(entry.extensionPath);
      return {
        path: entry.path,
        metadata: {
          source,
          scope: "temporary",
          origin: "top-level",
          baseDir
        }
      };
    });
  }
  getExtensionSourceLabel(extensionPath) {
    if (extensionPath.startsWith("<")) {
      return `extension:${extensionPath.replace(/[<>]/g, "")}`;
    }
    const base = basename(extensionPath);
    const name = base.replace(/\.(ts|js)$/, "");
    return `extension:${name}`;
  }
  _applyExtensionBindings(runner) {
    runner.setUIContext(this._extensionUIContext);
    runner.bindCommandContext(this._extensionCommandContextActions);
    try {
      this._extensionErrorUnsubscriber?.();
    } catch {
    }
    this._extensionErrorUnsubscriber = this._extensionErrorListener ? runner.onError(this._extensionErrorListener) : void 0;
  }
  _bindExtensionCore(runner) {
    const normalizeLocation = (source) => {
      if (source === "user" || source === "project" || source === "path") {
        return source;
      }
      return void 0;
    };
    const reservedBuiltins = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
    const getCommands = () => {
      const extensionCommands = runner.getRegisteredCommandsWithPaths().filter(({ command }) => !reservedBuiltins.has(command.name)).map(({ command, extensionPath }) => ({
        name: command.name,
        description: command.description,
        source: "extension",
        path: extensionPath
      }));
      const templates = this.promptTemplates.map((template) => ({
        name: template.name,
        description: template.description,
        source: "prompt",
        location: normalizeLocation(template.source),
        path: template.filePath
      }));
      const skills = this._resourceLoader.getSkills().skills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
        location: normalizeLocation(skill.source),
        path: skill.filePath
      }));
      return [...extensionCommands, ...templates, ...skills];
    };
    runner.bindCore(
      {
        sendMessage: (message, options) => {
          this.sendCustomMessage(message, options).catch((err) => {
            runner.emitError({
              extensionPath: "<runtime>",
              event: "send_message",
              error: getErrorMessage(err)
            });
          });
        },
        sendUserMessage: (content, options) => {
          this.sendUserMessage(content, options).catch((err) => {
            runner.emitError({
              extensionPath: "<runtime>",
              event: "send_user_message",
              error: getErrorMessage(err)
            });
          });
        },
        retryLastTurn: () => {
          const messages = this.agent.state.messages;
          const last = messages[messages.length - 1];
          if (last?.role === "assistant" && last.stopReason === "error") {
            if (isImageDimensionError(last.errorMessage)) {
              downsizeConversationImages(messages);
            }
            this.agent.replaceMessages(messages.slice(0, -1));
            this.agent.continue().catch((err) => {
              runner.emitError({
                extensionPath: "<runtime>",
                event: "retry_last_turn",
                error: getErrorMessage(err)
              });
            });
          }
        },
        appendEntry: (customType, data) => {
          this.sessionManager.appendCustomEntry(customType, data);
        },
        setSessionName: (name) => {
          this.sessionManager.appendSessionInfo(name);
        },
        getSessionName: () => {
          return this.sessionManager.getSessionName();
        },
        setLabel: (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
        },
        getActiveTools: () => this.getActiveToolNames(),
        getAllTools: () => this.getAllTools(),
        setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
        getVisibleSkills: () => this.getVisibleSkillNames(),
        setVisibleSkills: (skillNames) => this.setVisibleSkillsByName(skillNames),
        refreshTools: () => this._refreshToolRegistry(),
        getCommands,
        setModel: async (model, options) => {
          if (!this.modelRegistry.isProviderRequestReady(model.provider)) return false;
          await this.setModel(model, options);
          return true;
        },
        getThinkingLevel: () => this.thinkingLevel,
        setThinkingLevel: (level) => this.setThinkingLevel(level)
      },
      {
        getModel: () => this.model,
        isIdle: () => !this.isStreaming,
        abort: () => this.abort({ origin: "user" }),
        hasPendingMessages: () => this.pendingMessageCount > 0,
        shutdown: () => {
          this._extensionShutdownHandler?.();
        },
        getContextUsage: () => this.getContextUsage(),
        compact: (options) => {
          void (async () => {
            try {
              const result = await this.compact(options?.customInstructions);
              options?.onComplete?.(result);
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              options?.onError?.(err);
            }
          })();
        },
        getSystemPrompt: () => this.systemPrompt,
        setCompactionThresholdOverride: (percent) => {
          this.settingsManager.setCompactionThresholdOverride(percent);
        }
      }
    );
  }
  _refreshToolRegistry(options) {
    const previousRegistryNames = new Set(this._toolRegistry.keys());
    const previousActiveToolNames = this.getActiveToolNames();
    const registeredTools = this._extensionRunner?.getAllRegisteredTools() ?? [];
    const allCustomTools = [
      ...registeredTools,
      ...this._customTools.map((def) => ({ definition: def, extensionPath: "<sdk>" }))
    ];
    this._toolPromptSnippets = new Map(
      allCustomTools.map((registeredTool) => {
        const snippet = this._normalizePromptSnippet(
          registeredTool.definition.promptSnippet ?? registeredTool.definition.description
        );
        return snippet ? [registeredTool.definition.name, snippet] : void 0;
      }).filter((entry) => entry !== void 0)
    );
    this._toolPromptGuidelines = new Map(
      allCustomTools.map((registeredTool) => {
        const guidelines = this._normalizePromptGuidelines(registeredTool.definition.promptGuidelines);
        return guidelines.length > 0 ? [registeredTool.definition.name, guidelines] : void 0;
      }).filter((entry) => entry !== void 0)
    );
    const wrappedExtensionTools = this._extensionRunner ? wrapRegisteredTools(allCustomTools, this._extensionRunner) : [];
    const builtinTools = this._getBuiltinTools();
    const toolRegistry = new Map(this._baseToolRegistry);
    for (const tool of builtinTools) {
      toolRegistry.set(tool.name, tool);
    }
    for (const tool of wrappedExtensionTools) {
      toolRegistry.set(tool.name, tool);
    }
    this._toolRegistry = toolRegistry;
    const nextActiveToolNames = options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames];
    if (options?.includeAllExtensionTools) {
      for (const tool of wrappedExtensionTools) {
        nextActiveToolNames.push(tool.name);
      }
    } else if (!options?.activeToolNames) {
      for (const toolName of this._toolRegistry.keys()) {
        if (!previousRegistryNames.has(toolName)) {
          nextActiveToolNames.push(toolName);
        }
      }
    }
    this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
  }
  _buildRuntime(options) {
    const autoResizeImages = this.settingsManager.getImageAutoResize();
    const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
    const baseTools = this._baseToolsOverride ? this._baseToolsOverride : createAllTools(this._cwd, {
      read: { autoResizeImages },
      bash: {
        commandPrefix: shellCommandPrefix,
        interceptor: {
          enabled: this.settingsManager.getBashInterceptorEnabled(),
          rules: this.settingsManager.getBashInterceptorRules()
        },
        availableToolNames: () => this.getActiveToolNames()
      }
    });
    this._baseToolRegistry = new Map(Object.entries(baseTools).map(([name, tool]) => [name, tool]));
    const extensionsResult = this._resourceLoader.getExtensions();
    if (options.flagValues) {
      for (const [name, value] of options.flagValues) {
        extensionsResult.runtime.flagValues.set(name, value);
      }
    }
    const hasExtensions = extensionsResult.extensions.length > 0;
    const hasCustomTools = this._customTools.length > 0;
    this._extensionRunner = hasExtensions || hasCustomTools ? new ExtensionRunner(
      extensionsResult.extensions,
      extensionsResult.runtime,
      this._cwd,
      this.sessionManager,
      this._modelRegistry
    ) : void 0;
    if (this._extensionRunnerRef) {
      this._extensionRunnerRef.current = this._extensionRunner;
    }
    if (this._extensionRunner) {
      this._bindExtensionCore(this._extensionRunner);
      this._applyExtensionBindings(this._extensionRunner);
    }
    const defaultActiveToolNames = this._baseToolsOverride ? Object.keys(this._baseToolsOverride) : ["read", "bash", "edit", "write", "lsp"];
    const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
    this._refreshToolRegistry({
      activeToolNames: baseActiveToolNames,
      includeAllExtensionTools: options.includeAllExtensionTools
    });
  }
  async reload() {
    const previousFlagValues = this._extensionRunner?.getFlagValues();
    await this._extensionRunner?.emit({ type: "session_shutdown" });
    this.settingsManager.reload();
    resetApiProviders();
    await this._resourceLoader.reload();
    this._visibleSkillNames = void 0;
    this._buildRuntime({
      activeToolNames: this.getActiveToolNames(),
      flagValues: previousFlagValues,
      includeAllExtensionTools: true
    });
    const hasBindings = this._extensionUIContext || this._extensionCommandContextActions || this._extensionShutdownHandler || this._extensionErrorListener;
    if (this._extensionRunner && hasBindings) {
      await this._extensionRunner.emit({ type: "session_start" });
      await this.extendResourcesFromExtensions("reload");
    }
  }
  // =========================================================================
  // Auto-Retry (delegated to RetryHandler)
  // =========================================================================
  /** Cancel in-progress retry */
  abortRetry() {
    const hadRetry = this._retryHandler.isRetrying;
    this._retryHandler.abortRetry();
    if (hadRetry) {
      this._emitSessionStateChanged("abort_retry");
    }
  }
  /** Whether auto-retry is currently in progress */
  get isRetrying() {
    return this._retryHandler.isRetrying;
  }
  /** Whether auto-retry is enabled */
  get autoRetryEnabled() {
    return this._retryHandler.autoRetryEnabled;
  }
  /** Toggle auto-retry setting */
  setAutoRetryEnabled(enabled) {
    this._retryHandler.setAutoRetryEnabled(enabled);
    this._emitSessionStateChanged("set_auto_retry");
  }
  // =========================================================================
  // Bash Execution
  // =========================================================================
  /**
   * Execute a bash command.
   * Adds result to agent context and session.
   * @param command The bash command to execute
   * @param onChunk Optional streaming callback for output
   * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
   * @param options.operations Custom BashOperations for remote execution
   */
  async executeBash(command, onChunk, options) {
    this._bashAbortController = new AbortController();
    const prefix = this.settingsManager.getShellCommandPrefix();
    const resolvedCommand = prefix ? `${prefix}
${command}` : command;
    try {
      const result = options?.operations ? await executeBashWithOperations(resolvedCommand, process.cwd(), options.operations, {
        onChunk,
        signal: this._bashAbortController.signal
      }) : await executeBashCommand(resolvedCommand, {
        onChunk,
        signal: this._bashAbortController.signal,
        loginShell: options?.loginShell
      });
      this.recordBashResult(command, result, options);
      return result;
    } finally {
      this._bashAbortController = void 0;
    }
  }
  /**
   * Record a bash execution result in session history.
   * Used by executeBash and by extensions that handle bash execution themselves.
   */
  recordBashResult(command, result, options) {
    const bashMessage = {
      role: "bashExecution",
      command,
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      fullOutputPath: result.fullOutputPath,
      timestamp: Date.now(),
      excludeFromContext: options?.excludeFromContext
    };
    if (this.isStreaming) {
      this._pendingBashMessages.push(bashMessage);
    } else {
      this.agent.appendMessage(bashMessage);
      this.sessionManager.appendMessage(bashMessage);
    }
  }
  /**
   * Cancel running bash command.
   */
  abortBash() {
    this._bashAbortController?.abort();
  }
  /** Whether a bash command is currently running */
  get isBashRunning() {
    return this._bashAbortController !== void 0;
  }
  /** Whether there are pending bash messages waiting to be flushed */
  get hasPendingBashMessages() {
    return this._pendingBashMessages.length > 0;
  }
  /**
   * Flush pending bash messages to agent state and session.
   * Called after agent turn completes to maintain proper message ordering.
   */
  _flushPendingBashMessages() {
    if (this._pendingBashMessages.length === 0) return;
    for (const bashMessage of this._pendingBashMessages) {
      this.agent.appendMessage(bashMessage);
      this.sessionManager.appendMessage(bashMessage);
    }
    this._pendingBashMessages = [];
  }
  // =========================================================================
  // Session Management
  // =========================================================================
  /**
   * Switch to a different session file.
   * Aborts current operation, loads messages, restores model/thinking.
   * Listeners are preserved and will continue receiving events.
   * @returns true if switch completed, false if cancelled by extension
   */
  async switchSession(sessionPath) {
    const previousSessionFile = this.sessionManager.getSessionFile();
    if (this._extensionRunner?.hasHandlers("session_before_switch")) {
      const result = await this._extensionRunner.emit({
        type: "session_before_switch",
        reason: "resume",
        targetSessionFile: sessionPath
      });
      if (result?.cancel) {
        return false;
      }
    }
    this._sessionSwitchPending = true;
    try {
      await this._settleCurrentTurnForSessionTransition();
      this._disconnectFromAgent();
    } finally {
      this._sessionSwitchPending = false;
    }
    this._steeringMessages = [];
    this._followUpMessages = [];
    this._pendingNextTurnMessages = [];
    this._visibleSkillNames = void 0;
    this.sessionManager.setSessionFile(sessionPath);
    this.agent.sessionId = this.sessionManager.getSessionId();
    const sessionContext = this.sessionManager.buildSessionContext();
    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        type: "session_switch",
        reason: "resume",
        previousSessionFile
      });
    }
    this.agent.replaceMessages(sessionContext.messages);
    if (sessionContext.model) {
      const previousModel = this.model;
      const availableModels = await this._modelRegistry.getAvailable();
      const match = availableModels.find(
        (m) => m.provider === sessionContext.model.provider && m.id === sessionContext.model.modelId
      );
      if (match) {
        this.agent.setModel(match);
        await this._emitModelSelect(match, previousModel, "restore");
      }
    }
    const hasThinkingEntry = this.sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");
    const defaultThinkingLevel = this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
    if (hasThinkingEntry) {
      this.setThinkingLevel(sessionContext.thinkingLevel);
    } else {
      const availableLevels = this.getAvailableThinkingLevels();
      const effectiveLevel = availableLevels.includes(defaultThinkingLevel) ? defaultThinkingLevel : this._clampThinkingLevel(defaultThinkingLevel, availableLevels);
      this.agent.setThinkingLevel(effectiveLevel);
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
    }
    this._reconnectToAgent();
    this._emitSessionStateChanged("switch_session");
    return true;
  }
  /**
   * Set a display name for the current session.
   */
  setSessionName(name) {
    this.sessionManager.appendSessionInfo(name);
    this._emitSessionStateChanged("set_session_name");
  }
  /**
   * Create a fork from a specific entry.
   * Emits before_fork/fork session events to extensions.
   *
   * @param entryId ID of the entry to fork from
   * @returns Object with:
   *   - selectedText: The text of the selected user message (for editor pre-fill)
   *   - cancelled: True if an extension cancelled the fork
   */
  async fork(entryId) {
    const previousSessionFile = this.sessionFile;
    const selectedEntry = this.sessionManager.getEntry(entryId);
    if (!selectedEntry || selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
      throw new Error("Invalid entry ID for forking");
    }
    const selectedText = this._extractUserMessageText(selectedEntry.message.content);
    let skipConversationRestore = false;
    if (this._extensionRunner?.hasHandlers("session_before_fork")) {
      const result = await this._extensionRunner.emit({
        type: "session_before_fork",
        entryId
      });
      if (result?.cancel) {
        return { selectedText, cancelled: true };
      }
      skipConversationRestore = result?.skipConversationRestore ?? false;
    }
    this._pendingNextTurnMessages = [];
    if (!selectedEntry.parentId) {
      this.sessionManager.newSession({ parentSession: previousSessionFile });
    } else {
      this.sessionManager.createBranchedSession(selectedEntry.parentId);
    }
    this.agent.sessionId = this.sessionManager.getSessionId();
    const sessionContext = this.sessionManager.buildSessionContext();
    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        type: "session_fork",
        previousSessionFile
      });
    }
    if (!skipConversationRestore) {
      this.agent.replaceMessages(sessionContext.messages);
    }
    this._emitSessionStateChanged("fork");
    return { selectedText, cancelled: false };
  }
  // =========================================================================
  // Tree Navigation
  // =========================================================================
  /**
   * Navigate to a different node in the session tree.
   * Unlike fork() which creates a new session file, this stays in the same file.
   *
   * @param targetId The entry ID to navigate to
   * @param options.summarize Whether user wants to summarize abandoned branch
   * @param options.customInstructions Custom instructions for summarizer
   * @param options.replaceInstructions If true, customInstructions replaces the default prompt
   * @param options.label Label to attach to the branch summary entry
   * @returns Result with editorText (if user message) and cancelled status
   */
  async navigateTree(targetId, options = {}) {
    const oldLeafId = this.sessionManager.getLeafId();
    if (targetId === oldLeafId) {
      return { cancelled: false };
    }
    if (options.summarize && !this.model) {
      throw new Error("No model available for summarization");
    }
    const targetEntry = this.sessionManager.getEntry(targetId);
    if (!targetEntry) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
      this.sessionManager,
      oldLeafId,
      targetId
    );
    let customInstructions = options.customInstructions;
    let replaceInstructions = options.replaceInstructions;
    let label = options.label;
    const preparation = {
      targetId,
      oldLeafId,
      commonAncestorId,
      entriesToSummarize,
      userWantsSummary: options.summarize ?? false,
      customInstructions,
      replaceInstructions,
      label
    };
    this._compactionOrchestrator.branchSummaryAbortController = new AbortController();
    let extensionSummary;
    let fromExtension = false;
    if (this._extensionRunner?.hasHandlers("session_before_tree")) {
      const result = await this._extensionRunner.emit({
        type: "session_before_tree",
        preparation,
        signal: this._compactionOrchestrator.branchSummaryAbortController.signal
      });
      if (result?.cancel) {
        return { cancelled: true };
      }
      if (result?.summary && options.summarize) {
        extensionSummary = result.summary;
        fromExtension = true;
      }
      if (result?.customInstructions !== void 0) {
        customInstructions = result.customInstructions;
      }
      if (result?.replaceInstructions !== void 0) {
        replaceInstructions = result.replaceInstructions;
      }
      if (result?.label !== void 0) {
        label = result.label;
      }
    }
    let summaryText;
    let summaryDetails;
    if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
      const model = this.model;
      if (!this._modelRegistry.isProviderRequestReady(model.provider)) {
        throw new Error(`No API key for ${model.provider}`);
      }
      const apiKey = await this._modelRegistry.getApiKey(model, this.sessionId);
      const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
      const result = await generateBranchSummary(entriesToSummarize, {
        model,
        apiKey,
        signal: this._compactionOrchestrator.branchSummaryAbortController.signal,
        customInstructions,
        replaceInstructions,
        reserveTokens: branchSummarySettings.reserveTokens
      });
      this._compactionOrchestrator.branchSummaryAbortController = void 0;
      if (result.aborted) {
        return { cancelled: true, aborted: true };
      }
      if (result.error) {
        throw new Error(result.error);
      }
      summaryText = result.summary;
      summaryDetails = {
        readFiles: result.readFiles || [],
        modifiedFiles: result.modifiedFiles || []
      };
    } else if (extensionSummary) {
      summaryText = extensionSummary.summary;
      summaryDetails = extensionSummary.details;
    }
    let newLeafId;
    let editorText;
    if (targetEntry.type === "message" && targetEntry.message.role === "user") {
      newLeafId = targetEntry.parentId;
      editorText = this._extractUserMessageText(targetEntry.message.content);
    } else if (targetEntry.type === "custom_message") {
      newLeafId = targetEntry.parentId;
      editorText = typeof targetEntry.content === "string" ? targetEntry.content : targetEntry.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    } else {
      newLeafId = targetId;
    }
    let summaryEntry;
    if (summaryText) {
      const summaryId = this.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
      summaryEntry = this.sessionManager.getEntry(summaryId);
      if (label) {
        this.sessionManager.appendLabelChange(summaryId, label);
      }
    } else if (newLeafId === null) {
      this.sessionManager.resetLeaf();
    } else {
      this.sessionManager.branch(newLeafId);
    }
    if (label && !summaryText) {
      this.sessionManager.appendLabelChange(targetId, label);
    }
    const sessionContext = this.sessionManager.buildSessionContext();
    this.agent.replaceMessages(sessionContext.messages);
    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        type: "session_tree",
        newLeafId: this.sessionManager.getLeafId(),
        oldLeafId,
        summaryEntry,
        fromExtension: summaryText ? fromExtension : void 0
      });
    }
    this._compactionOrchestrator.branchSummaryAbortController = void 0;
    return { editorText, cancelled: false, summaryEntry };
  }
  /**
   * Get all user messages from session for fork selector.
   */
  getUserMessagesForForking() {
    const entries = this.sessionManager.getEntries();
    const result = [];
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      if (entry.message.role !== "user") continue;
      const text = this._extractUserMessageText(entry.message.content);
      if (text) {
        result.push({ entryId: entry.id, text });
      }
    }
    return result;
  }
  _extractUserMessageText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.filter((c) => c.type === "text").map((c) => c.text).join("");
    }
    return "";
  }
  /**
   * Get session statistics.
   */
  getSessionStats() {
    const state = this.state;
    const userMessages = state.messages.filter((m) => m.role === "user").length;
    const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
    const toolResults = state.messages.filter((m) => m.role === "toolResult").length;
    let toolCalls = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;
    for (const message of state.messages) {
      if (message.role === "assistant") {
        const assistantMsg = message;
        toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
        totalInput += assistantMsg.usage.input;
        totalOutput += assistantMsg.usage.output;
        totalCacheRead += assistantMsg.usage.cacheRead;
        totalCacheWrite += assistantMsg.usage.cacheWrite;
        totalCost += assistantMsg.usage.cost.total;
      }
    }
    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls: Math.max(toolCalls, this._cumulativeToolCalls),
      toolResults,
      totalMessages: state.messages.length,
      tokens: {
        input: Math.max(totalInput, this._cumulativeInputTokens),
        output: Math.max(totalOutput, this._cumulativeOutputTokens),
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        total: Math.max(totalInput + totalOutput, this._cumulativeInputTokens + this._cumulativeOutputTokens) + totalCacheRead + totalCacheWrite
      },
      cost: Math.max(totalCost, this._cumulativeCost)
    };
  }
  /**
   * Get the cost of the most recent assistant response.
   * Returns 0 if no assistant message has been received yet.
   */
  getLastTurnCost() {
    return this._lastTurnCost;
  }
  getContextUsage() {
    const model = this.model;
    if (!model) return void 0;
    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) return void 0;
    const branchEntries = this.sessionManager.getBranch();
    const latestCompaction = getLatestCompactionEntry(branchEntries);
    if (latestCompaction) {
      const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
      let hasPostCompactionUsage = false;
      for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
        const entry = branchEntries[i];
        if (entry.type === "message" && entry.message.role === "assistant") {
          const assistant = entry.message;
          if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
            const contextTokens = calculateContextTokens(assistant.usage);
            if (contextTokens > 0) {
              hasPostCompactionUsage = true;
            }
            break;
          }
        }
      }
      if (!hasPostCompactionUsage) {
        return { tokens: null, contextWindow, percent: null };
      }
    }
    const estimate = estimateContextTokens(this.messages);
    const percent = estimate.tokens / contextWindow * 100;
    return {
      tokens: estimate.tokens,
      contextWindow,
      percent
    };
  }
  /**
   * Export session to HTML.
   * @param outputPath Optional output path (defaults to session directory)
   * @returns Path to exported file
   */
  async exportToHtml(outputPath) {
    const themeName = this.settingsManager.getTheme();
    const toolRenderer = createToolHtmlRenderer({
      getToolDefinition: (name) => this.getRenderableToolDefinition(name),
      theme
    });
    return await exportSessionToHtml(this.sessionManager, this.state, {
      outputPath,
      themeName,
      toolRenderer
    });
  }
  // =========================================================================
  // Utilities
  // =========================================================================
  /**
   * Get text content of last assistant message.
   * Useful for /copy command.
   * @returns Text content, or undefined if no assistant message exists
   */
  getLastAssistantText() {
    const lastAssistant = this.messages.slice().reverse().find((m) => {
      if (m.role !== "assistant") return false;
      const msg = m;
      if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
      return true;
    });
    if (!lastAssistant) return void 0;
    let text = "";
    for (const content of lastAssistant.content) {
      if (content.type === "text") {
        text += content.text;
      }
    }
    return text.trim() || void 0;
  }
  // =========================================================================
  // Extension System
  // =========================================================================
  /**
   * Check if extensions have handlers for a specific event type.
   */
  hasExtensionHandlers(eventType) {
    return this._extensionRunner?.hasHandlers(eventType) ?? false;
  }
  /**
   * Get the extension runner (for setting UI context and error handlers).
   */
  get extensionRunner() {
    return this._extensionRunner;
  }
}
export {
  AgentSession,
  parseSkillBlock
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9jb3JlL2FnZW50LXNlc3Npb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRDIgLSBBZ2VudCBzZXNzaW9uIGxpZmVjeWNsZSBhbmQgd29ya3NwYWNlIHJ1bnRpbWUgY29vcmRpbmF0aW9uXG4vKipcbiAqIEFnZW50U2Vzc2lvbiAtIENvcmUgYWJzdHJhY3Rpb24gZm9yIGFnZW50IGxpZmVjeWNsZSBhbmQgc2Vzc2lvbiBtYW5hZ2VtZW50LlxuICpcbiAqIFRoaXMgY2xhc3MgaXMgc2hhcmVkIGJldHdlZW4gYWxsIHJ1biBtb2RlcyAoaW50ZXJhY3RpdmUsIHByaW50LCBycGMpLlxuICogSXQgZW5jYXBzdWxhdGVzOlxuICogLSBBZ2VudCBzdGF0ZSBhY2Nlc3NcbiAqIC0gRXZlbnQgc3Vic2NyaXB0aW9uIHdpdGggYXV0b21hdGljIHNlc3Npb24gcGVyc2lzdGVuY2VcbiAqIC0gTW9kZWwgYW5kIHRoaW5raW5nIGxldmVsIG1hbmFnZW1lbnRcbiAqIC0gQ29tcGFjdGlvbiAobWFudWFsIGFuZCBhdXRvKVxuICogLSBCYXNoIGV4ZWN1dGlvblxuICogLSBTZXNzaW9uIHN3aXRjaGluZyBhbmQgYnJhbmNoaW5nXG4gKlxuICogTW9kZXMgdXNlIHRoaXMgY2xhc3MgYW5kIGFkZCB0aGVpciBvd24gSS9PIGxheWVyIG9uIHRvcC5cbiAqL1xuXG5pbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7XG5cdEFnZW50LFxuXHRBZ2VudEFib3J0T3JpZ2luLFxuXHRBZ2VudEV2ZW50LFxuXHRBZ2VudE1lc3NhZ2UsXG5cdEFnZW50U3RhdGUsXG5cdEFnZW50VG9vbCxcblx0VGhpbmtpbmdMZXZlbCxcbn0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHR5cGUgeyBBc3Npc3RhbnRNZXNzYWdlLCBJbWFnZUNvbnRlbnQsIE1lc3NhZ2UsIE1vZGVsLCBUZXh0Q29udGVudCB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyBtb2RlbHNBcmVFcXVhbCwgcmVzZXRBcGlQcm92aWRlcnMsIHN1cHBvcnRzWGhpZ2ggfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHsgVHlwZSB9IGZyb20gXCJAc2luY2xhaXIvdHlwZWJveFwiO1xuaW1wb3J0IHsgZ2V0RG9jc1BhdGggfSBmcm9tIFwiLi4vY29uZmlnLmpzXCI7XG5pbXBvcnQgeyBnZXRFcnJvck1lc3NhZ2UgfSBmcm9tIFwiLi4vdXRpbHMvZXJyb3IuanNcIjtcbmltcG9ydCB7IHRoZW1lIH0gZnJvbSBcIi4uL21vZGVzL2ludGVyYWN0aXZlL3RoZW1lL3RoZW1lLmpzXCI7XG5pbXBvcnQgeyBzdHJpcEZyb250bWF0dGVyIH0gZnJvbSBcIi4uL3V0aWxzL2Zyb250bWF0dGVyLmpzXCI7XG5pbXBvcnQgeyB0eXBlIEJhc2hSZXN1bHQsIGV4ZWN1dGVCYXNoIGFzIGV4ZWN1dGVCYXNoQ29tbWFuZCwgZXhlY3V0ZUJhc2hXaXRoT3BlcmF0aW9ucyB9IGZyb20gXCIuL2Jhc2gtZXhlY3V0b3IuanNcIjtcbmltcG9ydCB7XG5cdHR5cGUgQ29tcGFjdGlvblJlc3VsdCxcblx0Y2FsY3VsYXRlQ29udGV4dFRva2Vucyxcblx0Y29sbGVjdEVudHJpZXNGb3JCcmFuY2hTdW1tYXJ5LFxuXHRlc3RpbWF0ZUNvbnRleHRUb2tlbnMsXG5cdGdlbmVyYXRlQnJhbmNoU3VtbWFyeSxcbn0gZnJvbSBcIi4vY29tcGFjdGlvbi9pbmRleC5qc1wiO1xuaW1wb3J0IHsgQ29tcGFjdGlvbk9yY2hlc3RyYXRvciB9IGZyb20gXCIuL2NvbXBhY3Rpb24tb3JjaGVzdHJhdG9yLmpzXCI7XG5pbXBvcnQgeyBERUZBVUxUX1RISU5LSU5HX0xFVkVMIH0gZnJvbSBcIi4vZGVmYXVsdHMuanNcIjtcbmltcG9ydCB7IGV4cG9ydFNlc3Npb25Ub0h0bWwsIHR5cGUgVG9vbEh0bWxSZW5kZXJlciB9IGZyb20gXCIuL2V4cG9ydC1odG1sL2luZGV4LmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVUb29sSHRtbFJlbmRlcmVyIH0gZnJvbSBcIi4vZXhwb3J0LWh0bWwvdG9vbC1yZW5kZXJlci5qc1wiO1xuaW1wb3J0IHtcblx0dHlwZSBDb250ZXh0VXNhZ2UsXG5cdHR5cGUgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHRBY3Rpb25zLFxuXHR0eXBlIEV4dGVuc2lvbkVycm9yTGlzdGVuZXIsXG5cdEV4dGVuc2lvblJ1bm5lcixcblx0dHlwZSBFeHRlbnNpb25VSUNvbnRleHQsXG5cdHR5cGUgSW5wdXRTb3VyY2UsXG5cdHR5cGUgTWVzc2FnZUVuZEV2ZW50LFxuXHR0eXBlIE1lc3NhZ2VTdGFydEV2ZW50LFxuXHR0eXBlIE1lc3NhZ2VVcGRhdGVFdmVudCxcblx0dHlwZSBTZXNzaW9uQmVmb3JlRm9ya1Jlc3VsdCxcblx0dHlwZSBTZXNzaW9uQmVmb3JlU3dpdGNoUmVzdWx0LFxuXHR0eXBlIFNlc3Npb25CZWZvcmVUcmVlUmVzdWx0LFxuXHR0eXBlIFNodXRkb3duSGFuZGxlcixcblx0dHlwZSBUb29sRGVmaW5pdGlvbixcblx0dHlwZSBUb29sRXhlY3V0aW9uRW5kRXZlbnQsXG5cdHR5cGUgVG9vbEV4ZWN1dGlvblN0YXJ0RXZlbnQsXG5cdHR5cGUgVG9vbEV4ZWN1dGlvblVwZGF0ZUV2ZW50LFxuXHR0eXBlIFRvb2xJbmZvLFxuXHR0eXBlIFRyZWVQcmVwYXJhdGlvbixcblx0dHlwZSBUdXJuRW5kRXZlbnQsXG5cdHR5cGUgVHVyblN0YXJ0RXZlbnQsXG5cdHdyYXBSZWdpc3RlcmVkVG9vbHMsXG59IGZyb20gXCIuL2V4dGVuc2lvbnMvaW5kZXguanNcIjtcbmltcG9ydCB0eXBlIHsgQmFzaEV4ZWN1dGlvbk1lc3NhZ2UsIEN1c3RvbU1lc3NhZ2UgfSBmcm9tIFwiLi9tZXNzYWdlcy5qc1wiO1xuaW1wb3J0IHsgRmFsbGJhY2tSZXNvbHZlciB9IGZyb20gXCIuL2ZhbGxiYWNrLXJlc29sdmVyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9tb2RlbC1yZWdpc3RyeS5qc1wiO1xuaW1wb3J0IHsgZXhwYW5kUHJvbXB0VGVtcGxhdGUsIHR5cGUgUHJvbXB0VGVtcGxhdGUgfSBmcm9tIFwiLi9wcm9tcHQtdGVtcGxhdGVzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFJlc291cmNlRXh0ZW5zaW9uUGF0aHMsIFJlc291cmNlTG9hZGVyIH0gZnJvbSBcIi4vcmVzb3VyY2UtbG9hZGVyLmpzXCI7XG5pbXBvcnQgeyBSZXRyeUhhbmRsZXIgfSBmcm9tIFwiLi9yZXRyeS1oYW5kbGVyLmpzXCI7XG5pbXBvcnQgeyBpc0ltYWdlRGltZW5zaW9uRXJyb3IsIGRvd25zaXplQ29udmVyc2F0aW9uSW1hZ2VzIH0gZnJvbSBcIi4vaW1hZ2Utb3ZlcmZsb3ctcmVjb3ZlcnkuanNcIjtcbmltcG9ydCB0eXBlIHsgQnJhbmNoU3VtbWFyeUVudHJ5LCBTZXNzaW9uTWFuYWdlciB9IGZyb20gXCIuL3Nlc3Npb24tbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgZ2V0TGF0ZXN0Q29tcGFjdGlvbkVudHJ5IH0gZnJvbSBcIi4vc2Vzc2lvbi1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFNldHRpbmdzTWFuYWdlciB9IGZyb20gXCIuL3NldHRpbmdzLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IEJVSUxUSU5fU0xBU0hfQ09NTUFORFMsIHR5cGUgU2xhc2hDb21tYW5kSW5mbywgdHlwZSBTbGFzaENvbW1hbmRMb2NhdGlvbiB9IGZyb20gXCIuL3NsYXNoLWNvbW1hbmRzLmpzXCI7XG5pbXBvcnQgeyBidWlsZFN5c3RlbVByb21wdCB9IGZyb20gXCIuL3N5c3RlbS1wcm9tcHQuanNcIjtcbmltcG9ydCB7IGVtaXRUb2tlblRlbGVtZXRyeSB9IGZyb20gXCIuL3Rva2VuLXRlbGVtZXRyeS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBCYXNoT3BlcmF0aW9ucyB9IGZyb20gXCIuL3Rvb2xzL2Jhc2guanNcIjtcbmltcG9ydCB7IGNyZWF0ZUFsbFRvb2xzIH0gZnJvbSBcIi4vdG9vbHMvaW5kZXguanNcIjtcblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gU2tpbGwgQmxvY2sgUGFyc2luZ1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKiogUGFyc2VkIHNraWxsIGJsb2NrIGZyb20gYSB1c2VyIG1lc3NhZ2UgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUGFyc2VkU2tpbGxCbG9jayB7XG5cdG5hbWU6IHN0cmluZztcblx0bG9jYXRpb246IHN0cmluZztcblx0Y29udGVudDogc3RyaW5nO1xuXHR1c2VyTWVzc2FnZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFBhcnNlIGEgc2tpbGwgYmxvY2sgZnJvbSBtZXNzYWdlIHRleHQuXG4gKiBSZXR1cm5zIG51bGwgaWYgdGhlIHRleHQgZG9lc24ndCBjb250YWluIGEgc2tpbGwgYmxvY2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNraWxsQmxvY2sodGV4dDogc3RyaW5nKTogUGFyc2VkU2tpbGxCbG9jayB8IG51bGwge1xuXHRjb25zdCBtYXRjaCA9IHRleHQubWF0Y2goL148c2tpbGwgbmFtZT1cIihbXlwiXSspXCIgbG9jYXRpb249XCIoW15cIl0rKVwiPlxcbihbXFxzXFxTXSo/KVxcbjxcXC9za2lsbD4oPzpcXG5cXG4oW1xcc1xcU10rKSk/JC8pO1xuXHRpZiAoIW1hdGNoKSByZXR1cm4gbnVsbDtcblx0cmV0dXJuIHtcblx0XHRuYW1lOiBtYXRjaFsxXSxcblx0XHRsb2NhdGlvbjogbWF0Y2hbMl0sXG5cdFx0Y29udGVudDogbWF0Y2hbM10sXG5cdFx0dXNlck1lc3NhZ2U6IG1hdGNoWzRdPy50cmltKCkgfHwgdW5kZWZpbmVkLFxuXHR9O1xufVxuXG4vKiogU2Vzc2lvbi1zcGVjaWZpYyBldmVudHMgdGhhdCBleHRlbmQgdGhlIGNvcmUgQWdlbnRFdmVudCAqL1xuZXhwb3J0IHR5cGUgU2Vzc2lvblN0YXRlQ2hhbmdlUmVhc29uID1cblx0fCBcInNldF9tb2RlbFwiXG5cdHwgXCJzZXRfdGhpbmtpbmdfbGV2ZWxcIlxuXHR8IFwic2V0X3N0ZWVyaW5nX21vZGVcIlxuXHR8IFwic2V0X2ZvbGxvd191cF9tb2RlXCJcblx0fCBcInNldF9hdXRvX2NvbXBhY3Rpb25cIlxuXHR8IFwic2V0X2F1dG9fcmV0cnlcIlxuXHR8IFwiYWJvcnRfcmV0cnlcIlxuXHR8IFwibmV3X3Nlc3Npb25cIlxuXHR8IFwic3dpdGNoX3Nlc3Npb25cIlxuXHR8IFwic2V0X3Nlc3Npb25fbmFtZVwiXG5cdHwgXCJmb3JrXCI7XG5cbmV4cG9ydCB0eXBlIEFnZW50U2Vzc2lvbkV2ZW50ID1cblx0fCBBZ2VudEV2ZW50XG5cdHwgeyB0eXBlOiBcInNlc3Npb25fc3RhdGVfY2hhbmdlZFwiOyByZWFzb246IFNlc3Npb25TdGF0ZUNoYW5nZVJlYXNvbiB9XG5cdHwgeyB0eXBlOiBcImF1dG9fY29tcGFjdGlvbl9zdGFydFwiOyByZWFzb246IFwidGhyZXNob2xkXCIgfCBcIm92ZXJmbG93XCIgfVxuXHR8IHtcblx0XHRcdHR5cGU6IFwiYXV0b19jb21wYWN0aW9uX2VuZFwiO1xuXHRcdFx0cmVzdWx0OiBDb21wYWN0aW9uUmVzdWx0IHwgdW5kZWZpbmVkO1xuXHRcdFx0YWJvcnRlZDogYm9vbGVhbjtcblx0XHRcdHdpbGxSZXRyeTogYm9vbGVhbjtcblx0XHRcdGVycm9yTWVzc2FnZT86IHN0cmluZztcblx0ICB9XG5cdHwgeyB0eXBlOiBcImF1dG9fcmV0cnlfc3RhcnRcIjsgYXR0ZW1wdDogbnVtYmVyOyBtYXhBdHRlbXB0czogbnVtYmVyOyBkZWxheU1zOiBudW1iZXI7IGVycm9yTWVzc2FnZTogc3RyaW5nIH1cblx0fCB7IHR5cGU6IFwiYXV0b19yZXRyeV9lbmRcIjsgc3VjY2VzczogYm9vbGVhbjsgYXR0ZW1wdDogbnVtYmVyOyBmaW5hbEVycm9yPzogc3RyaW5nIH1cblx0fCB7IHR5cGU6IFwiZmFsbGJhY2tfcHJvdmlkZXJfc3dpdGNoXCI7IGZyb206IHN0cmluZzsgdG86IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfVxuXHR8IHsgdHlwZTogXCJmYWxsYmFja19wcm92aWRlcl9yZXN0b3JlZFwiOyBwcm92aWRlcjogc3RyaW5nOyByZWFzb246IHN0cmluZyB9XG5cdHwgeyB0eXBlOiBcImZhbGxiYWNrX2NoYWluX2V4aGF1c3RlZFwiOyByZWFzb246IHN0cmluZyB9XG5cdHwgeyB0eXBlOiBcImltYWdlX292ZXJmbG93X3JlY292ZXJ5XCI7IHN0cmlwcGVkQ291bnQ6IG51bWJlcjsgaW1hZ2VDb3VudDogbnVtYmVyIH07XG5cbi8qKiBMaXN0ZW5lciBmdW5jdGlvbiBmb3IgYWdlbnQgc2Vzc2lvbiBldmVudHMgKi9cbmV4cG9ydCB0eXBlIEFnZW50U2Vzc2lvbkV2ZW50TGlzdGVuZXIgPSAoZXZlbnQ6IEFnZW50U2Vzc2lvbkV2ZW50KSA9PiB2b2lkO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUeXBlc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50U2Vzc2lvbkNvbmZpZyB7XG5cdGFnZW50OiBBZ2VudDtcblx0c2Vzc2lvbk1hbmFnZXI6IFNlc3Npb25NYW5hZ2VyO1xuXHRzZXR0aW5nc01hbmFnZXI6IFNldHRpbmdzTWFuYWdlcjtcblx0Y3dkOiBzdHJpbmc7XG5cdC8qKiBNb2RlbHMgdG8gY3ljbGUgdGhyb3VnaCB3aXRoIEN0cmwrUCAoZnJvbSAtLW1vZGVscyBmbGFnKSAqL1xuXHRzY29wZWRNb2RlbHM/OiBBcnJheTx7IG1vZGVsOiBNb2RlbDxhbnk+OyB0aGlua2luZ0xldmVsPzogVGhpbmtpbmdMZXZlbCB9Pjtcblx0LyoqIFJlc291cmNlIGxvYWRlciBmb3Igc2tpbGxzLCBwcm9tcHRzLCB0aGVtZXMsIGNvbnRleHQgZmlsZXMsIHN5c3RlbSBwcm9tcHQgKi9cblx0cmVzb3VyY2VMb2FkZXI6IFJlc291cmNlTG9hZGVyO1xuXHQvKiogU0RLIGN1c3RvbSB0b29scyByZWdpc3RlcmVkIG91dHNpZGUgZXh0ZW5zaW9ucyAqL1xuXHRjdXN0b21Ub29scz86IFRvb2xEZWZpbml0aW9uW107XG5cdC8qKiBNb2RlbCByZWdpc3RyeSBmb3IgQVBJIGtleSByZXNvbHV0aW9uIGFuZCBtb2RlbCBkaXNjb3ZlcnkgKi9cblx0bW9kZWxSZWdpc3RyeTogTW9kZWxSZWdpc3RyeTtcblx0LyoqIEluaXRpYWwgYWN0aXZlIGJ1aWx0LWluIHRvb2wgbmFtZXMuIERlZmF1bHQ6IFtyZWFkLCBiYXNoLCBlZGl0LCB3cml0ZV0gKi9cblx0aW5pdGlhbEFjdGl2ZVRvb2xOYW1lcz86IHN0cmluZ1tdO1xuXHQvKiogT3ZlcnJpZGUgYmFzZSB0b29scyAodXNlZnVsIGZvciBjdXN0b20gcnVudGltZXMpLiAqL1xuXHRiYXNlVG9vbHNPdmVycmlkZT86IFJlY29yZDxzdHJpbmcsIEFnZW50VG9vbD47XG5cdC8qKiBNdXRhYmxlIHJlZiB1c2VkIGJ5IEFnZW50IHRvIGFjY2VzcyB0aGUgY3VycmVudCBFeHRlbnNpb25SdW5uZXIgKi9cblx0ZXh0ZW5zaW9uUnVubmVyUmVmPzogeyBjdXJyZW50PzogRXh0ZW5zaW9uUnVubmVyIH07XG5cdC8qKiBNdXRhYmxlIHJlZiB1c2VkIGJ5IHByb3ZpZGVycyB0byBhY2Nlc3MgdGhlIGN1cnJlbnQgd29ya3NwYWNlIHJvb3QuICovXG5cdHdvcmtzcGFjZVJvb3RSZWY/OiB7IGN1cnJlbnQ6IHN0cmluZyB9O1xuXHQvKiogT3B0aW9uYWw6IGNoZWNrIGlmIHRoZSBjbGF1ZGUtY29kZSBDTEkgcHJvdmlkZXIgaXMgcmVhZHkgKGluc3RhbGxlZCArIGF1dGhlZCkuXG5cdCAqIFBhc3NlZCB0aHJvdWdoIHRvIFJldHJ5SGFuZGxlciBmb3IgdGhpcmQtcGFydHkgYmxvY2sgcmVjb3ZlcnkgKCMzNzcyKS4gKi9cblx0aXNDbGF1ZGVDb2RlUmVhZHk/OiAoKSA9PiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEV4dGVuc2lvbkJpbmRpbmdzIHtcblx0dWlDb250ZXh0PzogRXh0ZW5zaW9uVUlDb250ZXh0O1xuXHRjb21tYW5kQ29udGV4dEFjdGlvbnM/OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dEFjdGlvbnM7XG5cdHNodXRkb3duSGFuZGxlcj86IFNodXRkb3duSGFuZGxlcjtcblx0b25FcnJvcj86IEV4dGVuc2lvbkVycm9yTGlzdGVuZXI7XG59XG5cbi8qKiBPcHRpb25zIGZvciBBZ2VudFNlc3Npb24ucHJvbXB0KCkgKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJvbXB0T3B0aW9ucyB7XG5cdC8qKiBXaGV0aGVyIHRvIGV4cGFuZCBmaWxlLWJhc2VkIHByb21wdCB0ZW1wbGF0ZXMgKGRlZmF1bHQ6IHRydWUpICovXG5cdGV4cGFuZFByb21wdFRlbXBsYXRlcz86IGJvb2xlYW47XG5cdC8qKiBJbWFnZSBhdHRhY2htZW50cyAqL1xuXHRpbWFnZXM/OiBJbWFnZUNvbnRlbnRbXTtcblx0LyoqIFdoZW4gc3RyZWFtaW5nLCBob3cgdG8gcXVldWUgdGhlIG1lc3NhZ2U6IFwic3RlZXJcIiAoaW50ZXJydXB0KSBvciBcImZvbGxvd1VwXCIgKHdhaXQpLiBSZXF1aXJlZCBpZiBzdHJlYW1pbmcuICovXG5cdHN0cmVhbWluZ0JlaGF2aW9yPzogXCJzdGVlclwiIHwgXCJmb2xsb3dVcFwiO1xuXHQvKiogU291cmNlIG9mIGlucHV0IGZvciBleHRlbnNpb24gaW5wdXQgZXZlbnQgaGFuZGxlcnMuIERlZmF1bHRzIHRvIFwiaW50ZXJhY3RpdmVcIi4gKi9cblx0c291cmNlPzogSW5wdXRTb3VyY2U7XG59XG5cbi8qKiBSZXN1bHQgZnJvbSBjeWNsZU1vZGVsKCkgKi9cbmV4cG9ydCBpbnRlcmZhY2UgTW9kZWxDeWNsZVJlc3VsdCB7XG5cdG1vZGVsOiBNb2RlbDxhbnk+O1xuXHR0aGlua2luZ0xldmVsOiBUaGlua2luZ0xldmVsO1xuXHQvKiogV2hldGhlciBjeWNsaW5nIHRocm91Z2ggc2NvcGVkIG1vZGVscyAoLS1tb2RlbHMgZmxhZykgb3IgYWxsIGF2YWlsYWJsZSAqL1xuXHRpc1Njb3BlZDogYm9vbGVhbjtcbn1cblxuLyoqIFNlc3Npb24gc3RhdGlzdGljcyBmb3IgL3Nlc3Npb24gY29tbWFuZCAqL1xuZXhwb3J0IGludGVyZmFjZSBTZXNzaW9uU3RhdHMge1xuXHRzZXNzaW9uRmlsZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRzZXNzaW9uSWQ6IHN0cmluZztcblx0dXNlck1lc3NhZ2VzOiBudW1iZXI7XG5cdGFzc2lzdGFudE1lc3NhZ2VzOiBudW1iZXI7XG5cdHRvb2xDYWxsczogbnVtYmVyO1xuXHR0b29sUmVzdWx0czogbnVtYmVyO1xuXHR0b3RhbE1lc3NhZ2VzOiBudW1iZXI7XG5cdHRva2Vuczoge1xuXHRcdGlucHV0OiBudW1iZXI7XG5cdFx0b3V0cHV0OiBudW1iZXI7XG5cdFx0Y2FjaGVSZWFkOiBudW1iZXI7XG5cdFx0Y2FjaGVXcml0ZTogbnVtYmVyO1xuXHRcdHRvdGFsOiBudW1iZXI7XG5cdH07XG5cdGNvc3Q6IG51bWJlcjtcbn1cblxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuLy8gQ29uc3RhbnRzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKiBTdGFuZGFyZCB0aGlua2luZyBsZXZlbHMgKi9cbmNvbnN0IFRISU5LSU5HX0xFVkVMUzogVGhpbmtpbmdMZXZlbFtdID0gW1wib2ZmXCIsIFwibWluaW1hbFwiLCBcImxvd1wiLCBcIm1lZGl1bVwiLCBcImhpZ2hcIl07XG5cbi8qKiBUaGlua2luZyBsZXZlbHMgaW5jbHVkaW5nIHhoaWdoIChmb3Igc3VwcG9ydGVkIG1vZGVscykgKi9cbmNvbnN0IFRISU5LSU5HX0xFVkVMU19XSVRIX1hISUdIOiBUaGlua2luZ0xldmVsW10gPSBbXCJvZmZcIiwgXCJtaW5pbWFsXCIsIFwibG93XCIsIFwibWVkaXVtXCIsIFwiaGlnaFwiLCBcInhoaWdoXCJdO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBBZ2VudFNlc3Npb24gQ2xhc3Ncbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGNsYXNzIEFnZW50U2Vzc2lvbiB7XG5cdHJlYWRvbmx5IGFnZW50OiBBZ2VudDtcblx0cmVhZG9ubHkgc2Vzc2lvbk1hbmFnZXI6IFNlc3Npb25NYW5hZ2VyO1xuXHRyZWFkb25seSBzZXR0aW5nc01hbmFnZXI6IFNldHRpbmdzTWFuYWdlcjtcblxuXHRwcml2YXRlIF9zY29wZWRNb2RlbHM6IEFycmF5PHsgbW9kZWw6IE1vZGVsPGFueT47IHRoaW5raW5nTGV2ZWw/OiBUaGlua2luZ0xldmVsIH0+O1xuXG5cdC8vIEV2ZW50IHN1YnNjcmlwdGlvbiBzdGF0ZVxuXHRwcml2YXRlIF91bnN1YnNjcmliZUFnZW50PzogKCkgPT4gdm9pZDtcblx0cHJpdmF0ZSBfZXZlbnRMaXN0ZW5lcnM6IEFnZW50U2Vzc2lvbkV2ZW50TGlzdGVuZXJbXSA9IFtdO1xuXHRwcml2YXRlIF9hZ2VudEV2ZW50UXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuXHQvKiogVHJhY2tzIHBlbmRpbmcgc3RlZXJpbmcgbWVzc2FnZXMgZm9yIFVJIGRpc3BsYXkuIFJlbW92ZWQgd2hlbiBkZWxpdmVyZWQuICovXG5cdHByaXZhdGUgX3N0ZWVyaW5nTWVzc2FnZXM6IHN0cmluZ1tdID0gW107XG5cdC8qKiBUcmFja3MgcGVuZGluZyBmb2xsb3ctdXAgbWVzc2FnZXMgZm9yIFVJIGRpc3BsYXkuIFJlbW92ZWQgd2hlbiBkZWxpdmVyZWQuICovXG5cdHByaXZhdGUgX2ZvbGxvd1VwTWVzc2FnZXM6IHN0cmluZ1tdID0gW107XG5cdC8qKiBNZXNzYWdlcyBxdWV1ZWQgdG8gYmUgaW5jbHVkZWQgd2l0aCB0aGUgbmV4dCB1c2VyIHByb21wdCBhcyBjb250ZXh0IChcImFzaWRlc1wiKS4gKi9cblx0cHJpdmF0ZSBfcGVuZGluZ05leHRUdXJuTWVzc2FnZXM6IEN1c3RvbU1lc3NhZ2VbXSA9IFtdO1xuXG5cdC8vIERlbGVnYXRlZCBzdWJzeXN0ZW1zXG5cdHByaXZhdGUgX3JldHJ5SGFuZGxlcjogUmV0cnlIYW5kbGVyO1xuXHRwcml2YXRlIF9jb21wYWN0aW9uT3JjaGVzdHJhdG9yOiBDb21wYWN0aW9uT3JjaGVzdHJhdG9yO1xuXG5cdC8vIEN1bXVsYXRpdmUgc2Vzc2lvbiBzdGF0cyBcdTIwMTQgc3Vydml2ZXMgY29tcGFjdGlvbiAoIzE0MjMpXG5cdHByaXZhdGUgX2N1bXVsYXRpdmVDb3N0ID0gMDtcblx0cHJpdmF0ZSBfY3VtdWxhdGl2ZUlucHV0VG9rZW5zID0gMDtcblx0cHJpdmF0ZSBfY3VtdWxhdGl2ZU91dHB1dFRva2VucyA9IDA7XG5cdHByaXZhdGUgX2N1bXVsYXRpdmVUb29sQ2FsbHMgPSAwO1xuXG5cdC8qKiBDb3N0IG9mIHRoZSBtb3N0IHJlY2VudCBhc3Npc3RhbnQgcmVzcG9uc2UgKGZvciBwZXItcHJvbXB0IGRpc3BsYXkpLiAqL1xuXHRwcml2YXRlIF9sYXN0VHVybkNvc3QgPSAwO1xuXG5cblx0Ly8gQmFzaCBleGVjdXRpb24gc3RhdGVcblx0cHJpdmF0ZSBfYmFzaEFib3J0Q29udHJvbGxlcjogQWJvcnRDb250cm9sbGVyIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkO1xuXHRwcml2YXRlIF9wZW5kaW5nQmFzaE1lc3NhZ2VzOiBCYXNoRXhlY3V0aW9uTWVzc2FnZVtdID0gW107XG5cblx0Ly8gRXh0ZW5zaW9uIHN5c3RlbVxuXHRwcml2YXRlIF9leHRlbnNpb25SdW5uZXI6IEV4dGVuc2lvblJ1bm5lciB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblx0cHJpdmF0ZSBfdHVybkluZGV4ID0gMDtcblx0cHJpdmF0ZSBfcHJvY2Vzc2luZ0FnZW50RW5kID0gZmFsc2U7XG5cdC8qKiBUcnVlIHdoaWxlIG5ld1Nlc3Npb24oKS9zd2l0Y2hTZXNzaW9uKCkgaXMgaW4gcHJvZ3Jlc3M7IHNpZ25hbHMgYWdlbnRfZW5kXG5cdCAqIHBvc3QtaGFuZGxlcnMgdG8gYmFpbCByYXRoZXIgdGhhbiBjb3JydXB0IG5ldy1zZXNzaW9uIHN0YXRlLiAqL1xuXHRwcml2YXRlIF9zZXNzaW9uU3dpdGNoUGVuZGluZyA9IGZhbHNlO1xuXHRwcml2YXRlIF9wcm9jZXNzaW5nUXVldWVkQWdlbnRFbmQgPSBmYWxzZTtcblx0cHJpdmF0ZSBfc2Vzc2lvblRyYW5zaXRpb25TdGFydGVkRHVyaW5nQWdlbnRFbmQgPSBmYWxzZTtcblxuXHRwcml2YXRlIF9yZXNvdXJjZUxvYWRlcjogUmVzb3VyY2VMb2FkZXI7XG5cdHByaXZhdGUgX2N1c3RvbVRvb2xzOiBUb29sRGVmaW5pdGlvbltdO1xuXHRwcml2YXRlIF9iYXNlVG9vbFJlZ2lzdHJ5OiBNYXA8c3RyaW5nLCBBZ2VudFRvb2w+ID0gbmV3IE1hcCgpO1xuXHRwcml2YXRlIF9jd2Q6IHN0cmluZztcblx0cHJpdmF0ZSBfZXh0ZW5zaW9uUnVubmVyUmVmPzogeyBjdXJyZW50PzogRXh0ZW5zaW9uUnVubmVyIH07XG5cdHByaXZhdGUgX3dvcmtzcGFjZVJvb3RSZWY/OiB7IGN1cnJlbnQ6IHN0cmluZyB9O1xuXHRwcml2YXRlIF9pbml0aWFsQWN0aXZlVG9vbE5hbWVzPzogc3RyaW5nW107XG5cdHByaXZhdGUgX2Jhc2VUb29sc092ZXJyaWRlPzogUmVjb3JkPHN0cmluZywgQWdlbnRUb29sPjtcblx0cHJpdmF0ZSBfZXh0ZW5zaW9uVUlDb250ZXh0PzogRXh0ZW5zaW9uVUlDb250ZXh0O1xuXHRwcml2YXRlIF9leHRlbnNpb25Db21tYW5kQ29udGV4dEFjdGlvbnM/OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dEFjdGlvbnM7XG5cdHByaXZhdGUgX2V4dGVuc2lvblNodXRkb3duSGFuZGxlcj86IFNodXRkb3duSGFuZGxlcjtcblx0cHJpdmF0ZSBfZXh0ZW5zaW9uRXJyb3JMaXN0ZW5lcj86IEV4dGVuc2lvbkVycm9yTGlzdGVuZXI7XG5cdHByaXZhdGUgX2V4dGVuc2lvbkVycm9yVW5zdWJzY3JpYmVyPzogKCkgPT4gdm9pZDtcblxuXHQvLyBNb2RlbCByZWdpc3RyeSBmb3IgQVBJIGtleSByZXNvbHV0aW9uXG5cdHByaXZhdGUgX21vZGVsUmVnaXN0cnk6IE1vZGVsUmVnaXN0cnk7XG5cblx0Ly8gUHJvdmlkZXIgZmFsbGJhY2sgcmVzb2x2ZXJcblx0cHJpdmF0ZSBfZmFsbGJhY2tSZXNvbHZlcjogRmFsbGJhY2tSZXNvbHZlcjtcblxuXHQvLyBUb29sIHJlZ2lzdHJ5IGZvciBleHRlbnNpb24gZ2V0VG9vbHMvc2V0VG9vbHNcblx0cHJpdmF0ZSBfdG9vbFJlZ2lzdHJ5OiBNYXA8c3RyaW5nLCBBZ2VudFRvb2w+ID0gbmV3IE1hcCgpO1xuXHRwcml2YXRlIF90b29sUHJvbXB0U25pcHBldHM6IE1hcDxzdHJpbmcsIHN0cmluZz4gPSBuZXcgTWFwKCk7XG5cdHByaXZhdGUgX3Rvb2xQcm9tcHRHdWlkZWxpbmVzOiBNYXA8c3RyaW5nLCBzdHJpbmdbXT4gPSBuZXcgTWFwKCk7XG5cblx0Ly8gQmFzZSBzeXN0ZW0gcHJvbXB0ICh3aXRob3V0IGV4dGVuc2lvbiBhcHBlbmRzKSAtIHVzZWQgdG8gYXBwbHkgZnJlc2ggYXBwZW5kcyBlYWNoIHR1cm5cblx0cHJpdmF0ZSBfYmFzZVN5c3RlbVByb21wdCA9IFwiXCI7XG5cdC8vIE9wdGlvbmFsIHByb21wdC1vbmx5IHNraWxsIGNhdGFsb2cgZmlsdGVyLiBTa2lsbHMgcmVtYWluIGxvYWRlZCBhbmQgaW52b2NhYmxlIGJ5IG5hbWUuXG5cdHByaXZhdGUgX3Zpc2libGVTa2lsbE5hbWVzOiBTZXQ8c3RyaW5nPiB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblxuXHRjb25zdHJ1Y3Rvcihjb25maWc6IEFnZW50U2Vzc2lvbkNvbmZpZykge1xuXHRcdHRoaXMuYWdlbnQgPSBjb25maWcuYWdlbnQ7XG5cdFx0dGhpcy5zZXNzaW9uTWFuYWdlciA9IGNvbmZpZy5zZXNzaW9uTWFuYWdlcjtcblx0XHR0aGlzLnNldHRpbmdzTWFuYWdlciA9IGNvbmZpZy5zZXR0aW5nc01hbmFnZXI7XG5cdFx0dGhpcy5fc2NvcGVkTW9kZWxzID0gY29uZmlnLnNjb3BlZE1vZGVscyA/PyBbXTtcblx0XHR0aGlzLl9yZXNvdXJjZUxvYWRlciA9IGNvbmZpZy5yZXNvdXJjZUxvYWRlcjtcblx0XHR0aGlzLl9jdXN0b21Ub29scyA9IGNvbmZpZy5jdXN0b21Ub29scyA/PyBbXTtcblx0XHR0aGlzLl9jd2QgPSBjb25maWcuY3dkO1xuXHRcdHRoaXMuX21vZGVsUmVnaXN0cnkgPSBjb25maWcubW9kZWxSZWdpc3RyeTtcblx0XHR0aGlzLl9mYWxsYmFja1Jlc29sdmVyID0gbmV3IEZhbGxiYWNrUmVzb2x2ZXIoXG5cdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlcixcblx0XHRcdHRoaXMuX21vZGVsUmVnaXN0cnkuYXV0aFN0b3JhZ2UsXG5cdFx0XHR0aGlzLl9tb2RlbFJlZ2lzdHJ5LFxuXHRcdCk7XG5cdFx0dGhpcy5fZXh0ZW5zaW9uUnVubmVyUmVmID0gY29uZmlnLmV4dGVuc2lvblJ1bm5lclJlZjtcblx0XHR0aGlzLl93b3Jrc3BhY2VSb290UmVmID0gY29uZmlnLndvcmtzcGFjZVJvb3RSZWY7XG5cdFx0aWYgKHRoaXMuX3dvcmtzcGFjZVJvb3RSZWYpIHtcblx0XHRcdHRoaXMuX3dvcmtzcGFjZVJvb3RSZWYuY3VycmVudCA9IHRoaXMuX2N3ZDtcblx0XHR9XG5cdFx0dGhpcy5faW5pdGlhbEFjdGl2ZVRvb2xOYW1lcyA9IGNvbmZpZy5pbml0aWFsQWN0aXZlVG9vbE5hbWVzO1xuXHRcdHRoaXMuX2Jhc2VUb29sc092ZXJyaWRlID0gY29uZmlnLmJhc2VUb29sc092ZXJyaWRlO1xuXG5cdFx0Ly8gSW5pdGlhbGl6ZSBkZWxlZ2F0ZWQgc3Vic3lzdGVtc1xuXHRcdHRoaXMuX3JldHJ5SGFuZGxlciA9IG5ldyBSZXRyeUhhbmRsZXIoe1xuXHRcdFx0YWdlbnQ6IHRoaXMuYWdlbnQsXG5cdFx0XHRzZXR0aW5nc01hbmFnZXI6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLFxuXHRcdFx0bW9kZWxSZWdpc3RyeTogdGhpcy5fbW9kZWxSZWdpc3RyeSxcblx0XHRcdGZhbGxiYWNrUmVzb2x2ZXI6IHRoaXMuX2ZhbGxiYWNrUmVzb2x2ZXIsXG5cdFx0XHRnZXRNb2RlbDogKCkgPT4gdGhpcy5tb2RlbCxcblx0XHRcdGdldFNlc3Npb25JZDogKCkgPT4gdGhpcy5zZXNzaW9uSWQsXG5cdFx0XHRlbWl0OiAoZXZlbnQpID0+IHRoaXMuX2VtaXQoZXZlbnQpLFxuXHRcdFx0b25Nb2RlbENoYW5nZTogKG1vZGVsKSA9PiB0aGlzLnNlc3Npb25NYW5hZ2VyLmFwcGVuZE1vZGVsQ2hhbmdlKG1vZGVsLnByb3ZpZGVyLCBtb2RlbC5pZCksXG5cdFx0XHRpc0NsYXVkZUNvZGVSZWFkeTogY29uZmlnLmlzQ2xhdWRlQ29kZVJlYWR5LFxuXHRcdH0pO1xuXG5cdFx0dGhpcy5fY29tcGFjdGlvbk9yY2hlc3RyYXRvciA9IG5ldyBDb21wYWN0aW9uT3JjaGVzdHJhdG9yKHtcblx0XHRcdGFnZW50OiB0aGlzLmFnZW50LFxuXHRcdFx0c2Vzc2lvbk1hbmFnZXI6IHRoaXMuc2Vzc2lvbk1hbmFnZXIsXG5cdFx0XHRzZXR0aW5nc01hbmFnZXI6IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLFxuXHRcdFx0bW9kZWxSZWdpc3RyeTogdGhpcy5fbW9kZWxSZWdpc3RyeSxcblx0XHRcdGdldE1vZGVsOiAoKSA9PiB0aGlzLm1vZGVsLFxuXHRcdFx0Z2V0U2Vzc2lvbklkOiAoKSA9PiB0aGlzLnNlc3Npb25JZCxcblx0XHRcdGdldEV4dGVuc2lvblJ1bm5lcjogKCkgPT4gdGhpcy5fZXh0ZW5zaW9uUnVubmVyLFxuXHRcdFx0ZW1pdDogKGV2ZW50KSA9PiB0aGlzLl9lbWl0KGV2ZW50KSxcblx0XHRcdGRpc2Nvbm5lY3RGcm9tQWdlbnQ6ICgpID0+IHRoaXMuX2Rpc2Nvbm5lY3RGcm9tQWdlbnQoKSxcblx0XHRcdHJlY29ubmVjdFRvQWdlbnQ6ICgpID0+IHRoaXMuX3JlY29ubmVjdFRvQWdlbnQoKSxcblx0XHRcdGFib3J0OiAoKSA9PiB0aGlzLmFib3J0KHsgb3JpZ2luOiBcInVzZXJcIiB9KSxcblx0XHR9KTtcblxuXHRcdC8vIEFsd2F5cyBzdWJzY3JpYmUgdG8gYWdlbnQgZXZlbnRzIGZvciBpbnRlcm5hbCBoYW5kbGluZ1xuXHRcdC8vIChzZXNzaW9uIHBlcnNpc3RlbmNlLCBleHRlbnNpb25zLCBhdXRvLWNvbXBhY3Rpb24sIHJldHJ5IGxvZ2ljKVxuXHRcdHRoaXMuX3Vuc3Vic2NyaWJlQWdlbnQgPSB0aGlzLmFnZW50LnN1YnNjcmliZSh0aGlzLl9oYW5kbGVBZ2VudEV2ZW50KTtcblxuXHRcdC8vIEluc3RhbGwgdG9vbCBob29rcyB0aGF0IGF3YWl0IHRoZSBldmVudCBxdWV1ZSBiZWZvcmUgZW1pdHRpbmcgZXh0ZW5zaW9uIGV2ZW50cy5cblx0XHQvLyBUaGlzIGVuc3VyZXMgZXh0ZW5zaW9ucyBhbHdheXMgc2VlIHNldHRsZWQgc3RhdGUgKGUuZy4sIGFzc2lzdGFudCBtZXNzYWdlIGFwcGVuZGVkKVxuXHRcdC8vIGV2ZW4gd2hlbiB0b29scyBleGVjdXRlIGluIHBhcmFsbGVsLlxuXHRcdHRoaXMuX2luc3RhbGxBZ2VudFRvb2xIb29rcygpO1xuXG5cdFx0dGhpcy5fYnVpbGRSdW50aW1lKHtcblx0XHRcdGFjdGl2ZVRvb2xOYW1lczogdGhpcy5faW5pdGlhbEFjdGl2ZVRvb2xOYW1lcyxcblx0XHRcdGluY2x1ZGVBbGxFeHRlbnNpb25Ub29sczogdHJ1ZSxcblx0XHR9KTtcblx0fVxuXG5cdC8qKiBNb2RlbCByZWdpc3RyeSBmb3IgQVBJIGtleSByZXNvbHV0aW9uIGFuZCBtb2RlbCBkaXNjb3ZlcnkgKi9cblx0Z2V0IG1vZGVsUmVnaXN0cnkoKTogTW9kZWxSZWdpc3RyeSB7XG5cdFx0cmV0dXJuIHRoaXMuX21vZGVsUmVnaXN0cnk7XG5cdH1cblxuXHQvKiogRmFsbGJhY2sgcmVzb2x2ZXIgZm9yIGNyb3NzLXByb3ZpZGVyIGZhbGxiYWNrICovXG5cdGdldCBmYWxsYmFja1Jlc29sdmVyKCk6IEZhbGxiYWNrUmVzb2x2ZXIge1xuXHRcdHJldHVybiB0aGlzLl9mYWxsYmFja1Jlc29sdmVyO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBFdmVudCBTdWJzY3JpcHRpb25cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdC8qKiBFbWl0IGFuIGV2ZW50IHRvIGFsbCBsaXN0ZW5lcnMgKi9cblx0cHJpdmF0ZSBfZW1pdChldmVudDogQWdlbnRTZXNzaW9uRXZlbnQpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IGwgb2YgdGhpcy5fZXZlbnRMaXN0ZW5lcnMpIHtcblx0XHRcdGwoZXZlbnQpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgX2VtaXRTZXNzaW9uU3RhdGVDaGFuZ2VkKHJlYXNvbjogU2Vzc2lvblN0YXRlQ2hhbmdlUmVhc29uKTogdm9pZCB7XG5cdFx0dGhpcy5fZW1pdCh7IHR5cGU6IFwic2Vzc2lvbl9zdGF0ZV9jaGFuZ2VkXCIsIHJlYXNvbiB9KTtcblx0fVxuXG5cdC8vIFRyYWNrIGxhc3QgYXNzaXN0YW50IG1lc3NhZ2UgZm9yIGF1dG8tY29tcGFjdGlvbiBjaGVja1xuXHRwcml2YXRlIF9sYXN0QXNzaXN0YW50TWVzc2FnZTogQXNzaXN0YW50TWVzc2FnZSB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZDtcblxuXHQvKiogSW50ZXJuYWwgaGFuZGxlciBmb3IgYWdlbnQgZXZlbnRzIC0gc2hhcmVkIGJ5IHN1YnNjcmliZSBhbmQgcmVjb25uZWN0ICovXG5cdHByaXZhdGUgX2hhbmRsZUFnZW50RXZlbnQgPSAoZXZlbnQ6IEFnZW50RXZlbnQpOiB2b2lkID0+IHtcblx0XHQvLyBDcmVhdGUgcmV0cnkgcHJvbWlzZSBzeW5jaHJvbm91c2x5IGJlZm9yZSBxdWV1ZWluZyBhc3luYyBwcm9jZXNzaW5nLlxuXHRcdC8vIEFnZW50LmVtaXQoKSBjYWxscyB0aGlzIGhhbmRsZXIgc3luY2hyb25vdXNseSwgYW5kIHByb21wdCgpIGNhbGxzIHdhaXRGb3JSZXRyeSgpXG5cdFx0Ly8gYXMgc29vbiBhcyBhZ2VudC5wcm9tcHQoKSByZXNvbHZlcy4gSWYgdGhlIHJldHJ5IHByb21pc2UgaXMgY3JlYXRlZCBvbmx5IGluc2lkZVxuXHRcdC8vIF9wcm9jZXNzQWdlbnRFdmVudCwgc2xvdyBlYXJsaWVyIHF1ZXVlZCBldmVudHMgY2FuIGRlbGF5IGFnZW50X2VuZCBwcm9jZXNzaW5nXG5cdFx0Ly8gYW5kIHdhaXRGb3JSZXRyeSgpIGNhbiBtaXNzIHRoZSBpbi1mbGlnaHQgcmV0cnkuXG5cdFx0dGhpcy5fY3JlYXRlUmV0cnlQcm9taXNlRm9yQWdlbnRFbmQoZXZlbnQpO1xuXG5cdFx0dGhpcy5fYWdlbnRFdmVudFF1ZXVlID0gdGhpcy5fYWdlbnRFdmVudFF1ZXVlLnRoZW4oXG5cdFx0XHQoKSA9PiB0aGlzLl9wcm9jZXNzQWdlbnRFdmVudChldmVudCksXG5cdFx0XHQoKSA9PiB0aGlzLl9wcm9jZXNzQWdlbnRFdmVudChldmVudCksXG5cdFx0KTtcblxuXHRcdC8vIEtlZXAgcXVldWUgYWxpdmUgaWYgYW4gZXZlbnQgaGFuZGxlciBmYWlsc1xuXHRcdHRoaXMuX2FnZW50RXZlbnRRdWV1ZS5jYXRjaCgoKSA9PiB7fSk7XG5cdH07XG5cblx0cHJpdmF0ZSBfY3JlYXRlUmV0cnlQcm9taXNlRm9yQWdlbnRFbmQoZXZlbnQ6IEFnZW50RXZlbnQpOiB2b2lkIHtcblx0XHRpZiAoZXZlbnQudHlwZSAhPT0gXCJhZ2VudF9lbmRcIikgcmV0dXJuO1xuXHRcdHRoaXMuX3JldHJ5SGFuZGxlci5jcmVhdGVSZXRyeVByb21pc2VGb3JBZ2VudEVuZChldmVudC5tZXNzYWdlcyk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9wcm9jZXNzQWdlbnRFdmVudChldmVudDogQWdlbnRFdmVudCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdC8vIFdoZW4gYSB1c2VyIG1lc3NhZ2Ugc3RhcnRzLCBjaGVjayBpZiBpdCdzIGZyb20gZWl0aGVyIHF1ZXVlIGFuZCByZW1vdmUgaXQgQkVGT1JFIGVtaXR0aW5nXG5cdFx0Ly8gVGhpcyBlbnN1cmVzIHRoZSBVSSBzZWVzIHRoZSB1cGRhdGVkIHF1ZXVlIHN0YXRlXG5cdFx0aWYgKGV2ZW50LnR5cGUgPT09IFwibWVzc2FnZV9zdGFydFwiICYmIGV2ZW50Lm1lc3NhZ2Uucm9sZSA9PT0gXCJ1c2VyXCIpIHtcblx0XHRcdHRoaXMuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IucmVzZXRPdmVyZmxvd1JlY292ZXJ5KCk7XG5cdFx0XHRjb25zdCBtZXNzYWdlVGV4dCA9IHRoaXMuX2dldFVzZXJNZXNzYWdlVGV4dChldmVudC5tZXNzYWdlKTtcblx0XHRcdGlmIChtZXNzYWdlVGV4dCkge1xuXHRcdFx0XHQvLyBDaGVjayBzdGVlcmluZyBxdWV1ZSBmaXJzdFxuXHRcdFx0XHRjb25zdCBzdGVlcmluZ0luZGV4ID0gdGhpcy5fc3RlZXJpbmdNZXNzYWdlcy5pbmRleE9mKG1lc3NhZ2VUZXh0KTtcblx0XHRcdFx0aWYgKHN0ZWVyaW5nSW5kZXggIT09IC0xKSB7XG5cdFx0XHRcdFx0dGhpcy5fc3RlZXJpbmdNZXNzYWdlcy5zcGxpY2Uoc3RlZXJpbmdJbmRleCwgMSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gQ2hlY2sgZm9sbG93LXVwIHF1ZXVlXG5cdFx0XHRcdFx0Y29uc3QgZm9sbG93VXBJbmRleCA9IHRoaXMuX2ZvbGxvd1VwTWVzc2FnZXMuaW5kZXhPZihtZXNzYWdlVGV4dCk7XG5cdFx0XHRcdFx0aWYgKGZvbGxvd1VwSW5kZXggIT09IC0xKSB7XG5cdFx0XHRcdFx0XHR0aGlzLl9mb2xsb3dVcE1lc3NhZ2VzLnNwbGljZShmb2xsb3dVcEluZGV4LCAxKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBFbWl0IHRvIGV4dGVuc2lvbnMgZmlyc3Rcblx0XHRsZXQgc2tpcEFnZW50RW5kUG9zdEhhbmRsZXJzID0gZmFsc2U7XG5cdFx0aWYgKGV2ZW50LnR5cGUgPT09IFwiYWdlbnRfZW5kXCIpIHtcblx0XHRcdHRoaXMuX3Byb2Nlc3NpbmdRdWV1ZWRBZ2VudEVuZCA9IHRydWU7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLl9lbWl0RXh0ZW5zaW9uRXZlbnQoZXZlbnQpO1xuXHRcdFx0fSBmaW5hbGx5IHtcblx0XHRcdFx0dGhpcy5fcHJvY2Vzc2luZ1F1ZXVlZEFnZW50RW5kID0gZmFsc2U7XG5cdFx0XHRcdHNraXBBZ2VudEVuZFBvc3RIYW5kbGVycyA9IHRoaXMuX3Nlc3Npb25UcmFuc2l0aW9uU3RhcnRlZER1cmluZ0FnZW50RW5kO1xuXHRcdFx0XHR0aGlzLl9zZXNzaW9uVHJhbnNpdGlvblN0YXJ0ZWREdXJpbmdBZ2VudEVuZCA9IGZhbHNlO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoc2tpcEFnZW50RW5kUG9zdEhhbmRsZXJzKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0YXdhaXQgdGhpcy5fZW1pdEV4dGVuc2lvbkV2ZW50KGV2ZW50KTtcblx0XHR9XG5cblx0XHQvLyBOb3RpZnkgYWxsIGxpc3RlbmVyc1xuXHRcdHRoaXMuX2VtaXQoZXZlbnQpO1xuXG5cdFx0Ly8gSGFuZGxlIHNlc3Npb24gcGVyc2lzdGVuY2Vcblx0XHRpZiAoZXZlbnQudHlwZSA9PT0gXCJtZXNzYWdlX2VuZFwiKSB7XG5cdFx0XHQvLyBDaGVjayBpZiB0aGlzIGlzIGEgY3VzdG9tIG1lc3NhZ2UgZnJvbSBleHRlbnNpb25zXG5cdFx0XHRpZiAoZXZlbnQubWVzc2FnZS5yb2xlID09PSBcImN1c3RvbVwiKSB7XG5cdFx0XHRcdC8vIFBlcnNpc3QgYXMgQ3VzdG9tTWVzc2FnZUVudHJ5XG5cdFx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuYXBwZW5kQ3VzdG9tTWVzc2FnZUVudHJ5KFxuXHRcdFx0XHRcdGV2ZW50Lm1lc3NhZ2UuY3VzdG9tVHlwZSxcblx0XHRcdFx0XHRldmVudC5tZXNzYWdlLmNvbnRlbnQsXG5cdFx0XHRcdFx0ZXZlbnQubWVzc2FnZS5kaXNwbGF5LFxuXHRcdFx0XHRcdGV2ZW50Lm1lc3NhZ2UuZGV0YWlscyxcblx0XHRcdFx0KTtcblx0XHRcdH0gZWxzZSBpZiAoXG5cdFx0XHRcdGV2ZW50Lm1lc3NhZ2Uucm9sZSA9PT0gXCJ1c2VyXCIgfHxcblx0XHRcdFx0ZXZlbnQubWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiIHx8XG5cdFx0XHRcdGV2ZW50Lm1lc3NhZ2Uucm9sZSA9PT0gXCJ0b29sUmVzdWx0XCJcblx0XHRcdCkge1xuXHRcdFx0XHQvLyBSZWd1bGFyIExMTSBtZXNzYWdlIC0gcGVyc2lzdCBhcyBTZXNzaW9uTWVzc2FnZUVudHJ5XG5cdFx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuYXBwZW5kTWVzc2FnZShldmVudC5tZXNzYWdlKTtcblx0XHRcdH1cblx0XHRcdC8vIE90aGVyIG1lc3NhZ2UgdHlwZXMgKGJhc2hFeGVjdXRpb24sIGNvbXBhY3Rpb25TdW1tYXJ5LCBicmFuY2hTdW1tYXJ5KSBhcmUgcGVyc2lzdGVkIGVsc2V3aGVyZVxuXG5cdFx0XHQvLyBUcmFjayBhc3Npc3RhbnQgbWVzc2FnZSBmb3IgYXV0by1jb21wYWN0aW9uIChjaGVja2VkIG9uIGFnZW50X2VuZClcblx0XHRcdGlmIChldmVudC5tZXNzYWdlLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcblx0XHRcdFx0dGhpcy5fbGFzdEFzc2lzdGFudE1lc3NhZ2UgPSBldmVudC5tZXNzYWdlO1xuXG5cdFx0XHRcdC8vIEFjY3VtdWxhdGUgc2Vzc2lvbiBzdGF0cyB0aGF0IHN1cnZpdmUgY29tcGFjdGlvbiAoIzE0MjMpXG5cdFx0XHRcdGNvbnN0IGFzc2lzdGFudE1zZyA9IGV2ZW50Lm1lc3NhZ2UgYXMgQXNzaXN0YW50TWVzc2FnZTtcblx0XHRcdFx0dGhpcy5fbGFzdFR1cm5Db3N0ID0gYXNzaXN0YW50TXNnLnVzYWdlPy5jb3N0Py50b3RhbCA/PyAwO1xuXHRcdFx0XHR0aGlzLl9jdW11bGF0aXZlQ29zdCArPSBhc3Npc3RhbnRNc2cudXNhZ2U/LmNvc3Q/LnRvdGFsID8/IDA7XG5cdFx0XHRcdHRoaXMuX2N1bXVsYXRpdmVJbnB1dFRva2VucyArPSBhc3Npc3RhbnRNc2cudXNhZ2U/LmlucHV0ID8/IDA7XG5cdFx0XHRcdHRoaXMuX2N1bXVsYXRpdmVPdXRwdXRUb2tlbnMgKz0gYXNzaXN0YW50TXNnLnVzYWdlPy5vdXRwdXQgPz8gMDtcblx0XHRcdFx0dGhpcy5fY3VtdWxhdGl2ZVRvb2xDYWxscyArPSBhc3Npc3RhbnRNc2cuY29udGVudC5maWx0ZXIoKGMpID0+IGMudHlwZSA9PT0gXCJ0b29sQ2FsbFwiKS5sZW5ndGg7XG5cblx0XHRcdFx0Ly8gUGVyLWNhbGwgdG9rZW4gdGVsZW1ldHJ5IChvZmYgYnkgZGVmYXVsdDsgZ2F0ZWQgYnkgUElfVE9LRU5fVEVMRU1FVFJZPTEpLlxuXHRcdFx0XHQvLyBOb3RlOiBhIHR1cm4gdGhhdCByZXRyaWVzIGVtaXRzIG9uZSByZWNvcmQgcGVyIGF0dGVtcHQgXHUyMDE0IGdyb3VwIGJ5XG5cdFx0XHRcdC8vIHNlc3Npb24vdHVybiBkb3duc3RyZWFtIGlmIHlvdSB3YW50IGEgZGVkdXBsaWNhdGVkIHZpZXcuIEJvdGggcmVjb3Jkc1xuXHRcdFx0XHQvLyBhcmUgdmFsaWQgKGVhY2ggd2FzIGEgYmlsbGVkL2F0dGVtcHRlZCBBUEkgY2FsbCkuICM1MDIzXG5cdFx0XHRcdGVtaXRUb2tlblRlbGVtZXRyeShhc3Npc3RhbnRNc2cpO1xuXG5cdFx0XHRcdGlmIChhc3Npc3RhbnRNc2cuc3RvcFJlYXNvbiAhPT0gXCJlcnJvclwiKSB7XG5cdFx0XHRcdFx0dGhpcy5fY29tcGFjdGlvbk9yY2hlc3RyYXRvci5jbGVhck92ZXJmbG93UmVjb3ZlcnkoKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFJlc2V0IHJldHJ5IGNvdW50ZXIgaW1tZWRpYXRlbHkgb24gc3VjY2Vzc2Z1bCBhc3Npc3RhbnQgcmVzcG9uc2Vcblx0XHRcdFx0Ly8gVGhpcyBwcmV2ZW50cyBhY2N1bXVsYXRpb24gYWNyb3NzIG11bHRpcGxlIExMTSBjYWxscyB3aXRoaW4gYSB0dXJuXG5cdFx0XHRcdGlmIChhc3Npc3RhbnRNc2cuc3RvcFJlYXNvbiAhPT0gXCJlcnJvclwiKSB7XG5cdFx0XHRcdFx0dGhpcy5fcmV0cnlIYW5kbGVyLmhhbmRsZVN1Y2Nlc3NmdWxSZXNwb25zZSgpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gQ2hlY2sgYXV0by1yZXRyeSBhbmQgYXV0by1jb21wYWN0aW9uIGFmdGVyIGFnZW50IGNvbXBsZXRlc1xuXHRcdGlmIChldmVudC50eXBlID09PSBcImFnZW50X2VuZFwiICYmIHRoaXMuX2xhc3RBc3Npc3RhbnRNZXNzYWdlKSB7XG5cdFx0XHQvLyBBIHNlc3Npb24gdHJhbnNpdGlvbiBzdGFydGVkIGR1cmluZyBhZ2VudF9lbmQgaGFuZGxlciBleGVjdXRpb24gLVxuXHRcdFx0Ly8gYmFpbCB0byBhdm9pZCBydW5uaW5nIHJldHJ5L2NvbXBhY3Rpb24gYWdhaW5zdCBuZXctc2Vzc2lvbiBzdGF0ZS5cblx0XHRcdGlmICh0aGlzLl9zZXNzaW9uU3dpdGNoUGVuZGluZykge1xuXHRcdFx0XHR0aGlzLl9sYXN0QXNzaXN0YW50TWVzc2FnZSA9IHVuZGVmaW5lZDtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBtc2cgPSB0aGlzLl9sYXN0QXNzaXN0YW50TWVzc2FnZTtcblx0XHRcdHRoaXMuX2xhc3RBc3Npc3RhbnRNZXNzYWdlID0gdW5kZWZpbmVkO1xuXG5cdFx0XHQvLyBDaGVjayBmb3IgcmV0cnlhYmxlIGVycm9ycyBmaXJzdCAob3ZlcmxvYWRlZCwgcmF0ZSBsaW1pdCwgc2VydmVyIGVycm9ycylcblx0XHRcdGlmICh0aGlzLl9yZXRyeUhhbmRsZXIuaXNSZXRyeWFibGVFcnJvcihtc2cpKSB7XG5cdFx0XHRcdGNvbnN0IGRpZFJldHJ5ID0gYXdhaXQgdGhpcy5fcmV0cnlIYW5kbGVyLmhhbmRsZVJldHJ5YWJsZUVycm9yKG1zZyk7XG5cdFx0XHRcdGlmIChkaWRSZXRyeSkgcmV0dXJuOyAvLyBSZXRyeSB3YXMgaW5pdGlhdGVkLCBkb24ndCBwcm9jZWVkIHRvIGNvbXBhY3Rpb25cblx0XHRcdH1cblxuXHRcdFx0Ly8gQ2hlY2sgZm9yIGltYWdlIGRpbWVuc2lvbiBvdmVyZmxvdyAobWFueS1pbWFnZSA0MDAgZXJyb3IpLlxuXHRcdFx0Ly8gV2hlbiBhIHNlc3Npb24gYWNjdW11bGF0ZXMgbWFueSBpbWFnZXMsIHRoZSBBUEkgcmVqZWN0cyByZXF1ZXN0c1xuXHRcdFx0Ly8gd2hvc2UgaW1hZ2VzIGV4Y2VlZCB0aGUgbWFueS1pbWFnZSBkaW1lbnNpb24gbGltaXQuIFN0cmlwIG9sZGVyXG5cdFx0XHQvLyBpbWFnZXMgZnJvbSB0aGUgY29udmVyc2F0aW9uIGFuZCBhdXRvLXJldHJ5LiAoIzI4NzQpXG5cdFx0XHRpZiAoXG5cdFx0XHRcdG1zZy5zdG9wUmVhc29uID09PSBcImVycm9yXCIgJiZcblx0XHRcdFx0aXNJbWFnZURpbWVuc2lvbkVycm9yKG1zZy5lcnJvck1lc3NhZ2UpXG5cdFx0XHQpIHtcblx0XHRcdFx0Y29uc3QgbWVzc2FnZXMgPSB0aGlzLmFnZW50LnN0YXRlLm1lc3NhZ2VzO1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBkb3duc2l6ZUNvbnZlcnNhdGlvbkltYWdlcyhtZXNzYWdlcyBhcyBNZXNzYWdlW10pO1xuXHRcdFx0XHRpZiAocmVzdWx0LnByb2Nlc3NlZCkge1xuXHRcdFx0XHRcdC8vIFJlbW92ZSB0aGUgdHJhaWxpbmcgZXJyb3IgYXNzaXN0YW50IG1lc3NhZ2UsIHRoZW4gcmVwbGFjZVxuXHRcdFx0XHRcdGlmIChtZXNzYWdlcy5sZW5ndGggPiAwICYmIG1lc3NhZ2VzW21lc3NhZ2VzLmxlbmd0aCAtIDFdLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcblx0XHRcdFx0XHRcdHRoaXMuYWdlbnQucmVwbGFjZU1lc3NhZ2VzKG1lc3NhZ2VzLnNsaWNlKDAsIC0xKSk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0dGhpcy5fZW1pdCh7XG5cdFx0XHRcdFx0XHR0eXBlOiBcImltYWdlX292ZXJmbG93X3JlY292ZXJ5XCIsXG5cdFx0XHRcdFx0XHRzdHJpcHBlZENvdW50OiByZXN1bHQuc3RyaXBwZWRDb3VudCxcblx0XHRcdFx0XHRcdGltYWdlQ291bnQ6IHJlc3VsdC5pbWFnZUNvdW50LFxuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0Ly8gQXV0by1yZXRyeSBhZnRlciBkb3duc2l6aW5nXG5cdFx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0XHR0aGlzLmFnZW50LmNvbnRpbnVlKCkuY2F0Y2goKCkgPT4ge30pO1xuXHRcdFx0XHRcdH0sIDApO1xuXHRcdFx0XHRcdHJldHVybjtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRhd2FpdCB0aGlzLl9jb21wYWN0aW9uT3JjaGVzdHJhdG9yLmNoZWNrQ29tcGFjdGlvbihtc2cpO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBJbnN0YWxsIGJlZm9yZVRvb2xDYWxsL2FmdGVyVG9vbENhbGwgaG9va3Mgb24gdGhlIEFnZW50LlxuXHQgKlxuXHQgKiBUaGVzZSBob29rcyBhd2FpdCBgX2FnZW50RXZlbnRRdWV1ZWAgYmVmb3JlIGVtaXR0aW5nIGV4dGVuc2lvbiBldmVudHMsXG5cdCAqIGVuc3VyaW5nIHRoYXQgYWxsIHByaW9yIGV2ZW50cyAoaW5jbHVkaW5nIGBtZXNzYWdlX2VuZGAgd2hpY2ggYXBwZW5kc1xuXHQgKiB0aGUgYXNzaXN0YW50IG1lc3NhZ2UpIGhhdmUgZnVsbHkgc2V0dGxlZC4gVGhpcyBwcmV2ZW50cyBhIHJhY2UgY29uZGl0aW9uXG5cdCAqIGluIHBhcmFsbGVsIHRvb2wgZXhlY3V0aW9uIHdoZXJlIGV4dGVuc2lvbiBgdG9vbF9jYWxsYCBoYW5kbGVycyBjb3VsZFxuXHQgKiBzZWUgc3RhbGUgYWdlbnQgc3RhdGUuXG5cdCAqL1xuXHRwcml2YXRlIF9pbnN0YWxsQWdlbnRUb29sSG9va3MoKTogdm9pZCB7XG5cdFx0dGhpcy5hZ2VudC5zZXRCZWZvcmVUb29sQ2FsbChhc3luYyAoeyB0b29sQ2FsbCwgYXJncyB9KSA9PiB7XG5cdFx0XHQvLyBXYWl0IGZvciBhbGwgcXVldWVkIGFnZW50IGV2ZW50cyB0byBzZXR0bGUgYmVmb3JlIGVtaXR0aW5nIHRvIGV4dGVuc2lvbnNcblx0XHRcdGF3YWl0IHRoaXMuX2FnZW50RXZlbnRRdWV1ZTtcblxuXHRcdFx0aWYgKCF0aGlzLl9leHRlbnNpb25SdW5uZXI/Lmhhc0hhbmRsZXJzKFwidG9vbF9jYWxsXCIpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBjYWxsUmVzdWx0ID0gYXdhaXQgdGhpcy5fZXh0ZW5zaW9uUnVubmVyLmVtaXRUb29sQ2FsbCh7XG5cdFx0XHRcdFx0dHlwZTogXCJ0b29sX2NhbGxcIixcblx0XHRcdFx0XHR0b29sTmFtZTogdG9vbENhbGwubmFtZSxcblx0XHRcdFx0XHR0b29sQ2FsbElkOiB0b29sQ2FsbC5pZCxcblx0XHRcdFx0XHRpbnB1dDogYXJncyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcblx0XHRcdFx0fSk7XG5cblx0XHRcdFx0aWYgKGNhbGxSZXN1bHQ/LmJsb2NrKSB7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGJsb2NrOiB0cnVlLFxuXHRcdFx0XHRcdFx0cmVhc29uOiBjYWxsUmVzdWx0LnJlYXNvbiB8fCBcIlRvb2wgZXhlY3V0aW9uIHdhcyBibG9ja2VkIGJ5IGFuIGV4dGVuc2lvblwiLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRyZXR1cm4geyBibG9jazogdHJ1ZSwgcmVhc29uOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogYEV4dGVuc2lvbiBmYWlsZWQsIGJsb2NraW5nIGV4ZWN1dGlvbjogJHtTdHJpbmcoZXJyKX1gIH07XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiB1bmRlZmluZWQ7XG5cdFx0fSk7XG5cblx0XHR0aGlzLmFnZW50LnNldEFmdGVyVG9vbENhbGwoYXN5bmMgKHsgdG9vbENhbGwsIGFyZ3MsIHJlc3VsdCwgaXNFcnJvciB9KSA9PiB7XG5cdFx0XHQvLyBXYWl0IGZvciBhbGwgcXVldWVkIGFnZW50IGV2ZW50cyB0byBzZXR0bGVcblx0XHRcdGF3YWl0IHRoaXMuX2FnZW50RXZlbnRRdWV1ZTtcblxuXHRcdFx0aWYgKCF0aGlzLl9leHRlbnNpb25SdW5uZXI/Lmhhc0hhbmRsZXJzKFwidG9vbF9yZXN1bHRcIikpIHJldHVybiB1bmRlZmluZWQ7XG5cblx0XHRcdGNvbnN0IHJlc3VsdFJlc3VsdCA9IGF3YWl0IHRoaXMuX2V4dGVuc2lvblJ1bm5lci5lbWl0VG9vbFJlc3VsdCh7XG5cdFx0XHRcdHR5cGU6IFwidG9vbF9yZXN1bHRcIixcblx0XHRcdFx0dG9vbE5hbWU6IHRvb2xDYWxsLm5hbWUsXG5cdFx0XHRcdHRvb2xDYWxsSWQ6IHRvb2xDYWxsLmlkLFxuXHRcdFx0XHRpbnB1dDogYXJncyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcblx0XHRcdFx0Y29udGVudDogcmVzdWx0LmNvbnRlbnQsXG5cdFx0XHRcdGRldGFpbHM6IHJlc3VsdC5kZXRhaWxzLFxuXHRcdFx0XHRpc0Vycm9yLFxuXHRcdFx0fSk7XG5cblx0XHRcdGlmIChyZXN1bHRSZXN1bHQpIHtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiByZXN1bHRSZXN1bHQuY29udGVudCA/PyB1bmRlZmluZWQsXG5cdFx0XHRcdFx0ZGV0YWlsczogcmVzdWx0UmVzdWx0LmRldGFpbHMgPz8gdW5kZWZpbmVkLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHRcdH0pO1xuXHR9XG5cblx0LyoqIEV4dHJhY3QgdGV4dCBjb250ZW50IGZyb20gYSBtZXNzYWdlICovXG5cdHByaXZhdGUgX2dldFVzZXJNZXNzYWdlVGV4dChtZXNzYWdlOiBNZXNzYWdlKTogc3RyaW5nIHtcblx0XHRpZiAobWVzc2FnZS5yb2xlICE9PSBcInVzZXJcIikgcmV0dXJuIFwiXCI7XG5cdFx0Y29uc3QgY29udGVudCA9IG1lc3NhZ2UuY29udGVudDtcblx0XHRpZiAodHlwZW9mIGNvbnRlbnQgPT09IFwic3RyaW5nXCIpIHJldHVybiBjb250ZW50O1xuXHRcdGNvbnN0IHRleHRCbG9ja3MgPSBjb250ZW50LmZpbHRlcigoYykgPT4gYy50eXBlID09PSBcInRleHRcIik7XG5cdFx0cmV0dXJuIHRleHRCbG9ja3MubWFwKChjKSA9PiAoYyBhcyBUZXh0Q29udGVudCkudGV4dCkuam9pbihcIlwiKTtcblx0fVxuXG5cdC8qKiBGaW5kIHRoZSBsYXN0IGFzc2lzdGFudCBtZXNzYWdlIGluIGFnZW50IHN0YXRlIChpbmNsdWRpbmcgYWJvcnRlZCBvbmVzKSAqL1xuXHRwcml2YXRlIF9maW5kTGFzdEFzc2lzdGFudE1lc3NhZ2UoKTogQXNzaXN0YW50TWVzc2FnZSB8IHVuZGVmaW5lZCB7XG5cdFx0Y29uc3QgbWVzc2FnZXMgPSB0aGlzLmFnZW50LnN0YXRlLm1lc3NhZ2VzO1xuXHRcdGZvciAobGV0IGkgPSBtZXNzYWdlcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuXHRcdFx0Y29uc3QgbXNnID0gbWVzc2FnZXNbaV07XG5cdFx0XHRpZiAobXNnLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcblx0XHRcdFx0cmV0dXJuIG1zZyBhcyBBc3Npc3RhbnRNZXNzYWdlO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRyZXR1cm4gdW5kZWZpbmVkO1xuXHR9XG5cblx0LyoqIEVtaXQgZXh0ZW5zaW9uIGV2ZW50cyBiYXNlZCBvbiBhZ2VudCBldmVudHMgKi9cblx0cHJpdmF0ZSBhc3luYyBfZW1pdEV4dGVuc2lvbkV2ZW50KGV2ZW50OiBBZ2VudEV2ZW50KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgZXh0ZW5zaW9uUnVubmVyID0gdGhpcy5fZXh0ZW5zaW9uUnVubmVyO1xuXHRcdGlmICghZXh0ZW5zaW9uUnVubmVyKSByZXR1cm47XG5cblx0XHRpZiAoZXZlbnQudHlwZSA9PT0gXCJhZ2VudF9zdGFydFwiKSB7XG5cdFx0XHR0aGlzLl90dXJuSW5kZXggPSAwO1xuXHRcdFx0YXdhaXQgZXh0ZW5zaW9uUnVubmVyLmVtaXQoe1xuXHRcdFx0XHR0eXBlOiBcImFnZW50X3N0YXJ0XCIsXG5cdFx0XHRcdHNlc3Npb25JZDogZXZlbnQuc2Vzc2lvbklkLFxuXHRcdFx0XHR0dXJuSWQ6IGV2ZW50LnR1cm5JZCxcblx0XHRcdH0pO1xuXHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJhZ2VudF9lbmRcIikge1xuXHRcdFx0dGhpcy5fcHJvY2Vzc2luZ0FnZW50RW5kID0gdHJ1ZTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGF3YWl0IGV4dGVuc2lvblJ1bm5lci5lbWl0KHtcblx0XHRcdFx0XHR0eXBlOiBcImFnZW50X2VuZFwiLFxuXHRcdFx0XHRcdG1lc3NhZ2VzOiBldmVudC5tZXNzYWdlcyxcblx0XHRcdFx0XHRzZXNzaW9uSWQ6IGV2ZW50LnNlc3Npb25JZCxcblx0XHRcdFx0XHR0dXJuSWQ6IGV2ZW50LnR1cm5JZCxcblx0XHRcdFx0XHRhYm9ydE9yaWdpbjogZXZlbnQuYWJvcnRPcmlnaW4sXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHQvLyBgc3RvcGAgZmlyZXMgb24gdHJ1ZSBxdWllc2NlbmNlOiB0aGUgYWdlbnQgY2xlYW5seSBjb21wbGV0ZWQgYW5kIGlzIG5vd1xuXHRcdFx0XHQvLyB3YWl0aW5nIGZvciB0aGUgdXNlci4gVXNlIHRoZSBsYXN0IGFzc2lzdGFudCBtZXNzYWdlJ3Mgc3RvcFJlYXNvbiB0b1xuXHRcdFx0XHQvLyBkaXN0aW5ndWlzaCBjbGVhbiBjb21wbGV0aW9uIGZyb20gZXJyb3IvY2FuY2VsbGF0aW9uLlxuXHRcdFx0XHRjb25zdCBsYXN0ID0gZXZlbnQubWVzc2FnZXNbZXZlbnQubWVzc2FnZXMubGVuZ3RoIC0gMV07XG5cdFx0XHRcdGNvbnN0IHN0b3BSZWFzb246IFwiY29tcGxldGVkXCIgfCBcImNhbmNlbGxlZFwiIHwgXCJlcnJvclwiIHwgXCJibG9ja2VkXCIgPVxuXHRcdFx0XHRcdGxhc3Q/LnJvbGUgPT09IFwiYXNzaXN0YW50XCJcblx0XHRcdFx0XHRcdD8gbGFzdC5zdG9wUmVhc29uID09PSBcImFib3J0ZWRcIlxuXHRcdFx0XHRcdFx0XHQ/IFwiY2FuY2VsbGVkXCJcblx0XHRcdFx0XHRcdFx0OiBsYXN0LnN0b3BSZWFzb24gPT09IFwiZXJyb3JcIlxuXHRcdFx0XHRcdFx0XHRcdD8gXCJlcnJvclwiXG5cdFx0XHRcdFx0XHRcdFx0OiBcImNvbXBsZXRlZFwiXG5cdFx0XHRcdFx0XHQ6IFwiY29tcGxldGVkXCI7XG5cdFx0XHRcdGF3YWl0IGV4dGVuc2lvblJ1bm5lci5lbWl0U3RvcCh7XG5cdFx0XHRcdFx0cmVhc29uOiBzdG9wUmVhc29uLFxuXHRcdFx0XHRcdGxhc3RNZXNzYWdlOiBsYXN0LFxuXHRcdFx0XHRcdHNlc3Npb25JZDogZXZlbnQuc2Vzc2lvbklkLFxuXHRcdFx0XHRcdHR1cm5JZDogZXZlbnQudHVybklkLFxuXHRcdFx0XHRcdGFib3J0T3JpZ2luOiBldmVudC5hYm9ydE9yaWdpbixcblx0XHRcdFx0fSk7XG5cdFx0XHR9IGZpbmFsbHkge1xuXHRcdFx0XHR0aGlzLl9wcm9jZXNzaW5nQWdlbnRFbmQgPSBmYWxzZTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKGV2ZW50LnR5cGUgPT09IFwidHVybl9zdGFydFwiKSB7XG5cdFx0XHRjb25zdCBleHRlbnNpb25FdmVudDogVHVyblN0YXJ0RXZlbnQgPSB7XG5cdFx0XHRcdHR5cGU6IFwidHVybl9zdGFydFwiLFxuXHRcdFx0XHR0dXJuSW5kZXg6IHRoaXMuX3R1cm5JbmRleCxcblx0XHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdFx0XHRzZXNzaW9uSWQ6IGV2ZW50LnNlc3Npb25JZCxcblx0XHRcdFx0dHVybklkOiBldmVudC50dXJuSWQsXG5cdFx0XHR9O1xuXHRcdFx0YXdhaXQgZXh0ZW5zaW9uUnVubmVyLmVtaXQoZXh0ZW5zaW9uRXZlbnQpO1xuXHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJ0dXJuX2VuZFwiKSB7XG5cdFx0XHRjb25zdCBleHRlbnNpb25FdmVudDogVHVybkVuZEV2ZW50ID0ge1xuXHRcdFx0XHR0eXBlOiBcInR1cm5fZW5kXCIsXG5cdFx0XHRcdHR1cm5JbmRleDogdGhpcy5fdHVybkluZGV4LFxuXHRcdFx0XHRtZXNzYWdlOiBldmVudC5tZXNzYWdlLFxuXHRcdFx0XHR0b29sUmVzdWx0czogZXZlbnQudG9vbFJlc3VsdHMsXG5cdFx0XHRcdHNlc3Npb25JZDogZXZlbnQuc2Vzc2lvbklkLFxuXHRcdFx0XHR0dXJuSWQ6IGV2ZW50LnR1cm5JZCxcblx0XHRcdH07XG5cdFx0XHRhd2FpdCBleHRlbnNpb25SdW5uZXIuZW1pdChleHRlbnNpb25FdmVudCk7XG5cdFx0XHR0aGlzLl90dXJuSW5kZXgrKztcblx0XHR9IGVsc2UgaWYgKGV2ZW50LnR5cGUgPT09IFwibWVzc2FnZV9zdGFydFwiKSB7XG5cdFx0XHRjb25zdCBleHRlbnNpb25FdmVudDogTWVzc2FnZVN0YXJ0RXZlbnQgPSB7XG5cdFx0XHRcdHR5cGU6IFwibWVzc2FnZV9zdGFydFwiLFxuXHRcdFx0XHRtZXNzYWdlOiBldmVudC5tZXNzYWdlLFxuXHRcdFx0XHRzZXNzaW9uSWQ6IGV2ZW50LnNlc3Npb25JZCxcblx0XHRcdFx0dHVybklkOiBldmVudC50dXJuSWQsXG5cdFx0XHR9O1xuXHRcdFx0YXdhaXQgZXh0ZW5zaW9uUnVubmVyLmVtaXQoZXh0ZW5zaW9uRXZlbnQpO1xuXHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJtZXNzYWdlX3VwZGF0ZVwiKSB7XG5cdFx0XHRjb25zdCBleHRlbnNpb25FdmVudDogTWVzc2FnZVVwZGF0ZUV2ZW50ID0ge1xuXHRcdFx0XHR0eXBlOiBcIm1lc3NhZ2VfdXBkYXRlXCIsXG5cdFx0XHRcdG1lc3NhZ2U6IGV2ZW50Lm1lc3NhZ2UsXG5cdFx0XHRcdGFzc2lzdGFudE1lc3NhZ2VFdmVudDogZXZlbnQuYXNzaXN0YW50TWVzc2FnZUV2ZW50LFxuXHRcdFx0XHRzZXNzaW9uSWQ6IGV2ZW50LnNlc3Npb25JZCxcblx0XHRcdFx0dHVybklkOiBldmVudC50dXJuSWQsXG5cdFx0XHR9O1xuXHRcdFx0YXdhaXQgZXh0ZW5zaW9uUnVubmVyLmVtaXQoZXh0ZW5zaW9uRXZlbnQpO1xuXHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJtZXNzYWdlX2VuZFwiKSB7XG5cdFx0XHRjb25zdCBleHRlbnNpb25FdmVudDogTWVzc2FnZUVuZEV2ZW50ID0ge1xuXHRcdFx0XHR0eXBlOiBcIm1lc3NhZ2VfZW5kXCIsXG5cdFx0XHRcdG1lc3NhZ2U6IGV2ZW50Lm1lc3NhZ2UsXG5cdFx0XHRcdHNlc3Npb25JZDogZXZlbnQuc2Vzc2lvbklkLFxuXHRcdFx0XHR0dXJuSWQ6IGV2ZW50LnR1cm5JZCxcblx0XHRcdH07XG5cdFx0XHRhd2FpdCBleHRlbnNpb25SdW5uZXIuZW1pdChleHRlbnNpb25FdmVudCk7XG5cdFx0fSBlbHNlIGlmIChldmVudC50eXBlID09PSBcInRvb2xfZXhlY3V0aW9uX3N0YXJ0XCIpIHtcblx0XHRcdGNvbnN0IGV4dGVuc2lvbkV2ZW50OiBUb29sRXhlY3V0aW9uU3RhcnRFdmVudCA9IHtcblx0XHRcdFx0dHlwZTogXCJ0b29sX2V4ZWN1dGlvbl9zdGFydFwiLFxuXHRcdFx0XHR0b29sQ2FsbElkOiBldmVudC50b29sQ2FsbElkLFxuXHRcdFx0XHR0b29sTmFtZTogZXZlbnQudG9vbE5hbWUsXG5cdFx0XHRcdGFyZ3M6IGV2ZW50LmFyZ3MsXG5cdFx0XHR9O1xuXHRcdFx0YXdhaXQgZXh0ZW5zaW9uUnVubmVyLmVtaXQoZXh0ZW5zaW9uRXZlbnQpO1xuXHRcdH0gZWxzZSBpZiAoZXZlbnQudHlwZSA9PT0gXCJ0b29sX2V4ZWN1dGlvbl91cGRhdGVcIikge1xuXHRcdFx0Y29uc3QgZXh0ZW5zaW9uRXZlbnQ6IFRvb2xFeGVjdXRpb25VcGRhdGVFdmVudCA9IHtcblx0XHRcdFx0dHlwZTogXCJ0b29sX2V4ZWN1dGlvbl91cGRhdGVcIixcblx0XHRcdFx0dG9vbENhbGxJZDogZXZlbnQudG9vbENhbGxJZCxcblx0XHRcdFx0dG9vbE5hbWU6IGV2ZW50LnRvb2xOYW1lLFxuXHRcdFx0XHRhcmdzOiBldmVudC5hcmdzLFxuXHRcdFx0XHRwYXJ0aWFsUmVzdWx0OiBldmVudC5wYXJ0aWFsUmVzdWx0LFxuXHRcdFx0fTtcblx0XHRcdGF3YWl0IGV4dGVuc2lvblJ1bm5lci5lbWl0KGV4dGVuc2lvbkV2ZW50KTtcblx0XHR9IGVsc2UgaWYgKGV2ZW50LnR5cGUgPT09IFwidG9vbF9leGVjdXRpb25fZW5kXCIpIHtcblx0XHRcdGNvbnN0IGV4dGVuc2lvbkV2ZW50OiBUb29sRXhlY3V0aW9uRW5kRXZlbnQgPSB7XG5cdFx0XHRcdHR5cGU6IFwidG9vbF9leGVjdXRpb25fZW5kXCIsXG5cdFx0XHRcdHRvb2xDYWxsSWQ6IGV2ZW50LnRvb2xDYWxsSWQsXG5cdFx0XHRcdHRvb2xOYW1lOiBldmVudC50b29sTmFtZSxcblx0XHRcdFx0cmVzdWx0OiBldmVudC5yZXN1bHQsXG5cdFx0XHRcdGlzRXJyb3I6IGV2ZW50LmlzRXJyb3IsXG5cdFx0XHR9O1xuXHRcdFx0YXdhaXQgZXh0ZW5zaW9uUnVubmVyLmVtaXQoZXh0ZW5zaW9uRXZlbnQpO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBTdWJzY3JpYmUgdG8gYWdlbnQgZXZlbnRzLlxuXHQgKiBTZXNzaW9uIHBlcnNpc3RlbmNlIGlzIGhhbmRsZWQgaW50ZXJuYWxseSAoc2F2ZXMgbWVzc2FnZXMgb24gbWVzc2FnZV9lbmQpLlxuXHQgKiBNdWx0aXBsZSBsaXN0ZW5lcnMgY2FuIGJlIGFkZGVkLiBSZXR1cm5zIHVuc3Vic2NyaWJlIGZ1bmN0aW9uIGZvciB0aGlzIGxpc3RlbmVyLlxuXHQgKi9cblx0c3Vic2NyaWJlKGxpc3RlbmVyOiBBZ2VudFNlc3Npb25FdmVudExpc3RlbmVyKTogKCkgPT4gdm9pZCB7XG5cdFx0dGhpcy5fZXZlbnRMaXN0ZW5lcnMucHVzaChsaXN0ZW5lcik7XG5cblx0XHQvLyBSZXR1cm4gdW5zdWJzY3JpYmUgZnVuY3Rpb24gZm9yIHRoaXMgc3BlY2lmaWMgbGlzdGVuZXJcblx0XHRyZXR1cm4gKCkgPT4ge1xuXHRcdFx0Y29uc3QgaW5kZXggPSB0aGlzLl9ldmVudExpc3RlbmVycy5pbmRleE9mKGxpc3RlbmVyKTtcblx0XHRcdGlmIChpbmRleCAhPT0gLTEpIHtcblx0XHRcdFx0dGhpcy5fZXZlbnRMaXN0ZW5lcnMuc3BsaWNlKGluZGV4LCAxKTtcblx0XHRcdH1cblx0XHR9O1xuXHR9XG5cblx0LyoqXG5cdCAqIFRlbXBvcmFyaWx5IGRpc2Nvbm5lY3QgZnJvbSBhZ2VudCBldmVudHMuXG5cdCAqIFVzZXIgbGlzdGVuZXJzIGFyZSBwcmVzZXJ2ZWQgYW5kIHdpbGwgcmVjZWl2ZSBldmVudHMgYWdhaW4gYWZ0ZXIgcmVzdWJzY3JpYmUoKS5cblx0ICogVXNlZCBpbnRlcm5hbGx5IGR1cmluZyBvcGVyYXRpb25zIHRoYXQgbmVlZCB0byBwYXVzZSBldmVudCBwcm9jZXNzaW5nLlxuXHQgKi9cblx0cHJpdmF0ZSBfZGlzY29ubmVjdEZyb21BZ2VudCgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5fdW5zdWJzY3JpYmVBZ2VudCkge1xuXHRcdFx0dGhpcy5fdW5zdWJzY3JpYmVBZ2VudCgpO1xuXHRcdFx0dGhpcy5fdW5zdWJzY3JpYmVBZ2VudCA9IHVuZGVmaW5lZDtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogUmVjb25uZWN0IHRvIGFnZW50IGV2ZW50cyBhZnRlciBfZGlzY29ubmVjdEZyb21BZ2VudCgpLlxuXHQgKiBQcmVzZXJ2ZXMgYWxsIGV4aXN0aW5nIGxpc3RlbmVycy5cblx0ICovXG5cdHByaXZhdGUgX3JlY29ubmVjdFRvQWdlbnQoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuX3Vuc3Vic2NyaWJlQWdlbnQpIHJldHVybjsgLy8gQWxyZWFkeSBjb25uZWN0ZWRcblx0XHR0aGlzLl91bnN1YnNjcmliZUFnZW50ID0gdGhpcy5hZ2VudC5zdWJzY3JpYmUodGhpcy5faGFuZGxlQWdlbnRFdmVudCk7XG5cdH1cblxuXHQvKipcblx0ICogUmVtb3ZlIGFsbCBsaXN0ZW5lcnMgYW5kIGRpc2Nvbm5lY3QgZnJvbSBhZ2VudC5cblx0ICogQ2FsbCB0aGlzIHdoZW4gY29tcGxldGVseSBkb25lIHdpdGggdGhlIHNlc3Npb24uXG5cdCAqL1xuXHRkaXNwb3NlKCk6IHZvaWQge1xuXHRcdHRoaXMuX2V4dGVuc2lvbkVycm9yVW5zdWJzY3JpYmVyPy4oKTtcblx0XHR0aGlzLl9leHRlbnNpb25FcnJvclVuc3Vic2NyaWJlciA9IHVuZGVmaW5lZDtcblx0XHR0aGlzLl9kaXNjb25uZWN0RnJvbUFnZW50KCk7XG5cdFx0dGhpcy5fZXZlbnRMaXN0ZW5lcnMgPSBbXTtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gUmVhZC1vbmx5IFN0YXRlIEFjY2Vzc1xuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqIEZ1bGwgYWdlbnQgc3RhdGUgKi9cblx0Z2V0IHN0YXRlKCk6IEFnZW50U3RhdGUge1xuXHRcdHJldHVybiB0aGlzLmFnZW50LnN0YXRlO1xuXHR9XG5cblx0LyoqIEN1cnJlbnQgbW9kZWwgKG1heSBiZSB1bmRlZmluZWQgaWYgbm90IHlldCBzZWxlY3RlZCkgKi9cblx0Z2V0IG1vZGVsKCk6IE1vZGVsPGFueT4gfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLmFnZW50LnN0YXRlLm1vZGVsO1xuXHR9XG5cblx0LyoqIEN1cnJlbnQgdGhpbmtpbmcgbGV2ZWwgKi9cblx0Z2V0IHRoaW5raW5nTGV2ZWwoKTogVGhpbmtpbmdMZXZlbCB7XG5cdFx0cmV0dXJuIHRoaXMuYWdlbnQuc3RhdGUudGhpbmtpbmdMZXZlbDtcblx0fVxuXG5cdC8qKiBXaGV0aGVyIGFnZW50IGlzIGN1cnJlbnRseSBzdHJlYW1pbmcgYSByZXNwb25zZSAqL1xuXHRnZXQgaXNTdHJlYW1pbmcoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuYWdlbnQuc3RhdGUuaXNTdHJlYW1pbmc7XG5cdH1cblxuXHQvKiogQ3VycmVudCBlZmZlY3RpdmUgc3lzdGVtIHByb21wdCAoaW5jbHVkZXMgYW55IHBlci10dXJuIGV4dGVuc2lvbiBtb2RpZmljYXRpb25zKSAqL1xuXHRnZXQgc3lzdGVtUHJvbXB0KCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIHRoaXMuYWdlbnQuc3RhdGUuc3lzdGVtUHJvbXB0O1xuXHR9XG5cblx0LyoqIEN1cnJlbnQgcmV0cnkgYXR0ZW1wdCAoMCBpZiBub3QgcmV0cnlpbmcpICovXG5cdGdldCByZXRyeUF0dGVtcHQoKTogbnVtYmVyIHtcblx0XHRyZXR1cm4gdGhpcy5fcmV0cnlIYW5kbGVyLnJldHJ5QXR0ZW1wdDtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgdGhlIG5hbWVzIG9mIGN1cnJlbnRseSBhY3RpdmUgdG9vbHMuXG5cdCAqIFJldHVybnMgdGhlIG5hbWVzIG9mIHRvb2xzIGN1cnJlbnRseSBzZXQgb24gdGhlIGFnZW50LlxuXHQgKi9cblx0Z2V0QWN0aXZlVG9vbE5hbWVzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gdGhpcy5hZ2VudC5zdGF0ZS50b29scy5tYXAoKHQpID0+IHQubmFtZSk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGFsbCBjb25maWd1cmVkIHRvb2xzIHdpdGggbmFtZSwgZGVzY3JpcHRpb24sIGFuZCBwYXJhbWV0ZXIgc2NoZW1hLlxuXHQgKi9cblx0Z2V0QWxsVG9vbHMoKTogVG9vbEluZm9bXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5fdG9vbFJlZ2lzdHJ5LnZhbHVlcygpKS5tYXAoKHQpID0+ICh7XG5cdFx0XHRuYW1lOiB0Lm5hbWUsXG5cdFx0XHRkZXNjcmlwdGlvbjogdC5kZXNjcmlwdGlvbixcblx0XHRcdHBhcmFtZXRlcnM6IHQucGFyYW1ldGVycyxcblx0XHR9KSk7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGFjdGl2ZSB0b29scyBieSBuYW1lLlxuXHQgKiBPbmx5IHRvb2xzIGluIHRoZSByZWdpc3RyeSBjYW4gYmUgZW5hYmxlZC4gVW5rbm93biB0b29sIG5hbWVzIGFyZSBpZ25vcmVkLlxuXHQgKiBBbHNvIHJlYnVpbGRzIHRoZSBzeXN0ZW0gcHJvbXB0IHRvIHJlZmxlY3QgdGhlIG5ldyB0b29sIHNldC5cblx0ICogQ2hhbmdlcyB0YWtlIGVmZmVjdCBvbiB0aGUgbmV4dCBhZ2VudCB0dXJuLlxuXHQgKi9cblx0c2V0QWN0aXZlVG9vbHNCeU5hbWUodG9vbE5hbWVzOiBzdHJpbmdbXSk6IHZvaWQge1xuXHRcdGNvbnN0IHJlcXVlc3RlZFRvb2xOYW1lcyA9IFsuLi5uZXcgU2V0KFsuLi50b29sTmFtZXMsIC4uLnRoaXMuX2dldEJ1aWx0aW5Ub29sTmFtZXMoKV0pXTtcblx0XHRjb25zdCB0b29sczogQWdlbnRUb29sW10gPSBbXTtcblx0XHRjb25zdCB2YWxpZFRvb2xOYW1lczogc3RyaW5nW10gPSBbXTtcblx0XHRmb3IgKGNvbnN0IG5hbWUgb2YgcmVxdWVzdGVkVG9vbE5hbWVzKSB7XG5cdFx0XHRjb25zdCB0b29sID0gdGhpcy5fdG9vbFJlZ2lzdHJ5LmdldChuYW1lKTtcblx0XHRcdGlmICh0b29sKSB7XG5cdFx0XHRcdHRvb2xzLnB1c2godG9vbCk7XG5cdFx0XHRcdHZhbGlkVG9vbE5hbWVzLnB1c2gobmFtZSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdHRoaXMuYWdlbnQuc2V0VG9vbHModG9vbHMpO1xuXG5cblx0XHQvLyBSZWJ1aWxkIGJhc2Ugc3lzdGVtIHByb21wdCB3aXRoIG5ldyB0b29sIHNldFxuXHRcdHRoaXMuX2Jhc2VTeXN0ZW1Qcm9tcHQgPSB0aGlzLl9yZWJ1aWxkU3lzdGVtUHJvbXB0KHZhbGlkVG9vbE5hbWVzKTtcblx0XHR0aGlzLmFnZW50LnNldFN5c3RlbVByb21wdCh0aGlzLl9iYXNlU3lzdGVtUHJvbXB0KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgb3IgY2xlYXIgYSBwcm9tcHQtb25seSBmaWx0ZXIgZm9yIHRoZSA8YXZhaWxhYmxlX3NraWxscz4gY2F0YWxvZy5cblx0ICpcblx0ICogVGhpcyBkb2VzIG5vdCB1bmxvYWQgc2tpbGxzIG9yIGRpc2FibGUgdGhlIFNraWxsIHRvb2wuIEl0IG9ubHkgY29udHJvbHNcblx0ICogd2hpY2ggbG9hZGVkIHNraWxscyBhcmUgYWR2ZXJ0aXNlZCBpbiB0aGUgc3lzdGVtIHByb21wdCBvbiByZWJ1aWxkLlxuXHQgKi9cblx0c2V0VmlzaWJsZVNraWxsc0J5TmFtZShza2lsbE5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHZvaWQge1xuXHRcdHRoaXMuX3Zpc2libGVTa2lsbE5hbWVzID0gc2tpbGxOYW1lcyA9PT0gdW5kZWZpbmVkXG5cdFx0XHQ/IHVuZGVmaW5lZFxuXHRcdFx0OiBuZXcgU2V0KHNraWxsTmFtZXMubWFwKChuYW1lKSA9PiBuYW1lLnRyaW0oKS50b0xvd2VyQ2FzZSgpKS5maWx0ZXIoQm9vbGVhbikpO1xuXHRcdHRoaXMuX2Jhc2VTeXN0ZW1Qcm9tcHQgPSB0aGlzLl9yZWJ1aWxkU3lzdGVtUHJvbXB0KHRoaXMuZ2V0QWN0aXZlVG9vbE5hbWVzKCkpO1xuXHRcdHRoaXMuYWdlbnQuc2V0U3lzdGVtUHJvbXB0KHRoaXMuX2Jhc2VTeXN0ZW1Qcm9tcHQpO1xuXHR9XG5cblx0LyoqIEdldCB0aGUgY3VycmVudCBwcm9tcHQtb25seSBza2lsbCBjYXRhbG9nIGZpbHRlciwgaWYgb25lIGlzIGFjdGl2ZS4gKi9cblx0Z2V0VmlzaWJsZVNraWxsTmFtZXMoKTogc3RyaW5nW10gfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLl92aXNpYmxlU2tpbGxOYW1lcyA/IFsuLi50aGlzLl92aXNpYmxlU2tpbGxOYW1lc10gOiB1bmRlZmluZWQ7XG5cdH1cblxuXHQvKiogV2hldGhlciBjb21wYWN0aW9uIG9yIGJyYW5jaCBzdW1tYXJpemF0aW9uIGlzIGN1cnJlbnRseSBydW5uaW5nICovXG5cdGdldCBpc0NvbXBhY3RpbmcoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IuaXNDb21wYWN0aW5nO1xuXHR9XG5cblx0LyoqXG5cdCAqIFN3aXRjaCBlZGl0IG1vZGUgYmV0d2VlbiBzdGFuZGFyZCAodGV4dC1tYXRjaCkgYW5kIGhhc2hsaW5lIChMSU5FI0lEIGFuY2hvcnMpLlxuXHQgKiBTd2FwcyB0aGUgYWN0aXZlIHJlYWQvZWRpdCB0b29scyBhbmQgcmVidWlsZHMgdGhlIHN5c3RlbSBwcm9tcHQuXG5cdCAqL1xuXHRzZXRFZGl0TW9kZShtb2RlOiBcInN0YW5kYXJkXCIgfCBcImhhc2hsaW5lXCIpOiB2b2lkIHtcblx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXRFZGl0TW9kZShtb2RlKTtcblxuXHRcdC8vIEdldCBjdXJyZW50IGFjdGl2ZSB0b29sIHJlZ2lzdHJ5IGtleXNcblx0XHRjb25zdCBjdXJyZW50S2V5cyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdGZvciAoY29uc3QgW2tleSwgdG9vbF0gb2YgdGhpcy5fdG9vbFJlZ2lzdHJ5LmVudHJpZXMoKSkge1xuXHRcdFx0aWYgKHRoaXMuYWdlbnQuc3RhdGUudG9vbHMuaW5jbHVkZXModG9vbCkpIHtcblx0XHRcdFx0Y3VycmVudEtleXMuYWRkKGtleSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gU3dhcCByZWFkIHRvb2xzXG5cdFx0aWYgKG1vZGUgPT09IFwiaGFzaGxpbmVcIikge1xuXHRcdFx0Y3VycmVudEtleXMuZGVsZXRlKFwicmVhZFwiKTtcblx0XHRcdGN1cnJlbnRLZXlzLmFkZChcImhhc2hsaW5lX3JlYWRcIik7XG5cdFx0XHRjdXJyZW50S2V5cy5kZWxldGUoXCJlZGl0XCIpO1xuXHRcdFx0Y3VycmVudEtleXMuYWRkKFwiaGFzaGxpbmVfZWRpdFwiKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y3VycmVudEtleXMuZGVsZXRlKFwiaGFzaGxpbmVfcmVhZFwiKTtcblx0XHRcdGN1cnJlbnRLZXlzLmFkZChcInJlYWRcIik7XG5cdFx0XHRjdXJyZW50S2V5cy5kZWxldGUoXCJoYXNobGluZV9lZGl0XCIpO1xuXHRcdFx0Y3VycmVudEtleXMuYWRkKFwiZWRpdFwiKTtcblx0XHR9XG5cblx0XHR0aGlzLnNldEFjdGl2ZVRvb2xzQnlOYW1lKFsuLi5jdXJyZW50S2V5c10pO1xuXHR9XG5cblx0LyoqIEN1cnJlbnQgZWRpdCBtb2RlICovXG5cdGdldCBlZGl0TW9kZSgpOiBcInN0YW5kYXJkXCIgfCBcImhhc2hsaW5lXCIge1xuXHRcdHJldHVybiB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRFZGl0TW9kZSgpO1xuXHR9XG5cblx0LyoqIEFsbCBtZXNzYWdlcyBpbmNsdWRpbmcgY3VzdG9tIHR5cGVzIGxpa2UgQmFzaEV4ZWN1dGlvbk1lc3NhZ2UgKi9cblx0Z2V0IG1lc3NhZ2VzKCk6IEFnZW50TWVzc2FnZVtdIHtcblx0XHRyZXR1cm4gdGhpcy5hZ2VudC5zdGF0ZS5tZXNzYWdlcztcblx0fVxuXG5cdC8qKiBDdXJyZW50IHN0ZWVyaW5nIG1vZGUgKi9cblx0Z2V0IHN0ZWVyaW5nTW9kZSgpOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCIge1xuXHRcdHJldHVybiB0aGlzLmFnZW50LmdldFN0ZWVyaW5nTW9kZSgpO1xuXHR9XG5cblx0LyoqIEN1cnJlbnQgZm9sbG93LXVwIG1vZGUgKi9cblx0Z2V0IGZvbGxvd1VwTW9kZSgpOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCIge1xuXHRcdHJldHVybiB0aGlzLmFnZW50LmdldEZvbGxvd1VwTW9kZSgpO1xuXHR9XG5cblx0LyoqIEN1cnJlbnQgc2Vzc2lvbiBmaWxlIHBhdGgsIG9yIHVuZGVmaW5lZCBpZiBzZXNzaW9ucyBhcmUgZGlzYWJsZWQgKi9cblx0Z2V0IHNlc3Npb25GaWxlKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMuc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbkZpbGUoKTtcblx0fVxuXG5cdC8qKiBDdXJyZW50IHNlc3Npb24gSUQgKi9cblx0Z2V0IHNlc3Npb25JZCgpOiBzdHJpbmcge1xuXHRcdHJldHVybiB0aGlzLnNlc3Npb25NYW5hZ2VyLmdldFNlc3Npb25JZCgpO1xuXHR9XG5cblx0LyoqIEN1cnJlbnQgc2Vzc2lvbiBkaXNwbGF5IG5hbWUsIGlmIHNldCAqL1xuXHRnZXQgc2Vzc2lvbk5hbWUoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5zZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uTmFtZSgpO1xuXHR9XG5cblx0LyoqIFNjb3BlZCBtb2RlbHMgZm9yIGN5Y2xpbmcgKGZyb20gLS1tb2RlbHMgZmxhZykgKi9cblx0Z2V0IHNjb3BlZE1vZGVscygpOiBSZWFkb25seUFycmF5PHsgbW9kZWw6IE1vZGVsPGFueT47IHRoaW5raW5nTGV2ZWw/OiBUaGlua2luZ0xldmVsIH0+IHtcblx0XHRyZXR1cm4gdGhpcy5fc2NvcGVkTW9kZWxzO1xuXHR9XG5cblx0LyoqIFVwZGF0ZSBzY29wZWQgbW9kZWxzIGZvciBjeWNsaW5nICovXG5cdHNldFNjb3BlZE1vZGVscyhzY29wZWRNb2RlbHM6IEFycmF5PHsgbW9kZWw6IE1vZGVsPGFueT47IHRoaW5raW5nTGV2ZWw/OiBUaGlua2luZ0xldmVsIH0+KTogdm9pZCB7XG5cdFx0dGhpcy5fc2NvcGVkTW9kZWxzID0gc2NvcGVkTW9kZWxzO1xuXHR9XG5cblx0LyoqIEZpbGUtYmFzZWQgcHJvbXB0IHRlbXBsYXRlcyAqL1xuXHRnZXQgcHJvbXB0VGVtcGxhdGVzKCk6IFJlYWRvbmx5QXJyYXk8UHJvbXB0VGVtcGxhdGU+IHtcblx0XHRyZXR1cm4gdGhpcy5fcmVzb3VyY2VMb2FkZXIuZ2V0UHJvbXB0cygpLnByb21wdHM7XG5cdH1cblxuXHRwcml2YXRlIF9ub3JtYWxpemVQcm9tcHRTbmlwcGV0KHRleHQ6IHN0cmluZyB8IHVuZGVmaW5lZCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0aWYgKCF0ZXh0KSByZXR1cm4gdW5kZWZpbmVkO1xuXHRcdGNvbnN0IG9uZUxpbmUgPSB0ZXh0XG5cdFx0XHQucmVwbGFjZSgvW1xcclxcbl0rL2csIFwiIFwiKVxuXHRcdFx0LnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG5cdFx0XHQudHJpbSgpO1xuXHRcdHJldHVybiBvbmVMaW5lLmxlbmd0aCA+IDAgPyBvbmVMaW5lIDogdW5kZWZpbmVkO1xuXHR9XG5cblx0cHJpdmF0ZSBfbm9ybWFsaXplUHJvbXB0R3VpZGVsaW5lcyhndWlkZWxpbmVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHN0cmluZ1tdIHtcblx0XHRpZiAoIWd1aWRlbGluZXMgfHwgZ3VpZGVsaW5lcy5sZW5ndGggPT09IDApIHtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cblx0XHRjb25zdCB1bmlxdWUgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRmb3IgKGNvbnN0IGd1aWRlbGluZSBvZiBndWlkZWxpbmVzKSB7XG5cdFx0XHRjb25zdCBub3JtYWxpemVkID0gZ3VpZGVsaW5lLnRyaW0oKTtcblx0XHRcdGlmIChub3JtYWxpemVkLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0dW5pcXVlLmFkZChub3JtYWxpemVkKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odW5pcXVlKTtcblx0fVxuXG5cdHByaXZhdGUgX2ZpbmRTa2lsbEJ5TmFtZShza2lsbE5hbWU6IHN0cmluZykge1xuXHRcdHJldHVybiB0aGlzLnJlc291cmNlTG9hZGVyLmdldFNraWxscygpLnNraWxscy5maW5kKChza2lsbCkgPT4gc2tpbGwubmFtZSA9PT0gc2tpbGxOYW1lKTtcblx0fVxuXG5cdHByaXZhdGUgX2Zvcm1hdE1pc3NpbmdTa2lsbE1lc3NhZ2Uoc2tpbGxOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdGNvbnN0IGF2YWlsYWJsZVNraWxscyA9IHRoaXMucmVzb3VyY2VMb2FkZXIuZ2V0U2tpbGxzKCkuc2tpbGxzLm1hcCgoc2tpbGwpID0+IHNraWxsLm5hbWUpLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwiO1xuXHRcdHJldHVybiBgU2tpbGwgXCIke3NraWxsTmFtZX1cIiBub3QgZm91bmQuIEF2YWlsYWJsZSBza2lsbHM6ICR7YXZhaWxhYmxlU2tpbGxzfWA7XG5cdH1cblxuXHRwcml2YXRlIF9lbWl0U2tpbGxFeHBhbnNpb25FcnJvcihza2lsbEZpbGVQYXRoOiBzdHJpbmcsIGVycjogdW5rbm93bik6IHZvaWQge1xuXHRcdHRoaXMuX2V4dGVuc2lvblJ1bm5lcj8uZW1pdEVycm9yKHtcblx0XHRcdGV4dGVuc2lvblBhdGg6IHNraWxsRmlsZVBhdGgsXG5cdFx0XHRldmVudDogXCJza2lsbF9leHBhbnNpb25cIixcblx0XHRcdGVycm9yOiBnZXRFcnJvck1lc3NhZ2UoZXJyKSxcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgX3JlbmRlclNraWxsSW52b2NhdGlvbihza2lsbDogeyBuYW1lOiBzdHJpbmc7IGZpbGVQYXRoOiBzdHJpbmc7IGJhc2VEaXI6IHN0cmluZyB9LCBhcmdzPzogc3RyaW5nKTogc3RyaW5nIHtcblx0XHRjb25zdCBjb250ZW50ID0gcmVhZEZpbGVTeW5jKHNraWxsLmZpbGVQYXRoLCBcInV0Zi04XCIpO1xuXHRcdGNvbnN0IGJvZHkgPSBzdHJpcEZyb250bWF0dGVyKGNvbnRlbnQpLnRyaW0oKTtcblx0XHRjb25zdCBza2lsbEJsb2NrID0gYDxza2lsbCBuYW1lPVwiJHtza2lsbC5uYW1lfVwiIGxvY2F0aW9uPVwiJHtza2lsbC5maWxlUGF0aH1cIj5cXG5SZWZlcmVuY2VzIGFyZSByZWxhdGl2ZSB0byAke3NraWxsLmJhc2VEaXJ9LlxcblxcbiR7Ym9keX1cXG48L3NraWxsPmA7XG5cdFx0cmV0dXJuIGFyZ3MgJiYgYXJncy50cmltKCkgPyBgJHtza2lsbEJsb2NrfVxcblxcbiR7YXJncy50cmltKCl9YCA6IHNraWxsQmxvY2s7XG5cdH1cblxuXHRwcml2YXRlIF9leHBhbmRTa2lsbEJ5TmFtZShza2lsbE5hbWU6IHN0cmluZywgYXJncz86IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3Qgc2tpbGwgPSB0aGlzLl9maW5kU2tpbGxCeU5hbWUoc2tpbGxOYW1lKTtcblx0XHRpZiAoIXNraWxsKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IodGhpcy5fZm9ybWF0TWlzc2luZ1NraWxsTWVzc2FnZShza2lsbE5hbWUpKTtcblx0XHR9XG5cblx0XHR0cnkge1xuXHRcdFx0cmV0dXJuIHRoaXMuX3JlbmRlclNraWxsSW52b2NhdGlvbihza2lsbCwgYXJncyk7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHR0aGlzLl9lbWl0U2tpbGxFeHBhbnNpb25FcnJvcihza2lsbC5maWxlUGF0aCwgZXJyKTtcblx0XHRcdHRocm93IGVycjtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIF9mb3JtYXRTa2lsbEludm9jYXRpb24oc2tpbGxOYW1lOiBzdHJpbmcsIGFyZ3M/OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdHJldHVybiB0aGlzLl9leHBhbmRTa2lsbEJ5TmFtZShza2lsbE5hbWUsIGFyZ3MpO1xuXHR9XG5cblx0cHJpdmF0ZSBfcmVidWlsZFN5c3RlbVByb21wdCh0b29sTmFtZXM6IHN0cmluZ1tdKTogc3RyaW5nIHtcblx0XHRjb25zdCB2YWxpZFRvb2xOYW1lcyA9IHRvb2xOYW1lcy5maWx0ZXIoKG5hbWUpID0+IHRoaXMuX3Rvb2xSZWdpc3RyeS5oYXMobmFtZSkpO1xuXHRcdGNvbnN0IHRvb2xTbmlwcGV0czogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuXHRcdGNvbnN0IHByb21wdEd1aWRlbGluZXM6IHN0cmluZ1tdID0gW107XG5cdFx0Zm9yIChjb25zdCBuYW1lIG9mIHZhbGlkVG9vbE5hbWVzKSB7XG5cdFx0XHRjb25zdCBzbmlwcGV0ID0gdGhpcy5fdG9vbFByb21wdFNuaXBwZXRzLmdldChuYW1lKTtcblx0XHRcdGlmIChzbmlwcGV0KSB7XG5cdFx0XHRcdHRvb2xTbmlwcGV0c1tuYW1lXSA9IHNuaXBwZXQ7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHRvb2xHdWlkZWxpbmVzID0gdGhpcy5fdG9vbFByb21wdEd1aWRlbGluZXMuZ2V0KG5hbWUpO1xuXHRcdFx0aWYgKHRvb2xHdWlkZWxpbmVzKSB7XG5cdFx0XHRcdHByb21wdEd1aWRlbGluZXMucHVzaCguLi50b29sR3VpZGVsaW5lcyk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Y29uc3QgbG9hZGVyU3lzdGVtUHJvbXB0ID0gdGhpcy5fcmVzb3VyY2VMb2FkZXIuZ2V0U3lzdGVtUHJvbXB0KCk7XG5cdFx0Y29uc3QgbG9hZGVyQXBwZW5kU3lzdGVtUHJvbXB0ID0gdGhpcy5fcmVzb3VyY2VMb2FkZXIuZ2V0QXBwZW5kU3lzdGVtUHJvbXB0KCk7XG5cdFx0Y29uc3QgYXBwZW5kU3lzdGVtUHJvbXB0ID1cblx0XHRcdGxvYWRlckFwcGVuZFN5c3RlbVByb21wdC5sZW5ndGggPiAwID8gbG9hZGVyQXBwZW5kU3lzdGVtUHJvbXB0LmpvaW4oXCJcXG5cXG5cIikgOiB1bmRlZmluZWQ7XG5cdFx0Y29uc3QgbG9hZGVkU2tpbGxzID0gdGhpcy5fcmVzb3VyY2VMb2FkZXIuZ2V0U2tpbGxzKCkuc2tpbGxzO1xuXHRcdGNvbnN0IGxvYWRlZENvbnRleHRGaWxlcyA9IHRoaXMuX3Jlc291cmNlTG9hZGVyLmdldEFnZW50c0ZpbGVzKCkuYWdlbnRzRmlsZXM7XG5cblx0XHRyZXR1cm4gYnVpbGRTeXN0ZW1Qcm9tcHQoe1xuXHRcdFx0Y3dkOiB0aGlzLl9jd2QsXG5cdFx0XHRza2lsbHM6IGxvYWRlZFNraWxscyxcblx0XHRcdHNraWxsRmlsdGVyOiB0aGlzLl92aXNpYmxlU2tpbGxOYW1lc1xuXHRcdFx0XHQ/IChza2lsbCkgPT4gdGhpcy5fdmlzaWJsZVNraWxsTmFtZXMhLmhhcyhza2lsbC5uYW1lLnRyaW0oKS50b0xvd2VyQ2FzZSgpKVxuXHRcdFx0XHQ6IHVuZGVmaW5lZCxcblx0XHRcdGNvbnRleHRGaWxlczogbG9hZGVkQ29udGV4dEZpbGVzLFxuXHRcdFx0Y3VzdG9tUHJvbXB0OiBsb2FkZXJTeXN0ZW1Qcm9tcHQsXG5cdFx0XHRhcHBlbmRTeXN0ZW1Qcm9tcHQsXG5cdFx0XHRzZWxlY3RlZFRvb2xzOiB2YWxpZFRvb2xOYW1lcyxcblx0XHRcdHRvb2xTbmlwcGV0cyxcblx0XHRcdHByb21wdEd1aWRlbGluZXMsXG5cdFx0fSk7XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIFByb21wdGluZ1xuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIFNlbmQgYSBwcm9tcHQgdG8gdGhlIGFnZW50LlxuXHQgKiAtIEhhbmRsZXMgZXh0ZW5zaW9uIGNvbW1hbmRzIChyZWdpc3RlcmVkIHZpYSBwaS5yZWdpc3RlckNvbW1hbmQpIGltbWVkaWF0ZWx5LCBldmVuIGR1cmluZyBzdHJlYW1pbmdcblx0ICogLSBFeHBhbmRzIGZpbGUtYmFzZWQgcHJvbXB0IHRlbXBsYXRlcyBieSBkZWZhdWx0XG5cdCAqIC0gRHVyaW5nIHN0cmVhbWluZywgcXVldWVzIHZpYSBzdGVlcigpIG9yIGZvbGxvd1VwKCkgYmFzZWQgb24gc3RyZWFtaW5nQmVoYXZpb3Igb3B0aW9uXG5cdCAqIC0gVmFsaWRhdGVzIG1vZGVsIGFuZCBBUEkga2V5IGJlZm9yZSBzZW5kaW5nICh3aGVuIG5vdCBzdHJlYW1pbmcpXG5cdCAqIEB0aHJvd3MgRXJyb3IgaWYgc3RyZWFtaW5nIGFuZCBubyBzdHJlYW1pbmdCZWhhdmlvciBzcGVjaWZpZWRcblx0ICogQHRocm93cyBFcnJvciBpZiBubyBtb2RlbCBzZWxlY3RlZCBvciBubyBBUEkga2V5IGF2YWlsYWJsZSAod2hlbiBub3Qgc3RyZWFtaW5nKVxuXHQgKi9cblx0YXN5bmMgcHJvbXB0KHRleHQ6IHN0cmluZywgb3B0aW9ucz86IFByb21wdE9wdGlvbnMpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBleHBhbmRQcm9tcHRUZW1wbGF0ZXMgPSBvcHRpb25zPy5leHBhbmRQcm9tcHRUZW1wbGF0ZXMgPz8gdHJ1ZTtcblxuXHRcdC8vIEhhbmRsZSBleHRlbnNpb24gY29tbWFuZHMgZmlyc3QgKGV4ZWN1dGUgaW1tZWRpYXRlbHksIGV2ZW4gZHVyaW5nIHN0cmVhbWluZylcblx0XHQvLyBFeHRlbnNpb24gY29tbWFuZHMgbWFuYWdlIHRoZWlyIG93biBMTE0gaW50ZXJhY3Rpb24gdmlhIHBpLnNlbmRNZXNzYWdlKClcblx0XHRpZiAoZXhwYW5kUHJvbXB0VGVtcGxhdGVzICYmIHRleHQuc3RhcnRzV2l0aChcIi9cIikpIHtcblx0XHRcdGNvbnN0IGhhbmRsZWQgPSBhd2FpdCB0aGlzLl90cnlFeGVjdXRlRXh0ZW5zaW9uQ29tbWFuZCh0ZXh0KTtcblx0XHRcdGlmIChoYW5kbGVkKSB7XG5cdFx0XHRcdC8vIEV4dGVuc2lvbiBjb21tYW5kIGV4ZWN1dGVkLCBubyBwcm9tcHQgdG8gc2VuZFxuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Ly8gRW1pdCBpbnB1dCBldmVudCBmb3IgZXh0ZW5zaW9uIGludGVyY2VwdGlvbiAoYmVmb3JlIHNraWxsL3RlbXBsYXRlIGV4cGFuc2lvbilcblx0XHRsZXQgY3VycmVudFRleHQgPSB0ZXh0O1xuXHRcdGxldCBjdXJyZW50SW1hZ2VzID0gb3B0aW9ucz8uaW1hZ2VzO1xuXHRcdGlmICh0aGlzLl9leHRlbnNpb25SdW5uZXI/Lmhhc0hhbmRsZXJzKFwiaW5wdXRcIikpIHtcblx0XHRcdGNvbnN0IGlucHV0UmVzdWx0ID0gYXdhaXQgdGhpcy5fZXh0ZW5zaW9uUnVubmVyLmVtaXRJbnB1dChcblx0XHRcdFx0Y3VycmVudFRleHQsXG5cdFx0XHRcdGN1cnJlbnRJbWFnZXMsXG5cdFx0XHRcdG9wdGlvbnM/LnNvdXJjZSA/PyBcImludGVyYWN0aXZlXCIsXG5cdFx0XHQpO1xuXHRcdFx0aWYgKGlucHV0UmVzdWx0LmFjdGlvbiA9PT0gXCJoYW5kbGVkXCIpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0aWYgKGlucHV0UmVzdWx0LmFjdGlvbiA9PT0gXCJ0cmFuc2Zvcm1cIikge1xuXHRcdFx0XHRjdXJyZW50VGV4dCA9IGlucHV0UmVzdWx0LnRleHQ7XG5cdFx0XHRcdGN1cnJlbnRJbWFnZXMgPSBpbnB1dFJlc3VsdC5pbWFnZXMgPz8gY3VycmVudEltYWdlcztcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBFeHBhbmQgc2tpbGwgY29tbWFuZHMgKC9za2lsbDpuYW1lIGFyZ3MpIGFuZCBwcm9tcHQgdGVtcGxhdGVzICgvdGVtcGxhdGUgYXJncylcblx0XHRsZXQgZXhwYW5kZWRUZXh0ID0gY3VycmVudFRleHQ7XG5cdFx0aWYgKGV4cGFuZFByb21wdFRlbXBsYXRlcykge1xuXHRcdFx0ZXhwYW5kZWRUZXh0ID0gdGhpcy5fZXhwYW5kU2tpbGxDb21tYW5kKGV4cGFuZGVkVGV4dCk7XG5cdFx0XHRleHBhbmRlZFRleHQgPSBleHBhbmRQcm9tcHRUZW1wbGF0ZShleHBhbmRlZFRleHQsIFsuLi50aGlzLnByb21wdFRlbXBsYXRlc10pO1xuXHRcdH1cblxuXHRcdC8vIElmIHN0cmVhbWluZywgcXVldWUgdmlhIHN0ZWVyKCkgb3IgZm9sbG93VXAoKSBiYXNlZCBvbiBvcHRpb25cblx0XHRpZiAodGhpcy5pc1N0cmVhbWluZykge1xuXHRcdFx0aWYgKCFvcHRpb25zPy5zdHJlYW1pbmdCZWhhdmlvcikge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoXG5cdFx0XHRcdFx0XCJBZ2VudCBpcyBhbHJlYWR5IHByb2Nlc3NpbmcuIFNwZWNpZnkgc3RyZWFtaW5nQmVoYXZpb3IgKCdzdGVlcicgb3IgJ2ZvbGxvd1VwJykgdG8gcXVldWUgdGhlIG1lc3NhZ2UuXCIsXG5cdFx0XHRcdCk7XG5cdFx0XHR9XG5cdFx0XHRpZiAob3B0aW9ucy5zdHJlYW1pbmdCZWhhdmlvciA9PT0gXCJmb2xsb3dVcFwiKSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMuX3F1ZXVlRm9sbG93VXAoZXhwYW5kZWRUZXh0LCBjdXJyZW50SW1hZ2VzKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMuX3F1ZXVlU3RlZXIoZXhwYW5kZWRUZXh0LCBjdXJyZW50SW1hZ2VzKTtcblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBGbHVzaCBhbnkgcGVuZGluZyBiYXNoIG1lc3NhZ2VzIGJlZm9yZSB0aGUgbmV3IHByb21wdFxuXHRcdHRoaXMuX2ZsdXNoUGVuZGluZ0Jhc2hNZXNzYWdlcygpO1xuXG5cdFx0Ly8gVmFsaWRhdGUgbW9kZWxcblx0XHRpZiAoIXRoaXMubW9kZWwpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0XCJObyBtb2RlbCBzZWxlY3RlZC5cXG5cXG5cIiArXG5cdFx0XHRcdFx0YFVzZSAvbG9naW4gb3Igc2V0IGFuIEFQSSBrZXkgZW52aXJvbm1lbnQgdmFyaWFibGUuIFNlZSAke2pvaW4oZ2V0RG9jc1BhdGgoKSwgXCJwcm92aWRlcnMubWRcIil9XFxuXFxuYCArXG5cdFx0XHRcdFx0XCJUaGVuIHVzZSAvbW9kZWwgdG8gc2VsZWN0IGEgbW9kZWwuXCIsXG5cdFx0XHQpO1xuXHRcdH1cblxuXHRcdC8vIENoZWNrIGlmIGEgaGlnaGVyLXByaW9yaXR5IHByb3ZpZGVyIGluIHRoZSBmYWxsYmFjayBjaGFpbiBoYXMgcmVjb3ZlcmVkXG5cdFx0Y29uc3QgcmVzdG9yYXRpb24gPSBhd2FpdCB0aGlzLl9mYWxsYmFja1Jlc29sdmVyLmNoZWNrRm9yUmVzdG9yYXRpb24odGhpcy5tb2RlbCk7XG5cdFx0aWYgKHJlc3RvcmF0aW9uKSB7XG5cdFx0XHRjb25zdCBwcmV2aW91c1Byb3ZpZGVyID0gYCR7dGhpcy5tb2RlbC5wcm92aWRlcn0vJHt0aGlzLm1vZGVsLmlkfWA7XG5cdFx0XHR0aGlzLmFnZW50LnNldE1vZGVsKHJlc3RvcmF0aW9uLm1vZGVsKTtcblx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuYXBwZW5kTW9kZWxDaGFuZ2UocmVzdG9yYXRpb24ubW9kZWwucHJvdmlkZXIsIHJlc3RvcmF0aW9uLm1vZGVsLmlkKTtcblx0XHRcdHRoaXMuX2VtaXQoe1xuXHRcdFx0XHR0eXBlOiBcImZhbGxiYWNrX3Byb3ZpZGVyX3Jlc3RvcmVkXCIsXG5cdFx0XHRcdHByb3ZpZGVyOiBgJHtyZXN0b3JhdGlvbi5tb2RlbC5wcm92aWRlcn0vJHtyZXN0b3JhdGlvbi5tb2RlbC5pZH1gLFxuXHRcdFx0XHRyZWFzb246IGBSZXN0b3JlZCBmcm9tICR7cHJldmlvdXNQcm92aWRlcn1gLFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0Ly8gVmFsaWRhdGUgcHJvdmlkZXIgcmVhZGluZXNzXG5cdFx0aWYgKCF0aGlzLl9tb2RlbFJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkodGhpcy5tb2RlbC5wcm92aWRlcikpIHtcblx0XHRcdGNvbnN0IGlzT0F1dGggPSB0aGlzLl9tb2RlbFJlZ2lzdHJ5LmlzVXNpbmdPQXV0aCh0aGlzLm1vZGVsKTtcblx0XHRcdGlmIChpc09BdXRoKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0XHRgQXV0aGVudGljYXRpb24gZmFpbGVkIGZvciBcIiR7dGhpcy5tb2RlbC5wcm92aWRlcn1cIi4gYCArXG5cdFx0XHRcdFx0XHRgQ3JlZGVudGlhbHMgbWF5IGhhdmUgZXhwaXJlZCBvciBuZXR3b3JrIGlzIHVuYXZhaWxhYmxlLiBgICtcblx0XHRcdFx0XHRcdGBSdW4gJy9sb2dpbiAke3RoaXMubW9kZWwucHJvdmlkZXJ9JyB0byByZS1hdXRoZW50aWNhdGUuYCxcblx0XHRcdFx0KTtcblx0XHRcdH1cblx0XHRcdHRocm93IG5ldyBFcnJvcihcblx0XHRcdFx0YE5vIEFQSSBrZXkgZm91bmQgZm9yICR7dGhpcy5tb2RlbC5wcm92aWRlcn0uXFxuXFxuYCArXG5cdFx0XHRcdFx0YFVzZSAvbG9naW4gb3Igc2V0IGFuIEFQSSBrZXkgZW52aXJvbm1lbnQgdmFyaWFibGUuIFNlZSAke2pvaW4oZ2V0RG9jc1BhdGgoKSwgXCJwcm92aWRlcnMubWRcIil9YCxcblx0XHRcdCk7XG5cdFx0fVxuXG5cdFx0Ly8gQ2hlY2sgaWYgd2UgbmVlZCB0byBjb21wYWN0IGJlZm9yZSBzZW5kaW5nIChjYXRjaGVzIGFib3J0ZWQgcmVzcG9uc2VzKVxuXHRcdGNvbnN0IGxhc3RBc3Npc3RhbnQgPSB0aGlzLl9maW5kTGFzdEFzc2lzdGFudE1lc3NhZ2UoKTtcblx0XHRpZiAobGFzdEFzc2lzdGFudCkge1xuXHRcdFx0YXdhaXQgdGhpcy5fY29tcGFjdGlvbk9yY2hlc3RyYXRvci5jaGVja0NvbXBhY3Rpb24obGFzdEFzc2lzdGFudCwgZmFsc2UpO1xuXHRcdH1cblxuXHRcdC8vIEJ1aWxkIG1lc3NhZ2VzIGFycmF5IChjdXN0b20gbWVzc2FnZSBpZiBhbnksIHRoZW4gdXNlciBtZXNzYWdlKVxuXHRcdGNvbnN0IG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSA9IFtdO1xuXG5cdFx0Ly8gQWRkIHVzZXIgbWVzc2FnZVxuXHRcdGNvbnN0IHVzZXJDb250ZW50OiAoVGV4dENvbnRlbnQgfCBJbWFnZUNvbnRlbnQpW10gPSBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZXhwYW5kZWRUZXh0IH1dO1xuXHRcdGlmIChjdXJyZW50SW1hZ2VzKSB7XG5cdFx0XHR1c2VyQ29udGVudC5wdXNoKC4uLmN1cnJlbnRJbWFnZXMpO1xuXHRcdH1cblx0XHRtZXNzYWdlcy5wdXNoKHtcblx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0Y29udGVudDogdXNlckNvbnRlbnQsXG5cdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0fSk7XG5cblx0XHQvLyBJbmplY3QgYW55IHBlbmRpbmcgXCJuZXh0VHVyblwiIG1lc3NhZ2VzIGFzIGNvbnRleHQgYWxvbmdzaWRlIHRoZSB1c2VyIG1lc3NhZ2Vcblx0XHRmb3IgKGNvbnN0IG1zZyBvZiB0aGlzLl9wZW5kaW5nTmV4dFR1cm5NZXNzYWdlcykge1xuXHRcdFx0bWVzc2FnZXMucHVzaChtc2cpO1xuXHRcdH1cblx0XHR0aGlzLl9wZW5kaW5nTmV4dFR1cm5NZXNzYWdlcyA9IFtdO1xuXG5cdFx0Ly8gRW1pdCBiZWZvcmVfYWdlbnRfc3RhcnQgZXh0ZW5zaW9uIGV2ZW50XG5cdFx0aWYgKHRoaXMuX2V4dGVuc2lvblJ1bm5lcikge1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5fZXh0ZW5zaW9uUnVubmVyLmVtaXRCZWZvcmVBZ2VudFN0YXJ0KFxuXHRcdFx0XHRleHBhbmRlZFRleHQsXG5cdFx0XHRcdGN1cnJlbnRJbWFnZXMsXG5cdFx0XHRcdHRoaXMuX2Jhc2VTeXN0ZW1Qcm9tcHQsXG5cdFx0XHQpO1xuXHRcdFx0Ly8gQWRkIGFsbCBjdXN0b20gbWVzc2FnZXMgZnJvbSBleHRlbnNpb25zXG5cdFx0XHRpZiAocmVzdWx0Py5tZXNzYWdlcykge1xuXHRcdFx0XHRmb3IgKGNvbnN0IG1zZyBvZiByZXN1bHQubWVzc2FnZXMpIHtcblx0XHRcdFx0XHRtZXNzYWdlcy5wdXNoKHtcblx0XHRcdFx0XHRcdHJvbGU6IFwiY3VzdG9tXCIsXG5cdFx0XHRcdFx0XHRjdXN0b21UeXBlOiBtc2cuY3VzdG9tVHlwZSxcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IG1zZy5jb250ZW50LFxuXHRcdFx0XHRcdFx0ZGlzcGxheTogbXNnLmRpc3BsYXksXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiBtc2cuZGV0YWlscyxcblx0XHRcdFx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0Ly8gQXBwbHkgZXh0ZW5zaW9uLW1vZGlmaWVkIHN5c3RlbSBwcm9tcHQsIG9yIHJlc2V0IHRvIGJhc2Vcblx0XHRcdGlmIChyZXN1bHQ/LnN5c3RlbVByb21wdCkge1xuXHRcdFx0XHR0aGlzLmFnZW50LnNldFN5c3RlbVByb21wdChyZXN1bHQuc3lzdGVtUHJvbXB0KTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdC8vIEVuc3VyZSB3ZSdyZSB1c2luZyB0aGUgYmFzZSBwcm9tcHQgKGluIGNhc2UgcHJldmlvdXMgdHVybiBoYWQgbW9kaWZpY2F0aW9ucylcblx0XHRcdFx0dGhpcy5hZ2VudC5zZXRTeXN0ZW1Qcm9tcHQodGhpcy5fYmFzZVN5c3RlbVByb21wdCk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0YXdhaXQgdGhpcy5hZ2VudC5wcm9tcHQobWVzc2FnZXMpO1xuXHRcdGF3YWl0IHRoaXMuX3JldHJ5SGFuZGxlci53YWl0Rm9yUmV0cnkoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBUcnkgdG8gZXhlY3V0ZSBhbiBleHRlbnNpb24gY29tbWFuZC4gUmV0dXJucyB0cnVlIGlmIGNvbW1hbmQgd2FzIGZvdW5kIGFuZCBleGVjdXRlZC5cblx0ICovXG5cdHByaXZhdGUgYXN5bmMgX3RyeUV4ZWN1dGVFeHRlbnNpb25Db21tYW5kKHRleHQ6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdGlmICghdGhpcy5fZXh0ZW5zaW9uUnVubmVyKSByZXR1cm4gZmFsc2U7XG5cblx0XHQvLyBQYXJzZSBjb21tYW5kIG5hbWUgYW5kIGFyZ3Ncblx0XHRjb25zdCBzcGFjZUluZGV4ID0gdGV4dC5pbmRleE9mKFwiIFwiKTtcblx0XHRjb25zdCBjb21tYW5kTmFtZSA9IHNwYWNlSW5kZXggPT09IC0xID8gdGV4dC5zbGljZSgxKSA6IHRleHQuc2xpY2UoMSwgc3BhY2VJbmRleCk7XG5cdFx0Y29uc3QgYXJncyA9IHNwYWNlSW5kZXggPT09IC0xID8gXCJcIiA6IHRleHQuc2xpY2Uoc3BhY2VJbmRleCArIDEpO1xuXG5cdFx0Y29uc3QgY29tbWFuZCA9IHRoaXMuX2V4dGVuc2lvblJ1bm5lci5nZXRDb21tYW5kKGNvbW1hbmROYW1lKTtcblx0XHRpZiAoIWNvbW1hbmQpIHJldHVybiBmYWxzZTtcblxuXHRcdC8vIEdldCBjb21tYW5kIGNvbnRleHQgZnJvbSBleHRlbnNpb24gcnVubmVyIChpbmNsdWRlcyBzZXNzaW9uIGNvbnRyb2wgbWV0aG9kcylcblx0XHRjb25zdCBjdHggPSB0aGlzLl9leHRlbnNpb25SdW5uZXIuY3JlYXRlQ29tbWFuZENvbnRleHQoKTtcblxuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCBjb21tYW5kLmhhbmRsZXIoYXJncywgY3R4KTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0Ly8gRW1pdCBlcnJvciB2aWEgZXh0ZW5zaW9uIHJ1bm5lclxuXHRcdFx0dGhpcy5fZXh0ZW5zaW9uUnVubmVyLmVtaXRFcnJvcih7XG5cdFx0XHRcdGV4dGVuc2lvblBhdGg6IGBjb21tYW5kOiR7Y29tbWFuZE5hbWV9YCxcblx0XHRcdFx0ZXZlbnQ6IFwiY29tbWFuZFwiLFxuXHRcdFx0XHRlcnJvcjogZ2V0RXJyb3JNZXNzYWdlKGVyciksXG5cdFx0XHR9KTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBFeHBhbmQgc2tpbGwgY29tbWFuZHMgKC9za2lsbDpuYW1lIGFyZ3MpIHRvIHRoZWlyIGZ1bGwgY29udGVudC5cblx0ICogUmV0dXJucyB0aGUgZXhwYW5kZWQgdGV4dCwgb3IgdGhlIG9yaWdpbmFsIHRleHQgaWYgbm90IGEgc2tpbGwgY29tbWFuZCBvciBza2lsbCBub3QgZm91bmQuXG5cdCAqIEVtaXRzIGVycm9ycyB2aWEgZXh0ZW5zaW9uIHJ1bm5lciBpZiBmaWxlIHJlYWQgZmFpbHMuXG5cdCAqL1xuXHRwcml2YXRlIF9leHBhbmRTa2lsbENvbW1hbmQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0XHRpZiAoIXRleHQuc3RhcnRzV2l0aChcIi9za2lsbDpcIikpIHJldHVybiB0ZXh0O1xuXG5cdFx0Y29uc3Qgc3BhY2VJbmRleCA9IHRleHQuaW5kZXhPZihcIiBcIik7XG5cdFx0Y29uc3Qgc2tpbGxOYW1lID0gc3BhY2VJbmRleCA9PT0gLTEgPyB0ZXh0LnNsaWNlKDcpIDogdGV4dC5zbGljZSg3LCBzcGFjZUluZGV4KTtcblx0XHRjb25zdCBhcmdzID0gc3BhY2VJbmRleCA9PT0gLTEgPyBcIlwiIDogdGV4dC5zbGljZShzcGFjZUluZGV4ICsgMSkudHJpbSgpO1xuXG5cdFx0aWYgKCF0aGlzLl9maW5kU2tpbGxCeU5hbWUoc2tpbGxOYW1lKSkgcmV0dXJuIHRleHQ7XG5cblx0XHR0cnkge1xuXHRcdFx0cmV0dXJuIHRoaXMuX2Zvcm1hdFNraWxsSW52b2NhdGlvbihza2lsbE5hbWUsIGFyZ3MpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0cmV0dXJuIHRleHQ7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBfY3JlYXRlQnVpbHRJblNraWxsVG9vbCgpOiBBZ2VudFRvb2wge1xuXHRcdGNvbnN0IHNraWxsU2NoZW1hID0gVHlwZS5PYmplY3Qoe1xuXHRcdFx0c2tpbGw6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGhlIHNraWxsIG5hbWUuIEUuZy4sICdjb21taXQnLCAncmV2aWV3LXByJywgb3IgJ3BkZidcIiB9KSxcblx0XHRcdGFyZ3M6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJPcHRpb25hbCBhcmd1bWVudHMgZm9yIHRoZSBza2lsbFwiIH0pKSxcblx0XHR9KTtcblxuXHRcdHJldHVybiB7XG5cdFx0XHRuYW1lOiBcIlNraWxsXCIsXG5cdFx0XHRsYWJlbDogXCJTa2lsbFwiLFxuXHRcdFx0ZGVzY3JpcHRpb246XG5cdFx0XHRcdFwiRXhlY3V0ZSBhIHNraWxsIHdpdGhpbiB0aGUgbWFpbiBjb252ZXJzYXRpb24uIFVzZSB0aGlzIHRvb2wgd2hlbiB1c2VycyBhc2sgZm9yIGEgc2xhc2ggY29tbWFuZCBvciByZWZlcmVuY2UgYSBza2lsbCBieSBuYW1lLiBSZXR1cm5zIHRoZSBleHBhbmRlZCBza2lsbCBibG9jayBhbmQgYXBwZW5kcyBhcmdzIGFmdGVyIGl0LlwiLFxuXHRcdFx0cGFyYW1ldGVyczogc2tpbGxTY2hlbWEsXG5cdFx0XHRleGVjdXRlOiBhc3luYyAoX3Rvb2xDYWxsSWQsIHBhcmFtczogdW5rbm93bikgPT4ge1xuXHRcdFx0XHRjb25zdCBpbnB1dCA9IHBhcmFtcyBhcyB7IHNraWxsOiBzdHJpbmc7IGFyZ3M/OiBzdHJpbmcgfTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHRcdFx0dGV4dDogdGhpcy5fZXhwYW5kU2tpbGxCeU5hbWUoaW5wdXQuc2tpbGwsIGlucHV0LmFyZ3MpLFxuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGdldEVycm9yTWVzc2FnZShlcnIpIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdH0sXG5cdFx0fTtcblx0fVxuXG5cdHByaXZhdGUgX2dldEJ1aWx0aW5Ub29sTmFtZXMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiB0aGlzLl9nZXRCdWlsdGluVG9vbHMoKS5tYXAoKHRvb2wpID0+IHRvb2wubmFtZSk7XG5cdH1cblxuXHRwcml2YXRlIF9nZXRCdWlsdGluVG9vbHMoKTogQWdlbnRUb29sW10ge1xuXHRcdHJldHVybiBbdGhpcy5fY3JlYXRlQnVpbHRJblNraWxsVG9vbCgpXTtcblx0fVxuXG5cdHByaXZhdGUgX2dldFJlZ2lzdGVyZWRUb29sRGVmaW5pdGlvbnMoKTogVG9vbERlZmluaXRpb25bXSB7XG5cdFx0Y29uc3QgcmVnaXN0ZXJlZFRvb2xzID0gdGhpcy5fZXh0ZW5zaW9uUnVubmVyPy5nZXRBbGxSZWdpc3RlcmVkVG9vbHMoKSA/PyBbXTtcblx0XHRyZXR1cm4gcmVnaXN0ZXJlZFRvb2xzLm1hcCgodG9vbCkgPT4gdG9vbC5kZWZpbml0aW9uKTtcblx0fVxuXG5cdHByaXZhdGUgX2dldEJ1aWx0aW5Ub29sRGVmaW5pdGlvbnMoKTogVG9vbERlZmluaXRpb25bXSB7XG5cdFx0cmV0dXJuIHRoaXMuX2dldEJ1aWx0aW5Ub29scygpLm1hcCgodG9vbCkgPT4gKHtcblx0XHRcdG5hbWU6IHRvb2wubmFtZSxcblx0XHRcdGxhYmVsOiB0b29sLmxhYmVsLFxuXHRcdFx0ZGVzY3JpcHRpb246IHRvb2wuZGVzY3JpcHRpb24sXG5cdFx0XHRwYXJhbWV0ZXJzOiB0b29sLnBhcmFtZXRlcnMsXG5cdFx0XHRleGVjdXRlOiBhc3luYyAoKSA9PiAoeyBjb250ZW50OiBbXSwgZGV0YWlsczogdW5kZWZpbmVkIH0pLFxuXHRcdH0pKTtcblx0fVxuXG5cdGdldFJlbmRlcmFibGVUb29sRGVmaW5pdGlvbih0b29sTmFtZTogc3RyaW5nKTogVG9vbERlZmluaXRpb24gfCB1bmRlZmluZWQge1xuXHRcdGNvbnN0IG5vcm1hbGl6ZWRUb29sTmFtZSA9IHRvb2xOYW1lLnRvTG93ZXJDYXNlKCk7XG5cdFx0cmV0dXJuIFsuLi50aGlzLl9nZXRCdWlsdGluVG9vbERlZmluaXRpb25zKCksIC4uLnRoaXMuX2dldFJlZ2lzdGVyZWRUb29sRGVmaW5pdGlvbnMoKV0uZmluZChcblx0XHRcdCh0b29sKSA9PiB0b29sLm5hbWUudG9Mb3dlckNhc2UoKSA9PT0gbm9ybWFsaXplZFRvb2xOYW1lLFxuXHRcdCk7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYSBzdGVlcmluZyBtZXNzYWdlIHRvIGludGVycnVwdCB0aGUgYWdlbnQgbWlkLXJ1bi5cblx0ICogRGVsaXZlcmVkIGFmdGVyIGN1cnJlbnQgdG9vbCBleGVjdXRpb24sIHNraXBzIHJlbWFpbmluZyB0b29scy5cblx0ICogRXhwYW5kcyBza2lsbCBjb21tYW5kcyBhbmQgcHJvbXB0IHRlbXBsYXRlcy4gRXJyb3JzIG9uIGV4dGVuc2lvbiBjb21tYW5kcy5cblx0ICogQHBhcmFtIGltYWdlcyBPcHRpb25hbCBpbWFnZSBhdHRhY2htZW50cyB0byBpbmNsdWRlIHdpdGggdGhlIG1lc3NhZ2Vcblx0ICogQHRocm93cyBFcnJvciBpZiB0ZXh0IGlzIGFuIGV4dGVuc2lvbiBjb21tYW5kXG5cdCAqL1xuXHRhc3luYyBzdGVlcih0ZXh0OiBzdHJpbmcsIGltYWdlcz86IEltYWdlQ29udGVudFtdKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Ly8gQ2hlY2sgZm9yIGV4dGVuc2lvbiBjb21tYW5kcyAoY2Fubm90IGJlIHF1ZXVlZClcblx0XHRpZiAodGV4dC5zdGFydHNXaXRoKFwiL1wiKSkge1xuXHRcdFx0dGhpcy5fdGhyb3dJZkV4dGVuc2lvbkNvbW1hbmQodGV4dCk7XG5cdFx0fVxuXG5cdFx0Ly8gRXhwYW5kIHNraWxsIGNvbW1hbmRzIGFuZCBwcm9tcHQgdGVtcGxhdGVzXG5cdFx0bGV0IGV4cGFuZGVkVGV4dCA9IHRoaXMuX2V4cGFuZFNraWxsQ29tbWFuZCh0ZXh0KTtcblx0XHRleHBhbmRlZFRleHQgPSBleHBhbmRQcm9tcHRUZW1wbGF0ZShleHBhbmRlZFRleHQsIFsuLi50aGlzLnByb21wdFRlbXBsYXRlc10pO1xuXG5cdFx0YXdhaXQgdGhpcy5fcXVldWVTdGVlcihleHBhbmRlZFRleHQsIGltYWdlcyk7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYSBmb2xsb3ctdXAgbWVzc2FnZSB0byBiZSBwcm9jZXNzZWQgYWZ0ZXIgdGhlIGFnZW50IGZpbmlzaGVzLlxuXHQgKiBEZWxpdmVyZWQgb25seSB3aGVuIGFnZW50IGhhcyBubyBtb3JlIHRvb2wgY2FsbHMgb3Igc3RlZXJpbmcgbWVzc2FnZXMuXG5cdCAqIEV4cGFuZHMgc2tpbGwgY29tbWFuZHMgYW5kIHByb21wdCB0ZW1wbGF0ZXMuIEVycm9ycyBvbiBleHRlbnNpb24gY29tbWFuZHMuXG5cdCAqIEBwYXJhbSBpbWFnZXMgT3B0aW9uYWwgaW1hZ2UgYXR0YWNobWVudHMgdG8gaW5jbHVkZSB3aXRoIHRoZSBtZXNzYWdlXG5cdCAqIEB0aHJvd3MgRXJyb3IgaWYgdGV4dCBpcyBhbiBleHRlbnNpb24gY29tbWFuZFxuXHQgKi9cblx0YXN5bmMgZm9sbG93VXAodGV4dDogc3RyaW5nLCBpbWFnZXM/OiBJbWFnZUNvbnRlbnRbXSk6IFByb21pc2U8dm9pZD4ge1xuXHRcdC8vIENoZWNrIGZvciBleHRlbnNpb24gY29tbWFuZHMgKGNhbm5vdCBiZSBxdWV1ZWQpXG5cdFx0aWYgKHRleHQuc3RhcnRzV2l0aChcIi9cIikpIHtcblx0XHRcdHRoaXMuX3Rocm93SWZFeHRlbnNpb25Db21tYW5kKHRleHQpO1xuXHRcdH1cblxuXHRcdC8vIEV4cGFuZCBza2lsbCBjb21tYW5kcyBhbmQgcHJvbXB0IHRlbXBsYXRlc1xuXHRcdGxldCBleHBhbmRlZFRleHQgPSB0aGlzLl9leHBhbmRTa2lsbENvbW1hbmQodGV4dCk7XG5cdFx0ZXhwYW5kZWRUZXh0ID0gZXhwYW5kUHJvbXB0VGVtcGxhdGUoZXhwYW5kZWRUZXh0LCBbLi4udGhpcy5wcm9tcHRUZW1wbGF0ZXNdKTtcblxuXHRcdGF3YWl0IHRoaXMuX3F1ZXVlRm9sbG93VXAoZXhwYW5kZWRUZXh0LCBpbWFnZXMpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEludGVybmFsOiBRdWV1ZSBhIHN0ZWVyaW5nIG1lc3NhZ2UgKGFscmVhZHkgZXhwYW5kZWQsIG5vIGV4dGVuc2lvbiBjb21tYW5kIGNoZWNrKS5cblx0ICovXG5cdHByaXZhdGUgYXN5bmMgX3F1ZXVlU3RlZXIodGV4dDogc3RyaW5nLCBpbWFnZXM/OiBJbWFnZUNvbnRlbnRbXSk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuX3N0ZWVyaW5nTWVzc2FnZXMucHVzaCh0ZXh0KTtcblx0XHRjb25zdCBjb250ZW50OiAoVGV4dENvbnRlbnQgfCBJbWFnZUNvbnRlbnQpW10gPSBbeyB0eXBlOiBcInRleHRcIiwgdGV4dCB9XTtcblx0XHRpZiAoaW1hZ2VzKSB7XG5cdFx0XHRjb250ZW50LnB1c2goLi4uaW1hZ2VzKTtcblx0XHR9XG5cdFx0dGhpcy5hZ2VudC5zdGVlcihcblx0XHRcdHtcblx0XHRcdFx0cm9sZTogXCJ1c2VyXCIsXG5cdFx0XHRcdGNvbnRlbnQsXG5cdFx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHRcdH0sXG5cdFx0XHRcInVzZXJcIixcblx0XHQpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEludGVybmFsOiBRdWV1ZSBhIGZvbGxvdy11cCBtZXNzYWdlIChhbHJlYWR5IGV4cGFuZGVkLCBubyBleHRlbnNpb24gY29tbWFuZCBjaGVjaykuXG5cdCAqL1xuXHRwcml2YXRlIGFzeW5jIF9xdWV1ZUZvbGxvd1VwKHRleHQ6IHN0cmluZywgaW1hZ2VzPzogSW1hZ2VDb250ZW50W10pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHR0aGlzLl9mb2xsb3dVcE1lc3NhZ2VzLnB1c2godGV4dCk7XG5cdFx0Y29uc3QgY29udGVudDogKFRleHRDb250ZW50IHwgSW1hZ2VDb250ZW50KVtdID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQgfV07XG5cdFx0aWYgKGltYWdlcykge1xuXHRcdFx0Y29udGVudC5wdXNoKC4uLmltYWdlcyk7XG5cdFx0fVxuXHRcdHRoaXMuYWdlbnQuZm9sbG93VXAoXG5cdFx0XHR7XG5cdFx0XHRcdHJvbGU6IFwidXNlclwiLFxuXHRcdFx0XHRjb250ZW50LFxuXHRcdFx0XHR0aW1lc3RhbXA6IERhdGUubm93KCksXG5cdFx0XHR9LFxuXHRcdFx0XCJ1c2VyXCIsXG5cdFx0KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBUaHJvdyBhbiBlcnJvciBpZiB0aGUgdGV4dCBpcyBhbiBleHRlbnNpb24gY29tbWFuZC5cblx0ICovXG5cdHByaXZhdGUgX3Rocm93SWZFeHRlbnNpb25Db21tYW5kKHRleHQ6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghdGhpcy5fZXh0ZW5zaW9uUnVubmVyKSByZXR1cm47XG5cblx0XHRjb25zdCBzcGFjZUluZGV4ID0gdGV4dC5pbmRleE9mKFwiIFwiKTtcblx0XHRjb25zdCBjb21tYW5kTmFtZSA9IHNwYWNlSW5kZXggPT09IC0xID8gdGV4dC5zbGljZSgxKSA6IHRleHQuc2xpY2UoMSwgc3BhY2VJbmRleCk7XG5cdFx0Y29uc3QgY29tbWFuZCA9IHRoaXMuX2V4dGVuc2lvblJ1bm5lci5nZXRDb21tYW5kKGNvbW1hbmROYW1lKTtcblxuXHRcdGlmIChjb21tYW5kKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXG5cdFx0XHRcdGBFeHRlbnNpb24gY29tbWFuZCBcIi8ke2NvbW1hbmROYW1lfVwiIGNhbm5vdCBiZSBxdWV1ZWQuIFVzZSBwcm9tcHQoKSBvciBleGVjdXRlIHRoZSBjb21tYW5kIHdoZW4gbm90IHN0cmVhbWluZy5gLFxuXHRcdFx0KTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogU2VuZCBhIGN1c3RvbSBtZXNzYWdlIHRvIHRoZSBzZXNzaW9uLiBDcmVhdGVzIGEgQ3VzdG9tTWVzc2FnZUVudHJ5LlxuXHQgKlxuXHQgKiBIYW5kbGVzIHRocmVlIGNhc2VzOlxuXHQgKiAtIFN0cmVhbWluZzogcXVldWVzIG1lc3NhZ2UsIHByb2Nlc3NlZCB3aGVuIGxvb3AgcHVsbHMgZnJvbSBxdWV1ZVxuXHQgKiAtIE5vdCBzdHJlYW1pbmcgKyB0cmlnZ2VyVHVybjogYXBwZW5kcyB0byBzdGF0ZS9zZXNzaW9uLCBzdGFydHMgbmV3IHR1cm5cblx0ICogLSBOb3Qgc3RyZWFtaW5nICsgbm8gdHJpZ2dlcjogYXBwZW5kcyB0byBzdGF0ZS9zZXNzaW9uLCBubyB0dXJuXG5cdCAqXG5cdCAqIEBwYXJhbSBtZXNzYWdlIEN1c3RvbSBtZXNzYWdlIHdpdGggY3VzdG9tVHlwZSwgY29udGVudCwgZGlzcGxheSwgZGV0YWlsc1xuXHQgKiBAcGFyYW0gb3B0aW9ucy50cmlnZ2VyVHVybiBJZiB0cnVlIGFuZCBub3Qgc3RyZWFtaW5nLCB0cmlnZ2VycyBhIG5ldyBMTE0gdHVyblxuXHQgKiBAcGFyYW0gb3B0aW9ucy5kZWxpdmVyQXMgRGVsaXZlcnkgbW9kZTogXCJzdGVlclwiLCBcImZvbGxvd1VwXCIsIG9yIFwibmV4dFR1cm5cIlxuXHQgKi9cblx0YXN5bmMgc2VuZEN1c3RvbU1lc3NhZ2U8VCA9IHVua25vd24+KFxuXHRcdG1lc3NhZ2U6IFBpY2s8Q3VzdG9tTWVzc2FnZTxUPiwgXCJjdXN0b21UeXBlXCIgfCBcImNvbnRlbnRcIiB8IFwiZGlzcGxheVwiIHwgXCJkZXRhaWxzXCI+LFxuXHRcdG9wdGlvbnM/OiB7IHRyaWdnZXJUdXJuPzogYm9vbGVhbjsgZGVsaXZlckFzPzogXCJzdGVlclwiIHwgXCJmb2xsb3dVcFwiIHwgXCJuZXh0VHVyblwiIH0sXG5cdCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IGFwcE1lc3NhZ2UgPSB7XG5cdFx0XHRyb2xlOiBcImN1c3RvbVwiIGFzIGNvbnN0LFxuXHRcdFx0Y3VzdG9tVHlwZTogbWVzc2FnZS5jdXN0b21UeXBlLFxuXHRcdFx0Y29udGVudDogbWVzc2FnZS5jb250ZW50LFxuXHRcdFx0ZGlzcGxheTogbWVzc2FnZS5kaXNwbGF5LFxuXHRcdFx0ZGV0YWlsczogbWVzc2FnZS5kZXRhaWxzLFxuXHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdH0gc2F0aXNmaWVzIEN1c3RvbU1lc3NhZ2U8VD47XG5cdFx0aWYgKG9wdGlvbnM/LmRlbGl2ZXJBcyA9PT0gXCJuZXh0VHVyblwiKSB7XG5cdFx0XHR0aGlzLl9wZW5kaW5nTmV4dFR1cm5NZXNzYWdlcy5wdXNoKGFwcE1lc3NhZ2UpO1xuXHRcdH0gZWxzZSBpZiAodGhpcy5pc1N0cmVhbWluZykge1xuXHRcdFx0aWYgKG9wdGlvbnM/LmRlbGl2ZXJBcyA9PT0gXCJmb2xsb3dVcFwiKSB7XG5cdFx0XHRcdHRoaXMuYWdlbnQuZm9sbG93VXAoYXBwTWVzc2FnZSk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR0aGlzLmFnZW50LnN0ZWVyKGFwcE1lc3NhZ2UpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAob3B0aW9ucz8udHJpZ2dlclR1cm4pIHtcblx0XHRcdGF3YWl0IHRoaXMuYWdlbnQucHJvbXB0KGFwcE1lc3NhZ2UpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHR0aGlzLmFnZW50LmFwcGVuZE1lc3NhZ2UoYXBwTWVzc2FnZSk7XG5cdFx0XHR0aGlzLnNlc3Npb25NYW5hZ2VyLmFwcGVuZEN1c3RvbU1lc3NhZ2VFbnRyeShcblx0XHRcdFx0bWVzc2FnZS5jdXN0b21UeXBlLFxuXHRcdFx0XHRtZXNzYWdlLmNvbnRlbnQsXG5cdFx0XHRcdG1lc3NhZ2UuZGlzcGxheSxcblx0XHRcdFx0bWVzc2FnZS5kZXRhaWxzLFxuXHRcdFx0KTtcblx0XHRcdHRoaXMuX2VtaXQoeyB0eXBlOiBcIm1lc3NhZ2Vfc3RhcnRcIiwgbWVzc2FnZTogYXBwTWVzc2FnZSB9KTtcblx0XHRcdHRoaXMuX2VtaXQoeyB0eXBlOiBcIm1lc3NhZ2VfZW5kXCIsIG1lc3NhZ2U6IGFwcE1lc3NhZ2UgfSk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFNlbmQgYSB1c2VyIG1lc3NhZ2UgdG8gdGhlIGFnZW50LiBBbHdheXMgdHJpZ2dlcnMgYSB0dXJuLlxuXHQgKiBXaGVuIHRoZSBhZ2VudCBpcyBzdHJlYW1pbmcsIHVzZSBkZWxpdmVyQXMgdG8gc3BlY2lmeSBob3cgdG8gcXVldWUgdGhlIG1lc3NhZ2UuXG5cdCAqXG5cdCAqIEBwYXJhbSBjb250ZW50IFVzZXIgbWVzc2FnZSBjb250ZW50IChzdHJpbmcgb3IgY29udGVudCBhcnJheSlcblx0ICogQHBhcmFtIG9wdGlvbnMuZGVsaXZlckFzIERlbGl2ZXJ5IG1vZGUgd2hlbiBzdHJlYW1pbmc6IFwic3RlZXJcIiBvciBcImZvbGxvd1VwXCJcblx0ICovXG5cdGFzeW5jIHNlbmRVc2VyTWVzc2FnZShcblx0XHRjb250ZW50OiBzdHJpbmcgfCAoVGV4dENvbnRlbnQgfCBJbWFnZUNvbnRlbnQpW10sXG5cdFx0b3B0aW9ucz86IHsgZGVsaXZlckFzPzogXCJzdGVlclwiIHwgXCJmb2xsb3dVcFwiIH0sXG5cdCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdC8vIE5vcm1hbGl6ZSBjb250ZW50IHRvIHRleHQgc3RyaW5nICsgb3B0aW9uYWwgaW1hZ2VzXG5cdFx0bGV0IHRleHQ6IHN0cmluZztcblx0XHRsZXQgaW1hZ2VzOiBJbWFnZUNvbnRlbnRbXSB8IHVuZGVmaW5lZDtcblxuXHRcdGlmICh0eXBlb2YgY29udGVudCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0dGV4dCA9IGNvbnRlbnQ7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnN0IHRleHRQYXJ0czogc3RyaW5nW10gPSBbXTtcblx0XHRcdGltYWdlcyA9IFtdO1xuXHRcdFx0Zm9yIChjb25zdCBwYXJ0IG9mIGNvbnRlbnQpIHtcblx0XHRcdFx0aWYgKHBhcnQudHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHR0ZXh0UGFydHMucHVzaChwYXJ0LnRleHQpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGltYWdlcy5wdXNoKHBhcnQpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHR0ZXh0ID0gdGV4dFBhcnRzLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRpZiAoaW1hZ2VzLmxlbmd0aCA9PT0gMCkgaW1hZ2VzID0gdW5kZWZpbmVkO1xuXHRcdH1cblxuXHRcdC8vIFVzZSBwcm9tcHQoKSB3aXRoIGV4cGFuZFByb21wdFRlbXBsYXRlczogZmFsc2UgdG8gc2tpcCBjb21tYW5kIGhhbmRsaW5nIGFuZCB0ZW1wbGF0ZSBleHBhbnNpb25cblx0XHRhd2FpdCB0aGlzLnByb21wdCh0ZXh0LCB7XG5cdFx0XHRleHBhbmRQcm9tcHRUZW1wbGF0ZXM6IGZhbHNlLFxuXHRcdFx0c3RyZWFtaW5nQmVoYXZpb3I6IG9wdGlvbnM/LmRlbGl2ZXJBcyxcblx0XHRcdGltYWdlcyxcblx0XHRcdHNvdXJjZTogXCJleHRlbnNpb25cIixcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDbGVhciBhbGwgcXVldWVkIG1lc3NhZ2VzIGFuZCByZXR1cm4gdGhlbS5cblx0ICogVXNlZnVsIGZvciByZXN0b3JpbmcgdG8gZWRpdG9yIHdoZW4gdXNlciBhYm9ydHMuXG5cdCAqIEByZXR1cm5zIE9iamVjdCB3aXRoIHN0ZWVyaW5nIGFuZCBmb2xsb3dVcCBhcnJheXNcblx0ICovXG5cdGNsZWFyUXVldWUoKTogeyBzdGVlcmluZzogc3RyaW5nW107IGZvbGxvd1VwOiBzdHJpbmdbXSB9IHtcblx0XHQvLyBEcmFpbiB1c2VyLW9yaWdpbiBtZXNzYWdlcyBmcm9tIGFnZW50IHF1ZXVlcyBiZWZvcmUgY2xlYXJpbmcuXG5cdFx0Ly8gVGhpcyBwcmVzZXJ2ZXMgbWVzc2FnZXMgdGhlIHVzZXIgZXhwbGljaXRseSB0eXBlZCBkdXJpbmcgc3RyZWFtaW5nLFxuXHRcdC8vIHdoaWxlIHN5c3RlbS1nZW5lcmF0ZWQgbWVzc2FnZXMgKGV4dGVuc2lvbiBub3RpZmljYXRpb25zLCBldGMuKSBhcmUgZGlzY2FyZGVkLlxuXHRcdGNvbnN0IHVzZXJNZXNzYWdlcyA9IHRoaXMuYWdlbnQuZHJhaW5Vc2VyTWVzc2FnZXMoKTtcblxuXHRcdC8vIEV4dHJhY3QgdGV4dCBjb250ZW50IGZyb20gcHJlc2VydmVkIHVzZXIgbWVzc2FnZXNcblx0XHRjb25zdCBleHRyYWN0VGV4dCA9IChtOiBBZ2VudE1lc3NhZ2UpOiBzdHJpbmcgPT4ge1xuXHRcdFx0aWYgKCEoXCJjb250ZW50XCIgaW4gbSkgfHwgIUFycmF5LmlzQXJyYXkobS5jb250ZW50KSkgcmV0dXJuIFwiXCI7XG5cdFx0XHRjb25zdCB0ZXh0UGFydCA9IG0uY29udGVudC5maW5kKChjOiB7IHR5cGU6IHN0cmluZyB9KSA9PiBjLnR5cGUgPT09IFwidGV4dFwiKTtcblx0XHRcdHJldHVybiB0ZXh0UGFydCAmJiBcInRleHRcIiBpbiB0ZXh0UGFydCA/ICh0ZXh0UGFydCBhcyB7IHRleHQ6IHN0cmluZyB9KS50ZXh0IDogXCJcIjtcblx0XHR9O1xuXHRcdGNvbnN0IHByZXNlcnZlZFN0ZWVyaW5nID0gdXNlck1lc3NhZ2VzLnN0ZWVyaW5nLm1hcChleHRyYWN0VGV4dCkuZmlsdGVyKCh0KSA9PiB0Lmxlbmd0aCA+IDApO1xuXHRcdGNvbnN0IHByZXNlcnZlZEZvbGxvd1VwID0gdXNlck1lc3NhZ2VzLmZvbGxvd1VwLm1hcChleHRyYWN0VGV4dCkuZmlsdGVyKCh0KSA9PiB0Lmxlbmd0aCA+IDApO1xuXG5cdFx0Ly8gU2Vzc2lvbi1sZXZlbCBzdHJpbmcgYXJyYXlzIHRyYWNrIHdoYXQgd2FzIHF1ZXVlZCBmb3IgZGlzcGxheSBwdXJwb3Nlcy5cblx0XHQvLyBSZXR1cm4gdGhlIGZ1bGwgc2V0IChzZXNzaW9uLXRyYWNrZWQgKyBhbnkgYWdlbnQtb25seSB1c2VyIG1lc3NhZ2VzKS5cblx0XHRjb25zdCBzdGVlcmluZyA9IFsuLi50aGlzLl9zdGVlcmluZ01lc3NhZ2VzLCAuLi5wcmVzZXJ2ZWRTdGVlcmluZ107XG5cdFx0Y29uc3QgZm9sbG93VXAgPSBbLi4udGhpcy5fZm9sbG93VXBNZXNzYWdlcywgLi4ucHJlc2VydmVkRm9sbG93VXBdO1xuXHRcdHRoaXMuX3N0ZWVyaW5nTWVzc2FnZXMgPSBbXTtcblx0XHR0aGlzLl9mb2xsb3dVcE1lc3NhZ2VzID0gW107XG5cblx0XHQvLyBDbGVhciByZW1haW5pbmcgc3lzdGVtIG1lc3NhZ2VzIGZyb20gYWdlbnQgcXVldWVzXG5cdFx0dGhpcy5hZ2VudC5jbGVhckFsbFF1ZXVlcygpO1xuXHRcdHJldHVybiB7IHN0ZWVyaW5nLCBmb2xsb3dVcCB9O1xuXHR9XG5cblx0LyoqIE51bWJlciBvZiBwZW5kaW5nIG1lc3NhZ2VzIChpbmNsdWRlcyBib3RoIHN0ZWVyaW5nIGFuZCBmb2xsb3ctdXApICovXG5cdGdldCBwZW5kaW5nTWVzc2FnZUNvdW50KCk6IG51bWJlciB7XG5cdFx0cmV0dXJuIHRoaXMuX3N0ZWVyaW5nTWVzc2FnZXMubGVuZ3RoICsgdGhpcy5fZm9sbG93VXBNZXNzYWdlcy5sZW5ndGg7XG5cdH1cblxuXHQvKiogR2V0IHBlbmRpbmcgc3RlZXJpbmcgbWVzc2FnZXMgKHJlYWQtb25seSkgKi9cblx0Z2V0U3RlZXJpbmdNZXNzYWdlcygpOiByZWFkb25seSBzdHJpbmdbXSB7XG5cdFx0cmV0dXJuIHRoaXMuX3N0ZWVyaW5nTWVzc2FnZXM7XG5cdH1cblxuXHQvKiogR2V0IHBlbmRpbmcgZm9sbG93LXVwIG1lc3NhZ2VzIChyZWFkLW9ubHkpICovXG5cdGdldEZvbGxvd1VwTWVzc2FnZXMoKTogcmVhZG9ubHkgc3RyaW5nW10ge1xuXHRcdHJldHVybiB0aGlzLl9mb2xsb3dVcE1lc3NhZ2VzO1xuXHR9XG5cblx0Z2V0IHJlc291cmNlTG9hZGVyKCk6IFJlc291cmNlTG9hZGVyIHtcblx0XHRyZXR1cm4gdGhpcy5fcmVzb3VyY2VMb2FkZXI7XG5cdH1cblxuXHQvKipcblx0ICogQWJvcnQgY3VycmVudCBvcGVyYXRpb24gYW5kIHdhaXQgZm9yIGFnZW50IHRvIGJlY29tZSBpZGxlLlxuXHQgKi9cblx0YXN5bmMgYWJvcnQob3B0aW9ucz86IHsgb3JpZ2luPzogQWdlbnRBYm9ydE9yaWdpbiB9KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dGhpcy5fcmV0cnlIYW5kbGVyLmFib3J0UmV0cnkoKTtcblx0XHR0aGlzLmFnZW50LmFib3J0KG9wdGlvbnM/Lm9yaWdpbik7XG5cdFx0YXdhaXQgdGhpcy5hZ2VudC53YWl0Rm9ySWRsZSgpO1xuXHRcdC8vIEVuc3VyZSBhZ2VudF9lbmQgaXMgZW1pdHRlZCBldmVuIHdoZW4gYWJvcnQgaW50ZXJydXB0cyBhIHRvb2wgY2FsbCAoIzE0MTQpLlxuXHRcdC8vIFRoZSBhZ2VudCBtYXkgZ28gaWRsZSB3aXRob3V0IGVtaXR0aW5nIGFnZW50X2VuZCBpZiB0aGUgYWJvcnQgaGFwcGVuc1xuXHRcdC8vIGJldHdlZW4gdG9vbCBleGVjdXRpb24gYW5kIHJlc3BvbnNlIHByb2Nlc3NpbmcuIEFsc28gZmlyZSBTdG9wIHNvXG5cdFx0Ly8gTGF5ZXIgMCBob29rcyBzZWUgYSBjb25zaXN0ZW50IHZpZXcgb2Ygc2Vzc2lvbiBxdWllc2NlbmNlLlxuXHRcdGlmICghdGhpcy5pc1N0cmVhbWluZyAmJiB0aGlzLl9leHRlbnNpb25SdW5uZXIpIHtcblx0XHRcdGNvbnN0IHdhc1Byb2Nlc3NpbmdBZ2VudEVuZCA9IHRoaXMuX3Byb2Nlc3NpbmdBZ2VudEVuZDtcblx0XHRcdHRoaXMuX3Byb2Nlc3NpbmdBZ2VudEVuZCA9IHRydWU7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBtZXNzYWdlcyA9IHRoaXMuYWdlbnQuc3RhdGUubWVzc2FnZXM7XG5cdFx0XHRcdGF3YWl0IHRoaXMuX2V4dGVuc2lvblJ1bm5lci5lbWl0KHtcblx0XHRcdFx0XHR0eXBlOiBcImFnZW50X2VuZFwiLFxuXHRcdFx0XHRcdG1lc3NhZ2VzLFxuXHRcdFx0XHRcdHNlc3Npb25JZDogdGhpcy5zZXNzaW9uSWQsXG5cdFx0XHRcdFx0YWJvcnRPcmlnaW46IG9wdGlvbnM/Lm9yaWdpbixcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGNvbnN0IGxhc3QgPSBtZXNzYWdlc1ttZXNzYWdlcy5sZW5ndGggLSAxXTtcblx0XHRcdFx0Y29uc3Qgc3RvcFJlYXNvbjogXCJjb21wbGV0ZWRcIiB8IFwiY2FuY2VsbGVkXCIgfCBcImVycm9yXCIgfCBcImJsb2NrZWRcIiA9XG5cdFx0XHRcdFx0bGFzdD8ucm9sZSA9PT0gXCJhc3Npc3RhbnRcIlxuXHRcdFx0XHRcdFx0PyBsYXN0LnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiXG5cdFx0XHRcdFx0XHRcdD8gXCJjYW5jZWxsZWRcIlxuXHRcdFx0XHRcdFx0XHQ6IGxhc3Quc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiXG5cdFx0XHRcdFx0XHRcdFx0PyBcImVycm9yXCJcblx0XHRcdFx0XHRcdFx0XHQ6IFwiY29tcGxldGVkXCJcblx0XHRcdFx0XHRcdDogXCJjYW5jZWxsZWRcIjtcblx0XHRcdFx0YXdhaXQgdGhpcy5fZXh0ZW5zaW9uUnVubmVyLmVtaXRTdG9wKHtcblx0XHRcdFx0XHRyZWFzb246IHN0b3BSZWFzb24sXG5cdFx0XHRcdFx0bGFzdE1lc3NhZ2U6IGxhc3QsXG5cdFx0XHRcdFx0c2Vzc2lvbklkOiB0aGlzLnNlc3Npb25JZCxcblx0XHRcdFx0XHRhYm9ydE9yaWdpbjogb3B0aW9ucz8ub3JpZ2luLFxuXHRcdFx0XHR9KTtcblx0XHRcdH0gZmluYWxseSB7XG5cdFx0XHRcdHRoaXMuX3Byb2Nlc3NpbmdBZ2VudEVuZCA9IHdhc1Byb2Nlc3NpbmdBZ2VudEVuZDtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9zZXR0bGVDdXJyZW50VHVybkZvclNlc3Npb25UcmFuc2l0aW9uKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLl9wcm9jZXNzaW5nQWdlbnRFbmQpIHtcblx0XHRcdC8vIFdhaXQgZm9yIHRoZSBhZ2VudCB0byBmdWxseSBzZXR0bGUuIFdoZW4gY2FsbGVkIGZyb20gaW5zaWRlIGFuXG5cdFx0XHQvLyBhZ2VudF9lbmQgZXh0ZW5zaW9uIGhhbmRsZXIsIHRoZSBhZ2VudCBtYXkgYWxyZWFkeSBiZSBpZGxlIC0gYnV0XG5cdFx0XHQvLyBfcHJvY2Vzc0FnZW50RXZlbnQgc3RpbGwgaGFzIHJldHJ5L2NvbXBhY3Rpb24gdGFpbCB3b3JrIHRvIHJ1biBhZnRlclxuXHRcdFx0Ly8gX2VtaXRFeHRlbnNpb25FdmVudCByZXR1cm5zLiB3YWl0Rm9ySWRsZSgpIGlzIGVmZmVjdGl2ZWx5IGEgbm8tb3Agd2hlblxuXHRcdFx0Ly8gYWxyZWFkeSBpZGxlLCBzbyBhd2FpdGluZyBpdCB1bmNvbmRpdGlvbmFsbHkgaXMgc2FmZSBhbmQgZW5zdXJlcyB3ZVxuXHRcdFx0Ly8gZG9uJ3QgcHJvY2VlZCBpbnRvIHRoZSBzZXNzaW9uIHJlc2V0IHdoaWxlIHRoYXQgdGFpbCBpcyBzdGlsbCBvbiB0aGUgc3RhY2suXG5cdFx0XHRhd2FpdCB0aGlzLmFnZW50LndhaXRGb3JJZGxlKCk7XG5cblx0XHRcdGlmICh0aGlzLl9wcm9jZXNzaW5nUXVldWVkQWdlbnRFbmQpIHtcblx0XHRcdFx0dGhpcy5fc2Vzc2lvblRyYW5zaXRpb25TdGFydGVkRHVyaW5nQWdlbnRFbmQgPSB0cnVlO1xuXHRcdFx0XHR0aGlzLl9sYXN0QXNzaXN0YW50TWVzc2FnZSA9IHVuZGVmaW5lZDtcblx0XHRcdH1cblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyAjNDI0MzogTm9ybWFsIHNlc3Npb24gdHJhbnNpdGlvbnMgbXVzdCBhYm9ydCBiZWZvcmUgZGlzY29ubmVjdGluZyBzb1xuXHRcdC8vIG1lc3NhZ2VfZW5kL2FnZW50X2VuZCBldmVudHMgZmlyZSB3aGlsZSBsaXN0ZW5lcnMgYXJlIHN0aWxsIGNvbm5lY3RlZC5cblx0XHQvLyBEdXJpbmcgYWdlbnRfZW5kIGhhbmRsaW5nIHRoZSB0dXJuIGlzIGFscmVhZHkgZW5kaW5nOyBhYm9ydGluZyB0aGVyZSBjYW5cblx0XHQvLyBjb252ZXJ0IGEgc3VjY2Vzc2Z1bCBhdXRvLW1vZGUgaGFuZG9mZiBpbnRvIGFuIGFib3J0ZWQgcHJvdmlkZXIgbWVzc2FnZS5cblx0XHRpZiAoIXRoaXMuYWdlbnQuc3RhdGUuaXNTdHJlYW1pbmcpIHtcblx0XHRcdHRoaXMuX3JldHJ5SGFuZGxlci5hYm9ydFJldHJ5KCk7XG5cdFx0XHRhd2FpdCB0aGlzLmFnZW50LndhaXRGb3JJZGxlKCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGF3YWl0IHRoaXMuYWJvcnQoeyBvcmlnaW46IFwic2Vzc2lvbi10cmFuc2l0aW9uXCIgfSk7XG5cdH1cblxuXHQvKipcblx0ICogU3RhcnQgYSBuZXcgc2Vzc2lvbiwgb3B0aW9uYWxseSB3aXRoIGluaXRpYWwgbWVzc2FnZXMgYW5kIHBhcmVudCB0cmFja2luZy5cblx0ICogQ2xlYXJzIGFsbCBtZXNzYWdlcyBhbmQgc3RhcnRzIGEgbmV3IHNlc3Npb24uXG5cdCAqIExpc3RlbmVycyBhcmUgcHJlc2VydmVkIGFuZCB3aWxsIGNvbnRpbnVlIHJlY2VpdmluZyBldmVudHMuXG5cdCAqIEBwYXJhbSBvcHRpb25zLnBhcmVudFNlc3Npb24gLSBPcHRpb25hbCBwYXJlbnQgc2Vzc2lvbiBwYXRoIGZvciB0cmFja2luZ1xuXHQgKiBAcGFyYW0gb3B0aW9ucy5zZXR1cCAtIE9wdGlvbmFsIGNhbGxiYWNrIHRvIGluaXRpYWxpemUgc2Vzc2lvbiAoZS5nLiwgYXBwZW5kIG1lc3NhZ2VzKVxuXHQgKiBAcmV0dXJucyB0cnVlIGlmIGNvbXBsZXRlZCwgZmFsc2UgaWYgY2FuY2VsbGVkIGJ5IGV4dGVuc2lvblxuXHQgKi9cblx0YXN5bmMgbmV3U2Vzc2lvbihvcHRpb25zPzoge1xuXHRcdHBhcmVudFNlc3Npb24/OiBzdHJpbmc7XG5cdFx0c2V0dXA/OiAoc2Vzc2lvbk1hbmFnZXI6IFNlc3Npb25NYW5hZ2VyKSA9PiBQcm9taXNlPHZvaWQ+O1xuXHRcdC8qKiBFeHBsaWNpdCB3b3Jrc3BhY2Ugcm9vdCBmb3IgdGhlIG5ldyBzZXNzaW9uL3Rvb2wgcnVudGltZS4gKi9cblx0XHR3b3Jrc3BhY2VSb290Pzogc3RyaW5nO1xuXHRcdC8qKiBTZWUgRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQubmV3U2Vzc2lvbiBmb3IgZG9jcyAoIzM3MzEpLiAqL1xuXHRcdGFib3J0U2lnbmFsPzogQWJvcnRTaWduYWw7XG5cdH0pOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHRjb25zdCBwcmV2aW91c1Nlc3Npb25GaWxlID0gdGhpcy5zZXNzaW9uRmlsZTtcblxuXHRcdC8vIEVtaXQgc2Vzc2lvbl9iZWZvcmVfc3dpdGNoIGV2ZW50IHdpdGggcmVhc29uIFwibmV3XCIgKGNhbiBiZSBjYW5jZWxsZWQpXG5cdFx0aWYgKHRoaXMuX2V4dGVuc2lvblJ1bm5lcj8uaGFzSGFuZGxlcnMoXCJzZXNzaW9uX2JlZm9yZV9zd2l0Y2hcIikpIHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IChhd2FpdCB0aGlzLl9leHRlbnNpb25SdW5uZXIuZW1pdCh7XG5cdFx0XHRcdHR5cGU6IFwic2Vzc2lvbl9iZWZvcmVfc3dpdGNoXCIsXG5cdFx0XHRcdHJlYXNvbjogXCJuZXdcIixcblx0XHRcdH0pKSBhcyBTZXNzaW9uQmVmb3JlU3dpdGNoUmVzdWx0IHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRpZiAocmVzdWx0Py5jYW5jZWwpIHtcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHRoaXMuX3Nlc3Npb25Td2l0Y2hQZW5kaW5nID0gdHJ1ZTtcblx0XHR0cnkge1xuXHRcdFx0YXdhaXQgdGhpcy5fc2V0dGxlQ3VycmVudFR1cm5Gb3JTZXNzaW9uVHJhbnNpdGlvbigpO1xuXG5cdFx0XHQvLyAjMzczMTogSWYgdGhlIGNhbGxlciBhYm9ydGVkIChlLmcuIHJ1blVuaXQoKSB0aW1lZCBvdXQgd2hpbGUgdGhlXG5cdFx0XHQvLyB3b3JrdHJlZSB3YXMgYmVpbmcgdG9ybiBkb3duKSwgZGlzY2FyZCB0aGlzIHNlc3Npb24gYmVmb3JlIHJlYnVpbGRpbmdcblx0XHRcdC8vIHRoZSB0b29sIHJ1bnRpbWUuIFdpdGhvdXQgdGhpcyBjaGVjaywgdGhlIGxhdGUgbmV3U2Vzc2lvbigpIGNvdWxkXG5cdFx0XHQvLyByZWJ1aWxkIHRvb2xzIHdpdGggYSBzdGFsZSB3b3Jrc3BhY2Ugcm9vdC5cblx0XHRcdGlmIChvcHRpb25zPy5hYm9ydFNpZ25hbD8uYWJvcnRlZCkge1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cblx0XHRcdHRoaXMuX2Rpc2Nvbm5lY3RGcm9tQWdlbnQoKTtcblx0XHRcdHRoaXMuYWdlbnQucmVzZXQoKTtcblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0dGhpcy5fc2Vzc2lvblN3aXRjaFBlbmRpbmcgPSBmYWxzZTtcblx0XHR9XG5cdFx0Ly8gVXBkYXRlIHRoZSB3b3Jrc3BhY2Ugcm9vdCBmb3IgdGhlIG5ldyB0b29sIHJ1bnRpbWUuIEF1dG8tbW9kZSBwYXNzZXNcblx0XHQvLyB0aGlzIGV4cGxpY2l0bHkgc28gc2Vzc2lvbiByb3V0aW5nIGRvZXMgbm90IGRlcGVuZCBvbiBnbG9iYWxcblx0XHQvLyBwcm9jZXNzLmN3ZCgpIGFmdGVyIHdvcmt0cmVlIG1lcmdlL3RlYXJkb3duLiBPdGhlciBjYWxsZXJzIGtlZXAgdGhlXG5cdFx0Ly8gaGlzdG9yaWNhbCBkZWZhdWx0LlxuXHRcdGNvbnN0IHByZXZpb3VzQ3dkID0gdGhpcy5fY3dkO1xuXHRcdHRoaXMuX2N3ZCA9IG9wdGlvbnM/LndvcmtzcGFjZVJvb3QgPz8gcHJvY2Vzcy5jd2QoKTtcblx0XHRpZiAodGhpcy5fd29ya3NwYWNlUm9vdFJlZikge1xuXHRcdFx0dGhpcy5fd29ya3NwYWNlUm9vdFJlZi5jdXJyZW50ID0gdGhpcy5fY3dkO1xuXHRcdH1cblx0XHR0aGlzLnNlc3Npb25NYW5hZ2VyLm5ld1Nlc3Npb24oeyBwYXJlbnRTZXNzaW9uOiBvcHRpb25zPy5wYXJlbnRTZXNzaW9uIH0pO1xuXHRcdHRoaXMuYWdlbnQuc2Vzc2lvbklkID0gdGhpcy5zZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uSWQoKTtcblx0XHR0aGlzLl9zdGVlcmluZ01lc3NhZ2VzID0gW107XG5cdFx0dGhpcy5fZm9sbG93VXBNZXNzYWdlcyA9IFtdO1xuXHRcdHRoaXMuX3BlbmRpbmdOZXh0VHVybk1lc3NhZ2VzID0gW107XG5cdFx0dGhpcy5fdmlzaWJsZVNraWxsTmFtZXMgPSB1bmRlZmluZWQ7XG5cblx0XHR0aGlzLnNlc3Npb25NYW5hZ2VyLmFwcGVuZFRoaW5raW5nTGV2ZWxDaGFuZ2UodGhpcy50aGlua2luZ0xldmVsKTtcblxuXHRcdC8vIFJlYnVpbGQgdG9vbHMgd2hlbiBjd2QgY2hhbmdlZCAoZS5nLiwgYXV0by1tb2RlIGVudGVyZWQgYSB3b3JrdHJlZSkuXG5cdFx0Ly8gVG9vbHMgY2FwdHVyZSBjd2QgYXQgY3JlYXRpb24gdGltZSBmb3IgcGF0aCByZXNvbHV0aW9uIFx1MjAxNCB3aXRob3V0XG5cdFx0Ly8gcmVidWlsZGluZywgd3JpdGUvcmVhZC9lZGl0L2Jhc2ggcmVzb2x2ZSByZWxhdGl2ZSBwYXRocyBhZ2FpbnN0XG5cdFx0Ly8gdGhlIG9yaWdpbmFsIHByb2plY3Qgcm9vdCBpbnN0ZWFkIG9mIHRoZSB3b3JrdHJlZSAoIzYzMykuXG5cdFx0aWYgKHRoaXMuX2N3ZCAhPT0gcHJldmlvdXNDd2QpIHtcblx0XHRcdHRoaXMuX2J1aWxkUnVudGltZSh7XG5cdFx0XHRcdGFjdGl2ZVRvb2xOYW1lczogdGhpcy5nZXRBY3RpdmVUb29sTmFtZXMoKSxcblx0XHRcdFx0aW5jbHVkZUFsbEV4dGVuc2lvblRvb2xzOiB0cnVlLFxuXHRcdFx0fSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdC8vIEV2ZW4gd2hlbiBjd2QgaGFzbid0IGNoYW5nZWQsIHJlc3RvcmUgdGhlIGZ1bGwgdG9vbCBzZXQgKCMzNjE2KS5cblx0XHRcdC8vIEV4dGVuc2lvbnMgKGUuZy4sIGRpc2N1c3MgZmxvd3MpIG1heSBuYXJyb3cgdGhlIGFjdGl2ZSB0b29sIGxpc3Rcblx0XHRcdC8vIHZpYSBzZXRBY3RpdmVUb29scygpIGR1cmluZyBhIHNlc3Npb24uIFdpdGhvdXQgdGhpcyByZWZyZXNoLCB0aGVcblx0XHRcdC8vIG5hcnJvd2VkIHNldCBwZXJzaXN0cyBpbnRvIHRoZSBuZXh0IHNlc3Npb24gXHUyMDE0IGNhdXNpbmcgdG9vbHMgbGlrZVxuXHRcdFx0Ly8gZ3NkX3BsYW5fc2xpY2UgdG8gYmUgbWlzc2luZyBmcm9tIGF1dG8tbW9kZSBzdWJhZ2VudCBzZXNzaW9ucy5cblx0XHRcdHRoaXMuX3JlZnJlc2hUb29sUmVnaXN0cnkoe1xuXHRcdFx0XHRhY3RpdmVUb29sTmFtZXM6IHRoaXMuZ2V0QWN0aXZlVG9vbE5hbWVzKCksXG5cdFx0XHRcdGluY2x1ZGVBbGxFeHRlbnNpb25Ub29sczogdHJ1ZSxcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdC8vIFJ1biBzZXR1cCBjYWxsYmFjayBpZiBwcm92aWRlZCAoZS5nLiwgdG8gYXBwZW5kIGluaXRpYWwgbWVzc2FnZXMpXG5cdFx0aWYgKG9wdGlvbnM/LnNldHVwKSB7XG5cdFx0XHRhd2FpdCBvcHRpb25zLnNldHVwKHRoaXMuc2Vzc2lvbk1hbmFnZXIpO1xuXHRcdFx0Ly8gU3luYyBhZ2VudCBzdGF0ZSB3aXRoIHNlc3Npb24gbWFuYWdlciBhZnRlciBzZXR1cFxuXHRcdFx0Y29uc3Qgc2Vzc2lvbkNvbnRleHQgPSB0aGlzLnNlc3Npb25NYW5hZ2VyLmJ1aWxkU2Vzc2lvbkNvbnRleHQoKTtcblx0XHRcdHRoaXMuYWdlbnQucmVwbGFjZU1lc3NhZ2VzKHNlc3Npb25Db250ZXh0Lm1lc3NhZ2VzKTtcblx0XHR9XG5cblx0XHR0aGlzLl9yZWNvbm5lY3RUb0FnZW50KCk7XG5cblx0XHQvLyBFbWl0IHNlc3Npb25fc3dpdGNoIGV2ZW50IHdpdGggcmVhc29uIFwibmV3XCIgdG8gZXh0ZW5zaW9uc1xuXHRcdGlmICh0aGlzLl9leHRlbnNpb25SdW5uZXIpIHtcblx0XHRcdGF3YWl0IHRoaXMuX2V4dGVuc2lvblJ1bm5lci5lbWl0KHtcblx0XHRcdFx0dHlwZTogXCJzZXNzaW9uX3N3aXRjaFwiLFxuXHRcdFx0XHRyZWFzb246IFwibmV3XCIsXG5cdFx0XHRcdHByZXZpb3VzU2Vzc2lvbkZpbGUsXG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHQvLyBFbWl0IHNlc3Npb24gZXZlbnQgdG8gY3VzdG9tIHRvb2xzXG5cdFx0dGhpcy5fZW1pdFNlc3Npb25TdGF0ZUNoYW5nZWQoXCJuZXdfc2Vzc2lvblwiKTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gTW9kZWwgTWFuYWdlbWVudFxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0cHJpdmF0ZSBhc3luYyBfZW1pdE1vZGVsU2VsZWN0KFxuXHRcdG5leHRNb2RlbDogTW9kZWw8YW55Pixcblx0XHRwcmV2aW91c01vZGVsOiBNb2RlbDxhbnk+IHwgdW5kZWZpbmVkLFxuXHRcdHNvdXJjZTogXCJzZXRcIiB8IFwiY3ljbGVcIiB8IFwicmVzdG9yZVwiLFxuXHQpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAoIXRoaXMuX2V4dGVuc2lvblJ1bm5lcikgcmV0dXJuO1xuXHRcdGlmIChtb2RlbHNBcmVFcXVhbChwcmV2aW91c01vZGVsLCBuZXh0TW9kZWwpKSByZXR1cm47XG5cdFx0YXdhaXQgdGhpcy5fZXh0ZW5zaW9uUnVubmVyLmVtaXQoe1xuXHRcdFx0dHlwZTogXCJtb2RlbF9zZWxlY3RcIixcblx0XHRcdG1vZGVsOiBuZXh0TW9kZWwsXG5cdFx0XHRwcmV2aW91c01vZGVsLFxuXHRcdFx0c291cmNlLFxuXHRcdH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIEFwcGx5IGEgbW9kZWwgY2hhbmdlOiBzZXQgdGhlIG1vZGVsIG9uIHRoZSBhZ2VudCwgcGVyc2lzdCB0byBzZXNzaW9uL3NldHRpbmdzLFxuXHQgKiByZS1jbGFtcCB0aGlua2luZyBsZXZlbCwgYW5kIGVtaXQgdGhlIG1vZGVsX3NlbGVjdCBldmVudC5cblx0ICovXG5cdHByaXZhdGUgYXN5bmMgX2FwcGx5TW9kZWxDaGFuZ2UoXG5cdFx0bW9kZWw6IE1vZGVsPGFueT4sXG5cdFx0dGhpbmtpbmdMZXZlbDogVGhpbmtpbmdMZXZlbCxcblx0XHRzb3VyY2U6IFwic2V0XCIgfCBcImN5Y2xlXCIgfCBcInJlc3RvcmVcIixcblx0XHRvcHRpb25zPzogeyBwZXJzaXN0PzogYm9vbGVhbiB9LFxuXHQpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBwcmV2aW91c01vZGVsID0gdGhpcy5tb2RlbDtcblx0XHQvLyBFeHBsaWNpdCBtb2RlbCBzd2l0Y2hlcyBtdXN0IGNhbmNlbCBhbnkgaW4tZmxpZ2h0IHJldHJ5IGxvb3AgZnJvbSB0aGVcblx0XHQvLyBwcmV2aW91cyBwcm92aWRlci9tb2RlbC4gT3RoZXJ3aXNlIHN0YWxlIHByb3ZpZGVyIGJhY2tvZmYgZXJyb3JzIGNhblxuXHRcdC8vIGNvbnRpbnVlIHRvIGxhbmQgYWZ0ZXIgdGhlIHVzZXIgb3IgcnVudGltZSBoYXMgYWxyZWFkeSBzd2l0Y2hlZCBtb2RlbHMuXG5cdFx0dGhpcy5fcmV0cnlIYW5kbGVyLmFib3J0UmV0cnkoKTtcblx0XHR0aGlzLmFnZW50LnNldE1vZGVsKG1vZGVsKTtcblx0XHR0aGlzLnNlc3Npb25NYW5hZ2VyLmFwcGVuZE1vZGVsQ2hhbmdlKG1vZGVsLnByb3ZpZGVyLCBtb2RlbC5pZCk7XG5cdFx0aWYgKG9wdGlvbnM/LnBlcnNpc3QgIT09IGZhbHNlKSB7XG5cdFx0XHR0aGlzLnNldHRpbmdzTWFuYWdlci5zZXREZWZhdWx0TW9kZWxBbmRQcm92aWRlcihtb2RlbC5wcm92aWRlciwgbW9kZWwuaWQpO1xuXHRcdH1cblx0XHR0aGlzLnNldFRoaW5raW5nTGV2ZWwodGhpbmtpbmdMZXZlbCk7XG5cdFx0YXdhaXQgdGhpcy5fZW1pdE1vZGVsU2VsZWN0KG1vZGVsLCBwcmV2aW91c01vZGVsLCBzb3VyY2UpO1xuXHRcdHRoaXMuX2VtaXRTZXNzaW9uU3RhdGVDaGFuZ2VkKFwic2V0X21vZGVsXCIpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldCBtb2RlbCBkaXJlY3RseS5cblx0ICogVmFsaWRhdGVzIHByb3ZpZGVyIHJlYWRpbmVzcywgc2F2ZXMgdG8gc2Vzc2lvbiBhbmQgc2V0dGluZ3MuXG5cdCAqIEB0aHJvd3MgRXJyb3IgaWYgcHJvdmlkZXIgaXMgbm90IHJlYWR5IChtaXNzaW5nIGNyZWRlbnRpYWxzIGZvciBhcGlLZXkvb2F1dGggcHJvdmlkZXJzKVxuXHQgKi9cblx0YXN5bmMgc2V0TW9kZWwobW9kZWw6IE1vZGVsPGFueT4sIG9wdGlvbnM/OiB7IHBlcnNpc3Q/OiBib29sZWFuIH0pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAoIXRoaXMuX21vZGVsUmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeShtb2RlbC5wcm92aWRlcikpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgTm8gQVBJIGtleSBmb3IgJHttb2RlbC5wcm92aWRlcn0vJHttb2RlbC5pZH1gKTtcblx0XHR9XG5cblx0XHRjb25zdCB0aGlua2luZ0xldmVsID0gdGhpcy5fZ2V0VGhpbmtpbmdMZXZlbEZvck1vZGVsU3dpdGNoKCk7XG5cdFx0YXdhaXQgdGhpcy5fYXBwbHlNb2RlbENoYW5nZShtb2RlbCwgdGhpbmtpbmdMZXZlbCwgXCJzZXRcIiwgb3B0aW9ucyk7XG5cdH1cblxuXHQvKipcblx0ICogQ3ljbGUgdG8gbmV4dC9wcmV2aW91cyBtb2RlbC5cblx0ICogVXNlcyBzY29wZWQgbW9kZWxzIChmcm9tIC0tbW9kZWxzIGZsYWcpIGlmIGF2YWlsYWJsZSwgb3RoZXJ3aXNlIGFsbCBhdmFpbGFibGUgbW9kZWxzLlxuXHQgKiBAcGFyYW0gZGlyZWN0aW9uIC0gXCJmb3J3YXJkXCIgKGRlZmF1bHQpIG9yIFwiYmFja3dhcmRcIlxuXHQgKiBAcmV0dXJucyBUaGUgbmV3IG1vZGVsIGluZm8sIG9yIHVuZGVmaW5lZCBpZiBvbmx5IG9uZSBtb2RlbCBhdmFpbGFibGVcblx0ICovXG5cdGFzeW5jIGN5Y2xlTW9kZWwoZGlyZWN0aW9uOiBcImZvcndhcmRcIiB8IFwiYmFja3dhcmRcIiA9IFwiZm9yd2FyZFwiLCBvcHRpb25zPzogeyBwZXJzaXN0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxNb2RlbEN5Y2xlUmVzdWx0IHwgdW5kZWZpbmVkPiB7XG5cdFx0aWYgKHRoaXMuX3Njb3BlZE1vZGVscy5sZW5ndGggPiAwKSB7XG5cdFx0XHRyZXR1cm4gdGhpcy5fY3ljbGVTY29wZWRNb2RlbChkaXJlY3Rpb24sIG9wdGlvbnMpO1xuXHRcdH1cblx0XHRyZXR1cm4gdGhpcy5fY3ljbGVBdmFpbGFibGVNb2RlbChkaXJlY3Rpb24sIG9wdGlvbnMpO1xuXHR9XG5cblx0cHJpdmF0ZSBfZ2V0UmVhZHlTY29wZWRNb2RlbHMoKTogQXJyYXk8eyBtb2RlbDogTW9kZWw8YW55PjsgdGhpbmtpbmdMZXZlbD86IFRoaW5raW5nTGV2ZWwgfT4ge1xuXHRcdHJldHVybiB0aGlzLl9zY29wZWRNb2RlbHMuZmlsdGVyKChzY29wZWQpID0+XG5cdFx0XHR0aGlzLl9tb2RlbFJlZ2lzdHJ5LmlzUHJvdmlkZXJSZXF1ZXN0UmVhZHkoc2NvcGVkLm1vZGVsLnByb3ZpZGVyKSxcblx0XHQpO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBfY3ljbGVTY29wZWRNb2RlbChkaXJlY3Rpb246IFwiZm9yd2FyZFwiIHwgXCJiYWNrd2FyZFwiLCBvcHRpb25zPzogeyBwZXJzaXN0PzogYm9vbGVhbiB9KTogUHJvbWlzZTxNb2RlbEN5Y2xlUmVzdWx0IHwgdW5kZWZpbmVkPiB7XG5cdFx0Y29uc3Qgc2NvcGVkTW9kZWxzID0gdGhpcy5fZ2V0UmVhZHlTY29wZWRNb2RlbHMoKTtcblx0XHRpZiAoc2NvcGVkTW9kZWxzLmxlbmd0aCA8PSAxKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdFx0Y29uc3QgY3VycmVudE1vZGVsID0gdGhpcy5tb2RlbDtcblx0XHRsZXQgY3VycmVudEluZGV4ID0gc2NvcGVkTW9kZWxzLmZpbmRJbmRleCgoc20pID0+IG1vZGVsc0FyZUVxdWFsKHNtLm1vZGVsLCBjdXJyZW50TW9kZWwpKTtcblxuXHRcdGlmIChjdXJyZW50SW5kZXggPT09IC0xKSBjdXJyZW50SW5kZXggPSAwO1xuXHRcdGNvbnN0IGxlbiA9IHNjb3BlZE1vZGVscy5sZW5ndGg7XG5cdFx0Y29uc3QgbmV4dEluZGV4ID0gZGlyZWN0aW9uID09PSBcImZvcndhcmRcIiA/IChjdXJyZW50SW5kZXggKyAxKSAlIGxlbiA6IChjdXJyZW50SW5kZXggLSAxICsgbGVuKSAlIGxlbjtcblx0XHRjb25zdCBuZXh0ID0gc2NvcGVkTW9kZWxzW25leHRJbmRleF07XG5cblx0XHQvLyBFeHBsaWNpdCBzY29wZWQgbW9kZWwgdGhpbmtpbmcgbGV2ZWwgb3ZlcnJpZGVzIGN1cnJlbnQgc2Vzc2lvbiBsZXZlbDtcblx0XHQvLyB1bmRlZmluZWQgc2NvcGVkIG1vZGVsIHRoaW5raW5nIGxldmVsIGluaGVyaXRzIHRoZSBjdXJyZW50IHNlc3Npb24gcHJlZmVyZW5jZS5cblx0XHRjb25zdCB0aGlua2luZ0xldmVsID0gdGhpcy5fZ2V0VGhpbmtpbmdMZXZlbEZvck1vZGVsU3dpdGNoKG5leHQudGhpbmtpbmdMZXZlbCk7XG5cdFx0YXdhaXQgdGhpcy5fYXBwbHlNb2RlbENoYW5nZShuZXh0Lm1vZGVsLCB0aGlua2luZ0xldmVsLCBcImN5Y2xlXCIsIG9wdGlvbnMpO1xuXG5cdFx0cmV0dXJuIHsgbW9kZWw6IG5leHQubW9kZWwsIHRoaW5raW5nTGV2ZWw6IHRoaXMudGhpbmtpbmdMZXZlbCwgaXNTY29wZWQ6IHRydWUgfTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX2N5Y2xlQXZhaWxhYmxlTW9kZWwoZGlyZWN0aW9uOiBcImZvcndhcmRcIiB8IFwiYmFja3dhcmRcIiwgb3B0aW9ucz86IHsgcGVyc2lzdD86IGJvb2xlYW4gfSk6IFByb21pc2U8TW9kZWxDeWNsZVJlc3VsdCB8IHVuZGVmaW5lZD4ge1xuXHRcdGNvbnN0IGF2YWlsYWJsZU1vZGVscyA9IGF3YWl0IHRoaXMuX21vZGVsUmVnaXN0cnkuZ2V0QXZhaWxhYmxlKCk7XG5cdFx0aWYgKGF2YWlsYWJsZU1vZGVscy5sZW5ndGggPD0gMSkgcmV0dXJuIHVuZGVmaW5lZDtcblxuXHRcdGNvbnN0IGN1cnJlbnRNb2RlbCA9IHRoaXMubW9kZWw7XG5cdFx0bGV0IGN1cnJlbnRJbmRleCA9IGF2YWlsYWJsZU1vZGVscy5maW5kSW5kZXgoKG0pID0+IG1vZGVsc0FyZUVxdWFsKG0sIGN1cnJlbnRNb2RlbCkpO1xuXG5cdFx0aWYgKGN1cnJlbnRJbmRleCA9PT0gLTEpIGN1cnJlbnRJbmRleCA9IDA7XG5cdFx0Y29uc3QgbGVuID0gYXZhaWxhYmxlTW9kZWxzLmxlbmd0aDtcblx0XHRjb25zdCBuZXh0SW5kZXggPSBkaXJlY3Rpb24gPT09IFwiZm9yd2FyZFwiID8gKGN1cnJlbnRJbmRleCArIDEpICUgbGVuIDogKGN1cnJlbnRJbmRleCAtIDEgKyBsZW4pICUgbGVuO1xuXHRcdGNvbnN0IG5leHRNb2RlbCA9IGF2YWlsYWJsZU1vZGVsc1tuZXh0SW5kZXhdO1xuXG5cdFx0Y29uc3QgdGhpbmtpbmdMZXZlbCA9IHRoaXMuX2dldFRoaW5raW5nTGV2ZWxGb3JNb2RlbFN3aXRjaCgpO1xuXHRcdGF3YWl0IHRoaXMuX2FwcGx5TW9kZWxDaGFuZ2UobmV4dE1vZGVsLCB0aGlua2luZ0xldmVsLCBcImN5Y2xlXCIsIG9wdGlvbnMpO1xuXG5cdFx0cmV0dXJuIHsgbW9kZWw6IG5leHRNb2RlbCwgdGhpbmtpbmdMZXZlbDogdGhpcy50aGlua2luZ0xldmVsLCBpc1Njb3BlZDogZmFsc2UgfTtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gVGhpbmtpbmcgTGV2ZWwgTWFuYWdlbWVudFxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIFNldCB0aGlua2luZyBsZXZlbC5cblx0ICogQ2xhbXBzIHRvIG1vZGVsIGNhcGFiaWxpdGllcyBiYXNlZCBvbiBhdmFpbGFibGUgdGhpbmtpbmcgbGV2ZWxzLlxuXHQgKiBTYXZlcyB0byBzZXNzaW9uIGFuZCBzZXR0aW5ncyBvbmx5IGlmIHRoZSBsZXZlbCBhY3R1YWxseSBjaGFuZ2VzLlxuXHQgKi9cblx0c2V0VGhpbmtpbmdMZXZlbChsZXZlbDogVGhpbmtpbmdMZXZlbCk6IHZvaWQge1xuXHRcdGNvbnN0IGF2YWlsYWJsZUxldmVscyA9IHRoaXMuZ2V0QXZhaWxhYmxlVGhpbmtpbmdMZXZlbHMoKTtcblx0XHRjb25zdCBlZmZlY3RpdmVMZXZlbCA9IGF2YWlsYWJsZUxldmVscy5pbmNsdWRlcyhsZXZlbCkgPyBsZXZlbCA6IHRoaXMuX2NsYW1wVGhpbmtpbmdMZXZlbChsZXZlbCwgYXZhaWxhYmxlTGV2ZWxzKTtcblxuXHRcdC8vIE9ubHkgcGVyc2lzdCBpZiBhY3R1YWxseSBjaGFuZ2luZ1xuXHRcdGNvbnN0IGlzQ2hhbmdpbmcgPSBlZmZlY3RpdmVMZXZlbCAhPT0gdGhpcy5hZ2VudC5zdGF0ZS50aGlua2luZ0xldmVsO1xuXG5cdFx0dGhpcy5hZ2VudC5zZXRUaGlua2luZ0xldmVsKGVmZmVjdGl2ZUxldmVsKTtcblxuXHRcdGlmIChpc0NoYW5naW5nKSB7XG5cdFx0XHR0aGlzLnNlc3Npb25NYW5hZ2VyLmFwcGVuZFRoaW5raW5nTGV2ZWxDaGFuZ2UoZWZmZWN0aXZlTGV2ZWwpO1xuXHRcdFx0aWYgKGVmZmVjdGl2ZUxldmVsICE9PSBcIm9mZlwiKSB7XG5cdFx0XHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldERlZmF1bHRUaGlua2luZ0xldmVsKGVmZmVjdGl2ZUxldmVsKTtcblx0XHRcdH1cblx0XHRcdHRoaXMuX2VtaXRTZXNzaW9uU3RhdGVDaGFuZ2VkKFwic2V0X3RoaW5raW5nX2xldmVsXCIpO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBDeWNsZSB0byBuZXh0IHRoaW5raW5nIGxldmVsLlxuXHQgKiBAcmV0dXJucyBOZXcgbGV2ZWwsIG9yIHVuZGVmaW5lZCBpZiBtb2RlbCBkb2Vzbid0IHN1cHBvcnQgdGhpbmtpbmdcblx0ICovXG5cdGN5Y2xlVGhpbmtpbmdMZXZlbCgpOiBUaGlua2luZ0xldmVsIHwgdW5kZWZpbmVkIHtcblx0XHRpZiAoIXRoaXMuc3VwcG9ydHNUaGlua2luZygpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG5cdFx0Y29uc3QgbGV2ZWxzID0gdGhpcy5nZXRBdmFpbGFibGVUaGlua2luZ0xldmVscygpO1xuXHRcdGNvbnN0IGN1cnJlbnRJbmRleCA9IGxldmVscy5pbmRleE9mKHRoaXMudGhpbmtpbmdMZXZlbCk7XG5cdFx0Y29uc3QgbmV4dEluZGV4ID0gKGN1cnJlbnRJbmRleCArIDEpICUgbGV2ZWxzLmxlbmd0aDtcblx0XHRjb25zdCBuZXh0TGV2ZWwgPSBsZXZlbHNbbmV4dEluZGV4XTtcblxuXHRcdHRoaXMuc2V0VGhpbmtpbmdMZXZlbChuZXh0TGV2ZWwpO1xuXHRcdHJldHVybiBuZXh0TGV2ZWw7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGF2YWlsYWJsZSB0aGlua2luZyBsZXZlbHMgZm9yIGN1cnJlbnQgbW9kZWwuXG5cdCAqIFRoZSBwcm92aWRlciB3aWxsIGNsYW1wIHRvIHdoYXQgdGhlIHNwZWNpZmljIG1vZGVsIHN1cHBvcnRzIGludGVybmFsbHkuXG5cdCAqL1xuXHRnZXRBdmFpbGFibGVUaGlua2luZ0xldmVscygpOiBUaGlua2luZ0xldmVsW10ge1xuXHRcdGlmICghdGhpcy5zdXBwb3J0c1RoaW5raW5nKCkpIHJldHVybiBbXCJvZmZcIl07XG5cdFx0cmV0dXJuIHRoaXMuc3VwcG9ydHNYaGlnaFRoaW5raW5nKCkgPyBUSElOS0lOR19MRVZFTFNfV0lUSF9YSElHSCA6IFRISU5LSU5HX0xFVkVMUztcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiBjdXJyZW50IG1vZGVsIHN1cHBvcnRzIHhoaWdoIHRoaW5raW5nIGxldmVsLlxuXHQgKi9cblx0c3VwcG9ydHNYaGlnaFRoaW5raW5nKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLm1vZGVsID8gc3VwcG9ydHNYaGlnaCh0aGlzLm1vZGVsKSA6IGZhbHNlO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGlmIGN1cnJlbnQgbW9kZWwgc3VwcG9ydHMgdGhpbmtpbmcvcmVhc29uaW5nLlxuXHQgKi9cblx0c3VwcG9ydHNUaGlua2luZygpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gISF0aGlzLm1vZGVsPy5yZWFzb25pbmc7XG5cdH1cblxuXHRwcml2YXRlIF9nZXRUaGlua2luZ0xldmVsRm9yTW9kZWxTd2l0Y2goZXhwbGljaXRMZXZlbD86IFRoaW5raW5nTGV2ZWwpOiBUaGlua2luZ0xldmVsIHtcblx0XHRpZiAoZXhwbGljaXRMZXZlbCAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRyZXR1cm4gZXhwbGljaXRMZXZlbDtcblx0XHR9XG5cdFx0aWYgKCF0aGlzLnN1cHBvcnRzVGhpbmtpbmcoKSkge1xuXHRcdFx0cmV0dXJuIHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldERlZmF1bHRUaGlua2luZ0xldmVsKCkgPz8gREVGQVVMVF9USElOS0lOR19MRVZFTDtcblx0XHR9XG5cdFx0cmV0dXJuIHRoaXMudGhpbmtpbmdMZXZlbDtcblx0fVxuXG5cdHByaXZhdGUgX2NsYW1wVGhpbmtpbmdMZXZlbChsZXZlbDogVGhpbmtpbmdMZXZlbCwgYXZhaWxhYmxlTGV2ZWxzOiBUaGlua2luZ0xldmVsW10pOiBUaGlua2luZ0xldmVsIHtcblx0XHRjb25zdCBvcmRlcmVkID0gVEhJTktJTkdfTEVWRUxTX1dJVEhfWEhJR0g7XG5cdFx0Y29uc3QgYXZhaWxhYmxlID0gbmV3IFNldChhdmFpbGFibGVMZXZlbHMpO1xuXHRcdGNvbnN0IHJlcXVlc3RlZEluZGV4ID0gb3JkZXJlZC5pbmRleE9mKGxldmVsKTtcblx0XHRpZiAocmVxdWVzdGVkSW5kZXggPT09IC0xKSB7XG5cdFx0XHRyZXR1cm4gYXZhaWxhYmxlTGV2ZWxzWzBdID8/IFwib2ZmXCI7XG5cdFx0fVxuXHRcdGZvciAobGV0IGkgPSByZXF1ZXN0ZWRJbmRleDsgaSA8IG9yZGVyZWQubGVuZ3RoOyBpKyspIHtcblx0XHRcdGNvbnN0IGNhbmRpZGF0ZSA9IG9yZGVyZWRbaV07XG5cdFx0XHRpZiAoYXZhaWxhYmxlLmhhcyhjYW5kaWRhdGUpKSByZXR1cm4gY2FuZGlkYXRlO1xuXHRcdH1cblx0XHRmb3IgKGxldCBpID0gcmVxdWVzdGVkSW5kZXggLSAxOyBpID49IDA7IGktLSkge1xuXHRcdFx0Y29uc3QgY2FuZGlkYXRlID0gb3JkZXJlZFtpXTtcblx0XHRcdGlmIChhdmFpbGFibGUuaGFzKGNhbmRpZGF0ZSkpIHJldHVybiBjYW5kaWRhdGU7XG5cdFx0fVxuXHRcdHJldHVybiBhdmFpbGFibGVMZXZlbHNbMF0gPz8gXCJvZmZcIjtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gUXVldWUgTW9kZSBNYW5hZ2VtZW50XG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHQvKipcblx0ICogU2V0IHN0ZWVyaW5nIG1lc3NhZ2UgbW9kZS5cblx0ICogU2F2ZXMgdG8gc2V0dGluZ3MuXG5cdCAqL1xuXHRzZXRTdGVlcmluZ01vZGUobW9kZTogXCJhbGxcIiB8IFwib25lLWF0LWEtdGltZVwiKTogdm9pZCB7XG5cdFx0dGhpcy5hZ2VudC5zZXRTdGVlcmluZ01vZGUobW9kZSk7XG5cdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0U3RlZXJpbmdNb2RlKG1vZGUpO1xuXHRcdHRoaXMuX2VtaXRTZXNzaW9uU3RhdGVDaGFuZ2VkKFwic2V0X3N0ZWVyaW5nX21vZGVcIik7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGZvbGxvdy11cCBtZXNzYWdlIG1vZGUuXG5cdCAqIFNhdmVzIHRvIHNldHRpbmdzLlxuXHQgKi9cblx0c2V0Rm9sbG93VXBNb2RlKG1vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIik6IHZvaWQge1xuXHRcdHRoaXMuYWdlbnQuc2V0Rm9sbG93VXBNb2RlKG1vZGUpO1xuXHRcdHRoaXMuc2V0dGluZ3NNYW5hZ2VyLnNldEZvbGxvd1VwTW9kZShtb2RlKTtcblx0XHR0aGlzLl9lbWl0U2Vzc2lvblN0YXRlQ2hhbmdlZChcInNldF9mb2xsb3dfdXBfbW9kZVwiKTtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gQ29tcGFjdGlvblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIE1hbnVhbGx5IGNvbXBhY3QgdGhlIHNlc3Npb24gY29udGV4dC5cblx0ICogQWJvcnRzIGN1cnJlbnQgYWdlbnQgb3BlcmF0aW9uIGZpcnN0LlxuXHQgKiBAcGFyYW0gY3VzdG9tSW5zdHJ1Y3Rpb25zIE9wdGlvbmFsIGluc3RydWN0aW9ucyBmb3IgdGhlIGNvbXBhY3Rpb24gc3VtbWFyeVxuXHQgKi9cblx0YXN5bmMgY29tcGFjdChjdXN0b21JbnN0cnVjdGlvbnM/OiBzdHJpbmcpOiBQcm9taXNlPENvbXBhY3Rpb25SZXN1bHQ+IHtcblx0XHRyZXR1cm4gdGhpcy5fY29tcGFjdGlvbk9yY2hlc3RyYXRvci5jb21wYWN0KGN1c3RvbUluc3RydWN0aW9ucyk7XG5cdH1cblxuXHQvKiogQ2FuY2VsIGluLXByb2dyZXNzIGNvbXBhY3Rpb24gKG1hbnVhbCBvciBhdXRvKSAqL1xuXHRhYm9ydENvbXBhY3Rpb24oKTogdm9pZCB7XG5cdFx0dGhpcy5fY29tcGFjdGlvbk9yY2hlc3RyYXRvci5hYm9ydENvbXBhY3Rpb24oKTtcblx0fVxuXG5cdC8qKiBDYW5jZWwgaW4tcHJvZ3Jlc3MgYnJhbmNoIHN1bW1hcml6YXRpb24gKi9cblx0YWJvcnRCcmFuY2hTdW1tYXJ5KCk6IHZvaWQge1xuXHRcdHRoaXMuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IuYWJvcnRCcmFuY2hTdW1tYXJ5KCk7XG5cdH1cblxuXHQvKiogVG9nZ2xlIGF1dG8tY29tcGFjdGlvbiBzZXR0aW5nICovXG5cdHNldEF1dG9Db21wYWN0aW9uRW5hYmxlZChlbmFibGVkOiBib29sZWFuKTogdm9pZCB7XG5cdFx0dGhpcy5fY29tcGFjdGlvbk9yY2hlc3RyYXRvci5zZXRBdXRvQ29tcGFjdGlvbkVuYWJsZWQoZW5hYmxlZCk7XG5cdFx0dGhpcy5fZW1pdFNlc3Npb25TdGF0ZUNoYW5nZWQoXCJzZXRfYXV0b19jb21wYWN0aW9uXCIpO1xuXHR9XG5cblx0LyoqIFdoZXRoZXIgYXV0by1jb21wYWN0aW9uIGlzIGVuYWJsZWQgKi9cblx0Z2V0IGF1dG9Db21wYWN0aW9uRW5hYmxlZCgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5fY29tcGFjdGlvbk9yY2hlc3RyYXRvci5hdXRvQ29tcGFjdGlvbkVuYWJsZWQ7XG5cdH1cblxuXHRhc3luYyBiaW5kRXh0ZW5zaW9ucyhiaW5kaW5nczogRXh0ZW5zaW9uQmluZGluZ3MpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAoYmluZGluZ3MudWlDb250ZXh0ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdHRoaXMuX2V4dGVuc2lvblVJQ29udGV4dCA9IGJpbmRpbmdzLnVpQ29udGV4dDtcblx0XHR9XG5cdFx0aWYgKGJpbmRpbmdzLmNvbW1hbmRDb250ZXh0QWN0aW9ucyAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHR0aGlzLl9leHRlbnNpb25Db21tYW5kQ29udGV4dEFjdGlvbnMgPSBiaW5kaW5ncy5jb21tYW5kQ29udGV4dEFjdGlvbnM7XG5cdFx0fVxuXHRcdGlmIChiaW5kaW5ncy5zaHV0ZG93bkhhbmRsZXIgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0dGhpcy5fZXh0ZW5zaW9uU2h1dGRvd25IYW5kbGVyID0gYmluZGluZ3Muc2h1dGRvd25IYW5kbGVyO1xuXHRcdH1cblx0XHRpZiAoYmluZGluZ3Mub25FcnJvciAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHR0aGlzLl9leHRlbnNpb25FcnJvckxpc3RlbmVyID0gYmluZGluZ3Mub25FcnJvcjtcblx0XHR9XG5cblx0XHRpZiAodGhpcy5fZXh0ZW5zaW9uUnVubmVyKSB7XG5cdFx0XHR0aGlzLl9hcHBseUV4dGVuc2lvbkJpbmRpbmdzKHRoaXMuX2V4dGVuc2lvblJ1bm5lcik7XG5cdFx0XHRhd2FpdCB0aGlzLl9leHRlbnNpb25SdW5uZXIuZW1pdCh7IHR5cGU6IFwic2Vzc2lvbl9zdGFydFwiIH0pO1xuXHRcdFx0YXdhaXQgdGhpcy5leHRlbmRSZXNvdXJjZXNGcm9tRXh0ZW5zaW9ucyhcInN0YXJ0dXBcIik7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBleHRlbmRSZXNvdXJjZXNGcm9tRXh0ZW5zaW9ucyhyZWFzb246IFwic3RhcnR1cFwiIHwgXCJyZWxvYWRcIik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICghdGhpcy5fZXh0ZW5zaW9uUnVubmVyPy5oYXNIYW5kbGVycyhcInJlc291cmNlc19kaXNjb3ZlclwiKSkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHsgc2tpbGxQYXRocywgcHJvbXB0UGF0aHMsIHRoZW1lUGF0aHMgfSA9IGF3YWl0IHRoaXMuX2V4dGVuc2lvblJ1bm5lci5lbWl0UmVzb3VyY2VzRGlzY292ZXIoXG5cdFx0XHR0aGlzLl9jd2QsXG5cdFx0XHRyZWFzb24sXG5cdFx0KTtcblxuXHRcdGlmIChza2lsbFBhdGhzLmxlbmd0aCA9PT0gMCAmJiBwcm9tcHRQYXRocy5sZW5ndGggPT09IDAgJiYgdGhlbWVQYXRocy5sZW5ndGggPT09IDApIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBleHRlbnNpb25QYXRoczogUmVzb3VyY2VFeHRlbnNpb25QYXRocyA9IHtcblx0XHRcdHNraWxsUGF0aHM6IHRoaXMuYnVpbGRFeHRlbnNpb25SZXNvdXJjZVBhdGhzKHNraWxsUGF0aHMpLFxuXHRcdFx0cHJvbXB0UGF0aHM6IHRoaXMuYnVpbGRFeHRlbnNpb25SZXNvdXJjZVBhdGhzKHByb21wdFBhdGhzKSxcblx0XHRcdHRoZW1lUGF0aHM6IHRoaXMuYnVpbGRFeHRlbnNpb25SZXNvdXJjZVBhdGhzKHRoZW1lUGF0aHMpLFxuXHRcdH07XG5cblx0XHR0aGlzLl9yZXNvdXJjZUxvYWRlci5leHRlbmRSZXNvdXJjZXMoZXh0ZW5zaW9uUGF0aHMpO1xuXHRcdHRoaXMuX2Jhc2VTeXN0ZW1Qcm9tcHQgPSB0aGlzLl9yZWJ1aWxkU3lzdGVtUHJvbXB0KHRoaXMuZ2V0QWN0aXZlVG9vbE5hbWVzKCkpO1xuXHRcdHRoaXMuYWdlbnQuc2V0U3lzdGVtUHJvbXB0KHRoaXMuX2Jhc2VTeXN0ZW1Qcm9tcHQpO1xuXHR9XG5cblx0cHJpdmF0ZSBidWlsZEV4dGVuc2lvblJlc291cmNlUGF0aHMoZW50cmllczogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IGV4dGVuc2lvblBhdGg6IHN0cmluZyB9Pik6IEFycmF5PHtcblx0XHRwYXRoOiBzdHJpbmc7XG5cdFx0bWV0YWRhdGE6IHsgc291cmNlOiBzdHJpbmc7IHNjb3BlOiBcInRlbXBvcmFyeVwiOyBvcmlnaW46IFwidG9wLWxldmVsXCI7IGJhc2VEaXI/OiBzdHJpbmcgfTtcblx0fT4ge1xuXHRcdHJldHVybiBlbnRyaWVzLm1hcCgoZW50cnkpID0+IHtcblx0XHRcdGNvbnN0IHNvdXJjZSA9IHRoaXMuZ2V0RXh0ZW5zaW9uU291cmNlTGFiZWwoZW50cnkuZXh0ZW5zaW9uUGF0aCk7XG5cdFx0XHRjb25zdCBiYXNlRGlyID0gZW50cnkuZXh0ZW5zaW9uUGF0aC5zdGFydHNXaXRoKFwiPFwiKSA/IHVuZGVmaW5lZCA6IGRpcm5hbWUoZW50cnkuZXh0ZW5zaW9uUGF0aCk7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRwYXRoOiBlbnRyeS5wYXRoLFxuXHRcdFx0XHRtZXRhZGF0YToge1xuXHRcdFx0XHRcdHNvdXJjZSxcblx0XHRcdFx0XHRzY29wZTogXCJ0ZW1wb3JhcnlcIixcblx0XHRcdFx0XHRvcmlnaW46IFwidG9wLWxldmVsXCIsXG5cdFx0XHRcdFx0YmFzZURpcixcblx0XHRcdFx0fSxcblx0XHRcdH07XG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGdldEV4dGVuc2lvblNvdXJjZUxhYmVsKGV4dGVuc2lvblBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0aWYgKGV4dGVuc2lvblBhdGguc3RhcnRzV2l0aChcIjxcIikpIHtcblx0XHRcdHJldHVybiBgZXh0ZW5zaW9uOiR7ZXh0ZW5zaW9uUGF0aC5yZXBsYWNlKC9bPD5dL2csIFwiXCIpfWA7XG5cdFx0fVxuXHRcdGNvbnN0IGJhc2UgPSBiYXNlbmFtZShleHRlbnNpb25QYXRoKTtcblx0XHRjb25zdCBuYW1lID0gYmFzZS5yZXBsYWNlKC9cXC4odHN8anMpJC8sIFwiXCIpO1xuXHRcdHJldHVybiBgZXh0ZW5zaW9uOiR7bmFtZX1gO1xuXHR9XG5cblx0cHJpdmF0ZSBfYXBwbHlFeHRlbnNpb25CaW5kaW5ncyhydW5uZXI6IEV4dGVuc2lvblJ1bm5lcik6IHZvaWQge1xuXHRcdHJ1bm5lci5zZXRVSUNvbnRleHQodGhpcy5fZXh0ZW5zaW9uVUlDb250ZXh0KTtcblx0XHRydW5uZXIuYmluZENvbW1hbmRDb250ZXh0KHRoaXMuX2V4dGVuc2lvbkNvbW1hbmRDb250ZXh0QWN0aW9ucyk7XG5cblx0XHR0cnkge1xuXHRcdFx0dGhpcy5fZXh0ZW5zaW9uRXJyb3JVbnN1YnNjcmliZXI/LigpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gSWdub3JlIGVycm9ycyBmcm9tIHByZXZpb3VzIHVuc3Vic2NyaWJlclxuXHRcdH1cblx0XHR0aGlzLl9leHRlbnNpb25FcnJvclVuc3Vic2NyaWJlciA9IHRoaXMuX2V4dGVuc2lvbkVycm9yTGlzdGVuZXJcblx0XHRcdD8gcnVubmVyLm9uRXJyb3IodGhpcy5fZXh0ZW5zaW9uRXJyb3JMaXN0ZW5lcilcblx0XHRcdDogdW5kZWZpbmVkO1xuXHR9XG5cblx0cHJpdmF0ZSBfYmluZEV4dGVuc2lvbkNvcmUocnVubmVyOiBFeHRlbnNpb25SdW5uZXIpOiB2b2lkIHtcblx0XHRjb25zdCBub3JtYWxpemVMb2NhdGlvbiA9IChzb3VyY2U6IHN0cmluZyk6IFNsYXNoQ29tbWFuZExvY2F0aW9uIHwgdW5kZWZpbmVkID0+IHtcblx0XHRcdGlmIChzb3VyY2UgPT09IFwidXNlclwiIHx8IHNvdXJjZSA9PT0gXCJwcm9qZWN0XCIgfHwgc291cmNlID09PSBcInBhdGhcIikge1xuXHRcdFx0XHRyZXR1cm4gc291cmNlO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHR9O1xuXG5cdFx0Y29uc3QgcmVzZXJ2ZWRCdWlsdGlucyA9IG5ldyBTZXQoQlVJTFRJTl9TTEFTSF9DT01NQU5EUy5tYXAoKGNvbW1hbmQpID0+IGNvbW1hbmQubmFtZSkpO1xuXG5cdFx0Y29uc3QgZ2V0Q29tbWFuZHMgPSAoKTogU2xhc2hDb21tYW5kSW5mb1tdID0+IHtcblx0XHRcdGNvbnN0IGV4dGVuc2lvbkNvbW1hbmRzOiBTbGFzaENvbW1hbmRJbmZvW10gPSBydW5uZXJcblx0XHRcdFx0LmdldFJlZ2lzdGVyZWRDb21tYW5kc1dpdGhQYXRocygpXG5cdFx0XHRcdC5maWx0ZXIoKHsgY29tbWFuZCB9KSA9PiAhcmVzZXJ2ZWRCdWlsdGlucy5oYXMoY29tbWFuZC5uYW1lKSlcblx0XHRcdFx0Lm1hcCgoeyBjb21tYW5kLCBleHRlbnNpb25QYXRoIH0pID0+ICh7XG5cdFx0XHRcdFx0bmFtZTogY29tbWFuZC5uYW1lLFxuXHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBjb21tYW5kLmRlc2NyaXB0aW9uLFxuXHRcdFx0XHRcdHNvdXJjZTogXCJleHRlbnNpb25cIixcblx0XHRcdFx0XHRwYXRoOiBleHRlbnNpb25QYXRoLFxuXHRcdFx0XHR9KSk7XG5cblx0XHRcdGNvbnN0IHRlbXBsYXRlczogU2xhc2hDb21tYW5kSW5mb1tdID0gdGhpcy5wcm9tcHRUZW1wbGF0ZXMubWFwKCh0ZW1wbGF0ZSkgPT4gKHtcblx0XHRcdFx0bmFtZTogdGVtcGxhdGUubmFtZSxcblx0XHRcdFx0ZGVzY3JpcHRpb246IHRlbXBsYXRlLmRlc2NyaXB0aW9uLFxuXHRcdFx0XHRzb3VyY2U6IFwicHJvbXB0XCIsXG5cdFx0XHRcdGxvY2F0aW9uOiBub3JtYWxpemVMb2NhdGlvbih0ZW1wbGF0ZS5zb3VyY2UpLFxuXHRcdFx0XHRwYXRoOiB0ZW1wbGF0ZS5maWxlUGF0aCxcblx0XHRcdH0pKTtcblxuXHRcdFx0Y29uc3Qgc2tpbGxzOiBTbGFzaENvbW1hbmRJbmZvW10gPSB0aGlzLl9yZXNvdXJjZUxvYWRlci5nZXRTa2lsbHMoKS5za2lsbHMubWFwKChza2lsbCkgPT4gKHtcblx0XHRcdFx0bmFtZTogYHNraWxsOiR7c2tpbGwubmFtZX1gLFxuXHRcdFx0XHRkZXNjcmlwdGlvbjogc2tpbGwuZGVzY3JpcHRpb24sXG5cdFx0XHRcdHNvdXJjZTogXCJza2lsbFwiLFxuXHRcdFx0XHRsb2NhdGlvbjogbm9ybWFsaXplTG9jYXRpb24oc2tpbGwuc291cmNlKSxcblx0XHRcdFx0cGF0aDogc2tpbGwuZmlsZVBhdGgsXG5cdFx0XHR9KSk7XG5cblx0XHRcdHJldHVybiBbLi4uZXh0ZW5zaW9uQ29tbWFuZHMsIC4uLnRlbXBsYXRlcywgLi4uc2tpbGxzXTtcblx0XHR9O1xuXG5cdFx0cnVubmVyLmJpbmRDb3JlKFxuXHRcdFx0e1xuXHRcdFx0XHRzZW5kTWVzc2FnZTogKG1lc3NhZ2UsIG9wdGlvbnMpID0+IHtcblx0XHRcdFx0XHR0aGlzLnNlbmRDdXN0b21NZXNzYWdlKG1lc3NhZ2UsIG9wdGlvbnMpLmNhdGNoKChlcnIpID0+IHtcblx0XHRcdFx0XHRcdHJ1bm5lci5lbWl0RXJyb3Ioe1xuXHRcdFx0XHRcdFx0XHRleHRlbnNpb25QYXRoOiBcIjxydW50aW1lPlwiLFxuXHRcdFx0XHRcdFx0XHRldmVudDogXCJzZW5kX21lc3NhZ2VcIixcblx0XHRcdFx0XHRcdFx0ZXJyb3I6IGdldEVycm9yTWVzc2FnZShlcnIpLFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdHNlbmRVc2VyTWVzc2FnZTogKGNvbnRlbnQsIG9wdGlvbnMpID0+IHtcblx0XHRcdFx0XHR0aGlzLnNlbmRVc2VyTWVzc2FnZShjb250ZW50LCBvcHRpb25zKS5jYXRjaCgoZXJyKSA9PiB7XG5cdFx0XHRcdFx0XHRydW5uZXIuZW1pdEVycm9yKHtcblx0XHRcdFx0XHRcdFx0ZXh0ZW5zaW9uUGF0aDogXCI8cnVudGltZT5cIixcblx0XHRcdFx0XHRcdFx0ZXZlbnQ6IFwic2VuZF91c2VyX21lc3NhZ2VcIixcblx0XHRcdFx0XHRcdFx0ZXJyb3I6IGdldEVycm9yTWVzc2FnZShlcnIpLFxuXHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdHJldHJ5TGFzdFR1cm46ICgpID0+IHtcblx0XHRcdFx0XHRjb25zdCBtZXNzYWdlcyA9IHRoaXMuYWdlbnQuc3RhdGUubWVzc2FnZXM7XG5cdFx0XHRcdFx0Y29uc3QgbGFzdCA9IG1lc3NhZ2VzW21lc3NhZ2VzLmxlbmd0aCAtIDFdO1xuXHRcdFx0XHRcdGlmIChsYXN0Py5yb2xlID09PSBcImFzc2lzdGFudFwiICYmIChsYXN0IGFzIEFzc2lzdGFudE1lc3NhZ2UpLnN0b3BSZWFzb24gPT09IFwiZXJyb3JcIikge1xuXHRcdFx0XHRcdFx0Ly8gSWYgdGhlIGVycm9yIHdhcyBhbiBpbWFnZSBkaW1lbnNpb24gb3ZlcmZsb3csIGRvd25zaXplIGltYWdlc1xuXHRcdFx0XHRcdFx0Ly8gYmVmb3JlIHJldHJ5aW5nIHNvIHRoZSByZXRyeSBkb2Vzbid0IGhpdCB0aGUgc2FtZSBlcnJvciAoIzI4NzQpXG5cdFx0XHRcdFx0XHRpZiAoaXNJbWFnZURpbWVuc2lvbkVycm9yKChsYXN0IGFzIEFzc2lzdGFudE1lc3NhZ2UpLmVycm9yTWVzc2FnZSkpIHtcblx0XHRcdFx0XHRcdFx0ZG93bnNpemVDb252ZXJzYXRpb25JbWFnZXMobWVzc2FnZXMgYXMgTWVzc2FnZVtdKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdHRoaXMuYWdlbnQucmVwbGFjZU1lc3NhZ2VzKG1lc3NhZ2VzLnNsaWNlKDAsIC0xKSk7XG5cdFx0XHRcdFx0XHR0aGlzLmFnZW50LmNvbnRpbnVlKCkuY2F0Y2goKGVycikgPT4ge1xuXHRcdFx0XHRcdFx0XHRydW5uZXIuZW1pdEVycm9yKHtcblx0XHRcdFx0XHRcdFx0XHRleHRlbnNpb25QYXRoOiBcIjxydW50aW1lPlwiLFxuXHRcdFx0XHRcdFx0XHRcdGV2ZW50OiBcInJldHJ5X2xhc3RfdHVyblwiLFxuXHRcdFx0XHRcdFx0XHRcdGVycm9yOiBnZXRFcnJvck1lc3NhZ2UoZXJyKSxcblx0XHRcdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0sXG5cdFx0XHRcdGFwcGVuZEVudHJ5OiAoY3VzdG9tVHlwZSwgZGF0YSkgPT4ge1xuXHRcdFx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuYXBwZW5kQ3VzdG9tRW50cnkoY3VzdG9tVHlwZSwgZGF0YSk7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdHNldFNlc3Npb25OYW1lOiAobmFtZSkgPT4ge1xuXHRcdFx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuYXBwZW5kU2Vzc2lvbkluZm8obmFtZSk7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdGdldFNlc3Npb25OYW1lOiAoKSA9PiB7XG5cdFx0XHRcdFx0cmV0dXJuIHRoaXMuc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbk5hbWUoKTtcblx0XHRcdFx0fSxcblx0XHRcdFx0c2V0TGFiZWw6IChlbnRyeUlkLCBsYWJlbCkgPT4ge1xuXHRcdFx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuYXBwZW5kTGFiZWxDaGFuZ2UoZW50cnlJZCwgbGFiZWwpO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRnZXRBY3RpdmVUb29sczogKCkgPT4gdGhpcy5nZXRBY3RpdmVUb29sTmFtZXMoKSxcblx0XHRcdFx0Z2V0QWxsVG9vbHM6ICgpID0+IHRoaXMuZ2V0QWxsVG9vbHMoKSxcblx0XHRcdFx0c2V0QWN0aXZlVG9vbHM6ICh0b29sTmFtZXMpID0+IHRoaXMuc2V0QWN0aXZlVG9vbHNCeU5hbWUodG9vbE5hbWVzKSxcblx0XHRcdFx0Z2V0VmlzaWJsZVNraWxsczogKCkgPT4gdGhpcy5nZXRWaXNpYmxlU2tpbGxOYW1lcygpLFxuXHRcdFx0XHRzZXRWaXNpYmxlU2tpbGxzOiAoc2tpbGxOYW1lcykgPT4gdGhpcy5zZXRWaXNpYmxlU2tpbGxzQnlOYW1lKHNraWxsTmFtZXMpLFxuXHRcdFx0XHRyZWZyZXNoVG9vbHM6ICgpID0+IHRoaXMuX3JlZnJlc2hUb29sUmVnaXN0cnkoKSxcblx0XHRcdFx0Z2V0Q29tbWFuZHMsXG5cdFx0XHRcdHNldE1vZGVsOiBhc3luYyAobW9kZWwsIG9wdGlvbnMpID0+IHtcblx0XHRcdFx0XHRpZiAoIXRoaXMubW9kZWxSZWdpc3RyeS5pc1Byb3ZpZGVyUmVxdWVzdFJlYWR5KG1vZGVsLnByb3ZpZGVyKSkgcmV0dXJuIGZhbHNlO1xuXHRcdFx0XHRcdGF3YWl0IHRoaXMuc2V0TW9kZWwobW9kZWwsIG9wdGlvbnMpO1xuXHRcdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRnZXRUaGlua2luZ0xldmVsOiAoKSA9PiB0aGlzLnRoaW5raW5nTGV2ZWwsXG5cdFx0XHRcdHNldFRoaW5raW5nTGV2ZWw6IChsZXZlbCkgPT4gdGhpcy5zZXRUaGlua2luZ0xldmVsKGxldmVsKSxcblx0XHRcdH0sXG5cdFx0XHR7XG5cdFx0XHRcdGdldE1vZGVsOiAoKSA9PiB0aGlzLm1vZGVsLFxuXHRcdFx0XHRpc0lkbGU6ICgpID0+ICF0aGlzLmlzU3RyZWFtaW5nLFxuXHRcdFx0XHRhYm9ydDogKCkgPT4gdGhpcy5hYm9ydCh7IG9yaWdpbjogXCJ1c2VyXCIgfSksXG5cdFx0XHRcdGhhc1BlbmRpbmdNZXNzYWdlczogKCkgPT4gdGhpcy5wZW5kaW5nTWVzc2FnZUNvdW50ID4gMCxcblx0XHRcdFx0c2h1dGRvd246ICgpID0+IHtcblx0XHRcdFx0XHR0aGlzLl9leHRlbnNpb25TaHV0ZG93bkhhbmRsZXI/LigpO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRnZXRDb250ZXh0VXNhZ2U6ICgpID0+IHRoaXMuZ2V0Q29udGV4dFVzYWdlKCksXG5cdFx0XHRcdGNvbXBhY3Q6IChvcHRpb25zKSA9PiB7XG5cdFx0XHRcdFx0dm9pZCAoYXN5bmMgKCkgPT4ge1xuXHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5jb21wYWN0KG9wdGlvbnM/LmN1c3RvbUluc3RydWN0aW9ucyk7XG5cdFx0XHRcdFx0XHRcdG9wdGlvbnM/Lm9uQ29tcGxldGU/LihyZXN1bHQpO1xuXHRcdFx0XHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgZXJyID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFN0cmluZyhlcnJvcikpO1xuXHRcdFx0XHRcdFx0XHRvcHRpb25zPy5vbkVycm9yPy4oZXJyKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9KSgpO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRnZXRTeXN0ZW1Qcm9tcHQ6ICgpID0+IHRoaXMuc3lzdGVtUHJvbXB0LFxuXHRcdFx0XHRzZXRDb21wYWN0aW9uVGhyZXNob2xkT3ZlcnJpZGU6IChwZXJjZW50KSA9PiB7XG5cdFx0XHRcdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIuc2V0Q29tcGFjdGlvblRocmVzaG9sZE92ZXJyaWRlKHBlcmNlbnQpO1xuXHRcdFx0XHR9LFxuXHRcdFx0fSxcblx0XHQpO1xuXHR9XG5cblx0cHJpdmF0ZSBfcmVmcmVzaFRvb2xSZWdpc3RyeShvcHRpb25zPzogeyBhY3RpdmVUb29sTmFtZXM/OiBzdHJpbmdbXTsgaW5jbHVkZUFsbEV4dGVuc2lvblRvb2xzPzogYm9vbGVhbiB9KTogdm9pZCB7XG5cdFx0Y29uc3QgcHJldmlvdXNSZWdpc3RyeU5hbWVzID0gbmV3IFNldCh0aGlzLl90b29sUmVnaXN0cnkua2V5cygpKTtcblx0XHRjb25zdCBwcmV2aW91c0FjdGl2ZVRvb2xOYW1lcyA9IHRoaXMuZ2V0QWN0aXZlVG9vbE5hbWVzKCk7XG5cblx0XHRjb25zdCByZWdpc3RlcmVkVG9vbHMgPSB0aGlzLl9leHRlbnNpb25SdW5uZXI/LmdldEFsbFJlZ2lzdGVyZWRUb29scygpID8/IFtdO1xuXHRcdGNvbnN0IGFsbEN1c3RvbVRvb2xzID0gW1xuXHRcdFx0Li4ucmVnaXN0ZXJlZFRvb2xzLFxuXHRcdFx0Li4udGhpcy5fY3VzdG9tVG9vbHMubWFwKChkZWYpID0+ICh7IGRlZmluaXRpb246IGRlZiwgZXh0ZW5zaW9uUGF0aDogXCI8c2RrPlwiIH0pKSxcblx0XHRdO1xuXHRcdHRoaXMuX3Rvb2xQcm9tcHRTbmlwcGV0cyA9IG5ldyBNYXAoXG5cdFx0XHRhbGxDdXN0b21Ub29sc1xuXHRcdFx0XHQubWFwKChyZWdpc3RlcmVkVG9vbCkgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IHNuaXBwZXQgPSB0aGlzLl9ub3JtYWxpemVQcm9tcHRTbmlwcGV0KFxuXHRcdFx0XHRcdFx0cmVnaXN0ZXJlZFRvb2wuZGVmaW5pdGlvbi5wcm9tcHRTbmlwcGV0ID8/IHJlZ2lzdGVyZWRUb29sLmRlZmluaXRpb24uZGVzY3JpcHRpb24sXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRyZXR1cm4gc25pcHBldCA/IChbcmVnaXN0ZXJlZFRvb2wuZGVmaW5pdGlvbi5uYW1lLCBzbmlwcGV0XSBhcyBjb25zdCkgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdH0pXG5cdFx0XHRcdC5maWx0ZXIoKGVudHJ5KTogZW50cnkgaXMgcmVhZG9ubHkgW3N0cmluZywgc3RyaW5nXSA9PiBlbnRyeSAhPT0gdW5kZWZpbmVkKSxcblx0XHQpO1xuXHRcdHRoaXMuX3Rvb2xQcm9tcHRHdWlkZWxpbmVzID0gbmV3IE1hcChcblx0XHRcdGFsbEN1c3RvbVRvb2xzXG5cdFx0XHRcdC5tYXAoKHJlZ2lzdGVyZWRUb29sKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgZ3VpZGVsaW5lcyA9IHRoaXMuX25vcm1hbGl6ZVByb21wdEd1aWRlbGluZXMocmVnaXN0ZXJlZFRvb2wuZGVmaW5pdGlvbi5wcm9tcHRHdWlkZWxpbmVzKTtcblx0XHRcdFx0XHRyZXR1cm4gZ3VpZGVsaW5lcy5sZW5ndGggPiAwID8gKFtyZWdpc3RlcmVkVG9vbC5kZWZpbml0aW9uLm5hbWUsIGd1aWRlbGluZXNdIGFzIGNvbnN0KSA6IHVuZGVmaW5lZDtcblx0XHRcdFx0fSlcblx0XHRcdFx0LmZpbHRlcigoZW50cnkpOiBlbnRyeSBpcyByZWFkb25seSBbc3RyaW5nLCBzdHJpbmdbXV0gPT4gZW50cnkgIT09IHVuZGVmaW5lZCksXG5cdFx0KTtcblx0XHRjb25zdCB3cmFwcGVkRXh0ZW5zaW9uVG9vbHMgPSB0aGlzLl9leHRlbnNpb25SdW5uZXJcblx0XHRcdD8gd3JhcFJlZ2lzdGVyZWRUb29scyhhbGxDdXN0b21Ub29scywgdGhpcy5fZXh0ZW5zaW9uUnVubmVyKVxuXHRcdFx0OiBbXTtcblx0XHRjb25zdCBidWlsdGluVG9vbHMgPSB0aGlzLl9nZXRCdWlsdGluVG9vbHMoKTtcblxuXHRcdGNvbnN0IHRvb2xSZWdpc3RyeSA9IG5ldyBNYXAodGhpcy5fYmFzZVRvb2xSZWdpc3RyeSk7XG5cdFx0Zm9yIChjb25zdCB0b29sIG9mIGJ1aWx0aW5Ub29scykge1xuXHRcdFx0dG9vbFJlZ2lzdHJ5LnNldCh0b29sLm5hbWUsIHRvb2wpO1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IHRvb2wgb2Ygd3JhcHBlZEV4dGVuc2lvblRvb2xzIGFzIEFnZW50VG9vbFtdKSB7XG5cdFx0XHR0b29sUmVnaXN0cnkuc2V0KHRvb2wubmFtZSwgdG9vbCk7XG5cdFx0fVxuXG5cdFx0Ly8gVG9vbCBpbnRlcmNlcHRpb24gKHRvb2xfY2FsbC90b29sX3Jlc3VsdCBleHRlbnNpb24gZXZlbnRzKSBpcyBoYW5kbGVkIGJ5XG5cdFx0Ly8gYmVmb3JlVG9vbENhbGwvYWZ0ZXJUb29sQ2FsbCBob29rcyBpbnN0YWxsZWQgaW4gX2luc3RhbGxBZ2VudFRvb2xIb29rcygpLFxuXHRcdC8vIHdoaWNoIGF3YWl0IF9hZ2VudEV2ZW50UXVldWUgZm9yIHNhZmUgcGFyYWxsZWwgZXhlY3V0aW9uLlxuXHRcdHRoaXMuX3Rvb2xSZWdpc3RyeSA9IHRvb2xSZWdpc3RyeTtcblxuXHRcdGNvbnN0IG5leHRBY3RpdmVUb29sTmFtZXMgPSBvcHRpb25zPy5hY3RpdmVUb29sTmFtZXNcblx0XHRcdD8gWy4uLm9wdGlvbnMuYWN0aXZlVG9vbE5hbWVzXVxuXHRcdFx0OiBbLi4ucHJldmlvdXNBY3RpdmVUb29sTmFtZXNdO1xuXG5cdFx0aWYgKG9wdGlvbnM/LmluY2x1ZGVBbGxFeHRlbnNpb25Ub29scykge1xuXHRcdFx0Zm9yIChjb25zdCB0b29sIG9mIHdyYXBwZWRFeHRlbnNpb25Ub29scykge1xuXHRcdFx0XHRuZXh0QWN0aXZlVG9vbE5hbWVzLnB1c2godG9vbC5uYW1lKTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKCFvcHRpb25zPy5hY3RpdmVUb29sTmFtZXMpIHtcblx0XHRcdGZvciAoY29uc3QgdG9vbE5hbWUgb2YgdGhpcy5fdG9vbFJlZ2lzdHJ5LmtleXMoKSkge1xuXHRcdFx0XHRpZiAoIXByZXZpb3VzUmVnaXN0cnlOYW1lcy5oYXModG9vbE5hbWUpKSB7XG5cdFx0XHRcdFx0bmV4dEFjdGl2ZVRvb2xOYW1lcy5wdXNoKHRvb2xOYW1lKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHRoaXMuc2V0QWN0aXZlVG9vbHNCeU5hbWUoWy4uLm5ldyBTZXQobmV4dEFjdGl2ZVRvb2xOYW1lcyldKTtcblx0fVxuXG5cdHByaXZhdGUgX2J1aWxkUnVudGltZShvcHRpb25zOiB7XG5cdFx0YWN0aXZlVG9vbE5hbWVzPzogc3RyaW5nW107XG5cdFx0ZmxhZ1ZhbHVlcz86IE1hcDxzdHJpbmcsIGJvb2xlYW4gfCBzdHJpbmc+O1xuXHRcdGluY2x1ZGVBbGxFeHRlbnNpb25Ub29scz86IGJvb2xlYW47XG5cdH0pOiB2b2lkIHtcblx0XHRjb25zdCBhdXRvUmVzaXplSW1hZ2VzID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0SW1hZ2VBdXRvUmVzaXplKCk7XG5cdFx0Y29uc3Qgc2hlbGxDb21tYW5kUHJlZml4ID0gdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0U2hlbGxDb21tYW5kUHJlZml4KCk7XG5cdFx0Y29uc3QgYmFzZVRvb2xzID0gdGhpcy5fYmFzZVRvb2xzT3ZlcnJpZGVcblx0XHRcdD8gdGhpcy5fYmFzZVRvb2xzT3ZlcnJpZGVcblx0XHRcdDogY3JlYXRlQWxsVG9vbHModGhpcy5fY3dkLCB7XG5cdFx0XHRcdFx0cmVhZDogeyBhdXRvUmVzaXplSW1hZ2VzIH0sXG5cdFx0XHRcdFx0YmFzaDoge1xuXHRcdFx0XHRcdFx0Y29tbWFuZFByZWZpeDogc2hlbGxDb21tYW5kUHJlZml4LFxuXHRcdFx0XHRcdFx0aW50ZXJjZXB0b3I6IHtcblx0XHRcdFx0XHRcdFx0ZW5hYmxlZDogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0QmFzaEludGVyY2VwdG9yRW5hYmxlZCgpLFxuXHRcdFx0XHRcdFx0XHRydWxlczogdGhpcy5zZXR0aW5nc01hbmFnZXIuZ2V0QmFzaEludGVyY2VwdG9yUnVsZXMoKSxcblx0XHRcdFx0XHRcdH0sXG5cdFx0XHRcdFx0XHRhdmFpbGFibGVUb29sTmFtZXM6ICgpID0+IHRoaXMuZ2V0QWN0aXZlVG9vbE5hbWVzKCksXG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0fSk7XG5cblx0XHR0aGlzLl9iYXNlVG9vbFJlZ2lzdHJ5ID0gbmV3IE1hcChPYmplY3QuZW50cmllcyhiYXNlVG9vbHMpLm1hcCgoW25hbWUsIHRvb2xdKSA9PiBbbmFtZSwgdG9vbCBhcyBBZ2VudFRvb2xdKSk7XG5cblx0XHRjb25zdCBleHRlbnNpb25zUmVzdWx0ID0gdGhpcy5fcmVzb3VyY2VMb2FkZXIuZ2V0RXh0ZW5zaW9ucygpO1xuXHRcdGlmIChvcHRpb25zLmZsYWdWYWx1ZXMpIHtcblx0XHRcdGZvciAoY29uc3QgW25hbWUsIHZhbHVlXSBvZiBvcHRpb25zLmZsYWdWYWx1ZXMpIHtcblx0XHRcdFx0ZXh0ZW5zaW9uc1Jlc3VsdC5ydW50aW1lLmZsYWdWYWx1ZXMuc2V0KG5hbWUsIHZhbHVlKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRjb25zdCBoYXNFeHRlbnNpb25zID0gZXh0ZW5zaW9uc1Jlc3VsdC5leHRlbnNpb25zLmxlbmd0aCA+IDA7XG5cdFx0Y29uc3QgaGFzQ3VzdG9tVG9vbHMgPSB0aGlzLl9jdXN0b21Ub29scy5sZW5ndGggPiAwO1xuXHRcdHRoaXMuX2V4dGVuc2lvblJ1bm5lciA9XG5cdFx0XHRoYXNFeHRlbnNpb25zIHx8IGhhc0N1c3RvbVRvb2xzXG5cdFx0XHRcdD8gbmV3IEV4dGVuc2lvblJ1bm5lcihcblx0XHRcdFx0XHRcdGV4dGVuc2lvbnNSZXN1bHQuZXh0ZW5zaW9ucyxcblx0XHRcdFx0XHRcdGV4dGVuc2lvbnNSZXN1bHQucnVudGltZSxcblx0XHRcdFx0XHRcdHRoaXMuX2N3ZCxcblx0XHRcdFx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIsXG5cdFx0XHRcdFx0XHR0aGlzLl9tb2RlbFJlZ2lzdHJ5LFxuXHRcdFx0XHRcdClcblx0XHRcdFx0OiB1bmRlZmluZWQ7XG5cdFx0aWYgKHRoaXMuX2V4dGVuc2lvblJ1bm5lclJlZikge1xuXHRcdFx0dGhpcy5fZXh0ZW5zaW9uUnVubmVyUmVmLmN1cnJlbnQgPSB0aGlzLl9leHRlbnNpb25SdW5uZXI7XG5cdFx0fVxuXHRcdGlmICh0aGlzLl9leHRlbnNpb25SdW5uZXIpIHtcblx0XHRcdHRoaXMuX2JpbmRFeHRlbnNpb25Db3JlKHRoaXMuX2V4dGVuc2lvblJ1bm5lcik7XG5cdFx0XHR0aGlzLl9hcHBseUV4dGVuc2lvbkJpbmRpbmdzKHRoaXMuX2V4dGVuc2lvblJ1bm5lcik7XG5cdFx0fVxuXG5cdFx0Y29uc3QgZGVmYXVsdEFjdGl2ZVRvb2xOYW1lcyA9IHRoaXMuX2Jhc2VUb29sc092ZXJyaWRlXG5cdFx0XHQ/IE9iamVjdC5rZXlzKHRoaXMuX2Jhc2VUb29sc092ZXJyaWRlKVxuXHRcdFx0OiBbXCJyZWFkXCIsIFwiYmFzaFwiLCBcImVkaXRcIiwgXCJ3cml0ZVwiLCBcImxzcFwiXTtcblx0XHRjb25zdCBiYXNlQWN0aXZlVG9vbE5hbWVzID0gb3B0aW9ucy5hY3RpdmVUb29sTmFtZXMgPz8gZGVmYXVsdEFjdGl2ZVRvb2xOYW1lcztcblx0XHR0aGlzLl9yZWZyZXNoVG9vbFJlZ2lzdHJ5KHtcblx0XHRcdGFjdGl2ZVRvb2xOYW1lczogYmFzZUFjdGl2ZVRvb2xOYW1lcyxcblx0XHRcdGluY2x1ZGVBbGxFeHRlbnNpb25Ub29sczogb3B0aW9ucy5pbmNsdWRlQWxsRXh0ZW5zaW9uVG9vbHMsXG5cdFx0fSk7XG5cdH1cblxuXHRhc3luYyByZWxvYWQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgcHJldmlvdXNGbGFnVmFsdWVzID0gdGhpcy5fZXh0ZW5zaW9uUnVubmVyPy5nZXRGbGFnVmFsdWVzKCk7XG5cdFx0YXdhaXQgdGhpcy5fZXh0ZW5zaW9uUnVubmVyPy5lbWl0KHsgdHlwZTogXCJzZXNzaW9uX3NodXRkb3duXCIgfSk7XG5cdFx0dGhpcy5zZXR0aW5nc01hbmFnZXIucmVsb2FkKCk7XG5cdFx0cmVzZXRBcGlQcm92aWRlcnMoKTtcblx0XHRhd2FpdCB0aGlzLl9yZXNvdXJjZUxvYWRlci5yZWxvYWQoKTtcblx0XHR0aGlzLl92aXNpYmxlU2tpbGxOYW1lcyA9IHVuZGVmaW5lZDtcblx0XHR0aGlzLl9idWlsZFJ1bnRpbWUoe1xuXHRcdFx0YWN0aXZlVG9vbE5hbWVzOiB0aGlzLmdldEFjdGl2ZVRvb2xOYW1lcygpLFxuXHRcdFx0ZmxhZ1ZhbHVlczogcHJldmlvdXNGbGFnVmFsdWVzLFxuXHRcdFx0aW5jbHVkZUFsbEV4dGVuc2lvblRvb2xzOiB0cnVlLFxuXHRcdH0pO1xuXG5cdFx0Y29uc3QgaGFzQmluZGluZ3MgPVxuXHRcdFx0dGhpcy5fZXh0ZW5zaW9uVUlDb250ZXh0IHx8XG5cdFx0XHR0aGlzLl9leHRlbnNpb25Db21tYW5kQ29udGV4dEFjdGlvbnMgfHxcblx0XHRcdHRoaXMuX2V4dGVuc2lvblNodXRkb3duSGFuZGxlciB8fFxuXHRcdFx0dGhpcy5fZXh0ZW5zaW9uRXJyb3JMaXN0ZW5lcjtcblx0XHRpZiAodGhpcy5fZXh0ZW5zaW9uUnVubmVyICYmIGhhc0JpbmRpbmdzKSB7XG5cdFx0XHRhd2FpdCB0aGlzLl9leHRlbnNpb25SdW5uZXIuZW1pdCh7IHR5cGU6IFwic2Vzc2lvbl9zdGFydFwiIH0pO1xuXHRcdFx0YXdhaXQgdGhpcy5leHRlbmRSZXNvdXJjZXNGcm9tRXh0ZW5zaW9ucyhcInJlbG9hZFwiKTtcblx0XHR9XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIEF1dG8tUmV0cnkgKGRlbGVnYXRlZCB0byBSZXRyeUhhbmRsZXIpXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHQvKiogQ2FuY2VsIGluLXByb2dyZXNzIHJldHJ5ICovXG5cdGFib3J0UmV0cnkoKTogdm9pZCB7XG5cdFx0Y29uc3QgaGFkUmV0cnkgPSB0aGlzLl9yZXRyeUhhbmRsZXIuaXNSZXRyeWluZztcblx0XHR0aGlzLl9yZXRyeUhhbmRsZXIuYWJvcnRSZXRyeSgpO1xuXHRcdGlmIChoYWRSZXRyeSkge1xuXHRcdFx0dGhpcy5fZW1pdFNlc3Npb25TdGF0ZUNoYW5nZWQoXCJhYm9ydF9yZXRyeVwiKTtcblx0XHR9XG5cdH1cblxuXHQvKiogV2hldGhlciBhdXRvLXJldHJ5IGlzIGN1cnJlbnRseSBpbiBwcm9ncmVzcyAqL1xuXHRnZXQgaXNSZXRyeWluZygpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5fcmV0cnlIYW5kbGVyLmlzUmV0cnlpbmc7XG5cdH1cblxuXHQvKiogV2hldGhlciBhdXRvLXJldHJ5IGlzIGVuYWJsZWQgKi9cblx0Z2V0IGF1dG9SZXRyeUVuYWJsZWQoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuX3JldHJ5SGFuZGxlci5hdXRvUmV0cnlFbmFibGVkO1xuXHR9XG5cblx0LyoqIFRvZ2dsZSBhdXRvLXJldHJ5IHNldHRpbmcgKi9cblx0c2V0QXV0b1JldHJ5RW5hYmxlZChlbmFibGVkOiBib29sZWFuKTogdm9pZCB7XG5cdFx0dGhpcy5fcmV0cnlIYW5kbGVyLnNldEF1dG9SZXRyeUVuYWJsZWQoZW5hYmxlZCk7XG5cdFx0dGhpcy5fZW1pdFNlc3Npb25TdGF0ZUNoYW5nZWQoXCJzZXRfYXV0b19yZXRyeVwiKTtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gQmFzaCBFeGVjdXRpb25cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdC8qKlxuXHQgKiBFeGVjdXRlIGEgYmFzaCBjb21tYW5kLlxuXHQgKiBBZGRzIHJlc3VsdCB0byBhZ2VudCBjb250ZXh0IGFuZCBzZXNzaW9uLlxuXHQgKiBAcGFyYW0gY29tbWFuZCBUaGUgYmFzaCBjb21tYW5kIHRvIGV4ZWN1dGVcblx0ICogQHBhcmFtIG9uQ2h1bmsgT3B0aW9uYWwgc3RyZWFtaW5nIGNhbGxiYWNrIGZvciBvdXRwdXRcblx0ICogQHBhcmFtIG9wdGlvbnMuZXhjbHVkZUZyb21Db250ZXh0IElmIHRydWUsIGNvbW1hbmQgb3V0cHV0IHdvbid0IGJlIHNlbnQgdG8gTExNICghISBwcmVmaXgpXG5cdCAqIEBwYXJhbSBvcHRpb25zLm9wZXJhdGlvbnMgQ3VzdG9tIEJhc2hPcGVyYXRpb25zIGZvciByZW1vdGUgZXhlY3V0aW9uXG5cdCAqL1xuXHRhc3luYyBleGVjdXRlQmFzaChcblx0XHRjb21tYW5kOiBzdHJpbmcsXG5cdFx0b25DaHVuaz86IChjaHVuazogc3RyaW5nKSA9PiB2b2lkLFxuXHRcdG9wdGlvbnM/OiB7IGV4Y2x1ZGVGcm9tQ29udGV4dD86IGJvb2xlYW47IG9wZXJhdGlvbnM/OiBCYXNoT3BlcmF0aW9uczsgbG9naW5TaGVsbD86IGJvb2xlYW4gfSxcblx0KTogUHJvbWlzZTxCYXNoUmVzdWx0PiB7XG5cdFx0dGhpcy5fYmFzaEFib3J0Q29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcblxuXHRcdC8vIEFwcGx5IGNvbW1hbmQgcHJlZml4IGlmIGNvbmZpZ3VyZWQgKGUuZy4sIFwic2hvcHQgLXMgZXhwYW5kX2FsaWFzZXNcIiBmb3IgYWxpYXMgc3VwcG9ydClcblx0XHRjb25zdCBwcmVmaXggPSB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRTaGVsbENvbW1hbmRQcmVmaXgoKTtcblx0XHRjb25zdCByZXNvbHZlZENvbW1hbmQgPSBwcmVmaXggPyBgJHtwcmVmaXh9XFxuJHtjb21tYW5kfWAgOiBjb21tYW5kO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IG9wdGlvbnM/Lm9wZXJhdGlvbnNcblx0XHRcdFx0PyBhd2FpdCBleGVjdXRlQmFzaFdpdGhPcGVyYXRpb25zKHJlc29sdmVkQ29tbWFuZCwgcHJvY2Vzcy5jd2QoKSwgb3B0aW9ucy5vcGVyYXRpb25zLCB7XG5cdFx0XHRcdFx0XHRvbkNodW5rLFxuXHRcdFx0XHRcdFx0c2lnbmFsOiB0aGlzLl9iYXNoQWJvcnRDb250cm9sbGVyLnNpZ25hbCxcblx0XHRcdFx0XHR9KVxuXHRcdFx0XHQ6IGF3YWl0IGV4ZWN1dGVCYXNoQ29tbWFuZChyZXNvbHZlZENvbW1hbmQsIHtcblx0XHRcdFx0XHRcdG9uQ2h1bmssXG5cdFx0XHRcdFx0XHRzaWduYWw6IHRoaXMuX2Jhc2hBYm9ydENvbnRyb2xsZXIuc2lnbmFsLFxuXHRcdFx0XHRcdFx0bG9naW5TaGVsbDogb3B0aW9ucz8ubG9naW5TaGVsbCxcblx0XHRcdFx0XHR9KTtcblxuXHRcdFx0dGhpcy5yZWNvcmRCYXNoUmVzdWx0KGNvbW1hbmQsIHJlc3VsdCwgb3B0aW9ucyk7XG5cdFx0XHRyZXR1cm4gcmVzdWx0O1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHR0aGlzLl9iYXNoQWJvcnRDb250cm9sbGVyID0gdW5kZWZpbmVkO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBSZWNvcmQgYSBiYXNoIGV4ZWN1dGlvbiByZXN1bHQgaW4gc2Vzc2lvbiBoaXN0b3J5LlxuXHQgKiBVc2VkIGJ5IGV4ZWN1dGVCYXNoIGFuZCBieSBleHRlbnNpb25zIHRoYXQgaGFuZGxlIGJhc2ggZXhlY3V0aW9uIHRoZW1zZWx2ZXMuXG5cdCAqL1xuXHRyZWNvcmRCYXNoUmVzdWx0KGNvbW1hbmQ6IHN0cmluZywgcmVzdWx0OiBCYXNoUmVzdWx0LCBvcHRpb25zPzogeyBleGNsdWRlRnJvbUNvbnRleHQ/OiBib29sZWFuIH0pOiB2b2lkIHtcblx0XHRjb25zdCBiYXNoTWVzc2FnZTogQmFzaEV4ZWN1dGlvbk1lc3NhZ2UgPSB7XG5cdFx0XHRyb2xlOiBcImJhc2hFeGVjdXRpb25cIixcblx0XHRcdGNvbW1hbmQsXG5cdFx0XHRvdXRwdXQ6IHJlc3VsdC5vdXRwdXQsXG5cdFx0XHRleGl0Q29kZTogcmVzdWx0LmV4aXRDb2RlLFxuXHRcdFx0Y2FuY2VsbGVkOiByZXN1bHQuY2FuY2VsbGVkLFxuXHRcdFx0dHJ1bmNhdGVkOiByZXN1bHQudHJ1bmNhdGVkLFxuXHRcdFx0ZnVsbE91dHB1dFBhdGg6IHJlc3VsdC5mdWxsT3V0cHV0UGF0aCxcblx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHRcdGV4Y2x1ZGVGcm9tQ29udGV4dDogb3B0aW9ucz8uZXhjbHVkZUZyb21Db250ZXh0LFxuXHRcdH07XG5cblx0XHQvLyBJZiBhZ2VudCBpcyBzdHJlYW1pbmcsIGRlZmVyIGFkZGluZyB0byBhdm9pZCBicmVha2luZyB0b29sX3VzZS90b29sX3Jlc3VsdCBvcmRlcmluZ1xuXHRcdGlmICh0aGlzLmlzU3RyZWFtaW5nKSB7XG5cdFx0XHQvLyBRdWV1ZSBmb3IgbGF0ZXIgLSB3aWxsIGJlIGZsdXNoZWQgb24gYWdlbnRfZW5kXG5cdFx0XHR0aGlzLl9wZW5kaW5nQmFzaE1lc3NhZ2VzLnB1c2goYmFzaE1lc3NhZ2UpO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBBZGQgdG8gYWdlbnQgc3RhdGUgaW1tZWRpYXRlbHlcblx0XHRcdHRoaXMuYWdlbnQuYXBwZW5kTWVzc2FnZShiYXNoTWVzc2FnZSk7XG5cblx0XHRcdC8vIFNhdmUgdG8gc2Vzc2lvblxuXHRcdFx0dGhpcy5zZXNzaW9uTWFuYWdlci5hcHBlbmRNZXNzYWdlKGJhc2hNZXNzYWdlKTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogQ2FuY2VsIHJ1bm5pbmcgYmFzaCBjb21tYW5kLlxuXHQgKi9cblx0YWJvcnRCYXNoKCk6IHZvaWQge1xuXHRcdHRoaXMuX2Jhc2hBYm9ydENvbnRyb2xsZXI/LmFib3J0KCk7XG5cdH1cblxuXHQvKiogV2hldGhlciBhIGJhc2ggY29tbWFuZCBpcyBjdXJyZW50bHkgcnVubmluZyAqL1xuXHRnZXQgaXNCYXNoUnVubmluZygpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5fYmFzaEFib3J0Q29udHJvbGxlciAhPT0gdW5kZWZpbmVkO1xuXHR9XG5cblx0LyoqIFdoZXRoZXIgdGhlcmUgYXJlIHBlbmRpbmcgYmFzaCBtZXNzYWdlcyB3YWl0aW5nIHRvIGJlIGZsdXNoZWQgKi9cblx0Z2V0IGhhc1BlbmRpbmdCYXNoTWVzc2FnZXMoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuX3BlbmRpbmdCYXNoTWVzc2FnZXMubGVuZ3RoID4gMDtcblx0fVxuXG5cdC8qKlxuXHQgKiBGbHVzaCBwZW5kaW5nIGJhc2ggbWVzc2FnZXMgdG8gYWdlbnQgc3RhdGUgYW5kIHNlc3Npb24uXG5cdCAqIENhbGxlZCBhZnRlciBhZ2VudCB0dXJuIGNvbXBsZXRlcyB0byBtYWludGFpbiBwcm9wZXIgbWVzc2FnZSBvcmRlcmluZy5cblx0ICovXG5cdHByaXZhdGUgX2ZsdXNoUGVuZGluZ0Jhc2hNZXNzYWdlcygpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5fcGVuZGluZ0Jhc2hNZXNzYWdlcy5sZW5ndGggPT09IDApIHJldHVybjtcblxuXHRcdGZvciAoY29uc3QgYmFzaE1lc3NhZ2Ugb2YgdGhpcy5fcGVuZGluZ0Jhc2hNZXNzYWdlcykge1xuXHRcdFx0Ly8gQWRkIHRvIGFnZW50IHN0YXRlXG5cdFx0XHR0aGlzLmFnZW50LmFwcGVuZE1lc3NhZ2UoYmFzaE1lc3NhZ2UpO1xuXG5cdFx0XHQvLyBTYXZlIHRvIHNlc3Npb25cblx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuYXBwZW5kTWVzc2FnZShiYXNoTWVzc2FnZSk7XG5cdFx0fVxuXG5cdFx0dGhpcy5fcGVuZGluZ0Jhc2hNZXNzYWdlcyA9IFtdO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBTZXNzaW9uIE1hbmFnZW1lbnRcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdC8qKlxuXHQgKiBTd2l0Y2ggdG8gYSBkaWZmZXJlbnQgc2Vzc2lvbiBmaWxlLlxuXHQgKiBBYm9ydHMgY3VycmVudCBvcGVyYXRpb24sIGxvYWRzIG1lc3NhZ2VzLCByZXN0b3JlcyBtb2RlbC90aGlua2luZy5cblx0ICogTGlzdGVuZXJzIGFyZSBwcmVzZXJ2ZWQgYW5kIHdpbGwgY29udGludWUgcmVjZWl2aW5nIGV2ZW50cy5cblx0ICogQHJldHVybnMgdHJ1ZSBpZiBzd2l0Y2ggY29tcGxldGVkLCBmYWxzZSBpZiBjYW5jZWxsZWQgYnkgZXh0ZW5zaW9uXG5cdCAqL1xuXHRhc3luYyBzd2l0Y2hTZXNzaW9uKHNlc3Npb25QYXRoOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHRjb25zdCBwcmV2aW91c1Nlc3Npb25GaWxlID0gdGhpcy5zZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uRmlsZSgpO1xuXG5cdFx0Ly8gRW1pdCBzZXNzaW9uX2JlZm9yZV9zd2l0Y2ggZXZlbnQgKGNhbiBiZSBjYW5jZWxsZWQpXG5cdFx0aWYgKHRoaXMuX2V4dGVuc2lvblJ1bm5lcj8uaGFzSGFuZGxlcnMoXCJzZXNzaW9uX2JlZm9yZV9zd2l0Y2hcIikpIHtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IChhd2FpdCB0aGlzLl9leHRlbnNpb25SdW5uZXIuZW1pdCh7XG5cdFx0XHRcdHR5cGU6IFwic2Vzc2lvbl9iZWZvcmVfc3dpdGNoXCIsXG5cdFx0XHRcdHJlYXNvbjogXCJyZXN1bWVcIixcblx0XHRcdFx0dGFyZ2V0U2Vzc2lvbkZpbGU6IHNlc3Npb25QYXRoLFxuXHRcdFx0fSkpIGFzIFNlc3Npb25CZWZvcmVTd2l0Y2hSZXN1bHQgfCB1bmRlZmluZWQ7XG5cblx0XHRcdGlmIChyZXN1bHQ/LmNhbmNlbCkge1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0dGhpcy5fc2Vzc2lvblN3aXRjaFBlbmRpbmcgPSB0cnVlO1xuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCB0aGlzLl9zZXR0bGVDdXJyZW50VHVybkZvclNlc3Npb25UcmFuc2l0aW9uKCk7XG5cdFx0XHR0aGlzLl9kaXNjb25uZWN0RnJvbUFnZW50KCk7XG5cdFx0fSBmaW5hbGx5IHtcblx0XHRcdHRoaXMuX3Nlc3Npb25Td2l0Y2hQZW5kaW5nID0gZmFsc2U7XG5cdFx0fVxuXHRcdHRoaXMuX3N0ZWVyaW5nTWVzc2FnZXMgPSBbXTtcblx0XHR0aGlzLl9mb2xsb3dVcE1lc3NhZ2VzID0gW107XG5cdFx0dGhpcy5fcGVuZGluZ05leHRUdXJuTWVzc2FnZXMgPSBbXTtcblx0XHR0aGlzLl92aXNpYmxlU2tpbGxOYW1lcyA9IHVuZGVmaW5lZDtcblxuXHRcdC8vIFNldCBuZXcgc2Vzc2lvblxuXHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuc2V0U2Vzc2lvbkZpbGUoc2Vzc2lvblBhdGgpO1xuXHRcdHRoaXMuYWdlbnQuc2Vzc2lvbklkID0gdGhpcy5zZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uSWQoKTtcblxuXHRcdC8vIFJlbG9hZCBtZXNzYWdlc1xuXHRcdGNvbnN0IHNlc3Npb25Db250ZXh0ID0gdGhpcy5zZXNzaW9uTWFuYWdlci5idWlsZFNlc3Npb25Db250ZXh0KCk7XG5cblx0XHQvLyBFbWl0IHNlc3Npb25fc3dpdGNoIGV2ZW50IHRvIGV4dGVuc2lvbnNcblx0XHRpZiAodGhpcy5fZXh0ZW5zaW9uUnVubmVyKSB7XG5cdFx0XHRhd2FpdCB0aGlzLl9leHRlbnNpb25SdW5uZXIuZW1pdCh7XG5cdFx0XHRcdHR5cGU6IFwic2Vzc2lvbl9zd2l0Y2hcIixcblx0XHRcdFx0cmVhc29uOiBcInJlc3VtZVwiLFxuXHRcdFx0XHRwcmV2aW91c1Nlc3Npb25GaWxlLFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0Ly8gRW1pdCBzZXNzaW9uIGV2ZW50IHRvIGN1c3RvbSB0b29sc1xuXG5cdFx0dGhpcy5hZ2VudC5yZXBsYWNlTWVzc2FnZXMoc2Vzc2lvbkNvbnRleHQubWVzc2FnZXMpO1xuXG5cdFx0Ly8gUmVzdG9yZSBtb2RlbCBpZiBzYXZlZFxuXHRcdGlmIChzZXNzaW9uQ29udGV4dC5tb2RlbCkge1xuXHRcdFx0Y29uc3QgcHJldmlvdXNNb2RlbCA9IHRoaXMubW9kZWw7XG5cdFx0XHRjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBhd2FpdCB0aGlzLl9tb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpO1xuXHRcdFx0Y29uc3QgbWF0Y2ggPSBhdmFpbGFibGVNb2RlbHMuZmluZChcblx0XHRcdFx0KG0pID0+IG0ucHJvdmlkZXIgPT09IHNlc3Npb25Db250ZXh0Lm1vZGVsIS5wcm92aWRlciAmJiBtLmlkID09PSBzZXNzaW9uQ29udGV4dC5tb2RlbCEubW9kZWxJZCxcblx0XHRcdCk7XG5cdFx0XHRpZiAobWF0Y2gpIHtcblx0XHRcdFx0dGhpcy5hZ2VudC5zZXRNb2RlbChtYXRjaCk7XG5cdFx0XHRcdGF3YWl0IHRoaXMuX2VtaXRNb2RlbFNlbGVjdChtYXRjaCwgcHJldmlvdXNNb2RlbCwgXCJyZXN0b3JlXCIpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGNvbnN0IGhhc1RoaW5raW5nRW50cnkgPSB0aGlzLnNlc3Npb25NYW5hZ2VyLmdldEJyYW5jaCgpLnNvbWUoKGVudHJ5KSA9PiBlbnRyeS50eXBlID09PSBcInRoaW5raW5nX2xldmVsX2NoYW5nZVwiKTtcblx0XHRjb25zdCBkZWZhdWx0VGhpbmtpbmdMZXZlbCA9IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldERlZmF1bHRUaGlua2luZ0xldmVsKCkgPz8gREVGQVVMVF9USElOS0lOR19MRVZFTDtcblxuXHRcdGlmIChoYXNUaGlua2luZ0VudHJ5KSB7XG5cdFx0XHQvLyBSZXN0b3JlIHRoaW5raW5nIGxldmVsIGlmIHNhdmVkIChzZXRUaGlua2luZ0xldmVsIGNsYW1wcyB0byBtb2RlbCBjYXBhYmlsaXRpZXMpXG5cdFx0XHR0aGlzLnNldFRoaW5raW5nTGV2ZWwoc2Vzc2lvbkNvbnRleHQudGhpbmtpbmdMZXZlbCBhcyBUaGlua2luZ0xldmVsKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgYXZhaWxhYmxlTGV2ZWxzID0gdGhpcy5nZXRBdmFpbGFibGVUaGlua2luZ0xldmVscygpO1xuXHRcdFx0Y29uc3QgZWZmZWN0aXZlTGV2ZWwgPSBhdmFpbGFibGVMZXZlbHMuaW5jbHVkZXMoZGVmYXVsdFRoaW5raW5nTGV2ZWwpXG5cdFx0XHRcdD8gZGVmYXVsdFRoaW5raW5nTGV2ZWxcblx0XHRcdFx0OiB0aGlzLl9jbGFtcFRoaW5raW5nTGV2ZWwoZGVmYXVsdFRoaW5raW5nTGV2ZWwsIGF2YWlsYWJsZUxldmVscyk7XG5cdFx0XHR0aGlzLmFnZW50LnNldFRoaW5raW5nTGV2ZWwoZWZmZWN0aXZlTGV2ZWwpO1xuXHRcdFx0dGhpcy5zZXNzaW9uTWFuYWdlci5hcHBlbmRUaGlua2luZ0xldmVsQ2hhbmdlKGVmZmVjdGl2ZUxldmVsKTtcblx0XHR9XG5cblx0XHR0aGlzLl9yZWNvbm5lY3RUb0FnZW50KCk7XG5cdFx0dGhpcy5fZW1pdFNlc3Npb25TdGF0ZUNoYW5nZWQoXCJzd2l0Y2hfc2Vzc2lvblwiKTtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgYSBkaXNwbGF5IG5hbWUgZm9yIHRoZSBjdXJyZW50IHNlc3Npb24uXG5cdCAqL1xuXHRzZXRTZXNzaW9uTmFtZShuYW1lOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0aGlzLnNlc3Npb25NYW5hZ2VyLmFwcGVuZFNlc3Npb25JbmZvKG5hbWUpO1xuXHRcdHRoaXMuX2VtaXRTZXNzaW9uU3RhdGVDaGFuZ2VkKFwic2V0X3Nlc3Npb25fbmFtZVwiKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDcmVhdGUgYSBmb3JrIGZyb20gYSBzcGVjaWZpYyBlbnRyeS5cblx0ICogRW1pdHMgYmVmb3JlX2ZvcmsvZm9yayBzZXNzaW9uIGV2ZW50cyB0byBleHRlbnNpb25zLlxuXHQgKlxuXHQgKiBAcGFyYW0gZW50cnlJZCBJRCBvZiB0aGUgZW50cnkgdG8gZm9yayBmcm9tXG5cdCAqIEByZXR1cm5zIE9iamVjdCB3aXRoOlxuXHQgKiAgIC0gc2VsZWN0ZWRUZXh0OiBUaGUgdGV4dCBvZiB0aGUgc2VsZWN0ZWQgdXNlciBtZXNzYWdlIChmb3IgZWRpdG9yIHByZS1maWxsKVxuXHQgKiAgIC0gY2FuY2VsbGVkOiBUcnVlIGlmIGFuIGV4dGVuc2lvbiBjYW5jZWxsZWQgdGhlIGZvcmtcblx0ICovXG5cdGFzeW5jIGZvcmsoZW50cnlJZDogc3RyaW5nKTogUHJvbWlzZTx7IHNlbGVjdGVkVGV4dDogc3RyaW5nOyBjYW5jZWxsZWQ6IGJvb2xlYW4gfT4ge1xuXHRcdGNvbnN0IHByZXZpb3VzU2Vzc2lvbkZpbGUgPSB0aGlzLnNlc3Npb25GaWxlO1xuXHRcdGNvbnN0IHNlbGVjdGVkRW50cnkgPSB0aGlzLnNlc3Npb25NYW5hZ2VyLmdldEVudHJ5KGVudHJ5SWQpO1xuXG5cdFx0aWYgKCFzZWxlY3RlZEVudHJ5IHx8IHNlbGVjdGVkRW50cnkudHlwZSAhPT0gXCJtZXNzYWdlXCIgfHwgc2VsZWN0ZWRFbnRyeS5tZXNzYWdlLnJvbGUgIT09IFwidXNlclwiKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIGVudHJ5IElEIGZvciBmb3JraW5nXCIpO1xuXHRcdH1cblxuXHRcdGNvbnN0IHNlbGVjdGVkVGV4dCA9IHRoaXMuX2V4dHJhY3RVc2VyTWVzc2FnZVRleHQoc2VsZWN0ZWRFbnRyeS5tZXNzYWdlLmNvbnRlbnQpO1xuXG5cdFx0bGV0IHNraXBDb252ZXJzYXRpb25SZXN0b3JlID0gZmFsc2U7XG5cblx0XHQvLyBFbWl0IHNlc3Npb25fYmVmb3JlX2ZvcmsgZXZlbnQgKGNhbiBiZSBjYW5jZWxsZWQpXG5cdFx0aWYgKHRoaXMuX2V4dGVuc2lvblJ1bm5lcj8uaGFzSGFuZGxlcnMoXCJzZXNzaW9uX2JlZm9yZV9mb3JrXCIpKSB7XG5cdFx0XHRjb25zdCByZXN1bHQgPSAoYXdhaXQgdGhpcy5fZXh0ZW5zaW9uUnVubmVyLmVtaXQoe1xuXHRcdFx0XHR0eXBlOiBcInNlc3Npb25fYmVmb3JlX2ZvcmtcIixcblx0XHRcdFx0ZW50cnlJZCxcblx0XHRcdH0pKSBhcyBTZXNzaW9uQmVmb3JlRm9ya1Jlc3VsdCB8IHVuZGVmaW5lZDtcblxuXHRcdFx0aWYgKHJlc3VsdD8uY2FuY2VsKSB7XG5cdFx0XHRcdHJldHVybiB7IHNlbGVjdGVkVGV4dCwgY2FuY2VsbGVkOiB0cnVlIH07XG5cdFx0XHR9XG5cdFx0XHRza2lwQ29udmVyc2F0aW9uUmVzdG9yZSA9IHJlc3VsdD8uc2tpcENvbnZlcnNhdGlvblJlc3RvcmUgPz8gZmFsc2U7XG5cdFx0fVxuXG5cdFx0Ly8gQ2xlYXIgcGVuZGluZyBtZXNzYWdlcyAoYm91bmQgdG8gb2xkIHNlc3Npb24gc3RhdGUpXG5cdFx0dGhpcy5fcGVuZGluZ05leHRUdXJuTWVzc2FnZXMgPSBbXTtcblxuXHRcdGlmICghc2VsZWN0ZWRFbnRyeS5wYXJlbnRJZCkge1xuXHRcdFx0dGhpcy5zZXNzaW9uTWFuYWdlci5uZXdTZXNzaW9uKHsgcGFyZW50U2Vzc2lvbjogcHJldmlvdXNTZXNzaW9uRmlsZSB9KTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0dGhpcy5zZXNzaW9uTWFuYWdlci5jcmVhdGVCcmFuY2hlZFNlc3Npb24oc2VsZWN0ZWRFbnRyeS5wYXJlbnRJZCk7XG5cdFx0fVxuXHRcdHRoaXMuYWdlbnQuc2Vzc2lvbklkID0gdGhpcy5zZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uSWQoKTtcblxuXHRcdC8vIFJlbG9hZCBtZXNzYWdlcyBmcm9tIGVudHJpZXMgKHdvcmtzIGZvciBib3RoIGZpbGUgYW5kIGluLW1lbW9yeSBtb2RlKVxuXHRcdGNvbnN0IHNlc3Npb25Db250ZXh0ID0gdGhpcy5zZXNzaW9uTWFuYWdlci5idWlsZFNlc3Npb25Db250ZXh0KCk7XG5cblx0XHQvLyBFbWl0IHNlc3Npb25fZm9yayBldmVudCB0byBleHRlbnNpb25zIChhZnRlciBmb3JrIGNvbXBsZXRlcylcblx0XHRpZiAodGhpcy5fZXh0ZW5zaW9uUnVubmVyKSB7XG5cdFx0XHRhd2FpdCB0aGlzLl9leHRlbnNpb25SdW5uZXIuZW1pdCh7XG5cdFx0XHRcdHR5cGU6IFwic2Vzc2lvbl9mb3JrXCIsXG5cdFx0XHRcdHByZXZpb3VzU2Vzc2lvbkZpbGUsXG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHQvLyBFbWl0IHNlc3Npb24gZXZlbnQgdG8gY3VzdG9tIHRvb2xzICh3aXRoIHJlYXNvbiBcImZvcmtcIilcblxuXHRcdGlmICghc2tpcENvbnZlcnNhdGlvblJlc3RvcmUpIHtcblx0XHRcdHRoaXMuYWdlbnQucmVwbGFjZU1lc3NhZ2VzKHNlc3Npb25Db250ZXh0Lm1lc3NhZ2VzKTtcblx0XHR9XG5cblx0XHR0aGlzLl9lbWl0U2Vzc2lvblN0YXRlQ2hhbmdlZChcImZvcmtcIik7XG5cdFx0cmV0dXJuIHsgc2VsZWN0ZWRUZXh0LCBjYW5jZWxsZWQ6IGZhbHNlIH07XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIFRyZWUgTmF2aWdhdGlvblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIE5hdmlnYXRlIHRvIGEgZGlmZmVyZW50IG5vZGUgaW4gdGhlIHNlc3Npb24gdHJlZS5cblx0ICogVW5saWtlIGZvcmsoKSB3aGljaCBjcmVhdGVzIGEgbmV3IHNlc3Npb24gZmlsZSwgdGhpcyBzdGF5cyBpbiB0aGUgc2FtZSBmaWxlLlxuXHQgKlxuXHQgKiBAcGFyYW0gdGFyZ2V0SWQgVGhlIGVudHJ5IElEIHRvIG5hdmlnYXRlIHRvXG5cdCAqIEBwYXJhbSBvcHRpb25zLnN1bW1hcml6ZSBXaGV0aGVyIHVzZXIgd2FudHMgdG8gc3VtbWFyaXplIGFiYW5kb25lZCBicmFuY2hcblx0ICogQHBhcmFtIG9wdGlvbnMuY3VzdG9tSW5zdHJ1Y3Rpb25zIEN1c3RvbSBpbnN0cnVjdGlvbnMgZm9yIHN1bW1hcml6ZXJcblx0ICogQHBhcmFtIG9wdGlvbnMucmVwbGFjZUluc3RydWN0aW9ucyBJZiB0cnVlLCBjdXN0b21JbnN0cnVjdGlvbnMgcmVwbGFjZXMgdGhlIGRlZmF1bHQgcHJvbXB0XG5cdCAqIEBwYXJhbSBvcHRpb25zLmxhYmVsIExhYmVsIHRvIGF0dGFjaCB0byB0aGUgYnJhbmNoIHN1bW1hcnkgZW50cnlcblx0ICogQHJldHVybnMgUmVzdWx0IHdpdGggZWRpdG9yVGV4dCAoaWYgdXNlciBtZXNzYWdlKSBhbmQgY2FuY2VsbGVkIHN0YXR1c1xuXHQgKi9cblx0YXN5bmMgbmF2aWdhdGVUcmVlKFxuXHRcdHRhcmdldElkOiBzdHJpbmcsXG5cdFx0b3B0aW9uczogeyBzdW1tYXJpemU/OiBib29sZWFuOyBjdXN0b21JbnN0cnVjdGlvbnM/OiBzdHJpbmc7IHJlcGxhY2VJbnN0cnVjdGlvbnM/OiBib29sZWFuOyBsYWJlbD86IHN0cmluZyB9ID0ge30sXG5cdCk6IFByb21pc2U8eyBlZGl0b3JUZXh0Pzogc3RyaW5nOyBjYW5jZWxsZWQ6IGJvb2xlYW47IGFib3J0ZWQ/OiBib29sZWFuOyBzdW1tYXJ5RW50cnk/OiBCcmFuY2hTdW1tYXJ5RW50cnkgfT4ge1xuXHRcdGNvbnN0IG9sZExlYWZJZCA9IHRoaXMuc2Vzc2lvbk1hbmFnZXIuZ2V0TGVhZklkKCk7XG5cblx0XHQvLyBOby1vcCBpZiBhbHJlYWR5IGF0IHRhcmdldFxuXHRcdGlmICh0YXJnZXRJZCA9PT0gb2xkTGVhZklkKSB7XG5cdFx0XHRyZXR1cm4geyBjYW5jZWxsZWQ6IGZhbHNlIH07XG5cdFx0fVxuXG5cdFx0Ly8gTW9kZWwgcmVxdWlyZWQgZm9yIHN1bW1hcml6YXRpb25cblx0XHRpZiAob3B0aW9ucy5zdW1tYXJpemUgJiYgIXRoaXMubW9kZWwpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIk5vIG1vZGVsIGF2YWlsYWJsZSBmb3Igc3VtbWFyaXphdGlvblwiKTtcblx0XHR9XG5cblx0XHRjb25zdCB0YXJnZXRFbnRyeSA9IHRoaXMuc2Vzc2lvbk1hbmFnZXIuZ2V0RW50cnkodGFyZ2V0SWQpO1xuXHRcdGlmICghdGFyZ2V0RW50cnkpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihgRW50cnkgJHt0YXJnZXRJZH0gbm90IGZvdW5kYCk7XG5cdFx0fVxuXG5cdFx0Ly8gQ29sbGVjdCBlbnRyaWVzIHRvIHN1bW1hcml6ZSAoZnJvbSBvbGQgbGVhZiB0byBjb21tb24gYW5jZXN0b3IpXG5cdFx0Y29uc3QgeyBlbnRyaWVzOiBlbnRyaWVzVG9TdW1tYXJpemUsIGNvbW1vbkFuY2VzdG9ySWQgfSA9IGNvbGxlY3RFbnRyaWVzRm9yQnJhbmNoU3VtbWFyeShcblx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIsXG5cdFx0XHRvbGRMZWFmSWQsXG5cdFx0XHR0YXJnZXRJZCxcblx0XHQpO1xuXG5cdFx0Ly8gUHJlcGFyZSBldmVudCBkYXRhIC0gbXV0YWJsZSBzbyBleHRlbnNpb25zIGNhbiBvdmVycmlkZVxuXHRcdGxldCBjdXN0b21JbnN0cnVjdGlvbnMgPSBvcHRpb25zLmN1c3RvbUluc3RydWN0aW9ucztcblx0XHRsZXQgcmVwbGFjZUluc3RydWN0aW9ucyA9IG9wdGlvbnMucmVwbGFjZUluc3RydWN0aW9ucztcblx0XHRsZXQgbGFiZWwgPSBvcHRpb25zLmxhYmVsO1xuXG5cdFx0Y29uc3QgcHJlcGFyYXRpb246IFRyZWVQcmVwYXJhdGlvbiA9IHtcblx0XHRcdHRhcmdldElkLFxuXHRcdFx0b2xkTGVhZklkLFxuXHRcdFx0Y29tbW9uQW5jZXN0b3JJZCxcblx0XHRcdGVudHJpZXNUb1N1bW1hcml6ZSxcblx0XHRcdHVzZXJXYW50c1N1bW1hcnk6IG9wdGlvbnMuc3VtbWFyaXplID8/IGZhbHNlLFxuXHRcdFx0Y3VzdG9tSW5zdHJ1Y3Rpb25zLFxuXHRcdFx0cmVwbGFjZUluc3RydWN0aW9ucyxcblx0XHRcdGxhYmVsLFxuXHRcdH07XG5cblx0XHQvLyBTZXQgdXAgYWJvcnQgY29udHJvbGxlciBmb3Igc3VtbWFyaXphdGlvblxuXHRcdHRoaXMuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IuYnJhbmNoU3VtbWFyeUFib3J0Q29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcblx0XHRsZXQgZXh0ZW5zaW9uU3VtbWFyeTogeyBzdW1tYXJ5OiBzdHJpbmc7IGRldGFpbHM/OiB1bmtub3duIH0gfCB1bmRlZmluZWQ7XG5cdFx0bGV0IGZyb21FeHRlbnNpb24gPSBmYWxzZTtcblxuXHRcdC8vIEVtaXQgc2Vzc2lvbl9iZWZvcmVfdHJlZSBldmVudFxuXHRcdGlmICh0aGlzLl9leHRlbnNpb25SdW5uZXI/Lmhhc0hhbmRsZXJzKFwic2Vzc2lvbl9iZWZvcmVfdHJlZVwiKSkge1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gKGF3YWl0IHRoaXMuX2V4dGVuc2lvblJ1bm5lci5lbWl0KHtcblx0XHRcdFx0dHlwZTogXCJzZXNzaW9uX2JlZm9yZV90cmVlXCIsXG5cdFx0XHRcdHByZXBhcmF0aW9uLFxuXHRcdFx0XHRzaWduYWw6IHRoaXMuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IuYnJhbmNoU3VtbWFyeUFib3J0Q29udHJvbGxlci5zaWduYWwsXG5cdFx0XHR9KSkgYXMgU2Vzc2lvbkJlZm9yZVRyZWVSZXN1bHQgfCB1bmRlZmluZWQ7XG5cblx0XHRcdGlmIChyZXN1bHQ/LmNhbmNlbCkge1xuXHRcdFx0XHRyZXR1cm4geyBjYW5jZWxsZWQ6IHRydWUgfTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHJlc3VsdD8uc3VtbWFyeSAmJiBvcHRpb25zLnN1bW1hcml6ZSkge1xuXHRcdFx0XHRleHRlbnNpb25TdW1tYXJ5ID0gcmVzdWx0LnN1bW1hcnk7XG5cdFx0XHRcdGZyb21FeHRlbnNpb24gPSB0cnVlO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBBbGxvdyBleHRlbnNpb25zIHRvIG92ZXJyaWRlIGluc3RydWN0aW9ucyBhbmQgbGFiZWxcblx0XHRcdGlmIChyZXN1bHQ/LmN1c3RvbUluc3RydWN0aW9ucyAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdGN1c3RvbUluc3RydWN0aW9ucyA9IHJlc3VsdC5jdXN0b21JbnN0cnVjdGlvbnM7XG5cdFx0XHR9XG5cdFx0XHRpZiAocmVzdWx0Py5yZXBsYWNlSW5zdHJ1Y3Rpb25zICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0cmVwbGFjZUluc3RydWN0aW9ucyA9IHJlc3VsdC5yZXBsYWNlSW5zdHJ1Y3Rpb25zO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHJlc3VsdD8ubGFiZWwgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRsYWJlbCA9IHJlc3VsdC5sYWJlbDtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBSdW4gZGVmYXVsdCBzdW1tYXJpemVyIGlmIG5lZWRlZFxuXHRcdGxldCBzdW1tYXJ5VGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXHRcdGxldCBzdW1tYXJ5RGV0YWlsczogdW5rbm93bjtcblx0XHRpZiAob3B0aW9ucy5zdW1tYXJpemUgJiYgZW50cmllc1RvU3VtbWFyaXplLmxlbmd0aCA+IDAgJiYgIWV4dGVuc2lvblN1bW1hcnkpIHtcblx0XHRcdGNvbnN0IG1vZGVsID0gdGhpcy5tb2RlbCE7XG5cdFx0XHRpZiAoIXRoaXMuX21vZGVsUmVnaXN0cnkuaXNQcm92aWRlclJlcXVlc3RSZWFkeShtb2RlbC5wcm92aWRlcikpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBObyBBUEkga2V5IGZvciAke21vZGVsLnByb3ZpZGVyfWApO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgYXBpS2V5ID0gYXdhaXQgdGhpcy5fbW9kZWxSZWdpc3RyeS5nZXRBcGlLZXkobW9kZWwsIHRoaXMuc2Vzc2lvbklkKTtcblx0XHRcdGNvbnN0IGJyYW5jaFN1bW1hcnlTZXR0aW5ncyA9IHRoaXMuc2V0dGluZ3NNYW5hZ2VyLmdldEJyYW5jaFN1bW1hcnlTZXR0aW5ncygpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgZ2VuZXJhdGVCcmFuY2hTdW1tYXJ5KGVudHJpZXNUb1N1bW1hcml6ZSwge1xuXHRcdFx0XHRtb2RlbCxcblx0XHRcdFx0YXBpS2V5LFxuXHRcdFx0XHRzaWduYWw6IHRoaXMuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IuYnJhbmNoU3VtbWFyeUFib3J0Q29udHJvbGxlci5zaWduYWwsXG5cdFx0XHRcdGN1c3RvbUluc3RydWN0aW9ucyxcblx0XHRcdFx0cmVwbGFjZUluc3RydWN0aW9ucyxcblx0XHRcdFx0cmVzZXJ2ZVRva2VuczogYnJhbmNoU3VtbWFyeVNldHRpbmdzLnJlc2VydmVUb2tlbnMsXG5cdFx0XHR9KTtcblx0XHRcdHRoaXMuX2NvbXBhY3Rpb25PcmNoZXN0cmF0b3IuYnJhbmNoU3VtbWFyeUFib3J0Q29udHJvbGxlciA9IHVuZGVmaW5lZDtcblx0XHRcdGlmIChyZXN1bHQuYWJvcnRlZCkge1xuXHRcdFx0XHRyZXR1cm4geyBjYW5jZWxsZWQ6IHRydWUsIGFib3J0ZWQ6IHRydWUgfTtcblx0XHRcdH1cblx0XHRcdGlmIChyZXN1bHQuZXJyb3IpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKHJlc3VsdC5lcnJvcik7XG5cdFx0XHR9XG5cdFx0XHRzdW1tYXJ5VGV4dCA9IHJlc3VsdC5zdW1tYXJ5O1xuXHRcdFx0c3VtbWFyeURldGFpbHMgPSB7XG5cdFx0XHRcdHJlYWRGaWxlczogcmVzdWx0LnJlYWRGaWxlcyB8fCBbXSxcblx0XHRcdFx0bW9kaWZpZWRGaWxlczogcmVzdWx0Lm1vZGlmaWVkRmlsZXMgfHwgW10sXG5cdFx0XHR9O1xuXHRcdH0gZWxzZSBpZiAoZXh0ZW5zaW9uU3VtbWFyeSkge1xuXHRcdFx0c3VtbWFyeVRleHQgPSBleHRlbnNpb25TdW1tYXJ5LnN1bW1hcnk7XG5cdFx0XHRzdW1tYXJ5RGV0YWlscyA9IGV4dGVuc2lvblN1bW1hcnkuZGV0YWlscztcblx0XHR9XG5cblx0XHQvLyBEZXRlcm1pbmUgdGhlIG5ldyBsZWFmIHBvc2l0aW9uIGJhc2VkIG9uIHRhcmdldCB0eXBlXG5cdFx0bGV0IG5ld0xlYWZJZDogc3RyaW5nIHwgbnVsbDtcblx0XHRsZXQgZWRpdG9yVGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG5cdFx0aWYgKHRhcmdldEVudHJ5LnR5cGUgPT09IFwibWVzc2FnZVwiICYmIHRhcmdldEVudHJ5Lm1lc3NhZ2Uucm9sZSA9PT0gXCJ1c2VyXCIpIHtcblx0XHRcdC8vIFVzZXIgbWVzc2FnZTogbGVhZiA9IHBhcmVudCAobnVsbCBpZiByb290KSwgdGV4dCBnb2VzIHRvIGVkaXRvclxuXHRcdFx0bmV3TGVhZklkID0gdGFyZ2V0RW50cnkucGFyZW50SWQ7XG5cdFx0XHRlZGl0b3JUZXh0ID0gdGhpcy5fZXh0cmFjdFVzZXJNZXNzYWdlVGV4dCh0YXJnZXRFbnRyeS5tZXNzYWdlLmNvbnRlbnQpO1xuXHRcdH0gZWxzZSBpZiAodGFyZ2V0RW50cnkudHlwZSA9PT0gXCJjdXN0b21fbWVzc2FnZVwiKSB7XG5cdFx0XHQvLyBDdXN0b20gbWVzc2FnZTogbGVhZiA9IHBhcmVudCAobnVsbCBpZiByb290KSwgdGV4dCBnb2VzIHRvIGVkaXRvclxuXHRcdFx0bmV3TGVhZklkID0gdGFyZ2V0RW50cnkucGFyZW50SWQ7XG5cdFx0XHRlZGl0b3JUZXh0ID1cblx0XHRcdFx0dHlwZW9mIHRhcmdldEVudHJ5LmNvbnRlbnQgPT09IFwic3RyaW5nXCJcblx0XHRcdFx0XHQ/IHRhcmdldEVudHJ5LmNvbnRlbnRcblx0XHRcdFx0XHQ6IHRhcmdldEVudHJ5LmNvbnRlbnRcblx0XHRcdFx0XHRcdFx0LmZpbHRlcigoYyk6IGMgaXMgeyB0eXBlOiBcInRleHRcIjsgdGV4dDogc3RyaW5nIH0gPT4gYy50eXBlID09PSBcInRleHRcIilcblx0XHRcdFx0XHRcdFx0Lm1hcCgoYykgPT4gYy50ZXh0KVxuXHRcdFx0XHRcdFx0XHQuam9pbihcIlwiKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Ly8gTm9uLXVzZXIgbWVzc2FnZTogbGVhZiA9IHNlbGVjdGVkIG5vZGVcblx0XHRcdG5ld0xlYWZJZCA9IHRhcmdldElkO1xuXHRcdH1cblxuXHRcdC8vIFN3aXRjaCBsZWFmICh3aXRoIG9yIHdpdGhvdXQgc3VtbWFyeSlcblx0XHQvLyBTdW1tYXJ5IGlzIGF0dGFjaGVkIGF0IHRoZSBuYXZpZ2F0aW9uIHRhcmdldCBwb3NpdGlvbiAobmV3TGVhZklkKSwgbm90IHRoZSBvbGQgYnJhbmNoXG5cdFx0bGV0IHN1bW1hcnlFbnRyeTogQnJhbmNoU3VtbWFyeUVudHJ5IHwgdW5kZWZpbmVkO1xuXHRcdGlmIChzdW1tYXJ5VGV4dCkge1xuXHRcdFx0Ly8gQ3JlYXRlIHN1bW1hcnkgYXQgdGFyZ2V0IHBvc2l0aW9uIChjYW4gYmUgbnVsbCBmb3Igcm9vdClcblx0XHRcdGNvbnN0IHN1bW1hcnlJZCA9IHRoaXMuc2Vzc2lvbk1hbmFnZXIuYnJhbmNoV2l0aFN1bW1hcnkobmV3TGVhZklkLCBzdW1tYXJ5VGV4dCwgc3VtbWFyeURldGFpbHMsIGZyb21FeHRlbnNpb24pO1xuXHRcdFx0c3VtbWFyeUVudHJ5ID0gdGhpcy5zZXNzaW9uTWFuYWdlci5nZXRFbnRyeShzdW1tYXJ5SWQpIGFzIEJyYW5jaFN1bW1hcnlFbnRyeTtcblxuXHRcdFx0Ly8gQXR0YWNoIGxhYmVsIHRvIHRoZSBzdW1tYXJ5IGVudHJ5XG5cdFx0XHRpZiAobGFiZWwpIHtcblx0XHRcdFx0dGhpcy5zZXNzaW9uTWFuYWdlci5hcHBlbmRMYWJlbENoYW5nZShzdW1tYXJ5SWQsIGxhYmVsKTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKG5ld0xlYWZJZCA9PT0gbnVsbCkge1xuXHRcdFx0Ly8gTm8gc3VtbWFyeSwgbmF2aWdhdGluZyB0byByb290IC0gcmVzZXQgbGVhZlxuXHRcdFx0dGhpcy5zZXNzaW9uTWFuYWdlci5yZXNldExlYWYoKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Ly8gTm8gc3VtbWFyeSwgbmF2aWdhdGluZyB0byBub24tcm9vdFxuXHRcdFx0dGhpcy5zZXNzaW9uTWFuYWdlci5icmFuY2gobmV3TGVhZklkKTtcblx0XHR9XG5cblx0XHQvLyBBdHRhY2ggbGFiZWwgdG8gdGFyZ2V0IGVudHJ5IHdoZW4gbm90IHN1bW1hcml6aW5nIChubyBzdW1tYXJ5IGVudHJ5IHRvIGxhYmVsKVxuXHRcdGlmIChsYWJlbCAmJiAhc3VtbWFyeVRleHQpIHtcblx0XHRcdHRoaXMuc2Vzc2lvbk1hbmFnZXIuYXBwZW5kTGFiZWxDaGFuZ2UodGFyZ2V0SWQsIGxhYmVsKTtcblx0XHR9XG5cblx0XHQvLyBVcGRhdGUgYWdlbnQgc3RhdGVcblx0XHRjb25zdCBzZXNzaW9uQ29udGV4dCA9IHRoaXMuc2Vzc2lvbk1hbmFnZXIuYnVpbGRTZXNzaW9uQ29udGV4dCgpO1xuXHRcdHRoaXMuYWdlbnQucmVwbGFjZU1lc3NhZ2VzKHNlc3Npb25Db250ZXh0Lm1lc3NhZ2VzKTtcblxuXHRcdC8vIEVtaXQgc2Vzc2lvbl90cmVlIGV2ZW50XG5cdFx0aWYgKHRoaXMuX2V4dGVuc2lvblJ1bm5lcikge1xuXHRcdFx0YXdhaXQgdGhpcy5fZXh0ZW5zaW9uUnVubmVyLmVtaXQoe1xuXHRcdFx0XHR0eXBlOiBcInNlc3Npb25fdHJlZVwiLFxuXHRcdFx0XHRuZXdMZWFmSWQ6IHRoaXMuc2Vzc2lvbk1hbmFnZXIuZ2V0TGVhZklkKCksXG5cdFx0XHRcdG9sZExlYWZJZCxcblx0XHRcdFx0c3VtbWFyeUVudHJ5LFxuXHRcdFx0XHRmcm9tRXh0ZW5zaW9uOiBzdW1tYXJ5VGV4dCA/IGZyb21FeHRlbnNpb24gOiB1bmRlZmluZWQsXG5cdFx0XHR9KTtcblx0XHR9XG5cblx0XHQvLyBFbWl0IHRvIGN1c3RvbSB0b29sc1xuXG5cdFx0dGhpcy5fY29tcGFjdGlvbk9yY2hlc3RyYXRvci5icmFuY2hTdW1tYXJ5QWJvcnRDb250cm9sbGVyID0gdW5kZWZpbmVkO1xuXHRcdHJldHVybiB7IGVkaXRvclRleHQsIGNhbmNlbGxlZDogZmFsc2UsIHN1bW1hcnlFbnRyeSB9O1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBhbGwgdXNlciBtZXNzYWdlcyBmcm9tIHNlc3Npb24gZm9yIGZvcmsgc2VsZWN0b3IuXG5cdCAqL1xuXHRnZXRVc2VyTWVzc2FnZXNGb3JGb3JraW5nKCk6IEFycmF5PHsgZW50cnlJZDogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfT4ge1xuXHRcdGNvbnN0IGVudHJpZXMgPSB0aGlzLnNlc3Npb25NYW5hZ2VyLmdldEVudHJpZXMoKTtcblx0XHRjb25zdCByZXN1bHQ6IEFycmF5PHsgZW50cnlJZDogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfT4gPSBbXTtcblxuXHRcdGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuXHRcdFx0aWYgKGVudHJ5LnR5cGUgIT09IFwibWVzc2FnZVwiKSBjb250aW51ZTtcblx0XHRcdGlmIChlbnRyeS5tZXNzYWdlLnJvbGUgIT09IFwidXNlclwiKSBjb250aW51ZTtcblxuXHRcdFx0Y29uc3QgdGV4dCA9IHRoaXMuX2V4dHJhY3RVc2VyTWVzc2FnZVRleHQoZW50cnkubWVzc2FnZS5jb250ZW50KTtcblx0XHRcdGlmICh0ZXh0KSB7XG5cdFx0XHRcdHJlc3VsdC5wdXNoKHsgZW50cnlJZDogZW50cnkuaWQsIHRleHQgfSk7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHJlc3VsdDtcblx0fVxuXG5cdHByaXZhdGUgX2V4dHJhY3RVc2VyTWVzc2FnZVRleHQoY29udGVudDogc3RyaW5nIHwgQXJyYXk8eyB0eXBlOiBzdHJpbmc7IHRleHQ/OiBzdHJpbmcgfT4pOiBzdHJpbmcge1xuXHRcdGlmICh0eXBlb2YgY29udGVudCA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGNvbnRlbnQ7XG5cdFx0aWYgKEFycmF5LmlzQXJyYXkoY29udGVudCkpIHtcblx0XHRcdHJldHVybiBjb250ZW50XG5cdFx0XHRcdC5maWx0ZXIoKGMpOiBjIGlzIHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9ID0+IGMudHlwZSA9PT0gXCJ0ZXh0XCIpXG5cdFx0XHRcdC5tYXAoKGMpID0+IGMudGV4dClcblx0XHRcdFx0LmpvaW4oXCJcIik7XG5cdFx0fVxuXHRcdHJldHVybiBcIlwiO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBzZXNzaW9uIHN0YXRpc3RpY3MuXG5cdCAqL1xuXHRnZXRTZXNzaW9uU3RhdHMoKTogU2Vzc2lvblN0YXRzIHtcblx0XHRjb25zdCBzdGF0ZSA9IHRoaXMuc3RhdGU7XG5cdFx0Y29uc3QgdXNlck1lc3NhZ2VzID0gc3RhdGUubWVzc2FnZXMuZmlsdGVyKChtKSA9PiBtLnJvbGUgPT09IFwidXNlclwiKS5sZW5ndGg7XG5cdFx0Y29uc3QgYXNzaXN0YW50TWVzc2FnZXMgPSBzdGF0ZS5tZXNzYWdlcy5maWx0ZXIoKG0pID0+IG0ucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikubGVuZ3RoO1xuXHRcdGNvbnN0IHRvb2xSZXN1bHRzID0gc3RhdGUubWVzc2FnZXMuZmlsdGVyKChtKSA9PiBtLnJvbGUgPT09IFwidG9vbFJlc3VsdFwiKS5sZW5ndGg7XG5cblx0XHRsZXQgdG9vbENhbGxzID0gMDtcblx0XHRsZXQgdG90YWxJbnB1dCA9IDA7XG5cdFx0bGV0IHRvdGFsT3V0cHV0ID0gMDtcblx0XHRsZXQgdG90YWxDYWNoZVJlYWQgPSAwO1xuXHRcdGxldCB0b3RhbENhY2hlV3JpdGUgPSAwO1xuXHRcdGxldCB0b3RhbENvc3QgPSAwO1xuXG5cdFx0Zm9yIChjb25zdCBtZXNzYWdlIG9mIHN0YXRlLm1lc3NhZ2VzKSB7XG5cdFx0XHRpZiAobWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiKSB7XG5cdFx0XHRcdGNvbnN0IGFzc2lzdGFudE1zZyA9IG1lc3NhZ2UgYXMgQXNzaXN0YW50TWVzc2FnZTtcblx0XHRcdFx0dG9vbENhbGxzICs9IGFzc2lzdGFudE1zZy5jb250ZW50LmZpbHRlcigoYykgPT4gYy50eXBlID09PSBcInRvb2xDYWxsXCIpLmxlbmd0aDtcblx0XHRcdFx0dG90YWxJbnB1dCArPSBhc3Npc3RhbnRNc2cudXNhZ2UuaW5wdXQ7XG5cdFx0XHRcdHRvdGFsT3V0cHV0ICs9IGFzc2lzdGFudE1zZy51c2FnZS5vdXRwdXQ7XG5cdFx0XHRcdHRvdGFsQ2FjaGVSZWFkICs9IGFzc2lzdGFudE1zZy51c2FnZS5jYWNoZVJlYWQ7XG5cdFx0XHRcdHRvdGFsQ2FjaGVXcml0ZSArPSBhc3Npc3RhbnRNc2cudXNhZ2UuY2FjaGVXcml0ZTtcblx0XHRcdFx0dG90YWxDb3N0ICs9IGFzc2lzdGFudE1zZy51c2FnZS5jb3N0LnRvdGFsO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiB7XG5cdFx0XHRzZXNzaW9uRmlsZTogdGhpcy5zZXNzaW9uRmlsZSxcblx0XHRcdHNlc3Npb25JZDogdGhpcy5zZXNzaW9uSWQsXG5cdFx0XHR1c2VyTWVzc2FnZXMsXG5cdFx0XHRhc3Npc3RhbnRNZXNzYWdlcyxcblx0XHRcdHRvb2xDYWxsczogTWF0aC5tYXgodG9vbENhbGxzLCB0aGlzLl9jdW11bGF0aXZlVG9vbENhbGxzKSxcblx0XHRcdHRvb2xSZXN1bHRzLFxuXHRcdFx0dG90YWxNZXNzYWdlczogc3RhdGUubWVzc2FnZXMubGVuZ3RoLFxuXHRcdFx0dG9rZW5zOiB7XG5cdFx0XHRcdGlucHV0OiBNYXRoLm1heCh0b3RhbElucHV0LCB0aGlzLl9jdW11bGF0aXZlSW5wdXRUb2tlbnMpLFxuXHRcdFx0XHRvdXRwdXQ6IE1hdGgubWF4KHRvdGFsT3V0cHV0LCB0aGlzLl9jdW11bGF0aXZlT3V0cHV0VG9rZW5zKSxcblx0XHRcdFx0Y2FjaGVSZWFkOiB0b3RhbENhY2hlUmVhZCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogdG90YWxDYWNoZVdyaXRlLFxuXHRcdFx0XHR0b3RhbDogTWF0aC5tYXgodG90YWxJbnB1dCArIHRvdGFsT3V0cHV0LCB0aGlzLl9jdW11bGF0aXZlSW5wdXRUb2tlbnMgKyB0aGlzLl9jdW11bGF0aXZlT3V0cHV0VG9rZW5zKSArIHRvdGFsQ2FjaGVSZWFkICsgdG90YWxDYWNoZVdyaXRlLFxuXHRcdFx0fSxcblx0XHRcdGNvc3Q6IE1hdGgubWF4KHRvdGFsQ29zdCwgdGhpcy5fY3VtdWxhdGl2ZUNvc3QpLFxuXHRcdH07XG5cdH1cblxuXHQvKipcblx0ICogR2V0IHRoZSBjb3N0IG9mIHRoZSBtb3N0IHJlY2VudCBhc3Npc3RhbnQgcmVzcG9uc2UuXG5cdCAqIFJldHVybnMgMCBpZiBubyBhc3Npc3RhbnQgbWVzc2FnZSBoYXMgYmVlbiByZWNlaXZlZCB5ZXQuXG5cdCAqL1xuXHRnZXRMYXN0VHVybkNvc3QoKTogbnVtYmVyIHtcblx0XHRyZXR1cm4gdGhpcy5fbGFzdFR1cm5Db3N0O1xuXHR9XG5cblx0Z2V0Q29udGV4dFVzYWdlKCk6IENvbnRleHRVc2FnZSB8IHVuZGVmaW5lZCB7XG5cdFx0Y29uc3QgbW9kZWwgPSB0aGlzLm1vZGVsO1xuXHRcdGlmICghbW9kZWwpIHJldHVybiB1bmRlZmluZWQ7XG5cblx0XHRjb25zdCBjb250ZXh0V2luZG93ID0gbW9kZWwuY29udGV4dFdpbmRvdyA/PyAwO1xuXHRcdGlmIChjb250ZXh0V2luZG93IDw9IDApIHJldHVybiB1bmRlZmluZWQ7XG5cblx0XHQvLyBBZnRlciBjb21wYWN0aW9uLCB0aGUgbGFzdCBhc3Npc3RhbnQgdXNhZ2UgcmVmbGVjdHMgcHJlLWNvbXBhY3Rpb24gY29udGV4dCBzaXplLlxuXHRcdC8vIFdlIGNhbiBvbmx5IHRydXN0IHVzYWdlIGZyb20gYW4gYXNzaXN0YW50IHRoYXQgcmVzcG9uZGVkIGFmdGVyIHRoZSBsYXRlc3QgY29tcGFjdGlvbi5cblx0XHQvLyBJZiBubyBzdWNoIGFzc2lzdGFudCBleGlzdHMsIGNvbnRleHQgdG9rZW4gY291bnQgaXMgdW5rbm93biB1bnRpbCB0aGUgbmV4dCBMTE0gcmVzcG9uc2UuXG5cdFx0Y29uc3QgYnJhbmNoRW50cmllcyA9IHRoaXMuc2Vzc2lvbk1hbmFnZXIuZ2V0QnJhbmNoKCk7XG5cdFx0Y29uc3QgbGF0ZXN0Q29tcGFjdGlvbiA9IGdldExhdGVzdENvbXBhY3Rpb25FbnRyeShicmFuY2hFbnRyaWVzKTtcblxuXHRcdGlmIChsYXRlc3RDb21wYWN0aW9uKSB7XG5cdFx0XHQvLyBDaGVjayBpZiB0aGVyZSdzIGEgdmFsaWQgYXNzaXN0YW50IHVzYWdlIGFmdGVyIHRoZSBjb21wYWN0aW9uIGJvdW5kYXJ5XG5cdFx0XHRjb25zdCBjb21wYWN0aW9uSW5kZXggPSBicmFuY2hFbnRyaWVzLmxhc3RJbmRleE9mKGxhdGVzdENvbXBhY3Rpb24pO1xuXHRcdFx0bGV0IGhhc1Bvc3RDb21wYWN0aW9uVXNhZ2UgPSBmYWxzZTtcblx0XHRcdGZvciAobGV0IGkgPSBicmFuY2hFbnRyaWVzLmxlbmd0aCAtIDE7IGkgPiBjb21wYWN0aW9uSW5kZXg7IGktLSkge1xuXHRcdFx0XHRjb25zdCBlbnRyeSA9IGJyYW5jaEVudHJpZXNbaV07XG5cdFx0XHRcdGlmIChlbnRyeS50eXBlID09PSBcIm1lc3NhZ2VcIiAmJiBlbnRyeS5tZXNzYWdlLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcblx0XHRcdFx0XHRjb25zdCBhc3Npc3RhbnQgPSBlbnRyeS5tZXNzYWdlO1xuXHRcdFx0XHRcdGlmIChhc3Npc3RhbnQuc3RvcFJlYXNvbiAhPT0gXCJhYm9ydGVkXCIgJiYgYXNzaXN0YW50LnN0b3BSZWFzb24gIT09IFwiZXJyb3JcIikge1xuXHRcdFx0XHRcdFx0Y29uc3QgY29udGV4dFRva2VucyA9IGNhbGN1bGF0ZUNvbnRleHRUb2tlbnMoYXNzaXN0YW50LnVzYWdlKTtcblx0XHRcdFx0XHRcdGlmIChjb250ZXh0VG9rZW5zID4gMCkge1xuXHRcdFx0XHRcdFx0XHRoYXNQb3N0Q29tcGFjdGlvblVzYWdlID0gdHJ1ZTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRpZiAoIWhhc1Bvc3RDb21wYWN0aW9uVXNhZ2UpIHtcblx0XHRcdFx0cmV0dXJuIHsgdG9rZW5zOiBudWxsLCBjb250ZXh0V2luZG93LCBwZXJjZW50OiBudWxsIH07XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Y29uc3QgZXN0aW1hdGUgPSBlc3RpbWF0ZUNvbnRleHRUb2tlbnModGhpcy5tZXNzYWdlcyk7XG5cdFx0Y29uc3QgcGVyY2VudCA9IChlc3RpbWF0ZS50b2tlbnMgLyBjb250ZXh0V2luZG93KSAqIDEwMDtcblxuXHRcdHJldHVybiB7XG5cdFx0XHR0b2tlbnM6IGVzdGltYXRlLnRva2Vucyxcblx0XHRcdGNvbnRleHRXaW5kb3csXG5cdFx0XHRwZXJjZW50LFxuXHRcdH07XG5cdH1cblxuXHQvKipcblx0ICogRXhwb3J0IHNlc3Npb24gdG8gSFRNTC5cblx0ICogQHBhcmFtIG91dHB1dFBhdGggT3B0aW9uYWwgb3V0cHV0IHBhdGggKGRlZmF1bHRzIHRvIHNlc3Npb24gZGlyZWN0b3J5KVxuXHQgKiBAcmV0dXJucyBQYXRoIHRvIGV4cG9ydGVkIGZpbGVcblx0ICovXG5cdGFzeW5jIGV4cG9ydFRvSHRtbChvdXRwdXRQYXRoPzogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCB0aGVtZU5hbWUgPSB0aGlzLnNldHRpbmdzTWFuYWdlci5nZXRUaGVtZSgpO1xuXG5cdFx0Ly8gQ3JlYXRlIHRvb2wgcmVuZGVyZXIgZm9yIGV4dGVuc2lvbiBhbmQgYnVpbHQtaW4gdG9vbCBIVE1MIHJlbmRlcmluZ1xuXHRcdGNvbnN0IHRvb2xSZW5kZXJlciA9IGNyZWF0ZVRvb2xIdG1sUmVuZGVyZXIoe1xuXHRcdFx0Z2V0VG9vbERlZmluaXRpb246IChuYW1lKSA9PiB0aGlzLmdldFJlbmRlcmFibGVUb29sRGVmaW5pdGlvbihuYW1lKSxcblx0XHRcdHRoZW1lLFxuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIGF3YWl0IGV4cG9ydFNlc3Npb25Ub0h0bWwodGhpcy5zZXNzaW9uTWFuYWdlciwgdGhpcy5zdGF0ZSwge1xuXHRcdFx0b3V0cHV0UGF0aCxcblx0XHRcdHRoZW1lTmFtZSxcblx0XHRcdHRvb2xSZW5kZXJlcixcblx0XHR9KTtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gVXRpbGl0aWVzXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHQvKipcblx0ICogR2V0IHRleHQgY29udGVudCBvZiBsYXN0IGFzc2lzdGFudCBtZXNzYWdlLlxuXHQgKiBVc2VmdWwgZm9yIC9jb3B5IGNvbW1hbmQuXG5cdCAqIEByZXR1cm5zIFRleHQgY29udGVudCwgb3IgdW5kZWZpbmVkIGlmIG5vIGFzc2lzdGFudCBtZXNzYWdlIGV4aXN0c1xuXHQgKi9cblx0Z2V0TGFzdEFzc2lzdGFudFRleHQoKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcblx0XHRjb25zdCBsYXN0QXNzaXN0YW50ID0gdGhpcy5tZXNzYWdlc1xuXHRcdFx0LnNsaWNlKClcblx0XHRcdC5yZXZlcnNlKClcblx0XHRcdC5maW5kKChtKSA9PiB7XG5cdFx0XHRcdGlmIChtLnJvbGUgIT09IFwiYXNzaXN0YW50XCIpIHJldHVybiBmYWxzZTtcblx0XHRcdFx0Y29uc3QgbXNnID0gbSBhcyBBc3Npc3RhbnRNZXNzYWdlO1xuXHRcdFx0XHQvLyBTa2lwIGFib3J0ZWQgbWVzc2FnZXMgd2l0aCBubyBjb250ZW50XG5cdFx0XHRcdGlmIChtc2cuc3RvcFJlYXNvbiA9PT0gXCJhYm9ydGVkXCIgJiYgbXNnLmNvbnRlbnQubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fSk7XG5cblx0XHRpZiAoIWxhc3RBc3Npc3RhbnQpIHJldHVybiB1bmRlZmluZWQ7XG5cblx0XHRsZXQgdGV4dCA9IFwiXCI7XG5cdFx0Zm9yIChjb25zdCBjb250ZW50IG9mIChsYXN0QXNzaXN0YW50IGFzIEFzc2lzdGFudE1lc3NhZ2UpLmNvbnRlbnQpIHtcblx0XHRcdGlmIChjb250ZW50LnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdHRleHQgKz0gY29udGVudC50ZXh0O1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiB0ZXh0LnRyaW0oKSB8fCB1bmRlZmluZWQ7XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIEV4dGVuc2lvbiBTeXN0ZW1cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiBleHRlbnNpb25zIGhhdmUgaGFuZGxlcnMgZm9yIGEgc3BlY2lmaWMgZXZlbnQgdHlwZS5cblx0ICovXG5cdGhhc0V4dGVuc2lvbkhhbmRsZXJzKGV2ZW50VHlwZTogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuX2V4dGVuc2lvblJ1bm5lcj8uaGFzSGFuZGxlcnMoZXZlbnRUeXBlKSA/PyBmYWxzZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgdGhlIGV4dGVuc2lvbiBydW5uZXIgKGZvciBzZXR0aW5nIFVJIGNvbnRleHQgYW5kIGVycm9yIGhhbmRsZXJzKS5cblx0ICovXG5cdGdldCBleHRlbnNpb25SdW5uZXIoKTogRXh0ZW5zaW9uUnVubmVyIHwgdW5kZWZpbmVkIHtcblx0XHRyZXR1cm4gdGhpcy5fZXh0ZW5zaW9uUnVubmVyO1xuXHR9XG59XG4iXSwKICAibWFw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
