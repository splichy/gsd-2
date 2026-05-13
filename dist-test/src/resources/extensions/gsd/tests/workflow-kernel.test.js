import assert from "node:assert/strict";
import test from "node:test";
import {
  decideCooldownRecovery,
  decideCustomEngineRecovery,
  decideCustomEngineVerifyRetry,
  decideDispatchNodeKind,
  decideDispatchClaim,
  decideEngineDispatch,
  decideEngineReconcile,
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
} from "../auto/workflow-kernel.js";
test("decideWorkflowLoop continues when dispatch preconditions are valid", () => {
  assert.deepEqual(
    decideWorkflowLoop({
      active: true,
      iteration: 1,
      maxIterations: 500,
      hasCommandContext: true,
      sessionLockValid: true
    }),
    { action: "continue" }
  );
});
test("decideWorkflowLoop stops inactive sessions before dispatch", () => {
  assert.deepEqual(
    decideWorkflowLoop({
      active: false,
      iteration: 1,
      maxIterations: 500,
      hasCommandContext: true,
      sessionLockValid: true
    }),
    {
      action: "stop",
      reason: "inactive",
      message: "Auto-mode is not active."
    }
  );
});
test("decideWorkflowLoop stops runaway loops with a stable reason", () => {
  assert.deepEqual(
    decideWorkflowLoop({
      active: true,
      iteration: 501,
      maxIterations: 500,
      hasCommandContext: true,
      sessionLockValid: true
    }),
    {
      action: "stop",
      reason: "max-iterations",
      message: "Safety: loop exceeded 500 iterations."
    }
  );
});
test("decideWorkflowLoop stops when dispatch cannot create a command session", () => {
  assert.deepEqual(
    decideWorkflowLoop({
      active: true,
      iteration: 1,
      maxIterations: 500,
      hasCommandContext: false,
      sessionLockValid: true
    }),
    {
      action: "stop",
      reason: "missing-command-context",
      message: "Auto-mode has no command context for dispatch."
    }
  );
});
test("decideWorkflowLoop preserves session lock loss detail", () => {
  assert.deepEqual(
    decideWorkflowLoop({
      active: true,
      iteration: 1,
      maxIterations: 500,
      hasCommandContext: true,
      sessionLockValid: false,
      sessionLockReason: "pid mismatch"
    }),
    {
      action: "stop",
      reason: "session-lock-lost",
      message: "Session lock lost: pid mismatch."
    }
  );
});
test("decideDispatchClaim runs with an opened dispatch id", () => {
  assert.deepEqual(
    decideDispatchClaim({ kind: "opened", dispatchId: 42 }),
    { action: "run", dispatchId: 42 }
  );
});
test("decideDispatchClaim runs degraded dispatches without a ledger id", () => {
  assert.deepEqual(
    decideDispatchClaim({ kind: "degraded" }),
    { action: "run", dispatchId: null }
  );
});
test("decideDispatchClaim skips claimed units with a stable reason", () => {
  assert.deepEqual(
    decideDispatchClaim({ kind: "skip", reason: "already-active" }),
    { action: "skip", reason: "already-active" }
  );
});
test("decideEngineDispatch preserves stop reasons and defaults missing ones", () => {
  assert.deepEqual(
    decideEngineDispatch({ action: "stop", reason: "done" }),
    { action: "stop", reason: "done" }
  );
  assert.deepEqual(
    decideEngineDispatch({ action: "stop" }),
    { action: "stop", reason: "Engine stopped" }
  );
});
test("decideEngineDispatch passes through skip and dispatch actions", () => {
  assert.deepEqual(decideEngineDispatch({ action: "skip" }), { action: "skip" });
  assert.deepEqual(decideEngineDispatch({ action: "dispatch" }), { action: "dispatch" });
});
test("decideFinalizeResult maps break results to stop decisions", () => {
  assert.deepEqual(
    decideFinalizeResult({ action: "break", reason: "git-closeout-failure" }),
    {
      action: "stop",
      failureClass: "git",
      ledgerErrorSummary: "finalize-break:git-closeout-failure",
      turnError: "finalize-break"
    }
  );
  assert.deepEqual(
    decideFinalizeResult({ action: "break" }),
    {
      action: "stop",
      failureClass: "closeout",
      ledgerErrorSummary: "finalize-break:unknown",
      turnError: "finalize-break"
    }
  );
});
test("decideFinalizeResult maps continue and next results", () => {
  assert.deepEqual(
    decideFinalizeResult({ action: "continue" }),
    { action: "retry", ledgerErrorSummary: "finalize-retry" }
  );
  assert.deepEqual(decideFinalizeResult({ action: "next" }), { action: "complete" });
});
test("decideEngineReconcile maps terminal outcomes", () => {
  assert.deepEqual(
    decideEngineReconcile({ outcome: "milestone-complete" }),
    { action: "complete-workflow", stopReason: "Workflow complete" }
  );
  assert.deepEqual(decideEngineReconcile({ outcome: "pause" }), { action: "pause" });
  assert.deepEqual(
    decideEngineReconcile({ outcome: "stop", reason: "blocked" }),
    { action: "stop", reason: "blocked" }
  );
  assert.deepEqual(
    decideEngineReconcile({ outcome: "stop" }),
    { action: "stop", reason: "Engine stopped" }
  );
});
test("decideEngineReconcile passes through continue outcomes", () => {
  assert.deepEqual(decideEngineReconcile({ outcome: "continue" }), { action: "continue" });
});
test("decideMemoryPressure continues when heap pressure is below threshold", () => {
  assert.deepEqual(
    decideMemoryPressure({
      pressured: false,
      heapMB: 512,
      limitMB: 4096,
      pct: 0.125,
      iteration: 5
    }),
    { action: "continue" }
  );
});
test("decideMemoryPressure returns stable stop messages when pressured", () => {
  assert.deepEqual(
    decideMemoryPressure({
      pressured: true,
      heapMB: 3800,
      limitMB: 4096,
      pct: 0.927,
      iteration: 10
    }),
    {
      action: "stop",
      warningMessage: "Memory pressure: 3800MB / 4096MB (93%) \u2014 stopping auto-mode to prevent OOM kill",
      stopMessage: "Memory pressure: heap at 3800MB / 4096MB (93%). Stopping gracefully to prevent OOM kill after 10 iterations. Resume with /gsd auto to continue from where you left off.",
      turnError: "memory-pressure"
    }
  );
});
test("decideMinRequestInterval continues when throttling is disabled or unused", () => {
  assert.deepEqual(
    decideMinRequestInterval({
      minIntervalMs: 0,
      lastRequestTimestamp: 1e3,
      nowMs: 1001
    }),
    { action: "continue" }
  );
  assert.deepEqual(
    decideMinRequestInterval({
      minIntervalMs: 5e3,
      lastRequestTimestamp: 0,
      nowMs: 1001
    }),
    { action: "continue" }
  );
});
test("decideMinRequestInterval returns remaining wait budget", () => {
  assert.deepEqual(
    decideMinRequestInterval({
      minIntervalMs: 5e3,
      lastRequestTimestamp: 1e4,
      nowMs: 12500
    }),
    { action: "wait", waitMs: 2500 }
  );
  assert.deepEqual(
    decideMinRequestInterval({
      minIntervalMs: 5e3,
      lastRequestTimestamp: 1e4,
      nowMs: 15e3
    }),
    { action: "continue" }
  );
});
test("decideCooldownRecovery uses bounded retry-after hints with a small buffer", () => {
  assert.deepEqual(
    decideCooldownRecovery({
      consecutiveCooldowns: 2,
      maxCooldownRetries: 5,
      retryAfterMs: 3e4,
      fallbackWaitMs: 15e3
    }),
    {
      action: "wait",
      waitMs: 30500,
      notifyMessage: "Credentials in cooldown (2/5) \u2014 waiting 31s before retrying."
    }
  );
});
test("decideCooldownRecovery uses fallback wait when retry-after is missing or out of range", () => {
  assert.deepEqual(
    decideCooldownRecovery({
      consecutiveCooldowns: 1,
      maxCooldownRetries: 5,
      fallbackWaitMs: 15e3
    }),
    {
      action: "wait",
      waitMs: 15e3,
      notifyMessage: "Credentials in cooldown (1/5) \u2014 waiting 15s before retrying."
    }
  );
  assert.deepEqual(
    decideCooldownRecovery({
      consecutiveCooldowns: 1,
      maxCooldownRetries: 5,
      retryAfterMs: 9e4,
      fallbackWaitMs: 15e3
    }),
    {
      action: "wait",
      waitMs: 15e3,
      notifyMessage: "Credentials in cooldown (1/5) \u2014 waiting 15s before retrying."
    }
  );
});
test("decideCooldownRecovery stops after retry budget is exceeded", () => {
  assert.deepEqual(
    decideCooldownRecovery({
      consecutiveCooldowns: 6,
      maxCooldownRetries: 5,
      retryAfterMs: 3e4,
      fallbackWaitMs: 15e3
    }),
    {
      action: "stop",
      notifyMessage: "Auto-mode stopped: 6 consecutive credential cooldowns \u2014 rate limit or quota may be persistently exhausted.",
      stopMessage: "6 consecutive credential cooldowns exceeded retry budget"
    }
  );
});
test("decideIterationErrorRecovery retries first iteration error", () => {
  assert.deepEqual(
    decideIterationErrorRecovery({
      consecutiveErrors: 1,
      recentErrorMessages: ["temporary failure"],
      currentErrorMessage: "temporary failure"
    }),
    {
      action: "retry",
      notifyMessage: "Iteration error: temporary failure. Retrying.",
      turnStatus: "retry"
    }
  );
});
test("decideIterationErrorRecovery invalidates caches on second consecutive error", () => {
  assert.deepEqual(
    decideIterationErrorRecovery({
      consecutiveErrors: 2,
      recentErrorMessages: ["temporary failure", "still failing"],
      currentErrorMessage: "still failing"
    }),
    {
      action: "invalidate-and-retry",
      notifyMessage: "Iteration error (attempt 2): still failing. Invalidating caches and retrying.",
      turnStatus: "retry"
    }
  );
});
test("decideIterationErrorRecovery stops on third consecutive error with history", () => {
  assert.deepEqual(
    decideIterationErrorRecovery({
      consecutiveErrors: 3,
      recentErrorMessages: ["first", "second", "third"],
      currentErrorMessage: "third"
    }),
    {
      action: "stop",
      notifyMessage: "Auto-mode stopped: 3 consecutive iteration failures:\n  1. first\n  2. second\n  3. third",
      stopMessage: "3 consecutive iteration failures",
      turnStatus: "failed"
    }
  );
});
test("decideCustomEngineVerifyRetry retries until the retry budget is exceeded", () => {
  assert.deepEqual(
    decideCustomEngineVerifyRetry({ attempts: 3, maxRetries: 3 }),
    { action: "retry" }
  );
  assert.deepEqual(
    decideCustomEngineVerifyRetry({ attempts: 4, maxRetries: 3 }),
    { action: "recover" }
  );
});
test("shouldUseCustomEnginePath enables only non-dev engines without sidecar or bypass", () => {
  assert.equal(
    shouldUseCustomEnginePath({
      activeEngineId: "custom",
      hasSidecarItem: false,
      engineBypass: false
    }),
    true
  );
  assert.equal(
    shouldUseCustomEnginePath({
      activeEngineId: "dev",
      hasSidecarItem: false,
      engineBypass: false
    }),
    false
  );
  assert.equal(
    shouldUseCustomEnginePath({
      activeEngineId: null,
      hasSidecarItem: false,
      engineBypass: false
    }),
    false
  );
  assert.equal(
    shouldUseCustomEnginePath({
      activeEngineId: "custom",
      hasSidecarItem: true,
      engineBypass: false
    }),
    false
  );
  assert.equal(
    shouldUseCustomEnginePath({
      activeEngineId: "custom",
      hasSidecarItem: false,
      engineBypass: true
    }),
    false
  );
});
test("resolveUnitRequestTimestamp prefers dispatch time and ignores missing timestamps", () => {
  assert.equal(
    resolveUnitRequestTimestamp({
      requestDispatchedAt: 200,
      unitStartedAt: 100
    }),
    200
  );
  assert.equal(
    resolveUnitRequestTimestamp({
      unitStartedAt: 100
    }),
    100
  );
  assert.equal(
    resolveUnitRequestTimestamp({}),
    void 0
  );
});
test("decideCustomEngineRecovery maps pause recovery to manual attention", () => {
  assert.deepEqual(
    decideCustomEngineRecovery({
      outcome: "pause",
      reason: "needs review",
      unitId: "step-1",
      attempts: 4
    }),
    {
      action: "pause",
      turnError: "needs review"
    }
  );
  assert.deepEqual(
    decideCustomEngineRecovery({
      outcome: "pause",
      unitId: "step-1",
      attempts: 4
    }),
    {
      action: "pause",
      turnError: "custom-engine-verify-retry-exhausted"
    }
  );
});
test("decideCustomEngineRecovery maps skip recovery to a stop message", () => {
  assert.deepEqual(
    decideCustomEngineRecovery({
      outcome: "skip",
      unitId: "step-1",
      attempts: 4
    }),
    {
      action: "stop",
      stopMessage: "Custom workflow verification for step-1 requested skip after retry exhaustion, but the custom engine cannot reconcile skipped steps.",
      turnError: "custom-engine-verify-retry-exhausted"
    }
  );
});
test("decideCustomEngineRecovery maps stop and retry outcomes to exhausted stops", () => {
  assert.deepEqual(
    decideCustomEngineRecovery({
      outcome: "stop",
      reason: "blocked by policy",
      unitId: "step-1",
      attempts: 4
    }),
    {
      action: "stop",
      stopMessage: "blocked by policy",
      turnError: "custom-engine-verify-retry-exhausted"
    }
  );
  assert.deepEqual(
    decideCustomEngineRecovery({
      outcome: "retry",
      unitId: "step-1",
      attempts: 4
    }),
    {
      action: "stop",
      stopMessage: "Custom workflow verification for step-1 requested retry 4 times without passing.",
      turnError: "custom-engine-verify-retry-exhausted"
    }
  );
});
test("decideInfrastructureError returns stable stop and notification messages", () => {
  assert.deepEqual(
    decideInfrastructureError({
      code: "ENOSPC",
      errorMessage: "disk full"
    }),
    {
      notifyMessage: "Auto-mode stopped: infrastructure error ENOSPC \u2014 disk full",
      stopMessage: "Infrastructure error (ENOSPC): not recoverable by retry",
      turnStatus: "failed",
      failureClass: "execution"
    }
  );
});
test("decideModelPolicyBlocked returns pause notification and journal payload", () => {
  const reasons = [
    { provider: "provider-a", modelId: "model-a", reason: "tools denied" }
  ];
  assert.deepEqual(
    decideModelPolicyBlocked({
      unitType: "execute-task",
      unitId: "M001/S001/T001",
      errorMessage: "policy blocked",
      reasons
    }),
    {
      notifyMessage: "Auto-mode paused: model-policy denied dispatch for execute-task/M001/S001/T001. policy blocked",
      journalData: {
        unitType: "execute-task",
        unitId: "M001/S001/T001",
        status: "blocked",
        reason: "model-policy-dispatch-blocked",
        reasons
      },
      turnStatus: "paused",
      failureClass: "manual-attention"
    }
  );
});
test("decideDispatchNodeKind maps sidecar kinds before unit types", () => {
  assert.equal(decideDispatchNodeKind("execute-task", "hook"), "hook");
  assert.equal(decideDispatchNodeKind("execute-task", "triage"), "verification");
  assert.equal(decideDispatchNodeKind("execute-task", "quick-task"), "team-worker");
});
test("decideDispatchNodeKind maps workflow unit types to scheduler node kinds", () => {
  assert.equal(decideDispatchNodeKind("hook/pre-dispatch"), "hook");
  assert.equal(decideDispatchNodeKind("reactive-execute"), "subagent");
  assert.equal(decideDispatchNodeKind("gate-evaluate"), "verification");
  assert.equal(decideDispatchNodeKind("validate-milestone"), "verification");
  assert.equal(decideDispatchNodeKind("run-uat"), "verification");
  assert.equal(decideDispatchNodeKind("complete-slice"), "verification");
  assert.equal(decideDispatchNodeKind("replan-slice"), "reprocess");
  assert.equal(decideDispatchNodeKind("reassess-roadmap"), "reprocess");
  assert.equal(decideDispatchNodeKind("execute-task"), "unit");
});
test("formatDispatchExceptionSummary preserves error and non-error messages", () => {
  assert.equal(
    formatDispatchExceptionSummary({ error: new Error("unit failed") }),
    "exception:unit failed"
  );
  assert.equal(
    formatDispatchExceptionSummary({ error: "string failure" }),
    "exception:string failure"
  );
});
test("formatUnhandledDispatchErrorSummary truncates long messages", () => {
  assert.equal(
    formatUnhandledDispatchErrorSummary({ error: new Error("unexpected") }),
    "unhandled-error:unexpected"
  );
  const longMessage = "x".repeat(250);
  assert.equal(
    formatUnhandledDispatchErrorSummary({ error: longMessage }),
    `unhandled-error:${"x".repeat(200)}`
  );
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy93b3JrZmxvdy1rZXJuZWwudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFVuaXQgdGVzdHMgZm9yIHB1cmUgYXV0by1tb2RlIHdvcmtmbG93IGtlcm5lbCBkZWNpc2lvbnMuXG5cbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuXG5pbXBvcnQge1xuICBkZWNpZGVDb29sZG93blJlY292ZXJ5LFxuICBkZWNpZGVDdXN0b21FbmdpbmVSZWNvdmVyeSxcbiAgZGVjaWRlQ3VzdG9tRW5naW5lVmVyaWZ5UmV0cnksXG4gIGRlY2lkZURpc3BhdGNoTm9kZUtpbmQsXG4gIGRlY2lkZURpc3BhdGNoQ2xhaW0sXG4gIGRlY2lkZUVuZ2luZURpc3BhdGNoLFxuICBkZWNpZGVFbmdpbmVSZWNvbmNpbGUsXG4gIGRlY2lkZUZpbmFsaXplUmVzdWx0LFxuICBkZWNpZGVJbmZyYXN0cnVjdHVyZUVycm9yLFxuICBkZWNpZGVJdGVyYXRpb25FcnJvclJlY292ZXJ5LFxuICBkZWNpZGVNZW1vcnlQcmVzc3VyZSxcbiAgZGVjaWRlTW9kZWxQb2xpY3lCbG9ja2VkLFxuICBkZWNpZGVNaW5SZXF1ZXN0SW50ZXJ2YWwsXG4gIGRlY2lkZVdvcmtmbG93TG9vcCxcbiAgZm9ybWF0RGlzcGF0Y2hFeGNlcHRpb25TdW1tYXJ5LFxuICBmb3JtYXRVbmhhbmRsZWREaXNwYXRjaEVycm9yU3VtbWFyeSxcbiAgcmVzb2x2ZVVuaXRSZXF1ZXN0VGltZXN0YW1wLFxuICBzaG91bGRVc2VDdXN0b21FbmdpbmVQYXRoLFxufSBmcm9tIFwiLi4vYXV0by93b3JrZmxvdy1rZXJuZWwudHNcIjtcblxudGVzdChcImRlY2lkZVdvcmtmbG93TG9vcCBjb250aW51ZXMgd2hlbiBkaXNwYXRjaCBwcmVjb25kaXRpb25zIGFyZSB2YWxpZFwiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgZGVjaWRlV29ya2Zsb3dMb29wKHtcbiAgICAgIGFjdGl2ZTogdHJ1ZSxcbiAgICAgIGl0ZXJhdGlvbjogMSxcbiAgICAgIG1heEl0ZXJhdGlvbnM6IDUwMCxcbiAgICAgIGhhc0NvbW1hbmRDb250ZXh0OiB0cnVlLFxuICAgICAgc2Vzc2lvbkxvY2tWYWxpZDogdHJ1ZSxcbiAgICB9KSxcbiAgICB7IGFjdGlvbjogXCJjb250aW51ZVwiIH0sXG4gICk7XG59KTtcblxudGVzdChcImRlY2lkZVdvcmtmbG93TG9vcCBzdG9wcyBpbmFjdGl2ZSBzZXNzaW9ucyBiZWZvcmUgZGlzcGF0Y2hcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZVdvcmtmbG93TG9vcCh7XG4gICAgICBhY3RpdmU6IGZhbHNlLFxuICAgICAgaXRlcmF0aW9uOiAxLFxuICAgICAgbWF4SXRlcmF0aW9uczogNTAwLFxuICAgICAgaGFzQ29tbWFuZENvbnRleHQ6IHRydWUsXG4gICAgICBzZXNzaW9uTG9ja1ZhbGlkOiB0cnVlLFxuICAgIH0pLFxuICAgIHtcbiAgICAgIGFjdGlvbjogXCJzdG9wXCIsXG4gICAgICByZWFzb246IFwiaW5hY3RpdmVcIixcbiAgICAgIG1lc3NhZ2U6IFwiQXV0by1tb2RlIGlzIG5vdCBhY3RpdmUuXCIsXG4gICAgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlV29ya2Zsb3dMb29wIHN0b3BzIHJ1bmF3YXkgbG9vcHMgd2l0aCBhIHN0YWJsZSByZWFzb25cIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZVdvcmtmbG93TG9vcCh7XG4gICAgICBhY3RpdmU6IHRydWUsXG4gICAgICBpdGVyYXRpb246IDUwMSxcbiAgICAgIG1heEl0ZXJhdGlvbnM6IDUwMCxcbiAgICAgIGhhc0NvbW1hbmRDb250ZXh0OiB0cnVlLFxuICAgICAgc2Vzc2lvbkxvY2tWYWxpZDogdHJ1ZSxcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgcmVhc29uOiBcIm1heC1pdGVyYXRpb25zXCIsXG4gICAgICBtZXNzYWdlOiBcIlNhZmV0eTogbG9vcCBleGNlZWRlZCA1MDAgaXRlcmF0aW9ucy5cIixcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWNpZGVXb3JrZmxvd0xvb3Agc3RvcHMgd2hlbiBkaXNwYXRjaCBjYW5ub3QgY3JlYXRlIGEgY29tbWFuZCBzZXNzaW9uXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVXb3JrZmxvd0xvb3Aoe1xuICAgICAgYWN0aXZlOiB0cnVlLFxuICAgICAgaXRlcmF0aW9uOiAxLFxuICAgICAgbWF4SXRlcmF0aW9uczogNTAwLFxuICAgICAgaGFzQ29tbWFuZENvbnRleHQ6IGZhbHNlLFxuICAgICAgc2Vzc2lvbkxvY2tWYWxpZDogdHJ1ZSxcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgcmVhc29uOiBcIm1pc3NpbmctY29tbWFuZC1jb250ZXh0XCIsXG4gICAgICBtZXNzYWdlOiBcIkF1dG8tbW9kZSBoYXMgbm8gY29tbWFuZCBjb250ZXh0IGZvciBkaXNwYXRjaC5cIixcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWNpZGVXb3JrZmxvd0xvb3AgcHJlc2VydmVzIHNlc3Npb24gbG9jayBsb3NzIGRldGFpbFwiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgZGVjaWRlV29ya2Zsb3dMb29wKHtcbiAgICAgIGFjdGl2ZTogdHJ1ZSxcbiAgICAgIGl0ZXJhdGlvbjogMSxcbiAgICAgIG1heEl0ZXJhdGlvbnM6IDUwMCxcbiAgICAgIGhhc0NvbW1hbmRDb250ZXh0OiB0cnVlLFxuICAgICAgc2Vzc2lvbkxvY2tWYWxpZDogZmFsc2UsXG4gICAgICBzZXNzaW9uTG9ja1JlYXNvbjogXCJwaWQgbWlzbWF0Y2hcIixcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgcmVhc29uOiBcInNlc3Npb24tbG9jay1sb3N0XCIsXG4gICAgICBtZXNzYWdlOiBcIlNlc3Npb24gbG9jayBsb3N0OiBwaWQgbWlzbWF0Y2guXCIsXG4gICAgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlRGlzcGF0Y2hDbGFpbSBydW5zIHdpdGggYW4gb3BlbmVkIGRpc3BhdGNoIGlkXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVEaXNwYXRjaENsYWltKHsga2luZDogXCJvcGVuZWRcIiwgZGlzcGF0Y2hJZDogNDIgfSksXG4gICAgeyBhY3Rpb246IFwicnVuXCIsIGRpc3BhdGNoSWQ6IDQyIH0sXG4gICk7XG59KTtcblxudGVzdChcImRlY2lkZURpc3BhdGNoQ2xhaW0gcnVucyBkZWdyYWRlZCBkaXNwYXRjaGVzIHdpdGhvdXQgYSBsZWRnZXIgaWRcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZURpc3BhdGNoQ2xhaW0oeyBraW5kOiBcImRlZ3JhZGVkXCIgfSksXG4gICAgeyBhY3Rpb246IFwicnVuXCIsIGRpc3BhdGNoSWQ6IG51bGwgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlRGlzcGF0Y2hDbGFpbSBza2lwcyBjbGFpbWVkIHVuaXRzIHdpdGggYSBzdGFibGUgcmVhc29uXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVEaXNwYXRjaENsYWltKHsga2luZDogXCJza2lwXCIsIHJlYXNvbjogXCJhbHJlYWR5LWFjdGl2ZVwiIH0pLFxuICAgIHsgYWN0aW9uOiBcInNraXBcIiwgcmVhc29uOiBcImFscmVhZHktYWN0aXZlXCIgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlRW5naW5lRGlzcGF0Y2ggcHJlc2VydmVzIHN0b3AgcmVhc29ucyBhbmQgZGVmYXVsdHMgbWlzc2luZyBvbmVzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVFbmdpbmVEaXNwYXRjaCh7IGFjdGlvbjogXCJzdG9wXCIsIHJlYXNvbjogXCJkb25lXCIgfSksXG4gICAgeyBhY3Rpb246IFwic3RvcFwiLCByZWFzb246IFwiZG9uZVwiIH0sXG4gICk7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgZGVjaWRlRW5naW5lRGlzcGF0Y2goeyBhY3Rpb246IFwic3RvcFwiIH0pLFxuICAgIHsgYWN0aW9uOiBcInN0b3BcIiwgcmVhc29uOiBcIkVuZ2luZSBzdG9wcGVkXCIgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlRW5naW5lRGlzcGF0Y2ggcGFzc2VzIHRocm91Z2ggc2tpcCBhbmQgZGlzcGF0Y2ggYWN0aW9uc1wiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoZGVjaWRlRW5naW5lRGlzcGF0Y2goeyBhY3Rpb246IFwic2tpcFwiIH0pLCB7IGFjdGlvbjogXCJza2lwXCIgfSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZGVjaWRlRW5naW5lRGlzcGF0Y2goeyBhY3Rpb246IFwiZGlzcGF0Y2hcIiB9KSwgeyBhY3Rpb246IFwiZGlzcGF0Y2hcIiB9KTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlRmluYWxpemVSZXN1bHQgbWFwcyBicmVhayByZXN1bHRzIHRvIHN0b3AgZGVjaXNpb25zXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVGaW5hbGl6ZVJlc3VsdCh7IGFjdGlvbjogXCJicmVha1wiLCByZWFzb246IFwiZ2l0LWNsb3Nlb3V0LWZhaWx1cmVcIiB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgZmFpbHVyZUNsYXNzOiBcImdpdFwiLFxuICAgICAgbGVkZ2VyRXJyb3JTdW1tYXJ5OiBcImZpbmFsaXplLWJyZWFrOmdpdC1jbG9zZW91dC1mYWlsdXJlXCIsXG4gICAgICB0dXJuRXJyb3I6IFwiZmluYWxpemUtYnJlYWtcIixcbiAgICB9LFxuICApO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUZpbmFsaXplUmVzdWx0KHsgYWN0aW9uOiBcImJyZWFrXCIgfSksXG4gICAge1xuICAgICAgYWN0aW9uOiBcInN0b3BcIixcbiAgICAgIGZhaWx1cmVDbGFzczogXCJjbG9zZW91dFwiLFxuICAgICAgbGVkZ2VyRXJyb3JTdW1tYXJ5OiBcImZpbmFsaXplLWJyZWFrOnVua25vd25cIixcbiAgICAgIHR1cm5FcnJvcjogXCJmaW5hbGl6ZS1icmVha1wiLFxuICAgIH0sXG4gICk7XG59KTtcblxudGVzdChcImRlY2lkZUZpbmFsaXplUmVzdWx0IG1hcHMgY29udGludWUgYW5kIG5leHQgcmVzdWx0c1wiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgZGVjaWRlRmluYWxpemVSZXN1bHQoeyBhY3Rpb246IFwiY29udGludWVcIiB9KSxcbiAgICB7IGFjdGlvbjogXCJyZXRyeVwiLCBsZWRnZXJFcnJvclN1bW1hcnk6IFwiZmluYWxpemUtcmV0cnlcIiB9LFxuICApO1xuICBhc3NlcnQuZGVlcEVxdWFsKGRlY2lkZUZpbmFsaXplUmVzdWx0KHsgYWN0aW9uOiBcIm5leHRcIiB9KSwgeyBhY3Rpb246IFwiY29tcGxldGVcIiB9KTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlRW5naW5lUmVjb25jaWxlIG1hcHMgdGVybWluYWwgb3V0Y29tZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUVuZ2luZVJlY29uY2lsZSh7IG91dGNvbWU6IFwibWlsZXN0b25lLWNvbXBsZXRlXCIgfSksXG4gICAgeyBhY3Rpb246IFwiY29tcGxldGUtd29ya2Zsb3dcIiwgc3RvcFJlYXNvbjogXCJXb3JrZmxvdyBjb21wbGV0ZVwiIH0sXG4gICk7XG4gIGFzc2VydC5kZWVwRXF1YWwoZGVjaWRlRW5naW5lUmVjb25jaWxlKHsgb3V0Y29tZTogXCJwYXVzZVwiIH0pLCB7IGFjdGlvbjogXCJwYXVzZVwiIH0pO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUVuZ2luZVJlY29uY2lsZSh7IG91dGNvbWU6IFwic3RvcFwiLCByZWFzb246IFwiYmxvY2tlZFwiIH0pLFxuICAgIHsgYWN0aW9uOiBcInN0b3BcIiwgcmVhc29uOiBcImJsb2NrZWRcIiB9LFxuICApO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUVuZ2luZVJlY29uY2lsZSh7IG91dGNvbWU6IFwic3RvcFwiIH0pLFxuICAgIHsgYWN0aW9uOiBcInN0b3BcIiwgcmVhc29uOiBcIkVuZ2luZSBzdG9wcGVkXCIgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlRW5naW5lUmVjb25jaWxlIHBhc3NlcyB0aHJvdWdoIGNvbnRpbnVlIG91dGNvbWVzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChkZWNpZGVFbmdpbmVSZWNvbmNpbGUoeyBvdXRjb21lOiBcImNvbnRpbnVlXCIgfSksIHsgYWN0aW9uOiBcImNvbnRpbnVlXCIgfSk7XG59KTtcblxudGVzdChcImRlY2lkZU1lbW9yeVByZXNzdXJlIGNvbnRpbnVlcyB3aGVuIGhlYXAgcHJlc3N1cmUgaXMgYmVsb3cgdGhyZXNob2xkXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVNZW1vcnlQcmVzc3VyZSh7XG4gICAgICBwcmVzc3VyZWQ6IGZhbHNlLFxuICAgICAgaGVhcE1COiA1MTIsXG4gICAgICBsaW1pdE1COiA0MDk2LFxuICAgICAgcGN0OiAwLjEyNSxcbiAgICAgIGl0ZXJhdGlvbjogNSxcbiAgICB9KSxcbiAgICB7IGFjdGlvbjogXCJjb250aW51ZVwiIH0sXG4gICk7XG59KTtcblxudGVzdChcImRlY2lkZU1lbW9yeVByZXNzdXJlIHJldHVybnMgc3RhYmxlIHN0b3AgbWVzc2FnZXMgd2hlbiBwcmVzc3VyZWRcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZU1lbW9yeVByZXNzdXJlKHtcbiAgICAgIHByZXNzdXJlZDogdHJ1ZSxcbiAgICAgIGhlYXBNQjogMzgwMCxcbiAgICAgIGxpbWl0TUI6IDQwOTYsXG4gICAgICBwY3Q6IDAuOTI3LFxuICAgICAgaXRlcmF0aW9uOiAxMCxcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgd2FybmluZ01lc3NhZ2U6XG4gICAgICAgIFwiTWVtb3J5IHByZXNzdXJlOiAzODAwTUIgLyA0MDk2TUIgKDkzJSkgXHUyMDE0IHN0b3BwaW5nIGF1dG8tbW9kZSB0byBwcmV2ZW50IE9PTSBraWxsXCIsXG4gICAgICBzdG9wTWVzc2FnZTpcbiAgICAgICAgXCJNZW1vcnkgcHJlc3N1cmU6IGhlYXAgYXQgMzgwME1CIC8gNDA5Nk1CICg5MyUpLiBcIiArXG4gICAgICAgIFwiU3RvcHBpbmcgZ3JhY2VmdWxseSB0byBwcmV2ZW50IE9PTSBraWxsIGFmdGVyIDEwIGl0ZXJhdGlvbnMuIFwiICtcbiAgICAgICAgXCJSZXN1bWUgd2l0aCAvZ3NkIGF1dG8gdG8gY29udGludWUgZnJvbSB3aGVyZSB5b3UgbGVmdCBvZmYuXCIsXG4gICAgICB0dXJuRXJyb3I6IFwibWVtb3J5LXByZXNzdXJlXCIsXG4gICAgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlTWluUmVxdWVzdEludGVydmFsIGNvbnRpbnVlcyB3aGVuIHRocm90dGxpbmcgaXMgZGlzYWJsZWQgb3IgdW51c2VkXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVNaW5SZXF1ZXN0SW50ZXJ2YWwoe1xuICAgICAgbWluSW50ZXJ2YWxNczogMCxcbiAgICAgIGxhc3RSZXF1ZXN0VGltZXN0YW1wOiAxMDAwLFxuICAgICAgbm93TXM6IDEwMDEsXG4gICAgfSksXG4gICAgeyBhY3Rpb246IFwiY29udGludWVcIiB9LFxuICApO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZU1pblJlcXVlc3RJbnRlcnZhbCh7XG4gICAgICBtaW5JbnRlcnZhbE1zOiA1MDAwLFxuICAgICAgbGFzdFJlcXVlc3RUaW1lc3RhbXA6IDAsXG4gICAgICBub3dNczogMTAwMSxcbiAgICB9KSxcbiAgICB7IGFjdGlvbjogXCJjb250aW51ZVwiIH0sXG4gICk7XG59KTtcblxudGVzdChcImRlY2lkZU1pblJlcXVlc3RJbnRlcnZhbCByZXR1cm5zIHJlbWFpbmluZyB3YWl0IGJ1ZGdldFwiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgZGVjaWRlTWluUmVxdWVzdEludGVydmFsKHtcbiAgICAgIG1pbkludGVydmFsTXM6IDUwMDAsXG4gICAgICBsYXN0UmVxdWVzdFRpbWVzdGFtcDogMTBfMDAwLFxuICAgICAgbm93TXM6IDEyXzUwMCxcbiAgICB9KSxcbiAgICB7IGFjdGlvbjogXCJ3YWl0XCIsIHdhaXRNczogMjUwMCB9LFxuICApO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZU1pblJlcXVlc3RJbnRlcnZhbCh7XG4gICAgICBtaW5JbnRlcnZhbE1zOiA1MDAwLFxuICAgICAgbGFzdFJlcXVlc3RUaW1lc3RhbXA6IDEwXzAwMCxcbiAgICAgIG5vd01zOiAxNV8wMDAsXG4gICAgfSksXG4gICAgeyBhY3Rpb246IFwiY29udGludWVcIiB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWNpZGVDb29sZG93blJlY292ZXJ5IHVzZXMgYm91bmRlZCByZXRyeS1hZnRlciBoaW50cyB3aXRoIGEgc21hbGwgYnVmZmVyXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVDb29sZG93blJlY292ZXJ5KHtcbiAgICAgIGNvbnNlY3V0aXZlQ29vbGRvd25zOiAyLFxuICAgICAgbWF4Q29vbGRvd25SZXRyaWVzOiA1LFxuICAgICAgcmV0cnlBZnRlck1zOiAzMF8wMDAsXG4gICAgICBmYWxsYmFja1dhaXRNczogMTVfMDAwLFxuICAgIH0pLFxuICAgIHtcbiAgICAgIGFjdGlvbjogXCJ3YWl0XCIsXG4gICAgICB3YWl0TXM6IDMwXzUwMCxcbiAgICAgIG5vdGlmeU1lc3NhZ2U6IFwiQ3JlZGVudGlhbHMgaW4gY29vbGRvd24gKDIvNSkgXHUyMDE0IHdhaXRpbmcgMzFzIGJlZm9yZSByZXRyeWluZy5cIixcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWNpZGVDb29sZG93blJlY292ZXJ5IHVzZXMgZmFsbGJhY2sgd2FpdCB3aGVuIHJldHJ5LWFmdGVyIGlzIG1pc3Npbmcgb3Igb3V0IG9mIHJhbmdlXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVDb29sZG93blJlY292ZXJ5KHtcbiAgICAgIGNvbnNlY3V0aXZlQ29vbGRvd25zOiAxLFxuICAgICAgbWF4Q29vbGRvd25SZXRyaWVzOiA1LFxuICAgICAgZmFsbGJhY2tXYWl0TXM6IDE1XzAwMCxcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwid2FpdFwiLFxuICAgICAgd2FpdE1zOiAxNV8wMDAsXG4gICAgICBub3RpZnlNZXNzYWdlOiBcIkNyZWRlbnRpYWxzIGluIGNvb2xkb3duICgxLzUpIFx1MjAxNCB3YWl0aW5nIDE1cyBiZWZvcmUgcmV0cnlpbmcuXCIsXG4gICAgfSxcbiAgKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVDb29sZG93blJlY292ZXJ5KHtcbiAgICAgIGNvbnNlY3V0aXZlQ29vbGRvd25zOiAxLFxuICAgICAgbWF4Q29vbGRvd25SZXRyaWVzOiA1LFxuICAgICAgcmV0cnlBZnRlck1zOiA5MF8wMDAsXG4gICAgICBmYWxsYmFja1dhaXRNczogMTVfMDAwLFxuICAgIH0pLFxuICAgIHtcbiAgICAgIGFjdGlvbjogXCJ3YWl0XCIsXG4gICAgICB3YWl0TXM6IDE1XzAwMCxcbiAgICAgIG5vdGlmeU1lc3NhZ2U6IFwiQ3JlZGVudGlhbHMgaW4gY29vbGRvd24gKDEvNSkgXHUyMDE0IHdhaXRpbmcgMTVzIGJlZm9yZSByZXRyeWluZy5cIixcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWNpZGVDb29sZG93blJlY292ZXJ5IHN0b3BzIGFmdGVyIHJldHJ5IGJ1ZGdldCBpcyBleGNlZWRlZFwiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgZGVjaWRlQ29vbGRvd25SZWNvdmVyeSh7XG4gICAgICBjb25zZWN1dGl2ZUNvb2xkb3duczogNixcbiAgICAgIG1heENvb2xkb3duUmV0cmllczogNSxcbiAgICAgIHJldHJ5QWZ0ZXJNczogMzBfMDAwLFxuICAgICAgZmFsbGJhY2tXYWl0TXM6IDE1XzAwMCxcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgbm90aWZ5TWVzc2FnZTpcbiAgICAgICAgXCJBdXRvLW1vZGUgc3RvcHBlZDogNiBjb25zZWN1dGl2ZSBjcmVkZW50aWFsIGNvb2xkb3ducyBcdTIwMTQgXCIgK1xuICAgICAgICBcInJhdGUgbGltaXQgb3IgcXVvdGEgbWF5IGJlIHBlcnNpc3RlbnRseSBleGhhdXN0ZWQuXCIsXG4gICAgICBzdG9wTWVzc2FnZTogXCI2IGNvbnNlY3V0aXZlIGNyZWRlbnRpYWwgY29vbGRvd25zIGV4Y2VlZGVkIHJldHJ5IGJ1ZGdldFwiLFxuICAgIH0sXG4gICk7XG59KTtcblxudGVzdChcImRlY2lkZUl0ZXJhdGlvbkVycm9yUmVjb3ZlcnkgcmV0cmllcyBmaXJzdCBpdGVyYXRpb24gZXJyb3JcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUl0ZXJhdGlvbkVycm9yUmVjb3Zlcnkoe1xuICAgICAgY29uc2VjdXRpdmVFcnJvcnM6IDEsXG4gICAgICByZWNlbnRFcnJvck1lc3NhZ2VzOiBbXCJ0ZW1wb3JhcnkgZmFpbHVyZVwiXSxcbiAgICAgIGN1cnJlbnRFcnJvck1lc3NhZ2U6IFwidGVtcG9yYXJ5IGZhaWx1cmVcIixcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwicmV0cnlcIixcbiAgICAgIG5vdGlmeU1lc3NhZ2U6IFwiSXRlcmF0aW9uIGVycm9yOiB0ZW1wb3JhcnkgZmFpbHVyZS4gUmV0cnlpbmcuXCIsXG4gICAgICB0dXJuU3RhdHVzOiBcInJldHJ5XCIsXG4gICAgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlSXRlcmF0aW9uRXJyb3JSZWNvdmVyeSBpbnZhbGlkYXRlcyBjYWNoZXMgb24gc2Vjb25kIGNvbnNlY3V0aXZlIGVycm9yXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVJdGVyYXRpb25FcnJvclJlY292ZXJ5KHtcbiAgICAgIGNvbnNlY3V0aXZlRXJyb3JzOiAyLFxuICAgICAgcmVjZW50RXJyb3JNZXNzYWdlczogW1widGVtcG9yYXJ5IGZhaWx1cmVcIiwgXCJzdGlsbCBmYWlsaW5nXCJdLFxuICAgICAgY3VycmVudEVycm9yTWVzc2FnZTogXCJzdGlsbCBmYWlsaW5nXCIsXG4gICAgfSksXG4gICAge1xuICAgICAgYWN0aW9uOiBcImludmFsaWRhdGUtYW5kLXJldHJ5XCIsXG4gICAgICBub3RpZnlNZXNzYWdlOlxuICAgICAgICBcIkl0ZXJhdGlvbiBlcnJvciAoYXR0ZW1wdCAyKTogc3RpbGwgZmFpbGluZy4gSW52YWxpZGF0aW5nIGNhY2hlcyBhbmQgcmV0cnlpbmcuXCIsXG4gICAgICB0dXJuU3RhdHVzOiBcInJldHJ5XCIsXG4gICAgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlSXRlcmF0aW9uRXJyb3JSZWNvdmVyeSBzdG9wcyBvbiB0aGlyZCBjb25zZWN1dGl2ZSBlcnJvciB3aXRoIGhpc3RvcnlcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUl0ZXJhdGlvbkVycm9yUmVjb3Zlcnkoe1xuICAgICAgY29uc2VjdXRpdmVFcnJvcnM6IDMsXG4gICAgICByZWNlbnRFcnJvck1lc3NhZ2VzOiBbXCJmaXJzdFwiLCBcInNlY29uZFwiLCBcInRoaXJkXCJdLFxuICAgICAgY3VycmVudEVycm9yTWVzc2FnZTogXCJ0aGlyZFwiLFxuICAgIH0pLFxuICAgIHtcbiAgICAgIGFjdGlvbjogXCJzdG9wXCIsXG4gICAgICBub3RpZnlNZXNzYWdlOlxuICAgICAgICBcIkF1dG8tbW9kZSBzdG9wcGVkOiAzIGNvbnNlY3V0aXZlIGl0ZXJhdGlvbiBmYWlsdXJlczpcXG5cIiArXG4gICAgICAgIFwiICAxLiBmaXJzdFxcblwiICtcbiAgICAgICAgXCIgIDIuIHNlY29uZFxcblwiICtcbiAgICAgICAgXCIgIDMuIHRoaXJkXCIsXG4gICAgICBzdG9wTWVzc2FnZTogXCIzIGNvbnNlY3V0aXZlIGl0ZXJhdGlvbiBmYWlsdXJlc1wiLFxuICAgICAgdHVyblN0YXR1czogXCJmYWlsZWRcIixcbiAgICB9LFxuICApO1xufSk7XG5cbnRlc3QoXCJkZWNpZGVDdXN0b21FbmdpbmVWZXJpZnlSZXRyeSByZXRyaWVzIHVudGlsIHRoZSByZXRyeSBidWRnZXQgaXMgZXhjZWVkZWRcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUN1c3RvbUVuZ2luZVZlcmlmeVJldHJ5KHsgYXR0ZW1wdHM6IDMsIG1heFJldHJpZXM6IDMgfSksXG4gICAgeyBhY3Rpb246IFwicmV0cnlcIiB9LFxuICApO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUN1c3RvbUVuZ2luZVZlcmlmeVJldHJ5KHsgYXR0ZW1wdHM6IDQsIG1heFJldHJpZXM6IDMgfSksXG4gICAgeyBhY3Rpb246IFwicmVjb3ZlclwiIH0sXG4gICk7XG59KTtcblxudGVzdChcInNob3VsZFVzZUN1c3RvbUVuZ2luZVBhdGggZW5hYmxlcyBvbmx5IG5vbi1kZXYgZW5naW5lcyB3aXRob3V0IHNpZGVjYXIgb3IgYnlwYXNzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHNob3VsZFVzZUN1c3RvbUVuZ2luZVBhdGgoe1xuICAgICAgYWN0aXZlRW5naW5lSWQ6IFwiY3VzdG9tXCIsXG4gICAgICBoYXNTaWRlY2FySXRlbTogZmFsc2UsXG4gICAgICBlbmdpbmVCeXBhc3M6IGZhbHNlLFxuICAgIH0pLFxuICAgIHRydWUsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBzaG91bGRVc2VDdXN0b21FbmdpbmVQYXRoKHtcbiAgICAgIGFjdGl2ZUVuZ2luZUlkOiBcImRldlwiLFxuICAgICAgaGFzU2lkZWNhckl0ZW06IGZhbHNlLFxuICAgICAgZW5naW5lQnlwYXNzOiBmYWxzZSxcbiAgICB9KSxcbiAgICBmYWxzZSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHNob3VsZFVzZUN1c3RvbUVuZ2luZVBhdGgoe1xuICAgICAgYWN0aXZlRW5naW5lSWQ6IG51bGwsXG4gICAgICBoYXNTaWRlY2FySXRlbTogZmFsc2UsXG4gICAgICBlbmdpbmVCeXBhc3M6IGZhbHNlLFxuICAgIH0pLFxuICAgIGZhbHNlLFxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgc2hvdWxkVXNlQ3VzdG9tRW5naW5lUGF0aCh7XG4gICAgICBhY3RpdmVFbmdpbmVJZDogXCJjdXN0b21cIixcbiAgICAgIGhhc1NpZGVjYXJJdGVtOiB0cnVlLFxuICAgICAgZW5naW5lQnlwYXNzOiBmYWxzZSxcbiAgICB9KSxcbiAgICBmYWxzZSxcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHNob3VsZFVzZUN1c3RvbUVuZ2luZVBhdGgoe1xuICAgICAgYWN0aXZlRW5naW5lSWQ6IFwiY3VzdG9tXCIsXG4gICAgICBoYXNTaWRlY2FySXRlbTogZmFsc2UsXG4gICAgICBlbmdpbmVCeXBhc3M6IHRydWUsXG4gICAgfSksXG4gICAgZmFsc2UsXG4gICk7XG59KTtcblxudGVzdChcInJlc29sdmVVbml0UmVxdWVzdFRpbWVzdGFtcCBwcmVmZXJzIGRpc3BhdGNoIHRpbWUgYW5kIGlnbm9yZXMgbWlzc2luZyB0aW1lc3RhbXBzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHJlc29sdmVVbml0UmVxdWVzdFRpbWVzdGFtcCh7XG4gICAgICByZXF1ZXN0RGlzcGF0Y2hlZEF0OiAyMDAsXG4gICAgICB1bml0U3RhcnRlZEF0OiAxMDAsXG4gICAgfSksXG4gICAgMjAwLFxuICApO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgcmVzb2x2ZVVuaXRSZXF1ZXN0VGltZXN0YW1wKHtcbiAgICAgIHVuaXRTdGFydGVkQXQ6IDEwMCxcbiAgICB9KSxcbiAgICAxMDAsXG4gICk7XG4gIGFzc2VydC5lcXVhbChcbiAgICByZXNvbHZlVW5pdFJlcXVlc3RUaW1lc3RhbXAoe30pLFxuICAgIHVuZGVmaW5lZCxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlQ3VzdG9tRW5naW5lUmVjb3ZlcnkgbWFwcyBwYXVzZSByZWNvdmVyeSB0byBtYW51YWwgYXR0ZW50aW9uXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVDdXN0b21FbmdpbmVSZWNvdmVyeSh7XG4gICAgICBvdXRjb21lOiBcInBhdXNlXCIsXG4gICAgICByZWFzb246IFwibmVlZHMgcmV2aWV3XCIsXG4gICAgICB1bml0SWQ6IFwic3RlcC0xXCIsXG4gICAgICBhdHRlbXB0czogNCxcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwicGF1c2VcIixcbiAgICAgIHR1cm5FcnJvcjogXCJuZWVkcyByZXZpZXdcIixcbiAgICB9LFxuICApO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUN1c3RvbUVuZ2luZVJlY292ZXJ5KHtcbiAgICAgIG91dGNvbWU6IFwicGF1c2VcIixcbiAgICAgIHVuaXRJZDogXCJzdGVwLTFcIixcbiAgICAgIGF0dGVtcHRzOiA0LFxuICAgIH0pLFxuICAgIHtcbiAgICAgIGFjdGlvbjogXCJwYXVzZVwiLFxuICAgICAgdHVybkVycm9yOiBcImN1c3RvbS1lbmdpbmUtdmVyaWZ5LXJldHJ5LWV4aGF1c3RlZFwiLFxuICAgIH0sXG4gICk7XG59KTtcblxudGVzdChcImRlY2lkZUN1c3RvbUVuZ2luZVJlY292ZXJ5IG1hcHMgc2tpcCByZWNvdmVyeSB0byBhIHN0b3AgbWVzc2FnZVwiLCAoKSA9PiB7XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgZGVjaWRlQ3VzdG9tRW5naW5lUmVjb3Zlcnkoe1xuICAgICAgb3V0Y29tZTogXCJza2lwXCIsXG4gICAgICB1bml0SWQ6IFwic3RlcC0xXCIsXG4gICAgICBhdHRlbXB0czogNCxcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgc3RvcE1lc3NhZ2U6XG4gICAgICAgIFwiQ3VzdG9tIHdvcmtmbG93IHZlcmlmaWNhdGlvbiBmb3Igc3RlcC0xIHJlcXVlc3RlZCBza2lwIGFmdGVyIHJldHJ5IGV4aGF1c3Rpb24sIGJ1dCB0aGUgY3VzdG9tIGVuZ2luZSBjYW5ub3QgcmVjb25jaWxlIHNraXBwZWQgc3RlcHMuXCIsXG4gICAgICB0dXJuRXJyb3I6IFwiY3VzdG9tLWVuZ2luZS12ZXJpZnktcmV0cnktZXhoYXVzdGVkXCIsXG4gICAgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlQ3VzdG9tRW5naW5lUmVjb3ZlcnkgbWFwcyBzdG9wIGFuZCByZXRyeSBvdXRjb21lcyB0byBleGhhdXN0ZWQgc3RvcHNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUN1c3RvbUVuZ2luZVJlY292ZXJ5KHtcbiAgICAgIG91dGNvbWU6IFwic3RvcFwiLFxuICAgICAgcmVhc29uOiBcImJsb2NrZWQgYnkgcG9saWN5XCIsXG4gICAgICB1bml0SWQ6IFwic3RlcC0xXCIsXG4gICAgICBhdHRlbXB0czogNCxcbiAgICB9KSxcbiAgICB7XG4gICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgc3RvcE1lc3NhZ2U6IFwiYmxvY2tlZCBieSBwb2xpY3lcIixcbiAgICAgIHR1cm5FcnJvcjogXCJjdXN0b20tZW5naW5lLXZlcmlmeS1yZXRyeS1leGhhdXN0ZWRcIixcbiAgICB9LFxuICApO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRlY2lkZUN1c3RvbUVuZ2luZVJlY292ZXJ5KHtcbiAgICAgIG91dGNvbWU6IFwicmV0cnlcIixcbiAgICAgIHVuaXRJZDogXCJzdGVwLTFcIixcbiAgICAgIGF0dGVtcHRzOiA0LFxuICAgIH0pLFxuICAgIHtcbiAgICAgIGFjdGlvbjogXCJzdG9wXCIsXG4gICAgICBzdG9wTWVzc2FnZTogXCJDdXN0b20gd29ya2Zsb3cgdmVyaWZpY2F0aW9uIGZvciBzdGVwLTEgcmVxdWVzdGVkIHJldHJ5IDQgdGltZXMgd2l0aG91dCBwYXNzaW5nLlwiLFxuICAgICAgdHVybkVycm9yOiBcImN1c3RvbS1lbmdpbmUtdmVyaWZ5LXJldHJ5LWV4aGF1c3RlZFwiLFxuICAgIH0sXG4gICk7XG59KTtcblxudGVzdChcImRlY2lkZUluZnJhc3RydWN0dXJlRXJyb3IgcmV0dXJucyBzdGFibGUgc3RvcCBhbmQgbm90aWZpY2F0aW9uIG1lc3NhZ2VzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmRlZXBFcXVhbChcbiAgICBkZWNpZGVJbmZyYXN0cnVjdHVyZUVycm9yKHtcbiAgICAgIGNvZGU6IFwiRU5PU1BDXCIsXG4gICAgICBlcnJvck1lc3NhZ2U6IFwiZGlzayBmdWxsXCIsXG4gICAgfSksXG4gICAge1xuICAgICAgbm90aWZ5TWVzc2FnZTogXCJBdXRvLW1vZGUgc3RvcHBlZDogaW5mcmFzdHJ1Y3R1cmUgZXJyb3IgRU5PU1BDIFx1MjAxNCBkaXNrIGZ1bGxcIixcbiAgICAgIHN0b3BNZXNzYWdlOiBcIkluZnJhc3RydWN0dXJlIGVycm9yIChFTk9TUEMpOiBub3QgcmVjb3ZlcmFibGUgYnkgcmV0cnlcIixcbiAgICAgIHR1cm5TdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgICBmYWlsdXJlQ2xhc3M6IFwiZXhlY3V0aW9uXCIsXG4gICAgfSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGVjaWRlTW9kZWxQb2xpY3lCbG9ja2VkIHJldHVybnMgcGF1c2Ugbm90aWZpY2F0aW9uIGFuZCBqb3VybmFsIHBheWxvYWRcIiwgKCkgPT4ge1xuICBjb25zdCByZWFzb25zID0gW1xuICAgIHsgcHJvdmlkZXI6IFwicHJvdmlkZXItYVwiLCBtb2RlbElkOiBcIm1vZGVsLWFcIiwgcmVhc29uOiBcInRvb2xzIGRlbmllZFwiIH0sXG4gIF07XG4gIGFzc2VydC5kZWVwRXF1YWwoXG4gICAgZGVjaWRlTW9kZWxQb2xpY3lCbG9ja2VkKHtcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAwMS9UMDAxXCIsXG4gICAgICBlcnJvck1lc3NhZ2U6IFwicG9saWN5IGJsb2NrZWRcIixcbiAgICAgIHJlYXNvbnMsXG4gICAgfSksXG4gICAge1xuICAgICAgbm90aWZ5TWVzc2FnZTpcbiAgICAgICAgXCJBdXRvLW1vZGUgcGF1c2VkOiBtb2RlbC1wb2xpY3kgZGVuaWVkIGRpc3BhdGNoIGZvciBleGVjdXRlLXRhc2svTTAwMS9TMDAxL1QwMDEuIHBvbGljeSBibG9ja2VkXCIsXG4gICAgICBqb3VybmFsRGF0YToge1xuICAgICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgICAgdW5pdElkOiBcIk0wMDEvUzAwMS9UMDAxXCIsXG4gICAgICAgIHN0YXR1czogXCJibG9ja2VkXCIsXG4gICAgICAgIHJlYXNvbjogXCJtb2RlbC1wb2xpY3ktZGlzcGF0Y2gtYmxvY2tlZFwiLFxuICAgICAgICByZWFzb25zLFxuICAgICAgfSxcbiAgICAgIHR1cm5TdGF0dXM6IFwicGF1c2VkXCIsXG4gICAgICBmYWlsdXJlQ2xhc3M6IFwibWFudWFsLWF0dGVudGlvblwiLFxuICAgIH0sXG4gICk7XG59KTtcblxudGVzdChcImRlY2lkZURpc3BhdGNoTm9kZUtpbmQgbWFwcyBzaWRlY2FyIGtpbmRzIGJlZm9yZSB1bml0IHR5cGVzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGRlY2lkZURpc3BhdGNoTm9kZUtpbmQoXCJleGVjdXRlLXRhc2tcIiwgXCJob29rXCIpLCBcImhvb2tcIik7XG4gIGFzc2VydC5lcXVhbChkZWNpZGVEaXNwYXRjaE5vZGVLaW5kKFwiZXhlY3V0ZS10YXNrXCIsIFwidHJpYWdlXCIpLCBcInZlcmlmaWNhdGlvblwiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlY2lkZURpc3BhdGNoTm9kZUtpbmQoXCJleGVjdXRlLXRhc2tcIiwgXCJxdWljay10YXNrXCIpLCBcInRlYW0td29ya2VyXCIpO1xufSk7XG5cbnRlc3QoXCJkZWNpZGVEaXNwYXRjaE5vZGVLaW5kIG1hcHMgd29ya2Zsb3cgdW5pdCB0eXBlcyB0byBzY2hlZHVsZXIgbm9kZSBraW5kc1wiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChkZWNpZGVEaXNwYXRjaE5vZGVLaW5kKFwiaG9vay9wcmUtZGlzcGF0Y2hcIiksIFwiaG9va1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGRlY2lkZURpc3BhdGNoTm9kZUtpbmQoXCJyZWFjdGl2ZS1leGVjdXRlXCIpLCBcInN1YmFnZW50XCIpO1xuICBhc3NlcnQuZXF1YWwoZGVjaWRlRGlzcGF0Y2hOb2RlS2luZChcImdhdGUtZXZhbHVhdGVcIiksIFwidmVyaWZpY2F0aW9uXCIpO1xuICBhc3NlcnQuZXF1YWwoZGVjaWRlRGlzcGF0Y2hOb2RlS2luZChcInZhbGlkYXRlLW1pbGVzdG9uZVwiKSwgXCJ2ZXJpZmljYXRpb25cIik7XG4gIGFzc2VydC5lcXVhbChkZWNpZGVEaXNwYXRjaE5vZGVLaW5kKFwicnVuLXVhdFwiKSwgXCJ2ZXJpZmljYXRpb25cIik7XG4gIGFzc2VydC5lcXVhbChkZWNpZGVEaXNwYXRjaE5vZGVLaW5kKFwiY29tcGxldGUtc2xpY2VcIiksIFwidmVyaWZpY2F0aW9uXCIpO1xuICBhc3NlcnQuZXF1YWwoZGVjaWRlRGlzcGF0Y2hOb2RlS2luZChcInJlcGxhbi1zbGljZVwiKSwgXCJyZXByb2Nlc3NcIik7XG4gIGFzc2VydC5lcXVhbChkZWNpZGVEaXNwYXRjaE5vZGVLaW5kKFwicmVhc3Nlc3Mtcm9hZG1hcFwiKSwgXCJyZXByb2Nlc3NcIik7XG4gIGFzc2VydC5lcXVhbChkZWNpZGVEaXNwYXRjaE5vZGVLaW5kKFwiZXhlY3V0ZS10YXNrXCIpLCBcInVuaXRcIik7XG59KTtcblxudGVzdChcImZvcm1hdERpc3BhdGNoRXhjZXB0aW9uU3VtbWFyeSBwcmVzZXJ2ZXMgZXJyb3IgYW5kIG5vbi1lcnJvciBtZXNzYWdlc1wiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChcbiAgICBmb3JtYXREaXNwYXRjaEV4Y2VwdGlvblN1bW1hcnkoeyBlcnJvcjogbmV3IEVycm9yKFwidW5pdCBmYWlsZWRcIikgfSksXG4gICAgXCJleGNlcHRpb246dW5pdCBmYWlsZWRcIixcbiAgKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIGZvcm1hdERpc3BhdGNoRXhjZXB0aW9uU3VtbWFyeSh7IGVycm9yOiBcInN0cmluZyBmYWlsdXJlXCIgfSksXG4gICAgXCJleGNlcHRpb246c3RyaW5nIGZhaWx1cmVcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZm9ybWF0VW5oYW5kbGVkRGlzcGF0Y2hFcnJvclN1bW1hcnkgdHJ1bmNhdGVzIGxvbmcgbWVzc2FnZXNcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZm9ybWF0VW5oYW5kbGVkRGlzcGF0Y2hFcnJvclN1bW1hcnkoeyBlcnJvcjogbmV3IEVycm9yKFwidW5leHBlY3RlZFwiKSB9KSxcbiAgICBcInVuaGFuZGxlZC1lcnJvcjp1bmV4cGVjdGVkXCIsXG4gICk7XG4gIGNvbnN0IGxvbmdNZXNzYWdlID0gXCJ4XCIucmVwZWF0KDI1MCk7XG4gIGFzc2VydC5lcXVhbChcbiAgICBmb3JtYXRVbmhhbmRsZWREaXNwYXRjaEVycm9yU3VtbWFyeSh7IGVycm9yOiBsb25nTWVzc2FnZSB9KSxcbiAgICBgdW5oYW5kbGVkLWVycm9yOiR7XCJ4XCIucmVwZWF0KDIwMCl9YCxcbiAgKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsT0FBTyxZ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
