import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { getIsolationMode } from "../preferences.js";
import { compileSubagentPermissionContract } from "../unit-context-manifest.js";
import { logWarning } from "../workflow-logger.js";
import { isGsdWorktreePath, resolveWorktreeProjectRoot } from "../worktree-root.js";
const MILESTONE_CONTEXT_RE = /M\d+(?:-[a-z0-9]{6})?-CONTEXT\.md$/;
const CONTEXT_MILESTONE_RE = /(?:^|[/\\])(M\d+(?:-[a-z0-9]{6})?)-CONTEXT\.md$/i;
const DEPTH_VERIFICATION_MILESTONE_RE = /depth_verification[_-](M\d+(?:-[a-z0-9]{6})?)/i;
const GSD_DIR_RE = /(^|[/\\])\.gsd([/\\]|$)/;
const QUEUE_SAFE_TOOLS = /* @__PURE__ */ new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  // Discussion & planning tools
  "ask_user_questions",
  "gsd_milestone_generate_id",
  "gsd_summary_save",
  // Web research tools used during queue discussion
  "search-the-web",
  "resolve_library",
  "get_library_docs",
  "fetch_page",
  "search_and_read"
]);
const BASH_READ_ONLY_RE = /^\s*(cat|head|tail|less|more|wc|file|stat|du|df|which|type|echo|printf|ls|find|grep|rg|awk|sed\b(?!.*-i)|sort|uniq|diff|comm|tr|cut|tee\s+-a\s+\/dev\/null|git\s+(log|show|diff|status|branch|tag|remote|rev-parse|ls-files|blame|shortlog|describe|stash\s+list|config\s+--get|cat-file)|gh\s+(issue|pr|api|repo|release)\s+(view|list|diff|status|checks)|mkdir\s+-p\s+\.gsd|rtk\s|npm\s+run\s+(test|test:\w+|lint|lint:\w+|typecheck|type-check|type-check:\w+|check|verify|audit|outdated|format:check|ci|validate)\b|npm\s+(ls|list|info|view|show|outdated|audit|explain|doctor|ping|--version|-v)\b|npx\s|tsx\s|node\s+(--print|--version|-v\b)|python[23]?\s+(-c\s+'[^']*'|--version|-V\b|-m\s+(pip\s+show|pip\s+list|site))|pip[23]?\s+(show|list|freeze|check|index\s+versions)\b|jq\s|yq\s|curl\s+(-s\b|--silent\b)(?!\s+[^|>]*\s-[oO]\b)(?!\s+[^|>]*\s--output\b)[^|>]*$|openssl\s+(version|x509|s_client)|env\b|printenv\b|true\b|false\b)/;
const BASH_VERIFICATION_RE = /^\s*(npm\s+(run\s+(build|test|test:\w+|lint|lint:\w+|typecheck|type-check|verify|ci|validate)\b|test\b)|pnpm\s+(build|test|lint|typecheck|verify)\b|yarn\s+(build|test|lint|typecheck|verify)\b|vitest\b|jest\b|go\s+test\b)/;
function createEmptyWriteGateState() {
  return {
    verifiedDepthMilestones: /* @__PURE__ */ new Set(),
    verifiedApprovalGates: /* @__PURE__ */ new Set(),
    activeQueuePhase: false,
    pendingGateId: null
  };
}
const writeGateStatesByBasePath = /* @__PURE__ */ new Map();
function writeGateStateKey(basePath) {
  return resolve(basePath);
}
function getWriteGateState(basePath = process.cwd()) {
  const key = writeGateStateKey(basePath);
  let state = writeGateStatesByBasePath.get(key);
  if (!state) {
    state = createEmptyWriteGateState();
    writeGateStatesByBasePath.set(key, state);
  }
  return state;
}
const GATE_QUESTION_PATTERNS = [
  "depth_verification"
];
const GATE_SAFE_TOOLS = /* @__PURE__ */ new Set([
  "ask_user_questions"
]);
function canonicalToolName(toolName) {
  if (!toolName.startsWith("mcp__")) return toolName;
  const toolSeparator = toolName.indexOf("__", "mcp__".length);
  return toolSeparator >= 0 ? toolName.slice(toolSeparator + 2) : toolName;
}
function shouldPersistWriteGateSnapshot(env = process.env) {
  const v = env.GSD_PERSIST_WRITE_GATE_STATE;
  return v !== "0" && v !== "false";
}
function writeGateSnapshotPath(basePath) {
  return join(basePath, ".gsd", "runtime", "write-gate-state.json");
}
function ensureWriteGateSnapshotDirectory(basePath) {
  const gsdPath = join(basePath, ".gsd");
  if (!existsSync(gsdPath)) {
    try {
      const stat = lstatSync(gsdPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(gsdPath);
        mkdirSync(isAbsolute(target) ? target : resolve(basePath, target), { recursive: true });
      }
    } catch {
    }
  }
  mkdirSync(join(gsdPath, "runtime"), { recursive: true });
}
function currentWriteGateSnapshot(basePath = process.cwd()) {
  const state = getWriteGateState(basePath);
  return {
    verifiedDepthMilestones: [...state.verifiedDepthMilestones].sort(),
    verifiedApprovalGates: [...state.verifiedApprovalGates].sort(),
    activeQueuePhase: state.activeQueuePhase,
    pendingGateId: state.pendingGateId
  };
}
function persistWriteGateSnapshot(basePath) {
  if (!shouldPersistWriteGateSnapshot()) return;
  const path = writeGateSnapshotPath(basePath);
  ensureWriteGateSnapshotDirectory(basePath);
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tempPath, JSON.stringify(currentWriteGateSnapshot(basePath), null, 2), "utf-8");
  try {
    renameSync(tempPath, path);
  } catch (err) {
    if (err instanceof Error && err.code === "EXDEV") {
      copyFileSync(tempPath, path);
      unlinkSync(tempPath);
    } else {
      throw err;
    }
  }
}
function clearPersistedWriteGateSnapshot(basePath) {
  if (!shouldPersistWriteGateSnapshot()) return;
  const path = writeGateSnapshotPath(basePath);
  try {
    unlinkSync(path);
  } catch {
  }
}
function normalizeWriteGateSnapshot(value) {
  const record = value && typeof value === "object" ? value : {};
  const verified = Array.isArray(record.verifiedDepthMilestones) ? record.verifiedDepthMilestones.filter((item) => typeof item === "string") : [];
  const verifiedGates = Array.isArray(record.verifiedApprovalGates) ? record.verifiedApprovalGates.filter((item) => typeof item === "string") : [];
  return {
    verifiedDepthMilestones: [...new Set(verified)].sort(),
    verifiedApprovalGates: [...new Set(verifiedGates)].sort(),
    activeQueuePhase: record.activeQueuePhase === true,
    pendingGateId: typeof record.pendingGateId === "string" ? record.pendingGateId : null
  };
}
const EMPTY_SNAPSHOT = {
  verifiedDepthMilestones: [],
  verifiedApprovalGates: [],
  activeQueuePhase: false,
  pendingGateId: null
};
function loadWriteGateSnapshot(basePath) {
  const path = writeGateSnapshotPath(basePath);
  if (!existsSync(path)) {
    if (shouldPersistWriteGateSnapshot()) return EMPTY_SNAPSHOT;
    return currentWriteGateSnapshot(basePath);
  }
  try {
    return normalizeWriteGateSnapshot(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return currentWriteGateSnapshot(basePath);
  }
}
function isDepthVerified(basePath = process.cwd()) {
  return getWriteGateState(basePath).verifiedDepthMilestones.size > 0;
}
function isMilestoneDepthVerified(milestoneId, basePath = process.cwd()) {
  if (!milestoneId) return false;
  return getWriteGateState(basePath).verifiedDepthMilestones.has(milestoneId);
}
function isMilestoneDepthVerifiedInSnapshot(snapshot, milestoneId) {
  if (!milestoneId) return false;
  return snapshot.verifiedDepthMilestones.includes(milestoneId);
}
function isQueuePhaseActive(basePath = process.cwd()) {
  return getWriteGateState(basePath).activeQueuePhase;
}
function setQueuePhaseActive(active, basePath) {
  getWriteGateState(basePath).activeQueuePhase = active;
  persistWriteGateSnapshot(basePath);
}
function resetWriteGateState(basePath) {
  const state = getWriteGateState(basePath);
  state.verifiedDepthMilestones.clear();
  state.verifiedApprovalGates.clear();
  state.pendingGateId = null;
  persistWriteGateSnapshot(basePath);
}
function clearDiscussionFlowState(basePath) {
  writeGateStatesByBasePath.delete(writeGateStateKey(basePath));
  clearPersistedWriteGateSnapshot(basePath);
}
function markDepthVerified(milestoneId, basePath = process.cwd()) {
  if (!milestoneId) return;
  getWriteGateState(basePath).verifiedDepthMilestones.add(milestoneId);
  persistWriteGateSnapshot(basePath);
}
function markApprovalGateVerified(gateId, basePath = process.cwd()) {
  if (!gateId) return;
  getWriteGateState(basePath).verifiedApprovalGates.add(gateId);
  persistWriteGateSnapshot(basePath);
}
function isApprovalGateVerifiedInSnapshot(snapshot, gateId) {
  if (!gateId) return false;
  return (snapshot.verifiedApprovalGates ?? []).includes(gateId);
}
function isGateQuestionId(questionId) {
  return GATE_QUESTION_PATTERNS.some((pattern) => questionId.includes(pattern));
}
function extractDepthVerificationMilestoneId(questionId) {
  const match = questionId.match(DEPTH_VERIFICATION_MILESTONE_RE);
  return match?.[1] ?? null;
}
function extractContextMilestoneId(inputPath) {
  const match = inputPath.match(CONTEXT_MILESTONE_RE);
  return match?.[1] ?? null;
}
function setPendingGate(gateId, basePath) {
  const state = getWriteGateState(basePath);
  state.pendingGateId = gateId;
  state.verifiedApprovalGates.delete(gateId);
  const milestoneId = extractDepthVerificationMilestoneId(gateId);
  if (milestoneId) state.verifiedDepthMilestones.delete(milestoneId);
  persistWriteGateSnapshot(basePath);
}
function clearPendingGate(basePath) {
  getWriteGateState(basePath).pendingGateId = null;
  persistWriteGateSnapshot(basePath);
}
function getPendingGate(basePath = process.cwd()) {
  return getWriteGateState(basePath).pendingGateId;
}
function shouldBlockPendingGate(toolName, milestoneId, queuePhaseActive, basePath = process.cwd()) {
  return shouldBlockPendingGateInSnapshot(currentWriteGateSnapshot(basePath), toolName, milestoneId, queuePhaseActive);
}
function shouldBlockPendingGateInSnapshot(snapshot, toolName, _milestoneId, _queuePhaseActive) {
  if (!snapshot.pendingGateId) return { block: false };
  if (GATE_SAFE_TOOLS.has(canonicalToolName(toolName))) return { block: false };
  return {
    block: true,
    reason: [
      `HARD BLOCK: Discussion gate "${snapshot.pendingGateId}" has not been confirmed by the user.`,
      `The assistant already asked for user confirmation, so do not call more tools.`,
      `Wait for the user's answer, or re-call ask_user_questions with the gate question if the question was not delivered.`,
      `If the previous ask_user_questions call failed, errored, was cancelled, or the user's response`,
      `did not match a provided option, you MUST re-ask \u2014 never rationalize past the block.`,
      `Do NOT proceed, do NOT use alternative approaches, do NOT skip the gate.`
    ].join(" ")
  };
}
function shouldBlockPendingGateBash(command, milestoneId, queuePhaseActive, basePath = process.cwd()) {
  return shouldBlockPendingGateBashInSnapshot(currentWriteGateSnapshot(basePath), command, milestoneId, queuePhaseActive);
}
function shouldBlockPendingGateBashInSnapshot(snapshot, command, _milestoneId, _queuePhaseActive) {
  if (!snapshot.pendingGateId) return { block: false };
  return {
    block: true,
    reason: [
      `HARD BLOCK: Discussion gate "${snapshot.pendingGateId}" has not been confirmed by the user.`,
      `The assistant already asked for user confirmation, so do not run bash commands.`,
      `Wait for the user's answer, or re-call ask_user_questions with the gate question if the question was not delivered.`,
      `If the previous ask_user_questions call failed, errored, was cancelled, or the user's response`,
      `did not match a provided option, you MUST re-ask \u2014 never rationalize past the block.`
    ].join(" ")
  };
}
function isDepthConfirmationAnswer(selected, options) {
  const value = Array.isArray(selected) ? selected[0] : selected;
  if (typeof value !== "string" || !value) return false;
  if (Array.isArray(options) && options.length > 0) {
    const confirmLabel = options[0]?.label;
    return typeof confirmLabel === "string" && value === confirmLabel;
  }
  return false;
}
function shouldBlockContextWrite(toolName, inputPath, milestoneId, _queuePhaseActive, basePath = process.cwd()) {
  if (toolName !== "write") return { block: false };
  if (!MILESTONE_CONTEXT_RE.test(inputPath)) return { block: false };
  const targetMilestoneId = extractContextMilestoneId(inputPath) ?? milestoneId;
  if (!targetMilestoneId) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: Cannot write milestone CONTEXT.md without knowing which milestone it belongs to.`,
        `This is a mechanical gate \u2014 you MUST NOT proceed, retry, or rationalize past this block.`,
        `Required action: call ask_user_questions with question id containing "depth_verification" and the milestone id.`
      ].join(" ")
    };
  }
  if (isMilestoneDepthVerified(targetMilestoneId, basePath)) return { block: false };
  return {
    block: true,
    reason: [
      `HARD BLOCK: Cannot write to milestone CONTEXT.md without depth verification.`,
      `This is a mechanical gate \u2014 you MUST NOT proceed, retry, or rationalize past this block.`,
      `Required action: call ask_user_questions with question id containing "depth_verification".`,
      `The user MUST select the "(Recommended)" confirmation option to unlock this gate.`,
      `If the user declines, cancels, or the tool fails, you must re-ask \u2014 not bypass.`
    ].join(" ")
  };
}
function shouldBlockContextArtifactSave(artifactType, milestoneId, sliceId, basePath = process.cwd()) {
  return shouldBlockContextArtifactSaveInSnapshot(currentWriteGateSnapshot(basePath), artifactType, milestoneId, sliceId);
}
function shouldBlockContextArtifactSaveInSnapshot(snapshot, artifactType, milestoneId, sliceId) {
  if (artifactType !== "CONTEXT") return { block: false };
  if (sliceId) return { block: false };
  if (!milestoneId) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: Cannot save milestone CONTEXT without a milestone_id.`,
        `This is a mechanical gate \u2014 you MUST NOT proceed, retry, or rationalize past this block.`
      ].join(" ")
    };
  }
  if (isMilestoneDepthVerifiedInSnapshot(snapshot, milestoneId)) return { block: false };
  return {
    block: true,
    reason: [
      `HARD BLOCK: Cannot save milestone CONTEXT without depth verification for ${milestoneId}.`,
      `This is a mechanical gate \u2014 you MUST NOT proceed, retry, or rationalize past this block.`,
      `Required action: call ask_user_questions with question id containing "depth_verification_${milestoneId}".`,
      `The user MUST select the "(Recommended)" confirmation option to unlock this gate.`
    ].join(" ")
  };
}
const FINAL_ROOT_ARTIFACTS = /* @__PURE__ */ new Set(["PROJECT", "REQUIREMENTS"]);
function requiredRootApprovalGateForArtifact(artifactType) {
  if (artifactType === "PROJECT") return "depth_verification_project_confirm";
  if (artifactType === "REQUIREMENTS") return "depth_verification_requirements_confirm";
  return null;
}
function shouldBlockRootArtifactSaveInSnapshot(snapshot, artifactType, opts = {}) {
  if (!FINAL_ROOT_ARTIFACTS.has(artifactType)) return { block: false };
  if (snapshot.pendingGateId) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: Cannot save ${artifactType}.md because discussion gate "${snapshot.pendingGateId}" has not been confirmed by the user.`,
        `This is a mechanical gate \u2014 wait for explicit user approval before writing final project setup artifacts.`,
        `If approval was requested in plain text, the user must reply with explicit approval before this write is allowed.`
      ].join(" ")
    };
  }
  if (opts.requireVerifiedApproval) {
    const requiredGate = requiredRootApprovalGateForArtifact(artifactType);
    if (requiredGate && !isApprovalGateVerifiedInSnapshot(snapshot, requiredGate)) {
      return {
        block: true,
        reason: [
          `HARD BLOCK: Cannot save ${artifactType}.md before explicit approval gate "${requiredGate}" is verified.`,
          `Deep planning root artifacts are fail-closed: absence of a pending gate is not approval.`,
          `Ask the user to confirm the ${artifactType}.md preview and wait for an explicit approval response.`
        ].join(" ")
      };
    }
  }
  return { block: false };
}
function shouldBlockQueueExecution(toolName, input, queuePhaseActive) {
  return shouldBlockQueueExecutionInSnapshot(currentWriteGateSnapshot(), toolName, input, queuePhaseActive);
}
function shouldBlockQueueExecutionInSnapshot(snapshot, toolName, input, queuePhaseActive = snapshot.activeQueuePhase) {
  if (!queuePhaseActive) return { block: false };
  if (QUEUE_SAFE_TOOLS.has(toolName)) return { block: false };
  if (toolName === "write" || toolName === "edit") {
    if (GSD_DIR_RE.test(input)) return { block: false };
    return {
      block: true,
      reason: `Blocked: /gsd queue is a planning tool \u2014 it creates milestones, not executes work. Cannot ${toolName} to "${input}" during queue mode. Write CONTEXT.md files and update PROJECT.md/QUEUE.md instead.`
    };
  }
  if (toolName === "bash") {
    if (BASH_READ_ONLY_RE.test(input)) return { block: false };
    return {
      block: true,
      reason: `Blocked: /gsd queue is a planning tool \u2014 it creates milestones, not executes work. Cannot run "${input.slice(0, 80)}${input.length > 80 ? "\u2026" : ""}" during queue mode. Use read-only commands (cat, grep, git log, etc.) to investigate, then write planning artifacts.`
    };
  }
  return {
    block: true,
    reason: `Blocked: /gsd queue is a planning tool \u2014 it creates milestones, not executes work. Unknown tools are not permitted during queue mode.`
  };
}
const PLANNING_WRITE_TOOLS = /* @__PURE__ */ new Set(["write", "edit", "multi_edit", "notebook_edit"]);
const PLANNING_SUBAGENT_TOOLS = /* @__PURE__ */ new Set(["subagent", "task"]);
const PLANNING_DISPATCH_AGENT_REGISTRY = {
  scout: { readOnlySpecialist: true },
  planner: { readOnlySpecialist: true },
  reviewer: { readOnlySpecialist: true },
  security: { readOnlySpecialist: true },
  tester: { readOnlySpecialist: true }
};
const ALLOWED_PLANNING_DISPATCH_AGENTS = new Set(
  Object.entries(PLANNING_DISPATCH_AGENT_REGISTRY).filter(([, metadata]) => metadata.readOnlySpecialist).map(([agentId]) => agentId)
);
let warnedMissingPlanningDispatchAgentClasses = false;
function isReadOnlySpecialist(agentId) {
  const metadata = PLANNING_DISPATCH_AGENT_REGISTRY[agentId];
  return metadata?.readOnlySpecialist === true;
}
function allowedPlanningDispatchAgentsList() {
  return [...ALLOWED_PLANNING_DISPATCH_AGENTS].join(", ");
}
function warnMissingPlanningDispatchAgentClasses(unitType, mode, toolName) {
  if (warnedMissingPlanningDispatchAgentClasses) return;
  warnedMissingPlanningDispatchAgentClasses = true;
  const message = `[write-gate] planning-dispatch: shouldBlockPlanningUnit called for tool "${toolName}" on unit "${unitType}" without agentClasses - stale caller; blocking dispatch.`;
  console.warn(message);
  logWarning("intercept", message, {
    unitType,
    mode,
    toolName
  });
}
const PLANNING_SAFE_TOOLS = /* @__PURE__ */ new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "ask_user_questions",
  "search-the-web",
  "resolve_library",
  "get_library_docs",
  "fetch_page",
  "search_and_read"
]);
function isPathUnderGsd(absPath, basePath) {
  const gsdRoot = resolve(basePath, ".gsd");
  const rel = relative(gsdRoot, absPath);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function matchesAllowedGlob(absPath, basePath, globs) {
  const rel = relative(basePath, absPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  const posix = rel.split(sep).join("/");
  return globs.some((g) => minimatch(posix, g, { dot: false, nocase: false }));
}
function blockReason(unitType, mode, what) {
  return [
    `HARD BLOCK: unit "${unitType}" runs under tools-policy "${mode}" \u2014 ${what}.`,
    `This is a mechanical gate enforced by manifest.tools (#4934). You MUST NOT proceed,`,
    `retry the same call, or rationalize past this block. If you need to write user source,`,
    `the work belongs in execute-task, not in a planning unit.`
  ].join(" ");
}
function shouldBlockPlanningUnit(toolName, pathOrCommand, basePath, unitType, policy, agentClasses) {
  if (!policy) return { block: false };
  if (policy.mode === "all") return { block: false };
  const tool = toolName;
  if (policy.mode === "read-only") {
    if (PLANNING_SAFE_TOOLS.has(tool)) return { block: false };
    if (tool.startsWith("gsd_")) return { block: false };
    if (PLANNING_WRITE_TOOLS.has(tool) || tool === "bash" || PLANNING_SUBAGENT_TOOLS.has(tool)) {
      return { block: true, reason: blockReason(unitType, policy.mode, `${tool} is not permitted (read-only)`) };
    }
    return { block: true, reason: blockReason(unitType, policy.mode, `tool "${tool}" is not on the read-only allowlist`) };
  }
  if (PLANNING_SAFE_TOOLS.has(tool)) return { block: false };
  if (tool.startsWith("gsd_")) return { block: false };
  if (PLANNING_SUBAGENT_TOOLS.has(tool)) {
    if (policy.mode === "planning-dispatch") {
      const requested = (agentClasses ?? []).map((a) => a.trim()).filter(Boolean);
      const dispatchContract = compileSubagentPermissionContract(policy);
      const allowedSubagents = dispatchContract.allowedSubagents;
      const allowed = new Set(allowedSubagents);
      if (agentClasses === void 0) {
        warnMissingPlanningDispatchAgentClasses(unitType, policy.mode, tool);
        return {
          block: true,
          reason: blockReason(
            unitType,
            policy.mode,
            `subagent dispatch blocked: stale caller did not supply agent identities for "${tool}"; update extractSubagentAgentClasses to handle this input shape`
          )
        };
      }
      if (requested.length === 0) {
        return { block: false };
      }
      const globallyDisallowed = requested.find((a) => !isReadOnlySpecialist(a));
      if (globallyDisallowed) {
        return {
          block: true,
          reason: blockReason(
            unitType,
            policy.mode,
            `subagent dispatch of "${globallyDisallowed}" not permitted; only read-only specialists (${allowedPlanningDispatchAgentsList()}) may be dispatched from planning-dispatch units`
          )
        };
      }
      const disallowedByPolicy = requested.find((a) => !allowed.has(a));
      if (disallowedByPolicy) {
        return {
          block: true,
          reason: blockReason(
            unitType,
            policy.mode,
            `subagent dispatch of "${disallowedByPolicy}" not permitted by ToolsPolicy.allowedSubagents; permitted agents for this unit: ${allowedSubagents.join(", ")}`
          )
        };
      }
      return { block: false };
    }
    return { block: true, reason: blockReason(unitType, policy.mode, `subagent dispatch is not permitted in planning units`) };
  }
  if (tool === "bash") {
    if (policy.mode === "verification") {
      if (BASH_VERIFICATION_RE.test(pathOrCommand) || BASH_READ_ONLY_RE.test(pathOrCommand)) return { block: false };
      return {
        block: true,
        reason: blockReason(
          unitType,
          policy.mode,
          `bash is restricted to build/test verification commands (npm run build, npm test, etc.); cannot run "${pathOrCommand.slice(0, 80)}${pathOrCommand.length > 80 ? "\u2026" : ""}"`
        )
      };
    }
    if (BASH_READ_ONLY_RE.test(pathOrCommand)) return { block: false };
    return {
      block: true,
      reason: blockReason(
        unitType,
        policy.mode,
        `bash is restricted to read-only commands (cat/grep/git log/etc); cannot run "${pathOrCommand.slice(0, 80)}${pathOrCommand.length > 80 ? "\u2026" : ""}"`
      )
    };
  }
  if (PLANNING_WRITE_TOOLS.has(tool)) {
    if (!pathOrCommand) {
      return { block: true, reason: blockReason(unitType, policy.mode, `${tool} called with empty path`) };
    }
    const absPath = isAbsolute(pathOrCommand) ? pathOrCommand : resolve(basePath, pathOrCommand);
    if (isPathUnderGsd(absPath, basePath)) return { block: false };
    if (policy.mode === "docs" && matchesAllowedGlob(absPath, basePath, policy.allowedPathGlobs)) {
      return { block: false };
    }
    return {
      block: true,
      reason: blockReason(
        unitType,
        policy.mode,
        `cannot ${tool} "${pathOrCommand}" \u2014 writes are restricted to .gsd/${policy.mode === "docs" ? " and " + policy.allowedPathGlobs.join(", ") : ""}`
      )
    };
  }
  return { block: false };
}
const WORKTREE_GATE_BOOTSTRAP_UNITS = /* @__PURE__ */ new Set([
  "discuss-milestone",
  "plan-milestone",
  "init"
]);
function realpathOrResolve(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    let dir = abs;
    const tail = [];
    while (dir && dir !== resolve(dir, "..")) {
      try {
        const real = realpathSync(dir);
        return tail.length ? join(real, ...tail.reverse()) : real;
      } catch {
        const idx = dir.lastIndexOf(sep);
        if (idx <= 0) break;
        tail.push(dir.slice(idx + 1));
        dir = dir.slice(0, idx) || sep;
      }
    }
    return abs;
  }
}
function isPathContained(target, container) {
  if (target === container) return true;
  return target.startsWith(container.endsWith(sep) ? container : container + sep);
}
function shouldBlockWorktreeWrite(toolName, targetPath, effectiveBasePath, isAutoLive, currentUnitType) {
  const tool = canonicalToolName(toolName);
  if (!PLANNING_WRITE_TOOLS.has(tool)) return { block: false };
  if (process.env.GSD_DISABLE_WORKTREE_WRITE_GUARD === "1") return { block: false };
  if (getIsolationMode(effectiveBasePath) !== "worktree") return { block: false };
  if (currentUnitType && WORKTREE_GATE_BOOTSTRAP_UNITS.has(currentUnitType)) return { block: false };
  if (!targetPath) {
    return {
      block: true,
      reason: [
        `HARD BLOCK: ${tool} called with empty path while \`git.isolation: worktree\` is configured`,
        `and auto-mode is not active. Refusing to allow writes that cannot be located.`
      ].join(" ")
    };
  }
  const projectRoot = resolveWorktreeProjectRoot(effectiveBasePath);
  const absTarget = isAbsolute(targetPath) ? targetPath : resolve(projectRoot, targetPath);
  const realTarget = realpathOrResolve(absTarget);
  const realRoot = realpathOrResolve(projectRoot);
  const realGsd = realpathOrResolve(join(projectRoot, ".gsd"));
  const realWorktreesDir = realpathOrResolve(join(projectRoot, ".gsd", "worktrees"));
  if (isPathContained(realTarget, realWorktreesDir)) return { block: false };
  if (isPathContained(realTarget, realGsd)) {
    const rel = relative(realGsd, realTarget);
    const firstSeg = rel.split(/[\/\\]/)[0] ?? "";
    if (!firstSeg.startsWith("worktrees")) return { block: false };
  }
  if (isAutoLive && isGsdWorktreePath(effectiveBasePath)) return { block: false };
  const displayTarget = isPathContained(realTarget, realRoot) ? relative(realRoot, realTarget) || "." : realTarget;
  return {
    block: true,
    reason: [
      `HARD BLOCK: Worktree isolation is configured (\`git.isolation: worktree\`) but auto-mode is`,
      `not running and the target "${displayTarget}" is not inside \`.gsd/worktrees/<MID>/\`.`,
      `Code edits at the project root would be lost \u2014 only the auto-mode commit pipeline`,
      `(auto-post-unit) commits work, and it never runs outside the loop.`,
      `Required action: start auto-mode with \`/gsd\` so the milestone worktree is created,`,
      `then write inside it. To disable this guard for self-hosting development, set`,
      `GSD_DISABLE_WORKTREE_WRITE_GUARD=1.`
    ].join(" ")
  };
}
export {
  ALLOWED_PLANNING_DISPATCH_AGENTS,
  MILESTONE_CONTEXT_RE,
  canonicalToolName,
  clearDiscussionFlowState,
  clearPendingGate,
  extractDepthVerificationMilestoneId,
  getPendingGate,
  isApprovalGateVerifiedInSnapshot,
  isDepthConfirmationAnswer,
  isDepthVerified,
  isGateQuestionId,
  isMilestoneDepthVerified,
  isMilestoneDepthVerifiedInSnapshot,
  isQueuePhaseActive,
  loadWriteGateSnapshot,
  markApprovalGateVerified,
  markDepthVerified,
  resetWriteGateState,
  setPendingGate,
  setQueuePhaseActive,
  shouldBlockContextArtifactSave,
  shouldBlockContextArtifactSaveInSnapshot,
  shouldBlockContextWrite,
  shouldBlockPendingGate,
  shouldBlockPendingGateBash,
  shouldBlockPendingGateBashInSnapshot,
  shouldBlockPendingGateInSnapshot,
  shouldBlockPlanningUnit,
  shouldBlockQueueExecution,
  shouldBlockQueueExecutionInSnapshot,
  shouldBlockRootArtifactSaveInSnapshot,
  shouldBlockWorktreeWrite
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvd3JpdGUtZ2F0ZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NEMiAtIFdyaXRlIGdhdGUgcnVudGltZSBwZXJzaXN0ZW5jZSBhbmQgcG9saWN5IGd1YXJkcy5cbmltcG9ydCB7IGNvcHlGaWxlU3luYywgZXhpc3RzU3luYywgbHN0YXRTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgcmVhZGxpbmtTeW5jLCByZWFscGF0aFN5bmMsIHJlbmFtZVN5bmMsIHVubGlua1N5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaXNBYnNvbHV0ZSwgam9pbiwgcmVsYXRpdmUsIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuaW1wb3J0IHsgbWluaW1hdGNoIH0gZnJvbSBcIm1pbmltYXRjaFwiO1xuXG5pbXBvcnQgeyBnZXRJc29sYXRpb25Nb2RlIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBjb21waWxlU3ViYWdlbnRQZXJtaXNzaW9uQ29udHJhY3QsIHR5cGUgVG9vbHNQb2xpY3kgfSBmcm9tIFwiLi4vdW5pdC1jb250ZXh0LW1hbmlmZXN0LmpzXCI7XG5pbXBvcnQgeyBsb2dXYXJuaW5nIH0gZnJvbSBcIi4uL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgaXNHc2RXb3JrdHJlZVBhdGgsIHJlc29sdmVXb3JrdHJlZVByb2plY3RSb290IH0gZnJvbSBcIi4uL3dvcmt0cmVlLXJvb3QuanNcIjtcblxuLyoqXG4gKiBSZWdleCBtYXRjaGluZyBtaWxlc3RvbmUgQ09OVEVYVC5tZCBmaWxlIG5hbWVzIGluIGJvdGggbGVnYWN5IE0wMDFcbiAqIGFuZCB1bmlxdWUgTTAwMS1hYmMxMjMgZm9ybWF0cy4gRXhwb3J0ZWQgc28gcmVnZXgtaGFyZGVuaW5nIHRlc3RzXG4gKiBjYW4gZXhlcmNpc2UgdGhlIHJlYWwgcGF0dGVybiByYXRoZXIgdGhhbiBhIGRyaWZ0LXByb25lIGlubGluZVxuICogcmUtaW1wbGVtZW50YXRpb24gKHNlZSAjNDgzNSkuXG4gKi9cbmV4cG9ydCBjb25zdCBNSUxFU1RPTkVfQ09OVEVYVF9SRSA9IC9NXFxkKyg/Oi1bYS16MC05XXs2fSk/LUNPTlRFWFRcXC5tZCQvO1xuY29uc3QgQ09OVEVYVF9NSUxFU1RPTkVfUkUgPSAvKD86XnxbL1xcXFxdKShNXFxkKyg/Oi1bYS16MC05XXs2fSk/KS1DT05URVhUXFwubWQkL2k7XG5jb25zdCBERVBUSF9WRVJJRklDQVRJT05fTUlMRVNUT05FX1JFID0gL2RlcHRoX3ZlcmlmaWNhdGlvbltfLV0oTVxcZCsoPzotW2EtejAtOV17Nn0pPykvaTtcblxuLyoqXG4gKiBQYXRoIHNlZ21lbnQgdGhhdCBpZGVudGlmaWVzIC5nc2QvIHBsYW5uaW5nIGFydGlmYWN0cy5cbiAqIFdyaXRlcyB0byB0aGVzZSBwYXRocyBhcmUgYWxsb3dlZCBkdXJpbmcgcXVldWUgbW9kZS5cbiAqL1xuY29uc3QgR1NEX0RJUl9SRSA9IC8oXnxbL1xcXFxdKVxcLmdzZChbL1xcXFxdfCQpLztcblxuLyoqXG4gKiBSZWFkLW9ubHkgdG9vbCBuYW1lcyB0aGF0IGFyZSBhbHdheXMgc2FmZSBkdXJpbmcgcXVldWUgbW9kZS5cbiAqL1xuY29uc3QgUVVFVUVfU0FGRV9UT09MUyA9IG5ldyBTZXQoW1xuICBcInJlYWRcIiwgXCJncmVwXCIsIFwiZmluZFwiLCBcImxzXCIsIFwiZ2xvYlwiLFxuICAvLyBEaXNjdXNzaW9uICYgcGxhbm5pbmcgdG9vbHNcbiAgXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgXCJnc2RfbWlsZXN0b25lX2dlbmVyYXRlX2lkXCIsXG4gIFwiZ3NkX3N1bW1hcnlfc2F2ZVwiLFxuICAvLyBXZWIgcmVzZWFyY2ggdG9vbHMgdXNlZCBkdXJpbmcgcXVldWUgZGlzY3Vzc2lvblxuICBcInNlYXJjaC10aGUtd2ViXCIsIFwicmVzb2x2ZV9saWJyYXJ5XCIsIFwiZ2V0X2xpYnJhcnlfZG9jc1wiLCBcImZldGNoX3BhZ2VcIixcbiAgXCJzZWFyY2hfYW5kX3JlYWRcIixcbl0pO1xuXG4vKipcbiAqIEJhc2ggY29tbWFuZHMgdGhhdCBhcmUgcmVhZC1vbmx5IC8gaW52ZXN0aWdhdGl2ZSBcdTIwMTQgc2FmZSBkdXJpbmcgcXVldWUgbW9kZS5cbiAqIE1hdGNoZXMgdGhlIGxlYWRpbmcgY29tbWFuZCBpbiBhIGJhc2ggaW52b2NhdGlvbi5cbiAqXG4gKiBFeHRlbnNpb24gcG9saWN5OiBhZGQgY29tbWFuZHMgaGVyZSB3aGVuIHRoZXkgYXJlIHJlYWQtb25seSAvIGRpYWdub3N0aWMuXG4gKiBOZXZlciBhZGQgY29tbWFuZHMgdGhhdCBtdXRhdGUgcHJvamVjdCBzdGF0ZSAod3JpdGUgZmlsZXMsIHJ1biBidWlsZHMgdGhhdFxuICogZW1pdCBhcnRpZmFjdHMsIGluc3RhbGwgcGFja2FnZXMsIGV0Yy4pLlxuICpcbiAqIEN1cnJlbnQgcmVhZC1vbmx5IGFkZGl0aW9ucyAoQnVnICM0Mzg1KTpcbiAqICAgbnBtIHJ1biA8ZGlhZ25vc3RpYz4gXHUyMDE0IHJlYWQtb25seSBkaWFnbm9zdGljIHNjcmlwdHM6IHRlc3QsIGxpbnQsIHR5cGVjaGVjaywgZXRjLlxuICogICAgICAgICAgICAgICAgICAgICAgICAgTk9UOiBidWlsZCwgaW5zdGFsbCwgY29tcGlsZSwgZ2VuZXJhdGUsIGRlcGxveSAoYXJ0aWZhY3QtcHJvZHVjaW5nKVxuICogICBucG0gbHMvbGlzdC9pbmZvICAgIFx1MjAxNCBpbnNwZWN0IGluc3RhbGxlZCBwYWNrYWdlcyAocmVhZC1vbmx5KVxuICogICBucG0gb3V0ZGF0ZWQvYXVkaXQgIFx1MjAxNCBzZWN1cml0eS91cGRhdGUgY2hlY2tzIChyZWFkLW9ubHkpXG4gKiAgIG5weCA8cGtnPiAgICAgICAgICAgXHUyMDE0IHJ1biBhIHBhY2thZ2UgYmluYXJ5IHdpdGhvdXQgaW5zdGFsbGluZyBnbG9iYWxseVxuICogICB0c3ggICAgICAgICAgICAgICAgIFx1MjAxNCBUeXBlU2NyaXB0IHJ1bm5lciB1c2VkIGZvciBkcnktcnVuIC8gaW5zcGVjdGlvbiBzY3JpcHRzXG4gKiAgIG5vZGUgLS1wcmludCAgICAgICAgXHUyMDE0IGV2YWx1YXRlIGFuZCBwcmludCBhbiBleHByZXNzaW9uLCBubyBzaWRlIGVmZmVjdHNcbiAqICAgcHl0aG9uIC8gcHl0aG9uMyAgICBcdTIwMTQgc2NyaXB0IGluc3BlY3Rpb24sIHZlcnNpb24gY2hlY2tzXG4gKiAgIHBpcCAvIHBpcDMgc2hvdyAgICAgXHUyMDE0IHNob3cgaW5zdGFsbGVkIHBhY2thZ2UgaW5mbyAocmVhZC1vbmx5KVxuICogICBqcSAgICAgICAgICAgICAgICAgIFx1MjAxNCByZWFkLW9ubHkgSlNPTiBxdWVyeVxuICogICB5cSAgICAgICAgICAgICAgICAgIFx1MjAxNCByZWFkLW9ubHkgWUFNTCBxdWVyeVxuICogICBjdXJsIC1zIC8gY3VybCAtLXNpbGVudCBcdTIwMTQgZmV0Y2ggZm9yIGluc3BlY3Rpb24gKG5vIC1vIC8gbm8gb3V0cHV0IHJlZGlyZWN0KVxuICogICBvcGVuc3NsIHZlcnNpb24gICAgIFx1MjAxNCB2ZXJzaW9uIC8gY2VydGlmaWNhdGUgaW5zcGVjdGlvblxuICogICBlbnYgLyBwcmludGVudiAgICAgIFx1MjAxNCBwcmludCBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAqICAgdHJ1ZSAvIGZhbHNlICAgICAgICBcdTIwMTQgc2hlbGwgbm8tb3BzIC8gdGVzdCBleGl0IGNvZGVzXG4gKi9cbmNvbnN0IEJBU0hfUkVBRF9PTkxZX1JFID0gL15cXHMqKGNhdHxoZWFkfHRhaWx8bGVzc3xtb3JlfHdjfGZpbGV8c3RhdHxkdXxkZnx3aGljaHx0eXBlfGVjaG98cHJpbnRmfGxzfGZpbmR8Z3JlcHxyZ3xhd2t8c2VkXFxiKD8hLiotaSl8c29ydHx1bmlxfGRpZmZ8Y29tbXx0cnxjdXR8dGVlXFxzKy1hXFxzK1xcL2RldlxcL251bGx8Z2l0XFxzKyhsb2d8c2hvd3xkaWZmfHN0YXR1c3xicmFuY2h8dGFnfHJlbW90ZXxyZXYtcGFyc2V8bHMtZmlsZXN8YmxhbWV8c2hvcnRsb2d8ZGVzY3JpYmV8c3Rhc2hcXHMrbGlzdHxjb25maWdcXHMrLS1nZXR8Y2F0LWZpbGUpfGdoXFxzKyhpc3N1ZXxwcnxhcGl8cmVwb3xyZWxlYXNlKVxccysodmlld3xsaXN0fGRpZmZ8c3RhdHVzfGNoZWNrcyl8bWtkaXJcXHMrLXBcXHMrXFwuZ3NkfHJ0a1xcc3xucG1cXHMrcnVuXFxzKyh0ZXN0fHRlc3Q6XFx3K3xsaW50fGxpbnQ6XFx3K3x0eXBlY2hlY2t8dHlwZS1jaGVja3x0eXBlLWNoZWNrOlxcdyt8Y2hlY2t8dmVyaWZ5fGF1ZGl0fG91dGRhdGVkfGZvcm1hdDpjaGVja3xjaXx2YWxpZGF0ZSlcXGJ8bnBtXFxzKyhsc3xsaXN0fGluZm98dmlld3xzaG93fG91dGRhdGVkfGF1ZGl0fGV4cGxhaW58ZG9jdG9yfHBpbmd8LS12ZXJzaW9ufC12KVxcYnxucHhcXHN8dHN4XFxzfG5vZGVcXHMrKC0tcHJpbnR8LS12ZXJzaW9ufC12XFxiKXxweXRob25bMjNdP1xccysoLWNcXHMrJ1teJ10qJ3wtLXZlcnNpb258LVZcXGJ8LW1cXHMrKHBpcFxccytzaG93fHBpcFxccytsaXN0fHNpdGUpKXxwaXBbMjNdP1xccysoc2hvd3xsaXN0fGZyZWV6ZXxjaGVja3xpbmRleFxccyt2ZXJzaW9ucylcXGJ8anFcXHN8eXFcXHN8Y3VybFxccysoLXNcXGJ8LS1zaWxlbnRcXGIpKD8hXFxzK1tefD5dKlxccy1bb09dXFxiKSg/IVxccytbXnw+XSpcXHMtLW91dHB1dFxcYilbXnw+XSokfG9wZW5zc2xcXHMrKHZlcnNpb258eDUwOXxzX2NsaWVudCl8ZW52XFxifHByaW50ZW52XFxifHRydWVcXGJ8ZmFsc2VcXGIpLztcbmNvbnN0IEJBU0hfVkVSSUZJQ0FUSU9OX1JFID0gL15cXHMqKG5wbVxccysocnVuXFxzKyhidWlsZHx0ZXN0fHRlc3Q6XFx3K3xsaW50fGxpbnQ6XFx3K3x0eXBlY2hlY2t8dHlwZS1jaGVja3x2ZXJpZnl8Y2l8dmFsaWRhdGUpXFxifHRlc3RcXGIpfHBucG1cXHMrKGJ1aWxkfHRlc3R8bGludHx0eXBlY2hlY2t8dmVyaWZ5KVxcYnx5YXJuXFxzKyhidWlsZHx0ZXN0fGxpbnR8dHlwZWNoZWNrfHZlcmlmeSlcXGJ8dml0ZXN0XFxifGplc3RcXGJ8Z29cXHMrdGVzdFxcYikvO1xuXG5pbnRlcmZhY2UgSW5NZW1vcnlXcml0ZUdhdGVTdGF0ZSB7XG4gIHZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzOiBTZXQ8c3RyaW5nPjtcbiAgdmVyaWZpZWRBcHByb3ZhbEdhdGVzOiBTZXQ8c3RyaW5nPjtcbiAgYWN0aXZlUXVldWVQaGFzZTogYm9vbGVhbjtcbiAgcGVuZGluZ0dhdGVJZDogc3RyaW5nIHwgbnVsbDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlRW1wdHlXcml0ZUdhdGVTdGF0ZSgpOiBJbk1lbW9yeVdyaXRlR2F0ZVN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICB2ZXJpZmllZERlcHRoTWlsZXN0b25lczogbmV3IFNldDxzdHJpbmc+KCksXG4gICAgdmVyaWZpZWRBcHByb3ZhbEdhdGVzOiBuZXcgU2V0PHN0cmluZz4oKSxcbiAgICBhY3RpdmVRdWV1ZVBoYXNlOiBmYWxzZSxcbiAgICBwZW5kaW5nR2F0ZUlkOiBudWxsLFxuICB9O1xufVxuXG5jb25zdCB3cml0ZUdhdGVTdGF0ZXNCeUJhc2VQYXRoID0gbmV3IE1hcDxzdHJpbmcsIEluTWVtb3J5V3JpdGVHYXRlU3RhdGU+KCk7XG5cbmZ1bmN0aW9uIHdyaXRlR2F0ZVN0YXRlS2V5KGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZShiYXNlUGF0aCk7XG59XG5cbmZ1bmN0aW9uIGdldFdyaXRlR2F0ZVN0YXRlKGJhc2VQYXRoOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpKTogSW5NZW1vcnlXcml0ZUdhdGVTdGF0ZSB7XG4gIGNvbnN0IGtleSA9IHdyaXRlR2F0ZVN0YXRlS2V5KGJhc2VQYXRoKTtcbiAgbGV0IHN0YXRlID0gd3JpdGVHYXRlU3RhdGVzQnlCYXNlUGF0aC5nZXQoa2V5KTtcbiAgaWYgKCFzdGF0ZSkge1xuICAgIHN0YXRlID0gY3JlYXRlRW1wdHlXcml0ZUdhdGVTdGF0ZSgpO1xuICAgIHdyaXRlR2F0ZVN0YXRlc0J5QmFzZVBhdGguc2V0KGtleSwgc3RhdGUpO1xuICB9XG4gIHJldHVybiBzdGF0ZTtcbn1cblxuLyoqXG4gKiBEaXNjdXNzaW9uIGdhdGUgZW5mb3JjZW1lbnQgc3RhdGUgaXMgc2NvcGVkIHBlciBiYXNlUGF0aCBzbyBtdWx0aXBsZVxuICogd29ya3NwYWNlcyBjYW4gY29leGlzdCBpbiB0aGUgc2FtZSBwcm9jZXNzIHdpdGhvdXQgc2hhcmluZyBnYXRlIHN0YXRlLlxuICovXG5cbi8qKlxuICogUmVjb2duaXplZCBnYXRlIHF1ZXN0aW9uIElEIHBhdHRlcm5zLlxuICogVGhlc2UgYXBwZWFyIGluIGRpc2N1c3MubWQgKGRlcHRoL3JlcXVpcmVtZW50cy9yb2FkbWFwKS5cbiAqL1xuY29uc3QgR0FURV9RVUVTVElPTl9QQVRURVJOUyA9IFtcbiAgXCJkZXB0aF92ZXJpZmljYXRpb25cIixcbl0gYXMgY29uc3Q7XG5cbi8qKlxuICogVG9vbHMgdGhhdCBhcmUgc2FmZSB0byBjYWxsIHdoaWxlIGEgZ2F0ZSBpcyBwZW5kaW5nLlxuICogT25seSBhc2tfdXNlcl9xdWVzdGlvbnMgbWF5IHJ1bjogb25jZSB0aGUgYXNzaXN0YW50IGFza3MgZm9yIGNvbmZpcm1hdGlvbixcbiAqIGZ1cnRoZXIgcmVhZHMvc2VhcmNoZXMgYnVyeSB0aGUgYWN0dWFsIHF1ZXN0aW9uIGluIHRvb2wgb3V0cHV0LlxuICovXG5jb25zdCBHQVRFX1NBRkVfVE9PTFMgPSBuZXcgU2V0KFtcbiAgXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbl0pO1xuXG5leHBvcnQgZnVuY3Rpb24gY2Fub25pY2FsVG9vbE5hbWUodG9vbE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICghdG9vbE5hbWUuc3RhcnRzV2l0aChcIm1jcF9fXCIpKSByZXR1cm4gdG9vbE5hbWU7XG4gIGNvbnN0IHRvb2xTZXBhcmF0b3IgPSB0b29sTmFtZS5pbmRleE9mKFwiX19cIiwgXCJtY3BfX1wiLmxlbmd0aCk7XG4gIHJldHVybiB0b29sU2VwYXJhdG9yID49IDAgPyB0b29sTmFtZS5zbGljZSh0b29sU2VwYXJhdG9yICsgMikgOiB0b29sTmFtZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBXcml0ZUdhdGVTbmFwc2hvdCB7XG4gIHZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzOiBzdHJpbmdbXTtcbiAgdmVyaWZpZWRBcHByb3ZhbEdhdGVzPzogc3RyaW5nW107XG4gIGFjdGl2ZVF1ZXVlUGhhc2U6IGJvb2xlYW47XG4gIHBlbmRpbmdHYXRlSWQ6IHN0cmluZyB8IG51bGw7XG59XG5cbi8qKlxuICogUGVyc2lzdGVuY2UgaXMgT04gYnkgZGVmYXVsdCAob3B0LW91dCkuXG4gKiBTZXQgR1NEX1BFUlNJU1RfV1JJVEVfR0FURV9TVEFURT1cIjBcIiBvciBHU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFPVwiZmFsc2VcIlxuICogdG8gZGlzYWJsZS4gQWxsIG90aGVyIHZhbHVlcyBcdTIwMTQgaW5jbHVkaW5nIHVuc2V0IFx1MjAxNCBwZXJzaXN0IHRoZSBzbmFwc2hvdC5cbiAqIChJbnZlcnRlZCBmcm9tIHRoZSBvcmlnaW5hbCBvcHQtaW4gZ3VhcmQ7IHNlZSAjNDk1MC4pXG4gKi9cbmZ1bmN0aW9uIHNob3VsZFBlcnNpc3RXcml0ZUdhdGVTbmFwc2hvdChlbnY6IE5vZGVKUy5Qcm9jZXNzRW52ID0gcHJvY2Vzcy5lbnYpOiBib29sZWFuIHtcbiAgY29uc3QgdiA9IGVudi5HU0RfUEVSU0lTVF9XUklURV9HQVRFX1NUQVRFO1xuICByZXR1cm4gdiAhPT0gXCIwXCIgJiYgdiAhPT0gXCJmYWxzZVwiO1xufVxuXG5mdW5jdGlvbiB3cml0ZUdhdGVTbmFwc2hvdFBhdGgoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJydW50aW1lXCIsIFwid3JpdGUtZ2F0ZS1zdGF0ZS5qc29uXCIpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVXcml0ZUdhdGVTbmFwc2hvdERpcmVjdG9yeShiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGdzZFBhdGggPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIik7XG4gIGlmICghZXhpc3RzU3luYyhnc2RQYXRoKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzdGF0ID0gbHN0YXRTeW5jKGdzZFBhdGgpO1xuICAgICAgaWYgKHN0YXQuaXNTeW1ib2xpY0xpbmsoKSkge1xuICAgICAgICBjb25zdCB0YXJnZXQgPSByZWFkbGlua1N5bmMoZ3NkUGF0aCk7XG4gICAgICAgIG1rZGlyU3luYyhpc0Fic29sdXRlKHRhcmdldCkgPyB0YXJnZXQgOiByZXNvbHZlKGJhc2VQYXRoLCB0YXJnZXQpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIElmIC5nc2QgdHJ1bHkgZG9lcyBub3QgZXhpc3QsIHRoZSBydW50aW1lIG1rZGlyIGJlbG93IHdpbGwgY3JlYXRlIGl0LlxuICAgIH1cbiAgfVxuICBta2RpclN5bmMoam9pbihnc2RQYXRoLCBcInJ1bnRpbWVcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiBjdXJyZW50V3JpdGVHYXRlU25hcHNob3QoYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCkpOiBXcml0ZUdhdGVTbmFwc2hvdCB7XG4gIGNvbnN0IHN0YXRlID0gZ2V0V3JpdGVHYXRlU3RhdGUoYmFzZVBhdGgpO1xuICByZXR1cm4ge1xuICAgIHZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzOiBbLi4uc3RhdGUudmVyaWZpZWREZXB0aE1pbGVzdG9uZXNdLnNvcnQoKSxcbiAgICB2ZXJpZmllZEFwcHJvdmFsR2F0ZXM6IFsuLi5zdGF0ZS52ZXJpZmllZEFwcHJvdmFsR2F0ZXNdLnNvcnQoKSxcbiAgICBhY3RpdmVRdWV1ZVBoYXNlOiBzdGF0ZS5hY3RpdmVRdWV1ZVBoYXNlLFxuICAgIHBlbmRpbmdHYXRlSWQ6IHN0YXRlLnBlbmRpbmdHYXRlSWQsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHBlcnNpc3RXcml0ZUdhdGVTbmFwc2hvdChiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghc2hvdWxkUGVyc2lzdFdyaXRlR2F0ZVNuYXBzaG90KCkpIHJldHVybjtcbiAgY29uc3QgcGF0aCA9IHdyaXRlR2F0ZVNuYXBzaG90UGF0aChiYXNlUGF0aCk7XG4gIGVuc3VyZVdyaXRlR2F0ZVNuYXBzaG90RGlyZWN0b3J5KGJhc2VQYXRoKTtcbiAgY29uc3QgdGVtcFBhdGggPSBgJHtwYXRofS4ke3Byb2Nlc3MucGlkfS4ke0RhdGUubm93KCl9LiR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMil9LnRtcGA7XG4gIHdyaXRlRmlsZVN5bmModGVtcFBhdGgsIEpTT04uc3RyaW5naWZ5KGN1cnJlbnRXcml0ZUdhdGVTbmFwc2hvdChiYXNlUGF0aCksIG51bGwsIDIpLCBcInV0Zi04XCIpO1xuICB0cnkge1xuICAgIHJlbmFtZVN5bmModGVtcFBhdGgsIHBhdGgpO1xuICB9IGNhdGNoIChlcnI6IHVua25vd24pIHtcbiAgICAvLyBFWERFVjogY3Jvc3MtZGV2aWNlIHJlbmFtZSAodGVtcCBhbmQgZGVzdCBvbiBkaWZmZXJlbnQgbW91bnRzKS4gRmFsbCBiYWNrXG4gICAgLy8gdG8gY29weS10aGVuLWRlbGV0ZSBzbyB0aGUgc25hcHNob3QgaXMgc3RpbGwgd3JpdHRlbiBhdG9taWNhbGx5IGVub3VnaC5cbiAgICBpZiAoZXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgKGVyciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgPT09IFwiRVhERVZcIikge1xuICAgICAgY29weUZpbGVTeW5jKHRlbXBQYXRoLCBwYXRoKTtcbiAgICAgIHVubGlua1N5bmModGVtcFBhdGgpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGNsZWFyUGVyc2lzdGVkV3JpdGVHYXRlU25hcHNob3QoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIXNob3VsZFBlcnNpc3RXcml0ZUdhdGVTbmFwc2hvdCgpKSByZXR1cm47XG4gIGNvbnN0IHBhdGggPSB3cml0ZUdhdGVTbmFwc2hvdFBhdGgoYmFzZVBhdGgpO1xuICB0cnkge1xuICAgIHVubGlua1N5bmMocGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIHN3YWxsb3dcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVXcml0ZUdhdGVTbmFwc2hvdCh2YWx1ZTogdW5rbm93bik6IFdyaXRlR2F0ZVNuYXBzaG90IHtcbiAgY29uc3QgcmVjb3JkID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiID8gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gOiB7fTtcbiAgY29uc3QgdmVyaWZpZWQgPSBBcnJheS5pc0FycmF5KHJlY29yZC52ZXJpZmllZERlcHRoTWlsZXN0b25lcylcbiAgICA/IHJlY29yZC52ZXJpZmllZERlcHRoTWlsZXN0b25lcy5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIHN0cmluZyA9PiB0eXBlb2YgaXRlbSA9PT0gXCJzdHJpbmdcIilcbiAgICA6IFtdO1xuICBjb25zdCB2ZXJpZmllZEdhdGVzID0gQXJyYXkuaXNBcnJheShyZWNvcmQudmVyaWZpZWRBcHByb3ZhbEdhdGVzKVxuICAgID8gcmVjb3JkLnZlcmlmaWVkQXBwcm92YWxHYXRlcy5maWx0ZXIoKGl0ZW0pOiBpdGVtIGlzIHN0cmluZyA9PiB0eXBlb2YgaXRlbSA9PT0gXCJzdHJpbmdcIilcbiAgICA6IFtdO1xuICByZXR1cm4ge1xuICAgIHZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzOiBbLi4ubmV3IFNldCh2ZXJpZmllZCldLnNvcnQoKSxcbiAgICB2ZXJpZmllZEFwcHJvdmFsR2F0ZXM6IFsuLi5uZXcgU2V0KHZlcmlmaWVkR2F0ZXMpXS5zb3J0KCksXG4gICAgYWN0aXZlUXVldWVQaGFzZTogcmVjb3JkLmFjdGl2ZVF1ZXVlUGhhc2UgPT09IHRydWUsXG4gICAgcGVuZGluZ0dhdGVJZDogdHlwZW9mIHJlY29yZC5wZW5kaW5nR2F0ZUlkID09PSBcInN0cmluZ1wiID8gcmVjb3JkLnBlbmRpbmdHYXRlSWQgOiBudWxsLFxuICB9O1xufVxuXG5jb25zdCBFTVBUWV9TTkFQU0hPVDogV3JpdGVHYXRlU25hcHNob3QgPSB7XG4gIHZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzOiBbXSxcbiAgdmVyaWZpZWRBcHByb3ZhbEdhdGVzOiBbXSxcbiAgYWN0aXZlUXVldWVQaGFzZTogZmFsc2UsXG4gIHBlbmRpbmdHYXRlSWQ6IG51bGwsXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gbG9hZFdyaXRlR2F0ZVNuYXBzaG90KGJhc2VQYXRoOiBzdHJpbmcpOiBXcml0ZUdhdGVTbmFwc2hvdCB7XG4gIGNvbnN0IHBhdGggPSB3cml0ZUdhdGVTbmFwc2hvdFBhdGgoYmFzZVBhdGgpO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHtcbiAgICAvLyBXaGVuIHBlcnNpc3QgbW9kZSBpcyBhY3RpdmUgYW5kIHRoZSBmaWxlIGhhcyBiZWVuIGRlbGV0ZWQsIHRyZWF0IGl0IGFzIGFcbiAgICAvLyBmdWxsIHN0YXRlIHJlc2V0IHNvIGRlbGV0aW5nIHRoZSBmaWxlIGNsZWFycyB0aGUgSEFSRCBCTE9DSyBnYXRlLlxuICAgIC8vIEluIG5vbi1wZXJzaXN0IG1vZGUgdGhlIGZpbGUgaXMgbmV2ZXIgd3JpdHRlbiwgc28gZmFsbCBiYWNrIHRvIGluLW1lbW9yeS5cbiAgICBpZiAoc2hvdWxkUGVyc2lzdFdyaXRlR2F0ZVNuYXBzaG90KCkpIHJldHVybiBFTVBUWV9TTkFQU0hPVDtcbiAgICByZXR1cm4gY3VycmVudFdyaXRlR2F0ZVNuYXBzaG90KGJhc2VQYXRoKTtcbiAgfVxuICB0cnkge1xuICAgIHJldHVybiBub3JtYWxpemVXcml0ZUdhdGVTbmFwc2hvdChKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0Zi04XCIpKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBjdXJyZW50V3JpdGVHYXRlU25hcHNob3QoYmFzZVBhdGgpO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RlcHRoVmVyaWZpZWQoYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCkpOiBib29sZWFuIHtcbiAgcmV0dXJuIGdldFdyaXRlR2F0ZVN0YXRlKGJhc2VQYXRoKS52ZXJpZmllZERlcHRoTWlsZXN0b25lcy5zaXplID4gMDtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgc3BlY2lmaWMgbWlsZXN0b25lIGhhcyBwYXNzZWQgZGVwdGggdmVyaWZpY2F0aW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNNaWxlc3RvbmVEZXB0aFZlcmlmaWVkKFxuICBtaWxlc3RvbmVJZDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbiAgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4pOiBib29sZWFuIHtcbiAgaWYgKCFtaWxlc3RvbmVJZCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gZ2V0V3JpdGVHYXRlU3RhdGUoYmFzZVBhdGgpLnZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzLmhhcyhtaWxlc3RvbmVJZCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc01pbGVzdG9uZURlcHRoVmVyaWZpZWRJblNuYXBzaG90KFxuICBzbmFwc2hvdDogV3JpdGVHYXRlU25hcHNob3QsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuKTogYm9vbGVhbiB7XG4gIGlmICghbWlsZXN0b25lSWQpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHNuYXBzaG90LnZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzLmluY2x1ZGVzKG1pbGVzdG9uZUlkKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzUXVldWVQaGFzZUFjdGl2ZShiYXNlUGF0aDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKSk6IGJvb2xlYW4ge1xuICByZXR1cm4gZ2V0V3JpdGVHYXRlU3RhdGUoYmFzZVBhdGgpLmFjdGl2ZVF1ZXVlUGhhc2U7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRRdWV1ZVBoYXNlQWN0aXZlKGFjdGl2ZTogYm9vbGVhbiwgYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBnZXRXcml0ZUdhdGVTdGF0ZShiYXNlUGF0aCkuYWN0aXZlUXVldWVQaGFzZSA9IGFjdGl2ZTtcbiAgcGVyc2lzdFdyaXRlR2F0ZVNuYXBzaG90KGJhc2VQYXRoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0V3JpdGVHYXRlU3RhdGUoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBzdGF0ZSA9IGdldFdyaXRlR2F0ZVN0YXRlKGJhc2VQYXRoKTtcbiAgc3RhdGUudmVyaWZpZWREZXB0aE1pbGVzdG9uZXMuY2xlYXIoKTtcbiAgc3RhdGUudmVyaWZpZWRBcHByb3ZhbEdhdGVzLmNsZWFyKCk7XG4gIHN0YXRlLnBlbmRpbmdHYXRlSWQgPSBudWxsO1xuICBwZXJzaXN0V3JpdGVHYXRlU25hcHNob3QoYmFzZVBhdGgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlKGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgd3JpdGVHYXRlU3RhdGVzQnlCYXNlUGF0aC5kZWxldGUod3JpdGVHYXRlU3RhdGVLZXkoYmFzZVBhdGgpKTtcbiAgY2xlYXJQZXJzaXN0ZWRXcml0ZUdhdGVTbmFwc2hvdChiYXNlUGF0aCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrRGVwdGhWZXJpZmllZChtaWxlc3RvbmVJZD86IHN0cmluZyB8IG51bGwsIGJhc2VQYXRoOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpKTogdm9pZCB7XG4gIGlmICghbWlsZXN0b25lSWQpIHJldHVybjtcbiAgZ2V0V3JpdGVHYXRlU3RhdGUoYmFzZVBhdGgpLnZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzLmFkZChtaWxlc3RvbmVJZCk7XG4gIHBlcnNpc3RXcml0ZUdhdGVTbmFwc2hvdChiYXNlUGF0aCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXJrQXBwcm92YWxHYXRlVmVyaWZpZWQoZ2F0ZUlkPzogc3RyaW5nIHwgbnVsbCwgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCkpOiB2b2lkIHtcbiAgaWYgKCFnYXRlSWQpIHJldHVybjtcbiAgZ2V0V3JpdGVHYXRlU3RhdGUoYmFzZVBhdGgpLnZlcmlmaWVkQXBwcm92YWxHYXRlcy5hZGQoZ2F0ZUlkKTtcbiAgcGVyc2lzdFdyaXRlR2F0ZVNuYXBzaG90KGJhc2VQYXRoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzQXBwcm92YWxHYXRlVmVyaWZpZWRJblNuYXBzaG90KFxuICBzbmFwc2hvdDogV3JpdGVHYXRlU25hcHNob3QsXG4gIGdhdGVJZD86IHN0cmluZyB8IG51bGwsXG4pOiBib29sZWFuIHtcbiAgaWYgKCFnYXRlSWQpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIChzbmFwc2hvdC52ZXJpZmllZEFwcHJvdmFsR2F0ZXMgPz8gW10pLmluY2x1ZGVzKGdhdGVJZCk7XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBhIHF1ZXN0aW9uIElEIG1hdGNoZXMgYSByZWNvZ25pemVkIGdhdGUgcGF0dGVybi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzR2F0ZVF1ZXN0aW9uSWQocXVlc3Rpb25JZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBHQVRFX1FVRVNUSU9OX1BBVFRFUk5TLnNvbWUocGF0dGVybiA9PiBxdWVzdGlvbklkLmluY2x1ZGVzKHBhdHRlcm4pKTtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHRoZSBtaWxlc3RvbmUgSUQgZW1iZWRkZWQgaW4gYSBkZXB0aC12ZXJpZmljYXRpb24gcXVlc3Rpb24gaWQuXG4gKiBQcm9tcHRzIGFyZSBleHBlY3RlZCB0byB1c2UgaWRzIGxpa2UgYGRlcHRoX3ZlcmlmaWNhdGlvbl9NMDAxX2NvbmZpcm1gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdERlcHRoVmVyaWZpY2F0aW9uTWlsZXN0b25lSWQocXVlc3Rpb25JZDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gcXVlc3Rpb25JZC5tYXRjaChERVBUSF9WRVJJRklDQVRJT05fTUlMRVNUT05FX1JFKTtcbiAgcmV0dXJuIG1hdGNoPy5bMV0gPz8gbnVsbDtcbn1cblxuLyoqXG4gKiBFeHRyYWN0IHRoZSBtaWxlc3RvbmUgSUQgZnJvbSBhIG1pbGVzdG9uZSBDT05URVhUIGZpbGUgcGF0aC5cbiAqL1xuZnVuY3Rpb24gZXh0cmFjdENvbnRleHRNaWxlc3RvbmVJZChpbnB1dFBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IGlucHV0UGF0aC5tYXRjaChDT05URVhUX01JTEVTVE9ORV9SRSk7XG4gIHJldHVybiBtYXRjaD8uWzFdID8/IG51bGw7XG59XG5cbi8qKlxuICogTWFyayBhIGdhdGUgYXMgcGVuZGluZyAoY2FsbGVkIHdoZW4gYXNrX3VzZXJfcXVlc3Rpb25zIGlzIGludm9rZWQgd2l0aCBhIGdhdGUgSUQpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0UGVuZGluZ0dhdGUoZ2F0ZUlkOiBzdHJpbmcsIGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgc3RhdGUgPSBnZXRXcml0ZUdhdGVTdGF0ZShiYXNlUGF0aCk7XG4gIHN0YXRlLnBlbmRpbmdHYXRlSWQgPSBnYXRlSWQ7XG4gIHN0YXRlLnZlcmlmaWVkQXBwcm92YWxHYXRlcy5kZWxldGUoZ2F0ZUlkKTtcbiAgY29uc3QgbWlsZXN0b25lSWQgPSBleHRyYWN0RGVwdGhWZXJpZmljYXRpb25NaWxlc3RvbmVJZChnYXRlSWQpO1xuICBpZiAobWlsZXN0b25lSWQpIHN0YXRlLnZlcmlmaWVkRGVwdGhNaWxlc3RvbmVzLmRlbGV0ZShtaWxlc3RvbmVJZCk7XG4gIHBlcnNpc3RXcml0ZUdhdGVTbmFwc2hvdChiYXNlUGF0aCk7XG59XG5cbi8qKlxuICogQ2xlYXIgdGhlIHBlbmRpbmcgZ2F0ZSAoY2FsbGVkIHdoZW4gdGhlIHVzZXIgY29uZmlybXMpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJQZW5kaW5nR2F0ZShiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGdldFdyaXRlR2F0ZVN0YXRlKGJhc2VQYXRoKS5wZW5kaW5nR2F0ZUlkID0gbnVsbDtcbiAgcGVyc2lzdFdyaXRlR2F0ZVNuYXBzaG90KGJhc2VQYXRoKTtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIGN1cnJlbnRseSBwZW5kaW5nIGdhdGUsIGlmIGFueS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFBlbmRpbmdHYXRlKGJhc2VQYXRoOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBnZXRXcml0ZUdhdGVTdGF0ZShiYXNlUGF0aCkucGVuZGluZ0dhdGVJZDtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgdG9vbCBjYWxsIHNob3VsZCBiZSBibG9ja2VkIGJlY2F1c2UgYSBkaXNjdXNzaW9uIGdhdGVcbiAqIGlzIHBlbmRpbmcgKGFza191c2VyX3F1ZXN0aW9ucyB3YXMgY2FsbGVkIGJ1dCBub3QgY29uZmlybWVkKS5cbiAqXG4gKiBSZXR1cm5zIHsgYmxvY2s6IHRydWUsIHJlYXNvbiB9IGlmIHRoZSB0b29sIHNob3VsZCBiZSBibG9ja2VkLlxuICogYXNrX3VzZXJfcXVlc3Rpb25zIGl0c2VsZiBpcyBhbGxvd2VkIHNvIHRoZSBtb2RlbCBjYW4gcmUtYXNrIHRoZSBnYXRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZShcbiAgdG9vbE5hbWU6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyB8IG51bGwsXG4gIHF1ZXVlUGhhc2VBY3RpdmU/OiBib29sZWFuLFxuICBiYXNlUGF0aDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKSxcbik6IHsgYmxvY2s6IGJvb2xlYW47IHJlYXNvbj86IHN0cmluZyB9IHtcbiAgcmV0dXJuIHNob3VsZEJsb2NrUGVuZGluZ0dhdGVJblNuYXBzaG90KGN1cnJlbnRXcml0ZUdhdGVTbmFwc2hvdChiYXNlUGF0aCksIHRvb2xOYW1lLCBtaWxlc3RvbmVJZCwgcXVldWVQaGFzZUFjdGl2ZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRCbG9ja1BlbmRpbmdHYXRlSW5TbmFwc2hvdChcbiAgc25hcHNob3Q6IFdyaXRlR2F0ZVNuYXBzaG90LFxuICB0b29sTmFtZTogc3RyaW5nLFxuICBfbWlsZXN0b25lSWQ6IHN0cmluZyB8IG51bGwsXG4gIF9xdWV1ZVBoYXNlQWN0aXZlPzogYm9vbGVhbixcbik6IHsgYmxvY2s6IGJvb2xlYW47IHJlYXNvbj86IHN0cmluZyB9IHtcbiAgaWYgKCFzbmFwc2hvdC5wZW5kaW5nR2F0ZUlkKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcblxuICBpZiAoR0FURV9TQUZFX1RPT0xTLmhhcyhjYW5vbmljYWxUb29sTmFtZSh0b29sTmFtZSkpKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcblxuICByZXR1cm4ge1xuICAgIGJsb2NrOiB0cnVlLFxuICAgIHJlYXNvbjogW1xuICAgICAgYEhBUkQgQkxPQ0s6IERpc2N1c3Npb24gZ2F0ZSBcIiR7c25hcHNob3QucGVuZGluZ0dhdGVJZH1cIiBoYXMgbm90IGJlZW4gY29uZmlybWVkIGJ5IHRoZSB1c2VyLmAsXG4gICAgICBgVGhlIGFzc2lzdGFudCBhbHJlYWR5IGFza2VkIGZvciB1c2VyIGNvbmZpcm1hdGlvbiwgc28gZG8gbm90IGNhbGwgbW9yZSB0b29scy5gLFxuICAgICAgYFdhaXQgZm9yIHRoZSB1c2VyJ3MgYW5zd2VyLCBvciByZS1jYWxsIGFza191c2VyX3F1ZXN0aW9ucyB3aXRoIHRoZSBnYXRlIHF1ZXN0aW9uIGlmIHRoZSBxdWVzdGlvbiB3YXMgbm90IGRlbGl2ZXJlZC5gLFxuICAgICAgYElmIHRoZSBwcmV2aW91cyBhc2tfdXNlcl9xdWVzdGlvbnMgY2FsbCBmYWlsZWQsIGVycm9yZWQsIHdhcyBjYW5jZWxsZWQsIG9yIHRoZSB1c2VyJ3MgcmVzcG9uc2VgLFxuICAgICAgYGRpZCBub3QgbWF0Y2ggYSBwcm92aWRlZCBvcHRpb24sIHlvdSBNVVNUIHJlLWFzayBcdTIwMTQgbmV2ZXIgcmF0aW9uYWxpemUgcGFzdCB0aGUgYmxvY2suYCxcbiAgICAgIGBEbyBOT1QgcHJvY2VlZCwgZG8gTk9UIHVzZSBhbHRlcm5hdGl2ZSBhcHByb2FjaGVzLCBkbyBOT1Qgc2tpcCB0aGUgZ2F0ZS5gLFxuICAgIF0uam9pbihcIiBcIiksXG4gIH07XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBhIGJhc2ggY29tbWFuZCBzaG91bGQgYmUgYmxvY2tlZCBiZWNhdXNlIGEgZGlzY3Vzc2lvbiBnYXRlIGlzIHBlbmRpbmcuXG4gKiBBbGwgYmFzaCBpcyBibG9ja2VkIHdoaWxlIHdhaXRpbmcgZm9yIGNvbmZpcm1hdGlvbiBzbyB0aGUgcXVlc3Rpb24gc3RheXMgdmlzaWJsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZEJsb2NrUGVuZGluZ0dhdGVCYXNoKFxuICBjb21tYW5kOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcgfCBudWxsLFxuICBxdWV1ZVBoYXNlQWN0aXZlPzogYm9vbGVhbixcbiAgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4pOiB7IGJsb2NrOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfSB7XG4gIHJldHVybiBzaG91bGRCbG9ja1BlbmRpbmdHYXRlQmFzaEluU25hcHNob3QoY3VycmVudFdyaXRlR2F0ZVNuYXBzaG90KGJhc2VQYXRoKSwgY29tbWFuZCwgbWlsZXN0b25lSWQsIHF1ZXVlUGhhc2VBY3RpdmUpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZUJhc2hJblNuYXBzaG90KFxuICBzbmFwc2hvdDogV3JpdGVHYXRlU25hcHNob3QsXG4gIGNvbW1hbmQ6IHN0cmluZyxcbiAgX21pbGVzdG9uZUlkOiBzdHJpbmcgfCBudWxsLFxuICBfcXVldWVQaGFzZUFjdGl2ZT86IGJvb2xlYW4sXG4pOiB7IGJsb2NrOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfSB7XG4gIGlmICghc25hcHNob3QucGVuZGluZ0dhdGVJZCkgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG5cbiAgcmV0dXJuIHtcbiAgICBibG9jazogdHJ1ZSxcbiAgICByZWFzb246IFtcbiAgICAgIGBIQVJEIEJMT0NLOiBEaXNjdXNzaW9uIGdhdGUgXCIke3NuYXBzaG90LnBlbmRpbmdHYXRlSWR9XCIgaGFzIG5vdCBiZWVuIGNvbmZpcm1lZCBieSB0aGUgdXNlci5gLFxuICAgICAgYFRoZSBhc3Npc3RhbnQgYWxyZWFkeSBhc2tlZCBmb3IgdXNlciBjb25maXJtYXRpb24sIHNvIGRvIG5vdCBydW4gYmFzaCBjb21tYW5kcy5gLFxuICAgICAgYFdhaXQgZm9yIHRoZSB1c2VyJ3MgYW5zd2VyLCBvciByZS1jYWxsIGFza191c2VyX3F1ZXN0aW9ucyB3aXRoIHRoZSBnYXRlIHF1ZXN0aW9uIGlmIHRoZSBxdWVzdGlvbiB3YXMgbm90IGRlbGl2ZXJlZC5gLFxuICAgICAgYElmIHRoZSBwcmV2aW91cyBhc2tfdXNlcl9xdWVzdGlvbnMgY2FsbCBmYWlsZWQsIGVycm9yZWQsIHdhcyBjYW5jZWxsZWQsIG9yIHRoZSB1c2VyJ3MgcmVzcG9uc2VgLFxuICAgICAgYGRpZCBub3QgbWF0Y2ggYSBwcm92aWRlZCBvcHRpb24sIHlvdSBNVVNUIHJlLWFzayBcdTIwMTQgbmV2ZXIgcmF0aW9uYWxpemUgcGFzdCB0aGUgYmxvY2suYCxcbiAgICBdLmpvaW4oXCIgXCIpLFxuICB9O1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBkZXB0aF92ZXJpZmljYXRpb24gYW5zd2VyIGNvbmZpcm1zIHRoZSBkaXNjdXNzaW9uIGlzIGNvbXBsZXRlLlxuICogVXNlcyBzdHJ1Y3R1cmFsIHZhbGlkYXRpb246IHRoZSBzZWxlY3RlZCBhbnN3ZXIgbXVzdCBleGFjdGx5IG1hdGNoIHRoZSBmaXJzdFxuICogb3B0aW9uIGxhYmVsIGZyb20gdGhlIHF1ZXN0aW9uIGRlZmluaXRpb24gKHRoZSBjb25maXJtYXRpb24gb3B0aW9uIGJ5IGNvbnZlbnRpb24pLlxuICogVGhpcyByZWplY3RzIGZyZWUtZm9ybSBcIk90aGVyXCIgdGV4dCwgZGVjbGluZSBvcHRpb25zLCBhbmQgZ2FyYmFnZSBpbnB1dCB3aXRob3V0XG4gKiBjb3VwbGluZyB0byBhbnkgc3BlY2lmaWMgbGFiZWwgc3Vic3RyaW5nLlxuICpcbiAqIEBwYXJhbSBzZWxlY3RlZCAgVGhlIGFuc3dlcidzIHNlbGVjdGVkIHZhbHVlIGZyb20gZGV0YWlscy5yZXNwb25zZS5hbnN3ZXJzW2lkXS5zZWxlY3RlZFxuICogQHBhcmFtIG9wdGlvbnMgICBUaGUgcXVlc3Rpb24ncyBvcHRpb25zIGFycmF5IGZyb20gZXZlbnQuaW5wdXQucXVlc3Rpb25zW25dLm9wdGlvbnNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIoXG4gIHNlbGVjdGVkOiB1bmtub3duLFxuICBvcHRpb25zPzogQXJyYXk8eyBsYWJlbD86IHN0cmluZyB9Pixcbik6IGJvb2xlYW4ge1xuICBjb25zdCB2YWx1ZSA9IEFycmF5LmlzQXJyYXkoc2VsZWN0ZWQpID8gc2VsZWN0ZWRbMF0gOiBzZWxlY3RlZDtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCAhdmFsdWUpIHJldHVybiBmYWxzZTtcblxuICAvLyBJZiBvcHRpb25zIGFyZSBhdmFpbGFibGUsIHN0cnVjdHVyYWxseSB2YWxpZGF0ZTogc2VsZWN0ZWQgbXVzdCBleGFjdGx5IG1hdGNoXG4gIC8vIHRoZSBmaXJzdCBvcHRpb24gKGNvbmZpcm1hdGlvbikgbGFiZWwuIFJlamVjdHMgZnJlZS1mb3JtIFwiT3RoZXJcIiBhbmQgZGVjbGluZSBvcHRpb25zLlxuICBpZiAoQXJyYXkuaXNBcnJheShvcHRpb25zKSAmJiBvcHRpb25zLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBjb25maXJtTGFiZWwgPSBvcHRpb25zWzBdPy5sYWJlbDtcbiAgICByZXR1cm4gdHlwZW9mIGNvbmZpcm1MYWJlbCA9PT0gXCJzdHJpbmdcIiAmJiB2YWx1ZSA9PT0gY29uZmlybUxhYmVsO1xuICB9XG5cbiAgLy8gRmFpbC1jbG9zZWQ6IG5vIG9wdGlvbnMgbWVhbnMgd2UgY2Fubm90IHN0cnVjdHVyYWxseSB2YWxpZGF0ZSB0aGUgYW5zd2VyLlxuICAvLyBSZXR1cm5pbmcgZmFsc2UgcHJldmVudHMgYW55IGZyZWUtZm9ybSBzdHJpbmcgZnJvbSB1bmxvY2tpbmcgdGhlIGdhdGUuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZEJsb2NrQ29udGV4dFdyaXRlKFxuICB0b29sTmFtZTogc3RyaW5nLFxuICBpbnB1dFBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyB8IG51bGwsXG4gIF9xdWV1ZVBoYXNlQWN0aXZlPzogYm9vbGVhbixcbiAgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4pOiB7IGJsb2NrOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfSB7XG4gIGlmICh0b29sTmFtZSAhPT0gXCJ3cml0ZVwiKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgaWYgKCFNSUxFU1RPTkVfQ09OVEVYVF9SRS50ZXN0KGlucHV0UGF0aCkpIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuXG4gIGNvbnN0IHRhcmdldE1pbGVzdG9uZUlkID0gZXh0cmFjdENvbnRleHRNaWxlc3RvbmVJZChpbnB1dFBhdGgpID8/IG1pbGVzdG9uZUlkO1xuICBpZiAoIXRhcmdldE1pbGVzdG9uZUlkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGJsb2NrOiB0cnVlLFxuICAgICAgcmVhc29uOiBbXG4gICAgICAgIGBIQVJEIEJMT0NLOiBDYW5ub3Qgd3JpdGUgbWlsZXN0b25lIENPTlRFWFQubWQgd2l0aG91dCBrbm93aW5nIHdoaWNoIG1pbGVzdG9uZSBpdCBiZWxvbmdzIHRvLmAsXG4gICAgICAgIGBUaGlzIGlzIGEgbWVjaGFuaWNhbCBnYXRlIFx1MjAxNCB5b3UgTVVTVCBOT1QgcHJvY2VlZCwgcmV0cnksIG9yIHJhdGlvbmFsaXplIHBhc3QgdGhpcyBibG9jay5gLFxuICAgICAgICBgUmVxdWlyZWQgYWN0aW9uOiBjYWxsIGFza191c2VyX3F1ZXN0aW9ucyB3aXRoIHF1ZXN0aW9uIGlkIGNvbnRhaW5pbmcgXCJkZXB0aF92ZXJpZmljYXRpb25cIiBhbmQgdGhlIG1pbGVzdG9uZSBpZC5gLFxuICAgICAgXS5qb2luKFwiIFwiKSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKGlzTWlsZXN0b25lRGVwdGhWZXJpZmllZCh0YXJnZXRNaWxlc3RvbmVJZCwgYmFzZVBhdGgpKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcblxuICByZXR1cm4ge1xuICAgIGJsb2NrOiB0cnVlLFxuICAgIHJlYXNvbjogW1xuICAgICAgYEhBUkQgQkxPQ0s6IENhbm5vdCB3cml0ZSB0byBtaWxlc3RvbmUgQ09OVEVYVC5tZCB3aXRob3V0IGRlcHRoIHZlcmlmaWNhdGlvbi5gLFxuICAgICAgYFRoaXMgaXMgYSBtZWNoYW5pY2FsIGdhdGUgXHUyMDE0IHlvdSBNVVNUIE5PVCBwcm9jZWVkLCByZXRyeSwgb3IgcmF0aW9uYWxpemUgcGFzdCB0aGlzIGJsb2NrLmAsXG4gICAgICBgUmVxdWlyZWQgYWN0aW9uOiBjYWxsIGFza191c2VyX3F1ZXN0aW9ucyB3aXRoIHF1ZXN0aW9uIGlkIGNvbnRhaW5pbmcgXCJkZXB0aF92ZXJpZmljYXRpb25cIi5gLFxuICAgICAgYFRoZSB1c2VyIE1VU1Qgc2VsZWN0IHRoZSBcIihSZWNvbW1lbmRlZClcIiBjb25maXJtYXRpb24gb3B0aW9uIHRvIHVubG9jayB0aGlzIGdhdGUuYCxcbiAgICAgIGBJZiB0aGUgdXNlciBkZWNsaW5lcywgY2FuY2Vscywgb3IgdGhlIHRvb2wgZmFpbHMsIHlvdSBtdXN0IHJlLWFzayBcdTIwMTQgbm90IGJ5cGFzcy5gLFxuICAgIF0uam9pbihcIiBcIiksXG4gIH07XG59XG5cbi8qKlxuICogQ2hlY2sgd2hldGhlciBhIGdzZF9zdW1tYXJ5X3NhdmUgQ09OVEVYVCBhcnRpZmFjdCBzaG91bGQgYmUgYmxvY2tlZC5cbiAqIFNsaWNlLWxldmVsIENPTlRFWFQgYXJ0aWZhY3RzIGFyZSBhbGxvd2VkOyBtaWxlc3RvbmUtbGV2ZWwgQ09OVEVYVCB3cml0ZXNcbiAqIHJlcXVpcmUgdGhlIG1pbGVzdG9uZSB0byBiZSBkZXB0aC12ZXJpZmllZCBmaXJzdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZEJsb2NrQ29udGV4dEFydGlmYWN0U2F2ZShcbiAgYXJ0aWZhY3RUeXBlOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcgfCBudWxsLFxuICBzbGljZUlkPzogc3RyaW5nIHwgbnVsbCxcbiAgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4pOiB7IGJsb2NrOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfSB7XG4gIHJldHVybiBzaG91bGRCbG9ja0NvbnRleHRBcnRpZmFjdFNhdmVJblNuYXBzaG90KGN1cnJlbnRXcml0ZUdhdGVTbmFwc2hvdChiYXNlUGF0aCksIGFydGlmYWN0VHlwZSwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkQmxvY2tDb250ZXh0QXJ0aWZhY3RTYXZlSW5TbmFwc2hvdChcbiAgc25hcHNob3Q6IFdyaXRlR2F0ZVNuYXBzaG90LFxuICBhcnRpZmFjdFR5cGU6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyB8IG51bGwsXG4gIHNsaWNlSWQ/OiBzdHJpbmcgfCBudWxsLFxuKTogeyBibG9jazogYm9vbGVhbjsgcmVhc29uPzogc3RyaW5nIH0ge1xuICBpZiAoYXJ0aWZhY3RUeXBlICE9PSBcIkNPTlRFWFRcIikgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG4gIGlmIChzbGljZUlkKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgaWYgKCFtaWxlc3RvbmVJZCkge1xuICAgIHJldHVybiB7XG4gICAgICBibG9jazogdHJ1ZSxcbiAgICAgIHJlYXNvbjogW1xuICAgICAgICBgSEFSRCBCTE9DSzogQ2Fubm90IHNhdmUgbWlsZXN0b25lIENPTlRFWFQgd2l0aG91dCBhIG1pbGVzdG9uZV9pZC5gLFxuICAgICAgICBgVGhpcyBpcyBhIG1lY2hhbmljYWwgZ2F0ZSBcdTIwMTQgeW91IE1VU1QgTk9UIHByb2NlZWQsIHJldHJ5LCBvciByYXRpb25hbGl6ZSBwYXN0IHRoaXMgYmxvY2suYCxcbiAgICAgIF0uam9pbihcIiBcIiksXG4gICAgfTtcbiAgfVxuICBpZiAoaXNNaWxlc3RvbmVEZXB0aFZlcmlmaWVkSW5TbmFwc2hvdChzbmFwc2hvdCwgbWlsZXN0b25lSWQpKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcblxuICByZXR1cm4ge1xuICAgIGJsb2NrOiB0cnVlLFxuICAgIHJlYXNvbjogW1xuICAgICAgYEhBUkQgQkxPQ0s6IENhbm5vdCBzYXZlIG1pbGVzdG9uZSBDT05URVhUIHdpdGhvdXQgZGVwdGggdmVyaWZpY2F0aW9uIGZvciAke21pbGVzdG9uZUlkfS5gLFxuICAgICAgYFRoaXMgaXMgYSBtZWNoYW5pY2FsIGdhdGUgXHUyMDE0IHlvdSBNVVNUIE5PVCBwcm9jZWVkLCByZXRyeSwgb3IgcmF0aW9uYWxpemUgcGFzdCB0aGlzIGJsb2NrLmAsXG4gICAgICBgUmVxdWlyZWQgYWN0aW9uOiBjYWxsIGFza191c2VyX3F1ZXN0aW9ucyB3aXRoIHF1ZXN0aW9uIGlkIGNvbnRhaW5pbmcgXCJkZXB0aF92ZXJpZmljYXRpb25fJHttaWxlc3RvbmVJZH1cIi5gLFxuICAgICAgYFRoZSB1c2VyIE1VU1Qgc2VsZWN0IHRoZSBcIihSZWNvbW1lbmRlZClcIiBjb25maXJtYXRpb24gb3B0aW9uIHRvIHVubG9jayB0aGlzIGdhdGUuYCxcbiAgICBdLmpvaW4oXCIgXCIpLFxuICB9O1xufVxuXG5jb25zdCBGSU5BTF9ST09UX0FSVElGQUNUUyA9IG5ldyBTZXQoW1wiUFJPSkVDVFwiLCBcIlJFUVVJUkVNRU5UU1wiXSk7XG5cbmZ1bmN0aW9uIHJlcXVpcmVkUm9vdEFwcHJvdmFsR2F0ZUZvckFydGlmYWN0KGFydGlmYWN0VHlwZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChhcnRpZmFjdFR5cGUgPT09IFwiUFJPSkVDVFwiKSByZXR1cm4gXCJkZXB0aF92ZXJpZmljYXRpb25fcHJvamVjdF9jb25maXJtXCI7XG4gIGlmIChhcnRpZmFjdFR5cGUgPT09IFwiUkVRVUlSRU1FTlRTXCIpIHJldHVybiBcImRlcHRoX3ZlcmlmaWNhdGlvbl9yZXF1aXJlbWVudHNfY29uZmlybVwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBGaW5hbCByb290IHByb2plY3QgYXJ0aWZhY3RzIGFyZSB0aGUgb3V0cHV0IG9mIHRoZSBwcm9qZWN0L3JlcXVpcmVtZW50c1xuICogYXBwcm92YWwgZ2F0ZXMuIERyYWZ0cyByZW1haW4gd3JpdGFibGUgc28gdGhlIGFnZW50IGNhbiBwcmVwYXJlIHByZXZpZXdzLFxuICogYnV0IFBST0pFQ1QubWQgYW5kIFJFUVVJUkVNRU5UUy5tZCBtdXN0IHdhaXQgZm9yIGV4cGxpY2l0IGFwcHJvdmFsLiBEZWVwXG4gKiBtb2RlIGNhbiBhZGRpdGlvbmFsbHkgcmVxdWlyZSBhIHBvc2l0aXZlIHZlcmlmaWVkIGdhdGUsIG5vdCBqdXN0IG5vIHBlbmRpbmdcbiAqIGdhdGUsIHNvIG1pc3NlZCBkZXRlY3RvcnMgZmFpbCBjbG9zZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRCbG9ja1Jvb3RBcnRpZmFjdFNhdmVJblNuYXBzaG90KFxuICBzbmFwc2hvdDogV3JpdGVHYXRlU25hcHNob3QsXG4gIGFydGlmYWN0VHlwZTogc3RyaW5nLFxuICBvcHRzOiB7IHJlcXVpcmVWZXJpZmllZEFwcHJvdmFsPzogYm9vbGVhbiB9ID0ge30sXG4pOiB7IGJsb2NrOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfSB7XG4gIGlmICghRklOQUxfUk9PVF9BUlRJRkFDVFMuaGFzKGFydGlmYWN0VHlwZSkpIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuXG4gIGlmIChzbmFwc2hvdC5wZW5kaW5nR2F0ZUlkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGJsb2NrOiB0cnVlLFxuICAgICAgcmVhc29uOiBbXG4gICAgICAgIGBIQVJEIEJMT0NLOiBDYW5ub3Qgc2F2ZSAke2FydGlmYWN0VHlwZX0ubWQgYmVjYXVzZSBkaXNjdXNzaW9uIGdhdGUgXCIke3NuYXBzaG90LnBlbmRpbmdHYXRlSWR9XCIgaGFzIG5vdCBiZWVuIGNvbmZpcm1lZCBieSB0aGUgdXNlci5gLFxuICAgICAgICBgVGhpcyBpcyBhIG1lY2hhbmljYWwgZ2F0ZSBcdTIwMTQgd2FpdCBmb3IgZXhwbGljaXQgdXNlciBhcHByb3ZhbCBiZWZvcmUgd3JpdGluZyBmaW5hbCBwcm9qZWN0IHNldHVwIGFydGlmYWN0cy5gLFxuICAgICAgICBgSWYgYXBwcm92YWwgd2FzIHJlcXVlc3RlZCBpbiBwbGFpbiB0ZXh0LCB0aGUgdXNlciBtdXN0IHJlcGx5IHdpdGggZXhwbGljaXQgYXBwcm92YWwgYmVmb3JlIHRoaXMgd3JpdGUgaXMgYWxsb3dlZC5gLFxuICAgICAgXS5qb2luKFwiIFwiKSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKG9wdHMucmVxdWlyZVZlcmlmaWVkQXBwcm92YWwpIHtcbiAgICBjb25zdCByZXF1aXJlZEdhdGUgPSByZXF1aXJlZFJvb3RBcHByb3ZhbEdhdGVGb3JBcnRpZmFjdChhcnRpZmFjdFR5cGUpO1xuICAgIGlmIChyZXF1aXJlZEdhdGUgJiYgIWlzQXBwcm92YWxHYXRlVmVyaWZpZWRJblNuYXBzaG90KHNuYXBzaG90LCByZXF1aXJlZEdhdGUpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBibG9jazogdHJ1ZSxcbiAgICAgICAgcmVhc29uOiBbXG4gICAgICAgICAgYEhBUkQgQkxPQ0s6IENhbm5vdCBzYXZlICR7YXJ0aWZhY3RUeXBlfS5tZCBiZWZvcmUgZXhwbGljaXQgYXBwcm92YWwgZ2F0ZSBcIiR7cmVxdWlyZWRHYXRlfVwiIGlzIHZlcmlmaWVkLmAsXG4gICAgICAgICAgYERlZXAgcGxhbm5pbmcgcm9vdCBhcnRpZmFjdHMgYXJlIGZhaWwtY2xvc2VkOiBhYnNlbmNlIG9mIGEgcGVuZGluZyBnYXRlIGlzIG5vdCBhcHByb3ZhbC5gLFxuICAgICAgICAgIGBBc2sgdGhlIHVzZXIgdG8gY29uZmlybSB0aGUgJHthcnRpZmFjdFR5cGV9Lm1kIHByZXZpZXcgYW5kIHdhaXQgZm9yIGFuIGV4cGxpY2l0IGFwcHJvdmFsIHJlc3BvbnNlLmAsXG4gICAgICAgIF0uam9pbihcIiBcIiksXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xufVxuXG4vKipcbiAqIFF1ZXVlLW1vZGUgZXhlY3V0aW9uIGd1YXJkICgjMjU0NSkuXG4gKlxuICogV2hlbiB0aGUgcXVldWUgcGhhc2UgaXMgYWN0aXZlLCB0aGUgYWdlbnQgc2hvdWxkIG9ubHkgY3JlYXRlIHBsYW5uaW5nXG4gKiBhcnRpZmFjdHMgKG1pbGVzdG9uZXMsIENPTlRFWFQubWQsIFFVRVVFLm1kLCBldGMuKSBcdTIwMTQgbmV2ZXIgZXhlY3V0ZSB3b3JrLlxuICogVGhpcyBmdW5jdGlvbiBibG9ja3Mgd3JpdGUvZWRpdC9iYXNoIHRvb2wgY2FsbHMgdGhhdCB3b3VsZCBtb2RpZnkgc291cmNlXG4gKiBjb2RlIG91dHNpZGUgb2YgLmdzZC8uXG4gKlxuICogQHBhcmFtIHRvb2xOYW1lICBUaGUgdG9vbCBiZWluZyBjYWxsZWQgKHdyaXRlLCBlZGl0LCBiYXNoLCBldGMuKVxuICogQHBhcmFtIGlucHV0ICAgICBGb3Igd3JpdGUvZWRpdDogdGhlIGZpbGUgcGF0aC4gRm9yIGJhc2g6IHRoZSBjb21tYW5kIHN0cmluZy5cbiAqIEBwYXJhbSBxdWV1ZVBoYXNlQWN0aXZlICBXaGV0aGVyIHRoZSBxdWV1ZSBwaGFzZSBpcyBjdXJyZW50bHkgYWN0aXZlLlxuICogQHJldHVybnMgeyBibG9jaywgcmVhc29uIH0gXHUyMDE0IGJsb2NrPXRydWUgaWYgdGhlIGNhbGwgc2hvdWxkIGJlIHJlamVjdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkQmxvY2tRdWV1ZUV4ZWN1dGlvbihcbiAgdG9vbE5hbWU6IHN0cmluZyxcbiAgaW5wdXQ6IHN0cmluZyxcbiAgcXVldWVQaGFzZUFjdGl2ZTogYm9vbGVhbixcbik6IHsgYmxvY2s6IGJvb2xlYW47IHJlYXNvbj86IHN0cmluZyB9IHtcbiAgcmV0dXJuIHNob3VsZEJsb2NrUXVldWVFeGVjdXRpb25JblNuYXBzaG90KGN1cnJlbnRXcml0ZUdhdGVTbmFwc2hvdCgpLCB0b29sTmFtZSwgaW5wdXQsIHF1ZXVlUGhhc2VBY3RpdmUpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkQmxvY2tRdWV1ZUV4ZWN1dGlvbkluU25hcHNob3QoXG4gIHNuYXBzaG90OiBXcml0ZUdhdGVTbmFwc2hvdCxcbiAgdG9vbE5hbWU6IHN0cmluZyxcbiAgaW5wdXQ6IHN0cmluZyxcbiAgcXVldWVQaGFzZUFjdGl2ZTogYm9vbGVhbiA9IHNuYXBzaG90LmFjdGl2ZVF1ZXVlUGhhc2UsXG4pOiB7IGJsb2NrOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfSB7XG4gIGlmICghcXVldWVQaGFzZUFjdGl2ZSkgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG5cbiAgLy8gQWx3YXlzLXNhZmUgdG9vbHMgKHJlYWQtb25seSwgZGlzY3Vzc2lvbiwgcGxhbm5pbmcpXG4gIGlmIChRVUVVRV9TQUZFX1RPT0xTLmhhcyh0b29sTmFtZSkpIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuXG4gIC8vIHdyaXRlL2VkaXQgXHUyMDE0IGFsbG93IGlmIHRhcmdldGluZyAuZ3NkLyBwbGFubmluZyBhcnRpZmFjdHNcbiAgaWYgKHRvb2xOYW1lID09PSBcIndyaXRlXCIgfHwgdG9vbE5hbWUgPT09IFwiZWRpdFwiKSB7XG4gICAgaWYgKEdTRF9ESVJfUkUudGVzdChpbnB1dCkpIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuICAgIHJldHVybiB7XG4gICAgICBibG9jazogdHJ1ZSxcbiAgICAgIHJlYXNvbjogYEJsb2NrZWQ6IC9nc2QgcXVldWUgaXMgYSBwbGFubmluZyB0b29sIFx1MjAxNCBpdCBjcmVhdGVzIG1pbGVzdG9uZXMsIG5vdCBleGVjdXRlcyB3b3JrLiBgICtcbiAgICAgICAgYENhbm5vdCAke3Rvb2xOYW1lfSB0byBcIiR7aW5wdXR9XCIgZHVyaW5nIHF1ZXVlIG1vZGUuIGAgK1xuICAgICAgICBgV3JpdGUgQ09OVEVYVC5tZCBmaWxlcyBhbmQgdXBkYXRlIFBST0pFQ1QubWQvUVVFVUUubWQgaW5zdGVhZC5gLFxuICAgIH07XG4gIH1cblxuICAvLyBiYXNoIFx1MjAxNCBhbGxvdyByZWFkLW9ubHkvaW52ZXN0aWdhdGl2ZSBjb21tYW5kcywgYmxvY2sgZXZlcnl0aGluZyBlbHNlXG4gIGlmICh0b29sTmFtZSA9PT0gXCJiYXNoXCIpIHtcbiAgICBpZiAoQkFTSF9SRUFEX09OTFlfUkUudGVzdChpbnB1dCkpIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuICAgIHJldHVybiB7XG4gICAgICBibG9jazogdHJ1ZSxcbiAgICAgIHJlYXNvbjogYEJsb2NrZWQ6IC9nc2QgcXVldWUgaXMgYSBwbGFubmluZyB0b29sIFx1MjAxNCBpdCBjcmVhdGVzIG1pbGVzdG9uZXMsIG5vdCBleGVjdXRlcyB3b3JrLiBgICtcbiAgICAgICAgYENhbm5vdCBydW4gXCIke2lucHV0LnNsaWNlKDAsIDgwKX0ke2lucHV0Lmxlbmd0aCA+IDgwID8gXCJcdTIwMjZcIiA6IFwiXCJ9XCIgZHVyaW5nIHF1ZXVlIG1vZGUuIGAgK1xuICAgICAgICBgVXNlIHJlYWQtb25seSBjb21tYW5kcyAoY2F0LCBncmVwLCBnaXQgbG9nLCBldGMuKSB0byBpbnZlc3RpZ2F0ZSwgdGhlbiB3cml0ZSBwbGFubmluZyBhcnRpZmFjdHMuYCxcbiAgICB9O1xuICB9XG5cbiAgLy8gVW5rbm93biB0b29scyBcdTIwMTQgYmxvY2sgYnkgZGVmYXVsdCBpbiBxdWV1ZSBtb2RlIHNvIGN1c3RvbSB0b29scyBjYW5ub3RcbiAgLy8gYnlwYXNzIGV4ZWN1dGlvbiByZXN0cmljdGlvbnMuXG4gIHJldHVybiB7XG4gICAgYmxvY2s6IHRydWUsXG4gICAgcmVhc29uOiBgQmxvY2tlZDogL2dzZCBxdWV1ZSBpcyBhIHBsYW5uaW5nIHRvb2wgXHUyMDE0IGl0IGNyZWF0ZXMgbWlsZXN0b25lcywgbm90IGV4ZWN1dGVzIHdvcmsuIFVua25vd24gdG9vbHMgYXJlIG5vdCBwZXJtaXR0ZWQgZHVyaW5nIHF1ZXVlIG1vZGUuYCxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBsYW5uaW5nLXVuaXQgdG9vbHMtcG9saWN5IGVuZm9yY2VtZW50ICgjNDkzNCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vL1xuLy8gUnVudGltZSBoYWxmIG9mIHRoZSBkZWNsYXJhdGl2ZSBUb29sc1BvbGljeSBvbiBVbml0Q29udGV4dE1hbmlmZXN0LiBUaGVcbi8vIG1hbmlmZXN0IGFzc2lnbnMgZWFjaCB1bml0IHR5cGUgYSB0b29scyBtb2RlOyB0aGlzIHByZWRpY2F0ZSBpcyB3aGF0XG4vLyBhY3R1YWxseSByZWplY3RzIGEgdG9vbCBjYWxsIHRoYXQgdmlvbGF0ZXMgaXQuXG4vL1xuLy8gRm9yZW5zaWNzOiBhIGRpc2N1c3MtbWlsZXN0b25lIExMTSB0dXJuIHVzZWQgdGhlIGhvc3QgRWRpdCB0b29sIHRvIG1vZGlmeVxuLy8gaW5kZXguaHRtbCBpbiB0ZXN0IGFwcCBiMjMgKH4vR2l0aHViL3Rlc3QtYXBwcy9iMjMpLiBXaXRoIHRoaXMgcHJlZGljYXRlXG4vLyB3aXJlZCBpbnRvIHRoZSB0b29sX2NhbGwgaG9vaywgdGhlIHNhbWUgY2FsbCByZXR1cm5zIGJsb2NrPXRydWUgd2l0aCBhXG4vLyBIQVJEIEJMT0NLIHJlYXNvbiB0aGF0IHRoZSBtb2RlbCBjYW5ub3QgcmF0aW9uYWxpemUgcGFzdC5cbi8vXG4vLyBBY3RpdmF0aW9uOiB0aGUgaG9vayBzdXBwbGllcyB0aGUgcG9saWN5IHJlc29sdmVkIGZyb20gdGhlIGFjdGl2ZSB1bml0J3Ncbi8vIG1hbmlmZXN0LiBXaGVuIG5vIHVuaXQgaXMgYWN0aXZlIChpbnRlcmFjdGl2ZSBzZXNzaW9ucywgdW5rbm93biB1bml0XG4vLyB0eXBlcyksIHRoZSBob29rIHBhc3NlcyBudWxsIGFuZCB0aGlzIHByZWRpY2F0ZSBpcyBhIG5vLW9wIFx1MjAxNCBmYWxsaW5nXG4vLyB0aHJvdWdoIHRvIHRoZSBleGlzdGluZyBwZW5kaW5nR2F0ZSAvIHF1ZXVlLWV4ZWN1dGlvbiAvIGNvbnRleHQtd3JpdGVcbi8vIGd1YXJkcy5cblxuY29uc3QgUExBTk5JTkdfV1JJVEVfVE9PTFMgPSBuZXcgU2V0KFtcIndyaXRlXCIsIFwiZWRpdFwiLCBcIm11bHRpX2VkaXRcIiwgXCJub3RlYm9va19lZGl0XCJdKTtcbmNvbnN0IFBMQU5OSU5HX1NVQkFHRU5UX1RPT0xTID0gbmV3IFNldChbXCJzdWJhZ2VudFwiLCBcInRhc2tcIl0pO1xuXG4vKipcbiAqIENhbm9uaWNhbCByZWdpc3RyeSBmb3IgYWdlbnRzIHRoYXQgcGxhbm5pbmctZGlzcGF0Y2ggbWF5IGNvbnNpZGVyLiBVbml0XG4gKiBtYW5pZmVzdHMgc3RpbGwgZGVjbGFyZSBwZXItdW5pdCBzdWJzZXRzIHZpYSBUb29sc1BvbGljeS5hbGxvd2VkU3ViYWdlbnRzLlxuICovXG5jb25zdCBQTEFOTklOR19ESVNQQVRDSF9BR0VOVF9SRUdJU1RSWSA9IHtcbiAgc2NvdXQ6IHsgcmVhZE9ubHlTcGVjaWFsaXN0OiB0cnVlIH0sXG4gIHBsYW5uZXI6IHsgcmVhZE9ubHlTcGVjaWFsaXN0OiB0cnVlIH0sXG4gIHJldmlld2VyOiB7IHJlYWRPbmx5U3BlY2lhbGlzdDogdHJ1ZSB9LFxuICBzZWN1cml0eTogeyByZWFkT25seVNwZWNpYWxpc3Q6IHRydWUgfSxcbiAgdGVzdGVyOiB7IHJlYWRPbmx5U3BlY2lhbGlzdDogdHJ1ZSB9LFxufSBhcyBjb25zdCBzYXRpc2ZpZXMgUmVjb3JkPHN0cmluZywgeyByZWFkb25seSByZWFkT25seVNwZWNpYWxpc3Q6IGJvb2xlYW4gfT47XG5cbmV4cG9ydCBjb25zdCBBTExPV0VEX1BMQU5OSU5HX0RJU1BBVENIX0FHRU5UUyA9IG5ldyBTZXQ8c3RyaW5nPihcbiAgT2JqZWN0LmVudHJpZXMoUExBTk5JTkdfRElTUEFUQ0hfQUdFTlRfUkVHSVNUUlkpXG4gICAgLmZpbHRlcigoWywgbWV0YWRhdGFdKSA9PiBtZXRhZGF0YS5yZWFkT25seVNwZWNpYWxpc3QpXG4gICAgLm1hcCgoW2FnZW50SWRdKSA9PiBhZ2VudElkKSxcbik7XG5cbmxldCB3YXJuZWRNaXNzaW5nUGxhbm5pbmdEaXNwYXRjaEFnZW50Q2xhc3NlcyA9IGZhbHNlO1xuXG5mdW5jdGlvbiBpc1JlYWRPbmx5U3BlY2lhbGlzdChhZ2VudElkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbWV0YWRhdGEgPSBQTEFOTklOR19ESVNQQVRDSF9BR0VOVF9SRUdJU1RSWVthZ2VudElkIGFzIGtleW9mIHR5cGVvZiBQTEFOTklOR19ESVNQQVRDSF9BR0VOVF9SRUdJU1RSWV07XG4gIHJldHVybiBtZXRhZGF0YT8ucmVhZE9ubHlTcGVjaWFsaXN0ID09PSB0cnVlO1xufVxuXG5mdW5jdGlvbiBhbGxvd2VkUGxhbm5pbmdEaXNwYXRjaEFnZW50c0xpc3QoKTogc3RyaW5nIHtcbiAgcmV0dXJuIFsuLi5BTExPV0VEX1BMQU5OSU5HX0RJU1BBVENIX0FHRU5UU10uam9pbihcIiwgXCIpO1xufVxuXG5mdW5jdGlvbiB3YXJuTWlzc2luZ1BsYW5uaW5nRGlzcGF0Y2hBZ2VudENsYXNzZXModW5pdFR5cGU6IHN0cmluZywgbW9kZTogc3RyaW5nLCB0b29sTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICh3YXJuZWRNaXNzaW5nUGxhbm5pbmdEaXNwYXRjaEFnZW50Q2xhc3NlcykgcmV0dXJuO1xuICB3YXJuZWRNaXNzaW5nUGxhbm5pbmdEaXNwYXRjaEFnZW50Q2xhc3NlcyA9IHRydWU7XG4gIC8vIFRPRE8oIzUwNjApOiBSZW1vdmUgdGhpcyBtaWdyYXRpb24gc2hpbSBvbmNlIGFsbCBzdWJhZ2VudC90YXNrIGNhbGxlcnMgYXJlIHZlcmlmaWVkIHRvIGZvcndhcmQgYWdlbnQgaWRlbnRpdGllcy5cbiAgY29uc3QgbWVzc2FnZSA9IGBbd3JpdGUtZ2F0ZV0gcGxhbm5pbmctZGlzcGF0Y2g6IHNob3VsZEJsb2NrUGxhbm5pbmdVbml0IGNhbGxlZCBmb3IgdG9vbCBcIiR7dG9vbE5hbWV9XCIgYCArXG4gICAgYG9uIHVuaXQgXCIke3VuaXRUeXBlfVwiIHdpdGhvdXQgYWdlbnRDbGFzc2VzIC0gc3RhbGUgY2FsbGVyOyBibG9ja2luZyBkaXNwYXRjaC5gO1xuICBjb25zb2xlLndhcm4obWVzc2FnZSk7XG4gIGxvZ1dhcm5pbmcoXCJpbnRlcmNlcHRcIiwgbWVzc2FnZSwge1xuICAgIHVuaXRUeXBlLFxuICAgIG1vZGUsXG4gICAgdG9vbE5hbWUsXG4gIH0pO1xufVxuXG4vKipcbiAqIFJlYWQtb25seSAvIHBsYW5uaW5nLXNhZmUgdG9vbHMgdGhhdCBhbnkgbm9uLVwiYWxsXCIgbW9kZSBhbGxvd3MuIE1pcnJvcnNcbiAqIFFVRVVFX1NBRkVfVE9PTFMgLyBHQVRFX1NBRkVfVE9PTFMgYnV0IGlzIHRoZSBpbmNsdXNpdmUgZGVmYXVsdCBmb3JcbiAqIHBsYW5uaW5nIHVuaXRzICh3aGljaCBuZWVkIHRoZWlyIGZ1bGwgZGlzY3Vzc2lvbiArIHJlc2VhcmNoIHN1cmZhY2UpLlxuICpcbiAqIGdzZF8qIE1DUCB0b29scyBhcmUgcGFzc2VkIHRocm91Z2ggdW5jb25kaXRpb25hbGx5IFx1MjAxNCB0aGV5IGhhdmUgdGhlaXIgb3duXG4gKiBkb21haW4gdmFsaWRhdGlvbiAoZS5nLiBkZXB0aC12ZXJpZmljYXRpb24gZ2F0ZSwgc2luZ2xlLXdyaXRlciBEQikuXG4gKi9cbmNvbnN0IFBMQU5OSU5HX1NBRkVfVE9PTFMgPSBuZXcgU2V0KFtcbiAgXCJyZWFkXCIsIFwiZ3JlcFwiLCBcImZpbmRcIiwgXCJsc1wiLCBcImdsb2JcIixcbiAgXCJhc2tfdXNlcl9xdWVzdGlvbnNcIixcbiAgXCJzZWFyY2gtdGhlLXdlYlwiLCBcInJlc29sdmVfbGlicmFyeVwiLCBcImdldF9saWJyYXJ5X2RvY3NcIiwgXCJmZXRjaF9wYWdlXCIsXG4gIFwic2VhcmNoX2FuZF9yZWFkXCIsXG5dKTtcblxuZnVuY3Rpb24gaXNQYXRoVW5kZXJHc2QoYWJzUGF0aDogc3RyaW5nLCBiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGdzZFJvb3QgPSByZXNvbHZlKGJhc2VQYXRoLCBcIi5nc2RcIik7XG4gIGNvbnN0IHJlbCA9IHJlbGF0aXZlKGdzZFJvb3QsIGFic1BhdGgpO1xuICByZXR1cm4gcmVsID09PSBcIlwiIHx8ICghcmVsLnN0YXJ0c1dpdGgoXCIuLlwiKSAmJiAhaXNBYnNvbHV0ZShyZWwpKTtcbn1cblxuZnVuY3Rpb24gbWF0Y2hlc0FsbG93ZWRHbG9iKGFic1BhdGg6IHN0cmluZywgYmFzZVBhdGg6IHN0cmluZywgZ2xvYnM6IHJlYWRvbmx5IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIGNvbnN0IHJlbCA9IHJlbGF0aXZlKGJhc2VQYXRoLCBhYnNQYXRoKTtcbiAgaWYgKHJlbC5zdGFydHNXaXRoKFwiLi5cIikgfHwgaXNBYnNvbHV0ZShyZWwpKSByZXR1cm4gZmFsc2U7XG4gIC8vIE5vcm1hbGl6ZSBXaW5kb3dzIHNlcGFyYXRvcnMgZm9yIG1pbmltYXRjaC5cbiAgY29uc3QgcG9zaXggPSByZWwuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcbiAgcmV0dXJuIGdsb2JzLnNvbWUoZyA9PiBtaW5pbWF0Y2gocG9zaXgsIGcsIHsgZG90OiBmYWxzZSwgbm9jYXNlOiBmYWxzZSB9KSk7XG59XG5cbmZ1bmN0aW9uIGJsb2NrUmVhc29uKHVuaXRUeXBlOiBzdHJpbmcsIG1vZGU6IHN0cmluZywgd2hhdDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBgSEFSRCBCTE9DSzogdW5pdCBcIiR7dW5pdFR5cGV9XCIgcnVucyB1bmRlciB0b29scy1wb2xpY3kgXCIke21vZGV9XCIgXHUyMDE0ICR7d2hhdH0uYCxcbiAgICBgVGhpcyBpcyBhIG1lY2hhbmljYWwgZ2F0ZSBlbmZvcmNlZCBieSBtYW5pZmVzdC50b29scyAoIzQ5MzQpLiBZb3UgTVVTVCBOT1QgcHJvY2VlZCxgLFxuICAgIGByZXRyeSB0aGUgc2FtZSBjYWxsLCBvciByYXRpb25hbGl6ZSBwYXN0IHRoaXMgYmxvY2suIElmIHlvdSBuZWVkIHRvIHdyaXRlIHVzZXIgc291cmNlLGAsXG4gICAgYHRoZSB3b3JrIGJlbG9uZ3MgaW4gZXhlY3V0ZS10YXNrLCBub3QgaW4gYSBwbGFubmluZyB1bml0LmAsXG4gIF0uam9pbihcIiBcIik7XG59XG5cbi8qKlxuICogUGxhbm5pbmctdW5pdCB0b29sLXBvbGljeSBlbmZvcmNlbWVudC4gUmV0dXJucyB7IGJsb2NrIH0gcGVyIHRoZSBwb2xpY3lcbiAqIHJlc29sdmVkIGZyb20gdGhlIGFjdGl2ZSB1bml0J3MgbWFuaWZlc3Q6XG4gKlxuICogICAtIFwiYWxsXCIgICAgICAgIFx1MjE5MiBuZXZlciBibG9ja3MuXG4gKiAgIC0gXCJyZWFkLW9ubHlcIiAgXHUyMTkyIGJsb2NrcyBhbGwgd3JpdGVzLCBiYXNoLCBhbmQgc3ViYWdlbnQgZGlzcGF0Y2guXG4gKiAgIC0gXCJwbGFubmluZ1wiICAgXHUyMTkyIGJsb2NrcyB3cml0ZXMgdG8gcGF0aHMgb3V0c2lkZSA8YmFzZVBhdGg+Ly5nc2QvLFxuICogICAgICAgICAgICAgICAgICAgIGJhc2ggdGhhdCBpc24ndCByZWFkLW9ubHksIGFuZCBzdWJhZ2VudCBkaXNwYXRjaC5cbiAqICAgLSBcInBsYW5uaW5nLWRpc3BhdGNoXCJcbiAqICAgICAgICAgICAgICAgICAgXHUyMTkyIGxpa2UgXCJwbGFubmluZ1wiLCBidXQgcGVybWl0cyBzdWJhZ2VudCBkaXNwYXRjaCBvbmx5XG4gKiAgICAgICAgICAgICAgICAgICAgd2hlbiBldmVyeSBmb3J3YXJkZWQgYWdlbnQgY2xhc3MgaXMgZ2xvYmFsbHkgYWxsb3dlZFxuICogICAgICAgICAgICAgICAgICAgIGFuZCBsaXN0ZWQgaW4gdGhlIHBvbGljeSdzIGFsbG93ZWRTdWJhZ2VudHMuXG4gKiAgIC0gXCJkb2NzXCIgICAgICAgXHUyMTkyIGxpa2UgXCJwbGFubmluZ1wiIGJ1dCBhbHNvIGFsbG93cyB3cml0ZXMgdG8gcGF0aHNcbiAqICAgICAgICAgICAgICAgICAgICBtYXRjaGluZyBgYWxsb3dlZFBhdGhHbG9ic2AgcmVsYXRpdmUgdG8gYmFzZVBhdGguXG4gKiAgIC0gXCJ2ZXJpZmljYXRpb25cIlxuICogICAgICAgICAgICAgICAgICBcdTIxOTIgYWxsb3dzIEJhc2ggZm9yIHByb2plY3QgdmVyaWZpY2F0aW9uIGNvbW1hbmRzLCBidXQga2VlcHNcbiAqICAgICAgICAgICAgICAgICAgICB3cml0ZXMgcmVzdHJpY3RlZCB0byAuZ3NkLyBhbmQgYmxvY2tzIHN1YmFnZW50IGRpc3BhdGNoLlxuICpcbiAqIGBwYXRoT3JDb21tYW5kYCBpcyB0aGUgZmlsZSBwYXRoIGZvciB3cml0ZS9lZGl0LXNoYXBlZCB0b29scyBhbmQgdGhlXG4gKiBzaGVsbCBjb21tYW5kIGZvciBiYXNoLiBPdGhlciB0b29scyBpZ25vcmUgdGhpcyBhcmd1bWVudC5cbiAqXG4gKiBgcG9saWN5YCBvZiBudWxsIG1lYW5zIFwibm8gbWFuaWZlc3QgcmVzb2x2ZWRcIiBcdTIwMTQgcGFzcy10aHJvdWdoLiBDYWxsZXJzXG4gKiB0aGF0IGhhdmUgbm8gYWN0aXZlIHVuaXQgKGludGVyYWN0aXZlIHNlc3Npb25zKSBwYXNzIG51bGwgYW5kIHRoaXNcbiAqIHByZWRpY2F0ZSBpcyBhIG5vLW9wLlxuICpcbiAqIGBhZ2VudENsYXNzZXNgIGlzIHN1cHBsaWVkIGJ5IHRoZSB0b29sIGhvb2sgZm9yIHN1YmFnZW50LXNoYXBlZCBjYWxscy4gSWZcbiAqIGFic2VudCwgcGxhbm5pbmctZGlzcGF0Y2ggZmFpbHMgY2xvc2VkIHNvIHN0YWxlIGNhbGxlcnMgY2Fubm90IHNpbGVudGx5XG4gKiBieXBhc3MgdGhlIGFnZW50IGFsbG93bGlzdHMuIEFuIGV4cGxpY2l0bHkgc3VwcGxpZWQtYnV0LWVtcHR5IGxpc3QgaXNcbiAqIGFsbG93ZWQgdGhyb3VnaCBzbyB0aGUgZG93bnN0cmVhbSB0b29sIGNhbGwgY2FuIHJlamVjdCB0aGUgbWFsZm9ybWVkIGlucHV0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkQmxvY2tQbGFubmluZ1VuaXQoXG4gIHRvb2xOYW1lOiBzdHJpbmcsXG4gIHBhdGhPckNvbW1hbmQ6IHN0cmluZyxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgcG9saWN5OiBUb29sc1BvbGljeSB8IG51bGwgfCB1bmRlZmluZWQsXG4gIGFnZW50Q2xhc3Nlcz86IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogeyBibG9jazogYm9vbGVhbjsgcmVhc29uPzogc3RyaW5nIH0ge1xuICBpZiAoIXBvbGljeSkgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG4gIGlmIChwb2xpY3kubW9kZSA9PT0gXCJhbGxcIikgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG5cbiAgY29uc3QgdG9vbCA9IHRvb2xOYW1lO1xuXG4gIC8vIFJlYWQtb25seSBtb2RlOiBvbmx5IFJlYWQtY2xhc3MgdG9vbHMgYXJlIHBlcm1pdHRlZC5cbiAgaWYgKHBvbGljeS5tb2RlID09PSBcInJlYWQtb25seVwiKSB7XG4gICAgaWYgKFBMQU5OSU5HX1NBRkVfVE9PTFMuaGFzKHRvb2wpKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgICBpZiAodG9vbC5zdGFydHNXaXRoKFwiZ3NkX1wiKSkgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG4gICAgaWYgKFBMQU5OSU5HX1dSSVRFX1RPT0xTLmhhcyh0b29sKSB8fCB0b29sID09PSBcImJhc2hcIiB8fCBQTEFOTklOR19TVUJBR0VOVF9UT09MUy5oYXModG9vbCkpIHtcbiAgICAgIHJldHVybiB7IGJsb2NrOiB0cnVlLCByZWFzb246IGJsb2NrUmVhc29uKHVuaXRUeXBlLCBwb2xpY3kubW9kZSwgYCR7dG9vbH0gaXMgbm90IHBlcm1pdHRlZCAocmVhZC1vbmx5KWApIH07XG4gICAgfVxuICAgIC8vIFVua25vd24gdG9vbCBpbiByZWFkLW9ubHkgbW9kZSBcdTIwMTQgYmxvY2sgYnkgZGVmYXVsdC5cbiAgICByZXR1cm4geyBibG9jazogdHJ1ZSwgcmVhc29uOiBibG9ja1JlYXNvbih1bml0VHlwZSwgcG9saWN5Lm1vZGUsIGB0b29sIFwiJHt0b29sfVwiIGlzIG5vdCBvbiB0aGUgcmVhZC1vbmx5IGFsbG93bGlzdGApIH07XG4gIH1cblxuICAvLyBwbGFubmluZyAvIHBsYW5uaW5nLWRpc3BhdGNoIC8gZG9jcyAvIHZlcmlmaWNhdGlvbiBtb2RlcyBzaGFyZSB0aGUgc2FtZSBzdXJmYWNlIGZvciBzYWZlIHRvb2xzLCBiYXNoLCBhbmQgc3ViYWdlbnQuXG4gIGlmIChQTEFOTklOR19TQUZFX1RPT0xTLmhhcyh0b29sKSkgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG4gIGlmICh0b29sLnN0YXJ0c1dpdGgoXCJnc2RfXCIpKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcblxuICBpZiAoUExBTk5JTkdfU1VCQUdFTlRfVE9PTFMuaGFzKHRvb2wpKSB7XG4gICAgaWYgKHBvbGljeS5tb2RlID09PSBcInBsYW5uaW5nLWRpc3BhdGNoXCIpIHtcbiAgICAgIGNvbnN0IHJlcXVlc3RlZCA9IChhZ2VudENsYXNzZXMgPz8gW10pLm1hcChhID0+IGEudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgICBjb25zdCBkaXNwYXRjaENvbnRyYWN0ID0gY29tcGlsZVN1YmFnZW50UGVybWlzc2lvbkNvbnRyYWN0KHBvbGljeSk7XG4gICAgICBjb25zdCBhbGxvd2VkU3ViYWdlbnRzID0gZGlzcGF0Y2hDb250cmFjdC5hbGxvd2VkU3ViYWdlbnRzO1xuICAgICAgY29uc3QgYWxsb3dlZCA9IG5ldyBTZXQoYWxsb3dlZFN1YmFnZW50cyk7XG4gICAgICAvLyBXaGVuIGFnZW50Q2xhc3NlcyBpcyB1bmRlZmluZWQsIHRoZSBjYWxsZXIgaGFzIG5vdCBiZWVuIHVwZGF0ZWQgdG8gZXh0cmFjdFxuICAgICAgLy8gYWdlbnQgaWRlbnRpdGllcyB5ZXQuIEJsb2NrIGFuZCB3YXJuIHNvIHN0YWxlIGNhbGxlcnMgc3VyZmFjZSBpbiB0ZWxlbWV0cnlcbiAgICAgIC8vIGluc3RlYWQgb2Ygc2lsZW50bHkgYnlwYXNzaW5nIHRoZSBnYXRlLlxuICAgICAgaWYgKGFnZW50Q2xhc3NlcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHdhcm5NaXNzaW5nUGxhbm5pbmdEaXNwYXRjaEFnZW50Q2xhc3Nlcyh1bml0VHlwZSwgcG9saWN5Lm1vZGUsIHRvb2wpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGJsb2NrOiB0cnVlLFxuICAgICAgICAgIHJlYXNvbjogYmxvY2tSZWFzb24oXG4gICAgICAgICAgICB1bml0VHlwZSxcbiAgICAgICAgICAgIHBvbGljeS5tb2RlLFxuICAgICAgICAgICAgYHN1YmFnZW50IGRpc3BhdGNoIGJsb2NrZWQ6IHN0YWxlIGNhbGxlciBkaWQgbm90IHN1cHBseSBhZ2VudCBpZGVudGl0aWVzIGZvciBcIiR7dG9vbH1cIjsgdXBkYXRlIGV4dHJhY3RTdWJhZ2VudEFnZW50Q2xhc3NlcyB0byBoYW5kbGUgdGhpcyBpbnB1dCBzaGFwZWAsXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIC8vIGFnZW50Q2xhc3NlcyB3YXMgZXhwbGljaXRseSBwcm92aWRlZCBidXQgcmVzb2x2ZWQgdG8gYW4gZW1wdHkgbGlzdCAoZm9yXG4gICAgICAvLyBleGFtcGxlLCBhIGJhcmUgdG9vbCBjYWxsIHdpdGggbm8gYWdlbnQgZmllbGQpLiBQYXNzIHRocm91Z2g7IG5vIGFnZW50c1xuICAgICAgLy8gdG8gdmFsaWRhdGUgbWVhbnMgdGhlIGRvd25zdHJlYW0gdG9vbCBjYWxsIGl0c2VsZiB3aWxsIGZhaWwuXG4gICAgICBpZiAocmVxdWVzdGVkLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGdsb2JhbGx5RGlzYWxsb3dlZCA9IHJlcXVlc3RlZC5maW5kKGEgPT4gIWlzUmVhZE9ubHlTcGVjaWFsaXN0KGEpKTtcbiAgICAgIGlmIChnbG9iYWxseURpc2FsbG93ZWQpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBibG9jazogdHJ1ZSxcbiAgICAgICAgICByZWFzb246IGJsb2NrUmVhc29uKFxuICAgICAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgICAgICBwb2xpY3kubW9kZSxcbiAgICAgICAgICAgIGBzdWJhZ2VudCBkaXNwYXRjaCBvZiBcIiR7Z2xvYmFsbHlEaXNhbGxvd2VkfVwiIG5vdCBwZXJtaXR0ZWQ7IG9ubHkgcmVhZC1vbmx5IHNwZWNpYWxpc3RzICgke2FsbG93ZWRQbGFubmluZ0Rpc3BhdGNoQWdlbnRzTGlzdCgpfSkgbWF5IGJlIGRpc3BhdGNoZWQgZnJvbSBwbGFubmluZy1kaXNwYXRjaCB1bml0c2AsXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGRpc2FsbG93ZWRCeVBvbGljeSA9IHJlcXVlc3RlZC5maW5kKGEgPT4gIWFsbG93ZWQuaGFzKGEpKTtcbiAgICAgIGlmIChkaXNhbGxvd2VkQnlQb2xpY3kpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBibG9jazogdHJ1ZSxcbiAgICAgICAgICByZWFzb246IGJsb2NrUmVhc29uKFxuICAgICAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgICAgICBwb2xpY3kubW9kZSxcbiAgICAgICAgICAgIGBzdWJhZ2VudCBkaXNwYXRjaCBvZiBcIiR7ZGlzYWxsb3dlZEJ5UG9saWN5fVwiIG5vdCBwZXJtaXR0ZWQgYnkgVG9vbHNQb2xpY3kuYWxsb3dlZFN1YmFnZW50czsgcGVybWl0dGVkIGFnZW50cyBmb3IgdGhpcyB1bml0OiAke2FsbG93ZWRTdWJhZ2VudHMuam9pbihcIiwgXCIpfWAsXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuICAgIH1cbiAgICByZXR1cm4geyBibG9jazogdHJ1ZSwgcmVhc29uOiBibG9ja1JlYXNvbih1bml0VHlwZSwgcG9saWN5Lm1vZGUsIGBzdWJhZ2VudCBkaXNwYXRjaCBpcyBub3QgcGVybWl0dGVkIGluIHBsYW5uaW5nIHVuaXRzYCkgfTtcbiAgfVxuXG4gIGlmICh0b29sID09PSBcImJhc2hcIikge1xuICAgIGlmIChwb2xpY3kubW9kZSA9PT0gXCJ2ZXJpZmljYXRpb25cIikge1xuICAgICAgaWYgKEJBU0hfVkVSSUZJQ0FUSU9OX1JFLnRlc3QocGF0aE9yQ29tbWFuZCkgfHwgQkFTSF9SRUFEX09OTFlfUkUudGVzdChwYXRoT3JDb21tYW5kKSkgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG4gICAgICByZXR1cm4ge1xuICAgICAgICBibG9jazogdHJ1ZSxcbiAgICAgICAgcmVhc29uOiBibG9ja1JlYXNvbihcbiAgICAgICAgICB1bml0VHlwZSxcbiAgICAgICAgICBwb2xpY3kubW9kZSxcbiAgICAgICAgICBgYmFzaCBpcyByZXN0cmljdGVkIHRvIGJ1aWxkL3Rlc3QgdmVyaWZpY2F0aW9uIGNvbW1hbmRzIChucG0gcnVuIGJ1aWxkLCBucG0gdGVzdCwgZXRjLik7IGNhbm5vdCBydW4gXCIke3BhdGhPckNvbW1hbmQuc2xpY2UoMCwgODApfSR7cGF0aE9yQ29tbWFuZC5sZW5ndGggPiA4MCA/IFwiXHUyMDI2XCIgOiBcIlwifVwiYCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChCQVNIX1JFQURfT05MWV9SRS50ZXN0KHBhdGhPckNvbW1hbmQpKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgICByZXR1cm4ge1xuICAgICAgYmxvY2s6IHRydWUsXG4gICAgICByZWFzb246IGJsb2NrUmVhc29uKFxuICAgICAgICB1bml0VHlwZSxcbiAgICAgICAgcG9saWN5Lm1vZGUsXG4gICAgICAgIGBiYXNoIGlzIHJlc3RyaWN0ZWQgdG8gcmVhZC1vbmx5IGNvbW1hbmRzIChjYXQvZ3JlcC9naXQgbG9nL2V0Yyk7IGNhbm5vdCBydW4gXCIke3BhdGhPckNvbW1hbmQuc2xpY2UoMCwgODApfSR7cGF0aE9yQ29tbWFuZC5sZW5ndGggPiA4MCA/IFwiXHUyMDI2XCIgOiBcIlwifVwiYCxcbiAgICAgICksXG4gICAgfTtcbiAgfVxuXG4gIGlmIChQTEFOTklOR19XUklURV9UT09MUy5oYXModG9vbCkpIHtcbiAgICBpZiAoIXBhdGhPckNvbW1hbmQpIHtcbiAgICAgIHJldHVybiB7IGJsb2NrOiB0cnVlLCByZWFzb246IGJsb2NrUmVhc29uKHVuaXRUeXBlLCBwb2xpY3kubW9kZSwgYCR7dG9vbH0gY2FsbGVkIHdpdGggZW1wdHkgcGF0aGApIH07XG4gICAgfVxuICAgIGNvbnN0IGFic1BhdGggPSBpc0Fic29sdXRlKHBhdGhPckNvbW1hbmQpID8gcGF0aE9yQ29tbWFuZCA6IHJlc29sdmUoYmFzZVBhdGgsIHBhdGhPckNvbW1hbmQpO1xuXG4gICAgLy8gQWx3YXlzIGFsbG93IC5nc2QvIHdyaXRlcyBcdTIwMTQgdGhhdCdzIHdoZXJlIHBsYW5uaW5nIGFydGlmYWN0cyBsaXZlLlxuICAgIGlmIChpc1BhdGhVbmRlckdzZChhYnNQYXRoLCBiYXNlUGF0aCkpIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuXG4gICAgLy8gZG9jcyBtb2RlIGFkZGl0aW9uYWxseSBhbGxvd3MgdGhlIG1hbmlmZXN0J3MgYWxsb3dlZFBhdGhHbG9icy5cbiAgICBpZiAocG9saWN5Lm1vZGUgPT09IFwiZG9jc1wiICYmIG1hdGNoZXNBbGxvd2VkR2xvYihhYnNQYXRoLCBiYXNlUGF0aCwgcG9saWN5LmFsbG93ZWRQYXRoR2xvYnMpKSB7XG4gICAgICByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgYmxvY2s6IHRydWUsXG4gICAgICByZWFzb246IGJsb2NrUmVhc29uKFxuICAgICAgICB1bml0VHlwZSxcbiAgICAgICAgcG9saWN5Lm1vZGUsXG4gICAgICAgIGBjYW5ub3QgJHt0b29sfSBcIiR7cGF0aE9yQ29tbWFuZH1cIiBcdTIwMTQgd3JpdGVzIGFyZSByZXN0cmljdGVkIHRvIC5nc2QvJHtwb2xpY3kubW9kZSA9PT0gXCJkb2NzXCIgPyBcIiBhbmQgXCIgKyBwb2xpY3kuYWxsb3dlZFBhdGhHbG9icy5qb2luKFwiLCBcIikgOiBcIlwifWAsXG4gICAgICApLFxuICAgIH07XG4gIH1cblxuICAvLyBVbmtub3duIHRvb2wgbmFtZSBcdTIwMTQgcGFzcyB0aHJvdWdoLiBPdGhlciBsYXllcnMgKHF1ZXVlLCBwZW5kaW5nLWdhdGUsXG4gIC8vIENPTlRFWFQubWQgd3JpdGUpIGNhdGNoIGtub3duIG11dGF0aW5nIHNoYXBlczsgZGVmYXVsdGluZyB0byBhbGxvdyBoZXJlXG4gIC8vIGF2b2lkcyBicmVha2luZyBnc2RfKiBNQ1AgdG9vbHMgb3IgZnV0dXJlIHNhZmUgYWRkaXRpb25zLlxuICByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFdvcmt0cmVlIGlzb2xhdGlvbiB3cml0ZSBnYXRlICgjNTE5OSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vL1xuLy8gV2hlbiBgZ2l0Lmlzb2xhdGlvbjogd29ya3RyZWVgIGlzIGNvbmZpZ3VyZWQsIHRoZSBwZXItdW5pdCBjb21taXQgcGlwZWxpbmVcbi8vIG9ubHkgcnVucyBpbnNpZGUgdGhlIGF1dG8tbW9kZSBsb29wIChgYXV0by1wb3N0LXVuaXQudHNgKS4gSWYgdGhlIExMTVxuLy8gYXV0aG9ycyBjb2RlIGF0IHRoZSBwcm9qZWN0IHJvb3QgYmVmb3JlIGF1dG8tbW9kZSBpcyBzdGFydGVkLCB0aG9zZSB3cml0ZXNcbi8vIGxhbmQgaW4gdGhlIHdvcmtpbmcgdHJlZSBidXQgbmV2ZXIgcmVhY2ggYSBjb21taXQgXHUyMDE0IHRoZXkncmUgc2lsZW50bHlcbi8vIG9ycGhhbmVkIG91dHNpZGUgZ2l0IGhpc3RvcnkuIFRoaXMgZ3VhcmQgYmxvY2tzIHRob3NlIHdyaXRlcyBhdCB0aGVcbi8vIHRvb2xfY2FsbCBzZWFtIHNvIHRoZSBhZ2VudCByZWNlaXZlcyBhIGNsZWFyIGVycm9yIGluc3RlYWQuXG5cbmNvbnN0IFdPUktUUkVFX0dBVEVfQk9PVFNUUkFQX1VOSVRTID0gbmV3IFNldChbXG4gIFwiZGlzY3Vzcy1taWxlc3RvbmVcIixcbiAgXCJwbGFuLW1pbGVzdG9uZVwiLFxuICBcImluaXRcIixcbl0pO1xuXG5mdW5jdGlvbiByZWFscGF0aE9yUmVzb2x2ZShwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBhYnMgPSByZXNvbHZlKHApO1xuICB0cnkge1xuICAgIHJldHVybiByZWFscGF0aFN5bmMoYWJzKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gUGF0aCBkb2Vzbid0IGV4aXN0ICh5ZXQpIFx1MjAxNCByZWFscGF0aCB0aGUgZGVlcGVzdCBleGlzdGluZyBhbmNlc3RvciBzb1xuICAgIC8vIHBsYXRmb3JtcyB3aGVyZSAvdG1wIC0+IC9wcml2YXRlL3RtcCBkb24ndCBicmVhayBjb250YWlubWVudCBjaGVja3MuXG4gICAgbGV0IGRpciA9IGFicztcbiAgICBjb25zdCB0YWlsOiBzdHJpbmdbXSA9IFtdO1xuICAgIHdoaWxlIChkaXIgJiYgZGlyICE9PSByZXNvbHZlKGRpciwgXCIuLlwiKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVhbCA9IHJlYWxwYXRoU3luYyhkaXIpO1xuICAgICAgICByZXR1cm4gdGFpbC5sZW5ndGggPyBqb2luKHJlYWwsIC4uLnRhaWwucmV2ZXJzZSgpKSA6IHJlYWw7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29uc3QgaWR4ID0gZGlyLmxhc3RJbmRleE9mKHNlcCk7XG4gICAgICAgIGlmIChpZHggPD0gMCkgYnJlYWs7XG4gICAgICAgIHRhaWwucHVzaChkaXIuc2xpY2UoaWR4ICsgMSkpO1xuICAgICAgICBkaXIgPSBkaXIuc2xpY2UoMCwgaWR4KSB8fCBzZXA7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBhYnM7XG4gIH1cbn1cblxuZnVuY3Rpb24gaXNQYXRoQ29udGFpbmVkKHRhcmdldDogc3RyaW5nLCBjb250YWluZXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAodGFyZ2V0ID09PSBjb250YWluZXIpIHJldHVybiB0cnVlO1xuICByZXR1cm4gdGFyZ2V0LnN0YXJ0c1dpdGgoY29udGFpbmVyLmVuZHNXaXRoKHNlcCkgPyBjb250YWluZXIgOiBjb250YWluZXIgKyBzZXApO1xufVxuXG4vKipcbiAqIEJsb2NrIHBsYW5uaW5nLXdyaXRlIHRvb2wgY2FsbHMgdGhhdCB3b3VsZCBsYW5kIGNvZGUgYXQgdGhlIHByb2plY3Qgcm9vdFxuICogd2hpbGUgYGdpdC5pc29sYXRpb246IHdvcmt0cmVlYCBpcyBpbiBlZmZlY3QgYW5kIGF1dG8tbW9kZSBoYXNuJ3QgY3JlYXRlZFxuICogKG9yIGZsaXBwZWQgY3dkIGludG8pIHRoZSBtaWxlc3RvbmUgd29ya3RyZWUuXG4gKlxuICogUHVyZSAvIHVuaXQtdGVzdGFibGUuIENhbGxlcnMgaW4gYHJlZ2lzdGVyLWhvb2tzLnRzYCBzdXBwbHkgdGhlIHJlc29sdmVkXG4gKiBwcm9qZWN0IHJvb3QgYW5kIGN1cnJlbnQgYXV0byBsaXZlbmVzczsgdGhpcyBmdW5jdGlvbiBkb2VzIG5vIEkvTyBiZXlvbmRcbiAqIHJlYWxwYXRoIHJlc29sdXRpb24uXG4gKlxuICogQWxsb3cgcnVsZXMgKGluIG9yZGVyKTpcbiAqICAgMS4gVG9vbCBpc24ndCBhIHBsYW5uaW5nLXdyaXRlICh3cml0ZS9lZGl0L211bHRpX2VkaXQvbm90ZWJvb2tfZWRpdCkuXG4gKiAgIDIuIGBHU0RfRElTQUJMRV9XT1JLVFJFRV9XUklURV9HVUFSRD0xYCBzZWxmLWhvc3RpbmcgYnlwYXNzLlxuICogICAzLiBJc29sYXRpb24gbW9kZSBpcyBub3QgXCJ3b3JrdHJlZVwiLlxuICogICA0LiBBY3RpdmUgdW5pdCBpcyBhIGJvb3RzdHJhcCB1bml0IChkaXNjdXNzLW1pbGVzdG9uZS9wbGFuLW1pbGVzdG9uZS9pbml0KS5cbiAqICAgNS4gVGFyZ2V0IGlzIGluc2lkZSBgPHByb2plY3RSb290Pi8uZ3NkL3dvcmt0cmVlcy9gIChhIHJlYWwgd29ya3RyZWUpLlxuICogICA2LiBUYXJnZXQgaXMgaW5zaWRlIGA8cHJvamVjdFJvb3Q+Ly5nc2QvYCBhbmQgaXNuJ3QgbWFzcXVlcmFkaW5nIGFzIGFcbiAqICAgICAgd29ya3RyZWVzIHNpYmxpbmcgKHJlamVjdHMgdGhlIGAuZ3NkL3dvcmt0cmVlcy1leHRyYS9cdTIwMjZgIHByZWZpeCB0cmljaykuXG4gKiAgIDcuIEF1dG8gaXMgbGl2ZSBBTkQgYGVmZmVjdGl2ZUJhc2VQYXRoYCBpcyBpdHNlbGYgYSBgLmdzZC93b3JrdHJlZXMvXHUyMDI2YCBwYXRoLlxuICpcbiAqIE90aGVyd2lzZTogYmxvY2sgd2l0aCBhIG1lc3NhZ2UgdGhhdCBwb2ludHMgdGhlIGFnZW50IGF0IGAvZ3NkYCB0byBzdGFydFxuICogYXV0by1tb2RlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkQmxvY2tXb3JrdHJlZVdyaXRlKFxuICB0b29sTmFtZTogc3RyaW5nLFxuICB0YXJnZXRQYXRoOiBzdHJpbmcsXG4gIGVmZmVjdGl2ZUJhc2VQYXRoOiBzdHJpbmcsXG4gIGlzQXV0b0xpdmU6IGJvb2xlYW4sXG4gIGN1cnJlbnRVbml0VHlwZT86IHN0cmluZyB8IG51bGwsXG4pOiB7IGJsb2NrOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IHRvb2wgPSBjYW5vbmljYWxUb29sTmFtZSh0b29sTmFtZSk7XG4gIGlmICghUExBTk5JTkdfV1JJVEVfVE9PTFMuaGFzKHRvb2wpKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgaWYgKHByb2Nlc3MuZW52LkdTRF9ESVNBQkxFX1dPUktUUkVFX1dSSVRFX0dVQVJEID09PSBcIjFcIikgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG4gIGlmIChnZXRJc29sYXRpb25Nb2RlKGVmZmVjdGl2ZUJhc2VQYXRoKSAhPT0gXCJ3b3JrdHJlZVwiKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgaWYgKGN1cnJlbnRVbml0VHlwZSAmJiBXT1JLVFJFRV9HQVRFX0JPT1RTVFJBUF9VTklUUy5oYXMoY3VycmVudFVuaXRUeXBlKSkgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG5cbiAgaWYgKCF0YXJnZXRQYXRoKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGJsb2NrOiB0cnVlLFxuICAgICAgcmVhc29uOiBbXG4gICAgICAgIGBIQVJEIEJMT0NLOiAke3Rvb2x9IGNhbGxlZCB3aXRoIGVtcHR5IHBhdGggd2hpbGUgXFxgZ2l0Lmlzb2xhdGlvbjogd29ya3RyZWVcXGAgaXMgY29uZmlndXJlZGAsXG4gICAgICAgIGBhbmQgYXV0by1tb2RlIGlzIG5vdCBhY3RpdmUuIFJlZnVzaW5nIHRvIGFsbG93IHdyaXRlcyB0aGF0IGNhbm5vdCBiZSBsb2NhdGVkLmAsXG4gICAgICBdLmpvaW4oXCIgXCIpLFxuICAgIH07XG4gIH1cblxuICAvLyBSZXNvbHZlIHRoZSB0YXJnZXQgcmVsYXRpdmUgdG8gdGhlIHByb2plY3Qgcm9vdCwgdGhlbiByZWFscGF0aCB0byBkZWZlYXRcbiAgLy8gc3ltbGluay1iYXNlZCBlc2NhcGVzIGFuZCBwcmVmaXggdHJpY2tzIChlLmcuIC5nc2Qvd29ya3RyZWVzLWV4dHJhLykuXG4gIGNvbnN0IHByb2plY3RSb290ID0gcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QoZWZmZWN0aXZlQmFzZVBhdGgpO1xuICBjb25zdCBhYnNUYXJnZXQgPSBpc0Fic29sdXRlKHRhcmdldFBhdGgpID8gdGFyZ2V0UGF0aCA6IHJlc29sdmUocHJvamVjdFJvb3QsIHRhcmdldFBhdGgpO1xuICBjb25zdCByZWFsVGFyZ2V0ID0gcmVhbHBhdGhPclJlc29sdmUoYWJzVGFyZ2V0KTtcbiAgY29uc3QgcmVhbFJvb3QgPSByZWFscGF0aE9yUmVzb2x2ZShwcm9qZWN0Um9vdCk7XG4gIGNvbnN0IHJlYWxHc2QgPSByZWFscGF0aE9yUmVzb2x2ZShqb2luKHByb2plY3RSb290LCBcIi5nc2RcIikpO1xuICBjb25zdCByZWFsV29ya3RyZWVzRGlyID0gcmVhbHBhdGhPclJlc29sdmUoam9pbihwcm9qZWN0Um9vdCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIpKTtcblxuICAvLyBBbGxvdyB3cml0ZXMgaW5zaWRlIHRoZSBsZWdpdGltYXRlIHdvcmt0cmVlcyBzdWJ0cmVlLlxuICBpZiAoaXNQYXRoQ29udGFpbmVkKHJlYWxUYXJnZXQsIHJlYWxXb3JrdHJlZXNEaXIpKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcblxuICAvLyBBbGxvdyB3cml0ZXMgdG8gLmdzZC8gcGxhbm5pbmcgYXJ0aWZhY3RzLCBidXQgcmVqZWN0IHNpYmxpbmdzIHdob3NlIG5hbWVcbiAgLy8gc3RhcnRzIHdpdGggXCJ3b3JrdHJlZXNcIiAodGhlIHdvcmt0cmVlcy1leHRyYSBwcmVmaXggdHJpY2sgXHUyMDE0IGNhc2UgNCkuXG4gIGlmIChpc1BhdGhDb250YWluZWQocmVhbFRhcmdldCwgcmVhbEdzZCkpIHtcbiAgICBjb25zdCByZWwgPSByZWxhdGl2ZShyZWFsR3NkLCByZWFsVGFyZ2V0KTtcbiAgICBjb25zdCBmaXJzdFNlZyA9IHJlbC5zcGxpdCgvW1xcL1xcXFxdLylbMF0gPz8gXCJcIjtcbiAgICBpZiAoIWZpcnN0U2VnLnN0YXJ0c1dpdGgoXCJ3b3JrdHJlZXNcIikpIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuICAgIC8vIGZhbGwgdGhyb3VnaDogbG9va3MgbGlrZSB3b3JrdHJlZXM8c29tZXRoaW5nPiBzaWJsaW5nIFx1MjAxNCBibG9ja1xuICB9XG5cbiAgLy8gQXV0byBpcyBsaXZlIGFuZCB0aGUgY2FsbGVyIGlzIG9wZXJhdGluZyBpbnNpZGUgYSB3b3JrdHJlZSBwYXRoIFx1MjAxNFxuICAvLyBob3N0IHRvb2wncyB3cml0ZSBoYXBwZW5zIGluIHdvcmt0cmVlIGNvbnRleHQ7IGxldCBpdCB0aHJvdWdoLlxuICBpZiAoaXNBdXRvTGl2ZSAmJiBpc0dzZFdvcmt0cmVlUGF0aChlZmZlY3RpdmVCYXNlUGF0aCkpIHJldHVybiB7IGJsb2NrOiBmYWxzZSB9O1xuXG4gIC8vIEJsb2NrLiBQcm92aWRlIGVub3VnaCBjb250ZXh0IHRoYXQgdGhlIGFnZW50IGNhbiBzZWxmLWNvcnJlY3QuXG4gIGNvbnN0IGRpc3BsYXlUYXJnZXQgPSBpc1BhdGhDb250YWluZWQocmVhbFRhcmdldCwgcmVhbFJvb3QpXG4gICAgPyByZWxhdGl2ZShyZWFsUm9vdCwgcmVhbFRhcmdldCkgfHwgXCIuXCJcbiAgICA6IHJlYWxUYXJnZXQ7XG4gIHJldHVybiB7XG4gICAgYmxvY2s6IHRydWUsXG4gICAgcmVhc29uOiBbXG4gICAgICBgSEFSRCBCTE9DSzogV29ya3RyZWUgaXNvbGF0aW9uIGlzIGNvbmZpZ3VyZWQgKFxcYGdpdC5pc29sYXRpb246IHdvcmt0cmVlXFxgKSBidXQgYXV0by1tb2RlIGlzYCxcbiAgICAgIGBub3QgcnVubmluZyBhbmQgdGhlIHRhcmdldCBcIiR7ZGlzcGxheVRhcmdldH1cIiBpcyBub3QgaW5zaWRlIFxcYC5nc2Qvd29ya3RyZWVzLzxNSUQ+L1xcYC5gLFxuICAgICAgYENvZGUgZWRpdHMgYXQgdGhlIHByb2plY3Qgcm9vdCB3b3VsZCBiZSBsb3N0IFx1MjAxNCBvbmx5IHRoZSBhdXRvLW1vZGUgY29tbWl0IHBpcGVsaW5lYCxcbiAgICAgIGAoYXV0by1wb3N0LXVuaXQpIGNvbW1pdHMgd29yaywgYW5kIGl0IG5ldmVyIHJ1bnMgb3V0c2lkZSB0aGUgbG9vcC5gLFxuICAgICAgYFJlcXVpcmVkIGFjdGlvbjogc3RhcnQgYXV0by1tb2RlIHdpdGggXFxgL2dzZFxcYCBzbyB0aGUgbWlsZXN0b25lIHdvcmt0cmVlIGlzIGNyZWF0ZWQsYCxcbiAgICAgIGB0aGVuIHdyaXRlIGluc2lkZSBpdC4gVG8gZGlzYWJsZSB0aGlzIGd1YXJkIGZvciBzZWxmLWhvc3RpbmcgZGV2ZWxvcG1lbnQsIHNldGAsXG4gICAgICBgR1NEX0RJU0FCTEVfV09SS1RSRUVfV1JJVEVfR1VBUkQ9MS5gLFxuICAgIF0uam9pbihcIiBcIiksXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLGNBQWMsWUFBWSxXQUFXLFdBQVcsY0FBYyxjQUFjLGNBQWMsWUFBWSxZQUFZLHFCQUFxQjtBQUNoSixTQUFTLFlBQVksTUFBTSxVQUFVLFNBQVMsV0FBVztBQUV6RCxTQUFTLGlCQUFpQjtBQUUxQixTQUFTLHdCQUF3QjtBQUNqQyxTQUFTLHlDQUEyRDtBQUNwRSxTQUFT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
