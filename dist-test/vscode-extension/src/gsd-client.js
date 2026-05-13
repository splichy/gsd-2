import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { buildGsdClientSpawnPlan } from "./gsd-client-spawn.js";
class GsdClient {
  constructor(binaryPath, cwd) {
    this.binaryPath = binaryPath;
    this.cwd = cwd;
    this.disposables.push(this._onEvent, this._onConnectionChange, this._onError);
  }
  process = null;
  pendingRequests = /* @__PURE__ */ new Map();
  requestId = 0;
  buffer = "";
  restartCount = 0;
  restartTimestamps = [];
  _autoRetryEnabled = false;
  _onEvent = new vscode.EventEmitter();
  onEvent = this._onEvent.event;
  _onConnectionChange = new vscode.EventEmitter();
  onConnectionChange = this._onConnectionChange.event;
  _onError = new vscode.EventEmitter();
  onError = this._onError.event;
  disposables = [];
  get isConnected() {
    return this.process !== null && this.process.exitCode === null;
  }
  get autoRetryEnabled() {
    return this._autoRetryEnabled;
  }
  /**
   * Spawn the GSD agent in RPC mode.
   */
  async start() {
    if (this.process) {
      return;
    }
    const spawnPlan = buildGsdClientSpawnPlan(this.binaryPath, this.cwd);
    const proc = spawn(spawnPlan.command, spawnPlan.args, spawnPlan.options);
    this.process = proc;
    this.buffer = "";
    proc.stdout?.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this.drainBuffer();
    });
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this._onError.fire(text);
      }
    });
    let startupSettled = false;
    const startupResult = new Promise((resolve, reject) => {
      const cleanup = () => {
        proc.off("spawn", handleSpawn);
        proc.off("error", handleStartupError);
      };
      const handleSpawn = () => {
        if (startupSettled) return;
        startupSettled = true;
        cleanup();
        this._onConnectionChange.fire(true);
        this.restartCount = 0;
        resolve();
      };
      const handleStartupError = (err) => {
        if (startupSettled) return;
        startupSettled = true;
        cleanup();
        if (this.process === proc) {
          this.process = null;
        }
        const hint = err.code === "ENOENT" ? ` Make sure GSD is installed ("npm install -g gsd-pi") and set "gsd.binaryPath" to the absolute path if it is not on PATH.` : "";
        const message = `Failed to start GSD process: ${err.message}.${hint}`;
        this._onError.fire(message);
        reject(new Error(message));
      };
      proc.once("spawn", handleSpawn);
      proc.once("error", handleStartupError);
    });
    proc.on("error", (err) => {
      if (!startupSettled) {
        return;
      }
      if (this.process === proc) {
        this.process = null;
      }
      this._onConnectionChange.fire(false);
      const hint = err.code === "ENOENT" ? ` Make sure GSD is installed ("npm install -g gsd-pi") and set "gsd.binaryPath" to the absolute path if it is not on PATH.` : "";
      this._onError.fire(`GSD process error: ${err.message}.${hint}`);
    });
    proc.on("exit", (code, signal) => {
      if (this.process === proc) {
        this.process = null;
      }
      this.rejectAllPending(`GSD process exited (code=${code}, signal=${signal})`);
      this._onConnectionChange.fire(false);
      if (code !== 0 && signal !== "SIGTERM") {
        const now = Date.now();
        this.restartTimestamps.push(now);
        this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < 6e4);
        if (this.restartTimestamps.length > 3) {
          this._onError.fire(
            `GSD process crashed ${this.restartTimestamps.length} times within 60s. Not restarting. Use "GSD: Start Agent" to retry manually.`
          );
        } else if (this.restartCount < 3) {
          this.restartCount++;
          setTimeout(() => this.start(), 1e3 * this.restartCount);
        }
      }
    });
    await startupResult;
  }
  /**
   * Stop the GSD agent process.
   */
  async stop() {
    if (!this.process) {
      return;
    }
    const proc = this.process;
    this.process = null;
    proc.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2e3);
      proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    this.rejectAllPending("Client stopped");
    this._onConnectionChange.fire(false);
  }
  // =========================================================================
  // Prompting
  // =========================================================================
  /**
   * Send a prompt message to the agent.
   * Returns once the command is acknowledged; streaming events follow via onEvent.
   */
  async sendPrompt(message) {
    const response = await this.send({ type: "prompt", message });
    this.assertSuccess(response);
  }
  /**
   * Interrupt the agent with a steering message while it is streaming.
   */
  async steer(message) {
    const response = await this.send({ type: "steer", message });
    this.assertSuccess(response);
  }
  /**
   * Send a follow-up message after the agent has completed.
   */
  async followUp(message) {
    const response = await this.send({ type: "follow_up", message });
    this.assertSuccess(response);
  }
  /**
   * Abort current operation.
   */
  async abort() {
    const response = await this.send({ type: "abort" });
    this.assertSuccess(response);
  }
  // =========================================================================
  // State
  // =========================================================================
  /**
   * Get current session state.
   */
  async getState() {
    const response = await this.send({ type: "get_state" });
    this.assertSuccess(response);
    return response.data;
  }
  // =========================================================================
  // Model
  // =========================================================================
  /**
   * Set the active model.
   */
  async setModel(provider, modelId) {
    const response = await this.send({ type: "set_model", provider, modelId });
    this.assertSuccess(response);
  }
  /**
   * Get available models.
   */
  async getAvailableModels() {
    const response = await this.send({ type: "get_available_models" });
    this.assertSuccess(response);
    return response.data.models;
  }
  /**
   * Cycle through available models.
   */
  async cycleModel() {
    const response = await this.send({ type: "cycle_model" });
    this.assertSuccess(response);
    return response.data;
  }
  // =========================================================================
  // Thinking
  // =========================================================================
  /**
   * Set the thinking level explicitly.
   */
  async setThinkingLevel(level) {
    const response = await this.send({ type: "set_thinking_level", level });
    this.assertSuccess(response);
  }
  /**
   * Cycle through thinking levels (off -> low -> medium -> high -> off).
   */
  async cycleThinkingLevel() {
    const response = await this.send({ type: "cycle_thinking_level" });
    this.assertSuccess(response);
    return response.data;
  }
  // =========================================================================
  // Compaction
  // =========================================================================
  /**
   * Manually compact the conversation context.
   */
  async compact(customInstructions) {
    const cmd = { type: "compact" };
    if (customInstructions) {
      cmd.customInstructions = customInstructions;
    }
    const response = await this.send(cmd);
    this.assertSuccess(response);
    return response.data;
  }
  /**
   * Enable or disable automatic compaction.
   */
  async setAutoCompaction(enabled) {
    const response = await this.send({ type: "set_auto_compaction", enabled });
    this.assertSuccess(response);
  }
  // =========================================================================
  // Retry
  // =========================================================================
  /**
   * Enable or disable automatic retry on failure.
   */
  async setAutoRetry(enabled) {
    const response = await this.send({ type: "set_auto_retry", enabled });
    this.assertSuccess(response);
    this._autoRetryEnabled = enabled;
  }
  /**
   * Abort a pending retry.
   */
  async abortRetry() {
    const response = await this.send({ type: "abort_retry" });
    this.assertSuccess(response);
  }
  // =========================================================================
  // Bash
  // =========================================================================
  /**
   * Execute a bash command via the agent.
   */
  async runBash(command) {
    const response = await this.send({ type: "bash", command });
    this.assertSuccess(response);
    return response.data;
  }
  /**
   * Abort a running bash command.
   */
  async abortBash() {
    const response = await this.send({ type: "abort_bash" });
    this.assertSuccess(response);
  }
  // =========================================================================
  // Session
  // =========================================================================
  /**
   * Start a new session.
   */
  async newSession() {
    const response = await this.send({ type: "new_session" });
    this.assertSuccess(response);
    this._autoRetryEnabled = false;
  }
  /**
   * Get session statistics (token counts, cost, etc.).
   */
  async getSessionStats() {
    const response = await this.send({ type: "get_session_stats" });
    this.assertSuccess(response);
    return response.data;
  }
  /**
   * Export the conversation as HTML.
   */
  async exportHtml(outputPath) {
    const cmd = { type: "export_html" };
    if (outputPath) {
      cmd.outputPath = outputPath;
    }
    const response = await this.send(cmd);
    this.assertSuccess(response);
    return response.data;
  }
  /**
   * Switch to a different session file.
   */
  async switchSession(sessionPath) {
    const response = await this.send({ type: "switch_session", sessionPath });
    this.assertSuccess(response);
  }
  /**
   * Set the display name for the current session.
   */
  async setSessionName(name) {
    const response = await this.send({ type: "set_session_name", name });
    this.assertSuccess(response);
  }
  /**
   * Get all conversation messages.
   */
  async getMessages() {
    const response = await this.send({ type: "get_messages" });
    this.assertSuccess(response);
    return response.data.messages;
  }
  /**
   * Get the text of the last assistant response.
   */
  async getLastAssistantText() {
    const response = await this.send({ type: "get_last_assistant_text" });
    this.assertSuccess(response);
    return response.data.text;
  }
  /**
   * List available slash commands.
   */
  async getCommands() {
    const response = await this.send({ type: "get_commands" });
    this.assertSuccess(response);
    return response.data.commands;
  }
  // =========================================================================
  // Fork
  // =========================================================================
  /**
   * Get messages that can be used as fork points.
   */
  async getForkMessages() {
    const response = await this.send({ type: "get_fork_messages" });
    this.assertSuccess(response);
    return response.data.messages;
  }
  /**
   * Fork the session at the given entry point.
   */
  async forkSession(entryId) {
    const response = await this.send({ type: "fork", entryId });
    this.assertSuccess(response);
    return response.data;
  }
  // =========================================================================
  // Queue Modes
  // =========================================================================
  /**
   * Set steering queue mode.
   */
  async setSteeringMode(mode) {
    const response = await this.send({ type: "set_steering_mode", mode });
    this.assertSuccess(response);
  }
  /**
   * Set follow-up queue mode.
   */
  async setFollowUpMode(mode) {
    const response = await this.send({ type: "set_follow_up_mode", mode });
    this.assertSuccess(response);
  }
  dispose() {
    this.stop();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
  // -- Private helpers ------------------------------------------------------
  drainBuffer() {
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) {
        break;
      }
      let line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (!line) {
        continue;
      }
      this.handleLine(line);
    }
  }
  handleLine(line) {
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    if (data.type === "response" && typeof data.id === "string" && this.pendingRequests.has(data.id)) {
      const pending = this.pendingRequests.get(data.id);
      this.pendingRequests.delete(data.id);
      clearTimeout(pending.timer);
      pending.resolve(data);
      return;
    }
    if (data.type === "extension_ui_request" && typeof data.id === "string") {
      void this.handleUIRequest(data);
      return;
    }
    this._onEvent.fire(data);
  }
  async handleUIRequest(request) {
    const id = request.id;
    const method = request.method;
    try {
      switch (method) {
        case "select": {
          const options = request.options ?? [];
          const title = String(request.title ?? "Select");
          const allowMultiple = request.allowMultiple === true;
          if (allowMultiple) {
            const picked = await vscode.window.showQuickPick(options, {
              title,
              canPickMany: true
            });
            if (picked) {
              this.sendRaw({ type: "extension_ui_response", id, values: picked });
            } else {
              this.sendRaw({ type: "extension_ui_response", id, cancelled: true });
            }
          } else {
            const picked = await vscode.window.showQuickPick(options, { title });
            if (picked) {
              this.sendRaw({ type: "extension_ui_response", id, value: picked });
            } else {
              this.sendRaw({ type: "extension_ui_response", id, cancelled: true });
            }
          }
          break;
        }
        case "confirm": {
          const title = String(request.title ?? "Confirm");
          const message = String(request.message ?? "");
          const result = await vscode.window.showInformationMessage(
            `${title}: ${message}`,
            { modal: true },
            "Yes",
            "No"
          );
          this.sendRaw({ type: "extension_ui_response", id, confirmed: result === "Yes" });
          break;
        }
        case "input": {
          const title = String(request.title ?? "Input");
          const placeholder = String(request.placeholder ?? "");
          const value = await vscode.window.showInputBox({ title, placeHolder: placeholder });
          if (value !== void 0) {
            this.sendRaw({ type: "extension_ui_response", id, value });
          } else {
            this.sendRaw({ type: "extension_ui_response", id, cancelled: true });
          }
          break;
        }
        case "notify": {
          const message = String(request.message ?? "");
          const notifyType = String(request.notifyType ?? "info");
          if (notifyType === "error") {
            vscode.window.showErrorMessage(`GSD: ${message}`);
          } else if (notifyType === "warning") {
            vscode.window.showWarningMessage(`GSD: ${message}`);
          } else {
            vscode.window.showInformationMessage(`GSD: ${message}`);
          }
          break;
        }
        default:
          this.sendRaw({ type: "extension_ui_response", id, cancelled: true });
          break;
      }
    } catch {
      this.sendRaw({ type: "extension_ui_response", id, cancelled: true });
    }
  }
  sendRaw(data) {
    if (this.process?.stdin) {
      this.process.stdin.write(JSON.stringify(data) + "\n");
    }
  }
  send(command) {
    if (!this.process?.stdin) {
      return Promise.reject(new Error("GSD client not started"));
    }
    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${command.type}`));
      }, 3e4);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify(fullCommand) + "\n");
    });
  }
  assertSuccess(response) {
    if (!response.success) {
      throw new Error(response.error ?? "Unknown RPC error");
    }
  }
  rejectAllPending(reason) {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
export {
  GsdClient
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vdnNjb2RlLWV4dGVuc2lvbi9zcmMvZ3NkLWNsaWVudC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFZTIENvZGUgZXh0ZW5zaW9uIFJQQyBjbGllbnQgZm9yIGNvbW11bmljYXRpbmcgd2l0aCB0aGUgR1NEIGFnZW50LlxuXG5pbXBvcnQgeyBDaGlsZFByb2Nlc3MsIHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0ICogYXMgdnNjb2RlIGZyb20gXCJ2c2NvZGVcIjtcbmltcG9ydCB0eXBlIHtcblx0QmFzaFJlc3VsdCxcblx0TW9kZWxJbmZvLFxuXHRScGNTZXNzaW9uU3RhdGUsXG5cdFJwY1NsYXNoQ29tbWFuZCxcblx0U2Vzc2lvblN0YXRzLFxuXHRUaGlua2luZ0xldmVsLFxufSBmcm9tIFwiQGdzZC1idWlsZC9jb250cmFjdHNcIiB3aXRoIHsgXCJyZXNvbHV0aW9uLW1vZGVcIjogXCJpbXBvcnRcIiB9O1xuaW1wb3J0IHsgYnVpbGRHc2RDbGllbnRTcGF3blBsYW4gfSBmcm9tIFwiLi9nc2QtY2xpZW50LXNwYXduLmpzXCI7XG5cbi8qKlxuICogTWlycm9ycyB0aGUgUlBDIGNvbW1hbmQvcmVzcG9uc2UgcHJvdG9jb2wgZnJvbSB0aGUgR1NEIGFnZW50LlxuICogU2hhcmVkIGNvbW1hbmQgYW5kIHJlc3BvbnNlIHBheWxvYWRzIGNvbWUgZnJvbSBAZ3NkLWJ1aWxkL2NvbnRyYWN0cy5cbiAqL1xuZXhwb3J0IHR5cGUgeyBCYXNoUmVzdWx0LCBNb2RlbEluZm8sIFNlc3Npb25TdGF0cywgVGhpbmtpbmdMZXZlbCB9O1xuZXhwb3J0IHR5cGUgU2xhc2hDb21tYW5kID0gUnBjU2xhc2hDb21tYW5kO1xuXG5leHBvcnQgaW50ZXJmYWNlIFJwY1Jlc3BvbnNlIHtcblx0aWQ/OiBzdHJpbmc7XG5cdHR5cGU6IFwicmVzcG9uc2VcIjtcblx0Y29tbWFuZDogc3RyaW5nO1xuXHRzdWNjZXNzOiBib29sZWFuO1xuXHRkYXRhPzogdW5rbm93bjtcblx0ZXJyb3I/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQWdlbnRFdmVudCB7XG5cdHR5cGU6IHN0cmluZztcblx0W2tleTogc3RyaW5nXTogdW5rbm93bjtcbn1cblxudHlwZSBQZW5kaW5nUmVxdWVzdCA9IHtcblx0cmVzb2x2ZTogKHJlc3BvbnNlOiBScGNSZXNwb25zZSkgPT4gdm9pZDtcblx0cmVqZWN0OiAoZXJyb3I6IEVycm9yKSA9PiB2b2lkO1xuXHR0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD47XG59O1xuXG4vKipcbiAqIENsaWVudCB0aGF0IHNwYXducyBgZ3NkIC0tbW9kZSBycGNgIGFuZCBjb21tdW5pY2F0ZXMgdmlhIEpTT04gbGluZXNcbiAqIG92ZXIgc3RkaW4vc3Rkb3V0LiBFbWl0cyBWUyBDb2RlIGV2ZW50cyBmb3Igc3RyZWFtaW5nIHJlc3BvbnNlcy5cbiAqL1xuZXhwb3J0IGNsYXNzIEdzZENsaWVudCBpbXBsZW1lbnRzIHZzY29kZS5EaXNwb3NhYmxlIHtcblx0cHJpdmF0ZSBwcm9jZXNzOiBDaGlsZFByb2Nlc3MgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBwZW5kaW5nUmVxdWVzdHMgPSBuZXcgTWFwPHN0cmluZywgUGVuZGluZ1JlcXVlc3Q+KCk7XG5cdHByaXZhdGUgcmVxdWVzdElkID0gMDtcblx0cHJpdmF0ZSBidWZmZXIgPSBcIlwiO1xuXHRwcml2YXRlIHJlc3RhcnRDb3VudCA9IDA7XG5cdHByaXZhdGUgcmVzdGFydFRpbWVzdGFtcHM6IG51bWJlcltdID0gW107XG5cdHByaXZhdGUgX2F1dG9SZXRyeUVuYWJsZWQgPSBmYWxzZTtcblxuXHRwcml2YXRlIHJlYWRvbmx5IF9vbkV2ZW50ID0gbmV3IHZzY29kZS5FdmVudEVtaXR0ZXI8QWdlbnRFdmVudD4oKTtcblx0cmVhZG9ubHkgb25FdmVudCA9IHRoaXMuX29uRXZlbnQuZXZlbnQ7XG5cblx0cHJpdmF0ZSByZWFkb25seSBfb25Db25uZWN0aW9uQ2hhbmdlID0gbmV3IHZzY29kZS5FdmVudEVtaXR0ZXI8Ym9vbGVhbj4oKTtcblx0cmVhZG9ubHkgb25Db25uZWN0aW9uQ2hhbmdlID0gdGhpcy5fb25Db25uZWN0aW9uQ2hhbmdlLmV2ZW50O1xuXG5cdHByaXZhdGUgcmVhZG9ubHkgX29uRXJyb3IgPSBuZXcgdnNjb2RlLkV2ZW50RW1pdHRlcjxzdHJpbmc+KCk7XG5cdHJlYWRvbmx5IG9uRXJyb3IgPSB0aGlzLl9vbkVycm9yLmV2ZW50O1xuXG5cdHByaXZhdGUgZGlzcG9zYWJsZXM6IHZzY29kZS5EaXNwb3NhYmxlW10gPSBbXTtcblxuXHRjb25zdHJ1Y3Rvcihcblx0XHRwcml2YXRlIHJlYWRvbmx5IGJpbmFyeVBhdGg6IHN0cmluZyxcblx0XHRwcml2YXRlIHJlYWRvbmx5IGN3ZDogc3RyaW5nLFxuXHQpIHtcblx0XHR0aGlzLmRpc3Bvc2FibGVzLnB1c2godGhpcy5fb25FdmVudCwgdGhpcy5fb25Db25uZWN0aW9uQ2hhbmdlLCB0aGlzLl9vbkVycm9yKTtcblx0fVxuXG5cdGdldCBpc0Nvbm5lY3RlZCgpOiBib29sZWFuIHtcblx0XHRyZXR1cm4gdGhpcy5wcm9jZXNzICE9PSBudWxsICYmIHRoaXMucHJvY2Vzcy5leGl0Q29kZSA9PT0gbnVsbDtcblx0fVxuXG5cdGdldCBhdXRvUmV0cnlFbmFibGVkKCk6IGJvb2xlYW4ge1xuXHRcdHJldHVybiB0aGlzLl9hdXRvUmV0cnlFbmFibGVkO1xuXHR9XG5cblx0LyoqXG5cdCAqIFNwYXduIHRoZSBHU0QgYWdlbnQgaW4gUlBDIG1vZGUuXG5cdCAqL1xuXHRhc3luYyBzdGFydCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5wcm9jZXNzKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3Qgc3Bhd25QbGFuID0gYnVpbGRHc2RDbGllbnRTcGF3blBsYW4odGhpcy5iaW5hcnlQYXRoLCB0aGlzLmN3ZCk7XG5cdFx0Y29uc3QgcHJvYyA9IHNwYXduKHNwYXduUGxhbi5jb21tYW5kLCBzcGF3blBsYW4uYXJncywgc3Bhd25QbGFuLm9wdGlvbnMpO1xuXHRcdHRoaXMucHJvY2VzcyA9IHByb2M7XG5cblx0XHR0aGlzLmJ1ZmZlciA9IFwiXCI7XG5cblx0XHRwcm9jLnN0ZG91dD8ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG5cdFx0XHR0aGlzLmJ1ZmZlciArPSBjaHVuay50b1N0cmluZyhcInV0ZjhcIik7XG5cdFx0XHR0aGlzLmRyYWluQnVmZmVyKCk7XG5cdFx0fSk7XG5cblx0XHRwcm9jLnN0ZGVycj8ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG5cdFx0XHRjb25zdCB0ZXh0ID0gY2h1bmsudG9TdHJpbmcoXCJ1dGY4XCIpLnRyaW0oKTtcblx0XHRcdGlmICh0ZXh0KSB7XG5cdFx0XHRcdHRoaXMuX29uRXJyb3IuZmlyZSh0ZXh0KTtcblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdGxldCBzdGFydHVwU2V0dGxlZCA9IGZhbHNlO1xuXHRcdGNvbnN0IHN0YXJ0dXBSZXN1bHQgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cdFx0XHRjb25zdCBjbGVhbnVwID0gKCkgPT4ge1xuXHRcdFx0XHRwcm9jLm9mZihcInNwYXduXCIsIGhhbmRsZVNwYXduKTtcblx0XHRcdFx0cHJvYy5vZmYoXCJlcnJvclwiLCBoYW5kbGVTdGFydHVwRXJyb3IpO1xuXHRcdFx0fTtcblx0XHRcdGNvbnN0IGhhbmRsZVNwYXduID0gKCkgPT4ge1xuXHRcdFx0XHRpZiAoc3RhcnR1cFNldHRsZWQpIHJldHVybjtcblx0XHRcdFx0c3RhcnR1cFNldHRsZWQgPSB0cnVlO1xuXHRcdFx0XHRjbGVhbnVwKCk7XG5cdFx0XHRcdHRoaXMuX29uQ29ubmVjdGlvbkNoYW5nZS5maXJlKHRydWUpO1xuXHRcdFx0XHR0aGlzLnJlc3RhcnRDb3VudCA9IDA7XG5cdFx0XHRcdHJlc29sdmUoKTtcblx0XHRcdH07XG5cdFx0XHRjb25zdCBoYW5kbGVTdGFydHVwRXJyb3IgPSAoZXJyOiBOb2RlSlMuRXJybm9FeGNlcHRpb24pID0+IHtcblx0XHRcdFx0aWYgKHN0YXJ0dXBTZXR0bGVkKSByZXR1cm47XG5cdFx0XHRcdHN0YXJ0dXBTZXR0bGVkID0gdHJ1ZTtcblx0XHRcdFx0Y2xlYW51cCgpO1xuXHRcdFx0XHRpZiAodGhpcy5wcm9jZXNzID09PSBwcm9jKSB7XG5cdFx0XHRcdFx0dGhpcy5wcm9jZXNzID0gbnVsbDtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBoaW50ID0gZXJyLmNvZGUgPT09IFwiRU5PRU5UXCJcblx0XHRcdFx0XHQ/IGAgTWFrZSBzdXJlIEdTRCBpcyBpbnN0YWxsZWQgKFwibnBtIGluc3RhbGwgLWcgZ3NkLXBpXCIpIGFuZCBzZXQgXCJnc2QuYmluYXJ5UGF0aFwiIHRvIHRoZSBhYnNvbHV0ZSBwYXRoIGlmIGl0IGlzIG5vdCBvbiBQQVRILmBcblx0XHRcdFx0XHQ6IFwiXCI7XG5cdFx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBgRmFpbGVkIHRvIHN0YXJ0IEdTRCBwcm9jZXNzOiAke2Vyci5tZXNzYWdlfS4ke2hpbnR9YDtcblx0XHRcdFx0dGhpcy5fb25FcnJvci5maXJlKG1lc3NhZ2UpO1xuXHRcdFx0XHRyZWplY3QobmV3IEVycm9yKG1lc3NhZ2UpKTtcblx0XHRcdH07XG5cblx0XHRcdHByb2Mub25jZShcInNwYXduXCIsIGhhbmRsZVNwYXduKTtcblx0XHRcdHByb2Mub25jZShcImVycm9yXCIsIGhhbmRsZVN0YXJ0dXBFcnJvcik7XG5cdFx0fSk7XG5cblx0XHRwcm9jLm9uKFwiZXJyb3JcIiwgKGVycjogTm9kZUpTLkVycm5vRXhjZXB0aW9uKSA9PiB7XG5cdFx0XHRpZiAoIXN0YXJ0dXBTZXR0bGVkKSB7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGlmICh0aGlzLnByb2Nlc3MgPT09IHByb2MpIHtcblx0XHRcdFx0dGhpcy5wcm9jZXNzID0gbnVsbDtcblx0XHRcdH1cblx0XHRcdHRoaXMuX29uQ29ubmVjdGlvbkNoYW5nZS5maXJlKGZhbHNlKTtcblx0XHRcdGNvbnN0IGhpbnQgPSBlcnIuY29kZSA9PT0gXCJFTk9FTlRcIlxuXHRcdFx0XHQ/IGAgTWFrZSBzdXJlIEdTRCBpcyBpbnN0YWxsZWQgKFwibnBtIGluc3RhbGwgLWcgZ3NkLXBpXCIpIGFuZCBzZXQgXCJnc2QuYmluYXJ5UGF0aFwiIHRvIHRoZSBhYnNvbHV0ZSBwYXRoIGlmIGl0IGlzIG5vdCBvbiBQQVRILmBcblx0XHRcdFx0OiBcIlwiO1xuXHRcdFx0dGhpcy5fb25FcnJvci5maXJlKGBHU0QgcHJvY2VzcyBlcnJvcjogJHtlcnIubWVzc2FnZX0uJHtoaW50fWApO1xuXHRcdH0pO1xuXG5cdFx0cHJvYy5vbihcImV4aXRcIiwgKGNvZGUsIHNpZ25hbCkgPT4ge1xuXHRcdFx0aWYgKHRoaXMucHJvY2VzcyA9PT0gcHJvYykge1xuXHRcdFx0XHR0aGlzLnByb2Nlc3MgPSBudWxsO1xuXHRcdFx0fVxuXHRcdFx0dGhpcy5yZWplY3RBbGxQZW5kaW5nKGBHU0QgcHJvY2VzcyBleGl0ZWQgKGNvZGU9JHtjb2RlfSwgc2lnbmFsPSR7c2lnbmFsfSlgKTtcblx0XHRcdHRoaXMuX29uQ29ubmVjdGlvbkNoYW5nZS5maXJlKGZhbHNlKTtcblxuXHRcdFx0aWYgKGNvZGUgIT09IDAgJiYgc2lnbmFsICE9PSBcIlNJR1RFUk1cIikge1xuXHRcdFx0XHRjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXHRcdFx0XHR0aGlzLnJlc3RhcnRUaW1lc3RhbXBzLnB1c2gobm93KTtcblx0XHRcdFx0Ly8gS2VlcCBvbmx5IHRpbWVzdGFtcHMgd2l0aGluIHRoZSBsYXN0IDYwIHNlY29uZHNcblx0XHRcdFx0dGhpcy5yZXN0YXJ0VGltZXN0YW1wcyA9IHRoaXMucmVzdGFydFRpbWVzdGFtcHMuZmlsdGVyKHQgPT4gbm93IC0gdCA8IDYwXzAwMCk7XG5cblx0XHRcdFx0aWYgKHRoaXMucmVzdGFydFRpbWVzdGFtcHMubGVuZ3RoID4gMykge1xuXHRcdFx0XHRcdC8vIFRvbyBtYW55IGNyYXNoZXMgd2l0aGluIDYwcyBcdTIwMTQgc3RvcCByZXRyeWluZ1xuXHRcdFx0XHRcdHRoaXMuX29uRXJyb3IuZmlyZShcblx0XHRcdFx0XHRcdGBHU0QgcHJvY2VzcyBjcmFzaGVkICR7dGhpcy5yZXN0YXJ0VGltZXN0YW1wcy5sZW5ndGh9IHRpbWVzIHdpdGhpbiA2MHMuIE5vdCByZXN0YXJ0aW5nLiBVc2UgXCJHU0Q6IFN0YXJ0IEFnZW50XCIgdG8gcmV0cnkgbWFudWFsbHkuYCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKHRoaXMucmVzdGFydENvdW50IDwgMykge1xuXHRcdFx0XHRcdHRoaXMucmVzdGFydENvdW50Kys7XG5cdFx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB0aGlzLnN0YXJ0KCksIDEwMDAgKiB0aGlzLnJlc3RhcnRDb3VudCk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdGF3YWl0IHN0YXJ0dXBSZXN1bHQ7XG5cdH1cblxuXHQvKipcblx0ICogU3RvcCB0aGUgR1NEIGFnZW50IHByb2Nlc3MuXG5cdCAqL1xuXHRhc3luYyBzdG9wKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICghdGhpcy5wcm9jZXNzKSB7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgcHJvYyA9IHRoaXMucHJvY2Vzcztcblx0XHR0aGlzLnByb2Nlc3MgPSBudWxsO1xuXHRcdHByb2Mua2lsbChcIlNJR1RFUk1cIik7XG5cblx0XHRhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuXHRcdFx0Y29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0XHRwcm9jLmtpbGwoXCJTSUdLSUxMXCIpO1xuXHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHR9LCAyMDAwKTtcblx0XHRcdHByb2Mub24oXCJleGl0XCIsICgpID0+IHtcblx0XHRcdFx0Y2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuXHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHR9KTtcblx0XHR9KTtcblxuXHRcdHRoaXMucmVqZWN0QWxsUGVuZGluZyhcIkNsaWVudCBzdG9wcGVkXCIpO1xuXHRcdHRoaXMuX29uQ29ubmVjdGlvbkNoYW5nZS5maXJlKGZhbHNlKTtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gUHJvbXB0aW5nXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHQvKipcblx0ICogU2VuZCBhIHByb21wdCBtZXNzYWdlIHRvIHRoZSBhZ2VudC5cblx0ICogUmV0dXJucyBvbmNlIHRoZSBjb21tYW5kIGlzIGFja25vd2xlZGdlZDsgc3RyZWFtaW5nIGV2ZW50cyBmb2xsb3cgdmlhIG9uRXZlbnQuXG5cdCAqL1xuXHRhc3luYyBzZW5kUHJvbXB0KG1lc3NhZ2U6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJwcm9tcHRcIiwgbWVzc2FnZSB9KTtcblx0XHR0aGlzLmFzc2VydFN1Y2Nlc3MocmVzcG9uc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEludGVycnVwdCB0aGUgYWdlbnQgd2l0aCBhIHN0ZWVyaW5nIG1lc3NhZ2Ugd2hpbGUgaXQgaXMgc3RyZWFtaW5nLlxuXHQgKi9cblx0YXN5bmMgc3RlZXIobWVzc2FnZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInN0ZWVyXCIsIG1lc3NhZ2UgfSk7XG5cdFx0dGhpcy5hc3NlcnRTdWNjZXNzKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZW5kIGEgZm9sbG93LXVwIG1lc3NhZ2UgYWZ0ZXIgdGhlIGFnZW50IGhhcyBjb21wbGV0ZWQuXG5cdCAqL1xuXHRhc3luYyBmb2xsb3dVcChtZXNzYWdlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZm9sbG93X3VwXCIsIG1lc3NhZ2UgfSk7XG5cdFx0dGhpcy5hc3NlcnRTdWNjZXNzKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBBYm9ydCBjdXJyZW50IG9wZXJhdGlvbi5cblx0ICovXG5cdGFzeW5jIGFib3J0KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJhYm9ydFwiIH0pO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIFN0YXRlXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHQvKipcblx0ICogR2V0IGN1cnJlbnQgc2Vzc2lvbiBzdGF0ZS5cblx0ICovXG5cdGFzeW5jIGdldFN0YXRlKCk6IFByb21pc2U8UnBjU2Vzc2lvblN0YXRlPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9zdGF0ZVwiIH0pO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdFx0cmV0dXJuIHJlc3BvbnNlLmRhdGEgYXMgUnBjU2Vzc2lvblN0YXRlO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBNb2RlbFxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIFNldCB0aGUgYWN0aXZlIG1vZGVsLlxuXHQgKi9cblx0YXN5bmMgc2V0TW9kZWwocHJvdmlkZXI6IHN0cmluZywgbW9kZWxJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInNldF9tb2RlbFwiLCBwcm92aWRlciwgbW9kZWxJZCB9KTtcblx0XHR0aGlzLmFzc2VydFN1Y2Nlc3MocmVzcG9uc2UpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBhdmFpbGFibGUgbW9kZWxzLlxuXHQgKi9cblx0YXN5bmMgZ2V0QXZhaWxhYmxlTW9kZWxzKCk6IFByb21pc2U8TW9kZWxJbmZvW10+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZ2V0X2F2YWlsYWJsZV9tb2RlbHNcIiB9KTtcblx0XHR0aGlzLmFzc2VydFN1Y2Nlc3MocmVzcG9uc2UpO1xuXHRcdHJldHVybiAocmVzcG9uc2UuZGF0YSBhcyB7IG1vZGVsczogTW9kZWxJbmZvW10gfSkubW9kZWxzO1xuXHR9XG5cblx0LyoqXG5cdCAqIEN5Y2xlIHRocm91Z2ggYXZhaWxhYmxlIG1vZGVscy5cblx0ICovXG5cdGFzeW5jIGN5Y2xlTW9kZWwoKTogUHJvbWlzZTx7IG1vZGVsOiBNb2RlbEluZm87IHRoaW5raW5nTGV2ZWw6IFRoaW5raW5nTGV2ZWw7IGlzU2NvcGVkOiBib29sZWFuIH0gfCBudWxsPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImN5Y2xlX21vZGVsXCIgfSk7XG5cdFx0dGhpcy5hc3NlcnRTdWNjZXNzKHJlc3BvbnNlKTtcblx0XHRyZXR1cm4gcmVzcG9uc2UuZGF0YSBhcyB7IG1vZGVsOiBNb2RlbEluZm87IHRoaW5raW5nTGV2ZWw6IFRoaW5raW5nTGV2ZWw7IGlzU2NvcGVkOiBib29sZWFuIH0gfCBudWxsO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBUaGlua2luZ1xuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIFNldCB0aGUgdGhpbmtpbmcgbGV2ZWwgZXhwbGljaXRseS5cblx0ICovXG5cdGFzeW5jIHNldFRoaW5raW5nTGV2ZWwobGV2ZWw6IFRoaW5raW5nTGV2ZWwpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwic2V0X3RoaW5raW5nX2xldmVsXCIsIGxldmVsIH0pO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogQ3ljbGUgdGhyb3VnaCB0aGlua2luZyBsZXZlbHMgKG9mZiAtPiBsb3cgLT4gbWVkaXVtIC0+IGhpZ2ggLT4gb2ZmKS5cblx0ICovXG5cdGFzeW5jIGN5Y2xlVGhpbmtpbmdMZXZlbCgpOiBQcm9taXNlPHsgbGV2ZWw6IFRoaW5raW5nTGV2ZWwgfSB8IG51bGw+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiY3ljbGVfdGhpbmtpbmdfbGV2ZWxcIiB9KTtcblx0XHR0aGlzLmFzc2VydFN1Y2Nlc3MocmVzcG9uc2UpO1xuXHRcdHJldHVybiByZXNwb25zZS5kYXRhIGFzIHsgbGV2ZWw6IFRoaW5raW5nTGV2ZWwgfSB8IG51bGw7XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIENvbXBhY3Rpb25cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdC8qKlxuXHQgKiBNYW51YWxseSBjb21wYWN0IHRoZSBjb252ZXJzYXRpb24gY29udGV4dC5cblx0ICovXG5cdGFzeW5jIGNvbXBhY3QoY3VzdG9tSW5zdHJ1Y3Rpb25zPzogc3RyaW5nKTogUHJvbWlzZTx1bmtub3duPiB7XG5cdFx0Y29uc3QgY21kOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgdHlwZTogXCJjb21wYWN0XCIgfTtcblx0XHRpZiAoY3VzdG9tSW5zdHJ1Y3Rpb25zKSB7XG5cdFx0XHRjbWQuY3VzdG9tSW5zdHJ1Y3Rpb25zID0gY3VzdG9tSW5zdHJ1Y3Rpb25zO1xuXHRcdH1cblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZChjbWQpO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdFx0cmV0dXJuIHJlc3BvbnNlLmRhdGE7XG5cdH1cblxuXHQvKipcblx0ICogRW5hYmxlIG9yIGRpc2FibGUgYXV0b21hdGljIGNvbXBhY3Rpb24uXG5cdCAqL1xuXHRhc3luYyBzZXRBdXRvQ29tcGFjdGlvbihlbmFibGVkOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcInNldF9hdXRvX2NvbXBhY3Rpb25cIiwgZW5hYmxlZCB9KTtcblx0XHR0aGlzLmFzc2VydFN1Y2Nlc3MocmVzcG9uc2UpO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBSZXRyeVxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIEVuYWJsZSBvciBkaXNhYmxlIGF1dG9tYXRpYyByZXRyeSBvbiBmYWlsdXJlLlxuXHQgKi9cblx0YXN5bmMgc2V0QXV0b1JldHJ5KGVuYWJsZWQ6IGJvb2xlYW4pOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwic2V0X2F1dG9fcmV0cnlcIiwgZW5hYmxlZCB9KTtcblx0XHR0aGlzLmFzc2VydFN1Y2Nlc3MocmVzcG9uc2UpO1xuXHRcdHRoaXMuX2F1dG9SZXRyeUVuYWJsZWQgPSBlbmFibGVkO1xuXHR9XG5cblx0LyoqXG5cdCAqIEFib3J0IGEgcGVuZGluZyByZXRyeS5cblx0ICovXG5cdGFzeW5jIGFib3J0UmV0cnkoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImFib3J0X3JldHJ5XCIgfSk7XG5cdFx0dGhpcy5hc3NlcnRTdWNjZXNzKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0Ly8gQmFzaFxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIEV4ZWN1dGUgYSBiYXNoIGNvbW1hbmQgdmlhIHRoZSBhZ2VudC5cblx0ICovXG5cdGFzeW5jIHJ1bkJhc2goY29tbWFuZDogc3RyaW5nKTogUHJvbWlzZTxCYXNoUmVzdWx0PiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImJhc2hcIiwgY29tbWFuZCB9KTtcblx0XHR0aGlzLmFzc2VydFN1Y2Nlc3MocmVzcG9uc2UpO1xuXHRcdHJldHVybiByZXNwb25zZS5kYXRhIGFzIEJhc2hSZXN1bHQ7XG5cdH1cblxuXHQvKipcblx0ICogQWJvcnQgYSBydW5uaW5nIGJhc2ggY29tbWFuZC5cblx0ICovXG5cdGFzeW5jIGFib3J0QmFzaCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiYWJvcnRfYmFzaFwiIH0pO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdH1cblxuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdC8vIFNlc3Npb25cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdC8qKlxuXHQgKiBTdGFydCBhIG5ldyBzZXNzaW9uLlxuXHQgKi9cblx0YXN5bmMgbmV3U2Vzc2lvbigpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwibmV3X3Nlc3Npb25cIiB9KTtcblx0XHR0aGlzLmFzc2VydFN1Y2Nlc3MocmVzcG9uc2UpO1xuXHRcdHRoaXMuX2F1dG9SZXRyeUVuYWJsZWQgPSBmYWxzZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgc2Vzc2lvbiBzdGF0aXN0aWNzICh0b2tlbiBjb3VudHMsIGNvc3QsIGV0Yy4pLlxuXHQgKi9cblx0YXN5bmMgZ2V0U2Vzc2lvblN0YXRzKCk6IFByb21pc2U8U2Vzc2lvblN0YXRzPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9zZXNzaW9uX3N0YXRzXCIgfSk7XG5cdFx0dGhpcy5hc3NlcnRTdWNjZXNzKHJlc3BvbnNlKTtcblx0XHRyZXR1cm4gcmVzcG9uc2UuZGF0YSBhcyBTZXNzaW9uU3RhdHM7XG5cdH1cblxuXHQvKipcblx0ICogRXhwb3J0IHRoZSBjb252ZXJzYXRpb24gYXMgSFRNTC5cblx0ICovXG5cdGFzeW5jIGV4cG9ydEh0bWwob3V0cHV0UGF0aD86IHN0cmluZyk6IFByb21pc2U8eyBwYXRoOiBzdHJpbmcgfT4ge1xuXHRcdGNvbnN0IGNtZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHR5cGU6IFwiZXhwb3J0X2h0bWxcIiB9O1xuXHRcdGlmIChvdXRwdXRQYXRoKSB7XG5cdFx0XHRjbWQub3V0cHV0UGF0aCA9IG91dHB1dFBhdGg7XG5cdFx0fVxuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKGNtZCk7XG5cdFx0dGhpcy5hc3NlcnRTdWNjZXNzKHJlc3BvbnNlKTtcblx0XHRyZXR1cm4gcmVzcG9uc2UuZGF0YSBhcyB7IHBhdGg6IHN0cmluZyB9O1xuXHR9XG5cblx0LyoqXG5cdCAqIFN3aXRjaCB0byBhIGRpZmZlcmVudCBzZXNzaW9uIGZpbGUuXG5cdCAqL1xuXHRhc3luYyBzd2l0Y2hTZXNzaW9uKHNlc3Npb25QYXRoOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwic3dpdGNoX3Nlc3Npb25cIiwgc2Vzc2lvblBhdGggfSk7XG5cdFx0dGhpcy5hc3NlcnRTdWNjZXNzKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTZXQgdGhlIGRpc3BsYXkgbmFtZSBmb3IgdGhlIGN1cnJlbnQgc2Vzc2lvbi5cblx0ICovXG5cdGFzeW5jIHNldFNlc3Npb25OYW1lKG5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzZXRfc2Vzc2lvbl9uYW1lXCIsIG5hbWUgfSk7XG5cdFx0dGhpcy5hc3NlcnRTdWNjZXNzKHJlc3BvbnNlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgYWxsIGNvbnZlcnNhdGlvbiBtZXNzYWdlcy5cblx0ICovXG5cdGFzeW5jIGdldE1lc3NhZ2VzKCk6IFByb21pc2U8dW5rbm93bltdPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9tZXNzYWdlc1wiIH0pO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdFx0cmV0dXJuIChyZXNwb25zZS5kYXRhIGFzIHsgbWVzc2FnZXM6IHVua25vd25bXSB9KS5tZXNzYWdlcztcblx0fVxuXG5cdC8qKlxuXHQgKiBHZXQgdGhlIHRleHQgb2YgdGhlIGxhc3QgYXNzaXN0YW50IHJlc3BvbnNlLlxuXHQgKi9cblx0YXN5bmMgZ2V0TGFzdEFzc2lzdGFudFRleHQoKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9sYXN0X2Fzc2lzdGFudF90ZXh0XCIgfSk7XG5cdFx0dGhpcy5hc3NlcnRTdWNjZXNzKHJlc3BvbnNlKTtcblx0XHRyZXR1cm4gKHJlc3BvbnNlLmRhdGEgYXMgeyB0ZXh0OiBzdHJpbmcgfCBudWxsIH0pLnRleHQ7XG5cdH1cblxuXHQvKipcblx0ICogTGlzdCBhdmFpbGFibGUgc2xhc2ggY29tbWFuZHMuXG5cdCAqL1xuXHRhc3luYyBnZXRDb21tYW5kcygpOiBQcm9taXNlPFNsYXNoQ29tbWFuZFtdPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLnNlbmQoeyB0eXBlOiBcImdldF9jb21tYW5kc1wiIH0pO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdFx0cmV0dXJuIChyZXNwb25zZS5kYXRhIGFzIHsgY29tbWFuZHM6IFNsYXNoQ29tbWFuZFtdIH0pLmNvbW1hbmRzO1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBGb3JrXG5cdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHQvKipcblx0ICogR2V0IG1lc3NhZ2VzIHRoYXQgY2FuIGJlIHVzZWQgYXMgZm9yayBwb2ludHMuXG5cdCAqL1xuXHRhc3luYyBnZXRGb3JrTWVzc2FnZXMoKTogUHJvbWlzZTx7IGVudHJ5SWQ6IHN0cmluZzsgdGV4dDogc3RyaW5nIH1bXT4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJnZXRfZm9ya19tZXNzYWdlc1wiIH0pO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdFx0cmV0dXJuIChyZXNwb25zZS5kYXRhIGFzIHsgbWVzc2FnZXM6IHsgZW50cnlJZDogc3RyaW5nOyB0ZXh0OiBzdHJpbmcgfVtdIH0pLm1lc3NhZ2VzO1xuXHR9XG5cblx0LyoqXG5cdCAqIEZvcmsgdGhlIHNlc3Npb24gYXQgdGhlIGdpdmVuIGVudHJ5IHBvaW50LlxuXHQgKi9cblx0YXN5bmMgZm9ya1Nlc3Npb24oZW50cnlJZDogc3RyaW5nKTogUHJvbWlzZTx7IHRleHQ6IHN0cmluZzsgY2FuY2VsbGVkOiBib29sZWFuIH0+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHRoaXMuc2VuZCh7IHR5cGU6IFwiZm9ya1wiLCBlbnRyeUlkIH0pO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdFx0cmV0dXJuIHJlc3BvbnNlLmRhdGEgYXMgeyB0ZXh0OiBzdHJpbmc7IGNhbmNlbGxlZDogYm9vbGVhbiB9O1xuXHR9XG5cblx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHQvLyBRdWV1ZSBNb2Rlc1xuXHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0LyoqXG5cdCAqIFNldCBzdGVlcmluZyBxdWV1ZSBtb2RlLlxuXHQgKi9cblx0YXN5bmMgc2V0U3RlZXJpbmdNb2RlKG1vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzZXRfc3RlZXJpbmdfbW9kZVwiLCBtb2RlIH0pO1xuXHRcdHRoaXMuYXNzZXJ0U3VjY2VzcyhyZXNwb25zZSk7XG5cdH1cblxuXHQvKipcblx0ICogU2V0IGZvbGxvdy11cCBxdWV1ZSBtb2RlLlxuXHQgKi9cblx0YXN5bmMgc2V0Rm9sbG93VXBNb2RlKG1vZGU6IFwiYWxsXCIgfCBcIm9uZS1hdC1hLXRpbWVcIik6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5zZW5kKHsgdHlwZTogXCJzZXRfZm9sbG93X3VwX21vZGVcIiwgbW9kZSB9KTtcblx0XHR0aGlzLmFzc2VydFN1Y2Nlc3MocmVzcG9uc2UpO1xuXHR9XG5cblx0ZGlzcG9zZSgpOiB2b2lkIHtcblx0XHR0aGlzLnN0b3AoKTtcblx0XHRmb3IgKGNvbnN0IGQgb2YgdGhpcy5kaXNwb3NhYmxlcykge1xuXHRcdFx0ZC5kaXNwb3NlKCk7XG5cdFx0fVxuXHR9XG5cblx0Ly8gLS0gUHJpdmF0ZSBoZWxwZXJzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5cdHByaXZhdGUgZHJhaW5CdWZmZXIoKTogdm9pZCB7XG5cdFx0d2hpbGUgKHRydWUpIHtcblx0XHRcdGNvbnN0IG5ld2xpbmVJZHggPSB0aGlzLmJ1ZmZlci5pbmRleE9mKFwiXFxuXCIpO1xuXHRcdFx0aWYgKG5ld2xpbmVJZHggPT09IC0xKSB7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0bGV0IGxpbmUgPSB0aGlzLmJ1ZmZlci5zbGljZSgwLCBuZXdsaW5lSWR4KTtcblx0XHRcdHRoaXMuYnVmZmVyID0gdGhpcy5idWZmZXIuc2xpY2UobmV3bGluZUlkeCArIDEpO1xuXG5cdFx0XHRpZiAobGluZS5lbmRzV2l0aChcIlxcclwiKSkge1xuXHRcdFx0XHRsaW5lID0gbGluZS5zbGljZSgwLCAtMSk7XG5cdFx0XHR9XG5cdFx0XHRpZiAoIWxpbmUpIHtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHR0aGlzLmhhbmRsZUxpbmUobGluZSk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBoYW5kbGVMaW5lKGxpbmU6IHN0cmluZyk6IHZvaWQge1xuXHRcdGxldCBkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcblx0XHR0cnkge1xuXHRcdFx0ZGF0YSA9IEpTT04ucGFyc2UobGluZSk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm47IC8vIGlnbm9yZSBub24tSlNPTiBsaW5lc1xuXHRcdH1cblxuXHRcdC8vIFJlc3BvbnNlIHRvIGEgcGVuZGluZyByZXF1ZXN0XG5cdFx0aWYgKGRhdGEudHlwZSA9PT0gXCJyZXNwb25zZVwiICYmIHR5cGVvZiBkYXRhLmlkID09PSBcInN0cmluZ1wiICYmIHRoaXMucGVuZGluZ1JlcXVlc3RzLmhhcyhkYXRhLmlkKSkge1xuXHRcdFx0Y29uc3QgcGVuZGluZyA9IHRoaXMucGVuZGluZ1JlcXVlc3RzLmdldChkYXRhLmlkKSE7XG5cdFx0XHR0aGlzLnBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoZGF0YS5pZCk7XG5cdFx0XHRjbGVhclRpbWVvdXQocGVuZGluZy50aW1lcik7XG5cdFx0XHRwZW5kaW5nLnJlc29sdmUoZGF0YSBhcyB1bmtub3duIGFzIFJwY1Jlc3BvbnNlKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBFeHRlbnNpb24gVUkgcmVxdWVzdCBcdTIwMTQgYWdlbnQgbmVlZHMgdXNlciBpbnB1dFxuXHRcdGlmIChkYXRhLnR5cGUgPT09IFwiZXh0ZW5zaW9uX3VpX3JlcXVlc3RcIiAmJiB0eXBlb2YgZGF0YS5pZCA9PT0gXCJzdHJpbmdcIikge1xuXHRcdFx0dm9pZCB0aGlzLmhhbmRsZVVJUmVxdWVzdChkYXRhKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBTdHJlYW1pbmcgZXZlbnRcblx0XHR0aGlzLl9vbkV2ZW50LmZpcmUoZGF0YSBhcyBBZ2VudEV2ZW50KTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgaGFuZGxlVUlSZXF1ZXN0KHJlcXVlc3Q6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgaWQgPSByZXF1ZXN0LmlkIGFzIHN0cmluZztcblx0XHRjb25zdCBtZXRob2QgPSByZXF1ZXN0Lm1ldGhvZCBhcyBzdHJpbmc7XG5cblx0XHR0cnkge1xuXHRcdFx0c3dpdGNoIChtZXRob2QpIHtcblx0XHRcdFx0Y2FzZSBcInNlbGVjdFwiOiB7XG5cdFx0XHRcdFx0Y29uc3Qgb3B0aW9ucyA9IChyZXF1ZXN0Lm9wdGlvbnMgYXMgc3RyaW5nW10pID8/IFtdO1xuXHRcdFx0XHRcdGNvbnN0IHRpdGxlID0gU3RyaW5nKHJlcXVlc3QudGl0bGUgPz8gXCJTZWxlY3RcIik7XG5cdFx0XHRcdFx0Y29uc3QgYWxsb3dNdWx0aXBsZSA9IHJlcXVlc3QuYWxsb3dNdWx0aXBsZSA9PT0gdHJ1ZTtcblxuXHRcdFx0XHRcdGlmIChhbGxvd011bHRpcGxlKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBwaWNrZWQgPSBhd2FpdCB2c2NvZGUud2luZG93LnNob3dRdWlja1BpY2sob3B0aW9ucywge1xuXHRcdFx0XHRcdFx0XHR0aXRsZSxcblx0XHRcdFx0XHRcdFx0Y2FuUGlja01hbnk6IHRydWUsXG5cdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdGlmIChwaWNrZWQpIHtcblx0XHRcdFx0XHRcdFx0dGhpcy5zZW5kUmF3KHsgdHlwZTogXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIiwgaWQsIHZhbHVlczogcGlja2VkIH0pO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0dGhpcy5zZW5kUmF3KHsgdHlwZTogXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIiwgaWQsIGNhbmNlbGxlZDogdHJ1ZSB9KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0Y29uc3QgcGlja2VkID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93UXVpY2tQaWNrKG9wdGlvbnMsIHsgdGl0bGUgfSk7XG5cdFx0XHRcdFx0XHRpZiAocGlja2VkKSB7XG5cdFx0XHRcdFx0XHRcdHRoaXMuc2VuZFJhdyh7IHR5cGU6IFwiZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlXCIsIGlkLCB2YWx1ZTogcGlja2VkIH0pO1xuXHRcdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdFx0dGhpcy5zZW5kUmF3KHsgdHlwZTogXCJleHRlbnNpb25fdWlfcmVzcG9uc2VcIiwgaWQsIGNhbmNlbGxlZDogdHJ1ZSB9KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwiY29uZmlybVwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgdGl0bGUgPSBTdHJpbmcocmVxdWVzdC50aXRsZSA/PyBcIkNvbmZpcm1cIik7XG5cdFx0XHRcdFx0Y29uc3QgbWVzc2FnZSA9IFN0cmluZyhyZXF1ZXN0Lm1lc3NhZ2UgPz8gXCJcIik7XG5cdFx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93SW5mb3JtYXRpb25NZXNzYWdlKFxuXHRcdFx0XHRcdFx0YCR7dGl0bGV9OiAke21lc3NhZ2V9YCxcblx0XHRcdFx0XHRcdHsgbW9kYWw6IHRydWUgfSxcblx0XHRcdFx0XHRcdFwiWWVzXCIsXG5cdFx0XHRcdFx0XHRcIk5vXCIsXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR0aGlzLnNlbmRSYXcoeyB0eXBlOiBcImV4dGVuc2lvbl91aV9yZXNwb25zZVwiLCBpZCwgY29uZmlybWVkOiByZXN1bHQgPT09IFwiWWVzXCIgfSk7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwiaW5wdXRcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHRpdGxlID0gU3RyaW5nKHJlcXVlc3QudGl0bGUgPz8gXCJJbnB1dFwiKTtcblx0XHRcdFx0XHRjb25zdCBwbGFjZWhvbGRlciA9IFN0cmluZyhyZXF1ZXN0LnBsYWNlaG9sZGVyID8/IFwiXCIpO1xuXHRcdFx0XHRcdGNvbnN0IHZhbHVlID0gYXdhaXQgdnNjb2RlLndpbmRvdy5zaG93SW5wdXRCb3goeyB0aXRsZSwgcGxhY2VIb2xkZXI6IHBsYWNlaG9sZGVyIH0pO1xuXHRcdFx0XHRcdGlmICh2YWx1ZSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0XHR0aGlzLnNlbmRSYXcoeyB0eXBlOiBcImV4dGVuc2lvbl91aV9yZXNwb25zZVwiLCBpZCwgdmFsdWUgfSk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHRoaXMuc2VuZFJhdyh7IHR5cGU6IFwiZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlXCIsIGlkLCBjYW5jZWxsZWQ6IHRydWUgfSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGJyZWFrO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcIm5vdGlmeVwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgbWVzc2FnZSA9IFN0cmluZyhyZXF1ZXN0Lm1lc3NhZ2UgPz8gXCJcIik7XG5cdFx0XHRcdFx0Y29uc3Qgbm90aWZ5VHlwZSA9IFN0cmluZyhyZXF1ZXN0Lm5vdGlmeVR5cGUgPz8gXCJpbmZvXCIpO1xuXHRcdFx0XHRcdGlmIChub3RpZnlUeXBlID09PSBcImVycm9yXCIpIHtcblx0XHRcdFx0XHRcdHZzY29kZS53aW5kb3cuc2hvd0Vycm9yTWVzc2FnZShgR1NEOiAke21lc3NhZ2V9YCk7XG5cdFx0XHRcdFx0fSBlbHNlIGlmIChub3RpZnlUeXBlID09PSBcIndhcm5pbmdcIikge1xuXHRcdFx0XHRcdFx0dnNjb2RlLndpbmRvdy5zaG93V2FybmluZ01lc3NhZ2UoYEdTRDogJHttZXNzYWdlfWApO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHR2c2NvZGUud2luZG93LnNob3dJbmZvcm1hdGlvbk1lc3NhZ2UoYEdTRDogJHttZXNzYWdlfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHQvLyBOb3RpZnkgZG9lc24ndCBuZWVkIGEgcmVzcG9uc2Vcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGRlZmF1bHQ6XG5cdFx0XHRcdFx0Ly8gVW5rbm93biBtZXRob2QgXHUyMDE0IGNhbmNlbCB0byB1bmJsb2NrIHRoZSBhZ2VudFxuXHRcdFx0XHRcdHRoaXMuc2VuZFJhdyh7IHR5cGU6IFwiZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlXCIsIGlkLCBjYW5jZWxsZWQ6IHRydWUgfSk7XG5cdFx0XHRcdFx0YnJlYWs7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBPbiBlcnJvciwgY2FuY2VsIHRvIHVuYmxvY2tcblx0XHRcdHRoaXMuc2VuZFJhdyh7IHR5cGU6IFwiZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlXCIsIGlkLCBjYW5jZWxsZWQ6IHRydWUgfSk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBzZW5kUmF3KGRhdGE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogdm9pZCB7XG5cdFx0aWYgKHRoaXMucHJvY2Vzcz8uc3RkaW4pIHtcblx0XHRcdHRoaXMucHJvY2Vzcy5zdGRpbi53cml0ZShKU09OLnN0cmluZ2lmeShkYXRhKSArIFwiXFxuXCIpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgc2VuZChjb21tYW5kOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IFByb21pc2U8UnBjUmVzcG9uc2U+IHtcblx0XHRpZiAoIXRoaXMucHJvY2Vzcz8uc3RkaW4pIHtcblx0XHRcdHJldHVybiBQcm9taXNlLnJlamVjdChuZXcgRXJyb3IoXCJHU0QgY2xpZW50IG5vdCBzdGFydGVkXCIpKTtcblx0XHR9XG5cblx0XHRjb25zdCBpZCA9IGByZXFfJHsrK3RoaXMucmVxdWVzdElkfWA7XG5cdFx0Y29uc3QgZnVsbENvbW1hbmQgPSB7IC4uLmNvbW1hbmQsIGlkIH07XG5cblx0XHRyZXR1cm4gbmV3IFByb21pc2U8UnBjUmVzcG9uc2U+KChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdHRoaXMucGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShpZCk7XG5cdFx0XHRcdHJlamVjdChuZXcgRXJyb3IoYFRpbWVvdXQgd2FpdGluZyBmb3IgcmVzcG9uc2UgdG8gJHtjb21tYW5kLnR5cGV9YCkpO1xuXHRcdFx0fSwgMzBfMDAwKTtcblxuXHRcdFx0dGhpcy5wZW5kaW5nUmVxdWVzdHMuc2V0KGlkLCB7IHJlc29sdmUsIHJlamVjdCwgdGltZXIgfSk7XG5cdFx0XHR0aGlzLnByb2Nlc3MhLnN0ZGluIS53cml0ZShKU09OLnN0cmluZ2lmeShmdWxsQ29tbWFuZCkgKyBcIlxcblwiKTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgYXNzZXJ0U3VjY2VzcyhyZXNwb25zZTogUnBjUmVzcG9uc2UpOiB2b2lkIHtcblx0XHRpZiAoIXJlc3BvbnNlLnN1Y2Nlc3MpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihyZXNwb25zZS5lcnJvciA/PyBcIlVua25vd24gUlBDIGVycm9yXCIpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgcmVqZWN0QWxsUGVuZGluZyhyZWFzb246IHN0cmluZyk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgWywgcGVuZGluZ10gb2YgdGhpcy5wZW5kaW5nUmVxdWVzdHMpIHtcblx0XHRcdGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVyKTtcblx0XHRcdHBlbmRpbmcucmVqZWN0KG5ldyBFcnJvcihyZWFzb24pKTtcblx0XHR9XG5cdFx0dGhpcy5wZW5kaW5nUmVxdWVzdHMuY2xlYXIoKTtcblx0fVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBdUIsYUFBYTtBQUNwQyxZQUFZLFlBQVk7QUFTeEIsU0FBUywrQkFBK0I7QUFpQ2pDLE1BQU0sVUFBdUM7QUFBQSxFQW9CbkQsWUFDa0IsWUFDQSxLQUNoQjtBQUZnQjtBQUNBO0FBRWpCLFNBQUssWUFBWSxLQUFLLEtBQUssVUFBVSxLQUFLLHFCQUFxQixLQUFLLFFBQVE7QUFBQSxFQUM3RTtBQUFBLEVBeEJRLFVBQStCO0FBQUEsRUFDL0Isa0JBQWtCLG9CQUFJLElBQTRCO0FBQUEsRUFDbEQsWUFBWTtBQUFBLEVBQ1osU0FBUztBQUFBLEVBQ1QsZUFBZTtBQUFBLEVBQ2Ysb0JBQThCLENBQUM7QUFBQSxFQUMvQixvQkFBb0I7QUFBQSxFQUVYLFdBQVcsSUFBSSxPQUFPLGFBQXlCO0FBQUEsRUFDdkQsVUFBVSxLQUFLLFNBQVM7QUFBQSxFQUVoQixzQkFBc0IsSUFBSSxPQUFPLGFBQXNCO0FBQUEsRUFDL0QscUJBQXFCLEtBQUssb0JBQW9CO0FBQUEsRUFFdEMsV0FBVyxJQUFJLE9BQU8sYUFBcUI7QUFBQSxFQUNuRCxVQUFVLEtBQUssU0FBUztBQUFBLEVBRXpCLGNBQW1DLENBQUM7QUFBQSxFQVM1QyxJQUFJLGNBQXVCO0FBQzFCLFdBQU8sS0FBSyxZQUFZLFFBQVEsS0FBSyxRQUFRLGFBQWE7QUFBQSxFQUMzRDtBQUFBLEVBRUEsSUFBSSxtQkFBNEI7QUFDL0IsV0FBTyxLQUFLO0FBQUEsRUFDYjtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBS0EsTUFBTSxRQUF1QjtBQUM1QixRQUFJLEtBQUssU0FBUztBQUNqQjtBQUFBLElBQ0Q7QUFFQSxVQUFNLFlBQVksd0JBQXdC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
