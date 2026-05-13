import { randomUUID } from "node:crypto";
import {
  MAX_LOOP_ITERATIONS
} from "./types.js";
import { _clearCurrentResolve } from "./resolve.js";
import {
  runPreDispatch,
  runDispatch,
  runGuards,
  runFinalize
} from "./phases.js";
import { debugLog } from "../debug-logger.js";
import { isInfrastructureError, isTransientCooldownError, getCooldownRetryAfterMs, COOLDOWN_FALLBACK_WAIT_MS, MAX_COOLDOWN_RETRIES } from "./infra-errors.js";
import { ModelPolicyDispatchBlockedError } from "../auto-model-selection.js";
import { resolveEngine } from "../engine-resolver.js";
import { logWarning } from "../workflow-logger.js";
import {
  recordDispatchClaim,
  markRunning as markDispatchRunning,
  markCompleted as markDispatchCompleted,
  markFailed as markDispatchFailed,
  getRecentForUnit as getRecentDispatchesForUnit,
  getRecentUnitKeysForProjectRoot
} from "../db/unit-dispatches.js";
import { claimMilestoneLease, refreshMilestoneLease } from "../db/milestone-leases.js";
import { heartbeatAutoWorker } from "../db/auto-workers.js";
import { getRuntimeKv, setRuntimeKv } from "../db/runtime-kv.js";
import { resolveUokFlags } from "../uok/flags.js";
import { scheduleSidecarQueue } from "../uok/execution-graph.js";
import { normalizeRealPath } from "../paths.js";
import {
  decideCooldownRecovery,
  decideDispatchClaim,
  decideEngineDispatch,
  decideFinalizeResult,
  decideInfrastructureError,
  decideIterationErrorRecovery,
  decideMemoryPressure,
  decideModelPolicyBlocked,
  decideMinRequestInterval,
  decideWorkflowLoop,
  formatDispatchExceptionSummary,
  formatUnhandledDispatchErrorSummary,
  resolveUnitRequestTimestamp,
  shouldUseCustomEnginePath
} from "./workflow-kernel.js";
import {
  hydrateCustomVerifyRetryCounts,
  saveCustomVerifyRetryCounts
} from "./custom-verify-retry-store.js";
import {
  settleDispatchCompleted,
  settleDispatchFailed
} from "./workflow-dispatch-ledger.js";
import { emitOpenUnitEndForUnit } from "../crash-recovery.js";
import { writeUnitRuntimeRecord } from "../unit-runtime.js";
import { ensureDispatchLease, openDispatchClaim } from "./workflow-dispatch-claim.js";
import { completeWorkflowIteration } from "./workflow-iteration-completion.js";
import { createWorkflowJournalReporter } from "./workflow-journal-reporter.js";
import { createWorkflowPhaseReporter } from "./workflow-phase-reporter.js";
import { createWorkflowTurnReporter } from "./workflow-turn-reporter.js";
import { validateWorkflowSessionLock } from "./workflow-session-lock.js";
import { dequeueSidecarItem } from "./workflow-sidecar-queue.js";
import { maintainWorkerHeartbeat } from "./workflow-worker-heartbeat.js";
import {
  measureMemoryPressure,
  shouldCheckMemoryPressure
} from "./workflow-memory-pressure.js";
import { buildSidecarIterationData } from "./workflow-sidecar-iteration.js";
import {
  createExecutionGraphUnitDispatchDeps,
  runUnitPhaseViaContract
} from "./workflow-unit-dispatch.js";
import { handleCustomEngineDispatchOutcome } from "./workflow-custom-engine-dispatch-outcome.js";
import { buildCustomEngineIterationData } from "./workflow-custom-engine-iteration.js";
import { handleCustomEngineVerifyRetry } from "./workflow-custom-engine-retry.js";
import {
  handleCustomEngineVerifyPause,
  handleCustomEngineVerifyRetryOutcome
} from "./workflow-custom-engine-verify-outcome.js";
import { handleCustomEngineReconcile } from "./workflow-custom-engine-reconcile.js";
import { handleCustomEngineReconcileOutcome } from "./workflow-custom-engine-reconcile-outcome.js";
const STUCK_RECOVERY_ATTEMPTS_KEY = "stuck_recovery_attempts";
const RECENT_UNIT_KEYS_LIMIT = 20;
function stableStuckStateScopeId(s) {
  return normalizeRealPath(s.scope?.workspace.projectRoot ?? (s.originalBasePath || s.basePath));
}
function loadStuckState(s) {
  const scopeId = stableStuckStateScopeId(s);
  if (!scopeId) return { recentUnits: [], stuckRecoveryAttempts: 0 };
  try {
    const recentUnits = getRecentUnitKeysForProjectRoot(scopeId, RECENT_UNIT_KEYS_LIMIT);
    const stuckRecoveryAttempts = getRuntimeKv("global", scopeId, STUCK_RECOVERY_ATTEMPTS_KEY) ?? 0;
    return { recentUnits, stuckRecoveryAttempts };
  } catch (err) {
    debugLog("autoLoop", { phase: "load-stuck-state-failed", error: err instanceof Error ? err.message : String(err) });
    return { recentUnits: [], stuckRecoveryAttempts: 0 };
  }
}
function saveStuckState(s, state) {
  const scopeId = stableStuckStateScopeId(s);
  if (!scopeId) return;
  try {
    setRuntimeKv("global", scopeId, STUCK_RECOVERY_ATTEMPTS_KEY, state.stuckRecoveryAttempts);
  } catch (err) {
    debugLog("autoLoop", { phase: "save-stuck-state-failed", error: err instanceof Error ? err.message : String(err) });
  }
}
function logDispatchLedgerWriteFailure(err) {
  debugLog("autoLoop", {
    phase: "dispatch-ledger-write-failed",
    error: err instanceof Error ? err.message : String(err)
  });
}
function logDispatchClaimRejected(details) {
  debugLog("autoLoop", {
    phase: "dispatch-claim-rejected",
    ...details
  });
}
function logDispatchClaimFailed(err) {
  debugLog("autoLoop", {
    phase: "dispatch-claim-failed",
    error: err instanceof Error ? err.message : String(err)
  });
}
function logDispatchLeaseRecovered(details) {
  debugLog("autoLoop", {
    phase: details.recovered ? "dispatch-lease-recovered" : "dispatch-lease-acquired",
    ...details
  });
}
function logDispatchLeaseRecoveryFailed(details) {
  debugLog("autoLoop", {
    phase: "dispatch-lease-recovery-failed",
    ...details
  });
}
function logCustomVerifyRetryLoadFailure(err) {
  debugLog("autoLoop", {
    phase: "load-custom-verify-retries-failed",
    error: err instanceof Error ? err.message : String(err)
  });
}
function logCustomVerifyRetrySaveFailure(err) {
  debugLog("autoLoop", {
    phase: "save-custom-verify-retries-failed",
    error: err instanceof Error ? err.message : String(err)
  });
}
const MEMORY_CHECK_INTERVAL = 5;
const MAX_CUSTOM_ENGINE_VERIFY_RETRIES = 3;
async function enforceMinRequestInterval(s, prefs) {
  const minInterval = prefs?.min_request_interval_ms ?? 0;
  const decision = decideMinRequestInterval({
    minIntervalMs: minInterval,
    lastRequestTimestamp: s.lastRequestTimestamp,
    nowMs: Date.now()
  });
  if (decision.action === "wait") {
    debugLog("autoLoop", { phase: "rate-limit-wait", waitMs: decision.waitMs });
    await new Promise((r) => setTimeout(r, decision.waitMs));
  }
}
function closeOutCrashedUnit(s, iterData, err) {
  const summary = formatDispatchExceptionSummary({ error: err });
  try {
    emitOpenUnitEndForUnit(
      s.basePath,
      iterData.unitType,
      iterData.unitId,
      "cancelled",
      {
        message: summary,
        category: "unit-exception",
        isTransient: false
      }
    );
    writeUnitRuntimeRecord(
      s.basePath,
      iterData.unitType,
      iterData.unitId,
      s.currentUnit?.startedAt ?? Date.now(),
      {
        phase: "crashed",
        lastProgressAt: Date.now(),
        lastProgressKind: "unit-exception"
      }
    );
  } catch (closeoutErr) {
    logWarning("dispatch", `unit crash closeout failed: ${closeoutErr instanceof Error ? closeoutErr.message : String(closeoutErr)}`);
  }
}
async function autoLoop(ctx, pi, s, deps, options) {
  debugLog("autoLoop", { phase: "enter" });
  let iteration = 0;
  const dispatchContract = options?.dispatchContract ?? "legacy-direct";
  const unitDispatchDeps = createExecutionGraphUnitDispatchDeps();
  const persisted = loadStuckState(s);
  const loopState = {
    recentUnits: persisted.recentUnits,
    stuckRecoveryAttempts: persisted.stuckRecoveryAttempts,
    consecutiveFinalizeTimeouts: 0
  };
  let consecutiveErrors = 0;
  let consecutiveCooldowns = 0;
  const recentErrorMessages = [];
  while (s.active) {
    iteration++;
    debugLog("autoLoop", { phase: "loop-top", iteration });
    maintainWorkerHeartbeat(s, {
      heartbeatAutoWorker,
      refreshMilestoneLease,
      logHeartbeatFailure: (err) => debugLog("autoLoop", {
        phase: "heartbeat-failed",
        error: err instanceof Error ? err.message : String(err)
      }),
      logLeaseRefreshMiss: (details) => debugLog("autoLoop", {
        phase: "lease-refresh-missed",
        ...details
      })
    });
    const flowId = randomUUID();
    let seqCounter = 0;
    const nextSeq = () => ++seqCounter;
    const journalReporter = createWorkflowJournalReporter({
      emitJournalEvent: deps.emitJournalEvent,
      flowId,
      nextSeq
    });
    const turnId = randomUUID();
    s.currentTraceId = flowId;
    s.currentTurnId = turnId;
    const turnStartedAt = (/* @__PURE__ */ new Date()).toISOString();
    let observedUnitType;
    let observedUnitId;
    const phaseReporter = createWorkflowPhaseReporter({
      observer: deps.uokObserver
    });
    const turnReporter = createWorkflowTurnReporter({
      observer: deps.uokObserver,
      traceId: flowId,
      turnId,
      iteration,
      basePath: s.basePath,
      startedAt: turnStartedAt,
      clearCurrentTurn: () => {
        s.currentTraceId = null;
        s.currentTurnId = null;
      }
    });
    const finishTurn = (status, failureClass = "none", error) => {
      turnReporter.finish({
        unitType: observedUnitType,
        unitId: observedUnitId,
        status,
        failureClass,
        error
      });
    };
    turnReporter.start();
    const iterationDecision = decideWorkflowLoop({
      active: s.active,
      iteration,
      maxIterations: MAX_LOOP_ITERATIONS,
      hasCommandContext: true,
      sessionLockValid: true
    });
    if (iterationDecision.action === "stop" && iterationDecision.reason === "max-iterations") {
      debugLog("autoLoop", {
        phase: "exit",
        reason: iterationDecision.reason,
        iteration
      });
      await deps.stopAuto(
        ctx,
        pi,
        `Safety: loop exceeded ${MAX_LOOP_ITERATIONS} iterations \u2014 possible runaway`
      );
      finishTurn("stopped", "manual-attention", "max-iterations");
      break;
    }
    if (shouldCheckMemoryPressure(iteration, MEMORY_CHECK_INTERVAL)) {
      const mem = measureMemoryPressure();
      debugLog("autoLoop", { phase: "memory-check", ...mem });
      const memoryDecision = decideMemoryPressure({ ...mem, iteration });
      if (memoryDecision.action === "stop") {
        logWarning("dispatch", memoryDecision.warningMessage);
        await deps.stopAuto(ctx, pi, memoryDecision.stopMessage);
        finishTurn("stopped", "timeout", memoryDecision.turnError);
        break;
      }
    }
    const commandContextDecision = decideWorkflowLoop({
      active: s.active,
      iteration,
      maxIterations: MAX_LOOP_ITERATIONS,
      hasCommandContext: Boolean(s.cmdCtx),
      sessionLockValid: true
    });
    if (commandContextDecision.action === "stop" && commandContextDecision.reason === "missing-command-context") {
      debugLog("autoLoop", { phase: "exit", reason: "no-cmdCtx" });
      finishTurn("stopped", "manual-attention", commandContextDecision.reason);
      break;
    }
    let dispatchId = null;
    let dispatchSettled = false;
    let iterationEndEmitted = false;
    const emitIterationEnd = (details = {}) => {
      if (iterationEndEmitted) return;
      iterationEndEmitted = true;
      journalReporter.emit("iteration-end", { iteration, ...details });
    };
    const completeIteration = () => {
      completeWorkflowIteration({
        get consecutiveErrors() {
          return consecutiveErrors;
        },
        set consecutiveErrors(value) {
          consecutiveErrors = value;
        },
        get consecutiveCooldowns() {
          return consecutiveCooldowns;
        },
        set consecutiveCooldowns(value) {
          consecutiveCooldowns = value;
        },
        recentErrorMessages
      }, {
        emitIterationEnd: () => emitIterationEnd(),
        saveStuckState: () => saveStuckState(s, loopState),
        logIterationComplete: () => debugLog("autoLoop", { phase: "iteration-complete", iteration })
      });
    };
    const finishIncompleteIteration = (details) => {
      emitIterationEnd(details);
      saveStuckState(s, loopState);
    };
    try {
      const prefs = deps.loadEffectiveGSDPreferences()?.preferences;
      const uokFlags = resolveUokFlags(prefs);
      const sidecarItem = await dequeueSidecarItem({
        queue: s.sidecarQueue,
        executionGraphEnabled: uokFlags.executionGraph,
        scheduleQueue: scheduleSidecarQueue,
        warnSchedulingFailure: (message) => logWarning("dispatch", `sidecar queue scheduling failed: ${message}`),
        logDequeue: (payload) => debugLog("autoLoop", { phase: "sidecar-dequeue", ...payload }),
        emitDequeue: (payload) => journalReporter.emit("sidecar-dequeue", payload)
      });
      const sessionLockOutcome = validateWorkflowSessionLock({
        active: s.active,
        iteration,
        maxIterations: MAX_LOOP_ITERATIONS,
        deps: {
          lockBase: deps.lockBase,
          validateSessionLock: deps.validateSessionLock,
          handleLostSessionLock: (lockStatus) => deps.handleLostSessionLock(ctx, lockStatus),
          logInvalidSessionLock: (details) => debugLog("autoLoop", {
            phase: "session-lock-invalid",
            ...details
          }),
          logSessionLockExit: (details) => debugLog("autoLoop", {
            phase: "exit",
            ...details
          })
        }
      });
      if (sessionLockOutcome.action === "stop" && sessionLockOutcome.reason === "session-lock-lost") {
        finishTurn("stopped", "manual-attention", sessionLockOutcome.reason);
        break;
      }
      const ic = { ctx, pi, s, deps, prefs, iteration, flowId, nextSeq };
      journalReporter.emit("iteration-start", { iteration });
      let iterData;
      if (shouldUseCustomEnginePath({
        activeEngineId: s.activeEngineId,
        hasSidecarItem: Boolean(sidecarItem),
        engineBypass: process.env.GSD_ENGINE_BYPASS === "1"
      })) {
        debugLog("autoLoop", { phase: "custom-engine-derive", iteration, engineId: s.activeEngineId });
        const { engine, policy } = resolveEngine({
          activeEngineId: s.activeEngineId,
          activeRunDir: s.activeRunDir
        });
        const engineState = await engine.deriveState(s.canonicalProjectRoot);
        debugLog("autoLoop", {
          phase: "post-derive",
          site: "custom-engine-derive",
          basePath: s.basePath,
          originalBasePath: s.originalBasePath,
          scopeProjectRoot: s.scope?.workspace.projectRoot,
          canonicalProjectRoot: s.canonicalProjectRoot,
          derivedPhase: engineState.phase,
          isComplete: engineState.isComplete
        });
        if (engineState.isComplete) {
          finishTurn("completed");
          emitIterationEnd({ status: "completed", reason: "custom-engine-complete" });
          await deps.stopAuto(ctx, pi, "Workflow complete");
          break;
        }
        debugLog("autoLoop", { phase: "custom-engine-dispatch", iteration });
        const dispatch = await engine.resolveDispatch(engineState, { basePath: s.basePath });
        const engineDispatchDecision = decideEngineDispatch(dispatch.action === "stop" ? { action: "stop", reason: dispatch.reason } : { action: dispatch.action });
        const dispatchFlow = await handleCustomEngineDispatchOutcome({
          decision: engineDispatchDecision,
          deps: {
            stopAuto: (reason) => deps.stopAuto(ctx, pi, reason)
          }
        });
        if (dispatchFlow.action === "break") {
          finishTurn("stopped", "manual-attention", "custom-engine-dispatch-stop");
          finishIncompleteIteration({
            status: "stopped",
            reason: "custom-engine-dispatch-stop",
            failureClass: "manual-attention"
          });
          break;
        }
        if (dispatchFlow.action === "continue") {
          finishTurn("skipped");
          emitIterationEnd({ status: "skipped", reason: "custom-engine-dispatch-skip" });
          continue;
        }
        if (dispatch.action !== "dispatch") {
          finishTurn("skipped");
          emitIterationEnd({ status: "skipped", reason: "custom-engine-dispatch-mismatch" });
          continue;
        }
        const step = dispatch.step;
        iterData = await buildCustomEngineIterationData({
          step,
          basePath: s.basePath,
          canonicalProjectRoot: s.canonicalProjectRoot,
          currentMilestoneId: s.currentMilestoneId,
          deriveState: deps.deriveState,
          logPostDerive: (details) => debugLog("autoLoop", {
            phase: "post-derive",
            ...details
          })
        });
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;
        deps.updateProgressWidget(ctx, iterData.unitType, iterData.unitId, iterData.state);
        const guardsResult = await runGuards(ic, s.currentMilestoneId ?? "workflow");
        phaseReporter.report("guard", guardsResult.action, {
          unitType: iterData.unitType,
          unitId: iterData.unitId
        });
        if (guardsResult.action === "break") {
          finishTurn("stopped", "manual-attention", "guard-break");
          finishIncompleteIteration({
            status: "stopped",
            reason: "guard-break",
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            failureClass: "manual-attention"
          });
          break;
        }
        await enforceMinRequestInterval(s, prefs);
        let unitPhaseResult2;
        try {
          unitPhaseResult2 = await runUnitPhaseViaContract(
            dispatchContract,
            ic,
            iterData,
            loopState,
            void 0,
            unitDispatchDeps
          );
        } catch (err) {
          if (err instanceof ModelPolicyDispatchBlockedError) {
            throw err;
          }
          closeOutCrashedUnit(s, iterData, err);
          throw err;
        }
        if (unitPhaseResult2.action === "next") {
          const requestTimestamp = resolveUnitRequestTimestamp(unitPhaseResult2.data);
          if (requestTimestamp !== void 0) s.lastRequestTimestamp = requestTimestamp;
        }
        phaseReporter.report("unit", unitPhaseResult2.action, {
          unitType: iterData.unitType,
          unitId: iterData.unitId
        });
        if (unitPhaseResult2.action === "break") {
          finishIncompleteIteration({
            status: "stopped",
            reason: unitPhaseResult2.reason ?? "unit-break",
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            failureClass: "execution"
          });
          finishTurn("stopped", "execution", "unit-break");
          break;
        }
        debugLog("autoLoop", { phase: "custom-engine-verify", iteration, unitId: iterData.unitId });
        const verifyResult = await policy.verify(iterData.unitType, iterData.unitId, { basePath: s.basePath });
        if (verifyResult === "pause") {
          const verifyFlow = await handleCustomEngineVerifyPause({
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            deps: {
              pauseAuto: () => deps.pauseAuto(ctx, pi),
              stopAuto: (reason) => deps.stopAuto(ctx, pi, reason),
              reportPause: (details) => phaseReporter.report("custom-engine", "pause", details),
              finishTurn
            }
          });
          if (verifyFlow.action === "break") {
            finishIncompleteIteration({
              status: "paused",
              reason: "custom-engine-verify-pause",
              unitType: iterData.unitType,
              unitId: iterData.unitId,
              failureClass: "manual-attention"
            });
            break;
          }
        }
        if (verifyResult === "retry") {
          const retryOutcome = await handleCustomEngineVerifyRetry({
            session: s,
            unitType: iterData.unitType,
            unitId: iterData.unitId,
            basePath: s.basePath,
            iteration,
            maxRetries: MAX_CUSTOM_ENGINE_VERIFY_RETRIES,
            deps: {
              hydrateRetryCounts: () => hydrateCustomVerifyRetryCounts(s, {
                logFailure: logCustomVerifyRetryLoadFailure
              }),
              saveRetryCounts: () => saveCustomVerifyRetryCounts(s, {
                logFailure: logCustomVerifyRetrySaveFailure
              }),
              recover: (unitType, unitId, options2) => policy.recover(unitType, unitId, options2),
              logRetry: (details) => debugLog("autoLoop", {
                phase: "custom-engine-verify-retry",
                ...details
              }),
              reportRetry: (details) => phaseReporter.report("custom-engine", "retry", details)
            }
          });
          const retryFlow = await handleCustomEngineVerifyRetryOutcome({
            outcome: retryOutcome,
            deps: {
              pauseAuto: () => deps.pauseAuto(ctx, pi),
              stopAuto: (reason) => deps.stopAuto(ctx, pi, reason),
              reportPause: (details) => phaseReporter.report("custom-engine", "pause", details),
              finishTurn
            }
          });
          if (retryFlow.action === "break") {
            finishIncompleteIteration({
              status: retryOutcome.action === "stop" ? "stopped" : "paused",
              reason: retryOutcome.action === "retry" ? "custom-engine-verify-retry" : retryOutcome.turnError,
              unitType: iterData.unitType,
              unitId: iterData.unitId,
              failureClass: "manual-attention"
            });
            break;
          }
          finishIncompleteIteration({
            status: "retry",
            reason: "custom-engine-verify-retry",
            unitType: iterData.unitType,
            unitId: iterData.unitId
          });
          continue;
        }
        const reconcileOutcome = await handleCustomEngineReconcile({
          session: s,
          engineState,
          iterData,
          iteration,
          deps: {
            saveRetryCounts: () => saveCustomVerifyRetryCounts(s, {
              logFailure: logCustomVerifyRetrySaveFailure
            }),
            logReconcile: (details) => debugLog("autoLoop", {
              phase: "custom-engine-reconcile",
              ...details
            }),
            reconcile: (state, completedStep) => engine.reconcile(state, completedStep),
            now: () => Date.now(),
            clearUnitTimeout: deps.clearUnitTimeout,
            completeIteration
          }
        });
        const reconcileFlow = await handleCustomEngineReconcileOutcome({
          outcome: reconcileOutcome,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          deps: {
            stopAuto: (reason) => deps.stopAuto(ctx, pi, reason),
            pauseAuto: () => deps.pauseAuto(ctx, pi),
            report: (action, details) => phaseReporter.report("custom-engine", action, details),
            finishTurn
          }
        });
        if (reconcileFlow.action === "break") break;
        continue;
      }
      if (!sidecarItem) {
        const preDispatchResult = await runPreDispatch(ic, loopState);
        phaseReporter.report("pre-dispatch", preDispatchResult.action);
        if (preDispatchResult.action === "break") {
          finishTurn("stopped", "manual-attention", "pre-dispatch-break");
          break;
        }
        if (preDispatchResult.action === "continue") {
          finishTurn("skipped");
          continue;
        }
        const preData = preDispatchResult.data;
        const guardsResult = await runGuards(ic, preData.mid);
        phaseReporter.report("guard", guardsResult.action);
        if (guardsResult.action === "break") {
          finishTurn("stopped", "manual-attention", "guard-break");
          break;
        }
        const dispatchResult = await runDispatch(ic, preData, loopState);
        phaseReporter.report("dispatch", dispatchResult.action);
        if (dispatchResult.action === "break") {
          finishTurn("stopped", "manual-attention", "dispatch-break");
          break;
        }
        if (dispatchResult.action === "continue") {
          finishTurn("skipped");
          continue;
        }
        iterData = dispatchResult.data;
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;
      } else {
        iterData = await buildSidecarIterationData({
          sidecarItem,
          basePath: s.basePath,
          canonicalProjectRoot: s.canonicalProjectRoot,
          deriveState: deps.deriveState,
          logPostDerive: (details) => debugLog("autoLoop", {
            phase: "post-derive",
            ...details
          })
        });
        observedUnitType = iterData.unitType;
        observedUnitId = iterData.unitId;
        phaseReporter.report("dispatch", "sidecar", {
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          sidecarKind: sidecarItem.kind
        });
      }
      await enforceMinRequestInterval(s, prefs);
      const leaseBeforeClaim = ensureDispatchLease(s, iterData.mid, {
        claimMilestoneLease,
        logLeaseRecovered: logDispatchLeaseRecovered,
        logLeaseRecoveryFailed: logDispatchLeaseRecoveryFailed
      });
      if (leaseBeforeClaim.kind === "blocked" || leaseBeforeClaim.kind === "failed") {
        const msg = `Lost milestone lease for ${iterData.mid ?? "unknown"} before dispatching ${iterData.unitType} ${iterData.unitId}: ${leaseBeforeClaim.reason}`;
        ctx.ui.notify(msg, "error");
        finishTurn("stopped", "execution", msg);
        await deps.stopAuto(ctx, pi, msg);
        break;
      }
      let dispatchClaim = openDispatchClaim(s, flowId, turnId, iterData, {
        getRecentDispatchesForUnit,
        recordDispatchClaim,
        markDispatchRunning,
        logClaimRejected: logDispatchClaimRejected,
        logClaimFailed: logDispatchClaimFailed
      });
      let dispatchDecision = decideDispatchClaim(
        dispatchClaim.kind === "opened" ? { kind: "opened", dispatchId: dispatchClaim.dispatchId } : dispatchClaim.kind === "skip" ? { kind: "skip", reason: dispatchClaim.reason } : { kind: "degraded" }
      );
      if (dispatchDecision.action === "skip" && dispatchDecision.reason === "stale-lease") {
        const leaseRecovery = ensureDispatchLease(s, iterData.mid, {
          claimMilestoneLease,
          logLeaseRecovered: logDispatchLeaseRecovered,
          logLeaseRecoveryFailed: logDispatchLeaseRecoveryFailed
        }, { forceReclaim: true });
        if (leaseRecovery.kind === "ready") {
          dispatchClaim = openDispatchClaim(s, flowId, turnId, iterData, {
            getRecentDispatchesForUnit,
            recordDispatchClaim,
            markDispatchRunning,
            logClaimRejected: logDispatchClaimRejected,
            logClaimFailed: logDispatchClaimFailed
          });
          dispatchDecision = decideDispatchClaim(
            dispatchClaim.kind === "opened" ? { kind: "opened", dispatchId: dispatchClaim.dispatchId } : dispatchClaim.kind === "skip" ? { kind: "skip", reason: dispatchClaim.reason } : { kind: "degraded" }
          );
        } else {
          const msg = `Lost milestone lease for ${iterData.mid ?? "unknown"} while claiming ${iterData.unitType} ${iterData.unitId}: ${leaseRecovery.reason}`;
          ctx.ui.notify(msg, "error");
          finishTurn("stopped", "execution", msg);
          await deps.stopAuto(ctx, pi, msg);
          break;
        }
      }
      if (dispatchDecision.action === "skip") {
        if (dispatchDecision.reason === "stale-lease") {
          const msg = `Lost milestone lease for ${iterData.mid ?? "unknown"} while claiming ${iterData.unitType} ${iterData.unitId}; dispatch claim still failed after recovery.`;
          ctx.ui.notify(msg, "error");
          finishTurn("stopped", "execution", msg);
          await deps.stopAuto(ctx, pi, msg);
          break;
        }
        finishTurn("skipped", "execution", dispatchDecision.reason);
        continue;
      }
      dispatchId = dispatchDecision.dispatchId;
      let unitPhaseResult;
      try {
        unitPhaseResult = await runUnitPhaseViaContract(
          dispatchContract,
          ic,
          iterData,
          loopState,
          sidecarItem,
          unitDispatchDeps
        );
      } catch (err) {
        if (err instanceof ModelPolicyDispatchBlockedError) {
          throw err;
        }
        closeOutCrashedUnit(s, iterData, err);
        dispatchSettled = settleDispatchFailed(
          dispatchId,
          formatDispatchExceptionSummary({ error: err }),
          {
            markFailed: markDispatchFailed,
            logWriteFailure: logDispatchLedgerWriteFailure
          }
        ) || dispatchSettled;
        throw err;
      }
      if (unitPhaseResult.action === "next") {
        const requestTimestamp = resolveUnitRequestTimestamp(unitPhaseResult.data);
        if (requestTimestamp !== void 0) s.lastRequestTimestamp = requestTimestamp;
      }
      phaseReporter.report("unit", unitPhaseResult.action, {
        unitType: iterData.unitType,
        unitId: iterData.unitId
      });
      if (unitPhaseResult.action === "break") {
        dispatchSettled = settleDispatchFailed(dispatchId, "unit-break", {
          markFailed: markDispatchFailed,
          logWriteFailure: logDispatchLedgerWriteFailure
        }) || dispatchSettled;
        finishIncompleteIteration({
          status: "stopped",
          reason: unitPhaseResult.reason ?? "unit-break",
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          failureClass: "execution"
        });
        finishTurn("stopped", "execution", "unit-break");
        break;
      }
      let finalizeResult;
      journalReporter.emit("post-unit-finalize-start", {
        iteration,
        unitType: iterData.unitType,
        unitId: iterData.unitId
      });
      try {
        finalizeResult = await runFinalize(ic, iterData, loopState, sidecarItem);
      } catch (err) {
        const error = formatDispatchExceptionSummary({ error: err });
        journalReporter.emit("post-unit-finalize-end", {
          iteration,
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          status: "failed",
          error
        });
        dispatchSettled = settleDispatchFailed(
          dispatchId,
          error,
          {
            markFailed: markDispatchFailed,
            logWriteFailure: logDispatchLedgerWriteFailure
          }
        ) || dispatchSettled;
        throw err;
      }
      phaseReporter.report("finalize", finalizeResult.action, {
        unitType: iterData.unitType,
        unitId: iterData.unitId
      });
      const finalizeReason = finalizeResult.action === "break" ? finalizeResult.reason : void 0;
      journalReporter.emit("post-unit-finalize-end", {
        iteration,
        unitType: iterData.unitType,
        unitId: iterData.unitId,
        status: finalizeResult.action === "next" ? "completed" : finalizeResult.action === "continue" ? "retry" : "stopped",
        action: finalizeResult.action,
        ...finalizeReason ? { reason: finalizeReason } : {}
      });
      const finalizeDecision = decideFinalizeResult(
        finalizeResult.action === "break" ? { action: "break", reason: finalizeResult.reason } : finalizeResult.action === "continue" ? { action: "continue" } : { action: "next" }
      );
      if (finalizeDecision.action === "stop") {
        dispatchSettled = settleDispatchFailed(dispatchId, finalizeDecision.ledgerErrorSummary, {
          markFailed: markDispatchFailed,
          logWriteFailure: logDispatchLedgerWriteFailure
        }) || dispatchSettled;
        finishIncompleteIteration({
          status: "stopped",
          reason: finalizeReason ?? "finalize-break",
          unitType: iterData.unitType,
          unitId: iterData.unitId,
          failureClass: finalizeDecision.failureClass
        });
        finishTurn("stopped", finalizeDecision.failureClass, finalizeDecision.turnError);
        break;
      }
      if (finalizeDecision.action === "retry") {
        dispatchSettled = settleDispatchFailed(dispatchId, finalizeDecision.ledgerErrorSummary, {
          markFailed: markDispatchFailed,
          logWriteFailure: logDispatchLedgerWriteFailure
        }) || dispatchSettled;
        finishIncompleteIteration({
          status: "retry",
          reason: "finalize-retry",
          unitType: iterData.unitType,
          unitId: iterData.unitId
        });
        finishTurn("retry");
        continue;
      }
      dispatchSettled = settleDispatchCompleted(dispatchId, {
        markCompleted: markDispatchCompleted,
        logWriteFailure: logDispatchLedgerWriteFailure
      }) || dispatchSettled;
      completeIteration();
      finishTurn("completed");
    } catch (loopErr) {
      const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);
      if (dispatchId !== null && !dispatchSettled && !(loopErr instanceof ModelPolicyDispatchBlockedError)) {
        dispatchSettled = settleDispatchFailed(
          dispatchId,
          formatUnhandledDispatchErrorSummary({ error: loopErr }),
          {
            markFailed: markDispatchFailed,
            logWriteFailure: logDispatchLedgerWriteFailure
          }
        ) || dispatchSettled;
      }
      if (loopErr instanceof ModelPolicyDispatchBlockedError) {
        const policyDecision = decideModelPolicyBlocked({
          unitType: loopErr.unitType,
          unitId: loopErr.unitId,
          errorMessage: msg,
          reasons: loopErr.reasons
        });
        debugLog("autoLoop", {
          phase: "model-policy-blocked",
          iteration,
          unitType: loopErr.unitType,
          unitId: loopErr.unitId,
          reasons: loopErr.reasons
        });
        ctx.ui.notify(policyDecision.notifyMessage, "error");
        journalReporter.emit("unit-end", policyDecision.journalData);
        finishIncompleteIteration({
          status: "blocked",
          reason: "model-policy-dispatch-blocked",
          unitType: loopErr.unitType,
          unitId: loopErr.unitId
        });
        observedUnitType = loopErr.unitType;
        observedUnitId = loopErr.unitId;
        await deps.pauseAuto(ctx, pi);
        finishTurn(policyDecision.turnStatus, policyDecision.failureClass, msg);
        break;
      }
      finishIncompleteIteration({ status: "failed", error: msg });
      const infraCode = isInfrastructureError(loopErr);
      if (infraCode) {
        const infraDecision = decideInfrastructureError({
          code: infraCode,
          errorMessage: msg
        });
        debugLog("autoLoop", {
          phase: "infrastructure-error",
          iteration,
          code: infraCode,
          error: msg
        });
        ctx.ui.notify(infraDecision.notifyMessage, "error");
        await deps.stopAuto(ctx, pi, infraDecision.stopMessage);
        finishTurn(infraDecision.turnStatus, infraDecision.failureClass, msg);
        break;
      }
      if (isTransientCooldownError(loopErr)) {
        consecutiveCooldowns++;
        const retryAfterMs = getCooldownRetryAfterMs(loopErr);
        const cooldownDecision = decideCooldownRecovery({
          consecutiveCooldowns,
          maxCooldownRetries: MAX_COOLDOWN_RETRIES,
          retryAfterMs,
          fallbackWaitMs: COOLDOWN_FALLBACK_WAIT_MS
        });
        debugLog("autoLoop", {
          phase: "cooldown-wait",
          iteration,
          consecutiveCooldowns,
          retryAfterMs,
          error: msg
        });
        if (cooldownDecision.action === "stop") {
          ctx.ui.notify(cooldownDecision.notifyMessage, "error");
          finishTurn("stopped", "timeout", msg);
          await deps.stopAuto(ctx, pi, cooldownDecision.stopMessage);
          break;
        }
        ctx.ui.notify(cooldownDecision.notifyMessage, "warning");
        await new Promise((resolve) => setTimeout(resolve, cooldownDecision.waitMs));
        finishTurn("retry", "timeout", msg);
        continue;
      }
      consecutiveErrors++;
      recentErrorMessages.push(msg.length > 120 ? msg.slice(0, 120) + "..." : msg);
      debugLog("autoLoop", {
        phase: "iteration-error",
        iteration,
        consecutiveErrors,
        error: msg
      });
      const errorDecision = decideIterationErrorRecovery({
        consecutiveErrors,
        recentErrorMessages,
        currentErrorMessage: msg
      });
      if (errorDecision.action === "stop") {
        ctx.ui.notify(errorDecision.notifyMessage, "error");
        await deps.stopAuto(ctx, pi, errorDecision.stopMessage);
        finishTurn(errorDecision.turnStatus, "execution", msg);
        break;
      }
      if (errorDecision.action === "invalidate-and-retry") {
        ctx.ui.notify(errorDecision.notifyMessage, "warning");
        deps.invalidateAllCaches();
      } else {
        ctx.ui.notify(errorDecision.notifyMessage, "warning");
      }
      finishTurn(errorDecision.turnStatus, "execution", msg);
    }
  }
  _clearCurrentResolve();
  debugLog("autoLoop", { phase: "exit", totalIterations: iteration });
}
async function runUokKernelLoop(ctx, pi, s, deps) {
  return autoLoop(ctx, pi, s, deps, { dispatchContract: "uok-scheduler" });
}
async function runLegacyAutoLoop(ctx, pi, s, deps) {
  return autoLoop(ctx, pi, s, deps, { dispatchContract: "legacy-direct" });
}
export {
  autoLoop,
  runLegacyAutoLoop,
  runUokKernelLoop
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvL2xvb3AudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogYXV0by9sb29wLnRzIFx1MjAxNCBNYWluIGF1dG8tbW9kZSBleGVjdXRpb24gbG9vcC5cbiAqXG4gKiBJdGVyYXRlczogZGVyaXZlIFx1MjE5MiBkaXNwYXRjaCBcdTIxOTIgZ3VhcmRzIFx1MjE5MiBydW5Vbml0IFx1MjE5MiBmaW5hbGl6ZSBcdTIxOTIgcmVwZWF0LlxuICogRXhpdHMgd2hlbiBzLmFjdGl2ZSBiZWNvbWVzIGZhbHNlIG9yIGEgdGVybWluYWwgY29uZGl0aW9uIGlzIHJlYWNoZWQuXG4gKlxuICogSW1wb3J0cyBmcm9tOiBhdXRvL3R5cGVzLCBhdXRvL3Jlc29sdmUsIGF1dG8vcGhhc2VzXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25BUEksIEV4dGVuc2lvbkNvbnRleHQgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHR5cGUgeyBBdXRvU2Vzc2lvbiB9IGZyb20gXCIuL3Nlc3Npb24uanNcIjtcbmltcG9ydCB0eXBlIHsgTG9vcERlcHMgfSBmcm9tIFwiLi9sb29wLWRlcHMuanNcIjtcbmltcG9ydCB7XG4gIE1BWF9MT09QX0lURVJBVElPTlMsXG4gIHR5cGUgTG9vcFN0YXRlLFxuICB0eXBlIEl0ZXJhdGlvbkNvbnRleHQsXG4gIHR5cGUgSXRlcmF0aW9uRGF0YSxcbn0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IF9jbGVhckN1cnJlbnRSZXNvbHZlIH0gZnJvbSBcIi4vcmVzb2x2ZS5qc1wiO1xuaW1wb3J0IHtcbiAgcnVuUHJlRGlzcGF0Y2gsXG4gIHJ1bkRpc3BhdGNoLFxuICBydW5HdWFyZHMsXG4gIHJ1bkZpbmFsaXplLFxufSBmcm9tIFwiLi9waGFzZXMuanNcIjtcbmltcG9ydCB7IGRlYnVnTG9nIH0gZnJvbSBcIi4uL2RlYnVnLWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgaXNJbmZyYXN0cnVjdHVyZUVycm9yLCBpc1RyYW5zaWVudENvb2xkb3duRXJyb3IsIGdldENvb2xkb3duUmV0cnlBZnRlck1zLCBDT09MRE9XTl9GQUxMQkFDS19XQUlUX01TLCBNQVhfQ09PTERPV05fUkVUUklFUyB9IGZyb20gXCIuL2luZnJhLWVycm9ycy5qc1wiO1xuaW1wb3J0IHsgTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvciB9IGZyb20gXCIuLi9hdXRvLW1vZGVsLXNlbGVjdGlvbi5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUVuZ2luZSB9IGZyb20gXCIuLi9lbmdpbmUtcmVzb2x2ZXIuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQge1xuICByZWNvcmREaXNwYXRjaENsYWltLFxuICBtYXJrUnVubmluZyBhcyBtYXJrRGlzcGF0Y2hSdW5uaW5nLFxuICBtYXJrQ29tcGxldGVkIGFzIG1hcmtEaXNwYXRjaENvbXBsZXRlZCxcbiAgbWFya0ZhaWxlZCBhcyBtYXJrRGlzcGF0Y2hGYWlsZWQsXG4gIGdldFJlY2VudEZvclVuaXQgYXMgZ2V0UmVjZW50RGlzcGF0Y2hlc0ZvclVuaXQsXG4gIGdldFJlY2VudFVuaXRLZXlzRm9yUHJvamVjdFJvb3QsXG59IGZyb20gXCIuLi9kYi91bml0LWRpc3BhdGNoZXMuanNcIjtcbmltcG9ydCB7IGNsYWltTWlsZXN0b25lTGVhc2UsIHJlZnJlc2hNaWxlc3RvbmVMZWFzZSB9IGZyb20gXCIuLi9kYi9taWxlc3RvbmUtbGVhc2VzLmpzXCI7XG5pbXBvcnQgeyBoZWFydGJlYXRBdXRvV29ya2VyIH0gZnJvbSBcIi4uL2RiL2F1dG8td29ya2Vycy5qc1wiO1xuaW1wb3J0IHsgZ2V0UnVudGltZUt2LCBzZXRSdW50aW1lS3YgfSBmcm9tIFwiLi4vZGIvcnVudGltZS1rdi5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVVva0ZsYWdzIH0gZnJvbSBcIi4uL3Vvay9mbGFncy5qc1wiO1xuaW1wb3J0IHsgc2NoZWR1bGVTaWRlY2FyUXVldWUgfSBmcm9tIFwiLi4vdW9rL2V4ZWN1dGlvbi1ncmFwaC5qc1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplUmVhbFBhdGggfSBmcm9tIFwiLi4vcGF0aHMuanNcIjtcbmltcG9ydCB7XG4gIGRlY2lkZUNvb2xkb3duUmVjb3ZlcnksXG4gIGRlY2lkZURpc3BhdGNoQ2xhaW0sXG4gIGRlY2lkZUVuZ2luZURpc3BhdGNoLFxuICBkZWNpZGVGaW5hbGl6ZVJlc3VsdCxcbiAgZGVjaWRlSW5mcmFzdHJ1Y3R1cmVFcnJvcixcbiAgZGVjaWRlSXRlcmF0aW9uRXJyb3JSZWNvdmVyeSxcbiAgZGVjaWRlTWVtb3J5UHJlc3N1cmUsXG4gIGRlY2lkZU1vZGVsUG9saWN5QmxvY2tlZCxcbiAgZGVjaWRlTWluUmVxdWVzdEludGVydmFsLFxuICBkZWNpZGVXb3JrZmxvd0xvb3AsXG4gIGZvcm1hdERpc3BhdGNoRXhjZXB0aW9uU3VtbWFyeSxcbiAgZm9ybWF0VW5oYW5kbGVkRGlzcGF0Y2hFcnJvclN1bW1hcnksXG4gIHJlc29sdmVVbml0UmVxdWVzdFRpbWVzdGFtcCxcbiAgc2hvdWxkVXNlQ3VzdG9tRW5naW5lUGF0aCxcbn0gZnJvbSBcIi4vd29ya2Zsb3cta2VybmVsLmpzXCI7XG5pbXBvcnQge1xuICBoeWRyYXRlQ3VzdG9tVmVyaWZ5UmV0cnlDb3VudHMsXG4gIHNhdmVDdXN0b21WZXJpZnlSZXRyeUNvdW50cyxcbn0gZnJvbSBcIi4vY3VzdG9tLXZlcmlmeS1yZXRyeS1zdG9yZS5qc1wiO1xuaW1wb3J0IHtcbiAgc2V0dGxlRGlzcGF0Y2hDb21wbGV0ZWQsXG4gIHNldHRsZURpc3BhdGNoRmFpbGVkLFxufSBmcm9tIFwiLi93b3JrZmxvdy1kaXNwYXRjaC1sZWRnZXIuanNcIjtcbmltcG9ydCB7IGVtaXRPcGVuVW5pdEVuZEZvclVuaXQgfSBmcm9tIFwiLi4vY3Jhc2gtcmVjb3ZlcnkuanNcIjtcbmltcG9ydCB7IHdyaXRlVW5pdFJ1bnRpbWVSZWNvcmQgfSBmcm9tIFwiLi4vdW5pdC1ydW50aW1lLmpzXCI7XG5pbXBvcnQgeyBlbnN1cmVEaXNwYXRjaExlYXNlLCBvcGVuRGlzcGF0Y2hDbGFpbSB9IGZyb20gXCIuL3dvcmtmbG93LWRpc3BhdGNoLWNsYWltLmpzXCI7XG5pbXBvcnQgeyBjb21wbGV0ZVdvcmtmbG93SXRlcmF0aW9uIH0gZnJvbSBcIi4vd29ya2Zsb3ctaXRlcmF0aW9uLWNvbXBsZXRpb24uanNcIjtcbmltcG9ydCB7IGNyZWF0ZVdvcmtmbG93Sm91cm5hbFJlcG9ydGVyIH0gZnJvbSBcIi4vd29ya2Zsb3ctam91cm5hbC1yZXBvcnRlci5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlV29ya2Zsb3dQaGFzZVJlcG9ydGVyIH0gZnJvbSBcIi4vd29ya2Zsb3ctcGhhc2UtcmVwb3J0ZXIuanNcIjtcbmltcG9ydCB7IGNyZWF0ZVdvcmtmbG93VHVyblJlcG9ydGVyIH0gZnJvbSBcIi4vd29ya2Zsb3ctdHVybi1yZXBvcnRlci5qc1wiO1xuaW1wb3J0IHsgdmFsaWRhdGVXb3JrZmxvd1Nlc3Npb25Mb2NrIH0gZnJvbSBcIi4vd29ya2Zsb3ctc2Vzc2lvbi1sb2NrLmpzXCI7XG5pbXBvcnQgeyBkZXF1ZXVlU2lkZWNhckl0ZW0gfSBmcm9tIFwiLi93b3JrZmxvdy1zaWRlY2FyLXF1ZXVlLmpzXCI7XG5pbXBvcnQgeyBtYWludGFpbldvcmtlckhlYXJ0YmVhdCB9IGZyb20gXCIuL3dvcmtmbG93LXdvcmtlci1oZWFydGJlYXQuanNcIjtcbmltcG9ydCB7XG4gIG1lYXN1cmVNZW1vcnlQcmVzc3VyZSxcbiAgc2hvdWxkQ2hlY2tNZW1vcnlQcmVzc3VyZSxcbn0gZnJvbSBcIi4vd29ya2Zsb3ctbWVtb3J5LXByZXNzdXJlLmpzXCI7XG5pbXBvcnQgeyBidWlsZFNpZGVjYXJJdGVyYXRpb25EYXRhIH0gZnJvbSBcIi4vd29ya2Zsb3ctc2lkZWNhci1pdGVyYXRpb24uanNcIjtcbmltcG9ydCB7XG4gIGNyZWF0ZUV4ZWN1dGlvbkdyYXBoVW5pdERpc3BhdGNoRGVwcyxcbiAgcnVuVW5pdFBoYXNlVmlhQ29udHJhY3QsXG4gIHR5cGUgRGlzcGF0Y2hDb250cmFjdCxcbn0gZnJvbSBcIi4vd29ya2Zsb3ctdW5pdC1kaXNwYXRjaC5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlQ3VzdG9tRW5naW5lRGlzcGF0Y2hPdXRjb21lIH0gZnJvbSBcIi4vd29ya2Zsb3ctY3VzdG9tLWVuZ2luZS1kaXNwYXRjaC1vdXRjb21lLmpzXCI7XG5pbXBvcnQgeyBidWlsZEN1c3RvbUVuZ2luZUl0ZXJhdGlvbkRhdGEgfSBmcm9tIFwiLi93b3JrZmxvdy1jdXN0b20tZW5naW5lLWl0ZXJhdGlvbi5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlQ3VzdG9tRW5naW5lVmVyaWZ5UmV0cnkgfSBmcm9tIFwiLi93b3JrZmxvdy1jdXN0b20tZW5naW5lLXJldHJ5LmpzXCI7XG5pbXBvcnQge1xuICBoYW5kbGVDdXN0b21FbmdpbmVWZXJpZnlQYXVzZSxcbiAgaGFuZGxlQ3VzdG9tRW5naW5lVmVyaWZ5UmV0cnlPdXRjb21lLFxufSBmcm9tIFwiLi93b3JrZmxvdy1jdXN0b20tZW5naW5lLXZlcmlmeS1vdXRjb21lLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVDdXN0b21FbmdpbmVSZWNvbmNpbGUgfSBmcm9tIFwiLi93b3JrZmxvdy1jdXN0b20tZW5naW5lLXJlY29uY2lsZS5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlQ3VzdG9tRW5naW5lUmVjb25jaWxlT3V0Y29tZSB9IGZyb20gXCIuL3dvcmtmbG93LWN1c3RvbS1lbmdpbmUtcmVjb25jaWxlLW91dGNvbWUuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIFN0dWNrIGRldGVjdGlvbiBwZXJzaXN0ZW5jZSAoIzM3MDQpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gUGhhc2UgQyBtaWdyYXRpb246IHN0dWNrLXN0YXRlLmpzb24gZGVsZXRlZCBpbiBmYXZvciBvZiBEQi1iYWNrZWRcbi8vIGVxdWl2YWxlbnRzLiByZWNlbnRVbml0cyBpcyByZWJ1aWx0IGZyb20gdW5pdF9kaXNwYXRjaGVzIChQaGFzZSBCXG4vLyBsZWRnZXIpIG9uIHNlc3Npb24gc3RhcnQ7IHN0dWNrUmVjb3ZlcnlBdHRlbXB0cyBwZXJzaXN0cyBpbiBydW50aW1lX2t2XG4vLyB1bmRlciBhIHN0YWJsZSBwcm9qZWN0IHNjb3BlIChzb2Z0IHN0YXRlIHBlciB0aGUgcnVudGltZV9rdiBpbnZhcmlhbnQpLiBTaW5nbGUtaG9zdFxuLy8gU1FMaXRlIFdBTCBvbmx5IFx1MjAxNCBtdWx0aS1ob3N0IHdvdWxkIG5lZWQgYSByZWFsIGNvb3JkaW5hdG9yLlxuLy9cbi8vIFdoZW4gbm8gd29ya2VyIGlzIHJlZ2lzdGVyZWQgKERCIHVuYXZhaWxhYmxlLCBmcmVzaCBwcm9qZWN0KSwgYm90aFxuLy8gaGVscGVycyBkZWdyYWRlIHRvIHRoZSBlbXB0eS1zdGF0ZSBmYWxsYmFjayB0aGF0ICMzNzA0IGFscmVhZHlcbi8vIHRvbGVyYXRlcyBcdTIwMTQgc2FtZSBiZWhhdmlvciBhcyBhIGZyZXNoIHNlc3Npb24uXG5jb25zdCBTVFVDS19SRUNPVkVSWV9BVFRFTVBUU19LRVkgPSBcInN0dWNrX3JlY292ZXJ5X2F0dGVtcHRzXCI7XG5jb25zdCBSRUNFTlRfVU5JVF9LRVlTX0xJTUlUID0gMjA7XG5cbmZ1bmN0aW9uIHN0YWJsZVN0dWNrU3RhdGVTY29wZUlkKHM6IEF1dG9TZXNzaW9uKTogc3RyaW5nIHtcbiAgcmV0dXJuIG5vcm1hbGl6ZVJlYWxQYXRoKHMuc2NvcGU/LndvcmtzcGFjZS5wcm9qZWN0Um9vdCA/PyAocy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGgpKTtcbn1cblxuZnVuY3Rpb24gbG9hZFN0dWNrU3RhdGUoczogQXV0b1Nlc3Npb24pOiB7IHJlY2VudFVuaXRzOiBBcnJheTx7IGtleTogc3RyaW5nIH0+OyBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IG51bWJlciB9IHtcbiAgY29uc3Qgc2NvcGVJZCA9IHN0YWJsZVN0dWNrU3RhdGVTY29wZUlkKHMpO1xuICBpZiAoIXNjb3BlSWQpIHJldHVybiB7IHJlY2VudFVuaXRzOiBbXSwgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwIH07XG4gIHRyeSB7XG4gICAgY29uc3QgcmVjZW50VW5pdHMgPSBnZXRSZWNlbnRVbml0S2V5c0ZvclByb2plY3RSb290KHNjb3BlSWQsIFJFQ0VOVF9VTklUX0tFWVNfTElNSVQpO1xuICAgIGNvbnN0IHN0dWNrUmVjb3ZlcnlBdHRlbXB0cyA9XG4gICAgICBnZXRSdW50aW1lS3Y8bnVtYmVyPihcImdsb2JhbFwiLCBzY29wZUlkLCBTVFVDS19SRUNPVkVSWV9BVFRFTVBUU19LRVkpID8/IDA7XG4gICAgcmV0dXJuIHsgcmVjZW50VW5pdHMsIHN0dWNrUmVjb3ZlcnlBdHRlbXB0cyB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwibG9hZC1zdHVjay1zdGF0ZS1mYWlsZWRcIiwgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9KTtcbiAgICByZXR1cm4geyByZWNlbnRVbml0czogW10sIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVTdHVja1N0YXRlKHM6IEF1dG9TZXNzaW9uLCBzdGF0ZTogTG9vcFN0YXRlKTogdm9pZCB7XG4gIGNvbnN0IHNjb3BlSWQgPSBzdGFibGVTdHVja1N0YXRlU2NvcGVJZChzKTtcbiAgaWYgKCFzY29wZUlkKSByZXR1cm47XG4gIC8vIHJlY2VudFVuaXRzIGlzIGF1dG9tYXRpY2FsbHkgZGVyaXZlZCBmcm9tIHVuaXRfZGlzcGF0Y2hlcyBieSB0aGVcbiAgLy8gZGlzcGF0Y2ggbGVkZ2VyIHdyaXRlcyBpbiBvcGVuRGlzcGF0Y2hDbGFpbSBcdTIwMTQgbm8gc2VwYXJhdGUgcGVyc2lzdGVuY2VcbiAgLy8gbmVlZGVkLiBPbmx5IHRoZSBzb2Z0IHJldHJ5IGNvdW50ZXIgbmVlZHMgYSBydW50aW1lX2t2IHJvdy5cbiAgdHJ5IHtcbiAgICBzZXRSdW50aW1lS3YoXCJnbG9iYWxcIiwgc2NvcGVJZCwgU1RVQ0tfUkVDT1ZFUllfQVRURU1QVFNfS0VZLCBzdGF0ZS5zdHVja1JlY292ZXJ5QXR0ZW1wdHMpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwic2F2ZS1zdHVjay1zdGF0ZS1mYWlsZWRcIiwgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBsb2dEaXNwYXRjaExlZGdlcldyaXRlRmFpbHVyZShlcnI6IHVua25vd24pOiB2b2lkIHtcbiAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgcGhhc2U6IFwiZGlzcGF0Y2gtbGVkZ2VyLXdyaXRlLWZhaWxlZFwiLFxuICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBsb2dEaXNwYXRjaENsYWltUmVqZWN0ZWQoZGV0YWlsczoge1xuICB1bml0SWQ6IHN0cmluZztcbiAgcmVhc29uOiBzdHJpbmc7XG4gIGV4aXN0aW5nSWQ/OiBudW1iZXI7XG4gIGV4aXN0aW5nV29ya2VyPzogc3RyaW5nO1xufSk6IHZvaWQge1xuICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICBwaGFzZTogXCJkaXNwYXRjaC1jbGFpbS1yZWplY3RlZFwiLFxuICAgIC4uLmRldGFpbHMsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBsb2dEaXNwYXRjaENsYWltRmFpbGVkKGVycjogdW5rbm93bik6IHZvaWQge1xuICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICBwaGFzZTogXCJkaXNwYXRjaC1jbGFpbS1mYWlsZWRcIixcbiAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gbG9nRGlzcGF0Y2hMZWFzZVJlY292ZXJlZChkZXRhaWxzOiB7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHdvcmtlcklkOiBzdHJpbmc7XG4gIHRva2VuOiBudW1iZXI7XG4gIHJlY292ZXJlZDogYm9vbGVhbjtcbn0pOiB2b2lkIHtcbiAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgcGhhc2U6IGRldGFpbHMucmVjb3ZlcmVkID8gXCJkaXNwYXRjaC1sZWFzZS1yZWNvdmVyZWRcIiA6IFwiZGlzcGF0Y2gtbGVhc2UtYWNxdWlyZWRcIixcbiAgICAuLi5kZXRhaWxzLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gbG9nRGlzcGF0Y2hMZWFzZVJlY292ZXJ5RmFpbGVkKGRldGFpbHM6IHtcbiAgbWlsZXN0b25lSWQ/OiBzdHJpbmc7XG4gIHdvcmtlcklkPzogc3RyaW5nO1xuICByZWFzb246IHN0cmluZztcbn0pOiB2b2lkIHtcbiAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgcGhhc2U6IFwiZGlzcGF0Y2gtbGVhc2UtcmVjb3ZlcnktZmFpbGVkXCIsXG4gICAgLi4uZGV0YWlscyxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGxvZ0N1c3RvbVZlcmlmeVJldHJ5TG9hZEZhaWx1cmUoZXJyOiB1bmtub3duKTogdm9pZCB7XG4gIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgIHBoYXNlOiBcImxvYWQtY3VzdG9tLXZlcmlmeS1yZXRyaWVzLWZhaWxlZFwiLFxuICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBsb2dDdXN0b21WZXJpZnlSZXRyeVNhdmVGYWlsdXJlKGVycjogdW5rbm93bik6IHZvaWQge1xuICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICBwaGFzZTogXCJzYXZlLWN1c3RvbS12ZXJpZnktcmV0cmllcy1mYWlsZWRcIixcbiAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICB9KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIE1lbW9yeSBwcmVzc3VyZSBtb25pdG9yaW5nICgjMzMzMSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBDaGVjayBoZWFwIHVzYWdlIG9uIHNlc3Npb24gc3RhcnR1cCwgdGhlbiBldmVyeSBOIGl0ZXJhdGlvbnMsIGFuZCB0cmlnZ2VyXG4vLyBncmFjZWZ1bCBzaHV0ZG93biBiZWZvcmUgdGhlIE9TIE9PTSBraWxsZXIgc2VuZHMgU0lHS0lMTC4gVGhlIHRocmVzaG9sZCBpc1xuLy8gOTAlIG9mIHRoZSBWOCBoZWFwIGxpbWl0ICgtLW1heC1vbGQtc3BhY2Utc2l6ZSBvciBkZWZhdWx0IH4xLjUtNEdCIGRlcGVuZGluZyBvbiBwbGF0Zm9ybSkuXG5jb25zdCBNRU1PUllfQ0hFQ0tfSU5URVJWQUwgPSA1OyAvLyBjaGVjayBldmVyeSA1IGl0ZXJhdGlvbnNcbmNvbnN0IE1BWF9DVVNUT01fRU5HSU5FX1ZFUklGWV9SRVRSSUVTID0gMztcblxuaW50ZXJmYWNlIEF1dG9Mb29wT3B0aW9ucyB7XG4gIGRpc3BhdGNoQ29udHJhY3Q/OiBEaXNwYXRjaENvbnRyYWN0O1xufVxuXG5hc3luYyBmdW5jdGlvbiBlbmZvcmNlTWluUmVxdWVzdEludGVydmFsKHM6IEF1dG9TZXNzaW9uLCBwcmVmczogSXRlcmF0aW9uQ29udGV4dFtcInByZWZzXCJdKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IG1pbkludGVydmFsID0gcHJlZnM/Lm1pbl9yZXF1ZXN0X2ludGVydmFsX21zID8/IDA7XG4gIGNvbnN0IGRlY2lzaW9uID0gZGVjaWRlTWluUmVxdWVzdEludGVydmFsKHtcbiAgICBtaW5JbnRlcnZhbE1zOiBtaW5JbnRlcnZhbCxcbiAgICBsYXN0UmVxdWVzdFRpbWVzdGFtcDogcy5sYXN0UmVxdWVzdFRpbWVzdGFtcCxcbiAgICBub3dNczogRGF0ZS5ub3coKSxcbiAgfSk7XG4gIGlmIChkZWNpc2lvbi5hY3Rpb24gPT09IFwid2FpdFwiKSB7XG4gICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcInJhdGUtbGltaXQtd2FpdFwiLCB3YWl0TXM6IGRlY2lzaW9uLndhaXRNcyB9KTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPihyID0+IHNldFRpbWVvdXQociwgZGVjaXNpb24ud2FpdE1zKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2xvc2VPdXRDcmFzaGVkVW5pdChzOiBBdXRvU2Vzc2lvbiwgaXRlckRhdGE6IEl0ZXJhdGlvbkRhdGEsIGVycjogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBzdW1tYXJ5ID0gZm9ybWF0RGlzcGF0Y2hFeGNlcHRpb25TdW1tYXJ5KHsgZXJyb3I6IGVyciB9KTtcbiAgdHJ5IHtcbiAgICBlbWl0T3BlblVuaXRFbmRGb3JVbml0KFxuICAgICAgcy5iYXNlUGF0aCxcbiAgICAgIGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgaXRlckRhdGEudW5pdElkLFxuICAgICAgXCJjYW5jZWxsZWRcIixcbiAgICAgIHtcbiAgICAgICAgbWVzc2FnZTogc3VtbWFyeSxcbiAgICAgICAgY2F0ZWdvcnk6IFwidW5pdC1leGNlcHRpb25cIixcbiAgICAgICAgaXNUcmFuc2llbnQ6IGZhbHNlLFxuICAgICAgfSxcbiAgICApO1xuICAgIHdyaXRlVW5pdFJ1bnRpbWVSZWNvcmQoXG4gICAgICBzLmJhc2VQYXRoLFxuICAgICAgaXRlckRhdGEudW5pdFR5cGUsXG4gICAgICBpdGVyRGF0YS51bml0SWQsXG4gICAgICBzLmN1cnJlbnRVbml0Py5zdGFydGVkQXQgPz8gRGF0ZS5ub3coKSxcbiAgICAgIHtcbiAgICAgICAgcGhhc2U6IFwiY3Jhc2hlZFwiLFxuICAgICAgICBsYXN0UHJvZ3Jlc3NBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgbGFzdFByb2dyZXNzS2luZDogXCJ1bml0LWV4Y2VwdGlvblwiLFxuICAgICAgfSxcbiAgICApO1xuICB9IGNhdGNoIChjbG9zZW91dEVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJkaXNwYXRjaFwiLCBgdW5pdCBjcmFzaCBjbG9zZW91dCBmYWlsZWQ6ICR7Y2xvc2VvdXRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGNsb3Nlb3V0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoY2xvc2VvdXRFcnIpfWApO1xuICB9XG59XG5cbi8qKlxuICogTWFpbiBhdXRvLW1vZGUgZXhlY3V0aW9uIGxvb3AuIEl0ZXJhdGVzOiBkZXJpdmUgXHUyMTkyIGRpc3BhdGNoIFx1MjE5MiBndWFyZHMgXHUyMTkyXG4gKiBydW5Vbml0IFx1MjE5MiBmaW5hbGl6ZSBcdTIxOTIgcmVwZWF0LiBFeGl0cyB3aGVuIHMuYWN0aXZlIGJlY29tZXMgZmFsc2Ugb3IgYVxuICogdGVybWluYWwgY29uZGl0aW9uIGlzIHJlYWNoZWQuXG4gKlxuICogVGhpcyBpcyB0aGUgbGluZWFyIHJlcGxhY2VtZW50IGZvciB0aGUgcmVjdXJzaXZlXG4gKiBkaXNwYXRjaE5leHRVbml0IFx1MjE5MiByZXNvbHZlQWdlbnRFbmQgXHUyMTkyIGRpc3BhdGNoTmV4dFVuaXQgY2hhaW4uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhdXRvTG9vcChcbiAgY3R4OiBFeHRlbnNpb25Db250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuICBzOiBBdXRvU2Vzc2lvbixcbiAgZGVwczogTG9vcERlcHMsXG4gIG9wdGlvbnM/OiBBdXRvTG9vcE9wdGlvbnMsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImVudGVyXCIgfSk7XG4gIGxldCBpdGVyYXRpb24gPSAwO1xuICBjb25zdCBkaXNwYXRjaENvbnRyYWN0ID0gb3B0aW9ucz8uZGlzcGF0Y2hDb250cmFjdCA/PyBcImxlZ2FjeS1kaXJlY3RcIjtcbiAgY29uc3QgdW5pdERpc3BhdGNoRGVwcyA9IGNyZWF0ZUV4ZWN1dGlvbkdyYXBoVW5pdERpc3BhdGNoRGVwcygpO1xuICAvLyBMb2FkIHBlcnNpc3RlZCBzdHVjayBzdGF0ZSBzbyBjb3VudGVycyBzdXJ2aXZlIHNlc3Npb24gcmVzdGFydHMgKCMzNzA0KVxuICBjb25zdCBwZXJzaXN0ZWQgPSBsb2FkU3R1Y2tTdGF0ZShzKTtcbiAgY29uc3QgbG9vcFN0YXRlOiBMb29wU3RhdGUgPSB7XG4gICAgcmVjZW50VW5pdHM6IHBlcnNpc3RlZC5yZWNlbnRVbml0cyxcbiAgICBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IHBlcnNpc3RlZC5zdHVja1JlY292ZXJ5QXR0ZW1wdHMsXG4gICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICB9O1xuICBsZXQgY29uc2VjdXRpdmVFcnJvcnMgPSAwO1xuICBsZXQgY29uc2VjdXRpdmVDb29sZG93bnMgPSAwO1xuICBjb25zdCByZWNlbnRFcnJvck1lc3NhZ2VzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIHdoaWxlIChzLmFjdGl2ZSkge1xuICAgIGl0ZXJhdGlvbisrO1xuICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJsb29wLXRvcFwiLCBpdGVyYXRpb24gfSk7XG5cbiAgICBtYWludGFpbldvcmtlckhlYXJ0YmVhdChzLCB7XG4gICAgICBoZWFydGJlYXRBdXRvV29ya2VyLFxuICAgICAgcmVmcmVzaE1pbGVzdG9uZUxlYXNlLFxuICAgICAgbG9nSGVhcnRiZWF0RmFpbHVyZTogZXJyID0+IGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICBwaGFzZTogXCJoZWFydGJlYXQtZmFpbGVkXCIsXG4gICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICB9KSxcbiAgICAgIGxvZ0xlYXNlUmVmcmVzaE1pc3M6IGRldGFpbHMgPT4gZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgICAgIHBoYXNlOiBcImxlYXNlLXJlZnJlc2gtbWlzc2VkXCIsXG4gICAgICAgIC4uLmRldGFpbHMsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCBKb3VybmFsOiBwZXItaXRlcmF0aW9uIGZsb3cgZ3JvdXBpbmcgXHUyNTAwXHUyNTAwXG4gICAgY29uc3QgZmxvd0lkID0gcmFuZG9tVVVJRCgpO1xuICAgIGxldCBzZXFDb3VudGVyID0gMDtcbiAgICBjb25zdCBuZXh0U2VxID0gKCkgPT4gKytzZXFDb3VudGVyO1xuICAgIGNvbnN0IGpvdXJuYWxSZXBvcnRlciA9IGNyZWF0ZVdvcmtmbG93Sm91cm5hbFJlcG9ydGVyKHtcbiAgICAgIGVtaXRKb3VybmFsRXZlbnQ6IGRlcHMuZW1pdEpvdXJuYWxFdmVudCxcbiAgICAgIGZsb3dJZCxcbiAgICAgIG5leHRTZXEsXG4gICAgfSk7XG4gICAgY29uc3QgdHVybklkID0gcmFuZG9tVVVJRCgpO1xuICAgIHMuY3VycmVudFRyYWNlSWQgPSBmbG93SWQ7XG4gICAgcy5jdXJyZW50VHVybklkID0gdHVybklkO1xuICAgIGNvbnN0IHR1cm5TdGFydGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgbGV0IG9ic2VydmVkVW5pdFR5cGU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgb2JzZXJ2ZWRVbml0SWQ6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBjb25zdCBwaGFzZVJlcG9ydGVyID0gY3JlYXRlV29ya2Zsb3dQaGFzZVJlcG9ydGVyKHtcbiAgICAgIG9ic2VydmVyOiBkZXBzLnVva09ic2VydmVyLFxuICAgIH0pO1xuICAgIGNvbnN0IHR1cm5SZXBvcnRlciA9IGNyZWF0ZVdvcmtmbG93VHVyblJlcG9ydGVyKHtcbiAgICAgIG9ic2VydmVyOiBkZXBzLnVva09ic2VydmVyLFxuICAgICAgdHJhY2VJZDogZmxvd0lkLFxuICAgICAgdHVybklkLFxuICAgICAgaXRlcmF0aW9uLFxuICAgICAgYmFzZVBhdGg6IHMuYmFzZVBhdGgsXG4gICAgICBzdGFydGVkQXQ6IHR1cm5TdGFydGVkQXQsXG4gICAgICBjbGVhckN1cnJlbnRUdXJuOiAoKSA9PiB7XG4gICAgICAgIHMuY3VycmVudFRyYWNlSWQgPSBudWxsO1xuICAgICAgICBzLmN1cnJlbnRUdXJuSWQgPSBudWxsO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCBmaW5pc2hUdXJuID0gKFxuICAgICAgc3RhdHVzOiBcImNvbXBsZXRlZFwiIHwgXCJmYWlsZWRcIiB8IFwicGF1c2VkXCIgfCBcInN0b3BwZWRcIiB8IFwic2tpcHBlZFwiIHwgXCJyZXRyeVwiLFxuICAgICAgZmFpbHVyZUNsYXNzOiBcIm5vbmVcIiB8IFwidW5rbm93blwiIHwgXCJtYW51YWwtYXR0ZW50aW9uXCIgfCBcInRpbWVvdXRcIiB8IFwiZXhlY3V0aW9uXCIgfCBcImNsb3Nlb3V0XCIgfCBcImdpdFwiID0gXCJub25lXCIsXG4gICAgICBlcnJvcj86IHN0cmluZyxcbiAgICApOiB2b2lkID0+IHtcbiAgICAgIHR1cm5SZXBvcnRlci5maW5pc2goe1xuICAgICAgICB1bml0VHlwZTogb2JzZXJ2ZWRVbml0VHlwZSxcbiAgICAgICAgdW5pdElkOiBvYnNlcnZlZFVuaXRJZCxcbiAgICAgICAgc3RhdHVzLFxuICAgICAgICBmYWlsdXJlQ2xhc3MsXG4gICAgICAgIGVycm9yLFxuICAgICAgfSk7XG4gICAgfTtcbiAgICB0dXJuUmVwb3J0ZXIuc3RhcnQoKTtcblxuICAgIGNvbnN0IGl0ZXJhdGlvbkRlY2lzaW9uID0gZGVjaWRlV29ya2Zsb3dMb29wKHtcbiAgICAgIGFjdGl2ZTogcy5hY3RpdmUsXG4gICAgICBpdGVyYXRpb24sXG4gICAgICBtYXhJdGVyYXRpb25zOiBNQVhfTE9PUF9JVEVSQVRJT05TLFxuICAgICAgaGFzQ29tbWFuZENvbnRleHQ6IHRydWUsXG4gICAgICBzZXNzaW9uTG9ja1ZhbGlkOiB0cnVlLFxuICAgIH0pO1xuICAgIGlmIChpdGVyYXRpb25EZWNpc2lvbi5hY3Rpb24gPT09IFwic3RvcFwiICYmIGl0ZXJhdGlvbkRlY2lzaW9uLnJlYXNvbiA9PT0gXCJtYXgtaXRlcmF0aW9uc1wiKSB7XG4gICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICAgICAgcGhhc2U6IFwiZXhpdFwiLFxuICAgICAgICByZWFzb246IGl0ZXJhdGlvbkRlY2lzaW9uLnJlYXNvbixcbiAgICAgICAgaXRlcmF0aW9uLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCBkZXBzLnN0b3BBdXRvKFxuICAgICAgICBjdHgsXG4gICAgICAgIHBpLFxuICAgICAgICBgU2FmZXR5OiBsb29wIGV4Y2VlZGVkICR7TUFYX0xPT1BfSVRFUkFUSU9OU30gaXRlcmF0aW9ucyBcdTIwMTQgcG9zc2libGUgcnVuYXdheWAsXG4gICAgICApO1xuICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJtYW51YWwtYXR0ZW50aW9uXCIsIFwibWF4LWl0ZXJhdGlvbnNcIik7XG4gICAgICBicmVhaztcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgTWVtb3J5IHByZXNzdXJlIGNoZWNrICgjMzMzMSkgXHUyNTAwXHUyNTAwXG4gICAgLy8gR3JhY2VmdWwgc2h1dGRvd24gYmVmb3JlIE9PTSBraWxsZXIgc2VuZHMgU0lHS0lMTC5cbiAgICBpZiAoc2hvdWxkQ2hlY2tNZW1vcnlQcmVzc3VyZShpdGVyYXRpb24sIE1FTU9SWV9DSEVDS19JTlRFUlZBTCkpIHtcbiAgICAgIGNvbnN0IG1lbSA9IG1lYXN1cmVNZW1vcnlQcmVzc3VyZSgpO1xuICAgICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcIm1lbW9yeS1jaGVja1wiLCAuLi5tZW0gfSk7XG4gICAgICBjb25zdCBtZW1vcnlEZWNpc2lvbiA9IGRlY2lkZU1lbW9yeVByZXNzdXJlKHsgLi4ubWVtLCBpdGVyYXRpb24gfSk7XG4gICAgICBpZiAobWVtb3J5RGVjaXNpb24uYWN0aW9uID09PSBcInN0b3BcIikge1xuICAgICAgICBsb2dXYXJuaW5nKFwiZGlzcGF0Y2hcIiwgbWVtb3J5RGVjaXNpb24ud2FybmluZ01lc3NhZ2UpO1xuICAgICAgICBhd2FpdCBkZXBzLnN0b3BBdXRvKGN0eCwgcGksIG1lbW9yeURlY2lzaW9uLnN0b3BNZXNzYWdlKTtcbiAgICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJ0aW1lb3V0XCIsIG1lbW9yeURlY2lzaW9uLnR1cm5FcnJvcik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGNvbW1hbmRDb250ZXh0RGVjaXNpb24gPSBkZWNpZGVXb3JrZmxvd0xvb3Aoe1xuICAgICAgYWN0aXZlOiBzLmFjdGl2ZSxcbiAgICAgIGl0ZXJhdGlvbixcbiAgICAgIG1heEl0ZXJhdGlvbnM6IE1BWF9MT09QX0lURVJBVElPTlMsXG4gICAgICBoYXNDb21tYW5kQ29udGV4dDogQm9vbGVhbihzLmNtZEN0eCksXG4gICAgICBzZXNzaW9uTG9ja1ZhbGlkOiB0cnVlLFxuICAgIH0pO1xuICAgIGlmIChjb21tYW5kQ29udGV4dERlY2lzaW9uLmFjdGlvbiA9PT0gXCJzdG9wXCIgJiYgY29tbWFuZENvbnRleHREZWNpc2lvbi5yZWFzb24gPT09IFwibWlzc2luZy1jb21tYW5kLWNvbnRleHRcIikge1xuICAgICAgZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcImV4aXRcIiwgcmVhc29uOiBcIm5vLWNtZEN0eFwiIH0pO1xuICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJtYW51YWwtYXR0ZW50aW9uXCIsIGNvbW1hbmRDb250ZXh0RGVjaXNpb24ucmVhc29uKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cblxuICAgIGxldCBkaXNwYXRjaElkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgZGlzcGF0Y2hTZXR0bGVkID0gZmFsc2U7XG4gICAgbGV0IGl0ZXJhdGlvbkVuZEVtaXR0ZWQgPSBmYWxzZTtcbiAgICBjb25zdCBlbWl0SXRlcmF0aW9uRW5kID0gKGRldGFpbHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30pOiB2b2lkID0+IHtcbiAgICAgIGlmIChpdGVyYXRpb25FbmRFbWl0dGVkKSByZXR1cm47XG4gICAgICBpdGVyYXRpb25FbmRFbWl0dGVkID0gdHJ1ZTtcbiAgICAgIGpvdXJuYWxSZXBvcnRlci5lbWl0KFwiaXRlcmF0aW9uLWVuZFwiLCB7IGl0ZXJhdGlvbiwgLi4uZGV0YWlscyB9KTtcbiAgICB9O1xuICAgIGNvbnN0IGNvbXBsZXRlSXRlcmF0aW9uID0gKCk6IHZvaWQgPT4ge1xuICAgICAgY29tcGxldGVXb3JrZmxvd0l0ZXJhdGlvbih7XG4gICAgICAgIGdldCBjb25zZWN1dGl2ZUVycm9ycygpIHsgcmV0dXJuIGNvbnNlY3V0aXZlRXJyb3JzOyB9LFxuICAgICAgICBzZXQgY29uc2VjdXRpdmVFcnJvcnModmFsdWUpIHsgY29uc2VjdXRpdmVFcnJvcnMgPSB2YWx1ZTsgfSxcbiAgICAgICAgZ2V0IGNvbnNlY3V0aXZlQ29vbGRvd25zKCkgeyByZXR1cm4gY29uc2VjdXRpdmVDb29sZG93bnM7IH0sXG4gICAgICAgIHNldCBjb25zZWN1dGl2ZUNvb2xkb3ducyh2YWx1ZSkgeyBjb25zZWN1dGl2ZUNvb2xkb3ducyA9IHZhbHVlOyB9LFxuICAgICAgICByZWNlbnRFcnJvck1lc3NhZ2VzLFxuICAgICAgfSwge1xuICAgICAgICBlbWl0SXRlcmF0aW9uRW5kOiAoKSA9PiBlbWl0SXRlcmF0aW9uRW5kKCksXG4gICAgICAgIHNhdmVTdHVja1N0YXRlOiAoKSA9PiBzYXZlU3R1Y2tTdGF0ZShzLCBsb29wU3RhdGUpLFxuICAgICAgICBsb2dJdGVyYXRpb25Db21wbGV0ZTogKCkgPT4gZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcIml0ZXJhdGlvbi1jb21wbGV0ZVwiLCBpdGVyYXRpb24gfSksXG4gICAgICB9KTtcbiAgICB9O1xuICAgIGNvbnN0IGZpbmlzaEluY29tcGxldGVJdGVyYXRpb24gPSAoZGV0YWlsczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkID0+IHtcbiAgICAgIGVtaXRJdGVyYXRpb25FbmQoZGV0YWlscyk7XG4gICAgICBzYXZlU3R1Y2tTdGF0ZShzLCBsb29wU3RhdGUpO1xuICAgIH07XG5cbiAgICB0cnkge1xuICAgICAgLy8gXHUyNTAwXHUyNTAwIEJsYW5rZXQgdHJ5L2NhdGNoOiBvbmUgYmFkIGl0ZXJhdGlvbiBtdXN0IG5vdCBraWxsIHRoZSBzZXNzaW9uXG4gICAgICBjb25zdCBwcmVmcyA9IGRlcHMubG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzO1xuICAgICAgY29uc3QgdW9rRmxhZ3MgPSByZXNvbHZlVW9rRmxhZ3MocHJlZnMpO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgQ2hlY2sgc2lkZWNhciBxdWV1ZSBiZWZvcmUgZGVyaXZlU3RhdGUgXHUyNTAwXHUyNTAwXG4gICAgICAvLyBOT1RFOiBTaWRlY2FyIGRlcXVldWUgTVVTVCBydW4gYmVmb3JlIHZhbGlkYXRlV29ya2Zsb3dTZXNzaW9uTG9jayBzbyBhXG4gICAgICAvLyBxdWV1ZWQgaXRlbSBpcyBwb3BwZWQgKGFuZCB0aGUgYHNpZGVjYXItZGVxdWV1ZWAgam91cm5hbCBldmVudCBlbWl0dGVkKVxuICAgICAgLy8gZXZlbiB3aGVuIHRoZSBzZXNzaW9uIGxvY2sgaW52YWxpZGF0ZXMgdGhpcyBpdGVyYXRpb24uIEludmVydGluZyB0aGlzXG4gICAgICAvLyBvcmRlciBzaWxlbnRseSBkcm9wcyBxdWV1ZWQgaXRlbXMgb24gbG9jay1sb3NzLiBSZWZzICM1MzA4LlxuICAgICAgY29uc3Qgc2lkZWNhckl0ZW0gPSBhd2FpdCBkZXF1ZXVlU2lkZWNhckl0ZW0oe1xuICAgICAgICBxdWV1ZTogcy5zaWRlY2FyUXVldWUsXG4gICAgICAgIGV4ZWN1dGlvbkdyYXBoRW5hYmxlZDogdW9rRmxhZ3MuZXhlY3V0aW9uR3JhcGgsXG4gICAgICAgIHNjaGVkdWxlUXVldWU6IHNjaGVkdWxlU2lkZWNhclF1ZXVlLFxuICAgICAgICB3YXJuU2NoZWR1bGluZ0ZhaWx1cmU6IG1lc3NhZ2UgPT4gbG9nV2FybmluZyhcImRpc3BhdGNoXCIsIGBzaWRlY2FyIHF1ZXVlIHNjaGVkdWxpbmcgZmFpbGVkOiAke21lc3NhZ2V9YCksXG4gICAgICAgIGxvZ0RlcXVldWU6IHBheWxvYWQgPT4gZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7IHBoYXNlOiBcInNpZGVjYXItZGVxdWV1ZVwiLCAuLi5wYXlsb2FkIH0pLFxuICAgICAgICBlbWl0RGVxdWV1ZTogcGF5bG9hZCA9PiBqb3VybmFsUmVwb3J0ZXIuZW1pdChcInNpZGVjYXItZGVxdWV1ZVwiLCBwYXlsb2FkKSxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBzZXNzaW9uTG9ja091dGNvbWUgPSB2YWxpZGF0ZVdvcmtmbG93U2Vzc2lvbkxvY2soe1xuICAgICAgICBhY3RpdmU6IHMuYWN0aXZlLFxuICAgICAgICBpdGVyYXRpb24sXG4gICAgICAgIG1heEl0ZXJhdGlvbnM6IE1BWF9MT09QX0lURVJBVElPTlMsXG4gICAgICAgIGRlcHM6IHtcbiAgICAgICAgICBsb2NrQmFzZTogZGVwcy5sb2NrQmFzZSxcbiAgICAgICAgICB2YWxpZGF0ZVNlc3Npb25Mb2NrOiBkZXBzLnZhbGlkYXRlU2Vzc2lvbkxvY2ssXG4gICAgICAgICAgaGFuZGxlTG9zdFNlc3Npb25Mb2NrOiBsb2NrU3RhdHVzID0+IGRlcHMuaGFuZGxlTG9zdFNlc3Npb25Mb2NrKGN0eCwgbG9ja1N0YXR1cyksXG4gICAgICAgICAgbG9nSW52YWxpZFNlc3Npb25Mb2NrOiBkZXRhaWxzID0+IGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICAgICAgcGhhc2U6IFwic2Vzc2lvbi1sb2NrLWludmFsaWRcIixcbiAgICAgICAgICAgIC4uLmRldGFpbHMsXG4gICAgICAgICAgfSksXG4gICAgICAgICAgbG9nU2Vzc2lvbkxvY2tFeGl0OiBkZXRhaWxzID0+IGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICAgICAgcGhhc2U6IFwiZXhpdFwiLFxuICAgICAgICAgICAgLi4uZGV0YWlscyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuICAgICAgaWYgKHNlc3Npb25Mb2NrT3V0Y29tZS5hY3Rpb24gPT09IFwic3RvcFwiICYmIHNlc3Npb25Mb2NrT3V0Y29tZS5yZWFzb24gPT09IFwic2Vzc2lvbi1sb2NrLWxvc3RcIikge1xuICAgICAgICBmaW5pc2hUdXJuKFwic3RvcHBlZFwiLCBcIm1hbnVhbC1hdHRlbnRpb25cIiwgc2Vzc2lvbkxvY2tPdXRjb21lLnJlYXNvbik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBpYzogSXRlcmF0aW9uQ29udGV4dCA9IHsgY3R4LCBwaSwgcywgZGVwcywgcHJlZnMsIGl0ZXJhdGlvbiwgZmxvd0lkLCBuZXh0U2VxIH07XG4gICAgICBqb3VybmFsUmVwb3J0ZXIuZW1pdChcIml0ZXJhdGlvbi1zdGFydFwiLCB7IGl0ZXJhdGlvbiB9KTtcbiAgICAgIGxldCBpdGVyRGF0YTogSXRlcmF0aW9uRGF0YTtcblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIEN1c3RvbSBlbmdpbmUgcGF0aCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIC8vIFdoZW4gYWN0aXZlRW5naW5lSWQgaXMgYSBub24tZGV2IHZhbHVlLCBieXBhc3MgcnVuUHJlRGlzcGF0Y2ggYW5kXG4gICAgICAvLyBydW5EaXNwYXRjaCBlbnRpcmVseSBcdTIwMTQgdGhlIGN1c3RvbSBlbmdpbmUgZHJpdmVzIGl0cyBvd24gc3RhdGUgdmlhXG4gICAgICAvLyBHUkFQSC55YW1sLiBTaGFyZXMgcnVuR3VhcmRzIGFuZCBydW5Vbml0UGhhc2Ugd2l0aCB0aGUgZGV2IHBhdGguXG4gICAgICAvLyBBZnRlciB1bml0IGV4ZWN1dGlvbiwgdmVyaWZpZXMgdGhlbiByZWNvbmNpbGVzIHZpYSB0aGUgZW5naW5lIGxheWVyLlxuICAgICAgLy9cbiAgICAgIC8vIEdTRF9FTkdJTkVfQllQQVNTPTEgc2tpcHMgdGhlIGVuZ2luZSBsYXllciBlbnRpcmVseSBcdTIwMTQgZmFsbHMgdGhyb3VnaFxuICAgICAgLy8gdG8gdGhlIGRldiBwYXRoIGJlbG93LlxuICAgICAgaWYgKHNob3VsZFVzZUN1c3RvbUVuZ2luZVBhdGgoe1xuICAgICAgICBhY3RpdmVFbmdpbmVJZDogcy5hY3RpdmVFbmdpbmVJZCxcbiAgICAgICAgaGFzU2lkZWNhckl0ZW06IEJvb2xlYW4oc2lkZWNhckl0ZW0pLFxuICAgICAgICBlbmdpbmVCeXBhc3M6IHByb2Nlc3MuZW52LkdTRF9FTkdJTkVfQllQQVNTID09PSBcIjFcIixcbiAgICAgIH0pKSB7XG4gICAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJjdXN0b20tZW5naW5lLWRlcml2ZVwiLCBpdGVyYXRpb24sIGVuZ2luZUlkOiBzLmFjdGl2ZUVuZ2luZUlkIH0pO1xuXG4gICAgICAgIGNvbnN0IHsgZW5naW5lLCBwb2xpY3kgfSA9IHJlc29sdmVFbmdpbmUoe1xuICAgICAgICAgIGFjdGl2ZUVuZ2luZUlkOiBzLmFjdGl2ZUVuZ2luZUlkLFxuICAgICAgICAgIGFjdGl2ZVJ1bkRpcjogcy5hY3RpdmVSdW5EaXIsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGNvbnN0IGVuZ2luZVN0YXRlID0gYXdhaXQgZW5naW5lLmRlcml2ZVN0YXRlKHMuY2Fub25pY2FsUHJvamVjdFJvb3QpO1xuICAgICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICAgICAgICBwaGFzZTogXCJwb3N0LWRlcml2ZVwiLFxuICAgICAgICAgIHNpdGU6IFwiY3VzdG9tLWVuZ2luZS1kZXJpdmVcIixcbiAgICAgICAgICBiYXNlUGF0aDogcy5iYXNlUGF0aCxcbiAgICAgICAgICBvcmlnaW5hbEJhc2VQYXRoOiBzLm9yaWdpbmFsQmFzZVBhdGgsXG4gICAgICAgICAgc2NvcGVQcm9qZWN0Um9vdDogcy5zY29wZT8ud29ya3NwYWNlLnByb2plY3RSb290LFxuICAgICAgICAgIGNhbm9uaWNhbFByb2plY3RSb290OiBzLmNhbm9uaWNhbFByb2plY3RSb290LFxuICAgICAgICAgIGRlcml2ZWRQaGFzZTogKGVuZ2luZVN0YXRlIGFzIHsgcGhhc2U/OiBzdHJpbmcgfSkucGhhc2UsXG4gICAgICAgICAgaXNDb21wbGV0ZTogZW5naW5lU3RhdGUuaXNDb21wbGV0ZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChlbmdpbmVTdGF0ZS5pc0NvbXBsZXRlKSB7XG4gICAgICAgICAgZmluaXNoVHVybihcImNvbXBsZXRlZFwiKTtcbiAgICAgICAgICBlbWl0SXRlcmF0aW9uRW5kKHsgc3RhdHVzOiBcImNvbXBsZXRlZFwiLCByZWFzb246IFwiY3VzdG9tLWVuZ2luZS1jb21wbGV0ZVwiIH0pO1xuICAgICAgICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgXCJXb3JrZmxvdyBjb21wbGV0ZVwiKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuXG4gICAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJjdXN0b20tZW5naW5lLWRpc3BhdGNoXCIsIGl0ZXJhdGlvbiB9KTtcbiAgICAgICAgY29uc3QgZGlzcGF0Y2ggPSBhd2FpdCBlbmdpbmUucmVzb2x2ZURpc3BhdGNoKGVuZ2luZVN0YXRlLCB7IGJhc2VQYXRoOiBzLmJhc2VQYXRoIH0pO1xuICAgICAgICBjb25zdCBlbmdpbmVEaXNwYXRjaERlY2lzaW9uID0gZGVjaWRlRW5naW5lRGlzcGF0Y2goZGlzcGF0Y2guYWN0aW9uID09PSBcInN0b3BcIlxuICAgICAgICAgID8geyBhY3Rpb246IFwic3RvcFwiLCByZWFzb246IGRpc3BhdGNoLnJlYXNvbiB9XG4gICAgICAgICAgOiB7IGFjdGlvbjogZGlzcGF0Y2guYWN0aW9uIH0pO1xuICAgICAgICBjb25zdCBkaXNwYXRjaEZsb3cgPSBhd2FpdCBoYW5kbGVDdXN0b21FbmdpbmVEaXNwYXRjaE91dGNvbWUoe1xuICAgICAgICAgIGRlY2lzaW9uOiBlbmdpbmVEaXNwYXRjaERlY2lzaW9uLFxuICAgICAgICAgIGRlcHM6IHtcbiAgICAgICAgICAgIHN0b3BBdXRvOiByZWFzb24gPT4gZGVwcy5zdG9wQXV0byhjdHgsIHBpLCByZWFzb24pLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoZGlzcGF0Y2hGbG93LmFjdGlvbiA9PT0gXCJicmVha1wiKSB7XG4gICAgICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJtYW51YWwtYXR0ZW50aW9uXCIsIFwiY3VzdG9tLWVuZ2luZS1kaXNwYXRjaC1zdG9wXCIpO1xuICAgICAgICAgIGZpbmlzaEluY29tcGxldGVJdGVyYXRpb24oe1xuICAgICAgICAgICAgc3RhdHVzOiBcInN0b3BwZWRcIixcbiAgICAgICAgICAgIHJlYXNvbjogXCJjdXN0b20tZW5naW5lLWRpc3BhdGNoLXN0b3BcIixcbiAgICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJtYW51YWwtYXR0ZW50aW9uXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGRpc3BhdGNoRmxvdy5hY3Rpb24gPT09IFwiY29udGludWVcIikge1xuICAgICAgICAgIGZpbmlzaFR1cm4oXCJza2lwcGVkXCIpO1xuICAgICAgICAgIGVtaXRJdGVyYXRpb25FbmQoeyBzdGF0dXM6IFwic2tpcHBlZFwiLCByZWFzb246IFwiY3VzdG9tLWVuZ2luZS1kaXNwYXRjaC1za2lwXCIgfSk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBkaXNwYXRjaC5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIlxuICAgICAgICBpZiAoZGlzcGF0Y2guYWN0aW9uICE9PSBcImRpc3BhdGNoXCIpIHtcbiAgICAgICAgICBmaW5pc2hUdXJuKFwic2tpcHBlZFwiKTtcbiAgICAgICAgICBlbWl0SXRlcmF0aW9uRW5kKHsgc3RhdHVzOiBcInNraXBwZWRcIiwgcmVhc29uOiBcImN1c3RvbS1lbmdpbmUtZGlzcGF0Y2gtbWlzbWF0Y2hcIiB9KTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzdGVwID0gZGlzcGF0Y2guc3RlcDtcbiAgICAgICAgaXRlckRhdGEgPSBhd2FpdCBidWlsZEN1c3RvbUVuZ2luZUl0ZXJhdGlvbkRhdGEoe1xuICAgICAgICAgIHN0ZXAsXG4gICAgICAgICAgYmFzZVBhdGg6IHMuYmFzZVBhdGgsXG4gICAgICAgICAgY2Fub25pY2FsUHJvamVjdFJvb3Q6IHMuY2Fub25pY2FsUHJvamVjdFJvb3QsXG4gICAgICAgICAgY3VycmVudE1pbGVzdG9uZUlkOiBzLmN1cnJlbnRNaWxlc3RvbmVJZCxcbiAgICAgICAgICBkZXJpdmVTdGF0ZTogZGVwcy5kZXJpdmVTdGF0ZSxcbiAgICAgICAgICBsb2dQb3N0RGVyaXZlOiBkZXRhaWxzID0+IGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICAgICAgcGhhc2U6IFwicG9zdC1kZXJpdmVcIixcbiAgICAgICAgICAgIC4uLmRldGFpbHMsXG4gICAgICAgICAgfSksXG4gICAgICAgIH0pO1xuICAgICAgICBvYnNlcnZlZFVuaXRUeXBlID0gaXRlckRhdGEudW5pdFR5cGU7XG4gICAgICAgIG9ic2VydmVkVW5pdElkID0gaXRlckRhdGEudW5pdElkO1xuXG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCBQcm9ncmVzcyB3aWRnZXQgKG1pcnJvcnMgZGV2IHBhdGggaW4gcnVuRGlzcGF0Y2gpIFx1MjUwMFx1MjUwMFxuICAgICAgICBkZXBzLnVwZGF0ZVByb2dyZXNzV2lkZ2V0KGN0eCwgaXRlckRhdGEudW5pdFR5cGUsIGl0ZXJEYXRhLnVuaXRJZCwgaXRlckRhdGEuc3RhdGUpO1xuXG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCBHdWFyZHMgKHNoYXJlZCB3aXRoIGRldiBwYXRoKSBcdTI1MDBcdTI1MDBcbiAgICAgICAgY29uc3QgZ3VhcmRzUmVzdWx0ID0gYXdhaXQgcnVuR3VhcmRzKGljLCBzLmN1cnJlbnRNaWxlc3RvbmVJZCA/PyBcIndvcmtmbG93XCIpO1xuICAgICAgICBwaGFzZVJlcG9ydGVyLnJlcG9ydChcImd1YXJkXCIsIGd1YXJkc1Jlc3VsdC5hY3Rpb24sIHtcbiAgICAgICAgICB1bml0VHlwZTogaXRlckRhdGEudW5pdFR5cGUsXG4gICAgICAgICAgdW5pdElkOiBpdGVyRGF0YS51bml0SWQsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoZ3VhcmRzUmVzdWx0LmFjdGlvbiA9PT0gXCJicmVha1wiKSB7XG4gICAgICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJtYW51YWwtYXR0ZW50aW9uXCIsIFwiZ3VhcmQtYnJlYWtcIik7XG4gICAgICAgICAgZmluaXNoSW5jb21wbGV0ZUl0ZXJhdGlvbih7XG4gICAgICAgICAgICBzdGF0dXM6IFwic3RvcHBlZFwiLFxuICAgICAgICAgICAgcmVhc29uOiBcImd1YXJkLWJyZWFrXCIsXG4gICAgICAgICAgICB1bml0VHlwZTogaXRlckRhdGEudW5pdFR5cGUsXG4gICAgICAgICAgICB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCxcbiAgICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJtYW51YWwtYXR0ZW50aW9uXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgVW5pdCBleGVjdXRpb24gKHNoYXJlZCB3aXRoIGRldiBwYXRoKSBcdTI1MDBcdTI1MDBcbiAgICAgICAgYXdhaXQgZW5mb3JjZU1pblJlcXVlc3RJbnRlcnZhbChzLCBwcmVmcyk7XG4gICAgICAgIGxldCB1bml0UGhhc2VSZXN1bHQ6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcnVuVW5pdFBoYXNlVmlhQ29udHJhY3Q+PjtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB1bml0UGhhc2VSZXN1bHQgPSBhd2FpdCBydW5Vbml0UGhhc2VWaWFDb250cmFjdChcbiAgICAgICAgICAgIGRpc3BhdGNoQ29udHJhY3QsXG4gICAgICAgICAgICBpYyxcbiAgICAgICAgICAgIGl0ZXJEYXRhLFxuICAgICAgICAgICAgbG9vcFN0YXRlLFxuICAgICAgICAgICAgdW5kZWZpbmVkLFxuICAgICAgICAgICAgdW5pdERpc3BhdGNoRGVwcyxcbiAgICAgICAgICApO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvcikge1xuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjbG9zZU91dENyYXNoZWRVbml0KHMsIGl0ZXJEYXRhLCBlcnIpO1xuICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfVxuICAgICAgICBpZiAodW5pdFBoYXNlUmVzdWx0LmFjdGlvbiA9PT0gXCJuZXh0XCIpIHtcbiAgICAgICAgICBjb25zdCByZXF1ZXN0VGltZXN0YW1wID0gcmVzb2x2ZVVuaXRSZXF1ZXN0VGltZXN0YW1wKHVuaXRQaGFzZVJlc3VsdC5kYXRhKTtcbiAgICAgICAgICBpZiAocmVxdWVzdFRpbWVzdGFtcCAhPT0gdW5kZWZpbmVkKSBzLmxhc3RSZXF1ZXN0VGltZXN0YW1wID0gcmVxdWVzdFRpbWVzdGFtcDtcbiAgICAgICAgfVxuICAgICAgICBwaGFzZVJlcG9ydGVyLnJlcG9ydChcInVuaXRcIiwgdW5pdFBoYXNlUmVzdWx0LmFjdGlvbiwge1xuICAgICAgICAgIHVuaXRUeXBlOiBpdGVyRGF0YS51bml0VHlwZSxcbiAgICAgICAgICB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCxcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICh1bml0UGhhc2VSZXN1bHQuYWN0aW9uID09PSBcImJyZWFrXCIpIHtcbiAgICAgICAgICBmaW5pc2hJbmNvbXBsZXRlSXRlcmF0aW9uKHtcbiAgICAgICAgICAgIHN0YXR1czogXCJzdG9wcGVkXCIsXG4gICAgICAgICAgICByZWFzb246IHVuaXRQaGFzZVJlc3VsdC5yZWFzb24gPz8gXCJ1bml0LWJyZWFrXCIsXG4gICAgICAgICAgICB1bml0VHlwZTogaXRlckRhdGEudW5pdFR5cGUsXG4gICAgICAgICAgICB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCxcbiAgICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJleGVjdXRpb25cIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBmaW5pc2hUdXJuKFwic3RvcHBlZFwiLCBcImV4ZWN1dGlvblwiLCBcInVuaXQtYnJlYWtcIik7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgVmVyaWZ5IGZpcnN0LCB0aGVuIHJlY29uY2lsZSAob25seSBtYXJrIGNvbXBsZXRlIG9uIHBhc3MpIFx1MjUwMFx1MjUwMFxuICAgICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHsgcGhhc2U6IFwiY3VzdG9tLWVuZ2luZS12ZXJpZnlcIiwgaXRlcmF0aW9uLCB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCB9KTtcbiAgICAgICAgY29uc3QgdmVyaWZ5UmVzdWx0ID0gYXdhaXQgcG9saWN5LnZlcmlmeShpdGVyRGF0YS51bml0VHlwZSwgaXRlckRhdGEudW5pdElkLCB7IGJhc2VQYXRoOiBzLmJhc2VQYXRoIH0pO1xuICAgICAgICBpZiAodmVyaWZ5UmVzdWx0ID09PSBcInBhdXNlXCIpIHtcbiAgICAgICAgICBjb25zdCB2ZXJpZnlGbG93ID0gYXdhaXQgaGFuZGxlQ3VzdG9tRW5naW5lVmVyaWZ5UGF1c2Uoe1xuICAgICAgICAgICAgdW5pdFR5cGU6IGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgICAgICAgdW5pdElkOiBpdGVyRGF0YS51bml0SWQsXG4gICAgICAgICAgICBkZXBzOiB7XG4gICAgICAgICAgICAgIHBhdXNlQXV0bzogKCkgPT4gZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSksXG4gICAgICAgICAgICAgIHN0b3BBdXRvOiByZWFzb24gPT4gZGVwcy5zdG9wQXV0byhjdHgsIHBpLCByZWFzb24pLFxuICAgICAgICAgICAgICByZXBvcnRQYXVzZTogZGV0YWlscyA9PiBwaGFzZVJlcG9ydGVyLnJlcG9ydChcImN1c3RvbS1lbmdpbmVcIiwgXCJwYXVzZVwiLCBkZXRhaWxzKSxcbiAgICAgICAgICAgICAgZmluaXNoVHVybixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgaWYgKHZlcmlmeUZsb3cuYWN0aW9uID09PSBcImJyZWFrXCIpIHtcbiAgICAgICAgICAgIGZpbmlzaEluY29tcGxldGVJdGVyYXRpb24oe1xuICAgICAgICAgICAgICBzdGF0dXM6IFwicGF1c2VkXCIsXG4gICAgICAgICAgICAgIHJlYXNvbjogXCJjdXN0b20tZW5naW5lLXZlcmlmeS1wYXVzZVwiLFxuICAgICAgICAgICAgICB1bml0VHlwZTogaXRlckRhdGEudW5pdFR5cGUsXG4gICAgICAgICAgICAgIHVuaXRJZDogaXRlckRhdGEudW5pdElkLFxuICAgICAgICAgICAgICBmYWlsdXJlQ2xhc3M6IFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHZlcmlmeVJlc3VsdCA9PT0gXCJyZXRyeVwiKSB7XG4gICAgICAgICAgY29uc3QgcmV0cnlPdXRjb21lID0gYXdhaXQgaGFuZGxlQ3VzdG9tRW5naW5lVmVyaWZ5UmV0cnkoe1xuICAgICAgICAgICAgc2Vzc2lvbjogcyxcbiAgICAgICAgICAgIHVuaXRUeXBlOiBpdGVyRGF0YS51bml0VHlwZSxcbiAgICAgICAgICAgIHVuaXRJZDogaXRlckRhdGEudW5pdElkLFxuICAgICAgICAgICAgYmFzZVBhdGg6IHMuYmFzZVBhdGgsXG4gICAgICAgICAgICBpdGVyYXRpb24sXG4gICAgICAgICAgICBtYXhSZXRyaWVzOiBNQVhfQ1VTVE9NX0VOR0lORV9WRVJJRllfUkVUUklFUyxcbiAgICAgICAgICAgIGRlcHM6IHtcbiAgICAgICAgICAgICAgaHlkcmF0ZVJldHJ5Q291bnRzOiAoKSA9PiBoeWRyYXRlQ3VzdG9tVmVyaWZ5UmV0cnlDb3VudHMocywge1xuICAgICAgICAgICAgICAgIGxvZ0ZhaWx1cmU6IGxvZ0N1c3RvbVZlcmlmeVJldHJ5TG9hZEZhaWx1cmUsXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICBzYXZlUmV0cnlDb3VudHM6ICgpID0+IHNhdmVDdXN0b21WZXJpZnlSZXRyeUNvdW50cyhzLCB7XG4gICAgICAgICAgICAgICAgbG9nRmFpbHVyZTogbG9nQ3VzdG9tVmVyaWZ5UmV0cnlTYXZlRmFpbHVyZSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICAgIHJlY292ZXI6ICh1bml0VHlwZSwgdW5pdElkLCBvcHRpb25zKSA9PiBwb2xpY3kucmVjb3Zlcih1bml0VHlwZSwgdW5pdElkLCBvcHRpb25zKSxcbiAgICAgICAgICAgICAgbG9nUmV0cnk6IGRldGFpbHMgPT4gZGVidWdMb2coXCJhdXRvTG9vcFwiLCB7XG4gICAgICAgICAgICAgICAgcGhhc2U6IFwiY3VzdG9tLWVuZ2luZS12ZXJpZnktcmV0cnlcIixcbiAgICAgICAgICAgICAgICAuLi5kZXRhaWxzLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICAgcmVwb3J0UmV0cnk6IGRldGFpbHMgPT4gcGhhc2VSZXBvcnRlci5yZXBvcnQoXCJjdXN0b20tZW5naW5lXCIsIFwicmV0cnlcIiwgZGV0YWlscyksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGNvbnN0IHJldHJ5RmxvdyA9IGF3YWl0IGhhbmRsZUN1c3RvbUVuZ2luZVZlcmlmeVJldHJ5T3V0Y29tZSh7XG4gICAgICAgICAgICBvdXRjb21lOiByZXRyeU91dGNvbWUsXG4gICAgICAgICAgICBkZXBzOiB7XG4gICAgICAgICAgICAgIHBhdXNlQXV0bzogKCkgPT4gZGVwcy5wYXVzZUF1dG8oY3R4LCBwaSksXG4gICAgICAgICAgICAgIHN0b3BBdXRvOiByZWFzb24gPT4gZGVwcy5zdG9wQXV0byhjdHgsIHBpLCByZWFzb24pLFxuICAgICAgICAgICAgICByZXBvcnRQYXVzZTogZGV0YWlscyA9PiBwaGFzZVJlcG9ydGVyLnJlcG9ydChcImN1c3RvbS1lbmdpbmVcIiwgXCJwYXVzZVwiLCBkZXRhaWxzKSxcbiAgICAgICAgICAgICAgZmluaXNoVHVybixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgaWYgKHJldHJ5Rmxvdy5hY3Rpb24gPT09IFwiYnJlYWtcIikge1xuICAgICAgICAgICAgZmluaXNoSW5jb21wbGV0ZUl0ZXJhdGlvbih7XG4gICAgICAgICAgICAgIHN0YXR1czogcmV0cnlPdXRjb21lLmFjdGlvbiA9PT0gXCJzdG9wXCIgPyBcInN0b3BwZWRcIiA6IFwicGF1c2VkXCIsXG4gICAgICAgICAgICAgIHJlYXNvbjogcmV0cnlPdXRjb21lLmFjdGlvbiA9PT0gXCJyZXRyeVwiID8gXCJjdXN0b20tZW5naW5lLXZlcmlmeS1yZXRyeVwiIDogcmV0cnlPdXRjb21lLnR1cm5FcnJvcixcbiAgICAgICAgICAgICAgdW5pdFR5cGU6IGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgICAgICAgICB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCxcbiAgICAgICAgICAgICAgZmFpbHVyZUNsYXNzOiBcIm1hbnVhbC1hdHRlbnRpb25cIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGZpbmlzaEluY29tcGxldGVJdGVyYXRpb24oe1xuICAgICAgICAgICAgc3RhdHVzOiBcInJldHJ5XCIsXG4gICAgICAgICAgICByZWFzb246IFwiY3VzdG9tLWVuZ2luZS12ZXJpZnktcmV0cnlcIixcbiAgICAgICAgICAgIHVuaXRUeXBlOiBpdGVyRGF0YS51bml0VHlwZSxcbiAgICAgICAgICAgIHVuaXRJZDogaXRlckRhdGEudW5pdElkLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gVmVyaWZpY2F0aW9uIHBhc3NlZCBcdTIwMTQgbWFyayBzdGVwIGNvbXBsZXRlXG4gICAgICAgIGNvbnN0IHJlY29uY2lsZU91dGNvbWUgPSBhd2FpdCBoYW5kbGVDdXN0b21FbmdpbmVSZWNvbmNpbGUoe1xuICAgICAgICAgIHNlc3Npb246IHMsXG4gICAgICAgICAgZW5naW5lU3RhdGUsXG4gICAgICAgICAgaXRlckRhdGEsXG4gICAgICAgICAgaXRlcmF0aW9uLFxuICAgICAgICAgIGRlcHM6IHtcbiAgICAgICAgICAgIHNhdmVSZXRyeUNvdW50czogKCkgPT4gc2F2ZUN1c3RvbVZlcmlmeVJldHJ5Q291bnRzKHMsIHtcbiAgICAgICAgICAgICAgbG9nRmFpbHVyZTogbG9nQ3VzdG9tVmVyaWZ5UmV0cnlTYXZlRmFpbHVyZSxcbiAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgbG9nUmVjb25jaWxlOiBkZXRhaWxzID0+IGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICAgICAgICBwaGFzZTogXCJjdXN0b20tZW5naW5lLXJlY29uY2lsZVwiLFxuICAgICAgICAgICAgICAuLi5kZXRhaWxzLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgICByZWNvbmNpbGU6IChzdGF0ZSwgY29tcGxldGVkU3RlcCkgPT4gZW5naW5lLnJlY29uY2lsZShzdGF0ZSwgY29tcGxldGVkU3RlcCksXG4gICAgICAgICAgICBub3c6ICgpID0+IERhdGUubm93KCksXG4gICAgICAgICAgICBjbGVhclVuaXRUaW1lb3V0OiBkZXBzLmNsZWFyVW5pdFRpbWVvdXQsXG4gICAgICAgICAgICBjb21wbGV0ZUl0ZXJhdGlvbixcbiAgICAgICAgICB9LFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgcmVjb25jaWxlRmxvdyA9IGF3YWl0IGhhbmRsZUN1c3RvbUVuZ2luZVJlY29uY2lsZU91dGNvbWUoe1xuICAgICAgICAgIG91dGNvbWU6IHJlY29uY2lsZU91dGNvbWUsXG4gICAgICAgICAgdW5pdFR5cGU6IGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZDogaXRlckRhdGEudW5pdElkLFxuICAgICAgICAgIGRlcHM6IHtcbiAgICAgICAgICAgIHN0b3BBdXRvOiByZWFzb24gPT4gZGVwcy5zdG9wQXV0byhjdHgsIHBpLCByZWFzb24pLFxuICAgICAgICAgICAgcGF1c2VBdXRvOiAoKSA9PiBkZXBzLnBhdXNlQXV0byhjdHgsIHBpKSxcbiAgICAgICAgICAgIHJlcG9ydDogKGFjdGlvbiwgZGV0YWlscykgPT4gcGhhc2VSZXBvcnRlci5yZXBvcnQoXCJjdXN0b20tZW5naW5lXCIsIGFjdGlvbiwgZGV0YWlscyksXG4gICAgICAgICAgICBmaW5pc2hUdXJuLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAocmVjb25jaWxlRmxvdy5hY3Rpb24gPT09IFwiYnJlYWtcIikgYnJlYWs7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICBpZiAoIXNpZGVjYXJJdGVtKSB7XG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCBQaGFzZSAxOiBQcmUtZGlzcGF0Y2ggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAgIGNvbnN0IHByZURpc3BhdGNoUmVzdWx0ID0gYXdhaXQgcnVuUHJlRGlzcGF0Y2goaWMsIGxvb3BTdGF0ZSk7XG4gICAgICAgIHBoYXNlUmVwb3J0ZXIucmVwb3J0KFwicHJlLWRpc3BhdGNoXCIsIHByZURpc3BhdGNoUmVzdWx0LmFjdGlvbik7XG4gICAgICAgIGlmIChwcmVEaXNwYXRjaFJlc3VsdC5hY3Rpb24gPT09IFwiYnJlYWtcIikge1xuICAgICAgICAgIGZpbmlzaFR1cm4oXCJzdG9wcGVkXCIsIFwibWFudWFsLWF0dGVudGlvblwiLCBcInByZS1kaXNwYXRjaC1icmVha1wiKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICBpZiAocHJlRGlzcGF0Y2hSZXN1bHQuYWN0aW9uID09PSBcImNvbnRpbnVlXCIpIHtcbiAgICAgICAgICBmaW5pc2hUdXJuKFwic2tpcHBlZFwiKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHByZURhdGEgPSBwcmVEaXNwYXRjaFJlc3VsdC5kYXRhO1xuXG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCBQaGFzZSAyOiBHdWFyZHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAgIGNvbnN0IGd1YXJkc1Jlc3VsdCA9IGF3YWl0IHJ1bkd1YXJkcyhpYywgcHJlRGF0YS5taWQpO1xuICAgICAgICBwaGFzZVJlcG9ydGVyLnJlcG9ydChcImd1YXJkXCIsIGd1YXJkc1Jlc3VsdC5hY3Rpb24pO1xuICAgICAgICBpZiAoZ3VhcmRzUmVzdWx0LmFjdGlvbiA9PT0gXCJicmVha1wiKSB7XG4gICAgICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJtYW51YWwtYXR0ZW50aW9uXCIsIFwiZ3VhcmQtYnJlYWtcIik7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgUGhhc2UgMzogRGlzcGF0Y2ggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAgIGNvbnN0IGRpc3BhdGNoUmVzdWx0ID0gYXdhaXQgcnVuRGlzcGF0Y2goaWMsIHByZURhdGEsIGxvb3BTdGF0ZSk7XG4gICAgICAgIHBoYXNlUmVwb3J0ZXIucmVwb3J0KFwiZGlzcGF0Y2hcIiwgZGlzcGF0Y2hSZXN1bHQuYWN0aW9uKTtcbiAgICAgICAgaWYgKGRpc3BhdGNoUmVzdWx0LmFjdGlvbiA9PT0gXCJicmVha1wiKSB7XG4gICAgICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJtYW51YWwtYXR0ZW50aW9uXCIsIFwiZGlzcGF0Y2gtYnJlYWtcIik7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGRpc3BhdGNoUmVzdWx0LmFjdGlvbiA9PT0gXCJjb250aW51ZVwiKSB7XG4gICAgICAgICAgZmluaXNoVHVybihcInNraXBwZWRcIik7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaXRlckRhdGEgPSBkaXNwYXRjaFJlc3VsdC5kYXRhO1xuICAgICAgICBvYnNlcnZlZFVuaXRUeXBlID0gaXRlckRhdGEudW5pdFR5cGU7XG4gICAgICAgIG9ic2VydmVkVW5pdElkID0gaXRlckRhdGEudW5pdElkO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaXRlckRhdGEgPSBhd2FpdCBidWlsZFNpZGVjYXJJdGVyYXRpb25EYXRhKHtcbiAgICAgICAgICBzaWRlY2FySXRlbSxcbiAgICAgICAgICBiYXNlUGF0aDogcy5iYXNlUGF0aCxcbiAgICAgICAgICBjYW5vbmljYWxQcm9qZWN0Um9vdDogcy5jYW5vbmljYWxQcm9qZWN0Um9vdCxcbiAgICAgICAgICBkZXJpdmVTdGF0ZTogZGVwcy5kZXJpdmVTdGF0ZSxcbiAgICAgICAgICBsb2dQb3N0RGVyaXZlOiBkZXRhaWxzID0+IGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICAgICAgcGhhc2U6IFwicG9zdC1kZXJpdmVcIixcbiAgICAgICAgICAgIC4uLmRldGFpbHMsXG4gICAgICAgICAgfSksXG4gICAgICAgIH0pO1xuICAgICAgICBvYnNlcnZlZFVuaXRUeXBlID0gaXRlckRhdGEudW5pdFR5cGU7XG4gICAgICAgIG9ic2VydmVkVW5pdElkID0gaXRlckRhdGEudW5pdElkO1xuICAgICAgICBwaGFzZVJlcG9ydGVyLnJlcG9ydChcImRpc3BhdGNoXCIsIFwic2lkZWNhclwiLCB7XG4gICAgICAgICAgdW5pdFR5cGU6IGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZDogaXRlckRhdGEudW5pdElkLFxuICAgICAgICAgIHNpZGVjYXJLaW5kOiBzaWRlY2FySXRlbS5raW5kLFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgYXdhaXQgZW5mb3JjZU1pblJlcXVlc3RJbnRlcnZhbChzLCBwcmVmcyk7XG5cbiAgICAgIC8vIFBoYXNlIEI6IGNsYWltIGEgdW5pdF9kaXNwYXRjaGVzIHJvdyBiZWZvcmUgaW52b2tpbmcgdGhlIHVuaXQuIFRoZVxuICAgICAgLy8gcGFydGlhbCB1bmlxdWUgaW5kZXggaWR4X3VuaXRfZGlzcGF0Y2hlc19hY3RpdmVfcGVyX3VuaXQgcHJldmVudHNcbiAgICAgIC8vIGEgc2Vjb25kIHdvcmtlciBmcm9tIGNsYWltaW5nIHRoZSBzYW1lIHVuaXQgY29uY3VycmVudGx5LiBXaGVuIHRoaXNcbiAgICAgIC8vIHByb2Nlc3MgaGFzIGEgd29ya2VyIGlkZW50aXR5LCBtYWtlIHRoZSBtaWxlc3RvbmUgbGVhc2UgZXhwbGljaXQgYmVmb3JlXG4gICAgICAvLyBjbGFpbWluZyBzbyBhIHN0ZXAtbW9kZSBoYW5kb2ZmIGNhbm5vdCBsZWF2ZSB1cyBydW5uaW5nIHdpdGggYSBzdGFsZVxuICAgICAgLy8gaW4tbWVtb3J5IHRva2VuIGFuZCBubyBiYWNraW5nIGxlYXNlIHJvdy5cbiAgICAgIGNvbnN0IGxlYXNlQmVmb3JlQ2xhaW0gPSBlbnN1cmVEaXNwYXRjaExlYXNlKHMsIGl0ZXJEYXRhLm1pZCwge1xuICAgICAgICBjbGFpbU1pbGVzdG9uZUxlYXNlLFxuICAgICAgICBsb2dMZWFzZVJlY292ZXJlZDogbG9nRGlzcGF0Y2hMZWFzZVJlY292ZXJlZCxcbiAgICAgICAgbG9nTGVhc2VSZWNvdmVyeUZhaWxlZDogbG9nRGlzcGF0Y2hMZWFzZVJlY292ZXJ5RmFpbGVkLFxuICAgICAgfSk7XG4gICAgICBpZiAobGVhc2VCZWZvcmVDbGFpbS5raW5kID09PSBcImJsb2NrZWRcIiB8fCBsZWFzZUJlZm9yZUNsYWltLmtpbmQgPT09IFwiZmFpbGVkXCIpIHtcbiAgICAgICAgY29uc3QgbXNnID0gYExvc3QgbWlsZXN0b25lIGxlYXNlIGZvciAke2l0ZXJEYXRhLm1pZCA/PyBcInVua25vd25cIn0gYmVmb3JlIGRpc3BhdGNoaW5nICR7aXRlckRhdGEudW5pdFR5cGV9ICR7aXRlckRhdGEudW5pdElkfTogJHtsZWFzZUJlZm9yZUNsYWltLnJlYXNvbn1gO1xuICAgICAgICBjdHgudWkubm90aWZ5KG1zZywgXCJlcnJvclwiKTtcbiAgICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJleGVjdXRpb25cIiwgbXNnKTtcbiAgICAgICAgYXdhaXQgZGVwcy5zdG9wQXV0byhjdHgsIHBpLCBtc2cpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgbGV0IGRpc3BhdGNoQ2xhaW0gPSBvcGVuRGlzcGF0Y2hDbGFpbShzLCBmbG93SWQsIHR1cm5JZCwgaXRlckRhdGEsIHtcbiAgICAgICAgZ2V0UmVjZW50RGlzcGF0Y2hlc0ZvclVuaXQsXG4gICAgICAgIHJlY29yZERpc3BhdGNoQ2xhaW0sXG4gICAgICAgIG1hcmtEaXNwYXRjaFJ1bm5pbmcsXG4gICAgICAgIGxvZ0NsYWltUmVqZWN0ZWQ6IGxvZ0Rpc3BhdGNoQ2xhaW1SZWplY3RlZCxcbiAgICAgICAgbG9nQ2xhaW1GYWlsZWQ6IGxvZ0Rpc3BhdGNoQ2xhaW1GYWlsZWQsXG4gICAgICB9KTtcbiAgICAgIGxldCBkaXNwYXRjaERlY2lzaW9uID0gZGVjaWRlRGlzcGF0Y2hDbGFpbShcbiAgICAgICAgZGlzcGF0Y2hDbGFpbS5raW5kID09PSBcIm9wZW5lZFwiXG4gICAgICAgICAgPyB7IGtpbmQ6IFwib3BlbmVkXCIsIGRpc3BhdGNoSWQ6IGRpc3BhdGNoQ2xhaW0uZGlzcGF0Y2hJZCB9XG4gICAgICAgICAgOiBkaXNwYXRjaENsYWltLmtpbmQgPT09IFwic2tpcFwiXG4gICAgICAgICAgICA/IHsga2luZDogXCJza2lwXCIsIHJlYXNvbjogZGlzcGF0Y2hDbGFpbS5yZWFzb24gfVxuICAgICAgICAgICAgOiB7IGtpbmQ6IFwiZGVncmFkZWRcIiB9LFxuICAgICAgKTtcbiAgICAgIGlmIChkaXNwYXRjaERlY2lzaW9uLmFjdGlvbiA9PT0gXCJza2lwXCIgJiYgZGlzcGF0Y2hEZWNpc2lvbi5yZWFzb24gPT09IFwic3RhbGUtbGVhc2VcIikge1xuICAgICAgICBjb25zdCBsZWFzZVJlY292ZXJ5ID0gZW5zdXJlRGlzcGF0Y2hMZWFzZShzLCBpdGVyRGF0YS5taWQsIHtcbiAgICAgICAgICBjbGFpbU1pbGVzdG9uZUxlYXNlLFxuICAgICAgICAgIGxvZ0xlYXNlUmVjb3ZlcmVkOiBsb2dEaXNwYXRjaExlYXNlUmVjb3ZlcmVkLFxuICAgICAgICAgIGxvZ0xlYXNlUmVjb3ZlcnlGYWlsZWQ6IGxvZ0Rpc3BhdGNoTGVhc2VSZWNvdmVyeUZhaWxlZCxcbiAgICAgICAgfSwgeyBmb3JjZVJlY2xhaW06IHRydWUgfSk7XG4gICAgICAgIGlmIChsZWFzZVJlY292ZXJ5LmtpbmQgPT09IFwicmVhZHlcIikge1xuICAgICAgICAgIGRpc3BhdGNoQ2xhaW0gPSBvcGVuRGlzcGF0Y2hDbGFpbShzLCBmbG93SWQsIHR1cm5JZCwgaXRlckRhdGEsIHtcbiAgICAgICAgICAgIGdldFJlY2VudERpc3BhdGNoZXNGb3JVbml0LFxuICAgICAgICAgICAgcmVjb3JkRGlzcGF0Y2hDbGFpbSxcbiAgICAgICAgICAgIG1hcmtEaXNwYXRjaFJ1bm5pbmcsXG4gICAgICAgICAgICBsb2dDbGFpbVJlamVjdGVkOiBsb2dEaXNwYXRjaENsYWltUmVqZWN0ZWQsXG4gICAgICAgICAgICBsb2dDbGFpbUZhaWxlZDogbG9nRGlzcGF0Y2hDbGFpbUZhaWxlZCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBkaXNwYXRjaERlY2lzaW9uID0gZGVjaWRlRGlzcGF0Y2hDbGFpbShcbiAgICAgICAgICAgIGRpc3BhdGNoQ2xhaW0ua2luZCA9PT0gXCJvcGVuZWRcIlxuICAgICAgICAgICAgICA/IHsga2luZDogXCJvcGVuZWRcIiwgZGlzcGF0Y2hJZDogZGlzcGF0Y2hDbGFpbS5kaXNwYXRjaElkIH1cbiAgICAgICAgICAgICAgOiBkaXNwYXRjaENsYWltLmtpbmQgPT09IFwic2tpcFwiXG4gICAgICAgICAgICAgICAgPyB7IGtpbmQ6IFwic2tpcFwiLCByZWFzb246IGRpc3BhdGNoQ2xhaW0ucmVhc29uIH1cbiAgICAgICAgICAgICAgICA6IHsga2luZDogXCJkZWdyYWRlZFwiIH0sXG4gICAgICAgICAgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBtc2cgPSBgTG9zdCBtaWxlc3RvbmUgbGVhc2UgZm9yICR7aXRlckRhdGEubWlkID8/IFwidW5rbm93blwifSB3aGlsZSBjbGFpbWluZyAke2l0ZXJEYXRhLnVuaXRUeXBlfSAke2l0ZXJEYXRhLnVuaXRJZH06ICR7bGVhc2VSZWNvdmVyeS5yZWFzb259YDtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KG1zZywgXCJlcnJvclwiKTtcbiAgICAgICAgICBmaW5pc2hUdXJuKFwic3RvcHBlZFwiLCBcImV4ZWN1dGlvblwiLCBtc2cpO1xuICAgICAgICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgbXNnKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGRpc3BhdGNoRGVjaXNpb24uYWN0aW9uID09PSBcInNraXBcIikge1xuICAgICAgICBpZiAoZGlzcGF0Y2hEZWNpc2lvbi5yZWFzb24gPT09IFwic3RhbGUtbGVhc2VcIikge1xuICAgICAgICAgIGNvbnN0IG1zZyA9IGBMb3N0IG1pbGVzdG9uZSBsZWFzZSBmb3IgJHtpdGVyRGF0YS5taWQgPz8gXCJ1bmtub3duXCJ9IHdoaWxlIGNsYWltaW5nICR7aXRlckRhdGEudW5pdFR5cGV9ICR7aXRlckRhdGEudW5pdElkfTsgZGlzcGF0Y2ggY2xhaW0gc3RpbGwgZmFpbGVkIGFmdGVyIHJlY292ZXJ5LmA7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShtc2csIFwiZXJyb3JcIik7XG4gICAgICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJleGVjdXRpb25cIiwgbXNnKTtcbiAgICAgICAgICBhd2FpdCBkZXBzLnN0b3BBdXRvKGN0eCwgcGksIG1zZyk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgZmluaXNoVHVybihcInNraXBwZWRcIiwgXCJleGVjdXRpb25cIiwgZGlzcGF0Y2hEZWNpc2lvbi5yZWFzb24pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGRpc3BhdGNoSWQgPSBkaXNwYXRjaERlY2lzaW9uLmRpc3BhdGNoSWQ7XG5cbiAgICAgIGxldCB1bml0UGhhc2VSZXN1bHQ6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcnVuVW5pdFBoYXNlVmlhQ29udHJhY3Q+PjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHVuaXRQaGFzZVJlc3VsdCA9IGF3YWl0IHJ1blVuaXRQaGFzZVZpYUNvbnRyYWN0KFxuICAgICAgICAgIGRpc3BhdGNoQ29udHJhY3QsXG4gICAgICAgICAgaWMsXG4gICAgICAgICAgaXRlckRhdGEsXG4gICAgICAgICAgbG9vcFN0YXRlLFxuICAgICAgICAgIHNpZGVjYXJJdGVtLFxuICAgICAgICAgIHVuaXREaXNwYXRjaERlcHMsXG4gICAgICAgICk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGVyciBpbnN0YW5jZW9mIE1vZGVsUG9saWN5RGlzcGF0Y2hCbG9ja2VkRXJyb3IpIHtcbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgICAgY2xvc2VPdXRDcmFzaGVkVW5pdChzLCBpdGVyRGF0YSwgZXJyKTtcbiAgICAgICAgZGlzcGF0Y2hTZXR0bGVkID0gc2V0dGxlRGlzcGF0Y2hGYWlsZWQoXG4gICAgICAgICAgZGlzcGF0Y2hJZCxcbiAgICAgICAgICBmb3JtYXREaXNwYXRjaEV4Y2VwdGlvblN1bW1hcnkoeyBlcnJvcjogZXJyIH0pLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIG1hcmtGYWlsZWQ6IG1hcmtEaXNwYXRjaEZhaWxlZCxcbiAgICAgICAgICAgIGxvZ1dyaXRlRmFpbHVyZTogbG9nRGlzcGF0Y2hMZWRnZXJXcml0ZUZhaWx1cmUsXG4gICAgICAgICAgfSxcbiAgICAgICAgKSB8fCBkaXNwYXRjaFNldHRsZWQ7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cbiAgICAgIGlmICh1bml0UGhhc2VSZXN1bHQuYWN0aW9uID09PSBcIm5leHRcIikge1xuICAgICAgICBjb25zdCByZXF1ZXN0VGltZXN0YW1wID0gcmVzb2x2ZVVuaXRSZXF1ZXN0VGltZXN0YW1wKHVuaXRQaGFzZVJlc3VsdC5kYXRhKTtcbiAgICAgICAgaWYgKHJlcXVlc3RUaW1lc3RhbXAgIT09IHVuZGVmaW5lZCkgcy5sYXN0UmVxdWVzdFRpbWVzdGFtcCA9IHJlcXVlc3RUaW1lc3RhbXA7XG4gICAgICB9XG4gICAgICBwaGFzZVJlcG9ydGVyLnJlcG9ydChcInVuaXRcIiwgdW5pdFBoYXNlUmVzdWx0LmFjdGlvbiwge1xuICAgICAgICB1bml0VHlwZTogaXRlckRhdGEudW5pdFR5cGUsXG4gICAgICAgIHVuaXRJZDogaXRlckRhdGEudW5pdElkLFxuICAgICAgfSk7XG4gICAgICBpZiAodW5pdFBoYXNlUmVzdWx0LmFjdGlvbiA9PT0gXCJicmVha1wiKSB7XG4gICAgICAgIGRpc3BhdGNoU2V0dGxlZCA9IHNldHRsZURpc3BhdGNoRmFpbGVkKGRpc3BhdGNoSWQsIFwidW5pdC1icmVha1wiLCB7XG4gICAgICAgICAgbWFya0ZhaWxlZDogbWFya0Rpc3BhdGNoRmFpbGVkLFxuICAgICAgICAgIGxvZ1dyaXRlRmFpbHVyZTogbG9nRGlzcGF0Y2hMZWRnZXJXcml0ZUZhaWx1cmUsXG4gICAgICAgIH0pIHx8IGRpc3BhdGNoU2V0dGxlZDtcbiAgICAgICAgZmluaXNoSW5jb21wbGV0ZUl0ZXJhdGlvbih7XG4gICAgICAgICAgc3RhdHVzOiBcInN0b3BwZWRcIixcbiAgICAgICAgICByZWFzb246IHVuaXRQaGFzZVJlc3VsdC5yZWFzb24gPz8gXCJ1bml0LWJyZWFrXCIsXG4gICAgICAgICAgdW5pdFR5cGU6IGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZDogaXRlckRhdGEudW5pdElkLFxuICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJleGVjdXRpb25cIixcbiAgICAgICAgfSk7XG4gICAgICAgIGZpbmlzaFR1cm4oXCJzdG9wcGVkXCIsIFwiZXhlY3V0aW9uXCIsIFwidW5pdC1icmVha1wiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBQaGFzZSA1OiBGaW5hbGl6ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAgICAgbGV0IGZpbmFsaXplUmVzdWx0OiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJ1bkZpbmFsaXplPj47XG4gICAgICBqb3VybmFsUmVwb3J0ZXIuZW1pdChcInBvc3QtdW5pdC1maW5hbGl6ZS1zdGFydFwiLCB7XG4gICAgICAgIGl0ZXJhdGlvbixcbiAgICAgICAgdW5pdFR5cGU6IGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgICB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCxcbiAgICAgIH0pO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZmluYWxpemVSZXN1bHQgPSBhd2FpdCBydW5GaW5hbGl6ZShpYywgaXRlckRhdGEsIGxvb3BTdGF0ZSwgc2lkZWNhckl0ZW0pO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IGVycm9yID0gZm9ybWF0RGlzcGF0Y2hFeGNlcHRpb25TdW1tYXJ5KHsgZXJyb3I6IGVyciB9KTtcbiAgICAgICAgam91cm5hbFJlcG9ydGVyLmVtaXQoXCJwb3N0LXVuaXQtZmluYWxpemUtZW5kXCIsIHtcbiAgICAgICAgICBpdGVyYXRpb24sXG4gICAgICAgICAgdW5pdFR5cGU6IGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZDogaXRlckRhdGEudW5pdElkLFxuICAgICAgICAgIHN0YXR1czogXCJmYWlsZWRcIixcbiAgICAgICAgICBlcnJvcixcbiAgICAgICAgfSk7XG4gICAgICAgIGRpc3BhdGNoU2V0dGxlZCA9IHNldHRsZURpc3BhdGNoRmFpbGVkKFxuICAgICAgICAgIGRpc3BhdGNoSWQsXG4gICAgICAgICAgZXJyb3IsXG4gICAgICAgICAge1xuICAgICAgICAgICAgbWFya0ZhaWxlZDogbWFya0Rpc3BhdGNoRmFpbGVkLFxuICAgICAgICAgICAgbG9nV3JpdGVGYWlsdXJlOiBsb2dEaXNwYXRjaExlZGdlcldyaXRlRmFpbHVyZSxcbiAgICAgICAgICB9LFxuICAgICAgICApIHx8IGRpc3BhdGNoU2V0dGxlZDtcbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuICAgICAgcGhhc2VSZXBvcnRlci5yZXBvcnQoXCJmaW5hbGl6ZVwiLCBmaW5hbGl6ZVJlc3VsdC5hY3Rpb24sIHtcbiAgICAgICAgdW5pdFR5cGU6IGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgICB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgZmluYWxpemVSZWFzb24gPSBmaW5hbGl6ZVJlc3VsdC5hY3Rpb24gPT09IFwiYnJlYWtcIiA/IGZpbmFsaXplUmVzdWx0LnJlYXNvbiA6IHVuZGVmaW5lZDtcbiAgICAgIGpvdXJuYWxSZXBvcnRlci5lbWl0KFwicG9zdC11bml0LWZpbmFsaXplLWVuZFwiLCB7XG4gICAgICAgIGl0ZXJhdGlvbixcbiAgICAgICAgdW5pdFR5cGU6IGl0ZXJEYXRhLnVuaXRUeXBlLFxuICAgICAgICB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCxcbiAgICAgICAgc3RhdHVzOiBmaW5hbGl6ZVJlc3VsdC5hY3Rpb24gPT09IFwibmV4dFwiID8gXCJjb21wbGV0ZWRcIiA6IGZpbmFsaXplUmVzdWx0LmFjdGlvbiA9PT0gXCJjb250aW51ZVwiID8gXCJyZXRyeVwiIDogXCJzdG9wcGVkXCIsXG4gICAgICAgIGFjdGlvbjogZmluYWxpemVSZXN1bHQuYWN0aW9uLFxuICAgICAgICAuLi4oZmluYWxpemVSZWFzb24gPyB7IHJlYXNvbjogZmluYWxpemVSZWFzb24gfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgICAgY29uc3QgZmluYWxpemVEZWNpc2lvbiA9IGRlY2lkZUZpbmFsaXplUmVzdWx0KFxuICAgICAgICBmaW5hbGl6ZVJlc3VsdC5hY3Rpb24gPT09IFwiYnJlYWtcIlxuICAgICAgICAgID8geyBhY3Rpb246IFwiYnJlYWtcIiwgcmVhc29uOiBmaW5hbGl6ZVJlc3VsdC5yZWFzb24gfVxuICAgICAgICAgIDogZmluYWxpemVSZXN1bHQuYWN0aW9uID09PSBcImNvbnRpbnVlXCJcbiAgICAgICAgICAgID8geyBhY3Rpb246IFwiY29udGludWVcIiB9XG4gICAgICAgICAgICA6IHsgYWN0aW9uOiBcIm5leHRcIiB9LFxuICAgICAgKTtcbiAgICAgIGlmIChmaW5hbGl6ZURlY2lzaW9uLmFjdGlvbiA9PT0gXCJzdG9wXCIpIHtcbiAgICAgICAgZGlzcGF0Y2hTZXR0bGVkID0gc2V0dGxlRGlzcGF0Y2hGYWlsZWQoZGlzcGF0Y2hJZCwgZmluYWxpemVEZWNpc2lvbi5sZWRnZXJFcnJvclN1bW1hcnksIHtcbiAgICAgICAgICBtYXJrRmFpbGVkOiBtYXJrRGlzcGF0Y2hGYWlsZWQsXG4gICAgICAgICAgbG9nV3JpdGVGYWlsdXJlOiBsb2dEaXNwYXRjaExlZGdlcldyaXRlRmFpbHVyZSxcbiAgICAgICAgfSkgfHwgZGlzcGF0Y2hTZXR0bGVkO1xuICAgICAgICBmaW5pc2hJbmNvbXBsZXRlSXRlcmF0aW9uKHtcbiAgICAgICAgICBzdGF0dXM6IFwic3RvcHBlZFwiLFxuICAgICAgICAgIHJlYXNvbjogZmluYWxpemVSZWFzb24gPz8gXCJmaW5hbGl6ZS1icmVha1wiLFxuICAgICAgICAgIHVuaXRUeXBlOiBpdGVyRGF0YS51bml0VHlwZSxcbiAgICAgICAgICB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCxcbiAgICAgICAgICBmYWlsdXJlQ2xhc3M6IGZpbmFsaXplRGVjaXNpb24uZmFpbHVyZUNsYXNzLFxuICAgICAgICB9KTtcbiAgICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgZmluYWxpemVEZWNpc2lvbi5mYWlsdXJlQ2xhc3MsIGZpbmFsaXplRGVjaXNpb24udHVybkVycm9yKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBpZiAoZmluYWxpemVEZWNpc2lvbi5hY3Rpb24gPT09IFwicmV0cnlcIikge1xuICAgICAgICBkaXNwYXRjaFNldHRsZWQgPSBzZXR0bGVEaXNwYXRjaEZhaWxlZChkaXNwYXRjaElkLCBmaW5hbGl6ZURlY2lzaW9uLmxlZGdlckVycm9yU3VtbWFyeSwge1xuICAgICAgICAgIG1hcmtGYWlsZWQ6IG1hcmtEaXNwYXRjaEZhaWxlZCxcbiAgICAgICAgICBsb2dXcml0ZUZhaWx1cmU6IGxvZ0Rpc3BhdGNoTGVkZ2VyV3JpdGVGYWlsdXJlLFxuICAgICAgICB9KSB8fCBkaXNwYXRjaFNldHRsZWQ7XG4gICAgICAgIGZpbmlzaEluY29tcGxldGVJdGVyYXRpb24oe1xuICAgICAgICAgIHN0YXR1czogXCJyZXRyeVwiLFxuICAgICAgICAgIHJlYXNvbjogXCJmaW5hbGl6ZS1yZXRyeVwiLFxuICAgICAgICAgIHVuaXRUeXBlOiBpdGVyRGF0YS51bml0VHlwZSxcbiAgICAgICAgICB1bml0SWQ6IGl0ZXJEYXRhLnVuaXRJZCxcbiAgICAgICAgfSk7XG4gICAgICAgIGZpbmlzaFR1cm4oXCJyZXRyeVwiKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGRpc3BhdGNoU2V0dGxlZCA9IHNldHRsZURpc3BhdGNoQ29tcGxldGVkKGRpc3BhdGNoSWQsIHtcbiAgICAgICAgbWFya0NvbXBsZXRlZDogbWFya0Rpc3BhdGNoQ29tcGxldGVkLFxuICAgICAgICBsb2dXcml0ZUZhaWx1cmU6IGxvZ0Rpc3BhdGNoTGVkZ2VyV3JpdGVGYWlsdXJlLFxuICAgICAgfSkgfHwgZGlzcGF0Y2hTZXR0bGVkO1xuICAgICAgY29tcGxldGVJdGVyYXRpb24oKTtcbiAgICAgIGZpbmlzaFR1cm4oXCJjb21wbGV0ZWRcIik7XG4gICAgfSBjYXRjaCAobG9vcEVycikge1xuICAgICAgLy8gXHUyNTAwXHUyNTAwIEJsYW5rZXQgY2F0Y2g6IGFic29yYiB1bmV4cGVjdGVkIGV4Y2VwdGlvbnMsIGFwcGx5IGdyYWR1YXRlZCByZWNvdmVyeSBcdTI1MDBcdTI1MDBcbiAgICAgIGNvbnN0IG1zZyA9IGxvb3BFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGxvb3BFcnIubWVzc2FnZSA6IFN0cmluZyhsb29wRXJyKTtcbiAgICAgIGlmIChkaXNwYXRjaElkICE9PSBudWxsICYmICFkaXNwYXRjaFNldHRsZWQgJiYgIShsb29wRXJyIGluc3RhbmNlb2YgTW9kZWxQb2xpY3lEaXNwYXRjaEJsb2NrZWRFcnJvcikpIHtcbiAgICAgICAgZGlzcGF0Y2hTZXR0bGVkID0gc2V0dGxlRGlzcGF0Y2hGYWlsZWQoXG4gICAgICAgICAgZGlzcGF0Y2hJZCxcbiAgICAgICAgICBmb3JtYXRVbmhhbmRsZWREaXNwYXRjaEVycm9yU3VtbWFyeSh7IGVycm9yOiBsb29wRXJyIH0pLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIG1hcmtGYWlsZWQ6IG1hcmtEaXNwYXRjaEZhaWxlZCxcbiAgICAgICAgICAgIGxvZ1dyaXRlRmFpbHVyZTogbG9nRGlzcGF0Y2hMZWRnZXJXcml0ZUZhaWx1cmUsXG4gICAgICAgICAgfSxcbiAgICAgICAgKSB8fCBkaXNwYXRjaFNldHRsZWQ7XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBQcmUtc2VuZCBtb2RlbC1wb2xpY3kgYmxvY2s6IG5vdCBhIHJldHJ5YWJsZSBlcnJvciAoIzQ5NTkgLyAjNDg1MCkgXHUyNTAwXHUyNTAwXG4gICAgICAvLyBUaGUgbW9kZWwtcG9saWN5IGdhdGUgcnVucyBiZWZvcmUgdGhlIHByb21wdCBpcyBzZW50LiAgV2hlbiBldmVyeVxuICAgICAgLy8gY2FuZGlkYXRlIG1vZGVsIGlzIGRlbmllZCAoY3Jvc3MtcHJvdmlkZXIgZGlzYWJsZWQgKyBmbGF0LXJhdGVcbiAgICAgIC8vIGJhc2VsaW5lICsgdG9vbC1wb2xpY3kgZGVuaWFsKSwgcmV0cnlpbmcgdGhlIHNhbWUgdW5pdCBwcm9kdWNlcyB0aGVcbiAgICAgIC8vIHNhbWUgZGVuaWFsIFx1MjAxNCBidXJuaW5nIHRoZSBjb25zZWN1dGl2ZS1lcnJvciBidWRnZXQgdG93YXJkIGEgMy1zdHJpa2VcbiAgICAgIC8vIGhhcmQgc3RvcCBhbmQgY29ycnVwdGluZyBhdXRvLW1vZGUgc3RhdGUuICBQYXVzZSBmb3IgdXNlciBhdHRlbnRpb25cbiAgICAgIC8vIGluc3RlYWQsIHdpdGggdGhlIHBlci1tb2RlbCBkZW55IHJlYXNvbnMgc3VyZmFjZWQgZnJvbSB0aGUgdHlwZWRcbiAgICAgIC8vIGVycm9yLlxuICAgICAgaWYgKGxvb3BFcnIgaW5zdGFuY2VvZiBNb2RlbFBvbGljeURpc3BhdGNoQmxvY2tlZEVycm9yKSB7XG4gICAgICAgIGNvbnN0IHBvbGljeURlY2lzaW9uID0gZGVjaWRlTW9kZWxQb2xpY3lCbG9ja2VkKHtcbiAgICAgICAgICB1bml0VHlwZTogbG9vcEVyci51bml0VHlwZSxcbiAgICAgICAgICB1bml0SWQ6IGxvb3BFcnIudW5pdElkLFxuICAgICAgICAgIGVycm9yTWVzc2FnZTogbXNnLFxuICAgICAgICAgIHJlYXNvbnM6IGxvb3BFcnIucmVhc29ucyxcbiAgICAgICAgfSk7XG4gICAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICAgIHBoYXNlOiBcIm1vZGVsLXBvbGljeS1ibG9ja2VkXCIsXG4gICAgICAgICAgaXRlcmF0aW9uLFxuICAgICAgICAgIHVuaXRUeXBlOiBsb29wRXJyLnVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZDogbG9vcEVyci51bml0SWQsXG4gICAgICAgICAgcmVhc29uczogbG9vcEVyci5yZWFzb25zLFxuICAgICAgICB9KTtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShwb2xpY3lEZWNpc2lvbi5ub3RpZnlNZXNzYWdlLCBcImVycm9yXCIpO1xuICAgICAgICBqb3VybmFsUmVwb3J0ZXIuZW1pdChcInVuaXQtZW5kXCIsIHBvbGljeURlY2lzaW9uLmpvdXJuYWxEYXRhKTtcbiAgICAgICAgZmluaXNoSW5jb21wbGV0ZUl0ZXJhdGlvbih7XG4gICAgICAgICAgc3RhdHVzOiBcImJsb2NrZWRcIixcbiAgICAgICAgICByZWFzb246IFwibW9kZWwtcG9saWN5LWRpc3BhdGNoLWJsb2NrZWRcIixcbiAgICAgICAgICB1bml0VHlwZTogbG9vcEVyci51bml0VHlwZSxcbiAgICAgICAgICB1bml0SWQ6IGxvb3BFcnIudW5pdElkLFxuICAgICAgICB9KTtcbiAgICAgICAgLy8gQ2FycnkgdGhlIGJsb2NrZWQgdW5pdCBpZGVudGl0eSBpbnRvIHRoZSB0dXJuLXJlc3VsdCBvYnNlcnZlcjpcbiAgICAgICAgLy8gdGhlIHRocm93IG9yaWdpbmF0ZWQgaW5zaWRlIGRpc3BhdGNoLCBzbyBvYnNlcnZlZFVuaXRUeXBlL0lkIHdlcmVcbiAgICAgICAgLy8gbm90IGFzc2lnbmVkIGJ5IHRoZSBzdWNjZXNzIHBhdGggYXQgbGluZXMgNDUzLzYzMS82NDcgXHUyMDE0IGJ1dCB0aGVcbiAgICAgICAgLy8gdHlwZWQgZXJyb3IgYWxyZWFkeSBuYW1lcyB0aGUgdW5pdCAoIzQ5NTkgLyBDb2RlUmFiYml0KS5cbiAgICAgICAgb2JzZXJ2ZWRVbml0VHlwZSA9IGxvb3BFcnIudW5pdFR5cGU7XG4gICAgICAgIG9ic2VydmVkVW5pdElkID0gbG9vcEVyci51bml0SWQ7XG4gICAgICAgIGF3YWl0IGRlcHMucGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgICBmaW5pc2hUdXJuKHBvbGljeURlY2lzaW9uLnR1cm5TdGF0dXMsIHBvbGljeURlY2lzaW9uLmZhaWx1cmVDbGFzcywgbXNnKTtcbiAgICAgICAgLy8gRG8gTk9UIGluY3JlbWVudCBjb25zZWN1dGl2ZUVycm9ycyBcdTIwMTQgdGhlIGZhaWx1cmUgaXMgY29uZmlndXJhdGlvbixcbiAgICAgICAgLy8gbm90IGEgdHJhbnNpZW50IHJ1bnRpbWUgZmF1bHQuXG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICAvLyBBbHdheXMgZW1pdCBpdGVyYXRpb24tZW5kIG9uIGVycm9yIHNvIHRoZSBqb3VybmFsIHJlY29yZHMgaXRlcmF0aW9uXG4gICAgICAvLyBjb21wbGV0aW9uIGV2ZW4gb24gZmFpbHVyZSAoIzIzNDQpLiBXaXRob3V0IHRoaXMsIGVycm9ycyBpblxuICAgICAgLy8gcnVuRmluYWxpemUgbGVhdmUgdGhlIGpvdXJuYWwgaW5jb21wbGV0ZSwgbWFraW5nIGRpYWdub3NpcyBoYXJkZXIuXG4gICAgICBmaW5pc2hJbmNvbXBsZXRlSXRlcmF0aW9uKHsgc3RhdHVzOiBcImZhaWxlZFwiLCBlcnJvcjogbXNnIH0pO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgSW5mcmFzdHJ1Y3R1cmUgZXJyb3JzOiBpbW1lZGlhdGUgc3RvcCwgbm8gcmV0cnkgXHUyNTAwXHUyNTAwXG4gICAgICAvLyBUaGVzZSBhcmUgdW5yZWNvdmVyYWJsZSAoZGlzayBmdWxsLCBPT00sIGV0Yy4pLiBSZXRyeWluZyBqdXN0IGJ1cm5zXG4gICAgICAvLyBMTE0gYnVkZ2V0IG9uIGd1YXJhbnRlZWQgZmFpbHVyZXMuXG4gICAgICBjb25zdCBpbmZyYUNvZGUgPSBpc0luZnJhc3RydWN0dXJlRXJyb3IobG9vcEVycik7XG4gICAgICBpZiAoaW5mcmFDb2RlKSB7XG4gICAgICAgIGNvbnN0IGluZnJhRGVjaXNpb24gPSBkZWNpZGVJbmZyYXN0cnVjdHVyZUVycm9yKHtcbiAgICAgICAgICBjb2RlOiBpbmZyYUNvZGUsXG4gICAgICAgICAgZXJyb3JNZXNzYWdlOiBtc2csXG4gICAgICAgIH0pO1xuICAgICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICAgICAgICBwaGFzZTogXCJpbmZyYXN0cnVjdHVyZS1lcnJvclwiLFxuICAgICAgICAgIGl0ZXJhdGlvbixcbiAgICAgICAgICBjb2RlOiBpbmZyYUNvZGUsXG4gICAgICAgICAgZXJyb3I6IG1zZyxcbiAgICAgICAgfSk7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoaW5mcmFEZWNpc2lvbi5ub3RpZnlNZXNzYWdlLCBcImVycm9yXCIpO1xuICAgICAgICBhd2FpdCBkZXBzLnN0b3BBdXRvKGN0eCwgcGksIGluZnJhRGVjaXNpb24uc3RvcE1lc3NhZ2UpO1xuICAgICAgICBmaW5pc2hUdXJuKGluZnJhRGVjaXNpb24udHVyblN0YXR1cywgaW5mcmFEZWNpc2lvbi5mYWlsdXJlQ2xhc3MsIG1zZyk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgQ3JlZGVudGlhbCBjb29sZG93bjogd2FpdCBhbmQgcmV0cnkgd2l0aCBib3VuZGVkIGJ1ZGdldCBcdTI1MDBcdTI1MDBcbiAgICAgIC8vIEEgNDI5IHRyaWdnZXJzIGEgMzBzIGNyZWRlbnRpYWwgYmFja29mZiBpbiBBdXRoU3RvcmFnZS4gSWYgdGhlIFNESydzXG4gICAgICAvLyBnZXRBcGlLZXkoKSByZXRyaWVzIGNvdWxkbid0IG91dGxhc3QgdGhlIHdpbmRvdywgdGhlIGVycm9yIHN1cmZhY2VzXG4gICAgICAvLyBoZXJlLiBXYWl0IGZvciB0aGUgY29vbGRvd24gdG8gY2xlYXIgcmF0aGVyIHRoYW4gY291bnRpbmcgaXQgYXMgYVxuICAgICAgLy8gY29uc2VjdXRpdmUgZmFpbHVyZSBcdTIwMTQgYnV0IGNhcCByZXRyaWVzIHNvIHdlIGRvbid0IHNwaW4gZm9yIGhvdXJzXG4gICAgICAvLyBvbiBwZXJzaXN0ZW50IHF1b3RhIGV4aGF1c3Rpb24uXG4gICAgICBpZiAoaXNUcmFuc2llbnRDb29sZG93bkVycm9yKGxvb3BFcnIpKSB7XG4gICAgICAgIGNvbnNlY3V0aXZlQ29vbGRvd25zKys7XG4gICAgICAgIGNvbnN0IHJldHJ5QWZ0ZXJNcyA9IGdldENvb2xkb3duUmV0cnlBZnRlck1zKGxvb3BFcnIpO1xuICAgICAgICBjb25zdCBjb29sZG93bkRlY2lzaW9uID0gZGVjaWRlQ29vbGRvd25SZWNvdmVyeSh7XG4gICAgICAgICAgY29uc2VjdXRpdmVDb29sZG93bnMsXG4gICAgICAgICAgbWF4Q29vbGRvd25SZXRyaWVzOiBNQVhfQ09PTERPV05fUkVUUklFUyxcbiAgICAgICAgICByZXRyeUFmdGVyTXMsXG4gICAgICAgICAgZmFsbGJhY2tXYWl0TXM6IENPT0xET1dOX0ZBTExCQUNLX1dBSVRfTVMsXG4gICAgICAgIH0pO1xuICAgICAgICBkZWJ1Z0xvZyhcImF1dG9Mb29wXCIsIHtcbiAgICAgICAgICBwaGFzZTogXCJjb29sZG93bi13YWl0XCIsXG4gICAgICAgICAgaXRlcmF0aW9uLFxuICAgICAgICAgIGNvbnNlY3V0aXZlQ29vbGRvd25zLFxuICAgICAgICAgIHJldHJ5QWZ0ZXJNcyxcbiAgICAgICAgICBlcnJvcjogbXNnLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoY29vbGRvd25EZWNpc2lvbi5hY3Rpb24gPT09IFwic3RvcFwiKSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShjb29sZG93bkRlY2lzaW9uLm5vdGlmeU1lc3NhZ2UsIFwiZXJyb3JcIik7XG4gICAgICAgICAgZmluaXNoVHVybihcInN0b3BwZWRcIiwgXCJ0aW1lb3V0XCIsIG1zZyk7XG4gICAgICAgICAgYXdhaXQgZGVwcy5zdG9wQXV0byhjdHgsIHBpLCBjb29sZG93bkRlY2lzaW9uLnN0b3BNZXNzYWdlKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuXG4gICAgICAgIGN0eC51aS5ub3RpZnkoY29vbGRvd25EZWNpc2lvbi5ub3RpZnlNZXNzYWdlLCBcIndhcm5pbmdcIik7XG4gICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCBjb29sZG93bkRlY2lzaW9uLndhaXRNcykpO1xuICAgICAgICBmaW5pc2hUdXJuKFwicmV0cnlcIiwgXCJ0aW1lb3V0XCIsIG1zZyk7XG4gICAgICAgIGNvbnRpbnVlOyAvLyBSZXRyeSBpdGVyYXRpb24gd2l0aG91dCBpbmNyZW1lbnRpbmcgY29uc2VjdXRpdmVFcnJvcnNcbiAgICAgIH1cblxuICAgICAgY29uc2VjdXRpdmVFcnJvcnMrKztcbiAgICAgIHJlY2VudEVycm9yTWVzc2FnZXMucHVzaChtc2cubGVuZ3RoID4gMTIwID8gbXNnLnNsaWNlKDAsIDEyMCkgKyBcIi4uLlwiIDogbXNnKTtcbiAgICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgICBwaGFzZTogXCJpdGVyYXRpb24tZXJyb3JcIixcbiAgICAgICAgaXRlcmF0aW9uLFxuICAgICAgICBjb25zZWN1dGl2ZUVycm9ycyxcbiAgICAgICAgZXJyb3I6IG1zZyxcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCBlcnJvckRlY2lzaW9uID0gZGVjaWRlSXRlcmF0aW9uRXJyb3JSZWNvdmVyeSh7XG4gICAgICAgIGNvbnNlY3V0aXZlRXJyb3JzLFxuICAgICAgICByZWNlbnRFcnJvck1lc3NhZ2VzLFxuICAgICAgICBjdXJyZW50RXJyb3JNZXNzYWdlOiBtc2csXG4gICAgICB9KTtcbiAgICAgIGlmIChlcnJvckRlY2lzaW9uLmFjdGlvbiA9PT0gXCJzdG9wXCIpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShlcnJvckRlY2lzaW9uLm5vdGlmeU1lc3NhZ2UsIFwiZXJyb3JcIik7XG4gICAgICAgIGF3YWl0IGRlcHMuc3RvcEF1dG8oY3R4LCBwaSwgZXJyb3JEZWNpc2lvbi5zdG9wTWVzc2FnZSk7XG4gICAgICAgIGZpbmlzaFR1cm4oZXJyb3JEZWNpc2lvbi50dXJuU3RhdHVzLCBcImV4ZWN1dGlvblwiLCBtc2cpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmIChlcnJvckRlY2lzaW9uLmFjdGlvbiA9PT0gXCJpbnZhbGlkYXRlLWFuZC1yZXRyeVwiKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoZXJyb3JEZWNpc2lvbi5ub3RpZnlNZXNzYWdlLCBcIndhcm5pbmdcIik7XG4gICAgICAgIGRlcHMuaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShlcnJvckRlY2lzaW9uLm5vdGlmeU1lc3NhZ2UsIFwid2FybmluZ1wiKTtcbiAgICAgIH1cbiAgICAgIGZpbmlzaFR1cm4oZXJyb3JEZWNpc2lvbi50dXJuU3RhdHVzLCBcImV4ZWN1dGlvblwiLCBtc2cpO1xuICAgIH1cbiAgfVxuXG4gIF9jbGVhckN1cnJlbnRSZXNvbHZlKCk7XG4gIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwgeyBwaGFzZTogXCJleGl0XCIsIHRvdGFsSXRlcmF0aW9uczogaXRlcmF0aW9uIH0pO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuVW9rS2VybmVsTG9vcChcbiAgY3R4OiBFeHRlbnNpb25Db250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuICBzOiBBdXRvU2Vzc2lvbixcbiAgZGVwczogTG9vcERlcHMsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMsIHsgZGlzcGF0Y2hDb250cmFjdDogXCJ1b2stc2NoZWR1bGVyXCIgfSk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5MZWdhY3lBdXRvTG9vcChcbiAgY3R4OiBFeHRlbnNpb25Db250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuICBzOiBBdXRvU2Vzc2lvbixcbiAgZGVwczogTG9vcERlcHMsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMsIHsgZGlzcGF0Y2hDb250cmFjdDogXCJsZWdhY3ktZGlyZWN0XCIgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFXQSxTQUFTLGtCQUFrQjtBQUczQjtBQUFBLEVBQ0U7QUFBQSxPQUlLO0FBQ1AsU0FBUyw0QkFBNEI7QUFDckM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsZ0JB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
