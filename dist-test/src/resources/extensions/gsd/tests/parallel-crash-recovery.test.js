import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  restoreState,
  resetOrchestrator
} from "../parallel-orchestrator.js";
import {
  writeSessionStatus,
  readAllSessionStatuses,
  cleanupStaleSessions
} from "../session-status-io.js";
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "gsd-crash-recovery-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}
function stateFilePath(basePath) {
  return join(basePath, ".gsd", "orchestrator.json");
}
function writeStateFile(basePath, state) {
  writeFileSync(stateFilePath(basePath), JSON.stringify(state, null, 2), "utf-8");
}
function makePersistedState(overrides = {}) {
  return {
    active: true,
    workers: [],
    totalCost: 0,
    startedAt: Date.now(),
    configSnapshot: { max_workers: 3 },
    ...overrides
  };
}
describe("parallel-crash-recovery", () => {
  test("Test 1: orchestrator.json round-trips through restoreState (preserves worker fields)", () => {
    const basePath = makeTempDir();
    try {
      const state = makePersistedState({
        workers: [
          {
            milestoneId: "M001",
            title: "M001",
            pid: process.pid,
            // alive — survives restoreState's PID filter
            worktreePath: "/tmp/wt-M001",
            startedAt: Date.now(),
            state: "running",
            cost: 0.15
          }
        ],
        totalCost: 0.15
      });
      writeStateFile(basePath, state);
      const restored = restoreState(basePath);
      assert.ok(restored !== null, "restoreState: returns state for live worker");
      assert.deepStrictEqual(restored.active, true, "active field preserved through round-trip");
      assert.deepStrictEqual(restored.workers.length, 1, "worker count preserved");
      assert.deepStrictEqual(restored.workers[0].milestoneId, "M001", "milestoneId preserved");
      assert.deepStrictEqual(restored.workers[0].cost, 0.15, "cost preserved");
      assert.deepStrictEqual(restored.totalCost, 0.15, "totalCost preserved");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  test("Test 2: restoreState returns null for missing file", () => {
    const basePath = makeTempDir();
    try {
      const result = restoreState(basePath);
      assert.deepStrictEqual(result, null, "restoreState: returns null when no state file");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  test("Test 3: restoreState filters dead PIDs", () => {
    const basePath = makeTempDir();
    try {
      const state = makePersistedState({
        workers: [
          {
            milestoneId: "M001",
            title: "M001",
            pid: 99999999,
            worktreePath: "/tmp/wt-M001",
            startedAt: Date.now(),
            state: "running",
            cost: 0
          },
          {
            milestoneId: "M002",
            title: "M002",
            pid: 99999998,
            worktreePath: "/tmp/wt-M002",
            startedAt: Date.now(),
            state: "running",
            cost: 0
          }
        ]
      });
      writeStateFile(basePath, state);
      const result = restoreState(basePath);
      assert.deepStrictEqual(result, null, "restoreState: returns null when all PIDs dead");
      assert.ok(!existsSync(stateFilePath(basePath)), "restoreState: cleans up state file when all dead");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  test("Test 4: restoreState keeps alive PIDs", () => {
    const basePath = makeTempDir();
    try {
      const state = makePersistedState({
        workers: [
          {
            milestoneId: "M001",
            title: "M001",
            pid: process.pid,
            worktreePath: "/tmp/wt-M001",
            startedAt: Date.now(),
            state: "running",
            cost: 0.25
          },
          {
            milestoneId: "M002",
            title: "M002",
            pid: 99999999,
            // dead
            worktreePath: "/tmp/wt-M002",
            startedAt: Date.now(),
            state: "running",
            cost: 0
          }
        ],
        totalCost: 0.25
      });
      writeStateFile(basePath, state);
      const result = restoreState(basePath);
      assert.ok(result !== null, "restoreState: returns state when alive PID exists");
      assert.deepStrictEqual(result.workers.length, 1, "restoreState: filters out dead PID");
      assert.deepStrictEqual(result.workers[0].milestoneId, "M001", "restoreState: keeps alive worker");
      assert.deepStrictEqual(result.workers[0].pid, process.pid, "restoreState: preserves PID");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  test("Test 5: restoreState skips stopped/error workers even with alive PIDs", () => {
    const basePath = makeTempDir();
    try {
      const state = makePersistedState({
        workers: [
          {
            milestoneId: "M001",
            title: "M001",
            pid: process.pid,
            worktreePath: "/tmp/wt-M001",
            startedAt: Date.now(),
            state: "stopped",
            cost: 0.5
          }
        ]
      });
      writeStateFile(basePath, state);
      const result = restoreState(basePath);
      assert.deepStrictEqual(result, null, "restoreState: skips stopped workers");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  test("Test 6: cleanupStaleSessions removes dead-PID sessions and keeps live ones", () => {
    const basePath = makeTempDir();
    try {
      mkdirSync(join(basePath, ".gsd", "parallel"), { recursive: true });
      writeSessionStatus(basePath, {
        milestoneId: "M001",
        pid: 99999999,
        state: "running",
        currentUnit: null,
        completedUnits: 3,
        cost: 0.1,
        lastHeartbeat: Date.now(),
        startedAt: Date.now(),
        worktreePath: "/tmp/wt-M001"
      });
      writeSessionStatus(basePath, {
        milestoneId: "M002",
        pid: process.pid,
        state: "running",
        currentUnit: null,
        completedUnits: 1,
        cost: 0.05,
        lastHeartbeat: Date.now(),
        startedAt: Date.now(),
        worktreePath: "/tmp/wt-M002"
      });
      const before = readAllSessionStatuses(basePath);
      assert.deepStrictEqual(before.length, 2, "both sessions exist before cleanup");
      const removed = cleanupStaleSessions(basePath);
      assert.deepStrictEqual(removed, ["M001"], "dead-PID session id is reported as removed");
      const after = readAllSessionStatuses(basePath);
      assert.deepStrictEqual(after.length, 1, "dead session cleaned up");
      assert.deepStrictEqual(after[0].milestoneId, "M002", "alive session remains");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  test("Test 7: restoreState handles corrupt JSON gracefully", () => {
    const basePath = makeTempDir();
    try {
      writeFileSync(stateFilePath(basePath), "{ not valid json !!!", "utf-8");
      const result = restoreState(basePath);
      assert.deepStrictEqual(result, null, "restoreState: returns null for corrupt JSON");
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  resetOrchestrator();
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9wYXJhbGxlbC1jcmFzaC1yZWNvdmVyeS50ZXN0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFRlc3RzIGZvciBwYXJhbGxlbCBvcmNoZXN0cmF0b3IgY3Jhc2ggcmVjb3ZlcnkuXG4gKlxuICogVmFsaWRhdGVzIHRoYXQgb3JjaGVzdHJhdG9yIHN0YXRlIGlzIHBlcnNpc3RlZCB0byBkaXNrIGFuZCBjYW4gYmVcbiAqIHJlc3RvcmVkIGFmdGVyIGEgY29vcmRpbmF0b3IgY3Jhc2gsIHdpdGggUElEIGxpdmVuZXNzIGZpbHRlcmluZy5cbiAqL1xuXG5pbXBvcnQgeyBkZXNjcmliZSwgdGVzdCB9IGZyb20gJ25vZGU6dGVzdCc7XG5pbXBvcnQgYXNzZXJ0IGZyb20gJ25vZGU6YXNzZXJ0L3N0cmljdCc7XG5pbXBvcnQge1xuICBta2R0ZW1wU3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIHJtU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuXG5pbXBvcnQge1xuICByZXN0b3JlU3RhdGUsXG4gIHJlc2V0T3JjaGVzdHJhdG9yLFxuICB0eXBlIFBlcnNpc3RlZFN0YXRlLFxufSBmcm9tIFwiLi4vcGFyYWxsZWwtb3JjaGVzdHJhdG9yLnRzXCI7XG5pbXBvcnQge1xuICB3cml0ZVNlc3Npb25TdGF0dXMsXG4gIHJlYWRBbGxTZXNzaW9uU3RhdHVzZXMsXG4gIGNsZWFudXBTdGFsZVNlc3Npb25zLFxufSBmcm9tIFwiLi4vc2Vzc2lvbi1zdGF0dXMtaW8udHNcIjtcbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBtYWtlVGVtcERpcigpOiBzdHJpbmcge1xuICBjb25zdCBkaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcImdzZC1jcmFzaC1yZWNvdmVyeS1cIikpO1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBkaXI7XG59XG5cbmZ1bmN0aW9uIHN0YXRlRmlsZVBhdGgoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJvcmNoZXN0cmF0b3IuanNvblwiKTtcbn1cblxuZnVuY3Rpb24gd3JpdGVTdGF0ZUZpbGUoYmFzZVBhdGg6IHN0cmluZywgc3RhdGU6IFBlcnNpc3RlZFN0YXRlKTogdm9pZCB7XG4gIHdyaXRlRmlsZVN5bmMoc3RhdGVGaWxlUGF0aChiYXNlUGF0aCksIEpTT04uc3RyaW5naWZ5KHN0YXRlLCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcbn1cblxuZnVuY3Rpb24gbWFrZVBlcnNpc3RlZFN0YXRlKG92ZXJyaWRlczogUGFydGlhbDxQZXJzaXN0ZWRTdGF0ZT4gPSB7fSk6IFBlcnNpc3RlZFN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICBhY3RpdmU6IHRydWUsXG4gICAgd29ya2VyczogW10sXG4gICAgdG90YWxDb3N0OiAwLFxuICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICBjb25maWdTbmFwc2hvdDogeyBtYXhfd29ya2VyczogMyB9LFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFRlc3RzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5cbmRlc2NyaWJlKCdwYXJhbGxlbC1jcmFzaC1yZWNvdmVyeScsICgpID0+IHtcbnRlc3QoJ1Rlc3QgMTogb3JjaGVzdHJhdG9yLmpzb24gcm91bmQtdHJpcHMgdGhyb3VnaCByZXN0b3JlU3RhdGUgKHByZXNlcnZlcyB3b3JrZXIgZmllbGRzKScsICgpID0+IHtcbiAgY29uc3QgYmFzZVBhdGggPSBtYWtlVGVtcERpcigpO1xuICB0cnkge1xuICAgIC8vIFdyaXRlIGEgZnVsbCBzdGF0ZSBmaWxlIHRvIGRpc2sgYW5kIHRoZW4gZXhlcmNpc2UgdGhlIHJlYWwgcHJvZHVjdGlvblxuICAgIC8vIHJlc3RvcmVTdGF0ZSgpIHJlYWRlciBhZ2FpbnN0IGl0LiBUaGlzIHZlcmlmaWVzIHRoZSBwZXJzaXN0ZWQgZmlsZVxuICAgIC8vIHNjaGVtYSAodGhlIGNvbnRyYWN0IGJldHdlZW4gcGVyc2lzdFN0YXRlJ3Mgd3JpdGVyIGFuZCB0aGUgcmVhZGVyKVxuICAgIC8vIFx1MjAxNCBlYXJsaWVyIHRoaXMgdGVzdCBpbmxpbmVkIGEgdGVzdC1vbmx5IHdyaXRlciBhbmQgcmUtcGFyc2VkIEpTT04sXG4gICAgLy8gYnlwYXNzaW5nIHByb2R1Y3Rpb24gY29kZSBlbnRpcmVseS5cbiAgICBjb25zdCBzdGF0ZSA9IG1ha2VQZXJzaXN0ZWRTdGF0ZSh7XG4gICAgICB3b3JrZXJzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAxXCIsXG4gICAgICAgICAgdGl0bGU6IFwiTTAwMVwiLFxuICAgICAgICAgIHBpZDogcHJvY2Vzcy5waWQsIC8vIGFsaXZlIFx1MjAxNCBzdXJ2aXZlcyByZXN0b3JlU3RhdGUncyBQSUQgZmlsdGVyXG4gICAgICAgICAgd29ya3RyZWVQYXRoOiBcIi90bXAvd3QtTTAwMVwiLFxuICAgICAgICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgICBzdGF0ZTogXCJydW5uaW5nXCIsXG4gICAgICAgICAgY29zdDogMC4xNSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICB0b3RhbENvc3Q6IDAuMTUsXG4gICAgfSk7XG4gICAgd3JpdGVTdGF0ZUZpbGUoYmFzZVBhdGgsIHN0YXRlKTtcblxuICAgIGNvbnN0IHJlc3RvcmVkID0gcmVzdG9yZVN0YXRlKGJhc2VQYXRoKTtcbiAgICBhc3NlcnQub2socmVzdG9yZWQgIT09IG51bGwsIFwicmVzdG9yZVN0YXRlOiByZXR1cm5zIHN0YXRlIGZvciBsaXZlIHdvcmtlclwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3RvcmVkIS5hY3RpdmUsIHRydWUsIFwiYWN0aXZlIGZpZWxkIHByZXNlcnZlZCB0aHJvdWdoIHJvdW5kLXRyaXBcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN0b3JlZCEud29ya2Vycy5sZW5ndGgsIDEsIFwid29ya2VyIGNvdW50IHByZXNlcnZlZFwiKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3RvcmVkIS53b3JrZXJzWzBdLm1pbGVzdG9uZUlkLCBcIk0wMDFcIiwgXCJtaWxlc3RvbmVJZCBwcmVzZXJ2ZWRcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN0b3JlZCEud29ya2Vyc1swXS5jb3N0LCAwLjE1LCBcImNvc3QgcHJlc2VydmVkXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdG9yZWQhLnRvdGFsQ29zdCwgMC4xNSwgXCJ0b3RhbENvc3QgcHJlc2VydmVkXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdCgnVGVzdCAyOiByZXN0b3JlU3RhdGUgcmV0dXJucyBudWxsIGZvciBtaXNzaW5nIGZpbGUnLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gbWFrZVRlbXBEaXIoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSByZXN0b3JlU3RhdGUoYmFzZVBhdGgpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCBudWxsLCBcInJlc3RvcmVTdGF0ZTogcmV0dXJucyBudWxsIHdoZW4gbm8gc3RhdGUgZmlsZVwiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoJ1Rlc3QgMzogcmVzdG9yZVN0YXRlIGZpbHRlcnMgZGVhZCBQSURzJywgKCkgPT4ge1xuICBjb25zdCBiYXNlUGF0aCA9IG1ha2VUZW1wRGlyKCk7XG4gIHRyeSB7XG4gICAgLy8gUElEIDk5OTk5OTk5IGlzIGFsbW9zdCBjZXJ0YWlubHkgbm90IGFsaXZlXG4gICAgY29uc3Qgc3RhdGUgPSBtYWtlUGVyc2lzdGVkU3RhdGUoe1xuICAgICAgd29ya2VyczogW1xuICAgICAgICB7XG4gICAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICAgIHRpdGxlOiBcIk0wMDFcIixcbiAgICAgICAgICBwaWQ6IDk5OTk5OTk5LFxuICAgICAgICAgIHdvcmt0cmVlUGF0aDogXCIvdG1wL3d0LU0wMDFcIixcbiAgICAgICAgICBzdGFydGVkQXQ6IERhdGUubm93KCksXG4gICAgICAgICAgc3RhdGU6IFwicnVubmluZ1wiLFxuICAgICAgICAgIGNvc3Q6IDAsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAyXCIsXG4gICAgICAgICAgdGl0bGU6IFwiTTAwMlwiLFxuICAgICAgICAgIHBpZDogOTk5OTk5OTgsXG4gICAgICAgICAgd29ya3RyZWVQYXRoOiBcIi90bXAvd3QtTTAwMlwiLFxuICAgICAgICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgICAgICBzdGF0ZTogXCJydW5uaW5nXCIsXG4gICAgICAgICAgY29zdDogMCxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG4gICAgd3JpdGVTdGF0ZUZpbGUoYmFzZVBhdGgsIHN0YXRlKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlc3RvcmVTdGF0ZShiYXNlUGF0aCk7XG4gICAgLy8gQm90aCBQSURzIGFyZSBkZWFkLCBzbyByZXN1bHQgc2hvdWxkIGJlIG51bGwgYW5kIGZpbGUgc2hvdWxkIGJlIGNsZWFuZWQgdXBcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJyZXN0b3JlU3RhdGU6IHJldHVybnMgbnVsbCB3aGVuIGFsbCBQSURzIGRlYWRcIik7XG4gICAgYXNzZXJ0Lm9rKCFleGlzdHNTeW5jKHN0YXRlRmlsZVBhdGgoYmFzZVBhdGgpKSwgXCJyZXN0b3JlU3RhdGU6IGNsZWFucyB1cCBzdGF0ZSBmaWxlIHdoZW4gYWxsIGRlYWRcIik7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKGJhc2VQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG50ZXN0KCdUZXN0IDQ6IHJlc3RvcmVTdGF0ZSBrZWVwcyBhbGl2ZSBQSURzJywgKCkgPT4ge1xuICBjb25zdCBiYXNlUGF0aCA9IG1ha2VUZW1wRGlyKCk7XG4gIHRyeSB7XG4gICAgLy8gVXNlIGN1cnJlbnQgcHJvY2VzcyBQSUQgKGRlZmluaXRlbHkgYWxpdmUpXG4gICAgY29uc3Qgc3RhdGUgPSBtYWtlUGVyc2lzdGVkU3RhdGUoe1xuICAgICAgd29ya2VyczogW1xuICAgICAgICB7XG4gICAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICAgIHRpdGxlOiBcIk0wMDFcIixcbiAgICAgICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgICAgIHdvcmt0cmVlUGF0aDogXCIvdG1wL3d0LU0wMDFcIixcbiAgICAgICAgICBzdGFydGVkQXQ6IERhdGUubm93KCksXG4gICAgICAgICAgc3RhdGU6IFwicnVubmluZ1wiLFxuICAgICAgICAgIGNvc3Q6IDAuMjUsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBtaWxlc3RvbmVJZDogXCJNMDAyXCIsXG4gICAgICAgICAgdGl0bGU6IFwiTTAwMlwiLFxuICAgICAgICAgIHBpZDogOTk5OTk5OTksIC8vIGRlYWRcbiAgICAgICAgICB3b3JrdHJlZVBhdGg6IFwiL3RtcC93dC1NMDAyXCIsXG4gICAgICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICAgIHN0YXRlOiBcInJ1bm5pbmdcIixcbiAgICAgICAgICBjb3N0OiAwLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHRvdGFsQ29zdDogMC4yNSxcbiAgICB9KTtcbiAgICB3cml0ZVN0YXRlRmlsZShiYXNlUGF0aCwgc3RhdGUpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gcmVzdG9yZVN0YXRlKGJhc2VQYXRoKTtcbiAgICBhc3NlcnQub2socmVzdWx0ICE9PSBudWxsLCBcInJlc3RvcmVTdGF0ZTogcmV0dXJucyBzdGF0ZSB3aGVuIGFsaXZlIFBJRCBleGlzdHNcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQhLndvcmtlcnMubGVuZ3RoLCAxLCBcInJlc3RvcmVTdGF0ZTogZmlsdGVycyBvdXQgZGVhZCBQSURcIik7XG4gICAgYXNzZXJ0LmRlZXBTdHJpY3RFcXVhbChyZXN1bHQhLndvcmtlcnNbMF0ubWlsZXN0b25lSWQsIFwiTTAwMVwiLCBcInJlc3RvcmVTdGF0ZToga2VlcHMgYWxpdmUgd29ya2VyXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0IS53b3JrZXJzWzBdLnBpZCwgcHJvY2Vzcy5waWQsIFwicmVzdG9yZVN0YXRlOiBwcmVzZXJ2ZXMgUElEXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdCgnVGVzdCA1OiByZXN0b3JlU3RhdGUgc2tpcHMgc3RvcHBlZC9lcnJvciB3b3JrZXJzIGV2ZW4gd2l0aCBhbGl2ZSBQSURzJywgKCkgPT4ge1xuICBjb25zdCBiYXNlUGF0aCA9IG1ha2VUZW1wRGlyKCk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdGUgPSBtYWtlUGVyc2lzdGVkU3RhdGUoe1xuICAgICAgd29ya2VyczogW1xuICAgICAgICB7XG4gICAgICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMVwiLFxuICAgICAgICAgIHRpdGxlOiBcIk0wMDFcIixcbiAgICAgICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgICAgIHdvcmt0cmVlUGF0aDogXCIvdG1wL3d0LU0wMDFcIixcbiAgICAgICAgICBzdGFydGVkQXQ6IERhdGUubm93KCksXG4gICAgICAgICAgc3RhdGU6IFwic3RvcHBlZFwiLFxuICAgICAgICAgIGNvc3Q6IDAuNTAsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuICAgIHdyaXRlU3RhdGVGaWxlKGJhc2VQYXRoLCBzdGF0ZSk7XG5cbiAgICBjb25zdCByZXN1bHQgPSByZXN0b3JlU3RhdGUoYmFzZVBhdGgpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVzdWx0LCBudWxsLCBcInJlc3RvcmVTdGF0ZTogc2tpcHMgc3RvcHBlZCB3b3JrZXJzXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxudGVzdCgnVGVzdCA2OiBjbGVhbnVwU3RhbGVTZXNzaW9ucyByZW1vdmVzIGRlYWQtUElEIHNlc3Npb25zIGFuZCBrZWVwcyBsaXZlIG9uZXMnLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gbWFrZVRlbXBEaXIoKTtcbiAgdHJ5IHtcbiAgICBta2RpclN5bmMoam9pbihiYXNlUGF0aCwgXCIuZ3NkXCIsIFwicGFyYWxsZWxcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgLy8gRGVhZCBQSURcbiAgICB3cml0ZVNlc3Npb25TdGF0dXMoYmFzZVBhdGgsIHtcbiAgICAgIG1pbGVzdG9uZUlkOiBcIk0wMDFcIixcbiAgICAgIHBpZDogOTk5OTk5OTksXG4gICAgICBzdGF0ZTogXCJydW5uaW5nXCIsXG4gICAgICBjdXJyZW50VW5pdDogbnVsbCxcbiAgICAgIGNvbXBsZXRlZFVuaXRzOiAzLFxuICAgICAgY29zdDogMC4xMCxcbiAgICAgIGxhc3RIZWFydGJlYXQ6IERhdGUubm93KCksXG4gICAgICBzdGFydGVkQXQ6IERhdGUubm93KCksXG4gICAgICB3b3JrdHJlZVBhdGg6IFwiL3RtcC93dC1NMDAxXCIsXG4gICAgfSk7XG5cbiAgICAvLyBMaXZlIFBJRCAodGhpcyBwcm9jZXNzKVxuICAgIHdyaXRlU2Vzc2lvblN0YXR1cyhiYXNlUGF0aCwge1xuICAgICAgbWlsZXN0b25lSWQ6IFwiTTAwMlwiLFxuICAgICAgcGlkOiBwcm9jZXNzLnBpZCxcbiAgICAgIHN0YXRlOiBcInJ1bm5pbmdcIixcbiAgICAgIGN1cnJlbnRVbml0OiBudWxsLFxuICAgICAgY29tcGxldGVkVW5pdHM6IDEsXG4gICAgICBjb3N0OiAwLjA1LFxuICAgICAgbGFzdEhlYXJ0YmVhdDogRGF0ZS5ub3coKSxcbiAgICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICAgIHdvcmt0cmVlUGF0aDogXCIvdG1wL3d0LU0wMDJcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IGJlZm9yZSA9IHJlYWRBbGxTZXNzaW9uU3RhdHVzZXMoYmFzZVBhdGgpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYmVmb3JlLmxlbmd0aCwgMiwgXCJib3RoIHNlc3Npb25zIGV4aXN0IGJlZm9yZSBjbGVhbnVwXCIpO1xuXG4gICAgLy8gRHJpdmUgdGhlIHJlYWwgcHJvZHVjdGlvbiBjbGVhbnVwIGZ1bmN0aW9uLiBFYXJsaWVyIHRoaXMgdGVzdFxuICAgIC8vIHJlLWltcGxlbWVudGVkIHRoZSBjbGVhbnVwIGxvb3AgaW5saW5lIChwcm9jZXNzLmtpbGwgKyByZW1vdmUqKSBhbmRcbiAgICAvLyBuZXZlciBleGVyY2lzZWQgY2xlYW51cFN0YWxlU2Vzc2lvbnMgaXRzZWxmIFx1MjAxNCBzbyBjaGFuZ2VzIHRvIHRoZVxuICAgIC8vIHByb2R1Y3Rpb24gc3dlZXAgd291bGQgbm90IGhhdmUgYmVlbiBjYXVnaHQuXG4gICAgY29uc3QgcmVtb3ZlZCA9IGNsZWFudXBTdGFsZVNlc3Npb25zKGJhc2VQYXRoKTtcblxuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwocmVtb3ZlZCwgW1wiTTAwMVwiXSwgXCJkZWFkLVBJRCBzZXNzaW9uIGlkIGlzIHJlcG9ydGVkIGFzIHJlbW92ZWRcIik7XG5cbiAgICBjb25zdCBhZnRlciA9IHJlYWRBbGxTZXNzaW9uU3RhdHVzZXMoYmFzZVBhdGgpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWZ0ZXIubGVuZ3RoLCAxLCBcImRlYWQgc2Vzc2lvbiBjbGVhbmVkIHVwXCIpO1xuICAgIGFzc2VydC5kZWVwU3RyaWN0RXF1YWwoYWZ0ZXJbMF0ubWlsZXN0b25lSWQsIFwiTTAwMlwiLCBcImFsaXZlIHNlc3Npb24gcmVtYWluc1wiKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbnRlc3QoJ1Rlc3QgNzogcmVzdG9yZVN0YXRlIGhhbmRsZXMgY29ycnVwdCBKU09OIGdyYWNlZnVsbHknLCAoKSA9PiB7XG4gIGNvbnN0IGJhc2VQYXRoID0gbWFrZVRlbXBEaXIoKTtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKHN0YXRlRmlsZVBhdGgoYmFzZVBhdGgpLCBcInsgbm90IHZhbGlkIGpzb24gISEhXCIsIFwidXRmLThcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gcmVzdG9yZVN0YXRlKGJhc2VQYXRoKTtcbiAgICBhc3NlcnQuZGVlcFN0cmljdEVxdWFsKHJlc3VsdCwgbnVsbCwgXCJyZXN0b3JlU3RhdGU6IHJldHVybnMgbnVsbCBmb3IgY29ycnVwdCBKU09OXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuLy8gQ2xlYW4gdXAgbW9kdWxlIHN0YXRlXG5yZXNldE9yY2hlc3RyYXRvcigpO1xuXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU9BLFNBQVMsVUFBVSxZQUFZO0FBQy9CLE9BQU8sWUFBWTtBQUNuQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEs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
