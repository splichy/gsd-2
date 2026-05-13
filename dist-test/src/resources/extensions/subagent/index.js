import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@gsd/pi-ai";
import { getMarkdownTheme } from "@gsd/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@gsd/pi-tui";
import { Type } from "@sinclair/typebox";
import { formatTokenCount } from "../shared/mod.js";
import { getCurrentPhase } from "../shared/gsd-phase-state.js";
import { discoverAgents } from "./agents.js";
import {
  createIsolation,
  mergeDeltaPatches,
  readIsolationMode
} from "./isolation.js";
import { registerWorker, updateWorker } from "./worker-registry.js";
import { loadEffectiveGSDPreferences } from "../gsd/preferences.js";
import { emitJournalEvent } from "../gsd/journal.js";
import { CmuxClient, shellEscape } from "../cmux/index.js";
import {
  buildShellEnvAssignments,
  createSubagentLaunchPlan,
  isSubagentChildProcess
} from "./launch.js";
import {
  SubagentRunStore,
  createInitialRunRecord,
  createSubagentTrackingName,
  deriveRunStatus
} from "./run-store.js";
import { buildSubagentProcessArgs as buildSubagentProcessArgs2 } from "./launch.js";
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const liveSubagentProcesses = /* @__PURE__ */ new Set();
async function stopLiveSubagents() {
  const active = Array.from(liveSubagentProcesses);
  if (active.length === 0) return;
  for (const proc of active) {
    try {
      proc.kill("SIGTERM");
    } catch {
    }
  }
  await Promise.all(
    active.map(
      (proc) => new Promise((resolve) => {
        const done = () => resolve();
        const timer = setTimeout(done, 500);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      })
    )
  );
  for (const proc of active) {
    if (proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
      }
    }
  }
}
function formatUsageStats(usage, model) {
  const parts = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`\u2191${formatTokenCount(usage.input)}`);
  if (usage.output) parts.push(`\u2193${formatTokenCount(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${(Number(usage.cost) || 0).toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokenCount(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}
function formatToolCall(toolName, args, themeFg) {
  const shortenPath = (p) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };
  switch (toolName) {
    case "bash": {
      const command = args.command || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = args.file_path || args.path || "...";
      const filePath = shortenPath(rawPath);
      const offset = args.offset;
      const limit = args.limit;
      let text = themeFg("accent", filePath);
      if (offset !== void 0 || limit !== void 0) {
        const startLine = offset ?? 1;
        const endLine = limit !== void 0 ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = args.file_path || args.path || "...";
      const filePath = shortenPath(rawPath);
      const content = args.content || "";
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = args.file_path || args.path || "...";
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = args.path || ".";
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = args.pattern || "*";
      const rawPath = args.path || ".";
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = args.pattern || "";
      const rawPath = args.path || ".";
      return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}
function getFinalOutput(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}
function getDisplayItems(messages) {
  const items = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}
async function mapWithConcurrencyLimit(items, concurrency, fn) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}
function writePromptToTempFile(agentName, prompt) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 384 });
  return { dir: tmpDir, filePath };
}
function processSubagentEventLine(line, currentResult, emitUpdate) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === "message_end" && event.message) {
    const msg = event.message;
    currentResult.messages.push(msg);
    if (msg.role === "assistant") {
      currentResult.usage.turns++;
      const usage = msg.usage;
      if (usage) {
        currentResult.usage.input += usage.input || 0;
        currentResult.usage.output += usage.output || 0;
        currentResult.usage.cacheRead += usage.cacheRead || 0;
        currentResult.usage.cacheWrite += usage.cacheWrite || 0;
        currentResult.usage.cost += usage.cost?.total || 0;
        currentResult.usage.contextTokens = usage.totalTokens || 0;
      }
      if (!currentResult.model && msg.model) currentResult.model = msg.model;
      if (msg.stopReason) currentResult.stopReason = msg.stopReason;
      if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
    }
    emitUpdate();
  }
  if (event.type === "tool_result_end" && event.message) {
    currentResult.messages.push(event.message);
    emitUpdate();
  }
}
async function waitForFile(filePath, signal, timeoutMs = 30 * 60 * 1e3) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return false;
    if (fs.existsSync(filePath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}
function resultStatus(result) {
  if (result.stopReason === "aborted") return "interrupted";
  return result.exitCode === 0 ? "succeeded" : "failed";
}
function resultToChildArtifact(result, index, cwd) {
  const running = result.running === true || result.exitCode === -1;
  return {
    index,
    agent: result.agent,
    trackingName: result.trackingName,
    task: result.task,
    status: running ? "running" : resultStatus(result),
    exitCode: result.exitCode,
    cwd,
    sessionFile: result.sessionFile,
    completedAt: running ? void 0 : (/* @__PURE__ */ new Date()).toISOString(),
    output: getFinalOutput(result.messages),
    stderr: result.stderr || void 0,
    errorMessage: result.errorMessage,
    stopReason: result.stopReason,
    model: result.model,
    usage: result.usage,
    merge: result.mergeResult ? {
      success: result.mergeResult.success,
      appliedPatches: result.mergeResult.appliedPatches,
      failedPatches: result.mergeResult.failedPatches,
      error: result.mergeResult.error
    } : void 0
  };
}
function formatAgentLabel(agent, trackingName) {
  return trackingName ? `${trackingName} / ${agent}` : agent;
}
function formatRunRecord(record) {
  if (!record) return "Subagent run not found.";
  const lines = [
    `Run ${record.runId}: ${record.status}`,
    `Mode: ${record.mode}`,
    `Context: ${record.contextMode}`,
    `Updated: ${record.updatedAt}`
  ];
  for (const child of record.children) {
    const exit = child.exitCode === void 0 ? "" : ` (exit ${child.exitCode})`;
    lines.push(`- [${child.status}] ${formatAgentLabel(child.agent, child.trackingName)}${exit}: ${child.output || child.errorMessage || child.stderr || child.task}`);
    if (child.sessionFile) lines.push(`  session: ${child.sessionFile}`);
  }
  if (record.failure) lines.push(`Failure: ${record.failure.message}`);
  return lines.join("\n");
}
async function runSingleAgent(defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, modelOverride, contextMode = "fresh", parentSessionManager, sessionOverride, trackingName) {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      trackingName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step
    };
  }
  if (agent.conflictsWith && agent.conflictsWith.length > 0) {
    const activePhase = getCurrentPhase();
    if (activePhase && agent.conflictsWith.includes(activePhase)) {
      return {
        agent: agentName,
        trackingName,
        agentSource: agent.source,
        task,
        exitCode: 1,
        messages: [],
        stderr: `Agent "${agentName}" is blocked: it conflicts with the active GSD phase "${activePhase}". Use the built-in GSD workflow instead.`,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        step
      };
    }
  }
  let tmpPromptDir = null;
  let tmpPromptPath = null;
  const currentResult = {
    agent: agentName,
    trackingName,
    agentSource: agent.source,
    task,
    exitCode: -1,
    running: true,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: modelOverride ?? agent.model,
    step
  };
  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult])
      });
    }
  };
  try {
    if (agent.systemPrompt.trim()) {
      const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }
    const launch = createSubagentLaunchPlan({
      agent,
      task,
      tmpPromptPath,
      modelOverride,
      contextMode,
      parentSessionManager,
      session: sessionOverride,
      cwd,
      defaultCwd
    });
    if (launch.session.mode === "fork") currentResult.sessionFile = launch.session.sessionFile;
    let wasAborted = false;
    const exitCode = await new Promise((resolve) => {
      const bundledPaths = (process.env.GSD_BUNDLED_EXTENSION_PATHS ?? "").split(path.delimiter).map((s) => s.trim()).filter(Boolean);
      const extensionArgs = bundledPaths.flatMap((p) => ["--extension", p]);
      const proc = spawn(
        process.execPath,
        [process.env.GSD_BIN_PATH, ...extensionArgs, ...launch.args],
        { cwd: launch.cwd, env: launch.env, shell: false, stdio: ["ignore", "pipe", "pipe"] }
      );
      liveSubagentProcesses.add(proc);
      let buffer = "";
      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processSubagentEventLine(line, currentResult, emitUpdate);
      });
      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });
      proc.on("close", (code) => {
        liveSubagentProcesses.delete(proc);
        if (buffer.trim()) processSubagentEventLine(buffer, currentResult, emitUpdate);
        resolve(code ?? 0);
      });
      proc.on("error", () => {
        liveSubagentProcesses.delete(proc);
        resolve(1);
      });
      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5e3);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });
    currentResult.exitCode = exitCode;
    currentResult.running = false;
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
      }
  }
}
async function runSingleAgentInCmuxSplit(cmuxClient, directionOrSurfaceId, defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, modelOverride, contextMode = "fresh", parentSessionManager, sessionOverride, trackingName) {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    return runSingleAgent(defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, modelOverride, contextMode, parentSessionManager, sessionOverride, trackingName);
  }
  let tmpPromptDir = null;
  let tmpPromptPath = null;
  let tmpOutputDir = null;
  const currentResult = {
    agent: agentName,
    trackingName,
    agentSource: agent.source,
    task,
    exitCode: -1,
    running: true,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: modelOverride ?? agent.model,
    step
  };
  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult])
      });
    }
  };
  try {
    if (agent.systemPrompt.trim()) {
      const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }
    tmpOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-cmux-"));
    const stdoutPath = path.join(tmpOutputDir, "stdout.jsonl");
    const stderrPath = path.join(tmpOutputDir, "stderr.log");
    const exitPath = path.join(tmpOutputDir, "exit.code");
    const isDirection = directionOrSurfaceId === "right" || directionOrSurfaceId === "down" || directionOrSurfaceId === "left" || directionOrSurfaceId === "up";
    const cmuxSurfaceId = isDirection ? await cmuxClient.createSplit(directionOrSurfaceId) : directionOrSurfaceId;
    if (!cmuxSurfaceId) {
      return runSingleAgent(defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, modelOverride, contextMode, parentSessionManager, sessionOverride, trackingName);
    }
    const bundledPaths = (process.env.GSD_BUNDLED_EXTENSION_PATHS ?? "").split(path.delimiter).map((s) => s.trim()).filter(Boolean);
    const extensionArgs = bundledPaths.flatMap((p) => ["--extension", p]);
    const launch = createSubagentLaunchPlan({
      agent,
      task,
      tmpPromptPath,
      modelOverride,
      contextMode,
      parentSessionManager,
      session: sessionOverride,
      cwd,
      defaultCwd
    });
    if (launch.session.mode === "fork") currentResult.sessionFile = launch.session.sessionFile;
    const processArgs = [process.env.GSD_BIN_PATH, ...extensionArgs, ...launch.args];
    const bashPath = (p) => shellEscape(p.replaceAll("\\", "/"));
    const envPrefix = buildShellEnvAssignments(launch.env).join(" ");
    const commandPrefix = envPrefix ? `${envPrefix} ` : "";
    const innerScript = [
      `cd ${bashPath(launch.cwd)}`,
      "set -o pipefail",
      `${commandPrefix}${bashPath(process.execPath)} ${processArgs.map((a) => bashPath(a)).join(" ")} 2> >(tee ${bashPath(stderrPath)} >&2) | tee ${bashPath(stdoutPath)}`,
      "status=${PIPESTATUS[0]}",
      `printf '%s' "$status" > ${bashPath(exitPath)}`
    ].join("; ");
    const sent = await cmuxClient.sendSurface(cmuxSurfaceId, `bash -lc ${shellEscape(innerScript)}`);
    if (!sent) {
      return runSingleAgent(defaultCwd, agents, agentName, task, cwd, step, signal, onUpdate, makeDetails, modelOverride, contextMode, parentSessionManager, sessionOverride, trackingName);
    }
    const finished = await waitForFile(exitPath, signal);
    if (!finished) {
      try {
        await cmuxClient.sendInterrupt(cmuxSurfaceId);
      } catch {
      }
      await waitForFile(exitPath, void 0, 5e3);
      currentResult.exitCode = 1;
      currentResult.running = false;
      currentResult.stderr = "cmux split execution timed out or was aborted";
      if (fs.existsSync(stdoutPath)) {
        const stdout = fs.readFileSync(stdoutPath, "utf-8");
        for (const line of stdout.split("\n")) {
          processSubagentEventLine(line, currentResult, emitUpdate);
        }
      }
      return currentResult;
    }
    if (fs.existsSync(stdoutPath)) {
      const stdout = fs.readFileSync(stdoutPath, "utf-8");
      for (const line of stdout.split("\n")) {
        processSubagentEventLine(line, currentResult, emitUpdate);
      }
    }
    if (fs.existsSync(stderrPath)) {
      currentResult.stderr = fs.readFileSync(stderrPath, "utf-8");
    }
    currentResult.exitCode = Number.parseInt(fs.readFileSync(exitPath, "utf-8").trim() || "1", 10) || 0;
    currentResult.running = false;
    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
      }
    if (tmpOutputDir)
      try {
        fs.rmSync(tmpOutputDir, { recursive: true, force: true });
      } catch {
      }
  }
}
const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  model: Type.Optional(Type.String({ description: "Model override for this task (e.g. 'claude-sonnet-4-6')" })),
  context: Type.Optional(StringEnum(["fresh", "fork"], {
    description: 'Context mode for this task. "fresh" keeps the existing isolated context behavior; "fork" branches the parent session.',
    default: "fresh"
  }))
});
const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  model: Type.Optional(Type.String({ description: "Model override for this step (e.g. 'claude-sonnet-4-6')" })),
  context: Type.Optional(StringEnum(["fresh", "fork"], {
    description: 'Context mode for this step. "fresh" keeps the existing isolated context behavior; "fork" branches the parent session.',
    default: "fresh"
  }))
});
const AgentScopeSchema = StringEnum(["user", "project", "both"], {
  description: 'Which agent directories to use. Default: "both" (user + project-local).',
  default: "both"
});
const ContextModeSchema = StringEnum(["fresh", "fork"], {
  description: 'Context mode for delegated work. "fresh" is the default existing behavior; "fork" branches the parent session.',
  default: "fresh"
});
const SubagentActionSchema = StringEnum(["launch", "status", "resume"], {
  description: 'Run action. "launch" starts delegated work, "status" inspects a persisted run, and "resume" follows up a child session from a run.',
  default: "launch"
});
const SubagentParams = Type.Object({
  action: Type.Optional(SubagentActionSchema),
  runId: Type.Optional(Type.String({ description: "Persisted subagent run id for status or resume actions" })),
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  context: Type.Optional(ContextModeSchema),
  background: Type.Optional(Type.Boolean({ description: "Return after starting the run and keep status in the persisted run record. Default: false.", default: false })),
  followUp: Type.Optional(Type.String({ description: "Follow-up instruction for resume action. Falls back to task when omitted." })),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: false.", default: false })
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
  model: Type.Optional(Type.String({ description: "Model override for the subagent (e.g. 'claude-sonnet-4-6'). Takes precedence over the agent's frontmatter model." })),
  isolated: Type.Optional(
    Type.Boolean({
      description: "Run the subagent in an isolated filesystem (git worktree). Changes are captured as patches and merged back. Only available when taskIsolation.mode is configured in settings.",
      default: false
    })
  )
});
function subagent_default(pi) {
  if (isSubagentChildProcess()) return;
  pi.on("session_shutdown", async () => {
    await stopLiveSubagents();
  });
  pi.registerCommand("subagent", {
    description: "List available subagents",
    handler: async (_args, ctx) => {
      const discovery = discoverAgents(ctx.cwd, "both");
      if (discovery.agents.length === 0) {
        ctx.ui.notify("No agents found. Add .md files to ~/.gsd/agent/agents/ or .gsd/agents/", "warning");
        return;
      }
      const lines = discovery.agents.map(
        (a) => `  ${a.name} [${a.source}]${a.model ? ` (${a.model})` : ""}: ${a.description}`
      );
      ctx.ui.notify(`Available agents (${discovery.agents.length}):
${lines.join("\n")}`, "info");
    }
  });
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context windows.",
      "Each subagent is a separate pi process with its own tools, model, and system prompt.",
      "Modes: single ({ agent, task }), parallel ({ tasks: [{agent, task},...] }), chain ({ chain: [{agent, task},...] } with {previous} placeholder).",
      "Agents are defined as .md files in ~/.gsd/agent/agents/ (user) or .gsd/agents/ (project).",
      "Use the /subagent command to list available agents and their descriptions.",
      "Use chain mode to pipeline: scout finds context, planner designs, worker implements."
    ].join(" "),
    promptGuidelines: [
      "Prefer subagent dispatch over inline work whenever a task is self-contained \u2014 recon, planning, review, refactor, test writing, security audit, doc writing. Each dispatch gets a fresh context window, so your main session stays focused on synthesis.",
      "Before reading more than ~3 files to understand something, dispatch the scout agent and work from its compressed report instead.",
      "Before any change touching \u22652 packages, the orchestration kernel, auto-mode, or a public API, dispatch the planner agent first. Plan first, then implement.",
      "You MUST use parallel mode when \u22652 ready tasks are independent of each other's output. Do not serialize independent tasks manually \u2014 that wastes wall time and context.",
      "Use chain mode for sequential pipelines where each step's output feeds the next: scout \u2192 planner \u2192 worker, or worker \u2192 reviewer \u2192 worker.",
      "Before opening a PR or marking a slice complete, dispatch the reviewer agent (and security agent if the change touches auth, network, parsing, file IO, or shell exec).",
      "Always check available agents with /subagent before choosing one \u2014 there are bundled specialists plus any project-scoped agents."
    ],
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope = params.agentScope ?? "both";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;
      const confirmProjectAgents = params.confirmProjectAgents ?? false;
      const cmuxClient = CmuxClient.fromPreferences(loadEffectiveGSDPreferences()?.preferences);
      const cmuxSplitsEnabled = cmuxClient.getConfig().splits;
      const runStore = new SubagentRunStore();
      const action = params.action ?? "launch";
      const contextMode = params.context ?? "fresh";
      const taskParams = Array.isArray(params.tasks) ? params.tasks : [];
      const chainParams = Array.isArray(params.chain) ? params.chain : [];
      const isolationMode = readIsolationMode();
      const useIsolation = Boolean(params.isolated) && isolationMode !== "none";
      const hasChain = chainParams.length > 0;
      const hasTasks = taskParams.length > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      const makeDetails = (mode) => (results) => ({
        mode,
        agentScope,
        projectAgentsDir: discovery.projectAgentsDir,
        results
      });
      if (action === "status") {
        if (!params.runId) {
          return {
            content: [{ type: "text", text: "Status requires runId." }],
            details: makeDetails("single")([]),
            isError: true
          };
        }
        const record = runStore.get(params.runId);
        return {
          content: [{ type: "text", text: formatRunRecord(record) }],
          details: makeDetails("single")([]),
          ...record ? {} : { isError: true }
        };
      }
      if (action === "resume") {
        if (!params.runId) {
          return {
            content: [{ type: "text", text: "Resume requires runId." }],
            details: makeDetails("single")([]),
            isError: true
          };
        }
        const record = runStore.get(params.runId);
        if (!record) {
          return {
            content: [{ type: "text", text: `Subagent run not found: ${params.runId}` }],
            details: makeDetails("single")([]),
            isError: true
          };
        }
        const followUp = params.followUp ?? params.task;
        if (!followUp) {
          return {
            content: [{ type: "text", text: "Resume requires followUp or task." }],
            details: makeDetails("single")([]),
            isError: true
          };
        }
        const sessionChildren = record.children.filter((child) => child.sessionFile);
        const matches = params.agent ? sessionChildren.filter((child) => child.agent === params.agent) : sessionChildren;
        const selected = matches.length === 1 ? matches[0] : void 0;
        if (!selected?.sessionFile) {
          const available = sessionChildren.map((child) => formatAgentLabel(child.agent, child.trackingName)).join(", ") || "none";
          return {
            content: [{
              type: "text",
              text: `Resume requires exactly one child session or an agent selector. Available resumable agents: ${available}`
            }],
            details: makeDetails("single")([]),
            isError: true
          };
        }
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          selected.agent,
          followUp,
          selected.cwd,
          void 0,
          signal,
          onUpdate,
          makeDetails("single"),
          params.model,
          "fresh",
          ctx.sessionManager,
          { mode: "fork", sessionFile: selected.sessionFile, sessionDir: path.dirname(selected.sessionFile) },
          selected.trackingName
        );
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || result.errorMessage || result.stderr || "(no output)" }],
          details: makeDetails("single")([result]),
          ...result.exitCode === 0 ? {} : { isError: true }
        };
      }
      if (modeCount !== 1) {
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.
Available agents: ${available}`
            }
          ],
          details: makeDetails("single")([])
        };
      }
      const dispatchMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const dispatchAgents = hasChain ? chainParams.map((s) => s.agent) : hasTasks ? taskParams.map((t) => t.agent) : params.agent ? [params.agent] : [];
      const dispatchTasks = hasChain ? chainParams.map((s) => s.task) : hasTasks ? taskParams.map((t) => t.task) : params.task ? [params.task] : [];
      const dispatchId = crypto.randomUUID();
      const dispatchStartMs = Date.now();
      let finalResults = [];
      let dispatchCompletedEmitted = false;
      const usedTrackingNames = /* @__PURE__ */ new Set();
      const dispatchTrackingNames = dispatchAgents.map(() => {
        const trackingName = createSubagentTrackingName(usedTrackingNames);
        usedTrackingNames.add(trackingName);
        return trackingName;
      });
      const dispatchContextMode = hasChain && chainParams.some((step) => (step.context ?? contextMode) === "fork") ? "fork" : hasTasks && taskParams.some((task) => (task.context ?? contextMode) === "fork") ? "fork" : contextMode;
      const dispatchChildren = dispatchAgents.map((agent, index) => ({
        agent,
        trackingName: dispatchTrackingNames[index],
        task: dispatchTasks[index] ?? "",
        cwd: hasChain ? chainParams[index]?.cwd : hasTasks ? taskParams[index]?.cwd : params.cwd
      }));
      try {
        runStore.create(createInitialRunRecord({
          runId: dispatchId,
          mode: dispatchMode,
          contextMode: dispatchContextMode,
          cwd: ctx.cwd,
          children: dispatchChildren
        }));
      } catch {
      }
      const persistRunResults = (results, completed = false) => {
        try {
          runStore.update(dispatchId, (record) => {
            const children = [...record.children];
            for (let index = 0; index < results.length; index++) {
              const result = results[index];
              if (!result) continue;
              children[index] = {
                ...children[index],
                ...resultToChildArtifact(result, index, children[index]?.cwd)
              };
            }
            if (completed) {
              for (let index = 0; index < children.length; index++) {
                const child = children[index];
                if (child.status === "queued" || child.status === "running") {
                  children[index] = {
                    ...child,
                    status: "failed",
                    completedAt: (/* @__PURE__ */ new Date()).toISOString(),
                    errorMessage: "Subagent run ended before this child completed."
                  };
                }
              }
            }
            const status = completed ? deriveRunStatus(children) : "running";
            const failed = children.find((child) => child.status === "failed");
            const interrupted = children.find((child) => child.status === "interrupted");
            return {
              ...record,
              children,
              status,
              ...completed && status !== "running" ? { completedAt: (/* @__PURE__ */ new Date()).toISOString() } : {},
              ...interrupted ? { failure: { type: "interrupted", message: interrupted.errorMessage || interrupted.stderr || "Subagent run was interrupted" } } : failed ? { failure: { type: failed.merge?.success === false ? "merge-failed" : "child-failed", message: failed.errorMessage || failed.stderr || `Subagent ${failed.agent} failed` } } : {}
            };
          });
        } catch {
        }
      };
      emitJournalEvent(ctx.cwd, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        flowId: dispatchId,
        seq: 0,
        eventType: "subagent-invoked",
        data: {
          dispatchId,
          mode: dispatchMode,
          agents: dispatchAgents,
          batchSize: dispatchAgents.length,
          unitType: getCurrentPhase() ?? null,
          isolated: useIsolation
        }
      });
      const zeroUsage = () => ({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0
      });
      const errorMessageFor = (err) => err instanceof Error ? err.message : String(err || "subagent dispatch failed");
      const makeFailureResult = (err, agent, task, step, trackingName) => {
        const message = errorMessageFor(err);
        const dispatchIndex = dispatchAgents.findIndex(
          (dispatchAgent, index) => dispatchAgent === agent && dispatchTasks[index] === task
        );
        return {
          agent,
          trackingName: trackingName ?? (dispatchIndex >= 0 ? dispatchTrackingNames[dispatchIndex] : void 0),
          agentSource: "unknown",
          task,
          exitCode: 1,
          messages: [],
          stderr: message,
          usage: zeroUsage(),
          stopReason: signal?.aborted ? "aborted" : "error",
          errorMessage: message,
          ...step !== void 0 ? { step } : {}
        };
      };
      const synthesizeFailureResults = (err) => {
        if (finalResults.length > 0) {
          let patchedRunning = false;
          const patched = finalResults.map((result) => {
            if (result.exitCode !== -1) return result;
            patchedRunning = true;
            const message = errorMessageFor(err);
            return {
              ...result,
              exitCode: 1,
              stderr: result.stderr || message,
              stopReason: signal?.aborted ? "aborted" : "error",
              errorMessage: result.errorMessage || message,
              usage: result.usage ?? zeroUsage()
            };
          });
          if (patchedRunning || patched.some((result) => result.exitCode !== 0)) return patched;
          const nextIndex = finalResults.length < dispatchAgents.length ? finalResults.length : 0;
          if (nextIndex > 0) {
            return [
              ...finalResults,
              makeFailureResult(
                err,
                dispatchAgents[nextIndex] ?? "unknown",
                dispatchTasks[nextIndex] ?? "",
                dispatchMode === "chain" ? nextIndex + 1 : void 0,
                dispatchTrackingNames[nextIndex]
              )
            ];
          }
        }
        const agentsForFailure = dispatchAgents.length > 0 ? dispatchAgents : ["unknown"];
        return agentsForFailure.map(
          (agent, index) => makeFailureResult(
            err,
            agent,
            dispatchTasks[index] ?? "",
            dispatchMode === "chain" ? index + 1 : void 0,
            dispatchTrackingNames[index]
          )
        );
      };
      const finishDispatch = (results) => {
        if (dispatchCompletedEmitted) return;
        finalResults = results;
        dispatchCompletedEmitted = true;
        persistRunResults(results, true);
        const successCount = results.filter((r) => r.exitCode === 0).length;
        const failureCount = results.filter((r) => r.exitCode !== 0).length;
        const totalCost = results.reduce((s, r) => s + (r.usage?.cost ?? 0), 0);
        const totalInputTokens = results.reduce((s, r) => s + (r.usage?.input ?? 0), 0);
        const totalOutputTokens = results.reduce((s, r) => s + (r.usage?.output ?? 0), 0);
        emitJournalEvent(ctx.cwd, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          flowId: dispatchId,
          seq: 1,
          eventType: "subagent-completed",
          data: {
            dispatchId,
            mode: dispatchMode,
            agents: dispatchAgents,
            successCount,
            failureCount,
            totalCost,
            totalInputTokens,
            totalOutputTokens,
            wallTimeMs: Date.now() - dispatchStartMs
          }
        });
      };
      try {
        if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
          const requestedAgentNames = /* @__PURE__ */ new Set();
          if (hasChain) for (const step of chainParams) requestedAgentNames.add(step.agent);
          if (hasTasks) for (const t of taskParams) requestedAgentNames.add(t.agent);
          if (params.agent) requestedAgentNames.add(params.agent);
          const projectAgentsRequested = Array.from(requestedAgentNames).map((name) => agents.find((a) => a.name === name)).filter((a) => a?.source === "project");
          if (projectAgentsRequested.length > 0) {
            const names = projectAgentsRequested.map((a) => a.name).join(", ");
            const dir = discovery.projectAgentsDir ?? "(unknown)";
            const ok = await ctx.ui.confirm(
              "Run project-local agents?",
              `Agents: ${names}
Source: ${dir}

Project agents are repo-controlled. Only continue for trusted repositories.`
            );
            if (!ok) {
              finishDispatch([]);
              return {
                content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([])
              };
            }
          }
        }
        if (params.background) {
          if (!params.agent || !params.task || hasTasks || hasChain) {
            const failure = makeFailureResult(
              new Error("Background launch currently requires single mode with agent and task."),
              params.agent ?? "unknown",
              params.task ?? ""
            );
            finishDispatch([failure]);
            return {
              content: [{ type: "text", text: failure.errorMessage ?? failure.stderr }],
              details: makeDetails("single")([failure]),
              isError: true
            };
          }
          void (async () => {
            let isolation = null;
            try {
              const effectiveCwd = params.cwd ?? ctx.cwd;
              if (useIsolation) {
                const taskId = crypto.randomUUID();
                isolation = await createIsolation(effectiveCwd, taskId, isolationMode);
              }
              const result = await runSingleAgent(
                ctx.cwd,
                agents,
                params.agent,
                params.task,
                isolation ? isolation.workDir : params.cwd,
                void 0,
                void 0,
                (partial) => {
                  if (partial.details?.results[0]) persistRunResults([partial.details.results[0]]);
                },
                makeDetails("single"),
                params.model,
                contextMode,
                ctx.sessionManager,
                void 0,
                dispatchTrackingNames[0]
              );
              if (isolation && result.exitCode === 0) {
                const patches = await isolation.captureDelta();
                if (patches.length > 0) {
                  const mergeResult = await mergeDeltaPatches(effectiveCwd, patches);
                  result.mergeResult = mergeResult;
                  if (!mergeResult.success) {
                    result.exitCode = 1;
                    result.stopReason = "error";
                    result.errorMessage = `Patch merge failed: ${mergeResult.error || "unknown error"}`;
                    result.stderr = result.stderr || result.errorMessage;
                  }
                }
              }
              finalResults = [result];
              finishDispatch([result]);
            } catch (err) {
              finalResults = synthesizeFailureResults(err);
              finishDispatch(finalResults);
            } finally {
              if (isolation) await isolation.cleanup();
            }
          })();
          return {
            content: [{
              type: "text",
              text: `Started background subagent run ${dispatchId}. Use action: "status" with runId: "${dispatchId}" to inspect it.`
            }],
            details: makeDetails("single")([])
          };
        }
        if (chainParams.length > 0) {
          const results = [];
          finalResults = results;
          let previousOutput = "";
          for (let i = 0; i < chainParams.length; i++) {
            const step = chainParams[i];
            const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
            const chainUpdate = (partial) => {
              const currentResult = partial.details?.results[0];
              if (currentResult) {
                const allResults = [...results, currentResult];
                persistRunResults(allResults);
                if (onUpdate) {
                  onUpdate({
                    content: partial.content,
                    details: makeDetails("chain")(allResults)
                  });
                }
              }
            };
            const result = await runSingleAgent(
              ctx.cwd,
              agents,
              step.agent,
              taskWithContext,
              step.cwd,
              i + 1,
              signal,
              chainUpdate,
              makeDetails("chain"),
              step.model || params.model,
              step.context ?? contextMode,
              ctx.sessionManager,
              void 0,
              dispatchTrackingNames[i]
            );
            results.push(result);
            persistRunResults(results);
            const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
            if (isError) {
              const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
              finishDispatch(results);
              return {
                content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
                details: makeDetails("chain")(results),
                isError: true
              };
            }
            previousOutput = getFinalOutput(result.messages);
          }
          finishDispatch(results);
          return {
            content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
            details: makeDetails("chain")(results)
          };
        }
        if (taskParams.length > 0) {
          if (taskParams.length > MAX_PARALLEL_TASKS) {
            finishDispatch([]);
            return {
              content: [
                {
                  type: "text",
                  text: `Too many parallel tasks (${taskParams.length}). Max is ${MAX_PARALLEL_TASKS}.`
                }
              ],
              details: makeDetails("parallel")([])
            };
          }
          const allResults = new Array(taskParams.length);
          for (let i = 0; i < taskParams.length; i++) {
            allResults[i] = {
              agent: taskParams[i].agent,
              trackingName: dispatchTrackingNames[i],
              agentSource: "unknown",
              task: taskParams[i].task,
              exitCode: -1,
              // -1 = still running
              messages: [],
              stderr: "",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }
            };
          }
          finalResults = allResults;
          const emitParallelUpdate = () => {
            if (onUpdate) {
              const running = allResults.filter((r) => r.exitCode === -1).length;
              const done = allResults.filter((r) => r.exitCode !== -1).length;
              onUpdate({
                content: [
                  { type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }
                ],
                details: makeDetails("parallel")([...allResults])
              });
            }
          };
          const MAX_RETRIES = 1;
          const batchId = crypto.randomUUID();
          const batchSize = taskParams.length;
          const gridSurfaces = cmuxSplitsEnabled ? await cmuxClient.createGridLayout(Math.min(batchSize, MAX_CONCURRENCY)) : [];
          const results = await mapWithConcurrencyLimit(taskParams, MAX_CONCURRENCY, async (t, index) => {
            const workerId = registerWorker(t.agent, t.task, index, batchSize, batchId);
            const taskModel = t.model || params.model;
            const updateParallelResult = (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                persistRunResults([...allResults]);
                emitParallelUpdate();
              }
            };
            const executeOnce = (runCwd) => cmuxSplitsEnabled ? runSingleAgentInCmuxSplit(
              cmuxClient,
              gridSurfaces[index] ?? (index % 2 === 0 ? "right" : "down"),
              ctx.cwd,
              agents,
              t.agent,
              t.task,
              runCwd,
              void 0,
              signal,
              updateParallelResult,
              makeDetails("parallel"),
              taskModel,
              t.context ?? contextMode,
              ctx.sessionManager,
              void 0,
              dispatchTrackingNames[index]
            ) : runSingleAgent(
              ctx.cwd,
              agents,
              t.agent,
              t.task,
              runCwd,
              void 0,
              signal,
              updateParallelResult,
              makeDetails("parallel"),
              taskModel,
              t.context ?? contextMode,
              ctx.sessionManager,
              void 0,
              dispatchTrackingNames[index]
            );
            const runTask = async () => {
              let isolation = null;
              const effectiveCwd = t.cwd ?? ctx.cwd;
              try {
                if (useIsolation) {
                  const taskId = crypto.randomUUID();
                  isolation = await createIsolation(effectiveCwd, taskId, isolationMode);
                }
                const result2 = await executeOnce(isolation ? isolation.workDir : t.cwd);
                if (isolation && result2.exitCode === 0) {
                  const patches = await isolation.captureDelta();
                  const mergeResult = patches.length > 0 ? await mergeDeltaPatches(effectiveCwd, patches) : { success: true, appliedPatches: [], failedPatches: [] };
                  result2.mergeResult = mergeResult;
                  if (!mergeResult.success) {
                    result2.exitCode = 1;
                    result2.stopReason = "error";
                    result2.errorMessage = `Patch merge failed: ${mergeResult.error || "unknown error"}`;
                    result2.stderr = result2.stderr || result2.errorMessage;
                  }
                }
                return result2;
              } finally {
                if (isolation) await isolation.cleanup();
              }
            };
            let result = await runTask();
            const isFailed = result.exitCode !== 0 || result.messages.length === 0 && !signal?.aborted;
            if (isFailed && MAX_RETRIES > 0 && !signal?.aborted) {
              result = await runTask();
            }
            updateWorker(workerId, result.exitCode === 0 ? "completed" : "failed");
            allResults[index] = result;
            persistRunResults([...allResults]);
            emitParallelUpdate();
            return result;
          });
          finalResults = results;
          const successCount = results.filter((r) => r.exitCode === 0).length;
          const summaries = results.map((r) => {
            const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
            const output = isError ? r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)" : getFinalOutput(r.messages);
            return `[${formatAgentLabel(r.agent, r.trackingName)}] ${r.exitCode === 0 ? "completed" : `failed (exit ${r.exitCode})`}: ${output || "(no output)"}`;
          });
          finishDispatch(results);
          return {
            content: [
              {
                type: "text",
                text: `Parallel: ${successCount}/${results.length} succeeded

${summaries.join("\n\n")}`
              }
            ],
            details: makeDetails("parallel")(results)
          };
        }
        if (params.agent && params.task) {
          let isolation = null;
          let mergeResult;
          try {
            const effectiveCwd = params.cwd ?? ctx.cwd;
            if (useIsolation) {
              const taskId = crypto.randomUUID();
              isolation = await createIsolation(effectiveCwd, taskId, isolationMode);
            }
            const singleUpdate = (partial) => {
              if (partial.details?.results[0]) persistRunResults([partial.details.results[0]]);
              if (onUpdate) onUpdate(partial);
            };
            const result = cmuxSplitsEnabled ? await runSingleAgentInCmuxSplit(
              cmuxClient,
              "right",
              ctx.cwd,
              agents,
              params.agent,
              params.task,
              isolation ? isolation.workDir : params.cwd,
              void 0,
              signal,
              singleUpdate,
              makeDetails("single"),
              params.model,
              contextMode,
              ctx.sessionManager,
              void 0,
              dispatchTrackingNames[0]
            ) : await runSingleAgent(
              ctx.cwd,
              agents,
              params.agent,
              params.task,
              isolation ? isolation.workDir : params.cwd,
              void 0,
              signal,
              singleUpdate,
              makeDetails("single"),
              params.model,
              contextMode,
              ctx.sessionManager,
              void 0,
              dispatchTrackingNames[0]
            );
            finalResults = [result];
            if (isolation) {
              const patches = await isolation.captureDelta();
              if (patches.length > 0) {
                mergeResult = await mergeDeltaPatches(effectiveCwd, patches);
                result.mergeResult = mergeResult;
                if (!mergeResult.success) {
                  result.exitCode = 1;
                  result.stopReason = "error";
                  result.errorMessage = `Patch merge failed: ${mergeResult.error || "unknown error"}`;
                  result.stderr = result.stderr || result.errorMessage;
                }
              }
            }
            const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
            if (isError) {
              const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
              finishDispatch([result]);
              return {
                content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
                details: makeDetails("single")([result]),
                isError: true
              };
            }
            let outputText = getFinalOutput(result.messages) || "(no output)";
            if (mergeResult && !mergeResult.success) {
              outputText += `

\u26A0 Patch merge failed: ${mergeResult.error || "unknown error"}`;
            }
            finishDispatch([result]);
            return {
              content: [{ type: "text", text: outputText }],
              details: makeDetails("single")([result])
            };
          } finally {
            if (isolation) {
              await isolation.cleanup();
            }
          }
        }
        finishDispatch([]);
        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
          details: makeDetails("single")([])
        };
      } catch (err) {
        if (!dispatchCompletedEmitted) finalResults = synthesizeFailureResults(err);
        throw err;
      } finally {
        if (!params.background) finishDispatch(finalResults);
      }
    },
    renderCall(args, theme) {
      const scope = args.agentScope ?? "both";
      if (args.chain && args.chain.length > 0) {
        let text2 = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview2 = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text2 += "\n  " + theme.fg("muted", `${i + 1}.`) + " " + theme.fg("accent", step.agent) + theme.fg("dim", ` ${preview2}`);
        }
        if (args.chain.length > 3) text2 += `
  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text2, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text2 = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`) + theme.fg("muted", ` [${scope}]`);
        for (const t of args.tasks.slice(0, 3)) {
          const preview2 = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
          text2 += `
  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview2}`)}`;
        }
        if (args.tasks.length > 3) text2 += `
  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text2, 0, 0);
      }
      const agentName = args.agent || "...";
      const preview = args.task ? args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task : "...";
      let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + theme.fg("muted", ` [${scope}]`);
      text += `
  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      if (!details || details.results.length === 0) {
        const text2 = result.content[0];
        return new Text(text2?.type === "text" ? text2.text : "(no output)", 0, 0);
      }
      const mdTheme = getMarkdownTheme();
      const renderDisplayItems = (items, limit) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text2 = "";
        if (skipped > 0) text2 += theme.fg("muted", `... ${skipped} earlier items
