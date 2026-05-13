import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gsdRoot } from "./paths.js";
import { createWorktree, worktreePath } from "./worktree-manager.js";
import { autoWorktreeBranch, fastForwardReusedMilestoneBranchIfSafe, runWorktreePostCreateHook, syncGsdStateToWorktree } from "./auto-worktree.js";
import { nativeBranchExists } from "./native-git-bridge.js";
import { readIntegrationBranch } from "./git-service.js";
import { resolveParallelConfig } from "./preferences.js";
import {
  writeSessionStatus,
  readAllSessionStatuses,
  readSessionStatus,
  removeSessionStatus,
  sendSignal,
  cleanupStaleSessions
} from "./session-status-io.js";
import {
  analyzeParallelEligibility
} from "./parallel-eligibility.js";
import { getErrorMessage } from "./error-utils.js";
import { logWarning } from "./workflow-logger.js";
import { resolveUokFlags } from "./uok/flags.js";
import { selectConflictFreeBatch } from "./uok/execution-graph.js";
let state = null;
function overlapKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}
const ORCHESTRATOR_STATE_FILE = "orchestrator.json";
const TMP_SUFFIX = ".tmp";
function stateFilePath(basePath) {
  return join(gsdRoot(basePath), ORCHESTRATOR_STATE_FILE);
}
function persistState(basePath) {
  if (!state) return;
  try {
    const dir = gsdRoot(basePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const persisted = {
      active: state.active,
      workers: [...state.workers.values()].map((w) => ({
        milestoneId: w.milestoneId,
        title: w.title,
        pid: w.pid,
        worktreePath: w.worktreePath,
        startedAt: w.startedAt,
        state: w.state,
        cost: w.cost
      })),
      totalCost: state.totalCost,
      startedAt: state.startedAt,
      configSnapshot: {
        max_workers: state.config.max_workers,
        budget_ceiling: state.config.budget_ceiling
      }
    };
    const dest = stateFilePath(basePath);
    const tmp = dest + TMP_SUFFIX;
    writeFileSync(tmp, JSON.stringify(persisted, null, 2), "utf-8");
    renameSync(tmp, dest);
  } catch (e) {
    logWarning("parallel", `persist parallel state failed: ${e.message}`);
  }
}
function removeStateFile(basePath) {
  try {
    const p = stateFilePath(basePath);
    if (existsSync(p)) unlinkSync(p);
  } catch (e) {
    logWarning("parallel", `clear parallel state file failed: ${e.message}`);
  }
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    logWarning("parallel", `pid alive check failed for pid ${pid}: ${e.message}`);
    return false;
  }
}
function restoreState(basePath) {
  try {
    const p = stateFilePath(basePath);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf-8");
    const persisted = JSON.parse(raw);
    persisted.workers = persisted.workers.filter((w) => {
      if (w.state === "stopped" || w.state === "error") return false;
      return isPidAlive(w.pid);
    });
    if (persisted.workers.length === 0) {
      removeStateFile(basePath);
      return null;
    }
    return persisted;
  } catch (e) {
    logWarning("parallel", `readParallelState JSON parse failed: ${e.message}`);
    return null;
  }
}
function workerLogPath(basePath, milestoneId) {
  return join(gsdRoot(basePath), "parallel", `${milestoneId}.stderr.log`);
}
function appendWorkerLog(basePath, milestoneId, chunk) {
  try {
    const dir = join(gsdRoot(basePath), "parallel");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(workerLogPath(basePath, milestoneId), chunk, "utf-8");
  } catch (e) {
    logWarning("parallel", `appendFileSync worker log failed for ${milestoneId}: ${e.message}`);
  }
}
function restoreRuntimeState(basePath) {
  if (state?.active) {
    const hasLiveWorker = [...state.workers.values()].some(
      (w) => w.state !== "error" && w.state !== "stopped"
    );
    if (hasLiveWorker) return true;
    state = null;
  }
  const restored = restoreState(basePath);
  if (restored && restored.workers.length > 0) {
    const config2 = resolveParallelConfig(void 0);
    state = {
      active: restored.active,
      workers: /* @__PURE__ */ new Map(),
      config: {
        ...config2,
        max_workers: restored.configSnapshot.max_workers,
        budget_ceiling: restored.configSnapshot.budget_ceiling
      },
      totalCost: restored.totalCost,
      startedAt: restored.startedAt
    };
    for (const w of restored.workers) {
      const diskStatus = readSessionStatus(basePath, w.milestoneId);
      state.workers.set(w.milestoneId, {
        milestoneId: w.milestoneId,
        title: w.title,
        pid: diskStatus?.pid ?? w.pid,
        process: null,
        worktreePath: diskStatus?.worktreePath ?? w.worktreePath,
        startedAt: w.startedAt,
        state: diskStatus?.state ?? w.state,
        cost: diskStatus?.cost ?? w.cost
      });
    }
    return true;
  }
  cleanupStaleSessions(basePath);
  const statuses = readAllSessionStatuses(basePath);
  if (statuses.length === 0) {
    return false;
  }
  const config = resolveParallelConfig(void 0);
  state = {
    active: true,
    workers: /* @__PURE__ */ new Map(),
    config,
    totalCost: 0,
    startedAt: Math.min(...statuses.map((status) => status.startedAt))
  };
  for (const status of statuses) {
    state.workers.set(status.milestoneId, {
      milestoneId: status.milestoneId,
      title: status.milestoneId,
      pid: status.pid,
      process: null,
      worktreePath: status.worktreePath,
      startedAt: status.startedAt,
      state: status.state,
      cost: status.cost
    });
    state.totalCost += status.cost;
  }
  return true;
}
async function waitForWorkerExit(worker, timeoutMs) {
  if (worker.process) {
    await new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(done, timeoutMs);
      worker.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return worker.process === null || !isPidAlive(worker.pid);
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(worker.pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(worker.pid);
}
function isParallelActive() {
  return state?.active ?? false;
}
function getOrchestratorState() {
  return state;
}
function getWorkerStatuses(basePath) {
  if (basePath) {
    refreshWorkerStatuses(basePath, { restoreIfNeeded: true });
  }
  if (!state) return [];
  return [...state.workers.values()];
}
async function prepareParallelStart(basePath, _prefs) {
  const sessions = readAllSessionStatuses(basePath);
  const orphans = [];
  for (const session of sessions) {
    const alive = isPidAlive(session.pid);
    orphans.push({ milestoneId: session.milestoneId, pid: session.pid, alive });
    if (!alive) {
      removeSessionStatus(basePath, session.milestoneId);
    }
  }
  const candidates = await analyzeParallelEligibility(basePath);
  return orphans.length > 0 ? { ...candidates, orphans } : candidates;
}
async function startParallel(basePath, milestoneIds, prefs) {
  if (process.env.GSD_PARALLEL_WORKER) {
    return { started: [], errors: [{ mid: "all", error: "Cannot start parallel from within a parallel worker" }] };
  }
  const config = resolveParallelConfig(prefs);
  const uokFlags = resolveUokFlags(prefs);
  if (state) {
    for (const w of state.workers.values()) {
      w.cleanup?.();
      w.cleanup = void 0;
      w.process = null;
    }
    state.workers.clear();
  }
  const restored = restoreState(basePath);
  if (restored && restored.workers.length > 0) {
    state = {
      active: true,
      workers: /* @__PURE__ */ new Map(),
      config,
      totalCost: restored.totalCost,
      startedAt: restored.startedAt
    };
    const adopted = [];
    for (const w of restored.workers) {
      state.workers.set(w.milestoneId, {
        milestoneId: w.milestoneId,
        title: w.title,
        pid: w.pid,
        process: null,
        // no handle for adopted workers
        worktreePath: w.worktreePath,
        startedAt: w.startedAt,
        state: "running",
        cost: w.cost
      });
      adopted.push(w.milestoneId);
    }
    return { started: adopted, errors: [] };
  }
  const now = Date.now();
  state = {
    active: true,
    workers: /* @__PURE__ */ new Map(),
    config,
    totalCost: 0,
    startedAt: now
  };
  const started = [];
  const errors = [];
  let filteredMilestoneIds = milestoneIds;
  if (uokFlags.executionGraph && milestoneIds.length > 1) {
    try {
      const requestedIds = new Set(milestoneIds);
      const candidates = await analyzeParallelEligibility(basePath);
      const overlapPairs = /* @__PURE__ */ new Set();
      for (const overlap of candidates.fileOverlaps) {
        if (!requestedIds.has(overlap.mid1) || !requestedIds.has(overlap.mid2)) continue;
        overlapPairs.add(overlapKey(overlap.mid1, overlap.mid2));
      }
      filteredMilestoneIds = selectConflictFreeBatch({
        orderedIds: milestoneIds,
        maxParallel: milestoneIds.length,
        hasConflict: (candidate, existing) => overlapPairs.has(overlapKey(candidate, existing))
      });
      if (filteredMilestoneIds.length < milestoneIds.length) {
        const skipped = milestoneIds.filter((mid) => !filteredMilestoneIds.includes(mid));
        logWarning(
          "parallel",
          `uok execution graph filtered ${skipped.length} conflicting milestone(s): ${skipped.join(", ")}`
        );
      }
    } catch (e) {
      logWarning(
        "parallel",
        `uok execution graph overlap analysis failed; using legacy milestone selection: ${e.message}`
      );
      filteredMilestoneIds = milestoneIds;
    }
  }
  const toStart = filteredMilestoneIds.slice(0, config.max_workers);
  for (const mid of toStart) {
    if (isBudgetExceeded()) {
      errors.push({ mid, error: `Budget ceiling ($${config.budget_ceiling}) reached \u2014 skipping` });
      continue;
    }
    try {
      let wtPath;
      try {
        wtPath = _createMilestoneWorktree(basePath, mid);
      } catch (e) {
        logWarning("parallel", `createMilestoneWorktree fallback for ${mid}: ${e.message}`);
        wtPath = worktreePath(basePath, mid);
      }
      const worker = {
        milestoneId: mid,
        title: mid,
        pid: 0,
        // placeholder — real PID set by spawnWorker()
        process: null,
        worktreePath: wtPath,
        startedAt: now,
        state: "running",
        cost: 0
      };
      state.workers.set(mid, worker);
      const spawned = spawnWorker(basePath, mid);
      if (!spawned) {
        worker.state = "error";
      }
      writeSessionStatus(basePath, {
        milestoneId: mid,
        pid: worker.pid,
        state: worker.state,
        currentUnit: null,
        completedUnits: 0,
        cost: 0,
        lastHeartbeat: now,
        startedAt: now,
        worktreePath: wtPath
      });
      started.push(mid);
    } catch (err) {
      const message = getErrorMessage(err);
      errors.push({ mid, error: message });
    }
  }
  if (started.length === 0) {
    state.active = false;
  }
  persistState(basePath);
  return { started, errors };
}
function _createMilestoneWorktree(basePath, milestoneId) {
  const branch = autoWorktreeBranch(milestoneId);
  const branchExists = nativeBranchExists(basePath, branch);
  let info;
  if (branchExists) {
    fastForwardReusedMilestoneBranchIfSafe(basePath, milestoneId, branch);
    info = createWorktree(basePath, milestoneId, { branch, reuseExistingBranch: true });
  } else {
    const integrationBranch = readIntegrationBranch(basePath, milestoneId) ?? void 0;
    info = createWorktree(basePath, milestoneId, { branch, startPoint: integrationBranch });
  }
  runWorktreePostCreateHook(basePath, info.path);
  syncGsdStateToWorktree(basePath, info.path);
  return info.path;
}
function spawnWorker(basePath, milestoneId) {
  if (!state) return false;
  const worker = state.workers.get(milestoneId);
  if (!worker) return false;
  if (worker.process) return true;
  const binPath = resolveGsdBin();
  if (!binPath) return false;
  let child;
  try {
    const workerEnv = {
      ...process.env,
      GSD_MILESTONE_LOCK: milestoneId,
      // Pass the real project root so workers don't need to re-derive it.
      // Without this, process.cwd() resolves symlinks and the worktree
      // path heuristic can match the user-level ~/.gsd instead of the
      // project .gsd, causing writes to ~ and corrupting user config.
      GSD_PROJECT_ROOT: basePath,
      // Prevent workers from spawning their own parallel sessions
      GSD_PARALLEL_WORKER: "1"
    };
    if (state.config.worker_model) {
      workerEnv.GSD_WORKER_MODEL = state.config.worker_model;
    }
    child = spawn(process.execPath, [binPath, "headless", "--json", "auto"], {
      cwd: worker.worktreePath,
      env: workerEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false
    });
  } catch (e) {
    logWarning("parallel", `spawnSync worker failed for ${milestoneId}: ${e.message}`);
    return false;
  }
  child.on("error", () => {
    if (!state) return;
    const w = state.workers.get(milestoneId);
    if (w) {
      w.process = null;
    }
  });
  worker.process = child;
  worker.pid = child.pid ?? 0;
  if (!child.pid) {
    worker.process = null;
    return false;
  }
  if (child.stdout) {
    let stdoutBuffer = "";
    child.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        processWorkerLine(basePath, milestoneId, line);
      }
    });
    child.stdout.on("close", () => {
      if (stdoutBuffer.trim()) {
        processWorkerLine(basePath, milestoneId, stdoutBuffer);
      }
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (data) => {
      appendWorkerLog(basePath, milestoneId, data.toString());
    });
  }
  writeSessionStatus(basePath, {
    milestoneId,
    pid: worker.pid,
    state: "running",
    currentUnit: null,
    completedUnits: 0,
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
    if (!state) return;
    const w = state.workers.get(milestoneId);
    if (!w) return;
    w.cleanup?.();
    w.cleanup = void 0;
    w.process = null;
    if (w.state === "stopped") return;
    if (code === 0) {
      w.state = "stopped";
    } else {
      w.state = "error";
      appendWorkerLog(basePath, milestoneId, `
[orchestrator] worker exited with code ${code ?? "null"}
`);
    }
    writeSessionStatus(basePath, {
      milestoneId,
      pid: w.pid,
      state: w.state,
      currentUnit: null,
      completedUnits: 0,
      cost: w.cost,
      lastHeartbeat: Date.now(),
      startedAt: w.startedAt,
      worktreePath: w.worktreePath
    });
    persistState(basePath);
  });
  return true;
}
function resolveGsdBin() {
  if (process.env.GSD_BIN_PATH && existsSync(process.env.GSD_BIN_PATH)) {
    return process.env.GSD_BIN_PATH;
  }
  let thisDir;
  try {
    thisDir = dirname(fileURLToPath(import.meta.url));
  } catch (e) {
    logWarning("parallel", `dirname(fileURLToPath) failed: ${e.message}`);
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
function processWorkerLine(basePath, milestoneId, line) {
  if (!line.trim() || !state) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const type = String(event.type ?? "");
  if (type === "message_end" && event.message) {
    const msg = event.message;
    const usage = msg.usage;
    if (usage) {
      const cost = usage.cost?.total;
      if (typeof cost === "number") {
        const worker2 = state.workers.get(milestoneId);
        if (worker2) {
          worker2.cost += cost;
          state.totalCost = 0;
          for (const w of state.workers.values()) {
            state.totalCost += w.cost;
          }
        }
      }
    }
    const worker = state.workers.get(milestoneId);
    if (worker) {
      writeSessionStatus(basePath, {
        milestoneId,
        pid: worker.pid,
        state: worker.state,
        currentUnit: null,
        completedUnits: 0,
        cost: worker.cost,
        lastHeartbeat: Date.now(),
        startedAt: worker.startedAt,
        worktreePath: worker.worktreePath
      });
    }
  }
  if (type === "extension_ui_request" && event.method === "notify") {
    const worker = state.workers.get(milestoneId);
    if (worker) {
      writeSessionStatus(basePath, {
        milestoneId,
        pid: worker.pid,
        state: worker.state,
        currentUnit: null,
        completedUnits: 0,
        cost: worker.cost,
        lastHeartbeat: Date.now(),
        startedAt: worker.startedAt,
        worktreePath: worker.worktreePath
      });
    }
  }
}
async function stopParallel(basePath, milestoneId) {
  if (!state) return;
  const targets = milestoneId ? [milestoneId] : [...state.workers.keys()];
  for (const mid of targets) {
    const worker = state.workers.get(mid);
    if (!worker) continue;
    sendSignal(basePath, mid, "stop");
    if (worker.pid > 0) {
      try {
        if (worker.process) {
          worker.process.kill("SIGTERM");
        } else if (worker.pid !== process.pid) {
          process.kill(worker.pid, "SIGTERM");
        }
      } catch (e) {
        logWarning("parallel", `process.kill SIGTERM failed for pid ${worker.pid}: ${e.message}`);
      }
    }
    const exitedAfterTerm = await waitForWorkerExit(worker, 3e3);
    if (!exitedAfterTerm && worker.pid > 0) {
      try {
        if (worker.process) {
          worker.process.kill("SIGKILL");
        } else if (worker.pid !== process.pid) {
          process.kill(worker.pid, "SIGKILL");
        }
      } catch (e) {
        logWarning("parallel", `process.kill SIGKILL failed for pid ${worker.pid}: ${e.message}`);
      }
      await waitForWorkerExit(worker, 250);
    }
    worker.cleanup?.();
    worker.cleanup = void 0;
    worker.state = "stopped";
    worker.process = null;
    removeSessionStatus(basePath, mid);
  }
  if (!milestoneId) {
    state.active = false;
  }
  removeStateFile(basePath);
}
async function shutdownParallel(basePath) {
  if (!state) return;
  await stopParallel(basePath);
  resetOrchestrator();
}
function pauseWorker(basePath, milestoneId) {
  if (!state) return;
  const targets = milestoneId ? [milestoneId] : [...state.workers.keys()];
  for (const mid of targets) {
    const worker = state.workers.get(mid);
    if (!worker || worker.state !== "running") continue;
    sendSignal(basePath, mid, "pause");
    worker.state = "paused";
  }
}
function resumeWorker(basePath, milestoneId) {
  if (!state) return;
  const targets = milestoneId ? [milestoneId] : [...state.workers.keys()];
  for (const mid of targets) {
    const worker = state.workers.get(mid);
    if (!worker || worker.state !== "paused") continue;
    sendSignal(basePath, mid, "resume");
    worker.state = "running";
  }
}
function refreshWorkerStatuses(basePath, options = {}) {
  if (!state && options.restoreIfNeeded) {
    restoreRuntimeState(basePath);
  }
  if (!state) return;
  const staleIds = cleanupStaleSessions(basePath);
  for (const mid of staleIds) {
    const worker = state.workers.get(mid);
    if (worker) {
      worker.cleanup?.();
      worker.cleanup = void 0;
      worker.state = "error";
      worker.process = null;
    }
  }
  const statuses = readAllSessionStatuses(basePath);
  const statusMap = /* @__PURE__ */ new Map();
  for (const s of statuses) {
    statusMap.set(s.milestoneId, s);
  }
  for (const [mid, worker] of state.workers) {
    const diskStatus = statusMap.get(mid);
    if (!diskStatus) {
      if (!isPidAlive(worker.pid)) {
        worker.cleanup?.();
        worker.cleanup = void 0;
        worker.state = "error";
        worker.process = null;
      }
      continue;
    }
    worker.state = diskStatus.state;
    worker.cost = diskStatus.cost;
    worker.pid = diskStatus.pid;
  }
  state.totalCost = 0;
  for (const worker of state.workers.values()) {
    state.totalCost += worker.cost;
  }
  const allDead = [...state.workers.values()].every(
    (w) => w.state === "error" || w.state === "stopped"
  );
  if (allDead) {
    state.active = false;
    removeStateFile(basePath);
    state = null;
    return;
  }
  persistState(basePath);
}
function getAggregateCost() {
  if (!state) return 0;
  return state.totalCost;
}
function isBudgetExceeded() {
  if (!state) return false;
  if (state.config.budget_ceiling == null) return false;
  return state.totalCost >= state.config.budget_ceiling;
}
function resetOrchestrator() {
  if (state) {
    for (const w of state.workers.values()) {
      w.cleanup?.();
      w.cleanup = void 0;
      w.process = null;
    }
    state.workers.clear();
  }
  state = null;
}
export {
  _createMilestoneWorktree,
  getAggregateCost,
  getOrchestratorState,
  getWorkerStatuses,
  isBudgetExceeded,
  isParallelActive,
  pauseWorker,
  persistState,
  prepareParallelStart,
  refreshWorkerStatuses,
  resetOrchestrator,
  restoreState,
  resumeWorker,
  shutdownParallel,
  spawnWorker,
  startParallel,
  stopParallel
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wYXJhbGxlbC1vcmNoZXN0cmF0b3IudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIFBhcmFsbGVsIE9yY2hlc3RyYXRvciBcdTIwMTQgQ29yZSBlbmdpbmUgZm9yIHBhcmFsbGVsIG1pbGVzdG9uZSBvcmNoZXN0cmF0aW9uLlxuICpcbiAqIE1hbmFnZXMgd29ya2VyIGxpZmVjeWNsZSwgYnVkZ2V0IHRyYWNraW5nLCBhbmQgY29vcmRpbmF0aW9uLiBXb3JrZXJzIGFyZVxuICogc2VwYXJhdGUgcHJvY2Vzc2VzIHNwYXduZWQgdmlhIGNoaWxkX3Byb2Nlc3MsIGVhY2ggcnVubmluZyBpbiBpdHMgb3duIGdpdFxuICogd29ya3RyZWUgd2l0aCBHU0RfTUlMRVNUT05FX0xPQ0sgZW52IHZhciBzZXQuIFRoZSBjb29yZGluYXRvciBtb25pdG9yc1xuICogd29ya2VycyB2aWEgc2Vzc2lvbiBzdGF0dXMgZmlsZXMgKHNlZSBzZXNzaW9uLXN0YXR1cy1pby50cykuXG4gKi9cblxuaW1wb3J0IHsgc3Bhd24sIHR5cGUgQ2hpbGRQcm9jZXNzIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgYXBwZW5kRmlsZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVuYW1lU3luYyxcbiAgdW5saW5rU3luYyxcbiAgbWtkaXJTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgZGlybmFtZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IGdzZFJvb3QgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlV29ya3RyZWUsIHdvcmt0cmVlUGF0aCB9IGZyb20gXCIuL3dvcmt0cmVlLW1hbmFnZXIuanNcIjtcbmltcG9ydCB7IGF1dG9Xb3JrdHJlZUJyYW5jaCwgZmFzdEZvcndhcmRSZXVzZWRNaWxlc3RvbmVCcmFuY2hJZlNhZmUsIHJ1bldvcmt0cmVlUG9zdENyZWF0ZUhvb2ssIHN5bmNHc2RTdGF0ZVRvV29ya3RyZWUgfSBmcm9tIFwiLi9hdXRvLXdvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyBuYXRpdmVCcmFuY2hFeGlzdHMgfSBmcm9tIFwiLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc1wiO1xuaW1wb3J0IHsgcmVhZEludGVncmF0aW9uQnJhbmNoIH0gZnJvbSBcIi4vZ2l0LXNlcnZpY2UuanNcIjtcbmltcG9ydCB7IHJlc29sdmVQYXJhbGxlbENvbmZpZyB9IGZyb20gXCIuL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgUGFyYWxsZWxDb25maWcgfSBmcm9tIFwiLi90eXBlcy5qc1wiO1xuaW1wb3J0IHtcbiAgd3JpdGVTZXNzaW9uU3RhdHVzLFxuICByZWFkQWxsU2Vzc2lvblN0YXR1c2VzLFxuICByZWFkU2Vzc2lvblN0YXR1cyxcbiAgcmVtb3ZlU2Vzc2lvblN0YXR1cyxcbiAgc2VuZFNpZ25hbCxcbiAgY2xlYW51cFN0YWxlU2Vzc2lvbnMsXG4gIHR5cGUgU2Vzc2lvblN0YXR1cyxcbn0gZnJvbSBcIi4vc2Vzc2lvbi1zdGF0dXMtaW8uanNcIjtcbmltcG9ydCB7XG4gIGFuYWx5emVQYXJhbGxlbEVsaWdpYmlsaXR5LFxuICB0eXBlIFBhcmFsbGVsQ2FuZGlkYXRlcyxcbn0gZnJvbSBcIi4vcGFyYWxsZWwtZWxpZ2liaWxpdHkuanNcIjtcbmltcG9ydCB7IGdldEVycm9yTWVzc2FnZSB9IGZyb20gXCIuL2Vycm9yLXV0aWxzLmpzXCI7XG5pbXBvcnQgeyBsb2dXYXJuaW5nIH0gZnJvbSBcIi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlVW9rRmxhZ3MgfSBmcm9tIFwiLi91b2svZmxhZ3MuanNcIjtcbmltcG9ydCB7IHNlbGVjdENvbmZsaWN0RnJlZUJhdGNoIH0gZnJvbSBcIi4vdW9rL2V4ZWN1dGlvbi1ncmFwaC5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgV29ya2VySW5mbyB7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHBpZDogbnVtYmVyO1xuICBwcm9jZXNzOiBDaGlsZFByb2Nlc3MgfCBudWxsOyAvLyBudWxsIGFmdGVyIHByb2Nlc3MgZXhpdHNcbiAgd29ya3RyZWVQYXRoOiBzdHJpbmc7XG4gIHN0YXJ0ZWRBdDogbnVtYmVyO1xuICBzdGF0ZTogXCJydW5uaW5nXCIgfCBcInBhdXNlZFwiIHwgXCJzdG9wcGVkXCIgfCBcImVycm9yXCI7XG4gIGNvc3Q6IG51bWJlcjtcbiAgY2xlYW51cD86ICgpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgT3JjaGVzdHJhdG9yU3RhdGUge1xuICBhY3RpdmU6IGJvb2xlYW47XG4gIHdvcmtlcnM6IE1hcDxzdHJpbmcsIFdvcmtlckluZm8+O1xuICBjb25maWc6IFBhcmFsbGVsQ29uZmlnO1xuICB0b3RhbENvc3Q6IG51bWJlcjtcbiAgc3RhcnRlZEF0OiBudW1iZXI7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNb2R1bGUgU3RhdGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmxldCBzdGF0ZTogT3JjaGVzdHJhdG9yU3RhdGUgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gb3ZlcmxhcEtleShhOiBzdHJpbmcsIGI6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBhIDwgYiA/IGAke2F9Ojoke2J9YCA6IGAke2J9Ojoke2F9YDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBlcnNpc3RlbmNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5jb25zdCBPUkNIRVNUUkFUT1JfU1RBVEVfRklMRSA9IFwib3JjaGVzdHJhdG9yLmpzb25cIjtcbmNvbnN0IFRNUF9TVUZGSVggPSBcIi50bXBcIjtcblxuZXhwb3J0IGludGVyZmFjZSBQZXJzaXN0ZWRTdGF0ZSB7XG4gIGFjdGl2ZTogYm9vbGVhbjtcbiAgd29ya2VyczogQXJyYXk8e1xuICAgIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gICAgdGl0bGU6IHN0cmluZztcbiAgICBwaWQ6IG51bWJlcjtcbiAgICB3b3JrdHJlZVBhdGg6IHN0cmluZztcbiAgICBzdGFydGVkQXQ6IG51bWJlcjtcbiAgICBzdGF0ZTogXCJydW5uaW5nXCIgfCBcInBhdXNlZFwiIHwgXCJzdG9wcGVkXCIgfCBcImVycm9yXCI7XG4gICAgY29zdDogbnVtYmVyO1xuICB9PjtcbiAgdG90YWxDb3N0OiBudW1iZXI7XG4gIHN0YXJ0ZWRBdDogbnVtYmVyO1xuICBjb25maWdTbmFwc2hvdDogeyBtYXhfd29ya2VyczogbnVtYmVyOyBidWRnZXRfY2VpbGluZz86IG51bWJlciB9O1xufVxuXG5mdW5jdGlvbiBzdGF0ZUZpbGVQYXRoKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihnc2RSb290KGJhc2VQYXRoKSwgT1JDSEVTVFJBVE9SX1NUQVRFX0ZJTEUpO1xufVxuXG4vKipcbiAqIFBlcnNpc3QgdGhlIGN1cnJlbnQgb3JjaGVzdHJhdG9yIHN0YXRlIHRvIC5nc2Qvb3JjaGVzdHJhdG9yLmpzb24uXG4gKiBVc2VzIGF0b21pYyB3cml0ZSAodG1wICsgcmVuYW1lKSB0byBwcmV2ZW50IHBhcnRpYWwgcmVhZHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwZXJzaXN0U3RhdGUoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIXN0YXRlKSByZXR1cm47XG4gIHRyeSB7XG4gICAgY29uc3QgZGlyID0gZ3NkUm9vdChiYXNlUGF0aCk7XG4gICAgaWYgKCFleGlzdHNTeW5jKGRpcikpIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgcGVyc2lzdGVkOiBQZXJzaXN0ZWRTdGF0ZSA9IHtcbiAgICAgIGFjdGl2ZTogc3RhdGUuYWN0aXZlLFxuICAgICAgd29ya2VyczogWy4uLnN0YXRlLndvcmtlcnMudmFsdWVzKCldLm1hcCgodykgPT4gKHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IHcubWlsZXN0b25lSWQsXG4gICAgICAgIHRpdGxlOiB3LnRpdGxlLFxuICAgICAgICBwaWQ6IHcucGlkLFxuICAgICAgICB3b3JrdHJlZVBhdGg6IHcud29ya3RyZWVQYXRoLFxuICAgICAgICBzdGFydGVkQXQ6IHcuc3RhcnRlZEF0LFxuICAgICAgICBzdGF0ZTogdy5zdGF0ZSxcbiAgICAgICAgY29zdDogdy5jb3N0LFxuICAgICAgfSkpLFxuICAgICAgdG90YWxDb3N0OiBzdGF0ZS50b3RhbENvc3QsXG4gICAgICBzdGFydGVkQXQ6IHN0YXRlLnN0YXJ0ZWRBdCxcbiAgICAgIGNvbmZpZ1NuYXBzaG90OiB7XG4gICAgICAgIG1heF93b3JrZXJzOiBzdGF0ZS5jb25maWcubWF4X3dvcmtlcnMsXG4gICAgICAgIGJ1ZGdldF9jZWlsaW5nOiBzdGF0ZS5jb25maWcuYnVkZ2V0X2NlaWxpbmcsXG4gICAgICB9LFxuICAgIH07XG5cbiAgICBjb25zdCBkZXN0ID0gc3RhdGVGaWxlUGF0aChiYXNlUGF0aCk7XG4gICAgY29uc3QgdG1wID0gZGVzdCArIFRNUF9TVUZGSVg7XG4gICAgd3JpdGVGaWxlU3luYyh0bXAsIEpTT04uc3RyaW5naWZ5KHBlcnNpc3RlZCwgbnVsbCwgMiksIFwidXRmLThcIik7XG4gICAgcmVuYW1lU3luYyh0bXAsIGRlc3QpO1xuICB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJwYXJhbGxlbFwiLCBgcGVyc2lzdCBwYXJhbGxlbCBzdGF0ZSBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7IH1cbn1cblxuLyoqXG4gKiBSZW1vdmUgdGhlIHBlcnNpc3RlZCBzdGF0ZSBmaWxlLlxuICovXG5mdW5jdGlvbiByZW1vdmVTdGF0ZUZpbGUoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIGNvbnN0IHAgPSBzdGF0ZUZpbGVQYXRoKGJhc2VQYXRoKTtcbiAgICBpZiAoZXhpc3RzU3luYyhwKSkgdW5saW5rU3luYyhwKTtcbiAgfSBjYXRjaCAoZSkgeyBsb2dXYXJuaW5nKFwicGFyYWxsZWxcIiwgYGNsZWFyIHBhcmFsbGVsIHN0YXRlIGZpbGUgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG59XG5cbmZ1bmN0aW9uIGlzUGlkQWxpdmUocGlkOiBudW1iZXIpOiBib29sZWFuIHtcbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHBpZCkgfHwgcGlkIDw9IDApIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmtpbGwocGlkLCAwKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ1dhcm5pbmcoXCJwYXJhbGxlbFwiLCBgcGlkIGFsaXZlIGNoZWNrIGZhaWxlZCBmb3IgcGlkICR7cGlkfTogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBSZXN0b3JlIG9yY2hlc3RyYXRvciBzdGF0ZSBmcm9tIC5nc2Qvb3JjaGVzdHJhdG9yLmpzb24uXG4gKiBDaGVja3MgUElEIGxpdmVuZXNzIGZvciBlYWNoIHdvcmtlcjpcbiAqIC0gTGl2aW5nIFBJRCBcdTIxOTIgc3RhdGUgXCJydW5uaW5nXCIsIHByb2Nlc3Mgc3RheXMgbnVsbCAobm8gaGFuZGxlKVxuICogLSBEZWFkIFBJRCBcdTIxOTIgcmVtb3ZlZCBmcm9tIHJlc3RvcmVkIHN0YXRlXG4gKiBSZXR1cm5zIG51bGwgaWYgbm8gc3RhdGUgZmlsZSBleGlzdHMgb3Igbm8gd29ya2VycyBzdXJ2aXZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzdG9yZVN0YXRlKGJhc2VQYXRoOiBzdHJpbmcpOiBQZXJzaXN0ZWRTdGF0ZSB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHAgPSBzdGF0ZUZpbGVQYXRoKGJhc2VQYXRoKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMocCkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhwLCBcInV0Zi04XCIpO1xuICAgIGNvbnN0IHBlcnNpc3RlZCA9IEpTT04ucGFyc2UocmF3KSBhcyBQZXJzaXN0ZWRTdGF0ZTtcblxuICAgIC8vIEZpbHRlciB0byBvbmx5IHdvcmtlcnMgd2l0aCBsaXZpbmcgUElEc1xuICAgIHBlcnNpc3RlZC53b3JrZXJzID0gcGVyc2lzdGVkLndvcmtlcnMuZmlsdGVyKCh3KSA9PiB7XG4gICAgICBpZiAody5zdGF0ZSA9PT0gXCJzdG9wcGVkXCIgfHwgdy5zdGF0ZSA9PT0gXCJlcnJvclwiKSByZXR1cm4gZmFsc2U7XG4gICAgICByZXR1cm4gaXNQaWRBbGl2ZSh3LnBpZCk7XG4gICAgfSk7XG5cbiAgICBpZiAocGVyc2lzdGVkLndvcmtlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgICAvLyBObyBzdXJ2aXZpbmcgd29ya2VycyBcdTIwMTQgY2xlYW4gdXAgYW5kIHJldHVybiBudWxsXG4gICAgICByZW1vdmVTdGF0ZUZpbGUoYmFzZVBhdGgpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgcmV0dXJuIHBlcnNpc3RlZDtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ1dhcm5pbmcoXCJwYXJhbGxlbFwiLCBgcmVhZFBhcmFsbGVsU3RhdGUgSlNPTiBwYXJzZSBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gd29ya2VyTG9nUGF0aChiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwicGFyYWxsZWxcIiwgYCR7bWlsZXN0b25lSWR9LnN0ZGVyci5sb2dgKTtcbn1cblxuZnVuY3Rpb24gYXBwZW5kV29ya2VyTG9nKGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIGNodW5rOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBkaXIgPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcInBhcmFsbGVsXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhkaXIpKSBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhcHBlbmRGaWxlU3luYyh3b3JrZXJMb2dQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCksIGNodW5rLCBcInV0Zi04XCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcInBhcmFsbGVsXCIsIGBhcHBlbmRGaWxlU3luYyB3b3JrZXIgbG9nIGZhaWxlZCBmb3IgJHttaWxlc3RvbmVJZH06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzdG9yZVJ1bnRpbWVTdGF0ZShiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChzdGF0ZT8uYWN0aXZlKSB7XG4gICAgLy8gVmVyaWZ5IGF0IGxlYXN0IG9uZSB3b3JrZXIgaXMgYWxpdmUgXHUyMDE0IGlmIGFsbCBhcmUgaW4gdGVybWluYWwgc3RhdGVzLFxuICAgIC8vIHRoZSBjYWNoZWQgc3RhdGUgaXMgc3RhbGUgYW5kIHdlIHNob3VsZCBmYWxsIHRocm91Z2ggdG8gY2xlYW51cC5cbiAgICBjb25zdCBoYXNMaXZlV29ya2VyID0gWy4uLnN0YXRlLndvcmtlcnMudmFsdWVzKCldLnNvbWUoXG4gICAgICAodykgPT4gdy5zdGF0ZSAhPT0gXCJlcnJvclwiICYmIHcuc3RhdGUgIT09IFwic3RvcHBlZFwiLFxuICAgICk7XG4gICAgaWYgKGhhc0xpdmVXb3JrZXIpIHJldHVybiB0cnVlO1xuXG4gICAgLy8gQWxsIHdvcmtlcnMgZGVhZCBcdTIwMTQgY2xlYXIgc3RhbGUgc3RhdGUgc28gcmVzdG9yZVN0YXRlKCkgY2FuIGNsZWFuIHVwLlxuICAgIHN0YXRlID0gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IHJlc3RvcmVkID0gcmVzdG9yZVN0YXRlKGJhc2VQYXRoKTtcbiAgaWYgKHJlc3RvcmVkICYmIHJlc3RvcmVkLndvcmtlcnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVQYXJhbGxlbENvbmZpZyh1bmRlZmluZWQpO1xuICAgIHN0YXRlID0ge1xuICAgICAgYWN0aXZlOiByZXN0b3JlZC5hY3RpdmUsXG4gICAgICB3b3JrZXJzOiBuZXcgTWFwKCksXG4gICAgICBjb25maWc6IHtcbiAgICAgICAgLi4uY29uZmlnLFxuICAgICAgICBtYXhfd29ya2VyczogcmVzdG9yZWQuY29uZmlnU25hcHNob3QubWF4X3dvcmtlcnMsXG4gICAgICAgIGJ1ZGdldF9jZWlsaW5nOiByZXN0b3JlZC5jb25maWdTbmFwc2hvdC5idWRnZXRfY2VpbGluZyxcbiAgICAgIH0sXG4gICAgICB0b3RhbENvc3Q6IHJlc3RvcmVkLnRvdGFsQ29zdCxcbiAgICAgIHN0YXJ0ZWRBdDogcmVzdG9yZWQuc3RhcnRlZEF0LFxuICAgIH07XG5cbiAgICBmb3IgKGNvbnN0IHcgb2YgcmVzdG9yZWQud29ya2Vycykge1xuICAgICAgY29uc3QgZGlza1N0YXR1cyA9IHJlYWRTZXNzaW9uU3RhdHVzKGJhc2VQYXRoLCB3Lm1pbGVzdG9uZUlkKTtcbiAgICAgIHN0YXRlLndvcmtlcnMuc2V0KHcubWlsZXN0b25lSWQsIHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IHcubWlsZXN0b25lSWQsXG4gICAgICAgIHRpdGxlOiB3LnRpdGxlLFxuICAgICAgICBwaWQ6IGRpc2tTdGF0dXM/LnBpZCA/PyB3LnBpZCxcbiAgICAgICAgcHJvY2VzczogbnVsbCxcbiAgICAgICAgd29ya3RyZWVQYXRoOiBkaXNrU3RhdHVzPy53b3JrdHJlZVBhdGggPz8gdy53b3JrdHJlZVBhdGgsXG4gICAgICAgIHN0YXJ0ZWRBdDogdy5zdGFydGVkQXQsXG4gICAgICAgIHN0YXRlOiBkaXNrU3RhdHVzPy5zdGF0ZSA/PyB3LnN0YXRlLFxuICAgICAgICBjb3N0OiBkaXNrU3RhdHVzPy5jb3N0ID8/IHcuY29zdCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gRmFsbGJhY2s6IHJlYnVpbGQgY29vcmRpbmF0b3Igc3RhdGUgZnJvbSBsaXZlIHNlc3Npb24gc3RhdHVzIGZpbGVzLlxuICAvLyBUaGlzIGNvdmVycyBjYXNlcyB3aGVyZSBvcmNoZXN0cmF0b3IuanNvbiBpcyBtaXNzaW5nL2NvcnJ1cHQgYnV0IHdvcmtlcnMgYXJlXG4gIC8vIHN0aWxsIHJ1bm5pbmcgYW5kIHdyaXRpbmcgaGVhcnRiZWF0cyB1bmRlciAuZ3NkL3BhcmFsbGVsLy5cbiAgY2xlYW51cFN0YWxlU2Vzc2lvbnMoYmFzZVBhdGgpO1xuICBjb25zdCBzdGF0dXNlcyA9IHJlYWRBbGxTZXNzaW9uU3RhdHVzZXMoYmFzZVBhdGgpO1xuICBpZiAoc3RhdHVzZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgY29uc3QgY29uZmlnID0gcmVzb2x2ZVBhcmFsbGVsQ29uZmlnKHVuZGVmaW5lZCk7XG4gIHN0YXRlID0ge1xuICAgIGFjdGl2ZTogdHJ1ZSxcbiAgICB3b3JrZXJzOiBuZXcgTWFwKCksXG4gICAgY29uZmlnLFxuICAgIHRvdGFsQ29zdDogMCxcbiAgICBzdGFydGVkQXQ6IE1hdGgubWluKC4uLnN0YXR1c2VzLm1hcCgoc3RhdHVzKSA9PiBzdGF0dXMuc3RhcnRlZEF0KSksXG4gIH07XG5cbiAgZm9yIChjb25zdCBzdGF0dXMgb2Ygc3RhdHVzZXMpIHtcbiAgICBzdGF0ZS53b3JrZXJzLnNldChzdGF0dXMubWlsZXN0b25lSWQsIHtcbiAgICAgIG1pbGVzdG9uZUlkOiBzdGF0dXMubWlsZXN0b25lSWQsXG4gICAgICB0aXRsZTogc3RhdHVzLm1pbGVzdG9uZUlkLFxuICAgICAgcGlkOiBzdGF0dXMucGlkLFxuICAgICAgcHJvY2VzczogbnVsbCxcbiAgICAgIHdvcmt0cmVlUGF0aDogc3RhdHVzLndvcmt0cmVlUGF0aCxcbiAgICAgIHN0YXJ0ZWRBdDogc3RhdHVzLnN0YXJ0ZWRBdCxcbiAgICAgIHN0YXRlOiBzdGF0dXMuc3RhdGUsXG4gICAgICBjb3N0OiBzdGF0dXMuY29zdCxcbiAgICB9KTtcbiAgICBzdGF0ZS50b3RhbENvc3QgKz0gc3RhdHVzLmNvc3Q7XG4gIH1cblxuICByZXR1cm4gdHJ1ZTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gd2FpdEZvcldvcmtlckV4aXQod29ya2VyOiBXb3JrZXJJbmZvLCB0aW1lb3V0TXM6IG51bWJlcik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAod29ya2VyLnByb2Nlc3MpIHtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgICAgY29uc3QgZG9uZSA9ICgpID0+IHJlc29sdmUoKTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChkb25lLCB0aW1lb3V0TXMpO1xuICAgICAgd29ya2VyLnByb2Nlc3MhLm9uY2UoXCJleGl0XCIsICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHdvcmtlci5wcm9jZXNzID09PSBudWxsIHx8ICFpc1BpZEFsaXZlKHdvcmtlci5waWQpO1xuICB9XG5cbiAgY29uc3Qgc3RhcnRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgd2hpbGUgKERhdGUubm93KCkgLSBzdGFydGVkQXQgPCB0aW1lb3V0TXMpIHtcbiAgICBpZiAoIWlzUGlkQWxpdmUod29ya2VyLnBpZCkpIHJldHVybiB0cnVlO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIDUwKSk7XG4gIH1cbiAgcmV0dXJuICFpc1BpZEFsaXZlKHdvcmtlci5waWQpO1xufVxuXG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBY2Nlc3NvcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBSZXR1cm5zIHRydWUgaWYgdGhlIG9yY2hlc3RyYXRvciBpcyBhY3RpdmUgYW5kIGhhcyBiZWVuIGluaXRpYWxpemVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUGFyYWxsZWxBY3RpdmUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBzdGF0ZT8uYWN0aXZlID8/IGZhbHNlO1xufVxuXG4vKiogUmV0dXJucyB0aGUgY3VycmVudCBvcmNoZXN0cmF0b3Igc3RhdGUsIG9yIG51bGwgaWYgbm90IGluaXRpYWxpemVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldE9yY2hlc3RyYXRvclN0YXRlKCk6IE9yY2hlc3RyYXRvclN0YXRlIHwgbnVsbCB7XG4gIHJldHVybiBzdGF0ZTtcbn1cblxuLyoqIFJldHVybnMgYSBzbmFwc2hvdCBvZiBhbGwgdHJhY2tlZCB3b3JrZXJzIGFzIGFuIGFycmF5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFdvcmtlclN0YXR1c2VzKGJhc2VQYXRoPzogc3RyaW5nKTogV29ya2VySW5mb1tdIHtcbiAgaWYgKGJhc2VQYXRoKSB7XG4gICAgcmVmcmVzaFdvcmtlclN0YXR1c2VzKGJhc2VQYXRoLCB7IHJlc3RvcmVJZk5lZWRlZDogdHJ1ZSB9KTtcbiAgfVxuICBpZiAoIXN0YXRlKSByZXR1cm4gW107XG4gIHJldHVybiBbLi4uc3RhdGUud29ya2Vycy52YWx1ZXMoKV07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQcmVwYXJhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBBbmFseXplIGVsaWdpYmlsaXR5IGFuZCBwcmVwYXJlIGZvciBwYXJhbGxlbCBzdGFydC5cbiAqIFJldHVybnMgdGhlIGNhbmRpZGF0ZXMgcmVwb3J0IHdpdGhvdXQgYWN0dWFsbHkgc3RhcnRpbmcgd29ya2Vycy5cbiAqIEFsc28gZGV0ZWN0cyBvcnBoYW5lZCBzZXNzaW9ucyBmcm9tIHByaW9yIGNyYXNoZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcmVwYXJlUGFyYWxsZWxTdGFydChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgX3ByZWZzOiBHU0RQcmVmZXJlbmNlcyB8IHVuZGVmaW5lZCxcbik6IFByb21pc2U8UGFyYWxsZWxDYW5kaWRhdGVzICYgeyBvcnBoYW5zPzogQXJyYXk8eyBtaWxlc3RvbmVJZDogc3RyaW5nOyBwaWQ6IG51bWJlcjsgYWxpdmU6IGJvb2xlYW4gfT4gfT4ge1xuICAvLyBEZXRlY3Qgb3JwaGFuZWQgc2Vzc2lvbnMgYmVmb3JlIGVsaWdpYmlsaXR5IGFuYWx5c2lzXG4gIGNvbnN0IHNlc3Npb25zID0gcmVhZEFsbFNlc3Npb25TdGF0dXNlcyhiYXNlUGF0aCk7XG4gIGNvbnN0IG9ycGhhbnM6IEFycmF5PHsgbWlsZXN0b25lSWQ6IHN0cmluZzsgcGlkOiBudW1iZXI7IGFsaXZlOiBib29sZWFuIH0+ID0gW107XG4gIGZvciAoY29uc3Qgc2Vzc2lvbiBvZiBzZXNzaW9ucykge1xuICAgIGNvbnN0IGFsaXZlID0gaXNQaWRBbGl2ZShzZXNzaW9uLnBpZCk7XG4gICAgb3JwaGFucy5wdXNoKHsgbWlsZXN0b25lSWQ6IHNlc3Npb24ubWlsZXN0b25lSWQsIHBpZDogc2Vzc2lvbi5waWQsIGFsaXZlIH0pO1xuICAgIGlmICghYWxpdmUpIHtcbiAgICAgIC8vIENsZWFuIHVwIGRlYWQgc2Vzc2lvblxuICAgICAgcmVtb3ZlU2Vzc2lvblN0YXR1cyhiYXNlUGF0aCwgc2Vzc2lvbi5taWxlc3RvbmVJZCk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgY2FuZGlkYXRlcyA9IGF3YWl0IGFuYWx5emVQYXJhbGxlbEVsaWdpYmlsaXR5KGJhc2VQYXRoKTtcbiAgcmV0dXJuIG9ycGhhbnMubGVuZ3RoID4gMCA/IHsgLi4uY2FuZGlkYXRlcywgb3JwaGFucyB9IDogY2FuZGlkYXRlcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0YXJ0IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFN0YXJ0IHBhcmFsbGVsIGV4ZWN1dGlvbiB3aXRoIHRoZSBnaXZlbiBlbGlnaWJsZSBtaWxlc3RvbmVzLlxuICogQ3JlYXRlcyB3b3JrdHJlZXMsIHNwYXducyB3b3JrZXIgcHJvY2Vzc2VzLCBhbmQgYmVnaW5zIG1vbml0b3JpbmcuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydFBhcmFsbGVsKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZHM6IHN0cmluZ1tdLFxuICBwcmVmczogR1NEUHJlZmVyZW5jZXMgfCB1bmRlZmluZWQsXG4pOiBQcm9taXNlPHsgc3RhcnRlZDogc3RyaW5nW107IGVycm9yczogQXJyYXk8eyBtaWQ6IHN0cmluZzsgZXJyb3I6IHN0cmluZyB9PiB9PiB7XG4gIC8vIFByZXZlbnQgd29ya2VycyBmcm9tIHNwYXduaW5nIG5lc3RlZCBwYXJhbGxlbCBzZXNzaW9uc1xuICBpZiAocHJvY2Vzcy5lbnYuR1NEX1BBUkFMTEVMX1dPUktFUikge1xuICAgIHJldHVybiB7IHN0YXJ0ZWQ6IFtdLCBlcnJvcnM6IFt7IG1pZDogXCJhbGxcIiwgZXJyb3I6IFwiQ2Fubm90IHN0YXJ0IHBhcmFsbGVsIGZyb20gd2l0aGluIGEgcGFyYWxsZWwgd29ya2VyXCIgfV0gfTtcbiAgfVxuXG4gIGNvbnN0IGNvbmZpZyA9IHJlc29sdmVQYXJhbGxlbENvbmZpZyhwcmVmcyk7XG4gIGNvbnN0IHVva0ZsYWdzID0gcmVzb2x2ZVVva0ZsYWdzKHByZWZzKTtcblxuICAvLyBSZWxlYXNlIGFueSBsZWZ0b3ZlciBzdGF0ZSBmcm9tIGEgcHJldmlvdXMgc2Vzc2lvbiBiZWZvcmUgcmVhc3NpZ25pbmdcbiAgaWYgKHN0YXRlKSB7XG4gICAgZm9yIChjb25zdCB3IG9mIHN0YXRlLndvcmtlcnMudmFsdWVzKCkpIHtcbiAgICAgIHcuY2xlYW51cD8uKCk7XG4gICAgICB3LmNsZWFudXAgPSB1bmRlZmluZWQ7XG4gICAgICB3LnByb2Nlc3MgPSBudWxsO1xuICAgIH1cbiAgICBzdGF0ZS53b3JrZXJzLmNsZWFyKCk7XG4gIH1cblxuICAvLyBUcnkgdG8gcmVzdG9yZSBmcm9tIGEgcHJldmlvdXMgY3Jhc2hcbiAgY29uc3QgcmVzdG9yZWQgPSByZXN0b3JlU3RhdGUoYmFzZVBhdGgpO1xuICBpZiAocmVzdG9yZWQgJiYgcmVzdG9yZWQud29ya2Vycy5sZW5ndGggPiAwKSB7XG4gICAgLy8gQWRvcHQgc3Vydml2aW5nIHdvcmtlcnMgaW5zdGVhZCBvZiBzdGFydGluZyBuZXcgb25lc1xuICAgIHN0YXRlID0ge1xuICAgICAgYWN0aXZlOiB0cnVlLFxuICAgICAgd29ya2VyczogbmV3IE1hcCgpLFxuICAgICAgY29uZmlnLFxuICAgICAgdG90YWxDb3N0OiByZXN0b3JlZC50b3RhbENvc3QsXG4gICAgICBzdGFydGVkQXQ6IHJlc3RvcmVkLnN0YXJ0ZWRBdCxcbiAgICB9O1xuICAgIGNvbnN0IGFkb3B0ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCB3IG9mIHJlc3RvcmVkLndvcmtlcnMpIHtcbiAgICAgIHN0YXRlLndvcmtlcnMuc2V0KHcubWlsZXN0b25lSWQsIHtcbiAgICAgICAgbWlsZXN0b25lSWQ6IHcubWlsZXN0b25lSWQsXG4gICAgICAgIHRpdGxlOiB3LnRpdGxlLFxuICAgICAgICBwaWQ6IHcucGlkLFxuICAgICAgICBwcm9jZXNzOiBudWxsLCAvLyBubyBoYW5kbGUgZm9yIGFkb3B0ZWQgd29ya2Vyc1xuICAgICAgICB3b3JrdHJlZVBhdGg6IHcud29ya3RyZWVQYXRoLFxuICAgICAgICBzdGFydGVkQXQ6IHcuc3RhcnRlZEF0LFxuICAgICAgICBzdGF0ZTogXCJydW5uaW5nXCIsXG4gICAgICAgIGNvc3Q6IHcuY29zdCxcbiAgICAgIH0pO1xuICAgICAgYWRvcHRlZC5wdXNoKHcubWlsZXN0b25lSWQpO1xuICAgIH1cbiAgICByZXR1cm4geyBzdGFydGVkOiBhZG9wdGVkLCBlcnJvcnM6IFtdIH07XG4gIH1cblxuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG4gIC8vIEluaXRpYWxpemUgb3JjaGVzdHJhdG9yIHN0YXRlXG4gIHN0YXRlID0ge1xuICAgIGFjdGl2ZTogdHJ1ZSxcbiAgICB3b3JrZXJzOiBuZXcgTWFwKCksXG4gICAgY29uZmlnLFxuICAgIHRvdGFsQ29zdDogMCxcbiAgICBzdGFydGVkQXQ6IG5vdyxcbiAgfTtcblxuICBjb25zdCBzdGFydGVkOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBlcnJvcnM6IEFycmF5PHsgbWlkOiBzdHJpbmc7IGVycm9yOiBzdHJpbmcgfT4gPSBbXTtcblxuICBsZXQgZmlsdGVyZWRNaWxlc3RvbmVJZHMgPSBtaWxlc3RvbmVJZHM7XG4gIGlmICh1b2tGbGFncy5leGVjdXRpb25HcmFwaCAmJiBtaWxlc3RvbmVJZHMubGVuZ3RoID4gMSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXF1ZXN0ZWRJZHMgPSBuZXcgU2V0KG1pbGVzdG9uZUlkcyk7XG4gICAgICBjb25zdCBjYW5kaWRhdGVzID0gYXdhaXQgYW5hbHl6ZVBhcmFsbGVsRWxpZ2liaWxpdHkoYmFzZVBhdGgpO1xuICAgICAgY29uc3Qgb3ZlcmxhcFBhaXJzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgICBmb3IgKGNvbnN0IG92ZXJsYXAgb2YgY2FuZGlkYXRlcy5maWxlT3ZlcmxhcHMpIHtcbiAgICAgICAgaWYgKCFyZXF1ZXN0ZWRJZHMuaGFzKG92ZXJsYXAubWlkMSkgfHwgIXJlcXVlc3RlZElkcy5oYXMob3ZlcmxhcC5taWQyKSkgY29udGludWU7XG4gICAgICAgIG92ZXJsYXBQYWlycy5hZGQob3ZlcmxhcEtleShvdmVybGFwLm1pZDEsIG92ZXJsYXAubWlkMikpO1xuICAgICAgfVxuICAgICAgZmlsdGVyZWRNaWxlc3RvbmVJZHMgPSBzZWxlY3RDb25mbGljdEZyZWVCYXRjaCh7XG4gICAgICAgIG9yZGVyZWRJZHM6IG1pbGVzdG9uZUlkcyxcbiAgICAgICAgbWF4UGFyYWxsZWw6IG1pbGVzdG9uZUlkcy5sZW5ndGgsXG4gICAgICAgIGhhc0NvbmZsaWN0OiAoY2FuZGlkYXRlLCBleGlzdGluZykgPT5cbiAgICAgICAgICBvdmVybGFwUGFpcnMuaGFzKG92ZXJsYXBLZXkoY2FuZGlkYXRlLCBleGlzdGluZykpLFxuICAgICAgfSk7XG4gICAgICBpZiAoZmlsdGVyZWRNaWxlc3RvbmVJZHMubGVuZ3RoIDwgbWlsZXN0b25lSWRzLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBza2lwcGVkID0gbWlsZXN0b25lSWRzLmZpbHRlcigobWlkKSA9PiAhZmlsdGVyZWRNaWxlc3RvbmVJZHMuaW5jbHVkZXMobWlkKSk7XG4gICAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgICAgXCJwYXJhbGxlbFwiLFxuICAgICAgICAgIGB1b2sgZXhlY3V0aW9uIGdyYXBoIGZpbHRlcmVkICR7c2tpcHBlZC5sZW5ndGh9IGNvbmZsaWN0aW5nIG1pbGVzdG9uZShzKTogJHtza2lwcGVkLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgIFwicGFyYWxsZWxcIixcbiAgICAgICAgYHVvayBleGVjdXRpb24gZ3JhcGggb3ZlcmxhcCBhbmFseXNpcyBmYWlsZWQ7IHVzaW5nIGxlZ2FjeSBtaWxlc3RvbmUgc2VsZWN0aW9uOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWAsXG4gICAgICApO1xuICAgICAgZmlsdGVyZWRNaWxlc3RvbmVJZHMgPSBtaWxlc3RvbmVJZHM7XG4gICAgfVxuICB9XG5cbiAgLy8gQ2FwIHRvIG1heF93b3JrZXJzXG4gIGNvbnN0IHRvU3RhcnQgPSBmaWx0ZXJlZE1pbGVzdG9uZUlkcy5zbGljZSgwLCBjb25maWcubWF4X3dvcmtlcnMpO1xuXG4gIGZvciAoY29uc3QgbWlkIG9mIHRvU3RhcnQpIHtcbiAgICAvLyBDaGVjayBidWRnZXQgY2VpbGluZyBiZWZvcmUgZWFjaCBzcGF3blxuICAgIGlmIChpc0J1ZGdldEV4Y2VlZGVkKCkpIHtcbiAgICAgIGVycm9ycy5wdXNoKHsgbWlkLCBlcnJvcjogYEJ1ZGdldCBjZWlsaW5nICgkJHtjb25maWcuYnVkZ2V0X2NlaWxpbmd9KSByZWFjaGVkIFx1MjAxNCBza2lwcGluZ2AgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgLy8gQ3JlYXRlIHRoZSB3b3JrdHJlZSAod2l0aG91dCBjaGRpciBcdTIwMTQgY29vcmRpbmF0b3Igc3RheXMgaW4gcHJvamVjdCByb290KVxuICAgICAgbGV0IHd0UGF0aDogc3RyaW5nO1xuICAgICAgdHJ5IHtcbiAgICAgICAgd3RQYXRoID0gX2NyZWF0ZU1pbGVzdG9uZVdvcmt0cmVlKGJhc2VQYXRoLCBtaWQpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dXYXJuaW5nKFwicGFyYWxsZWxcIiwgYGNyZWF0ZU1pbGVzdG9uZVdvcmt0cmVlIGZhbGxiYWNrIGZvciAke21pZH06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAgIHd0UGF0aCA9IHdvcmt0cmVlUGF0aChiYXNlUGF0aCwgbWlkKTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgd29ya2VyOiBXb3JrZXJJbmZvID0ge1xuICAgICAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgICAgICB0aXRsZTogbWlkLFxuICAgICAgICBwaWQ6IDAsICAvLyBwbGFjZWhvbGRlciBcdTIwMTQgcmVhbCBQSUQgc2V0IGJ5IHNwYXduV29ya2VyKClcbiAgICAgICAgcHJvY2VzczogbnVsbCxcbiAgICAgICAgd29ya3RyZWVQYXRoOiB3dFBhdGgsXG4gICAgICAgIHN0YXJ0ZWRBdDogbm93LFxuICAgICAgICBzdGF0ZTogXCJydW5uaW5nXCIsXG4gICAgICAgIGNvc3Q6IDAsXG4gICAgICB9O1xuXG4gICAgICBzdGF0ZS53b3JrZXJzLnNldChtaWQsIHdvcmtlcik7XG5cbiAgICAgIC8vIFNwYXduIEJFRk9SRSB3cml0aW5nIHNlc3Npb24gc3RhdHVzIHNvIHRoZSBmaWxlIGdldHMgdGhlIHJlYWwgd29ya2VyIFBJRC5cbiAgICAgIGNvbnN0IHNwYXduZWQgPSBzcGF3bldvcmtlcihiYXNlUGF0aCwgbWlkKTtcbiAgICAgIGlmICghc3Bhd25lZCkge1xuICAgICAgICB3b3JrZXIuc3RhdGUgPSBcImVycm9yXCI7XG4gICAgICB9XG5cbiAgICAgIC8vIFdyaXRlIHNlc3Npb24gc3RhdHVzIHdpdGggcmVhbCBQSUQgKG9yIDAgaWYgc3Bhd24gZmFpbGVkKVxuICAgICAgd3JpdGVTZXNzaW9uU3RhdHVzKGJhc2VQYXRoLCB7XG4gICAgICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgICAgIHBpZDogd29ya2VyLnBpZCxcbiAgICAgICAgc3RhdGU6IHdvcmtlci5zdGF0ZSxcbiAgICAgICAgY3VycmVudFVuaXQ6IG51bGwsXG4gICAgICAgIGNvbXBsZXRlZFVuaXRzOiAwLFxuICAgICAgICBjb3N0OiAwLFxuICAgICAgICBsYXN0SGVhcnRiZWF0OiBub3csXG4gICAgICAgIHN0YXJ0ZWRBdDogbm93LFxuICAgICAgICB3b3JrdHJlZVBhdGg6IHd0UGF0aCxcbiAgICAgIH0pO1xuXG4gICAgICBzdGFydGVkLnB1c2gobWlkKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBnZXRFcnJvck1lc3NhZ2UoZXJyKTtcbiAgICAgIGVycm9ycy5wdXNoKHsgbWlkLCBlcnJvcjogbWVzc2FnZSB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBJZiBub3RoaW5nIHN0YXJ0ZWQgc3VjY2Vzc2Z1bGx5LCBkZWFjdGl2YXRlXG4gIGlmIChzdGFydGVkLmxlbmd0aCA9PT0gMCkge1xuICAgIHN0YXRlLmFjdGl2ZSA9IGZhbHNlO1xuICB9XG5cbiAgLy8gUGVyc2lzdCBzdGF0ZSBmb3IgY3Jhc2ggcmVjb3ZlcnlcbiAgcGVyc2lzdFN0YXRlKGJhc2VQYXRoKTtcblxuICByZXR1cm4geyBzdGFydGVkLCBlcnJvcnMgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFdvcmt0cmVlIENyZWF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENyZWF0ZSBhIGdpdCB3b3JrdHJlZSBmb3IgYSBtaWxlc3RvbmUgd2l0aG91dCBjaGFuZ2luZyB0aGUgY29vcmRpbmF0b3IncyBjd2QuXG4gKiBVc2VzIG1pbGVzdG9uZS88TUlEPiBicmFuY2ggbmFtaW5nIChzYW1lIGFzIGF1dG8td29ya3RyZWUudHMpLlxuICpcbiAqIEV4cG9ydGVkIHdpdGggdGhlIGBfYCBwcmVmaXggcHVyZWx5IGZvciB0ZXN0cyBcdTIwMTQgcHJvZHVjdGlvbiBjYWxsZXJzIHN0YXkgb25cbiAqIHRoZSBjbG9zdXJlLXByaXZhdGUgbmFtZSBgY3JlYXRlTWlsZXN0b25lV29ya3RyZWVgIGJlbG93LlxuICovXG5leHBvcnQgZnVuY3Rpb24gX2NyZWF0ZU1pbGVzdG9uZVdvcmt0cmVlKGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBicmFuY2ggPSBhdXRvV29ya3RyZWVCcmFuY2gobWlsZXN0b25lSWQpO1xuICBjb25zdCBicmFuY2hFeGlzdHMgPSBuYXRpdmVCcmFuY2hFeGlzdHMoYmFzZVBhdGgsIGJyYW5jaCk7XG5cbiAgbGV0IGluZm86IHsgbmFtZTogc3RyaW5nOyBwYXRoOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nOyBleGlzdHM6IGJvb2xlYW4gfTtcbiAgaWYgKGJyYW5jaEV4aXN0cykge1xuICAgIC8vICM1NTQ5IHBvc3QtbWVyZ2UgYXVkaXQgKFIzKTogbWF0Y2ggdGhlIGZhc3QtZm9yd2FyZCBiZWhhdmlvciBhZGRlZCB0b1xuICAgIC8vIGBjcmVhdGVBdXRvV29ya3RyZWVgIGluIGNvbW1pdCA4OTk2Y2I2OGUuIFdoZW4gYSB3b3JrZXIgcmV1c2VzIGFuXG4gICAgLy8gZXhpc3RpbmcgbWlsZXN0b25lIGJyYW5jaCwgZmFzdC1mb3J3YXJkIGl0IG9udG8gdGhlIGludGVncmF0aW9uIGJyYW5jaFxuICAgIC8vIHdoZW4gc2FmZSBzbyBwZXItd29ya2VyIHdvcmt0cmVlcyBkb24ndCBmb3JrIGZyb20gYSBzdGFsZSBiYXNlIGFmdGVyIGFcbiAgICAvLyBzaWJsaW5nIG1pbGVzdG9uZSBoYXMgbWVyZ2VkLiBTYW1lIGBuYXRpdmVJc0FuY2VzdG9yYCArIHdvcmt0cmVlLWxpc3RcbiAgICAvLyBzYWZldHkgZ3VhcmRzIGFwcGx5LlxuICAgIGZhc3RGb3J3YXJkUmV1c2VkTWlsZXN0b25lQnJhbmNoSWZTYWZlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgYnJhbmNoKTtcbiAgICBpbmZvID0gY3JlYXRlV29ya3RyZWUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCB7IGJyYW5jaCwgcmV1c2VFeGlzdGluZ0JyYW5jaDogdHJ1ZSB9KTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBpbnRlZ3JhdGlvbkJyYW5jaCA9IHJlYWRJbnRlZ3JhdGlvbkJyYW5jaChiYXNlUGF0aCwgbWlsZXN0b25lSWQpID8/IHVuZGVmaW5lZDtcbiAgICBpbmZvID0gY3JlYXRlV29ya3RyZWUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCB7IGJyYW5jaCwgc3RhcnRQb2ludDogaW50ZWdyYXRpb25CcmFuY2ggfSk7XG4gIH1cblxuICAvLyBSdW4gcG9zdC1jcmVhdGUgaG9vayBpZiBjb25maWd1cmVkXG4gIHJ1bldvcmt0cmVlUG9zdENyZWF0ZUhvb2soYmFzZVBhdGgsIGluZm8ucGF0aCk7XG5cbiAgLy8gQ29weSAuZ3NkLyBwbGFubmluZyBhcnRpZmFjdHMgKG1pbGVzdG9uZXMsIENPTlRFWFQsIFJPQURNQVAsIGV0Yy4pIGZyb20gdGhlXG4gIC8vIHByb2plY3Qgcm9vdCBpbnRvIHRoZSB3b3JrdHJlZS4gV2l0aG91dCB0aGlzLCB3b3JrZXJzIGZvciBuZXdseS1wbGFubmVkXG4gIC8vIG1pbGVzdG9uZXMgY2FuJ3QgZmluZCB0aGVpciByb2FkbWFwIGFuZCBleGl0IGltbWVkaWF0ZWx5ICgjMjE4NCBCdWcgNCkuXG4gIHN5bmNHc2RTdGF0ZVRvV29ya3RyZWUoYmFzZVBhdGgsIGluZm8ucGF0aCk7XG5cbiAgcmV0dXJuIGluZm8ucGF0aDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFdvcmtlciBTcGF3bmluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBTcGF3biBhIHdvcmtlciBwcm9jZXNzIGZvciBhIG1pbGVzdG9uZS5cbiAqIFRoZSB3b3JrZXIgcnVucyBgZ3NkIGhlYWRsZXNzIC0tanNvbiBhdXRvYCBpbiB0aGUgbWlsZXN0b25lJ3Mgd29ya3RyZWVcbiAqIHdpdGggR1NEX01JTEVTVE9ORV9MT0NLIHNldCB0byBpc29sYXRlIHN0YXRlIGRlcml2YXRpb24uXG4gKlxuICogSU1QT1JUQU5UOiBXZSB1c2UgYGhlYWRsZXNzIC0tanNvbiBhdXRvYCBpbnN0ZWFkIG9mIGAtLXByaW50IFwiL2dzZCBhdXRvXCJgLlxuICogLS1wcmludCBtb2RlIGNhbGxzIHNlc3Npb24ucHJvbXB0KCkgd2hpY2ggcmV0dXJucyBpbW1lZGlhdGVseSBhZnRlciB0aGVcbiAqIGV4dGVuc2lvbiBjb21tYW5kIGhhbmRsZXIgZmlyZXMsIGJlY2F1c2UgYXV0by1tb2RlJ3MgY3R4Lm5ld1Nlc3Npb24oKVxuICogcmVzZXRzIHRoZSBzZXNzaW9uIGFuZCB1bmJsb2NrcyB0aGUgb3V0ZXIgcHJvbXB0KCkgYXdhaXQuIFRoaXMgY2F1c2VzXG4gKiBwcm9jZXNzLmV4aXQoMCkgdG8gZmlyZSBiZWZvcmUgYW55IExMTSB3b3JrIGhhcHBlbnMuIFNlZSAjMjc5Mi5cbiAqXG4gKiBUaGUgaGVhZGxlc3Mgc3ViY29tbWFuZCB1c2VzIGFuIFJQQyBjbGllbnQgdGhhdCBrZWVwcyB0aGUgcHJvY2VzcyBhbGl2ZVxuICogdW50aWwgYXV0by1tb2RlIGVtaXRzIGEgdGVybWluYWwgbm90aWZpY2F0aW9uIG9yIHRoZSBpZGxlIHRpbWVyIGZpcmVzLlxuICogSXQgb3V0cHV0cyBOREpTT04gZXZlbnRzIHRvIHN0ZG91dCAod2l0aCAtLWpzb24pLCB3aGljaCBvdXJcbiAqIHByb2Nlc3NXb3JrZXJMaW5lKCkgcGFyc2VyIGFscmVhZHkgdW5kZXJzdGFuZHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzcGF3bldvcmtlcihcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbik6IGJvb2xlYW4ge1xuICBpZiAoIXN0YXRlKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHdvcmtlciA9IHN0YXRlLndvcmtlcnMuZ2V0KG1pbGVzdG9uZUlkKTtcbiAgaWYgKCF3b3JrZXIpIHJldHVybiBmYWxzZTtcbiAgaWYgKHdvcmtlci5wcm9jZXNzKSByZXR1cm4gdHJ1ZTsgLy8gYWxyZWFkeSBzcGF3bmVkXG5cbiAgLy8gUmVzb2x2ZSB0aGUgR1NEIENMSSBiaW5hcnkgcGF0aFxuICBjb25zdCBiaW5QYXRoID0gcmVzb2x2ZUdzZEJpbigpO1xuICBpZiAoIWJpblBhdGgpIHJldHVybiBmYWxzZTtcblxuICBsZXQgY2hpbGQ6IENoaWxkUHJvY2VzcztcbiAgdHJ5IHtcbiAgICBjb25zdCB3b3JrZXJFbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4gPSB7XG4gICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgIEdTRF9NSUxFU1RPTkVfTE9DSzogbWlsZXN0b25lSWQsXG4gICAgICAvLyBQYXNzIHRoZSByZWFsIHByb2plY3Qgcm9vdCBzbyB3b3JrZXJzIGRvbid0IG5lZWQgdG8gcmUtZGVyaXZlIGl0LlxuICAgICAgLy8gV2l0aG91dCB0aGlzLCBwcm9jZXNzLmN3ZCgpIHJlc29sdmVzIHN5bWxpbmtzIGFuZCB0aGUgd29ya3RyZWVcbiAgICAgIC8vIHBhdGggaGV1cmlzdGljIGNhbiBtYXRjaCB0aGUgdXNlci1sZXZlbCB+Ly5nc2QgaW5zdGVhZCBvZiB0aGVcbiAgICAgIC8vIHByb2plY3QgLmdzZCwgY2F1c2luZyB3cml0ZXMgdG8gfiBhbmQgY29ycnVwdGluZyB1c2VyIGNvbmZpZy5cbiAgICAgIEdTRF9QUk9KRUNUX1JPT1Q6IGJhc2VQYXRoLFxuICAgICAgLy8gUHJldmVudCB3b3JrZXJzIGZyb20gc3Bhd25pbmcgdGhlaXIgb3duIHBhcmFsbGVsIHNlc3Npb25zXG4gICAgICBHU0RfUEFSQUxMRUxfV09SS0VSOiBcIjFcIixcbiAgICB9O1xuXG4gICAgLy8gQXBwbHkgd29ya2VyIG1vZGVsIG92ZXJyaWRlIGlmIGNvbmZpZ3VyZWQsIHNvIHdvcmtlcnMgdXNlIGEgY2hlYXBlclxuICAgIC8vIG1vZGVsIChlLmcuIEhhaWt1KSByYXRoZXIgdGhhbiBpbmhlcml0aW5nIHRoZSBjb29yZGluYXRvcidzIG1vZGVsLlxuICAgIGlmIChzdGF0ZS5jb25maWcud29ya2VyX21vZGVsKSB7XG4gICAgICB3b3JrZXJFbnYuR1NEX1dPUktFUl9NT0RFTCA9IHN0YXRlLmNvbmZpZy53b3JrZXJfbW9kZWw7XG4gICAgfVxuXG4gICAgY2hpbGQgPSBzcGF3bihwcm9jZXNzLmV4ZWNQYXRoLCBbYmluUGF0aCwgXCJoZWFkbGVzc1wiLCBcIi0tanNvblwiLCBcImF1dG9cIl0sIHtcbiAgICAgIGN3ZDogd29ya2VyLndvcmt0cmVlUGF0aCxcbiAgICAgIGVudjogd29ya2VyRW52LFxuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgZGV0YWNoZWQ6IGZhbHNlLFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcInBhcmFsbGVsXCIsIGBzcGF3blN5bmMgd29ya2VyIGZhaWxlZCBmb3IgJHttaWxlc3RvbmVJZH06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgLy8gSGFuZGxlIHNwYXduIGVycm9ycyAoZS5nLiwgRU5PRU5UIHdoZW4gYmluYXJ5IGRvZXNuJ3QgZXhpc3QpXG4gIGNoaWxkLm9uKFwiZXJyb3JcIiwgKCkgPT4ge1xuICAgIGlmICghc3RhdGUpIHJldHVybjtcbiAgICBjb25zdCB3ID0gc3RhdGUud29ya2Vycy5nZXQobWlsZXN0b25lSWQpO1xuICAgIGlmICh3KSB7XG4gICAgICB3LnByb2Nlc3MgPSBudWxsO1xuICAgICAgLy8gRG9uJ3QgY2hhbmdlIHN0YXRlIFx1MjAxNCBzcGF3biBmYWlsdXJlIGlzIG5vbi1mYXRhbCwgY29vcmRpbmF0b3IgY2FuIHJldHJ5XG4gICAgfVxuICB9KTtcblxuICB3b3JrZXIucHJvY2VzcyA9IGNoaWxkO1xuICB3b3JrZXIucGlkID0gY2hpbGQucGlkID8/IDA7XG5cbiAgaWYgKCFjaGlsZC5waWQpIHtcbiAgICAvLyBTcGF3biByZXR1cm5lZCBidXQgbm8gUElEIFx1MjAxNCBwcm9jZXNzIGZhaWxlZCB0byBzdGFydFxuICAgIHdvcmtlci5wcm9jZXNzID0gbnVsbDtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgTkRKU09OIHN0ZG91dCBtb25pdG9yaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBXb3JrZXJzIHJ1biB2aWEgYGhlYWRsZXNzIC0tanNvbmAsIHdoaWNoIGZvcndhcmRzIGFsbCBSUEMgZXZlbnRzXG4gIC8vIGFzIE5ESlNPTiB0byBzdGRvdXQuIFdlIHBhcnNlIG1lc3NhZ2VfZW5kIGV2ZW50cyB0byBleHRyYWN0XG4gIC8vIGNvc3QvdG9rZW4gdXNhZ2UsIGtlZXBpbmcgdGhlIGNvb3JkaW5hdG9yJ3MgY29zdCB0cmFja2luZyBpbiBzeW5jXG4gIC8vIHdpdGggYWN0dWFsIEFQSSBzcGVuZC5cbiAgaWYgKGNoaWxkLnN0ZG91dCkge1xuICAgIGxldCBzdGRvdXRCdWZmZXIgPSBcIlwiO1xuICAgIGNoaWxkLnN0ZG91dC5vbihcImRhdGFcIiwgKGRhdGE6IEJ1ZmZlcikgPT4ge1xuICAgICAgc3Rkb3V0QnVmZmVyICs9IGRhdGEudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IGxpbmVzID0gc3Rkb3V0QnVmZmVyLnNwbGl0KFwiXFxuXCIpO1xuICAgICAgc3Rkb3V0QnVmZmVyID0gbGluZXMucG9wKCkgfHwgXCJcIjtcbiAgICAgIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgICAgICBwcm9jZXNzV29ya2VyTGluZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIGxpbmUpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIC8vIEZsdXNoIHJlbWFpbmluZyBidWZmZXIgb24gY2xvc2VcbiAgICBjaGlsZC5zdGRvdXQub24oXCJjbG9zZVwiLCAoKSA9PiB7XG4gICAgICBpZiAoc3Rkb3V0QnVmZmVyLnRyaW0oKSkge1xuICAgICAgICBwcm9jZXNzV29ya2VyTGluZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHN0ZG91dEJ1ZmZlcik7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBpZiAoY2hpbGQuc3RkZXJyKSB7XG4gICAgY2hpbGQuc3RkZXJyLm9uKFwiZGF0YVwiLCAoZGF0YTogQnVmZmVyKSA9PiB7XG4gICAgICBhcHBlbmRXb3JrZXJMb2coYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBkYXRhLnRvU3RyaW5nKCkpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gVXBkYXRlIHNlc3Npb24gc3RhdHVzIHdpdGggcmVhbCBQSURcbiAgd3JpdGVTZXNzaW9uU3RhdHVzKGJhc2VQYXRoLCB7XG4gICAgbWlsZXN0b25lSWQsXG4gICAgcGlkOiB3b3JrZXIucGlkLFxuICAgIHN0YXRlOiBcInJ1bm5pbmdcIixcbiAgICBjdXJyZW50VW5pdDogbnVsbCxcbiAgICBjb21wbGV0ZWRVbml0czogMCxcbiAgICBjb3N0OiB3b3JrZXIuY29zdCxcbiAgICBsYXN0SGVhcnRiZWF0OiBEYXRlLm5vdygpLFxuICAgIHN0YXJ0ZWRBdDogd29ya2VyLnN0YXJ0ZWRBdCxcbiAgICB3b3JrdHJlZVBhdGg6IHdvcmtlci53b3JrdHJlZVBhdGgsXG4gIH0pO1xuXG4gIC8vIFN0b3JlIGNsZWFudXAgZnVuY3Rpb24gdG8gcmVtb3ZlIGFsbCBsaXN0ZW5lcnMgZnJvbSB0aGUgY2hpbGQgcHJvY2Vzcy5cbiAgLy8gVGhpcyBwcmV2ZW50cyBsaXN0ZW5lciBhY2N1bXVsYXRpb24gd2hlbiB3b3JrZXJzIGFyZSByZXNwYXduZWQsIHNpbmNlXG4gIC8vIGhhbmRsZXIgY2xvc3VyZXMgY2FwdHVyZSBtaWxlc3RvbmVJZCBhbmQgb3RoZXIgZGF0YSB0aGF0IHdvdWxkIG90aGVyd2lzZVxuICAvLyBiZSByZXRhaW5lZCBpbmRlZmluaXRlbHkuXG4gIHdvcmtlci5jbGVhbnVwID0gKCkgPT4ge1xuICAgIGNoaWxkLnN0ZG91dD8ucmVtb3ZlQWxsTGlzdGVuZXJzKCk7XG4gICAgY2hpbGQuc3RkZXJyPy5yZW1vdmVBbGxMaXN0ZW5lcnMoKTtcbiAgICBjaGlsZC5yZW1vdmVBbGxMaXN0ZW5lcnMoKTtcbiAgfTtcblxuICAvLyBIYW5kbGUgd29ya2VyIGV4aXRcbiAgY2hpbGQub24oXCJleGl0XCIsIChjb2RlKSA9PiB7XG4gICAgaWYgKCFzdGF0ZSkgcmV0dXJuO1xuICAgIGNvbnN0IHcgPSBzdGF0ZS53b3JrZXJzLmdldChtaWxlc3RvbmVJZCk7XG4gICAgaWYgKCF3KSByZXR1cm47XG5cbiAgICAvLyBSZW1vdmUgYWxsIHN0cmVhbSBsaXN0ZW5lcnMgdG8gcmVsZWFzZSBjbG9zdXJlIHJlZmVyZW5jZXNcbiAgICB3LmNsZWFudXA/LigpO1xuICAgIHcuY2xlYW51cCA9IHVuZGVmaW5lZDtcblxuICAgIHcucHJvY2VzcyA9IG51bGw7XG4gICAgaWYgKHcuc3RhdGUgPT09IFwic3RvcHBlZFwiKSByZXR1cm47IC8vIGdyYWNlZnVsIHN0b3AsIGFscmVhZHkgaGFuZGxlZFxuXG4gICAgaWYgKGNvZGUgPT09IDApIHtcbiAgICAgIHcuc3RhdGUgPSBcInN0b3BwZWRcIjtcbiAgICB9IGVsc2Uge1xuICAgICAgdy5zdGF0ZSA9IFwiZXJyb3JcIjtcbiAgICAgIGFwcGVuZFdvcmtlckxvZyhiYXNlUGF0aCwgbWlsZXN0b25lSWQsIGBcXG5bb3JjaGVzdHJhdG9yXSB3b3JrZXIgZXhpdGVkIHdpdGggY29kZSAke2NvZGUgPz8gXCJudWxsXCJ9XFxuYCk7XG4gICAgfVxuXG4gICAgLy8gVXBkYXRlIHNlc3Npb24gc3RhdHVzIGFuZCBwZXJzaXN0IG9yY2hlc3RyYXRvciBzdGF0ZSBmb3IgY3Jhc2ggcmVjb3ZlcnlcbiAgICB3cml0ZVNlc3Npb25TdGF0dXMoYmFzZVBhdGgsIHtcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgcGlkOiB3LnBpZCxcbiAgICAgIHN0YXRlOiB3LnN0YXRlLFxuICAgICAgY3VycmVudFVuaXQ6IG51bGwsXG4gICAgICBjb21wbGV0ZWRVbml0czogMCxcbiAgICAgIGNvc3Q6IHcuY29zdCxcbiAgICAgIGxhc3RIZWFydGJlYXQ6IERhdGUubm93KCksXG4gICAgICBzdGFydGVkQXQ6IHcuc3RhcnRlZEF0LFxuICAgICAgd29ya3RyZWVQYXRoOiB3Lndvcmt0cmVlUGF0aCxcbiAgICB9KTtcbiAgICBwZXJzaXN0U3RhdGUoYmFzZVBhdGgpO1xuICB9KTtcblxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBHU0QgQ0xJIGJpbmFyeSBwYXRoLlxuICogVXNlcyBHU0RfQklOX1BBVEggZW52IHZhciAoc2V0IGJ5IGxvYWRlci50cykgb3IgZmFsbHMgYmFjayB0b1xuICogZmluZGluZyB0aGUgYmluYXJ5IHJlbGF0aXZlIHRvIHRoZSBjdXJyZW50IG1vZHVsZS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUdzZEJpbigpOiBzdHJpbmcgfCBudWxsIHtcbiAgLy8gR1NEX0JJTl9QQVRIIGlzIHNldCBieSBsb2FkZXIudHMgdG8gdGhlIGFic29sdXRlIHBhdGggb2YgZGlzdC9sb2FkZXIuanNcbiAgaWYgKHByb2Nlc3MuZW52LkdTRF9CSU5fUEFUSCAmJiBleGlzdHNTeW5jKHByb2Nlc3MuZW52LkdTRF9CSU5fUEFUSCkpIHtcbiAgICByZXR1cm4gcHJvY2Vzcy5lbnYuR1NEX0JJTl9QQVRIO1xuICB9XG5cbiAgLy8gRmFsbGJhY2s6IHRyeSB0byBmaW5kIGxvYWRlci5qcyByZWxhdGl2ZSB0byB0aGlzIGZpbGVcbiAgLy8gVGhpcyBmaWxlIGlzIGF0IGRpc3QvcmVzb3VyY2VzL2V4dGVuc2lvbnMvZ3NkL3BhcmFsbGVsLW9yY2hlc3RyYXRvci5qc1xuICAvLyBsb2FkZXIuanMgaXMgYXQgZGlzdC9sb2FkZXIuanNcbiAgbGV0IHRoaXNEaXI6IHN0cmluZztcbiAgdHJ5IHtcbiAgICB0aGlzRGlyID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcInBhcmFsbGVsXCIsIGBkaXJuYW1lKGZpbGVVUkxUb1BhdGgpIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICB0aGlzRGlyID0gcHJvY2Vzcy5jd2QoKTtcbiAgfVxuICBjb25zdCBjYW5kaWRhdGVzID0gW1xuICAgIGpvaW4odGhpc0RpciwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJsb2FkZXIuanNcIiksXG4gICAgam9pbih0aGlzRGlyLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiZGlzdFwiLCBcImxvYWRlci5qc1wiKSxcbiAgXTtcbiAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xuICAgIGlmIChleGlzdHNTeW5jKGNhbmRpZGF0ZSkpIHJldHVybiBjYW5kaWRhdGU7XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE5ESlNPTiBQcm9jZXNzaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFByb2Nlc3MgYSBzaW5nbGUgTkRKU09OIGxpbmUgZnJvbSBhIHdvcmtlcidzIHN0ZG91dC5cbiAqIEV4dHJhY3RzIGNvc3QgYW5kIHRva2VuIHVzYWdlIGZyb20gbWVzc2FnZV9lbmQgZXZlbnRzIGFuZCB1cGRhdGVzXG4gKiB0aGUgd29ya2VyJ3MgdHJhY2tpbmcgc3RhdGUgKyBzZXNzaW9uIHN0YXR1cyBmaWxlLlxuICovXG5mdW5jdGlvbiBwcm9jZXNzV29ya2VyTGluZShiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nLCBsaW5lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFsaW5lLnRyaW0oKSB8fCAhc3RhdGUpIHJldHVybjtcblxuICBsZXQgZXZlbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICB0cnkge1xuICAgIGV2ZW50ID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuOyAvLyBOb24tTkRKU09OIGxpbmVzIChwcm9ncmVzcyB0ZXh0LCB0b29sIG91dHB1dCkgYXJlIGV4cGVjdGVkIFx1MjAxNCBzaWxlbnQgZHJvcFxuICB9XG5cbiAgY29uc3QgdHlwZSA9IFN0cmluZyhldmVudC50eXBlID8/IFwiXCIpO1xuXG4gIC8vIG1lc3NhZ2VfZW5kIGNhcnJpZXMgdXNhZ2UgZGF0YSB3aXRoIGNvc3RcbiAgaWYgKHR5cGUgPT09IFwibWVzc2FnZV9lbmRcIiAmJiBldmVudC5tZXNzYWdlKSB7XG4gICAgY29uc3QgbXNnID0gZXZlbnQubWVzc2FnZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBjb25zdCB1c2FnZSA9IG1zZy51c2FnZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcblxuICAgIGlmICh1c2FnZSkge1xuICAgICAgY29uc3QgY29zdCA9ICh1c2FnZS5jb3N0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KT8udG90YWw7XG4gICAgICBpZiAodHlwZW9mIGNvc3QgPT09IFwibnVtYmVyXCIpIHtcbiAgICAgICAgY29uc3Qgd29ya2VyID0gc3RhdGUud29ya2Vycy5nZXQobWlsZXN0b25lSWQpO1xuICAgICAgICBpZiAod29ya2VyKSB7XG4gICAgICAgICAgd29ya2VyLmNvc3QgKz0gY29zdDtcbiAgICAgICAgICAvLyBVcGRhdGUgYWdncmVnYXRlXG4gICAgICAgICAgc3RhdGUudG90YWxDb3N0ID0gMDtcbiAgICAgICAgICBmb3IgKGNvbnN0IHcgb2Ygc3RhdGUud29ya2Vycy52YWx1ZXMoKSkge1xuICAgICAgICAgICAgc3RhdGUudG90YWxDb3N0ICs9IHcuY29zdDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBVcGRhdGUgc2Vzc2lvbiBzdGF0dXMgZmlsZSBzbyBkYXNoYm9hcmQgc2VlcyBsaXZlIGNvc3RcbiAgICBjb25zdCB3b3JrZXIgPSBzdGF0ZS53b3JrZXJzLmdldChtaWxlc3RvbmVJZCk7XG4gICAgaWYgKHdvcmtlcikge1xuICAgICAgd3JpdGVTZXNzaW9uU3RhdHVzKGJhc2VQYXRoLCB7XG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBwaWQ6IHdvcmtlci5waWQsXG4gICAgICAgIHN0YXRlOiB3b3JrZXIuc3RhdGUsXG4gICAgICAgIGN1cnJlbnRVbml0OiBudWxsLFxuICAgICAgICBjb21wbGV0ZWRVbml0czogMCxcbiAgICAgICAgY29zdDogd29ya2VyLmNvc3QsXG4gICAgICAgIGxhc3RIZWFydGJlYXQ6IERhdGUubm93KCksXG4gICAgICAgIHN0YXJ0ZWRBdDogd29ya2VyLnN0YXJ0ZWRBdCxcbiAgICAgICAgd29ya3RyZWVQYXRoOiB3b3JrZXIud29ya3RyZWVQYXRoLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gdG9vbF9leGVjdXRpb25fc3RhcnQgY2FuIHRyYWNrIGN1cnJlbnQgdW5pdFxuICBpZiAodHlwZSA9PT0gXCJleHRlbnNpb25fdWlfcmVxdWVzdFwiICYmIGV2ZW50Lm1ldGhvZCA9PT0gXCJub3RpZnlcIikge1xuICAgIC8vIEdTRCBhdXRvLW1vZGUgc2VuZHMgbm90aWZpY2F0aW9ucyBhYm91dCBjdXJyZW50IHVuaXRcbiAgICBjb25zdCB3b3JrZXIgPSBzdGF0ZS53b3JrZXJzLmdldChtaWxlc3RvbmVJZCk7XG4gICAgaWYgKHdvcmtlcikge1xuICAgICAgd3JpdGVTZXNzaW9uU3RhdHVzKGJhc2VQYXRoLCB7XG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBwaWQ6IHdvcmtlci5waWQsXG4gICAgICAgIHN0YXRlOiB3b3JrZXIuc3RhdGUsXG4gICAgICAgIGN1cnJlbnRVbml0OiBudWxsLFxuICAgICAgICBjb21wbGV0ZWRVbml0czogMCxcbiAgICAgICAgY29zdDogd29ya2VyLmNvc3QsXG4gICAgICAgIGxhc3RIZWFydGJlYXQ6IERhdGUubm93KCksXG4gICAgICAgIHN0YXJ0ZWRBdDogd29ya2VyLnN0YXJ0ZWRBdCxcbiAgICAgICAgd29ya3RyZWVQYXRoOiB3b3JrZXIud29ya3RyZWVQYXRoLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTdG9wIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFN0b3AgYWxsIHdvcmtlcnMgb3IgYSBzcGVjaWZpYyBtaWxlc3RvbmUncyB3b3JrZXIuXG4gKiBTZW5kcyBzdG9wIHNpZ25hbHMgYW5kIHVwZGF0ZXMgdHJhY2tpbmcgc3RhdGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdG9wUGFyYWxsZWwoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkPzogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghc3RhdGUpIHJldHVybjtcblxuICBjb25zdCB0YXJnZXRzID0gbWlsZXN0b25lSWRcbiAgICA/IFttaWxlc3RvbmVJZF1cbiAgICA6IFsuLi5zdGF0ZS53b3JrZXJzLmtleXMoKV07XG5cbiAgZm9yIChjb25zdCBtaWQgb2YgdGFyZ2V0cykge1xuICAgIGNvbnN0IHdvcmtlciA9IHN0YXRlLndvcmtlcnMuZ2V0KG1pZCk7XG4gICAgaWYgKCF3b3JrZXIpIGNvbnRpbnVlO1xuXG4gICAgLy8gU2VuZCBzdG9wIHNpZ25hbCB2aWEgZmlsZS1iYXNlZCBJUEMgKHdvcmtlciBjaGVja3Mgb24gbmV4dCBkaXNwYXRjaClcbiAgICBzZW5kU2lnbmFsKGJhc2VQYXRoLCBtaWQsIFwic3RvcFwiKTtcblxuICAgIC8vIFNlbmQgU0lHVEVSTSB0byB0aGUgcHJvY2VzcyBmb3IgaW1tZWRpYXRlIHJlc3BvbnNlLlxuICAgIC8vIFVzZSBwcm9jZXNzIGhhbmRsZSB3aGVuIGF2YWlsYWJsZSwgZmFsbCBiYWNrIHRvIFBJRC1iYXNlZCBraWxsXG4gICAgLy8gKGhhbmRsZXMgYXJlIG51bGwgYWZ0ZXIgY29vcmRpbmF0b3IgcmVzdGFydCAvIGRlc2VyaWFsaXphdGlvbikuXG4gICAgaWYgKHdvcmtlci5waWQgPiAwKSB7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAod29ya2VyLnByb2Nlc3MpIHtcbiAgICAgICAgICB3b3JrZXIucHJvY2Vzcy5raWxsKFwiU0lHVEVSTVwiKTtcbiAgICAgICAgfSBlbHNlIGlmICh3b3JrZXIucGlkICE9PSBwcm9jZXNzLnBpZCkge1xuICAgICAgICAgIHByb2Nlc3Mua2lsbCh3b3JrZXIucGlkLCBcIlNJR1RFUk1cIik7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcInBhcmFsbGVsXCIsIGBwcm9jZXNzLmtpbGwgU0lHVEVSTSBmYWlsZWQgZm9yIHBpZCAke3dvcmtlci5waWR9OiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG4gICAgfVxuXG4gICAgLy8gV2FpdCBmb3IgdGhlIGhlYWRsZXNzIHByb2Nlc3MgdG8gY2FzY2FkZSBTSUdURVJNIHRvIGl0cyBSUEMgY2hpbGQuXG4gICAgLy8gVGhlIGhlYWRsZXNzIHNpZ25hbCBoYW5kbGVyIGNhbGxzIGNsaWVudC5zdG9wKCkgd2hpY2ggc2VuZHMgU0lHVEVSTVxuICAgIC8vIHRvIHRoZSBSUEMgY2hpbGQgYW5kIHdhaXRzIHVwIHRvIDEwMDBtcy4gVGhlIHByZXZpb3VzIDc1MG1zIHdpbmRvd1xuICAgIC8vIHdhcyBpbnN1ZmZpY2llbnQgXHUyMDE0IHRoZSBwYXJlbnQgZ290IFNJR0tJTEwgYmVmb3JlIHRoZSBjaGlsZCBkaWVkLFxuICAgIC8vIGxlYXZpbmcgb3JwaGFuZWQgUlBDIHByb2Nlc3NlcyBob2xkaW5nIGF1dG8ubG9jay4gU2VlICMyNzk4LlxuICAgIGNvbnN0IGV4aXRlZEFmdGVyVGVybSA9IGF3YWl0IHdhaXRGb3JXb3JrZXJFeGl0KHdvcmtlciwgMzAwMCk7XG4gICAgaWYgKCFleGl0ZWRBZnRlclRlcm0gJiYgd29ya2VyLnBpZCA+IDApIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICh3b3JrZXIucHJvY2Vzcykge1xuICAgICAgICAgIHdvcmtlci5wcm9jZXNzLmtpbGwoXCJTSUdLSUxMXCIpO1xuICAgICAgICB9IGVsc2UgaWYgKHdvcmtlci5waWQgIT09IHByb2Nlc3MucGlkKSB7XG4gICAgICAgICAgcHJvY2Vzcy5raWxsKHdvcmtlci5waWQsIFwiU0lHS0lMTFwiKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkgeyBsb2dXYXJuaW5nKFwicGFyYWxsZWxcIiwgYHByb2Nlc3Mua2lsbCBTSUdLSUxMIGZhaWxlZCBmb3IgcGlkICR7d29ya2VyLnBpZH06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7IH1cbiAgICAgIGF3YWl0IHdhaXRGb3JXb3JrZXJFeGl0KHdvcmtlciwgMjUwKTtcbiAgICB9XG5cbiAgICAvLyBSZW1vdmUgc3RyZWFtIGxpc3RlbmVycyBiZWZvcmUgcmVsZWFzaW5nIHRoZSBwcm9jZXNzIGhhbmRsZVxuICAgIHdvcmtlci5jbGVhbnVwPy4oKTtcbiAgICB3b3JrZXIuY2xlYW51cCA9IHVuZGVmaW5lZDtcblxuICAgIC8vIFVwZGF0ZSBpbi1tZW1vcnkgc3RhdGVcbiAgICB3b3JrZXIuc3RhdGUgPSBcInN0b3BwZWRcIjtcbiAgICB3b3JrZXIucHJvY2VzcyA9IG51bGw7XG5cbiAgICAvLyBDbGVhbiB1cCBzZXNzaW9uIHN0YXR1cyBmaWxlXG4gICAgcmVtb3ZlU2Vzc2lvblN0YXR1cyhiYXNlUGF0aCwgbWlkKTtcbiAgfVxuXG4gIC8vIElmIHN0b3BwaW5nIGFsbCB3b3JrZXJzLCBkZWFjdGl2YXRlIHRoZSBvcmNoZXN0cmF0b3JcbiAgaWYgKCFtaWxlc3RvbmVJZCkge1xuICAgIHN0YXRlLmFjdGl2ZSA9IGZhbHNlO1xuICB9XG5cbiAgLy8gUGVyc2lzdCBmaW5hbCBzdGF0ZSBhbmQgY2xlYW4gdXAgc3RhdGUgZmlsZVxuICByZW1vdmVTdGF0ZUZpbGUoYmFzZVBhdGgpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2h1dGRvd25QYXJhbGxlbChiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmICghc3RhdGUpIHJldHVybjtcbiAgYXdhaXQgc3RvcFBhcmFsbGVsKGJhc2VQYXRoKTtcbiAgcmVzZXRPcmNoZXN0cmF0b3IoKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBhdXNlIC8gUmVzdW1lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogUGF1c2UgYSBzcGVjaWZpYyB3b3JrZXIgb3IgYWxsIHdvcmtlcnMuICovXG5leHBvcnQgZnVuY3Rpb24gcGF1c2VXb3JrZXIoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkPzogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmICghc3RhdGUpIHJldHVybjtcblxuICBjb25zdCB0YXJnZXRzID0gbWlsZXN0b25lSWRcbiAgICA/IFttaWxlc3RvbmVJZF1cbiAgICA6IFsuLi5zdGF0ZS53b3JrZXJzLmtleXMoKV07XG5cbiAgZm9yIChjb25zdCBtaWQgb2YgdGFyZ2V0cykge1xuICAgIGNvbnN0IHdvcmtlciA9IHN0YXRlLndvcmtlcnMuZ2V0KG1pZCk7XG4gICAgaWYgKCF3b3JrZXIgfHwgd29ya2VyLnN0YXRlICE9PSBcInJ1bm5pbmdcIikgY29udGludWU7XG5cbiAgICBzZW5kU2lnbmFsKGJhc2VQYXRoLCBtaWQsIFwicGF1c2VcIik7XG4gICAgd29ya2VyLnN0YXRlID0gXCJwYXVzZWRcIjtcbiAgfVxufVxuXG4vKiogUmVzdW1lIGEgc3BlY2lmaWMgd29ya2VyIG9yIGFsbCB3b3JrZXJzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc3VtZVdvcmtlcihcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ/OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKCFzdGF0ZSkgcmV0dXJuO1xuXG4gIGNvbnN0IHRhcmdldHMgPSBtaWxlc3RvbmVJZFxuICAgID8gW21pbGVzdG9uZUlkXVxuICAgIDogWy4uLnN0YXRlLndvcmtlcnMua2V5cygpXTtcblxuICBmb3IgKGNvbnN0IG1pZCBvZiB0YXJnZXRzKSB7XG4gICAgY29uc3Qgd29ya2VyID0gc3RhdGUud29ya2Vycy5nZXQobWlkKTtcbiAgICBpZiAoIXdvcmtlciB8fCB3b3JrZXIuc3RhdGUgIT09IFwicGF1c2VkXCIpIGNvbnRpbnVlO1xuXG4gICAgc2VuZFNpZ25hbChiYXNlUGF0aCwgbWlkLCBcInJlc3VtZVwiKTtcbiAgICB3b3JrZXIuc3RhdGUgPSBcInJ1bm5pbmdcIjtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3RhdHVzIFJlZnJlc2ggXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUG9sbCB3b3JrZXIgc3RhdHVzZXMgZnJvbSBkaXNrIGFuZCB1cGRhdGUgb3JjaGVzdHJhdG9yIHN0YXRlLlxuICogQ2FsbCB0aGlzIHBlcmlvZGljYWxseSBmcm9tIHRoZSBkYXNoYm9hcmQgcmVmcmVzaCBjeWNsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZnJlc2hXb3JrZXJTdGF0dXNlcyhcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgb3B0aW9uczogeyByZXN0b3JlSWZOZWVkZWQ/OiBib29sZWFuIH0gPSB7fSxcbik6IHZvaWQge1xuICBpZiAoIXN0YXRlICYmIG9wdGlvbnMucmVzdG9yZUlmTmVlZGVkKSB7XG4gICAgcmVzdG9yZVJ1bnRpbWVTdGF0ZShiYXNlUGF0aCk7XG4gIH1cbiAgaWYgKCFzdGF0ZSkgcmV0dXJuO1xuXG4gIC8vIENsZWFuIHVwIHN0YWxlIHNlc3Npb25zIGZpcnN0XG4gIGNvbnN0IHN0YWxlSWRzID0gY2xlYW51cFN0YWxlU2Vzc2lvbnMoYmFzZVBhdGgpO1xuICBmb3IgKGNvbnN0IG1pZCBvZiBzdGFsZUlkcykge1xuICAgIGNvbnN0IHdvcmtlciA9IHN0YXRlLndvcmtlcnMuZ2V0KG1pZCk7XG4gICAgaWYgKHdvcmtlcikge1xuICAgICAgd29ya2VyLmNsZWFudXA/LigpO1xuICAgICAgd29ya2VyLmNsZWFudXAgPSB1bmRlZmluZWQ7XG4gICAgICB3b3JrZXIuc3RhdGUgPSBcImVycm9yXCI7XG4gICAgICB3b3JrZXIucHJvY2VzcyA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgLy8gUmVhZCBhbGwgbGl2ZSBzZXNzaW9uIHN0YXR1c2VzIGZyb20gZGlza1xuICBjb25zdCBzdGF0dXNlcyA9IHJlYWRBbGxTZXNzaW9uU3RhdHVzZXMoYmFzZVBhdGgpO1xuICBjb25zdCBzdGF0dXNNYXAgPSBuZXcgTWFwPHN0cmluZywgU2Vzc2lvblN0YXR1cz4oKTtcbiAgZm9yIChjb25zdCBzIG9mIHN0YXR1c2VzKSB7XG4gICAgc3RhdHVzTWFwLnNldChzLm1pbGVzdG9uZUlkLCBzKTtcbiAgfVxuXG4gIC8vIFVwZGF0ZSBpbi1tZW1vcnkgd29ya2VyIHN0YXRlIGZyb20gZGlzayBkYXRhXG4gIGZvciAoY29uc3QgW21pZCwgd29ya2VyXSBvZiBzdGF0ZS53b3JrZXJzKSB7XG4gICAgY29uc3QgZGlza1N0YXR1cyA9IHN0YXR1c01hcC5nZXQobWlkKTtcbiAgICBpZiAoIWRpc2tTdGF0dXMpIHtcbiAgICAgIGlmICghaXNQaWRBbGl2ZSh3b3JrZXIucGlkKSkge1xuICAgICAgICB3b3JrZXIuY2xlYW51cD8uKCk7XG4gICAgICAgIHdvcmtlci5jbGVhbnVwID0gdW5kZWZpbmVkO1xuICAgICAgICB3b3JrZXIuc3RhdGUgPSBcImVycm9yXCI7XG4gICAgICAgIHdvcmtlci5wcm9jZXNzID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIHdvcmtlci5zdGF0ZSA9IGRpc2tTdGF0dXMuc3RhdGU7XG4gICAgd29ya2VyLmNvc3QgPSBkaXNrU3RhdHVzLmNvc3Q7XG4gICAgd29ya2VyLnBpZCA9IGRpc2tTdGF0dXMucGlkO1xuICB9XG5cbiAgLy8gUmVjYWxjdWxhdGUgYWdncmVnYXRlIGNvc3RcbiAgc3RhdGUudG90YWxDb3N0ID0gMDtcbiAgZm9yIChjb25zdCB3b3JrZXIgb2Ygc3RhdGUud29ya2Vycy52YWx1ZXMoKSkge1xuICAgIHN0YXRlLnRvdGFsQ29zdCArPSB3b3JrZXIuY29zdDtcbiAgfVxuXG4gIC8vIElmIGFsbCB3b3JrZXJzIGFyZSBpbiBhIHRlcm1pbmFsIHN0YXRlIChlcnJvci9zdG9wcGVkKSwgdGhlIG9yY2hlc3RyYXRpb25cbiAgLy8gaXMgZmluaXNoZWQgXHUyMDE0IGRlYWN0aXZhdGUgYW5kIGNsZWFuIHVwIHNvIHpvbWJpZSB3b3JrZXJzIGRvbid0IHBlcnNpc3QuXG4gIGNvbnN0IGFsbERlYWQgPSBbLi4uc3RhdGUud29ya2Vycy52YWx1ZXMoKV0uZXZlcnkoXG4gICAgKHcpID0+IHcuc3RhdGUgPT09IFwiZXJyb3JcIiB8fCB3LnN0YXRlID09PSBcInN0b3BwZWRcIixcbiAgKTtcbiAgaWYgKGFsbERlYWQpIHtcbiAgICBzdGF0ZS5hY3RpdmUgPSBmYWxzZTtcbiAgICByZW1vdmVTdGF0ZUZpbGUoYmFzZVBhdGgpO1xuICAgIHN0YXRlID0gbnVsbDtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBQZXJzaXN0IHVwZGF0ZWQgc3RhdGUgZm9yIGNyYXNoIHJlY292ZXJ5XG4gIHBlcnNpc3RTdGF0ZShiYXNlUGF0aCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBCdWRnZXQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBHZXQgYWdncmVnYXRlIGNvc3QgYWNyb3NzIGFsbCB3b3JrZXJzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEFnZ3JlZ2F0ZUNvc3QoKTogbnVtYmVyIHtcbiAgaWYgKCFzdGF0ZSkgcmV0dXJuIDA7XG4gIHJldHVybiBzdGF0ZS50b3RhbENvc3Q7XG59XG5cbi8qKiBDaGVjayBpZiBidWRnZXQgY2VpbGluZyBoYXMgYmVlbiByZWFjaGVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQnVkZ2V0RXhjZWVkZWQoKTogYm9vbGVhbiB7XG4gIGlmICghc3RhdGUpIHJldHVybiBmYWxzZTtcbiAgaWYgKHN0YXRlLmNvbmZpZy5idWRnZXRfY2VpbGluZyA9PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBzdGF0ZS50b3RhbENvc3QgPj0gc3RhdGUuY29uZmlnLmJ1ZGdldF9jZWlsaW5nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVzZXQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBSZXNldCBvcmNoZXN0cmF0b3Igc3RhdGUuIENhbGxlZCBvbiBjbGVhbiBzaHV0ZG93bi4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldE9yY2hlc3RyYXRvcigpOiB2b2lkIHtcbiAgaWYgKHN0YXRlKSB7XG4gICAgLy8gRXhwbGljaXRseSByZWxlYXNlIGFsbCBXb3JrZXJJbmZvIHJlZmVyZW5jZXMgYW5kIHJ1biBhbnkgcGVuZGluZ1xuICAgIC8vIGNsZWFudXAgY2FsbGJhY2tzIHNvIGNoaWxkIHByb2Nlc3Mgc3RyZWFtIGNsb3N1cmVzIGFyZSBmcmVlZC5cbiAgICBmb3IgKGNvbnN0IHcgb2Ygc3RhdGUud29ya2Vycy52YWx1ZXMoKSkge1xuICAgICAgdy5jbGVhbnVwPy4oKTtcbiAgICAgIHcuY2xlYW51cCA9IHVuZGVmaW5lZDtcbiAgICAgIHcucHJvY2VzcyA9IG51bGw7XG4gICAgfVxuICAgIHN0YXRlLndvcmtlcnMuY2xlYXIoKTtcbiAgfVxuICBzdGF0ZSA9IG51bGw7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFTQSxTQUFTLGFBQWdDO0FBQ3pDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGVBQWU7QUFDeEIsU0FBUyxnQkFBZ0Isb0JBQW9CO0FBQzdDLFNBQVMsb0JBQW9CLHdDQUF3QywyQkFBMkIsOEJBQThCO0FBQzlILFNBQVMsMEJBQTBCO0FBQ25DLFNBQVMsNkJBQTZCO0FBQ3RDLFNBQVMsNkJBQTZCO0FBR3RDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFSztBQUNQO0FBQUEsRUFDRTtBQUFBLE9BRUs7QUFDUCxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLGtCQUFrQjtBQUMzQixTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLCtCQUErQjtBQTBCeEMsSUFBSSxRQUFr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
