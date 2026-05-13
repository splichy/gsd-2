import { importExtensionModule } from "@gsd/pi-coding-agent";
import {
  USER_DRIVEN_DEEP_UNITS,
  isAwaitingUserInput
} from "../auto-post-unit.js";
import {
  MAX_RECOVERY_CHARS,
  BUDGET_THRESHOLDS,
  MAX_FINALIZE_TIMEOUTS
} from "./types.js";
import { detectStuck } from "./detect-stuck.js";
import { runUnit } from "./run-unit.js";
import { debugLog } from "../debug-logger.js";
import { resolveWorktreeProjectRoot, normalizeWorktreePathForCompare } from "../worktree-root.js";
import { classifyProject } from "../detection.js";
import { MergeConflictError } from "../git-service.js";
import { setCurrentPhase, clearCurrentPhase } from "../../shared/gsd-phase-state.js";
import { pauseAutoForProviderError } from "../provider-error-pause.js";
import { resumeAutoAfterProviderDelay } from "../bootstrap/provider-error-resume.js";
import { join, basename } from "node:path";
import { existsSync, cpSync } from "node:fs";
import {
  logWarning,
  logError,
  _resetLogs,
  drainLogs,
  drainAndSummarize,
  formatForNotification,
  hasAnyIssues
} from "../workflow-logger.js";
import { gsdRoot } from "../paths.js";
import { atomicWriteSync } from "../atomic-write.js";
import { verifyExpectedArtifact, diagnoseExpectedArtifact, buildLoopRemediationSteps, refreshRecoveryDbForArtifact } from "../auto-recovery.js";
import { writeUnitRuntimeRecord } from "../unit-runtime.js";
import { withTimeout, FINALIZE_PRE_TIMEOUT_MS, FINALIZE_POST_TIMEOUT_MS } from "./finalize-timeout.js";
import { getEligibleSlices } from "../slice-parallel-eligibility.js";
import { startSliceParallel } from "../slice-parallel-orchestrator.js";
import { isDbAvailable, getMilestoneSlices } from "../gsd-db.js";
import { reconcileBeforeSpawn } from "../state-reconciliation.js";
import { ensurePlanV2Graph, isEmptyPlanV2GraphResult, isMissingFinalizedContextResult } from "../uok/plan-v2.js";
import { resolveUokFlags } from "../uok/flags.js";
import { UokGateRunner } from "../uok/gate-runner.js";
import { resetEvidence, loadEvidenceFromDisk } from "../safety/evidence-collector.js";
import { parseUnitId } from "../unit-id.js";
import { createCheckpoint, cleanupCheckpoint, rollbackToCheckpoint } from "../safety/git-checkpoint.js";
import { resolveSafetyHarnessConfig } from "../safety/safety-harness.js";
import {
  getWorkflowTransportSupportError,
  getRequiredWorkflowToolsForAutoUnit,
  supportsStructuredQuestions
} from "../workflow-mcp.js";
import { resolveManifest } from "../unit-context-manifest.js";
import { createWorktreeSafetyModule } from "../worktree-safety.js";
import { isSuspiciousGhostCompletion } from "../auto-unit-closeout.js";
import { decideVerificationRetry, verificationRetryKey } from "./verification-retry-policy.js";
function isSamePathLocal(a, b) {
  return normalizeWorktreePathForCompare(a) === normalizeWorktreePathForCompare(b);
}
async function applyVerificationRetryPolicy(ic, unitType, phase) {
  const { ctx, pi, s, deps } = ic;
  const retryInfo = s.pendingVerificationRetry;
  const key = unitType && retryInfo ? verificationRetryKey(unitType, retryInfo.unitId) : void 0;
  const decision = decideVerificationRetry({
    unitType,
    retryInfo,
    previousFailureHash: key ? s.verificationRetryFailureHashes.get(key) : void 0
  });
  if (decision.action === "pause") {
    s.pendingVerificationRetry = null;
    debugLog("autoLoop", {
      phase: `${phase}-paused`,
      reason: decision.reason,
      unitType,
      unitId: retryInfo?.unitId,
      failureHash: decision.failureHash
    });
    ctx.ui.notify(
      decision.reason === "duplicate-failure-context" ? `Verification retry for ${unitType ?? "unit"} ${retryInfo?.unitId ?? "unknown"} produced the same failure context. Pausing auto-mode instead of re-dispatching.` : "Verification retry requested without retry context. Pausing auto-mode instead of re-dispatching.",
      "warning"
    );
    await deps.pauseAuto(ctx, pi);
    return { action: "break", reason: decision.reason };
  }
  s.verificationRetryFailureHashes.set(decision.key, decision.failureHash);
  debugLog("autoLoop", {
    phase: `${phase}-backoff`,
    iteration: ic.iteration,
    unitType,
    unitId: retryInfo?.unitId,
    attempt: retryInfo?.attempt,
    delayMs: decision.delayMs,
    baseDelayMs: decision.baseDelayMs,
    failureHash: decision.failureHash
  });
  await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
  return null;
}
function shouldDegradeEmptyWorktreeToProjectRoot(worktreeClassification, projectRootClassification) {
  return worktreeClassification.kind === "greenfield" && projectRootClassification.kind !== "greenfield" && projectRootClassification.kind !== "invalid-repo";
}
function unitWritesSource(unitType) {
  const manifest = resolveManifest(unitType);
  if (!manifest) return null;
  return manifest.tools.mode === "all" || manifest.tools.mode === "docs";
}
function formatWorktreeSafetyFailure(result) {
  return `Worktree Safety failed (${result.kind}): ${result.reason} ${result.remediation}`;
}
function resolveEmptyWorktreeWithProjectContent(unitRoot, projectRoot) {
  if (isSamePathLocal(unitRoot, projectRoot)) return false;
  const worktreeClassification = classifyProject(unitRoot);
  if (worktreeClassification.kind !== "greenfield") return false;
  const projectRootClassification = classifyProject(projectRoot);
  return shouldDegradeEmptyWorktreeToProjectRoot(worktreeClassification, projectRootClassification);
}
async function validateSourceWriteWorktreeSafety(ic, unitType, unitId, milestoneId, phase) {
  const { ctx, pi, s, deps } = ic;
  if (!s.basePath) return null;
  if (s.activeEngineId) return null;
  const writesSource = unitWritesSource(unitType);
  if (writesSource === null) {
    const msg2 = `Worktree Safety failed (missing-tool-contract): missing Tool Contract for ${unitType}. Add a UnitContextManifest entry before dispatching this Unit.`;
    debugLog("worktreeSafety", {
      phase,
      unitType,
      unitId,
      milestoneId,
      result: { ok: false, kind: "missing-tool-contract", reason: msg2 },
      basePath: s.basePath
    });
    ctx.ui.notify(msg2, "error");
    await deps.stopAuto(ctx, pi, msg2);
    return { action: "break", reason: "missing-tool-contract" };
  }
  if (!writesSource) return null;
  const projectRoot = s.canonicalProjectRoot ?? resolveWorktreeProjectRoot(s.basePath, s.originalBasePath);
  if (deps.getIsolationMode(projectRoot) !== "worktree") return null;
  const safety = createWorktreeSafetyModule();
  const result = safety.validateUnitRoot({
    unitType,
    unitId,
    writeScope: "source-writing",
    projectRoot,
    unitRoot: s.basePath,
    milestoneId,
    expectedBranch: milestoneId ? deps.autoWorktreeBranch(milestoneId) : null,
    emptyWorktreeWithProjectContent: resolveEmptyWorktreeWithProjectContent(s.basePath, projectRoot),
    lease: s.workerId ? {
      required: true,
      held: s.currentMilestoneId === milestoneId && s.milestoneLeaseToken !== null,
      owner: s.workerId
    } : void 0
  });
  if (result.ok) return null;
  const msg = formatWorktreeSafetyFailure(result);
  debugLog("worktreeSafety", {
    phase,
    unitType,
    unitId,
    milestoneId,
    result,
    basePath: s.basePath,
    projectRoot
  });
  ctx.ui.notify(msg, "error");
  await deps.stopAuto(ctx, pi, msg);
  return { action: "break", reason: result.kind };
}
let consecutiveSessionTimeouts = 0;
const MAX_SESSION_TIMEOUT_AUTO_RESUMES = 3;
function resetSessionTimeoutState() {
  consecutiveSessionTimeouts = 0;
}
function _resolveReportBasePath(s) {
  return resolveWorktreeProjectRoot(s.basePath, s.originalBasePath);
}
function _resolveDispatchGuardBasePath(s) {
  return resolveWorktreeProjectRoot(s.basePath, s.originalBasePath);
}
const PLAN_V2_GATE_PHASES = /* @__PURE__ */ new Set([
  "executing",
  "summarizing",
  "validating-milestone",
  "completing-milestone"
]);
function shouldRunPlanV2Gate(phase) {
  return PLAN_V2_GATE_PHASES.has(phase);
}
function _shouldProceedWithInvalidRepoClassificationForTest(reason, hasGit) {
  return reason === "missing .git" && hasGit;
}
function _resolveCurrentUnitStartedAtForTest(currentUnit) {
  return currentUnit?.startedAt;
}
async function generateMilestoneReport(s, ctx, milestoneId) {
  const { loadVisualizerData } = await importExtensionModule(import.meta.url, "../visualizer-data.js");
  const { generateHtmlReport } = await importExtensionModule(import.meta.url, "../export-html.js");
  const { writeReportSnapshot } = await importExtensionModule(import.meta.url, "../reports.js");
  const { basename: basename2 } = await import("node:path");
  const reportBasePath = _resolveReportBasePath(s);
  const snapData = await loadVisualizerData(reportBasePath);
  const completedMs = snapData.milestones.find(
    (m) => m.id === milestoneId
  );
  const msTitle = completedMs?.title ?? milestoneId;
  const gsdVersion = process.env.GSD_VERSION ?? "0.0.0";
  const projName = basename2(reportBasePath);
  const doneSlices = snapData.milestones.reduce(
    (acc, m) => acc + m.slices.filter((sl) => sl.done).length,
    0
  );
  const totalSlices = snapData.milestones.reduce(
    (acc, m) => acc + m.slices.length,
    0
  );
  const outPath = writeReportSnapshot({
    basePath: reportBasePath,
    html: generateHtmlReport(snapData, {
      projectName: projName,
      projectPath: reportBasePath,
      gsdVersion,
      milestoneId,
      indexRelPath: "index.html"
    }),
    milestoneId,
    milestoneTitle: msTitle,
    kind: "milestone",
    projectName: projName,
    projectPath: reportBasePath,
    gsdVersion,
    totalCost: snapData.totals?.cost ?? 0,
    totalTokens: snapData.totals?.tokens.total ?? 0,
    totalDuration: snapData.totals?.duration ?? 0,
    doneSlices,
    totalSlices,
    doneMilestones: snapData.milestones.filter(
      (m) => m.status === "complete"
    ).length,
    totalMilestones: snapData.milestones.length,
    phase: snapData.phase
  });
  ctx.ui.notify(
    `Report saved: .gsd/reports/${basename2(outPath)} \u2014 open index.html to browse progression.`,
    "info"
  );
}
async function closeoutAndStop(ctx, pi, s, deps, reason) {
  if (s.currentUnit) {
    await deps.closeoutUnit(
      ctx,
      s.basePath,
      s.currentUnit.type,
      s.currentUnit.id,
      s.currentUnit.startedAt,
      deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id)
    );
    s.currentUnit = null;
  }
  await deps.stopAuto(ctx, pi, reason);
}
async function stopOnPostflightRecoveryNeeded(ic, result, milestoneId) {
  if (!result.needsManualRecovery) return null;
  const { ctx, pi, deps } = ic;
  const reason = `Post-merge stash restore failed for milestone ${milestoneId}`;
  ctx.ui.notify(
    `${reason}. Resolve the working tree before resuming auto-mode. ${result.message}`,
    "error"
  );
  await deps.stopAuto(ctx, pi, reason);
  return { action: "break", reason: "postflight-stash-restore-failed" };
}
async function restorePreflightStashOrStop(ic, preflight, milestoneId) {
  if (!preflight.stashPushed) return null;
  const { ctx, s, deps } = ic;
  const result = deps.postflightPopStash(
    s.originalBasePath || s.basePath,
    milestoneId,
    preflight.stashMarker,
    ctx.ui.notify.bind(ctx.ui)
  );
  return stopOnPostflightRecoveryNeeded(ic, result, milestoneId);
}
async function _runMilestoneMergeWithStashRestore(ic, milestoneId) {
  const { ctx, pi, s, deps } = ic;
  const preflight = deps.preflightCleanRoot(
    s.originalBasePath || s.basePath,
    milestoneId,
    ctx.ui.notify.bind(ctx.ui)
  );
  let mergeError = null;
  const exitResult = deps.lifecycle.exitMilestone(
    milestoneId,
    { merge: true },
    ctx.ui
  );
  if (exitResult.ok) {
    s.milestoneMergedInPhases = true;
  } else {
    mergeError = exitResult.cause ?? new Error(`exit ${exitResult.reason}`);
  }
  let stashResult = null;
  if (preflight.stashPushed) {
    stashResult = deps.postflightPopStash(
      s.originalBasePath || s.basePath,
      milestoneId,
      preflight.stashMarker,
      ctx.ui.notify.bind(ctx.ui)
    );
  }
  if (mergeError) {
    if (mergeError instanceof MergeConflictError) {
      ctx.ui.notify(
        `Merge conflict: ${mergeError.conflictedFiles.join(", ")}. Resolve conflicts manually and run /gsd auto to resume.`,
        "error"
      );
      await deps.stopAuto(ctx, pi, `Merge conflict on milestone ${milestoneId}`);
      return { action: "break", reason: "merge-conflict" };
    }
    logError("engine", "Milestone merge failed with non-conflict error", {
      milestone: milestoneId,
      error: String(mergeError)
    });
    ctx.ui.notify(
      `Merge failed: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}. Resolve and run /gsd auto to resume.`,
      "error"
    );
    await deps.stopAuto(
      ctx,
      pi,
      `Merge error on milestone ${milestoneId}: ${String(mergeError)}`
    );
    return { action: "break", reason: "merge-failed" };
  }
  if (stashResult) {
    return stopOnPostflightRecoveryNeeded(ic, stashResult, milestoneId);
  }
  return null;
}
async function _runMilestoneMergeOnceWithStashRestore(ic, milestoneId) {
  if (ic.s.milestoneMergedInPhases) {
    debugLog("autoLoop", {
      phase: "milestone-merge-skip",
      reason: "already-merged-in-phases",
      milestoneId
    });
    return null;
  }
  return _runMilestoneMergeWithStashRestore(ic, milestoneId);
}
async function emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, errorContext) {
  ic.deps.emitJournalEvent({
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    flowId: ic.flowId,
    seq: ic.nextSeq(),
    eventType: "unit-end",
    data: {
      unitType,
      unitId,
      status: "cancelled",
      artifactVerified: false,
      ...errorContext ? { errorContext } : {}
    },
    causedBy: { flowId: ic.flowId, seq: unitStartSeq }
  });
}
function _buildCancelledUnitStopReason(unitType, unitId, errorContext) {
  const cancellationMessage = errorContext?.message ?? "unknown";
  const isSessionCreationFailure = errorContext?.category === "session-failed";
  if (isSessionCreationFailure) {
    return {
      notifyMessage: `Session creation failed for ${unitType} ${unitId}: ${cancellationMessage}. Stopping auto-mode.`,
      stopReason: `Session creation failed: ${cancellationMessage}`,
      loopReason: "session-failed"
    };
  }
  return {
    notifyMessage: `Unit ${unitType} ${unitId} aborted after dispatch: ${cancellationMessage}. Stopping auto-mode.`,
    stopReason: `Unit aborted: ${cancellationMessage}`,
    loopReason: "unit-aborted"
  };
}
async function failClosedOnFinalizeTimeout(ic, iterData, loopState, stage, startedAt) {
  const { ctx, pi, s, deps } = ic;
  const now = Date.now();
  const unitType = iterData.unitType;
  const unitId = iterData.unitId;
  const timeoutMs = stage === "pre" ? FINALIZE_PRE_TIMEOUT_MS : FINALIZE_POST_TIMEOUT_MS;
  const progressKind = stage === "pre" ? "finalize-pre-timeout" : "finalize-post-timeout";
  writeUnitRuntimeRecord(s.basePath, unitType, unitId, startedAt, {
    phase: "finalize-timeout",
    timeoutAt: now,
    lastProgressAt: now,
    lastProgressKind: progressKind
  });
  deps.emitJournalEvent({
    ts: new Date(now).toISOString(),
    flowId: ic.flowId,
    seq: ic.nextSeq(),
    eventType: "unit-end",
    data: {
      unitType,
      unitId,
      status: "timed-out-finalize",
      artifactVerified: false,
      finalizeStage: stage
    }
  });
  loopState.consecutiveFinalizeTimeouts++;
  debugLog("autoLoop", {
    phase: progressKind,
    iteration: ic.iteration,
    unitType,
    unitId,
    consecutiveTimeouts: loopState.consecutiveFinalizeTimeouts
  });
  ctx.ui.notify(
    `${stage === "pre" ? "postUnitPreVerification" : "postUnitPostVerification"} timed out after ${timeoutMs / 1e3}s for ${unitType} ${unitId} (${loopState.consecutiveFinalizeTimeouts}/${MAX_FINALIZE_TIMEOUTS}) \u2014 pausing auto-mode for recovery.`,
    "warning"
  );
  await deps.pauseAuto(ctx, pi);
  s.currentUnit = null;
  clearCurrentPhase();
  drainLogs();
  return { action: "break", reason: progressKind };
}
async function runPreDispatch(ic, loopState) {
  const { ctx, pi, s, deps, prefs } = ic;
  const uokFlags = resolveUokFlags(prefs);
  const runPreDispatchGate = async (input) => {
    if (!uokFlags.gates) return;
    const gateRunner = new UokGateRunner();
    gateRunner.register({
      id: input.gateId,
      type: input.gateType,
      execute: async () => ({
        outcome: input.outcome,
        failureClass: input.failureClass,
        rationale: input.rationale,
        findings: input.findings ?? ""
      })
    });
    await gateRunner.run(input.gateId, {
      basePath: s.basePath,
      traceId: `pre-dispatch:${ic.flowId}`,
      turnId: `iter-${ic.iteration}`,
      milestoneId: input.milestoneId ?? s.currentMilestoneId ?? void 0,
      unitType: "pre-dispatch",
      unitId: `iter-${ic.iteration}`
    });
  };
  const staleMsg = deps.checkResourcesStale(s.resourceVersionOnStart);
  if (staleMsg) {
    await runPreDispatchGate({
      gateId: "resource-version-guard",
      gateType: "policy",
      outcome: "fail",
      failureClass: "policy",
      rationale: "resource version guard blocked dispatch",
      findings: staleMsg
    });
    await deps.stopAuto(ctx, pi, staleMsg);
    debugLog("autoLoop", { phase: "exit", reason: "resources-stale" });
    return { action: "break", reason: "resources-stale" };
  }
  await runPreDispatchGate({
    gateId: "resource-version-guard",
    gateType: "policy",
    outcome: "pass",
    failureClass: "none",
    rationale: "resource version guard passed"
  });
  deps.invalidateAllCaches();
  s.lastPromptCharCount = void 0;
  s.lastBaselineCharCount = void 0;
  try {
    const healthGate = await deps.preDispatchHealthGate(s.basePath);
    if (healthGate.fixesApplied.length > 0) {
      ctx.ui.notify(
        `Pre-dispatch: ${healthGate.fixesApplied.join(", ")}`,
        "info"
      );
    }
    if (!healthGate.proceed) {
      await runPreDispatchGate({
        gateId: "pre-dispatch-health-gate",
        gateType: "execution",
        outcome: "manual-attention",
        failureClass: "manual-attention",
        rationale: "pre-dispatch health gate blocked dispatch",
        findings: healthGate.reason
      });
      ctx.ui.notify(
        healthGate.reason || "Pre-dispatch health check failed \u2014 run /gsd doctor for details.",
        "error"
      );
      await deps.pauseAuto(ctx, pi);
      debugLog("autoLoop", { phase: "exit", reason: "health-gate-failed" });
      return { action: "break", reason: "health-gate-failed" };
    }
    await runPreDispatchGate({
      gateId: "pre-dispatch-health-gate",
      gateType: "execution",
      outcome: "pass",
      failureClass: "none",
      rationale: "pre-dispatch health gate passed",
      findings: healthGate.fixesApplied.length > 0 ? healthGate.fixesApplied.join(", ") : ""
    });
  } catch (e) {
    await runPreDispatchGate({
      gateId: "pre-dispatch-health-gate",
      gateType: "execution",
      outcome: "manual-attention",
      failureClass: "manual-attention",
      rationale: "pre-dispatch health gate threw unexpectedly",
      findings: String(e)
    });
    logWarning("engine", "Pre-dispatch health gate threw unexpectedly", { error: String(e) });
  }
  if (s.originalBasePath && !isSamePathLocal(s.basePath, s.originalBasePath) && s.currentMilestoneId && s.scope) {
    deps.worktreeProjection.projectRootToWorktree(s.scope);
  }
  let state = await deps.deriveState(s.canonicalProjectRoot);
  const { getDeepStageGate } = await import("../auto-dispatch.js");
  const deepStageGate = getDeepStageGate(prefs, s.basePath);
  const canRunDeepSetupGate = state.phase === "pre-planning" || state.phase === "needs-discussion" || state.phase === "planning";
  if (canRunDeepSetupGate && (deepStageGate.status === "pending" || deepStageGate.status === "blocked")) {
    debugLog("autoLoop", {
      phase: "deep-project-stage-gate",
      stage: deepStageGate.stage,
      status: deepStageGate.status,
      reason: deepStageGate.reason
    });
    return {
      action: "next",
      data: {
        state: {
          ...state,
          phase: "pre-planning",
          activeMilestone: null,
          activeSlice: null,
          activeTask: null,
          nextAction: deepStageGate.reason
        },
        mid: "PROJECT",
        midTitle: "Project setup"
      }
    };
  }
  if (uokFlags.planV2 && shouldRunPlanV2Gate(state.phase)) {
    let compiled = ensurePlanV2Graph(s.basePath, state);
    if (isEmptyPlanV2GraphResult(compiled)) {
      deps.invalidateAllCaches();
      state = await deps.deriveState(s.canonicalProjectRoot);
      compiled = shouldRunPlanV2Gate(state.phase) ? ensurePlanV2Graph(s.basePath, state) : {
        ok: true,
        reason: "empty plan-v2 graph recovered by state rederive",
        nodeCount: 0
      };
    }
    if (!compiled.ok) {
      const reason = compiled.reason ?? "Plan v2 compilation failed";
      if (isMissingFinalizedContextResult(compiled)) {
        await runPreDispatchGate({
          gateId: "plan-v2-gate",
          gateType: "policy",
          outcome: "pass",
          failureClass: "none",
          rationale: "plan v2 missing context recovery deferred to dispatch",
          findings: reason,
          milestoneId: state.activeMilestone?.id ?? void 0
        });
      } else {
        await runPreDispatchGate({
          gateId: "plan-v2-gate",
          gateType: "policy",
          outcome: "manual-attention",
          failureClass: "manual-attention",
          rationale: "plan v2 compile gate failed",
          findings: reason,
          milestoneId: state.activeMilestone?.id ?? void 0
        });
        ctx.ui.notify(`Plan gate failed-closed: ${reason}

If this keeps happening, try: /gsd doctor heal`, "error");
        await deps.pauseAuto(ctx, pi);
        return { action: "break", reason: "plan-v2-gate-failed" };
      }
    }
    if (compiled.ok) {
      await runPreDispatchGate({
        gateId: "plan-v2-gate",
        gateType: "policy",
        outcome: "pass",
        failureClass: "none",
        rationale: "plan v2 compile gate passed",
        milestoneId: state.activeMilestone?.id ?? void 0
      });
    }
  }
  deps.syncCmuxSidebar(prefs, state);
  let mid = state.activeMilestone?.id;
  let midTitle = state.activeMilestone?.title;
  debugLog("autoLoop", {
    phase: "state-derived",
    iteration: ic.iteration,
    mid,
    statePhase: state.phase
  });
  if (prefs?.slice_parallel?.enabled && mid && !process.env.GSD_PARALLEL_WORKER && isDbAvailable()) {
    try {
      const dbSlices = getMilestoneSlices(mid);
      if (dbSlices.length > 0) {
        const doneIds = new Set(dbSlices.filter((sl) => sl.status === "complete" || sl.status === "done").map((sl) => sl.id));
        const sliceInputs = dbSlices.map((sl) => ({
          id: sl.id,
          done: doneIds.has(sl.id),
          depends: sl.depends ?? []
        }));
        const eligible = getEligibleSlices(sliceInputs, doneIds);
        if (eligible.length > 1) {
          debugLog("autoLoop", {
            phase: "slice-parallel-dispatch",
            iteration: ic.iteration,
            mid,
            eligibleSlices: eligible.map((e) => e.id)
          });
          ctx.ui.notify(
            `Slice-parallel: dispatching ${eligible.length} eligible slices for ${mid}.`,
            "info"
          );
          const spawnGate = await reconcileBeforeSpawn(s.basePath);
          if (!spawnGate.ok) {
            ctx.ui.notify(
              `Slice-parallel: aborting spawn \u2014 ${spawnGate.reason}`,
              "error"
            );
            return { action: "break", reason: `slice-parallel-reconciliation-failed: ${spawnGate.reason}` };
          }
          const result = await startSliceParallel(
            s.basePath,
            mid,
            eligible,
            {
              maxWorkers: prefs.slice_parallel.max_workers ?? 2,
              useExecutionGraph: uokFlags.executionGraph
            }
          );
          if (result.started.length > 0) {
            ctx.ui.notify(
              `Slice-parallel: started ${result.started.length} worker(s): ${result.started.join(", ")}.`,
              "info"
            );
            await deps.stopAuto(ctx, pi, `Slice-parallel dispatched for ${mid}`);
            return { action: "break", reason: "slice-parallel-dispatched" };
          }
        }
      }
    } catch (err) {
      debugLog("autoLoop", {
        phase: "slice-parallel-check-error",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  if (mid && s.currentMilestoneId && mid !== s.currentMilestoneId) {
    deps.emitJournalEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "milestone-transition", data: { from: s.currentMilestoneId, to: mid } });
    ctx.ui.notify(
      `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}: ${midTitle}.`,
      "info"
    );
    deps.sendDesktopNotification(
      "GSD",
      `Milestone ${s.currentMilestoneId} complete!`,
      "success",
      "milestone",
      basename(s.originalBasePath || s.basePath)
    );
    deps.logCmuxEvent(
      prefs,
      `Milestone ${s.currentMilestoneId} complete. Advancing to ${mid}.`,
      "success"
    );
    const vizPrefs = prefs;
    if (vizPrefs?.auto_visualize) {
      ctx.ui.notify("Run /gsd visualize to see progress overview.", "info");
    }
    if (vizPrefs?.auto_report !== false) {
      try {
        await generateMilestoneReport(s, ctx, s.currentMilestoneId);
      } catch (err) {
        ctx.ui.notify(
          `Report generation failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning"
        );
      }
    }
    s.unitDispatchCount.clear();
    s.unitRecoveryCount.clear();
    s.unitLifetimeDispatches.clear();
    loopState.recentUnits.length = 0;
    loopState.stuckRecoveryAttempts = 0;
    {
      const stop = await _runMilestoneMergeOnceWithStashRestore(ic, s.currentMilestoneId);
      if (stop) return stop;
    }
    deps.invalidateAllCaches();
    state = await deps.deriveState(s.canonicalProjectRoot);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;
    if (mid) {
      if (deps.getIsolationMode(s.basePath) !== "none") {
        deps.captureIntegrationBranch(s.basePath, mid);
      }
      const enterResult = deps.lifecycle.enterMilestone(mid, ctx.ui);
      if (!enterResult.ok) {
        ctx.ui.notify(
          `Milestone transition stopped: failed to enter ${mid} (${enterResult.reason}).`,
          "error"
        );
        if (enterResult.reason === "lease-conflict") {
          await deps.pauseAuto(ctx, pi);
        }
        return { action: "break", reason: "milestone-enter-failed" };
      }
    } else {
    }
    const pendingIds = state.registry.filter(
      (m) => m.status !== "complete" && m.status !== "parked"
    ).map((m) => m.id);
    deps.pruneQueueOrder(s.basePath, pendingIds);
    try {
      const completedKeysPath = join(gsdRoot(s.basePath), "completed-units.json");
      if (existsSync(completedKeysPath) && s.currentMilestoneId) {
        const archivePath = join(
          gsdRoot(s.basePath),
          `completed-units-${s.currentMilestoneId}.json`
        );
        cpSync(completedKeysPath, archivePath);
      }
      atomicWriteSync(completedKeysPath, JSON.stringify([], null, 2));
    } catch (e) {
      logWarning("engine", "Failed to archive completed-units on milestone transition", { error: String(e) });
    }
    try {
      await deps.rebuildState(s.basePath);
    } catch (e) {
      logWarning("engine", "STATE.md rebuild failed after milestone transition", { error: String(e) });
    }
  }
  if (mid) {
    s.currentMilestoneId = mid;
    deps.setActiveMilestoneId(s.basePath, mid);
  }
  if (!mid) {
    if (s.currentUnit) {
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        s.currentUnit.type,
        s.currentUnit.id,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id)
      );
    }
    const incomplete = state.registry.filter(
      (m) => m.status !== "complete" && m.status !== "parked"
    );
    if (incomplete.length === 0 && state.registry.length > 0) {
      if (s.currentMilestoneId) {
        const stop = await _runMilestoneMergeOnceWithStashRestore(ic, s.currentMilestoneId);
        if (stop) return stop;
      }
      deps.sendDesktopNotification(
        "GSD",
        "All milestones complete!",
        "success",
        "milestone",
        basename(s.originalBasePath || s.basePath)
      );
      deps.logCmuxEvent(
        prefs,
        "All milestones complete.",
        "success"
      );
      await deps.stopAuto(ctx, pi, "All milestones complete", {
        completionWidget: {
          milestoneId: s.currentMilestoneId,
          milestoneTitle: midTitle,
          allMilestonesComplete: true
        }
      });
    } else if (incomplete.length === 0 && state.registry.length === 0) {
      const diag = `basePath=${s.basePath}, phase=${state.phase}`;
      ctx.ui.notify(
        `No milestones visible in current scope. Possible path resolution issue.
   Diagnostic: ${diag}`,
        "error"
      );
      await deps.stopAuto(
        ctx,
        pi,
        `No milestones found \u2014 check basePath resolution`
      );
    } else if (state.phase === "blocked") {
      const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
      await deps.pauseAuto(ctx, pi);
      ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto to resume.`, "warning");
      deps.sendDesktopNotification("GSD", blockerMsg, "warning", "attention", basename(s.originalBasePath || s.basePath));
      deps.logCmuxEvent(prefs, blockerMsg, "warning");
    } else {
      const ids = incomplete.map((m) => m.id).join(", ");
      const diag = `basePath=${s.basePath}, milestones=[${state.registry.map((m) => `${m.id}:${m.status}`).join(", ")}], phase=${state.phase}`;
      ctx.ui.notify(
        `Unexpected: ${incomplete.length} incomplete milestone(s) (${ids}) but no active milestone.
   Diagnostic: ${diag}`,
        "error"
      );
      await deps.stopAuto(
        ctx,
        pi,
        `No active milestone \u2014 ${incomplete.length} incomplete (${ids}), see diagnostic above`
      );
    }
    debugLog("autoLoop", { phase: "exit", reason: "no-active-milestone" });
    deps.emitJournalEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "no-active-milestone" } });
    return { action: "break", reason: "no-active-milestone" };
  }
  if (!midTitle) {
    midTitle = mid;
    ctx.ui.notify(
      `Milestone ${mid} has no title in roadmap \u2014 using ID as fallback.`,
      "warning"
    );
  }
  const mergeReconcileResult = deps.reconcileMergeState(s.basePath, ctx);
  if (mergeReconcileResult === "blocked") {
    await deps.pauseAuto(ctx, pi);
    debugLog("autoLoop", { phase: "exit", reason: "merge-reconciliation-blocked" });
    return { action: "break", reason: "merge-reconciliation-blocked" };
  }
  if (mergeReconcileResult === "reconciled") {
    deps.invalidateAllCaches();
    state = await deps.deriveState(s.canonicalProjectRoot);
    mid = state.activeMilestone?.id;
    midTitle = state.activeMilestone?.title;
  }
  if (!mid || !midTitle) {
    const noMilestoneReason = !mid ? "No active milestone after merge reconciliation" : `Milestone ${mid} has no title after reconciliation`;
    await closeoutAndStop(ctx, pi, s, deps, noMilestoneReason);
    debugLog("autoLoop", {
      phase: "exit",
      reason: "no-milestone-after-reconciliation"
    });
    return { action: "break", reason: "no-milestone-after-reconciliation" };
  }
  if (state.phase === "complete") {
    if (s.currentMilestoneId) {
      const stop = await _runMilestoneMergeOnceWithStashRestore(ic, s.currentMilestoneId);
      if (stop) return stop;
    }
    deps.sendDesktopNotification(
      "GSD",
      `Milestone ${mid} complete!`,
      "success",
      "milestone",
      basename(s.originalBasePath || s.basePath)
    );
    deps.logCmuxEvent(
      prefs,
      `Milestone ${mid} complete.`,
      "success"
    );
    if (s.currentUnit) {
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        s.currentUnit.type,
        s.currentUnit.id,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id)
      );
      s.currentUnit = null;
    }
    await deps.stopAuto(ctx, pi, `Milestone ${mid} complete`, {
      completionWidget: {
        milestoneId: mid,
        milestoneTitle: midTitle
      }
    });
    debugLog("autoLoop", { phase: "exit", reason: "milestone-complete" });
    deps.emitJournalEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "milestone-complete", milestoneId: mid } });
    return { action: "break", reason: "milestone-complete" };
  }
  if (state.phase === "blocked") {
    const blockerMsg = `Blocked: ${state.blockers.join(", ")}`;
    if (s.currentUnit) {
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        s.currentUnit.type,
        s.currentUnit.id,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id)
      );
    }
    await deps.pauseAuto(ctx, pi);
    ctx.ui.notify(`${blockerMsg}. Fix and run /gsd auto to resume.`, "warning");
    deps.sendDesktopNotification("GSD", blockerMsg, "warning", "attention", basename(s.originalBasePath || s.basePath));
    deps.logCmuxEvent(prefs, blockerMsg, "warning");
    debugLog("autoLoop", { phase: "exit", reason: "blocked" });
    deps.emitJournalEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "terminal", data: { reason: "blocked", blockers: state.blockers } });
    return { action: "break", reason: "blocked" };
  }
  return { action: "next", data: { state, mid, midTitle } };
}
async function runDispatch(ic, preData, loopState) {
  const { ctx, pi, s, deps, prefs } = ic;
  const { state, mid, midTitle } = preData;
  const STUCK_WINDOW_SIZE = 6;
  const provider = ctx.model?.provider;
  const authMode = provider && typeof ctx.modelRegistry?.getProviderAuthMode === "function" ? ctx.modelRegistry.getProviderAuthMode(provider) : void 0;
  const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
  const structuredQuestionsAvailable = prefs?.planning_depth === "deep" ? "false" : supportsStructuredQuestions(activeTools, {
    authMode,
    baseUrl: ctx.model?.baseUrl
  }) ? "true" : "false";
  debugLog("autoLoop", { phase: "dispatch-resolve", iteration: ic.iteration });
  const dispatchResult = await deps.resolveDispatch({
    basePath: s.basePath,
    mid,
    midTitle,
    state,
    prefs,
    session: s,
    structuredQuestionsAvailable,
    sessionContextWindow: ctx.model?.contextWindow,
    sessionProvider: ctx.model?.provider,
    modelRegistry: ctx.modelRegistry
  });
  if (dispatchResult.action === "stop") {
    deps.emitJournalEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-stop", rule: dispatchResult.matchedRule, data: { reason: dispatchResult.reason } });
    if (dispatchResult.level === "warning") {
      ctx.ui.notify(dispatchResult.reason, "warning");
      await deps.pauseAuto(ctx, pi, {
        message: dispatchResult.reason,
        category: "unknown"
      });
    } else {
      await closeoutAndStop(ctx, pi, s, deps, dispatchResult.reason);
    }
    debugLog("autoLoop", { phase: "exit", reason: "dispatch-stop" });
    return { action: "break", reason: "dispatch-stop" };
  }
  if (dispatchResult.action !== "dispatch") {
    await new Promise((r) => setImmediate(r));
    return { action: "continue" };
  }
  deps.emitJournalEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "dispatch-match", rule: dispatchResult.matchedRule, data: { unitType: dispatchResult.unitType, unitId: dispatchResult.unitId } });
  let unitType = dispatchResult.unitType;
  let unitId = dispatchResult.unitId;
  let prompt = dispatchResult.prompt;
  const pauseAfterUatDispatch = dispatchResult.pauseAfterDispatch ?? false;
  const preDispatchResult = deps.runPreDispatchHooks(
    unitType,
    unitId,
    prompt,
    s.basePath
  );
  if (preDispatchResult.firedHooks.length > 0) {
    ctx.ui.notify(
      `Pre-dispatch hook${preDispatchResult.firedHooks.length > 1 ? "s" : ""}: ${preDispatchResult.firedHooks.join(", ")}`,
      "info"
    );
    deps.emitJournalEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "pre-dispatch-hook", data: { firedHooks: preDispatchResult.firedHooks, action: preDispatchResult.action } });
  }
  if (preDispatchResult.action === "skip") {
    ctx.ui.notify(
      `Skipping ${unitType} ${unitId} (pre-dispatch hook).`,
      "info"
    );
    await new Promise((r) => setImmediate(r));
    return { action: "continue" };
  }
  if (preDispatchResult.action === "replace") {
    prompt = preDispatchResult.prompt ?? prompt;
    if (preDispatchResult.unitType) unitType = preDispatchResult.unitType;
  } else if (preDispatchResult.prompt) {
    prompt = preDispatchResult.prompt;
  }
  const guardBasePath = _resolveDispatchGuardBasePath(s);
  let mainBranch = "main";
  try {
    mainBranch = deps.getMainBranch(guardBasePath);
  } catch (err) {
    debugLog("autoLoop", { phase: "getMainBranch-failed", error: String(err) });
  }
  const priorSliceBlocker = deps.getPriorSliceCompletionBlocker(
    guardBasePath,
    mainBranch,
    unitType,
    unitId
  );
  if (priorSliceBlocker) {
    await deps.stopAuto(ctx, pi, priorSliceBlocker);
    debugLog("autoLoop", { phase: "exit", reason: "prior-slice-blocker" });
    return { action: "break", reason: "prior-slice-blocker" };
  }
  const worktreeSafetyBlock = await validateSourceWriteWorktreeSafety(
    ic,
    unitType,
    unitId,
    mid,
    "pre-dispatch"
  );
  if (worktreeSafetyBlock) return worktreeSafetyBlock;
  const derivedKey = `${unitType}/${unitId}`;
  loopState.recentUnits.push({ key: derivedKey });
  if (loopState.recentUnits.length > STUCK_WINDOW_SIZE) loopState.recentUnits.shift();
  const stuckSignal = detectStuck(loopState.recentUnits);
  if (stuckSignal) {
    debugLog("autoLoop", {
      phase: "stuck-check",
      unitType,
      unitId,
      reason: stuckSignal.reason,
      recoveryAttempts: loopState.stuckRecoveryAttempts
    });
    if (loopState.stuckRecoveryAttempts === 0) {
      loopState.stuckRecoveryAttempts++;
      const artifactExists = verifyExpectedArtifact(
        unitType,
        unitId,
        s.basePath
      );
      if (artifactExists) {
        if (unitType === "complete-milestone") {
          const stuckDiag = diagnoseExpectedArtifact(unitType, unitId, s.basePath);
          const stuckParts = [
            `Detected ${unitType} ${unitId} output on disk, but the same unit is still being derived.`,
            "This usually means the milestone summary exists while the DB row still does not mark the milestone complete."
          ];
          if (stuckDiag) stuckParts.push(`Expected: ${stuckDiag}`);
          ctx.ui.notify(stuckParts.join(" "), "warning");
          await deps.pauseAuto(ctx, pi);
          return { action: "break", reason: "complete-milestone-artifact-db-mismatch" };
        }
        debugLog("autoLoop", {
          phase: "stuck-recovery",
          level: 1,
          action: "artifact-found"
        });
        const recoveryDb = refreshRecoveryDbForArtifact(unitType, unitId);
        if (!recoveryDb.ok) {
          ctx.ui.notify(
            recoveryDb.fatal ? `${recoveryDb.message} Pausing auto-mode for manual recovery.` : `${recoveryDb.message} Keeping stuck state for retry.`,
            "warning"
          );
          if (recoveryDb.fatal) {
            await deps.pauseAuto(ctx, pi);
            return { action: "break", reason: recoveryDb.reason };
          }
          return { action: "continue" };
        }
        ctx.ui.notify(
          `Stuck recovery: artifact for ${unitType} ${unitId} found on disk. Invalidating caches.`,
          "info"
        );
        deps.invalidateAllCaches();
        loopState.recentUnits.length = 0;
        loopState.stuckRecoveryAttempts = 0;
        return { action: "continue" };
      }
      ctx.ui.notify(
        `Stuck on ${unitType} ${unitId} (${stuckSignal.reason}). Invalidating caches and retrying.`,
        "warning"
      );
      deps.invalidateAllCaches();
    } else {
      deps.invalidateAllCaches();
      const artifactExists = verifyExpectedArtifact(
        unitType,
        unitId,
        s.basePath
      );
      if (artifactExists && unitType !== "complete-milestone") {
        debugLog("autoLoop", {
          phase: "stuck-recovery",
          level: 2,
          action: "artifact-found"
        });
        const recoveryDb = refreshRecoveryDbForArtifact(unitType, unitId);
        if (recoveryDb.ok) {
          ctx.ui.notify(
            `Stuck recovery: artifact for ${unitType} ${unitId} found on disk after cache invalidation. Continuing.`,
            "info"
          );
          loopState.recentUnits.length = 0;
          loopState.stuckRecoveryAttempts = 0;
          return { action: "continue" };
        }
        ctx.ui.notify(
          recoveryDb.fatal ? `${recoveryDb.message} Pausing auto-mode for manual recovery.` : `${recoveryDb.message} Stopping for manual recovery.`,
          "warning"
        );
        if (recoveryDb.fatal) {
          await deps.pauseAuto(ctx, pi);
          return { action: "break", reason: recoveryDb.reason };
        }
      }
      debugLog("autoLoop", {
        phase: "stuck-detected",
        unitType,
        unitId,
        reason: stuckSignal.reason
      });
      const stuckDiag = diagnoseExpectedArtifact(unitType, unitId, s.basePath);
      const stuckRemediation = buildLoopRemediationSteps(unitType, unitId, s.basePath);
      const stuckParts = [`Stuck on ${unitType} ${unitId} \u2014 ${stuckSignal.reason}.`];
      if (stuckDiag) stuckParts.push(`Expected: ${stuckDiag}`);
      if (stuckRemediation) stuckParts.push(`To recover:
${stuckRemediation}`);
      ctx.ui.notify(stuckParts.join(" "), "error");
      await deps.stopAuto(
        ctx,
        pi,
        `Stuck: ${stuckSignal.reason}`
      );
      return { action: "break", reason: "stuck-detected" };
    }
  } else {
    if (loopState.stuckRecoveryAttempts > 0) {
      debugLog("autoLoop", {
        phase: "stuck-counter-reset",
        from: loopState.recentUnits[loopState.recentUnits.length - 2]?.key ?? "",
        to: derivedKey
      });
      loopState.stuckRecoveryAttempts = 0;
    }
  }
  return {
    action: "next",
    data: {
      unitType,
      unitId,
      prompt,
      finalPrompt: prompt,
      pauseAfterUatDispatch,
      state,
      mid,
      midTitle,
      isRetry: false,
      previousTier: void 0,
      hookModelOverride: preDispatchResult.model
    }
  };
}
async function runGuards(ic, mid) {
  const { ctx, pi, s, deps, prefs } = ic;
  try {
    const { loadStopCaptures, markCaptureExecuted } = await import("../captures.js");
    const stopCaptures = loadStopCaptures(s.basePath);
    if (stopCaptures.length > 0) {
      const first = stopCaptures[0];
      const isBacktrack = first.classification === "backtrack";
      const label = isBacktrack ? `Backtrack directive: ${first.text}` : `Stop directive: ${first.text}`;
      ctx.ui.notify(label, "warning");
      deps.sendDesktopNotification(
        "GSD",
        label,
        "warning",
        "stop-directive",
        basename(s.originalBasePath || s.basePath)
      );
      await deps.pauseAuto(ctx, pi);
      if (isBacktrack) {
        try {
          const { executeBacktrack } = await import("../triage-resolution.js");
          executeBacktrack(s.basePath, mid, first);
        } catch (e) {
          debugLog("guards", { phase: "backtrack-execution-error", error: String(e) });
        }
      }
      for (const cap of stopCaptures) {
        markCaptureExecuted(s.basePath, cap.id);
      }
      debugLog("autoLoop", { phase: "exit", reason: isBacktrack ? "user-backtrack" : "user-stop" });
      return { action: "break", reason: isBacktrack ? "user-backtrack" : "user-stop" };
    }
  } catch (e) {
    debugLog("guards", { phase: "stop-guard-error", error: String(e) });
    return { action: "break", reason: "stop-guard-error" };
  }
  const budgetCeiling = prefs?.budget_ceiling;
  if (budgetCeiling !== void 0 && budgetCeiling > 0) {
    const currentLedger = deps.getLedger();
    let costUnits = currentLedger?.units;
    if (process.env.GSD_PARALLEL_WORKER && s.autoStartTime && Array.isArray(costUnits)) {
      const sessionStartISO = new Date(s.autoStartTime).toISOString();
      costUnits = costUnits.filter(
        (u) => u.startedAt != null && u.startedAt >= sessionStartISO
      );
    }
    const totalCost = costUnits ? deps.getProjectTotals(costUnits).cost : 0;
    const budgetPct = totalCost / budgetCeiling;
    const budgetAlertLevel = deps.getBudgetAlertLevel(budgetPct);
    const newBudgetAlertLevel = deps.getNewBudgetAlertLevel(
      s.lastBudgetAlertLevel,
      budgetPct
    );
    const enforcement = prefs?.budget_enforcement ?? "pause";
    const budgetEnforcementAction = deps.getBudgetEnforcementAction(
      enforcement,
      budgetPct
    );
    const threshold = BUDGET_THRESHOLDS.find(
      (t) => newBudgetAlertLevel >= t.pct
    );
    if (threshold) {
      s.lastBudgetAlertLevel = newBudgetAlertLevel;
      let hookAction;
      try {
        const { emitBudgetThreshold } = await import("../hook-emitter.js");
        const hookResult = await emitBudgetThreshold({
          fraction: budgetPct,
          spent: totalCost,
          limit: budgetCeiling
        });
        if (hookResult?.action) hookAction = hookResult.action;
      } catch (hookErr) {
        logWarning("engine", `budget_threshold hook emission failed: ${hookErr.message}`);
      }
      let effectiveAction = budgetEnforcementAction;
      if (hookAction === "continue") {
        effectiveAction = "none";
      } else if (hookAction === "pause") {
        effectiveAction = "pause";
      } else if (hookAction === "downgrade") {
        effectiveAction = "warn";
      }
      if (threshold.pct === 100 && effectiveAction !== "none") {
        const msg = `Budget ceiling ${deps.formatCost(budgetCeiling)} reached (spent ${deps.formatCost(totalCost)}).`;
        if (effectiveAction === "halt") {
          deps.sendDesktopNotification("GSD", msg, "error", "budget", basename(s.originalBasePath || s.basePath));
          await deps.stopAuto(ctx, pi, "Budget ceiling reached");
          debugLog("autoLoop", { phase: "exit", reason: "budget-halt" });
          return { action: "break", reason: "budget-halt" };
        }
        if (effectiveAction === "pause") {
          ctx.ui.notify(
            `${msg} Pausing auto-mode \u2014 /gsd auto to override and continue.`,
            "warning"
          );
          deps.sendDesktopNotification("GSD", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
          deps.logCmuxEvent(prefs, msg, "warning");
          await deps.pauseAuto(ctx, pi);
          debugLog("autoLoop", { phase: "exit", reason: "budget-pause" });
          return { action: "break", reason: "budget-pause" };
        }
        ctx.ui.notify(`${msg} Continuing (enforcement: warn).`, "warning");
        deps.sendDesktopNotification("GSD", msg, "warning", "budget", basename(s.originalBasePath || s.basePath));
        deps.logCmuxEvent(prefs, msg, "warning");
      } else if (threshold.pct < 100) {
        const msg = `${threshold.label}: ${deps.formatCost(totalCost)} / ${deps.formatCost(budgetCeiling)}`;
        ctx.ui.notify(msg, threshold.notifyLevel);
        deps.sendDesktopNotification(
          "GSD",
          msg,
          threshold.notifyLevel,
          "budget",
          basename(s.originalBasePath || s.basePath)
        );
        deps.logCmuxEvent(prefs, msg, threshold.cmuxLevel);
      }
    } else if (budgetAlertLevel === 0) {
      s.lastBudgetAlertLevel = 0;
    }
  } else {
    s.lastBudgetAlertLevel = 0;
  }
  const contextThreshold = prefs?.context_pause_threshold ?? 0;
  if (contextThreshold > 0 && s.cmdCtx) {
    const contextUsage = s.cmdCtx.getContextUsage();
    if (contextUsage && contextUsage.percent !== null && contextUsage.percent >= contextThreshold) {
      const msg = `Context window at ${contextUsage.percent}% (threshold: ${contextThreshold}%). Pausing to prevent truncated output.`;
      ctx.ui.notify(
        `${msg} Run /gsd auto to continue (will start fresh session).`,
        "warning"
      );
      deps.sendDesktopNotification(
        "GSD",
        `Context ${contextUsage.percent}% \u2014 paused`,
        "warning",
        "attention",
        basename(s.originalBasePath || s.basePath)
      );
      await deps.pauseAuto(ctx, pi);
      debugLog("autoLoop", { phase: "exit", reason: "context-window" });
      return { action: "break", reason: "context-window" };
    }
  }
  try {
    const manifestStatus = await deps.getManifestStatus(s.basePath, mid, s.originalBasePath);
    if (manifestStatus && manifestStatus.pending.length > 0) {
      const result = await deps.collectSecretsFromManifest(
        s.basePath,
        mid,
        ctx
      );
      if (result && result.applied && result.skipped && result.existingSkipped) {
        ctx.ui.notify(
          `Secrets collected: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.existingSkipped.length} already set.`,
          "info"
        );
      } else {
        ctx.ui.notify("Secrets collection skipped.", "info");
      }
    }
  } catch (err) {
    ctx.ui.notify(
      `Secrets collection error: ${err instanceof Error ? err.message : String(err)}. Continuing with next task.`,
      "warning"
    );
  }
  return { action: "next", data: void 0 };
}
async function runUnitPhase(ic, iterData, loopState, sidecarItem) {
  const { ctx, pi, s, deps, prefs } = ic;
  const { unitType, unitId, prompt, state, mid } = iterData;
  debugLog("autoLoop", {
    phase: "unit-execution",
    iteration: ic.iteration,
    unitType,
    unitId
  });
  const worktreeSafetyBlock = await validateSourceWriteWorktreeSafety(
    ic,
    unitType,
    unitId,
    mid,
    "unit-execution"
  );
  if (worktreeSafetyBlock) return worktreeSafetyBlock;
  let projectClassification = null;
  if (s.basePath && unitType === "execute-task") {
    projectClassification = classifyProject(s.basePath);
    if (projectClassification.kind === "invalid-repo") {
      const msg = `Worktree health check failed: ${s.basePath} classified as invalid-repo (${projectClassification.reason}) \u2014 refusing to dispatch ${unitType} ${unitId}`;
      debugLog("runUnitPhase", { phase: "worktree-health-invalid-repo", basePath: s.basePath, classification: projectClassification });
      const hasGit = deps.existsSync(join(s.basePath, ".git"));
      if (_shouldProceedWithInvalidRepoClassificationForTest(projectClassification.reason, hasGit)) {
        ctx.ui.notify(
          `Warning: ${s.basePath} project classification could not confirm .git; assuming it has no project content yet \u2014 proceeding as greenfield project because worktree health reported .git present`,
          "warning"
        );
      } else {
        ctx.ui.notify(msg, "error");
        await deps.stopAuto(ctx, pi, msg);
        return { action: "break", reason: "worktree-invalid" };
      }
    }
    if (projectClassification.kind === "greenfield") {
      debugLog("runUnitPhase", { phase: "worktree-health-greenfield", basePath: s.basePath, classification: projectClassification });
      ctx.ui.notify(`Warning: ${s.basePath} has no project content yet \u2014 proceeding as greenfield project`, "warning");
    } else if (projectClassification.kind === "untyped-existing") {
      debugLog("runUnitPhase", { phase: "worktree-health-untyped-existing", basePath: s.basePath, classification: projectClassification });
      ctx.ui.notify(
        `Notice: ${s.basePath} has existing project content but no recognized tooling markers \u2014 using generic file-level workflow guidance`,
        "info"
      );
    }
  }
  const isRetry = !!(s.currentUnit && s.currentUnit.type === unitType && s.currentUnit.id === unitId);
  const previousTier = s.currentUnitRouting?.tier;
  _resetLogs();
  const dispatchKey = `${unitType}/${unitId}`;
  s.unitDispatchCount.set(dispatchKey, (s.unitDispatchCount.get(dispatchKey) ?? 0) + 1);
  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  s.lastGitActionFailure = null;
  s.lastGitActionStatus = null;
  s.lastUnitAgentEndMessages = null;
  setCurrentPhase(unitType, {
    basePath: s.basePath,
    traceId: ic.flowId,
    turnId: `iter-${ic.iteration}`,
    causedBy: "unit-start"
  });
  s.lastToolInvocationError = null;
  const unitStartSeq = ic.nextSeq();
  deps.emitJournalEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), flowId: ic.flowId, seq: unitStartSeq, eventType: "unit-start", data: { unitType, unitId } });
  deps.captureAvailableSkills();
  writeUnitRuntimeRecord(
    s.basePath,
    unitType,
    unitId,
    s.currentUnit.startedAt,
    {
      phase: "dispatched",
      wrapupWarningSent: false,
      timeoutAt: null,
      lastProgressAt: s.currentUnit.startedAt,
      progressCount: 0,
      lastProgressKind: "dispatch",
      recoveryAttempts: 0
      // Reset so re-dispatched units get full recovery budget (#2322)
    }
  );
  ctx.ui.setStatus("gsd-auto", "auto");
  if (mid)
    deps.updateSliceProgressCache(s.basePath, mid, state.activeSlice?.id);
  const safetyConfig = resolveSafetyHarnessConfig(
    prefs?.safety_harness
  );
  if (safetyConfig.enabled && safetyConfig.evidence_collection) {
    resetEvidence();
    if (s.basePath && unitType === "execute-task") {
      const { milestone: eMid, slice: eSid, task: eTid } = parseUnitId(unitId);
      if (eMid && eSid && eTid) {
        loadEvidenceFromDisk(s.basePath, eMid, eSid, eTid);
      }
    }
  }
  if (safetyConfig.enabled && safetyConfig.checkpoints && unitType === "execute-task") {
    s.checkpointSha = createCheckpoint(s.basePath, unitId);
    if (s.checkpointSha) {
      debugLog("runUnitPhase", { phase: "checkpoint-created", unitId, sha: s.checkpointSha.slice(0, 8) });
    }
  }
  let finalPrompt = prompt;
  if (unitType === "execute-task") {
    projectClassification ??= classifyProject(s.basePath);
    if (projectClassification.kind === "untyped-existing") {
      const samples = projectClassification.contentFiles.slice(0, 8).join(", ") || "project files";
      finalPrompt += `

**Project classification:** Existing untyped project. No recognized build/tooling markers were detected, so use generic file-level workflow guidance. Task plans and completion summaries must list every concrete project file changed in \`files\` or \`expected_output\`. Detected content sample: ${samples}.`;
    }
  }
  if (s.pendingVerificationRetry) {
    const retryCtx = s.pendingVerificationRetry;
    s.pendingVerificationRetry = null;
    const capped = retryCtx.failureContext.length > MAX_RECOVERY_CHARS ? retryCtx.failureContext.slice(0, MAX_RECOVERY_CHARS) + "\n\n[...failure context truncated]" : retryCtx.failureContext;
    finalPrompt = `**VERIFICATION FAILED \u2014 AUTO-FIX ATTEMPT ${retryCtx.attempt}**

The verification gate ran after your previous attempt and found failures. Fix these issues before completing the task.

${capped}

---

${finalPrompt}`;
  }
  if (s.pendingCrashRecovery) {
    const capped = s.pendingCrashRecovery.length > MAX_RECOVERY_CHARS ? s.pendingCrashRecovery.slice(0, MAX_RECOVERY_CHARS) + "\n\n[...recovery briefing truncated to prevent memory exhaustion]" : s.pendingCrashRecovery;
    finalPrompt = `${capped}

---

${finalPrompt}`;
    s.pendingCrashRecovery = null;
  } else if ((s.unitDispatchCount.get(dispatchKey) ?? 0) > 1) {
    const diagnostic = deps.getDeepDiagnostic(s.basePath);
    if (diagnostic) {
      const cappedDiag = diagnostic.length > MAX_RECOVERY_CHARS ? diagnostic.slice(0, MAX_RECOVERY_CHARS) + "\n\n[...diagnostic truncated to prevent memory exhaustion]" : diagnostic;
      finalPrompt = `**RETRY \u2014 your previous attempt did not produce the required artifact.**

Diagnostic from previous attempt:
${cappedDiag}

Fix whatever went wrong and make sure you write the required file this time.

---

${finalPrompt}`;
    }
  }
  s.lastPromptCharCount = finalPrompt.length;
  s.lastBaselineCharCount = void 0;
  if (deps.isDbAvailable()) {
    try {
      const { inlineGsdRootFile } = await importExtensionModule(import.meta.url, "../auto-prompts.js");
      const [decisionsContent, requirementsContent, projectContent] = await Promise.all([
        inlineGsdRootFile(s.basePath, "decisions.md", "Decisions"),
        inlineGsdRootFile(s.basePath, "requirements.md", "Requirements"),
        inlineGsdRootFile(s.basePath, "project.md", "Project")
      ]);
      s.lastBaselineCharCount = (decisionsContent?.length ?? 0) + (requirementsContent?.length ?? 0) + (projectContent?.length ?? 0);
    } catch (e) {
      logWarning("engine", "Baseline char count measurement failed", { error: String(e) });
    }
  }
  try {
    finalPrompt = deps.reorderForCaching(finalPrompt);
  } catch (reorderErr) {
    const msg = reorderErr instanceof Error ? reorderErr.message : String(reorderErr);
    logWarning("engine", "Prompt reorder failed", { error: msg });
  }
  const modelResult = await deps.selectAndApplyModel(
    ctx,
    pi,
    unitType,
    unitId,
    s.basePath,
    prefs,
    s.verbose,
    s.autoModeStartModel,
    sidecarItem ? void 0 : { isRetry, previousTier },
    void 0,
    s.manualSessionModelOverride,
    s.autoModeStartThinkingLevel
  );
  s.currentUnitRouting = modelResult.routing;
  s.currentUnitModel = modelResult.appliedModel;
  const hookModelOverride = sidecarItem?.model ?? iterData.hookModelOverride;
  if (hookModelOverride) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const match = deps.resolveModelId(hookModelOverride, availableModels, ctx.model?.provider);
    if (match) {
      const ok = await pi.setModel(match, { persist: false });
      if (ok) {
        if (s.autoModeStartThinkingLevel) {
          pi.setThinkingLevel(s.autoModeStartThinkingLevel);
        }
        s.currentUnitModel = match;
        ctx.ui.notify(`Hook model override: ${match.provider}/${match.id}`, "info");
      } else {
        ctx.ui.notify(
          `Hook model "${hookModelOverride}" found but setModel failed. Using default.`,
          "warning"
        );
      }
    } else {
      ctx.ui.notify(
        `Hook model "${hookModelOverride}" not found in available models. Falling back to current session model. Ensure the model is defined in models.json and has auth configured.`,
        "warning"
      );
    }
  }
  s.currentDispatchedModelId = s.currentUnitModel ? `${s.currentUnitModel.provider ?? ""}/${s.currentUnitModel.id ?? ""}` : null;
  const compatibilityError = getWorkflowTransportSupportError(
    s.currentUnitModel?.provider ?? ctx.model?.provider,
    getRequiredWorkflowToolsForAutoUnit(unitType),
    {
      projectRoot: s.basePath,
      surface: "auto-mode",
      unitType,
      authMode: s.currentUnitModel?.provider ? ctx.modelRegistry.getProviderAuthMode(s.currentUnitModel.provider) : ctx.model?.provider ? ctx.modelRegistry.getProviderAuthMode(ctx.model.provider) : void 0,
      baseUrl: s.currentUnitModel?.baseUrl ?? ctx.model?.baseUrl
    }
  );
  if (compatibilityError) {
    ctx.ui.notify(compatibilityError, "error");
    await deps.stopAuto(ctx, pi, compatibilityError);
    return { action: "break", reason: "workflow-capability" };
  }
  deps.updateProgressWidget(ctx, unitType, unitId, state);
  deps.ensurePreconditions(unitType, unitId, s.basePath, state);
  deps.clearUnitTimeout();
  deps.startUnitSupervision({
    s,
    ctx,
    pi,
    unitType,
    unitId,
    prefs,
    buildSnapshotOpts: () => deps.buildSnapshotOpts(unitType, unitId),
    buildRecoveryContext: () => ({
      basePath: s.basePath,
      verbose: s.verbose,
      currentUnitStartedAt: s.currentUnit?.startedAt ?? Date.now(),
      unitRecoveryCount: s.unitRecoveryCount
    }),
    pauseAuto: deps.pauseAuto
  });
  deps.writeLock(
    deps.lockBase(),
    unitType,
    unitId
  );
  debugLog("autoLoop", {
    phase: "runUnit-start",
    iteration: ic.iteration,
    unitType,
    unitId
  });
  const unitResult = await runUnit(
    ctx,
    pi,
    s,
    unitType,
    unitId,
    finalPrompt
  );
  s.lastUnitAgentEndMessages = unitResult.event?.messages ?? null;
  debugLog("autoLoop", {
    phase: "runUnit-end",
    iteration: ic.iteration,
    unitType,
    unitId,
    status: unitResult.status
  });
  if (unitResult.status === "completed" && s.currentUnit && (unitResult.event?.messages?.length ?? 0) === 0 && isSuspiciousGhostCompletion(ctx, unitResult.requestDispatchedAt ?? s.currentUnit.startedAt)) {
    const message = `${unitType} ${unitId} completed without assistant output or tool calls; treating as a stale ghost completion.`;
    debugLog("autoLoop", {
      phase: "ghost-completion",
      iteration: ic.iteration,
      unitType,
      unitId,
      elapsedMs: Date.now() - (unitResult.requestDispatchedAt ?? s.currentUnit.startedAt)
    });
    logWarning("engine", message);
    ctx.ui.notify(`${message} Pausing auto-mode before closeout side effects.`, "warning");
    await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, {
      message,
      category: "unknown",
      isTransient: true
    });
    s.currentUnit = null;
    await deps.pauseAuto(ctx, pi);
    return { action: "break", reason: "ghost-completion" };
  }
  const sessionFile = deps.getSessionFile(ctx);
  deps.updateSessionLock(
    deps.lockBase(),
    unitType,
    unitId,
    sessionFile
  );
  deps.writeLock(
    deps.lockBase(),
    unitType,
    unitId,
    sessionFile
  );
  const lastEntry = loopState.recentUnits[loopState.recentUnits.length - 1];
  if (lastEntry) {
    if (unitResult.errorContext) {
      lastEntry.error = `${unitResult.errorContext.category}:${unitResult.errorContext.message}`.slice(0, 200);
    } else if (unitResult.status === "error" || unitResult.status === "cancelled") {
      lastEntry.error = `${unitResult.status}:${unitType}/${unitId}`;
    } else if (unitResult.event?.messages?.length) {
      const lastMsg = unitResult.event.messages[unitResult.event.messages.length - 1];
      const msgStr = typeof lastMsg === "string" ? lastMsg : JSON.stringify(lastMsg);
      if (/error|fail|exception/i.test(msgStr)) {
        lastEntry.error = msgStr.slice(0, 200);
      }
    }
  }
  if (unitResult.status === "cancelled") {
    const errorCategory = unitResult.errorContext?.category;
    if (errorCategory === "provider") {
      if (!s.paused) {
        const detail = unitResult.errorContext?.message ?? `Provider unavailable for ${unitType} ${unitId}`;
        await pauseAutoForProviderError(
          ctx.ui,
          detail,
          () => deps.pauseAuto(ctx, pi),
          {
            isRateLimit: false,
            isTransient: Boolean(unitResult.errorContext?.isTransient),
            retryAfterMs: unitResult.errorContext?.retryAfterMs
          }
        );
      }
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      debugLog("autoLoop", { phase: "exit", reason: "provider-pause", isTransient: unitResult.errorContext?.isTransient });
      return { action: "break", reason: "provider-pause" };
    }
    if (unitResult.errorContext?.isTransient && errorCategory === "timeout") {
      const isSessionCreationTimeout = unitResult.errorContext.message?.includes("Session creation timed out");
      if (isSessionCreationTimeout) {
        consecutiveSessionTimeouts += 1;
        const baseRetryAfterMs = 3e4;
        const retryAfterMs = baseRetryAfterMs * 2 ** Math.max(0, consecutiveSessionTimeouts - 1);
        const allowAutoResume = consecutiveSessionTimeouts <= MAX_SESSION_TIMEOUT_AUTO_RESUMES;
        if (!allowAutoResume) {
          ctx.ui.notify(
            `Session creation timed out ${consecutiveSessionTimeouts} consecutive times for ${unitType} ${unitId}. Pausing for manual review.`,
            "warning"
          );
        }
        debugLog("autoLoop", {
          phase: "session-timeout-pause",
          unitType,
          unitId,
          consecutiveSessionTimeouts,
          retryAfterMs,
          allowAutoResume
        });
        const errorDetail = ` for ${unitType} ${unitId}`;
        await pauseAutoForProviderError(
          ctx.ui,
          errorDetail,
          () => deps.pauseAuto(ctx, pi),
          {
            isRateLimit: false,
            isTransient: allowAutoResume,
            retryAfterMs,
            resume: allowAutoResume ? () => {
              void resumeAutoAfterProviderDelay(pi, ctx).catch((err) => {
                const message = err instanceof Error ? err.message : String(err);
                ctx.ui.notify(
                  `Session timeout recovery failed: ${message}`,
                  "error"
                );
              });
            } : void 0
          }
        );
        await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
        await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
        return { action: "break", reason: "session-timeout" };
      }
      ctx.ui.notify(
        `Unit timed out for ${unitType} ${unitId} (supervision may have failed). Pausing auto-mode.`,
        "warning"
      );
      debugLog("autoLoop", { phase: "unit-hard-timeout-pause", unitType, unitId });
      await deps.pauseAuto(ctx, pi);
      await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      return { action: "break", reason: "unit-hard-timeout" };
    }
    if (unitResult.errorContext?.isTransient && errorCategory === "session-failed") {
      ctx.ui.notify(
        `Session creation failed transiently for ${unitType} ${unitId}: ${unitResult.errorContext?.message ?? "unknown"}. Pausing auto-mode (recoverable).`,
        "warning"
      );
      debugLog("autoLoop", { phase: "session-start-transient-pause", unitType, unitId, category: errorCategory });
      await deps.pauseAuto(ctx, pi);
      await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      return { action: "break", reason: "session-timeout" };
    }
    if (unitResult.errorContext?.isTransient && errorCategory === "aborted") {
      ctx.ui.notify(
        `Unit ${unitType} ${unitId} was aborted by the user. Pausing auto-mode (recoverable).`,
        "warning"
      );
      debugLog("autoLoop", { phase: "unit-aborted-transient-pause", unitType, unitId, category: errorCategory });
      await deps.pauseAuto(ctx, pi);
      await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
      await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
      return { action: "break", reason: "unit-aborted-pause" };
    }
    if (s.currentUnit) {
      await deps.closeoutUnit(
        ctx,
        s.basePath,
        unitType,
        unitId,
        s.currentUnit.startedAt,
        deps.buildSnapshotOpts(unitType, unitId)
      );
    }
    await deps.autoCommitUnit?.(s.basePath, unitType, unitId, ctx);
    await emitCancelledUnitEnd(ic, unitType, unitId, unitStartSeq, unitResult.errorContext);
    const cancelledStop = _buildCancelledUnitStopReason(
      unitType,
      unitId,
      unitResult.errorContext
    );
    ctx.ui.notify(cancelledStop.notifyMessage, "warning");
    await deps.stopAuto(ctx, pi, cancelledStop.stopReason);
    debugLog("autoLoop", { phase: "exit", reason: cancelledStop.loopReason });
    return { action: "break", reason: cancelledStop.loopReason };
  }
  if (s.currentUnit) {
    consecutiveSessionTimeouts = 0;
    await deps.closeoutUnit(
      ctx,
      s.basePath,
      unitType,
      unitId,
      s.currentUnit.startedAt,
      deps.buildSnapshotOpts(unitType, unitId)
    );
  }
  {
    const currentLedger = deps.getLedger();
    if (currentLedger?.units) {
      const lastUnit = [...currentLedger.units].reverse().find(
        (u) => u.type === unitType && u.id === unitId && u.startedAt === _resolveCurrentUnitStartedAtForTest(s.currentUnit)
      );
      if (lastUnit && lastUnit.toolCalls === 0) {
        if (USER_DRIVEN_DEEP_UNITS.has(unitType) && isAwaitingUserInput(s.lastUnitAgentEndMessages ?? void 0)) {
          debugLog("runUnitPhase", {
            phase: "zero-tool-calls-awaiting-user-input",
            unitType,
            unitId
          });
        } else {
          debugLog("runUnitPhase", {
            phase: "zero-tool-calls",
            unitType,
            unitId,
            warning: "Unit completed with 0 tool calls \u2014 likely context exhaustion, marking as failed"
          });
          ctx.ui.notify(
            `${unitType} ${unitId} completed with 0 tool calls \u2014 context exhaustion, will retry`,
            "warning"
          );
          return { action: "next", data: { unitStartedAt: _resolveCurrentUnitStartedAtForTest(s.currentUnit), requestDispatchedAt: unitResult.requestDispatchedAt } };
        }
      }
    }
  }
  if (s.currentUnitRouting) {
    deps.recordOutcome(
      unitType,
      s.currentUnitRouting.tier,
      true
      // success assumed; dispatch will re-dispatch if artifact missing
    );
  }
  const skipArtifactVerification = unitType.startsWith("hook/") || unitType === "custom-step";
  const artifactVerified = skipArtifactVerification || verifyExpectedArtifact(unitType, unitId, s.basePath);
  if (artifactVerified) {
    s.unitDispatchCount.delete(dispatchKey);
    s.unitRecoveryCount.delete(`${unitType}/${unitId}`);
  }
  const anchorPhases = /* @__PURE__ */ new Set(["research-milestone", "research-slice", "plan-milestone", "plan-slice"]);
  if (artifactVerified && mid && anchorPhases.has(unitType)) {
    try {
      const { writePhaseAnchor } = await import("../phase-anchor.js");
      writePhaseAnchor(s.basePath, mid, {
        phase: unitType,
        milestoneId: mid,
        generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        intent: `Completed ${unitType} for ${unitId}`,
        decisions: [],
        blockers: [],
        nextSteps: []
      });
    } catch (err) {
      logWarning("engine", `phase anchor failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  deps.emitJournalEvent({ ts: (/* @__PURE__ */ new Date()).toISOString(), flowId: ic.flowId, seq: ic.nextSeq(), eventType: "unit-end", data: { unitType, unitId, status: unitResult.status, artifactVerified, ...unitResult.errorContext ? { errorContext: unitResult.errorContext } : {} }, causedBy: { flowId: ic.flowId, seq: unitStartSeq } });
  if (s.checkpointSha) {
    if (unitResult.status === "error" && safetyConfig.auto_rollback) {
      const rolled = rollbackToCheckpoint(s.basePath, unitId, s.checkpointSha);
      if (rolled) {
        ctx.ui.notify(`Rolled back to pre-unit checkpoint for ${unitId}`, "info");
        debugLog("runUnitPhase", { phase: "checkpoint-rollback", unitId });
      }
    } else if (unitResult.status === "error") {
      ctx.ui.notify(
        `Unit ${unitId} failed. Pre-unit checkpoint available at ${s.checkpointSha.slice(0, 8)}`,
        "warning"
      );
    } else {
      cleanupCheckpoint(s.basePath, unitId);
      debugLog("runUnitPhase", { phase: "checkpoint-cleaned", unitId });
    }
    s.checkpointSha = null;
  }
  return { action: "next", data: { unitStartedAt: _resolveCurrentUnitStartedAtForTest(s.currentUnit), requestDispatchedAt: unitResult.requestDispatchedAt } };
}
async function runFinalize(ic, iterData, loopState, sidecarItem) {
  const { ctx, pi, s, deps } = ic;
  const { pauseAfterUatDispatch } = iterData;
  debugLog("autoLoop", { phase: "finalize", iteration: ic.iteration });
  deps.clearUnitTimeout();
  const postUnitCtx = {
    s,
    ctx,
    pi,
    buildSnapshotOpts: deps.buildSnapshotOpts,
    lockBase: deps.lockBase,
    stopAuto: deps.stopAuto,
    pauseAuto: deps.pauseAuto,
    updateProgressWidget: deps.updateProgressWidget
  };
  const preVerificationOpts = sidecarItem ? sidecarItem.kind === "hook" ? { skipSettleDelay: true, skipWorktreeSync: true, agentEndMessages: s.lastUnitAgentEndMessages ?? void 0 } : { skipSettleDelay: true, agentEndMessages: s.lastUnitAgentEndMessages ?? void 0 } : { agentEndMessages: s.lastUnitAgentEndMessages ?? void 0 };
  const preUnitSnapshot = s.currentUnit ? { type: s.currentUnit.type, id: s.currentUnit.id, startedAt: s.currentUnit.startedAt } : null;
  const preResultGuard = await withTimeout(
    deps.postUnitPreVerification(postUnitCtx, preVerificationOpts),
    FINALIZE_PRE_TIMEOUT_MS,
    "postUnitPreVerification"
  );
  if (preResultGuard.timedOut) {
    return failClosedOnFinalizeTimeout(
      ic,
      iterData,
      loopState,
      "pre",
      preUnitSnapshot?.startedAt ?? Date.now()
    );
  }
  const preResult = preResultGuard.value;
  if (preResult === "dispatched") {
    const dispatchedReason = s.lastGitActionFailure ? "git-closeout-failure" : "pre-verification-dispatched";
    debugLog("autoLoop", {
      phase: "exit",
      reason: dispatchedReason,
      gitError: s.lastGitActionFailure ?? void 0
    });
    return { action: "break", reason: dispatchedReason };
  }
  if (preResult === "retry") {
    if (sidecarItem) {
      debugLog("autoLoop", { phase: "sidecar-artifact-retry-skipped", iteration: ic.iteration });
    } else {
      const retryInfo = s.pendingVerificationRetry;
      deps.emitJournalEvent({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        flowId: ic.flowId,
        seq: ic.nextSeq(),
        eventType: "artifact-verification-retry",
        data: {
          unitType: preUnitSnapshot?.type,
          unitId: retryInfo?.unitId,
          attempt: retryInfo?.attempt
        }
      });
      const retryPolicyResult = await applyVerificationRetryPolicy(
        ic,
        preUnitSnapshot?.type,
        "artifact-verification-retry"
      );
      if (retryPolicyResult) {
        return retryPolicyResult;
      }
      debugLog("autoLoop", { phase: "artifact-verification-retry", iteration: ic.iteration });
      return { action: "continue" };
    }
  }
  if (pauseAfterUatDispatch) {
    ctx.ui.notify(
      "UAT requires human execution. Auto-mode will pause after this unit writes the result file.",
      "info"
    );
    await deps.pauseAuto(ctx, pi);
    debugLog("autoLoop", { phase: "exit", reason: "uat-pause" });
    return { action: "break", reason: "uat-pause" };
  }
  const skipVerification = sidecarItem?.kind === "hook";
  if (!skipVerification) {
    const verificationResult = await deps.runPostUnitVerification(
      { s, ctx, pi },
      deps.pauseAuto
    );
    if (verificationResult === "pause") {
      debugLog("autoLoop", { phase: "exit", reason: "verification-pause" });
      return { action: "break", reason: "verification-pause" };
    }
    if (verificationResult === "retry") {
      if (sidecarItem) {
        debugLog("autoLoop", { phase: "sidecar-verification-retry-skipped", iteration: ic.iteration });
      } else {
        const retryPolicyResult = await applyVerificationRetryPolicy(
          ic,
          iterData.unitType,
          "verification-retry"
        );
        if (retryPolicyResult) {
          return retryPolicyResult;
        }
        debugLog("autoLoop", { phase: "verification-retry", iteration: ic.iteration });
        return { action: "continue" };
      }
    }
  }
  const postResultGuard = await withTimeout(
    deps.postUnitPostVerification(postUnitCtx),
    FINALIZE_POST_TIMEOUT_MS,
    "postUnitPostVerification"
  );
  if (postResultGuard.timedOut) {
    return failClosedOnFinalizeTimeout(
      ic,
      iterData,
      loopState,
      "post",
      preUnitSnapshot?.startedAt ?? Date.now()
    );
  }
  const postResult = postResultGuard.value;
  if (postResult === "stopped") {
    debugLog("autoLoop", {
      phase: "exit",
      reason: "post-verification-stopped"
    });
    return { action: "break", reason: "post-verification-stopped" };
  }
  if (postResult === "step-wizard") {
    debugLog("autoLoop", { phase: "exit", reason: "step-wizard" });
    return { action: "break", reason: "step-wizard" };
  }
  if (preUnitSnapshot?.type === "complete-milestone" && s.currentMilestoneId) {
    const stop = await _runMilestoneMergeOnceWithStashRestore(ic, s.currentMilestoneId);
    if (stop) return stop;
  }
  loopState.consecutiveFinalizeTimeouts = 0;
  if (preUnitSnapshot) {
    writeUnitRuntimeRecord(s.basePath, preUnitSnapshot.type, preUnitSnapshot.id, preUnitSnapshot.startedAt, {
      phase: "finalized",
      lastProgressAt: Date.now(),
      lastProgressKind: "finalize-success"
    });
  }
  s.currentUnit = null;
  clearCurrentPhase();
  if (hasAnyIssues()) {
    const { logs } = drainAndSummarize();
    if (logs.length > 0) {
      const severity = logs.some((e) => e.severity === "error") ? "error" : "warning";
      ctx.ui.notify(formatForNotification(logs), severity);
    }
  }
  return { action: "next", data: void 0 };
}
export {
  _buildCancelledUnitStopReason,
  _resolveCurrentUnitStartedAtForTest,
  _resolveDispatchGuardBasePath,
  _resolveReportBasePath,
  _runMilestoneMergeOnceWithStashRestore,
  _runMilestoneMergeWithStashRestore,
  _shouldProceedWithInvalidRepoClassificationForTest,
  resetSessionTimeoutState,
  runDispatch,
  runFinalize,
  runGuards,
  runPreDispatch,
  runUnitPhase,
  shouldDegradeEmptyWorktreeToProjectRoot,
  shouldRunPlanV2Gate
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvL3BoYXNlcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEF1dG8tbG9vcCBwaXBlbGluZSBwaGFzZXMsIG1lcmdlIGNsb3Nlb3V0LCBhbmQgZmluYWxpemUgaGFuZGxpbmcuXG4vKipcbiAqIGF1dG8vcGhhc2VzLnRzIFx1MjAxNCBQaXBlbGluZSBwaGFzZXMgZm9yIHRoZSBhdXRvLWxvb3AuXG4gKlxuICogQ29udGFpbnM6IHJ1blByZURpc3BhdGNoLCBydW5EaXNwYXRjaCwgcnVuR3VhcmRzLCBydW5Vbml0UGhhc2UsIHJ1bkZpbmFsaXplLFxuICogcGx1cyBpbnRlcm5hbCBoZWxwZXJzIGdlbmVyYXRlTWlsZXN0b25lUmVwb3J0IGFuZCBjbG9zZW91dEFuZFN0b3AuXG4gKlxuICogSW1wb3J0cyBmcm9tOiBhdXRvL3R5cGVzLCBhdXRvL2RldGVjdC1zdHVjaywgYXV0by9ydW4tdW5pdCwgYXV0by9sb29wLWRlcHNcbiAqL1xuXG5pbXBvcnQgeyBpbXBvcnRFeHRlbnNpb25Nb2R1bGUsIHR5cGUgRXh0ZW5zaW9uQVBJLCB0eXBlIEV4dGVuc2lvbkNvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHR5cGUgeyBBdXRvU2Vzc2lvbiwgU2lkZWNhckl0ZW0gfSBmcm9tIFwiLi9zZXNzaW9uLmpzXCI7XG5pbXBvcnQgdHlwZSB7IExvb3BEZXBzIH0gZnJvbSBcIi4vbG9vcC1kZXBzLmpzXCI7XG5pbXBvcnQge1xuICBVU0VSX0RSSVZFTl9ERUVQX1VOSVRTLFxuICBpc0F3YWl0aW5nVXNlcklucHV0LFxuICB0eXBlIFBvc3RVbml0Q29udGV4dCxcbiAgdHlwZSBQcmVWZXJpZmljYXRpb25PcHRzLFxufSBmcm9tIFwiLi4vYXV0by1wb3N0LXVuaXQuanNcIjtcbmltcG9ydCB0eXBlIHsgUGhhc2UgfSBmcm9tIFwiLi4vdHlwZXMuanNcIjtcbmltcG9ydCB7XG4gIE1BWF9SRUNPVkVSWV9DSEFSUyxcbiAgQlVER0VUX1RIUkVTSE9MRFMsXG4gIE1BWF9GSU5BTElaRV9USU1FT1VUUyxcbiAgdHlwZSBQaGFzZVJlc3VsdCxcbiAgdHlwZSBJdGVyYXRpb25Db250ZXh0LFxuICB0eXBlIExvb3BTdGF0ZSxcbiAgdHlwZSBQcmVEaXNwYXRjaERhdGEsXG4gIHR5cGUgSXRlcmF0aW9uRGF0YSxcbn0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IGRldGVjdFN0dWNrIH0gZnJvbSBcIi4vZGV0ZWN0LXN0dWNrLmpzXCI7XG5pbXBvcnQgeyBydW5Vbml0IH0gZnJvbSBcIi4vcnVuLXVuaXQuanNcIjtcbmltcG9ydCB7IGRlYnVnTG9nIH0gZnJvbSBcIi4uL2RlYnVnLWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QsIG5vcm1hbGl6ZVdvcmt0cmVlUGF0aEZvckNvbXBhcmUgfSBmcm9tIFwiLi4vd29ya3RyZWUtcm9vdC5qc1wiO1xuaW1wb3J0IHsgY2xhc3NpZnlQcm9qZWN0IH0gZnJvbSBcIi4uL2RldGVjdGlvbi5qc1wiO1xuaW1wb3J0IHsgTWVyZ2VDb25mbGljdEVycm9yIH0gZnJvbSBcIi4uL2dpdC1zZXJ2aWNlLmpzXCI7XG5pbXBvcnQgeyBzZXRDdXJyZW50UGhhc2UsIGNsZWFyQ3VycmVudFBoYXNlIH0gZnJvbSBcIi4uLy4uL3NoYXJlZC9nc2QtcGhhc2Utc3RhdGUuanNcIjtcbmltcG9ydCB7IHBhdXNlQXV0b0ZvclByb3ZpZGVyRXJyb3IgfSBmcm9tIFwiLi4vcHJvdmlkZXItZXJyb3ItcGF1c2UuanNcIjtcbmltcG9ydCB7IHJlc3VtZUF1dG9BZnRlclByb3ZpZGVyRGVsYXkgfSBmcm9tIFwiLi4vYm9vdHN0cmFwL3Byb3ZpZGVyLWVycm9yLXJlc3VtZS5qc1wiO1xuaW1wb3J0IHsgam9pbiwgYmFzZW5hbWUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBjcFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHtcbiAgbG9nV2FybmluZyxcbiAgbG9nRXJyb3IsXG4gIF9yZXNldExvZ3MsXG4gIGRyYWluTG9ncyxcbiAgZHJhaW5BbmRTdW1tYXJpemUsXG4gIGZvcm1hdEZvck5vdGlmaWNhdGlvbixcbiAgaGFzQW55SXNzdWVzLFxufSBmcm9tIFwiLi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyBnc2RSb290IH0gZnJvbSBcIi4uL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBhdG9taWNXcml0ZVN5bmMgfSBmcm9tIFwiLi4vYXRvbWljLXdyaXRlLmpzXCI7XG5pbXBvcnQgeyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0LCBkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3QsIGJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHMsIHJlZnJlc2hSZWNvdmVyeURiRm9yQXJ0aWZhY3QgfSBmcm9tIFwiLi4vYXV0by1yZWNvdmVyeS5qc1wiO1xuaW1wb3J0IHsgd3JpdGVVbml0UnVudGltZVJlY29yZCB9IGZyb20gXCIuLi91bml0LXJ1bnRpbWUuanNcIjtcbmltcG9ydCB7IHdpdGhUaW1lb3V0LCBGSU5BTElaRV9QUkVfVElNRU9VVF9NUywgRklOQUxJWkVfUE9TVF9USU1FT1VUX01TIH0gZnJvbSBcIi4vZmluYWxpemUtdGltZW91dC5qc1wiO1xuaW1wb3J0IHsgZ2V0RWxpZ2libGVTbGljZXMgfSBmcm9tIFwiLi4vc2xpY2UtcGFyYWxsZWwtZWxpZ2liaWxpdHkuanNcIjtcbmltcG9ydCB7IHN0YXJ0U2xpY2VQYXJhbGxlbCB9IGZyb20gXCIuLi9zbGljZS1wYXJhbGxlbC1vcmNoZXN0cmF0b3IuanNcIjtcbmltcG9ydCB7IGlzRGJBdmFpbGFibGUsIGdldE1pbGVzdG9uZVNsaWNlcyB9IGZyb20gXCIuLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7IHJlY29uY2lsZUJlZm9yZVNwYXduIH0gZnJvbSBcIi4uL3N0YXRlLXJlY29uY2lsaWF0aW9uLmpzXCI7XG5pbXBvcnQgdHlwZSB7IE1pbmltYWxNb2RlbFJlZ2lzdHJ5IH0gZnJvbSBcIi4uL2NvbnRleHQtYnVkZ2V0LmpzXCI7XG5pbXBvcnQgdHlwZSB7IFBvc3RmbGlnaHRSZXN1bHQsIFByZWZsaWdodFJlc3VsdCB9IGZyb20gXCIuLi9jbGVhbi1yb290LXByZWZsaWdodC5qc1wiO1xuaW1wb3J0IHsgZW5zdXJlUGxhblYyR3JhcGgsIGlzRW1wdHlQbGFuVjJHcmFwaFJlc3VsdCwgaXNNaXNzaW5nRmluYWxpemVkQ29udGV4dFJlc3VsdCB9IGZyb20gXCIuLi91b2svcGxhbi12Mi5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVVva0ZsYWdzIH0gZnJvbSBcIi4uL3Vvay9mbGFncy5qc1wiO1xuaW1wb3J0IHsgVW9rR2F0ZVJ1bm5lciB9IGZyb20gXCIuLi91b2svZ2F0ZS1ydW5uZXIuanNcIjtcbmltcG9ydCB7IHJlc2V0RXZpZGVuY2UsIGxvYWRFdmlkZW5jZUZyb21EaXNrIH0gZnJvbSBcIi4uL3NhZmV0eS9ldmlkZW5jZS1jb2xsZWN0b3IuanNcIjtcbmltcG9ydCB7IHBhcnNlVW5pdElkIH0gZnJvbSBcIi4uL3VuaXQtaWQuanNcIjtcbmltcG9ydCB7IGNyZWF0ZUNoZWNrcG9pbnQsIGNsZWFudXBDaGVja3BvaW50LCByb2xsYmFja1RvQ2hlY2twb2ludCB9IGZyb20gXCIuLi9zYWZldHkvZ2l0LWNoZWNrcG9pbnQuanNcIjtcbmltcG9ydCB7IHJlc29sdmVTYWZldHlIYXJuZXNzQ29uZmlnIH0gZnJvbSBcIi4uL3NhZmV0eS9zYWZldHktaGFybmVzcy5qc1wiO1xuaW1wb3J0IHtcbiAgZ2V0V29ya2Zsb3dUcmFuc3BvcnRTdXBwb3J0RXJyb3IsXG4gIGdldFJlcXVpcmVkV29ya2Zsb3dUb29sc0ZvckF1dG9Vbml0LFxuICBzdXBwb3J0c1N0cnVjdHVyZWRRdWVzdGlvbnMsXG59IGZyb20gXCIuLi93b3JrZmxvdy1tY3AuanNcIjtcbmltcG9ydCB7IHJlc29sdmVNYW5pZmVzdCB9IGZyb20gXCIuLi91bml0LWNvbnRleHQtbWFuaWZlc3QuanNcIjtcbmltcG9ydCB7IGNyZWF0ZVdvcmt0cmVlU2FmZXR5TW9kdWxlLCB0eXBlIFdvcmt0cmVlU2FmZXR5UmVzdWx0IH0gZnJvbSBcIi4uL3dvcmt0cmVlLXNhZmV0eS5qc1wiO1xuaW1wb3J0IHsgaXNTdXNwaWNpb3VzR2hvc3RDb21wbGV0aW9uIH0gZnJvbSBcIi4uL2F1dG8tdW5pdC1jbG9zZW91dC5qc1wiO1xuaW1wb3J0IHsgZGVjaWRlVmVyaWZpY2F0aW9uUmV0cnksIHZlcmlmaWNhdGlvblJldHJ5S2V5IH0gZnJvbSBcIi4vdmVyaWZpY2F0aW9uLXJldHJ5LXBvbGljeS5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGF0aCBDb21wYXJpc29uIEhlbHBlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8qKiBDb21wYXJlIHR3byBwYXRocyBmb3IgcGh5c2ljYWwgaWRlbnRpdHksIHRvbGVyYXRpbmcgdHJhaWxpbmcgc2xhc2hlcyBhbmQgc3ltbGlua3MuICovXG5mdW5jdGlvbiBpc1NhbWVQYXRoTG9jYWwoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIG5vcm1hbGl6ZVdvcmt0cmVlUGF0aEZvckNvbXBhcmUoYSkgPT09IG5vcm1hbGl6ZVdvcmt0cmVlUGF0aEZvckNvbXBhcmUoYik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwcGx5VmVyaWZpY2F0aW9uUmV0cnlQb2xpY3koXG4gIGljOiBJdGVyYXRpb25Db250ZXh0LFxuICB1bml0VHlwZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBwaGFzZTogXCJhcnRpZmFjdC12ZXJpZmljYXRpb24tcmV0cnlcIiB8IFwidmVyaWZpY2F0aW9uLXJldHJ5XCIsXG4pOiBQcm9taXNlPFBoYXNlUmVzdWx0IHwgbnVsbD4ge1xuICBjb25zdCB7IGN0eCwgcGksIHMsIGRlcHMgfSA9IGljO1xuICBjb25zdCByZXRyeUluZm8gPSBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeTtcbiAgY29uc3Qga2V5ID0gdW5pdFR5cGUgJiYgcmV0cnlJbmZvXG4gICAgPyB2ZXJpZmljYXRpb25SZXRyeUtleSh1bml0VHlwZSwgcmV0cnlJbmZvLnVuaXRJZClcbiAgICA6IHVuZGVmaW5lZDtcbiAgY29uc3QgZGVjaXNpb24gPSBkZWNpZGVWZXJpZmljYXRpb25SZXRyeSh7XG4gICAgdW5pdFR5cGUsXG4gICAgcmV0cnlJbmZvLFxuICAgIHByZXZpb3VzRmFpbHVyZUhhc2g6IGtleSA/IHMudmVyaWZpY2F0aW9uUmV0cnlGYWlsdXJlSGFzaGVzLmdldChrZXkpIDogdW5kZWZpbmVkLFxuICB9KTtcblxuICBpZiAoZGVjaXNpb24uYWN0aW9uID09PSBcInBhdXNlXCIpIHtcbiAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IG51bGw7XG4gICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgICBwaGFzZTogYCR7cGhhc2V9LXBhdXNlZGAsXG4gICAgICByZWFzb246IGRlY2lzaW9uLnJlYXNvbixcbiAgICAgIHVuaXRUeXBlLFxuICAgICAgdW5pdElkOiByZXRyeUluZm8/LnVuaXRJZCxcbiAgICAgIGZhaWx1cmVIYXNoOiBkZWNpc2lvbi5mYWlsdXJlSGFzaCxcbiAgICB9KTtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgZGVjaXNpb24ucmVhc29uID09PSBcImR1cGxpY2F0ZS1mYWlsdXJlLWNvbnRleHRcIlxuICAgICAgICA/IGBWZXJpZmljYXRpb24gcmV0cnkgZm9yICR7dW5pdFR5cGUgPz8gXCJ1bml0XCJ9ICR7cmV0cnlJbmZvPy51bml0SWQgPz8gXCJ1bmtub3duXCJ9IHByb2R1Y2VkIHRoZSBzYW1lIGZhaWx1cmUgY29udGV4dC4gUGF1c2luZyBhdXRvLW1vZGUgaW5zdGVhZCBvZiByZS1kaXNwYXRjaGluZy5gXG4gICAgICAgIDogXCJWZXJpZmljYXRpb24gcmV0cnkgcmVxdWVzdGVkIHdpdGhvdXQgcmV0cnkgY29udGV4dC4gUGF1c2luZyBhdXRvLW1vZGUgaW5zdGVhZCBvZiByZS1kaXNwYXRjaGluZy5cIixcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG4gICAgYXdhaXQgZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogZGVjaXNpb24ucmVhc29uIH07XG4gIH1cblxuICBzLnZlcmlmaWNhdGlvblJldHJ5RmFpbHVyZUhhc2hlcy5zZXQoZGVjaXNpb24ua2V5LCBkZWNpc2lvbi5mYWlsdXJlSGFzaCk7XG4gIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgIHBoYXNlOiBgJHtwaGFzZX0tYmFja29mZmAsXG4gICAgaXRlcmF0aW9uOiBpYy5pdGVyYXRpb24sXG4gICAgdW5pdFR5cGUsXG4gICAgdW5pdElkOiByZXRyeUluZm8/LnVuaXRJZCxcbiAgICBhdHRlbXB0OiByZXRyeUluZm8/LmF0dGVtcHQsXG4gICAgZGVsYXlNczogZGVjaXNpb24uZGVsYXlNcyxcbiAgICBiYXNlRGVsYXlNczogZGVjaXNpb24uYmFzZURlbGF5TXMsXG4gICAgZmFpbHVyZUhhc2g6IGRlY2lzaW9uLmZhaWx1cmVIYXNoLFxuICB9KTtcbiAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgZGVjaXNpb24uZGVsYXlNcykpO1xuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZERlZ3JhZGVFbXB0eVdvcmt0cmVlVG9Qcm9qZWN0Um9vdChcbiAgd29ya3RyZWVDbGFzc2lmaWNhdGlvbjogUmV0dXJuVHlwZTx0eXBlb2YgY2xhc3NpZnlQcm9qZWN0PixcbiAgcHJvamVjdFJvb3RDbGFzc2lmaWNhdGlvbjogUmV0dXJuVHlwZTx0eXBlb2YgY2xhc3NpZnlQcm9qZWN0Pixcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gKFxuICAgIHdvcmt0cmVlQ2xhc3NpZmljYXRpb24ua2luZCA9PT0gXCJncmVlbmZpZWxkXCIgJiZcbiAgICBwcm9qZWN0Um9vdENsYXNzaWZpY2F0aW9uLmtpbmQgIT09IFwiZ3JlZW5maWVsZFwiICYmXG4gICAgcHJvamVjdFJvb3RDbGFzc2lmaWNhdGlvbi5raW5kICE9PSBcImludmFsaWQtcmVwb1wiXG4gICk7XG59XG5cbmZ1bmN0aW9uIHVuaXRXcml0ZXNTb3VyY2UodW5pdFR5cGU6IHN0cmluZyk6IGJvb2xlYW4gfCBudWxsIHtcbiAgY29uc3QgbWFuaWZlc3QgPSByZXNvbHZlTWFuaWZlc3QodW5pdFR5cGUpO1xuICBpZiAoIW1hbmlmZXN0KSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIG1hbmlmZXN0LnRvb2xzLm1vZGUgPT09IFwiYWxsXCIgfHwgbWFuaWZlc3QudG9vbHMubW9kZSA9PT0gXCJkb2NzXCI7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdFdvcmt0cmVlU2FmZXR5RmFpbHVyZShyZXN1bHQ6IEV4dHJhY3Q8V29ya3RyZWVTYWZldHlSZXN1bHQsIHsgb2s6IGZhbHNlIH0+KTogc3RyaW5nIHtcbiAgcmV0dXJuIGBXb3JrdHJlZSBTYWZldHkgZmFpbGVkICgke3Jlc3VsdC5raW5kfSk6ICR7cmVzdWx0LnJlYXNvbn0gJHtyZXN1bHQucmVtZWRpYXRpb259YDtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZUVtcHR5V29ya3RyZWVXaXRoUHJvamVjdENvbnRlbnQoXG4gIHVuaXRSb290OiBzdHJpbmcsXG4gIHByb2plY3RSb290OiBzdHJpbmcsXG4pOiBib29sZWFuIHtcbiAgaWYgKGlzU2FtZVBhdGhMb2NhbCh1bml0Um9vdCwgcHJvamVjdFJvb3QpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHdvcmt0cmVlQ2xhc3NpZmljYXRpb24gPSBjbGFzc2lmeVByb2plY3QodW5pdFJvb3QpO1xuICBpZiAod29ya3RyZWVDbGFzc2lmaWNhdGlvbi5raW5kICE9PSBcImdyZWVuZmllbGRcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBwcm9qZWN0Um9vdENsYXNzaWZpY2F0aW9uID0gY2xhc3NpZnlQcm9qZWN0KHByb2plY3RSb290KTtcbiAgcmV0dXJuIHNob3VsZERlZ3JhZGVFbXB0eVdvcmt0cmVlVG9Qcm9qZWN0Um9vdCh3b3JrdHJlZUNsYXNzaWZpY2F0aW9uLCBwcm9qZWN0Um9vdENsYXNzaWZpY2F0aW9uKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gdmFsaWRhdGVTb3VyY2VXcml0ZVdvcmt0cmVlU2FmZXR5KFxuICBpYzogSXRlcmF0aW9uQ29udGV4dCxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHBoYXNlOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgYWN0aW9uOiBcImJyZWFrXCI7IHJlYXNvbjogc3RyaW5nIH0gfCBudWxsPiB7XG4gIGNvbnN0IHsgY3R4LCBwaSwgcywgZGVwcyB9ID0gaWM7XG4gIGlmICghcy5iYXNlUGF0aCkgcmV0dXJuIG51bGw7XG5cbiAgLy8gQ3VzdG9tIGVuZ2luZSB3b3JrZmxvd3MgKGdyYXBoLWRyaXZlbiwgcmVnaXN0ZXJlZCB2aWEgcnVuIGRpcnMpIGRlZmluZVxuICAvLyB0aGVpciBvd24gc3RlcCBpZHMgdGhhdCBhcmUgbm90IGluIHRoZSBHU0QgVW5pdENvbnRleHRNYW5pZmVzdC4gRG9uJ3RcbiAgLy8gZmFpbCBjbG9zZWQgZm9yIHRob3NlIFx1MjAxNCB0aGUgY3VzdG9tIGVuZ2luZSBvd25zIGl0cyBvd24gZGlzcGF0Y2hcbiAgLy8gY29udHJhY3QuIFRoZSBmYWlsLWNsb3NlZCBzYWZldHkgY2hlY2sgYXBwbGllcyBvbmx5IHRvIGJ1aWx0LWluIEdTRFxuICAvLyB1bml0cyB3aG9zZSBUb29sIENvbnRyYWN0IGlzIHJlZ2lzdGVyZWQgaW4gdGhlIG1hbmlmZXN0LiBVc2UgYSB0cnV0aHlcbiAgLy8gY2hlY2sgc28gdW5kZWZpbmVkICh0ZXN0IHNlc3Npb25zIHRoYXQgbmV2ZXIgc2V0IHRoZSBmaWVsZCkgcm91dGVzXG4gIC8vIHRocm91Z2ggdGhlIHNhZmV0eSBjaGVjaywgbWF0Y2hpbmcgdGhlIHJlZ3Jlc3Npb24gdGVzdCBjb250cmFjdC5cbiAgaWYgKHMuYWN0aXZlRW5naW5lSWQpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHdyaXRlc1NvdXJjZSA9IHVuaXRXcml0ZXNTb3VyY2UodW5pdFR5cGUpO1xuICBpZiAod3JpdGVzU291cmNlID09PSBudWxsKSB7XG4gICAgY29uc3QgbXNnID0gYFdvcmt0cmVlIFNhZmV0eSBmYWlsZWQgKG1pc3NpbmctdG9vbC1jb250cmFjdCk6IG1pc3NpbmcgVG9vbCBDb250cmFjdCBmb3IgJHt1bml0VHlwZX0uIEFkZCBhIFVuaXRDb250ZXh0TWFuaWZlc3QgZW50cnkgYmVmb3JlIGRpc3BhdGNoaW5nIHRoaXMgVW5pdC5gO1xuICAgIGRlYnVnTG9nKFwid29ya3RyZWVTYWZldHlcIiwge1xuICAgICAgcGhhc2UsXG4gICAgICB1bml0VHlwZSxcbiAgICAgIHVuaXRJZCxcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgcmVzdWx0OiB7IG9rOiBmYWxzZSwga2luZDogXCJtaXNzaW5nLXRvb2wtY29udHJhY3RcIiwgcmVhc29uOiBtc2cgfSxcbiAgICAgIGJhc2VQYXRoOiBzLmJhc2VQYXRoLFxuICAgIH0pO1xuICAgIGN0eC51aS5ub3RpZnkobXNnLCBcImVycm9yXCIpO1xuICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgbXNnKTtcbiAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBcIm1pc3NpbmctdG9vbC1jb250cmFjdFwiIH07XG4gIH1cbiAgaWYgKCF3cml0ZXNTb3VyY2UpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHByb2plY3RSb290ID0gcy5jYW5vbmljYWxQcm9qZWN0Um9vdCA/PyByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdChzLmJhc2VQYXRoLCBzLm9yaWdpbmFsQmFzZVBhdGgpO1xuICBpZiAoZGVwcy5nZXRJc29sYXRpb25Nb2RlKHByb2plY3RSb290KSAhPT0gXCJ3b3JrdHJlZVwiKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBzYWZldHkgPSBjcmVhdGVXb3JrdHJlZVNhZmV0eU1vZHVsZSgpO1xuICBjb25zdCByZXN1bHQgPSBzYWZldHkudmFsaWRhdGVVbml0Um9vdCh7XG4gICAgdW5pdFR5cGUsXG4gICAgdW5pdElkLFxuICAgIHdyaXRlU2NvcGU6IFwic291cmNlLXdyaXRpbmdcIixcbiAgICBwcm9qZWN0Um9vdCxcbiAgICB1bml0Um9vdDogcy5iYXNlUGF0aCxcbiAgICBtaWxlc3RvbmVJZCxcbiAgICBleHBlY3RlZEJyYW5jaDogbWlsZXN0b25lSWQgPyBkZXBzLmF1dG9Xb3JrdHJlZUJyYW5jaChtaWxlc3RvbmVJZCkgOiBudWxsLFxuICAgIGVtcHR5V29ya3RyZWVXaXRoUHJvamVjdENvbnRlbnQ6IHJlc29sdmVFbXB0eVdvcmt0cmVlV2l0aFByb2plY3RDb250ZW50KHMuYmFzZVBhdGgsIHByb2plY3RSb290KSxcbiAgICBsZWFzZTogcy53b3JrZXJJZFxuICAgICAgPyB7XG4gICAgICAgICAgcmVxdWlyZWQ6IHRydWUsXG4gICAgICAgICAgaGVsZDogcy5jdXJyZW50TWlsZXN0b25lSWQgPT09IG1pbGVzdG9uZUlkICYmIHMubWlsZXN0b25lTGVhc2VUb2tlbiAhPT0gbnVsbCxcbiAgICAgICAgICBvd25lcjogcy53b3JrZXJJZCxcbiAgICAgICAgfVxuICAgICAgOiB1bmRlZmluZWQsXG4gIH0pO1xuXG4gIGlmIChyZXN1bHQub2spIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IG1zZyA9IGZvcm1hdFdvcmt0cmVlU2FmZXR5RmFpbHVyZShyZXN1bHQpO1xuICBkZWJ1Z0xvZyhcIndvcmt0cmVlU2FmZXR5XCIsIHtcbiAgICBwaGFzZSxcbiAgICB1bml0VHlwZSxcbiAgICB1bml0SWQsXG4gICAgbWlsZXN0b25lSWQsXG4gICAgcmVzdWx0LFxuICAgIGJhc2VQYXRoOiBzLmJhc2VQYXRoLFxuICAgIHByb2plY3RSb290LFxuICB9KTtcbiAgY3R4LnVpLm5vdGlmeShtc2csIFwiZXJyb3JcIik7XG4gIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgbXNnKTtcbiAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogcmVzdWx0LmtpbmQgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNlc3Npb24gdGltZW91dCBhdXRvLXJlc3VtZSBzdGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxubGV0IGNvbnNlY3V0aXZlU2Vzc2lvblRpbWVvdXRzID0gMDtcbmNvbnN0IE1BWF9TRVNTSU9OX1RJTUVPVVRfQVVUT19SRVNVTUVTID0gMztcblxuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0U2Vzc2lvblRpbWVvdXRTdGF0ZSgpOiB2b2lkIHtcbiAgY29uc2VjdXRpdmVTZXNzaW9uVGltZW91dHMgPSAwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZ2VuZXJhdGVNaWxlc3RvbmVSZXBvcnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgYmFzZSBwYXRoIGZvciBtaWxlc3RvbmUgcmVwb3J0cy5cbiAqIFByZWZlcnMgb3JpZ2luYWxCYXNlUGF0aCAocHJvamVjdCByb290KSBvdmVyIGJhc2VQYXRoICh3aGljaCBtYXkgYmUgYSB3b3JrdHJlZSkuXG4gKiBFeHBvcnRlZCBmb3IgdGVzdGluZyBhcyBfcmVzb2x2ZVJlcG9ydEJhc2VQYXRoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gX3Jlc29sdmVSZXBvcnRCYXNlUGF0aChzOiBQaWNrPEF1dG9TZXNzaW9uLCBcIm9yaWdpbmFsQmFzZVBhdGhcIiB8IFwiYmFzZVBhdGhcIj4pOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3Qocy5iYXNlUGF0aCwgcy5vcmlnaW5hbEJhc2VQYXRoKTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBhdXRob3JpdGF0aXZlIHByb2plY3QgYmFzZSBmb3IgZGlzcGF0Y2ggZ3VhcmRzLlxuICogUHJpb3ItbWlsZXN0b25lIGNvbXBsZXRpb24gbGl2ZXMgYXQgdGhlIHByb2plY3Qgcm9vdCwgZXZlbiB3aGVuIHRoZSBhY3RpdmVcbiAqIHVuaXQgaXMgcnVubmluZyBpbnNpZGUgYW4gYXV0byB3b3JrdHJlZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9yZXNvbHZlRGlzcGF0Y2hHdWFyZEJhc2VQYXRoKFxuICBzOiBQaWNrPEF1dG9TZXNzaW9uLCBcIm9yaWdpbmFsQmFzZVBhdGhcIiB8IFwiYmFzZVBhdGhcIj4sXG4pOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3Qocy5iYXNlUGF0aCwgcy5vcmlnaW5hbEJhc2VQYXRoKTtcbn1cblxuY29uc3QgUExBTl9WMl9HQVRFX1BIQVNFUzogUmVhZG9ubHlTZXQ8UGhhc2U+ID0gbmV3IFNldChbXG4gIFwiZXhlY3V0aW5nXCIsXG4gIFwic3VtbWFyaXppbmdcIixcbiAgXCJ2YWxpZGF0aW5nLW1pbGVzdG9uZVwiLFxuICBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIsXG5dKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFJ1blBsYW5WMkdhdGUocGhhc2U6IFBoYXNlKTogYm9vbGVhbiB7XG4gIHJldHVybiBQTEFOX1YyX0dBVEVfUEhBU0VTLmhhcyhwaGFzZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfc2hvdWxkUHJvY2VlZFdpdGhJbnZhbGlkUmVwb0NsYXNzaWZpY2F0aW9uRm9yVGVzdChcbiAgcmVhc29uOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGhhc0dpdDogYm9vbGVhbixcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gcmVhc29uID09PSBcIm1pc3NpbmcgLmdpdFwiICYmIGhhc0dpdDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9yZXNvbHZlQ3VycmVudFVuaXRTdGFydGVkQXRGb3JUZXN0KFxuICBjdXJyZW50VW5pdDogeyBzdGFydGVkQXQ6IG51bWJlciB9IHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IG51bWJlciB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBjdXJyZW50VW5pdD8uc3RhcnRlZEF0O1xufVxuXG4vKipcbiAqIEdlbmVyYXRlIGFuZCB3cml0ZSBhbiBIVE1MIG1pbGVzdG9uZSByZXBvcnQgc25hcHNob3QuXG4gKiBFeHRyYWN0ZWQgZnJvbSB0aGUgbWlsZXN0b25lLXRyYW5zaXRpb24gYmxvY2sgaW4gYXV0b0xvb3AuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdlbmVyYXRlTWlsZXN0b25lUmVwb3J0KFxuICBzOiBBdXRvU2Vzc2lvbixcbiAgY3R4OiBFeHRlbnNpb25Db250ZXh0LFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgbG9hZFZpc3VhbGl6ZXJEYXRhIH0gPSBhd2FpdCBpbXBvcnRFeHRlbnNpb25Nb2R1bGU8dHlwZW9mIGltcG9ydChcIi4uL3Zpc3VhbGl6ZXItZGF0YS5qc1wiKT4oaW1wb3J0Lm1ldGEudXJsLCBcIi4uL3Zpc3VhbGl6ZXItZGF0YS5qc1wiKTtcbiAgY29uc3QgeyBnZW5lcmF0ZUh0bWxSZXBvcnQgfSA9IGF3YWl0IGltcG9ydEV4dGVuc2lvbk1vZHVsZTx0eXBlb2YgaW1wb3J0KFwiLi4vZXhwb3J0LWh0bWwuanNcIik+KGltcG9ydC5tZXRhLnVybCwgXCIuLi9leHBvcnQtaHRtbC5qc1wiKTtcbiAgY29uc3QgeyB3cml0ZVJlcG9ydFNuYXBzaG90IH0gPSBhd2FpdCBpbXBvcnRFeHRlbnNpb25Nb2R1bGU8dHlwZW9mIGltcG9ydChcIi4uL3JlcG9ydHMuanNcIik+KGltcG9ydC5tZXRhLnVybCwgXCIuLi9yZXBvcnRzLmpzXCIpO1xuICBjb25zdCB7IGJhc2VuYW1lIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnBhdGhcIik7XG5cbiAgY29uc3QgcmVwb3J0QmFzZVBhdGggPSBfcmVzb2x2ZVJlcG9ydEJhc2VQYXRoKHMpO1xuXG4gIGNvbnN0IHNuYXBEYXRhID0gYXdhaXQgbG9hZFZpc3VhbGl6ZXJEYXRhKHJlcG9ydEJhc2VQYXRoKTtcbiAgY29uc3QgY29tcGxldGVkTXMgPSBzbmFwRGF0YS5taWxlc3RvbmVzLmZpbmQoXG4gICAgKG06IHsgaWQ6IHN0cmluZyB9KSA9PiBtLmlkID09PSBtaWxlc3RvbmVJZCxcbiAgKTtcbiAgY29uc3QgbXNUaXRsZSA9IGNvbXBsZXRlZE1zPy50aXRsZSA/PyBtaWxlc3RvbmVJZDtcbiAgY29uc3QgZ3NkVmVyc2lvbiA9IHByb2Nlc3MuZW52LkdTRF9WRVJTSU9OID8/IFwiMC4wLjBcIjtcbiAgY29uc3QgcHJvak5hbWUgPSBiYXNlbmFtZShyZXBvcnRCYXNlUGF0aCk7XG4gIGNvbnN0IGRvbmVTbGljZXMgPSBzbmFwRGF0YS5taWxlc3RvbmVzLnJlZHVjZShcbiAgICAoYWNjOiBudW1iZXIsIG06IHsgc2xpY2VzOiB7IGRvbmU6IGJvb2xlYW4gfVtdIH0pID0+XG4gICAgICBhY2MgKyBtLnNsaWNlcy5maWx0ZXIoKHNsOiB7IGRvbmU6IGJvb2xlYW4gfSkgPT4gc2wuZG9uZSkubGVuZ3RoLFxuICAgIDAsXG4gICk7XG4gIGNvbnN0IHRvdGFsU2xpY2VzID0gc25hcERhdGEubWlsZXN0b25lcy5yZWR1Y2UoXG4gICAgKGFjYzogbnVtYmVyLCBtOiB7IHNsaWNlczogdW5rbm93bltdIH0pID0+IGFjYyArIG0uc2xpY2VzLmxlbmd0aCxcbiAgICAwLFxuICApO1xuICBjb25zdCBvdXRQYXRoID0gd3JpdGVSZXBvcnRTbmFwc2hvdCh7XG4gICAgYmFzZVBhdGg6IHJlcG9ydEJhc2VQYXRoLFxuICAgIGh0bWw6IGdlbmVyYXRlSHRtbFJlcG9ydChzbmFwRGF0YSwge1xuICAgICAgcHJvamVjdE5hbWU6IHByb2pOYW1lLFxuICAgICAgcHJvamVjdFBhdGg6IHJlcG9ydEJhc2VQYXRoLFxuICAgICAgZ3NkVmVyc2lvbixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgaW5kZXhSZWxQYXRoOiBcImluZGV4Lmh0bWxcIixcbiAgICB9KSxcbiAgICBtaWxlc3RvbmVJZCxcbiAgICBtaWxlc3RvbmVUaXRsZTogbXNUaXRsZSxcbiAgICBraW5kOiBcIm1pbGVzdG9uZVwiLFxuICAgIHByb2plY3ROYW1lOiBwcm9qTmFtZSxcbiAgICBwcm9qZWN0UGF0aDogcmVwb3J0QmFzZVBhdGgsXG4gICAgZ3NkVmVyc2lvbixcbiAgICB0b3RhbENvc3Q6IHNuYXBEYXRhLnRvdGFscz8uY29zdCA/PyAwLFxuICAgIHRvdGFsVG9rZW5zOiBzbmFwRGF0YS50b3RhbHM/LnRva2Vucy50b3RhbCA/PyAwLFxuICAgIHRvdGFsRHVyYXRpb246IHNuYXBEYXRhLnRvdGFscz8uZHVyYXRpb24gPz8gMCxcbiAgICBkb25lU2xpY2VzLFxuICAgIHRvdGFsU2xpY2VzLFxuICAgIGRvbmVNaWxlc3RvbmVzOiBzbmFwRGF0YS5taWxlc3RvbmVzLmZpbHRlcihcbiAgICAgIChtOiB7IHN0YXR1czogc3RyaW5nIH0pID0+IG0uc3RhdHVzID09PSBcImNvbXBsZXRlXCIsXG4gICAgKS5sZW5ndGgsXG4gICAgdG90YWxNaWxlc3RvbmVzOiBzbmFwRGF0YS5taWxlc3RvbmVzLmxlbmd0aCxcbiAgICBwaGFzZTogc25hcERhdGEucGhhc2UsXG4gIH0pO1xuICBjdHgudWkubm90aWZ5KFxuICAgIGBSZXBvcnQgc2F2ZWQ6IC5nc2QvcmVwb3J0cy8ke2Jhc2VuYW1lKG91dFBhdGgpfSBcdTIwMTQgb3BlbiBpbmRleC5odG1sIHRvIGJyb3dzZSBwcm9ncmVzc2lvbi5gLFxuICAgIFwiaW5mb1wiLFxuICApO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgY2xvc2VvdXRBbmRTdG9wIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIElmIGEgdW5pdCBpcyBpbi1mbGlnaHQsIGNsb3NlIGl0IG91dCwgdGhlbiBzdG9wIGF1dG8tbW9kZS5cbiAqIEV4dHJhY3RlZCBmcm9tIH40IGlkZW50aWNhbCBpZi1jbG9zZW91dC10aGVuLXN0b3Agc2VxdWVuY2VzIGluIGF1dG9Mb29wLlxuICovXG5hc3luYyBmdW5jdGlvbiBjbG9zZW91dEFuZFN0b3AoXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgczogQXV0b1Nlc3Npb24sXG4gIGRlcHM6IExvb3BEZXBzLFxuICByZWFzb246IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBpZiAocy5jdXJyZW50VW5pdCkge1xuICAgIGF3YWl0IGRlcHMuY2xvc2VvdXRVbml0KFxuICAgICAgY3R4LFxuICAgICAgcy5iYXNlUGF0aCxcbiAgICAgIHMuY3VycmVudFVuaXQudHlwZSxcbiAgICAgIHMuY3VycmVudFVuaXQuaWQsXG4gICAgICBzLmN1cnJlbnRVbml0LnN0YXJ0ZWRBdCxcbiAgICAgIGRlcHMuYnVpbGRTbmFwc2hvdE9wdHMocy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkKSxcbiAgICApO1xuICAgIHMuY3VycmVudFVuaXQgPSBudWxsO1xuICB9XG4gIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgcmVhc29uKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3RvcE9uUG9zdGZsaWdodFJlY292ZXJ5TmVlZGVkKFxuICBpYzogSXRlcmF0aW9uQ29udGV4dCxcbiAgcmVzdWx0OiBQb3N0ZmxpZ2h0UmVzdWx0LFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuKTogUHJvbWlzZTx7IGFjdGlvbjogXCJicmVha1wiOyByZWFzb246IHN0cmluZyB9IHwgbnVsbD4ge1xuICBpZiAoIXJlc3VsdC5uZWVkc01hbnVhbFJlY292ZXJ5KSByZXR1cm4gbnVsbDtcbiAgY29uc3QgeyBjdHgsIHBpLCBkZXBzIH0gPSBpYztcbiAgY29uc3QgcmVhc29uID0gYFBvc3QtbWVyZ2Ugc3Rhc2ggcmVzdG9yZSBmYWlsZWQgZm9yIG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfWA7XG4gIGN0eC51aS5ub3RpZnkoXG4gICAgYCR7cmVhc29ufS4gUmVzb2x2ZSB0aGUgd29ya2luZyB0cmVlIGJlZm9yZSByZXN1bWluZyBhdXRvLW1vZGUuICR7cmVzdWx0Lm1lc3NhZ2V9YCxcbiAgICBcImVycm9yXCIsXG4gICk7XG4gIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgcmVhc29uKTtcbiAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJwb3N0ZmxpZ2h0LXN0YXNoLXJlc3RvcmUtZmFpbGVkXCIgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVzdG9yZVByZWZsaWdodFN0YXNoT3JTdG9wKFxuICBpYzogSXRlcmF0aW9uQ29udGV4dCxcbiAgcHJlZmxpZ2h0OiBQcmVmbGlnaHRSZXN1bHQsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgYWN0aW9uOiBcImJyZWFrXCI7IHJlYXNvbjogc3RyaW5nIH0gfCBudWxsPiB7XG4gIGlmICghcHJlZmxpZ2h0LnN0YXNoUHVzaGVkKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgeyBjdHgsIHMsIGRlcHMgfSA9IGljO1xuICBjb25zdCByZXN1bHQgPSBkZXBzLnBvc3RmbGlnaHRQb3BTdGFzaChcbiAgICBzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCxcbiAgICBtaWxlc3RvbmVJZCxcbiAgICBwcmVmbGlnaHQuc3Rhc2hNYXJrZXIsXG4gICAgY3R4LnVpLm5vdGlmeS5iaW5kKGN0eC51aSksXG4gICk7XG4gIHJldHVybiBzdG9wT25Qb3N0ZmxpZ2h0UmVjb3ZlcnlOZWVkZWQoaWMsIHJlc3VsdCwgbWlsZXN0b25lSWQpO1xufVxuXG4vKipcbiAqIFJ1biBhIG1pbGVzdG9uZSBtZXJnZSBzdXJyb3VuZGVkIGJ5IHByZWZsaWdodCBzdGFzaCArIGFsd2F5cy1vbiBwb3N0ZmxpZ2h0XG4gKiBwb3AuIFRoZSBwcmV2aW91cyBjb2RlIHBvcHBlZCB0aGUgc3Rhc2ggb25seSBhZnRlciBhIHN1Y2Nlc3NmdWwgbWVyZ2UsIHdoaWNoXG4gKiBsZWFrZWQgYGdzZC1wcmVmbGlnaHQtc3Rhc2g6TTAweDoqYCBlbnRyaWVzIHdoZW5ldmVyIGBtZXJnZUFuZEV4aXRgIHRocmV3IFx1MjAxNFxuICogbGVhdmluZyB0aGUgdXNlcidzIHByZS1tZXJnZSB3b3JraW5nIHRyZWUgc2lsZW50bHkgc3Rhc2hlZCBhd2F5IGFmdGVyIGFcbiAqIG1lcmdlLWNvbmZsaWN0IG9yIG90aGVyIG1lcmdlIGVycm9yLiBUaGlzIGhlbHBlciByZXN0b3JlcyB0aGUgc3Rhc2ggb25cbiAqIGV2ZXJ5IGV4aXQgcGF0aCwgdGhlbiBzdXJmYWNlcyB0aGUgbWVyZ2Ugb3Igc3Rhc2ggZmFpbHVyZSAoaW4gcHJpb3JpdHlcbiAqIG9yZGVyKSBhcyB0aGUgbG9vcCdzIHN0b3AgcmVhc29uLlxuICpcbiAqIFJldHVybnMgYSBgYnJlYWtgIGFjdGlvbiB3aGVuIGF1dG8tbW9kZSBtdXN0IHN0b3AsIG9yIGBudWxsYCB3aGVuIHRoZSBtZXJnZVxuICogc3VjY2VlZGVkIGFuZCB0aGUgc3Rhc2ggKGlmIGFueSkgd2FzIHJlc3RvcmVkIGNsZWFubHkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBfcnVuTWlsZXN0b25lTWVyZ2VXaXRoU3Rhc2hSZXN0b3JlKFxuICBpYzogSXRlcmF0aW9uQ29udGV4dCxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbik6IFByb21pc2U8eyBhY3Rpb246IFwiYnJlYWtcIjsgcmVhc29uOiBzdHJpbmcgfSB8IG51bGw+IHtcbiAgY29uc3QgeyBjdHgsIHBpLCBzLCBkZXBzIH0gPSBpYztcblxuICBjb25zdCBwcmVmbGlnaHQgPSBkZXBzLnByZWZsaWdodENsZWFuUm9vdChcbiAgICBzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCxcbiAgICBtaWxlc3RvbmVJZCxcbiAgICBjdHgudWkubm90aWZ5LmJpbmQoY3R4LnVpKSxcbiAgKTtcblxuICBsZXQgbWVyZ2VFcnJvcjogdW5rbm93biA9IG51bGw7XG4gIGNvbnN0IGV4aXRSZXN1bHQgPSBkZXBzLmxpZmVjeWNsZS5leGl0TWlsZXN0b25lKFxuICAgIG1pbGVzdG9uZUlkLFxuICAgIHsgbWVyZ2U6IHRydWUgfSxcbiAgICBjdHgudWksXG4gICk7XG4gIGlmIChleGl0UmVzdWx0Lm9rKSB7XG4gICAgcy5taWxlc3RvbmVNZXJnZWRJblBoYXNlcyA9IHRydWU7XG4gIH0gZWxzZSB7XG4gICAgbWVyZ2VFcnJvciA9IGV4aXRSZXN1bHQuY2F1c2UgPz8gbmV3IEVycm9yKGBleGl0ICR7ZXhpdFJlc3VsdC5yZWFzb259YCk7XG4gIH1cblxuICAvLyBBbHdheXMgYXR0ZW1wdCB0byByZXN0b3JlIHRoZSBzdGFzaGVkIHdvcmtpbmcgdHJlZSwgZXZlbiBvbiBtZXJnZSBlcnJvci5cbiAgLy8gcG9zdGZsaWdodFBvcFN0YXNoIGl0c2VsZiBkb2VzIG5vdCB0aHJvdzsgZmFpbHVyZXMgc3VyZmFjZSB2aWEgdGhlXG4gIC8vIFBvc3RmbGlnaHRSZXN1bHQubmVlZHNNYW51YWxSZWNvdmVyeSBmbGFnLlxuICBsZXQgc3Rhc2hSZXN1bHQ6IFBvc3RmbGlnaHRSZXN1bHQgfCBudWxsID0gbnVsbDtcbiAgaWYgKHByZWZsaWdodC5zdGFzaFB1c2hlZCkge1xuICAgIHN0YXNoUmVzdWx0ID0gZGVwcy5wb3N0ZmxpZ2h0UG9wU3Rhc2goXG4gICAgICBzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCxcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgcHJlZmxpZ2h0LnN0YXNoTWFya2VyLFxuICAgICAgY3R4LnVpLm5vdGlmeS5iaW5kKGN0eC51aSksXG4gICAgKTtcbiAgfVxuXG4gIC8vIE1lcmdlIGZhaWx1cmUgdGFrZXMgcHJpb3JpdHkgb3ZlciBzdGFzaCByZWNvdmVyeSBcdTIwMTQgdGhlIG1lcmdlIGlzIHRoZVxuICAvLyBhdXRob3JpdGF0aXZlIGdhdGUuIElmIHRoZSBzdGFzaCBhbHNvIG5lZWRlZCBtYW51YWwgcmVjb3ZlcnksIHRoZSB1c2VyXG4gIC8vIGFscmVhZHkgc2F3IHRoZSBwb3N0ZmxpZ2h0UG9wU3Rhc2ggbm90aWZ5IGFib3ZlLlxuICBpZiAobWVyZ2VFcnJvcikge1xuICAgIGlmIChtZXJnZUVycm9yIGluc3RhbmNlb2YgTWVyZ2VDb25mbGljdEVycm9yKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgTWVyZ2UgY29uZmxpY3Q6ICR7bWVyZ2VFcnJvci5jb25mbGljdGVkRmlsZXMuam9pbihcIiwgXCIpfS4gUmVzb2x2ZSBjb25mbGljdHMgbWFudWFsbHkgYW5kIHJ1biAvZ3NkIGF1dG8gdG8gcmVzdW1lLmAsXG4gICAgICAgIFwiZXJyb3JcIixcbiAgICAgICk7XG4gICAgICBhd2FpdCBkZXBzLnN0b3BBdXRvKGN0eCwgcGksIGBNZXJnZSBjb25mbGljdCBvbiBtaWxlc3RvbmUgJHttaWxlc3RvbmVJZH1gKTtcbiAgICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwibWVyZ2UtY29uZmxpY3RcIiB9O1xuICAgIH1cbiAgICBsb2dFcnJvcihcImVuZ2luZVwiLCBcIk1pbGVzdG9uZSBtZXJnZSBmYWlsZWQgd2l0aCBub24tY29uZmxpY3QgZXJyb3JcIiwge1xuICAgICAgbWlsZXN0b25lOiBtaWxlc3RvbmVJZCxcbiAgICAgIGVycm9yOiBTdHJpbmcobWVyZ2VFcnJvciksXG4gICAgfSk7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBNZXJnZSBmYWlsZWQ6ICR7bWVyZ2VFcnJvciBpbnN0YW5jZW9mIEVycm9yID8gbWVyZ2VFcnJvci5tZXNzYWdlIDogU3RyaW5nKG1lcmdlRXJyb3IpfS4gUmVzb2x2ZSBhbmQgcnVuIC9nc2QgYXV0byB0byByZXN1bWUuYCxcbiAgICAgIFwiZXJyb3JcIixcbiAgICApO1xuICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oXG4gICAgICBjdHgsXG4gICAgICBwaSxcbiAgICAgIGBNZXJnZSBlcnJvciBvbiBtaWxlc3RvbmUgJHttaWxlc3RvbmVJZH06ICR7U3RyaW5nKG1lcmdlRXJyb3IpfWAsXG4gICAgKTtcbiAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBcIm1lcmdlLWZhaWxlZFwiIH07XG4gIH1cblxuICBpZiAoc3Rhc2hSZXN1bHQpIHtcbiAgICByZXR1cm4gc3RvcE9uUG9zdGZsaWdodFJlY292ZXJ5TmVlZGVkKGljLCBzdGFzaFJlc3VsdCwgbWlsZXN0b25lSWQpO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gX3J1bk1pbGVzdG9uZU1lcmdlT25jZVdpdGhTdGFzaFJlc3RvcmUoXG4gIGljOiBJdGVyYXRpb25Db250ZXh0LFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuKTogUHJvbWlzZTx7IGFjdGlvbjogXCJicmVha1wiOyByZWFzb246IHN0cmluZyB9IHwgbnVsbD4ge1xuICBpZiAoaWMucy5taWxlc3RvbmVNZXJnZWRJblBoYXNlcykge1xuICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgcGhhc2U6IFwibWlsZXN0b25lLW1lcmdlLXNraXBcIixcbiAgICAgIHJlYXNvbjogXCJhbHJlYWR5LW1lcmdlZC1pbi1waGFzZXNcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgIH0pO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiBfcnVuTWlsZXN0b25lTWVyZ2VXaXRoU3Rhc2hSZXN0b3JlKGljLCBtaWxlc3RvbmVJZCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVtaXRDYW5jZWxsZWRVbml0RW5kKFxuICBpYzogSXRlcmF0aW9uQ29udGV4dCxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4gIHVuaXRTdGFydFNlcTogbnVtYmVyLFxuICBlcnJvckNvbnRleHQ/OiB7IG1lc3NhZ2U6IHN0cmluZzsgY2F0ZWdvcnk6IHN0cmluZzsgc3RvcFJlYXNvbj86IHN0cmluZzsgaXNUcmFuc2llbnQ/OiBib29sZWFuOyByZXRyeUFmdGVyTXM/OiBudW1iZXIgfSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBpYy5kZXBzLmVtaXRKb3VybmFsRXZlbnQoe1xuICAgIHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgZmxvd0lkOiBpYy5mbG93SWQsXG4gICAgc2VxOiBpYy5uZXh0U2VxKCksXG4gICAgZXZlbnRUeXBlOiBcInVuaXQtZW5kXCIsXG4gICAgZGF0YToge1xuICAgICAgdW5pdFR5cGUsXG4gICAgICB1bml0SWQsXG4gICAgICBzdGF0dXM6IFwiY2FuY2VsbGVkXCIsXG4gICAgICBhcnRpZmFjdFZlcmlmaWVkOiBmYWxzZSxcbiAgICAgIC4uLihlcnJvckNvbnRleHQgPyB7IGVycm9yQ29udGV4dCB9IDoge30pLFxuICAgIH0sXG4gICAgY2F1c2VkQnk6IHsgZmxvd0lkOiBpYy5mbG93SWQsIHNlcTogdW5pdFN0YXJ0U2VxIH0sXG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX2J1aWxkQ2FuY2VsbGVkVW5pdFN0b3BSZWFzb24oXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICBlcnJvckNvbnRleHQ/OiB7IG1lc3NhZ2U6IHN0cmluZzsgY2F0ZWdvcnk6IHN0cmluZyB9LFxuKToge1xuICBub3RpZnlNZXNzYWdlOiBzdHJpbmc7XG4gIHN0b3BSZWFzb246IHN0cmluZztcbiAgbG9vcFJlYXNvbjogXCJzZXNzaW9uLWZhaWxlZFwiIHwgXCJ1bml0LWFib3J0ZWRcIjtcbn0ge1xuICBjb25zdCBjYW5jZWxsYXRpb25NZXNzYWdlID0gZXJyb3JDb250ZXh0Py5tZXNzYWdlID8/IFwidW5rbm93blwiO1xuICBjb25zdCBpc1Nlc3Npb25DcmVhdGlvbkZhaWx1cmUgPSBlcnJvckNvbnRleHQ/LmNhdGVnb3J5ID09PSBcInNlc3Npb24tZmFpbGVkXCI7XG5cbiAgaWYgKGlzU2Vzc2lvbkNyZWF0aW9uRmFpbHVyZSkge1xuICAgIHJldHVybiB7XG4gICAgICBub3RpZnlNZXNzYWdlOiBgU2Vzc2lvbiBjcmVhdGlvbiBmYWlsZWQgZm9yICR7dW5pdFR5cGV9ICR7dW5pdElkfTogJHtjYW5jZWxsYXRpb25NZXNzYWdlfS4gU3RvcHBpbmcgYXV0by1tb2RlLmAsXG4gICAgICBzdG9wUmVhc29uOiBgU2Vzc2lvbiBjcmVhdGlvbiBmYWlsZWQ6ICR7Y2FuY2VsbGF0aW9uTWVzc2FnZX1gLFxuICAgICAgbG9vcFJlYXNvbjogXCJzZXNzaW9uLWZhaWxlZFwiLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5vdGlmeU1lc3NhZ2U6IGBVbml0ICR7dW5pdFR5cGV9ICR7dW5pdElkfSBhYm9ydGVkIGFmdGVyIGRpc3BhdGNoOiAke2NhbmNlbGxhdGlvbk1lc3NhZ2V9LiBTdG9wcGluZyBhdXRvLW1vZGUuYCxcbiAgICBzdG9wUmVhc29uOiBgVW5pdCBhYm9ydGVkOiAke2NhbmNlbGxhdGlvbk1lc3NhZ2V9YCxcbiAgICBsb29wUmVhc29uOiBcInVuaXQtYWJvcnRlZFwiLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBmYWlsQ2xvc2VkT25GaW5hbGl6ZVRpbWVvdXQoXG4gIGljOiBJdGVyYXRpb25Db250ZXh0LFxuICBpdGVyRGF0YTogSXRlcmF0aW9uRGF0YSxcbiAgbG9vcFN0YXRlOiBMb29wU3RhdGUsXG4gIHN0YWdlOiBcInByZVwiIHwgXCJwb3N0XCIsXG4gIHN0YXJ0ZWRBdDogbnVtYmVyLFxuKTogUHJvbWlzZTxQaGFzZVJlc3VsdD4ge1xuICBjb25zdCB7IGN0eCwgcGksIHMsIGRlcHMgfSA9IGljO1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCB1bml0VHlwZSA9IGl0ZXJEYXRhLnVuaXRUeXBlO1xuICBjb25zdCB1bml0SWQgPSBpdGVyRGF0YS51bml0SWQ7XG4gIGNvbnN0IHRpbWVvdXRNcyA9IHN0YWdlID09PSBcInByZVwiID8gRklOQUxJWkVfUFJFX1RJTUVPVVRfTVMgOiBGSU5BTElaRV9QT1NUX1RJTUVPVVRfTVM7XG4gIGNvbnN0IHByb2dyZXNzS2luZCA9IHN0YWdlID09PSBcInByZVwiID8gXCJmaW5hbGl6ZS1wcmUtdGltZW91dFwiIDogXCJmaW5hbGl6ZS1wb3N0LXRpbWVvdXRcIjtcblxuICB3cml0ZVVuaXRSdW50aW1lUmVjb3JkKHMuYmFzZVBhdGgsIHVuaXRUeXBlLCB1bml0SWQsIHN0YXJ0ZWRBdCwge1xuICAgIHBoYXNlOiBcImZpbmFsaXplLXRpbWVvdXRcIixcbiAgICB0aW1lb3V0QXQ6IG5vdyxcbiAgICBsYXN0UHJvZ3Jlc3NBdDogbm93LFxuICAgIGxhc3RQcm9ncmVzc0tpbmQ6IHByb2dyZXNzS2luZCxcbiAgfSk7XG5cbiAgZGVwcy5lbWl0Sm91cm5hbEV2ZW50KHtcbiAgICB0czogbmV3IERhdGUobm93KS50b0lTT1N0cmluZygpLFxuICAgIGZsb3dJZDogaWMuZmxvd0lkLFxuICAgIHNlcTogaWMubmV4dFNlcSgpLFxuICAgIGV2ZW50VHlwZTogXCJ1bml0LWVuZFwiLFxuICAgIGRhdGE6IHtcbiAgICAgIHVuaXRUeXBlLFxuICAgICAgdW5pdElkLFxuICAgICAgc3RhdHVzOiBcInRpbWVkLW91dC1maW5hbGl6ZVwiLFxuICAgICAgYXJ0aWZhY3RWZXJpZmllZDogZmFsc2UsXG4gICAgICBmaW5hbGl6ZVN0YWdlOiBzdGFnZSxcbiAgICB9LFxuICB9KTtcblxuICBsb29wU3RhdGUuY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzKys7XG4gIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgIHBoYXNlOiBwcm9ncmVzc0tpbmQsXG4gICAgaXRlcmF0aW9uOiBpYy5pdGVyYXRpb24sXG4gICAgdW5pdFR5cGUsXG4gICAgdW5pdElkLFxuICAgIGNvbnNlY3V0aXZlVGltZW91dHM6IGxvb3BTdGF0ZS5jb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHMsXG4gIH0pO1xuXG4gIGN0eC51aS5ub3RpZnkoXG4gICAgYCR7c3RhZ2UgPT09IFwicHJlXCIgPyBcInBvc3RVbml0UHJlVmVyaWZpY2F0aW9uXCIgOiBcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblwifSB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0TXMgLyAxMDAwfXMgZm9yICR7dW5pdFR5cGV9ICR7dW5pdElkfSAoJHtsb29wU3RhdGUuY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzfS8ke01BWF9GSU5BTElaRV9USU1FT1VUU30pIFx1MjAxNCBwYXVzaW5nIGF1dG8tbW9kZSBmb3IgcmVjb3ZlcnkuYCxcbiAgICBcIndhcm5pbmdcIixcbiAgKTtcblxuICBhd2FpdCBkZXBzLnBhdXNlQXV0byhjdHgsIHBpKTtcbiAgcy5jdXJyZW50VW5pdCA9IG51bGw7XG4gIGNsZWFyQ3VycmVudFBoYXNlKCk7XG4gIGRyYWluTG9ncygpO1xuICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBwcm9ncmVzc0tpbmQgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJ1blByZURpc3BhdGNoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFBoYXNlIDE6IFByZS1kaXNwYXRjaCBcdTIwMTQgcmVzb3VyY2UgZ3VhcmQsIGhlYWx0aCBnYXRlLCBzdGF0ZSBkZXJpdmF0aW9uLFxuICogbWlsZXN0b25lIHRyYW5zaXRpb24sIHRlcm1pbmFsIGNvbmRpdGlvbnMuXG4gKiBSZXR1cm5zIGJyZWFrIHRvIGV4aXQgdGhlIGxvb3AsIG9yIG5leHQgd2l0aCBQcmVEaXNwYXRjaERhdGEgb24gc3VjY2Vzcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1blByZURpc3BhdGNoKFxuICBpYzogSXRlcmF0aW9uQ29udGV4dCxcbiAgbG9vcFN0YXRlOiBMb29wU3RhdGUsXG4pOiBQcm9taXNlPFBoYXNlUmVzdWx0PFByZURpc3BhdGNoRGF0YT4+IHtcbiAgY29uc3QgeyBjdHgsIHBpLCBzLCBkZXBzLCBwcmVmcyB9ID0gaWM7XG4gIGNvbnN0IHVva0ZsYWdzID0gcmVzb2x2ZVVva0ZsYWdzKHByZWZzKTtcbiAgY29uc3QgcnVuUHJlRGlzcGF0Y2hHYXRlID0gYXN5bmMgKGlucHV0OiB7XG4gICAgZ2F0ZUlkOiBzdHJpbmc7XG4gICAgZ2F0ZVR5cGU6IHN0cmluZztcbiAgICBvdXRjb21lOiBcInBhc3NcIiB8IFwiZmFpbFwiIHwgXCJyZXRyeVwiIHwgXCJtYW51YWwtYXR0ZW50aW9uXCI7XG4gICAgZmFpbHVyZUNsYXNzOiBcIm5vbmVcIiB8IFwicG9saWN5XCIgfCBcImlucHV0XCIgfCBcImV4ZWN1dGlvblwiIHwgXCJhcnRpZmFjdFwiIHwgXCJ2ZXJpZmljYXRpb25cIiB8IFwiY2xvc2VvdXRcIiB8IFwiZ2l0XCIgfCBcInRpbWVvdXRcIiB8IFwibWFudWFsLWF0dGVudGlvblwiIHwgXCJ1bmtub3duXCI7XG4gICAgcmF0aW9uYWxlOiBzdHJpbmc7XG4gICAgZmluZGluZ3M/OiBzdHJpbmc7XG4gICAgbWlsZXN0b25lSWQ/OiBzdHJpbmc7XG4gIH0pOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBpZiAoIXVva0ZsYWdzLmdhdGVzKSByZXR1cm47XG4gICAgY29uc3QgZ2F0ZVJ1bm5lciA9IG5ldyBVb2tHYXRlUnVubmVyKCk7XG4gICAgZ2F0ZVJ1bm5lci5yZWdpc3Rlcih7XG4gICAgICBpZDogaW5wdXQuZ2F0ZUlkLFxuICAgICAgdHlwZTogaW5wdXQuZ2F0ZVR5cGUsXG4gICAgICBleGVjdXRlOiBhc3luYyAoKSA9PiAoe1xuICAgICAgICBvdXRjb21lOiBpbnB1dC5vdXRjb21lLFxuICAgICAgICBmYWlsdXJlQ2xhc3M6IGlucHV0LmZhaWx1cmVDbGFzcyxcbiAgICAgICAgcmF0aW9uYWxlOiBpbnB1dC5yYXRpb25hbGUsXG4gICAgICAgIGZpbmRpbmdzOiBpbnB1dC5maW5kaW5ncyA/PyBcIlwiLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgYXdhaXQgZ2F0ZVJ1bm5lci5ydW4oaW5wdXQuZ2F0ZUlkLCB7XG4gICAgICBiYXNlUGF0aDogcy5iYXNlUGF0aCxcbiAgICAgIHRyYWNlSWQ6IGBwcmUtZGlzcGF0Y2g6JHtpYy5mbG93SWR9YCxcbiAgICAgIHR1cm5JZDogYGl0ZXItJHtpYy5pdGVyYXRpb259YCxcbiAgICAgIG1pbGVzdG9uZUlkOiBpbnB1dC5taWxlc3RvbmVJZCA/PyBzLmN1cnJlbnRNaWxlc3RvbmVJZCA/PyB1bmRlZmluZWQsXG4gICAgICB1bml0VHlwZTogXCJwcmUtZGlzcGF0Y2hcIixcbiAgICAgIHVuaXRJZDogYGl0ZXItJHtpYy5pdGVyYXRpb259YCxcbiAgICB9KTtcbiAgfTtcblxuICAvLyBSZXNvdXJjZSB2ZXJzaW9uIGd1YXJkXG4gIGNvbnN0IHN0YWxlTXNnID0gZGVwcy5jaGVja1Jlc291cmNlc1N0YWxlKHMucmVzb3VyY2VWZXJzaW9uT25TdGFydCk7XG4gIGlmIChzdGFsZU1zZykge1xuICAgIGF3YWl0IHJ1blByZURpc3BhdGNoR2F0ZSh7XG4gICAgICBnYXRlSWQ6IFwicmVzb3VyY2UtdmVyc2lvbi1ndWFyZFwiLFxuICAgICAgZ2F0ZVR5cGU6IFwicG9saWN5XCIsXG4gICAgICBvdXRjb21lOiBcImZhaWxcIixcbiAgICAgIGZhaWx1cmVDbGFzczogXCJwb2xpY3lcIixcbiAgICAgIHJhdGlvbmFsZTogXCJyZXNvdXJjZSB2ZXJzaW9uIGd1YXJkIGJsb2NrZWQgZGlzcGF0Y2hcIixcbiAgICAgIGZpbmRpbmdzOiBzdGFsZU1zZyxcbiAgICB9KTtcbiAgICBhd2FpdCBkZXBzLnN0b3BBdXRvKGN0eCwgcGksIHN0YWxlTXNnKTtcbiAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwiZXhpdFwiLCByZWFzb246IFwicmVzb3VyY2VzLXN0YWxlXCIgfSk7XG4gICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJyZXNvdXJjZXMtc3RhbGVcIiB9O1xuICB9XG4gIGF3YWl0IHJ1blByZURpc3BhdGNoR2F0ZSh7XG4gICAgZ2F0ZUlkOiBcInJlc291cmNlLXZlcnNpb24tZ3VhcmRcIixcbiAgICBnYXRlVHlwZTogXCJwb2xpY3lcIixcbiAgICBvdXRjb21lOiBcInBhc3NcIixcbiAgICBmYWlsdXJlQ2xhc3M6IFwibm9uZVwiLFxuICAgIHJhdGlvbmFsZTogXCJyZXNvdXJjZSB2ZXJzaW9uIGd1YXJkIHBhc3NlZFwiLFxuICB9KTtcblxuICBkZXBzLmludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgcy5sYXN0UHJvbXB0Q2hhckNvdW50ID0gdW5kZWZpbmVkO1xuICBzLmxhc3RCYXNlbGluZUNoYXJDb3VudCA9IHVuZGVmaW5lZDtcblxuICAvLyBQcmUtZGlzcGF0Y2ggaGVhbHRoIGdhdGVcbiAgdHJ5IHtcbiAgICBjb25zdCBoZWFsdGhHYXRlID0gYXdhaXQgZGVwcy5wcmVEaXNwYXRjaEhlYWx0aEdhdGUocy5iYXNlUGF0aCk7XG4gICAgaWYgKGhlYWx0aEdhdGUuZml4ZXNBcHBsaWVkLmxlbmd0aCA+IDApIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBQcmUtZGlzcGF0Y2g6ICR7aGVhbHRoR2F0ZS5maXhlc0FwcGxpZWQuam9pbihcIiwgXCIpfWAsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCFoZWFsdGhHYXRlLnByb2NlZWQpIHtcbiAgICAgIGF3YWl0IHJ1blByZURpc3BhdGNoR2F0ZSh7XG4gICAgICAgIGdhdGVJZDogXCJwcmUtZGlzcGF0Y2gtaGVhbHRoLWdhdGVcIixcbiAgICAgICAgZ2F0ZVR5cGU6IFwiZXhlY3V0aW9uXCIsXG4gICAgICAgIG91dGNvbWU6IFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgICAgICBmYWlsdXJlQ2xhc3M6IFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgICAgICByYXRpb25hbGU6IFwicHJlLWRpc3BhdGNoIGhlYWx0aCBnYXRlIGJsb2NrZWQgZGlzcGF0Y2hcIixcbiAgICAgICAgZmluZGluZ3M6IGhlYWx0aEdhdGUucmVhc29uLFxuICAgICAgfSk7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBoZWFsdGhHYXRlLnJlYXNvbiB8fCBcIlByZS1kaXNwYXRjaCBoZWFsdGggY2hlY2sgZmFpbGVkIFx1MjAxNCBydW4gL2dzZCBkb2N0b3IgZm9yIGRldGFpbHMuXCIsXG4gICAgICAgIFwiZXJyb3JcIixcbiAgICAgICk7XG4gICAgICBhd2FpdCBkZXBzLnBhdXNlQXV0byhjdHgsIHBpKTtcbiAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJleGl0XCIsIHJlYXNvbjogXCJoZWFsdGgtZ2F0ZS1mYWlsZWRcIiB9KTtcbiAgICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwiaGVhbHRoLWdhdGUtZmFpbGVkXCIgfTtcbiAgICB9XG4gICAgYXdhaXQgcnVuUHJlRGlzcGF0Y2hHYXRlKHtcbiAgICAgIGdhdGVJZDogXCJwcmUtZGlzcGF0Y2gtaGVhbHRoLWdhdGVcIixcbiAgICAgIGdhdGVUeXBlOiBcImV4ZWN1dGlvblwiLFxuICAgICAgb3V0Y29tZTogXCJwYXNzXCIsXG4gICAgICBmYWlsdXJlQ2xhc3M6IFwibm9uZVwiLFxuICAgICAgcmF0aW9uYWxlOiBcInByZS1kaXNwYXRjaCBoZWFsdGggZ2F0ZSBwYXNzZWRcIixcbiAgICAgIGZpbmRpbmdzOiBoZWFsdGhHYXRlLmZpeGVzQXBwbGllZC5sZW5ndGggPiAwID8gaGVhbHRoR2F0ZS5maXhlc0FwcGxpZWQuam9pbihcIiwgXCIpIDogXCJcIixcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGF3YWl0IHJ1blByZURpc3BhdGNoR2F0ZSh7XG4gICAgICBnYXRlSWQ6IFwicHJlLWRpc3BhdGNoLWhlYWx0aC1nYXRlXCIsXG4gICAgICBnYXRlVHlwZTogXCJleGVjdXRpb25cIixcbiAgICAgIG91dGNvbWU6IFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgICAgZmFpbHVyZUNsYXNzOiBcIm1hbnVhbC1hdHRlbnRpb25cIixcbiAgICAgIHJhdGlvbmFsZTogXCJwcmUtZGlzcGF0Y2ggaGVhbHRoIGdhdGUgdGhyZXcgdW5leHBlY3RlZGx5XCIsXG4gICAgICBmaW5kaW5nczogU3RyaW5nKGUpLFxuICAgIH0pO1xuICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgXCJQcmUtZGlzcGF0Y2ggaGVhbHRoIGdhdGUgdGhyZXcgdW5leHBlY3RlZGx5XCIsIHsgZXJyb3I6IFN0cmluZyhlKSB9KTtcbiAgfVxuXG4gIC8vIFN5bmMgcHJvamVjdCByb290IGFydGlmYWN0cyBpbnRvIHdvcmt0cmVlXG4gIGlmIChcbiAgICBzLm9yaWdpbmFsQmFzZVBhdGggJiZcbiAgICAhaXNTYW1lUGF0aExvY2FsKHMuYmFzZVBhdGgsIHMub3JpZ2luYWxCYXNlUGF0aCkgJiZcbiAgICBzLmN1cnJlbnRNaWxlc3RvbmVJZCAmJlxuICAgIHMuc2NvcGVcbiAgKSB7XG4gICAgZGVwcy53b3JrdHJlZVByb2plY3Rpb24ucHJvamVjdFJvb3RUb1dvcmt0cmVlKHMuc2NvcGUpO1xuICB9XG5cbiAgLy8gRGVyaXZlIHN0YXRlIFx1MjAxNCB1c2UgY2Fub25pY2FsIHByb2plY3Qgcm9vdCBzbyB0aGUgY2FjaGUga2V5IGlzIHN0YWJsZVxuICAvLyBhY3Jvc3Mgd29ya3RyZWVcdTIxOTRwcm9qZWN0LXJvb3QgcGF0aC1mb3JtIGFsdGVybmF0aW9uLiBTZWUgUFIgIzUyMzZcbiAgLy8gKHdvcmtzcGFjZSBoYW5kbGUgaW5mcmFzdHJ1Y3R1cmUpIGFuZCB0aGUgUGhhc2UgQSBwdCAyIHBsYW4uXG4gIGxldCBzdGF0ZSA9IGF3YWl0IGRlcHMuZGVyaXZlU3RhdGUocy5jYW5vbmljYWxQcm9qZWN0Um9vdCk7XG4gIGNvbnN0IHsgZ2V0RGVlcFN0YWdlR2F0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by1kaXNwYXRjaC5qc1wiKTtcbiAgY29uc3QgZGVlcFN0YWdlR2F0ZSA9IGdldERlZXBTdGFnZUdhdGUocHJlZnMsIHMuYmFzZVBhdGgpO1xuICBjb25zdCBjYW5SdW5EZWVwU2V0dXBHYXRlID1cbiAgICBzdGF0ZS5waGFzZSA9PT0gXCJwcmUtcGxhbm5pbmdcIiB8fFxuICAgIHN0YXRlLnBoYXNlID09PSBcIm5lZWRzLWRpc2N1c3Npb25cIiB8fFxuICAgIHN0YXRlLnBoYXNlID09PSBcInBsYW5uaW5nXCI7XG4gIGlmIChcbiAgICBjYW5SdW5EZWVwU2V0dXBHYXRlICYmXG4gICAgKGRlZXBTdGFnZUdhdGUuc3RhdHVzID09PSBcInBlbmRpbmdcIiB8fCBkZWVwU3RhZ2VHYXRlLnN0YXR1cyA9PT0gXCJibG9ja2VkXCIpXG4gICkge1xuICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgcGhhc2U6IFwiZGVlcC1wcm9qZWN0LXN0YWdlLWdhdGVcIixcbiAgICAgIHN0YWdlOiBkZWVwU3RhZ2VHYXRlLnN0YWdlLFxuICAgICAgc3RhdHVzOiBkZWVwU3RhZ2VHYXRlLnN0YXR1cyxcbiAgICAgIHJlYXNvbjogZGVlcFN0YWdlR2F0ZS5yZWFzb24sXG4gICAgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGlvbjogXCJuZXh0XCIsXG4gICAgICBkYXRhOiB7XG4gICAgICAgIHN0YXRlOiB7XG4gICAgICAgICAgLi4uc3RhdGUsXG4gICAgICAgICAgcGhhc2U6IFwicHJlLXBsYW5uaW5nXCIsXG4gICAgICAgICAgYWN0aXZlTWlsZXN0b25lOiBudWxsLFxuICAgICAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICAgICAgbmV4dEFjdGlvbjogZGVlcFN0YWdlR2F0ZS5yZWFzb24sXG4gICAgICAgIH0sXG4gICAgICAgIG1pZDogXCJQUk9KRUNUXCIsXG4gICAgICAgIG1pZFRpdGxlOiBcIlByb2plY3Qgc2V0dXBcIixcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGlmICh1b2tGbGFncy5wbGFuVjIgJiYgc2hvdWxkUnVuUGxhblYyR2F0ZShzdGF0ZS5waGFzZSkpIHtcbiAgICBsZXQgY29tcGlsZWQgPSBlbnN1cmVQbGFuVjJHcmFwaChzLmJhc2VQYXRoLCBzdGF0ZSk7XG4gICAgaWYgKGlzRW1wdHlQbGFuVjJHcmFwaFJlc3VsdChjb21waWxlZCkpIHtcbiAgICAgIGRlcHMuaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgc3RhdGUgPSBhd2FpdCBkZXBzLmRlcml2ZVN0YXRlKHMuY2Fub25pY2FsUHJvamVjdFJvb3QpO1xuICAgICAgY29tcGlsZWQgPSBzaG91bGRSdW5QbGFuVjJHYXRlKHN0YXRlLnBoYXNlKVxuICAgICAgICA/IGVuc3VyZVBsYW5WMkdyYXBoKHMuYmFzZVBhdGgsIHN0YXRlKVxuICAgICAgICA6IHtcbiAgICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgICAgcmVhc29uOiBcImVtcHR5IHBsYW4tdjIgZ3JhcGggcmVjb3ZlcmVkIGJ5IHN0YXRlIHJlZGVyaXZlXCIsXG4gICAgICAgICAgICBub2RlQ291bnQ6IDAsXG4gICAgICAgICAgfTtcbiAgICB9XG4gICAgaWYgKCFjb21waWxlZC5vaykge1xuICAgICAgY29uc3QgcmVhc29uID0gY29tcGlsZWQucmVhc29uID8/IFwiUGxhbiB2MiBjb21waWxhdGlvbiBmYWlsZWRcIjtcbiAgICAgIGlmIChpc01pc3NpbmdGaW5hbGl6ZWRDb250ZXh0UmVzdWx0KGNvbXBpbGVkKSkge1xuICAgICAgICBhd2FpdCBydW5QcmVEaXNwYXRjaEdhdGUoe1xuICAgICAgICAgIGdhdGVJZDogXCJwbGFuLXYyLWdhdGVcIixcbiAgICAgICAgICBnYXRlVHlwZTogXCJwb2xpY3lcIixcbiAgICAgICAgICBvdXRjb21lOiBcInBhc3NcIixcbiAgICAgICAgICBmYWlsdXJlQ2xhc3M6IFwibm9uZVwiLFxuICAgICAgICAgIHJhdGlvbmFsZTogXCJwbGFuIHYyIG1pc3NpbmcgY29udGV4dCByZWNvdmVyeSBkZWZlcnJlZCB0byBkaXNwYXRjaFwiLFxuICAgICAgICAgIGZpbmRpbmdzOiByZWFzb24sXG4gICAgICAgICAgbWlsZXN0b25lSWQ6IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQgPz8gdW5kZWZpbmVkLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGF3YWl0IHJ1blByZURpc3BhdGNoR2F0ZSh7XG4gICAgICAgICAgZ2F0ZUlkOiBcInBsYW4tdjItZ2F0ZVwiLFxuICAgICAgICAgIGdhdGVUeXBlOiBcInBvbGljeVwiLFxuICAgICAgICAgIG91dGNvbWU6IFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJtYW51YWwtYXR0ZW50aW9uXCIsXG4gICAgICAgICAgcmF0aW9uYWxlOiBcInBsYW4gdjIgY29tcGlsZSBnYXRlIGZhaWxlZFwiLFxuICAgICAgICAgIGZpbmRpbmdzOiByZWFzb24sXG4gICAgICAgICAgbWlsZXN0b25lSWQ6IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQgPz8gdW5kZWZpbmVkLFxuICAgICAgICB9KTtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShgUGxhbiBnYXRlIGZhaWxlZC1jbG9zZWQ6ICR7cmVhc29ufVxcblxcbklmIHRoaXMga2VlcHMgaGFwcGVuaW5nLCB0cnk6IC9nc2QgZG9jdG9yIGhlYWxgLCBcImVycm9yXCIpO1xuICAgICAgICBhd2FpdCBkZXBzLnBhdXNlQXV0byhjdHgsIHBpKTtcbiAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJwbGFuLXYyLWdhdGUtZmFpbGVkXCIgfTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKGNvbXBpbGVkLm9rKSB7XG4gICAgICBhd2FpdCBydW5QcmVEaXNwYXRjaEdhdGUoe1xuICAgICAgICBnYXRlSWQ6IFwicGxhbi12Mi1nYXRlXCIsXG4gICAgICAgIGdhdGVUeXBlOiBcInBvbGljeVwiLFxuICAgICAgICBvdXRjb21lOiBcInBhc3NcIixcbiAgICAgICAgZmFpbHVyZUNsYXNzOiBcIm5vbmVcIixcbiAgICAgICAgcmF0aW9uYWxlOiBcInBsYW4gdjIgY29tcGlsZSBnYXRlIHBhc3NlZFwiLFxuICAgICAgICBtaWxlc3RvbmVJZDogc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZCA/PyB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbiAgZGVwcy5zeW5jQ211eFNpZGViYXIocHJlZnMsIHN0YXRlKTtcbiAgbGV0IG1pZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQ7XG4gIGxldCBtaWRUaXRsZSA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8udGl0bGU7XG4gIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgIHBoYXNlOiBcInN0YXRlLWRlcml2ZWRcIixcbiAgICBpdGVyYXRpb246IGljLml0ZXJhdGlvbixcbiAgICBtaWQsXG4gICAgc3RhdGVQaGFzZTogc3RhdGUucGhhc2UsXG4gIH0pO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBTbGljZS1sZXZlbCBwYXJhbGxlbGlzbSBnYXRlICgjMjM0MCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIFdoZW4gc2xpY2VfcGFyYWxsZWwgaXMgZW5hYmxlZCwgY2hlY2sgaWYgbXVsdGlwbGUgc2xpY2VzIGFyZSBlbGlnaWJsZVxuICAvLyBmb3IgcGFyYWxsZWwgZXhlY3V0aW9uLiBJZiBzbywgZGlzcGF0Y2ggdGhlbSBpbiBwYXJhbGxlbCBhbmQgc3RvcCB0aGVcbiAgLy8gc2VxdWVudGlhbCBsb29wLiBXb3JrZXJzIGFyZSBzcGF3bmVkIHZpYSBzbGljZS1wYXJhbGxlbC1vcmNoZXN0cmF0b3IudHMuXG4gIGlmIChcbiAgICBwcmVmcz8uc2xpY2VfcGFyYWxsZWw/LmVuYWJsZWQgJiZcbiAgICBtaWQgJiZcbiAgICAhcHJvY2Vzcy5lbnYuR1NEX1BBUkFMTEVMX1dPUktFUiAmJlxuICAgIGlzRGJBdmFpbGFibGUoKVxuICApIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGJTbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMobWlkKTtcbiAgICAgIGlmIChkYlNsaWNlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IGRvbmVJZHMgPSBuZXcgU2V0KGRiU2xpY2VzLmZpbHRlcihzbCA9PiBzbC5zdGF0dXMgPT09IFwiY29tcGxldGVcIiB8fCBzbC5zdGF0dXMgPT09IFwiZG9uZVwiKS5tYXAoc2wgPT4gc2wuaWQpKTtcbiAgICAgICAgY29uc3Qgc2xpY2VJbnB1dHMgPSBkYlNsaWNlcy5tYXAoc2wgPT4gKHtcbiAgICAgICAgICBpZDogc2wuaWQsXG4gICAgICAgICAgZG9uZTogZG9uZUlkcy5oYXMoc2wuaWQpLFxuICAgICAgICAgIGRlcGVuZHM6IHNsLmRlcGVuZHMgPz8gW10sXG4gICAgICAgIH0pKTtcbiAgICAgICAgY29uc3QgZWxpZ2libGUgPSBnZXRFbGlnaWJsZVNsaWNlcyhzbGljZUlucHV0cywgZG9uZUlkcyk7XG4gICAgICAgIGlmIChlbGlnaWJsZS5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgICAgICAgICBwaGFzZTogXCJzbGljZS1wYXJhbGxlbC1kaXNwYXRjaFwiLFxuICAgICAgICAgICAgaXRlcmF0aW9uOiBpYy5pdGVyYXRpb24sXG4gICAgICAgICAgICBtaWQsXG4gICAgICAgICAgICBlbGlnaWJsZVNsaWNlczogZWxpZ2libGUubWFwKGUgPT4gZS5pZCksXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBTbGljZS1wYXJhbGxlbDogZGlzcGF0Y2hpbmcgJHtlbGlnaWJsZS5sZW5ndGh9IGVsaWdpYmxlIHNsaWNlcyBmb3IgJHttaWR9LmAsXG4gICAgICAgICAgICBcImluZm9cIixcbiAgICAgICAgICApO1xuICAgICAgICAgIC8vIEFEUi0wMTcgIzU3MDc6IHJlY29uY2lsZSBiZWZvcmUgc3Bhd25pbmcgc28gZWFjaCB3b3JrZXIgZG9lc24ndFxuICAgICAgICAgIC8vIGluZGVwZW5kZW50bHkgcmFjZSBvbiB0aGUgc2FtZSBkcmlmdC4gRmFpbHVyZSBhYm9ydHMgdGhlIHNwYXduLlxuICAgICAgICAgIGNvbnN0IHNwYXduR2F0ZSA9IGF3YWl0IHJlY29uY2lsZUJlZm9yZVNwYXduKHMuYmFzZVBhdGgpO1xuICAgICAgICAgIGlmICghc3Bhd25HYXRlLm9rKSB7XG4gICAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgICBgU2xpY2UtcGFyYWxsZWw6IGFib3J0aW5nIHNwYXduIFx1MjAxNCAke3NwYXduR2F0ZS5yZWFzb259YCxcbiAgICAgICAgICAgICAgXCJlcnJvclwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IGBzbGljZS1wYXJhbGxlbC1yZWNvbmNpbGlhdGlvbi1mYWlsZWQ6ICR7c3Bhd25HYXRlLnJlYXNvbn1gIH07XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHN0YXJ0U2xpY2VQYXJhbGxlbChcbiAgICAgICAgICAgIHMuYmFzZVBhdGgsXG4gICAgICAgICAgICBtaWQsXG4gICAgICAgICAgICBlbGlnaWJsZSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgbWF4V29ya2VyczogcHJlZnMuc2xpY2VfcGFyYWxsZWwubWF4X3dvcmtlcnMgPz8gMixcbiAgICAgICAgICAgICAgdXNlRXhlY3V0aW9uR3JhcGg6IHVva0ZsYWdzLmV4ZWN1dGlvbkdyYXBoLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmIChyZXN1bHQuc3RhcnRlZC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgICBgU2xpY2UtcGFyYWxsZWw6IHN0YXJ0ZWQgJHtyZXN1bHQuc3RhcnRlZC5sZW5ndGh9IHdvcmtlcihzKTogJHtyZXN1bHQuc3RhcnRlZC5qb2luKFwiLCBcIil9LmAsXG4gICAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgYFNsaWNlLXBhcmFsbGVsIGRpc3BhdGNoZWQgZm9yICR7bWlkfWApO1xuICAgICAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJzbGljZS1wYXJhbGxlbC1kaXNwYXRjaGVkXCIgfTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gRmFsbCB0aHJvdWdoIHRvIHNlcXVlbnRpYWwgaWYgbm8gd29ya2VycyBzdGFydGVkXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICBwaGFzZTogXCJzbGljZS1wYXJhbGxlbC1jaGVjay1lcnJvclwiLFxuICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgfSk7XG4gICAgICAvLyBOb24tZmF0YWwgXHUyMDE0IGZhbGwgdGhyb3VnaCB0byBzZXF1ZW50aWFsIGRpc3BhdGNoXG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIE1pbGVzdG9uZSB0cmFuc2l0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAobWlkICYmIHMuY3VycmVudE1pbGVzdG9uZUlkICYmIG1pZCAhPT0gcy5jdXJyZW50TWlsZXN0b25lSWQpIHtcbiAgICBkZXBzLmVtaXRKb3VybmFsRXZlbnQoeyB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBmbG93SWQ6IGljLmZsb3dJZCwgc2VxOiBpYy5uZXh0U2VxKCksIGV2ZW50VHlwZTogXCJtaWxlc3RvbmUtdHJhbnNpdGlvblwiLCBkYXRhOiB7IGZyb206IHMuY3VycmVudE1pbGVzdG9uZUlkLCB0bzogbWlkIH0gfSk7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBNaWxlc3RvbmUgJHtzLmN1cnJlbnRNaWxlc3RvbmVJZH0gY29tcGxldGUuIEFkdmFuY2luZyB0byAke21pZH06ICR7bWlkVGl0bGV9LmAsXG4gICAgICBcImluZm9cIixcbiAgICApO1xuICAgIGRlcHMuc2VuZERlc2t0b3BOb3RpZmljYXRpb24oXG4gICAgICBcIkdTRFwiLFxuICAgICAgYE1pbGVzdG9uZSAke3MuY3VycmVudE1pbGVzdG9uZUlkfSBjb21wbGV0ZSFgLFxuICAgICAgXCJzdWNjZXNzXCIsXG4gICAgICBcIm1pbGVzdG9uZVwiLFxuICAgICAgYmFzZW5hbWUocy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGgpLFxuICAgICk7XG4gICAgZGVwcy5sb2dDbXV4RXZlbnQoXG4gICAgICBwcmVmcyxcbiAgICAgIGBNaWxlc3RvbmUgJHtzLmN1cnJlbnRNaWxlc3RvbmVJZH0gY29tcGxldGUuIEFkdmFuY2luZyB0byAke21pZH0uYCxcbiAgICAgIFwic3VjY2Vzc1wiLFxuICAgICk7XG5cbiAgICBjb25zdCB2aXpQcmVmcyA9IHByZWZzO1xuICAgIGlmICh2aXpQcmVmcz8uYXV0b192aXN1YWxpemUpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXCJSdW4gL2dzZCB2aXN1YWxpemUgdG8gc2VlIHByb2dyZXNzIG92ZXJ2aWV3LlwiLCBcImluZm9cIik7XG4gICAgfVxuICAgIGlmICh2aXpQcmVmcz8uYXV0b19yZXBvcnQgIT09IGZhbHNlKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBnZW5lcmF0ZU1pbGVzdG9uZVJlcG9ydChzLCBjdHgsIHMuY3VycmVudE1pbGVzdG9uZUlkISk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgUmVwb3J0IGdlbmVyYXRpb24gZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFJlc2V0IGRpc3BhdGNoIGNvdW50ZXJzIGZvciBuZXcgbWlsZXN0b25lXG4gICAgcy51bml0RGlzcGF0Y2hDb3VudC5jbGVhcigpO1xuICAgIHMudW5pdFJlY292ZXJ5Q291bnQuY2xlYXIoKTtcbiAgICBzLnVuaXRMaWZldGltZURpc3BhdGNoZXMuY2xlYXIoKTtcbiAgICBsb29wU3RhdGUucmVjZW50VW5pdHMubGVuZ3RoID0gMDtcbiAgICBsb29wU3RhdGUuc3R1Y2tSZWNvdmVyeUF0dGVtcHRzID0gMDtcblxuICAgIC8vIFdvcmt0cmVlIGxpZmVjeWNsZSBvbiBtaWxlc3RvbmUgdHJhbnNpdGlvbiBcdTIwMTQgbWVyZ2UgY3VycmVudCwgZW50ZXIgbmV4dC5cbiAgICAvLyAjMjkwOSAvICM1NTM4LWZvbGxvd3VwOiBwcmVmbGlnaHQgc3Rhc2ggKyBhbHdheXMtb24gcG9zdGZsaWdodCBwb3AuXG4gICAge1xuICAgICAgY29uc3Qgc3RvcCA9IGF3YWl0IF9ydW5NaWxlc3RvbmVNZXJnZU9uY2VXaXRoU3Rhc2hSZXN0b3JlKGljLCBzLmN1cnJlbnRNaWxlc3RvbmVJZCEpO1xuICAgICAgaWYgKHN0b3ApIHJldHVybiBzdG9wO1xuICAgIH1cblxuICAgIC8vIFBSIGNyZWF0aW9uIChhdXRvX3ByKSBpcyBoYW5kbGVkIGluc2lkZSBtZXJnZU1pbGVzdG9uZVRvTWFpbiAoIzIzMDIpXG5cbiAgICBkZXBzLmludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICAgIHN0YXRlID0gYXdhaXQgZGVwcy5kZXJpdmVTdGF0ZShzLmNhbm9uaWNhbFByb2plY3RSb290KTtcbiAgICBtaWQgPSBzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkO1xuICAgIG1pZFRpdGxlID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lPy50aXRsZTtcblxuICAgIGlmIChtaWQpIHtcbiAgICAgIGlmIChkZXBzLmdldElzb2xhdGlvbk1vZGUocy5iYXNlUGF0aCkgIT09IFwibm9uZVwiKSB7XG4gICAgICAgIGRlcHMuY2FwdHVyZUludGVncmF0aW9uQnJhbmNoKHMuYmFzZVBhdGgsIG1pZCk7XG4gICAgICB9XG4gICAgICBjb25zdCBlbnRlclJlc3VsdCA9IGRlcHMubGlmZWN5Y2xlLmVudGVyTWlsZXN0b25lKG1pZCwgY3R4LnVpKTtcbiAgICAgIGlmICghZW50ZXJSZXN1bHQub2spIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgTWlsZXN0b25lIHRyYW5zaXRpb24gc3RvcHBlZDogZmFpbGVkIHRvIGVudGVyICR7bWlkfSAoJHtlbnRlclJlc3VsdC5yZWFzb259KS5gLFxuICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKGVudGVyUmVzdWx0LnJlYXNvbiA9PT0gXCJsZWFzZS1jb25mbGljdFwiKSB7XG4gICAgICAgICAgYXdhaXQgZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJtaWxlc3RvbmUtZW50ZXItZmFpbGVkXCIgfTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gbWlkIGlzIHVuZGVmaW5lZCBcdTIwMTQgbm8gbWlsZXN0b25lIHRvIGNhcHR1cmUgaW50ZWdyYXRpb24gYnJhbmNoIGZvclxuICAgIH1cblxuICAgIGNvbnN0IHBlbmRpbmdJZHMgPSBzdGF0ZS5yZWdpc3RyeVxuICAgICAgLmZpbHRlcihcbiAgICAgICAgKG06IHsgc3RhdHVzOiBzdHJpbmcgfSkgPT5cbiAgICAgICAgICBtLnN0YXR1cyAhPT0gXCJjb21wbGV0ZVwiICYmIG0uc3RhdHVzICE9PSBcInBhcmtlZFwiLFxuICAgICAgKVxuICAgICAgLm1hcCgobTogeyBpZDogc3RyaW5nIH0pID0+IG0uaWQpO1xuICAgIGRlcHMucHJ1bmVRdWV1ZU9yZGVyKHMuYmFzZVBhdGgsIHBlbmRpbmdJZHMpO1xuXG4gICAgLy8gQXJjaGl2ZSB0aGUgb2xkIGNvbXBsZXRlZC11bml0cy5qc29uIGluc3RlYWQgb2Ygd2lwaW5nIGl0ICgjMjMxMykuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGNvbXBsZXRlZEtleXNQYXRoID0gam9pbihnc2RSb290KHMuYmFzZVBhdGgpLCBcImNvbXBsZXRlZC11bml0cy5qc29uXCIpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMoY29tcGxldGVkS2V5c1BhdGgpICYmIHMuY3VycmVudE1pbGVzdG9uZUlkKSB7XG4gICAgICAgIGNvbnN0IGFyY2hpdmVQYXRoID0gam9pbihcbiAgICAgICAgICBnc2RSb290KHMuYmFzZVBhdGgpLFxuICAgICAgICAgIGBjb21wbGV0ZWQtdW5pdHMtJHtzLmN1cnJlbnRNaWxlc3RvbmVJZH0uanNvbmAsXG4gICAgICAgICk7XG4gICAgICAgIGNwU3luYyhjb21wbGV0ZWRLZXlzUGF0aCwgYXJjaGl2ZVBhdGgpO1xuICAgICAgfVxuICAgICAgYXRvbWljV3JpdGVTeW5jKGNvbXBsZXRlZEtleXNQYXRoLCBKU09OLnN0cmluZ2lmeShbXSwgbnVsbCwgMikpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgXCJGYWlsZWQgdG8gYXJjaGl2ZSBjb21wbGV0ZWQtdW5pdHMgb24gbWlsZXN0b25lIHRyYW5zaXRpb25cIiwgeyBlcnJvcjogU3RyaW5nKGUpIH0pO1xuICAgIH1cblxuICAgIC8vIFJlYnVpbGQgU1RBVEUubWQgaW1tZWRpYXRlbHkgc28gaXQgcmVmbGVjdHMgdGhlIG5ldyBhY3RpdmUgbWlsZXN0b25lLlxuICAgIC8vIFRoaXMgYnlwYXNzZXMgdGhlIDMwLXNlY29uZCB0aHJvdHRsZSBpbiB0aGUgbm9ybWFsIHJlYnVpbGQgcGF0aCBcdTIwMTRcbiAgICAvLyBtaWxlc3RvbmUgdHJhbnNpdGlvbnMgYXJlIHJhcmUgYW5kIGltcG9ydGFudCBlbm91Z2ggdG8gd2FycmFudCBhblxuICAgIC8vIGltbWVkaWF0ZSB3cml0ZS5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgZGVwcy5yZWJ1aWxkU3RhdGUocy5iYXNlUGF0aCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBcIlNUQVRFLm1kIHJlYnVpbGQgZmFpbGVkIGFmdGVyIG1pbGVzdG9uZSB0cmFuc2l0aW9uXCIsIHsgZXJyb3I6IFN0cmluZyhlKSB9KTtcbiAgICB9XG4gIH1cblxuICBpZiAobWlkKSB7XG4gICAgcy5jdXJyZW50TWlsZXN0b25lSWQgPSBtaWQ7XG4gICAgZGVwcy5zZXRBY3RpdmVNaWxlc3RvbmVJZChzLmJhc2VQYXRoLCBtaWQpO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFRlcm1pbmFsIGNvbmRpdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgaWYgKCFtaWQpIHtcbiAgICBpZiAocy5jdXJyZW50VW5pdCkge1xuICAgICAgYXdhaXQgZGVwcy5jbG9zZW91dFVuaXQoXG4gICAgICAgIGN0eCxcbiAgICAgICAgcy5iYXNlUGF0aCxcbiAgICAgICAgcy5jdXJyZW50VW5pdC50eXBlLFxuICAgICAgICBzLmN1cnJlbnRVbml0LmlkLFxuICAgICAgICBzLmN1cnJlbnRVbml0LnN0YXJ0ZWRBdCxcbiAgICAgICAgZGVwcy5idWlsZFNuYXBzaG90T3B0cyhzLmN1cnJlbnRVbml0LnR5cGUsIHMuY3VycmVudFVuaXQuaWQpLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBpbmNvbXBsZXRlID0gc3RhdGUucmVnaXN0cnkuZmlsdGVyKFxuICAgICAgKG06IHsgc3RhdHVzOiBzdHJpbmcgfSkgPT5cbiAgICAgICAgbS5zdGF0dXMgIT09IFwiY29tcGxldGVcIiAmJiBtLnN0YXR1cyAhPT0gXCJwYXJrZWRcIixcbiAgICApO1xuICAgIGlmIChpbmNvbXBsZXRlLmxlbmd0aCA9PT0gMCAmJiBzdGF0ZS5yZWdpc3RyeS5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBBbGwgbWlsZXN0b25lcyBjb21wbGV0ZSBcdTIwMTQgbWVyZ2UgbWlsZXN0b25lIGJyYW5jaCBiZWZvcmUgc3RvcHBpbmcuXG4gICAgICBpZiAocy5jdXJyZW50TWlsZXN0b25lSWQpIHtcbiAgICAgICAgLy8gIzI5MDkgLyAjNTUzOC1mb2xsb3d1cDogcHJlZmxpZ2h0IHN0YXNoICsgYWx3YXlzLW9uIHBvc3RmbGlnaHQgcG9wLlxuICAgICAgICBjb25zdCBzdG9wID0gYXdhaXQgX3J1bk1pbGVzdG9uZU1lcmdlT25jZVdpdGhTdGFzaFJlc3RvcmUoaWMsIHMuY3VycmVudE1pbGVzdG9uZUlkKTtcbiAgICAgICAgaWYgKHN0b3ApIHJldHVybiBzdG9wO1xuICAgICAgICAvLyBQUiBjcmVhdGlvbiAoYXV0b19wcikgaXMgaGFuZGxlZCBpbnNpZGUgbWVyZ2VNaWxlc3RvbmVUb01haW4gKCMyMzAyKVxuICAgICAgfVxuICAgICAgZGVwcy5zZW5kRGVza3RvcE5vdGlmaWNhdGlvbihcbiAgICAgICAgXCJHU0RcIixcbiAgICAgICAgXCJBbGwgbWlsZXN0b25lcyBjb21wbGV0ZSFcIixcbiAgICAgICAgXCJzdWNjZXNzXCIsXG4gICAgICAgIFwibWlsZXN0b25lXCIsXG4gICAgICAgIGJhc2VuYW1lKHMub3JpZ2luYWxCYXNlUGF0aCB8fCBzLmJhc2VQYXRoKSxcbiAgICAgICk7XG4gICAgICBkZXBzLmxvZ0NtdXhFdmVudChcbiAgICAgICAgcHJlZnMsXG4gICAgICAgIFwiQWxsIG1pbGVzdG9uZXMgY29tcGxldGUuXCIsXG4gICAgICAgIFwic3VjY2Vzc1wiLFxuICAgICAgKTtcbiAgICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgXCJBbGwgbWlsZXN0b25lcyBjb21wbGV0ZVwiLCB7XG4gICAgICAgIGNvbXBsZXRpb25XaWRnZXQ6IHtcbiAgICAgICAgICBtaWxlc3RvbmVJZDogcy5jdXJyZW50TWlsZXN0b25lSWQsXG4gICAgICAgICAgbWlsZXN0b25lVGl0bGU6IG1pZFRpdGxlLFxuICAgICAgICAgIGFsbE1pbGVzdG9uZXNDb21wbGV0ZTogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgIH0gZWxzZSBpZiAoaW5jb21wbGV0ZS5sZW5ndGggPT09IDAgJiYgc3RhdGUucmVnaXN0cnkubGVuZ3RoID09PSAwKSB7XG4gICAgICAvLyBFbXB0eSByZWdpc3RyeSBcdTIwMTQgbm8gbWlsZXN0b25lcyB2aXNpYmxlLCBsaWtlbHkgYSBwYXRoIHJlc29sdXRpb24gYnVnXG4gICAgICBjb25zdCBkaWFnID0gYGJhc2VQYXRoPSR7cy5iYXNlUGF0aH0sIHBoYXNlPSR7c3RhdGUucGhhc2V9YDtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBObyBtaWxlc3RvbmVzIHZpc2libGUgaW4gY3VycmVudCBzY29wZS4gUG9zc2libGUgcGF0aCByZXNvbHV0aW9uIGlzc3VlLlxcbiAgIERpYWdub3N0aWM6ICR7ZGlhZ31gLFxuICAgICAgICBcImVycm9yXCIsXG4gICAgICApO1xuICAgICAgYXdhaXQgZGVwcy5zdG9wQXV0byhcbiAgICAgICAgY3R4LFxuICAgICAgICBwaSxcbiAgICAgICAgYE5vIG1pbGVzdG9uZXMgZm91bmQgXHUyMDE0IGNoZWNrIGJhc2VQYXRoIHJlc29sdXRpb25gLFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKHN0YXRlLnBoYXNlID09PSBcImJsb2NrZWRcIikge1xuICAgICAgY29uc3QgYmxvY2tlck1zZyA9IGBCbG9ja2VkOiAke3N0YXRlLmJsb2NrZXJzLmpvaW4oXCIsIFwiKX1gO1xuICAgICAgLy8gUGF1c2UgaW5zdGVhZCBvZiBoYXJkLXN0b3Agc28gdGhlIHNlc3Npb24gaXMgcmVzdW1hYmxlIHdpdGggYC9nc2QgYXV0b2AuXG4gICAgICAvLyBIYXJkLXN0b3AgaGVyZSB3YXMgY2F1c2luZyBwcmVtYXR1cmUgdGVybWluYXRpb24gd2hlbiBzbGljZSBkZXBlbmRlbmNpZXNcbiAgICAgIC8vIHdlcmUgdGVtcG9yYXJpbHkgdW5yZXNvbHZhYmxlIChlLmcuIGFmdGVyIHJlYXNzZXNzbWVudCBhZGRlZCBuZXcgc2xpY2VzKS5cbiAgICAgIGF3YWl0IGRlcHMucGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgY3R4LnVpLm5vdGlmeShgJHtibG9ja2VyTXNnfS4gRml4IGFuZCBydW4gL2dzZCBhdXRvIHRvIHJlc3VtZS5gLCBcIndhcm5pbmdcIik7XG4gICAgICBkZXBzLnNlbmREZXNrdG9wTm90aWZpY2F0aW9uKFwiR1NEXCIsIGJsb2NrZXJNc2csIFwid2FybmluZ1wiLCBcImF0dGVudGlvblwiLCBiYXNlbmFtZShzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCkpO1xuICAgICAgZGVwcy5sb2dDbXV4RXZlbnQocHJlZnMsIGJsb2NrZXJNc2csIFwid2FybmluZ1wiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaWRzID0gaW5jb21wbGV0ZS5tYXAoKG06IHsgaWQ6IHN0cmluZyB9KSA9PiBtLmlkKS5qb2luKFwiLCBcIik7XG4gICAgICBjb25zdCBkaWFnID0gYGJhc2VQYXRoPSR7cy5iYXNlUGF0aH0sIG1pbGVzdG9uZXM9WyR7c3RhdGUucmVnaXN0cnkubWFwKChtOiB7IGlkOiBzdHJpbmc7IHN0YXR1czogc3RyaW5nIH0pID0+IGAke20uaWR9OiR7bS5zdGF0dXN9YCkuam9pbihcIiwgXCIpfV0sIHBoYXNlPSR7c3RhdGUucGhhc2V9YDtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBVbmV4cGVjdGVkOiAke2luY29tcGxldGUubGVuZ3RofSBpbmNvbXBsZXRlIG1pbGVzdG9uZShzKSAoJHtpZHN9KSBidXQgbm8gYWN0aXZlIG1pbGVzdG9uZS5cXG4gICBEaWFnbm9zdGljOiAke2RpYWd9YCxcbiAgICAgICAgXCJlcnJvclwiLFxuICAgICAgKTtcbiAgICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oXG4gICAgICAgIGN0eCxcbiAgICAgICAgcGksXG4gICAgICAgIGBObyBhY3RpdmUgbWlsZXN0b25lIFx1MjAxNCAke2luY29tcGxldGUubGVuZ3RofSBpbmNvbXBsZXRlICgke2lkc30pLCBzZWUgZGlhZ25vc3RpYyBhYm92ZWAsXG4gICAgICApO1xuICAgIH1cbiAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwiZXhpdFwiLCByZWFzb246IFwibm8tYWN0aXZlLW1pbGVzdG9uZVwiIH0pO1xuICAgIGRlcHMuZW1pdEpvdXJuYWxFdmVudCh7IHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIGZsb3dJZDogaWMuZmxvd0lkLCBzZXE6IGljLm5leHRTZXEoKSwgZXZlbnRUeXBlOiBcInRlcm1pbmFsXCIsIGRhdGE6IHsgcmVhc29uOiBcIm5vLWFjdGl2ZS1taWxlc3RvbmVcIiB9IH0pO1xuICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwibm8tYWN0aXZlLW1pbGVzdG9uZVwiIH07XG4gIH1cblxuICBpZiAoIW1pZFRpdGxlKSB7XG4gICAgbWlkVGl0bGUgPSBtaWQ7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBNaWxlc3RvbmUgJHttaWR9IGhhcyBubyB0aXRsZSBpbiByb2FkbWFwIFx1MjAxNCB1c2luZyBJRCBhcyBmYWxsYmFjay5gLFxuICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgKTtcbiAgfVxuXG4gIC8vIE1pZC1tZXJnZSBzYWZldHkgY2hlY2tcbiAgY29uc3QgbWVyZ2VSZWNvbmNpbGVSZXN1bHQgPSBkZXBzLnJlY29uY2lsZU1lcmdlU3RhdGUocy5iYXNlUGF0aCwgY3R4KTtcbiAgaWYgKG1lcmdlUmVjb25jaWxlUmVzdWx0ID09PSBcImJsb2NrZWRcIikge1xuICAgIGF3YWl0IGRlcHMucGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJleGl0XCIsIHJlYXNvbjogXCJtZXJnZS1yZWNvbmNpbGlhdGlvbi1ibG9ja2VkXCIgfSk7XG4gICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJtZXJnZS1yZWNvbmNpbGlhdGlvbi1ibG9ja2VkXCIgfTtcbiAgfVxuICBpZiAobWVyZ2VSZWNvbmNpbGVSZXN1bHQgPT09IFwicmVjb25jaWxlZFwiKSB7XG4gICAgZGVwcy5pbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgc3RhdGUgPSBhd2FpdCBkZXBzLmRlcml2ZVN0YXRlKHMuY2Fub25pY2FsUHJvamVjdFJvb3QpO1xuICAgIG1pZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQ7XG4gICAgbWlkVGl0bGUgPSBzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LnRpdGxlO1xuICB9XG5cbiAgaWYgKCFtaWQgfHwgIW1pZFRpdGxlKSB7XG4gICAgY29uc3Qgbm9NaWxlc3RvbmVSZWFzb24gPSAhbWlkXG4gICAgICA/IFwiTm8gYWN0aXZlIG1pbGVzdG9uZSBhZnRlciBtZXJnZSByZWNvbmNpbGlhdGlvblwiXG4gICAgICA6IGBNaWxlc3RvbmUgJHttaWR9IGhhcyBubyB0aXRsZSBhZnRlciByZWNvbmNpbGlhdGlvbmA7XG4gICAgYXdhaXQgY2xvc2VvdXRBbmRTdG9wKGN0eCwgcGksIHMsIGRlcHMsIG5vTWlsZXN0b25lUmVhc29uKTtcbiAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICAgIHBoYXNlOiBcImV4aXRcIixcbiAgICAgIHJlYXNvbjogXCJuby1taWxlc3RvbmUtYWZ0ZXItcmVjb25jaWxpYXRpb25cIixcbiAgICB9KTtcbiAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBcIm5vLW1pbGVzdG9uZS1hZnRlci1yZWNvbmNpbGlhdGlvblwiIH07XG4gIH1cblxuICAvLyBUZXJtaW5hbDogY29tcGxldGVcbiAgaWYgKHN0YXRlLnBoYXNlID09PSBcImNvbXBsZXRlXCIpIHtcbiAgICAvLyBNaWxlc3RvbmUgbWVyZ2Ugb24gY29tcGxldGUgKGJlZm9yZSBjbG9zZW91dCBzbyBicmFuY2ggc3RhdGUgaXMgY2xlYW4pLlxuICAgIGlmIChzLmN1cnJlbnRNaWxlc3RvbmVJZCkge1xuICAgICAgLy8gIzI5MDkgLyAjNTUzOC1mb2xsb3d1cDogcHJlZmxpZ2h0IHN0YXNoICsgYWx3YXlzLW9uIHBvc3RmbGlnaHQgcG9wLlxuICAgICAgY29uc3Qgc3RvcCA9IGF3YWl0IF9ydW5NaWxlc3RvbmVNZXJnZU9uY2VXaXRoU3Rhc2hSZXN0b3JlKGljLCBzLmN1cnJlbnRNaWxlc3RvbmVJZCk7XG4gICAgICBpZiAoc3RvcCkgcmV0dXJuIHN0b3A7XG4gICAgICAvLyBQUiBjcmVhdGlvbiAoYXV0b19wcikgaXMgaGFuZGxlZCBpbnNpZGUgbWVyZ2VNaWxlc3RvbmVUb01haW4gKCMyMzAyKVxuICAgIH1cbiAgICBkZXBzLnNlbmREZXNrdG9wTm90aWZpY2F0aW9uKFxuICAgICAgXCJHU0RcIixcbiAgICAgIGBNaWxlc3RvbmUgJHttaWR9IGNvbXBsZXRlIWAsXG4gICAgICBcInN1Y2Nlc3NcIixcbiAgICAgIFwibWlsZXN0b25lXCIsXG4gICAgICBiYXNlbmFtZShzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCksXG4gICAgKTtcbiAgICBkZXBzLmxvZ0NtdXhFdmVudChcbiAgICAgIHByZWZzLFxuICAgICAgYE1pbGVzdG9uZSAke21pZH0gY29tcGxldGUuYCxcbiAgICAgIFwic3VjY2Vzc1wiLFxuICAgICk7XG4gICAgaWYgKHMuY3VycmVudFVuaXQpIHtcbiAgICAgIGF3YWl0IGRlcHMuY2xvc2VvdXRVbml0KFxuICAgICAgICBjdHgsXG4gICAgICAgIHMuYmFzZVBhdGgsXG4gICAgICAgIHMuY3VycmVudFVuaXQudHlwZSxcbiAgICAgICAgcy5jdXJyZW50VW5pdC5pZCxcbiAgICAgICAgcy5jdXJyZW50VW5pdC5zdGFydGVkQXQsXG4gICAgICAgIGRlcHMuYnVpbGRTbmFwc2hvdE9wdHMocy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkKSxcbiAgICAgICk7XG4gICAgICBzLmN1cnJlbnRVbml0ID0gbnVsbDtcbiAgICB9XG4gICAgYXdhaXQgZGVwcy5zdG9wQXV0byhjdHgsIHBpLCBgTWlsZXN0b25lICR7bWlkfSBjb21wbGV0ZWAsIHtcbiAgICAgIGNvbXBsZXRpb25XaWRnZXQ6IHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICAgICAgbWlsZXN0b25lVGl0bGU6IG1pZFRpdGxlLFxuICAgICAgfSxcbiAgICB9KTtcbiAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwiZXhpdFwiLCByZWFzb246IFwibWlsZXN0b25lLWNvbXBsZXRlXCIgfSk7XG4gICAgZGVwcy5lbWl0Sm91cm5hbEV2ZW50KHsgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgZmxvd0lkOiBpYy5mbG93SWQsIHNlcTogaWMubmV4dFNlcSgpLCBldmVudFR5cGU6IFwidGVybWluYWxcIiwgZGF0YTogeyByZWFzb246IFwibWlsZXN0b25lLWNvbXBsZXRlXCIsIG1pbGVzdG9uZUlkOiBtaWQgfSB9KTtcbiAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBcIm1pbGVzdG9uZS1jb21wbGV0ZVwiIH07XG4gIH1cblxuICAvLyBUZXJtaW5hbDogYmxvY2tlZCBcdTIwMTQgcGF1c2UgaW5zdGVhZCBvZiBoYXJkLXN0b3Agc28gdGhlIHNlc3Npb24gaXMgcmVzdW1hYmxlLlxuICBpZiAoc3RhdGUucGhhc2UgPT09IFwiYmxvY2tlZFwiKSB7XG4gICAgY29uc3QgYmxvY2tlck1zZyA9IGBCbG9ja2VkOiAke3N0YXRlLmJsb2NrZXJzLmpvaW4oXCIsIFwiKX1gO1xuICAgIGlmIChzLmN1cnJlbnRVbml0KSB7XG4gICAgICBhd2FpdCBkZXBzLmNsb3Nlb3V0VW5pdChcbiAgICAgICAgY3R4LFxuICAgICAgICBzLmJhc2VQYXRoLFxuICAgICAgICBzLmN1cnJlbnRVbml0LnR5cGUsXG4gICAgICAgIHMuY3VycmVudFVuaXQuaWQsXG4gICAgICAgIHMuY3VycmVudFVuaXQuc3RhcnRlZEF0LFxuICAgICAgICBkZXBzLmJ1aWxkU25hcHNob3RPcHRzKHMuY3VycmVudFVuaXQudHlwZSwgcy5jdXJyZW50VW5pdC5pZCksXG4gICAgICApO1xuICAgIH1cbiAgICBhd2FpdCBkZXBzLnBhdXNlQXV0byhjdHgsIHBpKTtcbiAgICBjdHgudWkubm90aWZ5KGAke2Jsb2NrZXJNc2d9LiBGaXggYW5kIHJ1biAvZ3NkIGF1dG8gdG8gcmVzdW1lLmAsIFwid2FybmluZ1wiKTtcbiAgICBkZXBzLnNlbmREZXNrdG9wTm90aWZpY2F0aW9uKFwiR1NEXCIsIGJsb2NrZXJNc2csIFwid2FybmluZ1wiLCBcImF0dGVudGlvblwiLCBiYXNlbmFtZShzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCkpO1xuICAgIGRlcHMubG9nQ211eEV2ZW50KHByZWZzLCBibG9ja2VyTXNnLCBcIndhcm5pbmdcIik7XG4gICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImV4aXRcIiwgcmVhc29uOiBcImJsb2NrZWRcIiB9KTtcbiAgICBkZXBzLmVtaXRKb3VybmFsRXZlbnQoeyB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBmbG93SWQ6IGljLmZsb3dJZCwgc2VxOiBpYy5uZXh0U2VxKCksIGV2ZW50VHlwZTogXCJ0ZXJtaW5hbFwiLCBkYXRhOiB7IHJlYXNvbjogXCJibG9ja2VkXCIsIGJsb2NrZXJzOiBzdGF0ZS5ibG9ja2VycyB9IH0pO1xuICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwiYmxvY2tlZFwiIH07XG4gIH1cblxuICByZXR1cm4geyBhY3Rpb246IFwibmV4dFwiLCBkYXRhOiB7IHN0YXRlLCBtaWQsIG1pZFRpdGxlIH0gfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJ1bkRpc3BhdGNoIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFBoYXNlIDM6IERpc3BhdGNoIHJlc29sdXRpb24gXHUyMDE0IHJlc29sdmUgbmV4dCB1bml0LCBzdHVjayBkZXRlY3Rpb24sIHByZS1kaXNwYXRjaCBob29rcy5cbiAqIFJldHVybnMgYnJlYWsvY29udGludWUgdG8gY29udHJvbCB0aGUgbG9vcCwgb3IgbmV4dCB3aXRoIEl0ZXJhdGlvbkRhdGEgb24gc3VjY2Vzcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkRpc3BhdGNoKFxuICBpYzogSXRlcmF0aW9uQ29udGV4dCxcbiAgcHJlRGF0YTogUHJlRGlzcGF0Y2hEYXRhLFxuICBsb29wU3RhdGU6IExvb3BTdGF0ZSxcbik6IFByb21pc2U8UGhhc2VSZXN1bHQ8SXRlcmF0aW9uRGF0YT4+IHtcbiAgY29uc3QgeyBjdHgsIHBpLCBzLCBkZXBzLCBwcmVmcyB9ID0gaWM7XG4gIGNvbnN0IHsgc3RhdGUsIG1pZCwgbWlkVGl0bGUgfSA9IHByZURhdGE7XG4gIGNvbnN0IFNUVUNLX1dJTkRPV19TSVpFID0gNjtcbiAgY29uc3QgcHJvdmlkZXIgPSBjdHgubW9kZWw/LnByb3ZpZGVyO1xuICBjb25zdCBhdXRoTW9kZSA9IHByb3ZpZGVyICYmIHR5cGVvZiBjdHgubW9kZWxSZWdpc3RyeT8uZ2V0UHJvdmlkZXJBdXRoTW9kZSA9PT0gXCJmdW5jdGlvblwiXG4gICAgPyBjdHgubW9kZWxSZWdpc3RyeS5nZXRQcm92aWRlckF1dGhNb2RlKHByb3ZpZGVyKVxuICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCBhY3RpdmVUb29scyA9IHR5cGVvZiBwaS5nZXRBY3RpdmVUb29scyA9PT0gXCJmdW5jdGlvblwiID8gcGkuZ2V0QWN0aXZlVG9vbHMoKSA6IFtdO1xuICAvLyBEZWVwIHBsYW5uaW5nIGludGVudGlvbmFsbHkga2VlcHMgaHVtYW4gY2hlY2twb2ludHMgaW4gcGxhaW4gY2hhdC4gSW5cbiAgLy8gQ2xhdWRlIENvZGUvbG9jYWwgTUNQIHRyYW5zcG9ydHMsIHN0cnVjdHVyZWQgcXVlc3Rpb24gcmVxdWVzdHMgY2FuIGJlXG4gIC8vIGNhbmNlbGxlZCBvdXRzaWRlIHRoZSBub3JtYWwgY2hhdCBmbG93LCB3aGljaCBtYWRlIGFwcHJvdmFsIGdhdGVzIGVhc3kgdG9cbiAgLy8gc2tpcCBvciBidXJ5IHVuZGVyIHRvb2wgb3V0cHV0LlxuICBjb25zdCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlID0gcHJlZnM/LnBsYW5uaW5nX2RlcHRoID09PSBcImRlZXBcIlxuICAgID8gXCJmYWxzZVwiXG4gICAgOiBzdXBwb3J0c1N0cnVjdHVyZWRRdWVzdGlvbnMoYWN0aXZlVG9vbHMsIHtcbiAgICAgICAgYXV0aE1vZGUsXG4gICAgICAgIGJhc2VVcmw6IGN0eC5tb2RlbD8uYmFzZVVybCxcbiAgICAgIH0pID8gXCJ0cnVlXCIgOiBcImZhbHNlXCI7XG5cbiAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImRpc3BhdGNoLXJlc29sdmVcIiwgaXRlcmF0aW9uOiBpYy5pdGVyYXRpb24gfSk7XG4gIGNvbnN0IGRpc3BhdGNoUmVzdWx0ID0gYXdhaXQgZGVwcy5yZXNvbHZlRGlzcGF0Y2goe1xuICAgIGJhc2VQYXRoOiBzLmJhc2VQYXRoLFxuICAgIG1pZCxcbiAgICBtaWRUaXRsZSxcbiAgICBzdGF0ZSxcbiAgICBwcmVmcyxcbiAgICBzZXNzaW9uOiBzLFxuICAgIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUsXG4gICAgc2Vzc2lvbkNvbnRleHRXaW5kb3c6IGN0eC5tb2RlbD8uY29udGV4dFdpbmRvdyxcbiAgICBzZXNzaW9uUHJvdmlkZXI6IGN0eC5tb2RlbD8ucHJvdmlkZXIsXG4gICAgbW9kZWxSZWdpc3RyeTogY3R4Lm1vZGVsUmVnaXN0cnkgYXMgTWluaW1hbE1vZGVsUmVnaXN0cnkgfCB1bmRlZmluZWQsXG4gIH0pO1xuXG4gIGlmIChkaXNwYXRjaFJlc3VsdC5hY3Rpb24gPT09IFwic3RvcFwiKSB7XG4gICAgZGVwcy5lbWl0Sm91cm5hbEV2ZW50KHsgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgZmxvd0lkOiBpYy5mbG93SWQsIHNlcTogaWMubmV4dFNlcSgpLCBldmVudFR5cGU6IFwiZGlzcGF0Y2gtc3RvcFwiLCBydWxlOiBkaXNwYXRjaFJlc3VsdC5tYXRjaGVkUnVsZSwgZGF0YTogeyByZWFzb246IGRpc3BhdGNoUmVzdWx0LnJlYXNvbiB9IH0pO1xuICAgIC8vIFdhcm5pbmctbGV2ZWwgc3RvcHMgYXJlIHJlY292ZXJhYmxlIGh1bWFuIGNoZWNrcG9pbnRzIChlLmcuIFVBVCB2ZXJkaWN0XG4gICAgLy8gZ2F0ZSkgXHUyMDE0IHBhdXNlIGluc3RlYWQgb2YgaGFyZC1zdG9wcGluZyBzbyB0aGUgc2Vzc2lvbiBpcyByZXN1bWFibGUgd2l0aFxuICAgIC8vIGAvZ3NkIGF1dG9gLiBFcnJvci9pbmZvLWxldmVsIHN0b3BzIHJlbWFpbiBoYXJkIHN0b3BzIGZvciBpbmZyYXN0cnVjdHVyZVxuICAgIC8vIGZhaWx1cmVzIGFuZCB0ZXJtaW5hbCBjb25kaXRpb25zIHJlc3BlY3RpdmVseS5cbiAgICAvLyBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9nc2QtYnVpbGQvZ3NkLTIvaXNzdWVzLzI0NzRcbiAgICBpZiAoZGlzcGF0Y2hSZXN1bHQubGV2ZWwgPT09IFwid2FybmluZ1wiKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGRpc3BhdGNoUmVzdWx0LnJlYXNvbiwgXCJ3YXJuaW5nXCIpO1xuICAgICAgYXdhaXQgZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSwge1xuICAgICAgICBtZXNzYWdlOiBkaXNwYXRjaFJlc3VsdC5yZWFzb24sXG4gICAgICAgIGNhdGVnb3J5OiBcInVua25vd25cIixcbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBhd2FpdCBjbG9zZW91dEFuZFN0b3AoY3R4LCBwaSwgcywgZGVwcywgZGlzcGF0Y2hSZXN1bHQucmVhc29uKTtcbiAgICB9XG4gICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImV4aXRcIiwgcmVhc29uOiBcImRpc3BhdGNoLXN0b3BcIiB9KTtcbiAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBcImRpc3BhdGNoLXN0b3BcIiB9O1xuICB9XG5cbiAgaWYgKGRpc3BhdGNoUmVzdWx0LmFjdGlvbiAhPT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgLy8gTm9uLWRpc3BhdGNoIGFjdGlvbiAoZS5nLiBcInNraXBcIikgXHUyMDE0IHJlLWRlcml2ZSBzdGF0ZVxuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRJbW1lZGlhdGUocikpO1xuICAgIHJldHVybiB7IGFjdGlvbjogXCJjb250aW51ZVwiIH07XG4gIH1cblxuICBkZXBzLmVtaXRKb3VybmFsRXZlbnQoeyB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBmbG93SWQ6IGljLmZsb3dJZCwgc2VxOiBpYy5uZXh0U2VxKCksIGV2ZW50VHlwZTogXCJkaXNwYXRjaC1tYXRjaFwiLCBydWxlOiBkaXNwYXRjaFJlc3VsdC5tYXRjaGVkUnVsZSwgZGF0YTogeyB1bml0VHlwZTogZGlzcGF0Y2hSZXN1bHQudW5pdFR5cGUsIHVuaXRJZDogZGlzcGF0Y2hSZXN1bHQudW5pdElkIH0gfSk7XG5cbiAgbGV0IHVuaXRUeXBlID0gZGlzcGF0Y2hSZXN1bHQudW5pdFR5cGU7XG4gIGxldCB1bml0SWQgPSBkaXNwYXRjaFJlc3VsdC51bml0SWQ7XG4gIGxldCBwcm9tcHQgPSBkaXNwYXRjaFJlc3VsdC5wcm9tcHQ7XG4gIGNvbnN0IHBhdXNlQWZ0ZXJVYXREaXNwYXRjaCA9IGRpc3BhdGNoUmVzdWx0LnBhdXNlQWZ0ZXJEaXNwYXRjaCA/PyBmYWxzZTtcblxuICAvLyBSZXNvbHZlIGhvb2tzIGFuZCBwcmlvci1zbGljZSBnYXRpbmcgYmVmb3JlIGhlYWx0aC9zdHVjayBhY2NvdW50aW5nIHNvXG4gIC8vIHRob3NlIGNoZWNrcyBydW4gYWdhaW5zdCB0aGUgZmluYWwgZGlzcGF0Y2ggdW5pdC5cbiAgY29uc3QgcHJlRGlzcGF0Y2hSZXN1bHQgPSBkZXBzLnJ1blByZURpc3BhdGNoSG9va3MoXG4gICAgdW5pdFR5cGUsXG4gICAgdW5pdElkLFxuICAgIHByb21wdCxcbiAgICBzLmJhc2VQYXRoLFxuICApO1xuICBpZiAocHJlRGlzcGF0Y2hSZXN1bHQuZmlyZWRIb29rcy5sZW5ndGggPiAwKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBQcmUtZGlzcGF0Y2ggaG9vayR7cHJlRGlzcGF0Y2hSZXN1bHQuZmlyZWRIb29rcy5sZW5ndGggPiAxID8gXCJzXCIgOiBcIlwifTogJHtwcmVEaXNwYXRjaFJlc3VsdC5maXJlZEhvb2tzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgXCJpbmZvXCIsXG4gICAgKTtcbiAgICBkZXBzLmVtaXRKb3VybmFsRXZlbnQoeyB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBmbG93SWQ6IGljLmZsb3dJZCwgc2VxOiBpYy5uZXh0U2VxKCksIGV2ZW50VHlwZTogXCJwcmUtZGlzcGF0Y2gtaG9va1wiLCBkYXRhOiB7IGZpcmVkSG9va3M6IHByZURpc3BhdGNoUmVzdWx0LmZpcmVkSG9va3MsIGFjdGlvbjogcHJlRGlzcGF0Y2hSZXN1bHQuYWN0aW9uIH0gfSk7XG4gIH1cbiAgaWYgKHByZURpc3BhdGNoUmVzdWx0LmFjdGlvbiA9PT0gXCJza2lwXCIpIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYFNraXBwaW5nICR7dW5pdFR5cGV9ICR7dW5pdElkfSAocHJlLWRpc3BhdGNoIGhvb2spLmAsXG4gICAgICBcImluZm9cIixcbiAgICApO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRJbW1lZGlhdGUocikpO1xuICAgIHJldHVybiB7IGFjdGlvbjogXCJjb250aW51ZVwiIH07XG4gIH1cbiAgaWYgKHByZURpc3BhdGNoUmVzdWx0LmFjdGlvbiA9PT0gXCJyZXBsYWNlXCIpIHtcbiAgICBwcm9tcHQgPSBwcmVEaXNwYXRjaFJlc3VsdC5wcm9tcHQgPz8gcHJvbXB0O1xuICAgIGlmIChwcmVEaXNwYXRjaFJlc3VsdC51bml0VHlwZSkgdW5pdFR5cGUgPSBwcmVEaXNwYXRjaFJlc3VsdC51bml0VHlwZTtcbiAgfSBlbHNlIGlmIChwcmVEaXNwYXRjaFJlc3VsdC5wcm9tcHQpIHtcbiAgICBwcm9tcHQgPSBwcmVEaXNwYXRjaFJlc3VsdC5wcm9tcHQ7XG4gIH1cblxuICBjb25zdCBndWFyZEJhc2VQYXRoID0gX3Jlc29sdmVEaXNwYXRjaEd1YXJkQmFzZVBhdGgocyk7XG4gIGxldCBtYWluQnJhbmNoID0gXCJtYWluXCI7XG4gIHRyeSB7XG4gICAgbWFpbkJyYW5jaCA9IGRlcHMuZ2V0TWFpbkJyYW5jaChndWFyZEJhc2VQYXRoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImdldE1haW5CcmFuY2gtZmFpbGVkXCIsIGVycm9yOiBTdHJpbmcoZXJyKSB9KTtcbiAgfVxuICBjb25zdCBwcmlvclNsaWNlQmxvY2tlciA9IGRlcHMuZ2V0UHJpb3JTbGljZUNvbXBsZXRpb25CbG9ja2VyKFxuICAgIGd1YXJkQmFzZVBhdGgsXG4gICAgbWFpbkJyYW5jaCxcbiAgICB1bml0VHlwZSxcbiAgICB1bml0SWQsXG4gICk7XG4gIGlmIChwcmlvclNsaWNlQmxvY2tlcikge1xuICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgcHJpb3JTbGljZUJsb2NrZXIpO1xuICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJleGl0XCIsIHJlYXNvbjogXCJwcmlvci1zbGljZS1ibG9ja2VyXCIgfSk7XG4gICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJwcmlvci1zbGljZS1ibG9ja2VyXCIgfTtcbiAgfVxuXG4gIGNvbnN0IHdvcmt0cmVlU2FmZXR5QmxvY2sgPSBhd2FpdCB2YWxpZGF0ZVNvdXJjZVdyaXRlV29ya3RyZWVTYWZldHkoXG4gICAgaWMsXG4gICAgdW5pdFR5cGUsXG4gICAgdW5pdElkLFxuICAgIG1pZCxcbiAgICBcInByZS1kaXNwYXRjaFwiLFxuICApO1xuICBpZiAod29ya3RyZWVTYWZldHlCbG9jaykgcmV0dXJuIHdvcmt0cmVlU2FmZXR5QmxvY2s7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFNsaWRpbmctd2luZG93IHN0dWNrIGRldGVjdGlvbiB3aXRoIGdyYWR1YXRlZCByZWNvdmVyeSBcdTI1MDBcdTI1MDBcbiAgY29uc3QgZGVyaXZlZEtleSA9IGAke3VuaXRUeXBlfS8ke3VuaXRJZH1gO1xuXG4gIC8vIEFsd2F5cyByZWNvcmQgdGhpcyBkaXNwYXRjaCBpbiB0aGUgc2xpZGluZyB3aW5kb3cgYW5kIHJ1biBkZXRlY3Rpb24gc29cbiAgLy8gUnVsZXMgMS8zLzQgY2FuIGNhdGNoIHJldHJ5IGxvb3BzIHdpdGggcmVwZWF0ZWQgZmFpbHVyZSBjb250ZW50ICgjNTcxOSkuXG4gIC8vIFJ1bGVzIDIvMmIgc3VwcHJlc3MgbGVnaXRpbWF0ZSByZXRyeSBiYWNrb2ZmIHRocm91Z2ggdGhlIGRpc3BhdGNoIGxlZGdlci5cbiAgbG9vcFN0YXRlLnJlY2VudFVuaXRzLnB1c2goeyBrZXk6IGRlcml2ZWRLZXkgfSk7XG4gIGlmIChsb29wU3RhdGUucmVjZW50VW5pdHMubGVuZ3RoID4gU1RVQ0tfV0lORE9XX1NJWkUpIGxvb3BTdGF0ZS5yZWNlbnRVbml0cy5zaGlmdCgpO1xuXG4gIGNvbnN0IHN0dWNrU2lnbmFsID0gZGV0ZWN0U3R1Y2sobG9vcFN0YXRlLnJlY2VudFVuaXRzKTtcbiAgaWYgKHN0dWNrU2lnbmFsKSB7XG4gICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICAgICAgcGhhc2U6IFwic3R1Y2stY2hlY2tcIixcbiAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgIHVuaXRJZCxcbiAgICAgICAgcmVhc29uOiBzdHVja1NpZ25hbC5yZWFzb24sXG4gICAgICAgIHJlY292ZXJ5QXR0ZW1wdHM6IGxvb3BTdGF0ZS5zdHVja1JlY292ZXJ5QXR0ZW1wdHMsXG4gICAgICB9KTtcblxuICAgICAgaWYgKGxvb3BTdGF0ZS5zdHVja1JlY292ZXJ5QXR0ZW1wdHMgPT09IDApIHtcbiAgICAgICAgLy8gTGV2ZWwgMTogdHJ5IHZlcmlmeWluZyB0aGUgYXJ0aWZhY3QsIHRoZW4gY2FjaGUgaW52YWxpZGF0aW9uICsgcmV0cnlcbiAgICAgICAgbG9vcFN0YXRlLnN0dWNrUmVjb3ZlcnlBdHRlbXB0cysrO1xuICAgICAgICBjb25zdCBhcnRpZmFjdEV4aXN0cyA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXG4gICAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgICAgdW5pdElkLFxuICAgICAgICAgIHMuYmFzZVBhdGgsXG4gICAgICAgICk7XG4gICAgICAgIGlmIChhcnRpZmFjdEV4aXN0cykge1xuICAgICAgICAgIGlmICh1bml0VHlwZSA9PT0gXCJjb21wbGV0ZS1taWxlc3RvbmVcIikge1xuICAgICAgICAgICAgY29uc3Qgc3R1Y2tEaWFnID0gZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0KHVuaXRUeXBlLCB1bml0SWQsIHMuYmFzZVBhdGgpO1xuICAgICAgICAgICAgY29uc3Qgc3R1Y2tQYXJ0cyA9IFtcbiAgICAgICAgICAgICAgYERldGVjdGVkICR7dW5pdFR5cGV9ICR7dW5pdElkfSBvdXRwdXQgb24gZGlzaywgYnV0IHRoZSBzYW1lIHVuaXQgaXMgc3RpbGwgYmVpbmcgZGVyaXZlZC5gLFxuICAgICAgICAgICAgICBcIlRoaXMgdXN1YWxseSBtZWFucyB0aGUgbWlsZXN0b25lIHN1bW1hcnkgZXhpc3RzIHdoaWxlIHRoZSBEQiByb3cgc3RpbGwgZG9lcyBub3QgbWFyayB0aGUgbWlsZXN0b25lIGNvbXBsZXRlLlwiLFxuICAgICAgICAgICAgXTtcbiAgICAgICAgICAgIGlmIChzdHVja0RpYWcpIHN0dWNrUGFydHMucHVzaChgRXhwZWN0ZWQ6ICR7c3R1Y2tEaWFnfWApO1xuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShzdHVja1BhcnRzLmpvaW4oXCIgXCIpLCBcIndhcm5pbmdcIik7XG4gICAgICAgICAgICBhd2FpdCBkZXBzLnBhdXNlQXV0byhjdHgsIHBpKTtcbiAgICAgICAgICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwiY29tcGxldGUtbWlsZXN0b25lLWFydGlmYWN0LWRiLW1pc21hdGNoXCIgfTtcbiAgICAgICAgICB9XG4gICAgICAgICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgICAgICAgICBwaGFzZTogXCJzdHVjay1yZWNvdmVyeVwiLFxuICAgICAgICAgICAgbGV2ZWw6IDEsXG4gICAgICAgICAgICBhY3Rpb246IFwiYXJ0aWZhY3QtZm91bmRcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjb25zdCByZWNvdmVyeURiID0gcmVmcmVzaFJlY292ZXJ5RGJGb3JBcnRpZmFjdCh1bml0VHlwZSwgdW5pdElkKTtcbiAgICAgICAgICBpZiAoIXJlY292ZXJ5RGIub2spIHtcbiAgICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICAgIHJlY292ZXJ5RGIuZmF0YWxcbiAgICAgICAgICAgICAgICA/IGAke3JlY292ZXJ5RGIubWVzc2FnZX0gUGF1c2luZyBhdXRvLW1vZGUgZm9yIG1hbnVhbCByZWNvdmVyeS5gXG4gICAgICAgICAgICAgICAgOiBgJHtyZWNvdmVyeURiLm1lc3NhZ2V9IEtlZXBpbmcgc3R1Y2sgc3RhdGUgZm9yIHJldHJ5LmAsXG4gICAgICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChyZWNvdmVyeURiLmZhdGFsKSB7XG4gICAgICAgICAgICAgIGF3YWl0IGRlcHMucGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgICAgICAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiByZWNvdmVyeURiLnJlYXNvbiB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImNvbnRpbnVlXCIgfTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBTdHVjayByZWNvdmVyeTogYXJ0aWZhY3QgZm9yICR7dW5pdFR5cGV9ICR7dW5pdElkfSBmb3VuZCBvbiBkaXNrLiBJbnZhbGlkYXRpbmcgY2FjaGVzLmAsXG4gICAgICAgICAgICBcImluZm9cIixcbiAgICAgICAgICApO1xuICAgICAgICAgIGRlcHMuaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgICAgIGxvb3BTdGF0ZS5yZWNlbnRVbml0cy5sZW5ndGggPSAwO1xuICAgICAgICAgIGxvb3BTdGF0ZS5zdHVja1JlY292ZXJ5QXR0ZW1wdHMgPSAwO1xuICAgICAgICAgIHJldHVybiB7IGFjdGlvbjogXCJjb250aW51ZVwiIH07XG4gICAgICAgIH1cbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgU3R1Y2sgb24gJHt1bml0VHlwZX0gJHt1bml0SWR9ICgke3N0dWNrU2lnbmFsLnJlYXNvbn0pLiBJbnZhbGlkYXRpbmcgY2FjaGVzIGFuZCByZXRyeWluZy5gLFxuICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICApO1xuICAgICAgICBkZXBzLmludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIExldmVsIDI6IGhhcmQgc3RvcCBcdTIwMTQgZ2VudWluZWx5IHN0dWNrXG4gICAgICAgIGRlcHMuaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgICBjb25zdCBhcnRpZmFjdEV4aXN0cyA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoXG4gICAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgICAgdW5pdElkLFxuICAgICAgICAgIHMuYmFzZVBhdGgsXG4gICAgICAgICk7XG4gICAgICAgIGlmIChhcnRpZmFjdEV4aXN0cyAmJiB1bml0VHlwZSAhPT0gXCJjb21wbGV0ZS1taWxlc3RvbmVcIikge1xuICAgICAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICAgICAgcGhhc2U6IFwic3R1Y2stcmVjb3ZlcnlcIixcbiAgICAgICAgICAgIGxldmVsOiAyLFxuICAgICAgICAgICAgYWN0aW9uOiBcImFydGlmYWN0LWZvdW5kXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgY29uc3QgcmVjb3ZlcnlEYiA9IHJlZnJlc2hSZWNvdmVyeURiRm9yQXJ0aWZhY3QodW5pdFR5cGUsIHVuaXRJZCk7XG4gICAgICAgICAgaWYgKHJlY292ZXJ5RGIub2spIHtcbiAgICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICAgIGBTdHVjayByZWNvdmVyeTogYXJ0aWZhY3QgZm9yICR7dW5pdFR5cGV9ICR7dW5pdElkfSBmb3VuZCBvbiBkaXNrIGFmdGVyIGNhY2hlIGludmFsaWRhdGlvbi4gQ29udGludWluZy5gLFxuICAgICAgICAgICAgICBcImluZm9cIixcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBsb29wU3RhdGUucmVjZW50VW5pdHMubGVuZ3RoID0gMDtcbiAgICAgICAgICAgIGxvb3BTdGF0ZS5zdHVja1JlY292ZXJ5QXR0ZW1wdHMgPSAwO1xuICAgICAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImNvbnRpbnVlXCIgfTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIHJlY292ZXJ5RGIuZmF0YWxcbiAgICAgICAgICAgICAgPyBgJHtyZWNvdmVyeURiLm1lc3NhZ2V9IFBhdXNpbmcgYXV0by1tb2RlIGZvciBtYW51YWwgcmVjb3ZlcnkuYFxuICAgICAgICAgICAgICA6IGAke3JlY292ZXJ5RGIubWVzc2FnZX0gU3RvcHBpbmcgZm9yIG1hbnVhbCByZWNvdmVyeS5gLFxuICAgICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBpZiAocmVjb3ZlcnlEYi5mYXRhbCkge1xuICAgICAgICAgICAgYXdhaXQgZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgICAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiByZWNvdmVyeURiLnJlYXNvbiB9O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICAgICAgICBwaGFzZTogXCJzdHVjay1kZXRlY3RlZFwiLFxuICAgICAgICAgIHVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZCxcbiAgICAgICAgICByZWFzb246IHN0dWNrU2lnbmFsLnJlYXNvbixcbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnN0IHN0dWNrRGlhZyA9IGRpYWdub3NlRXhwZWN0ZWRBcnRpZmFjdCh1bml0VHlwZSwgdW5pdElkLCBzLmJhc2VQYXRoKTtcbiAgICAgICAgY29uc3Qgc3R1Y2tSZW1lZGlhdGlvbiA9IGJ1aWxkTG9vcFJlbWVkaWF0aW9uU3RlcHModW5pdFR5cGUsIHVuaXRJZCwgcy5iYXNlUGF0aCk7XG4gICAgICAgIGNvbnN0IHN0dWNrUGFydHMgPSBbYFN0dWNrIG9uICR7dW5pdFR5cGV9ICR7dW5pdElkfSBcdTIwMTQgJHtzdHVja1NpZ25hbC5yZWFzb259LmBdO1xuICAgICAgICBpZiAoc3R1Y2tEaWFnKSBzdHVja1BhcnRzLnB1c2goYEV4cGVjdGVkOiAke3N0dWNrRGlhZ31gKTtcbiAgICAgICAgaWYgKHN0dWNrUmVtZWRpYXRpb24pIHN0dWNrUGFydHMucHVzaChgVG8gcmVjb3ZlcjpcXG4ke3N0dWNrUmVtZWRpYXRpb259YCk7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoc3R1Y2tQYXJ0cy5qb2luKFwiIFwiKSwgXCJlcnJvclwiKTtcbiAgICAgICAgYXdhaXQgZGVwcy5zdG9wQXV0byhcbiAgICAgICAgICBjdHgsXG4gICAgICAgICAgcGksXG4gICAgICAgICAgYFN0dWNrOiAke3N0dWNrU2lnbmFsLnJlYXNvbn1gLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBcInN0dWNrLWRldGVjdGVkXCIgfTtcbiAgICAgIH1cbiAgfSBlbHNlIHtcbiAgICAvLyBQcm9ncmVzcyBkZXRlY3RlZCBcdTIwMTQgcmVzZXQgcmVjb3ZlcnkgY291bnRlclxuICAgIGlmIChsb29wU3RhdGUuc3R1Y2tSZWNvdmVyeUF0dGVtcHRzID4gMCkge1xuICAgICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgICAgIHBoYXNlOiBcInN0dWNrLWNvdW50ZXItcmVzZXRcIixcbiAgICAgICAgZnJvbTogbG9vcFN0YXRlLnJlY2VudFVuaXRzW2xvb3BTdGF0ZS5yZWNlbnRVbml0cy5sZW5ndGggLSAyXT8ua2V5ID8/IFwiXCIsXG4gICAgICAgIHRvOiBkZXJpdmVkS2V5LFxuICAgICAgfSk7XG4gICAgICBsb29wU3RhdGUuc3R1Y2tSZWNvdmVyeUF0dGVtcHRzID0gMDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGFjdGlvbjogXCJuZXh0XCIsXG4gICAgZGF0YToge1xuICAgICAgdW5pdFR5cGUsIHVuaXRJZCwgcHJvbXB0LCBmaW5hbFByb21wdDogcHJvbXB0LFxuICAgICAgcGF1c2VBZnRlclVhdERpc3BhdGNoLFxuICAgICAgc3RhdGUsIG1pZCwgbWlkVGl0bGUsXG4gICAgICBpc1JldHJ5OiBmYWxzZSwgcHJldmlvdXNUaWVyOiB1bmRlZmluZWQsXG4gICAgICBob29rTW9kZWxPdmVycmlkZTogcHJlRGlzcGF0Y2hSZXN1bHQubW9kZWwsXG4gICAgfSxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJ1bkd1YXJkcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBQaGFzZSAyOiBHdWFyZHMgXHUyMDE0IHN0b3AgZGlyZWN0aXZlcywgYnVkZ2V0IGNlaWxpbmcsIGNvbnRleHQgd2luZG93LCBzZWNyZXRzIHJlLWNoZWNrLlxuICogUmV0dXJucyBicmVhayB0byBleGl0IHRoZSBsb29wLCBvciBuZXh0IHRvIHByb2NlZWQgdG8gZGlzcGF0Y2guXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5HdWFyZHMoXG4gIGljOiBJdGVyYXRpb25Db250ZXh0LFxuICBtaWQ6IHN0cmluZyxcbik6IFByb21pc2U8UGhhc2VSZXN1bHQ+IHtcbiAgY29uc3QgeyBjdHgsIHBpLCBzLCBkZXBzLCBwcmVmcyB9ID0gaWM7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFN0b3AvQmFja3RyYWNrIGRpcmVjdGl2ZSBndWFyZCAoIzM0ODcpIFx1MjUwMFx1MjUwMFxuICAvLyBDaGVjayBmb3IgdW5leGVjdXRlZCBzdG9wIG9yIGJhY2t0cmFjayBjYXB0dXJlcyBCRUZPUkUgZGlzcGF0Y2hpbmcgYW55IHVuaXQuXG4gIC8vIFRoaXMgZW5zdXJlcyB1c2VyIFwiaGFsdFwiIGRpcmVjdGl2ZXMgYXJlIGhvbm9yZWQgaW1tZWRpYXRlbHkuXG4gIC8vIElNUE9SVEFOVDogRmFpbC1jbG9zZWQgXHUyMDE0IGFueSBleGNlcHRpb24gZHVyaW5nIHN0b3AgaGFuZGxpbmcgc3RpbGwgYnJlYWtzIHRoZSBsb29wXG4gIC8vIHRvIGVuc3VyZSB1c2VyIGhhbHQgaW50ZW50IGlzIG5ldmVyIHNpbGVudGx5IGRyb3BwZWQuXG4gIHRyeSB7XG4gICAgY29uc3QgeyBsb2FkU3RvcENhcHR1cmVzLCBtYXJrQ2FwdHVyZUV4ZWN1dGVkIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9jYXB0dXJlcy5qc1wiKTtcbiAgICBjb25zdCBzdG9wQ2FwdHVyZXMgPSBsb2FkU3RvcENhcHR1cmVzKHMuYmFzZVBhdGgpO1xuICAgIGlmIChzdG9wQ2FwdHVyZXMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgZmlyc3QgPSBzdG9wQ2FwdHVyZXNbMF07XG4gICAgICBjb25zdCBpc0JhY2t0cmFjayA9IGZpcnN0LmNsYXNzaWZpY2F0aW9uID09PSBcImJhY2t0cmFja1wiO1xuICAgICAgY29uc3QgbGFiZWwgPSBpc0JhY2t0cmFja1xuICAgICAgICA/IGBCYWNrdHJhY2sgZGlyZWN0aXZlOiAke2ZpcnN0LnRleHR9YFxuICAgICAgICA6IGBTdG9wIGRpcmVjdGl2ZTogJHtmaXJzdC50ZXh0fWA7XG5cbiAgICAgIGN0eC51aS5ub3RpZnkobGFiZWwsIFwid2FybmluZ1wiKTtcbiAgICAgIGRlcHMuc2VuZERlc2t0b3BOb3RpZmljYXRpb24oXG4gICAgICAgIFwiR1NEXCIsIGxhYmVsLCBcIndhcm5pbmdcIiwgXCJzdG9wLWRpcmVjdGl2ZVwiLFxuICAgICAgICBiYXNlbmFtZShzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCksXG4gICAgICApO1xuXG4gICAgICAvLyBQYXVzZSBmaXJzdCBcdTIwMTQgZW5zdXJlcyBhdXRvLW1vZGUgc3RvcHMgZXZlbiBpZiBsYXRlciBzdGVwcyBmYWlsXG4gICAgICBhd2FpdCBkZXBzLnBhdXNlQXV0byhjdHgsIHBpKTtcblxuICAgICAgLy8gRm9yIGJhY2t0cmFjayBjYXB0dXJlcywgd3JpdGUgdGhlIGJhY2t0cmFjayB0cmlnZ2VyIGFmdGVyIHBhdXNpbmdcbiAgICAgIGlmIChpc0JhY2t0cmFjaykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHsgZXhlY3V0ZUJhY2t0cmFjayB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vdHJpYWdlLXJlc29sdXRpb24uanNcIik7XG4gICAgICAgICAgZXhlY3V0ZUJhY2t0cmFjayhzLmJhc2VQYXRoLCBtaWQsIGZpcnN0KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIGRlYnVnTG9nKFwiZ3VhcmRzXCIsIHsgcGhhc2U6IFwiYmFja3RyYWNrLWV4ZWN1dGlvbi1lcnJvclwiLCBlcnJvcjogU3RyaW5nKGUpIH0pO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIE1hcmsgY2FwdHVyZXMgYXMgZXhlY3V0ZWQgb25seSBhZnRlciBzdWNjZXNzZnVsIHBhdXNlL3RyYW5zaXRpb25cbiAgICAgIGZvciAoY29uc3QgY2FwIG9mIHN0b3BDYXB0dXJlcykge1xuICAgICAgICBtYXJrQ2FwdHVyZUV4ZWN1dGVkKHMuYmFzZVBhdGgsIGNhcC5pZCk7XG4gICAgICB9XG5cbiAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJleGl0XCIsIHJlYXNvbjogaXNCYWNrdHJhY2sgPyBcInVzZXItYmFja3RyYWNrXCIgOiBcInVzZXItc3RvcFwiIH0pO1xuICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogaXNCYWNrdHJhY2sgPyBcInVzZXItYmFja3RyYWNrXCIgOiBcInVzZXItc3RvcFwiIH07XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gRmFpbC1jbG9zZWQ6IGlmIGFueXRoaW5nIGluIHRoZSBzdG9wIGd1YXJkIHRocm93cywgYnJlYWsgdGhlIGxvb3BcbiAgICAvLyByYXRoZXIgdGhhbiBzaWxlbnRseSBjb250aW51aW5nIGFuZCBkcm9wcGluZyB1c2VyIGhhbHQgaW50ZW50XG4gICAgZGVidWdMb2coXCJndWFyZHNcIiwgeyBwaGFzZTogXCJzdG9wLWd1YXJkLWVycm9yXCIsIGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJzdG9wLWd1YXJkLWVycm9yXCIgfTtcbiAgfVxuXG4gIC8vIEJ1ZGdldCBjZWlsaW5nIGd1YXJkXG4gIGNvbnN0IGJ1ZGdldENlaWxpbmcgPSBwcmVmcz8uYnVkZ2V0X2NlaWxpbmc7XG4gIGlmIChidWRnZXRDZWlsaW5nICE9PSB1bmRlZmluZWQgJiYgYnVkZ2V0Q2VpbGluZyA+IDApIHtcbiAgICBjb25zdCBjdXJyZW50TGVkZ2VyID0gZGVwcy5nZXRMZWRnZXIoKSBhcyB7IHVuaXRzOiB1bmtub3duIH0gfCBudWxsO1xuICAgIC8vIEluIHBhcmFsbGVsIHdvcmtlciBtb2RlLCBvbmx5IGNvdW50IGNvc3QgZnJvbSB0aGUgY3VycmVudCBhdXRvLW1vZGUgc2Vzc2lvblxuICAgIC8vIHRvIGF2b2lkIGhpdHRpbmcgdGhlIGNlaWxpbmcgZHVlIHRvIGhpc3RvcmljYWwgcHJvamVjdC13aWRlIHNwZW5kICgjMjE4NCkuXG4gICAgbGV0IGNvc3RVbml0cyA9IGN1cnJlbnRMZWRnZXI/LnVuaXRzO1xuICAgIGlmIChwcm9jZXNzLmVudi5HU0RfUEFSQUxMRUxfV09SS0VSICYmIHMuYXV0b1N0YXJ0VGltZSAmJiBBcnJheS5pc0FycmF5KGNvc3RVbml0cykpIHtcbiAgICAgIGNvbnN0IHNlc3Npb25TdGFydElTTyA9IG5ldyBEYXRlKHMuYXV0b1N0YXJ0VGltZSkudG9JU09TdHJpbmcoKTtcbiAgICAgIGNvc3RVbml0cyA9IGNvc3RVbml0cy5maWx0ZXIoXG4gICAgICAgICh1OiB7IHN0YXJ0ZWRBdD86IHN0cmluZyB9KSA9PiB1LnN0YXJ0ZWRBdCAhPSBudWxsICYmIHUuc3RhcnRlZEF0ID49IHNlc3Npb25TdGFydElTTyxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHRvdGFsQ29zdCA9IGNvc3RVbml0c1xuICAgICAgPyBkZXBzLmdldFByb2plY3RUb3RhbHMoY29zdFVuaXRzKS5jb3N0XG4gICAgICA6IDA7XG4gICAgY29uc3QgYnVkZ2V0UGN0ID0gdG90YWxDb3N0IC8gYnVkZ2V0Q2VpbGluZztcbiAgICBjb25zdCBidWRnZXRBbGVydExldmVsID0gZGVwcy5nZXRCdWRnZXRBbGVydExldmVsKGJ1ZGdldFBjdCk7XG4gICAgY29uc3QgbmV3QnVkZ2V0QWxlcnRMZXZlbCA9IGRlcHMuZ2V0TmV3QnVkZ2V0QWxlcnRMZXZlbChcbiAgICAgIHMubGFzdEJ1ZGdldEFsZXJ0TGV2ZWwsXG4gICAgICBidWRnZXRQY3QsXG4gICAgKTtcbiAgICBjb25zdCBlbmZvcmNlbWVudCA9IHByZWZzPy5idWRnZXRfZW5mb3JjZW1lbnQgPz8gXCJwYXVzZVwiO1xuICAgIGNvbnN0IGJ1ZGdldEVuZm9yY2VtZW50QWN0aW9uID0gZGVwcy5nZXRCdWRnZXRFbmZvcmNlbWVudEFjdGlvbihcbiAgICAgIGVuZm9yY2VtZW50LFxuICAgICAgYnVkZ2V0UGN0LFxuICAgICk7XG5cbiAgICAvLyBEYXRhLWRyaXZlbiB0aHJlc2hvbGQgY2hlY2sgXHUyMDE0IGxvb3AgZGVzY2VuZGluZywgZmlyZSBmaXJzdCBtYXRjaFxuICAgIGNvbnN0IHRocmVzaG9sZCA9IEJVREdFVF9USFJFU0hPTERTLmZpbmQoXG4gICAgICAodCkgPT4gbmV3QnVkZ2V0QWxlcnRMZXZlbCA+PSB0LnBjdCxcbiAgICApO1xuICAgIGlmICh0aHJlc2hvbGQpIHtcbiAgICAgIHMubGFzdEJ1ZGdldEFsZXJ0TGV2ZWwgPVxuICAgICAgICBuZXdCdWRnZXRBbGVydExldmVsIGFzIEF1dG9TZXNzaW9uW1wibGFzdEJ1ZGdldEFsZXJ0TGV2ZWxcIl07XG5cbiAgICAgIC8vIEVtaXQgTGF5ZXIgMiBidWRnZXRfdGhyZXNob2xkIGV2ZW50IChwb3N0LXBsYW4gaG9vayByZWNvbW1lbmRhdGlvbikuXG4gICAgICAvLyBFeHRlbnNpb25zIC8gTGF5ZXIgMCBzaGVsbCBob29rcyBtYXkgcmV0dXJuIGFuIGFjdGlvbiBvdmVycmlkZS5cbiAgICAgIGxldCBob29rQWN0aW9uOiBcInBhdXNlXCIgfCBcImRvd25ncmFkZVwiIHwgXCJjb250aW51ZVwiIHwgdW5kZWZpbmVkO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyBlbWl0QnVkZ2V0VGhyZXNob2xkIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9ob29rLWVtaXR0ZXIuanNcIik7XG4gICAgICAgIGNvbnN0IGhvb2tSZXN1bHQgPSBhd2FpdCBlbWl0QnVkZ2V0VGhyZXNob2xkKHtcbiAgICAgICAgICBmcmFjdGlvbjogYnVkZ2V0UGN0LFxuICAgICAgICAgIHNwZW50OiB0b3RhbENvc3QsXG4gICAgICAgICAgbGltaXQ6IGJ1ZGdldENlaWxpbmcsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoaG9va1Jlc3VsdD8uYWN0aW9uKSBob29rQWN0aW9uID0gaG9va1Jlc3VsdC5hY3Rpb247XG4gICAgICB9IGNhdGNoIChob29rRXJyKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYGJ1ZGdldF90aHJlc2hvbGQgaG9vayBlbWlzc2lvbiBmYWlsZWQ6ICR7KGhvb2tFcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICB9XG5cbiAgICAgIC8vIEFwcGx5IGhvb2sgb3ZlcnJpZGUgdG8gZW5mb3JjZW1lbnQgYWN0aW9uLiBcImNvbnRpbnVlXCIgXHUyMTkyIFwibm9uZVwiIChubyBlbmZvcmNlbWVudCksXG4gICAgICAvLyBcInBhdXNlXCIgYW5kIFwiZG93bmdyYWRlXCIgbWFwIHRvIHRoZSBtYXRjaGluZyBlbmZvcmNlbWVudCBwYXRoIGJlbG93LlxuICAgICAgbGV0IGVmZmVjdGl2ZUFjdGlvbiA9IGJ1ZGdldEVuZm9yY2VtZW50QWN0aW9uO1xuICAgICAgaWYgKGhvb2tBY3Rpb24gPT09IFwiY29udGludWVcIikge1xuICAgICAgICBlZmZlY3RpdmVBY3Rpb24gPSBcIm5vbmVcIjtcbiAgICAgIH0gZWxzZSBpZiAoaG9va0FjdGlvbiA9PT0gXCJwYXVzZVwiKSB7XG4gICAgICAgIGVmZmVjdGl2ZUFjdGlvbiA9IFwicGF1c2VcIjtcbiAgICAgIH0gZWxzZSBpZiAoaG9va0FjdGlvbiA9PT0gXCJkb3duZ3JhZGVcIikge1xuICAgICAgICBlZmZlY3RpdmVBY3Rpb24gPSBcIndhcm5cIjtcbiAgICAgIH1cblxuICAgICAgaWYgKHRocmVzaG9sZC5wY3QgPT09IDEwMCAmJiBlZmZlY3RpdmVBY3Rpb24gIT09IFwibm9uZVwiKSB7XG4gICAgICAgIC8vIDEwMCUgXHUyMDE0IHNwZWNpYWwgZW5mb3JjZW1lbnQgbG9naWMgKGhhbHQvcGF1c2Uvd2FybilcbiAgICAgICAgY29uc3QgbXNnID0gYEJ1ZGdldCBjZWlsaW5nICR7ZGVwcy5mb3JtYXRDb3N0KGJ1ZGdldENlaWxpbmcpfSByZWFjaGVkIChzcGVudCAke2RlcHMuZm9ybWF0Q29zdCh0b3RhbENvc3QpfSkuYDtcbiAgICAgICAgaWYgKGVmZmVjdGl2ZUFjdGlvbiA9PT0gXCJoYWx0XCIpIHtcbiAgICAgICAgICBkZXBzLnNlbmREZXNrdG9wTm90aWZpY2F0aW9uKFwiR1NEXCIsIG1zZywgXCJlcnJvclwiLCBcImJ1ZGdldFwiLCBiYXNlbmFtZShzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCkpO1xuICAgICAgICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgXCJCdWRnZXQgY2VpbGluZyByZWFjaGVkXCIpO1xuICAgICAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJleGl0XCIsIHJlYXNvbjogXCJidWRnZXQtaGFsdFwiIH0pO1xuICAgICAgICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwiYnVkZ2V0LWhhbHRcIiB9O1xuICAgICAgICB9XG4gICAgICAgIGlmIChlZmZlY3RpdmVBY3Rpb24gPT09IFwicGF1c2VcIikge1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICBgJHttc2d9IFBhdXNpbmcgYXV0by1tb2RlIFx1MjAxNCAvZ3NkIGF1dG8gdG8gb3ZlcnJpZGUgYW5kIGNvbnRpbnVlLmAsXG4gICAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgICApO1xuICAgICAgICAgIGRlcHMuc2VuZERlc2t0b3BOb3RpZmljYXRpb24oXCJHU0RcIiwgbXNnLCBcIndhcm5pbmdcIiwgXCJidWRnZXRcIiwgYmFzZW5hbWUocy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGgpKTtcbiAgICAgICAgICBkZXBzLmxvZ0NtdXhFdmVudChwcmVmcywgbXNnLCBcIndhcm5pbmdcIik7XG4gICAgICAgICAgYXdhaXQgZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImV4aXRcIiwgcmVhc29uOiBcImJ1ZGdldC1wYXVzZVwiIH0pO1xuICAgICAgICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwiYnVkZ2V0LXBhdXNlXCIgfTtcbiAgICAgICAgfVxuICAgICAgICBjdHgudWkubm90aWZ5KGAke21zZ30gQ29udGludWluZyAoZW5mb3JjZW1lbnQ6IHdhcm4pLmAsIFwid2FybmluZ1wiKTtcbiAgICAgICAgZGVwcy5zZW5kRGVza3RvcE5vdGlmaWNhdGlvbihcIkdTRFwiLCBtc2csIFwid2FybmluZ1wiLCBcImJ1ZGdldFwiLCBiYXNlbmFtZShzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCkpO1xuICAgICAgICBkZXBzLmxvZ0NtdXhFdmVudChwcmVmcywgbXNnLCBcIndhcm5pbmdcIik7XG4gICAgICB9IGVsc2UgaWYgKHRocmVzaG9sZC5wY3QgPCAxMDApIHtcbiAgICAgICAgLy8gU3ViLTEwMCUgXHUyMDE0IHNpbXBsZSBub3RpZmljYXRpb25cbiAgICAgICAgY29uc3QgbXNnID0gYCR7dGhyZXNob2xkLmxhYmVsfTogJHtkZXBzLmZvcm1hdENvc3QodG90YWxDb3N0KX0gLyAke2RlcHMuZm9ybWF0Q29zdChidWRnZXRDZWlsaW5nKX1gO1xuICAgICAgICBjdHgudWkubm90aWZ5KG1zZywgdGhyZXNob2xkLm5vdGlmeUxldmVsKTtcbiAgICAgICAgZGVwcy5zZW5kRGVza3RvcE5vdGlmaWNhdGlvbihcbiAgICAgICAgICBcIkdTRFwiLFxuICAgICAgICAgIG1zZyxcbiAgICAgICAgICB0aHJlc2hvbGQubm90aWZ5TGV2ZWwsXG4gICAgICAgICAgXCJidWRnZXRcIixcbiAgICAgICAgICBiYXNlbmFtZShzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCksXG4gICAgICAgICk7XG4gICAgICAgIGRlcHMubG9nQ211eEV2ZW50KHByZWZzLCBtc2csIHRocmVzaG9sZC5jbXV4TGV2ZWwpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoYnVkZ2V0QWxlcnRMZXZlbCA9PT0gMCkge1xuICAgICAgcy5sYXN0QnVkZ2V0QWxlcnRMZXZlbCA9IDA7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHMubGFzdEJ1ZGdldEFsZXJ0TGV2ZWwgPSAwO1xuICB9XG5cbiAgLy8gQ29udGV4dCB3aW5kb3cgZ3VhcmRcbiAgY29uc3QgY29udGV4dFRocmVzaG9sZCA9IHByZWZzPy5jb250ZXh0X3BhdXNlX3RocmVzaG9sZCA/PyAwO1xuICBpZiAoY29udGV4dFRocmVzaG9sZCA+IDAgJiYgcy5jbWRDdHgpIHtcbiAgICBjb25zdCBjb250ZXh0VXNhZ2UgPSBzLmNtZEN0eC5nZXRDb250ZXh0VXNhZ2UoKTtcbiAgICBpZiAoXG4gICAgICBjb250ZXh0VXNhZ2UgJiZcbiAgICAgIGNvbnRleHRVc2FnZS5wZXJjZW50ICE9PSBudWxsICYmXG4gICAgICBjb250ZXh0VXNhZ2UucGVyY2VudCA+PSBjb250ZXh0VGhyZXNob2xkXG4gICAgKSB7XG4gICAgICBjb25zdCBtc2cgPSBgQ29udGV4dCB3aW5kb3cgYXQgJHtjb250ZXh0VXNhZ2UucGVyY2VudH0lICh0aHJlc2hvbGQ6ICR7Y29udGV4dFRocmVzaG9sZH0lKS4gUGF1c2luZyB0byBwcmV2ZW50IHRydW5jYXRlZCBvdXRwdXQuYDtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGAke21zZ30gUnVuIC9nc2QgYXV0byB0byBjb250aW51ZSAod2lsbCBzdGFydCBmcmVzaCBzZXNzaW9uKS5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgICBkZXBzLnNlbmREZXNrdG9wTm90aWZpY2F0aW9uKFxuICAgICAgICBcIkdTRFwiLFxuICAgICAgICBgQ29udGV4dCAke2NvbnRleHRVc2FnZS5wZXJjZW50fSUgXHUyMDE0IHBhdXNlZGAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICBcImF0dGVudGlvblwiLFxuICAgICAgICBiYXNlbmFtZShzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCksXG4gICAgICApO1xuICAgICAgYXdhaXQgZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwiZXhpdFwiLCByZWFzb246IFwiY29udGV4dC13aW5kb3dcIiB9KTtcbiAgICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwiY29udGV4dC13aW5kb3dcIiB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIFNlY3JldHMgcmUtY2hlY2sgZ2F0ZVxuICB0cnkge1xuICAgIGNvbnN0IG1hbmlmZXN0U3RhdHVzID0gYXdhaXQgZGVwcy5nZXRNYW5pZmVzdFN0YXR1cyhzLmJhc2VQYXRoLCBtaWQsIHMub3JpZ2luYWxCYXNlUGF0aCk7XG4gICAgaWYgKG1hbmlmZXN0U3RhdHVzICYmIG1hbmlmZXN0U3RhdHVzLnBlbmRpbmcubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGVwcy5jb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdChcbiAgICAgICAgcy5iYXNlUGF0aCxcbiAgICAgICAgbWlkLFxuICAgICAgICBjdHgsXG4gICAgICApO1xuICAgICAgaWYgKFxuICAgICAgICByZXN1bHQgJiZcbiAgICAgICAgcmVzdWx0LmFwcGxpZWQgJiZcbiAgICAgICAgcmVzdWx0LnNraXBwZWQgJiZcbiAgICAgICAgcmVzdWx0LmV4aXN0aW5nU2tpcHBlZFxuICAgICAgKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYFNlY3JldHMgY29sbGVjdGVkOiAke3Jlc3VsdC5hcHBsaWVkLmxlbmd0aH0gYXBwbGllZCwgJHtyZXN1bHQuc2tpcHBlZC5sZW5ndGh9IHNraXBwZWQsICR7cmVzdWx0LmV4aXN0aW5nU2tpcHBlZC5sZW5ndGh9IGFscmVhZHkgc2V0LmAsXG4gICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdHgudWkubm90aWZ5KFwiU2VjcmV0cyBjb2xsZWN0aW9uIHNraXBwZWQuXCIsIFwiaW5mb1wiKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgU2VjcmV0cyBjb2xsZWN0aW9uIGVycm9yOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX0uIENvbnRpbnVpbmcgd2l0aCBuZXh0IHRhc2suYCxcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4geyBhY3Rpb246IFwibmV4dFwiLCBkYXRhOiB1bmRlZmluZWQgYXMgdm9pZCB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcnVuVW5pdFBoYXNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFBoYXNlIDQ6IFVuaXQgZXhlY3V0aW9uIFx1MjAxNCBkaXNwYXRjaCBwcm9tcHQsIGF3YWl0IGFnZW50X2VuZCwgY2xvc2VvdXQsIGFydGlmYWN0IHZlcmlmeS5cbiAqIFJldHVybnMgYnJlYWsgb3IgbmV4dCB3aXRoIHVuaXRTdGFydGVkQXQgZm9yIGRvd25zdHJlYW0gcGhhc2VzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuVW5pdFBoYXNlKFxuICBpYzogSXRlcmF0aW9uQ29udGV4dCxcbiAgaXRlckRhdGE6IEl0ZXJhdGlvbkRhdGEsXG4gIGxvb3BTdGF0ZTogTG9vcFN0YXRlLFxuICBzaWRlY2FySXRlbT86IFNpZGVjYXJJdGVtLFxuKTogUHJvbWlzZTxQaGFzZVJlc3VsdDx7IHVuaXRTdGFydGVkQXQ/OiBudW1iZXI7IHJlcXVlc3REaXNwYXRjaGVkQXQ/OiBudW1iZXIgfT4+IHtcbiAgY29uc3QgeyBjdHgsIHBpLCBzLCBkZXBzLCBwcmVmcyB9ID0gaWM7XG4gIGNvbnN0IHsgdW5pdFR5cGUsIHVuaXRJZCwgcHJvbXB0LCBzdGF0ZSwgbWlkIH0gPSBpdGVyRGF0YTtcblxuICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICBwaGFzZTogXCJ1bml0LWV4ZWN1dGlvblwiLFxuICAgIGl0ZXJhdGlvbjogaWMuaXRlcmF0aW9uLFxuICAgIHVuaXRUeXBlLFxuICAgIHVuaXRJZCxcbiAgfSk7XG5cbiAgY29uc3Qgd29ya3RyZWVTYWZldHlCbG9jayA9IGF3YWl0IHZhbGlkYXRlU291cmNlV3JpdGVXb3JrdHJlZVNhZmV0eShcbiAgICBpYyxcbiAgICB1bml0VHlwZSxcbiAgICB1bml0SWQsXG4gICAgbWlkLFxuICAgIFwidW5pdC1leGVjdXRpb25cIixcbiAgKTtcbiAgaWYgKHdvcmt0cmVlU2FmZXR5QmxvY2spIHJldHVybiB3b3JrdHJlZVNhZmV0eUJsb2NrO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBQcm9qZWN0IGNsYXNzaWZpY2F0aW9uIG5vdGljZSAoIzE4MzMsICMxODQzKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gV29ya3RyZWUgU2FmZXR5IG93bnMgc291cmNlLXdyaXRlIHJvb3QgdmFsaWRpdHkuIENsYXNzaWZpY2F0aW9uIG5vdyBvbmx5XG4gIC8vIHNoYXBlcyB1c2VyL21vZGVsIGd1aWRhbmNlIGZvciB2YWxpZCByb290cy5cbiAgbGV0IHByb2plY3RDbGFzc2lmaWNhdGlvbjogUmV0dXJuVHlwZTx0eXBlb2YgY2xhc3NpZnlQcm9qZWN0PiB8IG51bGwgPSBudWxsO1xuICBpZiAocy5iYXNlUGF0aCAmJiB1bml0VHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIikge1xuICAgIHByb2plY3RDbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5UHJvamVjdChzLmJhc2VQYXRoKTtcbiAgICBpZiAocHJvamVjdENsYXNzaWZpY2F0aW9uLmtpbmQgPT09IFwiaW52YWxpZC1yZXBvXCIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGBXb3JrdHJlZSBoZWFsdGggY2hlY2sgZmFpbGVkOiAke3MuYmFzZVBhdGh9IGNsYXNzaWZpZWQgYXMgaW52YWxpZC1yZXBvICgke3Byb2plY3RDbGFzc2lmaWNhdGlvbi5yZWFzb259KSBcdTIwMTQgcmVmdXNpbmcgdG8gZGlzcGF0Y2ggJHt1bml0VHlwZX0gJHt1bml0SWR9YDtcbiAgICAgIGRlYnVnTG9nKFwicnVuVW5pdFBoYXNlXCIsIHsgcGhhc2U6IFwid29ya3RyZWUtaGVhbHRoLWludmFsaWQtcmVwb1wiLCBiYXNlUGF0aDogcy5iYXNlUGF0aCwgY2xhc3NpZmljYXRpb246IHByb2plY3RDbGFzc2lmaWNhdGlvbiB9KTtcbiAgICAgIGNvbnN0IGhhc0dpdCA9IGRlcHMuZXhpc3RzU3luYyhqb2luKHMuYmFzZVBhdGgsIFwiLmdpdFwiKSk7XG4gICAgICBpZiAoX3Nob3VsZFByb2NlZWRXaXRoSW52YWxpZFJlcG9DbGFzc2lmaWNhdGlvbkZvclRlc3QocHJvamVjdENsYXNzaWZpY2F0aW9uLnJlYXNvbiwgaGFzR2l0KSkge1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIGBXYXJuaW5nOiAke3MuYmFzZVBhdGh9IHByb2plY3QgY2xhc3NpZmljYXRpb24gY291bGQgbm90IGNvbmZpcm0gLmdpdDsgYXNzdW1pbmcgaXQgaGFzIG5vIHByb2plY3QgY29udGVudCB5ZXQgXHUyMDE0IHByb2NlZWRpbmcgYXMgZ3JlZW5maWVsZCBwcm9qZWN0IGJlY2F1c2Ugd29ya3RyZWUgaGVhbHRoIHJlcG9ydGVkIC5naXQgcHJlc2VudGAsXG4gICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdHgudWkubm90aWZ5KG1zZywgXCJlcnJvclwiKTtcbiAgICAgICAgYXdhaXQgZGVwcy5zdG9wQXV0byhjdHgsIHBpLCBtc2cpO1xuICAgICAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBcIndvcmt0cmVlLWludmFsaWRcIiB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChwcm9qZWN0Q2xhc3NpZmljYXRpb24ua2luZCA9PT0gXCJncmVlbmZpZWxkXCIpIHtcbiAgICAgIGRlYnVnTG9nKFwicnVuVW5pdFBoYXNlXCIsIHsgcGhhc2U6IFwid29ya3RyZWUtaGVhbHRoLWdyZWVuZmllbGRcIiwgYmFzZVBhdGg6IHMuYmFzZVBhdGgsIGNsYXNzaWZpY2F0aW9uOiBwcm9qZWN0Q2xhc3NpZmljYXRpb24gfSk7XG4gICAgICBjdHgudWkubm90aWZ5KGBXYXJuaW5nOiAke3MuYmFzZVBhdGh9IGhhcyBubyBwcm9qZWN0IGNvbnRlbnQgeWV0IFx1MjAxNCBwcm9jZWVkaW5nIGFzIGdyZWVuZmllbGQgcHJvamVjdGAsIFwid2FybmluZ1wiKTtcbiAgICB9IGVsc2UgaWYgKHByb2plY3RDbGFzc2lmaWNhdGlvbi5raW5kID09PSBcInVudHlwZWQtZXhpc3RpbmdcIikge1xuICAgICAgZGVidWdMb2coXCJydW5Vbml0UGhhc2VcIiwgeyBwaGFzZTogXCJ3b3JrdHJlZS1oZWFsdGgtdW50eXBlZC1leGlzdGluZ1wiLCBiYXNlUGF0aDogcy5iYXNlUGF0aCwgY2xhc3NpZmljYXRpb246IHByb2plY3RDbGFzc2lmaWNhdGlvbiB9KTtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBOb3RpY2U6ICR7cy5iYXNlUGF0aH0gaGFzIGV4aXN0aW5nIHByb2plY3QgY29udGVudCBidXQgbm8gcmVjb2duaXplZCB0b29saW5nIG1hcmtlcnMgXHUyMDE0IHVzaW5nIGdlbmVyaWMgZmlsZS1sZXZlbCB3b3JrZmxvdyBndWlkYW5jZWAsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICAvLyBEZXRlY3QgcmV0cnkgYW5kIGNhcHR1cmUgcHJldmlvdXMgdGllciBmb3IgZXNjYWxhdGlvblxuICBjb25zdCBpc1JldHJ5ID0gISEoXG4gICAgcy5jdXJyZW50VW5pdCAmJlxuICAgIHMuY3VycmVudFVuaXQudHlwZSA9PT0gdW5pdFR5cGUgJiZcbiAgICBzLmN1cnJlbnRVbml0LmlkID09PSB1bml0SWRcbiAgKTtcbiAgY29uc3QgcHJldmlvdXNUaWVyID0gcy5jdXJyZW50VW5pdFJvdXRpbmc/LnRpZXI7XG5cbiAgLy8gU2NvcGUgd29ya2Zsb3ctbG9nZ2VyIGJ1ZmZlciB0byB0aGlzIHVuaXQgc28gcG9zdC1maW5hbGl6ZSBkcmFpbnMgYXJlXG4gIC8vIHBlci11bml0LiBXaXRob3V0IHRoaXMsIHRoZSBtb2R1bGUtbGV2ZWwgX2J1ZmZlciBhY2N1bXVsYXRlcyBhY3Jvc3MgZXZlcnlcbiAgLy8gdW5pdCBpbiB0aGUgc2FtZSBOb2RlIHByb2Nlc3MgKHNlZSB3b3JrZmxvdy1sb2dnZXIudHMgbW9kdWxlIGhlYWRlcikuXG4gIF9yZXNldExvZ3MoKTtcbiAgY29uc3QgZGlzcGF0Y2hLZXkgPSBgJHt1bml0VHlwZX0vJHt1bml0SWR9YDtcbiAgcy51bml0RGlzcGF0Y2hDb3VudC5zZXQoZGlzcGF0Y2hLZXksIChzLnVuaXREaXNwYXRjaENvdW50LmdldChkaXNwYXRjaEtleSkgPz8gMCkgKyAxKTtcbiAgcy5jdXJyZW50VW5pdCA9IHsgdHlwZTogdW5pdFR5cGUsIGlkOiB1bml0SWQsIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSB9O1xuICBzLmxhc3RHaXRBY3Rpb25GYWlsdXJlID0gbnVsbDtcbiAgcy5sYXN0R2l0QWN0aW9uU3RhdHVzID0gbnVsbDtcbiAgcy5sYXN0VW5pdEFnZW50RW5kTWVzc2FnZXMgPSBudWxsO1xuICBzZXRDdXJyZW50UGhhc2UodW5pdFR5cGUsIHtcbiAgICBiYXNlUGF0aDogcy5iYXNlUGF0aCxcbiAgICB0cmFjZUlkOiBpYy5mbG93SWQsXG4gICAgdHVybklkOiBgaXRlci0ke2ljLml0ZXJhdGlvbn1gLFxuICAgIGNhdXNlZEJ5OiBcInVuaXQtc3RhcnRcIixcbiAgfSk7XG4gIHMubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IgPSBudWxsOyAvLyAjMjg4MzogY2xlYXIgc3RhbGUgZXJyb3IgZnJvbSBwcmV2aW91cyB1bml0XG4gIGNvbnN0IHVuaXRTdGFydFNlcSA9IGljLm5leHRTZXEoKTtcbiAgZGVwcy5lbWl0Sm91cm5hbEV2ZW50KHsgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgZmxvd0lkOiBpYy5mbG93SWQsIHNlcTogdW5pdFN0YXJ0U2VxLCBldmVudFR5cGU6IFwidW5pdC1zdGFydFwiLCBkYXRhOiB7IHVuaXRUeXBlLCB1bml0SWQgfSB9KTtcbiAgZGVwcy5jYXB0dXJlQXZhaWxhYmxlU2tpbGxzKCk7XG4gIHdyaXRlVW5pdFJ1bnRpbWVSZWNvcmQoXG4gICAgcy5iYXNlUGF0aCxcbiAgICB1bml0VHlwZSxcbiAgICB1bml0SWQsXG4gICAgcy5jdXJyZW50VW5pdC5zdGFydGVkQXQsXG4gICAge1xuICAgICAgcGhhc2U6IFwiZGlzcGF0Y2hlZFwiLFxuICAgICAgd3JhcHVwV2FybmluZ1NlbnQ6IGZhbHNlLFxuICAgICAgdGltZW91dEF0OiBudWxsLFxuICAgICAgbGFzdFByb2dyZXNzQXQ6IHMuY3VycmVudFVuaXQuc3RhcnRlZEF0LFxuICAgICAgcHJvZ3Jlc3NDb3VudDogMCxcbiAgICAgIGxhc3RQcm9ncmVzc0tpbmQ6IFwiZGlzcGF0Y2hcIixcbiAgICAgIHJlY292ZXJ5QXR0ZW1wdHM6IDAsIC8vIFJlc2V0IHNvIHJlLWRpc3BhdGNoZWQgdW5pdHMgZ2V0IGZ1bGwgcmVjb3ZlcnkgYnVkZ2V0ICgjMjMyMilcbiAgICB9LFxuICApO1xuXG4gIC8vIFN0YXR1cyBiYXIgKHdpZGdldCArIHByZWNvbmRpdGlvbnMgZGVmZXJyZWQgdW50aWwgYWZ0ZXIgbW9kZWwgc2VsZWN0aW9uIFx1MjAxNCBzZWUgIzI4OTkpXG4gIGN0eC51aS5zZXRTdGF0dXMoXCJnc2QtYXV0b1wiLCBcImF1dG9cIik7XG4gIGlmIChtaWQpXG4gICAgZGVwcy51cGRhdGVTbGljZVByb2dyZXNzQ2FjaGUocy5iYXNlUGF0aCwgbWlkLCBzdGF0ZS5hY3RpdmVTbGljZT8uaWQpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBTYWZldHkgaGFybmVzczogcmVzZXQgZXZpZGVuY2UgKyBjcmVhdGUgY2hlY2twb2ludCBcdTI1MDBcdTI1MDBcbiAgY29uc3Qgc2FmZXR5Q29uZmlnID0gcmVzb2x2ZVNhZmV0eUhhcm5lc3NDb25maWcoXG4gICAgcHJlZnM/LnNhZmV0eV9oYXJuZXNzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkLFxuICApO1xuICBpZiAoc2FmZXR5Q29uZmlnLmVuYWJsZWQgJiYgc2FmZXR5Q29uZmlnLmV2aWRlbmNlX2NvbGxlY3Rpb24pIHtcbiAgICByZXNldEV2aWRlbmNlKCk7XG4gICAgLy8gUmVzdG9yZSBwZXJzaXN0ZWQgZXZpZGVuY2Ugc28gc2Vzc2lvbi1yZXN0YXJ0IHJlc3VtZXMgZG9uJ3QgcHJvZHVjZVxuICAgIC8vIGZhbHNlLXBvc2l0aXZlIFwibm8gYmFzaCBjYWxsc1wiIHdhcm5pbmdzIChCdWcgIzQzODUpLlxuICAgIGlmIChzLmJhc2VQYXRoICYmIHVuaXRUeXBlID09PSBcImV4ZWN1dGUtdGFza1wiKSB7XG4gICAgICBjb25zdCB7IG1pbGVzdG9uZTogZU1pZCwgc2xpY2U6IGVTaWQsIHRhc2s6IGVUaWQgfSA9IHBhcnNlVW5pdElkKHVuaXRJZCk7XG4gICAgICBpZiAoZU1pZCAmJiBlU2lkICYmIGVUaWQpIHtcbiAgICAgICAgbG9hZEV2aWRlbmNlRnJvbURpc2socy5iYXNlUGF0aCwgZU1pZCwgZVNpZCwgZVRpZCk7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIC8vIE9ubHkgY2hlY2twb2ludCBjb2RlLWV4ZWN1dGluZyB1bml0cyAobm90IGxpZmVjeWNsZS9wbGFubmluZyB1bml0cylcbiAgaWYgKHNhZmV0eUNvbmZpZy5lbmFibGVkICYmIHNhZmV0eUNvbmZpZy5jaGVja3BvaW50cyAmJiB1bml0VHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIikge1xuICAgIHMuY2hlY2twb2ludFNoYSA9IGNyZWF0ZUNoZWNrcG9pbnQocy5iYXNlUGF0aCwgdW5pdElkKTtcbiAgICBpZiAocy5jaGVja3BvaW50U2hhKSB7XG4gICAgICBkZWJ1Z0xvZyhcInJ1blVuaXRQaGFzZVwiLCB7IHBoYXNlOiBcImNoZWNrcG9pbnQtY3JlYXRlZFwiLCB1bml0SWQsIHNoYTogcy5jaGVja3BvaW50U2hhLnNsaWNlKDAsIDgpIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFByb21wdCBpbmplY3Rpb25cbiAgbGV0IGZpbmFsUHJvbXB0ID0gcHJvbXB0O1xuXG4gIGlmICh1bml0VHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIikge1xuICAgIHByb2plY3RDbGFzc2lmaWNhdGlvbiA/Pz0gY2xhc3NpZnlQcm9qZWN0KHMuYmFzZVBhdGgpO1xuICAgIGlmIChwcm9qZWN0Q2xhc3NpZmljYXRpb24ua2luZCA9PT0gXCJ1bnR5cGVkLWV4aXN0aW5nXCIpIHtcbiAgICAgIGNvbnN0IHNhbXBsZXMgPSBwcm9qZWN0Q2xhc3NpZmljYXRpb24uY29udGVudEZpbGVzLnNsaWNlKDAsIDgpLmpvaW4oXCIsIFwiKSB8fCBcInByb2plY3QgZmlsZXNcIjtcbiAgICAgIGZpbmFsUHJvbXB0ICs9XG4gICAgICAgIFwiXFxuXFxuKipQcm9qZWN0IGNsYXNzaWZpY2F0aW9uOioqIEV4aXN0aW5nIHVudHlwZWQgcHJvamVjdC4gTm8gcmVjb2duaXplZCBidWlsZC90b29saW5nIG1hcmtlcnMgd2VyZSBkZXRlY3RlZCwgXCIgK1xuICAgICAgICBcInNvIHVzZSBnZW5lcmljIGZpbGUtbGV2ZWwgd29ya2Zsb3cgZ3VpZGFuY2UuIFRhc2sgcGxhbnMgYW5kIGNvbXBsZXRpb24gc3VtbWFyaWVzIG11c3QgbGlzdCBldmVyeSBjb25jcmV0ZSBcIiArXG4gICAgICAgIGBwcm9qZWN0IGZpbGUgY2hhbmdlZCBpbiBcXGBmaWxlc1xcYCBvciBcXGBleHBlY3RlZF9vdXRwdXRcXGAuIERldGVjdGVkIGNvbnRlbnQgc2FtcGxlOiAke3NhbXBsZXN9LmA7XG4gICAgfVxuICB9XG5cbiAgaWYgKHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5KSB7XG4gICAgY29uc3QgcmV0cnlDdHggPSBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeTtcbiAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IG51bGw7XG4gICAgY29uc3QgY2FwcGVkID1cbiAgICAgIHJldHJ5Q3R4LmZhaWx1cmVDb250ZXh0Lmxlbmd0aCA+IE1BWF9SRUNPVkVSWV9DSEFSU1xuICAgICAgICA/IHJldHJ5Q3R4LmZhaWx1cmVDb250ZXh0LnNsaWNlKDAsIE1BWF9SRUNPVkVSWV9DSEFSUykgK1xuICAgICAgICAgIFwiXFxuXFxuWy4uLmZhaWx1cmUgY29udGV4dCB0cnVuY2F0ZWRdXCJcbiAgICAgICAgOiByZXRyeUN0eC5mYWlsdXJlQ29udGV4dDtcbiAgICBmaW5hbFByb21wdCA9IGAqKlZFUklGSUNBVElPTiBGQUlMRUQgXHUyMDE0IEFVVE8tRklYIEFUVEVNUFQgJHtyZXRyeUN0eC5hdHRlbXB0fSoqXFxuXFxuVGhlIHZlcmlmaWNhdGlvbiBnYXRlIHJhbiBhZnRlciB5b3VyIHByZXZpb3VzIGF0dGVtcHQgYW5kIGZvdW5kIGZhaWx1cmVzLiBGaXggdGhlc2UgaXNzdWVzIGJlZm9yZSBjb21wbGV0aW5nIHRoZSB0YXNrLlxcblxcbiR7Y2FwcGVkfVxcblxcbi0tLVxcblxcbiR7ZmluYWxQcm9tcHR9YDtcbiAgfVxuXG4gIGlmIChzLnBlbmRpbmdDcmFzaFJlY292ZXJ5KSB7XG4gICAgY29uc3QgY2FwcGVkID1cbiAgICAgIHMucGVuZGluZ0NyYXNoUmVjb3ZlcnkubGVuZ3RoID4gTUFYX1JFQ09WRVJZX0NIQVJTXG4gICAgICAgID8gcy5wZW5kaW5nQ3Jhc2hSZWNvdmVyeS5zbGljZSgwLCBNQVhfUkVDT1ZFUllfQ0hBUlMpICtcbiAgICAgICAgICBcIlxcblxcblsuLi5yZWNvdmVyeSBicmllZmluZyB0cnVuY2F0ZWQgdG8gcHJldmVudCBtZW1vcnkgZXhoYXVzdGlvbl1cIlxuICAgICAgICA6IHMucGVuZGluZ0NyYXNoUmVjb3Zlcnk7XG4gICAgZmluYWxQcm9tcHQgPSBgJHtjYXBwZWR9XFxuXFxuLS0tXFxuXFxuJHtmaW5hbFByb21wdH1gO1xuICAgIHMucGVuZGluZ0NyYXNoUmVjb3ZlcnkgPSBudWxsO1xuICB9IGVsc2UgaWYgKChzLnVuaXREaXNwYXRjaENvdW50LmdldChkaXNwYXRjaEtleSkgPz8gMCkgPiAxKSB7XG4gICAgY29uc3QgZGlhZ25vc3RpYyA9IGRlcHMuZ2V0RGVlcERpYWdub3N0aWMocy5iYXNlUGF0aCk7XG4gICAgaWYgKGRpYWdub3N0aWMpIHtcbiAgICAgIGNvbnN0IGNhcHBlZERpYWcgPVxuICAgICAgICBkaWFnbm9zdGljLmxlbmd0aCA+IE1BWF9SRUNPVkVSWV9DSEFSU1xuICAgICAgICAgID8gZGlhZ25vc3RpYy5zbGljZSgwLCBNQVhfUkVDT1ZFUllfQ0hBUlMpICtcbiAgICAgICAgICAgIFwiXFxuXFxuWy4uLmRpYWdub3N0aWMgdHJ1bmNhdGVkIHRvIHByZXZlbnQgbWVtb3J5IGV4aGF1c3Rpb25dXCJcbiAgICAgICAgICA6IGRpYWdub3N0aWM7XG4gICAgICBmaW5hbFByb21wdCA9IGAqKlJFVFJZIFx1MjAxNCB5b3VyIHByZXZpb3VzIGF0dGVtcHQgZGlkIG5vdCBwcm9kdWNlIHRoZSByZXF1aXJlZCBhcnRpZmFjdC4qKlxcblxcbkRpYWdub3N0aWMgZnJvbSBwcmV2aW91cyBhdHRlbXB0OlxcbiR7Y2FwcGVkRGlhZ31cXG5cXG5GaXggd2hhdGV2ZXIgd2VudCB3cm9uZyBhbmQgbWFrZSBzdXJlIHlvdSB3cml0ZSB0aGUgcmVxdWlyZWQgZmlsZSB0aGlzIHRpbWUuXFxuXFxuLS0tXFxuXFxuJHtmaW5hbFByb21wdH1gO1xuICAgIH1cbiAgfVxuXG4gIC8vIFByb21wdCBjaGFyIG1lYXN1cmVtZW50XG4gIHMubGFzdFByb21wdENoYXJDb3VudCA9IGZpbmFsUHJvbXB0Lmxlbmd0aDtcbiAgcy5sYXN0QmFzZWxpbmVDaGFyQ291bnQgPSB1bmRlZmluZWQ7XG4gIGlmIChkZXBzLmlzRGJBdmFpbGFibGUoKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGlubGluZUdzZFJvb3RGaWxlIH0gPSBhd2FpdCBpbXBvcnRFeHRlbnNpb25Nb2R1bGU8dHlwZW9mIGltcG9ydChcIi4uL2F1dG8tcHJvbXB0cy5qc1wiKT4oaW1wb3J0Lm1ldGEudXJsLCBcIi4uL2F1dG8tcHJvbXB0cy5qc1wiKTtcbiAgICAgIGNvbnN0IFtkZWNpc2lvbnNDb250ZW50LCByZXF1aXJlbWVudHNDb250ZW50LCBwcm9qZWN0Q29udGVudF0gPVxuICAgICAgICBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgICAgaW5saW5lR3NkUm9vdEZpbGUocy5iYXNlUGF0aCwgXCJkZWNpc2lvbnMubWRcIiwgXCJEZWNpc2lvbnNcIiksXG4gICAgICAgICAgaW5saW5lR3NkUm9vdEZpbGUocy5iYXNlUGF0aCwgXCJyZXF1aXJlbWVudHMubWRcIiwgXCJSZXF1aXJlbWVudHNcIiksXG4gICAgICAgICAgaW5saW5lR3NkUm9vdEZpbGUocy5iYXNlUGF0aCwgXCJwcm9qZWN0Lm1kXCIsIFwiUHJvamVjdFwiKSxcbiAgICAgICAgXSk7XG4gICAgICBzLmxhc3RCYXNlbGluZUNoYXJDb3VudCA9XG4gICAgICAgIChkZWNpc2lvbnNDb250ZW50Py5sZW5ndGggPz8gMCkgK1xuICAgICAgICAocmVxdWlyZW1lbnRzQ29udGVudD8ubGVuZ3RoID8/IDApICtcbiAgICAgICAgKHByb2plY3RDb250ZW50Py5sZW5ndGggPz8gMCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBcIkJhc2VsaW5lIGNoYXIgY291bnQgbWVhc3VyZW1lbnQgZmFpbGVkXCIsIHsgZXJyb3I6IFN0cmluZyhlKSB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBDYWNoZS1vcHRpbWl6ZSBwcm9tcHQgc2VjdGlvbiBvcmRlcmluZ1xuICB0cnkge1xuICAgIGZpbmFsUHJvbXB0ID0gZGVwcy5yZW9yZGVyRm9yQ2FjaGluZyhmaW5hbFByb21wdCk7XG4gIH0gY2F0Y2ggKHJlb3JkZXJFcnIpIHtcbiAgICBjb25zdCBtc2cgPVxuICAgICAgcmVvcmRlckVyciBpbnN0YW5jZW9mIEVycm9yID8gcmVvcmRlckVyci5tZXNzYWdlIDogU3RyaW5nKHJlb3JkZXJFcnIpO1xuICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgXCJQcm9tcHQgcmVvcmRlciBmYWlsZWRcIiwgeyBlcnJvcjogbXNnIH0pO1xuICB9XG5cbiAgLy8gU2VsZWN0IGFuZCBhcHBseSBtb2RlbCAod2l0aCB0aWVyIGVzY2FsYXRpb24gb24gcmV0cnkgXHUyMDE0IG5vcm1hbCB1bml0cyBvbmx5KVxuICBjb25zdCBtb2RlbFJlc3VsdCA9IGF3YWl0IGRlcHMuc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICBjdHgsXG4gICAgcGksXG4gICAgdW5pdFR5cGUsXG4gICAgdW5pdElkLFxuICAgIHMuYmFzZVBhdGgsXG4gICAgcHJlZnMsXG4gICAgcy52ZXJib3NlLFxuICAgIHMuYXV0b01vZGVTdGFydE1vZGVsLFxuICAgIHNpZGVjYXJJdGVtID8gdW5kZWZpbmVkIDogeyBpc1JldHJ5LCBwcmV2aW91c1RpZXIgfSxcbiAgICB1bmRlZmluZWQsXG4gICAgcy5tYW51YWxTZXNzaW9uTW9kZWxPdmVycmlkZSxcbiAgICBzLmF1dG9Nb2RlU3RhcnRUaGlua2luZ0xldmVsLFxuICApO1xuICBzLmN1cnJlbnRVbml0Um91dGluZyA9XG4gICAgbW9kZWxSZXN1bHQucm91dGluZyBhcyBBdXRvU2Vzc2lvbltcImN1cnJlbnRVbml0Um91dGluZ1wiXTtcbiAgcy5jdXJyZW50VW5pdE1vZGVsID1cbiAgICBtb2RlbFJlc3VsdC5hcHBsaWVkTW9kZWwgYXMgQXV0b1Nlc3Npb25bXCJjdXJyZW50VW5pdE1vZGVsXCJdO1xuXG4gIC8vIEFwcGx5IHNpZGVjYXIvcHJlLWRpc3BhdGNoIGhvb2sgbW9kZWwgb3ZlcnJpZGUgKHRha2VzIHByaW9yaXR5IG92ZXIgc3RhbmRhcmQgbW9kZWwgc2VsZWN0aW9uKVxuICBjb25zdCBob29rTW9kZWxPdmVycmlkZSA9IHNpZGVjYXJJdGVtPy5tb2RlbCA/PyBpdGVyRGF0YS5ob29rTW9kZWxPdmVycmlkZTtcbiAgaWYgKGhvb2tNb2RlbE92ZXJyaWRlKSB7XG4gICAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gY3R4Lm1vZGVsUmVnaXN0cnkuZ2V0QXZhaWxhYmxlKCk7XG4gICAgY29uc3QgbWF0Y2ggPSBkZXBzLnJlc29sdmVNb2RlbElkKGhvb2tNb2RlbE92ZXJyaWRlLCBhdmFpbGFibGVNb2RlbHMsIGN0eC5tb2RlbD8ucHJvdmlkZXIpO1xuICAgIGlmIChtYXRjaCkge1xuICAgICAgY29uc3Qgb2sgPSBhd2FpdCBwaS5zZXRNb2RlbChtYXRjaCwgeyBwZXJzaXN0OiBmYWxzZSB9KTtcbiAgICAgIGlmIChvaykge1xuICAgICAgICBpZiAocy5hdXRvTW9kZVN0YXJ0VGhpbmtpbmdMZXZlbCkge1xuICAgICAgICAgIHBpLnNldFRoaW5raW5nTGV2ZWwocy5hdXRvTW9kZVN0YXJ0VGhpbmtpbmdMZXZlbCk7XG4gICAgICAgIH1cbiAgICAgICAgcy5jdXJyZW50VW5pdE1vZGVsID0gbWF0Y2ggYXMgQXV0b1Nlc3Npb25bXCJjdXJyZW50VW5pdE1vZGVsXCJdO1xuICAgICAgICBjdHgudWkubm90aWZ5KGBIb29rIG1vZGVsIG92ZXJyaWRlOiAke21hdGNoLnByb3ZpZGVyfS8ke21hdGNoLmlkfWAsIFwiaW5mb1wiKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYEhvb2sgbW9kZWwgXCIke2hvb2tNb2RlbE92ZXJyaWRlfVwiIGZvdW5kIGJ1dCBzZXRNb2RlbCBmYWlsZWQuIFVzaW5nIGRlZmF1bHQuYCxcbiAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYEhvb2sgbW9kZWwgXCIke2hvb2tNb2RlbE92ZXJyaWRlfVwiIG5vdCBmb3VuZCBpbiBhdmFpbGFibGUgbW9kZWxzLiBGYWxsaW5nIGJhY2sgdG8gY3VycmVudCBzZXNzaW9uIG1vZGVsLiBgICtcbiAgICAgICAgYEVuc3VyZSB0aGUgbW9kZWwgaXMgZGVmaW5lZCBpbiBtb2RlbHMuanNvbiBhbmQgaGFzIGF1dGggY29uZmlndXJlZC5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gU3RvcmUgdGhlIGZpbmFsIGRpc3BhdGNoZWQgbW9kZWwgSUQgc28gdGhlIGRhc2hib2FyZCBjYW4gcmVhZCBpdCAoIzI4OTkpLlxuICAvLyBUaGlzIGFjY291bnRzIGZvciBob29rIG1vZGVsIG92ZXJyaWRlcyBhcHBsaWVkIGFmdGVyIHNlbGVjdEFuZEFwcGx5TW9kZWwuXG4gIHMuY3VycmVudERpc3BhdGNoZWRNb2RlbElkID0gcy5jdXJyZW50VW5pdE1vZGVsXG4gICAgPyBgJHsocy5jdXJyZW50VW5pdE1vZGVsIGFzIGFueSkucHJvdmlkZXIgPz8gXCJcIn0vJHsocy5jdXJyZW50VW5pdE1vZGVsIGFzIGFueSkuaWQgPz8gXCJcIn1gXG4gICAgOiBudWxsO1xuXG4gIGNvbnN0IGNvbXBhdGliaWxpdHlFcnJvciA9IGdldFdvcmtmbG93VHJhbnNwb3J0U3VwcG9ydEVycm9yKFxuICAgIHMuY3VycmVudFVuaXRNb2RlbD8ucHJvdmlkZXIgPz8gY3R4Lm1vZGVsPy5wcm92aWRlcixcbiAgICBnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JBdXRvVW5pdCh1bml0VHlwZSksXG4gICAge1xuICAgICAgcHJvamVjdFJvb3Q6IHMuYmFzZVBhdGgsXG4gICAgICBzdXJmYWNlOiBcImF1dG8tbW9kZVwiLFxuICAgICAgdW5pdFR5cGUsXG4gICAgICBhdXRoTW9kZTogcy5jdXJyZW50VW5pdE1vZGVsPy5wcm92aWRlclxuICAgICAgICA/IGN0eC5tb2RlbFJlZ2lzdHJ5LmdldFByb3ZpZGVyQXV0aE1vZGUocy5jdXJyZW50VW5pdE1vZGVsLnByb3ZpZGVyKVxuICAgICAgICA6IGN0eC5tb2RlbD8ucHJvdmlkZXJcbiAgICAgICAgICA/IGN0eC5tb2RlbFJlZ2lzdHJ5LmdldFByb3ZpZGVyQXV0aE1vZGUoY3R4Lm1vZGVsLnByb3ZpZGVyKVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgYmFzZVVybDogKHMuY3VycmVudFVuaXRNb2RlbCBhcyBhbnkpPy5iYXNlVXJsID8/IGN0eC5tb2RlbD8uYmFzZVVybCxcbiAgICB9LFxuICApO1xuICBpZiAoY29tcGF0aWJpbGl0eUVycm9yKSB7XG4gICAgY3R4LnVpLm5vdGlmeShjb21wYXRpYmlsaXR5RXJyb3IsIFwiZXJyb3JcIik7XG4gICAgYXdhaXQgZGVwcy5zdG9wQXV0byhjdHgsIHBpLCBjb21wYXRpYmlsaXR5RXJyb3IpO1xuICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwid29ya2Zsb3ctY2FwYWJpbGl0eVwiIH07XG4gIH1cblxuICAvLyBQcm9ncmVzcyB3aWRnZXQgKyBwcmVjb25kaXRpb25zIFx1MjAxNCBkZWZlcnJlZCB0byBhZnRlciBtb2RlbCBzZWxlY3Rpb24gc28gdGhlXG4gIC8vIHdpZGdldCdzIGZpcnN0IHJlbmRlciB0aWNrIHNob3dzIHRoZSBjb3JyZWN0IG1vZGVsICgjMjg5OSkuXG4gIGRlcHMudXBkYXRlUHJvZ3Jlc3NXaWRnZXQoY3R4LCB1bml0VHlwZSwgdW5pdElkLCBzdGF0ZSk7XG4gIGRlcHMuZW5zdXJlUHJlY29uZGl0aW9ucyh1bml0VHlwZSwgdW5pdElkLCBzLmJhc2VQYXRoLCBzdGF0ZSk7XG5cbiAgLy8gU3RhcnQgdW5pdCBzdXBlcnZpc2lvblxuICBkZXBzLmNsZWFyVW5pdFRpbWVvdXQoKTtcbiAgZGVwcy5zdGFydFVuaXRTdXBlcnZpc2lvbih7XG4gICAgcyxcbiAgICBjdHgsXG4gICAgcGksXG4gICAgdW5pdFR5cGUsXG4gICAgdW5pdElkLFxuICAgIHByZWZzLFxuICAgIGJ1aWxkU25hcHNob3RPcHRzOiAoKSA9PiBkZXBzLmJ1aWxkU25hcHNob3RPcHRzKHVuaXRUeXBlLCB1bml0SWQpLFxuICAgIGJ1aWxkUmVjb3ZlcnlDb250ZXh0OiAoKSA9PiAoe1xuICAgICAgYmFzZVBhdGg6IHMuYmFzZVBhdGgsXG4gICAgICB2ZXJib3NlOiBzLnZlcmJvc2UsXG4gICAgICBjdXJyZW50VW5pdFN0YXJ0ZWRBdDogcy5jdXJyZW50VW5pdD8uc3RhcnRlZEF0ID8/IERhdGUubm93KCksXG4gICAgICB1bml0UmVjb3ZlcnlDb3VudDogcy51bml0UmVjb3ZlcnlDb3VudCxcbiAgICB9KSxcbiAgICBwYXVzZUF1dG86IGRlcHMucGF1c2VBdXRvLFxuICB9KTtcblxuICAvLyBXcml0ZSBwcmVsaW1pbmFyeSBsb2NrIChubyBzZXNzaW9uIHBhdGggeWV0IFx1MjAxNCBydW5Vbml0IGNyZWF0ZXMgYSBuZXcgc2Vzc2lvbikuXG4gIC8vIENyYXNoIHJlY292ZXJ5IGNhbiBzdGlsbCBpZGVudGlmeSB0aGUgaW4tZmxpZ2h0IHVuaXQgZnJvbSB0aGlzIGxvY2suXG4gIGRlcHMud3JpdGVMb2NrKFxuICAgIGRlcHMubG9ja0Jhc2UoKSxcbiAgICB1bml0VHlwZSxcbiAgICB1bml0SWQsXG4gICk7XG5cbiAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgcGhhc2U6IFwicnVuVW5pdC1zdGFydFwiLFxuICAgIGl0ZXJhdGlvbjogaWMuaXRlcmF0aW9uLFxuICAgIHVuaXRUeXBlLFxuICAgIHVuaXRJZCxcbiAgfSk7XG4gIGNvbnN0IHVuaXRSZXN1bHQgPSBhd2FpdCBydW5Vbml0KFxuICAgIGN0eCxcbiAgICBwaSxcbiAgICBzLFxuICAgIHVuaXRUeXBlLFxuICAgIHVuaXRJZCxcbiAgICBmaW5hbFByb21wdCxcbiAgKTtcbiAgcy5sYXN0VW5pdEFnZW50RW5kTWVzc2FnZXMgPSB1bml0UmVzdWx0LmV2ZW50Py5tZXNzYWdlcyA/PyBudWxsO1xuICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICBwaGFzZTogXCJydW5Vbml0LWVuZFwiLFxuICAgIGl0ZXJhdGlvbjogaWMuaXRlcmF0aW9uLFxuICAgIHVuaXRUeXBlLFxuICAgIHVuaXRJZCxcbiAgICBzdGF0dXM6IHVuaXRSZXN1bHQuc3RhdHVzLFxuICB9KTtcblxuICBpZiAoXG4gICAgdW5pdFJlc3VsdC5zdGF0dXMgPT09IFwiY29tcGxldGVkXCIgJiZcbiAgICBzLmN1cnJlbnRVbml0ICYmXG4gICAgKHVuaXRSZXN1bHQuZXZlbnQ/Lm1lc3NhZ2VzPy5sZW5ndGggPz8gMCkgPT09IDAgJiZcbiAgICBpc1N1c3BpY2lvdXNHaG9zdENvbXBsZXRpb24oY3R4LCB1bml0UmVzdWx0LnJlcXVlc3REaXNwYXRjaGVkQXQgPz8gcy5jdXJyZW50VW5pdC5zdGFydGVkQXQpXG4gICkge1xuICAgIGNvbnN0IG1lc3NhZ2UgPVxuICAgICAgYCR7dW5pdFR5cGV9ICR7dW5pdElkfSBjb21wbGV0ZWQgd2l0aG91dCBhc3Npc3RhbnQgb3V0cHV0IG9yIHRvb2wgY2FsbHM7IHRyZWF0aW5nIGFzIGEgc3RhbGUgZ2hvc3QgY29tcGxldGlvbi5gO1xuICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgcGhhc2U6IFwiZ2hvc3QtY29tcGxldGlvblwiLFxuICAgICAgaXRlcmF0aW9uOiBpYy5pdGVyYXRpb24sXG4gICAgICB1bml0VHlwZSxcbiAgICAgIHVuaXRJZCxcbiAgICAgIGVsYXBzZWRNczogRGF0ZS5ub3coKSAtICh1bml0UmVzdWx0LnJlcXVlc3REaXNwYXRjaGVkQXQgPz8gcy5jdXJyZW50VW5pdC5zdGFydGVkQXQpLFxuICAgIH0pO1xuICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgbWVzc2FnZSk7XG4gICAgY3R4LnVpLm5vdGlmeShgJHttZXNzYWdlfSBQYXVzaW5nIGF1dG8tbW9kZSBiZWZvcmUgY2xvc2VvdXQgc2lkZSBlZmZlY3RzLmAsIFwid2FybmluZ1wiKTtcbiAgICBhd2FpdCBlbWl0Q2FuY2VsbGVkVW5pdEVuZChpYywgdW5pdFR5cGUsIHVuaXRJZCwgdW5pdFN0YXJ0U2VxLCB7XG4gICAgICBtZXNzYWdlLFxuICAgICAgY2F0ZWdvcnk6IFwidW5rbm93blwiLFxuICAgICAgaXNUcmFuc2llbnQ6IHRydWUsXG4gICAgfSk7XG4gICAgcy5jdXJyZW50VW5pdCA9IG51bGw7XG4gICAgYXdhaXQgZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJnaG9zdC1jb21wbGV0aW9uXCIgfTtcbiAgfVxuXG4gIC8vIE5vdyB0aGF0IHJ1blVuaXQgaGFzIGNhbGxlZCBuZXdTZXNzaW9uKCksIHRoZSBzZXNzaW9uIGZpbGUgcGF0aCBpcyBjb3JyZWN0LlxuICBjb25zdCBzZXNzaW9uRmlsZSA9IGRlcHMuZ2V0U2Vzc2lvbkZpbGUoY3R4KTtcbiAgZGVwcy51cGRhdGVTZXNzaW9uTG9jayhcbiAgICBkZXBzLmxvY2tCYXNlKCksXG4gICAgdW5pdFR5cGUsXG4gICAgdW5pdElkLFxuICAgIHNlc3Npb25GaWxlLFxuICApO1xuICBkZXBzLndyaXRlTG9jayhcbiAgICBkZXBzLmxvY2tCYXNlKCksXG4gICAgdW5pdFR5cGUsXG4gICAgdW5pdElkLFxuICAgIHNlc3Npb25GaWxlLFxuICApO1xuXG4gIC8vIFRhZyB0aGUgbW9zdCByZWNlbnQgd2luZG93IGVudHJ5IHdpdGggZXJyb3IgaW5mbyBmb3Igc3R1Y2sgZGV0ZWN0aW9uXG4gIGNvbnN0IGxhc3RFbnRyeSA9IGxvb3BTdGF0ZS5yZWNlbnRVbml0c1tsb29wU3RhdGUucmVjZW50VW5pdHMubGVuZ3RoIC0gMV07XG4gIGlmIChsYXN0RW50cnkpIHtcbiAgICBpZiAodW5pdFJlc3VsdC5lcnJvckNvbnRleHQpIHtcbiAgICAgIGxhc3RFbnRyeS5lcnJvciA9IGAke3VuaXRSZXN1bHQuZXJyb3JDb250ZXh0LmNhdGVnb3J5fToke3VuaXRSZXN1bHQuZXJyb3JDb250ZXh0Lm1lc3NhZ2V9YC5zbGljZSgwLCAyMDApO1xuICAgIH0gZWxzZSBpZiAodW5pdFJlc3VsdC5zdGF0dXMgPT09IFwiZXJyb3JcIiB8fCB1bml0UmVzdWx0LnN0YXR1cyA9PT0gXCJjYW5jZWxsZWRcIikge1xuICAgICAgbGFzdEVudHJ5LmVycm9yID0gYCR7dW5pdFJlc3VsdC5zdGF0dXN9OiR7dW5pdFR5cGV9LyR7dW5pdElkfWA7XG4gICAgfSBlbHNlIGlmICh1bml0UmVzdWx0LmV2ZW50Py5tZXNzYWdlcz8ubGVuZ3RoKSB7XG4gICAgICBjb25zdCBsYXN0TXNnID0gdW5pdFJlc3VsdC5ldmVudC5tZXNzYWdlc1t1bml0UmVzdWx0LmV2ZW50Lm1lc3NhZ2VzLmxlbmd0aCAtIDFdO1xuICAgICAgY29uc3QgbXNnU3RyID0gdHlwZW9mIGxhc3RNc2cgPT09IFwic3RyaW5nXCIgPyBsYXN0TXNnIDogSlNPTi5zdHJpbmdpZnkobGFzdE1zZyk7XG4gICAgICBpZiAoL2Vycm9yfGZhaWx8ZXhjZXB0aW9uL2kudGVzdChtc2dTdHIpKSB7XG4gICAgICAgIGxhc3RFbnRyeS5lcnJvciA9IG1zZ1N0ci5zbGljZSgwLCAyMDApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmICh1bml0UmVzdWx0LnN0YXR1cyA9PT0gXCJjYW5jZWxsZWRcIikge1xuICAgIGNvbnN0IGVycm9yQ2F0ZWdvcnkgPSB1bml0UmVzdWx0LmVycm9yQ29udGV4dD8uY2F0ZWdvcnk7XG4gICAgLy8gUHJvdmlkZXItZXJyb3IgcGF1c2U6IGFnZW50X2VuZCByZWNvdmVyeSBub3JtYWxseSBwYXVzZXMgYmVmb3JlIHRoaXNcbiAgICAvLyBicmFuY2guIFByb3ZpZGVyIHJlYWRpbmVzcyBmYWlsdXJlcyBoYXBwZW4gYmVmb3JlIGRpc3BhdGNoLCBzbyBwYXVzZSBoZXJlXG4gICAgLy8gaWYgbm90aGluZyB1cHN0cmVhbSBhbHJlYWR5IGRpZC5cbiAgICBpZiAoZXJyb3JDYXRlZ29yeSA9PT0gXCJwcm92aWRlclwiKSB7XG4gICAgICBpZiAoIXMucGF1c2VkKSB7XG4gICAgICAgIGNvbnN0IGRldGFpbCA9IHVuaXRSZXN1bHQuZXJyb3JDb250ZXh0Py5tZXNzYWdlID8/IGBQcm92aWRlciB1bmF2YWlsYWJsZSBmb3IgJHt1bml0VHlwZX0gJHt1bml0SWR9YDtcbiAgICAgICAgYXdhaXQgcGF1c2VBdXRvRm9yUHJvdmlkZXJFcnJvcihcbiAgICAgICAgICBjdHgudWksXG4gICAgICAgICAgZGV0YWlsLFxuICAgICAgICAgICgpID0+IGRlcHMucGF1c2VBdXRvKGN0eCwgcGkpLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGlzUmF0ZUxpbWl0OiBmYWxzZSxcbiAgICAgICAgICAgIGlzVHJhbnNpZW50OiBCb29sZWFuKHVuaXRSZXN1bHQuZXJyb3JDb250ZXh0Py5pc1RyYW5zaWVudCksXG4gICAgICAgICAgICByZXRyeUFmdGVyTXM6IHVuaXRSZXN1bHQuZXJyb3JDb250ZXh0Py5yZXRyeUFmdGVyTXMsXG4gICAgICAgICAgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IGVtaXRDYW5jZWxsZWRVbml0RW5kKGljLCB1bml0VHlwZSwgdW5pdElkLCB1bml0U3RhcnRTZXEsIHVuaXRSZXN1bHQuZXJyb3JDb250ZXh0KTtcbiAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJleGl0XCIsIHJlYXNvbjogXCJwcm92aWRlci1wYXVzZVwiLCBpc1RyYW5zaWVudDogdW5pdFJlc3VsdC5lcnJvckNvbnRleHQ/LmlzVHJhbnNpZW50IH0pO1xuICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJwcm92aWRlci1wYXVzZVwiIH07XG4gICAgfVxuICAgIC8vIFRpbWVvdXQgY2F0ZWdvcnkgY292ZXJzIHR3byBkaXN0aW5jdCBzY2VuYXJpb3M6XG4gICAgLy8gICAxLiBTZXNzaW9uIGNyZWF0aW9uIHRpbWVvdXQgKDEyMHMpIFx1MjAxNCB0cmFuc2llbnQsIGF1dG8tcmVzdW1lIHdpdGggYmFja29mZlxuICAgIC8vICAgMi4gVW5pdCBoYXJkIHRpbWVvdXQgKDMwbWluKykgXHUyMDE0IHN0dWNrIGFnZW50LCBwYXVzZSBmb3IgbWFudWFsIHJldmlld1xuICAgIC8vIFRyYW5zaWVudCBzZXNzaW9uLWZhaWxlZCBjb3ZlcnMgcmVjb3ZlcmFibGUgbmV3U2Vzc2lvbiBmYWlsdXJlcyBhbmQgc2hvdWxkXG4gICAgLy8gcGF1c2UgaW5zdGVhZCBvZiBoYXJkLXN0b3BwaW5nLlxuICAgIC8vIFN0cnVjdHVyYWwgZXJyb3JzIChUeXBlRXJyb3IsIGlzIG5vdCBhIGZ1bmN0aW9uKSBhcmUgTk9UIHRyYW5zaWVudFxuICAgIC8vIGFuZCBtdXN0IGhhcmQtc3RvcCB0byBhdm9pZCBpbmZpbml0ZSByZXRyeSBsb29wcy5cbiAgICBpZiAoXG4gICAgICB1bml0UmVzdWx0LmVycm9yQ29udGV4dD8uaXNUcmFuc2llbnQgJiZcbiAgICAgIGVycm9yQ2F0ZWdvcnkgPT09IFwidGltZW91dFwiXG4gICAgKSB7XG4gICAgICBjb25zdCBpc1Nlc3Npb25DcmVhdGlvblRpbWVvdXQgPSB1bml0UmVzdWx0LmVycm9yQ29udGV4dC5tZXNzYWdlPy5pbmNsdWRlcyhcIlNlc3Npb24gY3JlYXRpb24gdGltZWQgb3V0XCIpO1xuXG4gICAgICBpZiAoaXNTZXNzaW9uQ3JlYXRpb25UaW1lb3V0KSB7XG4gICAgICAgIGNvbnNlY3V0aXZlU2Vzc2lvblRpbWVvdXRzICs9IDE7XG4gICAgICAgIGNvbnN0IGJhc2VSZXRyeUFmdGVyTXMgPSAzMF8wMDA7XG4gICAgICAgIGNvbnN0IHJldHJ5QWZ0ZXJNcyA9IGJhc2VSZXRyeUFmdGVyTXMgKiAyICoqIE1hdGgubWF4KDAsIGNvbnNlY3V0aXZlU2Vzc2lvblRpbWVvdXRzIC0gMSk7XG4gICAgICAgIGNvbnN0IGFsbG93QXV0b1Jlc3VtZSA9IGNvbnNlY3V0aXZlU2Vzc2lvblRpbWVvdXRzIDw9IE1BWF9TRVNTSU9OX1RJTUVPVVRfQVVUT19SRVNVTUVTO1xuXG4gICAgICAgIGlmICghYWxsb3dBdXRvUmVzdW1lKSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBTZXNzaW9uIGNyZWF0aW9uIHRpbWVkIG91dCAke2NvbnNlY3V0aXZlU2Vzc2lvblRpbWVvdXRzfSBjb25zZWN1dGl2ZSB0aW1lcyBmb3IgJHt1bml0VHlwZX0gJHt1bml0SWR9LiBQYXVzaW5nIGZvciBtYW51YWwgcmV2aWV3LmAsXG4gICAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgICAgICAgcGhhc2U6IFwic2Vzc2lvbi10aW1lb3V0LXBhdXNlXCIsXG4gICAgICAgICAgdW5pdFR5cGUsIHVuaXRJZCxcbiAgICAgICAgICBjb25zZWN1dGl2ZVNlc3Npb25UaW1lb3V0cyxcbiAgICAgICAgICByZXRyeUFmdGVyTXMsXG4gICAgICAgICAgYWxsb3dBdXRvUmVzdW1lLFxuICAgICAgICB9KTtcblxuICAgICAgICBjb25zdCBlcnJvckRldGFpbCA9IGAgZm9yICR7dW5pdFR5cGV9ICR7dW5pdElkfWA7XG4gICAgICAgIGF3YWl0IHBhdXNlQXV0b0ZvclByb3ZpZGVyRXJyb3IoXG4gICAgICAgICAgY3R4LnVpLFxuICAgICAgICAgIGVycm9yRGV0YWlsLFxuICAgICAgICAgICgpID0+IGRlcHMucGF1c2VBdXRvKGN0eCwgcGkpLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGlzUmF0ZUxpbWl0OiBmYWxzZSxcbiAgICAgICAgICAgIGlzVHJhbnNpZW50OiBhbGxvd0F1dG9SZXN1bWUsXG4gICAgICAgICAgICByZXRyeUFmdGVyTXMsXG4gICAgICAgICAgICByZXN1bWU6IGFsbG93QXV0b1Jlc3VtZVxuICAgICAgICAgICAgICA/ICgpID0+IHtcbiAgICAgICAgICAgICAgICAgIHZvaWQgcmVzdW1lQXV0b0FmdGVyUHJvdmlkZXJEZWxheShwaSwgY3R4KS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICAgICAgICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICAgICAgICAgICAgYFNlc3Npb24gdGltZW91dCByZWNvdmVyeSBmYWlsZWQ6ICR7bWVzc2FnZX1gLFxuICAgICAgICAgICAgICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgICAgfSxcbiAgICAgICAgKTtcbiAgICAgICAgYXdhaXQgZGVwcy5hdXRvQ29tbWl0VW5pdD8uKHMuYmFzZVBhdGgsIHVuaXRUeXBlLCB1bml0SWQsIGN0eCk7XG4gICAgICAgIGF3YWl0IGVtaXRDYW5jZWxsZWRVbml0RW5kKGljLCB1bml0VHlwZSwgdW5pdElkLCB1bml0U3RhcnRTZXEsIHVuaXRSZXN1bHQuZXJyb3JDb250ZXh0KTtcbiAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJzZXNzaW9uLXRpbWVvdXRcIiB9O1xuICAgICAgfVxuXG4gICAgICAvLyBVbml0IGhhcmQgdGltZW91dCAoMzBtaW4rKTogcGF1c2Ugd2l0aG91dCBhdXRvLXJlc3VtZSBcdTIwMTQgc3R1Y2sgYWdlbnRcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBVbml0IHRpbWVkIG91dCBmb3IgJHt1bml0VHlwZX0gJHt1bml0SWR9IChzdXBlcnZpc2lvbiBtYXkgaGF2ZSBmYWlsZWQpLiBQYXVzaW5nIGF1dG8tbW9kZS5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwidW5pdC1oYXJkLXRpbWVvdXQtcGF1c2VcIiwgdW5pdFR5cGUsIHVuaXRJZCB9KTtcbiAgICAgIGF3YWl0IGRlcHMucGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgYXdhaXQgZGVwcy5hdXRvQ29tbWl0VW5pdD8uKHMuYmFzZVBhdGgsIHVuaXRUeXBlLCB1bml0SWQsIGN0eCk7XG4gICAgICBhd2FpdCBlbWl0Q2FuY2VsbGVkVW5pdEVuZChpYywgdW5pdFR5cGUsIHVuaXRJZCwgdW5pdFN0YXJ0U2VxLCB1bml0UmVzdWx0LmVycm9yQ29udGV4dCk7XG4gICAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBcInVuaXQtaGFyZC10aW1lb3V0XCIgfTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgdW5pdFJlc3VsdC5lcnJvckNvbnRleHQ/LmlzVHJhbnNpZW50ICYmXG4gICAgICBlcnJvckNhdGVnb3J5ID09PSBcInNlc3Npb24tZmFpbGVkXCJcbiAgICApIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBTZXNzaW9uIGNyZWF0aW9uIGZhaWxlZCB0cmFuc2llbnRseSBmb3IgJHt1bml0VHlwZX0gJHt1bml0SWR9OiAke3VuaXRSZXN1bHQuZXJyb3JDb250ZXh0Py5tZXNzYWdlID8/IFwidW5rbm93blwifS4gUGF1c2luZyBhdXRvLW1vZGUgKHJlY292ZXJhYmxlKS5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwic2Vzc2lvbi1zdGFydC10cmFuc2llbnQtcGF1c2VcIiwgdW5pdFR5cGUsIHVuaXRJZCwgY2F0ZWdvcnk6IGVycm9yQ2F0ZWdvcnkgfSk7XG4gICAgICBhd2FpdCBkZXBzLnBhdXNlQXV0byhjdHgsIHBpKTtcbiAgICAgIGF3YWl0IGRlcHMuYXV0b0NvbW1pdFVuaXQ/LihzLmJhc2VQYXRoLCB1bml0VHlwZSwgdW5pdElkLCBjdHgpO1xuICAgICAgYXdhaXQgZW1pdENhbmNlbGxlZFVuaXRFbmQoaWMsIHVuaXRUeXBlLCB1bml0SWQsIHVuaXRTdGFydFNlcSwgdW5pdFJlc3VsdC5lcnJvckNvbnRleHQpO1xuICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJzZXNzaW9uLXRpbWVvdXRcIiB9O1xuICAgIH1cbiAgICBpZiAoXG4gICAgICB1bml0UmVzdWx0LmVycm9yQ29udGV4dD8uaXNUcmFuc2llbnQgJiZcbiAgICAgIGVycm9yQ2F0ZWdvcnkgPT09IFwiYWJvcnRlZFwiXG4gICAgKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgVW5pdCAke3VuaXRUeXBlfSAke3VuaXRJZH0gd2FzIGFib3J0ZWQgYnkgdGhlIHVzZXIuIFBhdXNpbmcgYXV0by1tb2RlIChyZWNvdmVyYWJsZSkuYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcInVuaXQtYWJvcnRlZC10cmFuc2llbnQtcGF1c2VcIiwgdW5pdFR5cGUsIHVuaXRJZCwgY2F0ZWdvcnk6IGVycm9yQ2F0ZWdvcnkgfSk7XG4gICAgICBhd2FpdCBkZXBzLnBhdXNlQXV0byhjdHgsIHBpKTtcbiAgICAgIGF3YWl0IGRlcHMuYXV0b0NvbW1pdFVuaXQ/LihzLmJhc2VQYXRoLCB1bml0VHlwZSwgdW5pdElkLCBjdHgpO1xuICAgICAgYXdhaXQgZW1pdENhbmNlbGxlZFVuaXRFbmQoaWMsIHVuaXRUeXBlLCB1bml0SWQsIHVuaXRTdGFydFNlcSwgdW5pdFJlc3VsdC5lcnJvckNvbnRleHQpO1xuICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJ1bml0LWFib3J0ZWQtcGF1c2VcIiB9O1xuICAgIH1cbiAgICAvLyBBbGwgb3RoZXIgY2FuY2VsbGVkIHN0YXRlcyAoc3RydWN0dXJhbCBlcnJvcnMsIG5vbi10cmFuc2llbnQgZmFpbHVyZXMpOiBoYXJkIHN0b3BcbiAgICBpZiAocy5jdXJyZW50VW5pdCkge1xuICAgICAgYXdhaXQgZGVwcy5jbG9zZW91dFVuaXQoXG4gICAgICAgIGN0eCxcbiAgICAgICAgcy5iYXNlUGF0aCxcbiAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgIHVuaXRJZCxcbiAgICAgICAgcy5jdXJyZW50VW5pdC5zdGFydGVkQXQsXG4gICAgICAgIGRlcHMuYnVpbGRTbmFwc2hvdE9wdHModW5pdFR5cGUsIHVuaXRJZCksXG4gICAgICApO1xuICAgIH1cbiAgICBhd2FpdCBkZXBzLmF1dG9Db21taXRVbml0Py4ocy5iYXNlUGF0aCwgdW5pdFR5cGUsIHVuaXRJZCwgY3R4KTtcbiAgICBhd2FpdCBlbWl0Q2FuY2VsbGVkVW5pdEVuZChpYywgdW5pdFR5cGUsIHVuaXRJZCwgdW5pdFN0YXJ0U2VxLCB1bml0UmVzdWx0LmVycm9yQ29udGV4dCk7XG5cbiAgICBjb25zdCBjYW5jZWxsZWRTdG9wID0gX2J1aWxkQ2FuY2VsbGVkVW5pdFN0b3BSZWFzb24oXG4gICAgICB1bml0VHlwZSxcbiAgICAgIHVuaXRJZCxcbiAgICAgIHVuaXRSZXN1bHQuZXJyb3JDb250ZXh0LFxuICAgICk7XG4gICAgY3R4LnVpLm5vdGlmeShjYW5jZWxsZWRTdG9wLm5vdGlmeU1lc3NhZ2UsIFwid2FybmluZ1wiKTtcbiAgICBhd2FpdCBkZXBzLnN0b3BBdXRvKGN0eCwgcGksIGNhbmNlbGxlZFN0b3Auc3RvcFJlYXNvbik7XG4gICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImV4aXRcIiwgcmVhc29uOiBjYW5jZWxsZWRTdG9wLmxvb3BSZWFzb24gfSk7XG4gICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogY2FuY2VsbGVkU3RvcC5sb29wUmVhc29uIH07XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgSW1tZWRpYXRlIHVuaXQgY2xvc2VvdXQgKG1ldHJpY3MsIGFjdGl2aXR5IGxvZywgbWVtb3J5KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gUnVuIHJpZ2h0IGFmdGVyIHJ1blVuaXQoKSByZXR1cm5zIHNvIHRlbGVtZXRyeSBpcyBuZXZlciBsb3N0IHRvIGFcbiAgLy8gY3Jhc2ggYmV0d2VlbiBpdGVyYXRpb25zLlxuICAvLyBHdWFyZDogc3RvcEF1dG8oKSBtYXkgaGF2ZSBudWxsZWQgcy5jdXJyZW50VW5pdCB2aWEgcy5yZXNldCgpIHdoaWxlXG4gIC8vIHRoaXMgY29yb3V0aW5lIHdhcyBzdXNwZW5kZWQgYXQgYGF3YWl0IHJ1blVuaXQoLi4uKWAgKCMyOTM5KS5cbiAgaWYgKHMuY3VycmVudFVuaXQpIHtcbiAgICAvLyBSZXNldCBzZXNzaW9uIHRpbWVvdXQgY291bnRlciBcdTIwMTQgYW55IHN1Y2Nlc3NmdWwgdW5pdCBjbGVhcnMgdGhlIHNsYXRlXG4gICAgY29uc2VjdXRpdmVTZXNzaW9uVGltZW91dHMgPSAwO1xuICAgIGF3YWl0IGRlcHMuY2xvc2VvdXRVbml0KFxuICAgICAgY3R4LFxuICAgICAgcy5iYXNlUGF0aCxcbiAgICAgIHVuaXRUeXBlLFxuICAgICAgdW5pdElkLFxuICAgICAgcy5jdXJyZW50VW5pdC5zdGFydGVkQXQsXG4gICAgICBkZXBzLmJ1aWxkU25hcHNob3RPcHRzKHVuaXRUeXBlLCB1bml0SWQpLFxuICAgICk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgWmVybyB0b29sLWNhbGwgZ3VhcmQgKCMxODMzLCAjMjY1MykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIEFueSB1bml0IHRoYXQgY29tcGxldGVzIHdpdGggMCB0b29sIGNhbGxzIG1hZGUgbm8gcmVhbCBwcm9ncmVzcyBcdTIwMTRcbiAgLy8gbGlrZWx5IGNvbnRleHQgZXhoYXVzdGlvbiB3aGVyZSBhbGwgdG9vbCBjYWxscyBlcnJvcmVkIG91dC4gVHJlYXRcbiAgLy8gYXMgZmFpbGVkIHNvIHRoZSB1bml0IGlzIHJldHJpZWQgaW4gYSBmcmVzaCBjb250ZXh0IGluc3RlYWQgb2ZcbiAgLy8gc2lsZW50bHkgcGFzc2luZyB0aHJvdWdoIHRvIGFydGlmYWN0IHZlcmlmaWNhdGlvbiAod2hpY2ggbG9vcHNcbiAgLy8gZm9yZXZlciB3aGVuIHRoZSB1bml0IG5ldmVyIHByb2R1Y2VkIGl0cyBhcnRpZmFjdCkuXG4gIHtcbiAgICBjb25zdCBjdXJyZW50TGVkZ2VyID0gZGVwcy5nZXRMZWRnZXIoKSBhcyB7IHVuaXRzOiBBcnJheTx7IHR5cGU6IHN0cmluZzsgaWQ6IHN0cmluZzsgc3RhcnRlZEF0OiBudW1iZXI7IHRvb2xDYWxsczogbnVtYmVyIH0+IH0gfCBudWxsO1xuICAgIGlmIChjdXJyZW50TGVkZ2VyPy51bml0cykge1xuICAgICAgY29uc3QgbGFzdFVuaXQgPSBbLi4uY3VycmVudExlZGdlci51bml0c10ucmV2ZXJzZSgpLmZpbmQoXG4gICAgICAgICh1OiB7IHR5cGU6IHN0cmluZzsgaWQ6IHN0cmluZzsgc3RhcnRlZEF0OiBudW1iZXI7IHRvb2xDYWxsczogbnVtYmVyIH0pID0+IHUudHlwZSA9PT0gdW5pdFR5cGUgJiYgdS5pZCA9PT0gdW5pdElkICYmIHUuc3RhcnRlZEF0ID09PSBfcmVzb2x2ZUN1cnJlbnRVbml0U3RhcnRlZEF0Rm9yVGVzdChzLmN1cnJlbnRVbml0KSxcbiAgICAgICk7XG4gICAgICBpZiAobGFzdFVuaXQgJiYgbGFzdFVuaXQudG9vbENhbGxzID09PSAwKSB7XG4gICAgICAgIGlmIChVU0VSX0RSSVZFTl9ERUVQX1VOSVRTLmhhcyh1bml0VHlwZSkgJiYgaXNBd2FpdGluZ1VzZXJJbnB1dChzLmxhc3RVbml0QWdlbnRFbmRNZXNzYWdlcyA/PyB1bmRlZmluZWQpKSB7XG4gICAgICAgICAgZGVidWdMb2coXCJydW5Vbml0UGhhc2VcIiwge1xuICAgICAgICAgICAgcGhhc2U6IFwiemVyby10b29sLWNhbGxzLWF3YWl0aW5nLXVzZXItaW5wdXRcIixcbiAgICAgICAgICAgIHVuaXRUeXBlLFxuICAgICAgICAgICAgdW5pdElkLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGRlYnVnTG9nKFwicnVuVW5pdFBoYXNlXCIsIHtcbiAgICAgICAgICAgIHBoYXNlOiBcInplcm8tdG9vbC1jYWxsc1wiLFxuICAgICAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgICAgICB1bml0SWQsXG4gICAgICAgICAgICB3YXJuaW5nOiBcIlVuaXQgY29tcGxldGVkIHdpdGggMCB0b29sIGNhbGxzIFx1MjAxNCBsaWtlbHkgY29udGV4dCBleGhhdXN0aW9uLCBtYXJraW5nIGFzIGZhaWxlZFwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICBgJHt1bml0VHlwZX0gJHt1bml0SWR9IGNvbXBsZXRlZCB3aXRoIDAgdG9vbCBjYWxscyBcdTIwMTQgY29udGV4dCBleGhhdXN0aW9uLCB3aWxsIHJldHJ5YCxcbiAgICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICAgICk7XG4gICAgICAgICAgLy8gRmFsbCB0aHJvdWdoIHRvIG5leHQgaXRlcmF0aW9uIHdoZXJlIGRpc3BhdGNoIHdpbGwgcmUtZGVyaXZlXG4gICAgICAgICAgLy8gYW5kIHJlLWRpc3BhdGNoIHRoaXMgdW5pdC5cbiAgICAgICAgICByZXR1cm4geyBhY3Rpb246IFwibmV4dFwiLCBkYXRhOiB7IHVuaXRTdGFydGVkQXQ6IF9yZXNvbHZlQ3VycmVudFVuaXRTdGFydGVkQXRGb3JUZXN0KHMuY3VycmVudFVuaXQpLCByZXF1ZXN0RGlzcGF0Y2hlZEF0OiB1bml0UmVzdWx0LnJlcXVlc3REaXNwYXRjaGVkQXQgfSB9O1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKHMuY3VycmVudFVuaXRSb3V0aW5nKSB7XG4gICAgZGVwcy5yZWNvcmRPdXRjb21lKFxuICAgICAgdW5pdFR5cGUsXG4gICAgICBzLmN1cnJlbnRVbml0Um91dGluZy50aWVyIGFzIFwibGlnaHRcIiB8IFwic3RhbmRhcmRcIiB8IFwiaGVhdnlcIixcbiAgICAgIHRydWUsIC8vIHN1Y2Nlc3MgYXNzdW1lZDsgZGlzcGF0Y2ggd2lsbCByZS1kaXNwYXRjaCBpZiBhcnRpZmFjdCBtaXNzaW5nXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHNraXBBcnRpZmFjdFZlcmlmaWNhdGlvbiA9IHVuaXRUeXBlLnN0YXJ0c1dpdGgoXCJob29rL1wiKSB8fCB1bml0VHlwZSA9PT0gXCJjdXN0b20tc3RlcFwiO1xuICBjb25zdCBhcnRpZmFjdFZlcmlmaWVkID1cbiAgICBza2lwQXJ0aWZhY3RWZXJpZmljYXRpb24gfHxcbiAgICB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KHVuaXRUeXBlLCB1bml0SWQsIHMuYmFzZVBhdGgpO1xuICBpZiAoYXJ0aWZhY3RWZXJpZmllZCkge1xuICAgIHMudW5pdERpc3BhdGNoQ291bnQuZGVsZXRlKGRpc3BhdGNoS2V5KTtcbiAgICBzLnVuaXRSZWNvdmVyeUNvdW50LmRlbGV0ZShgJHt1bml0VHlwZX0vJHt1bml0SWR9YCk7XG4gIH1cblxuICAvLyBXcml0ZSBwaGFzZSBoYW5kb2ZmIGFuY2hvciBhZnRlciBzdWNjZXNzZnVsIHJlc2VhcmNoL3BsYW5uaW5nIGNvbXBsZXRpb25cbiAgY29uc3QgYW5jaG9yUGhhc2VzID0gbmV3IFNldChbXCJyZXNlYXJjaC1taWxlc3RvbmVcIiwgXCJyZXNlYXJjaC1zbGljZVwiLCBcInBsYW4tbWlsZXN0b25lXCIsIFwicGxhbi1zbGljZVwiXSk7XG4gIGlmIChhcnRpZmFjdFZlcmlmaWVkICYmIG1pZCAmJiBhbmNob3JQaGFzZXMuaGFzKHVuaXRUeXBlKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHdyaXRlUGhhc2VBbmNob3IgfSA9IGF3YWl0IGltcG9ydChcIi4uL3BoYXNlLWFuY2hvci5qc1wiKTtcbiAgICAgIHdyaXRlUGhhc2VBbmNob3Iocy5iYXNlUGF0aCwgbWlkLCB7XG4gICAgICAgIHBoYXNlOiB1bml0VHlwZSxcbiAgICAgICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICAgICAgZ2VuZXJhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgaW50ZW50OiBgQ29tcGxldGVkICR7dW5pdFR5cGV9IGZvciAke3VuaXRJZH1gLFxuICAgICAgICBkZWNpc2lvbnM6IFtdLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgIG5leHRTdGVwczogW10sXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlcnIpIHsgLyogbm9uLWZhdGFsIFx1MjAxNCBhbmNob3IgaXMgYWR2aXNvcnkgKi9cbiAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYHBoYXNlIGFuY2hvciBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgIH1cbiAgfVxuXG4gIGRlcHMuZW1pdEpvdXJuYWxFdmVudCh7IHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIGZsb3dJZDogaWMuZmxvd0lkLCBzZXE6IGljLm5leHRTZXEoKSwgZXZlbnRUeXBlOiBcInVuaXQtZW5kXCIsIGRhdGE6IHsgdW5pdFR5cGUsIHVuaXRJZCwgc3RhdHVzOiB1bml0UmVzdWx0LnN0YXR1cywgYXJ0aWZhY3RWZXJpZmllZCwgLi4uKHVuaXRSZXN1bHQuZXJyb3JDb250ZXh0ID8geyBlcnJvckNvbnRleHQ6IHVuaXRSZXN1bHQuZXJyb3JDb250ZXh0IH0gOiB7fSkgfSwgY2F1c2VkQnk6IHsgZmxvd0lkOiBpYy5mbG93SWQsIHNlcTogdW5pdFN0YXJ0U2VxIH0gfSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFNhZmV0eSBoYXJuZXNzOiBjaGVja3BvaW50IGNsZWFudXAgb3Igcm9sbGJhY2sgXHUyNTAwXHUyNTAwXG4gIGlmIChzLmNoZWNrcG9pbnRTaGEpIHtcbiAgICBpZiAodW5pdFJlc3VsdC5zdGF0dXMgPT09IFwiZXJyb3JcIiAmJiBzYWZldHlDb25maWcuYXV0b19yb2xsYmFjaykge1xuICAgICAgY29uc3Qgcm9sbGVkID0gcm9sbGJhY2tUb0NoZWNrcG9pbnQocy5iYXNlUGF0aCwgdW5pdElkLCBzLmNoZWNrcG9pbnRTaGEpO1xuICAgICAgaWYgKHJvbGxlZCkge1xuICAgICAgICBjdHgudWkubm90aWZ5KGBSb2xsZWQgYmFjayB0byBwcmUtdW5pdCBjaGVja3BvaW50IGZvciAke3VuaXRJZH1gLCBcImluZm9cIik7XG4gICAgICAgIGRlYnVnTG9nKFwicnVuVW5pdFBoYXNlXCIsIHsgcGhhc2U6IFwiY2hlY2twb2ludC1yb2xsYmFja1wiLCB1bml0SWQgfSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh1bml0UmVzdWx0LnN0YXR1cyA9PT0gXCJlcnJvclwiKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgVW5pdCAke3VuaXRJZH0gZmFpbGVkLiBQcmUtdW5pdCBjaGVja3BvaW50IGF2YWlsYWJsZSBhdCAke3MuY2hlY2twb2ludFNoYS5zbGljZSgwLCA4KX1gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFN1Y2Nlc3MgXHUyMDE0IGNsZWFuIHVwIGNoZWNrcG9pbnQgcmVmXG4gICAgICBjbGVhbnVwQ2hlY2twb2ludChzLmJhc2VQYXRoLCB1bml0SWQpO1xuICAgICAgZGVidWdMb2coXCJydW5Vbml0UGhhc2VcIiwgeyBwaGFzZTogXCJjaGVja3BvaW50LWNsZWFuZWRcIiwgdW5pdElkIH0pO1xuICAgIH1cbiAgICBzLmNoZWNrcG9pbnRTaGEgPSBudWxsO1xuICB9XG5cbiAgcmV0dXJuIHsgYWN0aW9uOiBcIm5leHRcIiwgZGF0YTogeyB1bml0U3RhcnRlZEF0OiBfcmVzb2x2ZUN1cnJlbnRVbml0U3RhcnRlZEF0Rm9yVGVzdChzLmN1cnJlbnRVbml0KSwgcmVxdWVzdERpc3BhdGNoZWRBdDogdW5pdFJlc3VsdC5yZXF1ZXN0RGlzcGF0Y2hlZEF0IH0gfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHJ1bkZpbmFsaXplIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFBoYXNlIDU6IFBvc3QtdW5pdCBmaW5hbGl6ZSBcdTIwMTQgcHJlL3Bvc3QgdmVyaWZpY2F0aW9uLCBVQVQgcGF1c2UsIHN0ZXAtd2l6YXJkLlxuICogUmV0dXJucyBicmVhay9jb250aW51ZS9uZXh0IHRvIGNvbnRyb2wgdGhlIG91dGVyIGxvb3AuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5GaW5hbGl6ZShcbiAgaWM6IEl0ZXJhdGlvbkNvbnRleHQsXG4gIGl0ZXJEYXRhOiBJdGVyYXRpb25EYXRhLFxuICBsb29wU3RhdGU6IExvb3BTdGF0ZSxcbiAgc2lkZWNhckl0ZW0/OiBTaWRlY2FySXRlbSxcbik6IFByb21pc2U8UGhhc2VSZXN1bHQ+IHtcbiAgY29uc3QgeyBjdHgsIHBpLCBzLCBkZXBzIH0gPSBpYztcbiAgY29uc3QgeyBwYXVzZUFmdGVyVWF0RGlzcGF0Y2ggfSA9IGl0ZXJEYXRhO1xuXG4gIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJmaW5hbGl6ZVwiLCBpdGVyYXRpb246IGljLml0ZXJhdGlvbiB9KTtcblxuICAvLyBDbGVhciB1bml0IHRpbWVvdXQgKHVuaXQgY29tcGxldGVkKVxuICBkZXBzLmNsZWFyVW5pdFRpbWVvdXQoKTtcblxuICAvLyBQb3N0LXVuaXQgY29udGV4dCBmb3IgcHJlL3Bvc3QgdmVyaWZpY2F0aW9uXG4gIGNvbnN0IHBvc3RVbml0Q3R4OiBQb3N0VW5pdENvbnRleHQgPSB7XG4gICAgcyxcbiAgICBjdHgsXG4gICAgcGksXG4gICAgYnVpbGRTbmFwc2hvdE9wdHM6IGRlcHMuYnVpbGRTbmFwc2hvdE9wdHMsXG4gICAgbG9ja0Jhc2U6IGRlcHMubG9ja0Jhc2UsXG4gICAgc3RvcEF1dG86IGRlcHMuc3RvcEF1dG8sXG4gICAgcGF1c2VBdXRvOiBkZXBzLnBhdXNlQXV0byxcbiAgICB1cGRhdGVQcm9ncmVzc1dpZGdldDogZGVwcy51cGRhdGVQcm9ncmVzc1dpZGdldCxcbiAgfTtcblxuICAvLyBQcmUtdmVyaWZpY2F0aW9uIHByb2Nlc3NpbmcgKGNvbW1pdCwgZG9jdG9yLCBzdGF0ZSByZWJ1aWxkLCBldGMuKVxuICAvLyBUaW1lb3V0IGd1YXJkOiBpZiBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbiBoYW5ncyAoZS5nLiwgc2FmZXR5IGhhcm5lc3NcbiAgLy8gZGVhZGxvY2ssIGJyb3dzZXIgdGVhcmRvd24gaGFuZywgd29ya3RyZWUgc3luYyBzdGFsbCksIGZvcmNlLWNvbnRpbnVlXG4gIC8vIGFmdGVyIHRpbWVvdXQgc28gdGhlIGF1dG8tbG9vcCBpcyBub3QgcGVybWFuZW50bHkgZnJvemVuICgjMzc1NykuXG4gIC8vXG4gIC8vIE9uIHRpbWVvdXQsIG51bGwgb3V0IHMuY3VycmVudFVuaXQgc28gdGhlIHRpbWVkLW91dCB0YXNrJ3MgbGF0ZSBhc3luY1xuICAvLyBtdXRhdGlvbnMgYXJlIGhhcm1sZXNzIFx1MjAxNCBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbiBndWFyZHMgYWxsIHNpZGUgZWZmZWN0c1xuICAvLyBiZWhpbmQgYGlmIChzLmN1cnJlbnRVbml0KWAuIFRoZSBuZXh0IGl0ZXJhdGlvbiBzZXRzIGEgZnJlc2ggY3VycmVudFVuaXQuXG4gIC8vIFNpZGVjYXIgaXRlbXMgdXNlIGxpZ2h0d2VpZ2h0IHByZS12ZXJpZmljYXRpb24gb3B0c1xuICBjb25zdCBwcmVWZXJpZmljYXRpb25PcHRzOiBQcmVWZXJpZmljYXRpb25PcHRzID0gc2lkZWNhckl0ZW1cbiAgICA/IHNpZGVjYXJJdGVtLmtpbmQgPT09IFwiaG9va1wiXG4gICAgICA/IHsgc2tpcFNldHRsZURlbGF5OiB0cnVlLCBza2lwV29ya3RyZWVTeW5jOiB0cnVlLCBhZ2VudEVuZE1lc3NhZ2VzOiBzLmxhc3RVbml0QWdlbnRFbmRNZXNzYWdlcyA/PyB1bmRlZmluZWQgfVxuICAgICAgOiB7IHNraXBTZXR0bGVEZWxheTogdHJ1ZSwgYWdlbnRFbmRNZXNzYWdlczogcy5sYXN0VW5pdEFnZW50RW5kTWVzc2FnZXMgPz8gdW5kZWZpbmVkIH1cbiAgICA6IHsgYWdlbnRFbmRNZXNzYWdlczogcy5sYXN0VW5pdEFnZW50RW5kTWVzc2FnZXMgPz8gdW5kZWZpbmVkIH07XG4gIGNvbnN0IHByZVVuaXRTbmFwc2hvdCA9IHMuY3VycmVudFVuaXRcbiAgICA/IHsgdHlwZTogcy5jdXJyZW50VW5pdC50eXBlLCBpZDogcy5jdXJyZW50VW5pdC5pZCwgc3RhcnRlZEF0OiBzLmN1cnJlbnRVbml0LnN0YXJ0ZWRBdCB9XG4gICAgOiBudWxsO1xuICBjb25zdCBwcmVSZXN1bHRHdWFyZCA9IGF3YWl0IHdpdGhUaW1lb3V0KFxuICAgIGRlcHMucG9zdFVuaXRQcmVWZXJpZmljYXRpb24ocG9zdFVuaXRDdHgsIHByZVZlcmlmaWNhdGlvbk9wdHMpLFxuICAgIEZJTkFMSVpFX1BSRV9USU1FT1VUX01TLFxuICAgIFwicG9zdFVuaXRQcmVWZXJpZmljYXRpb25cIixcbiAgKTtcblxuICBpZiAocHJlUmVzdWx0R3VhcmQudGltZWRPdXQpIHtcbiAgICByZXR1cm4gZmFpbENsb3NlZE9uRmluYWxpemVUaW1lb3V0KFxuICAgICAgaWMsXG4gICAgICBpdGVyRGF0YSxcbiAgICAgIGxvb3BTdGF0ZSxcbiAgICAgIFwicHJlXCIsXG4gICAgICBwcmVVbml0U25hcHNob3Q/LnN0YXJ0ZWRBdCA/PyBEYXRlLm5vdygpLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBwcmVSZXN1bHQgPSBwcmVSZXN1bHRHdWFyZC52YWx1ZTtcbiAgaWYgKHByZVJlc3VsdCA9PT0gXCJkaXNwYXRjaGVkXCIpIHtcbiAgICBjb25zdCBkaXNwYXRjaGVkUmVhc29uID0gcy5sYXN0R2l0QWN0aW9uRmFpbHVyZVxuICAgICAgPyBcImdpdC1jbG9zZW91dC1mYWlsdXJlXCJcbiAgICAgIDogXCJwcmUtdmVyaWZpY2F0aW9uLWRpc3BhdGNoZWRcIjtcbiAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICAgIHBoYXNlOiBcImV4aXRcIixcbiAgICAgIHJlYXNvbjogZGlzcGF0Y2hlZFJlYXNvbixcbiAgICAgIGdpdEVycm9yOiBzLmxhc3RHaXRBY3Rpb25GYWlsdXJlID8/IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBkaXNwYXRjaGVkUmVhc29uIH07XG4gIH1cbiAgaWYgKHByZVJlc3VsdCA9PT0gXCJyZXRyeVwiKSB7XG4gICAgaWYgKHNpZGVjYXJJdGVtKSB7XG4gICAgICAvLyBTaWRlY2FyIGFydGlmYWN0IHJldHJpZXMgYXJlIHNraXBwZWQgXHUyMDE0IGp1c3QgY29udGludWVcbiAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJzaWRlY2FyLWFydGlmYWN0LXJldHJ5LXNraXBwZWRcIiwgaXRlcmF0aW9uOiBpYy5pdGVyYXRpb24gfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5IHdhcyBzZXQgYnkgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24uXG4gICAgICAvLyBFbWl0IGEgZGVkaWNhdGVkIGpvdXJuYWwgZXZlbnQgc28gZm9yZW5zaWNzIGNhbiBkaXN0aW5ndWlzaCBib3VuZGVkXG4gICAgICAvLyB2ZXJpZmljYXRpb24gcmV0cmllcyBmcm9tIGdlbnVpbmUgc3R1Y2stbG9vcCBkaXNwYXRjaCByZXBldGl0aW9ucyAoIzQ1NDApLlxuICAgICAgY29uc3QgcmV0cnlJbmZvID0gcy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnk7XG4gICAgICBkZXBzLmVtaXRKb3VybmFsRXZlbnQoe1xuICAgICAgICB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICBmbG93SWQ6IGljLmZsb3dJZCxcbiAgICAgICAgc2VxOiBpYy5uZXh0U2VxKCksXG4gICAgICAgIGV2ZW50VHlwZTogXCJhcnRpZmFjdC12ZXJpZmljYXRpb24tcmV0cnlcIixcbiAgICAgICAgZGF0YToge1xuICAgICAgICAgIHVuaXRUeXBlOiBwcmVVbml0U25hcHNob3Q/LnR5cGUsXG4gICAgICAgICAgdW5pdElkOiByZXRyeUluZm8/LnVuaXRJZCxcbiAgICAgICAgICBhdHRlbXB0OiByZXRyeUluZm8/LmF0dGVtcHQsXG4gICAgICAgIH0sXG4gICAgICB9KTtcbiAgICAgIGNvbnN0IHJldHJ5UG9saWN5UmVzdWx0ID0gYXdhaXQgYXBwbHlWZXJpZmljYXRpb25SZXRyeVBvbGljeShcbiAgICAgICAgaWMsXG4gICAgICAgIHByZVVuaXRTbmFwc2hvdD8udHlwZSxcbiAgICAgICAgXCJhcnRpZmFjdC12ZXJpZmljYXRpb24tcmV0cnlcIixcbiAgICAgICk7XG4gICAgICBpZiAocmV0cnlQb2xpY3lSZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJldHJ5UG9saWN5UmVzdWx0O1xuICAgICAgfVxuICAgICAgLy8gQ29udGludWUgdGhlIGxvb3AgXHUyMDE0IG5leHQgaXRlcmF0aW9uIHdpbGwgaW5qZWN0IHRoZSByZXRyeSBjb250ZXh0IGludG8gdGhlIHByb21wdC5cbiAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJhcnRpZmFjdC12ZXJpZmljYXRpb24tcmV0cnlcIiwgaXRlcmF0aW9uOiBpYy5pdGVyYXRpb24gfSk7XG4gICAgICByZXR1cm4geyBhY3Rpb246IFwiY29udGludWVcIiB9O1xuICAgIH1cbiAgfVxuXG4gIGlmIChwYXVzZUFmdGVyVWF0RGlzcGF0Y2gpIHtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgXCJVQVQgcmVxdWlyZXMgaHVtYW4gZXhlY3V0aW9uLiBBdXRvLW1vZGUgd2lsbCBwYXVzZSBhZnRlciB0aGlzIHVuaXQgd3JpdGVzIHRoZSByZXN1bHQgZmlsZS5cIixcbiAgICAgIFwiaW5mb1wiLFxuICAgICk7XG4gICAgYXdhaXQgZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImV4aXRcIiwgcmVhc29uOiBcInVhdC1wYXVzZVwiIH0pO1xuICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwidWF0LXBhdXNlXCIgfTtcbiAgfVxuXG4gIC8vIFZlcmlmaWNhdGlvbiBnYXRlXG4gIC8vIEhvb2sgc2lkZWNhciBpdGVtcyBza2lwIHZlcmlmaWNhdGlvbiBlbnRpcmVseS5cbiAgLy8gTm9uLWhvb2sgc2lkZWNhciBpdGVtcyBydW4gdmVyaWZpY2F0aW9uIGJ1dCBza2lwIHJldHJpZXMgKGp1c3QgY29udGludWUpLlxuICBjb25zdCBza2lwVmVyaWZpY2F0aW9uID0gc2lkZWNhckl0ZW0/LmtpbmQgPT09IFwiaG9va1wiO1xuICBpZiAoIXNraXBWZXJpZmljYXRpb24pIHtcbiAgICBjb25zdCB2ZXJpZmljYXRpb25SZXN1bHQgPSBhd2FpdCBkZXBzLnJ1blBvc3RVbml0VmVyaWZpY2F0aW9uKFxuICAgICAgeyBzLCBjdHgsIHBpIH0sXG4gICAgICBkZXBzLnBhdXNlQXV0byxcbiAgICApO1xuXG4gICAgaWYgKHZlcmlmaWNhdGlvblJlc3VsdCA9PT0gXCJwYXVzZVwiKSB7XG4gICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwiZXhpdFwiLCByZWFzb246IFwidmVyaWZpY2F0aW9uLXBhdXNlXCIgfSk7XG4gICAgICByZXR1cm4geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBcInZlcmlmaWNhdGlvbi1wYXVzZVwiIH07XG4gICAgfVxuXG4gICAgaWYgKHZlcmlmaWNhdGlvblJlc3VsdCA9PT0gXCJyZXRyeVwiKSB7XG4gICAgICBpZiAoc2lkZWNhckl0ZW0pIHtcbiAgICAgICAgLy8gU2lkZWNhciB2ZXJpZmljYXRpb24gcmV0cmllcyBhcmUgc2tpcHBlZCBcdTIwMTQganVzdCBjb250aW51ZVxuICAgICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwic2lkZWNhci12ZXJpZmljYXRpb24tcmV0cnktc2tpcHBlZFwiLCBpdGVyYXRpb246IGljLml0ZXJhdGlvbiB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5IHdhcyBzZXQgYnkgcnVuUG9zdFVuaXRWZXJpZmljYXRpb24uXG4gICAgICAgIGNvbnN0IHJldHJ5UG9saWN5UmVzdWx0ID0gYXdhaXQgYXBwbHlWZXJpZmljYXRpb25SZXRyeVBvbGljeShcbiAgICAgICAgICBpYyxcbiAgICAgICAgICBpdGVyRGF0YS51bml0VHlwZSxcbiAgICAgICAgICBcInZlcmlmaWNhdGlvbi1yZXRyeVwiLFxuICAgICAgICApO1xuICAgICAgICBpZiAocmV0cnlQb2xpY3lSZXN1bHQpIHtcbiAgICAgICAgICByZXR1cm4gcmV0cnlQb2xpY3lSZXN1bHQ7XG4gICAgICAgIH1cbiAgICAgICAgLy8gQ29udGludWUgdGhlIGxvb3AgXHUyMDE0IG5leHQgaXRlcmF0aW9uIHdpbGwgaW5qZWN0IHRoZSByZXRyeSBjb250ZXh0IGludG8gdGhlIHByb21wdC5cbiAgICAgICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcInZlcmlmaWNhdGlvbi1yZXRyeVwiLCBpdGVyYXRpb246IGljLml0ZXJhdGlvbiB9KTtcbiAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImNvbnRpbnVlXCIgfTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBQb3N0LXZlcmlmaWNhdGlvbiBwcm9jZXNzaW5nIChEQiBkdWFsLXdyaXRlLCBob29rcywgdHJpYWdlLCBxdWljay10YXNrcylcbiAgLy8gVGltZW91dCBndWFyZDogaWYgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uIGhhbmdzIChlLmcuLCBtb2R1bGUgaW1wb3J0XG4gIC8vIGRlYWRsb2NrLCBTUUxpdGUgdHJhbnNhY3Rpb24gaGFuZyksIGZvcmNlLWNvbnRpbnVlIGFmdGVyIHRpbWVvdXQgc28gdGhlXG4gIC8vIGF1dG8tbG9vcCBpcyBub3QgcGVybWFuZW50bHkgZnJvemVuICgjMjM0NCkuXG4gIGNvbnN0IHBvc3RSZXN1bHRHdWFyZCA9IGF3YWl0IHdpdGhUaW1lb3V0KFxuICAgIGRlcHMucG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uKHBvc3RVbml0Q3R4KSxcbiAgICBGSU5BTElaRV9QT1NUX1RJTUVPVVRfTVMsXG4gICAgXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb25cIixcbiAgKTtcblxuICBpZiAocG9zdFJlc3VsdEd1YXJkLnRpbWVkT3V0KSB7XG4gICAgcmV0dXJuIGZhaWxDbG9zZWRPbkZpbmFsaXplVGltZW91dChcbiAgICAgIGljLFxuICAgICAgaXRlckRhdGEsXG4gICAgICBsb29wU3RhdGUsXG4gICAgICBcInBvc3RcIixcbiAgICAgIHByZVVuaXRTbmFwc2hvdD8uc3RhcnRlZEF0ID8/IERhdGUubm93KCksXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHBvc3RSZXN1bHQgPSBwb3N0UmVzdWx0R3VhcmQudmFsdWU7XG5cbiAgaWYgKHBvc3RSZXN1bHQgPT09IFwic3RvcHBlZFwiKSB7XG4gICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgICBwaGFzZTogXCJleGl0XCIsXG4gICAgICByZWFzb246IFwicG9zdC12ZXJpZmljYXRpb24tc3RvcHBlZFwiLFxuICAgIH0pO1xuICAgIHJldHVybiB7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwicG9zdC12ZXJpZmljYXRpb24tc3RvcHBlZFwiIH07XG4gIH1cblxuICBpZiAocG9zdFJlc3VsdCA9PT0gXCJzdGVwLXdpemFyZFwiKSB7XG4gICAgLy8gU3RlcCBtb2RlIFx1MjAxNCBleGl0IHRoZSBsb29wIChjYWxsZXIgaGFuZGxlcyB3aXphcmQpXG4gICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImV4aXRcIiwgcmVhc29uOiBcInN0ZXAtd2l6YXJkXCIgfSk7XG4gICAgcmV0dXJuIHsgYWN0aW9uOiBcImJyZWFrXCIsIHJlYXNvbjogXCJzdGVwLXdpemFyZFwiIH07XG4gIH1cblxuICBpZiAocHJlVW5pdFNuYXBzaG90Py50eXBlID09PSBcImNvbXBsZXRlLW1pbGVzdG9uZVwiICYmIHMuY3VycmVudE1pbGVzdG9uZUlkKSB7XG4gICAgY29uc3Qgc3RvcCA9IGF3YWl0IF9ydW5NaWxlc3RvbmVNZXJnZU9uY2VXaXRoU3Rhc2hSZXN0b3JlKGljLCBzLmN1cnJlbnRNaWxlc3RvbmVJZCk7XG4gICAgaWYgKHN0b3ApIHJldHVybiBzdG9wO1xuICB9XG5cbiAgLy8gQm90aCBwcmUgYW5kIHBvc3QgdmVyaWZpY2F0aW9uIGNvbXBsZXRlZCB3aXRob3V0IHRpbWVvdXQgXHUyMDE0IHJlc2V0IGNvdW50ZXJcbiAgbG9vcFN0YXRlLmNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0cyA9IDA7XG4gIGlmIChwcmVVbml0U25hcHNob3QpIHtcbiAgICB3cml0ZVVuaXRSdW50aW1lUmVjb3JkKHMuYmFzZVBhdGgsIHByZVVuaXRTbmFwc2hvdC50eXBlLCBwcmVVbml0U25hcHNob3QuaWQsIHByZVVuaXRTbmFwc2hvdC5zdGFydGVkQXQsIHtcbiAgICAgIHBoYXNlOiBcImZpbmFsaXplZFwiLFxuICAgICAgbGFzdFByb2dyZXNzQXQ6IERhdGUubm93KCksXG4gICAgICBsYXN0UHJvZ3Jlc3NLaW5kOiBcImZpbmFsaXplLXN1Y2Nlc3NcIixcbiAgICB9KTtcbiAgfVxuICBzLmN1cnJlbnRVbml0ID0gbnVsbDtcbiAgY2xlYXJDdXJyZW50UGhhc2UoKTtcblxuICAvLyBTdXJmYWNlIGFjY3VtdWxhdGVkIHdvcmtmbG93LWxvZ2dlciBpc3N1ZXMgZm9yIHRoaXMgdW5pdCB0byB0aGUgdXNlci5cbiAgLy8gV2FybmluZ3MvZXJyb3JzIGxvZ2dlZCBkdXJpbmcgdGhlIHVuaXQgYXJlIGJ1ZmZlcmVkIGluIHRoZSBsb2dnZXIgYW5kXG4gIC8vIGRyYWluZWQgaGVyZSBzbyB0aGUgdXNlciBzZWVzIGEgc2luZ2xlIGNvbnNvbGlkYXRlZCBwb3N0LXVuaXQgYWxlcnQuXG4gIGlmIChoYXNBbnlJc3N1ZXMoKSkge1xuICAgIGNvbnN0IHsgbG9ncyB9ID0gZHJhaW5BbmRTdW1tYXJpemUoKTtcbiAgICBpZiAobG9ncy5sZW5ndGggPiAwKSB7XG4gICAgICBjb25zdCBzZXZlcml0eSA9IGxvZ3Muc29tZSgoZSkgPT4gZS5zZXZlcml0eSA9PT0gXCJlcnJvclwiKSA/IFwiZXJyb3JcIiA6IFwid2FybmluZ1wiO1xuICAgICAgY3R4LnVpLm5vdGlmeShmb3JtYXRGb3JOb3RpZmljYXRpb24obG9ncyksIHNldmVyaXR5KTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBhY3Rpb246IFwibmV4dFwiLCBkYXRhOiB1bmRlZmluZWQgYXMgdm9pZCB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBV0EsU0FBUyw2QkFBdUU7QUFJaEY7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLE9BR0s7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
