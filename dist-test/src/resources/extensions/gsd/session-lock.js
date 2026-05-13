import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { gsdRoot } from "./paths.js";
import { atomicWriteSync } from "./atomic-write.js";
const _require = createRequire(import.meta.url);
let _releaseFunction = null;
let _lockedPath = null;
let _lockPid = 0;
let _lockCompromised = false;
let _exitHandlerRegistered = false;
const _lockDirRegistry = /* @__PURE__ */ new Set();
let _snapshotLockPath = null;
let _lockAcquiredAt = 0;
const LOCK_FILE = "auto.lock";
function effectiveLockFile() {
  const mid = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK : null;
  return mid ? `auto-${mid}.lock` : LOCK_FILE;
}
function effectiveLockTarget(gsdDir) {
  const mid = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK : null;
  return mid ? join(gsdDir, "parallel", mid) : gsdDir;
}
function lockPath(basePath) {
  if (_snapshotLockPath) return _snapshotLockPath;
  return join(gsdRoot(basePath), effectiveLockFile());
}
function cleanupStrayLockFiles(basePath) {
  const gsdDir = gsdRoot(basePath);
  try {
    if (existsSync(gsdDir)) {
      for (const entry of readdirSync(gsdDir)) {
        if (entry !== LOCK_FILE && /^auto\s.+\.lock$/i.test(entry)) {
          try {
            unlinkSync(join(gsdDir, entry));
          } catch {
          }
        }
      }
    }
  } catch {
  }
  try {
    const parentDir = dirname(gsdDir);
    const gsdDirName = gsdDir.split("/").pop() || ".gsd";
    if (existsSync(parentDir)) {
      for (const entry of readdirSync(parentDir)) {
        if (entry !== `${gsdDirName}.lock` && entry.startsWith(gsdDirName) && entry.endsWith(".lock")) {
          const fullPath = join(parentDir, entry);
          try {
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
              rmSync(fullPath, { recursive: true, force: true });
            }
          } catch {
          }
        }
      }
    }
  } catch {
  }
}
function ensureExitHandler(_gsdDir) {
  _lockDirRegistry.add(_gsdDir);
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;
  process.once("exit", () => {
    try {
      if (_releaseFunction) {
        _releaseFunction();
        _releaseFunction = null;
      }
    } catch {
    }
    for (const dir of _lockDirRegistry) {
      const lockFile = join(dir, LOCK_FILE);
      const ownsRegisteredLock = isLockFileOwnedByCurrentProcess(lockFile);
      try {
        if (ownsRegisteredLock && existsSync(lockFile)) unlinkSync(lockFile);
      } catch {
      }
      try {
        const lockDir = join(dir + ".lock");
        if (ownsRegisteredLock && existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
      } catch {
      }
    }
  });
}
function createLockCompromisedHandler(lockFilePath) {
  return () => {
    const elapsed = Date.now() - _lockAcquiredAt;
    if (elapsed < 18e5) {
      process.stderr.write(
        `[gsd] Lock heartbeat caught up after ${Math.round(elapsed / 1e3)}s \u2014 long LLM call, no action needed.
`
      );
      return;
    }
    const existing = readExistingLockDataWithRetry(lockFilePath);
    if (existing && existing.pid === process.pid) {
      process.stderr.write(
        `[gsd] Lock heartbeat mismatch after ${Math.round(elapsed / 1e3)}s \u2014 lock file still owned by PID ${process.pid}, treating as false positive.
`
      );
      return;
    }
    _lockCompromised = true;
    _releaseFunction = null;
  };
}
function assignLockState(basePath, release, lockFilePath) {
  _releaseFunction = release;
  _lockedPath = basePath;
  _lockPid = process.pid;
  _lockCompromised = false;
  _lockAcquiredAt = Date.now();
  _snapshotLockPath = lockFilePath;
}
function acquireSessionLock(basePath) {
  const lp = lockPath(basePath);
  if (_releaseFunction && _lockedPath === basePath) {
    try {
      _releaseFunction();
    } catch {
    }
    _releaseFunction = null;
    _lockedPath = null;
    _lockPid = 0;
    _lockCompromised = false;
  }
  mkdirSync(dirname(lp), { recursive: true });
  cleanupStrayLockFiles(basePath);
  const lockData = {
    pid: process.pid,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    unitType: "starting",
    unitId: "bootstrap",
    unitStartedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  let lockfile;
  try {
    lockfile = _require("proper-lockfile");
  } catch {
    return acquireFallbackLock(basePath, lp, lockData);
  }
  const gsdDir = gsdRoot(basePath);
  const lockTarget = effectiveLockTarget(gsdDir);
  const lockDir = lockTarget + ".lock";
  if (existsSync(lockDir)) {
    const existingData = readExistingLockData(lp);
    const isOrphan = !existingData || existingData.pid && !isPidAlive(existingData.pid);
    if (isOrphan) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
      }
      try {
        if (existsSync(lp)) unlinkSync(lp);
      } catch {
      }
    }
  }
  try {
    mkdirSync(lockTarget, { recursive: true });
    const release = lockfile.lockSync(lockTarget, {
      realpath: false,
      stale: 18e5,
      // 30 minutes — safe for laptop sleep / long event loop stalls
      update: 1e4,
      // Update lock mtime every 10s to prove liveness
      onCompromised: createLockCompromisedHandler(lp)
    });
    assignLockState(basePath, release, lp);
    ensureExitHandler(lockTarget);
    atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
    return { acquired: true };
  } catch (err) {
    const existingData = readExistingLockData(lp);
    const existingPid = existingData?.pid;
    if (!existingData || existingPid && !isPidAlive(existingPid)) {
      try {
        const lockDir2 = join(lockTarget + ".lock");
        if (existsSync(lockDir2)) rmSync(lockDir2, { recursive: true, force: true });
        if (existsSync(lp)) unlinkSync(lp);
        const release = lockfile.lockSync(lockTarget, {
          realpath: false,
          stale: 18e5,
          // 30 minutes — match primary lock settings
          update: 1e4,
          onCompromised: createLockCompromisedHandler(lp)
        });
        assignLockState(basePath, release, lp);
        ensureExitHandler(lockTarget);
        atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
        return { acquired: true };
      } catch {
      }
    }
    const lockDirPath = lockTarget + ".lock";
    const reason = existingPid ? `Another auto-mode session (PID ${existingPid}) appears to be running.
Stop it with \`kill ${existingPid}\` before starting a new session.` : `Another auto-mode session lock is stuck on this project.
Run: rm -rf "${lockDirPath}" && rm -f "${lp}"`;
    return { acquired: false, reason, existingPid };
  }
}
function acquireFallbackLock(basePath, lp, lockData) {
  const existing = readExistingLockData(lp);
  if (existing && existing.pid !== process.pid) {
    if (isPidAlive(existing.pid)) {
      return {
        acquired: false,
        reason: `Another auto-mode session (PID ${existing.pid}) is already running on this project.`,
        existingPid: existing.pid
      };
    }
  }
  atomicWriteSync(lp, JSON.stringify(lockData, null, 2));
  _lockedPath = basePath;
  _lockPid = process.pid;
  return { acquired: true };
}
function updateSessionLock(basePath, unitType, unitId, sessionFile) {
  if (_lockedPath !== basePath && _lockedPath !== null) return;
  const lp = lockPath(basePath);
  try {
    const data = {
      pid: process.pid,
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      unitType,
      unitId,
      unitStartedAt: (/* @__PURE__ */ new Date()).toISOString(),
      sessionFile
    };
    atomicWriteSync(lp, JSON.stringify(data, null, 2));
  } catch {
  }
}
function getSessionLockStatus(basePath) {
  if (_lockCompromised) {
    const lp2 = lockPath(basePath);
    const existing2 = readExistingLockDataWithRetry(lp2);
    if (existing2 && existing2.pid === process.pid) {
      try {
        const result = acquireSessionLock(basePath);
        if (result.acquired) {
          process.stderr.write(
            `[gsd] Lock recovered after onCompromised \u2014 lock file PID matched, re-acquired.
`
          );
          return { valid: true, recovered: true };
        }
      } catch {
      }
    }
    return {
      valid: false,
      failureReason: "compromised",
      existingPid: existing2?.pid,
      expectedPid: process.pid
    };
  }
  if (_releaseFunction && _lockedPath === basePath) {
    return { valid: true };
  }
  const lp = lockPath(basePath);
  const existing = readExistingLockData(lp);
  if (!existing) {
    return {
      valid: false,
      failureReason: "missing-metadata",
      expectedPid: process.pid
    };
  }
  if (existing.pid !== process.pid) {
    return {
      valid: false,
      failureReason: "pid-mismatch",
      existingPid: existing.pid,
      expectedPid: process.pid
    };
  }
  return { valid: true };
}
function validateSessionLock(basePath) {
  return getSessionLockStatus(basePath).valid;
}
function releaseSessionLock(basePath) {
  if (_releaseFunction) {
    try {
      _releaseFunction();
    } catch {
    }
    _releaseFunction = null;
  }
  const lp = lockPath(basePath);
  const ownsPrimaryLock = isLockFileOwnedByCurrentProcess(lp);
  try {
    if (ownsPrimaryLock && existsSync(lp)) unlinkSync(lp);
  } catch {
  }
  const gsdDir = gsdRoot(basePath);
  const lockTarget = effectiveLockTarget(gsdDir);
  try {
    const lockDir = join(lockTarget + ".lock");
    if (ownsPrimaryLock && existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
  } catch {
  }
  if (ownsPrimaryLock && lockTarget !== gsdDir) {
    try {
      if (existsSync(lockTarget)) rmSync(lockTarget, { recursive: true, force: true });
    } catch {
    }
  }
  for (const dir of _lockDirRegistry) {
    const lockFile = join(dir, LOCK_FILE);
    const ownsRegisteredLock = isLockFileOwnedByCurrentProcess(lockFile);
    try {
      if (ownsRegisteredLock && existsSync(lockFile)) unlinkSync(lockFile);
    } catch {
    }
    try {
      const lockDir = join(dir + ".lock");
      if (ownsRegisteredLock && existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
    } catch {
    }
  }
  _lockDirRegistry.clear();
  cleanupStrayLockFiles(basePath);
  _lockedPath = null;
  _lockPid = 0;
  _lockCompromised = false;
  _lockAcquiredAt = 0;
  _snapshotLockPath = null;
}
function readSessionLockData(basePath) {
  return readExistingLockData(lockPath(basePath));
}
function isSessionLockProcessAlive(data) {
  return isPidAlive(data.pid);
}
function removeStaleSessionLock(basePath) {
  const lp = lockPath(basePath);
  const gsdDir = gsdRoot(basePath);
  const lockTarget = effectiveLockTarget(gsdDir);
  const lockDir = lockTarget + ".lock";
  const existingData = readExistingLockData(lp);
  const isOrphan = !existingData || typeof existingData.pid === "number" && !isPidAlive(existingData.pid);
  if (!isOrphan) return false;
  let removed = false;
  if (existsSync(lockDir)) {
    try {
      rmSync(lockDir, { recursive: true, force: true });
      removed = true;
    } catch {
    }
  }
  if (existsSync(lp)) {
    try {
      unlinkSync(lp);
      removed = true;
    } catch {
    }
  }
  return removed;
}
function isSessionLockHeld(basePath) {
  return _lockedPath === basePath && _lockPid === process.pid;
}
function _getRegisteredLockDirs() {
  return [..._lockDirRegistry];
}
function readExistingLockData(lp) {
  try {
    if (!existsSync(lp)) return null;
    const raw = readFileSync(lp, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function isLockFileOwnedByCurrentProcess(lp) {
  const existing = readExistingLockData(lp);
  return existing?.pid === process.pid;
}
function readExistingLockDataWithRetry(lp, options) {
  const maxAttempts = options?.maxAttempts ?? 3;
  const delayMs = options?.delayMs ?? 200;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const data = readExistingLockData(lp);
    if (data !== null) return data;
    if (attempt < maxAttempts) {
      const start = Date.now();
      while (Date.now() - start < delayMs) {
      }
    }
  }
  return null;
}
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "EPERM") return true;
    return false;
  }
}
export {
  _getRegisteredLockDirs,
  acquireSessionLock,
  cleanupStrayLockFiles,
  effectiveLockFile,
  effectiveLockTarget,
  getSessionLockStatus,
  isSessionLockHeld,
  isSessionLockProcessAlive,
  readExistingLockDataWithRetry,
  readSessionLockData,
  releaseSessionLock,
  removeStaleSessionLock,
  updateSessionLock,
  validateSessionLock
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zZXNzaW9uLWxvY2sudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogR1NEIFNlc3Npb24gTG9jayBcdTIwMTQgT1MtbGV2ZWwgZXhjbHVzaXZlIGxvY2tpbmcgZm9yIGF1dG8tbW9kZSBzZXNzaW9ucy5cbiAqXG4gKiBQcmV2ZW50cyBtdWx0aXBsZSBHU0QgcHJvY2Vzc2VzIGZyb20gcnVubmluZyBhdXRvLW1vZGUgY29uY3VycmVudGx5IG9uXG4gKiB0aGUgc2FtZSBwcm9qZWN0LiBVc2VzIHByb3Blci1sb2NrZmlsZSBmb3IgT1MtbGV2ZWwgZmlsZSBsb2NraW5nIChmbG9jay9cbiAqIGxvY2tmaWxlKSB3aGljaCBlbGltaW5hdGVzIHRoZSBUT0NUT1UgcmFjZSBjb25kaXRpb24gdGhhdCBleGlzdGVkIHdpdGhcbiAqIHRoZSBvbGQgYWR2aXNvcnkgSlNPTiBsb2NrIGFwcHJvYWNoLlxuICpcbiAqIFRoZSBsb2NrIGZpbGUgKC5nc2QvYXV0by5sb2NrKSBjb250YWlucyBKU09OIG1ldGFkYXRhIChQSUQsIHN0YXJ0IHRpbWUsXG4gKiB1bml0IGluZm8pIGZvciBkaWFnbm9zdGljcywgYnV0IHRoZSBhY3R1YWwgZXhjbHVzaW9uIGlzIGVuZm9yY2VkIGJ5IHRoZVxuICogT1MtbGV2ZWwgbG9jayBoZWxkIHZpYSBwcm9wZXItbG9ja2ZpbGUuXG4gKlxuICogTGlmZWN5Y2xlOlxuICogICBhY3F1aXJlU2Vzc2lvbkxvY2soKSAgXHUyMDE0IGNhbGxlZCBhdCB0aGUgU1RBUlQgb2YgYm9vdHN0cmFwQXV0b1Nlc3Npb25cbiAqICAgdmFsaWRhdGVTZXNzaW9uTG9jaygpIFx1MjAxNCBjYWxsZWQgcGVyaW9kaWNhbGx5IGR1cmluZyBkaXNwYXRjaCB0byBkZXRlY3QgdGFrZW92ZXJcbiAqICAgcmVsZWFzZVNlc3Npb25Mb2NrKCkgIFx1MjAxNCBjYWxsZWQgb24gY2xlYW4gc3RvcC9wYXVzZVxuICovXG5cbmltcG9ydCB7IGNyZWF0ZVJlcXVpcmUgfSBmcm9tIFwibm9kZTptb2R1bGVcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgcmVhZGRpclN5bmMsIG1rZGlyU3luYywgdW5saW5rU3luYywgcm1TeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luLCBkaXJuYW1lIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZ3NkUm9vdCB9IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBhdG9taWNXcml0ZVN5bmMgfSBmcm9tIFwiLi9hdG9taWMtd3JpdGUuanNcIjtcblxuY29uc3QgX3JlcXVpcmUgPSBjcmVhdGVSZXF1aXJlKGltcG9ydC5tZXRhLnVybCk7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBTZXNzaW9uTG9ja0RhdGEge1xuICBwaWQ6IG51bWJlcjtcbiAgc3RhcnRlZEF0OiBzdHJpbmc7XG4gIHVuaXRUeXBlOiBzdHJpbmc7XG4gIHVuaXRJZDogc3RyaW5nO1xuICB1bml0U3RhcnRlZEF0OiBzdHJpbmc7XG4gIHNlc3Npb25GaWxlPzogc3RyaW5nO1xufVxuXG5leHBvcnQgdHlwZSBTZXNzaW9uTG9ja1Jlc3VsdCA9XG4gIHwgeyBhY3F1aXJlZDogdHJ1ZSB9XG4gIHwgeyBhY3F1aXJlZDogZmFsc2U7IHJlYXNvbjogc3RyaW5nOyBleGlzdGluZ1BpZD86IG51bWJlciB9O1xuXG5leHBvcnQgdHlwZSBTZXNzaW9uTG9ja0ZhaWx1cmVSZWFzb24gPVxuICB8IFwiY29tcHJvbWlzZWRcIlxuICB8IFwibWlzc2luZy1tZXRhZGF0YVwiXG4gIHwgXCJwaWQtbWlzbWF0Y2hcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTZXNzaW9uTG9ja1N0YXR1cyB7XG4gIHZhbGlkOiBib29sZWFuO1xuICBmYWlsdXJlUmVhc29uPzogU2Vzc2lvbkxvY2tGYWlsdXJlUmVhc29uO1xuICBleGlzdGluZ1BpZD86IG51bWJlcjtcbiAgZXhwZWN0ZWRQaWQ/OiBudW1iZXI7XG4gIHJlY292ZXJlZD86IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBQcm9wZXJMb2NrZmlsZUFwaSB7XG4gIGxvY2tTeW5jKFxuICAgIHBhdGg6IHN0cmluZyxcbiAgICBvcHRpb25zPzoge1xuICAgICAgcmVhbHBhdGg/OiBib29sZWFuO1xuICAgICAgc3RhbGU/OiBudW1iZXI7XG4gICAgICB1cGRhdGU/OiBudW1iZXI7XG4gICAgICBvbkNvbXByb21pc2VkPzogKCkgPT4gdm9pZDtcbiAgICB9LFxuICApOiAoKSA9PiB2b2lkO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTW9kdWxlIFN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogUmVsZWFzZSBmdW5jdGlvbiBmcm9tIHByb3Blci1sb2NrZmlsZSBcdTIwMTQgY2FsbGluZyBpdCByZWxlYXNlcyB0aGUgT1MgbG9jay4gKi9cbmxldCBfcmVsZWFzZUZ1bmN0aW9uOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuLyoqIFRoZSBwYXRoIHdlIGN1cnJlbnRseSBob2xkIGEgbG9jayBvbi4gKi9cbmxldCBfbG9ja2VkUGF0aDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBPdXIgUElEIGF0IGxvY2sgYWNxdWlzaXRpb24gdGltZS4gKi9cbmxldCBfbG9ja1BpZDogbnVtYmVyID0gMDtcblxuLyoqIFNldCB0byB0cnVlIHdoZW4gcHJvcGVyLWxvY2tmaWxlIGZpcmVzIG9uQ29tcHJvbWlzZWQgKG10aW1lIGRyaWZ0LCBzbGVlcCwgZXRjLikuICovXG5sZXQgX2xvY2tDb21wcm9taXNlZDogYm9vbGVhbiA9IGZhbHNlO1xuXG4vKiogV2hldGhlciB3ZSd2ZSBhbHJlYWR5IHJlZ2lzdGVyZWQgYSBwcm9jZXNzLm9uKCdleGl0JykgaGFuZGxlci4gKi9cbmxldCBfZXhpdEhhbmRsZXJSZWdpc3RlcmVkOiBib29sZWFuID0gZmFsc2U7XG5cbi8qKiBSZWdpc3RyeSBvZiBhbGwgZ3NkRGlyIHBhdGhzIHdoZXJlIGxvY2tzIHdlcmUgY3JlYXRlZCBkdXJpbmcgdGhpcyBzZXNzaW9uLlxuICogIFRoZSBleGl0IGhhbmRsZXIgY2xlYW5zIEFMTCBvZiB0aGVzZSwgbm90IGp1c3QgdGhlIGN1cnJlbnQgZ3NkUm9vdCgpLiAoIzE1NzgpICovXG5jb25zdCBfbG9ja0RpclJlZ2lzdHJ5OiBTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoKTtcblxuLyoqIFNuYXBzaG90dGVkIGxvY2sgZmlsZSBwYXRoIFx1MjAxNCBjYXB0dXJlZCBhdCBhY3F1aXJlU2Vzc2lvbkxvY2sgdGltZSB0byBhdm9pZFxuICogIGdzZFJvb3QoKSByZXNvbHZpbmcgZGlmZmVyZW50bHkgaW4gd29ya3RyZWUgdnMgcHJvamVjdCByb290IGNvbnRleHRzICgjMTM2MykuICovXG5sZXQgX3NuYXBzaG90TG9ja1BhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKiogVGltZXN0YW1wIHdoZW4gdGhlIHNlc3Npb24gbG9jayB3YXMgYWNxdWlyZWQgXHUyMDE0IHVzZWQgdG8gZGV0ZWN0IGZhbHNlLXBvc2l0aXZlXG4gKiAgb25Db21wcm9taXNlZCBldmVudHMgZnJvbSBldmVudCBsb29wIHN0YWxscyB3aXRoaW4gdGhlIHN0YWxlIHdpbmRvdyAoIzEzNjIpLiAqL1xubGV0IF9sb2NrQWNxdWlyZWRBdDogbnVtYmVyID0gMDtcblxuY29uc3QgTE9DS19GSUxFID0gXCJhdXRvLmxvY2tcIjtcblxuLyoqXG4gKiBEZXJpdmUgdGhlIGVmZmVjdGl2ZSBsb2NrIGZpbGUgbmFtZSBmb3IgdGhlIGN1cnJlbnQgcHJvY2Vzcy5cbiAqIEluIHBhcmFsbGVsIHdvcmtlciBtb2RlIChHU0RfUEFSQUxMRUxfV09SS0VSICsgR1NEX01JTEVTVE9ORV9MT0NLKSxcbiAqIGVhY2ggd29ya2VyIHVzZXMgYSBwZXItbWlsZXN0b25lIGxvY2sgZmlsZSAoYGF1dG8tPG1pbGVzdG9uZUlkPi5sb2NrYClcbiAqIHRvIGF2b2lkIGNvbnRlbmRpbmcgb24gdGhlIHNoYXJlZCBgLmdzZC9hdXRvLmxvY2tgICgjMjE4NCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlZmZlY3RpdmVMb2NrRmlsZSgpOiBzdHJpbmcge1xuICBjb25zdCBtaWQgPSBwcm9jZXNzLmVudi5HU0RfUEFSQUxMRUxfV09SS0VSID8gcHJvY2Vzcy5lbnYuR1NEX01JTEVTVE9ORV9MT0NLIDogbnVsbDtcbiAgcmV0dXJuIG1pZCA/IGBhdXRvLSR7bWlkfS5sb2NrYCA6IExPQ0tfRklMRTtcbn1cblxuLyoqXG4gKiBEZXJpdmUgdGhlIE9TLWxldmVsIGxvY2sgdGFyZ2V0IGRpcmVjdG9yeSBmb3IgdGhlIGN1cnJlbnQgcHJvY2Vzcy5cbiAqIEluIHBhcmFsbGVsIHdvcmtlciBtb2RlLCB1c2VzIGAuZ3NkL3BhcmFsbGVsLzxtaWxlc3RvbmVJZD4vYCBpbnN0ZWFkIG9mXG4gKiBgLmdzZC9gIHNvIHdvcmtlcnMgZG9uJ3QgY29udGVuZCBvbiB0aGUgc2FtZSBwcm9wZXItbG9ja2ZpbGUgZGlyZWN0b3J5ICgjMjE4NCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlZmZlY3RpdmVMb2NrVGFyZ2V0KGdzZERpcjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbWlkID0gcHJvY2Vzcy5lbnYuR1NEX1BBUkFMTEVMX1dPUktFUiA/IHByb2Nlc3MuZW52LkdTRF9NSUxFU1RPTkVfTE9DSyA6IG51bGw7XG4gIHJldHVybiBtaWQgPyBqb2luKGdzZERpciwgXCJwYXJhbGxlbFwiLCBtaWQpIDogZ3NkRGlyO1xufVxuXG5mdW5jdGlvbiBsb2NrUGF0aChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgLy8gSWYgd2UgaGF2ZSBhIHNuYXBzaG90dGVkIHBhdGggZnJvbSBhY3F1aXNpdGlvbiwgdXNlIGl0IGZvciBjb25zaXN0ZW5jeVxuICBpZiAoX3NuYXBzaG90TG9ja1BhdGgpIHJldHVybiBfc25hcHNob3RMb2NrUGF0aDtcbiAgcmV0dXJuIGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIGVmZmVjdGl2ZUxvY2tGaWxlKCkpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU3RyYXkgTG9jayBDbGVhbnVwIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlbW92ZSBudW1iZXJlZCBsb2NrIGZpbGUgdmFyaWFudHMgKGUuZy4gXCJhdXRvIDIubG9ja1wiLCBcImF1dG8gMy5sb2NrXCIpXG4gKiB0aGF0IGFjY3VtdWxhdGUgZnJvbSBtYWNPUyBmaWxlIGNvbmZsaWN0IHJlc29sdXRpb24gKGlDbG91ZC9Ecm9wYm94L09uZURyaXZlKVxuICogb3Igb3RoZXIgZmlsZXN5c3RlbS1sZXZlbCBjb3B5LW9uLWNvbmZsaWN0IGJlaGF2aW9yICgjMTMxNSkuXG4gKlxuICogQWxzbyByZW1vdmVzIHN0cmF5IHByb3Blci1sb2NrZmlsZSBkaXJlY3RvcmllcyBiZXlvbmQgdGhlIGNhbm9uaWNhbCBgLmdzZC5sb2NrL2AuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGVhbnVwU3RyYXlMb2NrRmlsZXMoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBnc2REaXIgPSBnc2RSb290KGJhc2VQYXRoKTtcblxuICAvLyBDbGVhbiBudW1iZXJlZCBhdXRvIGxvY2sgZmlsZXMgaW5zaWRlIC5nc2QvXG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoZ3NkRGlyKSkge1xuICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhnc2REaXIpKSB7XG4gICAgICAgIC8vIE1hdGNoIFwiYXV0byA8Tj4ubG9ja1wiIG9yIFwiYXV0byAoPE4+KS5sb2NrXCIgdmFyaWFudHMgYnV0IE5PVCB0aGUgY2Fub25pY2FsIFwiYXV0by5sb2NrXCJcbiAgICAgICAgaWYgKGVudHJ5ICE9PSBMT0NLX0ZJTEUgJiYgL15hdXRvXFxzLitcXC5sb2NrJC9pLnRlc3QoZW50cnkpKSB7XG4gICAgICAgICAgdHJ5IHsgdW5saW5rU3luYyhqb2luKGdzZERpciwgZW50cnkpKTsgfSBjYXRjaCB7IC8qIGJlc3QtZWZmb3J0ICovIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7IC8qIG5vbi1mYXRhbDogZGlyZWN0b3J5IHJlYWQgZmFpbHVyZSAqLyB9XG5cbiAgLy8gQ2xlYW4gc3RyYXkgcHJvcGVyLWxvY2tmaWxlIGRpcmVjdG9yaWVzIChlLmcuIFwiLmdzZCAyLmxvY2svXCIpXG4gIC8vIFRoZSBjYW5vbmljYWwgb25lIGlzIFwiLmdzZC5sb2NrL1wiIFx1MjAxNCBhbnl0aGluZyBlbHNlIGlzIHN0cmF5LlxuICB0cnkge1xuICAgIGNvbnN0IHBhcmVudERpciA9IGRpcm5hbWUoZ3NkRGlyKTtcbiAgICBjb25zdCBnc2REaXJOYW1lID0gZ3NkRGlyLnNwbGl0KFwiL1wiKS5wb3AoKSB8fCBcIi5nc2RcIjtcbiAgICBpZiAoZXhpc3RzU3luYyhwYXJlbnREaXIpKSB7XG4gICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJlYWRkaXJTeW5jKHBhcmVudERpcikpIHtcbiAgICAgICAgLy8gTWF0Y2ggXCIuZ3NkIDxOPi5sb2NrXCIgb3IgXCIuZ3NkICg8Tj4pLmxvY2tcIiBkaXJlY3RvcmllcyBidXQgTk9UIFwiLmdzZC5sb2NrXCJcbiAgICAgICAgaWYgKGVudHJ5ICE9PSBgJHtnc2REaXJOYW1lfS5sb2NrYCAmJiBlbnRyeS5zdGFydHNXaXRoKGdzZERpck5hbWUpICYmIGVudHJ5LmVuZHNXaXRoKFwiLmxvY2tcIikpIHtcbiAgICAgICAgICBjb25zdCBmdWxsUGF0aCA9IGpvaW4ocGFyZW50RGlyLCBlbnRyeSk7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHN0YXQgPSBzdGF0U3luYyhmdWxsUGF0aCk7XG4gICAgICAgICAgICBpZiAoc3RhdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgICAgICAgIHJtU3luYyhmdWxsUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2ggeyAvKiBiZXN0LWVmZm9ydCAqLyB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggeyAvKiBub24tZmF0YWwgKi8gfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIGEgc2luZ2xlIHByb2Nlc3MgZXhpdCBoYW5kbGVyIHRoYXQgY2xlYW5zIHVwIGxvY2sgc3RhdGUuXG4gKiBVc2VzIG1vZHVsZS1sZXZlbCByZWZlcmVuY2VzIHNvIGl0IGFsd2F5cyBvcGVyYXRlcyBvbiBjdXJyZW50IHN0YXRlLlxuICogT25seSByZWdpc3RlcnMgb25jZSBcdTIwMTQgc3Vic2VxdWVudCBjYWxscyBhcmUgbm8tb3BzLlxuICovXG5mdW5jdGlvbiBlbnN1cmVFeGl0SGFuZGxlcihfZ3NkRGlyOiBzdHJpbmcpOiB2b2lkIHtcbiAgLy8gUmVnaXN0ZXIgdGhlIGdzZERpciBzbyBleGl0IGNsZWFudXAgY292ZXJzIGl0XG4gIF9sb2NrRGlyUmVnaXN0cnkuYWRkKF9nc2REaXIpO1xuXG4gIGlmIChfZXhpdEhhbmRsZXJSZWdpc3RlcmVkKSByZXR1cm47XG4gIF9leGl0SGFuZGxlclJlZ2lzdGVyZWQgPSB0cnVlO1xuXG4gIHByb2Nlc3Mub25jZShcImV4aXRcIiwgKCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBpZiAoX3JlbGVhc2VGdW5jdGlvbikgeyBfcmVsZWFzZUZ1bmN0aW9uKCk7IF9yZWxlYXNlRnVuY3Rpb24gPSBudWxsOyB9XG4gICAgfSBjYXRjaCB7IC8qIGJlc3QtZWZmb3J0ICovIH1cbiAgICAvLyBDbGVhbiBBTEwgcmVnaXN0ZXJlZCBsb2NrIHBhdGhzLCBub3QganVzdCB0aGUgY3VycmVudCBvbmUgKCMxNTc4KS5cbiAgICAvLyBMb2NrIGZpbGVzIGFjY3VtdWxhdGUgYWNyb3NzIG1haW4gcHJvamVjdCAuZ3NkLywgd29ya3RyZWUgLmdzZC8sXG4gICAgLy8gYW5kIHByb2plY3RzIHJlZ2lzdHJ5IHBhdGhzIFx1MjAxNCBjbGVhbnVwIG11c3QgY292ZXIgYWxsIG9mIHRoZW0uXG4gICAgZm9yIChjb25zdCBkaXIgb2YgX2xvY2tEaXJSZWdpc3RyeSkge1xuICAgICAgY29uc3QgbG9ja0ZpbGUgPSBqb2luKGRpciwgTE9DS19GSUxFKTtcbiAgICAgIGNvbnN0IG93bnNSZWdpc3RlcmVkTG9jayA9IGlzTG9ja0ZpbGVPd25lZEJ5Q3VycmVudFByb2Nlc3MobG9ja0ZpbGUpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKG93bnNSZWdpc3RlcmVkTG9jayAmJiBleGlzdHNTeW5jKGxvY2tGaWxlKSkgdW5saW5rU3luYyhsb2NrRmlsZSk7XG4gICAgICB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbG9ja0RpciA9IGpvaW4oZGlyICsgXCIubG9ja1wiKTtcbiAgICAgICAgaWYgKG93bnNSZWdpc3RlcmVkTG9jayAmJiBleGlzdHNTeW5jKGxvY2tEaXIpKSBybVN5bmMobG9ja0RpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgfSBjYXRjaCB7IC8qIGJlc3QtZWZmb3J0ICovIH1cbiAgICB9XG4gIH0pO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTG9jayBBY3F1aXNpdGlvbiBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENyZWF0ZSB0aGUgb25Db21wcm9taXNlZCBjYWxsYmFjayBmb3IgcHJvcGVyLWxvY2tmaWxlLlxuICpcbiAqIHByb3Blci1sb2NrZmlsZSBmaXJlcyBvbkNvbXByb21pc2VkIHdoZW4gaXQgZGV0ZWN0cyBtdGltZSBkcmlmdCAoc3lzdGVtIHNsZWVwLFxuICogZXZlbnQgbG9vcCBzdGFsbCwgZXRjLikuIFRoZSBkZWZhdWx0IGhhbmRsZXIgdGhyb3dzIGluc2lkZSBzZXRUaW1lb3V0IFx1MjAxNCBhblxuICogdW5jYXVnaHQgZXhjZXB0aW9uIHRoYXQgY3Jhc2hlcyBvciBjb3JydXB0cyBwcm9jZXNzIHN0YXRlLlxuICpcbiAqIEZhbHNlLXBvc2l0aXZlIHN1cHByZXNzaW9uICgjMTM2Mik6IElmIHdlJ3JlIHN0aWxsIHdpdGhpbiB0aGUgc3RhbGUgd2luZG93XG4gKiAoMzAgbWluIHNpbmNlIGFjcXVpc2l0aW9uKSwgdGhlIG10aW1lIG1pc21hdGNoIGlzIGZyb20gYW4gZXZlbnQgbG9vcCBzdGFsbFxuICogZHVyaW5nIGEgbG9uZyBMTE0gY2FsbCBcdTIwMTQgbm90IGEgcmVhbCB0YWtlb3Zlci4gTG9nIGFuZCBjb250aW51ZS5cbiAqXG4gKiBQSUQgb3duZXJzaGlwIGNoZWNrICgjMTU3OCk6IFBhc3QgdGhlIHN0YWxlIHdpbmRvdywgY2hlY2sgaWYgdGhlIGxvY2sgZmlsZVxuICogc3RpbGwgY29udGFpbnMgb3VyIFBJRCBiZWZvcmUgZGVjbGFyaW5nIGNvbXByb21pc2UuIFJldHJ5IHJlYWRzIHRvbGVyYXRlXG4gKiB0cmFuc2llbnQgZmlsZXN5c3RlbSBoaWNjdXBzIChORlMvQ0lGUyBsYXRlbmN5LCBBUEZTIHNuYXBzaG90cywgZXRjLikgKCMyMzI0KS5cbiAqL1xuZnVuY3Rpb24gY3JlYXRlTG9ja0NvbXByb21pc2VkSGFuZGxlcihsb2NrRmlsZVBhdGg6IHN0cmluZyk6ICgpID0+IHZvaWQge1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGNvbnN0IGVsYXBzZWQgPSBEYXRlLm5vdygpIC0gX2xvY2tBY3F1aXJlZEF0O1xuICAgIGlmIChlbGFwc2VkIDwgMV84MDBfMDAwKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYFtnc2RdIExvY2sgaGVhcnRiZWF0IGNhdWdodCB1cCBhZnRlciAke01hdGgucm91bmQoZWxhcHNlZCAvIDEwMDApfXMgXHUyMDE0IGxvbmcgTExNIGNhbGwsIG5vIGFjdGlvbiBuZWVkZWQuXFxuYCxcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnkobG9ja0ZpbGVQYXRoKTtcbiAgICBpZiAoZXhpc3RpbmcgJiYgZXhpc3RpbmcucGlkID09PSBwcm9jZXNzLnBpZCkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGBbZ3NkXSBMb2NrIGhlYXJ0YmVhdCBtaXNtYXRjaCBhZnRlciAke01hdGgucm91bmQoZWxhcHNlZCAvIDEwMDApfXMgXHUyMDE0IGxvY2sgZmlsZSBzdGlsbCBvd25lZCBieSBQSUQgJHtwcm9jZXNzLnBpZH0sIHRyZWF0aW5nIGFzIGZhbHNlIHBvc2l0aXZlLlxcbmAsXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBfbG9ja0NvbXByb21pc2VkID0gdHJ1ZTtcbiAgICBfcmVsZWFzZUZ1bmN0aW9uID0gbnVsbDtcbiAgfTtcbn1cblxuLyoqXG4gKiBBc3NpZ24gbW9kdWxlLWxldmVsIGxvY2sgc3RhdGUgYWZ0ZXIgYSBzdWNjZXNzZnVsIGxvY2sgYWNxdWlzaXRpb24uXG4gKi9cbmZ1bmN0aW9uIGFzc2lnbkxvY2tTdGF0ZShiYXNlUGF0aDogc3RyaW5nLCByZWxlYXNlOiAoKSA9PiB2b2lkLCBsb2NrRmlsZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBfcmVsZWFzZUZ1bmN0aW9uID0gcmVsZWFzZTtcbiAgX2xvY2tlZFBhdGggPSBiYXNlUGF0aDtcbiAgX2xvY2tQaWQgPSBwcm9jZXNzLnBpZDtcbiAgX2xvY2tDb21wcm9taXNlZCA9IGZhbHNlO1xuICBfbG9ja0FjcXVpcmVkQXQgPSBEYXRlLm5vdygpO1xuICBfc25hcHNob3RMb2NrUGF0aCA9IGxvY2tGaWxlUGF0aDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFB1YmxpYyBBUEkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQXR0ZW1wdCB0byBhY3F1aXJlIGFuIGV4Y2x1c2l2ZSBzZXNzaW9uIGxvY2sgZm9yIHRoZSBnaXZlbiBwcm9qZWN0LlxuICpcbiAqIFRoaXMgdXNlcyBwcm9wZXItbG9ja2ZpbGUgZm9yIE9TLWxldmVsIGZpbGUgbG9ja2luZy4gSWYgYW5vdGhlciBwcm9jZXNzXG4gKiBhbHJlYWR5IGhvbGRzIHRoZSBsb2NrLCB0aGlzIHJldHVybnMgeyBhY3F1aXJlZDogZmFsc2UgfSB3aXRoIGRldGFpbHMuXG4gKlxuICogVGhlIGxvY2sgZmlsZSBhbHNvIGNvbnRhaW5zIEpTT04gbWV0YWRhdGEgYWJvdXQgdGhlIHNlc3Npb24gZm9yXG4gKiBkaWFnbm9zdGljIHB1cnBvc2VzIChQSUQsIHVuaXQgaW5mbywgZXRjLikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhY3F1aXJlU2Vzc2lvbkxvY2soYmFzZVBhdGg6IHN0cmluZyk6IFNlc3Npb25Mb2NrUmVzdWx0IHtcbiAgY29uc3QgbHAgPSBsb2NrUGF0aChiYXNlUGF0aCk7XG5cbiAgLy8gUmUtZW50cmFudCBhY3F1aXJlIG9uIHRoZSBzYW1lIHBhdGg6IHJlbGVhc2Ugb3VyIGN1cnJlbnQgT1MgbG9jayBmaXJzdCBzb1xuICAvLyBwcm9wZXItbG9ja2ZpbGUgY2xlYXJzIGl0cyB1cGRhdGUgdGltZXIgYmVmb3JlIHdlIGFjcXVpcmUgYSBmcmVzaCBsb2NrLlxuICBpZiAoX3JlbGVhc2VGdW5jdGlvbiAmJiBfbG9ja2VkUGF0aCA9PT0gYmFzZVBhdGgpIHtcbiAgICB0cnkgeyBfcmVsZWFzZUZ1bmN0aW9uKCk7IH0gY2F0Y2ggeyAvKiBtYXkgYWxyZWFkeSBiZSByZWxlYXNlZCAqLyB9XG4gICAgX3JlbGVhc2VGdW5jdGlvbiA9IG51bGw7XG4gICAgX2xvY2tlZFBhdGggPSBudWxsO1xuICAgIF9sb2NrUGlkID0gMDtcbiAgICBfbG9ja0NvbXByb21pc2VkID0gZmFsc2U7XG4gIH1cblxuICAvLyBFbnN1cmUgdGhlIGRpcmVjdG9yeSBleGlzdHNcbiAgbWtkaXJTeW5jKGRpcm5hbWUobHApLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBDbGVhbiB1cCBudW1iZXJlZCBsb2NrIGZpbGUgdmFyaWFudHMgZnJvbSBjbG91ZCBzeW5jIGNvbmZsaWN0cyAoIzEzMTUpXG4gIGNsZWFudXBTdHJheUxvY2tGaWxlcyhiYXNlUGF0aCk7XG5cbiAgLy8gV3JpdGUgb3VyIGxvY2sgZGF0YSBmaXJzdCAodGhlIGNvbnRlbnQgaXMgaW5mb3JtYXRpb25hbDsgdGhlIE9TIGxvY2sgaXMgdGhlIHJlYWwgZ3VhcmQpXG4gIGNvbnN0IGxvY2tEYXRhOiBTZXNzaW9uTG9ja0RhdGEgPSB7XG4gICAgcGlkOiBwcm9jZXNzLnBpZCxcbiAgICBzdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICB1bml0VHlwZTogXCJzdGFydGluZ1wiLFxuICAgIHVuaXRJZDogXCJib290c3RyYXBcIixcbiAgICB1bml0U3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gIH07XG5cbiAgbGV0IGxvY2tmaWxlOiBQcm9wZXJMb2NrZmlsZUFwaTtcbiAgdHJ5IHtcbiAgICBsb2NrZmlsZSA9IF9yZXF1aXJlKFwicHJvcGVyLWxvY2tmaWxlXCIpIGFzIFByb3BlckxvY2tmaWxlQXBpO1xuICB9IGNhdGNoIHtcbiAgICAvLyBwcm9wZXItbG9ja2ZpbGUgbm90IGF2YWlsYWJsZSBcdTIwMTQgZmFsbCBiYWNrIHRvIFBJRC1iYXNlZCBjaGVja1xuICAgIHJldHVybiBhY3F1aXJlRmFsbGJhY2tMb2NrKGJhc2VQYXRoLCBscCwgbG9ja0RhdGEpO1xuICB9XG5cbiAgY29uc3QgZ3NkRGlyID0gZ3NkUm9vdChiYXNlUGF0aCk7XG4gIGNvbnN0IGxvY2tUYXJnZXQgPSBlZmZlY3RpdmVMb2NrVGFyZ2V0KGdzZERpcik7XG5cbiAgLy8gIzMyMTg6IFByZS1mbGlnaHQgc3RhbGUgbG9jayBjbGVhbnVwIFx1MjAxNCBpZiB0aGUgLmxvY2svIGRpcmVjdG9yeSBleGlzdHMgYnV0XG4gIC8vIG5vIGF1dG8ubG9jayBtZXRhZGF0YSBpcyBwcmVzZW50IChvciB0aGUgUElEIGlzIGRlYWQpLCByZW1vdmUgdGhlIGxvY2tcbiAgLy8gZGlyZWN0b3J5IGJlZm9yZSBhdHRlbXB0aW5nIGFjcXVpc2l0aW9uLiBUaGlzIHByZXZlbnRzIHRoZSAzMC1taW4gc3RhbGVcbiAgLy8gd2luZG93IGZyb20gYmxvY2tpbmcgL2dzZCBhZnRlciBjcmFzaGVzLCBTSUdLSUxMLCBvciBsYXB0b3Agc2xlZXAuXG4gIGNvbnN0IGxvY2tEaXIgPSBsb2NrVGFyZ2V0ICsgXCIubG9ja1wiO1xuICBpZiAoZXhpc3RzU3luYyhsb2NrRGlyKSkge1xuICAgIGNvbnN0IGV4aXN0aW5nRGF0YSA9IHJlYWRFeGlzdGluZ0xvY2tEYXRhKGxwKTtcbiAgICBjb25zdCBpc09ycGhhbiA9ICFleGlzdGluZ0RhdGEgfHwgKGV4aXN0aW5nRGF0YS5waWQgJiYgIWlzUGlkQWxpdmUoZXhpc3RpbmdEYXRhLnBpZCkpO1xuICAgIGlmIChpc09ycGhhbikge1xuICAgICAgdHJ5IHsgcm1TeW5jKGxvY2tEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTsgfSBjYXRjaCB7IC8qIGJlc3QtZWZmb3J0ICovIH1cbiAgICAgIHRyeSB7IGlmIChleGlzdHNTeW5jKGxwKSkgdW5saW5rU3luYyhscCk7IH0gY2F0Y2ggeyAvKiBiZXN0LWVmZm9ydCAqLyB9XG4gICAgfVxuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBUcnkgdG8gYWNxdWlyZSBhbiBleGNsdXNpdmUgT1MtbGV2ZWwgbG9jayBvbiB0aGUgbG9jayB0YXJnZXQuXG4gICAgLy8gV2UgbG9jayBhIGRpcmVjdG9yeSBzaW5jZSBwcm9wZXItbG9ja2ZpbGUgd29ya3MgYmVzdCBvbiBkaXJlY3RvcmllcyxcbiAgICAvLyBhbmQgdGhlIGxvY2sgZmlsZSBpdHNlbGYgbWF5IG5vdCBleGlzdCB5ZXQuXG4gICAgLy8gSW4gcGFyYWxsZWwgd29ya2VyIG1vZGUsIGxvY2tUYXJnZXQgaXMgLmdzZC9wYXJhbGxlbC88TUlEPi8gKCMyMTg0KS5cbiAgICBta2RpclN5bmMobG9ja1RhcmdldCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgICBjb25zdCByZWxlYXNlID0gbG9ja2ZpbGUubG9ja1N5bmMobG9ja1RhcmdldCwge1xuICAgICAgcmVhbHBhdGg6IGZhbHNlLFxuICAgICAgc3RhbGU6IDFfODAwXzAwMCwgLy8gMzAgbWludXRlcyBcdTIwMTQgc2FmZSBmb3IgbGFwdG9wIHNsZWVwIC8gbG9uZyBldmVudCBsb29wIHN0YWxsc1xuICAgICAgdXBkYXRlOiAxMF8wMDAsIC8vIFVwZGF0ZSBsb2NrIG10aW1lIGV2ZXJ5IDEwcyB0byBwcm92ZSBsaXZlbmVzc1xuICAgICAgb25Db21wcm9taXNlZDogY3JlYXRlTG9ja0NvbXByb21pc2VkSGFuZGxlcihscCksXG4gICAgfSk7XG5cbiAgICBhc3NpZ25Mb2NrU3RhdGUoYmFzZVBhdGgsIHJlbGVhc2UsIGxwKTtcblxuICAgIC8vIFNhZmV0eSBuZXQ6IGNsZWFuIHVwIGxvY2sgZGlyIG9uIHByb2Nlc3MgZXhpdCBpZiBfcmVsZWFzZUZ1bmN0aW9uXG4gICAgLy8gd2Fzbid0IGNhbGxlZCAoZS5nLiwgbm9ybWFsIGV4aXQgYWZ0ZXIgY2xlYW4gY29tcGxldGlvbikgKCMxMjQ1KS5cbiAgICBlbnN1cmVFeGl0SGFuZGxlcihsb2NrVGFyZ2V0KTtcblxuICAgIC8vIFdyaXRlIHRoZSBpbmZvcm1hdGlvbmFsIGxvY2sgZGF0YVxuICAgIGF0b21pY1dyaXRlU3luYyhscCwgSlNPTi5zdHJpbmdpZnkobG9ja0RhdGEsIG51bGwsIDIpKTtcblxuICAgIHJldHVybiB7IGFjcXVpcmVkOiB0cnVlIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIExvY2sgaXMgaGVsZCBieSBhbm90aGVyIHByb2Nlc3MgXHUyMDE0IG9yIHRoZSAuZ3NkLmxvY2svIGRpcmVjdG9yeSBpcyBzdHJhbmRlZC5cbiAgICAvLyBDaGVjazogaWYgYXV0by5sb2NrIGlzIGdvbmUgYW5kIG5vIHByb2Nlc3MgaXMgYWxpdmUsIHRoZSBsb2NrIGRpciBpcyBzdGFsZS5cbiAgICBjb25zdCBleGlzdGluZ0RhdGEgPSByZWFkRXhpc3RpbmdMb2NrRGF0YShscCk7XG4gICAgY29uc3QgZXhpc3RpbmdQaWQgPSBleGlzdGluZ0RhdGE/LnBpZDtcblxuICAgIC8vIElmIG5vIGxvY2sgZmlsZSBvciBubyBhbGl2ZSBwcm9jZXNzLCB0cnkgdG8gY2xlYW4gdXAgYW5kIHJlLWFjcXVpcmUgKCMxMjQ1KVxuICAgIGlmICghZXhpc3RpbmdEYXRhIHx8IChleGlzdGluZ1BpZCAmJiAhaXNQaWRBbGl2ZShleGlzdGluZ1BpZCkpKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBsb2NrRGlyID0gam9pbihsb2NrVGFyZ2V0ICsgXCIubG9ja1wiKTtcbiAgICAgICAgaWYgKGV4aXN0c1N5bmMobG9ja0RpcikpIHJtU3luYyhsb2NrRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICAgIGlmIChleGlzdHNTeW5jKGxwKSkgdW5saW5rU3luYyhscCk7XG5cbiAgICAgICAgLy8gUmV0cnkgYWNxdWlzaXRpb24gYWZ0ZXIgY2xlYW51cFxuICAgICAgICBjb25zdCByZWxlYXNlID0gbG9ja2ZpbGUubG9ja1N5bmMobG9ja1RhcmdldCwge1xuICAgICAgICAgIHJlYWxwYXRoOiBmYWxzZSxcbiAgICAgICAgICBzdGFsZTogMV84MDBfMDAwLCAvLyAzMCBtaW51dGVzIFx1MjAxNCBtYXRjaCBwcmltYXJ5IGxvY2sgc2V0dGluZ3NcbiAgICAgICAgICB1cGRhdGU6IDEwXzAwMCxcbiAgICAgICAgICBvbkNvbXByb21pc2VkOiBjcmVhdGVMb2NrQ29tcHJvbWlzZWRIYW5kbGVyKGxwKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGFzc2lnbkxvY2tTdGF0ZShiYXNlUGF0aCwgcmVsZWFzZSwgbHApO1xuXG4gICAgICAgIC8vIFNhZmV0eSBuZXQgXHUyMDE0IHVzZXMgY2VudHJhbGl6ZWQgaGFuZGxlciB0byBhdm9pZCBkb3VibGUtcmVnaXN0cmF0aW9uXG4gICAgICAgIGVuc3VyZUV4aXRIYW5kbGVyKGxvY2tUYXJnZXQpO1xuXG4gICAgICAgIGF0b21pY1dyaXRlU3luYyhscCwgSlNPTi5zdHJpbmdpZnkobG9ja0RhdGEsIG51bGwsIDIpKTtcbiAgICAgICAgcmV0dXJuIHsgYWNxdWlyZWQ6IHRydWUgfTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBSZXRyeSBhbHNvIGZhaWxlZCBcdTIwMTQgZmFsbCB0aHJvdWdoIHRvIHRoZSBlcnJvciBwYXRoXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gIzMyMTg6IFByb3ZpZGUgYWN0aW9uYWJsZSB3b3JrYXJvdW5kIHdoZW4gbG9jayByZWNvdmVyeSBmYWlsc1xuICAgIGNvbnN0IGxvY2tEaXJQYXRoID0gbG9ja1RhcmdldCArIFwiLmxvY2tcIjtcbiAgICBjb25zdCByZWFzb24gPSBleGlzdGluZ1BpZFxuICAgICAgPyBgQW5vdGhlciBhdXRvLW1vZGUgc2Vzc2lvbiAoUElEICR7ZXhpc3RpbmdQaWR9KSBhcHBlYXJzIHRvIGJlIHJ1bm5pbmcuXFxuU3RvcCBpdCB3aXRoIFxcYGtpbGwgJHtleGlzdGluZ1BpZH1cXGAgYmVmb3JlIHN0YXJ0aW5nIGEgbmV3IHNlc3Npb24uYFxuICAgICAgOiBgQW5vdGhlciBhdXRvLW1vZGUgc2Vzc2lvbiBsb2NrIGlzIHN0dWNrIG9uIHRoaXMgcHJvamVjdC5cXG5SdW46IHJtIC1yZiBcIiR7bG9ja0RpclBhdGh9XCIgJiYgcm0gLWYgXCIke2xwfVwiYDtcblxuICAgIHJldHVybiB7IGFjcXVpcmVkOiBmYWxzZSwgcmVhc29uLCBleGlzdGluZ1BpZCB9O1xuICB9XG59XG5cbi8qKlxuICogRmFsbGJhY2sgbG9jayBhY3F1aXNpdGlvbiB3aGVuIHByb3Blci1sb2NrZmlsZSBpcyBub3QgYXZhaWxhYmxlLlxuICogVXNlcyBQSUQtYmFzZWQgbGl2ZW5lc3MgY2hlY2tpbmcgKHRoZSBvbGQgYXBwcm9hY2gsIGJ1dCB3aXRoIHRoZSBsb2NrXG4gKiB3cml0dGVuIEJFRk9SRSBpbml0aWFsaXphdGlvbiByYXRoZXIgdGhhbiBhZnRlcikuXG4gKi9cbmZ1bmN0aW9uIGFjcXVpcmVGYWxsYmFja0xvY2soXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGxwOiBzdHJpbmcsXG4gIGxvY2tEYXRhOiBTZXNzaW9uTG9ja0RhdGEsXG4pOiBTZXNzaW9uTG9ja1Jlc3VsdCB7XG4gIC8vIENoZWNrIGlmIGFuIGV4aXN0aW5nIGxvY2sgaXMgaGVsZCBieSBhIGxpdmUgcHJvY2Vzc1xuICBjb25zdCBleGlzdGluZyA9IHJlYWRFeGlzdGluZ0xvY2tEYXRhKGxwKTtcbiAgaWYgKGV4aXN0aW5nICYmIGV4aXN0aW5nLnBpZCAhPT0gcHJvY2Vzcy5waWQpIHtcbiAgICBpZiAoaXNQaWRBbGl2ZShleGlzdGluZy5waWQpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3F1aXJlZDogZmFsc2UsXG4gICAgICAgIHJlYXNvbjogYEFub3RoZXIgYXV0by1tb2RlIHNlc3Npb24gKFBJRCAke2V4aXN0aW5nLnBpZH0pIGlzIGFscmVhZHkgcnVubmluZyBvbiB0aGlzIHByb2plY3QuYCxcbiAgICAgICAgZXhpc3RpbmdQaWQ6IGV4aXN0aW5nLnBpZCxcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIFN0YWxlIGxvY2sgZnJvbSBkZWFkIHByb2Nlc3MgXHUyMDE0IHdlIGNhbiB0YWtlIG92ZXJcbiAgfVxuXG4gIC8vIFdyaXRlIG91ciBsb2NrIGRhdGFcbiAgYXRvbWljV3JpdGVTeW5jKGxwLCBKU09OLnN0cmluZ2lmeShsb2NrRGF0YSwgbnVsbCwgMikpO1xuICBfbG9ja2VkUGF0aCA9IGJhc2VQYXRoO1xuICBfbG9ja1BpZCA9IHByb2Nlc3MucGlkO1xuXG4gIHJldHVybiB7IGFjcXVpcmVkOiB0cnVlIH07XG59XG5cbi8qKlxuICogVXBkYXRlIHRoZSBsb2NrIGZpbGUgbWV0YWRhdGEgKGNhbGxlZCBvbiBlYWNoIHVuaXQgZGlzcGF0Y2gpLlxuICogRG9lcyBOT1QgcmUtYWNxdWlyZSB0aGUgT1MgbG9jayBcdTIwMTQganVzdCB1cGRhdGVzIHRoZSBKU09OIGNvbnRlbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZXNzaW9uTG9jayhcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4gIHNlc3Npb25GaWxlPzogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGlmIChfbG9ja2VkUGF0aCAhPT0gYmFzZVBhdGggJiYgX2xvY2tlZFBhdGggIT09IG51bGwpIHJldHVybjtcblxuICBjb25zdCBscCA9IGxvY2tQYXRoKGJhc2VQYXRoKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBkYXRhOiBTZXNzaW9uTG9ja0RhdGEgPSB7XG4gICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgc3RhcnRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICB1bml0VHlwZSxcbiAgICAgIHVuaXRJZCxcbiAgICAgIHVuaXRTdGFydGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIHNlc3Npb25GaWxlLFxuICAgIH07XG4gICAgYXRvbWljV3JpdGVTeW5jKGxwLCBKU09OLnN0cmluZ2lmeShkYXRhLCBudWxsLCAyKSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbDogbG9jayB1cGRhdGUgZmFpbHVyZVxuICB9XG59XG5cbi8qKlxuICogVmFsaWRhdGUgdGhhdCB3ZSBzdGlsbCBvd24gdGhlIHNlc3Npb24gbG9jay5cbiAqXG4gKiBSZXR1cm5zIHRydWUgaWYgd2Ugc3RpbGwgaG9sZCB0aGUgbG9jaywgZmFsc2UgaWYgYW5vdGhlciBwcm9jZXNzXG4gKiBoYXMgdGFrZW4gb3ZlciAoaW5kaWNhdGluZyB3ZSBzaG91bGQgZ3JhY2VmdWxseSBzdG9wKS5cbiAqXG4gKiBUaGlzIGlzIGNhbGxlZCBwZXJpb2RpY2FsbHkgZHVyaW5nIHRoZSBkaXNwYXRjaCBsb29wLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2Vzc2lvbkxvY2tTdGF0dXMoYmFzZVBhdGg6IHN0cmluZyk6IFNlc3Npb25Mb2NrU3RhdHVzIHtcbiAgLy8gTG9jayB3YXMgY29tcHJvbWlzZWQgYnkgcHJvcGVyLWxvY2tmaWxlIChtdGltZSBkcmlmdCBmcm9tIHNsZWVwLCBzdGFsbCwgZXRjLilcbiAgaWYgKF9sb2NrQ29tcHJvbWlzZWQpIHtcbiAgICAvLyBSZWNvdmVyeSBnYXRlICgjMTUxMik6IEJlZm9yZSBkZWNsYXJpbmcgdGhlIGxvY2sgbG9zdCwgY2hlY2sgaWYgdGhlIGxvY2tcbiAgICAvLyBmaWxlIHN0aWxsIGNvbnRhaW5zIG91ciBQSUQuIElmIGl0IGRvZXMsIG5vIG90aGVyIHByb2Nlc3MgdG9vayBvdmVyIFx1MjAxNCB0aGVcbiAgICAvLyBvbkNvbXByb21pc2VkIGZpcmVkIGZyb20gYmVuaWduIG10aW1lIGRyaWZ0IChsYXB0b3Agc2xlZXAsIGV2ZW50IGxvb3Agc3RhbGxcbiAgICAvLyBiZXlvbmQgdGhlIHN0YWxlIHdpbmRvdykuIEF0dGVtcHQgcmUtYWNxdWlzaXRpb24gaW5zdGVhZCBvZiBnaXZpbmcgdXAuXG4gICAgY29uc3QgbHAgPSBsb2NrUGF0aChiYXNlUGF0aCk7XG4gICAgLy8gUmV0cnkgcmVhZHMgdG8gdG9sZXJhdGUgdHJhbnNpZW50IGZpbGVzeXN0ZW0gaGljY3VwcyAoIzIzMjQpLlxuICAgIGNvbnN0IGV4aXN0aW5nID0gcmVhZEV4aXN0aW5nTG9ja0RhdGFXaXRoUmV0cnkobHApO1xuICAgIGlmIChleGlzdGluZyAmJiBleGlzdGluZy5waWQgPT09IHByb2Nlc3MucGlkKSB7XG4gICAgICAvLyBMb2NrIGZpbGUgc3RpbGwgb3VycyBcdTIwMTQgdHJ5IHRvIHJlLWFjcXVpcmUgdGhlIE9TIGxvY2tcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGFjcXVpcmVTZXNzaW9uTG9jayhiYXNlUGF0aCk7XG4gICAgICAgIGlmIChyZXN1bHQuYWNxdWlyZWQpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGBbZ3NkXSBMb2NrIHJlY292ZXJlZCBhZnRlciBvbkNvbXByb21pc2VkIFx1MjAxNCBsb2NrIGZpbGUgUElEIG1hdGNoZWQsIHJlLWFjcXVpcmVkLlxcbmAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4geyB2YWxpZDogdHJ1ZSwgcmVjb3ZlcmVkOiB0cnVlIH07XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBSZS1hY3F1aXNpdGlvbiBmYWlsZWQgXHUyMDE0IGZhbGwgdGhyb3VnaCB0byByZXR1cm4gZmFsc2VcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHZhbGlkOiBmYWxzZSxcbiAgICAgIGZhaWx1cmVSZWFzb246IFwiY29tcHJvbWlzZWRcIixcbiAgICAgIGV4aXN0aW5nUGlkOiBleGlzdGluZz8ucGlkLFxuICAgICAgZXhwZWN0ZWRQaWQ6IHByb2Nlc3MucGlkLFxuICAgIH07XG4gIH1cblxuICAvLyBJZiB3ZSBoYXZlIGFuIE9TLWxldmVsIGxvY2ssIHdlJ3JlIHN0aWxsIHRoZSBvd25lclxuICBpZiAoX3JlbGVhc2VGdW5jdGlvbiAmJiBfbG9ja2VkUGF0aCA9PT0gYmFzZVBhdGgpIHtcbiAgICByZXR1cm4geyB2YWxpZDogdHJ1ZSB9O1xuICB9XG5cbiAgLy8gRmFsbGJhY2s6IGNoZWNrIHRoZSBsb2NrIGZpbGUgUElEXG4gIGNvbnN0IGxwID0gbG9ja1BhdGgoYmFzZVBhdGgpO1xuICBjb25zdCBleGlzdGluZyA9IHJlYWRFeGlzdGluZ0xvY2tEYXRhKGxwKTtcbiAgaWYgKCFleGlzdGluZykge1xuICAgIC8vIExvY2sgZmlsZSB3YXMgZGVsZXRlZCBcdTIwMTQgd2UgbG9zdCBvd25lcnNoaXBcbiAgICByZXR1cm4ge1xuICAgICAgdmFsaWQ6IGZhbHNlLFxuICAgICAgZmFpbHVyZVJlYXNvbjogXCJtaXNzaW5nLW1ldGFkYXRhXCIsXG4gICAgICBleHBlY3RlZFBpZDogcHJvY2Vzcy5waWQsXG4gICAgfTtcbiAgfVxuXG4gIGlmIChleGlzdGluZy5waWQgIT09IHByb2Nlc3MucGlkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHZhbGlkOiBmYWxzZSxcbiAgICAgIGZhaWx1cmVSZWFzb246IFwicGlkLW1pc21hdGNoXCIsXG4gICAgICBleGlzdGluZ1BpZDogZXhpc3RpbmcucGlkLFxuICAgICAgZXhwZWN0ZWRQaWQ6IHByb2Nlc3MucGlkLFxuICAgIH07XG4gIH1cblxuICByZXR1cm4geyB2YWxpZDogdHJ1ZSB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVTZXNzaW9uTG9jayhiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBnZXRTZXNzaW9uTG9ja1N0YXR1cyhiYXNlUGF0aCkudmFsaWQ7XG59XG5cbi8qKlxuICogUmVsZWFzZSB0aGUgc2Vzc2lvbiBsb2NrLiBDYWxsZWQgb24gY2xlYW4gc3RvcC9wYXVzZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbGVhc2VTZXNzaW9uTG9jayhiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIC8vIFJlbGVhc2UgdGhlIE9TLWxldmVsIGxvY2tcbiAgaWYgKF9yZWxlYXNlRnVuY3Rpb24pIHtcbiAgICB0cnkge1xuICAgICAgX3JlbGVhc2VGdW5jdGlvbigpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gTG9jayBtYXkgYWxyZWFkeSBiZSByZWxlYXNlZFxuICAgIH1cbiAgICBfcmVsZWFzZUZ1bmN0aW9uID0gbnVsbDtcbiAgfVxuXG4gIC8vIFJlbW92ZSB0aGUgbG9jayBmaWxlIGF0IHRoZSBjdXJyZW50IHBhdGggb25seSBpZiBpdCBzdGlsbCBiZWxvbmdzIHRvIHVzLlxuICAvLyBMb3N0LWxvY2sgY2xlYW51cCBjYW4gcnVuIGFmdGVyIGFub3RoZXIgcHJvY2VzcyBoYXMgdGFrZW4gb3duZXJzaGlwOyBpblxuICAvLyB0aGF0IGNhc2UgZGVsZXRpbmcgYXV0by5sb2NrIHdvdWxkIGVyYXNlIHRoZSBuZXdlciBvd25lcidzIGV2aWRlbmNlLlxuICBjb25zdCBscCA9IGxvY2tQYXRoKGJhc2VQYXRoKTtcbiAgY29uc3Qgb3duc1ByaW1hcnlMb2NrID0gaXNMb2NrRmlsZU93bmVkQnlDdXJyZW50UHJvY2VzcyhscCk7XG4gIHRyeSB7XG4gICAgaWYgKG93bnNQcmltYXJ5TG9jayAmJiBleGlzdHNTeW5jKGxwKSkgdW5saW5rU3luYyhscCk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbFxuICB9XG5cbiAgLy8gUmVtb3ZlIHRoZSBwcm9wZXItbG9ja2ZpbGUgZGlyZWN0b3J5IGZvciB0aGUgY3VycmVudCBsb2NrIHRhcmdldC5cbiAgLy8gSW4gcGFyYWxsZWwgd29ya2VyIG1vZGUsIHRoaXMgaXMgLmdzZC9wYXJhbGxlbC88TUlEPi5sb2NrLyAoIzIxODQpLlxuICBjb25zdCBnc2REaXIgPSBnc2RSb290KGJhc2VQYXRoKTtcbiAgY29uc3QgbG9ja1RhcmdldCA9IGVmZmVjdGl2ZUxvY2tUYXJnZXQoZ3NkRGlyKTtcbiAgdHJ5IHtcbiAgICBjb25zdCBsb2NrRGlyID0gam9pbihsb2NrVGFyZ2V0ICsgXCIubG9ja1wiKTtcbiAgICBpZiAob3duc1ByaW1hcnlMb2NrICYmIGV4aXN0c1N5bmMobG9ja0RpcikpIHJtU3luYyhsb2NrRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbFxuICB9XG4gIC8vIEFsc28gY2xlYW4gdGhlIHBlci1taWxlc3RvbmUgcGFyYWxsZWwgZGlyZWN0b3J5IGl0c2VsZiBpZiBpdCBleGlzdHNcbiAgaWYgKG93bnNQcmltYXJ5TG9jayAmJiBsb2NrVGFyZ2V0ICE9PSBnc2REaXIpIHtcbiAgICB0cnkge1xuICAgICAgaWYgKGV4aXN0c1N5bmMobG9ja1RhcmdldCkpIHJtU3luYyhsb2NrVGFyZ2V0LCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBOb24tZmF0YWxcbiAgICB9XG4gIH1cblxuICAvLyBDbGVhbiBBTEwgcmVnaXN0ZXJlZCBsb2NrIHBhdGhzICgjMTU3OCkgXHUyMDE0IGxvY2sgZmlsZXMgYWNjdW11bGF0ZSBhY3Jvc3NcbiAgLy8gbWFpbiBwcm9qZWN0IC5nc2QvLCB3b3JrdHJlZSAuZ3NkLywgYW5kIHByb2plY3RzIHJlZ2lzdHJ5IHBhdGhzLlxuICBmb3IgKGNvbnN0IGRpciBvZiBfbG9ja0RpclJlZ2lzdHJ5KSB7XG4gICAgY29uc3QgbG9ja0ZpbGUgPSBqb2luKGRpciwgTE9DS19GSUxFKTtcbiAgICBjb25zdCBvd25zUmVnaXN0ZXJlZExvY2sgPSBpc0xvY2tGaWxlT3duZWRCeUN1cnJlbnRQcm9jZXNzKGxvY2tGaWxlKTtcbiAgICB0cnkge1xuICAgICAgaWYgKG93bnNSZWdpc3RlcmVkTG9jayAmJiBleGlzdHNTeW5jKGxvY2tGaWxlKSkgdW5saW5rU3luYyhsb2NrRmlsZSk7XG4gICAgfSBjYXRjaCB7IC8qIGJlc3QtZWZmb3J0ICovIH1cbiAgICB0cnkge1xuICAgICAgY29uc3QgbG9ja0RpciA9IGpvaW4oZGlyICsgXCIubG9ja1wiKTtcbiAgICAgIGlmIChvd25zUmVnaXN0ZXJlZExvY2sgJiYgZXhpc3RzU3luYyhsb2NrRGlyKSkgcm1TeW5jKGxvY2tEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHsgLyogYmVzdC1lZmZvcnQgKi8gfVxuICB9XG4gIF9sb2NrRGlyUmVnaXN0cnkuY2xlYXIoKTtcblxuICAvLyBDbGVhbiB1cCBudW1iZXJlZCBsb2NrIGZpbGUgdmFyaWFudHMgZnJvbSBjbG91ZCBzeW5jIGNvbmZsaWN0cyAoIzEzMTUpXG4gIGNsZWFudXBTdHJheUxvY2tGaWxlcyhiYXNlUGF0aCk7XG5cbiAgX2xvY2tlZFBhdGggPSBudWxsO1xuICBfbG9ja1BpZCA9IDA7XG4gIF9sb2NrQ29tcHJvbWlzZWQgPSBmYWxzZTtcbiAgX2xvY2tBY3F1aXJlZEF0ID0gMDtcbiAgX3NuYXBzaG90TG9ja1BhdGggPSBudWxsO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGEgc2Vzc2lvbiBsb2NrIGV4aXN0cyBhbmQgcmV0dXJuIGl0cyBkYXRhIChmb3IgY3Jhc2ggcmVjb3ZlcnkpLlxuICogRG9lcyBOT1QgYWNxdWlyZSB0aGUgbG9jay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRTZXNzaW9uTG9ja0RhdGEoYmFzZVBhdGg6IHN0cmluZyk6IFNlc3Npb25Mb2NrRGF0YSB8IG51bGwge1xuICByZXR1cm4gcmVhZEV4aXN0aW5nTG9ja0RhdGEobG9ja1BhdGgoYmFzZVBhdGgpKTtcbn1cblxuLyoqXG4gKiBDaGVjayBpZiB0aGUgcHJvY2VzcyB0aGF0IHdyb3RlIHRoZSBsb2NrIGlzIHN0aWxsIGFsaXZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTZXNzaW9uTG9ja1Byb2Nlc3NBbGl2ZShkYXRhOiBTZXNzaW9uTG9ja0RhdGEpOiBib29sZWFuIHtcbiAgcmV0dXJuIGlzUGlkQWxpdmUoZGF0YS5waWQpO1xufVxuXG4vKipcbiAqIEFEUi0wMTcgcmF3IHByaW1pdGl2ZTogcmVtb3ZlIG9ycGhhbmVkIGxvY2sgYXJ0aWZhY3RzIChsb2NrIGRpciArIGxvY2sgZmlsZSlcbiAqIHdoZW4gdGhlIHJlY29yZGVkIFBJRCBpcyBkZWFkIG9yIG5vIG1ldGFkYXRhIGlzIHByZXNlbnQuIE1pcnJvcnMgdGhlXG4gKiBwcmUtZmxpZ2h0IGNsZWFudXAgbG9naWMgaW4gYWNxdWlyZVNlc3Npb25Mb2NrIHNvIHRoZSBzdGFsZS13b3JrZXIgZHJpZnRcbiAqIGhhbmRsZXIgY2FuIGNsZWFyIHRoZSBvcnBoYW4gcHJvYWN0aXZlbHkgd2l0aG91dCBnb2luZyB0aHJvdWdoIHRoZSBmdWxsXG4gKiBhY3F1aXJlIHBhdGguIE5vLW9wIHdoZW4gdGhlIGxvY2sgaXMgaGVsZCBieSBhbiBhbGl2ZSBwcm9jZXNzLlxuICpcbiAqIFJldHVybnMgdHJ1ZSB3aGVuIGFydGlmYWN0cyB3ZXJlIHJlbW92ZWQgKGRyaWZ0IHdhcyBwcmVzZW50KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZVN0YWxlU2Vzc2lvbkxvY2soYmFzZVBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBscCA9IGxvY2tQYXRoKGJhc2VQYXRoKTtcbiAgY29uc3QgZ3NkRGlyID0gZ3NkUm9vdChiYXNlUGF0aCk7XG4gIGNvbnN0IGxvY2tUYXJnZXQgPSBlZmZlY3RpdmVMb2NrVGFyZ2V0KGdzZERpcik7XG4gIGNvbnN0IGxvY2tEaXIgPSBsb2NrVGFyZ2V0ICsgXCIubG9ja1wiO1xuXG4gIGNvbnN0IGV4aXN0aW5nRGF0YSA9IHJlYWRFeGlzdGluZ0xvY2tEYXRhKGxwKTtcbiAgY29uc3QgaXNPcnBoYW4gPVxuICAgICFleGlzdGluZ0RhdGEgfHxcbiAgICAodHlwZW9mIGV4aXN0aW5nRGF0YS5waWQgPT09IFwibnVtYmVyXCIgJiYgIWlzUGlkQWxpdmUoZXhpc3RpbmdEYXRhLnBpZCkpO1xuICBpZiAoIWlzT3JwaGFuKSByZXR1cm4gZmFsc2U7XG5cbiAgbGV0IHJlbW92ZWQgPSBmYWxzZTtcbiAgaWYgKGV4aXN0c1N5bmMobG9ja0RpcikpIHtcbiAgICB0cnkge1xuICAgICAgcm1TeW5jKGxvY2tEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIHJlbW92ZWQgPSB0cnVlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICB9XG4gIH1cbiAgaWYgKGV4aXN0c1N5bmMobHApKSB7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMobHApO1xuICAgICAgcmVtb3ZlZCA9IHRydWU7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVtb3ZlZDtcbn1cblxuLyoqXG4gKiBSZXR1cm5zIHRydWUgaWYgd2UgY3VycmVudGx5IGhvbGQgYSBzZXNzaW9uIGxvY2sgZm9yIHRoZSBnaXZlbiBwYXRoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTZXNzaW9uTG9ja0hlbGQoYmFzZVBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gX2xvY2tlZFBhdGggPT09IGJhc2VQYXRoICYmIF9sb2NrUGlkID09PSBwcm9jZXNzLnBpZDtcbn1cblxuLyoqXG4gKiBSZXR1cm5zIGEgc25hcHNob3Qgb2YgdGhlIHJlZ2lzdGVyZWQgbG9jayBkaXJlY3RvcnkgcGF0aHMgZm9yIGRpYWdub3N0aWNzLlxuICogRXhwb3J0ZWQgZm9yIHRlc3RzIG9ubHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfZ2V0UmVnaXN0ZXJlZExvY2tEaXJzKCk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFsuLi5fbG9ja0RpclJlZ2lzdHJ5XTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEludGVybmFsIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHJlYWRFeGlzdGluZ0xvY2tEYXRhKGxwOiBzdHJpbmcpOiBTZXNzaW9uTG9ja0RhdGEgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBpZiAoIWV4aXN0c1N5bmMobHApKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMobHAsIFwidXRmLThcIik7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uTG9ja0RhdGE7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGlzTG9ja0ZpbGVPd25lZEJ5Q3VycmVudFByb2Nlc3MobHA6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBleGlzdGluZyA9IHJlYWRFeGlzdGluZ0xvY2tEYXRhKGxwKTtcbiAgcmV0dXJuIGV4aXN0aW5nPy5waWQgPT09IHByb2Nlc3MucGlkO1xufVxuXG4vKipcbiAqIFJldHJ5LXRvbGVyYW50IHZhcmlhbnQgb2YgcmVhZEV4aXN0aW5nTG9ja0RhdGEgZm9yIHVzZSBpbiBvbkNvbXByb21pc2VkIGFuZFxuICogb3RoZXIgcGF0aHMgd2hlcmUgYSB0cmFuc2llbnQgZmlsZXN5c3RlbSBoaWNjdXAgKE5GUy9DSUZTIGxhdGVuY3ksIG1hY09TIEFQRlNcbiAqIHNuYXBzaG90LCBjb25jdXJyZW50IHByb2Nlc3MgYnJpZWZseSBob2xkaW5nIHRoZSBmaWxlKSBzaG91bGQgTk9UIGJlIHRyZWF0ZWRcbiAqIGFzIFwibG9jayBmaWxlIGdvbmVcIiAoIzIzMjQpLlxuICpcbiAqIFJldHJpZXMgdXAgdG8gYG1heEF0dGVtcHRzYCB0aW1lcyB3aXRoIGBkZWxheU1zYCBiZXR3ZWVuIGVhY2ggYXR0ZW1wdC5cbiAqIE9ubHkgcmV0dXJucyBudWxsIHdoZW4gQUxMIHJldHJpZXMgZmFpbCB0byByZWFkIHZhbGlkIGRhdGEuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUmV0cnlPcHRpb25zIHtcbiAgbWF4QXR0ZW1wdHM/OiBudW1iZXI7XG4gIGRlbGF5TXM/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWFkRXhpc3RpbmdMb2NrRGF0YVdpdGhSZXRyeShcbiAgbHA6IHN0cmluZyxcbiAgb3B0aW9ucz86IFJldHJ5T3B0aW9ucyxcbik6IFNlc3Npb25Mb2NrRGF0YSB8IG51bGwge1xuICBjb25zdCBtYXhBdHRlbXB0cyA9IG9wdGlvbnM/Lm1heEF0dGVtcHRzID8/IDM7XG4gIGNvbnN0IGRlbGF5TXMgPSBvcHRpb25zPy5kZWxheU1zID8/IDIwMDtcblxuICBmb3IgKGxldCBhdHRlbXB0ID0gMTsgYXR0ZW1wdCA8PSBtYXhBdHRlbXB0czsgYXR0ZW1wdCsrKSB7XG4gICAgY29uc3QgZGF0YSA9IHJlYWRFeGlzdGluZ0xvY2tEYXRhKGxwKTtcbiAgICBpZiAoZGF0YSAhPT0gbnVsbCkgcmV0dXJuIGRhdGE7XG4gICAgaWYgKGF0dGVtcHQgPCBtYXhBdHRlbXB0cykge1xuICAgICAgLy8gU3luY2hyb25vdXMgYnVzeS13YWl0IFx1MjAxNCBvbkNvbXByb21pc2VkIHJ1bnMgaW4gYSBzeW5jIGNhbGxiYWNrIGNvbnRleHRcbiAgICAgIC8vIGFuZCB0aGUgZGVsYXlzIGFyZSBzaG9ydCAoMjAwbXMgZGVmYXVsdCkuXG4gICAgICBjb25zdCBzdGFydCA9IERhdGUubm93KCk7XG4gICAgICB3aGlsZSAoRGF0ZS5ub3coKSAtIHN0YXJ0IDwgZGVsYXlNcykge1xuICAgICAgICAvLyBidXN5LXdhaXRcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzUGlkQWxpdmUocGlkOiBudW1iZXIpOiBib29sZWFuIHtcbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHBpZCkgfHwgcGlkIDw9IDApIHJldHVybiBmYWxzZTtcbiAgaWYgKHBpZCA9PT0gcHJvY2Vzcy5waWQpIHJldHVybiBmYWxzZTtcbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmtpbGwocGlkLCAwKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKChlcnIgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlID09PSBcIkVQRVJNXCIpIHJldHVybiB0cnVlO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBa0JBLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsWUFBWSxjQUFjLGFBQWEsV0FBVyxZQUFZLFFBQVEsZ0JBQWdCO0FBQy9GLFNBQVMsTUFBTSxlQUFlO0FBQzlCLFNBQVMsZUFBZTtBQUN4QixTQUFTLHVCQUF1QjtBQUVoQyxNQUFNLFdBQVcsY0FBYyxZQUFZLEdBQUc7QUE2QzlDLElBQUksbUJBQXdDO0FBRzVDLElBQUksY0FBNkI7QUFHakMsSUFBSSxXQUFtQjtBQUd2QixJ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
