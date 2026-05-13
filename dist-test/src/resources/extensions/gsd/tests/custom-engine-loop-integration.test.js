import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoLoop } from "../auto/loop.js";
import { resolveAgentEnd, _hasPendingResolveForTest, _resetPendingResolve } from "../auto/resolve.js";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import { writeGraph, readGraph } from "../graph.js";
import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
const tmpDirs = [];
function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "loop-integ-"));
  tmpDirs.push(dir);
  return dir;
}
async function resolveNextAgentEnd(timeoutMs = 3e3) {
  const deadline = Date.now() + timeoutMs;
  while (!_hasPendingResolveForTest()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for pending agent_end resolver");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
}
afterEach(() => {
  _resetPendingResolve();
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
  tmpDirs.length = 0;
});
function makeStep(overrides) {
  return {
    title: overrides.id,
    status: "pending",
    prompt: `Do ${overrides.id}`,
    dependsOn: [],
    ...overrides
  };
}
function makeGraph(steps, name = "test-wf") {
  return {
    steps,
    metadata: { name, createdAt: "2026-01-01T00:00:00.000Z" }
  };
}
function writeDefinition(runDir, steps, name = "test-wf") {
  const def = {
    version: 1,
    name,
    description: `Test workflow: ${name}`,
    steps: steps.map((s) => ({
      id: s.id,
      name: s.title ?? s.id,
      prompt: s.prompt ?? `Do ${s.id}`,
      produces: `${s.id}/output.md`,
      ...s.dependsOn?.length ? { requires: s.dependsOn } : {}
    }))
  };
  writeFileSync(join(runDir, "DEFINITION.yaml"), stringify(def));
}
function makeMockCtx() {
  return {
    ui: { notify: () => {
    }, setStatus: () => {
    } },
    model: { id: "test-model" },
    sessionManager: { getSessionFile: () => "/tmp/session.json" }
  };
}
function makeMockPi() {
  const calls = [];
  return {
    sendMessage: (...args) => {
      calls.push(args);
    },
    calls
  };
}
function makeLoopSession(overrides) {
  return {
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath: "/tmp/project",
    originalBasePath: "",
    currentMilestoneId: null,
    currentUnit: null,
    currentUnitRouting: null,
    completedUnits: [],
    resourceVersionOnStart: null,
    lastPromptCharCount: void 0,
    lastBaselineCharCount: void 0,
    lastBudgetAlertLevel: 0,
    pendingVerificationRetry: null,
    pendingCrashRecovery: null,
    pendingQuickTasks: [],
    sidecarQueue: [],
    autoModeStartModel: null,
    unitDispatchCount: /* @__PURE__ */ new Map(),
    unitLifetimeDispatches: /* @__PURE__ */ new Map(),
    unitRecoveryCount: /* @__PURE__ */ new Map(),
    verificationRetryCount: /* @__PURE__ */ new Map(),
    gitService: null,
    autoStartTime: Date.now(),
    activeEngineId: null,
    activeRunDir: null,
    rewriteAttemptCount: 0,
    cmdCtx: {
      newSession: () => Promise.resolve({ cancelled: false }),
      getContextUsage: () => ({ percent: 10, tokens: 1e3, limit: 1e4 })
    },
    clearTimers: () => {
    },
    lockBasePath: "/tmp/project",
    ...overrides
  };
}
function makeMockDeps(overrides) {
  const callLog = [];
  const baseDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async (_ctx, _pi, reason) => {
      callLog.push(`stopAuto:${reason ?? "no-reason"}`);
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
    },
    deriveState: async () => {
      callLog.push("deriveState");
      return {
        phase: "executing",
        activeMilestone: { id: "M001", title: "Workflow", status: "active" },
        activeSlice: null,
        activeTask: null,
        registry: [],
        blockers: []
      };
    },
    rebuildState: async () => {
    },
    loadEffectiveGSDPreferences: () => void 0,
    preDispatchHealthGate: async () => ({ proceed: true, fixesApplied: [] }),
    checkResourcesStale: () => null,
    validateSessionLock: () => ({ valid: true }),
    updateSessionLock: () => {
    },
    handleLostSessionLock: () => {
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
      return { action: "dispatch", unitType: "execute-task", unitId: "M001/S01/T01", prompt: "unused" };
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
    resolveModelId: () => void 0,
    startUnitSupervision: () => {
    },
    getDeepDiagnostic: () => null,
    isDbAvailable: () => false,
    reorderForCaching: (p) => p,
    existsSync: (p) => existsSync(p),
    readFileSync: () => "",
    atomicWriteSync: () => {
    },
    GitServiceImpl: class {
    },
    lifecycle: {
      enterMilestone: () => ({ ok: true, mode: "none", path: "/tmp/project" }),
      exitMilestone: (_mid, opts) => ({
        ok: true,
        merged: opts.merge,
        codeFilesChanged: false
      }),
      degradeToBranchMode: () => {
      },
      restoreToProjectRoot: () => {
      },
      isInMilestone: () => true,
      getCurrentMilestoneIfAny: () => "M001"
    },
    worktreeProjection: new WorktreeStateProjection(),
    postUnitPreVerification: async () => "continue",
    runPostUnitVerification: async () => "continue",
    postUnitPostVerification: async () => "continue",
    getSessionFile: () => "/tmp/session.json",
    emitJournalEvent: (entry) => {
      callLog.push(`journal:${entry.eventType}`);
    }
  };
  return { ...baseDeps, ...overrides, callLog };
}
describe("Custom engine loop integration", () => {
  it("dispatches a 3-step workflow through autoLoop and all steps complete", async () => {
    _resetPendingResolve();
    const runDir = makeTmpDir();
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] }),
      makeStep({ id: "step-c", dependsOn: ["step-b"] })
    ], "integ-test");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "integ-test");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    let unitCount = 0;
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    unitCount++;
    await resolveNextAgentEnd();
    unitCount++;
    await resolveNextAgentEnd();
    unitCount++;
    await resolveNextAgentEnd();
    await loopPromise;
    const finalGraph = readGraph(runDir);
    assert.equal(finalGraph.steps.length, 3, "Should have 3 steps");
    for (const step of finalGraph.steps) {
      assert.equal(step.status, "complete", `Step ${step.id} should be complete, got ${step.status}`);
      assert.ok(step.finishedAt, `Step ${step.id} should have finishedAt timestamp`);
    }
    assert.equal(pi.calls.length, 3, `Should have dispatched exactly 3 units, got ${pi.calls.length}`);
    const stopEntry = deps.callLog.find((e) => e.startsWith("stopAuto:"));
    assert.ok(stopEntry, "stopAuto should have been called");
    assert.ok(
      stopEntry.includes("Workflow complete"),
      `stopAuto reason should include "Workflow complete", got: ${stopEntry}`
    );
    assert.equal(
      deps.callLog.filter((e) => e === "deriveState").length,
      3,
      "custom engine should stop immediately after a milestone-complete reconcile"
    );
    assert.ok(
      !deps.callLog.includes("resolveDispatch"),
      "Custom engine path should skip resolveDispatch (dev path not taken)"
    );
  });
  it("stops when engine reports isComplete on first derive", async () => {
    _resetPendingResolve();
    const runDir = makeTmpDir();
    const graph = makeGraph([
      makeStep({ id: "step-a", status: "complete" })
    ], "already-done");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "already-done");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      }
    });
    await autoLoop(ctx, pi, s, deps);
    assert.equal(pi.calls.length, 0, "Should not dispatch units for complete workflow");
    const stopEntry = deps.callLog.find((e) => e.startsWith("stopAuto:"));
    assert.ok(stopEntry?.includes("Workflow complete"), "Should stop with 'Workflow complete'");
  });
  it("finalizes custom-engine complete turns and clears current turn state", async () => {
    _resetPendingResolve();
    const runDir = makeTmpDir();
    const graph = makeGraph([
      makeStep({ id: "step-a", status: "complete" })
    ], "already-done");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "already-done");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const turnResults = [];
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
      uokObserver: {
        onTurnStart: () => {
        },
        onTurnResult: (result) => {
          deps.callLog.push(`turnResult:${result.status}`);
          turnResults.push({
            status: result.status,
            failureClass: result.failureClass,
            error: result.error
          });
        },
        onPhaseResult: () => {
        }
      }
    });
    await autoLoop(ctx, pi, s, deps);
    assert.deepEqual(turnResults, [{ status: "completed", failureClass: "none", error: void 0 }]);
    assert.ok(
      deps.callLog.includes("journal:iteration-end"),
      `complete workflow should emit iteration-end; log=${deps.callLog.join(",")}`
    );
    assert.ok(
      deps.callLog.indexOf("turnResult:completed") < deps.callLog.indexOf("stopAuto:Workflow complete"),
      `turn should finalize before stopAuto; log=${deps.callLog.join(",")}`
    );
    assert.equal(s.currentTraceId, null);
    assert.equal(s.currentTurnId, null);
    assert.equal(pi.calls.length, 0, "complete workflow should not dispatch work");
  });
  it("stops blocked custom workflows and clears current turn state", async () => {
    _resetPendingResolve();
    const runDir = makeTmpDir();
    const graph = makeGraph([
      makeStep({ id: "step-a", dependsOn: ["step-b"] }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] })
    ], "blocked-workflow");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "blocked-workflow");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const turnResults = [];
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
      uokObserver: {
        onTurnStart: () => {
        },
        onTurnResult: (result) => {
          turnResults.push({
            status: result.status,
            failureClass: result.failureClass,
            error: result.error
          });
        },
        onPhaseResult: () => {
        }
      }
    });
    await autoLoop(ctx, pi, s, deps);
    assert.equal(turnResults.length, 1);
    assert.equal(turnResults[0].status, "stopped");
    assert.equal(turnResults[0].failureClass, "manual-attention");
    assert.match(turnResults[0].error ?? "", /custom-engine-dispatch-stop/);
    assert.ok(
      deps.callLog.includes("journal:iteration-end"),
      `blocked workflow should emit iteration-end; log=${deps.callLog.join(",")}`
    );
    assert.equal(s.currentTraceId, null);
    assert.equal(s.currentTurnId, null);
    assert.equal(pi.calls.length, 0, "blocked workflow should not dispatch a custom step");
    assert.match(
      deps.callLog.find((e) => e.startsWith("stopAuto:")) ?? "",
      /Workflow blocked: no pending steps are ready/
    );
  });
  it("finalizes the active turn when the session lock is lost", async () => {
    _resetPendingResolve();
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession();
    const turnResults = [];
    const deps = makeMockDeps({
      validateSessionLock: () => ({
        valid: false,
        failureReason: "pid-mismatch",
        expectedPid: 111,
        existingPid: 222
      }),
      handleLostSessionLock: () => {
        deps.callLog.push("handleLostSessionLock");
      },
      uokObserver: {
        onTurnStart: () => {
        },
        onTurnResult: (result) => {
          turnResults.push({
            status: result.status,
            failureClass: result.failureClass,
            error: result.error
          });
        },
        onPhaseResult: () => {
        }
      }
    });
    await autoLoop(ctx, pi, s, deps);
    assert.deepEqual(turnResults, [{
      status: "stopped",
      failureClass: "manual-attention",
      error: "session-lock-lost"
    }]);
    assert.equal(s.currentTraceId, null);
    assert.equal(s.currentTurnId, null);
    assert.equal(pi.calls.length, 0, "lost session lock must not dispatch work");
    assert.ok(deps.callLog.includes("handleLostSessionLock"));
  });
  it("does not call runPreDispatch or runFinalize on the custom path", async () => {
    _resetPendingResolve();
    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "only" })], "single");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "single");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
      postUnitPreVerification: async () => {
        deps.callLog.push("postUnitPreVerification");
        return "continue";
      },
      postUnitPostVerification: async () => {
        deps.callLog.push("postUnitPostVerification");
        return "continue";
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    await resolveNextAgentEnd();
    await loopPromise;
    assert.ok(
      !deps.callLog.includes("postUnitPreVerification"),
      "Custom path should skip postUnitPreVerification (runFinalize not called)"
    );
    assert.ok(
      !deps.callLog.includes("postUnitPostVerification"),
      "Custom path should skip postUnitPostVerification (runFinalize not called)"
    );
    assert.ok(
      !deps.callLog.includes("resolveDispatch"),
      "Custom path should skip resolveDispatch"
    );
  });
  it("respects dependency ordering \u2014 step-b waits for step-a", async () => {
    _resetPendingResolve();
    const runDir = makeTmpDir();
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] })
    ], "dep-order");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "dep-order");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const dispatchedUnitIds = [];
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const originalSendMessage = pi.sendMessage;
    pi.sendMessage = (...args) => {
      const promptArg = args[0];
      dispatchedUnitIds.push(promptArg?.content ?? "unknown");
      return originalSendMessage(...args);
    };
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    await resolveNextAgentEnd();
    await resolveNextAgentEnd();
    await loopPromise;
    assert.equal(dispatchedUnitIds.length, 2, "Should have dispatched 2 steps");
    assert.ok(
      dispatchedUnitIds[0].includes("Do step-a"),
      `First dispatch should be step-a, got: ${dispatchedUnitIds[0]}`
    );
    assert.ok(
      dispatchedUnitIds[1].includes("Do step-b"),
      `Second dispatch should be step-b, got: ${dispatchedUnitIds[1]}`
    );
  });
  it("stops custom workflow after repeated verification retries", async () => {
    _resetPendingResolve();
    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "retry-step" })], "retry-exhaustion");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "retry-exhaustion",
      steps: [{
        id: "retry-step",
        name: "retry-step",
        prompt: "Do retry-step",
        produces: "retry-step/output.md",
        verify: { policy: "shell-command", command: "exit 1" }
      }]
    }));
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const journalEvents = [];
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      },
      emitJournalEvent: (entry) => {
        journalEvents.push(entry);
        deps.callLog.push(`journal:${entry.eventType}`);
      }
    });
    const resolver = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
    }, 25);
    let timeout;
    try {
      await Promise.race([
        autoLoop(ctx, pi, s, deps),
        new Promise(
          (_, reject) => timeout = setTimeout(() => {
            s.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `autoLoop did not stop after verification retry exhaustion; calls=${pi.calls.length}; log=${deps.callLog.join(",")}`
            ));
          }, 3e3)
        )
      ]);
    } finally {
      clearInterval(resolver);
      if (timeout) clearTimeout(timeout);
    }
    assert.equal(pi.calls.length, 4, "verification retry should be capped after four dispatched attempts");
    const stopEntry = deps.callLog.find((e) => e.startsWith("stopAuto:"));
    assert.match(stopEntry ?? "", /requested retry 4 times without passing/);
    const finalGraph = readGraph(runDir);
    assert.equal(finalGraph.steps[0]?.status, "active", "failed verification must not reconcile the step complete");
    const unitEndIndexes = journalEvents.map((entry, index) => entry.eventType === "unit-end" ? index : -1).filter((index) => index >= 0);
    const iterationEndIndexes = journalEvents.map((entry, index) => entry.eventType === "iteration-end" ? index : -1).filter((index) => index >= 0);
    assert.equal(unitEndIndexes.length, 4, "each custom verification retry/stop attempt must emit unit-end");
    assert.equal(iterationEndIndexes.length, 4, "each custom verification retry/stop iteration must close after unit-end");
    for (const [i, unitEndIndex] of unitEndIndexes.entries()) {
      assert.ok(
        iterationEndIndexes[i] > unitEndIndex,
        `custom verification attempt ${i + 1} should emit iteration-end after unit-end`
      );
    }
  });
  it("persists custom verification retry budget across a session restart", async () => {
    _resetPendingResolve();
    const runDir = makeTmpDir();
    const graph = makeGraph([makeStep({ id: "retry-step" })], "retry-restart");
    writeGraph(runDir, graph);
    writeFileSync(join(runDir, "DEFINITION.yaml"), stringify({
      version: 1,
      name: "retry-restart",
      steps: [{
        id: "retry-step",
        name: "retry-step",
        prompt: "Do retry-step",
        produces: "retry-step/output.md",
        verify: { policy: "shell-command", command: "exit 1" }
      }]
    }));
    const ctx1 = makeMockCtx();
    const pi1 = makeMockPi();
    const s1 = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const deps1 = makeMockDeps();
    const resolver1 = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
      if (pi1.calls.length >= 2) {
        s1.active = false;
      }
    }, 25);
    let timeout1;
    try {
      await Promise.race([
        autoLoop(ctx1, pi1, s1, deps1),
        new Promise(
          (_, reject) => timeout1 = setTimeout(() => {
            s1.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `first autoLoop did not pause after two retry attempts; calls=${pi1.calls.length}; log=${deps1.callLog.join(",")}`
            ));
          }, 3e3)
        )
      ]);
    } finally {
      clearInterval(resolver1);
      if (timeout1) clearTimeout(timeout1);
    }
    assert.equal(pi1.calls.length, 2, "first session should consume two retry attempts");
    assert.equal(
      deps1.callLog.some((e) => e.startsWith("stopAuto:")),
      false,
      "first session should stop because the session deactivated, not because retry budget exhausted"
    );
    _resetPendingResolve();
    const ctx2 = makeMockCtx();
    const pi2 = makeMockPi();
    const s2 = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const deps2 = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps2.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s2.active = false;
      }
    });
    const resolver2 = setInterval(() => {
      if (_hasPendingResolveForTest()) {
        resolveAgentEnd({ messages: [{ role: "assistant" }] });
      }
    }, 25);
    let timeout2;
    try {
      await Promise.race([
        autoLoop(ctx2, pi2, s2, deps2),
        new Promise(
          (_, reject) => timeout2 = setTimeout(() => {
            s2.active = false;
            resolveAgentEnd({ messages: [{ role: "assistant" }] });
            reject(new Error(
              `second autoLoop did not stop after persisted retry exhaustion; calls=${pi2.calls.length}; log=${deps2.callLog.join(",")}`
            ));
          }, 3e3)
        )
      ]);
    } finally {
      clearInterval(resolver2);
      if (timeout2) clearTimeout(timeout2);
    }
    assert.equal(pi2.calls.length, 2, "second session should exhaust after attempts 3 and 4");
    const stopEntry = deps2.callLog.find((e) => e.startsWith("stopAuto:"));
    assert.match(stopEntry ?? "", /requested retry 4 times without passing/);
  });
  it("two-step workflow drives both steps to complete and stops when isComplete fires", async () => {
    _resetPendingResolve();
    const runDir = makeTmpDir();
    const graph = makeGraph([
      makeStep({ id: "step-a" }),
      makeStep({ id: "step-b", dependsOn: ["step-a"] })
    ], "failure-test");
    writeGraph(runDir, graph);
    writeDefinition(runDir, graph.steps, "failure-test");
    const ctx = makeMockCtx();
    const pi = makeMockPi();
    const s = makeLoopSession({
      activeEngineId: "custom",
      activeRunDir: runDir,
      basePath: runDir
    });
    const deps = makeMockDeps({
      stopAuto: async (_ctx, _pi, reason) => {
        deps.callLog.push(`stopAuto:${reason ?? "no-reason"}`);
        s.active = false;
      }
    });
    const loopPromise = autoLoop(ctx, pi, s, deps);
    await resolveNextAgentEnd();
    await resolveNextAgentEnd();
    await loopPromise;
    const finalGraph = readGraph(runDir);
    const stepA = finalGraph.steps.find((s2) => s2.id === "step-a");
    const stepB = finalGraph.steps.find((s2) => s2.id === "step-b");
    assert.equal(stepA?.status, "complete", "Step-a should be complete");
    assert.equal(stepB?.status, "complete", "Step-b should be complete");
    assert.ok(
      deps.callLog.some((e) => e.startsWith("stopAuto:")),
      "stopAuto should have been called"
    );
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9jdXN0b20tZW5naW5lLWxvb3AtaW50ZWdyYXRpb24udGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBjdXN0b20tZW5naW5lLWxvb3AtaW50ZWdyYXRpb24udGVzdC50cyBcdTIwMTQgSW50ZWdyYXRpb24gdGVzdCBwcm92aW5nIHRoYXRcbiAqIGF1dG9Mb29wIGRpc3BhdGNoZXMgYSAzLXN0ZXAgY3VzdG9tIHdvcmtmbG93IHRocm91Z2ggdGhlIHJlYWwgcGlwZWxpbmUuXG4gKlxuICogQ3JlYXRlcyBhIHJlYWwgcnVuIGRpcmVjdG9yeSB3aXRoIEdSQVBILnlhbWwsIG1vY2tzIExvb3BEZXBzIG1pbmltYWxseSxcbiAqIGFuZCB2ZXJpZmllcyBhbGwgMyBzdGVwcyBjb21wbGV0ZSBpbiBkZXBlbmRlbmN5IG9yZGVyLlxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBta2R0ZW1wU3luYywgcm1TeW5jLCBleGlzdHNTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQgeyBhdXRvTG9vcCB9IGZyb20gXCIuLi9hdXRvL2xvb3AuanNcIjtcbmltcG9ydCB7IHJlc29sdmVBZ2VudEVuZCwgX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCwgX3Jlc2V0UGVuZGluZ1Jlc29sdmUgfSBmcm9tIFwiLi4vYXV0by9yZXNvbHZlLmpzXCI7XG5pbXBvcnQgdHlwZSB7IExvb3BEZXBzIH0gZnJvbSBcIi4uL2F1dG8vbG9vcC1kZXBzLmpzXCI7XG5pbXBvcnQgeyBXb3JrdHJlZVN0YXRlUHJvamVjdGlvbiB9IGZyb20gXCIuLi93b3JrdHJlZS1zdGF0ZS1wcm9qZWN0aW9uLmpzXCI7XG5pbXBvcnQgdHlwZSB7IFNlc3Npb25Mb2NrU3RhdHVzIH0gZnJvbSBcIi4uL3Nlc3Npb24tbG9jay5qc1wiO1xuaW1wb3J0IHsgd3JpdGVHcmFwaCwgcmVhZEdyYXBoLCB0eXBlIFdvcmtmbG93R3JhcGgsIHR5cGUgR3JhcGhTdGVwIH0gZnJvbSBcIi4uL2dyYXBoLnRzXCI7XG5pbXBvcnQgeyB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHN0cmluZ2lmeSB9IGZyb20gXCJ5YW1sXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCB0bXBEaXJzOiBzdHJpbmdbXSA9IFtdO1xuXG5mdW5jdGlvbiBtYWtlVG1wRGlyKCk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwibG9vcC1pbnRlZy1cIikpO1xuICB0bXBEaXJzLnB1c2goZGlyKTtcbiAgcmV0dXJuIGRpcjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZU5leHRBZ2VudEVuZCh0aW1lb3V0TXMgPSAzXzAwMCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyB0aW1lb3V0TXM7XG4gIHdoaWxlICghX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCgpKSB7XG4gICAgaWYgKERhdGUubm93KCkgPiBkZWFkbGluZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVGltZWQgb3V0IHdhaXRpbmcgZm9yIHBlbmRpbmcgYWdlbnRfZW5kIHJlc29sdmVyXCIpO1xuICAgIH1cbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1KSk7XG4gIH1cbiAgcmVzb2x2ZUFnZW50RW5kKHsgbWVzc2FnZXM6IFt7IHJvbGU6IFwiYXNzaXN0YW50XCIgfV0gfSk7XG59XG5cbmFmdGVyRWFjaCgoKSA9PiB7XG4gIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG4gIGZvciAoY29uc3QgZCBvZiB0bXBEaXJzKSB7XG4gICAgdHJ5IHsgcm1TeW5jKGQsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSwgbWF4UmV0cmllczogMywgcmV0cnlEZWxheTogMTAwIH0pOyB9IGNhdGNoIHsgLyogV2luZG93cyBFUEVSTSBcdTIwMTQgT1MgY2xlYW5zIHVwIHRlbXAgZGlycyAqLyB9XG4gIH1cbiAgdG1wRGlycy5sZW5ndGggPSAwO1xufSk7XG5cbmZ1bmN0aW9uIG1ha2VTdGVwKG92ZXJyaWRlczogUGFydGlhbDxHcmFwaFN0ZXA+ICYgeyBpZDogc3RyaW5nIH0pOiBHcmFwaFN0ZXAge1xuICByZXR1cm4ge1xuICAgIHRpdGxlOiBvdmVycmlkZXMuaWQsXG4gICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICBwcm9tcHQ6IGBEbyAke292ZXJyaWRlcy5pZH1gLFxuICAgIGRlcGVuZHNPbjogW10sXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG5mdW5jdGlvbiBtYWtlR3JhcGgoc3RlcHM6IEdyYXBoU3RlcFtdLCBuYW1lID0gXCJ0ZXN0LXdmXCIpOiBXb3JrZmxvd0dyYXBoIHtcbiAgcmV0dXJuIHtcbiAgICBzdGVwcyxcbiAgICBtZXRhZGF0YTogeyBuYW1lLCBjcmVhdGVkQXQ6IFwiMjAyNi0wMS0wMVQwMDowMDowMC4wMDBaXCIgfSxcbiAgfTtcbn1cblxuLyoqIFdyaXRlIGEgbWluaW1hbCBERUZJTklUSU9OLnlhbWwgdGhhdCBtYXRjaGVzIHRoZSBncmFwaCBzdGVwcyAobmVlZGVkIGJ5IHJlc29sdmVEaXNwYXRjaCBzaW5jZSBTMDYpLiAqL1xuZnVuY3Rpb24gd3JpdGVEZWZpbml0aW9uKHJ1bkRpcjogc3RyaW5nLCBzdGVwczogR3JhcGhTdGVwW10sIG5hbWUgPSBcInRlc3Qtd2ZcIik6IHZvaWQge1xuICBjb25zdCBkZWYgPSB7XG4gICAgdmVyc2lvbjogMSxcbiAgICBuYW1lLFxuICAgIGRlc2NyaXB0aW9uOiBgVGVzdCB3b3JrZmxvdzogJHtuYW1lfWAsXG4gICAgc3RlcHM6IHN0ZXBzLm1hcCgocykgPT4gKHtcbiAgICAgIGlkOiBzLmlkLFxuICAgICAgbmFtZTogcy50aXRsZSA/PyBzLmlkLFxuICAgICAgcHJvbXB0OiBzLnByb21wdCA/PyBgRG8gJHtzLmlkfWAsXG4gICAgICBwcm9kdWNlczogYCR7cy5pZH0vb3V0cHV0Lm1kYCxcbiAgICAgIC4uLihzLmRlcGVuZHNPbj8ubGVuZ3RoID8geyByZXF1aXJlczogcy5kZXBlbmRzT24gfSA6IHt9KSxcbiAgICB9KSksXG4gIH07XG4gIHdyaXRlRmlsZVN5bmMoam9pbihydW5EaXIsIFwiREVGSU5JVElPTi55YW1sXCIpLCBzdHJpbmdpZnkoZGVmKSk7XG59XG5cbmZ1bmN0aW9uIG1ha2VNb2NrQ3R4KCkge1xuICByZXR1cm4ge1xuICAgIHVpOiB7IG5vdGlmeTogKCkgPT4ge30sIHNldFN0YXR1czogKCkgPT4ge30gfSxcbiAgICBtb2RlbDogeyBpZDogXCJ0ZXN0LW1vZGVsXCIgfSxcbiAgICBzZXNzaW9uTWFuYWdlcjogeyBnZXRTZXNzaW9uRmlsZTogKCkgPT4gXCIvdG1wL3Nlc3Npb24uanNvblwiIH0sXG4gIH0gYXMgYW55O1xufVxuXG5mdW5jdGlvbiBtYWtlTW9ja1BpKCkge1xuICBjb25zdCBjYWxsczogdW5rbm93bltdID0gW107XG4gIHJldHVybiB7XG4gICAgc2VuZE1lc3NhZ2U6ICguLi5hcmdzOiB1bmtub3duW10pID0+IHtcbiAgICAgIGNhbGxzLnB1c2goYXJncyk7XG4gICAgfSxcbiAgICBjYWxscyxcbiAgfSBhcyBhbnk7XG59XG5cbmZ1bmN0aW9uIG1ha2VMb29wU2Vzc2lvbihvdmVycmlkZXM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICByZXR1cm4ge1xuICAgIGFjdGl2ZTogdHJ1ZSxcbiAgICB2ZXJib3NlOiBmYWxzZSxcbiAgICBzdGVwTW9kZTogZmFsc2UsXG4gICAgcGF1c2VkOiBmYWxzZSxcbiAgICBiYXNlUGF0aDogXCIvdG1wL3Byb2plY3RcIixcbiAgICBvcmlnaW5hbEJhc2VQYXRoOiBcIlwiLFxuICAgIGN1cnJlbnRNaWxlc3RvbmVJZDogbnVsbCxcbiAgICBjdXJyZW50VW5pdDogbnVsbCxcbiAgICBjdXJyZW50VW5pdFJvdXRpbmc6IG51bGwsXG4gICAgY29tcGxldGVkVW5pdHM6IFtdLFxuICAgIHJlc291cmNlVmVyc2lvbk9uU3RhcnQ6IG51bGwsXG4gICAgbGFzdFByb21wdENoYXJDb3VudDogdW5kZWZpbmVkLFxuICAgIGxhc3RCYXNlbGluZUNoYXJDb3VudDogdW5kZWZpbmVkLFxuICAgIGxhc3RCdWRnZXRBbGVydExldmVsOiAwLFxuICAgIHBlbmRpbmdWZXJpZmljYXRpb25SZXRyeTogbnVsbCxcbiAgICBwZW5kaW5nQ3Jhc2hSZWNvdmVyeTogbnVsbCxcbiAgICBwZW5kaW5nUXVpY2tUYXNrczogW10sXG4gICAgc2lkZWNhclF1ZXVlOiBbXSxcbiAgICBhdXRvTW9kZVN0YXJ0TW9kZWw6IG51bGwsXG4gICAgdW5pdERpc3BhdGNoQ291bnQ6IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCksXG4gICAgdW5pdExpZmV0aW1lRGlzcGF0Y2hlczogbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKSxcbiAgICB1bml0UmVjb3ZlcnlDb3VudDogbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKSxcbiAgICB2ZXJpZmljYXRpb25SZXRyeUNvdW50OiBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpLFxuICAgIGdpdFNlcnZpY2U6IG51bGwsXG4gICAgYXV0b1N0YXJ0VGltZTogRGF0ZS5ub3coKSxcbiAgICBhY3RpdmVFbmdpbmVJZDogbnVsbCxcbiAgICBhY3RpdmVSdW5EaXI6IG51bGwsXG4gICAgcmV3cml0ZUF0dGVtcHRDb3VudDogMCxcbiAgICBjbWRDdHg6IHtcbiAgICAgIG5ld1Nlc3Npb246ICgpID0+IFByb21pc2UucmVzb2x2ZSh7IGNhbmNlbGxlZDogZmFsc2UgfSksXG4gICAgICBnZXRDb250ZXh0VXNhZ2U6ICgpID0+ICh7IHBlcmNlbnQ6IDEwLCB0b2tlbnM6IDEwMDAsIGxpbWl0OiAxMDAwMCB9KSxcbiAgICB9LFxuICAgIGNsZWFyVGltZXJzOiAoKSA9PiB7fSxcbiAgICBsb2NrQmFzZVBhdGg6IFwiL3RtcC9wcm9qZWN0XCIsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9IGFzIGFueTtcbn1cblxuZnVuY3Rpb24gbWFrZU1vY2tEZXBzKG92ZXJyaWRlcz86IFBhcnRpYWw8TG9vcERlcHM+KTogTG9vcERlcHMgJiB7IGNhbGxMb2c6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjYWxsTG9nOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGNvbnN0IGJhc2VEZXBzOiBMb29wRGVwcyA9IHtcbiAgICBsb2NrQmFzZTogKCkgPT4gXCIvdG1wL3Rlc3QtbG9ja1wiLFxuICAgIGJ1aWxkU25hcHNob3RPcHRzOiAoKSA9PiAoe30pLFxuICAgIHN0b3BBdXRvOiBhc3luYyAoX2N0eCwgX3BpLCByZWFzb24pID0+IHtcbiAgICAgIGNhbGxMb2cucHVzaChgc3RvcEF1dG86JHtyZWFzb24gPz8gXCJuby1yZWFzb25cIn1gKTtcbiAgICB9LFxuICAgIHBhdXNlQXV0bzogYXN5bmMgKCkgPT4ge1xuICAgICAgY2FsbExvZy5wdXNoKFwicGF1c2VBdXRvXCIpO1xuICAgIH0sXG4gICAgY2xlYXJVbml0VGltZW91dDogKCkgPT4ge30sXG4gICAgdXBkYXRlUHJvZ3Jlc3NXaWRnZXQ6ICgpID0+IHt9LFxuICAgIHN5bmNDbXV4U2lkZWJhcjogKCkgPT4ge30sXG4gICAgbG9nQ211eEV2ZW50OiAoKSA9PiB7fSxcbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzOiAoKSA9PiB7fSxcbiAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4ge1xuICAgICAgY2FsbExvZy5wdXNoKFwiZGVyaXZlU3RhdGVcIik7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiV29ya2Zsb3dcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgICByZWdpc3RyeTogW10sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIH0gYXMgYW55O1xuICAgIH0sXG4gICAgcmVidWlsZFN0YXRlOiBhc3luYyAoKSA9PiB7fSxcbiAgICBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXM6ICgpID0+IHVuZGVmaW5lZCxcbiAgICBwcmVEaXNwYXRjaEhlYWx0aEdhdGU6IGFzeW5jICgpID0+ICh7IHByb2NlZWQ6IHRydWUsIGZpeGVzQXBwbGllZDogW10gfSksXG4gICAgY2hlY2tSZXNvdXJjZXNTdGFsZTogKCkgPT4gbnVsbCxcbiAgICB2YWxpZGF0ZVNlc3Npb25Mb2NrOiAoKSA9PiAoeyB2YWxpZDogdHJ1ZSB9IGFzIFNlc3Npb25Mb2NrU3RhdHVzKSxcbiAgICB1cGRhdGVTZXNzaW9uTG9jazogKCkgPT4ge30sXG4gICAgaGFuZGxlTG9zdFNlc3Npb25Mb2NrOiAoKSA9PiB7fSxcbiAgICBzZW5kRGVza3RvcE5vdGlmaWNhdGlvbjogKCkgPT4ge30sXG4gICAgc2V0QWN0aXZlTWlsZXN0b25lSWQ6ICgpID0+IHt9LFxuICAgIHBydW5lUXVldWVPcmRlcjogKCkgPT4ge30sXG4gICAgaXNJbkF1dG9Xb3JrdHJlZTogKCkgPT4gZmFsc2UsXG4gICAgc2hvdWxkVXNlV29ya3RyZWVJc29sYXRpb246ICgpID0+IGZhbHNlLFxuICAgIHRlYXJkb3duQXV0b1dvcmt0cmVlOiAoKSA9PiB7fSxcbiAgICBjcmVhdGVBdXRvV29ya3RyZWU6ICgpID0+IFwiL3RtcC93dFwiLFxuICAgIGNhcHR1cmVJbnRlZ3JhdGlvbkJyYW5jaDogKCkgPT4ge30sXG4gICAgZ2V0SXNvbGF0aW9uTW9kZTogKCkgPT4gXCJub25lXCIsXG4gICAgZ2V0Q3VycmVudEJyYW5jaDogKCkgPT4gXCJtYWluXCIsXG4gICAgYXV0b1dvcmt0cmVlQnJhbmNoOiAoKSA9PiBcImF1dG8vTTAwMVwiLFxuICAgIHJlc29sdmVNaWxlc3RvbmVGaWxlOiAoKSA9PiBudWxsLFxuICAgIHJlY29uY2lsZU1lcmdlU3RhdGU6ICgpID0+IFwiY2xlYW5cIixcbiAgICBwcmVmbGlnaHRDbGVhblJvb3Q6ICgpID0+ICh7IHN0YXNoUHVzaGVkOiBmYWxzZSwgc3VtbWFyeTogXCJcIiB9KSxcbiAgICBwb3N0ZmxpZ2h0UG9wU3Rhc2g6ICgpID0+ICh7XG4gICAgICByZXN0b3JlZDogdHJ1ZSxcbiAgICAgIG5lZWRzTWFudWFsUmVjb3Zlcnk6IGZhbHNlLFxuICAgICAgbWVzc2FnZTogXCJyZXN0b3JlZFwiLFxuICAgIH0pLFxuICAgIGdldExlZGdlcjogKCkgPT4gbnVsbCxcbiAgICBnZXRQcm9qZWN0VG90YWxzOiAoKSA9PiAoeyBjb3N0OiAwIH0pLFxuICAgIGZvcm1hdENvc3Q6IChjOiBudW1iZXIpID0+IGAkJHtjLnRvRml4ZWQoMil9YCxcbiAgICBnZXRCdWRnZXRBbGVydExldmVsOiAoKSA9PiAwLFxuICAgIGdldE5ld0J1ZGdldEFsZXJ0TGV2ZWw6ICgpID0+IDAsXG4gICAgZ2V0QnVkZ2V0RW5mb3JjZW1lbnRBY3Rpb246ICgpID0+IFwibm9uZVwiLFxuICAgIGdldE1hbmlmZXN0U3RhdHVzOiBhc3luYyAoKSA9PiBudWxsLFxuICAgIGNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0OiBhc3luYyAoKSA9PiBudWxsLFxuICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4ge1xuICAgICAgY2FsbExvZy5wdXNoKFwicmVzb2x2ZURpc3BhdGNoXCIpO1xuICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLCB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsIHByb21wdDogXCJ1bnVzZWRcIiB9O1xuICAgIH0sXG4gICAgcnVuUHJlRGlzcGF0Y2hIb29rczogKCkgPT4gKHsgZmlyZWRIb29rczogW10sIGFjdGlvbjogXCJwcm9jZWVkXCIgfSksXG4gICAgZ2V0UHJpb3JTbGljZUNvbXBsZXRpb25CbG9ja2VyOiAoKSA9PiBudWxsLFxuICAgIGdldE1haW5CcmFuY2g6ICgpID0+IFwibWFpblwiLFxuICAgIGNsb3Nlb3V0VW5pdDogYXN5bmMgKCkgPT4ge30sXG4gICAgcmVjb3JkT3V0Y29tZTogKCkgPT4ge30sXG4gICAgd3JpdGVMb2NrOiAoKSA9PiB7fSxcbiAgICBjYXB0dXJlQXZhaWxhYmxlU2tpbGxzOiAoKSA9PiB7fSxcbiAgICBlbnN1cmVQcmVjb25kaXRpb25zOiAoKSA9PiB7fSxcbiAgICB1cGRhdGVTbGljZVByb2dyZXNzQ2FjaGU6ICgpID0+IHt9LFxuICAgIHNlbGVjdEFuZEFwcGx5TW9kZWw6IGFzeW5jICgpID0+ICh7IHJvdXRpbmc6IG51bGwsIGFwcGxpZWRNb2RlbDogbnVsbCB9KSxcbiAgICByZXNvbHZlTW9kZWxJZDogKCkgPT4gdW5kZWZpbmVkLFxuICAgIHN0YXJ0VW5pdFN1cGVydmlzaW9uOiAoKSA9PiB7fSxcbiAgICBnZXREZWVwRGlhZ25vc3RpYzogKCkgPT4gbnVsbCxcbiAgICBpc0RiQXZhaWxhYmxlOiAoKSA9PiBmYWxzZSxcbiAgICByZW9yZGVyRm9yQ2FjaGluZzogKHA6IHN0cmluZykgPT4gcCxcbiAgICBleGlzdHNTeW5jOiAocDogc3RyaW5nKSA9PiBleGlzdHNTeW5jKHApLFxuICAgIHJlYWRGaWxlU3luYzogKCkgPT4gXCJcIixcbiAgICBhdG9taWNXcml0ZVN5bmM6ICgpID0+IHt9LFxuICAgIEdpdFNlcnZpY2VJbXBsOiBjbGFzcyB7fSBhcyBhbnksXG4gICAgbGlmZWN5Y2xlOiB7XG4gICAgICBlbnRlck1pbGVzdG9uZTogKCkgPT4gKHsgb2s6IHRydWUsIG1vZGU6IFwibm9uZVwiLCBwYXRoOiBcIi90bXAvcHJvamVjdFwiIH0pLFxuICAgICAgZXhpdE1pbGVzdG9uZTogKF9taWQ6IHN0cmluZywgb3B0czogeyBtZXJnZTogYm9vbGVhbiB9KSA9PiAoe1xuICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgbWVyZ2VkOiBvcHRzLm1lcmdlLFxuICAgICAgICBjb2RlRmlsZXNDaGFuZ2VkOiBmYWxzZSxcbiAgICAgIH0pLFxuICAgICAgZGVncmFkZVRvQnJhbmNoTW9kZTogKCkgPT4ge30sXG4gICAgICByZXN0b3JlVG9Qcm9qZWN0Um9vdDogKCkgPT4ge30sXG4gICAgICBpc0luTWlsZXN0b25lOiAoKSA9PiB0cnVlLFxuICAgICAgZ2V0Q3VycmVudE1pbGVzdG9uZUlmQW55OiAoKSA9PiBcIk0wMDFcIixcbiAgICB9IGFzIGFueSxcbiAgICB3b3JrdHJlZVByb2plY3Rpb246IG5ldyBXb3JrdHJlZVN0YXRlUHJvamVjdGlvbigpLFxuICAgIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiBcImNvbnRpbnVlXCIgYXMgY29uc3QsXG4gICAgcnVuUG9zdFVuaXRWZXJpZmljYXRpb246IGFzeW5jICgpID0+IFwiY29udGludWVcIiBhcyBjb25zdCxcbiAgICBwb3N0VW5pdFBvc3RWZXJpZmljYXRpb246IGFzeW5jICgpID0+IFwiY29udGludWVcIiBhcyBjb25zdCxcbiAgICBnZXRTZXNzaW9uRmlsZTogKCkgPT4gXCIvdG1wL3Nlc3Npb24uanNvblwiLFxuICAgIGVtaXRKb3VybmFsRXZlbnQ6IChlbnRyeSkgPT4ge1xuICAgICAgY2FsbExvZy5wdXNoKGBqb3VybmFsOiR7ZW50cnkuZXZlbnRUeXBlfWApO1xuICAgIH0sXG4gIH07XG5cbiAgcmV0dXJuIHsgLi4uYmFzZURlcHMsIC4uLm92ZXJyaWRlcywgY2FsbExvZyB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiQ3VzdG9tIGVuZ2luZSBsb29wIGludGVncmF0aW9uXCIsICgpID0+IHtcbiAgaXQoXCJkaXNwYXRjaGVzIGEgMy1zdGVwIHdvcmtmbG93IHRocm91Z2ggYXV0b0xvb3AgYW5kIGFsbCBzdGVwcyBjb21wbGV0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICAgIC8vIENyZWF0ZSBhIHJlYWwgcnVuIGRpcmVjdG9yeSB3aXRoIDMgc3RlcHM6IGEgXHUyMTkyIGIgXHUyMTkyIGNcbiAgICBjb25zdCBydW5EaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgY29uc3QgZ3JhcGggPSBtYWtlR3JhcGgoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJzdGVwLWFcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC1iXCIsIGRlcGVuZHNPbjogW1wic3RlcC1hXCJdIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJzdGVwLWNcIiwgZGVwZW5kc09uOiBbXCJzdGVwLWJcIl0gfSksXG4gICAgXSwgXCJpbnRlZy10ZXN0XCIpO1xuICAgIHdyaXRlR3JhcGgocnVuRGlyLCBncmFwaCk7XG4gICAgd3JpdGVEZWZpbml0aW9uKHJ1bkRpciwgZ3JhcGguc3RlcHMsIFwiaW50ZWctdGVzdFwiKTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG5cbiAgICBsZXQgdW5pdENvdW50ID0gMDtcblxuICAgIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oe1xuICAgICAgYWN0aXZlRW5naW5lSWQ6IFwiY3VzdG9tXCIsXG4gICAgICBhY3RpdmVSdW5EaXI6IHJ1bkRpcixcbiAgICAgIGJhc2VQYXRoOiBydW5EaXIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICAgIHN0b3BBdXRvOiBhc3luYyAoX2N0eCwgX3BpLCByZWFzb24pID0+IHtcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goYHN0b3BBdXRvOiR7cmVhc29uID8/IFwibm8tcmVhc29uXCJ9YCk7XG4gICAgICAgIHMuYWN0aXZlID0gZmFsc2U7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgLy8gU3RhcnQgYXV0b0xvb3AgXHUyMDE0IGl0IHdpbGwgYmxvY2sgaW5zaWRlIHJ1blVuaXQgYXdhaXRpbmcgcmVzb2x2ZUFnZW50RW5kXG4gICAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICAgIC8vIEVhY2ggaXRlcmF0aW9uOiB0aGUgY3VzdG9tIGVuZ2luZSBwYXRoIGRlcml2ZXMgc3RhdGUgXHUyMTkyIHJlc29sdmVzIGRpc3BhdGNoIFx1MjE5MlxuICAgIC8vIHJ1bnMgZ3VhcmRzIFx1MjE5MiBydW5zIHJ1blVuaXRQaGFzZSAod2hpY2ggY2FsbHMgcnVuVW5pdCkgXHUyMTkyIHdlIHJlc29sdmUgXHUyMTkyXG4gICAgLy8gZW5naW5lLnJlY29uY2lsZSBtYXJrcyB0aGUgc3RlcCBjb21wbGV0ZSBcdTIxOTIgbG9vcCBjb250aW51ZXMuXG4gICAgLy8gV2UgbmVlZCB0byByZXNvbHZlIHJlc29sdmVBZ2VudEVuZCBmb3IgZWFjaCBzdGVwLlxuXG4gICAgLy8gU3RlcCAxOiBzdGVwLWFcbiAgICB1bml0Q291bnQrKztcbiAgICBhd2FpdCByZXNvbHZlTmV4dEFnZW50RW5kKCk7XG5cbiAgICAvLyBTdGVwIDI6IHN0ZXAtYlxuICAgIHVuaXRDb3VudCsrO1xuICAgIGF3YWl0IHJlc29sdmVOZXh0QWdlbnRFbmQoKTtcblxuICAgIC8vIFN0ZXAgMzogc3RlcC1jXG4gICAgdW5pdENvdW50Kys7XG4gICAgYXdhaXQgcmVzb2x2ZU5leHRBZ2VudEVuZCgpO1xuXG4gICAgLy8gQWZ0ZXIgc3RlcC1jIGNvbXBsZXRlcywgZW5naW5lLnJlY29uY2lsZSBtYXJrcyBpdCBjb21wbGV0ZSwgdGhlblxuICAgIC8vIG5leHQgZGVyaXZlU3RhdGUgc2VlcyBpc0NvbXBsZXRlPXRydWUgXHUyMTkyIHN0b3BBdXRvIFx1MjE5MiBsb29wIGV4aXRzXG4gICAgYXdhaXQgbG9vcFByb21pc2U7XG5cbiAgICAvLyBWZXJpZnkgR1JBUEgueWFtbCBzaG93cyBhbGwgMyBzdGVwcyBjb21wbGV0ZVxuICAgIGNvbnN0IGZpbmFsR3JhcGggPSByZWFkR3JhcGgocnVuRGlyKTtcbiAgICBhc3NlcnQuZXF1YWwoZmluYWxHcmFwaC5zdGVwcy5sZW5ndGgsIDMsIFwiU2hvdWxkIGhhdmUgMyBzdGVwc1wiKTtcbiAgICBmb3IgKGNvbnN0IHN0ZXAgb2YgZmluYWxHcmFwaC5zdGVwcykge1xuICAgICAgYXNzZXJ0LmVxdWFsKHN0ZXAuc3RhdHVzLCBcImNvbXBsZXRlXCIsIGBTdGVwICR7c3RlcC5pZH0gc2hvdWxkIGJlIGNvbXBsZXRlLCBnb3QgJHtzdGVwLnN0YXR1c31gKTtcbiAgICAgIGFzc2VydC5vayhzdGVwLmZpbmlzaGVkQXQsIGBTdGVwICR7c3RlcC5pZH0gc2hvdWxkIGhhdmUgZmluaXNoZWRBdCB0aW1lc3RhbXBgKTtcbiAgICB9XG5cbiAgICAvLyBWZXJpZnkgZXhhY3RseSAzIHVuaXRzIHdlcmUgZGlzcGF0Y2hlZCAoMyBwaS5zZW5kTWVzc2FnZSBjYWxscylcbiAgICBhc3NlcnQuZXF1YWwocGkuY2FsbHMubGVuZ3RoLCAzLCBgU2hvdWxkIGhhdmUgZGlzcGF0Y2hlZCBleGFjdGx5IDMgdW5pdHMsIGdvdCAke3BpLmNhbGxzLmxlbmd0aH1gKTtcblxuICAgIC8vIFZlcmlmeSB0aGUgbG9vcCBzdG9wcGVkIGJlY2F1c2UgdGhlIHdvcmtmbG93IGNvbXBsZXRlZFxuICAgIGNvbnN0IHN0b3BFbnRyeSA9IGRlcHMuY2FsbExvZy5maW5kKChlOiBzdHJpbmcpID0+IGUuc3RhcnRzV2l0aChcInN0b3BBdXRvOlwiKSk7XG4gICAgYXNzZXJ0Lm9rKHN0b3BFbnRyeSwgXCJzdG9wQXV0byBzaG91bGQgaGF2ZSBiZWVuIGNhbGxlZFwiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBzdG9wRW50cnkhLmluY2x1ZGVzKFwiV29ya2Zsb3cgY29tcGxldGVcIiksXG4gICAgICBgc3RvcEF1dG8gcmVhc29uIHNob3VsZCBpbmNsdWRlIFwiV29ya2Zsb3cgY29tcGxldGVcIiwgZ290OiAke3N0b3BFbnRyeX1gLFxuICAgICk7XG5cbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBkZXBzLmNhbGxMb2cuZmlsdGVyKChlOiBzdHJpbmcpID0+IGUgPT09IFwiZGVyaXZlU3RhdGVcIikubGVuZ3RoLFxuICAgICAgMyxcbiAgICAgIFwiY3VzdG9tIGVuZ2luZSBzaG91bGQgc3RvcCBpbW1lZGlhdGVseSBhZnRlciBhIG1pbGVzdG9uZS1jb21wbGV0ZSByZWNvbmNpbGVcIixcbiAgICApO1xuXG4gICAgLy8gVmVyaWZ5IGRldiBwYXRoIHdhcyBOT1QgdXNlZCAocmVzb2x2ZURpc3BhdGNoIHNob3VsZCBub3QgYXBwZWFyKVxuICAgIGFzc2VydC5vayhcbiAgICAgICFkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJyZXNvbHZlRGlzcGF0Y2hcIiksXG4gICAgICBcIkN1c3RvbSBlbmdpbmUgcGF0aCBzaG91bGQgc2tpcCByZXNvbHZlRGlzcGF0Y2ggKGRldiBwYXRoIG5vdCB0YWtlbilcIixcbiAgICApO1xuICB9KTtcblxuICBpdChcInN0b3BzIHdoZW4gZW5naW5lIHJlcG9ydHMgaXNDb21wbGV0ZSBvbiBmaXJzdCBkZXJpdmVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgICAvLyBDcmVhdGUgYSBydW4gZGlyZWN0b3J5IHdoZXJlIGFsbCBzdGVwcyBhcmUgYWxyZWFkeSBjb21wbGV0ZVxuICAgIGNvbnN0IHJ1bkRpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcInN0ZXAtYVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KSxcbiAgICBdLCBcImFscmVhZHktZG9uZVwiKTtcbiAgICB3cml0ZUdyYXBoKHJ1bkRpciwgZ3JhcGgpO1xuICAgIHdyaXRlRGVmaW5pdGlvbihydW5EaXIsIGdyYXBoLnN0ZXBzLCBcImFscmVhZHktZG9uZVwiKTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG5cbiAgICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKHtcbiAgICAgIGFjdGl2ZUVuZ2luZUlkOiBcImN1c3RvbVwiLFxuICAgICAgYWN0aXZlUnVuRGlyOiBydW5EaXIsXG4gICAgICBiYXNlUGF0aDogcnVuRGlyLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgICBzdG9wQXV0bzogYXN5bmMgKF9jdHgsIF9waSwgcmVhc29uKSA9PiB7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKGBzdG9wQXV0bzoke3JlYXNvbiA/PyBcIm5vLXJlYXNvblwifWApO1xuICAgICAgICBzLmFjdGl2ZSA9IGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGF3YWl0IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gICAgLy8gTm8gdW5pdHMgc2hvdWxkIGhhdmUgYmVlbiBkaXNwYXRjaGVkXG4gICAgYXNzZXJ0LmVxdWFsKHBpLmNhbGxzLmxlbmd0aCwgMCwgXCJTaG91bGQgbm90IGRpc3BhdGNoIHVuaXRzIGZvciBjb21wbGV0ZSB3b3JrZmxvd1wiKTtcblxuICAgIC8vIFNob3VsZCBzdG9wIHdpdGggXCJXb3JrZmxvdyBjb21wbGV0ZVwiIHJlYXNvblxuICAgIGNvbnN0IHN0b3BFbnRyeSA9IGRlcHMuY2FsbExvZy5maW5kKChlOiBzdHJpbmcpID0+IGUuc3RhcnRzV2l0aChcInN0b3BBdXRvOlwiKSk7XG4gICAgYXNzZXJ0Lm9rKHN0b3BFbnRyeT8uaW5jbHVkZXMoXCJXb3JrZmxvdyBjb21wbGV0ZVwiKSwgXCJTaG91bGQgc3RvcCB3aXRoICdXb3JrZmxvdyBjb21wbGV0ZSdcIik7XG4gIH0pO1xuXG4gIGl0KFwiZmluYWxpemVzIGN1c3RvbS1lbmdpbmUgY29tcGxldGUgdHVybnMgYW5kIGNsZWFycyBjdXJyZW50IHR1cm4gc3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICAgIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgICBjb25zdCBydW5EaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgY29uc3QgZ3JhcGggPSBtYWtlR3JhcGgoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJzdGVwLWFcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfSksXG4gICAgXSwgXCJhbHJlYWR5LWRvbmVcIik7XG4gICAgd3JpdGVHcmFwaChydW5EaXIsIGdyYXBoKTtcbiAgICB3cml0ZURlZmluaXRpb24ocnVuRGlyLCBncmFwaC5zdGVwcywgXCJhbHJlYWR5LWRvbmVcIik7XG5cbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAgIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oe1xuICAgICAgYWN0aXZlRW5naW5lSWQ6IFwiY3VzdG9tXCIsXG4gICAgICBhY3RpdmVSdW5EaXI6IHJ1bkRpcixcbiAgICAgIGJhc2VQYXRoOiBydW5EaXIsXG4gICAgfSk7XG4gICAgY29uc3QgdHVyblJlc3VsdHM6IEFycmF5PHsgc3RhdHVzOiBzdHJpbmc7IGZhaWx1cmVDbGFzczogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PiA9IFtdO1xuICAgIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgICAgc3RvcEF1dG86IGFzeW5jIChfY3R4LCBfcGksIHJlYXNvbikgPT4ge1xuICAgICAgICBkZXBzLmNhbGxMb2cucHVzaChgc3RvcEF1dG86JHtyZWFzb24gPz8gXCJuby1yZWFzb25cIn1gKTtcbiAgICAgICAgcy5hY3RpdmUgPSBmYWxzZTtcbiAgICAgIH0sXG4gICAgICB1b2tPYnNlcnZlcjoge1xuICAgICAgICBvblR1cm5TdGFydDogKCkgPT4ge30sXG4gICAgICAgIG9uVHVyblJlc3VsdDogKHJlc3VsdCkgPT4ge1xuICAgICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKGB0dXJuUmVzdWx0OiR7cmVzdWx0LnN0YXR1c31gKTtcbiAgICAgICAgICB0dXJuUmVzdWx0cy5wdXNoKHtcbiAgICAgICAgICAgIHN0YXR1czogcmVzdWx0LnN0YXR1cyxcbiAgICAgICAgICAgIGZhaWx1cmVDbGFzczogcmVzdWx0LmZhaWx1cmVDbGFzcyxcbiAgICAgICAgICAgIGVycm9yOiByZXN1bHQuZXJyb3IsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0sXG4gICAgICAgIG9uUGhhc2VSZXN1bHQ6ICgpID0+IHt9LFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGF3YWl0IGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpO1xuXG4gICAgYXNzZXJ0LmRlZXBFcXVhbCh0dXJuUmVzdWx0cywgW3sgc3RhdHVzOiBcImNvbXBsZXRlZFwiLCBmYWlsdXJlQ2xhc3M6IFwibm9uZVwiLCBlcnJvcjogdW5kZWZpbmVkIH1dKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJqb3VybmFsOml0ZXJhdGlvbi1lbmRcIiksXG4gICAgICBgY29tcGxldGUgd29ya2Zsb3cgc2hvdWxkIGVtaXQgaXRlcmF0aW9uLWVuZDsgbG9nPSR7ZGVwcy5jYWxsTG9nLmpvaW4oXCIsXCIpfWAsXG4gICAgKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBkZXBzLmNhbGxMb2cuaW5kZXhPZihcInR1cm5SZXN1bHQ6Y29tcGxldGVkXCIpIDwgZGVwcy5jYWxsTG9nLmluZGV4T2YoXCJzdG9wQXV0bzpXb3JrZmxvdyBjb21wbGV0ZVwiKSxcbiAgICAgIGB0dXJuIHNob3VsZCBmaW5hbGl6ZSBiZWZvcmUgc3RvcEF1dG87IGxvZz0ke2RlcHMuY2FsbExvZy5qb2luKFwiLFwiKX1gLFxuICAgICk7XG4gICAgYXNzZXJ0LmVxdWFsKHMuY3VycmVudFRyYWNlSWQsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChzLmN1cnJlbnRUdXJuSWQsIG51bGwpO1xuICAgIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDAsIFwiY29tcGxldGUgd29ya2Zsb3cgc2hvdWxkIG5vdCBkaXNwYXRjaCB3b3JrXCIpO1xuICB9KTtcblxuICBpdChcInN0b3BzIGJsb2NrZWQgY3VzdG9tIHdvcmtmbG93cyBhbmQgY2xlYXJzIGN1cnJlbnQgdHVybiBzdGF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICAgIGNvbnN0IHJ1bkRpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcInN0ZXAtYVwiLCBkZXBlbmRzT246IFtcInN0ZXAtYlwiXSB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC1iXCIsIGRlcGVuZHNPbjogW1wic3RlcC1hXCJdIH0pLFxuICAgIF0sIFwiYmxvY2tlZC13b3JrZmxvd1wiKTtcbiAgICB3cml0ZUdyYXBoKHJ1bkRpciwgZ3JhcGgpO1xuICAgIHdyaXRlRGVmaW5pdGlvbihydW5EaXIsIGdyYXBoLnN0ZXBzLCBcImJsb2NrZWQtd29ya2Zsb3dcIik7XG5cbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAgIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oe1xuICAgICAgYWN0aXZlRW5naW5lSWQ6IFwiY3VzdG9tXCIsXG4gICAgICBhY3RpdmVSdW5EaXI6IHJ1bkRpcixcbiAgICAgIGJhc2VQYXRoOiBydW5EaXIsXG4gICAgfSk7XG4gICAgY29uc3QgdHVyblJlc3VsdHM6IEFycmF5PHsgc3RhdHVzOiBzdHJpbmc7IGZhaWx1cmVDbGFzczogc3RyaW5nOyBlcnJvcj86IHN0cmluZyB9PiA9IFtdO1xuICAgIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoe1xuICAgICAgc3RvcEF1dG86IGFzeW5jIChfY3R4LCBfcGksIHJlYXNvbikgPT4ge1xuICAgICAgICBkZXBzLmNhbGxMb2cucHVzaChgc3RvcEF1dG86JHtyZWFzb24gPz8gXCJuby1yZWFzb25cIn1gKTtcbiAgICAgICAgcy5hY3RpdmUgPSBmYWxzZTtcbiAgICAgIH0sXG4gICAgICB1b2tPYnNlcnZlcjoge1xuICAgICAgICBvblR1cm5TdGFydDogKCkgPT4ge30sXG4gICAgICAgIG9uVHVyblJlc3VsdDogKHJlc3VsdCkgPT4ge1xuICAgICAgICAgIHR1cm5SZXN1bHRzLnB1c2goe1xuICAgICAgICAgICAgc3RhdHVzOiByZXN1bHQuc3RhdHVzLFxuICAgICAgICAgICAgZmFpbHVyZUNsYXNzOiByZXN1bHQuZmFpbHVyZUNsYXNzLFxuICAgICAgICAgICAgZXJyb3I6IHJlc3VsdC5lcnJvcixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSxcbiAgICAgICAgb25QaGFzZVJlc3VsdDogKCkgPT4ge30sXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgYXdhaXQgYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgICBhc3NlcnQuZXF1YWwodHVyblJlc3VsdHMubGVuZ3RoLCAxKTtcbiAgICBhc3NlcnQuZXF1YWwodHVyblJlc3VsdHNbMF0uc3RhdHVzLCBcInN0b3BwZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHR1cm5SZXN1bHRzWzBdLmZhaWx1cmVDbGFzcywgXCJtYW51YWwtYXR0ZW50aW9uXCIpO1xuICAgIGFzc2VydC5tYXRjaCh0dXJuUmVzdWx0c1swXS5lcnJvciA/PyBcIlwiLCAvY3VzdG9tLWVuZ2luZS1kaXNwYXRjaC1zdG9wLyk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwiam91cm5hbDppdGVyYXRpb24tZW5kXCIpLFxuICAgICAgYGJsb2NrZWQgd29ya2Zsb3cgc2hvdWxkIGVtaXQgaXRlcmF0aW9uLWVuZDsgbG9nPSR7ZGVwcy5jYWxsTG9nLmpvaW4oXCIsXCIpfWAsXG4gICAgKTtcbiAgICBhc3NlcnQuZXF1YWwocy5jdXJyZW50VHJhY2VJZCwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKHMuY3VycmVudFR1cm5JZCwgbnVsbCk7XG4gICAgYXNzZXJ0LmVxdWFsKHBpLmNhbGxzLmxlbmd0aCwgMCwgXCJibG9ja2VkIHdvcmtmbG93IHNob3VsZCBub3QgZGlzcGF0Y2ggYSBjdXN0b20gc3RlcFwiKTtcbiAgICBhc3NlcnQubWF0Y2goXG4gICAgICBkZXBzLmNhbGxMb2cuZmluZCgoZTogc3RyaW5nKSA9PiBlLnN0YXJ0c1dpdGgoXCJzdG9wQXV0bzpcIikpID8/IFwiXCIsXG4gICAgICAvV29ya2Zsb3cgYmxvY2tlZDogbm8gcGVuZGluZyBzdGVwcyBhcmUgcmVhZHkvLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwiZmluYWxpemVzIHRoZSBhY3RpdmUgdHVybiB3aGVuIHRoZSBzZXNzaW9uIGxvY2sgaXMgbG9zdFwiLCBhc3luYyAoKSA9PiB7XG4gICAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbigpO1xuICAgIGNvbnN0IHR1cm5SZXN1bHRzOiBBcnJheTx7IHN0YXR1czogc3RyaW5nOyBmYWlsdXJlQ2xhc3M6IHN0cmluZzsgZXJyb3I/OiBzdHJpbmcgfT4gPSBbXTtcbiAgICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICAgIHZhbGlkYXRlU2Vzc2lvbkxvY2s6ICgpID0+ICh7XG4gICAgICAgIHZhbGlkOiBmYWxzZSxcbiAgICAgICAgZmFpbHVyZVJlYXNvbjogXCJwaWQtbWlzbWF0Y2hcIixcbiAgICAgICAgZXhwZWN0ZWRQaWQ6IDExMSxcbiAgICAgICAgZXhpc3RpbmdQaWQ6IDIyMixcbiAgICAgIH0gYXMgU2Vzc2lvbkxvY2tTdGF0dXMpLFxuICAgICAgaGFuZGxlTG9zdFNlc3Npb25Mb2NrOiAoKSA9PiB7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwiaGFuZGxlTG9zdFNlc3Npb25Mb2NrXCIpO1xuICAgICAgfSxcbiAgICAgIHVva09ic2VydmVyOiB7XG4gICAgICAgIG9uVHVyblN0YXJ0OiAoKSA9PiB7fSxcbiAgICAgICAgb25UdXJuUmVzdWx0OiAocmVzdWx0KSA9PiB7XG4gICAgICAgICAgdHVyblJlc3VsdHMucHVzaCh7XG4gICAgICAgICAgICBzdGF0dXM6IHJlc3VsdC5zdGF0dXMsXG4gICAgICAgICAgICBmYWlsdXJlQ2xhc3M6IHJlc3VsdC5mYWlsdXJlQ2xhc3MsXG4gICAgICAgICAgICBlcnJvcjogcmVzdWx0LmVycm9yLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9LFxuICAgICAgICBvblBoYXNlUmVzdWx0OiAoKSA9PiB7fSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICBhd2FpdCBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICAgIGFzc2VydC5kZWVwRXF1YWwodHVyblJlc3VsdHMsIFt7XG4gICAgICBzdGF0dXM6IFwic3RvcHBlZFwiLFxuICAgICAgZmFpbHVyZUNsYXNzOiBcIm1hbnVhbC1hdHRlbnRpb25cIixcbiAgICAgIGVycm9yOiBcInNlc3Npb24tbG9jay1sb3N0XCIsXG4gICAgfV0pO1xuICAgIGFzc2VydC5lcXVhbChzLmN1cnJlbnRUcmFjZUlkLCBudWxsKTtcbiAgICBhc3NlcnQuZXF1YWwocy5jdXJyZW50VHVybklkLCBudWxsKTtcbiAgICBhc3NlcnQuZXF1YWwocGkuY2FsbHMubGVuZ3RoLCAwLCBcImxvc3Qgc2Vzc2lvbiBsb2NrIG11c3Qgbm90IGRpc3BhdGNoIHdvcmtcIik7XG4gICAgYXNzZXJ0Lm9rKGRlcHMuY2FsbExvZy5pbmNsdWRlcyhcImhhbmRsZUxvc3RTZXNzaW9uTG9ja1wiKSk7XG4gIH0pO1xuXG4gIGl0KFwiZG9lcyBub3QgY2FsbCBydW5QcmVEaXNwYXRjaCBvciBydW5GaW5hbGl6ZSBvbiB0aGUgY3VzdG9tIHBhdGhcIiwgYXN5bmMgKCkgPT4ge1xuICAgIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgICAvLyBTaW5nbGUtc3RlcCB3b3JrZmxvd1xuICAgIGNvbnN0IHJ1bkRpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbbWFrZVN0ZXAoeyBpZDogXCJvbmx5XCIgfSldLCBcInNpbmdsZVwiKTtcbiAgICB3cml0ZUdyYXBoKHJ1bkRpciwgZ3JhcGgpO1xuICAgIHdyaXRlRGVmaW5pdGlvbihydW5EaXIsIGdyYXBoLnN0ZXBzLCBcInNpbmdsZVwiKTtcblxuICAgIGNvbnN0IGN0eCA9IG1ha2VNb2NrQ3R4KCk7XG4gICAgY29uc3QgcGkgPSBtYWtlTW9ja1BpKCk7XG5cbiAgICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKHtcbiAgICAgIGFjdGl2ZUVuZ2luZUlkOiBcImN1c3RvbVwiLFxuICAgICAgYWN0aXZlUnVuRGlyOiBydW5EaXIsXG4gICAgICBiYXNlUGF0aDogcnVuRGlyLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgICBzdG9wQXV0bzogYXN5bmMgKF9jdHgsIF9waSwgcmVhc29uKSA9PiB7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKGBzdG9wQXV0bzoke3JlYXNvbiA/PyBcIm5vLXJlYXNvblwifWApO1xuICAgICAgICBzLmFjdGl2ZSA9IGZhbHNlO1xuICAgICAgfSxcbiAgICAgIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicG9zdFVuaXRQcmVWZXJpZmljYXRpb25cIik7XG4gICAgICAgIHJldHVybiBcImNvbnRpbnVlXCIgYXMgY29uc3Q7XG4gICAgICB9LFxuICAgICAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIpO1xuICAgICAgICByZXR1cm4gXCJjb250aW51ZVwiIGFzIGNvbnN0O1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxvb3BQcm9taXNlID0gYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgICBhd2FpdCByZXNvbHZlTmV4dEFnZW50RW5kKCk7XG5cbiAgICBhd2FpdCBsb29wUHJvbWlzZTtcblxuICAgIC8vIEN1c3RvbSBwYXRoIHNob3VsZCBOT1QgY2FsbCBydW5GaW5hbGl6ZSdzIHBvc3QtdW5pdCBwaGFzZXNcbiAgICBhc3NlcnQub2soXG4gICAgICAhZGVwcy5jYWxsTG9nLmluY2x1ZGVzKFwicG9zdFVuaXRQcmVWZXJpZmljYXRpb25cIiksXG4gICAgICBcIkN1c3RvbSBwYXRoIHNob3VsZCBza2lwIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uIChydW5GaW5hbGl6ZSBub3QgY2FsbGVkKVwiLFxuICAgICk7XG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgIWRlcHMuY2FsbExvZy5pbmNsdWRlcyhcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblwiKSxcbiAgICAgIFwiQ3VzdG9tIHBhdGggc2hvdWxkIHNraXAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uIChydW5GaW5hbGl6ZSBub3QgY2FsbGVkKVwiLFxuICAgICk7XG5cbiAgICAvLyBTaG91bGQgTk9UIGhhdmUgY2FsbGVkIHJlc29sdmVEaXNwYXRjaCAoZGV2IGRpc3BhdGNoKVxuICAgIGFzc2VydC5vayhcbiAgICAgICFkZXBzLmNhbGxMb2cuaW5jbHVkZXMoXCJyZXNvbHZlRGlzcGF0Y2hcIiksXG4gICAgICBcIkN1c3RvbSBwYXRoIHNob3VsZCBza2lwIHJlc29sdmVEaXNwYXRjaFwiLFxuICAgICk7XG4gIH0pO1xuXG4gIGl0KFwicmVzcGVjdHMgZGVwZW5kZW5jeSBvcmRlcmluZyBcdTIwMTQgc3RlcC1iIHdhaXRzIGZvciBzdGVwLWFcIiwgYXN5bmMgKCkgPT4ge1xuICAgIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgICBjb25zdCBydW5EaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgLy8gc3RlcC1iIGRlcGVuZHMgb24gc3RlcC1hLCBib3RoIHBlbmRpbmdcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbXG4gICAgICBtYWtlU3RlcCh7IGlkOiBcInN0ZXAtYVwiIH0pLFxuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJzdGVwLWJcIiwgZGVwZW5kc09uOiBbXCJzdGVwLWFcIl0gfSksXG4gICAgXSwgXCJkZXAtb3JkZXJcIik7XG4gICAgd3JpdGVHcmFwaChydW5EaXIsIGdyYXBoKTtcbiAgICB3cml0ZURlZmluaXRpb24ocnVuRGlyLCBncmFwaC5zdGVwcywgXCJkZXAtb3JkZXJcIik7XG5cbiAgICBjb25zdCBjdHggPSBtYWtlTW9ja0N0eCgpO1xuICAgIGNvbnN0IHBpID0gbWFrZU1vY2tQaSgpO1xuICAgIGNvbnN0IGRpc3BhdGNoZWRVbml0SWRzOiBzdHJpbmdbXSA9IFtdO1xuXG4gICAgY29uc3QgcyA9IG1ha2VMb29wU2Vzc2lvbih7XG4gICAgICBhY3RpdmVFbmdpbmVJZDogXCJjdXN0b21cIixcbiAgICAgIGFjdGl2ZVJ1bkRpcjogcnVuRGlyLFxuICAgICAgYmFzZVBhdGg6IHJ1bkRpcixcbiAgICB9KTtcblxuICAgIGNvbnN0IG9yaWdpbmFsU2VuZE1lc3NhZ2UgPSBwaS5zZW5kTWVzc2FnZTtcbiAgICBwaS5zZW5kTWVzc2FnZSA9ICguLi5hcmdzOiB1bmtub3duW10pID0+IHtcbiAgICAgIC8vIFRyYWNrIGRpc3BhdGNoZWQgcHJvbXB0cyB0byB2ZXJpZnkgb3JkZXJpbmdcbiAgICAgIGNvbnN0IHByb21wdEFyZyA9IGFyZ3NbMF0gYXMgeyBjb250ZW50Pzogc3RyaW5nIH07XG4gICAgICBkaXNwYXRjaGVkVW5pdElkcy5wdXNoKHByb21wdEFyZz8uY29udGVudCA/PyBcInVua25vd25cIik7XG4gICAgICByZXR1cm4gb3JpZ2luYWxTZW5kTWVzc2FnZSguLi5hcmdzKTtcbiAgICB9O1xuXG4gICAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyh7XG4gICAgICBzdG9wQXV0bzogYXN5bmMgKF9jdHgsIF9waSwgcmVhc29uKSA9PiB7XG4gICAgICAgIGRlcHMuY2FsbExvZy5wdXNoKGBzdG9wQXV0bzoke3JlYXNvbiA/PyBcIm5vLXJlYXNvblwifWApO1xuICAgICAgICBzLmFjdGl2ZSA9IGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxvb3BQcm9taXNlID0gYXV0b0xvb3AoY3R4LCBwaSwgcywgZGVwcyk7XG5cbiAgICAvLyBSZXNvbHZlIHN0ZXAtYVxuICAgIGF3YWl0IHJlc29sdmVOZXh0QWdlbnRFbmQoKTtcblxuICAgIC8vIFJlc29sdmUgc3RlcC1iXG4gICAgYXdhaXQgcmVzb2x2ZU5leHRBZ2VudEVuZCgpO1xuXG4gICAgYXdhaXQgbG9vcFByb21pc2U7XG5cbiAgICAvLyBWZXJpZnkgc3RlcC1hIHdhcyBkaXNwYXRjaGVkIGJlZm9yZSBzdGVwLWJcbiAgICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2hlZFVuaXRJZHMubGVuZ3RoLCAyLCBcIlNob3VsZCBoYXZlIGRpc3BhdGNoZWQgMiBzdGVwc1wiKTtcbiAgICBhc3NlcnQub2soXG4gICAgICBkaXNwYXRjaGVkVW5pdElkc1swXS5pbmNsdWRlcyhcIkRvIHN0ZXAtYVwiKSxcbiAgICAgIGBGaXJzdCBkaXNwYXRjaCBzaG91bGQgYmUgc3RlcC1hLCBnb3Q6ICR7ZGlzcGF0Y2hlZFVuaXRJZHNbMF19YCxcbiAgICApO1xuICAgIGFzc2VydC5vayhcbiAgICAgIGRpc3BhdGNoZWRVbml0SWRzWzFdLmluY2x1ZGVzKFwiRG8gc3RlcC1iXCIpLFxuICAgICAgYFNlY29uZCBkaXNwYXRjaCBzaG91bGQgYmUgc3RlcC1iLCBnb3Q6ICR7ZGlzcGF0Y2hlZFVuaXRJZHNbMV19YCxcbiAgICApO1xuICB9KTtcblxuICBpdChcInN0b3BzIGN1c3RvbSB3b3JrZmxvdyBhZnRlciByZXBlYXRlZCB2ZXJpZmljYXRpb24gcmV0cmllc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICAgIGNvbnN0IHJ1bkRpciA9IG1ha2VUbXBEaXIoKTtcbiAgICBjb25zdCBncmFwaCA9IG1ha2VHcmFwaChbbWFrZVN0ZXAoeyBpZDogXCJyZXRyeS1zdGVwXCIgfSldLCBcInJldHJ5LWV4aGF1c3Rpb25cIik7XG4gICAgd3JpdGVHcmFwaChydW5EaXIsIGdyYXBoKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4ocnVuRGlyLCBcIkRFRklOSVRJT04ueWFtbFwiKSwgc3RyaW5naWZ5KHtcbiAgICAgIHZlcnNpb246IDEsXG4gICAgICBuYW1lOiBcInJldHJ5LWV4aGF1c3Rpb25cIixcbiAgICAgIHN0ZXBzOiBbe1xuICAgICAgICBpZDogXCJyZXRyeS1zdGVwXCIsXG4gICAgICAgIG5hbWU6IFwicmV0cnktc3RlcFwiLFxuICAgICAgICBwcm9tcHQ6IFwiRG8gcmV0cnktc3RlcFwiLFxuICAgICAgICBwcm9kdWNlczogXCJyZXRyeS1zdGVwL291dHB1dC5tZFwiLFxuICAgICAgICB2ZXJpZnk6IHsgcG9saWN5OiBcInNoZWxsLWNvbW1hbmRcIiwgY29tbWFuZDogXCJleGl0IDFcIiB9LFxuICAgICAgfV0sXG4gICAgfSkpO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcbiAgICBjb25zdCBzID0gbWFrZUxvb3BTZXNzaW9uKHtcbiAgICAgIGFjdGl2ZUVuZ2luZUlkOiBcImN1c3RvbVwiLFxuICAgICAgYWN0aXZlUnVuRGlyOiBydW5EaXIsXG4gICAgICBiYXNlUGF0aDogcnVuRGlyLFxuICAgIH0pO1xuICAgIGNvbnN0IGpvdXJuYWxFdmVudHM6IEFycmF5PHsgZXZlbnRUeXBlOiBzdHJpbmc7IGRhdGE/OiBhbnkgfT4gPSBbXTtcbiAgICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICAgIHN0b3BBdXRvOiBhc3luYyAoX2N0eCwgX3BpLCByZWFzb24pID0+IHtcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goYHN0b3BBdXRvOiR7cmVhc29uID8/IFwibm8tcmVhc29uXCJ9YCk7XG4gICAgICAgIHMuYWN0aXZlID0gZmFsc2U7XG4gICAgICB9LFxuICAgICAgZW1pdEpvdXJuYWxFdmVudDogKGVudHJ5OiBhbnkpID0+IHtcbiAgICAgICAgam91cm5hbEV2ZW50cy5wdXNoKGVudHJ5KTtcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goYGpvdXJuYWw6JHtlbnRyeS5ldmVudFR5cGV9YCk7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzb2x2ZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICBpZiAoX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCgpKSB7XG4gICAgICAgIHJlc29sdmVBZ2VudEVuZCh7IG1lc3NhZ2VzOiBbeyByb2xlOiBcImFzc2lzdGFudFwiIH1dIH0pO1xuICAgICAgfVxuICAgIH0sIDI1KTtcbiAgICBsZXQgdGltZW91dDogTm9kZUpTLlRpbWVvdXQgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICAgIGF1dG9Mb29wKGN0eCwgcGksIHMsIGRlcHMpLFxuICAgICAgICBuZXcgUHJvbWlzZSgoXywgcmVqZWN0KSA9PlxuICAgICAgICAgIHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIHMuYWN0aXZlID0gZmFsc2U7XG4gICAgICAgICAgICByZXNvbHZlQWdlbnRFbmQoeyBtZXNzYWdlczogW3sgcm9sZTogXCJhc3Npc3RhbnRcIiB9XSB9KTtcbiAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoXG4gICAgICAgICAgICAgIGBhdXRvTG9vcCBkaWQgbm90IHN0b3AgYWZ0ZXIgdmVyaWZpY2F0aW9uIHJldHJ5IGV4aGF1c3Rpb247IGNhbGxzPSR7cGkuY2FsbHMubGVuZ3RofTsgbG9nPSR7ZGVwcy5jYWxsTG9nLmpvaW4oXCIsXCIpfWAsXG4gICAgICAgICAgICApKTtcbiAgICAgICAgICB9LCAzXzAwMCksXG4gICAgICAgICksXG4gICAgICBdKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYXJJbnRlcnZhbChyZXNvbHZlcik7XG4gICAgICBpZiAodGltZW91dCkgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgIH1cblxuICAgIGFzc2VydC5lcXVhbChwaS5jYWxscy5sZW5ndGgsIDQsIFwidmVyaWZpY2F0aW9uIHJldHJ5IHNob3VsZCBiZSBjYXBwZWQgYWZ0ZXIgZm91ciBkaXNwYXRjaGVkIGF0dGVtcHRzXCIpO1xuICAgIGNvbnN0IHN0b3BFbnRyeSA9IGRlcHMuY2FsbExvZy5maW5kKChlOiBzdHJpbmcpID0+IGUuc3RhcnRzV2l0aChcInN0b3BBdXRvOlwiKSk7XG4gICAgYXNzZXJ0Lm1hdGNoKHN0b3BFbnRyeSA/PyBcIlwiLCAvcmVxdWVzdGVkIHJldHJ5IDQgdGltZXMgd2l0aG91dCBwYXNzaW5nLyk7XG4gICAgY29uc3QgZmluYWxHcmFwaCA9IHJlYWRHcmFwaChydW5EaXIpO1xuICAgIGFzc2VydC5lcXVhbChmaW5hbEdyYXBoLnN0ZXBzWzBdPy5zdGF0dXMsIFwiYWN0aXZlXCIsIFwiZmFpbGVkIHZlcmlmaWNhdGlvbiBtdXN0IG5vdCByZWNvbmNpbGUgdGhlIHN0ZXAgY29tcGxldGVcIik7XG5cbiAgICBjb25zdCB1bml0RW5kSW5kZXhlcyA9IGpvdXJuYWxFdmVudHNcbiAgICAgIC5tYXAoKGVudHJ5LCBpbmRleCkgPT4gZW50cnkuZXZlbnRUeXBlID09PSBcInVuaXQtZW5kXCIgPyBpbmRleCA6IC0xKVxuICAgICAgLmZpbHRlcigoaW5kZXgpID0+IGluZGV4ID49IDApO1xuICAgIGNvbnN0IGl0ZXJhdGlvbkVuZEluZGV4ZXMgPSBqb3VybmFsRXZlbnRzXG4gICAgICAubWFwKChlbnRyeSwgaW5kZXgpID0+IGVudHJ5LmV2ZW50VHlwZSA9PT0gXCJpdGVyYXRpb24tZW5kXCIgPyBpbmRleCA6IC0xKVxuICAgICAgLmZpbHRlcigoaW5kZXgpID0+IGluZGV4ID49IDApO1xuICAgIGFzc2VydC5lcXVhbCh1bml0RW5kSW5kZXhlcy5sZW5ndGgsIDQsIFwiZWFjaCBjdXN0b20gdmVyaWZpY2F0aW9uIHJldHJ5L3N0b3AgYXR0ZW1wdCBtdXN0IGVtaXQgdW5pdC1lbmRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGl0ZXJhdGlvbkVuZEluZGV4ZXMubGVuZ3RoLCA0LCBcImVhY2ggY3VzdG9tIHZlcmlmaWNhdGlvbiByZXRyeS9zdG9wIGl0ZXJhdGlvbiBtdXN0IGNsb3NlIGFmdGVyIHVuaXQtZW5kXCIpO1xuICAgIGZvciAoY29uc3QgW2ksIHVuaXRFbmRJbmRleF0gb2YgdW5pdEVuZEluZGV4ZXMuZW50cmllcygpKSB7XG4gICAgICBhc3NlcnQub2soXG4gICAgICAgIGl0ZXJhdGlvbkVuZEluZGV4ZXNbaV0hID4gdW5pdEVuZEluZGV4LFxuICAgICAgICBgY3VzdG9tIHZlcmlmaWNhdGlvbiBhdHRlbXB0ICR7aSArIDF9IHNob3VsZCBlbWl0IGl0ZXJhdGlvbi1lbmQgYWZ0ZXIgdW5pdC1lbmRgLFxuICAgICAgKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwicGVyc2lzdHMgY3VzdG9tIHZlcmlmaWNhdGlvbiByZXRyeSBidWRnZXQgYWNyb3NzIGEgc2Vzc2lvbiByZXN0YXJ0XCIsIGFzeW5jICgpID0+IHtcbiAgICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gICAgY29uc3QgcnVuRGlyID0gbWFrZVRtcERpcigpO1xuICAgIGNvbnN0IGdyYXBoID0gbWFrZUdyYXBoKFttYWtlU3RlcCh7IGlkOiBcInJldHJ5LXN0ZXBcIiB9KV0sIFwicmV0cnktcmVzdGFydFwiKTtcbiAgICB3cml0ZUdyYXBoKHJ1bkRpciwgZ3JhcGgpO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihydW5EaXIsIFwiREVGSU5JVElPTi55YW1sXCIpLCBzdHJpbmdpZnkoe1xuICAgICAgdmVyc2lvbjogMSxcbiAgICAgIG5hbWU6IFwicmV0cnktcmVzdGFydFwiLFxuICAgICAgc3RlcHM6IFt7XG4gICAgICAgIGlkOiBcInJldHJ5LXN0ZXBcIixcbiAgICAgICAgbmFtZTogXCJyZXRyeS1zdGVwXCIsXG4gICAgICAgIHByb21wdDogXCJEbyByZXRyeS1zdGVwXCIsXG4gICAgICAgIHByb2R1Y2VzOiBcInJldHJ5LXN0ZXAvb3V0cHV0Lm1kXCIsXG4gICAgICAgIHZlcmlmeTogeyBwb2xpY3k6IFwic2hlbGwtY29tbWFuZFwiLCBjb21tYW5kOiBcImV4aXQgMVwiIH0sXG4gICAgICB9XSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCBjdHgxID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaTEgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgczEgPSBtYWtlTG9vcFNlc3Npb24oe1xuICAgICAgYWN0aXZlRW5naW5lSWQ6IFwiY3VzdG9tXCIsXG4gICAgICBhY3RpdmVSdW5EaXI6IHJ1bkRpcixcbiAgICAgIGJhc2VQYXRoOiBydW5EaXIsXG4gICAgfSk7XG4gICAgY29uc3QgZGVwczEgPSBtYWtlTW9ja0RlcHMoKTtcbiAgICBjb25zdCByZXNvbHZlcjEgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICBpZiAoX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCgpKSB7XG4gICAgICAgIHJlc29sdmVBZ2VudEVuZCh7IG1lc3NhZ2VzOiBbeyByb2xlOiBcImFzc2lzdGFudFwiIH1dIH0pO1xuICAgICAgfVxuICAgICAgaWYgKHBpMS5jYWxscy5sZW5ndGggPj0gMikge1xuICAgICAgICBzMS5hY3RpdmUgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9LCAyNSk7XG4gICAgbGV0IHRpbWVvdXQxOiBOb2RlSlMuVGltZW91dCB8IHVuZGVmaW5lZDtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgYXV0b0xvb3AoY3R4MSwgcGkxLCBzMSwgZGVwczEpLFxuICAgICAgICBuZXcgUHJvbWlzZSgoXywgcmVqZWN0KSA9PlxuICAgICAgICAgIHRpbWVvdXQxID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICBzMS5hY3RpdmUgPSBmYWxzZTtcbiAgICAgICAgICAgIHJlc29sdmVBZ2VudEVuZCh7IG1lc3NhZ2VzOiBbeyByb2xlOiBcImFzc2lzdGFudFwiIH1dIH0pO1xuICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgYGZpcnN0IGF1dG9Mb29wIGRpZCBub3QgcGF1c2UgYWZ0ZXIgdHdvIHJldHJ5IGF0dGVtcHRzOyBjYWxscz0ke3BpMS5jYWxscy5sZW5ndGh9OyBsb2c9JHtkZXBzMS5jYWxsTG9nLmpvaW4oXCIsXCIpfWAsXG4gICAgICAgICAgICApKTtcbiAgICAgICAgICB9LCAzXzAwMCksXG4gICAgICAgICksXG4gICAgICBdKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgY2xlYXJJbnRlcnZhbChyZXNvbHZlcjEpO1xuICAgICAgaWYgKHRpbWVvdXQxKSBjbGVhclRpbWVvdXQodGltZW91dDEpO1xuICAgIH1cbiAgICBhc3NlcnQuZXF1YWwocGkxLmNhbGxzLmxlbmd0aCwgMiwgXCJmaXJzdCBzZXNzaW9uIHNob3VsZCBjb25zdW1lIHR3byByZXRyeSBhdHRlbXB0c1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoXG4gICAgICBkZXBzMS5jYWxsTG9nLnNvbWUoKGU6IHN0cmluZykgPT4gZS5zdGFydHNXaXRoKFwic3RvcEF1dG86XCIpKSxcbiAgICAgIGZhbHNlLFxuICAgICAgXCJmaXJzdCBzZXNzaW9uIHNob3VsZCBzdG9wIGJlY2F1c2UgdGhlIHNlc3Npb24gZGVhY3RpdmF0ZWQsIG5vdCBiZWNhdXNlIHJldHJ5IGJ1ZGdldCBleGhhdXN0ZWRcIixcbiAgICApO1xuXG4gICAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcbiAgICBjb25zdCBjdHgyID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaTIgPSBtYWtlTW9ja1BpKCk7XG4gICAgY29uc3QgczIgPSBtYWtlTG9vcFNlc3Npb24oe1xuICAgICAgYWN0aXZlRW5naW5lSWQ6IFwiY3VzdG9tXCIsXG4gICAgICBhY3RpdmVSdW5EaXI6IHJ1bkRpcixcbiAgICAgIGJhc2VQYXRoOiBydW5EaXIsXG4gICAgfSk7XG4gICAgY29uc3QgZGVwczIgPSBtYWtlTW9ja0RlcHMoe1xuICAgICAgc3RvcEF1dG86IGFzeW5jIChfY3R4LCBfcGksIHJlYXNvbikgPT4ge1xuICAgICAgICBkZXBzMi5jYWxsTG9nLnB1c2goYHN0b3BBdXRvOiR7cmVhc29uID8/IFwibm8tcmVhc29uXCJ9YCk7XG4gICAgICAgIHMyLmFjdGl2ZSA9IGZhbHNlO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCByZXNvbHZlcjIgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgICBpZiAoX2hhc1BlbmRpbmdSZXNvbHZlRm9yVGVzdCgpKSB7XG4gICAgICAgIHJlc29sdmVBZ2VudEVuZCh7IG1lc3NhZ2VzOiBbeyByb2xlOiBcImFzc2lzdGFudFwiIH1dIH0pO1xuICAgICAgfVxuICAgIH0sIDI1KTtcbiAgICBsZXQgdGltZW91dDI6IE5vZGVKUy5UaW1lb3V0IHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgICBhdXRvTG9vcChjdHgyLCBwaTIsIHMyLCBkZXBzMiksXG4gICAgICAgIG5ldyBQcm9taXNlKChfLCByZWplY3QpID0+XG4gICAgICAgICAgdGltZW91dDIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIHMyLmFjdGl2ZSA9IGZhbHNlO1xuICAgICAgICAgICAgcmVzb2x2ZUFnZW50RW5kKHsgbWVzc2FnZXM6IFt7IHJvbGU6IFwiYXNzaXN0YW50XCIgfV0gfSk7XG4gICAgICAgICAgICByZWplY3QobmV3IEVycm9yKFxuICAgICAgICAgICAgICBgc2Vjb25kIGF1dG9Mb29wIGRpZCBub3Qgc3RvcCBhZnRlciBwZXJzaXN0ZWQgcmV0cnkgZXhoYXVzdGlvbjsgY2FsbHM9JHtwaTIuY2FsbHMubGVuZ3RofTsgbG9nPSR7ZGVwczIuY2FsbExvZy5qb2luKFwiLFwiKX1gLFxuICAgICAgICAgICAgKSk7XG4gICAgICAgICAgfSwgM18wMDApLFxuICAgICAgICApLFxuICAgICAgXSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNsZWFySW50ZXJ2YWwocmVzb2x2ZXIyKTtcbiAgICAgIGlmICh0aW1lb3V0MikgY2xlYXJUaW1lb3V0KHRpbWVvdXQyKTtcbiAgICB9XG5cbiAgICBhc3NlcnQuZXF1YWwocGkyLmNhbGxzLmxlbmd0aCwgMiwgXCJzZWNvbmQgc2Vzc2lvbiBzaG91bGQgZXhoYXVzdCBhZnRlciBhdHRlbXB0cyAzIGFuZCA0XCIpO1xuICAgIGNvbnN0IHN0b3BFbnRyeSA9IGRlcHMyLmNhbGxMb2cuZmluZCgoZTogc3RyaW5nKSA9PiBlLnN0YXJ0c1dpdGgoXCJzdG9wQXV0bzpcIikpO1xuICAgIGFzc2VydC5tYXRjaChzdG9wRW50cnkgPz8gXCJcIiwgL3JlcXVlc3RlZCByZXRyeSA0IHRpbWVzIHdpdGhvdXQgcGFzc2luZy8pO1xuICB9KTtcblxuICBpdChcInR3by1zdGVwIHdvcmtmbG93IGRyaXZlcyBib3RoIHN0ZXBzIHRvIGNvbXBsZXRlIGFuZCBzdG9wcyB3aGVuIGlzQ29tcGxldGUgZmlyZXNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIC8vIE5vdGUgKCM0ODMxKTogcmVuYW1lZCBmcm9tIFwiR1JBUEgueWFtbCBzdGVwIHN0YXlzIHBlbmRpbmcgd2hlbiBzZXNzaW9uXG4gICAgLy8gZGVhY3RpdmF0ZXMgYmVmb3JlIHJlY29uY2lsZVwiIFx1MjAxNCB0aGUgYXNzZXJ0aW9uIGJvZHkgbmV2ZXIgcHJvdmVkIHRoZVxuICAgIC8vIHBlbmRpbmctb24tZGVhY3RpdmF0ZSBjbGFpbSBhbmQgZXZlbiBjb21tZW50cyB0aGF0IFwidGhlIHJlY29uY2lsZVxuICAgIC8vIHdpbGwgc3RpbGwgcnVuIGZvciBzdGVwLWJcIi4gVGhlIGJlaGF2aW91ciB0aGlzIHRlc3QgYWN0dWFsbHkgcGlucyBpczpcbiAgICAvLyBib3RoIHN0ZXBzIHJlY29uY2lsZSBjb21wbGV0ZSBhbmQgc3RvcEF1dG8gZmlyZXMgb25jZSBpc0NvbXBsZXRlLlxuICAgIF9yZXNldFBlbmRpbmdSZXNvbHZlKCk7XG5cbiAgICAvLyBUd28tc3RlcCB3b3JrZmxvdzogYSBcdTIxOTIgYi4gV2Ugd2lsbCBjb21wbGV0ZSBzdGVwLWEsIHRoZW4gZm9yY2UgYSBicmVha1xuICAgIC8vIGR1cmluZyBzdGVwLWIncyBydW5Vbml0UGhhc2UgKGJ5IHJldHVybmluZyBjYW5jZWxsZWQgc3RhdHVzICsgZGVhY3RpdmF0aW5nKS5cbiAgICBjb25zdCBydW5EaXIgPSBtYWtlVG1wRGlyKCk7XG4gICAgY29uc3QgZ3JhcGggPSBtYWtlR3JhcGgoW1xuICAgICAgbWFrZVN0ZXAoeyBpZDogXCJzdGVwLWFcIiB9KSxcbiAgICAgIG1ha2VTdGVwKHsgaWQ6IFwic3RlcC1iXCIsIGRlcGVuZHNPbjogW1wic3RlcC1hXCJdIH0pLFxuICAgIF0sIFwiZmFpbHVyZS10ZXN0XCIpO1xuICAgIHdyaXRlR3JhcGgocnVuRGlyLCBncmFwaCk7XG4gICAgd3JpdGVEZWZpbml0aW9uKHJ1bkRpciwgZ3JhcGguc3RlcHMsIFwiZmFpbHVyZS10ZXN0XCIpO1xuXG4gICAgY29uc3QgY3R4ID0gbWFrZU1vY2tDdHgoKTtcbiAgICBjb25zdCBwaSA9IG1ha2VNb2NrUGkoKTtcblxuICAgIGNvbnN0IHMgPSBtYWtlTG9vcFNlc3Npb24oe1xuICAgICAgYWN0aXZlRW5naW5lSWQ6IFwiY3VzdG9tXCIsXG4gICAgICBhY3RpdmVSdW5EaXI6IHJ1bkRpcixcbiAgICAgIGJhc2VQYXRoOiBydW5EaXIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKHtcbiAgICAgIHN0b3BBdXRvOiBhc3luYyAoX2N0eCwgX3BpLCByZWFzb24pID0+IHtcbiAgICAgICAgZGVwcy5jYWxsTG9nLnB1c2goYHN0b3BBdXRvOiR7cmVhc29uID8/IFwibm8tcmVhc29uXCJ9YCk7XG4gICAgICAgIHMuYWN0aXZlID0gZmFsc2U7XG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3QgbG9vcFByb21pc2UgPSBhdXRvTG9vcChjdHgsIHBpLCBzLCBkZXBzKTtcblxuICAgIC8vIFJlc29sdmUgc3RlcC1hIHN1Y2Nlc3NmdWxseVxuICAgIGF3YWl0IHJlc29sdmVOZXh0QWdlbnRFbmQoKTtcblxuICAgIC8vIFN0ZXAtYiBlbnRlcnMgcnVuVW5pdCBcdTIwMTQgZGVhY3RpdmF0ZSB0aGUgc2Vzc2lvbiBiZWZvcmUgcmVzb2x2aW5nLlxuICAgIC8vIHJ1blVuaXQgY2hlY2tzIHMuYWN0aXZlIGFmdGVyIG5ld1Nlc3Npb24gYW5kIHJldHVybnMgY2FuY2VsbGVkIGlmIGZhbHNlLlxuICAgIC8vIEJ1dCBzaW5jZSBuZXdTZXNzaW9uIHJlc29sdmVzIHN5bmNocm9ub3VzbHkgaW4gb3VyIG1vY2sgKGJlZm9yZSB0aGVcbiAgICAvLyBhY3RpdmUgY2hlY2spLCB0aGUgdW5pdCBzdGlsbCBydW5zLiBJbnN0ZWFkLCBsZXQncyBqdXN0IGNhbmNlbCBpdC5cbiAgICAvLyBSZXNvbHZlIGFzIGNhbmNlbGxlZCB0byBzaW11bGF0ZSBhIGZhaWxlZCBzZXNzaW9uXG4gICAgYXdhaXQgcmVzb2x2ZU5leHRBZ2VudEVuZCgpO1xuXG4gICAgLy8gVGhlIHJlY29uY2lsZSB3aWxsIHN0aWxsIHJ1biBmb3Igc3RlcC1iIGluIHRoaXMgZmxvdyBzaW5jZVxuICAgIC8vIHJ1blVuaXRQaGFzZSByZXR1cm5zIFwibmV4dFwiIChub3QgXCJicmVha1wiKSBmb3IgY29tcGxldGVkIHVuaXRzLlxuICAgIC8vIEFmdGVyIGJvdGggc3RlcHMgY29tcGxldGUsIHRoZSBlbmdpbmUgZGV0ZWN0cyBpc0NvbXBsZXRlIGFuZCBzdG9wcy5cbiAgICBhd2FpdCBsb29wUHJvbWlzZTtcblxuICAgIC8vIEJvdGggc3RlcHMgcmVjb25jaWxlIGNvbXBsZXRlOyB0aGUgcmVuYW1lZCBleHBlY3RhdGlvbiBwaW5zIHRoYXQgdGhlXG4gICAgLy8gZW5naW5lIGRyaXZlcyB0aGUgd29ya2Zsb3cgdGhyb3VnaCBpc0NvbXBsZXRlIHJhdGhlciB0aGFuIGxlYXZpbmcgYW55XG4gICAgLy8gc3RlcCBwZW5kaW5nLlxuICAgIGNvbnN0IGZpbmFsR3JhcGggPSByZWFkR3JhcGgocnVuRGlyKTtcbiAgICBjb25zdCBzdGVwQSA9IGZpbmFsR3JhcGguc3RlcHMuZmluZChzID0+IHMuaWQgPT09IFwic3RlcC1hXCIpO1xuICAgIGNvbnN0IHN0ZXBCID0gZmluYWxHcmFwaC5zdGVwcy5maW5kKHMgPT4gcy5pZCA9PT0gXCJzdGVwLWJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHN0ZXBBPy5zdGF0dXMsIFwiY29tcGxldGVcIiwgXCJTdGVwLWEgc2hvdWxkIGJlIGNvbXBsZXRlXCIpO1xuICAgIGFzc2VydC5lcXVhbChzdGVwQj8uc3RhdHVzLCBcImNvbXBsZXRlXCIsIFwiU3RlcC1iIHNob3VsZCBiZSBjb21wbGV0ZVwiKTtcblxuICAgIC8vIFRoZSBsb29wIG11c3Qgc3RvcCBvbmNlIGlzQ29tcGxldGUgZmlyZXMuXG4gICAgYXNzZXJ0Lm9rKFxuICAgICAgZGVwcy5jYWxsTG9nLnNvbWUoKGU6IHN0cmluZykgPT4gZS5zdGFydHNXaXRoKFwic3RvcEF1dG86XCIpKSxcbiAgICAgIFwic3RvcEF1dG8gc2hvdWxkIGhhdmUgYmVlbiBjYWxsZWRcIixcbiAgICApO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUEsU0FBUyxVQUFVLElBQUksaUJBQWlCO0FBQ3hDLE9BQU8sWUFBWTtBQUNuQixTQUFTLGFBQWEsUUFBUSxrQkFBa0I7QUFDaEQsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLGdCQUFnQjtBQUN6QixTQUFTLGlCQUFpQiwyQkFBMkIsNEJBQTRCO0FBRWpGLFNBQVMsK0JBQStCO0FBRXhDLFNBQVMsWUFBWSxpQkFBcUQ7QUFDMUUsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxpQkFBaUI7QUFJMUIsTUFBTSxVQUFvQixDQUFDO0FBRTNCLFNBQVMsYUFBcUI7QUFDNUIsUUFBTSxNQUFNLFlBQVksS0FBSyxPQUFPLEdBQUcsYUFB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
