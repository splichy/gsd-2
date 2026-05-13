import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { WORKFLOW_TOOL_NAMES as CONTRACT_WORKFLOW_TOOL_NAMES } from "@gsd-build/contracts";
import { logAliasUsage } from "./alias-telemetry.js";
let workflowToolExecutorsPromise = null;
let workflowExecutionQueue = Promise.resolve();
let workflowWriteGatePromise = null;
function getAllowedProjectRoot(env = process.env) {
  const configuredRoot = env.GSD_WORKFLOW_PROJECT_ROOT?.trim();
  return configuredRoot ? resolve(configuredRoot) : null;
}
function isWithinRoot(candidatePath, rootPath) {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function resolveExternalStateRoot(allowedRoot) {
  try {
    return realpathSync(join(allowedRoot, ".gsd"));
  } catch {
    return null;
  }
}
function validateProjectDir(projectDir, env = process.env) {
  if (!isAbsolute(projectDir)) {
    throw new Error(`projectDir must be an absolute path. Received: ${projectDir}`);
  }
  const lexicallyResolved = resolve(projectDir);
  const resolvedProjectDir = safeRealpath(lexicallyResolved);
  const allowedRoot = getAllowedProjectRoot(env);
  if (!allowedRoot) return resolvedProjectDir;
  const resolvedAllowedRoot = safeRealpath(allowedRoot);
  if (isWithinRoot(resolvedProjectDir, resolvedAllowedRoot)) return resolvedProjectDir;
  const externalRoot = resolveExternalStateRoot(resolvedAllowedRoot);
  if (externalRoot && isWithinRoot(resolvedProjectDir, externalRoot)) {
    return resolvedProjectDir;
  }
  throw new Error(
    `projectDir must stay within the configured workflow project root. Received: ${resolvedProjectDir}; allowed root: ${resolvedAllowedRoot}`
  );
}
function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch (err) {
    if (err?.code === "ENOENT") return path;
    throw err;
  }
}
function parseToolArgs(schema, args) {
  return schema.parse(args);
}
function extractMilestoneId(parsed) {
  const candidates = [parsed.milestoneId, parsed.milestone_id, parsed.mid];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return null;
}
function resolveActiveWorktreeBasePath(projectRoot, milestoneId) {
  if (!milestoneId) return null;
  const wtPath = join(projectRoot, ".gsd", "worktrees", milestoneId);
  if (!existsSync(wtPath)) return null;
  if (!existsSync(join(wtPath, ".git"))) return null;
  return wtPath;
}
function resolveSoleActiveWorktree(projectRoot) {
  const worktreesDir = join(projectRoot, ".gsd", "worktrees");
  if (!existsSync(worktreesDir)) return null;
  let entries;
  try {
    entries = readdirSync(worktreesDir);
  } catch {
    return null;
  }
  const live = entries.map((name) => join(worktreesDir, name)).filter((p) => existsSync(join(p, ".git")));
  if (live.length !== 1) return null;
  return live[0];
}
function isHomeDirectory(candidate) {
  let resolvedHome;
  try {
    resolvedHome = realpathSync(resolve(homedir()));
  } catch {
    resolvedHome = resolve(homedir());
  }
  let resolvedCandidate;
  try {
    resolvedCandidate = realpathSync(resolve(candidate));
  } catch {
    resolvedCandidate = resolve(candidate);
  }
  return resolvedCandidate === resolvedHome;
}
function _parseWorkflowArgsForTest(schema, args) {
  return parseWorkflowArgs(schema, args);
}
function parseWorkflowArgs(schema, args) {
  const parsed = parseToolArgs(schema, args);
  const projectRootCandidate = parsed.projectDir ?? process.cwd();
  if (isHomeDirectory(projectRootCandidate)) {
    throw new Error(
      `projectDir resolves to the user's home directory (${projectRootCandidate}). Run the workflow tool from inside a project directory, or pass an explicit projectDir.`
    );
  }
  const projectRoot = validateProjectDir(projectRootCandidate);
  const milestoneId = extractMilestoneId(parsed);
  const worktreeBasePath = resolveActiveWorktreeBasePath(projectRoot, milestoneId) ?? (milestoneId ? null : resolveSoleActiveWorktree(projectRoot));
  const effectiveBasePath = worktreeBasePath ?? projectRoot;
  return {
    ...parsed,
    projectDir: effectiveBasePath
  };
}
function isWorkflowToolExecutors(value) {
  if (!value || typeof value !== "object") return false;
  const record = value;
  const functionExports = [
    "executeMilestoneStatus",
    "executePlanMilestone",
    "executePlanSlice",
    "executeReplanSlice",
    "executeSliceComplete",
    "executeCompleteMilestone",
    "executeValidateMilestone",
    "executeReassessRoadmap",
    "executeSaveGateResult",
    "executeSummarySave",
    "executeTaskComplete",
    "executeTaskReopen",
    "executeSliceReopen",
    "executeMilestoneReopen"
  ];
  return Array.isArray(record.SUPPORTED_SUMMARY_ARTIFACT_TYPES) && functionExports.every((key) => typeof record[key] === "function");
}
function getSupportedSummaryArtifactTypes(executors) {
  return executors.SUPPORTED_SUMMARY_ARTIFACT_TYPES;
}
function buildImportCandidates(relativePath) {
  const candidates = [];
  const pushPreferredPair = (path) => {
    if (!path) return;
    if (path.endsWith(".js")) candidates.push(path.replace(/\.js$/, ".ts"));
    candidates.push(path);
  };
  const sourcePath = relativePath.includes("/dist/") ? relativePath.replace("/dist/", "/src/") : relativePath;
  const distPath = relativePath.includes("/src/") ? relativePath.replace("/src/", "/dist/") : relativePath.includes("/dist/") ? relativePath : null;
  pushPreferredPair(sourcePath);
  pushPreferredPair(distPath);
  return [...new Set(candidates)];
}
function getWriteGateModuleCandidates() {
  const candidates = [];
  const explicitModule = process.env.GSD_WORKFLOW_WRITE_GATE_MODULE?.trim();
  if (explicitModule) {
    if (/^[a-z]{2,}:/i.test(explicitModule) && !explicitModule.startsWith("file:")) {
      throw new Error("GSD_WORKFLOW_WRITE_GATE_MODULE only supports file: URLs or filesystem paths.");
    }
    warnCustomWorkflowModule("GSD_WORKFLOW_WRITE_GATE_MODULE", explicitModule);
    candidates.push(explicitModule.startsWith("file:") ? explicitModule : toFileUrl(explicitModule));
  }
  candidates.push(
    ...buildImportCandidates("../../../src/resources/extensions/gsd/bootstrap/write-gate.js").map((p) => new URL(p, import.meta.url).href)
  );
  return [...new Set(candidates)];
}
function toFileUrl(modulePath) {
  return pathToFileURL(resolve(modulePath)).href;
}
const warnedCustomWorkflowModuleVars = /* @__PURE__ */ new Set();
function warnCustomWorkflowModule(varName, value) {
  if (warnedCustomWorkflowModuleVars.has(varName)) return;
  warnedCustomWorkflowModuleVars.add(varName);
  process.stderr.write(
    `[gsd-mcp-server] WARNING: ${varName} is set (${value}). Custom workflow modules will be loaded from this path. Unset for production use.
`
  );
}
function _buildImportCandidates(relativePath) {
  return buildImportCandidates(relativePath);
}
async function importLocalModule(relativePath) {
  const rawCandidates = _buildImportCandidates(relativePath);
  const candidates = (import.meta.url.includes("/dist-test/") || import.meta.url.includes("\\dist-test\\") ? [...rawCandidates].sort((a, b) => Number(a.endsWith(".ts")) - Number(b.endsWith(".ts"))) : rawCandidates).map((p) => new URL(p, import.meta.url).href);
  let lastErr;
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
async function loadProjectPreferences(projectDir) {
  const { loadEffectiveGSDPreferences } = await importLocalModule(
    "../../../src/resources/extensions/gsd/preferences.js"
  );
  try {
    return loadEffectiveGSDPreferences(projectDir).preferences;
  } catch {
    return null;
  }
}
function getWorkflowExecutorModuleCandidates(env = process.env) {
  const candidates = [];
  const explicitModule = env.GSD_WORKFLOW_EXECUTORS_MODULE?.trim();
  if (explicitModule) {
    if (/^[a-z]{2,}:/i.test(explicitModule) && !explicitModule.startsWith("file:")) {
      throw new Error("GSD_WORKFLOW_EXECUTORS_MODULE only supports file: URLs or filesystem paths.");
    }
    warnCustomWorkflowModule("GSD_WORKFLOW_EXECUTORS_MODULE", explicitModule);
    candidates.push(explicitModule.startsWith("file:") ? explicitModule : toFileUrl(explicitModule));
  }
  candidates.push(
    ...buildImportCandidates("../../../src/resources/extensions/gsd/tools/workflow-tool-executors.js").map((p) => new URL(p, import.meta.url).href)
  );
  return [...new Set(candidates)];
}
async function getWorkflowToolExecutors() {
  if (!workflowToolExecutorsPromise) {
    workflowToolExecutorsPromise = (async () => {
      const attempts = [];
      for (const candidate of getWorkflowExecutorModuleCandidates()) {
        try {
          const loaded = await import(candidate);
          if (isWorkflowToolExecutors(loaded)) {
            return loaded;
          }
          attempts.push(`${candidate} (module shape mismatch)`);
        } catch (err) {
          attempts.push(`${candidate} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      throw new Error(
        `Unable to load GSD workflow executor bridge for MCP mutation tools. Set GSD_WORKFLOW_EXECUTORS_MODULE to an importable workflow-tool-executors module, or run the MCP server from a GSD checkout that includes src/resources/extensions/gsd/tools/workflow-tool-executors.(js|ts). Attempts: ${attempts.join("; ")}`
      );
    })();
  }
  return workflowToolExecutorsPromise;
}
async function getWorkflowWriteGateModule() {
  if (!workflowWriteGatePromise) {
    workflowWriteGatePromise = (async () => {
      const attempts = [];
      for (const candidate of getWriteGateModuleCandidates()) {
        try {
          const loaded = await import(candidate);
          if (loaded && typeof loaded.loadWriteGateSnapshot === "function" && typeof loaded.shouldBlockPendingGateInSnapshot === "function" && typeof loaded.shouldBlockQueueExecutionInSnapshot === "function") {
            return loaded;
          }
          attempts.push(`${candidate} (module shape mismatch)`);
        } catch (err) {
          attempts.push(`${candidate} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      throw new Error(
        `Unable to load GSD write-gate bridge for workflow MCP tools. Attempts: ${attempts.join("; ")}`
      );
    })();
  }
  return workflowWriteGatePromise;
}
const WORKFLOW_TOOL_NAMES = CONTRACT_WORKFLOW_TOOL_NAMES;
const DEFAULT_WORKFLOW_OP_TIMEOUT_MS = 5 * 60 * 1e3;
function getWorkflowOpTimeoutMs(env = process.env) {
  const raw = env.GSD_MCP_WORKFLOW_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_WORKFLOW_OP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_WORKFLOW_OP_TIMEOUT_MS;
  return parsed;
}
function adaptExecutorResult(result) {
  if (!result || typeof result !== "object") return result;
  const r = result;
  if (!("details" in r)) return result;
  const { details, ...rest } = r;
  return isPlainObject(details) ? { ...rest, structuredContent: details } : rest;
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}
async function runSerializedWorkflowOperation(fn) {
  const prior = workflowExecutionQueue;
  let release;
  workflowExecutionQueue = new Promise((resolve2) => {
    release = resolve2;
  });
  await prior;
  const timeoutMs = getWorkflowOpTimeoutMs();
  try {
    if (timeoutMs === 0) {
      return await fn();
    }
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Workflow operation exceeded ${timeoutMs}ms deadline (GSD_MCP_WORKFLOW_TIMEOUT_MS)`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    release();
  }
}
async function runSerializedWorkflowDbOperation(projectDir, fn) {
  return runSerializedWorkflowOperation(async () => {
    const { ensureDbOpen } = await importLocalModule(
      "../../../src/resources/extensions/gsd/bootstrap/dynamic-tools.js"
    );
    const dbAvailable = await ensureDbOpen(projectDir);
    if (!dbAvailable) {
      throw new Error("GSD database is not available");
    }
    return fn();
  });
}
async function enforceWorkflowWriteGate(toolName, projectDir, milestoneId = null) {
  const writeGate = await getWorkflowWriteGateModule();
  const snapshot = writeGate.loadWriteGateSnapshot(projectDir);
  const pendingGate = writeGate.shouldBlockPendingGateInSnapshot(
    snapshot,
    toolName,
    milestoneId,
    snapshot.activeQueuePhase
  );
  if (pendingGate.block) {
    throw new Error(pendingGate.reason ?? "workflow tool blocked by pending discussion gate");
  }
  const queueGuard = writeGate.shouldBlockQueueExecutionInSnapshot(
    snapshot,
    toolName,
    "",
    snapshot.activeQueuePhase
  );
  if (queueGuard.block) {
    throw new Error(queueGuard.reason ?? "workflow tool blocked during queue mode");
  }
}
async function handleTaskComplete(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_task_complete", projectDir, args.milestoneId);
  const { executeTaskComplete } = await getWorkflowToolExecutors();
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeTaskComplete(args, projectDir))
  );
}
async function handleTaskReopen(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_task_reopen", projectDir, args.milestoneId);
  const { executeTaskReopen } = await getWorkflowToolExecutors();
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeTaskReopen(args, projectDir))
  );
}
async function handleSliceReopen(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_slice_reopen", projectDir, args.milestoneId);
  const { executeSliceReopen } = await getWorkflowToolExecutors();
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeSliceReopen(args, projectDir))
  );
}
async function handleMilestoneReopen(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_milestone_reopen", projectDir, args.milestoneId);
  const { executeMilestoneReopen } = await getWorkflowToolExecutors();
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeMilestoneReopen(args, projectDir))
  );
}
async function handleSliceComplete(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_slice_complete", projectDir, args.milestoneId);
  const { executeSliceComplete } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeSliceComplete(params, projectDir))
  );
}
async function handleReplanSlice(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_replan_slice", projectDir, args.milestoneId);
  const { executeReplanSlice } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeReplanSlice(params, projectDir))
  );
}
async function handleCompleteMilestone(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_complete_milestone", projectDir, args.milestoneId);
  const { executeCompleteMilestone } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeCompleteMilestone(params, projectDir))
  );
}
async function handleValidateMilestone(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_validate_milestone", projectDir, args.milestoneId);
  const { executeValidateMilestone } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeValidateMilestone(params, projectDir))
  );
}
async function handleReassessRoadmap(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_reassess_roadmap", projectDir, args.milestoneId);
  const { executeReassessRoadmap } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeReassessRoadmap(params, projectDir))
  );
}
async function handleSaveGateResult(projectDir, args) {
  await enforceWorkflowWriteGate("gsd_save_gate_result", projectDir, args.milestoneId);
  const { executeSaveGateResult } = await getWorkflowToolExecutors();
  const { projectDir: _projectDir, ...params } = args;
  return adaptExecutorResult(
    await runSerializedWorkflowOperation(() => executeSaveGateResult(params, projectDir))
  );
}
async function ensureMilestoneDbRow(milestoneId) {
  try {
    const { insertMilestone } = await importLocalModule("../../../src/resources/extensions/gsd/gsd-db.js");
    insertMilestone({ id: milestoneId, status: "queued" });
  } catch {
  }
}
async function findDatabaseMilestoneIds() {
  try {
    const { getAllMilestones } = await importLocalModule("../../../src/resources/extensions/gsd/gsd-db.js");
    return (getAllMilestones?.() ?? []).map((milestone) => {
      const id = milestone?.id;
      return typeof id === "string" ? id : null;
    }).filter((id) => id !== null);
  } catch {
    return [];
  }
}
async function generateOrReuseMilestoneId(projectDir) {
  const {
    claimReservedId,
    findMilestoneIds,
    getReservedMilestoneIds,
    nextMilestoneId,
    milestoneIdSort
  } = await importLocalModule("../../../src/resources/extensions/gsd/milestone-ids.js");
  const reserved = claimReservedId();
  if (reserved) {
    await ensureMilestoneDbRow(reserved);
    return reserved;
  }
  const allIds = [
    .../* @__PURE__ */ new Set([
      ...findMilestoneIds(projectDir),
      ...getReservedMilestoneIds(),
      ...await findDatabaseMilestoneIds()
    ])
  ];
  const { isReusableGhostMilestone } = await importLocalModule(
    "../../../src/resources/extensions/gsd/state.js"
  );
  const sorted = [...allIds].sort(milestoneIdSort);
  for (const candidate of sorted) {
    if (isReusableGhostMilestone(projectDir, candidate)) {
      await ensureMilestoneDbRow(candidate);
      return candidate;
    }
  }
  const prefsMod = await importLocalModule(
    "../../../src/resources/extensions/gsd/preferences.js"
  ).catch(() => null);
  let uniqueEnabled = false;
  try {
    uniqueEnabled = !!prefsMod?.loadEffectiveGSDPreferences?.(projectDir)?.preferences?.unique_milestone_ids;
  } catch {
    uniqueEnabled = false;
  }
  const nextId = nextMilestoneId(allIds, uniqueEnabled);
  await ensureMilestoneDbRow(nextId);
  return nextId;
}
const projectDirParam = z.string().optional().describe("Optional. Omit this field \u2014 the server defaults to its current working directory, which is already the correct project or worktree root.");
const nonEmptyString = (field) => z.string().trim().min(1, `${field} must be a non-empty string`);
const optionalNonEmptyString = (field) => nonEmptyString(field).optional();
const nonEmptyStringArray = (field) => z.array(nonEmptyString(`${field}[]`));
const HEAVY_FIELD_DESCRIBE = (field) => `${field} for this slice. REQUIRED unless isSketch=true (sketch slices defer this to refine-slice).`;
const planMilestoneSliceSchema = z.object({
  sliceId: nonEmptyString("sliceId"),
  title: nonEmptyString("title"),
  risk: nonEmptyString("risk"),
  depends: z.array(z.string()),
  demo: nonEmptyString("demo"),
  goal: nonEmptyString("goal"),
  // ADR-011: heavy planning fields are optional for sketch slices; required for full slices.
  successCriteria: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("successCriteria")),
  proofLevel: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("proofLevel")),
  integrationClosure: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("integrationClosure")),
  observabilityImpact: z.string().optional().describe(HEAVY_FIELD_DESCRIBE("observabilityImpact")),
  // ADR-011 sketch-then-refine fields.
  isSketch: z.boolean().optional().describe("ADR-011: true marks this slice as a sketch awaiting refine-slice expansion. When true, successCriteria/proofLevel/integrationClosure/observabilityImpact may be omitted and sketchScope becomes required."),
  sketchScope: z.string().optional().describe("ADR-011: 2-3 sentence scope boundary, required when isSketch=true")
}).describe(
  "Planned slice. For full slices (isSketch omitted or false): successCriteria, proofLevel, integrationClosure, and observabilityImpact are all required. For sketch slices (isSketch=true): those four fields may be omitted, but sketchScope is required."
).superRefine((slice, ctx) => {
  if (slice.isSketch === true) {
    if (typeof slice.sketchScope !== "string" || slice.sketchScope.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sketchScope"],
        message: "sketchScope must be a non-empty string when isSketch is true"
      });
    }
    return;
  }
  const required = ["successCriteria", "proofLevel", "integrationClosure", "observabilityImpact"];
  for (const field of required) {
    const value = slice[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be a non-empty string`
      });
    }
  }
});
const planMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  title: nonEmptyString("title").describe("Milestone title"),
  vision: nonEmptyString("vision").describe("Milestone vision"),
  slices: z.array(planMilestoneSliceSchema).describe("Planned slices for the milestone"),
  status: z.string().optional().describe("Milestone status"),
  dependsOn: z.array(z.string()).optional().describe("Milestone dependencies"),
  successCriteria: z.array(z.string()).optional().describe("Top-level success criteria bullets"),
  keyRisks: z.array(z.object({
    risk: nonEmptyString("risk"),
    whyItMatters: nonEmptyString("whyItMatters")
  })).optional().describe("Structured risk entries"),
  proofStrategy: z.array(z.object({
    riskOrUnknown: nonEmptyString("riskOrUnknown"),
    retireIn: nonEmptyString("retireIn"),
    whatWillBeProven: nonEmptyString("whatWillBeProven")
  })).optional().describe("Structured proof strategy entries"),
  verificationContract: z.string().optional(),
  verificationIntegration: z.string().optional(),
  verificationOperational: z.string().optional(),
  verificationUat: z.string().optional(),
  definitionOfDone: z.array(z.string()).optional(),
  requirementCoverage: z.string().optional(),
  boundaryMapMarkdown: z.string().optional()
};
const planMilestoneSchema = z.object(planMilestoneParams);
const planSliceParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  goal: nonEmptyString("goal").describe("Slice goal"),
  tasks: z.array(z.object({
    taskId: nonEmptyString("taskId"),
    title: nonEmptyString("title"),
    description: nonEmptyString("description"),
    estimate: nonEmptyString("estimate"),
    files: nonEmptyStringArray("files"),
    verify: nonEmptyString("verify"),
    inputs: nonEmptyStringArray("inputs"),
    expectedOutput: nonEmptyStringArray("expectedOutput"),
    observabilityImpact: optionalNonEmptyString("observabilityImpact")
  })).describe("Planned tasks for the slice"),
  successCriteria: z.string().optional(),
  proofLevel: z.string().optional(),
  integrationClosure: z.string().optional(),
  observabilityImpact: z.string().optional()
};
const planSliceSchema = z.object(planSliceParams);
const completeMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  title: nonEmptyString("title").describe("Milestone title"),
  oneLiner: z.string().describe("One-sentence summary of what the milestone achieved"),
  narrative: z.string().describe("Detailed narrative of what happened during the milestone"),
  verificationPassed: z.boolean().describe("Must be true after milestone verification succeeds"),
  successCriteriaResults: z.string().optional(),
  definitionOfDoneResults: z.string().optional(),
  requirementOutcomes: z.string().optional(),
  keyDecisions: z.array(z.string()).optional(),
  keyFiles: z.array(z.string()).optional(),
  lessonsLearned: z.array(z.string()).optional(),
  followUps: z.string().optional(),
  deviations: z.string().optional()
};
const completeMilestoneSchema = z.object(completeMilestoneParams);
const validateMilestoneParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  verdict: z.enum(["pass", "needs-attention", "needs-remediation"]).describe("Validation verdict"),
  remediationRound: z.number().describe("Remediation round (0 for first validation)"),
  successCriteriaChecklist: z.string().describe("Markdown checklist of success criteria with evidence"),
  sliceDeliveryAudit: z.string().describe("Markdown auditing each slice's claimed vs delivered output"),
  crossSliceIntegration: z.string().describe("Markdown describing cross-slice issues or closure"),
  requirementCoverage: z.string().describe("Markdown describing requirement coverage and gaps"),
  verificationClasses: z.string().optional(),
  verdictRationale: z.string().describe("Why this verdict was chosen"),
  remediationPlan: z.string().optional()
};
const validateMilestoneSchema = z.object(validateMilestoneParams);
const roadmapSliceChangeSchema = z.object({
  sliceId: nonEmptyString("sliceId"),
  title: nonEmptyString("title"),
  risk: z.string().optional(),
  depends: z.array(z.string()).optional(),
  demo: z.string().optional()
});
const reassessRoadmapParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  completedSliceId: nonEmptyString("completedSliceId").describe("Slice ID that just completed"),
  verdict: nonEmptyString("verdict").describe("Assessment verdict such as roadmap-confirmed or roadmap-adjusted"),
  assessment: nonEmptyString("assessment").describe("Assessment text explaining the roadmap decision"),
  sliceChanges: z.object({
    modified: z.array(roadmapSliceChangeSchema),
    added: z.array(roadmapSliceChangeSchema),
    removed: z.array(z.string())
  }).describe("Slice changes to apply")
};
const reassessRoadmapSchema = z.object(reassessRoadmapParams);
const saveGateResultParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().describe("Milestone ID (e.g. M001)"),
  sliceId: z.string().describe("Slice ID (e.g. S01)"),
  gateId: z.string().describe("Gate ID (e.g. Q3, Q4, Q5, Q6, Q7, Q8, MV01, MV02, MV03, MV04). Accepts any string for forward-compatibility with new gates."),
  taskId: z.string().optional().describe("Task ID for task-scoped gates"),
  verdict: z.enum(["pass", "flag", "omitted"]).describe("Gate verdict"),
  rationale: z.string().describe("One-sentence justification"),
  findings: z.string().optional().describe("Detailed markdown findings")
};
const saveGateResultSchema = z.object(saveGateResultParams);
const replanSliceParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  blockerTaskId: nonEmptyString("blockerTaskId").describe("Task ID that discovered the blocker"),
  blockerDescription: nonEmptyString("blockerDescription").describe("Description of the blocker"),
  whatChanged: nonEmptyString("whatChanged").describe("Summary of what changed in the plan"),
  updatedTasks: z.array(z.object({
    taskId: nonEmptyString("taskId"),
    title: nonEmptyString("title"),
    description: z.string(),
    estimate: z.string(),
    files: z.array(z.string()),
    verify: z.string(),
    inputs: z.array(z.string()),
    expectedOutput: z.array(z.string()),
    fullPlanMd: z.string().optional()
  })).describe("Tasks to upsert into the replanned slice"),
  removedTaskIds: z.array(z.string()).describe("Task IDs to remove from the slice")
};
const replanSliceSchema = z.object(replanSliceParams);
const sliceCompleteParams = {
  projectDir: projectDirParam,
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceTitle: z.string().describe("Title of the slice"),
  oneLiner: z.string().describe("One-line summary of what the slice accomplished"),
  narrative: z.string().describe("Detailed narrative of what happened across all tasks"),
  verification: z.string().describe("What was verified across all tasks"),
  uatContent: z.string().describe("UAT test content (markdown body)"),
  deviations: z.string().optional(),
  knownLimitations: z.string().optional(),
  followUps: z.string().optional(),
  keyFiles: z.union([z.array(z.string()), z.string()]).optional(),
  keyDecisions: z.union([z.array(z.string()), z.string()]).optional(),
  patternsEstablished: z.union([z.array(z.string()), z.string()]).optional(),
  observabilitySurfaces: z.union([z.array(z.string()), z.string()]).optional(),
  provides: z.union([z.array(z.string()), z.string()]).optional(),
  requirementsSurfaced: z.union([z.array(z.string()), z.string()]).optional(),
  drillDownPaths: z.union([z.array(z.string()), z.string()]).optional(),
  affects: z.union([z.array(z.string()), z.string()]).optional(),
  requirementsAdvanced: z.array(z.union([
    z.object({ id: z.string(), how: z.string() }),
    z.string()
  ])).optional(),
  requirementsValidated: z.array(z.union([
    z.object({ id: z.string(), proof: z.string() }),
    z.string()
  ])).optional(),
  requirementsInvalidated: z.array(z.union([
    z.object({ id: z.string(), what: z.string() }),
    z.string()
  ])).optional(),
  filesModified: z.array(z.union([
    z.object({ path: z.string(), description: z.string() }),
    z.string()
  ])).optional(),
  requires: z.array(z.union([
    z.object({ slice: z.string(), provides: z.string() }),
    z.string()
  ])).optional()
};
const sliceCompleteSchema = z.object(sliceCompleteParams);
const summarySaveParams = {
  projectDir: projectDirParam,
  milestone_id: z.string().optional().describe("Milestone ID (e.g. M001). Omit only for root-level PROJECT/PROJECT-DRAFT/REQUIREMENTS/REQUIREMENTS-DRAFT artifacts."),
  slice_id: z.string().optional().describe("Slice ID (e.g. S01)"),
  task_id: z.string().optional().describe("Task ID (e.g. T01)"),
  artifact_type: z.string().describe("Artifact type to save (SUMMARY, RESEARCH, CONTEXT, ASSESSMENT, CONTEXT-DRAFT, PROJECT, PROJECT-DRAFT, REQUIREMENTS, REQUIREMENTS-DRAFT)"),
  content: z.string().describe("The full markdown content of the artifact")
};
const ROOT_SUMMARY_ARTIFACT_TYPES = /* @__PURE__ */ new Set([
  "PROJECT",
  "PROJECT-DRAFT",
  "REQUIREMENTS",
  "REQUIREMENTS-DRAFT"
]);
const summarySaveSchema = z.object(summarySaveParams).superRefine((value, ctx) => {
  const isRootArtifact = ROOT_SUMMARY_ARTIFACT_TYPES.has(value.artifact_type);
  if (!isRootArtifact && (!value.milestone_id || value.milestone_id.trim() === "")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["milestone_id"],
      message: "milestone_id is required for milestone-scoped artifact types"
    });
  }
});
const decisionSaveParams = {
  projectDir: projectDirParam,
  scope: z.string().describe("Scope of the decision (e.g. architecture, library, observability)"),
  decision: z.string().describe("What is being decided"),
  choice: z.string().describe("The choice made"),
  rationale: z.string().describe("Why this choice was made"),
  revisable: z.string().optional().describe("Whether this can be revisited"),
  when_context: z.string().optional().describe("When/context for the decision"),
  made_by: z.enum(["human", "agent", "collaborative"]).optional().describe("Who made the decision")
};
const decisionSaveSchema = z.object(decisionSaveParams);
const requirementUpdateParams = {
  projectDir: projectDirParam,
  id: z.string().describe("Requirement ID (e.g. R001)"),
  status: z.string().optional().describe("New status"),
  validation: z.string().optional().describe("Validation criteria or proof"),
  notes: z.string().optional().describe("Additional notes"),
  description: z.string().optional().describe("Updated description"),
  primary_owner: z.string().optional().describe("Primary owning slice"),
  supporting_slices: z.string().optional().describe("Supporting slices")
};
const requirementUpdateSchema = z.object(requirementUpdateParams);
const requirementSaveParams = {
  projectDir: projectDirParam,
  class: z.string().describe("Requirement class: core-capability, primary-user-loop, launchability, continuity, failure-visibility, integration, quality-attribute, operability, admin/support, compliance/security, differentiator, constraint, or anti-feature"),
  description: z.string().describe("Short description of the requirement"),
  why: z.string().describe("Why this requirement matters"),
  source: z.string().describe("Origin of the requirement"),
  status: z.string().optional().describe("Requirement status"),
  primary_owner: z.string().optional().describe("Primary owning slice"),
  supporting_slices: z.string().optional().describe("Supporting slices"),
  validation: z.string().optional().describe("Validation criteria"),
  notes: z.string().optional().describe("Additional notes")
};
const requirementSaveSchema = z.object(requirementSaveParams);
const milestoneGenerateIdParams = {
  projectDir: projectDirParam
};
const milestoneGenerateIdSchema = z.object(milestoneGenerateIdParams);
const planTaskParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  title: nonEmptyString("title").describe("Task title"),
  description: nonEmptyString("description").describe("Task description / steps block"),
  estimate: nonEmptyString("estimate").describe("Task estimate"),
  files: z.array(z.string()).describe("Files likely touched"),
  verify: nonEmptyString("verify").describe("Verification command or block"),
  inputs: z.array(z.string()).describe("Input files or references"),
  expectedOutput: z.array(z.string()).describe("Expected output files or artifacts"),
  observabilityImpact: optionalNonEmptyString("observabilityImpact").describe("Task observability impact")
};
const planTaskSchema = z.object(planTaskParams);
const skipSliceParams = {
  projectDir: projectDirParam,
  sliceId: z.string().describe("Slice ID (e.g. S02)"),
  milestoneId: z.string().describe("Milestone ID (e.g. M003)"),
  reason: z.string().optional().describe("Reason for skipping this slice")
};
const skipSliceSchema = z.object(skipSliceParams);
const taskCompleteParams = {
  projectDir: projectDirParam,
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  oneLiner: z.string().describe("One-line summary of what was accomplished"),
  narrative: z.string().describe("Detailed narrative of what happened during the task"),
  verification: z.string().describe("What was verified and how"),
  deviations: z.string().optional().describe("Deviations from the task plan"),
  knownIssues: z.string().optional().describe("Known issues discovered but not fixed"),
  keyFiles: z.array(z.string()).optional().describe("List of key files created or modified"),
  keyDecisions: z.array(z.string()).optional().describe("List of key decisions made during this task"),
  blockerDiscovered: z.boolean().optional().describe("Whether a plan-invalidating blocker was discovered"),
  // ADR-011 Phase 2: mid-execution escalation — agent asks the user to resolve an ambiguity.
  escalation: z.object({
    question: z.string().describe("The question the user needs to answer \u2014 one clear sentence."),
    options: z.array(z.object({
      id: z.string().describe("Short id (e.g. 'A', 'B') used by /gsd escalate resolve."),
      label: z.string().describe("One-line label."),
      tradeoffs: z.string().describe("1-2 sentences on the tradeoffs of this option.")
    })).min(2).max(4).describe("2-4 options the user can choose between."),
    recommendation: z.string().describe("Option id the executor recommends."),
    recommendationRationale: z.string().describe("Why the recommendation \u2014 1-2 sentences."),
    continueWithDefault: z.boolean().describe(
      "When true, loop continues (artifact logged for later review). When false, auto-mode pauses until the user resolves via /gsd escalate resolve."
    )
  }).optional().describe("ADR-011 Phase 2: optional escalation payload. Only honored when phases.mid_execution_escalation is true."),
  verificationEvidence: z.array(z.union([
    z.object({
      command: z.string(),
      exitCode: z.number(),
      verdict: z.string(),
      durationMs: z.number()
    }),
    z.string()
  ])).optional().describe("Verification evidence entries")
};
const taskCompleteSchema = z.object(taskCompleteParams);
const taskReopenParams = {
  projectDir: projectDirParam,
  taskId: nonEmptyString("taskId").describe("Task ID (e.g. T01)"),
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  reason: z.string().optional().describe("Why the task is being reopened"),
  actorName: z.string().optional().describe("Caller-provided actor identity for audit trail"),
  triggerReason: z.string().optional().describe("Caller-provided reason this action was triggered")
};
const taskReopenSchema = z.object(taskReopenParams);
const sliceReopenParams = {
  projectDir: projectDirParam,
  sliceId: nonEmptyString("sliceId").describe("Slice ID (e.g. S01)"),
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  reason: z.string().optional().describe("Why the slice is being reopened"),
  actorName: z.string().optional().describe("Caller-provided actor identity for audit trail"),
  triggerReason: z.string().optional().describe("Caller-provided reason this action was triggered")
};
const sliceReopenSchema = z.object(sliceReopenParams);
const milestoneReopenParams = {
  projectDir: projectDirParam,
  milestoneId: nonEmptyString("milestoneId").describe("Milestone ID (e.g. M001)"),
  reason: z.string().optional().describe("Why the milestone is being reopened"),
  actorName: z.string().optional().describe("Caller-provided actor identity for audit trail"),
  triggerReason: z.string().optional().describe("Caller-provided reason this action was triggered")
};
const milestoneReopenSchema = z.object(milestoneReopenParams);
const milestoneStatusParams = {
  projectDir: projectDirParam,
  milestoneId: z.string().describe("Milestone ID to query (e.g. M001)")
};
const milestoneStatusSchema = z.object(milestoneStatusParams);
const journalQueryParams = {
  projectDir: projectDirParam,
  flowId: z.string().optional().describe("Filter by flow ID"),
  unitId: z.string().optional().describe("Filter by unit ID"),
  rule: z.string().optional().describe("Filter by rule name"),
  eventType: z.string().optional().describe("Filter by event type"),
  after: z.string().optional().describe("ISO-8601 lower bound (inclusive)"),
  before: z.string().optional().describe("ISO-8601 upper bound (inclusive)"),
  limit: z.number().optional().describe("Maximum entries to return")
};
const journalQuerySchema = z.object(journalQueryParams);
const execRuntimeSchema = z.enum(["bash", "node", "python"]);
const execParams = {
  projectDir: projectDirParam,
  runtime: execRuntimeSchema.describe("Interpreter: bash (-c), node (-e), or python3 (-c)."),
  script: nonEmptyString("script").describe("Script body. Keep output small; capped stdout/stderr are persisted under .gsd/exec."),
  purpose: z.string().optional().describe("Short label recorded in meta.json for later review."),
  timeout_ms: z.number().int().min(1e3).max(6e5).optional().describe("Per-invocation timeout in milliseconds.")
};
const execSchema = z.object(execParams);
const execSearchParams = {
  projectDir: projectDirParam,
  query: z.string().optional().describe("Substring matched against id and purpose, case-insensitive."),
  runtime: execRuntimeSchema.optional().describe("Restrict to one runtime."),
  failing_only: z.boolean().optional().describe("Only non-zero exit codes and timeouts."),
  limit: z.number().int().min(1).max(200).optional().describe("Max results (default 20, cap 200).")
};
const execSearchSchema = z.object(execSearchParams);
const resumeParams = {
  projectDir: projectDirParam
};
const resumeSchema = z.object(resumeParams);
function wrapServerWithErrorHandler(realServer) {
  return {
    tool(name, description, params, handler) {
      return realServer.tool(name, description, params, async (args) => {
        try {
          return await handler(args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: "text", text: message }]
          };
        }
      });
    }
  };
}
function registerWorkflowTools(realServer) {
  const server = wrapServerWithErrorHandler(realServer);
  server.tool(
    "gsd_decision_save",
    "Record a project decision to the GSD database and regenerate DECISIONS.md.",
    decisionSaveParams,
    async (args) => {
      const parsed = parseWorkflowArgs(decisionSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_decision_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { saveDecisionToDb } = await importLocalModule("../../../src/resources/extensions/gsd/db-writer.js");
        return saveDecisionToDb(params, projectDir);
      });
      return { content: [{ type: "text", text: `Saved decision ${result.id}` }] };
    }
  );
  server.tool(
    "gsd_save_decision",
    "Alias for gsd_decision_save. Record a project decision to the GSD database and regenerate DECISIONS.md.",
    decisionSaveParams,
    async (args) => {
      logAliasUsage("gsd_save_decision", "gsd_decision_save");
      const parsed = parseWorkflowArgs(decisionSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_decision_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { saveDecisionToDb } = await importLocalModule("../../../src/resources/extensions/gsd/db-writer.js");
        return saveDecisionToDb(params, projectDir);
      });
      return { content: [{ type: "text", text: `Saved decision ${result.id}` }] };
    }
  );
  server.tool(
    "gsd_requirement_update",
    "Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md.",
    requirementUpdateParams,
    async (args) => {
      const parsed = parseWorkflowArgs(requirementUpdateSchema, args);
      const { projectDir, id, ...updates } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_update", projectDir);
      await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { updateRequirementInDb } = await importLocalModule("../../../src/resources/extensions/gsd/db-writer.js");
        return updateRequirementInDb(id, updates, projectDir);
      });
      return { content: [{ type: "text", text: `Updated requirement ${id}` }] };
    }
  );
  server.tool(
    "gsd_update_requirement",
    "Alias for gsd_requirement_update. Update an existing requirement in the GSD database and regenerate REQUIREMENTS.md.",
    requirementUpdateParams,
    async (args) => {
      logAliasUsage("gsd_update_requirement", "gsd_requirement_update");
      const parsed = parseWorkflowArgs(requirementUpdateSchema, args);
      const { projectDir, id, ...updates } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_update", projectDir);
      await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { updateRequirementInDb } = await importLocalModule("../../../src/resources/extensions/gsd/db-writer.js");
        return updateRequirementInDb(id, updates, projectDir);
      });
      return { content: [{ type: "text", text: `Updated requirement ${id}` }] };
    }
  );
  server.tool(
    "gsd_requirement_save",
    "Record a new requirement to the GSD database and regenerate REQUIREMENTS.md.",
    requirementSaveParams,
    async (args) => {
      const parsed = parseWorkflowArgs(requirementSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { saveRequirementToDb } = await importLocalModule("../../../src/resources/extensions/gsd/db-writer.js");
        return saveRequirementToDb(params, projectDir);
      });
      return { content: [{ type: "text", text: `Saved requirement ${result.id}` }] };
    }
  );
  server.tool(
    "gsd_save_requirement",
    "Alias for gsd_requirement_save. Record a new requirement to the GSD database and regenerate REQUIREMENTS.md.",
    requirementSaveParams,
    async (args) => {
      logAliasUsage("gsd_save_requirement", "gsd_requirement_save");
      const parsed = parseWorkflowArgs(requirementSaveSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_requirement_save", projectDir);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { saveRequirementToDb } = await importLocalModule("../../../src/resources/extensions/gsd/db-writer.js");
        return saveRequirementToDb(params, projectDir);
      });
      return { content: [{ type: "text", text: `Saved requirement ${result.id}` }] };
    }
  );
  server.tool(
    "gsd_milestone_generate_id",
    "Generate the next milestone ID for a new GSD milestone.",
    milestoneGenerateIdParams,
    async (args) => {
      const { projectDir } = parseWorkflowArgs(milestoneGenerateIdSchema, args);
      await enforceWorkflowWriteGate("gsd_milestone_generate_id", projectDir);
      const id = await runSerializedWorkflowDbOperation(
        projectDir,
        () => generateOrReuseMilestoneId(projectDir)
      );
      return { content: [{ type: "text", text: id }] };
    }
  );
  server.tool(
    "gsd_generate_milestone_id",
    "Alias for gsd_milestone_generate_id. Generate the next milestone ID for a new GSD milestone.",
    milestoneGenerateIdParams,
    async (args) => {
      logAliasUsage("gsd_generate_milestone_id", "gsd_milestone_generate_id");
      const { projectDir } = parseWorkflowArgs(milestoneGenerateIdSchema, args);
      await enforceWorkflowWriteGate("gsd_milestone_generate_id", projectDir);
      const id = await runSerializedWorkflowDbOperation(
        projectDir,
        () => generateOrReuseMilestoneId(projectDir)
      );
      return { content: [{ type: "text", text: id }] };
    }
  );
  server.tool(
    "gsd_plan_milestone",
    "Write milestone planning state to the GSD database and render ROADMAP.md from DB.",
    planMilestoneParams,
    async (args) => {
      const parsed = parseWorkflowArgs(planMilestoneSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_milestone", projectDir, params.milestoneId);
      const { executePlanMilestone } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executePlanMilestone(params, projectDir))
      );
    }
  );
  server.tool(
    "gsd_plan_slice",
    "Write slice/task planning state to the GSD database and render plan artifacts from DB.",
    planSliceParams,
    async (args) => {
      const parsed = parseWorkflowArgs(planSliceSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_slice", projectDir, params.milestoneId);
      const { executePlanSlice } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executePlanSlice(params, projectDir))
      );
    }
  );
  server.tool(
    "gsd_plan_task",
    "Write task planning state to the GSD database and render tasks/T##-PLAN.md from DB.",
    planTaskParams,
    async (args) => {
      const parsed = parseWorkflowArgs(planTaskSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_task", projectDir, params.milestoneId);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { handlePlanTask } = await importLocalModule("../../../src/resources/extensions/gsd/tools/plan-task.js");
        return handlePlanTask(params, projectDir);
      });
      if ("error" in result) {
        throw new Error(result.error);
      }
      return {
        content: [{ type: "text", text: `Planned task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }]
      };
    }
  );
  server.tool(
    "gsd_task_plan",
    "Alias for gsd_plan_task. Write task planning state to the GSD database and render tasks/T##-PLAN.md from DB.",
    planTaskParams,
    async (args) => {
      logAliasUsage("gsd_task_plan", "gsd_plan_task");
      const parsed = parseWorkflowArgs(planTaskSchema, args);
      const { projectDir, ...params } = parsed;
      await enforceWorkflowWriteGate("gsd_plan_task", projectDir, params.milestoneId);
      const result = await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { handlePlanTask } = await importLocalModule("../../../src/resources/extensions/gsd/tools/plan-task.js");
        return handlePlanTask(params, projectDir);
      });
      if ("error" in result) {
        throw new Error(result.error);
      }
      return {
        content: [{ type: "text", text: `Planned task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }]
      };
    }
  );
  server.tool(
    "gsd_replan_slice",
    "Replan a slice after a blocker is discovered, preserving completed tasks and re-rendering PLAN.md + REPLAN.md.",
    replanSliceParams,
    async (args) => {
      const parsed = parseWorkflowArgs(replanSliceSchema, args);
      return handleReplanSlice(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_slice_replan",
    "Alias for gsd_replan_slice. Replan a slice after a blocker is discovered.",
    replanSliceParams,
    async (args) => {
      logAliasUsage("gsd_slice_replan", "gsd_replan_slice");
      const parsed = parseWorkflowArgs(replanSliceSchema, args);
      return handleReplanSlice(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_slice_complete",
    "Record a completed slice to the GSD database, render SUMMARY.md + UAT.md, and update roadmap projection.",
    sliceCompleteParams,
    async (args) => {
      const parsed = parseWorkflowArgs(sliceCompleteSchema, args);
      return handleSliceComplete(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_complete_slice",
    "Alias for gsd_slice_complete. Record a completed slice to the GSD database and render summary/UAT artifacts.",
    sliceCompleteParams,
    async (args) => {
      logAliasUsage("gsd_complete_slice", "gsd_slice_complete");
      const parsed = parseWorkflowArgs(sliceCompleteSchema, args);
      return handleSliceComplete(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_skip_slice",
    "Mark a slice as skipped so auto-mode advances past it without executing.",
    skipSliceParams,
    async (args) => {
      const { projectDir, milestoneId, sliceId, reason } = parseWorkflowArgs(skipSliceSchema, args);
      await enforceWorkflowWriteGate("gsd_skip_slice", projectDir, milestoneId);
      await runSerializedWorkflowDbOperation(projectDir, async () => {
        const { getSlice, updateSliceStatus } = await importLocalModule("../../../src/resources/extensions/gsd/gsd-db.js");
        const { invalidateStateCache } = await importLocalModule("../../../src/resources/extensions/gsd/state.js");
        const { rebuildState } = await importLocalModule("../../../src/resources/extensions/gsd/doctor.js");
        const slice = getSlice(milestoneId, sliceId);
        if (!slice) {
          throw new Error(`Slice ${sliceId} not found in milestone ${milestoneId}`);
        }
        if (slice.status === "complete" || slice.status === "done") {
          throw new Error(`Slice ${sliceId} is already complete and cannot be skipped`);
        }
        if (slice.status !== "skipped") {
          updateSliceStatus(milestoneId, sliceId, "skipped");
          invalidateStateCache();
          await rebuildState(projectDir);
        }
      });
      return {
        content: [{ type: "text", text: `Skipped slice ${sliceId} (${milestoneId}). Reason: ${reason ?? "User-directed skip"}.` }]
      };
    }
  );
  server.tool(
    "gsd_complete_milestone",
    "Record a completed milestone to the GSD database and render its SUMMARY.md.",
    completeMilestoneParams,
    async (args) => {
      const parsed = parseWorkflowArgs(completeMilestoneSchema, args);
      return handleCompleteMilestone(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_milestone_complete",
    "Alias for gsd_complete_milestone. Record a completed milestone to the GSD database and render its SUMMARY.md.",
    completeMilestoneParams,
    async (args) => {
      logAliasUsage("gsd_milestone_complete", "gsd_complete_milestone");
      const parsed = parseWorkflowArgs(completeMilestoneSchema, args);
      return handleCompleteMilestone(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_validate_milestone",
    "Validate a milestone, persist validation results to the GSD database, and render VALIDATION.md.",
    validateMilestoneParams,
    async (args) => {
      const parsed = parseWorkflowArgs(validateMilestoneSchema, args);
      return handleValidateMilestone(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_milestone_validate",
    "Alias for gsd_validate_milestone. Validate a milestone and render VALIDATION.md.",
    validateMilestoneParams,
    async (args) => {
      logAliasUsage("gsd_milestone_validate", "gsd_validate_milestone");
      const parsed = parseWorkflowArgs(validateMilestoneSchema, args);
      return handleValidateMilestone(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_reassess_roadmap",
    "Reassess a milestone roadmap after a slice completes, writing ASSESSMENT.md and re-rendering ROADMAP.md.",
    reassessRoadmapParams,
    async (args) => {
      const parsed = parseWorkflowArgs(reassessRoadmapSchema, args);
      return handleReassessRoadmap(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_roadmap_reassess",
    "Alias for gsd_reassess_roadmap. Reassess a roadmap after slice completion.",
    reassessRoadmapParams,
    async (args) => {
      logAliasUsage("gsd_roadmap_reassess", "gsd_reassess_roadmap");
      const parsed = parseWorkflowArgs(reassessRoadmapSchema, args);
      return handleReassessRoadmap(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_save_gate_result",
    "Save a quality gate result to the GSD database.",
    saveGateResultParams,
    async (args) => {
      const parsed = parseWorkflowArgs(saveGateResultSchema, args);
      return handleSaveGateResult(parsed.projectDir, parsed);
    }
  );
  server.tool(
    "gsd_summary_save",
    "Save a GSD summary/research/context/assessment artifact to the database and disk. Omit milestone_id only for root-level PROJECT/PROJECT-DRAFT/REQUIREMENTS/REQUIREMENTS-DRAFT artifacts.",
    summarySaveParams,
    async (args) => {
      const parsed = parseWorkflowArgs(summarySaveSchema, args);
      const { projectDir, milestone_id, slice_id, task_id, artifact_type, content } = parsed;
      await enforceWorkflowWriteGate("gsd_summary_save", projectDir, milestone_id ?? null);
      const executors = await getWorkflowToolExecutors();
      const supportedArtifactTypes = getSupportedSummaryArtifactTypes(executors);
      if (!supportedArtifactTypes.includes(artifact_type)) {
        throw new Error(
          `artifact_type must be one of: ${supportedArtifactTypes.join(", ")}`
        );
      }
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(
          () => executors.executeSummarySave({ milestone_id, slice_id, task_id, artifact_type, content }, projectDir)
        )
      );
    }
  );
  server.tool(
    "gsd_task_complete",
    "Record a completed task to the GSD database and render its SUMMARY.md.",
    taskCompleteParams,
    async (args) => {
      const parsed = parseWorkflowArgs(taskCompleteSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskComplete(projectDir, taskArgs);
    }
  );
  server.tool(
    "gsd_complete_task",
    "Alias for gsd_task_complete. Record a completed task to the GSD database and render its SUMMARY.md.",
    taskCompleteParams,
    async (args) => {
      logAliasUsage("gsd_complete_task", "gsd_task_complete");
      const parsed = parseWorkflowArgs(taskCompleteSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskComplete(projectDir, taskArgs);
    }
  );
  server.tool(
    "gsd_task_reopen",
    "Reset a completed task back to pending so it can be re-done.",
    taskReopenParams,
    async (args) => {
      const parsed = parseWorkflowArgs(taskReopenSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskReopen(projectDir, taskArgs);
    }
  );
  server.tool(
    "gsd_reopen_task",
    "Alias for gsd_task_reopen. Reset a completed task back to pending so it can be re-done.",
    taskReopenParams,
    async (args) => {
      logAliasUsage("gsd_reopen_task", "gsd_task_reopen");
      const parsed = parseWorkflowArgs(taskReopenSchema, args);
      const { projectDir, ...taskArgs } = parsed;
      return handleTaskReopen(projectDir, taskArgs);
    }
  );
  server.tool(
    "gsd_slice_reopen",
    "Reset a completed slice back to in_progress and reset its tasks to pending.",
    sliceReopenParams,
    async (args) => {
      const parsed = parseWorkflowArgs(sliceReopenSchema, args);
      const { projectDir, ...sliceArgs } = parsed;
      return handleSliceReopen(projectDir, sliceArgs);
    }
  );
  server.tool(
    "gsd_reopen_slice",
    "Alias for gsd_slice_reopen. Reset a completed slice back to in_progress and reset its tasks to pending.",
    sliceReopenParams,
    async (args) => {
      logAliasUsage("gsd_reopen_slice", "gsd_slice_reopen");
      const parsed = parseWorkflowArgs(sliceReopenSchema, args);
      const { projectDir, ...sliceArgs } = parsed;
      return handleSliceReopen(projectDir, sliceArgs);
    }
  );
  server.tool(
    "gsd_milestone_reopen",
    "Reset a closed milestone back to active and reset its slices/tasks for rework.",
    milestoneReopenParams,
    async (args) => {
      const parsed = parseWorkflowArgs(milestoneReopenSchema, args);
      const { projectDir, ...milestoneArgs } = parsed;
      return handleMilestoneReopen(projectDir, milestoneArgs);
    }
  );
  server.tool(
    "gsd_reopen_milestone",
    "Alias for gsd_milestone_reopen. Reset a closed milestone back to active and reset its slices/tasks for rework.",
    milestoneReopenParams,
    async (args) => {
      logAliasUsage("gsd_reopen_milestone", "gsd_milestone_reopen");
      const parsed = parseWorkflowArgs(milestoneReopenSchema, args);
      const { projectDir, ...milestoneArgs } = parsed;
      return handleMilestoneReopen(projectDir, milestoneArgs);
    }
  );
  server.tool(
    "gsd_milestone_status",
    "Read the current status of a milestone and all its slices from the GSD database.",
    milestoneStatusParams,
    async (args) => {
      const { projectDir, milestoneId } = parseWorkflowArgs(milestoneStatusSchema, args);
      const { executeMilestoneStatus } = await getWorkflowToolExecutors();
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(() => executeMilestoneStatus({ milestoneId }, projectDir))
      );
    }
  );
  server.tool(
    "gsd_journal_query",
    "Query the structured event journal for auto-mode iterations.",
    journalQueryParams,
    async (args) => {
      const { projectDir, limit, ...filters } = parseWorkflowArgs(journalQuerySchema, args);
      const { queryJournal } = await importLocalModule("../../../src/resources/extensions/gsd/journal.js");
      const entries = queryJournal(projectDir, filters).slice(0, limit ?? 100);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No matching journal entries found." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    }
  );
  server.tool(
    "gsd_exec",
    "Run a short bash/node/python script in the project directory. Capped stdout/stderr and metadata persist under .gsd/exec; only a digest returns to MCP.",
    execParams,
    async (args) => {
      const { projectDir, ...params } = parseWorkflowArgs(execSchema, args);
      await enforceWorkflowWriteGate("gsd_exec", projectDir);
      const { executeGsdExec } = await importLocalModule(
        "../../../src/resources/extensions/gsd/tools/exec-tool.js"
      );
      return adaptExecutorResult(
        await runSerializedWorkflowOperation(
          async () => executeGsdExec(params, {
            baseDir: projectDir,
            preferences: await loadProjectPreferences(projectDir)
          })
        )
      );
    }
  );
  server.tool(
    "gsd_exec_search",
    "Search prior gsd_exec runs from .gsd/exec/*.meta.json without re-running them.",
    execSearchParams,
    async (args) => {
      const { projectDir, ...params } = parseWorkflowArgs(execSearchSchema, args);
      const { executeExecSearch } = await importLocalModule(
        "../../../src/resources/extensions/gsd/tools/exec-search-tool.js"
      );
      return adaptExecutorResult(
        executeExecSearch(params, {
          baseDir: projectDir,
          preferences: await loadProjectPreferences(projectDir)
        })
      );
    }
  );
  server.tool(
    "gsd_resume",
    "Read .gsd/last-snapshot.md so agents can re-orient after compaction or session resume.",
    resumeParams,
    async (args) => {
      const { projectDir, ...params } = parseWorkflowArgs(resumeSchema, args);
      const { executeResume } = await importLocalModule(
        "../../../src/resources/extensions/gsd/tools/resume-tool.js"
      );
      return adaptExecutorResult(
        executeResume(params, {
          baseDir: projectDir,
          preferences: await loadProjectPreferences(projectDir)
        })
      );
    }
  );
  const MEMORY_CATEGORY = z.enum([
    "architecture",
    "convention",
    "gotcha",
    "preference",
    "environment",
    "pattern"
  ]);
  const captureThoughtSchema = z.object({
    projectDir: z.string().optional(),
    category: MEMORY_CATEGORY,
    // Reject empty / whitespace-only content at the schema layer so the LLM
    // never produces a memory row with no searchable text.
    content: z.string().trim().min(1, "content must be a non-empty trimmed string"),
    confidence: z.number().min(0.1).max(0.99).optional(),
    tags: z.array(z.string()).optional(),
    scope: z.string().optional(),
    structuredFields: z.record(z.string(), z.unknown()).optional()
  });
  const captureThoughtParams = {
    projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    category: MEMORY_CATEGORY.describe("Memory category"),
    content: z.string().describe("Memory text (1-3 sentences, no secrets)"),
    confidence: z.number().min(0.1).max(0.99).optional().describe("0.1-0.99, default 0.8"),
    tags: z.array(z.string()).optional().describe("Free-form tags"),
    scope: z.string().optional().describe("Scope name; defaults to 'project'"),
    structuredFields: z.record(z.string(), z.unknown()).optional().describe("ADR-013 structured payload (e.g. decision fields)")
  };
  server.tool(
    "gsd_capture_thought",
    "Record a durable project insight into the GSD memory store. Categories: architecture, convention, gotcha, preference, environment, pattern. Mirrors the in-process capture_thought tool for external MCP clients.",
    captureThoughtParams,
    async (args) => {
      const { projectDir, ...params } = parseWorkflowArgs(captureThoughtSchema, args);
      await enforceWorkflowWriteGate("gsd_capture_thought", projectDir);
      return runSerializedWorkflowDbOperation(projectDir, async () => {
        const { executeMemoryCapture } = await importLocalModule(
          "../../../src/resources/extensions/gsd/tools/memory-tools.js"
        );
        return executeMemoryCapture(params);
      });
    }
  );
  const memoryQuerySchema = z.object({
    projectDir: z.string().optional(),
    // Match the documented "2+ char terms" contract in the in-process
    // memory_query tool — reject sub-2-char queries at the schema layer.
    query: z.string().trim().min(2, "query must be at least 2 characters"),
    k: z.number().int().min(1).max(50).optional(),
    category: MEMORY_CATEGORY.optional(),
    scope: z.string().optional(),
    tag: z.string().optional(),
    include_superseded: z.boolean().optional(),
    reinforce_hits: z.boolean().optional()
  });
  const memoryQueryParams = {
    projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    query: z.string().describe("Keyword query (2+ char terms)"),
    k: z.number().int().min(1).max(50).optional().describe("Max results (default 10, max 50)"),
    category: MEMORY_CATEGORY.optional().describe("Restrict to a single category"),
    scope: z.string().optional().describe("Only include memories with this scope"),
    tag: z.string().optional().describe("Only include memories tagged with this value"),
    include_superseded: z.boolean().optional().describe("Include superseded memories (default false)"),
    reinforce_hits: z.boolean().optional().describe("Increment hit_count on returned memories (default false)")
  };
  server.tool(
    "gsd_memory_query",
    "Search the GSD memory store by keyword. Returns ranked memories with id, category, content, confidence, scope, and tags. Mirrors the in-process memory_query tool for external MCP clients.",
    memoryQueryParams,
    async (args) => {
      const { projectDir, ...params } = parseWorkflowArgs(memoryQuerySchema, args);
      return runSerializedWorkflowDbOperation(projectDir, async () => {
        const { executeMemoryQuery } = await importLocalModule(
          "../../../src/resources/extensions/gsd/tools/memory-tools.js"
        );
        return executeMemoryQuery(params);
      });
    }
  );
  const memoryGraphSchema = z.object({
    projectDir: z.string().optional(),
    mode: z.enum(["build", "query"]),
    memoryId: z.string().optional(),
    depth: z.number().int().min(0).max(5).optional(),
    rel: z.enum(["related_to", "depends_on", "contradicts", "elaborates", "supersedes"]).optional()
  }).refine(
    (val) => val.mode !== "query" || typeof val.memoryId === "string" && val.memoryId.trim().length > 0,
    { message: "memoryId is required and must be non-empty when mode=query", path: ["memoryId"] }
  );
  const memoryGraphParams = {
    projectDir: z.string().optional().describe("Absolute path to the project directory (defaults to MCP server cwd)"),
    mode: z.enum(["build", "query"]).describe("build = recompute graph (placeholder), query = inspect edges"),
    memoryId: z.string().optional().describe("Memory ID (required when mode=query)"),
    depth: z.number().int().min(0).max(5).optional().describe("Hops to traverse (0-5, default 1)"),
    rel: z.enum(["related_to", "depends_on", "contradicts", "elaborates", "supersedes"]).optional().describe("Only include edges with this relation type")
  };
  server.tool(
    "gsd_memory_graph",
    "Inspect the relationship graph between memories. mode=query walks edges from a given memoryId. mode=build is a placeholder reserved for future graph rebuilds. Distinct from gsd_graph (project knowledge graph) \u2014 see ADR-013.",
    memoryGraphParams,
    async (args) => {
      const { projectDir, ...params } = parseWorkflowArgs(memoryGraphSchema, args);
      return runSerializedWorkflowDbOperation(projectDir, async () => {
        const { executeGsdGraph } = await importLocalModule(
          "../../../src/resources/extensions/gsd/tools/memory-tools.js"
        );
        return executeGsdGraph(params);
      });
    }
  );
}
export {
  WORKFLOW_TOOL_NAMES,
  _buildImportCandidates,
  _parseWorkflowArgsForTest,
  registerWorkflowTools,
  validateProjectDir
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vcGFja2FnZXMvbWNwLXNlcnZlci9zcmMvd29ya2Zsb3ctdG9vbHMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBSZWdpc3RlcnMgcGFja2FnZWQgd29ya2Zsb3cgdG9vbHMgZXhwb3NlZCBieSB0aGUgR1NEIE1DUCBzZXJ2ZXIuXG5cbi8qKlxuICogV29ya2Zsb3cgTUNQIHRvb2xzIFx1MjAxNCBleHBvc2VzIHRoZSBjb3JlIEdTRCBtdXRhdGlvbi9yZWFkIGhhbmRsZXJzIG92ZXIgTUNQLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRkaXJTeW5jLCByZWFscGF0aFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhdGhUb0ZpbGVVUkwgfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHogfSBmcm9tIFwiem9kXCI7XG5pbXBvcnQgeyBXT1JLRkxPV19UT09MX05BTUVTIGFzIENPTlRSQUNUX1dPUktGTE9XX1RPT0xfTkFNRVMgfSBmcm9tIFwiQGdzZC1idWlsZC9jb250cmFjdHNcIjtcblxuaW1wb3J0IHsgbG9nQWxpYXNVc2FnZSB9IGZyb20gXCIuL2FsaWFzLXRlbGVtZXRyeS5qc1wiO1xuXG50eXBlIFdvcmtmbG93VG9vbEV4ZWN1dG9ycyA9IHtcbiAgU1VQUE9SVEVEX1NVTU1BUllfQVJUSUZBQ1RfVFlQRVM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBleGVjdXRlTWlsZXN0b25lU3RhdHVzOiAocGFyYW1zOiB7IG1pbGVzdG9uZUlkOiBzdHJpbmcgfSwgYmFzZVBhdGg/OiBzdHJpbmcpID0+IFByb21pc2U8dW5rbm93bj47XG4gIGV4ZWN1dGVQbGFuTWlsZXN0b25lOiAoXG4gICAgcGFyYW1zOiB7XG4gICAgICBtaWxlc3RvbmVJZDogc3RyaW5nO1xuICAgICAgdGl0bGU6IHN0cmluZztcbiAgICAgIHZpc2lvbjogc3RyaW5nO1xuICAgICAgc2xpY2VzOiBBcnJheTx7XG4gICAgICAgIHNsaWNlSWQ6IHN0cmluZztcbiAgICAgICAgdGl0bGU6IHN0cmluZztcbiAgICAgICAgcmlzazogc3RyaW5nO1xuICAgICAgICBkZXBlbmRzOiBzdHJpbmdbXTtcbiAgICAgICAgZGVtbzogc3RyaW5nO1xuICAgICAgICBnb2FsOiBzdHJpbmc7XG4gICAgICAgIHN1Y2Nlc3NDcml0ZXJpYT86IHN0cmluZztcbiAgICAgICAgcHJvb2ZMZXZlbD86IHN0cmluZztcbiAgICAgICAgaW50ZWdyYXRpb25DbG9zdXJlPzogc3RyaW5nO1xuICAgICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0Pzogc3RyaW5nO1xuICAgICAgICBpc1NrZXRjaD86IGJvb2xlYW47XG4gICAgICAgIHNrZXRjaFNjb3BlPzogc3RyaW5nO1xuICAgICAgfT47XG4gICAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgICBkZXBlbmRzT24/OiBzdHJpbmdbXTtcbiAgICAgIHN1Y2Nlc3NDcml0ZXJpYT86IHN0cmluZ1tdO1xuICAgICAga2V5Umlza3M/OiBBcnJheTx7IHJpc2s6IHN0cmluZzsgd2h5SXRNYXR0ZXJzOiBzdHJpbmcgfT47XG4gICAgICBwcm9vZlN0cmF0ZWd5PzogQXJyYXk8eyByaXNrT3JVbmtub3duOiBzdHJpbmc7IHJldGlyZUluOiBzdHJpbmc7IHdoYXRXaWxsQmVQcm92ZW46IHN0cmluZyB9PjtcbiAgICAgIHZlcmlmaWNhdGlvbkNvbnRyYWN0Pzogc3RyaW5nO1xuICAgICAgdmVyaWZpY2F0aW9uSW50ZWdyYXRpb24/OiBzdHJpbmc7XG4gICAgICB2ZXJpZmljYXRpb25PcGVyYXRpb25hbD86IHN0cmluZztcbiAgICAgIHZlcmlmaWNhdGlvblVhdD86IHN0cmluZztcbiAgICAgIGRlZmluaXRpb25PZkRvbmU/OiBzdHJpbmdbXTtcbiAgICAgIHJlcXVpcmVtZW50Q292ZXJhZ2U/OiBzdHJpbmc7XG4gICAgICBib3VuZGFyeU1hcE1hcmtkb3duPzogc3RyaW5nO1xuICAgIH0sXG4gICAgYmFzZVBhdGg/OiBzdHJpbmcsXG4gICkgPT4gUHJvbWlzZTx1bmtub3duPjtcbiAgZXhlY3V0ZVBsYW5TbGljZTogKFxuICAgIHBhcmFtczoge1xuICAgICAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgICAgIHNsaWNlSWQ6IHN0cmluZztcbiAgICAgIGdvYWw6IHN0cmluZztcbiAgICAgIHRhc2tzOiBBcnJheTx7XG4gICAgICAgIHRhc2tJZDogc3RyaW5nO1xuICAgICAgICB0aXRsZTogc3RyaW5nO1xuICAgICAgICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICAgICAgICBlc3RpbWF0ZTogc3RyaW5nO1xuICAgICAgICBmaWxlczogc3RyaW5nW107XG4gICAgICAgIHZlcmlmeTogc3RyaW5nO1xuICAgICAgICBpbnB1dHM6IHN0cmluZ1tdO1xuICAgICAgICBleHBlY3RlZE91dHB1dDogc3RyaW5nW107XG4gICAgICAgIG9ic2VydmFiaWxpdHlJbXBhY3Q/OiBzdHJpbmc7XG4gICAgICB9PjtcbiAgICAgIHN1Y2Nlc3NDcml0ZXJpYT86IHN0cmluZztcbiAgICAgIHByb29mTGV2ZWw/OiBzdHJpbmc7XG4gICAgICBpbnRlZ3JhdGlvbkNsb3N1cmU/OiBzdHJpbmc7XG4gICAgICBvYnNlcnZhYmlsaXR5SW1wYWN0Pzogc3RyaW5nO1xuICAgIH0sXG4gICAgYmFzZVBhdGg/OiBzdHJpbmcsXG4gICkgPT4gUHJvbWlzZTx1bmtub3duPjtcbiAgZXhlY3V0ZVJlcGxhblNsaWNlOiAoXG4gICAgcGFyYW1zOiB7XG4gICAgICBtaWxlc3RvbmVJZDogc3RyaW5nO1xuICAgICAgc2xpY2VJZDogc3RyaW5nO1xuICAgICAgYmxvY2tlclRhc2tJZDogc3RyaW5nO1xuICAgICAgYmxvY2tlckRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gICAgICB3aGF0Q2hhbmdlZDogc3RyaW5nO1xuICAgICAgdXBkYXRlZFRhc2tzOiBBcnJheTx7XG4gICAgICAgIHRhc2tJZDogc3RyaW5nO1xuICAgICAgICB0aXRsZTogc3RyaW5nO1xuICAgICAgICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICAgICAgICBlc3RpbWF0ZTogc3RyaW5nO1xuICAgICAgICBmaWxlczogc3RyaW5nW107XG4gICAgICAgIHZlcmlmeTogc3RyaW5nO1xuICAgICAgICBpbnB1dHM6IHN0cmluZ1tdO1xuICAgICAgICBleHBlY3RlZE91dHB1dDogc3RyaW5nW107XG4gICAgICAgIGZ1bGxQbGFuTWQ/OiBzdHJpbmc7XG4gICAgICB9PjtcbiAgICAgIHJlbW92ZWRUYXNrSWRzOiBzdHJpbmdbXTtcbiAgICB9LFxuICAgIGJhc2VQYXRoPzogc3RyaW5nLFxuICApID0+IFByb21pc2U8dW5rbm93bj47XG4gIGV4ZWN1dGVTbGljZUNvbXBsZXRlOiAoXG4gICAgcGFyYW1zOiB7XG4gICAgICBzbGljZUlkOiBzdHJpbmc7XG4gICAgICBtaWxlc3RvbmVJZDogc3RyaW5nO1xuICAgICAgc2xpY2VUaXRsZTogc3RyaW5nO1xuICAgICAgb25lTGluZXI6IHN0cmluZztcbiAgICAgIG5hcnJhdGl2ZTogc3RyaW5nO1xuICAgICAgdmVyaWZpY2F0aW9uOiBzdHJpbmc7XG4gICAgICB1YXRDb250ZW50OiBzdHJpbmc7XG4gICAgICBkZXZpYXRpb25zPzogc3RyaW5nO1xuICAgICAga25vd25MaW1pdGF0aW9ucz86IHN0cmluZztcbiAgICAgIGZvbGxvd1Vwcz86IHN0cmluZztcbiAgICAgIGtleUZpbGVzPzogc3RyaW5nW10gfCBzdHJpbmc7XG4gICAgICBrZXlEZWNpc2lvbnM/OiBzdHJpbmdbXSB8IHN0cmluZztcbiAgICAgIHBhdHRlcm5zRXN0YWJsaXNoZWQ/OiBzdHJpbmdbXSB8IHN0cmluZztcbiAgICAgIG9ic2VydmFiaWxpdHlTdXJmYWNlcz86IHN0cmluZ1tdIHwgc3RyaW5nO1xuICAgICAgcHJvdmlkZXM/OiBzdHJpbmdbXSB8IHN0cmluZztcbiAgICAgIHJlcXVpcmVtZW50c1N1cmZhY2VkPzogc3RyaW5nW10gfCBzdHJpbmc7XG4gICAgICBkcmlsbERvd25QYXRocz86IHN0cmluZ1tdIHwgc3RyaW5nO1xuICAgICAgYWZmZWN0cz86IHN0cmluZ1tdIHwgc3RyaW5nO1xuICAgICAgcmVxdWlyZW1lbnRzQWR2YW5jZWQ/OiBBcnJheTx7IGlkOiBzdHJpbmc7IGhvdzogc3RyaW5nIH0gfCBzdHJpbmc+O1xuICAgICAgcmVxdWlyZW1lbnRzVmFsaWRhdGVkPzogQXJyYXk8eyBpZDogc3RyaW5nOyBwcm9vZjogc3RyaW5nIH0gfCBzdHJpbmc+O1xuICAgICAgcmVxdWlyZW1lbnRzSW52YWxpZGF0ZWQ/OiBBcnJheTx7IGlkOiBzdHJpbmc7IHdoYXQ6IHN0cmluZyB9IHwgc3RyaW5nPjtcbiAgICAgIGZpbGVzTW9kaWZpZWQ/OiBBcnJheTx7IHBhdGg6IHN0cmluZzsgZGVzY3JpcHRpb246IHN0cmluZyB9IHwgc3RyaW5nPjtcbiAgICAgIHJlcXVpcmVzPzogQXJyYXk8eyBzbGljZTogc3RyaW5nOyBwcm92aWRlczogc3RyaW5nIH0gfCBzdHJpbmc+O1xuICAgIH0sXG4gICAgYmFzZVBhdGg/OiBzdHJpbmcsXG4gICkgPT4gUHJvbWlzZTx1bmtub3duPjtcbiAgZXhlY3V0ZUNvbXBsZXRlTWlsZXN0b25lOiAoXG4gICAgcGFyYW1zOiB7XG4gICAgICBtaWxlc3RvbmVJZDogc3RyaW5nO1xuICAgICAgdGl0bGU6IHN0cmluZztcbiAgICAgIG9uZUxpbmVyOiBzdHJpbmc7XG4gICAgICBuYXJyYXRpdmU6IHN0cmluZztcbiAgICAgIHZlcmlmaWNhdGlvblBhc3NlZDogYm9vbGVhbjtcbiAgICAgIHN1Y2Nlc3NDcml0ZXJpYVJlc3VsdHM/OiBzdHJpbmc7XG4gICAgICBkZWZpbml0aW9uT2ZEb25lUmVzdWx0cz86IHN0cmluZztcbiAgICAgIHJlcXVpcmVtZW50T3V0Y29tZXM/OiBzdHJpbmc7XG4gICAgICBrZXlEZWNpc2lvbnM/OiBzdHJpbmdbXTtcbiAgICAgIGtleUZpbGVzPzogc3RyaW5nW107XG4gICAgICBsZXNzb25zTGVhcm5lZD86IHN0cmluZ1tdO1xuICAgICAgZm9sbG93VXBzPzogc3RyaW5nO1xuICAgICAgZGV2aWF0aW9ucz86IHN0cmluZztcbiAgICB9LFxuICAgIGJhc2VQYXRoPzogc3RyaW5nLFxuICApID0+IFByb21pc2U8dW5rbm93bj47XG4gIGV4ZWN1dGVWYWxpZGF0ZU1pbGVzdG9uZTogKFxuICAgIHBhcmFtczoge1xuICAgICAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgICAgIHZlcmRpY3Q6IFwicGFzc1wiIHwgXCJuZWVkcy1hdHRlbnRpb25cIiB8IFwibmVlZHMtcmVtZWRpYXRpb25cIjtcbiAgICAgIHJlbWVkaWF0aW9uUm91bmQ6IG51bWJlcjtcbiAgICAgIHN1Y2Nlc3NDcml0ZXJpYUNoZWNrbGlzdDogc3RyaW5nO1xuICAgICAgc2xpY2VEZWxpdmVyeUF1ZGl0OiBzdHJpbmc7XG4gICAgICBjcm9zc1NsaWNlSW50ZWdyYXRpb246IHN0cmluZztcbiAgICAgIHJlcXVpcmVtZW50Q292ZXJhZ2U6IHN0cmluZztcbiAgICAgIHZlcmlmaWNhdGlvbkNsYXNzZXM/OiBzdHJpbmc7XG4gICAgICB2ZXJkaWN0UmF0aW9uYWxlOiBzdHJpbmc7XG4gICAgICByZW1lZGlhdGlvblBsYW4/OiBzdHJpbmc7XG4gICAgfSxcbiAgICBiYXNlUGF0aD86IHN0cmluZyxcbiAgKSA9PiBQcm9taXNlPHVua25vd24+O1xuICBleGVjdXRlUmVhc3Nlc3NSb2FkbWFwOiAoXG4gICAgcGFyYW1zOiB7XG4gICAgICBtaWxlc3RvbmVJZDogc3RyaW5nO1xuICAgICAgY29tcGxldGVkU2xpY2VJZDogc3RyaW5nO1xuICAgICAgdmVyZGljdDogc3RyaW5nO1xuICAgICAgYXNzZXNzbWVudDogc3RyaW5nO1xuICAgICAgc2xpY2VDaGFuZ2VzOiB7XG4gICAgICAgIG1vZGlmaWVkOiBBcnJheTx7XG4gICAgICAgICAgc2xpY2VJZDogc3RyaW5nO1xuICAgICAgICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgICAgICAgcmlzaz86IHN0cmluZztcbiAgICAgICAgICBkZXBlbmRzPzogc3RyaW5nW107XG4gICAgICAgICAgZGVtbz86IHN0cmluZztcbiAgICAgICAgfT47XG4gICAgICAgIGFkZGVkOiBBcnJheTx7XG4gICAgICAgICAgc2xpY2VJZDogc3RyaW5nO1xuICAgICAgICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgICAgICAgcmlzaz86IHN0cmluZztcbiAgICAgICAgICBkZXBlbmRzPzogc3RyaW5nW107XG4gICAgICAgICAgZGVtbz86IHN0cmluZztcbiAgICAgICAgfT47XG4gICAgICAgIHJlbW92ZWQ6IHN0cmluZ1tdO1xuICAgICAgfTtcbiAgICB9LFxuICAgIGJhc2VQYXRoPzogc3RyaW5nLFxuICApID0+IFByb21pc2U8dW5rbm93bj47XG4gIGV4ZWN1dGVTYXZlR2F0ZVJlc3VsdDogKFxuICAgIHBhcmFtczoge1xuICAgICAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgICAgIHNsaWNlSWQ6IHN0cmluZztcbiAgICAgIGdhdGVJZDogc3RyaW5nO1xuICAgICAgdGFza0lkPzogc3RyaW5nO1xuICAgICAgdmVyZGljdDogXCJwYXNzXCIgfCBcImZsYWdcIiB8IFwib21pdHRlZFwiO1xuICAgICAgcmF0aW9uYWxlOiBzdHJpbmc7XG4gICAgICBmaW5kaW5ncz86IHN0cmluZztcbiAgICB9LFxuICAgIGJhc2VQYXRoPzogc3RyaW5nLFxuICApID0+IFByb21pc2U8dW5rbm93bj47XG4gIGV4ZWN1dGVTdW1tYXJ5U2F2ZTogKFxuICAgIHBhcmFtczoge1xuICAgICAgbWlsZXN0b25lX2lkPzogc3RyaW5nO1xuICAgICAgc2xpY2VfaWQ/OiBzdHJpbmc7XG4gICAgICB0YXNrX2lkPzogc3RyaW5nO1xuICAgICAgYXJ0aWZhY3RfdHlwZTogc3RyaW5nO1xuICAgICAgY29udGVudDogc3RyaW5nO1xuICAgIH0sXG4gICAgYmFzZVBhdGg/OiBzdHJpbmcsXG4gICkgPT4gUHJvbWlzZTx1bmtub3duPjtcbiAgZXhlY3V0ZVRhc2tDb21wbGV0ZTogKFxuICAgIHBhcmFtczoge1xuICAgICAgdGFza0lkOiBzdHJpbmc7XG4gICAgICBzbGljZUlkOiBzdHJpbmc7XG4gICAgICBtaWxlc3RvbmVJZDogc3RyaW5nO1xuICAgICAgb25lTGluZXI6IHN0cmluZztcbiAgICAgIG5hcnJhdGl2ZTogc3RyaW5nO1xuICAgICAgdmVyaWZpY2F0aW9uOiBzdHJpbmc7XG4gICAgICBkZXZpYXRpb25zPzogc3RyaW5nO1xuICAgICAga25vd25Jc3N1ZXM/OiBzdHJpbmc7XG4gICAgICBrZXlGaWxlcz86IHN0cmluZ1tdO1xuICAgICAga2V5RGVjaXNpb25zPzogc3RyaW5nW107XG4gICAgICBibG9ja2VyRGlzY292ZXJlZD86IGJvb2xlYW47XG4gICAgICBlc2NhbGF0aW9uPzoge1xuICAgICAgICBxdWVzdGlvbjogc3RyaW5nO1xuICAgICAgICBvcHRpb25zOiBBcnJheTx7IGlkOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IHRyYWRlb2Zmczogc3RyaW5nIH0+O1xuICAgICAgICByZWNvbW1lbmRhdGlvbjogc3RyaW5nO1xuICAgICAgICByZWNvbW1lbmRhdGlvblJhdGlvbmFsZTogc3RyaW5nO1xuICAgICAgICBjb250aW51ZVdpdGhEZWZhdWx0OiBib29sZWFuO1xuICAgICAgfTtcbiAgICAgIHZlcmlmaWNhdGlvbkV2aWRlbmNlPzogQXJyYXk8XG4gICAgICAgIHsgY29tbWFuZDogc3RyaW5nOyBleGl0Q29kZTogbnVtYmVyOyB2ZXJkaWN0OiBzdHJpbmc7IGR1cmF0aW9uTXM6IG51bWJlciB9IHwgc3RyaW5nXG4gICAgICA+O1xuICAgIH0sXG4gICAgYmFzZVBhdGg/OiBzdHJpbmcsXG4gICkgPT4gUHJvbWlzZTx1bmtub3duPjtcbiAgZXhlY3V0ZVRhc2tSZW9wZW46IChcbiAgICBwYXJhbXM6IHtcbiAgICAgIHRhc2tJZDogc3RyaW5nO1xuICAgICAgc2xpY2VJZDogc3RyaW5nO1xuICAgICAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgICAgIHJlYXNvbj86IHN0cmluZztcbiAgICAgIGFjdG9yTmFtZT86IHN0cmluZztcbiAgICAgIHRyaWdnZXJSZWFzb24/OiBzdHJpbmc7XG4gICAgfSxcbiAgICBiYXNlUGF0aD86IHN0cmluZyxcbiAgKSA9PiBQcm9taXNlPHVua25vd24+O1xuICBleGVjdXRlU2xpY2VSZW9wZW46IChcbiAgICBwYXJhbXM6IHtcbiAgICAgIHNsaWNlSWQ6IHN0cmluZztcbiAgICAgIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gICAgICByZWFzb24/OiBzdHJpbmc7XG4gICAgICBhY3Rvck5hbWU/OiBzdHJpbmc7XG4gICAgICB0cmlnZ2VyUmVhc29uPzogc3RyaW5nO1xuICAgIH0sXG4gICAgYmFzZVBhdGg/OiBzdHJpbmcsXG4gICkgPT4gUHJvbWlzZTx1bmtub3duPjtcbiAgZXhlY3V0ZU1pbGVzdG9uZVJlb3BlbjogKFxuICAgIHBhcmFtczoge1xuICAgICAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgICAgIHJlYXNvbj86IHN0cmluZztcbiAgICAgIGFjdG9yTmFtZT86IHN0cmluZztcbiAgICAgIHRyaWdnZXJSZWFzb24/OiBzdHJpbmc7XG4gICAgfSxcbiAgICBiYXNlUGF0aD86IHN0cmluZyxcbiAgKSA9PiBQcm9taXNlPHVua25vd24+O1xufTtcblxudHlwZSBXb3JrZmxvd1dyaXRlR2F0ZU1vZHVsZSA9IHtcbiAgbG9hZFdyaXRlR2F0ZVNuYXBzaG90OiAoYmFzZVBhdGg6IHN0cmluZykgPT4ge1xuICAgIHZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzOiBzdHJpbmdbXTtcbiAgICBhY3RpdmVRdWV1ZVBoYXNlOiBib29sZWFuO1xuICAgIHBlbmRpbmdHYXRlSWQ6IHN0cmluZyB8IG51bGw7XG4gIH07XG4gIHNob3VsZEJsb2NrUGVuZGluZ0dhdGVJblNuYXBzaG90OiAoXG4gICAgc25hcHNob3Q6IHtcbiAgICAgIHZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzOiBzdHJpbmdbXTtcbiAgICAgIGFjdGl2ZVF1ZXVlUGhhc2U6IGJvb2xlYW47XG4gICAgICBwZW5kaW5nR2F0ZUlkOiBzdHJpbmcgfCBudWxsO1xuICAgIH0sXG4gICAgdG9vbE5hbWU6IHN0cmluZyxcbiAgICBtaWxlc3RvbmVJZDogc3RyaW5nIHwgbnVsbCxcbiAgICBxdWV1ZVBoYXNlQWN0aXZlPzogYm9vbGVhbixcbiAgKSA9PiB7IGJsb2NrOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfTtcbiAgc2hvdWxkQmxvY2tRdWV1ZUV4ZWN1dGlvbkluU25hcHNob3Q6IChcbiAgICBzbmFwc2hvdDoge1xuICAgICAgdmVyaWZpZWREZXB0aE1pbGVzdG9uZXM6IHN0cmluZ1tdO1xuICAgICAgYWN0aXZlUXVldWVQaGFzZTogYm9vbGVhbjtcbiAgICAgIHBlbmRpbmdHYXRlSWQ6IHN0cmluZyB8IG51bGw7XG4gICAgfSxcbiAgICB0b29sTmFtZTogc3RyaW5nLFxuICAgIGlucHV0OiBzdHJpbmcsXG4gICAgcXVldWVQaGFzZUFjdGl2ZT86IGJvb2xlYW4sXG4gICkgPT4geyBibG9jazogYm9vbGVhbjsgcmVhc29uPzogc3RyaW5nIH07XG59O1xuXG50eXBlIFdvcmtmbG93RGJCb290c3RyYXBNb2R1bGUgPSB7XG4gIGVuc3VyZURiT3BlbjogKGJhc2VQYXRoPzogc3RyaW5nKSA9PiBQcm9taXNlPGJvb2xlYW4+O1xufTtcblxubGV0IHdvcmtmbG93VG9vbEV4ZWN1dG9yc1Byb21pc2U6IFByb21pc2U8V29ya2Zsb3dUb29sRXhlY3V0b3JzPiB8IG51bGwgPSBudWxsO1xubGV0IHdvcmtmbG93RXhlY3V0aW9uUXVldWU6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcbmxldCB3b3JrZmxvd1dyaXRlR2F0ZVByb21pc2U6IFByb21pc2U8V29ya2Zsb3dXcml0ZUdhdGVNb2R1bGU+IHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIGdldEFsbG93ZWRQcm9qZWN0Um9vdChlbnY6IE5vZGVKUy5Qcm9jZXNzRW52ID0gcHJvY2Vzcy5lbnYpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgY29uZmlndXJlZFJvb3QgPSBlbnYuR1NEX1dPUktGTE9XX1BST0pFQ1RfUk9PVD8udHJpbSgpO1xuICByZXR1cm4gY29uZmlndXJlZFJvb3QgPyByZXNvbHZlKGNvbmZpZ3VyZWRSb290KSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzV2l0aGluUm9vdChjYW5kaWRhdGVQYXRoOiBzdHJpbmcsIHJvb3RQYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgcmVsID0gcmVsYXRpdmUocm9vdFBhdGgsIGNhbmRpZGF0ZVBhdGgpO1xuICByZXR1cm4gcmVsID09PSBcIlwiIHx8ICghcmVsLnN0YXJ0c1dpdGgoXCIuLlwiKSAmJiAhaXNBYnNvbHV0ZShyZWwpKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBzeW1saW5rIHRhcmdldCBvZiBgPGFsbG93ZWRSb290Pi8uZ3NkYCB3aGVuIGl0IHBvaW50cyBpbnRvIHRoZVxuICogZXh0ZXJuYWwgc3RhdGUgbGF5b3V0IChgfi8uZ3NkL3Byb2plY3RzLzxoYXNoPi9gKS4gUmV0dXJucyB0aGUgcmVhbHBhdGggb2ZcbiAqIHRoYXQgdGFyZ2V0IHNvIGNhbGxlcnMgY2FuIGFjY2VwdCB3b3JrdHJlZSBwYXRocyB0aGF0IGxpdmUgdW5kZXJcbiAqIGA8ZXh0ZXJuYWwtc3RhdGU+L3dvcmt0cmVlcy88TUlEPi9gLiBSZXR1cm5zIG51bGwgd2hlbiBgLmdzZGAgaXMgYWJzZW50IG9yXG4gKiByZXNvbHV0aW9uIGZhaWxzIFx1MjAxNCB0aGUgY2FsbGVyIHNob3VsZCBmYWxsIGJhY2sgdG8gdGhlIGRpcmVjdCBjb250YWlubWVudFxuICogY2hlY2sgaW4gdGhhdCBjYXNlLlxuICovXG5mdW5jdGlvbiByZXNvbHZlRXh0ZXJuYWxTdGF0ZVJvb3QoYWxsb3dlZFJvb3Q6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIHJldHVybiByZWFscGF0aFN5bmMoam9pbihhbGxvd2VkUm9vdCwgXCIuZ3NkXCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlUHJvamVjdERpcihwcm9qZWN0RGlyOiBzdHJpbmcsIGVudjogTm9kZUpTLlByb2Nlc3NFbnYgPSBwcm9jZXNzLmVudik6IHN0cmluZyB7XG4gIGlmICghaXNBYnNvbHV0ZShwcm9qZWN0RGlyKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgcHJvamVjdERpciBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGguIFJlY2VpdmVkOiAke3Byb2plY3REaXJ9YCk7XG4gIH1cblxuICBjb25zdCBsZXhpY2FsbHlSZXNvbHZlZCA9IHJlc29sdmUocHJvamVjdERpcik7XG4gIC8vIFJlc29sdmUgc3ltbGlua3Mgb24gdGhlIGNhbmRpZGF0ZSBiZWZvcmUgdGhlIGNvbnRhaW5tZW50IGNoZWNrIHNvIHRoYXQgYVxuICAvLyBzeW1saW5rIGluc2lkZSB0aGUgYWxsb3dlZCByb290IHBvaW50aW5nIG91dHNpZGUgb2YgaXQgY2Fubm90IGJ5cGFzcyB0aGVcbiAgLy8gZ3VhcmQuIEZhbGxzIGJhY2sgdG8gdGhlIGxleGljYWwgcGF0aCBpZiB0aGUgY2FuZGlkYXRlIGRvZXMgbm90IGV4aXN0IHlldFxuICAvLyAobGVnaXRpbWF0ZSBmb3IgYSBicmFuZC1uZXcgd29ya3RyZWUgZGlyIGFib3V0IHRvIGJlIGNyZWF0ZWQpLlxuICBjb25zdCByZXNvbHZlZFByb2plY3REaXIgPSBzYWZlUmVhbHBhdGgobGV4aWNhbGx5UmVzb2x2ZWQpO1xuXG4gIGNvbnN0IGFsbG93ZWRSb290ID0gZ2V0QWxsb3dlZFByb2plY3RSb290KGVudik7XG4gIGlmICghYWxsb3dlZFJvb3QpIHJldHVybiByZXNvbHZlZFByb2plY3REaXI7XG5cbiAgY29uc3QgcmVzb2x2ZWRBbGxvd2VkUm9vdCA9IHNhZmVSZWFscGF0aChhbGxvd2VkUm9vdCk7XG4gIGlmIChpc1dpdGhpblJvb3QocmVzb2x2ZWRQcm9qZWN0RGlyLCByZXNvbHZlZEFsbG93ZWRSb290KSkgcmV0dXJuIHJlc29sdmVkUHJvamVjdERpcjtcblxuICAvLyBFeHRlcm5hbCBzdGF0ZSBsYXlvdXQ6IGA8YWxsb3dlZFJvb3Q+Ly5nc2RgIG1heSBiZSBhIHN5bWxpbmsgaW50b1xuICAvLyBgfi8uZ3NkL3Byb2plY3RzLzxoYXNoPi9gLCBhbmQgYXV0by13b3JrdHJlZXMgbGl2ZSB1bmRlclxuICAvLyBgfi8uZ3NkL3Byb2plY3RzLzxoYXNoPi93b3JrdHJlZXMvPE1JRD4vYC4gQWNjZXB0IGNhbmRpZGF0ZXMgdGhhdCBhcmVcbiAgLy8gdW5kZXIgdGhlIHJlYWxwYXRoIG9mIGA8YWxsb3dlZFJvb3Q+Ly5nc2RgIFx1MjAxNCB0aGV5IGJlbG9uZyB0byB0aGlzIHByb2plY3RcbiAgLy8gZXZlbiB0aG91Z2ggdGhlaXIgYWJzb2x1dGUgcGF0aCBpcyBvdXRzaWRlIGFsbG93ZWRSb290ICgjaXNzdWUtYTQ0KS5cbiAgY29uc3QgZXh0ZXJuYWxSb290ID0gcmVzb2x2ZUV4dGVybmFsU3RhdGVSb290KHJlc29sdmVkQWxsb3dlZFJvb3QpO1xuICBpZiAoZXh0ZXJuYWxSb290ICYmIGlzV2l0aGluUm9vdChyZXNvbHZlZFByb2plY3REaXIsIGV4dGVybmFsUm9vdCkpIHtcbiAgICByZXR1cm4gcmVzb2x2ZWRQcm9qZWN0RGlyO1xuICB9XG5cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIGBwcm9qZWN0RGlyIG11c3Qgc3RheSB3aXRoaW4gdGhlIGNvbmZpZ3VyZWQgd29ya2Zsb3cgcHJvamVjdCByb290LiBSZWNlaXZlZDogJHtyZXNvbHZlZFByb2plY3REaXJ9OyBhbGxvd2VkIHJvb3Q6ICR7cmVzb2x2ZWRBbGxvd2VkUm9vdH1gLFxuICApO1xufVxuXG5mdW5jdGlvbiBzYWZlUmVhbHBhdGgocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhbHBhdGhTeW5jKHBhdGgpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBPbmx5IGZhbGwgYmFjayBmb3Igbm9uLWV4aXN0ZW50IHBhdGhzIFx1MjAxNCBhIGxlZ2l0aW1hdGUgY2FzZSB3aGVuIGEgd29ya3RyZWVcbiAgICAvLyBkaXJlY3RvcnkgaGFzbid0IGJlZW4gY3JlYXRlZCB5ZXQuIFBlcm1pc3Npb24gZXJyb3JzIChFQUNDRVMpLCBub3QtYS1cbiAgICAvLyBkaXJlY3RvcnkgKEVOT1RESVIpLCBldGMuIG11c3QgcHJvcGFnYXRlIHNvIHdlIGRvIG5vdCBzaWxlbnRseSBkZWdyYWRlXG4gICAgLy8gdG8gYSBsZXhpY2FsLW9ubHkgY29udGFpbm1lbnQgY2hlY2sgdGhhdCBhIHJlc3RyaWN0ZWQgc3ltbGluayBjb3VsZFxuICAgIC8vIGJ5cGFzcy5cbiAgICBpZiAoKGVyciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pPy5jb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gcGF0aDtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuZnVuY3Rpb24gcGFyc2VUb29sQXJnczxUPihzY2hlbWE6IHouWm9kVHlwZTxUPiwgYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBUIHtcbiAgcmV0dXJuIHNjaGVtYS5wYXJzZShhcmdzKTtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IGEgbWlsZXN0b25lIElEIGZyb20gcGFyc2VkIHRvb2wgYXJncywgdHJ5aW5nIGNvbW1vbiBmaWVsZCBuYW1lcy5cbiAqIFJldHVybnMgbnVsbCB3aGVuIG5vIGZpZWxkIGlzIHByZXNlbnQgb3IgdGhlIHZhbHVlIGlzIG5vdCBhIHN0cmluZy5cbiAqL1xuZnVuY3Rpb24gZXh0cmFjdE1pbGVzdG9uZUlkKHBhcnNlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IFtwYXJzZWQubWlsZXN0b25lSWQsIHBhcnNlZC5taWxlc3RvbmVfaWQsIHBhcnNlZC5taWRdO1xuICBmb3IgKGNvbnN0IGMgb2YgY2FuZGlkYXRlcykge1xuICAgIGlmICh0eXBlb2YgYyA9PT0gXCJzdHJpbmdcIiAmJiBjLnRyaW0oKSAhPT0gXCJcIikgcmV0dXJuIGMudHJpbSgpO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIElmIGFuIGF1dG8td29ya3RyZWUgZXhpc3RzIGZvciB0aGUgZ2l2ZW4gbWlsZXN0b25lIHVuZGVyXG4gKiBgPHByb2plY3RSb290Pi8uZ3NkL3dvcmt0cmVlcy88bWlsZXN0b25lSWQ+L2AsIHJldHVybiB0aGF0IHBhdGggYXMgdGhlXG4gKiBiYXNlUGF0aCB0aGUgdG9vbCBzaG91bGQgd3JpdGUgYWdhaW5zdC4gUmV0dXJucyBudWxsIHdoZW4gbm8gd29ya3RyZWVcbiAqIGV4aXN0cyBmb3IgdGhpcyBtaWxlc3RvbmUsIGxlYXZpbmcgdGhlIGNhbGxlciB0byB1c2UgdGhlIHByb2plY3Qgcm9vdC5cbiAqXG4gKiBUaGlzIHVuYnJlYWtzIHRoZSBleHRlcm5hbC1zdGF0ZSBsYXlvdXQgd2hlcmUgdGhlIE1DUCBzZXJ2ZXIncyBwcm9jZXNzLmN3ZCgpXG4gKiBpcyB0aGUgcHJvamVjdCByb290IChzZXQgYXQgQ2xhdWRlIENvZGUgbGF1bmNoKSBidXQgYXV0by1tb2RlIGlzIGFjdHVhbGx5XG4gKiB3b3JraW5nIGluc2lkZSBhIHBlci1taWxlc3RvbmUgd29ya3RyZWUuIFdpdGhvdXQgdGhpcywgdG9vbCB3cml0ZXMgZ28gdG9cbiAqIHRoZSBzaGFyZWQgcHJvamVjdCBgLmdzZC9gIGFuZCBhdXRvLW1vZGUncyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0ICh3aGljaFxuICogdXNlcyB0aGUgd29ya3RyZWUgYC5nc2QvYCkgZmFpbHMsIHRyaWdnZXJpbmcgYSBndWFyYW50ZWVkIHJldHJ5IHBlciB1bml0LlxuICovXG5mdW5jdGlvbiByZXNvbHZlQWN0aXZlV29ya3RyZWVCYXNlUGF0aChcbiAgcHJvamVjdFJvb3Q6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFtaWxlc3RvbmVJZCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHd0UGF0aCA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBtaWxlc3RvbmVJZCk7XG4gIGlmICghZXhpc3RzU3luYyh3dFBhdGgpKSByZXR1cm4gbnVsbDtcbiAgLy8gU2FuaXR5IGNoZWNrOiBhIHJlYWwgZ2l0IHdvcmt0cmVlIGhhcyBhIGAuZ2l0YCBmaWxlIHdpdGggYSBnaXRkaXIgcG9pbnRlci5cbiAgLy8gQmFyZSBkaXJlY3RvcmllcyB3aXRob3V0IGl0IHNob3VsZG4ndCBoaWphY2sgdGhlIHdyaXRlIHBhdGguXG4gIGlmICghZXhpc3RzU3luYyhqb2luKHd0UGF0aCwgXCIuZ2l0XCIpKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB3dFBhdGg7XG59XG5cbi8qKlxuICogRmFsbGJhY2sgd2hlbiB0aGUgdG9vbCBjYWxsIGhhcyBubyBtaWxlc3RvbmVJZDogaWYgZXhhY3RseSBvbmUgYXV0by13b3JrdHJlZVxuICogZXhpc3RzIHVuZGVyIGA8cHJvamVjdFJvb3Q+Ly5nc2Qvd29ya3RyZWVzL2AsIHRyZWF0IGl0IGFzIHRoZSBhY3RpdmUgb25lLlxuICogTXVsdGlwbGUgd29ya3RyZWVzIFx1MjE5MiBhbWJpZ3VvdXMsIHJldHVybiBudWxsIGFuZCBsZXQgd3JpdGVzIGdvIHRvIHByb2plY3Qgcm9vdC5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZVNvbGVBY3RpdmVXb3JrdHJlZShwcm9qZWN0Um9vdDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IHdvcmt0cmVlc0RpciA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiKTtcbiAgaWYgKCFleGlzdHNTeW5jKHdvcmt0cmVlc0RpcikpIHJldHVybiBudWxsO1xuICBsZXQgZW50cmllczogc3RyaW5nW107XG4gIHRyeSB7XG4gICAgZW50cmllcyA9IHJlYWRkaXJTeW5jKHdvcmt0cmVlc0Rpcik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNvbnN0IGxpdmUgPSBlbnRyaWVzXG4gICAgLm1hcCgobmFtZSkgPT4gam9pbih3b3JrdHJlZXNEaXIsIG5hbWUpKVxuICAgIC5maWx0ZXIoKHApID0+IGV4aXN0c1N5bmMoam9pbihwLCBcIi5naXRcIikpKTtcbiAgaWYgKGxpdmUubGVuZ3RoICE9PSAxKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGxpdmVbMF07XG59XG5cbmZ1bmN0aW9uIGlzSG9tZURpcmVjdG9yeShjYW5kaWRhdGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBsZXQgcmVzb2x2ZWRIb21lOiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgcmVzb2x2ZWRIb21lID0gcmVhbHBhdGhTeW5jKHJlc29sdmUoaG9tZWRpcigpKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJlc29sdmVkSG9tZSA9IHJlc29sdmUoaG9tZWRpcigpKTtcbiAgfVxuICBsZXQgcmVzb2x2ZWRDYW5kaWRhdGU6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByZXNvbHZlZENhbmRpZGF0ZSA9IHJlYWxwYXRoU3luYyhyZXNvbHZlKGNhbmRpZGF0ZSkpO1xuICB9IGNhdGNoIHtcbiAgICByZXNvbHZlZENhbmRpZGF0ZSA9IHJlc29sdmUoY2FuZGlkYXRlKTtcbiAgfVxuICByZXR1cm4gcmVzb2x2ZWRDYW5kaWRhdGUgPT09IHJlc29sdmVkSG9tZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9wYXJzZVdvcmtmbG93QXJnc0ZvclRlc3Q8VCBleHRlbmRzIHsgcHJvamVjdERpcj86IHN0cmluZyB9PihcbiAgc2NoZW1hOiB6LlpvZFR5cGU8VD4sXG4gIGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuKTogVCAmIHsgcHJvamVjdERpcjogc3RyaW5nIH0ge1xuICByZXR1cm4gcGFyc2VXb3JrZmxvd0FyZ3Moc2NoZW1hLCBhcmdzKTtcbn1cblxuZnVuY3Rpb24gcGFyc2VXb3JrZmxvd0FyZ3M8VCBleHRlbmRzIHsgcHJvamVjdERpcj86IHN0cmluZyB9PihcbiAgc2NoZW1hOiB6LlpvZFR5cGU8VD4sXG4gIGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuKTogVCAmIHsgcHJvamVjdERpcjogc3RyaW5nIH0ge1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVRvb2xBcmdzKHNjaGVtYSwgYXJncyk7XG4gIC8vIFN0ZXAgMTogZmlndXJlIG91dCB0aGUgcHJvamVjdCByb290LiBUaGUgYWdlbnQgc2hvdWxkbid0IG5lZWQgdG8gcGFzc1xuICAvLyBwcm9qZWN0RGlyIFx1MjAxNCBkZWZhdWx0IHRvIHByb2Nlc3MuY3dkKCkgd2hpY2ggdGhlIE1DUCBzZXJ2ZXIgaW5oZXJpdGVkIGZyb21cbiAgLy8gQ2xhdWRlIENvZGUgKGxhdW5jaGVkIGF0IHRoZSBwcm9qZWN0IHJvb3QpLlxuICBjb25zdCBwcm9qZWN0Um9vdENhbmRpZGF0ZSA9IHBhcnNlZC5wcm9qZWN0RGlyID8/IHByb2Nlc3MuY3dkKCk7XG5cbiAgLy8gRGVmZW5zZS1pbi1kZXB0aDogcmVmdXNlIHdoZW4gdGhlIHJlc29sdmVkIGNhbmRpZGF0ZSBpcyB0aGUgdXNlcidzIGhvbWVcbiAgLy8gZGlyZWN0b3J5LiBUaGUgTUNQIHNlcnZlcidzIHByb2Nlc3MuY3dkKCkgY2FuIGJlICRIT01FIGlmIGxhdW5jaGVkIGZyb21cbiAgLy8gYW4gdW51c3VhbCBjb250ZXh0OyBob25vcmluZyBpdCB3b3VsZCB3cml0ZSBwcm9qZWN0IGFydGlmYWN0cyBpbnRvIH4vLmdzZC5cbiAgaWYgKGlzSG9tZURpcmVjdG9yeShwcm9qZWN0Um9vdENhbmRpZGF0ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgcHJvamVjdERpciByZXNvbHZlcyB0byB0aGUgdXNlcidzIGhvbWUgZGlyZWN0b3J5ICgke3Byb2plY3RSb290Q2FuZGlkYXRlfSkuIGAgK1xuICAgICAgYFJ1biB0aGUgd29ya2Zsb3cgdG9vbCBmcm9tIGluc2lkZSBhIHByb2plY3QgZGlyZWN0b3J5LCBvciBwYXNzIGFuIGV4cGxpY2l0IHByb2plY3REaXIuYCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcHJvamVjdFJvb3QgPSB2YWxpZGF0ZVByb2plY3REaXIocHJvamVjdFJvb3RDYW5kaWRhdGUpO1xuXG4gIC8vIFN0ZXAgMjogaWYgdGhpcyB0b29sIGNhbGwgaXMgc2NvcGVkIHRvIGEgbWlsZXN0b25lIHRoYXQgaGFzIGFuIGFjdGl2ZVxuICAvLyBhdXRvLXdvcmt0cmVlLCByZS1yb3V0ZSB3cml0ZXMgdG8gdGhlIHdvcmt0cmVlJ3MgLmdzZCByYXRoZXIgdGhhbiB0aGVcbiAgLy8gcHJvamVjdCdzIHNoYXJlZCAuZ3NkLiBhdXRvLW1vZGUncyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IHJ1bnMgYWdhaW5zdFxuICAvLyB0aGUgd29ya3RyZWUsIGFuZCBhIG1pc21hdGNoIGhlcmUgY2F1c2VzIGV2ZXJ5IHVuaXQgdG8gcmV0cnkgb25jZS5cbiAgLy8gV2hlbiB0aGUgYWdlbnQgb21pdHMgbWlsZXN0b25lSWQsIGZhbGwgYmFjayB0byB0aGUgc29sZSBsaXZlIHdvcmt0cmVlXG4gIC8vIGlmIGV4YWN0bHkgb25lIGV4aXN0cyBcdTIwMTQgdGhhdCdzIHRoZSBhY3RpdmUgYXV0by1tb2RlIHNlc3Npb24uXG4gIGNvbnN0IG1pbGVzdG9uZUlkID0gZXh0cmFjdE1pbGVzdG9uZUlkKHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gIGNvbnN0IHdvcmt0cmVlQmFzZVBhdGggPSByZXNvbHZlQWN0aXZlV29ya3RyZWVCYXNlUGF0aChwcm9qZWN0Um9vdCwgbWlsZXN0b25lSWQpXG4gICAgPz8gKG1pbGVzdG9uZUlkID8gbnVsbCA6IHJlc29sdmVTb2xlQWN0aXZlV29ya3RyZWUocHJvamVjdFJvb3QpKTtcbiAgY29uc3QgZWZmZWN0aXZlQmFzZVBhdGggPSB3b3JrdHJlZUJhc2VQYXRoID8/IHByb2plY3RSb290O1xuXG4gIHJldHVybiB7XG4gICAgLi4ucGFyc2VkLFxuICAgIHByb2plY3REaXI6IGVmZmVjdGl2ZUJhc2VQYXRoLFxuICB9O1xufVxuXG5mdW5jdGlvbiBpc1dvcmtmbG93VG9vbEV4ZWN1dG9ycyh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFdvcmtmbG93VG9vbEV4ZWN1dG9ycyB7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHJlY29yZCA9IHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBjb25zdCBmdW5jdGlvbkV4cG9ydHMgPSBbXG4gICAgXCJleGVjdXRlTWlsZXN0b25lU3RhdHVzXCIsXG4gICAgXCJleGVjdXRlUGxhbk1pbGVzdG9uZVwiLFxuICAgIFwiZXhlY3V0ZVBsYW5TbGljZVwiLFxuICAgIFwiZXhlY3V0ZVJlcGxhblNsaWNlXCIsXG4gICAgXCJleGVjdXRlU2xpY2VDb21wbGV0ZVwiLFxuICAgIFwiZXhlY3V0ZUNvbXBsZXRlTWlsZXN0b25lXCIsXG4gICAgXCJleGVjdXRlVmFsaWRhdGVNaWxlc3RvbmVcIixcbiAgICBcImV4ZWN1dGVSZWFzc2Vzc1JvYWRtYXBcIixcbiAgICBcImV4ZWN1dGVTYXZlR2F0ZVJlc3VsdFwiLFxuICAgIFwiZXhlY3V0ZVN1bW1hcnlTYXZlXCIsXG4gICAgXCJleGVjdXRlVGFza0NvbXBsZXRlXCIsXG4gICAgXCJleGVjdXRlVGFza1Jlb3BlblwiLFxuICAgIFwiZXhlY3V0ZVNsaWNlUmVvcGVuXCIsXG4gICAgXCJleGVjdXRlTWlsZXN0b25lUmVvcGVuXCIsXG4gIF07XG5cbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkocmVjb3JkLlNVUFBPUlRFRF9TVU1NQVJZX0FSVElGQUNUX1RZUEVTKSAmJlxuICAgIGZ1bmN0aW9uRXhwb3J0cy5ldmVyeSgoa2V5KSA9PiB0eXBlb2YgcmVjb3JkW2tleV0gPT09IFwiZnVuY3Rpb25cIik7XG59XG5cbmZ1bmN0aW9uIGdldFN1cHBvcnRlZFN1bW1hcnlBcnRpZmFjdFR5cGVzKGV4ZWN1dG9yczogV29ya2Zsb3dUb29sRXhlY3V0b3JzKTogcmVhZG9ubHkgc3RyaW5nW10ge1xuICByZXR1cm4gZXhlY3V0b3JzLlNVUFBPUlRFRF9TVU1NQVJZX0FSVElGQUNUX1RZUEVTO1xufVxuXG5mdW5jdGlvbiBidWlsZEltcG9ydENhbmRpZGF0ZXMocmVsYXRpdmVQYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHB1c2hQcmVmZXJyZWRQYWlyID0gKHBhdGg6IHN0cmluZyB8IG51bGwpID0+IHtcbiAgICBpZiAoIXBhdGgpIHJldHVybjtcbiAgICBpZiAocGF0aC5lbmRzV2l0aChcIi5qc1wiKSkgY2FuZGlkYXRlcy5wdXNoKHBhdGgucmVwbGFjZSgvXFwuanMkLywgXCIudHNcIikpO1xuICAgIGNhbmRpZGF0ZXMucHVzaChwYXRoKTtcbiAgfTtcblxuICBjb25zdCBzb3VyY2VQYXRoID0gcmVsYXRpdmVQYXRoLmluY2x1ZGVzKFwiL2Rpc3QvXCIpXG4gICAgPyByZWxhdGl2ZVBhdGgucmVwbGFjZShcIi9kaXN0L1wiLCBcIi9zcmMvXCIpXG4gICAgOiByZWxhdGl2ZVBhdGg7XG4gIGNvbnN0IGRpc3RQYXRoID0gcmVsYXRpdmVQYXRoLmluY2x1ZGVzKFwiL3NyYy9cIilcbiAgICA/IHJlbGF0aXZlUGF0aC5yZXBsYWNlKFwiL3NyYy9cIiwgXCIvZGlzdC9cIilcbiAgICA6IHJlbGF0aXZlUGF0aC5pbmNsdWRlcyhcIi9kaXN0L1wiKVxuICAgICAgPyByZWxhdGl2ZVBhdGhcbiAgICAgIDogbnVsbDtcblxuICBwdXNoUHJlZmVycmVkUGFpcihzb3VyY2VQYXRoKTtcbiAgcHVzaFByZWZlcnJlZFBhaXIoZGlzdFBhdGgpO1xuXG4gIHJldHVybiBbLi4ubmV3IFNldChjYW5kaWRhdGVzKV07XG59XG5cbmZ1bmN0aW9uIGdldFdyaXRlR2F0ZU1vZHVsZUNhbmRpZGF0ZXMoKTogc3RyaW5nW10ge1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBleHBsaWNpdE1vZHVsZSA9IHByb2Nlc3MuZW52LkdTRF9XT1JLRkxPV19XUklURV9HQVRFX01PRFVMRT8udHJpbSgpO1xuICBpZiAoZXhwbGljaXRNb2R1bGUpIHtcbiAgICBpZiAoL15bYS16XXsyLH06L2kudGVzdChleHBsaWNpdE1vZHVsZSkgJiYgIWV4cGxpY2l0TW9kdWxlLnN0YXJ0c1dpdGgoXCJmaWxlOlwiKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiR1NEX1dPUktGTE9XX1dSSVRFX0dBVEVfTU9EVUxFIG9ubHkgc3VwcG9ydHMgZmlsZTogVVJMcyBvciBmaWxlc3lzdGVtIHBhdGhzLlwiKTtcbiAgICB9XG4gICAgd2FybkN1c3RvbVdvcmtmbG93TW9kdWxlKFwiR1NEX1dPUktGTE9XX1dSSVRFX0dBVEVfTU9EVUxFXCIsIGV4cGxpY2l0TW9kdWxlKTtcbiAgICBjYW5kaWRhdGVzLnB1c2goZXhwbGljaXRNb2R1bGUuc3RhcnRzV2l0aChcImZpbGU6XCIpID8gZXhwbGljaXRNb2R1bGUgOiB0b0ZpbGVVcmwoZXhwbGljaXRNb2R1bGUpKTtcbiAgfVxuXG4gIGNhbmRpZGF0ZXMucHVzaChcbiAgICAuLi5idWlsZEltcG9ydENhbmRpZGF0ZXMoXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2Jvb3RzdHJhcC93cml0ZS1nYXRlLmpzXCIpXG4gICAgICAubWFwKChwKSA9PiBuZXcgVVJMKHAsIGltcG9ydC5tZXRhLnVybCkuaHJlZiksXG4gICk7XG5cbiAgcmV0dXJuIFsuLi5uZXcgU2V0KGNhbmRpZGF0ZXMpXTtcbn1cblxuZnVuY3Rpb24gdG9GaWxlVXJsKG1vZHVsZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBwYXRoVG9GaWxlVVJMKHJlc29sdmUobW9kdWxlUGF0aCkpLmhyZWY7XG59XG5cbmNvbnN0IHdhcm5lZEN1c3RvbVdvcmtmbG93TW9kdWxlVmFycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4vKipcbiAqIEVtaXQgYSBvbmUtdGltZSBzdGRlcnIgd2FybmluZyB3aGVuIEdTRF9XT1JLRkxPV19FWEVDVVRPUlNfTU9EVUxFIG9yXG4gKiBHU0RfV09SS0ZMT1dfV1JJVEVfR0FURV9NT0RVTEUgaXMgc2V0LiBUaGVzZSBvdmVycmlkZXMgZXhpc3QgZm9yIGRldi90ZXN0XG4gKiB1c2UsIGJ1dCB0aGV5IGxldCB0aGUgZW52IG93bmVyIGxvYWQgYXJiaXRyYXJ5IGxvY2FsIG1vZHVsZXMuIFRoZSB3YXJuaW5nXG4gKiBtYWtlcyBhY2NpZGVudGFsIG9yIGhvc3RpbGUgdXNlIGxvdWQgcmF0aGVyIHRoYW4gc2lsZW50LlxuICovXG5mdW5jdGlvbiB3YXJuQ3VzdG9tV29ya2Zsb3dNb2R1bGUodmFyTmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICh3YXJuZWRDdXN0b21Xb3JrZmxvd01vZHVsZVZhcnMuaGFzKHZhck5hbWUpKSByZXR1cm47XG4gIHdhcm5lZEN1c3RvbVdvcmtmbG93TW9kdWxlVmFycy5hZGQodmFyTmFtZSk7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgIGBbZ3NkLW1jcC1zZXJ2ZXJdIFdBUk5JTkc6ICR7dmFyTmFtZX0gaXMgc2V0ICgke3ZhbHVlfSkuIGAgK1xuICAgIGBDdXN0b20gd29ya2Zsb3cgbW9kdWxlcyB3aWxsIGJlIGxvYWRlZCBmcm9tIHRoaXMgcGF0aC4gYCArXG4gICAgYFVuc2V0IGZvciBwcm9kdWN0aW9uIHVzZS5cXG5gLFxuICApO1xufVxuXG4vKiogQGludGVybmFsIFx1MjAxNCBleHBvcnRlZCBmb3IgdGVzdGluZyBvbmx5ICovXG5leHBvcnQgZnVuY3Rpb24gX2J1aWxkSW1wb3J0Q2FuZGlkYXRlcyhyZWxhdGl2ZVBhdGg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgLy8gQnVpbGQgY2FuZGlkYXRlIHBhdGhzOiBwcmVmZXIgc291cmNlIGZpcnN0LCBpbmNsdWRpbmcgdGhlIC50cyBzb3VyY2VcbiAgLy8gdmFyaWFudCwgYmVmb3JlIGZhbGxpbmcgYmFjayB0byBjb21waWxlZCBkaXN0LiBJbiBzb3VyY2UvZGV2IGV4ZWN1dGlvbiBhXG4gIC8vIHN0YWxlIGRpc3QvcmVzb3VyY2VzIHRyZWUgbXVzdCBub3Qgc2lsZW50bHkgb3ZlcnJpZGUgZWRpdGVkIHNvdXJjZSBmaWxlcy5cbiAgcmV0dXJuIGJ1aWxkSW1wb3J0Q2FuZGlkYXRlcyhyZWxhdGl2ZVBhdGgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBpbXBvcnRMb2NhbE1vZHVsZTxUPihyZWxhdGl2ZVBhdGg6IHN0cmluZyk6IFByb21pc2U8VD4ge1xuICBjb25zdCByYXdDYW5kaWRhdGVzID0gX2J1aWxkSW1wb3J0Q2FuZGlkYXRlcyhyZWxhdGl2ZVBhdGgpO1xuICBjb25zdCBjYW5kaWRhdGVzID0gKGltcG9ydC5tZXRhLnVybC5pbmNsdWRlcyhcIi9kaXN0LXRlc3QvXCIpIHx8IGltcG9ydC5tZXRhLnVybC5pbmNsdWRlcyhcIlxcXFxkaXN0LXRlc3RcXFxcXCIpXG4gICAgPyBbLi4ucmF3Q2FuZGlkYXRlc10uc29ydCgoYSwgYikgPT4gTnVtYmVyKGEuZW5kc1dpdGgoXCIudHNcIikpIC0gTnVtYmVyKGIuZW5kc1dpdGgoXCIudHNcIikpKVxuICAgIDogcmF3Q2FuZGlkYXRlcylcbiAgICAubWFwKChwKSA9PiBuZXcgVVJMKHAsIGltcG9ydC5tZXRhLnVybCkuaHJlZik7XG5cbiAgbGV0IGxhc3RFcnI6IHVua25vd247XG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IGltcG9ydChjYW5kaWRhdGUpIGFzIFQ7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsYXN0RXJyID0gZXJyO1xuICAgIH1cbiAgfVxuICB0aHJvdyBsYXN0RXJyO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsb2FkUHJvamVjdFByZWZlcmVuY2VzKHByb2plY3REaXI6IHN0cmluZyk6IFByb21pc2U8dW5rbm93biB8IG51bGw+IHtcbiAgY29uc3QgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgfSA9IGF3YWl0IGltcG9ydExvY2FsTW9kdWxlPGFueT4oXG4gICAgXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3ByZWZlcmVuY2VzLmpzXCIsXG4gICk7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhwcm9qZWN0RGlyKS5wcmVmZXJlbmNlcztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZ2V0V29ya2Zsb3dFeGVjdXRvck1vZHVsZUNhbmRpZGF0ZXMoZW52OiBOb2RlSlMuUHJvY2Vzc0VudiA9IHByb2Nlc3MuZW52KTogc3RyaW5nW10ge1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBleHBsaWNpdE1vZHVsZSA9IGVudi5HU0RfV09SS0ZMT1dfRVhFQ1VUT1JTX01PRFVMRT8udHJpbSgpO1xuICBpZiAoZXhwbGljaXRNb2R1bGUpIHtcbiAgICBpZiAoL15bYS16XXsyLH06L2kudGVzdChleHBsaWNpdE1vZHVsZSkgJiYgIWV4cGxpY2l0TW9kdWxlLnN0YXJ0c1dpdGgoXCJmaWxlOlwiKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiR1NEX1dPUktGTE9XX0VYRUNVVE9SU19NT0RVTEUgb25seSBzdXBwb3J0cyBmaWxlOiBVUkxzIG9yIGZpbGVzeXN0ZW0gcGF0aHMuXCIpO1xuICAgIH1cbiAgICB3YXJuQ3VzdG9tV29ya2Zsb3dNb2R1bGUoXCJHU0RfV09SS0ZMT1dfRVhFQ1VUT1JTX01PRFVMRVwiLCBleHBsaWNpdE1vZHVsZSk7XG4gICAgY2FuZGlkYXRlcy5wdXNoKGV4cGxpY2l0TW9kdWxlLnN0YXJ0c1dpdGgoXCJmaWxlOlwiKSA/IGV4cGxpY2l0TW9kdWxlIDogdG9GaWxlVXJsKGV4cGxpY2l0TW9kdWxlKSk7XG4gIH1cblxuICBjYW5kaWRhdGVzLnB1c2goXG4gICAgLi4uYnVpbGRJbXBvcnRDYW5kaWRhdGVzKFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy93b3JrZmxvdy10b29sLWV4ZWN1dG9ycy5qc1wiKVxuICAgICAgLm1hcCgocCkgPT4gbmV3IFVSTChwLCBpbXBvcnQubWV0YS51cmwpLmhyZWYpLFxuICApO1xuXG4gIHJldHVybiBbLi4ubmV3IFNldChjYW5kaWRhdGVzKV07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldFdvcmtmbG93VG9vbEV4ZWN1dG9ycygpOiBQcm9taXNlPFdvcmtmbG93VG9vbEV4ZWN1dG9ycz4ge1xuICBpZiAoIXdvcmtmbG93VG9vbEV4ZWN1dG9yc1Byb21pc2UpIHtcbiAgICB3b3JrZmxvd1Rvb2xFeGVjdXRvcnNQcm9taXNlID0gKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGF0dGVtcHRzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgZ2V0V29ya2Zsb3dFeGVjdXRvck1vZHVsZUNhbmRpZGF0ZXMoKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGxvYWRlZCA9IGF3YWl0IGltcG9ydChjYW5kaWRhdGUpO1xuICAgICAgICAgIGlmIChpc1dvcmtmbG93VG9vbEV4ZWN1dG9ycyhsb2FkZWQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbG9hZGVkO1xuICAgICAgICAgIH1cbiAgICAgICAgICBhdHRlbXB0cy5wdXNoKGAke2NhbmRpZGF0ZX0gKG1vZHVsZSBzaGFwZSBtaXNtYXRjaClgKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgYXR0ZW1wdHMucHVzaChgJHtjYW5kaWRhdGV9ICgke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX0pYCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIlVuYWJsZSB0byBsb2FkIEdTRCB3b3JrZmxvdyBleGVjdXRvciBicmlkZ2UgZm9yIE1DUCBtdXRhdGlvbiB0b29scy4gXCIgK1xuICAgICAgICBcIlNldCBHU0RfV09SS0ZMT1dfRVhFQ1VUT1JTX01PRFVMRSB0byBhbiBpbXBvcnRhYmxlIHdvcmtmbG93LXRvb2wtZXhlY3V0b3JzIG1vZHVsZSwgXCIgK1xuICAgICAgICBcIm9yIHJ1biB0aGUgTUNQIHNlcnZlciBmcm9tIGEgR1NEIGNoZWNrb3V0IHRoYXQgaW5jbHVkZXMgc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy93b3JrZmxvdy10b29sLWV4ZWN1dG9ycy4oanN8dHMpLiBcIiArXG4gICAgICAgIGBBdHRlbXB0czogJHthdHRlbXB0cy5qb2luKFwiOyBcIil9YCxcbiAgICAgICk7XG4gICAgfSkoKTtcbiAgfVxuICByZXR1cm4gd29ya2Zsb3dUb29sRXhlY3V0b3JzUHJvbWlzZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0V29ya2Zsb3dXcml0ZUdhdGVNb2R1bGUoKTogUHJvbWlzZTxXb3JrZmxvd1dyaXRlR2F0ZU1vZHVsZT4ge1xuICBpZiAoIXdvcmtmbG93V3JpdGVHYXRlUHJvbWlzZSkge1xuICAgIHdvcmtmbG93V3JpdGVHYXRlUHJvbWlzZSA9IChhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBhdHRlbXB0czogc3RyaW5nW10gPSBbXTtcbiAgICAgIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGdldFdyaXRlR2F0ZU1vZHVsZUNhbmRpZGF0ZXMoKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGxvYWRlZCA9IGF3YWl0IGltcG9ydChjYW5kaWRhdGUpO1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIGxvYWRlZCAmJlxuICAgICAgICAgICAgdHlwZW9mIGxvYWRlZC5sb2FkV3JpdGVHYXRlU25hcHNob3QgPT09IFwiZnVuY3Rpb25cIiAmJlxuICAgICAgICAgICAgdHlwZW9mIGxvYWRlZC5zaG91bGRCbG9ja1BlbmRpbmdHYXRlSW5TbmFwc2hvdCA9PT0gXCJmdW5jdGlvblwiICYmXG4gICAgICAgICAgICB0eXBlb2YgbG9hZGVkLnNob3VsZEJsb2NrUXVldWVFeGVjdXRpb25JblNuYXBzaG90ID09PSBcImZ1bmN0aW9uXCJcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHJldHVybiBsb2FkZWQgYXMgV29ya2Zsb3dXcml0ZUdhdGVNb2R1bGU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGF0dGVtcHRzLnB1c2goYCR7Y2FuZGlkYXRlfSAobW9kdWxlIHNoYXBlIG1pc21hdGNoKWApO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICBhdHRlbXB0cy5wdXNoKGAke2NhbmRpZGF0ZX0gKCR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfSlgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiVW5hYmxlIHRvIGxvYWQgR1NEIHdyaXRlLWdhdGUgYnJpZGdlIGZvciB3b3JrZmxvdyBNQ1AgdG9vbHMuIFwiICtcbiAgICAgICAgYEF0dGVtcHRzOiAke2F0dGVtcHRzLmpvaW4oXCI7IFwiKX1gLFxuICAgICAgKTtcbiAgICB9KSgpO1xuICB9XG4gIHJldHVybiB3b3JrZmxvd1dyaXRlR2F0ZVByb21pc2U7XG59XG5cbmludGVyZmFjZSBNY3BUb29sU2VydmVyIHtcbiAgdG9vbChcbiAgICBuYW1lOiBzdHJpbmcsXG4gICAgZGVzY3JpcHRpb246IHN0cmluZyxcbiAgICBwYXJhbXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIGhhbmRsZXI6IChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPixcbiAgKTogdW5rbm93bjtcbn1cblxuZXhwb3J0IGNvbnN0IFdPUktGTE9XX1RPT0xfTkFNRVMgPSBDT05UUkFDVF9XT1JLRkxPV19UT09MX05BTUVTO1xuXG5jb25zdCBERUZBVUxUX1dPUktGTE9XX09QX1RJTUVPVVRfTVMgPSA1ICogNjAgKiAxMDAwO1xuXG5mdW5jdGlvbiBnZXRXb3JrZmxvd09wVGltZW91dE1zKGVudjogTm9kZUpTLlByb2Nlc3NFbnYgPSBwcm9jZXNzLmVudik6IG51bWJlciB7XG4gIGNvbnN0IHJhdyA9IGVudi5HU0RfTUNQX1dPUktGTE9XX1RJTUVPVVRfTVM/LnRyaW0oKTtcbiAgaWYgKCFyYXcpIHJldHVybiBERUZBVUxUX1dPUktGTE9XX09QX1RJTUVPVVRfTVM7XG4gIGNvbnN0IHBhcnNlZCA9IE51bWJlci5wYXJzZUludChyYXcsIDEwKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSB8fCBwYXJzZWQgPCAwKSByZXR1cm4gREVGQVVMVF9XT1JLRkxPV19PUF9USU1FT1VUX01TO1xuICByZXR1cm4gcGFyc2VkOyAvLyAwIGRpc2FibGVzIHRoZSB0aW1lb3V0XG59XG5cbi8qKlxuICogQWRhcHQgYW4gZXhlY3V0b3IgYFRvb2xFeGVjdXRpb25SZXN1bHRgICh7IGNvbnRlbnQsIGRldGFpbHM/LCBpc0Vycm9yPyB9KSB0b1xuICogdGhlIE1DUCBgQ2FsbFRvb2xSZXN1bHRgIHNoYXBlICh7IGNvbnRlbnQsIHN0cnVjdHVyZWRDb250ZW50PywgaXNFcnJvcj8gfSkuXG4gKlxuICogTUNQIHRyYW5zcG9ydHMgKGluY2x1ZGluZyBzdGRpbykgb25seSBzZXJpYWxpemUgZmllbGRzIGRlY2xhcmVkIGluIHRoZVxuICogcHJvdG9jb2wsIHNvIGEgbm9uLXN0YW5kYXJkIGBkZXRhaWxzYCBmaWVsZCBpcyBzaWxlbnRseSBkcm9wcGVkIG92ZXIgdGhlXG4gKiB3aXJlLiBNaXJyb3JpbmcgaXQgaW50byBgc3RydWN0dXJlZENvbnRlbnRgIFx1MjAxNCB0aGUgcHJvdG9jb2wncyBzdXBwb3J0ZWRcbiAqIGNoYW5uZWwgZm9yIHN0cnVjdHVyZWQgdG9vbCBwYXlsb2FkcyBcdTIwMTQgcHJlc2VydmVzIHRoZSBkYXRhIGZvciBjbGllbnRzIHRoYXRcbiAqIHJlbmRlciBmcm9tIGl0IChlLmcuIHRoZSBzYXZlX2dhdGVfcmVzdWx0IHJlbmRlcmVyIHRoYXQgcmVhZHMgZ2F0ZUlkIC9cbiAqIHZlcmRpY3QpLiBTZWUgIzQ0NzIuXG4gKlxuICogRGlzY2FyZCBwb2xpY3kgZm9yIG5vbi1wbGFpbi1vYmplY3QgYGRldGFpbHNgOiB0aGUgYGlzUGxhaW5PYmplY3RgIGd1YXJkXG4gKiBhY2NlcHRzIHRoZSBjYW5vbmljYWwgY2FzZSAoYSByZWNvcmQgbGl0ZXJhbCkgYW5kIGludGVudGlvbmFsbHkgZHJvcHMgYmFyZVxuICogcHJpbWl0aXZlcyAoc3RyaW5nLCBudW1iZXIsIGJvb2xlYW4pLCBiYXJlIGFycmF5cywgYW5kIGNsYXNzIGluc3RhbmNlcyAvXG4gKiBEYXRlIG9iamVjdHMuIFRoaXMgaXMgZGVsaWJlcmF0ZSBcdTIwMTQgTUNQIGBzdHJ1Y3R1cmVkQ29udGVudGAgaXMgc3BlY2lmaWVkIGFzXG4gKiBhIEpTT04gb2JqZWN0OyBub24tb2JqZWN0IHBheWxvYWRzIGNhbid0IHJvdW5kLXRyaXAgY2xlYW5seS4gTm8gY3VycmVudFxuICogZXhlY3V0b3IgcmV0dXJucyBhIG5vbi1vYmplY3QgYGRldGFpbHNgLCBzbyB0aGlzIG5ldmVyIGZpcmVzIGluIHByYWN0aWNlLlxuICogRnV0dXJlIGV4ZWN1dG9ycyBuZWVkaW5nIHRvIHJldHVybiBhIHByaW1pdGl2ZSBzaG91bGQgd3JhcCBpdFxuICogKGBkZXRhaWxzOiB7IHZhbHVlOiA0MiB9YCkgcmF0aGVyIHRoYW4gcmVseWluZyBvbiB0aGUgZGlzY2FyZC5cbiAqL1xuZnVuY3Rpb24gYWRhcHRFeGVjdXRvclJlc3VsdChyZXN1bHQ6IHVua25vd24pOiB1bmtub3duIHtcbiAgaWYgKCFyZXN1bHQgfHwgdHlwZW9mIHJlc3VsdCAhPT0gXCJvYmplY3RcIikgcmV0dXJuIHJlc3VsdDtcbiAgY29uc3QgciA9IHJlc3VsdCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgaWYgKCEoXCJkZXRhaWxzXCIgaW4gcikpIHJldHVybiByZXN1bHQ7XG4gIGNvbnN0IHsgZGV0YWlscywgLi4ucmVzdCB9ID0gcjtcbiAgcmV0dXJuIGlzUGxhaW5PYmplY3QoZGV0YWlscykgPyB7IC4uLnJlc3QsIHN0cnVjdHVyZWRDb250ZW50OiBkZXRhaWxzIH0gOiByZXN0O1xufVxuXG4vKipcbiAqIFN0cmljdCBwbGFpbi1vYmplY3QgZ3VhcmQuIFRydWUgb25seSBmb3Igb2JqZWN0IGxpdGVyYWxzIGFuZFxuICogYE9iamVjdC5jcmVhdGUobnVsbClgIFx1MjAxNCBub3QgZm9yIGBEYXRlYCwgYFVSTGAsIGBNYXBgLCBgU2V0YCwgY2xhc3MgaW5zdGFuY2VzLFxuICogb3IgYXJyYXlzLiBVc2VkIHRvIGdhdGUgYHN0cnVjdHVyZWRDb250ZW50YCBmb3J3YXJkaW5nIHNvIHRoZSBNQ1AgdHJhbnNwb3J0XG4gKiByZWNlaXZlcyBvbmx5IHRydWUgSlNPTiBvYmplY3RzICh0aGUgcHJvdG9jb2wgY29udHJhY3QpLlxuICpcbiAqIE1pcnJvcmVkIGluIGBzcmMvbWNwLXNlcnZlci50c2AgZm9yIHRoZSBhZ2VudC10b29sIHJlZ2lzdHJ5IHBhdGgnc1xuICogc3RydWN0dXJlZC1jb250ZW50IGdhdGUuIEtlZXAgYm90aCBjb3BpZXMgaW4gc3luYyBpZiB0aGUgY29udHJhY3QgZGVmaW5pdGlvblxuICogbmVlZHMgdG8gZXZvbHZlLiBTZWUgIzQ0NzcgcmV2aWV3LlxuICovXG5mdW5jdGlvbiBpc1BsYWluT2JqZWN0KHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBpZiAodmFsdWUgPT09IG51bGwgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBwcm90byA9IE9iamVjdC5nZXRQcm90b3R5cGVPZih2YWx1ZSk7XG4gIHJldHVybiBwcm90byA9PT0gbnVsbCB8fCBwcm90byA9PT0gT2JqZWN0LnByb3RvdHlwZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuU2VyaWFsaXplZFdvcmtmbG93T3BlcmF0aW9uPFQ+KGZuOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gIC8vIFRoZSBzaGFyZWQgREIgYWRhcHRlciBhbmQgd29ya2Zsb3cgbG9nIGJhc2UgcGF0aCBhcmUgcHJvY2Vzcy1nbG9iYWwsIHNvXG4gIC8vIHdvcmtmbG93IE1DUCBtdXRhdGlvbnMgbXVzdCBub3Qgb3ZlcmxhcCB3aXRoaW4gYSBzaW5nbGUgc2VydmVyIHByb2Nlc3MuXG4gIC8vIEEgcGVyLW9wZXJhdGlvbiBkZWFkbGluZSBwcmV2ZW50cyBhIHNpbmdsZSBzdHVjayBjYWxsIGZyb20gd2VkZ2luZyBldmVyeVxuICAvLyBzdWJzZXF1ZW50IHdyaXRlIGZvciB0aGUgbGlmZXRpbWUgb2YgdGhlIHByb2Nlc3MuXG4gIC8vXG4gIC8vIEtub3duIGxpbWl0YXRpb246IG9uIHRpbWVvdXQgd2Ugc3VyZmFjZSBhbiBlcnJvciBhbmQgcmVsZWFzZSB0aGUgcXVldWUsXG4gIC8vIGJ1dCBQcm9taXNlLnJhY2UgY2Fubm90IGNhbmNlbCB0aGUgdW5kZXJseWluZyBgZm4oKWAgXHUyMDE0IGl0IG1heSBjb250aW51ZVxuICAvLyBydW5uaW5nIGluIHRoZSBiYWNrZ3JvdW5kIGFuZCBvdmVybGFwIHdpdGggdGhlIG5leHQgYWRtaXR0ZWQgb3BlcmF0aW9uLlxuICAvLyBQcm9wZXIgY2FuY2VsbGF0aW9uIHJlcXVpcmVzIHRocmVhZGluZyBhbiBBYm9ydFNpZ25hbCB0aHJvdWdoIGV2ZXJ5XG4gIC8vIHdvcmtmbG93IGV4ZWN1dG9yIChgd29ya2Zsb3ctdG9vbC1leGVjdXRvcnMudHNgIGFuZCBmcmllbmRzKSwgd2hpY2ggaXNcbiAgLy8gYSBsYXJnZXIgY2hhbmdlLiBUaGUgY3VycmVudCB0cmFkZS1vZmY6IHJpc2sgYSB0aGVvcmV0aWNhbCBvdmVybGFwIGFmdGVyXG4gIC8vIGEgNS1taW51dGUgd2FsbC1jbG9jayB0aW1lb3V0IHZzIHBlcm1hbmVudGx5IHdlZGdpbmcgdGhlIHNlcnZlci4gVGhlXG4gIC8vIG92ZXJsYXAgd2luZG93IGlzIGJvdW5kZWQgYnkgaG93IGxvbmcgdGhlIHpvbWJpZSBgZm4oKWAga2VlcHMgcnVubmluZztcbiAgLy8gaW4gcHJhY3RpY2UgREIgd3JpdGVzIGNvbXBsZXRlIHF1aWNrbHkgZXZlbiB3aGVuIHRoZSBjYWxsZXIgZ2F2ZSB1cC5cbiAgY29uc3QgcHJpb3IgPSB3b3JrZmxvd0V4ZWN1dGlvblF1ZXVlO1xuICBsZXQgcmVsZWFzZSE6ICgpID0+IHZvaWQ7XG4gIHdvcmtmbG93RXhlY3V0aW9uUXVldWUgPSBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgIHJlbGVhc2UgPSByZXNvbHZlO1xuICB9KTtcblxuICBhd2FpdCBwcmlvcjtcbiAgY29uc3QgdGltZW91dE1zID0gZ2V0V29ya2Zsb3dPcFRpbWVvdXRNcygpO1xuICB0cnkge1xuICAgIGlmICh0aW1lb3V0TXMgPT09IDApIHtcbiAgICAgIHJldHVybiBhd2FpdCBmbigpO1xuICAgIH1cbiAgICBsZXQgdGltZXI6IE5vZGVKUy5UaW1lb3V0IHwgdW5kZWZpbmVkO1xuICAgIGNvbnN0IHRpbWVvdXRQcm9taXNlID0gbmV3IFByb21pc2U8bmV2ZXI+KChfLCByZWplY3QpID0+IHtcbiAgICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHJlamVjdChuZXcgRXJyb3IoYFdvcmtmbG93IG9wZXJhdGlvbiBleGNlZWRlZCAke3RpbWVvdXRNc31tcyBkZWFkbGluZSAoR1NEX01DUF9XT1JLRkxPV19USU1FT1VUX01TKWApKTtcbiAgICAgIH0sIHRpbWVvdXRNcyk7XG4gICAgfSk7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCBQcm9taXNlLnJhY2UoW2ZuKCksIHRpbWVvdXRQcm9taXNlXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmICh0aW1lcikgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgcmVsZWFzZSgpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1blNlcmlhbGl6ZWRXb3JrZmxvd0RiT3BlcmF0aW9uPFQ+KFxuICBwcm9qZWN0RGlyOiBzdHJpbmcsXG4gIGZuOiAoKSA9PiBQcm9taXNlPFQ+LFxuKTogUHJvbWlzZTxUPiB7XG4gIHJldHVybiBydW5TZXJpYWxpemVkV29ya2Zsb3dPcGVyYXRpb24oYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgZW5zdXJlRGJPcGVuIH0gPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxXb3JrZmxvd0RiQm9vdHN0cmFwTW9kdWxlPihcbiAgICAgIFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvZHluYW1pYy10b29scy5qc1wiLFxuICAgICk7XG4gICAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4ocHJvamVjdERpcik7XG4gICAgaWYgKCFkYkF2YWlsYWJsZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGVcIik7XG4gICAgfVxuICAgIHJldHVybiBmbigpO1xuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFxuICB0b29sTmFtZTogc3RyaW5nLFxuICBwcm9qZWN0RGlyOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcgfCBudWxsID0gbnVsbCxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB3cml0ZUdhdGUgPSBhd2FpdCBnZXRXb3JrZmxvd1dyaXRlR2F0ZU1vZHVsZSgpO1xuICBjb25zdCBzbmFwc2hvdCA9IHdyaXRlR2F0ZS5sb2FkV3JpdGVHYXRlU25hcHNob3QocHJvamVjdERpcik7XG4gIGNvbnN0IHBlbmRpbmdHYXRlID0gd3JpdGVHYXRlLnNob3VsZEJsb2NrUGVuZGluZ0dhdGVJblNuYXBzaG90KFxuICAgIHNuYXBzaG90LFxuICAgIHRvb2xOYW1lLFxuICAgIG1pbGVzdG9uZUlkLFxuICAgIHNuYXBzaG90LmFjdGl2ZVF1ZXVlUGhhc2UsXG4gICk7XG4gIGlmIChwZW5kaW5nR2F0ZS5ibG9jaykge1xuICAgIHRocm93IG5ldyBFcnJvcihwZW5kaW5nR2F0ZS5yZWFzb24gPz8gXCJ3b3JrZmxvdyB0b29sIGJsb2NrZWQgYnkgcGVuZGluZyBkaXNjdXNzaW9uIGdhdGVcIik7XG4gIH1cblxuICBjb25zdCBxdWV1ZUd1YXJkID0gd3JpdGVHYXRlLnNob3VsZEJsb2NrUXVldWVFeGVjdXRpb25JblNuYXBzaG90KFxuICAgIHNuYXBzaG90LFxuICAgIHRvb2xOYW1lLFxuICAgIFwiXCIsXG4gICAgc25hcHNob3QuYWN0aXZlUXVldWVQaGFzZSxcbiAgKTtcbiAgaWYgKHF1ZXVlR3VhcmQuYmxvY2spIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IocXVldWVHdWFyZC5yZWFzb24gPz8gXCJ3b3JrZmxvdyB0b29sIGJsb2NrZWQgZHVyaW5nIHF1ZXVlIG1vZGVcIik7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlVGFza0NvbXBsZXRlKFxuICBwcm9qZWN0RGlyOiBzdHJpbmcsXG4gIGFyZ3M6IE9taXQ8ei5pbmZlcjx0eXBlb2YgdGFza0NvbXBsZXRlU2NoZW1hPiwgXCJwcm9qZWN0RGlyXCI+LFxuKTogUHJvbWlzZTx1bmtub3duPiB7XG4gIGF3YWl0IGVuZm9yY2VXb3JrZmxvd1dyaXRlR2F0ZShcImdzZF90YXNrX2NvbXBsZXRlXCIsIHByb2plY3REaXIsIGFyZ3MubWlsZXN0b25lSWQpO1xuICBjb25zdCB7IGV4ZWN1dGVUYXNrQ29tcGxldGUgfSA9IGF3YWl0IGdldFdvcmtmbG93VG9vbEV4ZWN1dG9ycygpO1xuICAvLyBQYXNzIGBhcmdzYCB0aHJvdWdoIGRpcmVjdGx5IHJhdGhlciB0aGFuIGRlc3RydWN0dXJlLXRoZW4tcmVidWlsZC4gVGhlXG4gIC8vIHByZXZpb3VzIGltcGxlbWVudGF0aW9uIHJlLWxpc3RlZCBlYWNoIGZpZWxkLCB3aGljaCBzaWxlbnRseSBkcm9wcGVkXG4gIC8vIHNjaGVtYSBmaWVsZHMgdGhhdCB3ZXJlbid0IGluIHRoZSByZWJ1aWxkIGxpc3QgKGUuZy4sIEFEUi0wMTEnc1xuICAvLyBgZXNjYWxhdGlvbmAgcGF5bG9hZCkuIFRoZSBkZXN0cnVjdHVyZS10aGVuLXJlYnVpbGQgcGF0dGVybiBpcyB0aGUgYnVnXG4gIC8vIGNsYXNzOyBtYXRjaGluZyB0aGUgc3ByZWFkIHNoYXBlIHVzZWQgYnkgc2libGluZyBoYW5kbGVycyAoaGFuZGxlU2xpY2VDb21wbGV0ZSxcbiAgLy8gaGFuZGxlUmVwbGFuU2xpY2UpIGVsaW1pbmF0ZXMgdGhlIHJlY3VycmVuY2UgcmlzayBieSBjb25zdHJ1Y3Rpb24uXG4gIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgIGF3YWl0IHJ1blNlcmlhbGl6ZWRXb3JrZmxvd09wZXJhdGlvbigoKSA9PiBleGVjdXRlVGFza0NvbXBsZXRlKGFyZ3MsIHByb2plY3REaXIpKSxcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlVGFza1Jlb3BlbihcbiAgcHJvamVjdERpcjogc3RyaW5nLFxuICBhcmdzOiBPbWl0PHouaW5mZXI8dHlwZW9mIHRhc2tSZW9wZW5TY2hlbWE+LCBcInByb2plY3REaXJcIj4sXG4pOiBQcm9taXNlPHVua25vd24+IHtcbiAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX3Rhc2tfcmVvcGVuXCIsIHByb2plY3REaXIsIGFyZ3MubWlsZXN0b25lSWQpO1xuICBjb25zdCB7IGV4ZWN1dGVUYXNrUmVvcGVuIH0gPSBhd2FpdCBnZXRXb3JrZmxvd1Rvb2xFeGVjdXRvcnMoKTtcbiAgcmV0dXJuIGFkYXB0RXhlY3V0b3JSZXN1bHQoXG4gICAgYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93T3BlcmF0aW9uKCgpID0+IGV4ZWN1dGVUYXNrUmVvcGVuKGFyZ3MsIHByb2plY3REaXIpKSxcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2xpY2VSZW9wZW4oXG4gIHByb2plY3REaXI6IHN0cmluZyxcbiAgYXJnczogT21pdDx6LmluZmVyPHR5cGVvZiBzbGljZVJlb3BlblNjaGVtYT4sIFwicHJvamVjdERpclwiPixcbik6IFByb21pc2U8dW5rbm93bj4ge1xuICBhd2FpdCBlbmZvcmNlV29ya2Zsb3dXcml0ZUdhdGUoXCJnc2Rfc2xpY2VfcmVvcGVuXCIsIHByb2plY3REaXIsIGFyZ3MubWlsZXN0b25lSWQpO1xuICBjb25zdCB7IGV4ZWN1dGVTbGljZVJlb3BlbiB9ID0gYXdhaXQgZ2V0V29ya2Zsb3dUb29sRXhlY3V0b3JzKCk7XG4gIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgIGF3YWl0IHJ1blNlcmlhbGl6ZWRXb3JrZmxvd09wZXJhdGlvbigoKSA9PiBleGVjdXRlU2xpY2VSZW9wZW4oYXJncywgcHJvamVjdERpcikpLFxuICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVNaWxlc3RvbmVSZW9wZW4oXG4gIHByb2plY3REaXI6IHN0cmluZyxcbiAgYXJnczogT21pdDx6LmluZmVyPHR5cGVvZiBtaWxlc3RvbmVSZW9wZW5TY2hlbWE+LCBcInByb2plY3REaXJcIj4sXG4pOiBQcm9taXNlPHVua25vd24+IHtcbiAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX21pbGVzdG9uZV9yZW9wZW5cIiwgcHJvamVjdERpciwgYXJncy5taWxlc3RvbmVJZCk7XG4gIGNvbnN0IHsgZXhlY3V0ZU1pbGVzdG9uZVJlb3BlbiB9ID0gYXdhaXQgZ2V0V29ya2Zsb3dUb29sRXhlY3V0b3JzKCk7XG4gIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgIGF3YWl0IHJ1blNlcmlhbGl6ZWRXb3JrZmxvd09wZXJhdGlvbigoKSA9PiBleGVjdXRlTWlsZXN0b25lUmVvcGVuKGFyZ3MsIHByb2plY3REaXIpKSxcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2xpY2VDb21wbGV0ZShcbiAgcHJvamVjdERpcjogc3RyaW5nLFxuICBhcmdzOiB6LmluZmVyPHR5cGVvZiBzbGljZUNvbXBsZXRlU2NoZW1hPixcbik6IFByb21pc2U8dW5rbm93bj4ge1xuICBhd2FpdCBlbmZvcmNlV29ya2Zsb3dXcml0ZUdhdGUoXCJnc2Rfc2xpY2VfY29tcGxldGVcIiwgcHJvamVjdERpciwgYXJncy5taWxlc3RvbmVJZCk7XG4gIGNvbnN0IHsgZXhlY3V0ZVNsaWNlQ29tcGxldGUgfSA9IGF3YWl0IGdldFdvcmtmbG93VG9vbEV4ZWN1dG9ycygpO1xuICBjb25zdCB7IHByb2plY3REaXI6IF9wcm9qZWN0RGlyLCAuLi5wYXJhbXMgfSA9IGFyZ3M7XG4gIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgIGF3YWl0IHJ1blNlcmlhbGl6ZWRXb3JrZmxvd09wZXJhdGlvbigoKSA9PiBleGVjdXRlU2xpY2VDb21wbGV0ZShwYXJhbXMsIHByb2plY3REaXIpKSxcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlUmVwbGFuU2xpY2UoXG4gIHByb2plY3REaXI6IHN0cmluZyxcbiAgYXJnczogei5pbmZlcjx0eXBlb2YgcmVwbGFuU2xpY2VTY2hlbWE+LFxuKTogUHJvbWlzZTx1bmtub3duPiB7XG4gIGF3YWl0IGVuZm9yY2VXb3JrZmxvd1dyaXRlR2F0ZShcImdzZF9yZXBsYW5fc2xpY2VcIiwgcHJvamVjdERpciwgYXJncy5taWxlc3RvbmVJZCk7XG4gIGNvbnN0IHsgZXhlY3V0ZVJlcGxhblNsaWNlIH0gPSBhd2FpdCBnZXRXb3JrZmxvd1Rvb2xFeGVjdXRvcnMoKTtcbiAgY29uc3QgeyBwcm9qZWN0RGlyOiBfcHJvamVjdERpciwgLi4ucGFyYW1zIH0gPSBhcmdzO1xuICByZXR1cm4gYWRhcHRFeGVjdXRvclJlc3VsdChcbiAgICBhd2FpdCBydW5TZXJpYWxpemVkV29ya2Zsb3dPcGVyYXRpb24oKCkgPT4gZXhlY3V0ZVJlcGxhblNsaWNlKHBhcmFtcywgcHJvamVjdERpcikpLFxuICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZShcbiAgcHJvamVjdERpcjogc3RyaW5nLFxuICBhcmdzOiB6LmluZmVyPHR5cGVvZiBjb21wbGV0ZU1pbGVzdG9uZVNjaGVtYT4sXG4pOiBQcm9taXNlPHVua25vd24+IHtcbiAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX2NvbXBsZXRlX21pbGVzdG9uZVwiLCBwcm9qZWN0RGlyLCBhcmdzLm1pbGVzdG9uZUlkKTtcbiAgY29uc3QgeyBleGVjdXRlQ29tcGxldGVNaWxlc3RvbmUgfSA9IGF3YWl0IGdldFdvcmtmbG93VG9vbEV4ZWN1dG9ycygpO1xuICBjb25zdCB7IHByb2plY3REaXI6IF9wcm9qZWN0RGlyLCAuLi5wYXJhbXMgfSA9IGFyZ3M7XG4gIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgIGF3YWl0IHJ1blNlcmlhbGl6ZWRXb3JrZmxvd09wZXJhdGlvbigoKSA9PiBleGVjdXRlQ29tcGxldGVNaWxlc3RvbmUocGFyYW1zLCBwcm9qZWN0RGlyKSksXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVZhbGlkYXRlTWlsZXN0b25lKFxuICBwcm9qZWN0RGlyOiBzdHJpbmcsXG4gIGFyZ3M6IHouaW5mZXI8dHlwZW9mIHZhbGlkYXRlTWlsZXN0b25lU2NoZW1hPixcbik6IFByb21pc2U8dW5rbm93bj4ge1xuICBhd2FpdCBlbmZvcmNlV29ya2Zsb3dXcml0ZUdhdGUoXCJnc2RfdmFsaWRhdGVfbWlsZXN0b25lXCIsIHByb2plY3REaXIsIGFyZ3MubWlsZXN0b25lSWQpO1xuICBjb25zdCB7IGV4ZWN1dGVWYWxpZGF0ZU1pbGVzdG9uZSB9ID0gYXdhaXQgZ2V0V29ya2Zsb3dUb29sRXhlY3V0b3JzKCk7XG4gIGNvbnN0IHsgcHJvamVjdERpcjogX3Byb2plY3REaXIsIC4uLnBhcmFtcyB9ID0gYXJncztcbiAgcmV0dXJuIGFkYXB0RXhlY3V0b3JSZXN1bHQoXG4gICAgYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93T3BlcmF0aW9uKCgpID0+IGV4ZWN1dGVWYWxpZGF0ZU1pbGVzdG9uZShwYXJhbXMsIHByb2plY3REaXIpKSxcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlUmVhc3Nlc3NSb2FkbWFwKFxuICBwcm9qZWN0RGlyOiBzdHJpbmcsXG4gIGFyZ3M6IHouaW5mZXI8dHlwZW9mIHJlYXNzZXNzUm9hZG1hcFNjaGVtYT4sXG4pOiBQcm9taXNlPHVua25vd24+IHtcbiAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX3JlYXNzZXNzX3JvYWRtYXBcIiwgcHJvamVjdERpciwgYXJncy5taWxlc3RvbmVJZCk7XG4gIGNvbnN0IHsgZXhlY3V0ZVJlYXNzZXNzUm9hZG1hcCB9ID0gYXdhaXQgZ2V0V29ya2Zsb3dUb29sRXhlY3V0b3JzKCk7XG4gIGNvbnN0IHsgcHJvamVjdERpcjogX3Byb2plY3REaXIsIC4uLnBhcmFtcyB9ID0gYXJncztcbiAgcmV0dXJuIGFkYXB0RXhlY3V0b3JSZXN1bHQoXG4gICAgYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93T3BlcmF0aW9uKCgpID0+IGV4ZWN1dGVSZWFzc2Vzc1JvYWRtYXAocGFyYW1zLCBwcm9qZWN0RGlyKSksXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVNhdmVHYXRlUmVzdWx0KFxuICBwcm9qZWN0RGlyOiBzdHJpbmcsXG4gIGFyZ3M6IHouaW5mZXI8dHlwZW9mIHNhdmVHYXRlUmVzdWx0U2NoZW1hPixcbik6IFByb21pc2U8dW5rbm93bj4ge1xuICBhd2FpdCBlbmZvcmNlV29ya2Zsb3dXcml0ZUdhdGUoXCJnc2Rfc2F2ZV9nYXRlX3Jlc3VsdFwiLCBwcm9qZWN0RGlyLCBhcmdzLm1pbGVzdG9uZUlkKTtcbiAgY29uc3QgeyBleGVjdXRlU2F2ZUdhdGVSZXN1bHQgfSA9IGF3YWl0IGdldFdvcmtmbG93VG9vbEV4ZWN1dG9ycygpO1xuICBjb25zdCB7IHByb2plY3REaXI6IF9wcm9qZWN0RGlyLCAuLi5wYXJhbXMgfSA9IGFyZ3M7XG4gIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgIGF3YWl0IHJ1blNlcmlhbGl6ZWRXb3JrZmxvd09wZXJhdGlvbigoKSA9PiBleGVjdXRlU2F2ZUdhdGVSZXN1bHQocGFyYW1zLCBwcm9qZWN0RGlyKSksXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZU1pbGVzdG9uZURiUm93KG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGluc2VydE1pbGVzdG9uZSB9ID0gYXdhaXQgaW1wb3J0TG9jYWxNb2R1bGU8YW55PihcIi4uLy4uLy4uL3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZ3NkLWRiLmpzXCIpO1xuICAgIGluc2VydE1pbGVzdG9uZSh7IGlkOiBtaWxlc3RvbmVJZCwgc3RhdHVzOiBcInF1ZXVlZFwiIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBJZ25vcmUgcHJlLWV4aXN0aW5nIHJvd3Mgb3IgdHJhbnNpZW50IERCIGF2YWlsYWJpbGl0eSBpc3N1ZXMuXG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZmluZERhdGFiYXNlTWlsZXN0b25lSWRzKCk6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGdldEFsbE1pbGVzdG9uZXMgfSA9IGF3YWl0IGltcG9ydExvY2FsTW9kdWxlPGFueT4oXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2dzZC1kYi5qc1wiKTtcbiAgICByZXR1cm4gKGdldEFsbE1pbGVzdG9uZXM/LigpID8/IFtdKVxuICAgICAgLm1hcCgobWlsZXN0b25lOiB1bmtub3duKSA9PiB7XG4gICAgICAgIGNvbnN0IGlkID0gKG1pbGVzdG9uZSBhcyB7IGlkPzogdW5rbm93biB9KT8uaWQ7XG4gICAgICAgIHJldHVybiB0eXBlb2YgaWQgPT09IFwic3RyaW5nXCIgPyBpZCA6IG51bGw7XG4gICAgICB9KVxuICAgICAgLmZpbHRlcigoaWQ6IHN0cmluZyB8IG51bGwpOiBpZCBpcyBzdHJpbmcgPT4gaWQgIT09IG51bGwpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLyoqXG4gKiBGaXggIzQ5OTY6IFNoYXJlZCBoZWxwZXIgZm9yIGJvdGggZ3NkX21pbGVzdG9uZV9nZW5lcmF0ZV9pZCBhbmRcbiAqIGdzZF9nZW5lcmF0ZV9taWxlc3RvbmVfaWQuIFJldXNlcyB0aGUgbG93ZXN0IHJldXNhYmxlIGdob3N0IG1pbGVzdG9uZSBJRFxuICogKGEgZGlzay1vbmx5IHN0dWIgd2l0aCBubyBEQiByb3csIG5vIHdvcmt0cmVlLCBubyBjb250ZW50IGZpbGVzKSBiZWZvcmVcbiAqIGZhbGxpbmcgYmFjayB0byBtYXgrMS4gVXNlcyB0aGUgc3RyaWN0ZXIgYGlzUmV1c2FibGVHaG9zdE1pbGVzdG9uZWAgXHUyMDE0XG4gKiBub3QgYGlzR2hvc3RNaWxlc3RvbmVgIFx1MjAxNCB0byBhdm9pZCByYWNpbmcgd2l0aCBpbi1mbGlnaHQgcXVldWVkIERCIHJvd3NcbiAqIGZyb20gYW4gZWFybGllciBjYWxsIHRvIHRoaXMgc2FtZSB0b29sLlxuICovXG5hc3luYyBmdW5jdGlvbiBnZW5lcmF0ZU9yUmV1c2VNaWxlc3RvbmVJZChwcm9qZWN0RGlyOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCB7XG4gICAgY2xhaW1SZXNlcnZlZElkLFxuICAgIGZpbmRNaWxlc3RvbmVJZHMsXG4gICAgZ2V0UmVzZXJ2ZWRNaWxlc3RvbmVJZHMsXG4gICAgbmV4dE1pbGVzdG9uZUlkLFxuICAgIG1pbGVzdG9uZUlkU29ydCxcbiAgfSA9IGF3YWl0IGltcG9ydExvY2FsTW9kdWxlPGFueT4oXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL21pbGVzdG9uZS1pZHMuanNcIik7XG5cbiAgY29uc3QgcmVzZXJ2ZWQgPSBjbGFpbVJlc2VydmVkSWQoKTtcbiAgaWYgKHJlc2VydmVkKSB7XG4gICAgYXdhaXQgZW5zdXJlTWlsZXN0b25lRGJSb3cocmVzZXJ2ZWQpO1xuICAgIHJldHVybiByZXNlcnZlZDtcbiAgfVxuXG4gIGNvbnN0IGFsbElkcyA9IFtcbiAgICAuLi5uZXcgU2V0KFtcbiAgICAgIC4uLmZpbmRNaWxlc3RvbmVJZHMocHJvamVjdERpciksXG4gICAgICAuLi5nZXRSZXNlcnZlZE1pbGVzdG9uZUlkcygpLFxuICAgICAgLi4uKGF3YWl0IGZpbmREYXRhYmFzZU1pbGVzdG9uZUlkcygpKSxcbiAgICBdKSxcbiAgXTtcblxuICAvLyBBdHRlbXB0IGdob3N0LUlEIHJldXNlIGJlZm9yZSBmYWxsaW5nIGJhY2sgdG8gbWF4KzEuXG4gIGNvbnN0IHsgaXNSZXVzYWJsZUdob3N0TWlsZXN0b25lIH0gPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxhbnk+KFxuICAgIFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zdGF0ZS5qc1wiLFxuICApO1xuICBjb25zdCBzb3J0ZWQgPSBbLi4uYWxsSWRzXS5zb3J0KG1pbGVzdG9uZUlkU29ydCk7XG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIHNvcnRlZCkge1xuICAgIGlmIChpc1JldXNhYmxlR2hvc3RNaWxlc3RvbmUocHJvamVjdERpciwgY2FuZGlkYXRlKSkge1xuICAgICAgYXdhaXQgZW5zdXJlTWlsZXN0b25lRGJSb3coY2FuZGlkYXRlKTtcbiAgICAgIHJldHVybiBjYW5kaWRhdGU7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgcHJlZnNNb2QgPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxhbnk+KFxuICAgIFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wcmVmZXJlbmNlcy5qc1wiLFxuICApLmNhdGNoKCgpID0+IG51bGwpO1xuICAvLyBHcmFjZWZ1bCBkZWdyYWRhdGlvbjogYSBjb3JydXB0IHByZWZlcmVuY2VzIGZpbGUgc2hvdWxkIG5vdCBjcmFzaFxuICAvLyBtaWxlc3RvbmUtaWQgZ2VuZXJhdGlvbi4gRmFsbCBiYWNrIHRvIG5vbi11bmlxdWUgSURzIGlmIGFueXRoaW5nXG4gIC8vIHRocm93cyBoZXJlIFx1MjAxNCBtYXRjaGVzIHRoZSBwcmUtZml4IGJlaGF2aW9yIGZvciBtaXNzaW5nIHByZWZzLlxuICBsZXQgdW5pcXVlRW5hYmxlZCA9IGZhbHNlO1xuICB0cnkge1xuICAgIHVuaXF1ZUVuYWJsZWQgPSAhIXByZWZzTW9kPy5sb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXM/Lihwcm9qZWN0RGlyKT8ucHJlZmVyZW5jZXM/LnVuaXF1ZV9taWxlc3RvbmVfaWRzO1xuICB9IGNhdGNoIHtcbiAgICB1bmlxdWVFbmFibGVkID0gZmFsc2U7XG4gIH1cbiAgY29uc3QgbmV4dElkID0gbmV4dE1pbGVzdG9uZUlkKGFsbElkcywgdW5pcXVlRW5hYmxlZCk7XG4gIGF3YWl0IGVuc3VyZU1pbGVzdG9uZURiUm93KG5leHRJZCk7XG4gIHJldHVybiBuZXh0SWQ7XG59XG5cbi8vIHByb2plY3REaXIgaXMgb3B0aW9uYWwuIFdoZW4gb21pdHRlZCwgdGhlIHNlcnZlciB1c2VzIHByb2Nlc3MuY3dkKCkuIFRoaXNcbi8vIHByZXZlbnRzIHRoZSBhZ2VudCBmcm9tIGJ1cm5pbmcgdG9rZW5zIHJlYXNvbmluZyBhYm91dCB3aGljaCBhYnNvbHV0ZSBwYXRoXG4vLyB0byBwYXNzIChnaXQgcm9vdCB2cyB3b3JrdHJlZSB2cyBzeW1saW5rLXJlc29sdmVkIGV4dGVybmFsIHN0YXRlIGxheW91dCkgXHUyMDE0XG4vLyB0aGUgc2VydmVyIGFscmVhZHkga25vd3Mgd2hlcmUgaXQgaXMgcnVubmluZy5cbmNvbnN0IHByb2plY3REaXJQYXJhbSA9IHpcbiAgLnN0cmluZygpXG4gIC5vcHRpb25hbCgpXG4gIC5kZXNjcmliZShcIk9wdGlvbmFsLiBPbWl0IHRoaXMgZmllbGQgXHUyMDE0IHRoZSBzZXJ2ZXIgZGVmYXVsdHMgdG8gaXRzIGN1cnJlbnQgd29ya2luZyBkaXJlY3RvcnksIHdoaWNoIGlzIGFscmVhZHkgdGhlIGNvcnJlY3QgcHJvamVjdCBvciB3b3JrdHJlZSByb290LlwiKTtcblxuY29uc3Qgbm9uRW1wdHlTdHJpbmcgPSAoZmllbGQ6IHN0cmluZykgPT5cbiAgei5zdHJpbmcoKS50cmltKCkubWluKDEsIGAke2ZpZWxkfSBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZ2ApO1xuXG4vLyBPcHRpb25hbCBub24tZW1wdHkgc3RyaW5nOiBhY2NlcHRzIG9taXR0ZWQvdW5kZWZpbmVkIGJ1dCByZWplY3RzIFwiXCIgb3Jcbi8vIHdoaXRlc3BhY2UuIE1pcnJvcnMgZXhlY3V0b3IgZ3VhcmRzIG9mIHRoZSBmb3JtXG4vLyBgdmFsdWUgIT09IHVuZGVmaW5lZCAmJiAhaXNOb25FbXB0eVN0cmluZyh2YWx1ZSlgIFx1MjAxNCBlLmcuIHBsYW4tdGFzaydzXG4vLyBvYnNlcnZhYmlsaXR5SW1wYWN0LiBEbyBub3QgcHJlcHJvY2VzcyBcIlwiIHRvIHVuZGVmaW5lZDsgdGhlIGV4ZWN1dG9yXG4vLyB0cmVhdHMgdGhlbSBkaWZmZXJlbnRseS5cbmNvbnN0IG9wdGlvbmFsTm9uRW1wdHlTdHJpbmcgPSAoZmllbGQ6IHN0cmluZykgPT4gbm9uRW1wdHlTdHJpbmcoZmllbGQpLm9wdGlvbmFsKCk7XG5cbi8vIEFycmF5IG9mIG5vbi1lbXB0eSBzdHJpbmdzLiBNaXJyb3JzIGV4ZWN1dG9yIGd1YXJkcyB0aGF0IGNhbGxcbi8vIGB2YWxpZGF0ZVN0cmluZ0FycmF5YCBvciBgYXJyLnNvbWUoKGl0ZW0pID0+ICFpc05vbkVtcHR5U3RyaW5nKGl0ZW0pKWAuXG5jb25zdCBub25FbXB0eVN0cmluZ0FycmF5ID0gKGZpZWxkOiBzdHJpbmcpID0+XG4gIHouYXJyYXkobm9uRW1wdHlTdHJpbmcoYCR7ZmllbGR9W11gKSk7XG5cbi8vIE1hdGNoZXMgdGhlIGV4ZWN1dG9yJ3MgYGlzTm9uRW1wdHlTdHJpbmdgICh0cmltICsgbGVuZ3RoPjApIHNvIFpvZCByZWplY3RzXG4vLyBlbXB0eS93aGl0ZXNwYWNlIGZpZWxkcyBhdCBwYXJzZSB0aW1lLiBXaXRob3V0IHRoaXMsIE1DUCBjYWxsZXJzIHBhc3MgXCJcIiBmb3Jcbi8vIHRoZSBoZWF2eSBwbGFubmluZyBmaWVsZHMsIFpvZCBhY2NlcHRzIGl0LCBhbmQgdGhlIGV4ZWN1dG9yIHJlamVjdHMgb25lXG4vLyBmaWVsZCBwZXIgY2FsbCBcdTIwMTQgZm9yY2luZyB0aGUgYWdlbnQgaW50byBhIHJldHJ5IGxvb3AgdG8gZGlzY292ZXIgZXZlcnkgZ2FwLlxuLy9cbi8vICM0NzU5IGZvbGxvdy11cDogdGhlIGZvdXIgaGVhdnkgZmllbGRzIGFyZSBab2Qtb3B0aW9uYWwgYmVjYXVzZSBza2V0Y2hcbi8vIHNsaWNlcyAoaXNTa2V0Y2g9dHJ1ZSkgbGVnaXRpbWF0ZWx5IG9taXQgdGhlbSwgYnV0IHRoZXkgYXJlIFJFUVVJUkVEIGZvclxuLy8gZXZlcnkgb3RoZXIgc2xpY2UuIFRoZSBjb25kaXRpb25hbCByZXF1aXJlbWVudCBpcyBpbnZpc2libGUgaW4gdGhlIEpTT05cbi8vIFNjaGVtYSBgcmVxdWlyZWRgIGFycmF5LCBzbyBjYWxsZXJzIGNhbiBvbmx5IGRpc2NvdmVyIGl0IGZyb20gdGhlXG4vLyBkZXNjcmlwdGlvbnMgb3IgYnkgaGl0dGluZyB0aGUgcnVudGltZSBzdXBlclJlZmluZSBiZWxvdy4gVGhlIGAuZGVzY3JpYmUoKWBcbi8vIGNhbGxzIGJlbG93IG1ha2UgdGhhdCBjb250cmFjdCB1bm1pc3Rha2FibGUgaW4gdGhlIHRvb2wgc2NoZW1hIHNlbnQgdG9cbi8vIGFnZW50czsgdGhlIHN1cGVyUmVmaW5lIGVuZm9yY2VzIGl0IGF0IHBhcnNlIHRpbWUuXG5jb25zdCBIRUFWWV9GSUVMRF9ERVNDUklCRSA9IChmaWVsZDogc3RyaW5nKSA9PlxuICBgJHtmaWVsZH0gZm9yIHRoaXMgc2xpY2UuIFJFUVVJUkVEIHVubGVzcyBpc1NrZXRjaD10cnVlIChza2V0Y2ggc2xpY2VzIGRlZmVyIHRoaXMgdG8gcmVmaW5lLXNsaWNlKS5gO1xuXG5jb25zdCBwbGFuTWlsZXN0b25lU2xpY2VTY2hlbWEgPSB6Lm9iamVjdCh7XG4gIHNsaWNlSWQ6IG5vbkVtcHR5U3RyaW5nKFwic2xpY2VJZFwiKSxcbiAgdGl0bGU6IG5vbkVtcHR5U3RyaW5nKFwidGl0bGVcIiksXG4gIHJpc2s6IG5vbkVtcHR5U3RyaW5nKFwicmlza1wiKSxcbiAgZGVwZW5kczogei5hcnJheSh6LnN0cmluZygpKSxcbiAgZGVtbzogbm9uRW1wdHlTdHJpbmcoXCJkZW1vXCIpLFxuICBnb2FsOiBub25FbXB0eVN0cmluZyhcImdvYWxcIiksXG4gIC8vIEFEUi0wMTE6IGhlYXZ5IHBsYW5uaW5nIGZpZWxkcyBhcmUgb3B0aW9uYWwgZm9yIHNrZXRjaCBzbGljZXM7IHJlcXVpcmVkIGZvciBmdWxsIHNsaWNlcy5cbiAgc3VjY2Vzc0NyaXRlcmlhOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoSEVBVllfRklFTERfREVTQ1JJQkUoXCJzdWNjZXNzQ3JpdGVyaWFcIikpLFxuICBwcm9vZkxldmVsOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoSEVBVllfRklFTERfREVTQ1JJQkUoXCJwcm9vZkxldmVsXCIpKSxcbiAgaW50ZWdyYXRpb25DbG9zdXJlOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoSEVBVllfRklFTERfREVTQ1JJQkUoXCJpbnRlZ3JhdGlvbkNsb3N1cmVcIikpLFxuICBvYnNlcnZhYmlsaXR5SW1wYWN0OiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoSEVBVllfRklFTERfREVTQ1JJQkUoXCJvYnNlcnZhYmlsaXR5SW1wYWN0XCIpKSxcbiAgLy8gQURSLTAxMSBza2V0Y2gtdGhlbi1yZWZpbmUgZmllbGRzLlxuICBpc1NrZXRjaDogei5ib29sZWFuKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIkFEUi0wMTE6IHRydWUgbWFya3MgdGhpcyBzbGljZSBhcyBhIHNrZXRjaCBhd2FpdGluZyByZWZpbmUtc2xpY2UgZXhwYW5zaW9uLiBXaGVuIHRydWUsIHN1Y2Nlc3NDcml0ZXJpYS9wcm9vZkxldmVsL2ludGVncmF0aW9uQ2xvc3VyZS9vYnNlcnZhYmlsaXR5SW1wYWN0IG1heSBiZSBvbWl0dGVkIGFuZCBza2V0Y2hTY29wZSBiZWNvbWVzIHJlcXVpcmVkLlwiKSxcbiAgc2tldGNoU2NvcGU6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIkFEUi0wMTE6IDItMyBzZW50ZW5jZSBzY29wZSBib3VuZGFyeSwgcmVxdWlyZWQgd2hlbiBpc1NrZXRjaD10cnVlXCIpLFxufSkuZGVzY3JpYmUoXG4gIFwiUGxhbm5lZCBzbGljZS4gRm9yIGZ1bGwgc2xpY2VzIChpc1NrZXRjaCBvbWl0dGVkIG9yIGZhbHNlKTogc3VjY2Vzc0NyaXRlcmlhLCBwcm9vZkxldmVsLCBpbnRlZ3JhdGlvbkNsb3N1cmUsIGFuZCBvYnNlcnZhYmlsaXR5SW1wYWN0IGFyZSBhbGwgcmVxdWlyZWQuIEZvciBza2V0Y2ggc2xpY2VzIChpc1NrZXRjaD10cnVlKTogdGhvc2UgZm91ciBmaWVsZHMgbWF5IGJlIG9taXR0ZWQsIGJ1dCBza2V0Y2hTY29wZSBpcyByZXF1aXJlZC5cIixcbikuc3VwZXJSZWZpbmUoKHNsaWNlLCBjdHgpID0+IHtcbiAgaWYgKHNsaWNlLmlzU2tldGNoID09PSB0cnVlKSB7XG4gICAgaWYgKHR5cGVvZiBzbGljZS5za2V0Y2hTY29wZSAhPT0gXCJzdHJpbmdcIiB8fCBzbGljZS5za2V0Y2hTY29wZS50cmltKCkubGVuZ3RoID09PSAwKSB7XG4gICAgICBjdHguYWRkSXNzdWUoe1xuICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgIHBhdGg6IFtcInNrZXRjaFNjb3BlXCJdLFxuICAgICAgICBtZXNzYWdlOiBcInNrZXRjaFNjb3BlIG11c3QgYmUgYSBub24tZW1wdHkgc3RyaW5nIHdoZW4gaXNTa2V0Y2ggaXMgdHJ1ZVwiLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCByZXF1aXJlZCA9IFtcInN1Y2Nlc3NDcml0ZXJpYVwiLCBcInByb29mTGV2ZWxcIiwgXCJpbnRlZ3JhdGlvbkNsb3N1cmVcIiwgXCJvYnNlcnZhYmlsaXR5SW1wYWN0XCJdIGFzIGNvbnN0O1xuICBmb3IgKGNvbnN0IGZpZWxkIG9mIHJlcXVpcmVkKSB7XG4gICAgY29uc3QgdmFsdWUgPSBzbGljZVtmaWVsZF07XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCB2YWx1ZS50cmltKCkubGVuZ3RoID09PSAwKSB7XG4gICAgICBjdHguYWRkSXNzdWUoe1xuICAgICAgICBjb2RlOiB6LlpvZElzc3VlQ29kZS5jdXN0b20sXG4gICAgICAgIHBhdGg6IFtmaWVsZF0sXG4gICAgICAgIG1lc3NhZ2U6IGAke2ZpZWxkfSBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZ2AsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn0pO1xuXG5jb25zdCBwbGFuTWlsZXN0b25lUGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG4gIG1pbGVzdG9uZUlkOiBub25FbXB0eVN0cmluZyhcIm1pbGVzdG9uZUlkXCIpLmRlc2NyaWJlKFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIpLFxuICB0aXRsZTogbm9uRW1wdHlTdHJpbmcoXCJ0aXRsZVwiKS5kZXNjcmliZShcIk1pbGVzdG9uZSB0aXRsZVwiKSxcbiAgdmlzaW9uOiBub25FbXB0eVN0cmluZyhcInZpc2lvblwiKS5kZXNjcmliZShcIk1pbGVzdG9uZSB2aXNpb25cIiksXG4gIHNsaWNlczogei5hcnJheShwbGFuTWlsZXN0b25lU2xpY2VTY2hlbWEpLmRlc2NyaWJlKFwiUGxhbm5lZCBzbGljZXMgZm9yIHRoZSBtaWxlc3RvbmVcIiksXG4gIHN0YXR1czogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiTWlsZXN0b25lIHN0YXR1c1wiKSxcbiAgZGVwZW5kc09uOiB6LmFycmF5KHouc3RyaW5nKCkpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJNaWxlc3RvbmUgZGVwZW5kZW5jaWVzXCIpLFxuICBzdWNjZXNzQ3JpdGVyaWE6IHouYXJyYXkoei5zdHJpbmcoKSkub3B0aW9uYWwoKS5kZXNjcmliZShcIlRvcC1sZXZlbCBzdWNjZXNzIGNyaXRlcmlhIGJ1bGxldHNcIiksXG4gIGtleVJpc2tzOiB6LmFycmF5KHoub2JqZWN0KHtcbiAgICByaXNrOiBub25FbXB0eVN0cmluZyhcInJpc2tcIiksXG4gICAgd2h5SXRNYXR0ZXJzOiBub25FbXB0eVN0cmluZyhcIndoeUl0TWF0dGVyc1wiKSxcbiAgfSkpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJTdHJ1Y3R1cmVkIHJpc2sgZW50cmllc1wiKSxcbiAgcHJvb2ZTdHJhdGVneTogei5hcnJheSh6Lm9iamVjdCh7XG4gICAgcmlza09yVW5rbm93bjogbm9uRW1wdHlTdHJpbmcoXCJyaXNrT3JVbmtub3duXCIpLFxuICAgIHJldGlyZUluOiBub25FbXB0eVN0cmluZyhcInJldGlyZUluXCIpLFxuICAgIHdoYXRXaWxsQmVQcm92ZW46IG5vbkVtcHR5U3RyaW5nKFwid2hhdFdpbGxCZVByb3ZlblwiKSxcbiAgfSkpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJTdHJ1Y3R1cmVkIHByb29mIHN0cmF0ZWd5IGVudHJpZXNcIiksXG4gIHZlcmlmaWNhdGlvbkNvbnRyYWN0OiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIHZlcmlmaWNhdGlvbkludGVncmF0aW9uOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIHZlcmlmaWNhdGlvbk9wZXJhdGlvbmFsOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIHZlcmlmaWNhdGlvblVhdDogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxuICBkZWZpbml0aW9uT2ZEb25lOiB6LmFycmF5KHouc3RyaW5nKCkpLm9wdGlvbmFsKCksXG4gIHJlcXVpcmVtZW50Q292ZXJhZ2U6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgYm91bmRhcnlNYXBNYXJrZG93bjogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxufTtcbmNvbnN0IHBsYW5NaWxlc3RvbmVTY2hlbWEgPSB6Lm9iamVjdChwbGFuTWlsZXN0b25lUGFyYW1zKTtcblxuY29uc3QgcGxhblNsaWNlUGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG4gIG1pbGVzdG9uZUlkOiBub25FbXB0eVN0cmluZyhcIm1pbGVzdG9uZUlkXCIpLmRlc2NyaWJlKFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIpLFxuICBzbGljZUlkOiBub25FbXB0eVN0cmluZyhcInNsaWNlSWRcIikuZGVzY3JpYmUoXCJTbGljZSBJRCAoZS5nLiBTMDEpXCIpLFxuICBnb2FsOiBub25FbXB0eVN0cmluZyhcImdvYWxcIikuZGVzY3JpYmUoXCJTbGljZSBnb2FsXCIpLFxuICB0YXNrczogei5hcnJheSh6Lm9iamVjdCh7XG4gICAgdGFza0lkOiBub25FbXB0eVN0cmluZyhcInRhc2tJZFwiKSxcbiAgICB0aXRsZTogbm9uRW1wdHlTdHJpbmcoXCJ0aXRsZVwiKSxcbiAgICBkZXNjcmlwdGlvbjogbm9uRW1wdHlTdHJpbmcoXCJkZXNjcmlwdGlvblwiKSxcbiAgICBlc3RpbWF0ZTogbm9uRW1wdHlTdHJpbmcoXCJlc3RpbWF0ZVwiKSxcbiAgICBmaWxlczogbm9uRW1wdHlTdHJpbmdBcnJheShcImZpbGVzXCIpLFxuICAgIHZlcmlmeTogbm9uRW1wdHlTdHJpbmcoXCJ2ZXJpZnlcIiksXG4gICAgaW5wdXRzOiBub25FbXB0eVN0cmluZ0FycmF5KFwiaW5wdXRzXCIpLFxuICAgIGV4cGVjdGVkT3V0cHV0OiBub25FbXB0eVN0cmluZ0FycmF5KFwiZXhwZWN0ZWRPdXRwdXRcIiksXG4gICAgb2JzZXJ2YWJpbGl0eUltcGFjdDogb3B0aW9uYWxOb25FbXB0eVN0cmluZyhcIm9ic2VydmFiaWxpdHlJbXBhY3RcIiksXG4gIH0pKS5kZXNjcmliZShcIlBsYW5uZWQgdGFza3MgZm9yIHRoZSBzbGljZVwiKSxcbiAgc3VjY2Vzc0NyaXRlcmlhOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIHByb29mTGV2ZWw6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgaW50ZWdyYXRpb25DbG9zdXJlOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIG9ic2VydmFiaWxpdHlJbXBhY3Q6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbn07XG5jb25zdCBwbGFuU2xpY2VTY2hlbWEgPSB6Lm9iamVjdChwbGFuU2xpY2VQYXJhbXMpO1xuXG5jb25zdCBjb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyA9IHtcbiAgcHJvamVjdERpcjogcHJvamVjdERpclBhcmFtLFxuICBtaWxlc3RvbmVJZDogbm9uRW1wdHlTdHJpbmcoXCJtaWxlc3RvbmVJZFwiKS5kZXNjcmliZShcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKVwiKSxcbiAgdGl0bGU6IG5vbkVtcHR5U3RyaW5nKFwidGl0bGVcIikuZGVzY3JpYmUoXCJNaWxlc3RvbmUgdGl0bGVcIiksXG4gIG9uZUxpbmVyOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiT25lLXNlbnRlbmNlIHN1bW1hcnkgb2Ygd2hhdCB0aGUgbWlsZXN0b25lIGFjaGlldmVkXCIpLFxuICBuYXJyYXRpdmU6IHouc3RyaW5nKCkuZGVzY3JpYmUoXCJEZXRhaWxlZCBuYXJyYXRpdmUgb2Ygd2hhdCBoYXBwZW5lZCBkdXJpbmcgdGhlIG1pbGVzdG9uZVwiKSxcbiAgdmVyaWZpY2F0aW9uUGFzc2VkOiB6LmJvb2xlYW4oKS5kZXNjcmliZShcIk11c3QgYmUgdHJ1ZSBhZnRlciBtaWxlc3RvbmUgdmVyaWZpY2F0aW9uIHN1Y2NlZWRzXCIpLFxuICBzdWNjZXNzQ3JpdGVyaWFSZXN1bHRzOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIGRlZmluaXRpb25PZkRvbmVSZXN1bHRzOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIHJlcXVpcmVtZW50T3V0Y29tZXM6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAga2V5RGVjaXNpb25zOiB6LmFycmF5KHouc3RyaW5nKCkpLm9wdGlvbmFsKCksXG4gIGtleUZpbGVzOiB6LmFycmF5KHouc3RyaW5nKCkpLm9wdGlvbmFsKCksXG4gIGxlc3NvbnNMZWFybmVkOiB6LmFycmF5KHouc3RyaW5nKCkpLm9wdGlvbmFsKCksXG4gIGZvbGxvd1Vwczogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxuICBkZXZpYXRpb25zOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG59O1xuY29uc3QgY29tcGxldGVNaWxlc3RvbmVTY2hlbWEgPSB6Lm9iamVjdChjb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyk7XG5cbmNvbnN0IHZhbGlkYXRlTWlsZXN0b25lUGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG4gIG1pbGVzdG9uZUlkOiBub25FbXB0eVN0cmluZyhcIm1pbGVzdG9uZUlkXCIpLmRlc2NyaWJlKFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIpLFxuICB2ZXJkaWN0OiB6LmVudW0oW1wicGFzc1wiLCBcIm5lZWRzLWF0dGVudGlvblwiLCBcIm5lZWRzLXJlbWVkaWF0aW9uXCJdKS5kZXNjcmliZShcIlZhbGlkYXRpb24gdmVyZGljdFwiKSxcbiAgcmVtZWRpYXRpb25Sb3VuZDogei5udW1iZXIoKS5kZXNjcmliZShcIlJlbWVkaWF0aW9uIHJvdW5kICgwIGZvciBmaXJzdCB2YWxpZGF0aW9uKVwiKSxcbiAgc3VjY2Vzc0NyaXRlcmlhQ2hlY2tsaXN0OiB6LnN0cmluZygpLmRlc2NyaWJlKFwiTWFya2Rvd24gY2hlY2tsaXN0IG9mIHN1Y2Nlc3MgY3JpdGVyaWEgd2l0aCBldmlkZW5jZVwiKSxcbiAgc2xpY2VEZWxpdmVyeUF1ZGl0OiB6LnN0cmluZygpLmRlc2NyaWJlKFwiTWFya2Rvd24gYXVkaXRpbmcgZWFjaCBzbGljZSdzIGNsYWltZWQgdnMgZGVsaXZlcmVkIG91dHB1dFwiKSxcbiAgY3Jvc3NTbGljZUludGVncmF0aW9uOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiTWFya2Rvd24gZGVzY3JpYmluZyBjcm9zcy1zbGljZSBpc3N1ZXMgb3IgY2xvc3VyZVwiKSxcbiAgcmVxdWlyZW1lbnRDb3ZlcmFnZTogei5zdHJpbmcoKS5kZXNjcmliZShcIk1hcmtkb3duIGRlc2NyaWJpbmcgcmVxdWlyZW1lbnQgY292ZXJhZ2UgYW5kIGdhcHNcIiksXG4gIHZlcmlmaWNhdGlvbkNsYXNzZXM6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgdmVyZGljdFJhdGlvbmFsZTogei5zdHJpbmcoKS5kZXNjcmliZShcIldoeSB0aGlzIHZlcmRpY3Qgd2FzIGNob3NlblwiKSxcbiAgcmVtZWRpYXRpb25QbGFuOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG59O1xuY29uc3QgdmFsaWRhdGVNaWxlc3RvbmVTY2hlbWEgPSB6Lm9iamVjdCh2YWxpZGF0ZU1pbGVzdG9uZVBhcmFtcyk7XG5cbmNvbnN0IHJvYWRtYXBTbGljZUNoYW5nZVNjaGVtYSA9IHoub2JqZWN0KHtcbiAgc2xpY2VJZDogbm9uRW1wdHlTdHJpbmcoXCJzbGljZUlkXCIpLFxuICB0aXRsZTogbm9uRW1wdHlTdHJpbmcoXCJ0aXRsZVwiKSxcbiAgcmlzazogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxuICBkZXBlbmRzOiB6LmFycmF5KHouc3RyaW5nKCkpLm9wdGlvbmFsKCksXG4gIGRlbW86IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbn0pO1xuXG5jb25zdCByZWFzc2Vzc1JvYWRtYXBQYXJhbXMgPSB7XG4gIHByb2plY3REaXI6IHByb2plY3REaXJQYXJhbSxcbiAgbWlsZXN0b25lSWQ6IG5vbkVtcHR5U3RyaW5nKFwibWlsZXN0b25lSWRcIikuZGVzY3JpYmUoXCJNaWxlc3RvbmUgSUQgKGUuZy4gTTAwMSlcIiksXG4gIGNvbXBsZXRlZFNsaWNlSWQ6IG5vbkVtcHR5U3RyaW5nKFwiY29tcGxldGVkU2xpY2VJZFwiKS5kZXNjcmliZShcIlNsaWNlIElEIHRoYXQganVzdCBjb21wbGV0ZWRcIiksXG4gIHZlcmRpY3Q6IG5vbkVtcHR5U3RyaW5nKFwidmVyZGljdFwiKS5kZXNjcmliZShcIkFzc2Vzc21lbnQgdmVyZGljdCBzdWNoIGFzIHJvYWRtYXAtY29uZmlybWVkIG9yIHJvYWRtYXAtYWRqdXN0ZWRcIiksXG4gIGFzc2Vzc21lbnQ6IG5vbkVtcHR5U3RyaW5nKFwiYXNzZXNzbWVudFwiKS5kZXNjcmliZShcIkFzc2Vzc21lbnQgdGV4dCBleHBsYWluaW5nIHRoZSByb2FkbWFwIGRlY2lzaW9uXCIpLFxuICBzbGljZUNoYW5nZXM6IHoub2JqZWN0KHtcbiAgICBtb2RpZmllZDogei5hcnJheShyb2FkbWFwU2xpY2VDaGFuZ2VTY2hlbWEpLFxuICAgIGFkZGVkOiB6LmFycmF5KHJvYWRtYXBTbGljZUNoYW5nZVNjaGVtYSksXG4gICAgcmVtb3ZlZDogei5hcnJheSh6LnN0cmluZygpKSxcbiAgfSkuZGVzY3JpYmUoXCJTbGljZSBjaGFuZ2VzIHRvIGFwcGx5XCIpLFxufTtcbmNvbnN0IHJlYXNzZXNzUm9hZG1hcFNjaGVtYSA9IHoub2JqZWN0KHJlYXNzZXNzUm9hZG1hcFBhcmFtcyk7XG5cbmNvbnN0IHNhdmVHYXRlUmVzdWx0UGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG4gIG1pbGVzdG9uZUlkOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIpLFxuICBzbGljZUlkOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiU2xpY2UgSUQgKGUuZy4gUzAxKVwiKSxcbiAgZ2F0ZUlkOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiR2F0ZSBJRCAoZS5nLiBRMywgUTQsIFE1LCBRNiwgUTcsIFE4LCBNVjAxLCBNVjAyLCBNVjAzLCBNVjA0KS4gQWNjZXB0cyBhbnkgc3RyaW5nIGZvciBmb3J3YXJkLWNvbXBhdGliaWxpdHkgd2l0aCBuZXcgZ2F0ZXMuXCIpLFxuICB0YXNrSWQ6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIlRhc2sgSUQgZm9yIHRhc2stc2NvcGVkIGdhdGVzXCIpLFxuICB2ZXJkaWN0OiB6LmVudW0oW1wicGFzc1wiLCBcImZsYWdcIiwgXCJvbWl0dGVkXCJdKS5kZXNjcmliZShcIkdhdGUgdmVyZGljdFwiKSxcbiAgcmF0aW9uYWxlOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiT25lLXNlbnRlbmNlIGp1c3RpZmljYXRpb25cIiksXG4gIGZpbmRpbmdzOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJEZXRhaWxlZCBtYXJrZG93biBmaW5kaW5nc1wiKSxcbn07XG5jb25zdCBzYXZlR2F0ZVJlc3VsdFNjaGVtYSA9IHoub2JqZWN0KHNhdmVHYXRlUmVzdWx0UGFyYW1zKTtcblxuY29uc3QgcmVwbGFuU2xpY2VQYXJhbXMgPSB7XG4gIHByb2plY3REaXI6IHByb2plY3REaXJQYXJhbSxcbiAgbWlsZXN0b25lSWQ6IG5vbkVtcHR5U3RyaW5nKFwibWlsZXN0b25lSWRcIikuZGVzY3JpYmUoXCJNaWxlc3RvbmUgSUQgKGUuZy4gTTAwMSlcIiksXG4gIHNsaWNlSWQ6IG5vbkVtcHR5U3RyaW5nKFwic2xpY2VJZFwiKS5kZXNjcmliZShcIlNsaWNlIElEIChlLmcuIFMwMSlcIiksXG4gIGJsb2NrZXJUYXNrSWQ6IG5vbkVtcHR5U3RyaW5nKFwiYmxvY2tlclRhc2tJZFwiKS5kZXNjcmliZShcIlRhc2sgSUQgdGhhdCBkaXNjb3ZlcmVkIHRoZSBibG9ja2VyXCIpLFxuICBibG9ja2VyRGVzY3JpcHRpb246IG5vbkVtcHR5U3RyaW5nKFwiYmxvY2tlckRlc2NyaXB0aW9uXCIpLmRlc2NyaWJlKFwiRGVzY3JpcHRpb24gb2YgdGhlIGJsb2NrZXJcIiksXG4gIHdoYXRDaGFuZ2VkOiBub25FbXB0eVN0cmluZyhcIndoYXRDaGFuZ2VkXCIpLmRlc2NyaWJlKFwiU3VtbWFyeSBvZiB3aGF0IGNoYW5nZWQgaW4gdGhlIHBsYW5cIiksXG4gIHVwZGF0ZWRUYXNrczogei5hcnJheSh6Lm9iamVjdCh7XG4gICAgdGFza0lkOiBub25FbXB0eVN0cmluZyhcInRhc2tJZFwiKSxcbiAgICB0aXRsZTogbm9uRW1wdHlTdHJpbmcoXCJ0aXRsZVwiKSxcbiAgICBkZXNjcmlwdGlvbjogei5zdHJpbmcoKSxcbiAgICBlc3RpbWF0ZTogei5zdHJpbmcoKSxcbiAgICBmaWxlczogei5hcnJheSh6LnN0cmluZygpKSxcbiAgICB2ZXJpZnk6IHouc3RyaW5nKCksXG4gICAgaW5wdXRzOiB6LmFycmF5KHouc3RyaW5nKCkpLFxuICAgIGV4cGVjdGVkT3V0cHV0OiB6LmFycmF5KHouc3RyaW5nKCkpLFxuICAgIGZ1bGxQbGFuTWQ6IHouc3RyaW5nKCkub3B0aW9uYWwoKSxcbiAgfSkpLmRlc2NyaWJlKFwiVGFza3MgdG8gdXBzZXJ0IGludG8gdGhlIHJlcGxhbm5lZCBzbGljZVwiKSxcbiAgcmVtb3ZlZFRhc2tJZHM6IHouYXJyYXkoei5zdHJpbmcoKSkuZGVzY3JpYmUoXCJUYXNrIElEcyB0byByZW1vdmUgZnJvbSB0aGUgc2xpY2VcIiksXG59O1xuY29uc3QgcmVwbGFuU2xpY2VTY2hlbWEgPSB6Lm9iamVjdChyZXBsYW5TbGljZVBhcmFtcyk7XG5cbmNvbnN0IHNsaWNlQ29tcGxldGVQYXJhbXMgPSB7XG4gIHByb2plY3REaXI6IHByb2plY3REaXJQYXJhbSxcbiAgc2xpY2VJZDogbm9uRW1wdHlTdHJpbmcoXCJzbGljZUlkXCIpLmRlc2NyaWJlKFwiU2xpY2UgSUQgKGUuZy4gUzAxKVwiKSxcbiAgbWlsZXN0b25lSWQ6IG5vbkVtcHR5U3RyaW5nKFwibWlsZXN0b25lSWRcIikuZGVzY3JpYmUoXCJNaWxlc3RvbmUgSUQgKGUuZy4gTTAwMSlcIiksXG4gIHNsaWNlVGl0bGU6IHouc3RyaW5nKCkuZGVzY3JpYmUoXCJUaXRsZSBvZiB0aGUgc2xpY2VcIiksXG4gIG9uZUxpbmVyOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiT25lLWxpbmUgc3VtbWFyeSBvZiB3aGF0IHRoZSBzbGljZSBhY2NvbXBsaXNoZWRcIiksXG4gIG5hcnJhdGl2ZTogei5zdHJpbmcoKS5kZXNjcmliZShcIkRldGFpbGVkIG5hcnJhdGl2ZSBvZiB3aGF0IGhhcHBlbmVkIGFjcm9zcyBhbGwgdGFza3NcIiksXG4gIHZlcmlmaWNhdGlvbjogei5zdHJpbmcoKS5kZXNjcmliZShcIldoYXQgd2FzIHZlcmlmaWVkIGFjcm9zcyBhbGwgdGFza3NcIiksXG4gIHVhdENvbnRlbnQ6IHouc3RyaW5nKCkuZGVzY3JpYmUoXCJVQVQgdGVzdCBjb250ZW50IChtYXJrZG93biBib2R5KVwiKSxcbiAgZGV2aWF0aW9uczogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxuICBrbm93bkxpbWl0YXRpb25zOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gIGZvbGxvd1Vwczogei5zdHJpbmcoKS5vcHRpb25hbCgpLFxuICBrZXlGaWxlczogei51bmlvbihbei5hcnJheSh6LnN0cmluZygpKSwgei5zdHJpbmcoKV0pLm9wdGlvbmFsKCksXG4gIGtleURlY2lzaW9uczogei51bmlvbihbei5hcnJheSh6LnN0cmluZygpKSwgei5zdHJpbmcoKV0pLm9wdGlvbmFsKCksXG4gIHBhdHRlcm5zRXN0YWJsaXNoZWQ6IHoudW5pb24oW3ouYXJyYXkoei5zdHJpbmcoKSksIHouc3RyaW5nKCldKS5vcHRpb25hbCgpLFxuICBvYnNlcnZhYmlsaXR5U3VyZmFjZXM6IHoudW5pb24oW3ouYXJyYXkoei5zdHJpbmcoKSksIHouc3RyaW5nKCldKS5vcHRpb25hbCgpLFxuICBwcm92aWRlczogei51bmlvbihbei5hcnJheSh6LnN0cmluZygpKSwgei5zdHJpbmcoKV0pLm9wdGlvbmFsKCksXG4gIHJlcXVpcmVtZW50c1N1cmZhY2VkOiB6LnVuaW9uKFt6LmFycmF5KHouc3RyaW5nKCkpLCB6LnN0cmluZygpXSkub3B0aW9uYWwoKSxcbiAgZHJpbGxEb3duUGF0aHM6IHoudW5pb24oW3ouYXJyYXkoei5zdHJpbmcoKSksIHouc3RyaW5nKCldKS5vcHRpb25hbCgpLFxuICBhZmZlY3RzOiB6LnVuaW9uKFt6LmFycmF5KHouc3RyaW5nKCkpLCB6LnN0cmluZygpXSkub3B0aW9uYWwoKSxcbiAgcmVxdWlyZW1lbnRzQWR2YW5jZWQ6IHouYXJyYXkoei51bmlvbihbXG4gICAgei5vYmplY3QoeyBpZDogei5zdHJpbmcoKSwgaG93OiB6LnN0cmluZygpIH0pLFxuICAgIHouc3RyaW5nKCksXG4gIF0pKS5vcHRpb25hbCgpLFxuICByZXF1aXJlbWVudHNWYWxpZGF0ZWQ6IHouYXJyYXkoei51bmlvbihbXG4gICAgei5vYmplY3QoeyBpZDogei5zdHJpbmcoKSwgcHJvb2Y6IHouc3RyaW5nKCkgfSksXG4gICAgei5zdHJpbmcoKSxcbiAgXSkpLm9wdGlvbmFsKCksXG4gIHJlcXVpcmVtZW50c0ludmFsaWRhdGVkOiB6LmFycmF5KHoudW5pb24oW1xuICAgIHoub2JqZWN0KHsgaWQ6IHouc3RyaW5nKCksIHdoYXQ6IHouc3RyaW5nKCkgfSksXG4gICAgei5zdHJpbmcoKSxcbiAgXSkpLm9wdGlvbmFsKCksXG4gIGZpbGVzTW9kaWZpZWQ6IHouYXJyYXkoei51bmlvbihbXG4gICAgei5vYmplY3QoeyBwYXRoOiB6LnN0cmluZygpLCBkZXNjcmlwdGlvbjogei5zdHJpbmcoKSB9KSxcbiAgICB6LnN0cmluZygpLFxuICBdKSkub3B0aW9uYWwoKSxcbiAgcmVxdWlyZXM6IHouYXJyYXkoei51bmlvbihbXG4gICAgei5vYmplY3QoeyBzbGljZTogei5zdHJpbmcoKSwgcHJvdmlkZXM6IHouc3RyaW5nKCkgfSksXG4gICAgei5zdHJpbmcoKSxcbiAgXSkpLm9wdGlvbmFsKCksXG59O1xuY29uc3Qgc2xpY2VDb21wbGV0ZVNjaGVtYSA9IHoub2JqZWN0KHNsaWNlQ29tcGxldGVQYXJhbXMpO1xuXG5jb25zdCBzdW1tYXJ5U2F2ZVBhcmFtcyA9IHtcbiAgcHJvamVjdERpcjogcHJvamVjdERpclBhcmFtLFxuICBtaWxlc3RvbmVfaWQ6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKS4gT21pdCBvbmx5IGZvciByb290LWxldmVsIFBST0pFQ1QvUFJPSkVDVC1EUkFGVC9SRVFVSVJFTUVOVFMvUkVRVUlSRU1FTlRTLURSQUZUIGFydGlmYWN0cy5cIiksXG4gIHNsaWNlX2lkOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJTbGljZSBJRCAoZS5nLiBTMDEpXCIpLFxuICB0YXNrX2lkOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJUYXNrIElEIChlLmcuIFQwMSlcIiksXG4gIGFydGlmYWN0X3R5cGU6IHouc3RyaW5nKCkuZGVzY3JpYmUoXCJBcnRpZmFjdCB0eXBlIHRvIHNhdmUgKFNVTU1BUlksIFJFU0VBUkNILCBDT05URVhULCBBU1NFU1NNRU5ULCBDT05URVhULURSQUZULCBQUk9KRUNULCBQUk9KRUNULURSQUZULCBSRVFVSVJFTUVOVFMsIFJFUVVJUkVNRU5UUy1EUkFGVClcIiksXG4gIGNvbnRlbnQ6IHouc3RyaW5nKCkuZGVzY3JpYmUoXCJUaGUgZnVsbCBtYXJrZG93biBjb250ZW50IG9mIHRoZSBhcnRpZmFjdFwiKSxcbn07XG5jb25zdCBST09UX1NVTU1BUllfQVJUSUZBQ1RfVFlQRVMgPSBuZXcgU2V0KFtcbiAgXCJQUk9KRUNUXCIsXG4gIFwiUFJPSkVDVC1EUkFGVFwiLFxuICBcIlJFUVVJUkVNRU5UU1wiLFxuICBcIlJFUVVJUkVNRU5UUy1EUkFGVFwiLFxuXSk7XG5jb25zdCBzdW1tYXJ5U2F2ZVNjaGVtYSA9IHoub2JqZWN0KHN1bW1hcnlTYXZlUGFyYW1zKS5zdXBlclJlZmluZSgodmFsdWUsIGN0eCkgPT4ge1xuICBjb25zdCBpc1Jvb3RBcnRpZmFjdCA9IFJPT1RfU1VNTUFSWV9BUlRJRkFDVF9UWVBFUy5oYXModmFsdWUuYXJ0aWZhY3RfdHlwZSk7XG4gIGlmICghaXNSb290QXJ0aWZhY3QgJiYgKCF2YWx1ZS5taWxlc3RvbmVfaWQgfHwgdmFsdWUubWlsZXN0b25lX2lkLnRyaW0oKSA9PT0gXCJcIikpIHtcbiAgICBjdHguYWRkSXNzdWUoe1xuICAgICAgY29kZTogei5ab2RJc3N1ZUNvZGUuY3VzdG9tLFxuICAgICAgcGF0aDogW1wibWlsZXN0b25lX2lkXCJdLFxuICAgICAgbWVzc2FnZTogXCJtaWxlc3RvbmVfaWQgaXMgcmVxdWlyZWQgZm9yIG1pbGVzdG9uZS1zY29wZWQgYXJ0aWZhY3QgdHlwZXNcIixcbiAgICB9KTtcbiAgfVxufSk7XG5cbmNvbnN0IGRlY2lzaW9uU2F2ZVBhcmFtcyA9IHtcbiAgcHJvamVjdERpcjogcHJvamVjdERpclBhcmFtLFxuICBzY29wZTogei5zdHJpbmcoKS5kZXNjcmliZShcIlNjb3BlIG9mIHRoZSBkZWNpc2lvbiAoZS5nLiBhcmNoaXRlY3R1cmUsIGxpYnJhcnksIG9ic2VydmFiaWxpdHkpXCIpLFxuICBkZWNpc2lvbjogei5zdHJpbmcoKS5kZXNjcmliZShcIldoYXQgaXMgYmVpbmcgZGVjaWRlZFwiKSxcbiAgY2hvaWNlOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiVGhlIGNob2ljZSBtYWRlXCIpLFxuICByYXRpb25hbGU6IHouc3RyaW5nKCkuZGVzY3JpYmUoXCJXaHkgdGhpcyBjaG9pY2Ugd2FzIG1hZGVcIiksXG4gIHJldmlzYWJsZTogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiV2hldGhlciB0aGlzIGNhbiBiZSByZXZpc2l0ZWRcIiksXG4gIHdoZW5fY29udGV4dDogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiV2hlbi9jb250ZXh0IGZvciB0aGUgZGVjaXNpb25cIiksXG4gIG1hZGVfYnk6IHouZW51bShbXCJodW1hblwiLCBcImFnZW50XCIsIFwiY29sbGFib3JhdGl2ZVwiXSkub3B0aW9uYWwoKS5kZXNjcmliZShcIldobyBtYWRlIHRoZSBkZWNpc2lvblwiKSxcbn07XG5jb25zdCBkZWNpc2lvblNhdmVTY2hlbWEgPSB6Lm9iamVjdChkZWNpc2lvblNhdmVQYXJhbXMpO1xuXG5jb25zdCByZXF1aXJlbWVudFVwZGF0ZVBhcmFtcyA9IHtcbiAgcHJvamVjdERpcjogcHJvamVjdERpclBhcmFtLFxuICBpZDogei5zdHJpbmcoKS5kZXNjcmliZShcIlJlcXVpcmVtZW50IElEIChlLmcuIFIwMDEpXCIpLFxuICBzdGF0dXM6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIk5ldyBzdGF0dXNcIiksXG4gIHZhbGlkYXRpb246IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIlZhbGlkYXRpb24gY3JpdGVyaWEgb3IgcHJvb2ZcIiksXG4gIG5vdGVzOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJBZGRpdGlvbmFsIG5vdGVzXCIpLFxuICBkZXNjcmlwdGlvbjogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiVXBkYXRlZCBkZXNjcmlwdGlvblwiKSxcbiAgcHJpbWFyeV9vd25lcjogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiUHJpbWFyeSBvd25pbmcgc2xpY2VcIiksXG4gIHN1cHBvcnRpbmdfc2xpY2VzOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJTdXBwb3J0aW5nIHNsaWNlc1wiKSxcbn07XG5jb25zdCByZXF1aXJlbWVudFVwZGF0ZVNjaGVtYSA9IHoub2JqZWN0KHJlcXVpcmVtZW50VXBkYXRlUGFyYW1zKTtcblxuY29uc3QgcmVxdWlyZW1lbnRTYXZlUGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG4gIGNsYXNzOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiUmVxdWlyZW1lbnQgY2xhc3M6IGNvcmUtY2FwYWJpbGl0eSwgcHJpbWFyeS11c2VyLWxvb3AsIGxhdW5jaGFiaWxpdHksIGNvbnRpbnVpdHksIGZhaWx1cmUtdmlzaWJpbGl0eSwgaW50ZWdyYXRpb24sIHF1YWxpdHktYXR0cmlidXRlLCBvcGVyYWJpbGl0eSwgYWRtaW4vc3VwcG9ydCwgY29tcGxpYW5jZS9zZWN1cml0eSwgZGlmZmVyZW50aWF0b3IsIGNvbnN0cmFpbnQsIG9yIGFudGktZmVhdHVyZVwiKSxcbiAgZGVzY3JpcHRpb246IHouc3RyaW5nKCkuZGVzY3JpYmUoXCJTaG9ydCBkZXNjcmlwdGlvbiBvZiB0aGUgcmVxdWlyZW1lbnRcIiksXG4gIHdoeTogei5zdHJpbmcoKS5kZXNjcmliZShcIldoeSB0aGlzIHJlcXVpcmVtZW50IG1hdHRlcnNcIiksXG4gIHNvdXJjZTogei5zdHJpbmcoKS5kZXNjcmliZShcIk9yaWdpbiBvZiB0aGUgcmVxdWlyZW1lbnRcIiksXG4gIHN0YXR1czogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiUmVxdWlyZW1lbnQgc3RhdHVzXCIpLFxuICBwcmltYXJ5X293bmVyOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJQcmltYXJ5IG93bmluZyBzbGljZVwiKSxcbiAgc3VwcG9ydGluZ19zbGljZXM6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIlN1cHBvcnRpbmcgc2xpY2VzXCIpLFxuICB2YWxpZGF0aW9uOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJWYWxpZGF0aW9uIGNyaXRlcmlhXCIpLFxuICBub3Rlczogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiQWRkaXRpb25hbCBub3Rlc1wiKSxcbn07XG5jb25zdCByZXF1aXJlbWVudFNhdmVTY2hlbWEgPSB6Lm9iamVjdChyZXF1aXJlbWVudFNhdmVQYXJhbXMpO1xuXG5jb25zdCBtaWxlc3RvbmVHZW5lcmF0ZUlkUGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG59O1xuY29uc3QgbWlsZXN0b25lR2VuZXJhdGVJZFNjaGVtYSA9IHoub2JqZWN0KG1pbGVzdG9uZUdlbmVyYXRlSWRQYXJhbXMpO1xuXG5jb25zdCBwbGFuVGFza1BhcmFtcyA9IHtcbiAgcHJvamVjdERpcjogcHJvamVjdERpclBhcmFtLFxuICBtaWxlc3RvbmVJZDogbm9uRW1wdHlTdHJpbmcoXCJtaWxlc3RvbmVJZFwiKS5kZXNjcmliZShcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKVwiKSxcbiAgc2xpY2VJZDogbm9uRW1wdHlTdHJpbmcoXCJzbGljZUlkXCIpLmRlc2NyaWJlKFwiU2xpY2UgSUQgKGUuZy4gUzAxKVwiKSxcbiAgdGFza0lkOiBub25FbXB0eVN0cmluZyhcInRhc2tJZFwiKS5kZXNjcmliZShcIlRhc2sgSUQgKGUuZy4gVDAxKVwiKSxcbiAgdGl0bGU6IG5vbkVtcHR5U3RyaW5nKFwidGl0bGVcIikuZGVzY3JpYmUoXCJUYXNrIHRpdGxlXCIpLFxuICBkZXNjcmlwdGlvbjogbm9uRW1wdHlTdHJpbmcoXCJkZXNjcmlwdGlvblwiKS5kZXNjcmliZShcIlRhc2sgZGVzY3JpcHRpb24gLyBzdGVwcyBibG9ja1wiKSxcbiAgZXN0aW1hdGU6IG5vbkVtcHR5U3RyaW5nKFwiZXN0aW1hdGVcIikuZGVzY3JpYmUoXCJUYXNrIGVzdGltYXRlXCIpLFxuICBmaWxlczogei5hcnJheSh6LnN0cmluZygpKS5kZXNjcmliZShcIkZpbGVzIGxpa2VseSB0b3VjaGVkXCIpLFxuICB2ZXJpZnk6IG5vbkVtcHR5U3RyaW5nKFwidmVyaWZ5XCIpLmRlc2NyaWJlKFwiVmVyaWZpY2F0aW9uIGNvbW1hbmQgb3IgYmxvY2tcIiksXG4gIGlucHV0czogei5hcnJheSh6LnN0cmluZygpKS5kZXNjcmliZShcIklucHV0IGZpbGVzIG9yIHJlZmVyZW5jZXNcIiksXG4gIGV4cGVjdGVkT3V0cHV0OiB6LmFycmF5KHouc3RyaW5nKCkpLmRlc2NyaWJlKFwiRXhwZWN0ZWQgb3V0cHV0IGZpbGVzIG9yIGFydGlmYWN0c1wiKSxcbiAgb2JzZXJ2YWJpbGl0eUltcGFjdDogb3B0aW9uYWxOb25FbXB0eVN0cmluZyhcIm9ic2VydmFiaWxpdHlJbXBhY3RcIikuZGVzY3JpYmUoXCJUYXNrIG9ic2VydmFiaWxpdHkgaW1wYWN0XCIpLFxufTtcbmNvbnN0IHBsYW5UYXNrU2NoZW1hID0gei5vYmplY3QocGxhblRhc2tQYXJhbXMpO1xuXG5jb25zdCBza2lwU2xpY2VQYXJhbXMgPSB7XG4gIHByb2plY3REaXI6IHByb2plY3REaXJQYXJhbSxcbiAgc2xpY2VJZDogei5zdHJpbmcoKS5kZXNjcmliZShcIlNsaWNlIElEIChlLmcuIFMwMilcIiksXG4gIG1pbGVzdG9uZUlkOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDMpXCIpLFxuICByZWFzb246IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIlJlYXNvbiBmb3Igc2tpcHBpbmcgdGhpcyBzbGljZVwiKSxcbn07XG5jb25zdCBza2lwU2xpY2VTY2hlbWEgPSB6Lm9iamVjdChza2lwU2xpY2VQYXJhbXMpO1xuXG5jb25zdCB0YXNrQ29tcGxldGVQYXJhbXMgPSB7XG4gIHByb2plY3REaXI6IHByb2plY3REaXJQYXJhbSxcbiAgdGFza0lkOiBub25FbXB0eVN0cmluZyhcInRhc2tJZFwiKS5kZXNjcmliZShcIlRhc2sgSUQgKGUuZy4gVDAxKVwiKSxcbiAgc2xpY2VJZDogbm9uRW1wdHlTdHJpbmcoXCJzbGljZUlkXCIpLmRlc2NyaWJlKFwiU2xpY2UgSUQgKGUuZy4gUzAxKVwiKSxcbiAgbWlsZXN0b25lSWQ6IG5vbkVtcHR5U3RyaW5nKFwibWlsZXN0b25lSWRcIikuZGVzY3JpYmUoXCJNaWxlc3RvbmUgSUQgKGUuZy4gTTAwMSlcIiksXG4gIG9uZUxpbmVyOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiT25lLWxpbmUgc3VtbWFyeSBvZiB3aGF0IHdhcyBhY2NvbXBsaXNoZWRcIiksXG4gIG5hcnJhdGl2ZTogei5zdHJpbmcoKS5kZXNjcmliZShcIkRldGFpbGVkIG5hcnJhdGl2ZSBvZiB3aGF0IGhhcHBlbmVkIGR1cmluZyB0aGUgdGFza1wiKSxcbiAgdmVyaWZpY2F0aW9uOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiV2hhdCB3YXMgdmVyaWZpZWQgYW5kIGhvd1wiKSxcbiAgZGV2aWF0aW9uczogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiRGV2aWF0aW9ucyBmcm9tIHRoZSB0YXNrIHBsYW5cIiksXG4gIGtub3duSXNzdWVzOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJLbm93biBpc3N1ZXMgZGlzY292ZXJlZCBidXQgbm90IGZpeGVkXCIpLFxuICBrZXlGaWxlczogei5hcnJheSh6LnN0cmluZygpKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiTGlzdCBvZiBrZXkgZmlsZXMgY3JlYXRlZCBvciBtb2RpZmllZFwiKSxcbiAga2V5RGVjaXNpb25zOiB6LmFycmF5KHouc3RyaW5nKCkpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJMaXN0IG9mIGtleSBkZWNpc2lvbnMgbWFkZSBkdXJpbmcgdGhpcyB0YXNrXCIpLFxuICBibG9ja2VyRGlzY292ZXJlZDogei5ib29sZWFuKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIldoZXRoZXIgYSBwbGFuLWludmFsaWRhdGluZyBibG9ja2VyIHdhcyBkaXNjb3ZlcmVkXCIpLFxuICAvLyBBRFItMDExIFBoYXNlIDI6IG1pZC1leGVjdXRpb24gZXNjYWxhdGlvbiBcdTIwMTQgYWdlbnQgYXNrcyB0aGUgdXNlciB0byByZXNvbHZlIGFuIGFtYmlndWl0eS5cbiAgZXNjYWxhdGlvbjogei5vYmplY3Qoe1xuICAgIHF1ZXN0aW9uOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiVGhlIHF1ZXN0aW9uIHRoZSB1c2VyIG5lZWRzIHRvIGFuc3dlciBcdTIwMTQgb25lIGNsZWFyIHNlbnRlbmNlLlwiKSxcbiAgICBvcHRpb25zOiB6LmFycmF5KHoub2JqZWN0KHtcbiAgICAgIGlkOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiU2hvcnQgaWQgKGUuZy4gJ0EnLCAnQicpIHVzZWQgYnkgL2dzZCBlc2NhbGF0ZSByZXNvbHZlLlwiKSxcbiAgICAgIGxhYmVsOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiT25lLWxpbmUgbGFiZWwuXCIpLFxuICAgICAgdHJhZGVvZmZzOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiMS0yIHNlbnRlbmNlcyBvbiB0aGUgdHJhZGVvZmZzIG9mIHRoaXMgb3B0aW9uLlwiKSxcbiAgICB9KSkubWluKDIpLm1heCg0KS5kZXNjcmliZShcIjItNCBvcHRpb25zIHRoZSB1c2VyIGNhbiBjaG9vc2UgYmV0d2Vlbi5cIiksXG4gICAgcmVjb21tZW5kYXRpb246IHouc3RyaW5nKCkuZGVzY3JpYmUoXCJPcHRpb24gaWQgdGhlIGV4ZWN1dG9yIHJlY29tbWVuZHMuXCIpLFxuICAgIHJlY29tbWVuZGF0aW9uUmF0aW9uYWxlOiB6LnN0cmluZygpLmRlc2NyaWJlKFwiV2h5IHRoZSByZWNvbW1lbmRhdGlvbiBcdTIwMTQgMS0yIHNlbnRlbmNlcy5cIiksXG4gICAgY29udGludWVXaXRoRGVmYXVsdDogei5ib29sZWFuKCkuZGVzY3JpYmUoXG4gICAgICBcIldoZW4gdHJ1ZSwgbG9vcCBjb250aW51ZXMgKGFydGlmYWN0IGxvZ2dlZCBmb3IgbGF0ZXIgcmV2aWV3KS4gV2hlbiBmYWxzZSwgYXV0by1tb2RlIHBhdXNlcyB1bnRpbCB0aGUgdXNlciByZXNvbHZlcyB2aWEgL2dzZCBlc2NhbGF0ZSByZXNvbHZlLlwiLFxuICAgICksXG4gIH0pLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJBRFItMDExIFBoYXNlIDI6IG9wdGlvbmFsIGVzY2FsYXRpb24gcGF5bG9hZC4gT25seSBob25vcmVkIHdoZW4gcGhhc2VzLm1pZF9leGVjdXRpb25fZXNjYWxhdGlvbiBpcyB0cnVlLlwiKSxcbiAgdmVyaWZpY2F0aW9uRXZpZGVuY2U6IHouYXJyYXkoei51bmlvbihbXG4gICAgei5vYmplY3Qoe1xuICAgICAgY29tbWFuZDogei5zdHJpbmcoKSxcbiAgICAgIGV4aXRDb2RlOiB6Lm51bWJlcigpLFxuICAgICAgdmVyZGljdDogei5zdHJpbmcoKSxcbiAgICAgIGR1cmF0aW9uTXM6IHoubnVtYmVyKCksXG4gICAgfSksXG4gICAgei5zdHJpbmcoKSxcbiAgXSkpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJWZXJpZmljYXRpb24gZXZpZGVuY2UgZW50cmllc1wiKSxcbn07XG5jb25zdCB0YXNrQ29tcGxldGVTY2hlbWEgPSB6Lm9iamVjdCh0YXNrQ29tcGxldGVQYXJhbXMpO1xuXG5jb25zdCB0YXNrUmVvcGVuUGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG4gIHRhc2tJZDogbm9uRW1wdHlTdHJpbmcoXCJ0YXNrSWRcIikuZGVzY3JpYmUoXCJUYXNrIElEIChlLmcuIFQwMSlcIiksXG4gIHNsaWNlSWQ6IG5vbkVtcHR5U3RyaW5nKFwic2xpY2VJZFwiKS5kZXNjcmliZShcIlNsaWNlIElEIChlLmcuIFMwMSlcIiksXG4gIG1pbGVzdG9uZUlkOiBub25FbXB0eVN0cmluZyhcIm1pbGVzdG9uZUlkXCIpLmRlc2NyaWJlKFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIpLFxuICByZWFzb246IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIldoeSB0aGUgdGFzayBpcyBiZWluZyByZW9wZW5lZFwiKSxcbiAgYWN0b3JOYW1lOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJDYWxsZXItcHJvdmlkZWQgYWN0b3IgaWRlbnRpdHkgZm9yIGF1ZGl0IHRyYWlsXCIpLFxuICB0cmlnZ2VyUmVhc29uOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJDYWxsZXItcHJvdmlkZWQgcmVhc29uIHRoaXMgYWN0aW9uIHdhcyB0cmlnZ2VyZWRcIiksXG59O1xuY29uc3QgdGFza1Jlb3BlblNjaGVtYSA9IHoub2JqZWN0KHRhc2tSZW9wZW5QYXJhbXMpO1xuXG5jb25zdCBzbGljZVJlb3BlblBhcmFtcyA9IHtcbiAgcHJvamVjdERpcjogcHJvamVjdERpclBhcmFtLFxuICBzbGljZUlkOiBub25FbXB0eVN0cmluZyhcInNsaWNlSWRcIikuZGVzY3JpYmUoXCJTbGljZSBJRCAoZS5nLiBTMDEpXCIpLFxuICBtaWxlc3RvbmVJZDogbm9uRW1wdHlTdHJpbmcoXCJtaWxlc3RvbmVJZFwiKS5kZXNjcmliZShcIk1pbGVzdG9uZSBJRCAoZS5nLiBNMDAxKVwiKSxcbiAgcmVhc29uOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJXaHkgdGhlIHNsaWNlIGlzIGJlaW5nIHJlb3BlbmVkXCIpLFxuICBhY3Rvck5hbWU6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIkNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSBmb3IgYXVkaXQgdHJhaWxcIiksXG4gIHRyaWdnZXJSZWFzb246IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIkNhbGxlci1wcm92aWRlZCByZWFzb24gdGhpcyBhY3Rpb24gd2FzIHRyaWdnZXJlZFwiKSxcbn07XG5jb25zdCBzbGljZVJlb3BlblNjaGVtYSA9IHoub2JqZWN0KHNsaWNlUmVvcGVuUGFyYW1zKTtcblxuY29uc3QgbWlsZXN0b25lUmVvcGVuUGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG4gIG1pbGVzdG9uZUlkOiBub25FbXB0eVN0cmluZyhcIm1pbGVzdG9uZUlkXCIpLmRlc2NyaWJlKFwiTWlsZXN0b25lIElEIChlLmcuIE0wMDEpXCIpLFxuICByZWFzb246IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIldoeSB0aGUgbWlsZXN0b25lIGlzIGJlaW5nIHJlb3BlbmVkXCIpLFxuICBhY3Rvck5hbWU6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIkNhbGxlci1wcm92aWRlZCBhY3RvciBpZGVudGl0eSBmb3IgYXVkaXQgdHJhaWxcIiksXG4gIHRyaWdnZXJSZWFzb246IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIkNhbGxlci1wcm92aWRlZCByZWFzb24gdGhpcyBhY3Rpb24gd2FzIHRyaWdnZXJlZFwiKSxcbn07XG5jb25zdCBtaWxlc3RvbmVSZW9wZW5TY2hlbWEgPSB6Lm9iamVjdChtaWxlc3RvbmVSZW9wZW5QYXJhbXMpO1xuXG5jb25zdCBtaWxlc3RvbmVTdGF0dXNQYXJhbXMgPSB7XG4gIHByb2plY3REaXI6IHByb2plY3REaXJQYXJhbSxcbiAgbWlsZXN0b25lSWQ6IHouc3RyaW5nKCkuZGVzY3JpYmUoXCJNaWxlc3RvbmUgSUQgdG8gcXVlcnkgKGUuZy4gTTAwMSlcIiksXG59O1xuY29uc3QgbWlsZXN0b25lU3RhdHVzU2NoZW1hID0gei5vYmplY3QobWlsZXN0b25lU3RhdHVzUGFyYW1zKTtcblxuY29uc3Qgam91cm5hbFF1ZXJ5UGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG4gIGZsb3dJZDogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiRmlsdGVyIGJ5IGZsb3cgSURcIiksXG4gIHVuaXRJZDogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiRmlsdGVyIGJ5IHVuaXQgSURcIiksXG4gIHJ1bGU6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIkZpbHRlciBieSBydWxlIG5hbWVcIiksXG4gIGV2ZW50VHlwZTogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiRmlsdGVyIGJ5IGV2ZW50IHR5cGVcIiksXG4gIGFmdGVyOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJJU08tODYwMSBsb3dlciBib3VuZCAoaW5jbHVzaXZlKVwiKSxcbiAgYmVmb3JlOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJJU08tODYwMSB1cHBlciBib3VuZCAoaW5jbHVzaXZlKVwiKSxcbiAgbGltaXQ6IHoubnVtYmVyKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIk1heGltdW0gZW50cmllcyB0byByZXR1cm5cIiksXG59O1xuY29uc3Qgam91cm5hbFF1ZXJ5U2NoZW1hID0gei5vYmplY3Qoam91cm5hbFF1ZXJ5UGFyYW1zKTtcblxuY29uc3QgZXhlY1J1bnRpbWVTY2hlbWEgPSB6LmVudW0oW1wiYmFzaFwiLCBcIm5vZGVcIiwgXCJweXRob25cIl0pO1xuY29uc3QgZXhlY1BhcmFtcyA9IHtcbiAgcHJvamVjdERpcjogcHJvamVjdERpclBhcmFtLFxuICBydW50aW1lOiBleGVjUnVudGltZVNjaGVtYS5kZXNjcmliZShcIkludGVycHJldGVyOiBiYXNoICgtYyksIG5vZGUgKC1lKSwgb3IgcHl0aG9uMyAoLWMpLlwiKSxcbiAgc2NyaXB0OiBub25FbXB0eVN0cmluZyhcInNjcmlwdFwiKS5kZXNjcmliZShcIlNjcmlwdCBib2R5LiBLZWVwIG91dHB1dCBzbWFsbDsgY2FwcGVkIHN0ZG91dC9zdGRlcnIgYXJlIHBlcnNpc3RlZCB1bmRlciAuZ3NkL2V4ZWMuXCIpLFxuICBwdXJwb3NlOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJTaG9ydCBsYWJlbCByZWNvcmRlZCBpbiBtZXRhLmpzb24gZm9yIGxhdGVyIHJldmlldy5cIiksXG4gIHRpbWVvdXRfbXM6IHoubnVtYmVyKCkuaW50KCkubWluKDFfMDAwKS5tYXgoNjAwXzAwMCkub3B0aW9uYWwoKS5kZXNjcmliZShcIlBlci1pbnZvY2F0aW9uIHRpbWVvdXQgaW4gbWlsbGlzZWNvbmRzLlwiKSxcbn07XG5jb25zdCBleGVjU2NoZW1hID0gei5vYmplY3QoZXhlY1BhcmFtcyk7XG5cbmNvbnN0IGV4ZWNTZWFyY2hQYXJhbXMgPSB7XG4gIHByb2plY3REaXI6IHByb2plY3REaXJQYXJhbSxcbiAgcXVlcnk6IHouc3RyaW5nKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIlN1YnN0cmluZyBtYXRjaGVkIGFnYWluc3QgaWQgYW5kIHB1cnBvc2UsIGNhc2UtaW5zZW5zaXRpdmUuXCIpLFxuICBydW50aW1lOiBleGVjUnVudGltZVNjaGVtYS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiUmVzdHJpY3QgdG8gb25lIHJ1bnRpbWUuXCIpLFxuICBmYWlsaW5nX29ubHk6IHouYm9vbGVhbigpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJPbmx5IG5vbi16ZXJvIGV4aXQgY29kZXMgYW5kIHRpbWVvdXRzLlwiKSxcbiAgbGltaXQ6IHoubnVtYmVyKCkuaW50KCkubWluKDEpLm1heCgyMDApLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJNYXggcmVzdWx0cyAoZGVmYXVsdCAyMCwgY2FwIDIwMCkuXCIpLFxufTtcbmNvbnN0IGV4ZWNTZWFyY2hTY2hlbWEgPSB6Lm9iamVjdChleGVjU2VhcmNoUGFyYW1zKTtcblxuY29uc3QgcmVzdW1lUGFyYW1zID0ge1xuICBwcm9qZWN0RGlyOiBwcm9qZWN0RGlyUGFyYW0sXG59O1xuY29uc3QgcmVzdW1lU2NoZW1hID0gei5vYmplY3QocmVzdW1lUGFyYW1zKTtcblxuLyoqXG4gKiBXcmFwIGEgcmVhbCBNY3BUb29sU2VydmVyIHNvIGV2ZXJ5IGhhbmRsZXIgd2UgcmVnaXN0ZXIgY2F0Y2hlcyB0aHJvd25cbiAqIGVycm9ycyBhbmQgcmV0dXJucyBhIHN0cnVjdHVyZWQgYHtpc0Vycm9yOiB0cnVlLCBjb250ZW50OiBbLi4uXX1gIE1DUFxuICogdG9vbCByZXN1bHQgaW5zdGVhZCBvZiBsZXR0aW5nIHRoZSBTREsgY29udmVydCB0aGUgdGhyb3cgaW50byBhXG4gKiBKU09OLVJQQyBlcnJvciBmcmFtZS4gU29tZSBNQ1AgaG9zdHMgKG5vdGFibHkgQ3Vyc29yKSBzdXJmYWNlIEpTT04tUlBDXG4gKiBlcnJvcnMgYXMgYSBnZW5lcmljIFwidG9vbCBmYWlsZWRcIiB3aXRoIG5vIG1lc3NhZ2UsIHdoaWNoIHN0cmlwcyB0aGVcbiAqIGFnZW50IG9mIHRoZSBjb250ZXh0IGl0IG5lZWRzIHRvIHJlY292ZXIgKHdyaXRlLWdhdGUgYmxvY2tzLCBzY2hlbWFcbiAqIG1pc21hdGNoZXMsIGRvd25zdHJlYW0gUlBDIGZhaWx1cmVzKS5cbiAqXG4gKiBSZWFkLW9ubHkgdG9vbHMgaW4gc2VydmVyLnRzIHVzZSB0aGUgc2FtZSBwYXR0ZXJuIHZpYSBwZXItaGFuZGxlclxuICogdHJ5L2NhdGNoICsgZXJyb3JDb250ZW50KCkuIFRoaXMgc2hpbSBhcHBsaWVzIGl0IHVuaWZvcm1seSB0byBldmVyeVxuICogbXV0YXRpb24gaGFuZGxlciBpbiB0aGlzIG1vZHVsZS5cbiAqL1xuZnVuY3Rpb24gd3JhcFNlcnZlcldpdGhFcnJvckhhbmRsZXIocmVhbFNlcnZlcjogTWNwVG9vbFNlcnZlcik6IE1jcFRvb2xTZXJ2ZXIge1xuICByZXR1cm4ge1xuICAgIHRvb2wobmFtZSwgZGVzY3JpcHRpb24sIHBhcmFtcywgaGFuZGxlcikge1xuICAgICAgcmV0dXJuIHJlYWxTZXJ2ZXIudG9vbChuYW1lLCBkZXNjcmlwdGlvbiwgcGFyYW1zLCBhc3luYyAoYXJncykgPT4ge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBhd2FpdCBoYW5kbGVyKGFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBpc0Vycm9yOiB0cnVlIGFzIGNvbnN0LFxuICAgICAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IG1lc3NhZ2UgfV0sXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyV29ya2Zsb3dUb29scyhyZWFsU2VydmVyOiBNY3BUb29sU2VydmVyKTogdm9pZCB7XG4gIGNvbnN0IHNlcnZlciA9IHdyYXBTZXJ2ZXJXaXRoRXJyb3JIYW5kbGVyKHJlYWxTZXJ2ZXIpO1xuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9kZWNpc2lvbl9zYXZlXCIsXG4gICAgXCJSZWNvcmQgYSBwcm9qZWN0IGRlY2lzaW9uIHRvIHRoZSBHU0QgZGF0YWJhc2UgYW5kIHJlZ2VuZXJhdGUgREVDSVNJT05TLm1kLlwiLFxuICAgIGRlY2lzaW9uU2F2ZVBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKGRlY2lzaW9uU2F2ZVNjaGVtYSwgYXJncyk7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIC4uLnBhcmFtcyB9ID0gcGFyc2VkO1xuICAgICAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX2RlY2lzaW9uX3NhdmVcIiwgcHJvamVjdERpcik7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5TZXJpYWxpemVkV29ya2Zsb3dEYk9wZXJhdGlvbihwcm9qZWN0RGlyLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgc2F2ZURlY2lzaW9uVG9EYiB9ID0gYXdhaXQgaW1wb3J0TG9jYWxNb2R1bGU8YW55PihcIi4uLy4uLy4uL3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZGItd3JpdGVyLmpzXCIpO1xuICAgICAgICByZXR1cm4gc2F2ZURlY2lzaW9uVG9EYihwYXJhbXMsIHByb2plY3REaXIpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4geyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYFNhdmVkIGRlY2lzaW9uICR7cmVzdWx0LmlkfWAgfV0gfTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3NhdmVfZGVjaXNpb25cIixcbiAgICBcIkFsaWFzIGZvciBnc2RfZGVjaXNpb25fc2F2ZS4gUmVjb3JkIGEgcHJvamVjdCBkZWNpc2lvbiB0byB0aGUgR1NEIGRhdGFiYXNlIGFuZCByZWdlbmVyYXRlIERFQ0lTSU9OUy5tZC5cIixcbiAgICBkZWNpc2lvblNhdmVQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBsb2dBbGlhc1VzYWdlKFwiZ3NkX3NhdmVfZGVjaXNpb25cIiwgXCJnc2RfZGVjaXNpb25fc2F2ZVwiKTtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKGRlY2lzaW9uU2F2ZVNjaGVtYSwgYXJncyk7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIC4uLnBhcmFtcyB9ID0gcGFyc2VkO1xuICAgICAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX2RlY2lzaW9uX3NhdmVcIiwgcHJvamVjdERpcik7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5TZXJpYWxpemVkV29ya2Zsb3dEYk9wZXJhdGlvbihwcm9qZWN0RGlyLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgc2F2ZURlY2lzaW9uVG9EYiB9ID0gYXdhaXQgaW1wb3J0TG9jYWxNb2R1bGU8YW55PihcIi4uLy4uLy4uL3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZGItd3JpdGVyLmpzXCIpO1xuICAgICAgICByZXR1cm4gc2F2ZURlY2lzaW9uVG9EYihwYXJhbXMsIHByb2plY3REaXIpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4geyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYFNhdmVkIGRlY2lzaW9uICR7cmVzdWx0LmlkfWAgfV0gfTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZVwiLFxuICAgIFwiVXBkYXRlIGFuIGV4aXN0aW5nIHJlcXVpcmVtZW50IGluIHRoZSBHU0QgZGF0YWJhc2UgYW5kIHJlZ2VuZXJhdGUgUkVRVUlSRU1FTlRTLm1kLlwiLFxuICAgIHJlcXVpcmVtZW50VXBkYXRlUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VXb3JrZmxvd0FyZ3MocmVxdWlyZW1lbnRVcGRhdGVTY2hlbWEsIGFyZ3MpO1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCBpZCwgLi4udXBkYXRlcyB9ID0gcGFyc2VkO1xuICAgICAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZVwiLCBwcm9qZWN0RGlyKTtcbiAgICAgIGF3YWl0IHJ1blNlcmlhbGl6ZWRXb3JrZmxvd0RiT3BlcmF0aW9uKHByb2plY3REaXIsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgeyB1cGRhdGVSZXF1aXJlbWVudEluRGIgfSA9IGF3YWl0IGltcG9ydExvY2FsTW9kdWxlPGFueT4oXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RiLXdyaXRlci5qc1wiKTtcbiAgICAgICAgcmV0dXJuIHVwZGF0ZVJlcXVpcmVtZW50SW5EYihpZCwgdXBkYXRlcywgcHJvamVjdERpcik7XG4gICAgICB9KTtcbiAgICAgIHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgVXBkYXRlZCByZXF1aXJlbWVudCAke2lkfWAgfV0gfTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3VwZGF0ZV9yZXF1aXJlbWVudFwiLFxuICAgIFwiQWxpYXMgZm9yIGdzZF9yZXF1aXJlbWVudF91cGRhdGUuIFVwZGF0ZSBhbiBleGlzdGluZyByZXF1aXJlbWVudCBpbiB0aGUgR1NEIGRhdGFiYXNlIGFuZCByZWdlbmVyYXRlIFJFUVVJUkVNRU5UUy5tZC5cIixcbiAgICByZXF1aXJlbWVudFVwZGF0ZVBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGxvZ0FsaWFzVXNhZ2UoXCJnc2RfdXBkYXRlX3JlcXVpcmVtZW50XCIsIFwiZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZVwiKTtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHJlcXVpcmVtZW50VXBkYXRlU2NoZW1hLCBhcmdzKTtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgaWQsIC4uLnVwZGF0ZXMgfSA9IHBhcnNlZDtcbiAgICAgIGF3YWl0IGVuZm9yY2VXb3JrZmxvd1dyaXRlR2F0ZShcImdzZF9yZXF1aXJlbWVudF91cGRhdGVcIiwgcHJvamVjdERpcik7XG4gICAgICBhd2FpdCBydW5TZXJpYWxpemVkV29ya2Zsb3dEYk9wZXJhdGlvbihwcm9qZWN0RGlyLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgdXBkYXRlUmVxdWlyZW1lbnRJbkRiIH0gPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxhbnk+KFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kYi13cml0ZXIuanNcIik7XG4gICAgICAgIHJldHVybiB1cGRhdGVSZXF1aXJlbWVudEluRGIoaWQsIHVwZGF0ZXMsIHByb2plY3REaXIpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4geyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogYFVwZGF0ZWQgcmVxdWlyZW1lbnQgJHtpZH1gIH1dIH07XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9yZXF1aXJlbWVudF9zYXZlXCIsXG4gICAgXCJSZWNvcmQgYSBuZXcgcmVxdWlyZW1lbnQgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVnZW5lcmF0ZSBSRVFVSVJFTUVOVFMubWQuXCIsXG4gICAgcmVxdWlyZW1lbnRTYXZlUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VXb3JrZmxvd0FyZ3MocmVxdWlyZW1lbnRTYXZlU2NoZW1hLCBhcmdzKTtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgLi4ucGFyYW1zIH0gPSBwYXJzZWQ7XG4gICAgICBhd2FpdCBlbmZvcmNlV29ya2Zsb3dXcml0ZUdhdGUoXCJnc2RfcmVxdWlyZW1lbnRfc2F2ZVwiLCBwcm9qZWN0RGlyKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blNlcmlhbGl6ZWRXb3JrZmxvd0RiT3BlcmF0aW9uKHByb2plY3REaXIsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgeyBzYXZlUmVxdWlyZW1lbnRUb0RiIH0gPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxhbnk+KFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kYi13cml0ZXIuanNcIik7XG4gICAgICAgIHJldHVybiBzYXZlUmVxdWlyZW1lbnRUb0RiKHBhcmFtcywgcHJvamVjdERpcik7XG4gICAgICB9KTtcbiAgICAgIHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgU2F2ZWQgcmVxdWlyZW1lbnQgJHtyZXN1bHQuaWR9YCB9XSB9O1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2Rfc2F2ZV9yZXF1aXJlbWVudFwiLFxuICAgIFwiQWxpYXMgZm9yIGdzZF9yZXF1aXJlbWVudF9zYXZlLiBSZWNvcmQgYSBuZXcgcmVxdWlyZW1lbnQgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVnZW5lcmF0ZSBSRVFVSVJFTUVOVFMubWQuXCIsXG4gICAgcmVxdWlyZW1lbnRTYXZlUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgbG9nQWxpYXNVc2FnZShcImdzZF9zYXZlX3JlcXVpcmVtZW50XCIsIFwiZ3NkX3JlcXVpcmVtZW50X3NhdmVcIik7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVdvcmtmbG93QXJncyhyZXF1aXJlbWVudFNhdmVTY2hlbWEsIGFyZ3MpO1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCAuLi5wYXJhbXMgfSA9IHBhcnNlZDtcbiAgICAgIGF3YWl0IGVuZm9yY2VXb3JrZmxvd1dyaXRlR2F0ZShcImdzZF9yZXF1aXJlbWVudF9zYXZlXCIsIHByb2plY3REaXIpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93RGJPcGVyYXRpb24ocHJvamVjdERpciwgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB7IHNhdmVSZXF1aXJlbWVudFRvRGIgfSA9IGF3YWl0IGltcG9ydExvY2FsTW9kdWxlPGFueT4oXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RiLXdyaXRlci5qc1wiKTtcbiAgICAgICAgcmV0dXJuIHNhdmVSZXF1aXJlbWVudFRvRGIocGFyYW1zLCBwcm9qZWN0RGlyKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGBTYXZlZCByZXF1aXJlbWVudCAke3Jlc3VsdC5pZH1gIH1dIH07XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9taWxlc3RvbmVfZ2VuZXJhdGVfaWRcIixcbiAgICBcIkdlbmVyYXRlIHRoZSBuZXh0IG1pbGVzdG9uZSBJRCBmb3IgYSBuZXcgR1NEIG1pbGVzdG9uZS5cIixcbiAgICBtaWxlc3RvbmVHZW5lcmF0ZUlkUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyIH0gPSBwYXJzZVdvcmtmbG93QXJncyhtaWxlc3RvbmVHZW5lcmF0ZUlkU2NoZW1hLCBhcmdzKTtcbiAgICAgIGF3YWl0IGVuZm9yY2VXb3JrZmxvd1dyaXRlR2F0ZShcImdzZF9taWxlc3RvbmVfZ2VuZXJhdGVfaWRcIiwgcHJvamVjdERpcik7XG4gICAgICBjb25zdCBpZCA9IGF3YWl0IHJ1blNlcmlhbGl6ZWRXb3JrZmxvd0RiT3BlcmF0aW9uKHByb2plY3REaXIsICgpID0+XG4gICAgICAgIGdlbmVyYXRlT3JSZXVzZU1pbGVzdG9uZUlkKHByb2plY3REaXIpLFxuICAgICAgKTtcbiAgICAgIHJldHVybiB7IGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBpZCB9XSB9O1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2RfZ2VuZXJhdGVfbWlsZXN0b25lX2lkXCIsXG4gICAgXCJBbGlhcyBmb3IgZ3NkX21pbGVzdG9uZV9nZW5lcmF0ZV9pZC4gR2VuZXJhdGUgdGhlIG5leHQgbWlsZXN0b25lIElEIGZvciBhIG5ldyBHU0QgbWlsZXN0b25lLlwiLFxuICAgIG1pbGVzdG9uZUdlbmVyYXRlSWRQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBsb2dBbGlhc1VzYWdlKFwiZ3NkX2dlbmVyYXRlX21pbGVzdG9uZV9pZFwiLCBcImdzZF9taWxlc3RvbmVfZ2VuZXJhdGVfaWRcIik7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIgfSA9IHBhcnNlV29ya2Zsb3dBcmdzKG1pbGVzdG9uZUdlbmVyYXRlSWRTY2hlbWEsIGFyZ3MpO1xuICAgICAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX21pbGVzdG9uZV9nZW5lcmF0ZV9pZFwiLCBwcm9qZWN0RGlyKTtcbiAgICAgIGNvbnN0IGlkID0gYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93RGJPcGVyYXRpb24ocHJvamVjdERpciwgKCkgPT5cbiAgICAgICAgZ2VuZXJhdGVPclJldXNlTWlsZXN0b25lSWQocHJvamVjdERpciksXG4gICAgICApO1xuICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IGlkIH1dIH07XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9wbGFuX21pbGVzdG9uZVwiLFxuICAgIFwiV3JpdGUgbWlsZXN0b25lIHBsYW5uaW5nIHN0YXRlIHRvIHRoZSBHU0QgZGF0YWJhc2UgYW5kIHJlbmRlciBST0FETUFQLm1kIGZyb20gREIuXCIsXG4gICAgcGxhbk1pbGVzdG9uZVBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHBsYW5NaWxlc3RvbmVTY2hlbWEsIGFyZ3MpO1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCAuLi5wYXJhbXMgfSA9IHBhcnNlZDtcbiAgICAgIGF3YWl0IGVuZm9yY2VXb3JrZmxvd1dyaXRlR2F0ZShcImdzZF9wbGFuX21pbGVzdG9uZVwiLCBwcm9qZWN0RGlyLCBwYXJhbXMubWlsZXN0b25lSWQpO1xuICAgICAgY29uc3QgeyBleGVjdXRlUGxhbk1pbGVzdG9uZSB9ID0gYXdhaXQgZ2V0V29ya2Zsb3dUb29sRXhlY3V0b3JzKCk7XG4gICAgICByZXR1cm4gYWRhcHRFeGVjdXRvclJlc3VsdChcbiAgICAgICAgYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93T3BlcmF0aW9uKCgpID0+IGV4ZWN1dGVQbGFuTWlsZXN0b25lKHBhcmFtcywgcHJvamVjdERpcikpLFxuICAgICAgKTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3BsYW5fc2xpY2VcIixcbiAgICBcIldyaXRlIHNsaWNlL3Rhc2sgcGxhbm5pbmcgc3RhdGUgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVuZGVyIHBsYW4gYXJ0aWZhY3RzIGZyb20gREIuXCIsXG4gICAgcGxhblNsaWNlUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VXb3JrZmxvd0FyZ3MocGxhblNsaWNlU2NoZW1hLCBhcmdzKTtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgLi4ucGFyYW1zIH0gPSBwYXJzZWQ7XG4gICAgICBhd2FpdCBlbmZvcmNlV29ya2Zsb3dXcml0ZUdhdGUoXCJnc2RfcGxhbl9zbGljZVwiLCBwcm9qZWN0RGlyLCBwYXJhbXMubWlsZXN0b25lSWQpO1xuICAgICAgY29uc3QgeyBleGVjdXRlUGxhblNsaWNlIH0gPSBhd2FpdCBnZXRXb3JrZmxvd1Rvb2xFeGVjdXRvcnMoKTtcbiAgICAgIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgICAgICBhd2FpdCBydW5TZXJpYWxpemVkV29ya2Zsb3dPcGVyYXRpb24oKCkgPT4gZXhlY3V0ZVBsYW5TbGljZShwYXJhbXMsIHByb2plY3REaXIpKSxcbiAgICAgICk7XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9wbGFuX3Rhc2tcIixcbiAgICBcIldyaXRlIHRhc2sgcGxhbm5pbmcgc3RhdGUgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVuZGVyIHRhc2tzL1QjIy1QTEFOLm1kIGZyb20gREIuXCIsXG4gICAgcGxhblRhc2tQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVdvcmtmbG93QXJncyhwbGFuVGFza1NjaGVtYSwgYXJncyk7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIC4uLnBhcmFtcyB9ID0gcGFyc2VkO1xuICAgICAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX3BsYW5fdGFza1wiLCBwcm9qZWN0RGlyLCBwYXJhbXMubWlsZXN0b25lSWQpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93RGJPcGVyYXRpb24ocHJvamVjdERpciwgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB7IGhhbmRsZVBsYW5UYXNrIH0gPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxhbnk+KFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9wbGFuLXRhc2suanNcIik7XG4gICAgICAgIHJldHVybiBoYW5kbGVQbGFuVGFzayhwYXJhbXMsIHByb2plY3REaXIpO1xuICAgICAgfSk7XG4gICAgICBpZiAoXCJlcnJvclwiIGluIHJlc3VsdCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IocmVzdWx0LmVycm9yKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgUGxhbm5lZCB0YXNrICR7cmVzdWx0LnRhc2tJZH0gKCR7cmVzdWx0LnNsaWNlSWR9LyR7cmVzdWx0Lm1pbGVzdG9uZUlkfSlgIH1dLFxuICAgICAgfTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3Rhc2tfcGxhblwiLFxuICAgIFwiQWxpYXMgZm9yIGdzZF9wbGFuX3Rhc2suIFdyaXRlIHRhc2sgcGxhbm5pbmcgc3RhdGUgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVuZGVyIHRhc2tzL1QjIy1QTEFOLm1kIGZyb20gREIuXCIsXG4gICAgcGxhblRhc2tQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBsb2dBbGlhc1VzYWdlKFwiZ3NkX3Rhc2tfcGxhblwiLCBcImdzZF9wbGFuX3Rhc2tcIik7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVdvcmtmbG93QXJncyhwbGFuVGFza1NjaGVtYSwgYXJncyk7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIC4uLnBhcmFtcyB9ID0gcGFyc2VkO1xuICAgICAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX3BsYW5fdGFza1wiLCBwcm9qZWN0RGlyLCBwYXJhbXMubWlsZXN0b25lSWQpO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93RGJPcGVyYXRpb24ocHJvamVjdERpciwgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB7IGhhbmRsZVBsYW5UYXNrIH0gPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxhbnk+KFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9wbGFuLXRhc2suanNcIik7XG4gICAgICAgIHJldHVybiBoYW5kbGVQbGFuVGFzayhwYXJhbXMsIHByb2plY3REaXIpO1xuICAgICAgfSk7XG4gICAgICBpZiAoXCJlcnJvclwiIGluIHJlc3VsdCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IocmVzdWx0LmVycm9yKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgUGxhbm5lZCB0YXNrICR7cmVzdWx0LnRhc2tJZH0gKCR7cmVzdWx0LnNsaWNlSWR9LyR7cmVzdWx0Lm1pbGVzdG9uZUlkfSlgIH1dLFxuICAgICAgfTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3JlcGxhbl9zbGljZVwiLFxuICAgIFwiUmVwbGFuIGEgc2xpY2UgYWZ0ZXIgYSBibG9ja2VyIGlzIGRpc2NvdmVyZWQsIHByZXNlcnZpbmcgY29tcGxldGVkIHRhc2tzIGFuZCByZS1yZW5kZXJpbmcgUExBTi5tZCArIFJFUExBTi5tZC5cIixcbiAgICByZXBsYW5TbGljZVBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHJlcGxhblNsaWNlU2NoZW1hLCBhcmdzKTtcbiAgICAgIHJldHVybiBoYW5kbGVSZXBsYW5TbGljZShwYXJzZWQucHJvamVjdERpciwgcGFyc2VkKTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3NsaWNlX3JlcGxhblwiLFxuICAgIFwiQWxpYXMgZm9yIGdzZF9yZXBsYW5fc2xpY2UuIFJlcGxhbiBhIHNsaWNlIGFmdGVyIGEgYmxvY2tlciBpcyBkaXNjb3ZlcmVkLlwiLFxuICAgIHJlcGxhblNsaWNlUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgbG9nQWxpYXNVc2FnZShcImdzZF9zbGljZV9yZXBsYW5cIiwgXCJnc2RfcmVwbGFuX3NsaWNlXCIpO1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VXb3JrZmxvd0FyZ3MocmVwbGFuU2xpY2VTY2hlbWEsIGFyZ3MpO1xuICAgICAgcmV0dXJuIGhhbmRsZVJlcGxhblNsaWNlKHBhcnNlZC5wcm9qZWN0RGlyLCBwYXJzZWQpO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2Rfc2xpY2VfY29tcGxldGVcIixcbiAgICBcIlJlY29yZCBhIGNvbXBsZXRlZCBzbGljZSB0byB0aGUgR1NEIGRhdGFiYXNlLCByZW5kZXIgU1VNTUFSWS5tZCArIFVBVC5tZCwgYW5kIHVwZGF0ZSByb2FkbWFwIHByb2plY3Rpb24uXCIsXG4gICAgc2xpY2VDb21wbGV0ZVBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHNsaWNlQ29tcGxldGVTY2hlbWEsIGFyZ3MpO1xuICAgICAgcmV0dXJuIGhhbmRsZVNsaWNlQ29tcGxldGUocGFyc2VkLnByb2plY3REaXIsIHBhcnNlZCk7XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9jb21wbGV0ZV9zbGljZVwiLFxuICAgIFwiQWxpYXMgZm9yIGdzZF9zbGljZV9jb21wbGV0ZS4gUmVjb3JkIGEgY29tcGxldGVkIHNsaWNlIHRvIHRoZSBHU0QgZGF0YWJhc2UgYW5kIHJlbmRlciBzdW1tYXJ5L1VBVCBhcnRpZmFjdHMuXCIsXG4gICAgc2xpY2VDb21wbGV0ZVBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGxvZ0FsaWFzVXNhZ2UoXCJnc2RfY29tcGxldGVfc2xpY2VcIiwgXCJnc2Rfc2xpY2VfY29tcGxldGVcIik7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVdvcmtmbG93QXJncyhzbGljZUNvbXBsZXRlU2NoZW1hLCBhcmdzKTtcbiAgICAgIHJldHVybiBoYW5kbGVTbGljZUNvbXBsZXRlKHBhcnNlZC5wcm9qZWN0RGlyLCBwYXJzZWQpO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2Rfc2tpcF9zbGljZVwiLFxuICAgIFwiTWFyayBhIHNsaWNlIGFzIHNraXBwZWQgc28gYXV0by1tb2RlIGFkdmFuY2VzIHBhc3QgaXQgd2l0aG91dCBleGVjdXRpbmcuXCIsXG4gICAgc2tpcFNsaWNlUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgcmVhc29uIH0gPSBwYXJzZVdvcmtmbG93QXJncyhza2lwU2xpY2VTY2hlbWEsIGFyZ3MpO1xuICAgICAgYXdhaXQgZW5mb3JjZVdvcmtmbG93V3JpdGVHYXRlKFwiZ3NkX3NraXBfc2xpY2VcIiwgcHJvamVjdERpciwgbWlsZXN0b25lSWQpO1xuICAgICAgYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93RGJPcGVyYXRpb24ocHJvamVjdERpciwgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB7IGdldFNsaWNlLCB1cGRhdGVTbGljZVN0YXR1cyB9ID0gYXdhaXQgaW1wb3J0TG9jYWxNb2R1bGU8YW55PihcIi4uLy4uLy4uL3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvZ3NkLWRiLmpzXCIpO1xuICAgICAgICBjb25zdCB7IGludmFsaWRhdGVTdGF0ZUNhY2hlIH0gPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxhbnk+KFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zdGF0ZS5qc1wiKTtcbiAgICAgICAgY29uc3QgeyByZWJ1aWxkU3RhdGUgfSA9IGF3YWl0IGltcG9ydExvY2FsTW9kdWxlPGFueT4oXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2RvY3Rvci5qc1wiKTtcbiAgICAgICAgY29uc3Qgc2xpY2UgPSBnZXRTbGljZShtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gICAgICAgIGlmICghc2xpY2UpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFNsaWNlICR7c2xpY2VJZH0gbm90IGZvdW5kIGluIG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfWApO1xuICAgICAgICB9XG4gICAgICAgIGlmIChzbGljZS5zdGF0dXMgPT09IFwiY29tcGxldGVcIiB8fCBzbGljZS5zdGF0dXMgPT09IFwiZG9uZVwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBTbGljZSAke3NsaWNlSWR9IGlzIGFscmVhZHkgY29tcGxldGUgYW5kIGNhbm5vdCBiZSBza2lwcGVkYCk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNsaWNlLnN0YXR1cyAhPT0gXCJza2lwcGVkXCIpIHtcbiAgICAgICAgICB1cGRhdGVTbGljZVN0YXR1cyhtaWxlc3RvbmVJZCwgc2xpY2VJZCwgXCJza2lwcGVkXCIpO1xuICAgICAgICAgIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk7XG4gICAgICAgICAgYXdhaXQgcmVidWlsZFN0YXRlKHByb2plY3REaXIpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiIGFzIGNvbnN0LCB0ZXh0OiBgU2tpcHBlZCBzbGljZSAke3NsaWNlSWR9ICgke21pbGVzdG9uZUlkfSkuIFJlYXNvbjogJHtyZWFzb24gPz8gXCJVc2VyLWRpcmVjdGVkIHNraXBcIn0uYCB9XSxcbiAgICAgIH07XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9jb21wbGV0ZV9taWxlc3RvbmVcIixcbiAgICBcIlJlY29yZCBhIGNvbXBsZXRlZCBtaWxlc3RvbmUgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVuZGVyIGl0cyBTVU1NQVJZLm1kLlwiLFxuICAgIGNvbXBsZXRlTWlsZXN0b25lUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VXb3JrZmxvd0FyZ3MoY29tcGxldGVNaWxlc3RvbmVTY2hlbWEsIGFyZ3MpO1xuICAgICAgcmV0dXJuIGhhbmRsZUNvbXBsZXRlTWlsZXN0b25lKHBhcnNlZC5wcm9qZWN0RGlyLCBwYXJzZWQpO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2RfbWlsZXN0b25lX2NvbXBsZXRlXCIsXG4gICAgXCJBbGlhcyBmb3IgZ3NkX2NvbXBsZXRlX21pbGVzdG9uZS4gUmVjb3JkIGEgY29tcGxldGVkIG1pbGVzdG9uZSB0byB0aGUgR1NEIGRhdGFiYXNlIGFuZCByZW5kZXIgaXRzIFNVTU1BUlkubWQuXCIsXG4gICAgY29tcGxldGVNaWxlc3RvbmVQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBsb2dBbGlhc1VzYWdlKFwiZ3NkX21pbGVzdG9uZV9jb21wbGV0ZVwiLCBcImdzZF9jb21wbGV0ZV9taWxlc3RvbmVcIik7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVdvcmtmbG93QXJncyhjb21wbGV0ZU1pbGVzdG9uZVNjaGVtYSwgYXJncyk7XG4gICAgICByZXR1cm4gaGFuZGxlQ29tcGxldGVNaWxlc3RvbmUocGFyc2VkLnByb2plY3REaXIsIHBhcnNlZCk7XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF92YWxpZGF0ZV9taWxlc3RvbmVcIixcbiAgICBcIlZhbGlkYXRlIGEgbWlsZXN0b25lLCBwZXJzaXN0IHZhbGlkYXRpb24gcmVzdWx0cyB0byB0aGUgR1NEIGRhdGFiYXNlLCBhbmQgcmVuZGVyIFZBTElEQVRJT04ubWQuXCIsXG4gICAgdmFsaWRhdGVNaWxlc3RvbmVQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVdvcmtmbG93QXJncyh2YWxpZGF0ZU1pbGVzdG9uZVNjaGVtYSwgYXJncyk7XG4gICAgICByZXR1cm4gaGFuZGxlVmFsaWRhdGVNaWxlc3RvbmUocGFyc2VkLnByb2plY3REaXIsIHBhcnNlZCk7XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9taWxlc3RvbmVfdmFsaWRhdGVcIixcbiAgICBcIkFsaWFzIGZvciBnc2RfdmFsaWRhdGVfbWlsZXN0b25lLiBWYWxpZGF0ZSBhIG1pbGVzdG9uZSBhbmQgcmVuZGVyIFZBTElEQVRJT04ubWQuXCIsXG4gICAgdmFsaWRhdGVNaWxlc3RvbmVQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBsb2dBbGlhc1VzYWdlKFwiZ3NkX21pbGVzdG9uZV92YWxpZGF0ZVwiLCBcImdzZF92YWxpZGF0ZV9taWxlc3RvbmVcIik7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVdvcmtmbG93QXJncyh2YWxpZGF0ZU1pbGVzdG9uZVNjaGVtYSwgYXJncyk7XG4gICAgICByZXR1cm4gaGFuZGxlVmFsaWRhdGVNaWxlc3RvbmUocGFyc2VkLnByb2plY3REaXIsIHBhcnNlZCk7XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9yZWFzc2Vzc19yb2FkbWFwXCIsXG4gICAgXCJSZWFzc2VzcyBhIG1pbGVzdG9uZSByb2FkbWFwIGFmdGVyIGEgc2xpY2UgY29tcGxldGVzLCB3cml0aW5nIEFTU0VTU01FTlQubWQgYW5kIHJlLXJlbmRlcmluZyBST0FETUFQLm1kLlwiLFxuICAgIHJlYXNzZXNzUm9hZG1hcFBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHJlYXNzZXNzUm9hZG1hcFNjaGVtYSwgYXJncyk7XG4gICAgICByZXR1cm4gaGFuZGxlUmVhc3Nlc3NSb2FkbWFwKHBhcnNlZC5wcm9qZWN0RGlyLCBwYXJzZWQpO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2Rfcm9hZG1hcF9yZWFzc2Vzc1wiLFxuICAgIFwiQWxpYXMgZm9yIGdzZF9yZWFzc2Vzc19yb2FkbWFwLiBSZWFzc2VzcyBhIHJvYWRtYXAgYWZ0ZXIgc2xpY2UgY29tcGxldGlvbi5cIixcbiAgICByZWFzc2Vzc1JvYWRtYXBQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBsb2dBbGlhc1VzYWdlKFwiZ3NkX3JvYWRtYXBfcmVhc3Nlc3NcIiwgXCJnc2RfcmVhc3Nlc3Nfcm9hZG1hcFwiKTtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHJlYXNzZXNzUm9hZG1hcFNjaGVtYSwgYXJncyk7XG4gICAgICByZXR1cm4gaGFuZGxlUmVhc3Nlc3NSb2FkbWFwKHBhcnNlZC5wcm9qZWN0RGlyLCBwYXJzZWQpO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2Rfc2F2ZV9nYXRlX3Jlc3VsdFwiLFxuICAgIFwiU2F2ZSBhIHF1YWxpdHkgZ2F0ZSByZXN1bHQgdG8gdGhlIEdTRCBkYXRhYmFzZS5cIixcbiAgICBzYXZlR2F0ZVJlc3VsdFBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHNhdmVHYXRlUmVzdWx0U2NoZW1hLCBhcmdzKTtcbiAgICAgIHJldHVybiBoYW5kbGVTYXZlR2F0ZVJlc3VsdChwYXJzZWQucHJvamVjdERpciwgcGFyc2VkKTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3N1bW1hcnlfc2F2ZVwiLFxuICAgIFwiU2F2ZSBhIEdTRCBzdW1tYXJ5L3Jlc2VhcmNoL2NvbnRleHQvYXNzZXNzbWVudCBhcnRpZmFjdCB0byB0aGUgZGF0YWJhc2UgYW5kIGRpc2suIE9taXQgbWlsZXN0b25lX2lkIG9ubHkgZm9yIHJvb3QtbGV2ZWwgUFJPSkVDVC9QUk9KRUNULURSQUZUL1JFUVVJUkVNRU5UUy9SRVFVSVJFTUVOVFMtRFJBRlQgYXJ0aWZhY3RzLlwiLFxuICAgIHN1bW1hcnlTYXZlUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VXb3JrZmxvd0FyZ3Moc3VtbWFyeVNhdmVTY2hlbWEsIGFyZ3MpO1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCBtaWxlc3RvbmVfaWQsIHNsaWNlX2lkLCB0YXNrX2lkLCBhcnRpZmFjdF90eXBlLCBjb250ZW50IH0gPSBwYXJzZWQ7XG4gICAgICBhd2FpdCBlbmZvcmNlV29ya2Zsb3dXcml0ZUdhdGUoXCJnc2Rfc3VtbWFyeV9zYXZlXCIsIHByb2plY3REaXIsIG1pbGVzdG9uZV9pZCA/PyBudWxsKTtcbiAgICAgIGNvbnN0IGV4ZWN1dG9ycyA9IGF3YWl0IGdldFdvcmtmbG93VG9vbEV4ZWN1dG9ycygpO1xuICAgICAgY29uc3Qgc3VwcG9ydGVkQXJ0aWZhY3RUeXBlcyA9IGdldFN1cHBvcnRlZFN1bW1hcnlBcnRpZmFjdFR5cGVzKGV4ZWN1dG9ycyk7XG4gICAgICBpZiAoIXN1cHBvcnRlZEFydGlmYWN0VHlwZXMuaW5jbHVkZXMoYXJ0aWZhY3RfdHlwZSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBhcnRpZmFjdF90eXBlIG11c3QgYmUgb25lIG9mOiAke3N1cHBvcnRlZEFydGlmYWN0VHlwZXMuam9pbihcIiwgXCIpfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gYWRhcHRFeGVjdXRvclJlc3VsdChcbiAgICAgICAgYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93T3BlcmF0aW9uKCgpID0+XG4gICAgICAgICAgZXhlY3V0b3JzLmV4ZWN1dGVTdW1tYXJ5U2F2ZSh7IG1pbGVzdG9uZV9pZCwgc2xpY2VfaWQsIHRhc2tfaWQsIGFydGlmYWN0X3R5cGUsIGNvbnRlbnQgfSwgcHJvamVjdERpciksXG4gICAgICAgICksXG4gICAgICApO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2RfdGFza19jb21wbGV0ZVwiLFxuICAgIFwiUmVjb3JkIGEgY29tcGxldGVkIHRhc2sgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVuZGVyIGl0cyBTVU1NQVJZLm1kLlwiLFxuICAgIHRhc2tDb21wbGV0ZVBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHRhc2tDb21wbGV0ZVNjaGVtYSwgYXJncyk7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIC4uLnRhc2tBcmdzIH0gPSBwYXJzZWQ7XG4gICAgICByZXR1cm4gaGFuZGxlVGFza0NvbXBsZXRlKHByb2plY3REaXIsIHRhc2tBcmdzKTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX2NvbXBsZXRlX3Rhc2tcIixcbiAgICBcIkFsaWFzIGZvciBnc2RfdGFza19jb21wbGV0ZS4gUmVjb3JkIGEgY29tcGxldGVkIHRhc2sgdG8gdGhlIEdTRCBkYXRhYmFzZSBhbmQgcmVuZGVyIGl0cyBTVU1NQVJZLm1kLlwiLFxuICAgIHRhc2tDb21wbGV0ZVBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGxvZ0FsaWFzVXNhZ2UoXCJnc2RfY29tcGxldGVfdGFza1wiLCBcImdzZF90YXNrX2NvbXBsZXRlXCIpO1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VXb3JrZmxvd0FyZ3ModGFza0NvbXBsZXRlU2NoZW1hLCBhcmdzKTtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgLi4udGFza0FyZ3MgfSA9IHBhcnNlZDtcbiAgICAgIHJldHVybiBoYW5kbGVUYXNrQ29tcGxldGUocHJvamVjdERpciwgdGFza0FyZ3MpO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2RfdGFza19yZW9wZW5cIixcbiAgICBcIlJlc2V0IGEgY29tcGxldGVkIHRhc2sgYmFjayB0byBwZW5kaW5nIHNvIGl0IGNhbiBiZSByZS1kb25lLlwiLFxuICAgIHRhc2tSZW9wZW5QYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVdvcmtmbG93QXJncyh0YXNrUmVvcGVuU2NoZW1hLCBhcmdzKTtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgLi4udGFza0FyZ3MgfSA9IHBhcnNlZDtcbiAgICAgIHJldHVybiBoYW5kbGVUYXNrUmVvcGVuKHByb2plY3REaXIsIHRhc2tBcmdzKTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3Jlb3Blbl90YXNrXCIsXG4gICAgXCJBbGlhcyBmb3IgZ3NkX3Rhc2tfcmVvcGVuLiBSZXNldCBhIGNvbXBsZXRlZCB0YXNrIGJhY2sgdG8gcGVuZGluZyBzbyBpdCBjYW4gYmUgcmUtZG9uZS5cIixcbiAgICB0YXNrUmVvcGVuUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgbG9nQWxpYXNVc2FnZShcImdzZF9yZW9wZW5fdGFza1wiLCBcImdzZF90YXNrX3Jlb3BlblwiKTtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHRhc2tSZW9wZW5TY2hlbWEsIGFyZ3MpO1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCAuLi50YXNrQXJncyB9ID0gcGFyc2VkO1xuICAgICAgcmV0dXJuIGhhbmRsZVRhc2tSZW9wZW4ocHJvamVjdERpciwgdGFza0FyZ3MpO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2Rfc2xpY2VfcmVvcGVuXCIsXG4gICAgXCJSZXNldCBhIGNvbXBsZXRlZCBzbGljZSBiYWNrIHRvIGluX3Byb2dyZXNzIGFuZCByZXNldCBpdHMgdGFza3MgdG8gcGVuZGluZy5cIixcbiAgICBzbGljZVJlb3BlblBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlV29ya2Zsb3dBcmdzKHNsaWNlUmVvcGVuU2NoZW1hLCBhcmdzKTtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgLi4uc2xpY2VBcmdzIH0gPSBwYXJzZWQ7XG4gICAgICByZXR1cm4gaGFuZGxlU2xpY2VSZW9wZW4ocHJvamVjdERpciwgc2xpY2VBcmdzKTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3Jlb3Blbl9zbGljZVwiLFxuICAgIFwiQWxpYXMgZm9yIGdzZF9zbGljZV9yZW9wZW4uIFJlc2V0IGEgY29tcGxldGVkIHNsaWNlIGJhY2sgdG8gaW5fcHJvZ3Jlc3MgYW5kIHJlc2V0IGl0cyB0YXNrcyB0byBwZW5kaW5nLlwiLFxuICAgIHNsaWNlUmVvcGVuUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgbG9nQWxpYXNVc2FnZShcImdzZF9yZW9wZW5fc2xpY2VcIiwgXCJnc2Rfc2xpY2VfcmVvcGVuXCIpO1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VXb3JrZmxvd0FyZ3Moc2xpY2VSZW9wZW5TY2hlbWEsIGFyZ3MpO1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCAuLi5zbGljZUFyZ3MgfSA9IHBhcnNlZDtcbiAgICAgIHJldHVybiBoYW5kbGVTbGljZVJlb3Blbihwcm9qZWN0RGlyLCBzbGljZUFyZ3MpO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2RfbWlsZXN0b25lX3Jlb3BlblwiLFxuICAgIFwiUmVzZXQgYSBjbG9zZWQgbWlsZXN0b25lIGJhY2sgdG8gYWN0aXZlIGFuZCByZXNldCBpdHMgc2xpY2VzL3Rhc2tzIGZvciByZXdvcmsuXCIsXG4gICAgbWlsZXN0b25lUmVvcGVuUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgcGFyc2VkID0gcGFyc2VXb3JrZmxvd0FyZ3MobWlsZXN0b25lUmVvcGVuU2NoZW1hLCBhcmdzKTtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgLi4ubWlsZXN0b25lQXJncyB9ID0gcGFyc2VkO1xuICAgICAgcmV0dXJuIGhhbmRsZU1pbGVzdG9uZVJlb3Blbihwcm9qZWN0RGlyLCBtaWxlc3RvbmVBcmdzKTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX3Jlb3Blbl9taWxlc3RvbmVcIixcbiAgICBcIkFsaWFzIGZvciBnc2RfbWlsZXN0b25lX3Jlb3Blbi4gUmVzZXQgYSBjbG9zZWQgbWlsZXN0b25lIGJhY2sgdG8gYWN0aXZlIGFuZCByZXNldCBpdHMgc2xpY2VzL3Rhc2tzIGZvciByZXdvcmsuXCIsXG4gICAgbWlsZXN0b25lUmVvcGVuUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgbG9nQWxpYXNVc2FnZShcImdzZF9yZW9wZW5fbWlsZXN0b25lXCIsIFwiZ3NkX21pbGVzdG9uZV9yZW9wZW5cIik7XG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVdvcmtmbG93QXJncyhtaWxlc3RvbmVSZW9wZW5TY2hlbWEsIGFyZ3MpO1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCAuLi5taWxlc3RvbmVBcmdzIH0gPSBwYXJzZWQ7XG4gICAgICByZXR1cm4gaGFuZGxlTWlsZXN0b25lUmVvcGVuKHByb2plY3REaXIsIG1pbGVzdG9uZUFyZ3MpO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2RfbWlsZXN0b25lX3N0YXR1c1wiLFxuICAgIFwiUmVhZCB0aGUgY3VycmVudCBzdGF0dXMgb2YgYSBtaWxlc3RvbmUgYW5kIGFsbCBpdHMgc2xpY2VzIGZyb20gdGhlIEdTRCBkYXRhYmFzZS5cIixcbiAgICBtaWxlc3RvbmVTdGF0dXNQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICAvLyBnc2RfbWlsZXN0b25lX3N0YXR1cyBpcyBhIHJlYWQtb25seSBxdWVyeS4gSW4tcHJvY2VzcyAocXVlcnktdG9vbHMudHMpXG4gICAgICAvLyBkb2VzIG5vdCBhcHBseSB0aGUgd3JpdGUtZ2F0ZTsgTUNQIG11c3QgbWF0Y2ggdG8gYXZvaWQgYmxvY2tpbmcgcmVhZHNcbiAgICAgIC8vIGR1cmluZyBwZW5kaW5nLWdhdGUgb3IgcXVldWUtbW9kZSBzdGF0ZXMuXG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIG1pbGVzdG9uZUlkIH0gPSBwYXJzZVdvcmtmbG93QXJncyhtaWxlc3RvbmVTdGF0dXNTY2hlbWEsIGFyZ3MpO1xuICAgICAgY29uc3QgeyBleGVjdXRlTWlsZXN0b25lU3RhdHVzIH0gPSBhd2FpdCBnZXRXb3JrZmxvd1Rvb2xFeGVjdXRvcnMoKTtcbiAgICAgIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgICAgICBhd2FpdCBydW5TZXJpYWxpemVkV29ya2Zsb3dPcGVyYXRpb24oKCkgPT4gZXhlY3V0ZU1pbGVzdG9uZVN0YXR1cyh7IG1pbGVzdG9uZUlkIH0sIHByb2plY3REaXIpKSxcbiAgICAgICk7XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9qb3VybmFsX3F1ZXJ5XCIsXG4gICAgXCJRdWVyeSB0aGUgc3RydWN0dXJlZCBldmVudCBqb3VybmFsIGZvciBhdXRvLW1vZGUgaXRlcmF0aW9ucy5cIixcbiAgICBqb3VybmFsUXVlcnlQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIGxpbWl0LCAuLi5maWx0ZXJzIH0gPSBwYXJzZVdvcmtmbG93QXJncyhqb3VybmFsUXVlcnlTY2hlbWEsIGFyZ3MpO1xuICAgICAgY29uc3QgeyBxdWVyeUpvdXJuYWwgfSA9IGF3YWl0IGltcG9ydExvY2FsTW9kdWxlPGFueT4oXCIuLi8uLi8uLi9zcmMvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL2pvdXJuYWwuanNcIik7XG4gICAgICBjb25zdCBlbnRyaWVzID0gcXVlcnlKb3VybmFsKHByb2plY3REaXIsIGZpbHRlcnMpLnNsaWNlKDAsIGxpbWl0ID8/IDEwMCk7XG4gICAgICBpZiAoZW50cmllcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgcmV0dXJuIHsgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsIHRleHQ6IFwiTm8gbWF0Y2hpbmcgam91cm5hbCBlbnRyaWVzIGZvdW5kLlwiIH1dIH07XG4gICAgICB9XG4gICAgICByZXR1cm4geyBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiBhcyBjb25zdCwgdGV4dDogSlNPTi5zdHJpbmdpZnkoZW50cmllcywgbnVsbCwgMikgfV0gfTtcbiAgICB9LFxuICApO1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX2V4ZWNcIixcbiAgICBcIlJ1biBhIHNob3J0IGJhc2gvbm9kZS9weXRob24gc2NyaXB0IGluIHRoZSBwcm9qZWN0IGRpcmVjdG9yeS4gQ2FwcGVkIHN0ZG91dC9zdGRlcnIgYW5kIG1ldGFkYXRhIHBlcnNpc3QgdW5kZXIgLmdzZC9leGVjOyBvbmx5IGEgZGlnZXN0IHJldHVybnMgdG8gTUNQLlwiLFxuICAgIGV4ZWNQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIC4uLnBhcmFtcyB9ID0gcGFyc2VXb3JrZmxvd0FyZ3MoZXhlY1NjaGVtYSwgYXJncyk7XG4gICAgICBhd2FpdCBlbmZvcmNlV29ya2Zsb3dXcml0ZUdhdGUoXCJnc2RfZXhlY1wiLCBwcm9qZWN0RGlyKTtcbiAgICAgIGNvbnN0IHsgZXhlY3V0ZUdzZEV4ZWMgfSA9IGF3YWl0IGltcG9ydExvY2FsTW9kdWxlPGFueT4oXG4gICAgICAgIFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9leGVjLXRvb2wuanNcIixcbiAgICAgICk7XG4gICAgICByZXR1cm4gYWRhcHRFeGVjdXRvclJlc3VsdChcbiAgICAgICAgYXdhaXQgcnVuU2VyaWFsaXplZFdvcmtmbG93T3BlcmF0aW9uKGFzeW5jICgpID0+XG4gICAgICAgICAgZXhlY3V0ZUdzZEV4ZWMocGFyYW1zLCB7XG4gICAgICAgICAgICBiYXNlRGlyOiBwcm9qZWN0RGlyLFxuICAgICAgICAgICAgcHJlZmVyZW5jZXM6IGF3YWl0IGxvYWRQcm9qZWN0UHJlZmVyZW5jZXMocHJvamVjdERpciksXG4gICAgICAgICAgfSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgIH0sXG4gICk7XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2RfZXhlY19zZWFyY2hcIixcbiAgICBcIlNlYXJjaCBwcmlvciBnc2RfZXhlYyBydW5zIGZyb20gLmdzZC9leGVjLyoubWV0YS5qc29uIHdpdGhvdXQgcmUtcnVubmluZyB0aGVtLlwiLFxuICAgIGV4ZWNTZWFyY2hQYXJhbXMsXG4gICAgYXN5bmMgKGFyZ3M6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICBjb25zdCB7IHByb2plY3REaXIsIC4uLnBhcmFtcyB9ID0gcGFyc2VXb3JrZmxvd0FyZ3MoZXhlY1NlYXJjaFNjaGVtYSwgYXJncyk7XG4gICAgICBjb25zdCB7IGV4ZWN1dGVFeGVjU2VhcmNoIH0gPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxhbnk+KFxuICAgICAgICBcIi4uLy4uLy4uL3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdG9vbHMvZXhlYy1zZWFyY2gtdG9vbC5qc1wiLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgICAgICBleGVjdXRlRXhlY1NlYXJjaChwYXJhbXMsIHtcbiAgICAgICAgICBiYXNlRGlyOiBwcm9qZWN0RGlyLFxuICAgICAgICAgIHByZWZlcmVuY2VzOiBhd2FpdCBsb2FkUHJvamVjdFByZWZlcmVuY2VzKHByb2plY3REaXIpLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgKTtcblxuICBzZXJ2ZXIudG9vbChcbiAgICBcImdzZF9yZXN1bWVcIixcbiAgICBcIlJlYWQgLmdzZC9sYXN0LXNuYXBzaG90Lm1kIHNvIGFnZW50cyBjYW4gcmUtb3JpZW50IGFmdGVyIGNvbXBhY3Rpb24gb3Igc2Vzc2lvbiByZXN1bWUuXCIsXG4gICAgcmVzdW1lUGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCAuLi5wYXJhbXMgfSA9IHBhcnNlV29ya2Zsb3dBcmdzKHJlc3VtZVNjaGVtYSwgYXJncyk7XG4gICAgICBjb25zdCB7IGV4ZWN1dGVSZXN1bWUgfSA9IGF3YWl0IGltcG9ydExvY2FsTW9kdWxlPGFueT4oXG4gICAgICAgIFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9yZXN1bWUtdG9vbC5qc1wiLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBhZGFwdEV4ZWN1dG9yUmVzdWx0KFxuICAgICAgICBleGVjdXRlUmVzdW1lKHBhcmFtcywge1xuICAgICAgICAgIGJhc2VEaXI6IHByb2plY3REaXIsXG4gICAgICAgICAgcHJlZmVyZW5jZXM6IGF3YWl0IGxvYWRQcm9qZWN0UHJlZmVyZW5jZXMocHJvamVjdERpciksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICApO1xuXG4gIC8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBRFItMDEzIHN0ZXAgMyBcdTIwMTQgbWVtb3J5LXN0b3JlIHRvb2xzIGZvciBleHRlcm5hbCBNQ1AgY2xpZW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy9cbiAgLy8gVGhlIHNhbWUgdGhyZWUgdG9vbHMgdGhlIExMTSBzZWVzIGluLXByb2Nlc3MgYXMgYGNhcHR1cmVfdGhvdWdodGAsXG4gIC8vIGBtZW1vcnlfcXVlcnlgLCBhbmQgYGdzZF9ncmFwaGAgKHRoZSBtZW1vcnkgdmFyaWFudCkuIE1DUCBleHBvc2VzIHRoZW1cbiAgLy8gdW5kZXIgdGhlIGdzZF8qIHByZWZpeCBhbmQgcmVuYW1lcyB0aGUgbWVtb3J5IGdyYXBoIHRvIGdzZF9tZW1vcnlfZ3JhcGhcbiAgLy8gdG8gYXZvaWQgY29sbGlzaW9uIHdpdGggdGhlIHByb2plY3Qga25vd2xlZGdlIGdyYXBoIHRvb2wgcmVnaXN0ZXJlZCBhc1xuICAvLyBgZ3NkX2dyYXBoYCBpbiBzZXJ2ZXIudHMuXG5cbiAgY29uc3QgTUVNT1JZX0NBVEVHT1JZID0gei5lbnVtKFtcbiAgICBcImFyY2hpdGVjdHVyZVwiLFxuICAgIFwiY29udmVudGlvblwiLFxuICAgIFwiZ290Y2hhXCIsXG4gICAgXCJwcmVmZXJlbmNlXCIsXG4gICAgXCJlbnZpcm9ubWVudFwiLFxuICAgIFwicGF0dGVyblwiLFxuICBdKTtcblxuICBjb25zdCBjYXB0dXJlVGhvdWdodFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBwcm9qZWN0RGlyOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gICAgY2F0ZWdvcnk6IE1FTU9SWV9DQVRFR09SWSxcbiAgICAvLyBSZWplY3QgZW1wdHkgLyB3aGl0ZXNwYWNlLW9ubHkgY29udGVudCBhdCB0aGUgc2NoZW1hIGxheWVyIHNvIHRoZSBMTE1cbiAgICAvLyBuZXZlciBwcm9kdWNlcyBhIG1lbW9yeSByb3cgd2l0aCBubyBzZWFyY2hhYmxlIHRleHQuXG4gICAgY29udGVudDogei5zdHJpbmcoKS50cmltKCkubWluKDEsIFwiY29udGVudCBtdXN0IGJlIGEgbm9uLWVtcHR5IHRyaW1tZWQgc3RyaW5nXCIpLFxuICAgIGNvbmZpZGVuY2U6IHoubnVtYmVyKCkubWluKDAuMSkubWF4KDAuOTkpLm9wdGlvbmFsKCksXG4gICAgdGFnczogei5hcnJheSh6LnN0cmluZygpKS5vcHRpb25hbCgpLFxuICAgIHNjb3BlOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gICAgc3RydWN0dXJlZEZpZWxkczogei5yZWNvcmQoei5zdHJpbmcoKSwgei51bmtub3duKCkpLm9wdGlvbmFsKCksXG4gIH0pO1xuICBjb25zdCBjYXB0dXJlVGhvdWdodFBhcmFtcyA9IHtcbiAgICBwcm9qZWN0RGlyOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJBYnNvbHV0ZSBwYXRoIHRvIHRoZSBwcm9qZWN0IGRpcmVjdG9yeSAoZGVmYXVsdHMgdG8gTUNQIHNlcnZlciBjd2QpXCIpLFxuICAgIGNhdGVnb3J5OiBNRU1PUllfQ0FURUdPUlkuZGVzY3JpYmUoXCJNZW1vcnkgY2F0ZWdvcnlcIiksXG4gICAgY29udGVudDogei5zdHJpbmcoKS5kZXNjcmliZShcIk1lbW9yeSB0ZXh0ICgxLTMgc2VudGVuY2VzLCBubyBzZWNyZXRzKVwiKSxcbiAgICBjb25maWRlbmNlOiB6Lm51bWJlcigpLm1pbigwLjEpLm1heCgwLjk5KS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiMC4xLTAuOTksIGRlZmF1bHQgMC44XCIpLFxuICAgIHRhZ3M6IHouYXJyYXkoei5zdHJpbmcoKSkub3B0aW9uYWwoKS5kZXNjcmliZShcIkZyZWUtZm9ybSB0YWdzXCIpLFxuICAgIHNjb3BlOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJTY29wZSBuYW1lOyBkZWZhdWx0cyB0byAncHJvamVjdCdcIiksXG4gICAgc3RydWN0dXJlZEZpZWxkczogei5yZWNvcmQoei5zdHJpbmcoKSwgei51bmtub3duKCkpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJBRFItMDEzIHN0cnVjdHVyZWQgcGF5bG9hZCAoZS5nLiBkZWNpc2lvbiBmaWVsZHMpXCIpLFxuICB9O1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX2NhcHR1cmVfdGhvdWdodFwiLFxuICAgIFwiUmVjb3JkIGEgZHVyYWJsZSBwcm9qZWN0IGluc2lnaHQgaW50byB0aGUgR1NEIG1lbW9yeSBzdG9yZS4gQ2F0ZWdvcmllczogYXJjaGl0ZWN0dXJlLCBjb252ZW50aW9uLCBnb3RjaGEsIHByZWZlcmVuY2UsIGVudmlyb25tZW50LCBwYXR0ZXJuLiBNaXJyb3JzIHRoZSBpbi1wcm9jZXNzIGNhcHR1cmVfdGhvdWdodCB0b29sIGZvciBleHRlcm5hbCBNQ1AgY2xpZW50cy5cIixcbiAgICBjYXB0dXJlVGhvdWdodFBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgLi4ucGFyYW1zIH0gPSBwYXJzZVdvcmtmbG93QXJncyhjYXB0dXJlVGhvdWdodFNjaGVtYSwgYXJncyk7XG4gICAgICBhd2FpdCBlbmZvcmNlV29ya2Zsb3dXcml0ZUdhdGUoXCJnc2RfY2FwdHVyZV90aG91Z2h0XCIsIHByb2plY3REaXIpO1xuICAgICAgcmV0dXJuIHJ1blNlcmlhbGl6ZWRXb3JrZmxvd0RiT3BlcmF0aW9uKHByb2plY3REaXIsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgeyBleGVjdXRlTWVtb3J5Q2FwdHVyZSB9ID0gYXdhaXQgaW1wb3J0TG9jYWxNb2R1bGU8YW55PihcbiAgICAgICAgICBcIi4uLy4uLy4uL3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdG9vbHMvbWVtb3J5LXRvb2xzLmpzXCIsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiBleGVjdXRlTWVtb3J5Q2FwdHVyZShwYXJhbXMpO1xuICAgICAgfSk7XG4gICAgfSxcbiAgKTtcblxuICBjb25zdCBtZW1vcnlRdWVyeVNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBwcm9qZWN0RGlyOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gICAgLy8gTWF0Y2ggdGhlIGRvY3VtZW50ZWQgXCIyKyBjaGFyIHRlcm1zXCIgY29udHJhY3QgaW4gdGhlIGluLXByb2Nlc3NcbiAgICAvLyBtZW1vcnlfcXVlcnkgdG9vbCBcdTIwMTQgcmVqZWN0IHN1Yi0yLWNoYXIgcXVlcmllcyBhdCB0aGUgc2NoZW1hIGxheWVyLlxuICAgIHF1ZXJ5OiB6LnN0cmluZygpLnRyaW0oKS5taW4oMiwgXCJxdWVyeSBtdXN0IGJlIGF0IGxlYXN0IDIgY2hhcmFjdGVyc1wiKSxcbiAgICBrOiB6Lm51bWJlcigpLmludCgpLm1pbigxKS5tYXgoNTApLm9wdGlvbmFsKCksXG4gICAgY2F0ZWdvcnk6IE1FTU9SWV9DQVRFR09SWS5vcHRpb25hbCgpLFxuICAgIHNjb3BlOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gICAgdGFnOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gICAgaW5jbHVkZV9zdXBlcnNlZGVkOiB6LmJvb2xlYW4oKS5vcHRpb25hbCgpLFxuICAgIHJlaW5mb3JjZV9oaXRzOiB6LmJvb2xlYW4oKS5vcHRpb25hbCgpLFxuICB9KTtcbiAgY29uc3QgbWVtb3J5UXVlcnlQYXJhbXMgPSB7XG4gICAgcHJvamVjdERpcjogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiQWJzb2x1dGUgcGF0aCB0byB0aGUgcHJvamVjdCBkaXJlY3RvcnkgKGRlZmF1bHRzIHRvIE1DUCBzZXJ2ZXIgY3dkKVwiKSxcbiAgICBxdWVyeTogei5zdHJpbmcoKS5kZXNjcmliZShcIktleXdvcmQgcXVlcnkgKDIrIGNoYXIgdGVybXMpXCIpLFxuICAgIGs6IHoubnVtYmVyKCkuaW50KCkubWluKDEpLm1heCg1MCkub3B0aW9uYWwoKS5kZXNjcmliZShcIk1heCByZXN1bHRzIChkZWZhdWx0IDEwLCBtYXggNTApXCIpLFxuICAgIGNhdGVnb3J5OiBNRU1PUllfQ0FURUdPUlkub3B0aW9uYWwoKS5kZXNjcmliZShcIlJlc3RyaWN0IHRvIGEgc2luZ2xlIGNhdGVnb3J5XCIpLFxuICAgIHNjb3BlOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJPbmx5IGluY2x1ZGUgbWVtb3JpZXMgd2l0aCB0aGlzIHNjb3BlXCIpLFxuICAgIHRhZzogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiT25seSBpbmNsdWRlIG1lbW9yaWVzIHRhZ2dlZCB3aXRoIHRoaXMgdmFsdWVcIiksXG4gICAgaW5jbHVkZV9zdXBlcnNlZGVkOiB6LmJvb2xlYW4oKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiSW5jbHVkZSBzdXBlcnNlZGVkIG1lbW9yaWVzIChkZWZhdWx0IGZhbHNlKVwiKSxcbiAgICByZWluZm9yY2VfaGl0czogei5ib29sZWFuKCkub3B0aW9uYWwoKS5kZXNjcmliZShcIkluY3JlbWVudCBoaXRfY291bnQgb24gcmV0dXJuZWQgbWVtb3JpZXMgKGRlZmF1bHQgZmFsc2UpXCIpLFxuICB9O1xuXG4gIHNlcnZlci50b29sKFxuICAgIFwiZ3NkX21lbW9yeV9xdWVyeVwiLFxuICAgIFwiU2VhcmNoIHRoZSBHU0QgbWVtb3J5IHN0b3JlIGJ5IGtleXdvcmQuIFJldHVybnMgcmFua2VkIG1lbW9yaWVzIHdpdGggaWQsIGNhdGVnb3J5LCBjb250ZW50LCBjb25maWRlbmNlLCBzY29wZSwgYW5kIHRhZ3MuIE1pcnJvcnMgdGhlIGluLXByb2Nlc3MgbWVtb3J5X3F1ZXJ5IHRvb2wgZm9yIGV4dGVybmFsIE1DUCBjbGllbnRzLlwiLFxuICAgIG1lbW9yeVF1ZXJ5UGFyYW1zLFxuICAgIGFzeW5jIChhcmdzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4ge1xuICAgICAgY29uc3QgeyBwcm9qZWN0RGlyLCAuLi5wYXJhbXMgfSA9IHBhcnNlV29ya2Zsb3dBcmdzKG1lbW9yeVF1ZXJ5U2NoZW1hLCBhcmdzKTtcbiAgICAgIHJldHVybiBydW5TZXJpYWxpemVkV29ya2Zsb3dEYk9wZXJhdGlvbihwcm9qZWN0RGlyLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgZXhlY3V0ZU1lbW9yeVF1ZXJ5IH0gPSBhd2FpdCBpbXBvcnRMb2NhbE1vZHVsZTxhbnk+KFxuICAgICAgICAgIFwiLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy9tZW1vcnktdG9vbHMuanNcIixcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuIGV4ZWN1dGVNZW1vcnlRdWVyeShwYXJhbXMpO1xuICAgICAgfSk7XG4gICAgfSxcbiAgKTtcblxuICBjb25zdCBtZW1vcnlHcmFwaFNjaGVtYSA9IHoub2JqZWN0KHtcbiAgICBwcm9qZWN0RGlyOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gICAgbW9kZTogei5lbnVtKFtcImJ1aWxkXCIsIFwicXVlcnlcIl0pLFxuICAgIG1lbW9yeUlkOiB6LnN0cmluZygpLm9wdGlvbmFsKCksXG4gICAgZGVwdGg6IHoubnVtYmVyKCkuaW50KCkubWluKDApLm1heCg1KS5vcHRpb25hbCgpLFxuICAgIHJlbDogei5lbnVtKFtcInJlbGF0ZWRfdG9cIiwgXCJkZXBlbmRzX29uXCIsIFwiY29udHJhZGljdHNcIiwgXCJlbGFib3JhdGVzXCIsIFwic3VwZXJzZWRlc1wiXSkub3B0aW9uYWwoKSxcbiAgfSkucmVmaW5lKFxuICAgICh2YWwpID0+IHZhbC5tb2RlICE9PSBcInF1ZXJ5XCIgfHwgKHR5cGVvZiB2YWwubWVtb3J5SWQgPT09IFwic3RyaW5nXCIgJiYgdmFsLm1lbW9yeUlkLnRyaW0oKS5sZW5ndGggPiAwKSxcbiAgICB7IG1lc3NhZ2U6IFwibWVtb3J5SWQgaXMgcmVxdWlyZWQgYW5kIG11c3QgYmUgbm9uLWVtcHR5IHdoZW4gbW9kZT1xdWVyeVwiLCBwYXRoOiBbXCJtZW1vcnlJZFwiXSB9LFxuICApO1xuICBjb25zdCBtZW1vcnlHcmFwaFBhcmFtcyA9IHtcbiAgICBwcm9qZWN0RGlyOiB6LnN0cmluZygpLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJBYnNvbHV0ZSBwYXRoIHRvIHRoZSBwcm9qZWN0IGRpcmVjdG9yeSAoZGVmYXVsdHMgdG8gTUNQIHNlcnZlciBjd2QpXCIpLFxuICAgIG1vZGU6IHouZW51bShbXCJidWlsZFwiLCBcInF1ZXJ5XCJdKS5kZXNjcmliZShcImJ1aWxkID0gcmVjb21wdXRlIGdyYXBoIChwbGFjZWhvbGRlciksIHF1ZXJ5ID0gaW5zcGVjdCBlZGdlc1wiKSxcbiAgICBtZW1vcnlJZDogei5zdHJpbmcoKS5vcHRpb25hbCgpLmRlc2NyaWJlKFwiTWVtb3J5IElEIChyZXF1aXJlZCB3aGVuIG1vZGU9cXVlcnkpXCIpLFxuICAgIGRlcHRoOiB6Lm51bWJlcigpLmludCgpLm1pbigwKS5tYXgoNSkub3B0aW9uYWwoKS5kZXNjcmliZShcIkhvcHMgdG8gdHJhdmVyc2UgKDAtNSwgZGVmYXVsdCAxKVwiKSxcbiAgICByZWw6IHouZW51bShbXCJyZWxhdGVkX3RvXCIsIFwiZGVwZW5kc19vblwiLCBcImNvbnRyYWRpY3RzXCIsIFwiZWxhYm9yYXRlc1wiLCBcInN1cGVyc2VkZXNcIl0pLm9wdGlvbmFsKCkuZGVzY3JpYmUoXCJPbmx5IGluY2x1ZGUgZWRnZXMgd2l0aCB0aGlzIHJlbGF0aW9uIHR5cGVcIiksXG4gIH07XG5cbiAgc2VydmVyLnRvb2woXG4gICAgXCJnc2RfbWVtb3J5X2dyYXBoXCIsXG4gICAgXCJJbnNwZWN0IHRoZSByZWxhdGlvbnNoaXAgZ3JhcGggYmV0d2VlbiBtZW1vcmllcy4gbW9kZT1xdWVyeSB3YWxrcyBlZGdlcyBmcm9tIGEgZ2l2ZW4gbWVtb3J5SWQuIG1vZGU9YnVpbGQgaXMgYSBwbGFjZWhvbGRlciByZXNlcnZlZCBmb3IgZnV0dXJlIGdyYXBoIHJlYnVpbGRzLiBEaXN0aW5jdCBmcm9tIGdzZF9ncmFwaCAocHJvamVjdCBrbm93bGVkZ2UgZ3JhcGgpIFx1MjAxNCBzZWUgQURSLTAxMy5cIixcbiAgICBtZW1vcnlHcmFwaFBhcmFtcyxcbiAgICBhc3luYyAoYXJnczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHtcbiAgICAgIGNvbnN0IHsgcHJvamVjdERpciwgLi4ucGFyYW1zIH0gPSBwYXJzZVdvcmtmbG93QXJncyhtZW1vcnlHcmFwaFNjaGVtYSwgYXJncyk7XG4gICAgICByZXR1cm4gcnVuU2VyaWFsaXplZFdvcmtmbG93RGJPcGVyYXRpb24ocHJvamVjdERpciwgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCB7IGV4ZWN1dGVHc2RHcmFwaCB9ID0gYXdhaXQgaW1wb3J0TG9jYWxNb2R1bGU8YW55PihcbiAgICAgICAgICBcIi4uLy4uLy4uL3NyYy9yZXNvdXJjZXMvZXh0ZW5zaW9ucy9nc2QvdG9vbHMvbWVtb3J5LXRvb2xzLmpzXCIsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiBleGVjdXRlR3NkR3JhcGgocGFyYW1zKTtcbiAgICAgIH0pO1xuICAgIH0sXG4gICk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFPQSxTQUFTLFlBQVksYUFBYSxvQkFBb0I7QUFDdEQsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsWUFBWSxNQUFNLFVBQVUsZUFBZTtBQUNwRCxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLFNBQVM7QUFDbEIsU0FBUyx1QkFBdUIsb0NBQW9DO0FBRXBFLFNBQVMscUJBQXFCO0FBMlI5QixJQUFJLCtCQUFzRTtBQUMxRSxJQUFJLHlCQUF3QyxRQUFRLFFBQVE7QUFDNUQsSUFBSSwyQkFBb0U7QUFFeEUsU0FBUyxzQkFBc0IsTUFBeUIsUUFBUSxLQUFvQjtBQUNsRixRQUFNLGlCQUFpQixJQUFJLDJCQUEyQixLQUFLO0FBQzNELFNBQU8saUJBQWlCLFFBQVEsY0FBYyxJQUFJO0FBQ3BEO0FBRUEsU0FBUyxhQUFhLGVBQXVCLFVBQTJCO0FBQ3RFLFFBQU0sTUFBTSxTQUFTLFVBQVUsYUFBYTtBQUM1QyxTQUFPLFFBQVEsTUFBTyxDQUFDLElBQUksV0FBVyxJQUFJLEtBQUssQ0FBQyxXQUFXLEdBQUc7QUFDaEU7QUFVQSxTQUFTLHlCQUF5QixhQUFvQztBQUNwRSxNQUFJO0FBQ0YsV0FBTyxhQUFhLEtBQUssYUFBYSxNQUFNLENBQUM7QUFBQSxFQUMvQyxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVPLFNBQVMsbUJBQW1CLFlBQW9CLE1BQXlCLFFBQVEsS0FBYTtBQUNuRyxNQUFJLENBQUMsV0FBVyxVQUFVLEdBQUc7QUFDM0IsVUFBTSxJQUFJLE1BQU0sa0RBQWtELFVBQVUsRUFBRTtBQUFBLEVBQ2hGO0FBRUEsUUFBTSxvQkFBb0IsUUFBUSxVQUFVO0FBSzVDLFFBQU0scUJBQXFCLGFBQWEsaUJBQWlCO0FBRXpELFFBQU0sY0FBYyxzQkFBc0IsR0FBRztBQUM3QyxNQUFJLENBQUMsWUFBYSxRQUFPO0FBRXpCLFFBQU0sc0JBQXNCLGFBQWEsV0FBVztBQUNwRCxNQUFJLGFBQWEsb0JBQW9CLG1CQUFtQixFQUFHLFFBQU87QUFPbEUsUUFBTSxlQUFlLHlCQUF5QixtQkFBbUI7QUFDakUsTUFBSSxnQkFBZ0IsYUFBYSxvQkFBb0IsWUFBWSxHQUFHO0FBQ2xFLFdBQU87QUFBQSxFQUNUO0FBRUEsUUFBTSxJQUFJO0FBQUEsSUFDUiwrRUFBK0Usa0JBQWtCLG1CQUFtQixtQkFBbUI7QUFBQSxFQUN6STtBQUNGO0FBRUEsU0FBUyxhQUFhLE1BQXNCO0FBQzFDLE1BQUk7QUFDRixXQUFPLGFBQWEsSUFBSTtBQUFBLEVBQzFCLFNBQVMsS0FBSztBQU1aLFFBQUssS0FBK0IsU0FBUyxTQUFVLFFBQU87QUFDOUQsVUFBTTtBQUFBLEVBQ1I7QUFDRjtBQUVBLFNBQVMsY0FBaUIsUUFBc0IsTUFBa0M7QUFDaEYsU0FBTyxPQUFPLE1BQU0sSUFBSTtBQUMxQjtBQU1BLFNBQVMsbUJBQW1CLFFBQWdEO0FBQzFFLFFBQU0sYUFBYSxDQUFDLE9BQU8sYUFBYSxPQUFPLGNBQWMsT0FBTyxHQUFHO0FBQ3ZFLGFBQVcsS0FBSyxZQUFZO0FBQzFCLFFBQUksT0FBTyxNQUFNLFlBQVksRUFBRSxLQUFLLE1BQU0sR0FBSSxRQUFPLEVBQUUsS0FBSztBQUFBLEVBQzlEO0FBQ0EsU0FBTztBQUNUO0FBY0EsU0FBUyw4QkFDUCxhQUNBLGFBQ2U7QUFDZixNQUFJLENBQUMsWUFBYSxRQUFPO0FBQ3pCLFFBQU0sU0FBUyxLQUFLLGFBQWEsUUFBUSxhQUFhLFdBQVc7QUFDakUsTUFBSSxDQUFDLFdBQVcsTUFBTSxFQUFHLFFBQU87QUFHaEMsTUFBSSxDQUFDLFdBQVcsS0FBSyxRQUFRLE1BQU0sQ0FBQyxFQUFHLFFBQU87QUFDOUMsU0FBTztBQUNUO0FBT0EsU0FBUywwQkFBMEIsYUFBb0M7QUFDckUsUUFBTSxlQUFlLEtBQUssYUFBYSxRQUFRLFdBQVc7QUFDMUQsTUFBSSxDQUFDLFdBQVcsWUFBWSxFQUFHLFFBQU87QUFDdEMsTUFBSTtBQUNKLE1BQUk7QUFDRixjQUFVLFlBQVksWUFBWTtBQUFBLEVBQ3BDLFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNBLFFBQU0sT0FBTyxRQUNWLElBQUksQ0FBQyxTQUFTLEtBQUssY0FBYyxJQUFJLENBQUMsRUFDdEMsT0FBTyxDQUFDLE1BQU0sV0FBVyxLQUFLLEdBQUcsTUFBTSxDQUFDLENBQUM7QUFDNUMsTUFBSSxLQUFLLFdBQVcsRUFBRyxRQUFPO0FBQzlCLFNBQU8sS0FBSyxDQUFDO0FBQ2Y7QUFFQSxTQUFTLGdCQUFnQixXQUE0QjtBQUNuRCxNQUFJO0FBQ0osTUFBSTtBQUNGLG1CQUFlLGFBQWEsUUFBUSxRQUFRLENBQUMsQ0FBQztBQUFBLEVBQ2hELFFBQVE7QUFDTixtQkFBZSxRQUFRLFFBQVEsQ0FBQztBQUFBLEVBQ2xDO0FBQ0EsTUFBSTtBQUNKLE1BQUk7QUFDRix3QkFBb0IsYUFBYSxRQUFRLFNBQVMsQ0FBQztBQUFBLEVBQ3JELFFBQVE7QUFDTix3QkFBb0IsUUFBUSxTQUFTO0FBQUEsRUFDdkM7QUFDQSxTQUFPLHNCQUFzQjtBQUMvQjtBQUVPLFNBQVMsMEJBQ2QsUUFDQSxNQUM0QjtBQUM1QixTQUFPLGtCQUFrQixRQUFRLElBQUk7QUFDdkM7QUFFQSxTQUFTLGtCQUNQLFFBQ0EsTUFDNEI7QUFDNUIsUUFBTSxTQUFTLGNBQWMsUUFBUSxJQUFJO0FBSXpDLFFBQU0sdUJBQXVCLE9BQU8sY0FBYyxRQUFRLElBQUk7QUFLOUQsTUFBSSxnQkFBZ0Isb0JBQW9CLEdBQUc7QUFDekMsVUFBTSxJQUFJO0FBQUEsTUFDUixxREFBcUQsb0JBQW9CO0FBQUEsSUFFM0U7QUFBQSxFQUNGO0FBRUEsUUFBTSxjQUFjLG1CQUFtQixvQkFBb0I7QUFRM0QsUUFBTSxjQUFjLG1CQUFtQixNQUFpQztBQUN4RSxRQUFNLG1CQUFtQiw4QkFBOEIsYUFBYSxXQUFXLE1BQ3pFLGNBQWMsT0FBTywwQkFBMEIsV0FBVztBQUNoRSxRQUFNLG9CQUFvQixvQkFBb0I7QUFFOUMsU0FBTztBQUFBLElBQ0wsR0FBRztBQUFBLElBQ0gsWUFBWTtBQUFBLEVBQ2Q7QUFDRjtBQUVBLFNBQVMsd0JBQXdCLE9BQWdEO0FBQy9FLE1BQUksQ0FBQyxTQUFTLE9BQU8sVUFBVSxTQUFVLFFBQU87QUFDaEQsUUFBTSxTQUFTO0FBQ2YsUUFBTSxrQkFBa0I7QUFBQSxJQUN0QjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBRUEsU0FBTyxNQUFNLFFBQVEsT0FBTyxnQ0FBZ0MsS0FDMUQsZ0JBQWdCLE1BQU0sQ0FBQyxRQUFRLE9BQU8sT0FBTyxHQUFHLE1BQU0sVUFBVTtBQUNwRTtBQUVBLFNBQVMsaUNBQWlDLFdBQXFEO0FBQzdGLFNBQU8sVUFBVTtBQUNuQjtBQUVBLFNBQVMsc0JBQXNCLGNBQWdDO0FBQzdELFFBQU0sYUFBdUIsQ0FBQztBQUM5QixRQUFNLG9CQUFvQixDQUFDLFNBQXdCO0FBQ2pELFFBQUksQ0FBQyxLQUFNO0FBQ1gsUUFBSSxLQUFLLFNBQVMsS0FBSyxFQUFHLFlBQVcsS0FBSyxLQUFLLFFBQVEsU0FBUyxLQUFLLENBQUM7QUFDdEUsZUFBVyxLQUFLLElBQUk7QUFBQSxFQUN0QjtBQUVBLFFBQU0sYUFBYSxhQUFhLFNBQVMsUUFBUSxJQUM3QyxhQUFhLFFBQVEsVUFBVSxPQUFPLElBQ3RDO0FBQ0osUUFBTSxXQUFXLGFBQWEsU0FBUyxPQUFPLElBQzFDLGFBQWEsUUFBUSxTQUFTLFFBQVEsSUFDdEMsYUFBYSxTQUFTLFFBQVEsSUFDNUIsZUFDQTtBQUVOLG9CQUFrQixVQUFVO0FBQzVCLG9CQUFrQixRQUFRO0FBRTFCLFNBQU8sQ0FBQyxHQUFHLElBQUksSUFBSSxVQUFVLENBQUM7QUFDaEM7QUFFQSxTQUFTLCtCQUF5QztBQUNoRCxRQUFNLGFBQXVCLENBQUM7QUFDOUIsUUFBTSxpQkFBaUIsUUFBUSxJQUFJLGdDQUFnQyxLQUFLO0FBQ3hFLE1BQUksZ0JBQWdCO0FBQ2xCLFFBQUksZUFBZSxLQUFLLGNBQWMsS0FBSyxDQUFDLGVBQWUsV0FBVyxPQUFPLEdBQUc7QUFDOUUsWUFBTSxJQUFJLE1BQU0sOEVBQThFO0FBQUEsSUFDaEc7QUFDQSw2QkFBeUIsa0NBQWtDLGNBQWM7QUFDekUsZUFBVyxLQUFLLGVBQWUsV0FBVyxPQUFPLElBQUksaUJBQWlCLFVBQVUsY0FBYyxDQUFDO0FBQUEsRUFDakc7QUFFQSxhQUFXO0FBQUEsSUFDVCxHQUFHLHNCQUFzQiwrREFBK0QsRUFDckYsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLEdBQUcsWUFBWSxHQUFHLEVBQUUsSUFBSTtBQUFBLEVBQ2hEO0FBRUEsU0FBTyxDQUFDLEdBQUcsSUFBSSxJQUFJLFVBQVUsQ0FBQztBQUNoQztBQUVBLFNBQVMsVUFBVSxZQUE0QjtBQUM3QyxTQUFPLGNBQWMsUUFBUSxVQUFVLENBQUMsRUFBRTtBQUM1QztBQUVBLE1BQU0saUNBQWlDLG9CQUFJLElBQVk7QUFRdkQsU0FBUyx5QkFBeUIsU0FBaUIsT0FBcUI7QUFDdEUsTUFBSSwrQkFBK0IsSUFBSSxPQUFPLEVBQUc7QUFDakQsaUNBQStCLElBQUksT0FBTztBQUMxQyxVQUFRLE9BQU87QUFBQSxJQUNiLDZCQUE2QixPQUFPLFlBQVksS0FBSztBQUFBO0FBQUEsRUFHdkQ7QUFDRjtBQUdPLFNBQVMsdUJBQXVCLGNBQWdDO0FBSXJFLFNBQU8sc0JBQXNCLFlBQVk7QUFDM0M7QUFFQSxlQUFlLGtCQUFxQixjQUFrQztBQUNwRSxRQUFNLGdCQUFnQix1QkFBdUIsWUFBWTtBQUN6RCxRQUFNLGNBQWMsWUFBWSxJQUFJLFNBQVMsYUFBYSxLQUFLLFlBQVksSUFBSSxTQUFTLGVBQWUsSUFDbkcsQ0FBQyxHQUFHLGFBQWEsRUFBRSxLQUFLLENBQUMsR0FBRyxNQUFNLE9BQU8sRUFBRSxTQUFTLEtBQUssQ0FBQyxJQUFJLE9BQU8sRUFBRSxTQUFTLEtBQUssQ0FBQyxDQUFDLElBQ3ZGLGVBQ0QsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLEdBQUcsWUFBWSxHQUFHLEVBQUUsSUFBSTtBQUU5QyxNQUFJO0FBQ0osYUFBVyxhQUFhLFlBQVk7QUFDbEMsUUFBSTtBQUNGLGFBQU8sTUFBTSxPQUFPO0FBQUEsSUFDdEIsU0FBUyxLQUFLO0FBQ1osZ0JBQVU7QUFBQSxJQUNaO0FBQUEsRUFDRjtBQUNBLFFBQU07QUFDUjtBQUVBLGVBQWUsdUJBQXVCLFlBQTZDO0FBQ2pGLFFBQU0sRUFBRSw0QkFBNEIsSUFBSSxNQUFNO0FBQUEsSUFDNUM7QUFBQSxFQUNGO0FBQ0EsTUFBSTtBQUNGLFdBQU8sNEJBQTRCLFVBQVUsRUFBRTtBQUFBLEVBQ2pELFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBRUEsU0FBUyxvQ0FBb0MsTUFBeUIsUUFBUSxLQUFlO0FBQzNGLFFBQU0sYUFBdUIsQ0FBQztBQUM5QixRQUFNLGlCQUFpQixJQUFJLCtCQUErQixLQUFLO0FBQy9ELE1BQUksZ0JBQWdCO0FBQ2xCLFFBQUksZUFBZSxLQUFLLGNBQWMsS0FBSyxDQUFDLGVBQWUsV0FBVyxPQUFPLEdBQUc7QUFDOUUsWUFBTSxJQUFJLE1BQU0sNkVBQTZFO0FBQUEsSUFDL0Y7QUFDQSw2QkFBeUIsaUNBQWlDLGNBQWM7QUFDeEUsZUFBVyxLQUFLLGVBQWUsV0FBVyxPQUFPLElBQUksaUJBQWlCLFVBQVUsY0FBYyxDQUFDO0FBQUEsRUFDakc7QUFFQSxhQUFXO0FBQUEsSUFDVCxHQUFHLHNCQUFzQix3RUFBd0UsRUFDOUYsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLEdBQUcsWUFBWSxHQUFHLEVBQUUsSUFBSTtBQUFBLEVBQ2hEO0FBRUEsU0FBTyxDQUFDLEdBQUcsSUFBSSxJQUFJLFVBQVUsQ0FBQztBQUNoQztBQUVBLGVBQWUsMkJBQTJEO0FBQ3hFLE1BQUksQ0FBQyw4QkFBOEI7QUFDakMsb0NBQWdDLFlBQVk7QUFDMUMsWUFBTSxXQUFxQixDQUFDO0FBQzVCLGlCQUFXLGFBQWEsb0NBQW9DLEdBQUc7QUFDN0QsWUFBSTtBQUNGLGdCQUFNLFNBQVMsTUFBTSxPQUFPO0FBQzVCLGNBQUksd0JBQXdCLE1BQU0sR0FBRztBQUNuQyxtQkFBTztBQUFBLFVBQ1Q7QUFDQSxtQkFBUyxLQUFLLEdBQUcsU0FBUywwQkFBMEI7QUFBQSxRQUN0RCxTQUFTLEtBQUs7QUFDWixtQkFBUyxLQUFLLEdBQUcsU0FBUyxLQUFLLGVBQWUsUUFBUSxJQUFJLFVBQVUsT0FBTyxHQUFHLENBQUMsR0FBRztBQUFBLFFBQ3BGO0FBQUEsTUFDRjtBQUVBLFlBQU0sSUFBSTtBQUFBLFFBQ1IsZ1NBR2EsU0FBUyxLQUFLLElBQUksQ0FBQztBQUFBLE1BQ2xDO0FBQUEsSUFDRixHQUFHO0FBQUEsRUFDTDtBQUNBLFNBQU87QUFDVDtBQUVBLGVBQWUsNkJBQStEO0FBQzVFLE1BQUksQ0FBQywwQkFBMEI7QUFDN0IsZ0NBQTRCLFlBQVk7QUFDdEMsWUFBTSxXQUFxQixDQUFDO0FBQzVCLGlCQUFXLGFBQWEsNkJBQTZCLEdBQUc7QUFDdEQsWUFBSTtBQUNGLGdCQUFNLFNBQVMsTUFBTSxPQUFPO0FBQzVCLGNBQ0UsVUFDQSxPQUFPLE9BQU8sMEJBQTBCLGNBQ3hDLE9BQU8sT0FBTyxxQ0FBcUMsY0FDbkQsT0FBTyxPQUFPLHdDQUF3QyxZQUN0RDtBQUNBLG1CQUFPO0FBQUEsVUFDVDtBQUNBLG1CQUFTLEtBQUssR0FBRyxTQUFTLDBCQUEwQjtBQUFBLFFBQ3RELFNBQVMsS0FBSztBQUNaLG1CQUFTLEtBQUssR0FBRyxTQUFTLEtBQUssZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUcsQ0FBQyxHQUFHO0FBQUEsUUFDcEY7QUFBQSxNQUNGO0FBRUEsWUFBTSxJQUFJO0FBQUEsUUFDUiwwRUFDYSxTQUFTLEtBQUssSUFBSSxDQUFDO0FBQUEsTUFDbEM7QUFBQSxJQUNGLEdBQUc7QUFBQSxFQUNMO0FBQ0EsU0FBTztBQUNUO0FBV08sTUFBTSxzQkFBc0I7QUFFbkMsTUFBTSxpQ0FBaUMsSUFBSSxLQUFLO0FBRWhELFNBQVMsdUJBQXVCLE1BQXlCLFFBQVEsS0FBYTtBQUM1RSxRQUFNLE1BQU0sSUFBSSw2QkFBNkIsS0FBSztBQUNsRCxNQUFJLENBQUMsSUFBSyxRQUFPO0FBQ2pCLFFBQU0sU0FBUyxPQUFPLFNBQVMsS0FBSyxFQUFFO0FBQ3RDLE1BQUksQ0FBQyxPQUFPLFNBQVMsTUFBTSxLQUFLLFNBQVMsRUFBRyxRQUFPO0FBQ25ELFNBQU87QUFDVDtBQXNCQSxTQUFTLG9CQUFvQixRQUEwQjtBQUNyRCxNQUFJLENBQUMsVUFBVSxPQUFPLFdBQVcsU0FBVSxRQUFPO0FBQ2xELFFBQU0sSUFBSTtBQUNWLE1BQUksRUFBRSxhQUFhLEdBQUksUUFBTztBQUM5QixRQUFNLEVBQUUsU0FBUyxHQUFHLEtBQUssSUFBSTtBQUM3QixTQUFPLGNBQWMsT0FBTyxJQUFJLEVBQUUsR0FBRyxNQUFNLG1CQUFtQixRQUFRLElBQUk7QUFDNUU7QUFZQSxTQUFTLGNBQWMsT0FBa0Q7QUFDdkUsTUFBSSxVQUFVLFFBQVEsT0FBTyxVQUFVLFNBQVUsUUFBTztBQUN4RCxNQUFJLE1BQU0sUUFBUSxLQUFLLEVBQUcsUUFBTztBQUNqQyxRQUFNLFFBQVEsT0FBTyxlQUFlLEtBQUs7QUFDekMsU0FBTyxVQUFVLFFBQVEsVUFBVSxPQUFPO0FBQzVDO0FBRUEsZUFBZSwrQkFBa0MsSUFBa0M7QUFlakYsUUFBTSxRQUFRO0FBQ2QsTUFBSTtBQUNKLDJCQUF5QixJQUFJLFFBQWMsQ0FBQ0EsYUFBWTtBQUN0RCxjQUFVQTtBQUFBLEVBQ1osQ0FBQztBQUVELFFBQU07QUFDTixRQUFNLFlBQVksdUJBQXVCO0FBQ3pDLE1BQUk7QUFDRixRQUFJLGNBQWMsR0FBRztBQUNuQixhQUFPLE1BQU0sR0FBRztBQUFBLElBQ2xCO0FBQ0EsUUFBSTtBQUNKLFVBQU0saUJBQWlCLElBQUksUUFBZSxDQUFDLEdBQUcsV0FBVztBQUN2RCxjQUFRLFdBQVcsTUFBTTtBQUN2QixlQUFPLElBQUksTUFBTSwrQkFBK0IsU0FBUywyQ0FBMkMsQ0FBQztBQUFBLE1BQ3ZHLEdBQUcsU0FBUztBQUFBLElBQ2QsQ0FBQztBQUNELFFBQUk7QUFDRixhQUFPLE1BQU0sUUFBUSxLQUFLLENBQUMsR0FBRyxHQUFHLGNBQWMsQ0FBQztBQUFBLElBQ2xELFVBQUU7QUFDQSxVQUFJLE1BQU8sY0FBYSxLQUFLO0FBQUEsSUFDL0I7QUFBQSxFQUNGLFVBQUU7QUFDQSxZQUFRO0FBQUEsRUFDVjtBQUNGO0FBRUEsZUFBZSxpQ0FDYixZQUNBLElBQ1k7QUFDWixTQUFPLCtCQUErQixZQUFZO0FBQ2hELFVBQU0sRUFBRSxhQUFhLElBQUksTUFBTTtBQUFBLE1BQzdCO0FBQUEsSUFDRjtBQUNBLFVBQU0sY0FBYyxNQUFNLGFBQWEsVUFBVTtBQUNqRCxRQUFJLENBQUMsYUFBYTtBQUNoQixZQUFNLElBQUksTUFBTSwrQkFBK0I7QUFBQSxJQUNqRDtBQUNBLFdBQU8sR0FBRztBQUFBLEVBQ1osQ0FBQztBQUNIO0FBRUEsZUFBZSx5QkFDYixVQUNBLFlBQ0EsY0FBNkIsTUFDZDtBQUNmLFFBQU0sWUFBWSxNQUFNLDJCQUEyQjtBQUNuRCxRQUFNLFdBQVcsVUFBVSxzQkFBc0IsVUFBVTtBQUMzRCxRQUFNLGNBQWMsVUFBVTtBQUFBLElBQzVCO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLFNBQVM7QUFBQSxFQUNYO0FBQ0EsTUFBSSxZQUFZLE9BQU87QUFDckIsVUFBTSxJQUFJLE1BQU0sWUFBWSxVQUFVLGtEQUFrRDtBQUFBLEVBQzFGO0FBRUEsUUFBTSxhQUFhLFVBQVU7QUFBQSxJQUMzQjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxTQUFTO0FBQUEsRUFDWDtBQUNBLE1BQUksV0FBVyxPQUFPO0FBQ3BCLFVBQU0sSUFBSSxNQUFNLFdBQVcsVUFBVSx5Q0FBeUM7QUFBQSxFQUNoRjtBQUNGO0FBRUEsZUFBZSxtQkFDYixZQUNBLE1BQ2tCO0FBQ2xCLFFBQU0seUJBQXlCLHFCQUFxQixZQUFZLEtBQUssV0FBVztBQUNoRixRQUFNLEVBQUUsb0JBQW9CLElBQUksTUFBTSx5QkFBeUI7QUFPL0QsU0FBTztBQUFBLElBQ0wsTUFBTSwrQkFBK0IsTUFBTSxvQkFBb0IsTUFBTSxVQUFVLENBQUM7QUFBQSxFQUNsRjtBQUNGO0FBRUEsZUFBZSxpQkFDYixZQUNBLE1BQ2tCO0FBQ2xCLFFBQU0seUJBQXlCLG1CQUFtQixZQUFZLEtBQUssV0FBVztBQUM5RSxRQUFNLEVBQUUsa0JBQWtCLElBQUksTUFBTSx5QkFBeUI7QUFDN0QsU0FBTztBQUFBLElBQ0wsTUFBTSwrQkFBK0IsTUFBTSxrQkFBa0IsTUFBTSxVQUFVLENBQUM7QUFBQSxFQUNoRjtBQUNGO0FBRUEsZUFBZSxrQkFDYixZQUNBLE1BQ2tCO0FBQ2xCLFFBQU0seUJBQXlCLG9CQUFvQixZQUFZLEtBQUssV0FBVztBQUMvRSxRQUFNLEVBQUUsbUJBQW1CLElBQUksTUFBTSx5QkFBeUI7QUFDOUQsU0FBTztBQUFBLElBQ0wsTUFBTSwrQkFBK0IsTUFBTSxtQkFBbUIsTUFBTSxVQUFVLENBQUM7QUFBQSxFQUNqRjtBQUNGO0FBRUEsZUFBZSxzQkFDYixZQUNBLE1BQ2tCO0FBQ2xCLFFBQU0seUJBQXlCLHdCQUF3QixZQUFZLEtBQUssV0FBVztBQUNuRixRQUFNLEVBQUUsdUJBQXVCLElBQUksTUFBTSx5QkFBeUI7QUFDbEUsU0FBTztBQUFBLElBQ0wsTUFBTSwrQkFBK0IsTUFBTSx1QkFBdUIsTUFBTSxVQUFVLENBQUM7QUFBQSxFQUNyRjtBQUNGO0FBRUEsZUFBZSxvQkFDYixZQUNBLE1BQ2tCO0FBQ2xCLFFBQU0seUJBQXlCLHNCQUFzQixZQUFZLEtBQUssV0FBVztBQUNqRixRQUFNLEVBQUUscUJBQXFCLElBQUksTUFBTSx5QkFBeUI7QUFDaEUsUUFBTSxFQUFFLFlBQVksYUFBYSxHQUFHLE9BQU8sSUFBSTtBQUMvQyxTQUFPO0FBQUEsSUFDTCxNQUFNLCtCQUErQixNQUFNLHFCQUFxQixRQUFRLFVBQVUsQ0FBQztBQUFBLEVBQ3JGO0FBQ0Y7QUFFQSxlQUFlLGtCQUNiLFlBQ0EsTUFDa0I7QUFDbEIsUUFBTSx5QkFBeUIsb0JBQW9CLFlBQVksS0FBSyxXQUFXO0FBQy9FLFFBQU0sRUFBRSxtQkFBbUIsSUFBSSxNQUFNLHlCQUF5QjtBQUM5RCxRQUFNLEVBQUUsWUFBWSxhQUFhLEdBQUcsT0FBTyxJQUFJO0FBQy9DLFNBQU87QUFBQSxJQUNMLE1BQU0sK0JBQStCLE1BQU0sbUJBQW1CLFFBQVEsVUFBVSxDQUFDO0FBQUEsRUFDbkY7QUFDRjtBQUVBLGVBQWUsd0JBQ2IsWUFDQSxNQUNrQjtBQUNsQixRQUFNLHlCQUF5QiwwQkFBMEIsWUFBWSxLQUFLLFdBQVc7QUFDckYsUUFBTSxFQUFFLHlCQUF5QixJQUFJLE1BQU0seUJBQXlCO0FBQ3BFLFFBQU0sRUFBRSxZQUFZLGFBQWEsR0FBRyxPQUFPLElBQUk7QUFDL0MsU0FBTztBQUFBLElBQ0wsTUFBTSwrQkFBK0IsTUFBTSx5QkFBeUIsUUFBUSxVQUFVLENBQUM7QUFBQSxFQUN6RjtBQUNGO0FBRUEsZUFBZSx3QkFDYixZQUNBLE1BQ2tCO0FBQ2xCLFFBQU0seUJBQXlCLDBCQUEwQixZQUFZLEtBQUssV0FBVztBQUNyRixRQUFNLEVBQUUseUJBQXlCLElBQUksTUFBTSx5QkFBeUI7QUFDcEUsUUFBTSxFQUFFLFlBQVksYUFBYSxHQUFHLE9BQU8sSUFBSTtBQUMvQyxTQUFPO0FBQUEsSUFDTCxNQUFNLCtCQUErQixNQUFNLHlCQUF5QixRQUFRLFVBQVUsQ0FBQztBQUFBLEVBQ3pGO0FBQ0Y7QUFFQSxlQUFlLHNCQUNiLFlBQ0EsTUFDa0I7QUFDbEIsUUFBTSx5QkFBeUIsd0JBQXdCLFlBQVksS0FBSyxXQUFXO0FBQ25GLFFBQU0sRUFBRSx1QkFBdUIsSUFBSSxNQUFNLHlCQUF5QjtBQUNsRSxRQUFNLEVBQUUsWUFBWSxhQUFhLEdBQUcsT0FBTyxJQUFJO0FBQy9DLFNBQU87QUFBQSxJQUNMLE1BQU0sK0JBQStCLE1BQU0sdUJBQXVCLFFBQVEsVUFBVSxDQUFDO0FBQUEsRUFDdkY7QUFDRjtBQUVBLGVBQWUscUJBQ2IsWUFDQSxNQUNrQjtBQUNsQixRQUFNLHlCQUF5Qix3QkFBd0IsWUFBWSxLQUFLLFdBQVc7QUFDbkYsUUFBTSxFQUFFLHNCQUFzQixJQUFJLE1BQU0seUJBQXlCO0FBQ2pFLFFBQU0sRUFBRSxZQUFZLGFBQWEsR0FBRyxPQUFPLElBQUk7QUFDL0MsU0FBTztBQUFBLElBQ0wsTUFBTSwrQkFBK0IsTUFBTSxzQkFBc0IsUUFBUSxVQUFVLENBQUM7QUFBQSxFQUN0RjtBQUNGO0FBRUEsZUFBZSxxQkFBcUIsYUFBb0M7QUFDdEUsTUFBSTtBQUNGLFVBQU0sRUFBRSxnQkFBZ0IsSUFBSSxNQUFNLGtCQUF1QixpREFBaUQ7QUFDMUcsb0JBQWdCLEVBQUUsSUFBSSxhQUFhLFFBQVEsU0FBUyxDQUFDO0FBQUEsRUFDdkQsUUFBUTtBQUFBLEVBRVI7QUFDRjtBQUVBLGVBQWUsMkJBQThDO0FBQzNELE1BQUk7QUFDRixVQUFNLEVBQUUsaUJBQWlCLElBQUksTUFBTSxrQkFBdUIsaURBQWlEO0FBQzNHLFlBQVEsbUJBQW1CLEtBQUssQ0FBQyxHQUM5QixJQUFJLENBQUMsY0FBdUI7QUFDM0IsWUFBTSxLQUFNLFdBQWdDO0FBQzVDLGFBQU8sT0FBTyxPQUFPLFdBQVcsS0FBSztBQUFBLElBQ3ZDLENBQUMsRUFDQSxPQUFPLENBQUMsT0FBb0MsT0FBTyxJQUFJO0FBQUEsRUFDNUQsUUFBUTtBQUNOLFdBQU8sQ0FBQztBQUFBLEVBQ1Y7QUFDRjtBQVVBLGVBQWUsMkJBQTJCLFlBQXFDO0FBQzdFLFFBQU07QUFBQSxJQUNKO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0YsSUFBSSxNQUFNLGtCQUF1Qix3REFBd0Q7QUFFekYsUUFBTSxXQUFXLGdCQUFnQjtBQUNqQyxNQUFJLFVBQVU7QUFDWixVQUFNLHFCQUFxQixRQUFRO0FBQ25DLFdBQU87QUFBQSxFQUNUO0FBRUEsUUFBTSxTQUFTO0FBQUEsSUFDYixHQUFHLG9CQUFJLElBQUk7QUFBQSxNQUNULEdBQUcsaUJBQWlCLFVBQVU7QUFBQSxNQUM5QixHQUFHLHdCQUF3QjtBQUFBLE1BQzNCLEdBQUksTUFBTSx5QkFBeUI7QUFBQSxJQUNyQyxDQUFDO0FBQUEsRUFDSDtBQUdBLFFBQU0sRUFBRSx5QkFBeUIsSUFBSSxNQUFNO0FBQUEsSUFDekM7QUFBQSxFQUNGO0FBQ0EsUUFBTSxTQUFTLENBQUMsR0FBRyxNQUFNLEVBQUUsS0FBSyxlQUFlO0FBQy9DLGFBQVcsYUFBYSxRQUFRO0FBQzlCLFFBQUkseUJBQXlCLFlBQVksU0FBUyxHQUFHO0FBQ25ELFlBQU0scUJBQXFCLFNBQVM7QUFDcEMsYUFBTztBQUFBLElBQ1Q7QUFBQSxFQUNGO0FBRUEsUUFBTSxXQUFXLE1BQU07QUFBQSxJQUNyQjtBQUFBLEVBQ0YsRUFBRSxNQUFNLE1BQU0sSUFBSTtBQUlsQixNQUFJLGdCQUFnQjtBQUNwQixNQUFJO0FBQ0Ysb0JBQWdCLENBQUMsQ0FBQyxVQUFVLDhCQUE4QixVQUFVLEdBQUcsYUFBYTtBQUFBLEVBQ3RGLFFBQVE7QUFDTixvQkFBZ0I7QUFBQSxFQUNsQjtBQUNBLFFBQU0sU0FBUyxnQkFBZ0IsUUFBUSxhQUFhO0FBQ3BELFFBQU0scUJBQXFCLE1BQU07QUFDakMsU0FBTztBQUNUO0FBTUEsTUFBTSxrQkFBa0IsRUFDckIsT0FBTyxFQUNQLFNBQVMsRUFDVCxTQUFTLCtJQUEwSTtBQUV0SixNQUFNLGlCQUFpQixDQUFDLFVBQ3RCLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEdBQUcsR0FBRyxLQUFLLDZCQUE2QjtBQU9oRSxNQUFNLHlCQUF5QixDQUFDLFVBQWtCLGVBQWUsS0FBSyxFQUFFLFNBQVM7QUFJakYsTUFBTSxzQkFBc0IsQ0FBQyxVQUMzQixFQUFFLE1BQU0sZUFBZSxHQUFHLEtBQUssSUFBSSxDQUFDO0FBY3RDLE1BQU0sdUJBQXVCLENBQUMsVUFDNUIsR0FBRyxLQUFLO0FBRVYsTUFBTSwyQkFBMkIsRUFBRSxPQUFPO0FBQUEsRUFDeEMsU0FBUyxlQUFlLFNBQVM7QUFBQSxFQUNqQyxPQUFPLGVBQWUsT0FBTztBQUFBLEVBQzdCLE1BQU0sZUFBZSxNQUFNO0FBQUEsRUFDM0IsU0FBUyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUM7QUFBQSxFQUMzQixNQUFNLGVBQWUsTUFBTTtBQUFBLEVBQzNCLE1BQU0sZUFBZSxNQUFNO0FBQUE7QUFBQSxFQUUzQixpQkFBaUIsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMscUJBQXFCLGlCQUFpQixDQUFDO0FBQUEsRUFDdkYsWUFBWSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxxQkFBcUIsWUFBWSxDQUFDO0FBQUEsRUFDN0Usb0JBQW9CLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLHFCQUFxQixvQkFBb0IsQ0FBQztBQUFBLEVBQzdGLHFCQUFxQixFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxxQkFBcUIscUJBQXFCLENBQUM7QUFBQTtBQUFBLEVBRS9GLFVBQVUsRUFBRSxRQUFRLEVBQUUsU0FBUyxFQUFFLFNBQVMsMk1BQTJNO0FBQUEsRUFDclAsYUFBYSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxtRUFBbUU7QUFDakgsQ0FBQyxFQUFFO0FBQUEsRUFDRDtBQUNGLEVBQUUsWUFBWSxDQUFDLE9BQU8sUUFBUTtBQUM1QixNQUFJLE1BQU0sYUFBYSxNQUFNO0FBQzNCLFFBQUksT0FBTyxNQUFNLGdCQUFnQixZQUFZLE1BQU0sWUFBWSxLQUFLLEVBQUUsV0FBVyxHQUFHO0FBQ2xGLFVBQUksU0FBUztBQUFBLFFBQ1gsTUFBTSxFQUFFLGFBQWE7QUFBQSxRQUNyQixNQUFNLENBQUMsYUFBYTtBQUFBLFFBQ3BCLFNBQVM7QUFBQSxNQUNYLENBQUM7QUFBQSxJQUNIO0FBQ0E7QUFBQSxFQUNGO0FBQ0EsUUFBTSxXQUFXLENBQUMsbUJBQW1CLGNBQWMsc0JBQXNCLHFCQUFxQjtBQUM5RixhQUFXLFNBQVMsVUFBVTtBQUM1QixVQUFNLFFBQVEsTUFBTSxLQUFLO0FBQ3pCLFFBQUksT0FBTyxVQUFVLFlBQVksTUFBTSxLQUFLLEVBQUUsV0FBVyxHQUFHO0FBQzFELFVBQUksU0FBUztBQUFBLFFBQ1gsTUFBTSxFQUFFLGFBQWE7QUFBQSxRQUNyQixNQUFNLENBQUMsS0FBSztBQUFBLFFBQ1osU0FBUyxHQUFHLEtBQUs7QUFBQSxNQUNuQixDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0Y7QUFDRixDQUFDO0FBRUQsTUFBTSxzQkFBc0I7QUFBQSxFQUMxQixZQUFZO0FBQUEsRUFDWixhQUFhLGVBQWUsYUFBYSxFQUFFLFNBQVMsMEJBQTBCO0FBQUEsRUFDOUUsT0FBTyxlQUFlLE9BQU8sRUFBRSxTQUFTLGlCQUFpQjtBQUFBLEVBQ3pELFFBQVEsZUFBZSxRQUFRLEVBQUUsU0FBUyxrQkFBa0I7QUFBQSxFQUM1RCxRQUFRLEVBQUUsTUFBTSx3QkFBd0IsRUFBRSxTQUFTLGtDQUFrQztBQUFBLEVBQ3JGLFFBQVEsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsa0JBQWtCO0FBQUEsRUFDekQsV0FBVyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsRUFBRSxTQUFTLEVBQUUsU0FBUyx3QkFBd0I7QUFBQSxFQUMzRSxpQkFBaUIsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLEVBQUUsU0FBUyxFQUFFLFNBQVMsb0NBQW9DO0FBQUEsRUFDN0YsVUFBVSxFQUFFLE1BQU0sRUFBRSxPQUFPO0FBQUEsSUFDekIsTUFBTSxlQUFlLE1BQU07QUFBQSxJQUMzQixjQUFjLGVBQWUsY0FBYztBQUFBLEVBQzdDLENBQUMsQ0FBQyxFQUFFLFNBQVMsRUFBRSxTQUFTLHlCQUF5QjtBQUFBLEVBQ2pELGVBQWUsRUFBRSxNQUFNLEVBQUUsT0FBTztBQUFBLElBQzlCLGVBQWUsZUFBZSxlQUFlO0FBQUEsSUFDN0MsVUFBVSxlQUFlLFVBQVU7QUFBQSxJQUNuQyxrQkFBa0IsZUFBZSxrQkFBa0I7QUFBQSxFQUNyRCxDQUFDLENBQUMsRUFBRSxTQUFTLEVBQUUsU0FBUyxtQ0FBbUM7QUFBQSxFQUMzRCxzQkFBc0IsRUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLEVBQzFDLHlCQUF5QixFQUFFLE9BQU8sRUFBRSxTQUFTO0FBQUEsRUFDN0MseUJBQXlCLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxFQUM3QyxpQkFBaUIsRUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLEVBQ3JDLGtCQUFrQixFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDL0MscUJBQXFCLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxFQUN6QyxxQkFBcUIsRUFBRSxPQUFPLEVBQUUsU0FBUztBQUMzQztBQUNBLE1BQU0sc0JBQXNCLEVBQUUsT0FBTyxtQkFBbUI7QUFFeEQsTUFBTSxrQkFBa0I7QUFBQSxFQUN0QixZQUFZO0FBQUEsRUFDWixhQUFhLGVBQWUsYUFBYSxFQUFFLFNBQVMsMEJBQTBCO0FBQUEsRUFDOUUsU0FBUyxlQUFlLFNBQVMsRUFBRSxTQUFTLHFCQUFxQjtBQUFBLEVBQ2pFLE1BQU0sZUFBZSxNQUFNLEVBQUUsU0FBUyxZQUFZO0FBQUEsRUFDbEQsT0FBTyxFQUFFLE1BQU0sRUFBRSxPQUFPO0FBQUEsSUFDdEIsUUFBUSxlQUFlLFFBQVE7QUFBQSxJQUMvQixPQUFPLGVBQWUsT0FBTztBQUFBLElBQzdCLGFBQWEsZUFBZSxhQUFhO0FBQUEsSUFDekMsVUFBVSxlQUFlLFVBQVU7QUFBQSxJQUNuQyxPQUFPLG9CQUFvQixPQUFPO0FBQUEsSUFDbEMsUUFBUSxlQUFlLFFBQVE7QUFBQSxJQUMvQixRQUFRLG9CQUFvQixRQUFRO0FBQUEsSUFDcEMsZ0JBQWdCLG9CQUFvQixnQkFBZ0I7QUFBQSxJQUNwRCxxQkFBcUIsdUJBQXVCLHFCQUFxQjtBQUFBLEVBQ25FLENBQUMsQ0FBQyxFQUFFLFNBQVMsNkJBQTZCO0FBQUEsRUFDMUMsaUJBQWlCLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxFQUNyQyxZQUFZLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxFQUNoQyxvQkFBb0IsRUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLEVBQ3hDLHFCQUFxQixFQUFFLE9BQU8sRUFBRSxTQUFTO0FBQzNDO0FBQ0EsTUFBTSxrQkFBa0IsRUFBRSxPQUFPLGVBQWU7QUFFaEQsTUFBTSwwQkFBMEI7QUFBQSxFQUM5QixZQUFZO0FBQUEsRUFDWixhQUFhLGVBQWUsYUFBYSxFQUFFLFNBQVMsMEJBQTBCO0FBQUEsRUFDOUUsT0FBTyxlQUFlLE9BQU8sRUFBRSxTQUFTLGlCQUFpQjtBQUFBLEVBQ3pELFVBQVUsRUFBRSxPQUFPLEVBQUUsU0FBUyxxREFBcUQ7QUFBQSxFQUNuRixXQUFXLEVBQUUsT0FBTyxFQUFFLFNBQVMsMERBQTBEO0FBQUEsRUFDekYsb0JBQW9CLEVBQUUsUUFBUSxFQUFFLFNBQVMsb0RBQW9EO0FBQUEsRUFDN0Ysd0JBQXdCLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxFQUM1Qyx5QkFBeUIsRUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLEVBQzdDLHFCQUFxQixFQUFFLE9BQU8sRUFBRSxTQUFTO0FBQUEsRUFDekMsY0FBYyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDM0MsVUFBVSxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDdkMsZ0JBQWdCLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxFQUFFLFNBQVM7QUFBQSxFQUM3QyxXQUFXLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxFQUMvQixZQUFZLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFDbEM7QUFDQSxNQUFNLDBCQUEwQixFQUFFLE9BQU8sdUJBQXVCO0FBRWhFLE1BQU0sMEJBQTBCO0FBQUEsRUFDOUIsWUFBWTtBQUFBLEVBQ1osYUFBYSxlQUFlLGFBQWEsRUFBRSxTQUFTLDBCQUEwQjtBQUFBLEVBQzlFLFNBQVMsRUFBRSxLQUFLLENBQUMsUUFBUSxtQkFBbUIsbUJBQW1CLENBQUMsRUFBRSxTQUFTLG9CQUFvQjtBQUFBLEVBQy9GLGtCQUFrQixFQUFFLE9BQU8sRUFBRSxTQUFTLDRDQUE0QztBQUFBLEVBQ2xGLDBCQUEwQixFQUFFLE9BQU8sRUFBRSxTQUFTLHNEQUFzRDtBQUFBLEVBQ3BHLG9CQUFvQixFQUFFLE9BQU8sRUFBRSxTQUFTLDREQUE0RDtBQUFBLEVBQ3BHLHVCQUF1QixFQUFFLE9BQU8sRUFBRSxTQUFTLG1EQUFtRDtBQUFBLEVBQzlGLHFCQUFxQixFQUFFLE9BQU8sRUFBRSxTQUFTLG1EQUFtRDtBQUFBLEVBQzVGLHFCQUFxQixFQUFFLE9BQU8sRUFBRSxTQUFTO0FBQUEsRUFDekMsa0JBQWtCLEVBQUUsT0FBTyxFQUFFLFNBQVMsNkJBQTZCO0FBQUEsRUFDbkUsaUJBQWlCLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFDdkM7QUFDQSxNQUFNLDBCQUEwQixFQUFFLE9BQU8sdUJBQXVCO0FBRWhFLE1BQU0sMkJBQTJCLEVBQUUsT0FBTztBQUFBLEVBQ3hDLFNBQVMsZUFBZSxTQUFTO0FBQUEsRUFDakMsT0FBTyxlQUFlLE9BQU87QUFBQSxFQUM3QixNQUFNLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxFQUMxQixTQUFTLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxFQUFFLFNBQVM7QUFBQSxFQUN0QyxNQUFNLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFDNUIsQ0FBQztBQUVELE1BQU0sd0JBQXdCO0FBQUEsRUFDNUIsWUFBWTtBQUFBLEVBQ1osYUFBYSxlQUFlLGFBQWEsRUFBRSxTQUFTLDBCQUEwQjtBQUFBLEVBQzlFLGtCQUFrQixlQUFlLGtCQUFrQixFQUFFLFNBQVMsOEJBQThCO0FBQUEsRUFDNUYsU0FBUyxlQUFlLFNBQVMsRUFBRSxTQUFTLGtFQUFrRTtBQUFBLEVBQzlHLFlBQVksZUFBZSxZQUFZLEVBQUUsU0FBUyxpREFBaUQ7QUFBQSxFQUNuRyxjQUFjLEVBQUUsT0FBTztBQUFBLElBQ3JCLFVBQVUsRUFBRSxNQUFNLHdCQUF3QjtBQUFBLElBQzFDLE9BQU8sRUFBRSxNQUFNLHdCQUF3QjtBQUFBLElBQ3ZDLFNBQVMsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDO0FBQUEsRUFDN0IsQ0FBQyxFQUFFLFNBQVMsd0JBQXdCO0FBQ3RDO0FBQ0EsTUFBTSx3QkFBd0IsRUFBRSxPQUFPLHFCQUFxQjtBQUU1RCxNQUFNLHVCQUF1QjtBQUFBLEVBQzNCLFlBQVk7QUFBQSxFQUNaLGFBQWEsRUFBRSxPQUFPLEVBQUUsU0FBUywwQkFBMEI7QUFBQSxFQUMzRCxTQUFTLEVBQUUsT0FBTyxFQUFFLFNBQVMscUJBQXFCO0FBQUEsRUFDbEQsUUFBUSxFQUFFLE9BQU8sRUFBRSxTQUFTLDZIQUE2SDtBQUFBLEVBQ3pKLFFBQVEsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsK0JBQStCO0FBQUEsRUFDdEUsU0FBUyxFQUFFLEtBQUssQ0FBQyxRQUFRLFFBQVEsU0FBUyxDQUFDLEVBQUUsU0FBUyxjQUFjO0FBQUEsRUFDcEUsV0FBVyxFQUFFLE9BQU8sRUFBRSxTQUFTLDRCQUE0QjtBQUFBLEVBQzNELFVBQVUsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsNEJBQTRCO0FBQ3ZFO0FBQ0EsTUFBTSx1QkFBdUIsRUFBRSxPQUFPLG9CQUFvQjtBQUUxRCxNQUFNLG9CQUFvQjtBQUFBLEVBQ3hCLFlBQVk7QUFBQSxFQUNaLGFBQWEsZUFBZSxhQUFhLEVBQUUsU0FBUywwQkFBMEI7QUFBQSxFQUM5RSxTQUFTLGVBQWUsU0FBUyxFQUFFLFNBQVMscUJBQXFCO0FBQUEsRUFDakUsZUFBZSxlQUFlLGVBQWUsRUFBRSxTQUFTLHFDQUFxQztBQUFBLEVBQzdGLG9CQUFvQixlQUFlLG9CQUFvQixFQUFFLFNBQVMsNEJBQTRCO0FBQUEsRUFDOUYsYUFBYSxlQUFlLGFBQWEsRUFBRSxTQUFTLHFDQUFxQztBQUFBLEVBQ3pGLGNBQWMsRUFBRSxNQUFNLEVBQUUsT0FBTztBQUFBLElBQzdCLFFBQVEsZUFBZSxRQUFRO0FBQUEsSUFDL0IsT0FBTyxlQUFlLE9BQU87QUFBQSxJQUM3QixhQUFhLEVBQUUsT0FBTztBQUFBLElBQ3RCLFVBQVUsRUFBRSxPQUFPO0FBQUEsSUFDbkIsT0FBTyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUM7QUFBQSxJQUN6QixRQUFRLEVBQUUsT0FBTztBQUFBLElBQ2pCLFFBQVEsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDO0FBQUEsSUFDMUIsZ0JBQWdCLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQztBQUFBLElBQ2xDLFlBQVksRUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLEVBQ2xDLENBQUMsQ0FBQyxFQUFFLFNBQVMsMENBQTBDO0FBQUEsRUFDdkQsZ0JBQWdCLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxFQUFFLFNBQVMsbUNBQW1DO0FBQ2xGO0FBQ0EsTUFBTSxvQkFBb0IsRUFBRSxPQUFPLGlCQUFpQjtBQUVwRCxNQUFNLHNCQUFzQjtBQUFBLEVBQzFCLFlBQVk7QUFBQSxFQUNaLFNBQVMsZUFBZSxTQUFTLEVBQUUsU0FBUyxxQkFBcUI7QUFBQSxFQUNqRSxhQUFhLGVBQWUsYUFBYSxFQUFFLFNBQVMsMEJBQTBCO0FBQUEsRUFDOUUsWUFBWSxFQUFFLE9BQU8sRUFBRSxTQUFTLG9CQUFvQjtBQUFBLEVBQ3BELFVBQVUsRUFBRSxPQUFPLEVBQUUsU0FBUyxpREFBaUQ7QUFBQSxFQUMvRSxXQUFXLEVBQUUsT0FBTyxFQUFFLFNBQVMsc0RBQXNEO0FBQUEsRUFDckYsY0FBYyxFQUFFLE9BQU8sRUFBRSxTQUFTLG9DQUFvQztBQUFBLEVBQ3RFLFlBQVksRUFBRSxPQUFPLEVBQUUsU0FBUyxrQ0FBa0M7QUFBQSxFQUNsRSxZQUFZLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxFQUNoQyxrQkFBa0IsRUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLEVBQ3RDLFdBQVcsRUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLEVBQy9CLFVBQVUsRUFBRSxNQUFNLENBQUMsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLEdBQUcsRUFBRSxPQUFPLENBQUMsQ0FBQyxFQUFFLFNBQVM7QUFBQSxFQUM5RCxjQUFjLEVBQUUsTUFBTSxDQUFDLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDbEUscUJBQXFCLEVBQUUsTUFBTSxDQUFDLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDekUsdUJBQXVCLEVBQUUsTUFBTSxDQUFDLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDM0UsVUFBVSxFQUFFLE1BQU0sQ0FBQyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDLEVBQUUsU0FBUztBQUFBLEVBQzlELHNCQUFzQixFQUFFLE1BQU0sQ0FBQyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDLEVBQUUsU0FBUztBQUFBLEVBQzFFLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxDQUFDLEVBQUUsU0FBUztBQUFBLEVBQ3BFLFNBQVMsRUFBRSxNQUFNLENBQUMsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLEdBQUcsRUFBRSxPQUFPLENBQUMsQ0FBQyxFQUFFLFNBQVM7QUFBQSxFQUM3RCxzQkFBc0IsRUFBRSxNQUFNLEVBQUUsTUFBTTtBQUFBLElBQ3BDLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxPQUFPLEdBQUcsS0FBSyxFQUFFLE9BQU8sRUFBRSxDQUFDO0FBQUEsSUFDNUMsRUFBRSxPQUFPO0FBQUEsRUFDWCxDQUFDLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDYix1QkFBdUIsRUFBRSxNQUFNLEVBQUUsTUFBTTtBQUFBLElBQ3JDLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxPQUFPLEdBQUcsT0FBTyxFQUFFLE9BQU8sRUFBRSxDQUFDO0FBQUEsSUFDOUMsRUFBRSxPQUFPO0FBQUEsRUFDWCxDQUFDLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDYix5QkFBeUIsRUFBRSxNQUFNLEVBQUUsTUFBTTtBQUFBLElBQ3ZDLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxPQUFPLEdBQUcsTUFBTSxFQUFFLE9BQU8sRUFBRSxDQUFDO0FBQUEsSUFDN0MsRUFBRSxPQUFPO0FBQUEsRUFDWCxDQUFDLENBQUMsRUFBRSxTQUFTO0FBQUEsRUFDYixlQUFlLEVBQUUsTUFBTSxFQUFFLE1BQU07QUFBQSxJQUM3QixFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsT0FBTyxHQUFHLGFBQWEsRUFBRSxPQUFPLEVBQUUsQ0FBQztBQUFBLElBQ3RELEVBQUUsT0FBTztBQUFBLEVBQ1gsQ0FBQyxDQUFDLEVBQUUsU0FBUztBQUFBLEVBQ2IsVUFBVSxFQUFFLE1BQU0sRUFBRSxNQUFNO0FBQUEsSUFDeEIsRUFBRSxPQUFPLEVBQUUsT0FBTyxFQUFFLE9BQU8sR0FBRyxVQUFVLEVBQUUsT0FBTyxFQUFFLENBQUM7QUFBQSxJQUNwRCxFQUFFLE9BQU87QUFBQSxFQUNYLENBQUMsQ0FBQyxFQUFFLFNBQVM7QUFDZjtBQUNBLE1BQU0sc0JBQXNCLEVBQUUsT0FBTyxtQkFBbUI7QUFFeEQsTUFBTSxvQkFBb0I7QUFBQSxFQUN4QixZQUFZO0FBQUEsRUFDWixjQUFjLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLHFIQUFxSDtBQUFBLEVBQ2xLLFVBQVUsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMscUJBQXFCO0FBQUEsRUFDOUQsU0FBUyxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxvQkFBb0I7QUFBQSxFQUM1RCxlQUFlLEVBQUUsT0FBTyxFQUFFLFNBQVMseUlBQXlJO0FBQUEsRUFDNUssU0FBUyxFQUFFLE9BQU8sRUFBRSxTQUFTLDJDQUEyQztBQUMxRTtBQUNBLE1BQU0sOEJBQThCLG9CQUFJLElBQUk7QUFBQSxFQUMxQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGLENBQUM7QUFDRCxNQUFNLG9CQUFvQixFQUFFLE9BQU8saUJBQWlCLEVBQUUsWUFBWSxDQUFDLE9BQU8sUUFBUTtBQUNoRixRQUFNLGlCQUFpQiw0QkFBNEIsSUFBSSxNQUFNLGFBQWE7QUFDMUUsTUFBSSxDQUFDLG1CQUFtQixDQUFDLE1BQU0sZ0JBQWdCLE1BQU0sYUFBYSxLQUFLLE1BQU0sS0FBSztBQUNoRixRQUFJLFNBQVM7QUFBQSxNQUNYLE1BQU0sRUFBRSxhQUFhO0FBQUEsTUFDckIsTUFBTSxDQUFDLGNBQWM7QUFBQSxNQUNyQixTQUFTO0FBQUEsSUFDWCxDQUFDO0FBQUEsRUFDSDtBQUNGLENBQUM7QUFFRCxNQUFNLHFCQUFxQjtBQUFBLEVBQ3pCLFlBQVk7QUFBQSxFQUNaLE9BQU8sRUFBRSxPQUFPLEVBQUUsU0FBUyxtRUFBbUU7QUFBQSxFQUM5RixVQUFVLEVBQUUsT0FBTyxFQUFFLFNBQVMsdUJBQXVCO0FBQUEsRUFDckQsUUFBUSxFQUFFLE9BQU8sRUFBRSxTQUFTLGlCQUFpQjtBQUFBLEVBQzdDLFdBQVcsRUFBRSxPQUFPLEVBQUUsU0FBUywwQkFBMEI7QUFBQSxFQUN6RCxXQUFXLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLCtCQUErQjtBQUFBLEVBQ3pFLGNBQWMsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsK0JBQStCO0FBQUEsRUFDNUUsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTLFNBQVMsZUFBZSxDQUFDLEVBQUUsU0FBUyxFQUFFLFNBQVMsdUJBQXVCO0FBQ2xHO0FBQ0EsTUFBTSxxQkFBcUIsRUFBRSxPQUFPLGtCQUFrQjtBQUV0RCxNQUFNLDBCQUEwQjtBQUFBLEVBQzlCLFlBQVk7QUFBQSxFQUNaLElBQUksRUFBRSxPQUFPLEVBQUUsU0FBUyw0QkFBNEI7QUFBQSxFQUNwRCxRQUFRLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLFlBQVk7QUFBQSxFQUNuRCxZQUFZLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLDhCQUE4QjtBQUFBLEVBQ3pFLE9BQU8sRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsa0JBQWtCO0FBQUEsRUFDeEQsYUFBYSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxxQkFBcUI7QUFBQSxFQUNqRSxlQUFlLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLHNCQUFzQjtBQUFBLEVBQ3BFLG1CQUFtQixFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxtQkFBbUI7QUFDdkU7QUFDQSxNQUFNLDBCQUEwQixFQUFFLE9BQU8sdUJBQXVCO0FBRWhFLE1BQU0sd0JBQXdCO0FBQUEsRUFDNUIsWUFBWTtBQUFBLEVBQ1osT0FBTyxFQUFFLE9BQU8sRUFBRSxTQUFTLG9PQUFvTztBQUFBLEVBQy9QLGFBQWEsRUFBRSxPQUFPLEVBQUUsU0FBUyxzQ0FBc0M7QUFBQSxFQUN2RSxLQUFLLEVBQUUsT0FBTyxFQUFFLFNBQVMsOEJBQThCO0FBQUEsRUFDdkQsUUFBUSxFQUFFLE9BQU8sRUFBRSxTQUFTLDJCQUEyQjtBQUFBLEVBQ3ZELFFBQVEsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsb0JBQW9CO0FBQUEsRUFDM0QsZUFBZSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxzQkFBc0I7QUFBQSxFQUNwRSxtQkFBbUIsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsbUJBQW1CO0FBQUEsRUFDckUsWUFBWSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxxQkFBcUI7QUFBQSxFQUNoRSxPQUFPLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLGtCQUFrQjtBQUMxRDtBQUNBLE1BQU0sd0JBQXdCLEVBQUUsT0FBTyxxQkFBcUI7QUFFNUQsTUFBTSw0QkFBNEI7QUFBQSxFQUNoQyxZQUFZO0FBQ2Q7QUFDQSxNQUFNLDRCQUE0QixFQUFFLE9BQU8seUJBQXlCO0FBRXBFLE1BQU0saUJBQWlCO0FBQUEsRUFDckIsWUFBWTtBQUFBLEVBQ1osYUFBYSxlQUFlLGFBQWEsRUFBRSxTQUFTLDBCQUEwQjtBQUFBLEVBQzlFLFNBQVMsZUFBZSxTQUFTLEVBQUUsU0FBUyxxQkFBcUI7QUFBQSxFQUNqRSxRQUFRLGVBQWUsUUFBUSxFQUFFLFNBQVMsb0JBQW9CO0FBQUEsRUFDOUQsT0FBTyxlQUFlLE9BQU8sRUFBRSxTQUFTLFlBQVk7QUFBQSxFQUNwRCxhQUFhLGVBQWUsYUFBYSxFQUFFLFNBQVMsZ0NBQWdDO0FBQUEsRUFDcEYsVUFBVSxlQUFlLFVBQVUsRUFBRSxTQUFTLGVBQWU7QUFBQSxFQUM3RCxPQUFPLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxFQUFFLFNBQVMsc0JBQXNCO0FBQUEsRUFDMUQsUUFBUSxlQUFlLFFBQVEsRUFBRSxTQUFTLCtCQUErQjtBQUFBLEVBQ3pFLFFBQVEsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLEVBQUUsU0FBUywyQkFBMkI7QUFBQSxFQUNoRSxnQkFBZ0IsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLEVBQUUsU0FBUyxvQ0FBb0M7QUFBQSxFQUNqRixxQkFBcUIsdUJBQXVCLHFCQUFxQixFQUFFLFNBQVMsMkJBQTJCO0FBQ3pHO0FBQ0EsTUFBTSxpQkFBaUIsRUFBRSxPQUFPLGNBQWM7QUFFOUMsTUFBTSxrQkFBa0I7QUFBQSxFQUN0QixZQUFZO0FBQUEsRUFDWixTQUFTLEVBQUUsT0FBTyxFQUFFLFNBQVMscUJBQXFCO0FBQUEsRUFDbEQsYUFBYSxFQUFFLE9BQU8sRUFBRSxTQUFTLDBCQUEwQjtBQUFBLEVBQzNELFFBQVEsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsZ0NBQWdDO0FBQ3pFO0FBQ0EsTUFBTSxrQkFBa0IsRUFBRSxPQUFPLGVBQWU7QUFFaEQsTUFBTSxxQkFBcUI7QUFBQSxFQUN6QixZQUFZO0FBQUEsRUFDWixRQUFRLGVBQWUsUUFBUSxFQUFFLFNBQVMsb0JBQW9CO0FBQUEsRUFDOUQsU0FBUyxlQUFlLFNBQVMsRUFBRSxTQUFTLHFCQUFxQjtBQUFBLEVBQ2pFLGFBQWEsZUFBZSxhQUFhLEVBQUUsU0FBUywwQkFBMEI7QUFBQSxFQUM5RSxVQUFVLEVBQUUsT0FBTyxFQUFFLFNBQVMsMkNBQTJDO0FBQUEsRUFDekUsV0FBVyxFQUFFLE9BQU8sRUFBRSxTQUFTLHFEQUFxRDtBQUFBLEVBQ3BGLGNBQWMsRUFBRSxPQUFPLEVBQUUsU0FBUywyQkFBMkI7QUFBQSxFQUM3RCxZQUFZLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLCtCQUErQjtBQUFBLEVBQzFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsdUNBQXVDO0FBQUEsRUFDbkYsVUFBVSxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsRUFBRSxTQUFTLEVBQUUsU0FBUyx1Q0FBdUM7QUFBQSxFQUN6RixjQUFjLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxFQUFFLFNBQVMsRUFBRSxTQUFTLDZDQUE2QztBQUFBLEVBQ25HLG1CQUFtQixFQUFFLFFBQVEsRUFBRSxTQUFTLEVBQUUsU0FBUyxvREFBb0Q7QUFBQTtBQUFBLEVBRXZHLFlBQVksRUFBRSxPQUFPO0FBQUEsSUFDbkIsVUFBVSxFQUFFLE9BQU8sRUFBRSxTQUFTLGtFQUE2RDtBQUFBLElBQzNGLFNBQVMsRUFBRSxNQUFNLEVBQUUsT0FBTztBQUFBLE1BQ3hCLElBQUksRUFBRSxPQUFPLEVBQUUsU0FBUyx5REFBeUQ7QUFBQSxNQUNqRixPQUFPLEVBQUUsT0FBTyxFQUFFLFNBQVMsaUJBQWlCO0FBQUEsTUFDNUMsV0FBVyxFQUFFLE9BQU8sRUFBRSxTQUFTLGdEQUFnRDtBQUFBLElBQ2pGLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxFQUFFLElBQUksQ0FBQyxFQUFFLFNBQVMsMENBQTBDO0FBQUEsSUFDckUsZ0JBQWdCLEVBQUUsT0FBTyxFQUFFLFNBQVMsb0NBQW9DO0FBQUEsSUFDeEUseUJBQXlCLEVBQUUsT0FBTyxFQUFFLFNBQVMsOENBQXlDO0FBQUEsSUFDdEYscUJBQXFCLEVBQUUsUUFBUSxFQUFFO0FBQUEsTUFDL0I7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDLEVBQUUsU0FBUyxFQUFFLFNBQVMsMEdBQTBHO0FBQUEsRUFDakksc0JBQXNCLEVBQUUsTUFBTSxFQUFFLE1BQU07QUFBQSxJQUNwQyxFQUFFLE9BQU87QUFBQSxNQUNQLFNBQVMsRUFBRSxPQUFPO0FBQUEsTUFDbEIsVUFBVSxFQUFFLE9BQU87QUFBQSxNQUNuQixTQUFTLEVBQUUsT0FBTztBQUFBLE1BQ2xCLFlBQVksRUFBRSxPQUFPO0FBQUEsSUFDdkIsQ0FBQztBQUFBLElBQ0QsRUFBRSxPQUFPO0FBQUEsRUFDWCxDQUFDLENBQUMsRUFBRSxTQUFTLEVBQUUsU0FBUywrQkFBK0I7QUFDekQ7QUFDQSxNQUFNLHFCQUFxQixFQUFFLE9BQU8sa0JBQWtCO0FBRXRELE1BQU0sbUJBQW1CO0FBQUEsRUFDdkIsWUFBWTtBQUFBLEVBQ1osUUFBUSxlQUFlLFFBQVEsRUFBRSxTQUFTLG9CQUFvQjtBQUFBLEVBQzlELFNBQVMsZUFBZSxTQUFTLEVBQUUsU0FBUyxxQkFBcUI7QUFBQSxFQUNqRSxhQUFhLGVBQWUsYUFBYSxFQUFFLFNBQVMsMEJBQTBCO0FBQUEsRUFDOUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxnQ0FBZ0M7QUFBQSxFQUN2RSxXQUFXLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLGdEQUFnRDtBQUFBLEVBQzFGLGVBQWUsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsa0RBQWtEO0FBQ2xHO0FBQ0EsTUFBTSxtQkFBbUIsRUFBRSxPQUFPLGdCQUFnQjtBQUVsRCxNQUFNLG9CQUFvQjtBQUFBLEVBQ3hCLFlBQVk7QUFBQSxFQUNaLFNBQVMsZUFBZSxTQUFTLEVBQUUsU0FBUyxxQkFBcUI7QUFBQSxFQUNqRSxhQUFhLGVBQWUsYUFBYSxFQUFFLFNBQVMsMEJBQTBCO0FBQUEsRUFDOUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxpQ0FBaUM7QUFBQSxFQUN4RSxXQUFXLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLGdEQUFnRDtBQUFBLEVBQzFGLGVBQWUsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsa0RBQWtEO0FBQ2xHO0FBQ0EsTUFBTSxvQkFBb0IsRUFBRSxPQUFPLGlCQUFpQjtBQUVwRCxNQUFNLHdCQUF3QjtBQUFBLEVBQzVCLFlBQVk7QUFBQSxFQUNaLGFBQWEsZUFBZSxhQUFhLEVBQUUsU0FBUywwQkFBMEI7QUFBQSxFQUM5RSxRQUFRLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLHFDQUFxQztBQUFBLEVBQzVFLFdBQVcsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsZ0RBQWdEO0FBQUEsRUFDMUYsZUFBZSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxrREFBa0Q7QUFDbEc7QUFDQSxNQUFNLHdCQUF3QixFQUFFLE9BQU8scUJBQXFCO0FBRTVELE1BQU0sd0JBQXdCO0FBQUEsRUFDNUIsWUFBWTtBQUFBLEVBQ1osYUFBYSxFQUFFLE9BQU8sRUFBRSxTQUFTLG1DQUFtQztBQUN0RTtBQUNBLE1BQU0sd0JBQXdCLEVBQUUsT0FBTyxxQkFBcUI7QUFFNUQsTUFBTSxxQkFBcUI7QUFBQSxFQUN6QixZQUFZO0FBQUEsRUFDWixRQUFRLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLG1CQUFtQjtBQUFBLEVBQzFELFFBQVEsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsbUJBQW1CO0FBQUEsRUFDMUQsTUFBTSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxxQkFBcUI7QUFBQSxFQUMxRCxXQUFXLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLHNCQUFzQjtBQUFBLEVBQ2hFLE9BQU8sRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsa0NBQWtDO0FBQUEsRUFDeEUsUUFBUSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxrQ0FBa0M7QUFBQSxFQUN6RSxPQUFPLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLDJCQUEyQjtBQUNuRTtBQUNBLE1BQU0scUJBQXFCLEVBQUUsT0FBTyxrQkFBa0I7QUFFdEQsTUFBTSxvQkFBb0IsRUFBRSxLQUFLLENBQUMsUUFBUSxRQUFRLFFBQVEsQ0FBQztBQUMzRCxNQUFNLGFBQWE7QUFBQSxFQUNqQixZQUFZO0FBQUEsRUFDWixTQUFTLGtCQUFrQixTQUFTLHFEQUFxRDtBQUFBLEVBQ3pGLFFBQVEsZUFBZSxRQUFRLEVBQUUsU0FBUyxxRkFBcUY7QUFBQSxFQUMvSCxTQUFTLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLHFEQUFxRDtBQUFBLEVBQzdGLFlBQVksRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLElBQUksR0FBSyxFQUFFLElBQUksR0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLHlDQUF5QztBQUNwSDtBQUNBLE1BQU0sYUFBYSxFQUFFLE9BQU8sVUFBVTtBQUV0QyxNQUFNLG1CQUFtQjtBQUFBLEVBQ3ZCLFlBQVk7QUFBQSxFQUNaLE9BQU8sRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsNkRBQTZEO0FBQUEsRUFDbkcsU0FBUyxrQkFBa0IsU0FBUyxFQUFFLFNBQVMsMEJBQTBCO0FBQUEsRUFDekUsY0FBYyxFQUFFLFFBQVEsRUFBRSxTQUFTLEVBQUUsU0FBUyx3Q0FBd0M7QUFBQSxFQUN0RixPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsRUFBRSxJQUFJLEdBQUcsRUFBRSxTQUFTLEVBQUUsU0FBUyxvQ0FBb0M7QUFDbEc7QUFDQSxNQUFNLG1CQUFtQixFQUFFLE9BQU8sZ0JBQWdCO0FBRWxELE1BQU0sZUFBZTtBQUFBLEVBQ25CLFlBQVk7QUFDZDtBQUNBLE1BQU0sZUFBZSxFQUFFLE9BQU8sWUFBWTtBQWUxQyxTQUFTLDJCQUEyQixZQUEwQztBQUM1RSxTQUFPO0FBQUEsSUFDTCxLQUFLLE1BQU0sYUFBYSxRQUFRLFNBQVM7QUFDdkMsYUFBTyxXQUFXLEtBQUssTUFBTSxhQUFhLFFBQVEsT0FBTyxTQUFTO0FBQ2hFLFlBQUk7QUFDRixpQkFBTyxNQUFNLFFBQVEsSUFBSTtBQUFBLFFBQzNCLFNBQVMsS0FBSztBQUNaLGdCQUFNLFVBQVUsZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFDL0QsaUJBQU87QUFBQSxZQUNMLFNBQVM7QUFBQSxZQUNULFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSxRQUFRLENBQUM7QUFBQSxVQUNwRDtBQUFBLFFBQ0Y7QUFBQSxNQUNGLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRjtBQUNGO0FBRU8sU0FBUyxzQkFBc0IsWUFBaUM7QUFDckUsUUFBTSxTQUFTLDJCQUEyQixVQUFVO0FBQ3BELFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxTQUFTLGtCQUFrQixvQkFBb0IsSUFBSTtBQUN6RCxZQUFNLEVBQUUsWUFBWSxHQUFHLE9BQU8sSUFBSTtBQUNsQyxZQUFNLHlCQUF5QixxQkFBcUIsVUFBVTtBQUM5RCxZQUFNLFNBQVMsTUFBTSxpQ0FBaUMsWUFBWSxZQUFZO0FBQzVFLGNBQU0sRUFBRSxpQkFBaUIsSUFBSSxNQUFNLGtCQUF1QixvREFBb0Q7QUFDOUcsZUFBTyxpQkFBaUIsUUFBUSxVQUFVO0FBQUEsTUFDNUMsQ0FBQztBQUNELGFBQU8sRUFBRSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0sa0JBQWtCLE9BQU8sRUFBRSxHQUFHLENBQUMsRUFBRTtBQUFBLElBQ3JGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsb0JBQWMscUJBQXFCLG1CQUFtQjtBQUN0RCxZQUFNLFNBQVMsa0JBQWtCLG9CQUFvQixJQUFJO0FBQ3pELFlBQU0sRUFBRSxZQUFZLEdBQUcsT0FBTyxJQUFJO0FBQ2xDLFlBQU0seUJBQXlCLHFCQUFxQixVQUFVO0FBQzlELFlBQU0sU0FBUyxNQUFNLGlDQUFpQyxZQUFZLFlBQVk7QUFDNUUsY0FBTSxFQUFFLGlCQUFpQixJQUFJLE1BQU0sa0JBQXVCLG9EQUFvRDtBQUM5RyxlQUFPLGlCQUFpQixRQUFRLFVBQVU7QUFBQSxNQUM1QyxDQUFDO0FBQ0QsYUFBTyxFQUFFLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSxrQkFBa0IsT0FBTyxFQUFFLEdBQUcsQ0FBQyxFQUFFO0FBQUEsSUFDckY7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxZQUFNLFNBQVMsa0JBQWtCLHlCQUF5QixJQUFJO0FBQzlELFlBQU0sRUFBRSxZQUFZLElBQUksR0FBRyxRQUFRLElBQUk7QUFDdkMsWUFBTSx5QkFBeUIsMEJBQTBCLFVBQVU7QUFDbkUsWUFBTSxpQ0FBaUMsWUFBWSxZQUFZO0FBQzdELGNBQU0sRUFBRSxzQkFBc0IsSUFBSSxNQUFNLGtCQUF1QixvREFBb0Q7QUFDbkgsZUFBTyxzQkFBc0IsSUFBSSxTQUFTLFVBQVU7QUFBQSxNQUN0RCxDQUFDO0FBQ0QsYUFBTyxFQUFFLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSx1QkFBdUIsRUFBRSxHQUFHLENBQUMsRUFBRTtBQUFBLElBQ25GO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsb0JBQWMsMEJBQTBCLHdCQUF3QjtBQUNoRSxZQUFNLFNBQVMsa0JBQWtCLHlCQUF5QixJQUFJO0FBQzlELFlBQU0sRUFBRSxZQUFZLElBQUksR0FBRyxRQUFRLElBQUk7QUFDdkMsWUFBTSx5QkFBeUIsMEJBQTBCLFVBQVU7QUFDbkUsWUFBTSxpQ0FBaUMsWUFBWSxZQUFZO0FBQzdELGNBQU0sRUFBRSxzQkFBc0IsSUFBSSxNQUFNLGtCQUF1QixvREFBb0Q7QUFDbkgsZUFBTyxzQkFBc0IsSUFBSSxTQUFTLFVBQVU7QUFBQSxNQUN0RCxDQUFDO0FBQ0QsYUFBTyxFQUFFLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSx1QkFBdUIsRUFBRSxHQUFHLENBQUMsRUFBRTtBQUFBLElBQ25GO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxTQUFTLGtCQUFrQix1QkFBdUIsSUFBSTtBQUM1RCxZQUFNLEVBQUUsWUFBWSxHQUFHLE9BQU8sSUFBSTtBQUNsQyxZQUFNLHlCQUF5Qix3QkFBd0IsVUFBVTtBQUNqRSxZQUFNLFNBQVMsTUFBTSxpQ0FBaUMsWUFBWSxZQUFZO0FBQzVFLGNBQU0sRUFBRSxvQkFBb0IsSUFBSSxNQUFNLGtCQUF1QixvREFBb0Q7QUFDakgsZUFBTyxvQkFBb0IsUUFBUSxVQUFVO0FBQUEsTUFDL0MsQ0FBQztBQUNELGFBQU8sRUFBRSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0scUJBQXFCLE9BQU8sRUFBRSxHQUFHLENBQUMsRUFBRTtBQUFBLElBQ3hGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsb0JBQWMsd0JBQXdCLHNCQUFzQjtBQUM1RCxZQUFNLFNBQVMsa0JBQWtCLHVCQUF1QixJQUFJO0FBQzVELFlBQU0sRUFBRSxZQUFZLEdBQUcsT0FBTyxJQUFJO0FBQ2xDLFlBQU0seUJBQXlCLHdCQUF3QixVQUFVO0FBQ2pFLFlBQU0sU0FBUyxNQUFNLGlDQUFpQyxZQUFZLFlBQVk7QUFDNUUsY0FBTSxFQUFFLG9CQUFvQixJQUFJLE1BQU0sa0JBQXVCLG9EQUFvRDtBQUNqSCxlQUFPLG9CQUFvQixRQUFRLFVBQVU7QUFBQSxNQUMvQyxDQUFDO0FBQ0QsYUFBTyxFQUFFLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSxxQkFBcUIsT0FBTyxFQUFFLEdBQUcsQ0FBQyxFQUFFO0FBQUEsSUFDeEY7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxZQUFNLEVBQUUsV0FBVyxJQUFJLGtCQUFrQiwyQkFBMkIsSUFBSTtBQUN4RSxZQUFNLHlCQUF5Qiw2QkFBNkIsVUFBVTtBQUN0RSxZQUFNLEtBQUssTUFBTTtBQUFBLFFBQWlDO0FBQUEsUUFBWSxNQUM1RCwyQkFBMkIsVUFBVTtBQUFBLE1BQ3ZDO0FBQ0EsYUFBTyxFQUFFLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSxHQUFHLENBQUMsRUFBRTtBQUFBLElBQzFEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsb0JBQWMsNkJBQTZCLDJCQUEyQjtBQUN0RSxZQUFNLEVBQUUsV0FBVyxJQUFJLGtCQUFrQiwyQkFBMkIsSUFBSTtBQUN4RSxZQUFNLHlCQUF5Qiw2QkFBNkIsVUFBVTtBQUN0RSxZQUFNLEtBQUssTUFBTTtBQUFBLFFBQWlDO0FBQUEsUUFBWSxNQUM1RCwyQkFBMkIsVUFBVTtBQUFBLE1BQ3ZDO0FBQ0EsYUFBTyxFQUFFLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSxHQUFHLENBQUMsRUFBRTtBQUFBLElBQzFEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxTQUFTLGtCQUFrQixxQkFBcUIsSUFBSTtBQUMxRCxZQUFNLEVBQUUsWUFBWSxHQUFHLE9BQU8sSUFBSTtBQUNsQyxZQUFNLHlCQUF5QixzQkFBc0IsWUFBWSxPQUFPLFdBQVc7QUFDbkYsWUFBTSxFQUFFLHFCQUFxQixJQUFJLE1BQU0seUJBQXlCO0FBQ2hFLGFBQU87QUFBQSxRQUNMLE1BQU0sK0JBQStCLE1BQU0scUJBQXFCLFFBQVEsVUFBVSxDQUFDO0FBQUEsTUFDckY7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxTQUFTLGtCQUFrQixpQkFBaUIsSUFBSTtBQUN0RCxZQUFNLEVBQUUsWUFBWSxHQUFHLE9BQU8sSUFBSTtBQUNsQyxZQUFNLHlCQUF5QixrQkFBa0IsWUFBWSxPQUFPLFdBQVc7QUFDL0UsWUFBTSxFQUFFLGlCQUFpQixJQUFJLE1BQU0seUJBQXlCO0FBQzVELGFBQU87QUFBQSxRQUNMLE1BQU0sK0JBQStCLE1BQU0saUJBQWlCLFFBQVEsVUFBVSxDQUFDO0FBQUEsTUFDakY7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxTQUFTLGtCQUFrQixnQkFBZ0IsSUFBSTtBQUNyRCxZQUFNLEVBQUUsWUFBWSxHQUFHLE9BQU8sSUFBSTtBQUNsQyxZQUFNLHlCQUF5QixpQkFBaUIsWUFBWSxPQUFPLFdBQVc7QUFDOUUsWUFBTSxTQUFTLE1BQU0saUNBQWlDLFlBQVksWUFBWTtBQUM1RSxjQUFNLEVBQUUsZUFBZSxJQUFJLE1BQU0sa0JBQXVCLDBEQUEwRDtBQUNsSCxlQUFPLGVBQWUsUUFBUSxVQUFVO0FBQUEsTUFDMUMsQ0FBQztBQUNELFVBQUksV0FBVyxRQUFRO0FBQ3JCLGNBQU0sSUFBSSxNQUFNLE9BQU8sS0FBSztBQUFBLE1BQzlCO0FBQ0EsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLGdCQUFnQixPQUFPLE1BQU0sS0FBSyxPQUFPLE9BQU8sSUFBSSxPQUFPLFdBQVcsSUFBSSxDQUFDO0FBQUEsTUFDdEg7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsb0JBQWMsaUJBQWlCLGVBQWU7QUFDOUMsWUFBTSxTQUFTLGtCQUFrQixnQkFBZ0IsSUFBSTtBQUNyRCxZQUFNLEVBQUUsWUFBWSxHQUFHLE9BQU8sSUFBSTtBQUNsQyxZQUFNLHlCQUF5QixpQkFBaUIsWUFBWSxPQUFPLFdBQVc7QUFDOUUsWUFBTSxTQUFTLE1BQU0saUNBQWlDLFlBQVksWUFBWTtBQUM1RSxjQUFNLEVBQUUsZUFBZSxJQUFJLE1BQU0sa0JBQXVCLDBEQUEwRDtBQUNsSCxlQUFPLGVBQWUsUUFBUSxVQUFVO0FBQUEsTUFDMUMsQ0FBQztBQUNELFVBQUksV0FBVyxRQUFRO0FBQ3JCLGNBQU0sSUFBSSxNQUFNLE9BQU8sS0FBSztBQUFBLE1BQzlCO0FBQ0EsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLGdCQUFnQixPQUFPLE1BQU0sS0FBSyxPQUFPLE9BQU8sSUFBSSxPQUFPLFdBQVcsSUFBSSxDQUFDO0FBQUEsTUFDdEg7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxTQUFTLGtCQUFrQixtQkFBbUIsSUFBSTtBQUN4RCxhQUFPLGtCQUFrQixPQUFPLFlBQVksTUFBTTtBQUFBLElBQ3BEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsb0JBQWMsb0JBQW9CLGtCQUFrQjtBQUNwRCxZQUFNLFNBQVMsa0JBQWtCLG1CQUFtQixJQUFJO0FBQ3hELGFBQU8sa0JBQWtCLE9BQU8sWUFBWSxNQUFNO0FBQUEsSUFDcEQ7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxZQUFNLFNBQVMsa0JBQWtCLHFCQUFxQixJQUFJO0FBQzFELGFBQU8sb0JBQW9CLE9BQU8sWUFBWSxNQUFNO0FBQUEsSUFDdEQ7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxvQkFBYyxzQkFBc0Isb0JBQW9CO0FBQ3hELFlBQU0sU0FBUyxrQkFBa0IscUJBQXFCLElBQUk7QUFDMUQsYUFBTyxvQkFBb0IsT0FBTyxZQUFZLE1BQU07QUFBQSxJQUN0RDtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLFlBQU0sRUFBRSxZQUFZLGFBQWEsU0FBUyxPQUFPLElBQUksa0JBQWtCLGlCQUFpQixJQUFJO0FBQzVGLFlBQU0seUJBQXlCLGtCQUFrQixZQUFZLFdBQVc7QUFDeEUsWUFBTSxpQ0FBaUMsWUFBWSxZQUFZO0FBQzdELGNBQU0sRUFBRSxVQUFVLGtCQUFrQixJQUFJLE1BQU0sa0JBQXVCLGlEQUFpRDtBQUN0SCxjQUFNLEVBQUUscUJBQXFCLElBQUksTUFBTSxrQkFBdUIsZ0RBQWdEO0FBQzlHLGNBQU0sRUFBRSxhQUFhLElBQUksTUFBTSxrQkFBdUIsaURBQWlEO0FBQ3ZHLGNBQU0sUUFBUSxTQUFTLGFBQWEsT0FBTztBQUMzQyxZQUFJLENBQUMsT0FBTztBQUNWLGdCQUFNLElBQUksTUFBTSxTQUFTLE9BQU8sMkJBQTJCLFdBQVcsRUFBRTtBQUFBLFFBQzFFO0FBQ0EsWUFBSSxNQUFNLFdBQVcsY0FBYyxNQUFNLFdBQVcsUUFBUTtBQUMxRCxnQkFBTSxJQUFJLE1BQU0sU0FBUyxPQUFPLDRDQUE0QztBQUFBLFFBQzlFO0FBQ0EsWUFBSSxNQUFNLFdBQVcsV0FBVztBQUM5Qiw0QkFBa0IsYUFBYSxTQUFTLFNBQVM7QUFDakQsK0JBQXFCO0FBQ3JCLGdCQUFNLGFBQWEsVUFBVTtBQUFBLFFBQy9CO0FBQUEsTUFDRixDQUFDO0FBQ0QsYUFBTztBQUFBLFFBQ0wsU0FBUyxDQUFDLEVBQUUsTUFBTSxRQUFpQixNQUFNLGlCQUFpQixPQUFPLEtBQUssV0FBVyxjQUFjLFVBQVUsb0JBQW9CLElBQUksQ0FBQztBQUFBLE1BQ3BJO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLFlBQU0sU0FBUyxrQkFBa0IseUJBQXlCLElBQUk7QUFDOUQsYUFBTyx3QkFBd0IsT0FBTyxZQUFZLE1BQU07QUFBQSxJQUMxRDtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLG9CQUFjLDBCQUEwQix3QkFBd0I7QUFDaEUsWUFBTSxTQUFTLGtCQUFrQix5QkFBeUIsSUFBSTtBQUM5RCxhQUFPLHdCQUF3QixPQUFPLFlBQVksTUFBTTtBQUFBLElBQzFEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxTQUFTLGtCQUFrQix5QkFBeUIsSUFBSTtBQUM5RCxhQUFPLHdCQUF3QixPQUFPLFlBQVksTUFBTTtBQUFBLElBQzFEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsb0JBQWMsMEJBQTBCLHdCQUF3QjtBQUNoRSxZQUFNLFNBQVMsa0JBQWtCLHlCQUF5QixJQUFJO0FBQzlELGFBQU8sd0JBQXdCLE9BQU8sWUFBWSxNQUFNO0FBQUEsSUFDMUQ7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxZQUFNLFNBQVMsa0JBQWtCLHVCQUF1QixJQUFJO0FBQzVELGFBQU8sc0JBQXNCLE9BQU8sWUFBWSxNQUFNO0FBQUEsSUFDeEQ7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxvQkFBYyx3QkFBd0Isc0JBQXNCO0FBQzVELFlBQU0sU0FBUyxrQkFBa0IsdUJBQXVCLElBQUk7QUFDNUQsYUFBTyxzQkFBc0IsT0FBTyxZQUFZLE1BQU07QUFBQSxJQUN4RDtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLFlBQU0sU0FBUyxrQkFBa0Isc0JBQXNCLElBQUk7QUFDM0QsYUFBTyxxQkFBcUIsT0FBTyxZQUFZLE1BQU07QUFBQSxJQUN2RDtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLFlBQU0sU0FBUyxrQkFBa0IsbUJBQW1CLElBQUk7QUFDeEQsWUFBTSxFQUFFLFlBQVksY0FBYyxVQUFVLFNBQVMsZUFBZSxRQUFRLElBQUk7QUFDaEYsWUFBTSx5QkFBeUIsb0JBQW9CLFlBQVksZ0JBQWdCLElBQUk7QUFDbkYsWUFBTSxZQUFZLE1BQU0seUJBQXlCO0FBQ2pELFlBQU0seUJBQXlCLGlDQUFpQyxTQUFTO0FBQ3pFLFVBQUksQ0FBQyx1QkFBdUIsU0FBUyxhQUFhLEdBQUc7QUFDbkQsY0FBTSxJQUFJO0FBQUEsVUFDUixpQ0FBaUMsdUJBQXVCLEtBQUssSUFBSSxDQUFDO0FBQUEsUUFDcEU7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsTUFBTTtBQUFBLFVBQStCLE1BQ25DLFVBQVUsbUJBQW1CLEVBQUUsY0FBYyxVQUFVLFNBQVMsZUFBZSxRQUFRLEdBQUcsVUFBVTtBQUFBLFFBQ3RHO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxZQUFNLFNBQVMsa0JBQWtCLG9CQUFvQixJQUFJO0FBQ3pELFlBQU0sRUFBRSxZQUFZLEdBQUcsU0FBUyxJQUFJO0FBQ3BDLGFBQU8sbUJBQW1CLFlBQVksUUFBUTtBQUFBLElBQ2hEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsb0JBQWMscUJBQXFCLG1CQUFtQjtBQUN0RCxZQUFNLFNBQVMsa0JBQWtCLG9CQUFvQixJQUFJO0FBQ3pELFlBQU0sRUFBRSxZQUFZLEdBQUcsU0FBUyxJQUFJO0FBQ3BDLGFBQU8sbUJBQW1CLFlBQVksUUFBUTtBQUFBLElBQ2hEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxTQUFTLGtCQUFrQixrQkFBa0IsSUFBSTtBQUN2RCxZQUFNLEVBQUUsWUFBWSxHQUFHLFNBQVMsSUFBSTtBQUNwQyxhQUFPLGlCQUFpQixZQUFZLFFBQVE7QUFBQSxJQUM5QztBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLG9CQUFjLG1CQUFtQixpQkFBaUI7QUFDbEQsWUFBTSxTQUFTLGtCQUFrQixrQkFBa0IsSUFBSTtBQUN2RCxZQUFNLEVBQUUsWUFBWSxHQUFHLFNBQVMsSUFBSTtBQUNwQyxhQUFPLGlCQUFpQixZQUFZLFFBQVE7QUFBQSxJQUM5QztBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLFlBQU0sU0FBUyxrQkFBa0IsbUJBQW1CLElBQUk7QUFDeEQsWUFBTSxFQUFFLFlBQVksR0FBRyxVQUFVLElBQUk7QUFDckMsYUFBTyxrQkFBa0IsWUFBWSxTQUFTO0FBQUEsSUFDaEQ7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxvQkFBYyxvQkFBb0Isa0JBQWtCO0FBQ3BELFlBQU0sU0FBUyxrQkFBa0IsbUJBQW1CLElBQUk7QUFDeEQsWUFBTSxFQUFFLFlBQVksR0FBRyxVQUFVLElBQUk7QUFDckMsYUFBTyxrQkFBa0IsWUFBWSxTQUFTO0FBQUEsSUFDaEQ7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxZQUFNLFNBQVMsa0JBQWtCLHVCQUF1QixJQUFJO0FBQzVELFlBQU0sRUFBRSxZQUFZLEdBQUcsY0FBYyxJQUFJO0FBQ3pDLGFBQU8sc0JBQXNCLFlBQVksYUFBYTtBQUFBLElBQ3hEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsb0JBQWMsd0JBQXdCLHNCQUFzQjtBQUM1RCxZQUFNLFNBQVMsa0JBQWtCLHVCQUF1QixJQUFJO0FBQzVELFlBQU0sRUFBRSxZQUFZLEdBQUcsY0FBYyxJQUFJO0FBQ3pDLGFBQU8sc0JBQXNCLFlBQVksYUFBYTtBQUFBLElBQ3hEO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFJdkMsWUFBTSxFQUFFLFlBQVksWUFBWSxJQUFJLGtCQUFrQix1QkFBdUIsSUFBSTtBQUNqRixZQUFNLEVBQUUsdUJBQXVCLElBQUksTUFBTSx5QkFBeUI7QUFDbEUsYUFBTztBQUFBLFFBQ0wsTUFBTSwrQkFBK0IsTUFBTSx1QkFBdUIsRUFBRSxZQUFZLEdBQUcsVUFBVSxDQUFDO0FBQUEsTUFDaEc7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxFQUFFLFlBQVksT0FBTyxHQUFHLFFBQVEsSUFBSSxrQkFBa0Isb0JBQW9CLElBQUk7QUFDcEYsWUFBTSxFQUFFLGFBQWEsSUFBSSxNQUFNLGtCQUF1QixrREFBa0Q7QUFDeEcsWUFBTSxVQUFVLGFBQWEsWUFBWSxPQUFPLEVBQUUsTUFBTSxHQUFHLFNBQVMsR0FBRztBQUN2RSxVQUFJLFFBQVEsV0FBVyxHQUFHO0FBQ3hCLGVBQU8sRUFBRSxTQUFTLENBQUMsRUFBRSxNQUFNLFFBQWlCLE1BQU0scUNBQXFDLENBQUMsRUFBRTtBQUFBLE1BQzVGO0FBQ0EsYUFBTyxFQUFFLFNBQVMsQ0FBQyxFQUFFLE1BQU0sUUFBaUIsTUFBTSxLQUFLLFVBQVUsU0FBUyxNQUFNLENBQUMsRUFBRSxDQUFDLEVBQUU7QUFBQSxJQUN4RjtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLFlBQU0sRUFBRSxZQUFZLEdBQUcsT0FBTyxJQUFJLGtCQUFrQixZQUFZLElBQUk7QUFDcEUsWUFBTSx5QkFBeUIsWUFBWSxVQUFVO0FBQ3JELFlBQU0sRUFBRSxlQUFlLElBQUksTUFBTTtBQUFBLFFBQy9CO0FBQUEsTUFDRjtBQUNBLGFBQU87QUFBQSxRQUNMLE1BQU07QUFBQSxVQUErQixZQUNuQyxlQUFlLFFBQVE7QUFBQSxZQUNyQixTQUFTO0FBQUEsWUFDVCxhQUFhLE1BQU0sdUJBQXVCLFVBQVU7QUFBQSxVQUN0RCxDQUFDO0FBQUEsUUFDSDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU8sU0FBa0M7QUFDdkMsWUFBTSxFQUFFLFlBQVksR0FBRyxPQUFPLElBQUksa0JBQWtCLGtCQUFrQixJQUFJO0FBQzFFLFlBQU0sRUFBRSxrQkFBa0IsSUFBSSxNQUFNO0FBQUEsUUFDbEM7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsa0JBQWtCLFFBQVE7QUFBQSxVQUN4QixTQUFTO0FBQUEsVUFDVCxhQUFhLE1BQU0sdUJBQXVCLFVBQVU7QUFBQSxRQUN0RCxDQUFDO0FBQUEsTUFDSDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxZQUFNLEVBQUUsWUFBWSxHQUFHLE9BQU8sSUFBSSxrQkFBa0IsY0FBYyxJQUFJO0FBQ3RFLFlBQU0sRUFBRSxjQUFjLElBQUksTUFBTTtBQUFBLFFBQzlCO0FBQUEsTUFDRjtBQUNBLGFBQU87QUFBQSxRQUNMLGNBQWMsUUFBUTtBQUFBLFVBQ3BCLFNBQVM7QUFBQSxVQUNULGFBQWEsTUFBTSx1QkFBdUIsVUFBVTtBQUFBLFFBQ3RELENBQUM7QUFBQSxNQUNIO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFVQSxRQUFNLGtCQUFrQixFQUFFLEtBQUs7QUFBQSxJQUM3QjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRixDQUFDO0FBRUQsUUFBTSx1QkFBdUIsRUFBRSxPQUFPO0FBQUEsSUFDcEMsWUFBWSxFQUFFLE9BQU8sRUFBRSxTQUFTO0FBQUEsSUFDaEMsVUFBVTtBQUFBO0FBQUE7QUFBQSxJQUdWLFNBQVMsRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksR0FBRyw0Q0FBNEM7QUFBQSxJQUM5RSxZQUFZLEVBQUUsT0FBTyxFQUFFLElBQUksR0FBRyxFQUFFLElBQUksSUFBSSxFQUFFLFNBQVM7QUFBQSxJQUNuRCxNQUFNLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxFQUFFLFNBQVM7QUFBQSxJQUNuQyxPQUFPLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxJQUMzQixrQkFBa0IsRUFBRSxPQUFPLEVBQUUsT0FBTyxHQUFHLEVBQUUsUUFBUSxDQUFDLEVBQUUsU0FBUztBQUFBLEVBQy9ELENBQUM7QUFDRCxRQUFNLHVCQUF1QjtBQUFBLElBQzNCLFlBQVksRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMscUVBQXFFO0FBQUEsSUFDaEgsVUFBVSxnQkFBZ0IsU0FBUyxpQkFBaUI7QUFBQSxJQUNwRCxTQUFTLEVBQUUsT0FBTyxFQUFFLFNBQVMseUNBQXlDO0FBQUEsSUFDdEUsWUFBWSxFQUFFLE9BQU8sRUFBRSxJQUFJLEdBQUcsRUFBRSxJQUFJLElBQUksRUFBRSxTQUFTLEVBQUUsU0FBUyx1QkFBdUI7QUFBQSxJQUNyRixNQUFNLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxFQUFFLFNBQVMsRUFBRSxTQUFTLGdCQUFnQjtBQUFBLElBQzlELE9BQU8sRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMsbUNBQW1DO0FBQUEsSUFDekUsa0JBQWtCLEVBQUUsT0FBTyxFQUFFLE9BQU8sR0FBRyxFQUFFLFFBQVEsQ0FBQyxFQUFFLFNBQVMsRUFBRSxTQUFTLG1EQUFtRDtBQUFBLEVBQzdIO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsT0FBTyxTQUFrQztBQUN2QyxZQUFNLEVBQUUsWUFBWSxHQUFHLE9BQU8sSUFBSSxrQkFBa0Isc0JBQXNCLElBQUk7QUFDOUUsWUFBTSx5QkFBeUIsdUJBQXVCLFVBQVU7QUFDaEUsYUFBTyxpQ0FBaUMsWUFBWSxZQUFZO0FBQzlELGNBQU0sRUFBRSxxQkFBcUIsSUFBSSxNQUFNO0FBQUEsVUFDckM7QUFBQSxRQUNGO0FBQ0EsZUFBTyxxQkFBcUIsTUFBTTtBQUFBLE1BQ3BDLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRjtBQUVBLFFBQU0sb0JBQW9CLEVBQUUsT0FBTztBQUFBLElBQ2pDLFlBQVksRUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBO0FBQUE7QUFBQSxJQUdoQyxPQUFPLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxJQUFJLEdBQUcscUNBQXFDO0FBQUEsSUFDckUsR0FBRyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLEVBQUUsU0FBUztBQUFBLElBQzVDLFVBQVUsZ0JBQWdCLFNBQVM7QUFBQSxJQUNuQyxPQUFPLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxJQUMzQixLQUFLLEVBQUUsT0FBTyxFQUFFLFNBQVM7QUFBQSxJQUN6QixvQkFBb0IsRUFBRSxRQUFRLEVBQUUsU0FBUztBQUFBLElBQ3pDLGdCQUFnQixFQUFFLFFBQVEsRUFBRSxTQUFTO0FBQUEsRUFDdkMsQ0FBQztBQUNELFFBQU0sb0JBQW9CO0FBQUEsSUFDeEIsWUFBWSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxxRUFBcUU7QUFBQSxJQUNoSCxPQUFPLEVBQUUsT0FBTyxFQUFFLFNBQVMsK0JBQStCO0FBQUEsSUFDMUQsR0FBRyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLEVBQUUsU0FBUyxFQUFFLFNBQVMsa0NBQWtDO0FBQUEsSUFDekYsVUFBVSxnQkFBZ0IsU0FBUyxFQUFFLFNBQVMsK0JBQStCO0FBQUEsSUFDN0UsT0FBTyxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyx1Q0FBdUM7QUFBQSxJQUM3RSxLQUFLLEVBQUUsT0FBTyxFQUFFLFNBQVMsRUFBRSxTQUFTLDhDQUE4QztBQUFBLElBQ2xGLG9CQUFvQixFQUFFLFFBQVEsRUFBRSxTQUFTLEVBQUUsU0FBUyw2Q0FBNkM7QUFBQSxJQUNqRyxnQkFBZ0IsRUFBRSxRQUFRLEVBQUUsU0FBUyxFQUFFLFNBQVMsMERBQTBEO0FBQUEsRUFDNUc7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLFlBQU0sRUFBRSxZQUFZLEdBQUcsT0FBTyxJQUFJLGtCQUFrQixtQkFBbUIsSUFBSTtBQUMzRSxhQUFPLGlDQUFpQyxZQUFZLFlBQVk7QUFDOUQsY0FBTSxFQUFFLG1CQUFtQixJQUFJLE1BQU07QUFBQSxVQUNuQztBQUFBLFFBQ0Y7QUFDQSxlQUFPLG1CQUFtQixNQUFNO0FBQUEsTUFDbEMsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGO0FBRUEsUUFBTSxvQkFBb0IsRUFBRSxPQUFPO0FBQUEsSUFDakMsWUFBWSxFQUFFLE9BQU8sRUFBRSxTQUFTO0FBQUEsSUFDaEMsTUFBTSxFQUFFLEtBQUssQ0FBQyxTQUFTLE9BQU8sQ0FBQztBQUFBLElBQy9CLFVBQVUsRUFBRSxPQUFPLEVBQUUsU0FBUztBQUFBLElBQzlCLE9BQU8sRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxFQUFFLElBQUksQ0FBQyxFQUFFLFNBQVM7QUFBQSxJQUMvQyxLQUFLLEVBQUUsS0FBSyxDQUFDLGNBQWMsY0FBYyxlQUFlLGNBQWMsWUFBWSxDQUFDLEVBQUUsU0FBUztBQUFBLEVBQ2hHLENBQUMsRUFBRTtBQUFBLElBQ0QsQ0FBQyxRQUFRLElBQUksU0FBUyxXQUFZLE9BQU8sSUFBSSxhQUFhLFlBQVksSUFBSSxTQUFTLEtBQUssRUFBRSxTQUFTO0FBQUEsSUFDbkcsRUFBRSxTQUFTLDhEQUE4RCxNQUFNLENBQUMsVUFBVSxFQUFFO0FBQUEsRUFDOUY7QUFDQSxRQUFNLG9CQUFvQjtBQUFBLElBQ3hCLFlBQVksRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFNBQVMscUVBQXFFO0FBQUEsSUFDaEgsTUFBTSxFQUFFLEtBQUssQ0FBQyxTQUFTLE9BQU8sQ0FBQyxFQUFFLFNBQVMsOERBQThEO0FBQUEsSUFDeEcsVUFBVSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsU0FBUyxzQ0FBc0M7QUFBQSxJQUMvRSxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsRUFBRSxJQUFJLENBQUMsRUFBRSxTQUFTLEVBQUUsU0FBUyxtQ0FBbUM7QUFBQSxJQUM3RixLQUFLLEVBQUUsS0FBSyxDQUFDLGNBQWMsY0FBYyxlQUFlLGNBQWMsWUFBWSxDQUFDLEVBQUUsU0FBUyxFQUFFLFNBQVMsNENBQTRDO0FBQUEsRUFDdko7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxPQUFPLFNBQWtDO0FBQ3ZDLFlBQU0sRUFBRSxZQUFZLEdBQUcsT0FBTyxJQUFJLGtCQUFrQixtQkFBbUIsSUFBSTtBQUMzRSxhQUFPLGlDQUFpQyxZQUFZLFlBQVk7QUFDOUQsY0FBTSxFQUFFLGdCQUFnQixJQUFJLE1BQU07QUFBQSxVQUNoQztBQUFBLFFBQ0Y7QUFDQSxlQUFPLGdCQUFnQixNQUFNO0FBQUEsTUFDL0IsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGO0FBQ0Y7IiwKICAibmFtZXMiOiBbInJlc29sdmUiXQp9Cg==
