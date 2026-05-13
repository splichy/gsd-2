import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveState } from "../state.js";
import { validatePreferences } from "../preferences-validation.js";
import {
  _buildSliceWorkerEnvForTest,
  _resolveSliceParallelMaxWorkersForTest,
  restoreSliceState,
  SLICE_WORKER_AUTO_ARGS
} from "../slice-parallel-orchestrator.js";
function readLinuxProcessStartFingerprint(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim();
    const fields = afterCommand.split(/\s+/);
    const startTimeTicks = fields[19];
    return startTimeTicks ? `linux-stat:${startTimeTicks}` : null;
  } catch {
    return null;
  }
}
function readPsProcessStartFingerprint(pid) {
  try {
    const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8"
    }).trim().replace(/\s+/g, " ");
    return raw ? `ps-lstart:${raw}` : null;
  } catch {
    return null;
  }
}
function readProcessStartFingerprint(pid) {
  return readLinuxProcessStartFingerprint(pid) ?? readPsProcessStartFingerprint(pid);
}
function makeTempProject() {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-slice-parallel-"));
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  return basePath;
}
function writeSliceOrchestratorState(basePath, worker) {
  writeFileSync(
    join(basePath, ".gsd", "slice-orchestrator.json"),
    JSON.stringify({
      active: true,
      workers: [{
        milestoneId: "M900",
        sliceId: "S01",
        pid: worker.pid,
        workerToken: worker.workerToken,
        processStartFingerprint: worker.processStartFingerprint,
        worktreePath: join(basePath, ".gsd", "worktrees", "M900-S01"),
        startedAt: Date.now(),
        state: "running",
        completedUnits: 0,
        cost: 0
      }],
      totalCost: 0,
      maxWorkers: 1,
      startedAt: Date.now(),
      basePath
    }),
    "utf-8"
  );
}
describe("slice worker launch contract", () => {
  it("uses headless auto instead of print-mode slash commands", () => {
    assert.deepEqual([...SLICE_WORKER_AUTO_ARGS], ["headless", "--json", "auto"]);
    assert.equal(SLICE_WORKER_AUTO_ARGS.includes("--print"), false);
  });
  it("builds isolated worker environment", () => {
    const env = _buildSliceWorkerEnvForTest(
      "/repo",
      "M001",
      "S02",
      "worker-token",
      { PATH: "/bin" }
    );
    assert.equal(env.GSD_SLICE_LOCK, "S02");
    assert.equal(env.GSD_MILESTONE_LOCK, "M001");
    assert.equal(env.GSD_PROJECT_ROOT, "/repo");
    assert.equal(env.GSD_PARALLEL_WORKER, "1");
    assert.equal(env.GSD_SLICE_WORKER_TOKEN, "worker-token");
  });
  it("defaults to two workers unless explicitly configured", () => {
    assert.equal(_resolveSliceParallelMaxWorkersForTest(), 2);
    assert.equal(_resolveSliceParallelMaxWorkersForTest(4), 4);
  });
});
describe("slice-parallel-orchestrator recovery identity", () => {
  it("rejects a live PID when the process start fingerprint does not match", () => {
    const basePath = makeTempProject();
    try {
      writeSliceOrchestratorState(basePath, {
        pid: process.pid,
        processStartFingerprint: "mismatched-fingerprint"
      });
      const restored = restoreSliceState(basePath);
      assert.equal(restored, null, "mismatched fingerprint is treated as a dead worker");
      assert.equal(
        existsSync(join(basePath, ".gsd", "slice-orchestrator.json")),
        false,
        "state file is removed when no recovered worker identity validates"
      );
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });
  it("keeps a recovered worker when PID, token, and process start fingerprint match", async () => {
    const basePath = makeTempProject();
    const token = `test-token-${Date.now()}`;
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      {
        env: { ...process.env, GSD_SLICE_WORKER_TOKEN: token },
        stdio: "ignore"
      }
    );
    try {
      assert.ok(child.pid, "child process has a pid");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const fingerprint = readProcessStartFingerprint(child.pid);
      if (!fingerprint) return;
      writeSliceOrchestratorState(basePath, {
        pid: child.pid,
        workerToken: token,
        processStartFingerprint: fingerprint
      });
      const restored = restoreSliceState(basePath);
      assert.ok(restored, "matching worker identity is restored");
      assert.equal(restored.workers.length, 1);
      assert.equal(restored.workers[0].pid, child.pid);
    } finally {
      child.kill("SIGTERM");
      rmSync(basePath, { recursive: true, force: true });
    }
  });
});
describe("slice_parallel preference and state gating", () => {
  it("validates slice_parallel preferences", () => {
    const result = validatePreferences({
      slice_parallel: { enabled: true, max_workers: 3 }
    });
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.preferences.slice_parallel, {
      enabled: true,
      max_workers: 3
    });
  });
  it("derives the locked slice for parallel workers", async () => {
    const basePath = makeTempProject();
    const oldWorker = process.env.GSD_PARALLEL_WORKER;
    const oldSlice = process.env.GSD_SLICE_LOCK;
    try {
      const msDir = join(basePath, ".gsd", "milestones", "M001");
      mkdirSync(msDir, { recursive: true });
      writeFileSync(
        join(msDir, "M001-ROADMAP.md"),
        [
          "# M001",
          "",
          "## Slices",
          "- [ ] **S01: First** `risk:low` `depends:[]`",
          "- [ ] **S02: Second** `risk:low` `depends:[]`"
        ].join("\n")
      );
      process.env.GSD_PARALLEL_WORKER = "1";
      process.env.GSD_SLICE_LOCK = "S02";
      const state = await deriveState(basePath);
      assert.equal(state.activeSlice?.id, "S02");
    } finally {
      if (oldWorker === void 0) delete process.env.GSD_PARALLEL_WORKER;
      else process.env.GSD_PARALLEL_WORKER = oldWorker;
      if (oldSlice === void 0) delete process.env.GSD_SLICE_LOCK;
      else process.env.GSD_SLICE_LOCK = oldSlice;
      rmSync(basePath, { recursive: true, force: true });
    }
  });
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90ZXN0cy9zbGljZS1wYXJhbGxlbC1vcmNoZXN0cmF0b3IudGVzdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IFNsaWNlIHBhcmFsbGVsIG9yY2hlc3RyYXRvciBiZWhhdmlvciB0ZXN0cy5cblxuaW1wb3J0IHsgZGVzY3JpYmUsIGl0IH0gZnJvbSBcIm5vZGU6dGVzdFwiO1xuaW1wb3J0IGFzc2VydCBmcm9tIFwibm9kZTphc3NlcnQvc3RyaWN0XCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMsIHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgbWtkaXJTeW5jLCBta2R0ZW1wU3luYywgcmVhZEZpbGVTeW5jLCBybVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5cbmltcG9ydCB7IGRlcml2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlLmpzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZVByZWZlcmVuY2VzIH0gZnJvbSBcIi4uL3ByZWZlcmVuY2VzLXZhbGlkYXRpb24udHNcIjtcbmltcG9ydCB7XG4gIF9idWlsZFNsaWNlV29ya2VyRW52Rm9yVGVzdCxcbiAgX3Jlc29sdmVTbGljZVBhcmFsbGVsTWF4V29ya2Vyc0ZvclRlc3QsXG4gIHJlc3RvcmVTbGljZVN0YXRlLFxuICBTTElDRV9XT1JLRVJfQVVUT19BUkdTLFxufSBmcm9tIFwiLi4vc2xpY2UtcGFyYWxsZWwtb3JjaGVzdHJhdG9yLnRzXCI7XG5cbmZ1bmN0aW9uIHJlYWRMaW51eFByb2Nlc3NTdGFydEZpbmdlcnByaW50KHBpZDogbnVtYmVyKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IHJlYWRGaWxlU3luYyhgL3Byb2MvJHtwaWR9L3N0YXRgLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IGFmdGVyQ29tbWFuZCA9IHN0YXQuc2xpY2Uoc3RhdC5sYXN0SW5kZXhPZihcIilcIikgKyAyKS50cmltKCk7XG4gICAgY29uc3QgZmllbGRzID0gYWZ0ZXJDb21tYW5kLnNwbGl0KC9cXHMrLyk7XG4gICAgY29uc3Qgc3RhcnRUaW1lVGlja3MgPSBmaWVsZHNbMTldO1xuICAgIHJldHVybiBzdGFydFRpbWVUaWNrcyA/IGBsaW51eC1zdGF0OiR7c3RhcnRUaW1lVGlja3N9YCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRQc1Byb2Nlc3NTdGFydEZpbmdlcnByaW50KHBpZDogbnVtYmVyKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gZXhlY0ZpbGVTeW5jKFwicHNcIiwgW1wiLXBcIiwgU3RyaW5nKHBpZCksIFwiLW9cIiwgXCJsc3RhcnQ9XCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgfSkudHJpbSgpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpO1xuICAgIHJldHVybiByYXcgPyBgcHMtbHN0YXJ0OiR7cmF3fWAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZWFkUHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQocGlkOiBudW1iZXIpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIHJlYWRMaW51eFByb2Nlc3NTdGFydEZpbmdlcnByaW50KHBpZCkgPz8gcmVhZFBzUHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQocGlkKTtcbn1cblxuZnVuY3Rpb24gbWFrZVRlbXBQcm9qZWN0KCk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2VQYXRoID0gbWtkdGVtcFN5bmMoam9pbih0bXBkaXIoKSwgXCJnc2Qtc2xpY2UtcGFyYWxsZWwtXCIpKTtcbiAgbWtkaXJTeW5jKGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHJldHVybiBiYXNlUGF0aDtcbn1cblxuZnVuY3Rpb24gd3JpdGVTbGljZU9yY2hlc3RyYXRvclN0YXRlKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICB3b3JrZXI6IHtcbiAgICBwaWQ6IG51bWJlcjtcbiAgICB3b3JrZXJUb2tlbj86IHN0cmluZztcbiAgICBwcm9jZXNzU3RhcnRGaW5nZXJwcmludD86IHN0cmluZyB8IG51bGw7XG4gIH0sXG4pOiB2b2lkIHtcbiAgd3JpdGVGaWxlU3luYyhcbiAgICBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJzbGljZS1vcmNoZXN0cmF0b3IuanNvblwiKSxcbiAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBhY3RpdmU6IHRydWUsXG4gICAgICB3b3JrZXJzOiBbe1xuICAgICAgICBtaWxlc3RvbmVJZDogXCJNOTAwXCIsXG4gICAgICAgIHNsaWNlSWQ6IFwiUzAxXCIsXG4gICAgICAgIHBpZDogd29ya2VyLnBpZCxcbiAgICAgICAgd29ya2VyVG9rZW46IHdvcmtlci53b3JrZXJUb2tlbixcbiAgICAgICAgcHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQ6IHdvcmtlci5wcm9jZXNzU3RhcnRGaW5nZXJwcmludCxcbiAgICAgICAgd29ya3RyZWVQYXRoOiBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIiwgXCJNOTAwLVMwMVwiKSxcbiAgICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICBzdGF0ZTogXCJydW5uaW5nXCIsXG4gICAgICAgIGNvbXBsZXRlZFVuaXRzOiAwLFxuICAgICAgICBjb3N0OiAwLFxuICAgICAgfV0sXG4gICAgICB0b3RhbENvc3Q6IDAsXG4gICAgICBtYXhXb3JrZXJzOiAxLFxuICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgYmFzZVBhdGgsXG4gICAgfSksXG4gICAgXCJ1dGYtOFwiLFxuICApO1xufVxuXG5kZXNjcmliZShcInNsaWNlIHdvcmtlciBsYXVuY2ggY29udHJhY3RcIiwgKCkgPT4ge1xuICBpdChcInVzZXMgaGVhZGxlc3MgYXV0byBpbnN0ZWFkIG9mIHByaW50LW1vZGUgc2xhc2ggY29tbWFuZHNcIiwgKCkgPT4ge1xuICAgIGFzc2VydC5kZWVwRXF1YWwoWy4uLlNMSUNFX1dPUktFUl9BVVRPX0FSR1NdLCBbXCJoZWFkbGVzc1wiLCBcIi0tanNvblwiLCBcImF1dG9cIl0pO1xuICAgIGFzc2VydC5lcXVhbChTTElDRV9XT1JLRVJfQVVUT19BUkdTLmluY2x1ZGVzKFwiLS1wcmludFwiIGFzIG5ldmVyKSwgZmFsc2UpO1xuICB9KTtcblxuICBpdChcImJ1aWxkcyBpc29sYXRlZCB3b3JrZXIgZW52aXJvbm1lbnRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGVudiA9IF9idWlsZFNsaWNlV29ya2VyRW52Rm9yVGVzdChcbiAgICAgIFwiL3JlcG9cIixcbiAgICAgIFwiTTAwMVwiLFxuICAgICAgXCJTMDJcIixcbiAgICAgIFwid29ya2VyLXRva2VuXCIsXG4gICAgICB7IFBBVEg6IFwiL2JpblwiIH0gYXMgTm9kZUpTLlByb2Nlc3NFbnYsXG4gICAgKTtcblxuICAgIGFzc2VydC5lcXVhbChlbnYuR1NEX1NMSUNFX0xPQ0ssIFwiUzAyXCIpO1xuICAgIGFzc2VydC5lcXVhbChlbnYuR1NEX01JTEVTVE9ORV9MT0NLLCBcIk0wMDFcIik7XG4gICAgYXNzZXJ0LmVxdWFsKGVudi5HU0RfUFJPSkVDVF9ST09ULCBcIi9yZXBvXCIpO1xuICAgIGFzc2VydC5lcXVhbChlbnYuR1NEX1BBUkFMTEVMX1dPUktFUiwgXCIxXCIpO1xuICAgIGFzc2VydC5lcXVhbChlbnYuR1NEX1NMSUNFX1dPUktFUl9UT0tFTiwgXCJ3b3JrZXItdG9rZW5cIik7XG4gIH0pO1xuXG4gIGl0KFwiZGVmYXVsdHMgdG8gdHdvIHdvcmtlcnMgdW5sZXNzIGV4cGxpY2l0bHkgY29uZmlndXJlZFwiLCAoKSA9PiB7XG4gICAgYXNzZXJ0LmVxdWFsKF9yZXNvbHZlU2xpY2VQYXJhbGxlbE1heFdvcmtlcnNGb3JUZXN0KCksIDIpO1xuICAgIGFzc2VydC5lcXVhbChfcmVzb2x2ZVNsaWNlUGFyYWxsZWxNYXhXb3JrZXJzRm9yVGVzdCg0KSwgNCk7XG4gIH0pO1xufSk7XG5cbmRlc2NyaWJlKFwic2xpY2UtcGFyYWxsZWwtb3JjaGVzdHJhdG9yIHJlY292ZXJ5IGlkZW50aXR5XCIsICgpID0+IHtcbiAgaXQoXCJyZWplY3RzIGEgbGl2ZSBQSUQgd2hlbiB0aGUgcHJvY2VzcyBzdGFydCBmaW5nZXJwcmludCBkb2VzIG5vdCBtYXRjaFwiLCAoKSA9PiB7XG4gICAgY29uc3QgYmFzZVBhdGggPSBtYWtlVGVtcFByb2plY3QoKTtcbiAgICB0cnkge1xuICAgICAgd3JpdGVTbGljZU9yY2hlc3RyYXRvclN0YXRlKGJhc2VQYXRoLCB7XG4gICAgICAgIHBpZDogcHJvY2Vzcy5waWQsXG4gICAgICAgIHByb2Nlc3NTdGFydEZpbmdlcnByaW50OiBcIm1pc21hdGNoZWQtZmluZ2VycHJpbnRcIixcbiAgICAgIH0pO1xuXG4gICAgICBjb25zdCByZXN0b3JlZCA9IHJlc3RvcmVTbGljZVN0YXRlKGJhc2VQYXRoKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN0b3JlZCwgbnVsbCwgXCJtaXNtYXRjaGVkIGZpbmdlcnByaW50IGlzIHRyZWF0ZWQgYXMgYSBkZWFkIHdvcmtlclwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChcbiAgICAgICAgZXhpc3RzU3luYyhqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJzbGljZS1vcmNoZXN0cmF0b3IuanNvblwiKSksXG4gICAgICAgIGZhbHNlLFxuICAgICAgICBcInN0YXRlIGZpbGUgaXMgcmVtb3ZlZCB3aGVuIG5vIHJlY292ZXJlZCB3b3JrZXIgaWRlbnRpdHkgdmFsaWRhdGVzXCIsXG4gICAgICApO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBybVN5bmMoYmFzZVBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGl0KFwia2VlcHMgYSByZWNvdmVyZWQgd29ya2VyIHdoZW4gUElELCB0b2tlbiwgYW5kIHByb2Nlc3Mgc3RhcnQgZmluZ2VycHJpbnQgbWF0Y2hcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IGJhc2VQYXRoID0gbWFrZVRlbXBQcm9qZWN0KCk7XG4gICAgY29uc3QgdG9rZW4gPSBgdGVzdC10b2tlbi0ke0RhdGUubm93KCl9YDtcbiAgICBjb25zdCBjaGlsZCA9IHNwYXduKFxuICAgICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICAgIFtcIi1lXCIsIFwic2V0VGltZW91dCgoKSA9PiB7fSwgMzAwMDApXCJdLFxuICAgICAge1xuICAgICAgICBlbnY6IHsgLi4ucHJvY2Vzcy5lbnYsIEdTRF9TTElDRV9XT1JLRVJfVE9LRU46IHRva2VuIH0sXG4gICAgICAgIHN0ZGlvOiBcImlnbm9yZVwiLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgdHJ5IHtcbiAgICAgIGFzc2VydC5vayhjaGlsZC5waWQsIFwiY2hpbGQgcHJvY2VzcyBoYXMgYSBwaWRcIik7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gc2V0VGltZW91dChyZXNvbHZlLCA1MCkpO1xuICAgICAgY29uc3QgZmluZ2VycHJpbnQgPSByZWFkUHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQoY2hpbGQucGlkISk7XG4gICAgICBpZiAoIWZpbmdlcnByaW50KSByZXR1cm47XG5cbiAgICAgIHdyaXRlU2xpY2VPcmNoZXN0cmF0b3JTdGF0ZShiYXNlUGF0aCwge1xuICAgICAgICBwaWQ6IGNoaWxkLnBpZCEsXG4gICAgICAgIHdvcmtlclRva2VuOiB0b2tlbixcbiAgICAgICAgcHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQ6IGZpbmdlcnByaW50LFxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IHJlc3RvcmVkID0gcmVzdG9yZVNsaWNlU3RhdGUoYmFzZVBhdGgpO1xuICAgICAgYXNzZXJ0Lm9rKHJlc3RvcmVkLCBcIm1hdGNoaW5nIHdvcmtlciBpZGVudGl0eSBpcyByZXN0b3JlZFwiKTtcbiAgICAgIGFzc2VydC5lcXVhbChyZXN0b3JlZC53b3JrZXJzLmxlbmd0aCwgMSk7XG4gICAgICBhc3NlcnQuZXF1YWwocmVzdG9yZWQud29ya2Vyc1swXS5waWQsIGNoaWxkLnBpZCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGNoaWxkLmtpbGwoXCJTSUdURVJNXCIpO1xuICAgICAgcm1TeW5jKGJhc2VQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfVxuICB9KTtcbn0pO1xuXG5kZXNjcmliZShcInNsaWNlX3BhcmFsbGVsIHByZWZlcmVuY2UgYW5kIHN0YXRlIGdhdGluZ1wiLCAoKSA9PiB7XG4gIGl0KFwidmFsaWRhdGVzIHNsaWNlX3BhcmFsbGVsIHByZWZlcmVuY2VzXCIsICgpID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSB2YWxpZGF0ZVByZWZlcmVuY2VzKHtcbiAgICAgIHNsaWNlX3BhcmFsbGVsOiB7IGVuYWJsZWQ6IHRydWUsIG1heF93b3JrZXJzOiAzIH0sXG4gICAgfSk7XG5cbiAgICBhc3NlcnQuZXF1YWwocmVzdWx0LmVycm9ycy5sZW5ndGgsIDApO1xuICAgIGFzc2VydC5kZWVwRXF1YWwocmVzdWx0LnByZWZlcmVuY2VzLnNsaWNlX3BhcmFsbGVsLCB7XG4gICAgICBlbmFibGVkOiB0cnVlLFxuICAgICAgbWF4X3dvcmtlcnM6IDMsXG4gICAgfSk7XG4gIH0pO1xuXG4gIGl0KFwiZGVyaXZlcyB0aGUgbG9ja2VkIHNsaWNlIGZvciBwYXJhbGxlbCB3b3JrZXJzXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBiYXNlUGF0aCA9IG1ha2VUZW1wUHJvamVjdCgpO1xuICAgIGNvbnN0IG9sZFdvcmtlciA9IHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVI7XG4gICAgY29uc3Qgb2xkU2xpY2UgPSBwcm9jZXNzLmVudi5HU0RfU0xJQ0VfTE9DSztcbiAgICB0cnkge1xuICAgICAgY29uc3QgbXNEaXIgPSBqb2luKGJhc2VQYXRoLCBcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIFwiTTAwMVwiKTtcbiAgICAgIG1rZGlyU3luYyhtc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgICBqb2luKG1zRGlyLCBcIk0wMDEtUk9BRE1BUC5tZFwiKSxcbiAgICAgICAgW1xuICAgICAgICAgIFwiIyBNMDAxXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIFNsaWNlc1wiLFxuICAgICAgICAgIFwiLSBbIF0gKipTMDE6IEZpcnN0KiogYHJpc2s6bG93YCBgZGVwZW5kczpbXWBcIixcbiAgICAgICAgICBcIi0gWyBdICoqUzAyOiBTZWNvbmQqKiBgcmlzazpsb3dgIGBkZXBlbmRzOltdYFwiLFxuICAgICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICApO1xuICAgICAgcHJvY2Vzcy5lbnYuR1NEX1BBUkFMTEVMX1dPUktFUiA9IFwiMVwiO1xuICAgICAgcHJvY2Vzcy5lbnYuR1NEX1NMSUNFX0xPQ0sgPSBcIlMwMlwiO1xuXG4gICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcbiAgICAgIGFzc2VydC5lcXVhbChzdGF0ZS5hY3RpdmVTbGljZT8uaWQsIFwiUzAyXCIpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBpZiAob2xkV29ya2VyID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfUEFSQUxMRUxfV09SS0VSO1xuICAgICAgZWxzZSBwcm9jZXNzLmVudi5HU0RfUEFSQUxMRUxfV09SS0VSID0gb2xkV29ya2VyO1xuICAgICAgaWYgKG9sZFNsaWNlID09PSB1bmRlZmluZWQpIGRlbGV0ZSBwcm9jZXNzLmVudi5HU0RfU0xJQ0VfTE9DSztcbiAgICAgIGVsc2UgcHJvY2Vzcy5lbnYuR1NEX1NMSUNFX0xPQ0sgPSBvbGRTbGljZTtcbiAgICAgIHJtU3luYyhiYXNlUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQUVBLFNBQVMsVUFBVSxVQUFVO0FBQzdCLE9BQU8sWUFBWTtBQUNuQixTQUFTLGNBQWMsYUFBYTtBQUNwQyxTQUFTLFlBQVksV0FBVyxhQUFhLGNBQWMsUUFBUSxxQkFBcUI7QUFDeEYsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsY0FBYztBQUV2QixTQUFTLG1CQUFtQjtBQUM1QixTQUFTLDJCQUEyQjtBQUNwQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsU0FBUyxpQ0FBaUMsS0FBNEI7QUFDcEUsTUFBSTtBQUNGLFVBQU0sT0FBTyxhQUFhLFNBQVMsR0FBRyxTQUFTLE9BQU87QUFDdEQsVUFBTSxlQUFlLEtBQUssTUFBTSxLQUFLLFlBQVksR0FBRyxJQUFJLENBQUMsRUFBRSxLQUFLO0FBQ2hFLFVBQU0sU0FBUyxhQUFhLE1BQU0sS0FBSztBQUN2QyxVQUFNLGlCQUFpQixPQUFPLEVBQUU7QUFDaEMsV0FBTyxpQkFBaUIsY0FBYyxjQUFjLEtBQUs7QUFBQSxFQUMzRCxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLFNBQVMsOEJBQThCLEtBQTRCO0FBQ2pFLE1BQUk7QUFDRixVQUFNLE1BQU0sYUFBYSxNQUFNLENBQUMsTUFBTSxPQUFPLEdBQUcsR0FBRyxNQUFNLFNBQVMsR0FBRztBQUFBLE1BQ25FLE9BQU8sQ0FBQyxVQUFVLFFBQVEsUUFBUTtBQUFBLE1BQ2xDLFVBQVU7QUFBQSxJQUNaLENBQUMsRUFBRSxLQUFL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
