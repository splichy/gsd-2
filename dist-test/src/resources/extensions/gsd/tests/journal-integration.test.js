import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeStateProjection } from "../worktree-state-projection.js";
import { runDispatch, runUnitPhase, runPreDispatch, runFinalize } from "../auto/phases.js";
import { readUnitRuntimeRecord } from "../unit-runtime.js";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase
} from "../gsd-db.js";
function createEventCapture() {
  const events = [];
  return {
    events,
    emitJournalEvent: (entry) => {
      events.push(entry);
    }
  };
}
function makeMockDeps(capture, overrides) {
  const baseDeps = {
    lockBase: () => "/tmp/test-lock",
    buildSnapshotOpts: () => ({}),
    stopAuto: async () => {
    },
    pauseAuto: async () => {
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
    deriveState: async () => ({
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: { id: "T01" },
      registry: [{ id: "M001", status: "active" }],
      blockers: []
    }),
    loadEffectiveGSDPreferences: () => ({ preferences: {} }),
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
    getLedger: () => ({ units: [] }),
    getProjectTotals: () => ({ cost: 0 }),
    formatCost: (c) => `$${c.toFixed(2)}`,
    getBudgetAlertLevel: () => 0,
    getNewBudgetAlertLevel: () => 0,
    getBudgetEnforcementAction: () => "none",
    getManifestStatus: async () => null,
    collectSecretsFromManifest: async () => null,
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
      matchedRule: "test-rule-alpha"
    }),
    runPreDispatchHooks: () => ({ firedHooks: [], action: "proceed" }),
    getPriorSliceCompletionBlocker: () => null,
    getMainBranch: () => "main",
    closeoutUnit: async () => {
    },
    autoCommitUnit: async () => null,
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
    worktreeProjection: new WorktreeStateProjection(),
    lifecycle: {
      enterMilestone: () => ({ ok: true, mode: "worktree", path: "/tmp/project" }),
      exitMilestone: (_mid, opts) => ({
        ok: true,
        merged: opts.merge,
        codeFilesChanged: false
      })
    },
    postUnitPreVerification: async () => "continue",
    runPostUnitVerification: async () => "continue",
    postUnitPostVerification: async () => "continue",
    getSessionFile: () => "/tmp/session.json",
    rebuildState: async () => {
    },
    resolveModelId: (id, models) => models.find((m) => m.id === id),
    emitJournalEvent: capture.emitJournalEvent
  };
  return { ...baseDeps, ...overrides };
}
function makeIC(deps, overrides) {
  const flowId = randomUUID();
  let seqCounter = 0;
  return {
    ctx: {
      ui: { notify: () => {
      }, setStatus: () => {
      } },
      model: { id: "test-model" },
      modelRegistry: { getAvailable: () => [] }
    },
    pi: {
      sendMessage: () => {
      },
      setModel: async () => true
    },
    s: makeSession(),
    deps,
    prefs: void 0,
    iteration: 1,
    flowId,
    nextSeq: () => ++seqCounter,
    ...overrides
  };
}
function makeSession() {
  return {
    active: true,
    verbose: false,
    stepMode: false,
    paused: false,
    basePath: "/tmp/project",
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
    pendingQuickTasks: [],
    sidecarQueue: [],
    autoModeStartModel: null,
    unitDispatchCount: /* @__PURE__ */ new Map(),
    unitLifetimeDispatches: /* @__PURE__ */ new Map(),
    unitRecoveryCount: /* @__PURE__ */ new Map(),
    verificationRetryCount: /* @__PURE__ */ new Map(),
    gitService: null,
    autoStartTime: Date.now(),
    cmdCtx: {
      newSession: () => Promise.resolve({ cancelled: false }),
      getContextUsage: () => ({ percent: 10, tokens: 1e3, limit: 1e4 })
    },
    clearTimers: () => {
    }
  };
}
test("runDispatch emits dispatch-match with correct rule and flowId", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
      matchedRule: "slice-task-rule"
    })
  });
  const ic = makeIC(deps);
  const preData = {
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      activeTask: { id: "T01" },
      registry: [{ id: "M001", status: "active" }],
      blockers: []
    },
    mid: "M001",
    midTitle: "Test Milestone"
  };
  const loopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const result = await runDispatch(ic, preData, loopState);
  assert.equal(result.action, "next", "runDispatch should return next for dispatch action");
  const matchEvents = capture.events.filter((e) => e.eventType === "dispatch-match");
  assert.equal(matchEvents.length, 1, "should emit exactly one dispatch-match event");
  const ev = matchEvents[0];
  assert.equal(ev.flowId, ic.flowId, "dispatch-match event should share the iteration flowId");
  assert.equal(ev.rule, "slice-task-rule", "dispatch-match should carry the matched rule name");
  assert.equal(ev.data.unitType, "execute-task");
  assert.equal(ev.data.unitId, "M001/S01/T01");
});
test("runDispatch emits dispatch-stop when dispatch returns stop action", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "stop",
      reason: "no eligible units",
      level: "info",
      matchedRule: "<no-match>"
    })
  });
  const ic = makeIC(deps);
  const preData = {
    state: { phase: "executing", activeMilestone: { id: "M001" }, registry: [{ id: "M001", status: "active" }], blockers: [] },
    mid: "M001",
    midTitle: "Test"
  };
  const loopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const result = await runDispatch(ic, preData, loopState);
  assert.equal(result.action, "break");
  const stopEvents = capture.events.filter((e) => e.eventType === "dispatch-stop");
  assert.equal(stopEvents.length, 1);
  assert.equal(stopEvents[0].rule, "<no-match>");
  assert.equal(stopEvents[0].data.reason, "no eligible units");
  assert.equal(stopEvents[0].flowId, ic.flowId);
});
test("runDispatch checks prior-slice completion against the project root in worktree mode", async () => {
  const capture = createEventCapture();
  const guardCalls = [];
  const deps = makeMockDeps(capture, {
    getMainBranch: (basePath) => {
      guardCalls.push({ fn: "getMainBranch", args: [basePath] });
      return "main";
    },
    getPriorSliceCompletionBlocker: (basePath, mainBranch, unitType, unitId) => {
      guardCalls.push({
        fn: "getPriorSliceCompletionBlocker",
        args: [basePath, mainBranch, unitType, unitId]
      });
      return null;
    }
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: "/tmp/project/.gsd/worktrees/M029-xoklo9",
      originalBasePath: "/tmp/project"
    }
  });
  const preData = {
    state: {
      phase: "executing",
      activeMilestone: { id: "M029-xoklo9", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice 1" },
      registry: [{ id: "M029-xoklo9", status: "active" }],
      blockers: []
    },
    mid: "M029-xoklo9",
    midTitle: "Test Milestone"
  };
  const result = await runDispatch(ic, preData, {
    recentUnits: [],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0
  });
  assert.equal(result.action, "next");
  assert.deepEqual(guardCalls, [
    { fn: "getMainBranch", args: ["/tmp/project"] },
    {
      fn: "getPriorSliceCompletionBlocker",
      args: ["/tmp/project", "main", "execute-task", "M001/S01/T01"]
    }
  ]);
});
test("runDispatch pauses when complete-milestone summary exists on disk but the unit is still stuck (#4289)", async (t) => {
  const capture = createEventCapture();
  let pauseCalls = 0;
  let stopCalls = 0;
  const base = join(tmpdir(), `gsd-stuck-complete-${randomUUID()}`);
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-SUMMARY.md"), "# Summary\nDone.\n");
  writeFileSync(join(base, "src", "app.ts"), "export const ok = true;\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Codex"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: seed"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "fix/test"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["add", ".gsd/milestones/M001/M001-SUMMARY.md", "src/app.ts"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feat: summary exists but db is stale"], { cwd: base, stdio: "ignore" });
  const deps = makeMockDeps(capture, {
    pauseAuto: async () => {
      pauseCalls++;
    },
    stopAuto: async () => {
      stopCalls++;
    },
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "complete-milestone",
      unitId: "M001",
      prompt: "complete the milestone",
      matchedRule: "completing-milestone-rule"
    })
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      currentMilestoneId: "M001"
    }
  });
  const preData = {
    state: {
      phase: "completing-milestone",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      registry: [{ id: "M001", status: "active" }],
      blockers: []
    },
    mid: "M001",
    midTitle: "Test Milestone"
  };
  const result = await runDispatch(ic, preData, {
    recentUnits: [
      { key: "complete-milestone/M001" },
      { key: "complete-milestone/M001" }
    ],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0
  });
  assert.equal(result.action, "break");
  assert.equal(result.reason, "complete-milestone-artifact-db-mismatch");
  assert.equal(pauseCalls, 1, "complete-milestone disk/db mismatch should pause auto-mode");
  assert.equal(stopCalls, 0, "mismatch pause should not hard-stop the loop");
});
test("runDispatch pauses when execute-task artifacts exist but DB status is still open", async (t) => {
  const capture = createEventCapture();
  let pauseCalls = 0;
  let stopCalls = 0;
  let invalidateCalls = 0;
  const base = join(tmpdir(), `gsd-stuck-execute-task-${randomUUID()}`);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "First task", status: "pending" });
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    [
      "# S01",
      "",
      "## Tasks",
      "",
      "- [x] **T01: First task** `est:1h`",
      ""
    ].join("\n")
  );
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n");
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\n\nDone on disk.\n");
  const deps = makeMockDeps(capture, {
    pauseAuto: async () => {
      pauseCalls++;
    },
    stopAuto: async () => {
      stopCalls++;
    },
    invalidateAllCaches: () => {
      invalidateCalls++;
    },
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "execute the task",
      matchedRule: "executing \u2192 execute-task"
    })
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base
    }
  });
  const preData = {
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice" },
      activeTask: { id: "T01", title: "First task" },
      registry: [{ id: "M001", status: "active" }],
      blockers: []
    },
    mid: "M001",
    midTitle: "Test Milestone"
  };
  const loopState = {
    recentUnits: [
      { key: "execute-task/M001/S01/T01" },
      { key: "execute-task/M001/S01/T01" }
    ],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0
  };
  const result = await runDispatch(ic, preData, loopState);
  assert.equal(result.action, "break");
  assert.equal(result.reason, "execute-task-artifact-db-mismatch");
  assert.equal(pauseCalls, 1, "execute-task disk/db mismatch should pause auto-mode");
  assert.equal(stopCalls, 0, "execute-task disk/db mismatch should not hard-stop the loop");
  assert.equal(invalidateCalls, 0, "mismatch should not clear caches and continue toward redispatch");
  assert.equal(loopState.recentUnits.length, 3, "mismatch should keep the stuck window intact");
  assert.equal(loopState.stuckRecoveryAttempts, 1, "mismatch should not reset the recovery counter");
});
test("runDispatch pauses at Level 2 when execute-task artifacts exist but DB status is still open", async (t) => {
  const capture = createEventCapture();
  let pauseCalls = 0;
  let stopCalls = 0;
  let invalidateCalls = 0;
  const base = join(tmpdir(), `gsd-stuck-execute-task-l2-${randomUUID()}`);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "First task", status: "pending" });
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    "# S01\n\n## Tasks\n\n- [x] **T01: First task** `est:1h`\n"
  );
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n");
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\n\nDone on disk.\n");
  const deps = makeMockDeps(capture, {
    pauseAuto: async () => {
      pauseCalls++;
    },
    stopAuto: async () => {
      stopCalls++;
    },
    invalidateAllCaches: () => {
      invalidateCalls++;
    },
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "execute the task",
      matchedRule: "executing execute-task"
    })
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base
    }
  });
  const preData = {
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice" },
      activeTask: { id: "T01", title: "First task" },
      registry: [{ id: "M001", status: "active" }],
      blockers: []
    },
    mid: "M001",
    midTitle: "Test Milestone"
  };
  const loopState = {
    recentUnits: [
      { key: "execute-task/M001/S01/T01" },
      { key: "execute-task/M001/S01/T01" }
    ],
    stuckRecoveryAttempts: 1,
    consecutiveFinalizeTimeouts: 0
  };
  const result = await runDispatch(ic, preData, loopState);
  assert.equal(result.action, "break");
  assert.equal(result.reason, "execute-task-artifact-db-mismatch");
  assert.equal(pauseCalls, 1, "Level 2 execute-task disk/db mismatch should pause auto-mode");
  assert.equal(stopCalls, 0, "Level 2 execute-task disk/db mismatch should not hard-stop the loop");
  assert.equal(invalidateCalls, 1, "Level 2 should invalidate caches before the final artifact recheck");
  assert.equal(loopState.recentUnits.length, 3, "Level 2 mismatch should keep the stuck window intact");
  assert.equal(loopState.stuckRecoveryAttempts, 1, "Level 2 mismatch should not reset the recovery counter");
});
test("runDispatch clears execute-task stuck state when artifacts and DB status are complete", async (t) => {
  const capture = createEventCapture();
  let pauseCalls = 0;
  let stopCalls = 0;
  let invalidateCalls = 0;
  const base = join(tmpdir(), `gsd-stuck-execute-task-complete-${randomUUID()}`);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "in_progress" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "First task", status: "complete" });
  writeFileSync(
    join(sliceDir, "S01-PLAN.md"),
    "# S01\n\n## Tasks\n\n- [x] **T01: First task** `est:1h`\n"
  );
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n");
  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), "# T01 Summary\n\nDone on disk.\n");
  const deps = makeMockDeps(capture, {
    pauseAuto: async () => {
      pauseCalls++;
    },
    stopAuto: async () => {
      stopCalls++;
    },
    invalidateAllCaches: () => {
      invalidateCalls++;
    },
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "execute the task",
      matchedRule: "executing execute-task"
    })
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base
    }
  });
  const preData = {
    state: {
      phase: "executing",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice" },
      activeTask: { id: "T01", title: "First task" },
      registry: [{ id: "M001", status: "active" }],
      blockers: []
    },
    mid: "M001",
    midTitle: "Test Milestone"
  };
  const loopState = {
    recentUnits: [
      { key: "execute-task/M001/S01/T01" },
      { key: "execute-task/M001/S01/T01" }
    ],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0
  };
  const result = await runDispatch(ic, preData, loopState);
  assert.equal(result.action, "continue");
  assert.equal(pauseCalls, 0, "closed DB task should not pause auto-mode");
  assert.equal(stopCalls, 0, "closed DB task should not hard-stop the loop");
  assert.equal(invalidateCalls, 1, "closed DB task recovery should invalidate caches once");
  assert.deepEqual(loopState.recentUnits, [], "closed DB task recovery should clear the stuck window");
  assert.equal(loopState.stuckRecoveryAttempts, 0, "closed DB task recovery should reset the recovery counter");
});
test("runDispatch clears stuck state after Level 1 artifact recovery", async (t) => {
  const capture = createEventCapture();
  let invalidateCalls = 0;
  let stopCalls = 0;
  const base = join(tmpdir(), `gsd-stuck-plan-${randomUUID()}`);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "First task", status: "pending" });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01\n\n## Tasks\n\n- [ ] **T01: First task** `est:1h`\n");
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n");
  const deps = makeMockDeps(capture, {
    invalidateAllCaches: () => {
      invalidateCalls++;
    },
    stopAuto: async () => {
      stopCalls++;
    },
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "plan-slice",
      unitId: "M001/S01",
      prompt: "plan the slice",
      matchedRule: "planning \u2192 plan-slice"
    })
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base
    }
  });
  const preData = {
    state: {
      phase: "planning",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice" },
      registry: [{ id: "M001", status: "active" }],
      blockers: []
    },
    mid: "M001",
    midTitle: "Test Milestone"
  };
  const loopState = {
    recentUnits: [
      { key: "plan-slice/M001/S01" },
      { key: "plan-slice/M001/S01" }
    ],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0
  };
  const result = await runDispatch(ic, preData, loopState);
  assert.equal(result.action, "continue");
  assert.equal(invalidateCalls, 1, "Level 1 artifact recovery should invalidate caches");
  assert.equal(stopCalls, 0, "Level 1 artifact recovery should not hard-stop");
  assert.deepEqual(loopState.recentUnits, [], "Level 1 artifact recovery should clear the stuck window");
  assert.equal(loopState.stuckRecoveryAttempts, 0, "Level 1 artifact recovery should reset the recovery counter");
});
test("runDispatch escapes Level 2 stuck stop when artifact verifies after cache invalidation", async (t) => {
  const capture = createEventCapture();
  let invalidateCalls = 0;
  let stopCalls = 0;
  const base = join(tmpdir(), `gsd-stuck-plan-l2-${randomUUID()}`);
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "First task", status: "pending" });
  writeFileSync(join(sliceDir, "S01-PLAN.md"), "# S01\n\n## Tasks\n\n- [ ] **T01: First task** `est:1h`\n");
  writeFileSync(join(tasksDir, "T01-PLAN.md"), "# T01 Plan\n");
  const deps = makeMockDeps(capture, {
    invalidateAllCaches: () => {
      invalidateCalls++;
    },
    stopAuto: async () => {
      stopCalls++;
    },
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "plan-slice",
      unitId: "M001/S01",
      prompt: "plan the slice",
      matchedRule: "planning \u2192 plan-slice"
    })
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath: base,
      originalBasePath: base
    }
  });
  const preData = {
    state: {
      phase: "planning",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: { id: "S01", title: "Slice" },
      registry: [{ id: "M001", status: "active" }],
      blockers: []
    },
    mid: "M001",
    midTitle: "Test Milestone"
  };
  const loopState = {
    recentUnits: [
      { key: "plan-slice/M001/S01" },
      { key: "plan-slice/M001/S01" }
    ],
    stuckRecoveryAttempts: 1,
    consecutiveFinalizeTimeouts: 0
  };
  const result = await runDispatch(ic, preData, loopState);
  assert.equal(result.action, "continue");
  assert.equal(invalidateCalls, 1, "Level 2 escape should invalidate caches before rechecking artifacts");
  assert.equal(stopCalls, 0, "verified artifacts should escape Level 2 hard stop");
  assert.deepEqual(loopState.recentUnits, [], "Level 2 artifact escape should clear the stuck window");
  assert.equal(loopState.stuckRecoveryAttempts, 0, "Level 2 artifact escape should reset the recovery counter");
});
test("runUnitPhase emits unit-start and unit-end with causedBy reference", async () => {
  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();
  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] },
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: void 0
  };
  const loopState = { recentUnits: [{ key: "execute-task/M001/S01/T01" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  const result = await unitPromise;
  assert.equal(result.action, "next");
  const startEvents = capture.events.filter((e) => e.eventType === "unit-start");
  assert.equal(startEvents.length, 1, "should emit exactly one unit-start");
  assert.equal(startEvents[0].flowId, ic.flowId);
  assert.equal(startEvents[0].data.unitType, "execute-task");
  assert.equal(startEvents[0].data.unitId, "M001/S01/T01");
  const endEvents = capture.events.filter((e) => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "should emit exactly one unit-end");
  assert.equal(endEvents[0].flowId, ic.flowId);
  assert.equal(endEvents[0].data.unitType, "execute-task");
  assert.equal(endEvents[0].data.unitId, "M001/S01/T01");
  assert.equal(endEvents[0].data.status, "completed");
  assert.ok(endEvents[0].causedBy, "unit-end must have a causedBy reference");
  assert.equal(endEvents[0].causedBy.flowId, ic.flowId);
  assert.equal(endEvents[0].causedBy.seq, startEvents[0].seq, "unit-end causedBy.seq must match unit-start.seq");
});
test("runUnitPhase increments unitDispatchCount for repeated artifact-missing retries", async () => {
  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();
  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] },
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: void 0
  };
  const loopState = { recentUnits: [{ key: "execute-task/M001/S01/T01" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const firstRun = runUnitPhase(ic, iterData, loopState);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await firstRun;
  assert.equal(ic.s.unitDispatchCount.get("execute-task/M001/S01/T01"), 1);
  _resetPendingResolve();
  const secondRun = runUnitPhase(ic, iterData, loopState);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await secondRun;
  assert.equal(ic.s.unitDispatchCount.get("execute-task/M001/S01/T01"), 2);
});
test("all events from a mock iteration have monotonically increasing seq and same flowId", async () => {
  const capture = createEventCapture();
  const { resolveAgentEnd, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();
  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "do the thing",
      matchedRule: "my-rule"
    })
  });
  const ic = makeIC(deps);
  const preData = {
    state: { phase: "executing", activeMilestone: { id: "M001", title: "T", status: "active" }, activeSlice: { id: "S01" }, activeTask: { id: "T01" }, registry: [{ id: "M001", status: "active" }], blockers: [] },
    mid: "M001",
    midTitle: "Test"
  };
  const loopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const dispatchResult = await runDispatch(ic, preData, loopState);
  assert.equal(dispatchResult.action, "next");
  const iterData = dispatchResult.data;
  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEnd({ messages: [{ role: "assistant" }] });
  await unitPromise;
  assert.ok(capture.events.length >= 3, `expected at least 3 events (dispatch-match, unit-start, unit-end), got ${capture.events.length}`);
  const flowId = ic.flowId;
  for (const ev of capture.events) {
    assert.equal(ev.flowId, flowId, `all events must share flowId=${flowId}, found event ${ev.eventType} with flowId=${ev.flowId}`);
  }
  for (let i = 1; i < capture.events.length; i++) {
    assert.ok(
      capture.events[i].seq > capture.events[i - 1].seq,
      `seq must be monotonically increasing: event[${i - 1}].seq=${capture.events[i - 1].seq} (${capture.events[i - 1].eventType}) should be less than event[${i}].seq=${capture.events[i].seq} (${capture.events[i].eventType})`
    );
  }
});
test("dispatch-match events include matchedRule field matching the rule name", async () => {
  const capture = createEventCapture();
  const RULE_NAME = "priority-execution-rule";
  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "test",
      matchedRule: RULE_NAME
    })
  });
  const ic = makeIC(deps);
  const preData = {
    state: { phase: "executing", activeMilestone: { id: "M001", title: "T", status: "active" }, activeSlice: { id: "S01" }, activeTask: { id: "T01" }, registry: [{ id: "M001", status: "active" }], blockers: [] },
    mid: "M001",
    midTitle: "Test"
  };
  await runDispatch(ic, preData, { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 });
  const matchEvents = capture.events.filter((e) => e.eventType === "dispatch-match");
  assert.equal(matchEvents.length, 1);
  assert.equal(matchEvents[0].rule, RULE_NAME, "dispatch-match event.rule must equal the matchedRule from dispatch result");
});
test("pre-dispatch-hook event is emitted when hooks fire", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    resolveDispatch: async () => ({
      action: "dispatch",
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      prompt: "test",
      matchedRule: "some-rule"
    }),
    runPreDispatchHooks: () => ({
      firedHooks: ["observability-check", "lint-gate"],
      action: "proceed"
    })
  });
  const ic = makeIC(deps);
  const preData = {
    state: { phase: "executing", activeMilestone: { id: "M001", title: "T", status: "active" }, activeSlice: { id: "S01" }, activeTask: { id: "T01" }, registry: [{ id: "M001", status: "active" }], blockers: [] },
    mid: "M001",
    midTitle: "Test"
  };
  await runDispatch(ic, preData, { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 });
  const hookEvents = capture.events.filter((e) => e.eventType === "pre-dispatch-hook");
  assert.equal(hookEvents.length, 1, "should emit one pre-dispatch-hook event");
  assert.deepEqual(hookEvents[0].data.firedHooks, ["observability-check", "lint-gate"]);
  assert.equal(hookEvents[0].data.action, "proceed");
  assert.equal(hookEvents[0].flowId, ic.flowId);
});
test("terminal event is emitted on milestone-complete", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    deriveState: async () => ({
      phase: "complete",
      activeMilestone: { id: "M001", title: "Test", status: "complete" },
      activeSlice: null,
      activeTask: null,
      registry: [{ id: "M001", status: "complete" }],
      blockers: []
    })
  });
  const ic = makeIC(deps);
  const loopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const result = await runPreDispatch(ic, loopState);
  assert.equal(result.action, "break");
  const terminalEvents = capture.events.filter((e) => e.eventType === "terminal");
  assert.equal(terminalEvents.length, 1, "should emit one terminal event");
  assert.equal(terminalEvents[0].data.reason, "milestone-complete");
  assert.equal(terminalEvents[0].flowId, ic.flowId);
});
test("terminal event is emitted on blocked state", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    deriveState: async () => ({
      phase: "blocked",
      activeMilestone: { id: "M001", title: "Test", status: "active" },
      activeSlice: null,
      activeTask: null,
      registry: [{ id: "M001", status: "active" }],
      blockers: ["Missing API key"]
    })
  });
  const ic = makeIC(deps);
  const loopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const result = await runPreDispatch(ic, loopState);
  assert.equal(result.action, "break");
  const terminalEvents = capture.events.filter((e) => e.eventType === "terminal");
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].data.reason, "blocked");
  assert.deepEqual(terminalEvents[0].data.blockers, ["Missing API key"]);
});
test("#4671: plan-v2 missing CONTEXT.md reaches dispatch recovery instead of pausing", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-4671-predispatch-"));
  mkdirSync(join(basePath, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(basePath, ".gsd", "gsd.db"));
  try {
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertSlice({
      id: "S01",
      milestoneId: "M001",
      title: "Slice 1",
      status: "in_progress",
      sequence: 1
    });
    insertTask({
      id: "T01",
      milestoneId: "M001",
      sliceId: "S01",
      title: "Task 1",
      status: "pending",
      keyFiles: ["src/task.ts"],
      sequence: 1
    });
    let pauseCalls = 0;
    const capture = createEventCapture();
    const deps = makeMockDeps(capture, {
      pauseAuto: async () => {
        pauseCalls++;
      },
      deriveState: async () => ({
        phase: "executing",
        activeMilestone: { id: "M001", title: "Test", status: "active" },
        activeSlice: { id: "S01", title: "Slice 1" },
        activeTask: { id: "T01", title: "Task 1" },
        registry: [{ id: "M001", status: "active" }],
        blockers: [],
        recentDecisions: [],
        nextAction: "dispatch"
      })
    });
    const ic = makeIC(deps, {
      prefs: { uok: { plan_v2: { enabled: true } } }
    });
    ic.s.basePath = basePath;
    const result = await runPreDispatch(ic, {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0
    });
    assert.equal(result.action, "next");
    assert.equal(pauseCalls, 0, "missing CONTEXT.md should be handled by dispatch recovery, not plan gate pause");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});
test("plan-v2 empty graph rederives state before pausing", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-plan-v2-empty-graph-"));
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
    "# M001: Test\n\nFinalized context.\n"
  );
  openDatabase(join(basePath, ".gsd", "gsd.db"));
  try {
    let deriveCalls = 0;
    let invalidateCalls = 0;
    let pauseCalls = 0;
    const capture = createEventCapture();
    const deps = makeMockDeps(capture, {
      pauseAuto: async () => {
        pauseCalls++;
      },
      invalidateAllCaches: () => {
        invalidateCalls++;
      },
      deriveState: async () => {
        deriveCalls++;
        if (deriveCalls === 1) {
          return {
            phase: "validating-milestone",
            activeMilestone: { id: "M001", title: "Test", status: "active" },
            activeSlice: null,
            activeTask: null,
            registry: [{ id: "M001", status: "active" }],
            blockers: [],
            recentDecisions: [],
            nextAction: "Validate milestone M001."
          };
        }
        return {
          phase: "pre-planning",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: null,
          activeTask: null,
          registry: [{ id: "M001", status: "active" }],
          blockers: [],
          recentDecisions: [],
          nextAction: "Plan milestone M001."
        };
      }
    });
    const ic = makeIC(deps, {
      prefs: { uok: { plan_v2: { enabled: true } } }
    });
    ic.s.basePath = basePath;
    const result = await runPreDispatch(ic, {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0
    });
    assert.equal(result.action, "next");
    assert.equal(deriveCalls, 2, "empty plan graph should trigger one state rederive");
    assert.ok(invalidateCalls >= 1, "empty plan graph recovery should clear caches before rederive");
    assert.equal(pauseCalls, 0, "recoverable empty graph should not pause auto-mode");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});
