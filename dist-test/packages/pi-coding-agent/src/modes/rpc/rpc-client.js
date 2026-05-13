import { spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
class RpcClient {
  constructor(options = {}) {
    this.options = options;
    this.process = null;
    this.stopReadingStdout = null;
    this.eventListeners = [];
    this.pendingRequests = /* @__PURE__ */ new Map();
    this.requestId = 0;
    this.stderr = "";
  }
  /**
   * Start the RPC agent process.
   */
  async start() {
    if (this.process) {
      throw new Error("Client already started");
    }
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
   * Subscribe to agent events.
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
   * Returns immediately after sending; use onEvent() to receive streaming events.
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9ycGMvcnBjLWNsaWVudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSUEMgQ2xpZW50IGZvciBwcm9ncmFtbWF0aWMgYWNjZXNzIHRvIHRoZSBjb2RpbmcgYWdlbnQuXG4gKlxuICogU3Bhd25zIHRoZSBhZ2VudCBpbiBSUEMgbW9kZSBhbmQgcHJvdmlkZXMgYSB0eXBlZCBBUEkgZm9yIGFsbCBvcGVyYXRpb25zLlxuICovXG5cbmltcG9ydCB7IHR5cGUgQ2hpbGRQcm9jZXNzLCBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB0eXBlIHsgQWdlbnRFdmVudCwgQWdlbnRNZXNzYWdlLCBUaGlua2luZ0xldmVsIH0gZnJvbSBcIkBnc2QvcGktYWdlbnQtY29yZVwiO1xuaW1wb3J0IHR5cGUgeyBJbWFnZUNvbnRlbnQgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHR5cGUgeyBTZXNzaW9uU3RhdHMgfSBmcm9tIFwiLi4vLi4vY29yZS9hZ2VudC1zZXNzaW9uLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEJhc2hSZXN1bHQgfSBmcm9tIFwiLi4vLi4vY29yZS9iYXNoLWV4ZWN1dG9yLmpzXCI7XG5pbXBvcnQgdHlwZSB7IENvbXBhY3Rpb25SZXN1bHQgfSBmcm9tIFwiLi4vLi4vY29yZS9jb21wYWN0aW9uL2luZGV4LmpzXCI7XG5pbXBvcnQgeyBhdHRhY2hKc29ubExpbmVSZWFkZXIsIHNlcmlhbGl6ZUpzb25MaW5lIH0gZnJvbSBcIi4vanNvbmwuanNcIjtcbmltcG9ydCB0eXBlIHsgUnBjQ29tbWFuZCwgUnBjSW5pdFJlc3VsdCwgUnBjUmVzcG9uc2UsIFJwY1Nlc3Npb25TdGF0ZSwgUnBjU2xhc2hDb21tYW5kIH0gZnJvbSBcIi4vcnBjLXR5cGVzLmpzXCI7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFR5cGVzXG4vLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbi8qKiBEaXN0cmlidXRpdmUgT21pdCB0aGF0IHdvcmtzIHdpdGggdW5pb24gdHlwZXMgKi9cbnR5cGUgRGlzdHJpYnV0aXZlT21pdDxULCBLIGV4dGVuZHMga2V5b2YgVD4gPSBUIGV4dGVuZHMgdW5rbm93biA/IE9taXQ8VCwgSz4gOiBuZXZlcjtcblxuLyoqIFJwY0NvbW1hbmQgd2l0aG91dCB0aGUgaWQgZmllbGQgKGZvciBpbnRlcm5hbCBzZW5kKSAqL1xudHlwZSBScGNDb21tYW5kQm9keSA9IERpc3RyaWJ1dGl2ZU9taXQ8UnBjQ29tbWFuZCwgXCJpZFwiPjtcblxuZXhwb3J0IGludGVyZmFjZSBScGNDbGllbnRPcHRpb25zIHtcblx0LyoqIFBhdGggdG8gdGhlIENMSSBlbnRyeSBwb2ludCAoZGVmYXVsdDogc2VhcmNoZXMgZm9yIGRpc3QvY2xpLmpzKSAqL1xuXHRjbGlQYXRoPzogc3RyaW5nO1xuXHQvKiogV29ya2luZyBkaXJlY3RvcnkgZm9yIHRoZSBhZ2VudCAqL1xuXHRjd2Q/OiBzdHJpbmc7XG5cdC8qKiBFbnZpcm9ubWVudCB2YXJpYWJsZXMgKi9cblx0ZW52PzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblx0LyoqIFByb3ZpZGVyIHRvIHVzZSAqL1xuXHRwcm92aWRlcj86IHN0cmluZztcblx0LyoqIE1vZGVsIElEIHRvIHVzZSAqL1xuXHRtb2RlbD86IHN0cmluZztcblx0LyoqIEFkZGl0aW9uYWwgQ0xJIGFyZ3VtZW50cyAqL1xuXHRhcmdzPzogc3RyaW5nW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTW9kZWxJbmZvIHtcblx0cHJvdmlkZXI6IHN0cmluZztcblx0aWQ6IHN0cmluZztcblx0Y29udGV4dFdpbmRvdzogbnVtYmVyO1xuXHRyZWFzb25pbmc6IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIFJwY0V2ZW50TGlzdGVuZXIgPSAoZXZlbnQ6IEFnZW50RXZlbnQpID0+IHZvaWQ7XG5cbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cbi8vIFJQQyBDbGllbnRcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuZXhwb3J0IGNsYXNzIFJwY0NsaWVudCB7XG5cdHByaXZhdGUgcHJvY2VzczogQ2hpbGRQcm9jZXNzIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgc3RvcFJlYWRpbmdTdGRvdXQ6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIF9zdGRlcnJIYW5kbGVyPzogKGRhdGE6IEJ1ZmZlcikgPT4gdm9pZDtcblx0cHJpdmF0ZSBldmVudExpc3RlbmVyczogUnBjRXZlbnRMaXN0ZW5lcltdID0gW107XG5cdHByaXZhdGUgcGVuZGluZ1JlcXVlc3RzOiBNYXA8c3RyaW5nLCB7IHJlc29sdmU6IChyZXNwb25zZTogUnBjUmVzcG9uc2UpID0+IHZvaWQ7IHJlamVjdDogKGVycm9yOiBFcnJvcikgPT4gdm9pZCB9PiA9XG5cdFx0bmV3IE1hcCgpO1xuXHRwcml2YXRlIHJlcXVlc3RJZCA9IDA7XG5cdHByaXZhdGUgc3RkZXJyID0gXCJcIjtcblxuXHRjb25zdHJ1Y3Rvcihwcml2YXRlIG9wdGlvbnM6IFJwY0NsaWVudE9wdGlvbnMgPSB7fSkge31cblxuXHQvKipcblx0ICogU3RhcnQgdGhlIFJQQyBhZ2VudCBwcm9jZXNzLlxuXHQgKi9cblx0YXN5bmMgc3RhcnQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMucHJvY2Vzcykge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQ2xpZW50IGFscmVhZHkgc3RhcnRlZFwiKTtcblx0XHR9XG5cblx0XHRjb25zdCBjbGlQYXRoID0gdGhpcy5vcHRpb25zLmNsaVBhdGggPz8gXCJkaXN0L2NsaS5qc1wiO1xuXHRcdGNvbnN0IGFyZ3MgPSBbXCItLW1vZGVcIiwgXCJycGNcIl07XG5cblx0XHRpZiAodGhpcy5vcHRpb25zLnByb3ZpZGVyKSB7XG5cdFx0XHRhcmdzLnB1c2goXCItLXByb3ZpZGVyXCIsIHRoaXMub3B0aW9ucy5wcm92aWRlcik7XG5cdFx0fVxuXHRcdGlmICh0aGlzLm9wdGlvbnMubW9kZWwpIHtcblx0XHRcdGFyZ3MucHVzaChcIi0tbW9kZWxcIiwgdGhpcy5vcHRpb25zLm1vZGVsKTtcblx0XHR9XG5cdFx0aWYgKHRoaXMub3B0aW9ucy5hcmdzKSB7XG5cdFx0XHRhcmdzLnB1c2goLi4udGhpcy5vcHRpb25zLmFyZ3MpO1xuXHRcdH1cblxuXHRcdHRoaXMucHJvY2VzcyA9IHNwYXduKFwibm9kZVwiLCBbY2xpUGF0aCwgLi4uYXJnc10sIHtcblx0XHRcdGN3ZDogdGhpcy5vcHRpb25zLmN3ZCxcblx0XHRcdGVudjogeyAuLi5wcm9jZXNzLmVudiwgLi4udGhpcy5vcHRpb25zLmVudiB9LFxuXHRcdFx0c3RkaW86IFtcInBpcGVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcblx0XHR9KTtcblxuXHRcdC8vIENvbGxlY3Qgc3RkZXJyIGZvciBkZWJ1Z2dpbmdcblx0XHR0aGlzLl9zdGRlcnJIYW5kbGVyID0gKGRhdGE6IEJ1ZmZlcikgPT4ge1xuXHRcdFx0dGhpcy5zdGRlcnIgKz0gZGF0YS50b1N0cmluZygpO1xuXHRcdH07XG5cdFx0dGhpcy5wcm9jZXNzLnN0ZGVycj8ub24oXCJkYXRhXCIsIHRoaXMuX3N0ZGVyckhhbmRsZXIpO1xuXG5cdFx0Ly8gU2V0IHVwIHN0cmljdCBKU09OTCByZWFkZXIgZm9yIHN0ZG91dC5cblx0XHR0aGlzLnN0b3BSZWFkaW5nU3Rkb3V0ID0gYXR0YWNoSnNvbmxMaW5lUmVhZGVyKHRoaXMucHJvY2Vzcy5zdGRvdXQhLCAobGluZSkgPT4ge1xuXHRcdFx0dGhpcy5oYW5kbGVMaW5lKGxpbmUpO1xuXHRcdH0pO1xuXG5cdFx0Ly8gRGV0ZWN0IHVuZXhwZWN0ZWQgc3VicHJvY2VzcyBleGl0IGFuZCByZWplY3QgYWxsIHBlbmRpbmcgcmVxdWVzdHNcblx0XHR0aGlzLnByb2Nlc3Mub24oXCJleGl0XCIsIChjb2RlLCBzaWduYWwpID0+IHtcblx0XHRcdGlmICh0aGlzLnBlbmRpbmdSZXF1ZXN0cy5zaXplID4gMCkge1xuXHRcdFx0XHRjb25zdCByZWFzb24gPSBzaWduYWwgPyBgc2lnbmFsICR7c2lnbmFsfWAgOiBgY29kZSAke2NvZGV9YDtcblx0XHRcdFx0Y29uc3QgZXJyb3IgPSBuZXcgRXJyb3IoYEFnZW50IHByb2Nlc3MgZXhpdGVkIHVuZXhwZWN0ZWRseSAoJHtyZWFzb259KS4gU3RkZXJyOiAke3RoaXMuc3RkZXJyfWApO1xuXHRcdFx0XHRmb3IgKGNvbnN0IFtpZCwgcGVuZGluZ10gb2YgdGhpcy5wZW5kaW5nUmVxdWVzdHMpIHtcblx0XHRcdFx0XHR0aGlzLnBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoaWQpO1xuXHRcdFx0XHRcdHBlbmRpbmcucmVqZWN0KGVycm9yKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0pO1xuXG5cdFx0Ly8gV2FpdCBhIG1vbWVudCBmb3IgcHJvY2VzcyB0byBpbml0aWFsaXplXG5cdFx0YXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMTAwKSk7XG5cblx0XHRpZiAodGhpcy5wcm9jZXNzLmV4aXRDb2RlICE9PSBudWxsKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEFnZW50IHByb2Nlc3MgZXhpdGVkIGltbWVkaWF0ZWx5IHdpdGggY29kZSAke3RoaXMucHJvY2Vzcy5leGl0Q29kZX0uIFN0ZGVycjogJHt0aGlzLnN0ZGVycn1gKTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogU3RvcCB0aGUgUlBDIGFnZW50IHByb2Nlc3MuXG5cdCAqL1xuXHRhc3luYyBzdG9wKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICghdGhpcy5wcm9jZXNzKSByZXR1cm47XG5cblx0XHR0aGlzLnN0b3BSZWFkaW5nU3Rkb3V0Py4oKTtcblx0XHR0aGlzLnN0b3BSZWFkaW5nU3Rkb3V0ID0gbnVsbDtcblx0XHRpZiAodGhpcy5fc3RkZXJySGFuZGxlcikge1xuXHRcdFx0dGhpcy5wcm9jZXNzLnN0ZGVycj8ucmVtb3ZlTGlzdGVuZXIoXCJkYXRhXCIsIHRoaXMuX3N0ZGVyckhhbmRsZXIpO1xuXHRcdFx0dGhpcy5fc3RkZXJySGFuZGxlciA9IHVuZGVmaW5lZDtcblx0XHR9XG5cdFx0dGhpcy5wcm9jZXNzLmtpbGwoXCJTSUdURVJNXCIpO1xuXG5cdFx0Ly8gV2FpdCBmb3IgcHJvY2VzcyB0byBleGl0XG5cdFx0YXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHtcblx0XHRcdGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dGhpcy5wcm9jZXNzPy5raWxsKFwiU0lHS0lMTFwiKTtcblx0XHRcdFx0cmVzb2x2ZSgpO1xuXHRcdFx0fSwgMTAwMCk7XG5cblx0XHRcdHRoaXMucHJvY2Vzcz8ub24oXCJleGl0XCIsICgpID0+IHtcblx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuXHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdHRoaXMucHJvY2VzcyA9IG51bGw7XG5cdFx0dGhpcy5wZW5kaW5nUmVxdWVzdHMuY2xlYXIoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTdWJzY3JpYmUgdG8gYWdlbnQgZXZlbnRzLlxuXHQgKi9cblx0b25FdmVudChsaXN0ZW5lcjogUnBjRXZlbnRMaXN0ZW5lcik6ICgpID0+IHZvaWQge1xuXHRcdHRoaXMuZXZlbnRMaXN0ZW5lcnMucHVzaChsaXN0ZW5lcik7XG5cdFx0cmV0dXJuICgpID0+IHtcblx0XHRcdGNvbnN0IGluZGV4ID0gdGhpcy5ldmVudExpc3RlbmVycy5pbmRleE9mKGxpc3RlbmVyKTtcblx0XHRcdGlmIChpbmRleCAhPT0gLTEpIHtcblx0XHRcdFx0dGhpcy5ldmVudExpc3RlbmVycy5zcGxpY2UoaW5kZXgsIDEpO1xuXHRcdFx0fVxuXHRcdH07XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGNvbGxlY3RlZCBzdGRlcnIgb3V0cHV0ICh1c2VmdWwgZm9yIGRlYnVnZ2luZykuXG5cdCAqL1xuXHRnZXRTdGRlcnIoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gdGhpcy5zdGRlcnI7XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIENvbW1hbmQgTWV0aG9kc1xuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIFNlbmQgYSBwcm9tcHQgdG8gdGhlIGFnZW50LlxuXHQgKiBSZXR1cm5zIGltbWVkaWF0ZWx5IGFmdGVyIHNlbmRpbmc7IHVzZSBvbkV2ZW50KCkgdG8gcmVjZWl2ZSBzdHJlYW1pbmcgZXZlbnRzLlxuXHQgKiBVc2Ugd2FpdEZvcklkbGUoKSB0byB3YWl0IGZvciBjb21wbGV0aW9uLlxuXHQgKi9cblx0YXN5bmMgcHJvbXB0KG1lc3NhZ2U6IHN0cmluZywgaW1hZ2VzPzogSW1hZ2VDb250ZW50W10pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInByb21wdFwiLCBtZXNzYWdlLCBpbWFnZXMgfSk7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYSBzdGVlcmluZyBtZXNzYWdlIHRvIGludGVycnVwdCB0aGUgYWdlbnQgbWlkLXJ1bi5cblx0ICovXG5cdGFzeW5jIHN0ZWVyKG1lc3NhZ2U6IHN0cmluZywgaW1hZ2VzPzogSW1hZ2VDb250ZW50W10pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInN0ZWVyXCIsIG1lc3NhZ2UsIGltYWdlcyB9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBRdWV1ZSBhIGZvbGxvdy11cCBtZXNzYWdlIHRvIGJlIHByb2Nlc3NlZCBhZnRlciB0aGUgYWdlbnQgZmluaXNoZXMuXG5cdCAqL1xuXHRhc3luYyBmb2xsb3dVcChtZXNzYWdlOiBzdHJpbmcsIGltYWdlcz86IEltYWdlQ29udGVudFtdKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJmb2xsb3dfdXBcIiwgbWVzc2FnZSwgaW1hZ2VzIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIEFib3J0IGN1cnJlbnQgb3BlcmF0aW9uLlxuXHQgKi9cblx0YXN5bmMgYWJvcnQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJhYm9ydFwiIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIFN0YXJ0IGEgbmV3IHNlc3Npb24sIG9wdGlvbmFsbHkgd2l0aCBwYXJlbnQgdHJhY2tpbmcuXG5cdCAqIEBwYXJhbSBwYXJlbnRTZXNzaW9uIC0gT3B0aW9uYWwgcGFyZW50IHNlc3Npb24gcGF0aCBmb3IgbGluZWFnZSB0cmFja2luZ1xuXHQgKiBAcmV0dXJucyBPYmplY3Qgd2l0aCBgY2FuY2VsbGVkOiB0cnVlYCBpZiBhbiBleHRlbnNpb24gY2FuY2VsbGVkIHRoZSBuZXcgc2Vzc2lvblxuXHQgKi9cblx0YXN5bmMgbmV3U2Vzc2lvbihwYXJlbnRTZXNzaW9uPzogc3RyaW5nKTogUHJvbWlzZTx7IGNhbmNlbGxlZDogYm9vbGVhbiB9PiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcIm5ld19zZXNzaW9uXCIsIHBhcmVudFNlc3Npb24gfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YShyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGN1cnJlbnQgc2Vzc2lvbiBzdGF0ZS5cblx0ICovXG5cdGFzeW5jIGdldFN0YXRlKCk6IFByb21pc2U8UnBjU2Vzc2lvblN0YXRlPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9zdGF0ZVwiIH0pO1xuXHRcdHJldHVybiB0aGlzLmdldERhdGEocmVzcG9uc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldCBtb2RlbCBieSBwcm92aWRlciBhbmQgSUQuXG5cdCAqL1xuXHRhc3luYyBzZXRNb2RlbChwcm92aWRlcjogc3RyaW5nLCBtb2RlbElkOiBzdHJpbmcpOiBQcm9taXNlPHsgcHJvdmlkZXI6IHN0cmluZzsgaWQ6IHN0cmluZyB9PiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInNldF9tb2RlbFwiLCBwcm92aWRlciwgbW9kZWxJZCB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDeWNsZSB0byBuZXh0IG1vZGVsLlxuXHQgKi9cblx0YXN5bmMgY3ljbGVNb2RlbCgpOiBQcm9taXNlPHtcblx0XHRtb2RlbDogeyBwcm92aWRlcjogc3RyaW5nOyBpZDogc3RyaW5nIH07XG5cdFx0dGhpbmtpbmdMZXZlbDogVGhpbmtpbmdMZXZlbDtcblx0XHRpc1Njb3BlZDogYm9vbGVhbjtcblx0fSB8IG51bGw+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiY3ljbGVfbW9kZWxcIiB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgbGlzdCBvZiBhdmFpbGFibGUgbW9kZWxzLlxuXHQgKi9cblx0YXN5bmMgZ2V0QXZhaWxhYmxlTW9kZWxzKCk6IFByb21pc2U8TW9kZWxJbmZvW10+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZ2V0X2F2YWlsYWJsZV9tb2RlbHNcIiB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhPHsgbW9kZWxzOiBNb2RlbEluZm9bXSB9PihyZXNwb25zZSkubW9kZWxzO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNldCB0aGlua2luZyBsZXZlbC5cblx0ICovXG5cdGFzeW5jIHNldFRoaW5raW5nTGV2ZWwobGV2ZWw6IFRoaW5raW5nTGV2ZWwpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInNldF90aGlua2luZ19sZXZlbFwiLCBsZXZlbCB9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDeWNsZSB0aGlua2luZyBsZXZlbC5cblx0ICovXG5cdGFzeW5jIGN5Y2xlVGhpbmtpbmdMZXZlbCgpOiBQcm9taXNlPHsgbGV2ZWw6IFRoaW5raW5nTGV2ZWwgfSB8IG51bGw+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiY3ljbGVfdGhpbmtpbmdfbGV2ZWxcIiB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgc3RlZXJpbmcgbW9kZS5cblx0ICovXG5cdGFzeW5jIHNldFN0ZWVyaW5nTW9kZShtb2RlOiBcImFsbFwiIHwgXCJvbmUtYXQtYS10aW1lXCIpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInNldF9zdGVlcmluZ19tb2RlXCIsIG1vZGUgfSk7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGZvbGxvdy11cCBtb2RlLlxuXHQgKi9cblx0YXN5bmMgc2V0Rm9sbG93VXBNb2RlKG1vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwic2V0X2ZvbGxvd191cF9tb2RlXCIsIG1vZGUgfSk7XG5cdH1cblxuXHQvKipcblx0ICogQ29tcGFjdCBzZXNzaW9uIGNvbnRleHQuXG5cdCAqL1xuXHRhc3luYyBjb21wYWN0KGN1c3RvbUluc3RydWN0aW9ucz86IHN0cmluZyk6IFByb21pc2U8Q29tcGFjdGlvblJlc3VsdD4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJjb21wYWN0XCIsIGN1c3RvbUluc3RydWN0aW9ucyB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgYXV0by1jb21wYWN0aW9uIGVuYWJsZWQvZGlzYWJsZWQuXG5cdCAqL1xuXHRhc3luYyBzZXRBdXRvQ29tcGFjdGlvbihlbmFibGVkOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzZXRfYXV0b19jb21wYWN0aW9uXCIsIGVuYWJsZWQgfSk7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGF1dG8tcmV0cnkgZW5hYmxlZC9kaXNhYmxlZC5cblx0ICovXG5cdGFzeW5jIHNldEF1dG9SZXRyeShlbmFibGVkOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzZXRfYXV0b19yZXRyeVwiLCBlbmFibGVkIH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIEFib3J0IGluLXByb2dyZXNzIHJldHJ5LlxuXHQgKi9cblx0YXN5bmMgYWJvcnRSZXRyeSgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImFib3J0X3JldHJ5XCIgfSk7XG5cdH1cblxuXHQvKipcblx0ICogRXhlY3V0ZSBhIGJhc2ggY29tbWFuZC5cblx0ICovXG5cdGFzeW5jIGJhc2goY29tbWFuZDogc3RyaW5nKTogUHJvbWlzZTxCYXNoUmVzdWx0PiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImJhc2hcIiwgY29tbWFuZCB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBBYm9ydCBydW5uaW5nIGJhc2ggY29tbWFuZC5cblx0ICovXG5cdGFzeW5jIGFib3J0QmFzaCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImFib3J0X2Jhc2hcIiB9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgc2Vzc2lvbiBzdGF0aXN0aWNzLlxuXHQgKi9cblx0YXN5bmMgZ2V0U2Vzc2lvblN0YXRzKCk6IFByb21pc2U8U2Vzc2lvblN0YXRzPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9zZXNzaW9uX3N0YXRzXCIgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YShyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogRXhwb3J0IHNlc3Npb24gdG8gSFRNTC5cblx0ICovXG5cdGFzeW5jIGV4cG9ydEh0bWwob3V0cHV0UGF0aD86IHN0cmluZyk6IFByb21pc2U8eyBwYXRoOiBzdHJpbmcgfT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJleHBvcnRfaHRtbFwiLCBvdXRwdXRQYXRoIH0pO1xuXHRcdHJldHVybiB0aGlzLmdldERhdGEocmVzcG9uc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFN3aXRjaCB0byBhIGRpZmZlcmVudCBzZXNzaW9uIGZpbGUuXG5cdCAqIEByZXR1cm5zIE9iamVjdCB3aXRoIGBjYW5jZWxsZWQ6IHRydWVgIGlmIGFuIGV4dGVuc2lvbiBjYW5jZWxsZWQgdGhlIHN3aXRjaFxuXHQgKi9cblx0YXN5bmMgc3dpdGNoU2Vzc2lvbihzZXNzaW9uUGF0aDogc3RyaW5nKTogUHJvbWlzZTx7IGNhbmNlbGxlZDogYm9vbGVhbiB9PiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInN3aXRjaF9zZXNzaW9uXCIsIHNlc3Npb25QYXRoIH0pO1xuXHRcdHJldHVybiB0aGlzLmdldERhdGEocmVzcG9uc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEZvcmsgZnJvbSBhIHNwZWNpZmljIG1lc3NhZ2UuXG5cdCAqIEByZXR1cm5zIE9iamVjdCB3aXRoIGB0ZXh0YCAodGhlIG1lc3NhZ2UgdGV4dCkgYW5kIGBjYW5jZWxsZWRgIChpZiBleHRlbnNpb24gY2FuY2VsbGVkKVxuXHQgKi9cblx0YXN5bmMgZm9yayhlbnRyeUlkOiBzdHJpbmcpOiBQcm9taXNlPHsgdGV4dDogc3RyaW5nOyBjYW5jZWxsZWQ6IGJvb2xlYW4gfT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJmb3JrXCIsIGVudHJ5SWQgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YShyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IG1lc3NhZ2VzIGF2YWlsYWJsZSBmb3IgZm9ya2luZy5cblx0ICovXG5cdGFzeW5jIGdldEZvcmtNZXNzYWdlcygpOiBQcm9taXNlPEFycmF5PHsgZW50cnlJZDogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfT4+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZ2V0X2ZvcmtfbWVzc2FnZXNcIiB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhPHsgbWVzc2FnZXM6IEFycmF5PHsgZW50cnlJZDogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfT4gfT4ocmVzcG9uc2UpLm1lc3NhZ2VzO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB0ZXh0IG9mIGxhc3QgYXNzaXN0YW50IG1lc3NhZ2UuXG5cdCAqL1xuXHRhc3luYyBnZXRMYXN0QXNzaXN0YW50VGV4dCgpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZ2V0X2xhc3RfYXNzaXN0YW50X3RleHRcIiB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhPHsgdGV4dDogc3RyaW5nIHwgbnVsbCB9PihyZXNwb25zZSkudGV4dDtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgdGhlIHNlc3Npb24gZGlzcGxheSBuYW1lLlxuXHQgKi9cblx0YXN5bmMgc2V0U2Vzc2lvbk5hbWUobmFtZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzZXRfc2Vzc2lvbl9uYW1lXCIsIG5hbWUgfSk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGFsbCBtZXNzYWdlcyBpbiB0aGUgc2Vzc2lvbi5cblx0ICovXG5cdGFzeW5jIGdldE1lc3NhZ2VzKCk6IFByb21pc2U8QWdlbnRNZXNzYWdlW10+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZ2V0X21lc3NhZ2VzXCIgfSk7XG5cdFx0cmV0dXJuIHRoaXMuZ2V0RGF0YTx7IG1lc3NhZ2VzOiBBZ2VudE1lc3NhZ2VbXSB9PihyZXNwb25zZSkubWVzc2FnZXM7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGF2YWlsYWJsZSBjb21tYW5kcyAoZXh0ZW5zaW9uIGNvbW1hbmRzLCBwcm9tcHQgdGVtcGxhdGVzLCBza2lsbHMpLlxuXHQgKi9cblx0YXN5bmMgZ2V0Q29tbWFuZHMoKTogUHJvbWlzZTxScGNTbGFzaENvbW1hbmRbXT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJnZXRfY29tbWFuZHNcIiB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhPHsgY29tbWFuZHM6IFJwY1NsYXNoQ29tbWFuZFtdIH0+KHJlc3BvbnNlKS5jb21tYW5kcztcblx0fVxuXG5cdC8qKlxuXHQgKiBTZW5kIGEgVUkgcmVzcG9uc2UgdG8gYSBwZW5kaW5nIGV4dGVuc2lvbl91aV9yZXF1ZXN0LlxuXHQgKiBGaXJlLWFuZC1mb3JnZXQgXHUyMDE0IG5vIHJlcXVlc3QvcmVzcG9uc2UgY29ycmVsYXRpb24uXG5cdCAqL1xuXHRzZW5kVUlSZXNwb25zZShpZDogc3RyaW5nLCByZXNwb25zZTogeyB2YWx1ZT86IHN0cmluZzsgdmFsdWVzPzogc3RyaW5nW107IGNvbmZpcm1lZD86IGJvb2xlYW47IGNhbmNlbGxlZD86IGJvb2xlYW4gfSk6IHZvaWQge1xuXHRcdGlmICghdGhpcy5wcm9jZXNzPy5zdGRpbikge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQ2xpZW50IG5vdCBzdGFydGVkXCIpO1xuXHRcdH1cblx0XHR0aGlzLnByb2Nlc3Muc3RkaW4ud3JpdGUoc2VyaWFsaXplSnNvbkxpbmUoe1xuXHRcdFx0dHlwZTogXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIixcblx0XHRcdGlkLFxuXHRcdFx0Li4ucmVzcG9uc2UsXG5cdFx0fSkpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEluaXRpYWxpemUgYSB2MiBwcm90b2NvbCBzZXNzaW9uLiBNdXN0IGJlIHNlbnQgYXMgdGhlIGZpcnN0IGNvbW1hbmQuXG5cdCAqIFJldHVybnMgdGhlIG5lZ290aWF0ZWQgcHJvdG9jb2wgdmVyc2lvbiwgc2Vzc2lvbiBJRCwgYW5kIHNlcnZlciBjYXBhYmlsaXRpZXMuXG5cdCAqL1xuXHRhc3luYyBpbml0KG9wdGlvbnM/OiB7IGNsaWVudElkPzogc3RyaW5nIH0pOiBQcm9taXNlPFJwY0luaXRSZXN1bHQ+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiaW5pdFwiLCBwcm90b2NvbFZlcnNpb246IDIsIGNsaWVudElkOiBvcHRpb25zPy5jbGllbnRJZCB9KTtcblx0XHRyZXR1cm4gdGhpcy5nZXREYXRhPFJwY0luaXRSZXN1bHQ+KHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBSZXF1ZXN0IGEgZ3JhY2VmdWwgc2h1dGRvd24gb2YgdGhlIGFnZW50IHByb2Nlc3MuXG5cdCAqIFdhaXRzIGZvciB0aGUgcmVzcG9uc2UgYmVmb3JlIHRoZSBwcm9jZXNzIGV4aXRzLlxuXHQgKi9cblx0YXN5bmMgc2h1dGRvd24oKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzaHV0ZG93blwiIH0pO1xuXHRcdC8vIFdhaXQgZm9yIHByb2Nlc3MgdG8gZXhpdCBhZnRlciBzaHV0ZG93biBhY2tub3dsZWRnbWVudFxuXHRcdGlmICh0aGlzLnByb2Nlc3MpIHtcblx0XHRcdGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHR0aGlzLnByb2Nlc3M/LmtpbGwoXCJTSUdLSUxMXCIpO1xuXHRcdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdFx0fSwgNTAwMCk7XG5cdFx0XHRcdHRoaXMucHJvY2Vzcz8ub24oXCJleGl0XCIsICgpID0+IHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQodGltZW91dCk7XG5cdFx0XHRcdFx0cmVzb2x2ZSgpO1xuXHRcdFx0XHR9KTtcblx0XHRcdH0pO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBTdWJzY3JpYmUgdG8gc3BlY2lmaWMgZXZlbnQgdHlwZXMgKHYyIG9ubHkpLlxuXHQgKiBQYXNzIFtcIipcIl0gdG8gcmVjZWl2ZSBhbGwgZXZlbnRzLCBvciBhIGxpc3Qgb2YgZXZlbnQgdHlwZSBzdHJpbmdzIHRvIGZpbHRlci5cblx0ICovXG5cdGFzeW5jIHN1YnNjcmliZShldmVudHM6IHN0cmluZ1tdKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzdWJzY3JpYmVcIiwgZXZlbnRzIH0pO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBIZWxwZXJzXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHQvKipcblx0ICogV2FpdCBmb3IgYWdlbnQgdG8gYmVjb21lIGlkbGUgKG5vIHN0cmVhbWluZykuXG5cdCAqIFJlc29sdmVzIHdoZW4gYWdlbnRfZW5kIGV2ZW50IGlzIHJlY2VpdmVkLlxuXHQgKi9cblx0d2FpdEZvcklkbGUodGltZW91dCA9IDYwMDAwKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdHVuc3Vic2NyaWJlKCk7XG5cdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoYFRpbWVvdXQgd2FpdGluZyBmb3IgYWdlbnQgdG8gYmVjb21lIGlkbGUuIFN0ZGVycjogJHt0aGlzLnN0ZGVycn1gKSk7XG5cdFx0XHR9LCB0aW1lb3V0KTtcblxuXHRcdFx0Y29uc3QgdW5zdWJzY3JpYmUgPSB0aGlzLm9uRXZlbnQoKGV2ZW50KSA9PiB7XG5cdFx0XHRcdGlmIChldmVudC50eXBlID09PSBcImFnZW50X2VuZFwiKSB7XG5cdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVyKTtcblx0XHRcdFx0XHR1bnN1YnNjcmliZSgpO1xuXHRcdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSk7XG5cdFx0fSk7XG5cdH1cblxuXHQvKipcblx0ICogQ29sbGVjdCBldmVudHMgdW50aWwgYWdlbnQgYmVjb21lcyBpZGxlLlxuXHQgKi9cblx0Y29sbGVjdEV2ZW50cyh0aW1lb3V0ID0gNjAwMDApOiBQcm9taXNlPEFnZW50RXZlbnRbXT4ge1xuXHRcdHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRjb25zdCBldmVudHM6IEFnZW50RXZlbnRbXSA9IFtdO1xuXHRcdFx0Y29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dW5zdWJzY3JpYmUoKTtcblx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihgVGltZW91dCBjb2xsZWN0aW5nIGV2ZW50cy4gU3RkZXJyOiAke3RoaXMuc3RkZXJyfWApKTtcblx0XHRcdH0sIHRpbWVvdXQpO1xuXG5cdFx0XHRjb25zdCB1bnN1YnNjcmliZSA9IHRoaXMub25FdmVudCgoZXZlbnQpID0+IHtcblx0XHRcdFx0ZXZlbnRzLnB1c2goZXZlbnQpO1xuXHRcdFx0XHRpZiAoZXZlbnQudHlwZSA9PT0gXCJhZ2VudF9lbmRcIikge1xuXHRcdFx0XHRcdGNsZWFyVGltZW91dCh0aW1lcik7XG5cdFx0XHRcdFx0dW5zdWJzY3JpYmUoKTtcblx0XHRcdFx0XHRyZXNvbHZlKGV2ZW50cyk7XG5cdFx0XHRcdH1cblx0XHRcdH0pO1xuXHRcdH0pO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNlbmQgcHJvbXB0IGFuZCB3YWl0IGZvciBjb21wbGV0aW9uLCByZXR1cm5pbmcgYWxsIGV2ZW50cy5cblx0ICovXG5cdGFzeW5jIHByb21wdEFuZFdhaXQobWVzc2FnZTogc3RyaW5nLCBpbWFnZXM/OiBJbWFnZUNvbnRlbnRbXSwgdGltZW91dCA9IDYwMDAwKTogUHJvbWlzZTxBZ2VudEV2ZW50W10+IHtcblx0XHRjb25zdCBldmVudHNQcm9taXNlID0gdGhpcy5jb2xsZWN0RXZlbnRzKHRpbWVvdXQpO1xuXHRcdGF3YWl0IHRoaXMucHJvbXB0KG1lc3NhZ2UsIGltYWdlcyk7XG5cdFx0cmV0dXJuIGV2ZW50c1Byb21pc2U7XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIEludGVybmFsXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHRwcml2YXRlIGhhbmRsZUxpbmUobGluZTogc3RyaW5nKTogdm9pZCB7XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKGxpbmUpO1xuXG5cdFx0XHQvLyBDaGVjayBpZiBpdCdzIGEgcmVzcG9uc2UgdG8gYSBwZW5kaW5nIHJlcXVlc3Rcblx0XHRcdGlmIChkYXRhLnR5cGUgPT09IFwicmVzcG9uc2VcIiAmJiBkYXRhLmlkICYmIHRoaXMucGVuZGluZ1JlcXVlc3RzLmhhcyhkYXRhLmlkKSkge1xuXHRcdFx0XHRjb25zdCBwZW5kaW5nID0gdGhpcy5wZW5kaW5nUmVxdWVzdHMuZ2V0KGRhdGEuaWQpITtcblx0XHRcdFx0dGhpcy5wZW5kaW5nUmVxdWVzdHMuZGVsZXRlKGRhdGEuaWQpO1xuXHRcdFx0XHRwZW5kaW5nLnJlc29sdmUoZGF0YSBhcyBScGNSZXNwb25zZSk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblxuXHRcdFx0Ly8gT3RoZXJ3aXNlIGl0J3MgYW4gZXZlbnRcblx0XHRcdGZvciAoY29uc3QgbGlzdGVuZXIgb2YgdGhpcy5ldmVudExpc3RlbmVycykge1xuXHRcdFx0XHRsaXN0ZW5lcihkYXRhIGFzIEFnZW50RXZlbnQpO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gSWdub3JlIG5vbi1KU09OIGxpbmVzXG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBzZW5kKGNvbW1hbmQ6IFJwY0NvbW1hbmRCb2R5KTogUHJvbWlzZTxScGNSZXNwb25zZT4ge1xuXHRcdGlmICghdGhpcy5wcm9jZXNzPy5zdGRpbikge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKFwiQ2xpZW50IG5vdCBzdGFydGVkXCIpO1xuXHRcdH1cblxuXHRcdGNvbnN0IGlkID0gYHJlcV8keysrdGhpcy5yZXF1ZXN0SWR9YDtcblx0XHRjb25zdCBmdWxsQ29tbWFuZCA9IHsgLi4uY29tbWFuZCwgaWQgfSBhcyBScGNDb21tYW5kO1xuXG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dGhpcy5wZW5kaW5nUmVxdWVzdHMuZGVsZXRlKGlkKTtcblx0XHRcdFx0cmVqZWN0KG5ldyBFcnJvcihgVGltZW91dCB3YWl0aW5nIGZvciByZXNwb25zZSB0byAke2NvbW1hbmQudHlwZX0uIFN0ZGVycjogJHt0aGlzLnN0ZGVycn1gKSk7XG5cdFx0XHR9LCAzMDAwMCk7XG5cblx0XHRcdHRoaXMucGVuZGluZ1JlcXVlc3RzLnNldChpZCwge1xuXHRcdFx0XHRyZXNvbHZlOiAocmVzcG9uc2UpID0+IHtcblx0XHRcdFx0XHRjbGVhclRpbWVvdXQodGltZW91dCk7XG5cdFx0XHRcdFx0cmVzb2x2ZShyZXNwb25zZSk7XG5cdFx0XHRcdH0sXG5cdFx0XHRcdHJlamVjdDogKGVycm9yKSA9PiB7XG5cdFx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuXHRcdFx0XHRcdHJlamVjdChlcnJvcik7XG5cdFx0XHRcdH0sXG5cdFx0XHR9KTtcblxuXHRcdFx0dGhpcy5wcm9jZXNzIS5zdGRpbiEud3JpdGUoc2VyaWFsaXplSnNvbkxpbmUoZnVsbENvbW1hbmQpKTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgZ2V0RGF0YTxUPihyZXNwb25zZTogUnBjUmVzcG9uc2UpOiBUIHtcblx0XHRpZiAoIXJlc3BvbnNlLnN1Y2Nlc3MpIHtcblx0XHRcdGNvbnN0IGVycm9yUmVzcG9uc2UgPSByZXNwb25zZSBhcyBFeHRyYWN0PFJwY1Jlc3BvbnNlLCB7IHN1Y2Nlc3M6IGZhbHNlIH0+O1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGVycm9yUmVzcG9uc2UuZXJyb3IpO1xuXHRcdH1cblx0XHQvLyBUeXBlIGFzc2VydGlvbjogd2UgdHJ1c3QgcmVzcG9uc2UuZGF0YSBtYXRjaGVzIFQgYmFzZWQgb24gdGhlIGNvbW1hbmQgc2VudC5cblx0XHQvLyBUaGlzIGlzIHNhZmUgYmVjYXVzZSBlYWNoIHB1YmxpYyBtZXRob2Qgc3BlY2lmaWVzIHRoZSBjb3JyZWN0IFQgZm9yIGl0cyBjb21tYW5kLlxuXHRcdGNvbnN0IHN1Y2Nlc3NSZXNwb25zZSA9IHJlc3BvbnNlIGFzIEV4dHJhY3Q8UnBjUmVzcG9uc2UsIHsgc3VjY2VzczogdHJ1ZTsgZGF0YTogdW5rbm93biB9Pjtcblx0XHRyZXR1cm4gc3VjY2Vzc1Jlc3BvbnNlLmRhdGEgYXMgVDtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBTUEsU0FBNEIsYUFBYTtBQU16QyxTQUFTLHVCQUF1Qix5QkFBeUI7QUF5Q2xELE1BQU0sVUFBVTtBQUFBLEVBVXRCLFlBQW9CLFVBQTRCLENBQUMsR0FBRztBQUFoQztBQVRwQixTQUFRLFVBQStCO0FBQ3ZDLFNBQVEsb0JBQXlDO0FBRWpELFNBQVEsaUJBQXFDLENBQUM7QUFDOUMsU0FBUSxrQkFDUCxvQkFBSSxJQUFJO0FBQ1QsU0FBUSxZQUFZO0FBQ3BCLFNBQVEsU0FBUztBQUFBLEVBRW9DO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFLckQsTUFBTSxRQUF1QjtBQUM1QixRQUFJLEtBQUssU0FBUztBQUNqQixZQUFNLElBQUksTUFBTSx3QkFBd0I7QUFBQSxJQUN6QztBQUVBLFVBQU0sVUFBVSxLQUFLLFFBQVEsV0FBVztBQUN4QyxVQUFNLE9BQU8sQ0FBQyxVQUFVLEtBQUs7QUFFN0IsUUFBSSxLQUFLLFFBQVEsVUFBVTtBQUMxQixXQUFLLEtBQUssY0FBYyxLQUFLLFFBQVEsUUFBUTtBQUFBLElBQzlDO0FBQ0EsUUFBSSxLQUFLLFFBQVEsT0FBTztBQUN2QixXQUFLLEtBQUssV0FBVyxLQUFLLFFBQVEsS0FBSztBQUFBLElBQ3hDO0FBQ0EsUUFBSSxLQUFLLFFBQVEsTUFBTTtBQUN0QixXQUFLLEtBQUssR0FBRyxLQUFLLFFBQVEsSUFBSTtBQUFBLElBQy9CO0FBRUEs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
