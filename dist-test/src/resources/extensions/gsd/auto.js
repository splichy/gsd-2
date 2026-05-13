import { deriveState } from "./state.js";
import { parseUnitId } from "./unit-id.js";
import {
  assessInterruptedSession,
  readPausedSessionMetadata,
  PAUSED_SESSION_KV_KEY
} from "./interrupted-session.js";
import {
  setRuntimeKv,
  deleteRuntimeKv
} from "./db/runtime-kv.js";
import { extractSection, getManifestStatus, splitFrontmatter, parseFrontmatterMap } from "./files.js";
import { inlinePriorMilestoneSummary } from "./files.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import {
  gsdRoot,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveDir,
  milestonesDir
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { clearActivityLogState } from "./activity-log.js";
import {
  synthesizeCrashRecovery,
  getDeepDiagnostic,
  readActiveMilestoneId
} from "./session-forensics.js";
import {
  writeLock,
  clearLock,
  clearStaleWorkerLock,
  readCrashLock,
  isLockProcessAlive,
  formatCrashInfo,
  emitCrashRecoveredUnitEnd,
  emitOpenUnitEndForUnit
} from "./crash-recovery.js";
import {
  acquireSessionLock,
  getSessionLockStatus,
  releaseSessionLock,
  updateSessionLock
} from "./session-lock.js";
import {
  resolveAutoSupervisorConfig,
  loadEffectiveGSDPreferences,
  getIsolationMode
} from "./preferences.js";
import { sendDesktopNotification } from "./notifications.js";
import {
  getBudgetAlertLevel,
  getNewBudgetAlertLevel,
  getBudgetEnforcementAction
} from "./auto-budget.js";
import {
  markToolStart as _markToolStart,
  markToolEnd as _markToolEnd,
  getOldestInFlightToolAgeMs as _getOldestInFlightToolAgeMs,
  clearInFlightTools,
  isToolInvocationError,
  isQueuedUserMessageSkip,
  isDeterministicPolicyError
} from "./auto-tool-tracking.js";
import { closeoutUnit } from "./auto-unit-closeout.js";
import { selectAndApplyModel, resolveModelId, clearToolBaseline } from "./auto-model-selection.js";
import { resetRoutingHistory, recordOutcome } from "./routing-history.js";
import {
  resetHookState,
  runPreDispatchHooks,
  restoreHookState,
  clearPersistedHookState
} from "./post-unit-hooks.js";
import { runGSDDoctor, rebuildState } from "./doctor.js";
import {
  preDispatchHealthGate,
  recordHealthSnapshot,
  resetProactiveHealing,
  setLevelChangeCallback
} from "./doctor-proactive.js";
import { clearSkillSnapshot } from "./skill-discovery.js";
import {
  captureAvailableSkills,
  resetSkillTelemetry
} from "./skill-telemetry.js";
import { getRtkSessionSavings } from "../shared/rtk-session-stats.js";
import { deactivateGSD } from "../shared/gsd-phase-state.js";
import {
  initMetrics,
  resetMetrics,
  getLedger,
  getProjectTotals,
  formatCost,
  formatTokenCount
} from "./metrics.js";
import { setLogBasePath, logWarning } from "./workflow-logger.js";
import { preflightCleanRoot, postflightPopStash } from "./clean-root-preflight.js";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { atomicWriteSync } from "./atomic-write.js";
import {
  captureIntegrationBranch,
  detectWorktreeName,
  getCurrentBranch,
  getMainBranch,
  setActiveMilestoneId,
  resolveProjectRoot
} from "./worktree.js";
import { GitServiceImpl } from "./git-service.js";
import { getPriorSliceCompletionBlocker } from "./dispatch-guard.js";
import {
  createAutoWorktree,
  teardownAutoWorktree,
  isInAutoWorktree,
  getAutoWorktreePath,
  mergeMilestoneToMain,
  autoWorktreeBranch,
  checkResourcesStale,
  escapeStaleWorktree
} from "./auto-worktree.js";
import { pruneQueueOrder } from "./queue-order.js";
import { startCommandPolling as _startCommandPolling, isRemoteConfigured } from "../remote-questions/manager.js";
import { debugLog, isDebugEnabled, writeDebugSummary } from "./debug-logger.js";
import {
  reconcileMergeState
} from "./auto-recovery.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import { resolveDispatch, DISPATCH_RULES } from "./auto-dispatch.js";
import { getErrorMessage } from "./error-utils.js";
import { recoverFailedMigration } from "./migrate-external.js";
import { initRegistry, convertDispatchRules } from "./rule-registry.js";
import { emitJournalEvent as _emitJournalEvent } from "./journal.js";
import { isClosedStatus } from "./status-guards.js";
import {
  updateProgressWidget as _updateProgressWidget,
  setCompletionProgressWidget,
  setAutoOutcomeWidget,
  updateSliceProgressCache,
  clearSliceProgressCache,
  unitVerb
} from "./auto-dashboard.js";
import {
  registerSigtermHandler as _registerSigtermHandler,
  deregisterSigtermHandler as _deregisterSigtermHandler
} from "./auto-supervisor.js";
import { isDbAvailable, getMilestone, getMilestoneSlices } from "./gsd-db.js";
import { markLatestActiveForWorkerCanceled } from "./db/unit-dispatches.js";
import { writeUnitRuntimeRecord } from "./unit-runtime.js";
import { countPendingCaptures } from "./captures.js";
import { CMUX_CHANNELS } from "../shared/cmux-events.js";
import { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
function makeCmuxEmitters(pi) {
  return {
    syncCmuxSidebar: (preferences, state) => pi.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "sync", preferences, state }),
    logCmuxEvent: (preferences, message, level) => pi.events.emit(CMUX_CHANNELS.LOG, { preferences, message, level: level ?? "info" }),
    clearCmuxSidebar: (preferences) => pi.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "clear", preferences })
  };
}
import { startUnitSupervision } from "./auto-timers.js";
import { runPostUnitVerification } from "./auto-verification.js";
import {
  autoCommitUnit,
  postUnitPreVerification,
  postUnitPostVerification
} from "./auto-post-unit.js";
import { bootstrapAutoSession, openProjectDbIfPresent } from "./auto-start.js";
import { initHealthWidget } from "./health-widget.js";
import { runLegacyAutoLoop, runUokKernelLoop } from "./auto/loop.js";
import { resolveAgentEnd, resolveAgentEndCancelled, _resetPendingResolve, isSessionSwitchInFlight } from "./auto/resolve.js";
import { runAutoLoopWithUok } from "./uok/kernel.js";
import { resolveUokFlags } from "./uok/flags.js";
import { validateDirectory } from "./validate-directory.js";
import { createAutoOrchestrator } from "./auto/orchestrator.js";
import { reconcileBeforeDispatch } from "./state-reconciliation.js";
import { compileUnitToolContract } from "./tool-contract.js";
import { createWorktreeSafetyModule } from "./worktree-safety.js";
import { resolveManifest } from "./unit-context-manifest.js";
import { classifyFailure } from "./recovery-classification.js";
import { supportsStructuredQuestions } from "./workflow-mcp.js";
import {
  WorktreeLifecycle
} from "./worktree-lifecycle.js";
import { WorktreeStateProjection } from "./worktree-state-projection.js";
import { reorderForCaching } from "./prompt-ordering.js";
import { initTokenCounter } from "./token-counter.js";
void initTokenCounter().catch((err) => {
  logWarning(
    "engine",
    `token counter warm-up failed: ${err instanceof Error ? err.message : String(err)}`
  );
});
import {
  STUB_RECOVERY_THRESHOLD as STUB_RECOVERY_THRESHOLD2,
  NEW_SESSION_TIMEOUT_MS as NEW_SESSION_TIMEOUT_MS2
} from "./auto/session.js";
import { autoSession as s } from "./auto-runtime-state.js";
import { gsdHome } from "./gsd-home.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";
import { registerAutoWorker, markWorkerStopping } from "./db/auto-workers.js";
import { releaseMilestoneLease } from "./db/milestone-leases.js";
import { normalizeRealPath } from "./paths.js";
const STATE_REBUILD_MIN_INTERVAL_MS = 3e4;
function registerAutoWorkerForSession(session, projectRootOverride) {
  if (session.workerId) return;
  try {
    const projectRootRealpath = normalizeRealPath(
      projectRootOverride ?? session.scope?.workspace.projectRoot ?? (session.originalBasePath || session.basePath)
    );
    session.workerId = registerAutoWorker({ projectRootRealpath });
  } catch (err) {
    debugLog("autoLoop", {
      phase: "register-worker-failed",
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
function captureProjectRootEnv(projectRoot) {
  if (!s.projectRootEnvCaptured) {
    s.hadProjectRootEnv = Object.prototype.hasOwnProperty.call(process.env, "GSD_PROJECT_ROOT");
    s.previousProjectRootEnv = process.env.GSD_PROJECT_ROOT ?? null;
    s.projectRootEnvCaptured = true;
  }
  process.env.GSD_PROJECT_ROOT = projectRoot;
}
function restoreProjectRootEnv() {
  if (!s.projectRootEnvCaptured) return;
  if (s.hadProjectRootEnv && s.previousProjectRootEnv !== null) {
    process.env.GSD_PROJECT_ROOT = s.previousProjectRootEnv;
  } else {
    delete process.env.GSD_PROJECT_ROOT;
  }
  s.previousProjectRootEnv = null;
  s.hadProjectRootEnv = false;
  s.projectRootEnvCaptured = false;
}
function _captureProjectRootEnvForTest(projectRoot) {
  captureProjectRootEnv(projectRoot);
}
function _restoreProjectRootEnvForTest() {
  restoreProjectRootEnv();
}
function captureMilestoneLockEnv(milestoneId) {
  if (!s.milestoneLockEnvCaptured) {
    s.hadMilestoneLockEnv = Object.prototype.hasOwnProperty.call(process.env, "GSD_MILESTONE_LOCK");
    s.previousMilestoneLockEnv = process.env.GSD_MILESTONE_LOCK ?? null;
    s.milestoneLockEnvCaptured = true;
  }
  if (milestoneId) {
    process.env.GSD_MILESTONE_LOCK = milestoneId;
  } else {
    delete process.env.GSD_MILESTONE_LOCK;
  }
}
function restoreMilestoneLockEnv() {
  if (!s.milestoneLockEnvCaptured) return;
  if (s.hadMilestoneLockEnv && s.previousMilestoneLockEnv !== null) {
    process.env.GSD_MILESTONE_LOCK = s.previousMilestoneLockEnv;
  } else {
    delete process.env.GSD_MILESTONE_LOCK;
  }
  s.previousMilestoneLockEnv = null;
  s.hadMilestoneLockEnv = false;
  s.milestoneLockEnvCaptured = false;
}
function rebuildScope(rawPath, milestoneId) {
  if (!milestoneId) {
    s.scope = null;
    return;
  }
  try {
    const workspace = createWorkspace(rawPath);
    s.scope = scopeMilestone(workspace, milestoneId);
  } catch {
    s.scope = null;
  }
}
function normalizeSessionFilePath(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return null;
  const jsonlIndex = firstLine.toLowerCase().indexOf(".jsonl");
  const candidate = jsonlIndex >= 0 ? firstLine.slice(0, jsonlIndex + ".jsonl".length) : firstLine;
  if (!isAbsolute(candidate)) return null;
  if (!candidate.toLowerCase().endsWith(".jsonl")) return null;
  return candidate;
}
function synthesizePausedSessionRecovery(basePath, unitType, unitId, sessionFile) {
  const activityDir = join(gsdRoot(basePath), "activity");
  return synthesizeCrashRecovery(basePath, unitType, unitId, sessionFile, activityDir);
}
function _synthesizePausedSessionRecoveryForTest(basePath, unitType, unitId, sessionFile) {
  return synthesizePausedSessionRecovery(basePath, unitType, unitId, sessionFile);
}
const DETACHED_AUTO_KEEPALIVE_INTERVAL_MS = 3e4;
function withDetachedAutoKeepalive(run) {
  const keepAlive = setInterval(() => {
  }, DETACHED_AUTO_KEEPALIVE_INTERVAL_MS);
  return run.finally(() => {
    clearInterval(keepAlive);
  });
}
const _withDetachedAutoKeepaliveForTest = withDetachedAutoKeepalive;
function startAutoDetached(ctx, pi, base, verboseMode, options) {
  void withDetachedAutoKeepalive(startAuto(ctx, pi, base, verboseMode, options)).catch((err) => {
    const message = getErrorMessage(err);
    ctx.ui.notify(`Auto-start failed: ${message}`, "error");
    logWarning("engine", `auto start error: ${message}`, { file: "auto.ts" });
    debugLog("auto-start-failed", { error: message });
  });
}
function shouldUseWorktreeIsolation(basePath) {
  return getIsolationMode(basePath) === "worktree";
}
import {
  getBudgetAlertLevel as getBudgetAlertLevel2,
  getNewBudgetAlertLevel as getNewBudgetAlertLevel2,
  getBudgetEnforcementAction as getBudgetEnforcementAction2
} from "./auto-budget.js";
function closeOutSignalInterruptedUnit(currentBasePath) {
  const currentUnit = s.currentUnit;
  if (!currentUnit) return;
  const reason = "Auto-mode process received a termination signal";
  const errorContext = {
    message: reason,
    category: "aborted",
    isTransient: false
  };
  const basePath = s.basePath || currentBasePath;
  try {
    emitOpenUnitEndForUnit(basePath, currentUnit.type, currentUnit.id, "cancelled", errorContext);
  } catch (err) {
    logWarning("engine", `signal unit-end cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
  }
  try {
    writeUnitRuntimeRecord(basePath, currentUnit.type, currentUnit.id, currentUnit.startedAt, {
      phase: "crashed",
      lastProgressAt: Date.now(),
      lastProgressKind: "signal"
    });
  } catch (err) {
    logWarning("engine", `signal runtime cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
  }
  try {
    if (s.workerId) markLatestActiveForWorkerCanceled(s.workerId, "signal-exit");
  } catch (err) {
    logWarning("engine", `signal dispatch cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
  }
  try {
    resolveAgentEndCancelled(errorContext);
  } catch (err) {
    logWarning("engine", `signal resolve cleanup failed: ${getErrorMessage(err)}`, { file: "auto.ts" });
  }
}
function registerSigtermHandler(currentBasePath) {
  s.sigtermHandler = _registerSigtermHandler(
    currentBasePath,
    s.sigtermHandler,
    () => closeOutSignalInterruptedUnit(currentBasePath)
  );
}
function deregisterSigtermHandler() {
  _deregisterSigtermHandler(s.sigtermHandler);
  s.sigtermHandler = null;
}
function startAutoCommandPolling(basePath) {
  if (!isRemoteConfigured()) return;
  stopAutoCommandPolling();
  s.commandPollingCleanup = _startCommandPolling(basePath);
}
function stopAutoCommandPolling() {
  if (s.commandPollingCleanup) {
    s.commandPollingCleanup();
    s.commandPollingCleanup = null;
  }
}
function getAutoDashboardData() {
  const ledger = getLedger();
  const totals = ledger ? getProjectTotals(ledger.units) : null;
  const sessionId = s.cmdCtx?.sessionManager?.getSessionId?.() ?? null;
  const rtkSavings = sessionId && s.basePath ? getRtkSessionSavings(s.basePath, sessionId) : null;
  const rtkEnabled = loadEffectiveGSDPreferences(s.basePath || void 0)?.preferences.experimental?.rtk === true;
  let pendingCaptureCount = 0;
  try {
    if (s.basePath) {
      pendingCaptureCount = countPendingCaptures(s.basePath);
    }
  } catch (err) {
    logWarning("engine", `capture count failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }
  return {
    active: s.active,
    paused: s.paused,
    stepMode: s.stepMode,
    startTime: s.autoStartTime,
    elapsed: s.active || s.paused ? s.autoStartTime > 0 ? Date.now() - s.autoStartTime : 0 : 0,
    currentUnit: s.currentUnit ? { ...s.currentUnit } : null,
    basePath: s.basePath,
    totalCost: totals?.cost ?? 0,
    totalTokens: totals?.tokens.total ?? 0,
    pendingCaptureCount,
    rtkSavings,
    rtkEnabled
  };
}
function isAutoActive() {
  return s.active;
}
function isAutoCompletionStopInProgress() {
  return s.completionStopInProgress;
}
function _setAutoActiveForTest(active) {
  s.active = active;
}
function _warnIfWorktreeMissingForTest(worktreePath, milestoneId) {
  if (worktreePath && !existsSync(worktreePath)) {
    logWarning(
      "session",
      `Worktree was expected at ${worktreePath} but is missing. Continuing in project-root mode. To restart with a fresh worktree, run /gsd-debug or recreate the milestone.`,
      { file: "auto.ts", milestoneId }
    );
    return true;
  }
  return false;
}
function isAutoPaused() {
  return s.paused;
}
async function refreshResumeResourcesAndDb(basePath, deps = {}) {
  const env = deps.env ?? process.env;
  const importModule = deps.importModule ?? ((specifier) => import(specifier));
  const agentDir = env.GSD_CODING_AGENT_DIR || join(gsdHome(), "agent");
  const pkgRoot = env.GSD_PKG_ROOT;
  const resourceLoaderPath = pkgRoot ? pathToFileURL(join(pkgRoot, "dist", "resource-loader.js")).href : new URL("../../../resource-loader.js", import.meta.url).href;
  const { initResources } = await importModule(resourceLoaderPath);
  initResources(agentDir);
  const { primeCache } = await importModule("./prompt-loader.js");
  primeCache();
  await (deps.openProjectDb ?? openProjectDbIfPresent)(basePath);
}
function setActiveEngineId(id) {
  s.activeEngineId = id;
}
function getActiveEngineId() {
  return s.activeEngineId;
}
function setActiveRunDir(runDir) {
  s.activeRunDir = runDir;
}
function getActiveRunDir() {
  return s.activeRunDir;
}
function getAutoModeStartModel() {
  return s.autoModeStartModel;
}
function setCurrentDispatchedModelId(model) {
  s.currentDispatchedModelId = model ? `${model.provider}/${model.id}` : null;
}
function markToolStart(toolCallId, toolName) {
  _markToolStart(toolCallId, s.active, toolName);
}
function markToolEnd(toolCallId) {
  _markToolEnd(toolCallId);
}
function recordToolInvocationError(toolName, errorMsg) {
  if (!s.active) return;
  if (isToolInvocationError(errorMsg) || isQueuedUserMessageSkip(errorMsg) || isDeterministicPolicyError(errorMsg)) {
    s.lastToolInvocationError = `${toolName}: ${errorMsg}`;
  }
}
function getOldestInFlightToolAgeMs() {
  return _getOldestInFlightToolAgeMs();
}
function lockBase() {
  return s.lockBasePath;
}
function stopAutoRemote(projectRoot) {
  const lock = readCrashLock(projectRoot);
  if (!lock) return { found: false };
  if (lock.pid === process.pid) {
    clearLock(projectRoot);
    return { found: false };
  }
  if (!isLockProcessAlive(lock)) {
    clearLock(projectRoot);
    return { found: false };
  }
  try {
    process.kill(lock.pid, "SIGTERM");
    return { found: true, pid: lock.pid };
  } catch (err) {
    return { found: false, error: err.message };
  }
}
function checkRemoteAutoSession(projectRoot) {
  const lock = readCrashLock(projectRoot);
  if (!lock) return { running: false };
  if (lock.pid === process.pid) return { running: false };
  if (!isLockProcessAlive(lock)) {
    return { running: false };
  }
  return {
    running: true,
    pid: lock.pid,
    unitType: lock.unitType,
    unitId: lock.unitId,
    startedAt: lock.startedAt
  };
}
function isStepMode() {
  return s.stepMode;
}
function clearUnitTimeout() {
  if (s.unitTimeoutHandle) {
    clearTimeout(s.unitTimeoutHandle);
    s.unitTimeoutHandle = null;
  }
  if (s.wrapupWarningHandle) {
    clearTimeout(s.wrapupWarningHandle);
    s.wrapupWarningHandle = null;
  }
  if (s.idleWatchdogHandle) {
    clearInterval(s.idleWatchdogHandle);
    s.idleWatchdogHandle = null;
  }
  if (s.continueHereHandle) {
    clearInterval(s.continueHereHandle);
    s.continueHereHandle = null;
  }
  clearInFlightTools();
}
function buildSnapshotOpts(_unitType, _unitId) {
  const prefs = loadEffectiveGSDPreferences(s.basePath || void 0)?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  return {
    ...s.autoStartTime > 0 ? { autoSessionKey: String(s.autoStartTime) } : {},
    promptCharCount: s.lastPromptCharCount,
    baselineCharCount: s.lastBaselineCharCount,
    traceId: s.currentTraceId ?? void 0,
    turnId: s.currentTurnId ?? void 0,
    ...uokFlags.gitops ? {
      gitAction: uokFlags.gitopsTurnAction,
      gitPush: uokFlags.gitopsTurnPush,
      gitStatus: s.lastGitActionStatus ?? void 0,
      gitError: s.lastGitActionFailure ?? void 0
    } : {},
    ...s.currentUnitRouting ?? {}
  };
}
function currentUnitLabel() {
  if (!s.currentUnit) return null;
  return `${unitVerb(s.currentUnit.type)} ${s.currentUnit.id}`;
}
function setLifecycleOutcome(ctx, input) {
  if (!ctx?.hasUI) return;
  const { unitLabel: unitLabelOverride, ...rest } = input;
  setAutoOutcomeWidget(ctx, {
    ...rest,
    unitLabel: unitLabelOverride !== void 0 ? unitLabelOverride : currentUnitLabel(),
    startedAt: s.autoStartTime
  });
}
function handleLostSessionLock(ctx, lockStatus) {
  debugLog("session-lock-lost", {
    lockBase: lockBase(),
    reason: lockStatus?.failureReason,
    existingPid: lockStatus?.existingPid,
    expectedPid: lockStatus?.expectedPid
  });
  s.active = false;
  s.paused = false;
  deactivateGSD();
  clearUnitTimeout();
  stopAutoCommandPolling();
  restoreProjectRootEnv();
  restoreMilestoneLockEnv();
  deregisterSigtermHandler();
  const base = lockBase();
  const lockFilePath = base ? join(gsdRoot(base), "auto.lock") : "unknown";
  const recoverySuggestion = "\nTo recover, run: gsd doctor --fix";
  const message = lockStatus?.failureReason === "pid-mismatch" ? lockStatus.existingPid ? `Session lock (${lockFilePath}) moved to PID ${lockStatus.existingPid} \u2014 another GSD process appears to have taken over. Stopping gracefully.${recoverySuggestion}` : `Session lock (${lockFilePath}) moved to a different process \u2014 another GSD process appears to have taken over. Stopping gracefully.${recoverySuggestion}` : lockStatus?.failureReason === "missing-metadata" ? `Session lock metadata (${lockFilePath}) disappeared, so ownership could not be confirmed. Stopping gracefully.${recoverySuggestion}` : lockStatus?.failureReason === "compromised" ? `Session lock (${lockFilePath}) was compromised during heartbeat checks (PID ${process.pid}). This can happen after long event loop stalls during subagent execution.${recoverySuggestion}` : `Session lock lost (${lockFilePath}). Stopping gracefully.${recoverySuggestion}`;
  ctx?.ui.notify(
    message,
    "error"
  );
  ctx?.ui.setStatus("gsd-auto", void 0);
  ctx?.ui.setWidget("gsd-progress", void 0);
  if (ctx) initHealthWidget(ctx);
}
async function rerootCommandSession(cmdCtx, workspaceRoot) {
  if (!cmdCtx || !workspaceRoot) return { status: "skipped" };
  try {
    const result = await cmdCtx.newSession({ workspaceRoot });
    return result.cancelled ? { status: "cancelled" } : { status: "ok" };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
async function cleanupAfterLoopExit(ctx) {
  s.currentUnit = null;
  s.active = false;
  deactivateGSD();
  clearUnitTimeout();
  stopAutoCommandPolling();
  restoreProjectRootEnv();
  restoreMilestoneLockEnv();
  try {
    if (lockBase()) clearLock(lockBase());
    if (lockBase()) releaseSessionLock(lockBase());
  } catch (err) {
    logWarning("session", `lock cleanup failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }
  if (!s.paused) {
    ctx.ui.setStatus("gsd-auto", void 0);
    ctx.ui.setWidget("gsd-progress", void 0);
    if (s.completionStopInProgress) {
      s.completionStopInProgress = false;
    }
    initHealthWidget(ctx);
  }
  if (s.originalBasePath) {
    try {
      buildLifecycle().restoreToProjectRoot();
    } catch (err) {
      logWarning(
        "engine",
        `restore project root failed: ${err instanceof Error ? err.message : String(err)}`,
        { file: "auto.ts" }
      );
    }
  }
  if (s.originalBasePath && s.cmdCtx) {
    const result = await rerootCommandSession(s.cmdCtx, s.originalBasePath);
    if (result.status === "cancelled") {
      logWarning("engine", "post-loop session re-root was cancelled", { file: "auto.ts", basePath: s.originalBasePath });
    } else if (result.status === "failed") {
      logWarning("engine", `post-loop session re-root failed: ${result.error ?? "unknown"}`, { file: "auto.ts", basePath: s.originalBasePath });
    }
  }
}
function _cleanupAfterLoopExitForTest(ctx) {
  return cleanupAfterLoopExit(ctx);
}
function normalizeFrontmatterList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter((item) => item.length > 0 && item !== "(none)");
}
function firstBoldParagraph(body) {
  const match = body.match(/\*\*([^*\n][\s\S]*?)\*\*/);
  return match?.[1]?.replace(/\s+/g, " ").trim() || void 0;
}
function loadMilestoneCompletionRollup(basePath, milestoneId) {
  if (!milestoneId) return {};
  const summaryPath = resolveMilestoneFile(basePath, milestoneId, "SUMMARY");
  if (!summaryPath || !existsSync(summaryPath)) return {};
  try {
    const raw = readFileSync(summaryPath, "utf-8");
    const [frontmatterLines, body] = splitFrontmatter(raw);
    const frontmatter = frontmatterLines ? parseFrontmatterMap(frontmatterLines) : {};
    return {
      milestoneTitle: typeof frontmatter.title === "string" ? frontmatter.title : void 0,
      oneLiner: firstBoldParagraph(body),
      successCriteriaResults: extractSection(body, "Success Criteria Results") ?? void 0,
      definitionOfDoneResults: extractSection(body, "Definition of Done Results") ?? void 0,
      requirementOutcomes: extractSection(body, "Requirement Outcomes") ?? void 0,
      deviations: extractSection(body, "Deviations") ?? void 0,
      followUps: extractSection(body, "Follow-ups") ?? void 0,
      keyDecisions: normalizeFrontmatterList(frontmatter.key_decisions),
      keyFiles: normalizeFrontmatterList(frontmatter.key_files),
      lessonsLearned: normalizeFrontmatterList(frontmatter.lessons_learned)
    };
  } catch (err) {
    logWarning("dashboard", `completion roll-up summary read failed: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}
function _resolveAutoWorktreeExitActionForTest(currentMilestoneId, milestoneMergedInPhases, milestoneComplete) {
  const action = _selectStopAutoWorktreeExit({
    currentMilestoneId: currentMilestoneId ?? null,
    milestoneComplete,
    milestoneMergedInPhases
  });
  return action === "none" ? "skip" : action;
}
async function stopAuto(ctx, pi, reason, options = {}) {
  if (!s.active && !s.paused) return;
  const loadedPreferences = loadEffectiveGSDPreferences(s.basePath || void 0)?.preferences;
  const reasonSuffix = reason ? ` \u2014 ${reason}` : "";
  const preserveCompletionSurface = Boolean(options.completionWidget);
  s.completionStopInProgress = preserveCompletionSurface;
  try {
    const { emitAutoExit } = await import("./worktree-telemetry.js");
    const rawReason = reason ?? "stop";
    const normalizedReason = rawReason.startsWith("Blocked:") ? "blocked" : rawReason.startsWith("Merge conflict") ? "merge-conflict" : rawReason.startsWith("Merge error") || rawReason.startsWith("Merge failed") ? "merge-failed" : rawReason.startsWith("slice-merge-conflict") ? "slice-merge-conflict" : rawReason === "All milestones complete" ? "all-complete" : rawReason === "No active milestone" ? "no-active-milestone" : rawReason === "stop" || rawReason === "pause" ? rawReason : "other";
    const telemetryBase = s.originalBasePath || s.basePath;
    emitAutoExit(telemetryBase, {
      reason: normalizedReason,
      milestoneId: s.currentMilestoneId ?? void 0,
      milestoneMerged: s.milestoneMergedInPhases === true,
      isolationMode: getIsolationMode(telemetryBase),
      worktreeActive: isInAutoWorktree(s.basePath)
    });
  } catch (err) {
    logWarning("engine", `auto-exit telemetry failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    try {
      clearUnitTimeout();
      stopAutoCommandPolling();
      if (lockBase()) clearLock(lockBase());
      if (lockBase()) releaseSessionLock(lockBase());
    } catch (e) {
      debugLog("stop-cleanup-locks", { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      if (s.workerId && s.currentMilestoneId && s.milestoneLeaseToken) {
        releaseMilestoneLease(s.workerId, s.currentMilestoneId, s.milestoneLeaseToken);
      }
      if (s.workerId) {
        markWorkerStopping(s.workerId);
      }
      s.workerId = null;
      s.milestoneLeaseToken = null;
    } catch (e) {
      debugLog("stop-cleanup-coordination", { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      const cmdCtxAny = s.cmdCtx;
      if (typeof cmdCtxAny?.clearQueue === "function") {
        cmdCtxAny.clearQueue();
      }
    } catch (e) {
      debugLog("stop-cleanup-queue", { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      clearSkillSnapshot();
      resetSkillTelemetry();
    } catch (e) {
      debugLog("stop-cleanup-skills", { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      deregisterSigtermHandler();
    } catch (e) {
      debugLog("stop-cleanup-sigterm", { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      if (s.currentMilestoneId && !s.milestoneMergedInPhases) {
        const notifyCtx = ctx ? { notify: ctx.ui.notify.bind(ctx.ui) } : { notify: () => {
        } };
        const lifecycle = buildLifecycle();
        let milestoneComplete = false;
        try {
          if (isDbAvailable()) {
            const dbRow = getMilestone(s.currentMilestoneId);
            milestoneComplete = dbRow?.status === "complete";
          } else {
            const summaryPath = resolveMilestoneFile(
              s.originalBasePath || s.basePath,
              s.currentMilestoneId,
              "SUMMARY"
            );
            if (!summaryPath) {
              const wtSummaryPath = resolveMilestoneFile(
                s.basePath,
                s.currentMilestoneId,
                "SUMMARY"
              );
              milestoneComplete = wtSummaryPath !== null;
            } else {
              milestoneComplete = true;
            }
          }
        } catch (err) {
          logWarning("engine", `milestone summary check failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
        }
        const exitAction = _selectStopAutoWorktreeExit({
          currentMilestoneId: s.currentMilestoneId,
          milestoneComplete,
          milestoneMergedInPhases: s.milestoneMergedInPhases
        });
        if (exitAction === "merge") {
          const r = lifecycle.exitMilestone(
            s.currentMilestoneId,
            { merge: true },
            notifyCtx
          );
          if (!r.ok && r.cause instanceof Error) throw r.cause;
        } else if (exitAction === "preserve") {
          const r = lifecycle.exitMilestone(
            s.currentMilestoneId,
            { merge: false, preserveBranch: true },
            notifyCtx
          );
          if (!r.ok && r.cause instanceof Error) throw r.cause;
        }
      }
    } catch (e) {
      ctx?.ui.notify(
        `Worktree cleanup failed for ${s.currentMilestoneId ?? "current milestone"}: ${e instanceof Error ? e.message : String(e)}. Resolve the preserved branch/worktree and run /gsd auto to resume.`,
        "warning"
      );
      debugLog("stop-cleanup-worktree", { error: e instanceof Error ? e.message : String(e) });
    }
    if (s.basePath) {
      try {
        await rebuildState(s.basePath);
      } catch (e) {
        debugLog("stop-rebuild-state-failed", {
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
    const completionMilestoneId = options.completionWidget?.milestoneId ?? s.currentMilestoneId;
    let completedSlices = null;
    let totalSlices = null;
    if (preserveCompletionSurface && options.completionWidget && completionMilestoneId && isDbAvailable()) {
      try {
        const slices = getMilestoneSlices(completionMilestoneId);
        completedSlices = slices.filter((slice) => isClosedStatus(slice.status)).length;
        totalSlices = slices.length;
      } catch (err) {
        logWarning("dashboard", `completion slice stats lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (isDbAvailable()) {
      try {
        const { closeDatabase } = await import("./gsd-db.js");
        closeDatabase();
      } catch (e) {
        debugLog("db-close-failed", {
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
    if (s.originalBasePath) {
      try {
        buildLifecycle().restoreToProjectRoot();
      } catch (e) {
        debugLog("stop-cleanup-basepath", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (s.originalBasePath && ctx && s.cmdCtx) {
      const result = await rerootCommandSession(s.cmdCtx, s.originalBasePath);
      if (result.status === "cancelled") {
        logWarning("engine", "post-stop session re-root was cancelled", { file: "auto.ts", basePath: s.originalBasePath });
      } else if (result.status === "failed") {
        logWarning("engine", `post-stop session re-root failed: ${result.error ?? "unknown"}`, { file: "auto.ts", basePath: s.originalBasePath });
      }
    }
    try {
      const ledger = getLedger();
      const isAllComplete = reason === "All milestones complete";
      const isMilestoneComplete = /^Milestone\s+\S+\s+complete$/i.test(reason ?? "");
      const notificationPrefix = isAllComplete ? "All milestones complete" : isMilestoneComplete ? `${reason}. Auto-mode finished this milestone` : `Auto-mode stopped${reasonSuffix}`;
      if (ledger && ledger.units.length > 0) {
        const totals = getProjectTotals(ledger.units);
        ctx?.ui.notify(
          `${notificationPrefix}. Session: ${formatCost(totals.cost)} \xB7 ${formatTokenCount(totals.tokens.total)} tokens \xB7 ${ledger.units.length} units`,
          "info"
        );
      } else {
        ctx?.ui.notify(`${notificationPrefix}.`, "info");
      }
    } catch (e) {
      debugLog("stop-cleanup-ledger", { error: e instanceof Error ? e.message : String(e) });
    }
    if (preserveCompletionSurface && ctx && options.completionWidget) {
      const ledger = getLedger();
      const units = ledger?.units ?? [];
      const totals = units.length > 0 ? getProjectTotals(units) : null;
      let totalInput = 0;
      let totalCacheRead = 0;
      try {
        for (const entry of s.cmdCtx?.sessionManager?.getEntries?.() ?? []) {
          if (entry.type === "message") {
            const msgEntry = entry;
            if (msgEntry.message?.role === "assistant") {
              const usage = msgEntry.message.usage;
              if (usage) {
                totalInput += usage.input || 0;
                totalCacheRead += usage.cacheRead || 0;
              }
            }
          }
        }
      } catch (err) {
        logWarning("dashboard", `completion stats lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const contextUsage = s.cmdCtx?.getContextUsage?.();
      const milestoneId = completionMilestoneId;
      const rollup = loadMilestoneCompletionRollup(s.originalBasePath || s.basePath, milestoneId);
      setCompletionProgressWidget(ctx, {
        milestoneId,
        milestoneTitle: options.completionWidget.milestoneTitle ?? rollup.milestoneTitle,
        oneLiner: rollup.oneLiner,
        successCriteriaResults: rollup.successCriteriaResults,
        definitionOfDoneResults: rollup.definitionOfDoneResults,
        requirementOutcomes: rollup.requirementOutcomes,
        deviations: rollup.deviations,
        followUps: rollup.followUps,
        keyDecisions: rollup.keyDecisions,
        keyFiles: rollup.keyFiles,
        lessonsLearned: rollup.lessonsLearned,
        reason: reason ?? "Milestone complete",
        startedAt: s.autoStartTime,
        totalCost: totals?.cost ?? 0,
        totalTokens: totals?.tokens.total ?? 0,
        unitCount: units.length,
        cacheHitRate: totalCacheRead + totalInput > 0 ? totalCacheRead / (totalCacheRead + totalInput) * 100 : null,
        contextPercent: contextUsage?.percent ?? null,
        contextWindow: contextUsage?.contextWindow ?? s.cmdCtx?.model?.contextWindow ?? null,
        completedSlices,
        totalSlices,
        allMilestonesComplete: options.completionWidget.allMilestonesComplete,
        basePath: s.originalBasePath || s.basePath || null
      });
    }
    try {
      pi?.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "clear", preferences: loadedPreferences });
      pi?.events.emit(CMUX_CHANNELS.LOG, {
        preferences: loadedPreferences,
        message: `Auto-mode stopped${reasonSuffix || ""}.`,
        level: reason?.startsWith("Blocked:") ? "warning" : "info"
      });
    } catch (e) {
      debugLog("stop-cleanup-cmux", { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      if (isDebugEnabled()) {
        const logPath = writeDebugSummary();
        if (logPath) {
          ctx?.ui.notify(`Debug log written \u2192 ${logPath}`, "info");
        }
      }
    } catch (e) {
      debugLog("stop-cleanup-debug", { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      resetMetrics();
      resetRoutingHistory();
      resetHookState();
      if (s.basePath) clearPersistedHookState(s.basePath);
    } catch (e) {
      debugLog("stop-cleanup-metrics", { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
    } catch (err) {
      logWarning("engine", `paused-session DB delete failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
    try {
      if (pi && ctx && s.originalModelId && s.originalModelProvider) {
        const original = ctx.modelRegistry.find(
          s.originalModelProvider,
          s.originalModelId
        );
        if (original) await pi.setModel(original);
      }
      if (pi && s.originalThinkingLevel) {
        pi.setThinkingLevel(s.originalThinkingLevel);
      }
    } catch (e) {
      debugLog("stop-cleanup-model", { error: e instanceof Error ? e.message : String(e) });
    }
    try {
      resolveAgentEnd({ messages: [] });
      _resetPendingResolve();
    } catch (e) {
      debugLog("stop-cleanup-pending-resolve", { error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    try {
      const { getBrowser } = await import("../browser-tools/state.js");
      if (getBrowser()) {
        const { closeBrowser } = await import("../browser-tools/lifecycle.js");
        await closeBrowser();
      }
    } catch (err) {
      logWarning("engine", `browser teardown failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
    clearInFlightTools();
    clearSliceProgressCache();
    clearActivityLogState();
    setLevelChangeCallback(null);
    resetProactiveHealing();
    ctx?.ui.setStatus("gsd-auto", void 0);
    if (!preserveCompletionSurface) {
      ctx?.ui.setWidget("gsd-progress", void 0);
      const status = reason?.startsWith("Blocked:") ? "blocked" : reason?.toLowerCase().includes("fail") ? "failed" : "stopped";
      setLifecycleOutcome(ctx, {
        status,
        title: status === "blocked" ? "Auto-mode blocked" : status === "failed" ? "Auto-mode stopped with an issue" : "Auto-mode stopped",
        detail: reason ?? "Auto-mode stopped.",
        nextAction: status === "blocked" ? "Fix the blocker, then run /gsd auto to resume." : "Run /gsd status for the current project state, or /gsd auto to continue.",
        commands: ["/gsd status for overview", "/gsd auto to run", "/gsd visualize to inspect", "/gsd notifications for history"]
      });
      if (ctx) initHealthWidget(ctx);
    }
    restoreProjectRootEnv();
    restoreMilestoneLockEnv();
    if (pi) clearToolBaseline(pi);
    try {
      await s.orchestration?.stop(reason ?? "stop");
    } catch (err) {
      debugLog("stop-orchestration-stop", { error: err instanceof Error ? err.message : String(err) });
    }
    s.resetAfterStop({ preserveCompletionSurface });
  }
}
function _selectStopAutoWorktreeExit(args) {
  if (!args.currentMilestoneId || args.milestoneMergedInPhases) return "none";
  return args.milestoneComplete ? "merge" : "preserve";
}
async function pauseAuto(ctx, _pi, _errorContext) {
  if (!s.active) return;
  clearUnitTimeout();
  stopAutoCommandPolling();
  try {
    const cmdCtxAny = s.cmdCtx;
    if (typeof cmdCtxAny?.clearQueue === "function") {
      cmdCtxAny.clearQueue();
    }
  } catch (e) {
    debugLog("pause-cleanup-queue", { error: e instanceof Error ? e.message : String(e) });
  }
  resolveAgentEndCancelled(_errorContext);
  s.pausedSessionFile = normalizeSessionFilePath(ctx?.sessionManager?.getSessionFile() ?? null);
  try {
    const pausedMeta = {
      milestoneId: s.currentMilestoneId ?? void 0,
      worktreePath: isInAutoWorktree(s.basePath) ? s.basePath : null,
      originalBasePath: s.originalBasePath,
      stepMode: s.stepMode,
      pausedAt: (/* @__PURE__ */ new Date()).toISOString(),
      sessionFile: s.pausedSessionFile,
      unitType: s.currentUnit?.type ?? void 0,
      unitId: s.currentUnit?.id ?? void 0,
      activeEngineId: s.activeEngineId ?? void 0,
      activeRunDir: s.activeRunDir,
      autoStartTime: s.autoStartTime,
      milestoneLock: s.sessionMilestoneLock ?? void 0,
      pauseReason: _errorContext?.message
    };
    setRuntimeKv("global", "", PAUSED_SESSION_KV_KEY, pausedMeta);
  } catch (err) {
    logWarning("engine", `paused-session DB write failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }
  const pausedUnitLabel = currentUnitLabel();
  if (s.currentUnit && ctx) {
    try {
      await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
    } catch (err) {
      logWarning("engine", `unit closeout on pause failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
    s.currentUnit = null;
  }
  if (s.basePath) {
    try {
      await rebuildState(s.basePath);
    } catch (e) {
      debugLog("pause-rebuild-state-failed", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }
  if (lockBase()) {
    releaseSessionLock(lockBase());
    clearLock(lockBase());
  }
  deregisterSigtermHandler();
  resolveAgentEnd({ messages: [] });
  _resetPendingResolve();
  try {
    await s.orchestration?.stop("pause");
  } catch (err) {
    debugLog("pause-orchestration-stop", { error: err instanceof Error ? err.message : String(err) });
  }
  s.active = false;
  s.paused = true;
  deactivateGSD();
  restoreProjectRootEnv();
  restoreMilestoneLockEnv();
  s.pendingVerificationRetry = null;
  s.verificationRetryCount.clear();
  ctx?.ui.setStatus("gsd-auto", "paused");
  ctx?.ui.setWidget("gsd-progress", void 0);
  const resumeCmd = s.stepMode ? "/gsd next" : "/gsd auto";
  setLifecycleOutcome(ctx, {
    status: "paused",
    title: `${s.stepMode ? "Step" : "Auto"}-mode paused`,
    detail: _errorContext?.message ?? "Paused by user request.",
    nextAction: `Type to steer, or run ${resumeCmd} to resume.`,
    commands: [resumeCmd, "/gsd status for overview", "/gsd notifications for history"],
    unitLabel: pausedUnitLabel
  });
  if (ctx) initHealthWidget(ctx);
  ctx?.ui.notify(
    `${s.stepMode ? "Step" : "Auto"}-mode paused (Escape). Type to interact, or ${resumeCmd} to resume.`,
    "info"
  );
}
function buildWorktreeLifecycleDeps() {
  return {
    gitServiceFactory: (basePath) => {
      const gitConfig = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
      return new GitServiceImpl(basePath, gitConfig);
    },
    worktreeProjection: new WorktreeStateProjection(),
    mergeMilestoneToMain
  };
}
function buildLifecycle() {
  return new WorktreeLifecycle(s, buildWorktreeLifecycleDeps());
}
function createWiredDispatchAdapter(ctx, pi, dispatchBasePath) {
  return {
    async decideNextUnit(input) {
      const state = input.stateSnapshot;
      const active = state.activeMilestone;
      if (!active) return null;
      const prefs = loadEffectiveGSDPreferences(dispatchBasePath)?.preferences;
      const sessionProvider = input.sessionProvider ?? ctx.model?.provider;
      const sessionContextWindow = input.sessionContextWindow ?? ctx.model?.contextWindow;
      const modelRegistry = input.modelRegistry ?? ctx.modelRegistry;
      const authMode = sessionProvider && typeof ctx.modelRegistry?.getProviderAuthMode === "function" ? ctx.modelRegistry.getProviderAuthMode(sessionProvider) : void 0;
      const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
      const structuredQuestionsAvailable = input.structuredQuestionsAvailable ?? (prefs?.planning_depth === "deep" ? "false" : supportsStructuredQuestions(activeTools, {
        authMode,
        baseUrl: ctx.model?.baseUrl
      }) ? "true" : "false");
      const action = await resolveDispatch({
        basePath: dispatchBasePath,
        mid: active.id,
        midTitle: active.title,
        state,
        prefs,
        structuredQuestionsAvailable,
        sessionContextWindow,
        sessionProvider,
        modelRegistry
      });
      if (action.action === "stop") {
        return {
          kind: "blocked",
          reason: action.reason,
          action: action.level === "warning" ? "pause" : "stop"
        };
      }
      if (action.action !== "dispatch") return null;
      return {
        unitType: action.unitType,
        unitId: action.unitId,
        reason: action.matchedRule ?? "dispatch",
        preconditions: []
      };
    }
  };
}
function createWiredAutoOrchestrationModule(ctx, pi, dispatchBasePath, runtimeBasePath = resolveProjectRoot(dispatchBasePath)) {
  const flowId = `auto-orchestrator-${Date.now()}`;
  let seq = 0;
  const deps = {
    stateReconciliation: {
      async reconcileBeforeDispatch() {
        const result = await reconcileBeforeDispatch(dispatchBasePath);
        if (result.blockers.length > 0) {
          return {
            ok: false,
            reason: result.blockers[0],
            stateSnapshot: result.stateSnapshot
          };
        }
        const repairedKinds = result.repaired.map((d) => d.kind);
        return {
          ok: true,
          reason: repairedKinds.length > 0 ? `repaired: ${repairedKinds.join(", ")}` : "clean",
          stateSnapshot: result.stateSnapshot
        };
      }
    },
    dispatch: createWiredDispatchAdapter(ctx, pi, dispatchBasePath),
    recovery: {
      async classifyAndRecover(input) {
        const recovery = classifyFailure(input);
        return { action: recovery.action, reason: recovery.reason };
      }
    },
    toolContract: {
      async compileUnitToolContract(unitType) {
        const result = compileUnitToolContract(unitType);
        if (!result.ok) return { ok: false, reason: result.detail };
        return { ok: true, reason: result.contract.validationRules.join(", ") };
      }
    },
    worktree: {
      async prepareForUnit(unitType, unitId) {
        const manifest = resolveManifest(unitType);
        if (!manifest) {
          return {
            ok: false,
            reason: `No Unit manifest is registered for ${unitType}`
          };
        }
        const writeScope = manifest.tools.mode === "all" || manifest.tools.mode === "docs" ? "source-writing" : "planning-only";
        const safety = createWorktreeSafetyModule();
        const snapshot = await deriveState(dispatchBasePath);
        const milestoneId = snapshot.activeMilestone?.id ?? null;
        const expectedBranch = milestoneId ? autoWorktreeBranch(milestoneId) : null;
        const result = safety.validateUnitRoot({
          unitType,
          unitId,
          writeScope,
          projectRoot: runtimeBasePath,
          unitRoot: dispatchBasePath,
          milestoneId,
          expectedBranch
        });
        if (!result.ok) {
          return { ok: false, reason: `${result.kind}: ${result.reason}` };
        }
        return { ok: true, reason: result.kind };
      },
      async syncAfterUnit() {
      },
      async cleanupOnStop() {
      }
    },
    health: {
      checkResourcesStale() {
        return checkResourcesStale(s.resourceVersionOnStart);
      },
      async preAdvanceGate() {
        try {
          const gate = await preDispatchHealthGate(dispatchBasePath);
          if (gate.proceed) {
            return {
              kind: "pass",
              fixesApplied: gate.fixesApplied
            };
          }
          return {
            kind: "fail",
            reason: gate.reason ?? "Pre-dispatch health check failed \u2014 run /gsd doctor for details."
          };
        } catch (error) {
          return { kind: "threw", error };
        }
      },
      async postAdvanceRecord(result) {
        if (result.kind === "error") {
          recordHealthSnapshot(1, 0, 0, [{
            code: "orchestration-error",
            message: result.reason ?? "orchestration error",
            severity: "error",
            unitId: "orchestration"
          }], [], "orchestration");
        } else if (result.kind === "blocked") {
          recordHealthSnapshot(0, 1, 0, [{
            code: "orchestration-blocked",
            message: result.reason ?? "orchestration blocked",
            severity: "warning",
            unitId: "orchestration"
          }], [], "orchestration");
        }
      }
    },
    runtime: {
      async ensureLockOwnership() {
        const status = getSessionLockStatus(runtimeBasePath);
        if (!status.valid || status.failureReason === "pid-mismatch") {
          throw new Error("session lock held by another process");
        }
      },
      async journalTransition(event) {
        const eventType = event.name === "start" ? "iteration-start" : event.name === "resume" ? "iteration-start" : event.name === "advance" ? "dispatch-match" : event.name === "advance-blocked" ? "guard-block" : event.name === "advance-stopped" ? "dispatch-stop" : event.name === "advance-error" ? "iteration-end" : event.name === "advance-paused" || event.name === "advance-retry" ? "guard-block" : event.name === "stop" ? "terminal" : "iteration-end";
        _emitJournalEvent(runtimeBasePath, {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          flowId,
          seq: ++seq,
          eventType,
          data: {
            source: "auto-orchestrator",
            name: event.name,
            reason: event.reason,
            unitType: event.unitType,
            unitId: event.unitId
          }
        });
      }
    },
    notifications: {
      async notifyLifecycle(event) {
        if (event.name === "error") {
          ctx.ui.notify(event.detail ?? "auto orchestration error", "error");
        }
      }
    },
    uokGate: {
      async emit(input) {
        const prefs = loadEffectiveGSDPreferences(dispatchBasePath)?.preferences;
        const uokFlags = resolveUokFlags(prefs);
        if (!uokFlags.gates) return;
        const milestoneId = input.milestoneId ?? s.currentMilestoneId ?? void 0;
        try {
          const { UokGateRunner } = await import("./uok/gate-runner.js");
          const runner = new UokGateRunner();
          runner.register({
            id: input.gateId,
            type: input.gateType,
            execute: async () => ({
              outcome: input.outcome,
              failureClass: input.failureClass,
              rationale: input.rationale,
              findings: input.findings ?? ""
            })
          });
          await runner.run(input.gateId, {
            basePath: dispatchBasePath,
            traceId: `pre-dispatch:${flowId}`,
            turnId: `orch-${seq}`,
            milestoneId,
            unitType: "pre-dispatch",
            unitId: `orch-${seq}`
          });
        } catch (err) {
          logWarning("engine", `uok gate emit failed: ${getErrorMessage(err)}`, {
            file: "auto.ts",
            gateId: input.gateId,
            gateType: input.gateType,
            ...milestoneId ? { milestoneId } : {}
          });
        }
      }
    }
  };
  return createAutoOrchestrator(deps);
}
function notifyResumeBlocked(ctx, result) {
  const resumeCmd = s.stepMode ? "/gsd next" : "/gsd auto";
  ctx.ui.notify(`Auto-mode blocked: ${result.reason}. Fix and run ${resumeCmd} to resume.`, "warning");
  setLifecycleOutcome(ctx, {
    status: "blocked",
    title: "Auto-mode blocked",
    detail: result.reason,
    nextAction: `Fix the blocker, then run ${resumeCmd} to resume.`,
    commands: ["/gsd status for overview", `${resumeCmd} to resume`, "/gsd doctor to diagnose"]
  });
}
function ensureOrchestrationModule(ctx, pi, basePath) {
  s.orchestration = createWiredAutoOrchestrationModule(ctx, pi, basePath, lockBase());
}
function buildLoopDeps(pi) {
  initRegistry(convertDispatchRules(DISPATCH_RULES));
  const cmux = makeCmuxEmitters(pi);
  const worktreeProjection = new WorktreeStateProjection();
  return {
    lockBase,
    buildSnapshotOpts,
    stopAuto,
    pauseAuto,
    clearUnitTimeout,
    updateProgressWidget,
    ...cmux,
    handleLostSessionLock: (ctx, lockStatus) => {
      cmux.clearCmuxSidebar(loadEffectiveGSDPreferences(s.basePath || void 0)?.preferences);
      handleLostSessionLock(ctx, lockStatus);
    },
    // State and cache
    invalidateAllCaches,
    deriveState,
    rebuildState,
    loadEffectiveGSDPreferences,
    // Pre-dispatch health gate
    preDispatchHealthGate,
    // Worktree state projection (ADR-016 — single Module Interface)
    worktreeProjection,
    // Resource version guard
    checkResourcesStale,
    // Session lock
    validateSessionLock: getSessionLockStatus,
    updateSessionLock,
    // Milestone transition
    sendDesktopNotification,
    setActiveMilestoneId,
    pruneQueueOrder,
    isInAutoWorktree,
    shouldUseWorktreeIsolation,
    teardownAutoWorktree,
    createAutoWorktree,
    captureIntegrationBranch,
    getIsolationMode,
    getCurrentBranch,
    autoWorktreeBranch,
    resolveMilestoneFile,
    reconcileMergeState,
    // Budget/context/secrets
    getLedger,
    getProjectTotals,
    formatCost,
    getBudgetAlertLevel,
    getNewBudgetAlertLevel,
    getBudgetEnforcementAction,
    getManifestStatus,
    collectSecretsFromManifest,
    // Dispatch
    resolveDispatch,
    runPreDispatchHooks,
    getPriorSliceCompletionBlocker,
    getMainBranch,
    // Unit closeout + runtime records
    closeoutUnit,
    autoCommitUnit,
    recordOutcome,
    writeLock,
    captureAvailableSkills,
    ensurePreconditions,
    updateSliceProgressCache,
    // Model selection + supervision
    selectAndApplyModel,
    resolveModelId,
    startUnitSupervision,
    // Prompt helpers
    getDeepDiagnostic: (basePath) => {
      const mid = readActiveMilestoneId(basePath);
      const wtPath = mid ? getAutoWorktreePath(basePath, mid) : void 0;
      return getDeepDiagnostic(basePath, wtPath ?? void 0);
    },
    isDbAvailable,
    reorderForCaching,
    // Filesystem
    existsSync,
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    atomicWriteSync,
    // Git
    GitServiceImpl,
    // Worktree Lifecycle Module (ADR-016 — single Module Interface for the
    // milestone create/enter/exit/merge verbs)
    lifecycle: buildLifecycle(),
    // Post-unit processing
    postUnitPreVerification,
    runPostUnitVerification,
    postUnitPostVerification,
    // Session manager
    getSessionFile: (ctx) => {
      try {
        return ctx.sessionManager?.getSessionFile() ?? "";
      } catch {
        return "";
      }
    },
    // Journal
    emitJournalEvent: (entry) => _emitJournalEvent(s.basePath, entry),
    // Clean-root preflight gate (#2909)
    preflightCleanRoot,
    postflightPopStash
  };
}
async function startAuto(ctx, pi, base, verboseMode, options) {
  if (s.active) {
    debugLog("startAuto", { phase: "already-active", skipping: true });
    return;
  }
  if (!s.paused) clearToolBaseline(pi);
  const requestedStepMode = options?.step ?? false;
  const interruptedAssessment = options?.interrupted ?? null;
  if (options?.milestoneLock !== void 0) {
    s.sessionMilestoneLock = options.milestoneLock ?? null;
  }
  if (s.sessionMilestoneLock) {
    captureMilestoneLockEnv(s.sessionMilestoneLock);
  }
  base = escapeStaleWorktree(base);
  const dirCheck = validateDirectory(base);
  if (dirCheck.severity === "blocked") {
    ctx.ui.notify(dirCheck.reason, "error");
    return;
  }
  if (recoverFailedMigration(base)) {
    ctx.ui.notify("Recovered unfinished migration (.gsd.migrating \u2192 .gsd).", "info");
  }
  const freshStartAssessment = await (interruptedAssessment ?? (() => {
    return ensureDbOpen(base).then(() => assessInterruptedSession(base));
  })());
  if (freshStartAssessment.classification === "running") {
    const pid = freshStartAssessment.lock?.pid;
    ctx.ui.notify(
      pid ? `Another auto-mode session (PID ${pid}) appears to be running.
Stop it with \`kill ${pid}\` before starting a new session.` : "Another auto-mode session appears to be running.",
      "error"
    );
    return;
  }
  const clearPausedSession = (logTag) => {
    try {
      deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
    } catch (err) {
      logWarning("session", `${logTag}: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
  };
  if (!s.paused) {
    try {
      const meta = freshStartAssessment.pausedSession ?? readPausedSessionMetadata(base);
      if (meta?.activeEngineId && meta.activeEngineId !== "dev") {
        s.activeEngineId = meta.activeEngineId;
        s.activeRunDir = meta.activeRunDir ?? null;
        s.originalBasePath = meta.originalBasePath || base;
        s.stepMode = meta.stepMode ?? requestedStepMode;
        s.autoStartTime = meta.autoStartTime || Date.now();
        s.sessionMilestoneLock = meta.milestoneLock ?? null;
        s.paused = true;
        ctx.ui.notify(
          `Resuming paused custom workflow${meta.activeRunDir ? ` (${meta.activeRunDir})` : ""}.`,
          "info"
        );
      } else if (meta?.milestoneId) {
        const shouldResumePausedSession = freshStartAssessment.classification === "recoverable" && (freshStartAssessment.hasResumableDiskState || !!freshStartAssessment.recoveryPrompt || !!freshStartAssessment.lock);
        if (shouldResumePausedSession) {
          const mDir = resolveMilestonePath(base, meta.milestoneId);
          let summaryIsTerminal = false;
          let dbAvailable = isDbAvailable();
          let milestoneRow = dbAvailable ? getMilestone(meta.milestoneId) : null;
          if (!milestoneRow) {
            const opened = await ensureDbOpen(base);
            dbAvailable = opened || isDbAvailable();
            if (dbAvailable) {
              milestoneRow = getMilestone(meta.milestoneId);
            }
          }
          if (dbAvailable) {
            summaryIsTerminal = !!milestoneRow && isClosedStatus(milestoneRow.status);
          } else {
            const summaryFile = resolveMilestoneFile(base, meta.milestoneId, "SUMMARY");
            if (summaryFile) {
              try {
                summaryIsTerminal = classifyMilestoneSummaryContent(readFileSync(summaryFile, "utf-8")) !== "failure";
              } catch {
                summaryIsTerminal = false;
              }
            }
          }
          if (!mDir || summaryIsTerminal) {
            clearPausedSession("paused-session DB cleanup failed (milestone gone/complete)");
            ctx.ui.notify(
              `Paused milestone ${meta.milestoneId} is ${!mDir ? "missing" : "already complete"}. Starting fresh.`,
              "info"
            );
          } else {
            s.currentMilestoneId = meta.milestoneId;
            s.originalBasePath = meta.originalBasePath || base;
            s.stepMode = meta.stepMode ?? requestedStepMode;
            s.pausedSessionFile = normalizeSessionFilePath(meta.sessionFile ?? null);
            s.pausedUnitType = meta.unitType ?? null;
            s.pausedUnitId = meta.unitId ?? null;
            s.autoStartTime = meta.autoStartTime || Date.now();
            s.sessionMilestoneLock = meta.milestoneLock ?? null;
            s.paused = true;
            {
              const persistedWorktreePath = meta.worktreePath ?? null;
              if (persistedWorktreePath && !existsSync(persistedWorktreePath)) {
                logWarning(
                  "session",
                  `Worktree was expected at ${persistedWorktreePath} but is missing. Continuing in project-root mode. To restart with a fresh worktree, run /gsd-debug or recreate the milestone.`,
                  { file: "auto.ts", milestoneId: meta.milestoneId ?? "" }
                );
              }
              const rawForScope = persistedWorktreePath && existsSync(persistedWorktreePath) ? persistedWorktreePath : s.originalBasePath || base;
              rebuildScope(rawForScope, s.currentMilestoneId);
            }
            ctx.ui.notify(
              `Resuming paused session for ${meta.milestoneId}${meta.worktreePath && existsSync(meta.worktreePath) ? ` (worktree)` : ""}.`,
              "info"
            );
          }
        } else if (meta) {
          clearPausedSession("stale paused-session DB cleanup failed");
        }
      }
    } catch (err) {
      logWarning("session", `paused-session restore failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
    }
    if (!s.autoStartTime || s.autoStartTime <= 0) s.autoStartTime = Date.now();
  }
  if (s.sessionMilestoneLock) {
    captureMilestoneLockEnv(s.sessionMilestoneLock);
  }
  if (!s.paused) {
    s.stepMode = requestedStepMode;
  }
  if (freshStartAssessment.lock) {
    emitCrashRecoveredUnitEnd(base, freshStartAssessment.lock);
    clearStaleWorkerLock(base);
  }
  if (!s.paused) {
    s.pendingCrashRecovery = freshStartAssessment.classification === "recoverable" ? freshStartAssessment.recoveryPrompt : null;
    if (freshStartAssessment.classification === "recoverable" && freshStartAssessment.lock) {
      const info = formatCrashInfo(freshStartAssessment.lock);
      if (freshStartAssessment.recoveryToolCallCount > 0) {
        ctx.ui.notify(
          `${info}
Recovered ${freshStartAssessment.recoveryToolCallCount} tool calls from crashed session. Resuming with full context.`,
          "warning"
        );
      } else if (freshStartAssessment.hasResumableDiskState) {
        ctx.ui.notify(`${info}
Resuming from disk state.`, "warning");
      }
    }
  }
  if (s.paused) {
    const resumeLock = acquireSessionLock(base);
    if (!resumeLock.acquired) {
      s.paused = false;
      ctx.ui.notify(`Cannot resume: ${resumeLock.reason}`, "error");
      return;
    }
    s.paused = false;
    s.active = true;
    s.verbose = verboseMode;
    s.stepMode = requestedStepMode;
    s.cmdCtx = ctx;
    buildLifecycle().adoptSessionRoot(base);
    const resumeWorktreePath = freshStartAssessment.pausedSession?.worktreePath ?? null;
    if (resumeWorktreePath && !existsSync(resumeWorktreePath)) {
      logWarning(
        "session",
        `Worktree was expected at ${resumeWorktreePath} but is missing. Continuing in project-root mode. To restart with a fresh worktree, run /gsd-debug or recreate the milestone.`,
        { file: "auto.ts", milestoneId: s.currentMilestoneId ?? "" }
      );
    }
    buildLifecycle().resumeFromPausedSession(base, resumeWorktreePath);
    rebuildScope(s.basePath, s.currentMilestoneId);
    setLogBasePath(base);
    s.unitDispatchCount.clear();
    s.unitLifetimeDispatches.clear();
    if (!getLedger()) initMetrics(base);
    if (s.currentMilestoneId) setActiveMilestoneId(base, s.currentMilestoneId);
    await openProjectDbIfPresent(base);
    registerAutoWorkerForSession(s, base);
    setLevelChangeCallback((_from, to, summary) => {
      const level = to === "red" ? "error" : to === "yellow" ? "warning" : "info";
      ctx.ui.notify(summary, level);
    });
    if (s.currentMilestoneId && getIsolationMode(s.originalBasePath || s.basePath) !== "none" && s.originalBasePath && !isInAutoWorktree(s.basePath) && !detectWorktreeName(s.basePath) && !detectWorktreeName(s.originalBasePath)) {
      const enterResult = buildLifecycle().enterMilestone(s.currentMilestoneId, {
        notify: ctx.ui.notify.bind(ctx.ui)
      });
      if (!enterResult.ok && enterResult.reason === "lease-conflict") {
        ctx.ui.notify(
          `Cannot resume milestone ${s.currentMilestoneId}: lease is held by another worker.`,
          "error"
        );
        await stopAuto(ctx, pi, "lease-conflict during resume");
        return;
      }
      rebuildScope(s.basePath, s.currentMilestoneId);
    }
    ensureOrchestrationModule(ctx, pi, s.basePath || base);
    registerSigtermHandler(lockBase());
    ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
    ctx.ui.setWidget("gsd-health", void 0);
    ctx.ui.notify(
      s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.",
      "info"
    );
    restoreHookState(s.basePath);
    await refreshResumeResourcesAndDb(s.basePath);
    try {
      await rebuildState(s.basePath);
      pi.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "sync", preferences: loadEffectiveGSDPreferences(s.basePath || void 0)?.preferences, state: await deriveState(s.basePath) });
    } catch (e) {
      debugLog("resume-rebuild-state-failed", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    try {
      const report = await runGSDDoctor(s.basePath, { fix: true });
      if (report.fixesApplied.length > 0) {
        ctx.ui.notify(
          `Resume: applied ${report.fixesApplied.length} fix(es) to state.`,
          "info"
        );
      }
    } catch (e) {
      debugLog("resume-doctor-failed", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    invalidateAllCaches();
    if (s.pausedSessionFile) {
      const recovery = synthesizePausedSessionRecovery(
        s.basePath,
        s.currentUnit?.type ?? s.pausedUnitType ?? "unknown",
        s.currentUnit?.id ?? s.pausedUnitId ?? "unknown",
        s.pausedSessionFile
      );
      if (recovery && recovery.trace.toolCallCount > 0) {
        s.pendingCrashRecovery = recovery.prompt;
        ctx.ui.notify(
          `Recovered ${recovery.trace.toolCallCount} tool calls from paused session. Resuming with context.`,
          "info"
        );
      }
      s.pausedSessionFile = null;
    }
    captureProjectRootEnv(s.originalBasePath || s.basePath);
    registerAutoWorkerForSession(s);
    updateSessionLock(
      lockBase(),
      "resuming",
      s.currentMilestoneId ?? "unknown"
    );
    if (s.workerId) {
      writeLock(
        lockBase(),
        "resuming",
        s.currentMilestoneId ?? "unknown"
      );
      clearPausedSession("paused-session DB cleanup failed (resume activation)");
    }
    pi.events.emit(CMUX_CHANNELS.LOG, { preferences: loadEffectiveGSDPreferences(s.basePath || void 0)?.preferences, message: s.stepMode ? "Step-mode resumed." : "Auto-mode resumed.", level: "progress" });
    try {
      const resumeResult = await s.orchestration?.resume();
      if (resumeResult?.kind === "blocked") {
        notifyResumeBlocked(ctx, resumeResult);
        await cleanupAfterLoopExit(ctx);
        return;
      }
    } catch (err) {
      debugLog("resume-orchestration-resume", { error: err instanceof Error ? err.message : String(err) });
    }
    startAutoCommandPolling(s.basePath);
    await runAutoLoopWithUok({
      ctx,
      pi,
      s,
      deps: buildLoopDeps(pi),
      runKernelLoop: runUokKernelLoop,
      runLegacyLoop: runLegacyAutoLoop
    });
    await cleanupAfterLoopExit(ctx);
    return;
  }
  const bootstrapDeps = {
    shouldUseWorktreeIsolation,
    registerSigtermHandler,
    registerAutoWorkerForSession: (projectRoot) => registerAutoWorkerForSession(s, projectRoot),
    lockBase,
    buildLifecycle
  };
  registerAutoWorkerForSession(s, base);
  const ready = await bootstrapAutoSession(
    s,
    ctx,
    pi,
    base,
    verboseMode,
    requestedStepMode,
    bootstrapDeps,
    freshStartAssessment
  );
  if (!ready) return;
  rebuildScope(s.basePath, s.currentMilestoneId);
  ensureOrchestrationModule(ctx, pi, s.basePath || base);
  captureProjectRootEnv(s.originalBasePath || s.basePath);
  registerAutoWorkerForSession(s);
  try {
    pi.events.emit(CMUX_CHANNELS.SIDEBAR, { action: "sync", preferences: loadEffectiveGSDPreferences(s.basePath || void 0)?.preferences, state: await deriveState(s.basePath) });
  } catch (err) {
    logWarning("engine", `cmux sync failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
  }
  pi.events.emit(CMUX_CHANNELS.LOG, { preferences: loadEffectiveGSDPreferences(s.basePath || void 0)?.preferences, message: requestedStepMode ? "Step-mode started." : "Auto-mode started.", level: "progress" });
  try {
    await s.orchestration?.start({ basePath: s.basePath, trigger: "auto-loop" });
  } catch (err) {
    debugLog("start-orchestration-start", { error: err instanceof Error ? err.message : String(err) });
  }
  startAutoCommandPolling(s.basePath);
  await runAutoLoopWithUok({
    ctx,
    pi,
    s,
    deps: buildLoopDeps(pi),
    runKernelLoop: runUokKernelLoop,
    runLegacyLoop: runLegacyAutoLoop
  });
  await cleanupAfterLoopExit(ctx);
}
import { describeNextUnit } from "./auto-dashboard.js";
function updateProgressWidget(ctx, unitType, unitId, state) {
  const badge = s.currentUnitRouting?.tier ? { light: "L", standard: "S", heavy: "H" }[s.currentUnitRouting.tier] ?? void 0 : void 0;
  _updateProgressWidget(
    ctx,
    unitType,
    unitId,
    state,
    widgetStateAccessors,
    badge
  );
}
const widgetStateAccessors = {
  getAutoStartTime: () => s.autoStartTime,
  isStepMode: () => s.stepMode,
  getCmdCtx: () => s.cmdCtx,
  getBasePath: () => s.basePath,
  isVerbose: () => s.verbose,
  isSessionSwitching: isSessionSwitchInFlight,
  getCurrentDispatchedModelId: () => s.currentDispatchedModelId
};
function ensurePreconditions(unitType, unitId, base, state) {
  const { milestone: mid, slice: sid } = parseUnitId(unitId);
  const mDir = resolveMilestonePath(base, mid);
  if (!mDir) {
    if (sid !== void 0) {
      const hasDbRow = isDbAvailable() && getMilestone(mid) != null;
      if (!hasDbRow) {
        logWarning("engine", `ensurePreconditions: skipping mkdir for unrecognised milestone ${mid} referenced by slice unit ${unitId} \u2014 no DB row exists`, { file: "auto.ts" });
        return;
      }
    }
    const newDir = join(milestonesDir(base), mid);
    mkdirSync(join(newDir, "slices"), { recursive: true });
  }
  if (sid !== void 0) {
    const mDirResolved = resolveMilestonePath(base, mid);
    if (mDirResolved) {
      const slicesDir = join(mDirResolved, "slices");
      const sDir = resolveDir(slicesDir, sid);
      if (!sDir) {
        mkdirSync(join(slicesDir, sid, "tasks"), { recursive: true });
      }
      const resolvedSliceDir = resolveDir(slicesDir, sid) ?? sid;
      const tasksDir = join(slicesDir, resolvedSliceDir, "tasks");
      if (!existsSync(tasksDir)) {
        mkdirSync(tasksDir, { recursive: true });
      }
    }
  }
}
async function dispatchHookUnit(ctx, pi, hookName, triggerUnitType, triggerUnitId, hookPrompt, hookModel, targetBasePath) {
  const wasActive = s.active;
  const previousBasePath = s.basePath;
  const previousCurrentUnit = s.currentUnit ? { ...s.currentUnit } : null;
  if (!s.active) {
    s.active = true;
    s.stepMode = true;
    s.cmdCtx = ctx;
    s.autoStartTime = Date.now();
    s.currentUnit = null;
    s.pendingQuickTasks = [];
  }
  buildLifecycle().adoptSessionRoot(targetBasePath);
  if (!s.orchestration) {
    ensureOrchestrationModule(ctx, pi, s.basePath);
  }
  const hookUnitType = `hook/${hookName}`;
  const hookStartedAt = Date.now();
  s.currentUnit = {
    type: triggerUnitType,
    id: triggerUnitId,
    startedAt: hookStartedAt
  };
  const result = await s.cmdCtx.newSession({ workspaceRoot: s.basePath });
  if (result.cancelled) {
    await stopAuto(ctx, pi);
    return false;
  }
  s.currentUnit = {
    type: hookUnitType,
    id: triggerUnitId,
    startedAt: hookStartedAt
  };
  if (hookModel) {
    const availableModels = ctx.modelRegistry.getAvailable();
    const match = resolveModelId(hookModel, availableModels, ctx.model?.provider);
    if (match) {
      try {
        await pi.setModel(match);
      } catch (err) {
        logWarning("dispatch", `hook model set failed: ${err instanceof Error ? err.message : String(err)}`, { file: "auto.ts" });
      }
    } else {
      ctx.ui.notify(
        `Hook model "${hookModel}" not found in available models. Falling back to current session model. Ensure the model is defined in models.json and has auth configured.`,
        "warning"
      );
    }
  }
  const sessionFile = normalizeSessionFilePath(ctx.sessionManager.getSessionFile());
  writeLock(
    lockBase(),
    hookUnitType,
    triggerUnitId,
    sessionFile ?? void 0
  );
  clearUnitTimeout();
  const supervisor = resolveAutoSupervisorConfig();
  const hookHardTimeoutMs = (supervisor.hard_timeout_minutes ?? 30) * 60 * 1e3;
  s.unitTimeoutHandle = setTimeout(async () => {
    s.unitTimeoutHandle = null;
    if (!s.active) return;
    ctx.ui.notify(
      `Hook ${hookName} exceeded ${supervisor.hard_timeout_minutes ?? 30}min timeout. Pausing auto-mode.`,
      "warning"
    );
    resetHookState();
    await pauseAuto(ctx, pi);
  }, hookHardTimeoutMs);
  ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
  ctx.ui.notify(`Running post-unit hook: ${hookName}`, "info");
  debugLog("dispatchHookUnit", {
    phase: "send-message",
    promptLength: hookPrompt.length
  });
  pi.sendMessage(
    { customType: "gsd-auto", content: hookPrompt, display: true },
    { triggerTurn: true }
  );
  return true;
}
import {
  buildLoopRemediationSteps as buildLoopRemediationSteps2
} from "./auto-recovery.js";
import { resolveExpectedArtifactPath } from "./auto-artifact-paths.js";
export {
  NEW_SESSION_TIMEOUT_MS2 as NEW_SESSION_TIMEOUT_MS,
  STUB_RECOVERY_THRESHOLD2 as STUB_RECOVERY_THRESHOLD,
  _captureProjectRootEnvForTest,
  _cleanupAfterLoopExitForTest,
  _resolveAutoWorktreeExitActionForTest,
  _restoreProjectRootEnvForTest,
  _selectStopAutoWorktreeExit,
  _setAutoActiveForTest,
  _synthesizePausedSessionRecoveryForTest,
  _warnIfWorktreeMissingForTest,
  _withDetachedAutoKeepaliveForTest,
  buildLoopRemediationSteps2 as buildLoopRemediationSteps,
  buildWorktreeLifecycleDeps,
  checkRemoteAutoSession,
  cleanupAfterLoopExit,
  createWiredAutoOrchestrationModule,
  createWiredDispatchAdapter,
  describeNextUnit,
  dispatchHookUnit,
  ensurePreconditions,
  getActiveEngineId,
  getActiveRunDir,
  getAutoDashboardData,
  getAutoModeStartModel,
  getBudgetAlertLevel2 as getBudgetAlertLevel,
  getBudgetEnforcementAction2 as getBudgetEnforcementAction,
  getNewBudgetAlertLevel2 as getNewBudgetAlertLevel,
  getOldestInFlightToolAgeMs,
  inlinePriorMilestoneSummary,
  isAutoActive,
  isAutoCompletionStopInProgress,
  isAutoPaused,
  isStepMode,
  markToolEnd,
  markToolStart,
  pauseAuto,
  recordToolInvocationError,
  refreshResumeResourcesAndDb,
  rerootCommandSession,
  resolveExpectedArtifactPath,
  setActiveEngineId,
  setActiveRunDir,
  setCurrentDispatchedModelId,
  shouldUseWorktreeIsolation,
  startAuto,
  startAutoDetached,
  stopAuto,
  stopAutoRemote
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogQXV0by1tb2RlIG9yY2hlc3RyYXRpb24sIHNlc3Npb24gbGlmZWN5Y2xlLCBhbmQgc3RvcCBoYW5kbGluZy5cbi8qKlxuICogR1NEIEF1dG8gTW9kZSBcdTIwMTQgRnJlc2ggU2Vzc2lvbiBQZXIgVW5pdFxuICpcbiAqIFN0YXRlIG1hY2hpbmUgZHJpdmVuIGJ5IC5nc2QvIGZpbGVzIG9uIGRpc2suIEVhY2ggXCJ1bml0XCIgb2Ygd29ya1xuICogKHBsYW4gc2xpY2UsIGV4ZWN1dGUgdGFzaywgY29tcGxldGUgc2xpY2UpIGdldHMgYSBmcmVzaCBzZXNzaW9uIHZpYVxuICogdGhlIHN0YXNoZWQgY3R4Lm5ld1Nlc3Npb24oKSBwYXR0ZXJuLlxuICpcbiAqIFRoZSBleHRlbnNpb24gcmVhZHMgZGlzayBzdGF0ZSBhZnRlciBlYWNoIGFnZW50X2VuZCwgZGV0ZXJtaW5lcyB0aGVcbiAqIG5leHQgdW5pdCB0eXBlLCBjcmVhdGVzIGEgZnJlc2ggc2Vzc2lvbiwgYW5kIGluamVjdHMgYSBmb2N1c2VkIHByb21wdFxuICogdGVsbGluZyB0aGUgTExNIHdoaWNoIGZpbGVzIHRvIHJlYWQgYW5kIHdoYXQgdG8gZG8uXG4gKi9cblxuaW1wb3J0IHR5cGUge1xuICBFeHRlbnNpb25BUEksXG4gIEV4dGVuc2lvbkNvbnRleHQsXG4gIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBTZXNzaW9uTWVzc2FnZUVudHJ5LFxufSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcblxuaW1wb3J0IHsgZGVyaXZlU3RhdGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgcGFyc2VVbml0SWQgfSBmcm9tIFwiLi91bml0LWlkLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7XG4gIGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbixcbiAgcmVhZFBhdXNlZFNlc3Npb25NZXRhZGF0YSxcbiAgUEFVU0VEX1NFU1NJT05fS1ZfS0VZLFxuICB0eXBlIEludGVycnVwdGVkU2Vzc2lvbkFzc2Vzc21lbnQsXG4gIHR5cGUgUGF1c2VkU2Vzc2lvbk1ldGFkYXRhLFxufSBmcm9tIFwiLi9pbnRlcnJ1cHRlZC1zZXNzaW9uLmpzXCI7XG5pbXBvcnQge1xuICBzZXRSdW50aW1lS3YsXG4gIGRlbGV0ZVJ1bnRpbWVLdixcbn0gZnJvbSBcIi4vZGIvcnVudGltZS1rdi5qc1wiO1xuaW1wb3J0IHsgZXh0cmFjdFNlY3Rpb24sIGdldE1hbmlmZXN0U3RhdHVzLCBzcGxpdEZyb250bWF0dGVyLCBwYXJzZUZyb250bWF0dGVyTWFwIH0gZnJvbSBcIi4vZmlsZXMuanNcIjtcbmV4cG9ydCB7IGlubGluZVByaW9yTWlsZXN0b25lU3VtbWFyeSB9IGZyb20gXCIuL2ZpbGVzLmpzXCI7XG5pbXBvcnQgeyBjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdCB9IGZyb20gXCIuLi9nZXQtc2VjcmV0cy1mcm9tLXVzZXIuanNcIjtcbmltcG9ydCB7XG4gIGdzZFJvb3QsXG4gIHJlc29sdmVNaWxlc3RvbmVGaWxlLFxuICByZXNvbHZlU2xpY2VGaWxlLFxuICByZXNvbHZlU2xpY2VQYXRoLFxuICByZXNvbHZlTWlsZXN0b25lUGF0aCxcbiAgcmVzb2x2ZURpcixcbiAgcmVzb2x2ZVRhc2tzRGlyLFxuICByZXNvbHZlVGFza0ZpbGUsXG4gIG1pbGVzdG9uZXNEaXIsXG4gIGJ1aWxkVGFza0ZpbGVOYW1lLFxufSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZUFsbENhY2hlcyB9IGZyb20gXCIuL2NhY2hlLmpzXCI7XG5pbXBvcnQgeyBjbGVhckFjdGl2aXR5TG9nU3RhdGUgfSBmcm9tIFwiLi9hY3Rpdml0eS1sb2cuanNcIjtcbmltcG9ydCB7XG4gIHN5bnRoZXNpemVDcmFzaFJlY292ZXJ5LFxuICBnZXREZWVwRGlhZ25vc3RpYyxcbiAgcmVhZEFjdGl2ZU1pbGVzdG9uZUlkLFxufSBmcm9tIFwiLi9zZXNzaW9uLWZvcmVuc2ljcy5qc1wiO1xuaW1wb3J0IHtcbiAgd3JpdGVMb2NrLFxuICBjbGVhckxvY2ssXG4gIGNsZWFyU3RhbGVXb3JrZXJMb2NrLFxuICByZWFkQ3Jhc2hMb2NrLFxuICBpc0xvY2tQcm9jZXNzQWxpdmUsXG4gIGZvcm1hdENyYXNoSW5mbyxcbiAgZW1pdENyYXNoUmVjb3ZlcmVkVW5pdEVuZCxcbiAgZW1pdE9wZW5Vbml0RW5kRm9yVW5pdCxcbn0gZnJvbSBcIi4vY3Jhc2gtcmVjb3ZlcnkuanNcIjtcbmltcG9ydCB7XG4gIGFjcXVpcmVTZXNzaW9uTG9jayxcbiAgZ2V0U2Vzc2lvbkxvY2tTdGF0dXMsXG4gIHJlbGVhc2VTZXNzaW9uTG9jayxcbiAgdXBkYXRlU2Vzc2lvbkxvY2ssXG59IGZyb20gXCIuL3Nlc3Npb24tbG9jay5qc1wiO1xuaW1wb3J0IHR5cGUgeyBTZXNzaW9uTG9ja1N0YXR1cyB9IGZyb20gXCIuL3Nlc3Npb24tbG9jay5qc1wiO1xuaW1wb3J0IHtcbiAgcmVzb2x2ZUF1dG9TdXBlcnZpc29yQ29uZmlnLFxuICBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMsXG4gIGdldElzb2xhdGlvbk1vZGUsXG59IGZyb20gXCIuL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBzZW5kRGVza3RvcE5vdGlmaWNhdGlvbiB9IGZyb20gXCIuL25vdGlmaWNhdGlvbnMuanNcIjtcbmltcG9ydCB0eXBlIHsgR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBCdWRnZXRBbGVydExldmVsLFxuICBnZXRCdWRnZXRBbGVydExldmVsLFxuICBnZXROZXdCdWRnZXRBbGVydExldmVsLFxuICBnZXRCdWRnZXRFbmZvcmNlbWVudEFjdGlvbixcbn0gZnJvbSBcIi4vYXV0by1idWRnZXQuanNcIjtcbmltcG9ydCB7XG4gIG1hcmtUb29sU3RhcnQgYXMgX21hcmtUb29sU3RhcnQsXG4gIG1hcmtUb29sRW5kIGFzIF9tYXJrVG9vbEVuZCxcbiAgZ2V0T2xkZXN0SW5GbGlnaHRUb29sQWdlTXMgYXMgX2dldE9sZGVzdEluRmxpZ2h0VG9vbEFnZU1zLFxuICBnZXRJbkZsaWdodFRvb2xDb3VudCxcbiAgZ2V0T2xkZXN0SW5GbGlnaHRUb29sU3RhcnQsXG4gIGhhc0ludGVyYWN0aXZlVG9vbEluRmxpZ2h0LFxuICBjbGVhckluRmxpZ2h0VG9vbHMsXG4gIGlzVG9vbEludm9jYXRpb25FcnJvcixcbiAgaXNRdWV1ZWRVc2VyTWVzc2FnZVNraXAsXG4gIGlzRGV0ZXJtaW5pc3RpY1BvbGljeUVycm9yLFxufSBmcm9tIFwiLi9hdXRvLXRvb2wtdHJhY2tpbmcuanNcIjtcbmltcG9ydCB7IGNsb3Nlb3V0VW5pdCB9IGZyb20gXCIuL2F1dG8tdW5pdC1jbG9zZW91dC5qc1wiO1xuaW1wb3J0IHsgcmVjb3ZlclRpbWVkT3V0VW5pdCB9IGZyb20gXCIuL2F1dG8tdGltZW91dC1yZWNvdmVyeS5qc1wiO1xuaW1wb3J0IHsgc2VsZWN0QW5kQXBwbHlNb2RlbCwgcmVzb2x2ZU1vZGVsSWQsIGNsZWFyVG9vbEJhc2VsaW5lIH0gZnJvbSBcIi4vYXV0by1tb2RlbC1zZWxlY3Rpb24uanNcIjtcbmltcG9ydCB7IHJlc2V0Um91dGluZ0hpc3RvcnksIHJlY29yZE91dGNvbWUgfSBmcm9tIFwiLi9yb3V0aW5nLWhpc3RvcnkuanNcIjtcbmltcG9ydCB7XG4gIGNoZWNrUG9zdFVuaXRIb29rcyxcbiAgZ2V0QWN0aXZlSG9vayxcbiAgcmVzZXRIb29rU3RhdGUsXG4gIGlzUmV0cnlQZW5kaW5nLFxuICBjb25zdW1lUmV0cnlUcmlnZ2VyLFxuICBydW5QcmVEaXNwYXRjaEhvb2tzLFxuICBwZXJzaXN0SG9va1N0YXRlLFxuICByZXN0b3JlSG9va1N0YXRlLFxuICBjbGVhclBlcnNpc3RlZEhvb2tTdGF0ZSxcbn0gZnJvbSBcIi4vcG9zdC11bml0LWhvb2tzLmpzXCI7XG5pbXBvcnQgeyBydW5HU0REb2N0b3IsIHJlYnVpbGRTdGF0ZSB9IGZyb20gXCIuL2RvY3Rvci5qc1wiO1xuaW1wb3J0IHtcbiAgcHJlRGlzcGF0Y2hIZWFsdGhHYXRlLFxuICByZWNvcmRIZWFsdGhTbmFwc2hvdCxcbiAgY2hlY2tIZWFsRXNjYWxhdGlvbixcbiAgcmVzZXRQcm9hY3RpdmVIZWFsaW5nLFxuICBzZXRMZXZlbENoYW5nZUNhbGxiYWNrLFxuICBmb3JtYXRIZWFsdGhTdW1tYXJ5LFxuICBnZXRDb25zZWN1dGl2ZUVycm9yVW5pdHMsXG59IGZyb20gXCIuL2RvY3Rvci1wcm9hY3RpdmUuanNcIjtcbmltcG9ydCB7IGNsZWFyU2tpbGxTbmFwc2hvdCB9IGZyb20gXCIuL3NraWxsLWRpc2NvdmVyeS5qc1wiO1xuaW1wb3J0IHtcbiAgY2FwdHVyZUF2YWlsYWJsZVNraWxscyxcbiAgcmVzZXRTa2lsbFRlbGVtZXRyeSxcbn0gZnJvbSBcIi4vc2tpbGwtdGVsZW1ldHJ5LmpzXCI7XG5pbXBvcnQgeyBnZXRSdGtTZXNzaW9uU2F2aW5ncyB9IGZyb20gXCIuLi9zaGFyZWQvcnRrLXNlc3Npb24tc3RhdHMuanNcIjtcbmltcG9ydCB7IGRlYWN0aXZhdGVHU0QgfSBmcm9tIFwiLi4vc2hhcmVkL2dzZC1waGFzZS1zdGF0ZS5qc1wiO1xuaW1wb3J0IHtcbiAgaW5pdE1ldHJpY3MsXG4gIHJlc2V0TWV0cmljcyxcbiAgZ2V0TGVkZ2VyLFxuICBnZXRQcm9qZWN0VG90YWxzLFxuICBmb3JtYXRDb3N0LFxuICBmb3JtYXRUb2tlbkNvdW50LFxufSBmcm9tIFwiLi9tZXRyaWNzLmpzXCI7XG5pbXBvcnQgeyBzZXRMb2dCYXNlUGF0aCwgbG9nV2FybmluZywgbG9nRXJyb3IgfSBmcm9tIFwiLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IHByZWZsaWdodENsZWFuUm9vdCwgcG9zdGZsaWdodFBvcFN0YXNoIH0gZnJvbSBcIi4vY2xlYW4tcm9vdC1wcmVmbGlnaHQuanNcIjtcbmltcG9ydCB7IGlzQWJzb2x1dGUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXRoVG9GaWxlVVJMIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMsIGV4aXN0c1N5bmMsIG1rZGlyU3luYywgd3JpdGVGaWxlU3luYywgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBhdG9taWNXcml0ZVN5bmMgfSBmcm9tIFwiLi9hdG9taWMtd3JpdGUuanNcIjtcbmltcG9ydCB7XG4gIGF1dG9Db21taXRDdXJyZW50QnJhbmNoLFxuICBjYXB0dXJlSW50ZWdyYXRpb25CcmFuY2gsXG4gIGRldGVjdFdvcmt0cmVlTmFtZSxcbiAgZ2V0Q3VycmVudEJyYW5jaCxcbiAgZ2V0TWFpbkJyYW5jaCxcbiAgTWVyZ2VDb25mbGljdEVycm9yLFxuICBwYXJzZVNsaWNlQnJhbmNoLFxuICBzZXRBY3RpdmVNaWxlc3RvbmVJZCxcbiAgcmVzb2x2ZVByb2plY3RSb290LFxufSBmcm9tIFwiLi93b3JrdHJlZS5qc1wiO1xuaW1wb3J0IHsgR2l0U2VydmljZUltcGwgfSBmcm9tIFwiLi9naXQtc2VydmljZS5qc1wiO1xuaW1wb3J0IHsgbmF0aXZlQ2hlY2tvdXRCcmFuY2ggfSBmcm9tIFwiLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc1wiO1xuaW1wb3J0IHsgZ2V0UHJpb3JTbGljZUNvbXBsZXRpb25CbG9ja2VyIH0gZnJvbSBcIi4vZGlzcGF0Y2gtZ3VhcmQuanNcIjtcbmltcG9ydCB7XG4gIGNyZWF0ZUF1dG9Xb3JrdHJlZSxcbiAgZW50ZXJBdXRvV29ya3RyZWUsXG4gIGVudGVyQnJhbmNoTW9kZUZvck1pbGVzdG9uZSxcbiAgdGVhcmRvd25BdXRvV29ya3RyZWUsXG4gIGlzSW5BdXRvV29ya3RyZWUsXG4gIGdldEF1dG9Xb3JrdHJlZVBhdGgsXG4gIGdldEF1dG9Xb3JrdHJlZU9yaWdpbmFsQmFzZSxcbiAgbWVyZ2VNaWxlc3RvbmVUb01haW4sXG4gIGF1dG9Xb3JrdHJlZUJyYW5jaCxcbiAgc3luY1dvcmt0cmVlU3RhdGVCYWNrLFxuICByZWFkUmVzb3VyY2VWZXJzaW9uLFxuICBjaGVja1Jlc291cmNlc1N0YWxlLFxuICBlc2NhcGVTdGFsZVdvcmt0cmVlLFxufSBmcm9tIFwiLi9hdXRvLXdvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyBwcnVuZVF1ZXVlT3JkZXIgfSBmcm9tIFwiLi9xdWV1ZS1vcmRlci5qc1wiO1xuaW1wb3J0IHsgc3RhcnRDb21tYW5kUG9sbGluZyBhcyBfc3RhcnRDb21tYW5kUG9sbGluZywgaXNSZW1vdGVDb25maWd1cmVkIH0gZnJvbSBcIi4uL3JlbW90ZS1xdWVzdGlvbnMvbWFuYWdlci5qc1wiO1xuXG5pbXBvcnQgeyBkZWJ1Z0xvZywgaXNEZWJ1Z0VuYWJsZWQsIHdyaXRlRGVidWdTdW1tYXJ5IH0gZnJvbSBcIi4vZGVidWctbG9nZ2VyLmpzXCI7XG5pbXBvcnQge1xuICBidWlsZExvb3BSZW1lZGlhdGlvblN0ZXBzLFxuICByZWNvbmNpbGVNZXJnZVN0YXRlLFxufSBmcm9tIFwiLi9hdXRvLXJlY292ZXJ5LmpzXCI7XG5pbXBvcnQgeyBjbGFzc2lmeU1pbGVzdG9uZVN1bW1hcnlDb250ZW50IH0gZnJvbSBcIi4vbWlsZXN0b25lLXN1bW1hcnktY2xhc3NpZmllci5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZURpc3BhdGNoLCBESVNQQVRDSF9SVUxFUyB9IGZyb20gXCIuL2F1dG8tZGlzcGF0Y2guanNcIjtcbmltcG9ydCB7IGdldEVycm9yTWVzc2FnZSB9IGZyb20gXCIuL2Vycm9yLXV0aWxzLmpzXCI7XG5pbXBvcnQgeyByZWNvdmVyRmFpbGVkTWlncmF0aW9uIH0gZnJvbSBcIi4vbWlncmF0ZS1leHRlcm5hbC5qc1wiO1xuaW1wb3J0IHsgaW5pdFJlZ2lzdHJ5LCBjb252ZXJ0RGlzcGF0Y2hSdWxlcyB9IGZyb20gXCIuL3J1bGUtcmVnaXN0cnkuanNcIjtcbmltcG9ydCB7IGVtaXRKb3VybmFsRXZlbnQgYXMgX2VtaXRKb3VybmFsRXZlbnQsIHR5cGUgSm91cm5hbEVudHJ5IH0gZnJvbSBcIi4vam91cm5hbC5qc1wiO1xuaW1wb3J0IHsgaXNDbG9zZWRTdGF0dXMgfSBmcm9tIFwiLi9zdGF0dXMtZ3VhcmRzLmpzXCI7XG5pbXBvcnQge1xuICB0eXBlIEF1dG9EYXNoYm9hcmREYXRhLFxuICB1cGRhdGVQcm9ncmVzc1dpZGdldCBhcyBfdXBkYXRlUHJvZ3Jlc3NXaWRnZXQsXG4gIHNldENvbXBsZXRpb25Qcm9ncmVzc1dpZGdldCxcbiAgc2V0QXV0b091dGNvbWVXaWRnZXQsXG4gIHVwZGF0ZVNsaWNlUHJvZ3Jlc3NDYWNoZSxcbiAgY2xlYXJTbGljZVByb2dyZXNzQ2FjaGUsXG4gIGRlc2NyaWJlTmV4dFVuaXQgYXMgX2Rlc2NyaWJlTmV4dFVuaXQsXG4gIHVuaXRWZXJiLFxuICBmb3JtYXRBdXRvRWxhcHNlZCBhcyBfZm9ybWF0QXV0b0VsYXBzZWQsXG4gIGZvcm1hdFdpZGdldFRva2VucyxcbiAgdHlwZSBXaWRnZXRTdGF0ZUFjY2Vzc29ycyxcbn0gZnJvbSBcIi4vYXV0by1kYXNoYm9hcmQuanNcIjtcbmltcG9ydCB7XG4gIHJlZ2lzdGVyU2lndGVybUhhbmRsZXIgYXMgX3JlZ2lzdGVyU2lndGVybUhhbmRsZXIsXG4gIGRlcmVnaXN0ZXJTaWd0ZXJtSGFuZGxlciBhcyBfZGVyZWdpc3RlclNpZ3Rlcm1IYW5kbGVyLFxuICBkZXRlY3RXb3JraW5nVHJlZUFjdGl2aXR5LFxufSBmcm9tIFwiLi9hdXRvLXN1cGVydmlzb3IuanNcIjtcbmltcG9ydCB7IGlzRGJBdmFpbGFibGUsIGdldE1pbGVzdG9uZSwgZ2V0TWlsZXN0b25lU2xpY2VzIH0gZnJvbSBcIi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyBtYXJrTGF0ZXN0QWN0aXZlRm9yV29ya2VyQ2FuY2VsZWQgfSBmcm9tIFwiLi9kYi91bml0LWRpc3BhdGNoZXMuanNcIjtcbmltcG9ydCB7IHdyaXRlVW5pdFJ1bnRpbWVSZWNvcmQgfSBmcm9tIFwiLi91bml0LXJ1bnRpbWUuanNcIjtcbmltcG9ydCB7IGNvdW50UGVuZGluZ0NhcHR1cmVzIH0gZnJvbSBcIi4vY2FwdHVyZXMuanNcIjtcbmltcG9ydCB7IENNVVhfQ0hBTk5FTFMsIHR5cGUgQ211eExvZ0xldmVsIH0gZnJvbSBcIi4uL3NoYXJlZC9jbXV4LWV2ZW50cy5qc1wiO1xuaW1wb3J0IHsgZW5zdXJlRGJPcGVuIH0gZnJvbSBcIi4vYm9vdHN0cmFwL2R5bmFtaWMtdG9vbHMuanNcIjtcblxuZnVuY3Rpb24gbWFrZUNtdXhFbWl0dGVycyhwaTogRXh0ZW5zaW9uQVBJKSB7XG4gIHJldHVybiB7XG4gICAgc3luY0NtdXhTaWRlYmFyOiAocHJlZmVyZW5jZXM6IEdTRFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkLCBzdGF0ZTogR1NEU3RhdGUpID0+XG4gICAgICBwaS5ldmVudHMuZW1pdChDTVVYX0NIQU5ORUxTLlNJREVCQVIsIHsgYWN0aW9uOiBcInN5bmNcIiBhcyBjb25zdCwgcHJlZmVyZW5jZXMsIHN0YXRlIH0pLFxuICAgIGxvZ0NtdXhFdmVudDogKHByZWZlcmVuY2VzOiBHU0RQcmVmZXJlbmNlcyB8IHVuZGVmaW5lZCwgbWVzc2FnZTogc3RyaW5nLCBsZXZlbD86IENtdXhMb2dMZXZlbCkgPT5cbiAgICAgIHBpLmV2ZW50cy5lbWl0KENNVVhfQ0hBTk5FTFMuTE9HLCB7IHByZWZlcmVuY2VzLCBtZXNzYWdlLCBsZXZlbDogbGV2ZWwgPz8gXCJpbmZvXCIgfSksXG4gICAgY2xlYXJDbXV4U2lkZWJhcjogKHByZWZlcmVuY2VzOiBHU0RQcmVmZXJlbmNlcyB8IHVuZGVmaW5lZCkgPT5cbiAgICAgIHBpLmV2ZW50cy5lbWl0KENNVVhfQ0hBTk5FTFMuU0lERUJBUiwgeyBhY3Rpb246IFwiY2xlYXJcIiBhcyBjb25zdCwgcHJlZmVyZW5jZXMgfSksXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBFeHRyYWN0ZWQgbW9kdWxlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmltcG9ydCB7IHN0YXJ0VW5pdFN1cGVydmlzaW9uIH0gZnJvbSBcIi4vYXV0by10aW1lcnMuanNcIjtcbmltcG9ydCB7IHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uIH0gZnJvbSBcIi4vYXV0by12ZXJpZmljYXRpb24uanNcIjtcbmltcG9ydCB7XG4gIGF1dG9Db21taXRVbml0LFxuICBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbixcbiAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uLFxufSBmcm9tIFwiLi9hdXRvLXBvc3QtdW5pdC5qc1wiO1xuaW1wb3J0IHsgYm9vdHN0cmFwQXV0b1Nlc3Npb24sIG9wZW5Qcm9qZWN0RGJJZlByZXNlbnQsIHR5cGUgQm9vdHN0cmFwRGVwcyB9IGZyb20gXCIuL2F1dG8tc3RhcnQuanNcIjtcbmltcG9ydCB7IGluaXRIZWFsdGhXaWRnZXQgfSBmcm9tIFwiLi9oZWFsdGgtd2lkZ2V0LmpzXCI7XG5pbXBvcnQgeyBydW5MZWdhY3lBdXRvTG9vcCwgcnVuVW9rS2VybmVsTG9vcCB9IGZyb20gXCIuL2F1dG8vbG9vcC5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUFnZW50RW5kLCByZXNvbHZlQWdlbnRFbmRDYW5jZWxsZWQsIF9yZXNldFBlbmRpbmdSZXNvbHZlLCBpc1Nlc3Npb25Td2l0Y2hJbkZsaWdodCB9IGZyb20gXCIuL2F1dG8vcmVzb2x2ZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBMb29wRGVwcywgU3RvcEF1dG9PcHRpb25zIH0gZnJvbSBcIi4vYXV0by9sb29wLWRlcHMuanNcIjtcbmltcG9ydCB0eXBlIHsgRXJyb3JDb250ZXh0IH0gZnJvbSBcIi4vYXV0by90eXBlcy5qc1wiO1xuaW1wb3J0IHsgcnVuQXV0b0xvb3BXaXRoVW9rIH0gZnJvbSBcIi4vdW9rL2tlcm5lbC5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVVva0ZsYWdzIH0gZnJvbSBcIi4vdW9rL2ZsYWdzLmpzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZURpcmVjdG9yeSB9IGZyb20gXCIuL3ZhbGlkYXRlLWRpcmVjdG9yeS5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlQXV0b09yY2hlc3RyYXRvciB9IGZyb20gXCIuL2F1dG8vb3JjaGVzdHJhdG9yLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEF1dG9BZHZhbmNlUmVzdWx0LCBBdXRvT3JjaGVzdHJhdGlvbk1vZHVsZSwgQXV0b09yY2hlc3RyYXRvckRlcHMsIERpc3BhdGNoQWRhcHRlciB9IGZyb20gXCIuL2F1dG8vY29udHJhY3RzLmpzXCI7XG5pbXBvcnQgeyByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaCB9IGZyb20gXCIuL3N0YXRlLXJlY29uY2lsaWF0aW9uLmpzXCI7XG5pbXBvcnQgeyBjb21waWxlVW5pdFRvb2xDb250cmFjdCB9IGZyb20gXCIuL3Rvb2wtY29udHJhY3QuanNcIjtcbmltcG9ydCB7IGNyZWF0ZVdvcmt0cmVlU2FmZXR5TW9kdWxlIH0gZnJvbSBcIi4vd29ya3RyZWUtc2FmZXR5LmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlTWFuaWZlc3QgfSBmcm9tIFwiLi91bml0LWNvbnRleHQtbWFuaWZlc3QuanNcIjtcbmltcG9ydCB7IGNsYXNzaWZ5RmFpbHVyZSB9IGZyb20gXCIuL3JlY292ZXJ5LWNsYXNzaWZpY2F0aW9uLmpzXCI7XG5pbXBvcnQgeyBzdXBwb3J0c1N0cnVjdHVyZWRRdWVzdGlvbnMgfSBmcm9tIFwiLi93b3JrZmxvdy1tY3AuanNcIjtcbmltcG9ydCB0eXBlIHsgTWluaW1hbE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9jb250ZXh0LWJ1ZGdldC5qc1wiO1xuLy8gU2xpY2UtbGV2ZWwgcGFyYWxsZWxpc20gKCMyMzQwKVxuaW1wb3J0IHsgZ2V0RWxpZ2libGVTbGljZXMgfSBmcm9tIFwiLi9zbGljZS1wYXJhbGxlbC1lbGlnaWJpbGl0eS5qc1wiO1xuaW1wb3J0IHsgc3RhcnRTbGljZVBhcmFsbGVsIH0gZnJvbSBcIi4vc2xpY2UtcGFyYWxsZWwtb3JjaGVzdHJhdG9yLmpzXCI7XG5pbXBvcnQge1xuICBXb3JrdHJlZUxpZmVjeWNsZSxcbiAgdHlwZSBXb3JrdHJlZUxpZmVjeWNsZURlcHMsXG59IGZyb20gXCIuL3dvcmt0cmVlLWxpZmVjeWNsZS5qc1wiO1xuaW1wb3J0IHsgV29ya3RyZWVTdGF0ZVByb2plY3Rpb24gfSBmcm9tIFwiLi93b3JrdHJlZS1zdGF0ZS1wcm9qZWN0aW9uLmpzXCI7XG5pbXBvcnQgeyByZW9yZGVyRm9yQ2FjaGluZyB9IGZyb20gXCIuL3Byb21wdC1vcmRlcmluZy5qc1wiO1xuaW1wb3J0IHsgaW5pdFRva2VuQ291bnRlciB9IGZyb20gXCIuL3Rva2VuLWNvdW50ZXIuanNcIjtcblxuLy8gV2FybSB0aGUgdGlrdG9rZW4gZW5jb2RlciBhdCBleHRlbnNpb24gc3RhcnR1cCBzbyBjb250ZXh0LWJ1ZGdldCBjb21wdXRhdGlvbnNcbi8vIGNhbiB1c2UgYWNjdXJhdGUgdG9rZW4gY291bnRzIHZpYSBjb3VudFRva2Vuc1N5bmMgd2l0aG91dCBwYXlpbmcgdGhlIGxvYWRcbi8vIGNvc3QgbWlkLXByb21wdC1idWlsZC4gRmlyZS1hbmQtZm9yZ2V0IFx1MjAxNCBmYWlsdXJlIGZhbGxzIGJhY2sgdG8gdGhlXG4vLyBwcm92aWRlci1hd2FyZSBjaGFyLXJhdGlvIGVzdGltYXRvciBhbHJlYWR5IHVzZWQgYnkgZ2V0Q2hhcnNQZXJUb2tlbigpLlxuLy8gQ2F0Y2ggcmVqZWN0aW9ucyBleHBsaWNpdGx5OiBhbiB1bmhhbmRsZWQgcmVqZWN0aW9uIGF0IG1vZHVsZS1pbXBvcnQgdGltZVxuLy8gY2FuIGRlc3RhYmlsaXplIHN0YXJ0dXAgYmVmb3JlIHRoZSBlbmdpbmUgbG9nZ2VyIGlzIGNvbmZpZ3VyZWQuXG52b2lkIGluaXRUb2tlbkNvdW50ZXIoKS5jYXRjaCgoZXJyKSA9PiB7XG4gIGxvZ1dhcm5pbmcoXG4gICAgXCJlbmdpbmVcIixcbiAgICBgdG9rZW4gY291bnRlciB3YXJtLXVwIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2Vzc2lvbiBTdGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW1wb3J0IHtcbiAgU1RVQl9SRUNPVkVSWV9USFJFU0hPTEQsXG4gIE5FV19TRVNTSU9OX1RJTUVPVVRfTVMsXG59IGZyb20gXCIuL2F1dG8vc2Vzc2lvbi5qc1wiO1xuaW1wb3J0IHR5cGUge1xuICBDdXJyZW50VW5pdCxcbiAgVW5pdFJvdXRpbmcsXG4gIFN0YXJ0TW9kZWwsXG4gIEF1dG9TZXNzaW9uLFxufSBmcm9tIFwiLi9hdXRvL3Nlc3Npb24uanNcIjtcbmV4cG9ydCB7XG4gIFNUVUJfUkVDT1ZFUllfVEhSRVNIT0xELFxuICBORVdfU0VTU0lPTl9USU1FT1VUX01TLFxufSBmcm9tIFwiLi9hdXRvL3Nlc3Npb24uanNcIjtcbmV4cG9ydCB0eXBlIHtcbiAgQ3VycmVudFVuaXQsXG4gIFVuaXRSb3V0aW5nLFxuICBTdGFydE1vZGVsLFxufSBmcm9tIFwiLi9hdXRvL3Nlc3Npb24uanNcIjtcbmltcG9ydCB7IGF1dG9TZXNzaW9uIGFzIHMgfSBmcm9tIFwiLi9hdXRvLXJ1bnRpbWUtc3RhdGUuanNcIjtcbmltcG9ydCB7IGdzZEhvbWUgfSBmcm9tIFwiLi9nc2QtaG9tZS5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlV29ya3NwYWNlLCBzY29wZU1pbGVzdG9uZSB9IGZyb20gXCIuL3dvcmtzcGFjZS5qc1wiO1xuaW1wb3J0IHsgcmVnaXN0ZXJBdXRvV29ya2VyLCBtYXJrV29ya2VyU3RvcHBpbmcgfSBmcm9tIFwiLi9kYi9hdXRvLXdvcmtlcnMuanNcIjtcbmltcG9ydCB7IHJlbGVhc2VNaWxlc3RvbmVMZWFzZSB9IGZyb20gXCIuL2RiL21pbGVzdG9uZS1sZWFzZXMuanNcIjtcbmltcG9ydCB7IG5vcm1hbGl6ZVJlYWxQYXRoIH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwIEVOQ0FQU1VMQVRJT04gSU5WQVJJQU5UIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gQUxMIG11dGFibGUgYXV0by1tb2RlIHN0YXRlIGxpdmVzIGluIHRoZSBBdXRvU2Vzc2lvbiBjbGFzcyAoYXV0by9zZXNzaW9uLnRzKS5cbi8vIFRoaXMgZmlsZSBtdXN0IE5PVCBkZWNsYXJlIG1vZHVsZS1sZXZlbCBgbGV0YCBvciBgdmFyYCB2YXJpYWJsZXMgZm9yIHN0YXRlLlxuLy8gVGhlIHNpbmdsZSBzaGFyZWQgYHNgIGluc3RhbmNlIGJlbG93IGlzIHRoZSBvbmx5IG11dGFibGUgQXV0b1Nlc3Npb24gYmluZGluZy5cbi8vXG4vLyBXaGVuIGFkZGluZyBmZWF0dXJlcyBvciBmaXhpbmcgYnVnczpcbi8vICAgLSBOZXcgbXV0YWJsZSBzdGF0ZSBcdTIxOTIgYWRkIGEgcHJvcGVydHkgdG8gQXV0b1Nlc3Npb24sIG5vdCBhIG1vZHVsZS1sZXZlbCB2YXJpYWJsZVxuLy8gICAtIE5ldyBjb25zdGFudHMgXHUyMTkyIG1vZHVsZS1sZXZlbCBgY29uc3RgIGlzIGZpbmUgKGltbXV0YWJsZSlcbi8vICAgLSBOZXcgc3RhdGUgdGhhdCBuZWVkcyByZXNldCBvbiBzdG9wQXV0byBcdTIxOTIgYWRkIHRvIEF1dG9TZXNzaW9uLnJlc2V0KClcbi8vXG4vLyBUZXN0cyBpbiBhdXRvLXNlc3Npb24tZW5jYXBzdWxhdGlvbi50ZXN0LnRzIGVuZm9yY2UgdGhpcyBpbnZhcmlhbnQuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIFRocm90dGxlIFNUQVRFLm1kIHJlYnVpbGRzIFx1MjAxNCBhdCBtb3N0IG9uY2UgcGVyIDMwIHNlY29uZHMgKi9cbmNvbnN0IFNUQVRFX1JFQlVJTERfTUlOX0lOVEVSVkFMX01TID0gMzBfMDAwO1xuXG4vKipcbiAqIFBoYXNlIEIgXHUyMDE0IHJlZ2lzdGVyIHRoaXMgYXV0by1tb2RlIHByb2Nlc3MgaW4gdGhlIHdvcmtlcnMgdGFibGUgc28gb3RoZXJcbiAqIHdvcmtlcnMgYW5kIGphbml0b3JzIGNhbiBkZXRlY3QgbGl2ZW5lc3MgdmlhIGhlYXJ0YmVhdC4gQmVzdC1lZmZvcnQ6IGlmXG4gKiB0aGUgREIgaXMgdW5hdmFpbGFibGUgKGUuZy4gZnJlc2ggcHJvamVjdCBiZWZvcmUgaW5pdCkgd2Ugc2tpcCByZWdpc3RyYXRpb25cbiAqIHNpbGVudGx5IHJhdGhlciB0aGFuIGJsb2NraW5nIHNlc3Npb24gc3RhcnQuXG4gKi9cbmZ1bmN0aW9uIHJlZ2lzdGVyQXV0b1dvcmtlckZvclNlc3Npb24oXG4gIHNlc3Npb246IEF1dG9TZXNzaW9uLFxuICBwcm9qZWN0Um9vdE92ZXJyaWRlPzogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmIChzZXNzaW9uLndvcmtlcklkKSByZXR1cm47IC8vIGFscmVhZHkgcmVnaXN0ZXJlZCAoZS5nLiByZXN1bWUgcmUtcnVucylcbiAgdHJ5IHtcbiAgICBjb25zdCBwcm9qZWN0Um9vdFJlYWxwYXRoID0gbm9ybWFsaXplUmVhbFBhdGgoXG4gICAgICBwcm9qZWN0Um9vdE92ZXJyaWRlXG4gICAgICAgID8/IHNlc3Npb24uc2NvcGU/LndvcmtzcGFjZS5wcm9qZWN0Um9vdFxuICAgICAgICA/PyAoc2Vzc2lvbi5vcmlnaW5hbEJhc2VQYXRoIHx8IHNlc3Npb24uYmFzZVBhdGgpLFxuICAgICk7XG4gICAgc2Vzc2lvbi53b3JrZXJJZCA9IHJlZ2lzdGVyQXV0b1dvcmtlcih7IHByb2plY3RSb290UmVhbHBhdGggfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGRlYnVnTG9nKFwiYXV0b0xvb3BcIiwge1xuICAgICAgcGhhc2U6IFwicmVnaXN0ZXItd29ya2VyLWZhaWxlZFwiLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjYXB0dXJlUHJvamVjdFJvb3RFbnYocHJvamVjdFJvb3Q6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIXMucHJvamVjdFJvb3RFbnZDYXB0dXJlZCkge1xuICAgIHMuaGFkUHJvamVjdFJvb3RFbnYgPSBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocHJvY2Vzcy5lbnYsIFwiR1NEX1BST0pFQ1RfUk9PVFwiKTtcbiAgICBzLnByZXZpb3VzUHJvamVjdFJvb3RFbnYgPSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UID8/IG51bGw7XG4gICAgcy5wcm9qZWN0Um9vdEVudkNhcHR1cmVkID0gdHJ1ZTtcbiAgfVxuICBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UID0gcHJvamVjdFJvb3Q7XG59XG5cbmZ1bmN0aW9uIHJlc3RvcmVQcm9qZWN0Um9vdEVudigpOiB2b2lkIHtcbiAgaWYgKCFzLnByb2plY3RSb290RW52Q2FwdHVyZWQpIHJldHVybjtcblxuICBpZiAocy5oYWRQcm9qZWN0Um9vdEVudiAmJiBzLnByZXZpb3VzUHJvamVjdFJvb3RFbnYgIT09IG51bGwpIHtcbiAgICBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UID0gcy5wcmV2aW91c1Byb2plY3RSb290RW52O1xuICB9IGVsc2Uge1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfUFJPSkVDVF9ST09UO1xuICB9XG5cbiAgcy5wcmV2aW91c1Byb2plY3RSb290RW52ID0gbnVsbDtcbiAgcy5oYWRQcm9qZWN0Um9vdEVudiA9IGZhbHNlO1xuICBzLnByb2plY3RSb290RW52Q2FwdHVyZWQgPSBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9jYXB0dXJlUHJvamVjdFJvb3RFbnZGb3JUZXN0KHByb2plY3RSb290OiBzdHJpbmcpOiB2b2lkIHtcbiAgY2FwdHVyZVByb2plY3RSb290RW52KHByb2plY3RSb290KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9yZXN0b3JlUHJvamVjdFJvb3RFbnZGb3JUZXN0KCk6IHZvaWQge1xuICByZXN0b3JlUHJvamVjdFJvb3RFbnYoKTtcbn1cblxuZnVuY3Rpb24gY2FwdHVyZU1pbGVzdG9uZUxvY2tFbnYobWlsZXN0b25lSWQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgaWYgKCFzLm1pbGVzdG9uZUxvY2tFbnZDYXB0dXJlZCkge1xuICAgIHMuaGFkTWlsZXN0b25lTG9ja0VudiA9IE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChwcm9jZXNzLmVudiwgXCJHU0RfTUlMRVNUT05FX0xPQ0tcIik7XG4gICAgcy5wcmV2aW91c01pbGVzdG9uZUxvY2tFbnYgPSBwcm9jZXNzLmVudi5HU0RfTUlMRVNUT05FX0xPQ0sgPz8gbnVsbDtcbiAgICBzLm1pbGVzdG9uZUxvY2tFbnZDYXB0dXJlZCA9IHRydWU7XG4gIH1cblxuICBpZiAobWlsZXN0b25lSWQpIHtcbiAgICBwcm9jZXNzLmVudi5HU0RfTUlMRVNUT05FX0xPQ0sgPSBtaWxlc3RvbmVJZDtcbiAgfSBlbHNlIHtcbiAgICBkZWxldGUgcHJvY2Vzcy5lbnYuR1NEX01JTEVTVE9ORV9MT0NLO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc3RvcmVNaWxlc3RvbmVMb2NrRW52KCk6IHZvaWQge1xuICBpZiAoIXMubWlsZXN0b25lTG9ja0VudkNhcHR1cmVkKSByZXR1cm47XG5cbiAgaWYgKHMuaGFkTWlsZXN0b25lTG9ja0VudiAmJiBzLnByZXZpb3VzTWlsZXN0b25lTG9ja0VudiAhPT0gbnVsbCkge1xuICAgIHByb2Nlc3MuZW52LkdTRF9NSUxFU1RPTkVfTE9DSyA9IHMucHJldmlvdXNNaWxlc3RvbmVMb2NrRW52O1xuICB9IGVsc2Uge1xuICAgIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfTUlMRVNUT05FX0xPQ0s7XG4gIH1cblxuICBzLnByZXZpb3VzTWlsZXN0b25lTG9ja0VudiA9IG51bGw7XG4gIHMuaGFkTWlsZXN0b25lTG9ja0VudiA9IGZhbHNlO1xuICBzLm1pbGVzdG9uZUxvY2tFbnZDYXB0dXJlZCA9IGZhbHNlO1xufVxuXG4vKipcbiAqIFJlYnVpbGQgcy5zY29wZSBmcm9tIHRoZSBjdXJyZW50IHMuYmFzZVBhdGggLyBzLm9yaWdpbmFsQmFzZVBhdGggLyBzLmN1cnJlbnRNaWxlc3RvbmVJZC5cbiAqXG4gKiBQYXNzIHRoZSB3b3JrdHJlZSBwYXRoIGFzIHJhd1BhdGggd2hlbiBlbnRlcmluZyBhIHdvcmt0cmVlIHNvIGNyZWF0ZVdvcmtzcGFjZVxuICogY2FuIGRldGVjdCB0aGUgd29ya3RyZWUgbGF5b3V0IGFuZCBzZXQgbW9kZT1cIndvcmt0cmVlXCIuIFdoZW4gbm8gd29ya3RyZWUgaXNcbiAqIGFjdGl2ZSwgcmF3UGF0aCBzaG91bGQgZXF1YWwgdGhlIHByb2plY3Qgcm9vdC5cbiAqXG4gKiBDbGVhcnMgcy5zY29wZSB3aGVuIG1pbGVzdG9uZUlkIGlzIGFic2VudCBcdTIwMTQgc2NvcGUgaXMgb25seSBtZWFuaW5nZnVsIHdoZW4gYVxuICogbWlsZXN0b25lIGlzIGFjdGl2ZS5cbiAqXG4gKiBUT0RPKEM4KTogcmVtb3ZlIGJhc2VQYXRoL29yaWdpbmFsQmFzZVBhdGggb25jZSBhbGwgcmVhZGVycyB1c2Ugcy5zY29wZS5cbiAqL1xuZnVuY3Rpb24gcmVidWlsZFNjb3BlKHJhd1BhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgaWYgKCFtaWxlc3RvbmVJZCkge1xuICAgIHMuc2NvcGUgPSBudWxsO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHdvcmtzcGFjZSA9IGNyZWF0ZVdvcmtzcGFjZShyYXdQYXRoKTtcbiAgICBzLnNjb3BlID0gc2NvcGVNaWxlc3RvbmUod29ya3NwYWNlLCBtaWxlc3RvbmVJZCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgc2NvcGUgaXMgYWRkaXRpdmUuIEV4aXN0aW5nIHJlYWRlcnMgc3RpbGwgdXNlIGJhc2VQYXRoLlxuICAgIHMuc2NvcGUgPSBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNlc3Npb25GaWxlUGF0aChyYXc6IHVua25vd24pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKHR5cGVvZiByYXcgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICBjb25zdCB0cmltbWVkID0gcmF3LnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlyc3RMaW5lID0gdHJpbW1lZC5zcGxpdCgvXFxyP1xcbi8sIDEpWzBdPy50cmltKCkgPz8gXCJcIjtcbiAgaWYgKCFmaXJzdExpbmUpIHJldHVybiBudWxsO1xuXG4gIC8vIEd1YXJkIGFnYWluc3QgYWNjaWRlbnRhbCBtZXNzYWdlIGNvbmNhdGVuYXRpb24gYnkgdHJpbW1pbmcgdG8gLmpzb25sLlxuICBjb25zdCBqc29ubEluZGV4ID0gZmlyc3RMaW5lLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihcIi5qc29ubFwiKTtcbiAgY29uc3QgY2FuZGlkYXRlID0ganNvbmxJbmRleCA+PSAwID8gZmlyc3RMaW5lLnNsaWNlKDAsIGpzb25sSW5kZXggKyBcIi5qc29ubFwiLmxlbmd0aCkgOiBmaXJzdExpbmU7XG4gIGlmICghaXNBYnNvbHV0ZShjYW5kaWRhdGUpKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFjYW5kaWRhdGUudG9Mb3dlckNhc2UoKS5lbmRzV2l0aChcIi5qc29ubFwiKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBjYW5kaWRhdGU7XG59XG5cbmZ1bmN0aW9uIHN5bnRoZXNpemVQYXVzZWRTZXNzaW9uUmVjb3ZlcnkoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICBzZXNzaW9uRmlsZTogc3RyaW5nLFxuKTogUmV0dXJuVHlwZTx0eXBlb2Ygc3ludGhlc2l6ZUNyYXNoUmVjb3Zlcnk+IHtcbiAgY29uc3QgYWN0aXZpdHlEaXIgPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcImFjdGl2aXR5XCIpO1xuICByZXR1cm4gc3ludGhlc2l6ZUNyYXNoUmVjb3ZlcnkoYmFzZVBhdGgsIHVuaXRUeXBlLCB1bml0SWQsIHNlc3Npb25GaWxlLCBhY3Rpdml0eURpcik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfc3ludGhlc2l6ZVBhdXNlZFNlc3Npb25SZWNvdmVyeUZvclRlc3QoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICBzZXNzaW9uRmlsZTogc3RyaW5nLFxuKTogUmV0dXJuVHlwZTx0eXBlb2Ygc3ludGhlc2l6ZUNyYXNoUmVjb3Zlcnk+IHtcbiAgcmV0dXJuIHN5bnRoZXNpemVQYXVzZWRTZXNzaW9uUmVjb3ZlcnkoYmFzZVBhdGgsIHVuaXRUeXBlLCB1bml0SWQsIHNlc3Npb25GaWxlKTtcbn1cblxuLy8gYF9yZXNvbHZlUGF1c2VkUmVzdW1lQmFzZVBhdGhGb3JUZXN0YCB3YXMgcmV0aXJlZCBpbiBBRFItMDE2IHBoYXNlIDIgLyBCM1xuLy8gKCM1NjIxKS4gUHJvZHVjdGlvbiBjYWxsZXJzIGdvIHRocm91Z2hcbi8vIGBXb3JrdHJlZUxpZmVjeWNsZS5yZXN1bWVGcm9tUGF1c2VkU2Vzc2lvbmA7IHRoZSBwdXJlIGhlbHBlciBmb3IgdGVzdHMgaXNcbi8vIGByZXNvbHZlUGF1c2VkUmVzdW1lQmFzZVBhdGhgIGV4cG9ydGVkIGZyb20gYHdvcmt0cmVlLWxpZmVjeWNsZS50c2AuXG5cbmNvbnN0IERFVEFDSEVEX0FVVE9fS0VFUEFMSVZFX0lOVEVSVkFMX01TID0gMzBfMDAwO1xuXG5mdW5jdGlvbiB3aXRoRGV0YWNoZWRBdXRvS2VlcGFsaXZlPFQ+KHJ1bjogUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICBjb25zdCBrZWVwQWxpdmUgPSBzZXRJbnRlcnZhbCgoKSA9PiB7fSwgREVUQUNIRURfQVVUT19LRUVQQUxJVkVfSU5URVJWQUxfTVMpO1xuICByZXR1cm4gcnVuLmZpbmFsbHkoKCkgPT4ge1xuICAgIGNsZWFySW50ZXJ2YWwoa2VlcEFsaXZlKTtcbiAgfSk7XG59XG5cbmV4cG9ydCBjb25zdCBfd2l0aERldGFjaGVkQXV0b0tlZXBhbGl2ZUZvclRlc3QgPSB3aXRoRGV0YWNoZWRBdXRvS2VlcGFsaXZlO1xuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRBdXRvRGV0YWNoZWQoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGJhc2U6IHN0cmluZyxcbiAgdmVyYm9zZU1vZGU6IGJvb2xlYW4sXG4gIG9wdGlvbnM/OiB7XG4gICAgc3RlcD86IGJvb2xlYW47XG4gICAgaW50ZXJydXB0ZWQ/OiBJbnRlcnJ1cHRlZFNlc3Npb25Bc3Nlc3NtZW50O1xuICAgIG1pbGVzdG9uZUxvY2s/OiBzdHJpbmcgfCBudWxsO1xuICB9LFxuKTogdm9pZCB7XG4gIHZvaWQgd2l0aERldGFjaGVkQXV0b0tlZXBhbGl2ZShzdGFydEF1dG8oY3R4LCBwaSwgYmFzZSwgdmVyYm9zZU1vZGUsIG9wdGlvbnMpKS5jYXRjaCgoZXJyKSA9PiB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGdldEVycm9yTWVzc2FnZShlcnIpO1xuICAgIGN0eC51aS5ub3RpZnkoYEF1dG8tc3RhcnQgZmFpbGVkOiAke21lc3NhZ2V9YCwgXCJlcnJvclwiKTtcbiAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBhdXRvIHN0YXJ0IGVycm9yOiAke21lc3NhZ2V9YCwgeyBmaWxlOiBcImF1dG8udHNcIiB9KTtcbiAgICBkZWJ1Z0xvZyhcImF1dG8tc3RhcnQtZmFpbGVkXCIsIHsgZXJyb3I6IG1lc3NhZ2UgfSk7XG4gIH0pO1xufVxuXG4vKiogUmV0dXJucyB0cnVlIGlmIHRoZSBwcm9qZWN0IGlzIGNvbmZpZ3VyZWQgZm9yIGBpc29sYXRpb246d29ya3RyZWVgIG1vZGUuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkVXNlV29ya3RyZWVJc29sYXRpb24oYmFzZVBhdGg/OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGdldElzb2xhdGlvbk1vZGUoYmFzZVBhdGgpID09PSBcIndvcmt0cmVlXCI7XG59XG5cbi8qKiBDcmFzaCByZWNvdmVyeSBwcm9tcHQgXHUyMDE0IHNldCBieSBzdGFydEF1dG8sIGNvbnN1bWVkIGJ5IHRoZSBtYWluIGxvb3AgKi9cblxuLyoqIFBlbmRpbmcgdmVyaWZpY2F0aW9uIHJldHJ5IFx1MjAxNCBzZXQgd2hlbiBnYXRlIGZhaWxzIHdpdGggcmV0cmllcyByZW1haW5pbmcsIGNvbnN1bWVkIGJ5IGF1dG9Mb29wICovXG5cbi8qKiBWZXJpZmljYXRpb24gcmV0cnkgY291bnQgcGVyIHVuaXRJZCBcdTIwMTQgc2VwYXJhdGUgZnJvbSBzLnVuaXREaXNwYXRjaENvdW50IHdoaWNoIHRyYWNrcyBhcnRpZmFjdC1taXNzaW5nIHJldHJpZXMgKi9cblxuLyoqIFNlc3Npb24gZmlsZSBwYXRoIGNhcHR1cmVkIGF0IHBhdXNlIFx1MjAxNCB1c2VkIHRvIHN5bnRoZXNpemUgcmVjb3ZlcnkgYnJpZWZpbmcgb24gcmVzdW1lICovXG5cbi8qKiBEYXNoYm9hcmQgdHJhY2tpbmcgKi9cblxuLyoqIFRyYWNrIGR5bmFtaWMgcm91dGluZyBkZWNpc2lvbiBmb3IgdGhlIGN1cnJlbnQgdW5pdCAoZm9yIG1ldHJpY3MpICovXG5cbi8qKiBRdWV1ZSBvZiBxdWljay10YXNrIGNhcHR1cmVzIGF3YWl0aW5nIGRpc3BhdGNoIGFmdGVyIHRyaWFnZSByZXNvbHV0aW9uICovXG5cbi8qKlxuICogTW9kZWwgY2FwdHVyZWQgYXQgYXV0by1tb2RlIHN0YXJ0LiBVc2VkIHRvIHByZXZlbnQgbW9kZWwgYmxlZWQgYmV0d2VlblxuICogY29uY3VycmVudCBHU0QgaW5zdGFuY2VzIHNoYXJpbmcgdGhlIHNhbWUgZ2xvYmFsIHNldHRpbmdzLmpzb24gKCM2NTApLlxuICogV2hlbiBwcmVmZXJlbmNlcyBkb24ndCBzcGVjaWZ5IGEgbW9kZWwgZm9yIGEgdW5pdCB0eXBlLCB0aGlzIGVuc3VyZXNcbiAqIHRoZSBzZXNzaW9uJ3Mgb3JpZ2luYWwgbW9kZWwgaXMgcmUtYXBwbGllZCBpbnN0ZWFkIG9mIHJlYWRpbmcgZnJvbVxuICogdGhlIHNoYXJlZCBnbG9iYWwgc2V0dGluZ3MgKHdoaWNoIGFub3RoZXIgaW5zdGFuY2UgbWF5IGhhdmUgb3ZlcndyaXR0ZW4pLlxuICovXG5cbi8qKiBUcmFjayBjdXJyZW50IG1pbGVzdG9uZSB0byBkZXRlY3QgdHJhbnNpdGlvbnMgKi9cblxuLyoqIE1vZGVsIHRoZSB1c2VyIGhhZCBzZWxlY3RlZCBiZWZvcmUgYXV0by1tb2RlIHN0YXJ0ZWQgKi9cblxuLyoqIFByb2dyZXNzLWF3YXJlIHRpbWVvdXQgc3VwZXJ2aXNpb24gKi9cblxuLyoqIENvbnRleHQtcHJlc3N1cmUgY29udGludWUtaGVyZSBtb25pdG9yIFx1MjAxNCBmaXJlcyBvbmNlIHdoZW4gY29udGV4dCB1c2FnZSA+PSA3MCUgKi9cblxuLyoqIFByb21wdCBjaGFyYWN0ZXIgbWVhc3VyZW1lbnQgZm9yIHRva2VuIHNhdmluZ3MgYW5hbHlzaXMgKFIwNTEpLiAqL1xuXG4vKiogU0lHVEVSTSBoYW5kbGVyIHJlZ2lzdGVyZWQgd2hpbGUgYXV0by1tb2RlIGlzIGFjdGl2ZSBcdTIwMTQgY2xlYXJlZCBvbiBzdG9wL3BhdXNlLiAqL1xuXG4vKipcbiAqIFRvb2wgY2FsbHMgY3VycmVudGx5IGJlaW5nIGV4ZWN1dGVkIFx1MjAxNCBwcmV2ZW50cyBmYWxzZSBpZGxlIGRldGVjdGlvbiBkdXJpbmcgbG9uZy1ydW5uaW5nIHRvb2xzLlxuICogTWFwcyB0b29sQ2FsbElkIFx1MjE5MiBzdGFydCB0aW1lc3RhbXAgKG1zKSBzbyB0aGUgaWRsZSB3YXRjaGRvZyBjYW4gZGV0ZWN0IHRvb2xzIHRoYXQgaGF2ZSBiZWVuXG4gKiBydW5uaW5nIHN1c3BpY2lvdXNseSBsb25nIChlLmcuLCBhIEJhc2ggY29tbWFuZCBodW5nIGJlY2F1c2UgYCZgIGtlcHQgc3Rkb3V0IG9wZW4pLlxuICovXG4vLyBSZS1leHBvcnQgYnVkZ2V0IHV0aWxpdGllcyBmb3IgZXh0ZXJuYWwgY29uc3VtZXJzXG5leHBvcnQge1xuICBnZXRCdWRnZXRBbGVydExldmVsLFxuICBnZXROZXdCdWRnZXRBbGVydExldmVsLFxuICBnZXRCdWRnZXRFbmZvcmNlbWVudEFjdGlvbixcbn0gZnJvbSBcIi4vYXV0by1idWRnZXQuanNcIjtcblxuZnVuY3Rpb24gY2xvc2VPdXRTaWduYWxJbnRlcnJ1cHRlZFVuaXQoY3VycmVudEJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgY3VycmVudFVuaXQgPSBzLmN1cnJlbnRVbml0O1xuICBpZiAoIWN1cnJlbnRVbml0KSByZXR1cm47XG5cbiAgY29uc3QgcmVhc29uID0gXCJBdXRvLW1vZGUgcHJvY2VzcyByZWNlaXZlZCBhIHRlcm1pbmF0aW9uIHNpZ25hbFwiO1xuICBjb25zdCBlcnJvckNvbnRleHQ6IEVycm9yQ29udGV4dCA9IHtcbiAgICBtZXNzYWdlOiByZWFzb24sXG4gICAgY2F0ZWdvcnk6IFwiYWJvcnRlZFwiLFxuICAgIGlzVHJhbnNpZW50OiBmYWxzZSxcbiAgfTtcbiAgY29uc3QgYmFzZVBhdGggPSBzLmJhc2VQYXRoIHx8IGN1cnJlbnRCYXNlUGF0aDtcblxuICB0cnkge1xuICAgIGVtaXRPcGVuVW5pdEVuZEZvclVuaXQoYmFzZVBhdGgsIGN1cnJlbnRVbml0LnR5cGUsIGN1cnJlbnRVbml0LmlkLCBcImNhbmNlbGxlZFwiLCBlcnJvckNvbnRleHQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBzaWduYWwgdW5pdC1lbmQgY2xlYW51cCBmYWlsZWQ6ICR7Z2V0RXJyb3JNZXNzYWdlKGVycil9YCwgeyBmaWxlOiBcImF1dG8udHNcIiB9KTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgd3JpdGVVbml0UnVudGltZVJlY29yZChiYXNlUGF0aCwgY3VycmVudFVuaXQudHlwZSwgY3VycmVudFVuaXQuaWQsIGN1cnJlbnRVbml0LnN0YXJ0ZWRBdCwge1xuICAgICAgcGhhc2U6IFwiY3Jhc2hlZFwiLFxuICAgICAgbGFzdFByb2dyZXNzQXQ6IERhdGUubm93KCksXG4gICAgICBsYXN0UHJvZ3Jlc3NLaW5kOiBcInNpZ25hbFwiLFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBzaWduYWwgcnVudGltZSBjbGVhbnVwIGZhaWxlZDogJHtnZXRFcnJvck1lc3NhZ2UoZXJyKX1gLCB7IGZpbGU6IFwiYXV0by50c1wiIH0pO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBpZiAocy53b3JrZXJJZCkgbWFya0xhdGVzdEFjdGl2ZUZvcldvcmtlckNhbmNlbGVkKHMud29ya2VySWQsIFwic2lnbmFsLWV4aXRcIik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYHNpZ25hbCBkaXNwYXRjaCBjbGVhbnVwIGZhaWxlZDogJHtnZXRFcnJvck1lc3NhZ2UoZXJyKX1gLCB7IGZpbGU6IFwiYXV0by50c1wiIH0pO1xuICB9XG5cbiAgdHJ5IHtcbiAgICByZXNvbHZlQWdlbnRFbmRDYW5jZWxsZWQoZXJyb3JDb250ZXh0KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgc2lnbmFsIHJlc29sdmUgY2xlYW51cCBmYWlsZWQ6ICR7Z2V0RXJyb3JNZXNzYWdlKGVycil9YCwgeyBmaWxlOiBcImF1dG8udHNcIiB9KTtcbiAgfVxufVxuXG4vKiogV3JhcHBlcjogcmVnaXN0ZXIgU0lHVEVSTSBoYW5kbGVyIGFuZCBzdG9yZSByZWZlcmVuY2UuICovXG5mdW5jdGlvbiByZWdpc3RlclNpZ3Rlcm1IYW5kbGVyKGN1cnJlbnRCYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIHMuc2lndGVybUhhbmRsZXIgPSBfcmVnaXN0ZXJTaWd0ZXJtSGFuZGxlcihcbiAgICBjdXJyZW50QmFzZVBhdGgsXG4gICAgcy5zaWd0ZXJtSGFuZGxlcixcbiAgICAoKSA9PiBjbG9zZU91dFNpZ25hbEludGVycnVwdGVkVW5pdChjdXJyZW50QmFzZVBhdGgpLFxuICApO1xufVxuXG4vKiogV3JhcHBlcjogZGVyZWdpc3RlciBTSUdURVJNIGhhbmRsZXIgYW5kIGNsZWFyIHJlZmVyZW5jZS4gKi9cbmZ1bmN0aW9uIGRlcmVnaXN0ZXJTaWd0ZXJtSGFuZGxlcigpOiB2b2lkIHtcbiAgX2RlcmVnaXN0ZXJTaWd0ZXJtSGFuZGxlcihzLnNpZ3Rlcm1IYW5kbGVyKTtcbiAgcy5zaWd0ZXJtSGFuZGxlciA9IG51bGw7XG59XG5cbi8qKlxuICogV3JhcHBlcjogc3RhcnQgYmFja2dyb3VuZCBjb21tYW5kIHBvbGxpbmcgZm9yIHRoZSBjb25maWd1cmVkIHJlbW90ZSBjaGFubmVsXG4gKiAoY3VycmVudGx5IFRlbGVncmFtIG9ubHkpLiBTdG9yZXMgdGhlIGNsZWFudXAgZnVuY3Rpb24gb24gdGhlIHNlc3Npb24gc29cbiAqIGV2ZXJ5IGV4aXQgcGF0aCBjYW4gc3RvcCB0aGUgaW50ZXJ2YWwgdmlhIHN0b3BDb21tYW5kUG9sbGluZygpLlxuICogTm8tb3Agd2hlbiBubyByZW1vdGUgY2hhbm5lbCBpcyBjb25maWd1cmVkLlxuICovXG5mdW5jdGlvbiBzdGFydEF1dG9Db21tYW5kUG9sbGluZyhiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghaXNSZW1vdGVDb25maWd1cmVkKCkpIHJldHVybjtcbiAgLy8gQ2xlYXIgYW55IGV4aXN0aW5nIGludGVydmFsIGJlZm9yZSBzdGFydGluZyBhIG5ldyBvbmUgKGUuZy4gcmVzdW1lIHBhdGgpLlxuICBzdG9wQXV0b0NvbW1hbmRQb2xsaW5nKCk7XG4gIHMuY29tbWFuZFBvbGxpbmdDbGVhbnVwID0gX3N0YXJ0Q29tbWFuZFBvbGxpbmcoYmFzZVBhdGgpO1xufVxuXG4vKiogV3JhcHBlcjogc3RvcCBiYWNrZ3JvdW5kIGNvbW1hbmQgcG9sbGluZyBhbmQgY2xlYXIgdGhlIHN0b3JlZCBjbGVhbnVwLiAqL1xuZnVuY3Rpb24gc3RvcEF1dG9Db21tYW5kUG9sbGluZygpOiB2b2lkIHtcbiAgaWYgKHMuY29tbWFuZFBvbGxpbmdDbGVhbnVwKSB7XG4gICAgcy5jb21tYW5kUG9sbGluZ0NsZWFudXAoKTtcbiAgICBzLmNvbW1hbmRQb2xsaW5nQ2xlYW51cCA9IG51bGw7XG4gIH1cbn1cblxuZXhwb3J0IHsgdHlwZSBBdXRvRGFzaGJvYXJkRGF0YSB9IGZyb20gXCIuL2F1dG8tZGFzaGJvYXJkLmpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRBdXRvRGFzaGJvYXJkRGF0YSgpOiBBdXRvRGFzaGJvYXJkRGF0YSB7XG4gIGNvbnN0IGxlZGdlciA9IGdldExlZGdlcigpO1xuICBjb25zdCB0b3RhbHMgPSBsZWRnZXIgPyBnZXRQcm9qZWN0VG90YWxzKGxlZGdlci51bml0cykgOiBudWxsO1xuICBjb25zdCBzZXNzaW9uSWQgPSBzLmNtZEN0eD8uc2Vzc2lvbk1hbmFnZXI/LmdldFNlc3Npb25JZD8uKCkgPz8gbnVsbDtcbiAgY29uc3QgcnRrU2F2aW5ncyA9IHNlc3Npb25JZCAmJiBzLmJhc2VQYXRoXG4gICAgPyBnZXRSdGtTZXNzaW9uU2F2aW5ncyhzLmJhc2VQYXRoLCBzZXNzaW9uSWQpXG4gICAgOiBudWxsO1xuICBjb25zdCBydGtFbmFibGVkID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKHMuYmFzZVBhdGggfHwgdW5kZWZpbmVkKT8ucHJlZmVyZW5jZXMuZXhwZXJpbWVudGFsPy5ydGsgPT09IHRydWU7XG4gIC8vIFBlbmRpbmcgY2FwdHVyZSBjb3VudCBcdTIwMTQgbGF6eSBjaGVjaywgbm9uLWZhdGFsXG4gIGxldCBwZW5kaW5nQ2FwdHVyZUNvdW50ID0gMDtcbiAgdHJ5IHtcbiAgICBpZiAocy5iYXNlUGF0aCkge1xuICAgICAgcGVuZGluZ0NhcHR1cmVDb3VudCA9IGNvdW50UGVuZGluZ0NhcHR1cmVzKHMuYmFzZVBhdGgpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBjYXB0dXJlcyBtb2R1bGUgbWF5IG5vdCBiZSBsb2FkZWRcbiAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBjYXB0dXJlIGNvdW50IGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCwgeyBmaWxlOiBcImF1dG8udHNcIiB9KTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGFjdGl2ZTogcy5hY3RpdmUsXG4gICAgcGF1c2VkOiBzLnBhdXNlZCxcbiAgICBzdGVwTW9kZTogcy5zdGVwTW9kZSxcbiAgICBzdGFydFRpbWU6IHMuYXV0b1N0YXJ0VGltZSxcbiAgICBlbGFwc2VkOiBzLmFjdGl2ZSB8fCBzLnBhdXNlZFxuICAgICAgPyAocy5hdXRvU3RhcnRUaW1lID4gMCA/IERhdGUubm93KCkgLSBzLmF1dG9TdGFydFRpbWUgOiAwKVxuICAgICAgOiAwLFxuICAgIGN1cnJlbnRVbml0OiBzLmN1cnJlbnRVbml0ID8geyAuLi5zLmN1cnJlbnRVbml0IH0gOiBudWxsLFxuICAgIGJhc2VQYXRoOiBzLmJhc2VQYXRoLFxuICAgIHRvdGFsQ29zdDogdG90YWxzPy5jb3N0ID8/IDAsXG4gICAgdG90YWxUb2tlbnM6IHRvdGFscz8udG9rZW5zLnRvdGFsID8/IDAsXG4gICAgcGVuZGluZ0NhcHR1cmVDb3VudCxcbiAgICBydGtTYXZpbmdzLFxuICAgIHJ0a0VuYWJsZWQsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gaXNBdXRvQWN0aXZlKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gcy5hY3RpdmU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0F1dG9Db21wbGV0aW9uU3RvcEluUHJvZ3Jlc3MoKTogYm9vbGVhbiB7XG4gIHJldHVybiBzLmNvbXBsZXRpb25TdG9wSW5Qcm9ncmVzcztcbn1cblxuLyoqIFRlc3Qtb25seSBzZWFtIGZvciB2YWxpZGF0aW5nIGF1dG8tbW9kZSBndWFyZHMgKCM0NzA0KS4gRG8gbm90IHVzZSBpbiBwcm9kdWN0aW9uIGNvZGUuICovXG5leHBvcnQgZnVuY3Rpb24gX3NldEF1dG9BY3RpdmVGb3JUZXN0KGFjdGl2ZTogYm9vbGVhbik6IHZvaWQge1xuICBzLmFjdGl2ZSA9IGFjdGl2ZTtcbn1cblxuLyoqXG4gKiBUZXN0LW9ubHkgc2VhbTogZW1pdCB0aGUgbWlzc2luZy13b3JrdHJlZSB3YXJuaW5nIGV4YWN0bHkgYXMgdGhlIHJlc3VtZSBwYXRoXG4gKiBkb2VzLiAgQWxsb3dzIHVuaXQgdGVzdHMgdG8gdmVyaWZ5IHRoZSB3YXJuaW5nIGlzIHByb2R1Y2VkIHdpdGhvdXRcbiAqIGJvb3RzdHJhcHBpbmcgdGhlIGZ1bGwgYXV0by1tb2RlIGVudHJ5IHBvaW50LiAgRG8gbm90IHVzZSBpbiBwcm9kdWN0aW9uIGNvZGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfd2FybklmV29ya3RyZWVNaXNzaW5nRm9yVGVzdChcbiAgd29ya3RyZWVQYXRoOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuKTogYm9vbGVhbiB7XG4gIGlmICh3b3JrdHJlZVBhdGggJiYgIWV4aXN0c1N5bmMod29ya3RyZWVQYXRoKSkge1xuICAgIGxvZ1dhcm5pbmcoXG4gICAgICBcInNlc3Npb25cIixcbiAgICAgIGBXb3JrdHJlZSB3YXMgZXhwZWN0ZWQgYXQgJHt3b3JrdHJlZVBhdGh9IGJ1dCBpcyBtaXNzaW5nLiBDb250aW51aW5nIGluIHByb2plY3Qtcm9vdCBtb2RlLiBUbyByZXN0YXJ0IHdpdGggYSBmcmVzaCB3b3JrdHJlZSwgcnVuIC9nc2QtZGVidWcgb3IgcmVjcmVhdGUgdGhlIG1pbGVzdG9uZS5gLFxuICAgICAgeyBmaWxlOiBcImF1dG8udHNcIiwgbWlsZXN0b25lSWQgfSxcbiAgICApO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzQXV0b1BhdXNlZCgpOiBib29sZWFuIHtcbiAgcmV0dXJuIHMucGF1c2VkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlc3VtZVJlc291cmNlUmVmcmVzaERlcHMge1xuICBlbnY/OiBOb2RlSlMuUHJvY2Vzc0VudjtcbiAgaW1wb3J0TW9kdWxlPzogKHNwZWNpZmllcjogc3RyaW5nKSA9PiBQcm9taXNlPGFueT47XG4gIG9wZW5Qcm9qZWN0RGI/OiAoYmFzZVBhdGg6IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hSZXN1bWVSZXNvdXJjZXNBbmREYihcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgZGVwczogUmVzdW1lUmVzb3VyY2VSZWZyZXNoRGVwcyA9IHt9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGVudiA9IGRlcHMuZW52ID8/IHByb2Nlc3MuZW52O1xuICBjb25zdCBpbXBvcnRNb2R1bGUgPSBkZXBzLmltcG9ydE1vZHVsZSA/PyAoKHNwZWNpZmllcjogc3RyaW5nKSA9PiBpbXBvcnQoc3BlY2lmaWVyKSk7XG4gIGNvbnN0IGFnZW50RGlyID0gZW52LkdTRF9DT0RJTkdfQUdFTlRfRElSIHx8IGpvaW4oZ3NkSG9tZSgpLCBcImFnZW50XCIpO1xuICBjb25zdCBwa2dSb290ID0gZW52LkdTRF9QS0dfUk9PVDtcbiAgY29uc3QgcmVzb3VyY2VMb2FkZXJQYXRoID0gcGtnUm9vdFxuICAgID8gcGF0aFRvRmlsZVVSTChqb2luKHBrZ1Jvb3QsIFwiZGlzdFwiLCBcInJlc291cmNlLWxvYWRlci5qc1wiKSkuaHJlZlxuICAgIDogbmV3IFVSTChcIi4uLy4uLy4uL3Jlc291cmNlLWxvYWRlci5qc1wiLCBpbXBvcnQubWV0YS51cmwpLmhyZWY7XG4gIGNvbnN0IHsgaW5pdFJlc291cmNlcyB9ID0gYXdhaXQgaW1wb3J0TW9kdWxlKHJlc291cmNlTG9hZGVyUGF0aCk7XG4gIGluaXRSZXNvdXJjZXMoYWdlbnREaXIpO1xuICBjb25zdCB7IHByaW1lQ2FjaGUgfSA9IGF3YWl0IGltcG9ydE1vZHVsZShcIi4vcHJvbXB0LWxvYWRlci5qc1wiKTtcbiAgcHJpbWVDYWNoZSgpO1xuICBhd2FpdCAoZGVwcy5vcGVuUHJvamVjdERiID8/IG9wZW5Qcm9qZWN0RGJJZlByZXNlbnQpKGJhc2VQYXRoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEFjdGl2ZUVuZ2luZUlkKGlkOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIHMuYWN0aXZlRW5naW5lSWQgPSBpZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEFjdGl2ZUVuZ2luZUlkKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gcy5hY3RpdmVFbmdpbmVJZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEFjdGl2ZVJ1bkRpcihydW5EaXI6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgcy5hY3RpdmVSdW5EaXIgPSBydW5EaXI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRBY3RpdmVSdW5EaXIoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBzLmFjdGl2ZVJ1bkRpcjtcbn1cblxuLyoqXG4gKiBSZXR1cm4gdGhlIG1vZGVsIGNhcHR1cmVkIGF0IGF1dG8tbW9kZSBzdGFydCBmb3IgdGhpcyBzZXNzaW9uLlxuICogVXNlZCBieSBlcnJvci1yZWNvdmVyeSB0byBmYWxsIGJhY2sgdG8gdGhlIHNlc3Npb24ncyBvd24gbW9kZWxcbiAqIGluc3RlYWQgb2YgcmVhZGluZyAocG90ZW50aWFsbHkgc3RhbGUpIHByZWZlcmVuY2VzIGZyb20gZGlzayAoIzEwNjUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0QXV0b01vZGVTdGFydE1vZGVsKCk6IHtcbiAgcHJvdmlkZXI6IHN0cmluZztcbiAgaWQ6IHN0cmluZztcbn0gfCBudWxsIHtcbiAgcmV0dXJuIHMuYXV0b01vZGVTdGFydE1vZGVsO1xufVxuXG4vKipcbiAqIFVwZGF0ZSB0aGUgZGFzaGJvYXJkLWZhY2luZyBkaXNwYXRjaGVkIG1vZGVsIGxhYmVsLlxuICogVXNlZCB3aGVuIHJ1bnRpbWUgcmVjb3Zlcnkgc3dpdGNoZXMgbW9kZWxzIG1pZC11bml0IChlLmcuIHByb3ZpZGVyIGZhbGxiYWNrKVxuICogc28gdGhlIEFVVE8gYm94IHJlZmxlY3RzIHRoZSBhY3RpdmUgbW9kZWwgaW1tZWRpYXRlbHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50RGlzcGF0Y2hlZE1vZGVsSWQobW9kZWw6IHsgcHJvdmlkZXI6IHN0cmluZzsgaWQ6IHN0cmluZyB9IHwgbnVsbCk6IHZvaWQge1xuICBzLmN1cnJlbnREaXNwYXRjaGVkTW9kZWxJZCA9IG1vZGVsID8gYCR7bW9kZWwucHJvdmlkZXJ9LyR7bW9kZWwuaWR9YCA6IG51bGw7XG59XG5cbi8vIFRvb2wgdHJhY2tpbmcgXHUyMDE0IGRlbGVnYXRlcyB0byBhdXRvLXRvb2wtdHJhY2tpbmcudHNcbmV4cG9ydCBmdW5jdGlvbiBtYXJrVG9vbFN0YXJ0KHRvb2xDYWxsSWQ6IHN0cmluZywgdG9vbE5hbWU/OiBzdHJpbmcpOiB2b2lkIHtcbiAgX21hcmtUb29sU3RhcnQodG9vbENhbGxJZCwgcy5hY3RpdmUsIHRvb2xOYW1lKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hcmtUb29sRW5kKHRvb2xDYWxsSWQ6IHN0cmluZyk6IHZvaWQge1xuICBfbWFya1Rvb2xFbmQodG9vbENhbGxJZCk7XG59XG5cbi8qKlxuICogUmVjb3JkIGEgdG9vbCBpbnZvY2F0aW9uIGVycm9yIG9uIHRoZSBjdXJyZW50IHNlc3Npb24gKCMyODgzKS5cbiAqIENhbGxlZCBmcm9tIHRvb2xfZXhlY3V0aW9uX2VuZCB3aGVuIGEgR1NEIHRvb2wgZmFpbHMgd2l0aCBpc0Vycm9yLlxuICogU3RvcmVzIHRoZSBlcnJvciBpZiBpdCBtYXRjaGVzOlxuICogICAtIHRvb2wtaW52b2NhdGlvbi1lcnJvciBwYXR0ZXJuIChtYWxmb3JtZWQvdHJ1bmNhdGVkIEpTT04pXG4gKiAgIC0gcXVldWVkLXVzZXItbWVzc2FnZSBza2lwIHBhdHRlcm5cbiAqICAgLSBkZXRlcm1pbmlzdGljIHBvbGljeSByZWplY3Rpb24gKCM0OTczLCBlLmcuIGNvbnRleHRfd3JpdGVfYmxvY2tlZClcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZFRvb2xJbnZvY2F0aW9uRXJyb3IodG9vbE5hbWU6IHN0cmluZywgZXJyb3JNc2c6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIXMuYWN0aXZlKSByZXR1cm47XG4gIGlmIChpc1Rvb2xJbnZvY2F0aW9uRXJyb3IoZXJyb3JNc2cpIHx8IGlzUXVldWVkVXNlck1lc3NhZ2VTa2lwKGVycm9yTXNnKSB8fCBpc0RldGVybWluaXN0aWNQb2xpY3lFcnJvcihlcnJvck1zZykpIHtcbiAgICBzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yID0gYCR7dG9vbE5hbWV9OiAke2Vycm9yTXNnfWA7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldE9sZGVzdEluRmxpZ2h0VG9vbEFnZU1zKCk6IG51bWJlciB7XG4gIHJldHVybiBfZ2V0T2xkZXN0SW5GbGlnaHRUb29sQWdlTXMoKTtcbn1cblxuLyoqXG4gKiBSZXR1cm4gdGhlIGJhc2UgcGF0aCB0byB1c2UgZm9yIHRoZSBhdXRvLmxvY2sgZmlsZS5cbiAqIEFsd2F5cyB1c2VzIHRoZSBvcmlnaW5hbCBwcm9qZWN0IHJvb3QgKG5vdCB0aGUgd29ya3RyZWUpIHNvIHRoYXRcbiAqIGEgc2Vjb25kIHRlcm1pbmFsIGNhbiBkaXNjb3ZlciBhbmQgc3RvcCBhIHJ1bm5pbmcgYXV0by1tb2RlIHNlc3Npb24uXG4gKlxuICogRGVsZWdhdGVzIHRvIEF1dG9TZXNzaW9uLmxvY2tCYXNlUGF0aCBcdTIwMTQgdGhlIHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGguXG4gKi9cbmZ1bmN0aW9uIGxvY2tCYXNlKCk6IHN0cmluZyB7XG4gIHJldHVybiBzLmxvY2tCYXNlUGF0aDtcbn1cblxuLyoqXG4gKiBBdHRlbXB0IHRvIHN0b3AgYSBydW5uaW5nIGF1dG8tbW9kZSBzZXNzaW9uIGZyb20gYSBkaWZmZXJlbnQgcHJvY2Vzcy5cbiAqIFJlYWRzIHRoZSBsb2NrIGZpbGUgYXQgdGhlIHByb2plY3Qgcm9vdCwgY2hlY2tzIGlmIHRoZSBQSUQgaXMgYWxpdmUsXG4gKiBhbmQgc2VuZHMgU0lHVEVSTSB0byBncmFjZWZ1bGx5IHN0b3AgaXQuXG4gKlxuICogUmV0dXJucyB0cnVlIGlmIGEgcmVtb3RlIHNlc3Npb24gd2FzIGZvdW5kIGFuZCBzaWduYWxlZCwgZmFsc2Ugb3RoZXJ3aXNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RvcEF1dG9SZW1vdGUocHJvamVjdFJvb3Q6IHN0cmluZyk6IHtcbiAgZm91bmQ6IGJvb2xlYW47XG4gIHBpZD86IG51bWJlcjtcbiAgZXJyb3I/OiBzdHJpbmc7XG59IHtcbiAgY29uc3QgbG9jayA9IHJlYWRDcmFzaExvY2socHJvamVjdFJvb3QpO1xuICBpZiAoIWxvY2spIHJldHVybiB7IGZvdW5kOiBmYWxzZSB9O1xuXG4gIC8vIE5ldmVyIFNJR1RFUk0gb3Vyc2VsdmVzIFx1MjAxNCBhIHN0YWxlIGxvY2sgd2l0aCBvdXIgb3duIFBJRCBpcyBub3QgYSByZW1vdGVcbiAgLy8gc2Vzc2lvbiwgaXQgaXMgbGVmdG92ZXIgZnJvbSBhIHByaW9yIGxvb3AgZXhpdCBpbiB0aGlzIHByb2Nlc3MuICgjMjczMClcbiAgaWYgKGxvY2sucGlkID09PSBwcm9jZXNzLnBpZCkge1xuICAgIGNsZWFyTG9jayhwcm9qZWN0Um9vdCk7XG4gICAgcmV0dXJuIHsgZm91bmQ6IGZhbHNlIH07XG4gIH1cblxuICBpZiAoIWlzTG9ja1Byb2Nlc3NBbGl2ZShsb2NrKSkge1xuICAgIC8vIFN0YWxlIGxvY2sgXHUyMDE0IGNsZWFuIGl0IHVwXG4gICAgY2xlYXJMb2NrKHByb2plY3RSb290KTtcbiAgICByZXR1cm4geyBmb3VuZDogZmFsc2UgfTtcbiAgfVxuXG4gIC8vIFNlbmQgU0lHVEVSTSBcdTIwMTQgdGhlIGF1dG8tbW9kZSBwcm9jZXNzIGhhcyBhIGhhbmRsZXIgdGhhdCBjbGVhcnMgdGhlIGxvY2sgYW5kIGV4aXRzXG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5raWxsKGxvY2sucGlkLCBcIlNJR1RFUk1cIik7XG4gICAgcmV0dXJuIHsgZm91bmQ6IHRydWUsIHBpZDogbG9jay5waWQgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHsgZm91bmQ6IGZhbHNlLCBlcnJvcjogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9O1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgYSByZW1vdGUgYXV0by1tb2RlIHNlc3Npb24gaXMgcnVubmluZyAoZnJvbSBhIGRpZmZlcmVudCBwcm9jZXNzKS5cbiAqIFJlYWRzIHRoZSBjcmFzaCBsb2NrLCBjaGVja3MgUElEIGxpdmVuZXNzLCBhbmQgcmV0dXJucyBzZXNzaW9uIGRldGFpbHMuXG4gKiBVc2VkIGJ5IHRoZSBndWFyZCBpbiBjb21tYW5kcy50cyB0byBwcmV2ZW50IGJhcmUgL2dzZCwgL2dzZCBuZXh0LCBhbmRcbiAqIC9nc2QgYXV0byBmcm9tIHN0ZWFsaW5nIHRoZSBzZXNzaW9uIGxvY2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja1JlbW90ZUF1dG9TZXNzaW9uKHByb2plY3RSb290OiBzdHJpbmcpOiB7XG4gIHJ1bm5pbmc6IGJvb2xlYW47XG4gIHBpZD86IG51bWJlcjtcbiAgdW5pdFR5cGU/OiBzdHJpbmc7XG4gIHVuaXRJZD86IHN0cmluZztcbiAgc3RhcnRlZEF0Pzogc3RyaW5nO1xufSB7XG4gIGNvbnN0IGxvY2sgPSByZWFkQ3Jhc2hMb2NrKHByb2plY3RSb290KTtcbiAgaWYgKCFsb2NrKSByZXR1cm4geyBydW5uaW5nOiBmYWxzZSB9O1xuXG4gIC8vIE91ciBvd24gUElEIGlzIG5vdCBhIFwicmVtb3RlXCIgc2Vzc2lvbiBcdTIwMTQgaXQgaXMgYSBzdGFsZSBsb2NrIGxlZnQgYnkgdGhpc1xuICAvLyBwcm9jZXNzIChlLmcuIGFmdGVyIHN0ZXAtbW9kZSBleGl0IHdpdGhvdXQgZnVsbCBjbGVhbnVwKS4gKCMyNzMwKVxuICBpZiAobG9jay5waWQgPT09IHByb2Nlc3MucGlkKSByZXR1cm4geyBydW5uaW5nOiBmYWxzZSB9O1xuXG4gIGlmICghaXNMb2NrUHJvY2Vzc0FsaXZlKGxvY2spKSB7XG4gICAgLy8gU3RhbGUgbG9jayBmcm9tIGEgZGVhZCBwcm9jZXNzIFx1MjAxNCBub3QgYSBsaXZlIHJlbW90ZSBzZXNzaW9uXG4gICAgcmV0dXJuIHsgcnVubmluZzogZmFsc2UgfTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgcnVubmluZzogdHJ1ZSxcbiAgICBwaWQ6IGxvY2sucGlkLFxuICAgIHVuaXRUeXBlOiBsb2NrLnVuaXRUeXBlLFxuICAgIHVuaXRJZDogbG9jay51bml0SWQsXG4gICAgc3RhcnRlZEF0OiBsb2NrLnN0YXJ0ZWRBdCxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzU3RlcE1vZGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBzLnN0ZXBNb2RlO1xufVxuXG5mdW5jdGlvbiBjbGVhclVuaXRUaW1lb3V0KCk6IHZvaWQge1xuICBpZiAocy51bml0VGltZW91dEhhbmRsZSkge1xuICAgIGNsZWFyVGltZW91dChzLnVuaXRUaW1lb3V0SGFuZGxlKTtcbiAgICBzLnVuaXRUaW1lb3V0SGFuZGxlID0gbnVsbDtcbiAgfVxuICBpZiAocy53cmFwdXBXYXJuaW5nSGFuZGxlKSB7XG4gICAgY2xlYXJUaW1lb3V0KHMud3JhcHVwV2FybmluZ0hhbmRsZSk7XG4gICAgcy53cmFwdXBXYXJuaW5nSGFuZGxlID0gbnVsbDtcbiAgfVxuICBpZiAocy5pZGxlV2F0Y2hkb2dIYW5kbGUpIHtcbiAgICBjbGVhckludGVydmFsKHMuaWRsZVdhdGNoZG9nSGFuZGxlKTtcbiAgICBzLmlkbGVXYXRjaGRvZ0hhbmRsZSA9IG51bGw7XG4gIH1cbiAgaWYgKHMuY29udGludWVIZXJlSGFuZGxlKSB7XG4gICAgY2xlYXJJbnRlcnZhbChzLmNvbnRpbnVlSGVyZUhhbmRsZSk7XG4gICAgcy5jb250aW51ZUhlcmVIYW5kbGUgPSBudWxsO1xuICB9XG4gIGNsZWFySW5GbGlnaHRUb29scygpO1xufVxuXG4vKiogQnVpbGQgc25hcHNob3QgbWV0cmljIG9wdHMuICovXG5mdW5jdGlvbiBidWlsZFNuYXBzaG90T3B0cyhcbiAgX3VuaXRUeXBlOiBzdHJpbmcsXG4gIF91bml0SWQ6IHN0cmluZyxcbik6IHtcbiAgYXV0b1Nlc3Npb25LZXk/OiBzdHJpbmc7XG4gIGNvbnRpbnVlSGVyZUZpcmVkPzogYm9vbGVhbjtcbiAgcHJvbXB0Q2hhckNvdW50PzogbnVtYmVyO1xuICBiYXNlbGluZUNoYXJDb3VudD86IG51bWJlcjtcbiAgdHJhY2VJZD86IHN0cmluZztcbiAgdHVybklkPzogc3RyaW5nO1xuICBnaXRBY3Rpb24/OiBcImNvbW1pdFwiIHwgXCJzbmFwc2hvdFwiIHwgXCJzdGF0dXMtb25seVwiO1xuICBnaXRQdXNoPzogYm9vbGVhbjtcbiAgZ2l0U3RhdHVzPzogXCJva1wiIHwgXCJmYWlsZWRcIjtcbiAgZ2l0RXJyb3I/OiBzdHJpbmc7XG59ICYgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhzLmJhc2VQYXRoIHx8IHVuZGVmaW5lZCk/LnByZWZlcmVuY2VzO1xuICBjb25zdCB1b2tGbGFncyA9IHJlc29sdmVVb2tGbGFncyhwcmVmcyk7XG4gIHJldHVybiB7XG4gICAgLi4uKHMuYXV0b1N0YXJ0VGltZSA+IDAgPyB7IGF1dG9TZXNzaW9uS2V5OiBTdHJpbmcocy5hdXRvU3RhcnRUaW1lKSB9IDoge30pLFxuICAgIHByb21wdENoYXJDb3VudDogcy5sYXN0UHJvbXB0Q2hhckNvdW50LFxuICAgIGJhc2VsaW5lQ2hhckNvdW50OiBzLmxhc3RCYXNlbGluZUNoYXJDb3VudCxcbiAgICB0cmFjZUlkOiBzLmN1cnJlbnRUcmFjZUlkID8/IHVuZGVmaW5lZCxcbiAgICB0dXJuSWQ6IHMuY3VycmVudFR1cm5JZCA/PyB1bmRlZmluZWQsXG4gICAgLi4uKHVva0ZsYWdzLmdpdG9wc1xuICAgICAgPyB7XG4gICAgICAgICAgZ2l0QWN0aW9uOiB1b2tGbGFncy5naXRvcHNUdXJuQWN0aW9uLFxuICAgICAgICAgIGdpdFB1c2g6IHVva0ZsYWdzLmdpdG9wc1R1cm5QdXNoLFxuICAgICAgICAgIGdpdFN0YXR1czogcy5sYXN0R2l0QWN0aW9uU3RhdHVzID8/IHVuZGVmaW5lZCxcbiAgICAgICAgICBnaXRFcnJvcjogcy5sYXN0R2l0QWN0aW9uRmFpbHVyZSA/PyB1bmRlZmluZWQsXG4gICAgICAgIH1cbiAgICAgIDoge30pLFxuICAgIC4uLihzLmN1cnJlbnRVbml0Um91dGluZyA/PyB7fSksXG4gIH07XG59XG5cbmZ1bmN0aW9uIGN1cnJlbnRVbml0TGFiZWwoKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghcy5jdXJyZW50VW5pdCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBgJHt1bml0VmVyYihzLmN1cnJlbnRVbml0LnR5cGUpfSAke3MuY3VycmVudFVuaXQuaWR9YDtcbn1cblxuZnVuY3Rpb24gc2V0TGlmZWN5Y2xlT3V0Y29tZShcbiAgY3R4OiBFeHRlbnNpb25Db250ZXh0IHwgdW5kZWZpbmVkLFxuICBpbnB1dDoge1xuICAgIHN0YXR1czogXCJwYXVzZWRcIiB8IFwic3RvcHBlZFwiIHwgXCJibG9ja2VkXCIgfCBcImZhaWxlZFwiIHwgXCJjb21wbGV0ZVwiIHwgXCJ3YWl0aW5nXCIgfCBcInN0ZXBcIjtcbiAgICB0aXRsZTogc3RyaW5nO1xuICAgIGRldGFpbD86IHN0cmluZyB8IG51bGw7XG4gICAgbmV4dEFjdGlvbjogc3RyaW5nO1xuICAgIGNvbW1hbmRzPzogc3RyaW5nW107XG4gICAgdW5pdExhYmVsPzogc3RyaW5nIHwgbnVsbDtcbiAgfSxcbik6IHZvaWQge1xuICBpZiAoIWN0eD8uaGFzVUkpIHJldHVybjtcbiAgY29uc3QgeyB1bml0TGFiZWw6IHVuaXRMYWJlbE92ZXJyaWRlLCAuLi5yZXN0IH0gPSBpbnB1dDtcbiAgc2V0QXV0b091dGNvbWVXaWRnZXQoY3R4LCB7XG4gICAgLi4ucmVzdCxcbiAgICB1bml0TGFiZWw6IHVuaXRMYWJlbE92ZXJyaWRlICE9PSB1bmRlZmluZWQgPyB1bml0TGFiZWxPdmVycmlkZSA6IGN1cnJlbnRVbml0TGFiZWwoKSxcbiAgICBzdGFydGVkQXQ6IHMuYXV0b1N0YXJ0VGltZSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZUxvc3RTZXNzaW9uTG9jayhcbiAgY3R4PzogRXh0ZW5zaW9uQ29udGV4dCxcbiAgbG9ja1N0YXR1cz86IFNlc3Npb25Mb2NrU3RhdHVzLFxuKTogdm9pZCB7XG4gIGRlYnVnTG9nKFwic2Vzc2lvbi1sb2NrLWxvc3RcIiwge1xuICAgIGxvY2tCYXNlOiBsb2NrQmFzZSgpLFxuICAgIHJlYXNvbjogbG9ja1N0YXR1cz8uZmFpbHVyZVJlYXNvbixcbiAgICBleGlzdGluZ1BpZDogbG9ja1N0YXR1cz8uZXhpc3RpbmdQaWQsXG4gICAgZXhwZWN0ZWRQaWQ6IGxvY2tTdGF0dXM/LmV4cGVjdGVkUGlkLFxuICB9KTtcbiAgcy5hY3RpdmUgPSBmYWxzZTtcbiAgcy5wYXVzZWQgPSBmYWxzZTtcbiAgZGVhY3RpdmF0ZUdTRCgpO1xuICBjbGVhclVuaXRUaW1lb3V0KCk7XG4gIHN0b3BBdXRvQ29tbWFuZFBvbGxpbmcoKTtcbiAgcmVzdG9yZVByb2plY3RSb290RW52KCk7XG4gIHJlc3RvcmVNaWxlc3RvbmVMb2NrRW52KCk7XG4gIGRlcmVnaXN0ZXJTaWd0ZXJtSGFuZGxlcigpO1xuICBjb25zdCBiYXNlID0gbG9ja0Jhc2UoKTtcbiAgY29uc3QgbG9ja0ZpbGVQYXRoID0gYmFzZSA/IGpvaW4oZ3NkUm9vdChiYXNlKSwgXCJhdXRvLmxvY2tcIikgOiBcInVua25vd25cIjtcbiAgY29uc3QgcmVjb3ZlcnlTdWdnZXN0aW9uID0gXCJcXG5UbyByZWNvdmVyLCBydW46IGdzZCBkb2N0b3IgLS1maXhcIjtcbiAgY29uc3QgbWVzc2FnZSA9XG4gICAgbG9ja1N0YXR1cz8uZmFpbHVyZVJlYXNvbiA9PT0gXCJwaWQtbWlzbWF0Y2hcIlxuICAgICAgPyBsb2NrU3RhdHVzLmV4aXN0aW5nUGlkXG4gICAgICAgID8gYFNlc3Npb24gbG9jayAoJHtsb2NrRmlsZVBhdGh9KSBtb3ZlZCB0byBQSUQgJHtsb2NrU3RhdHVzLmV4aXN0aW5nUGlkfSBcdTIwMTQgYW5vdGhlciBHU0QgcHJvY2VzcyBhcHBlYXJzIHRvIGhhdmUgdGFrZW4gb3Zlci4gU3RvcHBpbmcgZ3JhY2VmdWxseS4ke3JlY292ZXJ5U3VnZ2VzdGlvbn1gXG4gICAgICAgIDogYFNlc3Npb24gbG9jayAoJHtsb2NrRmlsZVBhdGh9KSBtb3ZlZCB0byBhIGRpZmZlcmVudCBwcm9jZXNzIFx1MjAxNCBhbm90aGVyIEdTRCBwcm9jZXNzIGFwcGVhcnMgdG8gaGF2ZSB0YWtlbiBvdmVyLiBTdG9wcGluZyBncmFjZWZ1bGx5LiR7cmVjb3ZlcnlTdWdnZXN0aW9ufWBcbiAgICAgIDogbG9ja1N0YXR1cz8uZmFpbHVyZVJlYXNvbiA9PT0gXCJtaXNzaW5nLW1ldGFkYXRhXCJcbiAgICAgICAgPyBgU2Vzc2lvbiBsb2NrIG1ldGFkYXRhICgke2xvY2tGaWxlUGF0aH0pIGRpc2FwcGVhcmVkLCBzbyBvd25lcnNoaXAgY291bGQgbm90IGJlIGNvbmZpcm1lZC4gU3RvcHBpbmcgZ3JhY2VmdWxseS4ke3JlY292ZXJ5U3VnZ2VzdGlvbn1gXG4gICAgICAgIDogbG9ja1N0YXR1cz8uZmFpbHVyZVJlYXNvbiA9PT0gXCJjb21wcm9taXNlZFwiXG4gICAgICAgICAgPyBgU2Vzc2lvbiBsb2NrICgke2xvY2tGaWxlUGF0aH0pIHdhcyBjb21wcm9taXNlZCBkdXJpbmcgaGVhcnRiZWF0IGNoZWNrcyAoUElEICR7cHJvY2Vzcy5waWR9KS4gVGhpcyBjYW4gaGFwcGVuIGFmdGVyIGxvbmcgZXZlbnQgbG9vcCBzdGFsbHMgZHVyaW5nIHN1YmFnZW50IGV4ZWN1dGlvbi4ke3JlY292ZXJ5U3VnZ2VzdGlvbn1gXG4gICAgICAgICAgOiBgU2Vzc2lvbiBsb2NrIGxvc3QgKCR7bG9ja0ZpbGVQYXRofSkuIFN0b3BwaW5nIGdyYWNlZnVsbHkuJHtyZWNvdmVyeVN1Z2dlc3Rpb259YDtcbiAgY3R4Py51aS5ub3RpZnkoXG4gICAgbWVzc2FnZSxcbiAgICBcImVycm9yXCIsXG4gICk7XG4gIGN0eD8udWkuc2V0U3RhdHVzKFwiZ3NkLWF1dG9cIiwgdW5kZWZpbmVkKTtcbiAgY3R4Py51aS5zZXRXaWRnZXQoXCJnc2QtcHJvZ3Jlc3NcIiwgdW5kZWZpbmVkKTtcbiAgaWYgKGN0eCkgaW5pdEhlYWx0aFdpZGdldChjdHgpO1xufVxuXG4vKipcbiAqIExpZ2h0d2VpZ2h0IGNsZWFudXAgYWZ0ZXIgYXV0b0xvb3AgZXhpdHMgdmlhIHN0ZXAtd2l6YXJkIGJyZWFrLlxuICpcbiAqIFVubGlrZSBzdG9wQXV0byAod2hpY2ggdGVhcnMgZG93biB0aGUgZW50aXJlIHNlc3Npb24pLCB0aGlzIG9ubHkgY2xlYXJzXG4gKiB0aGUgc3RhbGUgdW5pdCBzdGF0ZSwgcHJvZ3Jlc3Mgd2lkZ2V0LCBzdGF0dXMgYmFkZ2UsIGFuZCByZXN0b3JlcyBDV0Qgc29cbiAqIHRoZSBkYXNoYm9hcmQgZG9lcyBub3Qgc2hvdyBhbiBvcnBoYW5lZCB0aW1lciBhbmQgdGhlIHNoZWxsIGlzIHVzYWJsZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlcm9vdENvbW1hbmRTZXNzaW9uKFxuICBjbWRDdHg6IFBpY2s8RXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIFwibmV3U2Vzc2lvblwiPiB8IG51bGwgfCB1bmRlZmluZWQsXG4gIHdvcmtzcGFjZVJvb3Q6IHN0cmluZyxcbik6IFByb21pc2U8eyBzdGF0dXM6IFwic2tpcHBlZFwiIHwgXCJva1wiIHwgXCJjYW5jZWxsZWRcIiB8IFwiZmFpbGVkXCI7IGVycm9yPzogc3RyaW5nIH0+IHtcbiAgaWYgKCFjbWRDdHggfHwgIXdvcmtzcGFjZVJvb3QpIHJldHVybiB7IHN0YXR1czogXCJza2lwcGVkXCIgfTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbWRDdHgubmV3U2Vzc2lvbih7IHdvcmtzcGFjZVJvb3QgfSk7XG4gICAgcmV0dXJuIHJlc3VsdC5jYW5jZWxsZWQgPyB7IHN0YXR1czogXCJjYW5jZWxsZWRcIiB9IDogeyBzdGF0dXM6IFwib2tcIiB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhdHVzOiBcImZhaWxlZFwiLFxuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGVhbnVwQWZ0ZXJMb29wRXhpdChjdHg6IEV4dGVuc2lvbkNvbnRleHQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcy5jdXJyZW50VW5pdCA9IG51bGw7XG4gIHMuYWN0aXZlID0gZmFsc2U7XG4gIGRlYWN0aXZhdGVHU0QoKTtcbiAgY2xlYXJVbml0VGltZW91dCgpO1xuICBzdG9wQXV0b0NvbW1hbmRQb2xsaW5nKCk7XG4gIHJlc3RvcmVQcm9qZWN0Um9vdEVudigpO1xuICByZXN0b3JlTWlsZXN0b25lTG9ja0VudigpO1xuXG4gIC8vIENsZWFyIGNyYXNoIGxvY2sgYW5kIHJlbGVhc2Ugc2Vzc2lvbiBsb2NrIHNvIHRoZSBuZXh0IGAvZ3NkIG5leHRgIGRvZXNcbiAgLy8gbm90IHNlZSBhIHN0YWxlIGxvY2sgd2l0aCB0aGUgY3VycmVudCBQSUQgYW5kIHRyZWF0IGl0IGFzIGEgXCJyZW1vdGVcIlxuICAvLyBzZXNzaW9uICh3aGljaCB3b3VsZCBjYXVzZSBpdCB0byBTSUdURVJNIGl0c2VsZikuICgjMjczMClcbiAgdHJ5IHtcbiAgICBpZiAobG9ja0Jhc2UoKSkgY2xlYXJMb2NrKGxvY2tCYXNlKCkpO1xuICAgIGlmIChsb2NrQmFzZSgpKSByZWxlYXNlU2Vzc2lvbkxvY2sobG9ja0Jhc2UoKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8qIGJlc3QtZWZmb3J0IFx1MjAxNCBtaXJyb3Igc3RvcEF1dG8gY2xlYW51cCAqL1xuICAgIGxvZ1dhcm5pbmcoXCJzZXNzaW9uXCIsIGBsb2NrIGNsZWFudXAgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLCB7IGZpbGU6IFwiYXV0by50c1wiIH0pO1xuICB9XG5cbiAgLy8gQSB0cmFuc2llbnQgcHJvdmlkZXItZXJyb3IgcGF1c2UgaW50ZW50aW9uYWxseSBsZWF2ZXMgdGhlIHBhdXNlZCBiYWRnZVxuICAvLyB2aXNpYmxlIHNvIHRoZSB1c2VyIHN0aWxsIGhhcyBhIHJlc3VtYWJsZSBhdXRvLW1vZGUgc2lnbmFsIG9uIHNjcmVlbi5cbiAgaWYgKCFzLnBhdXNlZCkge1xuICAgIGN0eC51aS5zZXRTdGF0dXMoXCJnc2QtYXV0b1wiLCB1bmRlZmluZWQpO1xuICAgIGN0eC51aS5zZXRXaWRnZXQoXCJnc2QtcHJvZ3Jlc3NcIiwgdW5kZWZpbmVkKTtcbiAgICBpZiAocy5jb21wbGV0aW9uU3RvcEluUHJvZ3Jlc3MpIHtcbiAgICAgIHMuY29tcGxldGlvblN0b3BJblByb2dyZXNzID0gZmFsc2U7XG4gICAgfVxuICAgIGluaXRIZWFsdGhXaWRnZXQoY3R4KTtcbiAgfVxuXG4gIC8vIEFEUi0wMTYgcGhhc2UgMyAoIzU2OTMpOiB0aGUgc3RvcC1wYXRoIGJhc2VQYXRoIHJlc3RvcmUgKyBjaGRpciByb3V0ZXNcbiAgLy8gdGhyb3VnaCBgTGlmZWN5Y2xlLnJlc3RvcmVUb1Byb2plY3RSb290KClgLCB0aGUgc29sZSBvd25lciBvZiBib3RoXG4gIC8vIGBzLmJhc2VQYXRoYCBtdXRhdGlvbiBhbmQgdGhlIHBhaXJlZCBgcHJvY2Vzcy5jaGRpcmAgZm9yIGF1dG8tbG9vcFxuICAvLyB0cmFuc2l0aW9ucy4gVGhlIHZlcmIgYXNzaWducyBgcy5iYXNlUGF0aGAgYmVmb3JlIGFueSB0aHJvd2FibGUgd29yaywgc29cbiAgLy8gYSB0aHJvd24gZXJyb3Igc3RpbGwgbGVhdmVzIGJhc2VQYXRoIHJlc3RvcmVkLlxuICBpZiAocy5vcmlnaW5hbEJhc2VQYXRoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGJ1aWxkTGlmZWN5Y2xlKCkucmVzdG9yZVRvUHJvamVjdFJvb3QoKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgIFwiZW5naW5lXCIsXG4gICAgICAgIGByZXN0b3JlIHByb2plY3Qgcm9vdCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICAgIHsgZmlsZTogXCJhdXRvLnRzXCIgfSxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHMub3JpZ2luYWxCYXNlUGF0aCAmJiBzLmNtZEN0eCkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcm9vdENvbW1hbmRTZXNzaW9uKHMuY21kQ3R4LCBzLm9yaWdpbmFsQmFzZVBhdGgpO1xuICAgIGlmIChyZXN1bHQuc3RhdHVzID09PSBcImNhbmNlbGxlZFwiKSB7XG4gICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIFwicG9zdC1sb29wIHNlc3Npb24gcmUtcm9vdCB3YXMgY2FuY2VsbGVkXCIsIHsgZmlsZTogXCJhdXRvLnRzXCIsIGJhc2VQYXRoOiBzLm9yaWdpbmFsQmFzZVBhdGggfSk7XG4gICAgfSBlbHNlIGlmIChyZXN1bHQuc3RhdHVzID09PSBcImZhaWxlZFwiKSB7XG4gICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBwb3N0LWxvb3Agc2Vzc2lvbiByZS1yb290IGZhaWxlZDogJHtyZXN1bHQuZXJyb3IgPz8gXCJ1bmtub3duXCJ9YCwgeyBmaWxlOiBcImF1dG8udHNcIiwgYmFzZVBhdGg6IHMub3JpZ2luYWxCYXNlUGF0aCB9KTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9jbGVhbnVwQWZ0ZXJMb29wRXhpdEZvclRlc3QoY3R4OiBFeHRlbnNpb25Db250ZXh0KTogUHJvbWlzZTx2b2lkPiB7XG4gIHJldHVybiBjbGVhbnVwQWZ0ZXJMb29wRXhpdChjdHgpO1xufVxuXG5leHBvcnQgdHlwZSBBdXRvV29ya3RyZWVFeGl0QWN0aW9uID0gXCJza2lwXCIgfCBcIm1lcmdlXCIgfCBcInByZXNlcnZlXCI7XG5cbmludGVyZmFjZSBNaWxlc3RvbmVDb21wbGV0aW9uUm9sbHVwIHtcbiAgbWlsZXN0b25lVGl0bGU/OiBzdHJpbmc7XG4gIG9uZUxpbmVyPzogc3RyaW5nO1xuICBzdWNjZXNzQ3JpdGVyaWFSZXN1bHRzPzogc3RyaW5nO1xuICBkZWZpbml0aW9uT2ZEb25lUmVzdWx0cz86IHN0cmluZztcbiAgcmVxdWlyZW1lbnRPdXRjb21lcz86IHN0cmluZztcbiAgZGV2aWF0aW9ucz86IHN0cmluZztcbiAgZm9sbG93VXBzPzogc3RyaW5nO1xuICBrZXlEZWNpc2lvbnM/OiBzdHJpbmdbXTtcbiAga2V5RmlsZXM/OiBzdHJpbmdbXTtcbiAgbGVzc29uc0xlYXJuZWQ/OiBzdHJpbmdbXTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplRnJvbnRtYXR0ZXJMaXN0KHZhbHVlOiB1bmtub3duKTogc3RyaW5nW10ge1xuICBpZiAoIUFycmF5LmlzQXJyYXkodmFsdWUpKSByZXR1cm4gW107XG4gIHJldHVybiB2YWx1ZVxuICAgIC5tYXAoaXRlbSA9PiB0eXBlb2YgaXRlbSA9PT0gXCJzdHJpbmdcIiA/IGl0ZW0udHJpbSgpIDogXCJcIilcbiAgICAuZmlsdGVyKGl0ZW0gPT4gaXRlbS5sZW5ndGggPiAwICYmIGl0ZW0gIT09IFwiKG5vbmUpXCIpO1xufVxuXG5mdW5jdGlvbiBmaXJzdEJvbGRQYXJhZ3JhcGgoYm9keTogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgbWF0Y2ggPSBib2R5Lm1hdGNoKC9cXCpcXCooW14qXFxuXVtcXHNcXFNdKj8pXFwqXFwqLyk7XG4gIHJldHVybiBtYXRjaD8uWzFdPy5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCkgfHwgdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBsb2FkTWlsZXN0b25lQ29tcGxldGlvblJvbGx1cChiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IE1pbGVzdG9uZUNvbXBsZXRpb25Sb2xsdXAge1xuICBpZiAoIW1pbGVzdG9uZUlkKSByZXR1cm4ge307XG4gIGNvbnN0IHN1bW1hcnlQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBcIlNVTU1BUllcIik7XG4gIGlmICghc3VtbWFyeVBhdGggfHwgIWV4aXN0c1N5bmMoc3VtbWFyeVBhdGgpKSByZXR1cm4ge307XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoc3VtbWFyeVBhdGgsIFwidXRmLThcIik7XG4gICAgY29uc3QgW2Zyb250bWF0dGVyTGluZXMsIGJvZHldID0gc3BsaXRGcm9udG1hdHRlcihyYXcpO1xuICAgIGNvbnN0IGZyb250bWF0dGVyID0gZnJvbnRtYXR0ZXJMaW5lcyA/IHBhcnNlRnJvbnRtYXR0ZXJNYXAoZnJvbnRtYXR0ZXJMaW5lcykgOiB7fTtcbiAgICByZXR1cm4ge1xuICAgICAgbWlsZXN0b25lVGl0bGU6IHR5cGVvZiBmcm9udG1hdHRlci50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IGZyb250bWF0dGVyLnRpdGxlIDogdW5kZWZpbmVkLFxuICAgICAgb25lTGluZXI6IGZpcnN0Qm9sZFBhcmFncmFwaChib2R5KSxcbiAgICAgIHN1Y2Nlc3NDcml0ZXJpYVJlc3VsdHM6IGV4dHJhY3RTZWN0aW9uKGJvZHksIFwiU3VjY2VzcyBDcml0ZXJpYSBSZXN1bHRzXCIpID8/IHVuZGVmaW5lZCxcbiAgICAgIGRlZmluaXRpb25PZkRvbmVSZXN1bHRzOiBleHRyYWN0U2VjdGlvbihib2R5LCBcIkRlZmluaXRpb24gb2YgRG9uZSBSZXN1bHRzXCIpID8/IHVuZGVmaW5lZCxcbiAgICAgIHJlcXVpcmVtZW50T3V0Y29tZXM6IGV4dHJhY3RTZWN0aW9uKGJvZHksIFwiUmVxdWlyZW1lbnQgT3V0Y29tZXNcIikgPz8gdW5kZWZpbmVkLFxuICAgICAgZGV2aWF0aW9uczogZXh0cmFjdFNlY3Rpb24oYm9keSwgXCJEZXZpYXRpb25zXCIpID8/IHVuZGVmaW5lZCxcbiAgICAgIGZvbGxvd1VwczogZXh0cmFjdFNlY3Rpb24oYm9keSwgXCJGb2xsb3ctdXBzXCIpID8/IHVuZGVmaW5lZCxcbiAgICAgIGtleURlY2lzaW9uczogbm9ybWFsaXplRnJvbnRtYXR0ZXJMaXN0KGZyb250bWF0dGVyLmtleV9kZWNpc2lvbnMpLFxuICAgICAga2V5RmlsZXM6IG5vcm1hbGl6ZUZyb250bWF0dGVyTGlzdChmcm9udG1hdHRlci5rZXlfZmlsZXMpLFxuICAgICAgbGVzc29uc0xlYXJuZWQ6IG5vcm1hbGl6ZUZyb250bWF0dGVyTGlzdChmcm9udG1hdHRlci5sZXNzb25zX2xlYXJuZWQpLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJkYXNoYm9hcmRcIiwgYGNvbXBsZXRpb24gcm9sbC11cCBzdW1tYXJ5IHJlYWQgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICByZXR1cm4ge307XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9yZXNvbHZlQXV0b1dvcmt0cmVlRXhpdEFjdGlvbkZvclRlc3QoXG4gIGN1cnJlbnRNaWxlc3RvbmVJZDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbiAgbWlsZXN0b25lTWVyZ2VkSW5QaGFzZXM6IGJvb2xlYW4sXG4gIG1pbGVzdG9uZUNvbXBsZXRlOiBib29sZWFuLFxuKTogQXV0b1dvcmt0cmVlRXhpdEFjdGlvbiB7XG4gIGNvbnN0IGFjdGlvbiA9IF9zZWxlY3RTdG9wQXV0b1dvcmt0cmVlRXhpdCh7XG4gICAgY3VycmVudE1pbGVzdG9uZUlkOiBjdXJyZW50TWlsZXN0b25lSWQgPz8gbnVsbCxcbiAgICBtaWxlc3RvbmVDb21wbGV0ZSxcbiAgICBtaWxlc3RvbmVNZXJnZWRJblBoYXNlcyxcbiAgfSk7XG4gIHJldHVybiBhY3Rpb24gPT09IFwibm9uZVwiID8gXCJza2lwXCIgOiBhY3Rpb247XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdG9wQXV0byhcbiAgY3R4PzogRXh0ZW5zaW9uQ29udGV4dCxcbiAgcGk/OiBFeHRlbnNpb25BUEksXG4gIHJlYXNvbj86IHN0cmluZyxcbiAgb3B0aW9uczogU3RvcEF1dG9PcHRpb25zID0ge30sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKCFzLmFjdGl2ZSAmJiAhcy5wYXVzZWQpIHJldHVybjtcbiAgY29uc3QgbG9hZGVkUHJlZmVyZW5jZXMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMocy5iYXNlUGF0aCB8fCB1bmRlZmluZWQpPy5wcmVmZXJlbmNlcztcbiAgY29uc3QgcmVhc29uU3VmZml4ID0gcmVhc29uID8gYCBcdTIwMTQgJHtyZWFzb259YCA6IFwiXCI7XG4gIGNvbnN0IHByZXNlcnZlQ29tcGxldGlvblN1cmZhY2UgPSBCb29sZWFuKG9wdGlvbnMuY29tcGxldGlvbldpZGdldCk7XG4gIHMuY29tcGxldGlvblN0b3BJblByb2dyZXNzID0gcHJlc2VydmVDb21wbGV0aW9uU3VyZmFjZTtcblxuICAvLyAjNDc2NCBcdTIwMTQgdGVsZW1ldHJ5OiByZWNvcmQgdGhlIGV4aXQgcmVhc29uLCBpc29sYXRpb24gbW9kZSwgd2hldGhlciBhbiBhdXRvXG4gIC8vIHdvcmt0cmVlIHdhcyBhY3RpdmUsIGFuZCB3aGV0aGVyIHRoZSBjdXJyZW50IG1pbGVzdG9uZSB3YXMgbWVyZ2VkIGJlZm9yZVxuICAvLyBzdG9wQXV0by4gVGhlIHVubWVyZ2VkLXdvcmsgd2FybmluZyBpcyBvbmx5IG1lYW5pbmdmdWwgZm9yIHJlYWwgd29ya3RyZWVzLlxuICB0cnkge1xuICAgIGNvbnN0IHsgZW1pdEF1dG9FeGl0IH0gPSBhd2FpdCBpbXBvcnQoXCIuL3dvcmt0cmVlLXRlbGVtZXRyeS5qc1wiKTtcbiAgICB0eXBlIEF1dG9FeGl0UmVhc29uID1cbiAgICAgIHwgXCJwYXVzZVwiIHwgXCJzdG9wXCIgfCBcImJsb2NrZWRcIiB8IFwibWVyZ2UtY29uZmxpY3RcIiB8IFwibWVyZ2UtZmFpbGVkXCJcbiAgICAgIHwgXCJzbGljZS1tZXJnZS1jb25mbGljdFwiIHwgXCJhbGwtY29tcGxldGVcIiB8IFwibm8tYWN0aXZlLW1pbGVzdG9uZVwiIHwgXCJvdGhlclwiO1xuICAgIC8vIE5vcm1hbGl6ZSB0aGUgZnJlZS1mb3JtIHJlYXNvbiB0byBhIGNsb3NlZCBzZXQgc28gdGhlIHRlbGVtZXRyeVxuICAgIC8vIGFnZ3JlZ2F0b3IgYnVja2V0cyBzdGFibHkuIFJhdyBkZXRhaWwgaXMgcHJlc2VydmVkIGluIHRoZSBwaGFzZXMudHNcbiAgICAvLyBub3RpZmljYXRpb24gYW5kIHRoZSBub3RpZnknZCBlcnJvciBzdHJpbmcuXG4gICAgY29uc3QgcmF3UmVhc29uID0gcmVhc29uID8/IFwic3RvcFwiO1xuICAgIGNvbnN0IG5vcm1hbGl6ZWRSZWFzb246IEF1dG9FeGl0UmVhc29uID0gcmF3UmVhc29uLnN0YXJ0c1dpdGgoXCJCbG9ja2VkOlwiKVxuICAgICAgPyBcImJsb2NrZWRcIlxuICAgICAgOiByYXdSZWFzb24uc3RhcnRzV2l0aChcIk1lcmdlIGNvbmZsaWN0XCIpXG4gICAgICAgID8gXCJtZXJnZS1jb25mbGljdFwiXG4gICAgICAgIDogcmF3UmVhc29uLnN0YXJ0c1dpdGgoXCJNZXJnZSBlcnJvclwiKSB8fCByYXdSZWFzb24uc3RhcnRzV2l0aChcIk1lcmdlIGZhaWxlZFwiKVxuICAgICAgICAgID8gXCJtZXJnZS1mYWlsZWRcIlxuICAgICAgICAgIDogcmF3UmVhc29uLnN0YXJ0c1dpdGgoXCJzbGljZS1tZXJnZS1jb25mbGljdFwiKVxuICAgICAgICAgICAgPyBcInNsaWNlLW1lcmdlLWNvbmZsaWN0XCJcbiAgICAgICAgICAgIDogcmF3UmVhc29uID09PSBcIkFsbCBtaWxlc3RvbmVzIGNvbXBsZXRlXCJcbiAgICAgICAgICAgICAgPyBcImFsbC1jb21wbGV0ZVwiXG4gICAgICAgICAgICAgIDogcmF3UmVhc29uID09PSBcIk5vIGFjdGl2ZSBtaWxlc3RvbmVcIlxuICAgICAgICAgICAgICAgID8gXCJuby1hY3RpdmUtbWlsZXN0b25lXCJcbiAgICAgICAgICAgICAgICA6IHJhd1JlYXNvbiA9PT0gXCJzdG9wXCIgfHwgcmF3UmVhc29uID09PSBcInBhdXNlXCJcbiAgICAgICAgICAgICAgICAgID8gcmF3UmVhc29uXG4gICAgICAgICAgICAgICAgICA6IFwib3RoZXJcIjtcbiAgICBjb25zdCB0ZWxlbWV0cnlCYXNlID0gcy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGg7XG4gICAgZW1pdEF1dG9FeGl0KHRlbGVtZXRyeUJhc2UsIHtcbiAgICAgIHJlYXNvbjogbm9ybWFsaXplZFJlYXNvbixcbiAgICAgIG1pbGVzdG9uZUlkOiBzLmN1cnJlbnRNaWxlc3RvbmVJZCA/PyB1bmRlZmluZWQsXG4gICAgICBtaWxlc3RvbmVNZXJnZWQ6IHMubWlsZXN0b25lTWVyZ2VkSW5QaGFzZXMgPT09IHRydWUsXG4gICAgICBpc29sYXRpb25Nb2RlOiBnZXRJc29sYXRpb25Nb2RlKHRlbGVtZXRyeUJhc2UpLFxuICAgICAgd29ya3RyZWVBY3RpdmU6IGlzSW5BdXRvV29ya3RyZWUocy5iYXNlUGF0aCksXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYGF1dG8tZXhpdCB0ZWxlbWV0cnkgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMTogVGltZXJzIGFuZCBsb2NrcyBcdTI1MDBcdTI1MDBcbiAgICB0cnkge1xuICAgICAgY2xlYXJVbml0VGltZW91dCgpO1xuICAgICAgc3RvcEF1dG9Db21tYW5kUG9sbGluZygpO1xuICAgICAgaWYgKGxvY2tCYXNlKCkpIGNsZWFyTG9jayhsb2NrQmFzZSgpKTtcbiAgICAgIGlmIChsb2NrQmFzZSgpKSByZWxlYXNlU2Vzc2lvbkxvY2sobG9ja0Jhc2UoKSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGVidWdMb2coXCJzdG9wLWNsZWFudXAtbG9ja3NcIiwgeyBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDFiOiBDb29yZGluYXRpb24gY2xlYW51cCAoUGhhc2UgQikgXHUyNTAwXHUyNTAwXG4gICAgLy8gUmVsZWFzZSBhbnkgYWN0aXZlIG1pbGVzdG9uZSBsZWFzZSBzbyBvdGhlciB3b3JrZXJzIGRvbid0IGhhdmUgdG9cbiAgICAvLyB3YWl0IGZvciBUVEwgZXhwaXJ5LCB0aGVuIG1hcmsgdGhpcyB3b3JrZXIgYXMgc3RvcHBpbmcuIEJlc3QtZWZmb3J0OlxuICAgIC8vIERCIHVuYXZhaWxhYmlsaXR5IG9yIHN0YWxlIHN0YXRlIG11c3Qgbm90IGJsb2NrIHNodXRkb3duLlxuICAgIHRyeSB7XG4gICAgICBpZiAocy53b3JrZXJJZCAmJiBzLmN1cnJlbnRNaWxlc3RvbmVJZCAmJiBzLm1pbGVzdG9uZUxlYXNlVG9rZW4pIHtcbiAgICAgICAgcmVsZWFzZU1pbGVzdG9uZUxlYXNlKHMud29ya2VySWQsIHMuY3VycmVudE1pbGVzdG9uZUlkLCBzLm1pbGVzdG9uZUxlYXNlVG9rZW4pO1xuICAgICAgfVxuICAgICAgaWYgKHMud29ya2VySWQpIHtcbiAgICAgICAgbWFya1dvcmtlclN0b3BwaW5nKHMud29ya2VySWQpO1xuICAgICAgfVxuICAgICAgcy53b3JrZXJJZCA9IG51bGw7XG4gICAgICBzLm1pbGVzdG9uZUxlYXNlVG9rZW4gPSBudWxsO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGRlYnVnTG9nKFwic3RvcC1jbGVhbnVwLWNvb3JkaW5hdGlvblwiLCB7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMWI6IEZsdXNoIHF1ZXVlZCBmb2xsb3ctdXAgbWVzc2FnZXMgKCMzNTEyKSBcdTI1MDBcdTI1MDBcbiAgICAvLyBMYXRlIGFzeW5jIG5vdGlmaWNhdGlvbnMgKGFzeW5jX2pvYl9yZXN1bHQsIGdzZC1hdXRvLXdyYXB1cCkgY2FuIHRyaWdnZXJcbiAgICAvLyBleHRyYSBMTE0gdHVybnMgYWZ0ZXIgc3RvcC4gRmx1c2ggdGhlbSB0aGUgc2FtZSB3YXkgcnVuLXVuaXQudHMgZG9lcy5cbiAgICB0cnkge1xuICAgICAgY29uc3QgY21kQ3R4QW55ID0gcy5jbWRDdHggYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsO1xuICAgICAgaWYgKHR5cGVvZiBjbWRDdHhBbnk/LmNsZWFyUXVldWUgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICAoY21kQ3R4QW55LmNsZWFyUXVldWUgYXMgKCkgPT4gdW5rbm93bikoKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInN0b3AtY2xlYW51cC1xdWV1ZVwiLCB7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMjogU2tpbGwgc3RhdGUgXHUyNTAwXHUyNTAwXG4gICAgdHJ5IHtcbiAgICAgIGNsZWFyU2tpbGxTbmFwc2hvdCgpO1xuICAgICAgcmVzZXRTa2lsbFRlbGVtZXRyeSgpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGRlYnVnTG9nKFwic3RvcC1jbGVhbnVwLXNraWxsc1wiLCB7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMzogU0lHVEVSTSBoYW5kbGVyIFx1MjUwMFx1MjUwMFxuICAgIHRyeSB7XG4gICAgICBkZXJlZ2lzdGVyU2lndGVybUhhbmRsZXIoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInN0b3AtY2xlYW51cC1zaWd0ZXJtXCIsIHsgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCA0OiBBdXRvLXdvcmt0cmVlIGV4aXQgXHUyNTAwXHUyNTAwXG4gICAgLy8gV2hlbiB0aGUgbWlsZXN0b25lIGlzIGNvbXBsZXRlIChoYXMgYSBTVU1NQVJZKSwgbWVyZ2UgdGhlIHdvcmt0cmVlIGJyYW5jaFxuICAgIC8vIGJhY2sgdG8gbWFpbiBzbyBjb2RlIGlzbid0IHN0cmFuZGVkIG9uIHRoZSB3b3JrdHJlZSBicmFuY2ggKCMyMzE3KS5cbiAgICAvLyBGb3IgaW5jb21wbGV0ZSBtaWxlc3RvbmVzLCBwcmVzZXJ2ZSB0aGUgYnJhbmNoIGZvciBsYXRlciByZXN1bXB0aW9uLlxuICAgIC8vXG4gICAgLy8gU2tpcCBpZiBwaGFzZXMudHMgYWxyZWFkeSBtZXJnZWQgdGhpcyBtaWxlc3RvbmUgXHUyMDE0IGF2b2lkcyB0aGUgZG91YmxlXG4gICAgLy8gbWVyZ2VBbmRFeGl0IHRoYXQgZmFpbHMgYmVjYXVzZSB0aGUgYnJhbmNoIHdhcyBhbHJlYWR5IGRlbGV0ZWQgKCMyNjQ1KS5cbiAgICB0cnkge1xuICAgICAgaWYgKHMuY3VycmVudE1pbGVzdG9uZUlkICYmICFzLm1pbGVzdG9uZU1lcmdlZEluUGhhc2VzKSB7XG4gICAgICAgIGNvbnN0IG5vdGlmeUN0eCA9IGN0eFxuICAgICAgICAgID8geyBub3RpZnk6IGN0eC51aS5ub3RpZnkuYmluZChjdHgudWkpIH1cbiAgICAgICAgICA6IHsgbm90aWZ5OiAoKSA9PiB7fSB9O1xuICAgICAgICBjb25zdCBsaWZlY3ljbGUgPSBidWlsZExpZmVjeWNsZSgpO1xuXG4gICAgICAgIC8vIENoZWNrIGlmIHRoZSBtaWxlc3RvbmUgaXMgY29tcGxldGUuIERCIHN0YXR1cyBpcyB0aGUgYXV0aG9yaXRhdGl2ZVxuICAgICAgICAvLyBzaWduYWwgXHUyMDE0IG9ubHkgYSBzdWNjZXNzZnVsIGdzZF9jb21wbGV0ZV9taWxlc3RvbmUgY2FsbCBmbGlwcyBpdCB0b1xuICAgICAgICAvLyBcImNvbXBsZXRlXCIgKHRvb2xzL2NvbXBsZXRlLW1pbGVzdG9uZS50cykuIFNVTU1BUlkgZmlsZSBwcmVzZW5jZSBpc1xuICAgICAgICAvLyBOT1Qgc3VmZmljaWVudDogYSBibG9ja2VyIHBsYWNlaG9sZGVyIHN0dWIgb3IgYSBwYXJ0aWFsIHdyaXRlIGNhblxuICAgICAgICAvLyBsZWF2ZSBhIGZpbGUgYmVoaW5kIHdpdGhvdXQgdGhlIG1pbGVzdG9uZSBhY3R1YWxseSBiZWluZyBkb25lLFxuICAgICAgICAvLyB3aGljaCBwcmV2aW91c2x5IGNhdXNlZCBzdG9wQXV0byB0byBtZXJnZSBhIGZhaWxlZCBtaWxlc3RvbmUgYW5kXG4gICAgICAgIC8vIGVtaXQgYSBtaXNsZWFkaW5nIG1ldGFkYXRhLW9ubHkgbWVyZ2Ugd2FybmluZyAoIzQxNzUpLlxuICAgICAgICAvLyBEQi11bmF2YWlsYWJsZSBwcm9qZWN0cyBmYWxsIGJhY2sgdG8gU1VNTUFSWS1maWxlIHByZXNlbmNlLlxuICAgICAgICBsZXQgbWlsZXN0b25lQ29tcGxldGUgPSBmYWxzZTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgICAgICBjb25zdCBkYlJvdyA9IGdldE1pbGVzdG9uZShzLmN1cnJlbnRNaWxlc3RvbmVJZCk7XG4gICAgICAgICAgICBtaWxlc3RvbmVDb21wbGV0ZSA9IGRiUm93Py5zdGF0dXMgPT09IFwiY29tcGxldGVcIjtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3Qgc3VtbWFyeVBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShcbiAgICAgICAgICAgICAgcy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGgsXG4gICAgICAgICAgICAgIHMuY3VycmVudE1pbGVzdG9uZUlkLFxuICAgICAgICAgICAgICBcIlNVTU1BUllcIixcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXN1bW1hcnlQYXRoKSB7XG4gICAgICAgICAgICAgIC8vIEFsc28gY2hlY2sgaW4gdGhlIHdvcmt0cmVlIHBhdGggKFNVTU1BUlkgbWF5IG5vdCBiZSBzeW5jZWQgeWV0KVxuICAgICAgICAgICAgICBjb25zdCB3dFN1bW1hcnlQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoXG4gICAgICAgICAgICAgICAgcy5iYXNlUGF0aCxcbiAgICAgICAgICAgICAgICBzLmN1cnJlbnRNaWxlc3RvbmVJZCxcbiAgICAgICAgICAgICAgICBcIlNVTU1BUllcIixcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgbWlsZXN0b25lQ29tcGxldGUgPSB3dFN1bW1hcnlQYXRoICE9PSBudWxsO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgbWlsZXN0b25lQ29tcGxldGUgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBmYWxsIHRocm91Z2ggdG8gcHJlc2VydmVCcmFuY2ggcGF0aFxuICAgICAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYG1pbGVzdG9uZSBzdW1tYXJ5IGNoZWNrIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCwgeyBmaWxlOiBcImF1dG8udHNcIiB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGV4aXRBY3Rpb24gPSBfc2VsZWN0U3RvcEF1dG9Xb3JrdHJlZUV4aXQoe1xuICAgICAgICAgIGN1cnJlbnRNaWxlc3RvbmVJZDogcy5jdXJyZW50TWlsZXN0b25lSWQsXG4gICAgICAgICAgbWlsZXN0b25lQ29tcGxldGUsXG4gICAgICAgICAgbWlsZXN0b25lTWVyZ2VkSW5QaGFzZXM6IHMubWlsZXN0b25lTWVyZ2VkSW5QaGFzZXMsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChleGl0QWN0aW9uID09PSBcIm1lcmdlXCIpIHtcbiAgICAgICAgICAvLyBNaWxlc3RvbmUgaXMgY29tcGxldGUgXHUyMDE0IG1lcmdlIHdvcmt0cmVlIGJyYW5jaCBiYWNrIHRvIG1haW5cbiAgICAgICAgICBjb25zdCByID0gbGlmZWN5Y2xlLmV4aXRNaWxlc3RvbmUoXG4gICAgICAgICAgICBzLmN1cnJlbnRNaWxlc3RvbmVJZCxcbiAgICAgICAgICAgIHsgbWVyZ2U6IHRydWUgfSxcbiAgICAgICAgICAgIG5vdGlmeUN0eCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmICghci5vayAmJiByLmNhdXNlIGluc3RhbmNlb2YgRXJyb3IpIHRocm93IHIuY2F1c2U7XG4gICAgICAgIH0gZWxzZSBpZiAoZXhpdEFjdGlvbiA9PT0gXCJwcmVzZXJ2ZVwiKSB7XG4gICAgICAgICAgLy8gTWlsZXN0b25lIHN0aWxsIGluIHByb2dyZXNzIFx1MjAxNCBwcmVzZXJ2ZSBicmFuY2ggZm9yIGxhdGVyIHJlc3VtcHRpb25cbiAgICAgICAgICBjb25zdCByID0gbGlmZWN5Y2xlLmV4aXRNaWxlc3RvbmUoXG4gICAgICAgICAgICBzLmN1cnJlbnRNaWxlc3RvbmVJZCxcbiAgICAgICAgICAgIHsgbWVyZ2U6IGZhbHNlLCBwcmVzZXJ2ZUJyYW5jaDogdHJ1ZSB9LFxuICAgICAgICAgICAgbm90aWZ5Q3R4LFxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKCFyLm9rICYmIHIuY2F1c2UgaW5zdGFuY2VvZiBFcnJvcikgdGhyb3cgci5jYXVzZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGN0eD8udWkubm90aWZ5KFxuICAgICAgICBgV29ya3RyZWUgY2xlYW51cCBmYWlsZWQgZm9yICR7cy5jdXJyZW50TWlsZXN0b25lSWQgPz8gXCJjdXJyZW50IG1pbGVzdG9uZVwifTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9LiBSZXNvbHZlIHRoZSBwcmVzZXJ2ZWQgYnJhbmNoL3dvcmt0cmVlIGFuZCBydW4gL2dzZCBhdXRvIHRvIHJlc3VtZS5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgICBkZWJ1Z0xvZyhcInN0b3AtY2xlYW51cC13b3JrdHJlZVwiLCB7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgNTogUmVidWlsZCBzdGF0ZSB3aGlsZSBEQiBpcyBzdGlsbCBvcGVuICgjMzU5OSkgXHUyNTAwXHUyNTAwXG4gICAgLy8gcmVidWlsZFN0YXRlKCkgY2FsbHMgZGVyaXZlU3RhdGUoKSB3aGljaCBuZWVkcyB0aGUgREIgZm9yIGF1dGhvcml0YXRpdmVcbiAgICAvLyBzdGF0ZS4gUHJldmlvdXNseSB0aGlzIHJhbiBhZnRlciBjbG9zZURhdGFiYXNlKCksIGZvcmNpbmcgYSBmaWxlc3lzdGVtXG4gICAgLy8gZmFsbGJhY2sgdGhhdCBjb3VsZCBkaXNhZ3JlZSB3aXRoIHRoZSBEQi1iYWNrZWQgZGlzcGF0Y2ggZGVjaXNpb25zIFx1MjAxNFxuICAgIC8vIGEgc3BsaXQtYnJhaW4gd2hlcmUgZGlzcGF0Y2ggc2F5cyBcImJsb2NrZWRcIiBidXQgU1RBVEUubWQgc2hvd3Mgd29yay5cbiAgICBpZiAocy5iYXNlUGF0aCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgcmVidWlsZFN0YXRlKHMuYmFzZVBhdGgpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBkZWJ1Z0xvZyhcInN0b3AtcmVidWlsZC1zdGF0ZS1mYWlsZWRcIiwge1xuICAgICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFByZS1jb21wdXRlIGNvbXBsZXRpb24gd2lkZ2V0IHNsaWNlIGNvdW50cyB3aGlsZSB0aGUgREIgaXMgc3RpbGwgb3Blbi5cbiAgICAvLyBTdGVwIDggcnVucyBhZnRlciBjbG9zZURhdGFiYXNlKCksIHNvIERCLWJhY2tlZCBzbGljZSBsb29rdXBzIG11c3QgaGFwcGVuIGhlcmUuXG4gICAgY29uc3QgY29tcGxldGlvbk1pbGVzdG9uZUlkID0gb3B0aW9ucy5jb21wbGV0aW9uV2lkZ2V0Py5taWxlc3RvbmVJZCA/PyBzLmN1cnJlbnRNaWxlc3RvbmVJZDtcbiAgICBsZXQgY29tcGxldGVkU2xpY2VzOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgdG90YWxTbGljZXM6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICAgIGlmIChwcmVzZXJ2ZUNvbXBsZXRpb25TdXJmYWNlICYmIG9wdGlvbnMuY29tcGxldGlvbldpZGdldCAmJiBjb21wbGV0aW9uTWlsZXN0b25lSWQgJiYgaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMoY29tcGxldGlvbk1pbGVzdG9uZUlkKTtcbiAgICAgICAgY29tcGxldGVkU2xpY2VzID0gc2xpY2VzLmZpbHRlcihzbGljZSA9PiBpc0Nsb3NlZFN0YXR1cyhzbGljZS5zdGF0dXMpKS5sZW5ndGg7XG4gICAgICAgIHRvdGFsU2xpY2VzID0gc2xpY2VzLmxlbmd0aDtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBsb2dXYXJuaW5nKFwiZGFzaGJvYXJkXCIsIGBjb21wbGV0aW9uIHNsaWNlIHN0YXRzIGxvb2t1cCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDY6IERCIGNsZWFudXAgXHUyNTAwXHUyNTAwXG4gICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyBjbG9zZURhdGFiYXNlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2dzZC1kYi5qc1wiKTtcbiAgICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBkZWJ1Z0xvZyhcImRiLWNsb3NlLWZhaWxlZFwiLCB7XG4gICAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgNzogUmVzdG9yZSBiYXNlUGF0aCBhbmQgY2hkaXIgKEFEUi0wMTYgcGhhc2UgMywgIzU2OTMpIFx1MjUwMFx1MjUwMFxuICAgIC8vIGByZXN0b3JlVG9Qcm9qZWN0Um9vdGAgb3ducyBib3RoIHMuYmFzZVBhdGggcmVzdG9yZSBhbmQgcHJvY2Vzcy5jaGRpcjtcbiAgICAvLyBubyBwYWlyZWQgY2hkaXIgaXMgbmVlZGVkIGF0IHRoZSBjYWxsIHNpdGUuXG4gICAgaWYgKHMub3JpZ2luYWxCYXNlUGF0aCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYnVpbGRMaWZlY3ljbGUoKS5yZXN0b3JlVG9Qcm9qZWN0Um9vdCgpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBkZWJ1Z0xvZyhcInN0b3AtY2xlYW51cC1iYXNlcGF0aFwiLCB7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmUtcm9vdCB0aGUgYWN0aXZlIGNvbW1hbmQgc2Vzc2lvbi90b29sIHJ1bnRpbWUgYWZ0ZXIgd29ya3RyZWUgdGVhcmRvd24uXG4gICAgLy8gbWVyZ2VBbmRFeGl0IHJlc3RvcmVzIHByb2Nlc3MuY3dkKCksIGJ1dCBBZ2VudFNlc3Npb24gaGFzIGFscmVhZHkgY2FwdHVyZWRcbiAgICAvLyBpdHMgb3duIGN3ZCBmb3IgdG9vbHMgYW5kIHN5c3RlbSBwcm9tcHQ7IHJlZnJlc2ggaXQgYmVmb3JlIHJldHVybmluZyB0byB0aGVcbiAgICAvLyB1c2VyIHNvIGZvbGxvdy11cCBjb21tYW5kcyBkbyBub3QgdGFyZ2V0IGEgcmVtb3ZlZCBtaWxlc3RvbmUgd29ya3RyZWUuXG4gICAgaWYgKHMub3JpZ2luYWxCYXNlUGF0aCAmJiBjdHggJiYgcy5jbWRDdHgpIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcm9vdENvbW1hbmRTZXNzaW9uKHMuY21kQ3R4LCBzLm9yaWdpbmFsQmFzZVBhdGgpO1xuICAgICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09IFwiY2FuY2VsbGVkXCIpIHtcbiAgICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBcInBvc3Qtc3RvcCBzZXNzaW9uIHJlLXJvb3Qgd2FzIGNhbmNlbGxlZFwiLCB7IGZpbGU6IFwiYXV0by50c1wiLCBiYXNlUGF0aDogcy5vcmlnaW5hbEJhc2VQYXRoIH0pO1xuICAgICAgfSBlbHNlIGlmIChyZXN1bHQuc3RhdHVzID09PSBcImZhaWxlZFwiKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYHBvc3Qtc3RvcCBzZXNzaW9uIHJlLXJvb3QgZmFpbGVkOiAke3Jlc3VsdC5lcnJvciA/PyBcInVua25vd25cIn1gLCB7IGZpbGU6IFwiYXV0by50c1wiLCBiYXNlUGF0aDogcy5vcmlnaW5hbEJhc2VQYXRoIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDg6IExlZGdlciBub3RpZmljYXRpb24gXHUyNTAwXHUyNTAwXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGxlZGdlciA9IGdldExlZGdlcigpO1xuICAgICAgY29uc3QgaXNBbGxDb21wbGV0ZSA9IHJlYXNvbiA9PT0gXCJBbGwgbWlsZXN0b25lcyBjb21wbGV0ZVwiO1xuICAgICAgY29uc3QgaXNNaWxlc3RvbmVDb21wbGV0ZSA9IC9eTWlsZXN0b25lXFxzK1xcUytcXHMrY29tcGxldGUkL2kudGVzdChyZWFzb24gPz8gXCJcIik7XG4gICAgICBjb25zdCBub3RpZmljYXRpb25QcmVmaXggPSBpc0FsbENvbXBsZXRlXG4gICAgICAgID8gXCJBbGwgbWlsZXN0b25lcyBjb21wbGV0ZVwiXG4gICAgICAgIDogaXNNaWxlc3RvbmVDb21wbGV0ZVxuICAgICAgICAgID8gYCR7cmVhc29ufS4gQXV0by1tb2RlIGZpbmlzaGVkIHRoaXMgbWlsZXN0b25lYFxuICAgICAgICAgIDogYEF1dG8tbW9kZSBzdG9wcGVkJHtyZWFzb25TdWZmaXh9YDtcbiAgICAgIGlmIChsZWRnZXIgJiYgbGVkZ2VyLnVuaXRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3QgdG90YWxzID0gZ2V0UHJvamVjdFRvdGFscyhsZWRnZXIudW5pdHMpO1xuICAgICAgICBjdHg/LnVpLm5vdGlmeShcbiAgICAgICAgICBgJHtub3RpZmljYXRpb25QcmVmaXh9LiBTZXNzaW9uOiAke2Zvcm1hdENvc3QodG90YWxzLmNvc3QpfSBcdTAwQjcgJHtmb3JtYXRUb2tlbkNvdW50KHRvdGFscy50b2tlbnMudG90YWwpfSB0b2tlbnMgXHUwMEI3ICR7bGVkZ2VyLnVuaXRzLmxlbmd0aH0gdW5pdHNgLFxuICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY3R4Py51aS5ub3RpZnkoYCR7bm90aWZpY2F0aW9uUHJlZml4fS5gLCBcImluZm9cIik7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGVidWdMb2coXCJzdG9wLWNsZWFudXAtbGVkZ2VyXCIsIHsgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICB9XG5cbiAgICBpZiAocHJlc2VydmVDb21wbGV0aW9uU3VyZmFjZSAmJiBjdHggJiYgb3B0aW9ucy5jb21wbGV0aW9uV2lkZ2V0KSB7XG4gICAgICBjb25zdCBsZWRnZXIgPSBnZXRMZWRnZXIoKTtcbiAgICAgIGNvbnN0IHVuaXRzID0gbGVkZ2VyPy51bml0cyA/PyBbXTtcbiAgICAgIGNvbnN0IHRvdGFscyA9IHVuaXRzLmxlbmd0aCA+IDAgPyBnZXRQcm9qZWN0VG90YWxzKHVuaXRzKSA6IG51bGw7XG4gICAgICBsZXQgdG90YWxJbnB1dCA9IDA7XG4gICAgICBsZXQgdG90YWxDYWNoZVJlYWQgPSAwO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBzLmNtZEN0eD8uc2Vzc2lvbk1hbmFnZXI/LmdldEVudHJpZXM/LigpID8/IFtdKSB7XG4gICAgICAgICAgaWYgKGVudHJ5LnR5cGUgPT09IFwibWVzc2FnZVwiKSB7XG4gICAgICAgICAgICBjb25zdCBtc2dFbnRyeSA9IGVudHJ5IGFzIFNlc3Npb25NZXNzYWdlRW50cnk7XG4gICAgICAgICAgICBpZiAobXNnRW50cnkubWVzc2FnZT8ucm9sZSA9PT0gXCJhc3Npc3RhbnRcIikge1xuICAgICAgICAgICAgICBjb25zdCB1c2FnZSA9IChtc2dFbnRyeS5tZXNzYWdlIGFzIGFueSkudXNhZ2U7XG4gICAgICAgICAgICAgIGlmICh1c2FnZSkge1xuICAgICAgICAgICAgICAgIHRvdGFsSW5wdXQgKz0gdXNhZ2UuaW5wdXQgfHwgMDtcbiAgICAgICAgICAgICAgICB0b3RhbENhY2hlUmVhZCArPSB1c2FnZS5jYWNoZVJlYWQgfHwgMDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJkYXNoYm9hcmRcIiwgYGNvbXBsZXRpb24gc3RhdHMgbG9va3VwIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICB9XG4gICAgICBjb25zdCBjb250ZXh0VXNhZ2UgPSBzLmNtZEN0eD8uZ2V0Q29udGV4dFVzYWdlPy4oKTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZUlkID0gY29tcGxldGlvbk1pbGVzdG9uZUlkO1xuICAgICAgY29uc3Qgcm9sbHVwID0gbG9hZE1pbGVzdG9uZUNvbXBsZXRpb25Sb2xsdXAocy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgICAgIHNldENvbXBsZXRpb25Qcm9ncmVzc1dpZGdldChjdHgsIHtcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIG1pbGVzdG9uZVRpdGxlOiBvcHRpb25zLmNvbXBsZXRpb25XaWRnZXQubWlsZXN0b25lVGl0bGUgPz8gcm9sbHVwLm1pbGVzdG9uZVRpdGxlLFxuICAgICAgICBvbmVMaW5lcjogcm9sbHVwLm9uZUxpbmVyLFxuICAgICAgICBzdWNjZXNzQ3JpdGVyaWFSZXN1bHRzOiByb2xsdXAuc3VjY2Vzc0NyaXRlcmlhUmVzdWx0cyxcbiAgICAgICAgZGVmaW5pdGlvbk9mRG9uZVJlc3VsdHM6IHJvbGx1cC5kZWZpbml0aW9uT2ZEb25lUmVzdWx0cyxcbiAgICAgICAgcmVxdWlyZW1lbnRPdXRjb21lczogcm9sbHVwLnJlcXVpcmVtZW50T3V0Y29tZXMsXG4gICAgICAgIGRldmlhdGlvbnM6IHJvbGx1cC5kZXZpYXRpb25zLFxuICAgICAgICBmb2xsb3dVcHM6IHJvbGx1cC5mb2xsb3dVcHMsXG4gICAgICAgIGtleURlY2lzaW9uczogcm9sbHVwLmtleURlY2lzaW9ucyxcbiAgICAgICAga2V5RmlsZXM6IHJvbGx1cC5rZXlGaWxlcyxcbiAgICAgICAgbGVzc29uc0xlYXJuZWQ6IHJvbGx1cC5sZXNzb25zTGVhcm5lZCxcbiAgICAgICAgcmVhc29uOiByZWFzb24gPz8gXCJNaWxlc3RvbmUgY29tcGxldGVcIixcbiAgICAgICAgc3RhcnRlZEF0OiBzLmF1dG9TdGFydFRpbWUsXG4gICAgICAgIHRvdGFsQ29zdDogdG90YWxzPy5jb3N0ID8/IDAsXG4gICAgICAgIHRvdGFsVG9rZW5zOiB0b3RhbHM/LnRva2Vucy50b3RhbCA/PyAwLFxuICAgICAgICB1bml0Q291bnQ6IHVuaXRzLmxlbmd0aCxcbiAgICAgICAgY2FjaGVIaXRSYXRlOiB0b3RhbENhY2hlUmVhZCArIHRvdGFsSW5wdXQgPiAwXG4gICAgICAgICAgPyAodG90YWxDYWNoZVJlYWQgLyAodG90YWxDYWNoZVJlYWQgKyB0b3RhbElucHV0KSkgKiAxMDBcbiAgICAgICAgICA6IG51bGwsXG4gICAgICAgIGNvbnRleHRQZXJjZW50OiBjb250ZXh0VXNhZ2U/LnBlcmNlbnQgPz8gbnVsbCxcbiAgICAgICAgY29udGV4dFdpbmRvdzogY29udGV4dFVzYWdlPy5jb250ZXh0V2luZG93ID8/IHMuY21kQ3R4Py5tb2RlbD8uY29udGV4dFdpbmRvdyA/PyBudWxsLFxuICAgICAgICBjb21wbGV0ZWRTbGljZXMsXG4gICAgICAgIHRvdGFsU2xpY2VzLFxuICAgICAgICBhbGxNaWxlc3RvbmVzQ29tcGxldGU6IG9wdGlvbnMuY29tcGxldGlvbldpZGdldC5hbGxNaWxlc3RvbmVzQ29tcGxldGUsXG4gICAgICAgIGJhc2VQYXRoOiBzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCB8fCBudWxsLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgOTogQ211eCBzaWRlYmFyIC8gZXZlbnQgbG9nIFx1MjUwMFx1MjUwMFxuICAgIHRyeSB7XG4gICAgICBwaT8uZXZlbnRzLmVtaXQoQ01VWF9DSEFOTkVMUy5TSURFQkFSLCB7IGFjdGlvbjogXCJjbGVhclwiIGFzIGNvbnN0LCBwcmVmZXJlbmNlczogbG9hZGVkUHJlZmVyZW5jZXMgfSk7XG4gICAgICBwaT8uZXZlbnRzLmVtaXQoQ01VWF9DSEFOTkVMUy5MT0csIHtcbiAgICAgICAgcHJlZmVyZW5jZXM6IGxvYWRlZFByZWZlcmVuY2VzLFxuICAgICAgICBtZXNzYWdlOiBgQXV0by1tb2RlIHN0b3BwZWQke3JlYXNvblN1ZmZpeCB8fCBcIlwifS5gLFxuICAgICAgICBsZXZlbDogcmVhc29uPy5zdGFydHNXaXRoKFwiQmxvY2tlZDpcIikgPyBcIndhcm5pbmdcIiA6IFwiaW5mb1wiLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGVidWdMb2coXCJzdG9wLWNsZWFudXAtY211eFwiLCB7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMTA6IERlYnVnIHN1bW1hcnkgXHUyNTAwXHUyNTAwXG4gICAgdHJ5IHtcbiAgICAgIGlmIChpc0RlYnVnRW5hYmxlZCgpKSB7XG4gICAgICAgIGNvbnN0IGxvZ1BhdGggPSB3cml0ZURlYnVnU3VtbWFyeSgpO1xuICAgICAgICBpZiAobG9nUGF0aCkge1xuICAgICAgICAgIGN0eD8udWkubm90aWZ5KGBEZWJ1ZyBsb2cgd3JpdHRlbiBcdTIxOTIgJHtsb2dQYXRofWAsIFwiaW5mb1wiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGRlYnVnTG9nKFwic3RvcC1jbGVhbnVwLWRlYnVnXCIsIHsgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAxMTogUmVzZXQgbWV0cmljcywgcm91dGluZywgaG9va3MgXHUyNTAwXHUyNTAwXG4gICAgdHJ5IHtcbiAgICAgIHJlc2V0TWV0cmljcygpO1xuICAgICAgcmVzZXRSb3V0aW5nSGlzdG9yeSgpO1xuICAgICAgcmVzZXRIb29rU3RhdGUoKTtcbiAgICAgIGlmIChzLmJhc2VQYXRoKSBjbGVhclBlcnNpc3RlZEhvb2tTdGF0ZShzLmJhc2VQYXRoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInN0b3AtY2xlYW51cC1tZXRyaWNzXCIsIHsgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAxMjogUmVtb3ZlIHBhdXNlZC1zZXNzaW9uIG1ldGFkYXRhICgjMTM4MykgXHUyNTAwXHUyNTAwXG4gICAgLy8gUGhhc2UgQyBwdCAyOiBkZWxldGVSdW50aW1lS3YgcmVwbGFjZXMgdW5saW5rU3luYyhwYXVzZWQtc2Vzc2lvbi5qc29uKS5cbiAgICB0cnkge1xuICAgICAgZGVsZXRlUnVudGltZUt2KFwiZ2xvYmFsXCIsIFwiXCIsIFBBVVNFRF9TRVNTSU9OX0tWX0tFWSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7IC8qIG5vbi1mYXRhbCAqL1xuICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgcGF1c2VkLXNlc3Npb24gREIgZGVsZXRlIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCwgeyBmaWxlOiBcImF1dG8udHNcIiB9KTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAxMzogUmVzdG9yZSBvcmlnaW5hbCBtb2RlbCArIHRoaW5raW5nIChiZWZvcmUgcmVzZXQgY2xlYXJzIElEcykgXHUyNTAwXHUyNTAwXG4gICAgdHJ5IHtcbiAgICAgIGlmIChwaSAmJiBjdHggJiYgcy5vcmlnaW5hbE1vZGVsSWQgJiYgcy5vcmlnaW5hbE1vZGVsUHJvdmlkZXIpIHtcbiAgICAgICAgY29uc3Qgb3JpZ2luYWwgPSBjdHgubW9kZWxSZWdpc3RyeS5maW5kKFxuICAgICAgICAgIHMub3JpZ2luYWxNb2RlbFByb3ZpZGVyLFxuICAgICAgICAgIHMub3JpZ2luYWxNb2RlbElkLFxuICAgICAgICApO1xuICAgICAgICBpZiAob3JpZ2luYWwpIGF3YWl0IHBpLnNldE1vZGVsKG9yaWdpbmFsKTtcbiAgICAgIH1cbiAgICAgIGlmIChwaSAmJiBzLm9yaWdpbmFsVGhpbmtpbmdMZXZlbCkge1xuICAgICAgICBwaS5zZXRUaGlua2luZ0xldmVsKHMub3JpZ2luYWxUaGlua2luZ0xldmVsKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInN0b3AtY2xlYW51cC1tb2RlbFwiLCB7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuXG4gICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMTQ6IFVuYmxvY2sgcGVuZGluZyB1bml0UHJvbWlzZSAoIzE3OTkpIFx1MjUwMFx1MjUwMFxuICAgIC8vIHJlc29sdmVBZ2VudEVuZCB1bmJsb2NrcyBhdXRvTG9vcCdzIGBhd2FpdCB1bml0UHJvbWlzZWAgc28gaXQgY2FuIHNlZVxuICAgIC8vIHMuYWN0aXZlID09PSBmYWxzZSBhbmQgZXhpdCBjbGVhbmx5LiBXaXRob3V0IHRoaXMsIGF1dG9Mb29wIGhhbmdzXG4gICAgLy8gZm9yZXZlciBhbmQgdGhlIGludGVyYWN0aXZlIGxvb3AgaXMgYmxvY2tlZC5cbiAgICB0cnkge1xuICAgICAgcmVzb2x2ZUFnZW50RW5kKHsgbWVzc2FnZXM6IFtdIH0pO1xuICAgICAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInN0b3AtY2xlYW51cC1wZW5kaW5nLXJlc29sdmVcIiwgeyBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICAvLyBcdTI1MDBcdTI1MDAgQ3JpdGljYWwgaW52YXJpYW50czogdGhlc2UgTVVTVCBleGVjdXRlIHJlZ2FyZGxlc3Mgb2YgZXJyb3JzIFx1MjUwMFx1MjUwMFxuICAgIC8vIEJyb3dzZXIgdGVhcmRvd24gXHUyMDE0IHByZXZlbnQgb3JwaGFuZWQgQ2hyb21lIHByb2Nlc3NlcyBhY3Jvc3MgcmV0cmllcyAoIzE3MzMpXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgZ2V0QnJvd3NlciB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYnJvd3Nlci10b29scy9zdGF0ZS5qc1wiKTtcbiAgICAgIGlmIChnZXRCcm93c2VyKCkpIHtcbiAgICAgICAgY29uc3QgeyBjbG9zZUJyb3dzZXIgfSA9IGF3YWl0IGltcG9ydChcIi4uL2Jyb3dzZXItdG9vbHMvbGlmZWN5Y2xlLmpzXCIpO1xuICAgICAgICBhd2FpdCBjbG9zZUJyb3dzZXIoKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHsgLyogbm9uLWZhdGFsOiBicm93c2VyLXRvb2xzIG1heSBub3QgYmUgbG9hZGVkICovXG4gICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBicm93c2VyIHRlYXJkb3duIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCwgeyBmaWxlOiBcImF1dG8udHNcIiB9KTtcbiAgICB9XG5cbiAgICAvLyBFeHRlcm5hbCBjbGVhbnVwIChub3QgY292ZXJlZCBieSBzZXNzaW9uIHJlc2V0KVxuICAgIGNsZWFySW5GbGlnaHRUb29scygpO1xuICAgIGNsZWFyU2xpY2VQcm9ncmVzc0NhY2hlKCk7XG4gICAgY2xlYXJBY3Rpdml0eUxvZ1N0YXRlKCk7XG4gICAgc2V0TGV2ZWxDaGFuZ2VDYWxsYmFjayhudWxsKTtcbiAgICByZXNldFByb2FjdGl2ZUhlYWxpbmcoKTtcblxuICAgIC8vIFVJIGNsZWFudXBcbiAgICBjdHg/LnVpLnNldFN0YXR1cyhcImdzZC1hdXRvXCIsIHVuZGVmaW5lZCk7XG4gICAgaWYgKCFwcmVzZXJ2ZUNvbXBsZXRpb25TdXJmYWNlKSB7XG4gICAgICBjdHg/LnVpLnNldFdpZGdldChcImdzZC1wcm9ncmVzc1wiLCB1bmRlZmluZWQpO1xuICAgICAgY29uc3Qgc3RhdHVzID0gcmVhc29uPy5zdGFydHNXaXRoKFwiQmxvY2tlZDpcIikgPyBcImJsb2NrZWRcIiA6IHJlYXNvbj8udG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImZhaWxcIikgPyBcImZhaWxlZFwiIDogXCJzdG9wcGVkXCI7XG4gICAgICBzZXRMaWZlY3ljbGVPdXRjb21lKGN0eCwge1xuICAgICAgICBzdGF0dXMsXG4gICAgICAgIHRpdGxlOiBzdGF0dXMgPT09IFwiYmxvY2tlZFwiID8gXCJBdXRvLW1vZGUgYmxvY2tlZFwiIDogc3RhdHVzID09PSBcImZhaWxlZFwiID8gXCJBdXRvLW1vZGUgc3RvcHBlZCB3aXRoIGFuIGlzc3VlXCIgOiBcIkF1dG8tbW9kZSBzdG9wcGVkXCIsXG4gICAgICAgIGRldGFpbDogcmVhc29uID8/IFwiQXV0by1tb2RlIHN0b3BwZWQuXCIsXG4gICAgICAgIG5leHRBY3Rpb246IHN0YXR1cyA9PT0gXCJibG9ja2VkXCJcbiAgICAgICAgICA/IFwiRml4IHRoZSBibG9ja2VyLCB0aGVuIHJ1biAvZ3NkIGF1dG8gdG8gcmVzdW1lLlwiXG4gICAgICAgICAgOiBcIlJ1biAvZ3NkIHN0YXR1cyBmb3IgdGhlIGN1cnJlbnQgcHJvamVjdCBzdGF0ZSwgb3IgL2dzZCBhdXRvIHRvIGNvbnRpbnVlLlwiLFxuICAgICAgICBjb21tYW5kczogW1wiL2dzZCBzdGF0dXMgZm9yIG92ZXJ2aWV3XCIsIFwiL2dzZCBhdXRvIHRvIHJ1blwiLCBcIi9nc2QgdmlzdWFsaXplIHRvIGluc3BlY3RcIiwgXCIvZ3NkIG5vdGlmaWNhdGlvbnMgZm9yIGhpc3RvcnlcIl0sXG4gICAgICB9KTtcbiAgICAgIGlmIChjdHgpIGluaXRIZWFsdGhXaWRnZXQoY3R4KTtcbiAgICB9XG4gICAgcmVzdG9yZVByb2plY3RSb290RW52KCk7XG4gICAgcmVzdG9yZU1pbGVzdG9uZUxvY2tFbnYoKTtcblxuICAgIC8vIERyb3AgdGhlIGFjdGl2ZS10b29sIGJhc2VsaW5lIHNvIGEgc3Vic2VxdWVudCAvZ3NkIGF1dG8gcnVuIG9uIHRoZVxuICAgIC8vIHNhbWUgYHBpYCBpbnN0YW5jZSByZWNhcHR1cmVzIGZyb20gdGhlIGxpdmUgdG9vbCBzZXQgcmF0aGVyIHRoYW5cbiAgICAvLyByZXN0b3JpbmcgdGhpcyBzZXNzaW9uJ3Mgc25hcHNob3QgYW5kIHNpbGVudGx5IHVuZG9pbmcgYW55IHRvb2xcbiAgICAvLyBjaGFuZ2VzIHRoZSB1c2VyIG1hZGUgYmV0d2VlbiBzZXNzaW9ucyAoIzQ5NTkgLyBDb2RlUmFiYml0KS5cbiAgICBpZiAocGkpIGNsZWFyVG9vbEJhc2VsaW5lKHBpKTtcblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBzLm9yY2hlc3RyYXRpb24/LnN0b3AocmVhc29uID8/IFwic3RvcFwiKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGRlYnVnTG9nKFwic3RvcC1vcmNoZXN0cmF0aW9uLXN0b3BcIiwgeyBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpIH0pO1xuICAgIH1cblxuICAgIC8vIFJlc2V0IGFsbCBzZXNzaW9uIHN0YXRlIGluIG9uZSBjYWxsXG4gICAgcy5yZXNldEFmdGVyU3RvcCh7IHByZXNlcnZlQ29tcGxldGlvblN1cmZhY2UgfSk7XG4gIH1cbn1cblxuZXhwb3J0IHR5cGUgU3RvcEF1dG9Xb3JrdHJlZUV4aXRBY3Rpb24gPSBcIm5vbmVcIiB8IFwibWVyZ2VcIiB8IFwicHJlc2VydmVcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIF9zZWxlY3RTdG9wQXV0b1dvcmt0cmVlRXhpdChhcmdzOiB7XG4gIGN1cnJlbnRNaWxlc3RvbmVJZDogc3RyaW5nIHwgbnVsbDtcbiAgbWlsZXN0b25lQ29tcGxldGU6IGJvb2xlYW47XG4gIG1pbGVzdG9uZU1lcmdlZEluUGhhc2VzOiBib29sZWFuO1xufSk6IFN0b3BBdXRvV29ya3RyZWVFeGl0QWN0aW9uIHtcbiAgaWYgKCFhcmdzLmN1cnJlbnRNaWxlc3RvbmVJZCB8fCBhcmdzLm1pbGVzdG9uZU1lcmdlZEluUGhhc2VzKSByZXR1cm4gXCJub25lXCI7XG4gIHJldHVybiBhcmdzLm1pbGVzdG9uZUNvbXBsZXRlID8gXCJtZXJnZVwiIDogXCJwcmVzZXJ2ZVwiO1xufVxuXG4vKipcbiAqIFBhdXNlIGF1dG8tbW9kZSB3aXRob3V0IGRlc3Ryb3lpbmcgc3RhdGUuIENvbnRleHQgaXMgcHJlc2VydmVkLlxuICogVGhlIHVzZXIgY2FuIGludGVyYWN0IHdpdGggdGhlIGFnZW50LCB0aGVuIGAvZ3NkIGF1dG9gIHJlc3VtZXNcbiAqIGZyb20gZGlzayBzdGF0ZS4gQ2FsbGVkIHdoZW4gdGhlIHVzZXIgcHJlc3NlcyBFc2NhcGUgZHVyaW5nIGF1dG8tbW9kZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBhdXNlQXV0byhcbiAgY3R4PzogRXh0ZW5zaW9uQ29udGV4dCxcbiAgX3BpPzogRXh0ZW5zaW9uQVBJLFxuICBfZXJyb3JDb250ZXh0PzogRXJyb3JDb250ZXh0LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghcy5hY3RpdmUpIHJldHVybjtcbiAgY2xlYXJVbml0VGltZW91dCgpO1xuICBzdG9wQXV0b0NvbW1hbmRQb2xsaW5nKCk7XG5cbiAgLy8gRmx1c2ggcXVldWVkIGZvbGxvdy11cCBtZXNzYWdlcyAoIzM1MTIpLlxuICAvLyBMYXRlIGFzeW5jIG5vdGlmaWNhdGlvbnMgKGFzeW5jX2pvYl9yZXN1bHQsIGdzZC1hdXRvLXdyYXB1cCkgY2FuIHRyaWdnZXJcbiAgLy8gZXh0cmEgTExNIHR1cm5zIGFmdGVyIHBhdXNlLiBGbHVzaCB0aGVtIHRoZSBzYW1lIHdheSBydW4tdW5pdC50cyBkb2VzLlxuICB0cnkge1xuICAgIGNvbnN0IGNtZEN0eEFueSA9IHMuY21kQ3R4IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbDtcbiAgICBpZiAodHlwZW9mIGNtZEN0eEFueT8uY2xlYXJRdWV1ZSA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAoY21kQ3R4QW55LmNsZWFyUXVldWUgYXMgKCkgPT4gdW5rbm93bikoKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBkZWJ1Z0xvZyhcInBhdXNlLWNsZWFudXAtcXVldWVcIiwgeyBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpIH0pO1xuICB9XG5cbiAgLy8gVW5ibG9jayBhbnkgcGVuZGluZyB1bml0IHByb21pc2Ugc28gdGhlIGF1dG8tbG9vcCBpcyBub3Qgb3JwaGFuZWQuXG4gIC8vIFBhc3MgZXJyb3JDb250ZXh0IHNvIHJ1blVuaXRQaGFzZSBjYW4gZGlzdGluZ3Vpc2ggdXNlci1pbml0aWF0ZWQgcGF1c2VcbiAgLy8gZnJvbSBwcm92aWRlci1lcnJvciBwYXVzZSBhbmQgYXZvaWQgaGFyZC1zdG9wcGluZyAoIzI3NjIpLlxuICByZXNvbHZlQWdlbnRFbmRDYW5jZWxsZWQoX2Vycm9yQ29udGV4dCk7XG5cbiAgcy5wYXVzZWRTZXNzaW9uRmlsZSA9IG5vcm1hbGl6ZVNlc3Npb25GaWxlUGF0aChjdHg/LnNlc3Npb25NYW5hZ2VyPy5nZXRTZXNzaW9uRmlsZSgpID8/IG51bGwpO1xuXG4gIC8vIFBlcnNpc3QgcGF1c2VkLXNlc3Npb24gbWV0YWRhdGEgc28gcmVzdW1lIHN1cnZpdmVzIC9leGl0ICgjMTM4MykuXG4gIC8vIFBoYXNlIEMgcHQgMjogcGVyc2lzdGVkIHRvIHJ1bnRpbWVfa3YgKGdsb2JhbCBzY29wZSwga2V5XG4gIC8vIFBBVVNFRF9TRVNTSU9OX0tWX0tFWSkgaW5zdGVhZCBvZiBydW50aW1lL3BhdXNlZC1zZXNzaW9uLmpzb24uIFRoZVxuICAvLyBmcmVzaC1zdGFydCBib290c3RyYXAgYmVsb3cgcmVhZHMgZnJvbSB0aGUgc2FtZSBrZXkuXG4gIHRyeSB7XG4gICAgY29uc3QgcGF1c2VkTWV0YTogUGF1c2VkU2Vzc2lvbk1ldGFkYXRhID0ge1xuICAgICAgbWlsZXN0b25lSWQ6IHMuY3VycmVudE1pbGVzdG9uZUlkID8/IHVuZGVmaW5lZCxcbiAgICAgIHdvcmt0cmVlUGF0aDogaXNJbkF1dG9Xb3JrdHJlZShzLmJhc2VQYXRoKSA/IHMuYmFzZVBhdGggOiBudWxsLFxuICAgICAgb3JpZ2luYWxCYXNlUGF0aDogcy5vcmlnaW5hbEJhc2VQYXRoLFxuICAgICAgc3RlcE1vZGU6IHMuc3RlcE1vZGUsXG4gICAgICBwYXVzZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgc2Vzc2lvbkZpbGU6IHMucGF1c2VkU2Vzc2lvbkZpbGUsXG4gICAgICB1bml0VHlwZTogcy5jdXJyZW50VW5pdD8udHlwZSA/PyB1bmRlZmluZWQsXG4gICAgICB1bml0SWQ6IHMuY3VycmVudFVuaXQ/LmlkID8/IHVuZGVmaW5lZCxcbiAgICAgIGFjdGl2ZUVuZ2luZUlkOiBzLmFjdGl2ZUVuZ2luZUlkID8/IHVuZGVmaW5lZCxcbiAgICAgIGFjdGl2ZVJ1bkRpcjogcy5hY3RpdmVSdW5EaXIsXG4gICAgICBhdXRvU3RhcnRUaW1lOiBzLmF1dG9TdGFydFRpbWUsXG4gICAgICBtaWxlc3RvbmVMb2NrOiBzLnNlc3Npb25NaWxlc3RvbmVMb2NrID8/IHVuZGVmaW5lZCxcbiAgICAgIHBhdXNlUmVhc29uOiBfZXJyb3JDb250ZXh0Py5tZXNzYWdlLFxuICAgIH07XG4gICAgc2V0UnVudGltZUt2KFwiZ2xvYmFsXCIsIFwiXCIsIFBBVVNFRF9TRVNTSU9OX0tWX0tFWSwgcGF1c2VkTWV0YSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgcmVzdW1lIHdpbGwgc3RpbGwgd29yayB2aWEgZnVsbCBib290c3RyYXAsIGp1c3Qgd2l0aG91dCB3b3JrdHJlZSBjb250ZXh0XG4gICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgcGF1c2VkLXNlc3Npb24gREIgd3JpdGUgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLCB7IGZpbGU6IFwiYXV0by50c1wiIH0pO1xuICB9XG5cbiAgY29uc3QgcGF1c2VkVW5pdExhYmVsID0gY3VycmVudFVuaXRMYWJlbCgpO1xuXG4gIC8vIENsb3NlIG91dCB0aGUgY3VycmVudCB1bml0IHNvIGl0cyBydW50aW1lIHJlY29yZCBkb2Vzbid0IHN0YXkgYXQgXCJkaXNwYXRjaGVkXCJcbiAgaWYgKHMuY3VycmVudFVuaXQgJiYgY3R4KSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGNsb3Nlb3V0VW5pdChjdHgsIHMuYmFzZVBhdGgsIHMuY3VycmVudFVuaXQudHlwZSwgcy5jdXJyZW50VW5pdC5pZCwgcy5jdXJyZW50VW5pdC5zdGFydGVkQXQpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBiZXN0LWVmZm9ydCBjbG9zZW91dCBvbiBwYXVzZVxuICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgdW5pdCBjbG9zZW91dCBvbiBwYXVzZSBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsIHsgZmlsZTogXCJhdXRvLnRzXCIgfSk7XG4gICAgfVxuICAgIHMuY3VycmVudFVuaXQgPSBudWxsO1xuICB9XG5cbiAgLy8gS2VlcCBTVEFURS5tZCBhbGlnbmVkIHdpdGggdGhlIERCLWJhY2tlZCBzdGF0ZSBiZWZvcmUgcmVsZWFzaW5nIHBhdXNlIHN0YXRlLlxuICAvLyBXaXRob3V0IHRoaXMsIGFuIGludGVycnVwdGVkIGRlZXAgcnVuIGNhbiBsZWF2ZSBTVEFURS5tZCBzYXlpbmcgXCJubyBhY3RpdmVcbiAgLy8gbWlsZXN0b25lXCIgZXZlbiBhZnRlciB0aGUgREIvZGlzayByZWNvbmNpbGlhdGlvbiBoYXMgcmVjb3ZlcmVkIHRoZSBuZXh0IHVuaXQuXG4gIGlmIChzLmJhc2VQYXRoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHJlYnVpbGRTdGF0ZShzLmJhc2VQYXRoKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInBhdXNlLXJlYnVpbGQtc3RhdGUtZmFpbGVkXCIsIHtcbiAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIGlmIChsb2NrQmFzZSgpKSB7XG4gICAgcmVsZWFzZVNlc3Npb25Mb2NrKGxvY2tCYXNlKCkpO1xuICAgIGNsZWFyTG9jayhsb2NrQmFzZSgpKTtcbiAgfVxuXG4gIGRlcmVnaXN0ZXJTaWd0ZXJtSGFuZGxlcigpO1xuXG4gIC8vIFVuYmxvY2sgcGVuZGluZyB1bml0UHJvbWlzZSBzbyBhdXRvTG9vcCBleGl0cyBjbGVhbmx5ICgjMTc5OSlcbiAgcmVzb2x2ZUFnZW50RW5kKHsgbWVzc2FnZXM6IFtdIH0pO1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgcy5vcmNoZXN0cmF0aW9uPy5zdG9wKFwicGF1c2VcIik7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGRlYnVnTG9nKFwicGF1c2Utb3JjaGVzdHJhdGlvbi1zdG9wXCIsIHsgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9KTtcbiAgfVxuXG4gIHMuYWN0aXZlID0gZmFsc2U7XG4gIHMucGF1c2VkID0gdHJ1ZTtcbiAgZGVhY3RpdmF0ZUdTRCgpO1xuICByZXN0b3JlUHJvamVjdFJvb3RFbnYoKTtcbiAgcmVzdG9yZU1pbGVzdG9uZUxvY2tFbnYoKTtcbiAgcy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnkgPSBudWxsO1xuICBzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuY2xlYXIoKTtcbiAgY3R4Py51aS5zZXRTdGF0dXMoXCJnc2QtYXV0b1wiLCBcInBhdXNlZFwiKTtcbiAgY3R4Py51aS5zZXRXaWRnZXQoXCJnc2QtcHJvZ3Jlc3NcIiwgdW5kZWZpbmVkKTtcbiAgY29uc3QgcmVzdW1lQ21kID0gcy5zdGVwTW9kZSA/IFwiL2dzZCBuZXh0XCIgOiBcIi9nc2QgYXV0b1wiO1xuICBzZXRMaWZlY3ljbGVPdXRjb21lKGN0eCwge1xuICAgIHN0YXR1czogXCJwYXVzZWRcIixcbiAgICB0aXRsZTogYCR7cy5zdGVwTW9kZSA/IFwiU3RlcFwiIDogXCJBdXRvXCJ9LW1vZGUgcGF1c2VkYCxcbiAgICBkZXRhaWw6IF9lcnJvckNvbnRleHQ/Lm1lc3NhZ2UgPz8gXCJQYXVzZWQgYnkgdXNlciByZXF1ZXN0LlwiLFxuICAgIG5leHRBY3Rpb246IGBUeXBlIHRvIHN0ZWVyLCBvciBydW4gJHtyZXN1bWVDbWR9IHRvIHJlc3VtZS5gLFxuICAgIGNvbW1hbmRzOiBbcmVzdW1lQ21kLCBcIi9nc2Qgc3RhdHVzIGZvciBvdmVydmlld1wiLCBcIi9nc2Qgbm90aWZpY2F0aW9ucyBmb3IgaGlzdG9yeVwiXSxcbiAgICB1bml0TGFiZWw6IHBhdXNlZFVuaXRMYWJlbCxcbiAgfSk7XG4gIGlmIChjdHgpIGluaXRIZWFsdGhXaWRnZXQoY3R4KTtcbiAgY3R4Py51aS5ub3RpZnkoXG4gICAgYCR7cy5zdGVwTW9kZSA/IFwiU3RlcFwiIDogXCJBdXRvXCJ9LW1vZGUgcGF1c2VkIChFc2NhcGUpLiBUeXBlIHRvIGludGVyYWN0LCBvciAke3Jlc3VtZUNtZH0gdG8gcmVzdW1lLmAsXG4gICAgXCJpbmZvXCIsXG4gICk7XG59XG5cbi8qKlxuICogQnVpbGQgYSBXb3JrdHJlZUxpZmVjeWNsZSBNb2R1bGUgd3JhcHBpbmcgdGhlIGN1cnJlbnQgc2Vzc2lvbi5cbiAqXG4gKiBQZXIgQURSLTAxNiwgdGhlIExpZmVjeWNsZSBNb2R1bGUgaXMgdGhlIHR5cGVkLUludGVyZmFjZSBvd25lciBvZiBtaWxlc3RvbmVcbiAqIGVudHJ5L2V4aXQvbWVyZ2UgdmVyYnMgYW5kIGNhbGxzIFByb2plY3Rpb24gb24gbGlmZWN5Y2xlIHRyYW5zaXRpb25zLiBUaGVcbiAqIGRlcHMgYmFnIGlzIGludGVudGlvbmFsbHkgZm9jdXNlZCBcdTIwMTQgTGlmZWN5Y2xlIGRvZXMgbm90IHNlZSB0aGUgd2lkZXIgYXV0by1cbiAqIG1vZGUgZGVwZW5kZW5jeSBncmFwaC5cbiAqL1xuLyoqXG4gKiBDb25zdHJ1Y3QgYSBgV29ya3RyZWVMaWZlY3ljbGVEZXBzYCBiYWcgd2l0aG91dCBiaW5kaW5nIHRvIGFueSBzZXNzaW9uLlxuICpcbiAqIEV4cG9ydGVkIHNvIHNlc3Npb24tbGVzcyBjYWxsZXJzIChjdXJyZW50bHkgYHBhcmFsbGVsLW1lcmdlLnRzYCkgY2FuIGJ1aWxkXG4gKiB0aGUgc2FtZSBkZXBzIGFuZCBjYWxsIGBtZXJnZU1pbGVzdG9uZVN0YW5kYWxvbmVgIHRocm91Z2ggdGhlIFdvcmt0cmVlXG4gKiBMaWZlY3ljbGUgTW9kdWxlIGluc3RlYWQgb2YgYnlwYXNzaW5nIGl0IChBRFItMDE2IHBoYXNlIDIgLyBBMikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFdvcmt0cmVlTGlmZWN5Y2xlRGVwcygpOiBXb3JrdHJlZUxpZmVjeWNsZURlcHMge1xuICAvLyBBRFItMDE2IHBoYXNlIDIgLyBDLXRyYWNrIGNsb3NlLW91dDpcbiAgLy8gICBDMSAoIzU2MjQpIFx1MjAxNCBmcyArIGdpdC1DTEkgcHJpbWl0aXZlcyBpbmxpbmVkXG4gIC8vICAgQzIgKCM1NjI1KSBcdTIwMTQgd29ya3RyZWUtbWFuYWdlciBoZWxwZXJzIGlubGluZWRcbiAgLy8gICBDMyAoIzU2MjYpIFx1MjAxNCBjYWNoZSArIHByZWZlcmVuY2VzICsgcGF0aHMgaW5saW5lZFxuICAvLyAgIEM0ICgjNTYyNykgXHUyMDE0IEdpdFNlcnZpY2VJbXBsIGNvbnN0cnVjdG9yIFx1MjE5MiBnaXRTZXJ2aWNlRmFjdG9yeVxuICAvL1xuICAvLyBGaW5hbCBXb3JrdHJlZUxpZmVjeWNsZURlcHMgc2hhcGU6IDMgZmllbGRzIChnaXRTZXJ2aWNlRmFjdG9yeSxcbiAgLy8gd29ya3RyZWVQcm9qZWN0aW9uLCBtZXJnZU1pbGVzdG9uZVRvTWFpbikuIERvd24gZnJvbSAxOCBhdCBzbGljZS03XG4gIC8vIGNsb3N1cmUuXG4gIHJldHVybiB7XG4gICAgZ2l0U2VydmljZUZhY3Rvcnk6IChiYXNlUGF0aDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCBnaXRDb25maWcgPVxuICAgICAgICBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM/LmdpdCA/PyB7fTtcbiAgICAgIHJldHVybiBuZXcgR2l0U2VydmljZUltcGwoYmFzZVBhdGgsIGdpdENvbmZpZyk7XG4gICAgfSxcbiAgICB3b3JrdHJlZVByb2plY3Rpb246IG5ldyBXb3JrdHJlZVN0YXRlUHJvamVjdGlvbigpLFxuICAgIG1lcmdlTWlsZXN0b25lVG9NYWluLFxuICB9O1xufVxuXG5mdW5jdGlvbiBidWlsZExpZmVjeWNsZSgpOiBXb3JrdHJlZUxpZmVjeWNsZSB7XG4gIHJldHVybiBuZXcgV29ya3RyZWVMaWZlY3ljbGUocywgYnVpbGRXb3JrdHJlZUxpZmVjeWNsZURlcHMoKSk7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIHByb2R1Y3Rpb24gYERpc3BhdGNoQWRhcHRlcmAgdXNlZCBieSBgY3JlYXRlV2lyZWRBdXRvT3JjaGVzdHJhdGlvbk1vZHVsZWAuXG4gKlxuICogRXhwb3J0ZWQgc28gdGVzdHMgY2FuIHZlcmlmeSBwYXJpdHkgd2l0aCBgcnVuRGlzcGF0Y2hgJ3MgYHJlc29sdmVEaXNwYXRjaGAgY2FsbCBcdTIwMTRcbiAqIHRoZSB3aXJlZCBhZGFwdGVyIG11c3QgZGVyaXZlIGBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlYCwgYHNlc3Npb25Db250ZXh0V2luZG93YCxcbiAqIGBzZXNzaW9uUHJvdmlkZXJgLCBhbmQgYG1vZGVsUmVnaXN0cnlgIHRoZSBzYW1lIHdheSBwaGFzZXMudHM6cnVuRGlzcGF0Y2ggZG9lcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVdpcmVkRGlzcGF0Y2hBZGFwdGVyKFxuICBjdHg6IEV4dGVuc2lvbkNvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGRpc3BhdGNoQmFzZVBhdGg6IHN0cmluZyxcbik6IERpc3BhdGNoQWRhcHRlciB7XG4gIHJldHVybiB7XG4gICAgYXN5bmMgZGVjaWRlTmV4dFVuaXQoaW5wdXQpIHtcbiAgICAgIGNvbnN0IHN0YXRlID0gaW5wdXQuc3RhdGVTbmFwc2hvdDtcbiAgICAgIGNvbnN0IGFjdGl2ZSA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZTtcbiAgICAgIGlmICghYWN0aXZlKSByZXR1cm4gbnVsbDtcblxuICAgICAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoZGlzcGF0Y2hCYXNlUGF0aCk/LnByZWZlcmVuY2VzO1xuXG4gICAgICAvLyBEZXJpdmUgc2Vzc2lvbi1kZXJpdmVkIGRpc3BhdGNoIGlucHV0cyB0aGUgc2FtZSB3YXkgcGhhc2VzLnRzOnJ1bkRpc3BhdGNoIGRvZXNcbiAgICAgIC8vICgjNTc4OSkuIFByZWZlciBjYWxsZXItc3VwcGxpZWQgdmFsdWVzIHdoZW4gcHJlc2VudCBzbyB0ZXN0IGhhcm5lc3NlcyBhbmRcbiAgICAgIC8vIGFsdGVybmF0aXZlIHdpcmluZ3MgY2FuIGluamVjdCBkZXRlcm1pbmlzdGljIHNuYXBzaG90czsgb3RoZXJ3aXNlIHB1bGwgZnJvbVxuICAgICAgLy8gdGhlIGNhcHR1cmVkIHBpL2N0eCByZWZlcmVuY2VzLlxuICAgICAgY29uc3Qgc2Vzc2lvblByb3ZpZGVyID0gaW5wdXQuc2Vzc2lvblByb3ZpZGVyID8/IGN0eC5tb2RlbD8ucHJvdmlkZXI7XG4gICAgICBjb25zdCBzZXNzaW9uQ29udGV4dFdpbmRvdyA9IGlucHV0LnNlc3Npb25Db250ZXh0V2luZG93ID8/IGN0eC5tb2RlbD8uY29udGV4dFdpbmRvdztcbiAgICAgIGNvbnN0IG1vZGVsUmVnaXN0cnkgPSBpbnB1dC5tb2RlbFJlZ2lzdHJ5ID8/IChjdHgubW9kZWxSZWdpc3RyeSBhcyBNaW5pbWFsTW9kZWxSZWdpc3RyeSB8IHVuZGVmaW5lZCk7XG4gICAgICBjb25zdCBhdXRoTW9kZSA9XG4gICAgICAgIHNlc3Npb25Qcm92aWRlciAmJiB0eXBlb2YgY3R4Lm1vZGVsUmVnaXN0cnk/LmdldFByb3ZpZGVyQXV0aE1vZGUgPT09IFwiZnVuY3Rpb25cIlxuICAgICAgICAgID8gY3R4Lm1vZGVsUmVnaXN0cnkuZ2V0UHJvdmlkZXJBdXRoTW9kZShzZXNzaW9uUHJvdmlkZXIpXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBhY3RpdmVUb29scyA9IHR5cGVvZiBwaS5nZXRBY3RpdmVUb29scyA9PT0gXCJmdW5jdGlvblwiID8gcGkuZ2V0QWN0aXZlVG9vbHMoKSA6IFtdO1xuICAgICAgLy8gTWlycm9ycyBydW5EaXNwYXRjaDogZGVlcC1wbGFubmluZyBrZWVwcyBhcHByb3ZhbCBnYXRlcyBpbiBwbGFpbiBjaGF0XG4gICAgICAvLyBiZWNhdXNlIHN0cnVjdHVyZWQgcXVlc3Rpb25zIGNhbiBiZSBjYW5jZWxsZWQgb3V0c2lkZSB0aGUgY2hhdCB0dXJuIG9uXG4gICAgICAvLyBzb21lIHRyYW5zcG9ydHMuXG4gICAgICBjb25zdCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlID1cbiAgICAgICAgaW5wdXQuc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSA/P1xuICAgICAgICAocHJlZnM/LnBsYW5uaW5nX2RlcHRoID09PSBcImRlZXBcIlxuICAgICAgICAgID8gXCJmYWxzZVwiXG4gICAgICAgICAgOiBzdXBwb3J0c1N0cnVjdHVyZWRRdWVzdGlvbnMoYWN0aXZlVG9vbHMsIHtcbiAgICAgICAgICAgICAgYXV0aE1vZGUsXG4gICAgICAgICAgICAgIGJhc2VVcmw6IGN0eC5tb2RlbD8uYmFzZVVybCxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICA/IFwidHJ1ZVwiXG4gICAgICAgICAgICA6IFwiZmFsc2VcIik7XG5cbiAgICAgIGNvbnN0IGFjdGlvbiA9IGF3YWl0IHJlc29sdmVEaXNwYXRjaCh7XG4gICAgICAgIGJhc2VQYXRoOiBkaXNwYXRjaEJhc2VQYXRoLFxuICAgICAgICBtaWQ6IGFjdGl2ZS5pZCxcbiAgICAgICAgbWlkVGl0bGU6IGFjdGl2ZS50aXRsZSxcbiAgICAgICAgc3RhdGUsXG4gICAgICAgIHByZWZzLFxuICAgICAgICBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlLFxuICAgICAgICBzZXNzaW9uQ29udGV4dFdpbmRvdyxcbiAgICAgICAgc2Vzc2lvblByb3ZpZGVyLFxuICAgICAgICBtb2RlbFJlZ2lzdHJ5LFxuICAgICAgfSk7XG5cbiAgICAgIGlmIChhY3Rpb24uYWN0aW9uID09PSBcInN0b3BcIikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGtpbmQ6IFwiYmxvY2tlZFwiLFxuICAgICAgICAgIHJlYXNvbjogYWN0aW9uLnJlYXNvbixcbiAgICAgICAgICBhY3Rpb246IGFjdGlvbi5sZXZlbCA9PT0gXCJ3YXJuaW5nXCIgPyBcInBhdXNlXCIgOiBcInN0b3BcIixcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChhY3Rpb24uYWN0aW9uICE9PSBcImRpc3BhdGNoXCIpIHJldHVybiBudWxsO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdW5pdFR5cGU6IGFjdGlvbi51bml0VHlwZSxcbiAgICAgICAgdW5pdElkOiBhY3Rpb24udW5pdElkLFxuICAgICAgICByZWFzb246IGFjdGlvbi5tYXRjaGVkUnVsZSA/PyBcImRpc3BhdGNoXCIsXG4gICAgICAgIHByZWNvbmRpdGlvbnM6IFtdLFxuICAgICAgfTtcbiAgICB9LFxuICB9O1xufVxuXG4vKipcbiAqIFRoaW4gZW50cnkgZ2x1ZSBmb3IgdGhlIG5ldyBBdXRvIE9yY2hlc3RyYXRpb24gbW9kdWxlLlxuICpcbiAqIFRoaXMgaW50ZW50aW9uYWxseSB3aXJlcyBvbmx5IGRpc3BhdGNoICsgZXJyb3Igbm90aWZpY2F0aW9uIHRvZGF5LCB3aXRoXG4gKiBubyBiZWhhdmlvciBjaGFuZ2VzIHRvIHRoZSBleGlzdGluZyBhdXRvIGxvb3AuIEl0IHByb3ZpZGVzIGEgY29uY3JldGUgc2VhbVxuICogdGhlIG5leHQgcmVmYWN0b3Igc3RlcHMgY2FuIGFkb3B0IGluY3JlbWVudGFsbHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVXaXJlZEF1dG9PcmNoZXN0cmF0aW9uTW9kdWxlKFxuICBjdHg6IEV4dGVuc2lvbkNvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGRpc3BhdGNoQmFzZVBhdGg6IHN0cmluZyxcbiAgcnVudGltZUJhc2VQYXRoID0gcmVzb2x2ZVByb2plY3RSb290KGRpc3BhdGNoQmFzZVBhdGgpLFxuKTogQXV0b09yY2hlc3RyYXRpb25Nb2R1bGUge1xuICBjb25zdCBmbG93SWQgPSBgYXV0by1vcmNoZXN0cmF0b3ItJHtEYXRlLm5vdygpfWA7XG4gIGxldCBzZXEgPSAwO1xuXG4gIGNvbnN0IGRlcHM6IEF1dG9PcmNoZXN0cmF0b3JEZXBzID0ge1xuICAgIHN0YXRlUmVjb25jaWxpYXRpb246IHtcbiAgICAgIGFzeW5jIHJlY29uY2lsZUJlZm9yZURpc3BhdGNoKCkge1xuICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaChkaXNwYXRjaEJhc2VQYXRoKTtcbiAgICAgICAgaWYgKHJlc3VsdC5ibG9ja2Vycy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICAgIHJlYXNvbjogcmVzdWx0LmJsb2NrZXJzWzBdLFxuICAgICAgICAgICAgc3RhdGVTbmFwc2hvdDogcmVzdWx0LnN0YXRlU25hcHNob3QsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByZXBhaXJlZEtpbmRzID0gcmVzdWx0LnJlcGFpcmVkLm1hcCgoZCkgPT4gZC5raW5kKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICByZWFzb246XG4gICAgICAgICAgICByZXBhaXJlZEtpbmRzLmxlbmd0aCA+IDBcbiAgICAgICAgICAgICAgPyBgcmVwYWlyZWQ6ICR7cmVwYWlyZWRLaW5kcy5qb2luKFwiLCBcIil9YFxuICAgICAgICAgICAgICA6IFwiY2xlYW5cIixcbiAgICAgICAgICBzdGF0ZVNuYXBzaG90OiByZXN1bHQuc3RhdGVTbmFwc2hvdCxcbiAgICAgICAgfTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBkaXNwYXRjaDogY3JlYXRlV2lyZWREaXNwYXRjaEFkYXB0ZXIoY3R4LCBwaSwgZGlzcGF0Y2hCYXNlUGF0aCksXG4gICAgcmVjb3Zlcnk6IHtcbiAgICAgIGFzeW5jIGNsYXNzaWZ5QW5kUmVjb3ZlcihpbnB1dCkge1xuICAgICAgICBjb25zdCByZWNvdmVyeSA9IGNsYXNzaWZ5RmFpbHVyZShpbnB1dCk7XG4gICAgICAgIHJldHVybiB7IGFjdGlvbjogcmVjb3ZlcnkuYWN0aW9uLCByZWFzb246IHJlY292ZXJ5LnJlYXNvbiB9O1xuICAgICAgfSxcbiAgICB9LFxuICAgIHRvb2xDb250cmFjdDoge1xuICAgICAgYXN5bmMgY29tcGlsZVVuaXRUb29sQ29udHJhY3QodW5pdFR5cGUpIHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gY29tcGlsZVVuaXRUb29sQ29udHJhY3QodW5pdFR5cGUpO1xuICAgICAgICBpZiAoIXJlc3VsdC5vaykgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IHJlc3VsdC5kZXRhaWwgfTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJlYXNvbjogcmVzdWx0LmNvbnRyYWN0LnZhbGlkYXRpb25SdWxlcy5qb2luKFwiLCBcIikgfTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB3b3JrdHJlZToge1xuICAgICAgYXN5bmMgcHJlcGFyZUZvclVuaXQodW5pdFR5cGUsIHVuaXRJZCkge1xuICAgICAgICBjb25zdCBtYW5pZmVzdCA9IHJlc29sdmVNYW5pZmVzdCh1bml0VHlwZSk7XG4gICAgICAgIGlmICghbWFuaWZlc3QpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgcmVhc29uOiBgTm8gVW5pdCBtYW5pZmVzdCBpcyByZWdpc3RlcmVkIGZvciAke3VuaXRUeXBlfWAsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB3cml0ZVNjb3BlID1cbiAgICAgICAgICBtYW5pZmVzdC50b29scy5tb2RlID09PSBcImFsbFwiIHx8IG1hbmlmZXN0LnRvb2xzLm1vZGUgPT09IFwiZG9jc1wiXG4gICAgICAgICAgICA/IFwic291cmNlLXdyaXRpbmdcIlxuICAgICAgICAgICAgOiBcInBsYW5uaW5nLW9ubHlcIjtcbiAgICAgICAgY29uc3Qgc2FmZXR5ID0gY3JlYXRlV29ya3RyZWVTYWZldHlNb2R1bGUoKTtcbiAgICAgICAgY29uc3Qgc25hcHNob3QgPSBhd2FpdCBkZXJpdmVTdGF0ZShkaXNwYXRjaEJhc2VQYXRoKTtcbiAgICAgICAgY29uc3QgbWlsZXN0b25lSWQgPSBzbmFwc2hvdC5hY3RpdmVNaWxlc3RvbmU/LmlkID8/IG51bGw7XG4gICAgICAgIGNvbnN0IGV4cGVjdGVkQnJhbmNoID0gbWlsZXN0b25lSWQgPyBhdXRvV29ya3RyZWVCcmFuY2gobWlsZXN0b25lSWQpIDogbnVsbDtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gc2FmZXR5LnZhbGlkYXRlVW5pdFJvb3Qoe1xuICAgICAgICAgIHVuaXRUeXBlLFxuICAgICAgICAgIHVuaXRJZCxcbiAgICAgICAgICB3cml0ZVNjb3BlLFxuICAgICAgICAgIHByb2plY3RSb290OiBydW50aW1lQmFzZVBhdGgsXG4gICAgICAgICAgdW5pdFJvb3Q6IGRpc3BhdGNoQmFzZVBhdGgsXG4gICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgZXhwZWN0ZWRCcmFuY2gsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBgJHtyZXN1bHQua2luZH06ICR7cmVzdWx0LnJlYXNvbn1gIH07XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIHJlYXNvbjogcmVzdWx0LmtpbmQgfTtcbiAgICAgIH0sXG4gICAgICBhc3luYyBzeW5jQWZ0ZXJVbml0KCkge30sXG4gICAgICBhc3luYyBjbGVhbnVwT25TdG9wKCkge30sXG4gICAgfSxcbiAgICBoZWFsdGg6IHtcbiAgICAgIGNoZWNrUmVzb3VyY2VzU3RhbGUoKSB7XG4gICAgICAgIHJldHVybiBjaGVja1Jlc291cmNlc1N0YWxlKHMucmVzb3VyY2VWZXJzaW9uT25TdGFydCk7XG4gICAgICB9LFxuICAgICAgYXN5bmMgcHJlQWR2YW5jZUdhdGUoKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgZ2F0ZSA9IGF3YWl0IHByZURpc3BhdGNoSGVhbHRoR2F0ZShkaXNwYXRjaEJhc2VQYXRoKTtcbiAgICAgICAgICBpZiAoZ2F0ZS5wcm9jZWVkKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICBraW5kOiBcInBhc3NcIixcbiAgICAgICAgICAgICAgZml4ZXNBcHBsaWVkOiBnYXRlLmZpeGVzQXBwbGllZCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBraW5kOiBcImZhaWxcIixcbiAgICAgICAgICAgIHJlYXNvbjogZ2F0ZS5yZWFzb24gPz8gXCJQcmUtZGlzcGF0Y2ggaGVhbHRoIGNoZWNrIGZhaWxlZCBcdTIwMTQgcnVuIC9nc2QgZG9jdG9yIGZvciBkZXRhaWxzLlwiLFxuICAgICAgICAgIH07XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgcmV0dXJuIHsga2luZDogXCJ0aHJld1wiLCBlcnJvciB9O1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgYXN5bmMgcG9zdEFkdmFuY2VSZWNvcmQocmVzdWx0KSB7XG4gICAgICAgIGlmIChyZXN1bHQua2luZCA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgICAgcmVjb3JkSGVhbHRoU25hcHNob3QoMSwgMCwgMCwgW3tcbiAgICAgICAgICAgIGNvZGU6IFwib3JjaGVzdHJhdGlvbi1lcnJvclwiLFxuICAgICAgICAgICAgbWVzc2FnZTogcmVzdWx0LnJlYXNvbiA/PyBcIm9yY2hlc3RyYXRpb24gZXJyb3JcIixcbiAgICAgICAgICAgIHNldmVyaXR5OiBcImVycm9yXCIsXG4gICAgICAgICAgICB1bml0SWQ6IFwib3JjaGVzdHJhdGlvblwiLFxuICAgICAgICAgIH1dLCBbXSwgXCJvcmNoZXN0cmF0aW9uXCIpO1xuICAgICAgICB9IGVsc2UgaWYgKHJlc3VsdC5raW5kID09PSBcImJsb2NrZWRcIikge1xuICAgICAgICAgIHJlY29yZEhlYWx0aFNuYXBzaG90KDAsIDEsIDAsIFt7XG4gICAgICAgICAgICBjb2RlOiBcIm9yY2hlc3RyYXRpb24tYmxvY2tlZFwiLFxuICAgICAgICAgICAgbWVzc2FnZTogcmVzdWx0LnJlYXNvbiA/PyBcIm9yY2hlc3RyYXRpb24gYmxvY2tlZFwiLFxuICAgICAgICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgICAgICAgdW5pdElkOiBcIm9yY2hlc3RyYXRpb25cIixcbiAgICAgICAgICB9XSwgW10sIFwib3JjaGVzdHJhdGlvblwiKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9LFxuICAgIHJ1bnRpbWU6IHtcbiAgICAgIGFzeW5jIGVuc3VyZUxvY2tPd25lcnNoaXAoKSB7XG4gICAgICAgIGNvbnN0IHN0YXR1cyA9IGdldFNlc3Npb25Mb2NrU3RhdHVzKHJ1bnRpbWVCYXNlUGF0aCk7XG4gICAgICAgIGlmICghc3RhdHVzLnZhbGlkIHx8IHN0YXR1cy5mYWlsdXJlUmVhc29uID09PSBcInBpZC1taXNtYXRjaFwiKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwic2Vzc2lvbiBsb2NrIGhlbGQgYnkgYW5vdGhlciBwcm9jZXNzXCIpO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgYXN5bmMgam91cm5hbFRyYW5zaXRpb24oZXZlbnQpIHtcbiAgICAgICAgY29uc3QgZXZlbnRUeXBlID0gZXZlbnQubmFtZSA9PT0gXCJzdGFydFwiXG4gICAgICAgICAgPyBcIml0ZXJhdGlvbi1zdGFydFwiXG4gICAgICAgICAgOiBldmVudC5uYW1lID09PSBcInJlc3VtZVwiXG4gICAgICAgICAgICA/IFwiaXRlcmF0aW9uLXN0YXJ0XCJcbiAgICAgICAgICAgIDogZXZlbnQubmFtZSA9PT0gXCJhZHZhbmNlXCJcbiAgICAgICAgICAgICAgPyBcImRpc3BhdGNoLW1hdGNoXCJcbiAgICAgICAgICAgICAgOiBldmVudC5uYW1lID09PSBcImFkdmFuY2UtYmxvY2tlZFwiXG4gICAgICAgICAgICAgICAgPyBcImd1YXJkLWJsb2NrXCJcbiAgICAgICAgICAgICAgICA6IGV2ZW50Lm5hbWUgPT09IFwiYWR2YW5jZS1zdG9wcGVkXCJcbiAgICAgICAgICAgICAgICAgID8gXCJkaXNwYXRjaC1zdG9wXCJcbiAgICAgICAgICAgICAgICAgIDogZXZlbnQubmFtZSA9PT0gXCJhZHZhbmNlLWVycm9yXCJcbiAgICAgICAgICAgICAgICAgICAgPyBcIml0ZXJhdGlvbi1lbmRcIlxuICAgICAgICAgICAgICAgICAgICA6IGV2ZW50Lm5hbWUgPT09IFwiYWR2YW5jZS1wYXVzZWRcIiB8fCBldmVudC5uYW1lID09PSBcImFkdmFuY2UtcmV0cnlcIlxuICAgICAgICAgICAgICAgICAgICAgID8gXCJndWFyZC1ibG9ja1wiXG4gICAgICAgICAgICAgICAgICAgICAgOiBldmVudC5uYW1lID09PSBcInN0b3BcIlxuICAgICAgICAgICAgICAgICAgICAgID8gXCJ0ZXJtaW5hbFwiXG4gICAgICAgICAgICAgICAgICAgICAgOiBcIml0ZXJhdGlvbi1lbmRcIjtcblxuICAgICAgICBfZW1pdEpvdXJuYWxFdmVudChydW50aW1lQmFzZVBhdGgsIHtcbiAgICAgICAgICB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgIGZsb3dJZCxcbiAgICAgICAgICBzZXE6ICsrc2VxLFxuICAgICAgICAgIGV2ZW50VHlwZSxcbiAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICBzb3VyY2U6IFwiYXV0by1vcmNoZXN0cmF0b3JcIixcbiAgICAgICAgICAgIG5hbWU6IGV2ZW50Lm5hbWUsXG4gICAgICAgICAgICByZWFzb246IGV2ZW50LnJlYXNvbixcbiAgICAgICAgICAgIHVuaXRUeXBlOiBldmVudC51bml0VHlwZSxcbiAgICAgICAgICAgIHVuaXRJZDogZXZlbnQudW5pdElkLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICB9LFxuICAgIG5vdGlmaWNhdGlvbnM6IHtcbiAgICAgIGFzeW5jIG5vdGlmeUxpZmVjeWNsZShldmVudCkge1xuICAgICAgICBpZiAoZXZlbnQubmFtZSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShldmVudC5kZXRhaWwgPz8gXCJhdXRvIG9yY2hlc3RyYXRpb24gZXJyb3JcIiwgXCJlcnJvclwiKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9LFxuICAgIHVva0dhdGU6IHtcbiAgICAgIGFzeW5jIGVtaXQoaW5wdXQpIHtcbiAgICAgICAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoZGlzcGF0Y2hCYXNlUGF0aCk/LnByZWZlcmVuY2VzO1xuICAgICAgICBjb25zdCB1b2tGbGFncyA9IHJlc29sdmVVb2tGbGFncyhwcmVmcyk7XG4gICAgICAgIGlmICghdW9rRmxhZ3MuZ2F0ZXMpIHJldHVybjtcbiAgICAgICAgY29uc3QgbWlsZXN0b25lSWQgPSBpbnB1dC5taWxlc3RvbmVJZCA/PyBzLmN1cnJlbnRNaWxlc3RvbmVJZCA/PyB1bmRlZmluZWQ7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgeyBVb2tHYXRlUnVubmVyIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3Vvay9nYXRlLXJ1bm5lci5qc1wiKTtcbiAgICAgICAgICBjb25zdCBydW5uZXIgPSBuZXcgVW9rR2F0ZVJ1bm5lcigpO1xuICAgICAgICAgIHJ1bm5lci5yZWdpc3Rlcih7XG4gICAgICAgICAgICBpZDogaW5wdXQuZ2F0ZUlkLFxuICAgICAgICAgICAgdHlwZTogaW5wdXQuZ2F0ZVR5cGUsXG4gICAgICAgICAgICBleGVjdXRlOiBhc3luYyAoKSA9PiAoe1xuICAgICAgICAgICAgICBvdXRjb21lOiBpbnB1dC5vdXRjb21lLFxuICAgICAgICAgICAgICBmYWlsdXJlQ2xhc3M6IGlucHV0LmZhaWx1cmVDbGFzcyxcbiAgICAgICAgICAgICAgcmF0aW9uYWxlOiBpbnB1dC5yYXRpb25hbGUsXG4gICAgICAgICAgICAgIGZpbmRpbmdzOiBpbnB1dC5maW5kaW5ncyA/PyBcIlwiLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYXdhaXQgcnVubmVyLnJ1bihpbnB1dC5nYXRlSWQsIHtcbiAgICAgICAgICAgIGJhc2VQYXRoOiBkaXNwYXRjaEJhc2VQYXRoLFxuICAgICAgICAgICAgdHJhY2VJZDogYHByZS1kaXNwYXRjaDoke2Zsb3dJZH1gLFxuICAgICAgICAgICAgdHVybklkOiBgb3JjaC0ke3NlcX1gLFxuICAgICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgICB1bml0VHlwZTogXCJwcmUtZGlzcGF0Y2hcIixcbiAgICAgICAgICAgIHVuaXRJZDogYG9yY2gtJHtzZXF9YCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgdW9rIGdhdGUgZW1pdCBmYWlsZWQ6ICR7Z2V0RXJyb3JNZXNzYWdlKGVycil9YCwge1xuICAgICAgICAgICAgZmlsZTogXCJhdXRvLnRzXCIsXG4gICAgICAgICAgICBnYXRlSWQ6IGlucHV0LmdhdGVJZCxcbiAgICAgICAgICAgIGdhdGVUeXBlOiBpbnB1dC5nYXRlVHlwZSxcbiAgICAgICAgICAgIC4uLihtaWxlc3RvbmVJZCA/IHsgbWlsZXN0b25lSWQgfSA6IHt9KSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9LFxuICB9O1xuXG4gIHJldHVybiBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xufVxuXG5mdW5jdGlvbiBub3RpZnlSZXN1bWVCbG9ja2VkKGN0eDogRXh0ZW5zaW9uQ29udGV4dCwgcmVzdWx0OiBFeHRyYWN0PEF1dG9BZHZhbmNlUmVzdWx0LCB7IGtpbmQ6IFwiYmxvY2tlZFwiIH0+KTogdm9pZCB7XG4gIGNvbnN0IHJlc3VtZUNtZCA9IHMuc3RlcE1vZGUgPyBcIi9nc2QgbmV4dFwiIDogXCIvZ3NkIGF1dG9cIjtcbiAgY3R4LnVpLm5vdGlmeShgQXV0by1tb2RlIGJsb2NrZWQ6ICR7cmVzdWx0LnJlYXNvbn0uIEZpeCBhbmQgcnVuICR7cmVzdW1lQ21kfSB0byByZXN1bWUuYCwgXCJ3YXJuaW5nXCIpO1xuICBzZXRMaWZlY3ljbGVPdXRjb21lKGN0eCwge1xuICAgIHN0YXR1czogXCJibG9ja2VkXCIsXG4gICAgdGl0bGU6IFwiQXV0by1tb2RlIGJsb2NrZWRcIixcbiAgICBkZXRhaWw6IHJlc3VsdC5yZWFzb24sXG4gICAgbmV4dEFjdGlvbjogYEZpeCB0aGUgYmxvY2tlciwgdGhlbiBydW4gJHtyZXN1bWVDbWR9IHRvIHJlc3VtZS5gLFxuICAgIGNvbW1hbmRzOiBbXCIvZ3NkIHN0YXR1cyBmb3Igb3ZlcnZpZXdcIiwgYCR7cmVzdW1lQ21kfSB0byByZXN1bWVgLCBcIi9nc2QgZG9jdG9yIHRvIGRpYWdub3NlXCJdLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlT3JjaGVzdHJhdGlvbk1vZHVsZShjdHg6IEV4dGVuc2lvbkNvbnRleHQsIHBpOiBFeHRlbnNpb25BUEksIGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgcy5vcmNoZXN0cmF0aW9uID0gY3JlYXRlV2lyZWRBdXRvT3JjaGVzdHJhdGlvbk1vZHVsZShjdHgsIHBpLCBiYXNlUGF0aCwgbG9ja0Jhc2UoKSk7XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIExvb3BEZXBzIG9iamVjdCBmcm9tIGF1dG8udHMgcHJpdmF0ZSBzY29wZS5cbiAqIFRoaXMgYnVuZGxlcyBhbGwgcHJpdmF0ZSBmdW5jdGlvbnMgdGhhdCBhdXRvTG9vcCBuZWVkcyB3aXRob3V0IGV4cG9ydGluZyB0aGVtLlxuICovXG5mdW5jdGlvbiBidWlsZExvb3BEZXBzKHBpOiBFeHRlbnNpb25BUEkpOiBMb29wRGVwcyB7XG4gIC8vIEluaXRpYWxpemUgdGhlIHVuaWZpZWQgcnVsZSByZWdpc3RyeSB3aXRoIGNvbnZlcnRlZCBkaXNwYXRjaCBydWxlcy5cbiAgLy8gTXVzdCBoYXBwZW4gYmVmb3JlIExvb3BEZXBzIGlzIGFzc2VtYmxlZCBzbyBmYWNhZGUgZnVuY3Rpb25zXG4gIC8vIChyZXNvbHZlRGlzcGF0Y2gsIHJ1blByZURpc3BhdGNoSG9va3MsIGV0Yy4pIGRlbGVnYXRlIHRvIHRoZSByZWdpc3RyeS5cbiAgaW5pdFJlZ2lzdHJ5KGNvbnZlcnREaXNwYXRjaFJ1bGVzKERJU1BBVENIX1JVTEVTKSk7XG5cbiAgY29uc3QgY211eCA9IG1ha2VDbXV4RW1pdHRlcnMocGkpO1xuICBjb25zdCB3b3JrdHJlZVByb2plY3Rpb24gPSBuZXcgV29ya3RyZWVTdGF0ZVByb2plY3Rpb24oKTtcblxuICByZXR1cm4ge1xuICAgIGxvY2tCYXNlLFxuICAgIGJ1aWxkU25hcHNob3RPcHRzLFxuICAgIHN0b3BBdXRvLFxuICAgIHBhdXNlQXV0byxcbiAgICBjbGVhclVuaXRUaW1lb3V0LFxuICAgIHVwZGF0ZVByb2dyZXNzV2lkZ2V0LFxuICAgIC4uLmNtdXgsXG4gICAgaGFuZGxlTG9zdFNlc3Npb25Mb2NrOiAoY3R4OiBFeHRlbnNpb25Db250ZXh0IHwgdW5kZWZpbmVkLCBsb2NrU3RhdHVzOiBTZXNzaW9uTG9ja1N0YXR1cyB8IHVuZGVmaW5lZCkgPT4ge1xuICAgICAgY211eC5jbGVhckNtdXhTaWRlYmFyKGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhzLmJhc2VQYXRoIHx8IHVuZGVmaW5lZCk/LnByZWZlcmVuY2VzKTtcbiAgICAgIGhhbmRsZUxvc3RTZXNzaW9uTG9jayhjdHgsIGxvY2tTdGF0dXMpO1xuICAgIH0sXG5cbiAgICAvLyBTdGF0ZSBhbmQgY2FjaGVcbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzLFxuICAgIGRlcml2ZVN0YXRlLFxuICAgIHJlYnVpbGRTdGF0ZSxcbiAgICBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMsXG5cbiAgICAvLyBQcmUtZGlzcGF0Y2ggaGVhbHRoIGdhdGVcbiAgICBwcmVEaXNwYXRjaEhlYWx0aEdhdGUsXG5cbiAgICAvLyBXb3JrdHJlZSBzdGF0ZSBwcm9qZWN0aW9uIChBRFItMDE2IFx1MjAxNCBzaW5nbGUgTW9kdWxlIEludGVyZmFjZSlcbiAgICB3b3JrdHJlZVByb2plY3Rpb24sXG5cbiAgICAvLyBSZXNvdXJjZSB2ZXJzaW9uIGd1YXJkXG4gICAgY2hlY2tSZXNvdXJjZXNTdGFsZSxcblxuICAgIC8vIFNlc3Npb24gbG9ja1xuICAgIHZhbGlkYXRlU2Vzc2lvbkxvY2s6IGdldFNlc3Npb25Mb2NrU3RhdHVzLFxuICAgIHVwZGF0ZVNlc3Npb25Mb2NrLFxuXG4gICAgLy8gTWlsZXN0b25lIHRyYW5zaXRpb25cbiAgICBzZW5kRGVza3RvcE5vdGlmaWNhdGlvbixcbiAgICBzZXRBY3RpdmVNaWxlc3RvbmVJZCxcbiAgICBwcnVuZVF1ZXVlT3JkZXIsXG4gICAgaXNJbkF1dG9Xb3JrdHJlZSxcbiAgICBzaG91bGRVc2VXb3JrdHJlZUlzb2xhdGlvbixcbiAgICB0ZWFyZG93bkF1dG9Xb3JrdHJlZSxcbiAgICBjcmVhdGVBdXRvV29ya3RyZWUsXG4gICAgY2FwdHVyZUludGVncmF0aW9uQnJhbmNoLFxuICAgIGdldElzb2xhdGlvbk1vZGUsXG4gICAgZ2V0Q3VycmVudEJyYW5jaCxcbiAgICBhdXRvV29ya3RyZWVCcmFuY2gsXG4gICAgcmVzb2x2ZU1pbGVzdG9uZUZpbGUsXG4gICAgcmVjb25jaWxlTWVyZ2VTdGF0ZSxcblxuICAgIC8vIEJ1ZGdldC9jb250ZXh0L3NlY3JldHNcbiAgICBnZXRMZWRnZXIsXG4gICAgZ2V0UHJvamVjdFRvdGFscyxcbiAgICBmb3JtYXRDb3N0LFxuICAgIGdldEJ1ZGdldEFsZXJ0TGV2ZWwsXG4gICAgZ2V0TmV3QnVkZ2V0QWxlcnRMZXZlbCxcbiAgICBnZXRCdWRnZXRFbmZvcmNlbWVudEFjdGlvbixcbiAgICBnZXRNYW5pZmVzdFN0YXR1cyxcbiAgICBjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdCxcblxuICAgIC8vIERpc3BhdGNoXG4gICAgcmVzb2x2ZURpc3BhdGNoLFxuICAgIHJ1blByZURpc3BhdGNoSG9va3MsXG4gICAgZ2V0UHJpb3JTbGljZUNvbXBsZXRpb25CbG9ja2VyLFxuICAgIGdldE1haW5CcmFuY2gsXG4gICAgLy8gVW5pdCBjbG9zZW91dCArIHJ1bnRpbWUgcmVjb3Jkc1xuICAgIGNsb3Nlb3V0VW5pdCxcbiAgICBhdXRvQ29tbWl0VW5pdCxcbiAgICByZWNvcmRPdXRjb21lLFxuICAgIHdyaXRlTG9jayxcbiAgICBjYXB0dXJlQXZhaWxhYmxlU2tpbGxzLFxuICAgIGVuc3VyZVByZWNvbmRpdGlvbnMsXG4gICAgdXBkYXRlU2xpY2VQcm9ncmVzc0NhY2hlLFxuXG4gICAgLy8gTW9kZWwgc2VsZWN0aW9uICsgc3VwZXJ2aXNpb25cbiAgICBzZWxlY3RBbmRBcHBseU1vZGVsLFxuICAgIHJlc29sdmVNb2RlbElkLFxuICAgIHN0YXJ0VW5pdFN1cGVydmlzaW9uLFxuXG4gICAgLy8gUHJvbXB0IGhlbHBlcnNcbiAgICBnZXREZWVwRGlhZ25vc3RpYzogKGJhc2VQYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IG1pZCA9IHJlYWRBY3RpdmVNaWxlc3RvbmVJZChiYXNlUGF0aCk7XG4gICAgICBjb25zdCB3dFBhdGggPSBtaWQgPyBnZXRBdXRvV29ya3RyZWVQYXRoKGJhc2VQYXRoLCBtaWQpIDogdW5kZWZpbmVkO1xuICAgICAgcmV0dXJuIGdldERlZXBEaWFnbm9zdGljKGJhc2VQYXRoLCB3dFBhdGggPz8gdW5kZWZpbmVkKTtcbiAgICB9LFxuICAgIGlzRGJBdmFpbGFibGUsXG4gICAgcmVvcmRlckZvckNhY2hpbmcsXG5cbiAgICAvLyBGaWxlc3lzdGVtXG4gICAgZXhpc3RzU3luYyxcbiAgICByZWFkRmlsZVN5bmM6IChwYXRoOiBzdHJpbmcsIGVuY29kaW5nOiBzdHJpbmcpID0+XG4gICAgICByZWFkRmlsZVN5bmMocGF0aCwgZW5jb2RpbmcgYXMgQnVmZmVyRW5jb2RpbmcpLFxuICAgIGF0b21pY1dyaXRlU3luYyxcblxuICAgIC8vIEdpdFxuICAgIEdpdFNlcnZpY2VJbXBsOiBHaXRTZXJ2aWNlSW1wbCBhcyB1bmtub3duIGFzIExvb3BEZXBzW1wiR2l0U2VydmljZUltcGxcIl0sXG5cbiAgICAvLyBXb3JrdHJlZSBMaWZlY3ljbGUgTW9kdWxlIChBRFItMDE2IFx1MjAxNCBzaW5nbGUgTW9kdWxlIEludGVyZmFjZSBmb3IgdGhlXG4gICAgLy8gbWlsZXN0b25lIGNyZWF0ZS9lbnRlci9leGl0L21lcmdlIHZlcmJzKVxuICAgIGxpZmVjeWNsZTogYnVpbGRMaWZlY3ljbGUoKSxcblxuICAgIC8vIFBvc3QtdW5pdCBwcm9jZXNzaW5nXG4gICAgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24sXG4gICAgcnVuUG9zdFVuaXRWZXJpZmljYXRpb24sXG4gICAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uLFxuXG4gICAgLy8gU2Vzc2lvbiBtYW5hZ2VyXG4gICAgZ2V0U2Vzc2lvbkZpbGU6IChjdHg6IEV4dGVuc2lvbkNvbnRleHQpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBjdHguc2Vzc2lvbk1hbmFnZXI/LmdldFNlc3Npb25GaWxlKCkgPz8gXCJcIjtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXR1cm4gXCJcIjtcbiAgICAgIH1cbiAgICB9LFxuXG4gICAgLy8gSm91cm5hbFxuICAgIGVtaXRKb3VybmFsRXZlbnQ6IChlbnRyeTogSm91cm5hbEVudHJ5KSA9PiBfZW1pdEpvdXJuYWxFdmVudChzLmJhc2VQYXRoLCBlbnRyeSksXG5cbiAgICAvLyBDbGVhbi1yb290IHByZWZsaWdodCBnYXRlICgjMjkwOSlcbiAgICBwcmVmbGlnaHRDbGVhblJvb3QsXG4gICAgcG9zdGZsaWdodFBvcFN0YXNoLFxuICB9IGFzIHVua25vd24gYXMgTG9vcERlcHM7XG59XG5cbi8qKlxuICogU3RhcnQgYXV0by1tb2RlLiBIYW5kbGVzIGJvdGggZnJlc2gtc3RhcnQgYW5kIHJlc3VtZSBwYXRocywgc2V0cyB1cCBzZXNzaW9uXG4gKiBzdGF0ZSwgZW50ZXJzIHRoZSBtaWxlc3RvbmUgd29ya3RyZWUgb3IgYnJhbmNoLCBhbmQgZGlzcGF0Y2hlcyB0aGUgZmlyc3QgdW5pdC5cbiAqIE5vLW9wcyBpZiBhdXRvLW1vZGUgaXMgYWxyZWFkeSBhY3RpdmUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydEF1dG8oXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGJhc2U6IHN0cmluZyxcbiAgdmVyYm9zZU1vZGU6IGJvb2xlYW4sXG4gIG9wdGlvbnM/OiB7XG4gICAgc3RlcD86IGJvb2xlYW47XG4gICAgaW50ZXJydXB0ZWQ/OiBJbnRlcnJ1cHRlZFNlc3Npb25Bc3Nlc3NtZW50O1xuICAgIG1pbGVzdG9uZUxvY2s/OiBzdHJpbmcgfCBudWxsO1xuICB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChzLmFjdGl2ZSkge1xuICAgIGRlYnVnTG9nKFwic3RhcnRBdXRvXCIsIHsgcGhhc2U6IFwiYWxyZWFkeS1hY3RpdmVcIiwgc2tpcHBpbmc6IHRydWUgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gT24gYSAqZnJlc2gqIHN0YXJ0LCBkcm9wIGFueSBzdGFsZSBhY3RpdmUtdG9vbCBiYXNlbGluZSBsZWZ0IGJ5IGEgcHJpb3JcbiAgLy8gYXV0byBzZXNzaW9uIHRoYXQgZGlkbid0IHJ1biBzdG9wQXV0byBjbGVhbmx5LiAgU2tpcCBvbiByZXN1bWU6IHBhdXNlQXV0b1xuICAvLyBsZWF2ZXMgdGhlIGxhc3QgcHJvdmlkZXItdHJpbW1lZCBhY3RpdmUgdG9vbHMgaW4gcGxhY2UsIHNvIGNsZWFyaW5nIGhlcmVcbiAgLy8gd291bGQgbGV0IHRoZSBuZXh0IHNlbGVjdEFuZEFwcGx5TW9kZWwgcmVjYXB0dXJlIHRoYXQgYWxyZWFkeS1uYXJyb3dlZFxuICAvLyBzZXQgYXMgdGhlIG5ldyBiYXNlbGluZSBcdTIwMTQgZXhhY3RseSB0aGUgY3Jvc3MtdW5pdCBwb2lzb25pbmcgdGhpcyBQUiBpc1xuICAvLyBmaXhpbmcgKCM0OTU5IC8gQ29kZVJhYmJpdCBNYWpvcikuICBUaGUgcHJlLXBhdXNlIGJhc2VsaW5lIHN1cnZpdmVzIGluXG4gIC8vIHRoZSBXZWFrTWFwIGtleWVkIGJ5IGBwaWAuXG4gIGlmICghcy5wYXVzZWQpIGNsZWFyVG9vbEJhc2VsaW5lKHBpKTtcblxuICBjb25zdCByZXF1ZXN0ZWRTdGVwTW9kZSA9IG9wdGlvbnM/LnN0ZXAgPz8gZmFsc2U7XG4gIGNvbnN0IGludGVycnVwdGVkQXNzZXNzbWVudCA9IG9wdGlvbnM/LmludGVycnVwdGVkID8/IG51bGw7XG4gIGlmIChvcHRpb25zPy5taWxlc3RvbmVMb2NrICE9PSB1bmRlZmluZWQpIHtcbiAgICBzLnNlc3Npb25NaWxlc3RvbmVMb2NrID0gb3B0aW9ucy5taWxlc3RvbmVMb2NrID8/IG51bGw7XG4gIH1cbiAgaWYgKHMuc2Vzc2lvbk1pbGVzdG9uZUxvY2spIHtcbiAgICBjYXB0dXJlTWlsZXN0b25lTG9ja0VudihzLnNlc3Npb25NaWxlc3RvbmVMb2NrKTtcbiAgfVxuXG4gIC8vIEVzY2FwZSBzdGFsZSB3b3JrdHJlZSBjd2QgZnJvbSBhIHByZXZpb3VzIG1pbGVzdG9uZSAoIzYwOCkuXG4gIGJhc2UgPSBlc2NhcGVTdGFsZVdvcmt0cmVlKGJhc2UpO1xuXG4gIGNvbnN0IGRpckNoZWNrID0gdmFsaWRhdGVEaXJlY3RvcnkoYmFzZSk7XG4gIGlmIChkaXJDaGVjay5zZXZlcml0eSA9PT0gXCJibG9ja2VkXCIpIHtcbiAgICBjdHgudWkubm90aWZ5KGRpckNoZWNrLnJlYXNvbiEsIFwiZXJyb3JcIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gSGVhbCAuZ3NkLm1pZ3JhdGluZyBiZWZvcmUgYW55IGJyYW5jaGluZyBcdTIwMTQgY292ZXJzIGJvdGggZnJlc2gtc3RhcnQgYW5kXG4gIC8vIHJlc3VtZSBwYXRocyAoIzQ0MTYpLiBUaGUgbWF0Y2hpbmcgY2FsbCBpbiBhdXRvLXN0YXJ0LnRzIGNvdmVycyB0aGVcbiAgLy8gYm9vdHN0cmFwLW9ubHkgcGF0aDsgdGhpcyBjYWxsIGVuc3VyZXMgdGhlIHJlc3VtZSBwYXRoIGlzIGFsc28gcHJvdGVjdGVkLlxuICBpZiAocmVjb3ZlckZhaWxlZE1pZ3JhdGlvbihiYXNlKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJSZWNvdmVyZWQgdW5maW5pc2hlZCBtaWdyYXRpb24gKC5nc2QubWlncmF0aW5nIFx1MjE5MiAuZ3NkKS5cIiwgXCJpbmZvXCIpO1xuICB9XG5cbiAgY29uc3QgZnJlc2hTdGFydEFzc2Vzc21lbnQgPSBhd2FpdCAoaW50ZXJydXB0ZWRBc3Nlc3NtZW50XG4gICAgPz8gKCgpID0+IHtcbiAgICAgIHJldHVybiBlbnN1cmVEYk9wZW4oYmFzZSkudGhlbigoKSA9PiBhc3Nlc3NJbnRlcnJ1cHRlZFNlc3Npb24oYmFzZSkpO1xuICAgIH0pKCkpO1xuXG4gIGlmIChmcmVzaFN0YXJ0QXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICBjb25zdCBwaWQgPSBmcmVzaFN0YXJ0QXNzZXNzbWVudC5sb2NrPy5waWQ7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIHBpZFxuICAgICAgICA/IGBBbm90aGVyIGF1dG8tbW9kZSBzZXNzaW9uIChQSUQgJHtwaWR9KSBhcHBlYXJzIHRvIGJlIHJ1bm5pbmcuXFxuU3RvcCBpdCB3aXRoIFxcYGtpbGwgJHtwaWR9XFxgIGJlZm9yZSBzdGFydGluZyBhIG5ldyBzZXNzaW9uLmBcbiAgICAgICAgOiBcIkFub3RoZXIgYXV0by1tb2RlIHNlc3Npb24gYXBwZWFycyB0byBiZSBydW5uaW5nLlwiLFxuICAgICAgXCJlcnJvclwiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gSWYgcmVzdW1pbmcgZnJvbSBwYXVzZWQgc3RhdGUsIGp1c3QgcmUtYWN0aXZhdGUgYW5kIGRpc3BhdGNoIG5leHQgdW5pdC5cbiAgLy8gQ2hlY2sgcGVyc2lzdGVkIHBhdXNlZC1zZXNzaW9uIGZpcnN0ICgjMTM4MykgXHUyMDE0IHN1cnZpdmVzIC9leGl0LlxuICAvLyBQaGFzZSBDIHB0IDI6IHBlcnNpc3RlZCBpbiBydW50aW1lX2t2IChnbG9iYWwgc2NvcGUpIGluc3RlYWQgb2ZcbiAgLy8gcnVudGltZS9wYXVzZWQtc2Vzc2lvbi5qc29uLiBUaGUgYGNsZWFyUGF1c2VkU2Vzc2lvbmAgaGVscGVyXG4gIC8vIHJlcGxhY2VzIGV2ZXJ5IHByaW9yIHVubGlua1N5bmMocGF1c2VkUGF0aCkgY2FsbC5cbiAgY29uc3QgY2xlYXJQYXVzZWRTZXNzaW9uID0gKGxvZ1RhZzogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGRlbGV0ZVJ1bnRpbWVLdihcImdsb2JhbFwiLCBcIlwiLCBQQVVTRURfU0VTU0lPTl9LVl9LRVkpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgbG9nV2FybmluZyhcInNlc3Npb25cIiwgYCR7bG9nVGFnfTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCwgeyBmaWxlOiBcImF1dG8udHNcIiB9KTtcbiAgICB9XG4gIH07XG5cbiAgaWYgKCFzLnBhdXNlZCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBtZXRhID0gZnJlc2hTdGFydEFzc2Vzc21lbnQucGF1c2VkU2Vzc2lvbiA/PyByZWFkUGF1c2VkU2Vzc2lvbk1ldGFkYXRhKGJhc2UpO1xuICAgICAgaWYgKG1ldGE/LmFjdGl2ZUVuZ2luZUlkICYmIG1ldGEuYWN0aXZlRW5naW5lSWQgIT09IFwiZGV2XCIpIHtcbiAgICAgICAgLy8gQ3VzdG9tIHdvcmtmbG93IHJlc3VtZSBcdTIwMTQgcmVzdG9yZSBlbmdpbmUgc3RhdGVcbiAgICAgICAgcy5hY3RpdmVFbmdpbmVJZCA9IG1ldGEuYWN0aXZlRW5naW5lSWQ7XG4gICAgICAgIHMuYWN0aXZlUnVuRGlyID0gbWV0YS5hY3RpdmVSdW5EaXIgPz8gbnVsbDtcbiAgICAgICAgcy5vcmlnaW5hbEJhc2VQYXRoID0gbWV0YS5vcmlnaW5hbEJhc2VQYXRoIHx8IGJhc2U7XG4gICAgICAgIHMuc3RlcE1vZGUgPSBtZXRhLnN0ZXBNb2RlID8/IHJlcXVlc3RlZFN0ZXBNb2RlO1xuICAgICAgICBzLmF1dG9TdGFydFRpbWUgPSBtZXRhLmF1dG9TdGFydFRpbWUgfHwgRGF0ZS5ub3coKTtcbiAgICAgICAgcy5zZXNzaW9uTWlsZXN0b25lTG9jayA9IG1ldGEubWlsZXN0b25lTG9jayA/PyBudWxsO1xuICAgICAgICBzLnBhdXNlZCA9IHRydWU7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYFJlc3VtaW5nIHBhdXNlZCBjdXN0b20gd29ya2Zsb3cke21ldGEuYWN0aXZlUnVuRGlyID8gYCAoJHttZXRhLmFjdGl2ZVJ1bkRpcn0pYCA6IFwiXCJ9LmAsXG4gICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2UgaWYgKG1ldGE/Lm1pbGVzdG9uZUlkKSB7XG4gICAgICAgIGNvbnN0IHNob3VsZFJlc3VtZVBhdXNlZFNlc3Npb24gPVxuICAgICAgICAgIGZyZXNoU3RhcnRBc3Nlc3NtZW50LmNsYXNzaWZpY2F0aW9uID09PSBcInJlY292ZXJhYmxlXCJcbiAgICAgICAgICAmJiAoXG4gICAgICAgICAgICBmcmVzaFN0YXJ0QXNzZXNzbWVudC5oYXNSZXN1bWFibGVEaXNrU3RhdGVcbiAgICAgICAgICAgIHx8ICEhZnJlc2hTdGFydEFzc2Vzc21lbnQucmVjb3ZlcnlQcm9tcHRcbiAgICAgICAgICAgIHx8ICEhZnJlc2hTdGFydEFzc2Vzc21lbnQubG9ja1xuICAgICAgICAgICk7XG4gICAgICAgIGlmIChzaG91bGRSZXN1bWVQYXVzZWRTZXNzaW9uKSB7XG4gICAgICAgICAgLy8gVmFsaWRhdGUgdGhlIG1pbGVzdG9uZSBzdGlsbCBleGlzdHMgYW5kIGlzbid0IGFscmVhZHkgY29tcGxldGUgKCMxNjY0KS5cbiAgICAgICAgICAvLyBEQiBzdGF0dXMgaXMgYXV0aG9yaXRhdGl2ZSB3aGVuIGF2YWlsYWJsZTsgU1VNTUFSWS5tZCBpcyBhIGxlZ2FjeVxuICAgICAgICAgIC8vIGZhbGxiYWNrIG9ubHkgZm9yIHVubWlncmF0ZWQvb2ZmbGluZSBwcm9qZWN0cy5cbiAgICAgICAgICBjb25zdCBtRGlyID0gcmVzb2x2ZU1pbGVzdG9uZVBhdGgoYmFzZSwgbWV0YS5taWxlc3RvbmVJZCk7XG4gICAgICAgICAgbGV0IHN1bW1hcnlJc1Rlcm1pbmFsID0gZmFsc2U7XG4gICAgICAgICAgbGV0IGRiQXZhaWxhYmxlID0gaXNEYkF2YWlsYWJsZSgpO1xuICAgICAgICAgIGxldCBtaWxlc3RvbmVSb3cgPSBkYkF2YWlsYWJsZSA/IGdldE1pbGVzdG9uZShtZXRhLm1pbGVzdG9uZUlkKSA6IG51bGw7XG4gICAgICAgICAgaWYgKCFtaWxlc3RvbmVSb3cpIHtcbiAgICAgICAgICAgIGNvbnN0IG9wZW5lZCA9IGF3YWl0IGVuc3VyZURiT3BlbihiYXNlKTtcbiAgICAgICAgICAgIGRiQXZhaWxhYmxlID0gb3BlbmVkIHx8IGlzRGJBdmFpbGFibGUoKTtcbiAgICAgICAgICAgIGlmIChkYkF2YWlsYWJsZSkge1xuICAgICAgICAgICAgICBtaWxlc3RvbmVSb3cgPSBnZXRNaWxlc3RvbmUobWV0YS5taWxlc3RvbmVJZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChkYkF2YWlsYWJsZSkge1xuICAgICAgICAgICAgc3VtbWFyeUlzVGVybWluYWwgPSAhIW1pbGVzdG9uZVJvdyAmJiBpc0Nsb3NlZFN0YXR1cyhtaWxlc3RvbmVSb3cuc3RhdHVzKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3Qgc3VtbWFyeUZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtZXRhLm1pbGVzdG9uZUlkLCBcIlNVTU1BUllcIik7XG4gICAgICAgICAgICBpZiAoc3VtbWFyeUZpbGUpIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBzdW1tYXJ5SXNUZXJtaW5hbCA9IGNsYXNzaWZ5TWlsZXN0b25lU3VtbWFyeUNvbnRlbnQocmVhZEZpbGVTeW5jKHN1bW1hcnlGaWxlLCBcInV0Zi04XCIpKSAhPT0gXCJmYWlsdXJlXCI7XG4gICAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICAgIHN1bW1hcnlJc1Rlcm1pbmFsID0gZmFsc2U7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKCFtRGlyIHx8IHN1bW1hcnlJc1Rlcm1pbmFsKSB7XG4gICAgICAgICAgICBjbGVhclBhdXNlZFNlc3Npb24oXCJwYXVzZWQtc2Vzc2lvbiBEQiBjbGVhbnVwIGZhaWxlZCAobWlsZXN0b25lIGdvbmUvY29tcGxldGUpXCIpO1xuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgYFBhdXNlZCBtaWxlc3RvbmUgJHttZXRhLm1pbGVzdG9uZUlkfSBpcyAkeyFtRGlyID8gXCJtaXNzaW5nXCIgOiBcImFscmVhZHkgY29tcGxldGVcIn0uIFN0YXJ0aW5nIGZyZXNoLmAsXG4gICAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcy5jdXJyZW50TWlsZXN0b25lSWQgPSBtZXRhLm1pbGVzdG9uZUlkO1xuICAgICAgICAgICAgcy5vcmlnaW5hbEJhc2VQYXRoID0gbWV0YS5vcmlnaW5hbEJhc2VQYXRoIHx8IGJhc2U7XG4gICAgICAgICAgICBzLnN0ZXBNb2RlID0gbWV0YS5zdGVwTW9kZSA/PyByZXF1ZXN0ZWRTdGVwTW9kZTtcbiAgICAgICAgICAgIHMucGF1c2VkU2Vzc2lvbkZpbGUgPSBub3JtYWxpemVTZXNzaW9uRmlsZVBhdGgobWV0YS5zZXNzaW9uRmlsZSA/PyBudWxsKTtcbiAgICAgICAgICAgIHMucGF1c2VkVW5pdFR5cGUgPSBtZXRhLnVuaXRUeXBlID8/IG51bGw7XG4gICAgICAgICAgICBzLnBhdXNlZFVuaXRJZCA9IG1ldGEudW5pdElkID8/IG51bGw7XG4gICAgICAgICAgICBzLmF1dG9TdGFydFRpbWUgPSBtZXRhLmF1dG9TdGFydFRpbWUgfHwgRGF0ZS5ub3coKTtcbiAgICAgICAgICAgIHMuc2Vzc2lvbk1pbGVzdG9uZUxvY2sgPSBtZXRhLm1pbGVzdG9uZUxvY2sgPz8gbnVsbDtcbiAgICAgICAgICAgIHMucGF1c2VkID0gdHJ1ZTtcbiAgICAgICAgICAgIC8vIEJ1aWxkIHNjb3BlIGZyb20gcGVyc2lzdGVkIHN0YXRlLiBVc2Ugd29ya3RyZWVQYXRoIHdoZW4gcHJlc2VudCBhbmRcbiAgICAgICAgICAgIC8vIHN0aWxsIG9uIGRpc2sgc28gbW9kZSBpcyBkZXRlY3RlZCBjb3JyZWN0bHk7IGZhbGwgYmFjayB0byBwcm9qZWN0IHJvb3QuXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGNvbnN0IHBlcnNpc3RlZFdvcmt0cmVlUGF0aCA9IG1ldGEud29ya3RyZWVQYXRoID8/IG51bGw7XG4gICAgICAgICAgICAgIGlmIChwZXJzaXN0ZWRXb3JrdHJlZVBhdGggJiYgIWV4aXN0c1N5bmMocGVyc2lzdGVkV29ya3RyZWVQYXRoKSkge1xuICAgICAgICAgICAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgICAgICAgICAgICBcInNlc3Npb25cIixcbiAgICAgICAgICAgICAgICAgIGBXb3JrdHJlZSB3YXMgZXhwZWN0ZWQgYXQgJHtwZXJzaXN0ZWRXb3JrdHJlZVBhdGh9IGJ1dCBpcyBtaXNzaW5nLiBDb250aW51aW5nIGluIHByb2plY3Qtcm9vdCBtb2RlLiBUbyByZXN0YXJ0IHdpdGggYSBmcmVzaCB3b3JrdHJlZSwgcnVuIC9nc2QtZGVidWcgb3IgcmVjcmVhdGUgdGhlIG1pbGVzdG9uZS5gLFxuICAgICAgICAgICAgICAgICAgeyBmaWxlOiBcImF1dG8udHNcIiwgbWlsZXN0b25lSWQ6IG1ldGEubWlsZXN0b25lSWQgPz8gXCJcIiB9LFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgY29uc3QgcmF3Rm9yU2NvcGUgPSAocGVyc2lzdGVkV29ya3RyZWVQYXRoICYmIGV4aXN0c1N5bmMocGVyc2lzdGVkV29ya3RyZWVQYXRoKSlcbiAgICAgICAgICAgICAgICA/IHBlcnNpc3RlZFdvcmt0cmVlUGF0aFxuICAgICAgICAgICAgICAgIDogKHMub3JpZ2luYWxCYXNlUGF0aCB8fCBiYXNlKTtcbiAgICAgICAgICAgICAgcmVidWlsZFNjb3BlKHJhd0ZvclNjb3BlLCBzLmN1cnJlbnRNaWxlc3RvbmVJZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgICBgUmVzdW1pbmcgcGF1c2VkIHNlc3Npb24gZm9yICR7bWV0YS5taWxlc3RvbmVJZH0ke21ldGEud29ya3RyZWVQYXRoICYmIGV4aXN0c1N5bmMobWV0YS53b3JrdHJlZVBhdGgpID8gYCAod29ya3RyZWUpYCA6IFwiXCJ9LmAsXG4gICAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAobWV0YSkge1xuICAgICAgICAgIC8vIFN0YWxlIHBhdXNlZC1zZXNzaW9uIG1ldGFkYXRhIHRoYXQgdGhlIGFzc2Vzc21lbnQgY2hvc2Ugbm90IHRvXG4gICAgICAgICAgLy8gcmVzdW1lIFx1MjAxNCBjbGVhbiBpdCB1cCBzbyB0aGUgbmV4dCBib290c3RyYXAgc3RhcnRzIGZyZXNoLlxuICAgICAgICAgIGNsZWFyUGF1c2VkU2Vzc2lvbihcInN0YWxlIHBhdXNlZC1zZXNzaW9uIERCIGNsZWFudXAgZmFpbGVkXCIpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBNYWxmb3JtZWQgb3IgbWlzc2luZyBcdTIwMTQgcHJvY2VlZCB3aXRoIGZyZXNoIGJvb3RzdHJhcFxuICAgICAgbG9nV2FybmluZyhcInNlc3Npb25cIiwgYHBhdXNlZC1zZXNzaW9uIHJlc3RvcmUgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLCB7IGZpbGU6IFwiYXV0by50c1wiIH0pO1xuICAgIH1cbiAgICAvLyBHdWFyZCBhZ2FpbnN0IHplcm8vbWlzc2luZyBhdXRvU3RhcnRUaW1lIGFmdGVyIHJlc3VtZSAoIzM1ODUpXG4gICAgaWYgKCFzLmF1dG9TdGFydFRpbWUgfHwgcy5hdXRvU3RhcnRUaW1lIDw9IDApIHMuYXV0b1N0YXJ0VGltZSA9IERhdGUubm93KCk7XG4gIH1cblxuICBpZiAocy5zZXNzaW9uTWlsZXN0b25lTG9jaykge1xuICAgIGNhcHR1cmVNaWxlc3RvbmVMb2NrRW52KHMuc2Vzc2lvbk1pbGVzdG9uZUxvY2spO1xuICB9XG5cbiAgaWYgKCFzLnBhdXNlZCkge1xuICAgIHMuc3RlcE1vZGUgPSByZXF1ZXN0ZWRTdGVwTW9kZTtcbiAgfVxuXG4gIGlmIChmcmVzaFN0YXJ0QXNzZXNzbWVudC5sb2NrKSB7XG4gICAgLy8gRW1pdCBhIHN5bnRoZXRpYyB1bml0LWVuZCBmb3IgYW55IHVuaXQtc3RhcnQgdGhhdCBoYXMgbm8gY2xvc2luZyBldmVudC5cbiAgICAvLyBUaGlzIGNsb3NlcyB0aGUgam91cm5hbCBnYXAgcmVwb3J0ZWQgaW4gIzMzNDggd2hlcmUgdGhlIHdvcmtlciB3cm90ZSBzaWRlXG4gICAgLy8gZWZmZWN0cyAoU1VNTUFSWS5tZCwgREIgdXBkYXRlcykgYnV0IGRpZWQgYmVmb3JlIGVtaXR0aW5nIHVuaXQtZW5kLlxuICAgIGVtaXRDcmFzaFJlY292ZXJlZFVuaXRFbmQoYmFzZSwgZnJlc2hTdGFydEFzc2Vzc21lbnQubG9jayk7XG4gICAgY2xlYXJTdGFsZVdvcmtlckxvY2soYmFzZSk7XG4gIH1cblxuICBpZiAoIXMucGF1c2VkKSB7XG4gICAgcy5wZW5kaW5nQ3Jhc2hSZWNvdmVyeSA9XG4gICAgICBmcmVzaFN0YXJ0QXNzZXNzbWVudC5jbGFzc2lmaWNhdGlvbiA9PT0gXCJyZWNvdmVyYWJsZVwiXG4gICAgICAgID8gZnJlc2hTdGFydEFzc2Vzc21lbnQucmVjb3ZlcnlQcm9tcHRcbiAgICAgICAgOiBudWxsO1xuXG4gICAgaWYgKGZyZXNoU3RhcnRBc3Nlc3NtZW50LmNsYXNzaWZpY2F0aW9uID09PSBcInJlY292ZXJhYmxlXCIgJiYgZnJlc2hTdGFydEFzc2Vzc21lbnQubG9jaykge1xuICAgICAgY29uc3QgaW5mbyA9IGZvcm1hdENyYXNoSW5mbyhmcmVzaFN0YXJ0QXNzZXNzbWVudC5sb2NrKTtcbiAgICAgIGlmIChmcmVzaFN0YXJ0QXNzZXNzbWVudC5yZWNvdmVyeVRvb2xDYWxsQ291bnQgPiAwKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYCR7aW5mb31cXG5SZWNvdmVyZWQgJHtmcmVzaFN0YXJ0QXNzZXNzbWVudC5yZWNvdmVyeVRvb2xDYWxsQ291bnR9IHRvb2wgY2FsbHMgZnJvbSBjcmFzaGVkIHNlc3Npb24uIFJlc3VtaW5nIHdpdGggZnVsbCBjb250ZXh0LmAsXG4gICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2UgaWYgKGZyZXNoU3RhcnRBc3Nlc3NtZW50Lmhhc1Jlc3VtYWJsZURpc2tTdGF0ZSkge1xuICAgICAgICBjdHgudWkubm90aWZ5KGAke2luZm99XFxuUmVzdW1pbmcgZnJvbSBkaXNrIHN0YXRlLmAsIFwid2FybmluZ1wiKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBpZiAocy5wYXVzZWQpIHtcbiAgICBjb25zdCByZXN1bWVMb2NrID0gYWNxdWlyZVNlc3Npb25Mb2NrKGJhc2UpO1xuICAgIGlmICghcmVzdW1lTG9jay5hY3F1aXJlZCkge1xuICAgICAgLy8gUmVzZXQgcGF1c2VkIHN0YXRlIHNvIGlzQXV0b1BhdXNlZCgpIGRvZXNuJ3Qgc3RpY2sgdHJ1ZSBhZnRlciBsb2NrIGZhaWx1cmUuXG4gICAgICAvLyBQYXVzZSBmaWxlIGlzIHByZXNlcnZlZCBvbiBkaXNrIGZvciByZXRyeSBcdTIwMTQgbm90IGRlbGV0ZWQuXG4gICAgICBzLnBhdXNlZCA9IGZhbHNlO1xuICAgICAgY3R4LnVpLm5vdGlmeShgQ2Fubm90IHJlc3VtZTogJHtyZXN1bWVMb2NrLnJlYXNvbn1gLCBcImVycm9yXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHMucGF1c2VkID0gZmFsc2U7XG4gICAgcy5hY3RpdmUgPSB0cnVlO1xuICAgIHMudmVyYm9zZSA9IHZlcmJvc2VNb2RlO1xuICAgIHMuc3RlcE1vZGUgPSByZXF1ZXN0ZWRTdGVwTW9kZTtcbiAgICBzLmNtZEN0eCA9IGN0eDtcbiAgICAvLyBBRFItMDE2IHBoYXNlIDIgLyBCMiAoIzU2MjApOiBib290c3RyYXAgYmFzZVBhdGggdHJhbnNpdGlvbiBiZWZvcmVcbiAgICAvLyB0aGUgcmVzdW1lIHBhdGggY29uc3VsdHMgcGVyc2lzdGVkIHdvcmt0cmVlIHN0YXRlLiBEZWZlbnNpdmUgYWJvdXRcbiAgICAvLyBzLm9yaWdpbmFsQmFzZVBhdGggXHUyMDE0IHRoZSBtZXRhLXJlc3RvcmUgYWJvdmUgKGxpbmUgMjAwMyAvIDIwNTUpIG1heVxuICAgIC8vIGhhdmUgYWxyZWFkeSBwb3B1bGF0ZWQgaXQgZnJvbSBwYXVzZWQgbWV0YWRhdGE7IHRoZSB2ZXJiIHByZXNlcnZlc1xuICAgIC8vIHRoYXQgdmFsdWUuXG4gICAgYnVpbGRMaWZlY3ljbGUoKS5hZG9wdFNlc3Npb25Sb290KGJhc2UpO1xuICAgIC8vIFx1MjUwMFx1MjUwMCBSZXN1bWUgd29ya3RyZWU6IGlmIHRoZSBwYXVzZWQgc2Vzc2lvbiB3YXMgaW5zaWRlIGEgbWlsZXN0b25lIHdvcmt0cmVlLFxuICAgIC8vIGFwcGx5IHRoYXQgcGF0aCBhcyB0aGUgZGlzcGF0Y2ggYmFzZVBhdGggaW1tZWRpYXRlbHkgKCMzNzIzKS5cbiAgICAvLyBUaGlzIGVuc3VyZXMgdGhlIGRpc3BhdGNoIGxvb3AgcnVucyBmcm9tIHRoZSB3b3JrdHJlZSBkaXJlY3RvcnkgZXZlbiB3aGVuXG4gICAgLy8gZW50ZXJNaWxlc3RvbmUgZ3VhcmQgY29uZGl0aW9ucyBkaWZmZXIgYmV0d2VlbiB0aGUgb3JpZ2luYWwgYW5kIHJlc3VtZWRcbiAgICAvLyBzZXNzaW9uIChlLmcuIGlzb2xhdGlvbiBtb2RlIGNoYW5nZWQsIGRldGVjdFdvcmt0cmVlTmFtZSBkaWZmZXJzIGFjcm9zc1xuICAgIC8vIHByb2Nlc3MgcmVzdGFydHMpLiAgV2UgZ3VhcmQgd2l0aCBleGlzdHNTeW5jIHNvIGEgc3RhbGUgb3IgZGVsZXRlZFxuICAgIC8vIHdvcmt0cmVlIGRpcmVjdG9yeSBzYWZlbHkgZmFsbHMgYmFjayB0byB0aGUgcHJvamVjdCByb290LlxuICAgIGNvbnN0IHJlc3VtZVdvcmt0cmVlUGF0aCA9IGZyZXNoU3RhcnRBc3Nlc3NtZW50LnBhdXNlZFNlc3Npb24/Lndvcmt0cmVlUGF0aCA/PyBudWxsO1xuICAgIGlmIChyZXN1bWVXb3JrdHJlZVBhdGggJiYgIWV4aXN0c1N5bmMocmVzdW1lV29ya3RyZWVQYXRoKSkge1xuICAgICAgbG9nV2FybmluZyhcbiAgICAgICAgXCJzZXNzaW9uXCIsXG4gICAgICAgIGBXb3JrdHJlZSB3YXMgZXhwZWN0ZWQgYXQgJHtyZXN1bWVXb3JrdHJlZVBhdGh9IGJ1dCBpcyBtaXNzaW5nLiBDb250aW51aW5nIGluIHByb2plY3Qtcm9vdCBtb2RlLiBUbyByZXN0YXJ0IHdpdGggYSBmcmVzaCB3b3JrdHJlZSwgcnVuIC9nc2QtZGVidWcgb3IgcmVjcmVhdGUgdGhlIG1pbGVzdG9uZS5gLFxuICAgICAgICB7IGZpbGU6IFwiYXV0by50c1wiLCBtaWxlc3RvbmVJZDogcy5jdXJyZW50TWlsZXN0b25lSWQgPz8gXCJcIiB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgLy8gQURSLTAxNiBwaGFzZSAyIC8gQjMgKCM1NjIxKTogcGF1c2VkLXJlc3VtZSB3b3JrdHJlZS1wYXRoIGFkb3B0aW9uLlxuICAgIGJ1aWxkTGlmZWN5Y2xlKCkucmVzdW1lRnJvbVBhdXNlZFNlc3Npb24oYmFzZSwgcmVzdW1lV29ya3RyZWVQYXRoKTtcbiAgICAvLyBSZWJ1aWxkIHNjb3BlIG5vdyB0aGF0IHMuYmFzZVBhdGggcmVmbGVjdHMgdGhlIGFjdHVhbCB3b3JrdHJlZSAob3IgcHJvamVjdCByb290KS5cbiAgICByZWJ1aWxkU2NvcGUocy5iYXNlUGF0aCwgcy5jdXJyZW50TWlsZXN0b25lSWQpO1xuICAgIC8vIEVuc3VyZSB0aGUgd29ya2Zsb3ctbG9nZ2VyIGF1ZGl0IGxvZyBpcyBwaW5uZWQgdG8gdGhlIHByb2plY3Qgcm9vdFxuICAgIC8vIGV2ZW4gd2hlbiBhdXRvLW1vZGUgaXMgZW50ZXJlZCB2aWEgYSBwYXRoIHRoYXQgYnlwYXNzZXMgdGhlXG4gICAgLy8gYm9vdHN0cmFwL2R5bmFtaWMtdG9vbHMgZW5zdXJlRGJPcGVuKCkgXHUyMTkyIHNldExvZ0Jhc2VQYXRoKCkgY2hhaW5cbiAgICAvLyAoZS5nLiAvY2xlYXIgcmVzdW1lLCBob3QtcmVsb2FkKS5cbiAgICBzZXRMb2dCYXNlUGF0aChiYXNlKTtcbiAgICBzLnVuaXREaXNwYXRjaENvdW50LmNsZWFyKCk7XG4gICAgcy51bml0TGlmZXRpbWVEaXNwYXRjaGVzLmNsZWFyKCk7XG4gICAgaWYgKCFnZXRMZWRnZXIoKSkgaW5pdE1ldHJpY3MoYmFzZSk7XG4gICAgaWYgKHMuY3VycmVudE1pbGVzdG9uZUlkKSBzZXRBY3RpdmVNaWxlc3RvbmVJZChiYXNlLCBzLmN1cnJlbnRNaWxlc3RvbmVJZCk7XG4gICAgYXdhaXQgb3BlblByb2plY3REYklmUHJlc2VudChiYXNlKTtcbiAgICByZWdpc3RlckF1dG9Xb3JrZXJGb3JTZXNzaW9uKHMsIGJhc2UpO1xuXG4gICAgLy8gUmUtcmVnaXN0ZXIgaGVhbHRoIGxldmVsIG5vdGlmaWNhdGlvbiBjYWxsYmFjayBsb3N0IGFjcm9zcyBwcm9jZXNzIHJlc3RhcnRcbiAgICBzZXRMZXZlbENoYW5nZUNhbGxiYWNrKChfZnJvbSwgdG8sIHN1bW1hcnkpID0+IHtcbiAgICAgIGNvbnN0IGxldmVsID0gdG8gPT09IFwicmVkXCIgPyBcImVycm9yXCIgOiB0byA9PT0gXCJ5ZWxsb3dcIiA/IFwid2FybmluZ1wiIDogXCJpbmZvXCI7XG4gICAgICBjdHgudWkubm90aWZ5KHN1bW1hcnksIGxldmVsIGFzIFwiaW5mb1wiIHwgXCJ3YXJuaW5nXCIgfCBcImVycm9yXCIpO1xuICAgIH0pO1xuXG4gICAgLy8gXHUyNTAwXHUyNTAwIEF1dG8td29ya3RyZWUgLyBicmFuY2gtbW9kZTogcmUtZW50ZXIgb24gcmVzdW1lIFx1MjUwMFx1MjUwMFxuICAgIGlmIChcbiAgICAgIHMuY3VycmVudE1pbGVzdG9uZUlkICYmXG4gICAgICBnZXRJc29sYXRpb25Nb2RlKHMub3JpZ2luYWxCYXNlUGF0aCB8fCBzLmJhc2VQYXRoKSAhPT0gXCJub25lXCIgJiZcbiAgICAgIHMub3JpZ2luYWxCYXNlUGF0aCAmJlxuICAgICAgIWlzSW5BdXRvV29ya3RyZWUocy5iYXNlUGF0aCkgJiZcbiAgICAgICFkZXRlY3RXb3JrdHJlZU5hbWUocy5iYXNlUGF0aCkgJiZcbiAgICAgICFkZXRlY3RXb3JrdHJlZU5hbWUocy5vcmlnaW5hbEJhc2VQYXRoKVxuICAgICkge1xuICAgICAgY29uc3QgZW50ZXJSZXN1bHQgPSBidWlsZExpZmVjeWNsZSgpLmVudGVyTWlsZXN0b25lKHMuY3VycmVudE1pbGVzdG9uZUlkLCB7XG4gICAgICAgIG5vdGlmeTogY3R4LnVpLm5vdGlmeS5iaW5kKGN0eC51aSksXG4gICAgICB9KTtcbiAgICAgIGlmICghZW50ZXJSZXN1bHQub2sgJiYgZW50ZXJSZXN1bHQucmVhc29uID09PSBcImxlYXNlLWNvbmZsaWN0XCIpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgQ2Fubm90IHJlc3VtZSBtaWxlc3RvbmUgJHtzLmN1cnJlbnRNaWxlc3RvbmVJZH06IGxlYXNlIGlzIGhlbGQgYnkgYW5vdGhlciB3b3JrZXIuYCxcbiAgICAgICAgICBcImVycm9yXCIsXG4gICAgICAgICk7XG4gICAgICAgIGF3YWl0IHN0b3BBdXRvKGN0eCwgcGksIFwibGVhc2UtY29uZmxpY3QgZHVyaW5nIHJlc3VtZVwiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgLy8gcy5iYXNlUGF0aCBtYXkgaGF2ZSBiZWVuIHVwZGF0ZWQgdG8gYSB3b3JrdHJlZSBwYXRoIGJ5IGVudGVyTWlsZXN0b25lLlxuICAgICAgcmVidWlsZFNjb3BlKHMuYmFzZVBhdGgsIHMuY3VycmVudE1pbGVzdG9uZUlkKTtcbiAgICB9XG5cbiAgICBlbnN1cmVPcmNoZXN0cmF0aW9uTW9kdWxlKGN0eCwgcGksIHMuYmFzZVBhdGggfHwgYmFzZSk7XG4gICAgcmVnaXN0ZXJTaWd0ZXJtSGFuZGxlcihsb2NrQmFzZSgpKTtcblxuICAgIGN0eC51aS5zZXRTdGF0dXMoXCJnc2QtYXV0b1wiLCBzLnN0ZXBNb2RlID8gXCJuZXh0XCIgOiBcImF1dG9cIik7XG4gICAgY3R4LnVpLnNldFdpZGdldChcImdzZC1oZWFsdGhcIiwgdW5kZWZpbmVkKTtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgcy5zdGVwTW9kZSA/IFwiU3RlcC1tb2RlIHJlc3VtZWQuXCIgOiBcIkF1dG8tbW9kZSByZXN1bWVkLlwiLFxuICAgICAgXCJpbmZvXCIsXG4gICAgKTtcbiAgICByZXN0b3JlSG9va1N0YXRlKHMuYmFzZVBhdGgpO1xuICAgIC8vIFJlLXN5bmMgbWFuYWdlZCByZXNvdXJjZXMgb24gcmVzdW1lIHNvIGxvbmctbGl2ZWQgYXV0byBzZXNzaW9ucyBwaWNrIHVwXG4gICAgLy8gYnVuZGxlZCBleHRlbnNpb24gdXBkYXRlcyBiZWZvcmUgcmVzdW1lLXRpbWUgdmVyaWZpY2F0aW9uL3N0YXRlIGxvZ2ljIHJ1bnMuXG4gICAgLy8gR1NEX1BLR19ST09UIGlzIHNldCBieSBsb2FkZXIudHMgYW5kIHBvaW50cyB0byB0aGUgZ3NkLXBpIHBhY2thZ2Ugcm9vdC5cbiAgICAvLyBUaGUgcmVsYXRpdmUgaW1wb3J0IChcIi4uLy4uLy4uL3Jlc291cmNlLWxvYWRlci5qc1wiKSBvbmx5IHdvcmtzIGZyb20gdGhlIHNvdXJjZVxuICAgIC8vIHRyZWU7IGRlcGxveWVkIGV4dGVuc2lvbnMgbGl2ZSBhdCB+Ly5nc2QvYWdlbnQvZXh0ZW5zaW9ucy9nc2QvIHdoZXJlIHRoZVxuICAgIC8vIHJlbGF0aXZlIHBhdGggcmVzb2x2ZXMgdG8gfi8uZ3NkL2FnZW50L3Jlc291cmNlLWxvYWRlci5qcyB3aGljaCBkb2Vzbid0IGV4aXN0LlxuICAgIC8vIFVzaW5nIEdTRF9QS0dfUk9PVCBjb25zdHJ1Y3RzIGEgY29ycmVjdCBhYnNvbHV0ZSBwYXRoIGluIGJvdGggY29udGV4dHMgKCMzOTQ5KS5cbiAgICBhd2FpdCByZWZyZXNoUmVzdW1lUmVzb3VyY2VzQW5kRGIocy5iYXNlUGF0aCk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHJlYnVpbGRTdGF0ZShzLmJhc2VQYXRoKTtcbiAgICAgIHBpLmV2ZW50cy5lbWl0KENNVVhfQ0hBTk5FTFMuU0lERUJBUiwgeyBhY3Rpb246IFwic3luY1wiIGFzIGNvbnN0LCBwcmVmZXJlbmNlczogbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKHMuYmFzZVBhdGggfHwgdW5kZWZpbmVkKT8ucHJlZmVyZW5jZXMsIHN0YXRlOiBhd2FpdCBkZXJpdmVTdGF0ZShzLmJhc2VQYXRoKSB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInJlc3VtZS1yZWJ1aWxkLXN0YXRlLWZhaWxlZFwiLCB7XG4gICAgICAgIGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSksXG4gICAgICB9KTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcG9ydCA9IGF3YWl0IHJ1bkdTRERvY3RvcihzLmJhc2VQYXRoLCB7IGZpeDogdHJ1ZSB9KTtcbiAgICAgIGlmIChyZXBvcnQuZml4ZXNBcHBsaWVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgUmVzdW1lOiBhcHBsaWVkICR7cmVwb3J0LmZpeGVzQXBwbGllZC5sZW5ndGh9IGZpeChlcykgdG8gc3RhdGUuYCxcbiAgICAgICAgICBcImluZm9cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInJlc3VtZS1kb2N0b3ItZmFpbGVkXCIsIHtcbiAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG5cbiAgICBpZiAocy5wYXVzZWRTZXNzaW9uRmlsZSkge1xuICAgICAgY29uc3QgcmVjb3ZlcnkgPSBzeW50aGVzaXplUGF1c2VkU2Vzc2lvblJlY292ZXJ5KFxuICAgICAgICBzLmJhc2VQYXRoLFxuICAgICAgICBzLmN1cnJlbnRVbml0Py50eXBlID8/IHMucGF1c2VkVW5pdFR5cGUgPz8gXCJ1bmtub3duXCIsXG4gICAgICAgIHMuY3VycmVudFVuaXQ/LmlkID8/IHMucGF1c2VkVW5pdElkID8/IFwidW5rbm93blwiLFxuICAgICAgICBzLnBhdXNlZFNlc3Npb25GaWxlLFxuICAgICAgKTtcbiAgICAgIGlmIChyZWNvdmVyeSAmJiByZWNvdmVyeS50cmFjZS50b29sQ2FsbENvdW50ID4gMCkge1xuICAgICAgICBzLnBlbmRpbmdDcmFzaFJlY292ZXJ5ID0gcmVjb3ZlcnkucHJvbXB0O1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIGBSZWNvdmVyZWQgJHtyZWNvdmVyeS50cmFjZS50b29sQ2FsbENvdW50fSB0b29sIGNhbGxzIGZyb20gcGF1c2VkIHNlc3Npb24uIFJlc3VtaW5nIHdpdGggY29udGV4dC5gLFxuICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcy5wYXVzZWRTZXNzaW9uRmlsZSA9IG51bGw7XG4gICAgfVxuXG4gICAgY2FwdHVyZVByb2plY3RSb290RW52KHMub3JpZ2luYWxCYXNlUGF0aCB8fCBzLmJhc2VQYXRoKTtcbiAgICByZWdpc3RlckF1dG9Xb3JrZXJGb3JTZXNzaW9uKHMpO1xuICAgIHVwZGF0ZVNlc3Npb25Mb2NrKFxuICAgICAgbG9ja0Jhc2UoKSxcbiAgICAgIFwicmVzdW1pbmdcIixcbiAgICAgIHMuY3VycmVudE1pbGVzdG9uZUlkID8/IFwidW5rbm93blwiLFxuICAgICk7XG4gICAgaWYgKHMud29ya2VySWQpIHtcbiAgICAgIHdyaXRlTG9jayhcbiAgICAgICAgbG9ja0Jhc2UoKSxcbiAgICAgICAgXCJyZXN1bWluZ1wiLFxuICAgICAgICBzLmN1cnJlbnRNaWxlc3RvbmVJZCA/PyBcInVua25vd25cIixcbiAgICAgICk7XG4gICAgICBjbGVhclBhdXNlZFNlc3Npb24oXCJwYXVzZWQtc2Vzc2lvbiBEQiBjbGVhbnVwIGZhaWxlZCAocmVzdW1lIGFjdGl2YXRpb24pXCIpO1xuICAgIH1cbiAgICBwaS5ldmVudHMuZW1pdChDTVVYX0NIQU5ORUxTLkxPRywgeyBwcmVmZXJlbmNlczogbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKHMuYmFzZVBhdGggfHwgdW5kZWZpbmVkKT8ucHJlZmVyZW5jZXMsIG1lc3NhZ2U6IHMuc3RlcE1vZGUgPyBcIlN0ZXAtbW9kZSByZXN1bWVkLlwiIDogXCJBdXRvLW1vZGUgcmVzdW1lZC5cIiwgbGV2ZWw6IFwicHJvZ3Jlc3NcIiB9KTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bWVSZXN1bHQgPSBhd2FpdCBzLm9yY2hlc3RyYXRpb24/LnJlc3VtZSgpO1xuICAgICAgaWYgKHJlc3VtZVJlc3VsdD8ua2luZCA9PT0gXCJibG9ja2VkXCIpIHtcbiAgICAgICAgbm90aWZ5UmVzdW1lQmxvY2tlZChjdHgsIHJlc3VtZVJlc3VsdCk7XG4gICAgICAgIGF3YWl0IGNsZWFudXBBZnRlckxvb3BFeGl0KGN0eCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGRlYnVnTG9nKFwicmVzdW1lLW9yY2hlc3RyYXRpb24tcmVzdW1lXCIsIHsgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9KTtcbiAgICB9XG4gICAgc3RhcnRBdXRvQ29tbWFuZFBvbGxpbmcocy5iYXNlUGF0aCk7XG4gICAgYXdhaXQgcnVuQXV0b0xvb3BXaXRoVW9rKHtcbiAgICAgIGN0eCxcbiAgICAgIHBpLFxuICAgICAgcyxcbiAgICAgIGRlcHM6IGJ1aWxkTG9vcERlcHMocGkpLFxuICAgICAgcnVuS2VybmVsTG9vcDogcnVuVW9rS2VybmVsTG9vcCxcbiAgICAgIHJ1bkxlZ2FjeUxvb3A6IHJ1bkxlZ2FjeUF1dG9Mb29wLFxuICAgIH0pO1xuICAgIGF3YWl0IGNsZWFudXBBZnRlckxvb3BFeGl0KGN0eCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEZyZXNoIHN0YXJ0IHBhdGggXHUyMDE0IGRlbGVnYXRlZCB0byBhdXRvLXN0YXJ0LnRzIFx1MjUwMFx1MjUwMFxuICBjb25zdCBib290c3RyYXBEZXBzOiBCb290c3RyYXBEZXBzID0ge1xuICAgIHNob3VsZFVzZVdvcmt0cmVlSXNvbGF0aW9uLFxuICAgIHJlZ2lzdGVyU2lndGVybUhhbmRsZXIsXG4gICAgcmVnaXN0ZXJBdXRvV29ya2VyRm9yU2Vzc2lvbjogKHByb2plY3RSb290KSA9PiByZWdpc3RlckF1dG9Xb3JrZXJGb3JTZXNzaW9uKHMsIHByb2plY3RSb290KSxcbiAgICBsb2NrQmFzZSxcbiAgICBidWlsZExpZmVjeWNsZSxcbiAgfTtcblxuICAvLyBSZWdpc3RlciB0aGUgd29ya2VyIGJlZm9yZSBib290c3RyYXAgZW50ZXJzIGEgbWlsZXN0b25lIHdvcmt0cmVlLlxuICAvLyBUaGlzIGVuc3VyZXMgZW50ZXJNaWxlc3RvbmUgY2FuIGNsYWltIGEgbGVhc2UgYW5kIHNlZWQgZGlzcGF0Y2ggY2xhaW1zXG4gIC8vIGZvciBjcmFzaC1yZWNvdmVyeSBmaWRlbGl0eSAoIzU0MDUpLlxuICByZWdpc3RlckF1dG9Xb3JrZXJGb3JTZXNzaW9uKHMsIGJhc2UpO1xuXG4gIGNvbnN0IHJlYWR5ID0gYXdhaXQgYm9vdHN0cmFwQXV0b1Nlc3Npb24oXG4gICAgcyxcbiAgICBjdHgsXG4gICAgcGksXG4gICAgYmFzZSxcbiAgICB2ZXJib3NlTW9kZSxcbiAgICByZXF1ZXN0ZWRTdGVwTW9kZSxcbiAgICBib290c3RyYXBEZXBzLFxuICAgIGZyZXNoU3RhcnRBc3Nlc3NtZW50LFxuICApO1xuICBpZiAoIXJlYWR5KSByZXR1cm47XG5cbiAgLy8gQnVpbGQgc2NvcGUgYWZ0ZXIgYm9vdHN0cmFwIGhhcyBwb3B1bGF0ZWQgcy5iYXNlUGF0aCAvIHMub3JpZ2luYWxCYXNlUGF0aCAvXG4gIC8vIHMuY3VycmVudE1pbGVzdG9uZUlkIChpbmNsdWRpbmcgd29ya3RyZWUgc2V0dXAgaW5zaWRlIGJvb3RzdHJhcEF1dG9TZXNzaW9uKS5cbiAgcmVidWlsZFNjb3BlKHMuYmFzZVBhdGgsIHMuY3VycmVudE1pbGVzdG9uZUlkKTtcbiAgZW5zdXJlT3JjaGVzdHJhdGlvbk1vZHVsZShjdHgsIHBpLCBzLmJhc2VQYXRoIHx8IGJhc2UpO1xuICBjYXB0dXJlUHJvamVjdFJvb3RFbnYocy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGgpO1xuICByZWdpc3RlckF1dG9Xb3JrZXJGb3JTZXNzaW9uKHMpO1xuICB0cnkge1xuICAgIHBpLmV2ZW50cy5lbWl0KENNVVhfQ0hBTk5FTFMuU0lERUJBUiwgeyBhY3Rpb246IFwic3luY1wiIGFzIGNvbnN0LCBwcmVmZXJlbmNlczogbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKHMuYmFzZVBhdGggfHwgdW5kZWZpbmVkKT8ucHJlZmVyZW5jZXMsIHN0YXRlOiBhd2FpdCBkZXJpdmVTdGF0ZShzLmJhc2VQYXRoKSB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gQmVzdC1lZmZvcnQgb25seSBcdTIwMTQgc2lkZWJhciBzeW5jIG11c3QgbmV2ZXIgYmxvY2sgYXV0by1tb2RlIHN0YXJ0dXBcbiAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBjbXV4IHN5bmMgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLCB7IGZpbGU6IFwiYXV0by50c1wiIH0pO1xuICB9XG4gIHBpLmV2ZW50cy5lbWl0KENNVVhfQ0hBTk5FTFMuTE9HLCB7IHByZWZlcmVuY2VzOiBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMocy5iYXNlUGF0aCB8fCB1bmRlZmluZWQpPy5wcmVmZXJlbmNlcywgbWVzc2FnZTogcmVxdWVzdGVkU3RlcE1vZGUgPyBcIlN0ZXAtbW9kZSBzdGFydGVkLlwiIDogXCJBdXRvLW1vZGUgc3RhcnRlZC5cIiwgbGV2ZWw6IFwicHJvZ3Jlc3NcIiB9KTtcblxuICB0cnkge1xuICAgIGF3YWl0IHMub3JjaGVzdHJhdGlvbj8uc3RhcnQoeyBiYXNlUGF0aDogcy5iYXNlUGF0aCwgdHJpZ2dlcjogXCJhdXRvLWxvb3BcIiB9KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgZGVidWdMb2coXCJzdGFydC1vcmNoZXN0cmF0aW9uLXN0YXJ0XCIsIHsgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSB9KTtcbiAgfVxuXG4gIHN0YXJ0QXV0b0NvbW1hbmRQb2xsaW5nKHMuYmFzZVBhdGgpO1xuXG4gIC8vIERpc3BhdGNoIHRoZSBmaXJzdCB1bml0XG4gIGF3YWl0IHJ1bkF1dG9Mb29wV2l0aFVvayh7XG4gICAgY3R4LFxuICAgIHBpLFxuICAgIHMsXG4gICAgZGVwczogYnVpbGRMb29wRGVwcyhwaSksXG4gICAgcnVuS2VybmVsTG9vcDogcnVuVW9rS2VybmVsTG9vcCxcbiAgICBydW5MZWdhY3lMb29wOiBydW5MZWdhY3lBdXRvTG9vcCxcbiAgfSk7XG4gIGF3YWl0IGNsZWFudXBBZnRlckxvb3BFeGl0KGN0eCk7XG59XG5cbi8vIGRlc2NyaWJlTmV4dFVuaXQgaXMgaW1wb3J0ZWQgZnJvbSBhdXRvLWRhc2hib2FyZC50cyBhbmQgcmUtZXhwb3J0ZWRcbmV4cG9ydCB7IGRlc2NyaWJlTmV4dFVuaXQgfSBmcm9tIFwiLi9hdXRvLWRhc2hib2FyZC5qc1wiO1xuXG4vKiogVGhpbiB3cmFwcGVyOiBkZWxlZ2F0ZXMgdG8gYXV0by1kYXNoYm9hcmQudHMsIHBhc3Npbmcgc3RhdGUgYWNjZXNzb3JzLiAqL1xuZnVuY3Rpb24gdXBkYXRlUHJvZ3Jlc3NXaWRnZXQoXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4gIHN0YXRlOiBHU0RTdGF0ZSxcbik6IHZvaWQge1xuICBjb25zdCBiYWRnZSA9IHMuY3VycmVudFVuaXRSb3V0aW5nPy50aWVyXG4gICAgPyAoeyBsaWdodDogXCJMXCIsIHN0YW5kYXJkOiBcIlNcIiwgaGVhdnk6IFwiSFwiIH1bcy5jdXJyZW50VW5pdFJvdXRpbmcudGllcl0gPz9cbiAgICAgIHVuZGVmaW5lZClcbiAgICA6IHVuZGVmaW5lZDtcbiAgX3VwZGF0ZVByb2dyZXNzV2lkZ2V0KFxuICAgIGN0eCxcbiAgICB1bml0VHlwZSxcbiAgICB1bml0SWQsXG4gICAgc3RhdGUsXG4gICAgd2lkZ2V0U3RhdGVBY2Nlc3NvcnMsXG4gICAgYmFkZ2UsXG4gICk7XG59XG5cbi8qKiBTdGF0ZSBhY2Nlc3NvcnMgZm9yIHRoZSB3aWRnZXQgXHUyMDE0IGNsb3N1cmVzIG92ZXIgbW9kdWxlIGdsb2JhbHMuICovXG5jb25zdCB3aWRnZXRTdGF0ZUFjY2Vzc29yczogV2lkZ2V0U3RhdGVBY2Nlc3NvcnMgPSB7XG4gIGdldEF1dG9TdGFydFRpbWU6ICgpID0+IHMuYXV0b1N0YXJ0VGltZSxcbiAgaXNTdGVwTW9kZTogKCkgPT4gcy5zdGVwTW9kZSxcbiAgZ2V0Q21kQ3R4OiAoKSA9PiBzLmNtZEN0eCxcbiAgZ2V0QmFzZVBhdGg6ICgpID0+IHMuYmFzZVBhdGgsXG4gIGlzVmVyYm9zZTogKCkgPT4gcy52ZXJib3NlLFxuICBpc1Nlc3Npb25Td2l0Y2hpbmc6IGlzU2Vzc2lvblN3aXRjaEluRmxpZ2h0LFxuICBnZXRDdXJyZW50RGlzcGF0Y2hlZE1vZGVsSWQ6ICgpID0+IHMuY3VycmVudERpc3BhdGNoZWRNb2RlbElkLFxufTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFByZWNvbmRpdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogRW5zdXJlIGRpcmVjdG9yaWVzLCBicmFuY2hlcywgYW5kIG90aGVyIHByZXJlcXVpc2l0ZXMgZXhpc3QgYmVmb3JlXG4gKiBkaXNwYXRjaGluZyBhIHVuaXQuIFRoZSBMTE0gc2hvdWxkIG5ldmVyIG5lZWQgdG8gbWtkaXIgb3IgZ2l0IGNoZWNrb3V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW5zdXJlUHJlY29uZGl0aW9ucyhcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4gIGJhc2U6IHN0cmluZyxcbiAgc3RhdGU6IEdTRFN0YXRlLFxuKTogdm9pZCB7XG4gIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQgfSA9IHBhcnNlVW5pdElkKHVuaXRJZCk7XG5cbiAgY29uc3QgbURpciA9IHJlc29sdmVNaWxlc3RvbmVQYXRoKGJhc2UsIG1pZCk7XG4gIGlmICghbURpcikge1xuICAgIC8vIEZpeCAjNDk5NjogV2hlbiBkaXNwYXRjaGluZyBhIHNsaWNlIHVuaXQgYWdhaW5zdCBhbiB1bnJlY29nbmlzZWQgbWlsZXN0b25lLFxuICAgIC8vIG9ubHkgY3JlYXRlIHRoZSBkaXJlY3RvcnkgaWYgdGhlIG1pbGVzdG9uZSBoYXMgYSBEQiByb3cuXG4gICAgLy8gV2l0aG91dCB0aGlzIGd1YXJkLCBmb3J3YXJkLXJlZmVyZW5jZWQgdW5pdCBJRHMgKGUuZy4gZnJvbSBSRVFVSVJFTUVOVFMubWQpXG4gICAgLy8gc2lsZW50bHkgc2NhZmZvbGQgZW1wdHkgc3R1YiBkaXJlY3RvcmllcyB0aGF0IGxhdGVyIHNrZXcgbmV4dE1pbGVzdG9uZUlkLlxuICAgIGlmIChzaWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgaGFzRGJSb3cgPSBpc0RiQXZhaWxhYmxlKCkgJiYgZ2V0TWlsZXN0b25lKG1pZCkgIT0gbnVsbDtcbiAgICAgIGlmICghaGFzRGJSb3cpIHtcbiAgICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgZW5zdXJlUHJlY29uZGl0aW9uczogc2tpcHBpbmcgbWtkaXIgZm9yIHVucmVjb2duaXNlZCBtaWxlc3RvbmUgJHttaWR9IHJlZmVyZW5jZWQgYnkgc2xpY2UgdW5pdCAke3VuaXRJZH0gXHUyMDE0IG5vIERCIHJvdyBleGlzdHNgLCB7IGZpbGU6IFwiYXV0by50c1wiIH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IG5ld0RpciA9IGpvaW4obWlsZXN0b25lc0RpcihiYXNlKSwgbWlkKTtcbiAgICBta2RpclN5bmMoam9pbihuZXdEaXIsIFwic2xpY2VzXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxuXG4gIGlmIChzaWQgIT09IHVuZGVmaW5lZCkge1xuXG4gICAgY29uc3QgbURpclJlc29sdmVkID0gcmVzb2x2ZU1pbGVzdG9uZVBhdGgoYmFzZSwgbWlkKTtcbiAgICBpZiAobURpclJlc29sdmVkKSB7XG4gICAgICBjb25zdCBzbGljZXNEaXIgPSBqb2luKG1EaXJSZXNvbHZlZCwgXCJzbGljZXNcIik7XG4gICAgICBjb25zdCBzRGlyID0gcmVzb2x2ZURpcihzbGljZXNEaXIsIHNpZCk7XG4gICAgICBpZiAoIXNEaXIpIHtcbiAgICAgICAgbWtkaXJTeW5jKGpvaW4oc2xpY2VzRGlyLCBzaWQsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVzb2x2ZWRTbGljZURpciA9IHJlc29sdmVEaXIoc2xpY2VzRGlyLCBzaWQpID8/IHNpZDtcbiAgICAgIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZXNEaXIsIHJlc29sdmVkU2xpY2VEaXIsIFwidGFza3NcIik7XG4gICAgICBpZiAoIWV4aXN0c1N5bmModGFza3NEaXIpKSB7XG4gICAgICAgIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNwYXRjaEhvb2tVbml0KFxuICBjdHg6IEV4dGVuc2lvbkNvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGhvb2tOYW1lOiBzdHJpbmcsXG4gIHRyaWdnZXJVbml0VHlwZTogc3RyaW5nLFxuICB0cmlnZ2VyVW5pdElkOiBzdHJpbmcsXG4gIGhvb2tQcm9tcHQ6IHN0cmluZyxcbiAgaG9va01vZGVsOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHRhcmdldEJhc2VQYXRoOiBzdHJpbmcsXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3Qgd2FzQWN0aXZlID0gcy5hY3RpdmU7XG4gIGNvbnN0IHByZXZpb3VzQmFzZVBhdGggPSBzLmJhc2VQYXRoO1xuICBjb25zdCBwcmV2aW91c0N1cnJlbnRVbml0ID0gcy5jdXJyZW50VW5pdCA/IHsgLi4ucy5jdXJyZW50VW5pdCB9IDogbnVsbDtcblxuICBpZiAoIXMuYWN0aXZlKSB7XG4gICAgcy5hY3RpdmUgPSB0cnVlO1xuICAgIHMuc3RlcE1vZGUgPSB0cnVlO1xuICAgIHMuY21kQ3R4ID0gY3R4IGFzIEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0O1xuICAgIHMuYXV0b1N0YXJ0VGltZSA9IERhdGUubm93KCk7XG4gICAgcy5jdXJyZW50VW5pdCA9IG51bGw7XG4gICAgcy5wZW5kaW5nUXVpY2tUYXNrcyA9IFtdO1xuICB9XG5cbiAgLy8gQURSLTAxNiBwaGFzZSAyIC8gQjIgKCM1NjIwKTogaG9vay10cmlnZ2VyIGJhc2VQYXRoIHRyYW5zaXRpb24uIFRyZWF0c1xuICAvLyB0aGUgdHJpZ2dlciBhcyBhIGJvb3RzdHJhcCB2YXJpYW50IFx1MjAxNCBpZiB0aGUgc2Vzc2lvbiBpcyBmcmVzaCxcbiAgLy8gYG9yaWdpbmFsQmFzZVBhdGhgIGdldHMgc2V0IHRvIGB0YXJnZXRCYXNlUGF0aGA7IGlmIHRoZSBzZXNzaW9uIHdhc1xuICAvLyBhbHJlYWR5IGFjdGl2ZSB3aXRoIGFuIGVzdGFibGlzaGVkIGBvcmlnaW5hbEJhc2VQYXRoYCwgdGhlIHZlcmJcbiAgLy8gcHJlc2VydmVzIGl0LlxuICBidWlsZExpZmVjeWNsZSgpLmFkb3B0U2Vzc2lvblJvb3QodGFyZ2V0QmFzZVBhdGgpO1xuICBpZiAoIXMub3JjaGVzdHJhdGlvbikge1xuICAgIGVuc3VyZU9yY2hlc3RyYXRpb25Nb2R1bGUoY3R4LCBwaSwgcy5iYXNlUGF0aCk7XG4gIH1cblxuICBjb25zdCBob29rVW5pdFR5cGUgPSBgaG9vay8ke2hvb2tOYW1lfWA7XG4gIGNvbnN0IGhvb2tTdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuXG4gIHMuY3VycmVudFVuaXQgPSB7XG4gICAgdHlwZTogdHJpZ2dlclVuaXRUeXBlLFxuICAgIGlkOiB0cmlnZ2VyVW5pdElkLFxuICAgIHN0YXJ0ZWRBdDogaG9va1N0YXJ0ZWRBdCxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBzLmNtZEN0eCEubmV3U2Vzc2lvbih7IHdvcmtzcGFjZVJvb3Q6IHMuYmFzZVBhdGggfSk7XG4gIGlmIChyZXN1bHQuY2FuY2VsbGVkKSB7XG4gICAgYXdhaXQgc3RvcEF1dG8oY3R4LCBwaSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcy5jdXJyZW50VW5pdCA9IHtcbiAgICB0eXBlOiBob29rVW5pdFR5cGUsXG4gICAgaWQ6IHRyaWdnZXJVbml0SWQsXG4gICAgc3RhcnRlZEF0OiBob29rU3RhcnRlZEF0LFxuICB9O1xuXG4gIGlmIChob29rTW9kZWwpIHtcbiAgICBjb25zdCBhdmFpbGFibGVNb2RlbHMgPSBjdHgubW9kZWxSZWdpc3RyeS5nZXRBdmFpbGFibGUoKTtcbiAgICBjb25zdCBtYXRjaCA9IHJlc29sdmVNb2RlbElkKGhvb2tNb2RlbCwgYXZhaWxhYmxlTW9kZWxzLCBjdHgubW9kZWw/LnByb3ZpZGVyKTtcbiAgICBpZiAobWF0Y2gpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHBpLnNldE1vZGVsKG1hdGNoKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAvKiBub24tZmF0YWwgKi9cbiAgICAgICAgbG9nV2FybmluZyhcImRpc3BhdGNoXCIsIGBob29rIG1vZGVsIHNldCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsIHsgZmlsZTogXCJhdXRvLnRzXCIgfSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBIb29rIG1vZGVsIFwiJHtob29rTW9kZWx9XCIgbm90IGZvdW5kIGluIGF2YWlsYWJsZSBtb2RlbHMuIEZhbGxpbmcgYmFjayB0byBjdXJyZW50IHNlc3Npb24gbW9kZWwuIGAgK1xuICAgICAgICBgRW5zdXJlIHRoZSBtb2RlbCBpcyBkZWZpbmVkIGluIG1vZGVscy5qc29uIGFuZCBoYXMgYXV0aCBjb25maWd1cmVkLmAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBzZXNzaW9uRmlsZSA9IG5vcm1hbGl6ZVNlc3Npb25GaWxlUGF0aChjdHguc2Vzc2lvbk1hbmFnZXIuZ2V0U2Vzc2lvbkZpbGUoKSk7XG4gIHdyaXRlTG9jayhcbiAgICBsb2NrQmFzZSgpLFxuICAgIGhvb2tVbml0VHlwZSxcbiAgICB0cmlnZ2VyVW5pdElkLFxuICAgIHNlc3Npb25GaWxlID8/IHVuZGVmaW5lZCxcbiAgKTtcblxuICBjbGVhclVuaXRUaW1lb3V0KCk7XG4gIGNvbnN0IHN1cGVydmlzb3IgPSByZXNvbHZlQXV0b1N1cGVydmlzb3JDb25maWcoKTtcbiAgY29uc3QgaG9va0hhcmRUaW1lb3V0TXMgPSAoc3VwZXJ2aXNvci5oYXJkX3RpbWVvdXRfbWludXRlcyA/PyAzMCkgKiA2MCAqIDEwMDA7XG4gIHMudW5pdFRpbWVvdXRIYW5kbGUgPSBzZXRUaW1lb3V0KGFzeW5jICgpID0+IHtcbiAgICBzLnVuaXRUaW1lb3V0SGFuZGxlID0gbnVsbDtcbiAgICBpZiAoIXMuYWN0aXZlKSByZXR1cm47XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBIb29rICR7aG9va05hbWV9IGV4Y2VlZGVkICR7c3VwZXJ2aXNvci5oYXJkX3RpbWVvdXRfbWludXRlcyA/PyAzMH1taW4gdGltZW91dC4gUGF1c2luZyBhdXRvLW1vZGUuYCxcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG4gICAgcmVzZXRIb29rU3RhdGUoKTtcbiAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gIH0sIGhvb2tIYXJkVGltZW91dE1zKTtcblxuICBjdHgudWkuc2V0U3RhdHVzKFwiZ3NkLWF1dG9cIiwgcy5zdGVwTW9kZSA/IFwibmV4dFwiIDogXCJhdXRvXCIpO1xuICBjdHgudWkubm90aWZ5KGBSdW5uaW5nIHBvc3QtdW5pdCBob29rOiAke2hvb2tOYW1lfWAsIFwiaW5mb1wiKTtcblxuICBkZWJ1Z0xvZyhcImRpc3BhdGNoSG9va1VuaXRcIiwge1xuICAgIHBoYXNlOiBcInNlbmQtbWVzc2FnZVwiLFxuICAgIHByb21wdExlbmd0aDogaG9va1Byb21wdC5sZW5ndGgsXG4gIH0pO1xuICBwaS5zZW5kTWVzc2FnZShcbiAgICB7IGN1c3RvbVR5cGU6IFwiZ3NkLWF1dG9cIiwgY29udGVudDogaG9va1Byb21wdCwgZGlzcGxheTogdHJ1ZSB9LFxuICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgKTtcblxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gUmUtZXhwb3J0IHJlY292ZXJ5IGZ1bmN0aW9ucyBmb3IgZXh0ZXJuYWwgY29uc3VtZXJzXG5leHBvcnQge1xuICBidWlsZExvb3BSZW1lZGlhdGlvblN0ZXBzLFxufSBmcm9tIFwiLi9hdXRvLXJlY292ZXJ5LmpzXCI7XG5leHBvcnQgeyByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGggfSBmcm9tIFwiLi9hdXRvLWFydGlmYWN0LXBhdGhzLmpzXCI7XG4iXSwKICAibWFwcGluZ3MiOiAiQUFxQkEsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyxtQkFBbUI7QUFF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UztBQUFBLElBQ1Q7QUFBQSxJQUNBO0FBQUEsSUFDQSxlQUFlO0FBQUEsRUFDakI7QUFFQSxtQkFBaUI7QUFDakIsUUFBTSxhQUFhLDRCQUE0QjtBQUMvQyxRQUFNLHFCQUFxQixXQUFXLHdCQUF3QixNQUFNLEtBQUs7QUFDekUsSUFBRSxvQkFBb0IsV0FBVyxZQUFZO0FBQzNDLE1BQUUsb0JBQW9CO0FBQ3RCLFFBQUksQ0FBQyxFQUFFLE9BQVE7QUFDZixRQUFJLEdBQUc7QUFBQSxNQUNMLFFBQVEsUUFBUSxhQUFhLFdBQVcsd0JBQXdCLEVBQUU7QUFBQSxNQUNsRTtBQUFBLElBQ0Y7QUFDQSxtQkFBZTtBQUNmLFVBQU0sVUFBVSxLQUFLLEVBQUU7QUFBQSxFQUN6QixHQUFHLGlCQUFpQjtBQUVwQixNQUFJLEdBQUcsVUFBVSxZQUFZLEVBQUUsV0FBVyxTQUFTLE1BQU07QUFDekQsTUFBSSxHQUFHLE9BQU8sMkJBQTJCLFFBQVEsSUFBSSxNQUFNO0FBRTNELFdBQVMsb0JBQW9CO0FBQUEsSUFDM0IsT0FBTztBQUFBLElBQ1AsY0FBYyxXQUFXO0FBQUEsRUFDM0IsQ0FBQztBQUNELEtBQUc7QUFBQSxJQUNELEVBQUUsWUFBWSxZQUFZLFNBQVMsWUFBWSxTQUFTLEtBQUs7QUFBQSxJQUM3RCxFQUFFLGFBQWEsS0FBSztBQUFBLEVBQ3RCO0FBRUEsU0FBTztBQUNUO0FBR0E7QUFBQSxFQUNFLDZCQUFBQztBQUFBLE9BQ0s7QUFDUCxTQUFTLG1DQUFtQzsiLAogICJuYW1lcyI6IFsiU1RVQl9SRUNPVkVSWV9USFJFU0hPTEQiLCAiTkVXX1NFU1NJT05fVElNRU9VVF9NUyIsICJnZXRCdWRnZXRBbGVydExldmVsIiwgImdldE5ld0J1ZGdldEFsZXJ0TGV2ZWwiLCAiZ2V0QnVkZ2V0RW5mb3JjZW1lbnRBY3Rpb24iLCAiYnVpbGRMb29wUmVtZWRpYXRpb25TdGVwcyJdCn0K
