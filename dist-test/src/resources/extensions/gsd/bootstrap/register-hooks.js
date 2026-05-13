import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isToolCallEventType } from "@gsd/pi-coding-agent";
import { updateSnapshot } from "../ecosystem/gsd-extension-api.js";
import { buildMilestoneFileName, resolveMilestonePath, resolveSliceFile, resolveSlicePath } from "../paths.js";
import { canonicalToolName, clearDiscussionFlowState, isDepthConfirmationAnswer, isQueuePhaseActive, markApprovalGateVerified, markDepthVerified, resetWriteGateState, shouldBlockContextWrite, shouldBlockPlanningUnit, shouldBlockQueueExecution, shouldBlockWorktreeWrite, isGateQuestionId, setPendingGate, clearPendingGate, getPendingGate, shouldBlockPendingGate, shouldBlockPendingGateBash, extractDepthVerificationMilestoneId } from "./write-gate.js";
import { resolveManifest } from "../unit-context-manifest.js";
import { isBlockedStateFile, isBashWriteToStateFile, BLOCKED_WRITE_ERROR } from "../write-intercept.js";
import { loadFile, saveFile, formatContinue } from "../files.js";
import { clearToolInvocationError, getAutoRuntimeSnapshot, isAutoActive, isAutoPaused, markToolEnd, markToolStart, recordToolInvocationError } from "../auto-runtime-state.js";
import { checkToolCallLoop, resetToolCallLoopGuard } from "./tool-call-loop-guard.js";
import { saveActivityLog } from "../activity-log.js";
import { recordToolCall as safetyRecordToolCall, recordToolResult as safetyRecordToolResult, saveEvidenceToDisk } from "../safety/evidence-collector.js";
import { parseUnitId } from "../unit-id.js";
import { classifyCommand } from "../safety/destructive-guard.js";
import { logWarning as safetyLogWarning } from "../workflow-logger.js";
import { installNotifyInterceptor } from "./notify-interceptor.js";
import { initNotificationStore } from "../notification-store.js";
import { initNotificationWidget } from "../notification-widget.js";
import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { extractSubagentAgentClasses } from "./subagent-input.js";
import { approvalGateIdForUnit, isExplicitApprovalResponse, shouldPauseForUserApprovalQuestion } from "../user-input-boundary.js";
import { resolveSkillManifest } from "../skill-manifest.js";
let approvalQuestionAbortInFlight = false;
async function loadWelcomeScreenModule() {
  const candidates = [];
  const gsdBinPath = process.env.GSD_BIN_PATH;
  if (gsdBinPath) {
    candidates.push(join(dirname(gsdBinPath), "welcome-screen.js"));
  }
  const packageRoot = process.env.GSD_PKG_ROOT;
  if (packageRoot) {
    candidates.push(join(packageRoot, "dist", "welcome-screen.js"));
    candidates.push(join(packageRoot, "src", "welcome-screen.ts"));
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const mod = await import(pathToFileURL(candidate).href);
      if (typeof mod.buildWelcomeScreenLines === "function") {
        return mod;
      }
    } catch {
    }
  }
  return void 0;
}
async function installWelcomeHeader(ctx) {
  if (!ctx.hasUI || typeof ctx.ui?.setHeader !== "function") return;
  try {
    const welcome = await loadWelcomeScreenModule();
    if (!welcome) return;
    let remoteChannel;
    try {
      const { resolveRemoteConfig } = await import("../../remote-questions/config.js");
      const rc = resolveRemoteConfig();
      if (rc) remoteChannel = rc.channel;
    } catch {
    }
    ctx.ui.setHeader(() => {
      let cachedLines;
      let cachedWidth;
      return {
        render(width) {
          if (cachedLines !== void 0 && cachedWidth === width) return cachedLines;
          cachedLines = welcome.buildWelcomeScreenLines({
            version: process.env.GSD_VERSION || "0.0.0",
            remoteChannel,
            width
          });
          cachedWidth = width;
          return cachedLines;
        },
        invalidate() {
          cachedLines = void 0;
          cachedWidth = void 0;
        }
      };
    });
  } catch {
  }
}
let deferredApprovalGate = null;
const MINIMAL_GSD_TOOL_NAMES = [
  "gsd_exec",
  "gsd_exec_search",
  "gsd_resume",
  "gsd_milestone_status",
  "gsd_checkpoint_db",
  "memory_query",
  "capture_thought"
];
const MINIMAL_AUTO_BASE_TOOL_NAMES = [
  "ask_user_questions",
  "bash",
  "bg_shell",
  "edit",
  "glob",
  "grep",
  "ls",
  "read",
  "write"
];
const AUTO_UNIT_SCOPED_TOOLS = {
  "research-milestone": ["gsd_summary_save", "gsd_decision_save"],
  "plan-milestone": ["gsd_plan_milestone", "gsd_decision_save", "gsd_requirement_update"],
  "discuss-milestone": ["gsd_summary_save", "gsd_decision_save", "gsd_requirement_save"],
  "validate-milestone": ["gsd_validate_milestone", "gsd_reassess_roadmap", "subagent"],
  "complete-milestone": ["gsd_complete_milestone", "subagent"],
  "research-slice": ["gsd_summary_save", "gsd_decision_save"],
  "plan-slice": ["gsd_plan_slice", "gsd_plan_task", "gsd_decision_save"],
  "refine-slice": ["gsd_plan_slice", "gsd_plan_task", "gsd_decision_save"],
  "replan-slice": ["gsd_replan_slice", "gsd_plan_task", "gsd_decision_save"],
  "complete-slice": ["gsd_slice_complete", "gsd_task_reopen", "gsd_replan_slice", "gsd_decision_save", "gsd_requirement_update", "subagent"],
  "reassess-roadmap": ["gsd_reassess_roadmap"],
  "execute-task": ["gsd_task_complete", "gsd_decision_save"],
  "execute-task-simple": ["gsd_task_complete", "gsd_decision_save"],
  "reactive-execute": ["gsd_task_complete", "gsd_decision_save"],
  "run-uat": ["gsd_summary_save"],
  "gate-evaluate": ["gsd_save_gate_result"],
  "rewrite-docs": ["gsd_summary_save", "gsd_decision_save"],
  "workflow-preferences": ["gsd_summary_save"],
  "discuss-project": ["gsd_summary_save", "gsd_decision_save", "gsd_requirement_save"],
  "discuss-requirements": ["gsd_requirement_save", "gsd_summary_save"],
  "research-decision": ["gsd_summary_save"],
  "research-project": ["gsd_summary_save", "gsd_decision_save"]
};
const WORKFLOW_GSD_TOOL_NAMES = [
  ...MINIMAL_GSD_TOOL_NAMES,
  ...Object.values(AUTO_UNIT_SCOPED_TOOLS).flat()
].filter(isGsdManagedTool);
function isGsdManagedTool(name) {
  return name.startsWith("gsd_") || name === "memory_query" || name === "capture_thought" || name === "gsd_graph";
}
function buildMinimalGsdToolSet(activeToolNames) {
  const active = new Set(activeToolNames);
  const preserved = activeToolNames.filter((name) => !isGsdManagedTool(name));
  const minimal = MINIMAL_GSD_TOOL_NAMES.filter((name) => active.has(name));
  return [.../* @__PURE__ */ new Set([...preserved, ...minimal])];
}
function buildMinimalAutoGsdToolSet(activeToolNames, unitType) {
  const active = new Set(activeToolNames);
  const unitTools = unitType ? AUTO_UNIT_SCOPED_TOOLS[unitType] ?? [] : [];
  const autoBaseTools = new Set(MINIMAL_AUTO_BASE_TOOL_NAMES);
  const preserved = activeToolNames.filter((name) => autoBaseTools.has(name));
  const scoped = [...MINIMAL_GSD_TOOL_NAMES, ...unitTools].filter((name) => active.has(name));
  return [.../* @__PURE__ */ new Set([...preserved, ...scoped])];
}
function buildMinimalGsdWorkflowToolSet(activeToolNames) {
  const active = new Set(activeToolNames);
  const autoBaseTools = new Set(MINIMAL_AUTO_BASE_TOOL_NAMES);
  const preserved = activeToolNames.filter((name) => autoBaseTools.has(name));
  const scoped = WORKFLOW_GSD_TOOL_NAMES.filter((name) => active.has(name));
  return [.../* @__PURE__ */ new Set([...preserved, ...scoped])];
}
function buildRequestScopedGsdToolSet(activeToolNames, requestCustomMessages) {
  for (let index = (requestCustomMessages?.length ?? 0) - 1; index >= 0; index--) {
    const currentCustomType = requestCustomMessages?.[index]?.customType;
    if (currentCustomType === "gsd-run" || currentCustomType === "gsd-discuss" || currentCustomType === "gsd-doctor-heal" || currentCustomType === "gsd-triage") {
      return buildMinimalGsdWorkflowToolSet(activeToolNames);
    }
  }
  return void 0;
}
function isFullGsdToolSurfaceRequested() {
  return process.env.PI_GSD_FULL_TOOLS === "1";
}
function isGeneralGsdToolScopingRequested() {
  return process.env.PI_GSD_MINIMAL_TOOLS === "1";
}
function applyMinimalGsdToolSurface(pi) {
  if (isFullGsdToolSurfaceRequested()) return;
  const dash = getAutoRuntimeSnapshot();
  if (dash.active && dash.currentUnit) {
    pi.setActiveTools(buildMinimalAutoGsdToolSet(pi.getActiveTools(), dash.currentUnit.type));
    return;
  }
  if (!isGeneralGsdToolScopingRequested()) return;
  pi.setActiveTools(buildMinimalGsdToolSet(pi.getActiveTools()));
}
function scopeGsdWorkflowToolsForDispatch(pi, unitType) {
  if (isFullGsdToolSurfaceRequested()) return null;
  const current = pi.getActiveTools();
  const scoped = unitType ? buildMinimalAutoGsdToolSet(current, unitType) : buildMinimalGsdWorkflowToolSet(current);
  const toolsChanged = !(scoped.length === current.length && scoped.every((name, index) => name === current[index]));
  const skillManifest = resolveSkillManifest(unitType);
  const canScopeSkills = skillManifest !== null && pi.getVisibleSkills && pi.setVisibleSkills;
  if (!toolsChanged && !canScopeSkills) {
    return null;
  }
  if (toolsChanged) {
    pi.setActiveTools(scoped);
  }
  const visibleSkills = canScopeSkills ? pi.getVisibleSkills() : void 0;
  if (canScopeSkills) {
    pi.setVisibleSkills(skillManifest);
  }
  return {
    tools: toolsChanged ? current : null,
    visibleSkills,
    restoreVisibleSkills: Boolean(canScopeSkills)
  };
}
function restoreGsdWorkflowTools(pi, savedState) {
  if (!savedState) return;
  if (savedState.tools) pi.setActiveTools(savedState.tools);
  if (savedState.restoreVisibleSkills && pi.setVisibleSkills) {
    pi.setVisibleSkills(savedState.visibleSkills);
  }
}
async function deriveGsdState(basePath) {
  const { deriveState } = await import("../state.js");
  return deriveState(basePath);
}
async function getDiscussionMilestoneIdFor(basePath) {
  const { getDiscussionMilestoneId } = await import("../guided-flow.js");
  return getDiscussionMilestoneId(basePath);
}
async function loadToolApiKeysForSession() {
  const { loadToolApiKeys } = await import("../commands-config.js");
  loadToolApiKeys();
}
async function resetAskUserQuestionsTurnCache() {
  const { resetAskUserQuestionsCache } = await import("../../ask-user-questions.js");
  resetAskUserQuestionsCache();
}
async function syncServiceTierStatus(ctx) {
  const { getEffectiveServiceTier, formatServiceTierFooterStatus } = await import("../service-tier.js");
  ctx.ui.setStatus("gsd-fast", formatServiceTierFooterStatus(getEffectiveServiceTier(), ctx.model?.id));
}
async function applyDisabledModelProviderPolicy(ctx) {
  try {
    const { resolveDisabledModelProvidersFromPreferences } = await import("../preferences.js");
    ctx.modelRegistry.setDisabledModelProviders(resolveDisabledModelProvidersFromPreferences());
  } catch {
  }
}
async function applyCompactionThresholdOverride(ctx) {
  try {
    const { loadEffectiveGSDPreferences } = await import("../preferences.js");
    const prefs = loadEffectiveGSDPreferences();
    const raw = prefs?.preferences.context_management?.compaction_threshold_percent;
    const value = typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : void 0;
    ctx.setCompactionThresholdOverride(value);
  } catch {
  }
}
function clearDeferredApprovalGate(basePath) {
  if (!basePath || deferredApprovalGate?.basePath === basePath) {
    deferredApprovalGate = null;
  }
}
function deferApprovalGate(gateId, basePath) {
  deferredApprovalGate = { gateId, basePath };
}
function contextBasePath(ctx) {
  return typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
}
function activateDeferredApprovalGate(basePath) {
  if (deferredApprovalGate?.basePath !== basePath) return;
  setPendingGate(deferredApprovalGate.gateId, basePath);
  deferredApprovalGate = null;
}
function isContextDraftSummarySave(toolName, input) {
  if (toolName !== "gsd_summary_save" && toolName !== "summary_save") return false;
  if (!input || typeof input !== "object") return false;
  return input.artifact_type === "CONTEXT-DRAFT";
}
function shouldBlockDeferredApprovalTool(toolName, input, basePath) {
  if (deferredApprovalGate?.basePath !== basePath) return { block: false };
  if (toolName === "ask_user_questions") return { block: false };
  if (isContextDraftSummarySave(toolName, input)) return { block: false };
  return {
    block: true,
    reason: [
      `HARD BLOCK: Approval question "${deferredApprovalGate.gateId}" has been shown to the user.`,
      `Only CONTEXT-DRAFT persistence may finish in this same assistant turn.`,
      `Wait for the user's answer before calling additional tools.`
    ].join(" ")
  };
}
function resolveNotificationStoreBasePath(basePath) {
  return resolveWorktreeProjectRoot(basePath);
}
function initSessionNotifications(ctx) {
  initNotificationStore(resolveNotificationStoreBasePath(contextBasePath(ctx)));
  installNotifyInterceptor(ctx);
  initNotificationWidget(ctx);
}
async function writeContextModeCompactionSnapshot(basePath) {
  try {
    const { loadEffectiveGSDPreferences } = await import("../preferences.js");
    const { isContextModeEnabled } = await import("../preferences-types.js");
    const prefs = loadEffectiveGSDPreferences(basePath);
    if (!isContextModeEnabled(prefs?.preferences)) return;
    const { writeCompactionSnapshot } = await import("../compaction-snapshot.js");
    const { ensureDbOpen } = await import("./dynamic-tools.js");
    await ensureDbOpen(basePath);
    let activeContext = null;
    try {
      const state = await deriveGsdState(basePath);
      if (state.activeMilestone && state.activeSlice && state.activeTask) {
        activeContext = `Active: ${state.activeMilestone.id} / ${state.activeSlice.id} / ${state.activeTask.id}` + (state.activeTask.title ? ` - ${state.activeTask.title}` : "");
      }
    } catch {
    }
    writeCompactionSnapshot(basePath, { activeContext });
  } catch (err) {
    safetyLogWarning(
      "context-mode",
      `failed to write compaction snapshot: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function registerHooks(pi, ecosystemHandlers) {
  void import("../provider-switch-observer.js").then((m) => m.installProviderSwitchObserver());
  pi.on("session_start", async (_event, ctx) => {
    const basePath = contextBasePath(ctx);
    initSessionNotifications(ctx);
    if (!isAutoActive()) {
      const { initHealthWidget } = await import("../health-widget.js");
      initHealthWidget(ctx);
    }
    resetWriteGateState(basePath);
    resetToolCallLoopGuard();
    approvalQuestionAbortInFlight = false;
    clearDeferredApprovalGate();
    await resetAskUserQuestionsTurnCache();
    await syncServiceTierStatus(ctx);
    await applyDisabledModelProviderPolicy(ctx);
    await applyCompactionThresholdOverride(ctx);
    const { isInAutoWorktree } = await import("../auto-worktree.js");
    if (!isInAutoWorktree(basePath)) {
      const { prepareWorkflowMcpForProject } = await import("../workflow-mcp-auto-prep.js");
      prepareWorkflowMcpForProject(ctx, basePath);
    }
    try {
      const { loadEffectiveGSDPreferences } = await import("../preferences.js");
      const prefs = loadEffectiveGSDPreferences(basePath);
      process.env.GSD_SHOW_TOKEN_COST = prefs?.preferences.show_token_cost ? "1" : "";
    } catch {
    }
    await installWelcomeHeader(ctx);
    await loadToolApiKeysForSession();
    if (isAutoActive()) {
      ctx.ui.setWidget("gsd-health", void 0);
    }
  });
  pi.on("session_switch", async (_event, ctx) => {
    const basePath = contextBasePath(ctx);
    initSessionNotifications(ctx);
    resetWriteGateState(basePath);
    resetToolCallLoopGuard();
    clearDeferredApprovalGate();
    await resetAskUserQuestionsTurnCache();
    clearDiscussionFlowState(basePath);
    await syncServiceTierStatus(ctx);
    await applyDisabledModelProviderPolicy(ctx);
    await applyCompactionThresholdOverride(ctx);
    const { isInAutoWorktree } = await import("../auto-worktree.js");
    if (!isInAutoWorktree(basePath)) {
      const { prepareWorkflowMcpForProject } = await import("../workflow-mcp-auto-prep.js");
      prepareWorkflowMcpForProject(ctx, basePath);
    }
    await loadToolApiKeysForSession();
    if (!isAutoActive()) {
      ctx.ui.setWidget("gsd-progress", void 0);
      ctx.ui.setWidget("gsd-outcome", void 0);
      const { initHealthWidget } = await import("../health-widget.js");
      initHealthWidget(ctx);
    } else {
      ctx.ui.setWidget("gsd-health", void 0);
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    applyMinimalGsdToolSurface(pi);
    const { getEcosystemReadyPromise } = await import("../ecosystem/loader.js");
    await getEcosystemReadyPromise();
    const beforeAgentBasePath = contextBasePath(ctx);
    const pendingApprovalGate = getPendingGate(beforeAgentBasePath);
    if (pendingApprovalGate && isExplicitApprovalResponse(event.prompt, pendingApprovalGate)) {
      markApprovalGateVerified(pendingApprovalGate, beforeAgentBasePath);
      const milestoneId = extractDepthVerificationMilestoneId(pendingApprovalGate);
      if (milestoneId) markDepthVerified(milestoneId, beforeAgentBasePath);
      clearPendingGate(beforeAgentBasePath);
    }
    clearDeferredApprovalGate(beforeAgentBasePath);
    const { buildBeforeAgentStartResult } = await import("./system-context.js");
    const gsdResult = await buildBeforeAgentStartResult(event, ctx);
    try {
      const state = await deriveGsdState(beforeAgentBasePath);
      updateSnapshot(state);
    } catch {
      updateSnapshot(null);
    }
    let currentSystemPrompt = gsdResult?.systemPrompt ?? event.systemPrompt;
    let lastMessage = gsdResult?.message;
    for (const handler of ecosystemHandlers) {
      try {
        const r = await handler(
          { ...event, systemPrompt: currentSystemPrompt },
          ctx
        );
        if (r?.systemPrompt !== void 0) currentSystemPrompt = r.systemPrompt;
        if (r?.message) lastMessage = r.message;
      } catch (err) {
        safetyLogWarning(
          "ecosystem",
          `before_agent_start handler failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (currentSystemPrompt === event.systemPrompt && !lastMessage) return void 0;
    return {
      systemPrompt: currentSystemPrompt !== event.systemPrompt ? currentSystemPrompt : void 0,
      message: lastMessage
    };
  });
  pi.on("agent_end", async (event, ctx) => {
    approvalQuestionAbortInFlight = false;
    resetToolCallLoopGuard();
    await resetAskUserQuestionsTurnCache();
    const { handleAgentEnd } = await import("./agent-end-recovery.js");
    try {
      await handleAgentEnd(pi, event, ctx);
    } finally {
      activateDeferredApprovalGate(contextBasePath(ctx));
    }
  });
  pi.on("turn_end", async () => {
    try {
      const { cleanupQuickBranch } = await import("../quick.js");
      cleanupQuickBranch();
    } catch {
    }
  });
  pi.on("session_before_compact", async (_event, ctx) => {
    const basePath = contextBasePath(ctx);
    await writeContextModeCompactionSnapshot(basePath);
    if (isAutoActive()) {
      return { cancel: true };
    }
    const { ensureDbOpen } = await import("./dynamic-tools.js");
    await ensureDbOpen(basePath);
    const state = await deriveGsdState(basePath);
    if (!state.activeMilestone || !state.activeSlice) return;
    const sliceDir = resolveSlicePath(basePath, state.activeMilestone.id, state.activeSlice.id);
    if (!sliceDir) return;
    const existingFile = resolveSliceFile(basePath, state.activeMilestone.id, state.activeSlice.id, "CONTINUE");
    if (existingFile && await loadFile(existingFile)) return;
    const legacyContinue = join(sliceDir, "continue.md");
    if (await loadFile(legacyContinue)) return;
    const continuePath = join(sliceDir, `${state.activeSlice.id}-CONTINUE.md`);
    const taskId = state.activeTask?.id ?? "none";
    const taskTitle = state.activeTask?.title ?? "";
    const phaseLabel = state.phase.replace(/-/g, " ");
    await saveFile(continuePath, formatContinue({
      frontmatter: {
        milestone: state.activeMilestone.id,
        slice: state.activeSlice.id,
        task: taskId,
        step: 0,
        totalSteps: 0,
        status: "compacted",
        savedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      completedWork: state.activeTask ? `Task ${taskId} (${taskTitle}) was in progress when compaction occurred.` : `Slice ${state.activeSlice.id} was in ${phaseLabel} phase when compaction occurred.`,
      remainingWork: state.activeTask ? "Check the task plan for remaining steps." : "Continue this slice from the latest planning/research/discussion artifacts.",
      decisions: "Check task summary files for prior decisions.",
      context: "Session was auto-compacted by Pi. Resume with /gsd.",
      nextAction: state.activeTask ? `Resume task ${taskId}: ${taskTitle}.` : `Resume ${phaseLabel} work for slice ${state.activeSlice.id}.`
    }));
  });
  pi.on("message_update", async (event, ctx) => {
    if (approvalQuestionAbortInFlight) return;
    const dash = getAutoRuntimeSnapshot();
    let unitType = dash.currentUnit?.type;
    let unitId = dash.currentUnit?.id;
    if (!unitType) {
      try {
        const { getPendingDeepProjectSetupUnitForContext } = await import("../guided-flow.js");
        const pending = getPendingDeepProjectSetupUnitForContext(ctx, contextBasePath(ctx));
        unitType = pending?.unitType;
        unitId = pending?.unitId;
      } catch {
      }
    }
    if (!unitType) {
      const milestoneId = await getDiscussionMilestoneIdFor(contextBasePath(ctx));
      if (milestoneId) {
        unitType = "discuss-milestone";
        unitId = milestoneId;
      }
    }
    if (!shouldPauseForUserApprovalQuestion(unitType, [event.message])) return;
    const gateId = approvalGateIdForUnit(unitType, unitId);
    if (gateId) deferApprovalGate(gateId, contextBasePath(ctx));
    approvalQuestionAbortInFlight = true;
    ctx.ui.notify(
      `${unitType}${unitId ? ` ${unitId}` : ""} is waiting for your approval - pausing before more tool calls run.`,
      "info"
    );
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const { isParallelActive, shutdownParallel } = await import("../parallel-orchestrator.js");
    if (isParallelActive()) {
      try {
        await shutdownParallel(contextBasePath(ctx));
      } catch {
      }
    }
    if (!isAutoActive() && !isAutoPaused()) return;
    const dash = getAutoRuntimeSnapshot();
    if (dash.currentUnit) {
      saveActivityLog(ctx, dash.basePath, dash.currentUnit.type, dash.currentUnit.id);
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    const discussionBasePath = contextBasePath(ctx);
    const toolName = canonicalToolName(event.toolName);
    const loopCheck = checkToolCallLoop(toolName, event.input);
    if (loopCheck.block) {
      return { block: true, reason: loopCheck.reason };
    }
    const deferredGateGuard = shouldBlockDeferredApprovalTool(
      toolName,
      event.input,
      discussionBasePath
    );
    if (deferredGateGuard.block) return deferredGateGuard;
    if (toolName === "ask_user_questions") {
      const questions = event.input?.questions ?? [];
      const questionId = questions.find((question) => typeof question?.id === "string" && isGateQuestionId(question.id))?.id;
      if (typeof questionId === "string") {
        setPendingGate(questionId, discussionBasePath);
      }
    }
    if (getPendingGate(discussionBasePath)) {
      const milestoneId = await getDiscussionMilestoneIdFor(discussionBasePath);
      if (isToolCallEventType("bash", event)) {
        const bashGuard = shouldBlockPendingGateBash(
          event.input.command,
          milestoneId,
          isQueuePhaseActive(discussionBasePath),
          discussionBasePath
        );
        if (bashGuard.block) return bashGuard;
      } else {
        const gateGuard = shouldBlockPendingGate(
          toolName,
          milestoneId,
          isQueuePhaseActive(discussionBasePath),
          discussionBasePath
        );
        if (gateGuard.block) return gateGuard;
      }
    }
    if (isQueuePhaseActive(discussionBasePath)) {
      let queueInput = "";
      if (isToolCallEventType("write", event)) {
        queueInput = event.input.path;
      } else if (isToolCallEventType("edit", event)) {
        queueInput = event.input.path;
      } else if (isToolCallEventType("bash", event)) {
        queueInput = event.input.command;
      }
      const queueGuard = shouldBlockQueueExecution(toolName, queueInput, true);
      if (queueGuard.block) return queueGuard;
    }
    const dash = getAutoRuntimeSnapshot();
    const activeUnitType = dash.currentUnit?.type;
    if (activeUnitType) {
      const manifest = resolveManifest(activeUnitType);
      if (manifest) {
        let planningInput = "";
        let agentClasses;
        if (isToolCallEventType("write", event)) {
          planningInput = event.input.path;
        } else if (isToolCallEventType("edit", event)) {
          planningInput = event.input.path;
        } else if (isToolCallEventType("bash", event)) {
          planningInput = event.input.command;
        } else if (event.toolName === "subagent" || event.toolName === "task") {
          agentClasses = extractSubagentAgentClasses(event.input);
        }
        const planningGuard = shouldBlockPlanningUnit(
          event.toolName,
          planningInput,
          dash.basePath || discussionBasePath,
          activeUnitType,
          manifest.tools,
          agentClasses
        );
        if (planningGuard.block) return planningGuard;
      }
    }
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const wtBasePath = resolveWorktreeProjectRoot(dash.basePath ?? discussionBasePath);
      const wtGuard = shouldBlockWorktreeWrite(
        event.toolName,
        event.input.path,
        wtBasePath,
        isAutoActive(),
        dash.currentUnit?.type
      );
      if (wtGuard.block) return wtGuard;
    }
    if (isToolCallEventType("write", event)) {
      if (isBlockedStateFile(event.input.path)) {
        return { block: true, reason: BLOCKED_WRITE_ERROR };
      }
    }
    if (isToolCallEventType("edit", event)) {
      if (isBlockedStateFile(event.input.path)) {
        return { block: true, reason: BLOCKED_WRITE_ERROR };
      }
    }
    if (isToolCallEventType("bash", event)) {
      if (isBashWriteToStateFile(event.input.command)) {
        return { block: true, reason: BLOCKED_WRITE_ERROR };
      }
    }
    if (!isToolCallEventType("write", event)) return;
    const result = shouldBlockContextWrite(
      event.toolName,
      event.input.path,
      await getDiscussionMilestoneIdFor(discussionBasePath),
      isQueuePhaseActive(discussionBasePath),
      discussionBasePath
    );
    if (result.block) return result;
  });
  pi.on("tool_call", async (event, ctx) => {
    if (!isAutoActive()) return;
    markToolStart(event.toolCallId, event.toolName);
    safetyRecordToolCall(event.toolCallId, event.toolName, event.input);
    const callDash = getAutoRuntimeSnapshot();
    if (callDash.basePath && callDash.currentUnit?.type === "execute-task") {
      const { milestone: cMid, slice: cSid, task: cTid } = parseUnitId(callDash.currentUnit.id);
      if (cMid && cSid && cTid) {
        saveEvidenceToDisk(callDash.basePath, cMid, cSid, cTid);
      }
    }
    if (isToolCallEventType("bash", event)) {
      const classification = classifyCommand(event.input.command);
      if (classification.destructive) {
        safetyLogWarning("safety", `destructive command: ${classification.labels.join(", ")}`, {
          command: String(event.input.command).slice(0, 200)
        });
        ctx.ui.notify(
          `Destructive command detected: ${classification.labels.join(", ")}`,
          "warning"
        );
      }
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (isAutoActive() && typeof event.toolCallId === "string") {
      markToolEnd(event.toolCallId);
    }
    if (isAutoActive() && event.isError) {
      const resultPayload = "result" in event ? event.result : void 0;
      const errorText = typeof resultPayload === "string" ? resultPayload : typeof resultPayload?.content?.[0]?.text === "string" ? resultPayload.content[0].text : typeof event.content === "string" ? event.content : String(resultPayload ?? "");
      recordToolInvocationError(event.toolName, errorText);
    } else if (isAutoActive()) {
      clearToolInvocationError();
    }
    const toolName = canonicalToolName(event.toolName);
    if (toolName !== "ask_user_questions") return;
    const basePath = contextBasePath(ctx);
    const milestoneId = await getDiscussionMilestoneIdFor(basePath);
    const queueActive = isQueuePhaseActive(basePath);
    const details = event.details;
    const questions = event.input?.questions ?? [];
    const currentPendingGate = getPendingGate(basePath);
    if (currentPendingGate) {
      if (details?.cancelled || !details?.response) {
        resetToolCallLoopGuard();
        return {
          content: [{
            type: "text",
            text: [
              `HARD BLOCK: approval gate "${currentPendingGate}" is still pending.`,
              "No user response was received for the confirmation question.",
              "Do not infer approval from earlier or prior messages.",
              "Do not proceed, write files, save artifacts, or call other tools.",
              `Re-call ask_user_questions with the same gate question id ("${currentPendingGate}") and wait for the user's response.`
            ].join(" ")
          }]
        };
      } else {
        const pendingQuestion = questions.find((question) => question?.id === currentPendingGate);
        if (pendingQuestion) {
          const answer = details.response?.answers?.[currentPendingGate];
          if (isDepthConfirmationAnswer(answer?.selected, pendingQuestion.options)) {
            markApprovalGateVerified(currentPendingGate, basePath);
            const milestoneIdFromGate = extractDepthVerificationMilestoneId(currentPendingGate);
            if (milestoneIdFromGate) markDepthVerified(milestoneIdFromGate, basePath);
            clearPendingGate(basePath);
          }
        }
      }
    }
    if (details?.cancelled || !details?.response) return;
    for (const question of questions) {
      if (typeof question.id === "string" && question.id.includes("depth_verification")) {
        const answer = details.response?.answers?.[question.id];
        const inferredMilestoneId = extractDepthVerificationMilestoneId(question.id) ?? milestoneId;
        if (isDepthConfirmationAnswer(answer?.selected, question.options)) {
          if (currentPendingGate && question.id !== currentPendingGate) break;
          markApprovalGateVerified(question.id, basePath);
          markDepthVerified(inferredMilestoneId, basePath);
          clearPendingGate(basePath);
        }
        break;
      }
    }
    if (!milestoneId && !queueActive) return;
    if (!milestoneId) return;
    const milestoneDir = resolveMilestonePath(basePath, milestoneId);
    if (!milestoneDir) return;
    const discussionPath = join(milestoneDir, buildMilestoneFileName(milestoneId, "DISCUSSION"));
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const lines = [`## Exchange \u2014 ${timestamp}`, ""];
    for (const question of questions) {
      lines.push(`### ${question.header ?? "Question"}`, "", question.question ?? "");
      if (Array.isArray(question.options)) {
        lines.push("");
        for (const opt of question.options) {
          lines.push(`- **${opt.label}** \u2014 ${opt.description ?? ""}`);
        }
      }
      const answer = details.response?.answers?.[question.id];
      if (answer) {
        lines.push("");
        const selected = Array.isArray(answer.selected) ? answer.selected.join(", ") : answer.selected;
        lines.push(`**Selected:** ${selected}`);
        if (answer.notes) {
          lines.push(`**Notes:** ${answer.notes}`);
        }
      }
      lines.push("");
    }
    lines.push("---", "");
    const existing = await loadFile(discussionPath) ?? `# ${milestoneId} Discussion Log

`;
    await saveFile(discussionPath, existing + lines.join("\n"));
  });
  pi.on("tool_execution_start", async (event) => {
    if (!isAutoActive()) return;
    markToolStart(event.toolCallId, event.toolName);
  });
  pi.on("tool_execution_end", async (event) => {
    markToolEnd(event.toolCallId);
    if (event.isError) {
      const errorText = typeof event.result === "string" ? event.result : typeof event.result?.content?.[0]?.text === "string" ? event.result.content[0].text : String(event.result);
      recordToolInvocationError(event.toolName, errorText);
    } else if (isAutoActive()) {
      clearToolInvocationError();
    }
    if (isAutoActive()) {
      safetyRecordToolResult(event.toolCallId, event.toolName, event.result, event.isError);
      const dash = getAutoRuntimeSnapshot();
      if (dash.basePath && dash.currentUnit?.type === "execute-task") {
        const { milestone: pMid, slice: pSid, task: pTid } = parseUnitId(dash.currentUnit.id);
        if (pMid && pSid && pTid) {
          saveEvidenceToDisk(dash.basePath, pMid, pSid, pTid);
        }
      }
    }
  });
  pi.on("model_select", async (_event, ctx) => {
    await syncServiceTierStatus(ctx);
  });
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return;
    if (isAutoActive()) {
      try {
        const { loadEffectiveGSDPreferences } = await import("../preferences.js");
        const prefs = loadEffectiveGSDPreferences();
        const cmConfig = prefs?.preferences.context_management;
        if (cmConfig?.observation_masking !== false) {
          const keepTurns = cmConfig?.observation_mask_turns ?? 8;
          const { createObservationMask } = await import("../context-masker.js");
          const mask = createObservationMask(keepTurns);
          const messages = payload.messages;
          if (Array.isArray(messages)) {
            payload.messages = mask(messages);
          }
        }
        const maxChars = cmConfig?.tool_result_max_chars ?? 800;
        const msgs = payload.messages;
        if (Array.isArray(msgs)) {
          payload.messages = msgs.map((msg) => {
            if (msg?.role === "toolResult" && Array.isArray(msg.content)) {
              const blocks = msg.content;
              const totalLen = blocks.reduce((sum, b) => sum + (typeof b.text === "string" ? b.text.length : 0), 0);
              if (totalLen > maxChars) {
                const truncated = blocks.map((b) => {
                  if (typeof b.text === "string" && b.text.length > maxChars) {
                    return { ...b, text: b.text.slice(0, maxChars) + "\n\u2026[truncated]" };
                  }
                  return b;
                });
                return { ...msg, content: truncated };
              }
            }
            return msg;
          });
        }
      } catch {
      }
    }
    const modelId = event.model?.id;
    if (!modelId) return payload;
    const { getEffectiveServiceTier, supportsServiceTier } = await import("../service-tier.js");
    const tier = getEffectiveServiceTier();
    if (!tier || !supportsServiceTier(modelId)) return payload;
    payload.service_tier = tier;
    return payload;
  });
  pi.on("before_model_select", async (_event) => {
    return void 0;
  });
  pi.on("adjust_tool_set", async (event) => {
    if (isFullGsdToolSurfaceRequested()) return void 0;
    const removed = new Set(event.filteredTools);
    const providerCompatible = event.activeToolNames.filter((name) => !removed.has(name));
    const requestScoped = buildRequestScopedGsdToolSet(providerCompatible, event.requestCustomMessages);
    if (requestScoped) {
      return { toolNames: requestScoped };
    }
    const dash = getAutoRuntimeSnapshot();
    if (dash.active && dash.currentUnit) {
      return { toolNames: buildMinimalAutoGsdToolSet(providerCompatible, dash.currentUnit.type) };
    }
    if (isGeneralGsdToolScopingRequested()) {
      return { toolNames: buildMinimalGsdToolSet(providerCompatible) };
    }
    return void 0;
  });
}
export {
  MINIMAL_AUTO_BASE_TOOL_NAMES,
  MINIMAL_GSD_TOOL_NAMES,
  buildMinimalAutoGsdToolSet,
  buildMinimalGsdToolSet,
  buildMinimalGsdWorkflowToolSet,
  buildRequestScopedGsdToolSet,
  isFullGsdToolSurfaceRequested,
  registerHooks,
  resolveNotificationStoreBasePath,
  restoreGsdWorkflowTools,
  scopeGsdWorkflowToolsForDispatch
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ib290c3RyYXAvcmVnaXN0ZXItaG9va3MudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFByb2plY3QvQXBwOiBHU0QtMlxuLy8gRmlsZSBQdXJwb3NlOiBSZWdpc3RlcnMgR1NEIGV4dGVuc2lvbiBydW50aW1lIGhvb2tzIGFuZCB0b2tlbi1zYXZpbmcgdG9vbCBwb2xpY2llcy5cblxuaW1wb3J0IHsgZXhpc3RzU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCB9IGZyb20gXCJub2RlOnVybFwiO1xuXG5pbXBvcnQgdHlwZSB7IEV4dGVuc2lvbkFQSSwgRXh0ZW5zaW9uQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHsgaXNUb29sQ2FsbEV2ZW50VHlwZSB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuXG5pbXBvcnQgdHlwZSB7IEdTREVjb3N5c3RlbUJlZm9yZUFnZW50U3RhcnRIYW5kbGVyIH0gZnJvbSBcIi4uL2Vjb3N5c3RlbS9nc2QtZXh0ZW5zaW9uLWFwaS5qc1wiO1xuaW1wb3J0IHsgdXBkYXRlU25hcHNob3QgfSBmcm9tIFwiLi4vZWNvc3lzdGVtL2dzZC1leHRlbnNpb24tYXBpLmpzXCI7XG5cbmltcG9ydCB7IGJ1aWxkTWlsZXN0b25lRmlsZU5hbWUsIHJlc29sdmVNaWxlc3RvbmVQYXRoLCByZXNvbHZlU2xpY2VGaWxlLCByZXNvbHZlU2xpY2VQYXRoIH0gZnJvbSBcIi4uL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBjYW5vbmljYWxUb29sTmFtZSwgY2xlYXJEaXNjdXNzaW9uRmxvd1N0YXRlLCBpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyLCBpc1F1ZXVlUGhhc2VBY3RpdmUsIG1hcmtBcHByb3ZhbEdhdGVWZXJpZmllZCwgbWFya0RlcHRoVmVyaWZpZWQsIHJlc2V0V3JpdGVHYXRlU3RhdGUsIHNob3VsZEJsb2NrQ29udGV4dFdyaXRlLCBzaG91bGRCbG9ja1BsYW5uaW5nVW5pdCwgc2hvdWxkQmxvY2tRdWV1ZUV4ZWN1dGlvbiwgc2hvdWxkQmxvY2tXb3JrdHJlZVdyaXRlLCBpc0dhdGVRdWVzdGlvbklkLCBzZXRQZW5kaW5nR2F0ZSwgY2xlYXJQZW5kaW5nR2F0ZSwgZ2V0UGVuZGluZ0dhdGUsIHNob3VsZEJsb2NrUGVuZGluZ0dhdGUsIHNob3VsZEJsb2NrUGVuZGluZ0dhdGVCYXNoLCBleHRyYWN0RGVwdGhWZXJpZmljYXRpb25NaWxlc3RvbmVJZCB9IGZyb20gXCIuL3dyaXRlLWdhdGUuanNcIjtcbmltcG9ydCB7IHJlc29sdmVNYW5pZmVzdCB9IGZyb20gXCIuLi91bml0LWNvbnRleHQtbWFuaWZlc3QuanNcIjtcbmltcG9ydCB7IGlzQmxvY2tlZFN0YXRlRmlsZSwgaXNCYXNoV3JpdGVUb1N0YXRlRmlsZSwgQkxPQ0tFRF9XUklURV9FUlJPUiB9IGZyb20gXCIuLi93cml0ZS1pbnRlcmNlcHQuanNcIjtcbmltcG9ydCB7IGxvYWRGaWxlLCBzYXZlRmlsZSwgZm9ybWF0Q29udGludWUgfSBmcm9tIFwiLi4vZmlsZXMuanNcIjtcbmltcG9ydCB7IGNsZWFyVG9vbEludm9jYXRpb25FcnJvciwgZ2V0QXV0b1J1bnRpbWVTbmFwc2hvdCwgaXNBdXRvQWN0aXZlLCBpc0F1dG9QYXVzZWQsIG1hcmtUb29sRW5kLCBtYXJrVG9vbFN0YXJ0LCByZWNvcmRUb29sSW52b2NhdGlvbkVycm9yIH0gZnJvbSBcIi4uL2F1dG8tcnVudGltZS1zdGF0ZS5qc1wiO1xuXG5pbXBvcnQgeyBjaGVja1Rvb2xDYWxsTG9vcCwgcmVzZXRUb29sQ2FsbExvb3BHdWFyZCB9IGZyb20gXCIuL3Rvb2wtY2FsbC1sb29wLWd1YXJkLmpzXCI7XG5pbXBvcnQgeyBzYXZlQWN0aXZpdHlMb2cgfSBmcm9tIFwiLi4vYWN0aXZpdHktbG9nLmpzXCI7XG5pbXBvcnQgeyByZWNvcmRUb29sQ2FsbCBhcyBzYWZldHlSZWNvcmRUb29sQ2FsbCwgcmVjb3JkVG9vbFJlc3VsdCBhcyBzYWZldHlSZWNvcmRUb29sUmVzdWx0LCBzYXZlRXZpZGVuY2VUb0Rpc2sgfSBmcm9tIFwiLi4vc2FmZXR5L2V2aWRlbmNlLWNvbGxlY3Rvci5qc1wiO1xuaW1wb3J0IHsgcGFyc2VVbml0SWQgfSBmcm9tIFwiLi4vdW5pdC1pZC5qc1wiO1xuaW1wb3J0IHsgY2xhc3NpZnlDb21tYW5kIH0gZnJvbSBcIi4uL3NhZmV0eS9kZXN0cnVjdGl2ZS1ndWFyZC5qc1wiO1xuaW1wb3J0IHsgbG9nV2FybmluZyBhcyBzYWZldHlMb2dXYXJuaW5nIH0gZnJvbSBcIi4uL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgaW5zdGFsbE5vdGlmeUludGVyY2VwdG9yIH0gZnJvbSBcIi4vbm90aWZ5LWludGVyY2VwdG9yLmpzXCI7XG5pbXBvcnQgeyBpbml0Tm90aWZpY2F0aW9uU3RvcmUgfSBmcm9tIFwiLi4vbm90aWZpY2F0aW9uLXN0b3JlLmpzXCI7XG5pbXBvcnQgeyBpbml0Tm90aWZpY2F0aW9uV2lkZ2V0IH0gZnJvbSBcIi4uL25vdGlmaWNhdGlvbi13aWRnZXQuanNcIjtcbmltcG9ydCB7IHJlc29sdmVXb3JrdHJlZVByb2plY3RSb290IH0gZnJvbSBcIi4uL3dvcmt0cmVlLXJvb3QuanNcIjtcbmltcG9ydCB7IGV4dHJhY3RTdWJhZ2VudEFnZW50Q2xhc3NlcyB9IGZyb20gXCIuL3N1YmFnZW50LWlucHV0LmpzXCI7XG5pbXBvcnQgeyBhcHByb3ZhbEdhdGVJZEZvclVuaXQsIGlzRXhwbGljaXRBcHByb3ZhbFJlc3BvbnNlLCBzaG91bGRQYXVzZUZvclVzZXJBcHByb3ZhbFF1ZXN0aW9uIH0gZnJvbSBcIi4uL3VzZXItaW5wdXQtYm91bmRhcnkuanNcIjtcbmltcG9ydCB7IHJlc29sdmVTa2lsbE1hbmlmZXN0IH0gZnJvbSBcIi4uL3NraWxsLW1hbmlmZXN0LmpzXCI7XG5cbmxldCBhcHByb3ZhbFF1ZXN0aW9uQWJvcnRJbkZsaWdodCA9IGZhbHNlO1xuXG5pbnRlcmZhY2UgRGVmZXJyZWRBcHByb3ZhbEdhdGUge1xuICBnYXRlSWQ6IHN0cmluZztcbiAgYmFzZVBhdGg6IHN0cmluZztcbn1cblxudHlwZSBXZWxjb21lU2NyZWVuTW9kdWxlID0ge1xuICBidWlsZFdlbGNvbWVTY3JlZW5MaW5lcyhvcHRzOiB7IHZlcnNpb246IHN0cmluZzsgcmVtb3RlQ2hhbm5lbD86IHN0cmluZzsgd2lkdGg/OiBudW1iZXIgfSk6IHN0cmluZ1tdO1xufTtcblxuYXN5bmMgZnVuY3Rpb24gbG9hZFdlbGNvbWVTY3JlZW5Nb2R1bGUoKTogUHJvbWlzZTxXZWxjb21lU2NyZWVuTW9kdWxlIHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGdzZEJpblBhdGggPSBwcm9jZXNzLmVudi5HU0RfQklOX1BBVEg7XG4gIGlmIChnc2RCaW5QYXRoKSB7XG4gICAgY2FuZGlkYXRlcy5wdXNoKGpvaW4oZGlybmFtZShnc2RCaW5QYXRoKSwgXCJ3ZWxjb21lLXNjcmVlbi5qc1wiKSk7XG4gIH1cblxuICBjb25zdCBwYWNrYWdlUm9vdCA9IHByb2Nlc3MuZW52LkdTRF9QS0dfUk9PVDtcbiAgaWYgKHBhY2thZ2VSb290KSB7XG4gICAgY2FuZGlkYXRlcy5wdXNoKGpvaW4ocGFja2FnZVJvb3QsIFwiZGlzdFwiLCBcIndlbGNvbWUtc2NyZWVuLmpzXCIpKTtcbiAgICBjYW5kaWRhdGVzLnB1c2goam9pbihwYWNrYWdlUm9vdCwgXCJzcmNcIiwgXCJ3ZWxjb21lLXNjcmVlbi50c1wiKSk7XG4gIH1cblxuICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmICghZXhpc3RzU3luYyhjYW5kaWRhdGUpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IG1vZCA9IGF3YWl0IGltcG9ydChwYXRoVG9GaWxlVVJMKGNhbmRpZGF0ZSkuaHJlZikgYXMgUGFydGlhbDxXZWxjb21lU2NyZWVuTW9kdWxlPjtcbiAgICAgIGlmICh0eXBlb2YgbW9kLmJ1aWxkV2VsY29tZVNjcmVlbkxpbmVzID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgcmV0dXJuIG1vZCBhcyBXZWxjb21lU2NyZWVuTW9kdWxlO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gVHJ5IHRoZSBuZXh0IHBhY2thZ2UgbGF5b3V0LlxuICAgIH1cbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5hc3luYyBmdW5jdGlvbiBpbnN0YWxsV2VsY29tZUhlYWRlcihjdHg6IEV4dGVuc2lvbkNvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFjdHguaGFzVUkgfHwgdHlwZW9mIGN0eC51aT8uc2V0SGVhZGVyICE9PSBcImZ1bmN0aW9uXCIpIHJldHVybjtcblxuICB0cnkge1xuICAgIGNvbnN0IHdlbGNvbWUgPSBhd2FpdCBsb2FkV2VsY29tZVNjcmVlbk1vZHVsZSgpO1xuICAgIGlmICghd2VsY29tZSkgcmV0dXJuO1xuXG4gICAgbGV0IHJlbW90ZUNoYW5uZWw6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyByZXNvbHZlUmVtb3RlQ29uZmlnIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi8uLi9yZW1vdGUtcXVlc3Rpb25zL2NvbmZpZy5qc1wiKTtcbiAgICAgIGNvbnN0IHJjID0gcmVzb2x2ZVJlbW90ZUNvbmZpZygpO1xuICAgICAgaWYgKHJjKSByZW1vdGVDaGFubmVsID0gcmMuY2hhbm5lbDtcbiAgICB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cblxuICAgIGN0eC51aS5zZXRIZWFkZXIoKCkgPT4ge1xuICAgICAgbGV0IGNhY2hlZExpbmVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICAgIGxldCBjYWNoZWRXaWR0aDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVuZGVyKHdpZHRoOiBudW1iZXIpOiBzdHJpbmdbXSB7XG4gICAgICAgICAgaWYgKGNhY2hlZExpbmVzICE9PSB1bmRlZmluZWQgJiYgY2FjaGVkV2lkdGggPT09IHdpZHRoKSByZXR1cm4gY2FjaGVkTGluZXM7XG4gICAgICAgICAgY2FjaGVkTGluZXMgPSB3ZWxjb21lLmJ1aWxkV2VsY29tZVNjcmVlbkxpbmVzKHtcbiAgICAgICAgICAgIHZlcnNpb246IHByb2Nlc3MuZW52LkdTRF9WRVJTSU9OIHx8IFwiMC4wLjBcIixcbiAgICAgICAgICAgIHJlbW90ZUNoYW5uZWwsXG4gICAgICAgICAgICB3aWR0aCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjYWNoZWRXaWR0aCA9IHdpZHRoO1xuICAgICAgICAgIHJldHVybiBjYWNoZWRMaW5lcztcbiAgICAgICAgfSxcbiAgICAgICAgaW52YWxpZGF0ZSgpOiB2b2lkIHtcbiAgICAgICAgICBjYWNoZWRMaW5lcyA9IHVuZGVmaW5lZDtcbiAgICAgICAgICBjYWNoZWRXaWR0aCA9IHVuZGVmaW5lZDtcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1mYXRhbCAqL1xuICB9XG59XG5cbmxldCBkZWZlcnJlZEFwcHJvdmFsR2F0ZTogRGVmZXJyZWRBcHByb3ZhbEdhdGUgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGNvbnN0IE1JTklNQUxfR1NEX1RPT0xfTkFNRVMgPSBbXG4gIFwiZ3NkX2V4ZWNcIixcbiAgXCJnc2RfZXhlY19zZWFyY2hcIixcbiAgXCJnc2RfcmVzdW1lXCIsXG4gIFwiZ3NkX21pbGVzdG9uZV9zdGF0dXNcIixcbiAgXCJnc2RfY2hlY2twb2ludF9kYlwiLFxuICBcIm1lbW9yeV9xdWVyeVwiLFxuICBcImNhcHR1cmVfdGhvdWdodFwiLFxuXSBhcyBjb25zdDtcblxuZXhwb3J0IGNvbnN0IE1JTklNQUxfQVVUT19CQVNFX1RPT0xfTkFNRVMgPSBbXG4gIFwiYXNrX3VzZXJfcXVlc3Rpb25zXCIsXG4gIFwiYmFzaFwiLFxuICBcImJnX3NoZWxsXCIsXG4gIFwiZWRpdFwiLFxuICBcImdsb2JcIixcbiAgXCJncmVwXCIsXG4gIFwibHNcIixcbiAgXCJyZWFkXCIsXG4gIFwid3JpdGVcIixcbl0gYXMgY29uc3Q7XG5cbmNvbnN0IEFVVE9fVU5JVF9TQ09QRURfVE9PTFM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPiA9IHtcbiAgXCJyZXNlYXJjaC1taWxlc3RvbmVcIjogW1wiZ3NkX3N1bW1hcnlfc2F2ZVwiLCBcImdzZF9kZWNpc2lvbl9zYXZlXCJdLFxuICBcInBsYW4tbWlsZXN0b25lXCI6IFtcImdzZF9wbGFuX21pbGVzdG9uZVwiLCBcImdzZF9kZWNpc2lvbl9zYXZlXCIsIFwiZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZVwiXSxcbiAgXCJkaXNjdXNzLW1pbGVzdG9uZVwiOiBbXCJnc2Rfc3VtbWFyeV9zYXZlXCIsIFwiZ3NkX2RlY2lzaW9uX3NhdmVcIiwgXCJnc2RfcmVxdWlyZW1lbnRfc2F2ZVwiXSxcbiAgXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIjogW1wiZ3NkX3ZhbGlkYXRlX21pbGVzdG9uZVwiLCBcImdzZF9yZWFzc2Vzc19yb2FkbWFwXCIsIFwic3ViYWdlbnRcIl0sXG4gIFwiY29tcGxldGUtbWlsZXN0b25lXCI6IFtcImdzZF9jb21wbGV0ZV9taWxlc3RvbmVcIiwgXCJzdWJhZ2VudFwiXSxcbiAgXCJyZXNlYXJjaC1zbGljZVwiOiBbXCJnc2Rfc3VtbWFyeV9zYXZlXCIsIFwiZ3NkX2RlY2lzaW9uX3NhdmVcIl0sXG4gIFwicGxhbi1zbGljZVwiOiBbXCJnc2RfcGxhbl9zbGljZVwiLCBcImdzZF9wbGFuX3Rhc2tcIiwgXCJnc2RfZGVjaXNpb25fc2F2ZVwiXSxcbiAgXCJyZWZpbmUtc2xpY2VcIjogW1wiZ3NkX3BsYW5fc2xpY2VcIiwgXCJnc2RfcGxhbl90YXNrXCIsIFwiZ3NkX2RlY2lzaW9uX3NhdmVcIl0sXG4gIFwicmVwbGFuLXNsaWNlXCI6IFtcImdzZF9yZXBsYW5fc2xpY2VcIiwgXCJnc2RfcGxhbl90YXNrXCIsIFwiZ3NkX2RlY2lzaW9uX3NhdmVcIl0sXG4gIFwiY29tcGxldGUtc2xpY2VcIjogW1wiZ3NkX3NsaWNlX2NvbXBsZXRlXCIsIFwiZ3NkX3Rhc2tfcmVvcGVuXCIsIFwiZ3NkX3JlcGxhbl9zbGljZVwiLCBcImdzZF9kZWNpc2lvbl9zYXZlXCIsIFwiZ3NkX3JlcXVpcmVtZW50X3VwZGF0ZVwiLCBcInN1YmFnZW50XCJdLFxuICBcInJlYXNzZXNzLXJvYWRtYXBcIjogW1wiZ3NkX3JlYXNzZXNzX3JvYWRtYXBcIl0sXG4gIFwiZXhlY3V0ZS10YXNrXCI6IFtcImdzZF90YXNrX2NvbXBsZXRlXCIsIFwiZ3NkX2RlY2lzaW9uX3NhdmVcIl0sXG4gIFwiZXhlY3V0ZS10YXNrLXNpbXBsZVwiOiBbXCJnc2RfdGFza19jb21wbGV0ZVwiLCBcImdzZF9kZWNpc2lvbl9zYXZlXCJdLFxuICBcInJlYWN0aXZlLWV4ZWN1dGVcIjogW1wiZ3NkX3Rhc2tfY29tcGxldGVcIiwgXCJnc2RfZGVjaXNpb25fc2F2ZVwiXSxcbiAgXCJydW4tdWF0XCI6IFtcImdzZF9zdW1tYXJ5X3NhdmVcIl0sXG4gIFwiZ2F0ZS1ldmFsdWF0ZVwiOiBbXCJnc2Rfc2F2ZV9nYXRlX3Jlc3VsdFwiXSxcbiAgXCJyZXdyaXRlLWRvY3NcIjogW1wiZ3NkX3N1bW1hcnlfc2F2ZVwiLCBcImdzZF9kZWNpc2lvbl9zYXZlXCJdLFxuICBcIndvcmtmbG93LXByZWZlcmVuY2VzXCI6IFtcImdzZF9zdW1tYXJ5X3NhdmVcIl0sXG4gIFwiZGlzY3Vzcy1wcm9qZWN0XCI6IFtcImdzZF9zdW1tYXJ5X3NhdmVcIiwgXCJnc2RfZGVjaXNpb25fc2F2ZVwiLCBcImdzZF9yZXF1aXJlbWVudF9zYXZlXCJdLFxuICBcImRpc2N1c3MtcmVxdWlyZW1lbnRzXCI6IFtcImdzZF9yZXF1aXJlbWVudF9zYXZlXCIsIFwiZ3NkX3N1bW1hcnlfc2F2ZVwiXSxcbiAgXCJyZXNlYXJjaC1kZWNpc2lvblwiOiBbXCJnc2Rfc3VtbWFyeV9zYXZlXCJdLFxuICBcInJlc2VhcmNoLXByb2plY3RcIjogW1wiZ3NkX3N1bW1hcnlfc2F2ZVwiLCBcImdzZF9kZWNpc2lvbl9zYXZlXCJdLFxufTtcblxuY29uc3QgV09SS0ZMT1dfR1NEX1RPT0xfTkFNRVMgPSBbXG4gIC4uLk1JTklNQUxfR1NEX1RPT0xfTkFNRVMsXG4gIC4uLk9iamVjdC52YWx1ZXMoQVVUT19VTklUX1NDT1BFRF9UT09MUykuZmxhdCgpLFxuXS5maWx0ZXIoaXNHc2RNYW5hZ2VkVG9vbCk7XG5cbmZ1bmN0aW9uIGlzR3NkTWFuYWdlZFRvb2wobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBuYW1lLnN0YXJ0c1dpdGgoXCJnc2RfXCIpIHx8IG5hbWUgPT09IFwibWVtb3J5X3F1ZXJ5XCIgfHwgbmFtZSA9PT0gXCJjYXB0dXJlX3Rob3VnaHRcIiB8fCBuYW1lID09PSBcImdzZF9ncmFwaFwiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRNaW5pbWFsR3NkVG9vbFNldChhY3RpdmVUb29sTmFtZXM6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBhY3RpdmUgPSBuZXcgU2V0KGFjdGl2ZVRvb2xOYW1lcyk7XG4gIGNvbnN0IHByZXNlcnZlZCA9IGFjdGl2ZVRvb2xOYW1lcy5maWx0ZXIoKG5hbWUpID0+ICFpc0dzZE1hbmFnZWRUb29sKG5hbWUpKTtcbiAgY29uc3QgbWluaW1hbCA9IE1JTklNQUxfR1NEX1RPT0xfTkFNRVMuZmlsdGVyKChuYW1lKSA9PiBhY3RpdmUuaGFzKG5hbWUpKTtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KFsuLi5wcmVzZXJ2ZWQsIC4uLm1pbmltYWxdKV07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZE1pbmltYWxBdXRvR3NkVG9vbFNldChcbiAgYWN0aXZlVG9vbE5hbWVzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgdW5pdFR5cGU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IHN0cmluZ1tdIHtcbiAgY29uc3QgYWN0aXZlID0gbmV3IFNldChhY3RpdmVUb29sTmFtZXMpO1xuICBjb25zdCB1bml0VG9vbHMgPSB1bml0VHlwZSA/IEFVVE9fVU5JVF9TQ09QRURfVE9PTFNbdW5pdFR5cGVdID8/IFtdIDogW107XG4gIGNvbnN0IGF1dG9CYXNlVG9vbHMgPSBuZXcgU2V0PHN0cmluZz4oTUlOSU1BTF9BVVRPX0JBU0VfVE9PTF9OQU1FUyk7XG4gIGNvbnN0IHByZXNlcnZlZCA9IGFjdGl2ZVRvb2xOYW1lcy5maWx0ZXIoKG5hbWUpID0+IGF1dG9CYXNlVG9vbHMuaGFzKG5hbWUpKTtcbiAgY29uc3Qgc2NvcGVkID0gWy4uLk1JTklNQUxfR1NEX1RPT0xfTkFNRVMsIC4uLnVuaXRUb29sc10uZmlsdGVyKChuYW1lKSA9PiBhY3RpdmUuaGFzKG5hbWUpKTtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KFsuLi5wcmVzZXJ2ZWQsIC4uLnNjb3BlZF0pXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTWluaW1hbEdzZFdvcmtmbG93VG9vbFNldChhY3RpdmVUb29sTmFtZXM6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBhY3RpdmUgPSBuZXcgU2V0KGFjdGl2ZVRvb2xOYW1lcyk7XG4gIGNvbnN0IGF1dG9CYXNlVG9vbHMgPSBuZXcgU2V0PHN0cmluZz4oTUlOSU1BTF9BVVRPX0JBU0VfVE9PTF9OQU1FUyk7XG4gIGNvbnN0IHByZXNlcnZlZCA9IGFjdGl2ZVRvb2xOYW1lcy5maWx0ZXIoKG5hbWUpID0+IGF1dG9CYXNlVG9vbHMuaGFzKG5hbWUpKTtcbiAgY29uc3Qgc2NvcGVkID0gV09SS0ZMT1dfR1NEX1RPT0xfTkFNRVMuZmlsdGVyKChuYW1lKSA9PiBhY3RpdmUuaGFzKG5hbWUpKTtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KFsuLi5wcmVzZXJ2ZWQsIC4uLnNjb3BlZF0pXTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkUmVxdWVzdFNjb3BlZEdzZFRvb2xTZXQoXG4gIGFjdGl2ZVRvb2xOYW1lczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHJlcXVlc3RDdXN0b21NZXNzYWdlczogcmVhZG9ubHkgeyBjdXN0b21UeXBlPzogc3RyaW5nIH1bXSB8IHVuZGVmaW5lZCxcbik6IHN0cmluZ1tdIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChsZXQgaW5kZXggPSAocmVxdWVzdEN1c3RvbU1lc3NhZ2VzPy5sZW5ndGggPz8gMCkgLSAxOyBpbmRleCA+PSAwOyBpbmRleC0tKSB7XG4gICAgY29uc3QgY3VycmVudEN1c3RvbVR5cGUgPSByZXF1ZXN0Q3VzdG9tTWVzc2FnZXM/LltpbmRleF0/LmN1c3RvbVR5cGU7XG4gICAgaWYgKFxuICAgICAgY3VycmVudEN1c3RvbVR5cGUgPT09IFwiZ3NkLXJ1blwiIHx8XG4gICAgICBjdXJyZW50Q3VzdG9tVHlwZSA9PT0gXCJnc2QtZGlzY3Vzc1wiIHx8XG4gICAgICBjdXJyZW50Q3VzdG9tVHlwZSA9PT0gXCJnc2QtZG9jdG9yLWhlYWxcIiB8fFxuICAgICAgY3VycmVudEN1c3RvbVR5cGUgPT09IFwiZ3NkLXRyaWFnZVwiXG4gICAgKSB7XG4gICAgICByZXR1cm4gYnVpbGRNaW5pbWFsR3NkV29ya2Zsb3dUb29sU2V0KGFjdGl2ZVRvb2xOYW1lcyk7XG4gICAgfVxuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0Z1bGxHc2RUb29sU3VyZmFjZVJlcXVlc3RlZCgpOiBib29sZWFuIHtcbiAgcmV0dXJuIHByb2Nlc3MuZW52LlBJX0dTRF9GVUxMX1RPT0xTID09PSBcIjFcIjtcbn1cblxuZnVuY3Rpb24gaXNHZW5lcmFsR3NkVG9vbFNjb3BpbmdSZXF1ZXN0ZWQoKTogYm9vbGVhbiB7XG4gIHJldHVybiBwcm9jZXNzLmVudi5QSV9HU0RfTUlOSU1BTF9UT09MUyA9PT0gXCIxXCI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2NvcGVkR3NkV29ya2Zsb3dTdGF0ZSB7XG4gIHRvb2xzOiBzdHJpbmdbXSB8IG51bGw7XG4gIHZpc2libGVTa2lsbHM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuICByZXN0b3JlVmlzaWJsZVNraWxsczogYm9vbGVhbjtcbn1cblxudHlwZSBHc2RXb3JrZmxvd1Njb3BlQXBpID0gUGljazxFeHRlbnNpb25BUEksIFwiZ2V0QWN0aXZlVG9vbHNcIiB8IFwic2V0QWN0aXZlVG9vbHNcIj4gJiBQYXJ0aWFsPFBpY2s8RXh0ZW5zaW9uQVBJLCBcImdldFZpc2libGVTa2lsbHNcIiB8IFwic2V0VmlzaWJsZVNraWxsc1wiPj47XG5cbmZ1bmN0aW9uIGFwcGx5TWluaW1hbEdzZFRvb2xTdXJmYWNlKHBpOiBFeHRlbnNpb25BUEkpOiB2b2lkIHtcbiAgaWYgKGlzRnVsbEdzZFRvb2xTdXJmYWNlUmVxdWVzdGVkKCkpIHJldHVybjtcbiAgY29uc3QgZGFzaCA9IGdldEF1dG9SdW50aW1lU25hcHNob3QoKTtcbiAgaWYgKGRhc2guYWN0aXZlICYmIGRhc2guY3VycmVudFVuaXQpIHtcbiAgICBwaS5zZXRBY3RpdmVUb29scyhidWlsZE1pbmltYWxBdXRvR3NkVG9vbFNldChwaS5nZXRBY3RpdmVUb29scygpLCBkYXNoLmN1cnJlbnRVbml0LnR5cGUpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFpc0dlbmVyYWxHc2RUb29sU2NvcGluZ1JlcXVlc3RlZCgpKSByZXR1cm47XG4gIHBpLnNldEFjdGl2ZVRvb2xzKGJ1aWxkTWluaW1hbEdzZFRvb2xTZXQocGkuZ2V0QWN0aXZlVG9vbHMoKSkpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2NvcGVHc2RXb3JrZmxvd1Rvb2xzRm9yRGlzcGF0Y2goXG4gIHBpOiBHc2RXb3JrZmxvd1Njb3BlQXBpLFxuICB1bml0VHlwZT86IHN0cmluZyxcbik6IFNjb3BlZEdzZFdvcmtmbG93U3RhdGUgfCBudWxsIHtcbiAgaWYgKGlzRnVsbEdzZFRvb2xTdXJmYWNlUmVxdWVzdGVkKCkpIHJldHVybiBudWxsO1xuICBjb25zdCBjdXJyZW50ID0gcGkuZ2V0QWN0aXZlVG9vbHMoKTtcbiAgY29uc3Qgc2NvcGVkID0gdW5pdFR5cGVcbiAgICA/IGJ1aWxkTWluaW1hbEF1dG9Hc2RUb29sU2V0KGN1cnJlbnQsIHVuaXRUeXBlKVxuICAgIDogYnVpbGRNaW5pbWFsR3NkV29ya2Zsb3dUb29sU2V0KGN1cnJlbnQpO1xuICBjb25zdCB0b29sc0NoYW5nZWQgPSAhKHNjb3BlZC5sZW5ndGggPT09IGN1cnJlbnQubGVuZ3RoICYmIHNjb3BlZC5ldmVyeSgobmFtZSwgaW5kZXgpID0+IG5hbWUgPT09IGN1cnJlbnRbaW5kZXhdKSk7XG4gIGNvbnN0IHNraWxsTWFuaWZlc3QgPSByZXNvbHZlU2tpbGxNYW5pZmVzdCh1bml0VHlwZSk7XG4gIGNvbnN0IGNhblNjb3BlU2tpbGxzID0gc2tpbGxNYW5pZmVzdCAhPT0gbnVsbCAmJiBwaS5nZXRWaXNpYmxlU2tpbGxzICYmIHBpLnNldFZpc2libGVTa2lsbHM7XG4gIGlmICghdG9vbHNDaGFuZ2VkICYmICFjYW5TY29wZVNraWxscykge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmICh0b29sc0NoYW5nZWQpIHtcbiAgICBwaS5zZXRBY3RpdmVUb29scyhzY29wZWQpO1xuICB9XG4gIGNvbnN0IHZpc2libGVTa2lsbHMgPSBjYW5TY29wZVNraWxscyA/IHBpLmdldFZpc2libGVTa2lsbHMhKCkgOiB1bmRlZmluZWQ7XG4gIGlmIChjYW5TY29wZVNraWxscykge1xuICAgIHBpLnNldFZpc2libGVTa2lsbHMhKHNraWxsTWFuaWZlc3QpO1xuICB9XG4gIHJldHVybiB7XG4gICAgdG9vbHM6IHRvb2xzQ2hhbmdlZCA/IGN1cnJlbnQgOiBudWxsLFxuICAgIHZpc2libGVTa2lsbHMsXG4gICAgcmVzdG9yZVZpc2libGVTa2lsbHM6IEJvb2xlYW4oY2FuU2NvcGVTa2lsbHMpLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzdG9yZUdzZFdvcmtmbG93VG9vbHMoXG4gIHBpOiBQaWNrPEV4dGVuc2lvbkFQSSwgXCJzZXRBY3RpdmVUb29sc1wiPiAmIFBhcnRpYWw8UGljazxFeHRlbnNpb25BUEksIFwic2V0VmlzaWJsZVNraWxsc1wiPj4sXG4gIHNhdmVkU3RhdGU6IFNjb3BlZEdzZFdvcmtmbG93U3RhdGUgfCBudWxsLFxuKTogdm9pZCB7XG4gIGlmICghc2F2ZWRTdGF0ZSkgcmV0dXJuO1xuICBpZiAoc2F2ZWRTdGF0ZS50b29scykgcGkuc2V0QWN0aXZlVG9vbHMoc2F2ZWRTdGF0ZS50b29scyk7XG4gIGlmIChzYXZlZFN0YXRlLnJlc3RvcmVWaXNpYmxlU2tpbGxzICYmIHBpLnNldFZpc2libGVTa2lsbHMpIHtcbiAgICBwaS5zZXRWaXNpYmxlU2tpbGxzKHNhdmVkU3RhdGUudmlzaWJsZVNraWxscyk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGVyaXZlR3NkU3RhdGUoYmFzZVBhdGg6IHN0cmluZykge1xuICBjb25zdCB7IGRlcml2ZVN0YXRlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9zdGF0ZS5qc1wiKTtcbiAgcmV0dXJuIGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RGlzY3Vzc2lvbk1pbGVzdG9uZUlkRm9yKGJhc2VQYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgeyBnZXREaXNjdXNzaW9uTWlsZXN0b25lSWQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2d1aWRlZC1mbG93LmpzXCIpO1xuICByZXR1cm4gZ2V0RGlzY3Vzc2lvbk1pbGVzdG9uZUlkKGJhc2VQYXRoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZFRvb2xBcGlLZXlzRm9yU2Vzc2lvbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBsb2FkVG9vbEFwaUtleXMgfSA9IGF3YWl0IGltcG9ydChcIi4uL2NvbW1hbmRzLWNvbmZpZy5qc1wiKTtcbiAgbG9hZFRvb2xBcGlLZXlzKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc2V0QXNrVXNlclF1ZXN0aW9uc1R1cm5DYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyByZXNldEFza1VzZXJRdWVzdGlvbnNDYWNoZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vLi4vYXNrLXVzZXItcXVlc3Rpb25zLmpzXCIpO1xuICByZXNldEFza1VzZXJRdWVzdGlvbnNDYWNoZSgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzeW5jU2VydmljZVRpZXJTdGF0dXMoY3R4OiBFeHRlbnNpb25Db250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgZ2V0RWZmZWN0aXZlU2VydmljZVRpZXIsIGZvcm1hdFNlcnZpY2VUaWVyRm9vdGVyU3RhdHVzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9zZXJ2aWNlLXRpZXIuanNcIik7XG4gIGN0eC51aS5zZXRTdGF0dXMoXCJnc2QtZmFzdFwiLCBmb3JtYXRTZXJ2aWNlVGllckZvb3RlclN0YXR1cyhnZXRFZmZlY3RpdmVTZXJ2aWNlVGllcigpLCBjdHgubW9kZWw/LmlkKSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwcGx5RGlzYWJsZWRNb2RlbFByb3ZpZGVyUG9saWN5KGN0eDogRXh0ZW5zaW9uQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHsgcmVzb2x2ZURpc2FibGVkTW9kZWxQcm92aWRlcnNGcm9tUHJlZmVyZW5jZXMgfSA9IGF3YWl0IGltcG9ydChcIi4uL3ByZWZlcmVuY2VzLmpzXCIpO1xuICAgIGN0eC5tb2RlbFJlZ2lzdHJ5LnNldERpc2FibGVkTW9kZWxQcm92aWRlcnMocmVzb2x2ZURpc2FibGVkTW9kZWxQcm92aWRlcnNGcm9tUHJlZmVyZW5jZXMoKSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbDoga2VlcCBkZWZhdWx0IHByb3ZpZGVyIHZpc2liaWxpdHkgaWYgcHJlZmVyZW5jZXMgY2Fubm90IGJlIGxvYWRlZC5cbiAgfVxufVxuXG4vKipcbiAqIEJyaWRnZSBgY29udGV4dF9tYW5hZ2VtZW50LmNvbXBhY3Rpb25fdGhyZXNob2xkX3BlcmNlbnRgIGZyb20gR1NEIHByZWZlcmVuY2VzXG4gKiBpbnRvIHRoZSBhZ2VudCdzIHJ1bnRpbWUgY29tcGFjdGlvbiBzZXR0aW5ncyAoIzU0NzUpLiBUaGUgcHJlZmVyZW5jZSBpc1xuICogdmFsaWRhdGVkIHRvICgwLjUsIDAuOTUpIGF0IGxvYWQgdGltZSwgYnV0IGRlZmVuc2UtaW4tZGVwdGggbm9ybWFsaXphdGlvblxuICogaGVyZSBwcm90ZWN0cyBhZ2FpbnN0IGEgc3RhbGUgb3IgaGFuZC1lZGl0ZWQgcHJlZnMgZmlsZS4gQ2FsbGluZyB3aXRoXG4gKiBgdW5kZWZpbmVkYCBjbGVhcnMgYW55IHByaW9yIG92ZXJyaWRlIHNvIGEgcmVtb3ZlZCBwcmVmZXJlbmNlIGRvZXMgbm90IGxlYWsuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGFwcGx5Q29tcGFjdGlvblRocmVzaG9sZE92ZXJyaWRlKGN0eDogRXh0ZW5zaW9uQ29udGV4dCk6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9wcmVmZXJlbmNlcy5qc1wiKTtcbiAgICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpO1xuICAgIGNvbnN0IHJhdyA9IHByZWZzPy5wcmVmZXJlbmNlcy5jb250ZXh0X21hbmFnZW1lbnQ/LmNvbXBhY3Rpb25fdGhyZXNob2xkX3BlcmNlbnQ7XG4gICAgY29uc3QgdmFsdWUgPVxuICAgICAgdHlwZW9mIHJhdyA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUocmF3KSAmJiByYXcgPiAwICYmIHJhdyA8IDEgPyByYXcgOiB1bmRlZmluZWQ7XG4gICAgY3R4LnNldENvbXBhY3Rpb25UaHJlc2hvbGRPdmVycmlkZSh2YWx1ZSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbDogbGVhdmUgYW55IGV4aXN0aW5nIG92ZXJyaWRlIGluIHBsYWNlLlxuICB9XG59XG5cbmZ1bmN0aW9uIGNsZWFyRGVmZXJyZWRBcHByb3ZhbEdhdGUoYmFzZVBhdGg/OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFiYXNlUGF0aCB8fCBkZWZlcnJlZEFwcHJvdmFsR2F0ZT8uYmFzZVBhdGggPT09IGJhc2VQYXRoKSB7XG4gICAgZGVmZXJyZWRBcHByb3ZhbEdhdGUgPSBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGRlZmVyQXBwcm92YWxHYXRlKGdhdGVJZDogc3RyaW5nLCBiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGRlZmVycmVkQXBwcm92YWxHYXRlID0geyBnYXRlSWQsIGJhc2VQYXRoIH07XG59XG5cbmZ1bmN0aW9uIGNvbnRleHRCYXNlUGF0aChjdHg/OiB7IGN3ZD86IHN0cmluZyB9KTogc3RyaW5nIHtcbiAgcmV0dXJuIHR5cGVvZiBjdHg/LmN3ZCA9PT0gXCJzdHJpbmdcIiA/IGN0eC5jd2QgOiBwcm9jZXNzLmN3ZCgpO1xufVxuXG5mdW5jdGlvbiBhY3RpdmF0ZURlZmVycmVkQXBwcm92YWxHYXRlKGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKGRlZmVycmVkQXBwcm92YWxHYXRlPy5iYXNlUGF0aCAhPT0gYmFzZVBhdGgpIHJldHVybjtcbiAgc2V0UGVuZGluZ0dhdGUoZGVmZXJyZWRBcHByb3ZhbEdhdGUuZ2F0ZUlkLCBiYXNlUGF0aCk7XG4gIGRlZmVycmVkQXBwcm92YWxHYXRlID0gbnVsbDtcbn1cblxuZnVuY3Rpb24gaXNDb250ZXh0RHJhZnRTdW1tYXJ5U2F2ZSh0b29sTmFtZTogc3RyaW5nLCBpbnB1dDogdW5rbm93bik6IGJvb2xlYW4ge1xuICBpZiAodG9vbE5hbWUgIT09IFwiZ3NkX3N1bW1hcnlfc2F2ZVwiICYmIHRvb2xOYW1lICE9PSBcInN1bW1hcnlfc2F2ZVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmICghaW5wdXQgfHwgdHlwZW9mIGlucHV0ICE9PSBcIm9iamVjdFwiKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAoaW5wdXQgYXMgeyBhcnRpZmFjdF90eXBlPzogdW5rbm93biB9KS5hcnRpZmFjdF90eXBlID09PSBcIkNPTlRFWFQtRFJBRlRcIjtcbn1cblxuZnVuY3Rpb24gc2hvdWxkQmxvY2tEZWZlcnJlZEFwcHJvdmFsVG9vbChcbiAgdG9vbE5hbWU6IHN0cmluZyxcbiAgaW5wdXQ6IHVua25vd24sXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4pOiB7IGJsb2NrOiBib29sZWFuOyByZWFzb24/OiBzdHJpbmcgfSB7XG4gIGlmIChkZWZlcnJlZEFwcHJvdmFsR2F0ZT8uYmFzZVBhdGggIT09IGJhc2VQYXRoKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgaWYgKHRvb2xOYW1lID09PSBcImFza191c2VyX3F1ZXN0aW9uc1wiKSByZXR1cm4geyBibG9jazogZmFsc2UgfTtcbiAgaWYgKGlzQ29udGV4dERyYWZ0U3VtbWFyeVNhdmUodG9vbE5hbWUsIGlucHV0KSkgcmV0dXJuIHsgYmxvY2s6IGZhbHNlIH07XG4gIHJldHVybiB7XG4gICAgYmxvY2s6IHRydWUsXG4gICAgcmVhc29uOiBbXG4gICAgICBgSEFSRCBCTE9DSzogQXBwcm92YWwgcXVlc3Rpb24gXCIke2RlZmVycmVkQXBwcm92YWxHYXRlLmdhdGVJZH1cIiBoYXMgYmVlbiBzaG93biB0byB0aGUgdXNlci5gLFxuICAgICAgYE9ubHkgQ09OVEVYVC1EUkFGVCBwZXJzaXN0ZW5jZSBtYXkgZmluaXNoIGluIHRoaXMgc2FtZSBhc3Npc3RhbnQgdHVybi5gLFxuICAgICAgYFdhaXQgZm9yIHRoZSB1c2VyJ3MgYW5zd2VyIGJlZm9yZSBjYWxsaW5nIGFkZGl0aW9uYWwgdG9vbHMuYCxcbiAgICBdLmpvaW4oXCIgXCIpLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU5vdGlmaWNhdGlvblN0b3JlQmFzZVBhdGgoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdChiYXNlUGF0aCk7XG59XG5cbmZ1bmN0aW9uIGluaXRTZXNzaW9uTm90aWZpY2F0aW9ucyhjdHg6IEV4dGVuc2lvbkNvbnRleHQpOiB2b2lkIHtcbiAgaW5pdE5vdGlmaWNhdGlvblN0b3JlKHJlc29sdmVOb3RpZmljYXRpb25TdG9yZUJhc2VQYXRoKGNvbnRleHRCYXNlUGF0aChjdHgpKSk7XG4gIGluc3RhbGxOb3RpZnlJbnRlcmNlcHRvcihjdHgpO1xuICBpbml0Tm90aWZpY2F0aW9uV2lkZ2V0KGN0eCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdyaXRlQ29udGV4dE1vZGVDb21wYWN0aW9uU25hcHNob3QoYmFzZVBhdGg6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9wcmVmZXJlbmNlcy5qc1wiKTtcbiAgICBjb25zdCB7IGlzQ29udGV4dE1vZGVFbmFibGVkIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9wcmVmZXJlbmNlcy10eXBlcy5qc1wiKTtcbiAgICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhiYXNlUGF0aCk7XG4gICAgaWYgKCFpc0NvbnRleHRNb2RlRW5hYmxlZChwcmVmcz8ucHJlZmVyZW5jZXMpKSByZXR1cm47XG5cbiAgICBjb25zdCB7IHdyaXRlQ29tcGFjdGlvblNuYXBzaG90IH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9jb21wYWN0aW9uLXNuYXBzaG90LmpzXCIpO1xuICAgIGNvbnN0IHsgZW5zdXJlRGJPcGVuIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2R5bmFtaWMtdG9vbHMuanNcIik7XG4gICAgYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcblxuICAgIGxldCBhY3RpdmVDb250ZXh0OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVHc2RTdGF0ZShiYXNlUGF0aCk7XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlTWlsZXN0b25lICYmIHN0YXRlLmFjdGl2ZVNsaWNlICYmIHN0YXRlLmFjdGl2ZVRhc2spIHtcbiAgICAgICAgYWN0aXZlQ29udGV4dCA9XG4gICAgICAgICAgYEFjdGl2ZTogJHtzdGF0ZS5hY3RpdmVNaWxlc3RvbmUuaWR9IC8gJHtzdGF0ZS5hY3RpdmVTbGljZS5pZH0gLyAke3N0YXRlLmFjdGl2ZVRhc2suaWR9YCArXG4gICAgICAgICAgKHN0YXRlLmFjdGl2ZVRhc2sudGl0bGUgPyBgIC0gJHtzdGF0ZS5hY3RpdmVUYXNrLnRpdGxlfWAgOiBcIlwiKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vbi1mYXRhbCAqL1xuICAgIH1cblxuICAgIHdyaXRlQ29tcGFjdGlvblNuYXBzaG90KGJhc2VQYXRoLCB7IGFjdGl2ZUNvbnRleHQgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHNhZmV0eUxvZ1dhcm5pbmcoXG4gICAgICBcImNvbnRleHQtbW9kZVwiLFxuICAgICAgYGZhaWxlZCB0byB3cml0ZSBjb21wYWN0aW9uIHNuYXBzaG90OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVySG9va3MoXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGVjb3N5c3RlbUhhbmRsZXJzOiBHU0RFY29zeXN0ZW1CZWZvcmVBZ2VudFN0YXJ0SGFuZGxlcltdLFxuKTogdm9pZCB7XG4gIC8vIEFEUi0wMDUgUGhhc2UgM2I6IHN1cmZhY2UgcGktYWkgUHJvdmlkZXJTd2l0Y2hSZXBvcnQgdmlhIGF1ZGl0LCBub3RpZmljYXRpb24sIGFuZCBjb3VudGVyLlxuICAvLyBJZGVtcG90ZW50IFx1MjAxNCBvbmx5IHRoZSBmaXJzdCByZWdpc3Rlckhvb2tzIGNhbGwgaW5zdGFsbHMuXG4gIHZvaWQgaW1wb3J0KFwiLi4vcHJvdmlkZXItc3dpdGNoLW9ic2VydmVyLmpzXCIpLnRoZW4oKG0pID0+IG0uaW5zdGFsbFByb3ZpZGVyU3dpdGNoT2JzZXJ2ZXIoKSk7XG5cbiAgcGkub24oXCJzZXNzaW9uX3N0YXJ0XCIsIGFzeW5jIChfZXZlbnQsIGN0eCkgPT4ge1xuICAgIGNvbnN0IGJhc2VQYXRoID0gY29udGV4dEJhc2VQYXRoKGN0eCk7XG4gICAgaW5pdFNlc3Npb25Ob3RpZmljYXRpb25zKGN0eCk7XG4gICAgaWYgKCFpc0F1dG9BY3RpdmUoKSkge1xuICAgICAgY29uc3QgeyBpbml0SGVhbHRoV2lkZ2V0IH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9oZWFsdGgtd2lkZ2V0LmpzXCIpO1xuICAgICAgaW5pdEhlYWx0aFdpZGdldChjdHgpO1xuICAgIH1cbiAgICByZXNldFdyaXRlR2F0ZVN0YXRlKGJhc2VQYXRoKTtcbiAgICByZXNldFRvb2xDYWxsTG9vcEd1YXJkKCk7XG4gICAgYXBwcm92YWxRdWVzdGlvbkFib3J0SW5GbGlnaHQgPSBmYWxzZTtcbiAgICBjbGVhckRlZmVycmVkQXBwcm92YWxHYXRlKCk7XG4gICAgYXdhaXQgcmVzZXRBc2tVc2VyUXVlc3Rpb25zVHVybkNhY2hlKCk7XG4gICAgYXdhaXQgc3luY1NlcnZpY2VUaWVyU3RhdHVzKGN0eCk7XG4gICAgYXdhaXQgYXBwbHlEaXNhYmxlZE1vZGVsUHJvdmlkZXJQb2xpY3koY3R4KTtcbiAgICBhd2FpdCBhcHBseUNvbXBhY3Rpb25UaHJlc2hvbGRPdmVycmlkZShjdHgpO1xuICAgIC8vIFNraXAgTUNQIGF1dG8tcHJlcCB3aGVuIHJ1bm5pbmcgaW5zaWRlIGFuIGF1dG8td29ya3RyZWUgKHNlZSBzZXNzaW9uX3N3aXRjaCBiZWxvdykuXG4gICAgY29uc3QgeyBpc0luQXV0b1dvcmt0cmVlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9hdXRvLXdvcmt0cmVlLmpzXCIpO1xuICAgIGlmICghaXNJbkF1dG9Xb3JrdHJlZShiYXNlUGF0aCkpIHtcbiAgICAgIGNvbnN0IHsgcHJlcGFyZVdvcmtmbG93TWNwRm9yUHJvamVjdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vd29ya2Zsb3ctbWNwLWF1dG8tcHJlcC5qc1wiKTtcbiAgICAgIHByZXBhcmVXb3JrZmxvd01jcEZvclByb2plY3QoY3R4LCBiYXNlUGF0aCk7XG4gICAgfVxuXG4gICAgLy8gQXBwbHkgc2hvd190b2tlbl9jb3N0IHByZWZlcmVuY2UgKCMxNTE1KVxuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcHJlZmVyZW5jZXMuanNcIik7XG4gICAgICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhiYXNlUGF0aCk7XG4gICAgICBwcm9jZXNzLmVudi5HU0RfU0hPV19UT0tFTl9DT1NUID0gcHJlZnM/LnByZWZlcmVuY2VzLnNob3dfdG9rZW5fY29zdCA/IFwiMVwiIDogXCJcIjtcbiAgICB9IGNhdGNoIHsgLyogbm9uLWZhdGFsICovIH1cbiAgICBhd2FpdCBpbnN0YWxsV2VsY29tZUhlYWRlcihjdHgpO1xuICAgIGF3YWl0IGxvYWRUb29sQXBpS2V5c0ZvclNlc3Npb24oKTtcbiAgICBpZiAoaXNBdXRvQWN0aXZlKCkpIHtcbiAgICAgIGN0eC51aS5zZXRXaWRnZXQoXCJnc2QtaGVhbHRoXCIsIHVuZGVmaW5lZCk7XG4gICAgfVxuICB9KTtcblxuICBwaS5vbihcInNlc3Npb25fc3dpdGNoXCIsIGFzeW5jIChfZXZlbnQsIGN0eCkgPT4ge1xuICAgIGNvbnN0IGJhc2VQYXRoID0gY29udGV4dEJhc2VQYXRoKGN0eCk7XG4gICAgaW5pdFNlc3Npb25Ob3RpZmljYXRpb25zKGN0eCk7XG4gICAgcmVzZXRXcml0ZUdhdGVTdGF0ZShiYXNlUGF0aCk7XG4gICAgcmVzZXRUb29sQ2FsbExvb3BHdWFyZCgpO1xuICAgIGNsZWFyRGVmZXJyZWRBcHByb3ZhbEdhdGUoKTtcbiAgICBhd2FpdCByZXNldEFza1VzZXJRdWVzdGlvbnNUdXJuQ2FjaGUoKTtcbiAgICBjbGVhckRpc2N1c3Npb25GbG93U3RhdGUoYmFzZVBhdGgpO1xuICAgIGF3YWl0IHN5bmNTZXJ2aWNlVGllclN0YXR1cyhjdHgpO1xuICAgIGF3YWl0IGFwcGx5RGlzYWJsZWRNb2RlbFByb3ZpZGVyUG9saWN5KGN0eCk7XG4gICAgYXdhaXQgYXBwbHlDb21wYWN0aW9uVGhyZXNob2xkT3ZlcnJpZGUoY3R4KTtcbiAgICAvLyBTa2lwIE1DUCBhdXRvLXByZXAgd2hlbiBydW5uaW5nIGluc2lkZSBhbiBhdXRvLXdvcmt0cmVlLiBUaGUgd29ya3RyZWVcbiAgICAvLyBhbHJlYWR5IGhhcyAubWNwLmpzb24gZnJvbSBjcmVhdGVBdXRvV29ya3RyZWUsIGFuZCByZS1ydW5uaW5nIHRoZSB3cml0ZXJcbiAgICAvLyBwb3N0LWNoZGlyIHJld3JpdGVzIHRoZSBmaWxlIG1pZC1ydW4gKG5vbi1pZGVtcG90ZW50IGR1ZSB0byBjd2QtcmVsYXRpdmVcbiAgICAvLyBDTEkgcGF0aCByZXNvbHV0aW9uKSwgZGlydHlpbmcgdGhlIHRyZWUgYW5kIGJyZWFraW5nIHRoZSBtaWxlc3RvbmUgbWVyZ2UuXG4gICAgY29uc3QgeyBpc0luQXV0b1dvcmt0cmVlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9hdXRvLXdvcmt0cmVlLmpzXCIpO1xuICAgIGlmICghaXNJbkF1dG9Xb3JrdHJlZShiYXNlUGF0aCkpIHtcbiAgICAgIGNvbnN0IHsgcHJlcGFyZVdvcmtmbG93TWNwRm9yUHJvamVjdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vd29ya2Zsb3ctbWNwLWF1dG8tcHJlcC5qc1wiKTtcbiAgICAgIHByZXBhcmVXb3JrZmxvd01jcEZvclByb2plY3QoY3R4LCBiYXNlUGF0aCk7XG4gICAgfVxuICAgIGF3YWl0IGxvYWRUb29sQXBpS2V5c0ZvclNlc3Npb24oKTtcbiAgICBpZiAoIWlzQXV0b0FjdGl2ZSgpKSB7XG4gICAgICBjdHgudWkuc2V0V2lkZ2V0KFwiZ3NkLXByb2dyZXNzXCIsIHVuZGVmaW5lZCk7XG4gICAgICBjdHgudWkuc2V0V2lkZ2V0KFwiZ3NkLW91dGNvbWVcIiwgdW5kZWZpbmVkKTtcbiAgICAgIGNvbnN0IHsgaW5pdEhlYWx0aFdpZGdldCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vaGVhbHRoLXdpZGdldC5qc1wiKTtcbiAgICAgIGluaXRIZWFsdGhXaWRnZXQoY3R4KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3R4LnVpLnNldFdpZGdldChcImdzZC1oZWFsdGhcIiwgdW5kZWZpbmVkKTtcbiAgICB9XG4gIH0pO1xuXG4gIHBpLm9uKFwiYmVmb3JlX2FnZW50X3N0YXJ0XCIsIGFzeW5jIChldmVudCwgY3R4OiBFeHRlbnNpb25Db250ZXh0KSA9PiB7XG4gICAgYXBwbHlNaW5pbWFsR3NkVG9vbFN1cmZhY2UocGkpO1xuXG4gICAgLy8gV2FpdCBmb3IgZWNvc3lzdGVtIGxvYWRlciB0byBmaW5pc2ggKG5vLW9wIGFmdGVyIGZpcnN0IHR1cm4pLlxuICAgIGNvbnN0IHsgZ2V0RWNvc3lzdGVtUmVhZHlQcm9taXNlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9lY29zeXN0ZW0vbG9hZGVyLmpzXCIpO1xuICAgIGF3YWl0IGdldEVjb3N5c3RlbVJlYWR5UHJvbWlzZSgpO1xuXG4gICAgY29uc3QgYmVmb3JlQWdlbnRCYXNlUGF0aCA9IGNvbnRleHRCYXNlUGF0aChjdHgpO1xuICAgIGNvbnN0IHBlbmRpbmdBcHByb3ZhbEdhdGUgPSBnZXRQZW5kaW5nR2F0ZShiZWZvcmVBZ2VudEJhc2VQYXRoKTtcbiAgICBpZiAocGVuZGluZ0FwcHJvdmFsR2F0ZSAmJiBpc0V4cGxpY2l0QXBwcm92YWxSZXNwb25zZShldmVudC5wcm9tcHQsIHBlbmRpbmdBcHByb3ZhbEdhdGUpKSB7XG4gICAgICBtYXJrQXBwcm92YWxHYXRlVmVyaWZpZWQocGVuZGluZ0FwcHJvdmFsR2F0ZSwgYmVmb3JlQWdlbnRCYXNlUGF0aCk7XG4gICAgICBjb25zdCBtaWxlc3RvbmVJZCA9IGV4dHJhY3REZXB0aFZlcmlmaWNhdGlvbk1pbGVzdG9uZUlkKHBlbmRpbmdBcHByb3ZhbEdhdGUpO1xuICAgICAgaWYgKG1pbGVzdG9uZUlkKSBtYXJrRGVwdGhWZXJpZmllZChtaWxlc3RvbmVJZCwgYmVmb3JlQWdlbnRCYXNlUGF0aCk7XG4gICAgICBjbGVhclBlbmRpbmdHYXRlKGJlZm9yZUFnZW50QmFzZVBhdGgpO1xuICAgIH1cbiAgICBjbGVhckRlZmVycmVkQXBwcm92YWxHYXRlKGJlZm9yZUFnZW50QmFzZVBhdGgpO1xuXG4gICAgLy8gR1NEJ3Mgb3duIGNvbnRleHQgaW5qZWN0aW9uIChleGlzdGluZyBiZWhhdmlvciBcdTIwMTQgdW5jaGFuZ2VkKS5cbiAgICBjb25zdCB7IGJ1aWxkQmVmb3JlQWdlbnRTdGFydFJlc3VsdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9zeXN0ZW0tY29udGV4dC5qc1wiKTtcbiAgICBjb25zdCBnc2RSZXN1bHQgPSBhd2FpdCBidWlsZEJlZm9yZUFnZW50U3RhcnRSZXN1bHQoZXZlbnQsIGN0eCk7XG5cbiAgICAvLyBSZWZyZXNoIHRoZSBzbmFwc2hvdCB1c2VkIGJ5IGVjb3N5c3RlbSBnZXRQaGFzZSgpL2dldEFjdGl2ZVVuaXQoKS5cbiAgICAvLyBkZXJpdmVTdGF0ZSBoYXMgaXRzIG93biB+MTAwbXMgY2FjaGUgc28gdGhpcyBpcyBjaGVhcCBvbiByZXBlYXQgY2FsbHMuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlR3NkU3RhdGUoYmVmb3JlQWdlbnRCYXNlUGF0aCk7XG4gICAgICB1cGRhdGVTbmFwc2hvdChzdGF0ZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB1cGRhdGVTbmFwc2hvdChudWxsKTtcbiAgICB9XG5cbiAgICAvLyBDaGFpbiBlY29zeXN0ZW0gaGFuZGxlcnMgdXNpbmcgcGkncyBydW5uZXIudHMgY2hhaW5pbmcgcHJvdG9jb2w6XG4gICAgLy8gZWFjaCBoYW5kbGVyIHNlZXMgdGhlIHN5c3RlbVByb21wdCBtdXRhdGVkIGJ5IHByaW9yIGhhbmRsZXJzLlxuICAgIGxldCBjdXJyZW50U3lzdGVtUHJvbXB0ID0gZ3NkUmVzdWx0Py5zeXN0ZW1Qcm9tcHQgPz8gZXZlbnQuc3lzdGVtUHJvbXB0O1xuICAgIC8vIGBhbnlgIGJlY2F1c2UgcGkncyBCZWZvcmVBZ2VudFN0YXJ0RXZlbnRSZXN1bHQubWVzc2FnZSB1c2VzIGFuIGludGVybmFsXG4gICAgLy8gQ3VzdG9tTWVzc2FnZSB0eXBlIHRoYXQncyBub3QgcmUtZXhwb3J0ZWQgKHNlZSBlY29zeXN0ZW0vZ3NkLWV4dGVuc2lvbi1hcGkudHMpLlxuICAgIGxldCBsYXN0TWVzc2FnZTogYW55ID0gZ3NkUmVzdWx0Py5tZXNzYWdlO1xuXG4gICAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGVjb3N5c3RlbUhhbmRsZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByID0gYXdhaXQgaGFuZGxlcihcbiAgICAgICAgICB7IC4uLmV2ZW50LCBzeXN0ZW1Qcm9tcHQ6IGN1cnJlbnRTeXN0ZW1Qcm9tcHQgfSxcbiAgICAgICAgICBjdHgsXG4gICAgICAgICk7XG4gICAgICAgIGlmIChyPy5zeXN0ZW1Qcm9tcHQgIT09IHVuZGVmaW5lZCkgY3VycmVudFN5c3RlbVByb21wdCA9IHIuc3lzdGVtUHJvbXB0O1xuICAgICAgICBpZiAocj8ubWVzc2FnZSkgbGFzdE1lc3NhZ2UgPSByLm1lc3NhZ2U7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgc2FmZXR5TG9nV2FybmluZyhcbiAgICAgICAgICBcImVjb3N5c3RlbVwiLFxuICAgICAgICAgIGBiZWZvcmVfYWdlbnRfc3RhcnQgaGFuZGxlciBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ29tcG9zZSByZXN1bHQuIFJldHVybiB1bmRlZmluZWQgaWYgbm90aGluZyBjaGFuZ2VkIChwcmVzZXJ2ZXMgcnVubmVyIGNvbnRyYWN0KS5cbiAgICBpZiAoY3VycmVudFN5c3RlbVByb21wdCA9PT0gZXZlbnQuc3lzdGVtUHJvbXB0ICYmICFsYXN0TWVzc2FnZSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICByZXR1cm4ge1xuICAgICAgc3lzdGVtUHJvbXB0OiBjdXJyZW50U3lzdGVtUHJvbXB0ICE9PSBldmVudC5zeXN0ZW1Qcm9tcHQgPyBjdXJyZW50U3lzdGVtUHJvbXB0IDogdW5kZWZpbmVkLFxuICAgICAgbWVzc2FnZTogbGFzdE1lc3NhZ2UsXG4gICAgfTtcbiAgfSk7XG5cbiAgcGkub24oXCJhZ2VudF9lbmRcIiwgYXN5bmMgKGV2ZW50LCBjdHg6IEV4dGVuc2lvbkNvbnRleHQpID0+IHtcbiAgICBhcHByb3ZhbFF1ZXN0aW9uQWJvcnRJbkZsaWdodCA9IGZhbHNlO1xuICAgIHJlc2V0VG9vbENhbGxMb29wR3VhcmQoKTtcbiAgICBhd2FpdCByZXNldEFza1VzZXJRdWVzdGlvbnNUdXJuQ2FjaGUoKTtcbiAgICBjb25zdCB7IGhhbmRsZUFnZW50RW5kIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2FnZW50LWVuZC1yZWNvdmVyeS5qc1wiKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgaGFuZGxlQWdlbnRFbmQocGksIGV2ZW50LCBjdHgpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBhY3RpdmF0ZURlZmVycmVkQXBwcm92YWxHYXRlKGNvbnRleHRCYXNlUGF0aChjdHgpKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vIFNxdWFzaC1tZXJnZSBxdWljay10YXNrIGJyYW5jaCBiYWNrIHRvIHRoZSBvcmlnaW5hbCBicmFuY2ggYWZ0ZXIgdGhlXG4gIC8vIGFnZW50IHR1cm4gY29tcGxldGVzICgjMjY2OCkuIGNsZWFudXBRdWlja0JyYW5jaCBpcyBhIG5vLW9wIHdoZW4gbm9cbiAgLy8gcXVpY2stcmV0dXJuIHN0YXRlIGlzIHBlbmRpbmcsIHNvIHRoaXMgaXMgc2FmZSB0byBjYWxsIG9uIGV2ZXJ5IHR1cm4uXG4gIHBpLm9uKFwidHVybl9lbmRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGNsZWFudXBRdWlja0JyYW5jaCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vcXVpY2suanNcIik7XG4gICAgICBjbGVhbnVwUXVpY2tCcmFuY2goKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEJlc3QtZWZmb3J0OiBkb24ndCBicmVhayB0aGUgdHVybiBsaWZlY3ljbGUgaWYgY2xlYW51cCBmYWlscy5cbiAgICB9XG4gIH0pO1xuXG4gIHBpLm9uKFwic2Vzc2lvbl9iZWZvcmVfY29tcGFjdFwiLCBhc3luYyAoX2V2ZW50LCBjdHgpID0+IHtcbiAgICBjb25zdCBiYXNlUGF0aCA9IGNvbnRleHRCYXNlUGF0aChjdHgpO1xuICAgIC8vIENvbnRleHQgTW9kZSBpcyBkZWZhdWx0LW9uLiBXcml0ZSB0aGUgcmVzdW1hYmxlIHNuYXBzaG90IGJlZm9yZSBhbnlcbiAgICAvLyBhY3RpdmUtYXV0byBjYW5jZWwgcmV0dXJuIHNvIGF1dG8gc2Vzc2lvbnMgc3RpbGwgbGVhdmUgcmUtZW50cnkgY29udGV4dC5cbiAgICBhd2FpdCB3cml0ZUNvbnRleHRNb2RlQ29tcGFjdGlvblNuYXBzaG90KGJhc2VQYXRoKTtcblxuICAgIC8vIE9ubHkgY2FuY2VsIGNvbXBhY3Rpb24gd2hpbGUgYXV0by1tb2RlIGlzIGFjdGl2ZWx5IHJ1bm5pbmcuXG4gICAgLy8gUGF1c2VkIGF1dG8tbW9kZSBzaG91bGQgYWxsb3cgY29tcGFjdGlvbiBcdTIwMTQgdGhlIHVzZXIgbWF5IGJlIGRvaW5nXG4gICAgLy8gaW50ZXJhY3RpdmUgd29yayAoIzMxNjUpLlxuICAgIGlmIChpc0F1dG9BY3RpdmUoKSkge1xuICAgICAgcmV0dXJuIHsgY2FuY2VsOiB0cnVlIH07XG4gICAgfVxuICAgIGNvbnN0IHsgZW5zdXJlRGJPcGVuIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2R5bmFtaWMtdG9vbHMuanNcIik7XG4gICAgYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZUdzZFN0YXRlKGJhc2VQYXRoKTtcbiAgICBpZiAoIXN0YXRlLmFjdGl2ZU1pbGVzdG9uZSB8fCAhc3RhdGUuYWN0aXZlU2xpY2UpIHJldHVybjtcbiAgICAvLyBXcml0ZSBjaGVja3BvaW50IGZvciBBTEwgcGhhc2VzLCBub3QganVzdCBcImV4ZWN1dGluZ1wiIFx1MjAxNCBkaXNjdXNzLCByZXNlYXJjaCxcbiAgICAvLyBhbmQgcGxhbm5pbmcgYWxzbyBjYXJyeSBpbi1tZW1vcnkgc3RhdGUgKHVzZXIgYW5zd2VycywgZ2F0ZSB2ZXJpZmljYXRpb24pXG4gICAgLy8gdGhhdCB3b3VsZCBiZSBsb3N0IG9uIGNvbXBhY3Rpb24gKCM0MjU4KS5cbiAgICAvLyBpZiAoc3RhdGUucGhhc2UgIT09IFwiZXhlY3V0aW5nXCIpIHJldHVybjtcblxuICAgIGNvbnN0IHNsaWNlRGlyID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlUGF0aCwgc3RhdGUuYWN0aXZlTWlsZXN0b25lLmlkLCBzdGF0ZS5hY3RpdmVTbGljZS5pZCk7XG4gICAgaWYgKCFzbGljZURpcikgcmV0dXJuO1xuXG4gICAgY29uc3QgZXhpc3RpbmdGaWxlID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgc3RhdGUuYWN0aXZlTWlsZXN0b25lLmlkLCBzdGF0ZS5hY3RpdmVTbGljZS5pZCwgXCJDT05USU5VRVwiKTtcbiAgICBpZiAoZXhpc3RpbmdGaWxlICYmIGF3YWl0IGxvYWRGaWxlKGV4aXN0aW5nRmlsZSkpIHJldHVybjtcbiAgICBjb25zdCBsZWdhY3lDb250aW51ZSA9IGpvaW4oc2xpY2VEaXIsIFwiY29udGludWUubWRcIik7XG4gICAgaWYgKGF3YWl0IGxvYWRGaWxlKGxlZ2FjeUNvbnRpbnVlKSkgcmV0dXJuO1xuXG4gICAgY29uc3QgY29udGludWVQYXRoID0gam9pbihzbGljZURpciwgYCR7c3RhdGUuYWN0aXZlU2xpY2UuaWR9LUNPTlRJTlVFLm1kYCk7XG4gICAgY29uc3QgdGFza0lkID0gc3RhdGUuYWN0aXZlVGFzaz8uaWQgPz8gXCJub25lXCI7XG4gICAgY29uc3QgdGFza1RpdGxlID0gc3RhdGUuYWN0aXZlVGFzaz8udGl0bGUgPz8gXCJcIjtcbiAgICBjb25zdCBwaGFzZUxhYmVsID0gc3RhdGUucGhhc2UucmVwbGFjZSgvLS9nLCBcIiBcIik7XG5cbiAgICBhd2FpdCBzYXZlRmlsZShjb250aW51ZVBhdGgsIGZvcm1hdENvbnRpbnVlKHtcbiAgICAgIGZyb250bWF0dGVyOiB7XG4gICAgICAgIG1pbGVzdG9uZTogc3RhdGUuYWN0aXZlTWlsZXN0b25lLmlkLFxuICAgICAgICBzbGljZTogc3RhdGUuYWN0aXZlU2xpY2UuaWQsXG4gICAgICAgIHRhc2s6IHRhc2tJZCxcbiAgICAgICAgc3RlcDogMCxcbiAgICAgICAgdG90YWxTdGVwczogMCxcbiAgICAgICAgc3RhdHVzOiBcImNvbXBhY3RlZFwiIGFzIGNvbnN0LFxuICAgICAgICBzYXZlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB9LFxuICAgICAgY29tcGxldGVkV29yazogc3RhdGUuYWN0aXZlVGFza1xuICAgICAgICA/IGBUYXNrICR7dGFza0lkfSAoJHt0YXNrVGl0bGV9KSB3YXMgaW4gcHJvZ3Jlc3Mgd2hlbiBjb21wYWN0aW9uIG9jY3VycmVkLmBcbiAgICAgICAgOiBgU2xpY2UgJHtzdGF0ZS5hY3RpdmVTbGljZS5pZH0gd2FzIGluICR7cGhhc2VMYWJlbH0gcGhhc2Ugd2hlbiBjb21wYWN0aW9uIG9jY3VycmVkLmAsXG4gICAgICByZW1haW5pbmdXb3JrOiBzdGF0ZS5hY3RpdmVUYXNrXG4gICAgICAgID8gXCJDaGVjayB0aGUgdGFzayBwbGFuIGZvciByZW1haW5pbmcgc3RlcHMuXCJcbiAgICAgICAgOiBcIkNvbnRpbnVlIHRoaXMgc2xpY2UgZnJvbSB0aGUgbGF0ZXN0IHBsYW5uaW5nL3Jlc2VhcmNoL2Rpc2N1c3Npb24gYXJ0aWZhY3RzLlwiLFxuICAgICAgZGVjaXNpb25zOiBcIkNoZWNrIHRhc2sgc3VtbWFyeSBmaWxlcyBmb3IgcHJpb3IgZGVjaXNpb25zLlwiLFxuICAgICAgY29udGV4dDogXCJTZXNzaW9uIHdhcyBhdXRvLWNvbXBhY3RlZCBieSBQaS4gUmVzdW1lIHdpdGggL2dzZC5cIixcbiAgICAgIG5leHRBY3Rpb246IHN0YXRlLmFjdGl2ZVRhc2tcbiAgICAgICAgPyBgUmVzdW1lIHRhc2sgJHt0YXNrSWR9OiAke3Rhc2tUaXRsZX0uYFxuICAgICAgICA6IGBSZXN1bWUgJHtwaGFzZUxhYmVsfSB3b3JrIGZvciBzbGljZSAke3N0YXRlLmFjdGl2ZVNsaWNlLmlkfS5gLFxuICAgIH0pKTtcbiAgfSk7XG5cbiAgcGkub24oXCJtZXNzYWdlX3VwZGF0ZVwiLCBhc3luYyAoZXZlbnQsIGN0eDogRXh0ZW5zaW9uQ29udGV4dCkgPT4ge1xuICAgIGlmIChhcHByb3ZhbFF1ZXN0aW9uQWJvcnRJbkZsaWdodCkgcmV0dXJuO1xuXG4gICAgY29uc3QgZGFzaCA9IGdldEF1dG9SdW50aW1lU25hcHNob3QoKTtcbiAgICBsZXQgdW5pdFR5cGUgPSBkYXNoLmN1cnJlbnRVbml0Py50eXBlO1xuICAgIGxldCB1bml0SWQgPSBkYXNoLmN1cnJlbnRVbml0Py5pZDtcblxuICAgIGlmICghdW5pdFR5cGUpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgZ2V0UGVuZGluZ0RlZXBQcm9qZWN0U2V0dXBVbml0Rm9yQ29udGV4dCB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vZ3VpZGVkLWZsb3cuanNcIik7XG4gICAgICAgIGNvbnN0IHBlbmRpbmcgPSBnZXRQZW5kaW5nRGVlcFByb2plY3RTZXR1cFVuaXRGb3JDb250ZXh0KGN0eCwgY29udGV4dEJhc2VQYXRoKGN0eCkpO1xuICAgICAgICB1bml0VHlwZSA9IHBlbmRpbmc/LnVuaXRUeXBlO1xuICAgICAgICB1bml0SWQgPSBwZW5kaW5nPy51bml0SWQ7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gQmVzdC1lZmZvcnQgZm9yZWdyb3VuZCBkZXRlY3Rpb24gb25seS5cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIXVuaXRUeXBlKSB7XG4gICAgICBjb25zdCBtaWxlc3RvbmVJZCA9IGF3YWl0IGdldERpc2N1c3Npb25NaWxlc3RvbmVJZEZvcihjb250ZXh0QmFzZVBhdGgoY3R4KSk7XG4gICAgICBpZiAobWlsZXN0b25lSWQpIHtcbiAgICAgICAgdW5pdFR5cGUgPSBcImRpc2N1c3MtbWlsZXN0b25lXCI7XG4gICAgICAgIHVuaXRJZCA9IG1pbGVzdG9uZUlkO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghc2hvdWxkUGF1c2VGb3JVc2VyQXBwcm92YWxRdWVzdGlvbih1bml0VHlwZSwgW2V2ZW50Lm1lc3NhZ2VdKSkgcmV0dXJuO1xuXG4gICAgY29uc3QgZ2F0ZUlkID0gYXBwcm92YWxHYXRlSWRGb3JVbml0KHVuaXRUeXBlLCB1bml0SWQpO1xuICAgIGlmIChnYXRlSWQpIGRlZmVyQXBwcm92YWxHYXRlKGdhdGVJZCwgY29udGV4dEJhc2VQYXRoKGN0eCkpO1xuXG4gICAgYXBwcm92YWxRdWVzdGlvbkFib3J0SW5GbGlnaHQgPSB0cnVlO1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgJHt1bml0VHlwZX0ke3VuaXRJZCA/IGAgJHt1bml0SWR9YCA6IFwiXCJ9IGlzIHdhaXRpbmcgZm9yIHlvdXIgYXBwcm92YWwgLSBwYXVzaW5nIGJlZm9yZSBtb3JlIHRvb2wgY2FsbHMgcnVuLmAsXG4gICAgICBcImluZm9cIixcbiAgICApO1xuICAgIC8vIFRoZSBkdXJhYmxlIHBlbmRpbmcgZ2F0ZSBpcyBhY3RpdmF0ZWQgYXQgYWdlbnRfZW5kIHNvIHNhbWUtdHVyblxuICAgIC8vIENPTlRFWFQtRFJBRlQgcGVyc2lzdGVuY2UgY2FuIGZpbmlzaCBhZnRlciB0aGUgdGV4dCBib3VuZGFyeSBzdHJlYW1zLlxuICAgIC8vIFRoZSB0b29sX2NhbGwgaG9vayBiZWxvdyBzdGlsbCBibG9ja3Mgbm9uLWRyYWZ0IHRvb2xzIGluIHRoaXMgdHVybi5cbiAgICAvLyBBYm9ydGluZyBtaWQtc3RyZWFtIGVhdHMgdGhlIG1vZGVsJ3MgcXVlc3Rpb24gdGV4dCBvbiBleHRlcm5hbCBDTElcbiAgICAvLyBwcm92aWRlcnMgKENsYXVkZSBDb2RlIFNESykgYmVjYXVzZSBsYXN0VGV4dENvbnRlbnQgaXNuJ3QgcG9wdWxhdGVkXG4gICAgLy8gZnJvbSBpbi1mbGlnaHQgYnVpbGRlciBzdGF0ZSBcdTIwMTQgdGhlIHVzZXIgb25seSBldmVyIHNlZXMgXCJDbGF1ZGUgQ29kZVxuICAgIC8vIHN0cmVhbSBhYm9ydGVkIGJ5IGNhbGxlclwiIGluc3RlYWQgb2YgdGhlIHF1ZXN0aW9uLlxuICB9KTtcblxuICBwaS5vbihcInNlc3Npb25fc2h1dGRvd25cIiwgYXN5bmMgKF9ldmVudCwgY3R4OiBFeHRlbnNpb25Db250ZXh0KSA9PiB7XG4gICAgY29uc3QgeyBpc1BhcmFsbGVsQWN0aXZlLCBzaHV0ZG93blBhcmFsbGVsIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9wYXJhbGxlbC1vcmNoZXN0cmF0b3IuanNcIik7XG4gICAgaWYgKGlzUGFyYWxsZWxBY3RpdmUoKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgc2h1dGRvd25QYXJhbGxlbChjb250ZXh0QmFzZVBhdGgoY3R4KSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gYmVzdC1lZmZvcnRcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFpc0F1dG9BY3RpdmUoKSAmJiAhaXNBdXRvUGF1c2VkKCkpIHJldHVybjtcbiAgICBjb25zdCBkYXNoID0gZ2V0QXV0b1J1bnRpbWVTbmFwc2hvdCgpO1xuICAgIGlmIChkYXNoLmN1cnJlbnRVbml0KSB7XG4gICAgICBzYXZlQWN0aXZpdHlMb2coY3R4LCBkYXNoLmJhc2VQYXRoLCBkYXNoLmN1cnJlbnRVbml0LnR5cGUsIGRhc2guY3VycmVudFVuaXQuaWQpO1xuICAgIH1cbiAgfSk7XG5cbiAgcGkub24oXCJ0b29sX2NhbGxcIiwgYXN5bmMgKGV2ZW50LCBjdHgpID0+IHtcbiAgICBjb25zdCBkaXNjdXNzaW9uQmFzZVBhdGggPSBjb250ZXh0QmFzZVBhdGgoY3R4KTtcbiAgICBjb25zdCB0b29sTmFtZSA9IGNhbm9uaWNhbFRvb2xOYW1lKGV2ZW50LnRvb2xOYW1lKTtcbiAgICAvLyBcdTI1MDBcdTI1MDAgTG9vcCBndWFyZDogYmxvY2sgcmVwZWF0ZWQgaWRlbnRpY2FsIHRvb2wgY2FsbHMgXHUyNTAwXHUyNTAwXG4gICAgY29uc3QgbG9vcENoZWNrID0gY2hlY2tUb29sQ2FsbExvb3AodG9vbE5hbWUsIGV2ZW50LmlucHV0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgICBpZiAobG9vcENoZWNrLmJsb2NrKSB7XG4gICAgICByZXR1cm4geyBibG9jazogdHJ1ZSwgcmVhc29uOiBsb29wQ2hlY2sucmVhc29uIH07XG4gICAgfVxuXG4gICAgY29uc3QgZGVmZXJyZWRHYXRlR3VhcmQgPSBzaG91bGRCbG9ja0RlZmVycmVkQXBwcm92YWxUb29sKFxuICAgICAgdG9vbE5hbWUsXG4gICAgICBldmVudC5pbnB1dCxcbiAgICAgIGRpc2N1c3Npb25CYXNlUGF0aCxcbiAgICApO1xuICAgIGlmIChkZWZlcnJlZEdhdGVHdWFyZC5ibG9jaykgcmV0dXJuIGRlZmVycmVkR2F0ZUd1YXJkO1xuXG4gICAgLy8gXHUyNTAwXHUyNTAwIERpc2N1c3Npb24gZ2F0ZSBlbmZvcmNlbWVudDogdHJhY2sgcGVuZGluZyBnYXRlIHF1ZXN0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAvLyBPbmx5IGdhdGUtc2hhcGVkIGFza191c2VyX3F1ZXN0aW9ucyBjYWxscyBzaG91bGQgYmxvY2sgZXhlY3V0aW9uLlxuICAgIC8vIFRoZSBnYXRlIHN0YXlzIHBlbmRpbmcgdW50aWwgdGhlIHVzZXIgc2VsZWN0cyB0aGUgYXBwcm92YWwgb3B0aW9uLlxuICAgIGlmICh0b29sTmFtZSA9PT0gXCJhc2tfdXNlcl9xdWVzdGlvbnNcIikge1xuICAgICAgY29uc3QgcXVlc3Rpb25zOiBhbnlbXSA9IChldmVudC5pbnB1dCBhcyBhbnkpPy5xdWVzdGlvbnMgPz8gW107XG4gICAgICBjb25zdCBxdWVzdGlvbklkID0gcXVlc3Rpb25zLmZpbmQoKHF1ZXN0aW9uKSA9PiB0eXBlb2YgcXVlc3Rpb24/LmlkID09PSBcInN0cmluZ1wiICYmIGlzR2F0ZVF1ZXN0aW9uSWQocXVlc3Rpb24uaWQpKT8uaWQ7XG4gICAgICBpZiAodHlwZW9mIHF1ZXN0aW9uSWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgc2V0UGVuZGluZ0dhdGUocXVlc3Rpb25JZCwgZGlzY3Vzc2lvbkJhc2VQYXRoKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgRGlzY3Vzc2lvbiBnYXRlIGVuZm9yY2VtZW50OiBibG9jayB0b29sIGNhbGxzIHdoaWxlIGdhdGUgaXMgcGVuZGluZyBcdTI1MDBcdTI1MDBcbiAgICAvLyBJZiBhc2tfdXNlcl9xdWVzdGlvbnMgd2FzIGNhbGxlZCB3aXRoIGEgZ2F0ZSBJRCBidXQgaGFzbid0IGJlZW4gY29uZmlybWVkLFxuICAgIC8vIGJsb2NrIGFsbCBub24tcmVhZC1vbmx5IHRvb2wgY2FsbHMgdG8gcHJldmVudCB0aGUgbW9kZWwgZnJvbSBza2lwcGluZyBnYXRlcy5cbiAgICBpZiAoZ2V0UGVuZGluZ0dhdGUoZGlzY3Vzc2lvbkJhc2VQYXRoKSkge1xuICAgICAgY29uc3QgbWlsZXN0b25lSWQgPSBhd2FpdCBnZXREaXNjdXNzaW9uTWlsZXN0b25lSWRGb3IoZGlzY3Vzc2lvbkJhc2VQYXRoKTtcbiAgICAgIGlmIChpc1Rvb2xDYWxsRXZlbnRUeXBlKFwiYmFzaFwiLCBldmVudCkpIHtcbiAgICAgICAgY29uc3QgYmFzaEd1YXJkID0gc2hvdWxkQmxvY2tQZW5kaW5nR2F0ZUJhc2goXG4gICAgICAgICAgZXZlbnQuaW5wdXQuY29tbWFuZCxcbiAgICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgICBpc1F1ZXVlUGhhc2VBY3RpdmUoZGlzY3Vzc2lvbkJhc2VQYXRoKSxcbiAgICAgICAgICBkaXNjdXNzaW9uQmFzZVBhdGgsXG4gICAgICAgICk7XG4gICAgICAgIGlmIChiYXNoR3VhcmQuYmxvY2spIHJldHVybiBiYXNoR3VhcmQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBnYXRlR3VhcmQgPSBzaG91bGRCbG9ja1BlbmRpbmdHYXRlKFxuICAgICAgICAgIHRvb2xOYW1lLFxuICAgICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICAgIGlzUXVldWVQaGFzZUFjdGl2ZShkaXNjdXNzaW9uQmFzZVBhdGgpLFxuICAgICAgICAgIGRpc2N1c3Npb25CYXNlUGF0aCxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGdhdGVHdWFyZC5ibG9jaykgcmV0dXJuIGdhdGVHdWFyZDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgUXVldWUtbW9kZSBleGVjdXRpb24gZ3VhcmQgKCMyNTQ1KTogYmxvY2sgc291cmNlLWNvZGUgbXV0YXRpb25zIFx1MjUwMFx1MjUwMFxuICAgIC8vIFdoZW4gL2dzZCBxdWV1ZSBpcyBhY3RpdmUsIHRoZSBhZ2VudCBzaG91bGQgb25seSBjcmVhdGUgbWlsZXN0b25lcyxcbiAgICAvLyBub3QgZXhlY3V0ZSB3b3JrLiBCbG9jayB3cml0ZS9lZGl0IHRvIG5vbi0uZ3NkLyBwYXRocyBhbmQgYmFzaCBjb21tYW5kc1xuICAgIC8vIHRoYXQgd291bGQgbW9kaWZ5IGZpbGVzLlxuICAgIGlmIChpc1F1ZXVlUGhhc2VBY3RpdmUoZGlzY3Vzc2lvbkJhc2VQYXRoKSkge1xuICAgICAgbGV0IHF1ZXVlSW5wdXQgPSBcIlwiO1xuICAgICAgaWYgKGlzVG9vbENhbGxFdmVudFR5cGUoXCJ3cml0ZVwiLCBldmVudCkpIHtcbiAgICAgICAgcXVldWVJbnB1dCA9IGV2ZW50LmlucHV0LnBhdGg7XG4gICAgICB9IGVsc2UgaWYgKGlzVG9vbENhbGxFdmVudFR5cGUoXCJlZGl0XCIsIGV2ZW50KSkge1xuICAgICAgICBxdWV1ZUlucHV0ID0gZXZlbnQuaW5wdXQucGF0aDtcbiAgICAgIH0gZWxzZSBpZiAoaXNUb29sQ2FsbEV2ZW50VHlwZShcImJhc2hcIiwgZXZlbnQpKSB7XG4gICAgICAgIHF1ZXVlSW5wdXQgPSBldmVudC5pbnB1dC5jb21tYW5kO1xuICAgICAgfVxuICAgICAgY29uc3QgcXVldWVHdWFyZCA9IHNob3VsZEJsb2NrUXVldWVFeGVjdXRpb24odG9vbE5hbWUsIHF1ZXVlSW5wdXQsIHRydWUpO1xuICAgICAgaWYgKHF1ZXVlR3VhcmQuYmxvY2spIHJldHVybiBxdWV1ZUd1YXJkO1xuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBQbGFubmluZy11bml0IHRvb2xzLXBvbGljeSBlbmZvcmNlbWVudCAoIzQ5MzQpOiBydW50aW1lIGhhbGYgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgLy8gVGhlIGFjdGl2ZSBhdXRvLW1vZGUgdW5pdCdzIG1hbmlmZXN0IGRlY2xhcmVzIGEgVG9vbHNQb2xpY3kuIEZvclxuICAgIC8vIHBsYW5uaW5nL2RvY3MvcmVhZC1vbmx5IG1vZGVzLCBkZW55IHdyaXRlcyBvdXRzaWRlIC5nc2QvIChvciB0aGVcbiAgICAvLyBtYW5pZmVzdCdzIGFsbG93ZWRQYXRoR2xvYnMpLCBiYXNoIHRoYXQgaXNuJ3QgcmVhZC1vbmx5LCBhbmRcbiAgICAvLyBzdWJhZ2VudCBkaXNwYXRjaC4gQ2xvc2VzIHRoZSBiMjMgYnVnIGNsYXNzIHdoZXJlIGEgZGlzY3Vzcy1taWxlc3RvbmVcbiAgICAvLyB0dXJuIHVzZWQgdGhlIGhvc3QgRWRpdCB0b29sIHRvIG1vZGlmeSB1c2VyIHNvdXJjZSBmaWxlcy5cbiAgICBjb25zdCBkYXNoID0gZ2V0QXV0b1J1bnRpbWVTbmFwc2hvdCgpO1xuICAgIGNvbnN0IGFjdGl2ZVVuaXRUeXBlID0gZGFzaC5jdXJyZW50VW5pdD8udHlwZTtcbiAgICBpZiAoYWN0aXZlVW5pdFR5cGUpIHtcbiAgICAgIGNvbnN0IG1hbmlmZXN0ID0gcmVzb2x2ZU1hbmlmZXN0KGFjdGl2ZVVuaXRUeXBlKTtcbiAgICAgIGlmIChtYW5pZmVzdCkge1xuICAgICAgICBsZXQgcGxhbm5pbmdJbnB1dCA9IFwiXCI7XG4gICAgICAgIGxldCBhZ2VudENsYXNzZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAoaXNUb29sQ2FsbEV2ZW50VHlwZShcIndyaXRlXCIsIGV2ZW50KSkge1xuICAgICAgICAgIHBsYW5uaW5nSW5wdXQgPSBldmVudC5pbnB1dC5wYXRoO1xuICAgICAgICB9IGVsc2UgaWYgKGlzVG9vbENhbGxFdmVudFR5cGUoXCJlZGl0XCIsIGV2ZW50KSkge1xuICAgICAgICAgIHBsYW5uaW5nSW5wdXQgPSBldmVudC5pbnB1dC5wYXRoO1xuICAgICAgICB9IGVsc2UgaWYgKGlzVG9vbENhbGxFdmVudFR5cGUoXCJiYXNoXCIsIGV2ZW50KSkge1xuICAgICAgICAgIHBsYW5uaW5nSW5wdXQgPSBldmVudC5pbnB1dC5jb21tYW5kO1xuICAgICAgICB9IGVsc2UgaWYgKGV2ZW50LnRvb2xOYW1lID09PSBcInN1YmFnZW50XCIgfHwgZXZlbnQudG9vbE5hbWUgPT09IFwidGFza1wiKSB7XG4gICAgICAgICAgLy8gU3ViYWdlbnQgaW5wdXRzIHVzZSB7IGFnZW50IH0sIHsgdGFza3M6IFt7IGFnZW50IH1dIH0sIG9yIHsgY2hhaW46IFt7IGFnZW50IH1dIH0uXG4gICAgICAgICAgYWdlbnRDbGFzc2VzID0gZXh0cmFjdFN1YmFnZW50QWdlbnRDbGFzc2VzKChldmVudCBhcyB7IGlucHV0PzogdW5rbm93biB9KS5pbnB1dCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcGxhbm5pbmdHdWFyZCA9IHNob3VsZEJsb2NrUGxhbm5pbmdVbml0KFxuICAgICAgICAgIGV2ZW50LnRvb2xOYW1lLFxuICAgICAgICAgIHBsYW5uaW5nSW5wdXQsXG4gICAgICAgICAgZGFzaC5iYXNlUGF0aCB8fCBkaXNjdXNzaW9uQmFzZVBhdGgsXG4gICAgICAgICAgYWN0aXZlVW5pdFR5cGUsXG4gICAgICAgICAgbWFuaWZlc3QudG9vbHMsXG4gICAgICAgICAgYWdlbnRDbGFzc2VzLFxuICAgICAgICApO1xuICAgICAgICBpZiAocGxhbm5pbmdHdWFyZC5ibG9jaykgcmV0dXJuIHBsYW5uaW5nR3VhcmQ7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFdvcmt0cmVlLWlzb2xhdGlvbiB3cml0ZSBnYXRlICgjNTE5OSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgLy8gQmxvY2sgcGxhbm5pbmctd3JpdGUgdG9vbHMgZnJvbSBsYW5kaW5nIGNvZGUgYXQgdGhlIHByb2plY3Qgcm9vdCB3aGVuXG4gICAgLy8gZ2l0Lmlzb2xhdGlvbj13b3JrdHJlZSBidXQgYXV0by1tb2RlIGhhc24ndCBjcmVhdGVkIHRoZSBtaWxlc3RvbmVcbiAgICAvLyB3b3JrdHJlZSB5ZXQuIFdpdGhvdXQgdGhpcywgd3JpdGVzIHNpbGVudGx5IG9ycGhhbiBvdXRzaWRlIGdpdCBoaXN0b3J5LlxuICAgIGlmIChpc1Rvb2xDYWxsRXZlbnRUeXBlKFwid3JpdGVcIiwgZXZlbnQpIHx8IGlzVG9vbENhbGxFdmVudFR5cGUoXCJlZGl0XCIsIGV2ZW50KSkge1xuICAgICAgY29uc3Qgd3RCYXNlUGF0aCA9IHJlc29sdmVXb3JrdHJlZVByb2plY3RSb290KGRhc2guYmFzZVBhdGggPz8gZGlzY3Vzc2lvbkJhc2VQYXRoKTtcbiAgICAgIGNvbnN0IHd0R3VhcmQgPSBzaG91bGRCbG9ja1dvcmt0cmVlV3JpdGUoXG4gICAgICAgIGV2ZW50LnRvb2xOYW1lLFxuICAgICAgICBldmVudC5pbnB1dC5wYXRoLFxuICAgICAgICB3dEJhc2VQYXRoLFxuICAgICAgICBpc0F1dG9BY3RpdmUoKSxcbiAgICAgICAgZGFzaC5jdXJyZW50VW5pdD8udHlwZSxcbiAgICAgICk7XG4gICAgICBpZiAod3RHdWFyZC5ibG9jaykgcmV0dXJuIHd0R3VhcmQ7XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFNpbmdsZS13cml0ZXIgZW5naW5lOiBibG9jayBkaXJlY3Qgd3JpdGVzIHRvIFNUQVRFLm1kIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIC8vIENvdmVycyB3cml0ZSwgZWRpdCwgYW5kIGJhc2ggdG9vbHMgdG8gcHJldmVudCBieXBhc3MgdmVjdG9ycy5cbiAgICBpZiAoaXNUb29sQ2FsbEV2ZW50VHlwZShcIndyaXRlXCIsIGV2ZW50KSkge1xuICAgICAgaWYgKGlzQmxvY2tlZFN0YXRlRmlsZShldmVudC5pbnB1dC5wYXRoKSkge1xuICAgICAgICByZXR1cm4geyBibG9jazogdHJ1ZSwgcmVhc29uOiBCTE9DS0VEX1dSSVRFX0VSUk9SIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGlzVG9vbENhbGxFdmVudFR5cGUoXCJlZGl0XCIsIGV2ZW50KSkge1xuICAgICAgaWYgKGlzQmxvY2tlZFN0YXRlRmlsZShldmVudC5pbnB1dC5wYXRoKSkge1xuICAgICAgICByZXR1cm4geyBibG9jazogdHJ1ZSwgcmVhc29uOiBCTE9DS0VEX1dSSVRFX0VSUk9SIH07XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGlzVG9vbENhbGxFdmVudFR5cGUoXCJiYXNoXCIsIGV2ZW50KSkge1xuICAgICAgaWYgKGlzQmFzaFdyaXRlVG9TdGF0ZUZpbGUoZXZlbnQuaW5wdXQuY29tbWFuZCkpIHtcbiAgICAgICAgcmV0dXJuIHsgYmxvY2s6IHRydWUsIHJlYXNvbjogQkxPQ0tFRF9XUklURV9FUlJPUiB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghaXNUb29sQ2FsbEV2ZW50VHlwZShcIndyaXRlXCIsIGV2ZW50KSkgcmV0dXJuO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gc2hvdWxkQmxvY2tDb250ZXh0V3JpdGUoXG4gICAgICBldmVudC50b29sTmFtZSxcbiAgICAgIGV2ZW50LmlucHV0LnBhdGgsXG4gICAgICBhd2FpdCBnZXREaXNjdXNzaW9uTWlsZXN0b25lSWRGb3IoZGlzY3Vzc2lvbkJhc2VQYXRoKSxcbiAgICAgIGlzUXVldWVQaGFzZUFjdGl2ZShkaXNjdXNzaW9uQmFzZVBhdGgpLFxuICAgICAgZGlzY3Vzc2lvbkJhc2VQYXRoLFxuICAgICk7XG4gICAgaWYgKHJlc3VsdC5ibG9jaykgcmV0dXJuIHJlc3VsdDtcbiAgfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFNhZmV0eSBoYXJuZXNzOiBldmlkZW5jZSBjb2xsZWN0aW9uICsgZGVzdHJ1Y3RpdmUgY29tbWFuZCB3YXJuaW5ncyBcdTI1MDBcdTI1MDBcbiAgcGkub24oXCJ0b29sX2NhbGxcIiwgYXN5bmMgKGV2ZW50LCBjdHgpID0+IHtcbiAgICBpZiAoIWlzQXV0b0FjdGl2ZSgpKSByZXR1cm47XG4gICAgbWFya1Rvb2xTdGFydChldmVudC50b29sQ2FsbElkLCBldmVudC50b29sTmFtZSk7XG4gICAgc2FmZXR5UmVjb3JkVG9vbENhbGwoZXZlbnQudG9vbENhbGxJZCwgZXZlbnQudG9vbE5hbWUsIGV2ZW50LmlucHV0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcblxuICAgIC8vIFBlcnNpc3QgaW1tZWRpYXRlbHkgYXQgZGlzcGF0Y2ggc28gYSBtaWQtdW5pdCByZS1kaXNwYXRjaCBcdTIwMTQgd2hpY2ggY2FsbHNcbiAgICAvLyByZXNldEV2aWRlbmNlKCkgKyBsb2FkRXZpZGVuY2VGcm9tRGlzaygpIGluIHJ1blVuaXRQaGFzZSBcdTIwMTQgY2Fubm90IHdpcGVcbiAgICAvLyB0aGUgZW50cnkgYmV0d2VlbiB0b29sX2NhbGwgYW5kIHRvb2xfZXhlY3V0aW9uX2VuZC4gV2l0aG91dCB0aGlzLCB0aGVcbiAgICAvLyByYWNlIHdpbmRvdyBlcXVhbHMgdGhlIHRvb2wncyBydW50aW1lLCBwcm9kdWNpbmcgdGhlIFwibm8gYmFzaCBjYWxsc1wiXG4gICAgLy8gZmFsc2UgcG9zaXRpdmUgd2hlbiB0aGUgTExNIGNsZWFybHkgcmFuIGEgdmVyaWZpY2F0aW9uIGNvbW1hbmQuXG4gICAgY29uc3QgY2FsbERhc2ggPSBnZXRBdXRvUnVudGltZVNuYXBzaG90KCk7XG4gICAgaWYgKGNhbGxEYXNoLmJhc2VQYXRoICYmIGNhbGxEYXNoLmN1cnJlbnRVbml0Py50eXBlID09PSBcImV4ZWN1dGUtdGFza1wiKSB7XG4gICAgICBjb25zdCB7IG1pbGVzdG9uZTogY01pZCwgc2xpY2U6IGNTaWQsIHRhc2s6IGNUaWQgfSA9IHBhcnNlVW5pdElkKGNhbGxEYXNoLmN1cnJlbnRVbml0LmlkKTtcbiAgICAgIGlmIChjTWlkICYmIGNTaWQgJiYgY1RpZCkge1xuICAgICAgICBzYXZlRXZpZGVuY2VUb0Rpc2soY2FsbERhc2guYmFzZVBhdGgsIGNNaWQsIGNTaWQsIGNUaWQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIERlc3RydWN0aXZlIGNvbW1hbmQgY2xhc3NpZmljYXRpb24gKHdhcm4gb25seSwgbmV2ZXIgYmxvY2spXG4gICAgaWYgKGlzVG9vbENhbGxFdmVudFR5cGUoXCJiYXNoXCIsIGV2ZW50KSkge1xuICAgICAgY29uc3QgY2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeUNvbW1hbmQoZXZlbnQuaW5wdXQuY29tbWFuZCk7XG4gICAgICBpZiAoY2xhc3NpZmljYXRpb24uZGVzdHJ1Y3RpdmUpIHtcbiAgICAgICAgc2FmZXR5TG9nV2FybmluZyhcInNhZmV0eVwiLCBgZGVzdHJ1Y3RpdmUgY29tbWFuZDogJHtjbGFzc2lmaWNhdGlvbi5sYWJlbHMuam9pbihcIiwgXCIpfWAsIHtcbiAgICAgICAgICBjb21tYW5kOiBTdHJpbmcoZXZlbnQuaW5wdXQuY29tbWFuZCkuc2xpY2UoMCwgMjAwKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYERlc3RydWN0aXZlIGNvbW1hbmQgZGV0ZWN0ZWQ6ICR7Y2xhc3NpZmljYXRpb24ubGFiZWxzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcGkub24oXCJ0b29sX3Jlc3VsdFwiLCBhc3luYyAoZXZlbnQsIGN0eCkgPT4ge1xuICAgIGlmIChpc0F1dG9BY3RpdmUoKSAmJiB0eXBlb2YgZXZlbnQudG9vbENhbGxJZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgbWFya1Rvb2xFbmQoZXZlbnQudG9vbENhbGxJZCk7XG4gICAgfVxuICAgIGlmIChpc0F1dG9BY3RpdmUoKSAmJiBldmVudC5pc0Vycm9yKSB7XG4gICAgICBjb25zdCByZXN1bHRQYXlsb2FkID0gKFwicmVzdWx0XCIgaW4gZXZlbnQgPyBldmVudC5yZXN1bHQgOiB1bmRlZmluZWQpIGFzIGFueTtcbiAgICAgIGNvbnN0IGVycm9yVGV4dCA9IHR5cGVvZiByZXN1bHRQYXlsb2FkID09PSBcInN0cmluZ1wiXG4gICAgICAgID8gcmVzdWx0UGF5bG9hZFxuICAgICAgICA6ICh0eXBlb2YgcmVzdWx0UGF5bG9hZD8uY29udGVudD8uWzBdPy50ZXh0ID09PSBcInN0cmluZ1wiXG4gICAgICAgICAgICA/IHJlc3VsdFBheWxvYWQuY29udGVudFswXS50ZXh0XG4gICAgICAgICAgICA6ICh0eXBlb2YgKGV2ZW50IGFzIGFueSkuY29udGVudCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgICAgICAgID8gKGV2ZW50IGFzIGFueSkuY29udGVudFxuICAgICAgICAgICAgICAgIDogU3RyaW5nKHJlc3VsdFBheWxvYWQgPz8gXCJcIikpKTtcbiAgICAgIC8vIExldCByZWNvcmRUb29sSW52b2NhdGlvbkVycm9yIGNsYXNzaWZ5IHRoZSBmYWlsdXJlIHNvIG5vbi1nc2RfIGhhcm5lc3NcbiAgICAgIC8vIGVycm9ycyBhbmQgZGV0ZXJtaW5pc3RpYyBwb2xpY3kgcmVqZWN0aW9ucyBhcmUgaGFuZGxlZCBjb25zaXN0ZW50bHkuXG4gICAgICByZWNvcmRUb29sSW52b2NhdGlvbkVycm9yKGV2ZW50LnRvb2xOYW1lLCBlcnJvclRleHQpO1xuICAgIH0gZWxzZSBpZiAoaXNBdXRvQWN0aXZlKCkpIHtcbiAgICAgIGNsZWFyVG9vbEludm9jYXRpb25FcnJvcigpO1xuICAgIH1cbiAgICBjb25zdCB0b29sTmFtZSA9IGNhbm9uaWNhbFRvb2xOYW1lKGV2ZW50LnRvb2xOYW1lKTtcbiAgICBpZiAodG9vbE5hbWUgIT09IFwiYXNrX3VzZXJfcXVlc3Rpb25zXCIpIHJldHVybjtcbiAgICBjb25zdCBiYXNlUGF0aCA9IGNvbnRleHRCYXNlUGF0aChjdHgpO1xuICAgIGNvbnN0IG1pbGVzdG9uZUlkID0gYXdhaXQgZ2V0RGlzY3Vzc2lvbk1pbGVzdG9uZUlkRm9yKGJhc2VQYXRoKTtcbiAgICBjb25zdCBxdWV1ZUFjdGl2ZSA9IGlzUXVldWVQaGFzZUFjdGl2ZShiYXNlUGF0aCk7XG5cbiAgICBjb25zdCBkZXRhaWxzID0gZXZlbnQuZGV0YWlscyBhcyBhbnk7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgRGlzY3Vzc2lvbiBnYXRlIGVuZm9yY2VtZW50OiBoYW5kbGUgZ2F0ZSBxdWVzdGlvbiByZXNwb25zZXMgXHUyNTAwXHUyNTAwXG4gICAgLy8gSWYgdGhlIHJlc3VsdCBpcyBjYW5jZWxsZWQgb3IgaGFzIG5vIHJlc3BvbnNlLCB0aGUgcGVuZGluZyBnYXRlIHN0YXlzIGFjdGl2ZVxuICAgIC8vIHNvIHRoZSBtb2RlbCBpcyBibG9ja2VkIGZyb20gbm9uLXJlYWQtb25seSB0b29scyB1bnRpbCBpdCByZS1hc2tzLlxuICAgIC8vIElmIHRoZSB1c2VyIHJlc3BvbmRlZCBhdCBhbGwgKGV2ZW4gXCJuZWVkcyBhZGp1c3RtZW50XCIpLCBjbGVhciB0aGUgcGVuZGluZyBnYXRlXG4gICAgLy8gYmVjYXVzZSB0aGUgdXNlciBlbmdhZ2VkIFx1MjAxNCB0aGUgcHJvbXB0IGhhbmRsZXMgdGhlIHJlLWFzay1hZnRlci1hZGp1c3RtZW50IGZsb3cuXG4gICAgY29uc3QgcXVlc3Rpb25zOiBhbnlbXSA9IChldmVudC5pbnB1dCBhcyBhbnkpPy5xdWVzdGlvbnMgPz8gW107XG4gICAgY29uc3QgY3VycmVudFBlbmRpbmdHYXRlID0gZ2V0UGVuZGluZ0dhdGUoYmFzZVBhdGgpO1xuICAgIGlmIChjdXJyZW50UGVuZGluZ0dhdGUpIHtcbiAgICAgIGlmIChkZXRhaWxzPy5jYW5jZWxsZWQgfHwgIWRldGFpbHM/LnJlc3BvbnNlKSB7XG4gICAgICAgIC8vIEdhdGUgc3RheXMgcGVuZGluZy4gRGlyZWN0IHRoZSBhZ2VudCB0byB0aGUgbW9zdCByZWxpYWJsZSByZWNvdmVyeVxuICAgICAgICAvLyBwYXRoIFx1MjAxNCByZS1jYWxsaW5nIGFza191c2VyX3F1ZXN0aW9ucyB3aXRoIHRoZSBzYW1lIGdhdGUgaWQgXHUyMDE0IHdpdGhvdXRcbiAgICAgICAgLy8gbWlzcmVwcmVzZW50aW5nIHRoZSBwbGFpbi10ZXh0IHBhdGguIFRoZSBwbGFpbi10ZXh0IHBhdGggYWxzbyB3b3Jrc1xuICAgICAgICAvLyAoaXNFeHBsaWNpdEFwcHJvdmFsUmVzcG9uc2Ugb24gdGhlIG5leHQgYmVmb3JlX2FnZW50X3N0YXJ0IGNsZWFyc1xuICAgICAgICAvLyB0aGUgZ2F0ZSB3aGVuIHRoZSB1c2VyIHJlcGxpZXMgd2l0aCBhbiBhcHByb3ZhbCBrZXl3b3JkKSwgYnV0IHRoZVxuICAgICAgICAvLyBzdHJ1Y3R1cmVkIHJlLWFzayBpcyBtb3JlIGRldGVybWluaXN0aWMgYW5kIGdpdmVzIHRoZSB1c2VyIGEgY2xlYXIgVUkuXG4gICAgICAgIHJlc2V0VG9vbENhbGxMb29wR3VhcmQoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbe1xuICAgICAgICAgICAgdHlwZTogXCJ0ZXh0XCIgYXMgY29uc3QsXG4gICAgICAgICAgICB0ZXh0OiBbXG4gICAgICAgICAgICAgIGBIQVJEIEJMT0NLOiBhcHByb3ZhbCBnYXRlIFwiJHtjdXJyZW50UGVuZGluZ0dhdGV9XCIgaXMgc3RpbGwgcGVuZGluZy5gLFxuICAgICAgICAgICAgICBcIk5vIHVzZXIgcmVzcG9uc2Ugd2FzIHJlY2VpdmVkIGZvciB0aGUgY29uZmlybWF0aW9uIHF1ZXN0aW9uLlwiLFxuICAgICAgICAgICAgICBcIkRvIG5vdCBpbmZlciBhcHByb3ZhbCBmcm9tIGVhcmxpZXIgb3IgcHJpb3IgbWVzc2FnZXMuXCIsXG4gICAgICAgICAgICAgIFwiRG8gbm90IHByb2NlZWQsIHdyaXRlIGZpbGVzLCBzYXZlIGFydGlmYWN0cywgb3IgY2FsbCBvdGhlciB0b29scy5cIixcbiAgICAgICAgICAgICAgYFJlLWNhbGwgYXNrX3VzZXJfcXVlc3Rpb25zIHdpdGggdGhlIHNhbWUgZ2F0ZSBxdWVzdGlvbiBpZCAoXCIke2N1cnJlbnRQZW5kaW5nR2F0ZX1cIikgYW5kIHdhaXQgZm9yIHRoZSB1c2VyJ3MgcmVzcG9uc2UuYCxcbiAgICAgICAgICAgIF0uam9pbihcIiBcIiksXG4gICAgICAgICAgfV0sXG4gICAgICAgIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBwZW5kaW5nUXVlc3Rpb24gPSBxdWVzdGlvbnMuZmluZCgocXVlc3Rpb24pID0+IHF1ZXN0aW9uPy5pZCA9PT0gY3VycmVudFBlbmRpbmdHYXRlKTtcbiAgICAgICAgaWYgKHBlbmRpbmdRdWVzdGlvbikge1xuICAgICAgICAgIGNvbnN0IGFuc3dlciA9IGRldGFpbHMucmVzcG9uc2U/LmFuc3dlcnM/LltjdXJyZW50UGVuZGluZ0dhdGVdO1xuICAgICAgICAgIGlmIChpc0RlcHRoQ29uZmlybWF0aW9uQW5zd2VyKGFuc3dlcj8uc2VsZWN0ZWQsIHBlbmRpbmdRdWVzdGlvbi5vcHRpb25zKSkge1xuICAgICAgICAgICAgbWFya0FwcHJvdmFsR2F0ZVZlcmlmaWVkKGN1cnJlbnRQZW5kaW5nR2F0ZSwgYmFzZVBhdGgpO1xuICAgICAgICAgICAgY29uc3QgbWlsZXN0b25lSWRGcm9tR2F0ZSA9IGV4dHJhY3REZXB0aFZlcmlmaWNhdGlvbk1pbGVzdG9uZUlkKGN1cnJlbnRQZW5kaW5nR2F0ZSk7XG4gICAgICAgICAgICBpZiAobWlsZXN0b25lSWRGcm9tR2F0ZSkgbWFya0RlcHRoVmVyaWZpZWQobWlsZXN0b25lSWRGcm9tR2F0ZSwgYmFzZVBhdGgpO1xuICAgICAgICAgICAgY2xlYXJQZW5kaW5nR2F0ZShiYXNlUGF0aCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGRldGFpbHM/LmNhbmNlbGxlZCB8fCAhZGV0YWlscz8ucmVzcG9uc2UpIHJldHVybjtcblxuICAgIGZvciAoY29uc3QgcXVlc3Rpb24gb2YgcXVlc3Rpb25zKSB7XG4gICAgICBpZiAodHlwZW9mIHF1ZXN0aW9uLmlkID09PSBcInN0cmluZ1wiICYmIHF1ZXN0aW9uLmlkLmluY2x1ZGVzKFwiZGVwdGhfdmVyaWZpY2F0aW9uXCIpKSB7XG4gICAgICAgIC8vIE9ubHkgdW5sb2NrIHRoZSBnYXRlIGlmIHRoZSB1c2VyIHNlbGVjdGVkIHRoZSBmaXJzdCBvcHRpb24gKGNvbmZpcm1hdGlvbikuXG4gICAgICAgIC8vIENyb3NzLXJlZmVyZW5jZXMgYWdhaW5zdCB0aGUgcXVlc3Rpb24ncyBkZWZpbmVkIG9wdGlvbnMgdG8gcmVqZWN0IGZyZWUtZm9ybSBcIk90aGVyXCIgdGV4dC5cbiAgICAgICAgY29uc3QgYW5zd2VyID0gZGV0YWlscy5yZXNwb25zZT8uYW5zd2Vycz8uW3F1ZXN0aW9uLmlkXTtcbiAgICAgICAgY29uc3QgaW5mZXJyZWRNaWxlc3RvbmVJZCA9IGV4dHJhY3REZXB0aFZlcmlmaWNhdGlvbk1pbGVzdG9uZUlkKHF1ZXN0aW9uLmlkKSA/PyBtaWxlc3RvbmVJZDtcbiAgICAgICAgaWYgKGlzRGVwdGhDb25maXJtYXRpb25BbnN3ZXIoYW5zd2VyPy5zZWxlY3RlZCwgcXVlc3Rpb24ub3B0aW9ucykpIHtcbiAgICAgICAgICBpZiAoY3VycmVudFBlbmRpbmdHYXRlICYmIHF1ZXN0aW9uLmlkICE9PSBjdXJyZW50UGVuZGluZ0dhdGUpIGJyZWFrO1xuICAgICAgICAgIG1hcmtBcHByb3ZhbEdhdGVWZXJpZmllZChxdWVzdGlvbi5pZCwgYmFzZVBhdGgpO1xuICAgICAgICAgIG1hcmtEZXB0aFZlcmlmaWVkKGluZmVycmVkTWlsZXN0b25lSWQsIGJhc2VQYXRoKTtcbiAgICAgICAgICBjbGVhclBlbmRpbmdHYXRlKGJhc2VQYXRoKTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIW1pbGVzdG9uZUlkICYmICFxdWV1ZUFjdGl2ZSkgcmV0dXJuO1xuICAgIGlmICghbWlsZXN0b25lSWQpIHJldHVybjtcbiAgICBjb25zdCBtaWxlc3RvbmVEaXIgPSByZXNvbHZlTWlsZXN0b25lUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgIGlmICghbWlsZXN0b25lRGlyKSByZXR1cm47XG5cbiAgICBjb25zdCBkaXNjdXNzaW9uUGF0aCA9IGpvaW4obWlsZXN0b25lRGlyLCBidWlsZE1pbGVzdG9uZUZpbGVOYW1lKG1pbGVzdG9uZUlkLCBcIkRJU0NVU1NJT05cIikpO1xuICAgIGNvbnN0IHRpbWVzdGFtcCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbYCMjIEV4Y2hhbmdlIFx1MjAxNCAke3RpbWVzdGFtcH1gLCBcIlwiXTtcbiAgICBmb3IgKGNvbnN0IHF1ZXN0aW9uIG9mIHF1ZXN0aW9ucykge1xuICAgICAgbGluZXMucHVzaChgIyMjICR7cXVlc3Rpb24uaGVhZGVyID8/IFwiUXVlc3Rpb25cIn1gLCBcIlwiLCBxdWVzdGlvbi5xdWVzdGlvbiA/PyBcIlwiKTtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHF1ZXN0aW9uLm9wdGlvbnMpKSB7XG4gICAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgICAgIGZvciAoY29uc3Qgb3B0IG9mIHF1ZXN0aW9uLm9wdGlvbnMpIHtcbiAgICAgICAgICBsaW5lcy5wdXNoKGAtICoqJHtvcHQubGFiZWx9KiogXHUyMDE0ICR7b3B0LmRlc2NyaXB0aW9uID8/IFwiXCJ9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGNvbnN0IGFuc3dlciA9IGRldGFpbHMucmVzcG9uc2U/LmFuc3dlcnM/LltxdWVzdGlvbi5pZF07XG4gICAgICBpZiAoYW5zd2VyKSB7XG4gICAgICAgIGxpbmVzLnB1c2goXCJcIik7XG4gICAgICAgIGNvbnN0IHNlbGVjdGVkID0gQXJyYXkuaXNBcnJheShhbnN3ZXIuc2VsZWN0ZWQpID8gYW5zd2VyLnNlbGVjdGVkLmpvaW4oXCIsIFwiKSA6IGFuc3dlci5zZWxlY3RlZDtcbiAgICAgICAgbGluZXMucHVzaChgKipTZWxlY3RlZDoqKiAke3NlbGVjdGVkfWApO1xuICAgICAgICBpZiAoYW5zd2VyLm5vdGVzKSB7XG4gICAgICAgICAgbGluZXMucHVzaChgKipOb3RlczoqKiAke2Fuc3dlci5ub3Rlc31gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgbGluZXMucHVzaChcIlwiKTtcbiAgICB9XG4gICAgbGluZXMucHVzaChcIi0tLVwiLCBcIlwiKTtcbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGxvYWRGaWxlKGRpc2N1c3Npb25QYXRoKSA/PyBgIyAke21pbGVzdG9uZUlkfSBEaXNjdXNzaW9uIExvZ1xcblxcbmA7XG4gICAgYXdhaXQgc2F2ZUZpbGUoZGlzY3Vzc2lvblBhdGgsIGV4aXN0aW5nICsgbGluZXMuam9pbihcIlxcblwiKSk7XG4gIH0pO1xuXG4gIHBpLm9uKFwidG9vbF9leGVjdXRpb25fc3RhcnRcIiwgYXN5bmMgKGV2ZW50KSA9PiB7XG4gICAgaWYgKCFpc0F1dG9BY3RpdmUoKSkgcmV0dXJuO1xuICAgIG1hcmtUb29sU3RhcnQoZXZlbnQudG9vbENhbGxJZCwgZXZlbnQudG9vbE5hbWUpO1xuICB9KTtcblxuICBwaS5vbihcInRvb2xfZXhlY3V0aW9uX2VuZFwiLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICBtYXJrVG9vbEVuZChldmVudC50b29sQ2FsbElkKTtcbiAgICAvLyAjMjg4My8jNDk3NDogQ2FwdHVyZSBkZXRlcm1pbmlzdGljIGludm9jYXRpb24vcG9saWN5IGVycm9yc1xuICAgIC8vIHNvIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uIGNhbiBicmVhayB0aGUgcmV0cnkgbG9vcCBpbnN0ZWFkIG9mIHJlLWRpc3BhdGNoaW5nLlxuICAgIGlmIChldmVudC5pc0Vycm9yKSB7XG4gICAgICBjb25zdCBlcnJvclRleHQgPSB0eXBlb2YgZXZlbnQucmVzdWx0ID09PSBcInN0cmluZ1wiXG4gICAgICAgID8gZXZlbnQucmVzdWx0XG4gICAgICAgIDogKHR5cGVvZiBldmVudC5yZXN1bHQ/LmNvbnRlbnQ/LlswXT8udGV4dCA9PT0gXCJzdHJpbmdcIiA/IGV2ZW50LnJlc3VsdC5jb250ZW50WzBdLnRleHQgOiBTdHJpbmcoZXZlbnQucmVzdWx0KSk7XG4gICAgICAvLyBMZXQgcmVjb3JkVG9vbEludm9jYXRpb25FcnJvciBjbGFzc2lmeSB0aGUgZmFpbHVyZSBzbyBub24tZ3NkXyBoYXJuZXNzXG4gICAgICAvLyBlcnJvcnMgYW5kIGRldGVybWluaXN0aWMgcG9saWN5IHJlamVjdGlvbnMgYXJlIGhhbmRsZWQgY29uc2lzdGVudGx5LlxuICAgICAgcmVjb3JkVG9vbEludm9jYXRpb25FcnJvcihldmVudC50b29sTmFtZSwgZXJyb3JUZXh0KTtcbiAgICB9IGVsc2UgaWYgKGlzQXV0b0FjdGl2ZSgpKSB7XG4gICAgICBjbGVhclRvb2xJbnZvY2F0aW9uRXJyb3IoKTtcbiAgICB9XG4gICAgLy8gU2FmZXR5IGhhcm5lc3M6IHJlY29yZCB0b29sIGV4ZWN1dGlvbiByZXN1bHRzIGZvciBldmlkZW5jZSBjcm9zcy1yZWZlcmVuY2luZ1xuICAgIGlmIChpc0F1dG9BY3RpdmUoKSkge1xuICAgICAgc2FmZXR5UmVjb3JkVG9vbFJlc3VsdChldmVudC50b29sQ2FsbElkLCBldmVudC50b29sTmFtZSwgZXZlbnQucmVzdWx0LCBldmVudC5pc0Vycm9yKTtcbiAgICAgIC8vIFBlcnNpc3QgZXZpZGVuY2UgdG8gZGlzayBhZnRlciBlYWNoIHRvb2wgcmVzdWx0IHNvIGl0IHN1cnZpdmVzIGEgc2Vzc2lvblxuICAgICAgLy8gcmVzdGFydCBtaWQtdW5pdCAoQnVnICM0Mzg1IFx1MjAxNCBub24tcGVyc2lzdGVkIGV2aWRlbmNlIGZhbHNlIHBvc2l0aXZlcykuXG4gICAgICBjb25zdCBkYXNoID0gZ2V0QXV0b1J1bnRpbWVTbmFwc2hvdCgpO1xuICAgICAgaWYgKGRhc2guYmFzZVBhdGggJiYgZGFzaC5jdXJyZW50VW5pdD8udHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIikge1xuICAgICAgICBjb25zdCB7IG1pbGVzdG9uZTogcE1pZCwgc2xpY2U6IHBTaWQsIHRhc2s6IHBUaWQgfSA9IHBhcnNlVW5pdElkKGRhc2guY3VycmVudFVuaXQuaWQpO1xuICAgICAgICBpZiAocE1pZCAmJiBwU2lkICYmIHBUaWQpIHtcbiAgICAgICAgICBzYXZlRXZpZGVuY2VUb0Rpc2soZGFzaC5iYXNlUGF0aCwgcE1pZCwgcFNpZCwgcFRpZCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHBpLm9uKFwibW9kZWxfc2VsZWN0XCIsIGFzeW5jIChfZXZlbnQsIGN0eCkgPT4ge1xuICAgIGF3YWl0IHN5bmNTZXJ2aWNlVGllclN0YXR1cyhjdHgpO1xuICB9KTtcblxuICBwaS5vbihcImJlZm9yZV9wcm92aWRlcl9yZXF1ZXN0XCIsIGFzeW5jIChldmVudCkgPT4ge1xuICAgIGNvbnN0IHBheWxvYWQgPSBldmVudC5wYXlsb2FkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbDtcbiAgICBpZiAoIXBheWxvYWQgfHwgdHlwZW9mIHBheWxvYWQgIT09IFwib2JqZWN0XCIpIHJldHVybjtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCBPYnNlcnZhdGlvbiBNYXNraW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIC8vIFJlcGxhY2Ugb2xkIHRvb2wgcmVzdWx0cyB3aXRoIHBsYWNlaG9sZGVycyB0byByZWR1Y2UgY29udGV4dCBibG9hdC5cbiAgICAvLyBPbmx5IGFjdGl2ZSBkdXJpbmcgYXV0by1tb2RlIHdoZW4gY29udGV4dF9tYW5hZ2VtZW50Lm9ic2VydmF0aW9uX21hc2tpbmcgaXMgZW5hYmxlZC5cbiAgICBpZiAoaXNBdXRvQWN0aXZlKCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9wcmVmZXJlbmNlcy5qc1wiKTtcbiAgICAgICAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKTtcbiAgICAgICAgY29uc3QgY21Db25maWcgPSBwcmVmcz8ucHJlZmVyZW5jZXMuY29udGV4dF9tYW5hZ2VtZW50O1xuXG4gICAgICAgIC8vIE9ic2VydmF0aW9uIG1hc2tpbmc6IHJlcGxhY2Ugb2xkIHRvb2wgcmVzdWx0cyB3aXRoIHBsYWNlaG9sZGVyc1xuICAgICAgICBpZiAoY21Db25maWc/Lm9ic2VydmF0aW9uX21hc2tpbmcgIT09IGZhbHNlKSB7XG4gICAgICAgICAgY29uc3Qga2VlcFR1cm5zID0gY21Db25maWc/Lm9ic2VydmF0aW9uX21hc2tfdHVybnMgPz8gODtcbiAgICAgICAgICBjb25zdCB7IGNyZWF0ZU9ic2VydmF0aW9uTWFzayB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vY29udGV4dC1tYXNrZXIuanNcIik7XG4gICAgICAgICAgY29uc3QgbWFzayA9IGNyZWF0ZU9ic2VydmF0aW9uTWFzayhrZWVwVHVybnMpO1xuICAgICAgICAgIGNvbnN0IG1lc3NhZ2VzID0gcGF5bG9hZC5tZXNzYWdlcztcbiAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShtZXNzYWdlcykpIHtcbiAgICAgICAgICAgIHBheWxvYWQubWVzc2FnZXMgPSBtYXNrKG1lc3NhZ2VzKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBUb29sIHJlc3VsdCB0cnVuY2F0aW9uOiBjYXAgaW5kaXZpZHVhbCB0b29sIHJlc3VsdCBjb250ZW50IGxlbmd0aC5cbiAgICAgICAgLy8gSW4gcGktYWkgZm9ybWF0LCB0b29sUmVzdWx0IG1lc3NhZ2VzIGhhdmUgcm9sZTogXCJ0b29sUmVzdWx0XCIgYW5kIGNvbnRlbnQ6IFRleHRDb250ZW50W10uXG4gICAgICAgIC8vIENyZWF0ZXMgbmV3IG9iamVjdHMgdG8gYXZvaWQgbXV0YXRpbmcgc2hhcmVkIGNvbnZlcnNhdGlvbiBzdGF0ZS5cbiAgICAgICAgY29uc3QgbWF4Q2hhcnMgPSBjbUNvbmZpZz8udG9vbF9yZXN1bHRfbWF4X2NoYXJzID8/IDgwMDtcbiAgICAgICAgY29uc3QgbXNncyA9IHBheWxvYWQubWVzc2FnZXM7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG1zZ3MpKSB7XG4gICAgICAgICAgcGF5bG9hZC5tZXNzYWdlcyA9IG1zZ3MubWFwKChtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiB7XG4gICAgICAgICAgICAvLyBNYXRjaCB0b29sUmVzdWx0IG1lc3NhZ2VzIChyb2xlOiBcInRvb2xSZXN1bHRcIiwgY29udGVudCBpcyBhcnJheSBvZiBjb250ZW50IGJsb2NrcylcbiAgICAgICAgICAgIGlmIChtc2c/LnJvbGUgPT09IFwidG9vbFJlc3VsdFwiICYmIEFycmF5LmlzQXJyYXkobXNnLmNvbnRlbnQpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGJsb2NrcyA9IG1zZy5jb250ZW50IGFzIEFycmF5PFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgICAgICAgICAgICAgY29uc3QgdG90YWxMZW4gPSBibG9ja3MucmVkdWNlKChzdW06IG51bWJlciwgYikgPT4gc3VtICsgKHR5cGVvZiBiLnRleHQgPT09IFwic3RyaW5nXCIgPyBiLnRleHQubGVuZ3RoIDogMCksIDApO1xuICAgICAgICAgICAgICBpZiAodG90YWxMZW4gPiBtYXhDaGFycykge1xuICAgICAgICAgICAgICAgIGNvbnN0IHRydW5jYXRlZCA9IGJsb2Nrcy5tYXAoYiA9PiB7XG4gICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGIudGV4dCA9PT0gXCJzdHJpbmdcIiAmJiBiLnRleHQubGVuZ3RoID4gbWF4Q2hhcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgLi4uYiwgdGV4dDogYi50ZXh0LnNsaWNlKDAsIG1heENoYXJzKSArIFwiXFxuXHUyMDI2W3RydW5jYXRlZF1cIiB9O1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgcmV0dXJuIGI7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgLi4ubXNnLCBjb250ZW50OiB0cnVuY2F0ZWQgfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIG1zZztcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbCAqLyB9XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFNlcnZpY2UgVGllciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBjb25zdCBtb2RlbElkID0gZXZlbnQubW9kZWw/LmlkO1xuICAgIGlmICghbW9kZWxJZCkgcmV0dXJuIHBheWxvYWQ7XG4gICAgY29uc3QgeyBnZXRFZmZlY3RpdmVTZXJ2aWNlVGllciwgc3VwcG9ydHNTZXJ2aWNlVGllciB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vc2VydmljZS10aWVyLmpzXCIpO1xuICAgIGNvbnN0IHRpZXIgPSBnZXRFZmZlY3RpdmVTZXJ2aWNlVGllcigpO1xuICAgIGlmICghdGllciB8fCAhc3VwcG9ydHNTZXJ2aWNlVGllcihtb2RlbElkKSkgcmV0dXJuIHBheWxvYWQ7XG4gICAgcGF5bG9hZC5zZXJ2aWNlX3RpZXIgPSB0aWVyO1xuICAgIHJldHVybiBwYXlsb2FkO1xuICB9KTtcblxuICAvLyBDYXBhYmlsaXR5LWF3YXJlIG1vZGVsIHJvdXRpbmcgaG9vayAoQURSLTAwNClcbiAgLy8gRXh0ZW5zaW9ucyBjYW4gb3ZlcnJpZGUgbW9kZWwgc2VsZWN0aW9uIGJ5IHJldHVybmluZyB7IG1vZGVsSWQ6IFwiLi4uXCIgfVxuICAvLyBSZXR1cm4gdW5kZWZpbmVkIHRvIGxldCB0aGUgYnVpbHQtaW4gY2FwYWJpbGl0eSBzY29yaW5nIHByb2NlZWQuXG4gIHBpLm9uKFwiYmVmb3JlX21vZGVsX3NlbGVjdFwiLCBhc3luYyAoX2V2ZW50KSA9PiB7XG4gICAgLy8gRGVmYXVsdDogbm8gb3ZlcnJpZGUgXHUyMDE0IGxldCBjYXBhYmlsaXR5IHNjb3JpbmcgaGFuZGxlIHNlbGVjdGlvblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH0pO1xuXG4gIC8vIFRvb2wgc2V0IGFkYXB0YXRpb24gaG9vayAoQURSLTAwNSBQaGFzZSA0KVxuICAvLyBFeHRlbnNpb25zIGNhbiBvdmVycmlkZSB0b29sIHNldCBhZnRlciBtb2RlbCBzZWxlY3Rpb24gYnkgcmV0dXJuaW5nIHsgdG9vbE5hbWVzOiBbLi4uXSB9XG4gIC8vIFJldHVybiB1bmRlZmluZWQgdG8gbGV0IHRoZSBidWlsdC1pbiBwcm92aWRlciBjb21wYXRpYmlsaXR5IGZpbHRlcmluZyBwcm9jZWVkLlxuICBwaS5vbihcImFkanVzdF90b29sX3NldFwiLCBhc3luYyAoZXZlbnQpID0+IHtcbiAgICBpZiAoaXNGdWxsR3NkVG9vbFN1cmZhY2VSZXF1ZXN0ZWQoKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBjb25zdCByZW1vdmVkID0gbmV3IFNldChldmVudC5maWx0ZXJlZFRvb2xzKTtcbiAgICBjb25zdCBwcm92aWRlckNvbXBhdGlibGUgPSBldmVudC5hY3RpdmVUb29sTmFtZXMuZmlsdGVyKChuYW1lKSA9PiAhcmVtb3ZlZC5oYXMobmFtZSkpO1xuICAgIGNvbnN0IHJlcXVlc3RTY29wZWQgPSBidWlsZFJlcXVlc3RTY29wZWRHc2RUb29sU2V0KHByb3ZpZGVyQ29tcGF0aWJsZSwgZXZlbnQucmVxdWVzdEN1c3RvbU1lc3NhZ2VzKTtcbiAgICBpZiAocmVxdWVzdFNjb3BlZCkge1xuICAgICAgcmV0dXJuIHsgdG9vbE5hbWVzOiByZXF1ZXN0U2NvcGVkIH07XG4gICAgfVxuICAgIGNvbnN0IGRhc2ggPSBnZXRBdXRvUnVudGltZVNuYXBzaG90KCk7XG4gICAgaWYgKGRhc2guYWN0aXZlICYmIGRhc2guY3VycmVudFVuaXQpIHtcbiAgICAgIHJldHVybiB7IHRvb2xOYW1lczogYnVpbGRNaW5pbWFsQXV0b0dzZFRvb2xTZXQocHJvdmlkZXJDb21wYXRpYmxlLCBkYXNoLmN1cnJlbnRVbml0LnR5cGUpIH07XG4gICAgfVxuICAgIGlmIChpc0dlbmVyYWxHc2RUb29sU2NvcGluZ1JlcXVlc3RlZCgpKSB7XG4gICAgICByZXR1cm4geyB0b29sTmFtZXM6IGJ1aWxkTWluaW1hbEdzZFRvb2xTZXQocHJvdmlkZXJDb21wYXRpYmxlKSB9O1xuICAgIH1cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsU0FBUyxZQUFZO0FBQzlCLFNBQVMscUJBQXFCO0FBRzlCLFNBQVMsMkJBQTJCO0FBR3BDLFNBQVMsc0JBQXNCO0FBRS9CLFNBQVMsd0JBQXdCLHNCQUFzQixrQkFBa0Isd0JBQXdCO0FBQ2pHLFNBQVMsbUJBQW1CLDBCQUEwQiwyQkFBMkIsb0JBQW9CLDBCQUEwQixtQkFBbUIscUJBQXFCLHlCQUF5Qix5QkFBeUIsMkJBQTJCLDBCQUEwQixrQkFBa0IsZ0JBQWdCLGtCQUFrQixnQkFBZ0Isd0JBQXdCLDRCQUE0QiwyQ0FBMkM7QUFDamIsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxvQkFBb0Isd0JBQXdCLDJCQUEyQjtBQUNoRixTQUFTLFVBQVUsVUFBVSxzQkFBc0I7QUFDbkQsU0FBUywwQkFBMEIsd0JBQXdCLGNBQWMsY0FBYyxhQUFhLGVBQWUsaUNBQWlDO0FBRXBKLFNBQVMsbUJBQW1CLDhCQUE4QjtBQUMxRCxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGtCQUFrQixzQkFBc0Isb0JBQW9CLHdCQUF3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QUFLO0FBQ2hDLHNCQUFJLE9BQU8sRUFBRSxTQUFTLFlBQVksRUFBRSxLQUFLLFNBQVMsVUFBVTtBQUMxRCwyQkFBTyxFQUFFLEdBQUcsR0FBRyxNQUFNLEVBQUUsS0FBSyxNQUFNLEdBQUcsUUFBUSxJQUFJLHNCQUFpQjtBQUFBLGtCQUNwRTtBQUNBLHlCQUFPO0FBQUEsZ0JBQ1QsQ0FBQztBQUNELHVCQUFPLEVBQUUsR0FBRyxLQUFLLFNBQVMsVUFBVTtBQUFBLGNBQ3RDO0FBQUEsWUFDRjtBQUNBLG1CQUFPO0FBQUEsVUFDVCxDQUFDO0FBQUEsUUFDSDtBQUFBLE1BQ0YsUUFBUTtBQUFBLE1BQWtCO0FBQUEsSUFDNUI7QUFHQSxVQUFNLFVBQVUsTUFBTSxPQUFPO0FBQzdCLFFBQUksQ0FBQyxRQUFTLFFBQU87QUFDckIsVUFBTSxFQUFFLHlCQUF5QixvQkFBb0IsSUFBSSxNQUFNLE9BQU8sb0JBQW9CO0FBQzFGLFVBQU0sT0FBTyx3QkFBd0I7QUFDckMsUUFBSSxDQUFDLFFBQVEsQ0FBQyxvQkFBb0IsT0FBTyxFQUFHLFFBQU87QUFDbkQsWUFBUSxlQUFlO0FBQ3ZCLFdBQU87QUFBQSxFQUNULENBQUM7QUFLRCxLQUFHLEdBQUcsdUJBQXVCLE9BQU8sV0FBVztBQUU3QyxXQUFPO0FBQUEsRUFDVCxDQUFDO0FBS0QsS0FBRyxHQUFHLG1CQUFtQixPQUFPLFVBQVU7QUFDeEMsUUFBSSw4QkFBOEIsRUFBRyxRQUFPO0FBQzVDLFVBQU0sVUFBVSxJQUFJLElBQUksTUFBTSxhQUFhO0FBQzNDLFVBQU0scUJBQXFCLE1BQU0sZ0JBQWdCLE9BQU8sQ0FBQyxTQUFTLENBQUMsUUFBUSxJQUFJLElBQUksQ0FBQztBQUNwRixVQUFNLGdCQUFnQiw2QkFBNkIsb0JBQW9CLE1BQU0scUJBQXFCO0FBQ2xHLFFBQUksZUFBZTtBQUNqQixhQUFPLEVBQUUsV0FBVyxjQUFjO0FBQUEsSUFDcEM7QUFDQSxVQUFNLE9BQU8sdUJBQXVCO0FBQ3BDLFFBQUksS0FBSyxVQUFVLEtBQUssYUFBYTtBQUNuQyxhQUFPLEVBQUUsV0FBVywyQkFBMkIsb0JBQW9CLEtBQUssWUFBWSxJQUFJLEVBQUU7QUFBQSxJQUM1RjtBQUNBLFFBQUksaUNBQWlDLEdBQUc7QUFDdEMsYUFBTyxFQUFFLFdBQVcsdUJBQXVCLGtCQUFrQixFQUFFO0FBQUEsSUFDakU7QUFDQSxXQUFPO0FBQUEsRUFDVCxDQUFDO0FBQ0g7IiwKICAibmFtZXMiOiBbXQp9Cg==
