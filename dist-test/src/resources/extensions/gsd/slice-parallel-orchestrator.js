import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  renameSync,
  unlinkSync
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gsdRoot } from "./paths.js";
import { createWorktree, worktreePath, removeWorktree } from "./worktree-manager.js";
import {
  writeSessionStatus
} from "./session-status-io.js";
import { hasFileConflict } from "./slice-parallel-conflict.js";
import { getErrorMessage } from "./error-utils.js";
import { selectConflictFreeBatch } from "./uok/execution-graph.js";
let sliceState = null;
const SLICE_ORCHESTRATOR_STATE_FILE = "slice-orchestrator.json";
const TMP_SUFFIX = ".tmp";
const SLICE_WORKER_AUTO_ARGS = ["headless", "--json", "auto"];
function _resolveSliceParallelMaxWorkersForTest(maxWorkers) {
  return maxWorkers ?? 2;
}
function _buildSliceWorkerEnvForTest(basePath, milestoneId, sliceId, workerToken, sourceEnv = process.env) {
  return {
    ...sourceEnv,
    GSD_SLICE_LOCK: sliceId,
    GSD_MILESTONE_LOCK: milestoneId,
    GSD_PROJECT_ROOT: basePath,
    GSD_PARALLEL_WORKER: "1",
    GSD_SLICE_WORKER_TOKEN: workerToken
  };
}
function sliceStateFilePath(basePath) {
  return join(gsdRoot(basePath), SLICE_ORCHESTRATOR_STATE_FILE);
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "EPERM") return true;
    return false;
  }
}
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
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return readLinuxProcessStartFingerprint(pid) ?? readPsProcessStartFingerprint(pid);
}
function linuxProcessEnvContains(pid, key, value) {
  if (process.platform !== "linux") return null;
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf-8");
    return env.split("\0").includes(`${key}=${value}`);
  } catch {
    return null;
  }
}
function createWorkerToken(milestoneId, sliceId) {
  return `slice:${milestoneId}:${sliceId}:${Date.now()}:${randomUUID()}`;
}
function isRecoveredSliceWorkerAlive(worker) {
  if (!isPidAlive(worker.pid)) return false;
  if (!worker.processStartFingerprint) return false;
  const currentFingerprint = readProcessStartFingerprint(worker.pid);
  if (!currentFingerprint || currentFingerprint !== worker.processStartFingerprint) {
    return false;
  }
  if (worker.workerToken) {
    const envMatches = linuxProcessEnvContains(
      worker.pid,
      "GSD_SLICE_WORKER_TOKEN",
      worker.workerToken
    );
    if (envMatches === false) return false;
  }
  return true;
}
function persistSliceState() {
  if (!sliceState) return;
  try {
    const dir = gsdRoot(sliceState.basePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const persisted = {
      active: sliceState.active,
      workers: [...sliceState.workers.values()].map((w) => ({
        milestoneId: w.milestoneId,
        sliceId: w.sliceId,
        pid: w.pid,
        workerToken: w.workerToken,
        processStartFingerprint: w.processStartFingerprint,
        worktreePath: w.worktreePath,
        startedAt: w.startedAt,
        state: w.state,
        completedUnits: w.completedUnits,
        cost: w.cost
      })),
      totalCost: sliceState.totalCost,
      budgetCeiling: sliceState.budgetCeiling,
      maxWorkers: sliceState.maxWorkers,
      startedAt: sliceState.startedAt,
      basePath: sliceState.basePath
    };
    const dest = sliceStateFilePath(sliceState.basePath);
    const tmp = dest + TMP_SUFFIX;
    writeFileSync(tmp, JSON.stringify(persisted, null, 2), "utf-8");
    renameSync(tmp, dest);
    lastPersistTs = Date.now();
  } catch {
  }
}
const PERSIST_THROTTLE_MS = 1e3;
let lastPersistTs = 0;
function persistSliceStateThrottled() {
  if (Date.now() - lastPersistTs < PERSIST_THROTTLE_MS) return;
  persistSliceState();
}
function removeSliceStateFile(basePath) {
  try {
    const p = sliceStateFilePath(basePath);
    if (existsSync(p)) unlinkSync(p);
  } catch {
  }
}
function restoreSliceState(basePath) {
  try {
    const p = sliceStateFilePath(basePath);
    if (!existsSync(p)) return null;
    const persisted = JSON.parse(readFileSync(p, "utf-8"));
    const survivors = [];
    const dead = [];
    for (const w of persisted.workers) {
      if (w.state === "running" && isRecoveredSliceWorkerAlive(w)) {
        survivors.push(w);
      } else if (w.state === "running") {
        dead.push(w);
      } else {
        survivors.push(w);
      }
    }
    for (const w of dead) {
      const wtName = `${w.milestoneId}-${w.sliceId}`;
      try {
        removeWorktree(persisted.basePath, wtName, { deleteBranch: true, force: true });
      } catch {
      }
    }
    persisted.workers = survivors;
    if (survivors.length === 0) {
      removeSliceStateFile(basePath);
      return null;
    }
    return persisted;
  } catch {
    return null;
  }
}
function isSliceParallelActive(basePath) {
  if (sliceState?.active === true) return true;
  if (!basePath) return false;
  const restored = restoreSliceState(basePath);
  if (!restored || restored.workers.length === 0) return false;
  sliceState = {
    active: restored.active,
    workers: /* @__PURE__ */ new Map(),
    totalCost: restored.totalCost,
    budgetCeiling: restored.budgetCeiling,
    maxWorkers: restored.maxWorkers,
    startedAt: restored.startedAt,
    basePath: restored.basePath
  };
  for (const w of restored.workers) {
    sliceState.workers.set(w.sliceId, {
      milestoneId: w.milestoneId,
      sliceId: w.sliceId,
      pid: w.pid,
      process: null,
      worktreePath: w.worktreePath,
      workerToken: w.workerToken ?? "",
      processStartFingerprint: w.processStartFingerprint ?? null,
      startedAt: w.startedAt,
      state: w.state,
      completedUnits: w.completedUnits,
      cost: w.cost
    });
  }
  return true;
}
function getSliceOrchestratorState() {
  return sliceState;
}
async function startSliceParallel(basePath, milestoneId, eligibleSlices, opts = {}) {
  if (process.env.GSD_PARALLEL_WORKER) {
    return { started: [], errors: [{ sid: "all", error: "Cannot start slice-parallel from within a parallel worker" }] };
  }
  const maxWorkers = _resolveSliceParallelMaxWorkersForTest(opts.maxWorkers);
  const budgetCeiling = opts.budgetCeiling;
  sliceState = {
    active: true,
    workers: /* @__PURE__ */ new Map(),
    totalCost: 0,
    budgetCeiling,
    maxWorkers,
    startedAt: Date.now(),
    basePath
  };
  const started = [];
  const errors = [];
  const safeSlices = filterConflictingSlices(
    basePath,
    milestoneId,
    eligibleSlices,
    opts.useExecutionGraph === true
  );
  const toSpawn = safeSlices.slice(0, maxWorkers);
  for (const slice of toSpawn) {
    try {
      const wtBranch = `slice/${milestoneId}/${slice.id}`;
      const wtName = `${milestoneId}-${slice.id}`;
      const wtPath = worktreePath(basePath, wtName);
      if (!existsSync(wtPath)) {
        createWorktree(basePath, wtName, { branch: wtBranch });
      }
      const worker = {
        milestoneId,
        sliceId: slice.id,
        pid: 0,
        workerToken: createWorkerToken(milestoneId, slice.id),
        processStartFingerprint: null,
        process: null,
        worktreePath: wtPath,
        startedAt: Date.now(),
        state: "running",
        completedUnits: 0,
        cost: 0
      };
      sliceState.workers.set(slice.id, worker);
      const spawned = spawnSliceWorker(basePath, milestoneId, slice.id);
      if (spawned) {
        started.push(slice.id);
      } else {
        errors.push({ sid: slice.id, error: "Failed to spawn worker process" });
        sliceState.workers.delete(slice.id);
        try {
          removeWorktree(basePath, wtName, { deleteBranch: true, force: true });
        } catch {
        }
      }
    } catch (err) {
      errors.push({ sid: slice.id, error: getErrorMessage(err) });
      const wtName = `${milestoneId}-${slice.id}`;
      sliceState.workers.delete(slice.id);
      try {
        removeWorktree(basePath, wtName, { deleteBranch: true, force: true });
      } catch {
      }
    }
  }
  if (started.length === 0) {
    sliceState.active = false;
    removeSliceStateFile(basePath);
  } else {
    persistSliceState();
  }
  return { started, errors };
}
function stopSliceParallel() {
  if (!sliceState) return;
  const basePath = sliceState.basePath;
  for (const worker of sliceState.workers.values()) {
    try {
      if (worker.process) {
        worker.process.kill("SIGTERM");
      } else if (worker.state === "running" && isRecoveredSliceWorkerAlive(worker)) {
        process.kill(worker.pid, "SIGTERM");
      }
    } catch {
    }
    worker.cleanup?.();
    worker.cleanup = void 0;
    worker.process = null;
    worker.state = "stopped";
    const wtName = `${worker.milestoneId}-${worker.sliceId}`;
    try {
      removeWorktree(sliceState.basePath, wtName, { deleteBranch: true, force: true });
    } catch {
    }
  }
  sliceState.active = false;
  removeSliceStateFile(basePath);
}
function getSliceAggregateCost() {
  if (!sliceState) return 0;
  let total = 0;
  for (const w of sliceState.workers.values()) {
    total += w.cost;
  }
  return total;
}
function isSliceBudgetExceeded() {
  if (!sliceState?.budgetCeiling) return false;
  return getSliceAggregateCost() >= sliceState.budgetCeiling;
}
function resetSliceOrchestrator() {
  if (sliceState) {
    for (const w of sliceState.workers.values()) {
      w.cleanup?.();
    }
  }
  sliceState = null;
  lastPersistTs = 0;
}
function filterConflictingSlices(basePath, milestoneId, slices, useExecutionGraph) {
  if (useExecutionGraph) {
    const selectedIds = selectConflictFreeBatch({
      orderedIds: slices.map((slice) => slice.id),
      maxParallel: slices.length,
      hasConflict: (candidate, existing) => hasFileConflict(basePath, milestoneId, candidate, existing)
    });
    const selected = new Set(selectedIds);
    return slices.filter((slice) => selected.has(slice.id));
  }
  const safe = [];
  for (const candidate of slices) {
    let conflictsWithSafe = false;
    for (const existing of safe) {
      if (hasFileConflict(basePath, milestoneId, candidate.id, existing.id)) {
        conflictsWithSafe = true;
        break;
      }
    }
    if (!conflictsWithSafe) {
      safe.push(candidate);
    }
  }
  return safe;
}
function resolveGsdBin() {
  if (process.env.GSD_BIN_PATH && existsSync(process.env.GSD_BIN_PATH)) {
    return process.env.GSD_BIN_PATH;
  }
  let thisDir;
  try {
    thisDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    thisDir = process.cwd();
  }
  const candidates = [
    join(thisDir, "..", "..", "..", "loader.js"),
    join(thisDir, "..", "..", "..", "..", "dist", "loader.js")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
function spawnSliceWorker(basePath, milestoneId, sliceId) {
  if (!sliceState) return false;
  const worker = sliceState.workers.get(sliceId);
  if (!worker) return false;
  if (worker.process) return true;
  const binPath = resolveGsdBin();
  if (!binPath) return false;
  let child;
  try {
    child = spawn(process.execPath, [binPath, ...SLICE_WORKER_AUTO_ARGS], {
      cwd: worker.worktreePath,
      env: _buildSliceWorkerEnvForTest(basePath, milestoneId, sliceId, worker.workerToken),
      stdio: ["ignore", "pipe", "pipe"],
      detached: false
    });
  } catch {
    return false;
  }
  child.on("error", () => {
    if (!sliceState) return;
    const w = sliceState.workers.get(sliceId);
    if (w) {
      w.process = null;
    }
  });
  worker.process = child;
  worker.pid = child.pid ?? 0;
  worker.processStartFingerprint = worker.pid > 0 ? readProcessStartFingerprint(worker.pid) : null;
  if (!child.pid) {
    worker.process = null;
    worker.pid = 0;
    worker.processStartFingerprint = null;
    try {
      child.kill("SIGTERM");
    } catch {
    }
    return false;
  }
  if (child.stdout) {
    let stdoutBuffer = "";
    child.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        processSliceWorkerLine(basePath, milestoneId, sliceId, line);
      }
    });
    child.stdout.on("close", () => {
      if (stdoutBuffer.trim()) {
        processSliceWorkerLine(basePath, milestoneId, sliceId, stdoutBuffer);
      }
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (data) => {
      appendSliceWorkerLog(basePath, milestoneId, sliceId, data.toString());
    });
  }
  writeSessionStatus(basePath, {
    milestoneId: `${milestoneId}/${sliceId}`,
    pid: worker.pid,
    state: "running",
    currentUnit: null,
    completedUnits: worker.completedUnits,
    cost: worker.cost,
    lastHeartbeat: Date.now(),
    startedAt: worker.startedAt,
    worktreePath: worker.worktreePath
  });
  worker.cleanup = () => {
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.removeAllListeners();
  };
  child.on("exit", (code) => {
    if (!sliceState) return;
    const w = sliceState.workers.get(sliceId);
    if (!w) return;
    w.cleanup?.();
    w.cleanup = void 0;
    w.process = null;
    if (w.state === "stopped") return;
    if (code === 0) {
      w.state = "stopped";
    } else {
      w.state = "error";
      appendSliceWorkerLog(
        basePath,
        milestoneId,
        sliceId,
        `
[slice-orchestrator] worker exited with code ${code ?? "null"}
`
      );
    }
    writeSessionStatus(basePath, {
      milestoneId: `${milestoneId}/${sliceId}`,
      pid: w.pid,
      state: w.state,
      currentUnit: null,
      completedUnits: w.completedUnits,
      cost: w.cost,
      lastHeartbeat: Date.now(),
      startedAt: w.startedAt,
      worktreePath: w.worktreePath
    });
    persistSliceState();
  });
  return true;
}
function processSliceWorkerLine(_basePath, _milestoneId, sliceId, line) {
  if (!line.trim() || !sliceState) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const type = String(event.type ?? "");
  if (type === "message_end") {
    const worker = sliceState.workers.get(sliceId);
    if (worker) {
      const usage = event.usage;
      if (usage?.cost && typeof usage.cost === "number") {
        worker.cost += usage.cost;
        sliceState.totalCost += usage.cost;
      }
      worker.completedUnits++;
      persistSliceStateThrottled();
    }
  }
}
function sliceLogDir(basePath) {
  return join(gsdRoot(basePath), "parallel", "slice-logs");
}
function appendSliceWorkerLog(basePath, milestoneId, sliceId, text) {
  const dir = sliceLogDir(basePath);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${milestoneId}-${sliceId}.log`), text);
}
export {
  SLICE_WORKER_AUTO_ARGS,
  _buildSliceWorkerEnvForTest,
  _resolveSliceParallelMaxWorkersForTest,
  getSliceAggregateCost,
  getSliceOrchestratorState,
  isSliceBudgetExceeded,
  isSliceParallelActive,
  resetSliceOrchestrator,
  restoreSliceState,
  startSliceParallel,
  stopSliceParallel
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zbGljZS1wYXJhbGxlbC1vcmNoZXN0cmF0b3IudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIFNsaWNlIFBhcmFsbGVsIE9yY2hlc3RyYXRvciBcdTIwMTQgRW5naW5lIGZvciBwYXJhbGxlbCBzbGljZSBleGVjdXRpb25cbiAqIHdpdGhpbiBhIHNpbmdsZSBtaWxlc3RvbmUuXG4gKlxuICogTWlycm9ycyB0aGUgZXhpc3RpbmcgcGFyYWxsZWwtb3JjaGVzdHJhdG9yLnRzIHBhdHRlcm4gYXQgc2xpY2Ugc2NvcGVcbiAqIGluc3RlYWQgb2YgbWlsZXN0b25lIHNjb3BlLiBXb3JrZXJzIGFyZSBzZXBhcmF0ZSBwcm9jZXNzZXMgc3Bhd25lZCB2aWFcbiAqIGNoaWxkX3Byb2Nlc3MsIGVhY2ggcnVubmluZyBpbiBpdHMgb3duIGdpdCB3b3JrdHJlZSB3aXRoIEdTRF9TTElDRV9MT0NLXG4gKiArIEdTRF9NSUxFU1RPTkVfTE9DSyBlbnYgdmFycyBzZXQuXG4gKlxuICogS2V5IGRpZmZlcmVuY2VzIGZyb20gbWlsZXN0b25lLWxldmVsIHBhcmFsbGVsaXNtOlxuICogLSBTY29wZTogc2xpY2VzIHdpdGhpbiBvbmUgbWlsZXN0b25lLCBub3QgbWlsZXN0b25lcyB3aXRoaW4gYSBwcm9qZWN0XG4gKiAtIExvY2sgZW52OiBHU0RfU0xJQ0VfTE9DSyAoaW4gYWRkaXRpb24gdG8gR1NEX01JTEVTVE9ORV9MT0NLKVxuICogLSBDb25mbGljdCBjaGVjazogZmlsZSBvdmVybGFwIGJldHdlZW4gc2xpY2UgcGxhbnMgKHNsaWNlLXBhcmFsbGVsLWNvbmZsaWN0LnRzKVxuICovXG5cbmltcG9ydCB7IGV4ZWNGaWxlU3luYywgc3Bhd24sIHR5cGUgQ2hpbGRQcm9jZXNzIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgcmFuZG9tVVVJRCB9IGZyb20gXCJub2RlOmNyeXB0b1wiO1xuaW1wb3J0IHtcbiAgYXBwZW5kRmlsZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgbWtkaXJTeW5jLFxuICByZW5hbWVTeW5jLFxuICB1bmxpbmtTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgZGlybmFtZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IGdzZFJvb3QgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlV29ya3RyZWUsIHdvcmt0cmVlUGF0aCwgcmVtb3ZlV29ya3RyZWUgfSBmcm9tIFwiLi93b3JrdHJlZS1tYW5hZ2VyLmpzXCI7XG5pbXBvcnQgeyBhdXRvV29ya3RyZWVCcmFuY2gsIHJ1bldvcmt0cmVlUG9zdENyZWF0ZUhvb2sgfSBmcm9tIFwiLi9hdXRvLXdvcmt0cmVlLmpzXCI7XG5pbXBvcnQge1xuICB3cml0ZVNlc3Npb25TdGF0dXMsXG4gIHJlbW92ZVNlc3Npb25TdGF0dXMsXG59IGZyb20gXCIuL3Nlc3Npb24tc3RhdHVzLWlvLmpzXCI7XG5pbXBvcnQgeyBoYXNGaWxlQ29uZmxpY3QgfSBmcm9tIFwiLi9zbGljZS1wYXJhbGxlbC1jb25mbGljdC5qc1wiO1xuaW1wb3J0IHsgZ2V0RXJyb3JNZXNzYWdlIH0gZnJvbSBcIi4vZXJyb3ItdXRpbHMuanNcIjtcbmltcG9ydCB7IHNlbGVjdENvbmZsaWN0RnJlZUJhdGNoIH0gZnJvbSBcIi4vdW9rL2V4ZWN1dGlvbi1ncmFwaC5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgU2xpY2VXb3JrZXJJbmZvIHtcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgc2xpY2VJZDogc3RyaW5nO1xuICBwaWQ6IG51bWJlcjtcbiAgd29ya2VyVG9rZW46IHN0cmluZztcbiAgcHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQ6IHN0cmluZyB8IG51bGw7XG4gIHByb2Nlc3M6IENoaWxkUHJvY2VzcyB8IG51bGw7XG4gIHdvcmt0cmVlUGF0aDogc3RyaW5nO1xuICBzdGFydGVkQXQ6IG51bWJlcjtcbiAgc3RhdGU6IFwicnVubmluZ1wiIHwgXCJzdG9wcGVkXCIgfCBcImVycm9yXCI7XG4gIGNvbXBsZXRlZFVuaXRzOiBudW1iZXI7XG4gIGNvc3Q6IG51bWJlcjtcbiAgY2xlYW51cD86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2xpY2VPcmNoZXN0cmF0b3JTdGF0ZSB7XG4gIGFjdGl2ZTogYm9vbGVhbjtcbiAgd29ya2VyczogTWFwPHN0cmluZywgU2xpY2VXb3JrZXJJbmZvPjtcbiAgdG90YWxDb3N0OiBudW1iZXI7XG4gIGJ1ZGdldENlaWxpbmc/OiBudW1iZXI7XG4gIG1heFdvcmtlcnM6IG51bWJlcjtcbiAgc3RhcnRlZEF0OiBudW1iZXI7XG4gIGJhc2VQYXRoOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RhcnRTbGljZVBhcmFsbGVsT3B0cyB7XG4gIG1heFdvcmtlcnM/OiBudW1iZXI7XG4gIGJ1ZGdldENlaWxpbmc/OiBudW1iZXI7XG4gIHVzZUV4ZWN1dGlvbkdyYXBoPzogYm9vbGVhbjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1vZHVsZSBTdGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxubGV0IHNsaWNlU3RhdGU6IFNsaWNlT3JjaGVzdHJhdG9yU3RhdGUgfCBudWxsID0gbnVsbDtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBlcnNpc3RlZCBTdGF0ZSAoY3Jhc2ggcmVjb3ZlcnkpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy9cbi8vIE1pcnJvcnMgcGFyYWxsZWwtb3JjaGVzdHJhdG9yLnRzLiBXaXRob3V0IHBlcnNpc3RlbmNlLCBhIGNvb3JkaW5hdG9yIGNyYXNoXG4vLyBsZWF2ZXMgb3JwaGFuZWQgd29ya3RyZWVzIG9uIGRpc2sgd2l0aCBubyB3YXkgdG8gZGV0ZWN0IG9yIGNsZWFuIHRoZW0gdXBcbi8vIG9uIG5leHQgc2Vzc2lvbiBzdGFydC4gKElzc3VlICM0OTgwIEhJR0gtOClcblxuY29uc3QgU0xJQ0VfT1JDSEVTVFJBVE9SX1NUQVRFX0ZJTEUgPSBcInNsaWNlLW9yY2hlc3RyYXRvci5qc29uXCI7XG5jb25zdCBUTVBfU1VGRklYID0gXCIudG1wXCI7XG5leHBvcnQgY29uc3QgU0xJQ0VfV09SS0VSX0FVVE9fQVJHUyA9IFtcImhlYWRsZXNzXCIsIFwiLS1qc29uXCIsIFwiYXV0b1wiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIF9yZXNvbHZlU2xpY2VQYXJhbGxlbE1heFdvcmtlcnNGb3JUZXN0KG1heFdvcmtlcnM/OiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gbWF4V29ya2VycyA/PyAyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX2J1aWxkU2xpY2VXb3JrZXJFbnZGb3JUZXN0KFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBzbGljZUlkOiBzdHJpbmcsXG4gIHdvcmtlclRva2VuOiBzdHJpbmcsXG4gIHNvdXJjZUVudjogTm9kZUpTLlByb2Nlc3NFbnYgPSBwcm9jZXNzLmVudixcbik6IE5vZGVKUy5Qcm9jZXNzRW52IHtcbiAgcmV0dXJuIHtcbiAgICAuLi5zb3VyY2VFbnYsXG4gICAgR1NEX1NMSUNFX0xPQ0s6IHNsaWNlSWQsXG4gICAgR1NEX01JTEVTVE9ORV9MT0NLOiBtaWxlc3RvbmVJZCxcbiAgICBHU0RfUFJPSkVDVF9ST09UOiBiYXNlUGF0aCxcbiAgICBHU0RfUEFSQUxMRUxfV09SS0VSOiBcIjFcIixcbiAgICBHU0RfU0xJQ0VfV09SS0VSX1RPS0VOOiB3b3JrZXJUb2tlbixcbiAgfTtcbn1cblxuaW50ZXJmYWNlIFBlcnNpc3RlZFNsaWNlV29ya2VyIHtcbiAgbWlsZXN0b25lSWQ6IHN0cmluZztcbiAgc2xpY2VJZDogc3RyaW5nO1xuICBwaWQ6IG51bWJlcjtcbiAgd29ya2VyVG9rZW4/OiBzdHJpbmc7XG4gIHByb2Nlc3NTdGFydEZpbmdlcnByaW50Pzogc3RyaW5nIHwgbnVsbDtcbiAgd29ya3RyZWVQYXRoOiBzdHJpbmc7XG4gIHN0YXJ0ZWRBdDogbnVtYmVyO1xuICBzdGF0ZTogXCJydW5uaW5nXCIgfCBcInN0b3BwZWRcIiB8IFwiZXJyb3JcIjtcbiAgY29tcGxldGVkVW5pdHM6IG51bWJlcjtcbiAgY29zdDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgUGVyc2lzdGVkU2xpY2VTdGF0ZSB7XG4gIGFjdGl2ZTogYm9vbGVhbjtcbiAgd29ya2VyczogUGVyc2lzdGVkU2xpY2VXb3JrZXJbXTtcbiAgdG90YWxDb3N0OiBudW1iZXI7XG4gIGJ1ZGdldENlaWxpbmc/OiBudW1iZXI7XG4gIG1heFdvcmtlcnM6IG51bWJlcjtcbiAgc3RhcnRlZEF0OiBudW1iZXI7XG4gIGJhc2VQYXRoOiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIHNsaWNlU3RhdGVGaWxlUGF0aChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFNMSUNFX09SQ0hFU1RSQVRPUl9TVEFURV9GSUxFKTtcbn1cblxuZnVuY3Rpb24gaXNQaWRBbGl2ZShwaWQ6IG51bWJlcik6IGJvb2xlYW4ge1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIocGlkKSB8fCBwaWQgPD0gMCkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIHByb2Nlc3Mua2lsbChwaWQsIDApO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoKGVyciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGUgPT09IFwiRVBFUk1cIikgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRMaW51eFByb2Nlc3NTdGFydEZpbmdlcnByaW50KHBpZDogbnVtYmVyKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RhdCA9IHJlYWRGaWxlU3luYyhgL3Byb2MvJHtwaWR9L3N0YXRgLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IGFmdGVyQ29tbWFuZCA9IHN0YXQuc2xpY2Uoc3RhdC5sYXN0SW5kZXhPZihcIilcIikgKyAyKS50cmltKCk7XG4gICAgY29uc3QgZmllbGRzID0gYWZ0ZXJDb21tYW5kLnNwbGl0KC9cXHMrLyk7XG4gICAgY29uc3Qgc3RhcnRUaW1lVGlja3MgPSBmaWVsZHNbMTldO1xuICAgIHJldHVybiBzdGFydFRpbWVUaWNrcyA/IGBsaW51eC1zdGF0OiR7c3RhcnRUaW1lVGlja3N9YCA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlYWRQc1Byb2Nlc3NTdGFydEZpbmdlcnByaW50KHBpZDogbnVtYmVyKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gZXhlY0ZpbGVTeW5jKFwicHNcIiwgW1wiLXBcIiwgU3RyaW5nKHBpZCksIFwiLW9cIiwgXCJsc3RhcnQ9XCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgfSkudHJpbSgpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpO1xuICAgIHJldHVybiByYXcgPyBgcHMtbHN0YXJ0OiR7cmF3fWAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZWFkUHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQocGlkOiBudW1iZXIpOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHBpZCkgfHwgcGlkIDw9IDApIHJldHVybiBudWxsO1xuICByZXR1cm4gcmVhZExpbnV4UHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQocGlkKSA/PyByZWFkUHNQcm9jZXNzU3RhcnRGaW5nZXJwcmludChwaWQpO1xufVxuXG5mdW5jdGlvbiBsaW51eFByb2Nlc3NFbnZDb250YWlucyhwaWQ6IG51bWJlciwga2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHwgbnVsbCB7XG4gIGlmIChwcm9jZXNzLnBsYXRmb3JtICE9PSBcImxpbnV4XCIpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IGVudiA9IHJlYWRGaWxlU3luYyhgL3Byb2MvJHtwaWR9L2Vudmlyb25gLCBcInV0Zi04XCIpO1xuICAgIHJldHVybiBlbnYuc3BsaXQoXCJcXDBcIikuaW5jbHVkZXMoYCR7a2V5fT0ke3ZhbHVlfWApO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVXb3JrZXJUb2tlbihtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYHNsaWNlOiR7bWlsZXN0b25lSWR9OiR7c2xpY2VJZH06JHtEYXRlLm5vdygpfToke3JhbmRvbVVVSUQoKX1gO1xufVxuXG5mdW5jdGlvbiBpc1JlY292ZXJlZFNsaWNlV29ya2VyQWxpdmUod29ya2VyOiB7XG4gIHBpZDogbnVtYmVyO1xuICB3b3JrZXJUb2tlbj86IHN0cmluZztcbiAgcHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQ/OiBzdHJpbmcgfCBudWxsO1xufSk6IGJvb2xlYW4ge1xuICBpZiAoIWlzUGlkQWxpdmUod29ya2VyLnBpZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKCF3b3JrZXIucHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBjdXJyZW50RmluZ2VycHJpbnQgPSByZWFkUHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQod29ya2VyLnBpZCk7XG4gIGlmICghY3VycmVudEZpbmdlcnByaW50IHx8IGN1cnJlbnRGaW5nZXJwcmludCAhPT0gd29ya2VyLnByb2Nlc3NTdGFydEZpbmdlcnByaW50KSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgaWYgKHdvcmtlci53b3JrZXJUb2tlbikge1xuICAgIGNvbnN0IGVudk1hdGNoZXMgPSBsaW51eFByb2Nlc3NFbnZDb250YWlucyhcbiAgICAgIHdvcmtlci5waWQsXG4gICAgICBcIkdTRF9TTElDRV9XT1JLRVJfVE9LRU5cIixcbiAgICAgIHdvcmtlci53b3JrZXJUb2tlbixcbiAgICApO1xuICAgIGlmIChlbnZNYXRjaGVzID09PSBmYWxzZSkgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogUGVyc2lzdCBjdXJyZW50IHNsaWNlIG9yY2hlc3RyYXRvciBzdGF0ZS4gQXRvbWljIHdyaXRlICh0bXAgKyByZW5hbWUpIHRvXG4gKiBwcmV2ZW50IHBhcnRpYWwgcmVhZHMgaWYgdGhlIGNvb3JkaW5hdG9yIGRpZXMgbWlkLXdyaXRlLlxuICovXG5mdW5jdGlvbiBwZXJzaXN0U2xpY2VTdGF0ZSgpOiB2b2lkIHtcbiAgaWYgKCFzbGljZVN0YXRlKSByZXR1cm47XG4gIHRyeSB7XG4gICAgY29uc3QgZGlyID0gZ3NkUm9vdChzbGljZVN0YXRlLmJhc2VQYXRoKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMoZGlyKSkgbWtkaXJTeW5jKGRpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICBjb25zdCBwZXJzaXN0ZWQ6IFBlcnNpc3RlZFNsaWNlU3RhdGUgPSB7XG4gICAgICBhY3RpdmU6IHNsaWNlU3RhdGUuYWN0aXZlLFxuICAgICAgd29ya2VyczogWy4uLnNsaWNlU3RhdGUud29ya2Vycy52YWx1ZXMoKV0ubWFwKCh3KSA9PiAoe1xuICAgICAgICBtaWxlc3RvbmVJZDogdy5taWxlc3RvbmVJZCxcbiAgICAgICAgc2xpY2VJZDogdy5zbGljZUlkLFxuICAgICAgICBwaWQ6IHcucGlkLFxuICAgICAgICB3b3JrZXJUb2tlbjogdy53b3JrZXJUb2tlbixcbiAgICAgICAgcHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQ6IHcucHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQsXG4gICAgICAgIHdvcmt0cmVlUGF0aDogdy53b3JrdHJlZVBhdGgsXG4gICAgICAgIHN0YXJ0ZWRBdDogdy5zdGFydGVkQXQsXG4gICAgICAgIHN0YXRlOiB3LnN0YXRlLFxuICAgICAgICBjb21wbGV0ZWRVbml0czogdy5jb21wbGV0ZWRVbml0cyxcbiAgICAgICAgY29zdDogdy5jb3N0LFxuICAgICAgfSkpLFxuICAgICAgdG90YWxDb3N0OiBzbGljZVN0YXRlLnRvdGFsQ29zdCxcbiAgICAgIGJ1ZGdldENlaWxpbmc6IHNsaWNlU3RhdGUuYnVkZ2V0Q2VpbGluZyxcbiAgICAgIG1heFdvcmtlcnM6IHNsaWNlU3RhdGUubWF4V29ya2VycyxcbiAgICAgIHN0YXJ0ZWRBdDogc2xpY2VTdGF0ZS5zdGFydGVkQXQsXG4gICAgICBiYXNlUGF0aDogc2xpY2VTdGF0ZS5iYXNlUGF0aCxcbiAgICB9O1xuXG4gICAgY29uc3QgZGVzdCA9IHNsaWNlU3RhdGVGaWxlUGF0aChzbGljZVN0YXRlLmJhc2VQYXRoKTtcbiAgICBjb25zdCB0bXAgPSBkZXN0ICsgVE1QX1NVRkZJWDtcbiAgICB3cml0ZUZpbGVTeW5jKHRtcCwgSlNPTi5zdHJpbmdpZnkocGVyc2lzdGVkLCBudWxsLCAyKSwgXCJ1dGYtOFwiKTtcbiAgICByZW5hbWVTeW5jKHRtcCwgZGVzdCk7XG4gICAgbGFzdFBlcnNpc3RUcyA9IERhdGUubm93KCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1mYXRhbDogcGVyc2lzdGVuY2UgaXMgYmVzdC1lZmZvcnQgKi9cbiAgfVxufVxuXG4vKipcbiAqIFRocm90dGxlZCB3cmFwcGVyIGFyb3VuZCBgcGVyc2lzdFNsaWNlU3RhdGVgLiBTa2lwcyBpZiB0aGUgbGFzdCBzdWNjZXNzZnVsXG4gKiBwZXJzaXN0IHdhcyBsZXNzIHRoYW4gYFBFUlNJU1RfVEhST1RUTEVfTVNgIGFnbzsgb3RoZXJ3aXNlIHBlcnNpc3RzXG4gKiBpbW1lZGlhdGVseS4gVXNlIHRoaXMgb24gaG90IHBhdGhzIChlLmcuIGBtZXNzYWdlX2VuZGAgZXZlbnRzKSB3aGVyZSB3ZVxuICogcmVjZWl2ZSBtYW55IGV2ZW50cyBwZXIgc2Vjb25kIHBlciB3b3JrZXIuIFRlcm1pbmFsIGV2ZW50cyAod29ya2VyIGV4aXQsXG4gKiBjcmFzaCwgc3RvcCkgc2hvdWxkIGNhbGwgYHBlcnNpc3RTbGljZVN0YXRlKClgIGRpcmVjdGx5IHRvIGd1YXJhbnRlZSB0aGVcbiAqIGZpbmFsIHN0YXRlIGhpdHMgZGlzayByZWdhcmRsZXNzIG9mIHRpbWluZy5cbiAqL1xuY29uc3QgUEVSU0lTVF9USFJPVFRMRV9NUyA9IDEwMDA7XG5sZXQgbGFzdFBlcnNpc3RUcyA9IDA7XG5cbmZ1bmN0aW9uIHBlcnNpc3RTbGljZVN0YXRlVGhyb3R0bGVkKCk6IHZvaWQge1xuICBpZiAoRGF0ZS5ub3coKSAtIGxhc3RQZXJzaXN0VHMgPCBQRVJTSVNUX1RIUk9UVExFX01TKSByZXR1cm47XG4gIHBlcnNpc3RTbGljZVN0YXRlKCk7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZVNsaWNlU3RhdGVGaWxlKGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwID0gc2xpY2VTdGF0ZUZpbGVQYXRoKGJhc2VQYXRoKTtcbiAgICBpZiAoZXhpc3RzU3luYyhwKSkgdW5saW5rU3luYyhwKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9uLWZhdGFsICovXG4gIH1cbn1cblxuLyoqXG4gKiBSZXN0b3JlIHNsaWNlIG9yY2hlc3RyYXRvciBzdGF0ZSBmcm9tIGRpc2suIEZpbHRlcnMgZGVhZC1QSUQgd29ya2VycyBhbmRcbiAqIHJlbW92ZXMgdGhlaXIgb3JwaGFuZWQgd29ya3RyZWVzIHNvIGEgY2xlYW4gcmVzdGFydCBpcyBwb3NzaWJsZS5cbiAqXG4gKiBSZXR1cm5zIG51bGwgaWYgbm8gc3RhdGUgZmlsZSBleGlzdHMgb3Igbm8gd29ya2VycyBzdXJ2aXZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzdG9yZVNsaWNlU3RhdGUoYmFzZVBhdGg6IHN0cmluZyk6IFBlcnNpc3RlZFNsaWNlU3RhdGUgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwID0gc2xpY2VTdGF0ZUZpbGVQYXRoKGJhc2VQYXRoKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMocCkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHBlcnNpc3RlZCA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHAsIFwidXRmLThcIikpIGFzIFBlcnNpc3RlZFNsaWNlU3RhdGU7XG5cbiAgICBjb25zdCBzdXJ2aXZvcnM6IFBlcnNpc3RlZFNsaWNlV29ya2VyW10gPSBbXTtcbiAgICBjb25zdCBkZWFkOiBQZXJzaXN0ZWRTbGljZVdvcmtlcltdID0gW107XG4gICAgZm9yIChjb25zdCB3IG9mIHBlcnNpc3RlZC53b3JrZXJzKSB7XG4gICAgICBpZiAody5zdGF0ZSA9PT0gXCJydW5uaW5nXCIgJiYgaXNSZWNvdmVyZWRTbGljZVdvcmtlckFsaXZlKHcpKSB7XG4gICAgICAgIHN1cnZpdm9ycy5wdXNoKHcpO1xuICAgICAgfSBlbHNlIGlmICh3LnN0YXRlID09PSBcInJ1bm5pbmdcIikge1xuICAgICAgICBkZWFkLnB1c2godyk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdXJ2aXZvcnMucHVzaCh3KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBCZXN0LWVmZm9ydCBjbGVhbnVwIG9mIG9ycGhhbmVkIHdvcmt0cmVlcyBmcm9tIGRlYWQgd29ya2Vycy5cbiAgICBmb3IgKGNvbnN0IHcgb2YgZGVhZCkge1xuICAgICAgY29uc3Qgd3ROYW1lID0gYCR7dy5taWxlc3RvbmVJZH0tJHt3LnNsaWNlSWR9YDtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlbW92ZVdvcmt0cmVlKHBlcnNpc3RlZC5iYXNlUGF0aCwgd3ROYW1lLCB7IGRlbGV0ZUJyYW5jaDogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogd29ya3RyZWUgbWF5IGFscmVhZHkgYmUgZ29uZSAqL1xuICAgICAgfVxuICAgIH1cblxuICAgIHBlcnNpc3RlZC53b3JrZXJzID0gc3Vydml2b3JzO1xuXG4gICAgaWYgKHN1cnZpdm9ycy5sZW5ndGggPT09IDApIHtcbiAgICAgIHJlbW92ZVNsaWNlU3RhdGVGaWxlKGJhc2VQYXRoKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIHJldHVybiBwZXJzaXN0ZWQ7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgc2xpY2UtbGV2ZWwgcGFyYWxsZWwgaXMgY3VycmVudGx5IGFjdGl2ZS5cbiAqXG4gKiBJZiBpbi1tZW1vcnkgc3RhdGUgaXMgdW5zZXQgYnV0IGEgcGVyc2lzdGVkIHN0YXRlIGZpbGUgZXhpc3RzIHdpdGggYXRcbiAqIGxlYXN0IG9uZSBsaXZlLVBJRCB3b3JrZXIsIHRyZWF0IGFzIGFjdGl2ZSBhbmQgcmVoeWRyYXRlIHNvIGEgY29vcmRpbmF0b3JcbiAqIGNyYXNoIGZvbGxvd2VkIGJ5IGEgZnJlc2ggcHJvY2VzcyBpcyBkZXRlY3RhYmxlLiAoSXNzdWUgIzQ5ODAgSElHSC04KVxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTbGljZVBhcmFsbGVsQWN0aXZlKGJhc2VQYXRoPzogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChzbGljZVN0YXRlPy5hY3RpdmUgPT09IHRydWUpIHJldHVybiB0cnVlO1xuICBpZiAoIWJhc2VQYXRoKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHJlc3RvcmVkID0gcmVzdG9yZVNsaWNlU3RhdGUoYmFzZVBhdGgpO1xuICBpZiAoIXJlc3RvcmVkIHx8IHJlc3RvcmVkLndvcmtlcnMubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gUmVoeWRyYXRlIGluLW1lbW9yeSBzdGF0ZSBmcm9tIGRpc2s7IHByb2Nlc3NlcyBhcmUgZGV0YWNoZWQgc28gd2UgaGF2ZVxuICAvLyBubyBDaGlsZFByb2Nlc3MgaGFuZGxlcywgb25seSBQSURzLlxuICBzbGljZVN0YXRlID0ge1xuICAgIGFjdGl2ZTogcmVzdG9yZWQuYWN0aXZlLFxuICAgIHdvcmtlcnM6IG5ldyBNYXAoKSxcbiAgICB0b3RhbENvc3Q6IHJlc3RvcmVkLnRvdGFsQ29zdCxcbiAgICBidWRnZXRDZWlsaW5nOiByZXN0b3JlZC5idWRnZXRDZWlsaW5nLFxuICAgIG1heFdvcmtlcnM6IHJlc3RvcmVkLm1heFdvcmtlcnMsXG4gICAgc3RhcnRlZEF0OiByZXN0b3JlZC5zdGFydGVkQXQsXG4gICAgYmFzZVBhdGg6IHJlc3RvcmVkLmJhc2VQYXRoLFxuICB9O1xuICBmb3IgKGNvbnN0IHcgb2YgcmVzdG9yZWQud29ya2Vycykge1xuICAgIHNsaWNlU3RhdGUud29ya2Vycy5zZXQody5zbGljZUlkLCB7XG4gICAgICBtaWxlc3RvbmVJZDogdy5taWxlc3RvbmVJZCxcbiAgICAgIHNsaWNlSWQ6IHcuc2xpY2VJZCxcbiAgICAgIHBpZDogdy5waWQsXG4gICAgICBwcm9jZXNzOiBudWxsLFxuICAgICAgd29ya3RyZWVQYXRoOiB3Lndvcmt0cmVlUGF0aCxcbiAgICAgIHdvcmtlclRva2VuOiB3LndvcmtlclRva2VuID8/IFwiXCIsXG4gICAgICBwcm9jZXNzU3RhcnRGaW5nZXJwcmludDogdy5wcm9jZXNzU3RhcnRGaW5nZXJwcmludCA/PyBudWxsLFxuICAgICAgc3RhcnRlZEF0OiB3LnN0YXJ0ZWRBdCxcbiAgICAgIHN0YXRlOiB3LnN0YXRlLFxuICAgICAgY29tcGxldGVkVW5pdHM6IHcuY29tcGxldGVkVW5pdHMsXG4gICAgICBjb3N0OiB3LmNvc3QsXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogR2V0IGN1cnJlbnQgc2xpY2Ugb3JjaGVzdHJhdG9yIHN0YXRlIChyZWFkLW9ubHkgc25hcHNob3QpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2xpY2VPcmNoZXN0cmF0b3JTdGF0ZSgpOiBTbGljZU9yY2hlc3RyYXRvclN0YXRlIHwgbnVsbCB7XG4gIHJldHVybiBzbGljZVN0YXRlO1xufVxuXG4vKipcbiAqIFN0YXJ0IHBhcmFsbGVsIGV4ZWN1dGlvbiBmb3IgZWxpZ2libGUgc2xpY2VzIHdpdGhpbiBhIG1pbGVzdG9uZS5cbiAqXG4gKiBGb3IgZWFjaCBlbGlnaWJsZSBzbGljZTogY3JlYXRlIGEgd29ya3RyZWUsIHNwYXduIGBnc2QgaGVhZGxlc3MgLS1qc29uIGF1dG9gXG4gKiB3aXRoIGVudiBHU0RfU0xJQ0VfTE9DSz08U0lEPiArIEdTRF9NSUxFU1RPTkVfTE9DSz08TUlEPiArIEdTRF9QQVJBTExFTF9XT1JLRVI9MS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0U2xpY2VQYXJhbGxlbChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgZWxpZ2libGVTbGljZXM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PixcbiAgb3B0czogU3RhcnRTbGljZVBhcmFsbGVsT3B0cyA9IHt9LFxuKTogUHJvbWlzZTx7IHN0YXJ0ZWQ6IHN0cmluZ1tdOyBlcnJvcnM6IEFycmF5PHsgc2lkOiBzdHJpbmc7IGVycm9yOiBzdHJpbmcgfT4gfT4ge1xuICAvLyBQcmV2ZW50IG5lc3Rpbmc6IGlmIGFscmVhZHkgYSBwYXJhbGxlbCB3b3JrZXIsIHJlZnVzZVxuICBpZiAocHJvY2Vzcy5lbnYuR1NEX1BBUkFMTEVMX1dPUktFUikge1xuICAgIHJldHVybiB7IHN0YXJ0ZWQ6IFtdLCBlcnJvcnM6IFt7IHNpZDogXCJhbGxcIiwgZXJyb3I6IFwiQ2Fubm90IHN0YXJ0IHNsaWNlLXBhcmFsbGVsIGZyb20gd2l0aGluIGEgcGFyYWxsZWwgd29ya2VyXCIgfV0gfTtcbiAgfVxuXG4gIGNvbnN0IG1heFdvcmtlcnMgPSBfcmVzb2x2ZVNsaWNlUGFyYWxsZWxNYXhXb3JrZXJzRm9yVGVzdChvcHRzLm1heFdvcmtlcnMpO1xuICBjb25zdCBidWRnZXRDZWlsaW5nID0gb3B0cy5idWRnZXRDZWlsaW5nO1xuXG4gIC8vIEluaXRpYWxpemUgb3JjaGVzdHJhdG9yIHN0YXRlXG4gIHNsaWNlU3RhdGUgPSB7XG4gICAgYWN0aXZlOiB0cnVlLFxuICAgIHdvcmtlcnM6IG5ldyBNYXAoKSxcbiAgICB0b3RhbENvc3Q6IDAsXG4gICAgYnVkZ2V0Q2VpbGluZyxcbiAgICBtYXhXb3JrZXJzLFxuICAgIHN0YXJ0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICBiYXNlUGF0aCxcbiAgfTtcblxuICBjb25zdCBzdGFydGVkOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBlcnJvcnM6IEFycmF5PHsgc2lkOiBzdHJpbmc7IGVycm9yOiBzdHJpbmcgfT4gPSBbXTtcblxuICAvLyBGaWx0ZXIgb3V0IGNvbmZsaWN0aW5nIHNsaWNlcyAoY29uc2VydmF0aXZlOiBjaGVjayBhbGwgcGFpcnMpXG4gIGNvbnN0IHNhZmVTbGljZXMgPSBmaWx0ZXJDb25mbGljdGluZ1NsaWNlcyhcbiAgICBiYXNlUGF0aCxcbiAgICBtaWxlc3RvbmVJZCxcbiAgICBlbGlnaWJsZVNsaWNlcyxcbiAgICBvcHRzLnVzZUV4ZWN1dGlvbkdyYXBoID09PSB0cnVlLFxuICApO1xuXG4gIC8vIExpbWl0IHRvIG1heFdvcmtlcnNcbiAgY29uc3QgdG9TcGF3biA9IHNhZmVTbGljZXMuc2xpY2UoMCwgbWF4V29ya2Vycyk7XG5cbiAgZm9yIChjb25zdCBzbGljZSBvZiB0b1NwYXduKSB7XG4gICAgdHJ5IHtcbiAgICAgIC8vIENyZWF0ZSB3b3JrdHJlZSBmb3IgdGhpcyBzbGljZVxuICAgICAgY29uc3Qgd3RCcmFuY2ggPSBgc2xpY2UvJHttaWxlc3RvbmVJZH0vJHtzbGljZS5pZH1gO1xuICAgICAgY29uc3Qgd3ROYW1lID0gYCR7bWlsZXN0b25lSWR9LSR7c2xpY2UuaWR9YDtcbiAgICAgIGNvbnN0IHd0UGF0aCA9IHdvcmt0cmVlUGF0aChiYXNlUGF0aCwgd3ROYW1lKTtcblxuICAgICAgaWYgKCFleGlzdHNTeW5jKHd0UGF0aCkpIHtcbiAgICAgICAgY3JlYXRlV29ya3RyZWUoYmFzZVBhdGgsIHd0TmFtZSwgeyBicmFuY2g6IHd0QnJhbmNoIH0pO1xuICAgICAgfVxuXG4gICAgICAvLyBDcmVhdGUgd29ya2VyIGluZm9cbiAgICAgIGNvbnN0IHdvcmtlcjogU2xpY2VXb3JrZXJJbmZvID0ge1xuICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgc2xpY2VJZDogc2xpY2UuaWQsXG4gICAgICAgIHBpZDogMCxcbiAgICAgICAgd29ya2VyVG9rZW46IGNyZWF0ZVdvcmtlclRva2VuKG1pbGVzdG9uZUlkLCBzbGljZS5pZCksXG4gICAgICAgIHByb2Nlc3NTdGFydEZpbmdlcnByaW50OiBudWxsLFxuICAgICAgICBwcm9jZXNzOiBudWxsLFxuICAgICAgICB3b3JrdHJlZVBhdGg6IHd0UGF0aCxcbiAgICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICBzdGF0ZTogXCJydW5uaW5nXCIsXG4gICAgICAgIGNvbXBsZXRlZFVuaXRzOiAwLFxuICAgICAgICBjb3N0OiAwLFxuICAgICAgfTtcblxuICAgICAgc2xpY2VTdGF0ZS53b3JrZXJzLnNldChzbGljZS5pZCwgd29ya2VyKTtcblxuICAgICAgLy8gU3Bhd24gd29ya2VyXG4gICAgICBjb25zdCBzcGF3bmVkID0gc3Bhd25TbGljZVdvcmtlcihiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlLmlkKTtcbiAgICAgIGlmIChzcGF3bmVkKSB7XG4gICAgICAgIHN0YXJ0ZWQucHVzaChzbGljZS5pZCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBlcnJvcnMucHVzaCh7IHNpZDogc2xpY2UuaWQsIGVycm9yOiBcIkZhaWxlZCB0byBzcGF3biB3b3JrZXIgcHJvY2Vzc1wiIH0pO1xuICAgICAgICBzbGljZVN0YXRlLndvcmtlcnMuZGVsZXRlKHNsaWNlLmlkKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZW1vdmVXb3JrdHJlZShiYXNlUGF0aCwgd3ROYW1lLCB7IGRlbGV0ZUJyYW5jaDogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICAgIH0gY2F0Y2ggeyAvKiBpZ25vcmUgY2xlYW51cCBmYWlsdXJlcyAqLyB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBlcnJvcnMucHVzaCh7IHNpZDogc2xpY2UuaWQsIGVycm9yOiBnZXRFcnJvck1lc3NhZ2UoZXJyKSB9KTtcbiAgICAgIC8vIEJlc3QtZWZmb3J0IGNsZWFudXAgb2YgcGFydGlhbGx5IGNyZWF0ZWQgd29ya3RyZWVcbiAgICAgIGNvbnN0IHd0TmFtZSA9IGAke21pbGVzdG9uZUlkfS0ke3NsaWNlLmlkfWA7XG4gICAgICBzbGljZVN0YXRlLndvcmtlcnMuZGVsZXRlKHNsaWNlLmlkKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlbW92ZVdvcmt0cmVlKGJhc2VQYXRoLCB3dE5hbWUsIHsgZGVsZXRlQnJhbmNoOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIH0gY2F0Y2ggeyAvKiBpZ25vcmUgY2xlYW51cCBmYWlsdXJlcyAqLyB9XG4gICAgfVxuICB9XG5cbiAgLy8gSWYgbm90aGluZyBzdGFydGVkLCBkZWFjdGl2YXRlXG4gIGlmIChzdGFydGVkLmxlbmd0aCA9PT0gMCkge1xuICAgIHNsaWNlU3RhdGUuYWN0aXZlID0gZmFsc2U7XG4gICAgcmVtb3ZlU2xpY2VTdGF0ZUZpbGUoYmFzZVBhdGgpO1xuICB9IGVsc2Uge1xuICAgIC8vIFBlcnNpc3Qgc3RhdGUgZm9yIGNyYXNoIHJlY292ZXJ5IChJc3N1ZSAjNDk4MCBISUdILTgpLlxuICAgIHBlcnNpc3RTbGljZVN0YXRlKCk7XG4gIH1cblxuICByZXR1cm4geyBzdGFydGVkLCBlcnJvcnMgfTtcbn1cblxuLyoqXG4gKiBTdG9wIGFsbCBzbGljZS1wYXJhbGxlbCB3b3JrZXJzIGFuZCBkZWFjdGl2YXRlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3RvcFNsaWNlUGFyYWxsZWwoKTogdm9pZCB7XG4gIGlmICghc2xpY2VTdGF0ZSkgcmV0dXJuO1xuICBjb25zdCBiYXNlUGF0aCA9IHNsaWNlU3RhdGUuYmFzZVBhdGg7XG5cbiAgZm9yIChjb25zdCB3b3JrZXIgb2Ygc2xpY2VTdGF0ZS53b3JrZXJzLnZhbHVlcygpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmICh3b3JrZXIucHJvY2Vzcykge1xuICAgICAgICB3b3JrZXIucHJvY2Vzcy5raWxsKFwiU0lHVEVSTVwiKTtcbiAgICAgIH0gZWxzZSBpZiAod29ya2VyLnN0YXRlID09PSBcInJ1bm5pbmdcIiAmJiBpc1JlY292ZXJlZFNsaWNlV29ya2VyQWxpdmUod29ya2VyKSkge1xuICAgICAgICBwcm9jZXNzLmtpbGwod29ya2VyLnBpZCwgXCJTSUdURVJNXCIpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGRlYWQgKi8gfVxuICAgIHdvcmtlci5jbGVhbnVwPy4oKTtcbiAgICB3b3JrZXIuY2xlYW51cCA9IHVuZGVmaW5lZDtcbiAgICB3b3JrZXIucHJvY2VzcyA9IG51bGw7XG4gICAgd29ya2VyLnN0YXRlID0gXCJzdG9wcGVkXCI7XG5cbiAgICAvLyBDbGVhbiB1cCB3b3JrdHJlZSBjcmVhdGVkIGZvciB0aGlzIHdvcmtlclxuICAgIGNvbnN0IHd0TmFtZSA9IGAke3dvcmtlci5taWxlc3RvbmVJZH0tJHt3b3JrZXIuc2xpY2VJZH1gO1xuICAgIHRyeSB7XG4gICAgICByZW1vdmVXb3JrdHJlZShzbGljZVN0YXRlLmJhc2VQYXRoLCB3dE5hbWUsIHsgZGVsZXRlQnJhbmNoOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgY2xlYW51cCAqLyB9XG4gIH1cblxuICBzbGljZVN0YXRlLmFjdGl2ZSA9IGZhbHNlO1xuICAvLyBDbGVhciBwZXJzaXN0ZWQgc3RhdGUgXHUyMDE0IGNsZWFuIHNodXRkb3duIG1lYW5zIG5vIHJlY292ZXJ5IG9uIG5leHQgc3RhcnQuXG4gIC8vIChJc3N1ZSAjNDk4MCBISUdILTgpXG4gIHJlbW92ZVNsaWNlU3RhdGVGaWxlKGJhc2VQYXRoKTtcbn1cblxuLyoqXG4gKiBHZXQgYWdncmVnYXRlIGNvc3QgYWNyb3NzIGFsbCBzbGljZSB3b3JrZXJzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2xpY2VBZ2dyZWdhdGVDb3N0KCk6IG51bWJlciB7XG4gIGlmICghc2xpY2VTdGF0ZSkgcmV0dXJuIDA7XG4gIGxldCB0b3RhbCA9IDA7XG4gIGZvciAoY29uc3QgdyBvZiBzbGljZVN0YXRlLndvcmtlcnMudmFsdWVzKCkpIHtcbiAgICB0b3RhbCArPSB3LmNvc3Q7XG4gIH1cbiAgcmV0dXJuIHRvdGFsO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGJ1ZGdldCBjZWlsaW5nIGhhcyBiZWVuIGV4Y2VlZGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTbGljZUJ1ZGdldEV4Y2VlZGVkKCk6IGJvb2xlYW4ge1xuICBpZiAoIXNsaWNlU3RhdGU/LmJ1ZGdldENlaWxpbmcpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGdldFNsaWNlQWdncmVnYXRlQ29zdCgpID49IHNsaWNlU3RhdGUuYnVkZ2V0Q2VpbGluZztcbn1cblxuLyoqXG4gKiBSZXNldCBtb2R1bGUgc3RhdGUgKGZvciB0ZXN0aW5nKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0U2xpY2VPcmNoZXN0cmF0b3IoKTogdm9pZCB7XG4gIGlmIChzbGljZVN0YXRlKSB7XG4gICAgZm9yIChjb25zdCB3IG9mIHNsaWNlU3RhdGUud29ya2Vycy52YWx1ZXMoKSkge1xuICAgICAgdy5jbGVhbnVwPy4oKTtcbiAgICB9XG4gIH1cbiAgc2xpY2VTdGF0ZSA9IG51bGw7XG4gIGxhc3RQZXJzaXN0VHMgPSAwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSW50ZXJuYWw6IENvbmZsaWN0IEZpbHRlcmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZW1vdmUgc2xpY2VzIHRoYXQgaGF2ZSBmaWxlIGNvbmZsaWN0cyB3aXRoIGVhY2ggb3RoZXIuXG4gKiBHcmVlZHk6IGFkZCBzbGljZXMgdG8gdGhlIHNhZmUgc2V0IGluIG9yZGVyOyBza2lwIGFueSB0aGF0IGNvbmZsaWN0XG4gKiB3aXRoIGFuIGFscmVhZHktaW5jbHVkZWQgc2xpY2UuXG4gKi9cbmZ1bmN0aW9uIGZpbHRlckNvbmZsaWN0aW5nU2xpY2VzKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBzbGljZXM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PixcbiAgdXNlRXhlY3V0aW9uR3JhcGg6IGJvb2xlYW4sXG4pOiBBcnJheTx7IGlkOiBzdHJpbmcgfT4ge1xuICBpZiAodXNlRXhlY3V0aW9uR3JhcGgpIHtcbiAgICBjb25zdCBzZWxlY3RlZElkcyA9IHNlbGVjdENvbmZsaWN0RnJlZUJhdGNoKHtcbiAgICAgIG9yZGVyZWRJZHM6IHNsaWNlcy5tYXAoKHNsaWNlKSA9PiBzbGljZS5pZCksXG4gICAgICBtYXhQYXJhbGxlbDogc2xpY2VzLmxlbmd0aCxcbiAgICAgIGhhc0NvbmZsaWN0OiAoY2FuZGlkYXRlLCBleGlzdGluZykgPT5cbiAgICAgICAgaGFzRmlsZUNvbmZsaWN0KGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgY2FuZGlkYXRlLCBleGlzdGluZyksXG4gICAgfSk7XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBuZXcgU2V0KHNlbGVjdGVkSWRzKTtcbiAgICByZXR1cm4gc2xpY2VzLmZpbHRlcigoc2xpY2UpID0+IHNlbGVjdGVkLmhhcyhzbGljZS5pZCkpO1xuICB9XG5cbiAgY29uc3Qgc2FmZTogQXJyYXk8eyBpZDogc3RyaW5nIH0+ID0gW107XG5cbiAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2Ygc2xpY2VzKSB7XG4gICAgbGV0IGNvbmZsaWN0c1dpdGhTYWZlID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBleGlzdGluZyBvZiBzYWZlKSB7XG4gICAgICBpZiAoaGFzRmlsZUNvbmZsaWN0KGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgY2FuZGlkYXRlLmlkLCBleGlzdGluZy5pZCkpIHtcbiAgICAgICAgY29uZmxpY3RzV2l0aFNhZmUgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFjb25mbGljdHNXaXRoU2FmZSkge1xuICAgICAgc2FmZS5wdXNoKGNhbmRpZGF0ZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHNhZmU7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBJbnRlcm5hbDogV29ya2VyIFNwYXduaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlc29sdmUgdGhlIEdTRCBDTEkgYmluYXJ5IHBhdGguXG4gKiBTYW1lIGxvZ2ljIGFzIHBhcmFsbGVsLW9yY2hlc3RyYXRvci50cyByZXNvbHZlR3NkQmluKCkuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVHc2RCaW4oKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChwcm9jZXNzLmVudi5HU0RfQklOX1BBVEggJiYgZXhpc3RzU3luYyhwcm9jZXNzLmVudi5HU0RfQklOX1BBVEgpKSB7XG4gICAgcmV0dXJuIHByb2Nlc3MuZW52LkdTRF9CSU5fUEFUSDtcbiAgfVxuXG4gIGxldCB0aGlzRGlyOiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgdGhpc0RpciA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhpc0RpciA9IHByb2Nlc3MuY3dkKCk7XG4gIH1cbiAgY29uc3QgY2FuZGlkYXRlcyA9IFtcbiAgICBqb2luKHRoaXNEaXIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwibG9hZGVyLmpzXCIpLFxuICAgIGpvaW4odGhpc0RpciwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcImRpc3RcIiwgXCJsb2FkZXIuanNcIiksXG4gIF07XG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBpZiAoZXhpc3RzU3luYyhjYW5kaWRhdGUpKSByZXR1cm4gY2FuZGlkYXRlO1xuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogU3Bhd24gYSB3b3JrZXIgcHJvY2VzcyBmb3IgYSBzbGljZS5cbiAqIFRoZSB3b3JrZXIgcnVucyBgZ3NkIGhlYWRsZXNzIC0tanNvbiBhdXRvYCBpbiB0aGUgc2xpY2UncyB3b3JrdHJlZVxuICogd2l0aCBHU0RfU0xJQ0VfTE9DSywgR1NEX01JTEVTVE9ORV9MT0NLLCBhbmQgR1NEX1BBUkFMTEVMX1dPUktFUiBzZXQuXG4gKlxuICogUHJpbnQtbW9kZSBzbGFzaCBjb21tYW5kcyByZXR1cm4gYWZ0ZXIgdGhlIGNvbW1hbmQgaGFuZGxlciBzY2hlZHVsZXNcbiAqIGF1dG8tbW9kZSwgc28gdGhlIHdvcmtlciBwcm9jZXNzIGNhbiBleGl0IGJlZm9yZSBkb2luZyBhbnkgTExNIHdvcmsuIFRoZVxuICogaGVhZGxlc3MgYXV0byBlbnRyeXBvaW50IGtlZXBzIHRoZSBwcm9jZXNzIGFsaXZlIHVudGlsIGF1dG8tbW9kZSByZWFjaGVzIGFcbiAqIHRlcm1pbmFsIG5vdGlmaWNhdGlvbiwgbWF0Y2hpbmcgbWlsZXN0b25lLWxldmVsIHBhcmFsbGVsIHdvcmtlcnMuXG4gKi9cbmZ1bmN0aW9uIHNwYXduU2xpY2VXb3JrZXIoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIHNsaWNlSWQ6IHN0cmluZyxcbik6IGJvb2xlYW4ge1xuICBpZiAoIXNsaWNlU3RhdGUpIHJldHVybiBmYWxzZTtcbiAgY29uc3Qgd29ya2VyID0gc2xpY2VTdGF0ZS53b3JrZXJzLmdldChzbGljZUlkKTtcbiAgaWYgKCF3b3JrZXIpIHJldHVybiBmYWxzZTtcbiAgaWYgKHdvcmtlci5wcm9jZXNzKSByZXR1cm4gdHJ1ZTtcblxuICBjb25zdCBiaW5QYXRoID0gcmVzb2x2ZUdzZEJpbigpO1xuICBpZiAoIWJpblBhdGgpIHJldHVybiBmYWxzZTtcblxuICBsZXQgY2hpbGQ6IENoaWxkUHJvY2VzcztcbiAgdHJ5IHtcbiAgICBjaGlsZCA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtiaW5QYXRoLCAuLi5TTElDRV9XT1JLRVJfQVVUT19BUkdTXSwge1xuICAgICAgY3dkOiB3b3JrZXIud29ya3RyZWVQYXRoLFxuICAgICAgZW52OiBfYnVpbGRTbGljZVdvcmtlckVudkZvclRlc3QoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCB3b3JrZXIud29ya2VyVG9rZW4pLFxuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgZGV0YWNoZWQ6IGZhbHNlLFxuICAgIH0pO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBjaGlsZC5vbihcImVycm9yXCIsICgpID0+IHtcbiAgICBpZiAoIXNsaWNlU3RhdGUpIHJldHVybjtcbiAgICBjb25zdCB3ID0gc2xpY2VTdGF0ZS53b3JrZXJzLmdldChzbGljZUlkKTtcbiAgICBpZiAodykge1xuICAgICAgdy5wcm9jZXNzID0gbnVsbDtcbiAgICB9XG4gIH0pO1xuXG4gIHdvcmtlci5wcm9jZXNzID0gY2hpbGQ7XG4gIHdvcmtlci5waWQgPSBjaGlsZC5waWQgPz8gMDtcbiAgd29ya2VyLnByb2Nlc3NTdGFydEZpbmdlcnByaW50ID0gd29ya2VyLnBpZCA+IDBcbiAgICA/IHJlYWRQcm9jZXNzU3RhcnRGaW5nZXJwcmludCh3b3JrZXIucGlkKVxuICAgIDogbnVsbDtcblxuICBpZiAoIWNoaWxkLnBpZCkge1xuICAgIHdvcmtlci5wcm9jZXNzID0gbnVsbDtcbiAgICB3b3JrZXIucGlkID0gMDtcbiAgICB3b3JrZXIucHJvY2Vzc1N0YXJ0RmluZ2VycHJpbnQgPSBudWxsO1xuICAgIHRyeSB7IGNoaWxkLmtpbGwoXCJTSUdURVJNXCIpOyB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBOREpTT04gc3Rkb3V0IG1vbml0b3JpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChjaGlsZC5zdGRvdXQpIHtcbiAgICBsZXQgc3Rkb3V0QnVmZmVyID0gXCJcIjtcbiAgICBjaGlsZC5zdGRvdXQub24oXCJkYXRhXCIsIChkYXRhOiBCdWZmZXIpID0+IHtcbiAgICAgIHN0ZG91dEJ1ZmZlciArPSBkYXRhLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCBsaW5lcyA9IHN0ZG91dEJ1ZmZlci5zcGxpdChcIlxcblwiKTtcbiAgICAgIHN0ZG91dEJ1ZmZlciA9IGxpbmVzLnBvcCgpIHx8IFwiXCI7XG4gICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICAgICAgcHJvY2Vzc1NsaWNlV29ya2VyTGluZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQsIGxpbmUpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNoaWxkLnN0ZG91dC5vbihcImNsb3NlXCIsICgpID0+IHtcbiAgICAgIGlmIChzdGRvdXRCdWZmZXIudHJpbSgpKSB7XG4gICAgICAgIHByb2Nlc3NTbGljZVdvcmtlckxpbmUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCBzdGRvdXRCdWZmZXIpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgaWYgKGNoaWxkLnN0ZGVycikge1xuICAgIGNoaWxkLnN0ZGVyci5vbihcImRhdGFcIiwgKGRhdGE6IEJ1ZmZlcikgPT4ge1xuICAgICAgYXBwZW5kU2xpY2VXb3JrZXJMb2coYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCBkYXRhLnRvU3RyaW5nKCkpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gVXBkYXRlIHNlc3Npb24gc3RhdHVzXG4gIHdyaXRlU2Vzc2lvblN0YXR1cyhiYXNlUGF0aCwge1xuICAgIG1pbGVzdG9uZUlkOiBgJHttaWxlc3RvbmVJZH0vJHtzbGljZUlkfWAsXG4gICAgcGlkOiB3b3JrZXIucGlkLFxuICAgIHN0YXRlOiBcInJ1bm5pbmdcIixcbiAgICBjdXJyZW50VW5pdDogbnVsbCxcbiAgICBjb21wbGV0ZWRVbml0czogd29ya2VyLmNvbXBsZXRlZFVuaXRzLFxuICAgIGNvc3Q6IHdvcmtlci5jb3N0LFxuICAgIGxhc3RIZWFydGJlYXQ6IERhdGUubm93KCksXG4gICAgc3RhcnRlZEF0OiB3b3JrZXIuc3RhcnRlZEF0LFxuICAgIHdvcmt0cmVlUGF0aDogd29ya2VyLndvcmt0cmVlUGF0aCxcbiAgfSk7XG5cbiAgLy8gU3RvcmUgY2xlYW51cCBmdW5jdGlvblxuICB3b3JrZXIuY2xlYW51cCA9ICgpID0+IHtcbiAgICBjaGlsZC5zdGRvdXQ/LnJlbW92ZUFsbExpc3RlbmVycygpO1xuICAgIGNoaWxkLnN0ZGVycj8ucmVtb3ZlQWxsTGlzdGVuZXJzKCk7XG4gICAgY2hpbGQucmVtb3ZlQWxsTGlzdGVuZXJzKCk7XG4gIH07XG5cbiAgLy8gSGFuZGxlIHdvcmtlciBleGl0XG4gIGNoaWxkLm9uKFwiZXhpdFwiLCAoY29kZSkgPT4ge1xuICAgIGlmICghc2xpY2VTdGF0ZSkgcmV0dXJuO1xuICAgIGNvbnN0IHcgPSBzbGljZVN0YXRlLndvcmtlcnMuZ2V0KHNsaWNlSWQpO1xuICAgIGlmICghdykgcmV0dXJuO1xuXG4gICAgdy5jbGVhbnVwPy4oKTtcbiAgICB3LmNsZWFudXAgPSB1bmRlZmluZWQ7XG4gICAgdy5wcm9jZXNzID0gbnVsbDtcblxuICAgIGlmICh3LnN0YXRlID09PSBcInN0b3BwZWRcIikgcmV0dXJuO1xuXG4gICAgaWYgKGNvZGUgPT09IDApIHtcbiAgICAgIHcuc3RhdGUgPSBcInN0b3BwZWRcIjtcbiAgICB9IGVsc2Uge1xuICAgICAgdy5zdGF0ZSA9IFwiZXJyb3JcIjtcbiAgICAgIGFwcGVuZFNsaWNlV29ya2VyTG9nKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCxcbiAgICAgICAgYFxcbltzbGljZS1vcmNoZXN0cmF0b3JdIHdvcmtlciBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZSA/PyBcIm51bGxcIn1cXG5gKTtcbiAgICB9XG5cbiAgICB3cml0ZVNlc3Npb25TdGF0dXMoYmFzZVBhdGgsIHtcbiAgICAgIG1pbGVzdG9uZUlkOiBgJHttaWxlc3RvbmVJZH0vJHtzbGljZUlkfWAsXG4gICAgICBwaWQ6IHcucGlkLFxuICAgICAgc3RhdGU6IHcuc3RhdGUsXG4gICAgICBjdXJyZW50VW5pdDogbnVsbCxcbiAgICAgIGNvbXBsZXRlZFVuaXRzOiB3LmNvbXBsZXRlZFVuaXRzLFxuICAgICAgY29zdDogdy5jb3N0LFxuICAgICAgbGFzdEhlYXJ0YmVhdDogRGF0ZS5ub3coKSxcbiAgICAgIHN0YXJ0ZWRBdDogdy5zdGFydGVkQXQsXG4gICAgICB3b3JrdHJlZVBhdGg6IHcud29ya3RyZWVQYXRoLFxuICAgIH0pO1xuXG4gICAgLy8gUGVyc2lzdCB3b3JrZXIgdGVybWluYWwgc3RhdGUgZm9yIGNyYXNoIHJlY292ZXJ5LlxuICAgIC8vIChJc3N1ZSAjNDk4MCBISUdILTgpXG4gICAgcGVyc2lzdFNsaWNlU3RhdGUoKTtcbiAgfSk7XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBOREpTT04gUHJvY2Vzc2luZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBQcm9jZXNzIGEgc2luZ2xlIE5ESlNPTiBsaW5lIGZyb20gYSBzbGljZSB3b3JrZXIncyBzdGRvdXQuXG4gKiBFeHRyYWN0cyBjb3N0IGZyb20gbWVzc2FnZV9lbmQgZXZlbnRzLlxuICovXG5mdW5jdGlvbiBwcm9jZXNzU2xpY2VXb3JrZXJMaW5lKFxuICBfYmFzZVBhdGg6IHN0cmluZyxcbiAgX21pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIHNsaWNlSWQ6IHN0cmluZyxcbiAgbGluZTogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmICghbGluZS50cmltKCkgfHwgIXNsaWNlU3RhdGUpIHJldHVybjtcblxuICBsZXQgZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICB0cnkge1xuICAgIGV2ZW50ID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdHlwZSA9IFN0cmluZyhldmVudC50eXBlID8/IFwiXCIpO1xuICBpZiAodHlwZSA9PT0gXCJtZXNzYWdlX2VuZFwiKSB7XG4gICAgY29uc3Qgd29ya2VyID0gc2xpY2VTdGF0ZS53b3JrZXJzLmdldChzbGljZUlkKTtcbiAgICBpZiAod29ya2VyKSB7XG4gICAgICBjb25zdCB1c2FnZSA9IGV2ZW50LnVzYWdlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKHVzYWdlPy5jb3N0ICYmIHR5cGVvZiB1c2FnZS5jb3N0ID09PSBcIm51bWJlclwiKSB7XG4gICAgICAgIHdvcmtlci5jb3N0ICs9IHVzYWdlLmNvc3Q7XG4gICAgICAgIHNsaWNlU3RhdGUudG90YWxDb3N0ICs9IHVzYWdlLmNvc3Q7XG4gICAgICB9XG4gICAgICB3b3JrZXIuY29tcGxldGVkVW5pdHMrKztcbiAgICAgIC8vIFBlcnNpc3QgY29zdCAvIHByb2dyZXNzIHVwZGF0ZXMgc28gYSBjcmFzaCBtaWQtcnVuIHByZXNlcnZlcyB0aGVtLlxuICAgICAgLy8gVGhyb3R0bGVkICh+MS9zIHBlciBwcm9jZXNzKSBzbyBoaWdoLWZyZXF1ZW5jeSBtZXNzYWdlX2VuZCB0cmFmZmljXG4gICAgICAvLyBkb2VzIG5vdCBzYXR1cmF0ZSBkaXNrIEkvTy4gV29ya2VyIGV4aXQgLyBzdGFydCAvIHN0b3AgcGF0aHMgcGVyc2lzdFxuICAgICAgLy8gdW50aHJvdHRsZWQgdG8gZ3VhcmFudGVlIHRoZSB0ZXJtaW5hbCBzdGF0ZSBsYW5kcy4gKElzc3VlICM0OTgwIEhJR0gtOClcbiAgICAgIHBlcnNpc3RTbGljZVN0YXRlVGhyb3R0bGVkKCk7XG4gICAgfVxuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBMb2dnaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBzbGljZUxvZ0RpcihiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwicGFyYWxsZWxcIiwgXCJzbGljZS1sb2dzXCIpO1xufVxuXG5mdW5jdGlvbiBhcHBlbmRTbGljZVdvcmtlckxvZyhcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgc2xpY2VJZDogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgY29uc3QgZGlyID0gc2xpY2VMb2dEaXIoYmFzZVBhdGgpO1xuICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgYXBwZW5kRmlsZVN5bmMoam9pbihkaXIsIGAke21pbGVzdG9uZUlkfS0ke3NsaWNlSWR9LmxvZ2ApLCB0ZXh0KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWVBLFNBQVMsY0FBYyxhQUFnQztBQUN2RCxTQUFTLGtCQUFrQjtBQUMzQjtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxNQUFNLGVBQWU7QUFDOUIsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsZ0JBQWdCLGNBQWMsc0JBQXNCO0FBRTdEO0FBQUEsRUFDRTtBQUFBLE9BRUs7QUFDUCxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLCtCQUErQjtBQXFDeEMsSUFBSSxhQUE0QztBQVFoRCxNQUFNLGdDQUFnQztBQUN0QyxNQUFNLGFBQWE7QUFDWixNQUFNLHlCQUF5QixDQUFDLFlBQVksVUFBVSxNQUFNO0FBRTVELFNBQVMsdUNBQXVDLFlBQTZCO0FBQ2xGLFNBQU8s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