`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text2 += `${theme.fg("toolOutput", preview)}
`;
          } else {
            text2 += `${theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}
`;
          }
        }
        return text2.trimEnd();
      };
      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
        const icon = isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = getFinalOutput(r.messages);
        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg("toolTitle", theme.bold(formatAgentLabel(r.agent, r.trackingName)))}${theme.fg("muted", ` (${r.agentSource})`)}`;
          if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Task \u2500\u2500\u2500"), 0, 0));
          container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0));
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          } else {
            for (const item of displayItems) {
              if (item.type === "toolCall")
                container.addChild(
                  new Text(
                    theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0
                  )
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }
          }
          const usageStr2 = formatUsageStats(r.usage, r.model);
          if (usageStr2) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usageStr2), 0, 0));
          }
          return container;
        }
        let text2 = `${icon} ${theme.fg("toolTitle", theme.bold(formatAgentLabel(r.agent, r.trackingName)))}${theme.fg("muted", ` (${r.agentSource})`)}`;
        if (isError && r.stopReason) text2 += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage) text2 += `
${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0) text2 += `
${theme.fg("muted", "(no output)")}`;
        else {
          text2 += `
${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT) text2 += `
${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text2 += `
${theme.fg("dim", usageStr)}`;
        return new Text(text2, 0, 0);
      }
      const aggregateUsage = (results) => {
        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
        for (const r of results) {
          total.input += r.usage.input;
          total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite;
          total.cost += r.usage.cost;
          total.turns += r.usage.turns;
        }
        return total;
      };
      if (details.mode === "chain") {
        const successCount = details.results.filter((r) => r.exitCode === 0).length;
        const icon = successCount === details.results.length ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
        if (expanded) {
          const container = new Container();
          container.addChild(
            new Text(
              icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", `${successCount}/${details.results.length} steps`),
              0,
              0
            )
          );
          for (const r of details.results) {
            const rIcon = r.exitCode === 0 ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${theme.fg("muted", `\u2500\u2500\u2500 Step ${r.step}: `) + theme.fg("accent", formatAgentLabel(r.agent, r.trackingName))} ${rIcon}`,
                0,
                0
              )
            );
            container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0
                  )
                );
              }
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }
            const stepUsage = formatUsageStats(r.usage, r.model);
            if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
          }
          const usageStr2 = formatUsageStats(aggregateUsage(details.results));
          if (usageStr2) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageStr2}`), 0, 0));
          }
          return container;
        }
        let text2 = icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", `${successCount}/${details.results.length} steps`);
        for (const r of details.results) {
          const rIcon = r.exitCode === 0 ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
          const displayItems = getDisplayItems(r.messages);
          text2 += `

${theme.fg("muted", `\u2500\u2500\u2500 Step ${r.step}: `)}${theme.fg("accent", formatAgentLabel(r.agent, r.trackingName))} ${rIcon}`;
          if (displayItems.length === 0) text2 += `
${theme.fg("muted", "(no output)")}`;
          else text2 += `
${renderDisplayItems(displayItems, 5)}`;
        }
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) text2 += `

${theme.fg("dim", `Total: ${usageStr}`)}`;
        text2 += `
