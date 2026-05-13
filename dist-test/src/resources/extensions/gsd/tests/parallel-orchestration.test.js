import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSessionStatus,
  readSessionStatus,
  readAllSessionStatuses,
  removeSessionStatus,
  sendSignal,
  consumeSignal,
  isSessionStale,
  cleanupStaleSessions
} from "../session-status-io.js";
import {
  formatEligibilityReport
} from "../parallel-eligibility.js";
import {
  isParallelActive,
  getOrchestratorState,
  getWorkerStatuses,
  startParallel,
  stopParallel,
  pauseWorker,
  resumeWorker,
  getAggregateCost,
  isBudgetExceeded,
  resetOrchestrator,
  refreshWorkerStatuses
} from "../parallel-orchestrator.js";
import { validatePreferences, resolveParallelConfig } from "../preferences.js";
import { determineMergeOrder, formatMergeResults } from "../parallel-merge.js";
function makeTmpBase() {
  const base = mkdtempSync(join(tmpdir(), "gsd-parallel-test-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}
function makeStatus(overrides = {}) {
  return {
    milestoneId: "M001",
    pid: process.pid,
    state: "running",
    currentUnit: { type: "execute-task", id: "M001/S01/T01", startedAt: Date.now() },
    completedUnits: 3,
    cost: 1.5,
    lastHeartbeat: Date.now(),
    startedAt: Date.now() - 6e4,
    worktreePath: "/tmp/test-worktree",
    ...overrides
  };
}
describe("session-status-io: status roundtrip", () => {
  let base;
  beforeEach(() => {
    base = makeTmpBase();
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });
  it("write then read returns identical status", () => {
    const status = makeStatus();
    writeSessionStatus(base, status);
    const read = readSessionStatus(base, "M001");
    assert.ok(read);
    assert.equal(read.milestoneId, "M001");
    assert.equal(read.pid, process.pid);
    assert.equal(read.state, "running");
    assert.equal(read.completedUnits, 3);
    assert.equal(read.cost, 1.5);
  });
  it("readSessionStatus returns null for missing milestone", () => {
    const read = readSessionStatus(base, "M999");
    assert.equal(read, null);
  });
  it("readAllSessionStatuses returns all written statuses", () => {
    writeSessionStatus(base, makeStatus({ milestoneId: "M001" }));
    writeSessionStatus(base, makeStatus({ milestoneId: "M002" }));
    writeSessionStatus(base, makeStatus({ milestoneId: "M003" }));
    const all = readAllSessionStatuses(base);
    assert.equal(all.length, 3);
    const ids = all.map((s) => s.milestoneId).sort();
    assert.deepEqual(ids, ["M001", "M002", "M003"]);
  });
  it("readAllSessionStatuses returns empty array when no parallel dir", () => {
    const all = readAllSessionStatuses(base);
    assert.equal(all.length, 0);
  });
  it("removeSessionStatus deletes the file", () => {
    writeSessionStatus(base, makeStatus());
    assert.ok(readSessionStatus(base, "M001"));
    removeSessionStatus(base, "M001");
    assert.equal(readSessionStatus(base, "M001"), null);
  });
});
describe("session-status-io: signal roundtrip", () => {
  let base;
  beforeEach(() => {
    base = makeTmpBase();
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });
  it("sendSignal then consumeSignal returns the signal", () => {
    sendSignal(base, "M001", "pause");
    const signal = consumeSignal(base, "M001");
    assert.ok(signal);
    assert.equal(signal.signal, "pause");
    assert.equal(signal.from, "coordinator");
    assert.ok(signal.sentAt > 0);
  });
  it("consumeSignal removes the signal file", () => {
    sendSignal(base, "M001", "stop");
    consumeSignal(base, "M001");
    const second = consumeSignal(base, "M001");
    assert.equal(second, null);
  });
  it("consumeSignal returns null when no signal pending", () => {
    assert.equal(consumeSignal(base, "M001"), null);
  });
});
describe("session-status-io: stale detection", () => {
  it("isSessionStale returns false for current process PID", () => {
    const status = makeStatus({ pid: process.pid, lastHeartbeat: Date.now() });
    assert.equal(isSessionStale(status), false);
  });
  it("isSessionStale returns true for dead PID", () => {
    const status = makeStatus({ pid: 2147483647, lastHeartbeat: Date.now() });
    assert.equal(isSessionStale(status), true);
  });
  it("isSessionStale returns true for expired heartbeat", () => {
    const status = makeStatus({
      pid: process.pid,
      lastHeartbeat: Date.now() - 6e4
    });
    assert.equal(isSessionStale(status, 5e3), true);
  });
  it("isSessionStale returns false for recent heartbeat with alive PID", () => {
    const status = makeStatus({
      pid: process.pid,
      lastHeartbeat: Date.now()
    });
    assert.equal(isSessionStale(status, 3e4), false);
  });
});
describe("session-status-io: cleanupStaleSessions", () => {
  let base;
  beforeEach(() => {
    base = makeTmpBase();
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });
  it("removes stale sessions and returns their IDs", () => {
    writeSessionStatus(base, makeStatus({
      milestoneId: "M001",
      pid: 2147483647
    }));
    writeSessionStatus(base, makeStatus({
      milestoneId: "M002",
      pid: process.pid,
      lastHeartbeat: Date.now()
    }));
    const removed = cleanupStaleSessions(base);
    assert.deepEqual(removed, ["M001"]);
    assert.equal(readSessionStatus(base, "M001"), null);
    assert.ok(readSessionStatus(base, "M002"));
  });
});
describe("parallel-eligibility: formatEligibilityReport", () => {
  it("formats empty candidates", () => {
    const candidates = {
      eligible: [],
      ineligible: [],
      fileOverlaps: []
    };
    const report = formatEligibilityReport(candidates);
    assert.ok(report.includes("Eligible for Parallel Execution (0)"));
    assert.ok(report.includes("No milestones are currently eligible"));
  });
  it("formats eligible milestones", () => {
    const candidates = {
      eligible: [
        { milestoneId: "M001", title: "Auth System", eligible: true, reason: "All dependencies satisfied." },
        { milestoneId: "M002", title: "Dashboard", eligible: true, reason: "All dependencies satisfied." }
      ],
      ineligible: [],
      fileOverlaps: []
    };
    const report = formatEligibilityReport(candidates);
    assert.ok(report.includes("Eligible for Parallel Execution (2)"));
    assert.ok(report.includes("**M001** \u2014 Auth System"));
    assert.ok(report.includes("**M002** \u2014 Dashboard"));
  });
  it("formats ineligible milestones with reasons", () => {
    const candidates = {
      eligible: [],
      ineligible: [
        { milestoneId: "M003", title: "API", eligible: false, reason: "Blocked by incomplete dependencies: M001." }
      ],
      fileOverlaps: []
    };
    const report = formatEligibilityReport(candidates);
    assert.ok(report.includes("Ineligible (1)"));
    assert.ok(report.includes("Blocked by incomplete dependencies"));
  });
  it("formats file overlap warnings", () => {
    const candidates = {
      eligible: [
        { milestoneId: "M001", title: "Auth", eligible: true, reason: "OK" },
        { milestoneId: "M002", title: "API", eligible: true, reason: "OK" }
      ],
      ineligible: [],
      fileOverlaps: [
        { mid1: "M001", mid2: "M002", files: ["src/types.ts", "src/utils.ts"] }
      ]
    };
    const report = formatEligibilityReport(candidates);
    assert.ok(report.includes("File Overlap Warnings (1)"));
    assert.ok(report.includes("`src/types.ts`"));
    assert.ok(report.includes("`src/utils.ts`"));
  });
});
describe("parallel-orchestrator: lifecycle", () => {
  let base;
  beforeEach(() => {
    base = makeTmpBase();
    resetOrchestrator();
  });
  afterEach(() => {
    resetOrchestrator();
    rmSync(base, { recursive: true, force: true });
  });
  it("isParallelActive returns false initially", () => {
    assert.equal(isParallelActive(), false);
  });
  it("getWorkerStatuses restores persisted workers from disk", async () => {
    const base2 = makeTmpBase();
    try {
      const persisted = {
        active: true,
        workers: [
          {
            milestoneId: "M001",
            title: "M001",
            pid: process.pid,
            worktreePath: "/tmp/wt-M001",
            startedAt: Date.now(),
            state: "running",
            cost: 0.25
          }
        ],
        totalCost: 0.25,
        startedAt: Date.now(),
        configSnapshot: { max_workers: 2 }
      };
      writeFileSync(join(base2, ".gsd", "orchestrator.json"), JSON.stringify(persisted, null, 2), "utf-8");
      const workers = getWorkerStatuses(base2);
      assert.equal(workers.length, 1);
      assert.equal(workers[0].milestoneId, "M001");
      assert.equal(isParallelActive(), true);
    } finally {
      resetOrchestrator();
      rmSync(base2, { recursive: true, force: true });
    }
  });
  it("startParallel initializes orchestrator state", async () => {
    const result = await startParallel(base, ["M001", "M002"], {
      parallel: { enabled: true, max_workers: 4, merge_strategy: "per-milestone", auto_merge: "confirm" }
    });
    assert.deepEqual(result.started, ["M001", "M002"]);
    assert.equal(result.errors.length, 0);
    assert.equal(isParallelActive(), true);
    assert.equal(getWorkerStatuses().length, 2);
  });
  it("startParallel caps to max_workers", async () => {
    const result = await startParallel(base, ["M001", "M002", "M003", "M004"], {
      parallel: { enabled: true, max_workers: 2, merge_strategy: "per-milestone", auto_merge: "confirm" }
    });
    assert.deepEqual(result.started, ["M001", "M002"]);
    assert.equal(getWorkerStatuses().length, 2);
  });
  it("startParallel writes session status files", async () => {
    await startParallel(base, ["M001"], void 0);
    const status = readSessionStatus(base, "M001");
    assert.ok(status);
    assert.equal(status.milestoneId, "M001");
    assert.ok(
      status.state === "running" || status.state === "error",
      `expected running or error, got ${status.state}`
    );
  });
  it("stopParallel stops all workers", async () => {
    await startParallel(base, ["M001", "M002"], void 0);
    await stopParallel(base);
    assert.equal(isParallelActive(), false);
    const workers = getWorkerStatuses();
    assert.ok(workers.every((w) => w.state === "stopped"));
  });
  it("stopParallel stops a specific worker", async () => {
    await startParallel(base, ["M001", "M002"], void 0);
    await stopParallel(base, "M001");
    const workers = getWorkerStatuses();
    const m1 = workers.find((w) => w.milestoneId === "M001");
    const m2 = workers.find((w) => w.milestoneId === "M002");
    assert.equal(m1?.state, "stopped");
    assert.ok(
      m2?.state === "running" || m2?.state === "error",
      `expected running or error, got ${m2?.state}`
    );
    assert.equal(isParallelActive(), true);
  });
  it("pauseWorker and resumeWorker toggle worker state", async () => {
    await startParallel(base, ["M001"], void 0);
    const initial = getWorkerStatuses()[0].state;
    if (initial === "running") {
      pauseWorker(base, "M001");
      assert.equal(getWorkerStatuses()[0].state, "paused");
      resumeWorker(base, "M001");
      assert.equal(getWorkerStatuses()[0].state, "running");
    } else {
      pauseWorker(base, "M001");
      assert.equal(getWorkerStatuses()[0].state, initial);
    }
  });
  it("pauseWorker sends pause signal", async () => {
    await startParallel(base, ["M001"], void 0);
    const w = getWorkerStatuses()[0];
    if (w.state === "running") {
      pauseWorker(base, "M001");
      const signal = consumeSignal(base, "M001");
      assert.ok(signal);
      assert.equal(signal.signal, "pause");
    } else {
      pauseWorker(base, "M001");
      const signal = consumeSignal(base, "M001");
      assert.equal(signal, null);
    }
  });
  it("refreshWorkerStatuses restores live workers from session status files when orchestrator state is absent", async () => {
    const base2 = makeTmpBase();
    try {
      writeSessionStatus(base2, {
        milestoneId: "M001",
        pid: process.pid,
        state: "running",
        currentUnit: null,
        completedUnits: 4,
        cost: 0.33,
        lastHeartbeat: Date.now(),
        startedAt: Date.now() - 1e3,
        worktreePath: "/tmp/wt-M001"
      });
      refreshWorkerStatuses(base2, { restoreIfNeeded: true });
      const workers = getWorkerStatuses();
      assert.equal(workers.length, 1);
      assert.equal(workers[0].state, "running");
    } finally {
      resetOrchestrator();
      rmSync(base2, { recursive: true, force: true });
    }
  });
});
describe("parallel-orchestrator: budget", () => {
  beforeEach(() => {
    resetOrchestrator();
  });
  afterEach(() => {
    resetOrchestrator();
  });
  it("getAggregateCost returns 0 when not active", () => {
    assert.equal(getAggregateCost(), 0);
  });
  it("isBudgetExceeded returns false when not active", () => {
    assert.equal(isBudgetExceeded(), false);
  });
  it("isBudgetExceeded returns false when no ceiling set", async () => {
    const base = makeTmpBase();
    await startParallel(base, ["M001"], void 0);
    assert.equal(isBudgetExceeded(), false);
    resetOrchestrator();
    rmSync(base, { recursive: true, force: true });
  });
  it("isBudgetExceeded returns true when ceiling reached", async () => {
    const base = makeTmpBase();
    await startParallel(base, ["M001"], {
      parallel: { enabled: true, max_workers: 2, budget_ceiling: 1, merge_strategy: "per-milestone", auto_merge: "confirm" }
    });
    const orchState = getOrchestratorState();
    if (orchState) orchState.totalCost = 1.5;
    assert.equal(isBudgetExceeded(), true);
    resetOrchestrator();
    rmSync(base, { recursive: true, force: true });
  });
});
describe("preferences: resolveParallelConfig", () => {
  it("returns defaults when prefs is undefined", () => {
    const config = resolveParallelConfig(void 0);
    assert.equal(config.enabled, false);
    assert.equal(config.max_workers, 2);
    assert.equal(config.budget_ceiling, void 0);
    assert.equal(config.merge_strategy, "per-milestone");
    assert.equal(config.auto_merge, "confirm");
  });
  it("returns defaults when parallel is undefined", () => {
    const config = resolveParallelConfig({});
    assert.equal(config.enabled, false);
    assert.equal(config.max_workers, 2);
  });
  it("fills in missing fields with defaults", () => {
    const config = resolveParallelConfig({
      parallel: { enabled: true }
    });
    assert.equal(config.enabled, true);
    assert.equal(config.max_workers, 2);
    assert.equal(config.merge_strategy, "per-milestone");
  });
  it("clamps max_workers to 1-4 range", () => {
    assert.equal(resolveParallelConfig({
      parallel: { enabled: true, max_workers: 0, merge_strategy: "per-milestone", auto_merge: "confirm" }
    }).max_workers, 1);
    assert.equal(resolveParallelConfig({
      parallel: { enabled: true, max_workers: 10, merge_strategy: "per-milestone", auto_merge: "confirm" }
    }).max_workers, 4);
  });
});
describe("preferences: validatePreferences parallel config", () => {
  it("validates valid parallel config without errors", () => {
    const result = validatePreferences({
      parallel: {
        enabled: true,
        max_workers: 3,
        budget_ceiling: 50,
        merge_strategy: "per-slice",
        auto_merge: "manual"
      }
    });
    assert.equal(result.errors.length, 0);
    assert.ok(result.preferences.parallel);
    assert.equal(result.preferences.parallel?.enabled, true);
    assert.equal(result.preferences.parallel?.max_workers, 3);
  });
  it("rejects invalid max_workers", () => {
    const result = validatePreferences({
      parallel: { max_workers: 10 }
    });
    assert.ok(result.errors.some((e) => e.includes("max_workers")));
  });
  it("rejects negative budget_ceiling", () => {
    const result = validatePreferences({
      parallel: { budget_ceiling: -5 }
    });
    assert.ok(result.errors.some((e) => e.includes("budget_ceiling")));
  });
  it("rejects invalid merge_strategy", () => {
    const result = validatePreferences({
      parallel: { merge_strategy: "invalid" }
    });
    assert.ok(result.errors.some((e) => e.includes("merge_strategy")));
  });
  it("rejects invalid auto_merge", () => {
    const result = validatePreferences({
      parallel: { auto_merge: "yolo" }
    });
    assert.ok(result.errors.some((e) => e.includes("auto_merge")));
  });
});
function makeWorker(overrides = {}) {
  return {
    milestoneId: "M001",
    title: "Test Milestone",
    pid: process.pid,
    process: null,
    worktreePath: "/tmp/test-worktree",
    startedAt: Date.now() - 6e4,
    state: "stopped",
    cost: 2.5,
    ...overrides
  };
}
describe("parallel-merge: determineMergeOrder sequential", () => {
  it("returns milestone IDs sorted alphabetically by default", () => {
    const workers = [
      makeWorker({ milestoneId: "M003", state: "stopped" }),
      makeWorker({ milestoneId: "M001", state: "stopped" }),
      makeWorker({ milestoneId: "M002", state: "stopped" })
    ];
    const order = determineMergeOrder(workers, "sequential");
    assert.deepEqual(order, ["M001", "M002", "M003"]);
  });
  it("excludes workers that are still running", () => {
    const workers = [
      makeWorker({ milestoneId: "M001", state: "stopped" }),
      makeWorker({ milestoneId: "M002", state: "running" }),
      makeWorker({ milestoneId: "M003", state: "stopped" })
    ];
    const order = determineMergeOrder(workers, "sequential");
    assert.deepEqual(order, ["M001", "M003"]);
  });
  it("includes all stopped workers", () => {
    const workers = [
      makeWorker({ milestoneId: "M001", state: "stopped" }),
      makeWorker({ milestoneId: "M002", state: "stopped" })
    ];
    const order = determineMergeOrder(workers, "sequential");
    assert.deepEqual(order, ["M001", "M002"]);
  });
  it("returns empty array when no workers are completed", () => {
    const workers = [
      makeWorker({ milestoneId: "M001", state: "running" }),
      makeWorker({ milestoneId: "M002", state: "paused" })
    ];
    const order = determineMergeOrder(workers);
    assert.deepEqual(order, []);
  });
  it("uses sequential order as the default when no order arg provided", () => {
    const workers = [
      makeWorker({ milestoneId: "M002", state: "stopped" }),
      makeWorker({ milestoneId: "M001", state: "stopped" })
    ];
    const order = determineMergeOrder(workers);
    assert.deepEqual(order, ["M001", "M002"]);
  });
});
describe("parallel-merge: determineMergeOrder by-completion", () => {
  it("returns milestones sorted by startedAt (earliest first)", () => {
    const now = Date.now();
    const workers = [
      makeWorker({ milestoneId: "M003", state: "stopped", startedAt: now - 3e4 }),
      makeWorker({ milestoneId: "M001", state: "stopped", startedAt: now - 9e4 }),
      makeWorker({ milestoneId: "M002", state: "stopped", startedAt: now - 6e4 })
    ];
    const order = determineMergeOrder(workers, "by-completion");
    assert.deepEqual(order, ["M001", "M002", "M003"]);
  });
  it("excludes paused workers from by-completion order", () => {
    const now = Date.now();
    const workers = [
      makeWorker({ milestoneId: "M001", state: "stopped", startedAt: now - 9e4 }),
      makeWorker({ milestoneId: "M002", state: "paused", startedAt: now - 6e4 }),
      makeWorker({ milestoneId: "M003", state: "stopped", startedAt: now - 3e4 })
    ];
    const order = determineMergeOrder(workers, "by-completion");
    assert.deepEqual(order, ["M001", "M003"]);
  });
});
describe("parallel-merge: formatMergeResults", () => {
  it("returns a no-op message for an empty results array", () => {
    const output = formatMergeResults([]);
    assert.equal(output, "No completed milestones to merge.");
  });
  it("formats a single successful merge without push", () => {
    const results = [
      { milestoneId: "M001", success: true, commitMessage: "feat: auth system", pushed: false }
    ];
    const output = formatMergeResults(results);
    assert.ok(output.includes("# Merge Results"));
    assert.ok(output.includes("**M001**"));
    assert.ok(output.includes("merged successfully"));
    assert.ok(!output.includes("(pushed)"));
  });
  it("includes (pushed) suffix when result.pushed is true", () => {
    const results = [
      { milestoneId: "M002", success: true, commitMessage: "feat: dashboard", pushed: true }
    ];
    const output = formatMergeResults(results);
    assert.ok(output.includes("(pushed)"));
  });
  it("formats a conflict result with file list and retry instructions", () => {
    const results = [
      {
        milestoneId: "M003",
        success: false,
        conflictFiles: ["src/types.ts", "src/utils.ts"],
        error: "Merge conflict: 2 conflicting file(s)"
      }
    ];
    const output = formatMergeResults(results);
    assert.ok(output.includes("**M003**"));
    assert.ok(output.includes("CONFLICT (2 file(s))"));
    assert.ok(output.includes("`src/types.ts`"));
    assert.ok(output.includes("`src/utils.ts`"));
    assert.ok(output.includes("/gsd parallel merge M003"));
  });
  it("formats a generic error (no conflict files) with the error message", () => {
    const results = [
      { milestoneId: "M004", success: false, error: "No roadmap found for M004" }
    ];
    const output = formatMergeResults(results);
    assert.ok(output.includes("**M004**"));
    assert.ok(output.includes("failed: No roadmap found for M004"));
    assert.ok(!output.includes("CONFLICT"));
  });
  it("formats multiple results in the order provided", () => {
    const results = [
      { milestoneId: "M001", success: true, pushed: false },
      { milestoneId: "M002", success: false, error: "branch not found" },
      { milestoneId: "M003", success: true, pushed: true }
    ];
    const output = formatMergeResults(results);
    const m1Pos = output.indexOf("M001");
    const m2Pos = output.indexOf("M002");
    const m3Pos = output.indexOf("M003");
    assert.ok(m1Pos < m2Pos, "M001 should appear before M002");
    assert.ok(m2Pos < m3Pos, "M002 should appear before M003");
  });
});
describe("doctor: stale_parallel_session issue code exists", () => {
  it("DoctorIssueCode union includes stale_parallel_session", async () => {
    const {} = await import("../doctor.js");
    const issue = {
      severity: "warning",
      code: "stale_parallel_session",
      scope: "project",
      unitId: "M001",
      message: "Stale parallel session detected",
      fixable: true
    };
    assert.equal(issue.code, "stale_parallel_session");
  });
  it("DoctorIssue with stale_parallel_session has warning severity", () => {
    const issue = {
      severity: "warning",
      code: "stale_parallel_session",
      scope: "project",
      unitId: "M002",
      message: "Stale parallel session for M002",
      fixable: true
    };
    assert.equal(issue.severity, "warning");
    assert.equal(issue.fixable, true);
    assert.equal(issue.scope, "project");
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wYXJhbGxlbC1vcmNoZXN0cmF0aW9uLnRlc3QudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogVGVzdHMgZm9yIHBhcmFsbGVsIG1pbGVzdG9uZSBvcmNoZXN0cmF0aW9uIG1vZHVsZXM6XG4gKiAtIHNlc3Npb24tc3RhdHVzLWlvLnRzIChmaWxlLWJhc2VkIElQQylcbiAqIC0gcGFyYWxsZWwtZWxpZ2liaWxpdHkudHMgKGVsaWdpYmlsaXR5IGZvcm1hdHRpbmcpXG4gKiAtIHBhcmFsbGVsLW9yY2hlc3RyYXRvci50cyAob3JjaGVzdHJhdG9yIGxpZmVjeWNsZSlcbiAqIC0gcHJlZmVyZW5jZXMudHMgKHBhcmFsbGVsIGNvbmZpZyB2YWxpZGF0aW9uKVxuICovXG5cbmltcG9ydCB7IGRlc2NyaWJlLCBpdCwgYmVmb3JlRWFjaCwgYWZ0ZXJFYWNoIH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQge1xuICBta2R0ZW1wU3luYyxcbiAgbWtkaXJTeW5jLFxuICBybVN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgbHN0YXRTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5cbmltcG9ydCB7XG4gIHdyaXRlU2Vzc2lvblN0YXR1cyxcbiAgcmVhZFNlc3Npb25TdGF0dXMsXG4gIHJlYWRBbGxTZXNzaW9uU3RhdHVzZXMsXG4gIHJlbW92ZVNlc3Npb25TdGF0dXMsXG4gIHNlbmRTaWduYWwsXG4gIGNvbnN1bWVTaWduYWwsXG4gIGlzU2Vzc2lvblN0YWxlLFxuICBjbGVhbnVwU3RhbGVTZXNzaW9ucyxcbiAgdHlwZSBTZXNzaW9uU3RhdHVzLFxufSBmcm9tIFwiLi4vc2Vzc2lvbi1zdGF0dXMtaW8uanNcIjtcblxuaW1wb3J0IHtcbiAgZm9ybWF0RWxpZ2liaWxpdHlSZXBvcnQsXG4gIHR5cGUgUGFyYWxsZWxDYW5kaWRhdGVzLFxufSBmcm9tIFwiLi4vcGFyYWxsZWwtZWxpZ2liaWxpdHkuanNcIjtcblxuaW1wb3J0IHtcbiAgaXNQYXJhbGxlbEFjdGl2ZSxcbiAgZ2V0T3JjaGVzdHJhdG9yU3RhdGUsXG4gIGdldFdvcmtlclN0YXR1c2VzLFxuICBzdGFydFBhcmFsbGVsLFxuICBzdG9wUGFyYWxsZWwsXG4gIHNodXRkb3duUGFyYWxsZWwsXG4gIHBhdXNlV29ya2VyLFxuICByZXN1bWVXb3JrZXIsXG4gIGdldEFnZ3JlZ2F0ZUNvc3QsXG4gIGlzQnVkZ2V0RXhjZWVkZWQsXG4gIHJlc2V0T3JjaGVzdHJhdG9yLFxuICByZWZyZXNoV29ya2VyU3RhdHVzZXMsXG59IGZyb20gXCIuLi9wYXJhbGxlbC1vcmNoZXN0cmF0b3IuanNcIjtcblxuaW1wb3J0IHsgdmFsaWRhdGVQcmVmZXJlbmNlcywgcmVzb2x2ZVBhcmFsbGVsQ29uZmlnIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLmpzXCI7XG5cbmltcG9ydCB7IGRldGVybWluZU1lcmdlT3JkZXIsIGZvcm1hdE1lcmdlUmVzdWx0cywgdHlwZSBNZXJnZVJlc3VsdCB9IGZyb20gXCIuLi9wYXJhbGxlbC1tZXJnZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBXb3JrZXJJbmZvIH0gZnJvbSBcIi4uL3BhcmFsbGVsLW9yY2hlc3RyYXRvci5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlVG1wQmFzZSgpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2QtcGFyYWxsZWwtdGVzdC1cIikpO1xuICBta2RpclN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICByZXR1cm4gYmFzZTtcbn1cblxuZnVuY3Rpb24gbWFrZVN0YXR1cyhvdmVycmlkZXM6IFBhcnRpYWw8U2Vzc2lvblN0YXR1cz4gPSB7fSk6IFNlc3Npb25TdGF0dXMge1xuICByZXR1cm4ge1xuICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgIHN0YXRlOiBcInJ1bm5pbmdcIixcbiAgICBjdXJyZW50VW5pdDogeyB0eXBlOiBcImV4ZWN1dGUtdGFza1wiLCBpZDogXCJNMDAxL1MwMS9UMDFcIiwgc3RhcnRlZEF0OiBEYXRlLm5vdygpIH0sXG4gICAgY29tcGxldGVkVW5pdHM6IDMsXG4gICAgY29zdDogMS41MCxcbiAgICBsYXN0SGVhcnRiZWF0OiBEYXRlLm5vdygpLFxuICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSAtIDYwXzAwMCxcbiAgICB3b3JrdHJlZVBhdGg6IFwiL3RtcC90ZXN0LXdvcmt0cmVlXCIsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgc2Vzc2lvbi1zdGF0dXMtaW8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwic2Vzc2lvbi1zdGF0dXMtaW86IHN0YXR1cyByb3VuZHRyaXBcIiwgKCkgPT4ge1xuICBsZXQgYmFzZTogc3RyaW5nO1xuICBiZWZvcmVFYWNoKCgpID0+IHsgYmFzZSA9IG1ha2VUbXBCYXNlKCk7IH0pO1xuICBhZnRlckVhY2goKCkgPT4geyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9KTtcblxuICBpdChcIndyaXRlIHRoZW4gcmVhZCByZXR1cm5zIGlkZW50aWNhbCBzdGF0dXNcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHN0YXR1cyA9IG1ha2VTdGF0dXMoKTtcbiAgICB3cml0ZVNlc3Npb25TdGF0dXMoYmFzZSwgc3RhdHVzKTtcbiAgICBjb25zdCByZWFkID0gcmVhZFNlc3Npb25TdGF0dXMoYmFzZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5vayhyZWFkKTtcbiAgICBhc3NlcnQuZXF1YWwocmVhZC5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5lcXVhbChyZWFkLnBpZCwgcHJvY2Vzcy5waWQpO1xuICAgIGFzc2VydC5lcXVhbChyZWFkLnN0YXRlLCBcInJ1bm5pbmdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWQuY29tcGxldGVkVW5pdHMsIDMpO1xuICAgIGFzc2VydC5lcXVhbChyZWFkLmNvc3QsIDEuNTApO1xuICB9KTtcblxuICBpdChcInJlYWRTZXNzaW9uU3RhdHVzIHJldHVybnMgbnVsbCBmb3IgbWlzc2luZyBtaWxlc3RvbmVcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlYWQgPSByZWFkU2Vzc2lvblN0YXR1cyhiYXNlLCBcIk05OTlcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWQsIG51bGwpO1xuICB9KTtcblxuICBpdChcInJlYWRBbGxTZXNzaW9uU3RhdHVzZXMgcmV0dXJucyBhbGwgd3JpdHRlbiBzdGF0dXNlc1wiLCAoKSA9PiB7XG4gICAgd3JpdGVTZXNzaW9uU3RhdHVzKGJhc2UsIG1ha2VTdGF0dXMoeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIgfSkpO1xuICAgIHdyaXRlU2Vzc2lvblN0YXR1cyhiYXNlLCBtYWtlU3RhdHVzKHsgbWlsZXN0b25lSWQ6IFwiTTAwMlwiIH0pKTtcbiAgICB3cml0ZVNlc3Npb25TdGF0dXMoYmFzZSwgbWFrZVN0YXR1cyh7IG1pbGVzdG9uZUlkOiBcIk0wMDNcIiB9KSk7XG4gICAgY29uc3QgYWxsID0gcmVhZEFsbFNlc3Npb25TdGF0dXNlcyhiYXNlKTtcbiAgICBhc3NlcnQuZXF1YWwoYWxsLmxlbmd0aCwgMyk7XG4gICAgY29uc3QgaWRzID0gYWxsLm1hcChzID0+IHMubWlsZXN0b25lSWQpLnNvcnQoKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKGlkcywgW1wiTTAwMVwiLCBcIk0wMDJcIiwgXCJNMDAzXCJdKTtcbiAgfSk7XG5cbiAgaXQoXCJyZWFkQWxsU2Vzc2lvblN0YXR1c2VzIHJldHVybnMgZW1wdHkgYXJyYXkgd2hlbiBubyBwYXJhbGxlbCBkaXJcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGFsbCA9IHJlYWRBbGxTZXNzaW9uU3RhdHVzZXMoYmFzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGFsbC5sZW5ndGgsIDApO1xuICB9KTtcblxuICBpdChcInJlbW92ZVNlc3Npb25TdGF0dXMgZGVsZXRlcyB0aGUgZmlsZVwiLCAoKSA9PiB7XG4gICAgd3JpdGVTZXNzaW9uU3RhdHVzKGJhc2UsIG1ha2VTdGF0dXMoKSk7XG4gICAgYXNzZXJ0Lm9rKHJlYWRTZXNzaW9uU3RhdHVzKGJhc2UsIFwiTTAwMVwiKSk7XG4gICAgcmVtb3ZlU2Vzc2lvblN0YXR1cyhiYXNlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHJlYWRTZXNzaW9uU3RhdHVzKGJhc2UsIFwiTTAwMVwiKSwgbnVsbCk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwic2Vzc2lvbi1zdGF0dXMtaW86IHNpZ25hbCByb3VuZHRyaXBcIiwgKCkgPT4ge1xuICBsZXQgYmFzZTogc3RyaW5nO1xuICBiZWZvcmVFYWNoKCgpID0+IHsgYmFzZSA9IG1ha2VUbXBCYXNlKCk7IH0pO1xuICBhZnRlckVhY2goKCkgPT4geyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9KTtcblxuICBpdChcInNlbmRTaWduYWwgdGhlbiBjb25zdW1lU2lnbmFsIHJldHVybnMgdGhlIHNpZ25hbFwiLCAoKSA9PiB7XG4gICAgc2VuZFNpZ25hbChiYXNlLCBcIk0wMDFcIiwgXCJwYXVzZVwiKTtcbiAgICBjb25zdCBzaWduYWwgPSBjb25zdW1lU2lnbmFsKGJhc2UsIFwiTTAwMVwiKTtcbiAgICBhc3NlcnQub2soc2lnbmFsKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFsLnNpZ25hbCwgXCJwYXVzZVwiKTtcbiAgICBhc3NlcnQuZXF1YWwoc2lnbmFsLmZyb20sIFwiY29vcmRpbmF0b3JcIik7XG4gICAgYXNzZXJ0Lm9rKHNpZ25hbC5zZW50QXQgPiAwKTtcbiAgfSk7XG5cbiAgaXQoXCJjb25zdW1lU2lnbmFsIHJlbW92ZXMgdGhlIHNpZ25hbCBmaWxlXCIsICgpID0+IHtcbiAgICBzZW5kU2lnbmFsKGJhc2UsIFwiTTAwMVwiLCBcInN0b3BcIik7XG4gICAgY29uc3VtZVNpZ25hbChiYXNlLCBcIk0wMDFcIik7XG4gICAgY29uc3Qgc2Vjb25kID0gY29uc3VtZVNpZ25hbChiYXNlLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKHNlY29uZCwgbnVsbCk7XG4gIH0pO1xuXG4gIGl0KFwiY29uc3VtZVNpZ25hbCByZXR1cm5zIG51bGwgd2hlbiBubyBzaWduYWwgcGVuZGluZ1wiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbnN1bWVTaWduYWwoYmFzZSwgXCJNMDAxXCIpLCBudWxsKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJzZXNzaW9uLXN0YXR1cy1pbzogc3RhbGUgZGV0ZWN0aW9uXCIsICgpID0+IHtcbiAgaXQoXCJpc1Nlc3Npb25TdGFsZSByZXR1cm5zIGZhbHNlIGZvciBjdXJyZW50IHByb2Nlc3MgUElEXCIsICgpID0+IHtcbiAgICBjb25zdCBzdGF0dXMgPSBtYWtlU3RhdHVzKHsgcGlkOiBwcm9jZXNzLnBpZCwgbGFzdEhlYXJ0YmVhdDogRGF0ZS5ub3coKSB9KTtcbiAgICBhc3NlcnQuZXF1YWwoaXNTZXNzaW9uU3RhbGUoc3RhdHVzKSwgZmFsc2UpO1xuICB9KTtcblxuICBpdChcImlzU2Vzc2lvblN0YWxlIHJldHVybnMgdHJ1ZSBmb3IgZGVhZCBQSURcIiwgKCkgPT4ge1xuICAgIC8vIFBJRCAyMTQ3NDgzNjQ3IGlzIGV4dHJlbWVseSB1bmxpa2VseSB0byBiZSBhbGl2ZVxuICAgIGNvbnN0IHN0YXR1cyA9IG1ha2VTdGF0dXMoeyBwaWQ6IDIxNDc0ODM2NDcsIGxhc3RIZWFydGJlYXQ6IERhdGUubm93KCkgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzU2Vzc2lvblN0YWxlKHN0YXR1cyksIHRydWUpO1xuICB9KTtcblxuICBpdChcImlzU2Vzc2lvblN0YWxlIHJldHVybnMgdHJ1ZSBmb3IgZXhwaXJlZCBoZWFydGJlYXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHN0YXR1cyA9IG1ha2VTdGF0dXMoe1xuICAgICAgcGlkOiBwcm9jZXNzLnBpZCxcbiAgICAgIGxhc3RIZWFydGJlYXQ6IERhdGUubm93KCkgLSA2MF8wMDAsXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKGlzU2Vzc2lvblN0YWxlKHN0YXR1cywgNV8wMDApLCB0cnVlKTtcbiAgfSk7XG5cbiAgaXQoXCJpc1Nlc3Npb25TdGFsZSByZXR1cm5zIGZhbHNlIGZvciByZWNlbnQgaGVhcnRiZWF0IHdpdGggYWxpdmUgUElEXCIsICgpID0+IHtcbiAgICBjb25zdCBzdGF0dXMgPSBtYWtlU3RhdHVzKHtcbiAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICBsYXN0SGVhcnRiZWF0OiBEYXRlLm5vdygpLFxuICAgIH0pO1xuICAgIGFzc2VydC5lcXVhbChpc1Nlc3Npb25TdGFsZShzdGF0dXMsIDMwXzAwMCksIGZhbHNlKTtcbiAgfSk7XG59KTtcblxuZGVzY3JpYmUoXCJzZXNzaW9uLXN0YXR1cy1pbzogY2xlYW51cFN0YWxlU2Vzc2lvbnNcIiwgKCkgPT4ge1xuICBsZXQgYmFzZTogc3RyaW5nO1xuICBiZWZvcmVFYWNoKCgpID0+IHsgYmFzZSA9IG1ha2VUbXBCYXNlKCk7IH0pO1xuICBhZnRlckVhY2goKCkgPT4geyBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9KTtcblxuICBpdChcInJlbW92ZXMgc3RhbGUgc2Vzc2lvbnMgYW5kIHJldHVybnMgdGhlaXIgSURzXCIsICgpID0+IHtcbiAgICAvLyBXcml0ZSBhIHN0YWxlIHNlc3Npb24gKGRlYWQgUElEKVxuICAgIHdyaXRlU2Vzc2lvblN0YXR1cyhiYXNlLCBtYWtlU3RhdHVzKHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHBpZDogMjE0NzQ4MzY0NyxcbiAgICB9KSk7XG4gICAgLy8gV3JpdGUgYSBsaXZlIHNlc3Npb25cbiAgICB3cml0ZVNlc3Npb25TdGF0dXMoYmFzZSwgbWFrZVN0YXR1cyh7XG4gICAgICBtaWxlc3RvbmVJZDogXCJNMDAyXCIsXG4gICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgbGFzdEhlYXJ0YmVhdDogRGF0ZS5ub3coKSxcbiAgICB9KSk7XG5cbiAgICBjb25zdCByZW1vdmVkID0gY2xlYW51cFN0YWxlU2Vzc2lvbnMoYmFzZSk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChyZW1vdmVkLCBbXCJNMDAxXCJdKTtcbiAgICBhc3NlcnQuZXF1YWwocmVhZFNlc3Npb25TdGF0dXMoYmFzZSwgXCJNMDAxXCIpLCBudWxsKTtcbiAgICBhc3NlcnQub2socmVhZFNlc3Npb25TdGF0dXMoYmFzZSwgXCJNMDAyXCIpKTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHBhcmFsbGVsLWVsaWdpYmlsaXR5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInBhcmFsbGVsLWVsaWdpYmlsaXR5OiBmb3JtYXRFbGlnaWJpbGl0eVJlcG9ydFwiLCAoKSA9PiB7XG4gIGl0KFwiZm9ybWF0cyBlbXB0eSBjYW5kaWRhdGVzXCIsICgpID0+IHtcbiAgICBjb25zdCBjYW5kaWRhdGVzOiBQYXJhbGxlbENhbmRpZGF0ZXMgPSB7XG4gICAgICBlbGlnaWJsZTogW10sXG4gICAgICBpbmVsaWdpYmxlOiBbXSxcbiAgICAgIGZpbGVPdmVybGFwczogW10sXG4gICAgfTtcbiAgICBjb25zdCByZXBvcnQgPSBmb3JtYXRFbGlnaWJpbGl0eVJlcG9ydChjYW5kaWRhdGVzKTtcbiAgICBhc3NlcnQub2socmVwb3J0LmluY2x1ZGVzKFwiRWxpZ2libGUgZm9yIFBhcmFsbGVsIEV4ZWN1dGlvbiAoMClcIikpO1xuICAgIGFzc2VydC5vayhyZXBvcnQuaW5jbHVkZXMoXCJObyBtaWxlc3RvbmVzIGFyZSBjdXJyZW50bHkgZWxpZ2libGVcIikpO1xuICB9KTtcblxuICBpdChcImZvcm1hdHMgZWxpZ2libGUgbWlsZXN0b25lc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgY2FuZGlkYXRlczogUGFyYWxsZWxDYW5kaWRhdGVzID0ge1xuICAgICAgZWxpZ2libGU6IFtcbiAgICAgICAgeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIkF1dGggU3lzdGVtXCIsIGVsaWdpYmxlOiB0cnVlLCByZWFzb246IFwiQWxsIGRlcGVuZGVuY2llcyBzYXRpc2ZpZWQuXCIgfSxcbiAgICAgICAgeyBtaWxlc3RvbmVJZDogXCJNMDAyXCIsIHRpdGxlOiBcIkRhc2hib2FyZFwiLCBlbGlnaWJsZTogdHJ1ZSwgcmVhc29uOiBcIkFsbCBkZXBlbmRlbmNpZXMgc2F0aXNmaWVkLlwiIH0sXG4gICAgICBdLFxuICAgICAgaW5lbGlnaWJsZTogW10sXG4gICAgICBmaWxlT3ZlcmxhcHM6IFtdLFxuICAgIH07XG4gICAgY29uc3QgcmVwb3J0ID0gZm9ybWF0RWxpZ2liaWxpdHlSZXBvcnQoY2FuZGlkYXRlcyk7XG4gICAgYXNzZXJ0Lm9rKHJlcG9ydC5pbmNsdWRlcyhcIkVsaWdpYmxlIGZvciBQYXJhbGxlbCBFeGVjdXRpb24gKDIpXCIpKTtcbiAgICBhc3NlcnQub2socmVwb3J0LmluY2x1ZGVzKFwiKipNMDAxKiogXHUyMDE0IEF1dGggU3lzdGVtXCIpKTtcbiAgICBhc3NlcnQub2socmVwb3J0LmluY2x1ZGVzKFwiKipNMDAyKiogXHUyMDE0IERhc2hib2FyZFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwiZm9ybWF0cyBpbmVsaWdpYmxlIG1pbGVzdG9uZXMgd2l0aCByZWFzb25zXCIsICgpID0+IHtcbiAgICBjb25zdCBjYW5kaWRhdGVzOiBQYXJhbGxlbENhbmRpZGF0ZXMgPSB7XG4gICAgICBlbGlnaWJsZTogW10sXG4gICAgICBpbmVsaWdpYmxlOiBbXG4gICAgICAgIHsgbWlsZXN0b25lSWQ6IFwiTTAwM1wiLCB0aXRsZTogXCJBUElcIiwgZWxpZ2libGU6IGZhbHNlLCByZWFzb246IFwiQmxvY2tlZCBieSBpbmNvbXBsZXRlIGRlcGVuZGVuY2llczogTTAwMS5cIiB9LFxuICAgICAgXSxcbiAgICAgIGZpbGVPdmVybGFwczogW10sXG4gICAgfTtcbiAgICBjb25zdCByZXBvcnQgPSBmb3JtYXRFbGlnaWJpbGl0eVJlcG9ydChjYW5kaWRhdGVzKTtcbiAgICBhc3NlcnQub2socmVwb3J0LmluY2x1ZGVzKFwiSW5lbGlnaWJsZSAoMSlcIikpO1xuICAgIGFzc2VydC5vayhyZXBvcnQuaW5jbHVkZXMoXCJCbG9ja2VkIGJ5IGluY29tcGxldGUgZGVwZW5kZW5jaWVzXCIpKTtcbiAgfSk7XG5cbiAgaXQoXCJmb3JtYXRzIGZpbGUgb3ZlcmxhcCB3YXJuaW5nc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgY2FuZGlkYXRlczogUGFyYWxsZWxDYW5kaWRhdGVzID0ge1xuICAgICAgZWxpZ2libGU6IFtcbiAgICAgICAgeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHRpdGxlOiBcIkF1dGhcIiwgZWxpZ2libGU6IHRydWUsIHJlYXNvbjogXCJPS1wiIH0sXG4gICAgICAgIHsgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLCB0aXRsZTogXCJBUElcIiwgZWxpZ2libGU6IHRydWUsIHJlYXNvbjogXCJPS1wiIH0sXG4gICAgICBdLFxuICAgICAgaW5lbGlnaWJsZTogW10sXG4gICAgICBmaWxlT3ZlcmxhcHM6IFtcbiAgICAgICAgeyBtaWQxOiBcIk0wMDFcIiwgbWlkMjogXCJNMDAyXCIsIGZpbGVzOiBbXCJzcmMvdHlwZXMudHNcIiwgXCJzcmMvdXRpbHMudHNcIl0gfSxcbiAgICAgIF0sXG4gICAgfTtcbiAgICBjb25zdCByZXBvcnQgPSBmb3JtYXRFbGlnaWJpbGl0eVJlcG9ydChjYW5kaWRhdGVzKTtcbiAgICBhc3NlcnQub2socmVwb3J0LmluY2x1ZGVzKFwiRmlsZSBPdmVybGFwIFdhcm5pbmdzICgxKVwiKSk7XG4gICAgYXNzZXJ0Lm9rKHJlcG9ydC5pbmNsdWRlcyhcImBzcmMvdHlwZXMudHNgXCIpKTtcbiAgICBhc3NlcnQub2socmVwb3J0LmluY2x1ZGVzKFwiYHNyYy91dGlscy50c2BcIikpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcGFyYWxsZWwtb3JjaGVzdHJhdG9yIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5kZXNjcmliZShcInBhcmFsbGVsLW9yY2hlc3RyYXRvcjogbGlmZWN5Y2xlXCIsICgpID0+IHtcbiAgbGV0IGJhc2U6IHN0cmluZztcbiAgYmVmb3JlRWFjaCgoKSA9PiB7XG4gICAgYmFzZSA9IG1ha2VUbXBCYXNlKCk7XG4gICAgcmVzZXRPcmNoZXN0cmF0b3IoKTtcbiAgfSk7XG4gIGFmdGVyRWFjaCgoKSA9PiB7XG4gICAgcmVzZXRPcmNoZXN0cmF0b3IoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBpdChcImlzUGFyYWxsZWxBY3RpdmUgcmV0dXJucyBmYWxzZSBpbml0aWFsbHlcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5lcXVhbChpc1BhcmFsbGVsQWN0aXZlKCksIGZhbHNlKTtcbiAgfSk7XG5cbiAgaXQoXCJnZXRXb3JrZXJTdGF0dXNlcyByZXN0b3JlcyBwZXJzaXN0ZWQgd29ya2VycyBmcm9tIGRpc2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwZXJzaXN0ZWQgPSB7XG4gICAgICAgIGFjdGl2ZTogdHJ1ZSxcbiAgICAgICAgd29ya2VyczogW1xuICAgICAgICAgIHtcbiAgICAgICAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgICAgICAgIHRpdGxlOiBcIk0wMDFcIixcbiAgICAgICAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICAgICAgICB3b3JrdHJlZVBhdGg6IFwiL3RtcC93dC1NMDAxXCIsXG4gICAgICAgICAgICBzdGFydGVkQXQ6IERhdGUubm93KCksXG4gICAgICAgICAgICBzdGF0ZTogXCJydW5uaW5nXCIsXG4gICAgICAgICAgICBjb3N0OiAwLjI1LFxuICAgICAgICAgIH0sXG4gICAgICAgIF0sXG4gICAgICAgIHRvdGFsQ29zdDogMC4yNSxcbiAgICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICBjb25maWdTbmFwc2hvdDogeyBtYXhfd29ya2VyczogMiB9LFxuICAgICAgfTtcbiAgICAgIHdyaXRlRmlsZVN5bmMoam9pbihiYXNlLCBcIi5nc2RcIiwgXCJvcmNoZXN0cmF0b3IuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkocGVyc2lzdGVkLCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcbiAgICAgIGNvbnN0IHdvcmtlcnMgPSBnZXRXb3JrZXJTdGF0dXNlcyhiYXNlKTtcbiAgICAgIGFzc2VydC5lcXVhbCh3b3JrZXJzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwod29ya2Vyc1swXS5taWxlc3RvbmVJZCwgXCJNMDAxXCIpO1xuICAgICAgYXNzZXJ0LmVxdWFsKGlzUGFyYWxsZWxBY3RpdmUoKSwgdHJ1ZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHJlc2V0T3JjaGVzdHJhdG9yKCk7XG4gICAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJzdGFydFBhcmFsbGVsIGluaXRpYWxpemVzIG9yY2hlc3RyYXRvciBzdGF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc3RhcnRQYXJhbGxlbChiYXNlLCBbXCJNMDAxXCIsIFwiTTAwMlwiXSwge1xuICAgICAgcGFyYWxsZWw6IHsgZW5hYmxlZDogdHJ1ZSwgbWF4X3dvcmtlcnM6IDQsIG1lcmdlX3N0cmF0ZWd5OiBcInBlci1taWxlc3RvbmVcIiwgYXV0b19tZXJnZTogXCJjb25maXJtXCIgfSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKHJlc3VsdC5zdGFydGVkLCBbXCJNMDAxXCIsIFwiTTAwMlwiXSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvcnMubGVuZ3RoLCAwKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNQYXJhbGxlbEFjdGl2ZSgpLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0V29ya2VyU3RhdHVzZXMoKS5sZW5ndGgsIDIpO1xuICB9KTtcblxuICBpdChcInN0YXJ0UGFyYWxsZWwgY2FwcyB0byBtYXhfd29ya2Vyc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc3RhcnRQYXJhbGxlbChiYXNlLCBbXCJNMDAxXCIsIFwiTTAwMlwiLCBcIk0wMDNcIiwgXCJNMDA0XCJdLCB7XG4gICAgICBwYXJhbGxlbDogeyBlbmFibGVkOiB0cnVlLCBtYXhfd29ya2VyczogMiwgbWVyZ2Vfc3RyYXRlZ3k6IFwicGVyLW1pbGVzdG9uZVwiLCBhdXRvX21lcmdlOiBcImNvbmZpcm1cIiB9LFxuICAgIH0pO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LnN0YXJ0ZWQsIFtcIk0wMDFcIiwgXCJNMDAyXCJdKTtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0V29ya2VyU3RhdHVzZXMoKS5sZW5ndGgsIDIpO1xuICB9KTtcblxuICBpdChcInN0YXJ0UGFyYWxsZWwgd3JpdGVzIHNlc3Npb24gc3RhdHVzIGZpbGVzXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBzdGFydFBhcmFsbGVsKGJhc2UsIFtcIk0wMDFcIl0sIHVuZGVmaW5lZCk7XG4gICAgY29uc3Qgc3RhdHVzID0gcmVhZFNlc3Npb25TdGF0dXMoYmFzZSwgXCJNMDAxXCIpO1xuICAgIGFzc2VydC5vayhzdGF0dXMpO1xuICAgIGFzc2VydC5lcXVhbChzdGF0dXMubWlsZXN0b25lSWQsIFwiTTAwMVwiKTtcbiAgICAvLyBTdGF0ZSBpcyBcInJ1bm5pbmdcIiBpZiBzcGF3biBzdWNjZWVkcywgXCJlcnJvclwiIGlmIGJpbmFyeSBub3QgZm91bmQgKENJKVxuICAgIGFzc2VydC5vayhzdGF0dXMuc3RhdGUgPT09IFwicnVubmluZ1wiIHx8IHN0YXR1cy5zdGF0ZSA9PT0gXCJlcnJvclwiLFxuICAgICAgYGV4cGVjdGVkIHJ1bm5pbmcgb3IgZXJyb3IsIGdvdCAke3N0YXR1cy5zdGF0ZX1gKTtcbiAgfSk7XG5cbiAgaXQoXCJzdG9wUGFyYWxsZWwgc3RvcHMgYWxsIHdvcmtlcnNcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGF3YWl0IHN0YXJ0UGFyYWxsZWwoYmFzZSwgW1wiTTAwMVwiLCBcIk0wMDJcIl0sIHVuZGVmaW5lZCk7XG4gICAgYXdhaXQgc3RvcFBhcmFsbGVsKGJhc2UpO1xuICAgIGFzc2VydC5lcXVhbChpc1BhcmFsbGVsQWN0aXZlKCksIGZhbHNlKTtcbiAgICBjb25zdCB3b3JrZXJzID0gZ2V0V29ya2VyU3RhdHVzZXMoKTtcbiAgICBhc3NlcnQub2sod29ya2Vycy5ldmVyeSh3ID0+IHcuc3RhdGUgPT09IFwic3RvcHBlZFwiKSk7XG4gIH0pO1xuXG4gIGl0KFwic3RvcFBhcmFsbGVsIHN0b3BzIGEgc3BlY2lmaWMgd29ya2VyXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBzdGFydFBhcmFsbGVsKGJhc2UsIFtcIk0wMDFcIiwgXCJNMDAyXCJdLCB1bmRlZmluZWQpO1xuICAgIGF3YWl0IHN0b3BQYXJhbGxlbChiYXNlLCBcIk0wMDFcIik7XG4gICAgY29uc3Qgd29ya2VycyA9IGdldFdvcmtlclN0YXR1c2VzKCk7XG4gICAgY29uc3QgbTEgPSB3b3JrZXJzLmZpbmQodyA9PiB3Lm1pbGVzdG9uZUlkID09PSBcIk0wMDFcIik7XG4gICAgY29uc3QgbTIgPSB3b3JrZXJzLmZpbmQodyA9PiB3Lm1pbGVzdG9uZUlkID09PSBcIk0wMDJcIik7XG4gICAgYXNzZXJ0LmVxdWFsKG0xPy5zdGF0ZSwgXCJzdG9wcGVkXCIpO1xuICAgIC8vIE0wMDIgaXMgXCJydW5uaW5nXCIgaWYgc3Bhd24gc3VjY2VlZGVkLCBcImVycm9yXCIgaWYgYmluYXJ5IG5vdCBmb3VuZCAoQ0kpXG4gICAgYXNzZXJ0Lm9rKG0yPy5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgfHwgbTI/LnN0YXRlID09PSBcImVycm9yXCIsXG4gICAgICBgZXhwZWN0ZWQgcnVubmluZyBvciBlcnJvciwgZ290ICR7bTI/LnN0YXRlfWApO1xuICAgIGFzc2VydC5lcXVhbChpc1BhcmFsbGVsQWN0aXZlKCksIHRydWUpO1xuICB9KTtcblxuICBpdChcInBhdXNlV29ya2VyIGFuZCByZXN1bWVXb3JrZXIgdG9nZ2xlIHdvcmtlciBzdGF0ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgYXdhaXQgc3RhcnRQYXJhbGxlbChiYXNlLCBbXCJNMDAxXCJdLCB1bmRlZmluZWQpO1xuICAgIGNvbnN0IGluaXRpYWwgPSBnZXRXb3JrZXJTdGF0dXNlcygpWzBdLnN0YXRlO1xuICAgIC8vIE9ubHkgdGVzdCBwYXVzZS9yZXN1bWUgaWYgd29ya2VyIGlzIGluIGEgcGF1c2FibGUgc3RhdGVcbiAgICBpZiAoaW5pdGlhbCA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICAgIHBhdXNlV29ya2VyKGJhc2UsIFwiTTAwMVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChnZXRXb3JrZXJTdGF0dXNlcygpWzBdLnN0YXRlLCBcInBhdXNlZFwiKTtcbiAgICAgIHJlc3VtZVdvcmtlcihiYXNlLCBcIk0wMDFcIik7XG4gICAgICBhc3NlcnQuZXF1YWwoZ2V0V29ya2VyU3RhdHVzZXMoKVswXS5zdGF0ZSwgXCJydW5uaW5nXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBTcGF3biBmYWlsZWQgKENJKSBcdTIwMTQgcGF1c2UvcmVzdW1lIGFyZSBuby1vcHMgb24gZXJyb3Igc3RhdGVcbiAgICAgIHBhdXNlV29ya2VyKGJhc2UsIFwiTTAwMVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChnZXRXb3JrZXJTdGF0dXNlcygpWzBdLnN0YXRlLCBpbml0aWFsKTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwicGF1c2VXb3JrZXIgc2VuZHMgcGF1c2Ugc2lnbmFsXCIsIGFzeW5jICgpID0+IHtcbiAgICBhd2FpdCBzdGFydFBhcmFsbGVsKGJhc2UsIFtcIk0wMDFcIl0sIHVuZGVmaW5lZCk7XG4gICAgY29uc3QgdyA9IGdldFdvcmtlclN0YXR1c2VzKClbMF07XG4gICAgaWYgKHcuc3RhdGUgPT09IFwicnVubmluZ1wiKSB7XG4gICAgICBwYXVzZVdvcmtlcihiYXNlLCBcIk0wMDFcIik7XG4gICAgICBjb25zdCBzaWduYWwgPSBjb25zdW1lU2lnbmFsKGJhc2UsIFwiTTAwMVwiKTtcbiAgICAgIGFzc2VydC5vayhzaWduYWwpO1xuICAgICAgYXNzZXJ0LmVxdWFsKHNpZ25hbC5zaWduYWwsIFwicGF1c2VcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIFNwYXduIGZhaWxlZCBcdTIwMTQgcGF1c2VXb3JrZXIgaXMgYSBuby1vcCwgc2lnbmFsIG5vdCB3cml0dGVuXG4gICAgICBwYXVzZVdvcmtlcihiYXNlLCBcIk0wMDFcIik7XG4gICAgICBjb25zdCBzaWduYWwgPSBjb25zdW1lU2lnbmFsKGJhc2UsIFwiTTAwMVwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChzaWduYWwsIG51bGwpO1xuICAgIH1cbiAgfSk7XG5cbiAgaXQoXCJyZWZyZXNoV29ya2VyU3RhdHVzZXMgcmVzdG9yZXMgbGl2ZSB3b3JrZXJzIGZyb20gc2Vzc2lvbiBzdGF0dXMgZmlsZXMgd2hlbiBvcmNoZXN0cmF0b3Igc3RhdGUgaXMgYWJzZW50XCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVTZXNzaW9uU3RhdHVzKGJhc2UsIHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgICBzdGF0ZTogXCJydW5uaW5nXCIsXG4gICAgICAgIGN1cnJlbnRVbml0OiBudWxsLFxuICAgICAgICBjb21wbGV0ZWRVbml0czogNCxcbiAgICAgICAgY29zdDogMC4zMyxcbiAgICAgICAgbGFzdEhlYXJ0YmVhdDogRGF0ZS5ub3coKSxcbiAgICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpIC0gMTAwMCxcbiAgICAgICAgd29ya3RyZWVQYXRoOiBcIi90bXAvd3QtTTAwMVwiLFxuICAgICAgfSk7XG4gICAgICByZWZyZXNoV29ya2VyU3RhdHVzZXMoYmFzZSwgeyByZXN0b3JlSWZOZWVkZWQ6IHRydWUgfSk7XG4gICAgICBjb25zdCB3b3JrZXJzID0gZ2V0V29ya2VyU3RhdHVzZXMoKTtcbiAgICAgIGFzc2VydC5lcXVhbCh3b3JrZXJzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwod29ya2Vyc1swXS5zdGF0ZSwgXCJydW5uaW5nXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICByZXNldE9yY2hlc3RyYXRvcigpO1xuICAgICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwicGFyYWxsZWwtb3JjaGVzdHJhdG9yOiBidWRnZXRcIiwgKCkgPT4ge1xuICBiZWZvcmVFYWNoKCgpID0+IHsgcmVzZXRPcmNoZXN0cmF0b3IoKTsgfSk7XG4gIGFmdGVyRWFjaCgoKSA9PiB7IHJlc2V0T3JjaGVzdHJhdG9yKCk7IH0pO1xuXG4gIGl0KFwiZ2V0QWdncmVnYXRlQ29zdCByZXR1cm5zIDAgd2hlbiBub3QgYWN0aXZlXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoZ2V0QWdncmVnYXRlQ29zdCgpLCAwKTtcbiAgfSk7XG5cbiAgaXQoXCJpc0J1ZGdldEV4Y2VlZGVkIHJldHVybnMgZmFsc2Ugd2hlbiBub3QgYWN0aXZlXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwoaXNCdWRnZXRFeGNlZWRlZCgpLCBmYWxzZSk7XG4gIH0pO1xuXG4gIGl0KFwiaXNCdWRnZXRFeGNlZWRlZCByZXR1cm5zIGZhbHNlIHdoZW4gbm8gY2VpbGluZyBzZXRcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2UgPSBtYWtlVG1wQmFzZSgpO1xuICAgIGF3YWl0IHN0YXJ0UGFyYWxsZWwoYmFzZSwgW1wiTTAwMVwiXSwgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQuZXF1YWwoaXNCdWRnZXRFeGNlZWRlZCgpLCBmYWxzZSk7XG4gICAgcmVzZXRPcmNoZXN0cmF0b3IoKTtcbiAgICBybVN5bmMoYmFzZSwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9KTtcblxuICBpdChcImlzQnVkZ2V0RXhjZWVkZWQgcmV0dXJucyB0cnVlIHdoZW4gY2VpbGluZyByZWFjaGVkXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlID0gbWFrZVRtcEJhc2UoKTtcbiAgICBhd2FpdCBzdGFydFBhcmFsbGVsKGJhc2UsIFtcIk0wMDFcIl0sIHtcbiAgICAgIHBhcmFsbGVsOiB7IGVuYWJsZWQ6IHRydWUsIG1heF93b3JrZXJzOiAyLCBidWRnZXRfY2VpbGluZzogMS4wMCwgbWVyZ2Vfc3RyYXRlZ3k6IFwicGVyLW1pbGVzdG9uZVwiLCBhdXRvX21lcmdlOiBcImNvbmZpcm1cIiB9LFxuICAgIH0pO1xuICAgIC8vIE1hbnVhbGx5IHNldCB0b3RhbENvc3QgdG8gdGVzdCBidWRnZXQgY2hlY2tcbiAgICBjb25zdCBvcmNoU3RhdGUgPSBnZXRPcmNoZXN0cmF0b3JTdGF0ZSgpO1xuICAgIGlmIChvcmNoU3RhdGUpIG9yY2hTdGF0ZS50b3RhbENvc3QgPSAxLjUwO1xuICAgIGFzc2VydC5lcXVhbChpc0J1ZGdldEV4Y2VlZGVkKCksIHRydWUpO1xuICAgIHJlc2V0T3JjaGVzdHJhdG9yKCk7XG4gICAgcm1TeW5jKGJhc2UsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfSk7XG59KTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIHByZWZlcmVuY2VzOiBwYXJhbGxlbCBjb25maWcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwicHJlZmVyZW5jZXM6IHJlc29sdmVQYXJhbGxlbENvbmZpZ1wiLCAoKSA9PiB7XG4gIGl0KFwicmV0dXJucyBkZWZhdWx0cyB3aGVuIHByZWZzIGlzIHVuZGVmaW5lZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnID0gcmVzb2x2ZVBhcmFsbGVsQ29uZmlnKHVuZGVmaW5lZCk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbmZpZy5lbmFibGVkLCBmYWxzZSk7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbmZpZy5tYXhfd29ya2VycywgMik7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbmZpZy5idWRnZXRfY2VpbGluZywgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQuZXF1YWwoY29uZmlnLm1lcmdlX3N0cmF0ZWd5LCBcInBlci1taWxlc3RvbmVcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGNvbmZpZy5hdXRvX21lcmdlLCBcImNvbmZpcm1cIik7XG4gIH0pO1xuXG4gIGl0KFwicmV0dXJucyBkZWZhdWx0cyB3aGVuIHBhcmFsbGVsIGlzIHVuZGVmaW5lZFwiLCAoKSA9PiB7XG4gICAgY29uc3QgY29uZmlnID0gcmVzb2x2ZVBhcmFsbGVsQ29uZmlnKHt9KTtcbiAgICBhc3NlcnQuZXF1YWwoY29uZmlnLmVuYWJsZWQsIGZhbHNlKTtcbiAgICBhc3NlcnQuZXF1YWwoY29uZmlnLm1heF93b3JrZXJzLCAyKTtcbiAgfSk7XG5cbiAgaXQoXCJmaWxscyBpbiBtaXNzaW5nIGZpZWxkcyB3aXRoIGRlZmF1bHRzXCIsICgpID0+IHtcbiAgICBjb25zdCBjb25maWcgPSByZXNvbHZlUGFyYWxsZWxDb25maWcoe1xuICAgICAgcGFyYWxsZWw6IHsgZW5hYmxlZDogdHJ1ZSB9IGFzIGFueSxcbiAgICB9KTtcbiAgICBhc3NlcnQuZXF1YWwoY29uZmlnLmVuYWJsZWQsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChjb25maWcubWF4X3dvcmtlcnMsIDIpO1xuICAgIGFzc2VydC5lcXVhbChjb25maWcubWVyZ2Vfc3RyYXRlZ3ksIFwicGVyLW1pbGVzdG9uZVwiKTtcbiAgfSk7XG5cbiAgaXQoXCJjbGFtcHMgbWF4X3dvcmtlcnMgdG8gMS00IHJhbmdlXCIsICgpID0+IHtcbiAgICBhc3NlcnQuZXF1YWwocmVzb2x2ZVBhcmFsbGVsQ29uZmlnKHtcbiAgICAgIHBhcmFsbGVsOiB7IGVuYWJsZWQ6IHRydWUsIG1heF93b3JrZXJzOiAwLCBtZXJnZV9zdHJhdGVneTogXCJwZXItbWlsZXN0b25lXCIsIGF1dG9fbWVyZ2U6IFwiY29uZmlybVwiIH0sXG4gICAgfSkubWF4X3dvcmtlcnMsIDEpO1xuICAgIGFzc2VydC5lcXVhbChyZXNvbHZlUGFyYWxsZWxDb25maWcoe1xuICAgICAgcGFyYWxsZWw6IHsgZW5hYmxlZDogdHJ1ZSwgbWF4X3dvcmtlcnM6IDEwLCBtZXJnZV9zdHJhdGVneTogXCJwZXItbWlsZXN0b25lXCIsIGF1dG9fbWVyZ2U6IFwiY29uZmlybVwiIH0sXG4gICAgfSkubWF4X3dvcmtlcnMsIDQpO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcInByZWZlcmVuY2VzOiB2YWxpZGF0ZVByZWZlcmVuY2VzIHBhcmFsbGVsIGNvbmZpZ1wiLCAoKSA9PiB7XG4gIGl0KFwidmFsaWRhdGVzIHZhbGlkIHBhcmFsbGVsIGNvbmZpZyB3aXRob3V0IGVycm9yc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVQcmVmZXJlbmNlcyh7XG4gICAgICBwYXJhbGxlbDoge1xuICAgICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgICBtYXhfd29ya2VyczogMyxcbiAgICAgICAgYnVkZ2V0X2NlaWxpbmc6IDUwLjAwLFxuICAgICAgICBtZXJnZV9zdHJhdGVneTogXCJwZXItc2xpY2VcIixcbiAgICAgICAgYXV0b19tZXJnZTogXCJtYW51YWxcIixcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgYXNzZXJ0LmVxdWFsKHJlc3VsdC5lcnJvcnMubGVuZ3RoLCAwKTtcbiAgICBhc3NlcnQub2socmVzdWx0LnByZWZlcmVuY2VzLnBhcmFsbGVsKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnByZWZlcmVuY2VzLnBhcmFsbGVsPy5lbmFibGVkLCB0cnVlKTtcbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LnByZWZlcmVuY2VzLnBhcmFsbGVsPy5tYXhfd29ya2VycywgMyk7XG4gIH0pO1xuXG4gIGl0KFwicmVqZWN0cyBpbnZhbGlkIG1heF93b3JrZXJzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVByZWZlcmVuY2VzKHtcbiAgICAgIHBhcmFsbGVsOiB7IG1heF93b3JrZXJzOiAxMCB9IGFzIGFueSxcbiAgICB9KTtcbiAgICBhc3NlcnQub2socmVzdWx0LmVycm9ycy5zb21lKGUgPT4gZS5pbmNsdWRlcyhcIm1heF93b3JrZXJzXCIpKSk7XG4gIH0pO1xuXG4gIGl0KFwicmVqZWN0cyBuZWdhdGl2ZSBidWRnZXRfY2VpbGluZ1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVQcmVmZXJlbmNlcyh7XG4gICAgICBwYXJhbGxlbDogeyBidWRnZXRfY2VpbGluZzogLTUgfSBhcyBhbnksXG4gICAgfSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZShlID0+IGUuaW5jbHVkZXMoXCJidWRnZXRfY2VpbGluZ1wiKSkpO1xuICB9KTtcblxuICBpdChcInJlamVjdHMgaW52YWxpZCBtZXJnZV9zdHJhdGVneVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVQcmVmZXJlbmNlcyh7XG4gICAgICBwYXJhbGxlbDogeyBtZXJnZV9zdHJhdGVneTogXCJpbnZhbGlkXCIgfSBhcyBhbnksXG4gICAgfSk7XG4gICAgYXNzZXJ0Lm9rKHJlc3VsdC5lcnJvcnMuc29tZShlID0+IGUuaW5jbHVkZXMoXCJtZXJnZV9zdHJhdGVneVwiKSkpO1xuICB9KTtcblxuICBpdChcInJlamVjdHMgaW52YWxpZCBhdXRvX21lcmdlXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVByZWZlcmVuY2VzKHtcbiAgICAgIHBhcmFsbGVsOiB7IGF1dG9fbWVyZ2U6IFwieW9sb1wiIH0gYXMgYW55LFxuICAgIH0pO1xuICAgIGFzc2VydC5vayhyZXN1bHQuZXJyb3JzLnNvbWUoZSA9PiBlLmluY2x1ZGVzKFwiYXV0b19tZXJnZVwiKSkpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVGVzdCBIZWxwZXJzIChwYXJhbGxlbC1tZXJnZSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIG1ha2VXb3JrZXIob3ZlcnJpZGVzOiBQYXJ0aWFsPFdvcmtlckluZm8+ID0ge30pOiBXb3JrZXJJbmZvIHtcbiAgcmV0dXJuIHtcbiAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgdGl0bGU6IFwiVGVzdCBNaWxlc3RvbmVcIixcbiAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgIHByb2Nlc3M6IG51bGwsXG4gICAgd29ya3RyZWVQYXRoOiBcIi90bXAvdGVzdC13b3JrdHJlZVwiLFxuICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSAtIDYwXzAwMCxcbiAgICBzdGF0ZTogXCJzdG9wcGVkXCIsXG4gICAgY29zdDogMi41MCxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBwYXJhbGxlbC1tZXJnZTogZGV0ZXJtaW5lTWVyZ2VPcmRlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJwYXJhbGxlbC1tZXJnZTogZGV0ZXJtaW5lTWVyZ2VPcmRlciBzZXF1ZW50aWFsXCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIG1pbGVzdG9uZSBJRHMgc29ydGVkIGFscGhhYmV0aWNhbGx5IGJ5IGRlZmF1bHRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHdvcmtlcnMgPSBbXG4gICAgICBtYWtlV29ya2VyKHsgbWlsZXN0b25lSWQ6IFwiTTAwM1wiLCBzdGF0ZTogXCJzdG9wcGVkXCIgfSksXG4gICAgICBtYWtlV29ya2VyKHsgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBzdGF0ZTogXCJzdG9wcGVkXCIgfSksXG4gICAgICBtYWtlV29ya2VyKHsgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLCBzdGF0ZTogXCJzdG9wcGVkXCIgfSksXG4gICAgXTtcbiAgICBjb25zdCBvcmRlciA9IGRldGVybWluZU1lcmdlT3JkZXIod29ya2VycywgXCJzZXF1ZW50aWFsXCIpO1xuICAgIGFzc2VydC5kZWVwRXF1YWwob3JkZXIsIFtcIk0wMDFcIiwgXCJNMDAyXCIsIFwiTTAwM1wiXSk7XG4gIH0pO1xuXG4gIGl0KFwiZXhjbHVkZXMgd29ya2VycyB0aGF0IGFyZSBzdGlsbCBydW5uaW5nXCIsICgpID0+IHtcbiAgICBjb25zdCB3b3JrZXJzID0gW1xuICAgICAgbWFrZVdvcmtlcih7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc3RhdGU6IFwic3RvcHBlZFwiIH0pLFxuICAgICAgbWFrZVdvcmtlcih7IG1pbGVzdG9uZUlkOiBcIk0wMDJcIiwgc3RhdGU6IFwicnVubmluZ1wiIH0pLFxuICAgICAgbWFrZVdvcmtlcih7IG1pbGVzdG9uZUlkOiBcIk0wMDNcIiwgc3RhdGU6IFwic3RvcHBlZFwiIH0pLFxuICAgIF07XG4gICAgY29uc3Qgb3JkZXIgPSBkZXRlcm1pbmVNZXJnZU9yZGVyKHdvcmtlcnMsIFwic2VxdWVudGlhbFwiKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG9yZGVyLCBbXCJNMDAxXCIsIFwiTTAwM1wiXSk7XG4gIH0pO1xuXG4gIGl0KFwiaW5jbHVkZXMgYWxsIHN0b3BwZWQgd29ya2Vyc1wiLCAoKSA9PiB7XG4gICAgY29uc3Qgd29ya2VycyA9IFtcbiAgICAgIG1ha2VXb3JrZXIoeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHN0YXRlOiBcInN0b3BwZWRcIiB9KSxcbiAgICAgIG1ha2VXb3JrZXIoeyBtaWxlc3RvbmVJZDogXCJNMDAyXCIsIHN0YXRlOiBcInN0b3BwZWRcIiB9KSxcbiAgICBdO1xuICAgIGNvbnN0IG9yZGVyID0gZGV0ZXJtaW5lTWVyZ2VPcmRlcih3b3JrZXJzLCBcInNlcXVlbnRpYWxcIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChvcmRlciwgW1wiTTAwMVwiLCBcIk0wMDJcIl0pO1xuICB9KTtcblxuICBpdChcInJldHVybnMgZW1wdHkgYXJyYXkgd2hlbiBubyB3b3JrZXJzIGFyZSBjb21wbGV0ZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHdvcmtlcnMgPSBbXG4gICAgICBtYWtlV29ya2VyKHsgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBzdGF0ZTogXCJydW5uaW5nXCIgfSksXG4gICAgICBtYWtlV29ya2VyKHsgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLCBzdGF0ZTogXCJwYXVzZWRcIiB9KSxcbiAgICBdO1xuICAgIGNvbnN0IG9yZGVyID0gZGV0ZXJtaW5lTWVyZ2VPcmRlcih3b3JrZXJzKTtcbiAgICBhc3NlcnQuZGVlcEVxdWFsKG9yZGVyLCBbXSk7XG4gIH0pO1xuXG4gIGl0KFwidXNlcyBzZXF1ZW50aWFsIG9yZGVyIGFzIHRoZSBkZWZhdWx0IHdoZW4gbm8gb3JkZXIgYXJnIHByb3ZpZGVkXCIsICgpID0+IHtcbiAgICBjb25zdCB3b3JrZXJzID0gW1xuICAgICAgbWFrZVdvcmtlcih7IG1pbGVzdG9uZUlkOiBcIk0wMDJcIiwgc3RhdGU6IFwic3RvcHBlZFwiIH0pLFxuICAgICAgbWFrZVdvcmtlcih7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc3RhdGU6IFwic3RvcHBlZFwiIH0pLFxuICAgIF07XG4gICAgLy8gQ2FsbCB3aXRoIG5vIHNlY29uZCBhcmd1bWVudCBcdTIwMTQgc2hvdWxkIGRlZmF1bHQgdG8gXCJzZXF1ZW50aWFsXCJcbiAgICBjb25zdCBvcmRlciA9IGRldGVybWluZU1lcmdlT3JkZXIod29ya2Vycyk7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChvcmRlciwgW1wiTTAwMVwiLCBcIk0wMDJcIl0pO1xuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcInBhcmFsbGVsLW1lcmdlOiBkZXRlcm1pbmVNZXJnZU9yZGVyIGJ5LWNvbXBsZXRpb25cIiwgKCkgPT4ge1xuICBpdChcInJldHVybnMgbWlsZXN0b25lcyBzb3J0ZWQgYnkgc3RhcnRlZEF0IChlYXJsaWVzdCBmaXJzdClcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgY29uc3Qgd29ya2VycyA9IFtcbiAgICAgIG1ha2VXb3JrZXIoeyBtaWxlc3RvbmVJZDogXCJNMDAzXCIsIHN0YXRlOiBcInN0b3BwZWRcIiwgc3RhcnRlZEF0OiBub3cgLSAzMF8wMDAgfSksXG4gICAgICBtYWtlV29ya2VyKHsgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLCBzdGF0ZTogXCJzdG9wcGVkXCIsIHN0YXJ0ZWRBdDogbm93IC0gOTBfMDAwIH0pLFxuICAgICAgbWFrZVdvcmtlcih7IG1pbGVzdG9uZUlkOiBcIk0wMDJcIiwgc3RhdGU6IFwic3RvcHBlZFwiLCBzdGFydGVkQXQ6IG5vdyAtIDYwXzAwMCB9KSxcbiAgICBdO1xuICAgIGNvbnN0IG9yZGVyID0gZGV0ZXJtaW5lTWVyZ2VPcmRlcih3b3JrZXJzLCBcImJ5LWNvbXBsZXRpb25cIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChvcmRlciwgW1wiTTAwMVwiLCBcIk0wMDJcIiwgXCJNMDAzXCJdKTtcbiAgfSk7XG5cbiAgaXQoXCJleGNsdWRlcyBwYXVzZWQgd29ya2VycyBmcm9tIGJ5LWNvbXBsZXRpb24gb3JkZXJcIiwgKCkgPT4ge1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgY29uc3Qgd29ya2VycyA9IFtcbiAgICAgIG1ha2VXb3JrZXIoeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHN0YXRlOiBcInN0b3BwZWRcIiwgc3RhcnRlZEF0OiBub3cgLSA5MF8wMDAgfSksXG4gICAgICBtYWtlV29ya2VyKHsgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLCBzdGF0ZTogXCJwYXVzZWRcIiwgIHN0YXJ0ZWRBdDogbm93IC0gNjBfMDAwIH0pLFxuICAgICAgbWFrZVdvcmtlcih7IG1pbGVzdG9uZUlkOiBcIk0wMDNcIiwgc3RhdGU6IFwic3RvcHBlZFwiLCBzdGFydGVkQXQ6IG5vdyAtIDMwXzAwMCB9KSxcbiAgICBdO1xuICAgIGNvbnN0IG9yZGVyID0gZGV0ZXJtaW5lTWVyZ2VPcmRlcih3b3JrZXJzLCBcImJ5LWNvbXBsZXRpb25cIik7XG4gICAgYXNzZXJ0LmRlZXBFcXVhbChvcmRlciwgW1wiTTAwMVwiLCBcIk0wMDNcIl0pO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgcGFyYWxsZWwtbWVyZ2U6IGZvcm1hdE1lcmdlUmVzdWx0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZGVzY3JpYmUoXCJwYXJhbGxlbC1tZXJnZTogZm9ybWF0TWVyZ2VSZXN1bHRzXCIsICgpID0+IHtcbiAgaXQoXCJyZXR1cm5zIGEgbm8tb3AgbWVzc2FnZSBmb3IgYW4gZW1wdHkgcmVzdWx0cyBhcnJheVwiLCAoKSA9PiB7XG4gICAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0TWVyZ2VSZXN1bHRzKFtdKTtcbiAgICBhc3NlcnQuZXF1YWwob3V0cHV0LCBcIk5vIGNvbXBsZXRlZCBtaWxlc3RvbmVzIHRvIG1lcmdlLlwiKTtcbiAgfSk7XG5cbiAgaXQoXCJmb3JtYXRzIGEgc2luZ2xlIHN1Y2Nlc3NmdWwgbWVyZ2Ugd2l0aG91dCBwdXNoXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHRzOiBNZXJnZVJlc3VsdFtdID0gW1xuICAgICAgeyBtaWxlc3RvbmVJZDogXCJNMDAxXCIsIHN1Y2Nlc3M6IHRydWUsIGNvbW1pdE1lc3NhZ2U6IFwiZmVhdDogYXV0aCBzeXN0ZW1cIiwgcHVzaGVkOiBmYWxzZSB9LFxuICAgIF07XG4gICAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0TWVyZ2VSZXN1bHRzKHJlc3VsdHMpO1xuICAgIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCIjIE1lcmdlIFJlc3VsdHNcIikpO1xuICAgIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCIqKk0wMDEqKlwiKSk7XG4gICAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIm1lcmdlZCBzdWNjZXNzZnVsbHlcIikpO1xuICAgIGFzc2VydC5vayghb3V0cHV0LmluY2x1ZGVzKFwiKHB1c2hlZClcIikpO1xuICB9KTtcblxuICBpdChcImluY2x1ZGVzIChwdXNoZWQpIHN1ZmZpeCB3aGVuIHJlc3VsdC5wdXNoZWQgaXMgdHJ1ZVwiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0czogTWVyZ2VSZXN1bHRbXSA9IFtcbiAgICAgIHsgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLCBzdWNjZXNzOiB0cnVlLCBjb21taXRNZXNzYWdlOiBcImZlYXQ6IGRhc2hib2FyZFwiLCBwdXNoZWQ6IHRydWUgfSxcbiAgICBdO1xuICAgIGNvbnN0IG91dHB1dCA9IGZvcm1hdE1lcmdlUmVzdWx0cyhyZXN1bHRzKTtcbiAgICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiKHB1c2hlZClcIikpO1xuICB9KTtcblxuICBpdChcImZvcm1hdHMgYSBjb25mbGljdCByZXN1bHQgd2l0aCBmaWxlIGxpc3QgYW5kIHJldHJ5IGluc3RydWN0aW9uc1wiLCAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0czogTWVyZ2VSZXN1bHRbXSA9IFtcbiAgICAgIHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwM1wiLFxuICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgY29uZmxpY3RGaWxlczogW1wic3JjL3R5cGVzLnRzXCIsIFwic3JjL3V0aWxzLnRzXCJdLFxuICAgICAgICBlcnJvcjogXCJNZXJnZSBjb25mbGljdDogMiBjb25mbGljdGluZyBmaWxlKHMpXCIsXG4gICAgICB9LFxuICAgIF07XG4gICAgY29uc3Qgb3V0cHV0ID0gZm9ybWF0TWVyZ2VSZXN1bHRzKHJlc3VsdHMpO1xuICAgIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCIqKk0wMDMqKlwiKSk7XG4gICAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIkNPTkZMSUNUICgyIGZpbGUocykpXCIpKTtcbiAgICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiYHNyYy90eXBlcy50c2BcIikpO1xuICAgIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJgc3JjL3V0aWxzLnRzYFwiKSk7XG4gICAgYXNzZXJ0Lm9rKG91dHB1dC5pbmNsdWRlcyhcIi9nc2QgcGFyYWxsZWwgbWVyZ2UgTTAwM1wiKSk7XG4gIH0pO1xuXG4gIGl0KFwiZm9ybWF0cyBhIGdlbmVyaWMgZXJyb3IgKG5vIGNvbmZsaWN0IGZpbGVzKSB3aXRoIHRoZSBlcnJvciBtZXNzYWdlXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHRzOiBNZXJnZVJlc3VsdFtdID0gW1xuICAgICAgeyBtaWxlc3RvbmVJZDogXCJNMDA0XCIsIHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJObyByb2FkbWFwIGZvdW5kIGZvciBNMDA0XCIgfSxcbiAgICBdO1xuICAgIGNvbnN0IG91dHB1dCA9IGZvcm1hdE1lcmdlUmVzdWx0cyhyZXN1bHRzKTtcbiAgICBhc3NlcnQub2sob3V0cHV0LmluY2x1ZGVzKFwiKipNMDA0KipcIikpO1xuICAgIGFzc2VydC5vayhvdXRwdXQuaW5jbHVkZXMoXCJmYWlsZWQ6IE5vIHJvYWRtYXAgZm91bmQgZm9yIE0wMDRcIikpO1xuICAgIGFzc2VydC5vayghb3V0cHV0LmluY2x1ZGVzKFwiQ09ORkxJQ1RcIikpO1xuICB9KTtcblxuICBpdChcImZvcm1hdHMgbXVsdGlwbGUgcmVzdWx0cyBpbiB0aGUgb3JkZXIgcHJvdmlkZWRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHJlc3VsdHM6IE1lcmdlUmVzdWx0W10gPSBbXG4gICAgICB7IG1pbGVzdG9uZUlkOiBcIk0wMDFcIiwgc3VjY2VzczogdHJ1ZSwgcHVzaGVkOiBmYWxzZSB9LFxuICAgICAgeyBtaWxlc3RvbmVJZDogXCJNMDAyXCIsIHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJicmFuY2ggbm90IGZvdW5kXCIgfSxcbiAgICAgIHsgbWlsZXN0b25lSWQ6IFwiTTAwM1wiLCBzdWNjZXNzOiB0cnVlLCBwdXNoZWQ6IHRydWUgfSxcbiAgICBdO1xuICAgIGNvbnN0IG91dHB1dCA9IGZvcm1hdE1lcmdlUmVzdWx0cyhyZXN1bHRzKTtcbiAgICBjb25zdCBtMVBvcyA9IG91dHB1dC5pbmRleE9mKFwiTTAwMVwiKTtcbiAgICBjb25zdCBtMlBvcyA9IG91dHB1dC5pbmRleE9mKFwiTTAwMlwiKTtcbiAgICBjb25zdCBtM1BvcyA9IG91dHB1dC5pbmRleE9mKFwiTTAwM1wiKTtcbiAgICBhc3NlcnQub2sobTFQb3MgPCBtMlBvcywgXCJNMDAxIHNob3VsZCBhcHBlYXIgYmVmb3JlIE0wMDJcIik7XG4gICAgYXNzZXJ0Lm9rKG0yUG9zIDwgbTNQb3MsIFwiTTAwMiBzaG91bGQgYXBwZWFyIGJlZm9yZSBNMDAzXCIpO1xuICB9KTtcbn0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgZG9jdG9yOiBzdGFsZV9wYXJhbGxlbF9zZXNzaW9uIGlzc3VlIGNvZGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmRlc2NyaWJlKFwiZG9jdG9yOiBzdGFsZV9wYXJhbGxlbF9zZXNzaW9uIGlzc3VlIGNvZGUgZXhpc3RzXCIsICgpID0+IHtcbiAgaXQoXCJEb2N0b3JJc3N1ZUNvZGUgdW5pb24gaW5jbHVkZXMgc3RhbGVfcGFyYWxsZWxfc2Vzc2lvblwiLCBhc3luYyAoKSA9PiB7XG4gICAgLy8gSW1wb3J0IGRvY3Rvci50cyBhbmQgdmVyaWZ5IHRoZSB0eXBlIGlzIHJlYWwgYnkgY29uc3RydWN0aW5nIGEgRG9jdG9ySXNzdWVcbiAgICAvLyB3aXRoIGNvZGUgXCJzdGFsZV9wYXJhbGxlbF9zZXNzaW9uXCIgXHUyMDE0IFR5cGVTY3JpcHQgd2lsbCByZWplY3QgaXQgYXQgY29tcGlsZVxuICAgIC8vIHRpbWUgaWYgdGhlIGNvZGUgaXMgbm90IGluIHRoZSB1bmlvbjsgdGhlIHJ1bnRpbWUgYXNzZXJ0aW9uIGNvbmZpcm1zIHRoZVxuICAgIC8vIHN0cmluZyB2YWx1ZSByb3VuZC10cmlwcyB0aHJvdWdoIHRoZSB0eXBlZCBvYmplY3QgY29ycmVjdGx5LlxuICAgIGNvbnN0IHsgfSA9IGF3YWl0IGltcG9ydChcIi4uL2RvY3Rvci5qc1wiKTtcbiAgICAvLyBDb25zdHJ1Y3QgYSB2YWx1ZSB0aGF0IHNhdGlzZmllcyBEb2N0b3JJc3N1ZSB1c2luZyB0aGUgY29kZSB1bmRlciB0ZXN0XG4gICAgY29uc3QgaXNzdWU6IGltcG9ydChcIi4uL2RvY3Rvci5qc1wiKS5Eb2N0b3JJc3N1ZSA9IHtcbiAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgIGNvZGU6IFwic3RhbGVfcGFyYWxsZWxfc2Vzc2lvblwiLFxuICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgdW5pdElkOiBcIk0wMDFcIixcbiAgICAgIG1lc3NhZ2U6IFwiU3RhbGUgcGFyYWxsZWwgc2Vzc2lvbiBkZXRlY3RlZFwiLFxuICAgICAgZml4YWJsZTogdHJ1ZSxcbiAgICB9O1xuICAgIGFzc2VydC5lcXVhbChpc3N1ZS5jb2RlLCBcInN0YWxlX3BhcmFsbGVsX3Nlc3Npb25cIik7XG4gIH0pO1xuXG4gIGl0KFwiRG9jdG9ySXNzdWUgd2l0aCBzdGFsZV9wYXJhbGxlbF9zZXNzaW9uIGhhcyB3YXJuaW5nIHNldmVyaXR5XCIsICgpID0+IHtcbiAgICBjb25zdCBpc3N1ZTogaW1wb3J0KFwiLi4vZG9jdG9yLmpzXCIpLkRvY3Rvcklzc3VlID0ge1xuICAgICAgc2V2ZXJpdHk6IFwid2FybmluZ1wiLFxuICAgICAgY29kZTogXCJzdGFsZV9wYXJhbGxlbF9zZXNzaW9uXCIsXG4gICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICB1bml0SWQ6IFwiTTAwMlwiLFxuICAgICAgbWVzc2FnZTogXCJTdGFsZSBwYXJhbGxlbCBzZXNzaW9uIGZvciBNMDAyXCIsXG4gICAgICBmaXhhYmxlOiB0cnVlLFxuICAgIH07XG4gICAgYXNzZXJ0LmVxdWFsKGlzc3VlLnNldmVyaXR5LCBcIndhcm5pbmdcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGlzc3VlLmZpeGFibGUsIHRydWUpO1xuICAgIGFzc2VydC5lcXVhbChpc3N1ZS5zY29wZSwgXCJwcm9qZWN0XCIpO1xuICB9KTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIkFBUUEsU0FBUyxVQUFVLElBQUksWUFBWSxpQkFBaUI7QUFDcEQsT0FBTyxZQUFZO0FBQ25CO0FB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
