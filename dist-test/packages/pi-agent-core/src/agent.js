import {
  getModel,
  streamSimple
} from "@gsd/pi-ai";
import { randomUUID } from "crypto";
import { agentLoop, agentLoopContinue, ZERO_USAGE } from "./agent-loop.js";
function defaultConvertToLlm(messages) {
  return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}
class Agent {
  constructor(opts = {}) {
    this._state = {
      systemPrompt: "",
      model: getModel("google", "gemini-2.5-flash-lite-preview-06-17"),
      thinkingLevel: "off",
      tools: [],
      messages: [],
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: /* @__PURE__ */ new Set(),
      error: void 0
    };
    this.listeners = /* @__PURE__ */ new Set();
    this.steeringQueue = [];
    this.followUpQueue = [];
    this._state = { ...this._state, ...opts.initialState };
    this.convertToLlm = opts.convertToLlm || defaultConvertToLlm;
    this.transformContext = opts.transformContext;
    this.filterTools = opts.filterTools;
    this.steeringMode = opts.steeringMode || "one-at-a-time";
    this.followUpMode = opts.followUpMode || "one-at-a-time";
    this.streamFn = opts.streamFn || streamSimple;
    this._sessionId = opts.sessionId;
    this.getApiKey = opts.getApiKey;
    this._onPayload = opts.onPayload;
    this._thinkingBudgets = opts.thinkingBudgets;
    this._transport = opts.transport ?? "sse";
    this._maxRetryDelayMs = opts.maxRetryDelayMs;
    this._externalToolExecution = opts.externalToolExecution;
    this._getProviderOptions = opts.getProviderOptions;
  }
  /**
   * Get the current session ID used for provider caching.
   */
  get sessionId() {
    return this._sessionId;
  }
  /**
   * Set the session ID for provider caching.
   * Call this when switching sessions (new session, branch, resume).
   */
  set sessionId(value) {
    this._sessionId = value;
  }
  /**
   * Get the current thinking budgets.
   */
  get thinkingBudgets() {
    return this._thinkingBudgets;
  }
  /**
   * Set custom thinking budgets for token-based providers.
   */
  set thinkingBudgets(value) {
    this._thinkingBudgets = value;
  }
  /**
   * Get the current preferred transport.
   */
  get transport() {
    return this._transport;
  }
  /**
   * Set the preferred transport.
   */
  setTransport(value) {
    this._transport = value;
  }
  /**
   * Get the current max retry delay in milliseconds.
   */
  get maxRetryDelayMs() {
    return this._maxRetryDelayMs;
  }
  /**
   * Set the maximum delay to wait for server-requested retries.
   * Set to 0 to disable the cap.
   */
  set maxRetryDelayMs(value) {
    this._maxRetryDelayMs = value;
  }
  /**
   * Install a hook called before each tool executes, after argument validation.
   * Return `{ block: true }` to prevent execution.
   */
  setBeforeToolCall(fn) {
    this._beforeToolCall = fn;
  }
  /**
   * Install a hook called after each tool executes, before results are emitted.
   * Return field overrides for content/details/isError.
   */
  setAfterToolCall(fn) {
    this._afterToolCall = fn;
  }
  get state() {
    return this._state;
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  // State mutators
  setSystemPrompt(v) {
    this._state.systemPrompt = v;
  }
  setModel(m) {
    this._state.model = m;
  }
  setThinkingLevel(l) {
    this._state.thinkingLevel = l;
  }
  setSteeringMode(mode) {
    this.steeringMode = mode;
  }
  getSteeringMode() {
    return this.steeringMode;
  }
  setFollowUpMode(mode) {
    this.followUpMode = mode;
  }
  getFollowUpMode() {
    return this.followUpMode;
  }
  setTools(t) {
    this._state.tools = t;
  }
  replaceMessages(ms) {
    this._state.messages = ms.slice();
  }
  appendMessage(m) {
    this._state.messages = [...this._state.messages, m];
  }
  /**
   * Queue a steering message to interrupt the agent mid-run.
   * Delivered after current tool execution, skips remaining tools.
   */
  steer(m, origin = "system") {
    this.steeringQueue.push({ message: m, origin });
  }
  /**
   * Queue a follow-up message to be processed after the agent finishes.
   * Delivered only when agent has no more tool calls or steering messages.
   */
  followUp(m, origin = "system") {
    this.followUpQueue.push({ message: m, origin });
  }
  clearSteeringQueue() {
    this.steeringQueue = [];
  }
  clearFollowUpQueue() {
    this.followUpQueue = [];
  }
  clearAllQueues() {
    this.steeringQueue = [];
    this.followUpQueue = [];
  }
  /**
   * Drain user-origin messages from queues, leaving system messages in place.
   * Used during abort to preserve messages the user explicitly typed.
   */
  drainUserMessages() {
    const userSteering = this.steeringQueue.filter((e) => e.origin === "user").map((e) => e.message);
    const userFollowUp = this.followUpQueue.filter((e) => e.origin === "user").map((e) => e.message);
    this.steeringQueue = this.steeringQueue.filter((e) => e.origin !== "user");
    this.followUpQueue = this.followUpQueue.filter((e) => e.origin !== "user");
    return { steering: userSteering, followUp: userFollowUp };
  }
  hasQueuedMessages() {
    return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
  }
  dequeueSteeringMessages() {
    if (this.steeringMode === "one-at-a-time") {
      if (this.steeringQueue.length > 0) {
        const first = this.steeringQueue[0];
        this.steeringQueue = this.steeringQueue.slice(1);
        return [first.message];
      }
      return [];
    }
    const steering = this.steeringQueue.map((e) => e.message);
    this.steeringQueue = [];
    return steering;
  }
  dequeueFollowUpMessages() {
    if (this.followUpMode === "one-at-a-time") {
      if (this.followUpQueue.length > 0) {
        const first = this.followUpQueue[0];
        this.followUpQueue = this.followUpQueue.slice(1);
        return [first.message];
      }
      return [];
    }
    const followUp = this.followUpQueue.map((e) => e.message);
    this.followUpQueue = [];
    return followUp;
  }
  clearMessages() {
    this._state.messages = [];
  }
  abort(origin = "unknown") {
    this.abortOrigin = origin;
    this.abortController?.abort();
  }
  waitForIdle() {
    return this.runningPrompt ?? Promise.resolve();
  }
  reset() {
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamMessage = null;
    this._state.pendingToolCalls = /* @__PURE__ */ new Set();
    this._state.error = void 0;
    this.steeringQueue = [];
    this.followUpQueue = [];
  }
  async prompt(input, images) {
    if (this._state.isStreaming) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion."
      );
    }
    const model = this._state.model;
    if (!model) throw new Error("No model configured");
    let msgs;
    if (Array.isArray(input)) {
      msgs = input;
    } else if (typeof input === "string") {
      const content = [{ type: "text", text: input }];
      if (images && images.length > 0) {
        content.push(...images);
      }
      msgs = [
        {
          role: "user",
          content,
          timestamp: Date.now()
        }
      ];
    } else {
      msgs = [input];
    }
    await this._runLoop(msgs);
  }
  /**
   * Continue from current context (used for retries and resuming queued messages).
   */
  async continue() {
    if (this._state.isStreaming) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }
    const messages = this._state.messages;
    if (messages.length === 0) {
      throw new Error("No messages to continue from");
    }
    if (messages[messages.length - 1].role === "assistant") {
      const queuedSteering = this.dequeueSteeringMessages();
      if (queuedSteering.length > 0) {
        await this._runLoop(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }
      const queuedFollowUp = this.dequeueFollowUpMessages();
      if (queuedFollowUp.length > 0) {
        await this._runLoop(queuedFollowUp);
        return;
      }
      throw new Error("Cannot continue from message role: assistant");
    }
    await this._runLoop(void 0);
  }
  /**
   * Run the agent loop.
   * If messages are provided, starts a new conversation turn with those messages.
   * Otherwise, continues from existing context.
   */
  async _runLoop(messages, options) {
    const model = this._state.model;
    if (!model) throw new Error("No model configured");
    const turnId = randomUUID();
    const sessionId = this._sessionId;
    this._state.activeInferenceModel = model;
    this.runningPrompt = new Promise((resolve) => {
      this.resolveRunningPrompt = resolve;
    });
    this.abortController = new AbortController();
    this._state.isStreaming = true;
    this._state.streamMessage = null;
    this._state.error = void 0;
    const reasoning = this._state.thinkingLevel === "off" ? void 0 : this._state.thinkingLevel;
    const context = {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools
    };
    let skipInitialSteeringPoll = options?.skipInitialSteeringPoll === true;
    const providerOptions = await this._getProviderOptions?.(model);
    const config = {
      ...providerOptions ?? {},
      model,
      reasoning,
      sessionId: this._sessionId,
      onPayload: this._onPayload,
      transport: this._transport,
      thinkingBudgets: this._thinkingBudgets,
      maxRetryDelayMs: this._maxRetryDelayMs,
      convertToLlm: this.convertToLlm,
      transformContext: this.transformContext,
      filterTools: this.filterTools,
      getApiKey: this.getApiKey,
      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.dequeueSteeringMessages();
      },
      getFollowUpMessages: async () => this.dequeueFollowUpMessages(),
      beforeToolCall: this._beforeToolCall,
      afterToolCall: this._afterToolCall,
      externalToolExecution: this._externalToolExecution?.(model) ?? false
    };
    let partial = null;
    try {
      const stream = messages ? agentLoop(messages, context, config, this.abortController.signal, this.streamFn) : agentLoopContinue(context, config, this.abortController.signal, this.streamFn);
      for await (const event of stream) {
        const stampedEvent = this.stampEvent(event, sessionId, turnId);
        switch (stampedEvent.type) {
          case "message_start":
          case "message_update":
            partial = stampedEvent.message;
            this._state.streamMessage = stampedEvent.message;
            break;
          case "message_end":
            partial = null;
            this._state.streamMessage = null;
            this.appendMessage(stampedEvent.message);
            break;
          case "tool_execution_start":
            this._updatePendingToolCalls("add", stampedEvent.toolCallId);
            break;
          case "tool_execution_end":
            this._updatePendingToolCalls("delete", stampedEvent.toolCallId);
            break;
          case "turn_end":
            if (stampedEvent.message.role === "assistant" && stampedEvent.message.errorMessage) {
              this._state.error = stampedEvent.message.errorMessage;
            }
            break;
          case "agent_end":
            this._state.isStreaming = false;
            this._state.streamMessage = null;
            break;
        }
        this.emit(stampedEvent);
      }
      if (partial && partial.role === "assistant" && partial.content.length > 0) {
        const onlyEmpty = !partial.content.some(
          (c) => c.type === "thinking" && c.thinking.trim().length > 0 || c.type === "text" && c.text.trim().length > 0 || c.type === "toolCall" && c.name.trim().length > 0
        );
        if (!onlyEmpty) {
          this.appendMessage(partial);
        } else {
          if (this.abortController?.signal.aborted) {
            throw new Error("Request was aborted");
          }
        }
      }
    } catch (err) {
      const errorMsg = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: this.abortController?.signal.aborted ? "aborted" : "error",
        errorMessage: err?.message || String(err),
        timestamp: Date.now()
      };
      this.appendMessage(errorMsg);
      this._state.error = err?.message || String(err);
      const agentEndEvent = {
        type: "agent_end",
        messages: [errorMsg],
        sessionId,
        turnId
      };
      if (this.abortController?.signal.aborted) {
        agentEndEvent.abortOrigin = this.abortOrigin ?? "unknown";
      }
      this.emit(agentEndEvent);
    } finally {
      this._state.isStreaming = false;
      this._state.streamMessage = null;
      this._state.pendingToolCalls = /* @__PURE__ */ new Set();
      this._state.activeInferenceModel = void 0;
      this.abortOrigin = void 0;
      this.abortController = void 0;
      this.resolveRunningPrompt?.();
      this.runningPrompt = void 0;
      this.resolveRunningPrompt = void 0;
    }
  }
  stampEvent(event, sessionId, turnId) {
    switch (event.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_update":
      case "message_end":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        return { ...event, sessionId, turnId };
    }
  }
  _updatePendingToolCalls(action, id) {
    const s = new Set(this._state.pendingToolCalls);
    s[action](id);
    this._state.pendingToolCalls = s;
  }
  emit(e) {
    for (const listener of this.listeners) {
      listener(e);
    }
  }
}
export {
  Agent
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktYWdlbnQtY29yZS9zcmMvYWdlbnQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogQWdlbnQgY2xhc3MgdGhhdCB1c2VzIHRoZSBhZ2VudC1sb29wIGRpcmVjdGx5LlxuICogTm8gdHJhbnNwb3J0IGFic3RyYWN0aW9uIC0gY2FsbHMgc3RyZWFtU2ltcGxlIHZpYSB0aGUgbG9vcC5cbiAqL1xuXG5pbXBvcnQge1xuXHRnZXRNb2RlbCxcblx0dHlwZSBJbWFnZUNvbnRlbnQsXG5cdHR5cGUgTWVzc2FnZSxcblx0dHlwZSBNb2RlbCxcblx0dHlwZSBTaW1wbGVTdHJlYW1PcHRpb25zLFxuXHRzdHJlYW1TaW1wbGUsXG5cdHR5cGUgVGV4dENvbnRlbnQsXG5cdHR5cGUgVGhpbmtpbmdCdWRnZXRzLFxuXHR0eXBlIFRyYW5zcG9ydCxcbn0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tIFwiY3J5cHRvXCI7XG5pbXBvcnQgeyBhZ2VudExvb3AsIGFnZW50TG9vcENvbnRpbnVlLCBaRVJPX1VTQUdFIH0gZnJvbSBcIi4vYWdlbnQtbG9vcC5qc1wiO1xuaW1wb3J0IHR5cGUge1xuXHRBZ2VudENvbnRleHQsXG5cdEFnZW50QWJvcnRPcmlnaW4sXG5cdEFnZW50RXZlbnQsXG5cdEFnZW50TG9vcENvbmZpZyxcblx0QWdlbnRNZXNzYWdlLFxuXHRBZ2VudFN0YXRlLFxuXHRBZ2VudFRvb2wsXG5cdEJlZm9yZVRvb2xDYWxsQ29udGV4dCxcblx0QmVmb3JlVG9vbENhbGxSZXN1bHQsXG5cdEFmdGVyVG9vbENhbGxDb250ZXh0LFxuXHRBZnRlclRvb2xDYWxsUmVzdWx0LFxuXHRTdHJlYW1Gbixcblx0VGhpbmtpbmdMZXZlbCxcbn0gZnJvbSBcIi4vdHlwZXMuanNcIjtcblxuLyoqXG4gKiBEZWZhdWx0IGNvbnZlcnRUb0xsbTogS2VlcCBvbmx5IExMTS1jb21wYXRpYmxlIG1lc3NhZ2VzLCBjb252ZXJ0IGF0dGFjaG1lbnRzLlxuICovXG5mdW5jdGlvbiBkZWZhdWx0Q29udmVydFRvTGxtKG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSk6IE1lc3NhZ2VbXSB7XG5cdHJldHVybiBtZXNzYWdlcy5maWx0ZXIoKG0pID0+IG0ucm9sZSA9PT0gXCJ1c2VyXCIgfHwgbS5yb2xlID09PSBcImFzc2lzdGFudFwiIHx8IG0ucm9sZSA9PT0gXCJ0b29sUmVzdWx0XCIpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFnZW50T3B0aW9ucyB7XG5cdGluaXRpYWxTdGF0ZT86IFBhcnRpYWw8QWdlbnRTdGF0ZT47XG5cblx0LyoqXG5cdCAqIENvbnZlcnRzIEFnZW50TWVzc2FnZVtdIHRvIExMTS1jb21wYXRpYmxlIE1lc3NhZ2VbXSBiZWZvcmUgZWFjaCBMTE0gY2FsbC5cblx0ICogRGVmYXVsdCBmaWx0ZXJzIHRvIHVzZXIvYXNzaXN0YW50L3Rvb2xSZXN1bHQgYW5kIGNvbnZlcnRzIGF0dGFjaG1lbnRzLlxuXHQgKi9cblx0Y29udmVydFRvTGxtPzogKG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSkgPT4gTWVzc2FnZVtdIHwgUHJvbWlzZTxNZXNzYWdlW10+O1xuXG5cdC8qKlxuXHQgKiBPcHRpb25hbCB0cmFuc2Zvcm0gYXBwbGllZCB0byBjb250ZXh0IGJlZm9yZSBjb252ZXJ0VG9MbG0uXG5cdCAqIFVzZSBmb3IgY29udGV4dCBwcnVuaW5nLCBpbmplY3RpbmcgZXh0ZXJuYWwgY29udGV4dCwgZXRjLlxuXHQgKi9cblx0dHJhbnNmb3JtQ29udGV4dD86IChtZXNzYWdlczogQWdlbnRNZXNzYWdlW10sIHNpZ25hbD86IEFib3J0U2lnbmFsKSA9PiBQcm9taXNlPEFnZW50TWVzc2FnZVtdPjtcblxuXHQvKipcblx0ICogT3B0aW9uYWwgZmluYWwgdG9vbCBmaWx0ZXIgYXBwbGllZCBpbW1lZGlhdGVseSBiZWZvcmUgZWFjaCBwcm92aWRlciBjYWxsLlxuXHQgKi9cblx0ZmlsdGVyVG9vbHM/OiBBZ2VudExvb3BDb25maWdbXCJmaWx0ZXJUb29sc1wiXTtcblxuXHQvKipcblx0ICogU3RlZXJpbmcgbW9kZTogXCJhbGxcIiA9IHNlbmQgYWxsIHN0ZWVyaW5nIG1lc3NhZ2VzIGF0IG9uY2UsIFwib25lLWF0LWEtdGltZVwiID0gb25lIHBlciB0dXJuXG5cdCAqL1xuXHRzdGVlcmluZ01vZGU/OiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCI7XG5cblx0LyoqXG5cdCAqIEZvbGxvdy11cCBtb2RlOiBcImFsbFwiID0gc2VuZCBhbGwgZm9sbG93LXVwIG1lc3NhZ2VzIGF0IG9uY2UsIFwib25lLWF0LWEtdGltZVwiID0gb25lIHBlciB0dXJuXG5cdCAqL1xuXHRmb2xsb3dVcE1vZGU/OiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCI7XG5cblx0LyoqXG5cdCAqIEN1c3RvbSBzdHJlYW0gZnVuY3Rpb24gKGZvciBwcm94eSBiYWNrZW5kcywgZXRjLikuIERlZmF1bHQgdXNlcyBzdHJlYW1TaW1wbGUuXG5cdCAqL1xuXHRzdHJlYW1Gbj86IFN0cmVhbUZuO1xuXG5cdC8qKlxuXHQgKiBPcHRpb25hbCBzZXNzaW9uIGlkZW50aWZpZXIgZm9yd2FyZGVkIHRvIExMTSBwcm92aWRlcnMuXG5cdCAqIFVzZWQgYnkgcHJvdmlkZXJzIHRoYXQgc3VwcG9ydCBzZXNzaW9uLWJhc2VkIGNhY2hpbmcgKGUuZy4sIE9wZW5BSSBDb2RleCkuXG5cdCAqL1xuXHRzZXNzaW9uSWQ/OiBzdHJpbmc7XG5cblx0LyoqXG5cdCAqIFJlc29sdmVzIGFuIEFQSSBrZXkgZHluYW1pY2FsbHkgZm9yIGVhY2ggTExNIGNhbGwuXG5cdCAqIFVzZWZ1bCBmb3IgZXhwaXJpbmcgdG9rZW5zIChlLmcuLCBHaXRIdWIgQ29waWxvdCBPQXV0aCkuXG5cdCAqL1xuXHRnZXRBcGlLZXk/OiAocHJvdmlkZXI6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHwgc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG5cdC8qKlxuXHQgKiBJbnNwZWN0IG9yIHJlcGxhY2UgcHJvdmlkZXIgcGF5bG9hZHMgYmVmb3JlIHRoZXkgYXJlIHNlbnQuXG5cdCAqL1xuXHRvblBheWxvYWQ/OiBTaW1wbGVTdHJlYW1PcHRpb25zW1wib25QYXlsb2FkXCJdO1xuXG5cdC8qKlxuXHQgKiBDdXN0b20gdG9rZW4gYnVkZ2V0cyBmb3IgdGhpbmtpbmcgbGV2ZWxzICh0b2tlbi1iYXNlZCBwcm92aWRlcnMgb25seSkuXG5cdCAqL1xuXHR0aGlua2luZ0J1ZGdldHM/OiBUaGlua2luZ0J1ZGdldHM7XG5cblx0LyoqXG5cdCAqIFByZWZlcnJlZCB0cmFuc3BvcnQgZm9yIHByb3ZpZGVycyB0aGF0IHN1cHBvcnQgbXVsdGlwbGUgdHJhbnNwb3J0cy5cblx0ICovXG5cdHRyYW5zcG9ydD86IFRyYW5zcG9ydDtcblxuXHQvKipcblx0ICogTWF4aW11bSBkZWxheSBpbiBtaWxsaXNlY29uZHMgdG8gd2FpdCBmb3IgYSByZXRyeSB3aGVuIHRoZSBzZXJ2ZXIgcmVxdWVzdHMgYSBsb25nIHdhaXQuXG5cdCAqIElmIHRoZSBzZXJ2ZXIncyByZXF1ZXN0ZWQgZGVsYXkgZXhjZWVkcyB0aGlzIHZhbHVlLCB0aGUgcmVxdWVzdCBmYWlscyBpbW1lZGlhdGVseSxcblx0ICogYWxsb3dpbmcgaGlnaGVyLWxldmVsIHJldHJ5IGxvZ2ljIHRvIGhhbmRsZSBpdCB3aXRoIHVzZXIgdmlzaWJpbGl0eS5cblx0ICogRGVmYXVsdDogNjAwMDAgKDYwIHNlY29uZHMpLiBTZXQgdG8gMCB0byBkaXNhYmxlIHRoZSBjYXAuXG5cdCAqL1xuXHRtYXhSZXRyeURlbGF5TXM/OiBudW1iZXI7XG5cblx0LyoqXG5cdCAqIERldGVybWluZXMgd2hldGhlciBhIG1vZGVsIHVzZXMgZXh0ZXJuYWwgdG9vbCBleGVjdXRpb24gKHRvb2xzIGhhbmRsZWRcblx0ICogYnkgdGhlIHByb3ZpZGVyLCBub3QgZGlzcGF0Y2hlZCBsb2NhbGx5KS4gRXZhbHVhdGVkIHBlci1sb29wIHNvIG1vZGVsXG5cdCAqIHN3aXRjaGVzIG1pZC1zZXNzaW9uIGFyZSBoYW5kbGVkIGNvcnJlY3RseS5cblx0ICovXG5cdGV4dGVybmFsVG9vbEV4ZWN1dGlvbj86IChtb2RlbDogTW9kZWw8YW55PikgPT4gYm9vbGVhbjtcblxuXHQvKipcblx0ICogT3B0aW9uYWwgcHJvdmlkZXItc3BlY2lmaWMgb3B0aW9ucyB0byBtZXJnZSBpbnRvIHRoZSBuZXh0IHN0cmVhbSBjYWxsLlxuXHQgKlxuXHQgKiBVc2UgdGhpcyBmb3IgcnVudGltZS1vbmx5IGNhbGxiYWNrcyBvciBoYW5kbGVzIHRoYXQgc2hvdWxkIG5vdCBsaXZlIGluXG5cdCAqIHNoYXJlZCBhZ2VudCBzdGF0ZSwgc3VjaCBhcyBVSSBicmlkZ2VzIGZvciBleHRlcm5hbCBDTEkgcHJvdmlkZXJzLlxuXHQgKi9cblx0Z2V0UHJvdmlkZXJPcHRpb25zPzogKG1vZGVsOiBNb2RlbDxhbnk+KSA9PiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCB8IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ+O1xufVxuXG4vKipcbiAqIEludGVybmFsIHdyYXBwZXIgdGhhdCB0cmFja3MgbWVzc2FnZSBvcmlnaW4gZm9yIG9yaWdpbi1hd2FyZSBxdWV1ZSBjbGVhcmluZy5cbiAqIFwidXNlclwiID0gdHlwZWQgYnkgaHVtYW4gaW4gVFVJOyBcInN5c3RlbVwiID0gZ2VuZXJhdGVkIGJ5IGV4dGVuc2lvbnMvYmFja2dyb3VuZCBqb2JzLlxuICovXG5pbnRlcmZhY2UgUXVldWVFbnRyeSB7XG5cdG1lc3NhZ2U6IEFnZW50TWVzc2FnZTtcblx0b3JpZ2luOiBcInVzZXJcIiB8IFwic3lzdGVtXCI7XG59XG5cbmV4cG9ydCBjbGFzcyBBZ2VudCB7XG5cdHByaXZhdGUgX3N0YXRlOiBBZ2VudFN0YXRlID0ge1xuXHRcdHN5c3RlbVByb21wdDogXCJcIixcblx0XHRtb2RlbDogZ2V0TW9kZWwoXCJnb29nbGVcIiwgXCJnZW1pbmktMi41LWZsYXNoLWxpdGUtcHJldmlldy0wNi0xN1wiKSxcblx0XHR0aGlua2luZ0xldmVsOiBcIm9mZlwiLFxuXHRcdHRvb2xzOiBbXSxcblx0XHRtZXNzYWdlczogW10sXG5cdFx0aXNTdHJlYW1pbmc6IGZhbHNlLFxuXHRcdHN0cmVhbU1lc3NhZ2U6IG51bGwsXG5cdFx0cGVuZGluZ1Rvb2xDYWxsczogbmV3IFNldDxzdHJpbmc+KCksXG5cdFx0ZXJyb3I6IHVuZGVmaW5lZCxcblx0fTtcblxuXHRwcml2YXRlIGxpc3RlbmVycyA9IG5ldyBTZXQ8KGU6IEFnZW50RXZlbnQpID0+IHZvaWQ+KCk7XG5cdHByaXZhdGUgYWJvcnRDb250cm9sbGVyPzogQWJvcnRDb250cm9sbGVyO1xuXHRwcml2YXRlIGFib3J0T3JpZ2luPzogQWdlbnRBYm9ydE9yaWdpbjtcblx0cHJpdmF0ZSBjb252ZXJ0VG9MbG06IChtZXNzYWdlczogQWdlbnRNZXNzYWdlW10pID0+IE1lc3NhZ2VbXSB8IFByb21pc2U8TWVzc2FnZVtdPjtcblx0cHJpdmF0ZSB0cmFuc2Zvcm1Db250ZXh0PzogKG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSwgc2lnbmFsPzogQWJvcnRTaWduYWwpID0+IFByb21pc2U8QWdlbnRNZXNzYWdlW10+O1xuXHRwcml2YXRlIGZpbHRlclRvb2xzPzogQWdlbnRMb29wQ29uZmlnW1wiZmlsdGVyVG9vbHNcIl07XG5cdHByaXZhdGUgc3RlZXJpbmdRdWV1ZTogUXVldWVFbnRyeVtdID0gW107XG5cdHByaXZhdGUgZm9sbG93VXBRdWV1ZTogUXVldWVFbnRyeVtdID0gW107XG5cdHByaXZhdGUgc3RlZXJpbmdNb2RlOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCI7XG5cdHByaXZhdGUgZm9sbG93VXBNb2RlOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCI7XG5cdHB1YmxpYyBzdHJlYW1GbjogU3RyZWFtRm47XG5cdHByaXZhdGUgX3Nlc3Npb25JZD86IHN0cmluZztcblx0cHVibGljIGdldEFwaUtleT86IChwcm92aWRlcjogc3RyaW5nKSA9PiBQcm9taXNlPHN0cmluZyB8IHVuZGVmaW5lZD4gfCBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cdHByaXZhdGUgX29uUGF5bG9hZD86IFNpbXBsZVN0cmVhbU9wdGlvbnNbXCJvblBheWxvYWRcIl07XG5cdHByaXZhdGUgcnVubmluZ1Byb21wdD86IFByb21pc2U8dm9pZD47XG5cdHByaXZhdGUgcmVzb2x2ZVJ1bm5pbmdQcm9tcHQ/OiAoKSA9PiB2b2lkO1xuXHRwcml2YXRlIF90aGlua2luZ0J1ZGdldHM/OiBUaGlua2luZ0J1ZGdldHM7XG5cdHByaXZhdGUgX3RyYW5zcG9ydDogVHJhbnNwb3J0O1xuXHRwcml2YXRlIF9tYXhSZXRyeURlbGF5TXM/OiBudW1iZXI7XG5cdHByaXZhdGUgX2JlZm9yZVRvb2xDYWxsPzogQWdlbnRMb29wQ29uZmlnW1wiYmVmb3JlVG9vbENhbGxcIl07XG5cdHByaXZhdGUgX2FmdGVyVG9vbENhbGw/OiBBZ2VudExvb3BDb25maWdbXCJhZnRlclRvb2xDYWxsXCJdO1xuXHRwcml2YXRlIF9leHRlcm5hbFRvb2xFeGVjdXRpb24/OiAobW9kZWw6IE1vZGVsPGFueT4pID0+IGJvb2xlYW47XG5cdHByaXZhdGUgX2dldFByb3ZpZGVyT3B0aW9ucz86IEFnZW50T3B0aW9uc1tcImdldFByb3ZpZGVyT3B0aW9uc1wiXTtcblxuXHRjb25zdHJ1Y3RvcihvcHRzOiBBZ2VudE9wdGlvbnMgPSB7fSkge1xuXHRcdHRoaXMuX3N0YXRlID0geyAuLi50aGlzLl9zdGF0ZSwgLi4ub3B0cy5pbml0aWFsU3RhdGUgfTtcblx0XHR0aGlzLmNvbnZlcnRUb0xsbSA9IG9wdHMuY29udmVydFRvTGxtIHx8IGRlZmF1bHRDb252ZXJ0VG9MbG07XG5cdFx0dGhpcy50cmFuc2Zvcm1Db250ZXh0ID0gb3B0cy50cmFuc2Zvcm1Db250ZXh0O1xuXHRcdHRoaXMuZmlsdGVyVG9vbHMgPSBvcHRzLmZpbHRlclRvb2xzO1xuXHRcdHRoaXMuc3RlZXJpbmdNb2RlID0gb3B0cy5zdGVlcmluZ01vZGUgfHwgXCJvbmUtYXQtYS10aW1lXCI7XG5cdFx0dGhpcy5mb2xsb3dVcE1vZGUgPSBvcHRzLmZvbGxvd1VwTW9kZSB8fCBcIm9uZS1hdC1hLXRpbWVcIjtcblx0XHR0aGlzLnN0cmVhbUZuID0gb3B0cy5zdHJlYW1GbiB8fCBzdHJlYW1TaW1wbGU7XG5cdFx0dGhpcy5fc2Vzc2lvbklkID0gb3B0cy5zZXNzaW9uSWQ7XG5cdFx0dGhpcy5nZXRBcGlLZXkgPSBvcHRzLmdldEFwaUtleTtcblx0XHR0aGlzLl9vblBheWxvYWQgPSBvcHRzLm9uUGF5bG9hZDtcblx0XHR0aGlzLl90aGlua2luZ0J1ZGdldHMgPSBvcHRzLnRoaW5raW5nQnVkZ2V0cztcblx0XHR0aGlzLl90cmFuc3BvcnQgPSBvcHRzLnRyYW5zcG9ydCA/PyBcInNzZVwiO1xuXHRcdHRoaXMuX21heFJldHJ5RGVsYXlNcyA9IG9wdHMubWF4UmV0cnlEZWxheU1zO1xuXHRcdHRoaXMuX2V4dGVybmFsVG9vbEV4ZWN1dGlvbiA9IG9wdHMuZXh0ZXJuYWxUb29sRXhlY3V0aW9uO1xuXHRcdHRoaXMuX2dldFByb3ZpZGVyT3B0aW9ucyA9IG9wdHMuZ2V0UHJvdmlkZXJPcHRpb25zO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0aGUgY3VycmVudCBzZXNzaW9uIElEIHVzZWQgZm9yIHByb3ZpZGVyIGNhY2hpbmcuXG5cdCAqL1xuXHRnZXQgc2Vzc2lvbklkKCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMuX3Nlc3Npb25JZDtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgdGhlIHNlc3Npb24gSUQgZm9yIHByb3ZpZGVyIGNhY2hpbmcuXG5cdCAqIENhbGwgdGhpcyB3aGVuIHN3aXRjaGluZyBzZXNzaW9ucyAobmV3IHNlc3Npb24sIGJyYW5jaCwgcmVzdW1lKS5cblx0ICovXG5cdHNldCBzZXNzaW9uSWQodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuXHRcdHRoaXMuX3Nlc3Npb25JZCA9IHZhbHVlO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0aGUgY3VycmVudCB0aGlua2luZyBidWRnZXRzLlxuXHQgKi9cblx0Z2V0IHRoaW5raW5nQnVkZ2V0cygpOiBUaGlua2luZ0J1ZGdldHMgfCB1bmRlZmluZWQge1xuXHRcdHJldHVybiB0aGlzLl90aGlua2luZ0J1ZGdldHM7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGN1c3RvbSB0aGlua2luZyBidWRnZXRzIGZvciB0b2tlbi1iYXNlZCBwcm92aWRlcnMuXG5cdCAqL1xuXHRzZXQgdGhpbmtpbmdCdWRnZXRzKHZhbHVlOiBUaGlua2luZ0J1ZGdldHMgfCB1bmRlZmluZWQpIHtcblx0XHR0aGlzLl90aGlua2luZ0J1ZGdldHMgPSB2YWx1ZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgdGhlIGN1cnJlbnQgcHJlZmVycmVkIHRyYW5zcG9ydC5cblx0ICovXG5cdGdldCB0cmFuc3BvcnQoKTogVHJhbnNwb3J0IHtcblx0XHRyZXR1cm4gdGhpcy5fdHJhbnNwb3J0O1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldCB0aGUgcHJlZmVycmVkIHRyYW5zcG9ydC5cblx0ICovXG5cdHNldFRyYW5zcG9ydCh2YWx1ZTogVHJhbnNwb3J0KSB7XG5cdFx0dGhpcy5fdHJhbnNwb3J0ID0gdmFsdWU7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IHRoZSBjdXJyZW50IG1heCByZXRyeSBkZWxheSBpbiBtaWxsaXNlY29uZHMuXG5cdCAqL1xuXHRnZXQgbWF4UmV0cnlEZWxheU1zKCk6IG51bWJlciB8IHVuZGVmaW5lZCB7XG5cdFx0cmV0dXJuIHRoaXMuX21heFJldHJ5RGVsYXlNcztcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgdGhlIG1heGltdW0gZGVsYXkgdG8gd2FpdCBmb3Igc2VydmVyLXJlcXVlc3RlZCByZXRyaWVzLlxuXHQgKiBTZXQgdG8gMCB0byBkaXNhYmxlIHRoZSBjYXAuXG5cdCAqL1xuXHRzZXQgbWF4UmV0cnlEZWxheU1zKHZhbHVlOiBudW1iZXIgfCB1bmRlZmluZWQpIHtcblx0XHR0aGlzLl9tYXhSZXRyeURlbGF5TXMgPSB2YWx1ZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBJbnN0YWxsIGEgaG9vayBjYWxsZWQgYmVmb3JlIGVhY2ggdG9vbCBleGVjdXRlcywgYWZ0ZXIgYXJndW1lbnQgdmFsaWRhdGlvbi5cblx0ICogUmV0dXJuIGB7IGJsb2NrOiB0cnVlIH1gIHRvIHByZXZlbnQgZXhlY3V0aW9uLlxuXHQgKi9cblx0c2V0QmVmb3JlVG9vbENhbGwoZm46IEFnZW50TG9vcENvbmZpZ1tcImJlZm9yZVRvb2xDYWxsXCJdKTogdm9pZCB7XG5cdFx0dGhpcy5fYmVmb3JlVG9vbENhbGwgPSBmbjtcblx0fVxuXG5cdC8qKlxuXHQgKiBJbnN0YWxsIGEgaG9vayBjYWxsZWQgYWZ0ZXIgZWFjaCB0b29sIGV4ZWN1dGVzLCBiZWZvcmUgcmVzdWx0cyBhcmUgZW1pdHRlZC5cblx0ICogUmV0dXJuIGZpZWxkIG92ZXJyaWRlcyBmb3IgY29udGVudC9kZXRhaWxzL2lzRXJyb3IuXG5cdCAqL1xuXHRzZXRBZnRlclRvb2xDYWxsKGZuOiBBZ2VudExvb3BDb25maWdbXCJhZnRlclRvb2xDYWxsXCJdKTogdm9pZCB7XG5cdFx0dGhpcy5fYWZ0ZXJUb29sQ2FsbCA9IGZuO1xuXHR9XG5cblx0Z2V0IHN0YXRlKCk6IEFnZW50U3RhdGUge1xuXHRcdHJldHVybiB0aGlzLl9zdGF0ZTtcblx0fVxuXG5cdHN1YnNjcmliZShmbjogKGU6IEFnZW50RXZlbnQpID0+IHZvaWQpOiAoKSA9PiB2b2lkIHtcblx0XHR0aGlzLmxpc3RlbmVycy5hZGQoZm4pO1xuXHRcdHJldHVybiAoKSA9PiB0aGlzLmxpc3RlbmVycy5kZWxldGUoZm4pO1xuXHR9XG5cblx0Ly8gU3RhdGUgbXV0YXRvcnNcblx0c2V0U3lzdGVtUHJvbXB0KHY6IHN0cmluZykge1xuXHRcdHRoaXMuX3N0YXRlLnN5c3RlbVByb21wdCA9IHY7XG5cdH1cblxuXHRzZXRNb2RlbChtOiBNb2RlbDxhbnk+KSB7XG5cdFx0dGhpcy5fc3RhdGUubW9kZWwgPSBtO1xuXHR9XG5cblx0c2V0VGhpbmtpbmdMZXZlbChsOiBUaGlua2luZ0xldmVsKSB7XG5cdFx0dGhpcy5fc3RhdGUudGhpbmtpbmdMZXZlbCA9IGw7XG5cdH1cblxuXHRzZXRTdGVlcmluZ01vZGUobW9kZTogXCJhbGxcIiB8IFwib25lLWF0LWEtdGltZVwiKSB7XG5cdFx0dGhpcy5zdGVlcmluZ01vZGUgPSBtb2RlO1xuXHR9XG5cblx0Z2V0U3RlZXJpbmdNb2RlKCk6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIiB7XG5cdFx0cmV0dXJuIHRoaXMuc3RlZXJpbmdNb2RlO1xuXHR9XG5cblx0c2V0Rm9sbG93VXBNb2RlKG1vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIikge1xuXHRcdHRoaXMuZm9sbG93VXBNb2RlID0gbW9kZTtcblx0fVxuXG5cdGdldEZvbGxvd1VwTW9kZSgpOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCIge1xuXHRcdHJldHVybiB0aGlzLmZvbGxvd1VwTW9kZTtcblx0fVxuXG5cdHNldFRvb2xzKHQ6IEFnZW50VG9vbDxhbnk+W10pIHtcblx0XHR0aGlzLl9zdGF0ZS50b29scyA9IHQ7XG5cdH1cblxuXHRyZXBsYWNlTWVzc2FnZXMobXM6IEFnZW50TWVzc2FnZVtdKSB7XG5cdFx0dGhpcy5fc3RhdGUubWVzc2FnZXMgPSBtcy5zbGljZSgpO1xuXHR9XG5cblx0YXBwZW5kTWVzc2FnZShtOiBBZ2VudE1lc3NhZ2UpIHtcblx0XHR0aGlzLl9zdGF0ZS5tZXNzYWdlcyA9IFsuLi50aGlzLl9zdGF0ZS5tZXNzYWdlcywgbV07XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYSBzdGVlcmluZyBtZXNzYWdlIHRvIGludGVycnVwdCB0aGUgYWdlbnQgbWlkLXJ1bi5cblx0ICogRGVsaXZlcmVkIGFmdGVyIGN1cnJlbnQgdG9vbCBleGVjdXRpb24sIHNraXBzIHJlbWFpbmluZyB0b29scy5cblx0ICovXG5cdHN0ZWVyKG06IEFnZW50TWVzc2FnZSwgb3JpZ2luOiBcInVzZXJcIiB8IFwic3lzdGVtXCIgPSBcInN5c3RlbVwiKSB7XG5cdFx0dGhpcy5zdGVlcmluZ1F1ZXVlLnB1c2goeyBtZXNzYWdlOiBtLCBvcmlnaW4gfSk7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYSBmb2xsb3ctdXAgbWVzc2FnZSB0byBiZSBwcm9jZXNzZWQgYWZ0ZXIgdGhlIGFnZW50IGZpbmlzaGVzLlxuXHQgKiBEZWxpdmVyZWQgb25seSB3aGVuIGFnZW50IGhhcyBubyBtb3JlIHRvb2wgY2FsbHMgb3Igc3RlZXJpbmcgbWVzc2FnZXMuXG5cdCAqL1xuXHRmb2xsb3dVcChtOiBBZ2VudE1lc3NhZ2UsIG9yaWdpbjogXCJ1c2VyXCIgfCBcInN5c3RlbVwiID0gXCJzeXN0ZW1cIikge1xuXHRcdHRoaXMuZm9sbG93VXBRdWV1ZS5wdXNoKHsgbWVzc2FnZTogbSwgb3JpZ2luIH0pO1xuXHR9XG5cblx0Y2xlYXJTdGVlcmluZ1F1ZXVlKCkge1xuXHRcdHRoaXMuc3RlZXJpbmdRdWV1ZSA9IFtdO1xuXHR9XG5cblx0Y2xlYXJGb2xsb3dVcFF1ZXVlKCkge1xuXHRcdHRoaXMuZm9sbG93VXBRdWV1ZSA9IFtdO1xuXHR9XG5cblx0Y2xlYXJBbGxRdWV1ZXMoKSB7XG5cdFx0dGhpcy5zdGVlcmluZ1F1ZXVlID0gW107XG5cdFx0dGhpcy5mb2xsb3dVcFF1ZXVlID0gW107XG5cdH1cblxuXHQvKipcblx0ICogRHJhaW4gdXNlci1vcmlnaW4gbWVzc2FnZXMgZnJvbSBxdWV1ZXMsIGxlYXZpbmcgc3lzdGVtIG1lc3NhZ2VzIGluIHBsYWNlLlxuXHQgKiBVc2VkIGR1cmluZyBhYm9ydCB0byBwcmVzZXJ2ZSBtZXNzYWdlcyB0aGUgdXNlciBleHBsaWNpdGx5IHR5cGVkLlxuXHQgKi9cblx0ZHJhaW5Vc2VyTWVzc2FnZXMoKTogeyBzdGVlcmluZzogQWdlbnRNZXNzYWdlW107IGZvbGxvd1VwOiBBZ2VudE1lc3NhZ2VbXSB9IHtcblx0XHRjb25zdCB1c2VyU3RlZXJpbmcgPSB0aGlzLnN0ZWVyaW5nUXVldWUuZmlsdGVyKChlKSA9PiBlLm9yaWdpbiA9PT0gXCJ1c2VyXCIpLm1hcCgoZSkgPT4gZS5tZXNzYWdlKTtcblx0XHRjb25zdCB1c2VyRm9sbG93VXAgPSB0aGlzLmZvbGxvd1VwUXVldWUuZmlsdGVyKChlKSA9PiBlLm9yaWdpbiA9PT0gXCJ1c2VyXCIpLm1hcCgoZSkgPT4gZS5tZXNzYWdlKTtcblx0XHR0aGlzLnN0ZWVyaW5nUXVldWUgPSB0aGlzLnN0ZWVyaW5nUXVldWUuZmlsdGVyKChlKSA9PiBlLm9yaWdpbiAhPT0gXCJ1c2VyXCIpO1xuXHRcdHRoaXMuZm9sbG93VXBRdWV1ZSA9IHRoaXMuZm9sbG93VXBRdWV1ZS5maWx0ZXIoKGUpID0+IGUub3JpZ2luICE9PSBcInVzZXJcIik7XG5cdFx0cmV0dXJuIHsgc3RlZXJpbmc6IHVzZXJTdGVlcmluZywgZm9sbG93VXA6IHVzZXJGb2xsb3dVcCB9O1xuXHR9XG5cblx0aGFzUXVldWVkTWVzc2FnZXMoKTogYm9vbGVhbiB7XG5cdFx0cmV0dXJuIHRoaXMuc3RlZXJpbmdRdWV1ZS5sZW5ndGggPiAwIHx8IHRoaXMuZm9sbG93VXBRdWV1ZS5sZW5ndGggPiAwO1xuXHR9XG5cblx0cHJpdmF0ZSBkZXF1ZXVlU3RlZXJpbmdNZXNzYWdlcygpOiBBZ2VudE1lc3NhZ2VbXSB7XG5cdFx0aWYgKHRoaXMuc3RlZXJpbmdNb2RlID09PSBcIm9uZS1hdC1hLXRpbWVcIikge1xuXHRcdFx0aWYgKHRoaXMuc3RlZXJpbmdRdWV1ZS5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGNvbnN0IGZpcnN0ID0gdGhpcy5zdGVlcmluZ1F1ZXVlWzBdO1xuXHRcdFx0XHR0aGlzLnN0ZWVyaW5nUXVldWUgPSB0aGlzLnN0ZWVyaW5nUXVldWUuc2xpY2UoMSk7XG5cdFx0XHRcdHJldHVybiBbZmlyc3QubWVzc2FnZV07XG5cdFx0XHR9XG5cdFx0XHRyZXR1cm4gW107XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc3RlZXJpbmcgPSB0aGlzLnN0ZWVyaW5nUXVldWUubWFwKChlKSA9PiBlLm1lc3NhZ2UpO1xuXHRcdHRoaXMuc3RlZXJpbmdRdWV1ZSA9IFtdO1xuXHRcdHJldHVybiBzdGVlcmluZztcblx0fVxuXG5cdHByaXZhdGUgZGVxdWV1ZUZvbGxvd1VwTWVzc2FnZXMoKTogQWdlbnRNZXNzYWdlW10ge1xuXHRcdGlmICh0aGlzLmZvbGxvd1VwTW9kZSA9PT0gXCJvbmUtYXQtYS10aW1lXCIpIHtcblx0XHRcdGlmICh0aGlzLmZvbGxvd1VwUXVldWUubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb25zdCBmaXJzdCA9IHRoaXMuZm9sbG93VXBRdWV1ZVswXTtcblx0XHRcdFx0dGhpcy5mb2xsb3dVcFF1ZXVlID0gdGhpcy5mb2xsb3dVcFF1ZXVlLnNsaWNlKDEpO1xuXHRcdFx0XHRyZXR1cm4gW2ZpcnN0Lm1lc3NhZ2VdO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIFtdO1xuXHRcdH1cblxuXHRcdGNvbnN0IGZvbGxvd1VwID0gdGhpcy5mb2xsb3dVcFF1ZXVlLm1hcCgoZSkgPT4gZS5tZXNzYWdlKTtcblx0XHR0aGlzLmZvbGxvd1VwUXVldWUgPSBbXTtcblx0XHRyZXR1cm4gZm9sbG93VXA7XG5cdH1cblxuXHRjbGVhck1lc3NhZ2VzKCkge1xuXHRcdHRoaXMuX3N0YXRlLm1lc3NhZ2VzID0gW107XG5cdH1cblxuXHRhYm9ydChvcmlnaW46IEFnZW50QWJvcnRPcmlnaW4gPSBcInVua25vd25cIikge1xuXHRcdHRoaXMuYWJvcnRPcmlnaW4gPSBvcmlnaW47XG5cdFx0dGhpcy5hYm9ydENvbnRyb2xsZXI/LmFib3J0KCk7XG5cdH1cblxuXHR3YWl0Rm9ySWRsZSgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRyZXR1cm4gdGhpcy5ydW5uaW5nUHJvbXB0ID8/IFByb21pc2UucmVzb2x2ZSgpO1xuXHR9XG5cblx0cmVzZXQoKSB7XG5cdFx0dGhpcy5fc3RhdGUubWVzc2FnZXMgPSBbXTtcblx0XHR0aGlzLl9zdGF0ZS5pc1N0cmVhbWluZyA9IGZhbHNlO1xuXHRcdHRoaXMuX3N0YXRlLnN0cmVhbU1lc3NhZ2UgPSBudWxsO1xuXHRcdHRoaXMuX3N0YXRlLnBlbmRpbmdUb29sQ2FsbHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHR0aGlzLl9zdGF0ZS5lcnJvciA9IHVuZGVmaW5lZDtcblx0XHR0aGlzLnN0ZWVyaW5nUXVldWUgPSBbXTtcblx0XHR0aGlzLmZvbGxvd1VwUXVldWUgPSBbXTtcblx0fVxuXG5cdC8qKiBTZW5kIGEgcHJvbXB0IHdpdGggYW4gQWdlbnRNZXNzYWdlICovXG5cdGFzeW5jIHByb21wdChtZXNzYWdlOiBBZ2VudE1lc3NhZ2UgfCBBZ2VudE1lc3NhZ2VbXSk6IFByb21pc2U8dm9pZD47XG5cdGFzeW5jIHByb21wdChpbnB1dDogc3RyaW5nLCBpbWFnZXM/OiBJbWFnZUNvbnRlbnRbXSk6IFByb21pc2U8dm9pZD47XG5cdGFzeW5jIHByb21wdChpbnB1dDogc3RyaW5nIHwgQWdlbnRNZXNzYWdlIHwgQWdlbnRNZXNzYWdlW10sIGltYWdlcz86IEltYWdlQ29udGVudFtdKSB7XG5cdFx0aWYgKHRoaXMuX3N0YXRlLmlzU3RyZWFtaW5nKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXG5cdFx0XHRcdFwiQWdlbnQgaXMgYWxyZWFkeSBwcm9jZXNzaW5nIGEgcHJvbXB0LiBVc2Ugc3RlZXIoKSBvciBmb2xsb3dVcCgpIHRvIHF1ZXVlIG1lc3NhZ2VzLCBvciB3YWl0IGZvciBjb21wbGV0aW9uLlwiLFxuXHRcdFx0KTtcblx0XHR9XG5cblx0XHRjb25zdCBtb2RlbCA9IHRoaXMuX3N0YXRlLm1vZGVsO1xuXHRcdGlmICghbW9kZWwpIHRocm93IG5ldyBFcnJvcihcIk5vIG1vZGVsIGNvbmZpZ3VyZWRcIik7XG5cblx0XHRsZXQgbXNnczogQWdlbnRNZXNzYWdlW107XG5cblx0XHRpZiAoQXJyYXkuaXNBcnJheShpbnB1dCkpIHtcblx0XHRcdG1zZ3MgPSBpbnB1dDtcblx0XHR9IGVsc2UgaWYgKHR5cGVvZiBpbnB1dCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0Y29uc3QgY29udGVudDogQXJyYXk8VGV4dENvbnRlbnQgfCBJbWFnZUNvbnRlbnQ+ID0gW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGlucHV0IH1dO1xuXHRcdFx0aWYgKGltYWdlcyAmJiBpbWFnZXMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRjb250ZW50LnB1c2goLi4uaW1hZ2VzKTtcblx0XHRcdH1cblx0XHRcdG1zZ3MgPSBbXG5cdFx0XHRcdHtcblx0XHRcdFx0XHRyb2xlOiBcInVzZXJcIixcblx0XHRcdFx0XHRjb250ZW50LFxuXHRcdFx0XHRcdHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcblx0XHRcdFx0fSxcblx0XHRcdF07XG5cdFx0fSBlbHNlIHtcblx0XHRcdG1zZ3MgPSBbaW5wdXRdO1xuXHRcdH1cblxuXHRcdGF3YWl0IHRoaXMuX3J1bkxvb3AobXNncyk7XG5cdH1cblxuXHQvKipcblx0ICogQ29udGludWUgZnJvbSBjdXJyZW50IGNvbnRleHQgKHVzZWQgZm9yIHJldHJpZXMgYW5kIHJlc3VtaW5nIHF1ZXVlZCBtZXNzYWdlcykuXG5cdCAqL1xuXHRhc3luYyBjb250aW51ZSgpIHtcblx0XHRpZiAodGhpcy5fc3RhdGUuaXNTdHJlYW1pbmcpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIkFnZW50IGlzIGFscmVhZHkgcHJvY2Vzc2luZy4gV2FpdCBmb3IgY29tcGxldGlvbiBiZWZvcmUgY29udGludWluZy5cIik7XG5cdFx0fVxuXG5cdFx0Y29uc3QgbWVzc2FnZXMgPSB0aGlzLl9zdGF0ZS5tZXNzYWdlcztcblx0XHRpZiAobWVzc2FnZXMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJObyBtZXNzYWdlcyB0byBjb250aW51ZSBmcm9tXCIpO1xuXHRcdH1cblx0XHRpZiAobWVzc2FnZXNbbWVzc2FnZXMubGVuZ3RoIC0gMV0ucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0Y29uc3QgcXVldWVkU3RlZXJpbmcgPSB0aGlzLmRlcXVldWVTdGVlcmluZ01lc3NhZ2VzKCk7XG5cdFx0XHRpZiAocXVldWVkU3RlZXJpbmcubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLl9ydW5Mb29wKHF1ZXVlZFN0ZWVyaW5nLCB7IHNraXBJbml0aWFsU3RlZXJpbmdQb2xsOiB0cnVlIH0pO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IHF1ZXVlZEZvbGxvd1VwID0gdGhpcy5kZXF1ZXVlRm9sbG93VXBNZXNzYWdlcygpO1xuXHRcdFx0aWYgKHF1ZXVlZEZvbGxvd1VwLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0YXdhaXQgdGhpcy5fcnVuTG9vcChxdWV1ZWRGb2xsb3dVcCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IGNvbnRpbnVlIGZyb20gbWVzc2FnZSByb2xlOiBhc3Npc3RhbnRcIik7XG5cdFx0fVxuXG5cdFx0YXdhaXQgdGhpcy5fcnVuTG9vcCh1bmRlZmluZWQpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJ1biB0aGUgYWdlbnQgbG9vcC5cblx0ICogSWYgbWVzc2FnZXMgYXJlIHByb3ZpZGVkLCBzdGFydHMgYSBuZXcgY29udmVyc2F0aW9uIHR1cm4gd2l0aCB0aG9zZSBtZXNzYWdlcy5cblx0ICogT3RoZXJ3aXNlLCBjb250aW51ZXMgZnJvbSBleGlzdGluZyBjb250ZXh0LlxuXHQgKi9cblx0cHJpdmF0ZSBhc3luYyBfcnVuTG9vcChtZXNzYWdlcz86IEFnZW50TWVzc2FnZVtdLCBvcHRpb25zPzogeyBza2lwSW5pdGlhbFN0ZWVyaW5nUG9sbD86IGJvb2xlYW4gfSkge1xuXHRcdGNvbnN0IG1vZGVsID0gdGhpcy5fc3RhdGUubW9kZWw7XG5cdFx0aWYgKCFtb2RlbCkgdGhyb3cgbmV3IEVycm9yKFwiTm8gbW9kZWwgY29uZmlndXJlZFwiKTtcblxuXHRcdGNvbnN0IHR1cm5JZCA9IHJhbmRvbVVVSUQoKTtcblx0XHRjb25zdCBzZXNzaW9uSWQgPSB0aGlzLl9zZXNzaW9uSWQ7XG5cdFx0dGhpcy5fc3RhdGUuYWN0aXZlSW5mZXJlbmNlTW9kZWwgPSBtb2RlbDtcblxuXHRcdHRoaXMucnVubmluZ1Byb21wdCA9IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG5cdFx0XHR0aGlzLnJlc29sdmVSdW5uaW5nUHJvbXB0ID0gcmVzb2x2ZTtcblx0XHR9KTtcblxuXHRcdHRoaXMuYWJvcnRDb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuXHRcdHRoaXMuX3N0YXRlLmlzU3RyZWFtaW5nID0gdHJ1ZTtcblx0XHR0aGlzLl9zdGF0ZS5zdHJlYW1NZXNzYWdlID0gbnVsbDtcblx0XHR0aGlzLl9zdGF0ZS5lcnJvciA9IHVuZGVmaW5lZDtcblxuXHRcdGNvbnN0IHJlYXNvbmluZyA9IHRoaXMuX3N0YXRlLnRoaW5raW5nTGV2ZWwgPT09IFwib2ZmXCIgPyB1bmRlZmluZWQgOiB0aGlzLl9zdGF0ZS50aGlua2luZ0xldmVsO1xuXG5cdFx0Y29uc3QgY29udGV4dDogQWdlbnRDb250ZXh0ID0ge1xuXHRcdFx0c3lzdGVtUHJvbXB0OiB0aGlzLl9zdGF0ZS5zeXN0ZW1Qcm9tcHQsXG5cdFx0XHRtZXNzYWdlczogdGhpcy5fc3RhdGUubWVzc2FnZXMuc2xpY2UoKSxcblx0XHRcdHRvb2xzOiB0aGlzLl9zdGF0ZS50b29scyxcblx0XHR9O1xuXG5cdFx0bGV0IHNraXBJbml0aWFsU3RlZXJpbmdQb2xsID0gb3B0aW9ucz8uc2tpcEluaXRpYWxTdGVlcmluZ1BvbGwgPT09IHRydWU7XG5cdFx0Y29uc3QgcHJvdmlkZXJPcHRpb25zID0gYXdhaXQgdGhpcy5fZ2V0UHJvdmlkZXJPcHRpb25zPy4obW9kZWwpO1xuXG5cdFx0Y29uc3QgY29uZmlnOiBBZ2VudExvb3BDb25maWcgPSB7XG5cdFx0XHQuLi4ocHJvdmlkZXJPcHRpb25zID8/IHt9KSxcblx0XHRcdG1vZGVsLFxuXHRcdFx0cmVhc29uaW5nLFxuXHRcdFx0c2Vzc2lvbklkOiB0aGlzLl9zZXNzaW9uSWQsXG5cdFx0XHRvblBheWxvYWQ6IHRoaXMuX29uUGF5bG9hZCxcblx0XHRcdHRyYW5zcG9ydDogdGhpcy5fdHJhbnNwb3J0LFxuXHRcdFx0dGhpbmtpbmdCdWRnZXRzOiB0aGlzLl90aGlua2luZ0J1ZGdldHMsXG5cdFx0XHRtYXhSZXRyeURlbGF5TXM6IHRoaXMuX21heFJldHJ5RGVsYXlNcyxcblx0XHRcdGNvbnZlcnRUb0xsbTogdGhpcy5jb252ZXJ0VG9MbG0sXG5cdFx0XHR0cmFuc2Zvcm1Db250ZXh0OiB0aGlzLnRyYW5zZm9ybUNvbnRleHQsXG5cdFx0XHRmaWx0ZXJUb29sczogdGhpcy5maWx0ZXJUb29scyxcblx0XHRcdGdldEFwaUtleTogdGhpcy5nZXRBcGlLZXksXG5cdFx0XHRnZXRTdGVlcmluZ01lc3NhZ2VzOiBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGlmIChza2lwSW5pdGlhbFN0ZWVyaW5nUG9sbCkge1xuXHRcdFx0XHRcdHNraXBJbml0aWFsU3RlZXJpbmdQb2xsID0gZmFsc2U7XG5cdFx0XHRcdFx0cmV0dXJuIFtdO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB0aGlzLmRlcXVldWVTdGVlcmluZ01lc3NhZ2VzKCk7XG5cdFx0XHR9LFxuXHRcdFx0Z2V0Rm9sbG93VXBNZXNzYWdlczogYXN5bmMgKCkgPT4gdGhpcy5kZXF1ZXVlRm9sbG93VXBNZXNzYWdlcygpLFxuXHRcdFx0YmVmb3JlVG9vbENhbGw6IHRoaXMuX2JlZm9yZVRvb2xDYWxsLFxuXHRcdFx0YWZ0ZXJUb29sQ2FsbDogdGhpcy5fYWZ0ZXJUb29sQ2FsbCxcblx0XHRcdGV4dGVybmFsVG9vbEV4ZWN1dGlvbjogdGhpcy5fZXh0ZXJuYWxUb29sRXhlY3V0aW9uPy4obW9kZWwpID8/IGZhbHNlLFxuXHRcdH07XG5cblx0XHRsZXQgcGFydGlhbDogQWdlbnRNZXNzYWdlIHwgbnVsbCA9IG51bGw7XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3Qgc3RyZWFtID0gbWVzc2FnZXNcblx0XHRcdFx0PyBhZ2VudExvb3AobWVzc2FnZXMsIGNvbnRleHQsIGNvbmZpZywgdGhpcy5hYm9ydENvbnRyb2xsZXIuc2lnbmFsLCB0aGlzLnN0cmVhbUZuKVxuXHRcdFx0XHQ6IGFnZW50TG9vcENvbnRpbnVlKGNvbnRleHQsIGNvbmZpZywgdGhpcy5hYm9ydENvbnRyb2xsZXIuc2lnbmFsLCB0aGlzLnN0cmVhbUZuKTtcblxuXHRcdFx0Zm9yIGF3YWl0IChjb25zdCBldmVudCBvZiBzdHJlYW0pIHtcblx0XHRcdFx0Y29uc3Qgc3RhbXBlZEV2ZW50ID0gdGhpcy5zdGFtcEV2ZW50KGV2ZW50LCBzZXNzaW9uSWQsIHR1cm5JZCk7XG5cdFx0XHRcdC8vIFVwZGF0ZSBpbnRlcm5hbCBzdGF0ZSBiYXNlZCBvbiBldmVudHNcblx0XHRcdFx0c3dpdGNoIChzdGFtcGVkRXZlbnQudHlwZSkge1xuXHRcdFx0XHRcdGNhc2UgXCJtZXNzYWdlX3N0YXJ0XCI6XG5cdFx0XHRcdFx0Y2FzZSBcIm1lc3NhZ2VfdXBkYXRlXCI6XG5cdFx0XHRcdFx0XHRwYXJ0aWFsID0gc3RhbXBlZEV2ZW50Lm1lc3NhZ2U7XG5cdFx0XHRcdFx0XHR0aGlzLl9zdGF0ZS5zdHJlYW1NZXNzYWdlID0gc3RhbXBlZEV2ZW50Lm1lc3NhZ2U7XG5cdFx0XHRcdFx0XHRicmVhaztcblxuXHRcdFx0XHRcdGNhc2UgXCJtZXNzYWdlX2VuZFwiOlxuXHRcdFx0XHRcdFx0cGFydGlhbCA9IG51bGw7XG5cdFx0XHRcdFx0XHR0aGlzLl9zdGF0ZS5zdHJlYW1NZXNzYWdlID0gbnVsbDtcblx0XHRcdFx0XHRcdHRoaXMuYXBwZW5kTWVzc2FnZShzdGFtcGVkRXZlbnQubWVzc2FnZSk7XG5cdFx0XHRcdFx0XHRicmVhaztcblxuXHRcdFx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9zdGFydFwiOlxuXHRcdFx0XHRcdFx0dGhpcy5fdXBkYXRlUGVuZGluZ1Rvb2xDYWxscyhcImFkZFwiLCBzdGFtcGVkRXZlbnQudG9vbENhbGxJZCk7XG5cdFx0XHRcdFx0XHRicmVhaztcblxuXHRcdFx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9lbmRcIjpcblx0XHRcdFx0XHRcdHRoaXMuX3VwZGF0ZVBlbmRpbmdUb29sQ2FsbHMoXCJkZWxldGVcIiwgc3RhbXBlZEV2ZW50LnRvb2xDYWxsSWQpO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cblx0XHRcdFx0XHRjYXNlIFwidHVybl9lbmRcIjpcblx0XHRcdFx0XHRcdGlmIChzdGFtcGVkRXZlbnQubWVzc2FnZS5yb2xlID09PSBcImFzc2lzdGFudFwiICYmIChzdGFtcGVkRXZlbnQubWVzc2FnZSBhcyBhbnkpLmVycm9yTWVzc2FnZSkge1xuXHRcdFx0XHRcdFx0XHR0aGlzLl9zdGF0ZS5lcnJvciA9IChzdGFtcGVkRXZlbnQubWVzc2FnZSBhcyBhbnkpLmVycm9yTWVzc2FnZTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGJyZWFrO1xuXG5cdFx0XHRcdFx0Y2FzZSBcImFnZW50X2VuZFwiOlxuXHRcdFx0XHRcdFx0dGhpcy5fc3RhdGUuaXNTdHJlYW1pbmcgPSBmYWxzZTtcblx0XHRcdFx0XHRcdHRoaXMuX3N0YXRlLnN0cmVhbU1lc3NhZ2UgPSBudWxsO1xuXHRcdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBFbWl0IHRvIGxpc3RlbmVyc1xuXHRcdFx0XHR0aGlzLmVtaXQoc3RhbXBlZEV2ZW50KTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gSGFuZGxlIGFueSByZW1haW5pbmcgcGFydGlhbCBtZXNzYWdlXG5cdFx0XHRpZiAocGFydGlhbCAmJiBwYXJ0aWFsLnJvbGUgPT09IFwiYXNzaXN0YW50XCIgJiYgcGFydGlhbC5jb250ZW50Lmxlbmd0aCA+IDApIHtcblx0XHRcdFx0Y29uc3Qgb25seUVtcHR5ID0gIXBhcnRpYWwuY29udGVudC5zb21lKFxuXHRcdFx0XHRcdChjKSA9PlxuXHRcdFx0XHRcdFx0KGMudHlwZSA9PT0gXCJ0aGlua2luZ1wiICYmIGMudGhpbmtpbmcudHJpbSgpLmxlbmd0aCA+IDApIHx8XG5cdFx0XHRcdFx0XHQoYy50eXBlID09PSBcInRleHRcIiAmJiBjLnRleHQudHJpbSgpLmxlbmd0aCA+IDApIHx8XG5cdFx0XHRcdFx0XHQoYy50eXBlID09PSBcInRvb2xDYWxsXCIgJiYgYy5uYW1lLnRyaW0oKS5sZW5ndGggPiAwKSxcblx0XHRcdFx0KTtcblx0XHRcdFx0aWYgKCFvbmx5RW1wdHkpIHtcblx0XHRcdFx0XHR0aGlzLmFwcGVuZE1lc3NhZ2UocGFydGlhbCk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0aWYgKHRoaXMuYWJvcnRDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCkge1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiUmVxdWVzdCB3YXMgYWJvcnRlZFwiKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGNhdGNoIChlcnI6IGFueSkge1xuXHRcdFx0Y29uc3QgZXJyb3JNc2c6IEFnZW50TWVzc2FnZSA9IHtcblx0XHRcdFx0cm9sZTogXCJhc3Npc3RhbnRcIixcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiXCIgfV0sXG5cdFx0XHRcdGFwaTogbW9kZWwuYXBpLFxuXHRcdFx0XHRwcm92aWRlcjogbW9kZWwucHJvdmlkZXIsXG5cdFx0XHRcdG1vZGVsOiBtb2RlbC5pZCxcblx0XHRcdFx0dXNhZ2U6IFpFUk9fVVNBR0UsXG5cdFx0XHRcdHN0b3BSZWFzb246IHRoaXMuYWJvcnRDb250cm9sbGVyPy5zaWduYWwuYWJvcnRlZCA/IFwiYWJvcnRlZFwiIDogXCJlcnJvclwiLFxuXHRcdFx0XHRlcnJvck1lc3NhZ2U6IGVycj8ubWVzc2FnZSB8fCBTdHJpbmcoZXJyKSxcblx0XHRcdFx0dGltZXN0YW1wOiBEYXRlLm5vdygpLFxuXHRcdFx0fSBhcyBBZ2VudE1lc3NhZ2U7XG5cblx0XHRcdHRoaXMuYXBwZW5kTWVzc2FnZShlcnJvck1zZyk7XG5cdFx0XHR0aGlzLl9zdGF0ZS5lcnJvciA9IGVycj8ubWVzc2FnZSB8fCBTdHJpbmcoZXJyKTtcblx0XHRcdGNvbnN0IGFnZW50RW5kRXZlbnQ6IEFnZW50RXZlbnQgPSB7XG5cdFx0XHRcdHR5cGU6IFwiYWdlbnRfZW5kXCIsXG5cdFx0XHRcdG1lc3NhZ2VzOiBbZXJyb3JNc2ddLFxuXHRcdFx0XHRzZXNzaW9uSWQsXG5cdFx0XHRcdHR1cm5JZCxcblx0XHRcdH07XG5cdFx0XHRpZiAodGhpcy5hYm9ydENvbnRyb2xsZXI/LnNpZ25hbC5hYm9ydGVkKSB7XG5cdFx0XHRcdGFnZW50RW5kRXZlbnQuYWJvcnRPcmlnaW4gPSB0aGlzLmFib3J0T3JpZ2luID8/IFwidW5rbm93blwiO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5lbWl0KGFnZW50RW5kRXZlbnQpO1xuXHRcdH0gZmluYWxseSB7XG5cdFx0XHR0aGlzLl9zdGF0ZS5pc1N0cmVhbWluZyA9IGZhbHNlO1xuXHRcdFx0dGhpcy5fc3RhdGUuc3RyZWFtTWVzc2FnZSA9IG51bGw7XG5cdFx0XHR0aGlzLl9zdGF0ZS5wZW5kaW5nVG9vbENhbGxzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdFx0XHR0aGlzLl9zdGF0ZS5hY3RpdmVJbmZlcmVuY2VNb2RlbCA9IHVuZGVmaW5lZDtcblx0XHRcdHRoaXMuYWJvcnRPcmlnaW4gPSB1bmRlZmluZWQ7XG5cdFx0XHR0aGlzLmFib3J0Q29udHJvbGxlciA9IHVuZGVmaW5lZDtcblx0XHRcdHRoaXMucmVzb2x2ZVJ1bm5pbmdQcm9tcHQ/LigpO1xuXHRcdFx0dGhpcy5ydW5uaW5nUHJvbXB0ID0gdW5kZWZpbmVkO1xuXHRcdFx0dGhpcy5yZXNvbHZlUnVubmluZ1Byb21wdCA9IHVuZGVmaW5lZDtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHN0YW1wRXZlbnQoZXZlbnQ6IEFnZW50RXZlbnQsIHNlc3Npb25JZDogc3RyaW5nIHwgdW5kZWZpbmVkLCB0dXJuSWQ6IHN0cmluZyk6IEFnZW50RXZlbnQge1xuXHRcdHN3aXRjaCAoZXZlbnQudHlwZSkge1xuXHRcdFx0Y2FzZSBcImFnZW50X3N0YXJ0XCI6XG5cdFx0XHRjYXNlIFwiYWdlbnRfZW5kXCI6XG5cdFx0XHRjYXNlIFwidHVybl9zdGFydFwiOlxuXHRcdFx0Y2FzZSBcInR1cm5fZW5kXCI6XG5cdFx0XHRjYXNlIFwibWVzc2FnZV9zdGFydFwiOlxuXHRcdFx0Y2FzZSBcIm1lc3NhZ2VfdXBkYXRlXCI6XG5cdFx0XHRjYXNlIFwibWVzc2FnZV9lbmRcIjpcblx0XHRcdGNhc2UgXCJ0b29sX2V4ZWN1dGlvbl9zdGFydFwiOlxuXHRcdFx0Y2FzZSBcInRvb2xfZXhlY3V0aW9uX3VwZGF0ZVwiOlxuXHRcdFx0Y2FzZSBcInRvb2xfZXhlY3V0aW9uX2VuZFwiOlxuXHRcdFx0XHRyZXR1cm4geyAuLi5ldmVudCwgc2Vzc2lvbklkLCB0dXJuSWQgfTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIF91cGRhdGVQZW5kaW5nVG9vbENhbGxzKGFjdGlvbjogXCJhZGRcIiB8IFwiZGVsZXRlXCIsIGlkOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRjb25zdCBzID0gbmV3IFNldCh0aGlzLl9zdGF0ZS5wZW5kaW5nVG9vbENhbGxzKTtcblx0XHRzW2FjdGlvbl0oaWQpO1xuXHRcdHRoaXMuX3N0YXRlLnBlbmRpbmdUb29sQ2FsbHMgPSBzO1xuXHR9XG5cblx0cHJpdmF0ZSBlbWl0KGU6IEFnZW50RXZlbnQpIHtcblx0XHRmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIHRoaXMubGlzdGVuZXJzKSB7XG5cdFx0XHRsaXN0ZW5lcihlKTtcblx0XHR9XG5cdH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUtBO0FBQUEsRUFDQztBQUFBLEVBS0E7QUFBQSxPQUlNO0FBQ1AsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUyxXQUFXLG1CQUFtQixrQkFBa0I7QUFvQnpELFNBQVMsb0JBQW9CLFVBQXFDO0FBQ2pFLFNBQU8sU0FBUyxPQUFPLENB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