test("plan-v2 empty graph pauses after one failed rederive", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-plan-v2-empty-graph-pause-"));
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"),
    "# M001: Test\n\nFinalized context.\n"
  );
  openDatabase(join(basePath, ".gsd", "gsd.db"));
  try {
    let deriveCalls = 0;
    let invalidateCalls = 0;
    let pauseCalls = 0;
    const capture = createEventCapture();
    const deps = makeMockDeps(capture, {
      pauseAuto: async () => {
        pauseCalls++;
      },
      invalidateAllCaches: () => {
        invalidateCalls++;
      },
      deriveState: async () => {
        deriveCalls++;
        return {
          phase: "validating-milestone",
          activeMilestone: { id: "M001", title: "Test", status: "active" },
          activeSlice: null,
          activeTask: null,
          registry: [{ id: "M001", status: "active" }],
          blockers: [],
          recentDecisions: [],
          nextAction: "Validate milestone M001."
        };
      }
    });
    const ic = makeIC(deps, {
      prefs: { uok: { plan_v2: { enabled: true } } }
    });
    ic.s.basePath = basePath;
    const result = await runPreDispatch(ic, {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0
    });
    assert.equal(result.action, "break");
    assert.equal(result.reason, "plan-v2-gate-failed");
    assert.equal(deriveCalls, 2, "empty plan graph should only rederive once");
    assert.ok(invalidateCalls >= 1, "empty plan graph recovery should clear caches before rederive");
    assert.equal(pauseCalls, 1, "persistent empty graph should pause auto-mode");
  } finally {
    closeDatabase();
    rmSync(basePath, { recursive: true, force: true });
  }
});
test("milestone-transition event is emitted when milestone changes", async () => {
  const capture = createEventCapture();
  const deps = makeMockDeps(capture, {
    deriveState: async () => ({
      phase: "executing",
      activeMilestone: { id: "M002", title: "Next Milestone", status: "active" },
      activeSlice: { id: "S01" },
      activeTask: { id: "T01" },
      registry: [
        { id: "M001", status: "complete" },
        { id: "M002", status: "active" }
      ],
      blockers: []
    })
  });
  const ic = makeIC(deps, {
    prefs: { uok: { plan_v2: { enabled: false } } }
  });
  ic.s.currentMilestoneId = "M001";
  const loopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  await runPreDispatch(ic, loopState);
  const transitionEvents = capture.events.filter((e) => e.eventType === "milestone-transition");
  assert.equal(transitionEvents.length, 1, "should emit one milestone-transition event");
  assert.equal(transitionEvents[0].data.from, "M001");
  assert.equal(transitionEvents[0].data.to, "M002");
  assert.equal(transitionEvents[0].flowId, ic.flowId);
});
test("unit-end event contains errorContext when unit is cancelled with structured error", async () => {
  const capture = createEventCapture();
  const { resolveAgentEndCancelled, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();
  let pauseCalls = 0;
  let commitCalls = 0;
  const deps = makeMockDeps(capture, {
    pauseAuto: async () => {
      pauseCalls++;
    },
    autoCommitUnit: async () => {
      commitCalls++;
      return "commit";
    }
  });
  const ic = makeIC(deps);
  const iterData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] },
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: void 0
  };
  const loopState = { recentUnits: [{ key: "execute-task/M001/S01/T01" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEndCancelled({ message: "Hard timeout error: exceeded limit", category: "timeout", isTransient: true });
  const result = await unitPromise;
  assert.equal(result.action, "break");
  assert.equal(result.reason, "unit-hard-timeout");
  assert.equal(pauseCalls, 1, "timeout cancellations should pause auto-mode exactly once");
  assert.equal(commitCalls, 1, "timeout cancellations should flush a unit auto-commit once");
  const entry = loopState.recentUnits[loopState.recentUnits.length - 1];
  assert.ok(entry.error, "window entry must have error set");
  assert.ok(entry.error.startsWith("timeout:"), "error must start with category from errorContext");
  assert.ok(entry.error.includes("Hard timeout error"), "error must include the errorContext message");
  const endEvents = capture.events.filter((e) => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "timeout cancellations should still emit unit-end");
  assert.equal(endEvents[0].data.status, "cancelled");
  assert.equal(endEvents[0].data.artifactVerified, false);
  assert.equal(endEvents[0].data.errorContext.category, "timeout");
});
test("session-failed cancellations close out and emit unit-end before hard stop", async () => {
  const capture = createEventCapture();
  const { resolveAgentEndCancelled, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();
  let closeoutCalls = 0;
  let commitCalls = 0;
  let stopCalls = 0;
  const deps = makeMockDeps(capture, {
    closeoutUnit: async () => {
      closeoutCalls++;
    },
    autoCommitUnit: async () => {
      commitCalls++;
      return "commit";
    },
    stopAuto: async () => {
      stopCalls++;
    }
  });
  const ic = makeIC(deps);
  const iterData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] },
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: void 0
  };
  const loopState = { recentUnits: [{ key: "execute-task/M001/S01/T01" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEndCancelled({ message: "session bootstrap exploded", category: "session-failed", isTransient: false });
  const result = await unitPromise;
  assert.equal(result.action, "break");
  assert.equal(result.reason, "session-failed");
  assert.equal(closeoutCalls, 1, "session-failed cancellations should close out the unit before stopping");
  assert.equal(commitCalls, 1, "session-failed cancellations should try one auto-commit flush");
  assert.equal(stopCalls, 1, "session-failed cancellations should hard-stop auto-mode");
  const endEvents = capture.events.filter((e) => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "session-failed cancellations should emit unit-end");
  assert.equal(endEvents[0].data.status, "cancelled");
  assert.equal(endEvents[0].data.artifactVerified, false);
  assert.equal(endEvents[0].data.errorContext.category, "session-failed");
});
test("runFinalize pauses and emits unit-end when pre-verification times out", async () => {
  const capture = createEventCapture();
  let pauseCalls = 0;
  const basePath = mkdtempSync(join(tmpdir(), "gsd-finalize-timeout-"));
  const deps = makeMockDeps(capture, {
    pauseAuto: async () => {
      pauseCalls++;
    },
    postUnitPreVerification: async () => {
      await new Promise(() => {
      });
      return "continue";
    }
  });
  const ic = makeIC(deps, {
    s: {
      ...makeSession(),
      basePath,
      currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: 1234 }
    }
  });
  const iterData = {
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    prompt: "do stuff",
    finalPrompt: "do stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] },
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: void 0
  };
  const loopState = { recentUnits: [], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const originalSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((handler, _timeout, ...args) => originalSetTimeout(handler, 0, ...args));
    const result = await runFinalize(ic, iterData, loopState);
    assert.equal(result.action, "break");
    assert.equal(result.reason, "finalize-pre-timeout");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(pauseCalls, 1, "pre-verification timeout should pause auto-mode");
  assert.equal(loopState.consecutiveFinalizeTimeouts, 1, "timeout should increment finalize timeout counter");
  assert.equal(ic.s.currentUnit, null, "timed-out finalize should detach currentUnit");
  const runtime = readUnitRuntimeRecord(basePath, "execute-task", "M001/S01/T01");
  assert.ok(runtime, "timed-out finalize should persist a runtime record");
  assert.equal(runtime?.phase, "finalize-timeout");
  assert.equal(runtime?.lastProgressKind, "finalize-pre-timeout");
  const endEvents = capture.events.filter((e) => e.eventType === "unit-end");
  assert.equal(endEvents.length, 1, "timed-out finalize should emit terminal unit-end");
  assert.equal(endEvents[0].data.status, "timed-out-finalize");
  assert.equal(endEvents[0].data.artifactVerified, false);
  assert.equal(endEvents[0].data.finalizeStage, "pre");
});
test("transient session-failed cancellations pause instead of hard-stopping", async () => {
  const capture = createEventCapture();
  const { resolveAgentEndCancelled, _resetPendingResolve } = await import("../auto/resolve.js");
  _resetPendingResolve();
  const deps = makeMockDeps(capture);
  const ic = makeIC(deps);
  const iterData = {
    unitType: "execute-task",
    unitId: "M001/S01/T02",
    prompt: "do more stuff",
    finalPrompt: "do more stuff",
    pauseAfterUatDispatch: false,
    state: { phase: "executing", activeMilestone: { id: "M001" }, activeSlice: { id: "S01" }, registry: [], blockers: [] },
    mid: "M001",
    midTitle: "Test",
    isRetry: false,
    previousTier: void 0
  };
  const loopState = { recentUnits: [{ key: "execute-task/M001/S01/T02" }], stuckRecoveryAttempts: 0, consecutiveFinalizeTimeouts: 0 };
  const unitPromise = runUnitPhase(ic, iterData, loopState);
  await new Promise((r) => setTimeout(r, 50));
  resolveAgentEndCancelled({ message: "Session creation failed: temporary bootstrap overload", category: "session-failed", isTransient: true });
  const result = await unitPromise;
  assert.equal(result.action, "break");
  assert.equal(result.reason, "session-timeout");
  const entry = loopState.recentUnits[loopState.recentUnits.length - 1];
  assert.ok(entry.error, "window entry must have error set");
  assert.ok(entry.error.startsWith("session-failed:"), "error must preserve the session-failed category");
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9qb3VybmFsLWludGVncmF0aW9uLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogam91cm5hbC1pbnRlZ3JhdGlvbi50ZXN0LnRzIFx1MjAxNCBJbnRlZ3JhdGlvbiB0ZXN0cyBwcm92aW5nIHRoYXQgcGhhc2UgZnVuY3Rpb25zXG4gKiBlbWl0IGNvcnJlY3Qgam91cm5hbCBldmVudCBzZXF1ZW5jZXMgd2l0aCBmbG93SWQgdGhyZWFkaW5nLCBydWxlIHByb3ZlbmFuY2UsXG4gKiBhbmQgY2F1c2VkQnkgcmVmZXJlbmNlcy5cbiAqXG4gKiBUaGVzZSB0ZXN0cyBjYWxsIHRoZSByZWFsIHJ1bkRpc3BhdGNoIC8gcnVuVW5pdFBoYXNlIC8gcnVuUHJlRGlzcGF0Y2hcbiAqIGZ1bmN0aW9ucyB3aXRoIG1vY2sgTG9vcERlcHMgdGhhdCBjYXB0dXJlIGVtaXRKb3VybmFsRXZlbnQgY2FsbHMuXG4gKi9cblxuaW1wb3J0IHRlc3QgZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBta2RpclN5bmMsIG1rZHRlbXBTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB0eXBlIHsgSm91cm5hbEVudHJ5IH0gZnJvbSBcIi4uL2pvdXJuYWwuanNcIjtcbmltcG9ydCB0eXBlIHsgTG9vcERlcHMgfSBmcm9tIFwiLi4vYXV0by9sb29wLWRlcHMuanNcIjtcbmltcG9ydCB7IFdvcmt0cmVlU3RhdGVQcm9qZWN0aW9uIH0gZnJvbSBcIi4uL3dvcmt0cmVlLXN0YXRlLXByb2plY3Rpb24uanNcIjtcbmltcG9ydCB0eXBlIHsgSXRlcmF0aW9uQ29udGV4dCwgTG9vcFN0YXRlLCBQcmVEaXNwYXRjaERhdGEsIEl0ZXJhdGlvbkRhdGEgfSBmcm9tIFwiLi4vYXV0by90eXBlcy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBTZXNzaW9uTG9ja1N0YXR1cyB9IGZyb20gXCIuLi9zZXNzaW9uLWxvY2suanNcIjtcbmltcG9ydCB7IHJ1bkRpc3BhdGNoLCBydW5Vbml0UGhhc2UsIHJ1blByZURpc3BhdGNoLCBydW5GaW5hbGl6ZSB9IGZyb20gXCIuLi9hdXRvL3BoYXNlcy5qc1wiO1xuaW1wb3J0IHsgcmVhZFVuaXRSdW50aW1lUmVjb3JkIH0gZnJvbSBcIi4uL3VuaXQtcnVudGltZS5qc1wiO1xuaW1wb3J0IHtcbiAgY2xvc2VEYXRhYmFzZSxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBpbnNlcnRTbGljZSxcbiAgaW5zZXJ0VGFzayxcbiAgb3BlbkRhdGFiYXNlLFxufSBmcm9tIFwiLi4vZ3NkLWRiLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogQ2FwdHVyZWQgam91cm5hbCBldmVudHMgZnJvbSB0aGUgbW9jayBkZXBzLiAqL1xuZnVuY3Rpb24gY3JlYXRlRXZlbnRDYXB0dXJlKCkge1xuICBjb25zdCBldmVudHM6IEpvdXJuYWxFbnRyeVtdID0gW107XG4gIHJldHVybiB7XG4gICAgZXZlbnRzLFxuICAgIGVtaXRKb3VybmFsRXZlbnQ6IChlbnRyeTogSm91cm5hbEVudHJ5KSA9PiB7IGV2ZW50cy5wdXNoKGVudHJ5KTsgfSxcbiAgfTtcbn1cblxuLyoqIE1pbmltYWwgbW9jayBMb29wRGVwcyB3aXRoIGpvdXJuYWwgZXZlbnQgY2FwdHVyZS4gKi9cbmZ1bmN0aW9uIG1ha2VNb2NrRGVwcyhcbiAgY2FwdHVyZTogUmV0dXJuVHlwZTx0eXBlb2YgY3JlYXRlRXZlbnRDYXB0dXJlPixcbiAgb3ZlcnJpZGVzPzogUGFydGlhbDxMb29wRGVwcz4sXG4pOiBMb29wRGVwcyB7XG4gIGNvbnN0IGJhc2VEZXBzOiBMb29wRGVwcyA9IHtcbiAgICBsb2NrQmFzZTogKCkgPT4gXCIvdG1wL3Rlc3QtbG9ja1wiLFxuICAgIGJ1aWxkU25hcHNob3RPcHRzOiAoKSA9PiAoe30pLFxuICAgIHN0b3BBdXRvOiBhc3luYyAoKSA9PiB7fSxcbiAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHt9LFxuICAgIGNsZWFyVW5pdFRpbWVvdXQ6ICgpID0+IHt9LFxuICAgIHVwZGF0ZVByb2dyZXNzV2lkZ2V0OiAoKSA9PiB7fSxcbiAgICBzeW5jQ211eFNpZGViYXI6ICgpID0+IHt9LFxuICAgIGxvZ0NtdXhFdmVudDogKCkgPT4ge30sXG4gICAgaW52YWxpZGF0ZUFsbENhY2hlczogKCkgPT4ge30sXG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+ICh7XG4gICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiIH0sXG4gICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgfSkgYXMgYW55LFxuICAgIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlczogKCkgPT4gKHsgcHJlZmVyZW5jZXM6IHt9IH0pLFxuICAgIHByZURpc3BhdGNoSGVhbHRoR2F0ZTogYXN5bmMgKCkgPT4gKHsgcHJvY2VlZDogdHJ1ZSwgZml4ZXNBcHBsaWVkOiBbXSB9KSxcbiAgICBjaGVja1Jlc291cmNlc1N0YWxlOiAoKSA9PiBudWxsLFxuICAgIHZhbGlkYXRlU2Vzc2lvbkxvY2s6ICgpID0+ICh7IHZhbGlkOiB0cnVlIH0pIGFzIFNlc3Npb25Mb2NrU3RhdHVzLFxuICAgIHVwZGF0ZVNlc3Npb25Mb2NrOiAoKSA9PiB7fSxcbiAgICBoYW5kbGVMb3N0U2Vzc2lvbkxvY2s6ICgpID0+IHt9LFxuICAgIHNlbmREZXNrdG9wTm90aWZpY2F0aW9uOiAoKSA9PiB7fSxcbiAgICBzZXRBY3RpdmVNaWxlc3RvbmVJZDogKCkgPT4ge30sXG4gICAgcHJ1bmVRdWV1ZU9yZGVyOiAoKSA9PiB7fSxcbiAgICBpc0luQXV0b1dvcmt0cmVlOiAoKSA9PiBmYWxzZSxcbiAgICBzaG91bGRVc2VXb3JrdHJlZUlzb2xhdGlvbjogKCkgPT4gZmFsc2UsXG4gICAgdGVhcmRvd25BdXRvV29ya3RyZWU6ICgpID0+IHt9LFxuICAgIGNyZWF0ZUF1dG9Xb3JrdHJlZTogKCkgPT4gXCIvdG1wL3d0XCIsXG4gICAgY2FwdHVyZUludGVncmF0aW9uQnJhbmNoOiAoKSA9PiB7fSxcbiAgICBnZXRJc29sYXRpb25Nb2RlOiAoKSA9PiBcIm5vbmVcIixcbiAgICBnZXRDdXJyZW50QnJhbmNoOiAoKSA9PiBcIm1haW5cIixcbiAgICBhdXRvV29ya3RyZWVCcmFuY2g6ICgpID0+IFwiYXV0by9NMDAxXCIsXG4gICAgcmVzb2x2ZU1pbGVzdG9uZUZpbGU6ICgpID0+IG51bGwsXG4gICAgcmVjb25jaWxlTWVyZ2VTdGF0ZTogKCkgPT4gXCJjbGVhblwiLFxuICAgIHByZWZsaWdodENsZWFuUm9vdDogKCkgPT4gKHsgc3Rhc2hQdXNoZWQ6IGZhbHNlLCBzdW1tYXJ5OiBcIlwiIH0pLFxuICAgIHBvc3RmbGlnaHRQb3BTdGFzaDogKCkgPT4gKHtcbiAgICAgIHJlc3RvcmVkOiB0cnVlLFxuICAgICAgbmVlZHNNYW51YWxSZWNvdmVyeTogZmFsc2UsXG4gICAgICBtZXNzYWdlOiBcInJlc3RvcmVkXCIsXG4gICAgfSksXG4gICAgZ2V0TGVkZ2VyOiAoKSA9PiAoeyB1bml0czogW10gfSksXG4gICAgZ2V0UHJvamVjdFRvdGFsczogKCkgPT4gKHsgY29zdDogMCB9KSxcbiAgICBmb3JtYXRDb3N0OiAoYzogbnVtYmVyKSA9PiBgJCR7Yy50b0ZpeGVkKDIpfWAsXG4gICAgZ2V0QnVkZ2V0QWxlcnRMZXZlbDogKCkgPT4gMCxcbiAgICBnZXROZXdCdWRnZXRBbGVydExldmVsOiAoKSA9PiAwLFxuICAgIGdldEJ1ZGdldEVuZm9yY2VtZW50QWN0aW9uOiAoKSA9PiBcIm5vbmVcIixcbiAgICBnZXRNYW5pZmVzdFN0YXR1czogYXN5bmMgKCkgPT4gbnVsbCxcbiAgICBjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdDogYXN5bmMgKCkgPT4gbnVsbCxcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+ICh7XG4gICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIiBhcyBjb25zdCxcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgcHJvbXB0OiBcImRvIHRoZSB0aGluZ1wiLFxuICAgICAgbWF0Y2hlZFJ1bGU6IFwidGVzdC1ydWxlLWFscGhhXCIsXG4gICAgfSksXG4gICAgcnVuUHJlRGlzcGF0Y2hIb29rczogKCkgPT4gKHsgZmlyZWRIb29rczogW10sIGFjdGlvbjogXCJwcm9jZWVkXCIgfSksXG4gICAgZ2V0UHJpb3JTbGljZUNvbXBsZXRpb25CbG9ja2VyOiAoKSA9PiBudWxsLFxuICAgIGdldE1haW5CcmFuY2g6ICgpID0+IFwibWFpblwiLFxuICAgIGNsb3Nlb3V0VW5pdDogYXN5bmMgKCkgPT4ge30sXG4gICAgYXV0b0NvbW1pdFVuaXQ6IGFzeW5jICgpID0+IG51bGwsXG4gICAgcmVjb3JkT3V0Y29tZTogKCkgPT4ge30sXG4gICAgd3JpdGVMb2NrOiAoKSA9PiB7fSxcbiAgICBjYXB0dXJlQXZhaWxhYmxlU2tpbGxzOiAoKSA9PiB7fSxcbiAgICBlbnN1cmVQcmVjb25kaXRpb25zOiAoKSA9PiB7fSxcbiAgICB1cGRhdGVTbGljZVByb2dyZXNzQ2FjaGU6ICgpID0+IHt9LFxuICAgIHNlbGVjdEFuZEFwcGx5TW9kZWw6IGFzeW5jICgpID0+ICh7IHJvdXRpbmc6IG51bGwsIGFwcGxpZWRNb2RlbDogbnVsbCB9KSxcbiAgICBzdGFydFVuaXRTdXBlcnZpc2lvbjogKCkgPT4ge30sXG4gICAgZ2V0RGVlcERpYWdub3N0aWM6ICgpID0+IG51bGwsXG4gICAgaXNEYkF2YWlsYWJsZTogKCkgPT4gZmFsc2UsXG4gICAgcmVvcmRlckZvckNhY2hpbmc6IChwOiBzdHJpbmcpID0+IHAsXG4gICAgZXhpc3RzU3luYzogKHA6IHN0cmluZykgPT4gcC5lbmRzV2l0aChcIi5naXRcIikgfHwgcC5lbmRzV2l0aChcInBhY2thZ2UuanNvblwiKSxcbiAgICByZWFkRmlsZVN5bmM6ICgpID0+IFwiXCIsXG4gICAgYXRvbWljV3JpdGVTeW5jOiAoKSA9PiB7fSxcbiAgICBHaXRTZXJ2aWNlSW1wbDogY2xhc3Mge30gYXMgYW55LFxuICAgIHdvcmt0cmVlUHJvamVjdGlvbjogbmV3IFdvcmt0cmVlU3RhdGVQcm9qZWN0aW9uKCksXG4gICAgbGlmZWN5Y2xlOiB7XG4gICAgICBlbnRlck1pbGVzdG9uZTogKCkgPT4gKHsgb2s6IHRydWUsIG1vZGU6IFwid29ya3RyZWVcIiwgcGF0aDogXCIvdG1wL3Byb2plY3RcIiB9KSxcbiAgICAgIGV4aXRNaWxlc3RvbmU6IChfbWlkOiBzdHJpbmcsIG9wdHM6IHsgbWVyZ2U6IGJvb2xlYW4gfSkgPT4gKHtcbiAgICAgICAgb2s6IHRydWUsXG4gICAgICAgIG1lcmdlZDogb3B0cy5tZXJnZSxcbiAgICAgICAgY29kZUZpbGVzQ2hhbmdlZDogZmFsc2UsXG4gICAgICB9KSxcbiAgICB9IGFzIGFueSxcbiAgICBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbjogYXN5bmMgKCkgPT4gXCJjb250aW51ZVwiIGFzIGNvbnN0LFxuICAgIHJ1blBvc3RVbml0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiBcImNvbnRpbnVlXCIgYXMgY29uc3QsXG4gICAgcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uOiBhc3luYyAoKSA9PiBcImNvbnRpbnVlXCIgYXMgY29uc3QsXG4gICAgZ2V0U2Vzc2lvbkZpbGU6ICgpID0+IFwiL3RtcC9zZXNzaW9uLmpzb25cIixcbiAgICByZWJ1aWxkU3RhdGU6IGFzeW5jICgpID0+IHt9LFxuICAgIHJlc29sdmVNb2RlbElkOiAoaWQ6IHN0cmluZywgbW9kZWxzOiBhbnlbXSkgPT4gbW9kZWxzLmZpbmQoKG06IGFueSkgPT4gbS5pZCA9PT0gaWQpLFxuICAgIGVtaXRKb3VybmFsRXZlbnQ6IGNhcHR1cmUuZW1pdEpvdXJuYWxFdmVudCxcbiAgfTtcblxuICByZXR1cm4geyAuLi5iYXNlRGVwcywgLi4ub3ZlcnJpZGVzIH07XG59XG5cbi8qKiBCdWlsZCBhIG1vY2sgSXRlcmF0aW9uQ29udGV4dCB3aXRoIHJlYWwgZmxvd0lkIGFuZCBzZXFDb3VudGVyLiAqL1xuZnVuY3Rpb24gbWFrZUlDKFxuICBkZXBzOiBMb29wRGVwcyxcbiAgb3ZlcnJpZGVzPzogUGFydGlhbDxJdGVyYXRpb25Db250ZXh0Pixcbik6IEl0ZXJhdGlvbkNvbnRleHQge1xuICBjb25zdCBmbG93SWQgPSByYW5kb21VVUlEKCk7XG4gIGxldCBzZXFDb3VudGVyID0gMDtcbiAgcmV0dXJuIHtcbiAgICBjdHg6IHtcbiAgICAgIHVpOiB7IG5vdGlmeTogKCkgPT4ge30sIHNldFN0YXR1czogKCkgPT4ge30gfSxcbiAgICAgIG1vZGVsOiB7IGlkOiBcInRlc3QtbW9kZWxcIiB9LFxuICAgICAgbW9kZWxSZWdpc3RyeTogeyBnZXRBdmFpbGFibGU6ICgpID0+IFtdIH0sXG4gICAgfSBhcyBhbnksXG4gICAgcGk6IHtcbiAgICAgIHNlbmRNZXNzYWdlOiAoKSA9PiB7fSxcbiAgICAgIHNldE1vZGVsOiBhc3luYyAoKSA9PiB0cnVlLFxuICAgIH0gYXMgYW55LFxuICAgIHM6IG1ha2VTZXNzaW9uKCksXG4gICAgZGVwcyxcbiAgICBwcmVmczogdW5kZWZpbmVkLFxuICAgIGl0ZXJhdGlvbjogMSxcbiAgICBmbG93SWQsXG4gICAgbmV4dFNlcTogKCkgPT4gKytzZXFDb3VudGVyLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuLyoqIE1pbmltYWwgbW9jayBzZXNzaW9uIGZvciBwaGFzZSBjYWxscy4gKi9cbmZ1bmN0aW9uIG1ha2VTZXNzaW9uKCkge1xuICByZXR1cm4ge1xuICAgIGFjdGl2ZTogdHJ1ZSxcbiAgICB2ZXJib3NlOiBmYWxzZSxcbiAgICBzdGVwTW9kZTogZmFsc2UsXG4gICAgcGF1c2VkOiBmYWxzZSxcbiAgICBiYXNlUGF0aDogXCIvdG1wL3Byb2plY3RcIixcbiAgICBvcmlnaW5hbEJhc2VQYXRoOiBcIlwiLFxuICAgIGN1cnJlbnRNaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgY3VycmVudFVuaXQ6IG51bGwsXG4gICAgY3VycmVudFVuaXRSb3V0aW5nOiBudWxsLFxuICAgIGNvbXBsZXRlZFVuaXRzOiBbXSxcbiAgICByZXNvdXJjZVZlcnNpb25PblN0YXJ0OiBudWxsLFxuICAgIGxhc3RQcm9tcHRDaGFyQ291bnQ6IHVuZGVmaW5lZCxcbiAgICBsYXN0QmFzZWxpbmVDaGFyQ291bnQ6IHVuZGVmaW5lZCxcbiAgICBsYXN0QnVkZ2V0QWxlcnRMZXZlbDogMCxcbiAgICBwZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnk6IG51bGwsXG4gICAgcGVuZGluZ0NyYXNoUmVjb3Zlcnk6IG51bGwsXG4gICAgcGVuZGluZ1F1aWNrVGFza3M6IFtdLFxuICAgIHNpZGVjYXJRdWV1ZTogW10sXG4gICAgYXV0b01vZGVTdGFydE1vZGVsOiBudWxsLFxuICAgIHVuaXREaXNwYXRjaENvdW50OiBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpLFxuICAgIHVuaXRMaWZldGltZURpc3BhdGNoZXM6IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCksXG4gICAgdW5pdFJlY292ZXJ5Q291bnQ6IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCksXG4gICAgdmVyaWZpY2F0aW9uUmV0cnlDb3VudDogbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKSxcbiAgICBnaXRTZXJ2aWNlOiBudWxsLFxuICAgIGF1dG9TdGFydFRpbWU6IERhdGUubm93KCksXG4gICAgY21kQ3R4OiB7XG4gICAgICBuZXdTZXNzaW9uOiAoKSA9PiBQcm9taXNlLnJlc29sdmUoeyBjYW5jZWxsZWQ6IGZhbHNlIH0pLFxuICAgICAgZ2V0Q29udGV4dFVzYWdlOiAoKSA9PiAoeyBwZXJjZW50OiAxMCwgdG9rZW5zOiAxMDAwLCBsaW1pdDogMTAwMDAgfSksXG4gICAgfSxcbiAgICBjbGVhclRpbWVyczogKCkgPT4ge30sXG4gIH0gYXMgYW55O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbnRlc3QoXCJydW5EaXNwYXRjaCBlbWl0cyBkaXNwYXRjaC1tYXRjaCB3aXRoIGNvcnJlY3QgcnVsZSBhbmQgZmxvd0lkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUsIHtcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+ICh7XG4gICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIiBhcyBjb25zdCxcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgcHJvbXB0OiBcImRvIHRoZSB0aGluZ1wiLFxuICAgICAgbWF0Y2hlZFJ1bGU6IFwic2xpY2UtdGFzay1ydWxlXCIsXG4gICAgfSksXG4gIH0pO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzKTtcbiAgY29uc3QgcHJlRGF0YTogUHJlRGlzcGF0Y2hEYXRhID0ge1xuICAgIHN0YXRlOiB7XG4gICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2UgMVwiIH0sXG4gICAgICBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sXG4gICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgfSBhcyBhbnksXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICB9O1xuICBjb25zdCBsb29wU3RhdGU6IExvb3BTdGF0ZSA9IHsgcmVjZW50VW5pdHM6IFtdLCBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKGljLCBwcmVEYXRhLCBsb29wU3RhdGUpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5leHRcIiwgXCJydW5EaXNwYXRjaCBzaG91bGQgcmV0dXJuIG5leHQgZm9yIGRpc3BhdGNoIGFjdGlvblwiKTtcblxuICBjb25zdCBtYXRjaEV2ZW50cyA9IGNhcHR1cmUuZXZlbnRzLmZpbHRlcihlID0+IGUuZXZlbnRUeXBlID09PSBcImRpc3BhdGNoLW1hdGNoXCIpO1xuICBhc3NlcnQuZXF1YWwobWF0Y2hFdmVudHMubGVuZ3RoLCAxLCBcInNob3VsZCBlbWl0IGV4YWN0bHkgb25lIGRpc3BhdGNoLW1hdGNoIGV2ZW50XCIpO1xuXG4gIGNvbnN0IGV2ID0gbWF0Y2hFdmVudHNbMF07XG4gIGFzc2VydC5lcXVhbChldi5mbG93SWQsIGljLmZsb3dJZCwgXCJkaXNwYXRjaC1tYXRjaCBldmVudCBzaG91bGQgc2hhcmUgdGhlIGl0ZXJhdGlvbiBmbG93SWRcIik7XG4gIGFzc2VydC5lcXVhbChldi5ydWxlLCBcInNsaWNlLXRhc2stcnVsZVwiLCBcImRpc3BhdGNoLW1hdGNoIHNob3VsZCBjYXJyeSB0aGUgbWF0Y2hlZCBydWxlIG5hbWVcIik7XG4gIGFzc2VydC5lcXVhbCgoZXYuZGF0YSBhcyBhbnkpLnVuaXRUeXBlLCBcImV4ZWN1dGUtdGFza1wiKTtcbiAgYXNzZXJ0LmVxdWFsKChldi5kYXRhIGFzIGFueSkudW5pdElkLCBcIk0wMDEvUzAxL1QwMVwiKTtcbn0pO1xuXG50ZXN0KFwicnVuRGlzcGF0Y2ggZW1pdHMgZGlzcGF0Y2gtc3RvcCB3aGVuIGRpc3BhdGNoIHJldHVybnMgc3RvcCBhY3Rpb25cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjYXB0dXJlID0gY3JlYXRlRXZlbnRDYXB0dXJlKCk7XG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4gKHtcbiAgICAgIGFjdGlvbjogXCJzdG9wXCIgYXMgY29uc3QsXG4gICAgICByZWFzb246IFwibm8gZWxpZ2libGUgdW5pdHNcIixcbiAgICAgIGxldmVsOiBcImluZm9cIiBhcyBjb25zdCxcbiAgICAgIG1hdGNoZWRSdWxlOiBcIjxuby1tYXRjaD5cIixcbiAgICB9KSxcbiAgfSk7XG4gIGNvbnN0IGljID0gbWFrZUlDKGRlcHMpO1xuICBjb25zdCBwcmVEYXRhOiBQcmVEaXNwYXRjaERhdGEgPSB7XG4gICAgc3RhdGU6IHsgcGhhc2U6IFwiZXhlY3V0aW5nXCIsIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIgfSwgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLCBibG9ja2VyczogW10gfSBhcyBhbnksXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gIH07XG4gIGNvbnN0IGxvb3BTdGF0ZTogTG9vcFN0YXRlID0geyByZWNlbnRVbml0czogW10sIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCwgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRGlzcGF0Y2goaWMsIHByZURhdGEsIGxvb3BTdGF0ZSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImJyZWFrXCIpO1xuXG4gIGNvbnN0IHN0b3BFdmVudHMgPSBjYXB0dXJlLmV2ZW50cy5maWx0ZXIoZSA9PiBlLmV2ZW50VHlwZSA9PT0gXCJkaXNwYXRjaC1zdG9wXCIpO1xuICBhc3NlcnQuZXF1YWwoc3RvcEV2ZW50cy5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwoc3RvcEV2ZW50c1swXS5ydWxlLCBcIjxuby1tYXRjaD5cIik7XG4gIGFzc2VydC5lcXVhbCgoc3RvcEV2ZW50c1swXS5kYXRhIGFzIGFueSkucmVhc29uLCBcIm5vIGVsaWdpYmxlIHVuaXRzXCIpO1xuICBhc3NlcnQuZXF1YWwoc3RvcEV2ZW50c1swXS5mbG93SWQsIGljLmZsb3dJZCk7XG59KTtcblxudGVzdChcInJ1bkRpc3BhdGNoIGNoZWNrcyBwcmlvci1zbGljZSBjb21wbGV0aW9uIGFnYWluc3QgdGhlIHByb2plY3Qgcm9vdCBpbiB3b3JrdHJlZSBtb2RlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICBjb25zdCBndWFyZENhbGxzOiBBcnJheTx7IGZuOiBzdHJpbmc7IGFyZ3M6IHVua25vd25bXSB9PiA9IFtdO1xuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUsIHtcbiAgICBnZXRNYWluQnJhbmNoOiAoYmFzZVBhdGg6IHN0cmluZykgPT4ge1xuICAgICAgZ3VhcmRDYWxscy5wdXNoKHsgZm46IFwiZ2V0TWFpbkJyYW5jaFwiLCBhcmdzOiBbYmFzZVBhdGhdIH0pO1xuICAgICAgcmV0dXJuIFwibWFpblwiO1xuICAgIH0sXG4gICAgZ2V0UHJpb3JTbGljZUNvbXBsZXRpb25CbG9ja2VyOiAoXG4gICAgICBiYXNlUGF0aDogc3RyaW5nLFxuICAgICAgbWFpbkJyYW5jaDogc3RyaW5nLFxuICAgICAgdW5pdFR5cGU6IHN0cmluZyxcbiAgICAgIHVuaXRJZDogc3RyaW5nLFxuICAgICkgPT4ge1xuICAgICAgZ3VhcmRDYWxscy5wdXNoKHtcbiAgICAgICAgZm46IFwiZ2V0UHJpb3JTbGljZUNvbXBsZXRpb25CbG9ja2VyXCIsXG4gICAgICAgIGFyZ3M6IFtiYXNlUGF0aCwgbWFpbkJyYW5jaCwgdW5pdFR5cGUsIHVuaXRJZF0sXG4gICAgICB9KTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0sXG4gIH0pO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzLCB7XG4gICAgczoge1xuICAgICAgLi4ubWFrZVNlc3Npb24oKSxcbiAgICAgIGJhc2VQYXRoOiBcIi90bXAvcHJvamVjdC8uZ3NkL3dvcmt0cmVlcy9NMDI5LXhva2xvOVwiLFxuICAgICAgb3JpZ2luYWxCYXNlUGF0aDogXCIvdG1wL3Byb2plY3RcIixcbiAgICB9IGFzIGFueSxcbiAgfSk7XG4gIGNvbnN0IHByZURhdGE6IFByZURpc3BhdGNoRGF0YSA9IHtcbiAgICBzdGF0ZToge1xuICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAyOS14b2tsbzlcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIgfSxcbiAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDI5LXhva2xvOVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgfSBhcyBhbnksXG4gICAgbWlkOiBcIk0wMjkteG9rbG85XCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgfTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5EaXNwYXRjaChpYywgcHJlRGF0YSwge1xuICAgIHJlY2VudFVuaXRzOiBbXSxcbiAgICBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsXG4gICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICB9KTtcblxuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJuZXh0XCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKGd1YXJkQ2FsbHMsIFtcbiAgICB7IGZuOiBcImdldE1haW5CcmFuY2hcIiwgYXJnczogW1wiL3RtcC9wcm9qZWN0XCJdIH0sXG4gICAge1xuICAgICAgZm46IFwiZ2V0UHJpb3JTbGljZUNvbXBsZXRpb25CbG9ja2VyXCIsXG4gICAgICBhcmdzOiBbXCIvdG1wL3Byb2plY3RcIiwgXCJtYWluXCIsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCJdLFxuICAgIH0sXG4gIF0pO1xufSk7XG5cbnRlc3QoXCJydW5EaXNwYXRjaCBwYXVzZXMgd2hlbiBjb21wbGV0ZS1taWxlc3RvbmUgc3VtbWFyeSBleGlzdHMgb24gZGlzayBidXQgdGhlIHVuaXQgaXMgc3RpbGwgc3R1Y2sgKCM0Mjg5KVwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBjYXB0dXJlID0gY3JlYXRlRXZlbnRDYXB0dXJlKCk7XG4gIGxldCBwYXVzZUNhbGxzID0gMDtcbiAgbGV0IHN0b3BDYWxscyA9IDA7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXN0dWNrLWNvbXBsZXRlLSR7cmFuZG9tVVVJRCgpfWApO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2UsIFwic3JjXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwiTTAwMS1TVU1NQVJZLm1kXCIpLCBcIiMgU3VtbWFyeVxcbkRvbmUuXFxuXCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oYmFzZSwgXCJzcmNcIiwgXCJhcHAudHNcIiksIFwiZXhwb3J0IGNvbnN0IG9rID0gdHJ1ZTtcXG5cIik7XG5cbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImluaXRcIiwgXCItYlwiLCBcIm1haW5cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImNvbmZpZ1wiLCBcInVzZXIubmFtZVwiLCBcIkNvZGV4XCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb25maWdcIiwgXCJ1c2VyLmVtYWlsXCIsIFwiY29kZXhAZXhhbXBsZS5jb21cIl0sIHsgY3dkOiBiYXNlLCBzdGRpbzogXCJpZ25vcmVcIiB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGJhc2UsIFwiUkVBRE1FLm1kXCIpLCBcIiMgdGVzdFxcblwiKTtcbiAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImFkZFwiLCBcIlJFQURNRS5tZFwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY29tbWl0XCIsIFwiLW1cIiwgXCJjaG9yZTogc2VlZFwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiY2hlY2tvdXRcIiwgXCItYlwiLCBcImZpeC90ZXN0XCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCIuZ3NkL21pbGVzdG9uZXMvTTAwMS9NMDAxLVNVTU1BUlkubWRcIiwgXCJzcmMvYXBwLnRzXCJdLCB7IGN3ZDogYmFzZSwgc3RkaW86IFwiaWdub3JlXCIgfSk7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjb21taXRcIiwgXCItbVwiLCBcImZlYXQ6IHN1bW1hcnkgZXhpc3RzIGJ1dCBkYiBpcyBzdGFsZVwiXSwgeyBjd2Q6IGJhc2UsIHN0ZGlvOiBcImlnbm9yZVwiIH0pO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgIHBhdXNlQXV0bzogYXN5bmMgKCkgPT4geyBwYXVzZUNhbGxzKys7IH0sXG4gICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHsgc3RvcENhbGxzKys7IH0sXG4gICAgcmVzb2x2ZURpc3BhdGNoOiBhc3luYyAoKSA9PiAoe1xuICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICB1bml0VHlwZTogXCJjb21wbGV0ZS1taWxlc3RvbmVcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxXCIsXG4gICAgICBwcm9tcHQ6IFwiY29tcGxldGUgdGhlIG1pbGVzdG9uZVwiLFxuICAgICAgbWF0Y2hlZFJ1bGU6IFwiY29tcGxldGluZy1taWxlc3RvbmUtcnVsZVwiLFxuICAgIH0pLFxuICB9KTtcblxuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzLCB7XG4gICAgczoge1xuICAgICAgLi4ubWFrZVNlc3Npb24oKSxcbiAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgY3VycmVudE1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICB9IGFzIGFueSxcbiAgfSk7XG4gIGNvbnN0IHByZURhdGE6IFByZURpc3BhdGNoRGF0YSA9IHtcbiAgICBzdGF0ZToge1xuICAgICAgcGhhc2U6IFwiY29tcGxldGluZy1taWxlc3RvbmVcIixcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgfSBhcyBhbnksXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKGljLCBwcmVEYXRhLCB7XG4gICAgcmVjZW50VW5pdHM6IFtcbiAgICAgIHsga2V5OiBcImNvbXBsZXRlLW1pbGVzdG9uZS9NMDAxXCIgfSxcbiAgICAgIHsga2V5OiBcImNvbXBsZXRlLW1pbGVzdG9uZS9NMDAxXCIgfSxcbiAgICBdLFxuICAgIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCxcbiAgICBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAsXG4gIH0pO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImJyZWFrXCIpO1xuICBhc3NlcnQuZXF1YWwoKHJlc3VsdCBhcyBhbnkpLnJlYXNvbiwgXCJjb21wbGV0ZS1taWxlc3RvbmUtYXJ0aWZhY3QtZGItbWlzbWF0Y2hcIik7XG4gIGFzc2VydC5lcXVhbChwYXVzZUNhbGxzLCAxLCBcImNvbXBsZXRlLW1pbGVzdG9uZSBkaXNrL2RiIG1pc21hdGNoIHNob3VsZCBwYXVzZSBhdXRvLW1vZGVcIik7XG4gIGFzc2VydC5lcXVhbChzdG9wQ2FsbHMsIDAsIFwibWlzbWF0Y2ggcGF1c2Ugc2hvdWxkIG5vdCBoYXJkLXN0b3AgdGhlIGxvb3BcIik7XG59KTtcblxudGVzdChcInJ1bkRpc3BhdGNoIHBhdXNlcyB3aGVuIGV4ZWN1dGUtdGFzayBhcnRpZmFjdHMgZXhpc3QgYnV0IERCIHN0YXR1cyBpcyBzdGlsbCBvcGVuXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGNhcHR1cmUgPSBjcmVhdGVFdmVudENhcHR1cmUoKTtcbiAgbGV0IHBhdXNlQ2FsbHMgPSAwO1xuICBsZXQgc3RvcENhbGxzID0gMDtcbiAgbGV0IGludmFsaWRhdGVDYWxscyA9IDA7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXN0dWNrLWV4ZWN1dGUtdGFzay0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgY29uc3QgdGFza3NEaXIgPSBqb2luKHNsaWNlRGlyLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlNsaWNlXCIsIHN0YXR1czogXCJpbl9wcm9ncmVzc1wiIH0pO1xuICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgdGl0bGU6IFwiRmlyc3QgdGFza1wiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuICB3cml0ZUZpbGVTeW5jKFxuICAgIGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksXG4gICAgW1xuICAgICAgXCIjIFMwMVwiLFxuICAgICAgXCJcIixcbiAgICAgIFwiIyMgVGFza3NcIixcbiAgICAgIFwiXCIsXG4gICAgICBcIi0gW3hdICoqVDAxOiBGaXJzdCB0YXNrKiogYGVzdDoxaGBcIixcbiAgICAgIFwiXCIsXG4gICAgXS5qb2luKFwiXFxuXCIpLFxuICApO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAxLVBMQU4ubWRcIiksIFwiIyBUMDEgUGxhblxcblwiKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1TVU1NQVJZLm1kXCIpLCBcIiMgVDAxIFN1bW1hcnlcXG5cXG5Eb25lIG9uIGRpc2suXFxuXCIpO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgIHBhdXNlQXV0bzogYXN5bmMgKCkgPT4geyBwYXVzZUNhbGxzKys7IH0sXG4gICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHsgc3RvcENhbGxzKys7IH0sXG4gICAgaW52YWxpZGF0ZUFsbENhY2hlczogKCkgPT4geyBpbnZhbGlkYXRlQ2FsbHMrKzsgfSxcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+ICh7XG4gICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIiBhcyBjb25zdCxcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgcHJvbXB0OiBcImV4ZWN1dGUgdGhlIHRhc2tcIixcbiAgICAgIG1hdGNoZWRSdWxlOiBcImV4ZWN1dGluZyBcdTIxOTIgZXhlY3V0ZS10YXNrXCIsXG4gICAgfSksXG4gIH0pO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzLCB7XG4gICAgczoge1xuICAgICAgLi4ubWFrZVNlc3Npb24oKSxcbiAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgb3JpZ2luYWxCYXNlUGF0aDogYmFzZSxcbiAgICB9IGFzIGFueSxcbiAgfSk7XG4gIGNvbnN0IHByZURhdGE6IFByZURpc3BhdGNoRGF0YSA9IHtcbiAgICBzdGF0ZToge1xuICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlXCIgfSxcbiAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkZpcnN0IHRhc2tcIiB9LFxuICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgYmxvY2tlcnM6IFtdLFxuICAgIH0gYXMgYW55LFxuICAgIG1pZDogXCJNMDAxXCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgfTtcbiAgY29uc3QgbG9vcFN0YXRlOiBMb29wU3RhdGUgPSB7XG4gICAgcmVjZW50VW5pdHM6IFtcbiAgICAgIHsga2V5OiBcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIiB9LFxuICAgICAgeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH0sXG4gICAgXSxcbiAgICBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsXG4gICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKGljLCBwcmVEYXRhLCBsb29wU3RhdGUpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImJyZWFrXCIpO1xuICBhc3NlcnQuZXF1YWwoKHJlc3VsdCBhcyBhbnkpLnJlYXNvbiwgXCJleGVjdXRlLXRhc2stYXJ0aWZhY3QtZGItbWlzbWF0Y2hcIik7XG4gIGFzc2VydC5lcXVhbChwYXVzZUNhbGxzLCAxLCBcImV4ZWN1dGUtdGFzayBkaXNrL2RiIG1pc21hdGNoIHNob3VsZCBwYXVzZSBhdXRvLW1vZGVcIik7XG4gIGFzc2VydC5lcXVhbChzdG9wQ2FsbHMsIDAsIFwiZXhlY3V0ZS10YXNrIGRpc2svZGIgbWlzbWF0Y2ggc2hvdWxkIG5vdCBoYXJkLXN0b3AgdGhlIGxvb3BcIik7XG4gIGFzc2VydC5lcXVhbChpbnZhbGlkYXRlQ2FsbHMsIDAsIFwibWlzbWF0Y2ggc2hvdWxkIG5vdCBjbGVhciBjYWNoZXMgYW5kIGNvbnRpbnVlIHRvd2FyZCByZWRpc3BhdGNoXCIpO1xuICBhc3NlcnQuZXF1YWwobG9vcFN0YXRlLnJlY2VudFVuaXRzLmxlbmd0aCwgMywgXCJtaXNtYXRjaCBzaG91bGQga2VlcCB0aGUgc3R1Y2sgd2luZG93IGludGFjdFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGxvb3BTdGF0ZS5zdHVja1JlY292ZXJ5QXR0ZW1wdHMsIDEsIFwibWlzbWF0Y2ggc2hvdWxkIG5vdCByZXNldCB0aGUgcmVjb3ZlcnkgY291bnRlclwiKTtcbn0pO1xuXG50ZXN0KFwicnVuRGlzcGF0Y2ggcGF1c2VzIGF0IExldmVsIDIgd2hlbiBleGVjdXRlLXRhc2sgYXJ0aWZhY3RzIGV4aXN0IGJ1dCBEQiBzdGF0dXMgaXMgc3RpbGwgb3BlblwiLCBhc3luYyAodCkgPT4ge1xuICBjb25zdCBjYXB0dXJlID0gY3JlYXRlRXZlbnRDYXB0dXJlKCk7XG4gIGxldCBwYXVzZUNhbGxzID0gMDtcbiAgbGV0IHN0b3BDYWxscyA9IDA7XG4gIGxldCBpbnZhbGlkYXRlQ2FsbHMgPSAwO1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC1zdHVjay1leGVjdXRlLXRhc2stbDItJHtyYW5kb21VVUlEKCl9YCk7XG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBjb25zdCBzbGljZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZURpciwgXCJ0YXNrc1wiKTtcbiAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTbGljZVwiLCBzdGF0dXM6IFwiaW5fcHJvZ3Jlc3NcIiB9KTtcbiAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkZpcnN0IHRhc2tcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHNsaWNlRGlyLCBcIlMwMS1QTEFOLm1kXCIpLFxuICAgIFwiIyBTMDFcXG5cXG4jIyBUYXNrc1xcblxcbi0gW3hdICoqVDAxOiBGaXJzdCB0YXNrKiogYGVzdDoxaGBcXG5cIixcbiAgKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1QTEFOLm1kXCIpLCBcIiMgVDAxIFBsYW5cXG5cIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtU1VNTUFSWS5tZFwiKSwgXCIjIFQwMSBTdW1tYXJ5XFxuXFxuRG9uZSBvbiBkaXNrLlxcblwiKTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUsIHtcbiAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHsgcGF1c2VDYWxscysrOyB9LFxuICAgIHN0b3BBdXRvOiBhc3luYyAoKSA9PiB7IHN0b3BDYWxscysrOyB9LFxuICAgIGludmFsaWRhdGVBbGxDYWNoZXM6ICgpID0+IHsgaW52YWxpZGF0ZUNhbGxzKys7IH0sXG4gICAgcmVzb2x2ZURpc3BhdGNoOiBhc3luYyAoKSA9PiAoe1xuICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHByb21wdDogXCJleGVjdXRlIHRoZSB0YXNrXCIsXG4gICAgICBtYXRjaGVkUnVsZTogXCJleGVjdXRpbmcgZXhlY3V0ZS10YXNrXCIsXG4gICAgfSksXG4gIH0pO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzLCB7XG4gICAgczoge1xuICAgICAgLi4ubWFrZVNlc3Npb24oKSxcbiAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgb3JpZ2luYWxCYXNlUGF0aDogYmFzZSxcbiAgICB9IGFzIGFueSxcbiAgfSk7XG4gIGNvbnN0IHByZURhdGE6IFByZURpc3BhdGNoRGF0YSA9IHtcbiAgICBzdGF0ZToge1xuICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlXCIgfSxcbiAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkZpcnN0IHRhc2tcIiB9LFxuICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgYmxvY2tlcnM6IFtdLFxuICAgIH0gYXMgYW55LFxuICAgIG1pZDogXCJNMDAxXCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgfTtcbiAgY29uc3QgbG9vcFN0YXRlOiBMb29wU3RhdGUgPSB7XG4gICAgcmVjZW50VW5pdHM6IFtcbiAgICAgIHsga2V5OiBcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIiB9LFxuICAgICAgeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH0sXG4gICAgXSxcbiAgICBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDEsXG4gICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKGljLCBwcmVEYXRhLCBsb29wU3RhdGUpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImJyZWFrXCIpO1xuICBhc3NlcnQuZXF1YWwoKHJlc3VsdCBhcyBhbnkpLnJlYXNvbiwgXCJleGVjdXRlLXRhc2stYXJ0aWZhY3QtZGItbWlzbWF0Y2hcIik7XG4gIGFzc2VydC5lcXVhbChwYXVzZUNhbGxzLCAxLCBcIkxldmVsIDIgZXhlY3V0ZS10YXNrIGRpc2svZGIgbWlzbWF0Y2ggc2hvdWxkIHBhdXNlIGF1dG8tbW9kZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHN0b3BDYWxscywgMCwgXCJMZXZlbCAyIGV4ZWN1dGUtdGFzayBkaXNrL2RiIG1pc21hdGNoIHNob3VsZCBub3QgaGFyZC1zdG9wIHRoZSBsb29wXCIpO1xuICBhc3NlcnQuZXF1YWwoaW52YWxpZGF0ZUNhbGxzLCAxLCBcIkxldmVsIDIgc2hvdWxkIGludmFsaWRhdGUgY2FjaGVzIGJlZm9yZSB0aGUgZmluYWwgYXJ0aWZhY3QgcmVjaGVja1wiKTtcbiAgYXNzZXJ0LmVxdWFsKGxvb3BTdGF0ZS5yZWNlbnRVbml0cy5sZW5ndGgsIDMsIFwiTGV2ZWwgMiBtaXNtYXRjaCBzaG91bGQga2VlcCB0aGUgc3R1Y2sgd2luZG93IGludGFjdFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGxvb3BTdGF0ZS5zdHVja1JlY292ZXJ5QXR0ZW1wdHMsIDEsIFwiTGV2ZWwgMiBtaXNtYXRjaCBzaG91bGQgbm90IHJlc2V0IHRoZSByZWNvdmVyeSBjb3VudGVyXCIpO1xufSk7XG5cbnRlc3QoXCJydW5EaXNwYXRjaCBjbGVhcnMgZXhlY3V0ZS10YXNrIHN0dWNrIHN0YXRlIHdoZW4gYXJ0aWZhY3RzIGFuZCBEQiBzdGF0dXMgYXJlIGNvbXBsZXRlXCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGNhcHR1cmUgPSBjcmVhdGVFdmVudENhcHR1cmUoKTtcbiAgbGV0IHBhdXNlQ2FsbHMgPSAwO1xuICBsZXQgc3RvcENhbGxzID0gMDtcbiAgbGV0IGludmFsaWRhdGVDYWxscyA9IDA7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXN0dWNrLWV4ZWN1dGUtdGFzay1jb21wbGV0ZS0ke3JhbmRvbVVVSUQoKX1gKTtcbiAgdC5hZnRlcigoKSA9PiB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0pO1xuXG4gIGNvbnN0IHNsaWNlRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiLCBcInNsaWNlc1wiLCBcIlMwMVwiKTtcbiAgY29uc3QgdGFza3NEaXIgPSBqb2luKHNsaWNlRGlyLCBcInRhc2tzXCIpO1xuICBta2RpclN5bmModGFza3NEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJnc2QuZGJcIikpO1xuICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICBpbnNlcnRTbGljZSh7IGlkOiBcIlMwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIlNsaWNlXCIsIHN0YXR1czogXCJpbl9wcm9ncmVzc1wiIH0pO1xuICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgdGl0bGU6IFwiRmlyc3QgdGFza1wiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9KTtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKHNsaWNlRGlyLCBcIlMwMS1QTEFOLm1kXCIpLFxuICAgIFwiIyBTMDFcXG5cXG4jIyBUYXNrc1xcblxcbi0gW3hdICoqVDAxOiBGaXJzdCB0YXNrKiogYGVzdDoxaGBcXG5cIixcbiAgKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHRhc2tzRGlyLCBcIlQwMS1QTEFOLm1kXCIpLCBcIiMgVDAxIFBsYW5cXG5cIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtU1VNTUFSWS5tZFwiKSwgXCIjIFQwMSBTdW1tYXJ5XFxuXFxuRG9uZSBvbiBkaXNrLlxcblwiKTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUsIHtcbiAgICBwYXVzZUF1dG86IGFzeW5jICgpID0+IHsgcGF1c2VDYWxscysrOyB9LFxuICAgIHN0b3BBdXRvOiBhc3luYyAoKSA9PiB7IHN0b3BDYWxscysrOyB9LFxuICAgIGludmFsaWRhdGVBbGxDYWNoZXM6ICgpID0+IHsgaW52YWxpZGF0ZUNhbGxzKys7IH0sXG4gICAgcmVzb2x2ZURpc3BhdGNoOiBhc3luYyAoKSA9PiAoe1xuICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHByb21wdDogXCJleGVjdXRlIHRoZSB0YXNrXCIsXG4gICAgICBtYXRjaGVkUnVsZTogXCJleGVjdXRpbmcgZXhlY3V0ZS10YXNrXCIsXG4gICAgfSksXG4gIH0pO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzLCB7XG4gICAgczoge1xuICAgICAgLi4ubWFrZVNlc3Npb24oKSxcbiAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgb3JpZ2luYWxCYXNlUGF0aDogYmFzZSxcbiAgICB9IGFzIGFueSxcbiAgfSk7XG4gIGNvbnN0IHByZURhdGE6IFByZURpc3BhdGNoRGF0YSA9IHtcbiAgICBzdGF0ZToge1xuICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIsIHRpdGxlOiBcIlNsaWNlXCIgfSxcbiAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIsIHRpdGxlOiBcIkZpcnN0IHRhc2tcIiB9LFxuICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgYmxvY2tlcnM6IFtdLFxuICAgIH0gYXMgYW55LFxuICAgIG1pZDogXCJNMDAxXCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgfTtcbiAgY29uc3QgbG9vcFN0YXRlOiBMb29wU3RhdGUgPSB7XG4gICAgcmVjZW50VW5pdHM6IFtcbiAgICAgIHsga2V5OiBcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIiB9LFxuICAgICAgeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH0sXG4gICAgXSxcbiAgICBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsXG4gICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKGljLCBwcmVEYXRhLCBsb29wU3RhdGUpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImNvbnRpbnVlXCIpO1xuICBhc3NlcnQuZXF1YWwocGF1c2VDYWxscywgMCwgXCJjbG9zZWQgREIgdGFzayBzaG91bGQgbm90IHBhdXNlIGF1dG8tbW9kZVwiKTtcbiAgYXNzZXJ0LmVxdWFsKHN0b3BDYWxscywgMCwgXCJjbG9zZWQgREIgdGFzayBzaG91bGQgbm90IGhhcmQtc3RvcCB0aGUgbG9vcFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGludmFsaWRhdGVDYWxscywgMSwgXCJjbG9zZWQgREIgdGFzayByZWNvdmVyeSBzaG91bGQgaW52YWxpZGF0ZSBjYWNoZXMgb25jZVwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChsb29wU3RhdGUucmVjZW50VW5pdHMsIFtdLCBcImNsb3NlZCBEQiB0YXNrIHJlY292ZXJ5IHNob3VsZCBjbGVhciB0aGUgc3R1Y2sgd2luZG93XCIpO1xuICBhc3NlcnQuZXF1YWwobG9vcFN0YXRlLnN0dWNrUmVjb3ZlcnlBdHRlbXB0cywgMCwgXCJjbG9zZWQgREIgdGFzayByZWNvdmVyeSBzaG91bGQgcmVzZXQgdGhlIHJlY292ZXJ5IGNvdW50ZXJcIik7XG59KTtcblxudGVzdChcInJ1bkRpc3BhdGNoIGNsZWFycyBzdHVjayBzdGF0ZSBhZnRlciBMZXZlbCAxIGFydGlmYWN0IHJlY292ZXJ5XCIsIGFzeW5jICh0KSA9PiB7XG4gIGNvbnN0IGNhcHR1cmUgPSBjcmVhdGVFdmVudENhcHR1cmUoKTtcbiAgbGV0IGludmFsaWRhdGVDYWxscyA9IDA7XG4gIGxldCBzdG9wQ2FsbHMgPSAwO1xuICBjb25zdCBiYXNlID0gam9pbih0bXBkaXIoKSwgYGdzZC1zdHVjay1wbGFuLSR7cmFuZG9tVVVJRCgpfWApO1xuICB0LmFmdGVyKCgpID0+IHtcbiAgICBjbG9zZURhdGFiYXNlKCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG5cbiAgY29uc3Qgc2xpY2VEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIpO1xuICBjb25zdCB0YXNrc0RpciA9IGpvaW4oc2xpY2VEaXIsIFwidGFza3NcIik7XG4gIG1rZGlyU3luYyh0YXNrc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG9wZW5EYXRhYmFzZShqb2luKGJhc2UsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIGluc2VydE1pbGVzdG9uZSh7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSk7XG4gIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiU2xpY2VcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9KTtcbiAgaW5zZXJ0VGFzayh7IGlkOiBcIlQwMVwiLCBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHNsaWNlSWQ6IFwiUzAxXCIsIHRpdGxlOiBcIkZpcnN0IHRhc2tcIiwgc3RhdHVzOiBcInBlbmRpbmdcIiB9KTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKHNsaWNlRGlyLCBcIlMwMS1QTEFOLm1kXCIpLCBcIiMgUzAxXFxuXFxuIyMgVGFza3NcXG5cXG4tIFsgXSAqKlQwMTogRmlyc3QgdGFzayoqIGBlc3Q6MWhgXFxuXCIpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4odGFza3NEaXIsIFwiVDAxLVBMQU4ubWRcIiksIFwiIyBUMDEgUGxhblxcblwiKTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUsIHtcbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzOiAoKSA9PiB7IGludmFsaWRhdGVDYWxscysrOyB9LFxuICAgIHN0b3BBdXRvOiBhc3luYyAoKSA9PiB7IHN0b3BDYWxscysrOyB9LFxuICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4gKHtcbiAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiIGFzIGNvbnN0LFxuICAgICAgdW5pdFR5cGU6IFwicGxhbi1zbGljZVwiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxXCIsXG4gICAgICBwcm9tcHQ6IFwicGxhbiB0aGUgc2xpY2VcIixcbiAgICAgIG1hdGNoZWRSdWxlOiBcInBsYW5uaW5nIFx1MjE5MiBwbGFuLXNsaWNlXCIsXG4gICAgfSksXG4gIH0pO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzLCB7XG4gICAgczoge1xuICAgICAgLi4ubWFrZVNlc3Npb24oKSxcbiAgICAgIGJhc2VQYXRoOiBiYXNlLFxuICAgICAgb3JpZ2luYWxCYXNlUGF0aDogYmFzZSxcbiAgICB9IGFzIGFueSxcbiAgfSk7XG4gIGNvbnN0IHByZURhdGE6IFByZURpc3BhdGNoRGF0YSA9IHtcbiAgICBzdGF0ZToge1xuICAgICAgcGhhc2U6IFwicGxhbm5pbmdcIixcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiwgdGl0bGU6IFwiU2xpY2VcIiB9LFxuICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgYmxvY2tlcnM6IFtdLFxuICAgIH0gYXMgYW55LFxuICAgIG1pZDogXCJNMDAxXCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgfTtcbiAgY29uc3QgbG9vcFN0YXRlOiBMb29wU3RhdGUgPSB7XG4gICAgcmVjZW50VW5pdHM6IFtcbiAgICAgIHsga2V5OiBcInBsYW4tc2xpY2UvTTAwMS9TMDFcIiB9LFxuICAgICAgeyBrZXk6IFwicGxhbi1zbGljZS9NMDAxL1MwMVwiIH0sXG4gICAgXSxcbiAgICBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsXG4gICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICB9O1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKGljLCBwcmVEYXRhLCBsb29wU3RhdGUpO1xuXG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImNvbnRpbnVlXCIpO1xuICBhc3NlcnQuZXF1YWwoaW52YWxpZGF0ZUNhbGxzLCAxLCBcIkxldmVsIDEgYXJ0aWZhY3QgcmVjb3Zlcnkgc2hvdWxkIGludmFsaWRhdGUgY2FjaGVzXCIpO1xuICBhc3NlcnQuZXF1YWwoc3RvcENhbGxzLCAwLCBcIkxldmVsIDEgYXJ0aWZhY3QgcmVjb3Zlcnkgc2hvdWxkIG5vdCBoYXJkLXN0b3BcIik7XG4gIGFzc2VydC5kZWVwRXF1YWwobG9vcFN0YXRlLnJlY2VudFVuaXRzLCBbXSwgXCJMZXZlbCAxIGFydGlmYWN0IHJlY292ZXJ5IHNob3VsZCBjbGVhciB0aGUgc3R1Y2sgd2luZG93XCIpO1xuICBhc3NlcnQuZXF1YWwobG9vcFN0YXRlLnN0dWNrUmVjb3ZlcnlBdHRlbXB0cywgMCwgXCJMZXZlbCAxIGFydGlmYWN0IHJlY292ZXJ5IHNob3VsZCByZXNldCB0aGUgcmVjb3ZlcnkgY291bnRlclwiKTtcbn0pO1xuXG50ZXN0KFwicnVuRGlzcGF0Y2ggZXNjYXBlcyBMZXZlbCAyIHN0dWNrIHN0b3Agd2hlbiBhcnRpZmFjdCB2ZXJpZmllcyBhZnRlciBjYWNoZSBpbnZhbGlkYXRpb25cIiwgYXN5bmMgKHQpID0+IHtcbiAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICBsZXQgaW52YWxpZGF0ZUNhbGxzID0gMDtcbiAgbGV0IHN0b3BDYWxscyA9IDA7XG4gIGNvbnN0IGJhc2UgPSBqb2luKHRtcGRpcigpLCBgZ3NkLXN0dWNrLXBsYW4tbDItJHtyYW5kb21VVUlEKCl9YCk7XG4gIHQuYWZ0ZXIoKCkgPT4ge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBjb25zdCBzbGljZURpciA9IGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJzbGljZXNcIiwgXCJTMDFcIik7XG4gIGNvbnN0IHRhc2tzRGlyID0gam9pbihzbGljZURpciwgXCJ0YXNrc1wiKTtcbiAgbWtkaXJTeW5jKHRhc2tzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZSwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgaW5zZXJ0TWlsZXN0b25lKHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUZXN0XCIsIHN0YXR1czogXCJhY3RpdmVcIiB9KTtcbiAgaW5zZXJ0U2xpY2UoeyBpZDogXCJTMDFcIiwgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJTbGljZVwiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuICBpbnNlcnRUYXNrKHsgaWQ6IFwiVDAxXCIsIG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc2xpY2VJZDogXCJTMDFcIiwgdGl0bGU6IFwiRmlyc3QgdGFza1wiLCBzdGF0dXM6IFwicGVuZGluZ1wiIH0pO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4oc2xpY2VEaXIsIFwiUzAxLVBMQU4ubWRcIiksIFwiIyBTMDFcXG5cXG4jIyBUYXNrc1xcblxcbi0gWyBdICoqVDAxOiBGaXJzdCB0YXNrKiogYGVzdDoxaGBcXG5cIik7XG4gIHdyaXRlRmlsZVN5bmMoam9pbih0YXNrc0RpciwgXCJUMDEtUExBTi5tZFwiKSwgXCIjIFQwMSBQbGFuXFxuXCIpO1xuXG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgIGludmFsaWRhdGVBbGxDYWNoZXM6ICgpID0+IHsgaW52YWxpZGF0ZUNhbGxzKys7IH0sXG4gICAgc3RvcEF1dG86IGFzeW5jICgpID0+IHsgc3RvcENhbGxzKys7IH0sXG4gICAgcmVzb2x2ZURpc3BhdGNoOiBhc3luYyAoKSA9PiAoe1xuICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICB1bml0VHlwZTogXCJwbGFuLXNsaWNlXCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMS9TMDFcIixcbiAgICAgIHByb21wdDogXCJwbGFuIHRoZSBzbGljZVwiLFxuICAgICAgbWF0Y2hlZFJ1bGU6IFwicGxhbm5pbmcgXHUyMTkyIHBsYW4tc2xpY2VcIixcbiAgICB9KSxcbiAgfSk7XG4gIGNvbnN0IGljID0gbWFrZUlDKGRlcHMsIHtcbiAgICBzOiB7XG4gICAgICAuLi5tYWtlU2Vzc2lvbigpLFxuICAgICAgYmFzZVBhdGg6IGJhc2UsXG4gICAgICBvcmlnaW5hbEJhc2VQYXRoOiBiYXNlLFxuICAgIH0gYXMgYW55LFxuICB9KTtcbiAgY29uc3QgcHJlRGF0YTogUHJlRGlzcGF0Y2hEYXRhID0ge1xuICAgIHN0YXRlOiB7XG4gICAgICBwaGFzZTogXCJwbGFubmluZ1wiLFxuICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZVwiIH0sXG4gICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgfSBhcyBhbnksXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0IE1pbGVzdG9uZVwiLFxuICB9O1xuICBjb25zdCBsb29wU3RhdGU6IExvb3BTdGF0ZSA9IHtcbiAgICByZWNlbnRVbml0czogW1xuICAgICAgeyBrZXk6IFwicGxhbi1zbGljZS9NMDAxL1MwMVwiIH0sXG4gICAgICB7IGtleTogXCJwbGFuLXNsaWNlL00wMDEvUzAxXCIgfSxcbiAgICBdLFxuICAgIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMSxcbiAgICBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAsXG4gIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRGlzcGF0Y2goaWMsIHByZURhdGEsIGxvb3BTdGF0ZSk7XG5cbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiY29udGludWVcIik7XG4gIGFzc2VydC5lcXVhbChpbnZhbGlkYXRlQ2FsbHMsIDEsIFwiTGV2ZWwgMiBlc2NhcGUgc2hvdWxkIGludmFsaWRhdGUgY2FjaGVzIGJlZm9yZSByZWNoZWNraW5nIGFydGlmYWN0c1wiKTtcbiAgYXNzZXJ0LmVxdWFsKHN0b3BDYWxscywgMCwgXCJ2ZXJpZmllZCBhcnRpZmFjdHMgc2hvdWxkIGVzY2FwZSBMZXZlbCAyIGhhcmQgc3RvcFwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbChsb29wU3RhdGUucmVjZW50VW5pdHMsIFtdLCBcIkxldmVsIDIgYXJ0aWZhY3QgZXNjYXBlIHNob3VsZCBjbGVhciB0aGUgc3R1Y2sgd2luZG93XCIpO1xuICBhc3NlcnQuZXF1YWwobG9vcFN0YXRlLnN0dWNrUmVjb3ZlcnlBdHRlbXB0cywgMCwgXCJMZXZlbCAyIGFydGlmYWN0IGVzY2FwZSBzaG91bGQgcmVzZXQgdGhlIHJlY292ZXJ5IGNvdW50ZXJcIik7XG59KTtcblxudGVzdChcInJ1blVuaXRQaGFzZSBlbWl0cyB1bml0LXN0YXJ0IGFuZCB1bml0LWVuZCB3aXRoIGNhdXNlZEJ5IHJlZmVyZW5jZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNhcHR1cmUgPSBjcmVhdGVFdmVudENhcHR1cmUoKTtcblxuICAvLyBXZSBuZWVkIHJ1blVuaXQgdG8gcmV0dXJuIGltbWVkaWF0ZWx5IFx1MjAxNCBtb2NrIGl0IGJ5IHByb3ZpZGluZyBhIHNlc3Npb25cbiAgLy8gd2hvc2UgY21kQ3R4Lm5ld1Nlc3Npb24gcmVzb2x2ZXMgaW1tZWRpYXRlbHkgYW5kIHRoZSByZXN1bHQgaXMgY29tcGxldGVkLlxuICAvLyBBY3R1YWxseSwgcnVuVW5pdFBoYXNlIGNhbGxzIHRoZSByZWFsIHJ1blVuaXQgd2hpY2ggY3JlYXRlcyBhIHBlbmRpbmdcbiAgLy8gcHJvbWlzZSBhbmQgYmxvY2tzLiBXZSBuZWVkIGEgZGlmZmVyZW50IGFwcHJvYWNoLlxuICAvL1xuICAvLyBJbnN0ZWFkLCB3ZSB0ZXN0IHRoYXQgdW5pdC1zdGFydCBpcyBlbWl0dGVkIGF0IHRoZSByaWdodCBwb2ludCBieSBleGFtaW5pbmdcbiAgLy8gdGhlIGV2ZW50IGltbWVkaWF0ZWx5IGFmdGVyIGNhbGxpbmcgcnVuVW5pdFBoYXNlIHdpdGggYSBzZXNzaW9uIHdoZXJlXG4gIC8vIG5ld1Nlc3Npb24gcmVzb2x2ZXMgcXVpY2tseSwgYW5kIHdlIHJlc29sdmUgdGhlIGFnZW50X2VuZCBleHRlcm5hbGx5LlxuICBjb25zdCB7IHJlc29sdmVBZ2VudEVuZCwgX3Jlc2V0UGVuZGluZ1Jlc29sdmUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8vcmVzb2x2ZS5qc1wiKTtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUpO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzKTtcbiAgY29uc3QgaXRlckRhdGE6IEl0ZXJhdGlvbkRhdGEgPSB7XG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHByb21wdDogXCJkbyBzdHVmZlwiLFxuICAgIGZpbmFsUHJvbXB0OiBcImRvIHN0dWZmXCIsXG4gICAgcGF1c2VBZnRlclVhdERpc3BhdGNoOiBmYWxzZSxcbiAgICBzdGF0ZTogeyBwaGFzZTogXCJleGVjdXRpbmdcIiwgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiB9LCBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiB9LCByZWdpc3RyeTogW10sIGJsb2NrZXJzOiBbXSB9IGFzIGFueSxcbiAgICBtaWQ6IFwiTTAwMVwiLFxuICAgIG1pZFRpdGxlOiBcIlRlc3RcIixcbiAgICBpc1JldHJ5OiBmYWxzZSxcbiAgICBwcmV2aW91c1RpZXI6IHVuZGVmaW5lZCxcbiAgfTtcbiAgY29uc3QgbG9vcFN0YXRlOiBMb29wU3RhdGUgPSB7IHJlY2VudFVuaXRzOiBbeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH1dLCBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCB9O1xuXG4gIC8vIFN0YXJ0IHJ1blVuaXRQaGFzZSAoaXQgd2lsbCBibG9jayBvbiBydW5Vbml0IGludGVybmFsbHkpXG4gIGNvbnN0IHVuaXRQcm9taXNlID0gcnVuVW5pdFBoYXNlKGljLCBpdGVyRGF0YSwgbG9vcFN0YXRlKTtcblxuICAvLyBHaXZlIGl0IHRpbWUgdG8gcmVhY2ggdGhlIGF3YWl0IGluc2lkZSBydW5Vbml0XG4gIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuXG4gIC8vIFJlc29sdmUgdGhlIGFnZW50X2VuZFxuICByZXNvbHZlQWdlbnRFbmQoeyBtZXNzYWdlczogW3sgcm9sZTogXCJhc3Npc3RhbnRcIiB9XSB9KTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCB1bml0UHJvbWlzZTtcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwibmV4dFwiKTtcblxuICAvLyBDaGVjayB1bml0LXN0YXJ0XG4gIGNvbnN0IHN0YXJ0RXZlbnRzID0gY2FwdHVyZS5ldmVudHMuZmlsdGVyKGUgPT4gZS5ldmVudFR5cGUgPT09IFwidW5pdC1zdGFydFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHN0YXJ0RXZlbnRzLmxlbmd0aCwgMSwgXCJzaG91bGQgZW1pdCBleGFjdGx5IG9uZSB1bml0LXN0YXJ0XCIpO1xuICBhc3NlcnQuZXF1YWwoc3RhcnRFdmVudHNbMF0uZmxvd0lkLCBpYy5mbG93SWQpO1xuICBhc3NlcnQuZXF1YWwoKHN0YXJ0RXZlbnRzWzBdLmRhdGEgYXMgYW55KS51bml0VHlwZSwgXCJleGVjdXRlLXRhc2tcIik7XG4gIGFzc2VydC5lcXVhbCgoc3RhcnRFdmVudHNbMF0uZGF0YSBhcyBhbnkpLnVuaXRJZCwgXCJNMDAxL1MwMS9UMDFcIik7XG5cbiAgLy8gQ2hlY2sgdW5pdC1lbmRcbiAgY29uc3QgZW5kRXZlbnRzID0gY2FwdHVyZS5ldmVudHMuZmlsdGVyKGUgPT4gZS5ldmVudFR5cGUgPT09IFwidW5pdC1lbmRcIik7XG4gIGFzc2VydC5lcXVhbChlbmRFdmVudHMubGVuZ3RoLCAxLCBcInNob3VsZCBlbWl0IGV4YWN0bHkgb25lIHVuaXQtZW5kXCIpO1xuICBhc3NlcnQuZXF1YWwoZW5kRXZlbnRzWzBdLmZsb3dJZCwgaWMuZmxvd0lkKTtcbiAgYXNzZXJ0LmVxdWFsKChlbmRFdmVudHNbMF0uZGF0YSBhcyBhbnkpLnVuaXRUeXBlLCBcImV4ZWN1dGUtdGFza1wiKTtcbiAgYXNzZXJ0LmVxdWFsKChlbmRFdmVudHNbMF0uZGF0YSBhcyBhbnkpLnVuaXRJZCwgXCJNMDAxL1MwMS9UMDFcIik7XG4gIGFzc2VydC5lcXVhbCgoZW5kRXZlbnRzWzBdLmRhdGEgYXMgYW55KS5zdGF0dXMsIFwiY29tcGxldGVkXCIpO1xuXG4gIC8vIFZlcmlmeSBjYXVzZWRCeTogdW5pdC1lbmQgcmVmZXJlbmNlcyB1bml0LXN0YXJ0J3Mgc2VxXG4gIGFzc2VydC5vayhlbmRFdmVudHNbMF0uY2F1c2VkQnksIFwidW5pdC1lbmQgbXVzdCBoYXZlIGEgY2F1c2VkQnkgcmVmZXJlbmNlXCIpO1xuICBhc3NlcnQuZXF1YWwoZW5kRXZlbnRzWzBdLmNhdXNlZEJ5IS5mbG93SWQsIGljLmZsb3dJZCk7XG4gIGFzc2VydC5lcXVhbChlbmRFdmVudHNbMF0uY2F1c2VkQnkhLnNlcSwgc3RhcnRFdmVudHNbMF0uc2VxLCBcInVuaXQtZW5kIGNhdXNlZEJ5LnNlcSBtdXN0IG1hdGNoIHVuaXQtc3RhcnQuc2VxXCIpO1xufSk7XG5cbnRlc3QoXCJydW5Vbml0UGhhc2UgaW5jcmVtZW50cyB1bml0RGlzcGF0Y2hDb3VudCBmb3IgcmVwZWF0ZWQgYXJ0aWZhY3QtbWlzc2luZyByZXRyaWVzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICBjb25zdCB7IHJlc29sdmVBZ2VudEVuZCwgX3Jlc2V0UGVuZGluZ1Jlc29sdmUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8vcmVzb2x2ZS5qc1wiKTtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUpO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzKTtcbiAgY29uc3QgaXRlckRhdGE6IEl0ZXJhdGlvbkRhdGEgPSB7XG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHByb21wdDogXCJkbyBzdHVmZlwiLFxuICAgIGZpbmFsUHJvbXB0OiBcImRvIHN0dWZmXCIsXG4gICAgcGF1c2VBZnRlclVhdERpc3BhdGNoOiBmYWxzZSxcbiAgICBzdGF0ZTogeyBwaGFzZTogXCJleGVjdXRpbmdcIiwgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiB9LCBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiB9LCByZWdpc3RyeTogW10sIGJsb2NrZXJzOiBbXSB9IGFzIGFueSxcbiAgICBtaWQ6IFwiTTAwMVwiLFxuICAgIG1pZFRpdGxlOiBcIlRlc3RcIixcbiAgICBpc1JldHJ5OiBmYWxzZSxcbiAgICBwcmV2aW91c1RpZXI6IHVuZGVmaW5lZCxcbiAgfTtcbiAgY29uc3QgbG9vcFN0YXRlOiBMb29wU3RhdGUgPSB7IHJlY2VudFVuaXRzOiBbeyBrZXk6IFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiIH1dLCBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCB9O1xuXG4gIGNvbnN0IGZpcnN0UnVuID0gcnVuVW5pdFBoYXNlKGljLCBpdGVyRGF0YSwgbG9vcFN0YXRlKTtcbiAgYXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gIHJlc29sdmVBZ2VudEVuZCh7IG1lc3NhZ2VzOiBbeyByb2xlOiBcImFzc2lzdGFudFwiIH1dIH0pO1xuICBhd2FpdCBmaXJzdFJ1bjtcbiAgYXNzZXJ0LmVxdWFsKGljLnMudW5pdERpc3BhdGNoQ291bnQuZ2V0KFwiZXhlY3V0ZS10YXNrL00wMDEvUzAxL1QwMVwiKSwgMSk7XG5cbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcbiAgY29uc3Qgc2Vjb25kUnVuID0gcnVuVW5pdFBoYXNlKGljLCBpdGVyRGF0YSwgbG9vcFN0YXRlKTtcbiAgYXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gIHJlc29sdmVBZ2VudEVuZCh7IG1lc3NhZ2VzOiBbeyByb2xlOiBcImFzc2lzdGFudFwiIH1dIH0pO1xuICBhd2FpdCBzZWNvbmRSdW47XG4gIGFzc2VydC5lcXVhbChpYy5zLnVuaXREaXNwYXRjaENvdW50LmdldChcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIiksIDIpO1xufSk7XG5cbnRlc3QoXCJhbGwgZXZlbnRzIGZyb20gYSBtb2NrIGl0ZXJhdGlvbiBoYXZlIG1vbm90b25pY2FsbHkgaW5jcmVhc2luZyBzZXEgYW5kIHNhbWUgZmxvd0lkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICBjb25zdCB7IHJlc29sdmVBZ2VudEVuZCwgX3Jlc2V0UGVuZGluZ1Jlc29sdmUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8vcmVzb2x2ZS5qc1wiKTtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUsIHtcbiAgICByZXNvbHZlRGlzcGF0Y2g6IGFzeW5jICgpID0+ICh7XG4gICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIiBhcyBjb25zdCxcbiAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgICAgcHJvbXB0OiBcImRvIHRoZSB0aGluZ1wiLFxuICAgICAgbWF0Y2hlZFJ1bGU6IFwibXktcnVsZVwiLFxuICAgIH0pLFxuICB9KTtcbiAgY29uc3QgaWMgPSBtYWtlSUMoZGVwcyk7XG5cbiAgLy8gUGhhc2UgMTogRGlzcGF0Y2hcbiAgY29uc3QgcHJlRGF0YTogUHJlRGlzcGF0Y2hEYXRhID0ge1xuICAgIHN0YXRlOiB7IHBoYXNlOiBcImV4ZWN1dGluZ1wiLCBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LCBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiB9LCBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSwgYmxvY2tlcnM6IFtdIH0gYXMgYW55LFxuICAgIG1pZDogXCJNMDAxXCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdFwiLFxuICB9O1xuICBjb25zdCBsb29wU3RhdGU6IExvb3BTdGF0ZSA9IHsgcmVjZW50VW5pdHM6IFtdLCBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCB9O1xuICBjb25zdCBkaXNwYXRjaFJlc3VsdCA9IGF3YWl0IHJ1bkRpc3BhdGNoKGljLCBwcmVEYXRhLCBsb29wU3RhdGUpO1xuICBhc3NlcnQuZXF1YWwoZGlzcGF0Y2hSZXN1bHQuYWN0aW9uLCBcIm5leHRcIik7XG5cbiAgLy8gUGhhc2UgMjogVW5pdCBleGVjdXRpb25cbiAgY29uc3QgaXRlckRhdGEgPSAoZGlzcGF0Y2hSZXN1bHQgYXMgeyBhY3Rpb246IFwibmV4dFwiOyBkYXRhOiBJdGVyYXRpb25EYXRhIH0pLmRhdGE7XG4gIGNvbnN0IHVuaXRQcm9taXNlID0gcnVuVW5pdFBoYXNlKGljLCBpdGVyRGF0YSwgbG9vcFN0YXRlKTtcbiAgYXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gIHJlc29sdmVBZ2VudEVuZCh7IG1lc3NhZ2VzOiBbeyByb2xlOiBcImFzc2lzdGFudFwiIH1dIH0pO1xuICBhd2FpdCB1bml0UHJvbWlzZTtcblxuICAvLyBWZXJpZnkgYWxsIGV2ZW50cyBzaGFyZSB0aGUgc2FtZSBmbG93SWRcbiAgYXNzZXJ0Lm9rKGNhcHR1cmUuZXZlbnRzLmxlbmd0aCA+PSAzLCBgZXhwZWN0ZWQgYXQgbGVhc3QgMyBldmVudHMgKGRpc3BhdGNoLW1hdGNoLCB1bml0LXN0YXJ0LCB1bml0LWVuZCksIGdvdCAke2NhcHR1cmUuZXZlbnRzLmxlbmd0aH1gKTtcbiAgY29uc3QgZmxvd0lkID0gaWMuZmxvd0lkO1xuICBmb3IgKGNvbnN0IGV2IG9mIGNhcHR1cmUuZXZlbnRzKSB7XG4gICAgYXNzZXJ0LmVxdWFsKGV2LmZsb3dJZCwgZmxvd0lkLCBgYWxsIGV2ZW50cyBtdXN0IHNoYXJlIGZsb3dJZD0ke2Zsb3dJZH0sIGZvdW5kIGV2ZW50ICR7ZXYuZXZlbnRUeXBlfSB3aXRoIGZsb3dJZD0ke2V2LmZsb3dJZH1gKTtcbiAgfVxuXG4gIC8vIFZlcmlmeSBtb25vdG9uaWNhbGx5IGluY3JlYXNpbmcgc2VxIG51bWJlcnNcbiAgZm9yIChsZXQgaSA9IDE7IGkgPCBjYXB0dXJlLmV2ZW50cy5sZW5ndGg7IGkrKykge1xuICAgIGFzc2VydC5vayhcbiAgICAgIGNhcHR1cmUuZXZlbnRzW2ldLnNlcSA+IGNhcHR1cmUuZXZlbnRzW2kgLSAxXS5zZXEsXG4gICAgICBgc2VxIG11c3QgYmUgbW9ub3RvbmljYWxseSBpbmNyZWFzaW5nOiBldmVudFske2kgLSAxfV0uc2VxPSR7Y2FwdHVyZS5ldmVudHNbaSAtIDFdLnNlcX0gKCR7Y2FwdHVyZS5ldmVudHNbaSAtIDFdLmV2ZW50VHlwZX0pIHNob3VsZCBiZSBsZXNzIHRoYW4gZXZlbnRbJHtpfV0uc2VxPSR7Y2FwdHVyZS5ldmVudHNbaV0uc2VxfSAoJHtjYXB0dXJlLmV2ZW50c1tpXS5ldmVudFR5cGV9KWAsXG4gICAgKTtcbiAgfVxufSk7XG5cbnRlc3QoXCJkaXNwYXRjaC1tYXRjaCBldmVudHMgaW5jbHVkZSBtYXRjaGVkUnVsZSBmaWVsZCBtYXRjaGluZyB0aGUgcnVsZSBuYW1lXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICBjb25zdCBSVUxFX05BTUUgPSBcInByaW9yaXR5LWV4ZWN1dGlvbi1ydWxlXCI7XG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgIHJlc29sdmVEaXNwYXRjaDogYXN5bmMgKCkgPT4gKHtcbiAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiIGFzIGNvbnN0LFxuICAgICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMS9TMDEvVDAxXCIsXG4gICAgICBwcm9tcHQ6IFwidGVzdFwiLFxuICAgICAgbWF0Y2hlZFJ1bGU6IFJVTEVfTkFNRSxcbiAgICB9KSxcbiAgfSk7XG4gIGNvbnN0IGljID0gbWFrZUlDKGRlcHMpO1xuICBjb25zdCBwcmVEYXRhOiBQcmVEaXNwYXRjaERhdGEgPSB7XG4gICAgc3RhdGU6IHsgcGhhc2U6IFwiZXhlY3V0aW5nXCIsIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiIH0sIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIgfSwgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLCBibG9ja2VyczogW10gfSBhcyBhbnksXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gIH07XG5cbiAgYXdhaXQgcnVuRGlzcGF0Y2goaWMsIHByZURhdGEsIHsgcmVjZW50VW5pdHM6IFtdLCBzdHVja1JlY292ZXJ5QXR0ZW1wdHM6IDAsIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCB9KTtcblxuICBjb25zdCBtYXRjaEV2ZW50cyA9IGNhcHR1cmUuZXZlbnRzLmZpbHRlcihlID0+IGUuZXZlbnRUeXBlID09PSBcImRpc3BhdGNoLW1hdGNoXCIpO1xuICBhc3NlcnQuZXF1YWwobWF0Y2hFdmVudHMubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0LmVxdWFsKG1hdGNoRXZlbnRzWzBdLnJ1bGUsIFJVTEVfTkFNRSwgXCJkaXNwYXRjaC1tYXRjaCBldmVudC5ydWxlIG11c3QgZXF1YWwgdGhlIG1hdGNoZWRSdWxlIGZyb20gZGlzcGF0Y2ggcmVzdWx0XCIpO1xufSk7XG5cbnRlc3QoXCJwcmUtZGlzcGF0Y2gtaG9vayBldmVudCBpcyBlbWl0dGVkIHdoZW4gaG9va3MgZmlyZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNhcHR1cmUgPSBjcmVhdGVFdmVudENhcHR1cmUoKTtcbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyhjYXB0dXJlLCB7XG4gICAgcmVzb2x2ZURpc3BhdGNoOiBhc3luYyAoKSA9PiAoe1xuICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIgYXMgY29uc3QsXG4gICAgICB1bml0VHlwZTogXCJleGVjdXRlLXRhc2tcIixcbiAgICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICAgIHByb21wdDogXCJ0ZXN0XCIsXG4gICAgICBtYXRjaGVkUnVsZTogXCJzb21lLXJ1bGVcIixcbiAgICB9KSxcbiAgICBydW5QcmVEaXNwYXRjaEhvb2tzOiAoKSA9PiAoe1xuICAgICAgZmlyZWRIb29rczogW1wib2JzZXJ2YWJpbGl0eS1jaGVja1wiLCBcImxpbnQtZ2F0ZVwiXSxcbiAgICAgIGFjdGlvbjogXCJwcm9jZWVkXCIsXG4gICAgfSksXG4gIH0pO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzKTtcbiAgY29uc3QgcHJlRGF0YTogUHJlRGlzcGF0Y2hEYXRhID0ge1xuICAgIHN0YXRlOiB7IHBoYXNlOiBcImV4ZWN1dGluZ1wiLCBhY3RpdmVNaWxlc3RvbmU6IHsgaWQ6IFwiTTAwMVwiLCB0aXRsZTogXCJUXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LCBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiB9LCBhY3RpdmVUYXNrOiB7IGlkOiBcIlQwMVwiIH0sIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSwgYmxvY2tlcnM6IFtdIH0gYXMgYW55LFxuICAgIG1pZDogXCJNMDAxXCIsXG4gICAgbWlkVGl0bGU6IFwiVGVzdFwiLFxuICB9O1xuXG4gIGF3YWl0IHJ1bkRpc3BhdGNoKGljLCBwcmVEYXRhLCB7IHJlY2VudFVuaXRzOiBbXSwgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLCBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAgfSk7XG5cbiAgY29uc3QgaG9va0V2ZW50cyA9IGNhcHR1cmUuZXZlbnRzLmZpbHRlcihlID0+IGUuZXZlbnRUeXBlID09PSBcInByZS1kaXNwYXRjaC1ob29rXCIpO1xuICBhc3NlcnQuZXF1YWwoaG9va0V2ZW50cy5sZW5ndGgsIDEsIFwic2hvdWxkIGVtaXQgb25lIHByZS1kaXNwYXRjaC1ob29rIGV2ZW50XCIpO1xuICBhc3NlcnQuZGVlcEVxdWFsKChob29rRXZlbnRzWzBdLmRhdGEgYXMgYW55KS5maXJlZEhvb2tzLCBbXCJvYnNlcnZhYmlsaXR5LWNoZWNrXCIsIFwibGludC1nYXRlXCJdKTtcbiAgYXNzZXJ0LmVxdWFsKChob29rRXZlbnRzWzBdLmRhdGEgYXMgYW55KS5hY3Rpb24sIFwicHJvY2VlZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKGhvb2tFdmVudHNbMF0uZmxvd0lkLCBpYy5mbG93SWQpO1xufSk7XG5cbnRlc3QoXCJ0ZXJtaW5hbCBldmVudCBpcyBlbWl0dGVkIG9uIG1pbGVzdG9uZS1jb21wbGV0ZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNhcHR1cmUgPSBjcmVhdGVFdmVudENhcHR1cmUoKTtcbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyhjYXB0dXJlLCB7XG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+ICh7XG4gICAgICBwaGFzZTogXCJjb21wbGV0ZVwiLFxuICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9LFxuICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImNvbXBsZXRlXCIgfV0sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgfSkgYXMgYW55LFxuICB9KTtcbiAgY29uc3QgaWMgPSBtYWtlSUMoZGVwcyk7XG4gIGNvbnN0IGxvb3BTdGF0ZTogTG9vcFN0YXRlID0geyByZWNlbnRVbml0czogW10sIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCwgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRGlzcGF0Y2goaWMsIGxvb3BTdGF0ZSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImJyZWFrXCIpO1xuXG4gIGNvbnN0IHRlcm1pbmFsRXZlbnRzID0gY2FwdHVyZS5ldmVudHMuZmlsdGVyKGUgPT4gZS5ldmVudFR5cGUgPT09IFwidGVybWluYWxcIik7XG4gIGFzc2VydC5lcXVhbCh0ZXJtaW5hbEV2ZW50cy5sZW5ndGgsIDEsIFwic2hvdWxkIGVtaXQgb25lIHRlcm1pbmFsIGV2ZW50XCIpO1xuICBhc3NlcnQuZXF1YWwoKHRlcm1pbmFsRXZlbnRzWzBdLmRhdGEgYXMgYW55KS5yZWFzb24sIFwibWlsZXN0b25lLWNvbXBsZXRlXCIpO1xuICBhc3NlcnQuZXF1YWwodGVybWluYWxFdmVudHNbMF0uZmxvd0lkLCBpYy5mbG93SWQpO1xufSk7XG5cbnRlc3QoXCJ0ZXJtaW5hbCBldmVudCBpcyBlbWl0dGVkIG9uIGJsb2NrZWQgc3RhdGVcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjYXB0dXJlID0gY3JlYXRlRXZlbnRDYXB0dXJlKCk7XG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgIGRlcml2ZVN0YXRlOiBhc3luYyAoKSA9PiAoe1xuICAgICAgcGhhc2U6IFwiYmxvY2tlZFwiLFxuICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgIGJsb2NrZXJzOiBbXCJNaXNzaW5nIEFQSSBrZXlcIl0sXG4gICAgfSkgYXMgYW55LFxuICB9KTtcbiAgY29uc3QgaWMgPSBtYWtlSUMoZGVwcyk7XG4gIGNvbnN0IGxvb3BTdGF0ZTogTG9vcFN0YXRlID0geyByZWNlbnRVbml0czogW10sIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCwgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwIH07XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRGlzcGF0Y2goaWMsIGxvb3BTdGF0ZSk7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImJyZWFrXCIpO1xuXG4gIGNvbnN0IHRlcm1pbmFsRXZlbnRzID0gY2FwdHVyZS5ldmVudHMuZmlsdGVyKGUgPT4gZS5ldmVudFR5cGUgPT09IFwidGVybWluYWxcIik7XG4gIGFzc2VydC5lcXVhbCh0ZXJtaW5hbEV2ZW50cy5sZW5ndGgsIDEpO1xuICBhc3NlcnQuZXF1YWwoKHRlcm1pbmFsRXZlbnRzWzBdLmRhdGEgYXMgYW55KS5yZWFzb24sIFwiYmxvY2tlZFwiKTtcbiAgYXNzZXJ0LmRlZXBFcXVhbCgodGVybWluYWxFdmVudHNbMF0uZGF0YSBhcyBhbnkpLmJsb2NrZXJzLCBbXCJNaXNzaW5nIEFQSSBrZXlcIl0pO1xufSk7XG5cbnRlc3QoXCIjNDY3MTogcGxhbi12MiBtaXNzaW5nIENPTlRFWFQubWQgcmVhY2hlcyBkaXNwYXRjaCByZWNvdmVyeSBpbnN0ZWFkIG9mIHBhdXNpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBiYXNlUGF0aCA9IG1rZHRlbXBTeW5jKGpvaW4odG1wZGlyKCksIFwiZ3NkLTQ2NzEtcHJlZGlzcGF0Y2gtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIiwgXCJNMDAxXCIsIFwic2xpY2VzXCIsIFwiUzAxXCIsIFwidGFza3NcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBvcGVuRGF0YWJhc2Uoam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwiZ3NkLmRiXCIpKTtcbiAgdHJ5IHtcbiAgICBpbnNlcnRNaWxlc3RvbmUoeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0pO1xuICAgIGluc2VydFNsaWNlKHtcbiAgICAgIGlkOiBcIlMwMVwiLFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgdGl0bGU6IFwiU2xpY2UgMVwiLFxuICAgICAgc3RhdHVzOiBcImluX3Byb2dyZXNzXCIsXG4gICAgICBzZXF1ZW5jZTogMSxcbiAgICB9KTtcbiAgICBpbnNlcnRUYXNrKHtcbiAgICAgIGlkOiBcIlQwMVwiLFxuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgc2xpY2VJZDogXCJTMDFcIixcbiAgICAgIHRpdGxlOiBcIlRhc2sgMVwiLFxuICAgICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICAgIGtleUZpbGVzOiBbXCJzcmMvdGFzay50c1wiXSxcbiAgICAgIHNlcXVlbmNlOiAxLFxuICAgIH0pO1xuXG4gICAgbGV0IHBhdXNlQ2FsbHMgPSAwO1xuICAgIGNvbnN0IGNhcHR1cmUgPSBjcmVhdGVFdmVudENhcHR1cmUoKTtcbiAgICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUsIHtcbiAgICAgIHBhdXNlQXV0bzogYXN5bmMgKCkgPT4geyBwYXVzZUNhbGxzKys7IH0sXG4gICAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4gKHtcbiAgICAgICAgcGhhc2U6IFwiZXhlY3V0aW5nXCIsXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgIGFjdGl2ZVNsaWNlOiB7IGlkOiBcIlMwMVwiLCB0aXRsZTogXCJTbGljZSAxXCIgfSxcbiAgICAgICAgYWN0aXZlVGFzazogeyBpZDogXCJUMDFcIiwgdGl0bGU6IFwiVGFzayAxXCIgfSxcbiAgICAgICAgcmVnaXN0cnk6IFt7IGlkOiBcIk0wMDFcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH1dLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICAgIG5leHRBY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgIH0pIGFzIGFueSxcbiAgICB9KTtcbiAgICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzLCB7XG4gICAgICBwcmVmczogeyB1b2s6IHsgcGxhbl92MjogeyBlbmFibGVkOiB0cnVlIH0gfSB9IGFzIGFueSxcbiAgICB9KTtcbiAgICBpYy5zLmJhc2VQYXRoID0gYmFzZVBhdGg7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVEaXNwYXRjaChpYywge1xuICAgICAgcmVjZW50VW5pdHM6IFtdLFxuICAgICAgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLFxuICAgICAgY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzOiAwLFxuICAgIH0pO1xuXG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwibmV4dFwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VDYWxscywgMCwgXCJtaXNzaW5nIENPTlRFWFQubWQgc2hvdWxkIGJlIGhhbmRsZWQgYnkgZGlzcGF0Y2ggcmVjb3ZlcnksIG5vdCBwbGFuIGdhdGUgcGF1c2VcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcInBsYW4tdjIgZW1wdHkgZ3JhcGggcmVkZXJpdmVzIHN0YXRlIGJlZm9yZSBwYXVzaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZVBhdGggPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wbGFuLXYyLWVtcHR5LWdyYXBoLVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLUNPTlRFWFQubWRcIiksXG4gICAgXCIjIE0wMDE6IFRlc3RcXG5cXG5GaW5hbGl6ZWQgY29udGV4dC5cXG5cIixcbiAgKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIHRyeSB7XG4gICAgbGV0IGRlcml2ZUNhbGxzID0gMDtcbiAgICBsZXQgaW52YWxpZGF0ZUNhbGxzID0gMDtcbiAgICBsZXQgcGF1c2VDYWxscyA9IDA7XG4gICAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICAgIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7IHBhdXNlQ2FsbHMrKzsgfSxcbiAgICAgIGludmFsaWRhdGVBbGxDYWNoZXM6ICgpID0+IHsgaW52YWxpZGF0ZUNhbGxzKys7IH0sXG4gICAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4ge1xuICAgICAgICBkZXJpdmVDYWxscysrO1xuICAgICAgICBpZiAoZGVyaXZlQ2FsbHMgPT09IDEpIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgcGhhc2U6IFwidmFsaWRhdGluZy1taWxlc3RvbmVcIixcbiAgICAgICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgICAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICAgICAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgICAgICAgbmV4dEFjdGlvbjogXCJWYWxpZGF0ZSBtaWxlc3RvbmUgTTAwMS5cIixcbiAgICAgICAgICB9IGFzIGFueTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHBoYXNlOiBcInByZS1wbGFubmluZ1wiLFxuICAgICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIsIHRpdGxlOiBcIlRlc3RcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgICAgICByZWdpc3RyeTogW3sgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfV0sXG4gICAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICAgICAgbmV4dEFjdGlvbjogXCJQbGFuIG1pbGVzdG9uZSBNMDAxLlwiLFxuICAgICAgICB9IGFzIGFueTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgaWMgPSBtYWtlSUMoZGVwcywge1xuICAgICAgcHJlZnM6IHsgdW9rOiB7IHBsYW5fdjI6IHsgZW5hYmxlZDogdHJ1ZSB9IH0gfSBhcyBhbnksXG4gICAgfSk7XG4gICAgaWMucy5iYXNlUGF0aCA9IGJhc2VQYXRoO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRGlzcGF0Y2goaWMsIHtcbiAgICAgIHJlY2VudFVuaXRzOiBbXSxcbiAgICAgIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCxcbiAgICAgIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcIm5leHRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGRlcml2ZUNhbGxzLCAyLCBcImVtcHR5IHBsYW4gZ3JhcGggc2hvdWxkIHRyaWdnZXIgb25lIHN0YXRlIHJlZGVyaXZlXCIpO1xuICAgIGFzc2VydC5vayhpbnZhbGlkYXRlQ2FsbHMgPj0gMSwgXCJlbXB0eSBwbGFuIGdyYXBoIHJlY292ZXJ5IHNob3VsZCBjbGVhciBjYWNoZXMgYmVmb3JlIHJlZGVyaXZlXCIpO1xuICAgIGFzc2VydC5lcXVhbChwYXVzZUNhbGxzLCAwLCBcInJlY292ZXJhYmxlIGVtcHR5IGdyYXBoIHNob3VsZCBub3QgcGF1c2UgYXV0by1tb2RlXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIGNsb3NlRGF0YWJhc2UoKTtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoXCJwbGFuLXYyIGVtcHR5IGdyYXBoIHBhdXNlcyBhZnRlciBvbmUgZmFpbGVkIHJlZGVyaXZlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgYmFzZVBhdGggPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1wbGFuLXYyLWVtcHR5LWdyYXBoLXBhdXNlLVwiKSk7XG4gIG1rZGlyU3luYyhqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoXG4gICAgam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwibWlsZXN0b25lc1wiLCBcIk0wMDFcIiwgXCJNMDAxLUNPTlRFWFQubWRcIiksXG4gICAgXCIjIE0wMDE6IFRlc3RcXG5cXG5GaW5hbGl6ZWQgY29udGV4dC5cXG5cIixcbiAgKTtcbiAgb3BlbkRhdGFiYXNlKGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcImdzZC5kYlwiKSk7XG4gIHRyeSB7XG4gICAgbGV0IGRlcml2ZUNhbGxzID0gMDtcbiAgICBsZXQgaW52YWxpZGF0ZUNhbGxzID0gMDtcbiAgICBsZXQgcGF1c2VDYWxscyA9IDA7XG4gICAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICAgIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7IHBhdXNlQ2FsbHMrKzsgfSxcbiAgICAgIGludmFsaWRhdGVBbGxDYWNoZXM6ICgpID0+IHsgaW52YWxpZGF0ZUNhbGxzKys7IH0sXG4gICAgICBkZXJpdmVTdGF0ZTogYXN5bmMgKCkgPT4ge1xuICAgICAgICBkZXJpdmVDYWxscysrO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHBoYXNlOiBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIsXG4gICAgICAgICAgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiwgdGl0bGU6IFwiVGVzdFwiLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICAgICAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICAgICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgICAgIHJlZ2lzdHJ5OiBbeyBpZDogXCJNMDAxXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9XSxcbiAgICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgICAgICBuZXh0QWN0aW9uOiBcIlZhbGlkYXRlIG1pbGVzdG9uZSBNMDAxLlwiLFxuICAgICAgICB9IGFzIGFueTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgaWMgPSBtYWtlSUMoZGVwcywge1xuICAgICAgcHJlZnM6IHsgdW9rOiB7IHBsYW5fdjI6IHsgZW5hYmxlZDogdHJ1ZSB9IH0gfSBhcyBhbnksXG4gICAgfSk7XG4gICAgaWMucy5iYXNlUGF0aCA9IGJhc2VQYXRoO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRGlzcGF0Y2goaWMsIHtcbiAgICAgIHJlY2VudFVuaXRzOiBbXSxcbiAgICAgIHN0dWNrUmVjb3ZlcnlBdHRlbXB0czogMCxcbiAgICAgIGNvbnNlY3V0aXZlRmluYWxpemVUaW1lb3V0czogMCxcbiAgICB9KTtcblxuICAgIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImJyZWFrXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZXN1bHQucmVhc29uLCBcInBsYW4tdjItZ2F0ZS1mYWlsZWRcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGRlcml2ZUNhbGxzLCAyLCBcImVtcHR5IHBsYW4gZ3JhcGggc2hvdWxkIG9ubHkgcmVkZXJpdmUgb25jZVwiKTtcbiAgICBhc3NlcnQub2soaW52YWxpZGF0ZUNhbGxzID49IDEsIFwiZW1wdHkgcGxhbiBncmFwaCByZWNvdmVyeSBzaG91bGQgY2xlYXIgY2FjaGVzIGJlZm9yZSByZWRlcml2ZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwocGF1c2VDYWxscywgMSwgXCJwZXJzaXN0ZW50IGVtcHR5IGdyYXBoIHNob3VsZCBwYXVzZSBhdXRvLW1vZGVcIik7XG4gIH0gZmluYWxseSB7XG4gICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdChcIm1pbGVzdG9uZS10cmFuc2l0aW9uIGV2ZW50IGlzIGVtaXR0ZWQgd2hlbiBtaWxlc3RvbmUgY2hhbmdlc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNhcHR1cmUgPSBjcmVhdGVFdmVudENhcHR1cmUoKTtcbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyhjYXB0dXJlLCB7XG4gICAgZGVyaXZlU3RhdGU6IGFzeW5jICgpID0+ICh7XG4gICAgICBwaGFzZTogXCJleGVjdXRpbmdcIixcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAyXCIsIHRpdGxlOiBcIk5leHQgTWlsZXN0b25lXCIsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgICAgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIgfSxcbiAgICAgIGFjdGl2ZVRhc2s6IHsgaWQ6IFwiVDAxXCIgfSxcbiAgICAgIHJlZ2lzdHJ5OiBbXG4gICAgICAgIHsgaWQ6IFwiTTAwMVwiLCBzdGF0dXM6IFwiY29tcGxldGVcIiB9LFxuICAgICAgICB7IGlkOiBcIk0wMDJcIiwgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgICBdLFxuICAgICAgYmxvY2tlcnM6IFtdLFxuICAgIH0pIGFzIGFueSxcbiAgfSk7XG4gIGNvbnN0IGljID0gbWFrZUlDKGRlcHMsIHtcbiAgICBwcmVmczogeyB1b2s6IHsgcGxhbl92MjogeyBlbmFibGVkOiBmYWxzZSB9IH0gfSBhcyBhbnksXG4gIH0pO1xuICAvLyBTZXNzaW9uIHNheXMgY3VycmVudCBtaWxlc3RvbmUgaXMgTTAwMSwgYnV0IHN0YXRlIHdpbGwgcmV0dXJuIE0wMDJcbiAgaWMucy5jdXJyZW50TWlsZXN0b25lSWQgPSBcIk0wMDFcIjtcbiAgY29uc3QgbG9vcFN0YXRlOiBMb29wU3RhdGUgPSB7IHJlY2VudFVuaXRzOiBbXSwgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLCBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAgfTtcblxuICBhd2FpdCBydW5QcmVEaXNwYXRjaChpYywgbG9vcFN0YXRlKTtcblxuICBjb25zdCB0cmFuc2l0aW9uRXZlbnRzID0gY2FwdHVyZS5ldmVudHMuZmlsdGVyKGUgPT4gZS5ldmVudFR5cGUgPT09IFwibWlsZXN0b25lLXRyYW5zaXRpb25cIik7XG4gIGFzc2VydC5lcXVhbCh0cmFuc2l0aW9uRXZlbnRzLmxlbmd0aCwgMSwgXCJzaG91bGQgZW1pdCBvbmUgbWlsZXN0b25lLXRyYW5zaXRpb24gZXZlbnRcIik7XG4gIGFzc2VydC5lcXVhbCgodHJhbnNpdGlvbkV2ZW50c1swXS5kYXRhIGFzIGFueSkuZnJvbSwgXCJNMDAxXCIpO1xuICBhc3NlcnQuZXF1YWwoKHRyYW5zaXRpb25FdmVudHNbMF0uZGF0YSBhcyBhbnkpLnRvLCBcIk0wMDJcIik7XG4gIGFzc2VydC5lcXVhbCh0cmFuc2l0aW9uRXZlbnRzWzBdLmZsb3dJZCwgaWMuZmxvd0lkKTtcbn0pO1xuXG50ZXN0KFwidW5pdC1lbmQgZXZlbnQgY29udGFpbnMgZXJyb3JDb250ZXh0IHdoZW4gdW5pdCBpcyBjYW5jZWxsZWQgd2l0aCBzdHJ1Y3R1cmVkIGVycm9yXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICBjb25zdCB7IHJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCwgX3Jlc2V0UGVuZGluZ1Jlc29sdmUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8vcmVzb2x2ZS5qc1wiKTtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBsZXQgcGF1c2VDYWxscyA9IDA7XG4gIGxldCBjb21taXRDYWxscyA9IDA7XG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgIHBhdXNlQXV0bzogYXN5bmMgKCkgPT4geyBwYXVzZUNhbGxzKys7IH0sXG4gICAgYXV0b0NvbW1pdFVuaXQ6IGFzeW5jICgpID0+IHtcbiAgICAgIGNvbW1pdENhbGxzKys7XG4gICAgICByZXR1cm4gXCJjb21taXRcIjtcbiAgICB9LFxuICB9KTtcbiAgY29uc3QgaWMgPSBtYWtlSUMoZGVwcyk7XG4gIGNvbnN0IGl0ZXJEYXRhOiBJdGVyYXRpb25EYXRhID0ge1xuICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICBwcm9tcHQ6IFwiZG8gc3R1ZmZcIixcbiAgICBmaW5hbFByb21wdDogXCJkbyBzdHVmZlwiLFxuICAgIHBhdXNlQWZ0ZXJVYXREaXNwYXRjaDogZmFsc2UsXG4gICAgc3RhdGU6IHsgcGhhc2U6IFwiZXhlY3V0aW5nXCIsIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIgfSwgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIgfSwgcmVnaXN0cnk6IFtdLCBibG9ja2VyczogW10gfSBhcyBhbnksXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgaXNSZXRyeTogZmFsc2UsXG4gICAgcHJldmlvdXNUaWVyOiB1bmRlZmluZWQsXG4gIH07XG4gIGNvbnN0IGxvb3BTdGF0ZTogTG9vcFN0YXRlID0geyByZWNlbnRVbml0czogW3sga2V5OiBcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIiB9XSwgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLCBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAgfTtcblxuICBjb25zdCB1bml0UHJvbWlzZSA9IHJ1blVuaXRQaGFzZShpYywgaXRlckRhdGEsIGxvb3BTdGF0ZSk7XG4gIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuXG4gIC8vIFJlc29sdmUgd2l0aCBlcnJvckNvbnRleHQgKHNpbXVsYXRlcyBhIHVuaXQgaGFyZCB0aW1lb3V0IFx1MjAxNCBub3Qgc2Vzc2lvbiBjcmVhdGlvbilcbiAgcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkKHsgbWVzc2FnZTogXCJIYXJkIHRpbWVvdXQgZXJyb3I6IGV4Y2VlZGVkIGxpbWl0XCIsIGNhdGVnb3J5OiBcInRpbWVvdXRcIiwgaXNUcmFuc2llbnQ6IHRydWUgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdW5pdFByb21pc2U7XG4gIC8vIFVuaXQgaGFyZCB0aW1lb3V0cyBwYXVzZSAocmVjb3ZlcmFibGUpIHdpdGhvdXQgYXV0by1yZXN1bWVcbiAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiYnJlYWtcIik7XG4gIGFzc2VydC5lcXVhbCgocmVzdWx0IGFzIGFueSkucmVhc29uLCBcInVuaXQtaGFyZC10aW1lb3V0XCIpO1xuICBhc3NlcnQuZXF1YWwocGF1c2VDYWxscywgMSwgXCJ0aW1lb3V0IGNhbmNlbGxhdGlvbnMgc2hvdWxkIHBhdXNlIGF1dG8tbW9kZSBleGFjdGx5IG9uY2VcIik7XG4gIGFzc2VydC5lcXVhbChjb21taXRDYWxscywgMSwgXCJ0aW1lb3V0IGNhbmNlbGxhdGlvbnMgc2hvdWxkIGZsdXNoIGEgdW5pdCBhdXRvLWNvbW1pdCBvbmNlXCIpO1xuXG4gIC8vIFZlcmlmeSBlcnJvciBjbGFzc2lmaWNhdGlvbiB1c2VkIHN0cnVjdHVyZWQgZXJyb3JDb250ZXh0IG9uIHRoZSB3aW5kb3cgZW50cnlcbiAgY29uc3QgZW50cnkgPSBsb29wU3RhdGUucmVjZW50VW5pdHNbbG9vcFN0YXRlLnJlY2VudFVuaXRzLmxlbmd0aCAtIDFdO1xuICBhc3NlcnQub2soZW50cnkuZXJyb3IsIFwid2luZG93IGVudHJ5IG11c3QgaGF2ZSBlcnJvciBzZXRcIik7XG4gIGFzc2VydC5vayhlbnRyeS5lcnJvciEuc3RhcnRzV2l0aChcInRpbWVvdXQ6XCIpLCBcImVycm9yIG11c3Qgc3RhcnQgd2l0aCBjYXRlZ29yeSBmcm9tIGVycm9yQ29udGV4dFwiKTtcbiAgYXNzZXJ0Lm9rKGVudHJ5LmVycm9yIS5pbmNsdWRlcyhcIkhhcmQgdGltZW91dCBlcnJvclwiKSwgXCJlcnJvciBtdXN0IGluY2x1ZGUgdGhlIGVycm9yQ29udGV4dCBtZXNzYWdlXCIpO1xuXG4gIGNvbnN0IGVuZEV2ZW50cyA9IGNhcHR1cmUuZXZlbnRzLmZpbHRlcihlID0+IGUuZXZlbnRUeXBlID09PSBcInVuaXQtZW5kXCIpO1xuICBhc3NlcnQuZXF1YWwoZW5kRXZlbnRzLmxlbmd0aCwgMSwgXCJ0aW1lb3V0IGNhbmNlbGxhdGlvbnMgc2hvdWxkIHN0aWxsIGVtaXQgdW5pdC1lbmRcIik7XG4gIGFzc2VydC5lcXVhbCgoZW5kRXZlbnRzWzBdLmRhdGEgYXMgYW55KS5zdGF0dXMsIFwiY2FuY2VsbGVkXCIpO1xuICBhc3NlcnQuZXF1YWwoKGVuZEV2ZW50c1swXS5kYXRhIGFzIGFueSkuYXJ0aWZhY3RWZXJpZmllZCwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoKGVuZEV2ZW50c1swXS5kYXRhIGFzIGFueSkuZXJyb3JDb250ZXh0LmNhdGVnb3J5LCBcInRpbWVvdXRcIik7XG59KTtcblxudGVzdChcInNlc3Npb24tZmFpbGVkIGNhbmNlbGxhdGlvbnMgY2xvc2Ugb3V0IGFuZCBlbWl0IHVuaXQtZW5kIGJlZm9yZSBoYXJkIHN0b3BcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjYXB0dXJlID0gY3JlYXRlRXZlbnRDYXB0dXJlKCk7XG4gIGNvbnN0IHsgcmVzb2x2ZUFnZW50RW5kQ2FuY2VsbGVkLCBfcmVzZXRQZW5kaW5nUmVzb2x2ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYXV0by9yZXNvbHZlLmpzXCIpO1xuICBfcmVzZXRQZW5kaW5nUmVzb2x2ZSgpO1xuXG4gIGxldCBjbG9zZW91dENhbGxzID0gMDtcbiAgbGV0IGNvbW1pdENhbGxzID0gMDtcbiAgbGV0IHN0b3BDYWxscyA9IDA7XG4gIGNvbnN0IGRlcHMgPSBtYWtlTW9ja0RlcHMoY2FwdHVyZSwge1xuICAgIGNsb3Nlb3V0VW5pdDogYXN5bmMgKCkgPT4geyBjbG9zZW91dENhbGxzKys7IH0sXG4gICAgYXV0b0NvbW1pdFVuaXQ6IGFzeW5jICgpID0+IHtcbiAgICAgIGNvbW1pdENhbGxzKys7XG4gICAgICByZXR1cm4gXCJjb21taXRcIjtcbiAgICB9LFxuICAgIHN0b3BBdXRvOiBhc3luYyAoKSA9PiB7IHN0b3BDYWxscysrOyB9LFxuICB9KTtcbiAgY29uc3QgaWMgPSBtYWtlSUMoZGVwcyk7XG4gIGNvbnN0IGl0ZXJEYXRhOiBJdGVyYXRpb25EYXRhID0ge1xuICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgIHVuaXRJZDogXCJNMDAxL1MwMS9UMDFcIixcbiAgICBwcm9tcHQ6IFwiZG8gc3R1ZmZcIixcbiAgICBmaW5hbFByb21wdDogXCJkbyBzdHVmZlwiLFxuICAgIHBhdXNlQWZ0ZXJVYXREaXNwYXRjaDogZmFsc2UsXG4gICAgc3RhdGU6IHsgcGhhc2U6IFwiZXhlY3V0aW5nXCIsIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIgfSwgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIgfSwgcmVnaXN0cnk6IFtdLCBibG9ja2VyczogW10gfSBhcyBhbnksXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgaXNSZXRyeTogZmFsc2UsXG4gICAgcHJldmlvdXNUaWVyOiB1bmRlZmluZWQsXG4gIH07XG4gIGNvbnN0IGxvb3BTdGF0ZTogTG9vcFN0YXRlID0geyByZWNlbnRVbml0czogW3sga2V5OiBcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDFcIiB9XSwgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLCBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAgfTtcblxuICBjb25zdCB1bml0UHJvbWlzZSA9IHJ1blVuaXRQaGFzZShpYywgaXRlckRhdGEsIGxvb3BTdGF0ZSk7XG4gIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuXG4gIHJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCh7IG1lc3NhZ2U6IFwic2Vzc2lvbiBib290c3RyYXAgZXhwbG9kZWRcIiwgY2F0ZWdvcnk6IFwic2Vzc2lvbi1mYWlsZWRcIiwgaXNUcmFuc2llbnQ6IGZhbHNlIH0pO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHVuaXRQcm9taXNlO1xuICBhc3NlcnQuZXF1YWwocmVzdWx0LmFjdGlvbiwgXCJicmVha1wiKTtcbiAgYXNzZXJ0LmVxdWFsKChyZXN1bHQgYXMgYW55KS5yZWFzb24sIFwic2Vzc2lvbi1mYWlsZWRcIik7XG4gIGFzc2VydC5lcXVhbChjbG9zZW91dENhbGxzLCAxLCBcInNlc3Npb24tZmFpbGVkIGNhbmNlbGxhdGlvbnMgc2hvdWxkIGNsb3NlIG91dCB0aGUgdW5pdCBiZWZvcmUgc3RvcHBpbmdcIik7XG4gIGFzc2VydC5lcXVhbChjb21taXRDYWxscywgMSwgXCJzZXNzaW9uLWZhaWxlZCBjYW5jZWxsYXRpb25zIHNob3VsZCB0cnkgb25lIGF1dG8tY29tbWl0IGZsdXNoXCIpO1xuICBhc3NlcnQuZXF1YWwoc3RvcENhbGxzLCAxLCBcInNlc3Npb24tZmFpbGVkIGNhbmNlbGxhdGlvbnMgc2hvdWxkIGhhcmQtc3RvcCBhdXRvLW1vZGVcIik7XG5cbiAgY29uc3QgZW5kRXZlbnRzID0gY2FwdHVyZS5ldmVudHMuZmlsdGVyKGUgPT4gZS5ldmVudFR5cGUgPT09IFwidW5pdC1lbmRcIik7XG4gIGFzc2VydC5lcXVhbChlbmRFdmVudHMubGVuZ3RoLCAxLCBcInNlc3Npb24tZmFpbGVkIGNhbmNlbGxhdGlvbnMgc2hvdWxkIGVtaXQgdW5pdC1lbmRcIik7XG4gIGFzc2VydC5lcXVhbCgoZW5kRXZlbnRzWzBdLmRhdGEgYXMgYW55KS5zdGF0dXMsIFwiY2FuY2VsbGVkXCIpO1xuICBhc3NlcnQuZXF1YWwoKGVuZEV2ZW50c1swXS5kYXRhIGFzIGFueSkuYXJ0aWZhY3RWZXJpZmllZCwgZmFsc2UpO1xuICBhc3NlcnQuZXF1YWwoKGVuZEV2ZW50c1swXS5kYXRhIGFzIGFueSkuZXJyb3JDb250ZXh0LmNhdGVnb3J5LCBcInNlc3Npb24tZmFpbGVkXCIpO1xufSk7XG5cbnRlc3QoXCJydW5GaW5hbGl6ZSBwYXVzZXMgYW5kIGVtaXRzIHVuaXQtZW5kIHdoZW4gcHJlLXZlcmlmaWNhdGlvbiB0aW1lcyBvdXRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBjYXB0dXJlID0gY3JlYXRlRXZlbnRDYXB0dXJlKCk7XG4gIGxldCBwYXVzZUNhbGxzID0gMDtcbiAgY29uc3QgYmFzZVBhdGggPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1maW5hbGl6ZS10aW1lb3V0LVwiKSk7XG5cbiAgY29uc3QgZGVwcyA9IG1ha2VNb2NrRGVwcyhjYXB0dXJlLCB7XG4gICAgcGF1c2VBdXRvOiBhc3luYyAoKSA9PiB7IHBhdXNlQ2FsbHMrKzsgfSxcbiAgICBwb3N0VW5pdFByZVZlcmlmaWNhdGlvbjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKCkgPT4ge30pO1xuICAgICAgcmV0dXJuIFwiY29udGludWVcIiBhcyBjb25zdDtcbiAgICB9LFxuICB9KTtcblxuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzLCB7XG4gICAgczoge1xuICAgICAgLi4ubWFrZVNlc3Npb24oKSxcbiAgICAgIGJhc2VQYXRoLFxuICAgICAgY3VycmVudFVuaXQ6IHsgdHlwZTogXCJleGVjdXRlLXRhc2tcIiwgaWQ6IFwiTTAwMS9TMDEvVDAxXCIsIHN0YXJ0ZWRBdDogMTIzNCB9LFxuICAgIH0gYXMgYW55LFxuICB9KTtcbiAgY29uc3QgaXRlckRhdGE6IEl0ZXJhdGlvbkRhdGEgPSB7XG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMVwiLFxuICAgIHByb21wdDogXCJkbyBzdHVmZlwiLFxuICAgIGZpbmFsUHJvbXB0OiBcImRvIHN0dWZmXCIsXG4gICAgcGF1c2VBZnRlclVhdERpc3BhdGNoOiBmYWxzZSxcbiAgICBzdGF0ZTogeyBwaGFzZTogXCJleGVjdXRpbmdcIiwgYWN0aXZlTWlsZXN0b25lOiB7IGlkOiBcIk0wMDFcIiB9LCBhY3RpdmVTbGljZTogeyBpZDogXCJTMDFcIiB9LCByZWdpc3RyeTogW10sIGJsb2NrZXJzOiBbXSB9IGFzIGFueSxcbiAgICBtaWQ6IFwiTTAwMVwiLFxuICAgIG1pZFRpdGxlOiBcIlRlc3RcIixcbiAgICBpc1JldHJ5OiBmYWxzZSxcbiAgICBwcmV2aW91c1RpZXI6IHVuZGVmaW5lZCxcbiAgfTtcbiAgY29uc3QgbG9vcFN0YXRlOiBMb29wU3RhdGUgPSB7IHJlY2VudFVuaXRzOiBbXSwgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLCBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAgfTtcblxuICBjb25zdCBvcmlnaW5hbFNldFRpbWVvdXQgPSBnbG9iYWxUaGlzLnNldFRpbWVvdXQ7XG4gIHRyeSB7XG4gICAgZ2xvYmFsVGhpcy5zZXRUaW1lb3V0ID0gKChoYW5kbGVyOiAoLi4uYXJnczogYW55W10pID0+IHZvaWQsIF90aW1lb3V0PzogbnVtYmVyLCAuLi5hcmdzOiBhbnlbXSkgPT5cbiAgICAgIG9yaWdpbmFsU2V0VGltZW91dChoYW5kbGVyLCAwLCAuLi5hcmdzKSkgYXMgdHlwZW9mIHNldFRpbWVvdXQ7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5GaW5hbGl6ZShpYywgaXRlckRhdGEsIGxvb3BTdGF0ZSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5hY3Rpb24sIFwiYnJlYWtcIik7XG4gICAgYXNzZXJ0LmVxdWFsKChyZXN1bHQgYXMgYW55KS5yZWFzb24sIFwiZmluYWxpemUtcHJlLXRpbWVvdXRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgZ2xvYmFsVGhpcy5zZXRUaW1lb3V0ID0gb3JpZ2luYWxTZXRUaW1lb3V0O1xuICB9XG5cbiAgYXNzZXJ0LmVxdWFsKHBhdXNlQ2FsbHMsIDEsIFwicHJlLXZlcmlmaWNhdGlvbiB0aW1lb3V0IHNob3VsZCBwYXVzZSBhdXRvLW1vZGVcIik7XG4gIGFzc2VydC5lcXVhbChsb29wU3RhdGUuY29uc2VjdXRpdmVGaW5hbGl6ZVRpbWVvdXRzLCAxLCBcInRpbWVvdXQgc2hvdWxkIGluY3JlbWVudCBmaW5hbGl6ZSB0aW1lb3V0IGNvdW50ZXJcIik7XG4gIGFzc2VydC5lcXVhbChpYy5zLmN1cnJlbnRVbml0LCBudWxsLCBcInRpbWVkLW91dCBmaW5hbGl6ZSBzaG91bGQgZGV0YWNoIGN1cnJlbnRVbml0XCIpO1xuXG4gIGNvbnN0IHJ1bnRpbWUgPSByZWFkVW5pdFJ1bnRpbWVSZWNvcmQoYmFzZVBhdGgsIFwiZXhlY3V0ZS10YXNrXCIsIFwiTTAwMS9TMDEvVDAxXCIpO1xuICBhc3NlcnQub2socnVudGltZSwgXCJ0aW1lZC1vdXQgZmluYWxpemUgc2hvdWxkIHBlcnNpc3QgYSBydW50aW1lIHJlY29yZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKHJ1bnRpbWU/LnBoYXNlLCBcImZpbmFsaXplLXRpbWVvdXRcIik7XG4gIGFzc2VydC5lcXVhbChydW50aW1lPy5sYXN0UHJvZ3Jlc3NLaW5kLCBcImZpbmFsaXplLXByZS10aW1lb3V0XCIpO1xuXG4gIGNvbnN0IGVuZEV2ZW50cyA9IGNhcHR1cmUuZXZlbnRzLmZpbHRlcigoZSkgPT4gZS5ldmVudFR5cGUgPT09IFwidW5pdC1lbmRcIik7XG4gIGFzc2VydC5lcXVhbChlbmRFdmVudHMubGVuZ3RoLCAxLCBcInRpbWVkLW91dCBmaW5hbGl6ZSBzaG91bGQgZW1pdCB0ZXJtaW5hbCB1bml0LWVuZFwiKTtcbiAgYXNzZXJ0LmVxdWFsKChlbmRFdmVudHNbMF0uZGF0YSBhcyBhbnkpLnN0YXR1cywgXCJ0aW1lZC1vdXQtZmluYWxpemVcIik7XG4gIGFzc2VydC5lcXVhbCgoZW5kRXZlbnRzWzBdLmRhdGEgYXMgYW55KS5hcnRpZmFjdFZlcmlmaWVkLCBmYWxzZSk7XG4gIGFzc2VydC5lcXVhbCgoZW5kRXZlbnRzWzBdLmRhdGEgYXMgYW55KS5maW5hbGl6ZVN0YWdlLCBcInByZVwiKTtcbn0pO1xuXG50ZXN0KFwidHJhbnNpZW50IHNlc3Npb24tZmFpbGVkIGNhbmNlbGxhdGlvbnMgcGF1c2UgaW5zdGVhZCBvZiBoYXJkLXN0b3BwaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgY2FwdHVyZSA9IGNyZWF0ZUV2ZW50Q2FwdHVyZSgpO1xuICBjb25zdCB7IHJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCwgX3Jlc2V0UGVuZGluZ1Jlc29sdmUgfSA9IGF3YWl0IGltcG9ydChcIi4uL2F1dG8vcmVzb2x2ZS5qc1wiKTtcbiAgX3Jlc2V0UGVuZGluZ1Jlc29sdmUoKTtcblxuICBjb25zdCBkZXBzID0gbWFrZU1vY2tEZXBzKGNhcHR1cmUpO1xuICBjb25zdCBpYyA9IG1ha2VJQyhkZXBzKTtcbiAgY29uc3QgaXRlckRhdGE6IEl0ZXJhdGlvbkRhdGEgPSB7XG4gICAgdW5pdFR5cGU6IFwiZXhlY3V0ZS10YXNrXCIsXG4gICAgdW5pdElkOiBcIk0wMDEvUzAxL1QwMlwiLFxuICAgIHByb21wdDogXCJkbyBtb3JlIHN0dWZmXCIsXG4gICAgZmluYWxQcm9tcHQ6IFwiZG8gbW9yZSBzdHVmZlwiLFxuICAgIHBhdXNlQWZ0ZXJVYXREaXNwYXRjaDogZmFsc2UsXG4gICAgc3RhdGU6IHsgcGhhc2U6IFwiZXhlY3V0aW5nXCIsIGFjdGl2ZU1pbGVzdG9uZTogeyBpZDogXCJNMDAxXCIgfSwgYWN0aXZlU2xpY2U6IHsgaWQ6IFwiUzAxXCIgfSwgcmVnaXN0cnk6IFtdLCBibG9ja2VyczogW10gfSBhcyBhbnksXG4gICAgbWlkOiBcIk0wMDFcIixcbiAgICBtaWRUaXRsZTogXCJUZXN0XCIsXG4gICAgaXNSZXRyeTogZmFsc2UsXG4gICAgcHJldmlvdXNUaWVyOiB1bmRlZmluZWQsXG4gIH07XG4gIGNvbnN0IGxvb3BTdGF0ZTogTG9vcFN0YXRlID0geyByZWNlbnRVbml0czogW3sga2V5OiBcImV4ZWN1dGUtdGFzay9NMDAxL1MwMS9UMDJcIiB9XSwgc3R1Y2tSZWNvdmVyeUF0dGVtcHRzOiAwLCBjb25zZWN1dGl2ZUZpbmFsaXplVGltZW91dHM6IDAgfTtcblxuICBjb25zdCB1bml0UHJvbWlzZSA9IHJ1blVuaXRQaGFzZShpYywgaXRlckRhdGEsIGxvb3BTdGF0ZSk7XG4gIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuXG4gIHJlc29sdmVBZ2VudEVuZENhbmNlbGxlZCh7IG1lc3NhZ2U6IFwiU2Vzc2lvbiBjcmVhdGlvbiBmYWlsZWQ6IHRlbXBvcmFyeSBib290c3RyYXAgb3ZlcmxvYWRcIiwgY2F0ZWdvcnk6IFwic2Vzc2lvbi1mYWlsZWRcIiwgaXNUcmFuc2llbnQ6IHRydWUgfSk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdW5pdFByb21pc2U7XG4gIGFzc2VydC5lcXVhbChyZXN1bHQuYWN0aW9uLCBcImJyZWFrXCIpO1xuICBhc3NlcnQuZXF1YWwoKHJlc3VsdCBhcyBhbnkpLnJlYXNvbiwgXCJzZXNzaW9uLXRpbWVvdXRcIik7XG5cbiAgY29uc3QgZW50cnkgPSBsb29wU3RhdGUucmVjZW50VW5pdHNbbG9vcFN0YXRlLnJlY2VudFVuaXRzLmxlbmd0aCAtIDFdO1xuICBhc3NlcnQub2soZW50cnkuZXJyb3IsIFwid2luZG93IGVudHJ5IG11c3QgaGF2ZSBlcnJvciBzZXRcIik7XG4gIGFzc2VydC5vayhlbnRyeS5lcnJvciEuc3RhcnRzV2l0aChcInNlc3Npb24tZmFpbGVkOlwiKSwgXCJlcnJvciBtdXN0IHByZXNlcnZlIHRoZSBzZXNzaW9uLWZhaWxlZCBjYXRlZ29yeVwiKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGtCQUFrQjtBQUMzQixTQUFTLG9CQUFvQjtBQUM3QixTQUFTLFdBQVcsYUFBYSxRQUFRLHFCQUFxQjtBQUM5RCxTQUFTLGNBQWM7QUFDdkIsU0FBUyxZQUFZO0FBSXJCLFNBQVMsK0JBQStCO0FBR3hDLFNBQVMsYUFBYSxjQUFjLGdCQUFnQixtQkFBbUI7QUFDdkUsU0FBUyw2QkFBNkI7QUFDdEM7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFLUCxTQUFTLHFCQUFxQjtBQUM1QixRQUFNLFNBQXlCLENBQUM7QUFDaEMsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBLGtCQUFrQixDQUFDLFVBQXdCO0FBQUUsYUFBTyxLQUFLLEtBQUs7QUFBQSxJQUFHO0FBQUEsRUFDbkU7QUFDRjtBQUdBLFNBQVMsYUFDUCxTQUNBLFdBQ1U7QUFDVixRQUFNLFdBQXFCO0FBQUEsSUFDekIsVUFBVSxNQUFNO0FBQUEsSUFDaEIsbUJBQW1CLE9BQU8sQ0FBQztBQUFBLElBQzNCLFVBQVUsWUFBWTtBQUFBLElBQUM7QUFBQSxJQUN2QixXQUFXLFlBQVk7QUFBQSxJQUFDO0FBQUEsSUFDeEIsa0JBQWtCLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDekIsc0JBQXNCLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDN0IsaUJBQWlCLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDeEIsY0FBYyxNQUFNO0FBQUEsSUFBQztBQUFBLElBQ3JCLHFCQUFxQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQzVCLGFBQWEsYUFBYTtBQUFBLE1BQ3hCLE9BQU87QUFBQSxNQUNQLGlCQUFpQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTO0FBQUEsTUFDL0QsYUFBYSxFQUFFLElBQUksT0FBTyxPQUFPLFVBQVU7QUFBQSxNQUMzQyxZQUFZLEVBQUUsSUFBSSxNQUFNO0FBQUEsTUFDeEIsVUFBVSxDQUFDLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQUEsTUFDM0MsVUFBVSxDQUFDO0FBQUEsSUFDYjtBQUFBLElBQ0EsNkJBQTZCLE9BQU8sRUFBRSxhQUFhLENBQUMsRUFBRTtBQUFBLElBQ3RELHVCQUF1QixhQUFhLEVBQUUsU0FBUyxNQUFNLGNBQWMsQ0FBQyxFQUFFO0FBQUEsSUFDdEUscUJBQXFCLE1BQU07QUFBQSxJQUMzQixxQkFBcUIsT0FBTyxFQUFFLE9BQU8sS0FBSztBQUFBLElBQzFDLG1CQUFtQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQzFCLHVCQUF1QixNQUFNO0FBQUEsSUFBQztBQUFBLElBQzlCLHlCQUF5QixNQUFNO0FBQUEsSUFBQztBQUFBLElBQ2hDLHNCQUFzQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQzdCLGlCQUFpQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQ3hCLGtCQUFrQixNQUFNO0FBQUEsSUFDeEIsNEJBQTRCLE1BQU07QUFBQSxJQUNsQyxzQkFBc0IsTUFBTTtBQUFBLElBQUM7QUFBQSxJQUM3QixvQkFBb0IsTUFBTTtBQUFBLElBQzFCLDBCQUEwQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQ2pDLGtCQUFrQixNQUFNO0FBQUEsSUFDeEIsa0JBQWtCLE1BQU07QUFBQSxJQUN4QixvQkFBb0IsTUFBTTtBQUFBLElBQzFCLHNCQUFzQixNQUFNO0FBQUEsSUFDNUIscUJBQXFCLE1BQU07QUFBQSxJQUMzQixvQkFBb0IsT0FBTyxFQUFFLGFBQWEsT0FBTyxTQUFTLEdBQUc7QUFBQSxJQUM3RCxvQkFBb0IsT0FBTztBQUFBLE1BQ3pCLFVBQVU7QUFBQSxNQUNWLHFCQUFxQjtBQUFBLE1BQ3JCLFNBQVM7QUFBQSxJQUNYO0FBQUEsSUFDQSxXQUFXLE9BQU8sRUFBRSxPQUFPLENBQUMsRUFBRTtBQUFBLElBQzlCLGtCQUFrQixPQUFPLEVBQUUsTUFBTSxFQUFFO0FBQUEsSUFDbkMsWUFBWSxDQUFDLE1BQWMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQUEsSUFDM0MscUJBQXFCLE1BQU07QUFBQSxJQUMzQix3QkFBd0IsTUFBTTtBQUFBLElBQzlCLDRCQUE0QixNQUFNO0FBQUEsSUFDbEMsbUJBQW1CLFlBQVk7QUFBQSxJQUMvQiw0QkFBNEIsWUFBWTtBQUFBLElBQ3hDLGlCQUFpQixhQUFhO0FBQUEsTUFDNUIsUUFBUTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsUUFBUTtBQUFBLE1BQ1IsUUFBUTtBQUFBLE1BQ1IsYUFBYTtBQUFBLElBQ2Y7QUFBQSxJQUNBLHFCQUFxQixPQUFPLEVBQUUsWUFBWSxDQUFDLEdBQUcsUUFBUSxVQUFVO0FBQUEsSUFDaEUsZ0NBQWdDLE1BQU07QUFBQSxJQUN0QyxlQUFlLE1BQU07QUFBQSxJQUNyQixjQUFjLFlBQVk7QUFBQSxJQUFDO0FBQUEsSUFDM0IsZ0JBQWdCLFlBQVk7QUFBQSxJQUM1QixlQUFlLE1BQU07QUFBQSxJQUFDO0FBQUEsSUFDdEIsV0FBVyxNQUFNO0FBQUEsSUFBQztBQUFBLElBQ2xCLHdCQUF3QixNQUFNO0FBQUEsSUFBQztBQUFBLElBQy9CLHFCQUFxQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQzVCLDBCQUEwQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQ2pDLHFCQUFxQixhQUFhLEVBQUUsU0FBUyxNQUFNLGNBQWMsS0FBSztBQUFBLElBQ3RFLHNCQUFzQixNQUFNO0FBQUEsSUFBQztBQUFBLElBQzdCLG1CQUFtQixNQUFNO0FBQUEsSUFDekIsZUFBZSxNQUFNO0FBQUEsSUFDckIsbUJBQW1CLENBQUMsTUFBYztBQUFBLElBQ2xDLFlBQVksQ0FBQyxNQUFjLEVBQUUsU0FBUyxNQUFNLEtBQUssRUFBRSxTQUFTLGNBQWM7QUFBQSxJQUMxRSxjQUFjLE1BQU07QUFBQSxJQUNwQixpQkFBaUIsTUFBTTtBQUFBLElBQUM7QUFBQSxJQUN4QixnQkFBZ0IsTUFBTTtBQUFBLElBQUM7QUFBQSxJQUN2QixvQkFBb0IsSUFBSSx3QkFBd0I7QUFBQSxJQUNoRCxXQUFXO0FBQUEsTUFDVCxnQkFBZ0IsT0FBTyxFQUFFLElBQUksTUFBTSxNQUFNLFlBQVksTUFBTSxlQUFlO0FBQUEsTUFDMUUsZUFBZSxDQUFDLE1BQWMsVUFBOEI7QUFBQSxRQUMxRCxJQUFJO0FBQUEsUUFDSixRQUFRLEtBQUs7QUFBQSxRQUNiLGtCQUFrQjtBQUFBLE1BQ3BCO0FBQUEsSUFDRjtBQUFBLElBQ0EseUJBQXlCLFlBQVk7QUFBQSxJQUNyQyx5QkFBeUIsWUFBWTtBQUFBLElBQ3JDLDBCQUEwQixZQUFZO0FBQUEsSUFDdEMsZ0JBQWdCLE1BQU07QUFBQSxJQUN0QixjQUFjLFlBQVk7QUFBQSxJQUFDO0FBQUEsSUFDM0IsZ0JBQWdCLENBQUMsSUFBWSxXQUFrQixPQUFPLEtBQUssQ0FBQyxNQUFXLEVBQUUsT0FBTyxFQUFFO0FBQUEsSUFDbEYsa0JBQWtCLFFBQVE7QUFBQSxFQUM1QjtBQUVBLFNBQU8sRUFBRSxHQUFHLFVBQVUsR0FBRyxVQUFVO0FBQ3JDO0FBR0EsU0FBUyxPQUNQLE1BQ0EsV0FDa0I7QUFDbEIsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxhQUFhO0FBQ2pCLFNBQU87QUFBQSxJQUNMLEtBQUs7QUFBQSxNQUNILElBQUksRUFBRSxRQUFRLE1BQU07QUFBQSxNQUFDLEdBQUcsV0FBVyxNQUFNO0FBQUEsTUFBQyxFQUFFO0FBQUEsTUFDNUMsT0FBTyxFQUFFLElBQUksYUFBYTtBQUFBLE1BQzFCLGVBQWUsRUFBRSxjQUFjLE1BQU0sQ0FBQyxFQUFFO0FBQUEsSUFDMUM7QUFBQSxJQUNBLElBQUk7QUFBQSxNQUNGLGFBQWEsTUFBTTtBQUFBLE1BQUM7QUFBQSxNQUNwQixVQUFVLFlBQVk7QUFBQSxJQUN4QjtBQUFBLElBQ0EsR0FBRyxZQUFZO0FBQUEsSUFDZjtBQUFBLElBQ0EsT0FBTztBQUFBLElBQ1AsV0FBVztBQUFBLElBQ1g7QUFBQSxJQUNBLFNBQVMsTUFBTSxFQUFFO0FBQUEsSUFDakIsR0FBRztBQUFBLEVBQ0w7QUFDRjtBQUdBLFNBQVMsY0FBYztBQUNyQixTQUFPO0FBQUEsSUFDTCxRQUFRO0FBQUEsSUFDUixTQUFTO0FBQUEsSUFDVCxVQUFVO0FBQUEsSUFDVixRQUFRO0FBQUEsSUFDUixVQUFVO0FBQUEsSUFDVixrQkFBa0I7QUFBQSxJQUNsQixvQkFBb0I7QUFBQSxJQUNwQixhQUFhO0FBQUEsSUFDYixvQkFBb0I7QUFBQSxJQUNwQixnQkFBZ0IsQ0FBQztBQUFBLElBQ2pCLHdCQUF3QjtBQUFBLElBQ3hCLHFCQUFxQjtBQUFBLElBQ3JCLHVCQUF1QjtBQUFBLElBQ3ZCLHNCQUFzQjtBQUFBLElBQ3RCLDBCQUEwQjtBQUFBLElBQzFCLHNCQUFzQjtBQUFBLElBQ3RCLG1CQUFtQixDQUFDO0FBQUEsSUFDcEIsY0FBYyxDQUFDO0FBQUEsSUFDZixvQkFBb0I7QUFBQSxJQUNwQixtQkFBbUIsb0JBQUksSUFBb0I7QUFBQSxJQUMzQyx3QkFBd0Isb0JBQUksSUFBb0I7QUFBQSxJQUNoRCxtQkFBbUIsb0JBQUksSUFBb0I7QUFBQSxJQUMzQyx3QkFBd0Isb0JBQUksSUFBb0I7QUFBQSxJQUNoRCxZQUFZO0FBQUEsSUFDWixlQUFlLEtBQUssSUFBSTtBQUFBLElBQ3hCLFFBQVE7QUFBQSxNQUNOLFlBQVksTUFBTSxRQUFRLFFBQVEsRUFBRSxXQUFXLE1BQU0sQ0FBQztBQUFBLE1BQ3RELGlCQUFpQixPQUFPLEVBQUUsU0FBUyxJQUFJLFFBQVEsS0FBTSxPQUFPLElBQU07QUFBQSxJQUNwRTtBQUFBLElBQ0EsYUFBYSxNQUFNO0FBQUEsSUFBQztBQUFBLEVBQ3RCO0FBQ0Y7QUFJQSxLQUFLLGlFQUFpRSxZQUFZO0FBQ2hGLFFBQU0sVUFBVSxtQkFBbUI7QUFDbkMsUUFBTSxPQUFPLGFBQWEsU0FBUztBQUFBLElBQ2pDLGlCQUFpQixhQUFhO0FBQUEsTUFDNUIsUUFBUTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsUUFBUTtBQUFBLE1BQ1IsUUFBUTtBQUFBLE1BQ1IsYUFBYTtBQUFBLElBQ2Y7QUFBQSxFQUNGLENBQUM7QUFDRCxRQUFNLEtBQUssT0FBTyxJQUFJO0FBQ3RCLFFBQU0sVUFBMkI7QUFBQSxJQUMvQixPQUFPO0FBQUEsTUFDTCxPQUFPO0FBQUEsTUFDUCxpQkFBaUIsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUztBQUFBLE1BQy9ELGFBQWEsRUFBRSxJQUFJLE9BQU8sT0FBTyxVQUFVO0FBQUEsTUFDM0MsWUFBWSxFQUFFLElBQUksTUFBTTtBQUFBLE1BQ3hCLFVBQVUsQ0FBQyxFQUFFLElBQUksUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUFBLE1BQzNDLFVBQVUsQ0FBQztBQUFBLElBQ2I7QUFBQSxJQUNBLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxFQUNaO0FBQ0EsUUFBTSxZQUF1QixFQUFFLGFBQWEsQ0FBQyxHQUFHLHVCQUF1QixHQUFHLDZCQUE2QixFQUFFO0FBRXpHLFFBQU0sU0FBUyxNQUFNLFlBQVksSUFBSSxTQUFTLFNBQVM7QUFFdkQsU0FBTyxNQUFNLE9BQU8sUUFBUSxRQUFRLG9EQUFvRDtBQUV4RixRQUFNLGNBQWMsUUFBUSxPQUFPLE9BQU8sT0FBSyxFQUFFLGNBQWMsZ0JBQWdCO0FBQy9FLFNBQU8sTUFBTSxZQUFZLFFBQVEsR0FBRyw4Q0FBOEM7QUFFbEYsUUFBTSxLQUFLLFlBQVksQ0FBQztBQUN4QixTQUFPLE1BQU0sR0FBRyxRQUFRLEdBQUcsUUFBUSx3REFBd0Q7QUFDM0YsU0FBTyxNQUFNLEdBQUcsTUFBTSxtQkFBbUIsbURBQW1EO0FBQzVGLFNBQU8sTUFBTyxHQUFHLEtBQWEsVUFBVSxjQUFjO0FBQ3RELFNBQU8sTUFBTyxHQUFHLEtBQWEsUUFBUSxjQUFjO0FBQ3RELENBQUM7QUFFRCxLQUFLLHFFQUFxRSxZQUFZO0FBQ3BGLFFBQU0sVUFBVSxtQkFBbUI7QUFDbkMsUUFBTSxPQUFPLGFBQWEsU0FBUztBQUFBLElBQ2pDLGlCQUFpQixhQUFhO0FBQUEsTUFDNUIsUUFBUTtBQUFBLE1BQ1IsUUFBUTtBQUFBLE1BQ1IsT0FBTztBQUFBLE1BQ1AsYUFBYTtBQUFBLElBQ2Y7QUFBQSxFQUNGLENBQUM7QUFDRCxRQUFNLEtBQUssT0FBTyxJQUFJO0FBQ3RCLFFBQU0sVUFBMkI7QUFBQSxJQUMvQixPQUFPLEVBQUUsT0FBTyxhQUFhLGlCQUFpQixFQUFFLElBQUksT0FBTyxHQUFHLFVBQVUsQ0FBQyxFQUFFLElBQUksUUFBUSxRQUFRLFNBQVMsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxFQUFFO0FBQUEsSUFDekgsS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLEVBQ1o7QUFDQSxRQUFNLFlBQXVCLEVBQUUsYUFBYSxDQUFDLEdBQUcsdUJBQXVCLEdBQUcsNkJBQTZCLEVBQUU7QUFFekcsUUFBTSxTQUFTLE1BQU0sWUFBWSxJQUFJLFNBQVMsU0FBUztBQUN2RCxTQUFPLE1BQU0sT0FBTyxRQUFRLE9BQU87QUFFbkMsUUFBTSxhQUFhLFFBQVEsT0FBTyxPQUFPLE9BQUssRUFBRSxjQUFjLGVBQWU7QUFDN0UsU0FBTyxNQUFNLFdBQVcsUUFBUSxDQUFDO0FBQ2pDLFNBQU8sTUFBTSxXQUFXLENBQUMsRUFBRSxNQUFNLFlBQVk7QUFDN0MsU0FBTyxNQUFPLFdBQVcsQ0FBQyxFQUFFLEtBQWEsUUFBUSxtQkFBbUI7QUFDcEUsU0FBTyxNQUFNLFdBQVcsQ0FBQyxFQUFFLFFBQVEsR0FBRyxNQUFNO0FBQzlDLENBQUM7QUFFRCxLQUFLLHVGQUF1RixZQUFZO0FBQ3RHLFFBQU0sVUFBVSxtQkFBbUI7QUFDbkMsUUFBTSxhQUFxRCxDQUFDO0FBQzVELFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxlQUFlLENBQUMsYUFBcUI7QUFDbkMsaUJBQVcsS0FBSyxFQUFFLElBQUksaUJBQWlCLE1BQU0sQ0FBQyxRQUFRLEVBQUUsQ0FBQztBQUN6RCxhQUFPO0FBQUEsSUFDVDtBQUFBLElBQ0EsZ0NBQWdDLENBQzlCLFVBQ0EsWUFDQSxVQUNBLFdBQ0c7QUFDSCxpQkFBVyxLQUFLO0FBQUEsUUFDZCxJQUFJO0FBQUEsUUFDSixNQUFNLENBQUMsVUFBVSxZQUFZLFVBQVUsTUFBTTtBQUFBLE1BQy9DLENBQUM7QUFDRCxhQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0YsQ0FBQztBQUNELFFBQU0sS0FBSyxPQUFPLE1BQU07QUFBQSxJQUN0QixHQUFHO0FBQUEsTUFDRCxHQUFHLFlBQVk7QUFBQSxNQUNmLFVBQVU7QUFBQSxNQUNWLGtCQUFrQjtBQUFBLElBQ3BCO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxVQUEyQjtBQUFBLElBQy9CLE9BQU87QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLGlCQUFpQixFQUFFLElBQUksZUFBZSxPQUFPLFFBQVEsUUFBUSxTQUFTO0FBQUEsTUFDdEUsYUFBYSxFQUFFLElBQUksT0FBTyxPQUFPLFVBQVU7QUFBQSxNQUMzQyxVQUFVLENBQUMsRUFBRSxJQUFJLGVBQWUsUUFBUSxTQUFTLENBQUM7QUFBQSxNQUNsRCxVQUFVLENBQUM7QUFBQSxJQUNiO0FBQUEsSUFDQSxLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsRUFDWjtBQUVBLFFBQU0sU0FBUyxNQUFNLFlBQVksSUFBSSxTQUFTO0FBQUEsSUFDNUMsYUFBYSxDQUFDO0FBQUEsSUFDZCx1QkFBdUI7QUFBQSxJQUN2Qiw2QkFBNkI7QUFBQSxFQUMvQixDQUFDO0FBRUQsU0FBTyxNQUFNLE9BQU8sUUFBUSxNQUFNO0FBQ2xDLFNBQU8sVUFBVSxZQUFZO0FBQUEsSUFDM0IsRUFBRSxJQUFJLGlCQUFpQixNQUFNLENBQUMsY0FBYyxFQUFFO0FBQUEsSUFDOUM7QUFBQSxNQUNFLElBQUk7QUFBQSxNQUNKLE1BQU0sQ0FBQyxnQkFBZ0IsUUFBUSxnQkFBZ0IsY0FBYztBQUFBLElBQy9EO0FBQUEsRUFDRixDQUFDO0FBQ0gsQ0FBQztBQUVELEtBQUsseUdBQXlHLE9BQU8sTUFBTTtBQUN6SCxRQUFNLFVBQVUsbUJBQW1CO0FBQ25DLE1BQUksYUFBYTtBQUNqQixNQUFJLFlBQVk7QUFDaEIsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLHNCQUFzQixXQUFXLENBQUMsRUFBRTtBQUNoRSxJQUFFLE1BQU0sTUFBTTtBQUNaLFdBQU8sTUFBTSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQy9DLENBQUM7QUFFRCxZQUFVLEtBQUssTUFBTSxRQUFRLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDdkUsWUFBVSxLQUFLLE1BQU0sS0FBSyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDaEQsZ0JBQWMsS0FBSyxNQUFNLFFBQVEsY0FBYyxRQUFRLGlCQUFpQixHQUFHLG9CQUFvQjtBQUMvRixnQkFBYyxLQUFLLE1BQU0sT0FBTyxRQUFRLEdBQUcsMkJBQTJCO0FBRXRFLGVBQWEsT0FBTyxDQUFDLFFBQVEsTUFBTSxNQUFNLEdBQUcsRUFBRSxLQUFLLE1BQU0sT0FBTyxTQUFTLENBQUM7QUFDMUUsZUFBYSxPQUFPLENBQUMsVUFBVSxhQUFhLE9BQU8sR0FBRyxFQUFFLEtBQUssTUFBTSxPQUFPLFNBQVMsQ0FBQztBQUNwRixlQUFhLE9BQU8sQ0FBQyxVQUFVLGNBQWMsbUJBQW1CLEdBQUcsRUFBRSxLQUFLLE1BQU0sT0FBTyxTQUFTLENBQUM7QUFDakcsZ0JBQWMsS0FBSyxNQUFNLFdBQVcsR0FBRyxVQUFVO0FBQ2pELGVBQWEsT0FBTyxDQUFDLE9BQU8sV0FBVyxHQUFHLEVBQUUsS0FBSyxNQUFNLE9BQU8sU0FBUyxDQUFDO0FBQ3hFLGVBQWEsT0FBTyxDQUFDLFVBQVUsTUFBTSxhQUFhLEdBQUcsRUFBRSxLQUFLLE1BQU0sT0FBTyxTQUFTLENBQUM7QUFDbkYsZUFBYSxPQUFPLENBQUMsWUFBWSxNQUFNLFVBQVUsR0FBRyxFQUFFLEtBQUssTUFBTSxPQUFPLFNBQVMsQ0FBQztBQUNsRixlQUFhLE9BQU8sQ0FBQyxPQUFPLHdDQUF3QyxZQUFZLEdBQUcsRUFBRSxLQUFLLE1BQU0sT0FBTyxTQUFTLENBQUM7QUFDakgsZUFBYSxPQUFPLENBQUMsVUFBVSxNQUFNLHNDQUFzQyxHQUFHLEVBQUUsS0FBSyxNQUFNLE9BQU8sU0FBUyxDQUFDO0FBRTVHLFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxXQUFXLFlBQVk7QUFBRTtBQUFBLElBQWM7QUFBQSxJQUN2QyxVQUFVLFlBQVk7QUFBRTtBQUFBLElBQWE7QUFBQSxJQUNyQyxpQkFBaUIsYUFBYTtBQUFBLE1BQzVCLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLGFBQWE7QUFBQSxJQUNmO0FBQUEsRUFDRixDQUFDO0FBRUQsUUFBTSxLQUFLLE9BQU8sTUFBTTtBQUFBLElBQ3RCLEdBQUc7QUFBQSxNQUNELEdBQUcsWUFBWTtBQUFBLE1BQ2YsVUFBVTtBQUFBLE1BQ1Ysb0JBQW9CO0FBQUEsSUFDdEI7QUFBQSxFQUNGLENBQUM7QUFDRCxRQUFNLFVBQTJCO0FBQUEsSUFDL0IsT0FBTztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVM7QUFBQSxNQUMvRCxVQUFVLENBQUMsRUFBRSxJQUFJLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFBQSxNQUMzQyxVQUFVLENBQUM7QUFBQSxJQUNiO0FBQUEsSUFDQSxLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsRUFDWjtBQUVBLFFBQU0sU0FBUyxNQUFNLFlBQVksSUFBSSxTQUFTO0FBQUEsSUFDNUMsYUFBYTtBQUFBLE1BQ1gsRUFBRSxLQUFLLDBCQUEwQjtBQUFBLE1BQ2pDLEVBQUUsS0FBSywwQkFBMEI7QUFBQSxJQUNuQztBQUFBLElBQ0EsdUJBQXVCO0FBQUEsSUFDdkIsNkJBQTZCO0FBQUEsRUFDL0IsQ0FBQztBQUVELFNBQU8sTUFBTSxPQUFPLFFBQVEsT0FBTztBQUNuQyxTQUFPLE1BQU8sT0FBZSxRQUFRLHlDQUF5QztBQUM5RSxTQUFPLE1BQU0sWUFBWSxHQUFHLDREQUE0RDtBQUN4RixTQUFPLE1BQU0sV0FBVyxHQUFHLDhDQUE4QztBQUMzRSxDQUFDO0FBRUQsS0FBSyxvRkFBb0YsT0FBTyxNQUFNO0FBQ3BHLFFBQU0sVUFBVSxtQkFBbUI7QUFDbkMsTUFBSSxhQUFhO0FBQ2pCLE1BQUksWUFBWTtBQUNoQixNQUFJLGtCQUFrQjtBQUN0QixRQUFNLE9BQU8sS0FBSyxPQUFPLEdBQUcsMEJBQTBCLFdBQVcsQ0FBQyxFQUFFO0FBQ3BFLElBQUUsTUFBTSxNQUFNO0FBQ1osa0JBQWM7QUFDZCxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQyxDQUFDO0FBRUQsUUFBTSxXQUFXLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLEtBQUs7QUFDekUsUUFBTSxXQUFXLEtBQUssVUFBVSxPQUFPO0FBQ3ZDLFlBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLGVBQWEsS0FBSyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQ3pDLGtCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsY0FBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxTQUFTLFFBQVEsY0FBYyxDQUFDO0FBQ3JGLGFBQVcsRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLFNBQVMsT0FBTyxPQUFPLGNBQWMsUUFBUSxVQUFVLENBQUM7QUFDckc7QUFBQSxJQUNFLEtBQUssVUFBVSxhQUFhO0FBQUEsSUFDNUI7QUFBQSxNQUNFO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQUUsS0FBSyxJQUFJO0FBQUEsRUFDYjtBQUNBLGdCQUFjLEtBQUssVUFBVSxhQUFhLEdBQUcsY0FBYztBQUMzRCxnQkFBYyxLQUFLLFVBQVUsZ0JBQWdCLEdBQUcsa0NBQWtDO0FBRWxGLFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxXQUFXLFlBQVk7QUFBRTtBQUFBLElBQWM7QUFBQSxJQUN2QyxVQUFVLFlBQVk7QUFBRTtBQUFBLElBQWE7QUFBQSxJQUNyQyxxQkFBcUIsTUFBTTtBQUFFO0FBQUEsSUFBbUI7QUFBQSxJQUNoRCxpQkFBaUIsYUFBYTtBQUFBLE1BQzVCLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLGFBQWE7QUFBQSxJQUNmO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxLQUFLLE9BQU8sTUFBTTtBQUFBLElBQ3RCLEdBQUc7QUFBQSxNQUNELEdBQUcsWUFBWTtBQUFBLE1BQ2YsVUFBVTtBQUFBLE1BQ1Ysa0JBQWtCO0FBQUEsSUFDcEI7QUFBQSxFQUNGLENBQUM7QUFDRCxRQUFNLFVBQTJCO0FBQUEsSUFDL0IsT0FBTztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVM7QUFBQSxNQUMvRCxhQUFhLEVBQUUsSUFBSSxPQUFPLE9BQU8sUUFBUTtBQUFBLE1BQ3pDLFlBQVksRUFBRSxJQUFJLE9BQU8sT0FBTyxhQUFhO0FBQUEsTUFDN0MsVUFBVSxDQUFDLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQUEsTUFDM0MsVUFBVSxDQUFDO0FBQUEsSUFDYjtBQUFBLElBQ0EsS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLEVBQ1o7QUFDQSxRQUFNLFlBQXVCO0FBQUEsSUFDM0IsYUFBYTtBQUFBLE1BQ1gsRUFBRSxLQUFLLDRCQUE0QjtBQUFBLE1BQ25DLEVBQUUsS0FBSyw0QkFBNEI7QUFBQSxJQUNyQztBQUFBLElBQ0EsdUJBQXVCO0FBQUEsSUFDdkIsNkJBQTZCO0FBQUEsRUFDL0I7QUFFQSxRQUFNLFNBQVMsTUFBTSxZQUFZLElBQUksU0FBUyxTQUFTO0FBRXZELFNBQU8sTUFBTSxPQUFPLFFBQVEsT0FBTztBQUNuQyxTQUFPLE1BQU8sT0FBZSxRQUFRLG1DQUFtQztBQUN4RSxTQUFPLE1BQU0sWUFBWSxHQUFHLHNEQUFzRDtBQUNsRixTQUFPLE1BQU0sV0FBVyxHQUFHLDZEQUE2RDtBQUN4RixTQUFPLE1BQU0saUJBQWlCLEdBQUcsaUVBQWlFO0FBQ2xHLFNBQU8sTUFBTSxVQUFVLFlBQVksUUFBUSxHQUFHLDhDQUE4QztBQUM1RixTQUFPLE1BQU0sVUFBVSx1QkFBdUIsR0FBRyxnREFBZ0Q7QUFDbkcsQ0FBQztBQUVELEtBQUssK0ZBQStGLE9BQU8sTUFBTTtBQUMvRyxRQUFNLFVBQVUsbUJBQW1CO0FBQ25DLE1BQUksYUFBYTtBQUNqQixNQUFJLFlBQVk7QUFDaEIsTUFBSSxrQkFBa0I7QUFDdEIsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLDZCQUE2QixXQUFXLENBQUMsRUFBRTtBQUN2RSxJQUFFLE1BQU0sTUFBTTtBQUNaLGtCQUFjO0FBQ2QsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0MsQ0FBQztBQUVELFFBQU0sV0FBVyxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxLQUFLO0FBQ3pFLFFBQU0sV0FBVyxLQUFLLFVBQVUsT0FBTztBQUN2QyxZQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2QyxlQUFhLEtBQUssTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUN6QyxrQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQy9ELGNBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLGNBQWMsQ0FBQztBQUNyRixhQUFXLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxTQUFTLE9BQU8sT0FBTyxjQUFjLFFBQVEsVUFBVSxDQUFDO0FBQ3JHO0FBQUEsSUFDRSxLQUFLLFVBQVUsYUFBYTtBQUFBLElBQzVCO0FBQUEsRUFDRjtBQUNBLGdCQUFjLEtBQUssVUFBVSxhQUFhLEdBQUcsY0FBYztBQUMzRCxnQkFBYyxLQUFLLFVBQVUsZ0JBQWdCLEdBQUcsa0NBQWtDO0FBRWxGLFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxXQUFXLFlBQVk7QUFBRTtBQUFBLElBQWM7QUFBQSxJQUN2QyxVQUFVLFlBQVk7QUFBRTtBQUFBLElBQWE7QUFBQSxJQUNyQyxxQkFBcUIsTUFBTTtBQUFFO0FBQUEsSUFBbUI7QUFBQSxJQUNoRCxpQkFBaUIsYUFBYTtBQUFBLE1BQzVCLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLGFBQWE7QUFBQSxJQUNmO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxLQUFLLE9BQU8sTUFBTTtBQUFBLElBQ3RCLEdBQUc7QUFBQSxNQUNELEdBQUcsWUFBWTtBQUFBLE1BQ2YsVUFBVTtBQUFBLE1BQ1Ysa0JBQWtCO0FBQUEsSUFDcEI7QUFBQSxFQUNGLENBQUM7QUFDRCxRQUFNLFVBQTJCO0FBQUEsSUFDL0IsT0FBTztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVM7QUFBQSxNQUMvRCxhQUFhLEVBQUUsSUFBSSxPQUFPLE9BQU8sUUFBUTtBQUFBLE1BQ3pDLFlBQVksRUFBRSxJQUFJLE9BQU8sT0FBTyxhQUFhO0FBQUEsTUFDN0MsVUFBVSxDQUFDLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQUEsTUFDM0MsVUFBVSxDQUFDO0FBQUEsSUFDYjtBQUFBLElBQ0EsS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLEVBQ1o7QUFDQSxRQUFNLFlBQXVCO0FBQUEsSUFDM0IsYUFBYTtBQUFBLE1BQ1gsRUFBRSxLQUFLLDRCQUE0QjtBQUFBLE1BQ25DLEVBQUUsS0FBSyw0QkFBNEI7QUFBQSxJQUNyQztBQUFBLElBQ0EsdUJBQXVCO0FBQUEsSUFDdkIsNkJBQTZCO0FBQUEsRUFDL0I7QUFFQSxRQUFNLFNBQVMsTUFBTSxZQUFZLElBQUksU0FBUyxTQUFTO0FBRXZELFNBQU8sTUFBTSxPQUFPLFFBQVEsT0FBTztBQUNuQyxTQUFPLE1BQU8sT0FBZSxRQUFRLG1DQUFtQztBQUN4RSxTQUFPLE1BQU0sWUFBWSxHQUFHLDhEQUE4RDtBQUMxRixTQUFPLE1BQU0sV0FBVyxHQUFHLHFFQUFxRTtBQUNoRyxTQUFPLE1BQU0saUJBQWlCLEdBQUcsb0VBQW9FO0FBQ3JHLFNBQU8sTUFBTSxVQUFVLFlBQVksUUFBUSxHQUFHLHNEQUFzRDtBQUNwRyxTQUFPLE1BQU0sVUFBVSx1QkFBdUIsR0FBRyx3REFBd0Q7QUFDM0csQ0FBQztBQUVELEtBQUsseUZBQXlGLE9BQU8sTUFBTTtBQUN6RyxRQUFNLFVBQVUsbUJBQW1CO0FBQ25DLE1BQUksYUFBYTtBQUNqQixNQUFJLFlBQVk7QUFDaEIsTUFBSSxrQkFBa0I7QUFDdEIsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLG1DQUFtQyxXQUFXLENBQUMsRUFBRTtBQUM3RSxJQUFFLE1BQU0sTUFBTTtBQUNaLGtCQUFjO0FBQ2QsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0MsQ0FBQztBQUVELFFBQU0sV0FBVyxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxLQUFLO0FBQ3pFLFFBQU0sV0FBVyxLQUFLLFVBQVUsT0FBTztBQUN2QyxZQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2QyxlQUFhLEtBQUssTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUN6QyxrQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQy9ELGNBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLGNBQWMsQ0FBQztBQUNyRixhQUFXLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxTQUFTLE9BQU8sT0FBTyxjQUFjLFFBQVEsV0FBVyxDQUFDO0FBQ3RHO0FBQUEsSUFDRSxLQUFLLFVBQVUsYUFBYTtBQUFBLElBQzVCO0FBQUEsRUFDRjtBQUNBLGdCQUFjLEtBQUssVUFBVSxhQUFhLEdBQUcsY0FBYztBQUMzRCxnQkFBYyxLQUFLLFVBQVUsZ0JBQWdCLEdBQUcsa0NBQWtDO0FBRWxGLFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxXQUFXLFlBQVk7QUFBRTtBQUFBLElBQWM7QUFBQSxJQUN2QyxVQUFVLFlBQVk7QUFBRTtBQUFBLElBQWE7QUFBQSxJQUNyQyxxQkFBcUIsTUFBTTtBQUFFO0FBQUEsSUFBbUI7QUFBQSxJQUNoRCxpQkFBaUIsYUFBYTtBQUFBLE1BQzVCLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLGFBQWE7QUFBQSxJQUNmO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxLQUFLLE9BQU8sTUFBTTtBQUFBLElBQ3RCLEdBQUc7QUFBQSxNQUNELEdBQUcsWUFBWTtBQUFBLE1BQ2YsVUFBVTtBQUFBLE1BQ1Ysa0JBQWtCO0FBQUEsSUFDcEI7QUFBQSxFQUNGLENBQUM7QUFDRCxRQUFNLFVBQTJCO0FBQUEsSUFDL0IsT0FBTztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVM7QUFBQSxNQUMvRCxhQUFhLEVBQUUsSUFBSSxPQUFPLE9BQU8sUUFBUTtBQUFBLE1BQ3pDLFlBQVksRUFBRSxJQUFJLE9BQU8sT0FBTyxhQUFhO0FBQUEsTUFDN0MsVUFBVSxDQUFDLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQUEsTUFDM0MsVUFBVSxDQUFDO0FBQUEsSUFDYjtBQUFBLElBQ0EsS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLEVBQ1o7QUFDQSxRQUFNLFlBQXVCO0FBQUEsSUFDM0IsYUFBYTtBQUFBLE1BQ1gsRUFBRSxLQUFLLDRCQUE0QjtBQUFBLE1BQ25DLEVBQUUsS0FBSyw0QkFBNEI7QUFBQSxJQUNyQztBQUFBLElBQ0EsdUJBQXVCO0FBQUEsSUFDdkIsNkJBQTZCO0FBQUEsRUFDL0I7QUFFQSxRQUFNLFNBQVMsTUFBTSxZQUFZLElBQUksU0FBUyxTQUFTO0FBRXZELFNBQU8sTUFBTSxPQUFPLFFBQVEsVUFBVTtBQUN0QyxTQUFPLE1BQU0sWUFBWSxHQUFHLDJDQUEyQztBQUN2RSxTQUFPLE1BQU0sV0FBVyxHQUFHLDhDQUE4QztBQUN6RSxTQUFPLE1BQU0saUJBQWlCLEdBQUcsdURBQXVEO0FBQ3hGLFNBQU8sVUFBVSxVQUFVLGFBQWEsQ0FBQyxHQUFHLHVEQUF1RDtBQUNuRyxTQUFPLE1BQU0sVUFBVSx1QkFBdUIsR0FBRywyREFBMkQ7QUFDOUcsQ0FBQztBQUVELEtBQUssa0VBQWtFLE9BQU8sTUFBTTtBQUNsRixRQUFNLFVBQVUsbUJBQW1CO0FBQ25DLE1BQUksa0JBQWtCO0FBQ3RCLE1BQUksWUFBWTtBQUNoQixRQUFNLE9BQU8sS0FBSyxPQUFPLEdBQUcsa0JBQWtCLFdBQVcsQ0FBQyxFQUFFO0FBQzVELElBQUUsTUFBTSxNQUFNO0FBQ1osa0JBQWM7QUFDZCxXQUFPLE1BQU0sRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUMvQyxDQUFDO0FBRUQsUUFBTSxXQUFXLEtBQUssTUFBTSxRQUFRLGNBQWMsUUFBUSxVQUFVLEtBQUs7QUFDekUsUUFBTSxXQUFXLEtBQUssVUFBVSxPQUFPO0FBQ3ZDLFlBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQ3ZDLGVBQWEsS0FBSyxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQ3pDLGtCQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsY0FBWSxFQUFFLElBQUksT0FBTyxhQUFhLFFBQVEsT0FBTyxTQUFTLFFBQVEsVUFBVSxDQUFDO0FBQ2pGLGFBQVcsRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLFNBQVMsT0FBTyxPQUFPLGNBQWMsUUFBUSxVQUFVLENBQUM7QUFDckcsZ0JBQWMsS0FBSyxVQUFVLGFBQWEsR0FBRywyREFBMkQ7QUFDeEcsZ0JBQWMsS0FBSyxVQUFVLGFBQWEsR0FBRyxjQUFjO0FBRTNELFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxxQkFBcUIsTUFBTTtBQUFFO0FBQUEsSUFBbUI7QUFBQSxJQUNoRCxVQUFVLFlBQVk7QUFBRTtBQUFBLElBQWE7QUFBQSxJQUNyQyxpQkFBaUIsYUFBYTtBQUFBLE1BQzVCLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLGFBQWE7QUFBQSxJQUNmO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxLQUFLLE9BQU8sTUFBTTtBQUFBLElBQ3RCLEdBQUc7QUFBQSxNQUNELEdBQUcsWUFBWTtBQUFBLE1BQ2YsVUFBVTtBQUFBLE1BQ1Ysa0JBQWtCO0FBQUEsSUFDcEI7QUFBQSxFQUNGLENBQUM7QUFDRCxRQUFNLFVBQTJCO0FBQUEsSUFDL0IsT0FBTztBQUFBLE1BQ0wsT0FBTztBQUFBLE1BQ1AsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVM7QUFBQSxNQUMvRCxhQUFhLEVBQUUsSUFBSSxPQUFPLE9BQU8sUUFBUTtBQUFBLE1BQ3pDLFVBQVUsQ0FBQyxFQUFFLElBQUksUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUFBLE1BQzNDLFVBQVUsQ0FBQztBQUFBLElBQ2I7QUFBQSxJQUNBLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxFQUNaO0FBQ0EsUUFBTSxZQUF1QjtBQUFBLElBQzNCLGFBQWE7QUFBQSxNQUNYLEVBQUUsS0FBSyxzQkFBc0I7QUFBQSxNQUM3QixFQUFFLEtBQUssc0JBQXNCO0FBQUEsSUFDL0I7QUFBQSxJQUNBLHVCQUF1QjtBQUFBLElBQ3ZCLDZCQUE2QjtBQUFBLEVBQy9CO0FBRUEsUUFBTSxTQUFTLE1BQU0sWUFBWSxJQUFJLFNBQVMsU0FBUztBQUV2RCxTQUFPLE1BQU0sT0FBTyxRQUFRLFVBQVU7QUFDdEMsU0FBTyxNQUFNLGlCQUFpQixHQUFHLG9EQUFvRDtBQUNyRixTQUFPLE1BQU0sV0FBVyxHQUFHLGdEQUFnRDtBQUMzRSxTQUFPLFVBQVUsVUFBVSxhQUFhLENBQUMsR0FBRyx5REFBeUQ7QUFDckcsU0FBTyxNQUFNLFVBQVUsdUJBQXVCLEdBQUcsNkRBQTZEO0FBQ2hILENBQUM7QUFFRCxLQUFLLDBGQUEwRixPQUFPLE1BQU07QUFDMUcsUUFBTSxVQUFVLG1CQUFtQjtBQUNuQyxNQUFJLGtCQUFrQjtBQUN0QixNQUFJLFlBQVk7QUFDaEIsUUFBTSxPQUFPLEtBQUssT0FBTyxHQUFHLHFCQUFxQixXQUFXLENBQUMsRUFBRTtBQUMvRCxJQUFFLE1BQU0sTUFBTTtBQUNaLGtCQUFjO0FBQ2QsV0FBTyxNQUFNLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDL0MsQ0FBQztBQUVELFFBQU0sV0FBVyxLQUFLLE1BQU0sUUFBUSxjQUFjLFFBQVEsVUFBVSxLQUFLO0FBQ3pFLFFBQU0sV0FBVyxLQUFLLFVBQVUsT0FBTztBQUN2QyxZQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN2QyxlQUFhLEtBQUssTUFBTSxRQUFRLFFBQVEsQ0FBQztBQUN6QyxrQkFBZ0IsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQy9ELGNBQVksRUFBRSxJQUFJLE9BQU8sYUFBYSxRQUFRLE9BQU8sU0FBUyxRQUFRLFVBQVUsQ0FBQztBQUNqRixhQUFXLEVBQUUsSUFBSSxPQUFPLGFBQWEsUUFBUSxTQUFTLE9BQU8sT0FBTyxjQUFjLFFBQVEsVUFBVSxDQUFDO0FBQ3JHLGdCQUFjLEtBQUssVUFBVSxhQUFhLEdBQUcsMkRBQTJEO0FBQ3hHLGdCQUFjLEtBQUssVUFBVSxhQUFhLEdBQUcsY0FBYztBQUUzRCxRQUFNLE9BQU8sYUFBYSxTQUFTO0FBQUEsSUFDakMscUJBQXFCLE1BQU07QUFBRTtBQUFBLElBQW1CO0FBQUEsSUFDaEQsVUFBVSxZQUFZO0FBQUU7QUFBQSxJQUFhO0FBQUEsSUFDckMsaUJBQWlCLGFBQWE7QUFBQSxNQUM1QixRQUFRO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixRQUFRO0FBQUEsTUFDUixRQUFRO0FBQUEsTUFDUixhQUFhO0FBQUEsSUFDZjtBQUFBLEVBQ0YsQ0FBQztBQUNELFFBQU0sS0FBSyxPQUFPLE1BQU07QUFBQSxJQUN0QixHQUFHO0FBQUEsTUFDRCxHQUFHLFlBQVk7QUFBQSxNQUNmLFVBQVU7QUFBQSxNQUNWLGtCQUFrQjtBQUFBLElBQ3BCO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxVQUEyQjtBQUFBLElBQy9CLE9BQU87QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLGlCQUFpQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTO0FBQUEsTUFDL0QsYUFBYSxFQUFFLElBQUksT0FBTyxPQUFPLFFBQVE7QUFBQSxNQUN6QyxVQUFVLENBQUMsRUFBRSxJQUFJLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFBQSxNQUMzQyxVQUFVLENBQUM7QUFBQSxJQUNiO0FBQUEsSUFDQSxLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsRUFDWjtBQUNBLFFBQU0sWUFBdUI7QUFBQSxJQUMzQixhQUFhO0FBQUEsTUFDWCxFQUFFLEtBQUssc0JBQXNCO0FBQUEsTUFDN0IsRUFBRSxLQUFLLHNCQUFzQjtBQUFBLElBQy9CO0FBQUEsSUFDQSx1QkFBdUI7QUFBQSxJQUN2Qiw2QkFBNkI7QUFBQSxFQUMvQjtBQUVBLFFBQU0sU0FBUyxNQUFNLFlBQVksSUFBSSxTQUFTLFNBQVM7QUFFdkQsU0FBTyxNQUFNLE9BQU8sUUFBUSxVQUFVO0FBQ3RDLFNBQU8sTUFBTSxpQkFBaUIsR0FBRyxxRUFBcUU7QUFDdEcsU0FBTyxNQUFNLFdBQVcsR0FBRyxvREFBb0Q7QUFDL0UsU0FBTyxVQUFVLFVBQVUsYUFBYSxDQUFDLEdBQUcsdURBQXVEO0FBQ25HLFNBQU8sTUFBTSxVQUFVLHVCQUF1QixHQUFHLDJEQUEyRDtBQUM5RyxDQUFDO0FBRUQsS0FBSyxzRUFBc0UsWUFBWTtBQUNyRixRQUFNLFVBQVUsbUJBQW1CO0FBVW5DLFFBQU0sRUFBRSxpQkFBaUIscUJBQXFCLElBQUksTUFBTSxPQUFPLG9CQUFvQjtBQUNuRix1QkFBcUI7QUFFckIsUUFBTSxPQUFPLGFBQWEsT0FBTztBQUNqQyxRQUFNLEtBQUssT0FBTyxJQUFJO0FBQ3RCLFFBQU0sV0FBMEI7QUFBQSxJQUM5QixVQUFVO0FBQUEsSUFDVixRQUFRO0FBQUEsSUFDUixRQUFRO0FBQUEsSUFDUixhQUFhO0FBQUEsSUFDYix1QkFBdUI7QUFBQSxJQUN2QixPQUFPLEVBQUUsT0FBTyxhQUFhLGlCQUFpQixFQUFFLElBQUksT0FBTyxHQUFHLGFBQWEsRUFBRSxJQUFJLE1BQU0sR0FBRyxVQUFVLENBQUMsR0FBRyxVQUFVLENBQUMsRUFBRTtBQUFBLElBQ3JILEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULGNBQWM7QUFBQSxFQUNoQjtBQUNBLFFBQU0sWUFBdUIsRUFBRSxhQUFhLENBQUMsRUFBRSxLQUFLLDRCQUE0QixDQUFDLEdBQUcsdUJBQXVCLEdBQUcsNkJBQTZCLEVBQUU7QUFHN0ksUUFBTSxjQUFjLGFBQWEsSUFBSSxVQUFVLFNBQVM7QUFHeEQsUUFBTSxJQUFJLFFBQVEsT0FBSyxXQUFXLEdBQUcsRUFBRSxDQUFDO0FBR3hDLGtCQUFnQixFQUFFLFVBQVUsQ0FBQyxFQUFFLE1BQU0sWUFBWSxDQUFDLEVBQUUsQ0FBQztBQUVyRCxRQUFNLFNBQVMsTUFBTTtBQUNyQixTQUFPLE1BQU0sT0FBTyxRQUFRLE1BQU07QUFHbEMsUUFBTSxjQUFjLFFBQVEsT0FBTyxPQUFPLE9BQUssRUFBRSxjQUFjLFlBQVk7QUFDM0UsU0FBTyxNQUFNLFlBQVksUUFBUSxHQUFHLG9DQUFvQztBQUN4RSxTQUFPLE1BQU0sWUFBWSxDQUFDLEVBQUUsUUFBUSxHQUFHLE1BQU07QUFDN0MsU0FBTyxNQUFPLFlBQVksQ0FBQyxFQUFFLEtBQWEsVUFBVSxjQUFjO0FBQ2xFLFNBQU8sTUFBTyxZQUFZLENBQUMsRUFBRSxLQUFhLFFBQVEsY0FBYztBQUdoRSxRQUFNLFlBQVksUUFBUSxPQUFPLE9BQU8sT0FBSyxFQUFFLGNBQWMsVUFBVTtBQUN2RSxTQUFPLE1BQU0sVUFBVSxRQUFRLEdBQUcsa0NBQWtDO0FBQ3BFLFNBQU8sTUFBTSxVQUFVLENBQUMsRUFBRSxRQUFRLEdBQUcsTUFBTTtBQUMzQyxTQUFPLE1BQU8sVUFBVSxDQUFDLEVBQUUsS0FBYSxVQUFVLGNBQWM7QUFDaEUsU0FBTyxNQUFPLFVBQVUsQ0FBQyxFQUFFLEtBQWEsUUFBUSxjQUFjO0FBQzlELFNBQU8sTUFBTyxVQUFVLENBQUMsRUFBRSxLQUFhLFFBQVEsV0FBVztBQUczRCxTQUFPLEdBQUcsVUFBVSxDQUFDLEVBQUUsVUFBVSx5Q0FBeUM7QUFDMUUsU0FBTyxNQUFNLFVBQVUsQ0FBQyxFQUFFLFNBQVUsUUFBUSxHQUFHLE1BQU07QUFDckQsU0FBTyxNQUFNLFVBQVUsQ0FBQyxFQUFFLFNBQVUsS0FBSyxZQUFZLENBQUMsRUFBRSxLQUFLLGlEQUFpRDtBQUNoSCxDQUFDO0FBRUQsS0FBSyxtRkFBbUYsWUFBWTtBQUNsRyxRQUFNLFVBQVUsbUJBQW1CO0FBQ25DLFFBQU0sRUFBRSxpQkFBaUIscUJBQXFCLElBQUksTUFBTSxPQUFPLG9CQUFvQjtBQUNuRix1QkFBcUI7QUFFckIsUUFBTSxPQUFPLGFBQWEsT0FBTztBQUNqQyxRQUFNLEtBQUssT0FBTyxJQUFJO0FBQ3RCLFFBQU0sV0FBMEI7QUFBQSxJQUM5QixVQUFVO0FBQUEsSUFDVixRQUFRO0FBQUEsSUFDUixRQUFRO0FBQUEsSUFDUixhQUFhO0FBQUEsSUFDYix1QkFBdUI7QUFBQSxJQUN2QixPQUFPLEVBQUUsT0FBTyxhQUFhLGlCQUFpQixFQUFFLElBQUksT0FBTyxHQUFHLGFBQWEsRUFBRSxJQUFJLE1BQU0sR0FBRyxVQUFVLENBQUMsR0FBRyxVQUFVLENBQUMsRUFBRTtBQUFBLElBQ3JILEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULGNBQWM7QUFBQSxFQUNoQjtBQUNBLFFBQU0sWUFBdUIsRUFBRSxhQUFhLENBQUMsRUFBRSxLQUFLLDRCQUE0QixDQUFDLEdBQUcsdUJBQXVCLEdBQUcsNkJBQTZCLEVBQUU7QUFFN0ksUUFBTSxXQUFXLGFBQWEsSUFBSSxVQUFVLFNBQVM7QUFDckQsUUFBTSxJQUFJLFFBQVEsT0FBSyxXQUFXLEdBQUcsRUFBRSxDQUFDO0FBQ3hDLGtCQUFnQixFQUFFLFVBQVUsQ0FBQyxFQUFFLE1BQU0sWUFBWSxDQUFDLEVBQUUsQ0FBQztBQUNyRCxRQUFNO0FBQ04sU0FBTyxNQUFNLEdBQUcsRUFBRSxrQkFBa0IsSUFBSSwyQkFBMkIsR0FBRyxDQUFDO0FBRXZFLHVCQUFxQjtBQUNyQixRQUFNLFlBQVksYUFBYSxJQUFJLFVBQVUsU0FBUztBQUN0RCxRQUFNLElBQUksUUFBUSxPQUFLLFdBQVcsR0FBRyxFQUFFLENBQUM7QUFDeEMsa0JBQWdCLEVBQUUsVUFBVSxDQUFDLEVBQUUsTUFBTSxZQUFZLENBQUMsRUFBRSxDQUFDO0FBQ3JELFFBQU07QUFDTixTQUFPLE1BQU0sR0FBRyxFQUFFLGtCQUFrQixJQUFJLDJCQUEyQixHQUFHLENBQUM7QUFDekUsQ0FBQztBQUVELEtBQUssc0ZBQXNGLFlBQVk7QUFDckcsUUFBTSxVQUFVLG1CQUFtQjtBQUNuQyxRQUFNLEVBQUUsaUJBQWlCLHFCQUFxQixJQUFJLE1BQU0sT0FBTyxvQkFBb0I7QUFDbkYsdUJBQXFCO0FBRXJCLFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxpQkFBaUIsYUFBYTtBQUFBLE1BQzVCLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLGFBQWE7QUFBQSxJQUNmO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxLQUFLLE9BQU8sSUFBSTtBQUd0QixRQUFNLFVBQTJCO0FBQUEsSUFDL0IsT0FBTyxFQUFFLE9BQU8sYUFBYSxpQkFBaUIsRUFBRSxJQUFJLFFBQVEsT0FBTyxLQUFLLFFBQVEsU0FBUyxHQUFHLGFBQWEsRUFBRSxJQUFJLE1BQU0sR0FBRyxZQUFZLEVBQUUsSUFBSSxNQUFNLEdBQUcsVUFBVSxDQUFDLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUyxDQUFDLEdBQUcsVUFBVSxDQUFDLEVBQUU7QUFBQSxJQUM5TSxLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsRUFDWjtBQUNBLFFBQU0sWUFBdUIsRUFBRSxhQUFhLENBQUMsR0FBRyx1QkFBdUIsR0FBRyw2QkFBNkIsRUFBRTtBQUN6RyxRQUFNLGlCQUFpQixNQUFNLFlBQVksSUFBSSxTQUFTLFNBQVM7QUFDL0QsU0FBTyxNQUFNLGVBQWUsUUFBUSxNQUFNO0FBRzFDLFFBQU0sV0FBWSxlQUEyRDtBQUM3RSxRQUFNLGNBQWMsYUFBYSxJQUFJLFVBQVUsU0FBUztBQUN4RCxRQUFNLElBQUksUUFBUSxPQUFLLFdBQVcsR0FBRyxFQUFFLENBQUM7QUFDeEMsa0JBQWdCLEVBQUUsVUFBVSxDQUFDLEVBQUUsTUFBTSxZQUFZLENBQUMsRUFBRSxDQUFDO0FBQ3JELFFBQU07QUFHTixTQUFPLEdBQUcsUUFBUSxPQUFPLFVBQVUsR0FBRywwRUFBMEUsUUFBUSxPQUFPLE1BQU0sRUFBRTtBQUN2SSxRQUFNLFNBQVMsR0FBRztBQUNsQixhQUFXLE1BQU0sUUFBUSxRQUFRO0FBQy9CLFdBQU8sTUFBTSxHQUFHLFFBQVEsUUFBUSxnQ0FBZ0MsTUFBTSxpQkFBaUIsR0FBRyxTQUFTLGdCQUFnQixHQUFHLE1BQU0sRUFBRTtBQUFBLEVBQ2hJO0FBR0EsV0FBUyxJQUFJLEdBQUcsSUFBSSxRQUFRLE9BQU8sUUFBUSxLQUFLO0FBQzlDLFdBQU87QUFBQSxNQUNMLFFBQVEsT0FBTyxDQUFDLEVBQUUsTUFBTSxRQUFRLE9BQU8sSUFBSSxDQUFDLEVBQUU7QUFBQSxNQUM5QywrQ0FBK0MsSUFBSSxDQUFDLFNBQVMsUUFBUSxPQUFPLElBQUksQ0FBQyxFQUFFLEdBQUcsS0FBSyxRQUFRLE9BQU8sSUFBSSxDQUFDLEVBQUUsU0FBUywrQkFBK0IsQ0FBQyxTQUFTLFFBQVEsT0FBTyxDQUFDLEVBQUUsR0FBRyxLQUFLLFFBQVEsT0FBTyxDQUFDLEVBQUUsU0FBUztBQUFBLElBQzFOO0FBQUEsRUFDRjtBQUNGLENBQUM7QUFFRCxLQUFLLDBFQUEwRSxZQUFZO0FBQ3pGLFFBQU0sVUFBVSxtQkFBbUI7QUFDbkMsUUFBTSxZQUFZO0FBQ2xCLFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxpQkFBaUIsYUFBYTtBQUFBLE1BQzVCLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxNQUNWLFFBQVE7QUFBQSxNQUNSLFFBQVE7QUFBQSxNQUNSLGFBQWE7QUFBQSxJQUNmO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxLQUFLLE9BQU8sSUFBSTtBQUN0QixRQUFNLFVBQTJCO0FBQUEsSUFDL0IsT0FBTyxFQUFFLE9BQU8sYUFBYSxpQkFBaUIsRUFBRSxJQUFJLFFBQVEsT0FBTyxLQUFLLFFBQVEsU0FBUyxHQUFHLGFBQWEsRUFBRSxJQUFJLE1BQU0sR0FBRyxZQUFZLEVBQUUsSUFBSSxNQUFNLEdBQUcsVUFBVSxDQUFDLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUyxDQUFDLEdBQUcsVUFBVSxDQUFDLEVBQUU7QUFBQSxJQUM5TSxLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsRUFDWjtBQUVBLFFBQU0sWUFBWSxJQUFJLFNBQVMsRUFBRSxhQUFhLENBQUMsR0FBRyx1QkFBdUIsR0FBRyw2QkFBNkIsRUFBRSxDQUFDO0FBRTVHLFFBQU0sY0FBYyxRQUFRLE9BQU8sT0FBTyxPQUFLLEVBQUUsY0FBYyxnQkFBZ0I7QUFDL0UsU0FBTyxNQUFNLFlBQVksUUFBUSxDQUFDO0FBQ2xDLFNBQU8sTUFBTSxZQUFZLENBQUMsRUFBRSxNQUFNLFdBQVcsMkVBQTJFO0FBQzFILENBQUM7QUFFRCxLQUFLLHNEQUFzRCxZQUFZO0FBQ3JFLFFBQU0sVUFBVSxtQkFBbUI7QUFDbkMsUUFBTSxPQUFPLGFBQWEsU0FBUztBQUFBLElBQ2pDLGlCQUFpQixhQUFhO0FBQUEsTUFDNUIsUUFBUTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsUUFBUTtBQUFBLE1BQ1IsUUFBUTtBQUFBLE1BQ1IsYUFBYTtBQUFBLElBQ2Y7QUFBQSxJQUNBLHFCQUFxQixPQUFPO0FBQUEsTUFDMUIsWUFBWSxDQUFDLHVCQUF1QixXQUFXO0FBQUEsTUFDL0MsUUFBUTtBQUFBLElBQ1Y7QUFBQSxFQUNGLENBQUM7QUFDRCxRQUFNLEtBQUssT0FBTyxJQUFJO0FBQ3RCLFFBQU0sVUFBMkI7QUFBQSxJQUMvQixPQUFPLEVBQUUsT0FBTyxhQUFhLGlCQUFpQixFQUFFLElBQUksUUFBUSxPQUFPLEtBQUssUUFBUSxTQUFTLEdBQUcsYUFBYSxFQUFFLElBQUksTUFBTSxHQUFHLFlBQVksRUFBRSxJQUFJLE1BQU0sR0FBRyxVQUFVLENBQUMsRUFBRSxJQUFJLFFBQVEsUUFBUSxTQUFTLENBQUMsR0FBRyxVQUFVLENBQUMsRUFBRTtBQUFBLElBQzlNLEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxFQUNaO0FBRUEsUUFBTSxZQUFZLElBQUksU0FBUyxFQUFFLGFBQWEsQ0FBQyxHQUFHLHVCQUF1QixHQUFHLDZCQUE2QixFQUFFLENBQUM7QUFFNUcsUUFBTSxhQUFhLFFBQVEsT0FBTyxPQUFPLE9BQUssRUFBRSxjQUFjLG1CQUFtQjtBQUNqRixTQUFPLE1BQU0sV0FBVyxRQUFRLEdBQUcseUNBQXlDO0FBQzVFLFNBQU8sVUFBVyxXQUFXLENBQUMsRUFBRSxLQUFhLFlBQVksQ0FBQyx1QkFBdUIsV0FBVyxDQUFDO0FBQzdGLFNBQU8sTUFBTyxXQUFXLENBQUMsRUFBRSxLQUFhLFFBQVEsU0FBUztBQUMxRCxTQUFPLE1BQU0sV0FBVyxDQUFDLEVBQUUsUUFBUSxHQUFHLE1BQU07QUFDOUMsQ0FBQztBQUVELEtBQUssbURBQW1ELFlBQVk7QUFDbEUsUUFBTSxVQUFVLG1CQUFtQjtBQUNuQyxRQUFNLE9BQU8sYUFBYSxTQUFTO0FBQUEsSUFDakMsYUFBYSxhQUFhO0FBQUEsTUFDeEIsT0FBTztBQUFBLE1BQ1AsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFdBQVc7QUFBQSxNQUNqRSxhQUFhO0FBQUEsTUFDYixZQUFZO0FBQUEsTUFDWixVQUFVLENBQUMsRUFBRSxJQUFJLFFBQVEsUUFBUSxXQUFXLENBQUM7QUFBQSxNQUM3QyxVQUFVLENBQUM7QUFBQSxJQUNiO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxLQUFLLE9BQU8sSUFBSTtBQUN0QixRQUFNLFlBQXVCLEVBQUUsYUFBYSxDQUFDLEdBQUcsdUJBQXVCLEdBQUcsNkJBQTZCLEVBQUU7QUFFekcsUUFBTSxTQUFTLE1BQU0sZUFBZSxJQUFJLFNBQVM7QUFDakQsU0FBTyxNQUFNLE9BQU8sUUFBUSxPQUFPO0FBRW5DLFFBQU0saUJBQWlCLFFBQVEsT0FBTyxPQUFPLE9BQUssRUFBRSxjQUFjLFVBQVU7QUFDNUUsU0FBTyxNQUFNLGVBQWUsUUFBUSxHQUFHLGdDQUFnQztBQUN2RSxTQUFPLE1BQU8sZUFBZSxDQUFDLEVBQUUsS0FBYSxRQUFRLG9CQUFvQjtBQUN6RSxTQUFPLE1BQU0sZUFBZSxDQUFDLEVBQUUsUUFBUSxHQUFHLE1BQU07QUFDbEQsQ0FBQztBQUVELEtBQUssOENBQThDLFlBQVk7QUFDN0QsUUFBTSxVQUFVLG1CQUFtQjtBQUNuQyxRQUFNLE9BQU8sYUFBYSxTQUFTO0FBQUEsSUFDakMsYUFBYSxhQUFhO0FBQUEsTUFDeEIsT0FBTztBQUFBLE1BQ1AsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVM7QUFBQSxNQUMvRCxhQUFhO0FBQUEsTUFDYixZQUFZO0FBQUEsTUFDWixVQUFVLENBQUMsRUFBRSxJQUFJLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFBQSxNQUMzQyxVQUFVLENBQUMsaUJBQWlCO0FBQUEsSUFDOUI7QUFBQSxFQUNGLENBQUM7QUFDRCxRQUFNLEtBQUssT0FBTyxJQUFJO0FBQ3RCLFFBQU0sWUFBdUIsRUFBRSxhQUFhLENBQUMsR0FBRyx1QkFBdUIsR0FBRyw2QkFBNkIsRUFBRTtBQUV6RyxRQUFNLFNBQVMsTUFBTSxlQUFlLElBQUksU0FBUztBQUNqRCxTQUFPLE1BQU0sT0FBTyxRQUFRLE9BQU87QUFFbkMsUUFBTSxpQkFBaUIsUUFBUSxPQUFPLE9BQU8sT0FBSyxFQUFFLGNBQWMsVUFBVTtBQUM1RSxTQUFPLE1BQU0sZUFBZSxRQUFRLENBQUM7QUFDckMsU0FBTyxNQUFPLGVBQWUsQ0FBQyxFQUFFLEtBQWEsUUFBUSxTQUFTO0FBQzlELFNBQU8sVUFBVyxlQUFlLENBQUMsRUFBRSxLQUFhLFVBQVUsQ0FBQyxpQkFBaUIsQ0FBQztBQUNoRixDQUFDO0FBRUQsS0FBSyxrRkFBa0YsWUFBWTtBQUNqRyxRQUFNLFdBQVcsWUFBWSxLQUFLLE9BQU8sR0FBRyx1QkFBdUIsQ0FBQztBQUNwRSxZQUFVLEtBQUssVUFBVSxRQUFRLGNBQWMsUUFBUSxVQUFVLE9BQU8sT0FBTyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDckcsZUFBYSxLQUFLLFVBQVUsUUFBUSxRQUFRLENBQUM7QUFDN0MsTUFBSTtBQUNGLG9CQUFnQixFQUFFLElBQUksUUFBUSxPQUFPLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFDL0QsZ0JBQVk7QUFBQSxNQUNWLElBQUk7QUFBQSxNQUNKLGFBQWE7QUFBQSxNQUNiLE9BQU87QUFBQSxNQUNQLFFBQVE7QUFBQSxNQUNSLFVBQVU7QUFBQSxJQUNaLENBQUM7QUFDRCxlQUFXO0FBQUEsTUFDVCxJQUFJO0FBQUEsTUFDSixhQUFhO0FBQUEsTUFDYixTQUFTO0FBQUEsTUFDVCxPQUFPO0FBQUEsTUFDUCxRQUFRO0FBQUEsTUFDUixVQUFVLENBQUMsYUFBYTtBQUFBLE1BQ3hCLFVBQVU7QUFBQSxJQUNaLENBQUM7QUFFRCxRQUFJLGFBQWE7QUFDakIsVUFBTSxVQUFVLG1CQUFtQjtBQUNuQyxVQUFNLE9BQU8sYUFBYSxTQUFTO0FBQUEsTUFDakMsV0FBVyxZQUFZO0FBQUU7QUFBQSxNQUFjO0FBQUEsTUFDdkMsYUFBYSxhQUFhO0FBQUEsUUFDeEIsT0FBTztBQUFBLFFBQ1AsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVM7QUFBQSxRQUMvRCxhQUFhLEVBQUUsSUFBSSxPQUFPLE9BQU8sVUFBVTtBQUFBLFFBQzNDLFlBQVksRUFBRSxJQUFJLE9BQU8sT0FBTyxTQUFTO0FBQUEsUUFDekMsVUFBVSxDQUFDLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUyxDQUFDO0FBQUEsUUFDM0MsVUFBVSxDQUFDO0FBQUEsUUFDWCxpQkFBaUIsQ0FBQztBQUFBLFFBQ2xCLFlBQVk7QUFBQSxNQUNkO0FBQUEsSUFDRixDQUFDO0FBQ0QsVUFBTSxLQUFLLE9BQU8sTUFBTTtBQUFBLE1BQ3RCLE9BQU8sRUFBRSxLQUFLLEVBQUUsU0FBUyxFQUFFLFNBQVMsS0FBSyxFQUFFLEVBQUU7QUFBQSxJQUMvQyxDQUFDO0FBQ0QsT0FBRyxFQUFFLFdBQVc7QUFFaEIsVUFBTSxTQUFTLE1BQU0sZUFBZSxJQUFJO0FBQUEsTUFDdEMsYUFBYSxDQUFDO0FBQUEsTUFDZCx1QkFBdUI7QUFBQSxNQUN2Qiw2QkFBNkI7QUFBQSxJQUMvQixDQUFDO0FBRUQsV0FBTyxNQUFNLE9BQU8sUUFBUSxNQUFNO0FBQ2xDLFdBQU8sTUFBTSxZQUFZLEdBQUcsZ0ZBQWdGO0FBQUEsRUFDOUcsVUFBRTtBQUNBLGtCQUFjO0FBQ2QsV0FBTyxVQUFVLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDbkQ7QUFDRixDQUFDO0FBRUQsS0FBSyxzREFBc0QsWUFBWTtBQUNyRSxRQUFNLFdBQVcsWUFBWSxLQUFLLE9BQU8sR0FBRywwQkFBMEIsQ0FBQztBQUN2RSxZQUFVLEtBQUssVUFBVSxRQUFRLGNBQWMsTUFBTSxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDM0U7QUFBQSxJQUNFLEtBQUssVUFBVSxRQUFRLGNBQWMsUUFBUSxpQkFBaUI7QUFBQSxJQUM5RDtBQUFBLEVBQ0Y7QUFDQSxlQUFhLEtBQUssVUFBVSxRQUFRLFFBQVEsQ0FBQztBQUM3QyxNQUFJO0FBQ0YsUUFBSSxjQUFjO0FBQ2xCLFFBQUksa0JBQWtCO0FBQ3RCLFFBQUksYUFBYTtBQUNqQixVQUFNLFVBQVUsbUJBQW1CO0FBQ25DLFVBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxNQUNqQyxXQUFXLFlBQVk7QUFBRTtBQUFBLE1BQWM7QUFBQSxNQUN2QyxxQkFBcUIsTUFBTTtBQUFFO0FBQUEsTUFBbUI7QUFBQSxNQUNoRCxhQUFhLFlBQVk7QUFDdkI7QUFDQSxZQUFJLGdCQUFnQixHQUFHO0FBQ3JCLGlCQUFPO0FBQUEsWUFDTCxPQUFPO0FBQUEsWUFDUCxpQkFBaUIsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUztBQUFBLFlBQy9ELGFBQWE7QUFBQSxZQUNiLFlBQVk7QUFBQSxZQUNaLFVBQVUsQ0FBQyxFQUFFLElBQUksUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUFBLFlBQzNDLFVBQVUsQ0FBQztBQUFBLFlBQ1gsaUJBQWlCLENBQUM7QUFBQSxZQUNsQixZQUFZO0FBQUEsVUFDZDtBQUFBLFFBQ0Y7QUFDQSxlQUFPO0FBQUEsVUFDTCxPQUFPO0FBQUEsVUFDUCxpQkFBaUIsRUFBRSxJQUFJLFFBQVEsT0FBTyxRQUFRLFFBQVEsU0FBUztBQUFBLFVBQy9ELGFBQWE7QUFBQSxVQUNiLFlBQVk7QUFBQSxVQUNaLFVBQVUsQ0FBQyxFQUFFLElBQUksUUFBUSxRQUFRLFNBQVMsQ0FBQztBQUFBLFVBQzNDLFVBQVUsQ0FBQztBQUFBLFVBQ1gsaUJBQWlCLENBQUM7QUFBQSxVQUNsQixZQUFZO0FBQUEsUUFDZDtBQUFBLE1BQ0Y7QUFBQSxJQUNGLENBQUM7QUFDRCxVQUFNLEtBQUssT0FBTyxNQUFNO0FBQUEsTUFDdEIsT0FBTyxFQUFFLEtBQUssRUFBRSxTQUFTLEVBQUUsU0FBUyxLQUFLLEVBQUUsRUFBRTtBQUFBLElBQy9DLENBQUM7QUFDRCxPQUFHLEVBQUUsV0FBVztBQUVoQixVQUFNLFNBQVMsTUFBTSxlQUFlLElBQUk7QUFBQSxNQUN0QyxhQUFhLENBQUM7QUFBQSxNQUNkLHVCQUF1QjtBQUFBLE1BQ3ZCLDZCQUE2QjtBQUFBLElBQy9CLENBQUM7QUFFRCxXQUFPLE1BQU0sT0FBTyxRQUFRLE1BQU07QUFDbEMsV0FBTyxNQUFNLGFBQWEsR0FBRyxvREFBb0Q7QUFDakYsV0FBTyxHQUFHLG1CQUFtQixHQUFHLCtEQUErRDtBQUMvRixXQUFPLE1BQU0sWUFBWSxHQUFHLG9EQUFvRDtBQUFBLEVBQ2xGLFVBQUU7QUFDQSxrQkFBYztBQUNkLFdBQU8sVUFBVSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLEVBQ25EO0FBQ0YsQ0FBQztBQUVELEtBQUssd0RBQXdELFlBQVk7QUFDdkUsUUFBTSxXQUFXLFlBQVksS0FBSyxPQUFPLEdBQUcsZ0NBQWdDLENBQUM7QUFDN0UsWUFBVSxLQUFLLFVBQVUsUUFBUSxjQUFjLE1BQU0sR0FBRyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQzNFO0FBQUEsSUFDRSxLQUFLLFVBQVUsUUFBUSxjQUFjLFFBQVEsaUJBQWlCO0FBQUEsSUFDOUQ7QUFBQSxFQUNGO0FBQ0EsZUFBYSxLQUFLLFVBQVUsUUFBUSxRQUFRLENBQUM7QUFDN0MsTUFBSTtBQUNGLFFBQUksY0FBYztBQUNsQixRQUFJLGtCQUFrQjtBQUN0QixRQUFJLGFBQWE7QUFDakIsVUFBTSxVQUFVLG1CQUFtQjtBQUNuQyxVQUFNLE9BQU8sYUFBYSxTQUFTO0FBQUEsTUFDakMsV0FBVyxZQUFZO0FBQUU7QUFBQSxNQUFjO0FBQUEsTUFDdkMscUJBQXFCLE1BQU07QUFBRTtBQUFBLE1BQW1CO0FBQUEsTUFDaEQsYUFBYSxZQUFZO0FBQ3ZCO0FBQ0EsZUFBTztBQUFBLFVBQ0wsT0FBTztBQUFBLFVBQ1AsaUJBQWlCLEVBQUUsSUFBSSxRQUFRLE9BQU8sUUFBUSxRQUFRLFNBQVM7QUFBQSxVQUMvRCxhQUFhO0FBQUEsVUFDYixZQUFZO0FBQUEsVUFDWixVQUFVLENBQUMsRUFBRSxJQUFJLFFBQVEsUUFBUSxTQUFTLENBQUM7QUFBQSxVQUMzQyxVQUFVLENBQUM7QUFBQSxVQUNYLGlCQUFpQixDQUFDO0FBQUEsVUFDbEIsWUFBWTtBQUFBLFFBQ2Q7QUFBQSxNQUNGO0FBQUEsSUFDRixDQUFDO0FBQ0QsVUFBTSxLQUFLLE9BQU8sTUFBTTtBQUFBLE1BQ3RCLE9BQU8sRUFBRSxLQUFLLEVBQUUsU0FBUyxFQUFFLFNBQVMsS0FBSyxFQUFFLEVBQUU7QUFBQSxJQUMvQyxDQUFDO0FBQ0QsT0FBRyxFQUFFLFdBQVc7QUFFaEIsVUFBTSxTQUFTLE1BQU0sZUFBZSxJQUFJO0FBQUEsTUFDdEMsYUFBYSxDQUFDO0FBQUEsTUFDZCx1QkFBdUI7QUFBQSxNQUN2Qiw2QkFBNkI7QUFBQSxJQUMvQixDQUFDO0FBRUQsV0FBTyxNQUFNLE9BQU8sUUFBUSxPQUFPO0FBQ25DLFdBQU8sTUFBTSxPQUFPLFFBQVEscUJBQXFCO0FBQ2pELFdBQU8sTUFBTSxhQUFhLEdBQUcsNENBQTRDO0FBQ3pFLFdBQU8sR0FBRyxtQkFBbUIsR0FBRywrREFBK0Q7QUFDL0YsV0FBTyxNQUFNLFlBQVksR0FBRywrQ0FBK0M7QUFBQSxFQUM3RSxVQUFFO0FBQ0Esa0JBQWM7QUFDZCxXQUFPLFVBQVUsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxFQUNuRDtBQUNGLENBQUM7QUFFRCxLQUFLLGdFQUFnRSxZQUFZO0FBQy9FLFFBQU0sVUFBVSxtQkFBbUI7QUFDbkMsUUFBTSxPQUFPLGFBQWEsU0FBUztBQUFBLElBQ2pDLGFBQWEsYUFBYTtBQUFBLE1BQ3hCLE9BQU87QUFBQSxNQUNQLGlCQUFpQixFQUFFLElBQUksUUFBUSxPQUFPLGtCQUFrQixRQUFRLFNBQVM7QUFBQSxNQUN6RSxhQUFhLEVBQUUsSUFBSSxNQUFNO0FBQUEsTUFDekIsWUFBWSxFQUFFLElBQUksTUFBTTtBQUFBLE1BQ3hCLFVBQVU7QUFBQSxRQUNSLEVBQUUsSUFBSSxRQUFRLFFBQVEsV0FBVztBQUFBLFFBQ2pDLEVBQUUsSUFBSSxRQUFRLFFBQVEsU0FBUztBQUFBLE1BQ2pDO0FBQUEsTUFDQSxVQUFVLENBQUM7QUFBQSxJQUNiO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxLQUFLLE9BQU8sTUFBTTtBQUFBLElBQ3RCLE9BQU8sRUFBRSxLQUFLLEVBQUUsU0FBUyxFQUFFLFNBQVMsTUFBTSxFQUFFLEVBQUU7QUFBQSxFQUNoRCxDQUFDO0FBRUQsS0FBRyxFQUFFLHFCQUFxQjtBQUMxQixRQUFNLFlBQXVCLEVBQUUsYUFBYSxDQUFDLEdBQUcsdUJBQXVCLEdBQUcsNkJBQTZCLEVBQUU7QUFFekcsUUFBTSxlQUFlLElBQUksU0FBUztBQUVsQyxRQUFNLG1CQUFtQixRQUFRLE9BQU8sT0FBTyxPQUFLLEVBQUUsY0FBYyxzQkFBc0I7QUFDMUYsU0FBTyxNQUFNLGlCQUFpQixRQUFRLEdBQUcsNENBQTRDO0FBQ3JGLFNBQU8sTUFBTyxpQkFBaUIsQ0FBQyxFQUFFLEtBQWEsTUFBTSxNQUFNO0FBQzNELFNBQU8sTUFBTyxpQkFBaUIsQ0FBQyxFQUFFLEtBQWEsSUFBSSxNQUFNO0FBQ3pELFNBQU8sTUFBTSxpQkFBaUIsQ0FBQyxFQUFFLFFBQVEsR0FBRyxNQUFNO0FBQ3BELENBQUM7QUFFRCxLQUFLLHFGQUFxRixZQUFZO0FBQ3BHLFFBQU0sVUFBVSxtQkFBbUI7QUFDbkMsUUFBTSxFQUFFLDBCQUEwQixxQkFBcUIsSUFBSSxNQUFNLE9BQU8sb0JBQW9CO0FBQzVGLHVCQUFxQjtBQUVyQixNQUFJLGFBQWE7QUFDakIsTUFBSSxjQUFjO0FBQ2xCLFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxXQUFXLFlBQVk7QUFBRTtBQUFBLElBQWM7QUFBQSxJQUN2QyxnQkFBZ0IsWUFBWTtBQUMxQjtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxLQUFLLE9BQU8sSUFBSTtBQUN0QixRQUFNLFdBQTBCO0FBQUEsSUFDOUIsVUFBVTtBQUFBLElBQ1YsUUFBUTtBQUFBLElBQ1IsUUFBUTtBQUFBLElBQ1IsYUFBYTtBQUFBLElBQ2IsdUJBQXVCO0FBQUEsSUFDdkIsT0FBTyxFQUFFLE9BQU8sYUFBYSxpQkFBaUIsRUFBRSxJQUFJLE9BQU8sR0FBRyxhQUFhLEVBQUUsSUFBSSxNQUFNLEdBQUcsVUFBVSxDQUFDLEdBQUcsVUFBVSxDQUFDLEVBQUU7QUFBQSxJQUNySCxLQUFLO0FBQUEsSUFDTCxVQUFVO0FBQUEsSUFDVixTQUFTO0FBQUEsSUFDVCxjQUFjO0FBQUEsRUFDaEI7QUFDQSxRQUFNLFlBQXVCLEVBQUUsYUFBYSxDQUFDLEVBQUUsS0FBSyw0QkFBNEIsQ0FBQyxHQUFHLHVCQUF1QixHQUFHLDZCQUE2QixFQUFFO0FBRTdJLFFBQU0sY0FBYyxhQUFhLElBQUksVUFBVSxTQUFTO0FBQ3hELFFBQU0sSUFBSSxRQUFRLE9BQUssV0FBVyxHQUFHLEVBQUUsQ0FBQztBQUd4QywyQkFBeUIsRUFBRSxTQUFTLHNDQUFzQyxVQUFVLFdBQVcsYUFBYSxLQUFLLENBQUM7QUFFbEgsUUFBTSxTQUFTLE1BQU07QUFFckIsU0FBTyxNQUFNLE9BQU8sUUFBUSxPQUFPO0FBQ25DLFNBQU8sTUFBTyxPQUFlLFFBQVEsbUJBQW1CO0FBQ3hELFNBQU8sTUFBTSxZQUFZLEdBQUcsMkRBQTJEO0FBQ3ZGLFNBQU8sTUFBTSxhQUFhLEdBQUcsNERBQTREO0FBR3pGLFFBQU0sUUFBUSxVQUFVLFlBQVksVUFBVSxZQUFZLFNBQVMsQ0FBQztBQUNwRSxTQUFPLEdBQUcsTUFBTSxPQUFPLGtDQUFrQztBQUN6RCxTQUFPLEdBQUcsTUFBTSxNQUFPLFdBQVcsVUFBVSxHQUFHLGtEQUFrRDtBQUNqRyxTQUFPLEdBQUcsTUFBTSxNQUFPLFNBQVMsb0JBQW9CLEdBQUcsNkNBQTZDO0FBRXBHLFFBQU0sWUFBWSxRQUFRLE9BQU8sT0FBTyxPQUFLLEVBQUUsY0FBYyxVQUFVO0FBQ3ZFLFNBQU8sTUFBTSxVQUFVLFFBQVEsR0FBRyxrREFBa0Q7QUFDcEYsU0FBTyxNQUFPLFVBQVUsQ0FBQyxFQUFFLEtBQWEsUUFBUSxXQUFXO0FBQzNELFNBQU8sTUFBTyxVQUFVLENBQUMsRUFBRSxLQUFhLGtCQUFrQixLQUFLO0FBQy9ELFNBQU8sTUFBTyxVQUFVLENBQUMsRUFBRSxLQUFhLGFBQWEsVUFBVSxTQUFTO0FBQzFFLENBQUM7QUFFRCxLQUFLLDZFQUE2RSxZQUFZO0FBQzVGLFFBQU0sVUFBVSxtQkFBbUI7QUFDbkMsUUFBTSxFQUFFLDBCQUEwQixxQkFBcUIsSUFBSSxNQUFNLE9BQU8sb0JBQW9CO0FBQzVGLHVCQUFxQjtBQUVyQixNQUFJLGdCQUFnQjtBQUNwQixNQUFJLGNBQWM7QUFDbEIsTUFBSSxZQUFZO0FBQ2hCLFFBQU0sT0FBTyxhQUFhLFNBQVM7QUFBQSxJQUNqQyxjQUFjLFlBQVk7QUFBRTtBQUFBLElBQWlCO0FBQUEsSUFDN0MsZ0JBQWdCLFlBQVk7QUFDMUI7QUFDQSxhQUFPO0FBQUEsSUFDVDtBQUFBLElBQ0EsVUFBVSxZQUFZO0FBQUU7QUFBQSxJQUFhO0FBQUEsRUFDdkMsQ0FBQztBQUNELFFBQU0sS0FBSyxPQUFPLElBQUk7QUFDdEIsUUFBTSxXQUEwQjtBQUFBLElBQzlCLFVBQVU7QUFBQSxJQUNWLFFBQVE7QUFBQSxJQUNSLFFBQVE7QUFBQSxJQUNSLGFBQWE7QUFBQSxJQUNiLHVCQUF1QjtBQUFBLElBQ3ZCLE9BQU8sRUFBRSxPQUFPLGFBQWEsaUJBQWlCLEVBQUUsSUFBSSxPQUFPLEdBQUcsYUFBYSxFQUFFLElBQUksTUFBTSxHQUFHLFVBQVUsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxFQUFFO0FBQUEsSUFDckgsS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsY0FBYztBQUFBLEVBQ2hCO0FBQ0EsUUFBTSxZQUF1QixFQUFFLGFBQWEsQ0FBQyxFQUFFLEtBQUssNEJBQTRCLENBQUMsR0FBRyx1QkFBdUIsR0FBRyw2QkFBNkIsRUFBRTtBQUU3SSxRQUFNLGNBQWMsYUFBYSxJQUFJLFVBQVUsU0FBUztBQUN4RCxRQUFNLElBQUksUUFBUSxPQUFLLFdBQVcsR0FBRyxFQUFFLENBQUM7QUFFeEMsMkJBQXlCLEVBQUUsU0FBUyw4QkFBOEIsVUFBVSxrQkFBa0IsYUFBYSxNQUFNLENBQUM7QUFFbEgsUUFBTSxTQUFTLE1BQU07QUFDckIsU0FBTyxNQUFNLE9BQU8sUUFBUSxPQUFPO0FBQ25DLFNBQU8sTUFBTyxPQUFlLFFBQVEsZ0JBQWdCO0FBQ3JELFNBQU8sTUFBTSxlQUFlLEdBQUcsd0VBQXdFO0FBQ3ZHLFNBQU8sTUFBTSxhQUFhLEdBQUcsK0RBQStEO0FBQzVGLFNBQU8sTUFBTSxXQUFXLEdBQUcseURBQXlEO0FBRXBGLFFBQU0sWUFBWSxRQUFRLE9BQU8sT0FBTyxPQUFLLEVBQUUsY0FBYyxVQUFVO0FBQ3ZFLFNBQU8sTUFBTSxVQUFVLFFBQVEsR0FBRyxtREFBbUQ7QUFDckYsU0FBTyxNQUFPLFVBQVUsQ0FBQyxFQUFFLEtBQWEsUUFBUSxXQUFXO0FBQzNELFNBQU8sTUFBTyxVQUFVLENBQUMsRUFBRSxLQUFhLGtCQUFrQixLQUFLO0FBQy9ELFNBQU8sTUFBTyxVQUFVLENBQUMsRUFBRSxLQUFhLGFBQWEsVUFBVSxnQkFBZ0I7QUFDakYsQ0FBQztBQUVELEtBQUsseUVBQXlFLFlBQVk7QUFDeEYsUUFBTSxVQUFVLG1CQUFtQjtBQUNuQyxNQUFJLGFBQWE7QUFDakIsUUFBTSxXQUFXLFlBQVksS0FBSyxPQUFPLEdBQUcsdUJBQXVCLENBQUM7QUFFcEUsUUFBTSxPQUFPLGFBQWEsU0FBUztBQUFBLElBQ2pDLFdBQVcsWUFBWTtBQUFFO0FBQUEsSUFBYztBQUFBLElBQ3ZDLHlCQUF5QixZQUFZO0FBQ25DLFlBQU0sSUFBSSxRQUFRLE1BQU07QUFBQSxNQUFDLENBQUM7QUFDMUIsYUFBTztBQUFBLElBQ1Q7QUFBQSxFQUNGLENBQUM7QUFFRCxRQUFNLEtBQUssT0FBTyxNQUFNO0FBQUEsSUFDdEIsR0FBRztBQUFBLE1BQ0QsR0FBRyxZQUFZO0FBQUEsTUFDZjtBQUFBLE1BQ0EsYUFBYSxFQUFFLE1BQU0sZ0JBQWdCLElBQUksZ0JBQWdCLFdBQVcsS0FBSztBQUFBLElBQzNFO0FBQUEsRUFDRixDQUFDO0FBQ0QsUUFBTSxXQUEwQjtBQUFBLElBQzlCLFVBQVU7QUFBQSxJQUNWLFFBQVE7QUFBQSxJQUNSLFFBQVE7QUFBQSxJQUNSLGFBQWE7QUFBQSxJQUNiLHVCQUF1QjtBQUFBLElBQ3ZCLE9BQU8sRUFBRSxPQUFPLGFBQWEsaUJBQWlCLEVBQUUsSUFBSSxPQUFPLEdBQUcsYUFBYSxFQUFFLElBQUksTUFBTSxHQUFHLFVBQVUsQ0FBQyxHQUFHLFVBQVUsQ0FBQyxFQUFFO0FBQUEsSUFDckgsS0FBSztBQUFBLElBQ0wsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLElBQ1QsY0FBYztBQUFBLEVBQ2hCO0FBQ0EsUUFBTSxZQUF1QixFQUFFLGFBQWEsQ0FBQyxHQUFHLHVCQUF1QixHQUFHLDZCQUE2QixFQUFFO0FBRXpHLFFBQU0scUJBQXFCLFdBQVc7QUFDdEMsTUFBSTtBQUNGLGVBQVcsY0FBYyxDQUFDLFNBQW1DLGFBQXNCLFNBQ2pGLG1CQUFtQixTQUFTLEdBQUcsR0FBRyxJQUFJO0FBRXhDLFVBQU0sU0FBUyxNQUFNLFlBQVksSUFBSSxVQUFVLFNBQVM7QUFDeEQsV0FBTyxNQUFNLE9BQU8sUUFBUSxPQUFPO0FBQ25DLFdBQU8sTUFBTyxPQUFlLFFBQVEsc0JBQXNCO0FBQUEsRUFDN0QsVUFBRTtBQUNBLGVBQVcsYUFBYTtBQUFBLEVBQzFCO0FBRUEsU0FBTyxNQUFNLFlBQVksR0FBRyxpREFBaUQ7QUFDN0UsU0FBTyxNQUFNLFVBQVUsNkJBQTZCLEdBQUcsbURBQW1EO0FBQzFHLFNBQU8sTUFBTSxHQUFHLEVBQUUsYUFBYSxNQUFNLDhDQUE4QztBQUVuRixRQUFNLFVBQVUsc0JBQXNCLFVBQVUsZ0JBQWdCLGNBQWM7QUFDOUUsU0FBTyxHQUFHLFNBQVMsb0RBQW9EO0FBQ3ZFLFNBQU8sTUFBTSxTQUFTLE9BQU8sa0JBQWtCO0FBQy9DLFNBQU8sTUFBTSxTQUFTLGtCQUFrQixzQkFBc0I7QUFFOUQsUUFBTSxZQUFZLFFBQVEsT0FBTyxPQUFPLENBQUMsTUFBTSxFQUFFLGNBQWMsVUFBVTtBQUN6RSxTQUFPLE1BQU0sVUFBVSxRQUFRLEdBQUcsa0RBQWtEO0FBQ3BGLFNBQU8sTUFBTyxVQUFVLENBQUMsRUFBRSxLQUFhLFFBQVEsb0JBQW9CO0FBQ3BFLFNBQU8sTUFBTyxVQUFVLENBQUMsRUFBRSxLQUFhLGtCQUFrQixLQUFLO0FBQy9ELFNBQU8sTUFBTyxVQUFVLENBQUMsRUFBRSxLQUFhLGVBQWUsS0FBSztBQUM5RCxDQUFDO0FBRUQsS0FBSyx5RUFBeUUsWUFBWTtBQUN4RixRQUFNLFVBQVUsbUJBQW1CO0FBQ25DLFFBQU0sRUFBRSwwQkFBMEIscUJBQXFCLElBQUksTUFBTSxPQUFPLG9CQUFvQjtBQUM1Rix1QkFBcUI7QUFFckIsUUFBTSxPQUFPLGFBQWEsT0FBTztBQUNqQyxRQUFNLEtBQUssT0FBTyxJQUFJO0FBQ3RCLFFBQU0sV0FBMEI7QUFBQSxJQUM5QixVQUFVO0FBQUEsSUFDVixRQUFRO0FBQUEsSUFDUixRQUFRO0FBQUEsSUFDUixhQUFhO0FBQUEsSUFDYix1QkFBdUI7QUFBQSxJQUN2QixPQUFPLEVBQUUsT0FBTyxhQUFhLGlCQUFpQixFQUFFLElBQUksT0FBTyxHQUFHLGFBQWEsRUFBRSxJQUFJLE1BQU0sR0FBRyxVQUFVLENBQUMsR0FBRyxVQUFVLENBQUMsRUFBRTtBQUFBLElBQ3JILEtBQUs7QUFBQSxJQUNMLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxJQUNULGNBQWM7QUFBQSxFQUNoQjtBQUNBLFFBQU0sWUFBdUIsRUFBRSxhQUFhLENBQUMsRUFBRSxLQUFLLDRCQUE0QixDQUFDLEdBQUcsdUJBQXVCLEdBQUcsNkJBQTZCLEVBQUU7QUFFN0ksUUFBTSxjQUFjLGFBQWEsSUFBSSxVQUFVLFNBQVM7QUFDeEQsUUFBTSxJQUFJLFFBQVEsT0FBSyxXQUFXLEdBQUcsRUFBRSxDQUFDO0FBRXhDLDJCQUF5QixFQUFFLFNBQVMseURBQXlELFVBQVUsa0JBQWtCLGFBQWEsS0FBSyxDQUFDO0FBRTVJLFFBQU0sU0FBUyxNQUFNO0FBQ3JCLFNBQU8sTUFBTSxPQUFPLFFBQVEsT0FBTztBQUNuQyxTQUFPLE1BQU8sT0FBZSxRQUFRLGlCQUFpQjtBQUV0RCxRQUFNLFFBQVEsVUFBVSxZQUFZLFVBQVUsWUFBWSxTQUFTLENBQUM7QUFDcEUsU0FBTyxHQUFHLE1BQU0sT0FBTyxrQ0FBa0M7QUFDekQsU0FBTyxHQUFHLE1BQU0sTUFBTyxXQUFXLGlCQUFpQixHQUFHLGlEQUFpRDtBQUN6RyxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
