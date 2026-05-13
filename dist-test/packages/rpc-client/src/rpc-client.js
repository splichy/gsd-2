import { spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
class RpcClient {
  constructor(options = {}) {
    this.options = options;
  }
  process = null;
  stopReadingStdout = null;
  _stderrHandler;
  eventListeners = [];
  pendingRequests = /* @__PURE__ */ new Map();
  requestId = 0;
  stderr = "";
  _stopped = false;
  /**
   * Start the RPC agent process.
   */
  async start() {
    if (this.process) {
      throw new Error("Client already started");
    }
    this._stopped = false;
    const cliPath = this.options.cliPath ?? "dist/cli.js";
    const args = ["--mode", "rpc"];
    if (this.options.provider) {
      args.push("--provider", this.options.provider);
    }
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.args) {
      args.push(...this.options.args);
    }
    this.process = spawn("node", [cliPath, ...args], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this._stderrHandler = (data) => {
      this.stderr += data.toString();
    };
    this.process.stderr?.on("data", this._stderrHandler);
    this.stopReadingStdout = attachJsonlLineReader(this.process.stdout, (line) => {
      this.handleLine(line);
    });
    this.process.on("exit", (code, signal) => {
      if (this.pendingRequests.size > 0) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        const error = new Error(`Agent process exited unexpectedly (${reason}). Stderr: ${this.stderr}`);
        for (const [id, pending] of this.pendingRequests) {
          this.pendingRequests.delete(id);
          pending.reject(error);
        }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.process.exitCode !== null) {
      throw new Error(`Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`);
    }
  }
  /**
   * Stop the RPC agent process.
   */
  async stop() {
    if (!this.process) return;
    this._stopped = true;
    this.stopReadingStdout?.();
    this.stopReadingStdout = null;
    if (this._stderrHandler) {
      this.process.stderr?.removeListener("data", this._stderrHandler);
      this._stderrHandler = void 0;
    }
    this.process.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.process?.kill("SIGKILL");
        resolve();
      }, 1e3);
      this.process?.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.process = null;
    this.pendingRequests.clear();
  }
  /**
   * Subscribe to agent events via callback.
   */
  onEvent(listener) {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index !== -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }
  /**
   * Async generator that yields agent events as they arrive.
   *
   * Usage:
   * ```ts
   * for await (const event of client.events()) {
   *   console.log(event.type, event);
   * }
   * ```
   *
   * The generator terminates when:
   * - `stop()` is called
   * - The agent process exits
   * - The consumer breaks out of the loop
   */
  async *events() {
    if (!this.process) {
      throw new Error("Client not started \u2014 call start() before events()");
    }
    if (this._stopped) {
      return;
    }
    const buffer = [];
    let resolve = null;
    let done = false;
    const listener = (event) => {
      buffer.push(event);
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    };
    const onExit = () => {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    };
    const unsubscribe = this.onEvent(listener);
    this.process.on("exit", onExit);
    try {
      while (!done && !this._stopped) {
        while (buffer.length > 0) {
          yield buffer.shift();
        }
        if (done || this._stopped) {
          break;
        }
        await new Promise((r) => {
          resolve = r;
        });
      }
      while (buffer.length > 0) {
        yield buffer.shift();
      }
    } finally {
      unsubscribe();
      this.process?.removeListener("exit", onExit);
    }
  }
  /**
   * Get collected stderr output (useful for debugging).
   */
  getStderr() {
    return this.stderr;
  }
  // =========================================================================
  // Command Methods
  // =========================================================================
  /**
   * Send a prompt to the agent.
   * Returns immediately after sending; use onEvent() or events() to receive streaming events.
   * Use waitForIdle() to wait for completion.
   */
  async prompt(message, images) {
    await this.send({ type: "prompt", message, images });
  }
  /**
   * Queue a steering message to interrupt the agent mid-run.
   */
  async steer(message, images) {
    await this.send({ type: "steer", message, images });
  }
  /**
   * Queue a follow-up message to be processed after the agent finishes.
   */
  async followUp(message, images) {
    await this.send({ type: "follow_up", message, images });
  }
  /**
   * Abort current operation.
   */
  async abort() {
    await this.send({ type: "abort" });
  }
  /**
   * Start a new session, optionally with parent tracking.
   * @param parentSession - Optional parent session path for lineage tracking
   * @returns Object with `cancelled: true` if an extension cancelled the new session
   */
  async newSession(parentSession) {
    const response = await this.send({ type: "new_session", parentSession });
    return this.getData(response);
  }
  /**
   * Get current session state.
   */
  async getState() {
    const response = await this.send({ type: "get_state" });
    return this.getData(response);
  }
  /**
   * Set model by provider and ID.
   */
  async setModel(provider, modelId) {
    const response = await this.send({ type: "set_model", provider, modelId });
    return this.getData(response);
  }
  /**
   * Cycle to next model.
   */
  async cycleModel() {
    const response = await this.send({ type: "cycle_model" });
    return this.getData(response);
  }
  /**
   * Get list of available models.
   */
  async getAvailableModels() {
    const response = await this.send({ type: "get_available_models" });
    return this.getData(response).models;
  }
  /**
   * Set thinking level.
   */
  async setThinkingLevel(level) {
    await this.send({ type: "set_thinking_level", level });
  }
  /**
   * Cycle thinking level.
   */
  async cycleThinkingLevel() {
    const response = await this.send({ type: "cycle_thinking_level" });
    return this.getData(response);
  }
  /**
   * Set steering mode.
   */
  async setSteeringMode(mode) {
    await this.send({ type: "set_steering_mode", mode });
  }
  /**
   * Set follow-up mode.
   */
  async setFollowUpMode(mode) {
    await this.send({ type: "set_follow_up_mode", mode });
  }
  /**
   * Compact session context.
   */
  async compact(customInstructions) {
    const response = await this.send({ type: "compact", customInstructions });
    return this.getData(response);
  }
  /**
   * Set auto-compaction enabled/disabled.
   */
  async setAutoCompaction(enabled) {
    await this.send({ type: "set_auto_compaction", enabled });
  }
  /**
   * Set auto-retry enabled/disabled.
   */
  async setAutoRetry(enabled) {
    await this.send({ type: "set_auto_retry", enabled });
  }
  /**
   * Abort in-progress retry.
   */
  async abortRetry() {
    await this.send({ type: "abort_retry" });
  }
  /**
   * Execute a bash command.
   */
  async bash(command) {
    const response = await this.send({ type: "bash", command });
    return this.getData(response);
  }
  /**
   * Abort running bash command.
   */
  async abortBash() {
    await this.send({ type: "abort_bash" });
  }
  /**
   * Get session statistics.
   */
  async getSessionStats() {
    const response = await this.send({ type: "get_session_stats" });
    return this.getData(response);
  }
  /**
   * Export session to HTML.
   */
  async exportHtml(outputPath) {
    const response = await this.send({ type: "export_html", outputPath });
    return this.getData(response);
  }
  /**
   * Switch to a different session file.
   * @returns Object with `cancelled: true` if an extension cancelled the switch
   */
  async switchSession(sessionPath) {
    const response = await this.send({ type: "switch_session", sessionPath });
    return this.getData(response);
  }
  /**
   * Fork from a specific message.
   * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
   */
  async fork(entryId) {
    const response = await this.send({ type: "fork", entryId });
    return this.getData(response);
  }
  /**
   * Get messages available for forking.
   */
  async getForkMessages() {
    const response = await this.send({ type: "get_fork_messages" });
    return this.getData(response).messages;
  }
  /**
   * Get text of last assistant message.
   */
  async getLastAssistantText() {
    const response = await this.send({ type: "get_last_assistant_text" });
    return this.getData(response).text;
  }
  /**
   * Set the session display name.
   */
  async setSessionName(name) {
    await this.send({ type: "set_session_name", name });
  }
  /**
   * Get all messages in the session.
   * Messages are returned as opaque objects — the internal structure may vary.
   */
  async getMessages() {
    const response = await this.send({ type: "get_messages" });
    return this.getData(response).messages;
  }
  /**
   * Get available commands (extension commands, prompt templates, skills).
   */
  async getCommands() {
    const response = await this.send({ type: "get_commands" });
    return this.getData(response).commands;
  }
  /**
   * Send a UI response to a pending extension_ui_request.
   * Fire-and-forget — no request/response correlation.
   */
  sendUIResponse(id, response) {
    if (!this.process?.stdin) {
      throw new Error("Client not started");
    }
    this.process.stdin.write(serializeJsonLine({
      type: "extension_ui_response",
      id,
      ...response
    }));
  }
  /**
   * Initialize a v2 protocol session. Must be sent as the first command.
   * Returns the negotiated protocol version, session ID, and server capabilities.
   */
  async init(options) {
    const response = await this.send({ type: "init", protocolVersion: 2, clientId: options?.clientId });
    return this.getData(response);
  }
  /**
   * Request a graceful shutdown of the agent process.
   * Waits for the response before the process exits.
   */
  async shutdown() {
    await this.send({ type: "shutdown" });
    if (this.process) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 5e3);
        this.process?.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  }
  /**
   * Subscribe to specific event types (v2 only).
   * Pass ["*"] to receive all events, or a list of event type strings to filter.
   */
  async subscribe(events) {
    await this.send({ type: "subscribe", events });
  }
  // =========================================================================
  // Helpers
  // =========================================================================
  /**
   * Wait for agent to become idle (no streaming).
   * Resolves when agent_end event is received.
   */
  waitForIdle(timeout = 6e4) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
      }, timeout);
      const unsubscribe = this.onEvent((event) => {
        if (event.type === "agent_end") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
  }
  /**
   * Collect events until agent becomes idle.
   */
  collectEvents(timeout = 6e4) {
    return new Promise((resolve, reject) => {
      const events = [];
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
      }, timeout);
      const unsubscribe = this.onEvent((event) => {
        events.push(event);
        if (event.type === "agent_end") {
          clearTimeout(timer);
          unsubscribe();
          resolve(events);
        }
      });
    });
  }
  /**
   * Send prompt and wait for completion, returning all events.
   */
  async promptAndWait(message, images, timeout = 6e4) {
    const eventsPromise = this.collectEvents(timeout);
    await this.prompt(message, images);
    return eventsPromise;
  }
  // =========================================================================
  // Internal
  // =========================================================================
  handleLine(line) {
    try {
      const data = JSON.parse(line);
      if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
        const pending = this.pendingRequests.get(data.id);
        this.pendingRequests.delete(data.id);
        pending.resolve(data);
        return;
      }
      for (const listener of this.eventListeners) {
        listener(data);
      }
    } catch {
    }
  }
  async send(command) {
    if (!this.process?.stdin) {
      throw new Error("Client not started");
    }
    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
      }, 3e4);
      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      this.process.stdin.write(serializeJsonLine(fullCommand));
    });
  }
  getData(response) {
    if (!response.success) {
      const errorResponse = response;
      throw new Error(errorResponse.error);
    }
    const successResponse = response;
    return successResponse.data;
  }
}
export {
  RpcClient
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvcnBjLWNsaWVudC9zcmMvcnBjLWNsaWVudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSUEMgQ2xpZW50IGZvciBwcm9ncmFtbWF0aWMgYWNjZXNzIHRvIHRoZSBjb2RpbmcgYWdlbnQuXG4gKlxuICogU3Bhd25zIHRoZSBhZ2VudCBpbiBSUEMgbW9kZSBhbmQgcHJvdmlkZXMgYSB0eXBlZCBBUEkgZm9yIGFsbCBvcGVyYXRpb25zLlxuICogVGhpcyBpcyBhIHN0YW5kYWxvbmUgU0RLIGNsaWVudCBcdTIwMTQgYWxsIHR5cGVzIGFyZSBpbmxpbmVkIHdpdGggemVybyBpbnRlcm5hbFxuICogcGFja2FnZSBkZXBlbmRlbmNpZXMuXG4gKi9cblxuaW1wb3J0IHsgdHlwZSBDaGlsZFByb2Nlc3MsIHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgYXR0YWNoSnNvbmxMaW5lUmVhZGVyLCBzZXJpYWxpemVKc29uTGluZSB9IGZyb20gXCIuL2pzb25sLmpzXCI7XG5pbXBvcnQgdHlwZSB7XG5cdEJhc2hSZXN1bHQsXG5cdENvbXBhY3Rpb25SZXN1bHQsXG5cdEltYWdlQ29udGVudCxcblx0TW9kZWxJbmZvLFxuXHRScGNDb21tYW5kLFxuXHRScGNJbml0UmVzdWx0LFxuXHRScGNSZXNwb25zZSxcblx0UnBjU2Vzc2lvblN0YXRlLFxuXHRScGNTbGFzaENvbW1hbmQsXG5cdFNka0FnZW50RXZlbnQsXG5cdFRoaW5raW5nTGV2ZWwsXG5cdFNlc3Npb25TdGF0cyxcbn0gZnJvbSBcIi4vcnBjLXR5cGVzLmpzXCI7XG5cbmV4cG9ydCB0eXBlIHsgU2RrQWdlbnRFdmVudCB9O1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBUeXBlc1xuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG4vKiogRGlzdHJpYnV0aXZlIE9taXQgdGhhdCB3b3JrcyB3aXRoIHVuaW9uIHR5cGVzICovXG50eXBlIERpc3RyaWJ1dGl2ZU9taXQ8VCwgSyBleHRlbmRzIGtleW9mIFQ+ID0gVCBleHRlbmRzIHVua25vd24gPyBPbWl0PFQsIEs+IDogbmV2ZXI7XG5cbi8qKiBScGNDb21tYW5kIHdpdGhvdXQgdGhlIGlkIGZpZWxkIChmb3IgaW50ZXJuYWwgc2VuZCkgKi9cbnR5cGUgUnBjQ29tbWFuZEJvZHkgPSBEaXN0cmlidXRpdmVPbWl0PFJwY0NvbW1hbmQsIFwiaWRcIj47XG5cbmV4cG9ydCBpbnRlcmZhY2UgUnBjQ2xpZW50T3B0aW9ucyB7XG5cdC8qKiBQYXRoIHRvIHRoZSBDTEkgZW50cnkgcG9pbnQgKGRlZmF1bHQ6IHNlYXJjaGVzIGZvciBkaXN0L2NsaS5qcykgKi9cblx0Y2xpUGF0aD86IHN0cmluZztcblx0LyoqIFdvcmtpbmcgZGlyZWN0b3J5IGZvciB0aGUgYWdlbnQgKi9cblx0Y3dkPzogc3RyaW5nO1xuXHQvKiogRW52aXJvbm1lbnQgdmFyaWFibGVzICovXG5cdGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cdC8qKiBQcm92aWRlciB0byB1c2UgKi9cblx0cHJvdmlkZXI/OiBzdHJpbmc7XG5cdC8qKiBNb2RlbCBJRCB0byB1c2UgKi9cblx0bW9kZWw/OiBzdHJpbmc7XG5cdC8qKiBBZGRpdGlvbmFsIENMSSBhcmd1bWVudHMgKi9cblx0YXJncz86IHN0cmluZ1tdO1xufVxuXG5leHBvcnQgdHlwZSBScGNFdmVudExpc3RlbmVyID0gKGV2ZW50OiBTZGtBZ2VudEV2ZW50KSA9PiB2b2lkO1xuXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4vLyBSUEMgQ2xpZW50XG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbmV4cG9ydCBjbGFzcyBScGNDbGllbnQge1xuXHRwcml2YXRlIHByb2Nlc3M6IENoaWxkUHJvY2VzcyB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHN0b3BSZWFkaW5nU3Rkb3V0OiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBfc3RkZXJySGFuZGxlcj86IChkYXRhOiBCdWZmZXIpID0+IHZvaWQ7XG5cdHByaXZhdGUgZXZlbnRMaXN0ZW5lcnM6IFJwY0V2ZW50TGlzdGVuZXJbXSA9IFtdO1xuXHRwcml2YXRlIHBlbmRpbmdSZXF1ZXN0czogTWFwPHN0cmluZywgeyByZXNvbHZlOiAocmVzcG9uc2U6IFJwY1Jlc3BvbnNlKSA9PiB2b2lkOyByZWplY3Q6IChlcnJvcjogRXJyb3IpID0+IHZvaWQgfT4gPVxuXHRcdG5ldyBNYXAoKTtcblx0cHJpdmF0ZSByZXF1ZXN0SWQgPSAwO1xuXHRwcml2YXRlIHN0ZGVyciA9IFwiXCI7XG5cdHByaXZhdGUgX3N0b3BwZWQgPSBmYWxzZTtcblxuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIG9wdGlvbnM6IFJwY0NsaWVudE9wdGlvbnMgPSB7fSkge31cblxuXHQvKipcblx0ICogU3RhcnQgdGhlIFJQQyBhZ2VudCBwcm9jZXNzLlxuXHQgKi9cblx0YXN5bmMgc3RhcnQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMucHJvY2Vzcykge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQ2xpZW50IGFscmVhZHkgc3RhcnRlZFwiKTtcblx0XHR9XG5cblx0XHR0aGlzLl9zdG9wcGVkID0gZmFsc2U7XG5cblx0XHRjb25zdCBjbGlQYXRoID0gdGhpcy5vcHRpb25zLmNsaVBhdGggPz8gXCJkaXN0L2NsaS5qc1wiO1xuXHRcdGNvbnN0IGFyZ3MgPSBbXCItLW1vZGVcIiwgXCJycGNcIl07XG5cblx0XHRpZiAodGhpcy5vcHRpb25zLnByb3ZpZGVyKSB7XG5cdFx0XHRhcmdzLnB1c2goXCItLXByb3ZpZGVyXCIsIHRoaXMub3B0aW9ucy5wcm92aWRlcik7XG5cdFx0fVxuXHRcdGlmICh0aGlzLm9wdGlvbnMubW9kZWwpIHtcblx0XHRcdGFyZ3MucHVzaChcIi0tbW9kZWxcIiwgdGhpcy5vcHRpb25zLm1vZGVsKTtcblx0XHR9XG5cdFx0aWYgKHRoaXMub3B0aW9ucy5hcmdzKSB7XG5cdFx0XHRhcmdzLnB1c2goLi4udGhpcy5vcHRpb25zLmFyZ3MpO1xuXHRcdH1cblxuXHRcdHRoaXMucHJvY2VzcyA9IHNwYXduKFwibm9kZVwiLCBbY2xpUGF0aCwgLi4uYXJnc10sIHtcblx0XHRcdGN3ZDogdGhpcy5vcHRpb25zLmN3ZCxcblx0XHRcdGVudjogeyAuLi5wcm9jZXNzLmVudiwgLi4udGhpcy5vcHRpb25zLmVudiB9LFxuXHRcdFx0c3RkaW86IFtcInBpcGVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcblx0XHR9KTtcblxuXHRcdC8vIENvbGxlY3Qgc3RkZXJyIGZvciBkZWJ1Z2dpbmdcblx0XHR0aGlzLl9zdGRlcnJIYW5kbGVyID0gKGRhdGE6IEJ1ZmZlcikgPT4ge1xuXHRcdFx0dGhpcy5zdGRlcnIgKz0gZGF0YS50b1N0cmluZygpO1xuXHRcdH07XG5cdFx0dGhpcy5wcm9jZXNzLnN0ZGVycj8ub24oXCJkYXRhXCIsIHRoaXMuX3N0ZGVyckhhbmRsZXIpO1xuXG5cdFx0Ly8gU2V0IHVwIHN0cmljdCBKU09OTCByZWFkZXIgZm9yIHN0ZG91dC5cblx0XHR0aGlzLnN0b3BSZWFkaW5nU3Rkb3V0ID0gYXR0YWNoSnNvbmxMaW5lUmVhZGVyKHRoaXMucHJvY2Vzcy5zdGRvdXQhLCAobGluZSkgPT4ge1xuXHRcdFx0dGhpcy5oYW5kbGVMaW5lKGxpbmUpO1xuXHRcdH0pO1xuXG5cdFx0Ly8gRGV0ZWN0IHVuZXhwZWN0ZWQgc3VicHJvY2VzcyBleGl0IGFuZCByZWplY3QgYWxsIHBlbmRpbmcgcmVxdWVzdHNcblx0XHR0aGlzLnByb2Nlc3Mub24oXCJleGl0XCIsIChjb2RlLCBzaWduYWwpID0+IHtcblx0XHRcdGlmICh0aGlzLnBlbmRpbmdSZXF1ZXN0cy5zaXplID4gMCkge1xuXHRcdFx0XHRjb25zdCByZWFzb24gPSBzaWduYWwgPyBgc2lnbmFsICR7c2lnbmFsfWAgOiBgY29kZSAke2NvZGV9YDtcblx0XHRcdFx0Y29uc3QgZXJyb3IgPSBuZXcgRXJyb3IoYEFnZW50IHByb2Nlc3MgZXhpdGVkIHVuZXhwZWN0ZWRseSAoJHtyZWFzb259KS4gU3RkZXJyOiAke3RoaXMuc3RkZXJyfWApO1xuXHRcdFx0XHRmb3IgKGNvbnN0IFtpZCwgcGVuZGluZ10gb2YgdGhpcy5wZW5kaW5nUmVxdWVzdHMpIHtcblx0XHRcdFx0XHR0aGlzLnBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoaWQpO1xuXHRcdFx0XHRcdHBlbmRpbmcucmVqZWN0KGVycm9yKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0pO1xuXG5cdFx0Ly8gV2FpdCBhIG1vbWVudCBmb3IgcHJvY2VzcyB0byBpbml0aWFsaXplXG5cdFx0YXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMTAwKSk7XG5cblx0XHRpZiAodGhpcy5wcm9jZXNzLmV4aXRDb2RlICE9PSBudWxsKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEFnZW50IHByb2Nlc3MgZXhpdGVkIGltbWVkaWF0ZWx5IHdpdGggY29kZSAke3RoaXMucHJvY2Vzcy5leGl0Q29kZX0uIFN0ZGVycjogJHt0aGlzLnN0ZGVycn1gKTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogU3RvcCB0aGUgUlBDIGFnZW50IHByb2Nlc3MuXG5cdCAqL1xuXHRhc3luYyBzdG9wKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICghdGhpcy5wcm9jZXNzKSByZXR1cm47XG5cblx0XHR0aGlzLl9zdG9wcGVkID0gdHJ1ZTtcblxuXHRcdHRoaXMuc3RvcFJlYWRpbmdTdGRvdXQ/LigpO1xuXHRcdHRoaXMuc3RvcFJlYWRpbmdTdGRvdXQgPSBudWxsO1xuXHRcdGlmICh0aGlzLl9zdGRlcnJIYW5kbGVyKSB7XG5cdFx0XHR0aGlzLnByb2Nlc3Muc3RkZXJyPy5yZW1vdmVMaXN0ZW5lcihcImRhdGFcIiwgdGhpcy5fc3RkZXJySGFuZGxlcik7XG5cdFx0XHR0aGlzLl9zdGRlcnJIYW5kbGVyID0gdW5kZWZpbmVkO1xuXHRcdH1cblx0XHR0aGlzLnByb2Nlc3Mua2lsbChcIlNJR1RFUk1cIik7XG5cblx0XHQvLyBXYWl0IGZvciBwcm9jZXNzIHRvIGV4aXRcblx0XHRhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdFx0Y29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHR0aGlzLnByb2Nlc3M/LmtpbGwoXCJTSUdLSUxMXCIpO1xuXHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHR9LCAxMDAwKTtcblxuXHRcdFx0dGhpcy5wcm9jZXNzPy5vbihcImV4aXRcIiwgKCkgPT4ge1xuXHRcdFx0XHRjbGVhclRpbWVvdXQodGltZW91dCk7XG5cdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdH0pO1xuXHRcdH0pO1xuXG5cdFx0dGhpcy5wcm9jZXNzID0gbnVsbDtcblx0XHR0aGlzLnBlbmRpbmdSZXF1ZXN0cy5jbGVhcigpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFN1YnNjcmliZSB0byBhZ2VudCBldmVudHMgdmlhIGNhbGxiYWNrLlxuXHQgKi9cblx0b25FdmVudChsaXN0ZW5lcjogUnBjRXZlbnRMaXN0ZW5lcik6ICgpID0+IHZvaWQge1xuXHRcdHRoaXMuZXZlbnRMaXN0ZW5lcnMucHVzaChsaXN0ZW5lcik7XG5cdFx0cmV0dXJuICgpID0+IHtcblx0XHRcdGNvbnN0IGluZGV4ID0gdGhpcy5ldmVudExpc3RlbmVycy5pbmRleE9mKGxpc3RlbmVyKTtcblx0XHRcdGlmIChpbmRleCAhPT0gLTEpIHtcblx0XHRcdFx0dGhpcy5ldmVudExpc3RlbmVycy5zcGxpY2UoaW5kZXgsIDEpO1xuXHRcdFx0fVxuXHRcdH07XG5cdH1cblxuXHQvKipcblx0ICogQXN5bmMgZ2VuZXJhdG9yIHRoYXQgeWllbGRzIGFnZW50IGV2ZW50cyBhcyB0aGV5IGFycml2ZS5cblx0ICpcblx0ICogVXNhZ2U6XG5cdCAqIGBgYHRzXG5cdCAqIGZvciBhd2FpdCAoY29uc3QgZXZlbnQgb2YgY2xpZW50LmV2ZW50cygpKSB7XG5cdCAqICAgY29uc29sZS5sb2coZXZlbnQudHlwZSwgZXZlbnQpO1xuXHQgKiB9XG5cdCAqIGBgYFxuXHQgKlxuXHQgKiBUaGUgZ2VuZXJhdG9yIHRlcm1pbmF0ZXMgd2hlbjpcblx0ICogLSBgc3RvcCgpYCBpcyBjYWxsZWRcblx0ICogLSBUaGUgYWdlbnQgcHJvY2VzcyBleGl0c1xuXHQgKiAtIFRoZSBjb25zdW1lciBicmVha3Mgb3V0IG9mIHRoZSBsb29wXG5cdCAqL1xuXHRhc3luYyAqZXZlbnRzKCk6IEFzeW5jR2VuZXJhdG9yPFNka0FnZW50RXZlbnQsIHZvaWQsIHVuZGVmaW5lZD4ge1xuXHRcdGlmICghdGhpcy5wcm9jZXNzKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJDbGllbnQgbm90IHN0YXJ0ZWQgXHUyMDE0IGNhbGwgc3RhcnQoKSBiZWZvcmUgZXZlbnRzKClcIik7XG5cdFx0fVxuXG5cdFx0aWYgKHRoaXMuX3N0b3BwZWQpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBidWZmZXI6IFNka0FnZW50RXZlbnRbXSA9IFtdO1xuXHRcdGxldCByZXNvbHZlOiAoKHZhbHVlOiB2b2lkKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXHRcdGxldCBkb25lID0gZmFsc2U7XG5cblx0XHQvLyBXaGVuIGEgbmV3IGV2ZW50IGFycml2ZXMsIGVpdGhlciBwdXNoIHRvIGJ1ZmZlciBvciB3YWtlIHVwIHRoZSBhd2FpdGluZyBnZW5lcmF0b3Jcblx0XHRjb25zdCBsaXN0ZW5lciA9IChldmVudDogU2RrQWdlbnRFdmVudCkgPT4ge1xuXHRcdFx0YnVmZmVyLnB1c2goZXZlbnQpO1xuXHRcdFx0aWYgKHJlc29sdmUpIHtcblx0XHRcdFx0Y29uc3QgciA9IHJlc29sdmU7XG5cdFx0XHRcdHJlc29sdmUgPSBudWxsO1xuXHRcdFx0XHRyKCk7XG5cdFx0XHR9XG5cdFx0fTtcblxuXHRcdC8vIFdoZW4gdGhlIHByb2Nlc3MgZXhpdHMsIHNpZ25hbCB0aGUgZ2VuZXJhdG9yIHRvIHN0b3Bcblx0XHRjb25zdCBvbkV4aXQgPSAoKSA9PiB7XG5cdFx0XHRkb25lID0gdHJ1ZTtcblx0XHRcdGlmIChyZXNvbHZlKSB7XG5cdFx0XHRcdGNvbnN0IHIgPSByZXNvbHZlO1xuXHRcdFx0XHRyZXNvbHZlID0gbnVsbDtcblx0XHRcdFx0cigpO1xuXHRcdFx0fVxuXHRcdH07XG5cblx0XHRjb25zdCB1bnN1YnNjcmliZSA9IHRoaXMub25FdmVudChsaXN0ZW5lcik7XG5cdFx0dGhpcy5wcm9jZXNzLm9uKFwiZXhpdFwiLCBvbkV4aXQpO1xuXG5cdFx0dHJ5IHtcblx0XHRcdHdoaWxlICghZG9uZSAmJiAhdGhpcy5fc3RvcHBlZCkge1xuXHRcdFx0XHQvLyBEcmFpbiBidWZmZXIgZmlyc3Rcblx0XHRcdFx0d2hpbGUgKGJ1ZmZlci5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0eWllbGQgYnVmZmVyLnNoaWZ0KCkhO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gSWYgZG9uZSBhZnRlciBkcmFpbmluZywgYnJlYWtcblx0XHRcdFx0aWYgKGRvbmUgfHwgdGhpcy5fc3RvcHBlZCkge1xuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gV2FpdCBmb3IgbmV4dCBldmVudCBvciBwcm9jZXNzIGV4aXRcblx0XHRcdFx0YXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHtcblx0XHRcdFx0XHRyZXNvbHZlID0gcjtcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIERyYWluIGFueSByZW1haW5pbmcgZXZlbnRzIHRoYXQgYXJyaXZlZCB3aXRoIHRoZSBleGl0IHNpZ25hbFxuXHRcdFx0d2hpbGUgKGJ1ZmZlci5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdHlpZWxkIGJ1ZmZlci5zaGlmdCgpITtcblx0XHRcdH1cblx0XHR9IGZpbmFsbHkge1xuXHRcdFx0dW5zdWJzY3JpYmUoKTtcblx0XHRcdHRoaXMucHJvY2Vzcz8ucmVtb3ZlTGlzdGVuZXIoXCJleGl0XCIsIG9uRXhpdCk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBjb2xsZWN0ZWQgc3RkZXJyIG91dHB1dCAodXNlZnVsIGZvciBkZWJ1Z2dpbmcpLlxuXHQgKi9cblx0Z2V0U3RkZXJyKCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIHRoaXMuc3RkZXJyO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBDb21tYW5kIE1ldGhvZHNcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdC8qKlxuXHQgKiBTZW5kIGEgcHJvbXB0IHRvIHRoZSBhZ2VudC5cblx0ICogUmV0dXJucyBpbW1lZGlhdGVseSBhZnRlciBzZW5kaW5nOyB1c2Ugb25FdmVudCgpIG9yIGV2ZW50cygpIHRvIHJlY2VpdmUgc3RyZWFtaW5nIGV2ZW50cy5cblx0ICogVXNlIHdhaXRGb3JJZGxlKCkgdG8gd2FpdCBmb3IgY29tcGxldGlvbi5cblx0ICovXG5cdGFzeW5jIHByb21wdChtZXNzYWdlOiBzdHJpbmcsIGltYWdlcz86IEltYWdlQ29udGVudFtdKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJwcm9tcHRcIiwgbWVzc2FnZSwgaW1hZ2VzIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIFF1ZXVlIGEgc3RlZXJpbmcgbWVzc2FnZSB0byBpbnRlcnJ1cHQgdGhlIGFnZW50IG1pZC1ydW4uXG5cdCAqL1xuXHRhc3luYyBzdGVlcihtZXNzYWdlOiBzdHJpbmcsIGltYWdlcz86IEltYWdlQ29udGVudFtdKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzdGVlclwiLCBtZXNzYWdlLCBpbWFnZXMgfSk7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYSBmb2xsb3ctdXAgbWVzc2FnZSB0byBiZSBwcm9jZXNzZWQgYWZ0ZXIgdGhlIGFnZW50IGZpbmlzaGVzLlxuXHQgKi9cblx0YXN5bmMgZm9sbG93VXAobWVzc2FnZTogc3RyaW5nLCBpbWFnZXM/OiBJbWFnZUNvbnRlbnRbXSk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZm9sbG93X3VwXCIsIG1lc3NhZ2UsIGltYWdlcyB9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBBYm9ydCBjdXJyZW50IG9wZXJhdGlvbi5cblx0ICovXG5cdGFzeW5jIGFib3J0KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiYWJvcnRcIiB9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTdGFydCBhIG5ldyBzZXNzaW9uLCBvcHRpb25hbGx5IHdpdGggcGFyZW50IHRyYWNraW5nLlxuXHQgKiBAcGFyYW0gcGFyZW50U2Vzc2lvbiAtIE9wdGlvbmFsIHBhcmVudCBzZXNzaW9uIHBhdGggZm9yIGxpbmVhZ2UgdHJhY2tpbmdcblx0ICogQHJldHVybnMgT2JqZWN0IHdpdGggYGNhbmNlbGxlZDogdHJ1ZWAgaWYgYW4gZXh0ZW5zaW9uIGNhbmNlbGxlZCB0aGUgbmV3IHNlc3Npb25cblx0ICovXG5cdGFzeW5jIG5ld1Nlc3Npb24ocGFyZW50U2Vzc2lvbj86IHN0cmluZyk6IFByb21pc2U8eyBjYW5jZWxsZWQ6IGJvb2xlYW4gfT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJuZXdfc2Vzc2lvblwiLCBwYXJlbnRTZXNzaW9uIH0pO1xuXHRcdHJldHVybiB0aGlzLmdldERhdGEocmVzcG9uc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBjdXJyZW50IHNlc3Npb24gc3RhdGUuXG5cdCAqL1xuXHRhc3luYyBnZXRTdGF0ZSgpOiBQcm9taXNlPFJwY1Nlc3Npb25TdGF0ZT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJnZXRfc3RhdGVcIiB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgbW9kZWwgYnkgcHJvdmlkZXIgYW5kIElELlxuXHQgKi9cblx0YXN5bmMgc2V0TW9kZWwocHJvdmlkZXI6IHN0cmluZywgbW9kZWxJZDogc3RyaW5nKTogUHJvbWlzZTx7IHByb3ZpZGVyOiBzdHJpbmc7IGlkOiBzdHJpbmcgfT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzZXRfbW9kZWxcIiwgcHJvdmlkZXIsIG1vZGVsSWQgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YShyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogQ3ljbGUgdG8gbmV4dCBtb2RlbC5cblx0ICovXG5cdGFzeW5jIGN5Y2xlTW9kZWwoKTogUHJvbWlzZTx7XG5cdFx0bW9kZWw6IHsgcHJvdmlkZXI6IHN0cmluZzsgaWQ6IHN0cmluZyB9O1xuXHRcdHRoaW5raW5nTGV2ZWw6IFRoaW5raW5nTGV2ZWw7XG5cdFx0aXNTY29wZWQ6IGJvb2xlYW47XG5cdH0gfCBudWxsPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImN5Y2xlX21vZGVsXCIgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YShyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGxpc3Qgb2YgYXZhaWxhYmxlIG1vZGVscy5cblx0ICovXG5cdGFzeW5jIGdldEF2YWlsYWJsZU1vZGVscygpOiBQcm9taXNlPE1vZGVsSW5mb1tdPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9hdmFpbGFibGVfbW9kZWxzXCIgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YTx7IG1vZGVsczogTW9kZWxJbmZvW10gfT4ocmVzcG9uc2UpLm1vZGVscztcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgdGhpbmtpbmcgbGV2ZWwuXG5cdCAqL1xuXHRhc3luYyBzZXRUaGlua2luZ0xldmVsKGxldmVsOiBUaGlua2luZ0xldmVsKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzZXRfdGhpbmtpbmdfbGV2ZWxcIiwgbGV2ZWwgfSk7XG5cdH1cblxuXHQvKipcblx0ICogQ3ljbGUgdGhpbmtpbmcgbGV2ZWwuXG5cdCAqL1xuXHRhc3luYyBjeWNsZVRoaW5raW5nTGV2ZWwoKTogUHJvbWlzZTx7IGxldmVsOiBUaGlua2luZ0xldmVsIH0gfCBudWxsPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImN5Y2xlX3RoaW5raW5nX2xldmVsXCIgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YShyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IHN0ZWVyaW5nIG1vZGUuXG5cdCAqL1xuXHRhc3luYyBzZXRTdGVlcmluZ01vZGUobW9kZTogXCJhbGxcIiB8IFwib25lLWF0LWEtdGltZVwiKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzZXRfc3RlZXJpbmdfbW9kZVwiLCBtb2RlIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldCBmb2xsb3ctdXAgbW9kZS5cblx0ICovXG5cdGFzeW5jIHNldEZvbGxvd1VwTW9kZShtb2RlOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCIpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInNldF9mb2xsb3dfdXBfbW9kZVwiLCBtb2RlIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIENvbXBhY3Qgc2Vzc2lvbiBjb250ZXh0LlxuXHQgKi9cblx0YXN5bmMgY29tcGFjdChjdXN0b21JbnN0cnVjdGlvbnM/OiBzdHJpbmcpOiBQcm9taXNlPENvbXBhY3Rpb25SZXN1bHQ+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiY29tcGFjdFwiLCBjdXN0b21JbnN0cnVjdGlvbnMgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YShyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGF1dG8tY29tcGFjdGlvbiBlbmFibGVkL2Rpc2FibGVkLlxuXHQgKi9cblx0YXN5bmMgc2V0QXV0b0NvbXBhY3Rpb24oZW5hYmxlZDogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwic2V0X2F1dG9fY29tcGFjdGlvblwiLCBlbmFibGVkIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldCBhdXRvLXJldHJ5IGVuYWJsZWQvZGlzYWJsZWQuXG5cdCAqL1xuXHRhc3luYyBzZXRBdXRvUmV0cnkoZW5hYmxlZDogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwic2V0X2F1dG9fcmV0cnlcIiwgZW5hYmxlZCB9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBBYm9ydCBpbi1wcm9ncmVzcyByZXRyeS5cblx0ICovXG5cdGFzeW5jIGFib3J0UmV0cnkoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJhYm9ydF9yZXRyeVwiIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIEV4ZWN1dGUgYSBiYXNoIGNvbW1hbmQuXG5cdCAqL1xuXHRhc3luYyBiYXNoKGNvbW1hbmQ6IHN0cmluZyk6IFByb21pc2U8QmFzaFJlc3VsdD4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJiYXNoXCIsIGNvbW1hbmQgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YShyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogQWJvcnQgcnVubmluZyBiYXNoIGNvbW1hbmQuXG5cdCAqL1xuXHRhc3luYyBhYm9ydEJhc2goKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJhYm9ydF9iYXNoXCIgfSk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IHNlc3Npb24gc3RhdGlzdGljcy5cblx0ICovXG5cdGFzeW5jIGdldFNlc3Npb25TdGF0cygpOiBQcm9taXNlPFNlc3Npb25TdGF0cz4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJnZXRfc2Vzc2lvbl9zdGF0c1wiIH0pO1xuXHRcdHJldHVybiB0aGlzLmdldERhdGEocmVzcG9uc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEV4cG9ydCBzZXNzaW9uIHRvIEhUTUwuXG5cdCAqL1xuXHRhc3luYyBleHBvcnRIdG1sKG91dHB1dFBhdGg/OiBzdHJpbmcpOiBQcm9taXNlPHsgcGF0aDogc3RyaW5nIH0+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZXhwb3J0X2h0bWxcIiwgb3V0cHV0UGF0aCB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTd2l0Y2ggdG8gYSBkaWZmZXJlbnQgc2Vzc2lvbiBmaWxlLlxuXHQgKiBAcmV0dXJucyBPYmplY3Qgd2l0aCBgY2FuY2VsbGVkOiB0cnVlYCBpZiBhbiBleHRlbnNpb24gY2FuY2VsbGVkIHRoZSBzd2l0Y2hcblx0ICovXG5cdGFzeW5jIHN3aXRjaFNlc3Npb24oc2Vzc2lvblBhdGg6IHN0cmluZyk6IFByb21pc2U8eyBjYW5jZWxsZWQ6IGJvb2xlYW4gfT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzd2l0Y2hfc2Vzc2lvblwiLCBzZXNzaW9uUGF0aCB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBGb3JrIGZyb20gYSBzcGVjaWZpYyBtZXNzYWdlLlxuXHQgKiBAcmV0dXJucyBPYmplY3Qgd2l0aCBgdGV4dGAgKHRoZSBtZXNzYWdlIHRleHQpIGFuZCBgY2FuY2VsbGVkYCAoaWYgZXh0ZW5zaW9uIGNhbmNlbGxlZClcblx0ICovXG5cdGFzeW5jIGZvcmsoZW50cnlJZDogc3RyaW5nKTogUHJvbWlzZTx7IHRleHQ6IHN0cmluZzsgY2FuY2VsbGVkOiBib29sZWFuIH0+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZm9ya1wiLCBlbnRyeUlkIH0pO1xuXHRcdHJldHVybiB0aGlzLmdldERhdGEocmVzcG9uc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBtZXNzYWdlcyBhdmFpbGFibGUgZm9yIGZvcmtpbmcuXG5cdCAqL1xuXHRhc3luYyBnZXRGb3JrTWVzc2FnZXMoKTogUHJvbWlzZTxBcnJheTx7IGVudHJ5SWQ6IHN0cmluZzsgdGV4dDogc3RyaW5nIH0+PiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9mb3JrX21lc3NhZ2VzXCIgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YTx7IG1lc3NhZ2VzOiBBcnJheTx7IGVudHJ5SWQ6IHN0cmluZzsgdGV4dDogc3RyaW5nIH0+IH0+KHJlc3BvbnNlKS5tZXNzYWdlcztcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgdGV4dCBvZiBsYXN0IGFzc2lzdGFudCBtZXNzYWdlLlxuXHQgKi9cblx0YXN5bmMgZ2V0TGFzdEFzc2lzdGFudFRleHQoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9sYXN0X2Fzc2lzdGFudF90ZXh0XCIgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YTx7IHRleHQ6IHN0cmluZyB8IG51bGwgfT4ocmVzcG9uc2UpLnRleHQ7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IHRoZSBzZXNzaW9uIGRpc3BsYXkgbmFtZS5cblx0ICovXG5cdGFzeW5jIHNldFNlc3Npb25OYW1lKG5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwic2V0X3Nlc3Npb25fbmFtZVwiLCBuYW1lIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBhbGwgbWVzc2FnZXMgaW4gdGhlIHNlc3Npb24uXG5cdCAqIE1lc3NhZ2VzIGFyZSByZXR1cm5lZCBhcyBvcGFxdWUgb2JqZWN0cyBcdTIwMTQgdGhlIGludGVybmFsIHN0cnVjdHVyZSBtYXkgdmFyeS5cblx0ICovXG5cdGFzeW5jIGdldE1lc3NhZ2VzKCk6IFByb21pc2U8dW5rbm93bltdPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9tZXNzYWdlc1wiIH0pO1xuXHRcdHJldHVybiB0aGlzLmdldERhdGE8eyBtZXNzYWdlczogdW5rbm93bltdIH0+KHJlc3BvbnNlKS5tZXNzYWdlcztcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgYXZhaWxhYmxlIGNvbW1hbmRzIChleHRlbnNpb24gY29tbWFuZHMsIHByb21wdCB0ZW1wbGF0ZXMsIHNraWxscykuXG5cdCAqL1xuXHRhc3luYyBnZXRDb21tYW5kcygpOiBQcm9taXNlPFJwY1NsYXNoQ29tbWFuZFtdPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9jb21tYW5kc1wiIH0pO1xuXHRcdHJldHVybiB0aGlzLmdldERhdGE8eyBjb21tYW5kczogUnBjU2xhc2hDb21tYW5kW10gfT4ocmVzcG9uc2UpLmNvbW1hbmRzO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNlbmQgYSBVSSByZXNwb25zZSB0byBhIHBlbmRpbmcgZXh0ZW5zaW9uX3VpX3JlcXVlc3QuXG5cdCAqIEZpcmUtYW5kLWZvcmdldCBcdTIwMTQgbm8gcmVxdWVzdC9yZXNwb25zZSBjb3JyZWxhdGlvbi5cblx0ICovXG5cdHNlbmRVSVJlc3BvbnNlKGlkOiBzdHJpbmcsIHJlc3BvbnNlOiB7IHZhbHVlPzogc3RyaW5nOyB2YWx1ZXM/OiBzdHJpbmdbXTsgY29uZmlybWVkPzogYm9vbGVhbjsgY2FuY2VsbGVkPzogYm9vbGVhbiB9KTogdm9pZCB7XG5cdFx0aWYgKCF0aGlzLnByb2Nlc3M/LnN0ZGluKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoXCJDbGllbnQgbm90IHN0YXJ0ZWRcIik7XG5cdFx0fVxuXHRcdHRoaXMucHJvY2Vzcy5zdGRpbi53cml0ZShzZXJpYWxpemVKc29uTGluZSh7XG5cdFx0XHR0eXBlOiBcImV4dGVuc2lvbl91aV9yZXNwb25zZVwiLFxuXHRcdFx0aWQsXG5cdFx0XHQuLi5yZXNwb25zZSxcblx0XHR9KSk7XG5cdH1cblxuXHQvKipcblx0ICogSW5pdGlhbGl6ZSBhIHYyIHByb3RvY29sIHNlc3Npb24uIE11c3QgYmUgc2VudCBhcyB0aGUgZmlyc3QgY29tbWFuZC5cblx0ICogUmV0dXJucyB0aGUgbmVnb3RpYXRlZCBwcm90b2NvbCB2ZXJzaW9uLCBzZXNzaW9uIElELCBhbmQgc2VydmVyIGNhcGFiaWxpdGllcy5cblx0ICovXG5cdGFzeW5jIGluaXQob3B0aW9ucz86IHsgY2xpZW50SWQ/OiBzdHJpbmcgfSk6IFByb21pc2U8UnBjSW5pdFJlc3VsdD4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJpbml0XCIsIHByb3RvY29sVmVyc2lvbjogMiwgY2xpZW50SWQ6IG9wdGlvbnM/LmNsaWVudElkIH0pO1xuXHRcdHJldHVybiB0aGlzLmdldERhdGE8UnBjSW5pdFJlc3VsdD4ocmVzcG9uc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlcXVlc3QgYSBncmFjZWZ1bCBzaHV0ZG93biBvZiB0aGUgYWdlbnQgcHJvY2Vzcy5cblx0ICogV2FpdHMgZm9yIHRoZSByZXNwb25zZSBiZWZvcmUgdGhlIHByb2Nlc3MgZXhpdHMuXG5cdCAqL1xuXHRhc3luYyBzaHV0ZG93bigpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInNodXRkb3duXCIgfSk7XG5cdFx0Ly8gV2FpdCBmb3IgcHJvY2VzcyB0byBleGl0IGFmdGVyIHNodXRkb3duIGFja25vd2xlZGdtZW50XG5cdFx0aWYgKHRoaXMucHJvY2Vzcykge1xuXHRcdFx0YXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcblx0XHRcdFx0Y29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRcdHRoaXMucHJvY2Vzcz8ua2lsbChcIlNJR0tJTExcIik7XG5cdFx0XHRcdFx0cmVzb2x2ZSgpO1xuXHRcdFx0XHR9LCA1MDAwKTtcblx0XHRcdFx0dGhpcy5wcm9jZXNzPy5vbihcImV4aXRcIiwgKCkgPT4ge1xuXHRcdFx0XHRcdGNsZWFyVGltZW91dCh0aW1lb3V0KTtcblx0XHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHRcdH0pO1xuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFN1YnNjcmliZSB0byBzcGVjaWZpYyBldmVudCB0eXBlcyAodjIgb25seSkuXG5cdCAqIFBhc3MgW1wiKlwiXSB0byByZWNlaXZlIGFsbCBldmVudHMsIG9yIGEgbGlzdCBvZiBldmVudCB0eXBlIHN0cmluZ3MgdG8gZmlsdGVyLlxuXHQgKi9cblx0YXN5bmMgc3Vic2NyaWJlKGV2ZW50czogc3RyaW5nW10pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInN1YnNjcmliZVwiLCBldmVudHMgfSk7XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIEhlbHBlcnNcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdC8qKlxuXHQgKiBXYWl0IGZvciBhZ2VudCB0byBiZWNvbWUgaWRsZSAobm8gc3RyZWFtaW5nKS5cblx0ICogUmVzb2x2ZXMgd2hlbiBhZ2VudF9lbmQgZXZlbnQgaXMgcmVjZWl2ZWQuXG5cdCAqL1xuXHR3YWl0Rm9ySWRsZSh0aW1lb3V0ID0gNjAwMDApOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0Y29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dW5zdWJzY3JpYmUoKTtcblx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihgVGltZW91dCB3YWl0aW5nIGZvciBhZ2VudCB0byBiZWNvbWUgaWRsZS4gU3RkZXJyOiAke3RoaXMuc3RkZXJyfWApKTtcblx0XHRcdH0sIHRpbWVvdXQpO1xuXG5cdFx0XHRjb25zdCB1bnN1YnNjcmliZSA9IHRoaXMub25FdmVudCgoZXZlbnQpID0+IHtcblx0XHRcdFx0aWYgKGV2ZW50LnR5cGUgPT09IFwiYWdlbnRfZW5kXCIpIHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQodGltZXIpO1xuXHRcdFx0XHRcdHVuc3Vic2NyaWJlKCk7XG5cdFx0XHRcdFx0cmVzb2x2ZSgpO1xuXHRcdFx0XHR9XG5cdFx0XHR9KTtcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDb2xsZWN0IGV2ZW50cyB1bnRpbCBhZ2VudCBiZWNvbWVzIGlkbGUuXG5cdCAqL1xuXHRjb2xsZWN0RXZlbnRzKHRpbWVvdXQgPSA2MDAwMCk6IFByb21pc2U8U2RrQWdlbnRFdmVudFtdPiB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdGNvbnN0IGV2ZW50czogU2RrQWdlbnRFdmVudFtdID0gW107XG5cdFx0XHRjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHR1bnN1YnNjcmliZSgpO1xuXHRcdFx0XHRyZWplY3QobmV3IEVycm9yKGBUaW1lb3V0IGNvbGxlY3RpbmcgZXZlbnRzLiBTdGRlcnI6ICR7dGhpcy5zdGRlcnJ9YCkpO1xuXHRcdFx0fSwgdGltZW91dCk7XG5cblx0XHRcdGNvbnN0IHVuc3Vic2NyaWJlID0gdGhpcy5vbkV2ZW50KChldmVudCkgPT4ge1xuXHRcdFx0XHRldmVudHMucHVzaChldmVudCk7XG5cdFx0XHRcdGlmIChldmVudC50eXBlID09PSBcImFnZW50X2VuZFwiKSB7XG5cdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVyKTtcblx0XHRcdFx0XHR1bnN1YnNjcmliZSgpO1xuXHRcdFx0XHRcdHJlc29sdmUoZXZlbnRzKTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXHQvKipcblx0ICogU2VuZCBwcm9tcHQgYW5kIHdhaXQgZm9yIGNvbXBsZXRpb24sIHJldHVybmluZyBhbGwgZXZlbnRzLlxuXHQgKi9cblx0YXN5bmMgcHJvbXB0QW5kV2FpdChtZXNzYWdlOiBzdHJpbmcsIGltYWdlcz86IEltYWdlQ29udGVudFtdLCB0aW1lb3V0ID0gNjAwMDApOiBQcm9taXNlPFNka0FnZW50RXZlbnRbXT4ge1xuXHRcdGNvbnN0IGV2ZW50c1Byb21pc2UgPSB0aGlzLmNvbGxlY3RFdmVudHModGltZW91dCk7XG5cdFx0YXdhaXQgdGhpcy5wcm9tcHQobWVzc2FnZSwgaW1hZ2VzKTtcblx0XHRyZXR1cm4gZXZlbnRzUHJvbWlzZTtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gSW50ZXJuYWxcblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdHByaXZhdGUgaGFuZGxlTGluZShsaW5lOiBzdHJpbmcpOiB2b2lkIHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgZGF0YSA9IEpTT04ucGFyc2UobGluZSk7XG5cblx0XHRcdC8vIENoZWNrIGlmIGl0J3MgYSByZXNwb25zZSB0byBhIHBlbmRpbmcgcmVxdWVzdFxuXHRcdFx0aWYgKGRhdGEudHlwZSA9PT0gXCJyZXNwb25zZVwiICYmIGRhdGEuaWQgJiYgdGhpcy5wZW5kaW5nUmVxdWVzdHMuaGFzKGRhdGEuaWQpKSB7XG5cdFx0XHRcdGNvbnN0IHBlbmRpbmcgPSB0aGlzLnBlbmRpbmdSZXF1ZXN0cy5nZXQoZGF0YS5pZCkhO1xuXHRcdFx0XHR0aGlzLnBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoZGF0YS5pZCk7XG5cdFx0XHRcdHBlbmRpbmcucmVzb2x2ZShkYXRhIGFzIFJwY1Jlc3BvbnNlKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBPdGhlcndpc2UgaXQncyBhbiBldmVudCBcdTIwMTQgZGlzcGF0Y2ggdG8gbGlzdGVuZXJzXG5cdFx0XHRmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIHRoaXMuZXZlbnRMaXN0ZW5lcnMpIHtcblx0XHRcdFx0bGlzdGVuZXIoZGF0YSBhcyBTZGtBZ2VudEV2ZW50KTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIElnbm9yZSBub24tSlNPTiBsaW5lc1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgc2VuZChjb21tYW5kOiBScGNDb21tYW5kQm9keSk6IFByb21pc2U8UnBjUmVzcG9uc2U+IHtcblx0XHRpZiAoIXRoaXMucHJvY2Vzcz8uc3RkaW4pIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIkNsaWVudCBub3Qgc3RhcnRlZFwiKTtcblx0XHR9XG5cblx0XHRjb25zdCBpZCA9IGByZXFfJHsrK3RoaXMucmVxdWVzdElkfWA7XG5cdFx0Y29uc3QgZnVsbENvbW1hbmQgPSB7IC4uLmNvbW1hbmQsIGlkIH0gYXMgUnBjQ29tbWFuZDtcblxuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdHRoaXMucGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShpZCk7XG5cdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoYFRpbWVvdXQgd2FpdGluZyBmb3IgcmVzcG9uc2UgdG8gJHtjb21tYW5kLnR5cGV9LiBTdGRlcnI6ICR7dGhpcy5zdGRlcnJ9YCkpO1xuXHRcdFx0fSwgMzAwMDApO1xuXG5cdFx0XHR0aGlzLnBlbmRpbmdSZXF1ZXN0cy5zZXQoaWQsIHtcblx0XHRcdFx0cmVzb2x2ZTogKHJlc3BvbnNlKSA9PiB7XG5cdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuXHRcdFx0XHRcdHJlc29sdmUocmVzcG9uc2UpO1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRyZWplY3Q6IChlcnJvcikgPT4ge1xuXHRcdFx0XHRcdGNsZWFyVGltZW91dCh0aW1lb3V0KTtcblx0XHRcdFx0XHRyZWplY3QoZXJyb3IpO1xuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cblx0XHRcdHRoaXMucHJvY2VzcyEuc3RkaW4hLndyaXRlKHNlcmlhbGl6ZUpzb25MaW5lKGZ1bGxDb21tYW5kKSk7XG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGdldERhdGE8VD4ocmVzcG9uc2U6IFJwY1Jlc3BvbnNlKTogVCB7XG5cdFx0aWYgKCFyZXNwb25zZS5zdWNjZXNzKSB7XG5cdFx0XHRjb25zdCBlcnJvclJlc3BvbnNlID0gcmVzcG9uc2UgYXMgRXh0cmFjdDxScGNSZXNwb25zZSwgeyBzdWNjZXNzOiBmYWxzZSB9Pjtcblx0XHRcdHRocm93IG5ldyBFcnJvcihlcnJvclJlc3BvbnNlLmVycm9yKTtcblx0XHR9XG5cdFx0Ly8gVHlwZSBhc3NlcnRpb246IHdlIHRydXN0IHJlc3BvbnNlLmRhdGEgbWF0Y2hlcyBUIGJhc2VkIG9uIHRoZSBjb21tYW5kIHNlbnQuXG5cdFx0Y29uc3Qgc3VjY2Vzc1Jlc3BvbnNlID0gcmVzcG9uc2UgYXMgRXh0cmFjdDxScGNSZXNwb25zZSwgeyBzdWNjZXNzOiB0cnVlOyBkYXRhOiB1bmtub3duIH0+O1xuXHRcdHJldHVybiBzdWNjZXNzUmVzcG9uc2UuZGF0YSBhcyBUO1xuXHR9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUE0QixhQUFhO0FBQ3pDLFNBQVMsdUJBQXVCLHlCQUF5QjtBQWlEbEQsTUFBTSxVQUFVO0FBQUEsRUFXdEIsWUFBb0IsVUFBNEIsQ0FBQyxHQUFHO0FBQWhDO0FBQUEsRUFBaUM7QUFBQSxFQVY3QyxVQUErQjtBQUFBLEVBQy9CLG9CQUF5QztBQUFBLEVBQ3pDO0FBQUEsRUFDQSxpQkFBcUMsQ0FBQztBQUFBLEVBQ3RDLGtCQUNQLG9CQUFJLElBQUk7QUFBQSxFQUNELFlBQVk7QUFBQSxFQUNaLFNBQVM7QUFBQSxFQUNULFdBQVc7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU9uQixNQUFNLFFBQXVCO0FBQzVCLFFBQUksS0FBSyxTQUFTO0FBQ2pCLFlBQU0sSUFBSSxNQUFNLHdCQUF3QjtBQUFBLElBQ3pDO0FBRUEsU0FBSyxXQUFXO0FBRWhCLFVBQU0sVUFBVSxLQUFLLFFBQVEsV0FBVztBQUN4QyxVQUFNLE9BQU8sQ0FBQyxVQUFVLEtBQUs7QUFFN0IsUUFBSSxLQUFLLFFBQVEsVUFBVTtBQUMxQixXQUFLLEtBQUssY0FBYyxLQUFLLFFBQVEsUUFBUTtBQUFB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
