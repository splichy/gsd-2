import test from "node:test";
import assert from "node:assert/strict";
import { createAutoOrchestrator, STUCK_WINDOW_SIZE } from "../auto/orchestrator.js";
import { createWiredDispatchAdapter } from "../auto.js";
import { resolveDispatch } from "../auto-dispatch.js";
import { RuleRegistry, setRegistry, resetRegistry } from "../rule-registry.js";
import { supportsStructuredQuestions } from "../workflow-mcp.js";
function makeState() {
  return {
    activeMilestone: { id: "M001", title: "Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "Execute task",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } }
  };
}
function makeDeps(overrides = {}) {
  const calls = [];
  const stateSnapshot = makeState();
  const deps = {
    stateReconciliation: {
      async reconcileBeforeDispatch() {
        calls.push("state.reconcile");
        return { ok: true, stateSnapshot };
      }
    },
    dispatch: {
      async decideNextUnit(input) {
        calls.push("dispatch.decide");
        assert.equal(input.stateSnapshot, stateSnapshot);
        return { unitType: "execute-task", unitId: "T01", reason: "ready", preconditions: [] };
      }
    },
    toolContract: {
      async compileUnitToolContract() {
        calls.push("tool.compile");
        return { ok: true };
      }
    },
    recovery: {
      async classifyAndRecover() {
        calls.push("recovery.classify");
        return { action: "stop", reason: "fatal" };
      }
    },
    worktree: {
      async prepareForUnit() {
        calls.push("worktree.prepare");
        return { ok: true };
      },
      async syncAfterUnit() {
        calls.push("worktree.sync");
      },
      async cleanupOnStop() {
        calls.push("worktree.cleanup");
      }
    },
    health: {
      checkResourcesStale() {
        calls.push("health.stale");
        return null;
      },
      async preAdvanceGate() {
        calls.push("health.pre");
        return { kind: "pass" };
      },
      async postAdvanceRecord() {
        calls.push("health.post");
      }
    },
    runtime: {
      async ensureLockOwnership() {
        calls.push("runtime.lock");
      },
      async journalTransition(event) {
        calls.push(`journal:${event.name}`);
      }
    },
    notifications: {
      async notifyLifecycle(event) {
        calls.push(`notify:${event.name}`);
      }
    },
    uokGate: {
      async emit(input) {
        calls.push(`gate:${input.gateId}:${input.outcome}`);
      }
    }
  };
  return { deps: { ...deps, ...overrides }, calls };
}
test("start() advances and records active unit", async () => {
  const { deps, calls } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.start({ basePath: "/tmp/project", trigger: "manual" });
  assert.equal(result.kind, "advanced");
  assert.deepEqual(result.unit, { unitType: "execute-task", unitId: "T01" });
  const status = orchestrator.getStatus();
  assert.equal(status.phase, "running");
  assert.deepEqual(status.activeUnit, { unitType: "execute-task", unitId: "T01" });
  assert.ok(calls.includes("journal:start"));
  assert.ok(calls.includes("journal:advance"));
});
test("advance() returns blocked when health gate denies", async () => {
  const { deps, calls } = makeDeps({
    health: {
      checkResourcesStale: () => null,
      async preAdvanceGate() {
        return { kind: "fail", reason: "doctor-block" };
      },
      async postAdvanceRecord() {
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "doctor-block");
  assert.equal(result.action, "pause");
  assert.ok(calls.includes("gate:pre-dispatch-health-gate:manual-attention"));
});
test("advance() returns blocked stop when resources are stale", async () => {
  const { deps, calls } = makeDeps({
    health: {
      checkResourcesStale: () => "resources changed since session start",
      async preAdvanceGate() {
        return { kind: "pass" };
      },
      async postAdvanceRecord() {
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "resources changed since session start");
  assert.equal(result.action, "stop");
  assert.ok(calls.includes("gate:resource-version-guard:fail"));
  assert.ok(!calls.includes("health.pre"));
  assert.ok(!calls.includes("state.reconcile"));
});
test("advance() continues past pre-dispatch health gate when it throws", async () => {
  const { deps, calls } = makeDeps({
    health: {
      checkResourcesStale: () => null,
      async preAdvanceGate() {
        return { kind: "threw", error: new Error("boom") };
      },
      async postAdvanceRecord() {
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "advanced");
  assert.ok(calls.includes("gate:pre-dispatch-health-gate:manual-attention"));
  assert.ok(calls.includes("state.reconcile"));
  assert.ok(calls.includes("dispatch.decide"));
});
test("advance() forwards fixesApplied into pre-dispatch-health-gate pass findings", async () => {
  let observed = "";
  const { deps } = makeDeps({
    health: {
      checkResourcesStale: () => null,
      async preAdvanceGate() {
        return { kind: "pass", fixesApplied: ["fix-a", "fix-b"] };
      },
      async postAdvanceRecord() {
      }
    },
    uokGate: {
      async emit(input) {
        if (input.gateId === "pre-dispatch-health-gate" && input.outcome === "pass") {
          observed = input.findings ?? "";
        }
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  await orchestrator.advance();
  assert.equal(observed, "fix-a, fix-b");
});
test("advance() follows the ADR-015 invariant sequence before journaling advance", async () => {
  const { deps, calls } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "advanced");
  assert.deepEqual(result.unit, { unitType: "execute-task", unitId: "T01" });
  assert.deepEqual(calls, [
    "runtime.lock",
    "health.stale",
    "gate:resource-version-guard:pass",
    "health.pre",
    "gate:pre-dispatch-health-gate:pass",
    "state.reconcile",
    "dispatch.decide",
    "tool.compile",
    "worktree.prepare",
    "journal:advance",
    "worktree.sync",
    "health.post"
  ]);
});
test("advance() blocks before dispatch when State Reconciliation blocks", async () => {
  const { deps, calls } = makeDeps({
    stateReconciliation: {
      async reconcileBeforeDispatch() {
        calls.push("state.reconcile");
        return { ok: false, reason: "state drift blocked", stateSnapshot: makeState() };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "state drift blocked");
  assert.equal(result.action, "pause");
  assert.ok(!calls.includes("dispatch.decide"));
  assert.ok(calls.includes("journal:advance-blocked"));
});
test("advance() blocks before Runtime persistence when Tool Contract fails", async () => {
  const { deps, calls } = makeDeps({
    toolContract: {
      async compileUnitToolContract() {
        calls.push("tool.compile");
        return { ok: false, reason: "unknown Unit" };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "unknown Unit");
  assert.equal(result.action, "pause");
  assert.ok(!calls.includes("worktree.prepare"));
  assert.ok(!calls.includes("journal:advance"));
  assert.ok(calls.includes("journal:advance-blocked"));
});
test("advance() blocks before Runtime persistence when Worktree Safety fails", async () => {
  const { deps, calls } = makeDeps({
    worktree: {
      async prepareForUnit() {
        calls.push("worktree.prepare");
        return { ok: false, reason: "worktree invalid" };
      },
      async syncAfterUnit() {
        calls.push("worktree.sync");
      },
      async cleanupOnStop() {
        calls.push("worktree.cleanup");
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "worktree invalid");
  assert.equal(result.action, "pause");
  assert.ok(!calls.includes("journal:advance"));
  assert.ok(!calls.includes("worktree.sync"));
  assert.ok(calls.includes("journal:advance-blocked"));
});
test("advance() stops when dispatch has no next unit", async () => {
  const { deps } = makeDeps({
    dispatch: {
      async decideNextUnit() {
        return null;
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "stopped");
  assert.equal(orchestrator.getStatus().phase, "stopped");
});
test("advance() surfaces dispatch blocker reason instead of generic no remaining units", async () => {
  const { deps, calls } = makeDeps({
    dispatch: {
      async decideNextUnit() {
        return {
          kind: "blocked",
          reason: "Milestone M001 validation verdict is needs-remediation but all slices are complete.",
          action: "pause"
        };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") return;
  assert.equal(result.reason, "Milestone M001 validation verdict is needs-remediation but all slices are complete.");
  assert.equal(result.action, "pause");
  assert.ok(calls.includes("journal:advance-blocked"));
  assert.ok(!calls.includes("journal:advance-stopped"));
});
test("resume() returns blocked when advance detects a dispatch blocker", async () => {
  const { deps } = makeDeps({
    dispatch: {
      async decideNextUnit() {
        return {
          kind: "blocked",
          reason: "remediation required",
          action: "pause"
        };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.resume();
  assert.equal(result.kind, "blocked");
  if (result.kind !== "blocked") return;
  assert.equal(result.reason, "remediation required");
});
test("advance() uses recovery on error", async () => {
  const { deps, calls } = makeDeps({
    runtime: {
      async ensureLockOwnership() {
        throw new Error("lock lost");
      },
      async journalTransition(event) {
        calls.push(`journal:${event.name}`);
      }
    },
    recovery: {
      async classifyAndRecover() {
        return { action: "escalate", reason: "needs manual" };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "error");
  assert.equal(result.reason, "needs manual");
  assert.equal(orchestrator.getStatus().phase, "error");
  assert.ok(calls.includes("journal:advance-error"));
});
test("advance() is idempotent for the same active unit", async () => {
  const { deps, calls } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const first = await orchestrator.advance();
  const second = await orchestrator.advance();
  assert.equal(first.kind, "advanced");
  assert.deepEqual(first.unit, { unitType: "execute-task", unitId: "T01" });
  assert.equal(second.kind, "blocked");
  assert.equal(second.reason, "idempotent advance: unit already active");
  assert.equal(second.action, "stop");
  const prepareCalls = calls.filter((c) => c === "worktree.prepare").length;
  assert.equal(prepareCalls, 1);
});
test("resume() re-enters running flow via advance", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.resume();
  assert.equal(result.kind, "advanced");
  assert.equal(orchestrator.getStatus().phase, "running");
});
test("resume() clears idempotent lock and allows re-advance", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const first = await orchestrator.advance();
  const blocked = await orchestrator.advance();
  const resumed = await orchestrator.resume();
  assert.equal(first.kind, "advanced");
  assert.equal(blocked.kind, "blocked");
  assert.equal(resumed.kind, "advanced");
});
test("transitionCount increases across lifecycle transitions", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const before = orchestrator.getStatus().transitionCount;
  await orchestrator.start({ basePath: "/tmp/project", trigger: "manual" });
  const afterStart = orchestrator.getStatus().transitionCount;
  await orchestrator.stop("done");
  const afterStop = orchestrator.getStatus().transitionCount;
  assert.ok(afterStart > before);
  assert.ok(afterStop > afterStart);
});
test("stop() clears idempotent unit lock so advance can run again", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const first = await orchestrator.advance();
  const blocked = await orchestrator.advance();
  const stopped = await orchestrator.stop("reset");
  const second = await orchestrator.advance();
  assert.equal(first.kind, "advanced");
  assert.equal(blocked.kind, "blocked");
  assert.equal(stopped.kind, "stopped");
  assert.equal(second.kind, "advanced");
});
test("advance() stopped clears previous activeUnit", async () => {
  let first = true;
  const { deps } = makeDeps({
    dispatch: {
      async decideNextUnit() {
        if (first) {
          first = false;
          return { unitType: "execute-task", unitId: "T01", reason: "ready", preconditions: [] };
        }
        return null;
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  await orchestrator.advance();
  const stopped = await orchestrator.advance();
  assert.equal(stopped.kind, "stopped");
  assert.equal(orchestrator.getStatus().activeUnit, void 0);
});
test("recovery stop clears activeUnit", async () => {
  const { deps, calls } = makeDeps({
    runtime: {
      async ensureLockOwnership() {
        throw new Error("boom");
      },
      async journalTransition(event) {
        calls.push(`journal:${event.name}`);
      }
    },
    recovery: {
      async classifyAndRecover() {
        return { action: "stop", reason: "fatal" };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "stopped");
  assert.equal(orchestrator.getStatus().activeUnit, void 0);
  assert.ok(calls.includes("journal:advance-stopped"));
  assert.ok(calls.includes("notify:stopped"));
  assert.ok(!calls.includes("notify:error"));
});
test("recovery retry maps to paused result", async () => {
  const { deps, calls } = makeDeps({
    runtime: {
      async ensureLockOwnership() {
        throw new Error("boom");
      },
      async journalTransition(event) {
        calls.push(`journal:${event.name}`);
      }
    },
    recovery: {
      async classifyAndRecover() {
        return { action: "retry", reason: "transient" };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "paused");
  assert.equal(result.reason, "transient");
  assert.equal(orchestrator.getStatus().phase, "paused");
  assert.ok(calls.includes("journal:advance-paused"));
  assert.ok(calls.includes("notify:pause"));
});
test("getStatus() returns defensive copy of activeUnit", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  await orchestrator.advance();
  const snap1 = orchestrator.getStatus();
  if (snap1.activeUnit) snap1.activeUnit.unitId = "MUTATED";
  const snap2 = orchestrator.getStatus();
  assert.equal(snap2.activeUnit?.unitId, "T01");
});
test("start() clears prior idempotent lock", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  await orchestrator.advance();
  const blocked = await orchestrator.advance();
  const restarted = await orchestrator.start({ basePath: "/tmp/project", trigger: "manual" });
  assert.equal(blocked.kind, "blocked");
  assert.equal(restarted.kind, "advanced");
});
test("error path emits error notification", async () => {
  const { deps, calls } = makeDeps({
    runtime: {
      async ensureLockOwnership() {
        throw new Error("boom");
      },
      async journalTransition(event) {
        calls.push(`journal:${event.name}`);
      }
    },
    recovery: {
      async classifyAndRecover() {
        return { action: "escalate", reason: "needs manual" };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  await orchestrator.advance();
  assert.ok(calls.includes("notify:error"));
});
test("blocked path journals advance-blocked", async () => {
  const { deps, calls } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  await orchestrator.advance();
  await orchestrator.advance();
  assert.ok(calls.includes("journal:advance-blocked"));
});
test("health post hook runs on blocked result", async () => {
  const { deps, calls } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  await orchestrator.advance();
  await orchestrator.advance();
  assert.ok(calls.includes("health.post"));
});
test("start() emits start notification", async () => {
  const { deps, calls } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  await orchestrator.start({ basePath: "/tmp/project", trigger: "manual" });
  assert.ok(calls.includes("notify:start"));
});
test("resume() emits resume notification", async () => {
  const { deps, calls } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  await orchestrator.resume();
  assert.ok(calls.includes("notify:resume"));
});
test("stopped with no remaining units clears idempotent lock for next advance", async () => {
  let callCount = 0;
  const { deps } = makeDeps({
    dispatch: {
      async decideNextUnit() {
        callCount += 1;
        if (callCount === 2) return null;
        return { unitType: "execute-task", unitId: "T01", reason: "ready", preconditions: [] };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  const first = await orchestrator.advance();
  const stopped = await orchestrator.advance();
  const after = await orchestrator.advance();
  assert.equal(first.kind, "advanced");
  assert.equal(stopped.kind, "stopped");
  assert.equal(after.kind, "advanced");
});
test("stop() cleans up worktree and transitions to stopped", async () => {
  const { deps, calls } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.stop("user-request");
  assert.equal(result.kind, "stopped");
  assert.equal(orchestrator.getStatus().phase, "stopped");
  assert.ok(calls.includes("worktree.cleanup"));
  assert.ok(calls.includes("journal:stop"));
  assert.ok(calls.includes("notify:stop"));
});
test("STUCK_WINDOW_SIZE matches the legacy auto/phases.ts constant", () => {
  assert.equal(STUCK_WINDOW_SIZE, 6);
});
test("stuck-loop: empty ring on a freshly constructed orchestrator advances normally", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const result = await orchestrator.advance();
  assert.equal(result.kind, "advanced");
});
test("stuck-loop: partial fill of mixed units does not block", async () => {
  let i = 0;
  const sequence = ["A", "B", "A", "B", "A", "B"];
  const { deps } = makeDeps({
    dispatch: {
      async decideNextUnit() {
        const id = sequence[i++ % sequence.length];
        return { unitType: "execute-task", unitId: id, reason: "ready", preconditions: [] };
      }
    }
  });
  const orchestrator = createAutoOrchestrator(deps);
  for (let round = 0; round < STUCK_WINDOW_SIZE; round++) {
    const result = await orchestrator.advance();
    assert.equal(result.kind, "advanced", `round ${round} should advance, got ${result.kind}`);
  }
});
test("stuck-loop: ring saturated with same unit blocks with action 'stop' and stuck-loop reason", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const results = [];
  for (let i = 0; i < STUCK_WINDOW_SIZE; i++) {
    results.push(await orchestrator.advance());
  }
  assert.equal(results[0].kind, "advanced");
  for (let i = 1; i < STUCK_WINDOW_SIZE - 1; i++) {
    const r = results[i];
    assert.equal(r.kind, "blocked", `round ${i} should be blocked`);
    if (r.kind !== "blocked") return;
    assert.equal(r.reason, "idempotent advance: unit already active");
    assert.equal(r.action, "stop");
  }
  const last = results[STUCK_WINDOW_SIZE - 1];
  assert.equal(last.kind, "blocked");
  if (last.kind !== "blocked") return;
  assert.equal(last.action, "stop");
  assert.equal(last.reason, `stuck-loop: execute-task:T01 picked ${STUCK_WINDOW_SIZE} times`);
});
test("stuck-loop: idempotency block continues to fire with its own reason before saturation", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  const first = await orchestrator.advance();
  const second = await orchestrator.advance();
  assert.equal(first.kind, "advanced");
  assert.equal(second.kind, "blocked");
  assert.equal(second.reason, "idempotent advance: unit already active");
  assert.equal(second.action, "stop");
});
test("stuck-loop: start() resets the ring so a fresh saturation cycle is required", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  for (let i = 0; i < STUCK_WINDOW_SIZE - 1; i++) {
    await orchestrator.advance();
  }
  const restarted = await orchestrator.start({ basePath: "/tmp/project", trigger: "manual" });
  assert.equal(restarted.kind, "advanced");
  const next = await orchestrator.advance();
  assert.equal(next.kind, "blocked");
  assert.equal(next.reason, "idempotent advance: unit already active");
});
test("stuck-loop: resume() resets the ring", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  for (let i = 0; i < STUCK_WINDOW_SIZE - 1; i++) {
    await orchestrator.advance();
  }
  const resumed = await orchestrator.resume();
  assert.equal(resumed.kind, "advanced");
  const next = await orchestrator.advance();
  assert.equal(next.kind, "blocked");
  assert.equal(next.reason, "idempotent advance: unit already active");
});
test("stuck-loop: stop() resets the ring", async () => {
  const { deps } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  for (let i = 0; i < STUCK_WINDOW_SIZE - 1; i++) {
    await orchestrator.advance();
  }
  const stopped = await orchestrator.stop("user-request");
  assert.equal(stopped.kind, "stopped");
  const next = await orchestrator.advance();
  assert.equal(next.kind, "advanced");
});
test("stuck-loop: journal records the stuck-loop reason on advance-blocked", async () => {
  const { deps, calls } = makeDeps();
  const orchestrator = createAutoOrchestrator(deps);
  for (let i = 0; i < STUCK_WINDOW_SIZE; i++) {
    await orchestrator.advance();
  }
  assert.ok(calls.includes("journal:advance-blocked"));
});
test("wired DispatchAdapter forwards session-derived dispatch inputs identically to runDispatch", async () => {
  const stateSnapshot = makeState();
  const captured = [];
  const captureRule = {
    name: "test-capture",
    when: "dispatch",
    evaluation: "first-match",
    where: async (ctx) => {
      captured.push(ctx);
      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: "T01",
        prompt: "parity-fixture"
      };
    },
    then: (r) => r
  };
  setRegistry(new RuleRegistry([captureRule]));
  try {
    const fakeModelRegistry = {
      getAll: () => [],
      getProviderAuthMode: (_provider) => "apiKey"
    };
    const ctx = {
      model: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 2e5
      },
      modelRegistry: fakeModelRegistry
    };
    const pi = {
      getActiveTools: () => ["read_file", "write_file"]
    };
    const basePath = "/tmp/parity-fixture";
    const adapter = createWiredDispatchAdapter(ctx, pi, basePath);
    const adapterResult = await adapter.decideNextUnit({ stateSnapshot });
    const prefs = void 0;
    const provider = ctx.model?.provider;
    const authMode = provider && typeof ctx.modelRegistry?.getProviderAuthMode === "function" ? ctx.modelRegistry.getProviderAuthMode(provider) : void 0;
    const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    const structuredQuestionsAvailable = prefs !== void 0 && prefs.planning_depth === "deep" ? "false" : supportsStructuredQuestions(activeTools, {
      authMode,
      baseUrl: ctx.model?.baseUrl
    }) ? "true" : "false";
    const builtDirectCtx = {
      basePath,
      mid: stateSnapshot.activeMilestone.id,
      midTitle: stateSnapshot.activeMilestone.title,
      state: stateSnapshot,
      prefs,
      structuredQuestionsAvailable,
      sessionContextWindow: ctx.model?.contextWindow,
      sessionProvider: ctx.model?.provider,
      modelRegistry: ctx.modelRegistry
    };
    const directAction = await resolveDispatch(builtDirectCtx);
    assert.equal(captured.length, 2, "expected two captured dispatch contexts");
    const [adapterCtx, directCtx] = captured;
    assert.equal(adapterCtx.structuredQuestionsAvailable, directCtx.structuredQuestionsAvailable);
    assert.equal(adapterCtx.sessionContextWindow, directCtx.sessionContextWindow);
    assert.equal(adapterCtx.sessionProvider, directCtx.sessionProvider);
    assert.equal(adapterCtx.modelRegistry, directCtx.modelRegistry);
    assert.equal(adapterCtx.basePath, directCtx.basePath);
    assert.equal(adapterCtx.mid, directCtx.mid);
    assert.equal(adapterCtx.midTitle, directCtx.midTitle);
    if (!adapterResult || !("unitType" in adapterResult)) {
      assert.fail("expected adapter result to be a dispatch decision");
    }
    assert.equal(adapterResult.unitType, "execute-task");
    assert.equal(adapterResult.unitId, "T01");
    assert.equal(adapterResult.reason, "test-capture");
    assert.equal(directAction.action, "dispatch");
    if (directAction.action === "dispatch") {
      assert.equal(directAction.unitType, adapterResult.unitType);
      assert.equal(directAction.unitId, adapterResult.unitId);
      assert.equal(directAction.matchedRule, adapterResult.reason);
    }
  } finally {
    resetRegistry();
  }
});
test("wired DispatchAdapter prefers caller-supplied dispatch inputs over ctx-derived values", async () => {
  const stateSnapshot = makeState();
  const captured = [];
  const captureRule = {
    name: "test-capture-overrides",
    when: "dispatch",
    evaluation: "first-match",
    where: async (ctx) => {
      captured.push(ctx);
      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: "T01",
        prompt: "override-fixture"
      };
    },
    then: (r) => r
  };
  setRegistry(new RuleRegistry([captureRule]));
  try {
    const ctxModelRegistry = {
      getAll: () => [],
      getProviderAuthMode: (_provider) => "apiKey"
    };
    const overrideModelRegistry = {
      getAll: () => [],
      getProviderAuthMode: (_provider) => "oauth"
    };
    const ctx = {
      model: {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 2e5
      },
      modelRegistry: ctxModelRegistry
    };
    const pi = {
      getActiveTools: () => []
    };
    const adapter = createWiredDispatchAdapter(ctx, pi, "/tmp/parity-fixture");
    const result = await adapter.decideNextUnit({
      stateSnapshot,
      structuredQuestionsAvailable: "true",
      sessionContextWindow: 5e5,
      sessionProvider: "openai",
      modelRegistry: overrideModelRegistry
    });
    assert.ok(result);
    assert.equal(captured.length, 1, "expected one captured dispatch context");
    assert.equal(captured[0].structuredQuestionsAvailable, "true");
    assert.equal(captured[0].sessionContextWindow, 5e5);
    assert.equal(captured[0].sessionProvider, "openai");
    assert.equal(captured[0].modelRegistry, overrideModelRegistry);
  } finally {
    resetRegistry();
  }
});
test("wired DispatchAdapter preserves stop reason as a blocked decision", async () => {
  const stateSnapshot = makeState();
  const stopRule = {
    name: "test-stop",
    when: "dispatch",
    evaluation: "first-match",
    where: async () => ({
      action: "stop",
      reason: "remediation blocker",
      level: "warning"
    }),
    then: (r) => r
  };
  setRegistry(new RuleRegistry([stopRule]));
  try {
    const ctx = { model: {}, modelRegistry: { getAll: () => [] } };
    const pi = { getActiveTools: () => [] };
    const adapter = createWiredDispatchAdapter(ctx, pi, "/tmp/parity-fixture");
    const result = await adapter.decideNextUnit({ stateSnapshot });
    assert.deepEqual(result, {
      kind: "blocked",
      reason: "remediation blocker",
      action: "pause"
    });
  } finally {
    resetRegistry();
  }
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9hdXRvLW9yY2hlc3RyYXRvci50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogQXV0byBPcmNoZXN0cmF0aW9uIG1vZHVsZSBjb250cmFjdCBhbmQgQURSLTAxNSBpbnZhcmlhbnQgc2VxdWVuY2UgdGVzdHMuXG5cbmltcG9ydCB0ZXN0IGZyb20gXCJub2RlOnRlc3RcIjtcbmltcG9ydCBhc3NlcnQgZnJvbSBcIm5vZGU6YXNzZXJ0L3N0cmljdFwiO1xuXG5pbXBvcnQgeyBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yLCBTVFVDS19XSU5ET1dfU0laRSB9IGZyb20gXCIuLi9hdXRvL29yY2hlc3RyYXRvci5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBdXRvT3JjaGVzdHJhdG9yRGVwcyB9IGZyb20gXCIuLi9hdXRvL2NvbnRyYWN0cy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBHU0RTdGF0ZSB9IGZyb20gXCIuLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlV2lyZWREaXNwYXRjaEFkYXB0ZXIgfSBmcm9tIFwiLi4vYXV0by5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZURpc3BhdGNoLCB0eXBlIERpc3BhdGNoQ29udGV4dCB9IGZyb20gXCIuLi9hdXRvLWRpc3BhdGNoLmpzXCI7XG5pbXBvcnQgeyBSdWxlUmVnaXN0cnksIHNldFJlZ2lzdHJ5LCByZXNldFJlZ2lzdHJ5IH0gZnJvbSBcIi4uL3J1bGUtcmVnaXN0cnkuanNcIjtcbmltcG9ydCB0eXBlIHsgVW5pZmllZFJ1bGUgfSBmcm9tIFwiLi4vcnVsZS10eXBlcy5qc1wiO1xuaW1wb3J0IHsgc3VwcG9ydHNTdHJ1Y3R1cmVkUXVlc3Rpb25zIH0gZnJvbSBcIi4uL3dvcmtmbG93LW1jcC5qc1wiO1xuXG5mdW5jdGlvbiBtYWtlU3RhdGUoKTogR1NEU3RhdGUge1xuICByZXR1cm4ge1xuICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIk1pbGVzdG9uZVwiIH0sXG4gICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgIGJsb2NrZXJzOiBbXSxcbiAgICBuZXh0QWN0aW9uOiBcIkV4ZWN1dGUgdGFza1wiLFxuICAgIHJlZ2lzdHJ5OiBbXSxcbiAgICByZXF1aXJlbWVudHM6IHsgYWN0aXZlOiAwLCB2YWxpZGF0ZWQ6IDAsIGRlZmVycmVkOiAwLCBvdXRPZlNjb3BlOiAwLCBibG9ja2VkOiAwLCB0b3RhbDogMCB9LFxuICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IHsgZG9uZTogMCwgdG90YWw6IDEgfSB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBtYWtlRGVwcyhvdmVycmlkZXM6IFBhcnRpYWw8QXV0b09yY2hlc3RyYXRvckRlcHM+ID0ge30pOiB7IGRlcHM6IEF1dG9PcmNoZXN0cmF0b3JEZXBzOyBjYWxsczogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBzdGF0ZVNuYXBzaG90ID0gbWFrZVN0YXRlKCk7XG5cbiAgY29uc3QgZGVwczogQXV0b09yY2hlc3RyYXRvckRlcHMgPSB7XG4gICAgc3RhdGVSZWNvbmNpbGlhdGlvbjoge1xuICAgICAgYXN5bmMgcmVjb25jaWxlQmVmb3JlRGlzcGF0Y2goKSB7XG4gICAgICAgIGNhbGxzLnB1c2goXCJzdGF0ZS5yZWNvbmNpbGVcIik7XG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBzdGF0ZVNuYXBzaG90IH07XG4gICAgICB9LFxuICAgIH0sXG4gICAgZGlzcGF0Y2g6IHtcbiAgICAgIGFzeW5jIGRlY2lkZU5leHRVbml0KGlucHV0KSB7XG4gICAgICAgIGNhbGxzLnB1c2goXCJkaXNwYXRjaC5kZWNpZGVcIik7XG4gICAgICAgIGFzc2VydC5lcXVhbChpbnB1dC5zdGF0ZVNuYXBzaG90LCBzdGF0ZVNuYXBzaG90KTtcbiAgICAgICAgcmV0dXJuIHsgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIHVuaXRJZDogXCJUMDFcIiwgcmVhc29uOiBcInJlYWR5XCIsIHByZWNvbmRpdGlvbnM6IFtdIH07XG4gICAgICB9LFxuICAgIH0sXG4gICAgdG9vbENvbnRyYWN0OiB7XG4gICAgICBhc3luYyBjb21waWxlVW5pdFRvb2xDb250cmFjdCgpIHtcbiAgICAgICAgY2FsbHMucHVzaChcInRvb2wuY29tcGlsZVwiKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICByZWNvdmVyeToge1xuICAgICAgYXN5bmMgY2xhc3NpZnlBbmRSZWNvdmVyKCkge1xuICAgICAgICBjYWxscy5wdXNoKFwicmVjb3ZlcnkuY2xhc3NpZnlcIik7XG4gICAgICAgIHJldHVybiB7IGFjdGlvbjogXCJzdG9wXCIsIHJlYXNvbjogXCJmYXRhbFwiIH07XG4gICAgICB9LFxuICAgIH0sXG4gICAgd29ya3RyZWU6IHtcbiAgICAgIGFzeW5jIHByZXBhcmVGb3JVbml0KCkge1xuICAgICAgICBjYWxscy5wdXNoKFwid29ya3RyZWUucHJlcGFyZVwiKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICAgIH0sXG4gICAgICBhc3luYyBzeW5jQWZ0ZXJVbml0KCkgeyBjYWxscy5wdXNoKFwid29ya3RyZWUuc3luY1wiKTsgfSxcbiAgICAgIGFzeW5jIGNsZWFudXBPblN0b3AoKSB7IGNhbGxzLnB1c2goXCJ3b3JrdHJlZS5jbGVhbnVwXCIpOyB9LFxuICAgIH0sXG4gICAgaGVhbHRoOiB7XG4gICAgICBjaGVja1Jlc291cmNlc1N0YWxlKCkge1xuICAgICAgICBjYWxscy5wdXNoKFwiaGVhbHRoLnN0YWxlXCIpO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH0sXG4gICAgICBhc3luYyBwcmVBZHZhbmNlR2F0ZSgpIHtcbiAgICAgICAgY2FsbHMucHVzaChcImhlYWx0aC5wcmVcIik7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwicGFzc1wiIH07XG4gICAgICB9LFxuICAgICAgYXN5bmMgcG9zdEFkdmFuY2VSZWNvcmQoKSB7IGNhbGxzLnB1c2goXCJoZWFsdGgucG9zdFwiKTsgfSxcbiAgICB9LFxuICAgIHJ1bnRpbWU6IHtcbiAgICAgIGFzeW5jIGVuc3VyZUxvY2tPd25lcnNoaXAoKSB7IGNhbGxzLnB1c2goXCJydW50aW1lLmxvY2tcIik7IH0sXG4gICAgICBhc3luYyBqb3VybmFsVHJhbnNpdGlvbihldmVudCkgeyBjYWxscy5wdXNoKGBqb3VybmFsOiR7ZXZlbnQubmFtZX1gKTsgfSxcbiAgICB9LFxuICAgIG5vdGlmaWNhdGlvbnM6IHtcbiAgICAgIGFzeW5jIG5vdGlmeUxpZmVjeWNsZShldmVudCkgeyBjYWxscy5wdXNoKGBub3RpZnk6JHtldmVudC5uYW1lfWApOyB9LFxuICAgIH0sXG4gICAgdW9rR2F0ZToge1xuICAgICAgYXN5bmMgZW1pdChpbnB1dCkgeyBjYWxscy5wdXNoKGBnYXRlOiR7aW5wdXQuZ2F0ZUlkfToke2lucHV0Lm91dGNvbWV9YCk7IH0sXG4gICAgfSxcbiAgfTtcblxuICByZXR1cm4geyBkZXBzOiB7IC4uLmRlcHMsIC4uLm92ZXJyaWRlcyB9LCBjYWxscyB9O1xufVxuXG50ZXN0KFwic3RhcnQoKSBhZHZhbmNlcyBhbmQgcmVjb3JkcyBhY3RpdmUgdW5pdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3JjaGVzdHJhdG9yLnN0YXJ0KHsgYmFzZVBhdGg6IFwiL3RtcC9wcm9qZWN0XCIsIHRyaWdnZXI6IFwibWFudWFsXCIgfSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcImFkdmFuY2VkXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC51bml0LCB7IHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLCB1bml0SWQ6IFwiVDAxXCIgfSk7XG4gIGNvbnN0IHN0YXR1cyA9IG9yY2hlc3RyYXRvci5nZXRTdGF0dXMoKTtcbiAgYXNzZXJ0LmVxdWFsKHN0YXR1cy5waGFzZSwgXCJydW5uaW5nXCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKHN0YXR1cy5hY3RpdmVVbml0LCB7IHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLCB1bml0SWQ6IFwiVDAxXCIgfSk7XG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcImpvdXJuYWw6c3RhcnRcIikpO1xuICBhc3NlcnQub2soY2FsbHMuaW5jbHVkZXMoXCJqb3VybmFsOmFkdmFuY2VcIikpO1xufSk7XG5cbnRlc3QoXCJhZHZhbmNlKCkgcmV0dXJucyBibG9ja2VkIHdoZW4gaGVhbHRoIGdhdGUgZGVuaWVzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBjYWxscyB9ID0gbWFrZURlcHMoe1xuICAgIGhlYWx0aDoge1xuICAgICAgY2hlY2tSZXNvdXJjZXNTdGFsZTogKCkgPT4gbnVsbCxcbiAgICAgIGFzeW5jIHByZUFkdmFuY2VHYXRlKCkgeyByZXR1cm4geyBraW5kOiBcImZhaWxcIiwgcmVhc29uOiBcImRvY3Rvci1ibG9ja1wiIH07IH0sXG4gICAgICBhc3luYyBwb3N0QWR2YW5jZVJlY29yZCgpIHt9LFxuICAgIH0sXG4gIH0pO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcImJsb2NrZWRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucmVhc29uLCBcImRvY3Rvci1ibG9ja1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwicGF1c2VcIik7XG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcImdhdGU6cHJlLWRpc3BhdGNoLWhlYWx0aC1nYXRlOm1hbnVhbC1hdHRlbnRpb25cIikpO1xufSk7XG5cbnRlc3QoXCJhZHZhbmNlKCkgcmV0dXJucyBibG9ja2VkIHN0b3Agd2hlbiByZXNvdXJjZXMgYXJlIHN0YWxlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBjYWxscyB9ID0gbWFrZURlcHMoe1xuICAgIGhlYWx0aDoge1xuICAgICAgY2hlY2tSZXNvdXJjZXNTdGFsZTogKCkgPT4gXCJyZXNvdXJjZXMgY2hhbmdlZCBzaW5jZSBzZXNzaW9uIHN0YXJ0XCIsXG4gICAgICBhc3luYyBwcmVBZHZhbmNlR2F0ZSgpIHsgcmV0dXJuIHsga2luZDogXCJwYXNzXCIgfTsgfSxcbiAgICAgIGFzeW5jIHBvc3RBZHZhbmNlUmVjb3JkKCkge30sXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwiYmxvY2tlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWFzb24sIFwicmVzb3VyY2VzIGNoYW5nZWQgc2luY2Ugc2Vzc2lvbiBzdGFydFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwic3RvcFwiKTtcbiAgYXNzZXJ0Lm9rKGNhbGxzLmluY2x1ZGVzKFwiZ2F0ZTpyZXNvdXJjZS12ZXJzaW9uLWd1YXJkOmZhaWxcIikpO1xuICBhc3NlcnQub2soIWNhbGxzLmluY2x1ZGVzKFwiaGVhbHRoLnByZVwiKSk7XG4gIGFzc2VydC5vayghY2FsbHMuaW5jbHVkZXMoXCJzdGF0ZS5yZWNvbmNpbGVcIikpO1xufSk7XG5cbnRlc3QoXCJhZHZhbmNlKCkgY29udGludWVzIHBhc3QgcHJlLWRpc3BhdGNoIGhlYWx0aCBnYXRlIHdoZW4gaXQgdGhyb3dzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBjYWxscyB9ID0gbWFrZURlcHMoe1xuICAgIGhlYWx0aDoge1xuICAgICAgY2hlY2tSZXNvdXJjZXNTdGFsZTogKCkgPT4gbnVsbCxcbiAgICAgIGFzeW5jIHByZUFkdmFuY2VHYXRlKCkgeyByZXR1cm4geyBraW5kOiBcInRocmV3XCIsIGVycm9yOiBuZXcgRXJyb3IoXCJib29tXCIpIH07IH0sXG4gICAgICBhc3luYyBwb3N0QWR2YW5jZVJlY29yZCgpIHt9LFxuICAgIH0sXG4gIH0pO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcImFkdmFuY2VkXCIpO1xuICBhc3NlcnQub2soY2FsbHMuaW5jbHVkZXMoXCJnYXRlOnByZS1kaXNwYXRjaC1oZWFsdGgtZ2F0ZTptYW51YWwtYXR0ZW50aW9uXCIpKTtcbiAgYXNzZXJ0Lm9rKGNhbGxzLmluY2x1ZGVzKFwic3RhdGUucmVjb25jaWxlXCIpKTtcbiAgYXNzZXJ0Lm9rKGNhbGxzLmluY2x1ZGVzKFwiZGlzcGF0Y2guZGVjaWRlXCIpKTtcbn0pO1xuXG50ZXN0KFwiYWR2YW5jZSgpIGZvcndhcmRzIGZpeGVzQXBwbGllZCBpbnRvIHByZS1kaXNwYXRjaC1oZWFsdGgtZ2F0ZSBwYXNzIGZpbmRpbmdzXCIsIGFzeW5jICgpID0+IHtcbiAgbGV0IG9ic2VydmVkID0gXCJcIjtcbiAgY29uc3QgeyBkZXBzIH0gPSBtYWtlRGVwcyh7XG4gICAgaGVhbHRoOiB7XG4gICAgICBjaGVja1Jlc291cmNlc1N0YWxlOiAoKSA9PiBudWxsLFxuICAgICAgYXN5bmMgcHJlQWR2YW5jZUdhdGUoKSB7IHJldHVybiB7IGtpbmQ6IFwicGFzc1wiLCBmaXhlc0FwcGxpZWQ6IFtcImZpeC1hXCIsIFwiZml4LWJcIl0gfTsgfSxcbiAgICAgIGFzeW5jIHBvc3RBZHZhbmNlUmVjb3JkKCkge30sXG4gICAgfSxcbiAgICB1b2tHYXRlOiB7XG4gICAgICBhc3luYyBlbWl0KGlucHV0KSB7XG4gICAgICAgIGlmIChpbnB1dC5nYXRlSWQgPT09IFwicHJlLWRpc3BhdGNoLWhlYWx0aC1nYXRlXCIgJiYgaW5wdXQub3V0Y29tZSA9PT0gXCJwYXNzXCIpIHtcbiAgICAgICAgICBvYnNlcnZlZCA9IGlucHV0LmZpbmRpbmdzID8/IFwiXCI7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcblxuICBhc3NlcnQuZXF1YWwob2JzZXJ2ZWQsIFwiZml4LWEsIGZpeC1iXCIpO1xufSk7XG5cbnRlc3QoXCJhZHZhbmNlKCkgZm9sbG93cyB0aGUgQURSLTAxNSBpbnZhcmlhbnQgc2VxdWVuY2UgYmVmb3JlIGpvdXJuYWxpbmcgYWR2YW5jZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwiYWR2YW5jZWRcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LnVuaXQsIHsgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsIHVuaXRJZDogXCJUMDFcIiB9KTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChjYWxscywgW1xuICAgIFwicnVudGltZS5sb2NrXCIsXG4gICAgXCJoZWFsdGguc3RhbGVcIixcbiAgICBcImdhdGU6cmVzb3VyY2UtdmVyc2lvbi1ndWFyZDpwYXNzXCIsXG4gICAgXCJoZWFsdGgucHJlXCIsXG4gICAgXCJnYXRlOnByZS1kaXNwYXRjaC1oZWFsdGgtZ2F0ZTpwYXNzXCIsXG4gICAgXCJzdGF0ZS5yZWNvbmNpbGVcIixcbiAgICBcImRpc3BhdGNoLmRlY2lkZVwiLFxuICAgIFwidG9vbC5jb21waWxlXCIsXG4gICAgXCJ3b3JrdHJlZS5wcmVwYXJlXCIsXG4gICAgXCJqb3VybmFsOmFkdmFuY2VcIixcbiAgICBcIndvcmt0cmVlLnN5bmNcIixcbiAgICBcImhlYWx0aC5wb3N0XCIsXG4gIF0pO1xufSk7XG5cbnRlc3QoXCJhZHZhbmNlKCkgYmxvY2tzIGJlZm9yZSBkaXNwYXRjaCB3aGVuIFN0YXRlIFJlY29uY2lsaWF0aW9uIGJsb2Nrc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VEZXBzKHtcbiAgICBzdGF0ZVJlY29uY2lsaWF0aW9uOiB7XG4gICAgICBhc3luYyByZWNvbmNpbGVCZWZvcmVEaXNwYXRjaCgpIHtcbiAgICAgICAgY2FsbHMucHVzaChcInN0YXRlLnJlY29uY2lsZVwiKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IFwic3RhdGUgZHJpZnQgYmxvY2tlZFwiLCBzdGF0ZVNuYXBzaG90OiBtYWtlU3RhdGUoKSB9O1xuICAgICAgfSxcbiAgICB9LFxuICB9KTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJibG9ja2VkXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlYXNvbiwgXCJzdGF0ZSBkcmlmdCBibG9ja2VkXCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJwYXVzZVwiKTtcbiAgYXNzZXJ0Lm9rKCFjYWxscy5pbmNsdWRlcyhcImRpc3BhdGNoLmRlY2lkZVwiKSk7XG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcImpvdXJuYWw6YWR2YW5jZS1ibG9ja2VkXCIpKTtcbn0pO1xuXG50ZXN0KFwiYWR2YW5jZSgpIGJsb2NrcyBiZWZvcmUgUnVudGltZSBwZXJzaXN0ZW5jZSB3aGVuIFRvb2wgQ29udHJhY3QgZmFpbHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMsIGNhbGxzIH0gPSBtYWtlRGVwcyh7XG4gICAgdG9vbENvbnRyYWN0OiB7XG4gICAgICBhc3luYyBjb21waWxlVW5pdFRvb2xDb250cmFjdCgpIHtcbiAgICAgICAgY2FsbHMucHVzaChcInRvb2wuY29tcGlsZVwiKTtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IFwidW5rbm93biBVbml0XCIgfTtcbiAgICAgIH0sXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwiYmxvY2tlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWFzb24sIFwidW5rbm93biBVbml0XCIpO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJwYXVzZVwiKTtcbiAgYXNzZXJ0Lm9rKCFjYWxscy5pbmNsdWRlcyhcIndvcmt0cmVlLnByZXBhcmVcIikpO1xuICBhc3NlcnQub2soIWNhbGxzLmluY2x1ZGVzKFwiam91cm5hbDphZHZhbmNlXCIpKTtcbiAgYXNzZXJ0Lm9rKGNhbGxzLmluY2x1ZGVzKFwiam91cm5hbDphZHZhbmNlLWJsb2NrZWRcIikpO1xufSk7XG5cbnRlc3QoXCJhZHZhbmNlKCkgYmxvY2tzIGJlZm9yZSBSdW50aW1lIHBlcnNpc3RlbmNlIHdoZW4gV29ya3RyZWUgU2FmZXR5IGZhaWxzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBjYWxscyB9ID0gbWFrZURlcHMoe1xuICAgIHdvcmt0cmVlOiB7XG4gICAgICBhc3luYyBwcmVwYXJlRm9yVW5pdCgpIHtcbiAgICAgICAgY2FsbHMucHVzaChcIndvcmt0cmVlLnByZXBhcmVcIik7XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBcIndvcmt0cmVlIGludmFsaWRcIiB9O1xuICAgICAgfSxcbiAgICAgIGFzeW5jIHN5bmNBZnRlclVuaXQoKSB7IGNhbGxzLnB1c2goXCJ3b3JrdHJlZS5zeW5jXCIpOyB9LFxuICAgICAgYXN5bmMgY2xlYW51cE9uU3RvcCgpIHsgY2FsbHMucHVzaChcIndvcmt0cmVlLmNsZWFudXBcIik7IH0sXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwiYmxvY2tlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWFzb24sIFwid29ya3RyZWUgaW52YWxpZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwicGF1c2VcIik7XG4gIGFzc2VydC5vayghY2FsbHMuaW5jbHVkZXMoXCJqb3VybmFsOmFkdmFuY2VcIikpO1xuICBhc3NlcnQub2soIWNhbGxzLmluY2x1ZGVzKFwid29ya3RyZWUuc3luY1wiKSk7XG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcImpvdXJuYWw6YWR2YW5jZS1ibG9ja2VkXCIpKTtcbn0pO1xuXG50ZXN0KFwiYWR2YW5jZSgpIHN0b3BzIHdoZW4gZGlzcGF0Y2ggaGFzIG5vIG5leHQgdW5pdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcyB9ID0gbWFrZURlcHMoe1xuICAgIGRpc3BhdGNoOiB7XG4gICAgICBhc3luYyBkZWNpZGVOZXh0VW5pdCgpIHsgcmV0dXJuIG51bGw7IH0sXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwic3RvcHBlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG9yY2hlc3RyYXRvci5nZXRTdGF0dXMoKS5waGFzZSwgXCJzdG9wcGVkXCIpO1xufSk7XG5cbnRlc3QoXCJhZHZhbmNlKCkgc3VyZmFjZXMgZGlzcGF0Y2ggYmxvY2tlciByZWFzb24gaW5zdGVhZCBvZiBnZW5lcmljIG5vIHJlbWFpbmluZyB1bml0c1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VEZXBzKHtcbiAgICBkaXNwYXRjaDoge1xuICAgICAgYXN5bmMgZGVjaWRlTmV4dFVuaXQoKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJibG9ja2VkXCIsXG4gICAgICAgICAgcmVhc29uOiBcIk1pbGVzdG9uZSBNMDAxIHZhbGlkYXRpb24gdmVyZGljdCBpcyBuZWVkcy1yZW1lZGlhdGlvbiBidXQgYWxsIHNsaWNlcyBhcmUgY29tcGxldGUuXCIsXG4gICAgICAgICAgYWN0aW9uOiBcInBhdXNlXCIsXG4gICAgICAgIH07XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcImJsb2NrZWRcIik7XG4gIGlmIChyZXN1bHQua2luZCAhPT0gXCJibG9ja2VkXCIpIHJldHVybjtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWFzb24sIFwiTWlsZXN0b25lIE0wMDEgdmFsaWRhdGlvbiB2ZXJkaWN0IGlzIG5lZWRzLXJlbWVkaWF0aW9uIGJ1dCBhbGwgc2xpY2VzIGFyZSBjb21wbGV0ZS5cIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcInBhdXNlXCIpO1xuICBhc3NlcnQub2soY2FsbHMuaW5jbHVkZXMoXCJqb3VybmFsOmFkdmFuY2UtYmxvY2tlZFwiKSk7XG4gIGFzc2VydC5vayghY2FsbHMuaW5jbHVkZXMoXCJqb3VybmFsOmFkdmFuY2Utc3RvcHBlZFwiKSk7XG59KTtcblxudGVzdChcInJlc3VtZSgpIHJldHVybnMgYmxvY2tlZCB3aGVuIGFkdmFuY2UgZGV0ZWN0cyBhIGRpc3BhdGNoIGJsb2NrZXJcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMgfSA9IG1ha2VEZXBzKHtcbiAgICBkaXNwYXRjaDoge1xuICAgICAgYXN5bmMgZGVjaWRlTmV4dFVuaXQoKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAga2luZDogXCJibG9ja2VkXCIsXG4gICAgICAgICAgcmVhc29uOiBcInJlbWVkaWF0aW9uIHJlcXVpcmVkXCIsXG4gICAgICAgICAgYWN0aW9uOiBcInBhdXNlXCIsXG4gICAgICAgIH07XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5yZXN1bWUoKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwiYmxvY2tlZFwiKTtcbiAgaWYgKHJlc3VsdC5raW5kICE9PSBcImJsb2NrZWRcIikgcmV0dXJuO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LnJlYXNvbiwgXCJyZW1lZGlhdGlvbiByZXF1aXJlZFwiKTtcbn0pO1xuXG50ZXN0KFwiYWR2YW5jZSgpIHVzZXMgcmVjb3Zlcnkgb24gZXJyb3JcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMsIGNhbGxzIH0gPSBtYWtlRGVwcyh7XG4gICAgcnVudGltZToge1xuICAgICAgYXN5bmMgZW5zdXJlTG9ja093bmVyc2hpcCgpIHsgdGhyb3cgbmV3IEVycm9yKFwibG9jayBsb3N0XCIpOyB9LFxuICAgICAgYXN5bmMgam91cm5hbFRyYW5zaXRpb24oZXZlbnQpIHsgY2FsbHMucHVzaChgam91cm5hbDoke2V2ZW50Lm5hbWV9YCk7IH0sXG4gICAgfSxcbiAgICByZWNvdmVyeToge1xuICAgICAgYXN5bmMgY2xhc3NpZnlBbmRSZWNvdmVyKCkgeyByZXR1cm4geyBhY3Rpb246IFwiZXNjYWxhdGVcIiwgcmVhc29uOiBcIm5lZWRzIG1hbnVhbFwiIH07IH0sXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmtpbmQsIFwiZXJyb3JcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQucmVhc29uLCBcIm5lZWRzIG1hbnVhbFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG9yY2hlc3RyYXRvci5nZXRTdGF0dXMoKS5waGFzZSwgXCJlcnJvclwiKTtcbiAgYXNzZXJ0Lm9rKGNhbGxzLmluY2x1ZGVzKFwiam91cm5hbDphZHZhbmNlLWVycm9yXCIpKTtcbn0pO1xuXG50ZXN0KFwiYWR2YW5jZSgpIGlzIGlkZW1wb3RlbnQgZm9yIHRoZSBzYW1lIGFjdGl2ZSB1bml0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBjYWxscyB9ID0gbWFrZURlcHMoKTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBjb25zdCBmaXJzdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG4gIGNvbnN0IHNlY29uZCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG5cbiAgYXNzZXJ0LmVxdWFsKGZpcnN0LmtpbmQsIFwiYWR2YW5jZWRcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwoZmlyc3QudW5pdCwgeyB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIiwgdW5pdElkOiBcIlQwMVwiIH0pO1xuICBhc3NlcnQuZXF1YWwoc2Vjb25kLmtpbmQsIFwiYmxvY2tlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNlY29uZC5yZWFzb24sIFwiaWRlbXBvdGVudCBhZHZhbmNlOiB1bml0IGFscmVhZHkgYWN0aXZlXCIpO1xuICBhc3NlcnQuZXF1YWwoc2Vjb25kLmFjdGlvbiwgXCJzdG9wXCIpO1xuXG4gIGNvbnN0IHByZXBhcmVDYWxscyA9IGNhbGxzLmZpbHRlcigoYykgPT4gYyA9PT0gXCJ3b3JrdHJlZS5wcmVwYXJlXCIpLmxlbmd0aDtcbiAgYXNzZXJ0LmVxdWFsKHByZXBhcmVDYWxscywgMSk7XG59KTtcblxudGVzdChcInJlc3VtZSgpIHJlLWVudGVycyBydW5uaW5nIGZsb3cgdmlhIGFkdmFuY2VcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMgfSA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgb3JjaGVzdHJhdG9yLnJlc3VtZSgpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJhZHZhbmNlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG9yY2hlc3RyYXRvci5nZXRTdGF0dXMoKS5waGFzZSwgXCJydW5uaW5nXCIpO1xufSk7XG5cbnRlc3QoXCJyZXN1bWUoKSBjbGVhcnMgaWRlbXBvdGVudCBsb2NrIGFuZCBhbGxvd3MgcmUtYWR2YW5jZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcyB9ID0gbWFrZURlcHMoKTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBjb25zdCBmaXJzdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG4gIGNvbnN0IGJsb2NrZWQgPSBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBjb25zdCByZXN1bWVkID0gYXdhaXQgb3JjaGVzdHJhdG9yLnJlc3VtZSgpO1xuXG4gIGFzc2VydC5lcXVhbChmaXJzdC5raW5kLCBcImFkdmFuY2VkXCIpO1xuICBhc3NlcnQuZXF1YWwoYmxvY2tlZC5raW5kLCBcImJsb2NrZWRcIik7XG4gIGFzc2VydC5lcXVhbChyZXN1bWVkLmtpbmQsIFwiYWR2YW5jZWRcIik7XG59KTtcblxudGVzdChcInRyYW5zaXRpb25Db3VudCBpbmNyZWFzZXMgYWNyb3NzIGxpZmVjeWNsZSB0cmFuc2l0aW9uc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcyB9ID0gbWFrZURlcHMoKTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBjb25zdCBiZWZvcmUgPSBvcmNoZXN0cmF0b3IuZ2V0U3RhdHVzKCkudHJhbnNpdGlvbkNvdW50O1xuICBhd2FpdCBvcmNoZXN0cmF0b3Iuc3RhcnQoeyBiYXNlUGF0aDogXCIvdG1wL3Byb2plY3RcIiwgdHJpZ2dlcjogXCJtYW51YWxcIiB9KTtcbiAgY29uc3QgYWZ0ZXJTdGFydCA9IG9yY2hlc3RyYXRvci5nZXRTdGF0dXMoKS50cmFuc2l0aW9uQ291bnQ7XG4gIGF3YWl0IG9yY2hlc3RyYXRvci5zdG9wKFwiZG9uZVwiKTtcbiAgY29uc3QgYWZ0ZXJTdG9wID0gb3JjaGVzdHJhdG9yLmdldFN0YXR1cygpLnRyYW5zaXRpb25Db3VudDtcblxuICBhc3NlcnQub2soYWZ0ZXJTdGFydCA+IGJlZm9yZSk7XG4gIGFzc2VydC5vayhhZnRlclN0b3AgPiBhZnRlclN0YXJ0KTtcbn0pO1xuXG50ZXN0KFwic3RvcCgpIGNsZWFycyBpZGVtcG90ZW50IHVuaXQgbG9jayBzbyBhZHZhbmNlIGNhbiBydW4gYWdhaW5cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMgfSA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgZmlyc3QgPSBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBjb25zdCBibG9ja2VkID0gYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcbiAgY29uc3Qgc3RvcHBlZCA9IGF3YWl0IG9yY2hlc3RyYXRvci5zdG9wKFwicmVzZXRcIik7XG4gIGNvbnN0IHNlY29uZCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG5cbiAgYXNzZXJ0LmVxdWFsKGZpcnN0LmtpbmQsIFwiYWR2YW5jZWRcIik7XG4gIGFzc2VydC5lcXVhbChibG9ja2VkLmtpbmQsIFwiYmxvY2tlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHN0b3BwZWQua2luZCwgXCJzdG9wcGVkXCIpO1xuICBhc3NlcnQuZXF1YWwoc2Vjb25kLmtpbmQsIFwiYWR2YW5jZWRcIik7XG59KTtcblxudGVzdChcImFkdmFuY2UoKSBzdG9wcGVkIGNsZWFycyBwcmV2aW91cyBhY3RpdmVVbml0XCIsIGFzeW5jICgpID0+IHtcbiAgbGV0IGZpcnN0ID0gdHJ1ZTtcbiAgY29uc3QgeyBkZXBzIH0gPSBtYWtlRGVwcyh7XG4gICAgZGlzcGF0Y2g6IHtcbiAgICAgIGFzeW5jIGRlY2lkZU5leHRVbml0KCkge1xuICAgICAgICBpZiAoZmlyc3QpIHtcbiAgICAgICAgICBmaXJzdCA9IGZhbHNlO1xuICAgICAgICAgIHJldHVybiB7IHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLCB1bml0SWQ6IFwiVDAxXCIsIHJlYXNvbjogXCJyZWFkeVwiLCBwcmVjb25kaXRpb25zOiBbXSB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfSxcbiAgICB9LFxuICB9KTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBjb25zdCBzdG9wcGVkID0gYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcblxuICBhc3NlcnQuZXF1YWwoc3RvcHBlZC5raW5kLCBcInN0b3BwZWRcIik7XG4gIGFzc2VydC5lcXVhbChvcmNoZXN0cmF0b3IuZ2V0U3RhdHVzKCkuYWN0aXZlVW5pdCwgdW5kZWZpbmVkKTtcbn0pO1xuXG50ZXN0KFwicmVjb3Zlcnkgc3RvcCBjbGVhcnMgYWN0aXZlVW5pdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VEZXBzKHtcbiAgICBydW50aW1lOiB7XG4gICAgICBhc3luYyBlbnN1cmVMb2NrT3duZXJzaGlwKCkgeyB0aHJvdyBuZXcgRXJyb3IoXCJib29tXCIpOyB9LFxuICAgICAgYXN5bmMgam91cm5hbFRyYW5zaXRpb24oZXZlbnQpIHsgY2FsbHMucHVzaChgam91cm5hbDoke2V2ZW50Lm5hbWV9YCk7IH0sXG4gICAgfSxcbiAgICByZWNvdmVyeToge1xuICAgICAgYXN5bmMgY2xhc3NpZnlBbmRSZWNvdmVyKCkgeyByZXR1cm4geyBhY3Rpb246IFwic3RvcFwiLCByZWFzb246IFwiZmF0YWxcIiB9OyB9LFxuICAgIH0sXG4gIH0pO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInN0b3BwZWRcIik7XG4gIGFzc2VydC5lcXVhbChvcmNoZXN0cmF0b3IuZ2V0U3RhdHVzKCkuYWN0aXZlVW5pdCwgdW5kZWZpbmVkKTtcbiAgYXNzZXJ0Lm9rKGNhbGxzLmluY2x1ZGVzKFwiam91cm5hbDphZHZhbmNlLXN0b3BwZWRcIikpO1xuICBhc3NlcnQub2soY2FsbHMuaW5jbHVkZXMoXCJub3RpZnk6c3RvcHBlZFwiKSk7XG4gIGFzc2VydC5vayghY2FsbHMuaW5jbHVkZXMoXCJub3RpZnk6ZXJyb3JcIikpO1xufSk7XG5cbnRlc3QoXCJyZWNvdmVyeSByZXRyeSBtYXBzIHRvIHBhdXNlZCByZXN1bHRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMsIGNhbGxzIH0gPSBtYWtlRGVwcyh7XG4gICAgcnVudGltZToge1xuICAgICAgYXN5bmMgZW5zdXJlTG9ja093bmVyc2hpcCgpIHsgdGhyb3cgbmV3IEVycm9yKFwiYm9vbVwiKTsgfSxcbiAgICAgIGFzeW5jIGpvdXJuYWxUcmFuc2l0aW9uKGV2ZW50KSB7IGNhbGxzLnB1c2goYGpvdXJuYWw6JHtldmVudC5uYW1lfWApOyB9LFxuICAgIH0sXG4gICAgcmVjb3Zlcnk6IHtcbiAgICAgIGFzeW5jIGNsYXNzaWZ5QW5kUmVjb3ZlcigpIHsgcmV0dXJuIHsgYWN0aW9uOiBcInJldHJ5XCIsIHJlYXNvbjogXCJ0cmFuc2llbnRcIiB9OyB9LFxuICAgIH0sXG4gIH0pO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcInBhdXNlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5yZWFzb24sIFwidHJhbnNpZW50XCIpO1xuICBhc3NlcnQuZXF1YWwob3JjaGVzdHJhdG9yLmdldFN0YXR1cygpLnBoYXNlLCBcInBhdXNlZFwiKTtcbiAgYXNzZXJ0Lm9rKGNhbGxzLmluY2x1ZGVzKFwiam91cm5hbDphZHZhbmNlLXBhdXNlZFwiKSk7XG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcIm5vdGlmeTpwYXVzZVwiKSk7XG59KTtcblxudGVzdChcImdldFN0YXR1cygpIHJldHVybnMgZGVmZW5zaXZlIGNvcHkgb2YgYWN0aXZlVW5pdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcyB9ID0gbWFrZURlcHMoKTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBjb25zdCBzbmFwMSA9IG9yY2hlc3RyYXRvci5nZXRTdGF0dXMoKTtcbiAgaWYgKHNuYXAxLmFjdGl2ZVVuaXQpIHNuYXAxLmFjdGl2ZVVuaXQudW5pdElkID0gXCJNVVRBVEVEXCI7XG4gIGNvbnN0IHNuYXAyID0gb3JjaGVzdHJhdG9yLmdldFN0YXR1cygpO1xuXG4gIGFzc2VydC5lcXVhbChzbmFwMi5hY3RpdmVVbml0Py51bml0SWQsIFwiVDAxXCIpO1xufSk7XG5cbnRlc3QoXCJzdGFydCgpIGNsZWFycyBwcmlvciBpZGVtcG90ZW50IGxvY2tcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMgfSA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcbiAgY29uc3QgYmxvY2tlZCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG4gIGNvbnN0IHJlc3RhcnRlZCA9IGF3YWl0IG9yY2hlc3RyYXRvci5zdGFydCh7IGJhc2VQYXRoOiBcIi90bXAvcHJvamVjdFwiLCB0cmlnZ2VyOiBcIm1hbnVhbFwiIH0pO1xuXG4gIGFzc2VydC5lcXVhbChibG9ja2VkLmtpbmQsIFwiYmxvY2tlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3RhcnRlZC5raW5kLCBcImFkdmFuY2VkXCIpO1xufSk7XG5cbnRlc3QoXCJlcnJvciBwYXRoIGVtaXRzIGVycm9yIG5vdGlmaWNhdGlvblwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VEZXBzKHtcbiAgICBydW50aW1lOiB7XG4gICAgICBhc3luYyBlbnN1cmVMb2NrT3duZXJzaGlwKCkgeyB0aHJvdyBuZXcgRXJyb3IoXCJib29tXCIpOyB9LFxuICAgICAgYXN5bmMgam91cm5hbFRyYW5zaXRpb24oZXZlbnQpIHsgY2FsbHMucHVzaChgam91cm5hbDoke2V2ZW50Lm5hbWV9YCk7IH0sXG4gICAgfSxcbiAgICByZWNvdmVyeToge1xuICAgICAgYXN5bmMgY2xhc3NpZnlBbmRSZWNvdmVyKCkgeyByZXR1cm4geyBhY3Rpb246IFwiZXNjYWxhdGVcIiwgcmVhc29uOiBcIm5lZWRzIG1hbnVhbFwiIH07IH0sXG4gICAgfSxcbiAgfSk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcblxuICBhc3NlcnQub2soY2FsbHMuaW5jbHVkZXMoXCJub3RpZnk6ZXJyb3JcIikpO1xufSk7XG5cbnRlc3QoXCJibG9ja2VkIHBhdGggam91cm5hbHMgYWR2YW5jZS1ibG9ja2VkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBjYWxscyB9ID0gbWFrZURlcHMoKTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuXG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcImpvdXJuYWw6YWR2YW5jZS1ibG9ja2VkXCIpKTtcbn0pO1xuXG50ZXN0KFwiaGVhbHRoIHBvc3QgaG9vayBydW5zIG9uIGJsb2NrZWQgcmVzdWx0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBkZXBzLCBjYWxscyB9ID0gbWFrZURlcHMoKTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuXG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcImhlYWx0aC5wb3N0XCIpKTtcbn0pO1xuXG50ZXN0KFwic3RhcnQoKSBlbWl0cyBzdGFydCBub3RpZmljYXRpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMsIGNhbGxzIH0gPSBtYWtlRGVwcygpO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGF3YWl0IG9yY2hlc3RyYXRvci5zdGFydCh7IGJhc2VQYXRoOiBcIi90bXAvcHJvamVjdFwiLCB0cmlnZ2VyOiBcIm1hbnVhbFwiIH0pO1xuXG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcIm5vdGlmeTpzdGFydFwiKSk7XG59KTtcblxudGVzdChcInJlc3VtZSgpIGVtaXRzIHJlc3VtZSBub3RpZmljYXRpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMsIGNhbGxzIH0gPSBtYWtlRGVwcygpO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGF3YWl0IG9yY2hlc3RyYXRvci5yZXN1bWUoKTtcblxuICBhc3NlcnQub2soY2FsbHMuaW5jbHVkZXMoXCJub3RpZnk6cmVzdW1lXCIpKTtcbn0pO1xuXG50ZXN0KFwic3RvcHBlZCB3aXRoIG5vIHJlbWFpbmluZyB1bml0cyBjbGVhcnMgaWRlbXBvdGVudCBsb2NrIGZvciBuZXh0IGFkdmFuY2VcIiwgYXN5bmMgKCkgPT4ge1xuICBsZXQgY2FsbENvdW50ID0gMDtcbiAgY29uc3QgeyBkZXBzIH0gPSBtYWtlRGVwcyh7XG4gICAgZGlzcGF0Y2g6IHtcbiAgICAgIGFzeW5jIGRlY2lkZU5leHRVbml0KCkge1xuICAgICAgICBjYWxsQ291bnQgKz0gMTtcbiAgICAgICAgaWYgKGNhbGxDb3VudCA9PT0gMikgcmV0dXJuIG51bGw7XG4gICAgICAgIHJldHVybiB7IHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLCB1bml0SWQ6IFwiVDAxXCIsIHJlYXNvbjogXCJyZWFkeVwiLCBwcmVjb25kaXRpb25zOiBbXSB9O1xuICAgICAgfSxcbiAgICB9LFxuICB9KTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBjb25zdCBmaXJzdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG4gIGNvbnN0IHN0b3BwZWQgPSBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBjb25zdCBhZnRlciA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG5cbiAgYXNzZXJ0LmVxdWFsKGZpcnN0LmtpbmQsIFwiYWR2YW5jZWRcIik7XG4gIGFzc2VydC5lcXVhbChzdG9wcGVkLmtpbmQsIFwic3RvcHBlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGFmdGVyLmtpbmQsIFwiYWR2YW5jZWRcIik7XG59KTtcblxudGVzdChcInN0b3AoKSBjbGVhbnMgdXAgd29ya3RyZWUgYW5kIHRyYW5zaXRpb25zIHRvIHN0b3BwZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IGRlcHMsIGNhbGxzIH0gPSBtYWtlRGVwcygpO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5zdG9wKFwidXNlci1yZXF1ZXN0XCIpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQua2luZCwgXCJzdG9wcGVkXCIpO1xuICBhc3NlcnQuZXF1YWwob3JjaGVzdHJhdG9yLmdldFN0YXR1cygpLnBoYXNlLCBcInN0b3BwZWRcIik7XG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcIndvcmt0cmVlLmNsZWFudXBcIikpO1xuICBhc3NlcnQub2soY2FsbHMuaW5jbHVkZXMoXCJqb3VybmFsOnN0b3BcIikpO1xuICBhc3NlcnQub2soY2FsbHMuaW5jbHVkZXMoXCJub3RpZnk6c3RvcFwiKSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBTdHVjay1sb29wIHJpbmcgYnVmZmVyIChpc3N1ZSAjNTc4Nylcbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG50ZXN0KFwiU1RVQ0tfV0lORE9XX1NJWkUgbWF0Y2hlcyB0aGUgbGVnYWN5IGF1dG8vcGhhc2VzLnRzIGNvbnN0YW50XCIsICgpID0+IHtcbiAgYXNzZXJ0LmVxdWFsKFNUVUNLX1dJTkRPV19TSVpFLCA2KTtcbn0pO1xuXG50ZXN0KFwic3R1Y2stbG9vcDogZW1wdHkgcmluZyBvbiBhIGZyZXNobHkgY29uc3RydWN0ZWQgb3JjaGVzdHJhdG9yIGFkdmFuY2VzIG5vcm1hbGx5XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyBkZXBzIH0gPSBtYWtlRGVwcygpO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcImFkdmFuY2VkXCIpO1xufSk7XG5cbnRlc3QoXCJzdHVjay1sb29wOiBwYXJ0aWFsIGZpbGwgb2YgbWl4ZWQgdW5pdHMgZG9lcyBub3QgYmxvY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBBbHRlcm5hdGUgQS9CIGZvciBTVFVDS19XSU5ET1dfU0laRSByb3VuZHMuIE5vIHNpbmdsZSBrZXkgc2F0dXJhdGVzIHRoZVxuICAvLyB3aW5kb3csIHNvIG5laXRoZXIgaWRlbXBvdGVuY3kgbm9yIHN0dWNrLWxvb3Agc2hvdWxkIGZpcmUuXG4gIGxldCBpID0gMDtcbiAgY29uc3Qgc2VxdWVuY2UgPSBbXCJBXCIsIFwiQlwiLCBcIkFcIiwgXCJCXCIsIFwiQVwiLCBcIkJcIl07XG4gIGNvbnN0IHsgZGVwcyB9ID0gbWFrZURlcHMoe1xuICAgIGRpc3BhdGNoOiB7XG4gICAgICBhc3luYyBkZWNpZGVOZXh0VW5pdCgpIHtcbiAgICAgICAgY29uc3QgaWQgPSBzZXF1ZW5jZVtpKysgJSBzZXF1ZW5jZS5sZW5ndGhdO1xuICAgICAgICByZXR1cm4geyB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIiwgdW5pdElkOiBpZCwgcmVhc29uOiBcInJlYWR5XCIsIHByZWNvbmRpdGlvbnM6IFtdIH07XG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGZvciAobGV0IHJvdW5kID0gMDsgcm91bmQgPCBTVFVDS19XSU5ET1dfU0laRTsgcm91bmQrKykge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5raW5kLCBcImFkdmFuY2VkXCIsIGByb3VuZCAke3JvdW5kfSBzaG91bGQgYWR2YW5jZSwgZ290ICR7cmVzdWx0LmtpbmR9YCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwic3R1Y2stbG9vcDogcmluZyBzYXR1cmF0ZWQgd2l0aCBzYW1lIHVuaXQgYmxvY2tzIHdpdGggYWN0aW9uICdzdG9wJyBhbmQgc3R1Y2stbG9vcCByZWFzb25cIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBEaXNwYXRjaCBwaWNrcyB0aGUgc2FtZSB1bml0IGV2ZXJ5IHRpbWUuIFRoZSBmaXJzdCBhZHZhbmNlIHN1Y2NlZWRzLlxuICAvLyBDYWxscyAyLi5TVFVDS19XSU5ET1dfU0laRS0xIGFyZSBpZGVtcG90ZW5jeS1ibG9ja2VkIHdoaWxlIHRoZSByaW5nIGZpbGxzLlxuICAvLyBUaGUgU1RVQ0tfV0lORE9XX1NJWkUndGggY2FsbCBzZWVzIGEgc2F0dXJhdGVkIHJpbmcgYW5kIHJldHVybnMgc3R1Y2stbG9vcC5cbiAgY29uc3QgeyBkZXBzIH0gPSBtYWtlRGVwcygpO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGNvbnN0IHJlc3VsdHM6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2Ygb3JjaGVzdHJhdG9yLmFkdmFuY2U+PltdID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgU1RVQ0tfV0lORE9XX1NJWkU7IGkrKykge1xuICAgIHJlc3VsdHMucHVzaChhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpKTtcbiAgfVxuXG4gIC8vIEZpcnN0IGNhbGwgYWR2YW5jZXMuXG4gIGFzc2VydC5lcXVhbChyZXN1bHRzWzBdLmtpbmQsIFwiYWR2YW5jZWRcIik7XG5cbiAgLy8gSW50ZXJtZWRpYXRlIGNhbGxzIGFyZSBibG9ja2VkIGJ5IGlkZW1wb3RlbmN5IChub3Qgc3R1Y2stbG9vcCB5ZXQpLlxuICBmb3IgKGxldCBpID0gMTsgaSA8IFNUVUNLX1dJTkRPV19TSVpFIC0gMTsgaSsrKSB7XG4gICAgY29uc3QgciA9IHJlc3VsdHNbaV07XG4gICAgYXNzZXJ0LmVxdWFsKHIua2luZCwgXCJibG9ja2VkXCIsIGByb3VuZCAke2l9IHNob3VsZCBiZSBibG9ja2VkYCk7XG4gICAgaWYgKHIua2luZCAhPT0gXCJibG9ja2VkXCIpIHJldHVybjtcbiAgICBhc3NlcnQuZXF1YWwoci5yZWFzb24sIFwiaWRlbXBvdGVudCBhZHZhbmNlOiB1bml0IGFscmVhZHkgYWN0aXZlXCIpO1xuICAgIGFzc2VydC5lcXVhbChyLmFjdGlvbiwgXCJzdG9wXCIpO1xuICB9XG5cbiAgLy8gVGhlIGZpbmFsIGNhbGwgKHJpbmcgbm93IGhvbGRzIFNUVUNLX1dJTkRPV19TSVpFIGNvcGllcykgcmV0dXJucyBzdHVjay1sb29wLlxuICBjb25zdCBsYXN0ID0gcmVzdWx0c1tTVFVDS19XSU5ET1dfU0laRSAtIDFdO1xuICBhc3NlcnQuZXF1YWwobGFzdC5raW5kLCBcImJsb2NrZWRcIik7XG4gIGlmIChsYXN0LmtpbmQgIT09IFwiYmxvY2tlZFwiKSByZXR1cm47XG4gIGFzc2VydC5lcXVhbChsYXN0LmFjdGlvbiwgXCJzdG9wXCIpO1xuICBhc3NlcnQuZXF1YWwobGFzdC5yZWFzb24sIGBzdHVjay1sb29wOiBleGVjdXRlLXRhc2s6VDAxIHBpY2tlZCAke1NUVUNLX1dJTkRPV19TSVpFfSB0aW1lc2ApO1xufSk7XG5cbnRlc3QoXCJzdHVjay1sb29wOiBpZGVtcG90ZW5jeSBibG9jayBjb250aW51ZXMgdG8gZmlyZSB3aXRoIGl0cyBvd24gcmVhc29uIGJlZm9yZSBzYXR1cmF0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgLy8gVHdvIGlkZW50aWNhbCBjYWxscyBzaG91bGQgcHJvZHVjZSBpZGVtcG90ZW50IChub3Qgc3R1Y2stbG9vcCkuIEVuc3VyZXMgdGhlXG4gIC8vIGV4aXN0aW5nIGlkZW1wb3RlbmN5IGJsb2NrIGlzIG5vdCBhYnNvcmJlZCBieSB0aGUgbmV3IGNoZWNrLlxuICBjb25zdCB7IGRlcHMgfSA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgY29uc3QgZmlyc3QgPSBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBjb25zdCBzZWNvbmQgPSBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuXG4gIGFzc2VydC5lcXVhbChmaXJzdC5raW5kLCBcImFkdmFuY2VkXCIpO1xuICBhc3NlcnQuZXF1YWwoc2Vjb25kLmtpbmQsIFwiYmxvY2tlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHNlY29uZC5yZWFzb24sIFwiaWRlbXBvdGVudCBhZHZhbmNlOiB1bml0IGFscmVhZHkgYWN0aXZlXCIpO1xuICBhc3NlcnQuZXF1YWwoc2Vjb25kLmFjdGlvbiwgXCJzdG9wXCIpO1xufSk7XG5cbnRlc3QoXCJzdHVjay1sb29wOiBzdGFydCgpIHJlc2V0cyB0aGUgcmluZyBzbyBhIGZyZXNoIHNhdHVyYXRpb24gY3ljbGUgaXMgcmVxdWlyZWRcIiwgYXN5bmMgKCkgPT4ge1xuICAvLyBGaWxsIHRoZSByaW5nIHRvIG9uZSBzaG9ydCBvZiBzYXR1cmF0aW9uLCB0aGVuIHN0YXJ0KCkgXHUyMDE0IHRoZSByaW5nIHNob3VsZFxuICAvLyBiZSBjbGVhcmVkLCBhbmQgdGhlIG5leHQgYWR2YW5jZSBtdXN0IHN1Y2NlZWQgaW5zdGVhZCBvZiBnb2luZyBzdHVjay5cbiAgY29uc3QgeyBkZXBzIH0gPSBtYWtlRGVwcygpO1xuICBjb25zdCBvcmNoZXN0cmF0b3IgPSBjcmVhdGVBdXRvT3JjaGVzdHJhdG9yKGRlcHMpO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgU1RVQ0tfV0lORE9XX1NJWkUgLSAxOyBpKyspIHtcbiAgICBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICB9XG5cbiAgY29uc3QgcmVzdGFydGVkID0gYXdhaXQgb3JjaGVzdHJhdG9yLnN0YXJ0KHsgYmFzZVBhdGg6IFwiL3RtcC9wcm9qZWN0XCIsIHRyaWdnZXI6IFwibWFudWFsXCIgfSk7XG4gIGFzc2VydC5lcXVhbChyZXN0YXJ0ZWQua2luZCwgXCJhZHZhbmNlZFwiKTtcblxuICAvLyBJbW1lZGlhdGVseSBhZnRlciBzdGFydCgpLCB0aGUgbmV4dCBhZHZhbmNlIGlzIGlkZW1wb3RlbnQgKG9uZSBlbGVtZW50IGluXG4gIC8vIHJpbmcpLCBub3Qgc3R1Y2stbG9vcCwgY29uZmlybWluZyB0aGUgcmluZyB3YXMgcmVzZXQuXG4gIGNvbnN0IG5leHQgPSBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBhc3NlcnQuZXF1YWwobmV4dC5raW5kLCBcImJsb2NrZWRcIik7XG4gIGFzc2VydC5lcXVhbChuZXh0LnJlYXNvbiwgXCJpZGVtcG90ZW50IGFkdmFuY2U6IHVuaXQgYWxyZWFkeSBhY3RpdmVcIik7XG59KTtcblxudGVzdChcInN0dWNrLWxvb3A6IHJlc3VtZSgpIHJlc2V0cyB0aGUgcmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcyB9ID0gbWFrZURlcHMoKTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IFNUVUNLX1dJTkRPV19TSVpFIC0gMTsgaSsrKSB7XG4gICAgYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcbiAgfVxuXG4gIGNvbnN0IHJlc3VtZWQgPSBhd2FpdCBvcmNoZXN0cmF0b3IucmVzdW1lKCk7XG4gIGFzc2VydC5lcXVhbChyZXN1bWVkLmtpbmQsIFwiYWR2YW5jZWRcIik7XG5cbiAgY29uc3QgbmV4dCA9IGF3YWl0IG9yY2hlc3RyYXRvci5hZHZhbmNlKCk7XG4gIGFzc2VydC5lcXVhbChuZXh0LmtpbmQsIFwiYmxvY2tlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKG5leHQucmVhc29uLCBcImlkZW1wb3RlbnQgYWR2YW5jZTogdW5pdCBhbHJlYWR5IGFjdGl2ZVwiKTtcbn0pO1xuXG50ZXN0KFwic3R1Y2stbG9vcDogc3RvcCgpIHJlc2V0cyB0aGUgcmluZ1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcyB9ID0gbWFrZURlcHMoKTtcbiAgY29uc3Qgb3JjaGVzdHJhdG9yID0gY3JlYXRlQXV0b09yY2hlc3RyYXRvcihkZXBzKTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IFNUVUNLX1dJTkRPV19TSVpFIC0gMTsgaSsrKSB7XG4gICAgYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcbiAgfVxuXG4gIGNvbnN0IHN0b3BwZWQgPSBhd2FpdCBvcmNoZXN0cmF0b3Iuc3RvcChcInVzZXItcmVxdWVzdFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHN0b3BwZWQua2luZCwgXCJzdG9wcGVkXCIpO1xuXG4gIC8vIFJpbmcgaXMgY2xlYXJlZCBieSBzdG9wKCkuIEEgc3Vic2VxdWVudCBhZHZhbmNlIGlzIGEgZnJlc2ggZmlyc3QtdG91Y2guXG4gIGNvbnN0IG5leHQgPSBhd2FpdCBvcmNoZXN0cmF0b3IuYWR2YW5jZSgpO1xuICBhc3NlcnQuZXF1YWwobmV4dC5raW5kLCBcImFkdmFuY2VkXCIpO1xufSk7XG5cbnRlc3QoXCJzdHVjay1sb29wOiBqb3VybmFsIHJlY29yZHMgdGhlIHN0dWNrLWxvb3AgcmVhc29uIG9uIGFkdmFuY2UtYmxvY2tlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgZGVwcywgY2FsbHMgfSA9IG1ha2VEZXBzKCk7XG4gIGNvbnN0IG9yY2hlc3RyYXRvciA9IGNyZWF0ZUF1dG9PcmNoZXN0cmF0b3IoZGVwcyk7XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBTVFVDS19XSU5ET1dfU0laRTsgaSsrKSB7XG4gICAgYXdhaXQgb3JjaGVzdHJhdG9yLmFkdmFuY2UoKTtcbiAgfVxuXG4gIGFzc2VydC5vayhjYWxscy5pbmNsdWRlcyhcImpvdXJuYWw6YWR2YW5jZS1ibG9ja2VkXCIpKTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgIzU3ODkgcGFyaXR5OiB3aXJlZCBkaXNwYXRjaCBhZGFwdGVyIG1pcnJvcnMgcnVuRGlzcGF0Y2gncyByZXNvbHZlRGlzcGF0Y2ggY2FsbCBcdTI1MDBcdTI1MDBcdTI1MDBcblxudGVzdChcIndpcmVkIERpc3BhdGNoQWRhcHRlciBmb3J3YXJkcyBzZXNzaW9uLWRlcml2ZWQgZGlzcGF0Y2ggaW5wdXRzIGlkZW50aWNhbGx5IHRvIHJ1bkRpc3BhdGNoXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgc3RhdGVTbmFwc2hvdCA9IG1ha2VTdGF0ZSgpO1xuXG4gIC8vIEluc3RhbGwgYSBjYXB0dXJpbmcgcmVnaXN0cnkgc28gd2Ugb2JzZXJ2ZSB0aGUgRGlzcGF0Y2hDb250ZXh0IGJvdGggY29kZSBwYXRoc1xuICAvLyBidWlsZCwgYW5kIGZvcmNlIGEgZGV0ZXJtaW5pc3RpYyBkaXNwYXRjaCBhY3Rpb24gc28gdGhlIHBhcml0eSBhc3NlcnRpb24gaXNcbiAgLy8gYWJvdXQgKmlucHV0cyosIG5vdCBydWxlIGV2YWx1YXRpb24uXG4gIGNvbnN0IGNhcHR1cmVkOiBEaXNwYXRjaENvbnRleHRbXSA9IFtdO1xuICBjb25zdCBjYXB0dXJlUnVsZTogVW5pZmllZFJ1bGUgPSB7XG4gICAgbmFtZTogXCJ0ZXN0LWNhcHR1cmVcIixcbiAgICB3aGVuOiBcImRpc3BhdGNoXCIsXG4gICAgZXZhbHVhdGlvbjogXCJmaXJzdC1tYXRjaFwiLFxuICAgIHdoZXJlOiBhc3luYyAoY3R4OiBEaXNwYXRjaENvbnRleHQpID0+IHtcbiAgICAgIGNhcHR1cmVkLnB1c2goY3R4KTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiIGFzIGNvbnN0LFxuICAgICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgICAgdW5pdElkOiBcIlQwMVwiLFxuICAgICAgICBwcm9tcHQ6IFwicGFyaXR5LWZpeHR1cmVcIixcbiAgICAgIH07XG4gICAgfSxcbiAgICB0aGVuOiAocjogdW5rbm93bikgPT4gcixcbiAgfTtcbiAgc2V0UmVnaXN0cnkobmV3IFJ1bGVSZWdpc3RyeShbY2FwdHVyZVJ1bGVdKSk7XG5cbiAgdHJ5IHtcbiAgICAvLyBNb2NrIEV4dGVuc2lvbkNvbnRleHQgKyBFeHRlbnNpb25BUEkgd2l0aCB0aGUgc3VyZmFjZSB0aGUgd2lyZWQgYWRhcHRlciB0b3VjaGVzLlxuICAgIGNvbnN0IGZha2VNb2RlbFJlZ2lzdHJ5ID0ge1xuICAgICAgZ2V0QWxsOiAoKSA9PiBbXSxcbiAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6IChfcHJvdmlkZXI6IHN0cmluZykgPT4gXCJhcGlLZXlcIiBhcyBjb25zdCxcbiAgICB9O1xuICAgIGNvbnN0IGN0eCA9IHtcbiAgICAgIG1vZGVsOiB7XG4gICAgICAgIHByb3ZpZGVyOiBcImFudGhyb3BpY1wiLFxuICAgICAgICBiYXNlVXJsOiBcImh0dHBzOi8vYXBpLmFudGhyb3BpYy5jb21cIixcbiAgICAgICAgY29udGV4dFdpbmRvdzogMjAwXzAwMCxcbiAgICAgIH0sXG4gICAgICBtb2RlbFJlZ2lzdHJ5OiBmYWtlTW9kZWxSZWdpc3RyeSxcbiAgICB9IGFzIGFueTtcbiAgICBjb25zdCBwaSA9IHtcbiAgICAgIGdldEFjdGl2ZVRvb2xzOiAoKSA9PiBbXCJyZWFkX2ZpbGVcIiwgXCJ3cml0ZV9maWxlXCJdLFxuICAgIH0gYXMgYW55O1xuICAgIGNvbnN0IGJhc2VQYXRoID0gXCIvdG1wL3Bhcml0eS1maXh0dXJlXCI7XG5cbiAgICAvLyBQYXRoIEEgXHUyMDE0IHdpcmVkIGFkYXB0ZXIgKHdoYXQgY3JlYXRlV2lyZWRBdXRvT3JjaGVzdHJhdGlvbk1vZHVsZSB1c2VzKS5cbiAgICBjb25zdCBhZGFwdGVyID0gY3JlYXRlV2lyZWREaXNwYXRjaEFkYXB0ZXIoY3R4LCBwaSwgYmFzZVBhdGgpO1xuICAgIGNvbnN0IGFkYXB0ZXJSZXN1bHQgPSBhd2FpdCBhZGFwdGVyLmRlY2lkZU5leHRVbml0KHsgc3RhdGVTbmFwc2hvdCB9KTtcblxuICAgIC8vIFBhdGggQiBcdTIwMTQgZGlyZWN0IHJlc29sdmVEaXNwYXRjaCBjYWxsIG1pcnJvcmluZyBwaGFzZXMudHM6cnVuRGlzcGF0Y2guXG4gICAgLy8gSW5saW5lIHRoZSBzYW1lIGRlcml2YXRpb25zIHJ1bkRpc3BhdGNoIHVzZXMgc28gYW55IGRyaWZ0IGhlcmUgaXMgYSBwYXJpdHkgYnJlYWsuXG4gICAgY29uc3QgcHJlZnMgPSB1bmRlZmluZWQ7IC8vIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyByZXR1cm5zIG51bGwgZm9yIC90bXAvcGFyaXR5LWZpeHR1cmUuXG4gICAgY29uc3QgcHJvdmlkZXIgPSBjdHgubW9kZWw/LnByb3ZpZGVyO1xuICAgIGNvbnN0IGF1dGhNb2RlID0gcHJvdmlkZXIgJiYgdHlwZW9mIGN0eC5tb2RlbFJlZ2lzdHJ5Py5nZXRQcm92aWRlckF1dGhNb2RlID09PSBcImZ1bmN0aW9uXCJcbiAgICAgID8gY3R4Lm1vZGVsUmVnaXN0cnkuZ2V0UHJvdmlkZXJBdXRoTW9kZShwcm92aWRlcilcbiAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGFjdGl2ZVRvb2xzID0gdHlwZW9mIHBpLmdldEFjdGl2ZVRvb2xzID09PSBcImZ1bmN0aW9uXCIgPyBwaS5nZXRBY3RpdmVUb29scygpIDogW107XG4gICAgY29uc3Qgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZTogXCJ0cnVlXCIgfCBcImZhbHNlXCIgPVxuICAgICAgcHJlZnMgIT09IHVuZGVmaW5lZCAmJiAocHJlZnMgYXMgeyBwbGFubmluZ19kZXB0aD86IHN0cmluZyB9KS5wbGFubmluZ19kZXB0aCA9PT0gXCJkZWVwXCJcbiAgICAgICAgPyBcImZhbHNlXCJcbiAgICAgICAgOiBzdXBwb3J0c1N0cnVjdHVyZWRRdWVzdGlvbnMoYWN0aXZlVG9vbHMsIHtcbiAgICAgICAgICAgIGF1dGhNb2RlLFxuICAgICAgICAgICAgYmFzZVVybDogY3R4Lm1vZGVsPy5iYXNlVXJsLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgPyBcInRydWVcIlxuICAgICAgICAgIDogXCJmYWxzZVwiO1xuXG4gICAgY29uc3QgYnVpbHREaXJlY3RDdHg6IERpc3BhdGNoQ29udGV4dCA9IHtcbiAgICAgIGJhc2VQYXRoLFxuICAgICAgbWlkOiBzdGF0ZVNuYXBzaG90LmFjdGl2ZU1pbGVzdG9uZSEuaWQsXG4gICAgICBtaWRUaXRsZTogc3RhdGVTbmFwc2hvdC5hY3RpdmVNaWxlc3RvbmUhLnRpdGxlLFxuICAgICAgc3RhdGU6IHN0YXRlU25hcHNob3QsXG4gICAgICBwcmVmcyxcbiAgICAgIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUsXG4gICAgICBzZXNzaW9uQ29udGV4dFdpbmRvdzogY3R4Lm1vZGVsPy5jb250ZXh0V2luZG93LFxuICAgICAgc2Vzc2lvblByb3ZpZGVyOiBjdHgubW9kZWw/LnByb3ZpZGVyLFxuICAgICAgbW9kZWxSZWdpc3RyeTogY3R4Lm1vZGVsUmVnaXN0cnksXG4gICAgfTtcbiAgICBjb25zdCBkaXJlY3RBY3Rpb24gPSBhd2FpdCByZXNvbHZlRGlzcGF0Y2goYnVpbHREaXJlY3RDdHgpO1xuXG4gICAgLy8gVHdvIGNvbnRleHRzIGNhcHR1cmVkOiBvbmUgcGVyIHJlc29sdmVEaXNwYXRjaCBjYWxsLlxuICAgIGFzc2VydC5lcXVhbChjYXB0dXJlZC5sZW5ndGgsIDIsIFwiZXhwZWN0ZWQgdHdvIGNhcHR1cmVkIGRpc3BhdGNoIGNvbnRleHRzXCIpO1xuICAgIGNvbnN0IFthZGFwdGVyQ3R4LCBkaXJlY3RDdHhdID0gY2FwdHVyZWQ7XG5cbiAgICAvLyBQYXJpdHkgYXNzZXJ0aW9uOiBzZXNzaW9uLWRlcml2ZWQgZmllbGRzIGFyZSBpZGVudGljYWwuXG4gICAgYXNzZXJ0LmVxdWFsKGFkYXB0ZXJDdHguc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSwgZGlyZWN0Q3R4LnN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUpO1xuICAgIGFzc2VydC5lcXVhbChhZGFwdGVyQ3R4LnNlc3Npb25Db250ZXh0V2luZG93LCBkaXJlY3RDdHguc2Vzc2lvbkNvbnRleHRXaW5kb3cpO1xuICAgIGFzc2VydC5lcXVhbChhZGFwdGVyQ3R4LnNlc3Npb25Qcm92aWRlciwgZGlyZWN0Q3R4LnNlc3Npb25Qcm92aWRlcik7XG4gICAgYXNzZXJ0LmVxdWFsKGFkYXB0ZXJDdHgubW9kZWxSZWdpc3RyeSwgZGlyZWN0Q3R4Lm1vZGVsUmVnaXN0cnkpO1xuICAgIGFzc2VydC5lcXVhbChhZGFwdGVyQ3R4LmJhc2VQYXRoLCBkaXJlY3RDdHguYmFzZVBhdGgpO1xuICAgIGFzc2VydC5lcXVhbChhZGFwdGVyQ3R4Lm1pZCwgZGlyZWN0Q3R4Lm1pZCk7XG4gICAgYXNzZXJ0LmVxdWFsKGFkYXB0ZXJDdHgubWlkVGl0bGUsIGRpcmVjdEN0eC5taWRUaXRsZSk7XG5cbiAgICAvLyBEaXNwYXRjaCBhY3Rpb24gZXF1YWxpdHk6IGJvdGggZmxvd3MgcmVhY2ggdGhlIHNhbWUgZGlzcGF0Y2ggZGVjaXNpb24uXG4gICAgaWYgKCFhZGFwdGVyUmVzdWx0IHx8ICEoXCJ1bml0VHlwZVwiIGluIGFkYXB0ZXJSZXN1bHQpKSB7XG4gICAgICBhc3NlcnQuZmFpbChcImV4cGVjdGVkIGFkYXB0ZXIgcmVzdWx0IHRvIGJlIGEgZGlzcGF0Y2ggZGVjaXNpb25cIik7XG4gICAgfVxuICAgIGFzc2VydC5lcXVhbChhZGFwdGVyUmVzdWx0LnVuaXRUeXBlLCBcImV4ZWN1dGUtdGFza1wiKTtcbiAgICBhc3NlcnQuZXF1YWwoYWRhcHRlclJlc3VsdC51bml0SWQsIFwiVDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChhZGFwdGVyUmVzdWx0LnJlYXNvbiwgXCJ0ZXN0LWNhcHR1cmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGRpcmVjdEFjdGlvbi5hY3Rpb24sIFwiZGlzcGF0Y2hcIik7XG4gICAgaWYgKGRpcmVjdEFjdGlvbi5hY3Rpb24gPT09IFwiZGlzcGF0Y2hcIikge1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpcmVjdEFjdGlvbi51bml0VHlwZSwgYWRhcHRlclJlc3VsdC51bml0VHlwZSk7XG4gICAgICBhc3NlcnQuZXF1YWwoZGlyZWN0QWN0aW9uLnVuaXRJZCwgYWRhcHRlclJlc3VsdC51bml0SWQpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGRpcmVjdEFjdGlvbi5tYXRjaGVkUnVsZSwgYWRhcHRlclJlc3VsdC5yZWFzb24pO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICByZXNldFJlZ2lzdHJ5KCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwid2lyZWQgRGlzcGF0Y2hBZGFwdGVyIHByZWZlcnMgY2FsbGVyLXN1cHBsaWVkIGRpc3BhdGNoIGlucHV0cyBvdmVyIGN0eC1kZXJpdmVkIHZhbHVlc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHN0YXRlU25hcHNob3QgPSBtYWtlU3RhdGUoKTtcbiAgY29uc3QgY2FwdHVyZWQ6IERpc3BhdGNoQ29udGV4dFtdID0gW107XG4gIGNvbnN0IGNhcHR1cmVSdWxlOiBVbmlmaWVkUnVsZSA9IHtcbiAgICBuYW1lOiBcInRlc3QtY2FwdHVyZS1vdmVycmlkZXNcIixcbiAgICB3aGVuOiBcImRpc3BhdGNoXCIsXG4gICAgZXZhbHVhdGlvbjogXCJmaXJzdC1tYXRjaFwiLFxuICAgIHdoZXJlOiBhc3luYyAoY3R4OiBEaXNwYXRjaENvbnRleHQpID0+IHtcbiAgICAgIGNhcHR1cmVkLnB1c2goY3R4KTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiIGFzIGNvbnN0LFxuICAgICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgICAgdW5pdElkOiBcIlQwMVwiLFxuICAgICAgICBwcm9tcHQ6IFwib3ZlcnJpZGUtZml4dHVyZVwiLFxuICAgICAgfTtcbiAgICB9LFxuICAgIHRoZW46IChyOiB1bmtub3duKSA9PiByLFxuICB9O1xuICBzZXRSZWdpc3RyeShuZXcgUnVsZVJlZ2lzdHJ5KFtjYXB0dXJlUnVsZV0pKTtcblxuICB0cnkge1xuICAgIGNvbnN0IGN0eE1vZGVsUmVnaXN0cnkgPSB7XG4gICAgICBnZXRBbGw6ICgpID0+IFtdLFxuICAgICAgZ2V0UHJvdmlkZXJBdXRoTW9kZTogKF9wcm92aWRlcjogc3RyaW5nKSA9PiBcImFwaUtleVwiIGFzIGNvbnN0LFxuICAgIH07XG4gICAgY29uc3Qgb3ZlcnJpZGVNb2RlbFJlZ2lzdHJ5ID0ge1xuICAgICAgZ2V0QWxsOiAoKSA9PiBbXSxcbiAgICAgIGdldFByb3ZpZGVyQXV0aE1vZGU6IChfcHJvdmlkZXI6IHN0cmluZykgPT4gXCJvYXV0aFwiIGFzIGNvbnN0LFxuICAgIH07XG4gICAgY29uc3QgY3R4ID0ge1xuICAgICAgbW9kZWw6IHtcbiAgICAgICAgcHJvdmlkZXI6IFwiYW50aHJvcGljXCIsXG4gICAgICAgIGJhc2VVcmw6IFwiaHR0cHM6Ly9hcGkuYW50aHJvcGljLmNvbVwiLFxuICAgICAgICBjb250ZXh0V2luZG93OiAyMDBfMDAwLFxuICAgICAgfSxcbiAgICAgIG1vZGVsUmVnaXN0cnk6IGN0eE1vZGVsUmVnaXN0cnksXG4gICAgfSBhcyBhbnk7XG4gICAgY29uc3QgcGkgPSB7XG4gICAgICBnZXRBY3RpdmVUb29sczogKCkgPT4gW10sXG4gICAgfSBhcyBhbnk7XG4gICAgY29uc3QgYWRhcHRlciA9IGNyZWF0ZVdpcmVkRGlzcGF0Y2hBZGFwdGVyKGN0eCwgcGksIFwiL3RtcC9wYXJpdHktZml4dHVyZVwiKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGFkYXB0ZXIuZGVjaWRlTmV4dFVuaXQoe1xuICAgICAgc3RhdGVTbmFwc2hvdCxcbiAgICAgIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGU6IFwidHJ1ZVwiLFxuICAgICAgc2Vzc2lvbkNvbnRleHRXaW5kb3c6IDUwMF8wMDAsXG4gICAgICBzZXNzaW9uUHJvdmlkZXI6IFwib3BlbmFpXCIsXG4gICAgICBtb2RlbFJlZ2lzdHJ5OiBvdmVycmlkZU1vZGVsUmVnaXN0cnksXG4gICAgfSk7XG5cbiAgICBhc3NlcnQub2socmVzdWx0KTtcbiAgICBhc3NlcnQuZXF1YWwoY2FwdHVyZWQubGVuZ3RoLCAxLCBcImV4cGVjdGVkIG9uZSBjYXB0dXJlZCBkaXNwYXRjaCBjb250ZXh0XCIpO1xuICAgIGFzc2VydC5lcXVhbChjYXB0dXJlZFswXS5zdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlLCBcInRydWVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGNhcHR1cmVkWzBdLnNlc3Npb25Db250ZXh0V2luZG93LCA1MDBfMDAwKTtcbiAgICBhc3NlcnQuZXF1YWwoY2FwdHVyZWRbMF0uc2Vzc2lvblByb3ZpZGVyLCBcIm9wZW5haVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoY2FwdHVyZWRbMF0ubW9kZWxSZWdpc3RyeSwgb3ZlcnJpZGVNb2RlbFJlZ2lzdHJ5KTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZXNldFJlZ2lzdHJ5KCk7XG4gIH1cbn0pO1xuXG50ZXN0KFwid2lyZWQgRGlzcGF0Y2hBZGFwdGVyIHByZXNlcnZlcyBzdG9wIHJlYXNvbiBhcyBhIGJsb2NrZWQgZGVjaXNpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBzdGF0ZVNuYXBzaG90ID0gbWFrZVN0YXRlKCk7XG4gIGNvbnN0IHN0b3BSdWxlOiBVbmlmaWVkUnVsZSA9IHtcbiAgICBuYW1lOiBcInRlc3Qtc3RvcFwiLFxuICAgIHdoZW46IFwiZGlzcGF0Y2hcIixcbiAgICBldmFsdWF0aW9uOiBcImZpcnN0LW1hdGNoXCIsXG4gICAgd2hlcmU6IGFzeW5jICgpID0+ICh7XG4gICAgICBhY3Rpb246IFwic3RvcFwiIGFzIGNvbnN0LFxuICAgICAgcmVhc29uOiBcInJlbWVkaWF0aW9uIGJsb2NrZXJcIixcbiAgICAgIGxldmVsOiBcIndhcm5pbmdcIiBhcyBjb25zdCxcbiAgICB9KSxcbiAgICB0aGVuOiAocjogdW5rbm93bikgPT4gcixcbiAgfTtcbiAgc2V0UmVnaXN0cnkobmV3IFJ1bGVSZWdpc3RyeShbc3RvcFJ1bGVdKSk7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdHggPSB7IG1vZGVsOiB7fSwgbW9kZWxSZWdpc3RyeTogeyBnZXRBbGw6ICgpID0+IFtdIH0gfSBhcyBhbnk7XG4gICAgY29uc3QgcGkgPSB7IGdldEFjdGl2ZVRvb2xzOiAoKSA9PiBbXSB9IGFzIGFueTtcbiAgICBjb25zdCBhZGFwdGVyID0gY3JlYXRlV2lyZWREaXNwYXRjaEFkYXB0ZXIoY3R4LCBwaSwgXCIvdG1wL3Bhcml0eS1maXh0dXJlXCIpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgYWRhcHRlci5kZWNpZGVOZXh0VW5pdCh7IHN0YXRlU25hcHNob3QgfSk7XG5cbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdCwge1xuICAgICAga2luZDogXCJibG9ja2VkXCIsXG4gICAgICByZWFzb246IFwicmVtZWRpYXRpb24gYmxvY2tlclwiLFxuICAgICAgYWN0aW9uOiBcInBhdXNlXCIsXG4gICAgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVzZXRSZWdpc3RyeSgpO1xuICB9XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUdBLE9BQU8sVUFBVTtBQUNqQixPQUFPLFlBQVk7QUFFbkIsU0FBUyx3QkFBd0IseUJBQXlCO0FBRzFELFNBQVMsa0NBQWtDO0FBQzNDLFNBQVMsdUJBQTZDO0FBQ3RELFNBQVMsY0FBYyxhQUFhLHFCQUFxQjtBQUV6RCxTQUFTLG1DQUFtQztBQUU1QyxTQUFTLFlBQXNCO0FBQzdCLFNBQU87QUFBQSxJQUNMLGlCQUFpQixFQUFFLElBQUksUUFBUSxPQUFPLFlBQVk7QUFBQSxJQUNsRCxhQUFhO0FBQUEsSUFDYixZQUFZO0FBQUEsSUFDWixPQUFPO0FBQUEsSUFDUCxpQkFBaUIsQ0FBQztBQUFBLElBQ2xCLFVBQVUsQ0FBQztBQUFBLElBQ1gsWUFBWTtBQUFBLElBQ1osVUFBVSxDQUFDO0FBQUEsSUFDWCxjQUFjLEVBQUUsUUFBUSxHQUFHLFdBQVcsR0FBRyxVQUFVLEdBQUcsWUFBWSxHQUFHLFNBQVMsR0FBRyxPQUFPLEVBQUU7QUFBQSxJQUMxRixVQUFVLEVBQUUsWUFBWSxFQUFFLE1BQU0sR0FBRyxPQUFPLEVBQUUsRUFBRTtBQUFBLEVBQ2hEO0FBQ0Y7QUFFQSxTQUFTLFNBQVMsWUFBMkMsQ0FBQyxHQUFvRDtBQUNoSCxRQUFNLFFBQWtCLENBQUM7QUFDekIsUUFBTSxnQkFBZ0IsVUFBVTtBQUVoQyxRQUFNLE9BQTZCO0FBQUEsSUFDakMscUJBQXFCO0FBQUEsTUFDbkIsTUFBTSwwQkFBMEI7QUFDOUIsY0FBTSxLQUFLLGlCQUFpQjtBQUM1QixlQUFPLEVBQUUsSUFBSSxNQUFNLGNBQWM7QUFBQSxNQUNuQztBQUFBLElBQ0Y7QUFBQSxJQUNBLFVBQVU7QUFBQSxNQUNSLE1BQU0sZUFBZSxPQUFPO0FBQzFCLGNBQU0sS0FBSyxpQkFBaUI7QUFDNUIsZUFBTyxNQUFNLE1BQU0sZUFBZSxhQUFhO0FBQy9DLGVBQU8sRUFBRSxVQUFVLGdCQUFn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
