import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { isRemoteConfigured, tryRemoteQuestions } from "./remote-questions.js";
import { readProgress } from "./readers/state.js";
import { readRoadmap } from "./readers/roadmap.js";
import { readHistory } from "./readers/metrics.js";
import { readCaptures } from "./readers/captures.js";
import { readKnowledge } from "./readers/knowledge.js";
import { buildGraph, writeGraph, writeSnapshot, graphStatus, graphQuery, graphDiff } from "./readers/graph.js";
import { resolveGsdRoot, resolveMilestoneFile } from "./readers/paths.js";
import { runDoctorLite } from "./readers/doctor-lite.js";
import { registerWorkflowTools, validateProjectDir } from "./workflow-tools.js";
import { applySecrets, checkExistingEnvKeys, detectDestination, resolveProjectEnvFilePath } from "./env-writer.js";
const MCP_PKG = "@modelcontextprotocol/sdk";
const SERVER_NAME = "gsd";
const SERVER_VERSION = (() => {
  try {
    const require2 = createRequire(import.meta.url);
    const pkg = require2("../package.json");
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
  }
  return "0.0.0";
})();
const ELICIT_TIMEOUT_MS = 10 * 60 * 1e3;
function defaultExecFn(cmd, args, opts) {
  return new Promise((res) => {
    const child = spawn(resolveShellCommand(cmd), args, {
      shell: process.platform === "win32",
      stdio: [opts?.stdin === void 0 ? "ignore" : "pipe", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    child.stdin?.on("error", () => {
    });
    if (opts?.stdin !== void 0) {
      child.stdin?.end(opts.stdin, "utf8");
    }
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => res({ code: 1, stderr: err.message }));
    child.on("close", (code) => res({ code: code ?? 1, stderr }));
  });
}
function resolveShellCommand(cmd) {
  if (process.platform !== "win32") return cmd;
  if (cmd === "vercel") return "vercel.cmd";
  if (cmd === "npx") return "npx.cmd";
  return cmd;
}
async function withElicitTimeout(promise, label, timeoutMs = ELICIT_TIMEOUT_MS, signal) {
  let timer;
  const racers = [promise];
  racers.push(
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs / 6e4} minutes \u2014 no user response received`)),
        timeoutMs
      );
    })
  );
  let abortListener;
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new Error(`${label} cancelled by client`);
    }
    racers.push(
      new Promise((_, reject) => {
        abortListener = () => reject(new Error(`${label} cancelled by client`));
        signal.addEventListener("abort", abortListener, { once: true });
      })
    );
  }
  try {
    return await Promise.race(racers);
  } finally {
    clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}
function jsonContent(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function errorContent(message) {
  return { isError: true, content: [{ type: "text", text: message }] };
}
function textContent(text) {
  return { content: [{ type: "text", text }] };
}
const QUERY_FIELDS = {
  all: ["state", "project", "requirements", "milestones"],
  state: ["state"],
  status: ["state"],
  project: ["project"],
  requirements: ["requirements"],
  milestones: ["milestones"]
};
function normalizeQuery(query) {
  const key = (query ?? "all").trim().toLowerCase();
  if (key in QUERY_FIELDS) return key;
  return "all";
}
async function readProjectState(projectDir, query) {
  const gsdDir = join(resolve(projectDir), ".gsd");
  const category = normalizeQuery(query);
  const wanted = new Set(QUERY_FIELDS[category]);
  const result = {
    projectDir: resolve(projectDir),
    query: category
  };
  if (wanted.has("state")) {
    try {
      result.state = await readFile(join(gsdDir, "STATE.md"), "utf-8");
    } catch {
      result.state = null;
    }
  }
  if (wanted.has("project")) {
    try {
      result.project = await readFile(join(gsdDir, "PROJECT.md"), "utf-8");
    } catch {
      result.project = null;
    }
  }
  if (wanted.has("requirements")) {
    try {
      result.requirements = await readFile(join(gsdDir, "REQUIREMENTS.md"), "utf-8");
    } catch {
      result.requirements = null;
    }
  }
  if (wanted.has("milestones")) {
    const milestonesDir = join(gsdDir, "milestones");
    try {
      const entries = await readdir(milestonesDir, { withFileTypes: true });
      const milestones = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const hasRoadmap = !!resolveMilestoneFile(gsdDir, entry.name, "ROADMAP");
        const hasSummary = !!resolveMilestoneFile(gsdDir, entry.name, "SUMMARY");
        milestones.push({ id: entry.name, hasRoadmap, hasSummary });
      }
      result.milestones = milestones;
    } catch {
      result.milestones = [];
    }
  }
  return result;
}
const OTHER_OPTION_LABEL = "None of the above";
function normalizeAskUserQuestionsNote(value) {
  return typeof value === "string" ? value.trim() : "";
}
function normalizeAskUserQuestionsAnswers(value, allowMultiple) {
  if (allowMultiple) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  }
  return typeof value === "string" && value.length > 0 ? [value] : [];
}
function validateAskUserQuestionsPayload(questions) {
  if (questions.length === 0 || questions.length > 3) {
    return "Error: questions must contain 1-3 items";
  }
  for (const question of questions) {
    if (!question.options || question.options.length === 0) {
      return `Error: ask_user_questions requires non-empty options for every question (question "${question.id}" has none)`;
    }
  }
  return null;
}
function buildAskUserQuestionsElicitRequest(questions) {
  const properties = {};
  const required = questions.map((question) => question.id);
  for (const question of questions) {
    if (question.allowMultiple) {
      properties[question.id] = {
        type: "array",
        title: question.header,
        description: question.question,
        minItems: 1,
        maxItems: question.options.length,
        items: {
          anyOf: question.options.map((option) => ({
            const: option.label,
            title: option.label
          }))
        }
      };
      continue;
    }
    properties[question.id] = {
      type: "string",
      title: question.header,
      description: question.question,
      oneOf: [...question.options, { label: OTHER_OPTION_LABEL, description: "Choose this when the listed options do not fit." }].map((option) => ({
        const: option.label,
        title: option.label
      }))
    };
    properties[`${question.id}__note`] = {
      type: "string",
      title: `${question.header} Note`,
      description: `Optional note for "${OTHER_OPTION_LABEL}".`,
      maxLength: 500
    };
  }
  return {
    mode: "form",
    message: 'Please answer the following question(s). For single-select questions, choose "None of the above" and add a note if the provided options do not fit.',
    requestedSchema: {
      type: "object",
      properties,
      required
    }
  };
}
function formatAskUserQuestionsElicitResult(questions, result) {
  const answers = {};
  const content = result.content ?? {};
  for (const question of questions) {
    const answerList = normalizeAskUserQuestionsAnswers(content[question.id], !!question.allowMultiple);
    if (!question.allowMultiple && answerList[0] === OTHER_OPTION_LABEL) {
      const note = normalizeAskUserQuestionsNote(content[`${question.id}__note`]);
      if (note) {
        answerList.push(`user_note: ${note}`);
      }
    }
    answers[question.id] = { answers: answerList };
  }
  return JSON.stringify({ answers });
}
function buildAskUserQuestionsRoundResult(questions, result) {
  const answers = {};
  const content = result.content ?? {};
  for (const question of questions) {
    if (question.allowMultiple) {
      const list2 = normalizeAskUserQuestionsAnswers(content[question.id], true);
      answers[question.id] = { selected: list2, notes: "" };
      continue;
    }
    const list = normalizeAskUserQuestionsAnswers(content[question.id], false);
    const selected = list[0] ?? "";
    const notes = selected === OTHER_OPTION_LABEL ? normalizeAskUserQuestionsNote(content[`${question.id}__note`]) : "";
    answers[question.id] = { selected, notes };
  }
  return { endInterview: false, answers };
}
let askUserQuestionsWriteGateModulePromise = null;
function isAskUserQuestionsWriteGateModule(value) {
  if (!value || typeof value !== "object") return false;
  const module = value;
  return typeof module["isGateQuestionId"] === "function" && typeof module["isDepthConfirmationAnswer"] === "function" && typeof module["setPendingGate"] === "function" && typeof module["markApprovalGateVerified"] === "function" && typeof module["markDepthVerified"] === "function" && typeof module["clearPendingGate"] === "function" && typeof module["extractDepthVerificationMilestoneId"] === "function";
}
async function loadAskUserQuestionsWriteGateModule() {
  if (!askUserQuestionsWriteGateModulePromise) {
    askUserQuestionsWriteGateModulePromise = (async () => {
      const modulePath = process.env.GSD_WORKFLOW_WRITE_GATE_MODULE?.trim();
      if (!modulePath) return null;
      try {
        if (/^[a-z]{2,}:/i.test(modulePath) && !modulePath.startsWith("file:")) {
          throw new Error("GSD_WORKFLOW_WRITE_GATE_MODULE only supports file: URLs or filesystem paths.");
        }
        const baseRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT?.trim() || process.cwd();
        const specifier = modulePath.startsWith("file:") ? modulePath : pathToFileURL(resolve(baseRoot, modulePath)).href;
        const loaded = await import(specifier);
        return isAskUserQuestionsWriteGateModule(loaded) ? loaded : null;
      } catch (err) {
        console.warn(`[gsd:mcp] ask_user_questions write-gate integration unavailable: ${formatErrorMessage(err)}`);
        return null;
      }
    })();
  }
  return askUserQuestionsWriteGateModulePromise;
}
function askUserQuestionsWriteGateBasePath(deps) {
  return deps.writeGateBasePath ?? process.env.GSD_WORKFLOW_PROJECT_ROOT?.trim() ?? process.cwd();
}
async function resolveAskUserQuestionsWriteGate(deps) {
  if (deps.writeGate !== void 0) return deps.writeGate;
  return loadAskUserQuestionsWriteGateModule();
}
async function recordAskUserQuestionsPendingGate(questions, deps) {
  const writeGate = await resolveAskUserQuestionsWriteGate(deps);
  if (!writeGate) return;
  const basePath = askUserQuestionsWriteGateBasePath(deps);
  for (const question of questions) {
    if (writeGate.isGateQuestionId(question.id)) {
      writeGate.setPendingGate(question.id, basePath);
    }
  }
}
async function recordAskUserQuestionsGateResult(structured, deps) {
  if (structured.cancelled || !structured.response) return;
  const writeGate = await resolveAskUserQuestionsWriteGate(deps);
  if (!writeGate) return;
  const basePath = askUserQuestionsWriteGateBasePath(deps);
  for (const question of structured.questions) {
    if (!writeGate.isGateQuestionId(question.id)) continue;
    const selected = structured.response.answers[question.id]?.selected;
    if (!writeGate.isDepthConfirmationAnswer(selected, question.options)) continue;
    writeGate.markApprovalGateVerified(question.id, basePath);
    writeGate.markDepthVerified(writeGate.extractDepthVerificationMilestoneId(question.id), basePath);
    writeGate.clearPendingGate(basePath);
  }
}
function isLocalElicitFallbackError(err) {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes("timed out after") || message.includes("elicit") || message.includes("elicitation") || message.includes("host") || message.includes("not supported") || message.includes("method not found") || message.includes("-32601");
}
function formatErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
function isRoundResultLike(value) {
  if (!value || typeof value !== "object") return false;
  const answers = value["answers"];
  return !!answers && typeof answers === "object" && !Array.isArray(answers);
}
async function askUserQuestionsHandler(questions, extra, deps) {
  try {
    const validationError = validateAskUserQuestionsPayload(questions);
    if (validationError) return errorContent(validationError);
    await recordAskUserQuestionsPendingGate(questions, deps);
    let localElicitError;
    try {
      const elicitation = await withElicitTimeout(
        deps.elicitInput(buildAskUserQuestionsElicitRequest(questions)),
        "ask_user_questions"
      );
      if (elicitation.action === "accept" && elicitation.content) {
        const structured = {
          questions,
          response: buildAskUserQuestionsRoundResult(questions, elicitation),
          cancelled: false
        };
        await recordAskUserQuestionsGateResult(structured, deps);
        return {
          content: [{ type: "text", text: formatAskUserQuestionsElicitResult(questions, elicitation) }],
          structuredContent: structured
        };
      }
    } catch (err) {
      if (!isLocalElicitFallbackError(err)) throw err;
      localElicitError = err;
      console.warn(`[gsd:mcp] ask_user_questions local elicitation unavailable; trying remote fallback: ${formatErrorMessage(err)}`);
    }
    if (deps.isRemoteConfigured()) {
      let remoteResult;
      try {
        remoteResult = await deps.tryRemoteQuestions(questions, extra?.signal);
      } catch (err) {
        if (localElicitError) {
          throw new Error(
            `Local elicitation failed (${formatErrorMessage(localElicitError)}); remote fallback failed (${formatErrorMessage(err)})`
          );
        }
        throw err;
      }
      if (remoteResult) {
        const details = remoteResult.details;
        if (details?.["timed_out"] || details?.["error"]) {
          const failedStructured = {
            questions,
            response: null,
            cancelled: true
          };
          return {
            content: [{ type: "text", text: remoteResult.content[0]?.text ?? "Remote questions timed out or failed" }],
            structuredContent: failedStructured
          };
        }
        const hasValidResponse = isRoundResultLike(details?.["response"]);
        const acceptedStructured = hasValidResponse ? {
          questions,
          response: details["response"],
          cancelled: false
        } : {
          questions,
          response: null,
          cancelled: true
        };
        await recordAskUserQuestionsGateResult(acceptedStructured, deps);
        return {
          content: [{ type: "text", text: remoteResult.content[0]?.text ?? "" }],
          structuredContent: acceptedStructured
        };
      }
    }
    if (localElicitError) throw localElicitError;
    const cancelledStructured = {
      questions,
      response: null,
      cancelled: true
    };
    return {
      content: [{ type: "text", text: "ask_user_questions was cancelled before receiving a response" }],
      structuredContent: cancelledStructured
    };
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}
async function secureEnvCollectHandler(args, elicitInput) {
  const { projectDir, keys, destination, envFilePath, environment } = args;
  try {
    const resolvedProjectDir = validateProjectDir(projectDir);
    const resolvedEnvPath = resolveProjectEnvFilePath(resolvedProjectDir, envFilePath ?? ".env");
    const allKeyNames = keys.map((k) => k.key);
    const existingKeys = await checkExistingEnvKeys(allKeyNames, resolvedEnvPath);
    const existingSet = new Set(existingKeys);
    const pendingKeys = keys.filter((k) => !existingSet.has(k.key));
    if (pendingKeys.length === 0) {
      const lines2 = existingKeys.map((k) => `\u2022 ${k}: already set`);
      return textContent(`All ${existingKeys.length} key(s) already set.
${lines2.join("\n")}`);
    }
    const properties = {};
    const required = [];
    for (const item of pendingKeys) {
      const descParts = [];
      if (item.hint) descParts.push(`Format: ${item.hint}`);
      if (item.guidance && item.guidance.length > 0) {
        descParts.push("How to get this:");
        item.guidance.forEach((step, i) => descParts.push(`${i + 1}. ${step}`));
      }
      descParts.push("Leave empty to skip.");
      properties[item.key] = {
        type: "string",
        title: item.key,
        description: descParts.join("\n")
      };
    }
    const elicitation = await withElicitTimeout(
      elicitInput({
        message: `Enter values for ${pendingKeys.length} environment variable(s). Values are written directly to the project and never shown to the AI.`,
        requestedSchema: {
          type: "object",
          properties,
          required
        }
      }),
      "secure_env_collect"
    );
    if (elicitation.action !== "accept" || !elicitation.content) {
      return textContent("secure_env_collect was cancelled by user.");
    }
    const provided = [];
    const skipped = [];
    for (const item of pendingKeys) {
      const raw = elicitation.content[item.key];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (value.length > 0) {
        provided.push({ key: item.key, value });
      } else {
        skipped.push(item.key);
      }
    }
    const resolvedDestination = destination ?? detectDestination(resolvedProjectDir);
    const { applied, errors } = await applySecrets(provided, resolvedDestination, {
      envFilePath: resolvedEnvPath,
      environment,
      execFn: defaultExecFn
    });
    const lines = [
      `destination: ${resolvedDestination}${!destination ? " (auto-detected)" : ""}${environment ? ` (${environment})` : ""}`
    ];
    for (const k of applied) lines.push(`\u2713 ${k}: applied`);
    for (const k of skipped) lines.push(`\u2022 ${k}: skipped`);
    for (const k of existingKeys) lines.push(`\u2022 ${k}: already set`);
    for (const e of errors) lines.push(`\u2717 ${e}`);
    return errors.length > 0 && applied.length === 0 ? errorContent(lines.join("\n")) : textContent(lines.join("\n"));
  } catch (err) {
    return errorContent(err instanceof Error ? err.message : String(err));
  }
}
async function createMcpServer(sessionManager) {
  const mcpMod = await import(`${MCP_PKG}/server/mcp.js`);
  const McpServer = mcpMod.McpServer;
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, elicitation: {} } }
  );
  server.tool(
    "gsd_execute",
    "Start a GSD auto-mode session for a project directory. Returns a sessionId for tracking.",
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      command: z.string().optional().describe('Command to send (default: "/gsd auto")'),
      model: z.string().optional().describe("Model ID override"),
      bare: z.boolean().optional().describe("Run in bare mode (skip user config)")
    },
    async (args, extra) => {
      const { projectDir, command, model, bare } = args;
      try {
        const sessionId = await sessionManager.startSession(projectDir, { command, model, bare });
        if (extra?.signal?.aborted) {
          await sessionManager.cancelSession(sessionId).catch(() => {
          });
          return errorContent("gsd_execute aborted by client before returning");
        }
        return jsonContent({ sessionId, status: "started" });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_status",
    "Get the current status of a GSD session including progress, recent events, and pending blockers.",
    {
      sessionId: z.string().describe("Session ID returned from gsd_execute")
    },
    async (args) => {
      const { sessionId } = args;
      try {
        const session = sessionManager.getSession(sessionId);
        if (!session) return errorContent(`Session not found: ${sessionId}`);
        const durationMs = Date.now() - session.startTime;
        const toolCallCount = session.events.filter(
          (e) => e.type === "tool_use" || e.type === "tool_execution_start"
        ).length;
        return jsonContent({
          status: session.status,
          progress: {
            eventCount: session.events.length,
            toolCalls: toolCallCount
          },
          recentEvents: session.events.slice(-10),
          pendingBlocker: session.pendingBlocker ? {
            id: session.pendingBlocker.id,
            method: session.pendingBlocker.method,
            message: session.pendingBlocker.message
          } : null,
          cost: session.cost,
          durationMs
        });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_result",
    "Get the result of a GSD session. Returns partial results if the session is still running.",
    {
      sessionId: z.string().describe("Session ID returned from gsd_execute")
    },
    async (args) => {
      const { sessionId } = args;
      try {
        const result = sessionManager.getResult(sessionId);
        return jsonContent(result);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_cancel",
    "Cancel a running GSD session. Aborts the current operation and stops the process. Provide sessionId (from gsd_execute) or projectDir as a fallback for interactive/restarted sessions.",
    {
      sessionId: z.string().optional().describe("Session ID returned from gsd_execute"),
      projectDir: z.string().optional().describe("Absolute path to the project directory (fallback when sessionId is unavailable)")
    },
    async (args) => {
      const { sessionId, projectDir } = args;
      try {
        if (!sessionId && !projectDir) {
          return errorContent("Either sessionId or projectDir must be provided");
        }
        if (sessionId) {
          try {
            await sessionManager.cancelSession(sessionId);
          } catch (err) {
            if (!projectDir || !(err instanceof Error) || !err.message.includes("Session not found")) {
              throw err;
            }
            await sessionManager.cancelSessionByDir(projectDir);
          }
        } else if (projectDir) {
          await sessionManager.cancelSessionByDir(projectDir);
        }
        return jsonContent({ cancelled: true });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_query",
    'Query GSD project state from the filesystem. By default returns STATE.md, PROJECT.md, requirements, and milestone listing. Pass `query` to narrow the response (accepted: "state"/"status", "project", "requirements", "milestones", "all"). Does not require an active session.',
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      query: z.enum(["all", "state", "status", "project", "requirements", "milestones"]).optional().describe('Narrow the response to a single field (default: "all")')
    },
    async (args) => {
      const { projectDir, query } = args;
      try {
        const validated = validateProjectDir(projectDir);
        const state = await readProjectState(validated, query);
        return jsonContent(state);
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_resolve_blocker",
    "Resolve a pending blocker in a GSD session by sending a response to the UI request.",
    {
      sessionId: z.string().describe("Session ID returned from gsd_execute"),
      response: z.string().describe("Response to send for the pending blocker")
    },
    async (args) => {
      const { sessionId, response } = args;
      try {
        await sessionManager.resolveBlocker(sessionId, response);
        return jsonContent({ resolved: true });
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "ask_user_questions",
    'Request user input for one to three short questions and wait for the response. Single-select questions include a free-form "None of the above" path. Multi-select questions allow multiple choices.',
    {
      questions: z.array(z.object({
        id: z.string().describe("Stable identifier for mapping answers (snake_case)"),
        header: z.string().describe("Short header label shown in the UI (12 or fewer chars)"),
        question: z.string().describe("Single-sentence prompt shown to the user"),
        options: z.array(z.object({
          label: z.string().describe("User-facing label (1-5 words)"),
          description: z.string().describe("One short sentence explaining impact/tradeoff if selected")
        })).describe('Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option for single-select questions.'),
        allowMultiple: z.boolean().optional().describe('If true, the user can select multiple options. No "None of the above" option is added.')
      })).describe("Questions to show the user. Prefer 1 and do not exceed 3.")
    },
    async (args, extra) => {
      const { questions } = args;
      return askUserQuestionsHandler(questions, extra, {
        elicitInput: (params) => server.server.elicitInput(params),
        isRemoteConfigured,
        tryRemoteQuestions
      });
    }
  );
  server.tool(
    "secure_env_collect",
    "Collect environment variables securely via form input. Values are written directly to .env (or Vercel/Convex) and NEVER appear in tool output \u2014 only key names and applied/skipped status are returned. Use this instead of asking users to manually edit .env files or paste secrets into chat.",
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      keys: z.array(z.object({
        key: z.string().describe("Env var name, e.g. OPENAI_API_KEY"),
        hint: z.string().optional().describe('Format hint shown to user, e.g. "starts with sk-"'),
        guidance: z.array(z.string()).optional().describe("Step-by-step instructions for obtaining this key")
      })).min(1).describe("Environment variables to collect"),
      destination: z.enum(["dotenv", "vercel", "convex"]).optional().describe("Where to write secrets. Auto-detected from project files if omitted."),
      envFilePath: z.string().optional().describe("Path to .env file (dotenv only). Defaults to .env in projectDir."),
      environment: z.enum(["development", "preview", "production"]).optional().describe("Target environment (vercel/convex only)")
    },
    async (args) => secureEnvCollectHandler(
      args,
      (params) => server.server.elicitInput(params)
    )
  );
  server.tool(
    "gsd_progress",
    "Get structured project progress: active milestone/slice/task, phase, completion counts, blockers, and next action. No session required \u2014 reads directly from .gsd/ on disk.",
    {
      projectDir: z.string().describe("Absolute path to the project directory")
    },
    async (args) => {
      const { projectDir } = args;
      try {
        return jsonContent(readProgress(validateProjectDir(projectDir)));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_roadmap",
    "Get the full project roadmap structure: milestones with their slices, tasks, status, risk, and dependencies. Optionally filter to a single milestone. No session required.",
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      milestoneId: z.string().optional().describe('Filter to a specific milestone (e.g. "M001")')
    },
    async (args) => {
      const { projectDir, milestoneId } = args;
      try {
        return jsonContent(readRoadmap(validateProjectDir(projectDir), milestoneId));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_history",
    "Get execution history with cost, token usage, model, and duration per unit. Returns totals across all units. No session required.",
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      limit: z.number().optional().describe("Max entries to return (most recent first). Default: all.")
    },
    async (args) => {
      const { projectDir, limit } = args;
      try {
        return jsonContent(readHistory(validateProjectDir(projectDir), limit));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_doctor",
    "Run a lightweight structural health check on the .gsd/ directory. Checks for missing files, status inconsistencies, and orphaned state. No session required.",
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      scope: z.string().optional().describe('Limit checks to a specific milestone (e.g. "M001")')
    },
    async (args) => {
      const { projectDir, scope } = args;
      try {
        return jsonContent(runDoctorLite(validateProjectDir(projectDir), scope));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_captures",
    "Get captured ideas and thoughts from CAPTURES.md with triage status. Filter by pending, actionable, or all. No session required.",
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      filter: z.enum(["all", "pending", "actionable"]).optional().describe('Filter captures (default: "all")')
    },
    async (args) => {
      const { projectDir, filter } = args;
      try {
        return jsonContent(readCaptures(validateProjectDir(projectDir), filter ?? "all"));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_knowledge",
    "Get the project knowledge base: rules, patterns, and lessons learned accumulated during development. No session required.",
    {
      projectDir: z.string().describe("Absolute path to the project directory")
    },
    async (args) => {
      const { projectDir } = args;
      try {
        return jsonContent(readKnowledge(validateProjectDir(projectDir)));
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  server.tool(
    "gsd_graph",
    [
      "Manage the GSD project knowledge graph. No session required.",
      "",
      "Modes:",
      "  build   Parse .gsd/ artifacts (STATE.md, milestone ROADMAPs, slice PLANs,",
      "          KNOWLEDGE.md) and write .gsd/graphs/graph.json atomically.",
      "  query   Search graph nodes by term (BFS from seed matches, budget-trimmed).",
      "          Returns matching nodes and reachable edges within the token budget.",
      "  status  Show whether graph.json exists, its age, node/edge counts, and",
      "          whether it is stale (built more than 24 hours ago).",
      "  diff    Compare current graph.json with .last-build-snapshot.json.",
      "          Returns added, removed, and changed nodes and edges."
    ].join("\n"),
    {
      projectDir: z.string().describe("Absolute path to the project directory"),
      mode: z.enum(["build", "query", "status", "diff"]).describe(
        "Operation: build | query | status | diff"
      ),
      term: z.string().optional().describe("Search term for query mode (case-insensitive)"),
      budget: z.number().optional().describe("Token budget for query mode (default: 4000)"),
      snapshot: z.boolean().optional().describe("Write snapshot before build (for future diff)")
    },
    async (args) => {
      const { projectDir: rawProjectDir, mode, term, budget, snapshot } = args;
      try {
        const projectDir = validateProjectDir(rawProjectDir);
        const gsdRoot = resolveGsdRoot(projectDir);
        switch (mode) {
          case "build": {
            if (snapshot) {
              await writeSnapshot(gsdRoot).catch(() => {
              });
            }
            const graph = await buildGraph(projectDir);
            await writeGraph(gsdRoot, graph);
            return jsonContent({
              built: true,
              nodeCount: graph.nodes.length,
              edgeCount: graph.edges.length,
              builtAt: graph.builtAt
            });
          }
          case "query": {
            const result = await graphQuery(projectDir, term ?? "", budget);
            return jsonContent(result);
          }
          case "status": {
            const result = await graphStatus(projectDir);
            return jsonContent(result);
          }
          case "diff": {
            const result = await graphDiff(projectDir);
            return jsonContent(result);
          }
        }
      } catch (err) {
        return errorContent(err instanceof Error ? err.message : String(err));
      }
    }
  );
  registerWorkflowTools(server);
  return { server };
}
export {
  askUserQuestionsHandler,
  buildAskUserQuestionsElicitRequest,
  buildAskUserQuestionsRoundResult,
  createMcpServer,
  formatAskUserQuestionsElicitResult,
  secureEnvCollectHandler,
  withElicitTimeout
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvc2VydmVyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIE1DUCBTZXJ2ZXIgXHUyMDE0IHJlZ2lzdGVycyBHU0Qgb3JjaGVzdHJhdGlvbiwgcHJvamVjdC1zdGF0ZSwgYW5kIHdvcmtmbG93IHRvb2xzLlxuICpcbiAqIFNlc3Npb24gdG9vbHMgKDYpOiBnc2RfZXhlY3V0ZSwgZ3NkX3N0YXR1cywgZ3NkX3Jlc3VsdCwgZ3NkX2NhbmNlbCwgZ3NkX3F1ZXJ5LCBnc2RfcmVzb2x2ZV9ibG9ja2VyXG4gKiBJbnRlcmFjdGl2ZSB0b29scyAoMik6IGFza191c2VyX3F1ZXN0aW9ucywgc2VjdXJlX2Vudl9jb2xsZWN0IHZpYSBNQ1AgZm9ybSBlbGljaXRhdGlvblxuICogUmVhZC1vbmx5IHRvb2xzICg2KTogZ3NkX3Byb2dyZXNzLCBnc2Rfcm9hZG1hcCwgZ3NkX2hpc3RvcnksIGdzZF9kb2N0b3IsIGdzZF9jYXB0dXJlcywgZ3NkX2tub3dsZWRnZVxuICogV29ya2Zsb3cgdG9vbHMgKDI5KTogaGVhZGxlc3Mtc2FmZSBwbGFubmluZywgbWV0YWRhdGEgcGVyc2lzdGVuY2UsIHJlcGxhbm5pbmcsIGNvbXBsZXRpb24sIHZhbGlkYXRpb24sIHJlYXNzZXNzbWVudCwgZ2F0ZSByZXN1bHQsIHN0YXR1cywgYW5kIGpvdXJuYWwgdG9vbHNcbiAqXG4gKiBVc2VzIGR5bmFtaWMgaW1wb3J0cyBmb3IgQG1vZGVsY29udGV4dHByb3RvY29sL3NkayBiZWNhdXNlIFRTIE5vZGUxNlxuICogY2Fubm90IHJlc29sdmUgdGhlIFNESydzIHN1YnBhdGggZXhwb3J0cyBzdGF0aWNhbGx5IChzYW1lIHBhdHRlcm4gYXNcbiAqIHNyYy9tY3Atc2VydmVyLnRzIGluIHRoZSBtYWluIHBhY2thZ2UpLlxuICovXG5cbmltcG9ydCB7IHJlYWRGaWxlLCByZWFkZGlyIH0gZnJvbSAnbm9kZTpmcy9wcm9taXNlcyc7XG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IHNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tICdub2RlOm1vZHVsZSc7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSAnbm9kZTp1cmwnO1xuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCc7XG5pbXBvcnQgdHlwZSB7IFNlc3Npb25NYW5hZ2VyIH0gZnJvbSAnLi9zZXNzaW9uLW1hbmFnZXIuanMnO1xuaW1wb3J0IHsgaXNSZW1vdGVDb25maWd1cmVkLCB0cnlSZW1vdGVRdWVzdGlvbnMgfSBmcm9tICcuL3JlbW90ZS1xdWVzdGlvbnMuanMnO1xuaW1wb3J0IHR5cGUgeyBSZW1vdGVUb29sUmVzdWx0IH0gZnJvbSAnLi9yZW1vdGUtcXVlc3Rpb25zLmpzJztcbmltcG9ydCB7IHJlYWRQcm9ncmVzcyB9IGZyb20gJy4vcmVhZGVycy9zdGF0ZS5qcyc7XG5pbXBvcnQgeyByZWFkUm9hZG1hcCB9IGZyb20gJy4vcmVhZGVycy9yb2FkbWFwLmpzJztcbmltcG9ydCB7IHJlYWRIaXN0b3J5IH0gZnJvbSAnLi9yZWFkZXJzL21ldHJpY3MuanMnO1xuaW1wb3J0IHsgcmVhZENhcHR1cmVzIH0gZnJvbSAnLi9yZWFkZXJzL2NhcHR1cmVzLmpzJztcbmltcG9ydCB7IHJlYWRLbm93bGVkZ2UgfSBmcm9tICcuL3JlYWRlcnMva25vd2xlZGdlLmpzJztcbmltcG9ydCB7IGJ1aWxkR3JhcGgsIHdyaXRlR3JhcGgsIHdyaXRlU25hcHNob3QsIGdyYXBoU3RhdHVzLCBncmFwaFF1ZXJ5LCBncmFwaERpZmYgfSBmcm9tICcuL3JlYWRlcnMvZ3JhcGguanMnO1xuaW1wb3J0IHsgcmVzb2x2ZUdzZFJvb3QsIHJlc29sdmVNaWxlc3RvbmVGaWxlIH0gZnJvbSAnLi9yZWFkZXJzL3BhdGhzLmpzJztcbmltcG9ydCB7IHJ1bkRvY3RvckxpdGUgfSBmcm9tICcuL3JlYWRlcnMvZG9jdG9yLWxpdGUuanMnO1xuaW1wb3J0IHsgcmVnaXN0ZXJXb3JrZmxvd1Rvb2xzLCB2YWxpZGF0ZVByb2plY3REaXIgfSBmcm9tICcuL3dvcmtmbG93LXRvb2xzLmpzJztcbmltcG9ydCB7IGFwcGx5U2VjcmV0cywgY2hlY2tFeGlzdGluZ0VudktleXMsIGRldGVjdERlc3RpbmF0aW9uLCByZXNvbHZlUHJvamVjdEVudkZpbGVQYXRoIH0gZnJvbSAnLi9lbnYtd3JpdGVyLmpzJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBDb25zdGFudHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5jb25zdCBNQ1BfUEtHID0gJ0Btb2RlbGNvbnRleHRwcm90b2NvbC9zZGsnO1xuY29uc3QgU0VSVkVSX05BTUUgPSAnZ3NkJztcblxuLyoqXG4gKiBSZWFkIHRoZSB2ZXJzaW9uIGZyb20gdGhpcyBwYWNrYWdlJ3MgcGFja2FnZS5qc29uIHNvIHRoZSBNQ1AgaGFuZHNoYWtlXG4gKiBhbHdheXMgYWR2ZXJ0aXNlcyB0aGUgZGVwbG95ZWQgYXJ0aWZhY3QncyB2ZXJzaW9uLiBGYWxscyBiYWNrIHRvICcwLjAuMCdcbiAqIGlmIHBhY2thZ2UuanNvbiBjYW4ndCBiZSBsb2NhdGVkIChlLmcuIHVudXN1YWwgYnVuZGxpbmcpOyB0aGUgZmFsbGJhY2tcbiAqIGlzIGxvdWQtaXNoIGJ1dCB3b24ndCBjcmFzaCB0aGUgc2VydmVyLlxuICovXG5jb25zdCBTRVJWRVJfVkVSU0lPTjogc3RyaW5nID0gKCgpID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXF1aXJlID0gY3JlYXRlUmVxdWlyZShpbXBvcnQubWV0YS51cmwpO1xuICAgIGNvbnN0IHBrZyA9IHJlcXVpcmUoJy4uL3BhY2thZ2UuanNvbicpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcbiAgICBpZiAodHlwZW9mIHBrZy52ZXJzaW9uID09PSAnc3RyaW5nJyAmJiBwa2cudmVyc2lvbi5sZW5ndGggPiAwKSByZXR1cm4gcGtnLnZlcnNpb247XG4gIH0gY2F0Y2ggeyAvKiBmYWxsIHRocm91Z2ggKi8gfVxuICByZXR1cm4gJzAuMC4wJztcbn0pKCk7XG5cbi8qKiBVc2VyLWludGVyYWN0aW9uIHRpbWVvdXQgXHUyMDE0IGdlbmVyb3VzIGJ1dCBib3VuZGVkIHNvIGVsaWNpdGF0aW9uIGNhbid0IGhhbmcgaW5kZWZpbml0ZWx5ICgjNDU4NikuICovXG5jb25zdCBFTElDSVRfVElNRU9VVF9NUyA9IDEwICogNjAgKiAxMDAwOyAvLyAxMCBtaW51dGVzXG5cbi8qKlxuICogRGVmYXVsdCBjaGlsZC1wcm9jZXNzIHJ1bm5lciB1c2VkIGJ5IHNlY3VyZV9lbnZfY29sbGVjdCB0byBwdXNoIHNlY3JldHNcbiAqIGludG8gYHZlcmNlbCBlbnYgYWRkYCAvIGBucHggY29udmV4IGVudiBzZXRgLiBQcmV2aW91c2x5IGBhcHBseVNlY3JldHNgXG4gKiB3YXMgY2FsbGVkIHdpdGhvdXQgYW4gYGV4ZWNGbmAsIHNvIHZlcmNlbC9jb252ZXggZGVzdGluYXRpb25zIHNpbGVudGx5XG4gKiBkcm9wcGVkIGV2ZXJ5IGNvbGxlY3RlZCBrZXkuIFRoaXMgcmVzdG9yZXMgdGhlIHdyaXRlIHBhdGguXG4gKi9cbmZ1bmN0aW9uIGRlZmF1bHRFeGVjRm4oXG4gIGNtZDogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgb3B0cz86IHsgc3RkaW4/OiBzdHJpbmcgfSxcbik6IFByb21pc2U8eyBjb2RlOiBudW1iZXI7IHN0ZGVycjogc3RyaW5nIH0+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXMpID0+IHtcbiAgICAvLyBzdGRpbjogcGlwZSBvbmx5IHdoZW4gYSBjYWxsZXIgZXhwbGljaXRseSBzdXBwbGllcyBpbnB1dDsgb3RoZXJ3aXNlXG4gICAgLy8gaWdub3JlIGl0IHRvIGF2b2lkIGhhbmdpbmcgaWYgdGhlIGNoaWxkIGV2ZXIgcHJvbXB0cyBpbnRlcmFjdGl2ZWx5LlxuICAgIC8vIHN0ZG91dDogaWdub3JlIFx1MjAxNCBjb25zdW1lciBvbmx5IGNhcmVzIGFib3V0IHN0ZGVyciArIGV4aXQgY29kZSwgYW5kIGFuXG4gICAgLy8gICB1bi1kcmFpbmVkIHBpcGUgZGVhZGxvY2tzIG9uY2UgdGhlIGtlcm5lbCBidWZmZXIgKH42NEtCKSBmaWxscy5cbiAgICAvLyBzdGRlcnI6IHBpcGUgXHUyMDE0IGNhcHR1cmVkIGJlbG93IGZvciBlcnJvciBzdXJmYWNpbmcuXG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bihyZXNvbHZlU2hlbGxDb21tYW5kKGNtZCksIGFyZ3MsIHtcbiAgICAgIHNoZWxsOiBwcm9jZXNzLnBsYXRmb3JtID09PSAnd2luMzInLFxuICAgICAgc3RkaW86IFtvcHRzPy5zdGRpbiA9PT0gdW5kZWZpbmVkID8gJ2lnbm9yZScgOiAncGlwZScsICdpZ25vcmUnLCAncGlwZSddLFxuICAgICAgd2luZG93c0hpZGU6IHRydWUsXG4gICAgfSk7XG4gICAgbGV0IHN0ZGVyciA9ICcnO1xuICAgIGNoaWxkLnN0ZGluPy5vbignZXJyb3InLCAoKSA9PiB7XG4gICAgICAvLyBDaGlsZCBleGl0ZWQgYmVmb3JlIGNvbnN1bWluZyBzdGRpbjsgY2xvc2UvZXJyb3IgaGFuZGxpbmcgYmVsb3cgd2lsbFxuICAgICAgLy8gc3VyZmFjZSB0aGUgcmVhbCBwcm9jZXNzIHJlc3VsdC5cbiAgICB9KTtcbiAgICBpZiAob3B0cz8uc3RkaW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY2hpbGQuc3RkaW4/LmVuZChvcHRzLnN0ZGluLCAndXRmOCcpO1xuICAgIH1cbiAgICBjaGlsZC5zdGRlcnI/Lm9uKCdkYXRhJywgKGNodW5rKSA9PiB7XG4gICAgICBzdGRlcnIgKz0gY2h1bmsudG9TdHJpbmcoJ3V0ZjgnKTtcbiAgICB9KTtcbiAgICBjaGlsZC5vbignZXJyb3InLCAoZXJyKSA9PiByZXMoeyBjb2RlOiAxLCBzdGRlcnI6IGVyci5tZXNzYWdlIH0pKTtcbiAgICBjaGlsZC5vbignY2xvc2UnLCAoY29kZSkgPT4gcmVzKHsgY29kZTogY29kZSA/PyAxLCBzdGRlcnIgfSkpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZVNoZWxsQ29tbWFuZChjbWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSAnd2luMzInKSByZXR1cm4gY21kO1xuICBpZiAoY21kID09PSAndmVyY2VsJykgcmV0dXJuICd2ZXJjZWwuY21kJztcbiAgaWYgKGNtZCA9PT0gJ25weCcpIHJldHVybiAnbnB4LmNtZCc7XG4gIHJldHVybiBjbWQ7XG59XG5cbi8qKlxuICogUmFjZSBhIHByb21pc2UgYWdhaW5zdCBhIHRpbWVvdXQuIFJlamVjdHMgd2l0aCBhIHR5cGVkIGVycm9yIG9uIHRpbWVvdXQgc29cbiAqIGNhbGxlcnMgY2FuIHJldHVybiBhIHNwZWNpZmljIE1DUCBlcnJvciByZXNwb25zZSByYXRoZXIgdGhhbiBoYW5naW5nLlxuICogSWYgYSBwYXJlbnQgQWJvcnRTaWduYWwgaXMgcHJvdmlkZWQsIGFuIGFib3J0IGFsc28gcmVqZWN0cyB0aGUgcmFjZSBzb1xuICogY2xpZW50LXNpZGUgY2FuY2VsbGF0aW9uIHByb3BhZ2F0ZXMgaW5zdGVhZCBvZiBiZWluZyBhYnNvcmJlZCBieSB0aGVcbiAqIDEwLW1pbnV0ZSBlbGljaXRhdGlvbiBob2xkLlxuICpcbiAqIEBwYXJhbSB0aW1lb3V0TXMgLSBvdmVycmlkZSBmb3IgdGVzdGluZzsgZGVmYXVsdHMgdG8gRUxJQ0lUX1RJTUVPVVRfTVNcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdpdGhFbGljaXRUaW1lb3V0PFQ+KFxuICBwcm9taXNlOiBQcm9taXNlPFQ+LFxuICBsYWJlbDogc3RyaW5nLFxuICB0aW1lb3V0TXMgPSBFTElDSVRfVElNRU9VVF9NUyxcbiAgc2lnbmFsPzogQWJvcnRTaWduYWwsXG4pOiBQcm9taXNlPFQ+IHtcbiAgbGV0IHRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgY29uc3QgcmFjZXJzOiBQcm9taXNlPFQ+W10gPSBbcHJvbWlzZV07XG4gIHJhY2Vycy5wdXNoKFxuICAgIG5ldyBQcm9taXNlPG5ldmVyPigoXywgcmVqZWN0KSA9PiB7XG4gICAgICB0aW1lciA9IHNldFRpbWVvdXQoXG4gICAgICAgICgpID0+IHJlamVjdChuZXcgRXJyb3IoYCR7bGFiZWx9IHRpbWVkIG91dCBhZnRlciAke3RpbWVvdXRNcyAvIDYwMDAwfSBtaW51dGVzIFx1MjAxNCBubyB1c2VyIHJlc3BvbnNlIHJlY2VpdmVkYCkpLFxuICAgICAgICB0aW1lb3V0TXMsXG4gICAgICApO1xuICAgIH0pLFxuICApO1xuICBsZXQgYWJvcnRMaXN0ZW5lcjogKCgpID0+IHZvaWQpIHwgdW5kZWZpbmVkO1xuICBpZiAoc2lnbmFsKSB7XG4gICAgaWYgKHNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke2xhYmVsfSBjYW5jZWxsZWQgYnkgY2xpZW50YCk7XG4gICAgfVxuICAgIHJhY2Vycy5wdXNoKFxuICAgICAgbmV3IFByb21pc2U8bmV2ZXI+KChfLCByZWplY3QpID0+IHtcbiAgICAgICAgYWJvcnRMaXN0ZW5lciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoYCR7bGFiZWx9IGNhbmNlbGxlZCBieSBjbGllbnRgKSk7XG4gICAgICAgIHNpZ25hbC5hZGRFdmVudExpc3RlbmVyKCdhYm9ydCcsIGFib3J0TGlzdGVuZXIsIHsgb25jZTogdHJ1ZSB9KTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgUHJvbWlzZS5yYWNlKHJhY2Vycyk7XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICBpZiAoc2lnbmFsICYmIGFib3J0TGlzdGVuZXIpIHNpZ25hbC5yZW1vdmVFdmVudExpc3RlbmVyKCdhYm9ydCcsIGFib3J0TGlzdGVuZXIpO1xuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gVG9vbCByZXN1bHQgaGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBXcmFwIGEgSlNPTi1zZXJpYWxpemFibGUgdmFsdWUgYXMgTUNQIHRvb2wgY29udGVudC4gKi9cbmZ1bmN0aW9uIGpzb25Db250ZW50KGRhdGE6IHVua25vd24pOiB7IGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogJ3RleHQnOyB0ZXh0OiBzdHJpbmcgfT4gfSB7XG4gIHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6ICd0ZXh0JyBhcyBjb25zdCwgdGV4dDogSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgMikgfV0gfTtcbn1cblxuLyoqIFJldHVybiBhbiBNQ1AgZXJyb3IgcmVzcG9uc2UuICovXG5mdW5jdGlvbiBlcnJvckNvbnRlbnQobWVzc2FnZTogc3RyaW5nKTogeyBpc0Vycm9yOiB0cnVlOyBjb250ZW50OiBBcnJheTx7IHR5cGU6ICd0ZXh0JzsgdGV4dDogc3RyaW5nIH0+IH0ge1xuICByZXR1cm4geyBpc0Vycm9yOiB0cnVlLCBjb250ZW50OiBbeyB0eXBlOiAndGV4dCcgYXMgY29uc3QsIHRleHQ6IG1lc3NhZ2UgfV0gfTtcbn1cblxuLyoqIFJldHVybiByYXcgdGV4dCBjb250ZW50IHdpdGhvdXQgSlNPTiB3cmFwcGluZy4gKi9cbmZ1bmN0aW9uIHRleHRDb250ZW50KHRleHQ6IHN0cmluZyk6IHsgY29udGVudDogQXJyYXk8eyB0eXBlOiAndGV4dCc7IHRleHQ6IHN0cmluZyB9PiB9IHtcbiAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogJ3RleHQnIGFzIGNvbnN0LCB0ZXh0IH1dIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ3NkX3F1ZXJ5IGZpbGVzeXN0ZW0gcmVhZGVyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBOb3JtYWxpemVkIHF1ZXJ5IGNhdGVnb3JpZXMgZm9yIHtAbGluayByZWFkUHJvamVjdFN0YXRlfS5cbiAqXG4gKiBNYXBzIHVzZXItc3VwcGxpZWQgcXVlcnkgc3RyaW5ncyAob3IgZW1wdHkpIHRvIHRoZSBzZXQgb2YgZmllbGRzIHdlIHJldHVybi5cbiAqIEFjY2VwdHMgY29tbW9uIHN5bm9ueW1zIHNvIHRoZSBNQ1AgY2xpZW50IGNhbiBwYXNzIGludHVpdGl2ZSB2YWx1ZXMuXG4gKi9cbmNvbnN0IFFVRVJZX0ZJRUxEUyA9IHtcbiAgYWxsOiBbJ3N0YXRlJywgJ3Byb2plY3QnLCAncmVxdWlyZW1lbnRzJywgJ21pbGVzdG9uZXMnXSBhcyBjb25zdCxcbiAgc3RhdGU6IFsnc3RhdGUnXSBhcyBjb25zdCxcbiAgc3RhdHVzOiBbJ3N0YXRlJ10gYXMgY29uc3QsXG4gIHByb2plY3Q6IFsncHJvamVjdCddIGFzIGNvbnN0LFxuICByZXF1aXJlbWVudHM6IFsncmVxdWlyZW1lbnRzJ10gYXMgY29uc3QsXG4gIG1pbGVzdG9uZXM6IFsnbWlsZXN0b25lcyddIGFzIGNvbnN0LFxufSBhcyBjb25zdDtcblxudHlwZSBRdWVyeUNhdGVnb3J5ID0ga2V5b2YgdHlwZW9mIFFVRVJZX0ZJRUxEUztcbnR5cGUgUHJvamVjdFN0YXRlRmllbGQgPSAodHlwZW9mIFFVRVJZX0ZJRUxEUylbUXVlcnlDYXRlZ29yeV1bbnVtYmVyXTtcblxuZnVuY3Rpb24gbm9ybWFsaXplUXVlcnkocXVlcnk6IHN0cmluZyB8IHVuZGVmaW5lZCk6IFF1ZXJ5Q2F0ZWdvcnkge1xuICBjb25zdCBrZXkgPSAocXVlcnkgPz8gJ2FsbCcpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICBpZiAoa2V5IGluIFFVRVJZX0ZJRUxEUykgcmV0dXJuIGtleSBhcyBRdWVyeUNhdGVnb3J5O1xuICByZXR1cm4gJ2FsbCc7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRQcm9qZWN0U3RhdGUocHJvamVjdERpcjogc3RyaW5nLCBxdWVyeTogc3RyaW5nIHwgdW5kZWZpbmVkKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICBjb25zdCBnc2REaXIgPSBqb2luKHJlc29sdmUocHJvamVjdERpciksICcuZ3NkJyk7XG4gIGNvbnN0IGNhdGVnb3J5ID0gbm9ybWFsaXplUXVlcnkocXVlcnkpO1xuICBjb25zdCB3YW50ZWQgPSBuZXcgU2V0PFByb2plY3RTdGF0ZUZpZWxkPihRVUVSWV9GSUVMRFNbY2F0ZWdvcnldKTtcblxuICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIHByb2plY3REaXI6IHJlc29sdmUocHJvamVjdERpciksXG4gICAgcXVlcnk6IGNhdGVnb3J5LFxuICB9O1xuXG4gIGlmICh3YW50ZWQuaGFzKCdzdGF0ZScpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJlc3VsdC5zdGF0ZSA9IGF3YWl0IHJlYWRGaWxlKGpvaW4oZ3NkRGlyLCAnU1RBVEUubWQnKSwgJ3V0Zi04Jyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXN1bHQuc3RhdGUgPSBudWxsO1xuICAgIH1cbiAgfVxuXG4gIGlmICh3YW50ZWQuaGFzKCdwcm9qZWN0JykpIHtcbiAgICB0cnkge1xuICAgICAgcmVzdWx0LnByb2plY3QgPSBhd2FpdCByZWFkRmlsZShqb2luKGdzZERpciwgJ1BST0pFQ1QubWQnKSwgJ3V0Zi04Jyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXN1bHQucHJvamVjdCA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgaWYgKHdhbnRlZC5oYXMoJ3JlcXVpcmVtZW50cycpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJlc3VsdC5yZXF1aXJlbWVudHMgPSBhd2FpdCByZWFkRmlsZShqb2luKGdzZERpciwgJ1JFUVVJUkVNRU5UUy5tZCcpLCAndXRmLTgnKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJlc3VsdC5yZXF1aXJlbWVudHMgPSBudWxsO1xuICAgIH1cbiAgfVxuXG4gIGlmICh3YW50ZWQuaGFzKCdtaWxlc3RvbmVzJykpIHtcbiAgICBjb25zdCBtaWxlc3RvbmVzRGlyID0gam9pbihnc2REaXIsICdtaWxlc3RvbmVzJyk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudHJpZXMgPSBhd2FpdCByZWFkZGlyKG1pbGVzdG9uZXNEaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgaGFzUm9hZG1hcDogYm9vbGVhbjsgaGFzU3VtbWFyeTogYm9vbGVhbiB9PiA9IFtdO1xuICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICAgIGlmICghZW50cnkuaXNEaXJlY3RvcnkoKSkgY29udGludWU7XG4gICAgICAgIGNvbnN0IGhhc1JvYWRtYXAgPSAhIXJlc29sdmVNaWxlc3RvbmVGaWxlKGdzZERpciwgZW50cnkubmFtZSwgJ1JPQURNQVAnKTtcbiAgICAgICAgY29uc3QgaGFzU3VtbWFyeSA9ICEhcmVzb2x2ZU1pbGVzdG9uZUZpbGUoZ3NkRGlyLCBlbnRyeS5uYW1lLCAnU1VNTUFSWScpO1xuICAgICAgICBtaWxlc3RvbmVzLnB1c2goeyBpZDogZW50cnkubmFtZSwgaGFzUm9hZG1hcCwgaGFzU3VtbWFyeSB9KTtcbiAgICAgIH1cbiAgICAgIHJlc3VsdC5taWxlc3RvbmVzID0gbWlsZXN0b25lcztcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJlc3VsdC5taWxlc3RvbmVzID0gW107XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBNQ1AgU2VydmVyIHR5cGUgXHUyMDE0IG1pbmltYWwgaW50ZXJmYWNlIGZvciB0aGUgZHluYW1pY2FsbHktaW1wb3J0ZWQgTWNwU2VydmVyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuaW50ZXJmYWNlIEVsaWNpdFJlc3VsdCB7XG4gIGFjdGlvbjogJ2FjY2VwdCcgfCAnZGVjbGluZScgfCAnY2FuY2VsJztcbiAgY29udGVudD86IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IG51bWJlciB8IGJvb2xlYW4gfCBzdHJpbmdbXT47XG59XG5cbmludGVyZmFjZSBFbGljaXRSZXF1ZXN0Rm9ybVBhcmFtcyB7XG4gIG1vZGU/OiAnZm9ybSc7XG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgcmVxdWVzdGVkU2NoZW1hOiB7XG4gICAgdHlwZTogJ29iamVjdCc7XG4gICAgcHJvcGVydGllczogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICAgIHJlcXVpcmVkPzogc3RyaW5nW107XG4gIH07XG59XG5cbi8qKlxuICogSGFuZGxlciBleHRyYSBcdTIwMTQgdGhlIHNlY29uZCBhcmd1bWVudCBwYXNzZWQgYnkgTWNwU2VydmVyLnRvb2wgaGFuZGxlcnMuXG4gKiBDb250YWlucyBhbiBBYm9ydFNpZ25hbCBzY29wZWQgdG8gdGhlIEpTT04tUlBDIHJlcXVlc3QgKGNhbmNlbGxlZCB3aGVuXG4gKiB0aGUgY2xpZW50IGNhbmNlbHMgdGhlIGB0b29scy9jYWxsYCkgcGx1cyBvdGhlciBwZXItcmVxdWVzdCBtZXRhZGF0YS5cbiAqIFRvb2xzIHRoYXQgY2FuIGFjdHVhbGx5IGJlIHN0b3BwZWQgbWlkLWZsaWdodCBzaG91bGQgaG9ub3VyIGBzaWduYWxgLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIE1jcFRvb2xFeHRyYSB7XG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICByZXF1ZXN0SWQ/OiBzdHJpbmcgfCBudW1iZXI7XG4gIHNlbmROb3RpZmljYXRpb24/OiAobm90aWZpY2F0aW9uOiB1bmtub3duKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbn1cblxuaW50ZXJmYWNlIE1jcFNlcnZlckluc3RhbmNlIHtcbiAgdG9vbChcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgZGVzY3JpcHRpb246IHN0cmluZyxcbiAgICBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIGhhbmRsZXI6IChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZXh0cmE/OiBNY3BUb29sRXh0cmEpID0+IFByb21pc2U8dW5rbm93bj4sXG4gICk6IHVua25vd247XG4gIHNlcnZlcjoge1xuICAgIGVsaWNpdElucHV0KFxuICAgICAgcGFyYW1zOiBBc2tVc2VyUXVlc3Rpb25zRWxpY2l0UmVxdWVzdCB8IEVsaWNpdFJlcXVlc3RGb3JtUGFyYW1zLFxuICAgICAgb3B0aW9ucz86IHVua25vd24sXG4gICAgKTogUHJvbWlzZTxBc2tVc2VyUXVlc3Rpb25zRWxpY2l0UmVzdWx0PjtcbiAgfTtcbiAgY29ubmVjdCh0cmFuc3BvcnQ6IHVua25vd24pOiBQcm9taXNlPHZvaWQ+O1xuICBjbG9zZSgpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5pbnRlcmZhY2UgQXNrVXNlclF1ZXN0aW9uT3B0aW9uIHtcbiAgbGFiZWw6IHN0cmluZztcbiAgZGVzY3JpcHRpb246IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIEFza1VzZXJRdWVzdGlvbiB7XG4gIGlkOiBzdHJpbmc7XG4gIGhlYWRlcjogc3RyaW5nO1xuICBxdWVzdGlvbjogc3RyaW5nO1xuICBvcHRpb25zOiBBc2tVc2VyUXVlc3Rpb25PcHRpb25bXTtcbiAgYWxsb3dNdWx0aXBsZT86IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBBc2tVc2VyUXVlc3Rpb25zUGFyYW1zIHtcbiAgcXVlc3Rpb25zOiBBc2tVc2VyUXVlc3Rpb25bXTtcbn1cblxudHlwZSBBc2tVc2VyUXVlc3Rpb25zQ29udGVudFZhbHVlID0gc3RyaW5nIHwgbnVtYmVyIHwgYm9vbGVhbiB8IHN0cmluZ1tdO1xuXG5pbnRlcmZhY2UgQXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlc3VsdCB7XG4gIGFjdGlvbjogJ2FjY2VwdCcgfCAnZGVjbGluZScgfCAnY2FuY2VsJztcbiAgY29udGVudD86IFJlY29yZDxzdHJpbmcsIEFza1VzZXJRdWVzdGlvbnNDb250ZW50VmFsdWU+O1xufVxuXG5pbnRlcmZhY2UgQXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlcXVlc3Qge1xuICBtb2RlOiAnZm9ybSc7XG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgcmVxdWVzdGVkU2NoZW1hOiB7XG4gICAgdHlwZTogJ29iamVjdCc7XG4gICAgcHJvcGVydGllczogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICAgIHJlcXVpcmVkPzogc3RyaW5nW107XG4gIH07XG59XG5cbi8qKlxuICogU3RydWN0dXJlZCBwYXlsb2FkIG1pcnJvcmVkIHRvIHRoZSBNQ1AgYHN0cnVjdHVyZWRDb250ZW50YCBmaWVsZCBvblxuICogYGFza191c2VyX3F1ZXN0aW9uc2AgcmVzdWx0cy4gTWlycm9ycyB0aGUgYExvY2FsUmVzdWx0RGV0YWlsc2Agc2hhcGUgdGhhdFxuICogc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2Fzay11c2VyLXF1ZXN0aW9ucy50cyBhbHJlYWR5IHByb2R1Y2VzLCBzbyB0aGVcbiAqIEdTRCBkaXNjdXNzaW9uLWdhdGUgaG9vayBpbiByZWdpc3Rlci1ob29rcy50cyBjYW4gdHJlYXQgdGhlIE1DUCBwYXRoXG4gKiBpZGVudGljYWxseSB0byB0aGUgaW4tcHJvY2VzcyBleHRlbnNpb24gcGF0aC4gV2l0aG91dCB0aGlzLCB0aGUgYnJpZGdlXG4gKiBzdXJmYWNlcyBgZGV0YWlscyA9IHVuZGVmaW5lZGAgYW5kIHRoZSBnYXRlIGhvb2snc1xuICogYGlmIChkZXRhaWxzPy5jYW5jZWxsZWQgfHwgIWRldGFpbHM/LnJlc3BvbnNlKWAgYnJhbmNoIEhBUkQtQkxPQ0tzIGV2ZXJ5XG4gKiB1c2VyIGFuc3dlciwgaW5jbHVkaW5nIHN1Y2Nlc3NmdWwgY29uZmlybWF0aW9ucy4gU2VlICM1MjY3LlxuICovXG5pbnRlcmZhY2UgQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0QW5zd2VyIHtcbiAgc2VsZWN0ZWQ6IHN0cmluZyB8IHN0cmluZ1tdO1xuICBub3Rlczogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0IHtcbiAgZW5kSW50ZXJ2aWV3OiBmYWxzZTtcbiAgYW5zd2VyczogUmVjb3JkPHN0cmluZywgQXNrVXNlclF1ZXN0aW9uc1JvdW5kUmVzdWx0QW5zd2VyPjtcbn1cblxuaW50ZXJmYWNlIEFza1VzZXJRdWVzdGlvbnNTdHJ1Y3R1cmVkQ29udGVudCB7XG4gIHF1ZXN0aW9uczogQXNrVXNlclF1ZXN0aW9uW107XG4gIHJlc3BvbnNlOiBBc2tVc2VyUXVlc3Rpb25zUm91bmRSZXN1bHQgfCBudWxsO1xuICBjYW5jZWxsZWQ6IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBBc2tVc2VyUXVlc3Rpb25zV3JpdGVHYXRlTW9kdWxlIHtcbiAgaXNHYXRlUXVlc3Rpb25JZChxdWVzdGlvbklkOiBzdHJpbmcpOiBib29sZWFuO1xuICBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyKHNlbGVjdGVkOiB1bmtub3duLCBvcHRpb25zPzogQXJyYXk8eyBsYWJlbD86IHN0cmluZyB9Pik6IGJvb2xlYW47XG4gIHNldFBlbmRpbmdHYXRlKGdhdGVJZDogc3RyaW5nLCBiYXNlUGF0aDogc3RyaW5nKTogdm9pZDtcbiAgbWFya0FwcHJvdmFsR2F0ZVZlcmlmaWVkKGdhdGVJZD86IHN0cmluZyB8IG51bGwsIGJhc2VQYXRoPzogc3RyaW5nKTogdm9pZDtcbiAgbWFya0RlcHRoVmVyaWZpZWQobWlsZXN0b25lSWQ/OiBzdHJpbmcgfCBudWxsLCBiYXNlUGF0aD86IHN0cmluZyk6IHZvaWQ7XG4gIGNsZWFyUGVuZGluZ0dhdGUoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQ7XG4gIGV4dHJhY3REZXB0aFZlcmlmaWNhdGlvbk1pbGVzdG9uZUlkKHF1ZXN0aW9uSWQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGw7XG59XG5cbmNvbnN0IE9USEVSX09QVElPTl9MQUJFTCA9ICdOb25lIG9mIHRoZSBhYm92ZSc7XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUFza1VzZXJRdWVzdGlvbnNOb3RlKHZhbHVlOiBBc2tVc2VyUXVlc3Rpb25zQ29udGVudFZhbHVlIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgPyB2YWx1ZS50cmltKCkgOiAnJztcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQXNrVXNlclF1ZXN0aW9uc0Fuc3dlcnMoXG4gIHZhbHVlOiBBc2tVc2VyUXVlc3Rpb25zQ29udGVudFZhbHVlIHwgdW5kZWZpbmVkLFxuICBhbGxvd011bHRpcGxlOiBib29sZWFuLFxuKTogc3RyaW5nW10ge1xuICBpZiAoYWxsb3dNdWx0aXBsZSkge1xuICAgIHJldHVybiBBcnJheS5pc0FycmF5KHZhbHVlKSA/IHZhbHVlLmZpbHRlcigoaXRlbSk6IGl0ZW0gaXMgc3RyaW5nID0+IHR5cGVvZiBpdGVtID09PSAnc3RyaW5nJykgOiBbXTtcbiAgfVxuXG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlLmxlbmd0aCA+IDAgPyBbdmFsdWVdIDogW107XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlQXNrVXNlclF1ZXN0aW9uc1BheWxvYWQocXVlc3Rpb25zOiBBc2tVc2VyUXVlc3Rpb25bXSk6IHN0cmluZyB8IG51bGwge1xuICBpZiAocXVlc3Rpb25zLmxlbmd0aCA9PT0gMCB8fCBxdWVzdGlvbnMubGVuZ3RoID4gMykge1xuICAgIHJldHVybiAnRXJyb3I6IHF1ZXN0aW9ucyBtdXN0IGNvbnRhaW4gMS0zIGl0ZW1zJztcbiAgfVxuXG4gIGZvciAoY29uc3QgcXVlc3Rpb24gb2YgcXVlc3Rpb25zKSB7XG4gICAgaWYgKCFxdWVzdGlvbi5vcHRpb25zIHx8IHF1ZXN0aW9uLm9wdGlvbnMubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4gYEVycm9yOiBhc2tfdXNlcl9xdWVzdGlvbnMgcmVxdWlyZXMgbm9uLWVtcHR5IG9wdGlvbnMgZm9yIGV2ZXJ5IHF1ZXN0aW9uIChxdWVzdGlvbiBcIiR7cXVlc3Rpb24uaWR9XCIgaGFzIG5vbmUpYDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkQXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlcXVlc3QocXVlc3Rpb25zOiBBc2tVc2VyUXVlc3Rpb25bXSk6IEFza1VzZXJRdWVzdGlvbnNFbGljaXRSZXF1ZXN0IHtcbiAgY29uc3QgcHJvcGVydGllczogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0ge307XG4gIGNvbnN0IHJlcXVpcmVkID0gcXVlc3Rpb25zLm1hcCgocXVlc3Rpb24pID0+IHF1ZXN0aW9uLmlkKTtcblxuICBmb3IgKGNvbnN0IHF1ZXN0aW9uIG9mIHF1ZXN0aW9ucykge1xuICAgIGlmIChxdWVzdGlvbi5hbGxvd011bHRpcGxlKSB7XG4gICAgICBwcm9wZXJ0aWVzW3F1ZXN0aW9uLmlkXSA9IHtcbiAgICAgICAgdHlwZTogJ2FycmF5JyxcbiAgICAgICAgdGl0bGU6IHF1ZXN0aW9uLmhlYWRlcixcbiAgICAgICAgZGVzY3JpcHRpb246IHF1ZXN0aW9uLnF1ZXN0aW9uLFxuICAgICAgICBtaW5JdGVtczogMSxcbiAgICAgICAgbWF4SXRlbXM6IHF1ZXN0aW9uLm9wdGlvbnMubGVuZ3RoLFxuICAgICAgICBpdGVtczoge1xuICAgICAgICAgIGFueU9mOiBxdWVzdGlvbi5vcHRpb25zLm1hcCgob3B0aW9uKSA9PiAoe1xuICAgICAgICAgICAgY29uc3Q6IG9wdGlvbi5sYWJlbCxcbiAgICAgICAgICAgIHRpdGxlOiBvcHRpb24ubGFiZWwsXG4gICAgICAgICAgfSkpLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIHByb3BlcnRpZXNbcXVlc3Rpb24uaWRdID0ge1xuICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICB0aXRsZTogcXVlc3Rpb24uaGVhZGVyLFxuICAgICAgZGVzY3JpcHRpb246IHF1ZXN0aW9uLnF1ZXN0aW9uLFxuICAgICAgb25lT2Y6IFsuLi5xdWVzdGlvbi5vcHRpb25zLCB7IGxhYmVsOiBPVEhFUl9PUFRJT05fTEFCRUwsIGRlc2NyaXB0aW9uOiAnQ2hvb3NlIHRoaXMgd2hlbiB0aGUgbGlzdGVkIG9wdGlvbnMgZG8gbm90IGZpdC4nIH1dLm1hcCgob3B0aW9uKSA9PiAoe1xuICAgICAgICBjb25zdDogb3B0aW9uLmxhYmVsLFxuICAgICAgICB0aXRsZTogb3B0aW9uLmxhYmVsLFxuICAgICAgfSkpLFxuICAgIH07XG5cbiAgICBwcm9wZXJ0aWVzW2Ake3F1ZXN0aW9uLmlkfV9fbm90ZWBdID0ge1xuICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICB0aXRsZTogYCR7cXVlc3Rpb24uaGVhZGVyfSBOb3RlYCxcbiAgICAgIGRlc2NyaXB0aW9uOiBgT3B0aW9uYWwgbm90ZSBmb3IgXCIke09USEVSX09QVElPTl9MQUJFTH1cIi5gLFxuICAgICAgbWF4TGVuZ3RoOiA1MDAsXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgbW9kZTogJ2Zvcm0nLFxuICAgIG1lc3NhZ2U6ICdQbGVhc2UgYW5zd2VyIHRoZSBmb2xsb3dpbmcgcXVlc3Rpb24ocykuIEZvciBzaW5nbGUtc2VsZWN0IHF1ZXN0aW9ucywgY2hvb3NlIFwiTm9uZSBvZiB0aGUgYWJvdmVcIiBhbmQgYWRkIGEgbm90ZSBpZiB0aGUgcHJvdmlkZWQgb3B0aW9ucyBkbyBub3QgZml0LicsXG4gICAgcmVxdWVzdGVkU2NoZW1hOiB7XG4gICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgIHByb3BlcnRpZXMsXG4gICAgICByZXF1aXJlZCxcbiAgICB9LFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0QXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlc3VsdChcbiAgcXVlc3Rpb25zOiBBc2tVc2VyUXVlc3Rpb25bXSxcbiAgcmVzdWx0OiBBc2tVc2VyUXVlc3Rpb25zRWxpY2l0UmVzdWx0LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgYW5zd2VyczogUmVjb3JkPHN0cmluZywgeyBhbnN3ZXJzOiBzdHJpbmdbXSB9PiA9IHt9O1xuICBjb25zdCBjb250ZW50ID0gcmVzdWx0LmNvbnRlbnQgPz8ge307XG5cbiAgZm9yIChjb25zdCBxdWVzdGlvbiBvZiBxdWVzdGlvbnMpIHtcbiAgICBjb25zdCBhbnN3ZXJMaXN0ID0gbm9ybWFsaXplQXNrVXNlclF1ZXN0aW9uc0Fuc3dlcnMoY29udGVudFtxdWVzdGlvbi5pZF0sICEhcXVlc3Rpb24uYWxsb3dNdWx0aXBsZSk7XG5cbiAgICBpZiAoIXF1ZXN0aW9uLmFsbG93TXVsdGlwbGUgJiYgYW5zd2VyTGlzdFswXSA9PT0gT1RIRVJfT1BUSU9OX0xBQkVMKSB7XG4gICAgICBjb25zdCBub3RlID0gbm9ybWFsaXplQXNrVXNlclF1ZXN0aW9uc05vdGUoY29udGVudFtgJHtxdWVzdGlvbi5pZH1fX25vdGVgXSk7XG4gICAgICBpZiAobm90ZSkge1xuICAgICAgICBhbnN3ZXJMaXN0LnB1c2goYHVzZXJfbm90ZTogJHtub3RlfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGFuc3dlcnNbcXVlc3Rpb24uaWRdID0geyBhbnN3ZXJzOiBhbnN3ZXJMaXN0IH07XG4gIH1cblxuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBhbnN3ZXJzIH0pO1xufVxuXG4vKipcbiAqIE5vcm1hbGl6ZSBhbiBNQ1AgZWxpY2l0YXRpb24gZm9ybSByZXN1bHQgaW50byB0aGUgYFJvdW5kUmVzdWx0YCBzaGFwZSB0aGVcbiAqIEdTRCBkaXNjdXNzaW9uLWdhdGUgaG9vayByZWFkcyBmcm9tIGB0b29sX3Jlc3VsdGAgYGRldGFpbHMucmVzcG9uc2VgLiBUaGVcbiAqIGVsaWNpdGF0aW9uIGBjb250ZW50YCBtYXAgY2FycmllcyBgeyBbaWRdOiBsYWJlbCwgW2lkXV9fbm90ZT86IHN0cmluZyB9YDtcbiAqIHRoZSBob29rIGV4cGVjdHMgYHsgYW5zd2VyczogeyBbaWRdOiB7IHNlbGVjdGVkLCBub3RlcyB9IH0gfWAuIE1pcnJvcmVkIGludG9cbiAqIGBzdHJ1Y3R1cmVkQ29udGVudGAgYnkgYGFza1VzZXJRdWVzdGlvbnNIYW5kbGVyYC4gU2VlICM1MjY3LlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRBc2tVc2VyUXVlc3Rpb25zUm91bmRSZXN1bHQoXG4gIHF1ZXN0aW9uczogQXNrVXNlclF1ZXN0aW9uW10sXG4gIHJlc3VsdDogQXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlc3VsdCxcbik6IEFza1VzZXJRdWVzdGlvbnNSb3VuZFJlc3VsdCB7XG4gIGNvbnN0IGFuc3dlcnM6IFJlY29yZDxzdHJpbmcsIEFza1VzZXJRdWVzdGlvbnNSb3VuZFJlc3VsdEFuc3dlcj4gPSB7fTtcbiAgY29uc3QgY29udGVudCA9IHJlc3VsdC5jb250ZW50ID8/IHt9O1xuXG4gIGZvciAoY29uc3QgcXVlc3Rpb24gb2YgcXVlc3Rpb25zKSB7XG4gICAgaWYgKHF1ZXN0aW9uLmFsbG93TXVsdGlwbGUpIHtcbiAgICAgIGNvbnN0IGxpc3QgPSBub3JtYWxpemVBc2tVc2VyUXVlc3Rpb25zQW5zd2Vycyhjb250ZW50W3F1ZXN0aW9uLmlkXSwgdHJ1ZSk7XG4gICAgICBhbnN3ZXJzW3F1ZXN0aW9uLmlkXSA9IHsgc2VsZWN0ZWQ6IGxpc3QsIG5vdGVzOiAnJyB9O1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgbGlzdCA9IG5vcm1hbGl6ZUFza1VzZXJRdWVzdGlvbnNBbnN3ZXJzKGNvbnRlbnRbcXVlc3Rpb24uaWRdLCBmYWxzZSk7XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBsaXN0WzBdID8/ICcnO1xuICAgIGNvbnN0IG5vdGVzID0gc2VsZWN0ZWQgPT09IE9USEVSX09QVElPTl9MQUJFTFxuICAgICAgPyBub3JtYWxpemVBc2tVc2VyUXVlc3Rpb25zTm90ZShjb250ZW50W2Ake3F1ZXN0aW9uLmlkfV9fbm90ZWBdKVxuICAgICAgOiAnJztcbiAgICBhbnN3ZXJzW3F1ZXN0aW9uLmlkXSA9IHsgc2VsZWN0ZWQsIG5vdGVzIH07XG4gIH1cblxuICAvLyBgZW5kSW50ZXJ2aWV3OiBmYWxzZWAgbWlycm9ycyB0aGUgbG9jYWwgZXh0ZW5zaW9uJ3MgYFJvdW5kUmVzdWx0YCBzaGFwZSBhbmRcbiAgLy8gbWF0Y2hlcyB0aGUgcmVtb3RlIHBhdGgncyBgdG9Sb3VuZFJlc3VsdFJlc3BvbnNlYCBzbyByZWdpc3Rlci1ob29rcyByZWFkc1xuICAvLyBpZGVudGljYWwgcGF5bG9hZHMgcmVnYXJkbGVzcyBvZiBjaGFubmVsLiBTZWUgcGVlciByZXZpZXcgIzUyNjctUTIuXG4gIHJldHVybiB7IGVuZEludGVydmlldzogZmFsc2UsIGFuc3dlcnMgfTtcbn1cblxuaW50ZXJmYWNlIEFza1VzZXJRdWVzdGlvbnNIYW5kbGVyRGVwcyB7XG4gIGVsaWNpdElucHV0KHBhcmFtczogQXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlcXVlc3QpOiBQcm9taXNlPEFza1VzZXJRdWVzdGlvbnNFbGljaXRSZXN1bHQ+O1xuICBpc1JlbW90ZUNvbmZpZ3VyZWQoKTogYm9vbGVhbjtcbiAgdHJ5UmVtb3RlUXVlc3Rpb25zKHF1ZXN0aW9uczogQXNrVXNlclF1ZXN0aW9uW10sIHNpZ25hbD86IEFib3J0U2lnbmFsKTogUHJvbWlzZTxSZW1vdGVUb29sUmVzdWx0IHwgbnVsbD47XG4gIHdyaXRlR2F0ZT86IEFza1VzZXJRdWVzdGlvbnNXcml0ZUdhdGVNb2R1bGUgfCBudWxsO1xuICB3cml0ZUdhdGVCYXNlUGF0aD86IHN0cmluZztcbn1cblxubGV0IGFza1VzZXJRdWVzdGlvbnNXcml0ZUdhdGVNb2R1bGVQcm9taXNlOiBQcm9taXNlPEFza1VzZXJRdWVzdGlvbnNXcml0ZUdhdGVNb2R1bGUgfCBudWxsPiB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiBpc0Fza1VzZXJRdWVzdGlvbnNXcml0ZUdhdGVNb2R1bGUodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBBc2tVc2VyUXVlc3Rpb25zV3JpdGVHYXRlTW9kdWxlIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IG1vZHVsZSA9IHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICByZXR1cm4gKFxuICAgIHR5cGVvZiBtb2R1bGVbJ2lzR2F0ZVF1ZXN0aW9uSWQnXSA9PT0gJ2Z1bmN0aW9uJyAmJlxuICAgIHR5cGVvZiBtb2R1bGVbJ2lzRGVwdGhDb25maXJtYXRpb25BbnN3ZXInXSA9PT0gJ2Z1bmN0aW9uJyAmJlxuICAgIHR5cGVvZiBtb2R1bGVbJ3NldFBlbmRpbmdHYXRlJ10gPT09ICdmdW5jdGlvbicgJiZcbiAgICB0eXBlb2YgbW9kdWxlWydtYXJrQXBwcm92YWxHYXRlVmVyaWZpZWQnXSA9PT0gJ2Z1bmN0aW9uJyAmJlxuICAgIHR5cGVvZiBtb2R1bGVbJ21hcmtEZXB0aFZlcmlmaWVkJ10gPT09ICdmdW5jdGlvbicgJiZcbiAgICB0eXBlb2YgbW9kdWxlWydjbGVhclBlbmRpbmdHYXRlJ10gPT09ICdmdW5jdGlvbicgJiZcbiAgICB0eXBlb2YgbW9kdWxlWydleHRyYWN0RGVwdGhWZXJpZmljYXRpb25NaWxlc3RvbmVJZCddID09PSAnZnVuY3Rpb24nXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRBc2tVc2VyUXVlc3Rpb25zV3JpdGVHYXRlTW9kdWxlKCk6IFByb21pc2U8QXNrVXNlclF1ZXN0aW9uc1dyaXRlR2F0ZU1vZHVsZSB8IG51bGw+IHtcbiAgaWYgKCFhc2tVc2VyUXVlc3Rpb25zV3JpdGVHYXRlTW9kdWxlUHJvbWlzZSkge1xuICAgIGFza1VzZXJRdWVzdGlvbnNXcml0ZUdhdGVNb2R1bGVQcm9taXNlID0gKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IG1vZHVsZVBhdGggPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfV1JJVEVfR0FURV9NT0RVTEU/LnRyaW0oKTtcbiAgICAgIGlmICghbW9kdWxlUGF0aCkgcmV0dXJuIG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoL15bYS16XXsyLH06L2kudGVzdChtb2R1bGVQYXRoKSAmJiAhbW9kdWxlUGF0aC5zdGFydHNXaXRoKCdmaWxlOicpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdHU0RfV09SS0ZMT1dfV1JJVEVfR0FURV9NT0RVTEUgb25seSBzdXBwb3J0cyBmaWxlOiBVUkxzIG9yIGZpbGVzeXN0ZW0gcGF0aHMuJyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgYmFzZVJvb3QgPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUFJPSkVDVF9ST09UPy50cmltKCkgfHwgcHJvY2Vzcy5jd2QoKTtcbiAgICAgICAgY29uc3Qgc3BlY2lmaWVyID0gbW9kdWxlUGF0aC5zdGFydHNXaXRoKCdmaWxlOicpID8gbW9kdWxlUGF0aCA6IHBhdGhUb0ZpbGVVUkwocmVzb2x2ZShiYXNlUm9vdCwgbW9kdWxlUGF0aCkpLmhyZWY7XG4gICAgICAgIGNvbnN0IGxvYWRlZCA9IGF3YWl0IGltcG9ydChzcGVjaWZpZXIpO1xuICAgICAgICByZXR1cm4gaXNBc2tVc2VyUXVlc3Rpb25zV3JpdGVHYXRlTW9kdWxlKGxvYWRlZCkgPyBsb2FkZWQgOiBudWxsO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihgW2dzZDptY3BdIGFza191c2VyX3F1ZXN0aW9ucyB3cml0ZS1nYXRlIGludGVncmF0aW9uIHVuYXZhaWxhYmxlOiAke2Zvcm1hdEVycm9yTWVzc2FnZShlcnIpfWApO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9KSgpO1xuICB9XG4gIHJldHVybiBhc2tVc2VyUXVlc3Rpb25zV3JpdGVHYXRlTW9kdWxlUHJvbWlzZTtcbn1cblxuZnVuY3Rpb24gYXNrVXNlclF1ZXN0aW9uc1dyaXRlR2F0ZUJhc2VQYXRoKGRlcHM6IEFza1VzZXJRdWVzdGlvbnNIYW5kbGVyRGVwcyk6IHN0cmluZyB7XG4gIHJldHVybiBkZXBzLndyaXRlR2F0ZUJhc2VQYXRoID8/IHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19QUk9KRUNUX1JPT1Q/LnRyaW0oKSA/PyBwcm9jZXNzLmN3ZCgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQXNrVXNlclF1ZXN0aW9uc1dyaXRlR2F0ZShkZXBzOiBBc2tVc2VyUXVlc3Rpb25zSGFuZGxlckRlcHMpOiBQcm9taXNlPEFza1VzZXJRdWVzdGlvbnNXcml0ZUdhdGVNb2R1bGUgfCBudWxsPiB7XG4gIGlmIChkZXBzLndyaXRlR2F0ZSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gZGVwcy53cml0ZUdhdGU7XG4gIHJldHVybiBsb2FkQXNrVXNlclF1ZXN0aW9uc1dyaXRlR2F0ZU1vZHVsZSgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWNvcmRBc2tVc2VyUXVlc3Rpb25zUGVuZGluZ0dhdGUoXG4gIHF1ZXN0aW9uczogQXNrVXNlclF1ZXN0aW9uW10sXG4gIGRlcHM6IEFza1VzZXJRdWVzdGlvbnNIYW5kbGVyRGVwcyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB3cml0ZUdhdGUgPSBhd2FpdCByZXNvbHZlQXNrVXNlclF1ZXN0aW9uc1dyaXRlR2F0ZShkZXBzKTtcbiAgaWYgKCF3cml0ZUdhdGUpIHJldHVybjtcblxuICBjb25zdCBiYXNlUGF0aCA9IGFza1VzZXJRdWVzdGlvbnNXcml0ZUdhdGVCYXNlUGF0aChkZXBzKTtcbiAgZm9yIChjb25zdCBxdWVzdGlvbiBvZiBxdWVzdGlvbnMpIHtcbiAgICBpZiAod3JpdGVHYXRlLmlzR2F0ZVF1ZXN0aW9uSWQocXVlc3Rpb24uaWQpKSB7XG4gICAgICB3cml0ZUdhdGUuc2V0UGVuZGluZ0dhdGUocXVlc3Rpb24uaWQsIGJhc2VQYXRoKTtcbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVjb3JkQXNrVXNlclF1ZXN0aW9uc0dhdGVSZXN1bHQoXG4gIHN0cnVjdHVyZWQ6IEFza1VzZXJRdWVzdGlvbnNTdHJ1Y3R1cmVkQ29udGVudCxcbiAgZGVwczogQXNrVXNlclF1ZXN0aW9uc0hhbmRsZXJEZXBzLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChzdHJ1Y3R1cmVkLmNhbmNlbGxlZCB8fCAhc3RydWN0dXJlZC5yZXNwb25zZSkgcmV0dXJuO1xuICBjb25zdCB3cml0ZUdhdGUgPSBhd2FpdCByZXNvbHZlQXNrVXNlclF1ZXN0aW9uc1dyaXRlR2F0ZShkZXBzKTtcbiAgaWYgKCF3cml0ZUdhdGUpIHJldHVybjtcblxuICBjb25zdCBiYXNlUGF0aCA9IGFza1VzZXJRdWVzdGlvbnNXcml0ZUdhdGVCYXNlUGF0aChkZXBzKTtcbiAgZm9yIChjb25zdCBxdWVzdGlvbiBvZiBzdHJ1Y3R1cmVkLnF1ZXN0aW9ucykge1xuICAgIGlmICghd3JpdGVHYXRlLmlzR2F0ZVF1ZXN0aW9uSWQocXVlc3Rpb24uaWQpKSBjb250aW51ZTtcbiAgICBjb25zdCBzZWxlY3RlZCA9IHN0cnVjdHVyZWQucmVzcG9uc2UuYW5zd2Vyc1txdWVzdGlvbi5pZF0/LnNlbGVjdGVkO1xuICAgIGlmICghd3JpdGVHYXRlLmlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIoc2VsZWN0ZWQsIHF1ZXN0aW9uLm9wdGlvbnMpKSBjb250aW51ZTtcblxuICAgIHdyaXRlR2F0ZS5tYXJrQXBwcm92YWxHYXRlVmVyaWZpZWQocXVlc3Rpb24uaWQsIGJhc2VQYXRoKTtcbiAgICB3cml0ZUdhdGUubWFya0RlcHRoVmVyaWZpZWQod3JpdGVHYXRlLmV4dHJhY3REZXB0aFZlcmlmaWNhdGlvbk1pbGVzdG9uZUlkKHF1ZXN0aW9uLmlkKSwgYmFzZVBhdGgpO1xuICAgIHdyaXRlR2F0ZS5jbGVhclBlbmRpbmdHYXRlKGJhc2VQYXRoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc0xvY2FsRWxpY2l0RmFsbGJhY2tFcnJvcihlcnI6IHVua25vd24pOiBib29sZWFuIHtcbiAgaWYgKCEoZXJyIGluc3RhbmNlb2YgRXJyb3IpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IG1lc3NhZ2UgPSBlcnIubWVzc2FnZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gKFxuICAgIG1lc3NhZ2UuaW5jbHVkZXMoJ3RpbWVkIG91dCBhZnRlcicpIHx8XG4gICAgbWVzc2FnZS5pbmNsdWRlcygnZWxpY2l0JykgfHxcbiAgICBtZXNzYWdlLmluY2x1ZGVzKCdlbGljaXRhdGlvbicpIHx8XG4gICAgbWVzc2FnZS5pbmNsdWRlcygnaG9zdCcpIHx8XG4gICAgbWVzc2FnZS5pbmNsdWRlcygnbm90IHN1cHBvcnRlZCcpIHx8XG4gICAgbWVzc2FnZS5pbmNsdWRlcygnbWV0aG9kIG5vdCBmb3VuZCcpIHx8XG4gICAgbWVzc2FnZS5pbmNsdWRlcygnLTMyNjAxJylcbiAgKTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0RXJyb3JNZXNzYWdlKGVycjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG59XG5cbi8qKlxuICogRGVmZW5zaXZlIGd1YXJkIGZvciB0aGUgYGRldGFpbHMucmVzcG9uc2VgIHBheWxvYWQgZnJvbSBgdHJ5UmVtb3RlUXVlc3Rpb25zYC5cbiAqIEFjY2VwdHMgb25seSBhbiBvYmplY3Qgd2l0aCBhIHBsYWluIGBhbnN3ZXJzYCBtYXA7IGFueXRoaW5nIGVsc2UgKG51bGwsXG4gKiBzdHJpbmdpZmllZCBKU09OLCBtaXNzaW5nKSBmYWxscyBiYWNrIHRvIGBudWxsYCBzbyB0aGUgZ2F0ZSBob29rIHJvdXRlc1xuICogdGhlIGNhbmNlbCBicmFuY2ggaW5zdGVhZCBvZiBjcmFzaGluZyBvbiBgZGV0YWlscy5yZXNwb25zZS5hbnN3ZXJzW2lkXWAuXG4gKi9cbmZ1bmN0aW9uIGlzUm91bmRSZXN1bHRMaWtlKHZhbHVlOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSAnb2JqZWN0JykgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBhbnN3ZXJzID0gKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVsnYW5zd2VycyddO1xuICByZXR1cm4gISFhbnN3ZXJzICYmIHR5cGVvZiBhbnN3ZXJzID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheShhbnN3ZXJzKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFza1VzZXJRdWVzdGlvbnNIYW5kbGVyKFxuICBxdWVzdGlvbnM6IEFza1VzZXJRdWVzdGlvbltdLFxuICBleHRyYTogTWNwVG9vbEV4dHJhIHwgdW5kZWZpbmVkLFxuICBkZXBzOiBBc2tVc2VyUXVlc3Rpb25zSGFuZGxlckRlcHMsXG4pOiBQcm9taXNlPFRvb2xDb250ZW50PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgdmFsaWRhdGlvbkVycm9yID0gdmFsaWRhdGVBc2tVc2VyUXVlc3Rpb25zUGF5bG9hZChxdWVzdGlvbnMpO1xuICAgIGlmICh2YWxpZGF0aW9uRXJyb3IpIHJldHVybiBlcnJvckNvbnRlbnQodmFsaWRhdGlvbkVycm9yKTtcbiAgICBhd2FpdCByZWNvcmRBc2tVc2VyUXVlc3Rpb25zUGVuZGluZ0dhdGUocXVlc3Rpb25zLCBkZXBzKTtcblxuICAgIC8vIExvY2FsLWZpcnN0OiB0cnkgdGhlIE1DUCBob3N0J3MgZWxpY2l0YXRpb24gY2hhbm5lbCAoQ2xhdWRlIENvZGUsXG4gICAgLy8gQ3Vyc29yLCBldGMuKSBiZWZvcmUgYW55IGNvbmZpZ3VyZWQgcmVtb3RlIGNoYW5uZWwuIEEgbWlzY29uZmlndXJlZFxuICAgIC8vIHJlbW90ZSAoZS5nLiBleHBpcmVkIERpc2NvcmQgdG9rZW4gcmV0dXJuaW5nIDQwMSkgbXVzdCBub3QgYmxvY2sgdGhlXG4gICAgLy8gZGVwdGgtdmVyaWZpY2F0aW9uIGdhdGUgd2hlbiB0aGUgdXNlciBpcyBzaXR0aW5nIGluIGZyb250IG9mIHRoZSBob3N0LlxuICAgIGxldCBsb2NhbEVsaWNpdEVycm9yOiB1bmtub3duO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBlbGljaXRhdGlvbiA9IGF3YWl0IHdpdGhFbGljaXRUaW1lb3V0KFxuICAgICAgICBkZXBzLmVsaWNpdElucHV0KGJ1aWxkQXNrVXNlclF1ZXN0aW9uc0VsaWNpdFJlcXVlc3QocXVlc3Rpb25zKSksXG4gICAgICAgICdhc2tfdXNlcl9xdWVzdGlvbnMnLFxuICAgICAgKTtcbiAgICAgIGlmIChlbGljaXRhdGlvbi5hY3Rpb24gPT09ICdhY2NlcHQnICYmIGVsaWNpdGF0aW9uLmNvbnRlbnQpIHtcbiAgICAgICAgY29uc3Qgc3RydWN0dXJlZDogQXNrVXNlclF1ZXN0aW9uc1N0cnVjdHVyZWRDb250ZW50ID0ge1xuICAgICAgICAgIHF1ZXN0aW9ucyxcbiAgICAgICAgICByZXNwb25zZTogYnVpbGRBc2tVc2VyUXVlc3Rpb25zUm91bmRSZXN1bHQocXVlc3Rpb25zLCBlbGljaXRhdGlvbiksXG4gICAgICAgICAgY2FuY2VsbGVkOiBmYWxzZSxcbiAgICAgICAgfTtcbiAgICAgICAgYXdhaXQgcmVjb3JkQXNrVXNlclF1ZXN0aW9uc0dhdGVSZXN1bHQoc3RydWN0dXJlZCwgZGVwcyk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgY29udGVudDogW3sgdHlwZTogJ3RleHQnIGFzIGNvbnN0LCB0ZXh0OiBmb3JtYXRBc2tVc2VyUXVlc3Rpb25zRWxpY2l0UmVzdWx0KHF1ZXN0aW9ucywgZWxpY2l0YXRpb24pIH1dLFxuICAgICAgICAgIHN0cnVjdHVyZWRDb250ZW50OiBzdHJ1Y3R1cmVkIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWlzTG9jYWxFbGljaXRGYWxsYmFja0Vycm9yKGVycikpIHRocm93IGVycjtcbiAgICAgIGxvY2FsRWxpY2l0RXJyb3IgPSBlcnI7XG4gICAgICBjb25zb2xlLndhcm4oYFtnc2Q6bWNwXSBhc2tfdXNlcl9xdWVzdGlvbnMgbG9jYWwgZWxpY2l0YXRpb24gdW5hdmFpbGFibGU7IHRyeWluZyByZW1vdGUgZmFsbGJhY2s6ICR7Zm9ybWF0RXJyb3JNZXNzYWdlKGVycil9YCk7XG4gICAgfVxuXG4gICAgLy8gTG9jYWwgY2FuY2VsbGVkIC8gdW5hdmFpbGFibGUgXHUyMDE0IGZhbGwgYmFjayB0byB0aGUgY29uZmlndXJlZCByZW1vdGVcbiAgICAvLyBjaGFubmVsIChEaXNjb3JkLCBTbGFjaywgVGVsZWdyYW0pIGlmIG9uZSBpcyBzZXQuXG4gICAgaWYgKGRlcHMuaXNSZW1vdGVDb25maWd1cmVkKCkpIHtcbiAgICAgIGxldCByZW1vdGVSZXN1bHQ6IFJlbW90ZVRvb2xSZXN1bHQgfCBudWxsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVtb3RlUmVzdWx0ID0gYXdhaXQgZGVwcy50cnlSZW1vdGVRdWVzdGlvbnMocXVlc3Rpb25zLCBleHRyYT8uc2lnbmFsKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAobG9jYWxFbGljaXRFcnJvcikge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBMb2NhbCBlbGljaXRhdGlvbiBmYWlsZWQgKCR7Zm9ybWF0RXJyb3JNZXNzYWdlKGxvY2FsRWxpY2l0RXJyb3IpfSk7IHJlbW90ZSBmYWxsYmFjayBmYWlsZWQgKCR7Zm9ybWF0RXJyb3JNZXNzYWdlKGVycil9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9XG4gICAgICBpZiAocmVtb3RlUmVzdWx0KSB7XG4gICAgICAgIGNvbnN0IGRldGFpbHMgPSByZW1vdGVSZXN1bHQuZGV0YWlscyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKGRldGFpbHM/LlsndGltZWRfb3V0J10gfHwgZGV0YWlscz8uWydlcnJvciddKSB7XG4gICAgICAgICAgLy8gTWlycm9yIHRoZSB0aW1lb3V0L2Vycm9yIGludG8gc3RydWN0dXJlZENvbnRlbnQgc28gdGhlIGdhdGUgaG9vaydzXG4gICAgICAgICAgLy8gYGRldGFpbHM/LmNhbmNlbGxlZCB8fCAhZGV0YWlscz8ucmVzcG9uc2VgIGJyYW5jaCBmaXJlcyBjb3JyZWN0bHlcbiAgICAgICAgICAvLyAoZ2F0ZSBzdGF5cyBwZW5kaW5nLCBtb2RlbCByZS1hc2tzKSBpbnN0ZWFkIG9mIHNpbGVudGx5IGRyb3BwaW5nXG4gICAgICAgICAgLy8gYmVjYXVzZSBubyBgZGV0YWlsc2AgbWFkZSBpdCBhY3Jvc3MgdGhlIE1DUCB3aXJlLiBTZWUgIzUyNjcuXG4gICAgICAgICAgY29uc3QgZmFpbGVkU3RydWN0dXJlZDogQXNrVXNlclF1ZXN0aW9uc1N0cnVjdHVyZWRDb250ZW50ID0ge1xuICAgICAgICAgICAgcXVlc3Rpb25zLFxuICAgICAgICAgICAgcmVzcG9uc2U6IG51bGwsXG4gICAgICAgICAgICBjYW5jZWxsZWQ6IHRydWUsXG4gICAgICAgICAgfTtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgY29udGVudDogW3sgdHlwZTogJ3RleHQnIGFzIGNvbnN0LCB0ZXh0OiByZW1vdGVSZXN1bHQuY29udGVudFswXT8udGV4dCA/PyAnUmVtb3RlIHF1ZXN0aW9ucyB0aW1lZCBvdXQgb3IgZmFpbGVkJyB9XSxcbiAgICAgICAgICAgIHN0cnVjdHVyZWRDb250ZW50OiBmYWlsZWRTdHJ1Y3R1cmVkIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICAvLyBTdWNjZXNzZnVsIHJlbW90ZSBhbnN3ZXIgXHUyMDE0IHN1cmZhY2UgdGhlIG5vcm1hbGl6ZWQgUm91bmRSZXN1bHQgdGhhdFxuICAgICAgICAvLyByZW1vdGUtcXVlc3Rpb25zLnRzIGF0dGFjaGVkIHRvIGBkZXRhaWxzLnJlc3BvbnNlYCBzbyB0aGUgZ2F0ZSBob29rXG4gICAgICAgIC8vIHNlZXMgYGRldGFpbHMucmVzcG9uc2UuYW5zd2Vyc1tpZF0uc2VsZWN0ZWRgIG9uIHRoaXMgcGF0aCB0b28uXG4gICAgICAgIC8vIEEgbWFsZm9ybWVkIGByZXNwb25zZWAgKGZhaWxpbmcgaXNSb3VuZFJlc3VsdExpa2UpIGlzIHJlcG9ydGVkIGFzXG4gICAgICAgIC8vIGFuIGV4cGxpY2l0IGNhbmNlbGxhdGlvbiByYXRoZXIgdGhhbiBhIHNpbGVudCBgY2FuY2VsbGVkOiBmYWxzZWBcbiAgICAgICAgLy8gd2l0aCBgcmVzcG9uc2U6IG51bGxgIFx1MjAxNCB0aGUgbGF0dGVyIHdvdWxkIGxpZSB0byBhbnkgY29uc3VtZXIgdGhhdFxuICAgICAgICAvLyByZWFkcyBgc3RydWN0dXJlZENvbnRlbnQuY2FuY2VsbGVkYCBpbmRlcGVuZGVudGx5IG9mIGAucmVzcG9uc2VgLlxuICAgICAgICBjb25zdCBoYXNWYWxpZFJlc3BvbnNlID0gaXNSb3VuZFJlc3VsdExpa2UoZGV0YWlscz8uWydyZXNwb25zZSddKTtcbiAgICAgICAgY29uc3QgYWNjZXB0ZWRTdHJ1Y3R1cmVkOiBBc2tVc2VyUXVlc3Rpb25zU3RydWN0dXJlZENvbnRlbnQgPSBoYXNWYWxpZFJlc3BvbnNlXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICAgIHF1ZXN0aW9ucyxcbiAgICAgICAgICAgICAgcmVzcG9uc2U6IGRldGFpbHMhWydyZXNwb25zZSddIGFzIEFza1VzZXJRdWVzdGlvbnNSb3VuZFJlc3VsdCxcbiAgICAgICAgICAgICAgY2FuY2VsbGVkOiBmYWxzZSxcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDoge1xuICAgICAgICAgICAgICBxdWVzdGlvbnMsXG4gICAgICAgICAgICAgIHJlc3BvbnNlOiBudWxsLFxuICAgICAgICAgICAgICBjYW5jZWxsZWQ6IHRydWUsXG4gICAgICAgICAgICB9O1xuICAgICAgICBhd2FpdCByZWNvcmRBc2tVc2VyUXVlc3Rpb25zR2F0ZVJlc3VsdChhY2NlcHRlZFN0cnVjdHVyZWQsIGRlcHMpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6ICd0ZXh0JyBhcyBjb25zdCwgdGV4dDogcmVtb3RlUmVzdWx0LmNvbnRlbnRbMF0/LnRleHQgPz8gJycgfV0sXG4gICAgICAgICAgc3RydWN0dXJlZENvbnRlbnQ6IGFjY2VwdGVkU3RydWN0dXJlZCBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChsb2NhbEVsaWNpdEVycm9yKSB0aHJvdyBsb2NhbEVsaWNpdEVycm9yO1xuXG4gICAgY29uc3QgY2FuY2VsbGVkU3RydWN0dXJlZDogQXNrVXNlclF1ZXN0aW9uc1N0cnVjdHVyZWRDb250ZW50ID0ge1xuICAgICAgcXVlc3Rpb25zLFxuICAgICAgcmVzcG9uc2U6IG51bGwsXG4gICAgICBjYW5jZWxsZWQ6IHRydWUsXG4gICAgfTtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogJ3RleHQnIGFzIGNvbnN0LCB0ZXh0OiAnYXNrX3VzZXJfcXVlc3Rpb25zIHdhcyBjYW5jZWxsZWQgYmVmb3JlIHJlY2VpdmluZyBhIHJlc3BvbnNlJyB9XSxcbiAgICAgIHN0cnVjdHVyZWRDb250ZW50OiBjYW5jZWxsZWRTdHJ1Y3R1cmVkIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIGVycm9yQ29udGVudChlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikpO1xuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gc2VjdXJlX2Vudl9jb2xsZWN0IGhhbmRsZXIgKGV4dHJhY3RlZCBzbyB0ZXN0cyBjYW4gZHJpdmUgaXQgZGlyZWN0bHkpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZXhwb3J0IHR5cGUgRWxpY2l0SW5wdXRGbiA9IChwYXJhbXM6IHtcbiAgbWVzc2FnZTogc3RyaW5nO1xuICByZXF1ZXN0ZWRTY2hlbWE6IHsgdHlwZTogJ29iamVjdCc7IHByb3BlcnRpZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyByZXF1aXJlZDogc3RyaW5nW10gfTtcbn0pID0+IFByb21pc2U8eyBhY3Rpb246ICdhY2NlcHQnIHwgJ2NhbmNlbCcgfCAnZGVjbGluZSc7IGNvbnRlbnQ/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB9PjtcblxudHlwZSBUb29sQ29udGVudCA9XG4gIHwgeyBjb250ZW50OiBBcnJheTx7IHR5cGU6ICd0ZXh0JzsgdGV4dDogc3RyaW5nIH0+OyBzdHJ1Y3R1cmVkQ29udGVudD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH1cbiAgfCB7IGlzRXJyb3I6IHRydWU7IGNvbnRlbnQ6IEFycmF5PHsgdHlwZTogJ3RleHQnOyB0ZXh0OiBzdHJpbmcgfT47IHN0cnVjdHVyZWRDb250ZW50PzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfTtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNlY3VyZUVudkNvbGxlY3RIYW5kbGVyKFxuICBhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgZWxpY2l0SW5wdXQ6IEVsaWNpdElucHV0Rm4sXG4pOiBQcm9taXNlPFRvb2xDb250ZW50PiB7XG4gIGNvbnN0IHsgcHJvamVjdERpciwga2V5cywgZGVzdGluYXRpb24sIGVudkZpbGVQYXRoLCBlbnZpcm9ubWVudCB9ID0gYXJncyBhcyB7XG4gICAgcHJvamVjdERpcjogc3RyaW5nO1xuICAgIGtleXM6IEFycmF5PHsga2V5OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmc7IGd1aWRhbmNlPzogc3RyaW5nW10gfT47XG4gICAgZGVzdGluYXRpb24/OiAnZG90ZW52JyB8ICd2ZXJjZWwnIHwgJ2NvbnZleCc7XG4gICAgZW52RmlsZVBhdGg/OiBzdHJpbmc7XG4gICAgZW52aXJvbm1lbnQ/OiAnZGV2ZWxvcG1lbnQnIHwgJ3ByZXZpZXcnIHwgJ3Byb2R1Y3Rpb24nO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzb2x2ZWRQcm9qZWN0RGlyID0gdmFsaWRhdGVQcm9qZWN0RGlyKHByb2plY3REaXIpO1xuICAgIGNvbnN0IHJlc29sdmVkRW52UGF0aCA9IHJlc29sdmVQcm9qZWN0RW52RmlsZVBhdGgocmVzb2x2ZWRQcm9qZWN0RGlyLCBlbnZGaWxlUGF0aCA/PyAnLmVudicpO1xuXG4gICAgLy8gKDEpIENoZWNrIHdoaWNoIGtleXMgYWxyZWFkeSBleGlzdFxuICAgIGNvbnN0IGFsbEtleU5hbWVzID0ga2V5cy5tYXAoKGspID0+IGsua2V5KTtcbiAgICBjb25zdCBleGlzdGluZ0tleXMgPSBhd2FpdCBjaGVja0V4aXN0aW5nRW52S2V5cyhhbGxLZXlOYW1lcywgcmVzb2x2ZWRFbnZQYXRoKTtcbiAgICBjb25zdCBleGlzdGluZ1NldCA9IG5ldyBTZXQoZXhpc3RpbmdLZXlzKTtcbiAgICBjb25zdCBwZW5kaW5nS2V5cyA9IGtleXMuZmlsdGVyKChrKSA9PiAhZXhpc3RpbmdTZXQuaGFzKGsua2V5KSk7XG5cbiAgICAvLyBJZiBhbGwga2V5cyBhbHJlYWR5IGV4aXN0LCByZXR1cm4gaW1tZWRpYXRlbHlcbiAgICBpZiAocGVuZGluZ0tleXMubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb25zdCBsaW5lcyA9IGV4aXN0aW5nS2V5cy5tYXAoKGspID0+IGBcdTIwMjIgJHtrfTogYWxyZWFkeSBzZXRgKTtcbiAgICAgIHJldHVybiB0ZXh0Q29udGVudChgQWxsICR7ZXhpc3RpbmdLZXlzLmxlbmd0aH0ga2V5KHMpIGFscmVhZHkgc2V0LlxcbiR7bGluZXMuam9pbignXFxuJyl9YCk7XG4gICAgfVxuXG4gICAgLy8gKDIpIEJ1aWxkIGVsaWNpdGF0aW9uIGZvcm0gXHUyMDE0IG9uZSBzdHJpbmcgZmllbGQgcGVyIHBlbmRpbmcga2V5XG4gICAgY29uc3QgcHJvcGVydGllczogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+ID0ge307XG4gICAgY29uc3QgcmVxdWlyZWQ6IHN0cmluZ1tdID0gW107XG5cbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGVuZGluZ0tleXMpIHtcbiAgICAgIGNvbnN0IGRlc2NQYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICAgIGlmIChpdGVtLmhpbnQpIGRlc2NQYXJ0cy5wdXNoKGBGb3JtYXQ6ICR7aXRlbS5oaW50fWApO1xuICAgICAgaWYgKGl0ZW0uZ3VpZGFuY2UgJiYgaXRlbS5ndWlkYW5jZS5sZW5ndGggPiAwKSB7XG4gICAgICAgIGRlc2NQYXJ0cy5wdXNoKCdIb3cgdG8gZ2V0IHRoaXM6Jyk7XG4gICAgICAgIGl0ZW0uZ3VpZGFuY2UuZm9yRWFjaCgoc3RlcCwgaSkgPT4gZGVzY1BhcnRzLnB1c2goYCR7aSArIDF9LiAke3N0ZXB9YCkpO1xuICAgICAgfVxuICAgICAgZGVzY1BhcnRzLnB1c2goJ0xlYXZlIGVtcHR5IHRvIHNraXAuJyk7XG5cbiAgICAgIHByb3BlcnRpZXNbaXRlbS5rZXldID0ge1xuICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgdGl0bGU6IGl0ZW0ua2V5LFxuICAgICAgICBkZXNjcmlwdGlvbjogZGVzY1BhcnRzLmpvaW4oJ1xcbicpLFxuICAgICAgfTtcbiAgICAgIC8vIERvbid0IG1hcmsgYXMgcmVxdWlyZWQgXHUyMDE0IGVtcHR5IHN0cmluZyA9IHNraXBcbiAgICB9XG5cbiAgICAvLyAoMykgRWxpY2l0IGlucHV0IGZyb20gdGhlIE1DUCBjbGllbnRcbiAgICBjb25zdCBlbGljaXRhdGlvbiA9IGF3YWl0IHdpdGhFbGljaXRUaW1lb3V0KFxuICAgICAgZWxpY2l0SW5wdXQoe1xuICAgICAgICBtZXNzYWdlOiBgRW50ZXIgdmFsdWVzIGZvciAke3BlbmRpbmdLZXlzLmxlbmd0aH0gZW52aXJvbm1lbnQgdmFyaWFibGUocykuIFZhbHVlcyBhcmUgd3JpdHRlbiBkaXJlY3RseSB0byB0aGUgcHJvamVjdCBhbmQgbmV2ZXIgc2hvd24gdG8gdGhlIEFJLmAsXG4gICAgICAgIHJlcXVlc3RlZFNjaGVtYToge1xuICAgICAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgICAgIHByb3BlcnRpZXMsXG4gICAgICAgICAgcmVxdWlyZWQsXG4gICAgICAgIH0sXG4gICAgICB9KSxcbiAgICAgICdzZWN1cmVfZW52X2NvbGxlY3QnLFxuICAgICk7XG5cbiAgICBpZiAoZWxpY2l0YXRpb24uYWN0aW9uICE9PSAnYWNjZXB0JyB8fCAhZWxpY2l0YXRpb24uY29udGVudCkge1xuICAgICAgcmV0dXJuIHRleHRDb250ZW50KCdzZWN1cmVfZW52X2NvbGxlY3Qgd2FzIGNhbmNlbGxlZCBieSB1c2VyLicpO1xuICAgIH1cblxuICAgIC8vICg0KSBTZXBhcmF0ZSBwcm92aWRlZCB2cyBza2lwcGVkIGZyb20gZm9ybSByZXNwb25zZVxuICAgIGNvbnN0IHByb3ZpZGVkOiBBcnJheTx7IGtleTogc3RyaW5nOyB2YWx1ZTogc3RyaW5nIH0+ID0gW107XG4gICAgY29uc3Qgc2tpcHBlZDogc3RyaW5nW10gPSBbXTtcblxuICAgIGZvciAoY29uc3QgaXRlbSBvZiBwZW5kaW5nS2V5cykge1xuICAgICAgY29uc3QgcmF3ID0gZWxpY2l0YXRpb24uY29udGVudFtpdGVtLmtleV07XG4gICAgICBjb25zdCB2YWx1ZSA9IHR5cGVvZiByYXcgPT09ICdzdHJpbmcnID8gcmF3LnRyaW0oKSA6ICcnO1xuICAgICAgaWYgKHZhbHVlLmxlbmd0aCA+IDApIHtcbiAgICAgICAgcHJvdmlkZWQucHVzaCh7IGtleTogaXRlbS5rZXksIHZhbHVlIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2tpcHBlZC5wdXNoKGl0ZW0ua2V5KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAoNSkgQXV0by1kZXRlY3QgZGVzdGluYXRpb24gaWYgbm90IHNwZWNpZmllZFxuICAgIGNvbnN0IHJlc29sdmVkRGVzdGluYXRpb24gPSBkZXN0aW5hdGlvbiA/PyBkZXRlY3REZXN0aW5hdGlvbihyZXNvbHZlZFByb2plY3REaXIpO1xuXG4gICAgLy8gKDYpIFdyaXRlIHNlY3JldHMgdG8gZGVzdGluYXRpb25cbiAgICBjb25zdCB7IGFwcGxpZWQsIGVycm9ycyB9ID0gYXdhaXQgYXBwbHlTZWNyZXRzKHByb3ZpZGVkLCByZXNvbHZlZERlc3RpbmF0aW9uLCB7XG4gICAgICBlbnZGaWxlUGF0aDogcmVzb2x2ZWRFbnZQYXRoLFxuICAgICAgZW52aXJvbm1lbnQsXG4gICAgICBleGVjRm46IGRlZmF1bHRFeGVjRm4sXG4gICAgfSk7XG5cbiAgICAvLyAoNykgQnVpbGQgcmVzdWx0IFx1MjAxNCBORVZFUiBpbmNsdWRlIHNlY3JldCB2YWx1ZXNcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbXG4gICAgICBgZGVzdGluYXRpb246ICR7cmVzb2x2ZWREZXN0aW5hdGlvbn0keyFkZXN0aW5hdGlvbiA/ICcgKGF1dG8tZGV0ZWN0ZWQpJyA6ICcnfSR7ZW52aXJvbm1lbnQgPyBgICgke2Vudmlyb25tZW50fSlgIDogJyd9YCxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgayBvZiBhcHBsaWVkKSBsaW5lcy5wdXNoKGBcdTI3MTMgJHtrfTogYXBwbGllZGApO1xuICAgIGZvciAoY29uc3QgayBvZiBza2lwcGVkKSBsaW5lcy5wdXNoKGBcdTIwMjIgJHtrfTogc2tpcHBlZGApO1xuICAgIGZvciAoY29uc3QgayBvZiBleGlzdGluZ0tleXMpIGxpbmVzLnB1c2goYFx1MjAyMiAke2t9OiBhbHJlYWR5IHNldGApO1xuICAgIGZvciAoY29uc3QgZSBvZiBlcnJvcnMpIGxpbmVzLnB1c2goYFx1MjcxNyAke2V9YCk7XG5cbiAgICByZXR1cm4gZXJyb3JzLmxlbmd0aCA+IDAgJiYgYXBwbGllZC5sZW5ndGggPT09IDBcbiAgICAgID8gZXJyb3JDb250ZW50KGxpbmVzLmpvaW4oJ1xcbicpKVxuICAgICAgOiB0ZXh0Q29udGVudChsaW5lcy5qb2luKCdcXG4nKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiBlcnJvckNvbnRlbnQoZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpKTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGNyZWF0ZU1jcFNlcnZlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogQ3JlYXRlIGFuZCBjb25maWd1cmUgYW4gTUNQIHNlcnZlciB3aXRoIHNlc3Npb24sIHJlYWQtb25seSwgYW5kIHdvcmtmbG93IHRvb2xzLlxuICpcbiAqIFJldHVybnMgdGhlIE1jcFNlcnZlciBpbnN0YW5jZSBcdTIwMTQgY2FsbCBgY29ubmVjdCh0cmFuc3BvcnQpYCB0byBzdGFydCBzZXJ2aW5nLlxuICogVXNlcyBkeW5hbWljIGltcG9ydHMgZm9yIHRoZSBNQ1AgU0RLIHRvIGF2b2lkIFRTIHN1YnBhdGggcmVzb2x1dGlvbiBpc3N1ZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjcmVhdGVNY3BTZXJ2ZXIoXG4gIHNlc3Npb25NYW5hZ2VyOiBTZXNzaW9uTWFuYWdlcixcbik6IFByb21pc2U8e1xuICBzZXJ2ZXI6IE1jcFNlcnZlckluc3RhbmNlO1xufT4ge1xuICAvLyBEeW5hbWljIGltcG9ydCBcdTIwMTQgc2FtZSB3b3JrYXJvdW5kIGFzIHNyYy9tY3Atc2VydmVyLnRzXG4gIGNvbnN0IG1jcE1vZCA9IGF3YWl0IGltcG9ydChgJHtNQ1BfUEtHfS9zZXJ2ZXIvbWNwLmpzYCk7XG4gIGNvbnN0IE1jcFNlcnZlciA9IG1jcE1vZC5NY3BTZXJ2ZXIgYXMgbmV3IChcbiAgICBpbmZvOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0sXG4gICAgb3B0czogeyBjYXBhYmlsaXRpZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0sXG4gICkgPT4gTWNwU2VydmVySW5zdGFuY2U7XG5cbiAgY29uc3Qgc2VydmVyOiBNY3BTZXJ2ZXJJbnN0YW5jZSA9IG5ldyBNY3BTZXJ2ZXIoXG4gICAgeyBuYW1lOiBTRVJWRVJfTkFNRSwgdmVyc2lvbjogU0VSVkVSX1ZFUlNJT04gfSxcbiAgICB7IGNhcGFiaWxpdGllczogeyB0b29sczoge30sIGVsaWNpdGF0aW9uOiB7fSB9IH0sXG4gICk7XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gZ3NkX2V4ZWN1dGUgXHUyMDE0IHN0YXJ0IGEgbmV3IEdTRCBhdXRvLW1vZGUgc2Vzc2lvbi5cbiAgLy9cbiAgLy8gSWYgdGhlIEpTT04tUlBDIHJlcXVlc3QgaXMgYWJvcnRlZCB3aGlsZSB0aGUgc2Vzc2lvbiBpcyBzdGFydGluZyAob3JcbiAgLy8gaW1tZWRpYXRlbHkgYWZ0ZXIpLCB3ZSBjYW5jZWwgdGhlIHNlc3Npb24gc28gd2UgZG9uJ3QgbGVhayBhIGJhY2tncm91bmRcbiAgLy8gUnBjQ2xpZW50IHByb2Nlc3MuIE9uY2UgdGhlIHNlc3Npb24gaXMgcnVubmluZyB0aGUgY2FsbGVyIHNob3VsZCB1c2VcbiAgLy8gYGdzZF9jYW5jZWxgIHRvIHN0b3AgaXQgdmlhIHNlc3Npb25JZC5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgc2VydmVyLnRvb2woXG4gICAgJ2dzZF9leGVjdXRlJyxcbiAgICAnU3RhcnQgYSBHU0QgYXV0by1tb2RlIHNlc3Npb24gZm9yIGEgcHJvamVjdCBkaXJlY3RvcnkuIFJldHVybnMgYSBzZXNzaW9uSWQgZm9yIHRyYWNraW5nLicsXG4gICAge1xuICAgICAgcHJvamVjdERpcjogei5zdHJpbmcoKS5kZXNjcmliZSgnQWJzb2x1dGUgcGF0aCB0byB0aGUgcHJvamVjdCBkaXJlY3RvcnknKSxcbiAgICAgIGNvbW1hbmQ6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZSgnQ29tbWFuZCB0byBzZW5kIChkZWZhdWx0OiBcIi9nc2QgYXV0b1wiKScpLFxuICAgICAgbW9kZWw6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZSgnTW9kZWwgSUQgb3ZlcnJpZGUnKSxcbiAgICAgIGJhcmU6IHouYm9vbGVhbigpLm9wdGlvbmFsKCkuZGVzY3JpYmUoJ1J1biBpbiBiYXJlIG1vZGUgKHNraXAgdXNlciBjb25maWcpJyksXG4gICAgfSxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGV4dHJhPzogTWNwVG9vbEV4dHJhKSA9PiB7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIGNvbW1hbmQsIG1vZGVsLCBiYXJlIH0gPSBhcmdzIGFzIHtcbiAgICAgICAgcHJvamVjdERpcjogc3RyaW5nOyBjb21tYW5kPzogc3RyaW5nOyBtb2RlbD86IHN0cmluZzsgYmFyZT86IGJvb2xlYW47XG4gICAgICB9O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3Qgc2Vzc2lvbklkID0gYXdhaXQgc2Vzc2lvbk1hbmFnZXIuc3RhcnRTZXNzaW9uKHByb2plY3REaXIsIHsgY29tbWFuZCwgbW9kZWwsIGJhcmUgfSk7XG5cbiAgICAgICAgLy8gSWYgdGhlIGNsaWVudCBhYm9ydGVkIHdoaWxlIHN0YXJ0U2Vzc2lvbiB3YXMgcnVubmluZywgY2FuY2VsIHRoZVxuICAgICAgICAvLyBuZXdseS1jcmVhdGVkIHNlc3Npb24gcmF0aGVyIHRoYW4gbGVhdmluZyBhbiBvcnBoYW5lZCBwcm9jZXNzLlxuICAgICAgICBpZiAoZXh0cmE/LnNpZ25hbD8uYWJvcnRlZCkge1xuICAgICAgICAgIGF3YWl0IHNlc3Npb25NYW5hZ2VyLmNhbmNlbFNlc3Npb24oc2Vzc2lvbklkKS5jYXRjaCgoKSA9PiB7IC8qIHN3YWxsb3cgKi8gfSk7XG4gICAgICAgICAgcmV0dXJuIGVycm9yQ29udGVudCgnZ3NkX2V4ZWN1dGUgYWJvcnRlZCBieSBjbGllbnQgYmVmb3JlIHJldHVybmluZycpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGpzb25Db250ZW50KHsgc2Vzc2lvbklkLCBzdGF0dXM6ICdzdGFydGVkJyB9KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZXJyb3JDb250ZW50KGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSk7XG4gICAgICB9XG4gICAgfSxcbiAgKTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBnc2Rfc3RhdHVzIFx1MjAxNCBwb2xsIHNlc3Npb24gc3RhdHVzXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHNlcnZlci50b29sKFxuICAgICdnc2Rfc3RhdHVzJyxcbiAgICAnR2V0IHRoZSBjdXJyZW50IHN0YXR1cyBvZiBhIEdTRCBzZXNzaW9uIGluY2x1ZGluZyBwcm9ncmVzcywgcmVjZW50IGV2ZW50cywgYW5kIHBlbmRpbmcgYmxvY2tlcnMuJyxcbiAgICB7XG4gICAgICBzZXNzaW9uSWQ6IHouc3RyaW5nKCkuZGVzY3JpYmUoJ1Nlc3Npb24gSUQgcmV0dXJuZWQgZnJvbSBnc2RfZXhlY3V0ZScpLFxuICAgIH0sXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBjb25zdCB7IHNlc3Npb25JZCB9ID0gYXJncyBhcyB7IHNlc3Npb25JZDogc3RyaW5nIH07XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzZXNzaW9uID0gc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbihzZXNzaW9uSWQpO1xuICAgICAgICBpZiAoIXNlc3Npb24pIHJldHVybiBlcnJvckNvbnRlbnQoYFNlc3Npb24gbm90IGZvdW5kOiAke3Nlc3Npb25JZH1gKTtcblxuICAgICAgICBjb25zdCBkdXJhdGlvbk1zID0gRGF0ZS5ub3coKSAtIHNlc3Npb24uc3RhcnRUaW1lO1xuICAgICAgICBjb25zdCB0b29sQ2FsbENvdW50ID0gc2Vzc2lvbi5ldmVudHMuZmlsdGVyKFxuICAgICAgICAgIChlKSA9PiAoZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikudHlwZSA9PT0gJ3Rvb2xfdXNlJyB8fFxuICAgICAgICAgICAgICAgICAoZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikudHlwZSA9PT0gJ3Rvb2xfZXhlY3V0aW9uX3N0YXJ0J1xuICAgICAgICApLmxlbmd0aDtcblxuICAgICAgICByZXR1cm4ganNvbkNvbnRlbnQoe1xuICAgICAgICAgIHN0YXR1czogc2Vzc2lvbi5zdGF0dXMsXG4gICAgICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgICAgIGV2ZW50Q291bnQ6IHNlc3Npb24uZXZlbnRzLmxlbmd0aCxcbiAgICAgICAgICAgIHRvb2xDYWxsczogdG9vbENhbGxDb3VudCxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHJlY2VudEV2ZW50czogc2Vzc2lvbi5ldmVudHMuc2xpY2UoLTEwKSxcbiAgICAgICAgICBwZW5kaW5nQmxvY2tlcjogc2Vzc2lvbi5wZW5kaW5nQmxvY2tlclxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgaWQ6IHNlc3Npb24ucGVuZGluZ0Jsb2NrZXIuaWQsXG4gICAgICAgICAgICAgICAgbWV0aG9kOiBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLm1ldGhvZCxcbiAgICAgICAgICAgICAgICBtZXNzYWdlOiBzZXNzaW9uLnBlbmRpbmdCbG9ja2VyLm1lc3NhZ2UsXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgICBjb3N0OiBzZXNzaW9uLmNvc3QsXG4gICAgICAgICAgZHVyYXRpb25NcyxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGVycm9yQ29udGVudChlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikpO1xuICAgICAgfVxuICAgIH0sXG4gICk7XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gZ3NkX3Jlc3VsdCBcdTIwMTQgZ2V0IGFjY3VtdWxhdGVkIHNlc3Npb24gcmVzdWx0XG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHNlcnZlci50b29sKFxuICAgICdnc2RfcmVzdWx0JyxcbiAgICAnR2V0IHRoZSByZXN1bHQgb2YgYSBHU0Qgc2Vzc2lvbi4gUmV0dXJucyBwYXJ0aWFsIHJlc3VsdHMgaWYgdGhlIHNlc3Npb24gaXMgc3RpbGwgcnVubmluZy4nLFxuICAgIHtcbiAgICAgIHNlc3Npb25JZDogei5zdHJpbmcoKS5kZXNjcmliZSgnU2Vzc2lvbiBJRCByZXR1cm5lZCBmcm9tIGdzZF9leGVjdXRlJyksXG4gICAgfSxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHsgc2Vzc2lvbklkIH0gPSBhcmdzIGFzIHsgc2Vzc2lvbklkOiBzdHJpbmcgfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHNlc3Npb25NYW5hZ2VyLmdldFJlc3VsdChzZXNzaW9uSWQpO1xuICAgICAgICByZXR1cm4ganNvbkNvbnRlbnQocmVzdWx0KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZXJyb3JDb250ZW50KGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSk7XG4gICAgICB9XG4gICAgfSxcbiAgKTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBnc2RfY2FuY2VsIFx1MjAxNCBjYW5jZWwgYSBydW5uaW5nIHNlc3Npb25cbiAgLy9cbiAgLy8gU3VwcG9ydHMgdHdvIGxvb2t1cCBzdHJhdGVnaWVzOlxuICAvLyAgIDEuIHNlc3Npb25JZCAgXHUyMDE0IHRoZSBJRCByZXR1cm5lZCBmcm9tIGdzZF9leGVjdXRlIChwcmltYXJ5KVxuICAvLyAgIDIuIHByb2plY3REaXIgXHUyMDE0IGFic29sdXRlIHBhdGggdG8gdGhlIHByb2plY3QgZGlyZWN0b3J5IChmYWxsYmFjaylcbiAgLy9cbiAgLy8gVGhlIHByb2plY3REaXIgZmFsbGJhY2sgaGFuZGxlcyBpbnRlcmFjdGl2ZSBzZXNzaW9ucyAoc3RhcnRlZCB2aWFcbiAgLy8gYC9nc2QgYXV0b2AgaW4gdGhlIHRlcm1pbmFsKSBhbmQgcG9zdC1yZXN0YXJ0IE1DUCBzZXNzaW9ucyB0aGF0IHdlcmVcbiAgLy8gbmV2ZXIgcmVnaXN0ZXJlZCB3aXRoIGEgc2Vzc2lvbklkIGluIHRoaXMgc2VydmVyIGluc3RhbmNlLlxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBzZXJ2ZXIudG9vbChcbiAgICAnZ3NkX2NhbmNlbCcsXG4gICAgJ0NhbmNlbCBhIHJ1bm5pbmcgR1NEIHNlc3Npb24uIEFib3J0cyB0aGUgY3VycmVudCBvcGVyYXRpb24gYW5kIHN0b3BzIHRoZSBwcm9jZXNzLiBQcm92aWRlIHNlc3Npb25JZCAoZnJvbSBnc2RfZXhlY3V0ZSkgb3IgcHJvamVjdERpciBhcyBhIGZhbGxiYWNrIGZvciBpbnRlcmFjdGl2ZS9yZXN0YXJ0ZWQgc2Vzc2lvbnMuJyxcbiAgICB7XG4gICAgICBzZXNzaW9uSWQ6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZSgnU2Vzc2lvbiBJRCByZXR1cm5lZCBmcm9tIGdzZF9leGVjdXRlJyksXG4gICAgICBwcm9qZWN0RGlyOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoJ0Fic29sdXRlIHBhdGggdG8gdGhlIHByb2plY3QgZGlyZWN0b3J5IChmYWxsYmFjayB3aGVuIHNlc3Npb25JZCBpcyB1bmF2YWlsYWJsZSknKSxcbiAgICB9LFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgeyBzZXNzaW9uSWQsIHByb2plY3REaXIgfSA9IGFyZ3MgYXMgeyBzZXNzaW9uSWQ/OiBzdHJpbmc7IHByb2plY3REaXI/OiBzdHJpbmcgfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghc2Vzc2lvbklkICYmICFwcm9qZWN0RGlyKSB7XG4gICAgICAgICAgcmV0dXJuIGVycm9yQ29udGVudCgnRWl0aGVyIHNlc3Npb25JZCBvciBwcm9qZWN0RGlyIG11c3QgYmUgcHJvdmlkZWQnKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc2Vzc2lvbklkKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IHNlc3Npb25NYW5hZ2VyLmNhbmNlbFNlc3Npb24oc2Vzc2lvbklkKTtcbiAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIGlmICghcHJvamVjdERpciB8fCAhKGVyciBpbnN0YW5jZW9mIEVycm9yKSB8fCAhZXJyLm1lc3NhZ2UuaW5jbHVkZXMoJ1Nlc3Npb24gbm90IGZvdW5kJykpIHtcbiAgICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgYXdhaXQgc2Vzc2lvbk1hbmFnZXIuY2FuY2VsU2Vzc2lvbkJ5RGlyKHByb2plY3REaXIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChwcm9qZWN0RGlyKSB7XG4gICAgICAgICAgYXdhaXQgc2Vzc2lvbk1hbmFnZXIuY2FuY2VsU2Vzc2lvbkJ5RGlyKHByb2plY3REaXIpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBqc29uQ29udGVudCh7IGNhbmNlbGxlZDogdHJ1ZSB9KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZXJyb3JDb250ZW50KGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSk7XG4gICAgICB9XG4gICAgfSxcbiAgKTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBnc2RfcXVlcnkgXHUyMDE0IHJlYWQgcHJvamVjdCBzdGF0ZSBmcm9tIGZpbGVzeXN0ZW0gKG5vIHNlc3Npb24gbmVlZGVkKS5cbiAgLy9cbiAgLy8gYHF1ZXJ5YCBpcyBvcHRpb25hbDogd2hlbiBvbWl0dGVkIHRoZSB0b29sIHJldHVybnMgYWxsIGZpZWxkcyAoU1RBVEUubWQsXG4gIC8vIFBST0pFQ1QubWQsIHJlcXVpcmVtZW50cywgbWlsZXN0b25lIGxpc3RpbmcpLiBBY2NlcHRlZCBuYXJyb3cgdmFsdWVzOlxuICAvLyBcInN0YXRlXCIgLyBcInN0YXR1c1wiLCBcInByb2plY3RcIiwgXCJyZXF1aXJlbWVudHNcIiwgXCJtaWxlc3RvbmVzXCIsIFwiYWxsXCIuXG4gIC8vIFVua25vd24gdmFsdWVzIGZhbGwgYmFjayB0byBcImFsbFwiIGZvciBmb3J3YXJkLWNvbXBhdGliaWxpdHkuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHNlcnZlci50b29sKFxuICAgICdnc2RfcXVlcnknLFxuICAgICdRdWVyeSBHU0QgcHJvamVjdCBzdGF0ZSBmcm9tIHRoZSBmaWxlc3lzdGVtLiBCeSBkZWZhdWx0IHJldHVybnMgU1RBVEUubWQsIFBST0pFQ1QubWQsIHJlcXVpcmVtZW50cywgYW5kIG1pbGVzdG9uZSBsaXN0aW5nLiBQYXNzIGBxdWVyeWAgdG8gbmFycm93IHRoZSByZXNwb25zZSAoYWNjZXB0ZWQ6IFwic3RhdGVcIi9cInN0YXR1c1wiLCBcInByb2plY3RcIiwgXCJyZXF1aXJlbWVudHNcIiwgXCJtaWxlc3RvbmVzXCIsIFwiYWxsXCIpLiBEb2VzIG5vdCByZXF1aXJlIGFuIGFjdGl2ZSBzZXNzaW9uLicsXG4gICAge1xuICAgICAgcHJvamVjdERpcjogei5zdHJpbmcoKS5kZXNjcmliZSgnQWJzb2x1dGUgcGF0aCB0byB0aGUgcHJvamVjdCBkaXJlY3RvcnknKSxcbiAgICAgIHF1ZXJ5OiB6XG4gICAgICAgIC5lbnVtKFsnYWxsJywgJ3N0YXRlJywgJ3N0YXR1cycsICdwcm9qZWN0JywgJ3JlcXVpcmVtZW50cycsICdtaWxlc3RvbmVzJ10pXG4gICAgICAgIC5vcHRpb25hbCgpXG4gICAgICAgIC5kZXNjcmliZSgnTmFycm93IHRoZSByZXNwb25zZSB0byBhIHNpbmdsZSBmaWVsZCAoZGVmYXVsdDogXCJhbGxcIiknKSxcbiAgICB9LFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCBxdWVyeSB9ID0gYXJncyBhcyB7IHByb2plY3REaXI6IHN0cmluZzsgcXVlcnk/OiBzdHJpbmcgfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHZhbGlkYXRlZCA9IHZhbGlkYXRlUHJvamVjdERpcihwcm9qZWN0RGlyKTtcbiAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCByZWFkUHJvamVjdFN0YXRlKHZhbGlkYXRlZCwgcXVlcnkpO1xuICAgICAgICByZXR1cm4ganNvbkNvbnRlbnQoc3RhdGUpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHJldHVybiBlcnJvckNvbnRlbnQoZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpKTtcbiAgICAgIH1cbiAgICB9LFxuICApO1xuXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIC8vIGdzZF9yZXNvbHZlX2Jsb2NrZXIgXHUyMDE0IHJlc29sdmUgYSBwZW5kaW5nIGJsb2NrZXJcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgc2VydmVyLnRvb2woXG4gICAgJ2dzZF9yZXNvbHZlX2Jsb2NrZXInLFxuICAgICdSZXNvbHZlIGEgcGVuZGluZyBibG9ja2VyIGluIGEgR1NEIHNlc3Npb24gYnkgc2VuZGluZyBhIHJlc3BvbnNlIHRvIHRoZSBVSSByZXF1ZXN0LicsXG4gICAge1xuICAgICAgc2Vzc2lvbklkOiB6LnN0cmluZygpLmRlc2NyaWJlKCdTZXNzaW9uIElEIHJldHVybmVkIGZyb20gZ3NkX2V4ZWN1dGUnKSxcbiAgICAgIHJlc3BvbnNlOiB6LnN0cmluZygpLmRlc2NyaWJlKCdSZXNwb25zZSB0byBzZW5kIGZvciB0aGUgcGVuZGluZyBibG9ja2VyJyksXG4gICAgfSxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHsgc2Vzc2lvbklkLCByZXNwb25zZSB9ID0gYXJncyBhcyB7IHNlc3Npb25JZDogc3RyaW5nOyByZXNwb25zZTogc3RyaW5nIH07XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBzZXNzaW9uTWFuYWdlci5yZXNvbHZlQmxvY2tlcihzZXNzaW9uSWQsIHJlc3BvbnNlKTtcbiAgICAgICAgcmV0dXJuIGpzb25Db250ZW50KHsgcmVzb2x2ZWQ6IHRydWUgfSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGVycm9yQ29udGVudChlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikpO1xuICAgICAgfVxuICAgIH0sXG4gICk7XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gYXNrX3VzZXJfcXVlc3Rpb25zIFx1MjAxNCBzdHJ1Y3R1cmVkIHVzZXIgaW5wdXQgdmlhIE1DUCBmb3JtIGVsaWNpdGF0aW9uXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHNlcnZlci50b29sKFxuICAgICdhc2tfdXNlcl9xdWVzdGlvbnMnLFxuICAgICdSZXF1ZXN0IHVzZXIgaW5wdXQgZm9yIG9uZSB0byB0aHJlZSBzaG9ydCBxdWVzdGlvbnMgYW5kIHdhaXQgZm9yIHRoZSByZXNwb25zZS4gU2luZ2xlLXNlbGVjdCBxdWVzdGlvbnMgaW5jbHVkZSBhIGZyZWUtZm9ybSBcIk5vbmUgb2YgdGhlIGFib3ZlXCIgcGF0aC4gTXVsdGktc2VsZWN0IHF1ZXN0aW9ucyBhbGxvdyBtdWx0aXBsZSBjaG9pY2VzLicsXG4gICAge1xuICAgICAgcXVlc3Rpb25zOiB6LmFycmF5KHoub2JqZWN0KHtcbiAgICAgICAgaWQ6IHouc3RyaW5nKCkuZGVzY3JpYmUoJ1N0YWJsZSBpZGVudGlmaWVyIGZvciBtYXBwaW5nIGFuc3dlcnMgKHNuYWtlX2Nhc2UpJyksXG4gICAgICAgIGhlYWRlcjogei5zdHJpbmcoKS5kZXNjcmliZSgnU2hvcnQgaGVhZGVyIGxhYmVsIHNob3duIGluIHRoZSBVSSAoMTIgb3IgZmV3ZXIgY2hhcnMpJyksXG4gICAgICAgIHF1ZXN0aW9uOiB6LnN0cmluZygpLmRlc2NyaWJlKCdTaW5nbGUtc2VudGVuY2UgcHJvbXB0IHNob3duIHRvIHRoZSB1c2VyJyksXG4gICAgICAgIG9wdGlvbnM6IHouYXJyYXkoei5vYmplY3Qoe1xuICAgICAgICAgIGxhYmVsOiB6LnN0cmluZygpLmRlc2NyaWJlKCdVc2VyLWZhY2luZyBsYWJlbCAoMS01IHdvcmRzKScpLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiB6LnN0cmluZygpLmRlc2NyaWJlKCdPbmUgc2hvcnQgc2VudGVuY2UgZXhwbGFpbmluZyBpbXBhY3QvdHJhZGVvZmYgaWYgc2VsZWN0ZWQnKSxcbiAgICAgICAgfSkpLmRlc2NyaWJlKCdQcm92aWRlIDItMyBtdXR1YWxseSBleGNsdXNpdmUgY2hvaWNlcy4gUHV0IHRoZSByZWNvbW1lbmRlZCBvcHRpb24gZmlyc3QgYW5kIHN1ZmZpeCBpdHMgbGFiZWwgd2l0aCBcIihSZWNvbW1lbmRlZClcIi4gRG8gbm90IGluY2x1ZGUgYW4gXCJPdGhlclwiIG9wdGlvbiBmb3Igc2luZ2xlLXNlbGVjdCBxdWVzdGlvbnMuJyksXG4gICAgICAgIGFsbG93TXVsdGlwbGU6IHouYm9vbGVhbigpLm9wdGlvbmFsKCkuZGVzY3JpYmUoJ0lmIHRydWUsIHRoZSB1c2VyIGNhbiBzZWxlY3QgbXVsdGlwbGUgb3B0aW9ucy4gTm8gXCJOb25lIG9mIHRoZSBhYm92ZVwiIG9wdGlvbiBpcyBhZGRlZC4nKSxcbiAgICAgIH0pKS5kZXNjcmliZSgnUXVlc3Rpb25zIHRvIHNob3cgdGhlIHVzZXIuIFByZWZlciAxIGFuZCBkbyBub3QgZXhjZWVkIDMuJyksXG4gICAgfSxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGV4dHJhPzogTWNwVG9vbEV4dHJhKSA9PiB7XG4gICAgICBjb25zdCB7IHF1ZXN0aW9ucyB9ID0gYXJncyBhcyB1bmtub3duIGFzIEFza1VzZXJRdWVzdGlvbnNQYXJhbXM7XG4gICAgICByZXR1cm4gYXNrVXNlclF1ZXN0aW9uc0hhbmRsZXIocXVlc3Rpb25zLCBleHRyYSwge1xuICAgICAgICBlbGljaXRJbnB1dDogKHBhcmFtcykgPT4gc2VydmVyLnNlcnZlci5lbGljaXRJbnB1dChwYXJhbXMpLFxuICAgICAgICBpc1JlbW90ZUNvbmZpZ3VyZWQsXG4gICAgICAgIHRyeVJlbW90ZVF1ZXN0aW9ucyxcbiAgICAgIH0pO1xuICAgIH0sXG4gICk7XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gc2VjdXJlX2Vudl9jb2xsZWN0IFx1MjAxNCBjb2xsZWN0IHNlY3JldHMgdmlhIE1DUCBmb3JtIGVsaWNpdGF0aW9uXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHNlcnZlci50b29sKFxuICAgICdzZWN1cmVfZW52X2NvbGxlY3QnLFxuICAgICdDb2xsZWN0IGVudmlyb25tZW50IHZhcmlhYmxlcyBzZWN1cmVseSB2aWEgZm9ybSBpbnB1dC4gVmFsdWVzIGFyZSB3cml0dGVuIGRpcmVjdGx5IHRvIC5lbnYgKG9yIFZlcmNlbC9Db252ZXgpIGFuZCBORVZFUiBhcHBlYXIgaW4gdG9vbCBvdXRwdXQgXHUyMDE0IG9ubHkga2V5IG5hbWVzIGFuZCBhcHBsaWVkL3NraXBwZWQgc3RhdHVzIGFyZSByZXR1cm5lZC4gVXNlIHRoaXMgaW5zdGVhZCBvZiBhc2tpbmcgdXNlcnMgdG8gbWFudWFsbHkgZWRpdCAuZW52IGZpbGVzIG9yIHBhc3RlIHNlY3JldHMgaW50byBjaGF0LicsXG4gICAge1xuICAgICAgcHJvamVjdERpcjogei5zdHJpbmcoKS5kZXNjcmliZSgnQWJzb2x1dGUgcGF0aCB0byB0aGUgcHJvamVjdCBkaXJlY3RvcnknKSxcbiAgICAgIGtleXM6IHouYXJyYXkoei5vYmplY3Qoe1xuICAgICAgICBrZXk6IHouc3RyaW5nKCkuZGVzY3JpYmUoJ0VudiB2YXIgbmFtZSwgZS5nLiBPUEVOQUlfQVBJX0tFWScpLFxuICAgICAgICBoaW50OiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoJ0Zvcm1hdCBoaW50IHNob3duIHRvIHVzZXIsIGUuZy4gXCJzdGFydHMgd2l0aCBzay1cIicpLFxuICAgICAgICBndWlkYW5jZTogei5hcnJheSh6LnN0cmluZygpKS5vcHRpb25hbCgpLmRlc2NyaWJlKCdTdGVwLWJ5LXN0ZXAgaW5zdHJ1Y3Rpb25zIGZvciBvYnRhaW5pbmcgdGhpcyBrZXknKSxcbiAgICAgIH0pKS5taW4oMSkuZGVzY3JpYmUoJ0Vudmlyb25tZW50IHZhcmlhYmxlcyB0byBjb2xsZWN0JyksXG4gICAgICBkZXN0aW5hdGlvbjogei5lbnVtKFsnZG90ZW52JywgJ3ZlcmNlbCcsICdjb252ZXgnXSkub3B0aW9uYWwoKS5kZXNjcmliZSgnV2hlcmUgdG8gd3JpdGUgc2VjcmV0cy4gQXV0by1kZXRlY3RlZCBmcm9tIHByb2plY3QgZmlsZXMgaWYgb21pdHRlZC4nKSxcbiAgICAgIGVudkZpbGVQYXRoOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoJ1BhdGggdG8gLmVudiBmaWxlIChkb3RlbnYgb25seSkuIERlZmF1bHRzIHRvIC5lbnYgaW4gcHJvamVjdERpci4nKSxcbiAgICAgIGVudmlyb25tZW50OiB6LmVudW0oWydkZXZlbG9wbWVudCcsICdwcmV2aWV3JywgJ3Byb2R1Y3Rpb24nXSkub3B0aW9uYWwoKS5kZXNjcmliZSgnVGFyZ2V0IGVudmlyb25tZW50ICh2ZXJjZWwvY29udmV4IG9ubHkpJyksXG4gICAgfSxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+XG4gICAgICBzZWN1cmVFbnZDb2xsZWN0SGFuZGxlcihhcmdzLCAocGFyYW1zKSA9PlxuICAgICAgICBzZXJ2ZXIuc2VydmVyLmVsaWNpdElucHV0KHBhcmFtcyBhcyBFbGljaXRSZXF1ZXN0Rm9ybVBhcmFtcyksXG4gICAgICApLFxuICApO1xuXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG4gIC8vIFJFQUQtT05MWSBUT09MUyBcdTIwMTQgbm8gc2Vzc2lvbiByZXF1aXJlZCwgcHVyZSBmaWxlc3lzdGVtIHJlYWRzXG4gIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gZ3NkX3Byb2dyZXNzIFx1MjAxNCBzdHJ1Y3R1cmVkIHByb2plY3QgcHJvZ3Jlc3MgbWV0cmljc1xuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBzZXJ2ZXIudG9vbChcbiAgICAnZ3NkX3Byb2dyZXNzJyxcbiAgICAnR2V0IHN0cnVjdHVyZWQgcHJvamVjdCBwcm9ncmVzczogYWN0aXZlIG1pbGVzdG9uZS9zbGljZS90YXNrLCBwaGFzZSwgY29tcGxldGlvbiBjb3VudHMsIGJsb2NrZXJzLCBhbmQgbmV4dCBhY3Rpb24uIE5vIHNlc3Npb24gcmVxdWlyZWQgXHUyMDE0IHJlYWRzIGRpcmVjdGx5IGZyb20gLmdzZC8gb24gZGlzay4nLFxuICAgIHtcbiAgICAgIHByb2plY3REaXI6IHouc3RyaW5nKCkuZGVzY3JpYmUoJ0Fic29sdXRlIHBhdGggdG8gdGhlIHByb2plY3QgZGlyZWN0b3J5JyksXG4gICAgfSxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciB9ID0gYXJncyBhcyB7IHByb2plY3REaXI6IHN0cmluZyB9O1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGpzb25Db250ZW50KHJlYWRQcm9ncmVzcyh2YWxpZGF0ZVByb2plY3REaXIocHJvamVjdERpcikpKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZXJyb3JDb250ZW50KGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSk7XG4gICAgICB9XG4gICAgfSxcbiAgKTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBnc2Rfcm9hZG1hcCBcdTIwMTQgbWlsZXN0b25lL3NsaWNlL3Rhc2sgc3RydWN0dXJlIHdpdGggc3RhdHVzXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHNlcnZlci50b29sKFxuICAgICdnc2Rfcm9hZG1hcCcsXG4gICAgJ0dldCB0aGUgZnVsbCBwcm9qZWN0IHJvYWRtYXAgc3RydWN0dXJlOiBtaWxlc3RvbmVzIHdpdGggdGhlaXIgc2xpY2VzLCB0YXNrcywgc3RhdHVzLCByaXNrLCBhbmQgZGVwZW5kZW5jaWVzLiBPcHRpb25hbGx5IGZpbHRlciB0byBhIHNpbmdsZSBtaWxlc3RvbmUuIE5vIHNlc3Npb24gcmVxdWlyZWQuJyxcbiAgICB7XG4gICAgICBwcm9qZWN0RGlyOiB6LnN0cmluZygpLmRlc2NyaWJlKCdBYnNvbHV0ZSBwYXRoIHRvIHRoZSBwcm9qZWN0IGRpcmVjdG9yeScpLFxuICAgICAgbWlsZXN0b25lSWQ6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZSgnRmlsdGVyIHRvIGEgc3BlY2lmaWMgbWlsZXN0b25lIChlLmcuIFwiTTAwMVwiKScpLFxuICAgIH0sXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIG1pbGVzdG9uZUlkIH0gPSBhcmdzIGFzIHsgcHJvamVjdERpcjogc3RyaW5nOyBtaWxlc3RvbmVJZD86IHN0cmluZyB9O1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGpzb25Db250ZW50KHJlYWRSb2FkbWFwKHZhbGlkYXRlUHJvamVjdERpcihwcm9qZWN0RGlyKSwgbWlsZXN0b25lSWQpKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZXJyb3JDb250ZW50KGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSk7XG4gICAgICB9XG4gICAgfSxcbiAgKTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBnc2RfaGlzdG9yeSBcdTIwMTQgZXhlY3V0aW9uIGhpc3Rvcnkgd2l0aCBjb3N0L3Rva2VuIG1ldHJpY3NcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgc2VydmVyLnRvb2woXG4gICAgJ2dzZF9oaXN0b3J5JyxcbiAgICAnR2V0IGV4ZWN1dGlvbiBoaXN0b3J5IHdpdGggY29zdCwgdG9rZW4gdXNhZ2UsIG1vZGVsLCBhbmQgZHVyYXRpb24gcGVyIHVuaXQuIFJldHVybnMgdG90YWxzIGFjcm9zcyBhbGwgdW5pdHMuIE5vIHNlc3Npb24gcmVxdWlyZWQuJyxcbiAgICB7XG4gICAgICBwcm9qZWN0RGlyOiB6LnN0cmluZygpLmRlc2NyaWJlKCdBYnNvbHV0ZSBwYXRoIHRvIHRoZSBwcm9qZWN0IGRpcmVjdG9yeScpLFxuICAgICAgbGltaXQ6IHoubnVtYmVyKCkub3B0aW9uYWwoKS5kZXNjcmliZSgnTWF4IGVudHJpZXMgdG8gcmV0dXJuIChtb3N0IHJlY2VudCBmaXJzdCkuIERlZmF1bHQ6IGFsbC4nKSxcbiAgICB9LFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCBsaW1pdCB9ID0gYXJncyBhcyB7IHByb2plY3REaXI6IHN0cmluZzsgbGltaXQ/OiBudW1iZXIgfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBqc29uQ29udGVudChyZWFkSGlzdG9yeSh2YWxpZGF0ZVByb2plY3REaXIocHJvamVjdERpciksIGxpbWl0KSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGVycm9yQ29udGVudChlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikpO1xuICAgICAgfVxuICAgIH0sXG4gICk7XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gZ3NkX2RvY3RvciBcdTIwMTQgbGlnaHR3ZWlnaHQgc3RydWN0dXJhbCBoZWFsdGggY2hlY2tcbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgc2VydmVyLnRvb2woXG4gICAgJ2dzZF9kb2N0b3InLFxuICAgICdSdW4gYSBsaWdodHdlaWdodCBzdHJ1Y3R1cmFsIGhlYWx0aCBjaGVjayBvbiB0aGUgLmdzZC8gZGlyZWN0b3J5LiBDaGVja3MgZm9yIG1pc3NpbmcgZmlsZXMsIHN0YXR1cyBpbmNvbnNpc3RlbmNpZXMsIGFuZCBvcnBoYW5lZCBzdGF0ZS4gTm8gc2Vzc2lvbiByZXF1aXJlZC4nLFxuICAgIHtcbiAgICAgIHByb2plY3REaXI6IHouc3RyaW5nKCkuZGVzY3JpYmUoJ0Fic29sdXRlIHBhdGggdG8gdGhlIHByb2plY3QgZGlyZWN0b3J5JyksXG4gICAgICBzY29wZTogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKCdMaW1pdCBjaGVja3MgdG8gYSBzcGVjaWZpYyBtaWxlc3RvbmUgKGUuZy4gXCJNMDAxXCIpJyksXG4gICAgfSxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgc2NvcGUgfSA9IGFyZ3MgYXMgeyBwcm9qZWN0RGlyOiBzdHJpbmc7IHNjb3BlPzogc3RyaW5nIH07XG4gICAgICB0cnkge1xuICAgICAgICByZXR1cm4ganNvbkNvbnRlbnQocnVuRG9jdG9yTGl0ZSh2YWxpZGF0ZVByb2plY3REaXIocHJvamVjdERpciksIHNjb3BlKSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgcmV0dXJuIGVycm9yQ29udGVudChlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycikpO1xuICAgICAgfVxuICAgIH0sXG4gICk7XG5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgLy8gZ3NkX2NhcHR1cmVzIFx1MjAxNCBwZW5kaW5nIGNhcHR1cmVzIGFuZCBpZGVhc1xuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICBzZXJ2ZXIudG9vbChcbiAgICAnZ3NkX2NhcHR1cmVzJyxcbiAgICAnR2V0IGNhcHR1cmVkIGlkZWFzIGFuZCB0aG91Z2h0cyBmcm9tIENBUFRVUkVTLm1kIHdpdGggdHJpYWdlIHN0YXR1cy4gRmlsdGVyIGJ5IHBlbmRpbmcsIGFjdGlvbmFibGUsIG9yIGFsbC4gTm8gc2Vzc2lvbiByZXF1aXJlZC4nLFxuICAgIHtcbiAgICAgIHByb2plY3REaXI6IHouc3RyaW5nKCkuZGVzY3JpYmUoJ0Fic29sdXRlIHBhdGggdG8gdGhlIHByb2plY3QgZGlyZWN0b3J5JyksXG4gICAgICBmaWx0ZXI6IHouZW51bShbJ2FsbCcsICdwZW5kaW5nJywgJ2FjdGlvbmFibGUnXSkub3B0aW9uYWwoKS5kZXNjcmliZSgnRmlsdGVyIGNhcHR1cmVzIChkZWZhdWx0OiBcImFsbFwiKScpLFxuICAgIH0sXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIGZpbHRlciB9ID0gYXJncyBhcyB7IHByb2plY3REaXI6IHN0cmluZzsgZmlsdGVyPzogJ2FsbCcgfCAncGVuZGluZycgfCAnYWN0aW9uYWJsZScgfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBqc29uQ29udGVudChyZWFkQ2FwdHVyZXModmFsaWRhdGVQcm9qZWN0RGlyKHByb2plY3REaXIpLCBmaWx0ZXIgPz8gJ2FsbCcpKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZXJyb3JDb250ZW50KGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSk7XG4gICAgICB9XG4gICAgfSxcbiAgKTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBnc2Rfa25vd2xlZGdlIFx1MjAxNCBwcm9qZWN0IGtub3dsZWRnZSBiYXNlXG4gIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gIHNlcnZlci50b29sKFxuICAgICdnc2Rfa25vd2xlZGdlJyxcbiAgICAnR2V0IHRoZSBwcm9qZWN0IGtub3dsZWRnZSBiYXNlOiBydWxlcywgcGF0dGVybnMsIGFuZCBsZXNzb25zIGxlYXJuZWQgYWNjdW11bGF0ZWQgZHVyaW5nIGRldmVsb3BtZW50LiBObyBzZXNzaW9uIHJlcXVpcmVkLicsXG4gICAge1xuICAgICAgcHJvamVjdERpcjogei5zdHJpbmcoKS5kZXNjcmliZSgnQWJzb2x1dGUgcGF0aCB0byB0aGUgcHJvamVjdCBkaXJlY3RvcnknKSxcbiAgICB9LFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyIH0gPSBhcmdzIGFzIHsgcHJvamVjdERpcjogc3RyaW5nIH07XG4gICAgICB0cnkge1xuICAgICAgICByZXR1cm4ganNvbkNvbnRlbnQocmVhZEtub3dsZWRnZSh2YWxpZGF0ZVByb2plY3REaXIocHJvamVjdERpcikpKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZXJyb3JDb250ZW50KGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSk7XG4gICAgICB9XG4gICAgfSxcbiAgKTtcblxuICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAvLyBnc2RfZ3JhcGggXHUyMDE0IGtub3dsZWRnZSBncmFwaCBmb3IgR1NEIHByb2plY3RzXG4gIC8vXG4gIC8vIE1vZGVzOlxuICAvLyAgIGJ1aWxkICAgUGFyc2UgLmdzZC8gYXJ0aWZhY3RzIGFuZCB3cml0ZSBncmFwaC5qc29uIGF0b21pY2FsbHkuXG4gIC8vICAgcXVlcnkgICBTZWFyY2ggdGhlIGdyYXBoIGZvciBub2RlcyBtYXRjaGluZyBhIHRlcm0gKEJGUywgYnVkZ2V0LXRyaW1tZWQpLlxuICAvLyAgIHN0YXR1cyAgQ2hlY2sgd2hldGhlciBncmFwaC5qc29uIGV4aXN0cyBhbmQgd2hldGhlciBpdCBpcyBzdGFsZSAoPjI0aCkuXG4gIC8vICAgZGlmZiAgICBDb21wYXJlIGdyYXBoLmpzb24gd2l0aCB0aGUgbGFzdCBidWlsZCBzbmFwc2hvdC5cbiAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgc2VydmVyLnRvb2woXG4gICAgJ2dzZF9ncmFwaCcsXG4gICAgW1xuICAgICAgJ01hbmFnZSB0aGUgR1NEIHByb2plY3Qga25vd2xlZGdlIGdyYXBoLiBObyBzZXNzaW9uIHJlcXVpcmVkLicsXG4gICAgICAnJyxcbiAgICAgICdNb2RlczonLFxuICAgICAgJyAgYnVpbGQgICBQYXJzZSAuZ3NkLyBhcnRpZmFjdHMgKFNUQVRFLm1kLCBtaWxlc3RvbmUgUk9BRE1BUHMsIHNsaWNlIFBMQU5zLCcsXG4gICAgICAnICAgICAgICAgIEtOT1dMRURHRS5tZCkgYW5kIHdyaXRlIC5nc2QvZ3JhcGhzL2dyYXBoLmpzb24gYXRvbWljYWxseS4nLFxuICAgICAgJyAgcXVlcnkgICBTZWFyY2ggZ3JhcGggbm9kZXMgYnkgdGVybSAoQkZTIGZyb20gc2VlZCBtYXRjaGVzLCBidWRnZXQtdHJpbW1lZCkuJyxcbiAgICAgICcgICAgICAgICAgUmV0dXJucyBtYXRjaGluZyBub2RlcyBhbmQgcmVhY2hhYmxlIGVkZ2VzIHdpdGhpbiB0aGUgdG9rZW4gYnVkZ2V0LicsXG4gICAgICAnICBzdGF0dXMgIFNob3cgd2hldGhlciBncmFwaC5qc29uIGV4aXN0cywgaXRzIGFnZSwgbm9kZS9lZGdlIGNvdW50cywgYW5kJyxcbiAgICAgICcgICAgICAgICAgd2hldGhlciBpdCBpcyBzdGFsZSAoYnVpbHQgbW9yZSB0aGFuIDI0IGhvdXJzIGFnbykuJyxcbiAgICAgICcgIGRpZmYgICAgQ29tcGFyZSBjdXJyZW50IGdyYXBoLmpzb24gd2l0aCAubGFzdC1idWlsZC1zbmFwc2hvdC5qc29uLicsXG4gICAgICAnICAgICAgICAgIFJldHVybnMgYWRkZWQsIHJlbW92ZWQsIGFuZCBjaGFuZ2VkIG5vZGVzIGFuZCBlZGdlcy4nLFxuICAgIF0uam9pbignXFxuJyksXG4gICAge1xuICAgICAgcHJvamVjdERpcjogei5zdHJpbmcoKS5kZXNjcmliZSgnQWJzb2x1dGUgcGF0aCB0byB0aGUgcHJvamVjdCBkaXJlY3RvcnknKSxcbiAgICAgIG1vZGU6IHouZW51bShbJ2J1aWxkJywgJ3F1ZXJ5JywgJ3N0YXR1cycsICdkaWZmJ10pLmRlc2NyaWJlKFxuICAgICAgICAnT3BlcmF0aW9uOiBidWlsZCB8IHF1ZXJ5IHwgc3RhdHVzIHwgZGlmZicsXG4gICAgICApLFxuICAgICAgdGVybTogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKCdTZWFyY2ggdGVybSBmb3IgcXVlcnkgbW9kZSAoY2FzZS1pbnNlbnNpdGl2ZSknKSxcbiAgICAgIGJ1ZGdldDogei5udW1iZXIoKS5vcHRpb25hbCgpLmRlc2NyaWJlKCdUb2tlbiBidWRnZXQgZm9yIHF1ZXJ5IG1vZGUgKGRlZmF1bHQ6IDQwMDApJyksXG4gICAgICBzbmFwc2hvdDogei5ib29sZWFuKCkub3B0aW9uYWwoKS5kZXNjcmliZSgnV3JpdGUgc25hcHNob3QgYmVmb3JlIGJ1aWxkIChmb3IgZnV0dXJlIGRpZmYpJyksXG4gICAgfSxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpcjogcmF3UHJvamVjdERpciwgbW9kZSwgdGVybSwgYnVkZ2V0LCBzbmFwc2hvdCB9ID0gYXJncyBhcyB7XG4gICAgICAgIHByb2plY3REaXI6IHN0cmluZztcbiAgICAgICAgbW9kZTogJ2J1aWxkJyB8ICdxdWVyeScgfCAnc3RhdHVzJyB8ICdkaWZmJztcbiAgICAgICAgdGVybT86IHN0cmluZztcbiAgICAgICAgYnVkZ2V0PzogbnVtYmVyO1xuICAgICAgICBzbmFwc2hvdD86IGJvb2xlYW47XG4gICAgICB9O1xuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBwcm9qZWN0RGlyID0gdmFsaWRhdGVQcm9qZWN0RGlyKHJhd1Byb2plY3REaXIpO1xuICAgICAgICBjb25zdCBnc2RSb290ID0gcmVzb2x2ZUdzZFJvb3QocHJvamVjdERpcik7XG5cbiAgICAgICAgc3dpdGNoIChtb2RlKSB7XG4gICAgICAgICAgY2FzZSAnYnVpbGQnOiB7XG4gICAgICAgICAgICBpZiAoc25hcHNob3QpIHtcbiAgICAgICAgICAgICAgYXdhaXQgd3JpdGVTbmFwc2hvdChnc2RSb290KS5jYXRjaCgoKSA9PiB7IC8qIGJlc3QtZWZmb3J0ICovIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgZ3JhcGggPSBhd2FpdCBidWlsZEdyYXBoKHByb2plY3REaXIpO1xuICAgICAgICAgICAgYXdhaXQgd3JpdGVHcmFwaChnc2RSb290LCBncmFwaCk7XG4gICAgICAgICAgICByZXR1cm4ganNvbkNvbnRlbnQoe1xuICAgICAgICAgICAgICBidWlsdDogdHJ1ZSxcbiAgICAgICAgICAgICAgbm9kZUNvdW50OiBncmFwaC5ub2Rlcy5sZW5ndGgsXG4gICAgICAgICAgICAgIGVkZ2VDb3VudDogZ3JhcGguZWRnZXMubGVuZ3RoLFxuICAgICAgICAgICAgICBidWlsdEF0OiBncmFwaC5idWlsdEF0LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY2FzZSAncXVlcnknOiB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaFF1ZXJ5KHByb2plY3REaXIsIHRlcm0gPz8gJycsIGJ1ZGdldCk7XG4gICAgICAgICAgICByZXR1cm4ganNvbkNvbnRlbnQocmVzdWx0KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjYXNlICdzdGF0dXMnOiB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaFN0YXR1cyhwcm9qZWN0RGlyKTtcbiAgICAgICAgICAgIHJldHVybiBqc29uQ29udGVudChyZXN1bHQpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNhc2UgJ2RpZmYnOiB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaERpZmYocHJvamVjdERpcik7XG4gICAgICAgICAgICByZXR1cm4ganNvbkNvbnRlbnQocmVzdWx0KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4gZXJyb3JDb250ZW50KGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSk7XG4gICAgICB9XG4gICAgfSxcbiAgKTtcblxuICByZWdpc3RlcldvcmtmbG93VG9vbHMoc2VydmVyKTtcblxuICByZXR1cm4geyBzZXJ2ZXIgfTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWFBLFNBQVMsVUFBVSxlQUFlO0FBQ2xDLFNBQVMsTUFBTSxlQUFlO0FBQzlCLFNBQVMsYUFBYTtBQUN0QixTQUFTLHFCQUFxQjtBQUM5QixTQUFTLHFCQUFxQjtBQUM5QixTQUFTLFNBQVM7QUFFbEIsU0FBUyxvQkFBb0IsMEJBQTBCO0FBRXZELFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsb0JBQW9CO0FB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
