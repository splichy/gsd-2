import { resolveWorktreeProjectRoot } from "../worktree-root.js";
import { normalizeRealPath } from "../paths.js";
const STUB_RECOVERY_THRESHOLD = 2;
const NEW_SESSION_TIMEOUT_MS = 12e4;
class AutoSession {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  active = false;
  paused = false;
  completionStopInProgress = false;
  stepMode = false;
  verbose = false;
  activeEngineId = null;
  activeRunDir = null;
  cmdCtx = null;
  // ── Paths ────────────────────────────────────────────────────────────────
  basePath = "";
  originalBasePath = "";
  // TODO(C8): remove basePath/originalBasePath once all readers use s.scope
  scope = null;
  // ── Coordination identity (Phase B — DB-backed coordination) ────────────
  /**
   * Worker registry ID set by registerAutoWorker() at session start. Used by
   * heartbeatAutoWorker() each loop iteration and by recordDispatchClaim()
   * to fence dispatch ledger writes against stale workers.
   */
  workerId = null;
  /**
   * Active milestone lease fencing token, set by claimMilestoneLease() inside
   * WorktreeLifecycle.enterMilestone(). Threaded into recordDispatchClaim()
   * as milestone_lease_token so out-of-band dispatches by a stale worker
   * are detectable.
   */
  milestoneLeaseToken = null;
  previousProjectRootEnv = null;
  hadProjectRootEnv = false;
  projectRootEnvCaptured = false;
  previousMilestoneLockEnv = null;
  hadMilestoneLockEnv = false;
  milestoneLockEnvCaptured = false;
  sessionMilestoneLock = null;
  gitService = null;
  // ── Dispatch counters ────────────────────────────────────────────────────
  unitDispatchCount = /* @__PURE__ */ new Map();
  unitLifetimeDispatches = /* @__PURE__ */ new Map();
  unitRecoveryCount = /* @__PURE__ */ new Map();
  // ── Timers ───────────────────────────────────────────────────────────────
  unitTimeoutHandle = null;
  wrapupWarningHandle = null;
  idleWatchdogHandle = null;
  continueHereHandle = null;
  // ── Current unit ─────────────────────────────────────────────────────────
  currentUnit = null;
  currentTraceId = null;
  currentTurnId = null;
  currentUnitRouting = null;
  currentMilestoneId = null;
  // ── Model state ──────────────────────────────────────────────────────────
  autoModeStartModel = null;
  /** Explicit /gsd model pin captured at bootstrap (session-scoped policy override). */
  manualSessionModelOverride = null;
  currentUnitModel = null;
  /** Fully-qualified model ID (provider/id) set after selectAndApplyModel + hook overrides (#2899). */
  currentDispatchedModelId = null;
  originalModelId = null;
  originalModelProvider = null;
  autoModeStartThinkingLevel = null;
  originalThinkingLevel = null;
  lastBudgetAlertLevel = 0;
  // ── Recovery ─────────────────────────────────────────────────────────────
  pendingCrashRecovery = null;
  pendingVerificationRetry = null;
  verificationRetryCount = /* @__PURE__ */ new Map();
  verificationRetryFailureHashes = /* @__PURE__ */ new Map();
  pausedSessionFile = null;
  pausedUnitType = null;
  pausedUnitId = null;
  resourceVersionOnStart = null;
  lastStateRebuildAt = 0;
  // ── Sidecar queue ─────────────────────────────────────────────────────
  sidecarQueue = [];
  // ── Pre-exec gate failure context (#4551) ───────────────────────────
  /**
   * Persisted when a pre-execution gate fails on a plan-slice or refine-slice
   * unit. The planning → plan-slice dispatch rule reads this field and injects
   * the failure details into the next re-dispatch prompt so the LLM can fix the
   * specific issues instead of producing an identical plan.
   *
   * Cleared after it has been consumed (injected into the prompt) to avoid
   * stale context bleeding into unrelated slices.
   */
  lastPreExecFailure = null;
  /**
   * Tracks how many consecutive times each slice unit has failed pre-execution
   * checks. Keyed by unitId (e.g. "M001/S01"). Used to break the infinite
   * plan-slice → pre-exec fail → re-dispatch loop when the planner cannot fix
   * the issues after MAX_PRE_EXEC_RETRIES re-attempts.
   */
  preExecRetryCount = /* @__PURE__ */ new Map();
  // ── Tool invocation errors (#2883) ──────────────────────────────────
  /** Set when a GSD tool execution ends with isError due to malformed/truncated
   *  JSON arguments. Checked by postUnitPreVerification to break retry loops. */
  lastToolInvocationError = null;
  /** Agent-end messages from the just-finished unit, consumed during finalize. */
  lastUnitAgentEndMessages = null;
  /** Set when turn-level git action fails during closeout. */
  lastGitActionFailure = null;
  /** Last turn-level git action status captured during finalize. */
  lastGitActionStatus = null;
  // ── Isolation degradation ────────────────────────────────────────────
  /** Set to true when worktree creation fails; prevents merge of nonexistent branch. */
  isolationDegraded = false;
  // ── Merge guard ──────────────────────────────────────────────────────
  /** Set to true after phases.ts successfully calls mergeAndExit, so that
   *  stopAuto does not attempt the same merge a second time (#2645). */
  milestoneMergedInPhases = false;
  // #4765 — slice-cadence collapse: main-branch SHAs at the moment each
  // milestone's first slice merge began. Used by resquashMilestoneOnMain at
  // milestone completion to collapse N slice commits into one. Cleared when
  // the milestone finishes (or resquash runs).
  milestoneStartShas = /* @__PURE__ */ new Map();
  // ── Dispatch circuit breakers ──────────────────────────────────────
  rewriteAttemptCount = 0;
  /** Tracks consecutive bootstrap attempts that found phase === "complete".
   *  Moved from module-level to per-session so s.reset() clears it (#1348). */
  consecutiveCompleteBootstraps = 0;
  // ── Metrics ──────────────────────────────────────────────────────────────
  autoStartTime = 0;
  lastPromptCharCount;
  lastBaselineCharCount;
  pendingQuickTasks = [];
  /** Timestamp of the last LLM request dispatch (ms since epoch). Used for proactive rate limiting. */
  lastRequestTimestamp = 0;
  // ── Safety harness ───────────────────────────────────────────────────────
  /** SHA of the pre-unit git checkpoint ref. Cleared on success or rollback. */
  checkpointSha = null;
  // ── Signal handler ───────────────────────────────────────────────────────
  sigtermHandler = null;
  // ── Remote command polling ───────────────────────────────────────────────
  /** Cleanup function returned by startCommandPolling(); null when not running. */
  commandPollingCleanup = null;
  // ── Orchestration seam ───────────────────────────────────────────────────
  orchestration = null;
  // ── Loop promise state ──────────────────────────────────────────────────
  // Per-unit resolve function and session-switch guard live at module level
  // in auto-loop.ts (_currentResolve, _sessionSwitchInFlight).
  // ── Methods ──────────────────────────────────────────────────────────────
  clearTimers() {
    if (this.unitTimeoutHandle) {
      clearTimeout(this.unitTimeoutHandle);
      this.unitTimeoutHandle = null;
    }
    if (this.wrapupWarningHandle) {
      clearTimeout(this.wrapupWarningHandle);
      this.wrapupWarningHandle = null;
    }
    if (this.idleWatchdogHandle) {
      clearInterval(this.idleWatchdogHandle);
      this.idleWatchdogHandle = null;
    }
    if (this.continueHereHandle) {
      clearInterval(this.continueHereHandle);
      this.continueHereHandle = null;
    }
  }
  resetDispatchCounters() {
    this.unitDispatchCount.clear();
    this.unitLifetimeDispatches.clear();
  }
  get lockBasePath() {
    return resolveWorktreeProjectRoot(this.basePath, this.originalBasePath);
  }
  /**
   * Canonical project root for state-derivation reads AND writer paths.
   *
   * Prefers the realpath-normalized projectRoot from the MilestoneScope
   * (introduced by PR #5236), falling back to resolveWorktreeProjectRoot
   * during early lifecycle / engine-bypass paths where scope may be null.
   *
   * Always realpath-normalized so cache keys (e.g. deriveState's _stateCache)
   * cannot drift across worktree↔project-root path-string variants for the
   * same filesystem location.
   */
  get canonicalProjectRoot() {
    const root = this.scope?.workspace.projectRoot ?? resolveWorktreeProjectRoot(this.basePath, this.originalBasePath);
    return normalizeRealPath(root);
  }
  reset() {
    this.clearTimers();
    this.active = false;
    this.paused = false;
    this.completionStopInProgress = false;
    this.stepMode = false;
    this.verbose = false;
    this.activeEngineId = null;
    this.activeRunDir = null;
    this.cmdCtx = null;
    this.basePath = "";
    this.originalBasePath = "";
    this.scope = null;
    this.workerId = null;
    this.milestoneLeaseToken = null;
    this.previousProjectRootEnv = null;
    this.hadProjectRootEnv = false;
    this.projectRootEnvCaptured = false;
    this.previousMilestoneLockEnv = null;
    this.hadMilestoneLockEnv = false;
    this.milestoneLockEnvCaptured = false;
    this.sessionMilestoneLock = null;
    this.gitService = null;
    this.unitDispatchCount.clear();
    this.unitLifetimeDispatches.clear();
    this.unitRecoveryCount.clear();
    this.currentUnit = null;
    this.currentTraceId = null;
    this.currentTurnId = null;
    this.currentUnitRouting = null;
    this.currentMilestoneId = null;
    this.autoModeStartModel = null;
    this.manualSessionModelOverride = null;
    this.currentUnitModel = null;
    this.currentDispatchedModelId = null;
    this.originalModelId = null;
    this.originalModelProvider = null;
    this.autoModeStartThinkingLevel = null;
    this.originalThinkingLevel = null;
    this.lastBudgetAlertLevel = 0;
    this.pendingCrashRecovery = null;
    this.pendingVerificationRetry = null;
    this.verificationRetryCount.clear();
    this.verificationRetryFailureHashes.clear();
    this.pausedSessionFile = null;
    this.pausedUnitType = null;
    this.pausedUnitId = null;
    this.resourceVersionOnStart = null;
    this.lastStateRebuildAt = 0;
    this.autoStartTime = 0;
    this.lastPromptCharCount = void 0;
    this.lastBaselineCharCount = void 0;
    this.pendingQuickTasks = [];
    this.lastRequestTimestamp = 0;
    this.sidecarQueue = [];
    this.rewriteAttemptCount = 0;
    this.consecutiveCompleteBootstraps = 0;
    this.lastPreExecFailure = null;
    this.preExecRetryCount.clear();
    this.lastToolInvocationError = null;
    this.lastUnitAgentEndMessages = null;
    this.lastGitActionFailure = null;
    this.lastGitActionStatus = null;
    this.isolationDegraded = false;
    this.milestoneMergedInPhases = false;
    this.milestoneStartShas = /* @__PURE__ */ new Map();
    this.checkpointSha = null;
    this.sigtermHandler = null;
    this.commandPollingCleanup = null;
    this.orchestration = null;
  }
  resetAfterStop(options = {}) {
    const completionStopInProgress = options.preserveCompletionSurface ? this.completionStopInProgress : false;
    this.reset();
    this.completionStopInProgress = completionStopInProgress;
  }
  toJSON() {
    const orchestrationStatus = this.orchestration?.getStatus();
    return {
      active: this.active,
      paused: this.paused,
      stepMode: this.stepMode,
      basePath: this.basePath,
      activeEngineId: this.activeEngineId,
      activeRunDir: this.activeRunDir,
      currentMilestoneId: this.currentMilestoneId,
      currentUnit: this.currentUnit,
      orchestrationPhase: orchestrationStatus?.phase,
      orchestrationTransitionCount: orchestrationStatus?.transitionCount,
      orchestrationLastTransitionAt: orchestrationStatus?.lastTransitionAt,
      unitDispatchCount: Object.fromEntries(this.unitDispatchCount)
    };
  }
}
export {
  AutoSession,
  NEW_SESSION_TIMEOUT_MS,
  STUB_RECOVERY_THRESHOLD
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvL3Nlc3Npb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogQXV0b1Nlc3Npb24gXHUyMDE0IGVuY2Fwc3VsYXRlcyBhbGwgbXV0YWJsZSBhdXRvLW1vZGUgc3RhdGUgaW50byBhIHNpbmdsZSBpbnN0YW5jZS5cbiAqXG4gKiBSZXBsYWNlcyB+NDAgbW9kdWxlLWxldmVsIHZhcmlhYmxlcyBzY2F0dGVyZWQgYWNyb3NzIGF1dG8udHMgd2l0aCB0eXBlZFxuICogcHJvcGVydGllcyBvbiBhIGNsYXNzIGluc3RhbmNlLiBCZW5lZml0czpcbiAqXG4gKiAtIHJlc2V0KCkgY2xlYXJzIGV2ZXJ5dGhpbmcgaW4gb25lIGNhbGwgKHdhcyAyNSsgbWFudWFsIHJlc2V0cyBpbiBzdG9wQXV0bylcbiAqIC0gdG9KU09OKCkgcHJvdmlkZXMgZGlhZ25vc3RpYyBzbmFwc2hvdHNcbiAqIC0gZ3JlcCBgcy5gIHNob3dzIGV2ZXJ5IHN0YXRlIGFjY2Vzc1xuICogLSBDb25zdHJ1Y3RhYmxlIGZvciB0ZXN0aW5nXG4gKlxuICogTUFJTlRFTkFOQ0UgUlVMRTogQWxsIG5ldyBtdXRhYmxlIGF1dG8tbW9kZSBzdGF0ZSBNVVNUIGJlIGFkZGVkIGhlcmUgYXMgYVxuICogY2xhc3MgcHJvcGVydHksIG5vdCBhcyBhIG1vZHVsZS1sZXZlbCB2YXJpYWJsZSBpbiBhdXRvLnRzLiBJZiB0aGUgc3RhdGVcbiAqIG5lZWRzIGNsZWFyaW5nIG9uIHN0b3AsIGFkZCBpdCB0byByZXNldCgpLiBUZXN0cyBpblxuICogYXV0by1zZXNzaW9uLWVuY2Fwc3VsYXRpb24udGVzdC50cyBlbmZvcmNlIHRoYXQgYXV0by50cyBoYXMgbm8gbW9kdWxlLWxldmVsXG4gKiBgbGV0YCBvciBgdmFyYCBkZWNsYXJhdGlvbnMuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBBcGksIE1vZGVsIH0gZnJvbSBcIkBnc2QvcGktYWlcIjtcbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJLCBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHR5cGUgeyBHaXRTZXJ2aWNlSW1wbCB9IGZyb20gXCIuLi9naXQtc2VydmljZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBDYXB0dXJlRW50cnkgfSBmcm9tIFwiLi4vY2FwdHVyZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgQnVkZ2V0QWxlcnRMZXZlbCB9IGZyb20gXCIuLi9hdXRvLWJ1ZGdldC5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBdXRvT3JjaGVzdHJhdGlvbk1vZHVsZSB9IGZyb20gXCIuL2NvbnRyYWN0cy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QgfSBmcm9tIFwiLi4vd29ya3RyZWUtcm9vdC5qc1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplUmVhbFBhdGggfSBmcm9tIFwiLi4vcGF0aHMuanNcIjtcbmltcG9ydCB0eXBlIHsgTWlsZXN0b25lU2NvcGUgfSBmcm9tIFwiLi4vd29ya3NwYWNlLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBFeHBvcnRlZCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBDdXJyZW50VW5pdCB7XG4gIHR5cGU6IHN0cmluZztcbiAgaWQ6IHN0cmluZztcbiAgc3RhcnRlZEF0OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVW5pdFJvdXRpbmcge1xuICB0aWVyOiBzdHJpbmc7XG4gIG1vZGVsRG93bmdyYWRlZDogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTdGFydE1vZGVsIHtcbiAgcHJvdmlkZXI6IHN0cmluZztcbiAgaWQ6IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgVGhpbmtpbmdMZXZlbFNuYXBzaG90ID0gUmV0dXJuVHlwZTxFeHRlbnNpb25BUElbXCJnZXRUaGlua2luZ0xldmVsXCJdPjtcblxuZXhwb3J0IGludGVyZmFjZSBQZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnkge1xuICB1bml0SWQ6IHN0cmluZztcbiAgZmFpbHVyZUNvbnRleHQ6IHN0cmluZztcbiAgYXR0ZW1wdDogbnVtYmVyO1xufVxuXG4vKipcbiAqIEEgdHlwZWQgaXRlbSBlbnF1ZXVlZCBieSBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb24gZm9yIHRoZSBtYWluIGxvb3AgdG9cbiAqIGRyYWluIHZpYSB0aGUgc3RhbmRhcmQgcnVuVW5pdCBwYXRoLiBSZXBsYWNlcyBpbmxpbmUgZGlzcGF0Y2hcbiAqIChwaS5zZW5kTWVzc2FnZSAvIHMuY21kQ3R4Lm5ld1Nlc3Npb24oKSkgZm9yIGhvb2tzLCB0cmlhZ2UsIGFuZCBxdWljay10YXNrcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBTaWRlY2FySXRlbSB7XG4gIGtpbmQ6IFwiaG9va1wiIHwgXCJ0cmlhZ2VcIiB8IFwicXVpY2stdGFza1wiO1xuICB1bml0VHlwZTogc3RyaW5nO1xuICB1bml0SWQ6IHN0cmluZztcbiAgcHJvbXB0OiBzdHJpbmc7XG4gIC8qKiBNb2RlbCBvdmVycmlkZSBmb3IgaG9vayB1bml0cyAoZS5nLiBcImFudGhyb3BpYy9jbGF1ZGUtMy01LXNvbm5ldFwiKS4gKi9cbiAgbW9kZWw/OiBzdHJpbmc7XG4gIC8qKiBDYXB0dXJlIElEIGZvciBxdWljay10YXNrIGl0ZW1zIChhbHJlYWR5IG1hcmtlZCBleGVjdXRlZCBhdCBlbnF1ZXVlIHRpbWUpLiAqL1xuICBjYXB0dXJlSWQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUHJlRXhlY0ZhaWx1cmUge1xuICAvKiogTWlsZXN0b25lL3NsaWNlIHRoYXQgZmFpbGVkIChlLmcuIFwiTTAwMS9TMDJcIikuICovXG4gIHVuaXRJZDogc3RyaW5nO1xuICAvKiogVmVyYmF0aW0gYmxvY2tpbmcgY2hlY2sgc3RyaW5ncyBmcm9tIHRoZSBmYWlsZWQgZ2F0ZSBydW4uICovXG4gIGJsb2NraW5nRmluZGluZ3M6IHN0cmluZ1tdO1xuICAvKiogQ29uZGVuc2VkIGdhdGUgdmVyZGljdCBleGNlcnB0IGZvciBjb250ZXh0IChzdGF0dXMgKyByYXRpb25hbGUpLiAqL1xuICB2ZXJkaWN0RXhjZXJwdDogc3RyaW5nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29uc3RhbnRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgY29uc3QgU1RVQl9SRUNPVkVSWV9USFJFU0hPTEQgPSAyO1xuZXhwb3J0IGNvbnN0IE5FV19TRVNTSU9OX1RJTUVPVVRfTVMgPSAxMjBfMDAwO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQXV0b1Nlc3Npb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBjbGFzcyBBdXRvU2Vzc2lvbiB7XG4gIC8vIFx1MjUwMFx1MjUwMCBMaWZlY3ljbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGFjdGl2ZSA9IGZhbHNlO1xuICBwYXVzZWQgPSBmYWxzZTtcbiAgY29tcGxldGlvblN0b3BJblByb2dyZXNzID0gZmFsc2U7XG4gIHN0ZXBNb2RlID0gZmFsc2U7XG4gIHZlcmJvc2UgPSBmYWxzZTtcbiAgYWN0aXZlRW5naW5lSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBhY3RpdmVSdW5EaXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBjbWRDdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0IHwgbnVsbCA9IG51bGw7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFBhdGhzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBiYXNlUGF0aCA9IFwiXCI7XG4gIG9yaWdpbmFsQmFzZVBhdGggPSBcIlwiO1xuICAvLyBUT0RPKEM4KTogcmVtb3ZlIGJhc2VQYXRoL29yaWdpbmFsQmFzZVBhdGggb25jZSBhbGwgcmVhZGVycyB1c2Ugcy5zY29wZVxuICBzY29wZTogTWlsZXN0b25lU2NvcGUgfCBudWxsID0gbnVsbDtcblxuICAvLyBcdTI1MDBcdTI1MDAgQ29vcmRpbmF0aW9uIGlkZW50aXR5IChQaGFzZSBCIFx1MjAxNCBEQi1iYWNrZWQgY29vcmRpbmF0aW9uKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLyoqXG4gICAqIFdvcmtlciByZWdpc3RyeSBJRCBzZXQgYnkgcmVnaXN0ZXJBdXRvV29ya2VyKCkgYXQgc2Vzc2lvbiBzdGFydC4gVXNlZCBieVxuICAgKiBoZWFydGJlYXRBdXRvV29ya2VyKCkgZWFjaCBsb29wIGl0ZXJhdGlvbiBhbmQgYnkgcmVjb3JkRGlzcGF0Y2hDbGFpbSgpXG4gICAqIHRvIGZlbmNlIGRpc3BhdGNoIGxlZGdlciB3cml0ZXMgYWdhaW5zdCBzdGFsZSB3b3JrZXJzLlxuICAgKi9cbiAgd29ya2VySWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAvKipcbiAgICogQWN0aXZlIG1pbGVzdG9uZSBsZWFzZSBmZW5jaW5nIHRva2VuLCBzZXQgYnkgY2xhaW1NaWxlc3RvbmVMZWFzZSgpIGluc2lkZVxuICAgKiBXb3JrdHJlZUxpZmVjeWNsZS5lbnRlck1pbGVzdG9uZSgpLiBUaHJlYWRlZCBpbnRvIHJlY29yZERpc3BhdGNoQ2xhaW0oKVxuICAgKiBhcyBtaWxlc3RvbmVfbGVhc2VfdG9rZW4gc28gb3V0LW9mLWJhbmQgZGlzcGF0Y2hlcyBieSBhIHN0YWxlIHdvcmtlclxuICAgKiBhcmUgZGV0ZWN0YWJsZS5cbiAgICovXG4gIG1pbGVzdG9uZUxlYXNlVG9rZW46IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBwcmV2aW91c1Byb2plY3RSb290RW52OiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgaGFkUHJvamVjdFJvb3RFbnYgPSBmYWxzZTtcbiAgcHJvamVjdFJvb3RFbnZDYXB0dXJlZCA9IGZhbHNlO1xuICBwcmV2aW91c01pbGVzdG9uZUxvY2tFbnY6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBoYWRNaWxlc3RvbmVMb2NrRW52ID0gZmFsc2U7XG4gIG1pbGVzdG9uZUxvY2tFbnZDYXB0dXJlZCA9IGZhbHNlO1xuICBzZXNzaW9uTWlsZXN0b25lTG9jazogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGdpdFNlcnZpY2U6IEdpdFNlcnZpY2VJbXBsIHwgbnVsbCA9IG51bGw7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIERpc3BhdGNoIGNvdW50ZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICByZWFkb25seSB1bml0RGlzcGF0Y2hDb3VudCA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIHJlYWRvbmx5IHVuaXRMaWZldGltZURpc3BhdGNoZXMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICByZWFkb25seSB1bml0UmVjb3ZlcnlDb3VudCA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFRpbWVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdW5pdFRpbWVvdXRIYW5kbGU6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gIHdyYXB1cFdhcm5pbmdIYW5kbGU6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gIGlkbGVXYXRjaGRvZ0hhbmRsZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIGNvbnRpbnVlSGVyZUhhbmRsZTogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEN1cnJlbnQgdW5pdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY3VycmVudFVuaXQ6IEN1cnJlbnRVbml0IHwgbnVsbCA9IG51bGw7XG4gIGN1cnJlbnRUcmFjZUlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgY3VycmVudFR1cm5JZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGN1cnJlbnRVbml0Um91dGluZzogVW5pdFJvdXRpbmcgfCBudWxsID0gbnVsbDtcbiAgY3VycmVudE1pbGVzdG9uZUlkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICAvLyBcdTI1MDBcdTI1MDAgTW9kZWwgc3RhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGF1dG9Nb2RlU3RhcnRNb2RlbDogU3RhcnRNb2RlbCB8IG51bGwgPSBudWxsO1xuICAvKiogRXhwbGljaXQgL2dzZCBtb2RlbCBwaW4gY2FwdHVyZWQgYXQgYm9vdHN0cmFwIChzZXNzaW9uLXNjb3BlZCBwb2xpY3kgb3ZlcnJpZGUpLiAqL1xuICBtYW51YWxTZXNzaW9uTW9kZWxPdmVycmlkZTogU3RhcnRNb2RlbCB8IG51bGwgPSBudWxsO1xuICBjdXJyZW50VW5pdE1vZGVsOiBNb2RlbDxBcGk+IHwgbnVsbCA9IG51bGw7XG4gIC8qKiBGdWxseS1xdWFsaWZpZWQgbW9kZWwgSUQgKHByb3ZpZGVyL2lkKSBzZXQgYWZ0ZXIgc2VsZWN0QW5kQXBwbHlNb2RlbCArIGhvb2sgb3ZlcnJpZGVzICgjMjg5OSkuICovXG4gIGN1cnJlbnREaXNwYXRjaGVkTW9kZWxJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIG9yaWdpbmFsTW9kZWxJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIG9yaWdpbmFsTW9kZWxQcm92aWRlcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGF1dG9Nb2RlU3RhcnRUaGlua2luZ0xldmVsOiBUaGlua2luZ0xldmVsU25hcHNob3QgfCBudWxsID0gbnVsbDtcbiAgb3JpZ2luYWxUaGlua2luZ0xldmVsOiBUaGlua2luZ0xldmVsU25hcHNob3QgfCBudWxsID0gbnVsbDtcbiAgbGFzdEJ1ZGdldEFsZXJ0TGV2ZWw6IEJ1ZGdldEFsZXJ0TGV2ZWwgPSAwO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBSZWNvdmVyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgcGVuZGluZ0NyYXNoUmVjb3Zlcnk6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnk6IFBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSB8IG51bGwgPSBudWxsO1xuICByZWFkb25seSB2ZXJpZmljYXRpb25SZXRyeUNvdW50ID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgcmVhZG9ubHkgdmVyaWZpY2F0aW9uUmV0cnlGYWlsdXJlSGFzaGVzID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgcGF1c2VkU2Vzc2lvbkZpbGU6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwYXVzZWRVbml0VHlwZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHBhdXNlZFVuaXRJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHJlc291cmNlVmVyc2lvbk9uU3RhcnQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBsYXN0U3RhdGVSZWJ1aWxkQXQgPSAwO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBTaWRlY2FyIHF1ZXVlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBzaWRlY2FyUXVldWU6IFNpZGVjYXJJdGVtW10gPSBbXTtcblxuICAvLyBcdTI1MDBcdTI1MDAgUHJlLWV4ZWMgZ2F0ZSBmYWlsdXJlIGNvbnRleHQgKCM0NTUxKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLyoqXG4gICAqIFBlcnNpc3RlZCB3aGVuIGEgcHJlLWV4ZWN1dGlvbiBnYXRlIGZhaWxzIG9uIGEgcGxhbi1zbGljZSBvciByZWZpbmUtc2xpY2VcbiAgICogdW5pdC4gVGhlIHBsYW5uaW5nIFx1MjE5MiBwbGFuLXNsaWNlIGRpc3BhdGNoIHJ1bGUgcmVhZHMgdGhpcyBmaWVsZCBhbmQgaW5qZWN0c1xuICAgKiB0aGUgZmFpbHVyZSBkZXRhaWxzIGludG8gdGhlIG5leHQgcmUtZGlzcGF0Y2ggcHJvbXB0IHNvIHRoZSBMTE0gY2FuIGZpeCB0aGVcbiAgICogc3BlY2lmaWMgaXNzdWVzIGluc3RlYWQgb2YgcHJvZHVjaW5nIGFuIGlkZW50aWNhbCBwbGFuLlxuICAgKlxuICAgKiBDbGVhcmVkIGFmdGVyIGl0IGhhcyBiZWVuIGNvbnN1bWVkIChpbmplY3RlZCBpbnRvIHRoZSBwcm9tcHQpIHRvIGF2b2lkXG4gICAqIHN0YWxlIGNvbnRleHQgYmxlZWRpbmcgaW50byB1bnJlbGF0ZWQgc2xpY2VzLlxuICAgKi9cbiAgbGFzdFByZUV4ZWNGYWlsdXJlOiBQcmVFeGVjRmFpbHVyZSB8IG51bGwgPSBudWxsO1xuICAvKipcbiAgICogVHJhY2tzIGhvdyBtYW55IGNvbnNlY3V0aXZlIHRpbWVzIGVhY2ggc2xpY2UgdW5pdCBoYXMgZmFpbGVkIHByZS1leGVjdXRpb25cbiAgICogY2hlY2tzLiBLZXllZCBieSB1bml0SWQgKGUuZy4gXCJNMDAxL1MwMVwiKS4gVXNlZCB0byBicmVhayB0aGUgaW5maW5pdGVcbiAgICogcGxhbi1zbGljZSBcdTIxOTIgcHJlLWV4ZWMgZmFpbCBcdTIxOTIgcmUtZGlzcGF0Y2ggbG9vcCB3aGVuIHRoZSBwbGFubmVyIGNhbm5vdCBmaXhcbiAgICogdGhlIGlzc3VlcyBhZnRlciBNQVhfUFJFX0VYRUNfUkVUUklFUyByZS1hdHRlbXB0cy5cbiAgICovXG4gIHJlYWRvbmx5IHByZUV4ZWNSZXRyeUNvdW50OiBNYXA8c3RyaW5nLCBudW1iZXI+ID0gbmV3IE1hcCgpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBUb29sIGludm9jYXRpb24gZXJyb3JzICgjMjg4MykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8qKiBTZXQgd2hlbiBhIEdTRCB0b29sIGV4ZWN1dGlvbiBlbmRzIHdpdGggaXNFcnJvciBkdWUgdG8gbWFsZm9ybWVkL3RydW5jYXRlZFxuICAgKiAgSlNPTiBhcmd1bWVudHMuIENoZWNrZWQgYnkgcG9zdFVuaXRQcmVWZXJpZmljYXRpb24gdG8gYnJlYWsgcmV0cnkgbG9vcHMuICovXG4gIGxhc3RUb29sSW52b2NhdGlvbkVycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgLyoqIEFnZW50LWVuZCBtZXNzYWdlcyBmcm9tIHRoZSBqdXN0LWZpbmlzaGVkIHVuaXQsIGNvbnN1bWVkIGR1cmluZyBmaW5hbGl6ZS4gKi9cbiAgbGFzdFVuaXRBZ2VudEVuZE1lc3NhZ2VzOiB1bmtub3duW10gfCBudWxsID0gbnVsbDtcbiAgLyoqIFNldCB3aGVuIHR1cm4tbGV2ZWwgZ2l0IGFjdGlvbiBmYWlscyBkdXJpbmcgY2xvc2VvdXQuICovXG4gIGxhc3RHaXRBY3Rpb25GYWlsdXJlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgLyoqIExhc3QgdHVybi1sZXZlbCBnaXQgYWN0aW9uIHN0YXR1cyBjYXB0dXJlZCBkdXJpbmcgZmluYWxpemUuICovXG4gIGxhc3RHaXRBY3Rpb25TdGF0dXM6IFwib2tcIiB8IFwiZmFpbGVkXCIgfCBudWxsID0gbnVsbDtcblxuICAvLyBcdTI1MDBcdTI1MDAgSXNvbGF0aW9uIGRlZ3JhZGF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvKiogU2V0IHRvIHRydWUgd2hlbiB3b3JrdHJlZSBjcmVhdGlvbiBmYWlsczsgcHJldmVudHMgbWVyZ2Ugb2Ygbm9uZXhpc3RlbnQgYnJhbmNoLiAqL1xuICBpc29sYXRpb25EZWdyYWRlZCA9IGZhbHNlO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBNZXJnZSBndWFyZCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLyoqIFNldCB0byB0cnVlIGFmdGVyIHBoYXNlcy50cyBzdWNjZXNzZnVsbHkgY2FsbHMgbWVyZ2VBbmRFeGl0LCBzbyB0aGF0XG4gICAqICBzdG9wQXV0byBkb2VzIG5vdCBhdHRlbXB0IHRoZSBzYW1lIG1lcmdlIGEgc2Vjb25kIHRpbWUgKCMyNjQ1KS4gKi9cbiAgbWlsZXN0b25lTWVyZ2VkSW5QaGFzZXMgPSBmYWxzZTtcblxuICAvLyAjNDc2NSBcdTIwMTQgc2xpY2UtY2FkZW5jZSBjb2xsYXBzZTogbWFpbi1icmFuY2ggU0hBcyBhdCB0aGUgbW9tZW50IGVhY2hcbiAgLy8gbWlsZXN0b25lJ3MgZmlyc3Qgc2xpY2UgbWVyZ2UgYmVnYW4uIFVzZWQgYnkgcmVzcXVhc2hNaWxlc3RvbmVPbk1haW4gYXRcbiAgLy8gbWlsZXN0b25lIGNvbXBsZXRpb24gdG8gY29sbGFwc2UgTiBzbGljZSBjb21taXRzIGludG8gb25lLiBDbGVhcmVkIHdoZW5cbiAgLy8gdGhlIG1pbGVzdG9uZSBmaW5pc2hlcyAob3IgcmVzcXVhc2ggcnVucykuXG4gIG1pbGVzdG9uZVN0YXJ0U2hhczogTWFwPHN0cmluZywgc3RyaW5nPiA9IG5ldyBNYXAoKTtcblxuICAvLyBcdTI1MDBcdTI1MDAgRGlzcGF0Y2ggY2lyY3VpdCBicmVha2VycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgcmV3cml0ZUF0dGVtcHRDb3VudCA9IDA7XG4gIC8qKiBUcmFja3MgY29uc2VjdXRpdmUgYm9vdHN0cmFwIGF0dGVtcHRzIHRoYXQgZm91bmQgcGhhc2UgPT09IFwiY29tcGxldGVcIi5cbiAgICogIE1vdmVkIGZyb20gbW9kdWxlLWxldmVsIHRvIHBlci1zZXNzaW9uIHNvIHMucmVzZXQoKSBjbGVhcnMgaXQgKCMxMzQ4KS4gKi9cbiAgY29uc2VjdXRpdmVDb21wbGV0ZUJvb3RzdHJhcHMgPSAwO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBNZXRyaWNzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBhdXRvU3RhcnRUaW1lID0gMDtcbiAgbGFzdFByb21wdENoYXJDb3VudDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBsYXN0QmFzZWxpbmVDaGFyQ291bnQ6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgcGVuZGluZ1F1aWNrVGFza3M6IENhcHR1cmVFbnRyeVtdID0gW107XG4gIC8qKiBUaW1lc3RhbXAgb2YgdGhlIGxhc3QgTExNIHJlcXVlc3QgZGlzcGF0Y2ggKG1zIHNpbmNlIGVwb2NoKS4gVXNlZCBmb3IgcHJvYWN0aXZlIHJhdGUgbGltaXRpbmcuICovXG4gIGxhc3RSZXF1ZXN0VGltZXN0YW1wID0gMDtcblxuICAvLyBcdTI1MDBcdTI1MDAgU2FmZXR5IGhhcm5lc3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8qKiBTSEEgb2YgdGhlIHByZS11bml0IGdpdCBjaGVja3BvaW50IHJlZi4gQ2xlYXJlZCBvbiBzdWNjZXNzIG9yIHJvbGxiYWNrLiAqL1xuICBjaGVja3BvaW50U2hhOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICAvLyBcdTI1MDBcdTI1MDAgU2lnbmFsIGhhbmRsZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHNpZ3Rlcm1IYW5kbGVyOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuICAvLyBcdTI1MDBcdTI1MDAgUmVtb3RlIGNvbW1hbmQgcG9sbGluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLyoqIENsZWFudXAgZnVuY3Rpb24gcmV0dXJuZWQgYnkgc3RhcnRDb21tYW5kUG9sbGluZygpOyBudWxsIHdoZW4gbm90IHJ1bm5pbmcuICovXG4gIGNvbW1hbmRQb2xsaW5nQ2xlYW51cDogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIE9yY2hlc3RyYXRpb24gc2VhbSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgb3JjaGVzdHJhdGlvbjogQXV0b09yY2hlc3RyYXRpb25Nb2R1bGUgfCBudWxsID0gbnVsbDtcblxuICAvLyBcdTI1MDBcdTI1MDAgTG9vcCBwcm9taXNlIHN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBQZXItdW5pdCByZXNvbHZlIGZ1bmN0aW9uIGFuZCBzZXNzaW9uLXN3aXRjaCBndWFyZCBsaXZlIGF0IG1vZHVsZSBsZXZlbFxuICAvLyBpbiBhdXRvLWxvb3AudHMgKF9jdXJyZW50UmVzb2x2ZSwgX3Nlc3Npb25Td2l0Y2hJbkZsaWdodCkuXG5cbiAgLy8gXHUyNTAwXHUyNTAwIE1ldGhvZHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgY2xlYXJUaW1lcnMoKTogdm9pZCB7XG4gICAgaWYgKHRoaXMudW5pdFRpbWVvdXRIYW5kbGUpIHsgY2xlYXJUaW1lb3V0KHRoaXMudW5pdFRpbWVvdXRIYW5kbGUpOyB0aGlzLnVuaXRUaW1lb3V0SGFuZGxlID0gbnVsbDsgfVxuICAgIGlmICh0aGlzLndyYXB1cFdhcm5pbmdIYW5kbGUpIHsgY2xlYXJUaW1lb3V0KHRoaXMud3JhcHVwV2FybmluZ0hhbmRsZSk7IHRoaXMud3JhcHVwV2FybmluZ0hhbmRsZSA9IG51bGw7IH1cbiAgICBpZiAodGhpcy5pZGxlV2F0Y2hkb2dIYW5kbGUpIHsgY2xlYXJJbnRlcnZhbCh0aGlzLmlkbGVXYXRjaGRvZ0hhbmRsZSk7IHRoaXMuaWRsZVdhdGNoZG9nSGFuZGxlID0gbnVsbDsgfVxuICAgIGlmICh0aGlzLmNvbnRpbnVlSGVyZUhhbmRsZSkgeyBjbGVhckludGVydmFsKHRoaXMuY29udGludWVIZXJlSGFuZGxlKTsgdGhpcy5jb250aW51ZUhlcmVIYW5kbGUgPSBudWxsOyB9XG4gIH1cblxuICByZXNldERpc3BhdGNoQ291bnRlcnMoKTogdm9pZCB7XG4gICAgdGhpcy51bml0RGlzcGF0Y2hDb3VudC5jbGVhcigpO1xuICAgIHRoaXMudW5pdExpZmV0aW1lRGlzcGF0Y2hlcy5jbGVhcigpO1xuICB9XG5cbiAgZ2V0IGxvY2tCYXNlUGF0aCgpOiBzdHJpbmcge1xuICAgIHJldHVybiByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdCh0aGlzLmJhc2VQYXRoLCB0aGlzLm9yaWdpbmFsQmFzZVBhdGgpO1xuICB9XG5cbiAgLyoqXG4gICAqIENhbm9uaWNhbCBwcm9qZWN0IHJvb3QgZm9yIHN0YXRlLWRlcml2YXRpb24gcmVhZHMgQU5EIHdyaXRlciBwYXRocy5cbiAgICpcbiAgICogUHJlZmVycyB0aGUgcmVhbHBhdGgtbm9ybWFsaXplZCBwcm9qZWN0Um9vdCBmcm9tIHRoZSBNaWxlc3RvbmVTY29wZVxuICAgKiAoaW50cm9kdWNlZCBieSBQUiAjNTIzNiksIGZhbGxpbmcgYmFjayB0byByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdFxuICAgKiBkdXJpbmcgZWFybHkgbGlmZWN5Y2xlIC8gZW5naW5lLWJ5cGFzcyBwYXRocyB3aGVyZSBzY29wZSBtYXkgYmUgbnVsbC5cbiAgICpcbiAgICogQWx3YXlzIHJlYWxwYXRoLW5vcm1hbGl6ZWQgc28gY2FjaGUga2V5cyAoZS5nLiBkZXJpdmVTdGF0ZSdzIF9zdGF0ZUNhY2hlKVxuICAgKiBjYW5ub3QgZHJpZnQgYWNyb3NzIHdvcmt0cmVlXHUyMTk0cHJvamVjdC1yb290IHBhdGgtc3RyaW5nIHZhcmlhbnRzIGZvciB0aGVcbiAgICogc2FtZSBmaWxlc3lzdGVtIGxvY2F0aW9uLlxuICAgKi9cbiAgZ2V0IGNhbm9uaWNhbFByb2plY3RSb290KCk6IHN0cmluZyB7XG4gICAgY29uc3Qgcm9vdCA9XG4gICAgICB0aGlzLnNjb3BlPy53b3Jrc3BhY2UucHJvamVjdFJvb3RcbiAgICAgICAgPz8gcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QodGhpcy5iYXNlUGF0aCwgdGhpcy5vcmlnaW5hbEJhc2VQYXRoKTtcbiAgICByZXR1cm4gbm9ybWFsaXplUmVhbFBhdGgocm9vdCk7XG4gIH1cblxuICByZXNldCgpOiB2b2lkIHtcbiAgICB0aGlzLmNsZWFyVGltZXJzKCk7XG5cbiAgICAvLyBMaWZlY3ljbGVcbiAgICB0aGlzLmFjdGl2ZSA9IGZhbHNlO1xuICAgIHRoaXMucGF1c2VkID0gZmFsc2U7XG4gICAgdGhpcy5jb21wbGV0aW9uU3RvcEluUHJvZ3Jlc3MgPSBmYWxzZTtcbiAgICB0aGlzLnN0ZXBNb2RlID0gZmFsc2U7XG4gICAgdGhpcy52ZXJib3NlID0gZmFsc2U7XG4gICAgdGhpcy5hY3RpdmVFbmdpbmVJZCA9IG51bGw7XG4gICAgdGhpcy5hY3RpdmVSdW5EaXIgPSBudWxsO1xuICAgIHRoaXMuY21kQ3R4ID0gbnVsbDtcblxuICAgIC8vIFBhdGhzXG4gICAgdGhpcy5iYXNlUGF0aCA9IFwiXCI7XG4gICAgdGhpcy5vcmlnaW5hbEJhc2VQYXRoID0gXCJcIjtcbiAgICB0aGlzLnNjb3BlID0gbnVsbDtcbiAgICB0aGlzLndvcmtlcklkID0gbnVsbDtcbiAgICB0aGlzLm1pbGVzdG9uZUxlYXNlVG9rZW4gPSBudWxsO1xuICAgIHRoaXMucHJldmlvdXNQcm9qZWN0Um9vdEVudiA9IG51bGw7XG4gICAgdGhpcy5oYWRQcm9qZWN0Um9vdEVudiA9IGZhbHNlO1xuICAgIHRoaXMucHJvamVjdFJvb3RFbnZDYXB0dXJlZCA9IGZhbHNlO1xuICAgIHRoaXMucHJldmlvdXNNaWxlc3RvbmVMb2NrRW52ID0gbnVsbDtcbiAgICB0aGlzLmhhZE1pbGVzdG9uZUxvY2tFbnYgPSBmYWxzZTtcbiAgICB0aGlzLm1pbGVzdG9uZUxvY2tFbnZDYXB0dXJlZCA9IGZhbHNlO1xuICAgIHRoaXMuc2Vzc2lvbk1pbGVzdG9uZUxvY2sgPSBudWxsO1xuICAgIHRoaXMuZ2l0U2VydmljZSA9IG51bGw7XG5cbiAgICAvLyBEaXNwYXRjaFxuICAgIHRoaXMudW5pdERpc3BhdGNoQ291bnQuY2xlYXIoKTtcbiAgICB0aGlzLnVuaXRMaWZldGltZURpc3BhdGNoZXMuY2xlYXIoKTtcbiAgICB0aGlzLnVuaXRSZWNvdmVyeUNvdW50LmNsZWFyKCk7XG5cbiAgICAvLyBVbml0XG4gICAgdGhpcy5jdXJyZW50VW5pdCA9IG51bGw7XG4gICAgdGhpcy5jdXJyZW50VHJhY2VJZCA9IG51bGw7XG4gICAgdGhpcy5jdXJyZW50VHVybklkID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnRVbml0Um91dGluZyA9IG51bGw7XG4gICAgdGhpcy5jdXJyZW50TWlsZXN0b25lSWQgPSBudWxsO1xuXG4gICAgLy8gTW9kZWxcbiAgICB0aGlzLmF1dG9Nb2RlU3RhcnRNb2RlbCA9IG51bGw7XG4gICAgdGhpcy5tYW51YWxTZXNzaW9uTW9kZWxPdmVycmlkZSA9IG51bGw7XG4gICAgdGhpcy5jdXJyZW50VW5pdE1vZGVsID0gbnVsbDtcbiAgICB0aGlzLmN1cnJlbnREaXNwYXRjaGVkTW9kZWxJZCA9IG51bGw7XG4gICAgdGhpcy5vcmlnaW5hbE1vZGVsSWQgPSBudWxsO1xuICAgIHRoaXMub3JpZ2luYWxNb2RlbFByb3ZpZGVyID0gbnVsbDtcbiAgICB0aGlzLmF1dG9Nb2RlU3RhcnRUaGlua2luZ0xldmVsID0gbnVsbDtcbiAgICB0aGlzLm9yaWdpbmFsVGhpbmtpbmdMZXZlbCA9IG51bGw7XG4gICAgdGhpcy5sYXN0QnVkZ2V0QWxlcnRMZXZlbCA9IDA7XG5cbiAgICAvLyBSZWNvdmVyeVxuICAgIHRoaXMucGVuZGluZ0NyYXNoUmVjb3ZlcnkgPSBudWxsO1xuICAgIHRoaXMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5ID0gbnVsbDtcbiAgICB0aGlzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuY2xlYXIoKTtcbiAgICB0aGlzLnZlcmlmaWNhdGlvblJldHJ5RmFpbHVyZUhhc2hlcy5jbGVhcigpO1xuICAgIHRoaXMucGF1c2VkU2Vzc2lvbkZpbGUgPSBudWxsO1xuICAgIHRoaXMucGF1c2VkVW5pdFR5cGUgPSBudWxsO1xuICAgIHRoaXMucGF1c2VkVW5pdElkID0gbnVsbDtcbiAgICB0aGlzLnJlc291cmNlVmVyc2lvbk9uU3RhcnQgPSBudWxsO1xuICAgIHRoaXMubGFzdFN0YXRlUmVidWlsZEF0ID0gMDtcblxuICAgIC8vIE1ldHJpY3NcbiAgICB0aGlzLmF1dG9TdGFydFRpbWUgPSAwO1xuICAgIHRoaXMubGFzdFByb21wdENoYXJDb3VudCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLmxhc3RCYXNlbGluZUNoYXJDb3VudCA9IHVuZGVmaW5lZDtcbiAgICB0aGlzLnBlbmRpbmdRdWlja1Rhc2tzID0gW107XG4gICAgdGhpcy5sYXN0UmVxdWVzdFRpbWVzdGFtcCA9IDA7XG4gICAgdGhpcy5zaWRlY2FyUXVldWUgPSBbXTtcbiAgICB0aGlzLnJld3JpdGVBdHRlbXB0Q291bnQgPSAwO1xuICAgIHRoaXMuY29uc2VjdXRpdmVDb21wbGV0ZUJvb3RzdHJhcHMgPSAwO1xuICAgIHRoaXMubGFzdFByZUV4ZWNGYWlsdXJlID0gbnVsbDtcbiAgICB0aGlzLnByZUV4ZWNSZXRyeUNvdW50LmNsZWFyKCk7XG4gICAgdGhpcy5sYXN0VG9vbEludm9jYXRpb25FcnJvciA9IG51bGw7XG4gICAgdGhpcy5sYXN0VW5pdEFnZW50RW5kTWVzc2FnZXMgPSBudWxsO1xuICAgIHRoaXMubGFzdEdpdEFjdGlvbkZhaWx1cmUgPSBudWxsO1xuICAgIHRoaXMubGFzdEdpdEFjdGlvblN0YXR1cyA9IG51bGw7XG4gICAgdGhpcy5pc29sYXRpb25EZWdyYWRlZCA9IGZhbHNlO1xuICAgIHRoaXMubWlsZXN0b25lTWVyZ2VkSW5QaGFzZXMgPSBmYWxzZTtcbiAgICB0aGlzLm1pbGVzdG9uZVN0YXJ0U2hhcyA9IG5ldyBNYXAoKTtcbiAgICB0aGlzLmNoZWNrcG9pbnRTaGEgPSBudWxsO1xuXG4gICAgLy8gU2lnbmFsIGhhbmRsZXJcbiAgICB0aGlzLnNpZ3Rlcm1IYW5kbGVyID0gbnVsbDtcblxuICAgIC8vIFJlbW90ZSBjb21tYW5kIHBvbGxpbmcgXHUyMDE0IGNsZWFudXAgbXVzdCBiZSBjYWxsZWQgYmVmb3JlIHJlc2V0IChhdXRvLnRzIHN0b3BBdXRvKVxuICAgIHRoaXMuY29tbWFuZFBvbGxpbmdDbGVhbnVwID0gbnVsbDtcblxuICAgIC8vIE9yY2hlc3RyYXRpb24gc2VhbVxuICAgIHRoaXMub3JjaGVzdHJhdGlvbiA9IG51bGw7XG5cbiAgICAvLyBMb29wIHByb21pc2Ugc3RhdGUgbGl2ZXMgaW4gYXV0by1sb29wLnRzIG1vZHVsZSBzY29wZVxuICB9XG5cbiAgcmVzZXRBZnRlclN0b3Aob3B0aW9uczogeyBwcmVzZXJ2ZUNvbXBsZXRpb25TdXJmYWNlPzogYm9vbGVhbiB9ID0ge30pOiB2b2lkIHtcbiAgICBjb25zdCBjb21wbGV0aW9uU3RvcEluUHJvZ3Jlc3MgPSBvcHRpb25zLnByZXNlcnZlQ29tcGxldGlvblN1cmZhY2UgPyB0aGlzLmNvbXBsZXRpb25TdG9wSW5Qcm9ncmVzcyA6IGZhbHNlO1xuICAgIHRoaXMucmVzZXQoKTtcbiAgICB0aGlzLmNvbXBsZXRpb25TdG9wSW5Qcm9ncmVzcyA9IGNvbXBsZXRpb25TdG9wSW5Qcm9ncmVzcztcbiAgfVxuXG4gIHRvSlNPTigpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gICAgY29uc3Qgb3JjaGVzdHJhdGlvblN0YXR1cyA9IHRoaXMub3JjaGVzdHJhdGlvbj8uZ2V0U3RhdHVzKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZTogdGhpcy5hY3RpdmUsXG4gICAgICBwYXVzZWQ6IHRoaXMucGF1c2VkLFxuICAgICAgc3RlcE1vZGU6IHRoaXMuc3RlcE1vZGUsXG4gICAgICBiYXNlUGF0aDogdGhpcy5iYXNlUGF0aCxcbiAgICAgIGFjdGl2ZUVuZ2luZUlkOiB0aGlzLmFjdGl2ZUVuZ2luZUlkLFxuICAgICAgYWN0aXZlUnVuRGlyOiB0aGlzLmFjdGl2ZVJ1bkRpcixcbiAgICAgIGN1cnJlbnRNaWxlc3RvbmVJZDogdGhpcy5jdXJyZW50TWlsZXN0b25lSWQsXG4gICAgICBjdXJyZW50VW5pdDogdGhpcy5jdXJyZW50VW5pdCxcbiAgICAgIG9yY2hlc3RyYXRpb25QaGFzZTogb3JjaGVzdHJhdGlvblN0YXR1cz8ucGhhc2UsXG4gICAgICBvcmNoZXN0cmF0aW9uVHJhbnNpdGlvbkNvdW50OiBvcmNoZXN0cmF0aW9uU3RhdHVzPy50cmFuc2l0aW9uQ291bnQsXG4gICAgICBvcmNoZXN0cmF0aW9uTGFzdFRyYW5zaXRpb25BdDogb3JjaGVzdHJhdGlvblN0YXR1cz8ubGFzdFRyYW5zaXRpb25BdCxcbiAgICAgIHVuaXREaXNwYXRjaENvdW50OiBPYmplY3QuZnJvbUVudHJpZXModGhpcy51bml0RGlzcGF0Y2hDb3VudCksXG4gICAgfTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBd0JBLFNBQVMsa0NBQWtDO0FBQzNDLFNBQVMseUJBQXlCO0FBd0QzQixNQUFNLDBCQUEwQjtBQUNoQyxNQUFNLHlCQUF5QjtBQUkvQixNQUFNLFlBQVk7QUFBQTtBQUFBLEVBRXZCLFNBQVM7QUFBQSxFQUNULFNBQVM7QUFBQSxFQUNULDJCQUEyQjtBQUFBLEVBQzNCLFdBQVc7QUFBQSxFQUNYLFVBQVU7QUFBQSxFQUNWLGlCQUFnQztBQUFBLEVBQ2hDLGVBQThCO0FBQUEsRUFDOUIsU0FBeUM7QUFBQTtBQUFBLEVBR3pDLFdBQVc7QUFBQSxFQUNYLG1CQUFtQjtBQUFBO0FBQUEsRUFFbkIsUUFBK0I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQVEvQixXQUEwQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBTzFCLHNCQUFxQztBQUFBLEVBQ3JDLHlCQUF3QztBQUFBLEVBQ3hDLG9CQUFvQjtBQUFBLEVBQ3BCLHlCQUF5QjtBQUFBLEVBQ3pCLDJCQUEwQztBQUFBLEVBQzFDLHNCQUFzQjtBQUFBLEVBQ3RCLDJCQUEyQjtBQUFBLEVBQzNCLHVCQUFzQztBQUFBLEVBQ3RDLGFBQW9DO0FBQUE7QUFBQSxFQUczQixvQkFBb0Isb0JBQUksSUFBb0I7QUFBQSxFQUM1Qyx5QkFBeUIsb0JBQUksSUFBb0I7QUFBQSxFQUNqRCxvQkFBb0Isb0JBQUksSUFBb0I7QUFBQTtBQUFBLEVBR3JELG9CQUEwRDtBQUFBLEVBQzFELHNCQUE0RDtBQUFBLEVBQzVELHFCQUE0RDtBQUFBLEVBQzVELHFCQUE0RDtBQUFBO0FBQUEsRUFHNUQsY0FBa0M7QUFBQSxFQUNsQyxpQkFBZ0M7QUFBQSxFQUNoQyxnQkFBK0I7QUFBQSxFQUMvQixxQkFBeUM7QUFBQSxFQUN6QyxxQkFBb0M7QUFBQTtBQUFBLEVBR3BDLHFCQUF3QztBQUFBO0FBQUEsRUFFeEMsNkJBQWdEO0FBQUEsRUFDaEQsbUJBQXNDO0FBQUE7QUFBQSxFQUV0QywyQkFBMEM7QUFBQSxFQUMxQyxrQkFBaUM7QUFBQSxFQUNqQyx3QkFBdUM7QUFBQSxFQUN2Qyw2QkFBMkQ7QUFBQSxFQUMzRCx3QkFBc0Q7QUFBQSxFQUN0RCx1QkFBeUM7QUFBQTtBQUFBLEVBR3pDLHVCQUFzQztBQUFBLEVBQ3RDLDJCQUE0RDtBQUFBLEVBQ25ELHlCQUF5QixvQkFBSSxJQUFvQjtBQUFBLEVBQ2pELGlDQUFpQyxvQkFBSSxJQUFvQjtBQUFBLEVBQ2xFLG9CQUFtQztBQUFBLEVBQ25DLGlCQUFnQztBQUFBLEVBQ2hDLGVBQThCO0FBQUEsRUFDOUIseUJBQXdDO0FBQUEsRUFDeEMscUJBQXFCO0FBQUE7QUFBQSxFQUdyQixlQUE4QixDQUFDO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQVkvQixxQkFBNEM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQU9uQyxvQkFBeUMsb0JBQUksSUFBSTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBSzFELDBCQUF5QztBQUFBO0FBQUEsRUFFekMsMkJBQTZDO0FBQUE7QUFBQSxFQUU3Qyx1QkFBc0M7QUFBQTtBQUFBLEVBRXRDLHNCQUE4QztBQUFBO0FBQUE7QUFBQSxFQUk5QyxvQkFBb0I7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQUtwQiwwQkFBMEI7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBTTFCLHFCQUEwQyxvQkFBSSxJQUFJO0FBQUE7QUFBQSxFQUdsRCxzQkFBc0I7QUFBQTtBQUFBO0FBQUEsRUFHdEIsZ0NBQWdDO0FBQUE7QUFBQSxFQUdoQyxnQkFBZ0I7QUFBQSxFQUNoQjtBQUFBLEVBQ0E7QUFBQSxFQUNBLG9CQUFvQyxDQUFDO0FBQUE7QUFBQSxFQUVyQyx1QkFBdUI7QUFBQTtBQUFBO0FBQUEsRUFJdkIsZ0JBQStCO0FBQUE7QUFBQSxFQUcvQixpQkFBc0M7QUFBQTtBQUFBO0FBQUEsRUFJdEMsd0JBQTZDO0FBQUE7QUFBQSxFQUc3QyxnQkFBZ0Q7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLEVBUWhELGNBQW9CO0FBQ2xCLFFBQUksS0FBSyxtQkFBbUI7QUFBRSxtQkFBYSxLQUFLLGlCQUFpQjtBQUFHLFdBQUssb0JBQW9CO0FBQUEsSUFBTTtBQUNuRyxRQUFJLEtBQUsscUJBQXFCO0FBQUUsbUJBQWEsS0FBSyxtQkFBbUI7QUFBRyxXQUFLLHNCQUFzQjtBQUFBLElBQU07QUFDekcsUUFBSSxLQUFLLG9CQUFvQjtBQUFFLG9CQUFjLEtBQUssa0JBQWtCO0FBQUcsV0FBSyxxQkFBcUI7QUFBQSxJQUFNO0FBQ3ZHLFFBQUksS0FBSyxvQkFBb0I7QUFBRSxvQkFBYyxLQUFLLGtCQUFrQjtBQUFHLFdBQUsscUJBQXFCO0FBQUEsSUFBTTtBQUFBLEVBQ3pHO0FBQUEsRUFFQSx3QkFBOEI7QUFDNUIsU0FBSyxrQkFBa0IsTUFBTTtBQUM3QixTQUFLLHVCQUF1QixNQUFNO0FBQUEsRUFDcEM7QUFBQSxFQUVBLElBQUksZUFBdUI7QUFDekIsV0FBTywyQkFBMkIsS0FBSyxVQUFVLEtBQUssZ0JBQWdCO0FBQUEsRUFDeEU7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsRUFhQSxJQUFJLHVCQUErQjtBQUNqQyxVQUFNLE9BQ0osS0FBSyxPQUFPLFVBQVUsZUFDakIsMkJBQTJCLEtBQUssVUFBVSxLQUFLLGdCQUFnQjtBQUN0RSxXQUFPLGtCQUFrQixJQUFJO0FBQUEsRUFDL0I7QUFBQSxFQUVBLFFBQWM7QUFDWixTQUFLLFlBQVk7QUFHakIsU0FBSyxTQUFTO0FBQ2QsU0FBSyxTQUFTO0FBQ2QsU0FBSywyQkFBMkI7QUFDaEMsU0FBSyxXQUFXO0FBQ2hCLFNBQUssVUFBVTtBQUNmLFNBQUssaUJBQWlCO0FBQ3RCLFNBQUssZUFBZTtBQUNwQixTQUFLLFNBQVM7QUFHZCxTQUFLLFdBQVc7QUFDaEIsU0FBSyxtQkFBbUI7QUFDeEIsU0FBSyxRQUFRO0FBQ2IsU0FBSyxXQUFXO0FBQ2hCLFNBQUssc0JBQXNCO0FBQzNCLFNBQUsseUJBQXlCO0FBQzlCLFNBQUssb0JBQW9CO0FBQ3pCLFNBQUsseUJBQXlCO0FBQzlCLFNBQUssMkJBQTJCO0FBQ2hDLFNBQUssc0JBQXNCO0FBQzNCLFNBQUssMkJBQTJCO0FBQ2hDLFNBQUssdUJBQXVCO0FBQzVCLFNBQUssYUFBYTtBQUdsQixTQUFLLGtCQUFrQixNQUFNO0FBQzdCLFNBQUssdUJBQXVCLE1BQU07QUFDbEMsU0FBSyxrQkFBa0IsTUFBTTtBQUc3QixTQUFLLGNBQWM7QUFDbkIsU0FBSyxpQkFBaUI7QUFDdEIsU0FBSyxnQkFBZ0I7QUFDckIsU0FBSyxxQkFBcUI7QUFDMUIsU0FBSyxxQkFBcUI7QUFHMUIsU0FBSyxxQkFBcUI7QUFDMUIsU0FBSyw2QkFBNkI7QUFDbEMsU0FBSyxtQkFBbUI7QUFDeEIsU0FBSywyQkFBMkI7QUFDaEMsU0FBSyxrQkFBa0I7QUFDdkIsU0FBSyx3QkFBd0I7QUFDN0IsU0FBSyw2QkFBNkI7QUFDbEMsU0FBSyx3QkFBd0I7QUFDN0IsU0FBSyx1QkFBdUI7QUFHNUIsU0FBSyx1QkFBdUI7QUFDNUIsU0FBSywyQkFBMkI7QUFDaEMsU0FBSyx1QkFBdUIsTUFBTTtBQUNsQyxTQUFLLCtCQUErQixNQUFNO0FBQzFDLFNBQUssb0JBQW9CO0FBQ3pCLFNBQUssaUJBQWlCO0FBQ3RCLFNBQUssZUFBZTtBQUNwQixTQUFLLHlCQUF5QjtBQUM5QixTQUFLLHFCQUFxQjtBQUcxQixTQUFLLGdCQUFnQjtBQUNyQixTQUFLLHNCQUFzQjtBQUMzQixTQUFLLHdCQUF3QjtBQUM3QixTQUFLLG9CQUFvQixDQUFDO0FBQzFCLFNBQUssdUJBQXVCO0FBQzVCLFNBQUssZUFBZSxDQUFDO0FBQ3JCLFNBQUssc0JBQXNCO0FBQzNCLFNBQUssZ0NBQWdDO0FBQ3JDLFNBQUsscUJBQXFCO0FBQzFCLFNBQUssa0JBQWtCLE1BQU07QUFDN0IsU0FBSywwQkFBMEI7QUFDL0IsU0FBSywyQkFBMkI7QUFDaEMsU0FBSyx1QkFBdUI7QUFDNUIsU0FBSyxzQkFBc0I7QUFDM0IsU0FBSyxvQkFBb0I7QUFDekIsU0FBSywwQkFBMEI7QUFDL0IsU0FBSyxxQkFBcUIsb0JBQUksSUFBSTtBQUNsQyxTQUFLLGdCQUFnQjtBQUdyQixTQUFLLGlCQUFpQjtBQUd0QixTQUFLLHdCQUF3QjtBQUc3QixTQUFLLGdCQUFnQjtBQUFBLEVBR3ZCO0FBQUEsRUFFQSxlQUFlLFVBQW1ELENBQUMsR0FBUztBQUMxRSxVQUFNLDJCQUEyQixRQUFRLDRCQUE0QixLQUFLLDJCQUEyQjtBQUNyRyxTQUFLLE1BQU07QUFDWCxTQUFLLDJCQUEyQjtBQUFBLEVBQ2xDO0FBQUEsRUFFQSxTQUFrQztBQUNoQyxVQUFNLHNCQUFzQixLQUFLLGVBQWUsVUFBVTtBQUMxRCxXQUFPO0FBQUEsTUFDTCxRQUFRLEtBQUs7QUFBQSxNQUNiLFFBQVEsS0FBSztBQUFBLE1BQ2IsVUFBVSxLQUFLO0FBQUEsTUFDZixVQUFVLEtBQUs7QUFBQSxNQUNmLGdCQUFnQixLQUFLO0FBQUEsTUFDckIsY0FBYyxLQUFLO0FBQUEsTUFDbkIsb0JBQW9CLEtBQUs7QUFBQSxNQUN6QixhQUFhLEtBQUs7QUFBQSxNQUNsQixvQkFBb0IscUJBQXFCO0FBQUEsTUFDekMsOEJBQThCLHFCQUFxQjtBQUFBLE1BQ25ELCtCQUErQixxQkFBcUI7QUFBQSxNQUNwRCxtQkFBbUIsT0FBTyxZQUFZLEtBQUssaUJBQWlCO0FBQUEsSUFDOUQ7QUFBQSxFQUNGO0FBQ0Y7IiwKICAibmFtZXMiOiBbXQp9Cg==
