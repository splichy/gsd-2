import * as crypto from "node:crypto";
import { InteractiveMode } from "../interactive/interactive-mode.js";
import { theme } from "../interactive/theme/theme.js";
import { createDefaultCommandContextActions } from "../shared/command-context-actions.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import { RemoteTerminal } from "./remote-terminal.js";
async function runRpcMode(session) {
  const output = (obj) => {
    process.stdout.write(serializeJsonLine(obj));
  };
  const success = (id, command, data) => {
    if (data === void 0) {
      return { id, type: "response", command, success: true };
    }
    return { id, type: "response", command, success: true, data };
  };
  const error = (id, command, message) => {
    return { id, type: "response", command, success: false, error: message };
  };
  const pendingExtensionRequests = /* @__PURE__ */ new Map();
  let shutdownRequested = false;
  let protocolVersion = 1;
  let protocolLocked = false;
  let currentRunId = null;
  let eventFilter = null;
  const embeddedTerminalEnabled = process.env.GSD_WEB_BRIDGE_TUI === "1";
  const remoteTerminal = embeddedTerminalEnabled ? new RemoteTerminal({
    onWrite: (data) => {
      output({ type: "terminal_output", data });
    }
  }) : null;
  let embeddedInteractiveMode = null;
  let embeddedInteractiveInitPromise = null;
  const startupNotifications = [];
  const statusState = /* @__PURE__ */ new Map();
  const widgetState = /* @__PURE__ */ new Map();
  let footerFactory;
  let headerFactory;
  let workingMessageState;
  let titleState;
  let editorTextState;
  const withEmbeddedUiContext = async (apply) => {
    if (!embeddedInteractiveMode) {
      return;
    }
    await apply(embeddedInteractiveMode.getExtensionUIContext());
  };
  const replayEmbeddedUiState = async (interactiveMode) => {
    const ui = interactiveMode.getExtensionUIContext();
    ui.setHeader(headerFactory);
    ui.setFooter(footerFactory);
    for (const [key, text] of statusState.entries()) {
      ui.setStatus(key, text);
    }
    for (const [key, widget] of widgetState.entries()) {
      ui.setWidget(key, widget.content, widget.options);
    }
    ui.setWorkingMessage(workingMessageState);
    if (titleState) {
      ui.setTitle(titleState);
    }
    if (editorTextState !== void 0) {
      ui.setEditorText(editorTextState);
    }
    for (const { message, type } of startupNotifications) {
      ui.notify(message, type);
    }
  };
  const ensureEmbeddedInteractiveMode = async () => {
    if (!embeddedTerminalEnabled || !remoteTerminal) {
      throw new Error("Embedded terminal is not enabled for this RPC host");
    }
    if (embeddedInteractiveMode) {
      return embeddedInteractiveMode;
    }
    if (!embeddedInteractiveInitPromise) {
      embeddedInteractiveMode = new InteractiveMode(session, {
        terminal: remoteTerminal,
        bindExtensions: false,
        submitPromptsDirectly: true,
        shutdownBehavior: "ignore"
      });
      embeddedInteractiveInitPromise = embeddedInteractiveMode.init().then(async () => {
        await replayEmbeddedUiState(embeddedInteractiveMode);
      }).catch((error2) => {
        embeddedInteractiveMode = null;
        throw error2;
      }).finally(() => {
        embeddedInteractiveInitPromise = null;
      });
    }
    await embeddedInteractiveInitPromise;
    return embeddedInteractiveMode;
  };
  function createDialogPromise(opts, defaultValue, request, parseResponse) {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timeoutId;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener("abort", onAbort);
        pendingExtensionRequests.delete(id);
      };
      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }
      pendingExtensionRequests.set(id, {
        resolve: (response) => {
          cleanup();
          resolve(parseResponse(response));
        },
        reject
      });
      output({ type: "extension_ui_request", id, ...request });
    });
  }
  const createExtensionUIContext = () => ({
    select: (title, options, opts) => createDialogPromise(
      opts,
      void 0,
      { method: "select", title, options, timeout: opts?.timeout, allowMultiple: opts?.allowMultiple },
      (r) => "cancelled" in r && r.cancelled ? void 0 : "values" in r ? r.values : "value" in r ? r.value : void 0
    ),
    confirm: (title, message, opts) => createDialogPromise(
      opts,
      false,
      { method: "confirm", title, message, timeout: opts?.timeout },
      (r) => "cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false
    ),
    input: (title, placeholder, opts) => createDialogPromise(
      opts,
      void 0,
      { method: "input", title, placeholder, timeout: opts?.timeout, secure: opts?.secure },
      (r) => "cancelled" in r && r.cancelled ? void 0 : "value" in r ? r.value : void 0
    ),
    notify(message, type) {
      startupNotifications.push({ message, type });
      if (startupNotifications.length > 20) {
        startupNotifications.splice(0, startupNotifications.length - 20);
      }
      output({
        type: "extension_ui_request",
        id: crypto.randomUUID(),
        method: "notify",
        message,
        notifyType: type
      });
      void withEmbeddedUiContext((ui) => {
        ui.notify(message, type);
      });
    },
    onTerminalInput() {
      return () => {
      };
    },
    setStatus(key, text) {
      statusState.set(key, text);
      output({
        type: "extension_ui_request",
        id: crypto.randomUUID(),
        method: "setStatus",
        statusKey: key,
        statusText: text
      });
      void withEmbeddedUiContext((ui) => {
        ui.setStatus(key, text);
      });
    },
    setWorkingMessage(message) {
      workingMessageState = message;
      void withEmbeddedUiContext((ui) => {
        ui.setWorkingMessage(message);
      });
    },
    setWidget(key, content, options) {
      widgetState.set(key, { content, options });
      if (content === void 0 || Array.isArray(content)) {
        output({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement
        });
      } else if (typeof content === "function") {
        output({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: void 0,
          widgetPlacement: options?.placement
        });
      }
      void withEmbeddedUiContext((ui) => {
        ui.setWidget(key, content, options);
      });
    },
    setFooter(factory) {
      footerFactory = factory;
      void withEmbeddedUiContext((ui) => {
        ui.setFooter(factory);
      });
    },
    setHeader(factory) {
      headerFactory = factory;
      void withEmbeddedUiContext((ui) => {
        ui.setHeader(factory);
      });
    },
    setTitle(title) {
      titleState = title;
      output({
        type: "extension_ui_request",
        id: crypto.randomUUID(),
        method: "setTitle",
        title
      });
      void withEmbeddedUiContext((ui) => {
        ui.setTitle(title);
      });
    },
    async custom() {
      return void 0;
    },
    pasteToEditor(text) {
      this.setEditorText(text);
    },
    setEditorText(text) {
      editorTextState = text;
      output({
        type: "extension_ui_request",
        id: crypto.randomUUID(),
        method: "set_editor_text",
        text
      });
      void withEmbeddedUiContext((ui) => {
        ui.setEditorText(text);
      });
    },
    getEditorText() {
      return "";
    },
    async editor(title, prefill) {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        pendingExtensionRequests.set(id, {
          resolve: (response) => {
            if ("cancelled" in response && response.cancelled) {
              resolve(void 0);
            } else if ("value" in response) {
              resolve(response.value);
            } else {
              resolve(void 0);
            }
          },
          reject
        });
        output({ type: "extension_ui_request", id, method: "editor", title, prefill });
      });
    },
    setEditorComponent() {
    },
    get theme() {
      return theme;
    },
    getAllThemes() {
      return [];
    },
    getTheme(_name) {
      return void 0;
    },
    setTheme(_theme) {
      return { success: false, error: "Theme switching not supported in RPC mode" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded(_expanded) {
    }
  });
  let extensionsReady = false;
  const extensionsReadyPromise = session.bindExtensions({
    uiContext: createExtensionUIContext(),
    commandContextActions: createDefaultCommandContextActions(session),
    shutdownHandler: () => {
      shutdownRequested = true;
    },
    onError: (err) => {
      output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
    }
  }).then(() => {
    extensionsReady = true;
    output({ type: "extensions_ready" });
  }).catch((error2) => {
    extensionsReady = true;
    output({
      type: "extension_error",
      event: "session_start",
      error: error2 instanceof Error ? error2.message : String(error2)
    });
  });
  void extensionsReadyPromise;
  const unsubscribe = session.subscribe((event) => {
    if (protocolVersion === 2) {
      if (event.type === "message_end" && event.message.role === "assistant" && currentRunId) {
        const stats = session.getSessionStats();
        const costUpdate = {
          type: "cost_update",
          runId: currentRunId,
          turnCost: session.getLastTurnCost(),
          cumulativeCost: stats.cost,
          tokens: {
            input: stats.tokens.input,
            output: stats.tokens.output,
            cacheRead: stats.tokens.cacheRead,
            cacheWrite: stats.tokens.cacheWrite
          }
        };
        if (!eventFilter || eventFilter.has("cost_update")) {
          output(costUpdate);
        }
      }
      if (event.type === "agent_end" && currentRunId) {
        const stats = session.getSessionStats();
        const completionEvent = {
          type: "execution_complete",
          runId: currentRunId,
          status: "completed",
          stats
        };
        if (!eventFilter || eventFilter.has("execution_complete")) {
          output(completionEvent);
        }
        currentRunId = null;
      }
    }
    if (protocolVersion === 2 && eventFilter && !eventFilter.has(event.type)) {
      return;
    }
    if (protocolVersion === 2 && currentRunId) {
      output({ ...event, runId: currentRunId });
    } else {
      output(event);
    }
  });
  const handleCommand = async (command) => {
    const id = command.id;
    switch (command.type) {
      // =================================================================
      // Prompting
      // =================================================================
      case "prompt": {
        const runId = protocolVersion === 2 ? crypto.randomUUID() : void 0;
        if (runId) currentRunId = runId;
        session.prompt(command.message, {
          images: command.images,
          streamingBehavior: command.streamingBehavior,
          source: "rpc"
        }).catch((e) => output(error(id, "prompt", e.message)));
        return { id, type: "response", command: "prompt", success: true, ...runId && { runId } };
      }
      case "steer": {
        const runId = protocolVersion === 2 ? crypto.randomUUID() : void 0;
        if (runId) currentRunId = runId;
        await session.steer(command.message, command.images);
        return { id, type: "response", command: "steer", success: true, ...runId && { runId } };
      }
      case "follow_up": {
        const runId = protocolVersion === 2 ? crypto.randomUUID() : void 0;
        if (runId) currentRunId = runId;
        await session.followUp(command.message, command.images);
        return { id, type: "response", command: "follow_up", success: true, ...runId && { runId } };
      }
      case "abort": {
        await session.abort({ origin: "user" });
        return success(id, "abort");
      }
      case "new_session": {
        const options = command.parentSession ? { parentSession: command.parentSession } : void 0;
        const cancelled = !await session.newSession(options);
        return success(id, "new_session", { cancelled });
      }
      // =================================================================
      // State
      // =================================================================
      case "get_state": {
        const state = {
          model: session.model,
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          isCompacting: session.isCompacting,
          steeringMode: session.steeringMode,
          followUpMode: session.followUpMode,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          autoCompactionEnabled: session.autoCompactionEnabled,
          autoRetryEnabled: session.autoRetryEnabled,
          retryInProgress: session.isRetrying,
          retryAttempt: session.retryAttempt,
          messageCount: session.messages.length,
          pendingMessageCount: session.pendingMessageCount,
          extensionsReady
        };
        return success(id, "get_state", state);
      }
      // =================================================================
      // Model
      // =================================================================
      case "set_model": {
        const models = await session.modelRegistry.getAvailable();
        const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
        if (!model) {
          return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
        }
        await session.setModel(model);
        return success(id, "set_model", model);
      }
      case "cycle_model": {
        const result = await session.cycleModel();
        if (!result) {
          return success(id, "cycle_model", null);
        }
        return success(id, "cycle_model", result);
      }
      case "get_available_models": {
        const models = await session.modelRegistry.getAvailable();
        return success(id, "get_available_models", { models });
      }
      // =================================================================
      // Thinking
      // =================================================================
      case "set_thinking_level": {
        session.setThinkingLevel(command.level);
        return success(id, "set_thinking_level");
      }
      case "cycle_thinking_level": {
        const level = session.cycleThinkingLevel();
        if (!level) {
          return success(id, "cycle_thinking_level", null);
        }
        return success(id, "cycle_thinking_level", { level });
      }
      // =================================================================
      // Queue Modes
      // =================================================================
      case "set_steering_mode": {
        session.setSteeringMode(command.mode);
        return success(id, "set_steering_mode");
      }
      case "set_follow_up_mode": {
        session.setFollowUpMode(command.mode);
        return success(id, "set_follow_up_mode");
      }
      // =================================================================
      // Compaction
      // =================================================================
      case "compact": {
        const result = await session.compact(command.customInstructions);
        return success(id, "compact", result);
      }
      case "set_auto_compaction": {
        session.setAutoCompactionEnabled(command.enabled);
        return success(id, "set_auto_compaction");
      }
      // =================================================================
      // Retry
      // =================================================================
      case "set_auto_retry": {
        session.setAutoRetryEnabled(command.enabled);
        return success(id, "set_auto_retry");
      }
      case "abort_retry": {
        session.abortRetry();
        return success(id, "abort_retry");
      }
      // =================================================================
      // Bash
      // =================================================================
      case "bash": {
        const result = await session.executeBash(command.command);
        return success(id, "bash", result);
      }
      case "abort_bash": {
        session.abortBash();
        return success(id, "abort_bash");
      }
      // =================================================================
      // Session
      // =================================================================
      case "get_session_stats": {
        const stats = session.getSessionStats();
        return success(id, "get_session_stats", stats);
      }
      case "export_html": {
        const path = await session.exportToHtml(command.outputPath);
        return success(id, "export_html", { path });
      }
      case "switch_session": {
        const cancelled = !await session.switchSession(command.sessionPath);
        return success(id, "switch_session", { cancelled });
      }
      case "fork": {
        const result = await session.fork(command.entryId);
        return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
      }
      case "get_fork_messages": {
        const messages = session.getUserMessagesForForking();
        return success(id, "get_fork_messages", { messages });
      }
      case "get_last_assistant_text": {
        const text = session.getLastAssistantText();
        return success(id, "get_last_assistant_text", { text });
      }
      case "set_session_name": {
        const name = command.name.trim();
        if (!name) {
          return error(id, "set_session_name", "Session name cannot be empty");
        }
        session.setSessionName(name);
        return success(id, "set_session_name");
      }
      // =================================================================
      // Messages
      // =================================================================
      case "get_messages": {
        return success(id, "get_messages", { messages: session.messages });
      }
      // =================================================================
      // Commands (available for invocation via prompt)
      // =================================================================
      case "get_commands": {
        const commands = [];
        for (const { command: command2, extensionPath } of session.extensionRunner?.getRegisteredCommandsWithPaths() ?? []) {
          commands.push({
            name: command2.name,
            description: command2.description,
            source: "extension",
            path: extensionPath
          });
        }
        for (const template of session.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            location: template.source,
            path: template.filePath
          });
        }
        for (const skill of session.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            location: skill.source,
            path: skill.filePath
          });
        }
        return success(id, "get_commands", { commands });
      }
      case "terminal_input": {
        await ensureEmbeddedInteractiveMode();
        remoteTerminal.pushInput(command.data);
        return success(id, "terminal_input");
      }
      case "terminal_resize": {
        await ensureEmbeddedInteractiveMode();
        remoteTerminal.resize(command.cols, command.rows);
        return success(id, "terminal_resize");
      }
      case "terminal_redraw": {
        const interactiveMode = await ensureEmbeddedInteractiveMode();
        interactiveMode.requestRender(true);
        return success(id, "terminal_redraw");
      }
      // =================================================================
      // v2 Protocol: subscribe
      // =================================================================
      case "subscribe": {
        if (command.events.includes("*")) {
          eventFilter = null;
        } else {
          eventFilter = new Set(command.events);
        }
        return success(id, "subscribe");
      }
      // =================================================================
      // v2 Protocol: shutdown
      // =================================================================
      case "shutdown": {
        shutdownRequested = true;
        return success(id, "shutdown");
      }
      default: {
        const unknownCommand = command;
        return error(unknownCommand.id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
      }
    }
  };
  let detachInput = () => {
  };
  async function checkShutdownRequested() {
    if (!shutdownRequested) return;
    const currentRunner = session.extensionRunner;
    if (currentRunner?.hasHandlers("session_shutdown")) {
      await currentRunner.emit({ type: "session_shutdown" });
    }
    unsubscribe();
    embeddedInteractiveMode?.stop();
    detachInput();
    process.stdin.pause();
    process.exit(0);
  }
  const handleInputLine = async (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "extension_ui_response") {
        const response2 = parsed;
        const pending = pendingExtensionRequests.get(response2.id);
        if (pending) {
          pendingExtensionRequests.delete(response2.id);
          pending.resolve(response2);
        }
        return;
      }
      const command = parsed;
      if (!protocolLocked) {
        protocolLocked = true;
        if (command.type === "init") {
          protocolVersion = 2;
          const initResult = {
            protocolVersion: 2,
            sessionId: session.sessionId,
            capabilities: {
              events: ["execution_complete", "cost_update"],
              commands: ["init", "shutdown", "subscribe"]
            }
          };
          output(success(command.id, "init", initResult));
          return;
        }
        protocolVersion = 1;
      } else if (command.type === "init") {
        output(error(command.id, "init", "Protocol version already locked. init must be the first command."));
        return;
      }
      const response = await handleCommand(command);
      output(response);
      await checkShutdownRequested();
    } catch (e) {
      output(error(void 0, "parse", `Failed to parse command: ${e.message}`));
    }
  };
  detachInput = attachJsonlLineReader(process.stdin, (line) => {
    void handleInputLine(line);
  });
  return new Promise(() => {
  });
}
export {
  runRpcMode
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvcGktY29kaW5nLWFnZW50L3NyYy9tb2Rlcy9ycGMvcnBjLW1vZGUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUlBDIG1vZGU6IEhlYWRsZXNzIG9wZXJhdGlvbiB3aXRoIEpTT04gc3RkaW4vc3Rkb3V0IHByb3RvY29sLlxuICpcbiAqIFVzZWQgZm9yIGVtYmVkZGluZyB0aGUgYWdlbnQgaW4gb3RoZXIgYXBwbGljYXRpb25zLlxuICogUmVjZWl2ZXMgY29tbWFuZHMgYXMgSlNPTiBvbiBzdGRpbiwgb3V0cHV0cyBldmVudHMgYW5kIHJlc3BvbnNlcyBhcyBKU09OIG9uIHN0ZG91dC5cbiAqXG4gKiBQcm90b2NvbDpcbiAqIC0gQ29tbWFuZHM6IEpTT04gb2JqZWN0cyB3aXRoIGB0eXBlYCBmaWVsZCwgb3B0aW9uYWwgYGlkYCBmb3IgY29ycmVsYXRpb25cbiAqIC0gUmVzcG9uc2VzOiBKU09OIG9iamVjdHMgd2l0aCBgdHlwZTogXCJyZXNwb25zZVwiYCwgYGNvbW1hbmRgLCBgc3VjY2Vzc2AsIGFuZCBvcHRpb25hbCBgZGF0YWAvYGVycm9yYFxuICogLSBFdmVudHM6IEFnZW50U2Vzc2lvbkV2ZW50IG9iamVjdHMgc3RyZWFtZWQgYXMgdGhleSBvY2N1clxuICogLSBFeHRlbnNpb24gVUk6IEV4dGVuc2lvbiBVSSByZXF1ZXN0cyBhcmUgZW1pdHRlZCwgY2xpZW50IHJlc3BvbmRzIHdpdGggZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlXG4gKi9cblxuaW1wb3J0ICogYXMgY3J5cHRvIGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHR5cGUgeyBBZ2VudFNlc3Npb24gfSBmcm9tIFwiLi4vLi4vY29yZS9hZ2VudC1zZXNzaW9uLmpzXCI7XG5pbXBvcnQgdHlwZSB7XG5cdEV4dGVuc2lvblVJQ29udGV4dCxcblx0RXh0ZW5zaW9uVUlEaWFsb2dPcHRpb25zLFxuXHRFeHRlbnNpb25XaWRnZXRPcHRpb25zLFxufSBmcm9tIFwiLi4vLi4vY29yZS9leHRlbnNpb25zL2luZGV4LmpzXCI7XG5pbXBvcnQgeyBJbnRlcmFjdGl2ZU1vZGUgfSBmcm9tIFwiLi4vaW50ZXJhY3RpdmUvaW50ZXJhY3RpdmUtbW9kZS5qc1wiO1xuaW1wb3J0IHsgdHlwZSBUaGVtZSwgdGhlbWUgfSBmcm9tIFwiLi4vaW50ZXJhY3RpdmUvdGhlbWUvdGhlbWUuanNcIjtcbmltcG9ydCB7IGNyZWF0ZURlZmF1bHRDb21tYW5kQ29udGV4dEFjdGlvbnMgfSBmcm9tIFwiLi4vc2hhcmVkL2NvbW1hbmQtY29udGV4dC1hY3Rpb25zLmpzXCI7XG5pbXBvcnQgeyBhdHRhY2hKc29ubExpbmVSZWFkZXIsIHNlcmlhbGl6ZUpzb25MaW5lIH0gZnJvbSBcIi4vanNvbmwuanNcIjtcbmltcG9ydCB7IFJlbW90ZVRlcm1pbmFsIH0gZnJvbSBcIi4vcmVtb3RlLXRlcm1pbmFsLmpzXCI7XG5pbXBvcnQgdHlwZSB7XG5cdFJwY0NvbW1hbmQsXG5cdFJwY0V4dGVuc2lvblVJUmVxdWVzdCxcblx0UnBjRXh0ZW5zaW9uVUlSZXNwb25zZSxcblx0UnBjSW5pdFJlc3VsdCxcblx0UnBjUmVzcG9uc2UsXG5cdFJwY1Nlc3Npb25TdGF0ZSxcblx0UnBjU2xhc2hDb21tYW5kLFxufSBmcm9tIFwiLi9ycGMtdHlwZXMuanNcIjtcblxuLy8gUmUtZXhwb3J0IHR5cGVzIGZvciBjb25zdW1lcnNcbmV4cG9ydCB0eXBlIHtcblx0UnBjQ29tbWFuZCxcblx0UnBjRXh0ZW5zaW9uVUlSZXF1ZXN0LFxuXHRScGNFeHRlbnNpb25VSVJlc3BvbnNlLFxuXHRScGNJbml0UmVzdWx0LFxuXHRScGNQcm90b2NvbFZlcnNpb24sXG5cdFJwY1Jlc3BvbnNlLFxuXHRScGNTZXNzaW9uU3RhdGUsXG5cdFJwY1YyRXZlbnQsXG59IGZyb20gXCIuL3JwYy10eXBlcy5qc1wiO1xuXG4vKipcbiAqIFJ1biBpbiBSUEMgbW9kZS5cbiAqIExpc3RlbnMgZm9yIEpTT04gY29tbWFuZHMgb24gc3RkaW4sIG91dHB1dHMgZXZlbnRzIGFuZCByZXNwb25zZXMgb24gc3Rkb3V0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuUnBjTW9kZShzZXNzaW9uOiBBZ2VudFNlc3Npb24pOiBQcm9taXNlPG5ldmVyPiB7XG5cdGNvbnN0IG91dHB1dCA9IChvYmo6IFJwY1Jlc3BvbnNlIHwgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0IHwgb2JqZWN0KSA9PiB7XG5cdFx0cHJvY2Vzcy5zdGRvdXQud3JpdGUoc2VyaWFsaXplSnNvbkxpbmUob2JqKSk7XG5cdH07XG5cblx0Y29uc3Qgc3VjY2VzcyA9IDxUIGV4dGVuZHMgUnBjQ29tbWFuZFtcInR5cGVcIl0+KFxuXHRcdGlkOiBzdHJpbmcgfCB1bmRlZmluZWQsXG5cdFx0Y29tbWFuZDogVCxcblx0XHRkYXRhPzogb2JqZWN0IHwgbnVsbCxcblx0KTogUnBjUmVzcG9uc2UgPT4ge1xuXHRcdGlmIChkYXRhID09PSB1bmRlZmluZWQpIHtcblx0XHRcdHJldHVybiB7IGlkLCB0eXBlOiBcInJlc3BvbnNlXCIsIGNvbW1hbmQsIHN1Y2Nlc3M6IHRydWUgfSBhcyBScGNSZXNwb25zZTtcblx0XHR9XG5cdFx0cmV0dXJuIHsgaWQsIHR5cGU6IFwicmVzcG9uc2VcIiwgY29tbWFuZCwgc3VjY2VzczogdHJ1ZSwgZGF0YSB9IGFzIFJwY1Jlc3BvbnNlO1xuXHR9O1xuXG5cdGNvbnN0IGVycm9yID0gKGlkOiBzdHJpbmcgfCB1bmRlZmluZWQsIGNvbW1hbmQ6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nKTogUnBjUmVzcG9uc2UgPT4ge1xuXHRcdHJldHVybiB7IGlkLCB0eXBlOiBcInJlc3BvbnNlXCIsIGNvbW1hbmQsIHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogbWVzc2FnZSB9O1xuXHR9O1xuXG5cdC8vIFBlbmRpbmcgZXh0ZW5zaW9uIFVJIHJlcXVlc3RzIHdhaXRpbmcgZm9yIHJlc3BvbnNlXG5cdGNvbnN0IHBlbmRpbmdFeHRlbnNpb25SZXF1ZXN0cyA9IG5ldyBNYXA8XG5cdFx0c3RyaW5nLFxuXHRcdHsgcmVzb2x2ZTogKHZhbHVlOiBhbnkpID0+IHZvaWQ7IHJlamVjdDogKGVycm9yOiBFcnJvcikgPT4gdm9pZCB9XG5cdD4oKTtcblxuXHQvLyBTaHV0ZG93biByZXF1ZXN0IGZsYWdcblx0bGV0IHNodXRkb3duUmVxdWVzdGVkID0gZmFsc2U7XG5cblx0Ly8gdjIgcHJvdG9jb2wgdmVyc2lvbiBkZXRlY3Rpb24gc3RhdGVcblx0bGV0IHByb3RvY29sVmVyc2lvbjogMSB8IDIgPSAxO1xuXHRsZXQgcHJvdG9jb2xMb2NrZWQgPSBmYWxzZTtcblxuXHQvLyB2MiBydW5JZCB0aHJlYWRpbmc6IHRyYWNrcyB0aGUgY3VycmVudCBleGVjdXRpb24gcnVuXG5cdGxldCBjdXJyZW50UnVuSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5cdC8vIHYyIGV2ZW50IGZpbHRlcmluZzogbnVsbCA9IG5vIGZpbHRlciAoYWxsIGV2ZW50cyk7IFNldCA9IG9ubHkgbGlzdGVkIGV2ZW50IHR5cGVzXG5cdGxldCBldmVudEZpbHRlcjogU2V0PHN0cmluZz4gfCBudWxsID0gbnVsbDtcblxuXHRjb25zdCBlbWJlZGRlZFRlcm1pbmFsRW5hYmxlZCA9IHByb2Nlc3MuZW52LkdTRF9XRUJfQlJJREdFX1RVSSA9PT0gXCIxXCI7XG5cdGNvbnN0IHJlbW90ZVRlcm1pbmFsID0gZW1iZWRkZWRUZXJtaW5hbEVuYWJsZWRcblx0XHQ/IG5ldyBSZW1vdGVUZXJtaW5hbCh7XG5cdFx0XHRcdG9uV3JpdGU6IChkYXRhKSA9PiB7XG5cdFx0XHRcdFx0b3V0cHV0KHsgdHlwZTogXCJ0ZXJtaW5hbF9vdXRwdXRcIiwgZGF0YSB9KTtcblx0XHRcdFx0fSxcblx0XHRcdH0pXG5cdFx0OiBudWxsO1xuXHRsZXQgZW1iZWRkZWRJbnRlcmFjdGl2ZU1vZGU6IEludGVyYWN0aXZlTW9kZSB8IG51bGwgPSBudWxsO1xuXHRsZXQgZW1iZWRkZWRJbnRlcmFjdGl2ZUluaXRQcm9taXNlOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG5cdGNvbnN0IHN0YXJ0dXBOb3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgdHlwZT86IFwiaW5mb1wiIHwgXCJ3YXJuaW5nXCIgfCBcImVycm9yXCIgfCBcInN1Y2Nlc3NcIiB9PiA9IFtdO1xuXHRjb25zdCBzdGF0dXNTdGF0ZSA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmcgfCB1bmRlZmluZWQ+KCk7XG5cdGNvbnN0IHdpZGdldFN0YXRlID0gbmV3IE1hcDxzdHJpbmcsIHsgY29udGVudDogdW5rbm93bjsgb3B0aW9ucz86IEV4dGVuc2lvbldpZGdldE9wdGlvbnMgfT4oKTtcblx0bGV0IGZvb3RlckZhY3Rvcnk6IFBhcmFtZXRlcnM8RXh0ZW5zaW9uVUlDb250ZXh0W1wic2V0Rm9vdGVyXCJdPlswXSB8IHVuZGVmaW5lZDtcblx0bGV0IGhlYWRlckZhY3Rvcnk6IFBhcmFtZXRlcnM8RXh0ZW5zaW9uVUlDb250ZXh0W1wic2V0SGVhZGVyXCJdPlswXSB8IHVuZGVmaW5lZDtcblx0bGV0IHdvcmtpbmdNZXNzYWdlU3RhdGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0bGV0IHRpdGxlU3RhdGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcblx0bGV0IGVkaXRvclRleHRTdGF0ZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuXG5cdGNvbnN0IHdpdGhFbWJlZGRlZFVpQ29udGV4dCA9IGFzeW5jIChhcHBseTogKHVpOiBFeHRlbnNpb25VSUNvbnRleHQpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+KTogUHJvbWlzZTx2b2lkPiA9PiB7XG5cdFx0aWYgKCFlbWJlZGRlZEludGVyYWN0aXZlTW9kZSkge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRhd2FpdCBhcHBseShlbWJlZGRlZEludGVyYWN0aXZlTW9kZS5nZXRFeHRlbnNpb25VSUNvbnRleHQoKSk7XG5cdH07XG5cblx0Y29uc3QgcmVwbGF5RW1iZWRkZWRVaVN0YXRlID0gYXN5bmMgKGludGVyYWN0aXZlTW9kZTogSW50ZXJhY3RpdmVNb2RlKTogUHJvbWlzZTx2b2lkPiA9PiB7XG5cdFx0Y29uc3QgdWkgPSBpbnRlcmFjdGl2ZU1vZGUuZ2V0RXh0ZW5zaW9uVUlDb250ZXh0KCk7XG5cdFx0dWkuc2V0SGVhZGVyKGhlYWRlckZhY3RvcnkpO1xuXHRcdHVpLnNldEZvb3Rlcihmb290ZXJGYWN0b3J5KTtcblx0XHRmb3IgKGNvbnN0IFtrZXksIHRleHRdIG9mIHN0YXR1c1N0YXRlLmVudHJpZXMoKSkge1xuXHRcdFx0dWkuc2V0U3RhdHVzKGtleSwgdGV4dCk7XG5cdFx0fVxuXHRcdGZvciAoY29uc3QgW2tleSwgd2lkZ2V0XSBvZiB3aWRnZXRTdGF0ZS5lbnRyaWVzKCkpIHtcblx0XHRcdHVpLnNldFdpZGdldChrZXksIHdpZGdldC5jb250ZW50IGFzIGFueSwgd2lkZ2V0Lm9wdGlvbnMpO1xuXHRcdH1cblx0XHR1aS5zZXRXb3JraW5nTWVzc2FnZSh3b3JraW5nTWVzc2FnZVN0YXRlKTtcblx0XHRpZiAodGl0bGVTdGF0ZSkge1xuXHRcdFx0dWkuc2V0VGl0bGUodGl0bGVTdGF0ZSk7XG5cdFx0fVxuXHRcdGlmIChlZGl0b3JUZXh0U3RhdGUgIT09IHVuZGVmaW5lZCkge1xuXHRcdFx0dWkuc2V0RWRpdG9yVGV4dChlZGl0b3JUZXh0U3RhdGUpO1xuXHRcdH1cblx0XHRmb3IgKGNvbnN0IHsgbWVzc2FnZSwgdHlwZSB9IG9mIHN0YXJ0dXBOb3RpZmljYXRpb25zKSB7XG5cdFx0XHR1aS5ub3RpZnkobWVzc2FnZSwgdHlwZSk7XG5cdFx0fVxuXHR9O1xuXG5cdGNvbnN0IGVuc3VyZUVtYmVkZGVkSW50ZXJhY3RpdmVNb2RlID0gYXN5bmMgKCk6IFByb21pc2U8SW50ZXJhY3RpdmVNb2RlPiA9PiB7XG5cdFx0aWYgKCFlbWJlZGRlZFRlcm1pbmFsRW5hYmxlZCB8fCAhcmVtb3RlVGVybWluYWwpIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcihcIkVtYmVkZGVkIHRlcm1pbmFsIGlzIG5vdCBlbmFibGVkIGZvciB0aGlzIFJQQyBob3N0XCIpO1xuXHRcdH1cblxuXHRcdGlmIChlbWJlZGRlZEludGVyYWN0aXZlTW9kZSkge1xuXHRcdFx0cmV0dXJuIGVtYmVkZGVkSW50ZXJhY3RpdmVNb2RlO1xuXHRcdH1cblxuXHRcdGlmICghZW1iZWRkZWRJbnRlcmFjdGl2ZUluaXRQcm9taXNlKSB7XG5cdFx0XHRlbWJlZGRlZEludGVyYWN0aXZlTW9kZSA9IG5ldyBJbnRlcmFjdGl2ZU1vZGUoc2Vzc2lvbiwge1xuXHRcdFx0XHR0ZXJtaW5hbDogcmVtb3RlVGVybWluYWwsXG5cdFx0XHRcdGJpbmRFeHRlbnNpb25zOiBmYWxzZSxcblx0XHRcdFx0c3VibWl0UHJvbXB0c0RpcmVjdGx5OiB0cnVlLFxuXHRcdFx0XHRzaHV0ZG93bkJlaGF2aW9yOiBcImlnbm9yZVwiLFxuXHRcdFx0fSk7XG5cdFx0XHRlbWJlZGRlZEludGVyYWN0aXZlSW5pdFByb21pc2UgPSBlbWJlZGRlZEludGVyYWN0aXZlTW9kZS5pbml0KCkudGhlbihhc3luYyAoKSA9PiB7XG5cdFx0XHRcdGF3YWl0IHJlcGxheUVtYmVkZGVkVWlTdGF0ZShlbWJlZGRlZEludGVyYWN0aXZlTW9kZSEpO1xuXHRcdFx0fSkuY2F0Y2goKGVycm9yKSA9PiB7XG5cdFx0XHRcdGVtYmVkZGVkSW50ZXJhY3RpdmVNb2RlID0gbnVsbDtcblx0XHRcdFx0dGhyb3cgZXJyb3I7XG5cdFx0XHR9KS5maW5hbGx5KCgpID0+IHtcblx0XHRcdFx0ZW1iZWRkZWRJbnRlcmFjdGl2ZUluaXRQcm9taXNlID0gbnVsbDtcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdGF3YWl0IGVtYmVkZGVkSW50ZXJhY3RpdmVJbml0UHJvbWlzZTtcblx0XHRyZXR1cm4gZW1iZWRkZWRJbnRlcmFjdGl2ZU1vZGUhO1xuXHR9O1xuXG5cdC8qKiBIZWxwZXIgZm9yIGRpYWxvZyBtZXRob2RzIHdpdGggc2lnbmFsL3RpbWVvdXQgc3VwcG9ydCAqL1xuXHRmdW5jdGlvbiBjcmVhdGVEaWFsb2dQcm9taXNlPFQ+KFxuXHRcdG9wdHM6IEV4dGVuc2lvblVJRGlhbG9nT3B0aW9ucyB8IHVuZGVmaW5lZCxcblx0XHRkZWZhdWx0VmFsdWU6IFQsXG5cdFx0cmVxdWVzdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG5cdFx0cGFyc2VSZXNwb25zZTogKHJlc3BvbnNlOiBScGNFeHRlbnNpb25VSVJlc3BvbnNlKSA9PiBULFxuXHQpOiBQcm9taXNlPFQ+IHtcblx0XHRpZiAob3B0cz8uc2lnbmFsPy5hYm9ydGVkKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGRlZmF1bHRWYWx1ZSk7XG5cblx0XHRjb25zdCBpZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG5cdFx0cmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblx0XHRcdGxldCB0aW1lb3V0SWQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuXG5cdFx0XHRjb25zdCBjbGVhbnVwID0gKCkgPT4ge1xuXHRcdFx0XHRpZiAodGltZW91dElkKSBjbGVhclRpbWVvdXQodGltZW91dElkKTtcblx0XHRcdFx0b3B0cz8uc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCk7XG5cdFx0XHRcdHBlbmRpbmdFeHRlbnNpb25SZXF1ZXN0cy5kZWxldGUoaWQpO1xuXHRcdFx0fTtcblxuXHRcdFx0Y29uc3Qgb25BYm9ydCA9ICgpID0+IHtcblx0XHRcdFx0Y2xlYW51cCgpO1xuXHRcdFx0XHRyZXNvbHZlKGRlZmF1bHRWYWx1ZSk7XG5cdFx0XHR9O1xuXHRcdFx0b3B0cz8uc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuXG5cdFx0XHRpZiAob3B0cz8udGltZW91dCkge1xuXHRcdFx0XHR0aW1lb3V0SWQgPSBzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0XHRjbGVhbnVwKCk7XG5cdFx0XHRcdFx0cmVzb2x2ZShkZWZhdWx0VmFsdWUpO1xuXHRcdFx0XHR9LCBvcHRzLnRpbWVvdXQpO1xuXHRcdFx0fVxuXG5cdFx0XHRwZW5kaW5nRXh0ZW5zaW9uUmVxdWVzdHMuc2V0KGlkLCB7XG5cdFx0XHRcdHJlc29sdmU6IChyZXNwb25zZTogUnBjRXh0ZW5zaW9uVUlSZXNwb25zZSkgPT4ge1xuXHRcdFx0XHRcdGNsZWFudXAoKTtcblx0XHRcdFx0XHRyZXNvbHZlKHBhcnNlUmVzcG9uc2UocmVzcG9uc2UpKTtcblx0XHRcdFx0fSxcblx0XHRcdFx0cmVqZWN0LFxuXHRcdFx0fSk7XG5cdFx0XHRvdXRwdXQoeyB0eXBlOiBcImV4dGVuc2lvbl91aV9yZXF1ZXN0XCIsIGlkLCAuLi5yZXF1ZXN0IH0gYXMgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0KTtcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDcmVhdGUgYW4gZXh0ZW5zaW9uIFVJIGNvbnRleHQgdGhhdCB1c2VzIHRoZSBSUEMgcHJvdG9jb2wuXG5cdCAqL1xuXHRjb25zdCBjcmVhdGVFeHRlbnNpb25VSUNvbnRleHQgPSAoKTogRXh0ZW5zaW9uVUlDb250ZXh0ID0+ICh7XG5cdFx0c2VsZWN0OiAodGl0bGUsIG9wdGlvbnMsIG9wdHMpID0+XG5cdFx0XHRjcmVhdGVEaWFsb2dQcm9taXNlKG9wdHMsIHVuZGVmaW5lZCwgeyBtZXRob2Q6IFwic2VsZWN0XCIsIHRpdGxlLCBvcHRpb25zLCB0aW1lb3V0OiBvcHRzPy50aW1lb3V0LCBhbGxvd011bHRpcGxlOiBvcHRzPy5hbGxvd011bHRpcGxlIH0sIChyKSA9PlxuXHRcdFx0XHRcImNhbmNlbGxlZFwiIGluIHIgJiYgci5jYW5jZWxsZWQgPyB1bmRlZmluZWQgOiBcInZhbHVlc1wiIGluIHIgPyByLnZhbHVlcyA6IFwidmFsdWVcIiBpbiByID8gci52YWx1ZSA6IHVuZGVmaW5lZCxcblx0XHRcdCksXG5cblx0XHRjb25maXJtOiAodGl0bGUsIG1lc3NhZ2UsIG9wdHMpID0+XG5cdFx0XHRjcmVhdGVEaWFsb2dQcm9taXNlKG9wdHMsIGZhbHNlLCB7IG1ldGhvZDogXCJjb25maXJtXCIsIHRpdGxlLCBtZXNzYWdlLCB0aW1lb3V0OiBvcHRzPy50aW1lb3V0IH0sIChyKSA9PlxuXHRcdFx0XHRcImNhbmNlbGxlZFwiIGluIHIgJiYgci5jYW5jZWxsZWQgPyBmYWxzZSA6IFwiY29uZmlybWVkXCIgaW4gciA/IHIuY29uZmlybWVkIDogZmFsc2UsXG5cdFx0XHQpLFxuXG5cdFx0aW5wdXQ6ICh0aXRsZSwgcGxhY2Vob2xkZXIsIG9wdHMpID0+XG5cdFx0XHRjcmVhdGVEaWFsb2dQcm9taXNlKG9wdHMsIHVuZGVmaW5lZCwgeyBtZXRob2Q6IFwiaW5wdXRcIiwgdGl0bGUsIHBsYWNlaG9sZGVyLCB0aW1lb3V0OiBvcHRzPy50aW1lb3V0LCBzZWN1cmU6IG9wdHM/LnNlY3VyZSB9LCAocikgPT5cblx0XHRcdFx0XCJjYW5jZWxsZWRcIiBpbiByICYmIHIuY2FuY2VsbGVkID8gdW5kZWZpbmVkIDogXCJ2YWx1ZVwiIGluIHIgPyByLnZhbHVlIDogdW5kZWZpbmVkLFxuXHRcdFx0KSxcblxuXHRcdG5vdGlmeShtZXNzYWdlOiBzdHJpbmcsIHR5cGU/OiBcImluZm9cIiB8IFwid2FybmluZ1wiIHwgXCJlcnJvclwiIHwgXCJzdWNjZXNzXCIpOiB2b2lkIHtcblx0XHRcdHN0YXJ0dXBOb3RpZmljYXRpb25zLnB1c2goeyBtZXNzYWdlLCB0eXBlIH0pO1xuXHRcdFx0aWYgKHN0YXJ0dXBOb3RpZmljYXRpb25zLmxlbmd0aCA+IDIwKSB7XG5cdFx0XHRcdHN0YXJ0dXBOb3RpZmljYXRpb25zLnNwbGljZSgwLCBzdGFydHVwTm90aWZpY2F0aW9ucy5sZW5ndGggLSAyMCk7XG5cdFx0XHR9XG5cdFx0XHQvLyBGaXJlIGFuZCBmb3JnZXQgLSBubyByZXNwb25zZSBuZWVkZWRcblx0XHRcdG91dHB1dCh7XG5cdFx0XHRcdHR5cGU6IFwiZXh0ZW5zaW9uX3VpX3JlcXVlc3RcIixcblx0XHRcdFx0aWQ6IGNyeXB0by5yYW5kb21VVUlEKCksXG5cdFx0XHRcdG1ldGhvZDogXCJub3RpZnlcIixcblx0XHRcdFx0bWVzc2FnZSxcblx0XHRcdFx0bm90aWZ5VHlwZTogdHlwZSxcblx0XHRcdH0gYXMgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0KTtcblx0XHRcdHZvaWQgd2l0aEVtYmVkZGVkVWlDb250ZXh0KCh1aSkgPT4ge1xuXHRcdFx0XHR1aS5ub3RpZnkobWVzc2FnZSwgdHlwZSk7XG5cdFx0XHR9KTtcblx0XHR9LFxuXG5cdFx0b25UZXJtaW5hbElucHV0KCk6ICgpID0+IHZvaWQge1xuXHRcdFx0Ly8gUmF3IHRlcm1pbmFsIGlucHV0IG5vdCBzdXBwb3J0ZWQgaW4gUlBDIG1vZGVcblx0XHRcdHJldHVybiAoKSA9PiB7fTtcblx0XHR9LFxuXG5cdFx0c2V0U3RhdHVzKGtleTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcgfCB1bmRlZmluZWQpOiB2b2lkIHtcblx0XHRcdHN0YXR1c1N0YXRlLnNldChrZXksIHRleHQpO1xuXHRcdFx0Ly8gRmlyZSBhbmQgZm9yZ2V0IC0gbm8gcmVzcG9uc2UgbmVlZGVkXG5cdFx0XHRvdXRwdXQoe1xuXHRcdFx0XHR0eXBlOiBcImV4dGVuc2lvbl91aV9yZXF1ZXN0XCIsXG5cdFx0XHRcdGlkOiBjcnlwdG8ucmFuZG9tVVVJRCgpLFxuXHRcdFx0XHRtZXRob2Q6IFwic2V0U3RhdHVzXCIsXG5cdFx0XHRcdHN0YXR1c0tleToga2V5LFxuXHRcdFx0XHRzdGF0dXNUZXh0OiB0ZXh0LFxuXHRcdFx0fSBhcyBScGNFeHRlbnNpb25VSVJlcXVlc3QpO1xuXHRcdFx0dm9pZCB3aXRoRW1iZWRkZWRVaUNvbnRleHQoKHVpKSA9PiB7XG5cdFx0XHRcdHVpLnNldFN0YXR1cyhrZXksIHRleHQpO1xuXHRcdFx0fSk7XG5cdFx0fSxcblxuXHRcdHNldFdvcmtpbmdNZXNzYWdlKG1lc3NhZ2U/OiBzdHJpbmcpOiB2b2lkIHtcblx0XHRcdHdvcmtpbmdNZXNzYWdlU3RhdGUgPSBtZXNzYWdlO1xuXHRcdFx0dm9pZCB3aXRoRW1iZWRkZWRVaUNvbnRleHQoKHVpKSA9PiB7XG5cdFx0XHRcdHVpLnNldFdvcmtpbmdNZXNzYWdlKG1lc3NhZ2UpO1xuXHRcdFx0fSk7XG5cdFx0fSxcblxuXHRcdHNldFdpZGdldChrZXk6IHN0cmluZywgY29udGVudDogdW5rbm93biwgb3B0aW9ucz86IEV4dGVuc2lvbldpZGdldE9wdGlvbnMpOiB2b2lkIHtcblx0XHRcdHdpZGdldFN0YXRlLnNldChrZXksIHsgY29udGVudCwgb3B0aW9ucyB9KTtcblx0XHRcdGlmIChjb250ZW50ID09PSB1bmRlZmluZWQgfHwgQXJyYXkuaXNBcnJheShjb250ZW50KSkge1xuXHRcdFx0XHRvdXRwdXQoe1xuXHRcdFx0XHRcdHR5cGU6IFwiZXh0ZW5zaW9uX3VpX3JlcXVlc3RcIixcblx0XHRcdFx0XHRpZDogY3J5cHRvLnJhbmRvbVVVSUQoKSxcblx0XHRcdFx0XHRtZXRob2Q6IFwic2V0V2lkZ2V0XCIsXG5cdFx0XHRcdFx0d2lkZ2V0S2V5OiBrZXksXG5cdFx0XHRcdFx0d2lkZ2V0TGluZXM6IGNvbnRlbnQgYXMgc3RyaW5nW10gfCB1bmRlZmluZWQsXG5cdFx0XHRcdFx0d2lkZ2V0UGxhY2VtZW50OiBvcHRpb25zPy5wbGFjZW1lbnQsXG5cdFx0XHRcdH0gYXMgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0KTtcblx0XHRcdH0gZWxzZSBpZiAodHlwZW9mIGNvbnRlbnQgPT09IFwiZnVuY3Rpb25cIikge1xuXHRcdFx0XHQvLyBGYWN0b3J5LWJhc2VkIHdpZGdldHMgcmVxdWlyZSBUVUkgYWNjZXNzIHdoaWNoIFJQQyBtb2RlIGRvZXMgbm90IGhhdmUuXG5cdFx0XHRcdC8vIEVtaXQgYSBtaW5pbWFsIHBsYWNlaG9sZGVyIHNvIHRoZSBSUEMgY2xpZW50IGtub3dzIGEgd2lkZ2V0IHdhcyByZXF1ZXN0ZWQuXG5cdFx0XHRcdG91dHB1dCh7XG5cdFx0XHRcdFx0dHlwZTogXCJleHRlbnNpb25fdWlfcmVxdWVzdFwiLFxuXHRcdFx0XHRcdGlkOiBjcnlwdG8ucmFuZG9tVVVJRCgpLFxuXHRcdFx0XHRcdG1ldGhvZDogXCJzZXRXaWRnZXRcIixcblx0XHRcdFx0XHR3aWRnZXRLZXk6IGtleSxcblx0XHRcdFx0XHR3aWRnZXRMaW5lczogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdHdpZGdldFBsYWNlbWVudDogb3B0aW9ucz8ucGxhY2VtZW50LFxuXHRcdFx0XHR9IGFzIFJwY0V4dGVuc2lvblVJUmVxdWVzdCk7XG5cdFx0XHR9XG5cdFx0XHR2b2lkIHdpdGhFbWJlZGRlZFVpQ29udGV4dCgodWkpID0+IHtcblx0XHRcdFx0dWkuc2V0V2lkZ2V0KGtleSwgY29udGVudCBhcyBhbnksIG9wdGlvbnMpO1xuXHRcdFx0fSk7XG5cdFx0fSxcblxuXHRcdHNldEZvb3RlcihmYWN0b3J5OiBQYXJhbWV0ZXJzPEV4dGVuc2lvblVJQ29udGV4dFtcInNldEZvb3RlclwiXT5bMF0pOiB2b2lkIHtcblx0XHRcdGZvb3RlckZhY3RvcnkgPSBmYWN0b3J5O1xuXHRcdFx0dm9pZCB3aXRoRW1iZWRkZWRVaUNvbnRleHQoKHVpKSA9PiB7XG5cdFx0XHRcdHVpLnNldEZvb3RlcihmYWN0b3J5KTtcblx0XHRcdH0pO1xuXHRcdH0sXG5cblx0XHRzZXRIZWFkZXIoZmFjdG9yeTogUGFyYW1ldGVyczxFeHRlbnNpb25VSUNvbnRleHRbXCJzZXRIZWFkZXJcIl0+WzBdKTogdm9pZCB7XG5cdFx0XHRoZWFkZXJGYWN0b3J5ID0gZmFjdG9yeTtcblx0XHRcdHZvaWQgd2l0aEVtYmVkZGVkVWlDb250ZXh0KCh1aSkgPT4ge1xuXHRcdFx0XHR1aS5zZXRIZWFkZXIoZmFjdG9yeSk7XG5cdFx0XHR9KTtcblx0XHR9LFxuXG5cdFx0c2V0VGl0bGUodGl0bGU6IHN0cmluZyk6IHZvaWQge1xuXHRcdFx0dGl0bGVTdGF0ZSA9IHRpdGxlO1xuXHRcdFx0Ly8gRmlyZSBhbmQgZm9yZ2V0IC0gaG9zdCBjYW4gaW1wbGVtZW50IHRlcm1pbmFsIHRpdGxlIGNvbnRyb2xcblx0XHRcdG91dHB1dCh7XG5cdFx0XHRcdHR5cGU6IFwiZXh0ZW5zaW9uX3VpX3JlcXVlc3RcIixcblx0XHRcdFx0aWQ6IGNyeXB0by5yYW5kb21VVUlEKCksXG5cdFx0XHRcdG1ldGhvZDogXCJzZXRUaXRsZVwiLFxuXHRcdFx0XHR0aXRsZSxcblx0XHRcdH0gYXMgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0KTtcblx0XHRcdHZvaWQgd2l0aEVtYmVkZGVkVWlDb250ZXh0KCh1aSkgPT4ge1xuXHRcdFx0XHR1aS5zZXRUaXRsZSh0aXRsZSk7XG5cdFx0XHR9KTtcblx0XHR9LFxuXG5cdFx0YXN5bmMgY3VzdG9tKCkge1xuXHRcdFx0Ly8gQ3VzdG9tIFVJIG5vdCBzdXBwb3J0ZWQgaW4gUlBDIG1vZGVcblx0XHRcdHJldHVybiB1bmRlZmluZWQgYXMgbmV2ZXI7XG5cdFx0fSxcblxuXHRcdHBhc3RlVG9FZGl0b3IodGV4dDogc3RyaW5nKTogdm9pZCB7XG5cdFx0XHQvLyBQYXN0ZSBoYW5kbGluZyBub3Qgc3VwcG9ydGVkIGluIFJQQyBtb2RlIC0gZmFsbHMgYmFjayB0byBzZXRFZGl0b3JUZXh0XG5cdFx0XHR0aGlzLnNldEVkaXRvclRleHQodGV4dCk7XG5cdFx0fSxcblxuXHRcdHNldEVkaXRvclRleHQodGV4dDogc3RyaW5nKTogdm9pZCB7XG5cdFx0XHRlZGl0b3JUZXh0U3RhdGUgPSB0ZXh0O1xuXHRcdFx0Ly8gRmlyZSBhbmQgZm9yZ2V0IC0gaG9zdCBjYW4gaW1wbGVtZW50IGVkaXRvciBjb250cm9sXG5cdFx0XHRvdXRwdXQoe1xuXHRcdFx0XHR0eXBlOiBcImV4dGVuc2lvbl91aV9yZXF1ZXN0XCIsXG5cdFx0XHRcdGlkOiBjcnlwdG8ucmFuZG9tVVVJRCgpLFxuXHRcdFx0XHRtZXRob2Q6IFwic2V0X2VkaXRvcl90ZXh0XCIsXG5cdFx0XHRcdHRleHQsXG5cdFx0XHR9IGFzIFJwY0V4dGVuc2lvblVJUmVxdWVzdCk7XG5cdFx0XHR2b2lkIHdpdGhFbWJlZGRlZFVpQ29udGV4dCgodWkpID0+IHtcblx0XHRcdFx0dWkuc2V0RWRpdG9yVGV4dCh0ZXh0KTtcblx0XHRcdH0pO1xuXHRcdH0sXG5cblx0XHRnZXRFZGl0b3JUZXh0KCk6IHN0cmluZyB7XG5cdFx0XHQvLyBTeW5jaHJvbm91cyBtZXRob2QgY2FuJ3Qgd2FpdCBmb3IgUlBDIHJlc3BvbnNlXG5cdFx0XHQvLyBIb3N0IHNob3VsZCB0cmFjayBlZGl0b3Igc3RhdGUgbG9jYWxseSBpZiBuZWVkZWRcblx0XHRcdHJldHVybiBcIlwiO1xuXHRcdH0sXG5cblx0XHRhc3luYyBlZGl0b3IodGl0bGU6IHN0cmluZywgcHJlZmlsbD86IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG5cdFx0XHRjb25zdCBpZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG5cdFx0XHRyZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXHRcdFx0XHRwZW5kaW5nRXh0ZW5zaW9uUmVxdWVzdHMuc2V0KGlkLCB7XG5cdFx0XHRcdFx0cmVzb2x2ZTogKHJlc3BvbnNlOiBScGNFeHRlbnNpb25VSVJlc3BvbnNlKSA9PiB7XG5cdFx0XHRcdFx0XHRpZiAoXCJjYW5jZWxsZWRcIiBpbiByZXNwb25zZSAmJiByZXNwb25zZS5jYW5jZWxsZWQpIHtcblx0XHRcdFx0XHRcdFx0cmVzb2x2ZSh1bmRlZmluZWQpO1xuXHRcdFx0XHRcdFx0fSBlbHNlIGlmIChcInZhbHVlXCIgaW4gcmVzcG9uc2UpIHtcblx0XHRcdFx0XHRcdFx0cmVzb2x2ZShyZXNwb25zZS52YWx1ZSk7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRyZXNvbHZlKHVuZGVmaW5lZCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSxcblx0XHRcdFx0XHRyZWplY3QsXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRvdXRwdXQoeyB0eXBlOiBcImV4dGVuc2lvbl91aV9yZXF1ZXN0XCIsIGlkLCBtZXRob2Q6IFwiZWRpdG9yXCIsIHRpdGxlLCBwcmVmaWxsIH0gYXMgUnBjRXh0ZW5zaW9uVUlSZXF1ZXN0KTtcblx0XHRcdH0pO1xuXHRcdH0sXG5cblx0XHRzZXRFZGl0b3JDb21wb25lbnQoKTogdm9pZCB7XG5cdFx0XHQvLyBDdXN0b20gZWRpdG9yIGNvbXBvbmVudHMgbm90IHN1cHBvcnRlZCBpbiBSUEMgbW9kZVxuXHRcdH0sXG5cblx0XHRnZXQgdGhlbWUoKSB7XG5cdFx0XHRyZXR1cm4gdGhlbWU7XG5cdFx0fSxcblxuXHRcdGdldEFsbFRoZW1lcygpIHtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9LFxuXG5cdFx0Z2V0VGhlbWUoX25hbWU6IHN0cmluZykge1xuXHRcdFx0cmV0dXJuIHVuZGVmaW5lZDtcblx0XHR9LFxuXG5cdFx0c2V0VGhlbWUoX3RoZW1lOiBzdHJpbmcgfCBUaGVtZSkge1xuXHRcdFx0Ly8gVGhlbWUgc3dpdGNoaW5nIG5vdCBzdXBwb3J0ZWQgaW4gUlBDIG1vZGVcblx0XHRcdHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJUaGVtZSBzd2l0Y2hpbmcgbm90IHN1cHBvcnRlZCBpbiBSUEMgbW9kZVwiIH07XG5cdFx0fSxcblxuXHRcdGdldFRvb2xzRXhwYW5kZWQoKSB7XG5cdFx0XHQvLyBUb29sIGV4cGFuc2lvbiBub3Qgc3VwcG9ydGVkIGluIFJQQyBtb2RlIC0gbm8gVFVJXG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fSxcblxuXHRcdHNldFRvb2xzRXhwYW5kZWQoX2V4cGFuZGVkOiBib29sZWFuKSB7XG5cdFx0XHQvLyBUb29sIGV4cGFuc2lvbiBub3Qgc3VwcG9ydGVkIGluIFJQQyBtb2RlIC0gbm8gVFVJXG5cdFx0fSxcblx0fSk7XG5cblx0Ly8gU2V0IHVwIGV4dGVuc2lvbnMgd2l0aCBSUEMtYmFzZWQgVUkgY29udGV4dC5cblx0Ly8gRG8gbm90IGJsb2NrIHRoZSBpbml0aWFsIFJQQyBoYW5kc2hha2Ugb24gZXh0ZW5zaW9uIHNlc3Npb25fc3RhcnQgaG9va3M6XG5cdC8vIGJyb3dzZXIgYm9vdCBvbmx5IG5lZWRzIGdldF9zdGF0ZSwgYW5kIHNldmVyYWwgc3RhcnR1cC1vbmx5IG5vdGlmaWNhdGlvbnNcblx0Ly8gKE1DUCBhdmFpbGFiaWxpdHksIHdlYi1zZWFyY2ggc3RhdHVzLCBldGMuKSBjYW4gY29tcGxldGUgaW4gdGhlIGJhY2tncm91bmQuXG5cdC8vIFRyYWNrIHJlYWRpbmVzcyBzbyBjb25zdW1lcnMgY2FuIGtub3cgd2hlbiBleHRlbnNpb24gY29tbWFuZHMgYXJlIGF2YWlsYWJsZS5cblx0bGV0IGV4dGVuc2lvbnNSZWFkeSA9IGZhbHNlO1xuXHRjb25zdCBleHRlbnNpb25zUmVhZHlQcm9taXNlID0gc2Vzc2lvbi5iaW5kRXh0ZW5zaW9ucyh7XG5cdFx0dWlDb250ZXh0OiBjcmVhdGVFeHRlbnNpb25VSUNvbnRleHQoKSxcblx0XHRjb21tYW5kQ29udGV4dEFjdGlvbnM6IGNyZWF0ZURlZmF1bHRDb21tYW5kQ29udGV4dEFjdGlvbnMoc2Vzc2lvbiksXG5cdFx0c2h1dGRvd25IYW5kbGVyOiAoKSA9PiB7XG5cdFx0XHRzaHV0ZG93blJlcXVlc3RlZCA9IHRydWU7XG5cdFx0fSxcblx0XHRvbkVycm9yOiAoZXJyKSA9PiB7XG5cdFx0XHRvdXRwdXQoeyB0eXBlOiBcImV4dGVuc2lvbl9lcnJvclwiLCBleHRlbnNpb25QYXRoOiBlcnIuZXh0ZW5zaW9uUGF0aCwgZXZlbnQ6IGVyci5ldmVudCwgZXJyb3I6IGVyci5lcnJvciB9KTtcblx0XHR9LFxuXHR9KS50aGVuKCgpID0+IHtcblx0XHRleHRlbnNpb25zUmVhZHkgPSB0cnVlO1xuXHRcdG91dHB1dCh7IHR5cGU6IFwiZXh0ZW5zaW9uc19yZWFkeVwiIH0pO1xuXHR9KS5jYXRjaCgoZXJyb3IpID0+IHtcblx0XHRleHRlbnNpb25zUmVhZHkgPSB0cnVlOyAvLyBNYXJrIHJlYWR5IGV2ZW4gb24gZmFpbHVyZSBzbyBjb25zdW1lcnMgZG9uJ3Qgd2FpdCBmb3JldmVyXG5cdFx0b3V0cHV0KHtcblx0XHRcdHR5cGU6IFwiZXh0ZW5zaW9uX2Vycm9yXCIsXG5cdFx0XHRldmVudDogXCJzZXNzaW9uX3N0YXJ0XCIsXG5cdFx0XHRlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpLFxuXHRcdH0pO1xuXHR9KTtcblx0dm9pZCBleHRlbnNpb25zUmVhZHlQcm9taXNlO1xuXG5cdC8vIE91dHB1dCBhbGwgYWdlbnQgZXZlbnRzIGFzIEpTT05cblx0Y29uc3QgdW5zdWJzY3JpYmUgPSBzZXNzaW9uLnN1YnNjcmliZSgoZXZlbnQpID0+IHtcblx0XHQvLyB2MjogZW1pdCBzeW50aGVzaXplZCBldmVudHMgYmVmb3JlIHRoZSByZWd1bGFyIGV2ZW50XG5cdFx0aWYgKHByb3RvY29sVmVyc2lvbiA9PT0gMikge1xuXHRcdFx0Ly8gY29zdF91cGRhdGUgb24gYXNzaXN0YW50IG1lc3NhZ2VfZW5kXG5cdFx0XHRpZiAoZXZlbnQudHlwZSA9PT0gXCJtZXNzYWdlX2VuZFwiICYmIGV2ZW50Lm1lc3NhZ2Uucm9sZSA9PT0gXCJhc3Npc3RhbnRcIiAmJiBjdXJyZW50UnVuSWQpIHtcblx0XHRcdFx0Y29uc3Qgc3RhdHMgPSBzZXNzaW9uLmdldFNlc3Npb25TdGF0cygpO1xuXHRcdFx0XHRjb25zdCBjb3N0VXBkYXRlID0ge1xuXHRcdFx0XHRcdHR5cGU6IFwiY29zdF91cGRhdGVcIiBhcyBjb25zdCxcblx0XHRcdFx0XHRydW5JZDogY3VycmVudFJ1bklkLFxuXHRcdFx0XHRcdHR1cm5Db3N0OiBzZXNzaW9uLmdldExhc3RUdXJuQ29zdCgpLFxuXHRcdFx0XHRcdGN1bXVsYXRpdmVDb3N0OiBzdGF0cy5jb3N0LFxuXHRcdFx0XHRcdHRva2Vuczoge1xuXHRcdFx0XHRcdFx0aW5wdXQ6IHN0YXRzLnRva2Vucy5pbnB1dCxcblx0XHRcdFx0XHRcdG91dHB1dDogc3RhdHMudG9rZW5zLm91dHB1dCxcblx0XHRcdFx0XHRcdGNhY2hlUmVhZDogc3RhdHMudG9rZW5zLmNhY2hlUmVhZCxcblx0XHRcdFx0XHRcdGNhY2hlV3JpdGU6IHN0YXRzLnRva2Vucy5jYWNoZVdyaXRlLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH07XG5cdFx0XHRcdGlmICghZXZlbnRGaWx0ZXIgfHwgZXZlbnRGaWx0ZXIuaGFzKFwiY29zdF91cGRhdGVcIikpIHtcblx0XHRcdFx0XHRvdXRwdXQoY29zdFVwZGF0ZSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gZXhlY3V0aW9uX2NvbXBsZXRlIG9uIGFnZW50X2VuZFxuXHRcdFx0aWYgKGV2ZW50LnR5cGUgPT09IFwiYWdlbnRfZW5kXCIgJiYgY3VycmVudFJ1bklkKSB7XG5cdFx0XHRcdGNvbnN0IHN0YXRzID0gc2Vzc2lvbi5nZXRTZXNzaW9uU3RhdHMoKTtcblx0XHRcdFx0Y29uc3QgY29tcGxldGlvbkV2ZW50ID0ge1xuXHRcdFx0XHRcdHR5cGU6IFwiZXhlY3V0aW9uX2NvbXBsZXRlXCIgYXMgY29uc3QsXG5cdFx0XHRcdFx0cnVuSWQ6IGN1cnJlbnRSdW5JZCxcblx0XHRcdFx0XHRzdGF0dXM6IFwiY29tcGxldGVkXCIgYXMgY29uc3QsXG5cdFx0XHRcdFx0c3RhdHMsXG5cdFx0XHRcdH07XG5cdFx0XHRcdGlmICghZXZlbnRGaWx0ZXIgfHwgZXZlbnRGaWx0ZXIuaGFzKFwiZXhlY3V0aW9uX2NvbXBsZXRlXCIpKSB7XG5cdFx0XHRcdFx0b3V0cHV0KGNvbXBsZXRpb25FdmVudCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y3VycmVudFJ1bklkID0gbnVsbDtcblx0XHRcdH1cblx0XHR9XG5cblx0XHQvLyBBcHBseSBldmVudCBmaWx0ZXIgKHYyIG9ubHksIGFwcGxpZXMgdG8gYWdlbnQgc2Vzc2lvbiBldmVudHMgb25seSlcblx0XHRpZiAocHJvdG9jb2xWZXJzaW9uID09PSAyICYmIGV2ZW50RmlsdGVyICYmICFldmVudEZpbHRlci5oYXMoZXZlbnQudHlwZSkpIHtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBFbWl0IHRoZSByZWd1bGFyIGV2ZW50LCB3aXRoIHJ1bklkIGluamVjdGlvbiBpbiB2MiBtb2RlXG5cdFx0aWYgKHByb3RvY29sVmVyc2lvbiA9PT0gMiAmJiBjdXJyZW50UnVuSWQpIHtcblx0XHRcdG91dHB1dCh7IC4uLmV2ZW50LCBydW5JZDogY3VycmVudFJ1bklkIH0pO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRvdXRwdXQoZXZlbnQpO1xuXHRcdH1cblx0fSk7XG5cblx0Ly8gSGFuZGxlIGEgc2luZ2xlIGNvbW1hbmRcblx0Y29uc3QgaGFuZGxlQ29tbWFuZCA9IGFzeW5jIChjb21tYW5kOiBScGNDb21tYW5kKTogUHJvbWlzZTxScGNSZXNwb25zZT4gPT4ge1xuXHRcdGNvbnN0IGlkID0gY29tbWFuZC5pZDtcblxuXHRcdHN3aXRjaCAoY29tbWFuZC50eXBlKSB7XG5cdFx0XHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHRcdFx0Ly8gUHJvbXB0aW5nXG5cdFx0XHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdFx0XHRjYXNlIFwicHJvbXB0XCI6IHtcblx0XHRcdFx0Ly8gdjI6IGdlbmVyYXRlIHJ1bklkIGZvciBleGVjdXRpb24gdHJhY2tpbmdcblx0XHRcdFx0Y29uc3QgcnVuSWQgPSBwcm90b2NvbFZlcnNpb24gPT09IDIgPyBjcnlwdG8ucmFuZG9tVVVJRCgpIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRpZiAocnVuSWQpIGN1cnJlbnRSdW5JZCA9IHJ1bklkO1xuXHRcdFx0XHQvLyBEb24ndCBhd2FpdCAtIGV2ZW50cyB3aWxsIHN0cmVhbVxuXHRcdFx0XHQvLyBFeHRlbnNpb24gY29tbWFuZHMgYXJlIGV4ZWN1dGVkIGltbWVkaWF0ZWx5LCBmaWxlIHByb21wdCB0ZW1wbGF0ZXMgYXJlIGV4cGFuZGVkXG5cdFx0XHRcdC8vIElmIHN0cmVhbWluZyBhbmQgc3RyZWFtaW5nQmVoYXZpb3Igc3BlY2lmaWVkLCBxdWV1ZXMgdmlhIHN0ZWVyL2ZvbGxvd1VwXG5cdFx0XHRcdHNlc3Npb25cblx0XHRcdFx0XHQucHJvbXB0KGNvbW1hbmQubWVzc2FnZSwge1xuXHRcdFx0XHRcdFx0aW1hZ2VzOiBjb21tYW5kLmltYWdlcyxcblx0XHRcdFx0XHRcdHN0cmVhbWluZ0JlaGF2aW9yOiBjb21tYW5kLnN0cmVhbWluZ0JlaGF2aW9yLFxuXHRcdFx0XHRcdFx0c291cmNlOiBcInJwY1wiLFxuXHRcdFx0XHRcdH0pXG5cdFx0XHRcdFx0LmNhdGNoKChlKSA9PiBvdXRwdXQoZXJyb3IoaWQsIFwicHJvbXB0XCIsIGUubWVzc2FnZSkpKTtcblx0XHRcdFx0cmV0dXJuIHsgaWQsIHR5cGU6IFwicmVzcG9uc2VcIiwgY29tbWFuZDogXCJwcm9tcHRcIiwgc3VjY2VzczogdHJ1ZSwgLi4uKHJ1bklkICYmIHsgcnVuSWQgfSkgfSBhcyBScGNSZXNwb25zZTtcblx0XHRcdH1cblxuXHRcdFx0Y2FzZSBcInN0ZWVyXCI6IHtcblx0XHRcdFx0Ly8gdjI6IGdlbmVyYXRlIHJ1bklkIGZvciBleGVjdXRpb24gdHJhY2tpbmdcblx0XHRcdFx0Y29uc3QgcnVuSWQgPSBwcm90b2NvbFZlcnNpb24gPT09IDIgPyBjcnlwdG8ucmFuZG9tVVVJRCgpIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRpZiAocnVuSWQpIGN1cnJlbnRSdW5JZCA9IHJ1bklkO1xuXHRcdFx0XHRhd2FpdCBzZXNzaW9uLnN0ZWVyKGNvbW1hbmQubWVzc2FnZSwgY29tbWFuZC5pbWFnZXMpO1xuXHRcdFx0XHRyZXR1cm4geyBpZCwgdHlwZTogXCJyZXNwb25zZVwiLCBjb21tYW5kOiBcInN0ZWVyXCIsIHN1Y2Nlc3M6IHRydWUsIC4uLihydW5JZCAmJiB7IHJ1bklkIH0pIH0gYXMgUnBjUmVzcG9uc2U7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJmb2xsb3dfdXBcIjoge1xuXHRcdFx0XHQvLyB2MjogZ2VuZXJhdGUgcnVuSWQgZm9yIGV4ZWN1dGlvbiB0cmFja2luZ1xuXHRcdFx0XHRjb25zdCBydW5JZCA9IHByb3RvY29sVmVyc2lvbiA9PT0gMiA/IGNyeXB0by5yYW5kb21VVUlEKCkgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdGlmIChydW5JZCkgY3VycmVudFJ1bklkID0gcnVuSWQ7XG5cdFx0XHRcdGF3YWl0IHNlc3Npb24uZm9sbG93VXAoY29tbWFuZC5tZXNzYWdlLCBjb21tYW5kLmltYWdlcyk7XG5cdFx0XHRcdHJldHVybiB7IGlkLCB0eXBlOiBcInJlc3BvbnNlXCIsIGNvbW1hbmQ6IFwiZm9sbG93X3VwXCIsIHN1Y2Nlc3M6IHRydWUsIC4uLihydW5JZCAmJiB7IHJ1bklkIH0pIH0gYXMgUnBjUmVzcG9uc2U7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJhYm9ydFwiOiB7XG5cdFx0XHRcdFx0YXdhaXQgc2Vzc2lvbi5hYm9ydCh7IG9yaWdpbjogXCJ1c2VyXCIgfSk7XG5cdFx0XHRcdHJldHVybiBzdWNjZXNzKGlkLCBcImFib3J0XCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwibmV3X3Nlc3Npb25cIjoge1xuXHRcdFx0XHRjb25zdCBvcHRpb25zID0gY29tbWFuZC5wYXJlbnRTZXNzaW9uID8geyBwYXJlbnRTZXNzaW9uOiBjb21tYW5kLnBhcmVudFNlc3Npb24gfSA6IHVuZGVmaW5lZDtcblx0XHRcdFx0Y29uc3QgY2FuY2VsbGVkID0gIShhd2FpdCBzZXNzaW9uLm5ld1Nlc3Npb24ob3B0aW9ucykpO1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJuZXdfc2Vzc2lvblwiLCB7IGNhbmNlbGxlZCB9KTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0XHRcdC8vIFN0YXRlXG5cdFx0XHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdFx0XHRjYXNlIFwiZ2V0X3N0YXRlXCI6IHtcblx0XHRcdFx0Y29uc3Qgc3RhdGU6IFJwY1Nlc3Npb25TdGF0ZSA9IHtcblx0XHRcdFx0XHRtb2RlbDogc2Vzc2lvbi5tb2RlbCxcblx0XHRcdFx0XHR0aGlua2luZ0xldmVsOiBzZXNzaW9uLnRoaW5raW5nTGV2ZWwsXG5cdFx0XHRcdFx0aXNTdHJlYW1pbmc6IHNlc3Npb24uaXNTdHJlYW1pbmcsXG5cdFx0XHRcdFx0aXNDb21wYWN0aW5nOiBzZXNzaW9uLmlzQ29tcGFjdGluZyxcblx0XHRcdFx0XHRzdGVlcmluZ01vZGU6IHNlc3Npb24uc3RlZXJpbmdNb2RlLFxuXHRcdFx0XHRcdGZvbGxvd1VwTW9kZTogc2Vzc2lvbi5mb2xsb3dVcE1vZGUsXG5cdFx0XHRcdFx0c2Vzc2lvbkZpbGU6IHNlc3Npb24uc2Vzc2lvbkZpbGUsXG5cdFx0XHRcdFx0c2Vzc2lvbklkOiBzZXNzaW9uLnNlc3Npb25JZCxcblx0XHRcdFx0XHRzZXNzaW9uTmFtZTogc2Vzc2lvbi5zZXNzaW9uTmFtZSxcblx0XHRcdFx0XHRhdXRvQ29tcGFjdGlvbkVuYWJsZWQ6IHNlc3Npb24uYXV0b0NvbXBhY3Rpb25FbmFibGVkLFxuXHRcdFx0XHRcdGF1dG9SZXRyeUVuYWJsZWQ6IHNlc3Npb24uYXV0b1JldHJ5RW5hYmxlZCxcblx0XHRcdFx0XHRyZXRyeUluUHJvZ3Jlc3M6IHNlc3Npb24uaXNSZXRyeWluZyxcblx0XHRcdFx0XHRyZXRyeUF0dGVtcHQ6IHNlc3Npb24ucmV0cnlBdHRlbXB0LFxuXHRcdFx0XHRcdG1lc3NhZ2VDb3VudDogc2Vzc2lvbi5tZXNzYWdlcy5sZW5ndGgsXG5cdFx0XHRcdFx0cGVuZGluZ01lc3NhZ2VDb3VudDogc2Vzc2lvbi5wZW5kaW5nTWVzc2FnZUNvdW50LFxuXHRcdFx0XHRcdGV4dGVuc2lvbnNSZWFkeSxcblx0XHRcdFx0fTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwiZ2V0X3N0YXRlXCIsIHN0YXRlKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0XHRcdC8vIE1vZGVsXG5cdFx0XHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdFx0XHRjYXNlIFwic2V0X21vZGVsXCI6IHtcblx0XHRcdFx0Y29uc3QgbW9kZWxzID0gYXdhaXQgc2Vzc2lvbi5tb2RlbFJlZ2lzdHJ5LmdldEF2YWlsYWJsZSgpO1xuXHRcdFx0XHRjb25zdCBtb2RlbCA9IG1vZGVscy5maW5kKChtKSA9PiBtLnByb3ZpZGVyID09PSBjb21tYW5kLnByb3ZpZGVyICYmIG0uaWQgPT09IGNvbW1hbmQubW9kZWxJZCk7XG5cdFx0XHRcdGlmICghbW9kZWwpIHtcblx0XHRcdFx0XHRyZXR1cm4gZXJyb3IoaWQsIFwic2V0X21vZGVsXCIsIGBNb2RlbCBub3QgZm91bmQ6ICR7Y29tbWFuZC5wcm92aWRlcn0vJHtjb21tYW5kLm1vZGVsSWR9YCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0YXdhaXQgc2Vzc2lvbi5zZXRNb2RlbChtb2RlbCk7XG5cdFx0XHRcdHJldHVybiBzdWNjZXNzKGlkLCBcInNldF9tb2RlbFwiLCBtb2RlbCk7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJjeWNsZV9tb2RlbFwiOiB7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNlc3Npb24uY3ljbGVNb2RlbCgpO1xuXHRcdFx0XHRpZiAoIXJlc3VsdCkge1xuXHRcdFx0XHRcdHJldHVybiBzdWNjZXNzKGlkLCBcImN5Y2xlX21vZGVsXCIsIG51bGwpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiBzdWNjZXNzKGlkLCBcImN5Y2xlX21vZGVsXCIsIHJlc3VsdCk7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJnZXRfYXZhaWxhYmxlX21vZGVsc1wiOiB7XG5cdFx0XHRcdGNvbnN0IG1vZGVscyA9IGF3YWl0IHNlc3Npb24ubW9kZWxSZWdpc3RyeS5nZXRBdmFpbGFibGUoKTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwiZ2V0X2F2YWlsYWJsZV9tb2RlbHNcIiwgeyBtb2RlbHMgfSk7XG5cdFx0XHR9XG5cblx0XHRcdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdFx0XHQvLyBUaGlua2luZ1xuXHRcdFx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHRcdFx0Y2FzZSBcInNldF90aGlua2luZ19sZXZlbFwiOiB7XG5cdFx0XHRcdHNlc3Npb24uc2V0VGhpbmtpbmdMZXZlbChjb21tYW5kLmxldmVsKTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwic2V0X3RoaW5raW5nX2xldmVsXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwiY3ljbGVfdGhpbmtpbmdfbGV2ZWxcIjoge1xuXHRcdFx0XHRjb25zdCBsZXZlbCA9IHNlc3Npb24uY3ljbGVUaGlua2luZ0xldmVsKCk7XG5cdFx0XHRcdGlmICghbGV2ZWwpIHtcblx0XHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJjeWNsZV90aGlua2luZ19sZXZlbFwiLCBudWxsKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJjeWNsZV90aGlua2luZ19sZXZlbFwiLCB7IGxldmVsIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHRcdFx0Ly8gUXVldWUgTW9kZXNcblx0XHRcdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0XHRcdGNhc2UgXCJzZXRfc3RlZXJpbmdfbW9kZVwiOiB7XG5cdFx0XHRcdHNlc3Npb24uc2V0U3RlZXJpbmdNb2RlKGNvbW1hbmQubW9kZSk7XG5cdFx0XHRcdHJldHVybiBzdWNjZXNzKGlkLCBcInNldF9zdGVlcmluZ19tb2RlXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwic2V0X2ZvbGxvd191cF9tb2RlXCI6IHtcblx0XHRcdFx0c2Vzc2lvbi5zZXRGb2xsb3dVcE1vZGUoY29tbWFuZC5tb2RlKTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwic2V0X2ZvbGxvd191cF9tb2RlXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHRcdFx0Ly8gQ29tcGFjdGlvblxuXHRcdFx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblxuXHRcdFx0Y2FzZSBcImNvbXBhY3RcIjoge1xuXHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBzZXNzaW9uLmNvbXBhY3QoY29tbWFuZC5jdXN0b21JbnN0cnVjdGlvbnMpO1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJjb21wYWN0XCIsIHJlc3VsdCk7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJzZXRfYXV0b19jb21wYWN0aW9uXCI6IHtcblx0XHRcdFx0c2Vzc2lvbi5zZXRBdXRvQ29tcGFjdGlvbkVuYWJsZWQoY29tbWFuZC5lbmFibGVkKTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwic2V0X2F1dG9fY29tcGFjdGlvblwiKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0XHRcdC8vIFJldHJ5XG5cdFx0XHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdFx0XHRjYXNlIFwic2V0X2F1dG9fcmV0cnlcIjoge1xuXHRcdFx0XHRzZXNzaW9uLnNldEF1dG9SZXRyeUVuYWJsZWQoY29tbWFuZC5lbmFibGVkKTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwic2V0X2F1dG9fcmV0cnlcIik7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJhYm9ydF9yZXRyeVwiOiB7XG5cdFx0XHRcdHNlc3Npb24uYWJvcnRSZXRyeSgpO1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJhYm9ydF9yZXRyeVwiKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0XHRcdC8vIEJhc2hcblx0XHRcdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0XHRcdGNhc2UgXCJiYXNoXCI6IHtcblx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc2Vzc2lvbi5leGVjdXRlQmFzaChjb21tYW5kLmNvbW1hbmQpO1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJiYXNoXCIsIHJlc3VsdCk7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJhYm9ydF9iYXNoXCI6IHtcblx0XHRcdFx0c2Vzc2lvbi5hYm9ydEJhc2goKTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwiYWJvcnRfYmFzaFwiKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0XHRcdC8vIFNlc3Npb25cblx0XHRcdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0XHRcdGNhc2UgXCJnZXRfc2Vzc2lvbl9zdGF0c1wiOiB7XG5cdFx0XHRcdGNvbnN0IHN0YXRzID0gc2Vzc2lvbi5nZXRTZXNzaW9uU3RhdHMoKTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwiZ2V0X3Nlc3Npb25fc3RhdHNcIiwgc3RhdHMpO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwiZXhwb3J0X2h0bWxcIjoge1xuXHRcdFx0XHRjb25zdCBwYXRoID0gYXdhaXQgc2Vzc2lvbi5leHBvcnRUb0h0bWwoY29tbWFuZC5vdXRwdXRQYXRoKTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwiZXhwb3J0X2h0bWxcIiwgeyBwYXRoIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwic3dpdGNoX3Nlc3Npb25cIjoge1xuXHRcdFx0XHRjb25zdCBjYW5jZWxsZWQgPSAhKGF3YWl0IHNlc3Npb24uc3dpdGNoU2Vzc2lvbihjb21tYW5kLnNlc3Npb25QYXRoKSk7XG5cdFx0XHRcdHJldHVybiBzdWNjZXNzKGlkLCBcInN3aXRjaF9zZXNzaW9uXCIsIHsgY2FuY2VsbGVkIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwiZm9ya1wiOiB7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNlc3Npb24uZm9yayhjb21tYW5kLmVudHJ5SWQpO1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJmb3JrXCIsIHsgdGV4dDogcmVzdWx0LnNlbGVjdGVkVGV4dCwgY2FuY2VsbGVkOiByZXN1bHQuY2FuY2VsbGVkIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwiZ2V0X2ZvcmtfbWVzc2FnZXNcIjoge1xuXHRcdFx0XHRjb25zdCBtZXNzYWdlcyA9IHNlc3Npb24uZ2V0VXNlck1lc3NhZ2VzRm9yRm9ya2luZygpO1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJnZXRfZm9ya19tZXNzYWdlc1wiLCB7IG1lc3NhZ2VzIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwiZ2V0X2xhc3RfYXNzaXN0YW50X3RleHRcIjoge1xuXHRcdFx0XHRjb25zdCB0ZXh0ID0gc2Vzc2lvbi5nZXRMYXN0QXNzaXN0YW50VGV4dCgpO1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJnZXRfbGFzdF9hc3Npc3RhbnRfdGV4dFwiLCB7IHRleHQgfSk7XG5cdFx0XHR9XG5cblx0XHRcdGNhc2UgXCJzZXRfc2Vzc2lvbl9uYW1lXCI6IHtcblx0XHRcdFx0Y29uc3QgbmFtZSA9IGNvbW1hbmQubmFtZS50cmltKCk7XG5cdFx0XHRcdGlmICghbmFtZSkge1xuXHRcdFx0XHRcdHJldHVybiBlcnJvcihpZCwgXCJzZXRfc2Vzc2lvbl9uYW1lXCIsIFwiU2Vzc2lvbiBuYW1lIGNhbm5vdCBiZSBlbXB0eVwiKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRzZXNzaW9uLnNldFNlc3Npb25OYW1lKG5hbWUpO1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJzZXRfc2Vzc2lvbl9uYW1lXCIpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXHRcdFx0Ly8gTWVzc2FnZXNcblx0XHRcdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0XHRcdGNhc2UgXCJnZXRfbWVzc2FnZXNcIjoge1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJnZXRfbWVzc2FnZXNcIiwgeyBtZXNzYWdlczogc2Vzc2lvbi5tZXNzYWdlcyB9KTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cblx0XHRcdC8vIENvbW1hbmRzIChhdmFpbGFibGUgZm9yIGludm9jYXRpb24gdmlhIHByb21wdClcblx0XHRcdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0XHRcdGNhc2UgXCJnZXRfY29tbWFuZHNcIjoge1xuXHRcdFx0XHRjb25zdCBjb21tYW5kczogUnBjU2xhc2hDb21tYW5kW10gPSBbXTtcblxuXHRcdFx0XHQvLyBFeHRlbnNpb24gY29tbWFuZHNcblx0XHRcdFx0Zm9yIChjb25zdCB7IGNvbW1hbmQsIGV4dGVuc2lvblBhdGggfSBvZiBzZXNzaW9uLmV4dGVuc2lvblJ1bm5lcj8uZ2V0UmVnaXN0ZXJlZENvbW1hbmRzV2l0aFBhdGhzKCkgPz8gW10pIHtcblx0XHRcdFx0XHRjb21tYW5kcy5wdXNoKHtcblx0XHRcdFx0XHRcdG5hbWU6IGNvbW1hbmQubmFtZSxcblx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiBjb21tYW5kLmRlc2NyaXB0aW9uLFxuXHRcdFx0XHRcdFx0c291cmNlOiBcImV4dGVuc2lvblwiLFxuXHRcdFx0XHRcdFx0cGF0aDogZXh0ZW5zaW9uUGF0aCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFByb21wdCB0ZW1wbGF0ZXMgKHNvdXJjZSBpcyBhbHdheXMgXCJ1c2VyXCIgfCBcInByb2plY3RcIiB8IFwicGF0aFwiIGluIGNvZGluZy1hZ2VudClcblx0XHRcdFx0Zm9yIChjb25zdCB0ZW1wbGF0ZSBvZiBzZXNzaW9uLnByb21wdFRlbXBsYXRlcykge1xuXHRcdFx0XHRcdGNvbW1hbmRzLnB1c2goe1xuXHRcdFx0XHRcdFx0bmFtZTogdGVtcGxhdGUubmFtZSxcblx0XHRcdFx0XHRcdGRlc2NyaXB0aW9uOiB0ZW1wbGF0ZS5kZXNjcmlwdGlvbixcblx0XHRcdFx0XHRcdHNvdXJjZTogXCJwcm9tcHRcIixcblx0XHRcdFx0XHRcdGxvY2F0aW9uOiB0ZW1wbGF0ZS5zb3VyY2UgYXMgUnBjU2xhc2hDb21tYW5kW1wibG9jYXRpb25cIl0sXG5cdFx0XHRcdFx0XHRwYXRoOiB0ZW1wbGF0ZS5maWxlUGF0aCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFNraWxscyAoc291cmNlIGlzIGFsd2F5cyBcInVzZXJcIiB8IFwicHJvamVjdFwiIHwgXCJwYXRoXCIgaW4gY29kaW5nLWFnZW50KVxuXHRcdFx0XHRmb3IgKGNvbnN0IHNraWxsIG9mIHNlc3Npb24ucmVzb3VyY2VMb2FkZXIuZ2V0U2tpbGxzKCkuc2tpbGxzKSB7XG5cdFx0XHRcdFx0Y29tbWFuZHMucHVzaCh7XG5cdFx0XHRcdFx0XHRuYW1lOiBgc2tpbGw6JHtza2lsbC5uYW1lfWAsXG5cdFx0XHRcdFx0XHRkZXNjcmlwdGlvbjogc2tpbGwuZGVzY3JpcHRpb24sXG5cdFx0XHRcdFx0XHRzb3VyY2U6IFwic2tpbGxcIixcblx0XHRcdFx0XHRcdGxvY2F0aW9uOiBza2lsbC5zb3VyY2UgYXMgUnBjU2xhc2hDb21tYW5kW1wibG9jYXRpb25cIl0sXG5cdFx0XHRcdFx0XHRwYXRoOiBza2lsbC5maWxlUGF0aCxcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJldHVybiBzdWNjZXNzKGlkLCBcImdldF9jb21tYW5kc1wiLCB7IGNvbW1hbmRzIH0pO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwidGVybWluYWxfaW5wdXRcIjoge1xuXHRcdFx0XHRhd2FpdCBlbnN1cmVFbWJlZGRlZEludGVyYWN0aXZlTW9kZSgpO1xuXHRcdFx0XHRyZW1vdGVUZXJtaW5hbCEucHVzaElucHV0KGNvbW1hbmQuZGF0YSk7XG5cdFx0XHRcdHJldHVybiBzdWNjZXNzKGlkLCBcInRlcm1pbmFsX2lucHV0XCIpO1xuXHRcdFx0fVxuXG5cdFx0XHRjYXNlIFwidGVybWluYWxfcmVzaXplXCI6IHtcblx0XHRcdFx0YXdhaXQgZW5zdXJlRW1iZWRkZWRJbnRlcmFjdGl2ZU1vZGUoKTtcblx0XHRcdFx0cmVtb3RlVGVybWluYWwhLnJlc2l6ZShjb21tYW5kLmNvbHMsIGNvbW1hbmQucm93cyk7XG5cdFx0XHRcdHJldHVybiBzdWNjZXNzKGlkLCBcInRlcm1pbmFsX3Jlc2l6ZVwiKTtcblx0XHRcdH1cblxuXHRcdFx0Y2FzZSBcInRlcm1pbmFsX3JlZHJhd1wiOiB7XG5cdFx0XHRcdGNvbnN0IGludGVyYWN0aXZlTW9kZSA9IGF3YWl0IGVuc3VyZUVtYmVkZGVkSW50ZXJhY3RpdmVNb2RlKCk7XG5cdFx0XHRcdGludGVyYWN0aXZlTW9kZS5yZXF1ZXN0UmVuZGVyKHRydWUpO1xuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJ0ZXJtaW5hbF9yZWRyYXdcIik7XG5cdFx0XHR9XG5cblx0XHRcdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdFx0XHQvLyB2MiBQcm90b2NvbDogc3Vic2NyaWJlXG5cdFx0XHQvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxuXG5cdFx0XHRjYXNlIFwic3Vic2NyaWJlXCI6IHtcblx0XHRcdFx0aWYgKGNvbW1hbmQuZXZlbnRzLmluY2x1ZGVzKFwiKlwiKSkge1xuXHRcdFx0XHRcdGV2ZW50RmlsdGVyID0gbnVsbDsgLy8gd2lsZGNhcmQgPSBhbGwgZXZlbnRzXG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0ZXZlbnRGaWx0ZXIgPSBuZXcgU2V0KGNvbW1hbmQuZXZlbnRzKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4gc3VjY2VzcyhpZCwgXCJzdWJzY3JpYmVcIik7XG5cdFx0XHR9XG5cblx0XHRcdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cdFx0XHQvLyB2MiBQcm90b2NvbDogc2h1dGRvd25cblx0XHRcdC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cblx0XHRcdGNhc2UgXCJzaHV0ZG93blwiOiB7XG5cdFx0XHRcdHNodXRkb3duUmVxdWVzdGVkID0gdHJ1ZTtcblx0XHRcdFx0cmV0dXJuIHN1Y2Nlc3MoaWQsIFwic2h1dGRvd25cIik7XG5cdFx0XHR9XG5cblx0XHRcdGRlZmF1bHQ6IHtcblx0XHRcdFx0Y29uc3QgdW5rbm93bkNvbW1hbmQgPSBjb21tYW5kIGFzIHsgdHlwZTogc3RyaW5nOyBpZD86IHN0cmluZyB9O1xuXHRcdFx0XHRyZXR1cm4gZXJyb3IodW5rbm93bkNvbW1hbmQuaWQsIHVua25vd25Db21tYW5kLnR5cGUsIGBVbmtub3duIGNvbW1hbmQ6ICR7dW5rbm93bkNvbW1hbmQudHlwZX1gKTtcblx0XHRcdH1cblx0XHR9XG5cdH07XG5cblx0LyoqXG5cdCAqIENoZWNrIGlmIHNodXRkb3duIHdhcyByZXF1ZXN0ZWQgYW5kIHBlcmZvcm0gc2h1dGRvd24gaWYgc28uXG5cdCAqIENhbGxlZCBhZnRlciBoYW5kbGluZyBlYWNoIGNvbW1hbmQgd2hlbiB3YWl0aW5nIGZvciB0aGUgbmV4dCBjb21tYW5kLlxuXHQgKi9cblx0bGV0IGRldGFjaElucHV0ID0gKCkgPT4ge307XG5cblx0YXN5bmMgZnVuY3Rpb24gY2hlY2tTaHV0ZG93blJlcXVlc3RlZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAoIXNodXRkb3duUmVxdWVzdGVkKSByZXR1cm47XG5cblx0XHRjb25zdCBjdXJyZW50UnVubmVyID0gc2Vzc2lvbi5leHRlbnNpb25SdW5uZXI7XG5cdFx0aWYgKGN1cnJlbnRSdW5uZXI/Lmhhc0hhbmRsZXJzKFwic2Vzc2lvbl9zaHV0ZG93blwiKSkge1xuXHRcdFx0YXdhaXQgY3VycmVudFJ1bm5lci5lbWl0KHsgdHlwZTogXCJzZXNzaW9uX3NodXRkb3duXCIgfSk7XG5cdFx0fVxuXG5cdFx0dW5zdWJzY3JpYmUoKTtcblx0XHRlbWJlZGRlZEludGVyYWN0aXZlTW9kZT8uc3RvcCgpO1xuXHRcdGRldGFjaElucHV0KCk7XG5cdFx0cHJvY2Vzcy5zdGRpbi5wYXVzZSgpO1xuXHRcdHByb2Nlc3MuZXhpdCgwKTtcblx0fVxuXG5cdGNvbnN0IGhhbmRsZUlucHV0TGluZSA9IGFzeW5jIChsaW5lOiBzdHJpbmcpID0+IHtcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKTtcblxuXHRcdFx0Ly8gSGFuZGxlIGV4dGVuc2lvbiBVSSByZXNwb25zZXMgKGJ5cGFzcyBwcm90b2NvbCBkZXRlY3Rpb24pXG5cdFx0XHRpZiAocGFyc2VkLnR5cGUgPT09IFwiZXh0ZW5zaW9uX3VpX3Jlc3BvbnNlXCIpIHtcblx0XHRcdFx0Y29uc3QgcmVzcG9uc2UgPSBwYXJzZWQgYXMgUnBjRXh0ZW5zaW9uVUlSZXNwb25zZTtcblx0XHRcdFx0Y29uc3QgcGVuZGluZyA9IHBlbmRpbmdFeHRlbnNpb25SZXF1ZXN0cy5nZXQocmVzcG9uc2UuaWQpO1xuXHRcdFx0XHRpZiAocGVuZGluZykge1xuXHRcdFx0XHRcdHBlbmRpbmdFeHRlbnNpb25SZXF1ZXN0cy5kZWxldGUocmVzcG9uc2UuaWQpO1xuXHRcdFx0XHRcdHBlbmRpbmcucmVzb2x2ZShyZXNwb25zZSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBjb21tYW5kID0gcGFyc2VkIGFzIFJwY0NvbW1hbmQ7XG5cblx0XHRcdC8vIFByb3RvY29sIHZlcnNpb24gZGV0ZWN0aW9uOiBmaXJzdCBub24tVUktcmVzcG9uc2UgY29tbWFuZCBsb2NrcyB0aGUgdmVyc2lvblxuXHRcdFx0aWYgKCFwcm90b2NvbExvY2tlZCkge1xuXHRcdFx0XHRwcm90b2NvbExvY2tlZCA9IHRydWU7XG5cdFx0XHRcdGlmIChjb21tYW5kLnR5cGUgPT09IFwiaW5pdFwiKSB7XG5cdFx0XHRcdFx0cHJvdG9jb2xWZXJzaW9uID0gMjtcblx0XHRcdFx0XHRjb25zdCBpbml0UmVzdWx0OiBScGNJbml0UmVzdWx0ID0ge1xuXHRcdFx0XHRcdFx0cHJvdG9jb2xWZXJzaW9uOiAyLFxuXHRcdFx0XHRcdFx0c2Vzc2lvbklkOiBzZXNzaW9uLnNlc3Npb25JZCxcblx0XHRcdFx0XHRcdGNhcGFiaWxpdGllczoge1xuXHRcdFx0XHRcdFx0XHRldmVudHM6IFtcImV4ZWN1dGlvbl9jb21wbGV0ZVwiLCBcImNvc3RfdXBkYXRlXCJdLFxuXHRcdFx0XHRcdFx0XHRjb21tYW5kczogW1wiaW5pdFwiLCBcInNodXRkb3duXCIsIFwic3Vic2NyaWJlXCJdLFxuXHRcdFx0XHRcdFx0fSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdG91dHB1dChzdWNjZXNzKGNvbW1hbmQuaWQsIFwiaW5pdFwiLCBpbml0UmVzdWx0KSk7XG5cdFx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIE5vbi1pbml0IGZpcnN0IG1lc3NhZ2U6IGxvY2sgdG8gdjEsIGZhbGwgdGhyb3VnaCB0byBub3JtYWwgaGFuZGxpbmdcblx0XHRcdFx0cHJvdG9jb2xWZXJzaW9uID0gMTtcblx0XHRcdH0gZWxzZSBpZiAoY29tbWFuZC50eXBlID09PSBcImluaXRcIikge1xuXHRcdFx0XHQvLyBBbHJlYWR5IGxvY2tlZCBcdTIwMTQgcmVqZWN0IHJlLWluaXRcblx0XHRcdFx0b3V0cHV0KGVycm9yKGNvbW1hbmQuaWQsIFwiaW5pdFwiLCBcIlByb3RvY29sIHZlcnNpb24gYWxyZWFkeSBsb2NrZWQuIGluaXQgbXVzdCBiZSB0aGUgZmlyc3QgY29tbWFuZC5cIikpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cblx0XHRcdC8vIEhhbmRsZSByZWd1bGFyIGNvbW1hbmRzXG5cdFx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGhhbmRsZUNvbW1hbmQoY29tbWFuZCk7XG5cdFx0XHRvdXRwdXQocmVzcG9uc2UpO1xuXG5cdFx0XHQvLyBDaGVjayBmb3IgZGVmZXJyZWQgc2h1dGRvd24gcmVxdWVzdCAoaWRsZSBiZXR3ZWVuIGNvbW1hbmRzKVxuXHRcdFx0YXdhaXQgY2hlY2tTaHV0ZG93blJlcXVlc3RlZCgpO1xuXHRcdH0gY2F0Y2ggKGU6IGFueSkge1xuXHRcdFx0b3V0cHV0KGVycm9yKHVuZGVmaW5lZCwgXCJwYXJzZVwiLCBgRmFpbGVkIHRvIHBhcnNlIGNvbW1hbmQ6ICR7ZS5tZXNzYWdlfWApKTtcblx0XHR9XG5cdH07XG5cblx0ZGV0YWNoSW5wdXQgPSBhdHRhY2hKc29ubExpbmVSZWFkZXIocHJvY2Vzcy5zdGRpbiwgKGxpbmUpID0+IHtcblx0XHR2b2lkIGhhbmRsZUlucHV0TGluZShsaW5lKTtcblx0fSk7XG5cblx0Ly8gS2VlcCBwcm9jZXNzIGFsaXZlIGZvcmV2ZXJcblx0cmV0dXJuIG5ldyBQcm9taXNlKCgpID0+IHt9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWFBLFlBQVksWUFBWTtBQU94QixTQUFTLHVCQUF1QjtBQUNoQyxTQUFxQixhQUFhO0FBQ2xDLFNBQVMsMENBQTBDO0FBQ25ELFNBQVMsdUJBQXVCLHlCQUF5QjtBQUN6RCxTQUFTLHNCQUFzQjtBQTJCL0IsZUFBc0IsV0FBVyxTQUF1QztBQUN2RSxRQUFNLFNBQVMsQ0FBQyxRQUFzRDtBQUNyRSxZQUFRLE9BQU8sTUFBTSxrQkFBa0IsR0FBRyxDQUFDO0FBQUEsRUFDNUM7QUFFQSxRQUFNLFVBQVUsQ0FDZixJQUNBLFNBQ0EsU0FDaUI7QUFDakIsUUFBSSxTQUFTLFFBQVc7QUFDdkIsYUFBTyxFQUFFLElBQUksTUFBTSxZQUFZLFNBQVMsU0FBUyxLQUFLO0FBQUEsSUFDdkQ7QUFDQSxXQUFPLEVBQUUsSUFBSSxNQUFNLFlBQVksU0FBUyxTQUFTLE1BQU0sS0FBSztBQUFBLEVBQzdEO0FBRUEsUUFBTSxRQUFRLENBQUMsSUFBd0IsU0FBaUIsWUFBaUM7QUFDeEYsV0FBTyxFQUFFLElBQUksTUFBTSxZQUFZLFNBQVMsU0FBUyxPQUFPLE9BQU8sUUFBUTtBQUFBLEVBQ3hFO0FBR0EsUUFB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QUFZLGtCQUFrQixHQUFHO0FBQ25ELFlBQU0sY0FBYyxLQUFLLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUFBLElBQ3REO0FBRUEsZ0JBQVk7QUFDWiw2QkFBeUIsS0FBSztBQUM5QixnQkFBWTtBQUNaLFlBQVEsTUFBTSxNQUFNO0FBQ3BCLFlBQVEsS0FBSyxDQUFDO0FBQUEsRUFDZjtBQUVBLFFBQU0sa0JBQWtCLE9BQU8sU0FBaUI7QUFDL0MsUUFBSTtBQUNILFlBQU0sU0FBUyxLQUFLLE1BQU0sSUFBSTtBQUc5QixVQUFJLE9BQU8sU0FBUyx5QkFBeUI7QUFDNUMsY0FBTUMsWUFBVztBQUNqQixjQUFNLFVBQVUseUJBQXlCLElBQUlBLFVBQVMsRUFBRTtBQUN4RCxZQUFJLFNBQVM7QUFDWixtQ0FBeUIsT0FBT0EsVUFBUyxFQUFFO0FBQzNDLGtCQUFRLFFBQVFBLFNBQVE7QUFBQSxRQUN6QjtBQUNBO0FBQUEsTUFDRDtBQUVBLFlBQU0sVUFBVTtBQUdoQixVQUFJLENBQUMsZ0JBQWdCO0FBQ3BCLHlCQUFpQjtBQUNqQixZQUFJLFFBQVEsU0FBUyxRQUFRO0FBQzVCLDRCQUFrQjtBQUNsQixnQkFBTSxhQUE0QjtBQUFBLFlBQ2pDLGlCQUFpQjtBQUFBLFlBQ2pCLFdBQVcsUUFBUTtBQUFBLFlBQ25CLGNBQWM7QUFBQSxjQUNiLFFBQVEsQ0FBQyxzQkFBc0IsYUFBYTtBQUFBLGNBQzVDLFVBQVUsQ0FBQyxRQUFRLFlBQVksV0FBVztBQUFBLFlBQzNDO0FBQUEsVUFDRDtBQUNBLGlCQUFPLFFBQVEsUUFBUSxJQUFJLFFBQVEsVUFBVSxDQUFDO0FBQzlDO0FBQUEsUUFDRDtBQUVBLDBCQUFrQjtBQUFBLE1BQ25CLFdBQVcsUUFBUSxTQUFTLFFBQVE7QUFFbkMsZUFBTyxNQUFNLFFBQVEsSUFBSSxRQUFRLGtFQUFrRSxDQUFDO0FBQ3BHO0FBQUEsTUFDRDtBQUdBLFlBQU0sV0FBVyxNQUFNLGNBQWMsT0FBTztBQUM1QyxhQUFPLFFBQVE7QUFHZixZQUFNLHVCQUF1QjtBQUFBLElBQzlCLFNBQVMsR0FBUTtBQUNoQixhQUFPLE1BQU0sUUFBVyxTQUFTLDRCQUE0QixFQUFFLE9BQU8sRUFBRSxDQUFDO0FBQUEsSUFDMUU7QUFBQSxFQUNEO0FBRUEsZ0JBQWMsc0JBQXNCLFFBQVEsT0FBTyxDQUFDLFNBQVM7QUFDNUQsU0FBSyxnQkFBZ0IsSUFBSTtBQUFBLEVBQzFCLENBQUM7QUFHRCxTQUFPLElBQUksUUFBUSxNQUFNO0FBQUEsRUFBQyxDQUFDO0FBQzVCOyIsCiAgIm5hbWVzIjogWyJlcnJvciIsICJjb21tYW5kIiwgInJlc3BvbnNlIl0KfQo=