${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text2, 0, 0);
      }
      if (details.mode === "parallel") {
        const running = details.results.filter((r) => r.exitCode === -1).length;
        const successCount = details.results.filter((r) => r.exitCode === 0).length;
        const failCount = details.results.filter((r) => r.exitCode > 0).length;
        const isRunning = running > 0;
        const icon = isRunning ? theme.fg("warning", "\u23F3") : failCount > 0 ? theme.fg("warning", "\u25D0") : theme.fg("success", "\u2713");
        const status = isRunning ? `${successCount + failCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} tasks`;
        if (expanded && !isRunning) {
          const container = new Container();
          container.addChild(
            new Text(
              `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
              0,
              0
            )
          );
          for (const r of details.results) {
            const rIcon = r.exitCode === 0 ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
            const displayItems = getDisplayItems(r.messages);
            const finalOutput = getFinalOutput(r.messages);
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(`${theme.fg("muted", "\u2500\u2500\u2500 ") + theme.fg("accent", formatAgentLabel(r.agent, r.trackingName))} ${rIcon}`, 0, 0)
            );
            container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
            for (const item of displayItems) {
              if (item.type === "toolCall") {
                container.addChild(
                  new Text(
                    theme.fg("muted", "\u2192 ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                    0,
                    0
                  )
                );
              }
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }
            const taskUsage = formatUsageStats(r.usage, r.model);
            if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
          }
          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
          }
          return container;
        }
        let text2 = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
        for (const r of details.results) {
          const rIcon = r.exitCode === -1 ? theme.fg("warning", "\u23F3") : r.exitCode === 0 ? theme.fg("success", "\u2713") : theme.fg("error", "\u2717");
          const displayItems = getDisplayItems(r.messages);
          text2 += `

${theme.fg("muted", "\u2500\u2500\u2500 ")}${theme.fg("accent", formatAgentLabel(r.agent, r.trackingName))} ${rIcon}`;
          if (displayItems.length === 0)
            text2 += `
${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
          else text2 += `
${renderDisplayItems(displayItems, 5)}`;
        }
        if (!isRunning) {
          const usageStr = formatUsageStats(aggregateUsage(details.results));
          if (usageStr) text2 += `

${theme.fg("dim", `Total: ${usageStr}`)}`;
        }
        if (!expanded) text2 += `
${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text2, 0, 0);
      }
      const text = result.content[0];
      return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
    }
  });
}
export {
  buildSubagentProcessArgs2 as buildSubagentProcessArgs,
  subagent_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL3N1YmFnZW50L2luZGV4LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFN1YmFnZW50IFRvb2wgLSBEZWxlZ2F0ZSB0YXNrcyB0byBzcGVjaWFsaXplZCBhZ2VudHNcbiAqXG4gKiBTcGF3bnMgYSBzZXBhcmF0ZSBgcGlgIHByb2Nlc3MgZm9yIGVhY2ggc3ViYWdlbnQgaW52b2NhdGlvbixcbiAqIGdpdmluZyBpdCBhbiBpc29sYXRlZCBjb250ZXh0IHdpbmRvdy5cbiAqXG4gKiBTdXBwb3J0cyB0aHJlZSBtb2RlczpcbiAqICAgLSBTaW5nbGU6IHsgYWdlbnQ6IFwibmFtZVwiLCB0YXNrOiBcIi4uLlwiIH1cbiAqICAgLSBQYXJhbGxlbDogeyB0YXNrczogW3sgYWdlbnQ6IFwibmFtZVwiLCB0YXNrOiBcIi4uLlwiIH0sIC4uLl0gfVxuICogICAtIENoYWluOiB7IGNoYWluOiBbeyBhZ2VudDogXCJuYW1lXCIsIHRhc2s6IFwiLi4uIHtwcmV2aW91c30gLi4uXCIgfSwgLi4uXSB9XG4gKlxuICogVXNlcyBKU09OIG1vZGUgdG8gY2FwdHVyZSBzdHJ1Y3R1cmVkIG91dHB1dCBmcm9tIHN1YmFnZW50cy5cbiAqL1xuXG5pbXBvcnQgeyBzcGF3biwgdHlwZSBDaGlsZFByb2Nlc3MgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgKiBhcyBjcnlwdG8gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgKiBhcyBmcyBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0ICogYXMgb3MgZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCAqIGFzIHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBBZ2VudFRvb2xSZXN1bHQgfSBmcm9tIFwiQGdzZC9waS1hZ2VudC1jb3JlXCI7XG5pbXBvcnQgdHlwZSB7IE1lc3NhZ2UgfSBmcm9tIFwiQGdzZC9waS1haVwiO1xuaW1wb3J0IHsgU3RyaW5nRW51bSB9IGZyb20gXCJAZ3NkL3BpLWFpXCI7XG5pbXBvcnQgeyB0eXBlIEV4dGVuc2lvbkFQSSwgZ2V0TWFya2Rvd25UaGVtZSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgQ29udGFpbmVyLCBNYXJrZG93biwgU3BhY2VyLCBUZXh0IH0gZnJvbSBcIkBnc2QvcGktdHVpXCI7XG5pbXBvcnQgeyBUeXBlIH0gZnJvbSBcIkBzaW5jbGFpci90eXBlYm94XCI7XG5pbXBvcnQgeyBmb3JtYXRUb2tlbkNvdW50IH0gZnJvbSBcIi4uL3NoYXJlZC9tb2QuanNcIjtcbmltcG9ydCB7IGdldEN1cnJlbnRQaGFzZSB9IGZyb20gXCIuLi9zaGFyZWQvZ3NkLXBoYXNlLXN0YXRlLmpzXCI7XG5pbXBvcnQgeyB0eXBlIEFnZW50Q29uZmlnLCB0eXBlIEFnZW50U2NvcGUsIGRpc2NvdmVyQWdlbnRzIH0gZnJvbSBcIi4vYWdlbnRzLmpzXCI7XG5pbXBvcnQge1xuXHR0eXBlIElzb2xhdGlvbkVudmlyb25tZW50LFxuXHR0eXBlIElzb2xhdGlvbk1vZGUsXG5cdHR5cGUgTWVyZ2VSZXN1bHQsXG5cdGNyZWF0ZUlzb2xhdGlvbixcblx0bWVyZ2VEZWx0YVBhdGNoZXMsXG5cdHJlYWRJc29sYXRpb25Nb2RlLFxufSBmcm9tIFwiLi9pc29sYXRpb24uanNcIjtcbmltcG9ydCB7IHJlZ2lzdGVyV29ya2VyLCB1cGRhdGVXb3JrZXIgfSBmcm9tIFwiLi93b3JrZXItcmVnaXN0cnkuanNcIjtcbmltcG9ydCB7IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyB9IGZyb20gXCIuLi9nc2QvcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB7IGVtaXRKb3VybmFsRXZlbnQgfSBmcm9tIFwiLi4vZ3NkL2pvdXJuYWwuanNcIjtcbmltcG9ydCB7IENtdXhDbGllbnQsIHNoZWxsRXNjYXBlIH0gZnJvbSBcIi4uL2NtdXgvaW5kZXguanNcIjtcbmltcG9ydCB7XG5cdGJ1aWxkU2hlbGxFbnZBc3NpZ25tZW50cyxcblx0YnVpbGRTdWJhZ2VudFByb2Nlc3NBcmdzLFxuXHRjcmVhdGVTdWJhZ2VudExhdW5jaFBsYW4sXG5cdGlzU3ViYWdlbnRDaGlsZFByb2Nlc3MsXG5cdHR5cGUgU3ViYWdlbnRDb250ZXh0TW9kZSxcblx0dHlwZSBTdWJhZ2VudFNlc3Npb25BcmdzLFxufSBmcm9tIFwiLi9sYXVuY2guanNcIjtcbmltcG9ydCB7XG5cdFN1YmFnZW50UnVuU3RvcmUsXG5cdGNyZWF0ZUluaXRpYWxSdW5SZWNvcmQsXG5cdGNyZWF0ZVN1YmFnZW50VHJhY2tpbmdOYW1lLFxuXHRkZXJpdmVSdW5TdGF0dXMsXG5cdHR5cGUgU3ViYWdlbnRDaGlsZEFydGlmYWN0LFxuXHR0eXBlIFN1YmFnZW50UnVuTW9kZSxcblx0dHlwZSBTdWJhZ2VudFJ1blN0YXR1cyxcbn0gZnJvbSBcIi4vcnVuLXN0b3JlLmpzXCI7XG5cbmV4cG9ydCB7IGJ1aWxkU3ViYWdlbnRQcm9jZXNzQXJncyB9IGZyb20gXCIuL2xhdW5jaC5qc1wiO1xuXG5jb25zdCBNQVhfUEFSQUxMRUxfVEFTS1MgPSA4O1xuY29uc3QgTUFYX0NPTkNVUlJFTkNZID0gNDtcbmNvbnN0IENPTExBUFNFRF9JVEVNX0NPVU5UID0gMTA7XG5jb25zdCBsaXZlU3ViYWdlbnRQcm9jZXNzZXMgPSBuZXcgU2V0PENoaWxkUHJvY2Vzcz4oKTtcblxuYXN5bmMgZnVuY3Rpb24gc3RvcExpdmVTdWJhZ2VudHMoKTogUHJvbWlzZTx2b2lkPiB7XG5cdGNvbnN0IGFjdGl2ZSA9IEFycmF5LmZyb20obGl2ZVN1YmFnZW50UHJvY2Vzc2VzKTtcblx0aWYgKGFjdGl2ZS5sZW5ndGggPT09IDApIHJldHVybjtcblxuXHRmb3IgKGNvbnN0IHByb2Mgb2YgYWN0aXZlKSB7XG5cdFx0dHJ5IHtcblx0XHRcdHByb2Mua2lsbChcIlNJR1RFUk1cIik7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvKiBpZ25vcmUgKi9cblx0XHR9XG5cdH1cblxuXHRhd2FpdCBQcm9taXNlLmFsbChcblx0XHRhY3RpdmUubWFwKFxuXHRcdFx0KHByb2MpID0+XG5cdFx0XHRcdG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgZG9uZSA9ICgpID0+IHJlc29sdmUoKTtcblx0XHRcdFx0XHRjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZG9uZSwgNTAwKTtcblx0XHRcdFx0XHRwcm9jLm9uY2UoXCJleGl0XCIsICgpID0+IHtcblx0XHRcdFx0XHRcdGNsZWFyVGltZW91dCh0aW1lcik7XG5cdFx0XHRcdFx0XHRyZXNvbHZlKCk7XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH0pLFxuXHRcdCksXG5cdCk7XG5cblx0Zm9yIChjb25zdCBwcm9jIG9mIGFjdGl2ZSkge1xuXHRcdGlmIChwcm9jLmV4aXRDb2RlID09PSBudWxsKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRwcm9jLmtpbGwoXCJTSUdLSUxMXCIpO1xuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdC8qIGlnbm9yZSAqL1xuXHRcdFx0fVxuXHRcdH1cblx0fVxufVxuXG5mdW5jdGlvbiBmb3JtYXRVc2FnZVN0YXRzKFxuXHR1c2FnZToge1xuXHRcdGlucHV0OiBudW1iZXI7XG5cdFx0b3V0cHV0OiBudW1iZXI7XG5cdFx0Y2FjaGVSZWFkOiBudW1iZXI7XG5cdFx0Y2FjaGVXcml0ZTogbnVtYmVyO1xuXHRcdGNvc3Q6IG51bWJlcjtcblx0XHRjb250ZXh0VG9rZW5zPzogbnVtYmVyO1xuXHRcdHR1cm5zPzogbnVtYmVyO1xuXHR9LFxuXHRtb2RlbD86IHN0cmluZyxcbik6IHN0cmluZyB7XG5cdGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRpZiAodXNhZ2UudHVybnMpIHBhcnRzLnB1c2goYCR7dXNhZ2UudHVybnN9IHR1cm4ke3VzYWdlLnR1cm5zID4gMSA/IFwic1wiIDogXCJcIn1gKTtcblx0aWYgKHVzYWdlLmlucHV0KSBwYXJ0cy5wdXNoKGBcdTIxOTEke2Zvcm1hdFRva2VuQ291bnQodXNhZ2UuaW5wdXQpfWApO1xuXHRpZiAodXNhZ2Uub3V0cHV0KSBwYXJ0cy5wdXNoKGBcdTIxOTMke2Zvcm1hdFRva2VuQ291bnQodXNhZ2Uub3V0cHV0KX1gKTtcblx0aWYgKHVzYWdlLmNhY2hlUmVhZCkgcGFydHMucHVzaChgUiR7Zm9ybWF0VG9rZW5Db3VudCh1c2FnZS5jYWNoZVJlYWQpfWApO1xuXHRpZiAodXNhZ2UuY2FjaGVXcml0ZSkgcGFydHMucHVzaChgVyR7Zm9ybWF0VG9rZW5Db3VudCh1c2FnZS5jYWNoZVdyaXRlKX1gKTtcblx0aWYgKHVzYWdlLmNvc3QpIHBhcnRzLnB1c2goYCQkeyhOdW1iZXIodXNhZ2UuY29zdCkgfHwgMCkudG9GaXhlZCg0KX1gKTtcblx0aWYgKHVzYWdlLmNvbnRleHRUb2tlbnMgJiYgdXNhZ2UuY29udGV4dFRva2VucyA+IDApIHtcblx0XHRwYXJ0cy5wdXNoKGBjdHg6JHtmb3JtYXRUb2tlbkNvdW50KHVzYWdlLmNvbnRleHRUb2tlbnMpfWApO1xuXHR9XG5cdGlmIChtb2RlbCkgcGFydHMucHVzaChtb2RlbCk7XG5cdHJldHVybiBwYXJ0cy5qb2luKFwiIFwiKTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0VG9vbENhbGwoXG5cdHRvb2xOYW1lOiBzdHJpbmcsXG5cdGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuXHR0aGVtZUZnOiAoY29sb3I6IGFueSwgdGV4dDogc3RyaW5nKSA9PiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuXHRjb25zdCBzaG9ydGVuUGF0aCA9IChwOiBzdHJpbmcpID0+IHtcblx0XHRjb25zdCBob21lID0gb3MuaG9tZWRpcigpO1xuXHRcdHJldHVybiBwLnN0YXJ0c1dpdGgoaG9tZSkgPyBgfiR7cC5zbGljZShob21lLmxlbmd0aCl9YCA6IHA7XG5cdH07XG5cblx0c3dpdGNoICh0b29sTmFtZSkge1xuXHRcdGNhc2UgXCJiYXNoXCI6IHtcblx0XHRcdGNvbnN0IGNvbW1hbmQgPSAoYXJncy5jb21tYW5kIGFzIHN0cmluZykgfHwgXCIuLi5cIjtcblx0XHRcdGNvbnN0IHByZXZpZXcgPSBjb21tYW5kLmxlbmd0aCA+IDYwID8gYCR7Y29tbWFuZC5zbGljZSgwLCA2MCl9Li4uYCA6IGNvbW1hbmQ7XG5cdFx0XHRyZXR1cm4gdGhlbWVGZyhcIm11dGVkXCIsIFwiJCBcIikgKyB0aGVtZUZnKFwidG9vbE91dHB1dFwiLCBwcmV2aWV3KTtcblx0XHR9XG5cdFx0Y2FzZSBcInJlYWRcIjoge1xuXHRcdFx0Y29uc3QgcmF3UGF0aCA9IChhcmdzLmZpbGVfcGF0aCB8fCBhcmdzLnBhdGggfHwgXCIuLi5cIikgYXMgc3RyaW5nO1xuXHRcdFx0Y29uc3QgZmlsZVBhdGggPSBzaG9ydGVuUGF0aChyYXdQYXRoKTtcblx0XHRcdGNvbnN0IG9mZnNldCA9IGFyZ3Mub2Zmc2V0IGFzIG51bWJlciB8IHVuZGVmaW5lZDtcblx0XHRcdGNvbnN0IGxpbWl0ID0gYXJncy5saW1pdCBhcyBudW1iZXIgfCB1bmRlZmluZWQ7XG5cdFx0XHRsZXQgdGV4dCA9IHRoZW1lRmcoXCJhY2NlbnRcIiwgZmlsZVBhdGgpO1xuXHRcdFx0aWYgKG9mZnNldCAhPT0gdW5kZWZpbmVkIHx8IGxpbWl0ICE9PSB1bmRlZmluZWQpIHtcblx0XHRcdFx0Y29uc3Qgc3RhcnRMaW5lID0gb2Zmc2V0ID8/IDE7XG5cdFx0XHRcdGNvbnN0IGVuZExpbmUgPSBsaW1pdCAhPT0gdW5kZWZpbmVkID8gc3RhcnRMaW5lICsgbGltaXQgLSAxIDogXCJcIjtcblx0XHRcdFx0dGV4dCArPSB0aGVtZUZnKFwid2FybmluZ1wiLCBgOiR7c3RhcnRMaW5lfSR7ZW5kTGluZSA/IGAtJHtlbmRMaW5lfWAgOiBcIlwifWApO1xuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIHRoZW1lRmcoXCJtdXRlZFwiLCBcInJlYWQgXCIpICsgdGV4dDtcblx0XHR9XG5cdFx0Y2FzZSBcIndyaXRlXCI6IHtcblx0XHRcdGNvbnN0IHJhd1BhdGggPSAoYXJncy5maWxlX3BhdGggfHwgYXJncy5wYXRoIHx8IFwiLi4uXCIpIGFzIHN0cmluZztcblx0XHRcdGNvbnN0IGZpbGVQYXRoID0gc2hvcnRlblBhdGgocmF3UGF0aCk7XG5cdFx0XHRjb25zdCBjb250ZW50ID0gKGFyZ3MuY29udGVudCB8fCBcIlwiKSBhcyBzdHJpbmc7XG5cdFx0XHRjb25zdCBsaW5lcyA9IGNvbnRlbnQuc3BsaXQoXCJcXG5cIikubGVuZ3RoO1xuXHRcdFx0bGV0IHRleHQgPSB0aGVtZUZnKFwibXV0ZWRcIiwgXCJ3cml0ZSBcIikgKyB0aGVtZUZnKFwiYWNjZW50XCIsIGZpbGVQYXRoKTtcblx0XHRcdGlmIChsaW5lcyA+IDEpIHRleHQgKz0gdGhlbWVGZyhcImRpbVwiLCBgICgke2xpbmVzfSBsaW5lcylgKTtcblx0XHRcdHJldHVybiB0ZXh0O1xuXHRcdH1cblx0XHRjYXNlIFwiZWRpdFwiOiB7XG5cdFx0XHRjb25zdCByYXdQYXRoID0gKGFyZ3MuZmlsZV9wYXRoIHx8IGFyZ3MucGF0aCB8fCBcIi4uLlwiKSBhcyBzdHJpbmc7XG5cdFx0XHRyZXR1cm4gdGhlbWVGZyhcIm11dGVkXCIsIFwiZWRpdCBcIikgKyB0aGVtZUZnKFwiYWNjZW50XCIsIHNob3J0ZW5QYXRoKHJhd1BhdGgpKTtcblx0XHR9XG5cdFx0Y2FzZSBcImxzXCI6IHtcblx0XHRcdGNvbnN0IHJhd1BhdGggPSAoYXJncy5wYXRoIHx8IFwiLlwiKSBhcyBzdHJpbmc7XG5cdFx0XHRyZXR1cm4gdGhlbWVGZyhcIm11dGVkXCIsIFwibHMgXCIpICsgdGhlbWVGZyhcImFjY2VudFwiLCBzaG9ydGVuUGF0aChyYXdQYXRoKSk7XG5cdFx0fVxuXHRcdGNhc2UgXCJmaW5kXCI6IHtcblx0XHRcdGNvbnN0IHBhdHRlcm4gPSAoYXJncy5wYXR0ZXJuIHx8IFwiKlwiKSBhcyBzdHJpbmc7XG5cdFx0XHRjb25zdCByYXdQYXRoID0gKGFyZ3MucGF0aCB8fCBcIi5cIikgYXMgc3RyaW5nO1xuXHRcdFx0cmV0dXJuIHRoZW1lRmcoXCJtdXRlZFwiLCBcImZpbmQgXCIpICsgdGhlbWVGZyhcImFjY2VudFwiLCBwYXR0ZXJuKSArIHRoZW1lRmcoXCJkaW1cIiwgYCBpbiAke3Nob3J0ZW5QYXRoKHJhd1BhdGgpfWApO1xuXHRcdH1cblx0XHRjYXNlIFwiZ3JlcFwiOiB7XG5cdFx0XHRjb25zdCBwYXR0ZXJuID0gKGFyZ3MucGF0dGVybiB8fCBcIlwiKSBhcyBzdHJpbmc7XG5cdFx0XHRjb25zdCByYXdQYXRoID0gKGFyZ3MucGF0aCB8fCBcIi5cIikgYXMgc3RyaW5nO1xuXHRcdFx0cmV0dXJuIChcblx0XHRcdFx0dGhlbWVGZyhcIm11dGVkXCIsIFwiZ3JlcCBcIikgK1xuXHRcdFx0XHR0aGVtZUZnKFwiYWNjZW50XCIsIGAvJHtwYXR0ZXJufS9gKSArXG5cdFx0XHRcdHRoZW1lRmcoXCJkaW1cIiwgYCBpbiAke3Nob3J0ZW5QYXRoKHJhd1BhdGgpfWApXG5cdFx0XHQpO1xuXHRcdH1cblx0XHRkZWZhdWx0OiB7XG5cdFx0XHRjb25zdCBhcmdzU3RyID0gSlNPTi5zdHJpbmdpZnkoYXJncyk7XG5cdFx0XHRjb25zdCBwcmV2aWV3ID0gYXJnc1N0ci5sZW5ndGggPiA1MCA/IGAke2FyZ3NTdHIuc2xpY2UoMCwgNTApfS4uLmAgOiBhcmdzU3RyO1xuXHRcdFx0cmV0dXJuIHRoZW1lRmcoXCJhY2NlbnRcIiwgdG9vbE5hbWUpICsgdGhlbWVGZyhcImRpbVwiLCBgICR7cHJldmlld31gKTtcblx0XHR9XG5cdH1cbn1cblxuaW50ZXJmYWNlIFVzYWdlU3RhdHMge1xuXHRpbnB1dDogbnVtYmVyO1xuXHRvdXRwdXQ6IG51bWJlcjtcblx0Y2FjaGVSZWFkOiBudW1iZXI7XG5cdGNhY2hlV3JpdGU6IG51bWJlcjtcblx0Y29zdDogbnVtYmVyO1xuXHRjb250ZXh0VG9rZW5zOiBudW1iZXI7XG5cdHR1cm5zOiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBTaW5nbGVSZXN1bHQge1xuXHRhZ2VudDogc3RyaW5nO1xuXHR0cmFja2luZ05hbWU/OiBzdHJpbmc7XG5cdGFnZW50U291cmNlOiBcInVzZXJcIiB8IFwicHJvamVjdFwiIHwgXCJ1bmtub3duXCI7XG5cdHRhc2s6IHN0cmluZztcblx0ZXhpdENvZGU6IG51bWJlcjtcblx0cnVubmluZz86IGJvb2xlYW47XG5cdG1lc3NhZ2VzOiBNZXNzYWdlW107XG5cdHN0ZGVycjogc3RyaW5nO1xuXHR1c2FnZTogVXNhZ2VTdGF0cztcblx0bW9kZWw/OiBzdHJpbmc7XG5cdHN0b3BSZWFzb24/OiBzdHJpbmc7XG5cdGVycm9yTWVzc2FnZT86IHN0cmluZztcblx0c2Vzc2lvbkZpbGU/OiBzdHJpbmc7XG5cdG1lcmdlUmVzdWx0PzogTWVyZ2VSZXN1bHQ7XG5cdHN0ZXA/OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBTdWJhZ2VudERldGFpbHMge1xuXHRtb2RlOiBcInNpbmdsZVwiIHwgXCJwYXJhbGxlbFwiIHwgXCJjaGFpblwiO1xuXHRhZ2VudFNjb3BlOiBBZ2VudFNjb3BlO1xuXHRwcm9qZWN0QWdlbnRzRGlyOiBzdHJpbmcgfCBudWxsO1xuXHRyZXN1bHRzOiBTaW5nbGVSZXN1bHRbXTtcbn1cblxuZnVuY3Rpb24gZ2V0RmluYWxPdXRwdXQobWVzc2FnZXM6IE1lc3NhZ2VbXSk6IHN0cmluZyB7XG5cdGZvciAobGV0IGkgPSBtZXNzYWdlcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuXHRcdGNvbnN0IG1zZyA9IG1lc3NhZ2VzW2ldO1xuXHRcdGlmIChtc2cucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0Zm9yIChjb25zdCBwYXJ0IG9mIG1zZy5jb250ZW50KSB7XG5cdFx0XHRcdGlmIChwYXJ0LnR5cGUgPT09IFwidGV4dFwiKSByZXR1cm4gcGFydC50ZXh0O1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXHRyZXR1cm4gXCJcIjtcbn1cblxudHlwZSBEaXNwbGF5SXRlbSA9IHsgdHlwZTogXCJ0ZXh0XCI7IHRleHQ6IHN0cmluZyB9IHwgeyB0eXBlOiBcInRvb2xDYWxsXCI7IG5hbWU6IHN0cmluZzsgYXJnczogUmVjb3JkPHN0cmluZywgYW55PiB9O1xuXG5mdW5jdGlvbiBnZXREaXNwbGF5SXRlbXMobWVzc2FnZXM6IE1lc3NhZ2VbXSk6IERpc3BsYXlJdGVtW10ge1xuXHRjb25zdCBpdGVtczogRGlzcGxheUl0ZW1bXSA9IFtdO1xuXHRmb3IgKGNvbnN0IG1zZyBvZiBtZXNzYWdlcykge1xuXHRcdGlmIChtc2cucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuXHRcdFx0Zm9yIChjb25zdCBwYXJ0IG9mIG1zZy5jb250ZW50KSB7XG5cdFx0XHRcdGlmIChwYXJ0LnR5cGUgPT09IFwidGV4dFwiKSBpdGVtcy5wdXNoKHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHBhcnQudGV4dCB9KTtcblx0XHRcdFx0ZWxzZSBpZiAocGFydC50eXBlID09PSBcInRvb2xDYWxsXCIpIGl0ZW1zLnB1c2goeyB0eXBlOiBcInRvb2xDYWxsXCIsIG5hbWU6IHBhcnQubmFtZSwgYXJnczogcGFydC5hcmd1bWVudHMgfSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cdHJldHVybiBpdGVtcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFwV2l0aENvbmN1cnJlbmN5TGltaXQ8VEluLCBUT3V0Pihcblx0aXRlbXM6IFRJbltdLFxuXHRjb25jdXJyZW5jeTogbnVtYmVyLFxuXHRmbjogKGl0ZW06IFRJbiwgaW5kZXg6IG51bWJlcikgPT4gUHJvbWlzZTxUT3V0Pixcbik6IFByb21pc2U8VE91dFtdPiB7XG5cdGlmIChpdGVtcy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcblx0Y29uc3QgbGltaXQgPSBNYXRoLm1heCgxLCBNYXRoLm1pbihjb25jdXJyZW5jeSwgaXRlbXMubGVuZ3RoKSk7XG5cdGNvbnN0IHJlc3VsdHM6IFRPdXRbXSA9IG5ldyBBcnJheShpdGVtcy5sZW5ndGgpO1xuXHRsZXQgbmV4dEluZGV4ID0gMDtcblx0Y29uc3Qgd29ya2VycyA9IG5ldyBBcnJheShsaW1pdCkuZmlsbChudWxsKS5tYXAoYXN5bmMgKCkgPT4ge1xuXHRcdHdoaWxlICh0cnVlKSB7XG5cdFx0XHRjb25zdCBjdXJyZW50ID0gbmV4dEluZGV4Kys7XG5cdFx0XHRpZiAoY3VycmVudCA+PSBpdGVtcy5sZW5ndGgpIHJldHVybjtcblx0XHRcdHJlc3VsdHNbY3VycmVudF0gPSBhd2FpdCBmbihpdGVtc1tjdXJyZW50XSwgY3VycmVudCk7XG5cdFx0fVxuXHR9KTtcblx0YXdhaXQgUHJvbWlzZS5hbGwod29ya2Vycyk7XG5cdHJldHVybiByZXN1bHRzO1xufVxuXG5mdW5jdGlvbiB3cml0ZVByb21wdFRvVGVtcEZpbGUoYWdlbnROYW1lOiBzdHJpbmcsIHByb21wdDogc3RyaW5nKTogeyBkaXI6IHN0cmluZzsgZmlsZVBhdGg6IHN0cmluZyB9IHtcblx0Y29uc3QgdG1wRGlyID0gZnMubWtkdGVtcFN5bmMocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcInBpLXN1YmFnZW50LVwiKSk7XG5cdGNvbnN0IHNhZmVOYW1lID0gYWdlbnROYW1lLnJlcGxhY2UoL1teXFx3Li1dKy9nLCBcIl9cIik7XG5cdGNvbnN0IGZpbGVQYXRoID0gcGF0aC5qb2luKHRtcERpciwgYHByb21wdC0ke3NhZmVOYW1lfS5tZGApO1xuXHRmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBwcm9tcHQsIHsgZW5jb2Rpbmc6IFwidXRmLThcIiwgbW9kZTogMG82MDAgfSk7XG5cdHJldHVybiB7IGRpcjogdG1wRGlyLCBmaWxlUGF0aCB9O1xufVxuXG5mdW5jdGlvbiBwcm9jZXNzU3ViYWdlbnRFdmVudExpbmUoXG5cdGxpbmU6IHN0cmluZyxcblx0Y3VycmVudFJlc3VsdDogU2luZ2xlUmVzdWx0LFxuXHRlbWl0VXBkYXRlOiAoKSA9PiB2b2lkLFxuKTogdm9pZCB7XG5cdGlmICghbGluZS50cmltKCkpIHJldHVybjtcblx0bGV0IGV2ZW50OiBhbnk7XG5cdHRyeSB7XG5cdFx0ZXZlbnQgPSBKU09OLnBhcnNlKGxpbmUpO1xuXHR9IGNhdGNoIHtcblx0XHRyZXR1cm47XG5cdH1cblxuXHRpZiAoZXZlbnQudHlwZSA9PT0gXCJtZXNzYWdlX2VuZFwiICYmIGV2ZW50Lm1lc3NhZ2UpIHtcblx0XHRjb25zdCBtc2cgPSBldmVudC5tZXNzYWdlIGFzIE1lc3NhZ2U7XG5cdFx0Y3VycmVudFJlc3VsdC5tZXNzYWdlcy5wdXNoKG1zZyk7XG5cblx0XHRpZiAobXNnLnJvbGUgPT09IFwiYXNzaXN0YW50XCIpIHtcblx0XHRcdGN1cnJlbnRSZXN1bHQudXNhZ2UudHVybnMrKztcblx0XHRcdGNvbnN0IHVzYWdlID0gbXNnLnVzYWdlO1xuXHRcdFx0aWYgKHVzYWdlKSB7XG5cdFx0XHRcdGN1cnJlbnRSZXN1bHQudXNhZ2UuaW5wdXQgKz0gdXNhZ2UuaW5wdXQgfHwgMDtcblx0XHRcdFx0Y3VycmVudFJlc3VsdC51c2FnZS5vdXRwdXQgKz0gdXNhZ2Uub3V0cHV0IHx8IDA7XG5cdFx0XHRcdGN1cnJlbnRSZXN1bHQudXNhZ2UuY2FjaGVSZWFkICs9IHVzYWdlLmNhY2hlUmVhZCB8fCAwO1xuXHRcdFx0XHRjdXJyZW50UmVzdWx0LnVzYWdlLmNhY2hlV3JpdGUgKz0gdXNhZ2UuY2FjaGVXcml0ZSB8fCAwO1xuXHRcdFx0XHRjdXJyZW50UmVzdWx0LnVzYWdlLmNvc3QgKz0gdXNhZ2UuY29zdD8udG90YWwgfHwgMDtcblx0XHRcdFx0Y3VycmVudFJlc3VsdC51c2FnZS5jb250ZXh0VG9rZW5zID0gdXNhZ2UudG90YWxUb2tlbnMgfHwgMDtcblx0XHRcdH1cblx0XHRcdGlmICghY3VycmVudFJlc3VsdC5tb2RlbCAmJiBtc2cubW9kZWwpIGN1cnJlbnRSZXN1bHQubW9kZWwgPSBtc2cubW9kZWw7XG5cdFx0XHRpZiAobXNnLnN0b3BSZWFzb24pIGN1cnJlbnRSZXN1bHQuc3RvcFJlYXNvbiA9IG1zZy5zdG9wUmVhc29uO1xuXHRcdFx0aWYgKG1zZy5lcnJvck1lc3NhZ2UpIGN1cnJlbnRSZXN1bHQuZXJyb3JNZXNzYWdlID0gbXNnLmVycm9yTWVzc2FnZTtcblx0XHR9XG5cdFx0ZW1pdFVwZGF0ZSgpO1xuXHR9XG5cblx0aWYgKGV2ZW50LnR5cGUgPT09IFwidG9vbF9yZXN1bHRfZW5kXCIgJiYgZXZlbnQubWVzc2FnZSkge1xuXHRcdGN1cnJlbnRSZXN1bHQubWVzc2FnZXMucHVzaChldmVudC5tZXNzYWdlIGFzIE1lc3NhZ2UpO1xuXHRcdGVtaXRVcGRhdGUoKTtcblx0fVxufVxuXG5hc3luYyBmdW5jdGlvbiB3YWl0Rm9yRmlsZShmaWxlUGF0aDogc3RyaW5nLCBzaWduYWw6IEFib3J0U2lnbmFsIHwgdW5kZWZpbmVkLCB0aW1lb3V0TXMgPSAzMCAqIDYwICogMTAwMCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcblx0d2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkIDwgdGltZW91dE1zKSB7XG5cdFx0aWYgKHNpZ25hbD8uYWJvcnRlZCkgcmV0dXJuIGZhbHNlO1xuXHRcdGlmIChmcy5leGlzdHNTeW5jKGZpbGVQYXRoKSkgcmV0dXJuIHRydWU7XG5cdFx0YXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMTUwKSk7XG5cdH1cblx0cmV0dXJuIGZhbHNlO1xufVxuXG50eXBlIE9uVXBkYXRlQ2FsbGJhY2sgPSAocGFydGlhbDogQWdlbnRUb29sUmVzdWx0PFN1YmFnZW50RGV0YWlscz4pID0+IHZvaWQ7XG5cbmludGVyZmFjZSBUYXNrUGFyYW0ge1xuXHRhZ2VudDogc3RyaW5nO1xuXHR0YXNrOiBzdHJpbmc7XG5cdGN3ZD86IHN0cmluZztcblx0bW9kZWw/OiBzdHJpbmc7XG5cdGNvbnRleHQ/OiBTdWJhZ2VudENvbnRleHRNb2RlO1xufVxuXG5pbnRlcmZhY2UgQ2hhaW5QYXJhbSBleHRlbmRzIFRhc2tQYXJhbSB7fVxuXG5mdW5jdGlvbiByZXN1bHRTdGF0dXMocmVzdWx0OiBTaW5nbGVSZXN1bHQpOiBTdWJhZ2VudFJ1blN0YXR1cyB7XG5cdGlmIChyZXN1bHQuc3RvcFJlYXNvbiA9PT0gXCJhYm9ydGVkXCIpIHJldHVybiBcImludGVycnVwdGVkXCI7XG5cdHJldHVybiByZXN1bHQuZXhpdENvZGUgPT09IDAgPyBcInN1Y2NlZWRlZFwiIDogXCJmYWlsZWRcIjtcbn1cblxuZnVuY3Rpb24gcmVzdWx0VG9DaGlsZEFydGlmYWN0KHJlc3VsdDogU2luZ2xlUmVzdWx0LCBpbmRleDogbnVtYmVyLCBjd2Q/OiBzdHJpbmcpOiBTdWJhZ2VudENoaWxkQXJ0aWZhY3Qge1xuXHRjb25zdCBydW5uaW5nID0gcmVzdWx0LnJ1bm5pbmcgPT09IHRydWUgfHwgcmVzdWx0LmV4aXRDb2RlID09PSAtMTtcblx0cmV0dXJuIHtcblx0XHRpbmRleCxcblx0XHRhZ2VudDogcmVzdWx0LmFnZW50LFxuXHRcdHRyYWNraW5nTmFtZTogcmVzdWx0LnRyYWNraW5nTmFtZSxcblx0XHR0YXNrOiByZXN1bHQudGFzayxcblx0XHRzdGF0dXM6IHJ1bm5pbmcgPyBcInJ1bm5pbmdcIiA6IHJlc3VsdFN0YXR1cyhyZXN1bHQpLFxuXHRcdGV4aXRDb2RlOiByZXN1bHQuZXhpdENvZGUsXG5cdFx0Y3dkLFxuXHRcdHNlc3Npb25GaWxlOiByZXN1bHQuc2Vzc2lvbkZpbGUsXG5cdFx0Y29tcGxldGVkQXQ6IHJ1bm5pbmcgPyB1bmRlZmluZWQgOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0b3V0cHV0OiBnZXRGaW5hbE91dHB1dChyZXN1bHQubWVzc2FnZXMpLFxuXHRcdHN0ZGVycjogcmVzdWx0LnN0ZGVyciB8fCB1bmRlZmluZWQsXG5cdFx0ZXJyb3JNZXNzYWdlOiByZXN1bHQuZXJyb3JNZXNzYWdlLFxuXHRcdHN0b3BSZWFzb246IHJlc3VsdC5zdG9wUmVhc29uLFxuXHRcdG1vZGVsOiByZXN1bHQubW9kZWwsXG5cdFx0dXNhZ2U6IHJlc3VsdC51c2FnZSxcblx0XHRtZXJnZTogcmVzdWx0Lm1lcmdlUmVzdWx0XG5cdFx0XHQ/IHtcblx0XHRcdFx0XHRzdWNjZXNzOiByZXN1bHQubWVyZ2VSZXN1bHQuc3VjY2Vzcyxcblx0XHRcdFx0XHRhcHBsaWVkUGF0Y2hlczogcmVzdWx0Lm1lcmdlUmVzdWx0LmFwcGxpZWRQYXRjaGVzLFxuXHRcdFx0XHRcdGZhaWxlZFBhdGNoZXM6IHJlc3VsdC5tZXJnZVJlc3VsdC5mYWlsZWRQYXRjaGVzLFxuXHRcdFx0XHRcdGVycm9yOiByZXN1bHQubWVyZ2VSZXN1bHQuZXJyb3IsXG5cdFx0XHRcdH1cblx0XHRcdDogdW5kZWZpbmVkLFxuXHR9O1xufVxuXG5mdW5jdGlvbiBmb3JtYXRBZ2VudExhYmVsKGFnZW50OiBzdHJpbmcsIHRyYWNraW5nTmFtZT86IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiB0cmFja2luZ05hbWUgPyBgJHt0cmFja2luZ05hbWV9IC8gJHthZ2VudH1gIDogYWdlbnQ7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdFJ1blJlY29yZChyZWNvcmQ6IFJldHVyblR5cGU8U3ViYWdlbnRSdW5TdG9yZVtcImdldFwiXT4pOiBzdHJpbmcge1xuXHRpZiAoIXJlY29yZCkgcmV0dXJuIFwiU3ViYWdlbnQgcnVuIG5vdCBmb3VuZC5cIjtcblx0Y29uc3QgbGluZXMgPSBbXG5cdFx0YFJ1biAke3JlY29yZC5ydW5JZH06ICR7cmVjb3JkLnN0YXR1c31gLFxuXHRcdGBNb2RlOiAke3JlY29yZC5tb2RlfWAsXG5cdFx0YENvbnRleHQ6ICR7cmVjb3JkLmNvbnRleHRNb2RlfWAsXG5cdFx0YFVwZGF0ZWQ6ICR7cmVjb3JkLnVwZGF0ZWRBdH1gLFxuXHRdO1xuXHRmb3IgKGNvbnN0IGNoaWxkIG9mIHJlY29yZC5jaGlsZHJlbikge1xuXHRcdGNvbnN0IGV4aXQgPSBjaGlsZC5leGl0Q29kZSA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IGAgKGV4aXQgJHtjaGlsZC5leGl0Q29kZX0pYDtcblx0XHRsaW5lcy5wdXNoKGAtIFske2NoaWxkLnN0YXR1c31dICR7Zm9ybWF0QWdlbnRMYWJlbChjaGlsZC5hZ2VudCwgY2hpbGQudHJhY2tpbmdOYW1lKX0ke2V4aXR9OiAke2NoaWxkLm91dHB1dCB8fCBjaGlsZC5lcnJvck1lc3NhZ2UgfHwgY2hpbGQuc3RkZXJyIHx8IGNoaWxkLnRhc2t9YCk7XG5cdFx0aWYgKGNoaWxkLnNlc3Npb25GaWxlKSBsaW5lcy5wdXNoKGAgIHNlc3Npb246ICR7Y2hpbGQuc2Vzc2lvbkZpbGV9YCk7XG5cdH1cblx0aWYgKHJlY29yZC5mYWlsdXJlKSBsaW5lcy5wdXNoKGBGYWlsdXJlOiAke3JlY29yZC5mYWlsdXJlLm1lc3NhZ2V9YCk7XG5cdHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5TaW5nbGVBZ2VudChcblx0ZGVmYXVsdEN3ZDogc3RyaW5nLFxuXHRhZ2VudHM6IEFnZW50Q29uZmlnW10sXG5cdGFnZW50TmFtZTogc3RyaW5nLFxuXHR0YXNrOiBzdHJpbmcsXG5cdGN3ZDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuXHRzdGVwOiBudW1iZXIgfCB1bmRlZmluZWQsXG5cdHNpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsXG5cdG9uVXBkYXRlOiBPblVwZGF0ZUNhbGxiYWNrIHwgdW5kZWZpbmVkLFxuXHRtYWtlRGV0YWlsczogKHJlc3VsdHM6IFNpbmdsZVJlc3VsdFtdKSA9PiBTdWJhZ2VudERldGFpbHMsXG5cdG1vZGVsT3ZlcnJpZGU/OiBzdHJpbmcsXG5cdGNvbnRleHRNb2RlOiBTdWJhZ2VudENvbnRleHRNb2RlID0gXCJmcmVzaFwiLFxuXHRwYXJlbnRTZXNzaW9uTWFuYWdlcj86IFBhcmFtZXRlcnM8dHlwZW9mIGNyZWF0ZVN1YmFnZW50TGF1bmNoUGxhbj5bMF1bXCJwYXJlbnRTZXNzaW9uTWFuYWdlclwiXSxcblx0c2Vzc2lvbk92ZXJyaWRlPzogU3ViYWdlbnRTZXNzaW9uQXJncyxcblx0dHJhY2tpbmdOYW1lPzogc3RyaW5nLFxuKTogUHJvbWlzZTxTaW5nbGVSZXN1bHQ+IHtcblx0Y29uc3QgYWdlbnQgPSBhZ2VudHMuZmluZCgoYSkgPT4gYS5uYW1lID09PSBhZ2VudE5hbWUpO1xuXG5cdGlmICghYWdlbnQpIHtcblx0XHRjb25zdCBhdmFpbGFibGUgPSBhZ2VudHMubWFwKChhKSA9PiBgXCIke2EubmFtZX1cImApLmpvaW4oXCIsIFwiKSB8fCBcIm5vbmVcIjtcblx0XHRyZXR1cm4ge1xuXHRcdFx0YWdlbnQ6IGFnZW50TmFtZSxcblx0XHRcdHRyYWNraW5nTmFtZSxcblx0XHRcdGFnZW50U291cmNlOiBcInVua25vd25cIixcblx0XHRcdHRhc2ssXG5cdFx0XHRleGl0Q29kZTogMSxcblx0XHRcdG1lc3NhZ2VzOiBbXSxcblx0XHRcdHN0ZGVycjogYFVua25vd24gYWdlbnQ6IFwiJHthZ2VudE5hbWV9XCIuIEF2YWlsYWJsZSBhZ2VudHM6ICR7YXZhaWxhYmxlfS5gLFxuXHRcdFx0dXNhZ2U6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCBjb3N0OiAwLCBjb250ZXh0VG9rZW5zOiAwLCB0dXJuczogMCB9LFxuXHRcdFx0c3RlcCxcblx0XHR9O1xuXHR9XG5cblx0Ly8gR1NEIHBoYXNlIGd1YXJkOiBibG9jayBhZ2VudHMgdGhhdCBjb25mbGljdCB3aXRoIHRoZSBhY3RpdmUgR1NEIHBoYXNlXG5cdGlmIChhZ2VudC5jb25mbGljdHNXaXRoICYmIGFnZW50LmNvbmZsaWN0c1dpdGgubGVuZ3RoID4gMCkge1xuXHRcdGNvbnN0IGFjdGl2ZVBoYXNlID0gZ2V0Q3VycmVudFBoYXNlKCk7XG5cdFx0aWYgKGFjdGl2ZVBoYXNlICYmIGFnZW50LmNvbmZsaWN0c1dpdGguaW5jbHVkZXMoYWN0aXZlUGhhc2UpKSB7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRhZ2VudDogYWdlbnROYW1lLFxuXHRcdFx0XHR0cmFja2luZ05hbWUsXG5cdFx0XHRcdGFnZW50U291cmNlOiBhZ2VudC5zb3VyY2UsXG5cdFx0XHRcdHRhc2ssXG5cdFx0XHRcdGV4aXRDb2RlOiAxLFxuXHRcdFx0XHRtZXNzYWdlczogW10sXG5cdFx0XHRcdHN0ZGVycjogYEFnZW50IFwiJHthZ2VudE5hbWV9XCIgaXMgYmxvY2tlZDogaXQgY29uZmxpY3RzIHdpdGggdGhlIGFjdGl2ZSBHU0QgcGhhc2UgXCIke2FjdGl2ZVBoYXNlfVwiLiBVc2UgdGhlIGJ1aWx0LWluIEdTRCB3b3JrZmxvdyBpbnN0ZWFkLmAsXG5cdFx0XHRcdHVzYWdlOiB7IGlucHV0OiAwLCBvdXRwdXQ6IDAsIGNhY2hlUmVhZDogMCwgY2FjaGVXcml0ZTogMCwgY29zdDogMCwgY29udGV4dFRva2VuczogMCwgdHVybnM6IDAgfSxcblx0XHRcdFx0c3RlcCxcblx0XHRcdH07XG5cdFx0fVxuXHR9XG5cblx0bGV0IHRtcFByb21wdERpcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cdGxldCB0bXBQcm9tcHRQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuXHRjb25zdCBjdXJyZW50UmVzdWx0OiBTaW5nbGVSZXN1bHQgPSB7XG5cdFx0YWdlbnQ6IGFnZW50TmFtZSxcblx0XHR0cmFja2luZ05hbWUsXG5cdFx0YWdlbnRTb3VyY2U6IGFnZW50LnNvdXJjZSxcblx0XHR0YXNrLFxuXHRcdGV4aXRDb2RlOiAtMSxcblx0XHRydW5uaW5nOiB0cnVlLFxuXHRcdG1lc3NhZ2VzOiBbXSxcblx0XHRzdGRlcnI6IFwiXCIsXG5cdFx0dXNhZ2U6IHsgaW5wdXQ6IDAsIG91dHB1dDogMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwLCBjb3N0OiAwLCBjb250ZXh0VG9rZW5zOiAwLCB0dXJuczogMCB9LFxuXHRcdG1vZGVsOiBtb2RlbE92ZXJyaWRlID8/IGFnZW50Lm1vZGVsLFxuXHRcdHN0ZXAsXG5cdH07XG5cblx0Y29uc3QgZW1pdFVwZGF0ZSA9ICgpID0+IHtcblx0XHRpZiAob25VcGRhdGUpIHtcblx0XHRcdG9uVXBkYXRlKHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGdldEZpbmFsT3V0cHV0KGN1cnJlbnRSZXN1bHQubWVzc2FnZXMpIHx8IFwiKHJ1bm5pbmcuLi4pXCIgfV0sXG5cdFx0XHRcdGRldGFpbHM6IG1ha2VEZXRhaWxzKFtjdXJyZW50UmVzdWx0XSksXG5cdFx0XHR9KTtcblx0XHR9XG5cdH07XG5cblx0dHJ5IHtcblx0XHRpZiAoYWdlbnQuc3lzdGVtUHJvbXB0LnRyaW0oKSkge1xuXHRcdFx0Y29uc3QgdG1wID0gd3JpdGVQcm9tcHRUb1RlbXBGaWxlKGFnZW50Lm5hbWUsIGFnZW50LnN5c3RlbVByb21wdCk7XG5cdFx0XHR0bXBQcm9tcHREaXIgPSB0bXAuZGlyO1xuXHRcdFx0dG1wUHJvbXB0UGF0aCA9IHRtcC5maWxlUGF0aDtcblx0XHR9XG5cdFx0Y29uc3QgbGF1bmNoID0gY3JlYXRlU3ViYWdlbnRMYXVuY2hQbGFuKHtcblx0XHRcdGFnZW50LFxuXHRcdFx0dGFzayxcblx0XHRcdHRtcFByb21wdFBhdGgsXG5cdFx0XHRtb2RlbE92ZXJyaWRlLFxuXHRcdFx0Y29udGV4dE1vZGUsXG5cdFx0XHRwYXJlbnRTZXNzaW9uTWFuYWdlcixcblx0XHRcdHNlc3Npb246IHNlc3Npb25PdmVycmlkZSxcblx0XHRcdGN3ZCxcblx0XHRcdGRlZmF1bHRDd2QsXG5cdFx0fSk7XG5cdFx0aWYgKGxhdW5jaC5zZXNzaW9uLm1vZGUgPT09IFwiZm9ya1wiKSBjdXJyZW50UmVzdWx0LnNlc3Npb25GaWxlID0gbGF1bmNoLnNlc3Npb24uc2Vzc2lvbkZpbGU7XG5cdFx0bGV0IHdhc0Fib3J0ZWQgPSBmYWxzZTtcblxuXHRcdGNvbnN0IGV4aXRDb2RlID0gYXdhaXQgbmV3IFByb21pc2U8bnVtYmVyPigocmVzb2x2ZSkgPT4ge1xuXHRcdFx0Y29uc3QgYnVuZGxlZFBhdGhzID0gKHByb2Nlc3MuZW52LkdTRF9CVU5ETEVEX0VYVEVOU0lPTl9QQVRIUyA/PyBcIlwiKS5zcGxpdChwYXRoLmRlbGltaXRlcikubWFwKHMgPT4gcy50cmltKCkpLmZpbHRlcihCb29sZWFuKTtcblx0XHRcdGNvbnN0IGV4dGVuc2lvbkFyZ3MgPSBidW5kbGVkUGF0aHMuZmxhdE1hcChwID0+IFtcIi0tZXh0ZW5zaW9uXCIsIHBdKTtcblx0XHRcdGNvbnN0IHByb2MgPSBzcGF3bihcblx0XHRcdFx0cHJvY2Vzcy5leGVjUGF0aCxcblx0XHRcdFx0W3Byb2Nlc3MuZW52LkdTRF9CSU5fUEFUSCEsIC4uLmV4dGVuc2lvbkFyZ3MsIC4uLmxhdW5jaC5hcmdzXSxcblx0XHRcdFx0eyBjd2Q6IGxhdW5jaC5jd2QsIGVudjogbGF1bmNoLmVudiwgc2hlbGw6IGZhbHNlLCBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0gfSxcblx0XHRcdCk7XG5cdFx0XHRsaXZlU3ViYWdlbnRQcm9jZXNzZXMuYWRkKHByb2MpO1xuXHRcdFx0bGV0IGJ1ZmZlciA9IFwiXCI7XG5cblx0XHRcdHByb2Muc3Rkb3V0Lm9uKFwiZGF0YVwiLCAoZGF0YSkgPT4ge1xuXHRcdFx0XHRidWZmZXIgKz0gZGF0YS50b1N0cmluZygpO1xuXHRcdFx0XHRjb25zdCBsaW5lcyA9IGJ1ZmZlci5zcGxpdChcIlxcblwiKTtcblx0XHRcdFx0YnVmZmVyID0gbGluZXMucG9wKCkgfHwgXCJcIjtcblx0XHRcdFx0Zm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSBwcm9jZXNzU3ViYWdlbnRFdmVudExpbmUobGluZSwgY3VycmVudFJlc3VsdCwgZW1pdFVwZGF0ZSk7XG5cdFx0XHR9KTtcblxuXHRcdFx0cHJvYy5zdGRlcnIub24oXCJkYXRhXCIsIChkYXRhKSA9PiB7XG5cdFx0XHRcdGN1cnJlbnRSZXN1bHQuc3RkZXJyICs9IGRhdGEudG9TdHJpbmcoKTtcblx0XHRcdH0pO1xuXG5cdFx0XHRwcm9jLm9uKFwiY2xvc2VcIiwgKGNvZGUpID0+IHtcblx0XHRcdFx0bGl2ZVN1YmFnZW50UHJvY2Vzc2VzLmRlbGV0ZShwcm9jKTtcblx0XHRcdFx0aWYgKGJ1ZmZlci50cmltKCkpIHByb2Nlc3NTdWJhZ2VudEV2ZW50TGluZShidWZmZXIsIGN1cnJlbnRSZXN1bHQsIGVtaXRVcGRhdGUpO1xuXHRcdFx0XHRyZXNvbHZlKGNvZGUgPz8gMCk7XG5cdFx0XHR9KTtcblxuXHRcdFx0cHJvYy5vbihcImVycm9yXCIsICgpID0+IHtcblx0XHRcdFx0bGl2ZVN1YmFnZW50UHJvY2Vzc2VzLmRlbGV0ZShwcm9jKTtcblx0XHRcdFx0cmVzb2x2ZSgxKTtcblx0XHRcdH0pO1xuXG5cdFx0XHRpZiAoc2lnbmFsKSB7XG5cdFx0XHRcdGNvbnN0IGtpbGxQcm9jID0gKCkgPT4ge1xuXHRcdFx0XHRcdHdhc0Fib3J0ZWQgPSB0cnVlO1xuXHRcdFx0XHRcdHByb2Mua2lsbChcIlNJR1RFUk1cIik7XG5cdFx0XHRcdFx0c2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHRcdFx0XHRpZiAoIXByb2Mua2lsbGVkKSBwcm9jLmtpbGwoXCJTSUdLSUxMXCIpO1xuXHRcdFx0XHRcdH0sIDUwMDApO1xuXHRcdFx0XHR9O1xuXHRcdFx0XHRpZiAoc2lnbmFsLmFib3J0ZWQpIGtpbGxQcm9jKCk7XG5cdFx0XHRcdGVsc2Ugc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBraWxsUHJvYywgeyBvbmNlOiB0cnVlIH0pO1xuXHRcdFx0fVxuXHRcdH0pO1xuXG5cdFx0Y3VycmVudFJlc3VsdC5leGl0Q29kZSA9IGV4aXRDb2RlO1xuXHRcdGN1cnJlbnRSZXN1bHQucnVubmluZyA9IGZhbHNlO1xuXHRcdGlmICh3YXNBYm9ydGVkKSB0aHJvdyBuZXcgRXJyb3IoXCJTdWJhZ2VudCB3YXMgYWJvcnRlZFwiKTtcblx0XHRyZXR1cm4gY3VycmVudFJlc3VsdDtcblx0fSBmaW5hbGx5IHtcblx0XHRpZiAodG1wUHJvbXB0UGF0aClcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGZzLnVubGlua1N5bmModG1wUHJvbXB0UGF0aCk7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0LyogaWdub3JlICovXG5cdFx0XHR9XG5cdFx0aWYgKHRtcFByb21wdERpcilcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGZzLnJtZGlyU3luYyh0bXBQcm9tcHREaXIpO1xuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdC8qIGlnbm9yZSAqL1xuXHRcdFx0fVxuXHR9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1blNpbmdsZUFnZW50SW5DbXV4U3BsaXQoXG5cdGNtdXhDbGllbnQ6IENtdXhDbGllbnQsXG5cdGRpcmVjdGlvbk9yU3VyZmFjZUlkOiBcInJpZ2h0XCIgfCBcImRvd25cIiB8IHN0cmluZyxcblx0ZGVmYXVsdEN3ZDogc3RyaW5nLFxuXHRhZ2VudHM6IEFnZW50Q29uZmlnW10sXG5cdGFnZW50TmFtZTogc3RyaW5nLFxuXHR0YXNrOiBzdHJpbmcsXG5cdGN3ZDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuXHRzdGVwOiBudW1iZXIgfCB1bmRlZmluZWQsXG5cdHNpZ25hbDogQWJvcnRTaWduYWwgfCB1bmRlZmluZWQsXG5cdG9uVXBkYXRlOiBPblVwZGF0ZUNhbGxiYWNrIHwgdW5kZWZpbmVkLFxuXHRtYWtlRGV0YWlsczogKHJlc3VsdHM6IFNpbmdsZVJlc3VsdFtdKSA9PiBTdWJhZ2VudERldGFpbHMsXG5cdG1vZGVsT3ZlcnJpZGU/OiBzdHJpbmcsXG5cdGNvbnRleHRNb2RlOiBTdWJhZ2VudENvbnRleHRNb2RlID0gXCJmcmVzaFwiLFxuXHRwYXJlbnRTZXNzaW9uTWFuYWdlcj86IFBhcmFtZXRlcnM8dHlwZW9mIGNyZWF0ZVN1YmFnZW50TGF1bmNoUGxhbj5bMF1bXCJwYXJlbnRTZXNzaW9uTWFuYWdlclwiXSxcblx0c2Vzc2lvbk92ZXJyaWRlPzogU3ViYWdlbnRTZXNzaW9uQXJncyxcblx0dHJhY2tpbmdOYW1lPzogc3RyaW5nLFxuKTogUHJvbWlzZTxTaW5nbGVSZXN1bHQ+IHtcblx0Y29uc3QgYWdlbnQgPSBhZ2VudHMuZmluZCgoYSkgPT4gYS5uYW1lID09PSBhZ2VudE5hbWUpO1xuXHRpZiAoIWFnZW50KSB7XG5cdFx0cmV0dXJuIHJ1blNpbmdsZUFnZW50KGRlZmF1bHRDd2QsIGFnZW50cywgYWdlbnROYW1lLCB0YXNrLCBjd2QsIHN0ZXAsIHNpZ25hbCwgb25VcGRhdGUsIG1ha2VEZXRhaWxzLCBtb2RlbE92ZXJyaWRlLCBjb250ZXh0TW9kZSwgcGFyZW50U2Vzc2lvbk1hbmFnZXIsIHNlc3Npb25PdmVycmlkZSwgdHJhY2tpbmdOYW1lKTtcblx0fVxuXG5cdGxldCB0bXBQcm9tcHREaXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXHRsZXQgdG1wUHJvbXB0UGF0aDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cdGxldCB0bXBPdXRwdXREaXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5cdGNvbnN0IGN1cnJlbnRSZXN1bHQ6IFNpbmdsZVJlc3VsdCA9IHtcblx0XHRhZ2VudDogYWdlbnROYW1lLFxuXHRcdHRyYWNraW5nTmFtZSxcblx0XHRhZ2VudFNvdXJjZTogYWdlbnQuc291cmNlLFxuXHRcdHRhc2ssXG5cdFx0ZXhpdENvZGU6IC0xLFxuXHRcdHJ1bm5pbmc6IHRydWUsXG5cdFx0bWVzc2FnZXM6IFtdLFxuXHRcdHN0ZGVycjogXCJcIixcblx0XHR1c2FnZTogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIGNvc3Q6IDAsIGNvbnRleHRUb2tlbnM6IDAsIHR1cm5zOiAwIH0sXG5cdFx0bW9kZWw6IG1vZGVsT3ZlcnJpZGUgPz8gYWdlbnQubW9kZWwsXG5cdFx0c3RlcCxcblx0fTtcblxuXHRjb25zdCBlbWl0VXBkYXRlID0gKCkgPT4ge1xuXHRcdGlmIChvblVwZGF0ZSkge1xuXHRcdFx0b25VcGRhdGUoe1xuXHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogZ2V0RmluYWxPdXRwdXQoY3VycmVudFJlc3VsdC5tZXNzYWdlcykgfHwgXCIocnVubmluZy4uLilcIiB9XSxcblx0XHRcdFx0ZGV0YWlsczogbWFrZURldGFpbHMoW2N1cnJlbnRSZXN1bHRdKSxcblx0XHRcdH0pO1xuXHRcdH1cblx0fTtcblxuXHR0cnkge1xuXHRcdGlmIChhZ2VudC5zeXN0ZW1Qcm9tcHQudHJpbSgpKSB7XG5cdFx0XHRjb25zdCB0bXAgPSB3cml0ZVByb21wdFRvVGVtcEZpbGUoYWdlbnQubmFtZSwgYWdlbnQuc3lzdGVtUHJvbXB0KTtcblx0XHRcdHRtcFByb21wdERpciA9IHRtcC5kaXI7XG5cdFx0XHR0bXBQcm9tcHRQYXRoID0gdG1wLmZpbGVQYXRoO1xuXHRcdH1cblx0XHR0bXBPdXRwdXREaXIgPSBmcy5ta2R0ZW1wU3luYyhwYXRoLmpvaW4ob3MudG1wZGlyKCksIFwicGktc3ViYWdlbnQtY211eC1cIikpO1xuXHRcdGNvbnN0IHN0ZG91dFBhdGggPSBwYXRoLmpvaW4odG1wT3V0cHV0RGlyLCBcInN0ZG91dC5qc29ubFwiKTtcblx0XHRjb25zdCBzdGRlcnJQYXRoID0gcGF0aC5qb2luKHRtcE91dHB1dERpciwgXCJzdGRlcnIubG9nXCIpO1xuXHRcdGNvbnN0IGV4aXRQYXRoID0gcGF0aC5qb2luKHRtcE91dHB1dERpciwgXCJleGl0LmNvZGVcIik7XG5cdFx0Ly8gQWNjZXB0IGVpdGhlciBhIHByZS1jcmVhdGVkIHN1cmZhY2UgSUQgb3IgYSBkaXJlY3Rpb24gdG8gY3JlYXRlIGEgbmV3IHNwbGl0XG5cdFx0Y29uc3QgaXNEaXJlY3Rpb24gPSBkaXJlY3Rpb25PclN1cmZhY2VJZCA9PT0gXCJyaWdodFwiIHx8IGRpcmVjdGlvbk9yU3VyZmFjZUlkID09PSBcImRvd25cIlxuXHRcdFx0fHwgZGlyZWN0aW9uT3JTdXJmYWNlSWQgPT09IFwibGVmdFwiIHx8IGRpcmVjdGlvbk9yU3VyZmFjZUlkID09PSBcInVwXCI7XG5cdFx0Y29uc3QgY211eFN1cmZhY2VJZCA9IGlzRGlyZWN0aW9uXG5cdFx0XHQ/IGF3YWl0IGNtdXhDbGllbnQuY3JlYXRlU3BsaXQoZGlyZWN0aW9uT3JTdXJmYWNlSWQgYXMgXCJyaWdodFwiIHwgXCJkb3duXCIgfCBcImxlZnRcIiB8IFwidXBcIilcblx0XHRcdDogZGlyZWN0aW9uT3JTdXJmYWNlSWQ7XG5cdFx0aWYgKCFjbXV4U3VyZmFjZUlkKSB7XG5cdFx0XHRyZXR1cm4gcnVuU2luZ2xlQWdlbnQoZGVmYXVsdEN3ZCwgYWdlbnRzLCBhZ2VudE5hbWUsIHRhc2ssIGN3ZCwgc3RlcCwgc2lnbmFsLCBvblVwZGF0ZSwgbWFrZURldGFpbHMsIG1vZGVsT3ZlcnJpZGUsIGNvbnRleHRNb2RlLCBwYXJlbnRTZXNzaW9uTWFuYWdlciwgc2Vzc2lvbk92ZXJyaWRlLCB0cmFja2luZ05hbWUpO1xuXHRcdH1cblxuXHRcdGNvbnN0IGJ1bmRsZWRQYXRocyA9IChwcm9jZXNzLmVudi5HU0RfQlVORExFRF9FWFRFTlNJT05fUEFUSFMgPz8gXCJcIikuc3BsaXQocGF0aC5kZWxpbWl0ZXIpLm1hcCgocykgPT4gcy50cmltKCkpLmZpbHRlcihCb29sZWFuKTtcblx0XHRjb25zdCBleHRlbnNpb25BcmdzID0gYnVuZGxlZFBhdGhzLmZsYXRNYXAoKHApID0+IFtcIi0tZXh0ZW5zaW9uXCIsIHBdKTtcblx0XHRjb25zdCBsYXVuY2ggPSBjcmVhdGVTdWJhZ2VudExhdW5jaFBsYW4oe1xuXHRcdFx0YWdlbnQsXG5cdFx0XHR0YXNrLFxuXHRcdFx0dG1wUHJvbXB0UGF0aCxcblx0XHRcdG1vZGVsT3ZlcnJpZGUsXG5cdFx0XHRjb250ZXh0TW9kZSxcblx0XHRcdHBhcmVudFNlc3Npb25NYW5hZ2VyLFxuXHRcdFx0c2Vzc2lvbjogc2Vzc2lvbk92ZXJyaWRlLFxuXHRcdFx0Y3dkLFxuXHRcdFx0ZGVmYXVsdEN3ZCxcblx0XHR9KTtcblx0XHRpZiAobGF1bmNoLnNlc3Npb24ubW9kZSA9PT0gXCJmb3JrXCIpIGN1cnJlbnRSZXN1bHQuc2Vzc2lvbkZpbGUgPSBsYXVuY2guc2Vzc2lvbi5zZXNzaW9uRmlsZTtcblx0XHRjb25zdCBwcm9jZXNzQXJncyA9IFtwcm9jZXNzLmVudi5HU0RfQklOX1BBVEghLCAuLi5leHRlbnNpb25BcmdzLCAuLi5sYXVuY2guYXJnc107XG5cdFx0Ly8gTm9ybWFsaXplIGFsbCBwYXRocyB0byBmb3J3YXJkIHNsYXNoZXMgYmVmb3JlIGVtYmVkZGluZyBpbiBiYXNoIHN0cmluZ3MuXG5cdFx0Ly8gT24gV2luZG93cywgYmFja3NsYXNoZXMgYXJlIGludGVycHJldGVkIGFzIGVzY2FwZSBjaGFyYWN0ZXJzIGJ5IGJhc2gsXG5cdFx0Ly8gbWFuZ2xpbmcgcGF0aHMgbGlrZSBDOlxcVXNlcnNcXHVzZXIgaW50byBDOlVzZXJ1c2VyICgjMTQzNikuXG5cdFx0Y29uc3QgYmFzaFBhdGggPSAocDogc3RyaW5nKSA9PiBzaGVsbEVzY2FwZShwLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKSk7XG5cdFx0Y29uc3QgZW52UHJlZml4ID0gYnVpbGRTaGVsbEVudkFzc2lnbm1lbnRzKGxhdW5jaC5lbnYpLmpvaW4oXCIgXCIpO1xuXHRcdGNvbnN0IGNvbW1hbmRQcmVmaXggPSBlbnZQcmVmaXggPyBgJHtlbnZQcmVmaXh9IGAgOiBcIlwiO1xuXHRcdGNvbnN0IGlubmVyU2NyaXB0ID0gW1xuXHRcdFx0YGNkICR7YmFzaFBhdGgobGF1bmNoLmN3ZCl9YCxcblx0XHRcdFwic2V0IC1vIHBpcGVmYWlsXCIsXG5cdFx0XHRgJHtjb21tYW5kUHJlZml4fSR7YmFzaFBhdGgocHJvY2Vzcy5leGVjUGF0aCl9ICR7cHJvY2Vzc0FyZ3MubWFwKGEgPT4gYmFzaFBhdGgoYSkpLmpvaW4oXCIgXCIpfSAyPiA+KHRlZSAke2Jhc2hQYXRoKHN0ZGVyclBhdGgpfSA+JjIpIHwgdGVlICR7YmFzaFBhdGgoc3Rkb3V0UGF0aCl9YCxcblx0XHRcdFwic3RhdHVzPSR7UElQRVNUQVRVU1swXX1cIixcblx0XHRcdGBwcmludGYgJyVzJyBcIiRzdGF0dXNcIiA+ICR7YmFzaFBhdGgoZXhpdFBhdGgpfWAsXG5cdFx0XS5qb2luKFwiOyBcIik7XG5cblx0XHRjb25zdCBzZW50ID0gYXdhaXQgY211eENsaWVudC5zZW5kU3VyZmFjZShjbXV4U3VyZmFjZUlkLCBgYmFzaCAtbGMgJHtzaGVsbEVzY2FwZShpbm5lclNjcmlwdCl9YCk7XG5cdFx0aWYgKCFzZW50KSB7XG5cdFx0XHRyZXR1cm4gcnVuU2luZ2xlQWdlbnQoZGVmYXVsdEN3ZCwgYWdlbnRzLCBhZ2VudE5hbWUsIHRhc2ssIGN3ZCwgc3RlcCwgc2lnbmFsLCBvblVwZGF0ZSwgbWFrZURldGFpbHMsIG1vZGVsT3ZlcnJpZGUsIGNvbnRleHRNb2RlLCBwYXJlbnRTZXNzaW9uTWFuYWdlciwgc2Vzc2lvbk92ZXJyaWRlLCB0cmFja2luZ05hbWUpO1xuXHRcdH1cblxuXHRcdGNvbnN0IGZpbmlzaGVkID0gYXdhaXQgd2FpdEZvckZpbGUoZXhpdFBhdGgsIHNpZ25hbCk7XG5cdFx0aWYgKCFmaW5pc2hlZCkge1xuXHRcdFx0Ly8gVGVybWluYXRlIHRoZSBjaGlsZCBydW5uaW5nIGluc2lkZSB0aGUgY211eCBzcGxpdDogc2VuZCBDdHJsLUNcblx0XHRcdC8vIHNvIGJhc2ggaW50ZXJydXB0cyB0aGUgcGlwZWxpbmUgYW5kIHdyaXRlcyB0aGUgZXhpdCBjb2RlLCBpbnN0ZWFkXG5cdFx0XHQvLyBvZiBsZWF2aW5nIGFuIG9ycGhhbmVkIHN1YmFnZW50IHRoYXQgY2FuIGtlZXAgZWRpdGluZyBhZnRlciBjYW5jZWwuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRhd2FpdCBjbXV4Q2xpZW50LnNlbmRJbnRlcnJ1cHQoY211eFN1cmZhY2VJZCk7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0LyogaWdub3JlIFx1MjAxNCBiZXN0LWVmZm9ydCAqL1xuXHRcdFx0fVxuXHRcdFx0Ly8gR2l2ZSB0aGUgc2hlbGwgYSBicmllZiB3aW5kb3cgdG8gcmVhcCB0aGUga2lsbGVkIGNoaWxkIGFuZCB3cml0ZSBleGl0LmNvZGUuXG5cdFx0XHRhd2FpdCB3YWl0Rm9yRmlsZShleGl0UGF0aCwgdW5kZWZpbmVkLCA1MDAwKTtcblx0XHRcdGN1cnJlbnRSZXN1bHQuZXhpdENvZGUgPSAxO1xuXHRcdFx0Y3VycmVudFJlc3VsdC5ydW5uaW5nID0gZmFsc2U7XG5cdFx0XHRjdXJyZW50UmVzdWx0LnN0ZGVyciA9IFwiY211eCBzcGxpdCBleGVjdXRpb24gdGltZWQgb3V0IG9yIHdhcyBhYm9ydGVkXCI7XG5cdFx0XHRpZiAoZnMuZXhpc3RzU3luYyhzdGRvdXRQYXRoKSkge1xuXHRcdFx0XHRjb25zdCBzdGRvdXQgPSBmcy5yZWFkRmlsZVN5bmMoc3Rkb3V0UGF0aCwgXCJ1dGYtOFwiKTtcblx0XHRcdFx0Zm9yIChjb25zdCBsaW5lIG9mIHN0ZG91dC5zcGxpdChcIlxcblwiKSkge1xuXHRcdFx0XHRcdHByb2Nlc3NTdWJhZ2VudEV2ZW50TGluZShsaW5lLCBjdXJyZW50UmVzdWx0LCBlbWl0VXBkYXRlKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0cmV0dXJuIGN1cnJlbnRSZXN1bHQ7XG5cdFx0fVxuXG5cdFx0aWYgKGZzLmV4aXN0c1N5bmMoc3Rkb3V0UGF0aCkpIHtcblx0XHRcdGNvbnN0IHN0ZG91dCA9IGZzLnJlYWRGaWxlU3luYyhzdGRvdXRQYXRoLCBcInV0Zi04XCIpO1xuXHRcdFx0Zm9yIChjb25zdCBsaW5lIG9mIHN0ZG91dC5zcGxpdChcIlxcblwiKSkge1xuXHRcdFx0XHRwcm9jZXNzU3ViYWdlbnRFdmVudExpbmUobGluZSwgY3VycmVudFJlc3VsdCwgZW1pdFVwZGF0ZSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdGlmIChmcy5leGlzdHNTeW5jKHN0ZGVyclBhdGgpKSB7XG5cdFx0XHRjdXJyZW50UmVzdWx0LnN0ZGVyciA9IGZzLnJlYWRGaWxlU3luYyhzdGRlcnJQYXRoLCBcInV0Zi04XCIpO1xuXHRcdH1cblx0XHRjdXJyZW50UmVzdWx0LmV4aXRDb2RlID0gTnVtYmVyLnBhcnNlSW50KGZzLnJlYWRGaWxlU3luYyhleGl0UGF0aCwgXCJ1dGYtOFwiKS50cmltKCkgfHwgXCIxXCIsIDEwKSB8fCAwO1xuXHRcdGN1cnJlbnRSZXN1bHQucnVubmluZyA9IGZhbHNlO1xuXHRcdHJldHVybiBjdXJyZW50UmVzdWx0O1xuXHR9IGZpbmFsbHkge1xuXHRcdGlmICh0bXBQcm9tcHRQYXRoKVxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0ZnMudW5saW5rU3luYyh0bXBQcm9tcHRQYXRoKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvKiBpZ25vcmUgKi9cblx0XHRcdH1cblx0XHRpZiAodG1wUHJvbXB0RGlyKVxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0ZnMucm1kaXJTeW5jKHRtcFByb21wdERpcik7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0LyogaWdub3JlICovXG5cdFx0XHR9XG5cdFx0aWYgKHRtcE91dHB1dERpcilcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGZzLnJtU3luYyh0bXBPdXRwdXREaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvKiBpZ25vcmUgKi9cblx0XHRcdH1cblx0fVxufVxuXG5jb25zdCBUYXNrSXRlbSA9IFR5cGUuT2JqZWN0KHtcblx0YWdlbnQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTmFtZSBvZiB0aGUgYWdlbnQgdG8gaW52b2tlXCIgfSksXG5cdHRhc2s6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGFzayB0byBkZWxlZ2F0ZSB0byB0aGUgYWdlbnRcIiB9KSxcblx0Y3dkOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiV29ya2luZyBkaXJlY3RvcnkgZm9yIHRoZSBhZ2VudCBwcm9jZXNzXCIgfSkpLFxuXHRtb2RlbDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1vZGVsIG92ZXJyaWRlIGZvciB0aGlzIHRhc2sgKGUuZy4gJ2NsYXVkZS1zb25uZXQtNC02JylcIiB9KSksXG5cdGNvbnRleHQ6IFR5cGUuT3B0aW9uYWwoU3RyaW5nRW51bShbXCJmcmVzaFwiLCBcImZvcmtcIl0gYXMgY29uc3QsIHtcblx0XHRkZXNjcmlwdGlvbjogJ0NvbnRleHQgbW9kZSBmb3IgdGhpcyB0YXNrLiBcImZyZXNoXCIga2VlcHMgdGhlIGV4aXN0aW5nIGlzb2xhdGVkIGNvbnRleHQgYmVoYXZpb3I7IFwiZm9ya1wiIGJyYW5jaGVzIHRoZSBwYXJlbnQgc2Vzc2lvbi4nLFxuXHRcdGRlZmF1bHQ6IFwiZnJlc2hcIixcblx0fSkpLFxufSk7XG5cbmNvbnN0IENoYWluSXRlbSA9IFR5cGUuT2JqZWN0KHtcblx0YWdlbnQ6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTmFtZSBvZiB0aGUgYWdlbnQgdG8gaW52b2tlXCIgfSksXG5cdHRhc2s6IFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiVGFzayB3aXRoIG9wdGlvbmFsIHtwcmV2aW91c30gcGxhY2Vob2xkZXIgZm9yIHByaW9yIG91dHB1dFwiIH0pLFxuXHRjd2Q6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJXb3JraW5nIGRpcmVjdG9yeSBmb3IgdGhlIGFnZW50IHByb2Nlc3NcIiB9KSksXG5cdG1vZGVsOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiTW9kZWwgb3ZlcnJpZGUgZm9yIHRoaXMgc3RlcCAoZS5nLiAnY2xhdWRlLXNvbm5ldC00LTYnKVwiIH0pKSxcblx0Y29udGV4dDogVHlwZS5PcHRpb25hbChTdHJpbmdFbnVtKFtcImZyZXNoXCIsIFwiZm9ya1wiXSBhcyBjb25zdCwge1xuXHRcdGRlc2NyaXB0aW9uOiAnQ29udGV4dCBtb2RlIGZvciB0aGlzIHN0ZXAuIFwiZnJlc2hcIiBrZWVwcyB0aGUgZXhpc3RpbmcgaXNvbGF0ZWQgY29udGV4dCBiZWhhdmlvcjsgXCJmb3JrXCIgYnJhbmNoZXMgdGhlIHBhcmVudCBzZXNzaW9uLicsXG5cdFx0ZGVmYXVsdDogXCJmcmVzaFwiLFxuXHR9KSksXG59KTtcblxuY29uc3QgQWdlbnRTY29wZVNjaGVtYSA9IFN0cmluZ0VudW0oW1widXNlclwiLCBcInByb2plY3RcIiwgXCJib3RoXCJdIGFzIGNvbnN0LCB7XG5cdGRlc2NyaXB0aW9uOiAnV2hpY2ggYWdlbnQgZGlyZWN0b3JpZXMgdG8gdXNlLiBEZWZhdWx0OiBcImJvdGhcIiAodXNlciArIHByb2plY3QtbG9jYWwpLicsXG5cdGRlZmF1bHQ6IFwiYm90aFwiLFxufSk7XG5cbmNvbnN0IENvbnRleHRNb2RlU2NoZW1hID0gU3RyaW5nRW51bShbXCJmcmVzaFwiLCBcImZvcmtcIl0gYXMgY29uc3QsIHtcblx0ZGVzY3JpcHRpb246ICdDb250ZXh0IG1vZGUgZm9yIGRlbGVnYXRlZCB3b3JrLiBcImZyZXNoXCIgaXMgdGhlIGRlZmF1bHQgZXhpc3RpbmcgYmVoYXZpb3I7IFwiZm9ya1wiIGJyYW5jaGVzIHRoZSBwYXJlbnQgc2Vzc2lvbi4nLFxuXHRkZWZhdWx0OiBcImZyZXNoXCIsXG59KTtcblxuY29uc3QgU3ViYWdlbnRBY3Rpb25TY2hlbWEgPSBTdHJpbmdFbnVtKFtcImxhdW5jaFwiLCBcInN0YXR1c1wiLCBcInJlc3VtZVwiXSBhcyBjb25zdCwge1xuXHRkZXNjcmlwdGlvbjogJ1J1biBhY3Rpb24uIFwibGF1bmNoXCIgc3RhcnRzIGRlbGVnYXRlZCB3b3JrLCBcInN0YXR1c1wiIGluc3BlY3RzIGEgcGVyc2lzdGVkIHJ1biwgYW5kIFwicmVzdW1lXCIgZm9sbG93cyB1cCBhIGNoaWxkIHNlc3Npb24gZnJvbSBhIHJ1bi4nLFxuXHRkZWZhdWx0OiBcImxhdW5jaFwiLFxufSk7XG5cbmNvbnN0IFN1YmFnZW50UGFyYW1zID0gVHlwZS5PYmplY3Qoe1xuXHRhY3Rpb246IFR5cGUuT3B0aW9uYWwoU3ViYWdlbnRBY3Rpb25TY2hlbWEpLFxuXHRydW5JZDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIlBlcnNpc3RlZCBzdWJhZ2VudCBydW4gaWQgZm9yIHN0YXR1cyBvciByZXN1bWUgYWN0aW9uc1wiIH0pKSxcblx0YWdlbnQ6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJOYW1lIG9mIHRoZSBhZ2VudCB0byBpbnZva2UgKGZvciBzaW5nbGUgbW9kZSlcIiB9KSksXG5cdHRhc2s6IFR5cGUuT3B0aW9uYWwoVHlwZS5TdHJpbmcoeyBkZXNjcmlwdGlvbjogXCJUYXNrIHRvIGRlbGVnYXRlIChmb3Igc2luZ2xlIG1vZGUpXCIgfSkpLFxuXHR0YXNrczogVHlwZS5PcHRpb25hbChUeXBlLkFycmF5KFRhc2tJdGVtLCB7IGRlc2NyaXB0aW9uOiBcIkFycmF5IG9mIHthZ2VudCwgdGFza30gZm9yIHBhcmFsbGVsIGV4ZWN1dGlvblwiIH0pKSxcblx0Y2hhaW46IFR5cGUuT3B0aW9uYWwoVHlwZS5BcnJheShDaGFpbkl0ZW0sIHsgZGVzY3JpcHRpb246IFwiQXJyYXkgb2Yge2FnZW50LCB0YXNrfSBmb3Igc2VxdWVudGlhbCBleGVjdXRpb25cIiB9KSksXG5cdGFnZW50U2NvcGU6IFR5cGUuT3B0aW9uYWwoQWdlbnRTY29wZVNjaGVtYSksXG5cdGNvbnRleHQ6IFR5cGUuT3B0aW9uYWwoQ29udGV4dE1vZGVTY2hlbWEpLFxuXHRiYWNrZ3JvdW5kOiBUeXBlLk9wdGlvbmFsKFR5cGUuQm9vbGVhbih7IGRlc2NyaXB0aW9uOiBcIlJldHVybiBhZnRlciBzdGFydGluZyB0aGUgcnVuIGFuZCBrZWVwIHN0YXR1cyBpbiB0aGUgcGVyc2lzdGVkIHJ1biByZWNvcmQuIERlZmF1bHQ6IGZhbHNlLlwiLCBkZWZhdWx0OiBmYWxzZSB9KSksXG5cdGZvbGxvd1VwOiBUeXBlLk9wdGlvbmFsKFR5cGUuU3RyaW5nKHsgZGVzY3JpcHRpb246IFwiRm9sbG93LXVwIGluc3RydWN0aW9uIGZvciByZXN1bWUgYWN0aW9uLiBGYWxscyBiYWNrIHRvIHRhc2sgd2hlbiBvbWl0dGVkLlwiIH0pKSxcblx0Y29uZmlybVByb2plY3RBZ2VudHM6IFR5cGUuT3B0aW9uYWwoXG5cdFx0VHlwZS5Cb29sZWFuKHsgZGVzY3JpcHRpb246IFwiUHJvbXB0IGJlZm9yZSBydW5uaW5nIHByb2plY3QtbG9jYWwgYWdlbnRzLiBEZWZhdWx0OiBmYWxzZS5cIiwgZGVmYXVsdDogZmFsc2UgfSksXG5cdCksXG5cdGN3ZDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIldvcmtpbmcgZGlyZWN0b3J5IGZvciB0aGUgYWdlbnQgcHJvY2VzcyAoc2luZ2xlIG1vZGUpXCIgfSkpLFxuXHRtb2RlbDogVHlwZS5PcHRpb25hbChUeXBlLlN0cmluZyh7IGRlc2NyaXB0aW9uOiBcIk1vZGVsIG92ZXJyaWRlIGZvciB0aGUgc3ViYWdlbnQgKGUuZy4gJ2NsYXVkZS1zb25uZXQtNC02JykuIFRha2VzIHByZWNlZGVuY2Ugb3ZlciB0aGUgYWdlbnQncyBmcm9udG1hdHRlciBtb2RlbC5cIiB9KSksXG5cdGlzb2xhdGVkOiBUeXBlLk9wdGlvbmFsKFxuXHRcdFR5cGUuQm9vbGVhbih7XG5cdFx0XHRkZXNjcmlwdGlvbjpcblx0XHRcdFx0XCJSdW4gdGhlIHN1YmFnZW50IGluIGFuIGlzb2xhdGVkIGZpbGVzeXN0ZW0gKGdpdCB3b3JrdHJlZSkuIFwiICtcblx0XHRcdFx0XCJDaGFuZ2VzIGFyZSBjYXB0dXJlZCBhcyBwYXRjaGVzIGFuZCBtZXJnZWQgYmFjay4gXCIgK1xuXHRcdFx0XHRcIk9ubHkgYXZhaWxhYmxlIHdoZW4gdGFza0lzb2xhdGlvbi5tb2RlIGlzIGNvbmZpZ3VyZWQgaW4gc2V0dGluZ3MuXCIsXG5cdFx0XHRkZWZhdWx0OiBmYWxzZSxcblx0XHR9KSxcblx0KSxcbn0pO1xuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiAocGk6IEV4dGVuc2lvbkFQSSkge1xuXHRpZiAoaXNTdWJhZ2VudENoaWxkUHJvY2VzcygpKSByZXR1cm47XG5cblx0cGkub24oXCJzZXNzaW9uX3NodXRkb3duXCIsIGFzeW5jICgpID0+IHtcblx0XHRhd2FpdCBzdG9wTGl2ZVN1YmFnZW50cygpO1xuXHR9KTtcblxuXHQvLyAvc3ViYWdlbnQgY29tbWFuZCAtIGxpc3QgYXZhaWxhYmxlIGFnZW50c1xuXHRwaS5yZWdpc3RlckNvbW1hbmQoXCJzdWJhZ2VudFwiLCB7XG5cdFx0ZGVzY3JpcHRpb246IFwiTGlzdCBhdmFpbGFibGUgc3ViYWdlbnRzXCIsXG5cdFx0aGFuZGxlcjogYXN5bmMgKF9hcmdzLCBjdHgpID0+IHtcblx0XHRcdGNvbnN0IGRpc2NvdmVyeSA9IGRpc2NvdmVyQWdlbnRzKGN0eC5jd2QsIFwiYm90aFwiKTtcblx0XHRcdGlmIChkaXNjb3ZlcnkuYWdlbnRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRjdHgudWkubm90aWZ5KFwiTm8gYWdlbnRzIGZvdW5kLiBBZGQgLm1kIGZpbGVzIHRvIH4vLmdzZC9hZ2VudC9hZ2VudHMvIG9yIC5nc2QvYWdlbnRzL1wiLCBcIndhcm5pbmdcIik7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGxpbmVzID0gZGlzY292ZXJ5LmFnZW50cy5tYXAoXG5cdFx0XHRcdChhKSA9PiBgICAke2EubmFtZX0gWyR7YS5zb3VyY2V9XSR7YS5tb2RlbCA/IGAgKCR7YS5tb2RlbH0pYCA6IFwiXCJ9OiAke2EuZGVzY3JpcHRpb259YCxcblx0XHRcdCk7XG5cdFx0XHRjdHgudWkubm90aWZ5KGBBdmFpbGFibGUgYWdlbnRzICgke2Rpc2NvdmVyeS5hZ2VudHMubGVuZ3RofSk6XFxuJHtsaW5lcy5qb2luKFwiXFxuXCIpfWAsIFwiaW5mb1wiKTtcblx0XHR9LFxuXHR9KTtcblxuXHRwaS5yZWdpc3RlclRvb2woe1xuXHRcdG5hbWU6IFwic3ViYWdlbnRcIixcblx0XHRsYWJlbDogXCJTdWJhZ2VudFwiLFxuXHRcdGRlc2NyaXB0aW9uOiBbXG5cdFx0XHRcIkRlbGVnYXRlIHRhc2tzIHRvIHNwZWNpYWxpemVkIHN1YmFnZW50cyB3aXRoIGlzb2xhdGVkIGNvbnRleHQgd2luZG93cy5cIixcblx0XHRcdFwiRWFjaCBzdWJhZ2VudCBpcyBhIHNlcGFyYXRlIHBpIHByb2Nlc3Mgd2l0aCBpdHMgb3duIHRvb2xzLCBtb2RlbCwgYW5kIHN5c3RlbSBwcm9tcHQuXCIsXG5cdFx0XHRcIk1vZGVzOiBzaW5nbGUgKHsgYWdlbnQsIHRhc2sgfSksIHBhcmFsbGVsICh7IHRhc2tzOiBbe2FnZW50LCB0YXNrfSwuLi5dIH0pLCBjaGFpbiAoeyBjaGFpbjogW3thZ2VudCwgdGFza30sLi4uXSB9IHdpdGgge3ByZXZpb3VzfSBwbGFjZWhvbGRlcikuXCIsXG5cdFx0XHRcIkFnZW50cyBhcmUgZGVmaW5lZCBhcyAubWQgZmlsZXMgaW4gfi8uZ3NkL2FnZW50L2FnZW50cy8gKHVzZXIpIG9yIC5nc2QvYWdlbnRzLyAocHJvamVjdCkuXCIsXG5cdFx0XHRcIlVzZSB0aGUgL3N1YmFnZW50IGNvbW1hbmQgdG8gbGlzdCBhdmFpbGFibGUgYWdlbnRzIGFuZCB0aGVpciBkZXNjcmlwdGlvbnMuXCIsXG5cdFx0XHRcIlVzZSBjaGFpbiBtb2RlIHRvIHBpcGVsaW5lOiBzY291dCBmaW5kcyBjb250ZXh0LCBwbGFubmVyIGRlc2lnbnMsIHdvcmtlciBpbXBsZW1lbnRzLlwiLFxuXHRcdF0uam9pbihcIiBcIiksXG5cdFx0cHJvbXB0R3VpZGVsaW5lczogW1xuXHRcdFx0XCJQcmVmZXIgc3ViYWdlbnQgZGlzcGF0Y2ggb3ZlciBpbmxpbmUgd29yayB3aGVuZXZlciBhIHRhc2sgaXMgc2VsZi1jb250YWluZWQgXHUyMDE0IHJlY29uLCBwbGFubmluZywgcmV2aWV3LCByZWZhY3RvciwgdGVzdCB3cml0aW5nLCBzZWN1cml0eSBhdWRpdCwgZG9jIHdyaXRpbmcuIEVhY2ggZGlzcGF0Y2ggZ2V0cyBhIGZyZXNoIGNvbnRleHQgd2luZG93LCBzbyB5b3VyIG1haW4gc2Vzc2lvbiBzdGF5cyBmb2N1c2VkIG9uIHN5bnRoZXNpcy5cIixcblx0XHRcdFwiQmVmb3JlIHJlYWRpbmcgbW9yZSB0aGFuIH4zIGZpbGVzIHRvIHVuZGVyc3RhbmQgc29tZXRoaW5nLCBkaXNwYXRjaCB0aGUgc2NvdXQgYWdlbnQgYW5kIHdvcmsgZnJvbSBpdHMgY29tcHJlc3NlZCByZXBvcnQgaW5zdGVhZC5cIixcblx0XHRcdFwiQmVmb3JlIGFueSBjaGFuZ2UgdG91Y2hpbmcgXHUyMjY1MiBwYWNrYWdlcywgdGhlIG9yY2hlc3RyYXRpb24ga2VybmVsLCBhdXRvLW1vZGUsIG9yIGEgcHVibGljIEFQSSwgZGlzcGF0Y2ggdGhlIHBsYW5uZXIgYWdlbnQgZmlyc3QuIFBsYW4gZmlyc3QsIHRoZW4gaW1wbGVtZW50LlwiLFxuXHRcdFx0XCJZb3UgTVVTVCB1c2UgcGFyYWxsZWwgbW9kZSB3aGVuIFx1MjI2NTIgcmVhZHkgdGFza3MgYXJlIGluZGVwZW5kZW50IG9mIGVhY2ggb3RoZXIncyBvdXRwdXQuIERvIG5vdCBzZXJpYWxpemUgaW5kZXBlbmRlbnQgdGFza3MgbWFudWFsbHkgXHUyMDE0IHRoYXQgd2FzdGVzIHdhbGwgdGltZSBhbmQgY29udGV4dC5cIixcblx0XHRcdFwiVXNlIGNoYWluIG1vZGUgZm9yIHNlcXVlbnRpYWwgcGlwZWxpbmVzIHdoZXJlIGVhY2ggc3RlcCdzIG91dHB1dCBmZWVkcyB0aGUgbmV4dDogc2NvdXQgXHUyMTkyIHBsYW5uZXIgXHUyMTkyIHdvcmtlciwgb3Igd29ya2VyIFx1MjE5MiByZXZpZXdlciBcdTIxOTIgd29ya2VyLlwiLFxuXHRcdFx0XCJCZWZvcmUgb3BlbmluZyBhIFBSIG9yIG1hcmtpbmcgYSBzbGljZSBjb21wbGV0ZSwgZGlzcGF0Y2ggdGhlIHJldmlld2VyIGFnZW50IChhbmQgc2VjdXJpdHkgYWdlbnQgaWYgdGhlIGNoYW5nZSB0b3VjaGVzIGF1dGgsIG5ldHdvcmssIHBhcnNpbmcsIGZpbGUgSU8sIG9yIHNoZWxsIGV4ZWMpLlwiLFxuXHRcdFx0XCJBbHdheXMgY2hlY2sgYXZhaWxhYmxlIGFnZW50cyB3aXRoIC9zdWJhZ2VudCBiZWZvcmUgY2hvb3Npbmcgb25lIFx1MjAxNCB0aGVyZSBhcmUgYnVuZGxlZCBzcGVjaWFsaXN0cyBwbHVzIGFueSBwcm9qZWN0LXNjb3BlZCBhZ2VudHMuXCIsXG5cdFx0XSxcblx0XHRwYXJhbWV0ZXJzOiBTdWJhZ2VudFBhcmFtcyxcblxuXHRcdGFzeW5jIGV4ZWN1dGUoX3Rvb2xDYWxsSWQsIHBhcmFtcywgc2lnbmFsLCBvblVwZGF0ZSwgY3R4KSB7XG5cdFx0XHRjb25zdCBhZ2VudFNjb3BlOiBBZ2VudFNjb3BlID0gcGFyYW1zLmFnZW50U2NvcGUgPz8gXCJib3RoXCI7XG5cdFx0XHRjb25zdCBkaXNjb3ZlcnkgPSBkaXNjb3ZlckFnZW50cyhjdHguY3dkLCBhZ2VudFNjb3BlKTtcblx0XHRcdGNvbnN0IGFnZW50cyA9IGRpc2NvdmVyeS5hZ2VudHM7XG5cdFx0XHRjb25zdCBjb25maXJtUHJvamVjdEFnZW50cyA9IHBhcmFtcy5jb25maXJtUHJvamVjdEFnZW50cyA/PyBmYWxzZTtcblx0XHRcdGNvbnN0IGNtdXhDbGllbnQgPSBDbXV4Q2xpZW50LmZyb21QcmVmZXJlbmNlcyhsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXMpO1xuXHRcdFx0Y29uc3QgY211eFNwbGl0c0VuYWJsZWQgPSBjbXV4Q2xpZW50LmdldENvbmZpZygpLnNwbGl0cztcblx0XHRcdGNvbnN0IHJ1blN0b3JlID0gbmV3IFN1YmFnZW50UnVuU3RvcmUoKTtcblx0XHRcdGNvbnN0IGFjdGlvbiA9IHBhcmFtcy5hY3Rpb24gPz8gXCJsYXVuY2hcIjtcblx0XHRcdGNvbnN0IGNvbnRleHRNb2RlOiBTdWJhZ2VudENvbnRleHRNb2RlID0gcGFyYW1zLmNvbnRleHQgPz8gXCJmcmVzaFwiO1xuXHRcdFx0Y29uc3QgdGFza1BhcmFtczogVGFza1BhcmFtW10gPSBBcnJheS5pc0FycmF5KHBhcmFtcy50YXNrcykgPyBwYXJhbXMudGFza3MgYXMgVGFza1BhcmFtW10gOiBbXTtcblx0XHRcdGNvbnN0IGNoYWluUGFyYW1zOiBDaGFpblBhcmFtW10gPSBBcnJheS5pc0FycmF5KHBhcmFtcy5jaGFpbikgPyBwYXJhbXMuY2hhaW4gYXMgQ2hhaW5QYXJhbVtdIDogW107XG5cblx0XHRcdC8vIFJlc29sdmUgaXNvbGF0aW9uIG1vZGVcblx0XHRcdGNvbnN0IGlzb2xhdGlvbk1vZGUgPSByZWFkSXNvbGF0aW9uTW9kZSgpO1xuXHRcdFx0Y29uc3QgdXNlSXNvbGF0aW9uID0gQm9vbGVhbihwYXJhbXMuaXNvbGF0ZWQpICYmIGlzb2xhdGlvbk1vZGUgIT09IFwibm9uZVwiO1xuXG5cdFx0XHRjb25zdCBoYXNDaGFpbiA9IGNoYWluUGFyYW1zLmxlbmd0aCA+IDA7XG5cdFx0XHRjb25zdCBoYXNUYXNrcyA9IHRhc2tQYXJhbXMubGVuZ3RoID4gMDtcblx0XHRcdGNvbnN0IGhhc1NpbmdsZSA9IEJvb2xlYW4ocGFyYW1zLmFnZW50ICYmIHBhcmFtcy50YXNrKTtcblx0XHRcdGNvbnN0IG1vZGVDb3VudCA9IE51bWJlcihoYXNDaGFpbikgKyBOdW1iZXIoaGFzVGFza3MpICsgTnVtYmVyKGhhc1NpbmdsZSk7XG5cblx0XHRcdGNvbnN0IG1ha2VEZXRhaWxzID1cblx0XHRcdFx0KG1vZGU6IFwic2luZ2xlXCIgfCBcInBhcmFsbGVsXCIgfCBcImNoYWluXCIpID0+XG5cdFx0XHRcdChyZXN1bHRzOiBTaW5nbGVSZXN1bHRbXSk6IFN1YmFnZW50RGV0YWlscyA9PiAoe1xuXHRcdFx0XHRcdG1vZGUsXG5cdFx0XHRcdFx0YWdlbnRTY29wZSxcblx0XHRcdFx0XHRwcm9qZWN0QWdlbnRzRGlyOiBkaXNjb3ZlcnkucHJvamVjdEFnZW50c0Rpcixcblx0XHRcdFx0XHRyZXN1bHRzLFxuXHRcdFx0XHR9KTtcblxuXHRcdFx0aWYgKGFjdGlvbiA9PT0gXCJzdGF0dXNcIikge1xuXHRcdFx0XHRpZiAoIXBhcmFtcy5ydW5JZCkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJTdGF0dXMgcmVxdWlyZXMgcnVuSWQuXCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiBtYWtlRGV0YWlscyhcInNpbmdsZVwiKShbXSksXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgcmVjb3JkID0gcnVuU3RvcmUuZ2V0KHBhcmFtcy5ydW5JZCk7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGZvcm1hdFJ1blJlY29yZChyZWNvcmQpIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IG1ha2VEZXRhaWxzKFwic2luZ2xlXCIpKFtdKSxcblx0XHRcdFx0XHQuLi4ocmVjb3JkID8ge30gOiB7IGlzRXJyb3I6IHRydWUgfSksXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdGlmIChhY3Rpb24gPT09IFwicmVzdW1lXCIpIHtcblx0XHRcdFx0aWYgKCFwYXJhbXMucnVuSWQpIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiUmVzdW1lIHJlcXVpcmVzIHJ1bklkLlwiIH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogbWFrZURldGFpbHMoXCJzaW5nbGVcIikoW10pLFxuXHRcdFx0XHRcdFx0aXNFcnJvcjogdHJ1ZSxcblx0XHRcdFx0XHR9O1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IHJlY29yZCA9IHJ1blN0b3JlLmdldChwYXJhbXMucnVuSWQpO1xuXHRcdFx0XHRpZiAoIXJlY29yZCkge1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFN1YmFnZW50IHJ1biBub3QgZm91bmQ6ICR7cGFyYW1zLnJ1bklkfWAgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiBtYWtlRGV0YWlscyhcInNpbmdsZVwiKShbXSksXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgZm9sbG93VXAgPSBwYXJhbXMuZm9sbG93VXAgPz8gcGFyYW1zLnRhc2s7XG5cdFx0XHRcdGlmICghZm9sbG93VXApIHtcblx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiUmVzdW1lIHJlcXVpcmVzIGZvbGxvd1VwIG9yIHRhc2suXCIgfV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiBtYWtlRGV0YWlscyhcInNpbmdsZVwiKShbXSksXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3Qgc2Vzc2lvbkNoaWxkcmVuID0gcmVjb3JkLmNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLnNlc3Npb25GaWxlKTtcblx0XHRcdFx0Y29uc3QgbWF0Y2hlcyA9IHBhcmFtcy5hZ2VudFxuXHRcdFx0XHRcdD8gc2Vzc2lvbkNoaWxkcmVuLmZpbHRlcigoY2hpbGQpID0+IGNoaWxkLmFnZW50ID09PSBwYXJhbXMuYWdlbnQpXG5cdFx0XHRcdFx0OiBzZXNzaW9uQ2hpbGRyZW47XG5cdFx0XHRcdGNvbnN0IHNlbGVjdGVkID0gbWF0Y2hlcy5sZW5ndGggPT09IDEgPyBtYXRjaGVzWzBdIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRpZiAoIXNlbGVjdGVkPy5zZXNzaW9uRmlsZSkge1xuXHRcdFx0XHRcdGNvbnN0IGF2YWlsYWJsZSA9IHNlc3Npb25DaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiBmb3JtYXRBZ2VudExhYmVsKGNoaWxkLmFnZW50LCBjaGlsZC50cmFja2luZ05hbWUpKS5qb2luKFwiLCBcIikgfHwgXCJub25lXCI7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBgUmVzdW1lIHJlcXVpcmVzIGV4YWN0bHkgb25lIGNoaWxkIHNlc3Npb24gb3IgYW4gYWdlbnQgc2VsZWN0b3IuIEF2YWlsYWJsZSByZXN1bWFibGUgYWdlbnRzOiAke2F2YWlsYWJsZX1gLFxuXHRcdFx0XHRcdFx0fV0sXG5cdFx0XHRcdFx0XHRkZXRhaWxzOiBtYWtlRGV0YWlscyhcInNpbmdsZVwiKShbXSksXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuU2luZ2xlQWdlbnQoXG5cdFx0XHRcdFx0Y3R4LmN3ZCxcblx0XHRcdFx0XHRhZ2VudHMsXG5cdFx0XHRcdFx0c2VsZWN0ZWQuYWdlbnQsXG5cdFx0XHRcdFx0Zm9sbG93VXAsXG5cdFx0XHRcdFx0c2VsZWN0ZWQuY3dkLFxuXHRcdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0XHRzaWduYWwsXG5cdFx0XHRcdFx0b25VcGRhdGUsXG5cdFx0XHRcdFx0bWFrZURldGFpbHMoXCJzaW5nbGVcIiksXG5cdFx0XHRcdFx0cGFyYW1zLm1vZGVsLFxuXHRcdFx0XHRcdFwiZnJlc2hcIixcblx0XHRcdFx0XHRjdHguc2Vzc2lvbk1hbmFnZXIsXG5cdFx0XHRcdFx0eyBtb2RlOiBcImZvcmtcIiwgc2Vzc2lvbkZpbGU6IHNlbGVjdGVkLnNlc3Npb25GaWxlLCBzZXNzaW9uRGlyOiBwYXRoLmRpcm5hbWUoc2VsZWN0ZWQuc2Vzc2lvbkZpbGUpIH0sXG5cdFx0XHRcdFx0c2VsZWN0ZWQudHJhY2tpbmdOYW1lLFxuXHRcdFx0XHQpO1xuXHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBnZXRGaW5hbE91dHB1dChyZXN1bHQubWVzc2FnZXMpIHx8IHJlc3VsdC5lcnJvck1lc3NhZ2UgfHwgcmVzdWx0LnN0ZGVyciB8fCBcIihubyBvdXRwdXQpXCIgfV0sXG5cdFx0XHRcdFx0ZGV0YWlsczogbWFrZURldGFpbHMoXCJzaW5nbGVcIikoW3Jlc3VsdF0pLFxuXHRcdFx0XHRcdC4uLihyZXN1bHQuZXhpdENvZGUgPT09IDAgPyB7fSA6IHsgaXNFcnJvcjogdHJ1ZSB9KSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKG1vZGVDb3VudCAhPT0gMSkge1xuXHRcdFx0XHRjb25zdCBhdmFpbGFibGUgPSBhZ2VudHMubWFwKChhKSA9PiBgJHthLm5hbWV9ICgke2Euc291cmNlfSlgKS5qb2luKFwiLCBcIikgfHwgXCJub25lXCI7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdFx0e1xuXHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0dGV4dDogYEludmFsaWQgcGFyYW1ldGVycy4gUHJvdmlkZSBleGFjdGx5IG9uZSBtb2RlLlxcbkF2YWlsYWJsZSBhZ2VudHM6ICR7YXZhaWxhYmxlfWAsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdFx0ZGV0YWlsczogbWFrZURldGFpbHMoXCJzaW5nbGVcIikoW10pLFxuXHRcdFx0XHR9O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBEaXNwYXRjaCB0ZWxlbWV0cnkgXHUyMDE0IGVtaXQgaW52b2tlZCBvbmNlIHBlciBkaXNwYXRjaCBhbmQgY29tcGxldGVkIGJlZm9yZSBlYWNoIHJldHVybi5cblx0XHRcdC8vIEZyZXNoIGZsb3dJZCBwZXIgZGlzcGF0Y2ggKHN1YmFnZW50IHJ1bnMgYXJlbid0IGN1cnJlbnRseSBwbHVtYmVkIHdpdGggdGhlIHBhcmVudFxuXHRcdFx0Ly8gYXV0by1tb2RlIGZsb3dJZDsgcGVyLWRpc3BhdGNoIGlkcyBzdGlsbCBsZXQgdXMgbWVhc3VyZSBmcmVxdWVuY3ksIGJhdGNoIHNpemUsIG1vZGUpLlxuXHRcdFx0Y29uc3QgZGlzcGF0Y2hNb2RlOiBcInNpbmdsZVwiIHwgXCJwYXJhbGxlbFwiIHwgXCJjaGFpblwiID0gaGFzQ2hhaW4gPyBcImNoYWluXCIgOiBoYXNUYXNrcyA/IFwicGFyYWxsZWxcIiA6IFwic2luZ2xlXCI7XG5cdFx0XHRjb25zdCBkaXNwYXRjaEFnZW50cyA9IGhhc0NoYWluXG5cdFx0XHRcdD8gY2hhaW5QYXJhbXMubWFwKChzKSA9PiBzLmFnZW50KVxuXHRcdFx0XHQ6IGhhc1Rhc2tzXG5cdFx0XHRcdFx0PyB0YXNrUGFyYW1zLm1hcCgodCkgPT4gdC5hZ2VudClcblx0XHRcdFx0XHQ6IHBhcmFtcy5hZ2VudFxuXHRcdFx0XHRcdFx0PyBbcGFyYW1zLmFnZW50XVxuXHRcdFx0XHRcdFx0OiBbXTtcblx0XHRcdGNvbnN0IGRpc3BhdGNoVGFza3MgPSBoYXNDaGFpblxuXHRcdFx0XHQ/IGNoYWluUGFyYW1zLm1hcCgocykgPT4gcy50YXNrKVxuXHRcdFx0XHQ6IGhhc1Rhc2tzXG5cdFx0XHRcdFx0PyB0YXNrUGFyYW1zLm1hcCgodCkgPT4gdC50YXNrKVxuXHRcdFx0XHRcdDogcGFyYW1zLnRhc2tcblx0XHRcdFx0XHRcdD8gW3BhcmFtcy50YXNrXVxuXHRcdFx0XHRcdFx0OiBbXTtcblx0XHRcdGNvbnN0IGRpc3BhdGNoSWQgPSBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuXHRcdFx0Y29uc3QgZGlzcGF0Y2hTdGFydE1zID0gRGF0ZS5ub3coKTtcblx0XHRcdGxldCBmaW5hbFJlc3VsdHM6IFNpbmdsZVJlc3VsdFtdID0gW107XG5cdFx0XHRsZXQgZGlzcGF0Y2hDb21wbGV0ZWRFbWl0dGVkID0gZmFsc2U7XG5cdFx0XHRjb25zdCB1c2VkVHJhY2tpbmdOYW1lcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdFx0Y29uc3QgZGlzcGF0Y2hUcmFja2luZ05hbWVzID0gZGlzcGF0Y2hBZ2VudHMubWFwKCgpID0+IHtcblx0XHRcdFx0Y29uc3QgdHJhY2tpbmdOYW1lID0gY3JlYXRlU3ViYWdlbnRUcmFja2luZ05hbWUodXNlZFRyYWNraW5nTmFtZXMpO1xuXHRcdFx0XHR1c2VkVHJhY2tpbmdOYW1lcy5hZGQodHJhY2tpbmdOYW1lKTtcblx0XHRcdFx0cmV0dXJuIHRyYWNraW5nTmFtZTtcblx0XHRcdH0pO1xuXHRcdFx0Y29uc3QgZGlzcGF0Y2hDb250ZXh0TW9kZTogU3ViYWdlbnRDb250ZXh0TW9kZSA9XG5cdFx0XHRcdGhhc0NoYWluICYmIGNoYWluUGFyYW1zLnNvbWUoKHN0ZXApID0+IChzdGVwLmNvbnRleHQgPz8gY29udGV4dE1vZGUpID09PSBcImZvcmtcIilcblx0XHRcdFx0XHQ/IFwiZm9ya1wiXG5cdFx0XHRcdFx0OiBoYXNUYXNrcyAmJiB0YXNrUGFyYW1zLnNvbWUoKHRhc2spID0+ICh0YXNrLmNvbnRleHQgPz8gY29udGV4dE1vZGUpID09PSBcImZvcmtcIilcblx0XHRcdFx0XHRcdD8gXCJmb3JrXCJcblx0XHRcdFx0XHRcdDogY29udGV4dE1vZGU7XG5cdFx0XHRjb25zdCBkaXNwYXRjaENoaWxkcmVuID0gZGlzcGF0Y2hBZ2VudHMubWFwKChhZ2VudCwgaW5kZXgpID0+ICh7XG5cdFx0XHRcdGFnZW50LFxuXHRcdFx0XHR0cmFja2luZ05hbWU6IGRpc3BhdGNoVHJhY2tpbmdOYW1lc1tpbmRleF0sXG5cdFx0XHRcdHRhc2s6IGRpc3BhdGNoVGFza3NbaW5kZXhdID8/IFwiXCIsXG5cdFx0XHRcdGN3ZDogaGFzQ2hhaW5cblx0XHRcdFx0XHQ/IGNoYWluUGFyYW1zW2luZGV4XT8uY3dkXG5cdFx0XHRcdFx0OiBoYXNUYXNrc1xuXHRcdFx0XHRcdFx0PyB0YXNrUGFyYW1zW2luZGV4XT8uY3dkXG5cdFx0XHRcdFx0XHQ6IHBhcmFtcy5jd2QsXG5cdFx0XHR9KSk7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRydW5TdG9yZS5jcmVhdGUoY3JlYXRlSW5pdGlhbFJ1blJlY29yZCh7XG5cdFx0XHRcdFx0cnVuSWQ6IGRpc3BhdGNoSWQsXG5cdFx0XHRcdFx0bW9kZTogZGlzcGF0Y2hNb2RlIGFzIFN1YmFnZW50UnVuTW9kZSxcblx0XHRcdFx0XHRjb250ZXh0TW9kZTogZGlzcGF0Y2hDb250ZXh0TW9kZSxcblx0XHRcdFx0XHRjd2Q6IGN0eC5jd2QsXG5cdFx0XHRcdFx0Y2hpbGRyZW46IGRpc3BhdGNoQ2hpbGRyZW4sXG5cdFx0XHRcdH0pKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBQZXJzaXN0ZW5jZSBpcyBvYnNlcnZhYmlsaXR5OyBleGVjdXRpb24gcmVtYWlucyBhdXRob3JpdGF0aXZlLlxuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBwZXJzaXN0UnVuUmVzdWx0cyA9IChyZXN1bHRzOiBTaW5nbGVSZXN1bHRbXSwgY29tcGxldGVkID0gZmFsc2UpOiB2b2lkID0+IHtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRydW5TdG9yZS51cGRhdGUoZGlzcGF0Y2hJZCwgKHJlY29yZCkgPT4ge1xuXHRcdFx0XHRcdFx0Y29uc3QgY2hpbGRyZW4gPSBbLi4ucmVjb3JkLmNoaWxkcmVuXTtcblx0XHRcdFx0XHRcdGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCByZXN1bHRzLmxlbmd0aDsgaW5kZXgrKykge1xuXHRcdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSByZXN1bHRzW2luZGV4XTtcblx0XHRcdFx0XHRcdFx0aWYgKCFyZXN1bHQpIGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0XHRjaGlsZHJlbltpbmRleF0gPSB7XG5cdFx0XHRcdFx0XHRcdFx0Li4uY2hpbGRyZW5baW5kZXhdLFxuXHRcdFx0XHRcdFx0XHRcdC4uLnJlc3VsdFRvQ2hpbGRBcnRpZmFjdChyZXN1bHQsIGluZGV4LCBjaGlsZHJlbltpbmRleF0/LmN3ZCksXG5cdFx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRpZiAoY29tcGxldGVkKSB7XG5cdFx0XHRcdFx0XHRcdGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBjaGlsZHJlbi5sZW5ndGg7IGluZGV4KyspIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBjaGlsZCA9IGNoaWxkcmVuW2luZGV4XTtcblx0XHRcdFx0XHRcdFx0XHRpZiAoY2hpbGQuc3RhdHVzID09PSBcInF1ZXVlZFwiIHx8IGNoaWxkLnN0YXR1cyA9PT0gXCJydW5uaW5nXCIpIHtcblx0XHRcdFx0XHRcdFx0XHRcdGNoaWxkcmVuW2luZGV4XSA9IHtcblx0XHRcdFx0XHRcdFx0XHRcdFx0Li4uY2hpbGQsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdHN0YXR1czogXCJmYWlsZWRcIixcblx0XHRcdFx0XHRcdFx0XHRcdFx0Y29tcGxldGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdFx0XHRcdFx0XHRcdFx0ZXJyb3JNZXNzYWdlOiBcIlN1YmFnZW50IHJ1biBlbmRlZCBiZWZvcmUgdGhpcyBjaGlsZCBjb21wbGV0ZWQuXCIsXG5cdFx0XHRcdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0Y29uc3Qgc3RhdHVzID0gY29tcGxldGVkID8gZGVyaXZlUnVuU3RhdHVzKGNoaWxkcmVuKSA6IFwicnVubmluZ1wiO1xuXHRcdFx0XHRcdFx0Y29uc3QgZmFpbGVkID0gY2hpbGRyZW4uZmluZCgoY2hpbGQpID0+IGNoaWxkLnN0YXR1cyA9PT0gXCJmYWlsZWRcIik7XG5cdFx0XHRcdFx0XHRjb25zdCBpbnRlcnJ1cHRlZCA9IGNoaWxkcmVuLmZpbmQoKGNoaWxkKSA9PiBjaGlsZC5zdGF0dXMgPT09IFwiaW50ZXJydXB0ZWRcIik7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHQuLi5yZWNvcmQsXG5cdFx0XHRcdFx0XHRcdGNoaWxkcmVuLFxuXHRcdFx0XHRcdFx0XHRzdGF0dXMsXG5cdFx0XHRcdFx0XHRcdC4uLihjb21wbGV0ZWQgJiYgc3RhdHVzICE9PSBcInJ1bm5pbmdcIiA/IHsgY29tcGxldGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSB9IDoge30pLFxuXHRcdFx0XHRcdFx0XHQuLi4oaW50ZXJydXB0ZWRcblx0XHRcdFx0XHRcdFx0XHQ/IHsgZmFpbHVyZTogeyB0eXBlOiBcImludGVycnVwdGVkXCIgYXMgY29uc3QsIG1lc3NhZ2U6IGludGVycnVwdGVkLmVycm9yTWVzc2FnZSB8fCBpbnRlcnJ1cHRlZC5zdGRlcnIgfHwgXCJTdWJhZ2VudCBydW4gd2FzIGludGVycnVwdGVkXCIgfSB9XG5cdFx0XHRcdFx0XHRcdFx0OiBmYWlsZWRcblx0XHRcdFx0XHRcdFx0XHRcdD8geyBmYWlsdXJlOiB7IHR5cGU6IGZhaWxlZC5tZXJnZT8uc3VjY2VzcyA9PT0gZmFsc2UgPyBcIm1lcmdlLWZhaWxlZFwiIGFzIGNvbnN0IDogXCJjaGlsZC1mYWlsZWRcIiBhcyBjb25zdCwgbWVzc2FnZTogZmFpbGVkLmVycm9yTWVzc2FnZSB8fCBmYWlsZWQuc3RkZXJyIHx8IGBTdWJhZ2VudCAke2ZhaWxlZC5hZ2VudH0gZmFpbGVkYCB9IH1cblx0XHRcdFx0XHRcdFx0XHRcdDoge30pLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0Ly8gUGVyc2lzdGVuY2UgaXMgb2JzZXJ2YWJpbGl0eTsgZXhlY3V0aW9uIHJlbWFpbnMgYXV0aG9yaXRhdGl2ZS5cblx0XHRcdFx0fVxuXHRcdFx0fTtcblxuXHRcdFx0ZW1pdEpvdXJuYWxFdmVudChjdHguY3dkLCB7XG5cdFx0XHRcdHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRcdGZsb3dJZDogZGlzcGF0Y2hJZCxcblx0XHRcdFx0c2VxOiAwLFxuXHRcdFx0XHRldmVudFR5cGU6IFwic3ViYWdlbnQtaW52b2tlZFwiLFxuXHRcdFx0XHRkYXRhOiB7XG5cdFx0XHRcdFx0ZGlzcGF0Y2hJZCxcblx0XHRcdFx0XHRtb2RlOiBkaXNwYXRjaE1vZGUsXG5cdFx0XHRcdFx0YWdlbnRzOiBkaXNwYXRjaEFnZW50cyxcblx0XHRcdFx0XHRiYXRjaFNpemU6IGRpc3BhdGNoQWdlbnRzLmxlbmd0aCxcblx0XHRcdFx0XHR1bml0VHlwZTogZ2V0Q3VycmVudFBoYXNlKCkgPz8gbnVsbCxcblx0XHRcdFx0XHRpc29sYXRlZDogdXNlSXNvbGF0aW9uLFxuXHRcdFx0XHR9LFxuXHRcdFx0fSk7XG5cblx0XHRcdGNvbnN0IHplcm9Vc2FnZSA9ICgpOiBVc2FnZVN0YXRzID0+ICh7XG5cdFx0XHRcdGlucHV0OiAwLFxuXHRcdFx0XHRvdXRwdXQ6IDAsXG5cdFx0XHRcdGNhY2hlUmVhZDogMCxcblx0XHRcdFx0Y2FjaGVXcml0ZTogMCxcblx0XHRcdFx0Y29zdDogMCxcblx0XHRcdFx0Y29udGV4dFRva2VuczogMCxcblx0XHRcdFx0dHVybnM6IDAsXG5cdFx0XHR9KTtcblx0XHRcdGNvbnN0IGVycm9yTWVzc2FnZUZvciA9IChlcnI6IHVua25vd24pOiBzdHJpbmcgPT5cblx0XHRcdFx0ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIgfHwgXCJzdWJhZ2VudCBkaXNwYXRjaCBmYWlsZWRcIik7XG5cdFx0XHRjb25zdCBtYWtlRmFpbHVyZVJlc3VsdCA9IChcblx0XHRcdFx0ZXJyOiB1bmtub3duLFxuXHRcdFx0XHRhZ2VudDogc3RyaW5nLFxuXHRcdFx0XHR0YXNrOiBzdHJpbmcsXG5cdFx0XHRcdHN0ZXA/OiBudW1iZXIsXG5cdFx0XHRcdHRyYWNraW5nTmFtZT86IHN0cmluZyxcblx0XHRcdCk6IFNpbmdsZVJlc3VsdCA9PiB7XG5cdFx0XHRcdGNvbnN0IG1lc3NhZ2UgPSBlcnJvck1lc3NhZ2VGb3IoZXJyKTtcblx0XHRcdFx0Y29uc3QgZGlzcGF0Y2hJbmRleCA9IGRpc3BhdGNoQWdlbnRzLmZpbmRJbmRleCgoZGlzcGF0Y2hBZ2VudCwgaW5kZXgpID0+XG5cdFx0XHRcdFx0ZGlzcGF0Y2hBZ2VudCA9PT0gYWdlbnQgJiYgZGlzcGF0Y2hUYXNrc1tpbmRleF0gPT09IHRhc2tcblx0XHRcdFx0KTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRhZ2VudCxcblx0XHRcdFx0XHR0cmFja2luZ05hbWU6IHRyYWNraW5nTmFtZSA/PyAoZGlzcGF0Y2hJbmRleCA+PSAwID8gZGlzcGF0Y2hUcmFja2luZ05hbWVzW2Rpc3BhdGNoSW5kZXhdIDogdW5kZWZpbmVkKSxcblx0XHRcdFx0XHRhZ2VudFNvdXJjZTogXCJ1bmtub3duXCIsXG5cdFx0XHRcdFx0dGFzayxcblx0XHRcdFx0XHRleGl0Q29kZTogMSxcblx0XHRcdFx0XHRtZXNzYWdlczogW10sXG5cdFx0XHRcdFx0c3RkZXJyOiBtZXNzYWdlLFxuXHRcdFx0XHRcdHVzYWdlOiB6ZXJvVXNhZ2UoKSxcblx0XHRcdFx0XHRzdG9wUmVhc29uOiBzaWduYWw/LmFib3J0ZWQgPyBcImFib3J0ZWRcIiA6IFwiZXJyb3JcIixcblx0XHRcdFx0XHRlcnJvck1lc3NhZ2U6IG1lc3NhZ2UsXG5cdFx0XHRcdFx0Li4uKHN0ZXAgIT09IHVuZGVmaW5lZCA/IHsgc3RlcCB9IDoge30pLFxuXHRcdFx0XHR9O1xuXHRcdFx0fTtcblx0XHRcdGNvbnN0IHN5bnRoZXNpemVGYWlsdXJlUmVzdWx0cyA9IChlcnI6IHVua25vd24pOiBTaW5nbGVSZXN1bHRbXSA9PiB7XG5cdFx0XHRcdGlmIChmaW5hbFJlc3VsdHMubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRcdGxldCBwYXRjaGVkUnVubmluZyA9IGZhbHNlO1xuXHRcdFx0XHRcdGNvbnN0IHBhdGNoZWQgPSBmaW5hbFJlc3VsdHMubWFwKChyZXN1bHQpID0+IHtcblx0XHRcdFx0XHRcdGlmIChyZXN1bHQuZXhpdENvZGUgIT09IC0xKSByZXR1cm4gcmVzdWx0O1xuXHRcdFx0XHRcdFx0cGF0Y2hlZFJ1bm5pbmcgPSB0cnVlO1xuXHRcdFx0XHRcdFx0Y29uc3QgbWVzc2FnZSA9IGVycm9yTWVzc2FnZUZvcihlcnIpO1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Li4ucmVzdWx0LFxuXHRcdFx0XHRcdFx0XHRleGl0Q29kZTogMSxcblx0XHRcdFx0XHRcdFx0c3RkZXJyOiByZXN1bHQuc3RkZXJyIHx8IG1lc3NhZ2UsXG5cdFx0XHRcdFx0XHRcdHN0b3BSZWFzb246IHNpZ25hbD8uYWJvcnRlZCA/IFwiYWJvcnRlZFwiIDogXCJlcnJvclwiLFxuXHRcdFx0XHRcdFx0XHRlcnJvck1lc3NhZ2U6IHJlc3VsdC5lcnJvck1lc3NhZ2UgfHwgbWVzc2FnZSxcblx0XHRcdFx0XHRcdFx0dXNhZ2U6IHJlc3VsdC51c2FnZSA/PyB6ZXJvVXNhZ2UoKSxcblx0XHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0aWYgKHBhdGNoZWRSdW5uaW5nIHx8IHBhdGNoZWQuc29tZSgocmVzdWx0KSA9PiByZXN1bHQuZXhpdENvZGUgIT09IDApKSByZXR1cm4gcGF0Y2hlZDtcblxuXHRcdFx0XHRcdGNvbnN0IG5leHRJbmRleCA9IGZpbmFsUmVzdWx0cy5sZW5ndGggPCBkaXNwYXRjaEFnZW50cy5sZW5ndGggPyBmaW5hbFJlc3VsdHMubGVuZ3RoIDogMDtcblx0XHRcdFx0XHRpZiAobmV4dEluZGV4ID4gMCkge1xuXHRcdFx0XHRcdFx0cmV0dXJuIFtcblx0XHRcdFx0XHRcdFx0Li4uZmluYWxSZXN1bHRzLFxuXHRcdFx0XHRcdFx0XHRtYWtlRmFpbHVyZVJlc3VsdChcblx0XHRcdFx0XHRcdFx0XHRlcnIsXG5cdFx0XHRcdFx0XHRcdFx0ZGlzcGF0Y2hBZ2VudHNbbmV4dEluZGV4XSA/PyBcInVua25vd25cIixcblx0XHRcdFx0XHRcdFx0XHRkaXNwYXRjaFRhc2tzW25leHRJbmRleF0gPz8gXCJcIixcblx0XHRcdFx0XHRcdFx0XHRkaXNwYXRjaE1vZGUgPT09IFwiY2hhaW5cIiA/IG5leHRJbmRleCArIDEgOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRcdFx0ZGlzcGF0Y2hUcmFja2luZ05hbWVzW25leHRJbmRleF0sXG5cdFx0XHRcdFx0XHRcdCksXG5cdFx0XHRcdFx0XHRdO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXG5cdFx0XHRcdGNvbnN0IGFnZW50c0ZvckZhaWx1cmUgPSBkaXNwYXRjaEFnZW50cy5sZW5ndGggPiAwID8gZGlzcGF0Y2hBZ2VudHMgOiBbXCJ1bmtub3duXCJdO1xuXHRcdFx0XHRyZXR1cm4gYWdlbnRzRm9yRmFpbHVyZS5tYXAoKGFnZW50LCBpbmRleCkgPT5cblx0XHRcdFx0XHRtYWtlRmFpbHVyZVJlc3VsdChcblx0XHRcdFx0XHRcdGVycixcblx0XHRcdFx0XHRcdGFnZW50LFxuXHRcdFx0XHRcdFx0ZGlzcGF0Y2hUYXNrc1tpbmRleF0gPz8gXCJcIixcblx0XHRcdFx0XHRcdGRpc3BhdGNoTW9kZSA9PT0gXCJjaGFpblwiID8gaW5kZXggKyAxIDogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0ZGlzcGF0Y2hUcmFja2luZ05hbWVzW2luZGV4XSxcblx0XHRcdFx0XHQpLFxuXHRcdFx0XHQpO1xuXHRcdFx0fTtcblx0XHRcdGNvbnN0IGZpbmlzaERpc3BhdGNoID0gKHJlc3VsdHM6IFNpbmdsZVJlc3VsdFtdKTogdm9pZCA9PiB7XG5cdFx0XHRcdGlmIChkaXNwYXRjaENvbXBsZXRlZEVtaXR0ZWQpIHJldHVybjtcblx0XHRcdFx0ZmluYWxSZXN1bHRzID0gcmVzdWx0cztcblx0XHRcdFx0ZGlzcGF0Y2hDb21wbGV0ZWRFbWl0dGVkID0gdHJ1ZTtcblx0XHRcdFx0cGVyc2lzdFJ1blJlc3VsdHMocmVzdWx0cywgdHJ1ZSk7XG5cdFx0XHRcdGNvbnN0IHN1Y2Nlc3NDb3VudCA9IHJlc3VsdHMuZmlsdGVyKChyKSA9PiByLmV4aXRDb2RlID09PSAwKS5sZW5ndGg7XG5cdFx0XHRcdGNvbnN0IGZhaWx1cmVDb3VudCA9IHJlc3VsdHMuZmlsdGVyKChyKSA9PiByLmV4aXRDb2RlICE9PSAwKS5sZW5ndGg7XG5cdFx0XHRcdGNvbnN0IHRvdGFsQ29zdCA9IHJlc3VsdHMucmVkdWNlKChzLCByKSA9PiBzICsgKHIudXNhZ2U/LmNvc3QgPz8gMCksIDApO1xuXHRcdFx0XHRjb25zdCB0b3RhbElucHV0VG9rZW5zID0gcmVzdWx0cy5yZWR1Y2UoKHMsIHIpID0+IHMgKyAoci51c2FnZT8uaW5wdXQgPz8gMCksIDApO1xuXHRcdFx0XHRjb25zdCB0b3RhbE91dHB1dFRva2VucyA9IHJlc3VsdHMucmVkdWNlKChzLCByKSA9PiBzICsgKHIudXNhZ2U/Lm91dHB1dCA/PyAwKSwgMCk7XG5cdFx0XHRcdGVtaXRKb3VybmFsRXZlbnQoY3R4LmN3ZCwge1xuXHRcdFx0XHRcdHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRcdFx0Zmxvd0lkOiBkaXNwYXRjaElkLFxuXHRcdFx0XHRcdHNlcTogMSxcblx0XHRcdFx0XHRldmVudFR5cGU6IFwic3ViYWdlbnQtY29tcGxldGVkXCIsXG5cdFx0XHRcdFx0ZGF0YToge1xuXHRcdFx0XHRcdFx0ZGlzcGF0Y2hJZCxcblx0XHRcdFx0XHRcdG1vZGU6IGRpc3BhdGNoTW9kZSxcblx0XHRcdFx0XHRcdGFnZW50czogZGlzcGF0Y2hBZ2VudHMsXG5cdFx0XHRcdFx0XHRzdWNjZXNzQ291bnQsXG5cdFx0XHRcdFx0XHRmYWlsdXJlQ291bnQsXG5cdFx0XHRcdFx0XHR0b3RhbENvc3QsXG5cdFx0XHRcdFx0XHR0b3RhbElucHV0VG9rZW5zLFxuXHRcdFx0XHRcdFx0dG90YWxPdXRwdXRUb2tlbnMsXG5cdFx0XHRcdFx0XHR3YWxsVGltZU1zOiBEYXRlLm5vdygpIC0gZGlzcGF0Y2hTdGFydE1zLFxuXHRcdFx0XHRcdH0sXG5cdFx0XHRcdH0pO1xuXHRcdFx0fTtcblxuXHRcdFx0dHJ5IHtcblx0XHRcdGlmICgoYWdlbnRTY29wZSA9PT0gXCJwcm9qZWN0XCIgfHwgYWdlbnRTY29wZSA9PT0gXCJib3RoXCIpICYmIGNvbmZpcm1Qcm9qZWN0QWdlbnRzICYmIGN0eC5oYXNVSSkge1xuXHRcdFx0XHRjb25zdCByZXF1ZXN0ZWRBZ2VudE5hbWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdFx0XHRcdGlmIChoYXNDaGFpbikgZm9yIChjb25zdCBzdGVwIG9mIGNoYWluUGFyYW1zKSByZXF1ZXN0ZWRBZ2VudE5hbWVzLmFkZChzdGVwLmFnZW50KTtcblx0XHRcdFx0aWYgKGhhc1Rhc2tzKSBmb3IgKGNvbnN0IHQgb2YgdGFza1BhcmFtcykgcmVxdWVzdGVkQWdlbnROYW1lcy5hZGQodC5hZ2VudCk7XG5cdFx0XHRcdGlmIChwYXJhbXMuYWdlbnQpIHJlcXVlc3RlZEFnZW50TmFtZXMuYWRkKHBhcmFtcy5hZ2VudCk7XG5cblx0XHRcdFx0Y29uc3QgcHJvamVjdEFnZW50c1JlcXVlc3RlZCA9IEFycmF5LmZyb20ocmVxdWVzdGVkQWdlbnROYW1lcylcblx0XHRcdFx0XHQubWFwKChuYW1lKSA9PiBhZ2VudHMuZmluZCgoYSkgPT4gYS5uYW1lID09PSBuYW1lKSlcblx0XHRcdFx0XHQuZmlsdGVyKChhKTogYSBpcyBBZ2VudENvbmZpZyA9PiBhPy5zb3VyY2UgPT09IFwicHJvamVjdFwiKTtcblxuXHRcdFx0XHRpZiAocHJvamVjdEFnZW50c1JlcXVlc3RlZC5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0Y29uc3QgbmFtZXMgPSBwcm9qZWN0QWdlbnRzUmVxdWVzdGVkLm1hcCgoYSkgPT4gYS5uYW1lKS5qb2luKFwiLCBcIik7XG5cdFx0XHRcdFx0Y29uc3QgZGlyID0gZGlzY292ZXJ5LnByb2plY3RBZ2VudHNEaXIgPz8gXCIodW5rbm93bilcIjtcblx0XHRcdFx0XHRjb25zdCBvayA9IGF3YWl0IGN0eC51aS5jb25maXJtKFxuXHRcdFx0XHRcdFx0XCJSdW4gcHJvamVjdC1sb2NhbCBhZ2VudHM/XCIsXG5cdFx0XHRcdFx0XHRgQWdlbnRzOiAke25hbWVzfVxcblNvdXJjZTogJHtkaXJ9XFxuXFxuUHJvamVjdCBhZ2VudHMgYXJlIHJlcG8tY29udHJvbGxlZC4gT25seSBjb250aW51ZSBmb3IgdHJ1c3RlZCByZXBvc2l0b3JpZXMuYCxcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdGlmICghb2spIHtcblx0XHRcdFx0XHRcdGZpbmlzaERpc3BhdGNoKFtdKTtcblx0XHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkNhbmNlbGVkOiBwcm9qZWN0LWxvY2FsIGFnZW50cyBub3QgYXBwcm92ZWQuXCIgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IG1ha2VEZXRhaWxzKGhhc0NoYWluID8gXCJjaGFpblwiIDogaGFzVGFza3MgPyBcInBhcmFsbGVsXCIgOiBcInNpbmdsZVwiKShbXSksXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRpZiAocGFyYW1zLmJhY2tncm91bmQpIHtcblx0XHRcdFx0aWYgKCFwYXJhbXMuYWdlbnQgfHwgIXBhcmFtcy50YXNrIHx8IGhhc1Rhc2tzIHx8IGhhc0NoYWluKSB7XG5cdFx0XHRcdFx0Y29uc3QgZmFpbHVyZSA9IG1ha2VGYWlsdXJlUmVzdWx0KFxuXHRcdFx0XHRcdFx0bmV3IEVycm9yKFwiQmFja2dyb3VuZCBsYXVuY2ggY3VycmVudGx5IHJlcXVpcmVzIHNpbmdsZSBtb2RlIHdpdGggYWdlbnQgYW5kIHRhc2suXCIpLFxuXHRcdFx0XHRcdFx0cGFyYW1zLmFnZW50ID8/IFwidW5rbm93blwiLFxuXHRcdFx0XHRcdFx0cGFyYW1zLnRhc2sgPz8gXCJcIixcblx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdGZpbmlzaERpc3BhdGNoKFtmYWlsdXJlXSk7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBmYWlsdXJlLmVycm9yTWVzc2FnZSA/PyBmYWlsdXJlLnN0ZGVyciB9XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IG1ha2VEZXRhaWxzKFwic2luZ2xlXCIpKFtmYWlsdXJlXSksXG5cdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHR2b2lkIChhc3luYyAoKSA9PiB7XG5cdFx0XHRcdFx0bGV0IGlzb2xhdGlvbjogSXNvbGF0aW9uRW52aXJvbm1lbnQgfCBudWxsID0gbnVsbDtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0Y29uc3QgZWZmZWN0aXZlQ3dkID0gcGFyYW1zLmN3ZCA/PyBjdHguY3dkO1xuXHRcdFx0XHRcdFx0aWYgKHVzZUlzb2xhdGlvbikge1xuXHRcdFx0XHRcdFx0XHRjb25zdCB0YXNrSWQgPSBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuXHRcdFx0XHRcdFx0XHRpc29sYXRpb24gPSBhd2FpdCBjcmVhdGVJc29sYXRpb24oZWZmZWN0aXZlQ3dkLCB0YXNrSWQsIGlzb2xhdGlvbk1vZGUpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuU2luZ2xlQWdlbnQoXG5cdFx0XHRcdFx0XHRcdGN0eC5jd2QsXG5cdFx0XHRcdFx0XHRcdGFnZW50cyxcblx0XHRcdFx0XHRcdFx0cGFyYW1zLmFnZW50ISxcblx0XHRcdFx0XHRcdFx0cGFyYW1zLnRhc2shLFxuXHRcdFx0XHRcdFx0XHRpc29sYXRpb24gPyBpc29sYXRpb24ud29ya0RpciA6IHBhcmFtcy5jd2QsXG5cdFx0XHRcdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0XHQocGFydGlhbCkgPT4ge1xuXHRcdFx0XHRcdFx0XHRcdGlmIChwYXJ0aWFsLmRldGFpbHM/LnJlc3VsdHNbMF0pIHBlcnNpc3RSdW5SZXN1bHRzKFtwYXJ0aWFsLmRldGFpbHMucmVzdWx0c1swXV0pO1xuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XHRtYWtlRGV0YWlscyhcInNpbmdsZVwiKSxcblx0XHRcdFx0XHRcdFx0cGFyYW1zLm1vZGVsLFxuXHRcdFx0XHRcdFx0XHRjb250ZXh0TW9kZSxcblx0XHRcdFx0XHRcdFx0Y3R4LnNlc3Npb25NYW5hZ2VyLFxuXHRcdFx0XHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRcdGRpc3BhdGNoVHJhY2tpbmdOYW1lc1swXSxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRpZiAoaXNvbGF0aW9uICYmIHJlc3VsdC5leGl0Q29kZSA9PT0gMCkge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBwYXRjaGVzID0gYXdhaXQgaXNvbGF0aW9uLmNhcHR1cmVEZWx0YSgpO1xuXHRcdFx0XHRcdFx0XHRpZiAocGF0Y2hlcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgbWVyZ2VSZXN1bHQgPSBhd2FpdCBtZXJnZURlbHRhUGF0Y2hlcyhlZmZlY3RpdmVDd2QsIHBhdGNoZXMpO1xuXHRcdFx0XHRcdFx0XHRcdHJlc3VsdC5tZXJnZVJlc3VsdCA9IG1lcmdlUmVzdWx0O1xuXHRcdFx0XHRcdFx0XHRcdGlmICghbWVyZ2VSZXN1bHQuc3VjY2Vzcykge1xuXHRcdFx0XHRcdFx0XHRcdFx0cmVzdWx0LmV4aXRDb2RlID0gMTtcblx0XHRcdFx0XHRcdFx0XHRcdHJlc3VsdC5zdG9wUmVhc29uID0gXCJlcnJvclwiO1xuXHRcdFx0XHRcdFx0XHRcdFx0cmVzdWx0LmVycm9yTWVzc2FnZSA9IGBQYXRjaCBtZXJnZSBmYWlsZWQ6ICR7bWVyZ2VSZXN1bHQuZXJyb3IgfHwgXCJ1bmtub3duIGVycm9yXCJ9YDtcblx0XHRcdFx0XHRcdFx0XHRcdHJlc3VsdC5zdGRlcnIgPSByZXN1bHQuc3RkZXJyIHx8IHJlc3VsdC5lcnJvck1lc3NhZ2U7XG5cdFx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRmaW5hbFJlc3VsdHMgPSBbcmVzdWx0XTtcblx0XHRcdFx0XHRcdGZpbmlzaERpc3BhdGNoKFtyZXN1bHRdKTtcblx0XHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0XHRcdGZpbmFsUmVzdWx0cyA9IHN5bnRoZXNpemVGYWlsdXJlUmVzdWx0cyhlcnIpO1xuXHRcdFx0XHRcdFx0ZmluaXNoRGlzcGF0Y2goZmluYWxSZXN1bHRzKTtcblx0XHRcdFx0XHR9IGZpbmFsbHkge1xuXHRcdFx0XHRcdFx0aWYgKGlzb2xhdGlvbikgYXdhaXQgaXNvbGF0aW9uLmNsZWFudXAoKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0pKCk7XG5cblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbe1xuXHRcdFx0XHRcdFx0dHlwZTogXCJ0ZXh0XCIsXG5cdFx0XHRcdFx0XHR0ZXh0OiBgU3RhcnRlZCBiYWNrZ3JvdW5kIHN1YmFnZW50IHJ1biAke2Rpc3BhdGNoSWR9LiBVc2UgYWN0aW9uOiBcInN0YXR1c1wiIHdpdGggcnVuSWQ6IFwiJHtkaXNwYXRjaElkfVwiIHRvIGluc3BlY3QgaXQuYCxcblx0XHRcdFx0XHR9XSxcblx0XHRcdFx0XHRkZXRhaWxzOiBtYWtlRGV0YWlscyhcInNpbmdsZVwiKShbXSksXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdGlmIChjaGFpblBhcmFtcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdGNvbnN0IHJlc3VsdHM6IFNpbmdsZVJlc3VsdFtdID0gW107XG5cdFx0XHRcdGZpbmFsUmVzdWx0cyA9IHJlc3VsdHM7XG5cdFx0XHRcdGxldCBwcmV2aW91c091dHB1dCA9IFwiXCI7XG5cblx0XHRcdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBjaGFpblBhcmFtcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0XHRcdGNvbnN0IHN0ZXAgPSBjaGFpblBhcmFtc1tpXTtcblx0XHRcdFx0XHRjb25zdCB0YXNrV2l0aENvbnRleHQgPSBzdGVwLnRhc2sucmVwbGFjZSgvXFx7cHJldmlvdXNcXH0vZywgcHJldmlvdXNPdXRwdXQpO1xuXG5cdFx0XHRcdFx0Ly8gQ3JlYXRlIHVwZGF0ZSBjYWxsYmFjayB0aGF0IGluY2x1ZGVzIGFsbCBwcmV2aW91cyByZXN1bHRzXG5cdFx0XHRcdFx0Y29uc3QgY2hhaW5VcGRhdGU6IE9uVXBkYXRlQ2FsbGJhY2sgPSAocGFydGlhbCkgPT4ge1xuXHRcdFx0XHRcdFx0Ly8gQ29tYmluZSBjb21wbGV0ZWQgcmVzdWx0cyB3aXRoIGN1cnJlbnQgc3RyZWFtaW5nIHJlc3VsdFxuXHRcdFx0XHRcdFx0Y29uc3QgY3VycmVudFJlc3VsdCA9IHBhcnRpYWwuZGV0YWlscz8ucmVzdWx0c1swXTtcblx0XHRcdFx0XHRcdGlmIChjdXJyZW50UmVzdWx0KSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IGFsbFJlc3VsdHMgPSBbLi4ucmVzdWx0cywgY3VycmVudFJlc3VsdF07XG5cdFx0XHRcdFx0XHRcdHBlcnNpc3RSdW5SZXN1bHRzKGFsbFJlc3VsdHMpO1xuXHRcdFx0XHRcdFx0XHRpZiAob25VcGRhdGUpIHtcblx0XHRcdFx0XHRcdFx0XHRvblVwZGF0ZSh7XG5cdFx0XHRcdFx0XHRcdFx0XHRjb250ZW50OiBwYXJ0aWFsLmNvbnRlbnQsXG5cdFx0XHRcdFx0XHRcdFx0XHRkZXRhaWxzOiBtYWtlRGV0YWlscyhcImNoYWluXCIpKGFsbFJlc3VsdHMpLFxuXHRcdFx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fTtcblxuXHRcdFx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blNpbmdsZUFnZW50KFxuXHRcdFx0XHRcdFx0Y3R4LmN3ZCxcblx0XHRcdFx0XHRcdGFnZW50cyxcblx0XHRcdFx0XHRcdHN0ZXAuYWdlbnQsXG5cdFx0XHRcdFx0XHR0YXNrV2l0aENvbnRleHQsXG5cdFx0XHRcdFx0XHRzdGVwLmN3ZCxcblx0XHRcdFx0XHRcdGkgKyAxLFxuXHRcdFx0XHRcdFx0c2lnbmFsLFxuXHRcdFx0XHRcdFx0Y2hhaW5VcGRhdGUsXG5cdFx0XHRcdFx0XHRtYWtlRGV0YWlscyhcImNoYWluXCIpLFxuXHRcdFx0XHRcdFx0c3RlcC5tb2RlbCB8fCBwYXJhbXMubW9kZWwsXG5cdFx0XHRcdFx0XHRzdGVwLmNvbnRleHQgPz8gY29udGV4dE1vZGUsXG5cdFx0XHRcdFx0XHRjdHguc2Vzc2lvbk1hbmFnZXIsXG5cdFx0XHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRkaXNwYXRjaFRyYWNraW5nTmFtZXNbaV0sXG5cdFx0XHRcdFx0KTtcblx0XHRcdFx0XHRyZXN1bHRzLnB1c2gocmVzdWx0KTtcblx0XHRcdFx0XHRwZXJzaXN0UnVuUmVzdWx0cyhyZXN1bHRzKTtcblxuXHRcdFx0XHRcdGNvbnN0IGlzRXJyb3IgPVxuXHRcdFx0XHRcdFx0cmVzdWx0LmV4aXRDb2RlICE9PSAwIHx8IHJlc3VsdC5zdG9wUmVhc29uID09PSBcImVycm9yXCIgfHwgcmVzdWx0LnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiO1xuXHRcdFx0XHRcdGlmIChpc0Vycm9yKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBlcnJvck1zZyA9XG5cdFx0XHRcdFx0XHRcdHJlc3VsdC5lcnJvck1lc3NhZ2UgfHwgcmVzdWx0LnN0ZGVyciB8fCBnZXRGaW5hbE91dHB1dChyZXN1bHQubWVzc2FnZXMpIHx8IFwiKG5vIG91dHB1dClcIjtcblx0XHRcdFx0XHRcdGZpbmlzaERpc3BhdGNoKHJlc3VsdHMpO1xuXHRcdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBDaGFpbiBzdG9wcGVkIGF0IHN0ZXAgJHtpICsgMX0gKCR7c3RlcC5hZ2VudH0pOiAke2Vycm9yTXNnfWAgfV0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IG1ha2VEZXRhaWxzKFwiY2hhaW5cIikocmVzdWx0cyksXG5cdFx0XHRcdFx0XHRcdGlzRXJyb3I6IHRydWUsXG5cdFx0XHRcdFx0XHR9O1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRwcmV2aW91c091dHB1dCA9IGdldEZpbmFsT3V0cHV0KHJlc3VsdC5tZXNzYWdlcyk7XG5cdFx0XHRcdH1cblx0XHRcdFx0ZmluaXNoRGlzcGF0Y2gocmVzdWx0cyk7XG5cdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGdldEZpbmFsT3V0cHV0KHJlc3VsdHNbcmVzdWx0cy5sZW5ndGggLSAxXS5tZXNzYWdlcykgfHwgXCIobm8gb3V0cHV0KVwiIH1dLFxuXHRcdFx0XHRcdGRldGFpbHM6IG1ha2VEZXRhaWxzKFwiY2hhaW5cIikocmVzdWx0cyksXG5cdFx0XHRcdH07XG5cdFx0XHR9XG5cblx0XHRcdGlmICh0YXNrUGFyYW1zLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0aWYgKHRhc2tQYXJhbXMubGVuZ3RoID4gTUFYX1BBUkFMTEVMX1RBU0tTKSB7XG5cdFx0XHRcdFx0ZmluaXNoRGlzcGF0Y2goW10pO1xuXHRcdFx0XHRcdHJldHVybiB7XG5cdFx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHRcdHtcblx0XHRcdFx0XHRcdFx0XHR0eXBlOiBcInRleHRcIixcblx0XHRcdFx0XHRcdFx0XHR0ZXh0OiBgVG9vIG1hbnkgcGFyYWxsZWwgdGFza3MgKCR7dGFza1BhcmFtcy5sZW5ndGh9KS4gTWF4IGlzICR7TUFYX1BBUkFMTEVMX1RBU0tTfS5gLFxuXHRcdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdFx0XSxcblx0XHRcdFx0XHRcdGRldGFpbHM6IG1ha2VEZXRhaWxzKFwicGFyYWxsZWxcIikoW10pLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBUcmFjayBhbGwgcmVzdWx0cyBmb3Igc3RyZWFtaW5nIHVwZGF0ZXNcblx0XHRcdFx0Y29uc3QgYWxsUmVzdWx0czogU2luZ2xlUmVzdWx0W10gPSBuZXcgQXJyYXkodGFza1BhcmFtcy5sZW5ndGgpO1xuXG5cdFx0XHRcdC8vIEluaXRpYWxpemUgcGxhY2Vob2xkZXIgcmVzdWx0c1xuXHRcdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHRhc2tQYXJhbXMubGVuZ3RoOyBpKyspIHtcblx0XHRcdFx0XHRhbGxSZXN1bHRzW2ldID0ge1xuXHRcdFx0XHRcdFx0YWdlbnQ6IHRhc2tQYXJhbXNbaV0uYWdlbnQsXG5cdFx0XHRcdFx0XHR0cmFja2luZ05hbWU6IGRpc3BhdGNoVHJhY2tpbmdOYW1lc1tpXSxcblx0XHRcdFx0XHRcdGFnZW50U291cmNlOiBcInVua25vd25cIixcblx0XHRcdFx0XHRcdHRhc2s6IHRhc2tQYXJhbXNbaV0udGFzayxcblx0XHRcdFx0XHRcdGV4aXRDb2RlOiAtMSwgLy8gLTEgPSBzdGlsbCBydW5uaW5nXG5cdFx0XHRcdFx0XHRtZXNzYWdlczogW10sXG5cdFx0XHRcdFx0XHRzdGRlcnI6IFwiXCIsXG5cdFx0XHRcdFx0XHR1c2FnZTogeyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIGNvc3Q6IDAsIGNvbnRleHRUb2tlbnM6IDAsIHR1cm5zOiAwIH0sXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0fVxuXHRcdFx0XHRmaW5hbFJlc3VsdHMgPSBhbGxSZXN1bHRzO1xuXG5cdFx0XHRcdGNvbnN0IGVtaXRQYXJhbGxlbFVwZGF0ZSA9ICgpID0+IHtcblx0XHRcdFx0XHRpZiAob25VcGRhdGUpIHtcblx0XHRcdFx0XHRcdGNvbnN0IHJ1bm5pbmcgPSBhbGxSZXN1bHRzLmZpbHRlcigocikgPT4gci5leGl0Q29kZSA9PT0gLTEpLmxlbmd0aDtcblx0XHRcdFx0XHRcdGNvbnN0IGRvbmUgPSBhbGxSZXN1bHRzLmZpbHRlcigocikgPT4gci5leGl0Q29kZSAhPT0gLTEpLmxlbmd0aDtcblx0XHRcdFx0XHRcdG9uVXBkYXRlKHtcblx0XHRcdFx0XHRcdFx0Y29udGVudDogW1xuXHRcdFx0XHRcdFx0XHRcdHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBQYXJhbGxlbDogJHtkb25lfS8ke2FsbFJlc3VsdHMubGVuZ3RofSBkb25lLCAke3J1bm5pbmd9IHJ1bm5pbmcuLi5gIH0sXG5cdFx0XHRcdFx0XHRcdF0sXG5cdFx0XHRcdFx0XHRcdGRldGFpbHM6IG1ha2VEZXRhaWxzKFwicGFyYWxsZWxcIikoWy4uLmFsbFJlc3VsdHNdKSxcblx0XHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblxuXHRcdFx0XHRjb25zdCBNQVhfUkVUUklFUyA9IDE7IC8vIFJldHJ5IGZhaWxlZCB0YXNrcyBvbmNlXG5cdFx0XHRcdGNvbnN0IGJhdGNoSWQgPSBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuXHRcdFx0XHRjb25zdCBiYXRjaFNpemUgPSB0YXNrUGFyYW1zLmxlbmd0aDtcblx0XHRcdFx0Ly8gUHJlLWNyZWF0ZSBhIGdyaWQgbGF5b3V0IGZvciBjbXV4IHNwbGl0cyBzbyBhZ2VudHMgZ2V0IGEgY2xlYW4gdGlsZWQgYXJyYW5nZW1lbnRcblx0XHRcdFx0Y29uc3QgZ3JpZFN1cmZhY2VzID0gY211eFNwbGl0c0VuYWJsZWRcblx0XHRcdFx0XHQ/IGF3YWl0IGNtdXhDbGllbnQuY3JlYXRlR3JpZExheW91dChNYXRoLm1pbihiYXRjaFNpemUsIE1BWF9DT05DVVJSRU5DWSkpXG5cdFx0XHRcdFx0OiBbXTtcblx0XHRcdFx0Y29uc3QgcmVzdWx0cyA9IGF3YWl0IG1hcFdpdGhDb25jdXJyZW5jeUxpbWl0KHRhc2tQYXJhbXMsIE1BWF9DT05DVVJSRU5DWSwgYXN5bmMgKHQsIGluZGV4KSA9PiB7XG5cdFx0XHRcdFx0Y29uc3Qgd29ya2VySWQgPSByZWdpc3Rlcldvcmtlcih0LmFnZW50LCB0LnRhc2ssIGluZGV4LCBiYXRjaFNpemUsIGJhdGNoSWQpO1xuXHRcdFx0XHRcdGNvbnN0IHRhc2tNb2RlbCA9IHQubW9kZWwgfHwgcGFyYW1zLm1vZGVsO1xuXHRcdFx0XHRcdGNvbnN0IHVwZGF0ZVBhcmFsbGVsUmVzdWx0ID0gKHBhcnRpYWw6IEFnZW50VG9vbFJlc3VsdDxTdWJhZ2VudERldGFpbHM+KSA9PiB7XG5cdFx0XHRcdFx0XHRpZiAocGFydGlhbC5kZXRhaWxzPy5yZXN1bHRzWzBdKSB7XG5cdFx0XHRcdFx0XHRcdGFsbFJlc3VsdHNbaW5kZXhdID0gcGFydGlhbC5kZXRhaWxzLnJlc3VsdHNbMF07XG5cdFx0XHRcdFx0XHRcdHBlcnNpc3RSdW5SZXN1bHRzKFsuLi5hbGxSZXN1bHRzXSk7XG5cdFx0XHRcdFx0XHRcdGVtaXRQYXJhbGxlbFVwZGF0ZSgpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdFx0Y29uc3QgZXhlY3V0ZU9uY2UgPSAocnVuQ3dkOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IGNtdXhTcGxpdHNFbmFibGVkXG5cdFx0XHRcdFx0XHQ/IHJ1blNpbmdsZUFnZW50SW5DbXV4U3BsaXQoXG5cdFx0XHRcdFx0XHRcdFx0Y211eENsaWVudCxcblx0XHRcdFx0XHRcdFx0XHRncmlkU3VyZmFjZXNbaW5kZXhdID8/IChpbmRleCAlIDIgPT09IDAgPyBcInJpZ2h0XCIgOiBcImRvd25cIiksXG5cdFx0XHRcdFx0XHRcdFx0Y3R4LmN3ZCxcblx0XHRcdFx0XHRcdFx0XHRhZ2VudHMsXG5cdFx0XHRcdFx0XHRcdFx0dC5hZ2VudCxcblx0XHRcdFx0XHRcdFx0XHR0LnRhc2ssXG5cdFx0XHRcdFx0XHRcdFx0cnVuQ3dkLFxuXHRcdFx0XHRcdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdFx0XHRzaWduYWwsXG5cdFx0XHRcdFx0XHRcdFx0dXBkYXRlUGFyYWxsZWxSZXN1bHQsXG5cdFx0XHRcdFx0XHRcdFx0bWFrZURldGFpbHMoXCJwYXJhbGxlbFwiKSxcblx0XHRcdFx0XHRcdFx0XHR0YXNrTW9kZWwsXG5cdFx0XHRcdFx0XHRcdFx0dC5jb250ZXh0ID8/IGNvbnRleHRNb2RlLFxuXHRcdFx0XHRcdFx0XHRcdGN0eC5zZXNzaW9uTWFuYWdlcixcblx0XHRcdFx0XHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRcdFx0ZGlzcGF0Y2hUcmFja2luZ05hbWVzW2luZGV4XSxcblx0XHRcdFx0XHRcdFx0KVxuXHRcdFx0XHRcdFx0OiBydW5TaW5nbGVBZ2VudChcblx0XHRcdFx0XHRcdFx0XHRjdHguY3dkLFxuXHRcdFx0XHRcdFx0XHRcdGFnZW50cyxcblx0XHRcdFx0XHRcdFx0XHR0LmFnZW50LFxuXHRcdFx0XHRcdFx0XHRcdHQudGFzayxcblx0XHRcdFx0XHRcdFx0XHRydW5Dd2QsXG5cdFx0XHRcdFx0XHRcdFx0dW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdFx0XHR1cGRhdGVQYXJhbGxlbFJlc3VsdCxcblx0XHRcdFx0XHRcdFx0XHRtYWtlRGV0YWlscyhcInBhcmFsbGVsXCIpLFxuXHRcdFx0XHRcdFx0XHRcdHRhc2tNb2RlbCxcblx0XHRcdFx0XHRcdFx0XHR0LmNvbnRleHQgPz8gY29udGV4dE1vZGUsXG5cdFx0XHRcdFx0XHRcdFx0Y3R4LnNlc3Npb25NYW5hZ2VyLFxuXHRcdFx0XHRcdFx0XHRcdHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdFx0XHRkaXNwYXRjaFRyYWNraW5nTmFtZXNbaW5kZXhdLFxuXHRcdFx0XHRcdFx0XHQpO1xuXHRcdFx0XHRcdGNvbnN0IHJ1blRhc2sgPSBhc3luYyAoKSA9PiB7XG5cdFx0XHRcdFx0XHRsZXQgaXNvbGF0aW9uOiBJc29sYXRpb25FbnZpcm9ubWVudCB8IG51bGwgPSBudWxsO1xuXHRcdFx0XHRcdFx0Y29uc3QgZWZmZWN0aXZlQ3dkID0gdC5jd2QgPz8gY3R4LmN3ZDtcblx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdGlmICh1c2VJc29sYXRpb24pIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCB0YXNrSWQgPSBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuXHRcdFx0XHRcdFx0XHRcdGlzb2xhdGlvbiA9IGF3YWl0IGNyZWF0ZUlzb2xhdGlvbihlZmZlY3RpdmVDd2QsIHRhc2tJZCwgaXNvbGF0aW9uTW9kZSk7XG5cdFx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjdXRlT25jZShpc29sYXRpb24gPyBpc29sYXRpb24ud29ya0RpciA6IHQuY3dkKTtcblx0XHRcdFx0XHRcdFx0aWYgKGlzb2xhdGlvbiAmJiByZXN1bHQuZXhpdENvZGUgPT09IDApIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBwYXRjaGVzID0gYXdhaXQgaXNvbGF0aW9uLmNhcHR1cmVEZWx0YSgpO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IG1lcmdlUmVzdWx0ID0gcGF0Y2hlcy5sZW5ndGggPiAwXG5cdFx0XHRcdFx0XHRcdFx0XHQ/IGF3YWl0IG1lcmdlRGVsdGFQYXRjaGVzKGVmZmVjdGl2ZUN3ZCwgcGF0Y2hlcylcblx0XHRcdFx0XHRcdFx0XHRcdDogeyBzdWNjZXNzOiB0cnVlLCBhcHBsaWVkUGF0Y2hlczogW10sIGZhaWxlZFBhdGNoZXM6IFtdIH07XG5cdFx0XHRcdFx0XHRcdFx0cmVzdWx0Lm1lcmdlUmVzdWx0ID0gbWVyZ2VSZXN1bHQ7XG5cdFx0XHRcdFx0XHRcdFx0aWYgKCFtZXJnZVJlc3VsdC5zdWNjZXNzKSB7XG5cdFx0XHRcdFx0XHRcdFx0XHRyZXN1bHQuZXhpdENvZGUgPSAxO1xuXHRcdFx0XHRcdFx0XHRcdFx0cmVzdWx0LnN0b3BSZWFzb24gPSBcImVycm9yXCI7XG5cdFx0XHRcdFx0XHRcdFx0XHRyZXN1bHQuZXJyb3JNZXNzYWdlID0gYFBhdGNoIG1lcmdlIGZhaWxlZDogJHttZXJnZVJlc3VsdC5lcnJvciB8fCBcInVua25vd24gZXJyb3JcIn1gO1xuXHRcdFx0XHRcdFx0XHRcdFx0cmVzdWx0LnN0ZGVyciA9IHJlc3VsdC5zdGRlcnIgfHwgcmVzdWx0LmVycm9yTWVzc2FnZTtcblx0XHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdFx0cmV0dXJuIHJlc3VsdDtcblx0XHRcdFx0XHRcdH0gZmluYWxseSB7XG5cdFx0XHRcdFx0XHRcdGlmIChpc29sYXRpb24pIGF3YWl0IGlzb2xhdGlvbi5jbGVhbnVwKCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRsZXQgcmVzdWx0ID0gYXdhaXQgcnVuVGFzaygpO1xuXG5cdFx0XHRcdFx0Ly8gQXV0by1yZXRyeSBmYWlsZWQgdGFza3MgKGxpa2VseSBBUEkgcmF0ZSBsaW1pdCBvciB0cmFuc2llbnQgZXJyb3IpXG5cdFx0XHRcdFx0Y29uc3QgaXNGYWlsZWQgPSByZXN1bHQuZXhpdENvZGUgIT09IDAgfHwgKHJlc3VsdC5tZXNzYWdlcy5sZW5ndGggPT09IDAgJiYgIXNpZ25hbD8uYWJvcnRlZCk7XG5cdFx0XHRcdFx0aWYgKGlzRmFpbGVkICYmIE1BWF9SRVRSSUVTID4gMCAmJiAhc2lnbmFsPy5hYm9ydGVkKSB7XG5cdFx0XHRcdFx0XHRyZXN1bHQgPSBhd2FpdCBydW5UYXNrKCk7XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0dXBkYXRlV29ya2VyKHdvcmtlcklkLCByZXN1bHQuZXhpdENvZGUgPT09IDAgPyBcImNvbXBsZXRlZFwiIDogXCJmYWlsZWRcIik7XG5cdFx0XHRcdFx0YWxsUmVzdWx0c1tpbmRleF0gPSByZXN1bHQ7XG5cdFx0XHRcdFx0cGVyc2lzdFJ1blJlc3VsdHMoWy4uLmFsbFJlc3VsdHNdKTtcblx0XHRcdFx0XHRlbWl0UGFyYWxsZWxVcGRhdGUoKTtcblx0XHRcdFx0XHRyZXR1cm4gcmVzdWx0O1xuXHRcdFx0XHR9KTtcblx0XHRcdFx0ZmluYWxSZXN1bHRzID0gcmVzdWx0cztcblxuXHRcdFx0XHRjb25zdCBzdWNjZXNzQ291bnQgPSByZXN1bHRzLmZpbHRlcigocikgPT4gci5leGl0Q29kZSA9PT0gMCkubGVuZ3RoO1xuXHRcdFx0XHRjb25zdCBzdW1tYXJpZXMgPSByZXN1bHRzLm1hcCgocikgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IGlzRXJyb3IgPSByLmV4aXRDb2RlICE9PSAwIHx8IHIuc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiIHx8IHIuc3RvcFJlYXNvbiA9PT0gXCJhYm9ydGVkXCI7XG5cdFx0XHRcdFx0Y29uc3Qgb3V0cHV0ID0gaXNFcnJvclxuXHRcdFx0XHRcdFx0PyAoci5lcnJvck1lc3NhZ2UgfHwgci5zdGRlcnIgfHwgZ2V0RmluYWxPdXRwdXQoci5tZXNzYWdlcykgfHwgXCIobm8gb3V0cHV0KVwiKVxuXHRcdFx0XHRcdFx0OiBnZXRGaW5hbE91dHB1dChyLm1lc3NhZ2VzKTtcblx0XHRcdFx0XHRyZXR1cm4gYFske2Zvcm1hdEFnZW50TGFiZWwoci5hZ2VudCwgci50cmFja2luZ05hbWUpfV0gJHtyLmV4aXRDb2RlID09PSAwID8gXCJjb21wbGV0ZWRcIiA6IGBmYWlsZWQgKGV4aXQgJHtyLmV4aXRDb2RlfSlgfTogJHtvdXRwdXQgfHwgXCIobm8gb3V0cHV0KVwifWA7XG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRmaW5pc2hEaXNwYXRjaChyZXN1bHRzKTtcblx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRjb250ZW50OiBbXG5cdFx0XHRcdFx0XHR7XG5cdFx0XHRcdFx0XHRcdHR5cGU6IFwidGV4dFwiLFxuXHRcdFx0XHRcdFx0XHR0ZXh0OiBgUGFyYWxsZWw6ICR7c3VjY2Vzc0NvdW50fS8ke3Jlc3VsdHMubGVuZ3RofSBzdWNjZWVkZWRcXG5cXG4ke3N1bW1hcmllcy5qb2luKFwiXFxuXFxuXCIpfWAsXG5cdFx0XHRcdFx0XHR9LFxuXHRcdFx0XHRcdF0sXG5cdFx0XHRcdFx0ZGV0YWlsczogbWFrZURldGFpbHMoXCJwYXJhbGxlbFwiKShyZXN1bHRzKSxcblx0XHRcdFx0fTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKHBhcmFtcy5hZ2VudCAmJiBwYXJhbXMudGFzaykge1xuXHRcdFx0XHRsZXQgaXNvbGF0aW9uOiBJc29sYXRpb25FbnZpcm9ubWVudCB8IG51bGwgPSBudWxsO1xuXHRcdFx0XHRsZXQgbWVyZ2VSZXN1bHQ6IE1lcmdlUmVzdWx0IHwgdW5kZWZpbmVkO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IGVmZmVjdGl2ZUN3ZCA9IHBhcmFtcy5jd2QgPz8gY3R4LmN3ZDtcblxuXHRcdFx0XHRcdGlmICh1c2VJc29sYXRpb24pIHtcblx0XHRcdFx0XHRcdGNvbnN0IHRhc2tJZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG5cdFx0XHRcdFx0XHRpc29sYXRpb24gPSBhd2FpdCBjcmVhdGVJc29sYXRpb24oZWZmZWN0aXZlQ3dkLCB0YXNrSWQsIGlzb2xhdGlvbk1vZGUpO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IHNpbmdsZVVwZGF0ZTogT25VcGRhdGVDYWxsYmFjayA9IChwYXJ0aWFsKSA9PiB7XG5cdFx0XHRcdFx0XHRpZiAocGFydGlhbC5kZXRhaWxzPy5yZXN1bHRzWzBdKSBwZXJzaXN0UnVuUmVzdWx0cyhbcGFydGlhbC5kZXRhaWxzLnJlc3VsdHNbMF1dKTtcblx0XHRcdFx0XHRcdGlmIChvblVwZGF0ZSkgb25VcGRhdGUocGFydGlhbCk7XG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRjb25zdCByZXN1bHQgPSBjbXV4U3BsaXRzRW5hYmxlZFxuXHRcdFx0XHRcdFx0PyBhd2FpdCBydW5TaW5nbGVBZ2VudEluQ211eFNwbGl0KFxuXHRcdFx0XHRcdFx0XHRjbXV4Q2xpZW50LFxuXHRcdFx0XHRcdFx0XHRcInJpZ2h0XCIsXG5cdFx0XHRcdFx0XHRcdGN0eC5jd2QsXG5cdFx0XHRcdFx0XHRcdGFnZW50cyxcblx0XHRcdFx0XHRcdFx0cGFyYW1zLmFnZW50LFxuXHRcdFx0XHRcdFx0XHRwYXJhbXMudGFzayxcblx0XHRcdFx0XHRcdFx0aXNvbGF0aW9uID8gaXNvbGF0aW9uLndvcmtEaXIgOiBwYXJhbXMuY3dkLFxuXHRcdFx0XHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdFx0c2luZ2xlVXBkYXRlLFxuXHRcdFx0XHRcdFx0XHRtYWtlRGV0YWlscyhcInNpbmdsZVwiKSxcblx0XHRcdFx0XHRcdFx0cGFyYW1zLm1vZGVsLFxuXHRcdFx0XHRcdFx0XHRjb250ZXh0TW9kZSxcblx0XHRcdFx0XHRcdFx0Y3R4LnNlc3Npb25NYW5hZ2VyLFxuXHRcdFx0XHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRcdGRpc3BhdGNoVHJhY2tpbmdOYW1lc1swXSxcblx0XHRcdFx0XHRcdClcblx0XHRcdFx0XHRcdDogYXdhaXQgcnVuU2luZ2xlQWdlbnQoXG5cdFx0XHRcdFx0XHRcdGN0eC5jd2QsXG5cdFx0XHRcdFx0XHRcdGFnZW50cyxcblx0XHRcdFx0XHRcdFx0cGFyYW1zLmFnZW50LFxuXHRcdFx0XHRcdFx0XHRwYXJhbXMudGFzayxcblx0XHRcdFx0XHRcdFx0aXNvbGF0aW9uID8gaXNvbGF0aW9uLndvcmtEaXIgOiBwYXJhbXMuY3dkLFxuXHRcdFx0XHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRcdHNpZ25hbCxcblx0XHRcdFx0XHRcdFx0c2luZ2xlVXBkYXRlLFxuXHRcdFx0XHRcdFx0XHRtYWtlRGV0YWlscyhcInNpbmdsZVwiKSxcblx0XHRcdFx0XHRcdFx0cGFyYW1zLm1vZGVsLFxuXHRcdFx0XHRcdFx0XHRjb250ZXh0TW9kZSxcblx0XHRcdFx0XHRcdFx0Y3R4LnNlc3Npb25NYW5hZ2VyLFxuXHRcdFx0XHRcdFx0XHR1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRcdGRpc3BhdGNoVHJhY2tpbmdOYW1lc1swXSxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0ZmluYWxSZXN1bHRzID0gW3Jlc3VsdF07XG5cblx0XHRcdFx0XHQvLyBDYXB0dXJlIGFuZCBtZXJnZSBkZWx0YSBpZiBpc29sYXRlZFxuXHRcdFx0XHRcdGlmIChpc29sYXRpb24pIHtcblx0XHRcdFx0XHRcdGNvbnN0IHBhdGNoZXMgPSBhd2FpdCBpc29sYXRpb24uY2FwdHVyZURlbHRhKCk7XG5cdFx0XHRcdFx0XHRpZiAocGF0Y2hlcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRcdFx0XHRcdG1lcmdlUmVzdWx0ID0gYXdhaXQgbWVyZ2VEZWx0YVBhdGNoZXMoZWZmZWN0aXZlQ3dkLCBwYXRjaGVzKTtcblx0XHRcdFx0XHRcdFx0cmVzdWx0Lm1lcmdlUmVzdWx0ID0gbWVyZ2VSZXN1bHQ7XG5cdFx0XHRcdFx0XHRcdGlmICghbWVyZ2VSZXN1bHQuc3VjY2Vzcykge1xuXHRcdFx0XHRcdFx0XHRcdHJlc3VsdC5leGl0Q29kZSA9IDE7XG5cdFx0XHRcdFx0XHRcdFx0cmVzdWx0LnN0b3BSZWFzb24gPSBcImVycm9yXCI7XG5cdFx0XHRcdFx0XHRcdFx0cmVzdWx0LmVycm9yTWVzc2FnZSA9IGBQYXRjaCBtZXJnZSBmYWlsZWQ6ICR7bWVyZ2VSZXN1bHQuZXJyb3IgfHwgXCJ1bmtub3duIGVycm9yXCJ9YDtcblx0XHRcdFx0XHRcdFx0XHRyZXN1bHQuc3RkZXJyID0gcmVzdWx0LnN0ZGVyciB8fCByZXN1bHQuZXJyb3JNZXNzYWdlO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXG5cdFx0XHRcdFx0Y29uc3QgaXNFcnJvciA9IHJlc3VsdC5leGl0Q29kZSAhPT0gMCB8fCByZXN1bHQuc3RvcFJlYXNvbiA9PT0gXCJlcnJvclwiIHx8IHJlc3VsdC5zdG9wUmVhc29uID09PSBcImFib3J0ZWRcIjtcblx0XHRcdFx0XHRpZiAoaXNFcnJvcikge1xuXHRcdFx0XHRcdFx0Y29uc3QgZXJyb3JNc2cgPVxuXHRcdFx0XHRcdFx0XHRyZXN1bHQuZXJyb3JNZXNzYWdlIHx8IHJlc3VsdC5zdGRlcnIgfHwgZ2V0RmluYWxPdXRwdXQocmVzdWx0Lm1lc3NhZ2VzKSB8fCBcIihubyBvdXRwdXQpXCI7XG5cdFx0XHRcdFx0XHRmaW5pc2hEaXNwYXRjaChbcmVzdWx0XSk7XG5cdFx0XHRcdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRcdFx0XHRjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEFnZW50ICR7cmVzdWx0LnN0b3BSZWFzb24gfHwgXCJmYWlsZWRcIn06ICR7ZXJyb3JNc2d9YCB9XSxcblx0XHRcdFx0XHRcdFx0ZGV0YWlsczogbWFrZURldGFpbHMoXCJzaW5nbGVcIikoW3Jlc3VsdF0pLFxuXHRcdFx0XHRcdFx0XHRpc0Vycm9yOiB0cnVlLFxuXHRcdFx0XHRcdFx0fTtcblx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRsZXQgb3V0cHV0VGV4dCA9IGdldEZpbmFsT3V0cHV0KHJlc3VsdC5tZXNzYWdlcykgfHwgXCIobm8gb3V0cHV0KVwiO1xuXHRcdFx0XHRcdGlmIChtZXJnZVJlc3VsdCAmJiAhbWVyZ2VSZXN1bHQuc3VjY2Vzcykge1xuXHRcdFx0XHRcdFx0b3V0cHV0VGV4dCArPSBgXFxuXFxuXHUyNkEwIFBhdGNoIG1lcmdlIGZhaWxlZDogJHttZXJnZVJlc3VsdC5lcnJvciB8fCBcInVua25vd24gZXJyb3JcIn1gO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRmaW5pc2hEaXNwYXRjaChbcmVzdWx0XSk7XG5cdFx0XHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0XHRcdGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBvdXRwdXRUZXh0IH1dLFxuXHRcdFx0XHRcdFx0ZGV0YWlsczogbWFrZURldGFpbHMoXCJzaW5nbGVcIikoW3Jlc3VsdF0pLFxuXHRcdFx0XHRcdH07XG5cdFx0XHRcdH0gZmluYWxseSB7XG5cdFx0XHRcdFx0aWYgKGlzb2xhdGlvbikge1xuXHRcdFx0XHRcdFx0YXdhaXQgaXNvbGF0aW9uLmNsZWFudXAoKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0ZmluaXNoRGlzcGF0Y2goW10pO1xuXHRcdFx0Y29uc3QgYXZhaWxhYmxlID0gYWdlbnRzLm1hcCgoYSkgPT4gYCR7YS5uYW1lfSAoJHthLnNvdXJjZX0pYCkuam9pbihcIiwgXCIpIHx8IFwibm9uZVwiO1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0Y29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBJbnZhbGlkIHBhcmFtZXRlcnMuIEF2YWlsYWJsZSBhZ2VudHM6ICR7YXZhaWxhYmxlfWAgfV0sXG5cdFx0XHRcdGRldGFpbHM6IG1ha2VEZXRhaWxzKFwic2luZ2xlXCIpKFtdKSxcblx0XHRcdH07XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0aWYgKCFkaXNwYXRjaENvbXBsZXRlZEVtaXR0ZWQpIGZpbmFsUmVzdWx0cyA9IHN5bnRoZXNpemVGYWlsdXJlUmVzdWx0cyhlcnIpO1xuXHRcdFx0XHR0aHJvdyBlcnI7XG5cdFx0XHR9IGZpbmFsbHkge1xuXHRcdFx0XHRpZiAoIXBhcmFtcy5iYWNrZ3JvdW5kKSBmaW5pc2hEaXNwYXRjaChmaW5hbFJlc3VsdHMpO1xuXHRcdFx0fVxuXHRcdH0sXG5cblx0XHRyZW5kZXJDYWxsKGFyZ3MsIHRoZW1lKSB7XG5cdFx0XHRjb25zdCBzY29wZTogQWdlbnRTY29wZSA9IGFyZ3MuYWdlbnRTY29wZSA/PyBcImJvdGhcIjtcblx0XHRcdGlmIChhcmdzLmNoYWluICYmIGFyZ3MuY2hhaW4ubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRsZXQgdGV4dCA9XG5cdFx0XHRcdFx0dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcInN1YmFnZW50IFwiKSkgK1xuXHRcdFx0XHRcdHRoZW1lLmZnKFwiYWNjZW50XCIsIGBjaGFpbiAoJHthcmdzLmNoYWluLmxlbmd0aH0gc3RlcHMpYCkgK1xuXHRcdFx0XHRcdHRoZW1lLmZnKFwibXV0ZWRcIiwgYCBbJHtzY29wZX1dYCk7XG5cdFx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgTWF0aC5taW4oYXJncy5jaGFpbi5sZW5ndGgsIDMpOyBpKyspIHtcblx0XHRcdFx0XHRjb25zdCBzdGVwID0gYXJncy5jaGFpbltpXTtcblx0XHRcdFx0XHQvLyBDbGVhbiB1cCB7cHJldmlvdXN9IHBsYWNlaG9sZGVyIGZvciBkaXNwbGF5XG5cdFx0XHRcdFx0Y29uc3QgY2xlYW5UYXNrID0gc3RlcC50YXNrLnJlcGxhY2UoL1xce3ByZXZpb3VzXFx9L2csIFwiXCIpLnRyaW0oKTtcblx0XHRcdFx0XHRjb25zdCBwcmV2aWV3ID0gY2xlYW5UYXNrLmxlbmd0aCA+IDQwID8gYCR7Y2xlYW5UYXNrLnNsaWNlKDAsIDQwKX0uLi5gIDogY2xlYW5UYXNrO1xuXHRcdFx0XHRcdHRleHQgKz1cblx0XHRcdFx0XHRcdFwiXFxuICBcIiArXG5cdFx0XHRcdFx0XHR0aGVtZS5mZyhcIm11dGVkXCIsIGAke2kgKyAxfS5gKSArXG5cdFx0XHRcdFx0XHRcIiBcIiArXG5cdFx0XHRcdFx0XHR0aGVtZS5mZyhcImFjY2VudFwiLCBzdGVwLmFnZW50KSArXG5cdFx0XHRcdFx0XHR0aGVtZS5mZyhcImRpbVwiLCBgICR7cHJldmlld31gKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoYXJncy5jaGFpbi5sZW5ndGggPiAzKSB0ZXh0ICs9IGBcXG4gICR7dGhlbWUuZmcoXCJtdXRlZFwiLCBgLi4uICske2FyZ3MuY2hhaW4ubGVuZ3RoIC0gM30gbW9yZWApfWA7XG5cdFx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcblx0XHRcdH1cblx0XHRcdGlmIChhcmdzLnRhc2tzICYmIGFyZ3MudGFza3MubGVuZ3RoID4gMCkge1xuXHRcdFx0XHRsZXQgdGV4dCA9XG5cdFx0XHRcdFx0dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcInN1YmFnZW50IFwiKSkgK1xuXHRcdFx0XHRcdHRoZW1lLmZnKFwiYWNjZW50XCIsIGBwYXJhbGxlbCAoJHthcmdzLnRhc2tzLmxlbmd0aH0gdGFza3MpYCkgK1xuXHRcdFx0XHRcdHRoZW1lLmZnKFwibXV0ZWRcIiwgYCBbJHtzY29wZX1dYCk7XG5cdFx0XHRcdGZvciAoY29uc3QgdCBvZiBhcmdzLnRhc2tzLnNsaWNlKDAsIDMpKSB7XG5cdFx0XHRcdFx0Y29uc3QgcHJldmlldyA9IHQudGFzay5sZW5ndGggPiA0MCA/IGAke3QudGFzay5zbGljZSgwLCA0MCl9Li4uYCA6IHQudGFzaztcblx0XHRcdFx0XHR0ZXh0ICs9IGBcXG4gICR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgdC5hZ2VudCl9JHt0aGVtZS5mZyhcImRpbVwiLCBgICR7cHJldmlld31gKX1gO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChhcmdzLnRhc2tzLmxlbmd0aCA+IDMpIHRleHQgKz0gYFxcbiAgJHt0aGVtZS5mZyhcIm11dGVkXCIsIGAuLi4gKyR7YXJncy50YXNrcy5sZW5ndGggLSAzfSBtb3JlYCl9YDtcblx0XHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgYWdlbnROYW1lID0gYXJncy5hZ2VudCB8fCBcIi4uLlwiO1xuXHRcdFx0Y29uc3QgcHJldmlldyA9IGFyZ3MudGFzayA/IChhcmdzLnRhc2subGVuZ3RoID4gNjAgPyBgJHthcmdzLnRhc2suc2xpY2UoMCwgNjApfS4uLmAgOiBhcmdzLnRhc2spIDogXCIuLi5cIjtcblx0XHRcdGxldCB0ZXh0ID1cblx0XHRcdFx0dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcInN1YmFnZW50IFwiKSkgK1xuXHRcdFx0XHR0aGVtZS5mZyhcImFjY2VudFwiLCBhZ2VudE5hbWUpICtcblx0XHRcdFx0dGhlbWUuZmcoXCJtdXRlZFwiLCBgIFske3Njb3BlfV1gKTtcblx0XHRcdHRleHQgKz0gYFxcbiAgJHt0aGVtZS5mZyhcImRpbVwiLCBwcmV2aWV3KX1gO1xuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQsIDAsIDApO1xuXHRcdH0sXG5cblx0XHRyZW5kZXJSZXN1bHQocmVzdWx0LCB7IGV4cGFuZGVkIH0sIHRoZW1lKSB7XG5cdFx0XHRjb25zdCBkZXRhaWxzID0gcmVzdWx0LmRldGFpbHMgYXMgU3ViYWdlbnREZXRhaWxzIHwgdW5kZWZpbmVkO1xuXHRcdFx0aWYgKCFkZXRhaWxzIHx8IGRldGFpbHMucmVzdWx0cy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0Y29uc3QgdGV4dCA9IHJlc3VsdC5jb250ZW50WzBdO1xuXHRcdFx0XHRyZXR1cm4gbmV3IFRleHQodGV4dD8udHlwZSA9PT0gXCJ0ZXh0XCIgPyB0ZXh0LnRleHQgOiBcIihubyBvdXRwdXQpXCIsIDAsIDApO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBtZFRoZW1lID0gZ2V0TWFya2Rvd25UaGVtZSgpO1xuXG5cdFx0XHRjb25zdCByZW5kZXJEaXNwbGF5SXRlbXMgPSAoaXRlbXM6IERpc3BsYXlJdGVtW10sIGxpbWl0PzogbnVtYmVyKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHRvU2hvdyA9IGxpbWl0ID8gaXRlbXMuc2xpY2UoLWxpbWl0KSA6IGl0ZW1zO1xuXHRcdFx0XHRjb25zdCBza2lwcGVkID0gbGltaXQgJiYgaXRlbXMubGVuZ3RoID4gbGltaXQgPyBpdGVtcy5sZW5ndGggLSBsaW1pdCA6IDA7XG5cdFx0XHRcdGxldCB0ZXh0ID0gXCJcIjtcblx0XHRcdFx0aWYgKHNraXBwZWQgPiAwKSB0ZXh0ICs9IHRoZW1lLmZnKFwibXV0ZWRcIiwgYC4uLiAke3NraXBwZWR9IGVhcmxpZXIgaXRlbXNcXG5gKTtcblx0XHRcdFx0Zm9yIChjb25zdCBpdGVtIG9mIHRvU2hvdykge1xuXHRcdFx0XHRcdGlmIChpdGVtLnR5cGUgPT09IFwidGV4dFwiKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBwcmV2aWV3ID0gZXhwYW5kZWQgPyBpdGVtLnRleHQgOiBpdGVtLnRleHQuc3BsaXQoXCJcXG5cIikuc2xpY2UoMCwgMykuam9pbihcIlxcblwiKTtcblx0XHRcdFx0XHRcdHRleHQgKz0gYCR7dGhlbWUuZmcoXCJ0b29sT3V0cHV0XCIsIHByZXZpZXcpfVxcbmA7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdHRleHQgKz0gYCR7dGhlbWUuZmcoXCJtdXRlZFwiLCBcIlx1MjE5MiBcIikgKyBmb3JtYXRUb29sQ2FsbChpdGVtLm5hbWUsIGl0ZW0uYXJncywgdGhlbWUuZmcuYmluZCh0aGVtZSkpfVxcbmA7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdHJldHVybiB0ZXh0LnRyaW1FbmQoKTtcblx0XHRcdH07XG5cblx0XHRcdGlmIChkZXRhaWxzLm1vZGUgPT09IFwic2luZ2xlXCIgJiYgZGV0YWlscy5yZXN1bHRzLmxlbmd0aCA9PT0gMSkge1xuXHRcdFx0XHRjb25zdCByID0gZGV0YWlscy5yZXN1bHRzWzBdO1xuXHRcdFx0XHRjb25zdCBpc0Vycm9yID0gci5leGl0Q29kZSAhPT0gMCB8fCByLnN0b3BSZWFzb24gPT09IFwiZXJyb3JcIiB8fCByLnN0b3BSZWFzb24gPT09IFwiYWJvcnRlZFwiO1xuXHRcdFx0XHRjb25zdCBpY29uID0gaXNFcnJvciA/IHRoZW1lLmZnKFwiZXJyb3JcIiwgXCJcdTI3MTdcIikgOiB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJcdTI3MTNcIik7XG5cdFx0XHRcdGNvbnN0IGRpc3BsYXlJdGVtcyA9IGdldERpc3BsYXlJdGVtcyhyLm1lc3NhZ2VzKTtcblx0XHRcdFx0Y29uc3QgZmluYWxPdXRwdXQgPSBnZXRGaW5hbE91dHB1dChyLm1lc3NhZ2VzKTtcblxuXHRcdFx0XHRpZiAoZXhwYW5kZWQpIHtcblx0XHRcdFx0XHRjb25zdCBjb250YWluZXIgPSBuZXcgQ29udGFpbmVyKCk7XG5cdFx0XHRcdFx0bGV0IGhlYWRlciA9IGAke2ljb259ICR7dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChmb3JtYXRBZ2VudExhYmVsKHIuYWdlbnQsIHIudHJhY2tpbmdOYW1lKSkpfSR7dGhlbWUuZmcoXCJtdXRlZFwiLCBgICgke3IuYWdlbnRTb3VyY2V9KWApfWA7XG5cdFx0XHRcdFx0aWYgKGlzRXJyb3IgJiYgci5zdG9wUmVhc29uKSBoZWFkZXIgKz0gYCAke3RoZW1lLmZnKFwiZXJyb3JcIiwgYFske3Iuc3RvcFJlYXNvbn1dYCl9YDtcblx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQoaGVhZGVyLCAwLCAwKSk7XG5cdFx0XHRcdFx0aWYgKGlzRXJyb3IgJiYgci5lcnJvck1lc3NhZ2UpXG5cdFx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJlcnJvclwiLCBgRXJyb3I6ICR7ci5lcnJvck1lc3NhZ2V9YCksIDAsIDApKTtcblx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0XHRcdFx0Y29udGFpbmVyLmFkZENoaWxkKG5ldyBUZXh0KHRoZW1lLmZnKFwibXV0ZWRcIiwgXCJcdTI1MDBcdTI1MDBcdTI1MDAgVGFzayBcdTI1MDBcdTI1MDBcdTI1MDBcIiksIDAsIDApKTtcblx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJkaW1cIiwgci50YXNrKSwgMCwgMCkpO1xuXHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJtdXRlZFwiLCBcIlx1MjUwMFx1MjUwMFx1MjUwMCBPdXRwdXQgXHUyNTAwXHUyNTAwXHUyNTAwXCIpLCAwLCAwKSk7XG5cdFx0XHRcdFx0aWYgKGRpc3BsYXlJdGVtcy5sZW5ndGggPT09IDAgJiYgIWZpbmFsT3V0cHV0KSB7XG5cdFx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJtdXRlZFwiLCBcIihubyBvdXRwdXQpXCIpLCAwLCAwKSk7XG5cdFx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRcdGZvciAoY29uc3QgaXRlbSBvZiBkaXNwbGF5SXRlbXMpIHtcblx0XHRcdFx0XHRcdFx0aWYgKGl0ZW0udHlwZSA9PT0gXCJ0b29sQ2FsbFwiKVxuXHRcdFx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdFx0XHRcdFx0XHRcdG5ldyBUZXh0KFxuXHRcdFx0XHRcdFx0XHRcdFx0XHR0aGVtZS5mZyhcIm11dGVkXCIsIFwiXHUyMTkyIFwiKSArIGZvcm1hdFRvb2xDYWxsKGl0ZW0ubmFtZSwgaXRlbS5hcmdzLCB0aGVtZS5mZy5iaW5kKHRoZW1lKSksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRpZiAoZmluYWxPdXRwdXQpIHtcblx0XHRcdFx0XHRcdFx0Y29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IE1hcmtkb3duKGZpbmFsT3V0cHV0LnRyaW0oKSwgMCwgMCwgbWRUaGVtZSkpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb25zdCB1c2FnZVN0ciA9IGZvcm1hdFVzYWdlU3RhdHMoci51c2FnZSwgci5tb2RlbCk7XG5cdFx0XHRcdFx0aWYgKHVzYWdlU3RyKSB7XG5cdFx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJkaW1cIiwgdXNhZ2VTdHIpLCAwLCAwKSk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdHJldHVybiBjb250YWluZXI7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRsZXQgdGV4dCA9IGAke2ljb259ICR7dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChmb3JtYXRBZ2VudExhYmVsKHIuYWdlbnQsIHIudHJhY2tpbmdOYW1lKSkpfSR7dGhlbWUuZmcoXCJtdXRlZFwiLCBgICgke3IuYWdlbnRTb3VyY2V9KWApfWA7XG5cdFx0XHRcdGlmIChpc0Vycm9yICYmIHIuc3RvcFJlYXNvbikgdGV4dCArPSBgICR7dGhlbWUuZmcoXCJlcnJvclwiLCBgWyR7ci5zdG9wUmVhc29ufV1gKX1gO1xuXHRcdFx0XHRpZiAoaXNFcnJvciAmJiByLmVycm9yTWVzc2FnZSkgdGV4dCArPSBgXFxuJHt0aGVtZS5mZyhcImVycm9yXCIsIGBFcnJvcjogJHtyLmVycm9yTWVzc2FnZX1gKX1gO1xuXHRcdFx0XHRlbHNlIGlmIChkaXNwbGF5SXRlbXMubGVuZ3RoID09PSAwKSB0ZXh0ICs9IGBcXG4ke3RoZW1lLmZnKFwibXV0ZWRcIiwgXCIobm8gb3V0cHV0KVwiKX1gO1xuXHRcdFx0XHRlbHNlIHtcblx0XHRcdFx0XHR0ZXh0ICs9IGBcXG4ke3JlbmRlckRpc3BsYXlJdGVtcyhkaXNwbGF5SXRlbXMsIENPTExBUFNFRF9JVEVNX0NPVU5UKX1gO1xuXHRcdFx0XHRcdGlmIChkaXNwbGF5SXRlbXMubGVuZ3RoID4gQ09MTEFQU0VEX0lURU1fQ09VTlQpIHRleHQgKz0gYFxcbiR7dGhlbWUuZmcoXCJtdXRlZFwiLCBcIihDdHJsK08gdG8gZXhwYW5kKVwiKX1gO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IHVzYWdlU3RyID0gZm9ybWF0VXNhZ2VTdGF0cyhyLnVzYWdlLCByLm1vZGVsKTtcblx0XHRcdFx0aWYgKHVzYWdlU3RyKSB0ZXh0ICs9IGBcXG4ke3RoZW1lLmZnKFwiZGltXCIsIHVzYWdlU3RyKX1gO1xuXHRcdFx0XHRyZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGFnZ3JlZ2F0ZVVzYWdlID0gKHJlc3VsdHM6IFNpbmdsZVJlc3VsdFtdKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHRvdGFsID0geyBpbnB1dDogMCwgb3V0cHV0OiAwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAsIGNvc3Q6IDAsIHR1cm5zOiAwIH07XG5cdFx0XHRcdGZvciAoY29uc3QgciBvZiByZXN1bHRzKSB7XG5cdFx0XHRcdFx0dG90YWwuaW5wdXQgKz0gci51c2FnZS5pbnB1dDtcblx0XHRcdFx0XHR0b3RhbC5vdXRwdXQgKz0gci51c2FnZS5vdXRwdXQ7XG5cdFx0XHRcdFx0dG90YWwuY2FjaGVSZWFkICs9IHIudXNhZ2UuY2FjaGVSZWFkO1xuXHRcdFx0XHRcdHRvdGFsLmNhY2hlV3JpdGUgKz0gci51c2FnZS5jYWNoZVdyaXRlO1xuXHRcdFx0XHRcdHRvdGFsLmNvc3QgKz0gci51c2FnZS5jb3N0O1xuXHRcdFx0XHRcdHRvdGFsLnR1cm5zICs9IHIudXNhZ2UudHVybnM7XG5cdFx0XHRcdH1cblx0XHRcdFx0cmV0dXJuIHRvdGFsO1xuXHRcdFx0fTtcblxuXHRcdFx0aWYgKGRldGFpbHMubW9kZSA9PT0gXCJjaGFpblwiKSB7XG5cdFx0XHRcdGNvbnN0IHN1Y2Nlc3NDb3VudCA9IGRldGFpbHMucmVzdWx0cy5maWx0ZXIoKHIpID0+IHIuZXhpdENvZGUgPT09IDApLmxlbmd0aDtcblx0XHRcdFx0Y29uc3QgaWNvbiA9IHN1Y2Nlc3NDb3VudCA9PT0gZGV0YWlscy5yZXN1bHRzLmxlbmd0aCA/IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlx1MjcxM1wiKSA6IHRoZW1lLmZnKFwiZXJyb3JcIiwgXCJcdTI3MTdcIik7XG5cblx0XHRcdFx0aWYgKGV4cGFuZGVkKSB7XG5cdFx0XHRcdFx0Y29uc3QgY29udGFpbmVyID0gbmV3IENvbnRhaW5lcigpO1xuXHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdFx0XHRcdG5ldyBUZXh0KFxuXHRcdFx0XHRcdFx0XHRpY29uICtcblx0XHRcdFx0XHRcdFx0XHRcIiBcIiArXG5cdFx0XHRcdFx0XHRcdFx0dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcImNoYWluIFwiKSkgK1xuXHRcdFx0XHRcdFx0XHRcdHRoZW1lLmZnKFwiYWNjZW50XCIsIGAke3N1Y2Nlc3NDb3VudH0vJHtkZXRhaWxzLnJlc3VsdHMubGVuZ3RofSBzdGVwc2ApLFxuXHRcdFx0XHRcdFx0XHQwLFxuXHRcdFx0XHRcdFx0XHQwLFxuXHRcdFx0XHRcdFx0KSxcblx0XHRcdFx0XHQpO1xuXG5cdFx0XHRcdFx0Zm9yIChjb25zdCByIG9mIGRldGFpbHMucmVzdWx0cykge1xuXHRcdFx0XHRcdFx0Y29uc3Qgckljb24gPSByLmV4aXRDb2RlID09PSAwID8gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiXHUyNzEzXCIpIDogdGhlbWUuZmcoXCJlcnJvclwiLCBcIlx1MjcxN1wiKTtcblx0XHRcdFx0XHRcdGNvbnN0IGRpc3BsYXlJdGVtcyA9IGdldERpc3BsYXlJdGVtcyhyLm1lc3NhZ2VzKTtcblx0XHRcdFx0XHRcdGNvbnN0IGZpbmFsT3V0cHV0ID0gZ2V0RmluYWxPdXRwdXQoci5tZXNzYWdlcyk7XG5cblx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdFx0XHRcdFx0bmV3IFRleHQoXG5cdFx0XHRcdFx0XHRcdFx0YCR7dGhlbWUuZmcoXCJtdXRlZFwiLCBgXHUyNTAwXHUyNTAwXHUyNTAwIFN0ZXAgJHtyLnN0ZXB9OiBgKSArIHRoZW1lLmZnKFwiYWNjZW50XCIsIGZvcm1hdEFnZW50TGFiZWwoci5hZ2VudCwgci50cmFja2luZ05hbWUpKX0gJHtySWNvbn1gLFxuXHRcdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHRcdFx0MCxcblx0XHRcdFx0XHRcdFx0KSxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJtdXRlZFwiLCBcIlRhc2s6IFwiKSArIHRoZW1lLmZnKFwiZGltXCIsIHIudGFzayksIDAsIDApKTtcblxuXHRcdFx0XHRcdFx0Ly8gU2hvdyB0b29sIGNhbGxzXG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGl0ZW0gb2YgZGlzcGxheUl0ZW1zKSB7XG5cdFx0XHRcdFx0XHRcdGlmIChpdGVtLnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdFx0XHRcdFx0XHRcdG5ldyBUZXh0KFxuXHRcdFx0XHRcdFx0XHRcdFx0XHR0aGVtZS5mZyhcIm11dGVkXCIsIFwiXHUyMTkyIFwiKSArIGZvcm1hdFRvb2xDYWxsKGl0ZW0ubmFtZSwgaXRlbS5hcmdzLCB0aGVtZS5mZy5iaW5kKHRoZW1lKSksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Ly8gU2hvdyBmaW5hbCBvdXRwdXQgYXMgbWFya2Rvd25cblx0XHRcdFx0XHRcdGlmIChmaW5hbE91dHB1dCkge1xuXHRcdFx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgTWFya2Rvd24oZmluYWxPdXRwdXQudHJpbSgpLCAwLCAwLCBtZFRoZW1lKSk7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IHN0ZXBVc2FnZSA9IGZvcm1hdFVzYWdlU3RhdHMoci51c2FnZSwgci5tb2RlbCk7XG5cdFx0XHRcdFx0XHRpZiAoc3RlcFVzYWdlKSBjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJkaW1cIiwgc3RlcFVzYWdlKSwgMCwgMCkpO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IHVzYWdlU3RyID0gZm9ybWF0VXNhZ2VTdGF0cyhhZ2dyZWdhdGVVc2FnZShkZXRhaWxzLnJlc3VsdHMpKTtcblx0XHRcdFx0XHRpZiAodXNhZ2VTdHIpIHtcblx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcImRpbVwiLCBgVG90YWw6ICR7dXNhZ2VTdHJ9YCksIDAsIDApKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIGNvbnRhaW5lcjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIENvbGxhcHNlZCB2aWV3XG5cdFx0XHRcdGxldCB0ZXh0ID1cblx0XHRcdFx0XHRpY29uICtcblx0XHRcdFx0XHRcIiBcIiArXG5cdFx0XHRcdFx0dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcImNoYWluIFwiKSkgK1xuXHRcdFx0XHRcdHRoZW1lLmZnKFwiYWNjZW50XCIsIGAke3N1Y2Nlc3NDb3VudH0vJHtkZXRhaWxzLnJlc3VsdHMubGVuZ3RofSBzdGVwc2ApO1xuXHRcdFx0XHRmb3IgKGNvbnN0IHIgb2YgZGV0YWlscy5yZXN1bHRzKSB7XG5cdFx0XHRcdFx0Y29uc3Qgckljb24gPSByLmV4aXRDb2RlID09PSAwID8gdGhlbWUuZmcoXCJzdWNjZXNzXCIsIFwiXHUyNzEzXCIpIDogdGhlbWUuZmcoXCJlcnJvclwiLCBcIlx1MjcxN1wiKTtcblx0XHRcdFx0XHRjb25zdCBkaXNwbGF5SXRlbXMgPSBnZXREaXNwbGF5SXRlbXMoci5tZXNzYWdlcyk7XG5cdFx0XHRcdFx0dGV4dCArPSBgXFxuXFxuJHt0aGVtZS5mZyhcIm11dGVkXCIsIGBcdTI1MDBcdTI1MDBcdTI1MDAgU3RlcCAke3Iuc3RlcH06IGApfSR7dGhlbWUuZmcoXCJhY2NlbnRcIiwgZm9ybWF0QWdlbnRMYWJlbChyLmFnZW50LCByLnRyYWNraW5nTmFtZSkpfSAke3JJY29ufWA7XG5cdFx0XHRcdFx0aWYgKGRpc3BsYXlJdGVtcy5sZW5ndGggPT09IDApIHRleHQgKz0gYFxcbiR7dGhlbWUuZmcoXCJtdXRlZFwiLCBcIihubyBvdXRwdXQpXCIpfWA7XG5cdFx0XHRcdFx0ZWxzZSB0ZXh0ICs9IGBcXG4ke3JlbmRlckRpc3BsYXlJdGVtcyhkaXNwbGF5SXRlbXMsIDUpfWA7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgdXNhZ2VTdHIgPSBmb3JtYXRVc2FnZVN0YXRzKGFnZ3JlZ2F0ZVVzYWdlKGRldGFpbHMucmVzdWx0cykpO1xuXHRcdFx0XHRpZiAodXNhZ2VTdHIpIHRleHQgKz0gYFxcblxcbiR7dGhlbWUuZmcoXCJkaW1cIiwgYFRvdGFsOiAke3VzYWdlU3RyfWApfWA7XG5cdFx0XHRcdHRleHQgKz0gYFxcbiR7dGhlbWUuZmcoXCJtdXRlZFwiLCBcIihDdHJsK08gdG8gZXhwYW5kKVwiKX1gO1xuXHRcdFx0XHRyZXR1cm4gbmV3IFRleHQodGV4dCwgMCwgMCk7XG5cdFx0XHR9XG5cblx0XHRcdGlmIChkZXRhaWxzLm1vZGUgPT09IFwicGFyYWxsZWxcIikge1xuXHRcdFx0XHRjb25zdCBydW5uaW5nID0gZGV0YWlscy5yZXN1bHRzLmZpbHRlcigocikgPT4gci5leGl0Q29kZSA9PT0gLTEpLmxlbmd0aDtcblx0XHRcdFx0Y29uc3Qgc3VjY2Vzc0NvdW50ID0gZGV0YWlscy5yZXN1bHRzLmZpbHRlcigocikgPT4gci5leGl0Q29kZSA9PT0gMCkubGVuZ3RoO1xuXHRcdFx0XHRjb25zdCBmYWlsQ291bnQgPSBkZXRhaWxzLnJlc3VsdHMuZmlsdGVyKChyKSA9PiByLmV4aXRDb2RlID4gMCkubGVuZ3RoO1xuXHRcdFx0XHRjb25zdCBpc1J1bm5pbmcgPSBydW5uaW5nID4gMDtcblx0XHRcdFx0Y29uc3QgaWNvbiA9IGlzUnVubmluZ1xuXHRcdFx0XHRcdD8gdGhlbWUuZmcoXCJ3YXJuaW5nXCIsIFwiXHUyM0YzXCIpXG5cdFx0XHRcdFx0OiBmYWlsQ291bnQgPiAwXG5cdFx0XHRcdFx0XHQ/IHRoZW1lLmZnKFwid2FybmluZ1wiLCBcIlx1MjVEMFwiKVxuXHRcdFx0XHRcdFx0OiB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJcdTI3MTNcIik7XG5cdFx0XHRcdGNvbnN0IHN0YXR1cyA9IGlzUnVubmluZ1xuXHRcdFx0XHRcdD8gYCR7c3VjY2Vzc0NvdW50ICsgZmFpbENvdW50fS8ke2RldGFpbHMucmVzdWx0cy5sZW5ndGh9IGRvbmUsICR7cnVubmluZ30gcnVubmluZ2Bcblx0XHRcdFx0XHQ6IGAke3N1Y2Nlc3NDb3VudH0vJHtkZXRhaWxzLnJlc3VsdHMubGVuZ3RofSB0YXNrc2A7XG5cblx0XHRcdFx0aWYgKGV4cGFuZGVkICYmICFpc1J1bm5pbmcpIHtcblx0XHRcdFx0XHRjb25zdCBjb250YWluZXIgPSBuZXcgQ29udGFpbmVyKCk7XG5cdFx0XHRcdFx0Y29udGFpbmVyLmFkZENoaWxkKFxuXHRcdFx0XHRcdFx0bmV3IFRleHQoXG5cdFx0XHRcdFx0XHRcdGAke2ljb259ICR7dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcInBhcmFsbGVsIFwiKSl9JHt0aGVtZS5mZyhcImFjY2VudFwiLCBzdGF0dXMpfWAsXG5cdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdCk7XG5cblx0XHRcdFx0XHRmb3IgKGNvbnN0IHIgb2YgZGV0YWlscy5yZXN1bHRzKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBySWNvbiA9IHIuZXhpdENvZGUgPT09IDAgPyB0aGVtZS5mZyhcInN1Y2Nlc3NcIiwgXCJcdTI3MTNcIikgOiB0aGVtZS5mZyhcImVycm9yXCIsIFwiXHUyNzE3XCIpO1xuXHRcdFx0XHRcdFx0Y29uc3QgZGlzcGxheUl0ZW1zID0gZ2V0RGlzcGxheUl0ZW1zKHIubWVzc2FnZXMpO1xuXHRcdFx0XHRcdFx0Y29uc3QgZmluYWxPdXRwdXQgPSBnZXRGaW5hbE91dHB1dChyLm1lc3NhZ2VzKTtcblxuXHRcdFx0XHRcdFx0Y29udGFpbmVyLmFkZENoaWxkKG5ldyBTcGFjZXIoMSkpO1xuXHRcdFx0XHRcdFx0Y29udGFpbmVyLmFkZENoaWxkKFxuXHRcdFx0XHRcdFx0XHRuZXcgVGV4dChgJHt0aGVtZS5mZyhcIm11dGVkXCIsIFwiXHUyNTAwXHUyNTAwXHUyNTAwIFwiKSArIHRoZW1lLmZnKFwiYWNjZW50XCIsIGZvcm1hdEFnZW50TGFiZWwoci5hZ2VudCwgci50cmFja2luZ05hbWUpKX0gJHtySWNvbn1gLCAwLCAwKSxcblx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJtdXRlZFwiLCBcIlRhc2s6IFwiKSArIHRoZW1lLmZnKFwiZGltXCIsIHIudGFzayksIDAsIDApKTtcblxuXHRcdFx0XHRcdFx0Ly8gU2hvdyB0b29sIGNhbGxzXG5cdFx0XHRcdFx0XHRmb3IgKGNvbnN0IGl0ZW0gb2YgZGlzcGxheUl0ZW1zKSB7XG5cdFx0XHRcdFx0XHRcdGlmIChpdGVtLnR5cGUgPT09IFwidG9vbENhbGxcIikge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChcblx0XHRcdFx0XHRcdFx0XHRcdG5ldyBUZXh0KFxuXHRcdFx0XHRcdFx0XHRcdFx0XHR0aGVtZS5mZyhcIm11dGVkXCIsIFwiXHUyMTkyIFwiKSArIGZvcm1hdFRvb2xDYWxsKGl0ZW0ubmFtZSwgaXRlbS5hcmdzLCB0aGVtZS5mZy5iaW5kKHRoZW1lKSksXG5cdFx0XHRcdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHRcdFx0XHRcdDAsXG5cdFx0XHRcdFx0XHRcdFx0XHQpLFxuXHRcdFx0XHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdFx0Ly8gU2hvdyBmaW5hbCBvdXRwdXQgYXMgbWFya2Rvd25cblx0XHRcdFx0XHRcdGlmIChmaW5hbE91dHB1dCkge1xuXHRcdFx0XHRcdFx0XHRjb250YWluZXIuYWRkQ2hpbGQobmV3IFNwYWNlcigxKSk7XG5cdFx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgTWFya2Rvd24oZmluYWxPdXRwdXQudHJpbSgpLCAwLCAwLCBtZFRoZW1lKSk7XG5cdFx0XHRcdFx0XHR9XG5cblx0XHRcdFx0XHRcdGNvbnN0IHRhc2tVc2FnZSA9IGZvcm1hdFVzYWdlU3RhdHMoci51c2FnZSwgci5tb2RlbCk7XG5cdFx0XHRcdFx0XHRpZiAodGFza1VzYWdlKSBjb250YWluZXIuYWRkQ2hpbGQobmV3IFRleHQodGhlbWUuZmcoXCJkaW1cIiwgdGFza1VzYWdlKSwgMCwgMCkpO1xuXHRcdFx0XHRcdH1cblxuXHRcdFx0XHRcdGNvbnN0IHVzYWdlU3RyID0gZm9ybWF0VXNhZ2VTdGF0cyhhZ2dyZWdhdGVVc2FnZShkZXRhaWxzLnJlc3VsdHMpKTtcblx0XHRcdFx0XHRpZiAodXNhZ2VTdHIpIHtcblx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgU3BhY2VyKDEpKTtcblx0XHRcdFx0XHRcdGNvbnRhaW5lci5hZGRDaGlsZChuZXcgVGV4dCh0aGVtZS5mZyhcImRpbVwiLCBgVG90YWw6ICR7dXNhZ2VTdHJ9YCksIDAsIDApKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0cmV0dXJuIGNvbnRhaW5lcjtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIENvbGxhcHNlZCB2aWV3IChvciBzdGlsbCBydW5uaW5nKVxuXHRcdFx0XHRsZXQgdGV4dCA9IGAke2ljb259ICR7dGhlbWUuZmcoXCJ0b29sVGl0bGVcIiwgdGhlbWUuYm9sZChcInBhcmFsbGVsIFwiKSl9JHt0aGVtZS5mZyhcImFjY2VudFwiLCBzdGF0dXMpfWA7XG5cdFx0XHRcdGZvciAoY29uc3QgciBvZiBkZXRhaWxzLnJlc3VsdHMpIHtcblx0XHRcdFx0XHRjb25zdCBySWNvbiA9XG5cdFx0XHRcdFx0XHRyLmV4aXRDb2RlID09PSAtMVxuXHRcdFx0XHRcdFx0XHQ/IHRoZW1lLmZnKFwid2FybmluZ1wiLCBcIlx1MjNGM1wiKVxuXHRcdFx0XHRcdFx0XHQ6IHIuZXhpdENvZGUgPT09IDBcblx0XHRcdFx0XHRcdFx0XHQ/IHRoZW1lLmZnKFwic3VjY2Vzc1wiLCBcIlx1MjcxM1wiKVxuXHRcdFx0XHRcdFx0XHRcdDogdGhlbWUuZmcoXCJlcnJvclwiLCBcIlx1MjcxN1wiKTtcblx0XHRcdFx0XHRjb25zdCBkaXNwbGF5SXRlbXMgPSBnZXREaXNwbGF5SXRlbXMoci5tZXNzYWdlcyk7XG5cdFx0XHRcdFx0dGV4dCArPSBgXFxuXFxuJHt0aGVtZS5mZyhcIm11dGVkXCIsIFwiXHUyNTAwXHUyNTAwXHUyNTAwIFwiKX0ke3RoZW1lLmZnKFwiYWNjZW50XCIsIGZvcm1hdEFnZW50TGFiZWwoci5hZ2VudCwgci50cmFja2luZ05hbWUpKX0gJHtySWNvbn1gO1xuXHRcdFx0XHRcdGlmIChkaXNwbGF5SXRlbXMubGVuZ3RoID09PSAwKVxuXHRcdFx0XHRcdFx0dGV4dCArPSBgXFxuJHt0aGVtZS5mZyhcIm11dGVkXCIsIHIuZXhpdENvZGUgPT09IC0xID8gXCIocnVubmluZy4uLilcIiA6IFwiKG5vIG91dHB1dClcIil9YDtcblx0XHRcdFx0XHRlbHNlIHRleHQgKz0gYFxcbiR7cmVuZGVyRGlzcGxheUl0ZW1zKGRpc3BsYXlJdGVtcywgNSl9YDtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoIWlzUnVubmluZykge1xuXHRcdFx0XHRcdGNvbnN0IHVzYWdlU3RyID0gZm9ybWF0VXNhZ2VTdGF0cyhhZ2dyZWdhdGVVc2FnZShkZXRhaWxzLnJlc3VsdHMpKTtcblx0XHRcdFx0XHRpZiAodXNhZ2VTdHIpIHRleHQgKz0gYFxcblxcbiR7dGhlbWUuZmcoXCJkaW1cIiwgYFRvdGFsOiAke3VzYWdlU3RyfWApfWA7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKCFleHBhbmRlZCkgdGV4dCArPSBgXFxuJHt0aGVtZS5mZyhcIm11dGVkXCIsIFwiKEN0cmwrTyB0byBleHBhbmQpXCIpfWA7XG5cdFx0XHRcdHJldHVybiBuZXcgVGV4dCh0ZXh0LCAwLCAwKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgdGV4dCA9IHJlc3VsdC5jb250ZW50WzBdO1xuXHRcdFx0cmV0dXJuIG5ldyBUZXh0KHRleHQ/LnR5cGUgPT09IFwidGV4dFwiID8gdGV4dC50ZXh0IDogXCIobm8gb3V0cHV0KVwiLCAwLCAwKTtcblx0XHR9LFxuXHR9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWNBLFNBQVMsYUFBZ0M7QUFDekMsWUFBWSxZQUFZO0FBQ3hCLFlBQVksUUFBUTtBQUNwQixZQUFZLFFBQVE7QUFDcEIsWUFBWSxVQUFVO0FBR3RCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQTRCLHdCQUF3QjtBQUNwRCxTQUFTLFdBQVcsVUFBVSxRQUFRLFlBQVk7QUFDbEQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsdUJBQXVCO0FBQ2hDLFNBQTRDLHNCQUFzQjtBQUNsRTtBQUFBLEVBSUM7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ007QUFDUCxTQUFTLGdCQUFnQixvQkFBb0I7QUFDN0MsU0FBUyxtQ0FBbUM7QUFDNUMsU0FBUyx3QkFBd0I7QUFDakMsU0FBUyxZQUFZLG1CQUFtQjtBQUN4QztBQUFBLEVBQ0M7QUFBQSxFQUVBO0FBQUEsRUFDQTtBQUFBLE9BR007QUFDUDtBQUFBLEVBQ0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUlNO0FBRVAsU0FBUyw0QkFBQUEs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LFNBQVMsRUFBRSxhQUFhLEtBQUssaUJBQWlCLGFBQWEsQ0FBQztBQUFBLGNBQzlFLENBQUFBLFNBQVE7QUFBQSxFQUFLLG1CQUFtQixjQUFjLENBQUMsQ0FBQztBQUFBLFFBQ3REO0FBQ0EsWUFBSSxDQUFDLFdBQVc7QUFDZixnQkFBTSxXQUFXLGlCQUFpQixlQUFlLFFBQVEsT0FBTyxDQUFDO0FBQ2pFLGNBQUksU0FBVSxDQUFBQSxTQUFRO0FBQUE7QUFBQSxFQUFPLE1BQU0sR0FBRyxPQUFPLFVBQVUsUUFBUSxFQUFFLENBQUM7QUFBQSxRQUNuRTtBQUNBLFlBQUksQ0FBQyxTQUFVLENBQUFBLFNBQVE7QUFBQSxFQUFLLE1BQU0sR0FBRyxTQUFTLG9CQUFvQixDQUFDO0FBQ25FLGVBQU8sSUFBSSxLQUFLQSxPQUFNLEdBQUcsQ0FBQztBQUFBLE1BQzNCO0FBRUEsWUFBTSxPQUFPLE9BQU8sUUFBUSxDQUFDO0FBQzdCLGFBQU8sSUFBSSxLQUFLLE1BQU0sU0FBUyxTQUFTLEtBQUssT0FBTyxlQUFlLEdBQUcsQ0FBQztBQUFBLElBQ3hFO0FBQUEsRUFDRCxDQUFDO0FBQ0Y7IiwKICAibmFtZXMiOiBbImJ1aWxkU3ViYWdlbnRQcm9jZXNzQXJncyIsICJyZXN1bHQiLCAidGV4dCIsICJwcmV2aWV3IiwgInVzYWdlU3RyIl0KfQo=
