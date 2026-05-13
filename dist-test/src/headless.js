import { existsSync, mkdirSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { RpcClient, SessionManager } from "@gsd/pi-coding-agent";
import { getProjectSessionsDir } from "./project-sessions.js";
import { loadAndValidateAnswerFile, AnswerInjector } from "./headless-answers.js";
import {
  isTerminalNotification,
  isBlockedNotification,
  isMilestoneReadyNotification,
  isQuickCommand,
  FIRE_AND_FORGET_METHODS,
  IDLE_TIMEOUT_MS,
  NEW_MILESTONE_IDLE_TIMEOUT_MS,
  isInteractiveHeadlessTool,
  shouldArmHeadlessIdleTimeout,
  EXIT_SUCCESS,
  EXIT_ERROR,
  EXIT_BLOCKED,
  EXIT_CANCELLED,
  mapStatusToExitCode
} from "./headless-events.js";
import { VALID_OUTPUT_FORMATS } from "./headless-types.js";
import {
  handleExtensionUIRequest,
  formatProgress,
  formatThinkingLine,
  formatTextStart,
  formatTextEnd,
  formatThinkingStart,
  formatThinkingEnd,
  startSupervisedStdinReader
} from "./headless-ui.js";
import {
  loadContext,
  bootstrapGsdProject
} from "./headless-context.js";
function isMultiTurnHeadlessCommand(command) {
  return command === "auto" || command === "next" || command === "discuss" || command === "plan";
}
function resolveResumeSession(sessions, prefix) {
  const exact = sessions.find((s) => s.id === prefix);
  if (exact) {
    return { session: exact };
  }
  const matches = sessions.filter((s) => s.id.startsWith(prefix));
  if (matches.length === 0) {
    return { error: `No session matching '${prefix}' found` };
  }
  if (matches.length > 1) {
    const list = matches.map((s) => `  ${s.id}`).join("\n");
    return { error: `Ambiguous session prefix '${prefix}' matches ${matches.length} sessions:
${list}` };
  }
  return { session: matches[0] };
}
function parseHeadlessArgs(argv) {
  const options = {
    timeout: 3e5,
    json: false,
    outputFormat: "text",
    command: "auto",
    commandArgs: []
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "headless") continue;
    if (arg.startsWith("--")) {
      if (arg === "--timeout" && i + 1 < args.length) {
        options.timeout = parseInt(args[++i], 10);
        if (Number.isNaN(options.timeout) || options.timeout < 0) {
          process.stderr.write("[headless] Error: --timeout must be a non-negative integer (milliseconds, 0 to disable)\n");
          process.exit(1);
        }
      } else if (arg === "--json") {
        options.json = true;
        options.outputFormat = "stream-json";
      } else if (arg === "--output-format" && i + 1 < args.length) {
        const fmt = args[++i];
        if (!VALID_OUTPUT_FORMATS.has(fmt)) {
          process.stderr.write(`[headless] Error: --output-format must be one of: text, json, stream-json (got '${fmt}')
`);
          process.exit(1);
        }
        options.outputFormat = fmt;
        if (fmt === "stream-json" || fmt === "json") {
          options.json = true;
        }
      } else if (arg === "--model" && i + 1 < args.length) {
        options.model = args[++i];
      } else if (arg === "--context" && i + 1 < args.length) {
        options.context = args[++i];
      } else if (arg === "--context-text" && i + 1 < args.length) {
        options.contextText = args[++i];
      } else if (arg === "--auto") {
        options.auto = true;
      } else if (arg === "--verbose") {
        options.verbose = true;
      } else if (arg === "--max-restarts" && i + 1 < args.length) {
        options.maxRestarts = parseInt(args[++i], 10);
        if (Number.isNaN(options.maxRestarts) || options.maxRestarts < 0) {
          process.stderr.write("[headless] Error: --max-restarts must be a non-negative integer\n");
          process.exit(1);
        }
      } else if (arg === "--answers" && i + 1 < args.length) {
        options.answers = args[++i];
      } else if (arg === "--events" && i + 1 < args.length) {
        options.eventFilter = new Set(args[++i].split(","));
        options.json = true;
        if (options.outputFormat === "text") {
          options.outputFormat = "stream-json";
        }
      } else if (arg === "--supervised") {
        options.supervised = true;
        options.json = true;
        if (options.outputFormat === "text") {
          options.outputFormat = "stream-json";
        }
      } else if (arg === "--response-timeout" && i + 1 < args.length) {
        options.responseTimeout = parseInt(args[++i], 10);
        if (Number.isNaN(options.responseTimeout) || options.responseTimeout <= 0) {
          process.stderr.write("[headless] Error: --response-timeout must be a positive integer (milliseconds)\n");
          process.exit(1);
        }
      } else if (arg === "--resume" && i + 1 < args.length) {
        options.resumeSession = args[++i];
      } else if (arg === "--bare") {
        options.bare = true;
      }
    } else if (options.command === "auto") {
      options.command = arg;
    } else {
      options.commandArgs.push(arg);
    }
  }
  return options;
}
async function runHeadless(options) {
  const maxRestarts = options.maxRestarts ?? 3;
  let restartCount = 0;
  while (true) {
    const result = await runHeadlessOnce(options, restartCount);
    if (result.exitCode === EXIT_SUCCESS || result.exitCode === EXIT_BLOCKED) {
      process.exit(result.exitCode);
    }
    if (restartCount >= maxRestarts) {
      process.stderr.write(`[headless] Max restarts (${maxRestarts}) reached. Exiting.
`);
      process.exit(result.exitCode);
    }
    if (result.interrupted) {
      process.exit(result.exitCode);
    }
    restartCount++;
    const backoffMs = Math.min(5e3 * restartCount, 3e4);
    process.stderr.write(`[headless] Restarting in ${(backoffMs / 1e3).toFixed(0)}s (attempt ${restartCount}/${maxRestarts})...
`);
    await new Promise((resolve2) => setTimeout(resolve2, backoffMs));
  }
}
async function runHeadlessOnce(options, restartCount) {
  let interrupted = false;
  const startTime = Date.now();
  const isNewMilestone = options.command === "new-milestone";
  if (isNewMilestone && options.timeout === 3e5) {
    options.timeout = 6e5;
  }
  const isAutoMode = options.command === "auto";
  const isMultiTurnCommand = isMultiTurnHeadlessCommand(options.command);
  if (isAutoMode && options.timeout === 3e5) {
    options.timeout = 0;
  }
  if (options.supervised && options.context === "-") {
    process.stderr.write("[headless] Error: --supervised cannot be used with --context - (both require stdin)\n");
    process.exit(1);
  }
  let injector;
  if (options.answers) {
    try {
      const answerFile = loadAndValidateAnswerFile(resolve(options.answers));
      injector = new AnswerInjector(answerFile);
      if (!options.json) {
        process.stderr.write(`[headless] Loaded answer file: ${options.answers}
`);
      }
    } catch (err) {
      process.stderr.write(`[headless] Error loading answer file: ${err instanceof Error ? err.message : String(err)}
`);
      process.exit(1);
    }
  }
  if (isNewMilestone) {
    if (!options.context && !options.contextText) {
      process.stderr.write("[headless] Error: new-milestone requires --context <file> or --context-text <text>\n");
      process.exit(1);
    }
    let contextContent;
    try {
      contextContent = await loadContext(options);
    } catch (err) {
      process.stderr.write(`[headless] Error loading context: ${err instanceof Error ? err.message : String(err)}
`);
      process.exit(1);
    }
    const gsdDir2 = join(process.cwd(), ".gsd");
    if (!existsSync(gsdDir2)) {
      if (!options.json) {
        process.stderr.write("[headless] Bootstrapping .gsd/ project structure...\n");
      }
      bootstrapGsdProject(process.cwd());
    }
    const runtimeDir = join(gsdDir2, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "headless-context.md"), contextContent, "utf-8");
  }
  const gsdDir = join(process.cwd(), ".gsd");
  if (!isNewMilestone && !existsSync(gsdDir)) {
    process.stderr.write("[headless] Error: No .gsd/ directory found in current directory.\n");
    process.stderr.write("[headless] Run 'gsd' interactively first to initialize a project.\n");
    process.exit(1);
  }
  if (options.command === "query") {
    const { handleQuery } = await import("./headless-query.js");
    const result = await handleQuery(process.cwd());
    return { exitCode: result.exitCode, interrupted: false };
  }
  if (options.command === "recover") {
    const { handleRecover } = await import("./headless-recover.js");
    const result = await handleRecover(process.cwd());
    process.exit(result.exitCode);
  }
  if (options.command === "doctor") {
    const wantsJson = options.json || options.commandArgs.includes("--json");
    const { runGSDDoctor } = await import("./resources/extensions/gsd/doctor.js");
    const { formatDoctorReport, formatDoctorReportJson } = await import("./resources/extensions/gsd/doctor-format.js");
    let exitCode2 = 1;
    try {
      const report = await runGSDDoctor(process.cwd());
      const out = wantsJson ? formatDoctorReportJson(report) : formatDoctorReport(report);
      process.stdout.write(`${out}
`);
      exitCode2 = report.ok ? 0 : 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[headless] doctor failed: ${msg}
`);
      exitCode2 = 1;
    }
    process.exit(exitCode2);
  }
  const cliPath = process.env.GSD_BIN_PATH || process.argv[1];
  if (!cliPath) {
    process.stderr.write("[headless] Error: Cannot determine CLI path. Set GSD_BIN_PATH or run via gsd.\n");
    process.exit(1);
  }
  const clientOptions = {
    cliPath,
    cwd: process.cwd()
  };
  if (options.model) {
    clientOptions.model = options.model;
  }
  if (injector) {
    clientOptions.env = injector.getSecretEnvVars();
  }
  clientOptions.env = { ...clientOptions.env || {}, GSD_HEADLESS: "1" };
  if (options.bare) {
    clientOptions.args = [...clientOptions.args || [], "--bare"];
  }
  const client = new RpcClient(clientOptions);
  let totalEvents = 0;
  let toolCallCount = 0;
  let blocked = false;
  let completed = false;
  let exitCode = 0;
  let milestoneReady = false;
  const recentEvents = [];
  const interactiveToolCallIds = /* @__PURE__ */ new Set();
  let cumulativeCostUsd = 0;
  let cumulativeInputTokens = 0;
  let cumulativeOutputTokens = 0;
  let cumulativeCacheReadTokens = 0;
  let cumulativeCacheWriteTokens = 0;
  let lastSessionId;
  const toolStartTimes = /* @__PURE__ */ new Map();
  let lastCostData;
  let thinkingBuffer = "";
  let inTextBlock = false;
  let inThinkingBlock = false;
  function emitBatchJsonResult() {
    if (options.outputFormat !== "json") return;
    const duration2 = Date.now() - startTime;
    const status2 = blocked ? "blocked" : exitCode === EXIT_CANCELLED ? "cancelled" : exitCode === EXIT_ERROR ? totalEvents === 0 ? "error" : "timeout" : "success";
    const result = {
      status: status2,
      exitCode,
      sessionId: lastSessionId,
      duration: duration2,
      cost: {
        total: cumulativeCostUsd,
        input_tokens: cumulativeInputTokens,
        output_tokens: cumulativeOutputTokens,
        cache_read_tokens: cumulativeCacheReadTokens,
        cache_write_tokens: cumulativeCacheWriteTokens
      },
      toolCalls: toolCallCount,
      events: totalEvents
    };
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  function trackEvent(event) {
    totalEvents++;
    const type = String(event.type ?? "unknown");
    if (type === "tool_execution_start") {
      toolCallCount++;
    }
    const detail = type === "tool_execution_start" ? String(event.toolName ?? "") : type === "extension_ui_request" ? `${event.method}: ${event.title ?? event.message ?? ""}` : void 0;
    recentEvents.push({ type, timestamp: Date.now(), detail });
    if (recentEvents.length > 20) recentEvents.shift();
  }
  let clientStarted = false;
  let injectorStdinAdapter = () => {
  };
  const pendingResponseTimers = /* @__PURE__ */ new Map();
  let supervisedFallback = false;
  let stopSupervisedReader = null;
  const onStdinClose = () => {
    supervisedFallback = true;
    process.stderr.write("[headless] Warning: orchestrator stdin closed, falling back to auto-response\n");
  };
  if (options.supervised) {
    process.stdin.on("close", onStdinClose);
  }
  let resolveCompletion;
  const completionPromise = new Promise((resolve2) => {
    resolveCompletion = resolve2;
  });
  let idleTimer = null;
  const effectiveIdleTimeout = isNewMilestone ? NEW_MILESTONE_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (shouldArmHeadlessIdleTimeout(toolCallCount, interactiveToolCallIds.size)) {
      idleTimer = setTimeout(() => {
        completed = true;
        resolveCompletion();
      }, effectiveIdleTimeout);
    }
  }
  const responseTimeout = options.responseTimeout ?? 3e4;
  const timeoutTimer = options.timeout > 0 ? setTimeout(() => {
    process.stderr.write(`[headless] Timeout after ${options.timeout / 1e3}s
`);
    exitCode = EXIT_ERROR;
    resolveCompletion();
  }, options.timeout) : null;
  client.onEvent((event) => {
    const eventObj = event;
    trackEvent(eventObj);
    const eventType = String(eventObj.type ?? "");
    if (eventType === "tool_execution_start") {
      const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? "");
      if (toolCallId && isInteractiveHeadlessTool(String(eventObj.toolName ?? ""))) {
        interactiveToolCallIds.add(toolCallId);
      }
    } else if (eventType === "tool_execution_end") {
      const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? "");
      if (toolCallId) {
        interactiveToolCallIds.delete(toolCallId);
      }
    }
    resetIdleTimer();
    injector?.observeEvent(eventObj);
    if (options.json && options.outputFormat === "stream-json") {
      if (!options.eventFilter || options.eventFilter.has(eventType)) {
        process.stdout.write(JSON.stringify(eventObj) + "\n");
      }
    } else if (options.outputFormat === "json") {
      const eventType2 = String(eventObj.type ?? "");
      if (eventType2 === "cost_update") {
        const data = eventObj;
        const cumCost = data.cumulativeCost;
        if (cumCost) {
          cumulativeCostUsd = Math.max(cumulativeCostUsd, Number(cumCost.costUsd ?? 0));
          const tokens = data.tokens;
          if (tokens) {
            cumulativeInputTokens = Math.max(cumulativeInputTokens, tokens.input ?? 0);
            cumulativeOutputTokens = Math.max(cumulativeOutputTokens, tokens.output ?? 0);
            cumulativeCacheReadTokens = Math.max(cumulativeCacheReadTokens, tokens.cacheRead ?? 0);
            cumulativeCacheWriteTokens = Math.max(cumulativeCacheWriteTokens, tokens.cacheWrite ?? 0);
          }
        }
      }
      if (eventType2 === "init_result") {
        lastSessionId = String(eventObj.sessionId ?? "");
      }
    } else if (!options.json) {
      const eventType2 = String(eventObj.type ?? "");
      if (eventType2 === "cost_update") {
        const data = eventObj;
        const cumCost = data.cumulativeCost;
        if (cumCost) {
          const tokens = data.tokens;
          lastCostData = {
            costUsd: Number(cumCost.costUsd ?? 0),
            inputTokens: tokens?.input ?? 0,
            outputTokens: tokens?.output ?? 0
          };
        }
      }
      if (eventType2 === "message_update") {
        const ame = eventObj.assistantMessageEvent;
        if (ame && options.verbose) {
          const ameType = String(ame.type ?? "");
          if (ameType === "text_start") {
            inTextBlock = true;
            process.stderr.write(formatTextStart());
          } else if (ameType === "text_delta") {
            const delta = String(ame.delta ?? ame.text ?? "");
            if (delta) {
              if (!inTextBlock) {
                inTextBlock = true;
                process.stderr.write(formatTextStart());
              }
              process.stderr.write(delta);
            }
          } else if (ameType === "text_end") {
            if (inTextBlock) {
              process.stderr.write(formatTextEnd() + "\n");
              inTextBlock = false;
            }
          } else if (ameType === "thinking_start") {
            inThinkingBlock = true;
            process.stderr.write(formatThinkingStart());
          } else if (ameType === "thinking_delta") {
            const delta = String(ame.delta ?? ame.text ?? "");
            if (delta) {
              if (!inThinkingBlock) {
                inThinkingBlock = true;
                process.stderr.write(formatThinkingStart());
              }
              process.stderr.write(delta);
            }
          } else if (ameType === "thinking_end") {
            if (inThinkingBlock) {
              process.stderr.write(formatThinkingEnd() + "\n");
              inThinkingBlock = false;
            }
          }
        } else if (ame?.type === "text_delta") {
          thinkingBuffer += String(ame.delta ?? ame.text ?? "");
        }
      }
      if (eventType2 === "tool_execution_start") {
        const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? "");
        if (toolCallId) toolStartTimes.set(toolCallId, Date.now());
      }
      if (options.verbose && (eventType2 === "tool_execution_start" || eventType2 === "message_end")) {
        if (inTextBlock) {
          process.stderr.write("\n");
          inTextBlock = false;
        }
        if (inThinkingBlock) {
          process.stderr.write("\n");
          inThinkingBlock = false;
        }
      } else if (!options.verbose && thinkingBuffer.trim() && (eventType2 === "tool_execution_start" || eventType2 === "message_end")) {
        process.stderr.write(formatThinkingLine(thinkingBuffer) + "\n");
        thinkingBuffer = "";
      }
      let toolDuration;
      let isToolError = false;
      if (eventType2 === "tool_execution_end") {
        const toolCallId = String(eventObj.toolCallId ?? eventObj.id ?? "");
        const startTime2 = toolStartTimes.get(toolCallId);
        if (startTime2) {
          toolDuration = Date.now() - startTime2;
          toolStartTimes.delete(toolCallId);
        }
        isToolError = eventObj.isError === true || eventObj.error != null;
      }
      const ctx = {
        verbose: !!options.verbose,
        toolDuration,
        isError: isToolError,
        lastCost: eventType2 === "agent_end" ? lastCostData : void 0
      };
      const line = formatProgress(eventObj, ctx);
      if (line) process.stderr.write(line + "\n");
    }
    if (eventObj.type === "execution_complete" && !completed && !isMultiTurnCommand) {
      completed = true;
      const status2 = String(eventObj.status ?? "success");
      exitCode = mapStatusToExitCode(status2);
      if (eventObj.status === "blocked") blocked = true;
      resolveCompletion();
      return;
    }
    if (eventObj.type === "extension_ui_request" && clientStarted) {
      if (isBlockedNotification(eventObj)) {
        blocked = true;
      }
      if (isMilestoneReadyNotification(eventObj)) {
        milestoneReady = true;
      }
      if (isTerminalNotification(eventObj)) {
        completed = true;
      }
      if (injector && !FIRE_AND_FORGET_METHODS.has(String(eventObj.method ?? ""))) {
        if (injector.tryHandle(eventObj, injectorStdinAdapter)) {
          if (completed) {
            exitCode = blocked ? EXIT_BLOCKED : EXIT_SUCCESS;
            resolveCompletion();
          }
          return;
        }
      }
      const method = String(eventObj.method ?? "");
      const shouldSupervise = options.supervised && !supervisedFallback && !FIRE_AND_FORGET_METHODS.has(method);
      if (shouldSupervise) {
        const eventId = String(eventObj.id ?? "");
        const timer = setTimeout(() => {
          pendingResponseTimers.delete(eventId);
          handleExtensionUIRequest(eventObj, client);
          process.stdout.write(JSON.stringify({ type: "supervised_timeout", id: eventId, method }) + "\n");
        }, responseTimeout);
        pendingResponseTimers.set(eventId, timer);
      } else {
        handleExtensionUIRequest(eventObj, client);
      }
      if (completed) {
        exitCode = blocked ? EXIT_BLOCKED : EXIT_SUCCESS;
        resolveCompletion();
        return;
      }
    }
    if (eventObj.type === "agent_end" && isQuickCommand(options.command, options.commandArgs) && !completed) {
      completed = true;
      resolveCompletion();
      return;
    }
  });
  const signalHandler = () => {
    try {
      writeSync(2, "\n[headless] Interrupted, stopping child process...\n");
    } catch {
      process.stderr.write("\n[headless] Interrupted, stopping child process...\n");
    }
    interrupted = true;
    exitCode = EXIT_CANCELLED;
    void client.stop().catch((error) => {
      process.stderr.write(`[headless] Warning: failed to stop child process: ${error instanceof Error ? error.message : String(error)}
`);
    });
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (options.outputFormat === "json") {
      emitBatchJsonResult();
    }
    process.exit(exitCode);
  };
  process.prependListener("SIGINT", signalHandler);
  process.prependListener("SIGTERM", signalHandler);
  try {
    writeSync(2, "[headless] signal-handlers-ready\n");
  } catch {
    process.stderr.write("[headless] signal-handlers-ready\n");
  }
  try {
    await client.start();
  } catch (err) {
    process.stderr.write(`[headless] Error: Failed to start RPC session: ${err instanceof Error ? err.message : String(err)}
`);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    process.exit(1);
  }
  let v2Enabled = false;
  try {
    await client.init({ clientId: "gsd-headless" });
    v2Enabled = true;
  } catch {
    process.stderr.write("[headless] Warning: v2 init failed, falling back to v1 string-matching\n");
  }
  clientStarted = true;
  if (options.resumeSession) {
    const projectSessionsDir = getProjectSessionsDir(process.cwd());
    const sessions = await SessionManager.list(process.cwd(), projectSessionsDir);
    const result = resolveResumeSession(sessions, options.resumeSession);
    if (result.error) {
      process.stderr.write(`[headless] Error: ${result.error}
`);
      await client.stop();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      process.exit(1);
    }
    const matched = result.session;
    const switchResult = await client.switchSession(matched.path);
    if (switchResult.cancelled) {
      process.stderr.write(`[headless] Error: Session switch to '${matched.id}' was cancelled by an extension
`);
      await client.stop();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      process.exit(1);
    }
    process.stderr.write(`[headless] Resuming session ${matched.id}
`);
  }
  injectorStdinAdapter = (data) => {
    try {
      const parsed = JSON.parse(data.trim());
      if (parsed.type === "extension_ui_response" && parsed.id) {
        const { id, value, values, confirmed, cancelled } = parsed;
        client.sendUIResponse(id, { value, values, confirmed, cancelled });
      }
    } catch {
      process.stderr.write("[headless] Warning: injector adapter received unparseable data\n");
    }
  };
  if (options.supervised) {
    stopSupervisedReader = startSupervisedStdinReader(client, (id) => {
      const timer = pendingResponseTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        pendingResponseTimers.delete(id);
      }
    });
    process.stdin.resume();
  }
  const internalProcess = Reflect.get(client, "process");
  if (internalProcess) {
    internalProcess.on("exit", (code) => {
      if (!completed) {
        const msg = `[headless] Child process exited unexpectedly with code ${code ?? "null"}
`;
        process.stderr.write(msg);
        exitCode = EXIT_ERROR;
        resolveCompletion();
      }
    });
  }
  if (!options.json) {
    process.stderr.write(`[headless] Running /gsd ${options.command}${options.commandArgs.length > 0 ? " " + options.commandArgs.join(" ") : ""}...
`);
  }
  const command = `/gsd ${options.command}${options.commandArgs.length > 0 ? " " + options.commandArgs.join(" ") : ""}`;
  try {
    await client.prompt(command);
  } catch (err) {
    process.stderr.write(`[headless] Error: Failed to send prompt: ${err instanceof Error ? err.message : String(err)}
`);
    exitCode = EXIT_ERROR;
  }
  if (exitCode === EXIT_SUCCESS || exitCode === EXIT_BLOCKED) {
    await completionPromise;
  }
  if (isNewMilestone && options.auto && milestoneReady && !blocked && exitCode === EXIT_SUCCESS) {
    if (!options.json) {
      process.stderr.write("[headless] Milestone ready \u2014 chaining into auto-mode...\n");
    }
    if (timeoutTimer) clearTimeout(timeoutTimer);
    completed = false;
    milestoneReady = false;
    blocked = false;
    const autoCompletionPromise = new Promise((resolve2) => {
      resolveCompletion = resolve2;
    });
    try {
      await client.prompt("/gsd auto");
    } catch (err) {
      process.stderr.write(`[headless] Error: Failed to start auto-mode: ${err instanceof Error ? err.message : String(err)}
`);
      exitCode = EXIT_ERROR;
    }
    if (exitCode === EXIT_SUCCESS || exitCode === EXIT_BLOCKED) {
      await autoCompletionPromise;
    }
  }
  if (timeoutTimer) clearTimeout(timeoutTimer);
  if (idleTimer) clearTimeout(idleTimer);
  pendingResponseTimers.forEach((timer) => clearTimeout(timer));
  pendingResponseTimers.clear();
  stopSupervisedReader?.();
  process.stdin.removeListener("close", onStdinClose);
  process.removeListener("SIGINT", signalHandler);
  process.removeListener("SIGTERM", signalHandler);
  await client.stop();
  const duration = ((Date.now() - startTime) / 1e3).toFixed(1);
  const status = blocked ? "blocked" : exitCode === EXIT_CANCELLED ? "cancelled" : exitCode === EXIT_ERROR ? totalEvents === 0 ? "error" : "timeout" : "complete";
  process.stderr.write(`[headless] Status: ${status}
`);
  process.stderr.write(`[headless] Duration: ${duration}s
`);
  process.stderr.write(`[headless] Events: ${totalEvents} total, ${toolCallCount} tool calls
`);
  if (options.eventFilter) {
    process.stderr.write(`[headless] Event filter: ${[...options.eventFilter].join(", ")}
`);
  }
  if (restartCount > 0) {
    process.stderr.write(`[headless] Restarts: ${restartCount}
`);
  }
  if (injector) {
    const stats = injector.getStats();
    process.stderr.write(`[headless] Answers: ${stats.questionsAnswered} answered, ${stats.questionsDefaulted} defaulted, ${stats.secretsProvided} secrets
`);
    for (const warning of injector.getUnusedWarnings()) {
      process.stderr.write(`${warning}
`);
    }
  }
  if (exitCode !== 0) {
    const lastFive = recentEvents.slice(-5);
    if (lastFive.length > 0) {
      process.stderr.write("[headless] Last events:\n");
      for (const e of lastFive) {
        process.stderr.write(`  ${e.type}${e.detail ? `: ${e.detail}` : ""}
`);
      }
    }
  }
  emitBatchJsonResult();
  return { exitCode, interrupted };
}
export {
  isMultiTurnHeadlessCommand,
  parseHeadlessArgs,
  resolveResumeSession,
  runHeadless
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2hlYWRsZXNzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEhlYWRsZXNzIE9yY2hlc3RyYXRvciBcdTIwMTQgYGdzZCBoZWFkbGVzc2BcbiAqXG4gKiBSdW5zIGFueSAvZ3NkIHN1YmNvbW1hbmQgd2l0aG91dCBhIFRVSSBieSBzcGF3bmluZyBhIGNoaWxkIHByb2Nlc3MgaW5cbiAqIFJQQyBtb2RlLCBhdXRvLXJlc3BvbmRpbmcgdG8gZXh0ZW5zaW9uIFVJIHJlcXVlc3RzLCBhbmQgc3RyZWFtaW5nXG4gKiBwcm9ncmVzcyB0byBzdGRlcnIuXG4gKlxuICogRXhpdCBjb2RlczpcbiAqICAgMCAgXHUyMDE0IGNvbXBsZXRlIChjb21tYW5kIGZpbmlzaGVkIHN1Y2Nlc3NmdWxseSlcbiAqICAgMSAgXHUyMDE0IGVycm9yIG9yIHRpbWVvdXRcbiAqICAgMTAgXHUyMDE0IGJsb2NrZWQgKGNvbW1hbmQgcmVwb3J0ZWQgYSBibG9ja2VyKVxuICogICAxMSBcdTIwMTQgY2FuY2VsbGVkIChTSUdJTlQvU0lHVEVSTSByZWNlaXZlZClcbiAqL1xuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMsIHdyaXRlU3luYyB9IGZyb20gJ25vZGU6ZnMnXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAnbm9kZTpwYXRoJ1xuaW1wb3J0IHsgcmVzb2x2ZSB9IGZyb20gJ25vZGU6cGF0aCdcbmltcG9ydCB7IENoaWxkUHJvY2VzcyB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2VzcydcblxuaW1wb3J0IHsgUnBjQ2xpZW50LCBTZXNzaW9uTWFuYWdlciB9IGZyb20gJ0Bnc2QvcGktY29kaW5nLWFnZW50J1xuaW1wb3J0IHR5cGUgeyBTZXNzaW9uSW5mbyB9IGZyb20gJ0Bnc2QvcGktY29kaW5nLWFnZW50J1xuaW1wb3J0IHsgZ2V0UHJvamVjdFNlc3Npb25zRGlyIH0gZnJvbSAnLi9wcm9qZWN0LXNlc3Npb25zLmpzJ1xuaW1wb3J0IHsgbG9hZEFuZFZhbGlkYXRlQW5zd2VyRmlsZSwgQW5zd2VySW5qZWN0b3IgfSBmcm9tICcuL2hlYWRsZXNzLWFuc3dlcnMuanMnXG5cbmltcG9ydCB7XG4gIGlzVGVybWluYWxOb3RpZmljYXRpb24sXG4gIGlzQmxvY2tlZE5vdGlmaWNhdGlvbixcbiAgaXNNaWxlc3RvbmVSZWFkeU5vdGlmaWNhdGlvbixcbiAgaXNRdWlja0NvbW1hbmQsXG4gIEZJUkVfQU5EX0ZPUkdFVF9NRVRIT0RTLFxuICBJRExFX1RJTUVPVVRfTVMsXG4gIE5FV19NSUxFU1RPTkVfSURMRV9USU1FT1VUX01TLFxuICBpc0ludGVyYWN0aXZlSGVhZGxlc3NUb29sLFxuICBzaG91bGRBcm1IZWFkbGVzc0lkbGVUaW1lb3V0LFxuICBFWElUX1NVQ0NFU1MsXG4gIEVYSVRfRVJST1IsXG4gIEVYSVRfQkxPQ0tFRCxcbiAgRVhJVF9DQU5DRUxMRUQsXG4gIG1hcFN0YXR1c1RvRXhpdENvZGUsXG59IGZyb20gJy4vaGVhZGxlc3MtZXZlbnRzLmpzJ1xuXG5pbXBvcnQgdHlwZSB7IE91dHB1dEZvcm1hdCwgSGVhZGxlc3NKc29uUmVzdWx0IH0gZnJvbSAnLi9oZWFkbGVzcy10eXBlcy5qcydcbmltcG9ydCB7IFZBTElEX09VVFBVVF9GT1JNQVRTIH0gZnJvbSAnLi9oZWFkbGVzcy10eXBlcy5qcydcblxuaW1wb3J0IHtcbiAgaGFuZGxlRXh0ZW5zaW9uVUlSZXF1ZXN0LFxuICBmb3JtYXRQcm9ncmVzcyxcbiAgZm9ybWF0VGhpbmtpbmdMaW5lLFxuICBmb3JtYXRUZXh0U3RhcnQsXG4gIGZvcm1hdFRleHRFbmQsXG4gIGZvcm1hdFRoaW5raW5nU3RhcnQsXG4gIGZvcm1hdFRoaW5raW5nRW5kLFxuICBzdGFydFN1cGVydmlzZWRTdGRpblJlYWRlcixcbn0gZnJvbSAnLi9oZWFkbGVzcy11aS5qcydcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uVUlSZXF1ZXN0LCBQcm9ncmVzc0NvbnRleHQgfSBmcm9tICcuL2hlYWRsZXNzLXVpLmpzJ1xuXG5pbXBvcnQge1xuICBsb2FkQ29udGV4dCxcbiAgYm9vdHN0cmFwR3NkUHJvamVjdCxcbn0gZnJvbSAnLi9oZWFkbGVzcy1jb250ZXh0LmpzJ1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFR5cGVzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGludGVyZmFjZSBIZWFkbGVzc09wdGlvbnMge1xuICB0aW1lb3V0OiBudW1iZXJcbiAganNvbjogYm9vbGVhblxuICBvdXRwdXRGb3JtYXQ6IE91dHB1dEZvcm1hdFxuICBtb2RlbD86IHN0cmluZ1xuICBjb21tYW5kOiBzdHJpbmdcbiAgY29tbWFuZEFyZ3M6IHN0cmluZ1tdXG4gIGNvbnRleHQ/OiBzdHJpbmcgICAgICAgLy8gZmlsZSBwYXRoIG9yICctJyBmb3Igc3RkaW5cbiAgY29udGV4dFRleHQ/OiBzdHJpbmcgICAvLyBpbmxpbmUgdGV4dFxuICBhdXRvPzogYm9vbGVhbiAgICAgICAgIC8vIGNoYWluIGludG8gYXV0by1tb2RlIGFmdGVyIG1pbGVzdG9uZSBjcmVhdGlvblxuICB2ZXJib3NlPzogYm9vbGVhbiAgICAgIC8vIHNob3cgdG9vbCBjYWxscyBpbiBvdXRwdXRcbiAgbWF4UmVzdGFydHM/OiBudW1iZXIgICAvLyBhdXRvLXJlc3RhcnQgb24gY3Jhc2ggKGRlZmF1bHQgMywgMCB0byBkaXNhYmxlKVxuICBzdXBlcnZpc2VkPzogYm9vbGVhbiAgIC8vIHN1cGVydmlzZWQgbW9kZTogZm9yd2FyZCBpbnRlcmFjdGl2ZSByZXF1ZXN0cyB0byBvcmNoZXN0cmF0b3JcbiAgcmVzcG9uc2VUaW1lb3V0PzogbnVtYmVyIC8vIHRpbWVvdXQgZm9yIG9yY2hlc3RyYXRvciByZXNwb25zZSAoZGVmYXVsdCAzMDAwMG1zKVxuICBhbnN3ZXJzPzogc3RyaW5nICAgICAgIC8vIHBhdGggdG8gYW5zd2VycyBKU09OIGZpbGVcbiAgZXZlbnRGaWx0ZXI/OiBTZXQ8c3RyaW5nPiAgLy8gZmlsdGVyIEpTT05MIG91dHB1dCB0byBzcGVjaWZpYyBldmVudCB0eXBlc1xuICByZXN1bWVTZXNzaW9uPzogc3RyaW5nIC8vIHNlc3Npb24gSUQgdG8gcmVzdW1lICgtLXJlc3VtZSA8aWQ+KVxuICBiYXJlPzogYm9vbGVhbiAgICAgICAgIC8vIC0tYmFyZTogc3VwcHJlc3MgQ0xBVURFLm1kL0FHRU5UUy5tZCwgdXNlciBza2lsbHMsIHByb2plY3QgcHJlZmVyZW5jZXNcbn1cblxuLyoqXG4gKiBDb21tYW5kcyBjbGFzc2lmaWVkIGFzIG11bHRpLXR1cm4gaW4gaGVhZGxlc3MgbW9kZTogdGhleSBpbnZvbHZlIG11bHRpcGxlXG4gKiBxdWVzdGlvbiByb3VuZHMsIGNvZGViYXNlIHNjYW5uaW5nLCBhbmQgYXJ0aWZhY3Qgd3JpdGluZyBiZWZvcmUgdGhlIHdvcmtmbG93XG4gKiBjb21wbGV0ZXMgKCMzNTQ3KS4gTXVsdGktdHVybiBjb21tYW5kcyBzdXBwcmVzcyBzaW5nbGUtZXhlY3V0aW9uLWNvbXBsZXRlXG4gKiBleGl0IGFuZCBkaXNhYmxlIHRoZSBkZWZhdWx0IDUtbWludXRlIHRpbWVvdXQuXG4gKlxuICogRXhwb3J0ZWQgc28gdGhlIHJlZ3Jlc3Npb24gdGVzdCBjYW4gZXhlcmNpc2UgdGhlIHJlYWwgY2xhc3NpZmllciByYXRoZXJcbiAqIHRoYW4gZ3JlcHBpbmcgdGhlIHNvdXJjZSBmb3IgaWRlbnRpZmllciBuYW1lcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzTXVsdGlUdXJuSGVhZGxlc3NDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gKFxuICAgIGNvbW1hbmQgPT09ICdhdXRvJyB8fFxuICAgIGNvbW1hbmQgPT09ICduZXh0JyB8fFxuICAgIGNvbW1hbmQgPT09ICdkaXNjdXNzJyB8fFxuICAgIGNvbW1hbmQgPT09ICdwbGFuJ1xuICApXG59XG5cbmludGVyZmFjZSBUcmFja2VkRXZlbnQge1xuICB0eXBlOiBzdHJpbmdcbiAgdGltZXN0YW1wOiBudW1iZXJcbiAgZGV0YWlsPzogc3RyaW5nXG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUmVzdW1lIFNlc3Npb24gUmVzb2x1dGlvblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVzdW1lU2Vzc2lvblJlc3VsdCB7XG4gIHNlc3Npb24/OiBTZXNzaW9uSW5mb1xuICBlcnJvcj86IHN0cmluZ1xufVxuXG4vKipcbiAqIFJlc29sdmUgYSBzZXNzaW9uIHByZWZpeCB0byBhIHNpbmdsZSBzZXNzaW9uLlxuICogRXhhY3QgaWQgbWF0Y2ggaXMgcHJlZmVycmVkIG92ZXIgcHJlZml4IG1hdGNoLlxuICogUmV0dXJucyBgeyBzZXNzaW9uIH1gIG9uIHVuaXF1ZSBtYXRjaCBvciBgeyBlcnJvciB9YCBvbiAwL2FtYmlndW91cyBtYXRjaGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVJlc3VtZVNlc3Npb24oc2Vzc2lvbnM6IFNlc3Npb25JbmZvW10sIHByZWZpeDogc3RyaW5nKTogUmVzdW1lU2Vzc2lvblJlc3VsdCB7XG4gIC8vIEV4YWN0IG1hdGNoIHRha2VzIHByaW9yaXR5XG4gIGNvbnN0IGV4YWN0ID0gc2Vzc2lvbnMuZmluZChzID0+IHMuaWQgPT09IHByZWZpeClcbiAgaWYgKGV4YWN0KSB7XG4gICAgcmV0dXJuIHsgc2Vzc2lvbjogZXhhY3QgfVxuICB9XG5cbiAgLy8gUHJlZml4IG1hdGNoXG4gIGNvbnN0IG1hdGNoZXMgPSBzZXNzaW9ucy5maWx0ZXIocyA9PiBzLmlkLnN0YXJ0c1dpdGgocHJlZml4KSlcbiAgaWYgKG1hdGNoZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHsgZXJyb3I6IGBObyBzZXNzaW9uIG1hdGNoaW5nICcke3ByZWZpeH0nIGZvdW5kYCB9XG4gIH1cbiAgaWYgKG1hdGNoZXMubGVuZ3RoID4gMSkge1xuICAgIGNvbnN0IGxpc3QgPSBtYXRjaGVzLm1hcChzID0+IGAgICR7cy5pZH1gKS5qb2luKCdcXG4nKVxuICAgIHJldHVybiB7IGVycm9yOiBgQW1iaWd1b3VzIHNlc3Npb24gcHJlZml4ICcke3ByZWZpeH0nIG1hdGNoZXMgJHttYXRjaGVzLmxlbmd0aH0gc2Vzc2lvbnM6XFxuJHtsaXN0fWAgfVxuICB9XG4gIHJldHVybiB7IHNlc3Npb246IG1hdGNoZXNbMF0gfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENMSSBBcmd1bWVudCBQYXJzZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VIZWFkbGVzc0FyZ3MoYXJndjogc3RyaW5nW10pOiBIZWFkbGVzc09wdGlvbnMge1xuICBjb25zdCBvcHRpb25zOiBIZWFkbGVzc09wdGlvbnMgPSB7XG4gICAgdGltZW91dDogMzAwXzAwMCxcbiAgICBqc29uOiBmYWxzZSxcbiAgICBvdXRwdXRGb3JtYXQ6ICd0ZXh0JyxcbiAgICBjb21tYW5kOiAnYXV0bycsXG4gICAgY29tbWFuZEFyZ3M6IFtdLFxuICB9XG5cbiAgY29uc3QgYXJncyA9IGFyZ3Yuc2xpY2UoMilcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhcmcgPSBhcmdzW2ldXG4gICAgaWYgKGFyZyA9PT0gJ2hlYWRsZXNzJykgY29udGludWVcblxuICAgIGlmIChhcmcuc3RhcnRzV2l0aCgnLS0nKSkge1xuICAgICAgaWYgKGFyZyA9PT0gJy0tdGltZW91dCcgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuICAgICAgICBvcHRpb25zLnRpbWVvdXQgPSBwYXJzZUludChhcmdzWysraV0sIDEwKVxuICAgICAgICBpZiAoTnVtYmVyLmlzTmFOKG9wdGlvbnMudGltZW91dCkgfHwgb3B0aW9ucy50aW1lb3V0IDwgMCkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbaGVhZGxlc3NdIEVycm9yOiAtLXRpbWVvdXQgbXVzdCBiZSBhIG5vbi1uZWdhdGl2ZSBpbnRlZ2VyIChtaWxsaXNlY29uZHMsIDAgdG8gZGlzYWJsZSlcXG4nKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tanNvbicpIHtcbiAgICAgICAgb3B0aW9ucy5qc29uID0gdHJ1ZVxuICAgICAgICBvcHRpb25zLm91dHB1dEZvcm1hdCA9ICdzdHJlYW0tanNvbidcbiAgICAgIH0gZWxzZSBpZiAoYXJnID09PSAnLS1vdXRwdXQtZm9ybWF0JyAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG4gICAgICAgIGNvbnN0IGZtdCA9IGFyZ3NbKytpXVxuICAgICAgICBpZiAoIVZBTElEX09VVFBVVF9GT1JNQVRTLmhhcyhmbXQpKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gRXJyb3I6IC0tb3V0cHV0LWZvcm1hdCBtdXN0IGJlIG9uZSBvZjogdGV4dCwganNvbiwgc3RyZWFtLWpzb24gKGdvdCAnJHtmbXR9JylcXG5gKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICAgIG9wdGlvbnMub3V0cHV0Rm9ybWF0ID0gZm10IGFzIE91dHB1dEZvcm1hdFxuICAgICAgICBpZiAoZm10ID09PSAnc3RyZWFtLWpzb24nIHx8IGZtdCA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgb3B0aW9ucy5qc29uID0gdHJ1ZVxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tbW9kZWwnICYmIGkgKyAxIDwgYXJncy5sZW5ndGgpIHtcbiAgICAgICAgLy8gLS1tb2RlbCBjYW4gYWxzbyBiZSBwYXNzZWQgZnJvbSB0aGUgbWFpbiBDTEk7IGhlYWRsZXNzLXNwZWNpZmljIHRha2VzIHByZWNlZGVuY2VcbiAgICAgICAgb3B0aW9ucy5tb2RlbCA9IGFyZ3NbKytpXVxuICAgICAgfSBlbHNlIGlmIChhcmcgPT09ICctLWNvbnRleHQnICYmIGkgKyAxIDwgYXJncy5sZW5ndGgpIHtcbiAgICAgICAgb3B0aW9ucy5jb250ZXh0ID0gYXJnc1srK2ldXG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tY29udGV4dC10ZXh0JyAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG4gICAgICAgIG9wdGlvbnMuY29udGV4dFRleHQgPSBhcmdzWysraV1cbiAgICAgIH0gZWxzZSBpZiAoYXJnID09PSAnLS1hdXRvJykge1xuICAgICAgICBvcHRpb25zLmF1dG8gPSB0cnVlXG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tdmVyYm9zZScpIHtcbiAgICAgICAgb3B0aW9ucy52ZXJib3NlID0gdHJ1ZVxuICAgICAgfSBlbHNlIGlmIChhcmcgPT09ICctLW1heC1yZXN0YXJ0cycgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuICAgICAgICBvcHRpb25zLm1heFJlc3RhcnRzID0gcGFyc2VJbnQoYXJnc1srK2ldLCAxMClcbiAgICAgICAgaWYgKE51bWJlci5pc05hTihvcHRpb25zLm1heFJlc3RhcnRzKSB8fCBvcHRpb25zLm1heFJlc3RhcnRzIDwgMCkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbaGVhZGxlc3NdIEVycm9yOiAtLW1heC1yZXN0YXJ0cyBtdXN0IGJlIGEgbm9uLW5lZ2F0aXZlIGludGVnZXJcXG4nKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tYW5zd2VycycgJiYgaSArIDEgPCBhcmdzLmxlbmd0aCkge1xuICAgICAgICBvcHRpb25zLmFuc3dlcnMgPSBhcmdzWysraV1cbiAgICAgIH0gZWxzZSBpZiAoYXJnID09PSAnLS1ldmVudHMnICYmIGkgKyAxIDwgYXJncy5sZW5ndGgpIHtcbiAgICAgICAgb3B0aW9ucy5ldmVudEZpbHRlciA9IG5ldyBTZXQoYXJnc1srK2ldLnNwbGl0KCcsJykpXG4gICAgICAgIG9wdGlvbnMuanNvbiA9IHRydWUgIC8vIC0tZXZlbnRzIGltcGxpZXMgLS1qc29uXG4gICAgICAgIGlmIChvcHRpb25zLm91dHB1dEZvcm1hdCA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgb3B0aW9ucy5vdXRwdXRGb3JtYXQgPSAnc3RyZWFtLWpzb24nXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoYXJnID09PSAnLS1zdXBlcnZpc2VkJykge1xuICAgICAgICBvcHRpb25zLnN1cGVydmlzZWQgPSB0cnVlXG4gICAgICAgIG9wdGlvbnMuanNvbiA9IHRydWUgIC8vIHN1cGVydmlzZWQgaW1wbGllcyBqc29uXG4gICAgICAgIGlmIChvcHRpb25zLm91dHB1dEZvcm1hdCA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgb3B0aW9ucy5vdXRwdXRGb3JtYXQgPSAnc3RyZWFtLWpzb24nXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoYXJnID09PSAnLS1yZXNwb25zZS10aW1lb3V0JyAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG4gICAgICAgIG9wdGlvbnMucmVzcG9uc2VUaW1lb3V0ID0gcGFyc2VJbnQoYXJnc1srK2ldLCAxMClcbiAgICAgICAgaWYgKE51bWJlci5pc05hTihvcHRpb25zLnJlc3BvbnNlVGltZW91dCkgfHwgb3B0aW9ucy5yZXNwb25zZVRpbWVvdXQgPD0gMCkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbaGVhZGxlc3NdIEVycm9yOiAtLXJlc3BvbnNlLXRpbWVvdXQgbXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXIgKG1pbGxpc2Vjb25kcylcXG4nKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKGFyZyA9PT0gJy0tcmVzdW1lJyAmJiBpICsgMSA8IGFyZ3MubGVuZ3RoKSB7XG4gICAgICAgIG9wdGlvbnMucmVzdW1lU2Vzc2lvbiA9IGFyZ3NbKytpXVxuICAgICAgfSBlbHNlIGlmIChhcmcgPT09ICctLWJhcmUnKSB7XG4gICAgICAgIG9wdGlvbnMuYmFyZSA9IHRydWVcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKG9wdGlvbnMuY29tbWFuZCA9PT0gJ2F1dG8nKSB7XG4gICAgICBvcHRpb25zLmNvbW1hbmQgPSBhcmdcbiAgICB9IGVsc2Uge1xuICAgICAgb3B0aW9ucy5jb21tYW5kQXJncy5wdXNoKGFyZylcbiAgICB9XG4gIH1cblxuICByZXR1cm4gb3B0aW9uc1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE1haW4gT3JjaGVzdHJhdG9yXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkhlYWRsZXNzKG9wdGlvbnM6IEhlYWRsZXNzT3B0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBtYXhSZXN0YXJ0cyA9IG9wdGlvbnMubWF4UmVzdGFydHMgPz8gM1xuICBsZXQgcmVzdGFydENvdW50ID0gMFxuXG4gIHdoaWxlICh0cnVlKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuSGVhZGxlc3NPbmNlKG9wdGlvbnMsIHJlc3RhcnRDb3VudClcblxuICAgIC8vIFN1Y2Nlc3Mgb3IgYmxvY2tlZCBcdTIwMTQgZXhpdCBub3JtYWxseVxuICAgIGlmIChyZXN1bHQuZXhpdENvZGUgPT09IEVYSVRfU1VDQ0VTUyB8fCByZXN1bHQuZXhpdENvZGUgPT09IEVYSVRfQkxPQ0tFRCkge1xuICAgICAgcHJvY2Vzcy5leGl0KHJlc3VsdC5leGl0Q29kZSlcbiAgICB9XG5cbiAgICAvLyBDcmFzaC9lcnJvciBcdTIwMTQgY2hlY2sgaWYgd2Ugc2hvdWxkIHJlc3RhcnRcbiAgICBpZiAocmVzdGFydENvdW50ID49IG1heFJlc3RhcnRzKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2hlYWRsZXNzXSBNYXggcmVzdGFydHMgKCR7bWF4UmVzdGFydHN9KSByZWFjaGVkLiBFeGl0aW5nLlxcbmApXG4gICAgICBwcm9jZXNzLmV4aXQocmVzdWx0LmV4aXRDb2RlKVxuICAgIH1cblxuICAgIC8vIERvbid0IHJlc3RhcnQgaWYgU0lHSU5UL1NJR1RFUk0gd2FzIHJlY2VpdmVkXG4gICAgaWYgKHJlc3VsdC5pbnRlcnJ1cHRlZCkge1xuICAgICAgcHJvY2Vzcy5leGl0KHJlc3VsdC5leGl0Q29kZSlcbiAgICB9XG5cbiAgICByZXN0YXJ0Q291bnQrK1xuICAgIGNvbnN0IGJhY2tvZmZNcyA9IE1hdGgubWluKDUwMDAgKiByZXN0YXJ0Q291bnQsIDMwXzAwMClcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2hlYWRsZXNzXSBSZXN0YXJ0aW5nIGluICR7KGJhY2tvZmZNcyAvIDEwMDApLnRvRml4ZWQoMCl9cyAoYXR0ZW1wdCAke3Jlc3RhcnRDb3VudH0vJHttYXhSZXN0YXJ0c30pLi4uXFxuYClcbiAgICBhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgYmFja29mZk1zKSlcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBydW5IZWFkbGVzc09uY2Uob3B0aW9uczogSGVhZGxlc3NPcHRpb25zLCByZXN0YXJ0Q291bnQ6IG51bWJlcik6IFByb21pc2U8eyBleGl0Q29kZTogbnVtYmVyOyBpbnRlcnJ1cHRlZDogYm9vbGVhbiB9PiB7XG4gIGxldCBpbnRlcnJ1cHRlZCA9IGZhbHNlXG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KClcbiAgY29uc3QgaXNOZXdNaWxlc3RvbmUgPSBvcHRpb25zLmNvbW1hbmQgPT09ICduZXctbWlsZXN0b25lJ1xuXG4gIC8vIG5ldy1taWxlc3RvbmUgaW52b2x2ZXMgY29kZWJhc2UgaW52ZXN0aWdhdGlvbiArIGFydGlmYWN0IHdyaXRpbmcgXHUyMDE0IG5lZWRzIG1vcmUgdGltZVxuICBpZiAoaXNOZXdNaWxlc3RvbmUgJiYgb3B0aW9ucy50aW1lb3V0ID09PSAzMDBfMDAwKSB7XG4gICAgb3B0aW9ucy50aW1lb3V0ID0gNjAwXzAwMCAvLyAxMCBtaW51dGVzXG4gIH1cblxuICAvLyBhdXRvLW1vZGUgc2Vzc2lvbnMgYXJlIGxvbmctcnVubmluZyAobWludXRlcyB0byBob3Vycykgd2l0aCB0aGVpciBvd24gaW50ZXJuYWxcbiAgLy8gcGVyLXVuaXQgdGltZW91dCB2aWEgYXV0by1zdXBlcnZpc29yLiBEaXNhYmxlIHRoZSBvdmVyYWxsIHRpbWVvdXQgdW5sZXNzIHRoZVxuICAvLyB1c2VyIGV4cGxpY2l0bHkgc2V0IC0tdGltZW91dC5cbiAgY29uc3QgaXNBdXRvTW9kZSA9IG9wdGlvbnMuY29tbWFuZCA9PT0gJ2F1dG8nXG4gIC8vIGRpc2N1c3MgYW5kIHBsYW4gYXJlIG11bHRpLXR1cm46IHRoZXkgaW52b2x2ZSBtdWx0aXBsZSBxdWVzdGlvbiByb3VuZHMsXG4gIC8vIGNvZGViYXNlIHNjYW5uaW5nLCBhbmQgYXJ0aWZhY3Qgd3JpdGluZyBiZWZvcmUgdGhlIHdvcmtmbG93IGNvbXBsZXRlcyAoIzM1NDcpLlxuICBjb25zdCBpc011bHRpVHVybkNvbW1hbmQgPSBpc011bHRpVHVybkhlYWRsZXNzQ29tbWFuZChvcHRpb25zLmNvbW1hbmQpXG4gIGlmIChpc0F1dG9Nb2RlICYmIG9wdGlvbnMudGltZW91dCA9PT0gMzAwXzAwMCkge1xuICAgIG9wdGlvbnMudGltZW91dCA9IDBcbiAgfVxuXG4gIC8vIFN1cGVydmlzZWQgbW9kZSBjYW5ub3Qgc2hhcmUgc3RkaW4gd2l0aCAtLWNvbnRleHQgLVxuICBpZiAob3B0aW9ucy5zdXBlcnZpc2VkICYmIG9wdGlvbnMuY29udGV4dCA9PT0gJy0nKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoJ1toZWFkbGVzc10gRXJyb3I6IC0tc3VwZXJ2aXNlZCBjYW5ub3QgYmUgdXNlZCB3aXRoIC0tY29udGV4dCAtIChib3RoIHJlcXVpcmUgc3RkaW4pXFxuJylcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIC8vIExvYWQgYW5zd2VyIGluamVjdGlvbiBmaWxlXG4gIGxldCBpbmplY3RvcjogQW5zd2VySW5qZWN0b3IgfCB1bmRlZmluZWRcbiAgaWYgKG9wdGlvbnMuYW5zd2Vycykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBhbnN3ZXJGaWxlID0gbG9hZEFuZFZhbGlkYXRlQW5zd2VyRmlsZShyZXNvbHZlKG9wdGlvbnMuYW5zd2VycykpXG4gICAgICBpbmplY3RvciA9IG5ldyBBbnN3ZXJJbmplY3RvcihhbnN3ZXJGaWxlKVxuICAgICAgaWYgKCFvcHRpb25zLmpzb24pIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gTG9hZGVkIGFuc3dlciBmaWxlOiAke29wdGlvbnMuYW5zd2Vyc31cXG5gKVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gRXJyb3IgbG9hZGluZyBhbnN3ZXIgZmlsZTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9XFxuYClcbiAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgIH1cbiAgfVxuXG4gIC8vIEZvciBuZXctbWlsZXN0b25lLCBsb2FkIGNvbnRleHQgYW5kIGJvb3RzdHJhcCAuZ3NkLyBiZWZvcmUgc3Bhd25pbmcgUlBDIGNoaWxkXG4gIGlmIChpc05ld01pbGVzdG9uZSkge1xuICAgIGlmICghb3B0aW9ucy5jb250ZXh0ICYmICFvcHRpb25zLmNvbnRleHRUZXh0KSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnW2hlYWRsZXNzXSBFcnJvcjogbmV3LW1pbGVzdG9uZSByZXF1aXJlcyAtLWNvbnRleHQgPGZpbGU+IG9yIC0tY29udGV4dC10ZXh0IDx0ZXh0PlxcbicpXG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICB9XG5cbiAgICBsZXQgY29udGV4dENvbnRlbnQ6IHN0cmluZ1xuICAgIHRyeSB7XG4gICAgICBjb250ZXh0Q29udGVudCA9IGF3YWl0IGxvYWRDb250ZXh0KG9wdGlvbnMpXG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2hlYWRsZXNzXSBFcnJvciBsb2FkaW5nIGNvbnRleHQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfVxcbmApXG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICB9XG5cbiAgICAvLyBCb290c3RyYXAgLmdzZC8gaWYgbmVlZGVkXG4gICAgY29uc3QgZ3NkRGlyID0gam9pbihwcm9jZXNzLmN3ZCgpLCAnLmdzZCcpXG4gICAgaWYgKCFleGlzdHNTeW5jKGdzZERpcikpIHtcbiAgICAgIGlmICghb3B0aW9ucy5qc29uKSB7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbaGVhZGxlc3NdIEJvb3RzdHJhcHBpbmcgLmdzZC8gcHJvamVjdCBzdHJ1Y3R1cmUuLi5cXG4nKVxuICAgICAgfVxuICAgICAgYm9vdHN0cmFwR3NkUHJvamVjdChwcm9jZXNzLmN3ZCgpKVxuICAgIH1cblxuICAgIC8vIFdyaXRlIGNvbnRleHQgdG8gdGVtcCBmaWxlIGZvciB0aGUgUlBDIGNoaWxkIHRvIHJlYWRcbiAgICBjb25zdCBydW50aW1lRGlyID0gam9pbihnc2REaXIsICdydW50aW1lJylcbiAgICBta2RpclN5bmMocnVudGltZURpciwgeyByZWN1cnNpdmU6IHRydWUgfSlcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocnVudGltZURpciwgJ2hlYWRsZXNzLWNvbnRleHQubWQnKSwgY29udGV4dENvbnRlbnQsICd1dGYtOCcpXG4gIH1cblxuICAvLyBWYWxpZGF0ZSAuZ3NkLyBkaXJlY3RvcnkgKHNraXAgZm9yIG5ldy1taWxlc3RvbmUgc2luY2Ugd2UganVzdCBib290c3RyYXBwZWQgaXQpXG4gIGNvbnN0IGdzZERpciA9IGpvaW4ocHJvY2Vzcy5jd2QoKSwgJy5nc2QnKVxuICBpZiAoIWlzTmV3TWlsZXN0b25lICYmICFleGlzdHNTeW5jKGdzZERpcikpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnW2hlYWRsZXNzXSBFcnJvcjogTm8gLmdzZC8gZGlyZWN0b3J5IGZvdW5kIGluIGN1cnJlbnQgZGlyZWN0b3J5LlxcbicpXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCJbaGVhZGxlc3NdIFJ1biAnZ3NkJyBpbnRlcmFjdGl2ZWx5IGZpcnN0IHRvIGluaXRpYWxpemUgYSBwcm9qZWN0LlxcblwiKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgLy8gUXVlcnk6IHJlYWQtb25seSBzdGF0ZSBzbmFwc2hvdCwgbm8gUlBDIGNoaWxkIG5lZWRlZFxuICBpZiAob3B0aW9ucy5jb21tYW5kID09PSAncXVlcnknKSB7XG4gICAgY29uc3QgeyBoYW5kbGVRdWVyeSB9ID0gYXdhaXQgaW1wb3J0KCcuL2hlYWRsZXNzLXF1ZXJ5LmpzJylcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVRdWVyeShwcm9jZXNzLmN3ZCgpKVxuICAgIHJldHVybiB7IGV4aXRDb2RlOiByZXN1bHQuZXhpdENvZGUsIGludGVycnVwdGVkOiBmYWxzZSB9XG4gIH1cblxuICAvLyBSZWNvdmVyOiByZWJ1aWxkIERCIGhpZXJhcmNoeSBmcm9tIG9uLWRpc2sgbWFya2Rvd24gcHJvamVjdGlvbnMsIG5vIFJQQ1xuICAvLyBjaGlsZCBuZWVkZWQuIFRoaXMgaXMgdGhlIG9uZSBtdXRhdGluZyBoZWFkbGVzcyBzdWJjb21tYW5kIFx1MjAxNCByZXF1aXJlZCBmb3JcbiAgLy8gQ0kgLyBhdXRvbWF0aW9uIHRoYXQgbmVlZHMgdG8gcmVjb25jaWxlIERCIHN0YXRlIGZyb20gbWFya2Rvd24gd2l0aG91dFxuICAvLyBsYXVuY2hpbmcgYW4gaW50ZXJhY3RpdmUgVFRZLWJvdW5kIHJ1bnRpbWUuXG4gIGlmIChvcHRpb25zLmNvbW1hbmQgPT09ICdyZWNvdmVyJykge1xuICAgIGNvbnN0IHsgaGFuZGxlUmVjb3ZlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2hlYWRsZXNzLXJlY292ZXIuanMnKVxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlY292ZXIocHJvY2Vzcy5jd2QoKSlcbiAgICBwcm9jZXNzLmV4aXQocmVzdWx0LmV4aXRDb2RlKVxuICB9XG5cbiAgLy8gRG9jdG9yOiByZWFkLW9ubHkgaGVhbHRoIGNoZWNrLCBubyBSUEMgY2hpbGQgbmVlZGVkICgjNDkwNCBsaXZlLXJlZ3Jlc3Npb24pLlxuICAvLyBUaGUgaW50ZXJhY3RpdmUgYC9nc2QgZG9jdG9yYCBjb21tYW5kIGxpdmVzIGluIHRoZSBHU0QgZXh0ZW5zaW9uOyB0aGlzIENMSVxuICAvLyBwYXRoIGxldHMgbm9uLWludGVyYWN0aXZlIGNhbGxlcnMgKENJLCByZWNvdmVyeSBzY3JpcHRzLCB0aGUgbGl2ZS1yZWdyZXNzaW9uXG4gIC8vIHN1aXRlKSBnZXQgdGhlIHNhbWUgZGlhZ25vc3RpYyB3aXRob3V0IGEgVFRZLlxuICBpZiAob3B0aW9ucy5jb21tYW5kID09PSAnZG9jdG9yJykge1xuICAgIGNvbnN0IHdhbnRzSnNvbiA9IG9wdGlvbnMuanNvbiB8fCBvcHRpb25zLmNvbW1hbmRBcmdzLmluY2x1ZGVzKCctLWpzb24nKVxuICAgIGNvbnN0IHsgcnVuR1NERG9jdG9yIH0gPSBhd2FpdCBpbXBvcnQoJy4vcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RvY3Rvci5qcycpXG4gICAgY29uc3QgeyBmb3JtYXREb2N0b3JSZXBvcnQsIGZvcm1hdERvY3RvclJlcG9ydEpzb24gfSA9IGF3YWl0IGltcG9ydCgnLi9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZG9jdG9yLWZvcm1hdC5qcycpXG4gICAgbGV0IGV4aXRDb2RlID0gMVxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXBvcnQgPSBhd2FpdCBydW5HU0REb2N0b3IocHJvY2Vzcy5jd2QoKSlcbiAgICAgIGNvbnN0IG91dCA9IHdhbnRzSnNvbiA/IGZvcm1hdERvY3RvclJlcG9ydEpzb24ocmVwb3J0KSA6IGZvcm1hdERvY3RvclJlcG9ydChyZXBvcnQpXG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtvdXR9XFxuYClcbiAgICAgIGV4aXRDb2RlID0gcmVwb3J0Lm9rID8gMCA6IDFcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gZG9jdG9yIGZhaWxlZDogJHttc2d9XFxuYClcbiAgICAgIGV4aXRDb2RlID0gMVxuICAgIH1cbiAgICAvLyBCeXBhc3MgdGhlIGF1dG8tcmVzdGFydCBsb29wIGluIHJ1bkhlYWRsZXNzIFx1MjAxNCBkb2N0b3IgaXMgYSBvbmUtc2hvdFxuICAgIC8vIGRpYWdub3N0aWM7IGV4aXQgMSBtZWFucyBcImlzc3VlcyBkZXRlY3RlZFwiLCBub3QgXCJjcmFzaGVkXCIuXG4gICAgcHJvY2Vzcy5leGl0KGV4aXRDb2RlKVxuICB9XG5cbiAgLy8gUmVzb2x2ZSBDTEkgcGF0aCBmb3IgdGhlIGNoaWxkIHByb2Nlc3NcbiAgY29uc3QgY2xpUGF0aCA9IHByb2Nlc3MuZW52LkdTRF9CSU5fUEFUSCB8fCBwcm9jZXNzLmFyZ3ZbMV1cbiAgaWYgKCFjbGlQYXRoKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoJ1toZWFkbGVzc10gRXJyb3I6IENhbm5vdCBkZXRlcm1pbmUgQ0xJIHBhdGguIFNldCBHU0RfQklOX1BBVEggb3IgcnVuIHZpYSBnc2QuXFxuJylcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIC8vIENyZWF0ZSBSUEMgY2xpZW50XG4gIGNvbnN0IGNsaWVudE9wdGlvbnM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIGNsaVBhdGgsXG4gICAgY3dkOiBwcm9jZXNzLmN3ZCgpLFxuICB9XG4gIGlmIChvcHRpb25zLm1vZGVsKSB7XG4gICAgY2xpZW50T3B0aW9ucy5tb2RlbCA9IG9wdGlvbnMubW9kZWxcbiAgfVxuICBpZiAoaW5qZWN0b3IpIHtcbiAgICBjbGllbnRPcHRpb25zLmVudiA9IGluamVjdG9yLmdldFNlY3JldEVudlZhcnMoKVxuICB9XG4gIC8vIFNpZ25hbCBoZWFkbGVzcyBtb2RlIHRvIHRoZSBHU0QgZXh0ZW5zaW9uIChza2lwcyBVQVQgaHVtYW4gcGF1c2UsIGV0Yy4pXG4gIGNsaWVudE9wdGlvbnMuZW52ID0geyAuLi4oY2xpZW50T3B0aW9ucy5lbnYgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8fCB7fSksIEdTRF9IRUFETEVTUzogJzEnIH1cbiAgLy8gUHJvcGFnYXRlIC0tYmFyZSB0byB0aGUgY2hpbGQgcHJvY2Vzc1xuICBpZiAob3B0aW9ucy5iYXJlKSB7XG4gICAgY2xpZW50T3B0aW9ucy5hcmdzID0gWy4uLigoY2xpZW50T3B0aW9ucy5hcmdzIGFzIHN0cmluZ1tdKSB8fCBbXSksICctLWJhcmUnXVxuICB9XG5cbiAgY29uc3QgY2xpZW50ID0gbmV3IFJwY0NsaWVudChjbGllbnRPcHRpb25zKVxuXG4gIC8vIEV2ZW50IHRyYWNraW5nXG4gIGxldCB0b3RhbEV2ZW50cyA9IDBcbiAgbGV0IHRvb2xDYWxsQ291bnQgPSAwXG4gIGxldCBibG9ja2VkID0gZmFsc2VcbiAgbGV0IGNvbXBsZXRlZCA9IGZhbHNlXG4gIGxldCBleGl0Q29kZSA9IDBcbiAgbGV0IG1pbGVzdG9uZVJlYWR5ID0gZmFsc2UgIC8vIHRyYWNrcyBcIk1pbGVzdG9uZSBYIHJlYWR5LlwiIGZvciBhdXRvLWNoYWluaW5nXG4gIGNvbnN0IHJlY2VudEV2ZW50czogVHJhY2tlZEV2ZW50W10gPSBbXVxuICBjb25zdCBpbnRlcmFjdGl2ZVRvb2xDYWxsSWRzID0gbmV3IFNldDxzdHJpbmc+KClcblxuICAvLyBKU09OIGJhdGNoIG1vZGU6IGNvc3QgYWdncmVnYXRpb24gKGN1bXVsYXRpdmUtbWF4IHBhdHRlcm4gcGVyIEswMDQpXG4gIGxldCBjdW11bGF0aXZlQ29zdFVzZCA9IDBcbiAgbGV0IGN1bXVsYXRpdmVJbnB1dFRva2VucyA9IDBcbiAgbGV0IGN1bXVsYXRpdmVPdXRwdXRUb2tlbnMgPSAwXG4gIGxldCBjdW11bGF0aXZlQ2FjaGVSZWFkVG9rZW5zID0gMFxuICBsZXQgY3VtdWxhdGl2ZUNhY2hlV3JpdGVUb2tlbnMgPSAwXG4gIGxldCBsYXN0U2Vzc2lvbklkOiBzdHJpbmcgfCB1bmRlZmluZWRcblxuICAvLyBWZXJib3NlIHRleHQtbW9kZSBzdGF0ZVxuICBjb25zdCB0b29sU3RhcnRUaW1lcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KClcbiAgbGV0IGxhc3RDb3N0RGF0YTogeyBjb3N0VXNkOiBudW1iZXI7IGlucHV0VG9rZW5zOiBudW1iZXI7IG91dHB1dFRva2VuczogbnVtYmVyIH0gfCB1bmRlZmluZWRcbiAgbGV0IHRoaW5raW5nQnVmZmVyID0gJydcbiAgLy8gU3RyZWFtaW5nIHN0YXRlOiB0cmFja3Mgd2hldGhlciB3ZSdyZSBpbnNpZGUgYSB0ZXh0IG9yIHRoaW5raW5nIGJsb2NrXG4gIGxldCBpblRleHRCbG9jayA9IGZhbHNlXG4gIGxldCBpblRoaW5raW5nQmxvY2sgPSBmYWxzZVxuXG4gIC8vIEVtaXQgSGVhZGxlc3NKc29uUmVzdWx0IHRvIHN0ZG91dCBmb3IgLS1vdXRwdXQtZm9ybWF0IGpzb24gYmF0Y2ggbW9kZVxuICBmdW5jdGlvbiBlbWl0QmF0Y2hKc29uUmVzdWx0KCk6IHZvaWQge1xuICAgIGlmIChvcHRpb25zLm91dHB1dEZvcm1hdCAhPT0gJ2pzb24nKSByZXR1cm5cbiAgICBjb25zdCBkdXJhdGlvbiA9IERhdGUubm93KCkgLSBzdGFydFRpbWVcbiAgICBjb25zdCBzdGF0dXM6IEhlYWRsZXNzSnNvblJlc3VsdFsnc3RhdHVzJ10gPSBibG9ja2VkID8gJ2Jsb2NrZWQnXG4gICAgICA6IGV4aXRDb2RlID09PSBFWElUX0NBTkNFTExFRCA/ICdjYW5jZWxsZWQnXG4gICAgICA6IGV4aXRDb2RlID09PSBFWElUX0VSUk9SID8gKHRvdGFsRXZlbnRzID09PSAwID8gJ2Vycm9yJyA6ICd0aW1lb3V0JylcbiAgICAgIDogJ3N1Y2Nlc3MnXG4gICAgY29uc3QgcmVzdWx0OiBIZWFkbGVzc0pzb25SZXN1bHQgPSB7XG4gICAgICBzdGF0dXMsXG4gICAgICBleGl0Q29kZSxcbiAgICAgIHNlc3Npb25JZDogbGFzdFNlc3Npb25JZCxcbiAgICAgIGR1cmF0aW9uLFxuICAgICAgY29zdDoge1xuICAgICAgICB0b3RhbDogY3VtdWxhdGl2ZUNvc3RVc2QsXG4gICAgICAgIGlucHV0X3Rva2VuczogY3VtdWxhdGl2ZUlucHV0VG9rZW5zLFxuICAgICAgICBvdXRwdXRfdG9rZW5zOiBjdW11bGF0aXZlT3V0cHV0VG9rZW5zLFxuICAgICAgICBjYWNoZV9yZWFkX3Rva2VuczogY3VtdWxhdGl2ZUNhY2hlUmVhZFRva2VucyxcbiAgICAgICAgY2FjaGVfd3JpdGVfdG9rZW5zOiBjdW11bGF0aXZlQ2FjaGVXcml0ZVRva2VucyxcbiAgICAgIH0sXG4gICAgICB0b29sQ2FsbHM6IHRvb2xDYWxsQ291bnQsXG4gICAgICBldmVudHM6IHRvdGFsRXZlbnRzLFxuICAgIH1cbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShKU09OLnN0cmluZ2lmeShyZXN1bHQpICsgJ1xcbicpXG4gIH1cblxuICBmdW5jdGlvbiB0cmFja0V2ZW50KGV2ZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQge1xuICAgIHRvdGFsRXZlbnRzKytcbiAgICBjb25zdCB0eXBlID0gU3RyaW5nKGV2ZW50LnR5cGUgPz8gJ3Vua25vd24nKVxuXG4gICAgaWYgKHR5cGUgPT09ICd0b29sX2V4ZWN1dGlvbl9zdGFydCcpIHtcbiAgICAgIHRvb2xDYWxsQ291bnQrK1xuICAgIH1cblxuICAgIC8vIEtlZXAgbGFzdCAyMCBldmVudHMgZm9yIGRpYWdub3N0aWNzXG4gICAgY29uc3QgZGV0YWlsID1cbiAgICAgIHR5cGUgPT09ICd0b29sX2V4ZWN1dGlvbl9zdGFydCdcbiAgICAgICAgPyBTdHJpbmcoZXZlbnQudG9vbE5hbWUgPz8gJycpXG4gICAgICAgIDogdHlwZSA9PT0gJ2V4dGVuc2lvbl91aV9yZXF1ZXN0J1xuICAgICAgICAgID8gYCR7ZXZlbnQubWV0aG9kfTogJHtldmVudC50aXRsZSA/PyBldmVudC5tZXNzYWdlID8/ICcnfWBcbiAgICAgICAgICA6IHVuZGVmaW5lZFxuXG4gICAgcmVjZW50RXZlbnRzLnB1c2goeyB0eXBlLCB0aW1lc3RhbXA6IERhdGUubm93KCksIGRldGFpbCB9KVxuICAgIGlmIChyZWNlbnRFdmVudHMubGVuZ3RoID4gMjApIHJlY2VudEV2ZW50cy5zaGlmdCgpXG4gIH1cblxuICAvLyBDbGllbnQgc3RhcnRlZCBmbGFnIFx1MjAxNCByZXBsYWNlcyBvbGQgc3RkaW5Xcml0ZXIgbnVsbC1jaGVja1xuICBsZXQgY2xpZW50U3RhcnRlZCA9IGZhbHNlXG4gIC8vIEFkYXB0ZXIgZm9yIEFuc3dlckluamVjdG9yIFx1MjAxNCB3cmFwcyBjbGllbnQuc2VuZFVJUmVzcG9uc2UgaW4gYSB3cml0ZVRvU3RkaW4tY29tcGF0aWJsZSBjYWxsYmFja1xuICAvLyBJbml0aWFsaXplZCBhZnRlciBjbGllbnQuc3RhcnQoKTsgZXZlbnRzIHdvbid0IGZpcmUgYmVmb3JlIHRoZW5cbiAgbGV0IGluamVjdG9yU3RkaW5BZGFwdGVyOiAoZGF0YTogc3RyaW5nKSA9PiB2b2lkID0gKCkgPT4ge31cblxuICAvLyBTdXBlcnZpc2VkIG1vZGUgc3RhdGVcbiAgY29uc3QgcGVuZGluZ1Jlc3BvbnNlVGltZXJzID0gbmV3IE1hcDxzdHJpbmcsIFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+PigpXG4gIGxldCBzdXBlcnZpc2VkRmFsbGJhY2sgPSBmYWxzZVxuICBsZXQgc3RvcFN1cGVydmlzZWRSZWFkZXI6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsXG4gIGNvbnN0IG9uU3RkaW5DbG9zZSA9ICgpID0+IHtcbiAgICBzdXBlcnZpc2VkRmFsbGJhY2sgPSB0cnVlXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoJ1toZWFkbGVzc10gV2FybmluZzogb3JjaGVzdHJhdG9yIHN0ZGluIGNsb3NlZCwgZmFsbGluZyBiYWNrIHRvIGF1dG8tcmVzcG9uc2VcXG4nKVxuICB9XG4gIGlmIChvcHRpb25zLnN1cGVydmlzZWQpIHtcbiAgICBwcm9jZXNzLnN0ZGluLm9uKCdjbG9zZScsIG9uU3RkaW5DbG9zZSlcbiAgfVxuXG4gIC8vIENvbXBsZXRpb24gcHJvbWlzZVxuICBsZXQgcmVzb2x2ZUNvbXBsZXRpb246ICgpID0+IHZvaWRcbiAgY29uc3QgY29tcGxldGlvblByb21pc2UgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgIHJlc29sdmVDb21wbGV0aW9uID0gcmVzb2x2ZVxuICB9KVxuXG4gIC8vIElkbGUgdGltZW91dCBcdTIwMTQgZmFsbGJhY2sgY29tcGxldGlvbiBkZXRlY3Rpb25cbiAgbGV0IGlkbGVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbFxuICBjb25zdCBlZmZlY3RpdmVJZGxlVGltZW91dCA9IGlzTmV3TWlsZXN0b25lID8gTkVXX01JTEVTVE9ORV9JRExFX1RJTUVPVVRfTVMgOiBJRExFX1RJTUVPVVRfTVNcblxuICBmdW5jdGlvbiByZXNldElkbGVUaW1lcigpOiB2b2lkIHtcbiAgICBpZiAoaWRsZVRpbWVyKSBjbGVhclRpbWVvdXQoaWRsZVRpbWVyKVxuICAgIGlmIChzaG91bGRBcm1IZWFkbGVzc0lkbGVUaW1lb3V0KHRvb2xDYWxsQ291bnQsIGludGVyYWN0aXZlVG9vbENhbGxJZHMuc2l6ZSkpIHtcbiAgICAgIGlkbGVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBjb21wbGV0ZWQgPSB0cnVlXG4gICAgICAgIHJlc29sdmVDb21wbGV0aW9uKClcbiAgICAgIH0sIGVmZmVjdGl2ZUlkbGVUaW1lb3V0KVxuICAgIH1cbiAgfVxuXG4gIC8vIFByZWNvbXB1dGUgc3VwZXJ2aXNlZCByZXNwb25zZSB0aW1lb3V0XG4gIGNvbnN0IHJlc3BvbnNlVGltZW91dCA9IG9wdGlvbnMucmVzcG9uc2VUaW1lb3V0ID8/IDMwXzAwMFxuXG4gIC8vIE92ZXJhbGwgdGltZW91dCAoZGlzYWJsZWQgd2hlbiBvcHRpb25zLnRpbWVvdXQgPT09IDAsIGUuZy4gYXV0by1tb2RlKVxuICBjb25zdCB0aW1lb3V0VGltZXIgPSBvcHRpb25zLnRpbWVvdXQgPiAwXG4gICAgPyBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gVGltZW91dCBhZnRlciAke29wdGlvbnMudGltZW91dCAvIDEwMDB9c1xcbmApXG4gICAgICAgIGV4aXRDb2RlID0gRVhJVF9FUlJPUlxuICAgICAgICByZXNvbHZlQ29tcGxldGlvbigpXG4gICAgICB9LCBvcHRpb25zLnRpbWVvdXQpXG4gICAgOiBudWxsXG5cbiAgLy8gRXZlbnQgaGFuZGxlclxuICBjbGllbnQub25FdmVudCgoZXZlbnQpID0+IHtcbiAgICBjb25zdCBldmVudE9iaiA9IGV2ZW50IGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgICB0cmFja0V2ZW50KGV2ZW50T2JqKVxuXG4gICAgY29uc3QgZXZlbnRUeXBlID0gU3RyaW5nKGV2ZW50T2JqLnR5cGUgPz8gJycpXG4gICAgaWYgKGV2ZW50VHlwZSA9PT0gJ3Rvb2xfZXhlY3V0aW9uX3N0YXJ0Jykge1xuICAgICAgY29uc3QgdG9vbENhbGxJZCA9IFN0cmluZyhldmVudE9iai50b29sQ2FsbElkID8/IGV2ZW50T2JqLmlkID8/ICcnKVxuICAgICAgaWYgKHRvb2xDYWxsSWQgJiYgaXNJbnRlcmFjdGl2ZUhlYWRsZXNzVG9vbChTdHJpbmcoZXZlbnRPYmoudG9vbE5hbWUgPz8gJycpKSkge1xuICAgICAgICBpbnRlcmFjdGl2ZVRvb2xDYWxsSWRzLmFkZCh0b29sQ2FsbElkKVxuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoZXZlbnRUeXBlID09PSAndG9vbF9leGVjdXRpb25fZW5kJykge1xuICAgICAgY29uc3QgdG9vbENhbGxJZCA9IFN0cmluZyhldmVudE9iai50b29sQ2FsbElkID8/IGV2ZW50T2JqLmlkID8/ICcnKVxuICAgICAgaWYgKHRvb2xDYWxsSWQpIHtcbiAgICAgICAgaW50ZXJhY3RpdmVUb29sQ2FsbElkcy5kZWxldGUodG9vbENhbGxJZClcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXNldElkbGVUaW1lcigpXG5cbiAgICAvLyBBbnN3ZXIgaW5qZWN0b3I6IG9ic2VydmUgZXZlbnRzIGZvciBxdWVzdGlvbiBtZXRhZGF0YVxuICAgIGluamVjdG9yPy5vYnNlcnZlRXZlbnQoZXZlbnRPYmopXG5cbiAgICAvLyAtLWpzb24gLyAtLW91dHB1dC1mb3JtYXQgc3RyZWFtLWpzb246IGZvcndhcmQgZXZlbnRzIGFzIEpTT05MIHRvIHN0ZG91dCAoZmlsdGVyZWQgaWYgLS1ldmVudHMpXG4gICAgLy8gLS1vdXRwdXQtZm9ybWF0IGpzb24gKGJhdGNoIG1vZGUpOiBzdXBwcmVzcyBzdHJlYW1pbmcsIHRyYWNrIGNvc3QgZm9yIGZpbmFsIHJlc3VsdFxuICAgIGlmIChvcHRpb25zLmpzb24gJiYgb3B0aW9ucy5vdXRwdXRGb3JtYXQgPT09ICdzdHJlYW0tanNvbicpIHtcbiAgICAgIGlmICghb3B0aW9ucy5ldmVudEZpbHRlciB8fCBvcHRpb25zLmV2ZW50RmlsdGVyLmhhcyhldmVudFR5cGUpKSB7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKEpTT04uc3RyaW5naWZ5KGV2ZW50T2JqKSArICdcXG4nKVxuICAgICAgfVxuICAgIH0gZWxzZSBpZiAob3B0aW9ucy5vdXRwdXRGb3JtYXQgPT09ICdqc29uJykge1xuICAgICAgLy8gQmF0Y2ggbW9kZTogc2lsZW50bHkgdHJhY2sgY29zdF91cGRhdGUgZXZlbnRzIChjdW11bGF0aXZlLW1heCBwZXIgSzAwNClcbiAgICAgIGNvbnN0IGV2ZW50VHlwZSA9IFN0cmluZyhldmVudE9iai50eXBlID8/ICcnKVxuICAgICAgaWYgKGV2ZW50VHlwZSA9PT0gJ2Nvc3RfdXBkYXRlJykge1xuICAgICAgICBjb25zdCBkYXRhID0gZXZlbnRPYmogYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgICAgICAgY29uc3QgY3VtQ29zdCA9IGRhdGEuY3VtdWxhdGl2ZUNvc3QgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWRcbiAgICAgICAgaWYgKGN1bUNvc3QpIHtcbiAgICAgICAgICBjdW11bGF0aXZlQ29zdFVzZCA9IE1hdGgubWF4KGN1bXVsYXRpdmVDb3N0VXNkLCBOdW1iZXIoY3VtQ29zdC5jb3N0VXNkID8/IDApKVxuICAgICAgICAgIGNvbnN0IHRva2VucyA9IGRhdGEudG9rZW5zIGFzIFJlY29yZDxzdHJpbmcsIG51bWJlcj4gfCB1bmRlZmluZWRcbiAgICAgICAgICBpZiAodG9rZW5zKSB7XG4gICAgICAgICAgICBjdW11bGF0aXZlSW5wdXRUb2tlbnMgPSBNYXRoLm1heChjdW11bGF0aXZlSW5wdXRUb2tlbnMsIHRva2Vucy5pbnB1dCA/PyAwKVxuICAgICAgICAgICAgY3VtdWxhdGl2ZU91dHB1dFRva2VucyA9IE1hdGgubWF4KGN1bXVsYXRpdmVPdXRwdXRUb2tlbnMsIHRva2Vucy5vdXRwdXQgPz8gMClcbiAgICAgICAgICAgIGN1bXVsYXRpdmVDYWNoZVJlYWRUb2tlbnMgPSBNYXRoLm1heChjdW11bGF0aXZlQ2FjaGVSZWFkVG9rZW5zLCB0b2tlbnMuY2FjaGVSZWFkID8/IDApXG4gICAgICAgICAgICBjdW11bGF0aXZlQ2FjaGVXcml0ZVRva2VucyA9IE1hdGgubWF4KGN1bXVsYXRpdmVDYWNoZVdyaXRlVG9rZW5zLCB0b2tlbnMuY2FjaGVXcml0ZSA/PyAwKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gVHJhY2sgc2Vzc2lvbklkIGZyb20gaW5pdF9yZXN1bHRcbiAgICAgIGlmIChldmVudFR5cGUgPT09ICdpbml0X3Jlc3VsdCcpIHtcbiAgICAgICAgbGFzdFNlc3Npb25JZCA9IFN0cmluZygoZXZlbnRPYmogYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLnNlc3Npb25JZCA/PyAnJylcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKCFvcHRpb25zLmpzb24pIHtcbiAgICAgIC8vIFByb2dyZXNzIG91dHB1dCB0byBzdGRlcnIgd2l0aCB2ZXJib3NlIHN0YXRlIHRyYWNraW5nXG4gICAgICBjb25zdCBldmVudFR5cGUgPSBTdHJpbmcoZXZlbnRPYmoudHlwZSA/PyAnJylcblxuICAgICAgLy8gVHJhY2sgY29zdF91cGRhdGUgZXZlbnRzIGZvciBhZ2VudF9lbmQgc3VtbWFyeVxuICAgICAgaWYgKGV2ZW50VHlwZSA9PT0gJ2Nvc3RfdXBkYXRlJykge1xuICAgICAgICBjb25zdCBkYXRhID0gZXZlbnRPYmogYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgICAgICAgY29uc3QgY3VtQ29zdCA9IGRhdGEuY3VtdWxhdGl2ZUNvc3QgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWRcbiAgICAgICAgaWYgKGN1bUNvc3QpIHtcbiAgICAgICAgICBjb25zdCB0b2tlbnMgPSBkYXRhLnRva2VucyBhcyBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+IHwgdW5kZWZpbmVkXG4gICAgICAgICAgbGFzdENvc3REYXRhID0ge1xuICAgICAgICAgICAgY29zdFVzZDogTnVtYmVyKGN1bUNvc3QuY29zdFVzZCA/PyAwKSxcbiAgICAgICAgICAgIGlucHV0VG9rZW5zOiB0b2tlbnM/LmlucHV0ID8/IDAsXG4gICAgICAgICAgICBvdXRwdXRUb2tlbnM6IHRva2Vucz8ub3V0cHV0ID8/IDAsXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFN0cmVhbSBhc3Npc3RhbnQgdGV4dCBhbmQgdGhpbmtpbmcgZGVsdGFzIGluIHZlcmJvc2UgbW9kZVxuICAgICAgaWYgKGV2ZW50VHlwZSA9PT0gJ21lc3NhZ2VfdXBkYXRlJykge1xuICAgICAgICBjb25zdCBhbWUgPSBldmVudE9iai5hc3Npc3RhbnRNZXNzYWdlRXZlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWRcbiAgICAgICAgaWYgKGFtZSAmJiBvcHRpb25zLnZlcmJvc2UpIHtcbiAgICAgICAgICBjb25zdCBhbWVUeXBlID0gU3RyaW5nKGFtZS50eXBlID8/ICcnKVxuXG4gICAgICAgICAgLy8gLS0tIFRleHQgc3RyZWFtaW5nIC0tLVxuICAgICAgICAgIGlmIChhbWVUeXBlID09PSAndGV4dF9zdGFydCcpIHtcbiAgICAgICAgICAgIGluVGV4dEJsb2NrID0gdHJ1ZVxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZm9ybWF0VGV4dFN0YXJ0KCkpXG4gICAgICAgICAgfSBlbHNlIGlmIChhbWVUeXBlID09PSAndGV4dF9kZWx0YScpIHtcbiAgICAgICAgICAgIGNvbnN0IGRlbHRhID0gU3RyaW5nKGFtZS5kZWx0YSA/PyBhbWUudGV4dCA/PyAnJylcbiAgICAgICAgICAgIGlmIChkZWx0YSkge1xuICAgICAgICAgICAgICBpZiAoIWluVGV4dEJsb2NrKSB7XG4gICAgICAgICAgICAgICAgLy8gRWRnZSBjYXNlOiBkZWx0YSB3aXRob3V0IHN0YXJ0XG4gICAgICAgICAgICAgICAgaW5UZXh0QmxvY2sgPSB0cnVlXG4gICAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZm9ybWF0VGV4dFN0YXJ0KCkpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZGVsdGEpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChhbWVUeXBlID09PSAndGV4dF9lbmQnKSB7XG4gICAgICAgICAgICBpZiAoaW5UZXh0QmxvY2spIHtcbiAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZm9ybWF0VGV4dEVuZCgpICsgJ1xcbicpXG4gICAgICAgICAgICAgIGluVGV4dEJsb2NrID0gZmFsc2VcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyAtLS0gVGhpbmtpbmcgc3RyZWFtaW5nIC0tLVxuICAgICAgICAgIGVsc2UgaWYgKGFtZVR5cGUgPT09ICd0aGlua2luZ19zdGFydCcpIHtcbiAgICAgICAgICAgIGluVGhpbmtpbmdCbG9jayA9IHRydWVcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGZvcm1hdFRoaW5raW5nU3RhcnQoKSlcbiAgICAgICAgICB9IGVsc2UgaWYgKGFtZVR5cGUgPT09ICd0aGlua2luZ19kZWx0YScpIHtcbiAgICAgICAgICAgIGNvbnN0IGRlbHRhID0gU3RyaW5nKGFtZS5kZWx0YSA/PyBhbWUudGV4dCA/PyAnJylcbiAgICAgICAgICAgIGlmIChkZWx0YSkge1xuICAgICAgICAgICAgICBpZiAoIWluVGhpbmtpbmdCbG9jaykge1xuICAgICAgICAgICAgICAgIGluVGhpbmtpbmdCbG9jayA9IHRydWVcbiAgICAgICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShmb3JtYXRUaGlua2luZ1N0YXJ0KCkpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZGVsdGEpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChhbWVUeXBlID09PSAndGhpbmtpbmdfZW5kJykge1xuICAgICAgICAgICAgaWYgKGluVGhpbmtpbmdCbG9jaykge1xuICAgICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShmb3JtYXRUaGlua2luZ0VuZCgpICsgJ1xcbicpXG4gICAgICAgICAgICAgIGluVGhpbmtpbmdCbG9jayA9IGZhbHNlXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8vIE5vbi12ZXJib3NlOiBhY2N1bXVsYXRlIHRleHRfZGVsdGEgZm9yIHRydW5jYXRlZCBvbmUtbGluZXJcbiAgICAgICAgZWxzZSBpZiAoYW1lPy50eXBlID09PSAndGV4dF9kZWx0YScpIHtcbiAgICAgICAgICB0aGlua2luZ0J1ZmZlciArPSBTdHJpbmcoYW1lLmRlbHRhID8/IGFtZS50ZXh0ID8/ICcnKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFRyYWNrIHRvb2wgZXhlY3V0aW9uIHN0YXJ0IHRpbWVzdGFtcHNcbiAgICAgIGlmIChldmVudFR5cGUgPT09ICd0b29sX2V4ZWN1dGlvbl9zdGFydCcpIHtcbiAgICAgICAgY29uc3QgdG9vbENhbGxJZCA9IFN0cmluZyhldmVudE9iai50b29sQ2FsbElkID8/IGV2ZW50T2JqLmlkID8/ICcnKVxuICAgICAgICBpZiAodG9vbENhbGxJZCkgdG9vbFN0YXJ0VGltZXMuc2V0KHRvb2xDYWxsSWQsIERhdGUubm93KCkpXG4gICAgICB9XG5cbiAgICAgIC8vIENsb3NlIGFueSBvcGVuIHN0cmVhbWluZyBibG9ja3MgYmVmb3JlIHRvb2wgY2FsbHMgb3IgbWVzc2FnZSBlbmRcbiAgICAgIGlmIChvcHRpb25zLnZlcmJvc2UgJiYgKGV2ZW50VHlwZSA9PT0gJ3Rvb2xfZXhlY3V0aW9uX3N0YXJ0JyB8fCBldmVudFR5cGUgPT09ICdtZXNzYWdlX2VuZCcpKSB7XG4gICAgICAgIGlmIChpblRleHRCbG9jaykge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdcXG4nKVxuICAgICAgICAgIGluVGV4dEJsb2NrID0gZmFsc2VcbiAgICAgICAgfVxuICAgICAgICBpZiAoaW5UaGlua2luZ0Jsb2NrKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoJ1xcbicpXG4gICAgICAgICAgaW5UaGlua2luZ0Jsb2NrID0gZmFsc2VcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gTm9uLXZlcmJvc2U6IGZsdXNoIGFjY3VtdWxhdGVkIGJ1ZmZlciBhcyB0cnVuY2F0ZWQgb25lLWxpbmVyXG4gICAgICBlbHNlIGlmICghb3B0aW9ucy52ZXJib3NlICYmIHRoaW5raW5nQnVmZmVyLnRyaW0oKSAmJlxuICAgICAgICAgIChldmVudFR5cGUgPT09ICd0b29sX2V4ZWN1dGlvbl9zdGFydCcgfHwgZXZlbnRUeXBlID09PSAnbWVzc2FnZV9lbmQnKSkge1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShmb3JtYXRUaGlua2luZ0xpbmUodGhpbmtpbmdCdWZmZXIpICsgJ1xcbicpXG4gICAgICAgIHRoaW5raW5nQnVmZmVyID0gJydcbiAgICAgIH1cblxuICAgICAgLy8gQ29tcHV0ZSB0b29sIGR1cmF0aW9uIGZvciB0b29sX2V4ZWN1dGlvbl9lbmRcbiAgICAgIGxldCB0b29sRHVyYXRpb246IG51bWJlciB8IHVuZGVmaW5lZFxuICAgICAgbGV0IGlzVG9vbEVycm9yID0gZmFsc2VcbiAgICAgIGlmIChldmVudFR5cGUgPT09ICd0b29sX2V4ZWN1dGlvbl9lbmQnKSB7XG4gICAgICAgIGNvbnN0IHRvb2xDYWxsSWQgPSBTdHJpbmcoZXZlbnRPYmoudG9vbENhbGxJZCA/PyBldmVudE9iai5pZCA/PyAnJylcbiAgICAgICAgY29uc3Qgc3RhcnRUaW1lID0gdG9vbFN0YXJ0VGltZXMuZ2V0KHRvb2xDYWxsSWQpXG4gICAgICAgIGlmIChzdGFydFRpbWUpIHtcbiAgICAgICAgICB0b29sRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gc3RhcnRUaW1lXG4gICAgICAgICAgdG9vbFN0YXJ0VGltZXMuZGVsZXRlKHRvb2xDYWxsSWQpXG4gICAgICAgIH1cbiAgICAgICAgaXNUb29sRXJyb3IgPSBldmVudE9iai5pc0Vycm9yID09PSB0cnVlIHx8IGV2ZW50T2JqLmVycm9yICE9IG51bGxcbiAgICAgIH1cblxuICAgICAgY29uc3QgY3R4OiBQcm9ncmVzc0NvbnRleHQgPSB7XG4gICAgICAgIHZlcmJvc2U6ICEhb3B0aW9ucy52ZXJib3NlLFxuICAgICAgICB0b29sRHVyYXRpb24sXG4gICAgICAgIGlzRXJyb3I6IGlzVG9vbEVycm9yLFxuICAgICAgICBsYXN0Q29zdDogZXZlbnRUeXBlID09PSAnYWdlbnRfZW5kJyA/IGxhc3RDb3N0RGF0YSA6IHVuZGVmaW5lZCxcbiAgICAgIH1cblxuICAgICAgY29uc3QgbGluZSA9IGZvcm1hdFByb2dyZXNzKGV2ZW50T2JqLCBjdHgpXG4gICAgICBpZiAobGluZSkgcHJvY2Vzcy5zdGRlcnIud3JpdGUobGluZSArICdcXG4nKVxuICAgIH1cblxuICAgIC8vIEhhbmRsZSBleGVjdXRpb25fY29tcGxldGUgKHYyIHN0cnVjdHVyZWQgY29tcGxldGlvbilcbiAgICAvLyBTa2lwIGZvciBtdWx0aS10dXJuIGNvbW1hbmRzIChhdXRvLCBuZXh0KSBcdTIwMTQgdGhlaXIgY29tcGxldGlvbiBpcyBkZXRlY3RlZCB2aWFcbiAgICAvLyBpc1Rlcm1pbmFsTm90aWZpY2F0aW9uKFwiQXV0by1tb2RlIHN0b3BwZWQuLi5cIi9cIlN0ZXAtbW9kZSBzdG9wcGVkLi4uXCIpLCBub3QgcGVyLXR1cm4gZXZlbnRzXG4gICAgaWYgKGV2ZW50T2JqLnR5cGUgPT09ICdleGVjdXRpb25fY29tcGxldGUnICYmICFjb21wbGV0ZWQgJiYgIWlzTXVsdGlUdXJuQ29tbWFuZCkge1xuICAgICAgY29tcGxldGVkID0gdHJ1ZVxuICAgICAgY29uc3Qgc3RhdHVzID0gU3RyaW5nKGV2ZW50T2JqLnN0YXR1cyA/PyAnc3VjY2VzcycpXG4gICAgICBleGl0Q29kZSA9IG1hcFN0YXR1c1RvRXhpdENvZGUoc3RhdHVzKVxuICAgICAgaWYgKGV2ZW50T2JqLnN0YXR1cyA9PT0gJ2Jsb2NrZWQnKSBibG9ja2VkID0gdHJ1ZVxuICAgICAgcmVzb2x2ZUNvbXBsZXRpb24oKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gSGFuZGxlIGV4dGVuc2lvbl91aV9yZXF1ZXN0XG4gICAgaWYgKGV2ZW50T2JqLnR5cGUgPT09ICdleHRlbnNpb25fdWlfcmVxdWVzdCcgJiYgY2xpZW50U3RhcnRlZCkge1xuICAgICAgLy8gQ2hlY2sgZm9yIHRlcm1pbmFsIG5vdGlmaWNhdGlvbiBiZWZvcmUgYXV0by1yZXNwb25kaW5nXG4gICAgICBpZiAoaXNCbG9ja2VkTm90aWZpY2F0aW9uKGV2ZW50T2JqKSkge1xuICAgICAgICBibG9ja2VkID0gdHJ1ZVxuICAgICAgfVxuXG4gICAgICAvLyBEZXRlY3QgXCJNaWxlc3RvbmUgWCByZWFkeS5cIiBmb3IgYXV0by1tb2RlIGNoYWluaW5nXG4gICAgICBpZiAoaXNNaWxlc3RvbmVSZWFkeU5vdGlmaWNhdGlvbihldmVudE9iaikpIHtcbiAgICAgICAgbWlsZXN0b25lUmVhZHkgPSB0cnVlXG4gICAgICB9XG5cbiAgICAgIGlmIChpc1Rlcm1pbmFsTm90aWZpY2F0aW9uKGV2ZW50T2JqKSkge1xuICAgICAgICBjb21wbGV0ZWQgPSB0cnVlXG4gICAgICB9XG5cbiAgICAgIC8vIEFuc3dlciBpbmplY3Rpb246IHRyeSB0byBoYW5kbGUgd2l0aCBwcmUtc3VwcGxpZWQgYW5zd2VycyBiZWZvcmUgc3VwZXJ2aXNlZC9hdXRvXG4gICAgICBpZiAoaW5qZWN0b3IgJiYgIUZJUkVfQU5EX0ZPUkdFVF9NRVRIT0RTLmhhcyhTdHJpbmcoZXZlbnRPYmoubWV0aG9kID8/ICcnKSkpIHtcbiAgICAgICAgaWYgKGluamVjdG9yLnRyeUhhbmRsZShldmVudE9iaiwgaW5qZWN0b3JTdGRpbkFkYXB0ZXIpKSB7XG4gICAgICAgICAgaWYgKGNvbXBsZXRlZCkge1xuICAgICAgICAgICAgZXhpdENvZGUgPSBibG9ja2VkID8gRVhJVF9CTE9DS0VEIDogRVhJVF9TVUNDRVNTXG4gICAgICAgICAgICByZXNvbHZlQ29tcGxldGlvbigpXG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVyblxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhldmVudE9iai5tZXRob2QgPz8gJycpXG4gICAgICBjb25zdCBzaG91bGRTdXBlcnZpc2UgPSBvcHRpb25zLnN1cGVydmlzZWQgJiYgIXN1cGVydmlzZWRGYWxsYmFja1xuICAgICAgICAmJiAhRklSRV9BTkRfRk9SR0VUX01FVEhPRFMuaGFzKG1ldGhvZClcblxuICAgICAgaWYgKHNob3VsZFN1cGVydmlzZSkge1xuICAgICAgICAvLyBJbnRlcmFjdGl2ZSByZXF1ZXN0IGluIHN1cGVydmlzZWQgbW9kZSBcdTIwMTQgbGV0IG9yY2hlc3RyYXRvciByZXNwb25kXG4gICAgICAgIGNvbnN0IGV2ZW50SWQgPSBTdHJpbmcoZXZlbnRPYmouaWQgPz8gJycpXG4gICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgcGVuZGluZ1Jlc3BvbnNlVGltZXJzLmRlbGV0ZShldmVudElkKVxuICAgICAgICAgIGhhbmRsZUV4dGVuc2lvblVJUmVxdWVzdChldmVudE9iaiBhcyB1bmtub3duIGFzIEV4dGVuc2lvblVJUmVxdWVzdCwgY2xpZW50KVxuICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKEpTT04uc3RyaW5naWZ5KHsgdHlwZTogJ3N1cGVydmlzZWRfdGltZW91dCcsIGlkOiBldmVudElkLCBtZXRob2QgfSkgKyAnXFxuJylcbiAgICAgICAgfSwgcmVzcG9uc2VUaW1lb3V0KVxuICAgICAgICBwZW5kaW5nUmVzcG9uc2VUaW1lcnMuc2V0KGV2ZW50SWQsIHRpbWVyKVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaGFuZGxlRXh0ZW5zaW9uVUlSZXF1ZXN0KGV2ZW50T2JqIGFzIHVua25vd24gYXMgRXh0ZW5zaW9uVUlSZXF1ZXN0LCBjbGllbnQpXG4gICAgICB9XG5cbiAgICAgIC8vIElmIHdlIGRldGVjdGVkIGEgdGVybWluYWwgbm90aWZpY2F0aW9uLCByZXNvbHZlIGFmdGVyIHJlc3BvbmRpbmdcbiAgICAgIGlmIChjb21wbGV0ZWQpIHtcbiAgICAgICAgZXhpdENvZGUgPSBibG9ja2VkID8gRVhJVF9CTE9DS0VEIDogRVhJVF9TVUNDRVNTXG4gICAgICAgIHJlc29sdmVDb21wbGV0aW9uKClcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUXVpY2sgY29tbWFuZHM6IHJlc29sdmUgb24gZmlyc3QgYWdlbnRfZW5kXG4gICAgaWYgKGV2ZW50T2JqLnR5cGUgPT09ICdhZ2VudF9lbmQnICYmIGlzUXVpY2tDb21tYW5kKG9wdGlvbnMuY29tbWFuZCwgb3B0aW9ucy5jb21tYW5kQXJncykgJiYgIWNvbXBsZXRlZCkge1xuICAgICAgY29tcGxldGVkID0gdHJ1ZVxuICAgICAgcmVzb2x2ZUNvbXBsZXRpb24oKVxuICAgICAgcmV0dXJuXG4gICAgfVxuXG4gICAgLy8gTG9uZy1ydW5uaW5nIGNvbW1hbmRzOiBhZ2VudF9lbmQgYWZ0ZXIgdG9vbCBleGVjdXRpb24gXHUyMDE0IHBvc3NpYmxlIGNvbXBsZXRpb25cbiAgICAvLyBUaGUgaWRsZSB0aW1lciArIHRlcm1pbmFsIG5vdGlmaWNhdGlvbiBoYW5kbGUgdGhpcyBjYXNlLlxuICB9KVxuXG4gIC8vIFNpZ25hbCBoYW5kbGluZ1xuICBjb25zdCBzaWduYWxIYW5kbGVyID0gKCkgPT4ge1xuICAgIC8vIFVzZSB3cml0ZVN5bmMgb24gZmQgMiB0byBndWFyYW50ZWUgdGhlIEludGVycnVwdGVkIG1hcmtlciByZWFjaGVzXG4gICAgLy8gY29uc3VtZXJzIGJlZm9yZSBwcm9jZXNzLmV4aXQoKSB0cnVuY2F0ZXMgcGVuZGluZyBhc3luYyB3cml0ZXMuXG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlU3luYygyLCAnXFxuW2hlYWRsZXNzXSBJbnRlcnJ1cHRlZCwgc3RvcHBpbmcgY2hpbGQgcHJvY2Vzcy4uLlxcbicpXG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBGYWxsYmFjayB0byBhc3luYyB3cml0ZSBpZiBmZCAyIGlzIHNvbWVob3cgdW5hdmFpbGFibGUuXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnXFxuW2hlYWRsZXNzXSBJbnRlcnJ1cHRlZCwgc3RvcHBpbmcgY2hpbGQgcHJvY2Vzcy4uLlxcbicpXG4gICAgfVxuICAgIGludGVycnVwdGVkID0gdHJ1ZVxuICAgIGV4aXRDb2RlID0gRVhJVF9DQU5DRUxMRURcbiAgICAvLyBLaWxsIGNoaWxkIHByb2Nlc3MgXHUyMDE0IGRvbid0IGF3YWl0LCBqdXN0IGZpcmUgYW5kIGV4aXQuXG4gICAgLy8gVGhlIG1haW4gZmxvdyBtYXkgYmUgYXdhaXRpbmcgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiB0aGUgY2hpbGQgZGllcyxcbiAgICAvLyB3aGljaCB3b3VsZCByYWNlIHdpdGggdGhpcyBoYW5kbGVyLiBFeGl0IHN5bmNocm9ub3VzbHkgdG8gZW5zdXJlIGNvcnJlY3QgZXhpdCBjb2RlLlxuICAgIHZvaWQgY2xpZW50LnN0b3AoKS5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBbaGVhZGxlc3NdIFdhcm5pbmc6IGZhaWxlZCB0byBzdG9wIGNoaWxkIHByb2Nlc3M6ICR7ZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpfVxcbmApXG4gICAgfSlcbiAgICBpZiAodGltZW91dFRpbWVyKSBjbGVhclRpbWVvdXQodGltZW91dFRpbWVyKVxuICAgIGlmIChpZGxlVGltZXIpIGNsZWFyVGltZW91dChpZGxlVGltZXIpXG4gICAgLy8gRW1pdCBiYXRjaCBKU09OIHJlc3VsdCBpZiBpbiBqc29uIG1vZGUgYmVmb3JlIGV4aXRpbmdcbiAgICBpZiAob3B0aW9ucy5vdXRwdXRGb3JtYXQgPT09ICdqc29uJykge1xuICAgICAgZW1pdEJhdGNoSnNvblJlc3VsdCgpXG4gICAgfVxuICAgIHByb2Nlc3MuZXhpdChleGl0Q29kZSlcbiAgfVxuICAvLyBVc2UgcHJlcGVuZExpc3RlbmVyIHNvIG91ciBoYW5kbGVyIHJ1bnMgYmVmb3JlIHBpLWNvZGluZy1hZ2VudCdzXG4gIC8vIExTUC1jbGllbnQgbW9kdWxlLWxvYWQgU0lHSU5UIGhhbmRsZXIsIHdoaWNoIGNhbGxzIHByb2Nlc3MuZXhpdCgwKVxuICAvLyBhbmQgd291bGQgb3RoZXJ3aXNlIHNob3J0LWNpcmN1aXQgb3VyIGV4aXQtY29kZS0xMSBjb250cmFjdC5cbiAgcHJvY2Vzcy5wcmVwZW5kTGlzdGVuZXIoJ1NJR0lOVCcsIHNpZ25hbEhhbmRsZXIpXG4gIHByb2Nlc3MucHJlcGVuZExpc3RlbmVyKCdTSUdURVJNJywgc2lnbmFsSGFuZGxlcilcbiAgLy8gRW1pdCBhIGRldGVybWluaXN0aWMgcmVhZGluZXNzIG1hcmtlciBzbyB0ZXN0IGhhcm5lc3NlcyBjYW4gd2FpdCBmb3JcbiAgLy8gdGhlIFNJR0lOVCBoYW5kbGVyIHRvIGJlIGxpdmUgYmVmb3JlIHNlbmRpbmcgYSBzaWduYWwuIHdyaXRlU3luYyBvblxuICAvLyBmZCAyIGF2b2lkcyBhbnkgcGlwZS1idWZmZXJpbmcgcmFjZSBiZXR3ZWVuIHRoZSBtYXJrZXIgYW5kIHN1YnNlcXVlbnRcbiAgLy8gc2lnbmFsIGRlbGl2ZXJ5LlxuICB0cnkge1xuICAgIHdyaXRlU3luYygyLCAnW2hlYWRsZXNzXSBzaWduYWwtaGFuZGxlcnMtcmVhZHlcXG4nKVxuICB9IGNhdGNoIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnW2hlYWRsZXNzXSBzaWduYWwtaGFuZGxlcnMtcmVhZHlcXG4nKVxuICB9XG5cbiAgLy8gU3RhcnQgdGhlIFJQQyBzZXNzaW9uXG4gIHRyeSB7XG4gICAgYXdhaXQgY2xpZW50LnN0YXJ0KClcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gRXJyb3I6IEZhaWxlZCB0byBzdGFydCBSUEMgc2Vzc2lvbjogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9XFxuYClcbiAgICBpZiAodGltZW91dFRpbWVyKSBjbGVhclRpbWVvdXQodGltZW91dFRpbWVyKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgLy8gdjIgcHJvdG9jb2wgbmVnb3RpYXRpb24gXHUyMDE0IGF0dGVtcHQgaW5pdCBmb3Igc3RydWN0dXJlZCBjb21wbGV0aW9uIGV2ZW50c1xuICBsZXQgdjJFbmFibGVkID0gZmFsc2VcbiAgdHJ5IHtcbiAgICBhd2FpdCBjbGllbnQuaW5pdCh7IGNsaWVudElkOiAnZ3NkLWhlYWRsZXNzJyB9KVxuICAgIHYyRW5hYmxlZCA9IHRydWVcbiAgfSBjYXRjaCB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoJ1toZWFkbGVzc10gV2FybmluZzogdjIgaW5pdCBmYWlsZWQsIGZhbGxpbmcgYmFjayB0byB2MSBzdHJpbmctbWF0Y2hpbmdcXG4nKVxuICB9XG5cbiAgY2xpZW50U3RhcnRlZCA9IHRydWVcblxuICAvLyAtLXJlc3VtZTogcmVzb2x2ZSBzZXNzaW9uIElEIGFuZCBzd2l0Y2ggdG8gaXRcbiAgaWYgKG9wdGlvbnMucmVzdW1lU2Vzc2lvbikge1xuICAgIGNvbnN0IHByb2plY3RTZXNzaW9uc0RpciA9IGdldFByb2plY3RTZXNzaW9uc0Rpcihwcm9jZXNzLmN3ZCgpKVxuICAgIGNvbnN0IHNlc3Npb25zID0gYXdhaXQgU2Vzc2lvbk1hbmFnZXIubGlzdChwcm9jZXNzLmN3ZCgpLCBwcm9qZWN0U2Vzc2lvbnNEaXIpXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzb2x2ZVJlc3VtZVNlc3Npb24oc2Vzc2lvbnMsIG9wdGlvbnMucmVzdW1lU2Vzc2lvbilcbiAgICBpZiAocmVzdWx0LmVycm9yKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2hlYWRsZXNzXSBFcnJvcjogJHtyZXN1bHQuZXJyb3J9XFxuYClcbiAgICAgIGF3YWl0IGNsaWVudC5zdG9wKClcbiAgICAgIGlmICh0aW1lb3V0VGltZXIpIGNsZWFyVGltZW91dCh0aW1lb3V0VGltZXIpXG4gICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICB9XG4gICAgY29uc3QgbWF0Y2hlZCA9IHJlc3VsdC5zZXNzaW9uIVxuICAgIGNvbnN0IHN3aXRjaFJlc3VsdCA9IGF3YWl0IGNsaWVudC5zd2l0Y2hTZXNzaW9uKG1hdGNoZWQucGF0aClcbiAgICBpZiAoc3dpdGNoUmVzdWx0LmNhbmNlbGxlZCkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gRXJyb3I6IFNlc3Npb24gc3dpdGNoIHRvICcke21hdGNoZWQuaWR9JyB3YXMgY2FuY2VsbGVkIGJ5IGFuIGV4dGVuc2lvblxcbmApXG4gICAgICBhd2FpdCBjbGllbnQuc3RvcCgpXG4gICAgICBpZiAodGltZW91dFRpbWVyKSBjbGVhclRpbWVvdXQodGltZW91dFRpbWVyKVxuICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgfVxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBbaGVhZGxlc3NdIFJlc3VtaW5nIHNlc3Npb24gJHttYXRjaGVkLmlkfVxcbmApXG4gIH1cblxuICAvLyBCdWlsZCBpbmplY3RvciBhZGFwdGVyIFx1MjAxNCB3cmFwcyBjbGllbnQuc2VuZFVJUmVzcG9uc2UgZm9yIEFuc3dlckluamVjdG9yJ3Mgd3JpdGVUb1N0ZGluIGludGVyZmFjZVxuICBpbmplY3RvclN0ZGluQWRhcHRlciA9IChkYXRhOiBzdHJpbmcpID0+IHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShkYXRhLnRyaW0oKSlcbiAgICAgIGlmIChwYXJzZWQudHlwZSA9PT0gJ2V4dGVuc2lvbl91aV9yZXNwb25zZScgJiYgcGFyc2VkLmlkKSB7XG4gICAgICAgIGNvbnN0IHsgaWQsIHZhbHVlLCB2YWx1ZXMsIGNvbmZpcm1lZCwgY2FuY2VsbGVkIH0gPSBwYXJzZWRcbiAgICAgICAgY2xpZW50LnNlbmRVSVJlc3BvbnNlKGlkLCB7IHZhbHVlLCB2YWx1ZXMsIGNvbmZpcm1lZCwgY2FuY2VsbGVkIH0pXG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnW2hlYWRsZXNzXSBXYXJuaW5nOiBpbmplY3RvciBhZGFwdGVyIHJlY2VpdmVkIHVucGFyc2VhYmxlIGRhdGFcXG4nKVxuICAgIH1cbiAgfVxuXG4gIC8vIFN0YXJ0IHN1cGVydmlzZWQgc3RkaW4gcmVhZGVyIGZvciBvcmNoZXN0cmF0b3IgY29tbWFuZHNcbiAgaWYgKG9wdGlvbnMuc3VwZXJ2aXNlZCkge1xuICAgIHN0b3BTdXBlcnZpc2VkUmVhZGVyID0gc3RhcnRTdXBlcnZpc2VkU3RkaW5SZWFkZXIoY2xpZW50LCAoaWQpID0+IHtcbiAgICAgIGNvbnN0IHRpbWVyID0gcGVuZGluZ1Jlc3BvbnNlVGltZXJzLmdldChpZClcbiAgICAgIGlmICh0aW1lcikge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpXG4gICAgICAgIHBlbmRpbmdSZXNwb25zZVRpbWVycy5kZWxldGUoaWQpXG4gICAgICB9XG4gICAgfSlcbiAgICAvLyBFbnN1cmUgc3RkaW4gaXMgaW4gZmxvd2luZyBtb2RlIGZvciBKU09OTCByZWFkaW5nXG4gICAgcHJvY2Vzcy5zdGRpbi5yZXN1bWUoKVxuICB9XG5cbiAgLy8gRGV0ZWN0IGNoaWxkIHByb2Nlc3MgY3Jhc2ggKHJlYWQtb25seSBleGl0IGV2ZW50IHN1YnNjcmlwdGlvbiBcdTIwMTQgbm90IHN0ZGluIGFjY2VzcylcbiAgY29uc3QgaW50ZXJuYWxQcm9jZXNzID0gUmVmbGVjdC5nZXQoY2xpZW50IGFzIG9iamVjdCwgJ3Byb2Nlc3MnKSBhcyBDaGlsZFByb2Nlc3MgfCB1bmRlZmluZWRcbiAgaWYgKGludGVybmFsUHJvY2Vzcykge1xuICAgIGludGVybmFsUHJvY2Vzcy5vbignZXhpdCcsIChjb2RlOiBudW1iZXIgfCBudWxsKSA9PiB7XG4gICAgICBpZiAoIWNvbXBsZXRlZCkge1xuICAgICAgICBjb25zdCBtc2cgPSBgW2hlYWRsZXNzXSBDaGlsZCBwcm9jZXNzIGV4aXRlZCB1bmV4cGVjdGVkbHkgd2l0aCBjb2RlICR7Y29kZSA/PyAnbnVsbCd9XFxuYFxuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShtc2cpXG4gICAgICAgIGV4aXRDb2RlID0gRVhJVF9FUlJPUlxuICAgICAgICByZXNvbHZlQ29tcGxldGlvbigpXG4gICAgICB9XG4gICAgfSlcbiAgfVxuXG4gIGlmICghb3B0aW9ucy5qc29uKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gUnVubmluZyAvZ3NkICR7b3B0aW9ucy5jb21tYW5kfSR7b3B0aW9ucy5jb21tYW5kQXJncy5sZW5ndGggPiAwID8gJyAnICsgb3B0aW9ucy5jb21tYW5kQXJncy5qb2luKCcgJykgOiAnJ30uLi5cXG5gKVxuICB9XG5cbiAgLy8gU2VuZCB0aGUgY29tbWFuZFxuICBjb25zdCBjb21tYW5kID0gYC9nc2QgJHtvcHRpb25zLmNvbW1hbmR9JHtvcHRpb25zLmNvbW1hbmRBcmdzLmxlbmd0aCA+IDAgPyAnICcgKyBvcHRpb25zLmNvbW1hbmRBcmdzLmpvaW4oJyAnKSA6ICcnfWBcbiAgdHJ5IHtcbiAgICBhd2FpdCBjbGllbnQucHJvbXB0KGNvbW1hbmQpXG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBbaGVhZGxlc3NdIEVycm9yOiBGYWlsZWQgdG8gc2VuZCBwcm9tcHQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfVxcbmApXG4gICAgZXhpdENvZGUgPSBFWElUX0VSUk9SXG4gIH1cblxuICAvLyBXYWl0IGZvciBjb21wbGV0aW9uXG4gIGlmIChleGl0Q29kZSA9PT0gRVhJVF9TVUNDRVNTIHx8IGV4aXRDb2RlID09PSBFWElUX0JMT0NLRUQpIHtcbiAgICBhd2FpdCBjb21wbGV0aW9uUHJvbWlzZVxuICB9XG5cbiAgLy8gQXV0by1tb2RlIGNoYWluaW5nOiBpZiAtLWF1dG8gYW5kIG1pbGVzdG9uZSBjcmVhdGlvbiBzdWNjZWVkZWQsIHNlbmQgL2dzZCBhdXRvXG4gIGlmIChpc05ld01pbGVzdG9uZSAmJiBvcHRpb25zLmF1dG8gJiYgbWlsZXN0b25lUmVhZHkgJiYgIWJsb2NrZWQgJiYgZXhpdENvZGUgPT09IEVYSVRfU1VDQ0VTUykge1xuICAgIGlmICghb3B0aW9ucy5qc29uKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZSgnW2hlYWRsZXNzXSBNaWxlc3RvbmUgcmVhZHkgXHUyMDE0IGNoYWluaW5nIGludG8gYXV0by1tb2RlLi4uXFxuJylcbiAgICB9XG5cbiAgICAvLyBSZXNldCBjb21wbGV0aW9uIHN0YXRlIGZvciB0aGUgYXV0by1tb2RlIHBoYXNlLlxuICAgIC8vIERpc2FibGUgdGhlIG92ZXJhbGwgdGltZW91dCBcdTIwMTQgYXV0by1tb2RlIGhhcyBpdHMgb3duIGludGVybmFsIHN1cGVydmlzb3IuXG4gICAgaWYgKHRpbWVvdXRUaW1lcikgY2xlYXJUaW1lb3V0KHRpbWVvdXRUaW1lcilcbiAgICBjb21wbGV0ZWQgPSBmYWxzZVxuICAgIG1pbGVzdG9uZVJlYWR5ID0gZmFsc2VcbiAgICBibG9ja2VkID0gZmFsc2VcbiAgICBjb25zdCBhdXRvQ29tcGxldGlvblByb21pc2UgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgcmVzb2x2ZUNvbXBsZXRpb24gPSByZXNvbHZlXG4gICAgfSlcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBjbGllbnQucHJvbXB0KCcvZ3NkIGF1dG8nKVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gRXJyb3I6IEZhaWxlZCB0byBzdGFydCBhdXRvLW1vZGU6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfVxcbmApXG4gICAgICBleGl0Q29kZSA9IEVYSVRfRVJST1JcbiAgICB9XG5cbiAgICBpZiAoZXhpdENvZGUgPT09IEVYSVRfU1VDQ0VTUyB8fCBleGl0Q29kZSA9PT0gRVhJVF9CTE9DS0VEKSB7XG4gICAgICBhd2FpdCBhdXRvQ29tcGxldGlvblByb21pc2VcbiAgICB9XG4gIH1cblxuICAvLyBDbGVhbnVwXG4gIGlmICh0aW1lb3V0VGltZXIpIGNsZWFyVGltZW91dCh0aW1lb3V0VGltZXIpXG4gIGlmIChpZGxlVGltZXIpIGNsZWFyVGltZW91dChpZGxlVGltZXIpXG4gIHBlbmRpbmdSZXNwb25zZVRpbWVycy5mb3JFYWNoKCh0aW1lcikgPT4gY2xlYXJUaW1lb3V0KHRpbWVyKSlcbiAgcGVuZGluZ1Jlc3BvbnNlVGltZXJzLmNsZWFyKClcbiAgc3RvcFN1cGVydmlzZWRSZWFkZXI/LigpXG4gIHByb2Nlc3Muc3RkaW4ucmVtb3ZlTGlzdGVuZXIoJ2Nsb3NlJywgb25TdGRpbkNsb3NlKVxuICBwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKCdTSUdJTlQnLCBzaWduYWxIYW5kbGVyKVxuICBwcm9jZXNzLnJlbW92ZUxpc3RlbmVyKCdTSUdURVJNJywgc2lnbmFsSGFuZGxlcilcblxuICBhd2FpdCBjbGllbnQuc3RvcCgpXG5cbiAgLy8gU3VtbWFyeVxuICBjb25zdCBkdXJhdGlvbiA9ICgoRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSkgLyAxMDAwKS50b0ZpeGVkKDEpXG4gIGNvbnN0IHN0YXR1cyA9IGJsb2NrZWQgPyAnYmxvY2tlZCcgOiBleGl0Q29kZSA9PT0gRVhJVF9DQU5DRUxMRUQgPyAnY2FuY2VsbGVkJyA6IGV4aXRDb2RlID09PSBFWElUX0VSUk9SID8gKHRvdGFsRXZlbnRzID09PSAwID8gJ2Vycm9yJyA6ICd0aW1lb3V0JykgOiAnY29tcGxldGUnXG5cbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gU3RhdHVzOiAke3N0YXR1c31cXG5gKVxuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2hlYWRsZXNzXSBEdXJhdGlvbjogJHtkdXJhdGlvbn1zXFxuYClcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYFtoZWFkbGVzc10gRXZlbnRzOiAke3RvdGFsRXZlbnRzfSB0b3RhbCwgJHt0b29sQ2FsbENvdW50fSB0b29sIGNhbGxzXFxuYClcbiAgaWYgKG9wdGlvbnMuZXZlbnRGaWx0ZXIpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2hlYWRsZXNzXSBFdmVudCBmaWx0ZXI6ICR7Wy4uLm9wdGlvbnMuZXZlbnRGaWx0ZXJdLmpvaW4oJywgJyl9XFxuYClcbiAgfVxuICBpZiAocmVzdGFydENvdW50ID4gMCkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBbaGVhZGxlc3NdIFJlc3RhcnRzOiAke3Jlc3RhcnRDb3VudH1cXG5gKVxuICB9XG5cbiAgLy8gQW5zd2VyIGluamVjdGlvbiBzdGF0c1xuICBpZiAoaW5qZWN0b3IpIHtcbiAgICBjb25zdCBzdGF0cyA9IGluamVjdG9yLmdldFN0YXRzKClcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgW2hlYWRsZXNzXSBBbnN3ZXJzOiAke3N0YXRzLnF1ZXN0aW9uc0Fuc3dlcmVkfSBhbnN3ZXJlZCwgJHtzdGF0cy5xdWVzdGlvbnNEZWZhdWx0ZWR9IGRlZmF1bHRlZCwgJHtzdGF0cy5zZWNyZXRzUHJvdmlkZWR9IHNlY3JldHNcXG5gKVxuICAgIGZvciAoY29uc3Qgd2FybmluZyBvZiBpbmplY3Rvci5nZXRVbnVzZWRXYXJuaW5ncygpKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgJHt3YXJuaW5nfVxcbmApXG4gICAgfVxuICB9XG5cbiAgLy8gT24gZmFpbHVyZSwgcHJpbnQgbGFzdCA1IGV2ZW50cyBmb3IgZGlhZ25vc3RpY3NcbiAgaWYgKGV4aXRDb2RlICE9PSAwKSB7XG4gICAgY29uc3QgbGFzdEZpdmUgPSByZWNlbnRFdmVudHMuc2xpY2UoLTUpXG4gICAgaWYgKGxhc3RGaXZlLmxlbmd0aCA+IDApIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdbaGVhZGxlc3NdIExhc3QgZXZlbnRzOlxcbicpXG4gICAgICBmb3IgKGNvbnN0IGUgb2YgbGFzdEZpdmUpIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCAgJHtlLnR5cGV9JHtlLmRldGFpbCA/IGA6ICR7ZS5kZXRhaWx9YCA6ICcnfVxcbmApXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gRW1pdCBzdHJ1Y3R1cmVkIEpTT04gcmVzdWx0IGluIGJhdGNoIG1vZGVcbiAgZW1pdEJhdGNoSnNvblJlc3VsdCgpXG5cbiAgcmV0dXJuIHsgZXhpdENvZGUsIGludGVycnVwdGVkIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWNBLFNBQVMsWUFBWSxXQUFXLGVBQWUsaUJBQWlCO0FBQ2hFLFNBQVMsWUFBWTtBQUNyQixTQUFTLGVBQWU7QUFHeEIsU0FBUyxXQUFXLHNCQUFzQjtBQUUxQyxTQUFTLDZCQUE2QjtBQUN0QyxTQUFTLDJCQUEyQixzQkFBc0I7QUFFMUQ7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFHUCxTQUFTLDRCQUE0QjtBQUVyQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtB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U0FBUyxrQkFBa0IsR0FBRztBQUNsRCxjQUFRLE9BQU8sTUFBTSxHQUFHLE9BQU87QUFBQSxDQUFJO0FBQUEsSUFDckM7QUFBQSxFQUNGO0FBR0EsTUFBSSxhQUFhLEdBQUc7QUFDbEIsVUFBTSxXQUFXLGFBQWEsTUFBTSxFQUFFO0FBQ3RDLFFBQUksU0FBUyxTQUFTLEdBQUc7QUFDdkIsY0FBUSxPQUFPLE1BQU0sMkJBQTJCO0FBQ2hELGlCQUFXLEtBQUssVUFBVTtBQUN4QixnQkFBUSxPQUFPLE1BQU0sS0FBSyxFQUFFLElBQUksR0FBRyxFQUFFLFNBQVMsS0FBSyxFQUFFLE1BQU0sS0FBSyxFQUFFO0FBQUEsQ0FBSTtBQUFBLE1BQ3hFO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFHQSxzQkFBb0I7QUFFcEIsU0FBTyxFQUFFLFVBQVUsWUFBWTtBQUNqQzsiLAogICJuYW1lcyI6IFsicmVzb2x2ZSIsICJnc2REaXIiLCAiZXhpdENvZGUiLCAiZHVyYXRpb24iLCAic3RhdHVzIiwgImV2ZW50VHlwZSIsICJzdGFydFRpbWUiXQp9Cg==
