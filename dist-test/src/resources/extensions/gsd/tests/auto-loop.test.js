import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAgentEnd,
  resolveAgentEndCancelled,
  _resetPendingResolve,
  _hasPendingResolveForTest,
  _setSessionSwitchInFlight,
  _markSessionSwitchAbortGraceWindow,
  _clearSessionSwitchAbortGraceWindow,
  _consumePendingSwitchCancellation,
  isSessionSwitchInFlight,
  isSessionSwitchAbortGraceActive
} from "../auto/resolve.js";
import { runUnit, shouldDeferUnitFailsafeTimeout } from "../auto/run-unit.js";
import { writeUnitRuntimeRecord, readUnitRuntimeRecord } from "../unit-runtime.js";
import { autoLoop } from "../auto/loop.js";
import { runDispatch, runUnitPhase } from "../auto/phases.js";
import { detectStuck } from "../auto/detect-stuck.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import { ModelPolicyDispatchBlockedError } from "../auto-model-selection.js";
function makeEvent(messages = [{ role: "assistant" }]) {
  return { messages };
}
async function drainMicrotasks(turns = 20) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}
async function waitForMicrotasks(condition, label, turns = 500) {
  for (let i = 0; i < turns; i++) {
    if (condition()) return;
    await Promise.resolve();
  }
  assert.fail(`Timed out waiting for ${label}`);
}
function makeMockSession(opts) {
  const session = {
    active: true,
    verbose: false,
    basePath: process.cwd(),
    cmdCtx: {
      newSession: (options) => {
        opts?.onNewSessionStart?.(session);
        if (opts?.newSessionThrows) {
          return Promise.reject(new Error(opts.newSessionThrows));
        }
        const result = opts?.newSessionResult ?? { cancelled: false };
        const delay = opts?.newSessionDelayMs ?? 0;
        if (delay > 0) {
          return new Promise(
            (res) => setTimeout(() => {
              opts?.onSignalCheck?.(options?.abortSignal?.aborted ?? false);
              opts?.onNewSessionSettle?.(session);
              res(result);
            }, delay)
          );
        }
        opts?.onSignalCheck?.(options?.abortSignal?.aborted ?? false);
        opts?.onNewSessionSettle?.(session);
        return Promise.resolve(result);
      }
    },
    clearTimers: () => {
    }
  };
  return session;
}
function makeMockCtx() {
  return {
    ui: { notify: () => {
    } },
    model: { id: "test-model" }
  };
}
function makeMockPi() {
  const calls = [];
  const setModelCalls = [];
  return {
    sendMessage: (...args) => {
      calls.push(args);
    },
    setModel: async (...args) => {
      setModelCalls.push(args);
      return true;
    },
    calls,
    setModelCalls
  };
}
test("resolveAgentEnd resolves a pending runUnit promise", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  const event = makeEvent();
  const resultPromise = runUnit(
    ctx,
    pi,
    s,
    "task",
    "T01",
    "do stuff"
  );
  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd(event);
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.event, event);
});
test("runUnit failsafe defers cancellation while timeout recovery is making fresh progress", async () => {
  _resetPendingResolve();
  mock.timers.enable();
  const originalCwd = process.cwd();
  try {
    mock.timers.setTime(1e4);
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeMockSession();
    s.basePath = mkdtempSync(join(tmpdir(), "gsd-rununit-recovery-"));
    s.currentUnit = { type: "task", id: "T01", startedAt: 1234 };
    const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
    await waitForMicrotasks(() => pi.calls.length === 1, "unit dispatch");
    writeUnitRuntimeRecord(s.basePath, "task", "T01", 1234, {
      phase: "recovered",
      recoveryAttempts: 1,
      lastProgressKind: "hard-recovery-retry",
      lastProgressAt: Date.now()
    });
    assert.equal(
      shouldDeferUnitFailsafeTimeout(readUnitRuntimeRecord(s.basePath, "task", "T01"), {
        nowMs: Date.now(),
        currentUnitStartedAt: s.currentUnit.startedAt,
        freshProgressMs: 3e4
      }),
      true,
      "fresh recovery runtime should defer the failsafe"
    );
    setTimeout(() => {
      writeUnitRuntimeRecord(s.basePath, "task", "T01", 1234, {
        phase: "recovered",
        recoveryAttempts: 1,
        lastProgressKind: "hard-recovery-retry",
        lastProgressAt: Date.now()
      });
    }, 30 * 60 * 1e3 + 29e3);
    mock.timers.tick(30 * 60 * 1e3 + 31e3);
    await Promise.resolve();
    resolveAgentEnd(makeEvent());
    const result = await resultPromise;
    assert.equal(result.status, "completed");
  } finally {
    mock.timers.reset();
    process.chdir(originalCwd);
  }
});
test("shouldDeferUnitFailsafeTimeout rejects stale runtime progress", () => {
  assert.equal(
    shouldDeferUnitFailsafeTimeout({
      version: 1,
      unitType: "task",
      unitId: "T01",
      startedAt: 1234,
      updatedAt: 1,
      phase: "recovered",
      wrapupWarningSent: false,
      continueHereFired: false,
      timeoutAt: 1,
      lastProgressAt: 1,
      progressCount: 1,
      lastProgressKind: "hard-recovery-retry",
      recoveryAttempts: 1
    }, {
      nowMs: 12e4,
      currentUnitStartedAt: 1234,
      freshProgressMs: 3e4
    }),
    false
  );
});
test("shouldDeferUnitFailsafeTimeout rejects future runtime progress", () => {
  assert.equal(
    shouldDeferUnitFailsafeTimeout({
      version: 1,
      unitType: "task",
      unitId: "T01",
      startedAt: 1234,
      updatedAt: 1,
      phase: "recovered",
      wrapupWarningSent: false,
      continueHereFired: false,
      timeoutAt: 1,
      lastProgressAt: 15e4,
      progressCount: 1,
      lastProgressKind: "hard-recovery-retry",
      recoveryAttempts: 1
    }, {
      nowMs: 12e4,
      currentUnitStartedAt: 1234,
      freshProgressMs: 3e4
    }),
    false
  );
});
test("resolveAgentEnd drops event when no promise is pending", () => {
  _resetPendingResolve();
  assert.doesNotThrow(() => {
    resolveAgentEnd(makeEvent());
  });
});
test("double resolveAgentEnd only resolves once (second is dropped)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  const event1 = makeEvent([{ id: 1 }]);
  const event2 = makeEvent([{ id: 2 }]);
  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd(event1);
  assert.doesNotThrow(() => {
    resolveAgentEnd(event2);
  });
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.event, event1);
});
test("runUnit returns cancelled when session creation fails", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession({ newSessionThrows: "connection refused" });
  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");
  assert.equal(result.status, "cancelled");
  assert.equal(result.event, void 0);
  assert.equal(pi.calls.length, 0);
});
test("runUnit clears queued switch cancellation when session creation fails", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession({
    newSessionThrows: "connection refused",
    onNewSessionStart: () => {
      resolveAgentEndCancelled({
        message: "Claude Code process aborted by user",
        category: "aborted",
        isTransient: false
      });
    }
  });
  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");
  assert.equal(result.status, "cancelled");
  assert.equal(_consumePendingSwitchCancellation(), null);
});
test("runUnit returns cancelled when session creation times out", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession({ newSessionResult: { cancelled: true } });
  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");
  assert.equal(result.status, "cancelled");
  assert.equal(result.event, void 0);
  assert.equal(pi.calls.length, 0);
});
test("runUnit consumes a cancellation queued during session switch before dispatch", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  let cancellationQueued = false;
  const s = makeMockSession({
    newSessionDelayMs: 10,
    onNewSessionStart: () => {
      setTimeout(() => {
        cancellationQueued = !resolveAgentEndCancelled({
          message: "Claude Code process aborted by user",
          category: "aborted",
          isTransient: false
        });
      }, 0);
    }
  });
  const result = await runUnit(ctx, pi, s, "plan-slice", "M009/S01", "prompt");
  assert.equal(cancellationQueued, true);
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "aborted");
  assert.equal(result.errorContext?.message, "Claude Code process aborted by user");
  assert.equal(pi.calls.length, 0, "queued switch cancellation must prevent prompt dispatch");
});
test("runUnit keeps the session-switch guard across a late newSession settlement", async () => {
  _resetPendingResolve();
  mock.timers.enable();
  try {
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const firstSession = makeMockSession({ newSessionDelayMs: 2e5 });
    const secondSession = makeMockSession({ newSessionDelayMs: 2e5 });
    const firstRun = runUnit(ctx, pi, firstSession, "task", "T01", "prompt");
    mock.timers.tick(121e3);
    await Promise.resolve();
    const firstResult = await firstRun;
    assert.equal(firstResult.status, "cancelled");
    assert.equal(isSessionSwitchInFlight(), true, "guard should remain set after the timed-out session");
    mock.timers.tick(1);
    const secondRun = runUnit(ctx, pi, secondSession, "task", "T02", "prompt");
    mock.timers.tick(1e5);
    await Promise.resolve();
    assert.equal(
      isSessionSwitchInFlight(),
      true,
      "late settlement from the first session must not clear the newer session guard"
    );
    mock.timers.tick(21001);
    await Promise.resolve();
    const secondResult = await secondRun;
    assert.equal(secondResult.status, "cancelled");
    mock.timers.tick(8e4);
    await Promise.resolve();
    assert.equal(isSessionSwitchInFlight(), false, "guard should clear after the newer session settles");
  } finally {
    mock.timers.reset();
  }
});
test("runUnit returns cancelled when s.active is false before sendMessage", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  s.active = false;
  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");
  assert.equal(result.status, "cancelled");
  assert.equal(pi.calls.length, 0);
});
test("runUnit only arms resolve after newSession completes", async () => {
  _resetPendingResolve();
  let sawSwitchFlag = false;
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession({
    newSessionDelayMs: 20,
    onNewSessionStart: () => {
      sawSwitchFlag = isSessionSwitchInFlight();
    }
  });
  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sawSwitchFlag, true, "session switch guard should be active during newSession");
  assert.equal(isSessionSwitchInFlight(), false, "session switch guard should clear after newSession settles");
  resolveAgentEnd(makeEvent());
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(pi.calls.length, 1);
});
test("runUnit re-applies the selected unit model after newSession before dispatch", async () => {
  _resetPendingResolve();
  const callOrder = [];
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  pi.setModel = async (...args) => {
    callOrder.push("setModel");
    pi.setModelCalls.push(args);
    return true;
  };
  pi.sendMessage = (...args) => {
    callOrder.push("sendMessage");
    pi.calls.push(args);
  };
  const s = makeMockSession();
  s.currentUnitModel = { provider: "anthropic", id: "claude-opus-4-6" };
  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd(makeEvent());
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.deepEqual(callOrder, ["setModel", "sendMessage"]);
  assert.equal(pi.setModelCalls.length, 1);
  assert.deepEqual(pi.setModelCalls[0][0], s.currentUnitModel);
  assert.equal(pi.calls.length, 1);
});
test("runUnit cancels before dispatch when model restore fails after newSession", async () => {
  _resetPendingResolve();
  const notifications = [];
  const ctx = makeMockCtx();
  ctx.ui.notify = (message, level) => {
    notifications.push({ message, level });
  };
  const pi = makeMockPi();
  pi.setModel = async (...args) => {
    pi.setModelCalls.push(args);
    return false;
  };
  const s = makeMockSession();
  s.currentUnitModel = { provider: "openai-codex", id: "gpt-5.4" };
  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "session-failed");
  assert.match(
    result.errorContext?.message ?? "",
    /Failed to restore configured model openai-codex\/gpt-5\.4 after session creation/
  );
  assert.equal(pi.setModelCalls.length, 1);
  assert.equal(pi.calls.length, 0, "unit must not dispatch on the session default model");
  assert.deepEqual(notifications, [
    {
      message: "Failed to restore configured model openai-codex/gpt-5.4 after session creation. Cancelling unit before dispatch.",
      level: "warning"
    }
  ]);
});
test("runUnit cancels before dispatch when provider is not request-ready (#4555)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  ctx.modelRegistry = {
    isProviderRequestReady: (_provider) => false
  };
  const pi = makeMockPi();
  const s = makeMockSession();
  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "provider");
  assert.match(
    result.errorContext?.message ?? "",
    /Provider anthropic is not request-ready/
  );
  assert.equal(pi.calls.length, 0, "sendMessage must not be called when provider is not ready");
  assert.equal(_hasPendingResolveForTest(), false, "provider cancellation must clear the pending resolver");
});
test("runUnit cancels before dispatch using currentUnitModel provider when set (#4555)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.model = { provider: "openai", id: "gpt-4o" };
  ctx.modelRegistry = {
    isProviderRequestReady: (provider) => provider === "openai"
  };
  const pi = makeMockPi();
  const s = makeMockSession();
  s.currentUnitModel = { provider: "anthropic", id: "claude-opus-4-6" };
  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "provider");
  assert.match(
    result.errorContext?.message ?? "",
    /Provider anthropic is not request-ready/
  );
  assert.equal(pi.calls.length, 0, "sendMessage must not be called \u2014 anthropic (currentUnitModel) is not ready");
});
test("runUnit does not cancel before dispatch when provider is request-ready (#4555)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  ctx.modelRegistry = {
    isProviderRequestReady: (_provider) => true
  };
  const pi = makeMockPi();
  const s = makeMockSession();
  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd(makeEvent());
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(pi.calls.length, 1, "sendMessage must be called when provider is ready");
});
test("runUnit proceeds when modelRegistry is absent (no readiness check available) (#4555)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  const pi = makeMockPi();
  const s = makeMockSession();
  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd(makeEvent());
  const result = await resultPromise;
  assert.equal(result.status, "completed");
  assert.equal(pi.calls.length, 1);
});
test("runUnit proceeds when isProviderRequestReady throws (defensive) (#4555)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  ctx.modelRegistry = {
    isProviderRequestReady: (_provider) => {
      throw new Error("registry error");
    }
  };
  const pi = makeMockPi();
  const s = makeMockSession();
  const result = await runUnit(ctx, pi, s, "task", "T01", "prompt");
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorContext?.category, "provider");
  assert.equal(pi.calls.length, 0);
});
test("late-resolving newSession() after timeout receives aborted signal so tool runtime is not configured with stale workspace root (#3731)", async () => {
  _resetPendingResolve();
  mock.timers.enable();
  try {
    let abortedWhenLateSessionSettled = null;
    const s = makeMockSession({
      newSessionDelayMs: 2e5,
      // longer than NEW_SESSION_TIMEOUT_MS (120s)
      onSignalCheck: (aborted) => {
        abortedWhenLateSessionSettled = aborted;
      }
    });
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
    mock.timers.tick(121e3);
    await Promise.resolve();
    const result = await resultPromise;
    assert.equal(result.status, "cancelled", "runUnit must return cancelled on session timeout");
    mock.timers.tick(8e4);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      abortedWhenLateSessionSettled,
      true,
      "runUnit must pass an aborted AbortSignal to newSession() when it resolves after the session-creation timeout (#3731). Without this, AgentSession.newSession() can rebuild the tool runtime with a stale workspace root."
    );
  } finally {
    mock.timers.reset();
  }
});
function makeMockDeps(overrides) {
  const callLog = [];
  const baseDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async () => {
      callLog.push("stopAuto");
    },
    pauseAuto: async () => {
      callLog.push("pauseAuto");
    },
    clearUnitTimeout: () => {
    },
    updateProgressWidget: () => {
    },
    syncCmuxSidebar: () => {
    },
    logCmuxEvent: () => {
    },
    invalidateAllCaches: () => {
      callLog.push("invalidateAllCaches");
    },
    deriveState: async () => {
      callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: {
          id: "M001",
          title: "Test Milestone",
          status: "active"
        },
        activeSlice: { id: "S01", title: "Test Slice" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      };
    },
    loadEffectiveGSDPreferences: () => ({
      // These loop-mechanics tests mock executing state without plan-v2 artifacts.
      // Plan-v2 default-on coverage lives in uok-plan-v2-wiring.test.ts.
      preferences: { uok: { plan_v2: { enabled: false } } }
    }),
    preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
    checkResourcesStale: () => null,
    validateSessionLock: () => ({ valid: true }),
    updateSessionLock: () => {
      callLog.push("updateSessionLock");
    },
    handleLostSessionLock: () => {
      callLog.push("handleLostSessionLock");
    },
    sendDesktopNotification: () => {
    },
    setActiveMilestoneId: () => {
    },
    pruneQueueOrder: () => {
    },
    isInAutoWorktree: () => false,
    shouldUseWorktreeIsolation: () => false,
    teardownAutoWorktree: () => {
    },
    createAutoWorktree: () => "/tmp/wt",
    captureIntegrationBranch: () => {
    },
    getIsolationMode: () => "none",
    getCurrentBranch: () => "main",
    autoWorktreeBranch: () => "auto/M001",
    resolveMilestoneFile: () => null,
    reconcileMergeState: () => "clean",
    preflightCleanRoot: () => ({ stashPushed: false, summary: "" }),
    postflightPopStash: () => ({
      restored: true,
      needsManualRecovery: false,
      message: "restored"
    }),
    getLedger: () => null,
    getProjectTotals: () => ({ cost: 0 }),
    formatCost: (c) => `$${c.toFixed(2)}`,
    getBudgetAlertLevel: () => 0,
    getNewBudgetAlertLevel: () => 0,
    getBudgetEnforcementAction: () => "none",
    getManifestStatus: async () => null,
    collectSecretsFromManifest: async () => null,
    resolveDispatch: async () => {
      callLog.push("resolveDispatch");
      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do the thing"
      };
    },
    runPreDispatchHooks: () => ({ firedHooks: [], action: "proceed" }),
    getPriorSliceCompletionBlocker: () => null,
    getMainBranch: () => "main",
    closeoutUnit: async () => {
    },
    recordOutcome: () => {
    },
    writeLock: () => {
    },
    captureAvailableSkills: () => {
    },
    ensurePreconditions: () => {
    },
    updateSliceProgressCache: () => {
    },
    selectAndApplyModel: async () => ({ routing: null, appliedModel: null }),
    startUnitSupervision: () => {
    },
    getDeepDiagnostic: () => null,
    isDbAvailable: () => false,
    reorderForCaching: (p) => p,
    existsSync: (p) => p.endsWith(".git") || p.endsWith("package.json"),
    readFileSync: () => "",
    atomicWriteSync: () => {
    },
    GitServiceImpl: class {
    },
    lifecycle: {
      enterMilestone: () => ({ ok: true, mode: "worktree", path: "/tmp/project" }),
      exitMilestone: (_mid, opts) => ({
        ok: true,
        merged: opts.merge,
        codeFilesChanged: false
      })
    },
    worktreeProjection: new WorktreeStateProjection(),
    postUnitPreVerification: async () => {
      callLog.push("postUnitPreVerification");
      return "continue";
    },
    runPostUnitVerification: async () => {
      callLog.push("runPostUnitVerification");
      return "continue";
    },
    postUnitPostVerification: async () => {
      callLog.push("postUnitPostVerification");
      return "continue";
    },
    getSessionFile: () => "/tmp/session.json",
    rebuildState: async () => {
    },
    resolveModelId: (id, models) => models.find((m) => m.id === id),
    emitJournalEvent: () => {
    }
  };
  const merged = { ...baseDeps, ...overrides, callLog };
  return merged;
}
function makeLoopSession(overrides) {
  return {
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath: mkdtempSync(join(tmpdir(), "gsd-auto-loop-")),
    originalBasePath: "",
    currentMilestoneId: "M001",
    currentUnit: null,
    currentUnitRouting: null,
    completedUnits: [],
    resourceVersionOnStart: null,
    lastPromptCharCount: void 0,
    lastBaselineCharCount: void 0,
    lastBudgetAlertLevel: 0,
    pendingVerificationRetry: null,
    pendingCrashRecovery: null,
    verificationRetryFailureHashes: /* @__PURE__ */ new Map(),
    pendingQuickTasks: [],
    sidecarQueue: [],
    autoModeStartModel: null,
    unitDispatchCount: /* @__PURE__ */ new Map(),
    unitLifetimeDispatches: /* @__PURE__ */ new Map(),
    unitRecoveryCount: /* @__PURE__ */ new Map(),
    verificationRetryCount: /* @__PURE__ */ new Map(),
    gitService: null,
    lastRequestTimestamp: 0,
    autoStartTime: Date.now(),
    cmdCtx: {
      newSession: () => Promise.resolve({ cancelled: false }),
      getContextUsage: () => ({ percent: 10, tokens: 1e3, limit: 1e4 })
    },
    clearTimers: () => {
    },
    ...overrides
  };
}
test("autoLoop exits when s.active is set to false", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession({ active: false });
  const deps = makeMockDeps();
  await autoLoop(ctx, pi, s, deps);
  assert.ok(
    !deps.callLog.includes("deriveState"),
    "loop should not have iterated"
  );
});
test("autoLoop exits on terminal complete state", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "complete",
        activeMilestone: { id: "M001", title: "Test", status: "complete" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "complete" }],
        blockers: []
      };
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.ok(deps.callLog.includes("deriveState"), "should have derived state");
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should have called stopAuto for complete state"
  );
  assert.ok(
    !deps.callLog.includes("resolveDispatch"),
    "should not dispatch when complete"
  );
});
test("autoLoop stops before success notification when postflight stash restore needs recovery", async () => {
  _resetPendingResolve();
  const notifications = [];
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.ui.notify = (msg, level) => {
    notifications.push({ msg, level });
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  let stopReason = "";
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "complete",
        activeMilestone: { id: "M001", title: "Test", status: "complete" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "complete" }],
        blockers: []
      };
    },
    preflightCleanRoot: () => ({
      stashPushed: true,
      stashMarker: "gsd-preflight-stash:M001:test",
      summary: "stashed"
    }),
    postflightPopStash: () => ({
      restored: false,
      needsManualRecovery: true,
      message: "git stash pop stash@{0} failed after merge of milestone M001",
      stashRef: "stash@{0}"
    }),
    sendDesktopNotification: () => {
      deps.callLog.push("sendDesktopNotification");
    },
    logCmuxEvent: () => {
      deps.callLog.push("logCmuxEvent");
    },
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push("stopAuto");
      stopReason = reason ?? "";
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.equal(stopReason, "Post-merge stash restore failed for milestone M001");
  assert.ok(
    notifications.some(
      (n) => n.level === "error" && n.msg.includes("Post-merge stash restore failed for milestone M001")
    ),
    "failed postflight restore must be surfaced as an error"
  );
  assert.ok(
    !deps.callLog.includes("sendDesktopNotification"),
    "must not emit milestone success desktop notification after stash restore failure"
  );
  assert.ok(
    !deps.callLog.includes("logCmuxEvent"),
    "must not emit milestone success cmux event after stash restore failure"
  );
});
test("autoLoop marks transition merge complete before postflight recovery stop", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.ui.notify = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  let mergeCalls = 0;
  let stopReason = "";
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M002", title: "Next", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [
          { id: "M001", title: "Done", status: "complete" },
          { id: "M002", title: "Next", status: "active" }
        ],
        blockers: []
      };
    },
    preflightCleanRoot: () => ({
      stashPushed: true,
      stashMarker: "gsd-preflight-stash:M001:test",
      summary: "stashed"
    }),
    postflightPopStash: () => ({
      restored: false,
      needsManualRecovery: true,
      message: "git stash pop stash@{0} failed after merge of milestone M001",
      stashRef: "stash@{0}"
    }),
    lifecycle: {
      enterMilestone: () => {
        assert.fail("must not enter the next milestone after postflight recovery fails");
      },
      exitMilestone: (_mid, opts) => {
        if (opts.merge) mergeCalls += 1;
        return { ok: true, merged: opts.merge, codeFilesChanged: false };
      }
    },
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push("stopAuto");
      stopReason = reason ?? "";
      if (!s.milestoneMergedInPhases) {
        deps.lifecycle.exitMilestone(
          "M001",
          { merge: true },
          { notify: ctx.ui.notify.bind(ctx.ui) }
        );
      }
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.equal(stopReason, "Post-merge stash restore failed for milestone M001");
  assert.equal(s.milestoneMergedInPhases, true);
  assert.equal(mergeCalls, 1, "postflight recovery stop must not re-run an already completed transition merge");
});
test("autoLoop pauses when provider readiness cancels before dispatch", async () => {
  _resetPendingResolve();
  const notifications = [];
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.ui.notify = (message, level) => {
    notifications.push({ message, level });
  };
  ctx.model = { provider: "anthropic", id: "claude-opus-4-6" };
  ctx.modelRegistry = {
    getProviderAuthMode: () => "api-key",
    isProviderRequestReady: () => false
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const deps = makeMockDeps({
    selectAndApplyModel: async () => ({
      routing: null,
      appliedModel: { provider: "anthropic", id: "claude-opus-4-6" }
    })
  });
  await autoLoop(ctx, pi, s, deps);
  assert.equal(pi.calls.length, 0, "provider readiness cancellation must not dispatch a message");
  assert.ok(deps.callLog.includes("pauseAuto"), "provider readiness cancellation should pause auto-mode");
  assert.ok(!deps.callLog.includes("stopAuto"), "provider readiness cancellation should not hard-stop auto-mode");
  assert.ok(
    !deps.callLog.includes("postUnitPreVerification"),
    "post-unit verification must not run after pre-dispatch provider cancellation"
  );
  assert.ok(
    notifications.some((n) => /Provider anthropic is not request-ready/.test(n.message)),
    "provider pause should notify with the readiness failure"
  );
});
test("autoLoop passes structured session-lock failure details to the handler", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  let observedLockStatus;
  const deps = makeMockDeps({
    validateSessionLock: () => ({
      valid: false,
      failureReason: "compromised",
      expectedPid: process.pid
    }),
    handleLostSessionLock: (_ctx, lockStatus) => {
      observedLockStatus = lockStatus;
      deps.callLog.push("handleLostSessionLock");
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.deepEqual(observedLockStatus, {
    valid: false,
    failureReason: "compromised",
    expectedPid: process.pid
  });
  assert.ok(
    !deps.callLog.includes("resolveDispatch"),
    "should stop before dispatch after lock validation fails"
  );
});
test("autoLoop dequeues sidecar item before session-lock break (first iteration, #5308)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  s.sidecarQueue.push({
    kind: "hook",
    unitType: "hook/review",
    unitId: "M001/S01/T01/review",
    prompt: "review the code"
  });
  const journalEvents = [];
  const deps = makeMockDeps({
    validateSessionLock: () => ({
      valid: false,
      failureReason: "compromised",
      expectedPid: process.pid
    }),
    handleLostSessionLock: () => {
      deps.callLog.push("handleLostSessionLock");
    },
    emitJournalEvent: (entry) => {
      journalEvents.push(entry.eventType);
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.equal(
    s.sidecarQueue.length,
    0,
    "sidecar item must be popped on lock-loss iteration (pre-#5308 ordering)"
  );
  assert.ok(
    journalEvents.includes("sidecar-dequeue"),
    "sidecar-dequeue journal event must be emitted before session-lock break"
  );
  assert.ok(
    deps.callLog.includes("handleLostSessionLock"),
    "session lock handler must still fire after sidecar dequeue"
  );
  assert.ok(!deps.callLog.includes("deriveState"), "lock loss should stop before deriving state");
});
test("autoLoop dequeues sidecar item before session-lock break (mid-session, #5308)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const journalEvents = [];
  let lockCheckCount = 0;
  const deps = makeMockDeps({
    // First iteration: lock valid; second iteration: lock invalidates.
    validateSessionLock: () => {
      lockCheckCount += 1;
      if (lockCheckCount === 1) {
        return { valid: true };
      }
      return {
        valid: false,
        failureReason: "compromised",
        expectedPid: process.pid
      };
    },
    handleLostSessionLock: () => {
      deps.callLog.push("handleLostSessionLock");
    },
    emitJournalEvent: (entry) => {
      journalEvents.push(entry.eventType);
    },
    // Enqueue a sidecar item at the end of iteration 1, so iteration 2 begins
    // with a non-empty queue and an invalid lock.
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      s.sidecarQueue.push({
        kind: "hook",
        unitType: "run-uat",
        unitId: "M001/S01/T01/review",
        prompt: "review the code"
      });
      return "continue";
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());
  await loopPromise;
  assert.ok(lockCheckCount >= 2, "lock validator must run on iteration 2");
  assert.equal(
    s.sidecarQueue.length,
    0,
    "queued sidecar item must be popped on the lock-loss iteration"
  );
  assert.ok(
    journalEvents.includes("sidecar-dequeue"),
    "sidecar-dequeue journal event must be emitted before session-lock break"
  );
  assert.ok(
    deps.callLog.includes("handleLostSessionLock"),
    "lock-loss handler must still fire on iteration 2"
  );
});
test("autoLoop exits on terminal blocked state", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "blocked",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "active" }],
        blockers: ["Missing API key"]
      };
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.ok(deps.callLog.includes("deriveState"), "should have derived state");
  assert.ok(
    deps.callLog.includes("pauseAuto"),
    "should have called pauseAuto for blocked state"
  );
  assert.ok(
    !deps.callLog.includes("resolveDispatch"),
    "should not dispatch when blocked"
  );
});
test("autoLoop calls deriveState \u2192 resolveDispatch \u2192 runUnit in sequence", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      };
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do the thing"
      };
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      s.active = false;
      return "continue";
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());
  await loopPromise;
  const deriveIdx = deps.callLog.indexOf("deriveState");
  const dispatchIdx = deps.callLog.indexOf("resolveDispatch");
  const preVerIdx = deps.callLog.indexOf("postUnitPreVerification");
  const verIdx = deps.callLog.indexOf("runPostUnitVerification");
  const postVerIdx = deps.callLog.indexOf("postUnitPostVerification");
  assert.ok(deriveIdx >= 0, "deriveState should have been called");
  assert.ok(
    dispatchIdx > deriveIdx,
    "resolveDispatch should come after deriveState"
  );
  assert.ok(
    preVerIdx > dispatchIdx,
    "postUnitPreVerification should come after resolveDispatch"
  );
  assert.ok(
    verIdx > preVerIdx,
    "runPostUnitVerification should come after pre-verification"
  );
  assert.ok(
    postVerIdx > verIdx,
    "postUnitPostVerification should come after verification"
  );
});
test("autoLoop journals post-unit finalize stop after completed unit", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const journalEvents = [];
  const deps = makeMockDeps({
    postUnitPreVerification: async () => {
      deps.callLog.push("postUnitPreVerification");
      s.lastGitActionFailure = "commit failed";
      return "dispatched";
    },
    emitJournalEvent: (entry) => {
      journalEvents.push(entry);
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());
  await loopPromise;
  assert.ok(
    deps.callLog.includes("postUnitPreVerification"),
    "completed units must enter post-unit pre-verification before stopping"
  );
  assert.ok(
    !deps.callLog.includes("runPostUnitVerification"),
    "git-closeout stop should not run later verification phases"
  );
  const unitEndIndex = journalEvents.findIndex((e) => e.eventType === "unit-end");
  const finalizeStartIndex = journalEvents.findIndex((e) => e.eventType === "post-unit-finalize-start");
  const finalizeEndIndex = journalEvents.findIndex((e) => e.eventType === "post-unit-finalize-end");
  const iterationEndIndex = journalEvents.findIndex((e) => e.eventType === "iteration-end");
  assert.ok(unitEndIndex >= 0, "unit-end should be journaled after agent completion");
  assert.ok(finalizeStartIndex > unitEndIndex, "post-unit finalize must start after unit-end");
  assert.ok(finalizeEndIndex > finalizeStartIndex, "post-unit finalize must journal its stop result");
  assert.ok(iterationEndIndex > finalizeEndIndex, "iteration-end must be emitted even when finalize stops");
  assert.deepEqual(journalEvents[finalizeEndIndex].data, {
    iteration: 1,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    status: "stopped",
    action: "break",
    reason: "git-closeout-failure"
  });
  assert.deepEqual(journalEvents[iterationEndIndex].data, {
    iteration: 1,
    status: "stopped",
    reason: "git-closeout-failure",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    failureClass: "git"
  });
});
test("autoLoop journals iteration-end when unit phase breaks after cancelled unit", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const journalEvents = [];
  const deps = makeMockDeps({
    emitJournalEvent: (entry) => {
      journalEvents.push(entry);
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEndCancelled();
  await loopPromise;
  const unitEndIndex = journalEvents.findIndex(
    (e) => e.eventType === "unit-end" && e.data?.status === "cancelled"
  );
  const iterationEndIndex = journalEvents.findIndex((e) => e.eventType === "iteration-end");
  assert.ok(unitEndIndex >= 0, "cancelled unit should still emit unit-end");
  assert.ok(iterationEndIndex > unitEndIndex, "unit-phase break must close the iteration after unit-end");
  assert.deepEqual(journalEvents[iterationEndIndex].data, {
    iteration: 1,
    status: "stopped",
    reason: "unit-aborted",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    failureClass: "execution"
  });
});
test("crash lock records session file from AFTER newSession, not before (#1710)", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  let currentSessionFile = "/tmp/old-session.json";
  ctx.sessionManager = {
    getSessionFile: () => currentSessionFile
  };
  const pi = makeMockPi();
  const s = makeLoopSession({
    cmdCtx: {
      newSession: () => {
        currentSessionFile = "/tmp/new-session-after-newSession.json";
        return Promise.resolve({ cancelled: false });
      },
      getContextUsage: () => ({ percent: 10, tokens: 1e3, limit: 1e4 })
    }
  });
  const writeLockCalls = [];
  const updateSessionLockCalls = [];
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      };
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do the thing"
      };
    },
    writeLock: (_base, _ut, _uid, sessionFile) => {
      writeLockCalls.push({ sessionFile });
    },
    updateSessionLock: (_base, _ut, _uid, sessionFile) => {
      updateSessionLockCalls.push({ sessionFile });
    },
    getSessionFile: (ctxArg) => {
      return ctxArg.sessionManager?.getSessionFile() ?? "";
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      s.active = false;
      return "continue";
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());
  await loopPromise;
  assert.ok(
    writeLockCalls.length >= 2,
    `expected at least 2 writeLock calls, got ${writeLockCalls.length}`
  );
  assert.strictEqual(
    writeLockCalls[0].sessionFile,
    void 0,
    "preliminary lock before runUnit should have no session file"
  );
  assert.strictEqual(
    writeLockCalls[1].sessionFile,
    "/tmp/new-session-after-newSession.json",
    "post-runUnit lock should record the session file created by newSession"
  );
  assert.ok(
    updateSessionLockCalls.length >= 1,
    "updateSessionLock should have been called at least once"
  );
  assert.strictEqual(
    updateSessionLockCalls[0].sessionFile,
    "/tmp/new-session-after-newSession.json",
    "updateSessionLock should record the session file created by newSession"
  );
});
test("autoLoop handles verification retry by continuing loop", async (t) => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1e4 });
  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {
    };
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    let verifyCallCount = 0;
    let deriveCallCount = 0;
    const s = makeLoopSession();
    const verificationActions = [
      {
        sideEffect: () => {
          s.pendingVerificationRetry = {
            unitId: "M001/S01/T01",
            failureContext: "test failed: expected X got Y",
            attempt: 1
          };
        },
        response: "retry"
      },
      { response: "continue" }
    ];
    const deps = makeMockDeps({
      deriveState: async () => {
        deriveCallCount++;
        deps.callLog.push("deriveState");
        return {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: { id: "S01", title: "Slice 1" },
          activeTask: { id: "T01" },
          registry: [{ id: "M001", status: "active" }],
          blockers: []
        };
      },
      runPostUnitVerification: async () => {
        const action = verificationActions[verifyCallCount] ?? { response: "continue" };
        verifyCallCount++;
        deps.callLog.push("runPostUnitVerification");
        action.sideEffect?.();
        return action.response;
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        s.active = false;
        return "continue";
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    await waitForMicrotasks(() => pi.calls.length === 1, "first dispatch");
    resolveAgentEnd(makeEvent());
    await drainMicrotasks(100);
    mock.timers.tick(3e4);
    await waitForMicrotasks(() => pi.calls.length === 2, "retry dispatch");
    resolveAgentEnd(makeEvent());
    await loopPromise;
    const deriveCount = deps.callLog.filter((c) => c === "deriveState").length;
    assert.ok(
      deriveCount >= 2,
      `deriveState should be called at least 2 times (got ${deriveCount})`
    );
    assert.equal(
      verifyCallCount,
      2,
      "verification should have been called twice (once retry, once pass)"
    );
  } finally {
    mock.timers.reset();
  }
});
test("autoLoop pauses instead of redispatching identical verification failure context", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 15e3 });
  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {
    };
    ctx.ui.notify = () => {
    };
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    const s = makeLoopSession();
    let verifyCallCount = 0;
    let pauseCallCount = 0;
    const deps = makeMockDeps({
      deriveState: async () => ({
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      }),
      runPostUnitVerification: async () => {
        verifyCallCount++;
        deps.callLog.push("runPostUnitVerification");
        s.pendingVerificationRetry = {
          unitId: "M001/S01/T01",
          failureContext: "test failed: expected X got Y",
          attempt: verifyCallCount
        };
        return "retry";
      },
      pauseAuto: async () => {
        pauseCallCount++;
        s.active = false;
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    await waitForMicrotasks(() => pi.calls.length === 1, "first dispatch");
    resolveAgentEnd(makeEvent());
    await drainMicrotasks(100);
    mock.timers.tick(3e4);
    await waitForMicrotasks(() => pi.calls.length === 2, "retry dispatch");
    resolveAgentEnd(makeEvent());
    await loopPromise;
    assert.equal(verifyCallCount, 2);
    assert.equal(pi.calls.length, 2, "duplicate failure should not be redispatched a third time");
    assert.equal(pauseCallCount, 1, "duplicate failure should pause auto-mode");
  } finally {
    mock.timers.reset();
  }
});
test("autoLoop handles dispatch stop action", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "stop",
        reason: "test-stop-reason",
        level: "info"
      };
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.ok(
    deps.callLog.includes("resolveDispatch"),
    "should have called resolveDispatch"
  );
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should have stopped on dispatch stop action"
  );
});
test("autoLoop pauses instead of stopping for warning-level dispatch stop", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "stop",
        reason: 'UAT verdict for S01 is "partial" \u2014 blocking progression.',
        level: "warning"
      };
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.ok(
    deps.callLog.includes("resolveDispatch"),
    "should have called resolveDispatch"
  );
  assert.ok(
    deps.callLog.includes("pauseAuto"),
    "warning-level stop should call pauseAuto (resumable)"
  );
  assert.ok(
    !deps.callLog.includes("stopAuto"),
    "warning-level stop should NOT call stopAuto (hard stop)"
  );
});
test("autoLoop hard-stops for error-level dispatch stop", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const deps = makeMockDeps({
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "stop",
        reason: "Cannot complete milestone: missing SUMMARY files.",
        level: "error"
      };
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "error-level stop should call stopAuto (hard stop)"
  );
  assert.ok(
    !deps.callLog.includes("pauseAuto"),
    "error-level stop should NOT call pauseAuto"
  );
});
test("autoLoop handles dispatch skip action by continuing", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  let dispatchCallCount = 0;
  const dispatchResponses = [
    { action: "skip" },
    { action: "stop", reason: "done", level: "info" }
  ];
  const deps = makeMockDeps({
    resolveDispatch: async () => {
      const response = dispatchResponses[dispatchCallCount] ?? dispatchResponses[dispatchResponses.length - 1];
      dispatchCallCount++;
      deps.callLog.push("resolveDispatch");
      return response;
    }
  });
  await autoLoop(ctx, pi, s, deps);
  const dispatchCalls = deps.callLog.filter((c) => c === "resolveDispatch");
  assert.equal(
    dispatchCalls.length,
    2,
    "resolveDispatch should be called twice (skip then stop)"
  );
  const deriveCalls = deps.callLog.filter((c) => c === "deriveState");
  assert.ok(
    deriveCalls.length >= 2,
    "deriveState should be called at least twice (one per iteration)"
  );
});
test("autoLoop drains sidecar queue after postUnitPostVerification enqueues items", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();
  let postVerCallCount = 0;
  const postVerActions = [
    () => {
      s.sidecarQueue.push({
        kind: "hook",
        unitType: "run-uat",
        unitId: "M001/S01/T01/review",
        prompt: "review the code"
      });
    },
    () => {
      s.active = false;
    }
  ];
  const deps = makeMockDeps({
    postUnitPostVerification: async () => {
      postVerActions[postVerCallCount]?.();
      postVerCallCount++;
      deps.callLog.push("postUnitPostVerification");
      return "continue";
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  for (let i = 0; !_hasPendingResolveForTest() && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(_hasPendingResolveForTest(), true, "main unit should be awaiting agent_end");
  resolveAgentEnd(makeEvent());
  for (let i = 0; !_hasPendingResolveForTest() && postVerCallCount < 2 && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(_hasPendingResolveForTest(), true, "sidecar unit should be awaiting agent_end");
  resolveAgentEnd(makeEvent());
  await loopPromise;
  assert.equal(
    postVerCallCount,
    2,
    "postUnitPostVerification should be called twice (main + sidecar)"
  );
});
test("autoLoop exits when no active milestone found", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession({ currentMilestoneId: null });
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        registry: [],
        blockers: []
      };
    }
  });
  await autoLoop(ctx, pi, s, deps);
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should stop when no milestone and all complete"
  );
});
test("stuck detection: stops when sliding window detects same unit 3 consecutive times", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.ui.notify = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  let stopReason = "";
  const deps = makeMockDeps({
    deriveState: async () => ({
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: { id: "T01" },
      registry: [{ id: "M001", status: "active" }],
      blockers: []
    }),
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing"
    }),
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push("stopAuto");
      stopReason = reason ?? "";
      s.active = false;
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }
  await loopPromise;
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "stopAuto should have been called"
  );
  assert.ok(
    stopReason.includes("Stuck"),
    `stop reason should mention 'Stuck', got: ${stopReason}`
  );
  assert.ok(
    stopReason.includes("M001/S01/T01"),
    "stop reason should include unitId"
  );
});
test("stuck detection: window resets recovery when deriveState returns a different unit", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.ui.notify = () => {
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  let deriveCallCount = 0;
  let postVerCallCount = 0;
  let stopCalled = false;
  const derivedTaskIds = ["T01", "T01", "T01", "T02"];
  const deps = makeMockDeps({
    deriveState: async () => {
      const taskId = derivedTaskIds[Math.min(deriveCallCount, derivedTaskIds.length - 1)];
      deriveCallCount++;
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: taskId },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      };
    },
    resolveDispatch: async () => {
      const taskId = derivedTaskIds[Math.min(deriveCallCount - 1, derivedTaskIds.length - 1)];
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: `M001/S01/${taskId}`,
        prompt: "do the thing"
      };
    },
    stopAuto: async (_ctx, _pi, reason) => {
      deps.callLog.push("stopAuto");
      stopCalled = true;
      s.active = false;
    },
    postUnitPostVerification: async () => {
      postVerCallCount++;
      deps.callLog.push("postUnitPostVerification");
      const shouldExit = postVerCallCount >= 4;
      s.active = !shouldExit;
      return "continue";
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }
  await loopPromise;
  assert.ok(
    !stopCalled,
    "stopAuto should NOT have been called \u2014 different unit broke stuck pattern"
  );
  assert.ok(
    deriveCallCount >= 4,
    `deriveState should have been called at least 4 times (got ${deriveCallCount})`
  );
});
test("stuck detection: verification retries remain visible to the sliding window", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2e4 });
  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {
    };
    ctx.ui.notify = () => {
    };
    const pi = makeMockPi();
    const s = makeLoopSession();
    let verifyCallCount = 0;
    let stopReason = "";
    const verifyActions = [
      () => {
        s.pendingVerificationRetry = { unitId: "M001/S01/T01", failureContext: "test failed: 1", attempt: 1 };
        return "retry";
      },
      () => {
        s.pendingVerificationRetry = { unitId: "M001/S01/T01", failureContext: "test failed: 2", attempt: 2 };
        return "retry";
      },
      () => {
        s.pendingVerificationRetry = { unitId: "M001/S01/T01", failureContext: "test failed: 3", attempt: 3 };
        return "retry";
      },
      () => {
        s.active = false;
        return "continue";
      }
    ];
    const deps = makeMockDeps({
      deriveState: async () => ({
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      }),
      resolveDispatch: async () => ({
        action: "dispatch",
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "do the thing"
      }),
      runPostUnitVerification: async () => {
        const action = verifyActions[verifyCallCount] ?? (() => {
          s.active = false;
          return "continue";
        });
        verifyCallCount++;
        deps.callLog.push("runPostUnitVerification");
        return action();
      },
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push("stopAuto");
        stopReason = reason ?? "";
        s.active = false;
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    for (let i = 1; i <= 3; i++) {
      await waitForMicrotasks(() => pi.calls.length === i, `dispatch ${i}`);
      resolveAgentEnd(makeEvent());
      await drainMicrotasks(100);
      mock.timers.tick(3e4);
    }
    await loopPromise;
    assert.ok(
      stopReason.includes("Stuck"),
      `stuck detection should fire during repeated verification retries, got: ${stopReason}`
    );
    assert.equal(
      verifyCallCount,
      3,
      "verification should stop before a 4th repeated retry dispatch"
    );
  } finally {
    mock.timers.reset();
  }
});
test("detectStuck: returns null for fewer than 2 entries", () => {
  assert.equal(detectStuck([]), null);
  assert.equal(detectStuck([{ key: "A" }]), null);
});
test("detectStuck: Rule 1 \u2014 same error twice in a row", () => {
  const result = detectStuck([
    { key: "A", error: "ENOENT: file not found" },
    { key: "A", error: "ENOENT: file not found" }
  ]);
  assert.ok(result?.stuck, "should detect same error repeated");
  assert.ok(result?.reason.includes("Same error repeated"));
});
test("detectStuck: Rule 1 \u2014 different errors do not trigger", () => {
  const result = detectStuck([
    { key: "A", error: "ENOENT: file not found" },
    { key: "A", error: "EACCES: permission denied" }
  ]);
  assert.equal(result, null);
});
test("detectStuck: Rule 2 \u2014 same unit 3 consecutive times", () => {
  const result = detectStuck([
    { key: "execute-task/M001/S01/T01" },
    { key: "execute-task/M001/S01/T01" },
    { key: "execute-task/M001/S01/T01" }
  ]);
  assert.ok(result?.stuck);
  assert.ok(result?.reason.includes("3 consecutive times"));
});
test("detectStuck: Rule 2 \u2014 2 consecutive does not trigger", () => {
  assert.equal(detectStuck([
    { key: "A" },
    { key: "A" }
  ]), null);
});
test("detectStuck: Rule 3 \u2014 oscillation A\u2192B\u2192A\u2192B", () => {
  const result = detectStuck([
    { key: "A" },
    { key: "B" },
    { key: "A" },
    { key: "B" }
  ]);
  assert.ok(result?.stuck);
  assert.ok(result?.reason.includes("Oscillation"));
});
test("detectStuck: Rule 3 \u2014 non-oscillation pattern A\u2192B\u2192C\u2192B", () => {
  assert.equal(detectStuck([
    { key: "A" },
    { key: "B" },
    { key: "C" },
    { key: "B" }
  ]), null);
});
test("detectStuck: Rule 1 takes priority over Rule 2 when both match", () => {
  const result = detectStuck([
    { key: "A", error: "test error" },
    { key: "A", error: "test error" },
    { key: "A", error: "test error" }
  ]);
  assert.ok(result?.stuck);
  assert.ok(result?.reason.includes("Same error repeated"));
});
test("detectStuck: truncates long error strings", () => {
  const longError = "x".repeat(500);
  const result = detectStuck([
    { key: "A", error: longError },
    { key: "A", error: longError }
  ]);
  assert.ok(result?.stuck);
  assert.ok(result.reason.includes(longError.slice(0, 200)), "reason should include the truncated error prefix");
  assert.equal(result.reason.includes(longError), false, "reason should not include the full long error");
});
test("autoLoop lifecycle: advances through research \u2192 plan \u2192 execute \u2192 verify \u2192 complete across iterations", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.ui.notify = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const s = makeLoopSession();
  let deriveCallCount = 0;
  let dispatchCallCount = 0;
  const dispatchedUnitTypes = [];
  const phases = [
    // Call 1: researching → dispatches research-slice
    {
      phase: "researching",
      activeSlice: { id: "S01", title: "Research Slice" },
      activeTask: null
    },
    // Call 2: planning → dispatches plan-slice
    {
      phase: "planning",
      activeSlice: { id: "S01", title: "Plan Slice" },
      activeTask: null
    },
    // Call 3: executing → dispatches execute-task
    {
      phase: "executing",
      activeSlice: { id: "S01", title: "Execute Slice" },
      activeTask: { id: "T01" }
    },
    // Call 4: verifying → dispatches verify-slice
    {
      phase: "verifying",
      activeSlice: { id: "S01", title: "Verify Slice" },
      activeTask: null
    },
    // Call 5: completing → dispatches complete-slice
    {
      phase: "completing",
      activeSlice: { id: "S01", title: "Complete Slice" },
      activeTask: null
    },
    // Call 6: terminal — deactivate to exit the loop
    {
      phase: "complete",
      activeSlice: null,
      activeTask: null
    }
  ];
  const dispatches = [
    { unitType: "research-slice", unitId: "M001/S01", prompt: "research" },
    { unitType: "plan-slice", unitId: "M001/S01", prompt: "plan" },
    { unitType: "execute-task", unitId: "M001/S01/T01", prompt: "execute" },
    { unitType: "run-uat", unitId: "M001/S01", prompt: "verify" },
    { unitType: "complete-slice", unitId: "M001/S01", prompt: "complete" }
  ];
  const deps = makeMockDeps({
    deriveState: async () => {
      const p = phases[Math.min(deriveCallCount, phases.length - 1)];
      deriveCallCount++;
      deps.callLog.push("deriveState");
      const terminalPhases = { complete: "complete" };
      s.active = p.phase !== "complete";
      const milestoneStatus = terminalPhases[p.phase] ?? "active";
      return {
        phase: p.phase,
        activeMilestone: { id: "M001", title: "Test", status: milestoneStatus },
        activeSlice: p.activeSlice ?? null,
        activeTask: p.activeTask ?? null,
        registry: [{ id: "M001", status: milestoneStatus }],
        blockers: []
      };
    },
    resolveDispatch: async () => {
      const d = dispatches[Math.min(dispatchCallCount, dispatches.length - 1)];
      dispatchCallCount++;
      deps.callLog.push("resolveDispatch");
      dispatchedUnitTypes.push(d.unitType);
      return {
        action: "dispatch",
        unitType: d.unitType,
        unitId: d.unitId,
        prompt: d.prompt
      };
    },
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      return "continue";
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 30));
    resolveAgentEnd(makeEvent());
  }
  await loopPromise;
  assert.ok(
    deriveCallCount >= 5,
    `deriveState should be called at least 5 times (got ${deriveCallCount})`
  );
  assert.ok(
    dispatchedUnitTypes.includes("research-slice"),
    `should have dispatched research-slice, got: ${dispatchedUnitTypes.join(", ")}`
  );
  assert.ok(
    dispatchedUnitTypes.includes("plan-slice"),
    `should have dispatched plan-slice, got: ${dispatchedUnitTypes.join(", ")}`
  );
  assert.ok(
    dispatchedUnitTypes.includes("execute-task"),
    `should have dispatched execute-task, got: ${dispatchedUnitTypes.join(", ")}`
  );
  assert.ok(
    dispatchedUnitTypes.includes("run-uat"),
    `should have dispatched run-uat, got: ${dispatchedUnitTypes.join(", ")}`
  );
  assert.ok(
    dispatchedUnitTypes.includes("complete-slice"),
    `should have dispatched complete-slice, got: ${dispatchedUnitTypes.join(", ")}`
  );
  const deriveEntries = deps.callLog.filter((c) => c === "deriveState");
  const dispatchEntries = deps.callLog.filter((c) => c === "resolveDispatch");
  assert.ok(
    deriveEntries.length >= 5,
    `callLog should have at least 5 deriveState entries (got ${deriveEntries.length})`
  );
  assert.ok(
    dispatchEntries.length >= 5,
    `callLog should have at least 5 resolveDispatch entries (got ${dispatchEntries.length})`
  );
  const firstDispatchIdx = deps.callLog.indexOf("resolveDispatch");
  const firstDeriveAfterDispatch = deps.callLog.indexOf("deriveState", firstDispatchIdx + 1);
  assert.ok(firstDispatchIdx >= 0, "resolveDispatch should appear in callLog");
  assert.ok(firstDeriveAfterDispatch > firstDispatchIdx, "deriveState should follow resolveDispatch to confirm loop advanced");
  assert.deepEqual(
    dispatchedUnitTypes,
    [
      "research-slice",
      "plan-slice",
      "execute-task",
      "run-uat",
      "complete-slice"
    ],
    "dispatched unit types should follow the full lifecycle sequence"
  );
});
test("resolveAgentEndCancelled resolves a pending promise with cancelled status", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEndCancelled();
  const result = await resultPromise;
  assert.equal(result.status, "cancelled");
  assert.equal(result.event, void 0);
});
test("resolveAgentEndCancelled is a no-op when no promise is pending", () => {
  _resetPendingResolve();
  assert.doesNotThrow(() => {
    resolveAgentEndCancelled();
  });
});
test("resolveAgentEndCancelled prevents orphaned promise after abort path", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "prompt");
  await new Promise((r) => setTimeout(r, 10));
  s.active = false;
  resolveAgentEndCancelled();
  const result = await resultPromise;
  assert.equal(result.status, "cancelled");
});
test("resolveAgentEndCancelled with errorContext passes it through to resolved promise", async () => {
  _resetPendingResolve();
  const { _setCurrentResolve } = await import("../auto/resolve.js");
  const p = new Promise((r) => {
    _setCurrentResolve(r);
  });
  resolveAgentEndCancelled({ message: "test timeout", category: "timeout", isTransient: true });
  const resolved = await p;
  assert.equal(resolved.status, "cancelled");
  assert.ok(resolved.errorContext, "errorContext must be present");
  assert.equal(resolved.errorContext.category, "timeout");
  assert.equal(resolved.errorContext.message, "test timeout");
  assert.equal(resolved.errorContext.isTransient, true);
});
test("runUnitPhase pauses transient aborted cancellations instead of hard-stopping", async (t) => {
  _resetPendingResolve();
  const basePath = mkdtempSync(join(tmpdir(), "gsd-aborted-cancel-"));
  t.after(() => {
    rmSync(basePath, { recursive: true, force: true });
  });
  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {
      },
      setStatus: () => {
      },
      setWorkingMessage: () => {
      }
    },
    sessionManager: {
      getEntries: () => []
    },
    modelRegistry: {
      getProviderAuthMode: () => void 0,
      isProviderRequestReady: () => true
    }
  };
  const pi = {
    ...makeMockPi(),
    sendMessage: () => {
      queueMicrotask(() => resolveAgentEndCancelled({
        message: "Claude Code process aborted by user",
        category: "aborted",
        isTransient: true
      }));
    }
  };
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath
  });
  const deps = makeMockDeps();
  let seq = 0;
  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: void 0, iteration: 1, flowId: "flow-aborted", nextSeq: () => ++seq },
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 }
      },
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: void 0
    },
    { recentUnits: [{ key: "execute-task/M001/S01/T01" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 }
  );
  assert.equal(result.action, "break");
  assert.equal(result.reason, "unit-aborted-pause");
  assert.equal(deps.callLog.includes("pauseAuto"), true);
  assert.equal(deps.callLog.includes("stopAuto"), false);
});
test("runUnitPhase pauses ghost completions before closeout and finalize side effects", async (t) => {
  _resetPendingResolve();
  const basePath = mkdtempSync(join(tmpdir(), "gsd-ghost-completion-"));
  t.after(() => {
    _resetPendingResolve();
    rmSync(basePath, { recursive: true, force: true });
  });
  let closeoutCalls = 0;
  let preVerificationCalls = 0;
  let postVerificationCalls = 0;
  const journalEvents = [];
  const deps = makeMockDeps({
    closeoutUnit: async () => {
      closeoutCalls++;
    },
    postUnitPreVerification: async () => {
      preVerificationCalls++;
      return "continue";
    },
    postUnitPostVerification: async () => {
      postVerificationCalls++;
      return "continue";
    },
    emitJournalEvent: (event) => {
      journalEvents.push(event);
    }
  });
  const ctx = {
    ...makeMockCtx(),
    ui: {
      notify: () => {
      },
      setStatus: () => {
      },
      setWorkingMessage: () => {
      }
    },
    sessionManager: {
      getEntries: () => []
    },
    modelRegistry: {
      getProviderAuthMode: () => void 0,
      isProviderRequestReady: () => true
    }
  };
  const pi = {
    ...makeMockPi(),
    sendMessage: () => {
      queueMicrotask(() => resolveAgentEnd({ messages: [] }));
    }
  };
  const s = makeLoopSession({
    basePath,
    canonicalProjectRoot: basePath,
    originalBasePath: basePath
  });
  let seq = 0;
  const result = await runUnitPhase(
    { ctx, pi, s, deps, prefs: void 0, iteration: 1, flowId: "flow-ghost", nextSeq: () => ++seq },
    {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do work",
      finalPrompt: "do work",
      pauseAfterUatDispatch: false,
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Milestone" },
        activeSlice: { id: "S01", title: "Slice" },
        activeTask: { id: "T01", title: "Task" },
        registry: [{ id: "M001", title: "Milestone", status: "active" }],
        recentDecisions: [],
        blockers: [],
        nextAction: "",
        progress: { milestones: { done: 0, total: 1 } },
        requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 }
      },
      mid: "M001",
      midTitle: "Milestone",
      isRetry: false,
      previousTier: void 0
    },
    { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 }
  );
  assert.equal(result.action, "break");
  assert.equal(result.reason, "ghost-completion");
  assert.equal(deps.callLog.includes("pauseAuto"), true);
  assert.equal(closeoutCalls, 0);
  assert.equal(preVerificationCalls, 0);
  assert.equal(postVerificationCalls, 0);
  assert.equal(s.currentUnit, null);
  assert.ok(
    journalEvents.some(
      (event) => event.eventType === "unit-end" && event.data?.status === "cancelled" && event.data?.errorContext?.message.includes("stale ghost completion")
    ),
    "ghost completion should emit a cancelled unit-end"
  );
});
test("resolveAgentEndCancelled without args produces no errorContext field", async () => {
  _resetPendingResolve();
  const { _setCurrentResolve } = await import("../auto/resolve.js");
  const p = new Promise((r) => {
    _setCurrentResolve(r);
  });
  resolveAgentEndCancelled();
  const resolved = await p;
  assert.equal(resolved.status, "cancelled");
  assert.equal(resolved.errorContext, void 0, "errorContext must not be present when no args passed");
});
test("resolveAgentEndCancelled queues cancellation that arrives during session switch", () => {
  _resetPendingResolve();
  _setSessionSwitchInFlight(true);
  const resolved = resolveAgentEndCancelled({
    message: "Claude Code process aborted by user",
    category: "aborted",
    isTransient: false
  });
  assert.equal(resolved, false);
  const pending = _consumePendingSwitchCancellation();
  assert.ok(pending?.errorContext, "queued cancellation should preserve errorContext");
  assert.equal(pending.errorContext.category, "aborted");
  assert.equal(pending.errorContext.message, "Claude Code process aborted by user");
  assert.equal(_consumePendingSwitchCancellation(), null);
  _resetPendingResolve();
});
test("session-switch abort grace window is short-lived and resettable", () => {
  _resetPendingResolve();
  _markSessionSwitchAbortGraceWindow(1e3);
  assert.equal(isSessionSwitchAbortGraceActive(Date.now()), true);
  assert.equal(isSessionSwitchAbortGraceActive(Date.now() + 1e4), false);
  _clearSessionSwitchAbortGraceWindow();
  assert.equal(isSessionSwitchAbortGraceActive(), false);
});
test("autoLoop re-iterates when postUnitPreVerification returns retry (#1571)", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 3e4 });
  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {
    };
    const pi = makeMockPi();
    const s = makeLoopSession();
    let preVerifyCallCount = 0;
    const preVerifyResponses = ["retry", "continue"];
    const deps = makeMockDeps({
      deriveState: async () => {
        deps.callLog.push("deriveState");
        return {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: { id: "S01", title: "Slice 1" },
          activeTask: { id: "T01" },
          registry: [{ id: "M001", status: "active" }],
          blockers: []
        };
      },
      postUnitPreVerification: async () => {
        deps.callLog.push("postUnitPreVerification");
        const response = preVerifyResponses[preVerifyCallCount++] ?? "continue";
        if (response === "retry") {
          s.pendingVerificationRetry = {
            unitId: "M001/S01/T01",
            failureContext: "missing artifact",
            attempt: 1
          };
        }
        return response;
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        s.active = false;
        return "continue";
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    await waitForMicrotasks(() => pi.calls.length === 1, "first dispatch");
    resolveAgentEnd(makeEvent());
    await drainMicrotasks(100);
    mock.timers.tick(3e4);
    await waitForMicrotasks(() => pi.calls.length === 2, "retry dispatch");
    resolveAgentEnd(makeEvent());
    await loopPromise;
    assert.equal(preVerifyCallCount, 2, "preVerification should be called twice");
    const postVerifyCalls = deps.callLog.filter(
      (c) => c === "runPostUnitVerification"
    );
    const postPostVerifyCalls = deps.callLog.filter(
      (c) => c === "postUnitPostVerification"
    );
    assert.equal(postVerifyCalls.length, 1, "runPostUnitVerification should only be called once");
    assert.equal(postPostVerifyCalls.length, 1, "postUnitPostVerification should only be called once");
  } finally {
    mock.timers.reset();
  }
});
test("resolveAgentEnd unblocks pending runUnit when called before session reset (#1799)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const s = makeMockSession();
  const resultPromise = runUnit(ctx, pi, s, "task", "T01", "do work");
  await new Promise((r) => setTimeout(r, 10));
  resolveAgentEnd({ messages: [] });
  _resetPendingResolve();
  s.active = false;
  const result = await resultPromise;
  assert.equal(result.status, "completed", "runUnit should resolve, not hang");
});
test("autoLoop rejects execute-task with 0 tool calls as hallucinated (#1833)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  let iterationCount = 0;
  const notifications = [];
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
  };
  const s = makeLoopSession();
  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: []
  };
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      };
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: "M001/S01/T01",
        prompt: "implement the feature"
      };
    },
    closeoutUnit: async () => {
      mockLedger.units.push({
        type: "execute-task",
        id: "M001/S01/T01",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 100, output: 200, total: 300, cacheRead: 0, cacheWrite: 0 },
        cost: 0.5
      });
    },
    getLedger: () => mockLedger,
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      iterationCount++;
      s.active = iterationCount < 2;
      return "continue";
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());
  await new Promise((r) => setTimeout(r, 50));
  mockLedger.units.length = 0;
  deps.closeoutUnit = async () => {
    mockLedger.units.push({
      type: "execute-task",
      id: "M001/S01/T01",
      startedAt: s.currentUnit?.startedAt ?? Date.now(),
      toolCalls: 5,
      assistantMessages: 3,
      tokens: { input: 500, output: 800, total: 1300, cacheRead: 0, cacheWrite: 0 },
      cost: 1
    });
  };
  resolveAgentEnd(makeEvent());
  await loopPromise;
  const warningNotification = notifications.find(
    (n) => n.includes("0 tool calls") && n.includes("context exhaustion")
  );
  assert.ok(
    warningNotification,
    "should notify about 0 tool calls context exhaustion"
  );
  const deriveCount = deps.callLog.filter((c) => c === "deriveState").length;
  assert.ok(
    deriveCount >= 2,
    `deriveState should be called at least 2 times for retry (got ${deriveCount})`
  );
});
test("autoLoop pauses user-driven deep question instead of flagging 0 tool calls", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const notifications = [];
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
  };
  const s = makeLoopSession();
  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: []
  };
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Bootstrap", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      };
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch",
        unitType: "discuss-project",
        unitId: "PROJECT",
        prompt: "ask what to build"
      };
    },
    closeoutUnit: async () => {
      mockLedger.units.push({
        type: "discuss-project",
        id: "PROJECT",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 100, output: 20, total: 120, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01
      });
    },
    getLedger: () => mockLedger,
    postUnitPreVerification: async () => {
      deps.callLog.push("postUnitPreVerification");
      return "dispatched";
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent([
    {
      role: "assistant",
      content: [
        { type: "text", text: "What do you want to build?" }
      ]
    }
  ]));
  await loopPromise;
  assert.ok(
    deps.callLog.includes("postUnitPreVerification"),
    "questioning units should reach post-unit verification so the pause path can run"
  );
  assert.ok(
    !notifications.some((n) => n.includes("context exhaustion")),
    "questioning units should not show the context-exhaustion warning"
  );
});
test("autoLoop rejects complete-slice with 0 tool calls as context-exhausted (#2653)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  let iterationCount = 0;
  const notifications = [];
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
  };
  const s = makeLoopSession();
  const mockLedger = {
    version: 1,
    projectStartedAt: Date.now(),
    units: []
  };
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      };
    },
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch",
        unitType: "complete-slice",
        unitId: "M001/S01",
        prompt: "complete the slice"
      };
    },
    closeoutUnit: async () => {
      mockLedger.units.push({
        type: "complete-slice",
        id: "M001/S01",
        startedAt: s.currentUnit?.startedAt ?? Date.now(),
        toolCalls: 0,
        assistantMessages: 1,
        tokens: { input: 50, output: 100, total: 150, cacheRead: 0, cacheWrite: 0 },
        cost: 0.1
      });
    },
    getLedger: () => mockLedger,
    postUnitPostVerification: async () => {
      deps.callLog.push("postUnitPostVerification");
      iterationCount++;
      s.active = iterationCount < 2;
      return "continue";
    }
  });
  const loopPromise = autoLoop(ctx, pi, s, deps);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd(makeEvent());
  await new Promise((r) => setTimeout(r, 50));
  mockLedger.units.length = 0;
  deps.closeoutUnit = async () => {
    mockLedger.units.push({
      type: "complete-slice",
      id: "M001/S01",
      startedAt: s.currentUnit?.startedAt ?? Date.now(),
      toolCalls: 3,
      assistantMessages: 2,
      tokens: { input: 200, output: 400, total: 600, cacheRead: 0, cacheWrite: 0 },
      cost: 0.3
    });
  };
  resolveAgentEnd(makeEvent());
  await loopPromise;
  const warningNotification = notifications.find(
    (n) => n.includes("0 tool calls")
  );
  assert.ok(
    warningNotification,
    "should flag complete-slice with 0 tool calls as failed (#2653)"
  );
  const deriveCount = deps.callLog.filter((c) => c === "deriveState").length;
  assert.ok(
    deriveCount >= 2,
    `deriveState should be called at least 2 times for retry (got ${deriveCount})`
  );
});
test("autoLoop stops when Worktree Safety finds no .git marker for execute-task (#1833)", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const notifications = [];
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
  };
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-loop-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const s = makeLoopSession({
    basePath: worktreeRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot
  });
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      };
    },
    getIsolationMode: () => "worktree"
  });
  await autoLoop(ctx, pi, s, deps);
  assert.ok(
    deps.callLog.includes("stopAuto"),
    "should stop auto-mode when worktree is invalid"
  );
  const healthNotification = notifications.find(
    (n) => n.includes("Worktree Safety failed") && n.includes("worktree-git-marker-missing")
  );
  assert.ok(
    healthNotification,
    "should notify about missing worktree .git marker"
  );
});
test("dispatch Worktree Safety wins before stuck detection for execute-task without .git", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications = [];
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
  };
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-dispatch-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const s = makeLoopSession({
    basePath: worktreeRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot
  });
  const deps = makeMockDeps({
    getIsolationMode: () => "worktree"
  });
  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: void 0,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      },
      mid: "M001",
      midTitle: "Test"
    },
    {
      recentUnits: [
        { key: "execute-task/M001/S01/T01" },
        { key: "execute-task/M001/S01/T01" }
      ],
      stuckRecoveryAttempts: 1,
      consecutiveFinalizeTimeouts: 0
    }
  );
  assert.equal(result.action, "break");
  assert.equal(result.reason, "worktree-git-marker-missing");
  assert.ok(deps.callLog.includes("stopAuto"), "should stop through Worktree Safety");
  assert.ok(
    notifications.some((n) => n.includes("Worktree Safety failed") && n.includes("worktree-git-marker-missing")),
    "should notify about missing worktree .git marker"
  );
  assert.ok(
    !notifications.some((n) => n.includes("Stuck on execute-task")),
    "stuck-loop message must not mask the worktree health failure"
  );
});
test("runDispatch runs stuck detection while artifact verification retry is pending (#5719)", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications = [];
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
  };
  const basePath = mkdtempSync(join(tmpdir(), "gsd-5719-retry-stuck-"));
  t.after(() => rmSync(basePath, { recursive: true, force: true }));
  const s = makeLoopSession({
    basePath,
    pendingVerificationRetry: {
      unitId: "M001/S01/T01",
      failureContext: "ENOENT: no such file or directory, access '/tmp/missing-plan.md'",
      attempt: 1
    }
  });
  const deps = makeMockDeps();
  const loopState = {
    recentUnits: [
      {
        key: "execute-task/M001/S01/T01",
        error: "ENOENT: no such file or directory, access '/tmp/missing-plan.md'"
      },
      { key: "plan-slice/M001/S02", error: "other failure" },
      {
        key: "complete-slice/M001/S01",
        error: "ENOENT: no such file or directory, access '/tmp/missing-plan.md'"
      }
    ],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0
  };
  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: void 0,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      },
      mid: "M001",
      midTitle: "Test"
    },
    loopState
  );
  assert.equal(result.action, "next", "level-1 stuck recovery should still allow the recovery dispatch");
  assert.equal(loopState.stuckRecoveryAttempts, 1, "stuck recovery should record the first recovery attempt");
  assert.ok(deps.callLog.includes("invalidateAllCaches"), "stuck recovery should invalidate caches");
  assert.ok(
    notifications.some((n) => n.includes("Missing file referenced twice")),
    "notification should surface the repeated ENOENT stuck reason"
  );
});
test("runDispatch falls back to main when dispatch guard cannot read main branch (#5530)", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const basePath = mkdtempSync(join(tmpdir(), "gsd-5530-main-branch-fallback-"));
  t.after(() => rmSync(basePath, { recursive: true, force: true }));
  let guardBranch = null;
  const s = makeLoopSession({ basePath });
  const deps = makeMockDeps({
    getMainBranch: () => {
      throw new Error("fatal: detected dubious ownership");
    },
    getPriorSliceCompletionBlocker: (_basePath, mainBranch) => {
      guardBranch = mainBranch;
      return null;
    }
  });
  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: void 0,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      },
      mid: "M001",
      midTitle: "Test"
    },
    {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0
    }
  );
  assert.equal(guardBranch, "main");
  assert.equal(result.action, "next");
});
test("dispatch Worktree Safety stops unknown unit types with missing Tool Contract", async (t) => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications = [];
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
  };
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-wt-safety-missing-contract-"));
  const worktreeRoot = join(projectRoot, ".gsd", "worktrees", "M001");
  mkdirSync(worktreeRoot, { recursive: true });
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const s = makeLoopSession({
    basePath: worktreeRoot,
    originalBasePath: projectRoot,
    canonicalProjectRoot: projectRoot
  });
  const deps = makeMockDeps({
    getIsolationMode: () => "worktree",
    resolveDispatch: async () => {
      deps.callLog.push("resolveDispatch");
      return {
        action: "dispatch",
        unitType: "new-source-writing-unit-without-manifest",
        unitId: "M001/S01/T01",
        prompt: "do the thing"
      };
    }
  });
  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: void 0,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      },
      mid: "M001",
      midTitle: "Test"
    },
    {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0
    }
  );
  assert.equal(result.action, "break");
  assert.equal(result.reason, "missing-tool-contract");
  assert.ok(deps.callLog.includes("stopAuto"), "should stop when the Tool Contract is missing");
  assert.ok(
    notifications.some((n) => n.includes("missing Tool Contract for new-source-writing-unit-without-manifest")),
    "should notify with an actionable missing Tool Contract reason"
  );
});
test("pre-dispatch skip resolves before dispatch health and stuck accounting", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications = [];
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
  };
  const s = makeLoopSession({ basePath: "/tmp/broken-worktree" });
  const deps = makeMockDeps({
    existsSync: (p) => !p.endsWith(".git"),
    runPreDispatchHooks: () => ({ firedHooks: ["skip-execute"], action: "skip" })
  });
  const loopState = {
    recentUnits: [
      { key: "execute-task/M001/S01/T01" },
      { key: "execute-task/M001/S01/T01" }
    ],
    stuckRecoveryAttempts: 1,
    consecutiveFinalizeTimeouts: 0
  };
  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: void 0,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      },
      mid: "M001",
      midTitle: "Test"
    },
    loopState
  );
  assert.equal(result.action, "continue");
  assert.ok(!deps.callLog.includes("stopAuto"), "skip hook should not stop on worktree health");
  assert.equal(loopState.recentUnits.length, 2, "skip hook should not update stuck accounting");
  assert.ok(
    notifications.some((n) => n.includes("Skipping execute-task M001/S01/T01")),
    "should notify about the skip hook"
  );
  assert.ok(
    !notifications.some((n) => n.includes("Worktree health check failed") || n.includes("Stuck on execute-task")),
    "health and stuck notifications must not run before skip hook resolution"
  );
});
test("pre-dispatch replace resolves final unit before dispatch health and stuck accounting", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  const pi = makeMockPi();
  const notifications = [];
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
  };
  const s = makeLoopSession({ basePath: "/tmp/broken-worktree" });
  const deps = makeMockDeps({
    existsSync: (p) => !p.endsWith(".git"),
    runPreDispatchHooks: () => ({
      firedHooks: ["review"],
      action: "replace",
      unitType: "run-uat",
      prompt: "review before executing",
      model: "review-model"
    })
  });
  const loopState = {
    recentUnits: [
      { key: "execute-task/M001/S01/T01" },
      { key: "execute-task/M001/S01/T01" }
    ],
    stuckRecoveryAttempts: 1,
    consecutiveFinalizeTimeouts: 0
  };
  const result = await runDispatch(
    {
      ctx,
      pi,
      s,
      deps,
      prefs: void 0,
      iteration: 1,
      flowId: "test-flow",
      nextSeq: () => 1
    },
    {
      state: {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      },
      mid: "M001",
      midTitle: "Test"
    },
    loopState
  );
  assert.equal(result.action, "next");
  assert.equal(result.data?.unitType, "run-uat");
  assert.equal(result.data?.finalPrompt, "review before executing");
  assert.equal(result.data?.hookModelOverride, "review-model");
  assert.ok(!deps.callLog.includes("stopAuto"), "replace hook should not stop on execute-task health");
  assert.deepEqual(
    loopState.recentUnits.map((u) => u.key),
    [
      "execute-task/M001/S01/T01",
      "execute-task/M001/S01/T01",
      "run-uat/M001/S01/T01"
    ],
    "stuck accounting should record the final replaced unit"
  );
  assert.ok(
    !notifications.some((n) => n.includes("Worktree health check failed") || n.includes("Stuck on execute-task")),
    "health and stuck notifications must use the final replaced unit"
  );
});
test("autoLoop warns but proceeds for greenfield project (no project files) (#1833)", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
  const pi = makeMockPi();
  const notifications = [];
  const s = makeLoopSession({ basePath: "/tmp/empty-worktree" });
  ctx.ui.notify = (msg) => {
    notifications.push(msg);
    if (msg.includes("greenfield")) {
      s.active = false;
    }
  };
  const deps = makeMockDeps({
    deriveState: async () => {
      deps.callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01" },
        registry: [{ id: "M001", status: "active" }],
        blockers: []
      };
    },
    // Has .git but no package.json or src/
    existsSync: (p) => p.endsWith(".git")
  });
  await autoLoop(ctx, pi, s, deps);
  const stoppedForHealth = notifications.find(
    (n) => n.includes("Worktree health check failed")
  );
  assert.ok(
    !stoppedForHealth,
    "should not stop with health check failure for greenfield project"
  );
  const greenfieldWarning = notifications.find(
    (n) => n.includes("no project content yet") && n.includes("greenfield")
  );
  assert.ok(
    greenfieldWarning,
    "should warn about greenfield project (no project files)"
  );
});
test("autoLoop enforces min_request_interval_ms delay between LLM dispatches (#2996)", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1e3 });
  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {
    };
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    const originalSendMessage = pi.sendMessage;
    const dispatchTimestamps = [];
    pi.sendMessage = (...args) => {
      dispatchTimestamps.push(Date.now());
      return originalSendMessage(...args);
    };
    let iterCount = 0;
    const s = makeLoopSession();
    const deps = makeMockDeps({
      loadEffectiveGSDPreferences: () => ({
        preferences: {
          min_request_interval_ms: 300,
          uok: { plan_v2: { enabled: false } }
        }
      }),
      deriveState: async () => {
        iterCount++;
        deps.callLog.push("deriveState");
        return {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: { id: "S01", title: "Slice" },
          activeTask: { id: "T01" },
          registry: [{ id: "M001", status: "active" }],
          blockers: []
        };
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        if (iterCount >= 2) {
          s.active = false;
        }
        return "continue";
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    await waitForMicrotasks(() => dispatchTimestamps.length === 1, "first dispatch");
    resolveAgentEnd(makeEvent());
    await waitForMicrotasks(
      () => deps.callLog.filter((entry) => entry === "resolveDispatch").length >= 2,
      "second dispatch planning"
    );
    await drainMicrotasks(100);
    mock.timers.tick(299);
    await drainMicrotasks(100);
    assert.equal(dispatchTimestamps.length, 1, "second dispatch should wait for the configured interval");
    mock.timers.tick(1);
    await waitForMicrotasks(() => dispatchTimestamps.length === 2, "second dispatch");
    resolveAgentEnd(makeEvent());
    await loopPromise;
    assert.ok(iterCount >= 2, `expected at least 2 iterations, got ${iterCount}`);
    assert.ok(dispatchTimestamps.length >= 2, `expected at least 2 dispatches, got ${dispatchTimestamps.length}`);
    assert.equal(
      s.lastRequestTimestamp,
      dispatchTimestamps[1],
      "lastRequestTimestamp should record the actual dispatch time"
    );
    const gap = dispatchTimestamps[1] - dispatchTimestamps[0];
    assert.equal(
      gap,
      300,
      `gap between dispatches should match min_request_interval_ms=300 (got ${gap}ms)`
    );
  } finally {
    mock.timers.reset();
  }
});
test("autoLoop skips rate-limit delay when min_request_interval_ms is 0 (default)", async () => {
  _resetPendingResolve();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2e3 });
  try {
    const ctx = makeMockCtx();
    ctx.ui.setStatus = () => {
    };
    ctx.sessionManager = { getSessionFile: () => "/tmp/session.json" };
    const pi = makeMockPi();
    const originalSendMessage = pi.sendMessage;
    const dispatchTimestamps = [];
    pi.sendMessage = (...args) => {
      dispatchTimestamps.push(Date.now());
      return originalSendMessage(...args);
    };
    let iterCount = 0;
    const s = makeLoopSession();
    const deps = makeMockDeps({
      loadEffectiveGSDPreferences: () => ({
        preferences: { uok: { plan_v2: { enabled: false } } }
      }),
      deriveState: async () => {
        iterCount++;
        deps.callLog.push("deriveState");
        return {
          phase: "executing",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: { id: "S01", title: "Slice" },
          activeTask: { id: "T01" },
          registry: [{ id: "M001", status: "active" }],
          blockers: []
        };
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        if (iterCount >= 3) {
          s.active = false;
        }
        return "continue";
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    for (let i = 1; i <= 3; i++) {
      await waitForMicrotasks(() => dispatchTimestamps.length === i, `dispatch ${i}`);
      resolveAgentEnd(makeEvent());
    }
    await loopPromise;
    assert.ok(iterCount >= 3, `expected at least 3 iterations, got ${iterCount}`);
    assert.ok(dispatchTimestamps.length >= 3, `expected at least 3 dispatches, got ${dispatchTimestamps.length}`);
    const gap = dispatchTimestamps[2] - dispatchTimestamps[1];
    assert.equal(
      gap,
      0,
      `gap should be 0ms under mocked time without rate limiting (got ${gap}ms)`
    );
  } finally {
    mock.timers.reset();
  }
});
test("autoLoop classifies ModelPolicyDispatchBlockedError as blocked, not a retryable error", async () => {
  _resetPendingResolve();
  const ctx = makeMockCtx();
  ctx.ui.setStatus = () => {
  };
  const notifications = [];
  ctx.ui.notify = (m, l) => {
    notifications.push({ message: m, level: l });
  };
  const pi = makeMockPi();
  const s = makeLoopSession();
  const journalEvents = [];
  let pauseAutoCalls = 0;
  let stopAutoCalls = 0;
  const turnResults = [];
  const deps = makeMockDeps({
    selectAndApplyModel: async () => {
      throw new ModelPolicyDispatchBlockedError(
        "research-slice",
        "M001/S01",
        [{ provider: "openai", modelId: "gpt-4o", reason: "tool policy denied (web_search) for openai-completions" }]
      );
    },
    pauseAuto: async () => {
      pauseAutoCalls++;
    },
    stopAuto: async () => {
      stopAutoCalls++;
    },
    emitJournalEvent: (entry) => {
      journalEvents.push(entry);
    },
    uokObserver: {
      onTurnStart: () => {
      },
      onPhaseResult: () => {
      },
      onTurnResult: (res) => {
        turnResults.push({ unitType: res.unitType, unitId: res.unitId, status: res.status });
      }
    }
  });
  await autoLoop(ctx, pi, s, deps);
  const unitEnd = journalEvents.find(
    (e) => e.eventType === "unit-end" && e.data?.status === "blocked"
  );
  assert.ok(unitEnd, "should emit unit-end with status=blocked");
  assert.equal(unitEnd.data.reason, "model-policy-dispatch-blocked");
  const unitEndIndex = journalEvents.findIndex(
    (e) => e.eventType === "unit-end" && e.data?.status === "blocked"
  );
  const iterationEndIndex = journalEvents.findIndex(
    (e) => e.eventType === "iteration-end" && e.data?.status === "blocked"
  );
  assert.ok(iterationEndIndex > unitEndIndex, "blocked policy iterations must close after unit-end");
  assert.equal(pauseAutoCalls, 1, "should pause once on policy block");
  assert.equal(stopAutoCalls, 0, "should NOT call stopAuto \u2014 pre-send block is not a retryable iteration error");
  const blockedNotice = notifications.find(
    (n) => n.message.includes("model-policy denied dispatch") && n.message.includes("tool policy denied (web_search)")
  );
  assert.ok(blockedNotice, "user-facing notification should name the policy block + deny reason");
  const pausedTurn = turnResults.find((r) => r.status === "paused");
  assert.ok(pausedTurn, "uokObserver should observe a paused turn for the blocked unit");
  assert.equal(pausedTurn.unitType, "research-slice", "onTurnResult must receive the blocked unitType from the typed error");
  assert.equal(pausedTurn.unitId, "M001/S01", "onTurnResult must receive the blocked unitId from the typed error");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLWxvb3AudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEF1dG8tbG9vcCBleGVjdXRpb24sIGRpc3BhdGNoLCByZWNvdmVyeSwgYW5kIGNhbmNlbGxhdGlvbiByZWdyZXNzaW9uIHRlc3RzLlxuXG5pbXBvcnQgdGVzdCwgeyBtb2NrIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7XG4gIHJlc29sdmVBZ2VudEVuZCxcbiAgcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkLFxuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSxcbiAgX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCxcbiAgX3NldEFjdGl2ZVNlc3Npb24sXG4gIF9zZXRTZXNzaW9uU3dpdGNoSW5GbGlnaHQsXG4gIF9tYXJrU2Vzc2lvblN3aXRjaEFib3J0R3JhY2VXaW5kb3csXG4gIF9jbGVhclNlc3Npb25Td2l0Y2hBYm9ydEdyYWNlV2luZG93LFxuICBfY29uc3VtZVBlbmRpbmdTd2l0Y2hDYW5jZWxsYXRpb24sXG4gIGlzU2Vzc2lvblN3aXRjaEluRmxpZ2h0LFxuICBpc1Nlc3Npb25Td2l0Y2hBYm9ydEdyYWNlQWN0aXZlLFxufSBmcm9tIFwiLi4vYXV0by9yZXNvbHZlLmpzXCI7XG5pbXBvcnQgeyBydW5Vbml0LCBzaG91bGREZWZlclVuaXRGYWlsc2FmZVRpbWVvdXQgfSBmcm9tIFwiLi4vYXV0by9ydW4tdW5pdC5qc1wiO1xuaW1wb3J0IHsgd3JpdGVVbml0UnVudGltZVJlY29yZCwgcmVhZFVuaXRSdW50aW1lUmVjb3JkIH0gZnJvbSBcIi4uL3VuaXQtcnVudGltZS5qc1wiO1xuaW1wb3J0IHsgYXV0b0xvb3AgfSBmcm9tIFwiLi4vYXV0by9sb29wLmpzXCI7XG5pbXBvcnQgeyBydW5EaXNwYXRjaCwgcnVuVW5pdFBoYXNlIH0gZnJvbSBcIi4uL2F1dG8vcGhhc2VzLmpzXCI7XG5pbXBvcnQgeyBkZXRlY3RTdHVjayB9IGZyb20gXCIuLi9hdXRvL2RldGVjdC1zdHVjay5qc1wiO1xuaW1wb3J0IHR5cGUgeyBVbml0UmVzdWx0LCBBZ2VudEVuZEV2ZW50IH0gZnJvbSBcIi4uL2F1dG8vdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgTG9vcERlcHMgfSBmcm9tIFwiLi4vYXV0by9sb29wLWRlcHMuanNcIjtcbmltcG9ydCB7IFdvcmt0cmVlU3RhdGVQcm9qZWN0aW9uIH0gZnJvbSBcIi4uL3dvcmt0cmVlLXN0YXRlLXByb2plY3Rpb24uanNcIjtcbmltcG9ydCB7IE1vZGVsUG9saWN5RGlzcGF0Y2hCbG9ja2VkRXJyb3IgfSBmcm9tIFwiLi4vYXV0by1tb2RlbC1zZWxlY3Rpb24uanNcIjtcbmltcG9ydCB0eXBlIHsgU2Vzc2lvbkxvY2tTdGF0dXMgfSBmcm9tIFwiLi4vc2Vzc2lvbi1sb2NrLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlRXZlbnQoXG4gIG1lc3NhZ2VzOiB1bmtub3duW10gPSBbeyByb2xlOiBcImFzc2lzdGFudFwiIH1dLFxuKTogQWdlbnRFbmRFdmVudCB7XG4gIHJldHVybiB7IG1lc3NhZ2VzIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGRyYWluTWljcm90YXNrcyh0dXJucyA9IDIwKTogUHJvbWlzZTx2b2lkPiB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdHVybnM7IGkrKykge1xuICAgIGF3YWl0IFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JNaWNyb3Rhc2tzKFxuICBjb25kaXRpb246ICgpID0+IGJvb2xlYW4sXG4gIGxhYmVsOiBzdHJpbmcsXG4gIHR1cm5zID0gNTAwLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgdHVybnM7IGkrKykge1xuICAgIGlmIChjb25kaXRpb24oKSkgcmV0dXJuO1xuICAgIGF3YWl0IFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG4gIGFzc2VydC5mYWlsKGBUaW1lZCBvdXQgd2FpdGluZyBmb3IgJHtsYWJlbH1gKTtcbn1cblxuLyoqXG4gKiBCdWlsZCBhIG1pbmltYWwgbW9jayBBdXRvU2Vzc2lvbiB3aXRoIGNvbnRyb2xsYWJsZSBuZXdTZXNzaW9uIGJlaGF2aW9yLlxuICovXG5mdW5jdGlvbiBtYWtlTW9ja1Nlc3Npb24ob3B0cz86IHtcbiAgbmV3U2Vzc2lvblJlc3VsdD86IHsgY2FuY2VsbGVkOiBib29sZWFuIH07XG4gIG5ld1Nlc3Npb25UaHJvd3M/OiBzdHJpbmc7XG4gIG5ld1Nlc3Npb25EZWxheU1zPzogbnVtYmVyO1xuICBvbk5ld1Nlc3Npb25TdGFydD86IChzZXNzaW9uOiBhbnkpID0+IHZvaWQ7XG4gIG9uTmV3U2Vzc2lvblNldHRsZT86IChzZXNzaW9uOiBhbnkpID0+IHZvaWQ7XG4gIC8qKiBDYWxsZWQgYWZ0ZXIgdGhlIGRlbGF5IHdpdGggdGhlIGFib3J0ZWQgc3RhdGUgb2YgYW55IHBhc3NlZCBhYm9ydFNpZ25hbC5cbiAgICogIFVzZWQgdG8gdmVyaWZ5IHRoYXQgcnVuVW5pdCBwYXNzZXMgYW4gYWJvcnRlZCBzaWduYWwgb24gbGF0ZSByZXNvbHV0aW9uICgjMzczMSkuICovXG4gIG9uU2lnbmFsQ2hlY2s/OiAoYWJvcnRlZDogYm9vbGVhbikgPT4gdm9pZDtcbn0pIHtcbiAgY29uc3Qgc2Vzc2lvbiA9IHtcbiAgICBhY3RpdmU6IHRydWUsXG4gICAgdmVyYm9zZTogZmFsc2UsXG4gICAgYmFzZVBhdGg6IHByb2Nlc3MuY3dkKCksXG4gICAgY21kQ3R4OiB7XG4gICAgICBuZXdTZXNzaW9uOiAob3B0aW9ucz86IHsgYWJvcnRTaWduYWw/OiBBYm9ydFNpZ25hbDsgd29ya3NwYWNlUm9vdD86IHN0cmluZyB9KSA9PiB7XG4gICAgICAgIG9wdHM/Lm9uTmV3U2Vzc2lvblN0YXJ0Py4oc2Vzc2lvbik7XG4gICAgICAgIGlmIChvcHRzPy5uZXdTZXNzaW9uVGhyb3dzKSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBFcnJvcihvcHRzLm5ld1Nlc3Npb25UaHJvd3MpKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByZXN1bHQgPSBvcHRzPy5uZXdTZXNzaW9uUmVzdWx0ID8/IHsgY2FuY2VsbGVkOiBmYWxzZSB9O1xuICAgICAgICBjb25zdCBkZWxheSA9IG9wdHM/Lm5ld1Nlc3Npb25EZWxheU1zID8/IDA7XG4gICAgICAgIGlmIChkZWxheSA+IDApIHtcbiAgICAgICAgICByZXR1cm4gbmV3IFByb21pc2U8eyBjYW5jZWxsZWQ6IGJvb2xlYW4gfT4oKHJlcykgPT5cbiAgICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgICAvLyBTaW11bGF0ZSBBZ2VudFNlc3Npb24ubmV3U2Vzc2lvbigpIGNoZWNraW5nIGFib3J0U2lnbmFsIGFmdGVyXG4gICAgICAgICAgICAgIC8vIGl0cyBpbnRlcm5hbCBhc3luYyB3b3JrIChhYm9ydCgpKSBjb21wbGV0ZXMgXHUyMDE0IHRoaXMgaXMgd2hlcmUgdGhlXG4gICAgICAgICAgICAgIC8vIHJlYWwgY29kZSBzZWxlY3RzIGEgd29ya3NwYWNlIHJvb3QgYW5kIHJlYnVpbGRzIHRoZSB0b29sIHJ1bnRpbWUuXG4gICAgICAgICAgICAgIC8vIElmIHRoZSBzaWduYWwgaXMgYWJvcnRlZCwgdGhlIHJlYWwgY29kZSBkaXNjYXJkcyB0aGUgc2Vzc2lvbi5cbiAgICAgICAgICAgICAgb3B0cz8ub25TaWduYWxDaGVjaz8uKG9wdGlvbnM/LmFib3J0U2lnbmFsPy5hYm9ydGVkID8/IGZhbHNlKTtcbiAgICAgICAgICAgICAgb3B0cz8ub25OZXdTZXNzaW9uU2V0dGxlPy4oc2Vzc2lvbik7XG4gICAgICAgICAgICAgIHJlcyhyZXN1bHQpO1xuICAgICAgICAgICAgfSwgZGVsYXkpLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgb3B0cz8ub25TaWduYWxDaGVjaz8uKG9wdGlvbnM/LmFib3J0U2lnbmFsPy5hYm9ydGVkID8/IGZhbHNlKTtcbiAgICAgICAgb3B0cz8ub25OZXdTZXNzaW9uU2V0dGxlPy4oc2Vzc2lvbik7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzdWx0KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBjbGVhclRpbWVyczogKCkgPT4ge30sXG4gIH0gYXMgYW55O1xuICByZXR1cm4gc2Vzc2lvbjtcbn1cblxuLyoqXG4gKiBCdWlsZCBhIG1pbmltYWwgbW9jayBFeHRlbnNpb25Db250ZXh0LlxuICovXG5mdW5jdGlvbiBtYWtlTW9ja0N0eCgpIHtcbiAgcmV0dXJuIHtcbiAgICB1aTogeyBub3RpZnk6ICgpID0+IHt9IH0sXG4gICAgbW9kZWw6IHsgaWQ6IFwidGVzdC1tb2RlbFwiIH0sXG4gIH0gYXMgYW55O1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgbWluaW1hbCBtb2NrIEV4dGVuc2lvbkFQSSB0aGF0IHJlY29yZHMgc2VuZE1lc3NhZ2UgY2FsbHMuXG4gKi9cbmZ1bmN0aW9uIG1ha2VNb2NrUGkoKSB7XG4gIGNvbnN0IGNhbGxzOiB1bmtub3duW10gPSBbXTtcbiAgY29uc3Qgc2V0TW9kZWxDYWxsczogdW5rbm93bltdID0gW107XG4gIHJldHVybiB7XG4gICAgc2VuZE1lc3NhZ2U6ICguLi5hcmdzOiB1bmtub3duW10pID0+IHtcbiAgICAgIGNhbGxzLnB1c2goYXJncyk7XG4gICAgfSxcbiAgICBzZXRNb2RlbDogYXN5bmMgKC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuICAgICAgc2V0TW9kZWxDYWxscy5wdXNoKGFyZ3MpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSxcbiAgICBjYWxscyxcbiAgICBzZXRNb2RlbENhbGxzLFxuICB9IGFzIGFueTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwicmVzb2x2ZUFnZW50RW5kIHJlc29sdmVzIGEgcGVuZGluZyBydW5Vbml0IHByb21pc2VcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKCk7XG4gIGNvbnN0IGV2ZW50ID0gbWFrZUV2ZW50KCk7XG5cbiAgLy8gU3RhcnQgcnVuVW5pdCBcdTIwMTQgaXQgd2lsbCBjcmVhdGUgdGhlIHByb21pc2UgYW5kIHNlbmQgYSBtZXNzYWdlLFxuICAvLyB0aGVuIGJsb2NrIGF3YWl0aW5nIGFnZW50X2VuZFxuICBjb25zdCByZXN1bHRQcm9taXNlID0gcnVuVW5pdChcbiAgICBjdHgsXG4gICAgcGksXG4gICAgcyxcbiAgICBcInRhc2tcIixcbiAgICBcIlQwMVwiLFxuICAgIFwiZG8gc3R1ZmZcIixcbiAgKTtcblxuICAvLyBHaXZlIHRoZSBtaWNyb3Rhc2sgcXVldWUgYSB0aWNrIHNvIHJ1blVuaXQgcmVhY2hlcyB0aGUgYXdhaXRcbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTApKTtcblxuICAvLyBOb3cgcmVzb2x2ZSB0aGUgYWdlbnRfZW5kXG4gIHJlc29sdmVBZ2VudEVuZChldmVudCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzdWx0UHJvbWlzZTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIFwiY29tcGxldGVkXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5ldmVudCwgZXZlbnQpO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0IGZhaWxzYWZlIGRlZmVycyBjYW5jZWxsYXRpb24gd2hpbGUgdGltZW91dCByZWNvdmVyeSBpcyBtYWtpbmcgZnJlc2ggcHJvZ3Jlc3NcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuICBtb2NrLnRpbWVycy5lbmFibGUoKTtcbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBwcm9jZXNzLmN3ZCgpO1xuXG4gIHRyeSB7XG4gICAgbW9jay50aW1lcnMuc2V0VGltZSgxMF8wMDApO1xuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbigpO1xuICAgIHMuYmFzZVBhdGggPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1ydW51bml0LXJlY292ZXJ5LVwiKSk7XG4gICAgcy5jdXJyZW50VW5pdCA9IHsgdHlwZTogXCJ0YXNrXCIsIGlkOiBcIlQwMVwiLCBzdGFydGVkQXQ6IDEyMzQgfTtcblxuICAgIGNvbnN0IHJlc3VsdFByb21pc2UgPSBydW5Vbml0KGN0eCwgcGksIHMsIFwidGFza1wiLCBcIlQwMVwiLCBcInByb21wdFwiKTtcbiAgICBhd2FpdCB3YWl0Rm9yTWljcm90YXNrcygoKSA9PiBwaS5jYWxscy5sZW5ndGggPT09IDEsIFwidW5pdCBkaXNwYXRjaFwiKTtcblxuICAgIHdyaXRlVW5pdFJ1bnRpbWVSZWNvcmQocy5iYXNlUGF0aCwgXCJ0YXNrXCIsIFwiVDAxXCIsIDEyMzQsIHtcbiAgICAgIHBoYXNlOiBcInJlY292ZXJlZFwiLFxuICAgICAgcmVjb3ZlcnlBdHRlbXB0czogMSxcbiAgICAgIGxhc3RQcm9ncmVzc0tpbmQ6IFwiaGFyZC1yZWNvdmVyeS1yZXRyeVwiLFxuICAgICAgbGFzdFByb2dyZXNzQXQ6IERhdGUubm93KCksXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgc2hvdWxkRGVmZXJVbml0RmFpbHNhZmVUaW1lb3V0KHJlYWRVbml0UnVudGltZVJlY29yZChzLmJhc2VQYXRoLCBcInRhc2tcIiwgXCJUMDFcIiksIHtcbiAgICAgICAgbm93TXM6IERhdGUubm93KCksXG4gICAgICAgIGN1cnJlbnRVbml0U3RhcnRlZEF0OiBzLmN1cnJlbnRVbml0LnN0YXJ0ZWRBdCxcbiAgICAgICAgZnJlc2hQcm9ncmVzc01zOiAzMF8wMDAsXG4gICAgICB9KSxcbiAgICAgIHRydWUsXG4gICAgICBcImZyZXNoIHJlY292ZXJ5IHJ1bnRpbWUgc2hvdWxkIGRlZmVyIHRoZSBmYWlsc2FmZVwiLFxuICAgICk7XG5cbiAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHdyaXRlVW5pdFJ1bnRpbWVSZWNvcmQocy5iYXNlUGF0aCwgXCJ0YXNrXCIsIFwiVDAxXCIsIDEyMzQsIHtcbiAgICAgICAgcGhhc2U6IFwicmVjb3ZlcmVkXCIsXG4gICAgICAgIHJlY292ZXJ5QXR0ZW1wdHM6IDEsXG4gICAgICAgIGxhc3RQcm9ncmVzc0tpbmQ6IFwiaGFyZC1yZWNvdmVyeS1yZXRyeVwiLFxuICAgICAgICBsYXN0UHJvZ3Jlc3NBdDogRGF0ZS5ub3coKSxcbiAgICAgIH0pO1xuICAgIH0sICgzMCAqIDYwICogMTAwMCkgKyAyOV8wMDApO1xuXG4gICAgbW9jay50aW1lcnMudGljaygoMzAgKiA2MCAqIDEwMDApICsgMzFfMDAwKTtcbiAgICBhd2FpdCBQcm9taXNlLnJlc29sdmUoKTtcblxuICAgIHJlc29sdmVBZ2VudEVuZChtYWtlRXZlbnQoKSk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzdWx0UHJvbWlzZTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjb21wbGV0ZWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgbW9jay50aW1lcnMucmVzZXQoKTtcbiAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQ3dkKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJzaG91bGREZWZlclVuaXRGYWlsc2FmZVRpbWVvdXQgcmVqZWN0cyBzdGFsZSBydW50aW1lIHByb2dyZXNzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHNob3VsZERlZmVyVW5pdEZhaWxzYWZlVGltZW91dCh7XG4gICAgICB2ZXJzaW9uOiAxLFxuICAgICAgdW5pdFR5cGU6IFwidGFza1wiLFxuICAgICAgdW5pdElkOiBcIlQwMVwiLFxuICAgICAgc3RhcnRlZEF0OiAxMjM0LFxuICAgICAgdXBkYXRlZEF0OiAxLFxuICAgICAgcGhhc2U6IFwicmVjb3ZlcmVkXCIsXG4gICAgICB3cmFwdXBXYXJuaW5nU2VudDogZmFsc2UsXG4gICAgICBjb250aW51ZUhlcmVGaXJlZDogZmFsc2UsXG4gICAgICB0aW1lb3V0QXQ6IDEsXG4gICAgICBsYXN0UHJvZ3Jlc3NBdDogMSxcbiAgICAgIHByb2dyZXNzQ291bnQ6IDEsXG4gICAgICBsYXN0UHJvZ3Jlc3NLaW5kOiBcImhhcmQtcmVjb3ZlcnktcmV0cnlcIixcbiAgICAgIHJlY292ZXJ5QXR0ZW1wdHM6IDEsXG4gICAgfSwge1xuICAgICAgbm93TXM6IDEyMF8wMDAsXG4gICAgICBjdXJyZW50VW5pdFN0YXJ0ZWRBdDogMTIzNCxcbiAgICAgIGZyZXNoUHJvZ3Jlc3NNczogMzBfMDAwLFxuICAgIH0pLFxuICAgIGZhbHNlLFxuICApO1xufSk7XG5cbnRlc3QoXCJzaG91bGREZWZlclVuaXRGYWlsc2FmZVRpbWVvdXQgcmVqZWN0cyBmdXR1cmUgcnVudGltZSBwcm9ncmVzc1wiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChcbiAgICBzaG91bGREZWZlclVuaXRGYWlsc2FmZVRpbWVvdXQoe1xuICAgICAgdmVyc2lvbjogMSxcbiAgICAgIHVuaXRUeXBlOiBcInRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJUMDFcIixcbiAgICAgIHN0YXJ0ZWRBdDogMTIzNCxcbiAgICAgIHVwZGF0ZWRBdDogMSxcbiAgICAgIHBoYXNlOiBcInJlY292ZXJlZFwiLFxuICAgICAgd3JhcHVwV2FybmluZ1NlbnQ6IGZhbHNlLFxuICAgICAgY29udGludWVIZXJlRmlyZWQ6IGZhbHNlLFxuICAgICAgdGltZW91dEF0OiAxLFxuICAgICAgbGFzdFByb2dyZXNzQXQ6IDE1MF8wMDAsXG4gICAgICBwcm9ncmVzc0NvdW50OiAxLFxuICAgICAgbGFzdFByb2dyZXNzS2luZDogXCJoYXJkLXJlY292ZXJ5LXJldHJ5XCIsXG4gICAgICByZWNvdmVyeUF0dGVtcHRzOiAxLFxuICAgIH0sIHtcbiAgICAgIG5vd01zOiAxMjBfMDAwLFxuICAgICAgY3VycmVudFVuaXRTdGFydGVkQXQ6IDEyMzQsXG4gICAgICBmcmVzaFByb2dyZXNzTXM6IDMwXzAwMCxcbiAgICB9KSxcbiAgICBmYWxzZSxcbiAgKTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZUFnZW50RW5kIGRyb3BzIGV2ZW50IHdoZW4gbm8gcHJvbWlzZSBpcyBwZW5kaW5nXCIsICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICAvLyBTaG91bGQgbm90IHRocm93IFx1MjAxNCBldmVudCBpcyBkcm9wcGVkIChsb2dnZWQgYXMgd2FybmluZylcbiAgYXNzZXJ0LmRvZXNOb3RUaHJvdygoKSA9PiB7XG4gICAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcbiAgfSk7XG59KTtcblxudGVzdChcImRvdWJsZSByZXNvbHZlQWdlbnRFbmQgb25seSByZXNvbHZlcyBvbmNlIChzZWNvbmQgaXMgZHJvcHBlZClcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKCk7XG4gIGNvbnN0IGV2ZW50MSA9IG1ha2VFdmVudChbeyBpZDogMSB9XSk7XG4gIGNvbnN0IGV2ZW50MiA9IG1ha2VFdmVudChbeyBpZDogMiB9XSk7XG5cbiAgY29uc3QgcmVzdWx0UHJvbWlzZSA9IHJ1blVuaXQoY3R4LCBwaSwgcywgXCJ0YXNrXCIsIFwiVDAxXCIsIFwicHJvbXB0XCIpO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cbiAgLy8gRmlyc3QgcmVzb2x2ZSBcdTIwMTQgc2hvdWxkIHdvcmtcbiAgcmVzb2x2ZUFnZW50RW5kKGV2ZW50MSk7XG5cbiAgLy8gU2Vjb25kIHJlc29sdmUgXHUyMDE0IHNob3VsZCBiZSBkcm9wcGVkIChubyBwZW5kaW5nIHJlc29sdmVyKVxuICBhc3NlcnQuZG9lc05vdFRocm93KCgpID0+IHtcbiAgICByZXNvbHZlQWdlbnRFbmQoZXZlbnQyKTtcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzdWx0UHJvbWlzZTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIFwiY29tcGxldGVkXCIpO1xuICAvLyBTaG91bGQgaGF2ZSB0aGUgZmlyc3QgZXZlbnQsIG5vdCB0aGUgc2Vjb25kXG4gIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LmV2ZW50LCBldmVudDEpO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0IHJldHVybnMgY2FuY2VsbGVkIHdoZW4gc2Vzc2lvbiBjcmVhdGlvbiBmYWlsc1wiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24oeyBuZXdTZXNzaW9uVGhyb3dzOiBcImNvbm5lY3Rpb24gcmVmdXNlZFwiIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blVuaXQoY3R4LCBwaSwgcywgXCJ0YXNrXCIsIFwiVDAxXCIsIFwicHJvbXB0XCIpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImNhbmNlbGxlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5ldmVudCwgdW5kZWZpbmVkKTtcbiAgLy8gc2VuZE1lc3NhZ2Ugc2hvdWxkIE5PVCBoYXZlIGJlZW4gY2FsbGVkXG4gIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0IGNsZWFycyBxdWV1ZWQgc3dpdGNoIGNhbmNlbGxhdGlvbiB3aGVuIHNlc3Npb24gY3JlYXRpb24gZmFpbHNcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKHtcbiAgICBuZXdTZXNzaW9uVGhyb3dzOiBcImNvbm5lY3Rpb24gcmVmdXNlZFwiLFxuICAgIG9uTmV3U2Vzc2lvblN0YXJ0OiAoKSA9PiB7XG4gICAgICByZXNvbHZlQWdlbnRFbmRDYW5jZWxsZWQoe1xuICAgICAgICBtZXNzYWdlOiBcIkNsYXVkZSBDb2RlIHByb2Nlc3MgYWJvcnRlZCBieSB1c2VyXCIsXG4gICAgICAgIGNhdGVnb3J5OiBcImFib3J0ZWRcIixcbiAgICAgICAgaXNUcmFuc2llbnQ6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVW5pdChjdHgsIHBpLCBzLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJwcm9tcHRcIik7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIFwiY2FuY2VsbGVkXCIpO1xuICBhc3NlcnQuZXF1YWwoX2NvbnN1bWVQZW5kaW5nU3dpdGNoQ2FuY2VsbGF0aW9uKCksIG51bGwpO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0IHJldHVybnMgY2FuY2VsbGVkIHdoZW4gc2Vzc2lvbiBjcmVhdGlvbiB0aW1lcyBvdXRcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAvLyBTZXNzaW9uIHJldHVybnMgY2FuY2VsbGVkOiB0cnVlIChzaW11bGF0ZXMgdGhlIHRpbWVvdXQgcmFjZSBvdXRjb21lKVxuICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKHsgbmV3U2Vzc2lvblJlc3VsdDogeyBjYW5jZWxsZWQ6IHRydWUgfSB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5Vbml0KGN0eCwgcGksIHMsIFwidGFza1wiLCBcIlQwMVwiLCBcInByb21wdFwiKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjYW5jZWxsZWRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZXZlbnQsIHVuZGVmaW5lZCk7XG4gIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDApO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0IGNvbnN1bWVzIGEgY2FuY2VsbGF0aW9uIHF1ZXVlZCBkdXJpbmcgc2Vzc2lvbiBzd2l0Y2ggYmVmb3JlIGRpc3BhdGNoXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgbGV0IGNhbmNlbGxhdGlvblF1ZXVlZCA9IGZhbHNlO1xuICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKHtcbiAgICBuZXdTZXNzaW9uRGVsYXlNczogMTAsXG4gICAgb25OZXdTZXNzaW9uU3RhcnQ6ICgpID0+IHtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBjYW5jZWxsYXRpb25RdWV1ZWQgPSAhcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkKHtcbiAgICAgICAgICBtZXNzYWdlOiBcIkNsYXVkZSBDb2RlIHByb2Nlc3MgYWJvcnRlZCBieSB1c2VyXCIsXG4gICAgICAgICAgY2F0ZWdvcnk6IFwiYWJvcnRlZFwiLFxuICAgICAgICAgIGlzVHJhbnNpZW50OiBmYWxzZSxcbiAgICAgICAgfSk7XG4gICAgICB9LCAwKTtcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5Vbml0KGN0eCwgcGksIHMsIFwicGxhbi1zbGljZVwiLCBcIk0wMDkvUzAxXCIsIFwicHJvbXB0XCIpO1xuXG4gIGFzc2VydC5lcXVhbChjYW5jZWxsYXRpb25RdWV1ZWQsIHRydWUpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjYW5jZWxsZWRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZXJyb3JDb250ZXh0Py5jYXRlZ29yeSwgXCJhYm9ydGVkXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9yQ29udGV4dD8ubWVzc2FnZSwgXCJDbGF1ZGUgQ29kZSBwcm9jZXNzIGFib3J0ZWQgYnkgdXNlclwiKTtcbiAgYXNzZXJ0LmVxdWFsKHBpLmNhbGxzLmxlbmd0aCwgMCwgXCJxdWV1ZWQgc3dpdGNoIGNhbmNlbGxhdGlvbiBtdXN0IHByZXZlbnQgcHJvbXB0IGRpc3BhdGNoXCIpO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0IGtlZXBzIHRoZSBzZXNzaW9uLXN3aXRjaCBndWFyZCBhY3Jvc3MgYSBsYXRlIG5ld1Nlc3Npb24gc2V0dGxlbWVudFwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG4gIG1vY2sudGltZXJzLmVuYWJsZSgpO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICAvLyBVc2UgZGVsYXlzIGxvbmdlciB0aGFuIE5FV19TRVNTSU9OX1RJTUVPVVRfTVMgKDEyMHMpIHNvIHRoZSB0aW1lb3V0IGZpcmVzXG4gICAgY29uc3QgZmlyc3RTZXNzaW9uID0gbWFrZU1vY2tTZXNzaW9uKHsgbmV3U2Vzc2lvbkRlbGF5TXM6IDIwMF8wMDAgfSk7XG4gICAgY29uc3Qgc2Vjb25kU2Vzc2lvbiA9IG1ha2VNb2NrU2Vzc2lvbih7IG5ld1Nlc3Npb25EZWxheU1zOiAyMDBfMDAwIH0pO1xuXG4gICAgY29uc3QgZmlyc3RSdW4gPSBydW5Vbml0KGN0eCwgcGksIGZpcnN0U2Vzc2lvbiwgXCJ0YXNrXCIsIFwiVDAxXCIsIFwicHJvbXB0XCIpO1xuXG4gICAgLy8gVGljayBwYXN0IHRoZSAxMjBzIHNlc3Npb24gdGltZW91dFxuICAgIG1vY2sudGltZXJzLnRpY2soMTIxXzAwMCk7XG4gICAgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKCk7XG5cbiAgICBjb25zdCBmaXJzdFJlc3VsdCA9IGF3YWl0IGZpcnN0UnVuO1xuICAgIGFzc2VydC5lcXVhbChmaXJzdFJlc3VsdC5zdGF0dXMsIFwiY2FuY2VsbGVkXCIpO1xuICAgIGFzc2VydC5lcXVhbChpc1Nlc3Npb25Td2l0Y2hJbkZsaWdodCgpLCB0cnVlLCBcImd1YXJkIHNob3VsZCByZW1haW4gc2V0IGFmdGVyIHRoZSB0aW1lZC1vdXQgc2Vzc2lvblwiKTtcblxuICAgIG1vY2sudGltZXJzLnRpY2soMSk7XG4gICAgY29uc3Qgc2Vjb25kUnVuID0gcnVuVW5pdChjdHgsIHBpLCBzZWNvbmRTZXNzaW9uLCBcInRhc2tcIiwgXCJUMDJcIiwgXCJwcm9tcHRcIik7XG5cbiAgICBtb2NrLnRpbWVycy50aWNrKDEwMF8wMDApO1xuICAgIGF3YWl0IFByb21pc2UucmVzb2x2ZSgpO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGlzU2Vzc2lvblN3aXRjaEluRmxpZ2h0KCksXG4gICAgICB0cnVlLFxuICAgICAgXCJsYXRlIHNldHRsZW1lbnQgZnJvbSB0aGUgZmlyc3Qgc2Vzc2lvbiBtdXN0IG5vdCBjbGVhciB0aGUgbmV3ZXIgc2Vzc2lvbiBndWFyZFwiLFxuICAgICk7XG5cbiAgICAvLyBUaWNrIHBhc3QgdGhlIHNlY29uZCBzZXNzaW9uJ3MgdGltZW91dCAoMTIxcyB0b3RhbCA+IDEyMHMgTkVXX1NFU1NJT05fVElNRU9VVF9NUylcbiAgICBtb2NrLnRpbWVycy50aWNrKDIxXzAwMSk7XG4gICAgYXdhaXQgUHJvbWlzZS5yZXNvbHZlKCk7XG5cbiAgICBjb25zdCBzZWNvbmRSZXN1bHQgPSBhd2FpdCBzZWNvbmRSdW47XG4gICAgYXNzZXJ0LmVxdWFsKHNlY29uZFJlc3VsdC5zdGF0dXMsIFwiY2FuY2VsbGVkXCIpO1xuXG4gICAgLy8gVGljayBwYXN0IHRoZSBzZWNvbmQgc2Vzc2lvbidzIGRlbGF5ZWQgcHJvbWlzZSAoMjAwcykgc28gLmZpbmFsbHkoKSBmaXJlc1xuICAgIG1vY2sudGltZXJzLnRpY2soODBfMDAwKTtcbiAgICBhd2FpdCBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNTZXNzaW9uU3dpdGNoSW5GbGlnaHQoKSwgZmFsc2UsIFwiZ3VhcmQgc2hvdWxkIGNsZWFyIGFmdGVyIHRoZSBuZXdlciBzZXNzaW9uIHNldHRsZXNcIik7XG4gIH0gZmluYWxseSB7XG4gICAgbW9jay50aW1lcnMucmVzZXQoKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJydW5Vbml0IHJldHVybnMgY2FuY2VsbGVkIHdoZW4gcy5hY3RpdmUgaXMgZmFsc2UgYmVmb3JlIHNlbmRNZXNzYWdlXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbigpO1xuICBzLmFjdGl2ZSA9IGZhbHNlO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blVuaXQoY3R4LCBwaSwgcywgXCJ0YXNrXCIsIFwiVDAxXCIsIFwicHJvbXB0XCIpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImNhbmNlbGxlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHBpLmNhbGxzLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdChcInJ1blVuaXQgb25seSBhcm1zIHJlc29sdmUgYWZ0ZXIgbmV3U2Vzc2lvbiBjb21wbGV0ZXNcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGxldCBzYXdTd2l0Y2hGbGFnID0gZmFsc2U7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24oe1xuICAgIG5ld1Nlc3Npb25EZWxheU1zOiAyMCxcbiAgICBvbk5ld1Nlc3Npb25TdGFydDogKCkgPT4ge1xuICAgICAgc2F3U3dpdGNoRmxhZyA9IGlzU2Vzc2lvblN3aXRjaEluRmxpZ2h0KCk7XG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0UHJvbWlzZSA9IHJ1blVuaXQoY3R4LCBwaSwgcywgXCJ0YXNrXCIsIFwiVDAxXCIsIFwicHJvbXB0XCIpO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDMwKSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHNhd1N3aXRjaEZsYWcsIHRydWUsIFwic2Vzc2lvbiBzd2l0Y2ggZ3VhcmQgc2hvdWxkIGJlIGFjdGl2ZSBkdXJpbmcgbmV3U2Vzc2lvblwiKTtcbiAgYXNzZXJ0LmVxdWFsKGlzU2Vzc2lvblN3aXRjaEluRmxpZ2h0KCksIGZhbHNlLCBcInNlc3Npb24gc3dpdGNoIGd1YXJkIHNob3VsZCBjbGVhciBhZnRlciBuZXdTZXNzaW9uIHNldHRsZXNcIik7XG5cbiAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXN1bHRQcm9taXNlO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjb21wbGV0ZWRcIik7XG4gIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDEpO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0IHJlLWFwcGxpZXMgdGhlIHNlbGVjdGVkIHVuaXQgbW9kZWwgYWZ0ZXIgbmV3U2Vzc2lvbiBiZWZvcmUgZGlzcGF0Y2hcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGNhbGxPcmRlcjogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIHBpLnNldE1vZGVsID0gYXN5bmMgKC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuICAgIGNhbGxPcmRlci5wdXNoKFwic2V0TW9kZWxcIik7XG4gICAgcGkuc2V0TW9kZWxDYWxscy5wdXNoKGFyZ3MpO1xuICAgIHJldHVybiB0cnVlO1xuICB9O1xuICBwaS5zZW5kTWVzc2FnZSA9ICguLi5hcmdzOiB1bmtub3duW10pID0+IHtcbiAgICBjYWxsT3JkZXIucHVzaChcInNlbmRNZXNzYWdlXCIpO1xuICAgIHBpLmNhbGxzLnB1c2goYXJncyk7XG4gIH07XG5cbiAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbigpO1xuICBzLmN1cnJlbnRVbml0TW9kZWwgPSB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtb3B1cy00LTZcIiB9O1xuXG4gIGNvbnN0IHJlc3VsdFByb21pc2UgPSBydW5Vbml0KGN0eCwgcGksIHMsIFwidGFza1wiLCBcIlQwMVwiLCBcInByb21wdFwiKTtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc3VsdFByb21pc2U7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImNvbXBsZXRlZFwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxsT3JkZXIsIFtcInNldE1vZGVsXCIsIFwic2VuZE1lc3NhZ2VcIl0pO1xuICBhc3NlcnQuZXF1YWwocGkuc2V0TW9kZWxDYWxscy5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHBpLnNldE1vZGVsQ2FsbHNbMF1bMF0sIHMuY3VycmVudFVuaXRNb2RlbCk7XG4gIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDEpO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0IGNhbmNlbHMgYmVmb3JlIGRpc3BhdGNoIHdoZW4gbW9kZWwgcmVzdG9yZSBmYWlscyBhZnRlciBuZXdTZXNzaW9uXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkubm90aWZ5ID0gKG1lc3NhZ2U6IHN0cmluZywgbGV2ZWw6IHN0cmluZykgPT4ge1xuICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1lc3NhZ2UsIGxldmVsIH0pO1xuICB9O1xuXG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBwaS5zZXRNb2RlbCA9IGFzeW5jICguLi5hcmdzOiB1bmtub3duW10pID0+IHtcbiAgICBwaS5zZXRNb2RlbENhbGxzLnB1c2goYXJncyk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9O1xuXG4gIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24oKTtcbiAgcy5jdXJyZW50VW5pdE1vZGVsID0geyBwcm92aWRlcjogXCJvcGVuYWktY29kZXhcIiwgaWQ6IFwiZ3B0LTUuNFwiIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVW5pdChjdHgsIHBpLCBzLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJwcm9tcHRcIik7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIFwiY2FuY2VsbGVkXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9yQ29udGV4dD8uY2F0ZWdvcnksIFwic2Vzc2lvbi1mYWlsZWRcIik7XG4gIGFzc2VydC5tYXRjaChcbiAgICByZXN1bHQuZXJyb3JDb250ZXh0Py5tZXNzYWdlID8/IFwiXCIsXG4gICAgL0ZhaWxlZCB0byByZXN0b3JlIGNvbmZpZ3VyZWQgbW9kZWwgb3BlbmFpLWNvZGV4XFwvZ3B0LTVcXC40IGFmdGVyIHNlc3Npb24gY3JlYXRpb24vLFxuICApO1xuICBhc3NlcnQuZXF1YWwocGkuc2V0TW9kZWxDYWxscy5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwocGkuY2FsbHMubGVuZ3RoLCAwLCBcInVuaXQgbXVzdCBub3QgZGlzcGF0Y2ggb24gdGhlIHNlc3Npb24gZGVmYXVsdCBtb2RlbFwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChub3RpZmljYXRpb25zLCBbXG4gICAge1xuICAgICAgbWVzc2FnZTogXCJGYWlsZWQgdG8gcmVzdG9yZSBjb25maWd1cmVkIG1vZGVsIG9wZW5haS1jb2RleC9ncHQtNS40IGFmdGVyIHNlc3Npb24gY3JlYXRpb24uIENhbmNlbGxpbmcgdW5pdCBiZWZvcmUgZGlzcGF0Y2guXCIsXG4gICAgICBsZXZlbDogXCJ3YXJuaW5nXCIsXG4gICAgfSxcbiAgXSk7XG59KTtcblxudGVzdChcInJ1blVuaXQgY2FuY2VscyBiZWZvcmUgZGlzcGF0Y2ggd2hlbiBwcm92aWRlciBpcyBub3QgcmVxdWVzdC1yZWFkeSAoIzQ1NTUpXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgubW9kZWwgPSB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtb3B1cy00LTZcIiB9O1xuICBjdHgubW9kZWxSZWdpc3RyeSA9IHtcbiAgICBpc1Byb3ZpZGVyUmVxdWVzdFJlYWR5OiAoX3Byb3ZpZGVyOiBzdHJpbmcpID0+IGZhbHNlLFxuICB9O1xuXG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVW5pdChjdHgsIHBpLCBzLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJwcm9tcHRcIik7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIFwiY2FuY2VsbGVkXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9yQ29udGV4dD8uY2F0ZWdvcnksIFwicHJvdmlkZXJcIik7XG4gIGFzc2VydC5tYXRjaChcbiAgICByZXN1bHQuZXJyb3JDb250ZXh0Py5tZXNzYWdlID8/IFwiXCIsXG4gICAgL1Byb3ZpZGVyIGFudGhyb3BpYyBpcyBub3QgcmVxdWVzdC1yZWFkeS8sXG4gICk7XG4gIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDAsIFwic2VuZE1lc3NhZ2UgbXVzdCBub3QgYmUgY2FsbGVkIHdoZW4gcHJvdmlkZXIgaXMgbm90IHJlYWR5XCIpO1xuICBhc3NlcnQuZXF1YWwoX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCgpLCBmYWxzZSwgXCJwcm92aWRlciBjYW5jZWxsYXRpb24gbXVzdCBjbGVhciB0aGUgcGVuZGluZyByZXNvbHZlclwiKTtcbn0pO1xuXG50ZXN0KFwicnVuVW5pdCBjYW5jZWxzIGJlZm9yZSBkaXNwYXRjaCB1c2luZyBjdXJyZW50VW5pdE1vZGVsIHByb3ZpZGVyIHdoZW4gc2V0ICgjNDU1NSlcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIC8vIGN0eC5tb2RlbCB1c2VzIFwib3BlbmFpXCIgd2hpY2ggSVMgcmVhZHkgXHUyMDE0IGlmIHRoZSBjb2RlIGlnbm9yZXMgY3VycmVudFVuaXRNb2RlbFxuICAvLyBhbmQgZmFsbHMgYmFjayB0byBjdHgubW9kZWwucHJvdmlkZXIsIHRoZSB1bml0IHdvdWxkIE5PVCBiZSBjYW5jZWxsZWQuIFRoZVxuICAvLyB0ZXN0IHRoZXJlZm9yZSBkaWZmZXJlbnRpYXRlczogb25seSBhIGJ1ZyAod3JvbmcgcHJvdmlkZXIgbG9va3VwKSB3b3VsZCBwYXNzLlxuICBjdHgubW9kZWwgPSB7IHByb3ZpZGVyOiBcIm9wZW5haVwiLCBpZDogXCJncHQtNG9cIiB9O1xuICAvLyBtb2RlbFJlZ2lzdHJ5IHNheXMgYW50aHJvcGljIGlzIG5vdCByZWFkeSBidXQgb3BlbmFpIGlzXG4gIGN0eC5tb2RlbFJlZ2lzdHJ5ID0ge1xuICAgIGlzUHJvdmlkZXJSZXF1ZXN0UmVhZHk6IChwcm92aWRlcjogc3RyaW5nKSA9PiBwcm92aWRlciA9PT0gXCJvcGVuYWlcIixcbiAgfTtcblxuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbigpO1xuICAvLyBjdXJyZW50VW5pdE1vZGVsIG92ZXJyaWRlcyB0aGUgcHJvdmlkZXIgdXNlZCBpbiB0aGUgcmVhZGluZXNzIGNoZWNrXG4gIHMuY3VycmVudFVuaXRNb2RlbCA9IHsgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsIGlkOiBcImNsYXVkZS1vcHVzLTQtNlwiIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVW5pdChjdHgsIHBpLCBzLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJwcm9tcHRcIik7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5zdGF0dXMsIFwiY2FuY2VsbGVkXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9yQ29udGV4dD8uY2F0ZWdvcnksIFwicHJvdmlkZXJcIik7XG4gIGFzc2VydC5tYXRjaChcbiAgICByZXN1bHQuZXJyb3JDb250ZXh0Py5tZXNzYWdlID8/IFwiXCIsXG4gICAgL1Byb3ZpZGVyIGFudGhyb3BpYyBpcyBub3QgcmVxdWVzdC1yZWFkeS8sXG4gICk7XG4gIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDAsIFwic2VuZE1lc3NhZ2UgbXVzdCBub3QgYmUgY2FsbGVkIFx1MjAxNCBhbnRocm9waWMgKGN1cnJlbnRVbml0TW9kZWwpIGlzIG5vdCByZWFkeVwiKTtcbn0pO1xuXG50ZXN0KFwicnVuVW5pdCBkb2VzIG5vdCBjYW5jZWwgYmVmb3JlIGRpc3BhdGNoIHdoZW4gcHJvdmlkZXIgaXMgcmVxdWVzdC1yZWFkeSAoIzQ1NTUpXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgubW9kZWwgPSB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtb3B1cy00LTZcIiB9O1xuICBjdHgubW9kZWxSZWdpc3RyeSA9IHtcbiAgICBpc1Byb3ZpZGVyUmVxdWVzdFJlYWR5OiAoX3Byb3ZpZGVyOiBzdHJpbmcpID0+IHRydWUsXG4gIH07XG5cbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24oKTtcblxuICBjb25zdCByZXN1bHRQcm9taXNlID0gcnVuVW5pdChjdHgsIHBpLCBzLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJwcm9tcHRcIik7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTApKTtcbiAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXN1bHRQcm9taXNlO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjb21wbGV0ZWRcIik7XG4gIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDEsIFwic2VuZE1lc3NhZ2UgbXVzdCBiZSBjYWxsZWQgd2hlbiBwcm92aWRlciBpcyByZWFkeVwiKTtcbn0pO1xuXG50ZXN0KFwicnVuVW5pdCBwcm9jZWVkcyB3aGVuIG1vZGVsUmVnaXN0cnkgaXMgYWJzZW50IChubyByZWFkaW5lc3MgY2hlY2sgYXZhaWxhYmxlKSAoIzQ1NTUpXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgubW9kZWwgPSB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtb3B1cy00LTZcIiB9O1xuICAvLyBObyBtb2RlbFJlZ2lzdHJ5IG9uIGN0eCBcdTIwMTQgcHJlLWNoZWNrIHNob3VsZCBiZSBza2lwcGVkXG5cbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24oKTtcblxuICBjb25zdCByZXN1bHRQcm9taXNlID0gcnVuVW5pdChjdHgsIHBpLCBzLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJwcm9tcHRcIik7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTApKTtcbiAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXN1bHRQcm9taXNlO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjb21wbGV0ZWRcIik7XG4gIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDEpO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0IHByb2NlZWRzIHdoZW4gaXNQcm92aWRlclJlcXVlc3RSZWFkeSB0aHJvd3MgKGRlZmVuc2l2ZSkgKCM0NTU1KVwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4Lm1vZGVsID0geyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLW9wdXMtNC02XCIgfTtcbiAgY3R4Lm1vZGVsUmVnaXN0cnkgPSB7XG4gICAgaXNQcm92aWRlclJlcXVlc3RSZWFkeTogKF9wcm92aWRlcjogc3RyaW5nKSA9PiB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyZWdpc3RyeSBlcnJvclwiKTtcbiAgICB9LFxuICB9O1xuXG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZU1vY2tTZXNzaW9uKCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVW5pdChjdHgsIHBpLCBzLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJwcm9tcHRcIik7XG5cbiAgLy8gV2hlbiB0aGUgcmVhZHlDaGVjayB0aHJvd3MsIHJlYWR5PWZhbHNlIFx1MjE5MiB1bml0IGNhbmNlbGxlZFxuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjYW5jZWxsZWRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZXJyb3JDb250ZXh0Py5jYXRlZ29yeSwgXCJwcm92aWRlclwiKTtcbiAgYXNzZXJ0LmVxdWFsKHBpLmNhbGxzLmxlbmd0aCwgMCk7XG59KTtcblxudGVzdChcImxhdGUtcmVzb2x2aW5nIG5ld1Nlc3Npb24oKSBhZnRlciB0aW1lb3V0IHJlY2VpdmVzIGFib3J0ZWQgc2lnbmFsIHNvIHRvb2wgcnVudGltZSBpcyBub3QgY29uZmlndXJlZCB3aXRoIHN0YWxlIHdvcmtzcGFjZSByb290ICgjMzczMSlcIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBXaGVuIG5ld1Nlc3Npb24oKSB0aW1lcyBvdXQgaW4gcnVuVW5pdCgpLCBhIGxhdGUgcmVzb2x1dGlvbiBtdXN0IG5vdFxuICAvLyBjb25maWd1cmUgdGhlIHRvb2wgcnVudGltZSBhZ2FpbnN0IGEgc3RhbGUgd29ya3NwYWNlIHJvb3QuXG4gIC8vXG4gIC8vIFRoZSBmaXg6IHJ1blVuaXQgY3JlYXRlcyBhbiBBYm9ydENvbnRyb2xsZXIsIGFib3J0cyBpdCBvbiB0aW1lb3V0LCBhbmQgcGFzc2VzXG4gIC8vIHRoZSBzaWduYWwgdG8gbmV3U2Vzc2lvbigpLiBBZ2VudFNlc3Npb24ubmV3U2Vzc2lvbigpIGNoZWNrcyB0aGUgc2lnbmFsIGFmdGVyXG4gIC8vIGl0cyBpbnRlcm5hbCBhd2FpdCB0aGlzLmFib3J0KCkgY29tcGxldGVzIGFuZCByZXR1cm5zIGVhcmx5IChkaXNjYXJkcykgaWYgYWJvcnRlZC5cbiAgLy9cbiAgLy8gVGhpcyB0ZXN0IHVzZXMgbW9jay50aW1lcnMgdG8gY29udHJvbCB0aW1pbmcgcHJlY2lzZWx5LlxuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuICBtb2NrLnRpbWVycy5lbmFibGUoKTtcblxuICB0cnkge1xuICAgIGxldCBhYm9ydGVkV2hlbkxhdGVTZXNzaW9uU2V0dGxlZDogYm9vbGVhbiB8IG51bGwgPSBudWxsO1xuXG4gICAgLy8gbmV3U2Vzc2lvbiBtb2NrIHNpbXVsYXRlcyBBZ2VudFNlc3Npb24ubmV3U2Vzc2lvbigpIGJlaGF2aW9yOlxuICAgIC8vIGFmdGVyIGFuIGludGVybmFsIGRlbGF5IChyZXByZXNlbnRpbmcgYXdhaXQgdGhpcy5hYm9ydCgpKSwgaXQgY2hlY2tzIHRoZVxuICAgIC8vIGFib3J0U2lnbmFsIGJlZm9yZSBzZWxlY3RpbmcgdGhlIHdvcmtzcGFjZSByb290IGFuZCBjYWxsaW5nIF9idWlsZFJ1bnRpbWUuXG4gICAgLy8gSWYgYWJvcnRlZCwgdGhlIHJlYWwgY29kZSBtdXN0IGRpc2NhcmQgdGhlIHNlc3Npb24uXG4gICAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbih7XG4gICAgICBuZXdTZXNzaW9uRGVsYXlNczogMjAwXzAwMCwgLy8gbG9uZ2VyIHRoYW4gTkVXX1NFU1NJT05fVElNRU9VVF9NUyAoMTIwcylcbiAgICAgIG9uU2lnbmFsQ2hlY2s6IChhYm9ydGVkKSA9PiB7XG4gICAgICAgIGFib3J0ZWRXaGVuTGF0ZVNlc3Npb25TZXR0bGVkID0gYWJvcnRlZDtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuXG4gICAgY29uc3QgcmVzdWx0UHJvbWlzZSA9IHJ1blVuaXQoY3R4LCBwaSwgcywgXCJ0YXNrXCIsIFwiVDAxXCIsIFwicHJvbXB0XCIpO1xuXG4gICAgLy8gVGljayBwYXN0IHRoZSAxMjBzIE5FV19TRVNTSU9OX1RJTUVPVVRfTVMgXHUyMDE0IHJ1blVuaXQgcmV0dXJucyBjYW5jZWxsZWRcbiAgICBtb2NrLnRpbWVycy50aWNrKDEyMV8wMDApO1xuICAgIGF3YWl0IFByb21pc2UucmVzb2x2ZSgpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzdWx0UHJvbWlzZTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjYW5jZWxsZWRcIiwgXCJydW5Vbml0IG11c3QgcmV0dXJuIGNhbmNlbGxlZCBvbiBzZXNzaW9uIHRpbWVvdXRcIik7XG5cbiAgICAvLyBUaWNrIHBhc3QgdGhlIGRlbGF5ZWQgbmV3U2Vzc2lvbiAoMjAwcyB0b3RhbCkgXHUyMDE0IHRoZSBsYXRlIG5ld1Nlc3Npb24gcmVzb2x2ZXNcbiAgICBtb2NrLnRpbWVycy50aWNrKDgwXzAwMCk7XG4gICAgLy8gRHJhaW4gbWljcm90YXNrIHF1ZXVlIHNvIHRoZSAuZmluYWxseSgpIGFuZCBzZXRUaW1lb3V0IGNhbGxiYWNrcyBydW5cbiAgICBhd2FpdCBQcm9taXNlLnJlc29sdmUoKTtcbiAgICBhd2FpdCBQcm9taXNlLnJlc29sdmUoKTtcblxuICAgIC8vIFRoZSBrZXkgYXNzZXJ0aW9uOiB3aGVuIHRoZSBsYXRlIG5ld1Nlc3Npb24oKSByZXNvbHZlcywgcnVuVW5pdCBtdXN0IGhhdmVcbiAgICAvLyBwYXNzZWQgYW4gYWJvcnRlZCBBYm9ydFNpZ25hbC4gV2l0aG91dCB0aGUgZml4LCBubyBzaWduYWwgaXMgcGFzc2VkIGFuZFxuICAgIC8vIGFib3J0ZWRXaGVuTGF0ZVNlc3Npb25TZXR0bGVkIHdvdWxkIGJlIGZhbHNlIChvciBudWxsLCBpZiBzaWduYWwgbm90IHBhc3NlZCBhdCBhbGwpLlxuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIGFib3J0ZWRXaGVuTGF0ZVNlc3Npb25TZXR0bGVkLFxuICAgICAgdHJ1ZSxcbiAgICAgIFwicnVuVW5pdCBtdXN0IHBhc3MgYW4gYWJvcnRlZCBBYm9ydFNpZ25hbCB0byBuZXdTZXNzaW9uKCkgd2hlbiBpdCByZXNvbHZlcyBhZnRlciB0aGUgc2Vzc2lvbi1jcmVhdGlvbiB0aW1lb3V0ICgjMzczMSkuIFwiICtcbiAgICAgIFwiV2l0aG91dCB0aGlzLCBBZ2VudFNlc3Npb24ubmV3U2Vzc2lvbigpIGNhbiByZWJ1aWxkIHRoZSB0b29sIHJ1bnRpbWUgd2l0aCBhIHN0YWxlIHdvcmtzcGFjZSByb290LlwiLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgbW9jay50aW1lcnMucmVzZXQoKTtcbiAgfVxufSk7XG5cbi8vIE5PVEU6IHRoZSBcIndoaWxlIGtleXdvcmRcIiwgXCJvbmUtc2hvdCBudWxsLWJlZm9yZS1yZXNvbHZlXCIsIGFuZFxuLy8gXCJzZWxlY3RBbmRBcHBseU1vZGVsIGJlZm9yZSB1cGRhdGVQcm9ncmVzc1dpZGdldFwiIHNvdXJjZS1ncmVwIHRlc3RzXG4vLyBwcmV2aW91c2x5IGhlcmUgd2VyZSBkZWxldGVkIGFzIHRhdXRvbG9naWNhbCAocmVhZEZpbGVTeW5jICsgc3Vic3RyaW5nXG4vLyBtYXRjaCkuIFRoZSBvbmUtc2hvdCBwYXR0ZXJuIGlzIGFscmVhZHkgY292ZXJlZCBiZWhhdmlvdXJhbGx5IGJ5IHRoZVxuLy8gXCJkb3VibGUgcmVzb2x2ZUFnZW50RW5kIG9ubHkgcmVzb2x2ZXMgb25jZVwiIHRlc3QgYWJvdmUsIHdoaWNoIGRyaXZlcyB0aGVcbi8vIHJlYWwgcmVzb2x2ZUFnZW50RW5kL3J1blVuaXQgZmxvdyBhbmQgYXNzZXJ0cyBvbiB0aGUgb2JzZXJ2YWJsZSBwcm9taXNlXG4vLyBvdXRjb21lLiBUaGUgcGhhc2VzLnRzIG9yZGVyaW5nIGNvbnRyYWN0IGlzIHRyYWNrZWQgdmlhIGEgZm9sbG93LXVwXG4vLyBpc3N1ZSBwcm9wb3NpbmcgZXh0cmFjdGlvbiBvZiBhIHB1cmUgYGRpc3BhdGNoT3JkZXJgIGhlbHBlciAocGVyIHRoZVxuLy8gIzQ4MzIvUFIgIzQ4NTkgcHJlY2VkZW50KSBzbyBpdCBjYW4gYmUgdGVzdGVkIGJlaGF2aW91cmFsbHkuXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBhdXRvTG9vcCB0ZXN0cyAoVDAyKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBCdWlsZCBhIG1vY2sgTG9vcERlcHMgdGhhdCB0cmFja3MgY2FsbCBvcmRlciBhbmQgYWxsb3dzIGNvbnRyb2xsaW5nXG4gKiBiZWhhdmlvciB2aWEgb3ZlcnJpZGVzLlxuICovXG5mdW5jdGlvbiBtYWtlTW9ja0RlcHMoXG4gIG92ZXJyaWRlcz86IFBhcnRpYWw8TG9vcERlcHM+LFxuKTogTG9vcERlcHMgJiB7IGNhbGxMb2c6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjYWxsTG9nOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGNvbnN0IGJhc2VEZXBzOiBMb29wRGVwcyA9IHtcbiAgICBsb2NrQmFzZTogKCkgPT4gXCIvdG1wL3Rlc3QtbG9ja1wiLFxuICAgIGJ1aWxkU25hcHNob3RPcHRzOiAoKSA9PiAoe30pLFxuICAgIHN0b3BBdXRvOiBhc3luYyAoKSA9PiB7XG4gICAgICBjYWxsTG9nLnB1c2goXCJzdG9wQXV0b1wiKTtcbiAgICB9LFxuICAgIHBhdXNlQXV0bzogYXN5bmMgKCkgPT4ge1xuICAgICAgY2FsbExvZy5wdXNoKFwicGF1c2VBdXRvXCIpO1xuICAgIH0sXG4gICAgY2xlYXJVbml0VGltZW91dDogKCkgPT4ge30sXG4gICAgdXBkYXRlUHJvZ3Jlc3NXaWRnZXQ6ICgpID0+IHt9LFxuICAgIHN5bmNDbXV4U2lkZWJhcjogKCkgPT4ge30sXG4gICAgbG9nQ211eEV2ZW50OiAoKSA9PiB7fSxcbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzOiAoKSA9PiB7XG4gICAgICBjYWxsTG9nLnB1c2goXCJpbnZhbGlkYXRlQWxsQ2FjaGVzXCIpO1xuICAgIH0sXG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IHtcbiAgICAgIGNhbGxMb2cucHVzaChcImRlcml2ZVN0YXRlXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZToge1xuICAgICAgICAgIGlkOiBcIk0wMDFcIixcbiAgICAgICAgICB0aXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICAgICAgICAgIHN0YXR1czogXCJhY3RpdmVcIixcbiAgICAgICAgfSxcbiAgICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlRlc3QgU2xpY2VcIiB9LFxuICAgICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgfSBhcyBhbnk7XG4gICAgfSxcbiAgICBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXM6ICgpID0+ICh7XG4gICAgICAvLyBUaGVzZSBsb29wLW1lY2hhbmljcyB0ZXN0cyBtb2NrIGV4ZWN1dGluZyBzdGF0ZSB3aXRob3V0IHBsYW4tdjIgYXJ0aWZhY3RzLlxuICAgICAgLy8gUGxhbi12MiBkZWZhdWx0LW9uIGNvdmVyYWdlIGxpdmVzIGluIHVvay1wbGFuLXYyLXdpcmluZy50ZXN0LnRzLlxuICAgICAgcHJlZmVyZW5jZXM6IHsgdW9rOiB7IHBsYW5fdjI6IHsgZW5hYmxlZDogZmFsc2UgfSB9IH0sXG4gICAgfSksXG4gICAgcHJlRGlzcGF0Y2hIZWFsdGhHYXRlOiBhc3luYyAoKSA9PiAoeyBwcm9jZWVkOiB0cnVlLCBmaXhlc0FwcGxpZWQ6IFtdIH0pLFxuICAgIGNoZWNrUmVzb3VyY2VzU3RhbGU6ICgpID0+IG51bGwsXG4gICAgdmFsaWRhdGVTZXNzaW9uTG9jazogKCkgPT4gKHsgdmFsaWQ6IHRydWUgfSBhcyBTZXNzaW9uTG9ja1N0YXR1cyksXG4gICAgdXBkYXRlU2Vzc2lvbkxvY2s6ICgpID0+IHtcbiAgICAgIGNhbGxMb2cucHVzaChcInVwZGF0ZVNlc3Npb25Mb2NrXCIpO1xuICAgIH0sXG4gICAgaGFuZGxlTG9zdFNlc3Npb25Mb2NrOiAoKSA9PiB7XG4gICAgICBjYWxsTG9nLnB1c2goXCJoYW5kbGVMb3N0U2Vzc2lvbkxvY2tcIik7XG4gICAgfSxcbiAgICBzZW5kRGVza3RvcE5vdGlmaWNhdGlvbjogKCkgPT4ge30sXG4gICAgc2V0QWN0aXZlTWlsZXN0b25lSWQ6ICgpID0+IHt9LFxuICAgIHBydW5lUXVldWVPcmRlcjogKCkgPT4ge30sXG4gICAgaXNJbkF1dG9Xb3JrdHJlZTogKCkgPT4gZmFsc2UsXG4gICAgc2hvdWxkVXNlV29ya3RyZWVJc29sYXRpb246ICgpID0+IGZhbHNlLFxuICAgIHRlYXJkb3duQXV0b1dvcmt0cmVlOiAoKSA9PiB7fSxcbiAgICBjcmVhdGVBdXRvV29ya3RyZWU6ICgpID0+IFwiL3RtcC93dFwiLFxuICAgIGNhcHR1cmVJbnRlZ3JhdGlvbkJyYW5jaDogKCkgPT4ge30sXG4gICAgZ2V0SXNvbGF0aW9uTW9kZTogKCkgPT4gXCJub25lXCIsXG4gICAgZ2V0Q3VycmVudEJyYW5jaDogKCkgPT4gXCJtYWluXCIsXG4gICAgYXV0b1dvcmt0cmVlQnJhbmNoOiAoKSA9PiBcImF1dG8vTTAwMVwiLFxuICAgIHJlc29sdmVNaWxlc3RvbmVGaWxlOiAoKSA9PiBudWxsLFxuICAgIHJlY29uY2lsZU1lcmdlU3RhdGU6ICgpID0+IFwiY2xlYW5cIixcbiAgICBwcmVmbGlnaHRDbGVhblJvb3Q6ICgpID0+ICh7IHN0YXNoUHVzaGVkOiBmYWxzZSwgc3VtbWFyeTogXCJcIiB9KSxcbiAgICBwb3N0ZmxpZ2h0UG9wU3Rhc2g6ICgpID0+ICh7XG4gICAgICByZXN0b3JlZDogdHJ1ZSxcbiAgICAgIG5lZWRzTWFudWFsUmVjb3Zlcnk6IGZhbHNlLFxuICAgICAgbWVzc2FnZTogXCJyZXN0b3JlZFwiLFxuICAgIH0pLFxuICAgIGdldExlZGdlcjogKCkgPT4gbnVsbCxcbiAgICBnZXRQcm9qZWN0VG90YWxzOiAoKSA9PiAoeyBjb3N0OiAwIH0pLFxuICAgIGZvcm1hdENvc3Q6IChjOiBudW1iZXIpID0+IGAkJHtjLnRvRml4ZWQoMil9YCxcbiAgICBnZXRCdWRnZXRBbGVydExldmVsOiAoKSA9PiAwLFxuICAgIGdldE5ld0J1ZGdldEFsZXJ0TGV2ZWw6ICgpID0+IDAsXG4gICAgZ2V0QnVkZ2V0RW5mb3JjZW1lbnRBY3Rpb246ICgpID0+IFwibm9uZVwiLFxuICAgIGdldE1hbmlmZXN0U3RhdHVzOiBhc3luYyAoKSA9PiBudWxsLFxuICAgIGNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0OiBhc3luYyAoKSA9PiBudWxsLFxuICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4ge1xuICAgICAgY2FsbExvZy5wdXNoKFwicmVzb2x2ZURpc3BhdGNoXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICAgIHByb21wdDogXCJkbyB0aGUgdGhpbmdcIixcbiAgICAgIH07XG4gICAgfSxcbiAgICBydW5QcmVEaXNwYXRjaEhvb2tzOiAoKSA9PiAoeyBmaXJlZEhvb2tzOiBbXSwgYWN0aW9uOiBcInByb2NlZWRcIiB9KSxcbiAgICBnZXRQcmlvclNsaWNlQ29tcGxldGlvbkJsb2NrZXI6ICgpID0+IG51bGwsXG4gICAgZ2V0TWFpbkJyYW5jaDogKCkgPT4gXCJtYWluXCIsXG4gICAgY2xvc2VvdXRVbml0OiBhc3luYyAoKSA9PiB7fSxcbiAgICByZWNvcmRPdXRjb21lOiAoKSA9PiB7fSxcbiAgICB3cml0ZUxvY2s6ICgpID0+IHt9LFxuICAgIGNhcHR1cmVBdmFpbGFibGVTa2lsbHM6ICgpID0+IHt9LFxuICAgIGVuc3VyZVByZWNvbmRpdGlvbnM6ICgpID0+IHt9LFxuICAgIHVwZGF0ZVNsaWNlUHJvZ3Jlc3NDYWNoZTogKCkgPT4ge30sXG4gICAgc2VsZWN0QW5kQXBwbHlNb2RlbDogYXN5bmMgKCkgPT4gKHsgcm91dGluZzogbnVsbCwgYXBwbGllZE1vZGVsOiBudWxsIH0pLFxuICAgIHN0YXJ0VW5pdFN1cGVydmlzaW9uOiAoKSA9PiB7fSxcbiAgICBnZXREZWVwRGlhZ25vc3RpYzogKCkgPT4gbnVsbCxcbiAgICBpc0RiQXZhaWxhYmxlOiAoKSA9PiBmYWxzZSxcbiAgICByZW9yZGVyRm9yQ2FjaGluZzogKHA6IHN0cmluZykgPT4gcCxcbiAgICBleGlzdHNTeW5jOiAocDogc3RyaW5nKSA9PiBwLmVuZHNXaXRoKFwiLmdpdFwiKSB8fCBwLmVuZHNXaXRoKFwicGFja2FnZS5qc29uXCIpLFxuICAgIHJlYWRGaWxlU3luYzogKCkgPT4gXCJcIixcbiAgICBhdG9taWNXcml0ZVN5bmM6ICgpID0+IHt9LFxuICAgIEdpdFNlcnZpY2VJbXBsOiBjbGFzcyB7fSBhcyBhbnksXG4gICAgbGlmZWN5Y2xlOiB7XG4gICAgICBlbnRlck1pbGVzdG9uZTogKCkgPT4gKHsgb2s6IHRydWUsIG1vZGU6IFwid29ya3RyZWVcIiwgcGF0aDogXCIvdG1wL3Byb2plY3RcIiB9KSxcbiAgICAgIGV4aXRNaWxlc3RvbmU6IChfbWlkOiBzdHJpbmcsIG9wdHM6IHsgbWVyZ2U6IGJvb2xlYW4gfSkgPT4gKHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIG1lcmdlZDogb3B0cy5tZXJnZSxcbiAgICAgICAgY29kZUZpbGVzQ2hhbmdlZDogZmFsc2UsXG4gICAgICB9KSxcbiAgICB9IGFzIGFueSxcbiAgICB3b3JrdHJlZVByb2plY3Rpb246IG5ldyBXb3JrdHJlZVN0YXRlUHJvamVjdGlvbigpLFxuICAgIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICBjYWxsTG9nLnB1c2goXCJwb3N0VW5pdFByZVZlcmlmaWNhdGlvblwiKTtcbiAgICAgIHJldHVybiBcImNvbnRpbnVlXCIgYXMgY29uc3Q7XG4gICAgfSxcbiAgICBydW5Qb3N0VW5pdFZlcmlmaWNhdGlvbjogYXN5bmMgKCkgPT4ge1xuICAgICAgY2FsbExvZy5wdXNoKFwicnVuUG9zdFVuaXRWZXJpZmljYXRpb25cIik7XG4gICAgICByZXR1cm4gXCJjb250aW51ZVwiIGFzIGNvbnN0O1xuICAgIH0sXG4gICAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICBjYWxsTG9nLnB1c2goXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb25cIik7XG4gICAgICByZXR1cm4gXCJjb250aW51ZVwiIGFzIGNvbnN0O1xuICAgIH0sXG4gICAgZ2V0U2Vzc2lvbkZpbGU6ICgpID0+IFwiL3RtcC9zZXNzaW9uLmpzb25cIixcbiAgICByZWJ1aWxkU3RhdGU6IGFzeW5jICgpID0+IHt9LFxuICAgIHJlc29sdmVNb2RlbElkOiAoaWQ6IHN0cmluZywgbW9kZWxzOiBhbnlbXSkgPT4gbW9kZWxzLmZpbmQoKG06IGFueSkgPT4gbS5pZCA9PT0gaWQpLFxuICAgIGVtaXRKb3VybmFsRXZlbnQ6ICgpID0+IHt9LFxuICB9O1xuXG4gIGNvbnN0IG1lcmdlZCA9IHsgLi4uYmFzZURlcHMsIC4uLm92ZXJyaWRlcywgY2FsbExvZyB9O1xuICByZXR1cm4gbWVyZ2VkO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgbW9jayBzZXNzaW9uIGZvciBhdXRvTG9vcCB0ZXN0aW5nIFx1MjAxNCBuZWVkcyBtb3JlIGZpZWxkcyB0aGFuIHRoZVxuICogcnVuVW5pdCBtb2NrIChkaXNwYXRjaCBjb3VudGVycywgbWlsZXN0b25lIHN0YXRlLCBldGMuKS5cbiAqL1xuZnVuY3Rpb24gbWFrZUxvb3BTZXNzaW9uKG92ZXJyaWRlcz86IFBhcnRpYWw8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+KSB7XG4gIHJldHVybiB7XG4gICAgYWN0aXZlOiB0cnVlLFxuICAgIHZlcmJvc2U6IGZhbHNlLFxuICAgIHN0ZXBNb2RlOiBmYWxzZSxcbiAgICBwYXVzZWQ6IGZhbHNlLFxuICAgIGJhc2VQYXRoOiBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1hdXRvLWxvb3AtXCIpKSxcbiAgICBvcmlnaW5hbEJhc2VQYXRoOiBcIlwiLFxuICAgIGN1cnJlbnRNaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgY3VycmVudFVuaXQ6IG51bGwsXG4gICAgY3VycmVudFVuaXRSb3V0aW5nOiBudWxsLFxuICAgIGNvbXBsZXRlZFVuaXRzOiBbXSxcbiAgICByZXNvdXJjZVZlcnNpb25PblN0YXJ0OiBudWxsLFxuICAgIGxhc3RQcm9tcHRDaGFyQ291bnQ6IHVuZGVmaW5lZCxcbiAgICBsYXN0QmFzZWxpbmVDaGFyQ291bnQ6IHVuZGVmaW5lZCxcbiAgICBsYXN0QnVkZ2V0QWxlcnRMZXZlbDogMCxcbiAgICBwZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnk6IG51bGwsXG4gICAgcGVuZGluZ0NyYXNoUmVjb3Zlcnk6IG51bGwsXG4gICAgdmVyaWZpY2F0aW9uUmV0cnlGYWlsdXJlSGFzaGVzOiBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpLFxuICAgIHBlbmRpbmdRdWlja1Rhc2tzOiBbXSxcbiAgICBzaWRlY2FyUXVldWU6IFtdLFxuICAgIGF1dG9Nb2RlU3RhcnRNb2RlbDogbnVsbCxcbiAgICB1bml0RGlzcGF0Y2hDb3VudDogbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKSxcbiAgICB1bml0TGlmZXRpbWVEaXNwYXRjaGVzOiBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpLFxuICAgIHVuaXRSZWNvdmVyeUNvdW50OiBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpLFxuICAgIHZlcmlmaWNhdGlvblJldHJ5Q291bnQ6IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCksXG4gICAgZ2l0U2VydmljZTogbnVsbCxcbiAgICBsYXN0UmVxdWVzdFRpbWVzdGFtcDogMCxcbiAgICBhdXRvU3RhcnRUaW1lOiBEYXRlLm5vdygpLFxuICAgIGNtZEN0eDoge1xuICAgICAgbmV3U2Vzc2lvbjogKCkgPT4gUHJvbWlzZS5yZXNvbHZlKHsgY2FuY2VsbGVkOiBmYWxzZSB9KSxcbiAgICAgIGdldENvbnRleHRVc2FnZTogKCkgPT4gKHsgcGVyY2VudDogMTAsIHRva2VuczogMTAwMCwgbGltaXQ6IDEwMDAwIH0pLFxuICAgIH0sXG4gICAgY2xlYXJUaW1lcnM6ICgpID0+IHt9LFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfSBhcyBhbnk7XG59XG5cbnRlc3QoXCJhdXRvTG9vcCBleGl0cyB3aGVuIHMuYWN0aXZlIGlzIHNldCB0byBmYWxzZVwiLCBhc3luYyAodCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGN0eC51aS5zZXRTdGF0dXMgPSAoKSA9PiB7fTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oeyBhY3RpdmU6IGZhbHNlIH0pO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoKTtcbiAgYXdhaXQgYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgLy8gTG9vcCBib2R5IHNob3VsZCBub3QgaGF2ZSBleGVjdXRlZCAoZGVyaXZlU3RhdGUgbmV2ZXIgY2FsbGVkKVxuICBhc3NlcnQub2soXG4gICAgIWRlcHMuY2FsbExvZy5pbmNsdWRlcyhcImRlcml2ZVN0YXRlXCIpLFxuICAgIFwibG9vcCBzaG91bGQgbm90IGhhdmUgaXRlcmF0ZWRcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiYXV0b0xvb3AgZXhpdHMgb24gdGVybWluYWwgY29tcGxldGUgc3RhdGVcIiwgYXN5bmMgKHQpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG5cbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwiZGVyaXZlU3RhdGVcIik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwaGFzZTogXCJjb21wbGV0ZVwiLFxuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgfSBhcyBhbnk7XG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgYXNzZXJ0Lm9rKGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcImRlcml2ZVN0YXRlXCIpLCBcInNob3VsZCBoYXZlIGRlcml2ZWQgc3RhdGVcIik7XG4gIGFzc2VydC5vayhcbiAgICBkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJzdG9wQXV0b1wiKSxcbiAgICBcInNob3VsZCBoYXZlIGNhbGxlZCBzdG9wQXV0byBmb3IgY29tcGxldGUgc3RhdGVcIixcbiAgKTtcbiAgLy8gU2hvdWxkIE5PVCBoYXZlIGRpc3BhdGNoZWQgYSB1bml0XG4gIGFzc2VydC5vayhcbiAgICAhZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicmVzb2x2ZURpc3BhdGNoXCIpLFxuICAgIFwic2hvdWxkIG5vdCBkaXNwYXRjaCB3aGVuIGNvbXBsZXRlXCIsXG4gICk7XG59KTtcblxudGVzdChcImF1dG9Mb29wIHN0b3BzIGJlZm9yZSBzdWNjZXNzIG5vdGlmaWNhdGlvbiB3aGVuIHBvc3RmbGlnaHQgc3Rhc2ggcmVzdG9yZSBuZWVkcyByZWNvdmVyeVwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3Qgbm90aWZpY2F0aW9uczogQXJyYXk8eyBtc2c6IHN0cmluZzsgbGV2ZWw6IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGN0eC51aS5ub3RpZnkgPSAobXNnOiBzdHJpbmcsIGxldmVsOiBzdHJpbmcpID0+IHtcbiAgICBub3RpZmljYXRpb25zLnB1c2goeyBtc2csIGxldmVsIH0pO1xuICB9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbigpO1xuICBsZXQgc3RvcFJlYXNvbiA9IFwiXCI7XG5cbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwiZGVyaXZlU3RhdGVcIik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwaGFzZTogXCJjb21wbGV0ZVwiLFxuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgfSBhcyBhbnk7XG4gICAgfSxcbiAgICBwcmVmbGlnaHRDbGVhblJvb3Q6ICgpID0+ICh7XG4gICAgICBzdGFzaFB1c2hlZDogdHJ1ZSxcbiAgICAgIHN0YXNoTWFya2VyOiBcImdzZC1wcmVmbGlnaHQtc3Rhc2g6TTAwMTp0ZXN0XCIsXG4gICAgICBzdW1tYXJ5OiBcInN0YXNoZWRcIixcbiAgICB9KSxcbiAgICBwb3N0ZmxpZ2h0UG9wU3Rhc2g6ICgpID0+ICh7XG4gICAgICByZXN0b3JlZDogZmFsc2UsXG4gICAgICBuZWVkc01hbnVhbFJlY292ZXJ5OiB0cnVlLFxuICAgICAgbWVzc2FnZTogXCJnaXQgc3Rhc2ggcG9wIHN0YXNoQHswfSBmYWlsZWQgYWZ0ZXIgbWVyZ2Ugb2YgbWlsZXN0b25lIE0wMDFcIixcbiAgICAgIHN0YXNoUmVmOiBcInN0YXNoQHswfVwiLFxuICAgIH0pLFxuICAgIHNlbmREZXNrdG9wTm90aWZpY2F0aW9uOiAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcInNlbmREZXNrdG9wTm90aWZpY2F0aW9uXCIpO1xuICAgIH0sXG4gICAgbG9nQ211eEV2ZW50OiAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcImxvZ0NtdXhFdmVudFwiKTtcbiAgICB9LFxuICAgIHN0b3BBdXRvOiBhc3luYyAoX2N0eCwgX3BpLCByZWFzb24pID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwic3RvcEF1dG9cIik7XG4gICAgICBzdG9wUmVhc29uID0gcmVhc29uID8/IFwiXCI7XG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgYXNzZXJ0LmVxdWFsKHN0b3BSZWFzb24sIFwiUG9zdC1tZXJnZSBzdGFzaCByZXN0b3JlIGZhaWxlZCBmb3IgbWlsZXN0b25lIE0wMDFcIik7XG4gIGFzc2VydC5vayhcbiAgICBub3RpZmljYXRpb25zLnNvbWUoXG4gICAgICAobikgPT4gbi5sZXZlbCA9PT0gXCJlcnJvclwiICYmIG4ubXNnLmluY2x1ZGVzKFwiUG9zdC1tZXJnZSBzdGFzaCByZXN0b3JlIGZhaWxlZCBmb3IgbWlsZXN0b25lIE0wMDFcIiksXG4gICAgKSxcbiAgICBcImZhaWxlZCBwb3N0ZmxpZ2h0IHJlc3RvcmUgbXVzdCBiZSBzdXJmYWNlZCBhcyBhbiBlcnJvclwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgIWRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInNlbmREZXNrdG9wTm90aWZpY2F0aW9uXCIpLFxuICAgIFwibXVzdCBub3QgZW1pdCBtaWxlc3RvbmUgc3VjY2VzcyBkZXNrdG9wIG5vdGlmaWNhdGlvbiBhZnRlciBzdGFzaCByZXN0b3JlIGZhaWx1cmVcIixcbiAgKTtcbiAgYXNzZXJ0Lm9rKFxuICAgICFkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJsb2dDbXV4RXZlbnRcIiksXG4gICAgXCJtdXN0IG5vdCBlbWl0IG1pbGVzdG9uZSBzdWNjZXNzIGNtdXggZXZlbnQgYWZ0ZXIgc3Rhc2ggcmVzdG9yZSBmYWlsdXJlXCIsXG4gICk7XG59KTtcblxudGVzdChcImF1dG9Mb29wIG1hcmtzIHRyYW5zaXRpb24gbWVyZ2UgY29tcGxldGUgYmVmb3JlIHBvc3RmbGlnaHQgcmVjb3Zlcnkgc3RvcFwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjdHgudWkubm90aWZ5ID0gKCkgPT4ge307XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG4gIGxldCBtZXJnZUNhbGxzID0gMDtcbiAgbGV0IHN0b3BSZWFzb24gPSBcIlwiO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcImRlcml2ZVN0YXRlXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAyXCIsIHRpdGxlOiBcIk5leHRcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgICByZWdpc3RyeTogW1xuICAgICAgICAgIHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJEb25lXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiIH0sXG4gICAgICAgICAgeyBpZDogXCJNMDAyXCIsIHRpdGxlOiBcIk5leHRcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIF0sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIH0gYXMgYW55O1xuICAgIH0sXG4gICAgcHJlZmxpZ2h0Q2xlYW5Sb290OiAoKSA9PiAoe1xuICAgICAgc3Rhc2hQdXNoZWQ6IHRydWUsXG4gICAgICBzdGFzaE1hcmtlcjogXCJnc2QtcHJlZmxpZ2h0LXN0YXNoOk0wMDE6dGVzdFwiLFxuICAgICAgc3VtbWFyeTogXCJzdGFzaGVkXCIsXG4gICAgfSksXG4gICAgcG9zdGZsaWdodFBvcFN0YXNoOiAoKSA9PiAoe1xuICAgICAgcmVzdG9yZWQ6IGZhbHNlLFxuICAgICAgbmVlZHNNYW51YWxSZWNvdmVyeTogdHJ1ZSxcbiAgICAgIG1lc3NhZ2U6IFwiZ2l0IHN0YXNoIHBvcCBzdGFzaEB7MH0gZmFpbGVkIGFmdGVyIG1lcmdlIG9mIG1pbGVzdG9uZSBNMDAxXCIsXG4gICAgICBzdGFzaFJlZjogXCJzdGFzaEB7MH1cIixcbiAgICB9KSxcbiAgICBsaWZlY3ljbGU6IHtcbiAgICAgIGVudGVyTWlsZXN0b25lOiAoKSA9PiB7XG4gICAgICAgIGFzc2VydC5mYWlsKFwibXVzdCBub3QgZW50ZXIgdGhlIG5leHQgbWlsZXN0b25lIGFmdGVyIHBvc3RmbGlnaHQgcmVjb3ZlcnkgZmFpbHNcIik7XG4gICAgICB9LFxuICAgICAgZXhpdE1pbGVzdG9uZTogKF9taWQ6IHN0cmluZywgb3B0czogeyBtZXJnZTogYm9vbGVhbiB9KSA9PiB7XG4gICAgICAgIGlmIChvcHRzLm1lcmdlKSBtZXJnZUNhbGxzICs9IDE7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtZXJnZWQ6IG9wdHMubWVyZ2UsIGNvZGVGaWxlc0NoYW5nZWQ6IGZhbHNlIH07XG4gICAgICB9LFxuICAgIH0gYXMgYW55LFxuICAgIHN0b3BBdXRvOiBhc3luYyAoX2N0eCwgX3BpLCByZWFzb24pID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwic3RvcEF1dG9cIik7XG4gICAgICBzdG9wUmVhc29uID0gcmVhc29uID8/IFwiXCI7XG4gICAgICBpZiAoIXMubWlsZXN0b25lTWVyZ2VkSW5QaGFzZXMpIHtcbiAgICAgICAgZGVwcy5saWZlY3ljbGUuZXhpdE1pbGVzdG9uZShcbiAgICAgICAgICBcIk0wMDFcIixcbiAgICAgICAgICB7IG1lcmdlOiB0cnVlIH0sXG4gICAgICAgICAgeyBub3RpZnk6IGN0eC51aS5ub3RpZnkuYmluZChjdHgudWkpIH0sXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgYXNzZXJ0LmVxdWFsKHN0b3BSZWFzb24sIFwiUG9zdC1tZXJnZSBzdGFzaCByZXN0b3JlIGZhaWxlZCBmb3IgbWlsZXN0b25lIE0wMDFcIik7XG4gIGFzc2VydC5lcXVhbChzLm1pbGVzdG9uZU1lcmdlZEluUGhhc2VzLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKG1lcmdlQ2FsbHMsIDEsIFwicG9zdGZsaWdodCByZWNvdmVyeSBzdG9wIG11c3Qgbm90IHJlLXJ1biBhbiBhbHJlYWR5IGNvbXBsZXRlZCB0cmFuc2l0aW9uIG1lcmdlXCIpO1xufSk7XG5cbnRlc3QoXCJhdXRvTG9vcCBwYXVzZXMgd2hlbiBwcm92aWRlciByZWFkaW5lc3MgY2FuY2VscyBiZWZvcmUgZGlzcGF0Y2hcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IG5vdGlmaWNhdGlvbnM6IEFycmF5PHsgbWVzc2FnZTogc3RyaW5nOyBsZXZlbD86IHN0cmluZyB9PiA9IFtdO1xuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGN0eC51aS5ub3RpZnkgPSAobWVzc2FnZTogc3RyaW5nLCBsZXZlbD86IHN0cmluZykgPT4ge1xuICAgIG5vdGlmaWNhdGlvbnMucHVzaCh7IG1lc3NhZ2UsIGxldmVsIH0pO1xuICB9O1xuICBjdHgubW9kZWwgPSB7IHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLCBpZDogXCJjbGF1ZGUtb3B1cy00LTZcIiB9O1xuICBjdHgubW9kZWxSZWdpc3RyeSA9IHtcbiAgICBnZXRQcm92aWRlckF1dGhNb2RlOiAoKSA9PiBcImFwaS1rZXlcIixcbiAgICBpc1Byb3ZpZGVyUmVxdWVzdFJlYWR5OiAoKSA9PiBmYWxzZSxcbiAgfTtcblxuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbigpO1xuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICBzZWxlY3RBbmRBcHBseU1vZGVsOiBhc3luYyAoKSA9PiAoe1xuICAgICAgcm91dGluZzogbnVsbCxcbiAgICAgIGFwcGxpZWRNb2RlbDogeyBwcm92aWRlcjogXCJhbnRocm9waWNcIiwgaWQ6IFwiY2xhdWRlLW9wdXMtNC02XCIgfSxcbiAgICB9KSxcbiAgfSk7XG5cbiAgYXdhaXQgYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgYXNzZXJ0LmVxdWFsKHBpLmNhbGxzLmxlbmd0aCwgMCwgXCJwcm92aWRlciByZWFkaW5lc3MgY2FuY2VsbGF0aW9uIG11c3Qgbm90IGRpc3BhdGNoIGEgbWVzc2FnZVwiKTtcbiAgYXNzZXJ0Lm9rKGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInBhdXNlQXV0b1wiKSwgXCJwcm92aWRlciByZWFkaW5lc3MgY2FuY2VsbGF0aW9uIHNob3VsZCBwYXVzZSBhdXRvLW1vZGVcIik7XG4gIGFzc2VydC5vayghZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwic3RvcEF1dG9cIiksIFwicHJvdmlkZXIgcmVhZGluZXNzIGNhbmNlbGxhdGlvbiBzaG91bGQgbm90IGhhcmQtc3RvcCBhdXRvLW1vZGVcIik7XG4gIGFzc2VydC5vayhcbiAgICAhZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicG9zdFVuaXRQcmVWZXJpZmljYXRpb25cIiksXG4gICAgXCJwb3N0LXVuaXQgdmVyaWZpY2F0aW9uIG11c3Qgbm90IHJ1biBhZnRlciBwcmUtZGlzcGF0Y2ggcHJvdmlkZXIgY2FuY2VsbGF0aW9uXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBub3RpZmljYXRpb25zLnNvbWUobiA9PiAvUHJvdmlkZXIgYW50aHJvcGljIGlzIG5vdCByZXF1ZXN0LXJlYWR5Ly50ZXN0KG4ubWVzc2FnZSkpLFxuICAgIFwicHJvdmlkZXIgcGF1c2Ugc2hvdWxkIG5vdGlmeSB3aXRoIHRoZSByZWFkaW5lc3MgZmFpbHVyZVwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJhdXRvTG9vcCBwYXNzZXMgc3RydWN0dXJlZCBzZXNzaW9uLWxvY2sgZmFpbHVyZSBkZXRhaWxzIHRvIHRoZSBoYW5kbGVyXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG4gIGxldCBvYnNlcnZlZExvY2tTdGF0dXM6IFNlc3Npb25Mb2NrU3RhdHVzIHwgdW5kZWZpbmVkO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIHZhbGlkYXRlU2Vzc2lvbkxvY2s6ICgpID0+XG4gICAgICAoe1xuICAgICAgICB2YWxpZDogZmFsc2UsXG4gICAgICAgIGZhaWx1cmVSZWFzb246IFwiY29tcHJvbWlzZWRcIixcbiAgICAgICAgZXhwZWN0ZWRQaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgfSkgYXMgU2Vzc2lvbkxvY2tTdGF0dXMsXG4gICAgaGFuZGxlTG9zdFNlc3Npb25Mb2NrOiAoX2N0eCwgbG9ja1N0YXR1cykgPT4ge1xuICAgICAgb2JzZXJ2ZWRMb2NrU3RhdHVzID0gbG9ja1N0YXR1cztcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwiaGFuZGxlTG9zdFNlc3Npb25Mb2NrXCIpO1xuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwob2JzZXJ2ZWRMb2NrU3RhdHVzLCB7XG4gICAgdmFsaWQ6IGZhbHNlLFxuICAgIGZhaWx1cmVSZWFzb246IFwiY29tcHJvbWlzZWRcIixcbiAgICBleHBlY3RlZFBpZDogcHJvY2Vzcy5waWQsXG4gIH0pO1xuICBhc3NlcnQub2soXG4gICAgIWRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInJlc29sdmVEaXNwYXRjaFwiKSxcbiAgICBcInNob3VsZCBzdG9wIGJlZm9yZSBkaXNwYXRjaCBhZnRlciBsb2NrIHZhbGlkYXRpb24gZmFpbHNcIixcbiAgKTtcbn0pO1xuXG4vLyBSZWdyZXNzaW9uIGZvciAjNTMwODogdGhlIGl0ZXJhdGlvbiBwcmVsdWRlIG11c3QgZGVxdWV1ZSBzaWRlY2FyIGl0ZW1zXG4vLyAocG9wcGluZyB0aGUgcXVldWUgYW5kIGVtaXR0aW5nIHRoZSBgc2lkZWNhci1kZXF1ZXVlYCBqb3VybmFsIGV2ZW50KSBCRUZPUkVcbi8vIHZhbGlkYXRlU2Vzc2lvbkxvY2sgKyBicmVhay1vbi1pbnZhbGlkLiBJbnZlcnRpbmcgdGhhdCBvcmRlciBzaWxlbnRseSBkcm9wc1xuLy8gcXVldWVkIHNpZGVjYXIgd29yayBvbiBsb2NrLWxvc3MuIENvdmVycyBmaXJzdC1pdGVyYXRpb24gYW5kIG1pZC1zZXNzaW9uLlxudGVzdChcImF1dG9Mb29wIGRlcXVldWVzIHNpZGVjYXIgaXRlbSBiZWZvcmUgc2Vzc2lvbi1sb2NrIGJyZWFrIChmaXJzdCBpdGVyYXRpb24sICM1MzA4KVwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbigpO1xuICBzLnNpZGVjYXJRdWV1ZS5wdXNoKHtcbiAgICBraW5kOiBcImhvb2tcIiBhcyBjb25zdCxcbiAgICB1bml0VHlwZTogXCJob29rL3Jldmlld1wiLFxuICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDEvcmV2aWV3XCIsXG4gICAgcHJvbXB0OiBcInJldmlldyB0aGUgY29kZVwiLFxuICB9KTtcblxuICBjb25zdCBqb3VybmFsRXZlbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICB2YWxpZGF0ZVNlc3Npb25Mb2NrOiAoKSA9PlxuICAgICAgKHtcbiAgICAgICAgdmFsaWQ6IGZhbHNlLFxuICAgICAgICBmYWlsdXJlUmVhc29uOiBcImNvbXByb21pc2VkXCIsXG4gICAgICAgIGV4cGVjdGVkUGlkOiBwcm9jZXNzLnBpZCxcbiAgICAgIH0pIGFzIFNlc3Npb25Mb2NrU3RhdHVzLFxuICAgIGhhbmRsZUxvc3RTZXNzaW9uTG9jazogKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJoYW5kbGVMb3N0U2Vzc2lvbkxvY2tcIik7XG4gICAgfSxcbiAgICBlbWl0Sm91cm5hbEV2ZW50OiAoZW50cnkpID0+IHtcbiAgICAgIGpvdXJuYWxFdmVudHMucHVzaChlbnRyeS5ldmVudFR5cGUpO1xuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gIGFzc2VydC5lcXVhbChcbiAgICBzLnNpZGVjYXJRdWV1ZS5sZW5ndGgsXG4gICAgMCxcbiAgICBcInNpZGVjYXIgaXRlbSBtdXN0IGJlIHBvcHBlZCBvbiBsb2NrLWxvc3MgaXRlcmF0aW9uIChwcmUtIzUzMDggb3JkZXJpbmcpXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBqb3VybmFsRXZlbnRzLmluY2x1ZGVzKFwic2lkZWNhci1kZXF1ZXVlXCIpLFxuICAgIFwic2lkZWNhci1kZXF1ZXVlIGpvdXJuYWwgZXZlbnQgbXVzdCBiZSBlbWl0dGVkIGJlZm9yZSBzZXNzaW9uLWxvY2sgYnJlYWtcIixcbiAgKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcImhhbmRsZUxvc3RTZXNzaW9uTG9ja1wiKSxcbiAgICBcInNlc3Npb24gbG9jayBoYW5kbGVyIG11c3Qgc3RpbGwgZmlyZSBhZnRlciBzaWRlY2FyIGRlcXVldWVcIixcbiAgKTtcbiAgYXNzZXJ0Lm9rKCFkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJkZXJpdmVTdGF0ZVwiKSwgXCJsb2NrIGxvc3Mgc2hvdWxkIHN0b3AgYmVmb3JlIGRlcml2aW5nIHN0YXRlXCIpO1xufSk7XG5cbnRlc3QoXCJhdXRvTG9vcCBkZXF1ZXVlcyBzaWRlY2FyIGl0ZW0gYmVmb3JlIHNlc3Npb24tbG9jayBicmVhayAobWlkLXNlc3Npb24sICM1MzA4KVwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbigpO1xuXG4gIGNvbnN0IGpvdXJuYWxFdmVudHM6IHN0cmluZ1tdID0gW107XG4gIGxldCBsb2NrQ2hlY2tDb3VudCA9IDA7XG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIC8vIEZpcnN0IGl0ZXJhdGlvbjogbG9jayB2YWxpZDsgc2Vjb25kIGl0ZXJhdGlvbjogbG9jayBpbnZhbGlkYXRlcy5cbiAgICB2YWxpZGF0ZVNlc3Npb25Mb2NrOiAoKSA9PiB7XG4gICAgICBsb2NrQ2hlY2tDb3VudCArPSAxO1xuICAgICAgaWYgKGxvY2tDaGVja0NvdW50ID09PSAxKSB7XG4gICAgICAgIHJldHVybiB7IHZhbGlkOiB0cnVlIH0gYXMgU2Vzc2lvbkxvY2tTdGF0dXM7XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICB2YWxpZDogZmFsc2UsXG4gICAgICAgIGZhaWx1cmVSZWFzb246IFwiY29tcHJvbWlzZWRcIixcbiAgICAgICAgZXhwZWN0ZWRQaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgfSBhcyBTZXNzaW9uTG9ja1N0YXR1cztcbiAgICB9LFxuICAgIGhhbmRsZUxvc3RTZXNzaW9uTG9jazogKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJoYW5kbGVMb3N0U2Vzc2lvbkxvY2tcIik7XG4gICAgfSxcbiAgICBlbWl0Sm91cm5hbEV2ZW50OiAoZW50cnkpID0+IHtcbiAgICAgIGpvdXJuYWxFdmVudHMucHVzaChlbnRyeS5ldmVudFR5cGUpO1xuICAgIH0sXG4gICAgLy8gRW5xdWV1ZSBhIHNpZGVjYXIgaXRlbSBhdCB0aGUgZW5kIG9mIGl0ZXJhdGlvbiAxLCBzbyBpdGVyYXRpb24gMiBiZWdpbnNcbiAgICAvLyB3aXRoIGEgbm9uLWVtcHR5IHF1ZXVlIGFuZCBhbiBpbnZhbGlkIGxvY2suXG4gICAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblwiKTtcbiAgICAgIHMuc2lkZWNhclF1ZXVlLnB1c2goe1xuICAgICAgICBraW5kOiBcImhvb2tcIiBhcyBjb25zdCxcbiAgICAgICAgdW5pdFR5cGU6IFwicnVuLXVhdFwiLFxuICAgICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxL3Jldmlld1wiLFxuICAgICAgICBwcm9tcHQ6IFwicmV2aWV3IHRoZSBjb2RlXCIsXG4gICAgICB9KTtcbiAgICAgIHJldHVybiBcImNvbnRpbnVlXCIgYXMgY29uc3Q7XG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcbiAgLy8gQWxsb3cgdGhlIGxvb3AgdG8gcmVhY2ggcnVuVW5pdCdzIGF3YWl0IG9uIGl0ZXJhdGlvbiAxLlxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpO1xuICBhd2FpdCBsb29wUHJvbWlzZTtcblxuICBhc3NlcnQub2sobG9ja0NoZWNrQ291bnQgPj0gMiwgXCJsb2NrIHZhbGlkYXRvciBtdXN0IHJ1biBvbiBpdGVyYXRpb24gMlwiKTtcbiAgYXNzZXJ0LmVxdWFsKFxuICAgIHMuc2lkZWNhclF1ZXVlLmxlbmd0aCxcbiAgICAwLFxuICAgIFwicXVldWVkIHNpZGVjYXIgaXRlbSBtdXN0IGJlIHBvcHBlZCBvbiB0aGUgbG9jay1sb3NzIGl0ZXJhdGlvblwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgam91cm5hbEV2ZW50cy5pbmNsdWRlcyhcInNpZGVjYXItZGVxdWV1ZVwiKSxcbiAgICBcInNpZGVjYXItZGVxdWV1ZSBqb3VybmFsIGV2ZW50IG11c3QgYmUgZW1pdHRlZCBiZWZvcmUgc2Vzc2lvbi1sb2NrIGJyZWFrXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJoYW5kbGVMb3N0U2Vzc2lvbkxvY2tcIiksXG4gICAgXCJsb2NrLWxvc3MgaGFuZGxlciBtdXN0IHN0aWxsIGZpcmUgb24gaXRlcmF0aW9uIDJcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiYXV0b0xvb3AgZXhpdHMgb24gdGVybWluYWwgYmxvY2tlZCBzdGF0ZVwiLCBhc3luYyAodCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGN0eC51aS5zZXRTdGF0dXMgPSAoKSA9PiB7fTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oKTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJkZXJpdmVTdGF0ZVwiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHBoYXNlOiBcImJsb2NrZWRcIixcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtcIk1pc3NpbmcgQVBJIGtleVwiXSxcbiAgICAgIH0gYXMgYW55O1xuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gIGFzc2VydC5vayhkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJkZXJpdmVTdGF0ZVwiKSwgXCJzaG91bGQgaGF2ZSBkZXJpdmVkIHN0YXRlXCIpO1xuICBhc3NlcnQub2soXG4gICAgZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicGF1c2VBdXRvXCIpLFxuICAgIFwic2hvdWxkIGhhdmUgY2FsbGVkIHBhdXNlQXV0byBmb3IgYmxvY2tlZCBzdGF0ZVwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgIWRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInJlc29sdmVEaXNwYXRjaFwiKSxcbiAgICBcInNob3VsZCBub3QgZGlzcGF0Y2ggd2hlbiBibG9ja2VkXCIsXG4gICk7XG59KTtcblxudGVzdChcImF1dG9Mb29wIGNhbGxzIGRlcml2ZVN0YXRlIFx1MjE5MiByZXNvbHZlRGlzcGF0Y2ggXHUyMTkyIHJ1blVuaXQgaW4gc2VxdWVuY2VcIiwgYXN5bmMgKHQpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGN0eC5zZXNzaW9uTWFuYWdlciA9IHsgZ2V0U2Vzc2lvbkZpbGU6ICgpID0+IFwiL3RtcC9zZXNzaW9uLmpzb25cIiB9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcblxuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG5cbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwiZGVyaXZlU3RhdGVcIik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlIDFcIiB9LFxuICAgICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgfSBhcyBhbnk7XG4gICAgfSxcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicmVzb2x2ZURpc3BhdGNoXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICAgIHByb21wdDogXCJkbyB0aGUgdGhpbmdcIixcbiAgICAgIH07XG4gICAgfSxcbiAgICBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb246IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIpO1xuICAgICAgLy8gRGVhY3RpdmF0ZSBhZnRlciBmaXJzdCBpdGVyYXRpb24gdG8gZXhpdCB0aGUgbG9vcFxuICAgICAgcy5hY3RpdmUgPSBmYWxzZTtcbiAgICAgIHJldHVybiBcImNvbnRpbnVlXCIgYXMgY29uc3Q7XG4gICAgfSxcbiAgfSk7XG5cbiAgLy8gUnVuIGF1dG9Mb29wIFx1MjAxNCBpdCB3aWxsIGNhbGwgcnVuVW5pdCBpbnRlcm5hbGx5IHdoaWNoIGNyZWF0ZXMgYSBwcm9taXNlLlxuICAvLyBXZSBuZWVkIHRvIHJlc29sdmUgdGhlIHByb21pc2UgZnJvbSBvdXRzaWRlIHZpYSByZXNvbHZlQWdlbnRFbmQuXG4gIGNvbnN0IGxvb3BQcm9taXNlID0gYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgLy8gR2l2ZSB0aGUgbG9vcCB0aW1lIHRvIHJlYWNoIHJ1blVuaXQncyBhd2FpdFxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuXG4gIC8vIFJlc29sdmUgdGhlIGZpcnN0IHVuaXQncyBhZ2VudF9lbmRcbiAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcblxuICBhd2FpdCBsb29wUHJvbWlzZTtcblxuICAvLyBWZXJpZnkgdGhlIHNlcXVlbmNlOiBkZXJpdmVTdGF0ZSBcdTIxOTIgcmVzb2x2ZURpc3BhdGNoIFx1MjE5MiB0aGVuIGZpbmFsaXplIGNhbGxiYWNrc1xuICBjb25zdCBkZXJpdmVJZHggPSBkZXBzLmNhbGxMb2cuaW5kZXhPZihcImRlcml2ZVN0YXRlXCIpO1xuICBjb25zdCBkaXNwYXRjaElkeCA9IGRlcHMuY2FsbExvZy5pbmRleE9mKFwicmVzb2x2ZURpc3BhdGNoXCIpO1xuICBjb25zdCBwcmVWZXJJZHggPSBkZXBzLmNhbGxMb2cuaW5kZXhPZihcInBvc3RVbml0UHJlVmVyaWZpY2F0aW9uXCIpO1xuICBjb25zdCB2ZXJJZHggPSBkZXBzLmNhbGxMb2cuaW5kZXhPZihcInJ1blBvc3RVbml0VmVyaWZpY2F0aW9uXCIpO1xuICBjb25zdCBwb3N0VmVySWR4ID0gZGVwcy5jYWxsTG9nLmluZGV4T2YoXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb25cIik7XG5cbiAgYXNzZXJ0Lm9rKGRlcml2ZUlkeCA+PSAwLCBcImRlcml2ZVN0YXRlIHNob3VsZCBoYXZlIGJlZW4gY2FsbGVkXCIpO1xuICBhc3NlcnQub2soXG4gICAgZGlzcGF0Y2hJZHggPiBkZXJpdmVJZHgsXG4gICAgXCJyZXNvbHZlRGlzcGF0Y2ggc2hvdWxkIGNvbWUgYWZ0ZXIgZGVyaXZlU3RhdGVcIixcbiAgKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIHByZVZlcklkeCA+IGRpc3BhdGNoSWR4LFxuICAgIFwicG9zdFVuaXRQcmVWZXJpZmljYXRpb24gc2hvdWxkIGNvbWUgYWZ0ZXIgcmVzb2x2ZURpc3BhdGNoXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICB2ZXJJZHggPiBwcmVWZXJJZHgsXG4gICAgXCJydW5Qb3N0VW5pdFZlcmlmaWNhdGlvbiBzaG91bGQgY29tZSBhZnRlciBwcmUtdmVyaWZpY2F0aW9uXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBwb3N0VmVySWR4ID4gdmVySWR4LFxuICAgIFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uIHNob3VsZCBjb21lIGFmdGVyIHZlcmlmaWNhdGlvblwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJhdXRvTG9vcCBqb3VybmFscyBwb3N0LXVuaXQgZmluYWxpemUgc3RvcCBhZnRlciBjb21wbGV0ZWQgdW5pdFwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjdHguc2Vzc2lvbk1hbmFnZXIgPSB7IGdldFNlc3Npb25GaWxlOiAoKSA9PiBcIi90bXAvc2Vzc2lvbi5qc29uXCIgfTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oKTtcbiAgY29uc3Qgam91cm5hbEV2ZW50czogQXJyYXk8eyBldmVudFR5cGU6IHN0cmluZzsgZGF0YT86IGFueSB9PiA9IFtdO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcInBvc3RVbml0UHJlVmVyaWZpY2F0aW9uXCIpO1xuICAgICAgcy5sYXN0R2l0QWN0aW9uRmFpbHVyZSA9IFwiY29tbWl0IGZhaWxlZFwiO1xuICAgICAgcmV0dXJuIFwiZGlzcGF0Y2hlZFwiIGFzIGNvbnN0O1xuICAgIH0sXG4gICAgZW1pdEpvdXJuYWxFdmVudDogKGVudHJ5OiBhbnkpID0+IHtcbiAgICAgIGpvdXJuYWxFdmVudHMucHVzaChlbnRyeSk7XG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcbiAgYXdhaXQgbG9vcFByb21pc2U7XG5cbiAgYXNzZXJ0Lm9rKFxuICAgIGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInBvc3RVbml0UHJlVmVyaWZpY2F0aW9uXCIpLFxuICAgIFwiY29tcGxldGVkIHVuaXRzIG11c3QgZW50ZXIgcG9zdC11bml0IHByZS12ZXJpZmljYXRpb24gYmVmb3JlIHN0b3BwaW5nXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICAhZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicnVuUG9zdFVuaXRWZXJpZmljYXRpb25cIiksXG4gICAgXCJnaXQtY2xvc2VvdXQgc3RvcCBzaG91bGQgbm90IHJ1biBsYXRlciB2ZXJpZmljYXRpb24gcGhhc2VzXCIsXG4gICk7XG5cbiAgY29uc3QgdW5pdEVuZEluZGV4ID0gam91cm5hbEV2ZW50cy5maW5kSW5kZXgoKGUpID0+IGUuZXZlbnRUeXBlID09PSBcInVuaXQtZW5kXCIpO1xuICBjb25zdCBmaW5hbGl6ZVN0YXJ0SW5kZXggPSBqb3VybmFsRXZlbnRzLmZpbmRJbmRleCgoZSkgPT4gZS5ldmVudFR5cGUgPT09IFwicG9zdC11bml0LWZpbmFsaXplLXN0YXJ0XCIpO1xuICBjb25zdCBmaW5hbGl6ZUVuZEluZGV4ID0gam91cm5hbEV2ZW50cy5maW5kSW5kZXgoKGUpID0+IGUuZXZlbnRUeXBlID09PSBcInBvc3QtdW5pdC1maW5hbGl6ZS1lbmRcIik7XG4gIGNvbnN0IGl0ZXJhdGlvbkVuZEluZGV4ID0gam91cm5hbEV2ZW50cy5maW5kSW5kZXgoKGUpID0+IGUuZXZlbnRUeXBlID09PSBcIml0ZXJhdGlvbi1lbmRcIik7XG5cbiAgYXNzZXJ0Lm9rKHVuaXRFbmRJbmRleCA+PSAwLCBcInVuaXQtZW5kIHNob3VsZCBiZSBqb3VybmFsZWQgYWZ0ZXIgYWdlbnQgY29tcGxldGlvblwiKTtcbiAgYXNzZXJ0Lm9rKGZpbmFsaXplU3RhcnRJbmRleCA+IHVuaXRFbmRJbmRleCwgXCJwb3N0LXVuaXQgZmluYWxpemUgbXVzdCBzdGFydCBhZnRlciB1bml0LWVuZFwiKTtcbiAgYXNzZXJ0Lm9rKGZpbmFsaXplRW5kSW5kZXggPiBmaW5hbGl6ZVN0YXJ0SW5kZXgsIFwicG9zdC11bml0IGZpbmFsaXplIG11c3Qgam91cm5hbCBpdHMgc3RvcCByZXN1bHRcIik7XG4gIGFzc2VydC5vayhpdGVyYXRpb25FbmRJbmRleCA+IGZpbmFsaXplRW5kSW5kZXgsIFwiaXRlcmF0aW9uLWVuZCBtdXN0IGJlIGVtaXR0ZWQgZXZlbiB3aGVuIGZpbmFsaXplIHN0b3BzXCIpO1xuXG4gIGFzc2VydC5kZWVwRXF1YWwoam91cm5hbEV2ZW50c1tmaW5hbGl6ZUVuZEluZGV4XSEuZGF0YSwge1xuICAgIGl0ZXJhdGlvbjogMSxcbiAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgc3RhdHVzOiBcInN0b3BwZWRcIixcbiAgICBhY3Rpb246IFwiYnJlYWtcIixcbiAgICByZWFzb246IFwiZ2l0LWNsb3Nlb3V0LWZhaWx1cmVcIixcbiAgfSk7XG4gIGFzc2VydC5kZWVwRXF1YWwoam91cm5hbEV2ZW50c1tpdGVyYXRpb25FbmRJbmRleF0hLmRhdGEsIHtcbiAgICBpdGVyYXRpb246IDEsXG4gICAgc3RhdHVzOiBcInN0b3BwZWRcIixcbiAgICByZWFzb246IFwiZ2l0LWNsb3Nlb3V0LWZhaWx1cmVcIixcbiAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgZmFpbHVyZUNsYXNzOiBcImdpdFwiLFxuICB9KTtcbn0pO1xuXG50ZXN0KFwiYXV0b0xvb3Agam91cm5hbHMgaXRlcmF0aW9uLWVuZCB3aGVuIHVuaXQgcGhhc2UgYnJlYWtzIGFmdGVyIGNhbmNlbGxlZCB1bml0XCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGN0eC5zZXNzaW9uTWFuYWdlciA9IHsgZ2V0U2Vzc2lvbkZpbGU6ICgpID0+IFwiL3RtcC9zZXNzaW9uLmpzb25cIiB9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbigpO1xuICBjb25zdCBqb3VybmFsRXZlbnRzOiBBcnJheTx7IGV2ZW50VHlwZTogc3RyaW5nOyBkYXRhPzogYW55IH0+ID0gW107XG5cbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZW1pdEpvdXJuYWxFdmVudDogKGVudHJ5OiBhbnkpID0+IHtcbiAgICAgIGpvdXJuYWxFdmVudHMucHVzaChlbnRyeSk7XG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkKCk7XG4gIGF3YWl0IGxvb3BQcm9taXNlO1xuXG4gIGNvbnN0IHVuaXRFbmRJbmRleCA9IGpvdXJuYWxFdmVudHMuZmluZEluZGV4KFxuICAgIChlKSA9PiBlLmV2ZW50VHlwZSA9PT0gXCJ1bml0LWVuZFwiICYmIGUuZGF0YT8uc3RhdHVzID09PSBcImNhbmNlbGxlZFwiLFxuICApO1xuICBjb25zdCBpdGVyYXRpb25FbmRJbmRleCA9IGpvdXJuYWxFdmVudHMuZmluZEluZGV4KChlKSA9PiBlLmV2ZW50VHlwZSA9PT0gXCJpdGVyYXRpb24tZW5kXCIpO1xuXG4gIGFzc2VydC5vayh1bml0RW5kSW5kZXggPj0gMCwgXCJjYW5jZWxsZWQgdW5pdCBzaG91bGQgc3RpbGwgZW1pdCB1bml0LWVuZFwiKTtcbiAgYXNzZXJ0Lm9rKGl0ZXJhdGlvbkVuZEluZGV4ID4gdW5pdEVuZEluZGV4LCBcInVuaXQtcGhhc2UgYnJlYWsgbXVzdCBjbG9zZSB0aGUgaXRlcmF0aW9uIGFmdGVyIHVuaXQtZW5kXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGpvdXJuYWxFdmVudHNbaXRlcmF0aW9uRW5kSW5kZXhdIS5kYXRhLCB7XG4gICAgaXRlcmF0aW9uOiAxLFxuICAgIHN0YXR1czogXCJzdG9wcGVkXCIsXG4gICAgcmVhc29uOiBcInVuaXQtYWJvcnRlZFwiLFxuICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICBmYWlsdXJlQ2xhc3M6IFwiZXhlY3V0aW9uXCIsXG4gIH0pO1xufSk7XG5cbnRlc3QoXCJjcmFzaCBsb2NrIHJlY29yZHMgc2Vzc2lvbiBmaWxlIGZyb20gQUZURVIgbmV3U2Vzc2lvbiwgbm90IGJlZm9yZSAoIzE3MTApXCIsIGFzeW5jICh0KSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuXG4gIC8vIFNpbXVsYXRlIG5ld1Nlc3Npb24gY2hhbmdpbmcgdGhlIHNlc3Npb24gZmlsZSBwYXRoLlxuICAvLyBuZXdTZXNzaW9uKCkgaW4gcnVuVW5pdCBjaGFuZ2VzIHRoZSB1bmRlcmx5aW5nIHNlc3Npb24sIHNvIGdldFNlc3Npb25GaWxlXG4gIC8vIHJldHVybnMgYSBkaWZmZXJlbnQgcGF0aCBhZnRlciBuZXdTZXNzaW9uIGNvbXBsZXRlcy5cbiAgbGV0IGN1cnJlbnRTZXNzaW9uRmlsZSA9IFwiL3RtcC9vbGQtc2Vzc2lvbi5qc29uXCI7XG4gIGN0eC5zZXNzaW9uTWFuYWdlciA9IHtcbiAgICBnZXRTZXNzaW9uRmlsZTogKCkgPT4gY3VycmVudFNlc3Npb25GaWxlLFxuICB9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcblxuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKHtcbiAgICBjbWRDdHg6IHtcbiAgICAgIG5ld1Nlc3Npb246ICgpID0+IHtcbiAgICAgICAgLy8gV2hlbiBuZXdTZXNzaW9uIGNvbXBsZXRlcywgdGhlIHNlc3Npb24gZmlsZSBjaGFuZ2VzXG4gICAgICAgIGN1cnJlbnRTZXNzaW9uRmlsZSA9IFwiL3RtcC9uZXctc2Vzc2lvbi1hZnRlci1uZXdTZXNzaW9uLmpzb25cIjtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7IGNhbmNlbGxlZDogZmFsc2UgfSk7XG4gICAgICB9LFxuICAgICAgZ2V0Q29udGV4dFVzYWdlOiAoKSA9PiAoeyBwZXJjZW50OiAxMCwgdG9rZW5zOiAxMDAwLCBsaW1pdDogMTAwMDAgfSksXG4gICAgfSxcbiAgfSk7XG5cbiAgLy8gVHJhY2sgYWxsIHdyaXRlTG9jayBjYWxscyB3aXRoIHRoZWlyIHNlc3Npb25GaWxlIGFyZ3VtZW50XG4gIGNvbnN0IHdyaXRlTG9ja0NhbGxzOiB7IHNlc3Npb25GaWxlOiBzdHJpbmcgfCB1bmRlZmluZWQgfVtdID0gW107XG4gIGNvbnN0IHVwZGF0ZVNlc3Npb25Mb2NrQ2FsbHM6IHsgc2Vzc2lvbkZpbGU6IHN0cmluZyB8IHVuZGVmaW5lZCB9W10gPSBbXTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJkZXJpdmVTdGF0ZVwiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiIH0sXG4gICAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIgfSxcbiAgICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICB9IGFzIGFueTtcbiAgICB9LFxuICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJyZXNvbHZlRGlzcGF0Y2hcIik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIiBhcyBjb25zdCxcbiAgICAgICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgICAgcHJvbXB0OiBcImRvIHRoZSB0aGluZ1wiLFxuICAgICAgfTtcbiAgICB9LFxuICAgIHdyaXRlTG9jazogKF9iYXNlOiBzdHJpbmcsIF91dDogc3RyaW5nLCBfdWlkOiBzdHJpbmcsIHNlc3Npb25GaWxlPzogc3RyaW5nKSA9PiB7XG4gICAgICB3cml0ZUxvY2tDYWxscy5wdXNoKHsgc2Vzc2lvbkZpbGUgfSk7XG4gICAgfSxcbiAgICB1cGRhdGVTZXNzaW9uTG9jazogKF9iYXNlOiBzdHJpbmcsIF91dDogc3RyaW5nLCBfdWlkOiBzdHJpbmcsIHNlc3Npb25GaWxlPzogc3RyaW5nKSA9PiB7XG4gICAgICB1cGRhdGVTZXNzaW9uTG9ja0NhbGxzLnB1c2goeyBzZXNzaW9uRmlsZSB9KTtcbiAgICB9LFxuICAgIGdldFNlc3Npb25GaWxlOiAoY3R4QXJnOiBhbnkpID0+IHtcbiAgICAgIHJldHVybiBjdHhBcmcuc2Vzc2lvbk1hbmFnZXI/LmdldFNlc3Npb25GaWxlKCkgPz8gXCJcIjtcbiAgICB9LFxuICAgIHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbjogYXN5bmMgKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb25cIik7XG4gICAgICAvLyBEZWFjdGl2YXRlIGFmdGVyIGZpcnN0IGl0ZXJhdGlvbiB0byBleGl0IHRoZSBsb29wXG4gICAgICBzLmFjdGl2ZSA9IGZhbHNlO1xuICAgICAgcmV0dXJuIFwiY29udGludWVcIiBhcyBjb25zdDtcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBsb29wUHJvbWlzZSA9IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gIC8vIEdpdmUgdGhlIGxvb3AgdGltZSB0byByZWFjaCBydW5Vbml0J3MgYXdhaXRcbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcblxuICAvLyBSZXNvbHZlIHRoZSB1bml0J3MgYWdlbnRfZW5kXG4gIHJlc29sdmVBZ2VudEVuZChtYWtlRXZlbnQoKSk7XG5cbiAgYXdhaXQgbG9vcFByb21pc2U7XG5cbiAgLy8gVGhlIHByZWxpbWluYXJ5IGxvY2sgKGJlZm9yZSBydW5Vbml0KSBzaG91bGQgaGF2ZSBOTyBzZXNzaW9uIGZpbGVcbiAgYXNzZXJ0Lm9rKFxuICAgIHdyaXRlTG9ja0NhbGxzLmxlbmd0aCA+PSAyLFxuICAgIGBleHBlY3RlZCBhdCBsZWFzdCAyIHdyaXRlTG9jayBjYWxscywgZ290ICR7d3JpdGVMb2NrQ2FsbHMubGVuZ3RofWAsXG4gICk7XG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICB3cml0ZUxvY2tDYWxsc1swXS5zZXNzaW9uRmlsZSxcbiAgICB1bmRlZmluZWQsXG4gICAgXCJwcmVsaW1pbmFyeSBsb2NrIGJlZm9yZSBydW5Vbml0IHNob3VsZCBoYXZlIG5vIHNlc3Npb24gZmlsZVwiLFxuICApO1xuXG4gIC8vIFRoZSBwb3N0LXJ1blVuaXQgbG9jayBzaG91bGQgaGF2ZSB0aGUgTkVXIHNlc3Npb24gZmlsZSBwYXRoXG4gIGFzc2VydC5zdHJpY3RFcXVhbChcbiAgICB3cml0ZUxvY2tDYWxsc1sxXS5zZXNzaW9uRmlsZSxcbiAgICBcIi90bXAvbmV3LXNlc3Npb24tYWZ0ZXItbmV3U2Vzc2lvbi5qc29uXCIsXG4gICAgXCJwb3N0LXJ1blVuaXQgbG9jayBzaG91bGQgcmVjb3JkIHRoZSBzZXNzaW9uIGZpbGUgY3JlYXRlZCBieSBuZXdTZXNzaW9uXCIsXG4gICk7XG5cbiAgLy8gdXBkYXRlU2Vzc2lvbkxvY2sgc2hvdWxkIGFsc28gaGF2ZSB0aGUgbmV3IHNlc3Npb24gZmlsZVxuICBhc3NlcnQub2soXG4gICAgdXBkYXRlU2Vzc2lvbkxvY2tDYWxscy5sZW5ndGggPj0gMSxcbiAgICBcInVwZGF0ZVNlc3Npb25Mb2NrIHNob3VsZCBoYXZlIGJlZW4gY2FsbGVkIGF0IGxlYXN0IG9uY2VcIixcbiAgKTtcbiAgYXNzZXJ0LnN0cmljdEVxdWFsKFxuICAgIHVwZGF0ZVNlc3Npb25Mb2NrQ2FsbHNbMF0uc2Vzc2lvbkZpbGUsXG4gICAgXCIvdG1wL25ldy1zZXNzaW9uLWFmdGVyLW5ld1Nlc3Npb24uanNvblwiLFxuICAgIFwidXBkYXRlU2Vzc2lvbkxvY2sgc2hvdWxkIHJlY29yZCB0aGUgc2Vzc2lvbiBmaWxlIGNyZWF0ZWQgYnkgbmV3U2Vzc2lvblwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJhdXRvTG9vcCBoYW5kbGVzIHZlcmlmaWNhdGlvbiByZXRyeSBieSBjb250aW51aW5nIGxvb3BcIiwgYXN5bmMgKHQpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcbiAgbW9jay50aW1lcnMuZW5hYmxlKHsgYXBpczogW1wiRGF0ZVwiLCBcInNldFRpbWVvdXRcIl0sIG5vdzogMTBfMDAwIH0pO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gICAgY3R4LnNlc3Npb25NYW5hZ2VyID0geyBnZXRTZXNzaW9uRmlsZTogKCkgPT4gXCIvdG1wL3Nlc3Npb24uanNvblwiIH07XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG5cbiAgICBsZXQgdmVyaWZ5Q2FsbENvdW50ID0gMDtcbiAgICBsZXQgZGVyaXZlQ2FsbENvdW50ID0gMDtcbiAgICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG5cbiAgICAvLyBQcmUtcXVldWVkIHZlcmlmaWNhdGlvbiBhY3Rpb25zOiBlYWNoIGVudHJ5IHByb3ZpZGVzIGEgc2lkZS1lZmZlY3QgKyByZXR1cm4gdmFsdWVcbiAgICB0eXBlIFZlcmlmeUFjdGlvbiA9IHsgc2lkZUVmZmVjdD86ICgpID0+IHZvaWQ7IHJlc3BvbnNlOiBcInJldHJ5XCIgfCBcImNvbnRpbnVlXCIgfTtcbiAgICBjb25zdCB2ZXJpZmljYXRpb25BY3Rpb25zOiBWZXJpZnlBY3Rpb25bXSA9IFtcbiAgICAgIHtcbiAgICAgICAgc2lkZUVmZmVjdDogKCkgPT4ge1xuICAgICAgICAgIC8vIFNpbXVsYXRlIHJldHJ5IFx1MjAxNCBzZXQgcGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5IG9uIHNlc3Npb25cbiAgICAgICAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IHtcbiAgICAgICAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgICAgICAgIGZhaWx1cmVDb250ZXh0OiBcInRlc3QgZmFpbGVkOiBleHBlY3RlZCBYIGdvdCBZXCIsXG4gICAgICAgICAgICBhdHRlbXB0OiAxLFxuICAgICAgICAgIH07XG4gICAgICAgIH0sXG4gICAgICAgIHJlc3BvbnNlOiBcInJldHJ5XCIsXG4gICAgICB9LFxuICAgICAgeyByZXNwb25zZTogXCJjb250aW51ZVwiIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IHtcbiAgICAgICAgZGVyaXZlQ2FsbENvdW50Kys7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwiZGVyaXZlU3RhdGVcIik7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiIH0sXG4gICAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgIH0gYXMgYW55O1xuICAgICAgfSxcbiAgICAgIHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGFjdGlvbiA9IHZlcmlmaWNhdGlvbkFjdGlvbnNbdmVyaWZ5Q2FsbENvdW50XSA/PyB7IHJlc3BvbnNlOiBcImNvbnRpbnVlXCIgYXMgY29uc3QgfTtcbiAgICAgICAgdmVyaWZ5Q2FsbENvdW50Kys7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicnVuUG9zdFVuaXRWZXJpZmljYXRpb25cIik7XG4gICAgICAgIGFjdGlvbi5zaWRlRWZmZWN0Py4oKTtcbiAgICAgICAgcmV0dXJuIGFjdGlvbi5yZXNwb25zZTtcbiAgICAgIH0sXG4gICAgICBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb246IGFzeW5jICgpID0+IHtcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb25cIik7XG4gICAgICAgIC8vIEFmdGVyIHRoZSByZXRyeSBjeWNsZSBjb21wbGV0ZXMsIGRlYWN0aXZhdGVcbiAgICAgICAgcy5hY3RpdmUgPSBmYWxzZTtcbiAgICAgICAgcmV0dXJuIFwiY29udGludWVcIiBhcyBjb25zdDtcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBsb29wUHJvbWlzZSA9IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gICAgLy8gRmlyc3QgaXRlcmF0aW9uOiBydW5Vbml0IFx1MjE5MiB2ZXJpZmljYXRpb24gcmV0dXJucyBcInJldHJ5XCIgXHUyMTkyIGxvb3AgY29udGludWVzXG4gICAgYXdhaXQgd2FpdEZvck1pY3JvdGFza3MoKCkgPT4gcGkuY2FsbHMubGVuZ3RoID09PSAxLCBcImZpcnN0IGRpc3BhdGNoXCIpO1xuICAgIHJlc29sdmVBZ2VudEVuZChtYWtlRXZlbnQoKSk7IC8vIHJlc29sdmUgZmlyc3QgdW5pdFxuXG4gICAgYXdhaXQgZHJhaW5NaWNyb3Rhc2tzKDEwMCk7XG4gICAgbW9jay50aW1lcnMudGljaygzMF8wMDApO1xuICAgIGF3YWl0IHdhaXRGb3JNaWNyb3Rhc2tzKCgpID0+IHBpLmNhbGxzLmxlbmd0aCA9PT0gMiwgXCJyZXRyeSBkaXNwYXRjaFwiKTtcbiAgICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpOyAvLyByZXNvbHZlIHJldHJ5IHVuaXRcblxuICAgIGF3YWl0IGxvb3BQcm9taXNlO1xuXG4gICAgLy8gVmVyaWZ5IGRlcml2ZVN0YXRlIHdhcyBjYWxsZWQgdHdpY2UgKHR3byBpdGVyYXRpb25zKVxuICAgIGNvbnN0IGRlcml2ZUNvdW50ID0gZGVwcy5jYWxsTG9nLmZpbHRlcigoYykgPT4gYyA9PT0gXCJkZXJpdmVTdGF0ZVwiKS5sZW5ndGg7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgZGVyaXZlQ291bnQgPj0gMixcbiAgICAgIGBkZXJpdmVTdGF0ZSBzaG91bGQgYmUgY2FsbGVkIGF0IGxlYXN0IDIgdGltZXMgKGdvdCAke2Rlcml2ZUNvdW50fSlgLFxuICAgICk7XG5cbiAgICAvLyBWZXJpZnkgdmVyaWZpY2F0aW9uIHdhcyBjYWxsZWQgdHdpY2VcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICB2ZXJpZnlDYWxsQ291bnQsXG4gICAgICAyLFxuICAgICAgXCJ2ZXJpZmljYXRpb24gc2hvdWxkIGhhdmUgYmVlbiBjYWxsZWQgdHdpY2UgKG9uY2UgcmV0cnksIG9uY2UgcGFzcylcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIG1vY2sudGltZXJzLnJlc2V0KCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYXV0b0xvb3AgcGF1c2VzIGluc3RlYWQgb2YgcmVkaXNwYXRjaGluZyBpZGVudGljYWwgdmVyaWZpY2F0aW9uIGZhaWx1cmUgY29udGV4dFwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG4gIG1vY2sudGltZXJzLmVuYWJsZSh7IGFwaXM6IFtcIkRhdGVcIiwgXCJzZXRUaW1lb3V0XCJdLCBub3c6IDE1XzAwMCB9KTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICAgIGN0eC51aS5ub3RpZnkgPSAoKSA9PiB7fTtcbiAgICBjdHguc2Vzc2lvbk1hbmFnZXIgPSB7IGdldFNlc3Npb25GaWxlOiAoKSA9PiBcIi90bXAvc2Vzc2lvbi5qc29uXCIgfTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG4gICAgbGV0IHZlcmlmeUNhbGxDb3VudCA9IDA7XG4gICAgbGV0IHBhdXNlQ2FsbENvdW50ID0gMDtcblxuICAgIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+XG4gICAgICAgICh7XG4gICAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiIH0sXG4gICAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgIH0pIGFzIGFueSxcbiAgICAgIHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIHZlcmlmeUNhbGxDb3VudCsrO1xuICAgICAgICBkZXBzLmNhbGxMb2cucHVzaChcInJ1blBvc3RVbml0VmVyaWZpY2F0aW9uXCIpO1xuICAgICAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IHtcbiAgICAgICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICAgICAgZmFpbHVyZUNvbnRleHQ6IFwidGVzdCBmYWlsZWQ6IGV4cGVjdGVkIFggZ290IFlcIixcbiAgICAgICAgICBhdHRlbXB0OiB2ZXJpZnlDYWxsQ291bnQsXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiBcInJldHJ5XCIgYXMgY29uc3Q7XG4gICAgICB9LFxuICAgICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIHBhdXNlQ2FsbENvdW50Kys7XG4gICAgICAgIHMuYWN0aXZlID0gZmFsc2U7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICAgIGF3YWl0IHdhaXRGb3JNaWNyb3Rhc2tzKCgpID0+IHBpLmNhbGxzLmxlbmd0aCA9PT0gMSwgXCJmaXJzdCBkaXNwYXRjaFwiKTtcbiAgICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpO1xuICAgIGF3YWl0IGRyYWluTWljcm90YXNrcygxMDApO1xuICAgIG1vY2sudGltZXJzLnRpY2soMzBfMDAwKTtcblxuICAgIGF3YWl0IHdhaXRGb3JNaWNyb3Rhc2tzKCgpID0+IHBpLmNhbGxzLmxlbmd0aCA9PT0gMiwgXCJyZXRyeSBkaXNwYXRjaFwiKTtcbiAgICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpO1xuXG4gICAgYXdhaXQgbG9vcFByb21pc2U7XG5cbiAgICBhc3NlcnQuZXF1YWwodmVyaWZ5Q2FsbENvdW50LCAyKTtcbiAgICBhc3NlcnQuZXF1YWwocGkuY2FsbHMubGVuZ3RoLCAyLCBcImR1cGxpY2F0ZSBmYWlsdXJlIHNob3VsZCBub3QgYmUgcmVkaXNwYXRjaGVkIGEgdGhpcmQgdGltZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VDYWxsQ291bnQsIDEsIFwiZHVwbGljYXRlIGZhaWx1cmUgc2hvdWxkIHBhdXNlIGF1dG8tbW9kZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBtb2NrLnRpbWVycy5yZXNldCgpO1xuICB9XG59KTtcblxudGVzdChcImF1dG9Mb29wIGhhbmRsZXMgZGlzcGF0Y2ggc3RvcCBhY3Rpb25cIiwgYXN5bmMgKHQpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG5cbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgcmVzb2x2ZURpc3BhdGNoOiBhc3luYyAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcInJlc29sdmVEaXNwYXRjaFwiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJzdG9wXCIgYXMgY29uc3QsXG4gICAgICAgIHJlYXNvbjogXCJ0ZXN0LXN0b3AtcmVhc29uXCIsXG4gICAgICAgIGxldmVsOiBcImluZm9cIiBhcyBjb25zdCxcbiAgICAgIH07XG4gICAgfSxcbiAgfSk7XG5cbiAgYXdhaXQgYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgYXNzZXJ0Lm9rKFxuICAgIGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInJlc29sdmVEaXNwYXRjaFwiKSxcbiAgICBcInNob3VsZCBoYXZlIGNhbGxlZCByZXNvbHZlRGlzcGF0Y2hcIixcbiAgKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInN0b3BBdXRvXCIpLFxuICAgIFwic2hvdWxkIGhhdmUgc3RvcHBlZCBvbiBkaXNwYXRjaCBzdG9wIGFjdGlvblwiLFxuICApO1xufSk7XG5cbi8vICMyNDc0OiB3YXJuaW5nLWxldmVsIGRpc3BhdGNoIHN0b3Agc2hvdWxkIHBhdXNlIChyZXN1bWFibGUpLCBub3QgaGFyZC1zdG9wXG50ZXN0KFwiYXV0b0xvb3AgcGF1c2VzIGluc3RlYWQgb2Ygc3RvcHBpbmcgZm9yIHdhcm5pbmctbGV2ZWwgZGlzcGF0Y2ggc3RvcFwiLCBhc3luYyAodCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGN0eC51aS5zZXRTdGF0dXMgPSAoKSA9PiB7fTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oKTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicmVzb2x2ZURpc3BhdGNoXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcInN0b3BcIiBhcyBjb25zdCxcbiAgICAgICAgcmVhc29uOiAnVUFUIHZlcmRpY3QgZm9yIFMwMSBpcyBcInBhcnRpYWxcIiBcdTIwMTQgYmxvY2tpbmcgcHJvZ3Jlc3Npb24uJyxcbiAgICAgICAgbGV2ZWw6IFwid2FybmluZ1wiIGFzIGNvbnN0LFxuICAgICAgfTtcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICBhc3NlcnQub2soXG4gICAgZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicmVzb2x2ZURpc3BhdGNoXCIpLFxuICAgIFwic2hvdWxkIGhhdmUgY2FsbGVkIHJlc29sdmVEaXNwYXRjaFwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicGF1c2VBdXRvXCIpLFxuICAgIFwid2FybmluZy1sZXZlbCBzdG9wIHNob3VsZCBjYWxsIHBhdXNlQXV0byAocmVzdW1hYmxlKVwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgIWRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInN0b3BBdXRvXCIpLFxuICAgIFwid2FybmluZy1sZXZlbCBzdG9wIHNob3VsZCBOT1QgY2FsbCBzdG9wQXV0byAoaGFyZCBzdG9wKVwiLFxuICApO1xufSk7XG5cbi8vICMyNDc0OiBlcnJvci1sZXZlbCBkaXNwYXRjaCBzdG9wIHNob3VsZCBzdGlsbCBoYXJkLXN0b3BcbnRlc3QoXCJhdXRvTG9vcCBoYXJkLXN0b3BzIGZvciBlcnJvci1sZXZlbCBkaXNwYXRjaCBzdG9wXCIsIGFzeW5jICh0KSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbigpO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJyZXNvbHZlRGlzcGF0Y2hcIik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwic3RvcFwiIGFzIGNvbnN0LFxuICAgICAgICByZWFzb246IFwiQ2Fubm90IGNvbXBsZXRlIG1pbGVzdG9uZTogbWlzc2luZyBTVU1NQVJZIGZpbGVzLlwiLFxuICAgICAgICBsZXZlbDogXCJlcnJvclwiIGFzIGNvbnN0LFxuICAgICAgfTtcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICBhc3NlcnQub2soXG4gICAgZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwic3RvcEF1dG9cIiksXG4gICAgXCJlcnJvci1sZXZlbCBzdG9wIHNob3VsZCBjYWxsIHN0b3BBdXRvIChoYXJkIHN0b3ApXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICAhZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicGF1c2VBdXRvXCIpLFxuICAgIFwiZXJyb3ItbGV2ZWwgc3RvcCBzaG91bGQgTk9UIGNhbGwgcGF1c2VBdXRvXCIsXG4gICk7XG59KTtcblxudGVzdChcImF1dG9Mb29wIGhhbmRsZXMgZGlzcGF0Y2ggc2tpcCBhY3Rpb24gYnkgY29udGludWluZ1wiLCBhc3luYyAodCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGN0eC51aS5zZXRTdGF0dXMgPSAoKSA9PiB7fTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oKTtcblxuICBsZXQgZGlzcGF0Y2hDYWxsQ291bnQgPSAwO1xuICAvLyBQcmUtcXVldWVkIGRpc3BhdGNoIHJlc3BvbnNlczogZmlyc3QgY2FsbCByZXR1cm5zIFwic2tpcFwiLCBzZWNvbmQgcmV0dXJucyBcInN0b3BcIlxuICBjb25zdCBkaXNwYXRjaFJlc3BvbnNlcyA9IFtcbiAgICB7IGFjdGlvbjogXCJza2lwXCIgYXMgY29uc3QgfSxcbiAgICB7IGFjdGlvbjogXCJzdG9wXCIgYXMgY29uc3QsIHJlYXNvbjogXCJkb25lXCIsIGxldmVsOiBcImluZm9cIiBhcyBjb25zdCB9LFxuICBdO1xuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gZGlzcGF0Y2hSZXNwb25zZXNbZGlzcGF0Y2hDYWxsQ291bnRdID8/IGRpc3BhdGNoUmVzcG9uc2VzW2Rpc3BhdGNoUmVzcG9uc2VzLmxlbmd0aCAtIDFdO1xuICAgICAgZGlzcGF0Y2hDYWxsQ291bnQrKztcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicmVzb2x2ZURpc3BhdGNoXCIpO1xuICAgICAgcmV0dXJuIHJlc3BvbnNlO1xuICAgIH0sXG4gIH0pO1xuXG4gIGF3YWl0IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gIC8vIFNob3VsZCBoYXZlIGNhbGxlZCByZXNvbHZlRGlzcGF0Y2ggdHdpY2UgKHNraXAgXHUyMTkyIHJlLWRlcml2ZSBcdTIxOTIgc3RvcClcbiAgY29uc3QgZGlzcGF0Y2hDYWxscyA9IGRlcHMuY2FsbExvZy5maWx0ZXIoKGMpID0+IGMgPT09IFwicmVzb2x2ZURpc3BhdGNoXCIpO1xuICBhc3NlcnQuZXF1YWwoXG4gICAgZGlzcGF0Y2hDYWxscy5sZW5ndGgsXG4gICAgMixcbiAgICBcInJlc29sdmVEaXNwYXRjaCBzaG91bGQgYmUgY2FsbGVkIHR3aWNlIChza2lwIHRoZW4gc3RvcClcIixcbiAgKTtcbiAgY29uc3QgZGVyaXZlQ2FsbHMgPSBkZXBzLmNhbGxMb2cuZmlsdGVyKChjKSA9PiBjID09PSBcImRlcml2ZVN0YXRlXCIpO1xuICBhc3NlcnQub2soXG4gICAgZGVyaXZlQ2FsbHMubGVuZ3RoID49IDIsXG4gICAgXCJkZXJpdmVTdGF0ZSBzaG91bGQgYmUgY2FsbGVkIGF0IGxlYXN0IHR3aWNlIChvbmUgcGVyIGl0ZXJhdGlvbilcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiYXV0b0xvb3AgZHJhaW5zIHNpZGVjYXIgcXVldWUgYWZ0ZXIgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uIGVucXVldWVzIGl0ZW1zXCIsIGFzeW5jICh0KSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjdHguc2Vzc2lvbk1hbmFnZXIgPSB7IGdldFNlc3Npb25GaWxlOiAoKSA9PiBcIi90bXAvc2Vzc2lvbi5qc29uXCIgfTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oKTtcblxuICBsZXQgcG9zdFZlckNhbGxDb3VudCA9IDA7XG4gIGNvbnN0IHBvc3RWZXJBY3Rpb25zOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtcbiAgICAoKSA9PiB7XG4gICAgICAvLyBGaXJzdCBjYWxsIChtYWluIHVuaXQpOiBlbnF1ZXVlIGEgc2lkZWNhciBpdGVtXG4gICAgICBzLnNpZGVjYXJRdWV1ZS5wdXNoKHtcbiAgICAgICAga2luZDogXCJob29rXCIgYXMgY29uc3QsXG4gICAgICAgIHVuaXRUeXBlOiBcInJ1bi11YXRcIixcbiAgICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMS9yZXZpZXdcIixcbiAgICAgICAgcHJvbXB0OiBcInJldmlldyB0aGUgY29kZVwiLFxuICAgICAgfSk7XG4gICAgfSxcbiAgICAoKSA9PiB7XG4gICAgICAvLyBTZWNvbmQgY2FsbCAoc2lkZWNhciB1bml0IGNvbXBsZXRlZCk6IGRlYWN0aXZhdGVcbiAgICAgIHMuYWN0aXZlID0gZmFsc2U7XG4gICAgfSxcbiAgXTtcbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICBwb3N0VmVyQWN0aW9uc1twb3N0VmVyQ2FsbENvdW50XT8uKCk7XG4gICAgICBwb3N0VmVyQ2FsbENvdW50Kys7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblwiKTtcbiAgICAgIHJldHVybiBcImNvbnRpbnVlXCIgYXMgY29uc3Q7XG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICAvLyBXYWl0IGZvciBtYWluIHVuaXQncyBydW5Vbml0IHRvIGJlIGF3YWl0aW5nXG4gIGZvciAobGV0IGkgPSAwOyAhX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCgpICYmIGkgPCAxMDA7IGkrKykge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUpKTtcbiAgfVxuICBhc3NlcnQuZXF1YWwoX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCgpLCB0cnVlLCBcIm1haW4gdW5pdCBzaG91bGQgYmUgYXdhaXRpbmcgYWdlbnRfZW5kXCIpO1xuICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpOyAvLyByZXNvbHZlIG1haW4gdW5pdFxuXG4gIC8vIFdhaXQgZm9yIHRoZSBzaWRlY2FyIHVuaXQncyBydW5Vbml0IHRvIGJlIGF3YWl0aW5nXG4gIGZvciAobGV0IGkgPSAwOyAhX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCgpICYmIHBvc3RWZXJDYWxsQ291bnQgPCAyICYmIGkgPCAxMDA7IGkrKykge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUpKTtcbiAgfVxuICBhc3NlcnQuZXF1YWwoX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCgpLCB0cnVlLCBcInNpZGVjYXIgdW5pdCBzaG91bGQgYmUgYXdhaXRpbmcgYWdlbnRfZW5kXCIpO1xuICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpOyAvLyByZXNvbHZlIHNpZGVjYXIgdW5pdFxuXG4gIGF3YWl0IGxvb3BQcm9taXNlO1xuXG4gIC8vIHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbiBzaG91bGQgaGF2ZSBiZWVuIGNhbGxlZCB0d2ljZSAobWFpbiArIHNpZGVjYXIpXG4gIGFzc2VydC5lcXVhbChcbiAgICBwb3N0VmVyQ2FsbENvdW50LFxuICAgIDIsXG4gICAgXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb24gc2hvdWxkIGJlIGNhbGxlZCB0d2ljZSAobWFpbiArIHNpZGVjYXIpXCIsXG4gICk7XG59KTtcblxudGVzdChcImF1dG9Mb29wIGV4aXRzIHdoZW4gbm8gYWN0aXZlIG1pbGVzdG9uZSBmb3VuZFwiLCBhc3luYyAodCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGN0eC51aS5zZXRTdGF0dXMgPSAoKSA9PiB7fTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oeyBjdXJyZW50TWlsZXN0b25lSWQ6IG51bGwgfSk7XG5cbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwiZGVyaXZlU3RhdGVcIik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lOiBudWxsLFxuICAgICAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgICAgcmVnaXN0cnk6IFtdLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICB9IGFzIGFueTtcbiAgICB9LFxuICB9KTtcblxuICBhd2FpdCBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICBhc3NlcnQub2soXG4gICAgZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwic3RvcEF1dG9cIiksXG4gICAgXCJzaG91bGQgc3RvcCB3aGVuIG5vIG1pbGVzdG9uZSBhbmQgYWxsIGNvbXBsZXRlXCIsXG4gICk7XG59KTtcblxuLy8gTk9URTogVGhlIFQwMyBcIndpcmluZyBzdHJ1Y3R1cmFsIGFzc2VydGlvbnNcIiBibG9jayAoYmFycmVsIHJlLWV4cG9ydHMsXG4vLyBMb29wRGVwcy1pbnRlcmZhY2UtZGVjbGFyZWQsIHdoaWxlLWxvb3Aga2V5d29yZCwgVU9LIGtlcm5lbCB3cmFwcGVyLFxuLy8gc2VsZkhlYWwgb3JkZXJpbmcsIHMuYWN0aXZlIGNvbmN1cnJlbnQgZ3VhcmQsIGFnZW50X2VuZCBoYW5kbGVyIGNhbGxcbi8vIHNoYXBlLCBydW5Qb3N0VW5pdFZlcmlmaWNhdGlvbiBzaWduYXR1cmUsIGF1dG8tdGltZW91dC1yZWNvdmVyeSBjYWxsXG4vLyBzaGFwZSkgd2FzIGEgcHVyZSBzb3VyY2UtZ3JlcCBjaGFpbiBcdTIwMTQgcmVhZEZpbGVTeW5jICsgaW5jbHVkZXMvaW5kZXhPZiBcdTIwMTRcbi8vIHNvIGl0IGFzc2VydGVkIG9uIGNvZGUgc2hhcGUgcmF0aGVyIHRoYW4gcnVudGltZSBiZWhhdmlvdXIuIFRoZSBzeW1ib2xzXG4vLyBuYW1lZCBpbiB0aG9zZSBhc3NlcnRpb25zIGFyZSBBTFJFQURZIGltcG9ydGVkIGF0IHRoZSB0b3Agb2YgdGhpcyBmaWxlO1xuLy8gaWYgdGhlIHByb2R1Y3Rpb24gYmFycmVsIGRyb3BzIGFueSBvZiB0aGVtLCB0aGlzIGZpbGUgZmFpbHMgdG8gaW1wb3J0XG4vLyBhbmQgZXZlcnkgdGVzdCBoZXJlIGZhaWxzIGNvbGQuIFRoYXQgaW1wb3J0LXRpbWUgY2hlY2sgaXMgdGhlIHJlYWxcbi8vIGJlaGF2aW91cmFsIGNvbnRyYWN0LiBUaGUgb3JkZXJpbmcvc2lnbmF0dXJlIGNvbnRyYWN0cyAoVU9LIGRpc3BhdGNoLFxuLy8gY29uY3VycmVudCBndWFyZCwgYWdlbnRfZW5kIHdpcmluZykgYXJlIHRyYWNrZWQgYXMgZm9sbG93LXVwIGlzc3VlcyBmb3Jcbi8vIHB1cmUtaGVscGVyIGV4dHJhY3Rpb24gcGVyIHRoZSAjNDgzMi9QUiAjNDg1OSBwcmVjZWRlbnQuXG5cbi8vIFx1MjUwMFx1MjUwMCBTdHVjayBjb3VudGVyIHRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwic3R1Y2sgZGV0ZWN0aW9uOiBzdG9wcyB3aGVuIHNsaWRpbmcgd2luZG93IGRldGVjdHMgc2FtZSB1bml0IDMgY29uc2VjdXRpdmUgdGltZXNcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGN0eC51aS5zZXRTdGF0dXMgPSAoKSA9PiB7fTtcbiAgY3R4LnVpLm5vdGlmeSA9ICgpID0+IHt9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbigpO1xuXG4gIGxldCBzdG9wUmVhc29uID0gXCJcIjtcbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+XG4gICAgICAoe1xuICAgICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlIDFcIiB9LFxuICAgICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgfSkgYXMgYW55LFxuICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4gKHtcbiAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiIGFzIGNvbnN0LFxuICAgICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICBwcm9tcHQ6IFwiZG8gdGhlIHRoaW5nXCIsXG4gICAgfSksXG4gICAgc3RvcEF1dG86IGFzeW5jIChfY3R4PzogYW55LCBfcGk/OiBhbnksIHJlYXNvbj86IHN0cmluZykgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJzdG9wQXV0b1wiKTtcbiAgICAgIHN0b3BSZWFzb24gPSByZWFzb24gPz8gXCJcIjtcbiAgICAgIHMuYWN0aXZlID0gZmFsc2U7XG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICAvLyBTbGlkaW5nIHdpbmRvdzogaXRlcmF0aW9uIDEgcHVzaGVzIFtBXSwgaXRlcmF0aW9uIDIgcHVzaGVzIFtBLEFdLFxuICAvLyBpdGVyYXRpb24gMyBwdXNoZXMgW0EsQSxBXSBcdTIxOTIgUnVsZSAyIGZpcmVzICgzIGNvbnNlY3V0aXZlKSBcdTIxOTIgTGV2ZWwgMSByZWNvdmVyeS5cbiAgLy8gTGV2ZWwgMSBpbnZhbGlkYXRlcyBjYWNoZXMgYW5kIGNvbnRpbnVlcy4gSXRlcmF0aW9uIDQgcHVzaGVzIFtBLEEsQSxBXSBcdTIxOTJcbiAgLy8gUnVsZSAyIGZpcmVzIGFnYWluIFx1MjE5MiBMZXZlbCAyIGhhcmQgc3RvcC5cbiAgLy8gSXRlcmF0aW9ucyAxLTMgZWFjaCBydW4gYSB1bml0ICgzIHJlc29sdmVzIG5lZWRlZCkuIEl0ZXJhdGlvbiAzIHRyaWdnZXJzXG4gIC8vIExldmVsIDEgKGNhY2hlIGludmFsaWRhdGlvbiArIGNvbnRpbnVlKS4gSXRlcmF0aW9uIDQgdHJpZ2dlcnMgTGV2ZWwgMiAoc3RvcFxuICAvLyBiZWZvcmUgcnVuVW5pdCksIHNvIG5vIDR0aCByZXNvbHZlIG5lZWRlZC5cblxuICBmb3IgKGxldCBpID0gMDsgaSA8IDM7IGkrKykge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDMwKSk7XG4gICAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcbiAgfVxuXG4gIGF3YWl0IGxvb3BQcm9taXNlO1xuXG4gIGFzc2VydC5vayhcbiAgICBkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJzdG9wQXV0b1wiKSxcbiAgICBcInN0b3BBdXRvIHNob3VsZCBoYXZlIGJlZW4gY2FsbGVkXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBzdG9wUmVhc29uLmluY2x1ZGVzKFwiU3R1Y2tcIiksXG4gICAgYHN0b3AgcmVhc29uIHNob3VsZCBtZW50aW9uICdTdHVjaycsIGdvdDogJHtzdG9wUmVhc29ufWAsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBzdG9wUmVhc29uLmluY2x1ZGVzKFwiTTAwMS9TMDEvVDAxXCIpLFxuICAgIFwic3RvcCByZWFzb24gc2hvdWxkIGluY2x1ZGUgdW5pdElkXCIsXG4gICk7XG59KTtcblxudGVzdChcInN0dWNrIGRldGVjdGlvbjogd2luZG93IHJlc2V0cyByZWNvdmVyeSB3aGVuIGRlcml2ZVN0YXRlIHJldHVybnMgYSBkaWZmZXJlbnQgdW5pdFwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjdHgudWkubm90aWZ5ID0gKCkgPT4ge307XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG5cbiAgbGV0IGRlcml2ZUNhbGxDb3VudCA9IDA7XG4gIGxldCBwb3N0VmVyQ2FsbENvdW50ID0gMDtcbiAgbGV0IHN0b3BDYWxsZWQgPSBmYWxzZTtcblxuICAvLyBGaXJzdCAzIGRlcml2ZXMgcmV0dXJuIFQwMSwgNHRoIHJldHVybnMgVDAyOyBkaXNwYXRjaCBmb2xsb3dzIHRoZSBkZXJpdmVkIHRhc2tcbiAgY29uc3QgZGVyaXZlZFRhc2tJZHMgPSBbXCJUMDFcIiwgXCJUMDFcIiwgXCJUMDFcIiwgXCJUMDJcIl07XG5cbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHRhc2tJZCA9IGRlcml2ZWRUYXNrSWRzW01hdGgubWluKGRlcml2ZUNhbGxDb3VudCwgZGVyaXZlZFRhc2tJZHMubGVuZ3RoIC0gMSldO1xuICAgICAgZGVyaXZlQ2FsbENvdW50Kys7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcImRlcml2ZVN0YXRlXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIgfSxcbiAgICAgICAgYWN0aXZlVGFzazogeyBpZDogdGFza0lkIH0sXG4gICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgfSBhcyBhbnk7XG4gICAgfSxcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHRhc2tJZCA9IGRlcml2ZWRUYXNrSWRzW01hdGgubWluKGRlcml2ZUNhbGxDb3VudCAtIDEsIGRlcml2ZWRUYXNrSWRzLmxlbmd0aCAtIDEpXTtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicmVzb2x2ZURpc3BhdGNoXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgICB1bml0SWQ6IGBNMDAxL1MwMS8ke3Rhc2tJZH1gLFxuICAgICAgICBwcm9tcHQ6IFwiZG8gdGhlIHRoaW5nXCIsXG4gICAgICB9O1xuICAgIH0sXG4gICAgc3RvcEF1dG86IGFzeW5jIChfY3R4PzogYW55LCBfcGk/OiBhbnksIHJlYXNvbj86IHN0cmluZykgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJzdG9wQXV0b1wiKTtcbiAgICAgIHN0b3BDYWxsZWQgPSB0cnVlO1xuICAgICAgcy5hY3RpdmUgPSBmYWxzZTtcbiAgICB9LFxuICAgIHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbjogYXN5bmMgKCkgPT4ge1xuICAgICAgcG9zdFZlckNhbGxDb3VudCsrO1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb25cIik7XG4gICAgICAvLyBFeGl0IG9uIHRoZSA0dGggY2FsbCAoYWZ0ZXIgVDAyIHVuaXQgY29tcGxldGVzKVxuICAgICAgY29uc3Qgc2hvdWxkRXhpdCA9IHBvc3RWZXJDYWxsQ291bnQgPj0gNDtcbiAgICAgIHMuYWN0aXZlID0gIXNob3VsZEV4aXQ7XG4gICAgICByZXR1cm4gXCJjb250aW51ZVwiIGFzIGNvbnN0O1xuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGxvb3BQcm9taXNlID0gYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgLy8gUmVzb2x2ZSBhZ2VudF9lbmQgZm9yIGl0ZXJhdGlvbnMgMS00XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgNDsgaSsrKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMzApKTtcbiAgICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpO1xuICB9XG5cbiAgYXdhaXQgbG9vcFByb21pc2U7XG5cbiAgLy8gTGV2ZWwgMSByZWNvdmVyeSBmaXJlcyBvbiBpdGVyYXRpb24gMyAoY2FjaGUgaW52YWxpZGF0aW9uICsgY29udGludWUpLFxuICAvLyB0aGVuIGl0ZXJhdGlvbiA0IGRlcml2ZXMgVDAyIFx1MjAxNCBubyBMZXZlbCAyIGhhcmQgc3RvcC5cbiAgYXNzZXJ0Lm9rKFxuICAgICFzdG9wQ2FsbGVkLFxuICAgIFwic3RvcEF1dG8gc2hvdWxkIE5PVCBoYXZlIGJlZW4gY2FsbGVkIFx1MjAxNCBkaWZmZXJlbnQgdW5pdCBicm9rZSBzdHVjayBwYXR0ZXJuXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBkZXJpdmVDYWxsQ291bnQgPj0gNCxcbiAgICBgZGVyaXZlU3RhdGUgc2hvdWxkIGhhdmUgYmVlbiBjYWxsZWQgYXQgbGVhc3QgNCB0aW1lcyAoZ290ICR7ZGVyaXZlQ2FsbENvdW50fSlgLFxuICApO1xufSk7XG5cbnRlc3QoXCJzdHVjayBkZXRlY3Rpb246IHZlcmlmaWNhdGlvbiByZXRyaWVzIHJlbWFpbiB2aXNpYmxlIHRvIHRoZSBzbGlkaW5nIHdpbmRvd1wiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG4gIG1vY2sudGltZXJzLmVuYWJsZSh7IGFwaXM6IFtcIkRhdGVcIiwgXCJzZXRUaW1lb3V0XCJdLCBub3c6IDIwXzAwMCB9KTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICAgIGN0eC51aS5ub3RpZnkgPSAoKSA9PiB7fTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG5cbiAgICBsZXQgdmVyaWZ5Q2FsbENvdW50ID0gMDtcbiAgICBsZXQgc3RvcFJlYXNvbiA9IFwiXCI7XG5cbiAgICAvLyBQcmUtcXVldWVkIHJlc3BvbnNlczogMyByZXRyaWVzIHRoZW4gYSBjb250aW51ZSAoZXhpdCkuIEZhaWx1cmVcbiAgICAvLyBjb250ZXh0cyBkaWZmZXIgc28gdGhpcyB0ZXN0IGV4ZXJjaXNlcyBzdHVjay13aW5kb3cgYmVoYXZpb3Igd2l0aG91dFxuICAgIC8vIHRyaXBwaW5nIGR1cGxpY2F0ZS1mYWlsdXJlIHN1cHByZXNzaW9uLlxuICAgIGNvbnN0IHZlcmlmeUFjdGlvbnM6IEFycmF5PCgpID0+IFwicmV0cnlcIiB8IFwiY29udGludWVcIj4gPSBbXG4gICAgICAoKSA9PiB7IHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5ID0geyB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsIGZhaWx1cmVDb250ZXh0OiBcInRlc3QgZmFpbGVkOiAxXCIsIGF0dGVtcHQ6IDEgfTsgcmV0dXJuIFwicmV0cnlcIjsgfSxcbiAgICAgICgpID0+IHsgcy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnkgPSB7IHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIiwgZmFpbHVyZUNvbnRleHQ6IFwidGVzdCBmYWlsZWQ6IDJcIiwgYXR0ZW1wdDogMiB9OyByZXR1cm4gXCJyZXRyeVwiOyB9LFxuICAgICAgKCkgPT4geyBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IHsgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLCBmYWlsdXJlQ29udGV4dDogXCJ0ZXN0IGZhaWxlZDogM1wiLCBhdHRlbXB0OiAzIH07IHJldHVybiBcInJldHJ5XCI7IH0sXG4gICAgICAoKSA9PiB7IHMuYWN0aXZlID0gZmFsc2U7IHJldHVybiBcImNvbnRpbnVlXCI7IH0sXG4gICAgXTtcblxuICAgIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+XG4gICAgICAgICh7XG4gICAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiIH0sXG4gICAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgIH0pIGFzIGFueSxcbiAgICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4gKHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICAgIHByb21wdDogXCJkbyB0aGUgdGhpbmdcIixcbiAgICAgIH0pLFxuICAgICAgcnVuUG9zdFVuaXRWZXJpZmljYXRpb246IGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgYWN0aW9uID0gdmVyaWZ5QWN0aW9uc1t2ZXJpZnlDYWxsQ291bnRdID8/ICgoKSA9PiB7IHMuYWN0aXZlID0gZmFsc2U7IHJldHVybiBcImNvbnRpbnVlXCIgYXMgY29uc3Q7IH0pO1xuICAgICAgICB2ZXJpZnlDYWxsQ291bnQrKztcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJydW5Qb3N0VW5pdFZlcmlmaWNhdGlvblwiKTtcbiAgICAgICAgcmV0dXJuIGFjdGlvbigpO1xuICAgICAgfSxcbiAgICAgIHN0b3BBdXRvOiBhc3luYyAoX2N0eD86IGFueSwgX3BpPzogYW55LCByZWFzb24/OiBzdHJpbmcpID0+IHtcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJzdG9wQXV0b1wiKTtcbiAgICAgICAgc3RvcFJlYXNvbiA9IHJlYXNvbiA/PyBcIlwiO1xuICAgICAgICBzLmFjdGl2ZSA9IGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxvb3BQcm9taXNlID0gYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgICAvLyBSZXNvbHZlIGFnZW50X2VuZCBmb3IgMyBhdHRlbXB0cy4gVGhlIDR0aCBpdGVyYXRpb24gc2hvdWxkIHN0b3AgYmVmb3JlXG4gICAgLy8gZGlzcGF0Y2ggYmVjYXVzZSByZXRyeSBkaXNwYXRjaGVzIHN0YXkgdmlzaWJsZSB0byBzdHVjayBkZXRlY3Rpb24uXG4gICAgZm9yIChsZXQgaSA9IDE7IGkgPD0gMzsgaSsrKSB7XG4gICAgICBhd2FpdCB3YWl0Rm9yTWljcm90YXNrcygoKSA9PiBwaS5jYWxscy5sZW5ndGggPT09IGksIGBkaXNwYXRjaCAke2l9YCk7XG4gICAgICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpO1xuICAgICAgYXdhaXQgZHJhaW5NaWNyb3Rhc2tzKDEwMCk7XG4gICAgICBtb2NrLnRpbWVycy50aWNrKDMwXzAwMCk7XG4gICAgfVxuXG4gICAgYXdhaXQgbG9vcFByb21pc2U7XG5cbiAgICBhc3NlcnQub2soXG4gICAgICBzdG9wUmVhc29uLmluY2x1ZGVzKFwiU3R1Y2tcIiksXG4gICAgICBgc3R1Y2sgZGV0ZWN0aW9uIHNob3VsZCBmaXJlIGR1cmluZyByZXBlYXRlZCB2ZXJpZmljYXRpb24gcmV0cmllcywgZ290OiAke3N0b3BSZWFzb259YCxcbiAgICApO1xuICAgIGFzc2VydC5lcXVhbChcbiAgICAgIHZlcmlmeUNhbGxDb3VudCxcbiAgICAgIDMsXG4gICAgICBcInZlcmlmaWNhdGlvbiBzaG91bGQgc3RvcCBiZWZvcmUgYSA0dGggcmVwZWF0ZWQgcmV0cnkgZGlzcGF0Y2hcIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIG1vY2sudGltZXJzLnJlc2V0KCk7XG4gIH1cbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDAgZGV0ZWN0U3R1Y2sgdW5pdCB0ZXN0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcImRldGVjdFN0dWNrOiByZXR1cm5zIG51bGwgZm9yIGZld2VyIHRoYW4gMiBlbnRyaWVzXCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKGRldGVjdFN0dWNrKFtdKSwgbnVsbCk7XG4gIGFzc2VydC5lcXVhbChkZXRlY3RTdHVjayhbeyBrZXk6IFwiQVwiIH1dKSwgbnVsbCk7XG59KTtcblxudGVzdChcImRldGVjdFN0dWNrOiBSdWxlIDEgXHUyMDE0IHNhbWUgZXJyb3IgdHdpY2UgaW4gYSByb3dcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBkZXRlY3RTdHVjayhbXG4gICAgeyBrZXk6IFwiQVwiLCBlcnJvcjogXCJFTk9FTlQ6IGZpbGUgbm90IGZvdW5kXCIgfSxcbiAgICB7IGtleTogXCJBXCIsIGVycm9yOiBcIkVOT0VOVDogZmlsZSBub3QgZm91bmRcIiB9LFxuICBdKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdD8uc3R1Y2ssIFwic2hvdWxkIGRldGVjdCBzYW1lIGVycm9yIHJlcGVhdGVkXCIpO1xuICBhc3NlcnQub2socmVzdWx0Py5yZWFzb24uaW5jbHVkZXMoXCJTYW1lIGVycm9yIHJlcGVhdGVkXCIpKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0U3R1Y2s6IFJ1bGUgMSBcdTIwMTQgZGlmZmVyZW50IGVycm9ycyBkbyBub3QgdHJpZ2dlclwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGRldGVjdFN0dWNrKFtcbiAgICB7IGtleTogXCJBXCIsIGVycm9yOiBcIkVOT0VOVDogZmlsZSBub3QgZm91bmRcIiB9LFxuICAgIHsga2V5OiBcIkFcIiwgZXJyb3I6IFwiRUFDQ0VTOiBwZXJtaXNzaW9uIGRlbmllZFwiIH0sXG4gIF0pO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LCBudWxsKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0U3R1Y2s6IFJ1bGUgMiBcdTIwMTQgc2FtZSB1bml0IDMgY29uc2VjdXRpdmUgdGltZXNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBkZXRlY3RTdHVjayhbXG4gICAgeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH0sXG4gICAgeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH0sXG4gICAgeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH0sXG4gIF0pO1xuICBhc3NlcnQub2socmVzdWx0Py5zdHVjayk7XG4gIGFzc2VydC5vayhyZXN1bHQ/LnJlYXNvbi5pbmNsdWRlcyhcIjMgY29uc2VjdXRpdmUgdGltZXNcIikpO1xufSk7XG5cbnRlc3QoXCJkZXRlY3RTdHVjazogUnVsZSAyIFx1MjAxNCAyIGNvbnNlY3V0aXZlIGRvZXMgbm90IHRyaWdnZXJcIiwgKCkgPT4ge1xuICBhc3NlcnQuZXF1YWwoZGV0ZWN0U3R1Y2soW1xuICAgIHsga2V5OiBcIkFcIiB9LFxuICAgIHsga2V5OiBcIkFcIiB9LFxuICBdKSwgbnVsbCk7XG59KTtcblxudGVzdChcImRldGVjdFN0dWNrOiBSdWxlIDMgXHUyMDE0IG9zY2lsbGF0aW9uIEFcdTIxOTJCXHUyMTkyQVx1MjE5MkJcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBkZXRlY3RTdHVjayhbXG4gICAgeyBrZXk6IFwiQVwiIH0sXG4gICAgeyBrZXk6IFwiQlwiIH0sXG4gICAgeyBrZXk6IFwiQVwiIH0sXG4gICAgeyBrZXk6IFwiQlwiIH0sXG4gIF0pO1xuICBhc3NlcnQub2socmVzdWx0Py5zdHVjayk7XG4gIGFzc2VydC5vayhyZXN1bHQ/LnJlYXNvbi5pbmNsdWRlcyhcIk9zY2lsbGF0aW9uXCIpKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0U3R1Y2s6IFJ1bGUgMyBcdTIwMTQgbm9uLW9zY2lsbGF0aW9uIHBhdHRlcm4gQVx1MjE5MkJcdTIxOTJDXHUyMTkyQlwiLCAoKSA9PiB7XG4gIGFzc2VydC5lcXVhbChkZXRlY3RTdHVjayhbXG4gICAgeyBrZXk6IFwiQVwiIH0sXG4gICAgeyBrZXk6IFwiQlwiIH0sXG4gICAgeyBrZXk6IFwiQ1wiIH0sXG4gICAgeyBrZXk6IFwiQlwiIH0sXG4gIF0pLCBudWxsKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0U3R1Y2s6IFJ1bGUgMSB0YWtlcyBwcmlvcml0eSBvdmVyIFJ1bGUgMiB3aGVuIGJvdGggbWF0Y2hcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBkZXRlY3RTdHVjayhbXG4gICAgeyBrZXk6IFwiQVwiLCBlcnJvcjogXCJ0ZXN0IGVycm9yXCIgfSxcbiAgICB7IGtleTogXCJBXCIsIGVycm9yOiBcInRlc3QgZXJyb3JcIiB9LFxuICAgIHsga2V5OiBcIkFcIiwgZXJyb3I6IFwidGVzdCBlcnJvclwiIH0sXG4gIF0pO1xuICBhc3NlcnQub2socmVzdWx0Py5zdHVjayk7XG4gIC8vIFJ1bGUgMSBmaXJlcyBmaXJzdFxuICBhc3NlcnQub2socmVzdWx0Py5yZWFzb24uaW5jbHVkZXMoXCJTYW1lIGVycm9yIHJlcGVhdGVkXCIpKTtcbn0pO1xuXG50ZXN0KFwiZGV0ZWN0U3R1Y2s6IHRydW5jYXRlcyBsb25nIGVycm9yIHN0cmluZ3NcIiwgKCkgPT4ge1xuICBjb25zdCBsb25nRXJyb3IgPSBcInhcIi5yZXBlYXQoNTAwKTtcbiAgY29uc3QgcmVzdWx0ID0gZGV0ZWN0U3R1Y2soW1xuICAgIHsga2V5OiBcIkFcIiwgZXJyb3I6IGxvbmdFcnJvciB9LFxuICAgIHsga2V5OiBcIkFcIiwgZXJyb3I6IGxvbmdFcnJvciB9LFxuICBdKTtcbiAgYXNzZXJ0Lm9rKHJlc3VsdD8uc3R1Y2spO1xuICBhc3NlcnQub2socmVzdWx0IS5yZWFzb24uaW5jbHVkZXMobG9uZ0Vycm9yLnNsaWNlKDAsIDIwMCkpLCBcInJlYXNvbiBzaG91bGQgaW5jbHVkZSB0aGUgdHJ1bmNhdGVkIGVycm9yIHByZWZpeFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdCEucmVhc29uLmluY2x1ZGVzKGxvbmdFcnJvciksIGZhbHNlLCBcInJlYXNvbiBzaG91bGQgbm90IGluY2x1ZGUgdGhlIGZ1bGwgbG9uZyBlcnJvclwiKTtcbn0pO1xuXG4vLyBOT1RFOiB0aGUgXCJzdHVjay1kZXRlY3RlZFwiIC8gXCJzdHVjay1jb3VudGVyLXJlc2V0XCIgZGVidWctbG9nIGdyZXAgd2FzXG4vLyByZW1vdmVkIFx1MjAxNCB0aGF0IHN0cmluZyB0ZXN0IG5ldmVyIGV4ZXJjaXNlZCB0aGUgZGV0ZWN0b3IuIGRldGVjdFN0dWNrXG4vLyBpdHNlbGYgaXMgdGVzdGVkIGJlaGF2aW91cmFsbHkgYWJvdmUgYWdhaW5zdCB0aGUgcmVhbCBpbXBsZW1lbnRhdGlvblxuLy8gaW1wb3J0ZWQgZnJvbSBhdXRvLWxvb3AuanMuXG5cbi8vIFx1MjUwMFx1MjUwMCBMaWZlY3ljbGUgdGVzdCAoUzA1L1QwMikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJhdXRvTG9vcCBsaWZlY3ljbGU6IGFkdmFuY2VzIHRocm91Z2ggcmVzZWFyY2ggXHUyMTkyIHBsYW4gXHUyMTkyIGV4ZWN1dGUgXHUyMTkyIHZlcmlmeSBcdTIxOTIgY29tcGxldGUgYWNyb3NzIGl0ZXJhdGlvbnNcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGN0eC51aS5zZXRTdGF0dXMgPSAoKSA9PiB7fTtcbiAgY3R4LnVpLm5vdGlmeSA9ICgpID0+IHt9O1xuICBjdHguc2Vzc2lvbk1hbmFnZXIgPSB7IGdldFNlc3Npb25GaWxlOiAoKSA9PiBcIi90bXAvc2Vzc2lvbi5qc29uXCIgfTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oKTtcblxuICBsZXQgZGVyaXZlQ2FsbENvdW50ID0gMDtcbiAgbGV0IGRpc3BhdGNoQ2FsbENvdW50ID0gMDtcbiAgY29uc3QgZGlzcGF0Y2hlZFVuaXRUeXBlczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBQaGFzZSBzZXF1ZW5jZTogZWFjaCBkZXJpdmVTdGF0ZSBjYWxsIHJldHVybnMgYSBkaWZmZXJlbnQgcGhhc2UuXG4gIC8vIFRoZSA2dGggZW50cnkgKGluZGV4IDUpIGlzIHRoZSB0ZXJtaW5hbCBcImNvbXBsZXRlXCIgcGhhc2UgdGhhdCBzdG9wcyB0aGUgbG9vcC5cbiAgY29uc3QgcGhhc2VzID0gW1xuICAgIC8vIENhbGwgMTogcmVzZWFyY2hpbmcgXHUyMTkyIGRpc3BhdGNoZXMgcmVzZWFyY2gtc2xpY2VcbiAgICB7XG4gICAgICBwaGFzZTogXCJyZXNlYXJjaGluZ1wiLFxuICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlJlc2VhcmNoIFNsaWNlXCIgfSxcbiAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgfSxcbiAgICAvLyBDYWxsIDI6IHBsYW5uaW5nIFx1MjE5MiBkaXNwYXRjaGVzIHBsYW4tc2xpY2VcbiAgICB7XG4gICAgICBwaGFzZTogXCJwbGFubmluZ1wiLFxuICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlBsYW4gU2xpY2VcIiB9LFxuICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICB9LFxuICAgIC8vIENhbGwgMzogZXhlY3V0aW5nIFx1MjE5MiBkaXNwYXRjaGVzIGV4ZWN1dGUtdGFza1xuICAgIHtcbiAgICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkV4ZWN1dGUgU2xpY2VcIiB9LFxuICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgIH0sXG4gICAgLy8gQ2FsbCA0OiB2ZXJpZnlpbmcgXHUyMTkyIGRpc3BhdGNoZXMgdmVyaWZ5LXNsaWNlXG4gICAge1xuICAgICAgcGhhc2U6IFwidmVyaWZ5aW5nXCIsXG4gICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiVmVyaWZ5IFNsaWNlXCIgfSxcbiAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgfSxcbiAgICAvLyBDYWxsIDU6IGNvbXBsZXRpbmcgXHUyMTkyIGRpc3BhdGNoZXMgY29tcGxldGUtc2xpY2VcbiAgICB7XG4gICAgICBwaGFzZTogXCJjb21wbGV0aW5nXCIsXG4gICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiQ29tcGxldGUgU2xpY2VcIiB9LFxuICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICB9LFxuICAgIC8vIENhbGwgNjogdGVybWluYWwgXHUyMDE0IGRlYWN0aXZhdGUgdG8gZXhpdCB0aGUgbG9vcFxuICAgIHtcbiAgICAgIHBoYXNlOiBcImNvbXBsZXRlXCIsXG4gICAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgfSxcbiAgXTtcblxuICBjb25zdCBkaXNwYXRjaGVzID0gW1xuICAgIHsgdW5pdFR5cGU6IFwicmVzZWFyY2gtc2xpY2VcIiwgdW5pdElkOiBcIk0wMDEvUzAxXCIsIHByb21wdDogXCJyZXNlYXJjaFwiIH0sXG4gICAgeyB1bml0VHlwZTogXCJwbGFuLXNsaWNlXCIsIHVuaXRJZDogXCJNMDAxL1MwMVwiLCBwcm9tcHQ6IFwicGxhblwiIH0sXG4gICAgeyB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIiwgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLCBwcm9tcHQ6IFwiZXhlY3V0ZVwiIH0sXG4gICAgeyB1bml0VHlwZTogXCJydW4tdWF0XCIsIHVuaXRJZDogXCJNMDAxL1MwMVwiLCBwcm9tcHQ6IFwidmVyaWZ5XCIgfSxcbiAgICB7IHVuaXRUeXBlOiBcImNvbXBsZXRlLXNsaWNlXCIsIHVuaXRJZDogXCJNMDAxL1MwMVwiLCBwcm9tcHQ6IFwiY29tcGxldGVcIiB9LFxuICBdO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBwID0gcGhhc2VzW01hdGgubWluKGRlcml2ZUNhbGxDb3VudCwgcGhhc2VzLmxlbmd0aCAtIDEpXTtcbiAgICAgIGRlcml2ZUNhbGxDb3VudCsrO1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJkZXJpdmVTdGF0ZVwiKTtcblxuICAgICAgY29uc3QgdGVybWluYWxQaGFzZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IGNvbXBsZXRlOiBcImNvbXBsZXRlXCIgfTtcbiAgICAgIHMuYWN0aXZlID0gcC5waGFzZSAhPT0gXCJjb21wbGV0ZVwiO1xuICAgICAgY29uc3QgbWlsZXN0b25lU3RhdHVzID0gdGVybWluYWxQaGFzZXNbcC5waGFzZV0gPz8gXCJhY3RpdmVcIjtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHBoYXNlOiBwLnBoYXNlLFxuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogbWlsZXN0b25lU3RhdHVzIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiBwLmFjdGl2ZVNsaWNlID8/IG51bGwsXG4gICAgICAgIGFjdGl2ZVRhc2s6IHAuYWN0aXZlVGFzayA/PyBudWxsLFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IG1pbGVzdG9uZVN0YXR1cyB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgfSBhcyBhbnk7XG4gICAgfSxcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IGQgPSBkaXNwYXRjaGVzW01hdGgubWluKGRpc3BhdGNoQ2FsbENvdW50LCBkaXNwYXRjaGVzLmxlbmd0aCAtIDEpXTtcbiAgICAgIGRpc3BhdGNoQ2FsbENvdW50Kys7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcInJlc29sdmVEaXNwYXRjaFwiKTtcbiAgICAgIGRpc3BhdGNoZWRVbml0VHlwZXMucHVzaChkLnVuaXRUeXBlKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiIGFzIGNvbnN0LFxuICAgICAgICB1bml0VHlwZTogZC51bml0VHlwZSxcbiAgICAgICAgdW5pdElkOiBkLnVuaXRJZCxcbiAgICAgICAgcHJvbXB0OiBkLnByb21wdCxcbiAgICAgIH07XG4gICAgfSxcbiAgICBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb246IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIpO1xuICAgICAgcmV0dXJuIFwiY29udGludWVcIiBhcyBjb25zdDtcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBsb29wUHJvbWlzZSA9IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gIC8vIFJlc29sdmUgZWFjaCBpdGVyYXRpb24ncyBhZ2VudF9lbmQgXHUyMDE0IDUgaXRlcmF0aW9ucywgZWFjaCBkaXNwYXRjaGVzIGEgdW5pdFxuICBmb3IgKGxldCBpID0gMDsgaSA8IDU7IGkrKykge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDMwKSk7XG4gICAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcbiAgfVxuXG4gIGF3YWl0IGxvb3BQcm9taXNlO1xuXG4gIC8vIEFzc2VydCBkZXJpdmVTdGF0ZSB3YXMgY2FsbGVkIGF0IGxlYXN0IDUgdGltZXMgKG9uY2UgcGVyIGl0ZXJhdGlvbilcbiAgYXNzZXJ0Lm9rKFxuICAgIGRlcml2ZUNhbGxDb3VudCA+PSA1LFxuICAgIGBkZXJpdmVTdGF0ZSBzaG91bGQgYmUgY2FsbGVkIGF0IGxlYXN0IDUgdGltZXMgKGdvdCAke2Rlcml2ZUNhbGxDb3VudH0pYCxcbiAgKTtcblxuICAvLyBBc3NlcnQgdGhlIGRpc3BhdGNoZWQgdW5pdCB0eXBlcyBjb3ZlciB0aGUgZnVsbCBsaWZlY3ljbGUgc2VxdWVuY2VcbiAgYXNzZXJ0Lm9rKFxuICAgIGRpc3BhdGNoZWRVbml0VHlwZXMuaW5jbHVkZXMoXCJyZXNlYXJjaC1zbGljZVwiKSxcbiAgICBgc2hvdWxkIGhhdmUgZGlzcGF0Y2hlZCByZXNlYXJjaC1zbGljZSwgZ290OiAke2Rpc3BhdGNoZWRVbml0VHlwZXMuam9pbihcIiwgXCIpfWAsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBkaXNwYXRjaGVkVW5pdFR5cGVzLmluY2x1ZGVzKFwicGxhbi1zbGljZVwiKSxcbiAgICBgc2hvdWxkIGhhdmUgZGlzcGF0Y2hlZCBwbGFuLXNsaWNlLCBnb3Q6ICR7ZGlzcGF0Y2hlZFVuaXRUeXBlcy5qb2luKFwiLCBcIil9YCxcbiAgKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIGRpc3BhdGNoZWRVbml0VHlwZXMuaW5jbHVkZXMoXCJleGVjdXRlLXRhc2tcIiksXG4gICAgYHNob3VsZCBoYXZlIGRpc3BhdGNoZWQgZXhlY3V0ZS10YXNrLCBnb3Q6ICR7ZGlzcGF0Y2hlZFVuaXRUeXBlcy5qb2luKFwiLCBcIil9YCxcbiAgKTtcbiAgYXNzZXJ0Lm9rKFxuICAgIGRpc3BhdGNoZWRVbml0VHlwZXMuaW5jbHVkZXMoXCJydW4tdWF0XCIpLFxuICAgIGBzaG91bGQgaGF2ZSBkaXNwYXRjaGVkIHJ1bi11YXQsIGdvdDogJHtkaXNwYXRjaGVkVW5pdFR5cGVzLmpvaW4oXCIsIFwiKX1gLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgZGlzcGF0Y2hlZFVuaXRUeXBlcy5pbmNsdWRlcyhcImNvbXBsZXRlLXNsaWNlXCIpLFxuICAgIGBzaG91bGQgaGF2ZSBkaXNwYXRjaGVkIGNvbXBsZXRlLXNsaWNlLCBnb3Q6ICR7ZGlzcGF0Y2hlZFVuaXRUeXBlcy5qb2luKFwiLCBcIil9YCxcbiAgKTtcblxuICAvLyBBc3NlcnQgY2FsbCBzZXF1ZW5jZTogZGVyaXZlU3RhdGUgYW5kIHJlc29sdmVEaXNwYXRjaCBlbnRyaWVzIGFyZSBpbnRlcmxlYXZlZFxuICBjb25zdCBkZXJpdmVFbnRyaWVzID0gZGVwcy5jYWxsTG9nLmZpbHRlcigoYykgPT4gYyA9PT0gXCJkZXJpdmVTdGF0ZVwiKTtcbiAgY29uc3QgZGlzcGF0Y2hFbnRyaWVzID0gZGVwcy5jYWxsTG9nLmZpbHRlcigoYykgPT4gYyA9PT0gXCJyZXNvbHZlRGlzcGF0Y2hcIik7XG4gIGFzc2VydC5vayhcbiAgICBkZXJpdmVFbnRyaWVzLmxlbmd0aCA+PSA1LFxuICAgIGBjYWxsTG9nIHNob3VsZCBoYXZlIGF0IGxlYXN0IDUgZGVyaXZlU3RhdGUgZW50cmllcyAoZ290ICR7ZGVyaXZlRW50cmllcy5sZW5ndGh9KWAsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBkaXNwYXRjaEVudHJpZXMubGVuZ3RoID49IDUsXG4gICAgYGNhbGxMb2cgc2hvdWxkIGhhdmUgYXQgbGVhc3QgNSByZXNvbHZlRGlzcGF0Y2ggZW50cmllcyAoZ290ICR7ZGlzcGF0Y2hFbnRyaWVzLmxlbmd0aH0pYCxcbiAgKTtcblxuICAvLyBWZXJpZnkgaW50ZXJsZWF2aW5nOiBhIGRlcml2ZVN0YXRlIG11c3QgZm9sbG93IGEgcmVzb2x2ZURpc3BhdGNoIChjb25maXJtcyBsb29wIGFkdmFuY2VkKVxuICBjb25zdCBmaXJzdERpc3BhdGNoSWR4ID0gZGVwcy5jYWxsTG9nLmluZGV4T2YoXCJyZXNvbHZlRGlzcGF0Y2hcIik7XG4gIGNvbnN0IGZpcnN0RGVyaXZlQWZ0ZXJEaXNwYXRjaCA9IGRlcHMuY2FsbExvZy5pbmRleE9mKFwiZGVyaXZlU3RhdGVcIiwgZmlyc3REaXNwYXRjaElkeCArIDEpO1xuICBhc3NlcnQub2soZmlyc3REaXNwYXRjaElkeCA+PSAwLCBcInJlc29sdmVEaXNwYXRjaCBzaG91bGQgYXBwZWFyIGluIGNhbGxMb2dcIik7XG4gIGFzc2VydC5vayhmaXJzdERlcml2ZUFmdGVyRGlzcGF0Y2ggPiBmaXJzdERpc3BhdGNoSWR4LCBcImRlcml2ZVN0YXRlIHNob3VsZCBmb2xsb3cgcmVzb2x2ZURpc3BhdGNoIHRvIGNvbmZpcm0gbG9vcCBhZHZhbmNlZFwiKTtcblxuICAvLyBBc3NlcnQgdGhlIGV4YWN0IHNlcXVlbmNlIG9mIGRpc3BhdGNoZWQgdW5pdCB0eXBlc1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGRpc3BhdGNoZWRVbml0VHlwZXMsXG4gICAgW1xuICAgICAgXCJyZXNlYXJjaC1zbGljZVwiLFxuICAgICAgXCJwbGFuLXNsaWNlXCIsXG4gICAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgXCJydW4tdWF0XCIsXG4gICAgICBcImNvbXBsZXRlLXNsaWNlXCIsXG4gICAgXSxcbiAgICBcImRpc3BhdGNoZWQgdW5pdCB0eXBlcyBzaG91bGQgZm9sbG93IHRoZSBmdWxsIGxpZmVjeWNsZSBzZXF1ZW5jZVwiLFxuICApO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZXNvbHZlQWdlbnRFbmRDYW5jZWxsZWQgdGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJyZXNvbHZlQWdlbnRFbmRDYW5jZWxsZWQgcmVzb2x2ZXMgYSBwZW5kaW5nIHByb21pc2Ugd2l0aCBjYW5jZWxsZWQgc3RhdHVzXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3QgcyA9IG1ha2VNb2NrU2Vzc2lvbigpO1xuXG4gIGNvbnN0IHJlc3VsdFByb21pc2UgPSBydW5Vbml0KGN0eCwgcGksIHMsIFwidGFza1wiLCBcIlQwMVwiLCBcInByb21wdFwiKTtcblxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuXG4gIHJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCgpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc3VsdFByb21pc2U7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImNhbmNlbGxlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5ldmVudCwgdW5kZWZpbmVkKTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkIGlzIGEgbm8tb3Agd2hlbiBubyBwcm9taXNlIGlzIHBlbmRpbmdcIiwgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGFzc2VydC5kb2VzTm90VGhyb3coKCkgPT4ge1xuICAgIHJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCgpO1xuICB9KTtcbn0pO1xuXG50ZXN0KFwicmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkIHByZXZlbnRzIG9ycGhhbmVkIHByb21pc2UgYWZ0ZXIgYWJvcnQgcGF0aFwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24oKTtcblxuICBjb25zdCByZXN1bHRQcm9taXNlID0gcnVuVW5pdChjdHgsIHBpLCBzLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJwcm9tcHRcIik7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTApKTtcblxuICBzLmFjdGl2ZSA9IGZhbHNlO1xuICByZXNvbHZlQWdlbnRFbmRDYW5jZWxsZWQoKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXN1bHRQcm9taXNlO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnN0YXR1cywgXCJjYW5jZWxsZWRcIik7XG59KTtcblxudGVzdChcInJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCB3aXRoIGVycm9yQ29udGV4dCBwYXNzZXMgaXQgdGhyb3VnaCB0byByZXNvbHZlZCBwcm9taXNlXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCB7IF9zZXRDdXJyZW50UmVzb2x2ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by9yZXNvbHZlLmpzXCIpO1xuXG4gIGNvbnN0IHAgPSBuZXcgUHJvbWlzZTxVbml0UmVzdWx0PigocikgPT4ge1xuICAgIF9zZXRDdXJyZW50UmVzb2x2ZShyKTtcbiAgfSk7XG5cbiAgcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkKHsgbWVzc2FnZTogXCJ0ZXN0IHRpbWVvdXRcIiwgY2F0ZWdvcnk6IFwidGltZW91dFwiLCBpc1RyYW5zaWVudDogdHJ1ZSB9KTtcblxuICBjb25zdCByZXNvbHZlZCA9IGF3YWl0IHA7XG4gIGFzc2VydC5lcXVhbChyZXNvbHZlZC5zdGF0dXMsIFwiY2FuY2VsbGVkXCIpO1xuICBhc3NlcnQub2socmVzb2x2ZWQuZXJyb3JDb250ZXh0LCBcImVycm9yQ29udGV4dCBtdXN0IGJlIHByZXNlbnRcIik7XG4gIGFzc2VydC5lcXVhbChyZXNvbHZlZC5lcnJvckNvbnRleHQhLmNhdGVnb3J5LCBcInRpbWVvdXRcIik7XG4gIGFzc2VydC5lcXVhbChyZXNvbHZlZC5lcnJvckNvbnRleHQhLm1lc3NhZ2UsIFwidGVzdCB0aW1lb3V0XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzb2x2ZWQuZXJyb3JDb250ZXh0IS5pc1RyYW5zaWVudCwgdHJ1ZSk7XG59KTtcblxudGVzdChcInJ1blVuaXRQaGFzZSBwYXVzZXMgdHJhbnNpZW50IGFib3J0ZWQgY2FuY2VsbGF0aW9ucyBpbnN0ZWFkIG9mIGhhcmQtc3RvcHBpbmdcIiwgYXN5bmMgKHQpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWFib3J0ZWQtY2FuY2VsLVwiKSk7XG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBjb25zdCBjdHggPSB7XG4gICAgLi4ubWFrZU1vY2tDdHgoKSxcbiAgICB1aToge1xuICAgICAgbm90aWZ5OiAoKSA9PiB7fSxcbiAgICAgIHNldFN0YXR1czogKCkgPT4ge30sXG4gICAgICBzZXRXb3JraW5nTWVzc2FnZTogKCkgPT4ge30sXG4gICAgfSxcbiAgICBzZXNzaW9uTWFuYWdlcjoge1xuICAgICAgZ2V0RW50cmllczogKCkgPT4gW10sXG4gICAgfSxcbiAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICBnZXRQcm92aWRlckF1dGhNb2RlOiAoKSA9PiB1bmRlZmluZWQsXG4gICAgICBpc1Byb3ZpZGVyUmVxdWVzdFJlYWR5OiAoKSA9PiB0cnVlLFxuICAgIH0sXG4gIH0gYXMgYW55O1xuICBjb25zdCBwaSA9IHtcbiAgICAuLi5tYWtlTW9ja1BpKCksXG4gICAgc2VuZE1lc3NhZ2U6ICgpID0+IHtcbiAgICAgIHF1ZXVlTWljcm90YXNrKCgpID0+IHJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCh7XG4gICAgICAgIG1lc3NhZ2U6IFwiQ2xhdWRlIENvZGUgcHJvY2VzcyBhYm9ydGVkIGJ5IHVzZXJcIixcbiAgICAgICAgY2F0ZWdvcnk6IFwiYWJvcnRlZFwiLFxuICAgICAgICBpc1RyYW5zaWVudDogdHJ1ZSxcbiAgICAgIH0pKTtcbiAgICB9LFxuICB9IGFzIGFueTtcbiAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbih7XG4gICAgYmFzZVBhdGgsXG4gICAgY2Fub25pY2FsUHJvamVjdFJvb3Q6IGJhc2VQYXRoLFxuICAgIG9yaWdpbmFsQmFzZVBhdGg6IGJhc2VQYXRoLFxuICB9KTtcbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcygpO1xuICBsZXQgc2VxID0gMDtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5Vbml0UGhhc2UoXG4gICAgeyBjdHgsIHBpLCBzLCBkZXBzLCBwcmVmczogdW5kZWZpbmVkLCBpdGVyYXRpb246IDEsIGZsb3dJZDogXCJmbG93LWFib3J0ZWRcIiwgbmV4dFNlcTogKCkgPT4gKytzZXEgfSxcbiAgICB7XG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHByb21wdDogXCJkbyB3b3JrXCIsXG4gICAgICBmaW5hbFByb21wdDogXCJkbyB3b3JrXCIsXG4gICAgICBwYXVzZUFmdGVyVWF0RGlzcGF0Y2g6IGZhbHNlLFxuICAgICAgc3RhdGU6IHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk1pbGVzdG9uZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZVwiIH0sXG4gICAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIlRhc2tcIiB9LFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgIG5leHRBY3Rpb246IFwiXCIsXG4gICAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IHsgZG9uZTogMCwgdG90YWw6IDEgfSB9LFxuICAgICAgICByZXF1aXJlbWVudHM6IHsgYWN0aXZlOiAwLCB2YWxpZGF0ZWQ6IDAsIGRlZmVycmVkOiAwLCBvdXRPZlNjb3BlOiAwLCBibG9ja2VkOiAwLCB0b3RhbDogMCB9LFxuICAgICAgfSBhcyBhbnksXG4gICAgICBtaWQ6IFwiTTAwMVwiLFxuICAgICAgbWlkVGl0bGU6IFwiTWlsZXN0b25lXCIsXG4gICAgICBpc1JldHJ5OiBmYWxzZSxcbiAgICAgIHByZXZpb3VzVGllcjogdW5kZWZpbmVkLFxuICAgIH0sXG4gICAgeyByZWNlbnRVbml0czogW3sga2V5OiBcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIiB9XSwgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLCBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAgfSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJicmVha1wiKTtcbiAgYXNzZXJ0LmVxdWFsKChyZXN1bHQgYXMgYW55KS5yZWFzb24sIFwidW5pdC1hYm9ydGVkLXBhdXNlXCIpO1xuICBhc3NlcnQuZXF1YWwoZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicGF1c2VBdXRvXCIpLCB0cnVlKTtcbiAgYXNzZXJ0LmVxdWFsKGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInN0b3BBdXRvXCIpLCBmYWxzZSk7XG59KTtcblxudGVzdChcInJ1blVuaXRQaGFzZSBwYXVzZXMgZ2hvc3QgY29tcGxldGlvbnMgYmVmb3JlIGNsb3Nlb3V0IGFuZCBmaW5hbGl6ZSBzaWRlIGVmZmVjdHNcIiwgYXN5bmMgKHQpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLWdob3N0LWNvbXBsZXRpb24tXCIpKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgbGV0IGNsb3Nlb3V0Q2FsbHMgPSAwO1xuICBsZXQgcHJlVmVyaWZpY2F0aW9uQ2FsbHMgPSAwO1xuICBsZXQgcG9zdFZlcmlmaWNhdGlvbkNhbGxzID0gMDtcbiAgY29uc3Qgam91cm5hbEV2ZW50czogYW55W10gPSBbXTtcbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgY2xvc2VvdXRVbml0OiBhc3luYyAoKSA9PiB7XG4gICAgICBjbG9zZW91dENhbGxzKys7XG4gICAgfSxcbiAgICBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbjogYXN5bmMgKCkgPT4ge1xuICAgICAgcHJlVmVyaWZpY2F0aW9uQ2FsbHMrKztcbiAgICAgIHJldHVybiBcImNvbnRpbnVlXCI7XG4gICAgfSxcbiAgICBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb246IGFzeW5jICgpID0+IHtcbiAgICAgIHBvc3RWZXJpZmljYXRpb25DYWxscysrO1xuICAgICAgcmV0dXJuIFwiY29udGludWVcIjtcbiAgICB9LFxuICAgIGVtaXRKb3VybmFsRXZlbnQ6IChldmVudDogYW55KSA9PiB7XG4gICAgICBqb3VybmFsRXZlbnRzLnB1c2goZXZlbnQpO1xuICAgIH0sXG4gIH0pO1xuICBjb25zdCBjdHggPSB7XG4gICAgLi4ubWFrZU1vY2tDdHgoKSxcbiAgICB1aToge1xuICAgICAgbm90aWZ5OiAoKSA9PiB7fSxcbiAgICAgIHNldFN0YXR1czogKCkgPT4ge30sXG4gICAgICBzZXRXb3JraW5nTWVzc2FnZTogKCkgPT4ge30sXG4gICAgfSxcbiAgICBzZXNzaW9uTWFuYWdlcjoge1xuICAgICAgZ2V0RW50cmllczogKCkgPT4gW10sXG4gICAgfSxcbiAgICBtb2RlbFJlZ2lzdHJ5OiB7XG4gICAgICBnZXRQcm92aWRlckF1dGhNb2RlOiAoKSA9PiB1bmRlZmluZWQsXG4gICAgICBpc1Byb3ZpZGVyUmVxdWVzdFJlYWR5OiAoKSA9PiB0cnVlLFxuICAgIH0sXG4gIH0gYXMgYW55O1xuICBjb25zdCBwaSA9IHtcbiAgICAuLi5tYWtlTW9ja1BpKCksXG4gICAgc2VuZE1lc3NhZ2U6ICgpID0+IHtcbiAgICAgIHF1ZXVlTWljcm90YXNrKCgpID0+IHJlc29sdmVBZ2VudEVuZCh7IG1lc3NhZ2VzOiBbXSB9KSk7XG4gICAgfSxcbiAgfSBhcyBhbnk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oe1xuICAgIGJhc2VQYXRoLFxuICAgIGNhbm9uaWNhbFByb2plY3RSb290OiBiYXNlUGF0aCxcbiAgICBvcmlnaW5hbEJhc2VQYXRoOiBiYXNlUGF0aCxcbiAgfSk7XG4gIGxldCBzZXEgPSAwO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blVuaXRQaGFzZShcbiAgICB7IGN0eCwgcGksIHMsIGRlcHMsIHByZWZzOiB1bmRlZmluZWQsIGl0ZXJhdGlvbjogMSwgZmxvd0lkOiBcImZsb3ctZ2hvc3RcIiwgbmV4dFNlcTogKCkgPT4gKytzZXEgfSxcbiAgICB7XG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHByb21wdDogXCJkbyB3b3JrXCIsXG4gICAgICBmaW5hbFByb21wdDogXCJkbyB3b3JrXCIsXG4gICAgICBwYXVzZUFmdGVyVWF0RGlzcGF0Y2g6IGZhbHNlLFxuICAgICAgc3RhdGU6IHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk1pbGVzdG9uZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZVwiIH0sXG4gICAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIlRhc2tcIiB9LFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJNaWxlc3RvbmVcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgIG5leHRBY3Rpb246IFwiXCIsXG4gICAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IHsgZG9uZTogMCwgdG90YWw6IDEgfSB9LFxuICAgICAgICByZXF1aXJlbWVudHM6IHsgYWN0aXZlOiAwLCB2YWxpZGF0ZWQ6IDAsIGRlZmVycmVkOiAwLCBvdXRPZlNjb3BlOiAwLCBibG9ja2VkOiAwLCB0b3RhbDogMCB9LFxuICAgICAgfSBhcyBhbnksXG4gICAgICBtaWQ6IFwiTTAwMVwiLFxuICAgICAgbWlkVGl0bGU6IFwiTWlsZXN0b25lXCIsXG4gICAgICBpc1JldHJ5OiBmYWxzZSxcbiAgICAgIHByZXZpb3VzVGllcjogdW5kZWZpbmVkLFxuICAgIH0sXG4gICAgeyByZWNlbnRVbml0czogW10sIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCwgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiYnJlYWtcIik7XG4gIGFzc2VydC5lcXVhbCgocmVzdWx0IGFzIGFueSkucmVhc29uLCBcImdob3N0LWNvbXBsZXRpb25cIik7XG4gIGFzc2VydC5lcXVhbChkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJwYXVzZUF1dG9cIiksIHRydWUpO1xuICBhc3NlcnQuZXF1YWwoY2xvc2VvdXRDYWxscywgMCk7XG4gIGFzc2VydC5lcXVhbChwcmVWZXJpZmljYXRpb25DYWxscywgMCk7XG4gIGFzc2VydC5lcXVhbChwb3N0VmVyaWZpY2F0aW9uQ2FsbHMsIDApO1xuICBhc3NlcnQuZXF1YWwocy5jdXJyZW50VW5pdCwgbnVsbCk7XG4gIGFzc2VydC5vayhcbiAgICBqb3VybmFsRXZlbnRzLnNvbWUoKGV2ZW50KSA9PlxuICAgICAgZXZlbnQuZXZlbnRUeXBlID09PSBcInVuaXQtZW5kXCIgJiZcbiAgICAgIGV2ZW50LmRhdGE/LnN0YXR1cyA9PT0gXCJjYW5jZWxsZWRcIiAmJlxuICAgICAgZXZlbnQuZGF0YT8uZXJyb3JDb250ZXh0Py5tZXNzYWdlLmluY2x1ZGVzKFwic3RhbGUgZ2hvc3QgY29tcGxldGlvblwiKVxuICAgICksXG4gICAgXCJnaG9zdCBjb21wbGV0aW9uIHNob3VsZCBlbWl0IGEgY2FuY2VsbGVkIHVuaXQtZW5kXCIsXG4gICk7XG59KTtcblxudGVzdChcInJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCB3aXRob3V0IGFyZ3MgcHJvZHVjZXMgbm8gZXJyb3JDb250ZXh0IGZpZWxkXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCB7IF9zZXRDdXJyZW50UmVzb2x2ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by9yZXNvbHZlLmpzXCIpO1xuXG4gIGNvbnN0IHAgPSBuZXcgUHJvbWlzZTxVbml0UmVzdWx0PigocikgPT4ge1xuICAgIF9zZXRDdXJyZW50UmVzb2x2ZShyKTtcbiAgfSk7XG5cbiAgcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkKCk7XG5cbiAgY29uc3QgcmVzb2x2ZWQgPSBhd2FpdCBwO1xuICBhc3NlcnQuZXF1YWwocmVzb2x2ZWQuc3RhdHVzLCBcImNhbmNlbGxlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc29sdmVkLmVycm9yQ29udGV4dCwgdW5kZWZpbmVkLCBcImVycm9yQ29udGV4dCBtdXN0IG5vdCBiZSBwcmVzZW50IHdoZW4gbm8gYXJncyBwYXNzZWRcIik7XG59KTtcblxudGVzdChcInJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCBxdWV1ZXMgY2FuY2VsbGF0aW9uIHRoYXQgYXJyaXZlcyBkdXJpbmcgc2Vzc2lvbiBzd2l0Y2hcIiwgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIF9zZXRTZXNzaW9uU3dpdGNoSW5GbGlnaHQodHJ1ZSk7XG4gIGNvbnN0IHJlc29sdmVkID0gcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkKHtcbiAgICBtZXNzYWdlOiBcIkNsYXVkZSBDb2RlIHByb2Nlc3MgYWJvcnRlZCBieSB1c2VyXCIsXG4gICAgY2F0ZWdvcnk6IFwiYWJvcnRlZFwiLFxuICAgIGlzVHJhbnNpZW50OiBmYWxzZSxcbiAgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc29sdmVkLCBmYWxzZSk7XG4gIGNvbnN0IHBlbmRpbmcgPSBfY29uc3VtZVBlbmRpbmdTd2l0Y2hDYW5jZWxsYXRpb24oKTtcbiAgYXNzZXJ0Lm9rKHBlbmRpbmc/LmVycm9yQ29udGV4dCwgXCJxdWV1ZWQgY2FuY2VsbGF0aW9uIHNob3VsZCBwcmVzZXJ2ZSBlcnJvckNvbnRleHRcIik7XG4gIGFzc2VydC5lcXVhbChwZW5kaW5nLmVycm9yQ29udGV4dC5jYXRlZ29yeSwgXCJhYm9ydGVkXCIpO1xuICBhc3NlcnQuZXF1YWwocGVuZGluZy5lcnJvckNvbnRleHQubWVzc2FnZSwgXCJDbGF1ZGUgQ29kZSBwcm9jZXNzIGFib3J0ZWQgYnkgdXNlclwiKTtcbiAgYXNzZXJ0LmVxdWFsKF9jb25zdW1lUGVuZGluZ1N3aXRjaENhbmNlbGxhdGlvbigpLCBudWxsKTtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcbn0pO1xuXG50ZXN0KFwic2Vzc2lvbi1zd2l0Y2ggYWJvcnQgZ3JhY2Ugd2luZG93IGlzIHNob3J0LWxpdmVkIGFuZCByZXNldHRhYmxlXCIsICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBfbWFya1Nlc3Npb25Td2l0Y2hBYm9ydEdyYWNlV2luZG93KDFfMDAwKTtcblxuICBhc3NlcnQuZXF1YWwoaXNTZXNzaW9uU3dpdGNoQWJvcnRHcmFjZUFjdGl2ZShEYXRlLm5vdygpKSwgdHJ1ZSk7XG4gIGFzc2VydC5lcXVhbChpc1Nlc3Npb25Td2l0Y2hBYm9ydEdyYWNlQWN0aXZlKERhdGUubm93KCkgKyAxMF8wMDApLCBmYWxzZSk7XG5cbiAgX2NsZWFyU2Vzc2lvblN3aXRjaEFib3J0R3JhY2VXaW5kb3coKTtcbiAgYXNzZXJ0LmVxdWFsKGlzU2Vzc2lvblN3aXRjaEFib3J0R3JhY2VBY3RpdmUoKSwgZmFsc2UpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCAjMTU3MTogYXJ0aWZhY3QgdmVyaWZpY2F0aW9uIHJldHJ5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiYXV0b0xvb3AgcmUtaXRlcmF0ZXMgd2hlbiBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbiByZXR1cm5zIHJldHJ5ICgjMTU3MSlcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuICBtb2NrLnRpbWVycy5lbmFibGUoeyBhcGlzOiBbXCJEYXRlXCIsIFwic2V0VGltZW91dFwiXSwgbm93OiAzMF8wMDAgfSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGN0eC51aS5zZXRTdGF0dXMgPSAoKSA9PiB7fTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG5cbiAgICBsZXQgcHJlVmVyaWZ5Q2FsbENvdW50ID0gMDtcbiAgICAvLyBQcmUtcXVldWVkIHJlc3BvbnNlczogZmlyc3QgY2FsbCByZXR1cm5zIFwicmV0cnlcIiwgc2Vjb25kIHJldHVybnMgXCJjb250aW51ZVwiXG4gICAgY29uc3QgcHJlVmVyaWZ5UmVzcG9uc2VzID0gW1wicmV0cnlcIiwgXCJjb250aW51ZVwiXSBhcyBjb25zdDtcblxuICAgIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IHtcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJkZXJpdmVTdGF0ZVwiKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIgfSxcbiAgICAgICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgICAgfSBhcyBhbnk7XG4gICAgICB9LFxuICAgICAgcG9zdFVuaXRQcmVWZXJpZmljYXRpb246IGFzeW5jICgpID0+IHtcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJwb3N0VW5pdFByZVZlcmlmaWNhdGlvblwiKTtcbiAgICAgICAgY29uc3QgcmVzcG9uc2UgPSBwcmVWZXJpZnlSZXNwb25zZXNbcHJlVmVyaWZ5Q2FsbENvdW50KytdID8/IFwiY29udGludWVcIjtcbiAgICAgICAgaWYgKHJlc3BvbnNlID09PSBcInJldHJ5XCIpIHtcbiAgICAgICAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IHtcbiAgICAgICAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgICAgICAgIGZhaWx1cmVDb250ZXh0OiBcIm1pc3NpbmcgYXJ0aWZhY3RcIixcbiAgICAgICAgICAgIGF0dGVtcHQ6IDEsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzcG9uc2U7XG4gICAgICB9LFxuICAgICAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIpO1xuICAgICAgICBzLmFjdGl2ZSA9IGZhbHNlO1xuICAgICAgICByZXR1cm4gXCJjb250aW51ZVwiIGFzIGNvbnN0O1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxvb3BQcm9taXNlID0gYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgICBhd2FpdCB3YWl0Rm9yTWljcm90YXNrcygoKSA9PiBwaS5jYWxscy5sZW5ndGggPT09IDEsIFwiZmlyc3QgZGlzcGF0Y2hcIik7XG4gICAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcblxuICAgIGF3YWl0IGRyYWluTWljcm90YXNrcygxMDApO1xuICAgIG1vY2sudGltZXJzLnRpY2soMzBfMDAwKTtcbiAgICBhd2FpdCB3YWl0Rm9yTWljcm90YXNrcygoKSA9PiBwaS5jYWxscy5sZW5ndGggPT09IDIsIFwicmV0cnkgZGlzcGF0Y2hcIik7XG4gICAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudCgpKTtcblxuICAgIGF3YWl0IGxvb3BQcm9taXNlO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHByZVZlcmlmeUNhbGxDb3VudCwgMiwgXCJwcmVWZXJpZmljYXRpb24gc2hvdWxkIGJlIGNhbGxlZCB0d2ljZVwiKTtcblxuICAgIGNvbnN0IHBvc3RWZXJpZnlDYWxscyA9IGRlcHMuY2FsbExvZy5maWx0ZXIoXG4gICAgICAoYzogc3RyaW5nKSA9PiBjID09PSBcInJ1blBvc3RVbml0VmVyaWZpY2F0aW9uXCIsXG4gICAgKTtcbiAgICBjb25zdCBwb3N0UG9zdFZlcmlmeUNhbGxzID0gZGVwcy5jYWxsTG9nLmZpbHRlcihcbiAgICAgIChjOiBzdHJpbmcpID0+IGMgPT09IFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIsXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChwb3N0VmVyaWZ5Q2FsbHMubGVuZ3RoLCAxLCBcInJ1blBvc3RVbml0VmVyaWZpY2F0aW9uIHNob3VsZCBvbmx5IGJlIGNhbGxlZCBvbmNlXCIpO1xuICAgIGFzc2VydC5lcXVhbChwb3N0UG9zdFZlcmlmeUNhbGxzLmxlbmd0aCwgMSwgXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb24gc2hvdWxkIG9ubHkgYmUgY2FsbGVkIG9uY2VcIik7XG4gIH0gZmluYWxseSB7XG4gICAgbW9jay50aW1lcnMucmVzZXQoKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBzdG9wQXV0byB1bml0UHJvbWlzZSBsZWFrIHJlZ3Jlc3Npb24gKCMxNzk5KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcInJlc29sdmVBZ2VudEVuZCB1bmJsb2NrcyBwZW5kaW5nIHJ1blVuaXQgd2hlbiBjYWxsZWQgYmVmb3JlIHNlc3Npb24gcmVzZXQgKCMxNzk5KVwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTW9ja1Nlc3Npb24oKTtcblxuICBjb25zdCByZXN1bHRQcm9taXNlID0gcnVuVW5pdChjdHgsIHBpLCBzLCBcInRhc2tcIiwgXCJUMDFcIiwgXCJkbyB3b3JrXCIpO1xuXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cbiAgcmVzb2x2ZUFnZW50RW5kKHsgbWVzc2FnZXM6IFtdIH0pO1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuICBzLmFjdGl2ZSA9IGZhbHNlO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc3VsdFByb21pc2U7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuc3RhdHVzLCBcImNvbXBsZXRlZFwiLCBcInJ1blVuaXQgc2hvdWxkIHJlc29sdmUsIG5vdCBoYW5nXCIpO1xufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBaZXJvIHRvb2wtY2FsbCBoYWxsdWNpbmF0aW9uIGd1YXJkICgjMTgzMykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJhdXRvTG9vcCByZWplY3RzIGV4ZWN1dGUtdGFzayB3aXRoIDAgdG9vbCBjYWxscyBhcyBoYWxsdWNpbmF0ZWQgKCMxODMzKVwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjdHguc2Vzc2lvbk1hbmFnZXIgPSB7IGdldFNlc3Npb25GaWxlOiAoKSA9PiBcIi90bXAvc2Vzc2lvbi5qc29uXCIgfTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG5cbiAgbGV0IGl0ZXJhdGlvbkNvdW50ID0gMDtcbiAgY29uc3Qgbm90aWZpY2F0aW9uczogc3RyaW5nW10gPSBbXTtcbiAgY3R4LnVpLm5vdGlmeSA9IChtc2c6IHN0cmluZykgPT4geyBub3RpZmljYXRpb25zLnB1c2gobXNnKTsgfTtcblxuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG5cbiAgLy8gTW9jayBsZWRnZXI6IGV4ZWN1dGUtdGFzayBjb21wbGV0ZWQgd2l0aCAwIHRvb2wgY2FsbHNcbiAgY29uc3QgbW9ja0xlZGdlciA9IHtcbiAgICB2ZXJzaW9uOiAxLFxuICAgIHByb2plY3RTdGFydGVkQXQ6IERhdGUubm93KCksXG4gICAgdW5pdHM6IFtdIGFzIGFueVtdLFxuICB9O1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcImRlcml2ZVN0YXRlXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIgfSxcbiAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIH0gYXMgYW55O1xuICAgIH0sXG4gICAgcmVzb2x2ZURpc3BhdGNoOiBhc3luYyAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcInJlc29sdmVEaXNwYXRjaFwiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiIGFzIGNvbnN0LFxuICAgICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgICBwcm9tcHQ6IFwiaW1wbGVtZW50IHRoZSBmZWF0dXJlXCIsXG4gICAgICB9O1xuICAgIH0sXG4gICAgY2xvc2VvdXRVbml0OiBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBTaW11bGF0ZSBzbmFwc2hvdFVuaXRNZXRyaWNzIGFkZGluZyBhIDAtdG9vbENhbGxzIGVudHJ5IHRvIGxlZGdlclxuICAgICAgbW9ja0xlZGdlci51bml0cy5wdXNoKHtcbiAgICAgICAgdHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgICAgaWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICAgIHN0YXJ0ZWRBdDogcy5jdXJyZW50VW5pdD8uc3RhcnRlZEF0ID8/IERhdGUubm93KCksXG4gICAgICAgIHRvb2xDYWxsczogMCxcbiAgICAgICAgYXNzaXN0YW50TWVzc2FnZXM6IDEsXG4gICAgICAgIHRva2VuczogeyBpbnB1dDogMTAwLCBvdXRwdXQ6IDIwMCwgdG90YWw6IDMwMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0sXG4gICAgICAgIGNvc3Q6IDAuNTAsXG4gICAgICB9KTtcbiAgICB9LFxuICAgIGdldExlZGdlcjogKCkgPT4gbW9ja0xlZGdlcixcbiAgICBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb246IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIpO1xuICAgICAgaXRlcmF0aW9uQ291bnQrKztcbiAgICAgIC8vIERlYWN0aXZhdGUgYWZ0ZXIgMm5kIGl0ZXJhdGlvblxuICAgICAgcy5hY3RpdmUgPSBpdGVyYXRpb25Db3VudCA8IDI7XG4gICAgICByZXR1cm4gXCJjb250aW51ZVwiIGFzIGNvbnN0O1xuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGxvb3BQcm9taXNlID0gYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgLy8gRmlyc3QgaXRlcmF0aW9uOiBleGVjdXRlLXRhc2sgd2l0aCAwIHRvb2wgY2FsbHMgXHUyMTkyIHJlamVjdGVkXG4gIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gIHJlc29sdmVBZ2VudEVuZChtYWtlRXZlbnQoKSk7XG5cbiAgLy8gU2Vjb25kIGl0ZXJhdGlvbjogc2FtZSB0YXNrIHJlLWRpc3BhdGNoZWQsIHRoaXMgdGltZSB3aXRoIHRvb2wgY2FsbHNcbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgbW9ja0xlZGdlci51bml0cy5sZW5ndGggPSAwOyAvLyBjbGVhciBwcmV2aW91cyBlbnRyeVxuICAoZGVwcyBhcyBhbnkpLmNsb3Nlb3V0VW5pdCA9IGFzeW5jICgpID0+IHtcbiAgICBtb2NrTGVkZ2VyLnVuaXRzLnB1c2goe1xuICAgICAgdHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIGlkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgc3RhcnRlZEF0OiBzLmN1cnJlbnRVbml0Py5zdGFydGVkQXQgPz8gRGF0ZS5ub3coKSxcbiAgICAgIHRvb2xDYWxsczogNSxcbiAgICAgIGFzc2lzdGFudE1lc3NhZ2VzOiAzLFxuICAgICAgdG9rZW5zOiB7IGlucHV0OiA1MDAsIG91dHB1dDogODAwLCB0b3RhbDogMTMwMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0sXG4gICAgICBjb3N0OiAxLjAwLFxuICAgIH0pO1xuICB9O1xuICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpO1xuXG4gIGF3YWl0IGxvb3BQcm9taXNlO1xuXG4gIC8vIFRoZSB0YXNrIHNob3VsZCBOT1QgaGF2ZSBiZWVuIGFkZGVkIHRvIGNvbXBsZXRlZFVuaXRzIG9uIHRoZSBmaXJzdCBpdGVyYXRpb25cbiAgLy8gKDAgdG9vbCBjYWxscyksIGJ1dCBTSE9VTEQgYmUgYWRkZWQgb24gdGhlIHNlY29uZCBpdGVyYXRpb24gKDUgdG9vbCBjYWxscylcbiAgY29uc3Qgd2FybmluZ05vdGlmaWNhdGlvbiA9IG5vdGlmaWNhdGlvbnMuZmluZChcbiAgICAobikgPT4gbi5pbmNsdWRlcyhcIjAgdG9vbCBjYWxsc1wiKSAmJiBuLmluY2x1ZGVzKFwiY29udGV4dCBleGhhdXN0aW9uXCIpLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgd2FybmluZ05vdGlmaWNhdGlvbixcbiAgICBcInNob3VsZCBub3RpZnkgYWJvdXQgMCB0b29sIGNhbGxzIGNvbnRleHQgZXhoYXVzdGlvblwiLFxuICApO1xuXG4gIC8vIFZlcmlmeSBkZXJpdmVTdGF0ZSB3YXMgY2FsbGVkIGF0IGxlYXN0IHR3aWNlICh0d28gaXRlcmF0aW9ucylcbiAgY29uc3QgZGVyaXZlQ291bnQgPSBkZXBzLmNhbGxMb2cuZmlsdGVyKChjKSA9PiBjID09PSBcImRlcml2ZVN0YXRlXCIpLmxlbmd0aDtcbiAgYXNzZXJ0Lm9rKFxuICAgIGRlcml2ZUNvdW50ID49IDIsXG4gICAgYGRlcml2ZVN0YXRlIHNob3VsZCBiZSBjYWxsZWQgYXQgbGVhc3QgMiB0aW1lcyBmb3IgcmV0cnkgKGdvdCAke2Rlcml2ZUNvdW50fSlgLFxuICApO1xufSk7XG5cbnRlc3QoXCJhdXRvTG9vcCBwYXVzZXMgdXNlci1kcml2ZW4gZGVlcCBxdWVzdGlvbiBpbnN0ZWFkIG9mIGZsYWdnaW5nIDAgdG9vbCBjYWxsc1wiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjdHguc2Vzc2lvbk1hbmFnZXIgPSB7IGdldFNlc3Npb25GaWxlOiAoKSA9PiBcIi90bXAvc2Vzc2lvbi5qc29uXCIgfTtcbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG5cbiAgY29uc3Qgbm90aWZpY2F0aW9uczogc3RyaW5nW10gPSBbXTtcbiAgY3R4LnVpLm5vdGlmeSA9IChtc2c6IHN0cmluZykgPT4geyBub3RpZmljYXRpb25zLnB1c2gobXNnKTsgfTtcblxuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG4gIGNvbnN0IG1vY2tMZWRnZXIgPSB7XG4gICAgdmVyc2lvbjogMSxcbiAgICBwcm9qZWN0U3RhcnRlZEF0OiBEYXRlLm5vdygpLFxuICAgIHVuaXRzOiBbXSBhcyBhbnlbXSxcbiAgfTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJkZXJpdmVTdGF0ZVwiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJCb290c3RyYXBcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIH0gYXMgYW55O1xuICAgIH0sXG4gICAgcmVzb2x2ZURpc3BhdGNoOiBhc3luYyAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcInJlc29sdmVEaXNwYXRjaFwiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiIGFzIGNvbnN0LFxuICAgICAgICB1bml0VHlwZTogXCJkaXNjdXNzLXByb2plY3RcIixcbiAgICAgICAgdW5pdElkOiBcIlBST0pFQ1RcIixcbiAgICAgICAgcHJvbXB0OiBcImFzayB3aGF0IHRvIGJ1aWxkXCIsXG4gICAgICB9O1xuICAgIH0sXG4gICAgY2xvc2VvdXRVbml0OiBhc3luYyAoKSA9PiB7XG4gICAgICBtb2NrTGVkZ2VyLnVuaXRzLnB1c2goe1xuICAgICAgICB0eXBlOiBcImRpc2N1c3MtcHJvamVjdFwiLFxuICAgICAgICBpZDogXCJQUk9KRUNUXCIsXG4gICAgICAgIHN0YXJ0ZWRBdDogcy5jdXJyZW50VW5pdD8uc3RhcnRlZEF0ID8/IERhdGUubm93KCksXG4gICAgICAgIHRvb2xDYWxsczogMCxcbiAgICAgICAgYXNzaXN0YW50TWVzc2FnZXM6IDEsXG4gICAgICAgIHRva2VuczogeyBpbnB1dDogMTAwLCBvdXRwdXQ6IDIwLCB0b3RhbDogMTIwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSxcbiAgICAgICAgY29zdDogMC4wMSxcbiAgICAgIH0pO1xuICAgIH0sXG4gICAgZ2V0TGVkZ2VyOiAoKSA9PiBtb2NrTGVkZ2VyLFxuICAgIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcInBvc3RVbml0UHJlVmVyaWZpY2F0aW9uXCIpO1xuICAgICAgcmV0dXJuIFwiZGlzcGF0Y2hlZFwiIGFzIGNvbnN0O1xuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IGxvb3BQcm9taXNlID0gYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgcmVzb2x2ZUFnZW50RW5kKG1ha2VFdmVudChbXG4gICAge1xuICAgICAgcm9sZTogXCJhc3Npc3RhbnRcIixcbiAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJXaGF0IGRvIHlvdSB3YW50IHRvIGJ1aWxkP1wiIH0sXG4gICAgICBdLFxuICAgIH0sXG4gIF0pKTtcblxuICBhd2FpdCBsb29wUHJvbWlzZTtcblxuICBhc3NlcnQub2soXG4gICAgZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicG9zdFVuaXRQcmVWZXJpZmljYXRpb25cIiksXG4gICAgXCJxdWVzdGlvbmluZyB1bml0cyBzaG91bGQgcmVhY2ggcG9zdC11bml0IHZlcmlmaWNhdGlvbiBzbyB0aGUgcGF1c2UgcGF0aCBjYW4gcnVuXCIsXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICAhbm90aWZpY2F0aW9ucy5zb21lKChuKSA9PiBuLmluY2x1ZGVzKFwiY29udGV4dCBleGhhdXN0aW9uXCIpKSxcbiAgICBcInF1ZXN0aW9uaW5nIHVuaXRzIHNob3VsZCBub3Qgc2hvdyB0aGUgY29udGV4dC1leGhhdXN0aW9uIHdhcm5pbmdcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiYXV0b0xvb3AgcmVqZWN0cyBjb21wbGV0ZS1zbGljZSB3aXRoIDAgdG9vbCBjYWxscyBhcyBjb250ZXh0LWV4aGF1c3RlZCAoIzI2NTMpXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGN0eC5zZXNzaW9uTWFuYWdlciA9IHsgZ2V0U2Vzc2lvbkZpbGU6ICgpID0+IFwiL3RtcC9zZXNzaW9uLmpzb25cIiB9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcblxuICBsZXQgaXRlcmF0aW9uQ291bnQgPSAwO1xuICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjdHgudWkubm90aWZ5ID0gKG1zZzogc3RyaW5nKSA9PiB7IG5vdGlmaWNhdGlvbnMucHVzaChtc2cpOyB9O1xuXG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oKTtcblxuICBjb25zdCBtb2NrTGVkZ2VyID0ge1xuICAgIHZlcnNpb246IDEsXG4gICAgcHJvamVjdFN0YXJ0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICB1bml0czogW10gYXMgYW55W10sXG4gIH07XG5cbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwiZGVyaXZlU3RhdGVcIik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlIDFcIiB9LFxuICAgICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgfSBhcyBhbnk7XG4gICAgfSxcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+IHtcbiAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicmVzb2x2ZURpc3BhdGNoXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICAgIHVuaXRUeXBlOiBcImNvbXBsZXRlLXNsaWNlXCIsXG4gICAgICAgIHVuaXRJZDogXCJNMDAxL1MwMVwiLFxuICAgICAgICBwcm9tcHQ6IFwiY29tcGxldGUgdGhlIHNsaWNlXCIsXG4gICAgICB9O1xuICAgIH0sXG4gICAgY2xvc2VvdXRVbml0OiBhc3luYyAoKSA9PiB7XG4gICAgICAvLyBjb21wbGV0ZS1zbGljZSB3aXRoIDAgdG9vbCBjYWxscyBcdTIwMTQgY29udGV4dCBleGhhdXN0ZWQsIG5vIHByb2dyZXNzXG4gICAgICBtb2NrTGVkZ2VyLnVuaXRzLnB1c2goe1xuICAgICAgICB0eXBlOiBcImNvbXBsZXRlLXNsaWNlXCIsXG4gICAgICAgIGlkOiBcIk0wMDEvUzAxXCIsXG4gICAgICAgIHN0YXJ0ZWRBdDogcy5jdXJyZW50VW5pdD8uc3RhcnRlZEF0ID8/IERhdGUubm93KCksXG4gICAgICAgIHRvb2xDYWxsczogMCxcbiAgICAgICAgYXNzaXN0YW50TWVzc2FnZXM6IDEsXG4gICAgICAgIHRva2VuczogeyBpbnB1dDogNTAsIG91dHB1dDogMTAwLCB0b3RhbDogMTUwLCBjYWNoZVJlYWQ6IDAsIGNhY2hlV3JpdGU6IDAgfSxcbiAgICAgICAgY29zdDogMC4xMCxcbiAgICAgIH0pO1xuICAgIH0sXG4gICAgZ2V0TGVkZ2VyOiAoKSA9PiBtb2NrTGVkZ2VyLFxuICAgIHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbjogYXN5bmMgKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb25cIik7XG4gICAgICBpdGVyYXRpb25Db3VudCsrO1xuICAgICAgLy8gRGVhY3RpdmF0ZSBhZnRlciAybmQgaXRlcmF0aW9uXG4gICAgICBzLmFjdGl2ZSA9IGl0ZXJhdGlvbkNvdW50IDwgMjtcbiAgICAgIHJldHVybiBcImNvbnRpbnVlXCIgYXMgY29uc3Q7XG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICAvLyBGaXJzdCBpdGVyYXRpb246IGNvbXBsZXRlLXNsaWNlIHdpdGggMCB0b29sIGNhbGxzIFx1MjE5MiByZWplY3RlZFxuICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpO1xuXG4gIC8vIFNlY29uZCBpdGVyYXRpb246IHJlLWRpc3BhdGNoZWQsIHRoaXMgdGltZSB3aXRoIHRvb2wgY2FsbHNcbiAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgbW9ja0xlZGdlci51bml0cy5sZW5ndGggPSAwO1xuICAoZGVwcyBhcyBhbnkpLmNsb3Nlb3V0VW5pdCA9IGFzeW5jICgpID0+IHtcbiAgICBtb2NrTGVkZ2VyLnVuaXRzLnB1c2goe1xuICAgICAgdHlwZTogXCJjb21wbGV0ZS1zbGljZVwiLFxuICAgICAgaWQ6IFwiTTAwMS9TMDFcIixcbiAgICAgIHN0YXJ0ZWRBdDogcy5jdXJyZW50VW5pdD8uc3RhcnRlZEF0ID8/IERhdGUubm93KCksXG4gICAgICB0b29sQ2FsbHM6IDMsXG4gICAgICBhc3Npc3RhbnRNZXNzYWdlczogMixcbiAgICAgIHRva2VuczogeyBpbnB1dDogMjAwLCBvdXRwdXQ6IDQwMCwgdG90YWw6IDYwMCwgY2FjaGVSZWFkOiAwLCBjYWNoZVdyaXRlOiAwIH0sXG4gICAgICBjb3N0OiAwLjMwLFxuICAgIH0pO1xuICB9O1xuICByZXNvbHZlQWdlbnRFbmQobWFrZUV2ZW50KCkpO1xuXG4gIGF3YWl0IGxvb3BQcm9taXNlO1xuXG4gIC8vIFNob3VsZCBoYXZlIGEgd2FybmluZyBhYm91dCAwIHRvb2wgY2FsbHMgZm9yIGNvbXBsZXRlLXNsaWNlXG4gIGNvbnN0IHdhcm5pbmdOb3RpZmljYXRpb24gPSBub3RpZmljYXRpb25zLmZpbmQoXG4gICAgKG4pID0+IG4uaW5jbHVkZXMoXCIwIHRvb2wgY2FsbHNcIiksXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICB3YXJuaW5nTm90aWZpY2F0aW9uLFxuICAgIFwic2hvdWxkIGZsYWcgY29tcGxldGUtc2xpY2Ugd2l0aCAwIHRvb2wgY2FsbHMgYXMgZmFpbGVkICgjMjY1MylcIixcbiAgKTtcblxuICAvLyBWZXJpZnkgZGVyaXZlU3RhdGUgd2FzIGNhbGxlZCBhdCBsZWFzdCB0d2ljZSAodHdvIGl0ZXJhdGlvbnM6IHJlamVjdGVkICsgcmV0cnkpXG4gIGNvbnN0IGRlcml2ZUNvdW50ID0gZGVwcy5jYWxsTG9nLmZpbHRlcigoYykgPT4gYyA9PT0gXCJkZXJpdmVTdGF0ZVwiKS5sZW5ndGg7XG4gIGFzc2VydC5vayhcbiAgICBkZXJpdmVDb3VudCA+PSAyLFxuICAgIGBkZXJpdmVTdGF0ZSBzaG91bGQgYmUgY2FsbGVkIGF0IGxlYXN0IDIgdGltZXMgZm9yIHJldHJ5IChnb3QgJHtkZXJpdmVDb3VudH0pYCxcbiAgKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgV29ya3RyZWUgaGVhbHRoIGNoZWNrICgjMTgzMykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJhdXRvTG9vcCBzdG9wcyB3aGVuIFdvcmt0cmVlIFNhZmV0eSBmaW5kcyBubyAuZ2l0IG1hcmtlciBmb3IgZXhlY3V0ZS10YXNrICgjMTgzMylcIiwgYXN5bmMgKHQpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGN0eC5zZXNzaW9uTWFuYWdlciA9IHsgZ2V0U2Vzc2lvbkZpbGU6ICgpID0+IFwiL3RtcC9zZXNzaW9uLmpzb25cIiB9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcblxuICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjdHgudWkubm90aWZ5ID0gKG1zZzogc3RyaW5nKSA9PiB7IG5vdGlmaWNhdGlvbnMucHVzaChtc2cpOyB9O1xuXG4gIGNvbnN0IHByb2plY3RSb290ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd3Qtc2FmZXR5LWxvb3AtXCIpKTtcbiAgY29uc3Qgd29ya3RyZWVSb290ID0gam9pbihwcm9qZWN0Um9vdCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKHdvcmt0cmVlUm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHByb2plY3RSb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oe1xuICAgIGJhc2VQYXRoOiB3b3JrdHJlZVJvb3QsXG4gICAgb3JpZ2luYWxCYXNlUGF0aDogcHJvamVjdFJvb3QsXG4gICAgY2Fub25pY2FsUHJvamVjdFJvb3Q6IHByb2plY3RSb290LFxuICB9KTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJkZXJpdmVTdGF0ZVwiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiIH0sXG4gICAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIgfSxcbiAgICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICB9IGFzIGFueTtcbiAgICB9LFxuICAgIGdldElzb2xhdGlvbk1vZGU6ICgpID0+IFwid29ya3RyZWVcIixcbiAgfSk7XG5cbiAgYXdhaXQgYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgYXNzZXJ0Lm9rKFxuICAgIGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInN0b3BBdXRvXCIpLFxuICAgIFwic2hvdWxkIHN0b3AgYXV0by1tb2RlIHdoZW4gd29ya3RyZWUgaXMgaW52YWxpZFwiLFxuICApO1xuICBjb25zdCBoZWFsdGhOb3RpZmljYXRpb24gPSBub3RpZmljYXRpb25zLmZpbmQoXG4gICAgKG4pID0+IG4uaW5jbHVkZXMoXCJXb3JrdHJlZSBTYWZldHkgZmFpbGVkXCIpICYmIG4uaW5jbHVkZXMoXCJ3b3JrdHJlZS1naXQtbWFya2VyLW1pc3NpbmdcIiksXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICBoZWFsdGhOb3RpZmljYXRpb24sXG4gICAgXCJzaG91bGQgbm90aWZ5IGFib3V0IG1pc3Npbmcgd29ya3RyZWUgLmdpdCBtYXJrZXJcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwiZGlzcGF0Y2ggV29ya3RyZWUgU2FmZXR5IHdpbnMgYmVmb3JlIHN0dWNrIGRldGVjdGlvbiBmb3IgZXhlY3V0ZS10YXNrIHdpdGhvdXQgLmdpdFwiLCBhc3luYyAodCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjdHgudWkubm90aWZ5ID0gKG1zZzogc3RyaW5nKSA9PiB7IG5vdGlmaWNhdGlvbnMucHVzaChtc2cpOyB9O1xuXG4gIGNvbnN0IHByb2plY3RSb290ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd3Qtc2FmZXR5LWRpc3BhdGNoLVwiKSk7XG4gIGNvbnN0IHdvcmt0cmVlUm9vdCA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiLCBcIk0wMDFcIik7XG4gIG1rZGlyU3luYyh3b3JrdHJlZVJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB0LmFmdGVyKCgpID0+IHJtU3luYyhwcm9qZWN0Um9vdCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKHtcbiAgICBiYXNlUGF0aDogd29ya3RyZWVSb290LFxuICAgIG9yaWdpbmFsQmFzZVBhdGg6IHByb2plY3RSb290LFxuICAgIGNhbm9uaWNhbFByb2plY3RSb290OiBwcm9qZWN0Um9vdCxcbiAgfSk7XG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIGdldElzb2xhdGlvbk1vZGU6ICgpID0+IFwid29ya3RyZWVcIixcbiAgfSk7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKFxuICAgIHtcbiAgICAgIGN0eCxcbiAgICAgIHBpLFxuICAgICAgcyxcbiAgICAgIGRlcHMsXG4gICAgICBwcmVmczogdW5kZWZpbmVkLFxuICAgICAgaXRlcmF0aW9uOiAxLFxuICAgICAgZmxvd0lkOiBcInRlc3QtZmxvd1wiLFxuICAgICAgbmV4dFNlcTogKCkgPT4gMSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHN0YXRlOiB7XG4gICAgICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiIH0sXG4gICAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIgfSxcbiAgICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICB9IGFzIGFueSxcbiAgICAgIG1pZDogXCJNMDAxXCIsXG4gICAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgfSxcbiAgICB7XG4gICAgICByZWNlbnRVbml0czogW1xuICAgICAgICB7IGtleTogXCJleGVjdXRlLXRhc2svTTAwMS9TMDEvVDAxXCIgfSxcbiAgICAgICAgeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH0sXG4gICAgICBdLFxuICAgICAgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAxLFxuICAgICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICAgIH0sXG4gICk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiYnJlYWtcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucmVhc29uLCBcIndvcmt0cmVlLWdpdC1tYXJrZXItbWlzc2luZ1wiKTtcbiAgYXNzZXJ0Lm9rKGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInN0b3BBdXRvXCIpLCBcInNob3VsZCBzdG9wIHRocm91Z2ggV29ya3RyZWUgU2FmZXR5XCIpO1xuICBhc3NlcnQub2soXG4gICAgbm90aWZpY2F0aW9ucy5zb21lKChuKSA9PiBuLmluY2x1ZGVzKFwiV29ya3RyZWUgU2FmZXR5IGZhaWxlZFwiKSAmJiBuLmluY2x1ZGVzKFwid29ya3RyZWUtZ2l0LW1hcmtlci1taXNzaW5nXCIpKSxcbiAgICBcInNob3VsZCBub3RpZnkgYWJvdXQgbWlzc2luZyB3b3JrdHJlZSAuZ2l0IG1hcmtlclwiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgIW5vdGlmaWNhdGlvbnMuc29tZSgobikgPT4gbi5pbmNsdWRlcyhcIlN0dWNrIG9uIGV4ZWN1dGUtdGFza1wiKSksXG4gICAgXCJzdHVjay1sb29wIG1lc3NhZ2UgbXVzdCBub3QgbWFzayB0aGUgd29ya3RyZWUgaGVhbHRoIGZhaWx1cmVcIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwicnVuRGlzcGF0Y2ggcnVucyBzdHVjayBkZXRlY3Rpb24gd2hpbGUgYXJ0aWZhY3QgdmVyaWZpY2F0aW9uIHJldHJ5IGlzIHBlbmRpbmcgKCM1NzE5KVwiLCBhc3luYyAodCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjdHgudWkubm90aWZ5ID0gKG1zZzogc3RyaW5nKSA9PiB7IG5vdGlmaWNhdGlvbnMucHVzaChtc2cpOyB9O1xuXG4gIGNvbnN0IGJhc2VQYXRoID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtNTcxOS1yZXRyeS1zdHVjay1cIikpO1xuICB0LmFmdGVyKCgpID0+IHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pKTtcblxuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKHtcbiAgICBiYXNlUGF0aCxcbiAgICBwZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnk6IHtcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIGZhaWx1cmVDb250ZXh0OiBcIkVOT0VOVDogbm8gc3VjaCBmaWxlIG9yIGRpcmVjdG9yeSwgYWNjZXNzICcvdG1wL21pc3NpbmctcGxhbi5tZCdcIixcbiAgICAgIGF0dGVtcHQ6IDEsXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoKTtcbiAgY29uc3QgbG9vcFN0YXRlID0ge1xuICAgIHJlY2VudFVuaXRzOiBbXG4gICAgICB7XG4gICAgICAgIGtleTogXCJleGVjdXRlLXRhc2svTTAwMS9TMDEvVDAxXCIsXG4gICAgICAgIGVycm9yOiBcIkVOT0VOVDogbm8gc3VjaCBmaWxlIG9yIGRpcmVjdG9yeSwgYWNjZXNzICcvdG1wL21pc3NpbmctcGxhbi5tZCdcIixcbiAgICAgIH0sXG4gICAgICB7IGtleTogXCJwbGFuLXNsaWNlL00wMDEvUzAyXCIsIGVycm9yOiBcIm90aGVyIGZhaWx1cmVcIiB9LFxuICAgICAge1xuICAgICAgICBrZXk6IFwiY29tcGxldGUtc2xpY2UvTTAwMS9TMDFcIixcbiAgICAgICAgZXJyb3I6IFwiRU5PRU5UOiBubyBzdWNoIGZpbGUgb3IgZGlyZWN0b3J5LCBhY2Nlc3MgJy90bXAvbWlzc2luZy1wbGFuLm1kJ1wiLFxuICAgICAgfSxcbiAgICBdLFxuICAgIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCxcbiAgICBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAsXG4gIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRGlzcGF0Y2goXG4gICAge1xuICAgICAgY3R4LFxuICAgICAgcGksXG4gICAgICBzLFxuICAgICAgZGVwcyxcbiAgICAgIHByZWZzOiB1bmRlZmluZWQsXG4gICAgICBpdGVyYXRpb246IDEsXG4gICAgICBmbG93SWQ6IFwidGVzdC1mbG93XCIsXG4gICAgICBuZXh0U2VxOiAoKSA9PiAxLFxuICAgIH0sXG4gICAge1xuICAgICAgc3RhdGU6IHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIgfSxcbiAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIH0gYXMgYW55LFxuICAgICAgbWlkOiBcIk0wMDFcIixcbiAgICAgIG1pZFRpdGxlOiBcIlRlc3RcIixcbiAgICB9LFxuICAgIGxvb3BTdGF0ZSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJuZXh0XCIsIFwibGV2ZWwtMSBzdHVjayByZWNvdmVyeSBzaG91bGQgc3RpbGwgYWxsb3cgdGhlIHJlY292ZXJ5IGRpc3BhdGNoXCIpO1xuICBhc3NlcnQuZXF1YWwobG9vcFN0YXRlLnN0dWNrUmVjb3ZlcnlBdHRlbXB0cywgMSwgXCJzdHVjayByZWNvdmVyeSBzaG91bGQgcmVjb3JkIHRoZSBmaXJzdCByZWNvdmVyeSBhdHRlbXB0XCIpO1xuICBhc3NlcnQub2soZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwiaW52YWxpZGF0ZUFsbENhY2hlc1wiKSwgXCJzdHVjayByZWNvdmVyeSBzaG91bGQgaW52YWxpZGF0ZSBjYWNoZXNcIik7XG4gIGFzc2VydC5vayhcbiAgICBub3RpZmljYXRpb25zLnNvbWUoKG4pID0+IG4uaW5jbHVkZXMoXCJNaXNzaW5nIGZpbGUgcmVmZXJlbmNlZCB0d2ljZVwiKSksXG4gICAgXCJub3RpZmljYXRpb24gc2hvdWxkIHN1cmZhY2UgdGhlIHJlcGVhdGVkIEVOT0VOVCBzdHVjayByZWFzb25cIixcbiAgKTtcbn0pO1xuXG50ZXN0KFwicnVuRGlzcGF0Y2ggZmFsbHMgYmFjayB0byBtYWluIHdoZW4gZGlzcGF0Y2ggZ3VhcmQgY2Fubm90IHJlYWQgbWFpbiBicmFuY2ggKCM1NTMwKVwiLCBhc3luYyAodCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLTU1MzAtbWFpbi1icmFuY2gtZmFsbGJhY2stXCIpKTtcbiAgdC5hZnRlcigoKSA9PiBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KSk7XG5cbiAgbGV0IGd1YXJkQnJhbmNoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbih7IGJhc2VQYXRoIH0pO1xuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICBnZXRNYWluQnJhbmNoOiAoKSA9PiB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJmYXRhbDogZGV0ZWN0ZWQgZHViaW91cyBvd25lcnNoaXBcIik7XG4gICAgfSxcbiAgICBnZXRQcmlvclNsaWNlQ29tcGxldGlvbkJsb2NrZXI6IChfYmFzZVBhdGgsIG1haW5CcmFuY2gpID0+IHtcbiAgICAgIGd1YXJkQnJhbmNoID0gbWFpbkJyYW5jaDtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0sXG4gIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKFxuICAgIHtcbiAgICAgIGN0eCxcbiAgICAgIHBpLFxuICAgICAgcyxcbiAgICAgIGRlcHMsXG4gICAgICBwcmVmczogdW5kZWZpbmVkLFxuICAgICAgaXRlcmF0aW9uOiAxLFxuICAgICAgZmxvd0lkOiBcInRlc3QtZmxvd1wiLFxuICAgICAgbmV4dFNlcTogKCkgPT4gMSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHN0YXRlOiB7XG4gICAgICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiIH0sXG4gICAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIgfSxcbiAgICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICB9IGFzIGFueSxcbiAgICAgIG1pZDogXCJNMDAxXCIsXG4gICAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgfSxcbiAgICB7XG4gICAgICByZWNlbnRVbml0czogW10sXG4gICAgICBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsXG4gICAgICBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAsXG4gICAgfSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwoZ3VhcmRCcmFuY2gsIFwibWFpblwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwibmV4dFwiKTtcbn0pO1xuXG50ZXN0KFwiZGlzcGF0Y2ggV29ya3RyZWUgU2FmZXR5IHN0b3BzIHVua25vd24gdW5pdCB0eXBlcyB3aXRoIG1pc3NpbmcgVG9vbCBDb250cmFjdFwiLCBhc3luYyAodCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjdHgudWkubm90aWZ5ID0gKG1zZzogc3RyaW5nKSA9PiB7IG5vdGlmaWNhdGlvbnMucHVzaChtc2cpOyB9O1xuXG4gIGNvbnN0IHByb2plY3RSb290ID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtd3Qtc2FmZXR5LW1pc3NpbmctY29udHJhY3QtXCIpKTtcbiAgY29uc3Qgd29ya3RyZWVSb290ID0gam9pbihwcm9qZWN0Um9vdCwgXCIuZ3NkXCIsIFwid29ya3RyZWVzXCIsIFwiTTAwMVwiKTtcbiAgbWtkaXJTeW5jKHdvcmt0cmVlUm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHQuYWZ0ZXIoKCkgPT4gcm1TeW5jKHByb2plY3RSb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSkpO1xuXG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oe1xuICAgIGJhc2VQYXRoOiB3b3JrdHJlZVJvb3QsXG4gICAgb3JpZ2luYWxCYXNlUGF0aDogcHJvamVjdFJvb3QsXG4gICAgY2Fub25pY2FsUHJvamVjdFJvb3Q6IHByb2plY3RSb290LFxuICB9KTtcbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZ2V0SXNvbGF0aW9uTW9kZTogKCkgPT4gXCJ3b3JrdHJlZVwiLFxuICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4ge1xuICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJyZXNvbHZlRGlzcGF0Y2hcIik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIiBhcyBjb25zdCxcbiAgICAgICAgdW5pdFR5cGU6IFwibmV3LXNvdXJjZS13cml0aW5nLXVuaXQtd2l0aG91dC1tYW5pZmVzdFwiLFxuICAgICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICAgIHByb21wdDogXCJkbyB0aGUgdGhpbmdcIixcbiAgICAgIH07XG4gICAgfSxcbiAgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRGlzcGF0Y2goXG4gICAge1xuICAgICAgY3R4LFxuICAgICAgcGksXG4gICAgICBzLFxuICAgICAgZGVwcyxcbiAgICAgIHByZWZzOiB1bmRlZmluZWQsXG4gICAgICBpdGVyYXRpb246IDEsXG4gICAgICBmbG93SWQ6IFwidGVzdC1mbG93XCIsXG4gICAgICBuZXh0U2VxOiAoKSA9PiAxLFxuICAgIH0sXG4gICAge1xuICAgICAgc3RhdGU6IHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIgfSxcbiAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIH0gYXMgYW55LFxuICAgICAgbWlkOiBcIk0wMDFcIixcbiAgICAgIG1pZFRpdGxlOiBcIlRlc3RcIixcbiAgICB9LFxuICAgIHtcbiAgICAgIHJlY2VudFVuaXRzOiBbXSxcbiAgICAgIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCxcbiAgICAgIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCxcbiAgICB9LFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImJyZWFrXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlYXNvbiwgXCJtaXNzaW5nLXRvb2wtY29udHJhY3RcIik7XG4gIGFzc2VydC5vayhkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJzdG9wQXV0b1wiKSwgXCJzaG91bGQgc3RvcCB3aGVuIHRoZSBUb29sIENvbnRyYWN0IGlzIG1pc3NpbmdcIik7XG4gIGFzc2VydC5vayhcbiAgICBub3RpZmljYXRpb25zLnNvbWUoKG4pID0+IG4uaW5jbHVkZXMoXCJtaXNzaW5nIFRvb2wgQ29udHJhY3QgZm9yIG5ldy1zb3VyY2Utd3JpdGluZy11bml0LXdpdGhvdXQtbWFuaWZlc3RcIikpLFxuICAgIFwic2hvdWxkIG5vdGlmeSB3aXRoIGFuIGFjdGlvbmFibGUgbWlzc2luZyBUb29sIENvbnRyYWN0IHJlYXNvblwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJwcmUtZGlzcGF0Y2ggc2tpcCByZXNvbHZlcyBiZWZvcmUgZGlzcGF0Y2ggaGVhbHRoIGFuZCBzdHVjayBhY2NvdW50aW5nXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgY29uc3Qgbm90aWZpY2F0aW9uczogc3RyaW5nW10gPSBbXTtcbiAgY3R4LnVpLm5vdGlmeSA9IChtc2c6IHN0cmluZykgPT4geyBub3RpZmljYXRpb25zLnB1c2gobXNnKTsgfTtcblxuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKHsgYmFzZVBhdGg6IFwiL3RtcC9icm9rZW4td29ya3RyZWVcIiB9KTtcbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgZXhpc3RzU3luYzogKHA6IHN0cmluZykgPT4gIXAuZW5kc1dpdGgoXCIuZ2l0XCIpLFxuICAgIHJ1blByZURpc3BhdGNoSG9va3M6ICgpID0+ICh7IGZpcmVkSG9va3M6IFtcInNraXAtZXhlY3V0ZVwiXSwgYWN0aW9uOiBcInNraXBcIiB9KSxcbiAgfSk7XG4gIGNvbnN0IGxvb3BTdGF0ZSA9IHtcbiAgICByZWNlbnRVbml0czogW1xuICAgICAgeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH0sXG4gICAgICB7IGtleTogXCJleGVjdXRlLXRhc2svTTAwMS9TMDEvVDAxXCIgfSxcbiAgICBdLFxuICAgIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMSxcbiAgICBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAsXG4gIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRGlzcGF0Y2goXG4gICAge1xuICAgICAgY3R4LFxuICAgICAgcGksXG4gICAgICBzLFxuICAgICAgZGVwcyxcbiAgICAgIHByZWZzOiB1bmRlZmluZWQsXG4gICAgICBpdGVyYXRpb246IDEsXG4gICAgICBmbG93SWQ6IFwidGVzdC1mbG93XCIsXG4gICAgICBuZXh0U2VxOiAoKSA9PiAxLFxuICAgIH0sXG4gICAge1xuICAgICAgc3RhdGU6IHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIgfSxcbiAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIH0gYXMgYW55LFxuICAgICAgbWlkOiBcIk0wMDFcIixcbiAgICAgIG1pZFRpdGxlOiBcIlRlc3RcIixcbiAgICB9LFxuICAgIGxvb3BTdGF0ZSxcbiAgKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJjb250aW51ZVwiKTtcbiAgYXNzZXJ0Lm9rKCFkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJzdG9wQXV0b1wiKSwgXCJza2lwIGhvb2sgc2hvdWxkIG5vdCBzdG9wIG9uIHdvcmt0cmVlIGhlYWx0aFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGxvb3BTdGF0ZS5yZWNlbnRVbml0cy5sZW5ndGgsIDIsIFwic2tpcCBob29rIHNob3VsZCBub3QgdXBkYXRlIHN0dWNrIGFjY291bnRpbmdcIik7XG4gIGFzc2VydC5vayhcbiAgICBub3RpZmljYXRpb25zLnNvbWUoKG4pID0+IG4uaW5jbHVkZXMoXCJTa2lwcGluZyBleGVjdXRlLXRhc2sgTTAwMS9TMDEvVDAxXCIpKSxcbiAgICBcInNob3VsZCBub3RpZnkgYWJvdXQgdGhlIHNraXAgaG9va1wiLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgIW5vdGlmaWNhdGlvbnMuc29tZSgobikgPT4gbi5pbmNsdWRlcyhcIldvcmt0cmVlIGhlYWx0aCBjaGVjayBmYWlsZWRcIikgfHwgbi5pbmNsdWRlcyhcIlN0dWNrIG9uIGV4ZWN1dGUtdGFza1wiKSksXG4gICAgXCJoZWFsdGggYW5kIHN0dWNrIG5vdGlmaWNhdGlvbnMgbXVzdCBub3QgcnVuIGJlZm9yZSBza2lwIGhvb2sgcmVzb2x1dGlvblwiLFxuICApO1xufSk7XG5cbnRlc3QoXCJwcmUtZGlzcGF0Y2ggcmVwbGFjZSByZXNvbHZlcyBmaW5hbCB1bml0IGJlZm9yZSBkaXNwYXRjaCBoZWFsdGggYW5kIHN0dWNrIGFjY291bnRpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjdHgudWkubm90aWZ5ID0gKG1zZzogc3RyaW5nKSA9PiB7IG5vdGlmaWNhdGlvbnMucHVzaChtc2cpOyB9O1xuXG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oeyBiYXNlUGF0aDogXCIvdG1wL2Jyb2tlbi13b3JrdHJlZVwiIH0pO1xuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICBleGlzdHNTeW5jOiAocDogc3RyaW5nKSA9PiAhcC5lbmRzV2l0aChcIi5naXRcIiksXG4gICAgcnVuUHJlRGlzcGF0Y2hIb29rczogKCkgPT4gKHtcbiAgICAgIGZpcmVkSG9va3M6IFtcInJldmlld1wiXSxcbiAgICAgIGFjdGlvbjogXCJyZXBsYWNlXCIsXG4gICAgICB1bml0VHlwZTogXCJydW4tdWF0XCIsXG4gICAgICBwcm9tcHQ6IFwicmV2aWV3IGJlZm9yZSBleGVjdXRpbmdcIixcbiAgICAgIG1vZGVsOiBcInJldmlldy1tb2RlbFwiLFxuICAgIH0pLFxuICB9KTtcbiAgY29uc3QgbG9vcFN0YXRlID0ge1xuICAgIHJlY2VudFVuaXRzOiBbXG4gICAgICB7IGtleTogXCJleGVjdXRlLXRhc2svTTAwMS9TMDEvVDAxXCIgfSxcbiAgICAgIHsga2V5OiBcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIiB9LFxuICAgIF0sXG4gICAgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAxLFxuICAgIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCxcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5EaXNwYXRjaChcbiAgICB7XG4gICAgICBjdHgsXG4gICAgICBwaSxcbiAgICAgIHMsXG4gICAgICBkZXBzLFxuICAgICAgcHJlZnM6IHVuZGVmaW5lZCxcbiAgICAgIGl0ZXJhdGlvbjogMSxcbiAgICAgIGZsb3dJZDogXCJ0ZXN0LWZsb3dcIixcbiAgICAgIG5leHRTZXE6ICgpID0+IDEsXG4gICAgfSxcbiAgICB7XG4gICAgICBzdGF0ZToge1xuICAgICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlIDFcIiB9LFxuICAgICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgfSBhcyBhbnksXG4gICAgICBtaWQ6IFwiTTAwMVwiLFxuICAgICAgbWlkVGl0bGU6IFwiVGVzdFwiLFxuICAgIH0sXG4gICAgbG9vcFN0YXRlLFxuICApO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5leHRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuZGF0YT8udW5pdFR5cGUsIFwicnVuLXVhdFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kYXRhPy5maW5hbFByb21wdCwgXCJyZXZpZXcgYmVmb3JlIGV4ZWN1dGluZ1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5kYXRhPy5ob29rTW9kZWxPdmVycmlkZSwgXCJyZXZpZXctbW9kZWxcIik7XG4gIGFzc2VydC5vayghZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwic3RvcEF1dG9cIiksIFwicmVwbGFjZSBob29rIHNob3VsZCBub3Qgc3RvcCBvbiBleGVjdXRlLXRhc2sgaGVhbHRoXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKFxuICAgIGxvb3BTdGF0ZS5yZWNlbnRVbml0cy5tYXAoKHUpID0+IHUua2V5KSxcbiAgICBbXG4gICAgICBcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIixcbiAgICAgIFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiLFxuICAgICAgXCJydW4tdWF0L00wMDEvUzAxL1QwMVwiLFxuICAgIF0sXG4gICAgXCJzdHVjayBhY2NvdW50aW5nIHNob3VsZCByZWNvcmQgdGhlIGZpbmFsIHJlcGxhY2VkIHVuaXRcIixcbiAgKTtcbiAgYXNzZXJ0Lm9rKFxuICAgICFub3RpZmljYXRpb25zLnNvbWUoKG4pID0+IG4uaW5jbHVkZXMoXCJXb3JrdHJlZSBoZWFsdGggY2hlY2sgZmFpbGVkXCIpIHx8IG4uaW5jbHVkZXMoXCJTdHVjayBvbiBleGVjdXRlLXRhc2tcIikpLFxuICAgIFwiaGVhbHRoIGFuZCBzdHVjayBub3RpZmljYXRpb25zIG11c3QgdXNlIHRoZSBmaW5hbCByZXBsYWNlZCB1bml0XCIsXG4gICk7XG59KTtcblxudGVzdChcImF1dG9Mb29wIHdhcm5zIGJ1dCBwcm9jZWVkcyBmb3IgZ3JlZW5maWVsZCBwcm9qZWN0IChubyBwcm9qZWN0IGZpbGVzKSAoIzE4MzMpXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICBjdHgudWkuc2V0U3RhdHVzID0gKCkgPT4ge307XG4gIGN0eC5zZXNzaW9uTWFuYWdlciA9IHsgZ2V0U2Vzc2lvbkZpbGU6ICgpID0+IFwiL3RtcC9zZXNzaW9uLmpzb25cIiB9O1xuICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcblxuICBjb25zdCBub3RpZmljYXRpb25zOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKHsgYmFzZVBhdGg6IFwiL3RtcC9lbXB0eS13b3JrdHJlZVwiIH0pO1xuXG4gIGN0eC51aS5ub3RpZnkgPSAobXNnOiBzdHJpbmcpID0+IHtcbiAgICBub3RpZmljYXRpb25zLnB1c2gobXNnKTtcbiAgICAvLyBUZXJtaW5hdGUgdGhlIGxvb3AgYWZ0ZXIgdGhlIGdyZWVuZmllbGQgd2FybmluZyBmaXJlcyxcbiAgICAvLyBzbyB3ZSBkb24ndCBoYW5nIHdhaXRpbmcgZm9yIGRpc3BhdGNoIHJlc29sdXRpb24uXG4gICAgaWYgKG1zZy5pbmNsdWRlcyhcImdyZWVuZmllbGRcIikpIHtcbiAgICAgIHMuYWN0aXZlID0gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiB7XG4gICAgICBkZXBzLmNhbGxMb2cucHVzaChcImRlcml2ZVN0YXRlXCIpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIgfSxcbiAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIH0gYXMgYW55O1xuICAgIH0sXG4gICAgLy8gSGFzIC5naXQgYnV0IG5vIHBhY2thZ2UuanNvbiBvciBzcmMvXG4gICAgZXhpc3RzU3luYzogKHA6IHN0cmluZykgPT4gcC5lbmRzV2l0aChcIi5naXRcIiksXG4gIH0pO1xuXG4gIGF3YWl0IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gIC8vIFNob3VsZCBOT1QgaGF2ZSBzdG9wcGVkIGF1dG8tbW9kZSBkdWUgdG8gaGVhbHRoIGNoZWNrIFx1MjAxNCBncmVlbmZpZWxkIGlzIGFsbG93ZWRcbiAgY29uc3Qgc3RvcHBlZEZvckhlYWx0aCA9IG5vdGlmaWNhdGlvbnMuZmluZChcbiAgICAobikgPT4gbi5pbmNsdWRlcyhcIldvcmt0cmVlIGhlYWx0aCBjaGVjayBmYWlsZWRcIiksXG4gICk7XG4gIGFzc2VydC5vayhcbiAgICAhc3RvcHBlZEZvckhlYWx0aCxcbiAgICBcInNob3VsZCBub3Qgc3RvcCB3aXRoIGhlYWx0aCBjaGVjayBmYWlsdXJlIGZvciBncmVlbmZpZWxkIHByb2plY3RcIixcbiAgKTtcbiAgY29uc3QgZ3JlZW5maWVsZFdhcm5pbmcgPSBub3RpZmljYXRpb25zLmZpbmQoXG4gICAgKG4pID0+IG4uaW5jbHVkZXMoXCJubyBwcm9qZWN0IGNvbnRlbnQgeWV0XCIpICYmIG4uaW5jbHVkZXMoXCJncmVlbmZpZWxkXCIpLFxuICApO1xuICBhc3NlcnQub2soXG4gICAgZ3JlZW5maWVsZFdhcm5pbmcsXG4gICAgXCJzaG91bGQgd2FybiBhYm91dCBncmVlbmZpZWxkIHByb2plY3QgKG5vIHByb2plY3QgZmlsZXMpXCIsXG4gICk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwIFByb2FjdGl2ZSByYXRlIGxpbWl0aW5nICgjMjk5NikgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJhdXRvTG9vcCBlbmZvcmNlcyBtaW5fcmVxdWVzdF9pbnRlcnZhbF9tcyBkZWxheSBiZXR3ZWVuIExMTSBkaXNwYXRjaGVzICgjMjk5NilcIiwgYXN5bmMgKCkgPT4ge1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuICBtb2NrLnRpbWVycy5lbmFibGUoeyBhcGlzOiBbXCJEYXRlXCIsIFwic2V0VGltZW91dFwiXSwgbm93OiAxXzAwMCB9KTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICAgIGN0eC5zZXNzaW9uTWFuYWdlciA9IHsgZ2V0U2Vzc2lvbkZpbGU6ICgpID0+IFwiL3RtcC9zZXNzaW9uLmpzb25cIiB9O1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAgIGNvbnN0IG9yaWdpbmFsU2VuZE1lc3NhZ2UgPSBwaS5zZW5kTWVzc2FnZTtcbiAgICBjb25zdCBkaXNwYXRjaFRpbWVzdGFtcHM6IG51bWJlcltdID0gW107XG4gICAgcGkuc2VuZE1lc3NhZ2UgPSAoLi4uYXJnczogdW5rbm93bltdKSA9PiB7XG4gICAgICBkaXNwYXRjaFRpbWVzdGFtcHMucHVzaChEYXRlLm5vdygpKTtcbiAgICAgIHJldHVybiBvcmlnaW5hbFNlbmRNZXNzYWdlKC4uLmFyZ3MpO1xuICAgIH07XG5cbiAgICBsZXQgaXRlckNvdW50ID0gMDtcblxuICAgIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oKTtcblxuICAgIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgICAgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzOiAoKSA9PiAoe1xuICAgICAgICBwcmVmZXJlbmNlczoge1xuICAgICAgICAgIG1pbl9yZXF1ZXN0X2ludGVydmFsX21zOiAzMDAsXG4gICAgICAgICAgdW9rOiB7IHBsYW5fdjI6IHsgZW5hYmxlZDogZmFsc2UgfSB9LFxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4ge1xuICAgICAgICBpdGVyQ291bnQrKztcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goXCJkZXJpdmVTdGF0ZVwiKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZVwiIH0sXG4gICAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiB9LFxuICAgICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgIH0gYXMgYW55O1xuICAgICAgfSxcbiAgICAgIHBvc3RVbml0UG9zdFZlcmlmaWNhdGlvbjogYXN5bmMgKCkgPT4ge1xuICAgICAgICBkZXBzLmNhbGxMb2cucHVzaChcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblwiKTtcbiAgICAgICAgaWYgKGl0ZXJDb3VudCA+PSAyKSB7XG4gICAgICAgICAgcy5hY3RpdmUgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gXCJjb250aW51ZVwiIGFzIGNvbnN0O1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxvb3BQcm9taXNlID0gYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgICBhd2FpdCB3YWl0Rm9yTWljcm90YXNrcygoKSA9PiBkaXNwYXRjaFRpbWVzdGFtcHMubGVuZ3RoID09PSAxLCBcImZpcnN0IGRpc3BhdGNoXCIpO1xuICAgIHJlc29sdmVBZ2VudEVuZChtYWtlRXZlbnQoKSk7XG4gICAgYXdhaXQgd2FpdEZvck1pY3JvdGFza3MoXG4gICAgICAoKSA9PiBkZXBzLmNhbGxMb2cuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkgPT09IFwicmVzb2x2ZURpc3BhdGNoXCIpLmxlbmd0aCA+PSAyLFxuICAgICAgXCJzZWNvbmQgZGlzcGF0Y2ggcGxhbm5pbmdcIixcbiAgICApO1xuXG4gICAgYXdhaXQgZHJhaW5NaWNyb3Rhc2tzKDEwMCk7XG4gICAgbW9jay50aW1lcnMudGljaygyOTkpO1xuICAgIGF3YWl0IGRyYWluTWljcm90YXNrcygxMDApO1xuICAgIGFzc2VydC5lcXVhbChkaXNwYXRjaFRpbWVzdGFtcHMubGVuZ3RoLCAxLCBcInNlY29uZCBkaXNwYXRjaCBzaG91bGQgd2FpdCBmb3IgdGhlIGNvbmZpZ3VyZWQgaW50ZXJ2YWxcIik7XG5cbiAgICBtb2NrLnRpbWVycy50aWNrKDEpO1xuICAgIGF3YWl0IHdhaXRGb3JNaWNyb3Rhc2tzKCgpID0+IGRpc3BhdGNoVGltZXN0YW1wcy5sZW5ndGggPT09IDIsIFwic2Vjb25kIGRpc3BhdGNoXCIpO1xuICAgIHJlc29sdmVBZ2VudEVuZChtYWtlRXZlbnQoKSk7XG5cbiAgICBhd2FpdCBsb29wUHJvbWlzZTtcblxuICAgIGFzc2VydC5vayhpdGVyQ291bnQgPj0gMiwgYGV4cGVjdGVkIGF0IGxlYXN0IDIgaXRlcmF0aW9ucywgZ290ICR7aXRlckNvdW50fWApO1xuICAgIGFzc2VydC5vayhkaXNwYXRjaFRpbWVzdGFtcHMubGVuZ3RoID49IDIsIGBleHBlY3RlZCBhdCBsZWFzdCAyIGRpc3BhdGNoZXMsIGdvdCAke2Rpc3BhdGNoVGltZXN0YW1wcy5sZW5ndGh9YCk7XG5cbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICAocyBhcyBhbnkpLmxhc3RSZXF1ZXN0VGltZXN0YW1wLFxuICAgICAgZGlzcGF0Y2hUaW1lc3RhbXBzWzFdLFxuICAgICAgXCJsYXN0UmVxdWVzdFRpbWVzdGFtcCBzaG91bGQgcmVjb3JkIHRoZSBhY3R1YWwgZGlzcGF0Y2ggdGltZVwiLFxuICAgICk7XG5cbiAgICBjb25zdCBnYXAgPSBkaXNwYXRjaFRpbWVzdGFtcHNbMV0hIC0gZGlzcGF0Y2hUaW1lc3RhbXBzWzBdITtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBnYXAsXG4gICAgICAzMDAsXG4gICAgICBgZ2FwIGJldHdlZW4gZGlzcGF0Y2hlcyBzaG91bGQgbWF0Y2ggbWluX3JlcXVlc3RfaW50ZXJ2YWxfbXM9MzAwIChnb3QgJHtnYXB9bXMpYCxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIG1vY2sudGltZXJzLnJlc2V0KCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwiYXV0b0xvb3Agc2tpcHMgcmF0ZS1saW1pdCBkZWxheSB3aGVuIG1pbl9yZXF1ZXN0X2ludGVydmFsX21zIGlzIDAgKGRlZmF1bHQpXCIsIGFzeW5jICgpID0+IHtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcbiAgbW9jay50aW1lcnMuZW5hYmxlKHsgYXBpczogW1wiRGF0ZVwiLCBcInNldFRpbWVvdXRcIl0sIG5vdzogMl8wMDAgfSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGN0eC51aS5zZXRTdGF0dXMgPSAoKSA9PiB7fTtcbiAgICBjdHguc2Vzc2lvbk1hbmFnZXIgPSB7IGdldFNlc3Npb25GaWxlOiAoKSA9PiBcIi90bXAvc2Vzc2lvbi5qc29uXCIgfTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBvcmlnaW5hbFNlbmRNZXNzYWdlID0gcGkuc2VuZE1lc3NhZ2U7XG4gICAgY29uc3QgZGlzcGF0Y2hUaW1lc3RhbXBzOiBudW1iZXJbXSA9IFtdO1xuICAgIHBpLnNlbmRNZXNzYWdlID0gKC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuICAgICAgZGlzcGF0Y2hUaW1lc3RhbXBzLnB1c2goRGF0ZS5ub3coKSk7XG4gICAgICByZXR1cm4gb3JpZ2luYWxTZW5kTWVzc2FnZSguLi5hcmdzKTtcbiAgICB9O1xuXG4gICAgbGV0IGl0ZXJDb3VudCA9IDA7XG5cbiAgICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKCk7XG5cbiAgICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICAgIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlczogKCkgPT4gKHtcbiAgICAgICAgcHJlZmVyZW5jZXM6IHsgdW9rOiB7IHBsYW5fdjI6IHsgZW5hYmxlZDogZmFsc2UgfSB9IH0sXG4gICAgICB9KSxcbiAgICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGl0ZXJDb3VudCsrO1xuICAgICAgICBkZXBzLmNhbGxMb2cucHVzaChcImRlcml2ZVN0YXRlXCIpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHBoYXNlOiBcImV4ZWN1dGluZ1wiLFxuICAgICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlXCIgfSxcbiAgICAgICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgICAgfSBhcyBhbnk7XG4gICAgICB9LFxuICAgICAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIpO1xuICAgICAgICBpZiAoaXRlckNvdW50ID49IDMpIHtcbiAgICAgICAgICBzLmFjdGl2ZSA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBcImNvbnRpbnVlXCIgYXMgY29uc3Q7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICAgIGZvciAobGV0IGkgPSAxOyBpIDw9IDM7IGkrKykge1xuICAgICAgYXdhaXQgd2FpdEZvck1pY3JvdGFza3MoKCkgPT4gZGlzcGF0Y2hUaW1lc3RhbXBzLmxlbmd0aCA9PT0gaSwgYGRpc3BhdGNoICR7aX1gKTtcbiAgICAgIHJlc29sdmVBZ2VudEVuZChtYWtlRXZlbnQoKSk7XG4gICAgfVxuXG4gICAgYXdhaXQgbG9vcFByb21pc2U7XG5cbiAgICBhc3NlcnQub2soaXRlckNvdW50ID49IDMsIGBleHBlY3RlZCBhdCBsZWFzdCAzIGl0ZXJhdGlvbnMsIGdvdCAke2l0ZXJDb3VudH1gKTtcbiAgICBhc3NlcnQub2soZGlzcGF0Y2hUaW1lc3RhbXBzLmxlbmd0aCA+PSAzLCBgZXhwZWN0ZWQgYXQgbGVhc3QgMyBkaXNwYXRjaGVzLCBnb3QgJHtkaXNwYXRjaFRpbWVzdGFtcHMubGVuZ3RofWApO1xuXG4gICAgY29uc3QgZ2FwID0gZGlzcGF0Y2hUaW1lc3RhbXBzWzJdISAtIGRpc3BhdGNoVGltZXN0YW1wc1sxXSE7XG4gICAgYXNzZXJ0LmVxdWFsKFxuICAgICAgZ2FwLFxuICAgICAgMCxcbiAgICAgIGBnYXAgc2hvdWxkIGJlIDBtcyB1bmRlciBtb2NrZWQgdGltZSB3aXRob3V0IHJhdGUgbGltaXRpbmcgKGdvdCAke2dhcH1tcylgLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgbW9jay50aW1lcnMucmVzZXQoKTtcbiAgfVxufSk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCAjNDg1MDogcHJlLXNlbmQgbW9kZWwtcG9saWN5IGJsb2NrIGlzIG5vbi1yZXRyeWFibGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG50ZXN0KFwiYXV0b0xvb3AgY2xhc3NpZmllcyBNb2RlbFBvbGljeURpc3BhdGNoQmxvY2tlZEVycm9yIGFzIGJsb2NrZWQsIG5vdCBhIHJldHJ5YWJsZSBlcnJvclwiLCBhc3luYyAoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgY3R4LnVpLnNldFN0YXR1cyA9ICgpID0+IHt9O1xuICBjb25zdCBub3RpZmljYXRpb25zOiBBcnJheTx7IG1lc3NhZ2U6IHN0cmluZzsgbGV2ZWw/OiBzdHJpbmcgfT4gPSBbXTtcbiAgY3R4LnVpLm5vdGlmeSA9IChtOiBzdHJpbmcsIGw/OiBzdHJpbmcpID0+IHsgbm90aWZpY2F0aW9ucy5wdXNoKHsgbWVzc2FnZTogbSwgbGV2ZWw6IGwgfSk7IH07XG5cbiAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oKTtcblxuICBjb25zdCBqb3VybmFsRXZlbnRzOiBBcnJheTx7IGV2ZW50VHlwZTogc3RyaW5nOyBkYXRhPzogYW55IH0+ID0gW107XG4gIGxldCBwYXVzZUF1dG9DYWxscyA9IDA7XG4gIGxldCBzdG9wQXV0b0NhbGxzID0gMDtcbiAgLy8gQ2FwdHVyZSBvblR1cm5SZXN1bHQgdG8gYXNzZXJ0IGJsb2NrZWQtdW5pdCBpZGVudGl0eSBpcyBwcm9wYWdhdGVkIHRvXG4gIC8vIHRoZSB1b2tPYnNlcnZlci4gV2l0aG91dCB0aGUgZml4LCBvYnNlcnZlZFVuaXRUeXBlL0lkIGFyZSB1bnNldCBiZWNhdXNlXG4gIC8vIHRoZSB0aHJvdyBoYXBwZW5zIGluc2lkZSBkaXNwYXRjaCBiZWZvcmUgdGhlIHN1Y2Nlc3MtcGF0aCBhc3NpZ25tZW50c1xuICAvLyBhdCBsb29wLnRzOjQ1My82MzEvNjQ3ICgjNDk1OSAvIENvZGVSYWJiaXQgTWlub3IpLlxuICBjb25zdCB0dXJuUmVzdWx0czogQXJyYXk8eyB1bml0VHlwZT86IHN0cmluZzsgdW5pdElkPzogc3RyaW5nOyBzdGF0dXM6IHN0cmluZyB9PiA9IFtdO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgIHNlbGVjdEFuZEFwcGx5TW9kZWw6IGFzeW5jICgpID0+IHtcbiAgICAgIHRocm93IG5ldyBNb2RlbFBvbGljeURpc3BhdGNoQmxvY2tlZEVycm9yKFxuICAgICAgICBcInJlc2VhcmNoLXNsaWNlXCIsXG4gICAgICAgIFwiTTAwMS9TMDFcIixcbiAgICAgICAgW3sgcHJvdmlkZXI6IFwib3BlbmFpXCIsIG1vZGVsSWQ6IFwiZ3B0LTRvXCIsIHJlYXNvbjogXCJ0b29sIHBvbGljeSBkZW5pZWQgKHdlYl9zZWFyY2gpIGZvciBvcGVuYWktY29tcGxldGlvbnNcIiB9XSxcbiAgICAgICk7XG4gICAgfSxcbiAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHsgcGF1c2VBdXRvQ2FsbHMrKzsgfSxcbiAgICBzdG9wQXV0bzogYXN5bmMgKCkgPT4geyBzdG9wQXV0b0NhbGxzKys7IH0sXG4gICAgZW1pdEpvdXJuYWxFdmVudDogKGVudHJ5OiBhbnkpID0+IHsgam91cm5hbEV2ZW50cy5wdXNoKGVudHJ5KTsgfSxcbiAgICB1b2tPYnNlcnZlcjoge1xuICAgICAgb25UdXJuU3RhcnQ6ICgpID0+IHt9LFxuICAgICAgb25QaGFzZVJlc3VsdDogKCkgPT4ge30sXG4gICAgICBvblR1cm5SZXN1bHQ6IChyZXM6IGFueSkgPT4geyB0dXJuUmVzdWx0cy5wdXNoKHsgdW5pdFR5cGU6IHJlcy51bml0VHlwZSwgdW5pdElkOiByZXMudW5pdElkLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSk7IH0sXG4gICAgfSBhcyBhbnksXG4gIH0pO1xuXG4gIGF3YWl0IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gIC8vIFRoZSB1bml0LWVuZCBldmVudCB3aXRoIHN0YXR1czogXCJibG9ja2VkXCIgbXVzdCBiZSBlbWl0dGVkLlxuICBjb25zdCB1bml0RW5kID0gam91cm5hbEV2ZW50cy5maW5kKFxuICAgIGUgPT4gZS5ldmVudFR5cGUgPT09IFwidW5pdC1lbmRcIiAmJiBlLmRhdGE/LnN0YXR1cyA9PT0gXCJibG9ja2VkXCIsXG4gICk7XG4gIGFzc2VydC5vayh1bml0RW5kLCBcInNob3VsZCBlbWl0IHVuaXQtZW5kIHdpdGggc3RhdHVzPWJsb2NrZWRcIik7XG4gIGFzc2VydC5lcXVhbCh1bml0RW5kIS5kYXRhLnJlYXNvbiwgXCJtb2RlbC1wb2xpY3ktZGlzcGF0Y2gtYmxvY2tlZFwiKTtcbiAgY29uc3QgdW5pdEVuZEluZGV4ID0gam91cm5hbEV2ZW50cy5maW5kSW5kZXgoXG4gICAgZSA9PiBlLmV2ZW50VHlwZSA9PT0gXCJ1bml0LWVuZFwiICYmIGUuZGF0YT8uc3RhdHVzID09PSBcImJsb2NrZWRcIixcbiAgKTtcbiAgY29uc3QgaXRlcmF0aW9uRW5kSW5kZXggPSBqb3VybmFsRXZlbnRzLmZpbmRJbmRleChcbiAgICBlID0+IGUuZXZlbnRUeXBlID09PSBcIml0ZXJhdGlvbi1lbmRcIiAmJiBlLmRhdGE/LnN0YXR1cyA9PT0gXCJibG9ja2VkXCIsXG4gICk7XG4gIGFzc2VydC5vayhpdGVyYXRpb25FbmRJbmRleCA+IHVuaXRFbmRJbmRleCwgXCJibG9ja2VkIHBvbGljeSBpdGVyYXRpb25zIG11c3QgY2xvc2UgYWZ0ZXIgdW5pdC1lbmRcIik7XG5cbiAgLy8gTG9vcCBtdXN0IHBhdXNlIGZvciBtYW51YWwgYXR0ZW50aW9uLCBOT1QgcmV0cnkgdW50aWwgMy1zdHJpa2UgaGFyZCBzdG9wLlxuICBhc3NlcnQuZXF1YWwocGF1c2VBdXRvQ2FsbHMsIDEsIFwic2hvdWxkIHBhdXNlIG9uY2Ugb24gcG9saWN5IGJsb2NrXCIpO1xuICBhc3NlcnQuZXF1YWwoc3RvcEF1dG9DYWxscywgMCwgXCJzaG91bGQgTk9UIGNhbGwgc3RvcEF1dG8gXHUyMDE0IHByZS1zZW5kIGJsb2NrIGlzIG5vdCBhIHJldHJ5YWJsZSBpdGVyYXRpb24gZXJyb3JcIik7XG5cbiAgLy8gVGhlIG5vdGlmaWNhdGlvbiBzaG91bGQgc3VyZmFjZSB0aGUgcGVyLW1vZGVsIGRlbnkgcmVhc29uIGZyb20gdGhlIHR5cGVkIGVycm9yLlxuICBjb25zdCBibG9ja2VkTm90aWNlID0gbm90aWZpY2F0aW9ucy5maW5kKFxuICAgIG4gPT4gbi5tZXNzYWdlLmluY2x1ZGVzKFwibW9kZWwtcG9saWN5IGRlbmllZCBkaXNwYXRjaFwiKVxuICAgICAgJiYgbi5tZXNzYWdlLmluY2x1ZGVzKFwidG9vbCBwb2xpY3kgZGVuaWVkICh3ZWJfc2VhcmNoKVwiKSxcbiAgKTtcbiAgYXNzZXJ0Lm9rKGJsb2NrZWROb3RpY2UsIFwidXNlci1mYWNpbmcgbm90aWZpY2F0aW9uIHNob3VsZCBuYW1lIHRoZSBwb2xpY3kgYmxvY2sgKyBkZW55IHJlYXNvblwiKTtcblxuICAvLyBCbG9ja2VkLXVuaXQgaWRlbnRpdHkgbXVzdCByZWFjaCB1b2tPYnNlcnZlci5vblR1cm5SZXN1bHQgXHUyMDE0IHRoZSB0eXBlZFxuICAvLyBlcnJvciBhbHJlYWR5IGNhcnJpZXMgaXQsIHRoZSBsb29wIG11c3QgdGhyZWFkIGl0IGludG8gb2JzZXJ2ZWRVbml0VHlwZS9JZFxuICAvLyBiZWZvcmUgZmluaXNoVHVybiBpcyBjYWxsZWQgKCM0OTU5IC8gQ29kZVJhYmJpdCBNaW5vcikuXG4gIGNvbnN0IHBhdXNlZFR1cm4gPSB0dXJuUmVzdWx0cy5maW5kKHIgPT4gci5zdGF0dXMgPT09IFwicGF1c2VkXCIpO1xuICBhc3NlcnQub2socGF1c2VkVHVybiwgXCJ1b2tPYnNlcnZlciBzaG91bGQgb2JzZXJ2ZSBhIHBhdXNlZCB0dXJuIGZvciB0aGUgYmxvY2tlZCB1bml0XCIpO1xuICBhc3NlcnQuZXF1YWwocGF1c2VkVHVybiEudW5pdFR5cGUsIFwicmVzZWFyY2gtc2xpY2VcIiwgXCJvblR1cm5SZXN1bHQgbXVzdCByZWNlaXZlIHRoZSBibG9ja2VkIHVuaXRUeXBlIGZyb20gdGhlIHR5cGVkIGVycm9yXCIpO1xuICBhc3NlcnQuZXF1YWwocGF1c2VkVHVybiEudW5pdElkLCBcIk0wMDEvUzAxXCIsIFwib25UdXJuUmVzdWx0IG11c3QgcmVjZWl2ZSB0aGUgYmxvY2tlZCB1bml0SWQgZnJvbSB0aGUgdHlwZWQgZXJyb3JcIik7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sUUFB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
