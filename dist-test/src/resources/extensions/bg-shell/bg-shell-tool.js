import { StringEnum } from "@gsd/pi-ai";
import { Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { DEFAULT_READY_TIMEOUT } from "./types.js";
import {
  processes,
  startProcess,
  killProcess,
  restartProcess,
  getInfo,
  getGroupStatus,
  persistManifest
} from "./process-manager.js";
import {
  generateDigest,
  getHighlights,
  getOutput,
  formatDigestText
} from "./output-formatter.js";
import { waitForReady } from "./readiness-detector.js";
import { queryShellEnv, sendAndWait, runOnSession } from "./interaction.js";
import { toPosixPath } from "../shared/path-display.js";
function registerBgShellTool(pi, state) {
  pi.registerTool({
    name: "bg_shell",
    label: "Background Shell",
    description: "Run shell commands in the background without blocking. Manages persistent background processes with intelligent lifecycle tracking. Actions: start (launch with auto-classification & readiness detection), digest (structured summary ~30 tokens vs ~2000 raw), output (raw lines with incremental delivery), wait_for_ready (block until process signals readiness), send (write stdin), send_and_wait (expect-style: send + wait for output pattern), run (execute a command on a persistent shell session, block until done, return output + exit code), env (query shell cwd and environment variables), signal (send OS signal), list (all processes with status), kill (terminate), restart (kill + relaunch), group_status (health of a process group), highlights (significant output lines only).",
    promptGuidelines: [
      "Use bg_shell to start long-running processes (servers, watchers, builds) that should not block the agent.",
      "After starting a server, use 'wait_for_ready' to efficiently block until it's listening \u2014 avoids polling loops entirely.",
      "Use 'digest' instead of 'output' when you just need status \u2014 it returns a structured ~30-token summary instead of ~2000 tokens of raw output.",
      "Use 'highlights' to see only significant output (errors, URLs, results) \u2014 typically 5-15 lines instead of hundreds.",
      "Use 'output' only when you need raw lines for debugging \u2014 add filter:'error|warning' to narrow results.",
      "The 'output' action returns only new output since the last check (incremental). Repeated calls are cheap on context.",
      "Set type:'server' and ready_port:3000 for dev servers so readiness detection is automatic.",
      "Set group:'my-stack' on related processes to manage them together with 'group_status'.",
      "Use 'run' to execute a command on a persistent shell session and block until it completes \u2014 returns structured output + exit code. Shell state (env vars, cwd, virtualenvs) persists across runs.",
      "Use 'send_and_wait' for interactive CLIs: send input and wait for expected output pattern.",
      "Use 'env' to check the current working directory and active environment variables of a shell session \u2014 useful after cd, source, or export commands.",
      "Background processes are session-scoped by default: a new session reaps them unless you set persist_across_sessions:true.",
      "Use 'restart' to kill and relaunch with the same config \u2014 preserves restart count.",
      "Background processes are auto-classified (server/build/test/watcher) based on the command.",
      "Process crashes and errors are automatically surfaced as alerts at the start of your next turn \u2014 you don't need to poll.",
      "To create a persistent shell session: bg_shell start with type:'shell'. The session stays alive for interactive use with 'send', 'send_and_wait', or 'run'."
    ],
    parameters: Type.Object({
      action: StringEnum([
        "start",
        "digest",
        "output",
        "highlights",
        "wait_for_ready",
        "send",
        "send_and_wait",
        "run",
        "env",
        "signal",
        "list",
        "kill",
        "restart",
        "group_status"
      ]),
      command: Type.Optional(
        Type.String({ description: "Shell command to run (for start, run)" })
      ),
      label: Type.Optional(
        Type.String({ description: "Short human-readable label for the process (for start)" })
      ),
      id: Type.Optional(
        Type.String({ description: "Process ID (for digest, output, highlights, wait_for_ready, send, send_and_wait, run, signal, kill, restart)" })
      ),
      stream: Type.Optional(
        StringEnum(["stdout", "stderr", "both"])
      ),
      tail: Type.Optional(
        Type.Number({ description: "Number of most recent lines to return (for output). Defaults to 100." })
      ),
      filter: Type.Optional(
        Type.String({ description: "Regex pattern to filter output lines (for output). Case-insensitive." })
      ),
      input: Type.Optional(
        Type.String({ description: "Text to write to process stdin (for send, send_and_wait)" })
      ),
      wait_pattern: Type.Optional(
        Type.String({ description: "Regex to wait for in output (for send_and_wait)" })
      ),
      signal_name: Type.Optional(
        Type.String({ description: "OS signal to send, e.g. SIGINT, SIGTERM, SIGHUP (for signal)" })
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in milliseconds (for wait_for_ready, send_and_wait, run). Default: 30000 for wait_for_ready/send_and_wait, 120000 for run" })
      ),
      type: Type.Optional(
        StringEnum(["server", "build", "test", "watcher", "generic", "shell"])
      ),
      ready_pattern: Type.Optional(
        Type.String({ description: "Regex pattern that indicates the process is ready (for start)" })
      ),
      ready_port: Type.Optional(
        Type.Number({ description: "Port to probe for readiness (for start). When open, process is considered ready." })
      ),
      ready_timeout: Type.Optional(
        Type.Number({ description: "Max milliseconds to wait for ready_port/ready_pattern before marking as error (default: 30000)" })
      ),
      group: Type.Optional(
        Type.String({ description: "Group name for related processes (for start, group_status)" })
      ),
      persist_across_sessions: Type.Optional(
        Type.Boolean({
          description: "Keep this process running after a new session starts. Default: false.",
          default: false
        })
      )
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      state.latestCtx = ctx;
      switch (params.action) {
        // ── start ──────────────────────────────────────────
        case "start": {
          if (!params.command) {
            return {
              content: [{ type: "text", text: "Error: 'command' is required for start" }],
              isError: true,
              details: void 0
            };
          }
          const bg = startProcess({
            command: params.command,
            cwd: ctx.cwd,
            ownerSessionFile: ctx.sessionManager.getSessionFile() ?? null,
            persistAcrossSessions: params.persist_across_sessions ?? false,
            label: params.label,
            type: params.type,
            readyPattern: params.ready_pattern,
            readyPort: params.ready_port,
            readyTimeout: params.ready_timeout,
            group: params.group
          });
          await new Promise((r) => setTimeout(r, 500));
          persistManifest(ctx.cwd);
          const info = getInfo(bg);
          let text = `Started background process ${bg.id}
`;
          text += `  label: ${bg.label}
`;
          text += `  type: ${bg.processType}
`;
          text += `  status: ${bg.status}
`;
          text += `  command: ${bg.command}
`;
          text += `  cwd: ${toPosixPath(bg.cwd)}`;
          if (bg.group) text += `
  group: ${bg.group}`;
          if (bg.persistAcrossSessions) text += `
  persist_across_sessions: true`;
          if (bg.readyPort) text += `
  ready_port: ${bg.readyPort}`;
          if (bg.readyPattern) text += `
  ready_pattern: ${bg.readyPattern}`;
          if (bg.ports.length > 0) text += `
  detected ports: ${bg.ports.join(", ")}`;
          if (bg.urls.length > 0) text += `
  detected urls: ${bg.urls.join(", ")}`;
          if (!bg.alive) {
            text += `
  exit code: ${bg.exitCode}`;
            const errLines = bg.output.filter((l) => l.stream === "stderr").map((l) => l.line);
            const errOut = errLines.join("\n").trim();
            if (errOut) text += `
  stderr:
${errOut}`;
          }
          return {
            content: [{ type: "text", text }],
            details: { action: "start", process: info }
          };
        }
        // ── digest ─────────────────────────────────────────
        case "digest": {
          if (params.id) {
            const bg = processes.get(params.id);
            if (!bg) {
              return {
                content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
                isError: true,
                details: void 0
              };
            }
            const digest = generateDigest(bg, true);
            return {
              content: [{ type: "text", text: formatDigestText(bg, digest) }],
              details: { action: "digest", process: getInfo(bg), digest }
            };
          }
          const all = Array.from(processes.values());
          if (all.length === 0) {
            return {
              content: [{ type: "text", text: "No background processes." }],
              details: { action: "digest", processes: [] }
            };
          }
          const lines = all.map((bg) => {
            const d = generateDigest(bg, true);
            const status = bg.alive ? bg.status === "ready" ? "\u2713" : bg.status === "error" ? "\u2717" : "\u22EF" : "\u25CB";
            const portInfo = d.ports.length > 0 ? ` :${d.ports.join(",")}` : "";
            const errInfo = d.errors.length > 0 ? ` (${d.errors.length} errors)` : "";
            return `${status} ${bg.id} ${bg.label} [${bg.processType}] ${d.uptime}${portInfo}${errInfo} \u2014 ${d.changeSummary}`;
          });
          return {
            content: [{ type: "text", text: `Background processes (${all.length}):
${lines.join("\n")}` }],
            details: { action: "digest", count: all.length }
          };
        }
        // ── highlights ──────────────────────────────────────
        case "highlights": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for highlights" }],
              isError: true,
              details: void 0
            };
          }
          const bg = processes.get(params.id);
          if (!bg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          const highlights = getHighlights(bg, params.tail || 15);
          const info = getInfo(bg);
          let text = `Highlights for ${bg.id} (${bg.label}) \u2014 ${bg.status}:
`;
          if (highlights.length === 0) {
            text += "(no significant output)";
          } else {
            text += highlights.join("\n");
          }
          return {
            content: [{ type: "text", text }],
            details: { action: "highlights", process: info, lineCount: highlights.length }
          };
        }
        // ── output ─────────────────────────────────────────
        case "output": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for output" }],
              isError: true,
              details: void 0
            };
          }
          const bg = processes.get(params.id);
          if (!bg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          const stream = params.stream || "both";
          const tail = params.tail ?? 100;
          const output = getOutput(bg, {
            stream,
            tail,
            filter: params.filter,
            incremental: true
          });
          const info = getInfo(bg);
          let text = `Process ${bg.id} (${bg.label})`;
          text += ` \u2014 ${bg.alive ? `${bg.status}` : `exited (code ${bg.exitCode})`}`;
          if (output) {
            text += `
${output}`;
          } else {
            text += `
(no new output since last check)`;
          }
          return {
            content: [{ type: "text", text }],
            details: { action: "output", process: info, stream, tail }
          };
        }
        // ── wait_for_ready ──────────────────────────────────
        case "wait_for_ready": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for wait_for_ready" }],
              isError: true,
              details: void 0
            };
          }
          const bg = processes.get(params.id);
          if (!bg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          if (bg.status === "ready") {
            const digest2 = generateDigest(bg, true);
            return {
              content: [{ type: "text", text: `Process ${bg.id} is already ready.
${formatDigestText(bg, digest2)}` }],
              details: { action: "wait_for_ready", process: getInfo(bg), ready: true }
            };
          }
          const timeout = params.timeout || DEFAULT_READY_TIMEOUT;
          const result = await waitForReady(bg, timeout, signal ?? void 0);
          const digest = generateDigest(bg, true);
          let text;
          if (result.ready) {
            text = `\u2713 Process ${bg.id} is ready: ${result.detail}
${formatDigestText(bg, digest)}`;
          } else {
            text = `\u2717 Process ${bg.id} not ready: ${result.detail}
${formatDigestText(bg, digest)}`;
          }
          return {
            content: [{ type: "text", text }],
            details: { action: "wait_for_ready", process: getInfo(bg), ready: result.ready, detail: result.detail }
          };
        }
        // ── send ───────────────────────────────────────────
        case "send": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for send" }],
              isError: true,
              details: void 0
            };
          }
          if (params.input === void 0) {
            return {
              content: [{ type: "text", text: "Error: 'input' is required for send" }],
              isError: true,
              details: void 0
            };
          }
          const bg = processes.get(params.id);
          if (!bg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          if (!bg.alive) {
            return {
              content: [{ type: "text", text: `Error: Process ${params.id} has already exited` }],
              isError: true,
              details: void 0
            };
          }
          try {
            bg.proc.stdin?.write(params.input + "\n");
            return {
              content: [{ type: "text", text: `Sent input to process ${bg.id}` }],
              details: { action: "send", process: getInfo(bg) }
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Error writing to stdin: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
              details: void 0
            };
          }
        }
        // ── send_and_wait ───────────────────────────────────
        case "send_and_wait": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for send_and_wait" }],
              isError: true,
              details: void 0
            };
          }
          if (params.input === void 0) {
            return {
              content: [{ type: "text", text: "Error: 'input' is required for send_and_wait" }],
              isError: true,
              details: void 0
            };
          }
          if (!params.wait_pattern) {
            return {
              content: [{ type: "text", text: "Error: 'wait_pattern' is required for send_and_wait" }],
              isError: true,
              details: void 0
            };
          }
          const bg = processes.get(params.id);
          if (!bg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          if (!bg.alive) {
            return {
              content: [{ type: "text", text: `Error: Process ${params.id} has already exited` }],
              isError: true,
              details: void 0
            };
          }
          const timeout = params.timeout || 1e4;
          const result = await sendAndWait(bg, params.input, params.wait_pattern, timeout, signal ?? void 0);
          let text;
          if (result.matched) {
            text = `\u2713 Pattern matched for process ${bg.id}
${result.output}`;
          } else {
            text = `\u2717 Pattern not matched (timed out after ${timeout}ms)
${result.output}`;
          }
          return {
            content: [{ type: "text", text }],
            details: { action: "send_and_wait", process: getInfo(bg), matched: result.matched }
          };
        }
        // ── run ────────────────────────────────────────────
        case "run": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for run" }],
              isError: true,
              details: void 0
            };
          }
          if (!params.command) {
            return {
              content: [{ type: "text", text: "Error: 'command' is required for run" }],
              isError: true,
              details: void 0
            };
          }
          const bg = processes.get(params.id);
          if (!bg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          if (!bg.alive) {
            return {
              content: [{ type: "text", text: `Error: Process ${params.id} has already exited` }],
              isError: true,
              details: void 0
            };
          }
          const runTimeout = params.timeout || 12e4;
          const result = await runOnSession(bg, params.command, runTimeout, signal ?? void 0);
          let text;
          if (result.timedOut) {
            text = `Command timed out after ${runTimeout}ms
Output:
${result.output}`;
          } else {
            text = `Exit code: ${result.exitCode}
${result.output}`;
          }
          return {
            content: [{ type: "text", text }],
            details: { action: "run", process: getInfo(bg), exitCode: result.exitCode, timedOut: result.timedOut }
          };
        }
        // ── env ───────────────────────────────────────────
        case "env": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for env" }],
              isError: true,
              details: void 0
            };
          }
          const bg = processes.get(params.id);
          if (!bg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          if (!bg.alive) {
            return {
              content: [{ type: "text", text: `Error: Process ${params.id} has already exited` }],
              isError: true,
              details: void 0
            };
          }
          const timeout = params.timeout || 5e3;
          const envResult = await queryShellEnv(bg, timeout, signal ?? void 0);
          if (!envResult) {
            return {
              content: [{ type: "text", text: `Failed to query environment for process ${bg.id} (timed out or process died)` }],
              isError: true,
              details: void 0
            };
          }
          let text = `Shell environment for ${bg.id} (${bg.label}):
`;
          text += `  cwd: ${toPosixPath(envResult.cwd)}
`;
          text += `  shell: ${envResult.shell}
`;
          const envEntries = Object.entries(envResult.env);
          if (envEntries.length > 0) {
            text += `  environment:
`;
            for (const [key, value] of envEntries) {
              const displayValue = value.length > 100 ? value.slice(0, 97) + "..." : value;
              text += `    ${key}=${displayValue}
`;
            }
          }
          return {
            content: [{ type: "text", text: text.trimEnd() }],
            details: { action: "env", process: getInfo(bg), env: envResult }
          };
        }
        // ── signal ─────────────────────────────────────────
        case "signal": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for signal" }],
              isError: true,
              details: void 0
            };
          }
          const bg = processes.get(params.id);
          if (!bg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          const sig = params.signal_name || "SIGINT";
          const sent = killProcess(params.id, sig);
          return {
            content: [{ type: "text", text: sent ? `Sent ${sig} to process ${bg.id} (${bg.label})` : `Failed to send ${sig} to process ${bg.id}` }],
            details: { action: "signal", process: getInfo(bg), signal: sig }
          };
        }
        // ── list ───────────────────────────────────────────
        case "list": {
          const all = Array.from(processes.values()).map(getInfo);
          if (all.length === 0) {
            return {
              content: [{ type: "text", text: "No background processes." }],
              details: { action: "list", processes: [] }
            };
          }
          const lines = all.map((p) => {
            const status = p.alive ? p.status === "ready" ? "\u2713 ready" : p.status === "error" ? "\u2717 error" : "\u22EF starting" : `\u25CB ${p.status} (code ${p.exitCode})`;
            const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
            const urlInfo = p.urls.length > 0 ? ` ${p.urls[0]}` : "";
            const groupInfo = p.group ? ` [${p.group}]` : "";
            return `${p.id}  ${status}  ${p.uptime}  ${p.label}  [${p.processType}]${portInfo}${urlInfo}${groupInfo}`;
          });
          return {
            content: [{ type: "text", text: `Background processes (${all.length}):
${lines.join("\n")}` }],
            details: { action: "list", processes: all }
          };
        }
        // ── kill ───────────────────────────────────────────
        case "kill": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for kill" }],
              isError: true,
              details: void 0
            };
          }
          const bg = processes.get(params.id);
          if (!bg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          const killed = killProcess(params.id, "SIGTERM");
          await new Promise((r) => setTimeout(r, 300));
          if (bg.alive) {
            killProcess(params.id, "SIGKILL");
            await new Promise((r) => setTimeout(r, 200));
          }
          const info = getInfo(bg);
          if (!bg.alive) processes.delete(params.id);
          persistManifest(ctx.cwd);
          return {
            content: [{ type: "text", text: killed ? `Killed process ${bg.id} (${bg.label})` : `Failed to kill process ${bg.id}` }],
            details: { action: "kill", process: info }
          };
        }
        // ── restart ────────────────────────────────────────
        case "restart": {
          if (!params.id) {
            return {
              content: [{ type: "text", text: "Error: 'id' is required for restart" }],
              isError: true,
              details: void 0
            };
          }
          const newBg = await restartProcess(params.id);
          if (!newBg) {
            return {
              content: [{ type: "text", text: `Error: No process found with id '${params.id}'` }],
              isError: true,
              details: void 0
            };
          }
          await new Promise((r) => setTimeout(r, 500));
          persistManifest(ctx.cwd);
          const info = getInfo(newBg);
          let text = `Restarted process (restart #${newBg.restartCount})
`;
          text += `  new id: ${newBg.id}
`;
          text += `  label: ${newBg.label}
`;
          text += `  type: ${newBg.processType}
`;
          text += `  status: ${newBg.status}
`;
          text += `  command: ${newBg.command}`;
          return {
            content: [{ type: "text", text }],
            details: { action: "restart", process: info, previousId: params.id }
          };
        }
        // ── group_status ────────────────────────────────────
        case "group_status": {
          if (!params.group) {
            const groups = /* @__PURE__ */ new Set();
            for (const p of processes.values()) {
              if (p.group) groups.add(p.group);
            }
            if (groups.size === 0) {
              return {
                content: [{ type: "text", text: "No process groups defined." }],
                details: { action: "group_status", groups: [] }
              };
            }
            const statuses = Array.from(groups).map((g) => {
              const gs2 = getGroupStatus(g);
              const icon2 = gs2.healthy ? "\u2713" : "\u2717";
              const procs = gs2.processes.map((p) => `${p.id} (${p.status})`).join(", ");
              return `${icon2} ${g}: ${procs}`;
            });
            return {
              content: [{ type: "text", text: `Process groups:
${statuses.join("\n")}` }],
              details: { action: "group_status", groups: Array.from(groups) }
            };
          }
          const gs = getGroupStatus(params.group);
          const icon = gs.healthy ? "\u2713" : "\u2717";
          let text = `${icon} Group '${params.group}' \u2014 ${gs.healthy ? "healthy" : "unhealthy"}
`;
          for (const p of gs.processes) {
            text += `  ${p.id}: ${p.label} \u2014 ${p.status}${p.alive ? "" : " (dead)"}
`;
          }
          return {
            content: [{ type: "text", text }],
            details: { action: "group_status", groupStatus: gs }
          };
        }
        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${params.action}` }],
            isError: true,
            details: void 0
          };
      }
    },
    // ── Rendering ────────────────────────────────────────────────────
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("bg_shell "));
      text += theme.fg("accent", args.action);
      if (args.command) text += " " + theme.fg("muted", `$ ${args.command}`);
      if (args.id) text += " " + theme.fg("dim", `[${args.id}]`);
      if (args.label) text += " " + theme.fg("dim", `(${args.label})`);
      if (args.type) text += " " + theme.fg("dim", `type:${args.type}`);
      if (args.ready_port) text += " " + theme.fg("dim", `port:${args.ready_port}`);
      if (args.group) text += " " + theme.fg("dim", `group:${args.group}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      const action = details.action;
      if (result.isError) {
        const text = result.content[0];
        return new Text(
          theme.fg("error", text?.type === "text" ? text.text : "Error"),
          0,
          0
        );
      }
      switch (action) {
        case "start": {
          const proc = details.process;
          let text = theme.fg("success", "\u25B8 Started ");
          text += theme.fg("accent", proc.id);
          text += " " + theme.fg("muted", proc.label);
          text += " " + theme.fg("dim", `[${proc.processType}]`);
          if (proc.ports.length > 0) text += " " + theme.fg("dim", `:${proc.ports.join(",")}`);
          if (!proc.alive) {
            text += " " + theme.fg("error", `(exited: ${proc.exitCode})`);
          }
          return new Text(text, 0, 0);
        }
        case "digest": {
          const proc = details.process;
          if (proc) {
            const statusIcon = proc.status === "ready" ? theme.fg("success", "\u2713") : proc.status === "error" ? theme.fg("error", "\u2717") : theme.fg("warning", "\u22EF");
            let text = `${statusIcon} ${theme.fg("accent", proc.id)} ${theme.fg("muted", proc.label)}`;
            if (expanded) {
              const rawText = result.content[0];
              if (rawText?.type === "text") {
                const lines = rawText.text.split("\n").slice(1);
                for (const line of lines.slice(0, 20)) {
                  text += "\n  " + theme.fg("dim", line);
                }
              }
            }
            return new Text(text, 0, 0);
          }
          return new Text(theme.fg("dim", `${details.count ?? 0} process(es)`), 0, 0);
        }
        case "highlights": {
          const proc = details.process;
          const lineCount = details.lineCount;
          let text = theme.fg("accent", proc.id) + " " + theme.fg("dim", `${lineCount} highlights`);
          if (expanded) {
            const rawText = result.content[0];
            if (rawText?.type === "text") {
              const lines = rawText.text.split("\n").slice(1);
              for (const line of lines.slice(0, 20)) {
                text += "\n  " + theme.fg("toolOutput", line);
              }
            }
          }
          return new Text(text, 0, 0);
        }
        case "output": {
          const proc = details.process;
          const statusIcon = proc.alive ? proc.status === "ready" ? theme.fg("success", "\u25CF") : proc.status === "error" ? theme.fg("error", "\u25CF") : theme.fg("warning", "\u25CF") : theme.fg("error", "\u25CB");
          let text = `${statusIcon} ${theme.fg("accent", proc.id)} ${theme.fg("muted", proc.label)}`;
          if (expanded) {
            const rawText = result.content[0];
            if (rawText?.type === "text") {
              const lines = rawText.text.split("\n").slice(1);
              const show = lines.slice(0, 30);
              for (const line of show) {
                text += "\n  " + theme.fg("toolOutput", line);
              }
              if (lines.length > 30) {
                text += `
  ${theme.fg("dim", `... ${lines.length - 30} more lines`)}`;
              }
            }
          } else {
            text += " " + theme.fg("dim", `(${proc.stdoutLines} stdout, ${proc.stderrLines} stderr lines)`);
          }
          return new Text(text, 0, 0);
        }
        case "wait_for_ready": {
          const proc = details.process;
          const ready = details.ready;
          if (ready) {
            let text = theme.fg("success", "\u2713 Ready ") + theme.fg("accent", proc.id);
            if (proc.ports.length > 0) text += " " + theme.fg("dim", `:${proc.ports.join(",")}`);
            if (proc.urls.length > 0) text += " " + theme.fg("dim", proc.urls[0]);
            return new Text(text, 0, 0);
          } else {
            return new Text(
              theme.fg("error", "\u2717 Not ready ") + theme.fg("accent", proc.id) + " " + theme.fg("dim", String(details.detail)),
              0,
              0
            );
          }
        }
        case "send": {
          const proc = details.process;
          return new Text(
            theme.fg("success", "\u2192 ") + theme.fg("muted", `stdin \u2192 ${proc.id}`),
            0,
            0
          );
        }
        case "send_and_wait": {
          const proc = details.process;
          const matched = details.matched;
          if (matched) {
            return new Text(
              theme.fg("success", "\u2713 ") + theme.fg("muted", `Pattern matched \u2014 ${proc.id}`),
              0,
              0
            );
          }
          return new Text(
            theme.fg("warning", "\u2717 ") + theme.fg("muted", `Timed out \u2014 ${proc.id}`),
            0,
            0
          );
        }
        case "run": {
          const proc = details.process;
          const exitCode = details.exitCode;
          const timedOut = details.timedOut;
          if (timedOut) {
            let text2 = theme.fg("warning", "\u23F1 Timed out ") + theme.fg("accent", proc.id);
            if (expanded) {
              const rawText = result.content[0];
              if (rawText?.type === "text") {
                const lines = rawText.text.split("\n").slice(1);
                for (const line of lines.slice(0, 30)) {
                  text2 += "\n  " + theme.fg("toolOutput", line);
                }
              }
            }
            return new Text(text2, 0, 0);
          }
          const icon = exitCode === 0 ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
          let text = `${icon} ${theme.fg("accent", proc.id)} ${theme.fg("dim", `exit:${exitCode}`)}`;
          if (expanded) {
            const rawText = result.content[0];
            if (rawText?.type === "text") {
              const lines = rawText.text.split("\n").slice(1);
              for (const line of lines.slice(0, 30)) {
                text += "\n  " + theme.fg("toolOutput", line);
              }
              if (lines.length > 30) {
                text += `
  ${theme.fg("dim", `... ${lines.length - 30} more lines`)}`;
              }
            }
          }
          return new Text(text, 0, 0);
        }
        case "signal": {
          const sig = details.signal;
          const proc = details.process;
          return new Text(
            theme.fg("warning", `${sig} `) + theme.fg("muted", `\u2192 ${proc.id}`),
            0,
            0
          );
        }
        case "list": {
          const procs = details.processes;
          if (procs.length === 0) {
            return new Text(theme.fg("dim", "No background processes"), 0, 0);
          }
          let text = theme.fg("muted", `${procs.length} background process(es)`);
          if (expanded) {
            for (const p of procs) {
              const statusIcon = p.alive ? p.status === "ready" ? theme.fg("success", "\u25CF") : p.status === "error" ? theme.fg("error", "\u25CF") : theme.fg("warning", "\u25CF") : theme.fg("error", "\u25CB");
              const portInfo = p.ports.length > 0 ? ` :${p.ports.join(",")}` : "";
              text += `
  ${statusIcon} ${theme.fg("accent", p.id)}  ${theme.fg("dim", p.uptime)}  ${theme.fg("muted", p.label)}  [${p.processType}]${portInfo}`;
            }
          }
          return new Text(text, 0, 0);
        }
        case "kill": {
          const proc = details.process;
          return new Text(
            theme.fg("success", "\u2713 Killed ") + theme.fg("accent", proc.id) + " " + theme.fg("muted", proc.label),
            0,
            0
          );
        }
        case "restart": {
          const proc = details.process;
          return new Text(
            theme.fg("success", "\u21BB Restarted ") + theme.fg("accent", proc.id) + " " + theme.fg("muted", proc.label) + " " + theme.fg("dim", `#${proc.restartCount}`),
            0,
            0
          );
        }
        case "env": {
          const proc = details.process;
          const envData = details.env;
          let text = theme.fg("accent", proc.id) + " " + theme.fg("muted", proc.label);
          if (envData) {
            text += " " + theme.fg("dim", `cwd: ${envData.cwd}`);
          }
          if (expanded) {
            const rawText = result.content[0];
            if (rawText?.type === "text") {
              const lines = rawText.text.split("\n").slice(1);
              for (const line of lines.slice(0, 15)) {
                text += "\n  " + theme.fg("dim", line);
              }
            }
          }
          return new Text(text, 0, 0);
        }
        case "group_status": {
          const gs = details.groupStatus;
          if (gs) {
            const icon = gs.healthy ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
            return new Text(
              `${icon} ${theme.fg("accent", gs.group)} \u2014 ${gs.processes.length} process(es)`,
              0,
              0
            );
          }
          const groups = details.groups;
          return new Text(theme.fg("dim", `${groups?.length ?? 0} group(s)`), 0, 0);
        }
        default: {
          const text = result.content[0];
          return new Text(text?.type === "text" ? text.text : "", 0, 0);
        }
      }
    }
  });
}
export {
  registerBgShellTool
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2JnLXNoZWxsL2JnLXNoZWxsLXRvb2wudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogYmdfc2hlbGwgdG9vbCByZWdpc3RyYXRpb24gXHUyMDE0IHRoZSBjb3JlIHRvb2wgdGhhdCBhZ2VudHMgdXNlIHRvIG1hbmFnZSBiYWNrZ3JvdW5kIHByb2Nlc3Nlcy5cbiAqL1xuXG5pbXBvcnQgeyBTdHJpbmdFbnVtIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJIH0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBUZXh0IH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5cbmltcG9ydCB0eXBlIHsgQmdQcm9jZXNzSW5mbywgUHJvY2Vzc1R5cGUgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgREVGQVVMVF9SRUFEWV9USU1FT1VUIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7XG5cdHByb2Nlc3Nlcyxcblx0c3RhcnRQcm9jZXNzLFxuXHRraWxsUHJvY2Vzcyxcblx0cmVzdGFydFByb2Nlc3MsXG5cdGdldEluZm8sXG5cdGdldEdyb3VwU3RhdHVzLFxuXHRwZXJzaXN0TWFuaWZlc3QsXG59IGZyb20gXCIuL3Byb2Nlc3MtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHtcblx0Z2VuZXJhdGVEaWdlc3QsXG5cdGdldEhpZ2hsaWdodHMsXG5cdGdldE91dHB1dCxcblx0Zm9ybWF0RGlnZXN0VGV4dCxcbn0gZnJvbSBcIi4vb3V0cHV0LWZvcm1hdHRlci5qc1wiO1xuaW1wb3J0IHsgd2FpdEZvclJlYWR5IH0gZnJvbSBcIi4vcmVhZGluZXNzLWRldGVjdG9yLmpzXCI7XG5pbXBvcnQgeyBxdWVyeVNoZWxsRW52LCBzZW5kQW5kV2FpdCwgcnVuT25TZXNzaW9uIH0gZnJvbSBcIi4vaW50ZXJhY3Rpb24uanNcIjtcbmltcG9ydCB7IHRvUG9zaXhQYXRoIH0gZnJvbSBcIi4uL3NoYXJlZC9wYXRoLWRpc3BsYXkuanNcIjtcblxuaW1wb3J0IHR5cGUgeyBCZ1NoZWxsU2hhcmVkU3RhdGUgfSBmcm9tIFwiLi9pbmRleC5qc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJCZ1NoZWxsVG9vbChwaTogRXh0ZW5zaW9uQVBJLCBzdGF0ZTogQmdTaGVsbFNoYXJlZFN0YXRlKTogdm9pZCB7XG5cdHBpLnJlZ2lzdGVyVG9vbCh7XG5cdFx0bmFtZTogXCJiZ19zaGVsbFwiLFxuXHRcdGxhYmVsOiBcIkJhY2tncm91bmQgU2hlbGxcIixcblx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFwiUnVuIHNoZWxsIGNvbW1hbmRzIGluIHRoZSBiYWNrZ3JvdW5kIHdpdGhvdXQgYmxvY2tpbmcuIE1hbmFnZXMgcGVyc2lzdGVudCBiYWNrZ3JvdW5kIHByb2Nlc3NlcyB3aXRoIGludGVsbGlnZW50IGxpZmVjeWNsZSB0cmFja2luZy4gXCIgK1xuXHRcdFx0XCJBY3Rpb25zOiBzdGFydCAobGF1bmNoIHdpdGggYXV0by1jbGFzc2lmaWNhdGlvbiAmIHJlYWRpbmVzcyBkZXRlY3Rpb24pLCBkaWdlc3QgKHN0cnVjdHVyZWQgc3VtbWFyeSB+MzAgdG9rZW5zIHZzIH4yMDAwIHJhdyksIFwiICtcblx0XHRcdFwib3V0cHV0IChyYXcgbGluZXMgd2l0aCBpbmNyZW1lbnRhbCBkZWxpdmVyeSksIHdhaXRfZm9yX3JlYWR5IChibG9jayB1bnRpbCBwcm9jZXNzIHNpZ25hbHMgcmVhZGluZXNzKSwgXCIgK1xuXHRcdFx0XCJzZW5kICh3cml0ZSBzdGRpbiksIHNlbmRfYW5kX3dhaXQgKGV4cGVjdC1zdHlsZTogc2VuZCArIHdhaXQgZm9yIG91dHB1dCBwYXR0ZXJuKSwgXCIgK1xuXHRcdFx0XCJydW4gKGV4ZWN1dGUgYSBjb21tYW5kIG9uIGEgcGVyc2lzdGVudCBzaGVsbCBzZXNzaW9uLCBibG9jayB1bnRpbCBkb25lLCByZXR1cm4gb3V0cHV0ICsgZXhpdCBjb2RlKSwgXCIgK1xuXHRcdFx0XCJlbnYgKHF1ZXJ5IHNoZWxsIGN3ZCBhbmQgZW52aXJvbm1lbnQgdmFyaWFibGVzKSwgXCIgK1xuXHRcdFx0XCJzaWduYWwgKHNlbmQgT1Mgc2lnbmFsKSwgbGlzdCAoYWxsIHByb2Nlc3NlcyB3aXRoIHN0YXR1cyksIGtpbGwgKHRlcm1pbmF0ZSksIHJlc3RhcnQgKGtpbGwgKyByZWxhdW5jaCksIFwiICtcblx0XHRcdFwiZ3JvdXBfc3RhdHVzIChoZWFsdGggb2YgYSBwcm9jZXNzIGdyb3VwKSwgaGlnaGxpZ2h0cyAoc2lnbmlmaWNhbnQgb3V0cHV0IGxpbmVzIG9ubHkpLlwiLFxuXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJVc2UgYmdfc2hlbGwgdG8gc3RhcnQgbG9uZy1ydW5uaW5nIHByb2Nlc3NlcyAoc2VydmVycywgd2F0Y2hlcnMsIGJ1aWxkcykgdGhhdCBzaG91bGQgbm90IGJsb2NrIHRoZSBhZ2VudC5cIixcblx0XHRcdFwiQWZ0ZXIgc3RhcnRpbmcgYSBzZXJ2ZXIsIHVzZSAnd2FpdF9mb3JfcmVhZHknIHRvIGVmZmljaWVudGx5IGJsb2NrIHVudGlsIGl0J3MgbGlzdGVuaW5nIFx1MjAxNCBhdm9pZHMgcG9sbGluZyBsb29wcyBlbnRpcmVseS5cIixcblx0XHRcdFwiVXNlICdkaWdlc3QnIGluc3RlYWQgb2YgJ291dHB1dCcgd2hlbiB5b3UganVzdCBuZWVkIHN0YXR1cyBcdTIwMTQgaXQgcmV0dXJucyBhIHN0cnVjdHVyZWQgfjMwLXRva2VuIHN1bW1hcnkgaW5zdGVhZCBvZiB+MjAwMCB0b2tlbnMgb2YgcmF3IG91dHB1dC5cIixcblx0XHRcdFwiVXNlICdoaWdobGlnaHRzJyB0byBzZWUgb25seSBzaWduaWZpY2FudCBvdXRwdXQgKGVycm9ycywgVVJMcywgcmVzdWx0cykgXHUyMDE0IHR5cGljYWxseSA1LTE1IGxpbmVzIGluc3RlYWQgb2YgaHVuZHJlZHMuXCIsXG5cdFx0XHRcIlVzZSAnb3V0cHV0JyBvbmx5IHdoZW4geW91IG5lZWQgcmF3IGxpbmVzIGZvciBkZWJ1Z2dpbmcgXHUyMDE0IGFkZCBmaWx0ZXI6J2Vycm9yfHdhcm5pbmcnIHRvIG5hcnJvdyByZXN1bHRzLlwiLFxuXHRcdFx0XCJUaGUgJ291dHB1dCcgYWN0aW9uIHJldHVybnMgb25seSBuZXcgb3V0cHV0IHNpbmNlIHRoZSBsYXN0IGNoZWNrIChpbmNyZW1lbnRhbCkuIFJlcGVhdGVkIGNhbGxzIGFyZSBjaGVhcCBvbiBjb250ZXh0LlwiLFxuXHRcdFx0XCJTZXQgdHlwZTonc2VydmVyJyBhbmQgcmVhZHlfcG9ydDozMDAwIGZvciBkZXYgc2VydmVycyBzbyByZWFkaW5lc3MgZGV0ZWN0aW9uIGlzIGF1dG9tYXRpYy5cIixcblx0XHRcdFwiU2V0IGdyb3VwOidteS1zdGFjaycgb24gcmVsYXRlZCBwcm9jZXNzZXMgdG8gbWFuYWdlIHRoZW0gdG9nZXRoZXIgd2l0aCAnZ3JvdXBfc3RhdHVzJy5cIixcblx0XHRcdFwiVXNlICdydW4nIHRvIGV4ZWN1dGUgYSBjb21tYW5kIG9uIGEgcGVyc2lzdGVudCBzaGVsbCBzZXNzaW9uIGFuZCBibG9jayB1bnRpbCBpdCBjb21wbGV0ZXMgXHUyMDE0IHJldHVybnMgc3RydWN0dXJlZCBvdXRwdXQgKyBleGl0IGNvZGUuIFNoZWxsIHN0YXRlIChlbnYgdmFycywgY3dkLCB2aXJ0dWFsZW52cykgcGVyc2lzdHMgYWNyb3NzIHJ1bnMuXCIsXG5cdFx0XHRcIlVzZSAnc2VuZF9hbmRfd2FpdCcgZm9yIGludGVyYWN0aXZlIENMSXM6IHNlbmQgaW5wdXQgYW5kIHdhaXQgZm9yIGV4cGVjdGVkIG91dHB1dCBwYXR0ZXJuLlwiLFxuXHRcdFx0XCJVc2UgJ2VudicgdG8gY2hlY2sgdGhlIGN1cnJlbnQgd29ya2luZyBkaXJlY3RvcnkgYW5kIGFjdGl2ZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMgb2YgYSBzaGVsbCBzZXNzaW9uIFx1MjAxNCB1c2VmdWwgYWZ0ZXIgY2QsIHNvdXJjZSwgb3IgZXhwb3J0IGNvbW1hbmRzLlwiLFxuXHRcdFx0XCJCYWNrZ3JvdW5kIHByb2Nlc3NlcyBhcmUgc2Vzc2lvbi1zY29wZWQgYnkgZGVmYXVsdDogYSBuZXcgc2Vzc2lvbiByZWFwcyB0aGVtIHVubGVzcyB5b3Ugc2V0IHBlcnNpc3RfYWNyb3NzX3Nlc3Npb25zOnRydWUuXCIsXG5cdFx0XHRcIlVzZSAncmVzdGFydCcgdG8ga2lsbCBhbmQgcmVsYXVuY2ggd2l0aCB0aGUgc2FtZSBjb25maWcgXHUyMDE0IHByZXNlcnZlcyByZXN0YXJ0IGNvdW50LlwiLFxuXHRcdFx0XCJCYWNrZ3JvdW5kIHByb2Nlc3NlcyBhcmUgYXV0by1jbGFzc2lmaWVkIChzZXJ2ZXIvYnVpbGQvdGVzdC93YXRjaGVyKSBiYXNlZCBvbiB0aGUgY29tbWFuZC5cIixcblx0XHRcdFwiUHJvY2VzcyBjcmFzaGVzIGFuZCBlcnJvcnMgYXJlIGF1dG9tYXRpY2FsbHkgc3VyZmFjZWQgYXMgYWxlcnRzIGF0IHRoZSBzdGFydCBvZiB5b3VyIG5leHQgdHVybiBcdTIwMTQgeW91IGRvbid0IG5lZWQgdG8gcG9sbC5cIixcblx0XHRcdFwiVG8gY3JlYXRlIGEgcGVyc2lzdGVudCBzaGVsbCBzZXNzaW9uOiBiZ19zaGVsbCBzdGFydCB3aXRoIHR5cGU6J3NoZWxsJy4gVGhlIHNlc3Npb24gc3RheXMgYWxpdmUgZm9yIGludGVyYWN0aXZlIHVzZSB3aXRoICdzZW5kJywgJ3NlbmRfYW5kX3dhaXQnLCBvciAncnVuJy5cIixcblx0XHRdLFxuXG5cdFx0cGFyYW1ldGVyczogVHlwZS5PYmplY3Qoe1xuXHRcdFx0YWN0aW9uOiBTdHJpbmdFbnVtKFtcblx0XHRcdFx0XCJzdGFydFwiLFxuXHRcdFx0XHRcImRpZ2VzdFwiLFxuXHRcdFx0XHRcIm91dHB1dFwiLFxuXHRcdFx0XHRcImhpZ2hsaWdodHNcIixcblx0XHRcdFx0XCJ3YWl0X2Zvcl9yZWFkeVwiLFxuXHRcdFx0XHRcInNlbmRcIixcblx0XHRcdFx0XCJzZW5kX2FuZF93YWl0XCIsXG5cdFx0XHRcdFwicnVuXCIsXG5cdFx0XHRcdFwiZW52XCIsXG5cdFx0XHRcdFwic2lnbmFsXCIsXG5cdFx0XHRcdFwibGlzdFwiLFxuXHRcdFx0XHRcImtpbGxcIixcblx0XHRcdFx0XCJyZXN0YXJ0XCIsXG5cdFx0XHRcdFwiZ3JvdXBfc3RhdHVzXCIsXG5cdFx0XHRdIGFzIGNvbnN0KSxcblx0XHRcdGNvbW1hbmQ6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiU2hlbGwgY29tbWFuZCB0byBydW4gKGZvciBzdGFydCwgcnVuKVwiIH0pLFxuXHRcdFx0KSxcblx0XHRcdGxhYmVsOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlNob3J0IGh1bWFuLXJlYWRhYmxlIGxhYmVsIGZvciB0aGUgcHJvY2VzcyAoZm9yIHN0YXJ0KVwiIH0pLFxuXHRcdFx0KSxcblx0XHRcdGlkOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlByb2Nlc3MgSUQgKGZvciBkaWdlc3QsIG91dHB1dCwgaGlnaGxpZ2h0cywgd2FpdF9mb3JfcmVhZHksIHNlbmQsIHNlbmRfYW5kX3dhaXQsIHJ1biwgc2lnbmFsLCBraWxsLCByZXN0YXJ0KVwiIH0pLFxuXHRcdFx0KSxcblx0XHRcdHN0cmVhbTogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0U3RyaW5nRW51bShbXCJzdGRvdXRcIiwgXCJzdGRlcnJcIiwgXCJib3RoXCJdIGFzIGNvbnN0KSxcblx0XHRcdCksXG5cdFx0XHR0YWlsOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIk51bWJlciBvZiBtb3N0IHJlY2VudCBsaW5lcyB0byByZXR1cm4gKGZvciBvdXRwdXQpLiBEZWZhdWx0cyB0byAxMDAuXCIgfSksXG5cdFx0XHQpLFxuXHRcdFx0ZmlsdGVyOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlJlZ2V4IHBhdHRlcm4gdG8gZmlsdGVyIG91dHB1dCBsaW5lcyAoZm9yIG91dHB1dCkuIENhc2UtaW5zZW5zaXRpdmUuXCIgfSksXG5cdFx0XHQpLFxuXHRcdFx0aW5wdXQ6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGV4dCB0byB3cml0ZSB0byBwcm9jZXNzIHN0ZGluIChmb3Igc2VuZCwgc2VuZF9hbmRfd2FpdClcIiB9KSxcblx0XHRcdCksXG5cdFx0XHR3YWl0X3BhdHRlcm46IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiUmVnZXggdG8gd2FpdCBmb3IgaW4gb3V0cHV0IChmb3Igc2VuZF9hbmRfd2FpdClcIiB9KSxcblx0XHRcdCksXG5cdFx0XHRzaWduYWxfbmFtZTogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJPUyBzaWduYWwgdG8gc2VuZCwgZS5nLiBTSUdJTlQsIFNJR1RFUk0sIFNJR0hVUCAoZm9yIHNpZ25hbClcIiB9KSxcblx0XHRcdCksXG5cdFx0XHR0aW1lb3V0OiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLk51bWJlcih7IGRlc2NyaXB0aW9uOiBcIlRpbWVvdXQgaW4gbWlsbGlzZWNvbmRzIChmb3Igd2FpdF9mb3JfcmVhZHksIHNlbmRfYW5kX3dhaXQsIHJ1bikuIERlZmF1bHQ6IDMwMDAwIGZvciB3YWl0X2Zvcl9yZWFkeS9zZW5kX2FuZF93YWl0LCAxMjAwMDAgZm9yIHJ1blwiIH0pLFxuXHRcdFx0KSxcblx0XHRcdHR5cGU6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFN0cmluZ0VudW0oW1wic2VydmVyXCIsIFwiYnVpbGRcIiwgXCJ0ZXN0XCIsIFwid2F0Y2hlclwiLCBcImdlbmVyaWNcIiwgXCJzaGVsbFwiXSBhcyBjb25zdCksXG5cdFx0XHQpLFxuXHRcdFx0cmVhZHlfcGF0dGVybjogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJSZWdleCBwYXR0ZXJuIHRoYXQgaW5kaWNhdGVzIHRoZSBwcm9jZXNzIGlzIHJlYWR5IChmb3Igc3RhcnQpXCIgfSksXG5cdFx0XHQpLFxuXHRcdFx0cmVhZHlfcG9ydDogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5OdW1iZXIoeyBkZXNjcmlwdGlvbjogXCJQb3J0IHRvIHByb2JlIGZvciByZWFkaW5lc3MgKGZvciBzdGFydCkuIFdoZW4gb3BlbiwgcHJvY2VzcyBpcyBjb25zaWRlcmVkIHJlYWR5LlwiIH0pLFxuXHRcdFx0KSxcblx0XHRcdHJlYWR5X3RpbWVvdXQ6IFR5cGUuT3B0aW9uYWwoXG5cdFx0XHRcdFR5cGUuTnVtYmVyKHsgZGVzY3JpcHRpb246IFwiTWF4IG1pbGxpc2Vjb25kcyB0byB3YWl0IGZvciByZWFkeV9wb3J0L3JlYWR5X3BhdHRlcm4gYmVmb3JlIG1hcmtpbmcgYXMgZXJyb3IgKGRlZmF1bHQ6IDMwMDAwKVwiIH0pLFxuXHRcdFx0KSxcblx0XHRcdGdyb3VwOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFx0XHRUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIkdyb3VwIG5hbWUgZm9yIHJlbGF0ZWQgcHJvY2Vzc2VzIChmb3Igc3RhcnQsIGdyb3VwX3N0YXR1cylcIiB9KSxcblx0XHRcdCksXG5cdFx0XHRwZXJzaXN0X2Fjcm9zc19zZXNzaW9uczogVHlwZS5PcHRpb25hbChcblx0XHRcdFx0VHlwZS5Cb29sZWFuKHtcblx0XHRcdFx0XHRkZXNjcmlwdGlvbjogXCJLZWVwIHRoaXMgcHJvY2VzcyBydW5uaW5nIGFmdGVyIGEgbmV3IHNlc3Npb24gc3RhcnRzLiBEZWZhdWx0OiBmYWxzZS5cIixcblx0XHRcdFx0XHRkZWZhdWx0OiBmYWxzZSxcblx0XHRcdFx0fSksXG5cdFx0XHQpLFxuXHRcdH0pLFxuXG5cdFx0YXN5bmMgZXhlY3V0ZShfdG9vbENhbGxJZCwgcGFyYW1zLCBzaWduYWwsIF9vblVwZGF0ZSwgY3R4KSB7XG5cdFx0XHRzdGF0ZS5sYXRlc3RDdHggPSBjdHg7XG5cblx0XHRcdHN3aXRjaCAocGFyYW1zLmFjdGlvbikge1xuXHRcdFx0XHQvLyBcdTI1MDBcdTI1MDAgc3RhcnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdFx0XHRcdGNhc2UgXCJzdGFydFwiOiB7XG5cdFx0XHRcdFx0aWYgKCFwYXJhbXMuY29tbWFuZCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiRXJyb3I6ICdjb21tYW5kJyBpcyByZXF1aXJlZCBmb3Igc3RhcnRcIiB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IGJnID0gc3RhcnRQcm9jZXNzKHtcblx0XHRcdFx0XHRcdGNvbW1hbmQ6IHBhcmFtcy5jb21tYW5kLFxuXHRcdFx0XHRcdFx0Y3dkOiBjdHguY3dkLFxuXHRcdFx0XHRcdFx0b3duZXJTZXNzaW9uRmlsZTogY3R4LnNlc3Npb25NYW5hZ2VyLmdldFNlc3Npb25GaWxlKCkgPz8gbnVsbCxcblx0XHRcdFx0XHRcdHBlcnNpc3RBY3Jvc3NTZXNzaW9uczogcGFyYW1zLnBlcnNpc3RfYWNyb3NzX3Nlc3Npb25zID8/IGZhbHNlLFxuXHRcdFx0XHRcdFx0bGFiZWw6IHBhcmFtcy5sYWJlbCxcblx0XHRcdFx0XHRcdHR5cGU6IHBhcmFtcy50eXBlIGFzIFByb2Nlc3NUeXBlIHwgdW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0cmVhZHlQYXR0ZXJuOiBwYXJhbXMucmVhZHlfcGF0dGVybixcblx0XHRcdFx0XHRcdHJlYWR5UG9ydDogcGFyYW1zLnJlYWR5X3BvcnQsXG5cdFx0XHRcdFx0XHRyZWFkeVRpbWVvdXQ6IHBhcmFtcy5yZWFkeV90aW1lb3V0LFxuXHRcdFx0XHRcdFx0Z3JvdXA6IHBhcmFtcy5ncm91cCxcblx0XHRcdFx0XHR9KTtcblxuXHRcdFx0XHRcdC8vIEdpdmUgdGhlIHByb2Nlc3MgYSBtb21lbnQgdG8gcG90ZW50aWFsbHkgZmFpbCBpbW1lZGlhdGVseVxuXHRcdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCA1MDApKTtcblxuXHRcdFx0XHRcdC8vIFBlcnNpc3QgbWFuaWZlc3Rcblx0XHRcdFx0XHRwZXJzaXN0TWFuaWZlc3QoY3R4LmN3ZCk7XG5cblx0XHRcdFx0XHRjb25zdCBpbmZvID0gZ2V0SW5mbyhiZyk7XG5cdFx0XHRcdFx0bGV0IHRleHQgPSBgU3RhcnRlZCBiYWNrZ3JvdW5kIHByb2Nlc3MgJHtiZy5pZH1cXG5gO1xuXHRcdFx0XHRcdHRleHQgKz0gYCAgbGFiZWw6ICR7YmcubGFiZWx9XFxuYDtcblx0XHRcdFx0XHR0ZXh0ICs9IGAgIHR5cGU6ICR7YmcucHJvY2Vzc1R5cGV9XFxuYDtcblx0XHRcdFx0XHR0ZXh0ICs9IGAgIHN0YXR1czogJHtiZy5zdGF0dXN9XFxuYDtcblx0XHRcdFx0XHR0ZXh0ICs9IGAgIGNvbW1hbmQ6ICR7YmcuY29tbWFuZH1cXG5gO1xuXHRcdFx0XHRcdHRleHQgKz0gYCAgY3dkOiAke3RvUG9zaXhQYXRoKGJnLmN3ZCl9YDtcblx0XHRcdFx0XHRpZiAoYmcuZ3JvdXApIHRleHQgKz0gYFxcbiAgZ3JvdXA6ICR7YmcuZ3JvdXB9YDtcblx0XHRcdFx0XHRpZiAoYmcucGVyc2lzdEFjcm9zc1Nlc3Npb25zKSB0ZXh0ICs9IGBcXG4gIHBlcnNpc3RfYWNyb3NzX3Nlc3Npb25zOiB0cnVlYDtcblx0XHRcdFx0XHRpZiAoYmcucmVhZHlQb3J0KSB0ZXh0ICs9IGBcXG4gIHJlYWR5X3BvcnQ6ICR7YmcucmVhZHlQb3J0fWA7XG5cdFx0XHRcdFx0aWYgKGJnLnJlYWR5UGF0dGVybikgdGV4dCArPSBgXFxuICByZWFkeV9wYXR0ZXJuOiAke2JnLnJlYWR5UGF0dGVybn1gO1xuXHRcdFx0XHRcdGlmIChiZy5wb3J0cy5sZW5ndGggPiAwKSB0ZXh0ICs9IGBcXG4gIGRldGVjdGVkIHBvcnRzOiAke2JnLnBvcnRzLmpvaW4oXCIsIFwiKX1gO1xuXHRcdFx0XHRcdGlmIChiZy51cmxzLmxlbmd0aCA+IDApIHRleHQgKz0gYFxcbiAgZGV0ZWN0ZWQgdXJsczogJHtiZy51cmxzLmpvaW4oXCIsIFwiKX1gO1xuXG5cdFx0XHRcdFx0aWYgKCFiZy5hbGl2ZSkge1xuXHRcdFx0XHRcdFx0dGV4dCArPSBgXFxuICBleGl0IGNvZGU6ICR7YmcuZXhpdENvZGV9YDtcblx0XHRcdFx0XHRcdGNvbnN0IGVyckxpbmVzID0gYmcub3V0cHV0LmZpbHRlcihsID0+IGwuc3RyZWFtID09PSBcInN0ZGVyclwiKS5tYXAobCA9PiBsLmxpbmUpO1xuXHRcdFx0XHRcdFx0Y29uc3QgZXJyT3V0ID0gZXJyTGluZXMuam9pbihcIlxcblwiKS50cmltKCk7XG5cdFx0XHRcdFx0XHRpZiAoZXJyT3V0KSB0ZXh0ICs9IGBcXG4gIHN0ZGVycjpcXG4ke2Vyck91dH1gO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dCB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uOiBcInN0YXJ0XCIsIHByb2Nlc3M6IGluZm8gfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gXHUyNTAwXHUyNTAwIGRpZ2VzdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdFx0Y2FzZSBcImRpZ2VzdFwiOiB7XG5cdFx0XHRcdFx0Ly8gQ2FuIGdldCBkaWdlc3QgZm9yIGEgc2luZ2xlIHByb2Nlc3Mgb3IgYWxsXG5cdFx0XHRcdFx0aWYgKHBhcmFtcy5pZCkge1xuXHRcdFx0XHRcdFx0Y29uc3QgYmcgPSBwcm9jZXNzZXMuZ2V0KHBhcmFtcy5pZCk7XG5cdFx0XHRcdFx0XHRpZiAoIWJnKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBFcnJvcjogTm8gcHJvY2VzcyBmb3VuZCB3aXRoIGlkICcke3BhcmFtcy5pZH0nYCB9XSxcblx0XHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGNvbnN0IGRpZ2VzdCA9IGdlbmVyYXRlRGlnZXN0KGJnLCB0cnVlKTtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBmb3JtYXREaWdlc3RUZXh0KGJnLCBkaWdlc3QpIH1dLFxuXHRcdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbjogXCJkaWdlc3RcIiwgcHJvY2VzczogZ2V0SW5mbyhiZyksIGRpZ2VzdCB9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHQvLyBBbGwgcHJvY2Vzc2VzIGRpZ2VzdFxuXHRcdFx0XHRcdGNvbnN0IGFsbCA9IEFycmF5LmZyb20ocHJvY2Vzc2VzLnZhbHVlcygpKTtcblx0XHRcdFx0XHRpZiAoYWxsLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiTm8gYmFja2dyb3VuZCBwcm9jZXNzZXMuXCIgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uOiBcImRpZ2VzdFwiLCBwcm9jZXNzZXM6IFtdIH0sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gYWxsLm1hcChiZyA9PiB7XG5cdFx0XHRcdFx0XHRjb25zdCBkID0gZ2VuZXJhdGVEaWdlc3QoYmcsIHRydWUpO1xuXHRcdFx0XHRcdFx0Y29uc3Qgc3RhdHVzID0gYmcuYWxpdmVcblx0XHRcdFx0XHRcdFx0PyAoYmcuc3RhdHVzID09PSBcInJlYWR5XCIgPyBcIlx1MjcxM1wiIDogYmcuc3RhdHVzID09PSBcImVycm9yXCIgPyBcIlx1MjcxN1wiIDogXCJcdTIyRUZcIilcblx0XHRcdFx0XHRcdFx0OiBcIlx1MjVDQlwiO1xuXHRcdFx0XHRcdFx0Y29uc3QgcG9ydEluZm8gPSBkLnBvcnRzLmxlbmd0aCA+IDAgPyBgIDoke2QucG9ydHMuam9pbihcIixcIil9YCA6IFwiXCI7XG5cdFx0XHRcdFx0XHRjb25zdCBlcnJJbmZvID0gZC5lcnJvcnMubGVuZ3RoID4gMCA/IGAgKCR7ZC5lcnJvcnMubGVuZ3RofSBlcnJvcnMpYCA6IFwiXCI7XG5cdFx0XHRcdFx0XHRyZXR1cm4gYCR7c3RhdHVzfSAke2JnLmlkfSAke2JnLmxhYmVsfSBbJHtiZy5wcm9jZXNzVHlwZX1dICR7ZC51cHRpbWV9JHtwb3J0SW5mb30ke2VyckluZm99IFx1MjAxNCAke2QuY2hhbmdlU3VtbWFyeX1gO1xuXHRcdFx0XHRcdH0pO1xuXG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgQmFja2dyb3VuZCBwcm9jZXNzZXMgKCR7YWxsLmxlbmd0aH0pOlxcbiR7bGluZXMuam9pbihcIlxcblwiKX1gIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb246IFwiZGlnZXN0XCIsIGNvdW50OiBhbGwubGVuZ3RoIH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFx1MjUwMFx1MjUwMCBoaWdobGlnaHRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHRcdFx0XHRjYXNlIFwiaGlnaGxpZ2h0c1wiOiB7XG5cdFx0XHRcdFx0aWYgKCFwYXJhbXMuaWQpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiAnaWQnIGlzIHJlcXVpcmVkIGZvciBoaWdobGlnaHRzXCIgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBiZyA9IHByb2Nlc3Nlcy5nZXQocGFyYW1zLmlkKTtcblx0XHRcdFx0XHRpZiAoIWJnKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yOiBObyBwcm9jZXNzIGZvdW5kIHdpdGggaWQgJyR7cGFyYW1zLmlkfSdgIH1dLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgaGlnaGxpZ2h0cyA9IGdldEhpZ2hsaWdodHMoYmcsIHBhcmFtcy50YWlsIHx8IDE1KTtcblx0XHRcdFx0XHRjb25zdCBpbmZvID0gZ2V0SW5mbyhiZyk7XG5cdFx0XHRcdFx0bGV0IHRleHQgPSBgSGlnaGxpZ2h0cyBmb3IgJHtiZy5pZH0gKCR7YmcubGFiZWx9KSBcdTIwMTQgJHtiZy5zdGF0dXN9OlxcbmA7XG5cdFx0XHRcdFx0aWYgKGhpZ2hsaWdodHMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9IFwiKG5vIHNpZ25pZmljYW50IG91dHB1dClcIjtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0dGV4dCArPSBoaWdobGlnaHRzLmpvaW4oXCJcXG5cIik7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0IH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb246IFwiaGlnaGxpZ2h0c1wiLCBwcm9jZXNzOiBpbmZvLCBsaW5lQ291bnQ6IGhpZ2hsaWdodHMubGVuZ3RoIH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFx1MjUwMFx1MjUwMCBvdXRwdXQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdFx0XHRcdGNhc2UgXCJvdXRwdXRcIjoge1xuXHRcdFx0XHRcdGlmICghcGFyYW1zLmlkKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogXCJFcnJvcjogJ2lkJyBpcyByZXF1aXJlZCBmb3Igb3V0cHV0XCIgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBiZyA9IHByb2Nlc3Nlcy5nZXQocGFyYW1zLmlkKTtcblx0XHRcdFx0XHRpZiAoIWJnKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yOiBObyBwcm9jZXNzIGZvdW5kIHdpdGggaWQgJyR7cGFyYW1zLmlkfSdgIH1dLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3Qgc3RyZWFtID0gcGFyYW1zLnN0cmVhbSB8fCBcImJvdGhcIjtcblx0XHRcdFx0XHRjb25zdCB0YWlsID0gcGFyYW1zLnRhaWwgPz8gMTAwO1xuXHRcdFx0XHRcdGNvbnN0IG91dHB1dCA9IGdldE91dHB1dChiZywge1xuXHRcdFx0XHRcdFx0c3RyZWFtLFxuXHRcdFx0XHRcdFx0dGFpbCxcblx0XHRcdFx0XHRcdGZpbHRlcjogcGFyYW1zLmZpbHRlcixcblx0XHRcdFx0XHRcdGluY3JlbWVudGFsOiB0cnVlLFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGNvbnN0IGluZm8gPSBnZXRJbmZvKGJnKTtcblxuXHRcdFx0XHRcdGxldCB0ZXh0ID0gYFByb2Nlc3MgJHtiZy5pZH0gKCR7YmcubGFiZWx9KWA7XG5cdFx0XHRcdFx0dGV4dCArPSBgIFx1MjAxNCAke2JnLmFsaXZlID8gYCR7Ymcuc3RhdHVzfWAgOiBgZXhpdGVkIChjb2RlICR7YmcuZXhpdENvZGV9KWB9YDtcblx0XHRcdFx0XHRpZiAob3V0cHV0KSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9IGBcXG4ke291dHB1dH1gO1xuXHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9IGBcXG4obm8gbmV3IG91dHB1dCBzaW5jZSBsYXN0IGNoZWNrKWA7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0IH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb246IFwib3V0cHV0XCIsIHByb2Nlc3M6IGluZm8sIHN0cmVhbSwgdGFpbCB9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBcdTI1MDBcdTI1MDAgd2FpdF9mb3JfcmVhZHkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdFx0XHRcdGNhc2UgXCJ3YWl0X2Zvcl9yZWFkeVwiOiB7XG5cdFx0XHRcdFx0aWYgKCFwYXJhbXMuaWQpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiAnaWQnIGlzIHJlcXVpcmVkIGZvciB3YWl0X2Zvcl9yZWFkeVwiIH1dLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgYmcgPSBwcm9jZXNzZXMuZ2V0KHBhcmFtcy5pZCk7XG5cdFx0XHRcdFx0aWYgKCFiZykge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBFcnJvcjogTm8gcHJvY2VzcyBmb3VuZCB3aXRoIGlkICcke3BhcmFtcy5pZH0nYCB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdC8vIEFscmVhZHkgcmVhZHk/XG5cdFx0XHRcdFx0aWYgKGJnLnN0YXR1cyA9PT0gXCJyZWFkeVwiKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBkaWdlc3QgPSBnZW5lcmF0ZURpZ2VzdChiZywgdHJ1ZSk7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYFByb2Nlc3MgJHtiZy5pZH0gaXMgYWxyZWFkeSByZWFkeS5cXG4ke2Zvcm1hdERpZ2VzdFRleHQoYmcsIGRpZ2VzdCl9YCB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb246IFwid2FpdF9mb3JfcmVhZHlcIiwgcHJvY2VzczogZ2V0SW5mbyhiZyksIHJlYWR5OiB0cnVlIH0sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IHRpbWVvdXQgPSBwYXJhbXMudGltZW91dCB8fCBERUZBVUxUX1JFQURZX1RJTUVPVVQ7XG5cdFx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgd2FpdEZvclJlYWR5KGJnLCB0aW1lb3V0LCBzaWduYWwgPz8gdW5kZWZpbmVkKTtcblxuXHRcdFx0XHRcdGNvbnN0IGRpZ2VzdCA9IGdlbmVyYXRlRGlnZXN0KGJnLCB0cnVlKTtcblx0XHRcdFx0XHRsZXQgdGV4dDogc3RyaW5nO1xuXHRcdFx0XHRcdGlmIChyZXN1bHQucmVhZHkpIHtcblx0XHRcdFx0XHRcdHRleHQgPSBgXHUyNzEzIFByb2Nlc3MgJHtiZy5pZH0gaXMgcmVhZHk6ICR7cmVzdWx0LmRldGFpbH1cXG4ke2Zvcm1hdERpZ2VzdFRleHQoYmcsIGRpZ2VzdCl9YDtcblx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0dGV4dCA9IGBcdTI3MTcgUHJvY2VzcyAke2JnLmlkfSBub3QgcmVhZHk6ICR7cmVzdWx0LmRldGFpbH1cXG4ke2Zvcm1hdERpZ2VzdFRleHQoYmcsIGRpZ2VzdCl9YDtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbjogXCJ3YWl0X2Zvcl9yZWFkeVwiLCBwcm9jZXNzOiBnZXRJbmZvKGJnKSwgcmVhZHk6IHJlc3VsdC5yZWFkeSwgZGV0YWlsOiByZXN1bHQuZGV0YWlsIH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFx1MjUwMFx1MjUwMCBzZW5kIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHRcdFx0XHRjYXNlIFwic2VuZFwiOiB7XG5cdFx0XHRcdFx0aWYgKCFwYXJhbXMuaWQpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiAnaWQnIGlzIHJlcXVpcmVkIGZvciBzZW5kXCIgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0aWYgKHBhcmFtcy5pbnB1dCA9PT0gdW5kZWZpbmVkKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogXCJFcnJvcjogJ2lucHV0JyBpcyByZXF1aXJlZCBmb3Igc2VuZFwiIH1dLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgYmcgPSBwcm9jZXNzZXMuZ2V0KHBhcmFtcy5pZCk7XG5cdFx0XHRcdFx0aWYgKCFiZykge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBFcnJvcjogTm8gcHJvY2VzcyBmb3VuZCB3aXRoIGlkICcke3BhcmFtcy5pZH0nYCB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmICghYmcuYWxpdmUpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3I6IFByb2Nlc3MgJHtwYXJhbXMuaWR9IGhhcyBhbHJlYWR5IGV4aXRlZGAgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0YmcucHJvYy5zdGRpbj8ud3JpdGUocGFyYW1zLmlucHV0ICsgXCJcXG5cIik7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYFNlbnQgaW5wdXQgdG8gcHJvY2VzcyAke2JnLmlkfWAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uOiBcInNlbmRcIiwgcHJvY2VzczogZ2V0SW5mbyhiZykgfSxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yIHdyaXRpbmcgdG8gc3RkaW46ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBcdTI1MDBcdTI1MDAgc2VuZF9hbmRfd2FpdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdFx0Y2FzZSBcInNlbmRfYW5kX3dhaXRcIjoge1xuXHRcdFx0XHRcdGlmICghcGFyYW1zLmlkKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogXCJFcnJvcjogJ2lkJyBpcyByZXF1aXJlZCBmb3Igc2VuZF9hbmRfd2FpdFwiIH1dLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGlmIChwYXJhbXMuaW5wdXQgPT09IHVuZGVmaW5lZCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiRXJyb3I6ICdpbnB1dCcgaXMgcmVxdWlyZWQgZm9yIHNlbmRfYW5kX3dhaXRcIiB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAoIXBhcmFtcy53YWl0X3BhdHRlcm4pIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiAnd2FpdF9wYXR0ZXJuJyBpcyByZXF1aXJlZCBmb3Igc2VuZF9hbmRfd2FpdFwiIH1dLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgYmcgPSBwcm9jZXNzZXMuZ2V0KHBhcmFtcy5pZCk7XG5cdFx0XHRcdFx0aWYgKCFiZykge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBFcnJvcjogTm8gcHJvY2VzcyBmb3VuZCB3aXRoIGlkICcke3BhcmFtcy5pZH0nYCB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGlmICghYmcuYWxpdmUpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3I6IFByb2Nlc3MgJHtwYXJhbXMuaWR9IGhhcyBhbHJlYWR5IGV4aXRlZGAgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCB0aW1lb3V0ID0gcGFyYW1zLnRpbWVvdXQgfHwgMTAwMDA7XG5cdFx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgc2VuZEFuZFdhaXQoYmcsIHBhcmFtcy5pbnB1dCwgcGFyYW1zLndhaXRfcGF0dGVybiwgdGltZW91dCwgc2lnbmFsID8/IHVuZGVmaW5lZCk7XG5cblx0XHRcdFx0XHRsZXQgdGV4dDogc3RyaW5nO1xuXHRcdFx0XHRcdGlmIChyZXN1bHQubWF0Y2hlZCkge1xuXHRcdFx0XHRcdFx0dGV4dCA9IGBcdTI3MTMgUGF0dGVybiBtYXRjaGVkIGZvciBwcm9jZXNzICR7YmcuaWR9XFxuJHtyZXN1bHQub3V0cHV0fWA7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHRleHQgPSBgXHUyNzE3IFBhdHRlcm4gbm90IG1hdGNoZWQgKHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXR9bXMpXFxuJHtyZXN1bHQub3V0cHV0fWA7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0IH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb246IFwic2VuZF9hbmRfd2FpdFwiLCBwcm9jZXNzOiBnZXRJbmZvKGJnKSwgbWF0Y2hlZDogcmVzdWx0Lm1hdGNoZWQgfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gXHUyNTAwXHUyNTAwIHJ1biBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdFx0Y2FzZSBcInJ1blwiOiB7XG5cdFx0XHRcdFx0aWYgKCFwYXJhbXMuaWQpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiAnaWQnIGlzIHJlcXVpcmVkIGZvciBydW5cIiB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRpZiAoIXBhcmFtcy5jb21tYW5kKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogXCJFcnJvcjogJ2NvbW1hbmQnIGlzIHJlcXVpcmVkIGZvciBydW5cIiB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IGJnID0gcHJvY2Vzc2VzLmdldChwYXJhbXMuaWQpO1xuXHRcdFx0XHRcdGlmICghYmcpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3I6IE5vIHByb2Nlc3MgZm91bmQgd2l0aCBpZCAnJHtwYXJhbXMuaWR9J2AgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRpZiAoIWJnLmFsaXZlKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yOiBQcm9jZXNzICR7cGFyYW1zLmlkfSBoYXMgYWxyZWFkeSBleGl0ZWRgIH1dLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgcnVuVGltZW91dCA9IHBhcmFtcy50aW1lb3V0IHx8IDEyMDAwMDtcblx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBydW5PblNlc3Npb24oYmcsIHBhcmFtcy5jb21tYW5kLCBydW5UaW1lb3V0LCBzaWduYWwgPz8gdW5kZWZpbmVkKTtcblxuXHRcdFx0XHRcdGxldCB0ZXh0OiBzdHJpbmc7XG5cdFx0XHRcdFx0aWYgKHJlc3VsdC50aW1lZE91dCkge1xuXHRcdFx0XHRcdFx0dGV4dCA9IGBDb21tYW5kIHRpbWVkIG91dCBhZnRlciAke3J1blRpbWVvdXR9bXNcXG5PdXRwdXQ6XFxuJHtyZXN1bHQub3V0cHV0fWA7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHRleHQgPSBgRXhpdCBjb2RlOiAke3Jlc3VsdC5leGl0Q29kZX1cXG4ke3Jlc3VsdC5vdXRwdXR9YDtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbjogXCJydW5cIiwgcHJvY2VzczogZ2V0SW5mbyhiZyksIGV4aXRDb2RlOiByZXN1bHQuZXhpdENvZGUsIHRpbWVkT3V0OiByZXN1bHQudGltZWRPdXQgfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gXHUyNTAwXHUyNTAwIGVudiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdFx0Y2FzZSBcImVudlwiOiB7XG5cdFx0XHRcdFx0aWYgKCFwYXJhbXMuaWQpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiAnaWQnIGlzIHJlcXVpcmVkIGZvciBlbnZcIiB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IGJnID0gcHJvY2Vzc2VzLmdldChwYXJhbXMuaWQpO1xuXHRcdFx0XHRcdGlmICghYmcpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3I6IE5vIHByb2Nlc3MgZm91bmQgd2l0aCBpZCAnJHtwYXJhbXMuaWR9J2AgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRpZiAoIWJnLmFsaXZlKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yOiBQcm9jZXNzICR7cGFyYW1zLmlkfSBoYXMgYWxyZWFkeSBleGl0ZWRgIH1dLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgdGltZW91dCA9IHBhcmFtcy50aW1lb3V0IHx8IDUwMDA7XG5cdFx0XHRcdFx0Y29uc3QgZW52UmVzdWx0ID0gYXdhaXQgcXVlcnlTaGVsbEVudihiZywgdGltZW91dCwgc2lnbmFsID8/IHVuZGVmaW5lZCk7XG5cblx0XHRcdFx0XHRpZiAoIWVudlJlc3VsdCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBGYWlsZWQgdG8gcXVlcnkgZW52aXJvbm1lbnQgZm9yIHByb2Nlc3MgJHtiZy5pZH0gKHRpbWVkIG91dCBvciBwcm9jZXNzIGRpZWQpYCB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGxldCB0ZXh0ID0gYFNoZWxsIGVudmlyb25tZW50IGZvciAke2JnLmlkfSAoJHtiZy5sYWJlbH0pOlxcbmA7XG5cdFx0XHRcdFx0dGV4dCArPSBgICBjd2Q6ICR7dG9Qb3NpeFBhdGgoZW52UmVzdWx0LmN3ZCl9XFxuYDtcblx0XHRcdFx0XHR0ZXh0ICs9IGAgIHNoZWxsOiAke2VudlJlc3VsdC5zaGVsbH1cXG5gO1xuXG5cdFx0XHRcdFx0Y29uc3QgZW52RW50cmllcyA9IE9iamVjdC5lbnRyaWVzKGVudlJlc3VsdC5lbnYpO1xuXHRcdFx0XHRcdGlmIChlbnZFbnRyaWVzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRcdHRleHQgKz0gYCAgZW52aXJvbm1lbnQ6XFxuYDtcblx0XHRcdFx0XHRcdGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGVudkVudHJpZXMpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgZGlzcGxheVZhbHVlID0gdmFsdWUubGVuZ3RoID4gMTAwID8gdmFsdWUuc2xpY2UoMCwgOTcpICsgXCIuLi5cIiA6IHZhbHVlO1xuXHRcdFx0XHRcdFx0XHR0ZXh0ICs9IGAgICAgJHtrZXl9PSR7ZGlzcGxheVZhbHVlfVxcbmA7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiB0ZXh0LnRyaW1FbmQoKSB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uOiBcImVudlwiLCBwcm9jZXNzOiBnZXRJbmZvKGJnKSwgZW52OiBlbnZSZXN1bHQgfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gXHUyNTAwXHUyNTAwIHNpZ25hbCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblx0XHRcdFx0Y2FzZSBcInNpZ25hbFwiOiB7XG5cdFx0XHRcdFx0aWYgKCFwYXJhbXMuaWQpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIkVycm9yOiAnaWQnIGlzIHJlcXVpcmVkIGZvciBzaWduYWxcIiB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IGJnID0gcHJvY2Vzc2VzLmdldChwYXJhbXMuaWQpO1xuXHRcdFx0XHRcdGlmICghYmcpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3I6IE5vIHByb2Nlc3MgZm91bmQgd2l0aCBpZCAnJHtwYXJhbXMuaWR9J2AgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBzaWcgPSAocGFyYW1zLnNpZ25hbF9uYW1lIHx8IFwiU0lHSU5UXCIpIGFzIE5vZGVKUy5TaWduYWxzO1xuXHRcdFx0XHRcdGNvbnN0IHNlbnQgPSBraWxsUHJvY2VzcyhwYXJhbXMuaWQsIHNpZyk7XG5cblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IHNlbnQgPyBgU2VudCAke3NpZ30gdG8gcHJvY2VzcyAke2JnLmlkfSAoJHtiZy5sYWJlbH0pYCA6IGBGYWlsZWQgdG8gc2VuZCAke3NpZ30gdG8gcHJvY2VzcyAke2JnLmlkfWAgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbjogXCJzaWduYWxcIiwgcHJvY2VzczogZ2V0SW5mbyhiZyksIHNpZ25hbDogc2lnIH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFx1MjUwMFx1MjUwMCBsaXN0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHRcdFx0XHRjYXNlIFwibGlzdFwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgYWxsID0gQXJyYXkuZnJvbShwcm9jZXNzZXMudmFsdWVzKCkpLm1hcChnZXRJbmZvKTtcblxuXHRcdFx0XHRcdGlmIChhbGwubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogXCJObyBiYWNrZ3JvdW5kIHByb2Nlc3Nlcy5cIiB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb246IFwibGlzdFwiLCBwcm9jZXNzZXM6IFtdIH0sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gYWxsLm1hcChwID0+IHtcblx0XHRcdFx0XHRcdGNvbnN0IHN0YXR1cyA9IHAuYWxpdmVcblx0XHRcdFx0XHRcdFx0PyAocC5zdGF0dXMgPT09IFwicmVhZHlcIiA/IFwiXHUyNzEzIHJlYWR5XCIgOiBwLnN0YXR1cyA9PT0gXCJlcnJvclwiID8gXCJcdTI3MTcgZXJyb3JcIiA6IFwiXHUyMkVGIHN0YXJ0aW5nXCIpXG5cdFx0XHRcdFx0XHRcdDogYFx1MjVDQiAke3Auc3RhdHVzfSAoY29kZSAke3AuZXhpdENvZGV9KWA7XG5cdFx0XHRcdFx0XHRjb25zdCBwb3J0SW5mbyA9IHAucG9ydHMubGVuZ3RoID4gMCA/IGAgOiR7cC5wb3J0cy5qb2luKFwiLFwiKX1gIDogXCJcIjtcblx0XHRcdFx0XHRcdGNvbnN0IHVybEluZm8gPSBwLnVybHMubGVuZ3RoID4gMCA/IGAgJHtwLnVybHNbMF19YCA6IFwiXCI7XG5cdFx0XHRcdFx0XHRjb25zdCBncm91cEluZm8gPSBwLmdyb3VwID8gYCBbJHtwLmdyb3VwfV1gIDogXCJcIjtcblx0XHRcdFx0XHRcdHJldHVybiBgJHtwLmlkfSAgJHtzdGF0dXN9ICAke3AudXB0aW1lfSAgJHtwLmxhYmVsfSAgWyR7cC5wcm9jZXNzVHlwZX1dJHtwb3J0SW5mb30ke3VybEluZm99JHtncm91cEluZm99YDtcblx0XHRcdFx0XHR9KTtcblxuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEJhY2tncm91bmQgcHJvY2Vzc2VzICgke2FsbC5sZW5ndGh9KTpcXG4ke2xpbmVzLmpvaW4oXCJcXG5cIil9YCB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uOiBcImxpc3RcIiwgcHJvY2Vzc2VzOiBhbGwgfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gXHUyNTAwXHUyNTAwIGtpbGwgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdFx0XHRcdGNhc2UgXCJraWxsXCI6IHtcblx0XHRcdFx0XHRpZiAoIXBhcmFtcy5pZCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiRXJyb3I6ICdpZCcgaXMgcmVxdWlyZWQgZm9yIGtpbGxcIiB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IGJnID0gcHJvY2Vzc2VzLmdldChwYXJhbXMuaWQpO1xuXHRcdFx0XHRcdGlmICghYmcpIHtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgRXJyb3I6IE5vIHByb2Nlc3MgZm91bmQgd2l0aCBpZCAnJHtwYXJhbXMuaWR9J2AgfV0sXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBraWxsZWQgPSBraWxsUHJvY2VzcyhwYXJhbXMuaWQsIFwiU0lHVEVSTVwiKTtcblx0XHRcdFx0XHRhd2FpdCBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgMzAwKSk7XG5cdFx0XHRcdFx0aWYgKGJnLmFsaXZlKSB7XG5cdFx0XHRcdFx0XHRraWxsUHJvY2VzcyhwYXJhbXMuaWQsIFwiU0lHS0lMTFwiKTtcblx0XHRcdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCAyMDApKTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBpbmZvID0gZ2V0SW5mbyhiZyk7XG5cdFx0XHRcdFx0aWYgKCFiZy5hbGl2ZSkgcHJvY2Vzc2VzLmRlbGV0ZShwYXJhbXMuaWQpO1xuXG5cdFx0XHRcdFx0Ly8gVXBkYXRlIG1hbmlmZXN0XG5cdFx0XHRcdFx0cGVyc2lzdE1hbmlmZXN0KGN0eC5jd2QpO1xuXG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBraWxsZWQgPyBgS2lsbGVkIHByb2Nlc3MgJHtiZy5pZH0gKCR7YmcubGFiZWx9KWAgOiBgRmFpbGVkIHRvIGtpbGwgcHJvY2VzcyAke2JnLmlkfWAgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbjogXCJraWxsXCIsIHByb2Nlc3M6IGluZm8gfSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gXHUyNTAwXHUyNTAwIHJlc3RhcnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cdFx0XHRcdGNhc2UgXCJyZXN0YXJ0XCI6IHtcblx0XHRcdFx0XHRpZiAoIXBhcmFtcy5pZCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiRXJyb3I6ICdpZCcgaXMgcmVxdWlyZWQgZm9yIHJlc3RhcnRcIiB9XSxcblx0XHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSwgZGV0YWlsczogdW5kZWZpbmVkIGFzIHVua25vd24sXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IG5ld0JnID0gYXdhaXQgcmVzdGFydFByb2Nlc3MocGFyYW1zLmlkKTtcblx0XHRcdFx0XHRpZiAoIW5ld0JnKSB7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYEVycm9yOiBObyBwcm9jZXNzIGZvdW5kIHdpdGggaWQgJyR7cGFyYW1zLmlkfSdgIH1dLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLCBkZXRhaWxzOiB1bmRlZmluZWQgYXMgdW5rbm93bixcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Ly8gR2l2ZSBpdCBhIG1vbWVudFxuXHRcdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCA1MDApKTtcblx0XHRcdFx0XHRwZXJzaXN0TWFuaWZlc3QoY3R4LmN3ZCk7XG5cblx0XHRcdFx0XHRjb25zdCBpbmZvID0gZ2V0SW5mbyhuZXdCZyk7XG5cdFx0XHRcdFx0bGV0IHRleHQgPSBgUmVzdGFydGVkIHByb2Nlc3MgKHJlc3RhcnQgIyR7bmV3QmcucmVzdGFydENvdW50fSlcXG5gO1xuXHRcdFx0XHRcdHRleHQgKz0gYCAgbmV3IGlkOiAke25ld0JnLmlkfVxcbmA7XG5cdFx0XHRcdFx0dGV4dCArPSBgICBsYWJlbDogJHtuZXdCZy5sYWJlbH1cXG5gO1xuXHRcdFx0XHRcdHRleHQgKz0gYCAgdHlwZTogJHtuZXdCZy5wcm9jZXNzVHlwZX1cXG5gO1xuXHRcdFx0XHRcdHRleHQgKz0gYCAgc3RhdHVzOiAke25ld0JnLnN0YXR1c31cXG5gO1xuXHRcdFx0XHRcdHRleHQgKz0gYCAgY29tbWFuZDogJHtuZXdCZy5jb21tYW5kfWA7XG5cblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiB7IGFjdGlvbjogXCJyZXN0YXJ0XCIsIHByb2Nlc3M6IGluZm8sIHByZXZpb3VzSWQ6IHBhcmFtcy5pZCB9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBcdTI1MDBcdTI1MDAgZ3JvdXBfc3RhdHVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXHRcdFx0XHRjYXNlIFwiZ3JvdXBfc3RhdHVzXCI6IHtcblx0XHRcdFx0XHRpZiAoIXBhcmFtcy5ncm91cCkge1xuXHRcdFx0XHRcdFx0Ly8gTGlzdCBhbGwgZ3JvdXBzXG5cdFx0XHRcdFx0XHRjb25zdCBncm91cHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRcdFx0XHRcdGZvciAoY29uc3QgcCBvZiBwcm9jZXNzZXMudmFsdWVzKCkpIHtcblx0XHRcdFx0XHRcdFx0aWYgKHAuZ3JvdXApIGdyb3Vwcy5hZGQocC5ncm91cCk7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGlmIChncm91cHMuc2l6ZSA9PT0gMCkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBcIk5vIHByb2Nlc3MgZ3JvdXBzIGRlZmluZWQuXCIgfV0sXG5cdFx0XHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb246IFwiZ3JvdXBfc3RhdHVzXCIsIGdyb3VwczogW10gfSxcblx0XHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Y29uc3Qgc3RhdHVzZXMgPSBBcnJheS5mcm9tKGdyb3VwcykubWFwKGcgPT4ge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBncyA9IGdldEdyb3VwU3RhdHVzKGcpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBpY29uID0gZ3MuaGVhbHRoeSA/IFwiXHUyNzEzXCIgOiBcIlx1MjcxN1wiO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBwcm9jcyA9IGdzLnByb2Nlc3Nlcy5tYXAocCA9PiBgJHtwLmlkfSAoJHtwLnN0YXR1c30pYCkuam9pbihcIiwgXCIpO1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4gYCR7aWNvbn0gJHtnfTogJHtwcm9jc31gO1xuXHRcdFx0XHRcdFx0fSk7XG5cblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgUHJvY2VzcyBncm91cHM6XFxuJHtzdGF0dXNlcy5qb2luKFwiXFxuXCIpfWAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IHsgYWN0aW9uOiBcImdyb3VwX3N0YXR1c1wiLCBncm91cHM6IEFycmF5LmZyb20oZ3JvdXBzKSB9LFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRjb25zdCBncyA9IGdldEdyb3VwU3RhdHVzKHBhcmFtcy5ncm91cCk7XG5cdFx0XHRcdFx0Y29uc3QgaWNvbiA9IGdzLmhlYWx0aHkgPyBcIlx1MjcxM1wiIDogXCJcdTI3MTdcIjtcblx0XHRcdFx0XHRsZXQgdGV4dCA9IGAke2ljb259IEdyb3VwICcke3BhcmFtcy5ncm91cH0nIFx1MjAxNCAke2dzLmhlYWx0aHkgPyBcImhlYWx0aHlcIiA6IFwidW5oZWFsdGh5XCJ9XFxuYDtcblx0XHRcdFx0XHRmb3IgKGNvbnN0IHAgb2YgZ3MucHJvY2Vzc2VzKSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9IGAgICR7cC5pZH06ICR7cC5sYWJlbH0gXHUyMDE0ICR7cC5zdGF0dXN9JHtwLmFsaXZlID8gXCJcIiA6IFwiIChkZWFkKVwifVxcbmA7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0IH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogeyBhY3Rpb246IFwiZ3JvdXBfc3RhdHVzXCIsIGdyb3VwU3RhdHVzOiBncyB9LFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRkZWZhdWx0OlxuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYFVua25vd24gYWN0aW9uOiAke3BhcmFtcy5hY3Rpb259YCB9XSxcblx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsIGRldGFpbHM6IHVuZGVmaW5lZCBhcyB1bmtub3duLFxuXHRcdFx0XHRcdH07XG5cdFx0XHR9XG5cdFx0fSxcblxuXHRcdC8vIFx1MjUwMFx1MjUwMCBSZW5kZXJpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblx0XHRyZW5kZXJDYWxsKGFyZ3MsIHRoZW1lKSB7XG5cdFx0XHRsZXQgdGV4dCA9IHRoZW1lLmZnKFwidG9vbFRpdGxlXCIsIHRoZW1lLmJvbGQoXCJiZ19zaGVsbCBcIikpO1xuXHRcdFx0dGV4dCArPSB0aGVtZS5mZyhcImFjY2VudFwiLCBhcmdzLmFjdGlvbik7XG5cdFx0XHRpZiAoYXJncy5jb21tYW5kKSB0ZXh0ICs9IFwiIFwiICsgdGhlbWUuZmcoXCJtdXRlZFwiLCBgJCAke2FyZ3MuY29tbWFuZH1gKTtcblx0XHRcdGlmIChhcmdzLmlkKSB0ZXh0ICs9IFwiIFwiICsgdGhlbWUuZmcoXCJkaW1cIiwgYFske2FyZ3MuaWR9XWApO1xuXHRcdFx0aWYgKGFyZ3MubGFiZWwpIHRleHQgKz0gXCIgXCIgKyB0aGVtZS5mZyhcImRpbVwiLCBgKCR7YXJncy5sYWJlbH0pYCk7XG5cdFx0XHRpZiAoYXJncy50eXBlKSB0ZXh0ICs9IFwiIFwiICsgdGhlbWUuZmcoXCJkaW1cIiwgYHR5cGU6JHthcmdzLnR5cGV9YCk7XG5cdFx0XHRpZiAoYXJncy5yZWFkeV9wb3J0KSB0ZXh0ICs9IFwiIFwiICsgdGhlbWUuZmcoXCJkaW1cIiwgYHBvcnQ6JHthcmdzLnJlYWR5X3BvcnR9YCk7XG5cdFx0XHRpZiAoYXJncy5ncm91cCkgdGV4dCArPSBcIiBcIiArIHRoZW1lLmZnKFwiZGltXCIsIGBncm91cDoke2FyZ3MuZ3JvdXB9YCk7XG5cdFx0XHRyZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG5cdFx0fSxcblxuXHRcdHJlbmRlclJlc3VsdChyZXN1bHQsIHsgZXhwYW5kZWQgfSwgdGhlbWUpIHtcblx0XHRcdGNvbnN0IGRldGFpbHMgPSByZXN1bHQuZGV0YWlscyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcblx0XHRcdGlmICghZGV0YWlscykge1xuXHRcdFx0XHRjb25zdCB0ZXh0ID0gcmVzdWx0LmNvbnRlbnRbMF07XG5cdFx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0Py50eXBlID09PSBcInRleHRcIiA/IHRleHQudGV4dCA6IFwiXCIsIDAsIDApO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBhY3Rpb24gPSBkZXRhaWxzLmFjdGlvbiBhcyBzdHJpbmc7XG5cblx0XHRcdGlmICgocmVzdWx0IGFzIGFueSkuaXNFcnJvcikge1xuXHRcdFx0XHRjb25zdCB0ZXh0ID0gcmVzdWx0LmNvbnRlbnRbMF07XG5cdFx0XHRcdHJldHVybiBuZXcgVGV4dChcblx0XHRcdFx0XHR0aGVtZS5mZyhcImVycm9yXCIsIHRleHQ/LnR5cGUgPT09IFwidGV4dFwiID8gdGV4dC50ZXh0IDogXCJFcnJvclwiKSxcblx0XHRcdFx0XHQwLCAwLFxuXHRcdFx0XHQpO1xuXHRcdFx0fVxuXG5cdFx0XHRzd2l0Y2ggKGFjdGlvbikge1xuXHRcdFx0XHRjYXNlIFwic3RhcnRcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHByb2MgPSBkZXRhaWxzLnByb2Nlc3MgYXMgQmdQcm9jZXNzSW5mbztcblx0XHRcdFx0XHRsZXQgdGV4dCA9IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlx1MjVCOCBTdGFydGVkIFwiKTtcblx0XHRcdFx0XHR0ZXh0ICs9IHRoZW1lLmZnKFwiYWNjZW50XCIsIHByb2MuaWQpO1xuXHRcdFx0XHRcdHRleHQgKz0gXCIgXCIgKyB0aGVtZS5mZyhcIm11dGVkXCIsIHByb2MubGFiZWwpO1xuXHRcdFx0XHRcdHRleHQgKz0gXCIgXCIgKyB0aGVtZS5mZyhcImRpbVwiLCBgWyR7cHJvYy5wcm9jZXNzVHlwZX1dYCk7XG5cdFx0XHRcdFx0aWYgKHByb2MucG9ydHMubGVuZ3RoID4gMCkgdGV4dCArPSBcIiBcIiArIHRoZW1lLmZnKFwiZGltXCIsIGA6JHtwcm9jLnBvcnRzLmpvaW4oXCIsXCIpfWApO1xuXHRcdFx0XHRcdGlmICghcHJvYy5hbGl2ZSkge1xuXHRcdFx0XHRcdFx0dGV4dCArPSBcIiBcIiArIHRoZW1lLmZnKFwiZXJyb3JcIiwgYChleGl0ZWQ6ICR7cHJvYy5leGl0Q29kZX0pYCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNhc2UgXCJkaWdlc3RcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHByb2MgPSBkZXRhaWxzLnByb2Nlc3MgYXMgQmdQcm9jZXNzSW5mbyB8IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRpZiAocHJvYykge1xuXHRcdFx0XHRcdFx0Y29uc3Qgc3RhdHVzSWNvbiA9IHByb2Muc3RhdHVzID09PSBcInJlYWR5XCIgPyB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJcdTI3MTNcIilcblx0XHRcdFx0XHRcdFx0OiBwcm9jLnN0YXR1cyA9PT0gXCJlcnJvclwiID8gdGhlbWUuZmcoXCJlcnJvclwiLCBcIlx1MjcxN1wiKVxuXHRcdFx0XHRcdFx0XHQ6IHRoZW1lLmZnKFwid2FybmluZ1wiLCBcIlx1MjJFRlwiKTtcblx0XHRcdFx0XHRcdGxldCB0ZXh0ID0gYCR7c3RhdHVzSWNvbn0gJHt0aGVtZS5mZyhcImFjY2VudFwiLCBwcm9jLmlkKX0gJHt0aGVtZS5mZyhcIm11dGVkXCIsIHByb2MubGFiZWwpfWA7XG5cdFx0XHRcdFx0XHRpZiAoZXhwYW5kZWQpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgcmF3VGV4dCA9IHJlc3VsdC5jb250ZW50WzBdO1xuXHRcdFx0XHRcdFx0XHRpZiAocmF3VGV4dD8udHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBsaW5lcyA9IHJhd1RleHQudGV4dC5zcGxpdChcIlxcblwiKS5zbGljZSgxKTtcblx0XHRcdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMuc2xpY2UoMCwgMjApKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHR0ZXh0ICs9IFwiXFxuICBcIiArIHRoZW1lLmZnKFwiZGltXCIsIGxpbmUpO1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRyZXR1cm4gbmV3IFRleHQodGhlbWUuZmcoXCJkaW1cIiwgYCR7ZGV0YWlscy5jb3VudCA/PyAwfSBwcm9jZXNzKGVzKWApLCAwLCAwKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNhc2UgXCJoaWdobGlnaHRzXCI6IHtcblx0XHRcdFx0XHRjb25zdCBwcm9jID0gZGV0YWlscy5wcm9jZXNzIGFzIEJnUHJvY2Vzc0luZm87XG5cdFx0XHRcdFx0Y29uc3QgbGluZUNvdW50ID0gZGV0YWlscy5saW5lQ291bnQgYXMgbnVtYmVyO1xuXHRcdFx0XHRcdGxldCB0ZXh0ID0gdGhlbWUuZmcoXCJhY2NlbnRcIiwgcHJvYy5pZCkgKyBcIiBcIiArIHRoZW1lLmZnKFwiZGltXCIsIGAke2xpbmVDb3VudH0gaGlnaGxpZ2h0c2ApO1xuXHRcdFx0XHRcdGlmIChleHBhbmRlZCkge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmF3VGV4dCA9IHJlc3VsdC5jb250ZW50WzBdO1xuXHRcdFx0XHRcdFx0aWYgKHJhd1RleHQ/LnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gcmF3VGV4dC50ZXh0LnNwbGl0KFwiXFxuXCIpLnNsaWNlKDEpO1xuXHRcdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMuc2xpY2UoMCwgMjApKSB7XG5cdFx0XHRcdFx0XHRcdFx0dGV4dCArPSBcIlxcbiAgXCIgKyB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgbGluZSk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcIm91dHB1dFwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgcHJvYyA9IGRldGFpbHMucHJvY2VzcyBhcyBCZ1Byb2Nlc3NJbmZvO1xuXHRcdFx0XHRcdGNvbnN0IHN0YXR1c0ljb24gPSBwcm9jLmFsaXZlXG5cdFx0XHRcdFx0XHQ/IChwcm9jLnN0YXR1cyA9PT0gXCJyZWFkeVwiID8gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiXHUyNUNGXCIpIDogcHJvYy5zdGF0dXMgPT09IFwiZXJyb3JcIiA/IHRoZW1lLmZnKFwiZXJyb3JcIiwgXCJcdTI1Q0ZcIikgOiB0aGVtZS5mZyhcIndhcm5pbmdcIiwgXCJcdTI1Q0ZcIikpXG5cdFx0XHRcdFx0XHQ6IHRoZW1lLmZnKFwiZXJyb3JcIiwgXCJcdTI1Q0JcIik7XG5cdFx0XHRcdFx0bGV0IHRleHQgPSBgJHtzdGF0dXNJY29ufSAke3RoZW1lLmZnKFwiYWNjZW50XCIsIHByb2MuaWQpfSAke3RoZW1lLmZnKFwibXV0ZWRcIiwgcHJvYy5sYWJlbCl9YDtcblxuXHRcdFx0XHRcdGlmIChleHBhbmRlZCkge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmF3VGV4dCA9IHJlc3VsdC5jb250ZW50WzBdO1xuXHRcdFx0XHRcdFx0aWYgKHJhd1RleHQ/LnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gcmF3VGV4dC50ZXh0LnNwbGl0KFwiXFxuXCIpLnNsaWNlKDEpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBzaG93ID0gbGluZXMuc2xpY2UoMCwgMzApO1xuXHRcdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGxpbmUgb2Ygc2hvdykge1xuXHRcdFx0XHRcdFx0XHRcdHRleHQgKz0gXCJcXG4gIFwiICsgdGhlbWUuZmcoXCJ0b29sT3V0cHV0XCIsIGxpbmUpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdGlmIChsaW5lcy5sZW5ndGggPiAzMCkge1xuXHRcdFx0XHRcdFx0XHRcdHRleHQgKz0gYFxcbiAgJHt0aGVtZS5mZyhcImRpbVwiLCBgLi4uICR7bGluZXMubGVuZ3RoIC0gMzB9IG1vcmUgbGluZXNgKX1gO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHRleHQgKz0gXCIgXCIgKyB0aGVtZS5mZyhcImRpbVwiLCBgKCR7cHJvYy5zdGRvdXRMaW5lc30gc3Rkb3V0LCAke3Byb2Muc3RkZXJyTGluZXN9IHN0ZGVyciBsaW5lcylgKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcIndhaXRfZm9yX3JlYWR5XCI6IHtcblx0XHRcdFx0XHRjb25zdCBwcm9jID0gZGV0YWlscy5wcm9jZXNzIGFzIEJnUHJvY2Vzc0luZm87XG5cdFx0XHRcdFx0Y29uc3QgcmVhZHkgPSBkZXRhaWxzLnJlYWR5IGFzIGJvb2xlYW47XG5cdFx0XHRcdFx0aWYgKHJlYWR5KSB7XG5cdFx0XHRcdFx0XHRsZXQgdGV4dCA9IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlx1MjcxMyBSZWFkeSBcIikgKyB0aGVtZS5mZyhcImFjY2VudFwiLCBwcm9jLmlkKTtcblx0XHRcdFx0XHRcdGlmIChwcm9jLnBvcnRzLmxlbmd0aCA+IDApIHRleHQgKz0gXCIgXCIgKyB0aGVtZS5mZyhcImRpbVwiLCBgOiR7cHJvYy5wb3J0cy5qb2luKFwiLFwiKX1gKTtcblx0XHRcdFx0XHRcdGlmIChwcm9jLnVybHMubGVuZ3RoID4gMCkgdGV4dCArPSBcIiBcIiArIHRoZW1lLmZnKFwiZGltXCIsIHByb2MudXJsc1swXSk7XG5cdFx0XHRcdFx0XHRyZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHJldHVybiBuZXcgVGV4dChcblx0XHRcdFx0XHRcdFx0dGhlbWUuZmcoXCJlcnJvclwiLCBcIlx1MjcxNyBOb3QgcmVhZHkgXCIpICsgdGhlbWUuZmcoXCJhY2NlbnRcIiwgcHJvYy5pZCkgKyBcIiBcIiArIHRoZW1lLmZnKFwiZGltXCIsIFN0cmluZyhkZXRhaWxzLmRldGFpbCkpLFxuXHRcdFx0XHRcdFx0XHQwLCAwLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwic2VuZFwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgcHJvYyA9IGRldGFpbHMucHJvY2VzcyBhcyBCZ1Byb2Nlc3NJbmZvO1xuXHRcdFx0XHRcdHJldHVybiBuZXcgVGV4dChcblx0XHRcdFx0XHRcdHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlx1MjE5MiBcIikgKyB0aGVtZS5mZyhcIm11dGVkXCIsIGBzdGRpbiBcdTIxOTIgJHtwcm9jLmlkfWApLFxuXHRcdFx0XHRcdFx0MCwgMCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcInNlbmRfYW5kX3dhaXRcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHByb2MgPSBkZXRhaWxzLnByb2Nlc3MgYXMgQmdQcm9jZXNzSW5mbztcblx0XHRcdFx0XHRjb25zdCBtYXRjaGVkID0gZGV0YWlscy5tYXRjaGVkIGFzIGJvb2xlYW47XG5cdFx0XHRcdFx0aWYgKG1hdGNoZWQpIHtcblx0XHRcdFx0XHRcdHJldHVybiBuZXcgVGV4dChcblx0XHRcdFx0XHRcdFx0dGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiXHUyNzEzIFwiKSArIHRoZW1lLmZnKFwibXV0ZWRcIiwgYFBhdHRlcm4gbWF0Y2hlZCBcdTIwMTQgJHtwcm9jLmlkfWApLFxuXHRcdFx0XHRcdFx0XHQwLCAwLFxuXHRcdFx0XHRcdFx0KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KFxuXHRcdFx0XHRcdFx0dGhlbWUuZmcoXCJ3YXJuaW5nXCIsIFwiXHUyNzE3IFwiKSArIHRoZW1lLmZnKFwibXV0ZWRcIiwgYFRpbWVkIG91dCBcdTIwMTQgJHtwcm9jLmlkfWApLFxuXHRcdFx0XHRcdFx0MCwgMCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcInJ1blwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgcHJvYyA9IGRldGFpbHMucHJvY2VzcyBhcyBCZ1Byb2Nlc3NJbmZvO1xuXHRcdFx0XHRcdGNvbnN0IGV4aXRDb2RlID0gZGV0YWlscy5leGl0Q29kZSBhcyBudW1iZXI7XG5cdFx0XHRcdFx0Y29uc3QgdGltZWRPdXQgPSBkZXRhaWxzLnRpbWVkT3V0IGFzIGJvb2xlYW47XG5cdFx0XHRcdFx0aWYgKHRpbWVkT3V0KSB7XG5cdFx0XHRcdFx0XHRsZXQgdGV4dCA9IHRoZW1lLmZnKFwid2FybmluZ1wiLCBcIlx1MjNGMSBUaW1lZCBvdXQgXCIpICsgdGhlbWUuZmcoXCJhY2NlbnRcIiwgcHJvYy5pZCk7XG5cdFx0XHRcdFx0XHRpZiAoZXhwYW5kZWQpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgcmF3VGV4dCA9IHJlc3VsdC5jb250ZW50WzBdO1xuXHRcdFx0XHRcdFx0XHRpZiAocmF3VGV4dD8udHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBsaW5lcyA9IHJhd1RleHQudGV4dC5zcGxpdChcIlxcblwiKS5zbGljZSgxKTtcblx0XHRcdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMuc2xpY2UoMCwgMzApKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHR0ZXh0ICs9IFwiXFxuICBcIiArIHRoZW1lLmZnKFwidG9vbE91dHB1dFwiLCBsaW5lKTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0Y29uc3QgaWNvbiA9IGV4aXRDb2RlID09PSAwID8gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiXHUyNzEzXCIpIDogdGhlbWUuZmcoXCJlcnJvclwiLCBcIlx1MjcxN1wiKTtcblx0XHRcdFx0XHRsZXQgdGV4dCA9IGAke2ljb259ICR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgcHJvYy5pZCl9ICR7dGhlbWUuZmcoXCJkaW1cIiwgYGV4aXQ6JHtleGl0Q29kZX1gKX1gO1xuXHRcdFx0XHRcdGlmIChleHBhbmRlZCkge1xuXHRcdFx0XHRcdFx0Y29uc3QgcmF3VGV4dCA9IHJlc3VsdC5jb250ZW50WzBdO1xuXHRcdFx0XHRcdFx0aWYgKHJhd1RleHQ/LnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGxpbmVzID0gcmF3VGV4dC50ZXh0LnNwbGl0KFwiXFxuXCIpLnNsaWNlKDEpO1xuXHRcdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMuc2xpY2UoMCwgMzApKSB7XG5cdFx0XHRcdFx0XHRcdFx0dGV4dCArPSBcIlxcbiAgXCIgKyB0aGVtZS5mZyhcInRvb2xPdXRwdXRcIiwgbGluZSk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0aWYgKGxpbmVzLmxlbmd0aCA+IDMwKSB7XG5cdFx0XHRcdFx0XHRcdFx0dGV4dCArPSBgXFxuICAke3RoZW1lLmZnKFwiZGltXCIsIGAuLi4gJHtsaW5lcy5sZW5ndGggLSAzMH0gbW9yZSBsaW5lc2ApfWA7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcInNpZ25hbFwiOiB7XG5cdFx0XHRcdFx0Y29uc3Qgc2lnID0gZGV0YWlscy5zaWduYWwgYXMgc3RyaW5nO1xuXHRcdFx0XHRcdGNvbnN0IHByb2MgPSBkZXRhaWxzLnByb2Nlc3MgYXMgQmdQcm9jZXNzSW5mbztcblx0XHRcdFx0XHRyZXR1cm4gbmV3IFRleHQoXG5cdFx0XHRcdFx0XHR0aGVtZS5mZyhcIndhcm5pbmdcIiwgYCR7c2lnfSBgKSArIHRoZW1lLmZnKFwibXV0ZWRcIiwgYFx1MjE5MiAke3Byb2MuaWR9YCksXG5cdFx0XHRcdFx0XHQwLCAwLFxuXHRcdFx0XHRcdCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwibGlzdFwiOiB7XG5cdFx0XHRcdFx0Y29uc3QgcHJvY3MgPSBkZXRhaWxzLnByb2Nlc3NlcyBhcyBCZ1Byb2Nlc3NJbmZvW107XG5cdFx0XHRcdFx0aWYgKHByb2NzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRoZW1lLmZnKFwiZGltXCIsIFwiTm8gYmFja2dyb3VuZCBwcm9jZXNzZXNcIiksIDAsIDApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRsZXQgdGV4dCA9IHRoZW1lLmZnKFwibXV0ZWRcIiwgYCR7cHJvY3MubGVuZ3RofSBiYWNrZ3JvdW5kIHByb2Nlc3MoZXMpYCk7XG5cdFx0XHRcdFx0aWYgKGV4cGFuZGVkKSB7XG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IHAgb2YgcHJvY3MpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3Qgc3RhdHVzSWNvbiA9IHAuYWxpdmVcblx0XHRcdFx0XHRcdFx0XHQ/IChwLnN0YXR1cyA9PT0gXCJyZWFkeVwiID8gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiXHUyNUNGXCIpIDogcC5zdGF0dXMgPT09IFwiZXJyb3JcIiA/IHRoZW1lLmZnKFwiZXJyb3JcIiwgXCJcdTI1Q0ZcIikgOiB0aGVtZS5mZyhcIndhcm5pbmdcIiwgXCJcdTI1Q0ZcIikpXG5cdFx0XHRcdFx0XHRcdFx0OiB0aGVtZS5mZyhcImVycm9yXCIsIFwiXHUyNUNCXCIpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBwb3J0SW5mbyA9IHAucG9ydHMubGVuZ3RoID4gMCA/IGAgOiR7cC5wb3J0cy5qb2luKFwiLFwiKX1gIDogXCJcIjtcblx0XHRcdFx0XHRcdFx0dGV4dCArPSBgXFxuICAke3N0YXR1c0ljb259ICR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgcC5pZCl9ICAke3RoZW1lLmZnKFwiZGltXCIsIHAudXB0aW1lKX0gICR7dGhlbWUuZmcoXCJtdXRlZFwiLCBwLmxhYmVsKX0gIFske3AucHJvY2Vzc1R5cGV9XSR7cG9ydEluZm99YDtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcImtpbGxcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHByb2MgPSBkZXRhaWxzLnByb2Nlc3MgYXMgQmdQcm9jZXNzSW5mbztcblx0XHRcdFx0XHRyZXR1cm4gbmV3IFRleHQoXG5cdFx0XHRcdFx0XHR0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJcdTI3MTMgS2lsbGVkIFwiKSArIHRoZW1lLmZnKFwiYWNjZW50XCIsIHByb2MuaWQpICsgXCIgXCIgKyB0aGVtZS5mZyhcIm11dGVkXCIsIHByb2MubGFiZWwpLFxuXHRcdFx0XHRcdFx0MCwgMCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Y2FzZSBcInJlc3RhcnRcIjoge1xuXHRcdFx0XHRcdGNvbnN0IHByb2MgPSBkZXRhaWxzLnByb2Nlc3MgYXMgQmdQcm9jZXNzSW5mbztcblx0XHRcdFx0XHRyZXR1cm4gbmV3IFRleHQoXG5cdFx0XHRcdFx0XHR0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJcdTIxQkIgUmVzdGFydGVkIFwiKSArIHRoZW1lLmZnKFwiYWNjZW50XCIsIHByb2MuaWQpICsgXCIgXCIgKyB0aGVtZS5mZyhcIm11dGVkXCIsIHByb2MubGFiZWwpICsgXCIgXCIgKyB0aGVtZS5mZyhcImRpbVwiLCBgIyR7cHJvYy5yZXN0YXJ0Q291bnR9YCksXG5cdFx0XHRcdFx0XHQwLCAwLFxuXHRcdFx0XHRcdCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRjYXNlIFwiZW52XCI6IHtcblx0XHRcdFx0XHRjb25zdCBwcm9jID0gZGV0YWlscy5wcm9jZXNzIGFzIEJnUHJvY2Vzc0luZm87XG5cdFx0XHRcdFx0Y29uc3QgZW52RGF0YSA9IGRldGFpbHMuZW52IGFzIHsgY3dkOiBzdHJpbmc7IHNoZWxsOiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcblx0XHRcdFx0XHRsZXQgdGV4dCA9IHRoZW1lLmZnKFwiYWNjZW50XCIsIHByb2MuaWQpICsgXCIgXCIgKyB0aGVtZS5mZyhcIm11dGVkXCIsIHByb2MubGFiZWwpO1xuXHRcdFx0XHRcdGlmIChlbnZEYXRhKSB7XG5cdFx0XHRcdFx0XHR0ZXh0ICs9IFwiIFwiICsgdGhlbWUuZmcoXCJkaW1cIiwgYGN3ZDogJHtlbnZEYXRhLmN3ZH1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0aWYgKGV4cGFuZGVkKSB7XG5cdFx0XHRcdFx0XHRjb25zdCByYXdUZXh0ID0gcmVzdWx0LmNvbnRlbnRbMF07XG5cdFx0XHRcdFx0XHRpZiAocmF3VGV4dD8udHlwZSA9PT0gXCJ0ZXh0XCIpIHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgbGluZXMgPSByYXdUZXh0LnRleHQuc3BsaXQoXCJcXG5cIikuc2xpY2UoMSk7XG5cdFx0XHRcdFx0XHRcdGZvciAoY29uc3QgbGluZSBvZiBsaW5lcy5zbGljZSgwLCAxNSkpIHtcblx0XHRcdFx0XHRcdFx0XHR0ZXh0ICs9IFwiXFxuICBcIiArIHRoZW1lLmZnKFwiZGltXCIsIGxpbmUpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNhc2UgXCJncm91cF9zdGF0dXNcIjoge1xuXHRcdFx0XHRcdGNvbnN0IGdzID0gZGV0YWlscy5ncm91cFN0YXR1cyBhcyBSZXR1cm5UeXBlPHR5cGVvZiBnZXRHcm91cFN0YXR1cz4gfCB1bmRlZmluZWQ7XG5cdFx0XHRcdFx0aWYgKGdzKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBpY29uID0gZ3MuaGVhbHRoeSA/IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlx1MjcxM1wiKSA6IHRoZW1lLmZnKFwiZXJyb3JcIiwgXCJcdTI3MTdcIik7XG5cdFx0XHRcdFx0XHRyZXR1cm4gbmV3IFRleHQoXG5cdFx0XHRcdFx0XHRcdGAke2ljb259ICR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgZ3MuZ3JvdXApfSBcdTIwMTQgJHtncy5wcm9jZXNzZXMubGVuZ3RofSBwcm9jZXNzKGVzKWAsXG5cdFx0XHRcdFx0XHRcdDAsIDAsXG5cdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb25zdCBncm91cHMgPSBkZXRhaWxzLmdyb3VwcyBhcyBzdHJpbmdbXTtcblx0XHRcdFx0XHRyZXR1cm4gbmV3IFRleHQodGhlbWUuZmcoXCJkaW1cIiwgYCR7Z3JvdXBzPy5sZW5ndGggPz8gMH0gZ3JvdXAocylgKSwgMCwgMCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRkZWZhdWx0OiB7XG5cdFx0XHRcdFx0Y29uc3QgdGV4dCA9IHJlc3VsdC5jb250ZW50WzBdO1xuXHRcdFx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0Py50eXBlID09PSBcInRleHRcIiA/IHRleHQudGV4dCA6IFwiXCIsIDAsIDApO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSxcblx0fSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFJQSxTQUFTLGtCQUFrQjtBQUUzQixTQUFTLFlBQVk7QUFDckIsU0FBUyxZQUFZO0FBR3JCLFNBQVMsNkJBQTZCO0FBQ3RDO0FBQUEsRUFDQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFDUDtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNNO0FBQ1AsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxlQUFlLGFBQWEsb0JBQW9CO0FBQ3pELFNBQVMsbUJBQW1CO0FBSXJCLFNBQVMsb0JBQW9CLElBQWtCLE9BQWlDO0FBQ3RGLEtBQUcsYUFBYTtBQUFBLElBQ2YsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFDQztBQUFBLElBU0Qsa0JBQWtCO0FBQUEsTUFDakI7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNEO0FBQUEsSUFFQSxZQUFZLEtBQUssT0FBTztBQUFBLE1BQ3ZCLFFBQVEsV0FBVztBQUFBLFFBQ2xCO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsUUFDQTtBQUFBLFFBQ0E7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
