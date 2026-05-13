import { readdirSync, existsSync, realpathSync, Dirent } from "node:fs";
import { join, dirname, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { nativeScanGsdTree } from "./native-parser-bridge.js";
import { DIR_CACHE_MAX } from "./constants.js";
import { gsdHome } from "./gsd-home.js";
import { isGsdWorktreePath, resolveWorktreeProjectRoot } from "./worktree-root.js";
const dirEntryCache = /* @__PURE__ */ new Map();
const dirListCache = /* @__PURE__ */ new Map();
let nativeTreeCache = null;
let nativeTreeBase = null;
function getNativeTree(gsdDir) {
  if (nativeTreeCache && nativeTreeBase === gsdDir) return nativeTreeCache;
  const entries = nativeScanGsdTree(gsdDir);
  if (!entries) return null;
  const tree = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    const parentPath = parts.slice(0, -1).join("/");
    const parentKey = parentPath || ".";
    if (!tree.has(parentKey)) tree.set(parentKey, []);
    tree.get(parentKey).push(entry);
  }
  nativeTreeCache = tree;
  nativeTreeBase = gsdDir;
  return tree;
}
function nativeTreeKey(dirPath, gsdDir) {
  if (!dirPath.startsWith(gsdDir)) return null;
  const rel = dirPath.slice(gsdDir.length).replace(/^\//, "");
  return rel || ".";
}
function cachedReaddirWithTypes(dirPath) {
  const cached = dirEntryCache.get(dirPath);
  if (cached) return cached;
  if (nativeTreeBase) {
    const key = nativeTreeKey(dirPath, nativeTreeBase);
    if (key && nativeTreeCache) {
      const treeEntries = nativeTreeCache.get(key);
      if (treeEntries) {
        const dirents = treeEntries.map((e) => {
          const d = Object.create(Dirent.prototype);
          Object.assign(d, {
            name: e.name,
            parentPath: dirPath,
            path: dirPath
          });
          const isDir = e.isDir;
          d.isDirectory = () => isDir;
          d.isFile = () => !isDir;
          d.isSymbolicLink = () => false;
          d.isBlockDevice = () => false;
          d.isCharacterDevice = () => false;
          d.isFIFO = () => false;
          d.isSocket = () => false;
          return d;
        });
        if (dirEntryCache.size >= DIR_CACHE_MAX) dirEntryCache.clear();
        dirEntryCache.set(dirPath, dirents);
        return dirents;
      }
    }
  }
  const entries = readdirSync(dirPath, { withFileTypes: true });
  if (dirEntryCache.size >= DIR_CACHE_MAX) dirEntryCache.clear();
  dirEntryCache.set(dirPath, entries);
  return entries;
}
function cachedReaddir(dirPath) {
  const cached = dirListCache.get(dirPath);
  if (cached) return cached;
  if (nativeTreeBase) {
    const key = nativeTreeKey(dirPath, nativeTreeBase);
    if (key && nativeTreeCache) {
      const treeEntries = nativeTreeCache.get(key);
      if (treeEntries) {
        const names = treeEntries.map((e) => e.name);
        if (dirListCache.size >= DIR_CACHE_MAX) dirListCache.clear();
        dirListCache.set(dirPath, names);
        return names;
      }
    }
  }
  const entries = readdirSync(dirPath);
  if (dirListCache.size >= DIR_CACHE_MAX) dirListCache.clear();
  dirListCache.set(dirPath, entries);
  return entries;
}
function clearPathCache() {
  dirEntryCache.clear();
  dirListCache.clear();
  nativeTreeCache = null;
  nativeTreeBase = null;
}
function buildMilestoneFileName(milestoneId, suffix) {
  return `${milestoneId}-${suffix}.md`;
}
function buildSliceFileName(sliceId, suffix) {
  return `${sliceId}-${suffix}.md`;
}
function buildTaskFileName(taskId, suffix) {
  return `${taskId}-${suffix}.md`;
}
function resolveDir(parentDir, idPrefix) {
  if (!existsSync(parentDir)) return null;
  try {
    const entries = cachedReaddirWithTypes(parentDir);
    const exact = entries.find((e) => e.isDirectory() && e.name === idPrefix);
    if (exact) return exact.name;
    const idLower = idPrefix.toLowerCase();
    const exactCaseInsensitive = entries.find(
      (e) => e.isDirectory() && e.name.toLowerCase() === idLower
    );
    if (exactCaseInsensitive) return exactCaseInsensitive.name;
    const prefixed = entries.find(
      (e) => e.isDirectory() && e.name.toLowerCase().startsWith(idLower + "-")
    );
    return prefixed ? prefixed.name : null;
  } catch {
    return null;
  }
}
function resolveFile(dir, idPrefix, suffix) {
  if (!existsSync(dir)) return null;
  const target = `${idPrefix}-${suffix}.md`.toUpperCase();
  try {
    const entries = cachedReaddir(dir);
    const direct = entries.find((e) => e.toUpperCase() === target);
    if (direct) return direct;
    const pattern = new RegExp(
      `^${idPrefix}-.*-${suffix}\\.md$`,
      "i"
    );
    const match = entries.find((e) => pattern.test(e));
    if (match) return match;
    const legacy = entries.find((e) => e.toLowerCase() === `${suffix.toLowerCase()}.md`);
    if (legacy) return legacy;
    return null;
  } catch {
    return null;
  }
}
function resolveTaskFiles(tasksDir, suffix) {
  if (!existsSync(tasksDir)) return [];
  try {
    const currentPattern = new RegExp(`^T\\d+-${suffix}\\.md$`, "i");
    const legacyPattern = new RegExp(`^T\\d+-.*-${suffix}\\.md$`, "i");
    return cachedReaddir(tasksDir).filter((f) => currentPattern.test(f) || legacyPattern.test(f)).sort();
  } catch {
    return [];
  }
}
function resolveTaskJsonFiles(tasksDir, suffix) {
  if (!existsSync(tasksDir)) return [];
  try {
    const currentPattern = new RegExp(`^T\\d+-${suffix}\\.json$`, "i");
    const legacyPattern = new RegExp(`^T\\d+-.*-${suffix}\\.json$`, "i");
    return cachedReaddir(tasksDir).filter((f) => currentPattern.test(f) || legacyPattern.test(f)).sort();
  } catch {
    return [];
  }
}
const GSD_ROOT_FILES = {
  PROJECT: "PROJECT.md",
  DECISIONS: "DECISIONS.md",
  QUEUE: "QUEUE.md",
  STATE: "STATE.md",
  REQUIREMENTS: "REQUIREMENTS.md",
  OVERRIDES: "OVERRIDES.md",
  KNOWLEDGE: "KNOWLEDGE.md",
  CODEBASE: "CODEBASE.md"
};
const LEGACY_GSD_ROOT_FILES = {
  PROJECT: "project.md",
  DECISIONS: "decisions.md",
  QUEUE: "queue.md",
  STATE: "state.md",
  REQUIREMENTS: "requirements.md",
  OVERRIDES: "overrides.md",
  KNOWLEDGE: "knowledge.md",
  CODEBASE: "codebase.md"
};
const gsdRootCache = /* @__PURE__ */ new Map();
function resolveGsdPathContract(workRoot, originalProjectRoot) {
  const resolvedWorkRoot = resolve(workRoot || process.cwd());
  const isWorktree = isGsdWorktreePath(resolvedWorkRoot);
  if (isWorktree && !originalProjectRoot?.trim()) {
    const externalMatch = /[/\\]\.gsd[/\\]projects[/\\][^/\\]+[/\\]worktrees(?:[/\\]|$)/.exec(resolvedWorkRoot);
    if (externalMatch) {
      const worktreesIdx = externalMatch[0].search(/[/\\]worktrees(?:[/\\]|$)/);
      const projectGsd2 = resolvedWorkRoot.slice(0, externalMatch.index + worktreesIdx);
      return {
        projectRoot: dirname(dirname(projectGsd2)),
        workRoot: resolvedWorkRoot,
        projectGsd: projectGsd2,
        worktreeGsd: join(resolvedWorkRoot, ".gsd"),
        projectDb: join(projectGsd2, "gsd.db"),
        isWorktree
      };
    }
  }
  const projectRoot = resolve(resolveWorktreeProjectRoot(resolvedWorkRoot, originalProjectRoot));
  const projectGsd = join(projectRoot, ".gsd");
  const worktreeGsd = isWorktree ? join(resolvedWorkRoot, ".gsd") : null;
  return {
    projectRoot,
    workRoot: resolvedWorkRoot,
    projectGsd,
    worktreeGsd,
    projectDb: join(projectGsd, "gsd.db"),
    isWorktree
  };
}
function _clearGsdRootCache() {
  gsdRootCache.clear();
}
function normalizeRealPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}
function normCacheKey(p) {
  const r = normalizeRealPath(p);
  const s = r.replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}
function gsdRoot(basePath) {
  const cacheKey = normCacheKey(basePath);
  const cached = gsdRootCache.get(cacheKey);
  if (cached) return cached;
  const result = normalizeRealPath(probeGsdRoot(basePath));
  assertNotGlobalGsdHome(basePath, result);
  gsdRootCache.set(cacheKey, result);
  return result;
}
function assertNotGlobalGsdHome(basePath, result) {
  const norm = (p) => {
    let r;
    try {
      r = realpathSync.native(p);
    } catch {
      r = p;
    }
    const s = r.replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  let baseNorm;
  let homeNorm;
  let resultNorm;
  let gsdHomeNorm;
  try {
    baseNorm = norm(basePath);
    homeNorm = norm(homedir());
    resultNorm = norm(result);
    gsdHomeNorm = norm(gsdHome());
  } catch {
    return;
  }
  if (baseNorm === homeNorm && resultNorm === gsdHomeNorm) {
    throw new Error(
      `Refusing to use ${result} as a project .gsd directory \u2014 that is the global GSD home. Run GSD from inside a project directory.`
    );
  }
}
function isInsideGsdWorktree(p) {
  const sepFwd = "/";
  const sepNative = "\\";
  const markers = [
    `${sepFwd}.gsd${sepFwd}worktrees${sepFwd}`,
    `${sepNative}.gsd${sepNative}worktrees${sepNative}`
  ];
  for (const marker of markers) {
    const idx = p.indexOf(marker);
    if (idx === -1) continue;
    const afterMarker = p.slice(idx + marker.length);
    const nameEnd = afterMarker.search(/[/\\]/);
    const name = nameEnd === -1 ? afterMarker : afterMarker.slice(0, nameEnd);
    if (name.length > 0) return true;
  }
  return false;
}
function probeGsdRoot(rawBasePath) {
  const contract = resolveGsdPathContract(rawBasePath);
  if (contract.isWorktree) return contract.projectGsd;
  const local = join(rawBasePath, ".gsd");
  if (existsSync(local)) return local;
  if (isInsideGsdWorktree(rawBasePath)) return local;
  let basePath;
  try {
    basePath = realpathSync.native(rawBasePath);
  } catch {
    basePath = rawBasePath;
  }
  if (basePath !== rawBasePath && isInsideGsdWorktree(basePath)) return local;
  let gitRoot = null;
  try {
    const out = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      encoding: "utf-8"
    });
    if (out.status === 0) {
      const r = out.stdout.trim();
      if (r) gitRoot = normalize(r);
    }
  } catch {
  }
  const normPath = (p) => {
    let r;
    try {
      r = realpathSync.native(p);
    } catch {
      r = p;
    }
    const s = r.replaceAll("\\", "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  let gsdHomeNorm;
  try {
    gsdHomeNorm = normPath(gsdHome());
  } catch {
    gsdHomeNorm = "";
  }
  if (gitRoot) {
    const candidate = join(gitRoot, ".gsd");
    if (existsSync(candidate) && normPath(candidate) !== gsdHomeNorm) return candidate;
  }
  if (gitRoot && basePath !== gitRoot) {
    let cur = dirname(basePath);
    while (cur !== basePath) {
      const candidate = join(cur, ".gsd");
      if (existsSync(candidate) && normPath(candidate) !== gsdHomeNorm) return candidate;
      if (cur === gitRoot) break;
      basePath = cur;
      cur = dirname(cur);
    }
  }
  return local;
}
function milestonesDir(basePath) {
  return join(gsdRoot(basePath), "milestones");
}
function resolveRuntimeFile(basePath) {
  return join(gsdRoot(basePath), "RUNTIME.md");
}
function resolveGsdRootFile(basePath, key) {
  const root = gsdRoot(basePath);
  const canonical = join(root, GSD_ROOT_FILES[key]);
  if (existsSync(canonical)) return canonical;
  const legacy = join(root, LEGACY_GSD_ROOT_FILES[key]);
  if (existsSync(legacy)) return legacy;
  return canonical;
}
function relGsdRootFile(key) {
  return `.gsd/${GSD_ROOT_FILES[key]}`;
}
function resolveMilestonePath(basePath, milestoneId) {
  const dir = resolveDir(milestonesDir(basePath), milestoneId);
  return dir ? join(milestonesDir(basePath), dir) : null;
}
function resolveMilestoneFile(basePath, milestoneId, suffix) {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir) return null;
  const file = resolveFile(mDir, milestoneId, suffix);
  return file ? join(mDir, file) : null;
}
function resolveSlicePath(basePath, milestoneId, sliceId) {
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (!mDir) return null;
  const slicesDir = join(mDir, "slices");
  const dir = resolveDir(slicesDir, sliceId);
  return dir ? join(slicesDir, dir) : null;
}
function resolveSliceFile(basePath, milestoneId, sliceId, suffix) {
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!sDir) return null;
  const file = resolveFile(sDir, sliceId, suffix);
  return file ? join(sDir, file) : null;
}
function resolveTasksDir(basePath, milestoneId, sliceId) {
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (!sDir) return null;
  const tDir = join(sDir, "tasks");
  return existsSync(tDir) ? tDir : null;
}
function resolveTaskFile(basePath, milestoneId, sliceId, taskId, suffix) {
  const tDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (!tDir) return null;
  const file = resolveFile(tDir, taskId, suffix);
  return file ? join(tDir, file) : null;
}
function relMilestonePath(basePath, milestoneId) {
  const dir = resolveDir(milestonesDir(basePath), milestoneId);
  if (dir) return `.gsd/milestones/${dir}`;
  return `.gsd/milestones/${milestoneId}`;
}
function relMilestoneFile(basePath, milestoneId, suffix) {
  const mRel = relMilestonePath(basePath, milestoneId);
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (mDir) {
    const file = resolveFile(mDir, milestoneId, suffix);
    if (file) return `${mRel}/${file}`;
  }
  return `${mRel}/${buildMilestoneFileName(milestoneId, suffix)}`;
}
function relSlicePath(basePath, milestoneId, sliceId) {
  const mRel = relMilestonePath(basePath, milestoneId);
  const mDir = resolveMilestonePath(basePath, milestoneId);
  if (mDir) {
    const slicesDir = join(mDir, "slices");
    const dir = resolveDir(slicesDir, sliceId);
    if (dir) return `${mRel}/slices/${dir}`;
  }
  return `${mRel}/slices/${sliceId}`;
}
function relSliceFile(basePath, milestoneId, sliceId, suffix) {
  const sRel = relSlicePath(basePath, milestoneId, sliceId);
  const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
  if (sDir) {
    const file = resolveFile(sDir, sliceId, suffix);
    if (file) return `${sRel}/${file}`;
  }
  return `${sRel}/${buildSliceFileName(sliceId, suffix)}`;
}
function relTaskFile(basePath, milestoneId, sliceId, taskId, suffix) {
  const sRel = relSlicePath(basePath, milestoneId, sliceId);
  const tDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (tDir) {
    const file = resolveFile(tDir, taskId, suffix);
    if (file) return `${sRel}/tasks/${file}`;
  }
  return `${sRel}/tasks/${buildTaskFileName(taskId, suffix)}`;
}
export {
  GSD_ROOT_FILES,
  _clearGsdRootCache,
  buildMilestoneFileName,
  buildSliceFileName,
  buildTaskFileName,
  clearPathCache,
  gsdRoot,
  milestonesDir,
  normalizeRealPath,
  relGsdRootFile,
  relMilestoneFile,
  relMilestonePath,
  relSliceFile,
  relSlicePath,
  relTaskFile,
  resolveDir,
  resolveFile,
  resolveGsdPathContract,
  resolveGsdRootFile,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveRuntimeFile,
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  resolveTaskFiles,
  resolveTaskJsonFiles,
  resolveTasksDir
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9wYXRocy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgXHUyMDE0IElELWJhc2VkIHBhdGggcmVzb2x1dGlvbiBmb3IgR1NEIHByb2plY3QgZmlsZXMgYW5kIGRpcmVjdG9yaWVzXG4vKipcbiAqIEdTRCBQYXRocyBcdTIwMTQgSUQtYmFzZWQgcGF0aCByZXNvbHV0aW9uXG4gKlxuICogRGlyZWN0b3JpZXMgdXNlIGJhcmUgSURzOiBNMDAxLywgUzAxLywgZXRjLlxuICogRmlsZXMgdXNlIElELVNVRkZJWDogTTAwMS1ST0FETUFQLm1kLCBTMDEtUExBTi5tZCwgVDAxLVBMQU4ubWRcbiAqXG4gKiBSZXNvbHZlcnMgc3RpbGwgaGFuZGxlIGxlZ2FjeSBkZXNjcmlwdG9yLXN1ZmZpeGVkIG5hbWVzXG4gKiAoZS5nLiBNMDAxLUZMSUdIVC1TSU1VTEFUT1IvLCBUMDMtSU5TVEFMTC1QQUNLQUdFUy1QTEFOLm1kKVxuICogdmlhIHByZWZpeCBtYXRjaGluZywgc28gZXhpc3RpbmcgcHJvamVjdHMgd29yayB3aXRob3V0IG1pZ3JhdGlvbi5cbiAqL1xuXG5pbXBvcnQgeyByZWFkZGlyU3luYywgZXhpc3RzU3luYywgcmVhbHBhdGhTeW5jLCBEaXJlbnQgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgZGlybmFtZSwgbm9ybWFsaXplLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBuYXRpdmVTY2FuR3NkVHJlZSwgdHlwZSBHc2RUcmVlRW50cnkgfSBmcm9tIFwiLi9uYXRpdmUtcGFyc2VyLWJyaWRnZS5qc1wiO1xuaW1wb3J0IHsgRElSX0NBQ0hFX01BWCB9IGZyb20gXCIuL2NvbnN0YW50cy5qc1wiO1xuaW1wb3J0IHsgZ3NkSG9tZSB9IGZyb20gXCIuL2dzZC1ob21lLmpzXCI7XG5pbXBvcnQgeyBpc0dzZFdvcmt0cmVlUGF0aCwgcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QgfSBmcm9tIFwiLi93b3JrdHJlZS1yb290LmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBEaXJlY3RvcnkgTGlzdGluZyBDYWNoZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuY29uc3QgZGlyRW50cnlDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBEaXJlbnRbXT4oKTtcbmNvbnN0IGRpckxpc3RDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE5hdGl2ZSBUcmVlIENhY2hlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gV2hlbiB0aGUgbmF0aXZlIG1vZHVsZSBpcyBhdmFpbGFibGUsIHNjYW4gdGhlIGVudGlyZSAuZ3NkLyB0cmVlIGluIG9uZSBjYWxsXG4vLyBhbmQgc2VydmUgZGlyZWN0b3J5IGxpc3RpbmdzIGZyb20gbWVtb3J5IGluc3RlYWQgb2YgaW5kaXZpZHVhbCByZWFkZGlyU3luYyBjYWxscy5cblxubGV0IG5hdGl2ZVRyZWVDYWNoZTogTWFwPHN0cmluZywgR3NkVHJlZUVudHJ5W10+IHwgbnVsbCA9IG51bGw7XG5sZXQgbmF0aXZlVHJlZUJhc2U6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiBnZXROYXRpdmVUcmVlKGdzZERpcjogc3RyaW5nKTogTWFwPHN0cmluZywgR3NkVHJlZUVudHJ5W10+IHwgbnVsbCB7XG4gIGlmIChuYXRpdmVUcmVlQ2FjaGUgJiYgbmF0aXZlVHJlZUJhc2UgPT09IGdzZERpcikgcmV0dXJuIG5hdGl2ZVRyZWVDYWNoZTtcblxuICBjb25zdCBlbnRyaWVzID0gbmF0aXZlU2NhbkdzZFRyZWUoZ3NkRGlyKTtcbiAgaWYgKCFlbnRyaWVzKSByZXR1cm4gbnVsbDtcblxuICAvLyBCdWlsZCBhIG1hcCBvZiBwYXJlbnQgZGlyZWN0b3J5IC0+IGVudHJpZXNcbiAgY29uc3QgdHJlZSA9IG5ldyBNYXA8c3RyaW5nLCBHc2RUcmVlRW50cnlbXT4oKTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgY29uc3QgcGFydHMgPSBlbnRyeS5wYXRoLnNwbGl0KCcvJyk7XG4gICAgY29uc3QgcGFyZW50UGF0aCA9IHBhcnRzLnNsaWNlKDAsIC0xKS5qb2luKCcvJyk7XG4gICAgY29uc3QgcGFyZW50S2V5ID0gcGFyZW50UGF0aCB8fCAnLic7XG4gICAgaWYgKCF0cmVlLmhhcyhwYXJlbnRLZXkpKSB0cmVlLnNldChwYXJlbnRLZXksIFtdKTtcbiAgICB0cmVlLmdldChwYXJlbnRLZXkpIS5wdXNoKGVudHJ5KTtcbiAgfVxuXG4gIG5hdGl2ZVRyZWVDYWNoZSA9IHRyZWU7XG4gIG5hdGl2ZVRyZWVCYXNlID0gZ3NkRGlyO1xuICByZXR1cm4gdHJlZTtcbn1cblxuLyoqXG4gKiBDb252ZXJ0IGEgbmF0aXZlIHRyZWUgbG9va3VwIGludG8gYSByZWxhdGl2ZSBrZXkgZm9yIHRoZSB0cmVlIG1hcC5cbiAqIFJldHVybnMgdGhlIHJlbGF0aXZlIHBhdGggZnJvbSB0aGUgZ3NkRGlyLCBvciBudWxsIGlmIHRoZSBwYXRoIGlzbid0IHVuZGVyIGdzZERpci5cbiAqL1xuZnVuY3Rpb24gbmF0aXZlVHJlZUtleShkaXJQYXRoOiBzdHJpbmcsIGdzZERpcjogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghZGlyUGF0aC5zdGFydHNXaXRoKGdzZERpcikpIHJldHVybiBudWxsO1xuICBjb25zdCByZWwgPSBkaXJQYXRoLnNsaWNlKGdzZERpci5sZW5ndGgpLnJlcGxhY2UoL15cXC8vLCAnJyk7XG4gIHJldHVybiByZWwgfHwgJy4nO1xufVxuXG5mdW5jdGlvbiBjYWNoZWRSZWFkZGlyV2l0aFR5cGVzKGRpclBhdGg6IHN0cmluZyk6IERpcmVudFtdIHtcbiAgY29uc3QgY2FjaGVkID0gZGlyRW50cnlDYWNoZS5nZXQoZGlyUGF0aCk7XG4gIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgLy8gVHJ5IG5hdGl2ZSB0cmVlIGNhY2hlIGZvciBwYXRocyB1bmRlciAuZ3NkL1xuICBpZiAobmF0aXZlVHJlZUJhc2UpIHtcbiAgICBjb25zdCBrZXkgPSBuYXRpdmVUcmVlS2V5KGRpclBhdGgsIG5hdGl2ZVRyZWVCYXNlKTtcbiAgICBpZiAoa2V5ICYmIG5hdGl2ZVRyZWVDYWNoZSkge1xuICAgICAgY29uc3QgdHJlZUVudHJpZXMgPSBuYXRpdmVUcmVlQ2FjaGUuZ2V0KGtleSk7XG4gICAgICBpZiAodHJlZUVudHJpZXMpIHtcbiAgICAgICAgLy8gU3ludGhlc2l6ZSBEaXJlbnQtbGlrZSBvYmplY3RzIGZyb20gbmF0aXZlIHRyZWUgZW50cmllc1xuICAgICAgICBjb25zdCBkaXJlbnRzID0gdHJlZUVudHJpZXMubWFwKGUgPT4ge1xuICAgICAgICAgIGNvbnN0IGQgPSBPYmplY3QuY3JlYXRlKERpcmVudC5wcm90b3R5cGUpIGFzIERpcmVudDtcbiAgICAgICAgICBPYmplY3QuYXNzaWduKGQsIHtcbiAgICAgICAgICAgIG5hbWU6IGUubmFtZSxcbiAgICAgICAgICAgIHBhcmVudFBhdGg6IGRpclBhdGgsXG4gICAgICAgICAgICBwYXRoOiBkaXJQYXRoLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIC8vIE92ZXJyaWRlIHRoZSB0eXBlIGNoZWNrIG1ldGhvZHNcbiAgICAgICAgICBjb25zdCBpc0RpciA9IGUuaXNEaXI7XG4gICAgICAgICAgZC5pc0RpcmVjdG9yeSA9ICgpID0+IGlzRGlyO1xuICAgICAgICAgIGQuaXNGaWxlID0gKCkgPT4gIWlzRGlyO1xuICAgICAgICAgIGQuaXNTeW1ib2xpY0xpbmsgPSAoKSA9PiBmYWxzZTtcbiAgICAgICAgICBkLmlzQmxvY2tEZXZpY2UgPSAoKSA9PiBmYWxzZTtcbiAgICAgICAgICBkLmlzQ2hhcmFjdGVyRGV2aWNlID0gKCkgPT4gZmFsc2U7XG4gICAgICAgICAgZC5pc0ZJRk8gPSAoKSA9PiBmYWxzZTtcbiAgICAgICAgICBkLmlzU29ja2V0ID0gKCkgPT4gZmFsc2U7XG4gICAgICAgICAgcmV0dXJuIGQ7XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoZGlyRW50cnlDYWNoZS5zaXplID49IERJUl9DQUNIRV9NQVgpIGRpckVudHJ5Q2FjaGUuY2xlYXIoKTtcbiAgICAgICAgZGlyRW50cnlDYWNoZS5zZXQoZGlyUGF0aCwgZGlyZW50cyk7XG4gICAgICAgIHJldHVybiBkaXJlbnRzO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhkaXJQYXRoLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSk7XG4gIGlmIChkaXJFbnRyeUNhY2hlLnNpemUgPj0gRElSX0NBQ0hFX01BWCkgZGlyRW50cnlDYWNoZS5jbGVhcigpO1xuICBkaXJFbnRyeUNhY2hlLnNldChkaXJQYXRoLCBlbnRyaWVzKTtcbiAgcmV0dXJuIGVudHJpZXM7XG59XG5cbmZ1bmN0aW9uIGNhY2hlZFJlYWRkaXIoZGlyUGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBjYWNoZWQgPSBkaXJMaXN0Q2FjaGUuZ2V0KGRpclBhdGgpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gIC8vIFRyeSBuYXRpdmUgdHJlZSBjYWNoZSBmb3IgcGF0aHMgdW5kZXIgLmdzZC9cbiAgaWYgKG5hdGl2ZVRyZWVCYXNlKSB7XG4gICAgY29uc3Qga2V5ID0gbmF0aXZlVHJlZUtleShkaXJQYXRoLCBuYXRpdmVUcmVlQmFzZSk7XG4gICAgaWYgKGtleSAmJiBuYXRpdmVUcmVlQ2FjaGUpIHtcbiAgICAgIGNvbnN0IHRyZWVFbnRyaWVzID0gbmF0aXZlVHJlZUNhY2hlLmdldChrZXkpO1xuICAgICAgaWYgKHRyZWVFbnRyaWVzKSB7XG4gICAgICAgIGNvbnN0IG5hbWVzID0gdHJlZUVudHJpZXMubWFwKGUgPT4gZS5uYW1lKTtcbiAgICAgICAgaWYgKGRpckxpc3RDYWNoZS5zaXplID49IERJUl9DQUNIRV9NQVgpIGRpckxpc3RDYWNoZS5jbGVhcigpO1xuICAgICAgICBkaXJMaXN0Q2FjaGUuc2V0KGRpclBhdGgsIG5hbWVzKTtcbiAgICAgICAgcmV0dXJuIG5hbWVzO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhkaXJQYXRoKTtcbiAgaWYgKGRpckxpc3RDYWNoZS5zaXplID49IERJUl9DQUNIRV9NQVgpIGRpckxpc3RDYWNoZS5jbGVhcigpO1xuICBkaXJMaXN0Q2FjaGUuc2V0KGRpclBhdGgsIGVudHJpZXMpO1xuICByZXR1cm4gZW50cmllcztcbn1cblxuLyoqXG4gKiBDbGVhciB0aGUgdm9sYXRpbGUgZGlyZWN0b3J5IGxpc3RpbmcgY2FjaGVzLlxuICogQ2FsbCBhZnRlciBtaWxlc3RvbmUgdHJhbnNpdGlvbnMsIGZpbGUgY3JlYXRpb24gaW4gcGxhbm5pbmcgZGlyZWN0b3JpZXMsXG4gKiBvciBhdCB0aGUgc3RhcnQvZW5kIG9mIGEgZGlzcGF0Y2ggY3ljbGUuXG4gKlxuICogTk9URTogVGhpcyBkb2VzIE5PVCBjbGVhciBnc2RSb290Q2FjaGUuIFRoZSBwcm9qZWN0IHJvb3QgaXMgc3RhYmxlIGZvclxuICogdGhlIGxpZmV0aW1lIG9mIGEgcHJvY2VzczsgY2xlYXJpbmcgaXQgb24gZXZlcnkgYWdlbnQgdHVybi1lbmQgY2F1c2VkIGFcbiAqIDI1MFx1MjAxMzI1MDAgbXMgcmVncmVzc2lvbiBwZXIgc2Vzc2lvbiAoZ2l0IHJldi1wYXJzZSArIGRpciB3YWxrIHBlciB0dXJuKS5cbiAqIFVzZSBfY2xlYXJHc2RSb290Q2FjaGUoKSBhdCBzZXNzaW9uLXJlc2V0IGJvdW5kYXJpZXMgKHdvcmtzcGFjZSBzd2l0Y2gsXG4gKiBwcm9jZXNzIGV4aXQpIHdoZW4gdGhlIHByb2plY3Qgcm9vdCBtYXkgZ2VudWluZWx5IGNoYW5nZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyUGF0aENhY2hlKCk6IHZvaWQge1xuICBkaXJFbnRyeUNhY2hlLmNsZWFyKCk7XG4gIGRpckxpc3RDYWNoZS5jbGVhcigpO1xuICBuYXRpdmVUcmVlQ2FjaGUgPSBudWxsO1xuICBuYXRpdmVUcmVlQmFzZSA9IG51bGw7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBOYW1lIEJ1aWxkZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEJ1aWxkIGEgbWlsZXN0b25lLWxldmVsIGZpbGUgbmFtZS5cbiAqIChcIk0wMDFcIiwgXCJDT05URVhUXCIpIFx1MjE5MiBcIk0wMDEtQ09OVEVYVC5tZFwiXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZE1pbGVzdG9uZUZpbGVOYW1lKG1pbGVzdG9uZUlkOiBzdHJpbmcsIHN1ZmZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke21pbGVzdG9uZUlkfS0ke3N1ZmZpeH0ubWRgO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgc2xpY2UtbGV2ZWwgZmlsZSBuYW1lLlxuICogKFwiUzAxXCIsIFwiUExBTlwiKSBcdTIxOTIgXCJTMDEtUExBTi5tZFwiXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFNsaWNlRmlsZU5hbWUoc2xpY2VJZDogc3RyaW5nLCBzdWZmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtzbGljZUlkfS0ke3N1ZmZpeH0ubWRgO1xufVxuXG4vKipcbiAqIEJ1aWxkIGEgdGFzayBmaWxlIG5hbWUuXG4gKiAoXCJUMDNcIiwgXCJQTEFOXCIpIFx1MjE5MiBcIlQwMy1QTEFOLm1kXCJcbiAqIChcIlQwM1wiLCBcIlNVTU1BUllcIikgXHUyMTkyIFwiVDAzLVNVTU1BUlkubWRcIlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRUYXNrRmlsZU5hbWUodGFza0lkOiBzdHJpbmcsIHN1ZmZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3Rhc2tJZH0tJHtzdWZmaXh9Lm1kYDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlc29sdmVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBGaW5kIGEgZGlyZWN0b3J5IGVudHJ5IGJ5IElEIHByZWZpeCB3aXRoaW4gYSBwYXJlbnQgZGlyZWN0b3J5LlxuICogRXhhY3QgbWF0Y2ggZmlyc3QgKE0wMDEpLCB0aGVuIHByZWZpeCBtYXRjaCAoTTAwMS1TT01FVEhJTkcpIGZvclxuICogYmFja3dhcmQgY29tcGF0aWJpbGl0eSB3aXRoIGxlZ2FjeSBkZXNjcmlwdG9yIGRpcmVjdG9yaWVzLlxuICogUmV0dXJucyB0aGUgZnVsbCBkaXJlY3RvcnkgbmFtZSBvciBudWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZURpcihwYXJlbnREaXI6IHN0cmluZywgaWRQcmVmaXg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWV4aXN0c1N5bmMocGFyZW50RGlyKSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgZW50cmllcyA9IGNhY2hlZFJlYWRkaXJXaXRoVHlwZXMocGFyZW50RGlyKTtcbiAgICAvLyBFeGFjdCBtYXRjaCBmaXJzdCAoY3VycmVudCBjb252ZW50aW9uOiBiYXJlIElEKVxuICAgIGNvbnN0IGV4YWN0ID0gZW50cmllcy5maW5kKGUgPT4gZS5pc0RpcmVjdG9yeSgpICYmIGUubmFtZSA9PT0gaWRQcmVmaXgpO1xuICAgIGlmIChleGFjdCkgcmV0dXJuIGV4YWN0Lm5hbWU7XG4gICAgY29uc3QgaWRMb3dlciA9IGlkUHJlZml4LnRvTG93ZXJDYXNlKCk7XG4gICAgY29uc3QgZXhhY3RDYXNlSW5zZW5zaXRpdmUgPSBlbnRyaWVzLmZpbmQoXG4gICAgICBlID0+IGUuaXNEaXJlY3RvcnkoKSAmJiBlLm5hbWUudG9Mb3dlckNhc2UoKSA9PT0gaWRMb3dlclxuICAgICk7XG4gICAgaWYgKGV4YWN0Q2FzZUluc2Vuc2l0aXZlKSByZXR1cm4gZXhhY3RDYXNlSW5zZW5zaXRpdmUubmFtZTtcbiAgICAvLyBQcmVmaXggbWF0Y2ggZm9yIGxlZ2FjeSBkZXNjcmlwdG9yIGRpcnM6IE0wMDEtU09NRVRISU5HXG4gICAgY29uc3QgcHJlZml4ZWQgPSBlbnRyaWVzLmZpbmQoXG4gICAgICBlID0+IGUuaXNEaXJlY3RvcnkoKSAmJiBlLm5hbWUudG9Mb3dlckNhc2UoKS5zdGFydHNXaXRoKGlkTG93ZXIgKyBcIi1cIilcbiAgICApO1xuICAgIHJldHVybiBwcmVmaXhlZCA/IHByZWZpeGVkLm5hbWUgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIEZpbmQgYSBmaWxlIGJ5IElEIHByZWZpeCBhbmQgc3VmZml4IHdpdGhpbiBhIGRpcmVjdG9yeS5cbiAqIENoZWNrcyBpbiBvcmRlcjpcbiAqICAgMS4gRGlyZWN0OiBJRC1TVUZGSVgubWQgKGUuZy4gTTAwMS1ST0FETUFQLm1kLCBUMDMtUExBTi5tZClcbiAqICAgMi4gTGVnYWN5IGRlc2NyaXB0b3I6IElELURFU0NSSVBUT1ItU1VGRklYLm1kIChlLmcuIFQwMy1JTlNUQUxMLVBBQ0tBR0VTLVBMQU4ubWQpXG4gKiAgIDMuIExlZ2FjeSBiYXJlOiBzdWZmaXgubWQgKGUuZy4gcm9hZG1hcC5tZClcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVGaWxlKGRpcjogc3RyaW5nLCBpZFByZWZpeDogc3RyaW5nLCBzdWZmaXg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWV4aXN0c1N5bmMoZGlyKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHRhcmdldCA9IGAke2lkUHJlZml4fS0ke3N1ZmZpeH0ubWRgLnRvVXBwZXJDYXNlKCk7XG4gIHRyeSB7XG4gICAgY29uc3QgZW50cmllcyA9IGNhY2hlZFJlYWRkaXIoZGlyKTtcbiAgICAvLyBEaXJlY3QgbWF0Y2g6IElELVNVRkZJWC5tZFxuICAgIGNvbnN0IGRpcmVjdCA9IGVudHJpZXMuZmluZChlID0+IGUudG9VcHBlckNhc2UoKSA9PT0gdGFyZ2V0KTtcbiAgICBpZiAoZGlyZWN0KSByZXR1cm4gZGlyZWN0O1xuICAgIC8vIExlZ2FjeSBwYXR0ZXJuIG1hdGNoOiBJRC1ERVNDUklQVE9SLVNVRkZJWC5tZFxuICAgIGNvbnN0IHBhdHRlcm4gPSBuZXcgUmVnRXhwKFxuICAgICAgYF4ke2lkUHJlZml4fS0uKi0ke3N1ZmZpeH1cXFxcLm1kJGAsIFwiaVwiXG4gICAgKTtcbiAgICBjb25zdCBtYXRjaCA9IGVudHJpZXMuZmluZChlID0+IHBhdHRlcm4udGVzdChlKSk7XG4gICAgaWYgKG1hdGNoKSByZXR1cm4gbWF0Y2g7XG4gICAgLy8gTGVnYWN5IGZhbGxiYWNrOiBzdWZmaXgubWRcbiAgICBjb25zdCBsZWdhY3kgPSBlbnRyaWVzLmZpbmQoZSA9PiBlLnRvTG93ZXJDYXNlKCkgPT09IGAke3N1ZmZpeC50b0xvd2VyQ2FzZSgpfS5tZGApO1xuICAgIGlmIChsZWdhY3kpIHJldHVybiBsZWdhY3k7XG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogRmluZCBhbGwgdGFzayBmaWxlcyBtYXRjaGluZyBhIHBhdHRlcm4gaW4gYSB0YXNrcyBkaXJlY3RvcnkuXG4gKiBSZXR1cm5zIHNvcnRlZCBmaWxlIG5hbWVzIG1hdGNoaW5nIFQjIy1TVUZGSVgubWQgb3IgbGVnYWN5IFQjIy0qLVNVRkZJWC5tZFxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVRhc2tGaWxlcyh0YXNrc0Rpcjogc3RyaW5nLCBzdWZmaXg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgaWYgKCFleGlzdHNTeW5jKHRhc2tzRGlyKSkgcmV0dXJuIFtdO1xuICB0cnkge1xuICAgIC8vIEN1cnJlbnQgY29udmVudGlvbjogVDAxLVBMQU4ubWRcbiAgICBjb25zdCBjdXJyZW50UGF0dGVybiA9IG5ldyBSZWdFeHAoYF5UXFxcXGQrLSR7c3VmZml4fVxcXFwubWQkYCwgXCJpXCIpO1xuICAgIC8vIExlZ2FjeSBjb252ZW50aW9uOiBUMDEtSU5TVEFMTC1QQUNLQUdFUy1QTEFOLm1kXG4gICAgY29uc3QgbGVnYWN5UGF0dGVybiA9IG5ldyBSZWdFeHAoYF5UXFxcXGQrLS4qLSR7c3VmZml4fVxcXFwubWQkYCwgXCJpXCIpO1xuICAgIHJldHVybiBjYWNoZWRSZWFkZGlyKHRhc2tzRGlyKVxuICAgICAgLmZpbHRlcihmID0+IGN1cnJlbnRQYXR0ZXJuLnRlc3QoZikgfHwgbGVnYWN5UGF0dGVybi50ZXN0KGYpKVxuICAgICAgLnNvcnQoKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKlxuICogRmluZCBhbGwgdGFzayBKU09OIGZpbGVzIG1hdGNoaW5nIGEgcGF0dGVybiBpbiBhIHRhc2tzIGRpcmVjdG9yeS5cbiAqIFJldHVybnMgc29ydGVkIGZpbGUgbmFtZXMgbWF0Y2hpbmcgVCMjLVNVRkZJWC5qc29uIG9yIGxlZ2FjeSBUIyMtKi1TVUZGSVguanNvblxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVRhc2tKc29uRmlsZXModGFza3NEaXI6IHN0cmluZywgc3VmZml4OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGlmICghZXhpc3RzU3luYyh0YXNrc0RpcikpIHJldHVybiBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCBjdXJyZW50UGF0dGVybiA9IG5ldyBSZWdFeHAoYF5UXFxcXGQrLSR7c3VmZml4fVxcXFwuanNvbiRgLCBcImlcIik7XG4gICAgY29uc3QgbGVnYWN5UGF0dGVybiA9IG5ldyBSZWdFeHAoYF5UXFxcXGQrLS4qLSR7c3VmZml4fVxcXFwuanNvbiRgLCBcImlcIik7XG4gICAgcmV0dXJuIGNhY2hlZFJlYWRkaXIodGFza3NEaXIpXG4gICAgICAuZmlsdGVyKGYgPT4gY3VycmVudFBhdHRlcm4udGVzdChmKSB8fCBsZWdhY3lQYXR0ZXJuLnRlc3QoZikpXG4gICAgICAuc29ydCgpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gW107XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZ1bGwgUGF0aCBCdWlsZGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGNvbnN0IEdTRF9ST09UX0ZJTEVTID0ge1xuICBQUk9KRUNUOiBcIlBST0pFQ1QubWRcIixcbiAgREVDSVNJT05TOiBcIkRFQ0lTSU9OUy5tZFwiLFxuICBRVUVVRTogXCJRVUVVRS5tZFwiLFxuICBTVEFURTogXCJTVEFURS5tZFwiLFxuICBSRVFVSVJFTUVOVFM6IFwiUkVRVUlSRU1FTlRTLm1kXCIsXG4gIE9WRVJSSURFUzogXCJPVkVSUklERVMubWRcIixcbiAgS05PV0xFREdFOiBcIktOT1dMRURHRS5tZFwiLFxuICBDT0RFQkFTRTogXCJDT0RFQkFTRS5tZFwiLFxufSBhcyBjb25zdDtcblxuZXhwb3J0IHR5cGUgR1NEUm9vdEZpbGVLZXkgPSBrZXlvZiB0eXBlb2YgR1NEX1JPT1RfRklMRVM7XG5cbmNvbnN0IExFR0FDWV9HU0RfUk9PVF9GSUxFUzogUmVjb3JkPEdTRFJvb3RGaWxlS2V5LCBzdHJpbmc+ID0ge1xuICBQUk9KRUNUOiBcInByb2plY3QubWRcIixcbiAgREVDSVNJT05TOiBcImRlY2lzaW9ucy5tZFwiLFxuICBRVUVVRTogXCJxdWV1ZS5tZFwiLFxuICBTVEFURTogXCJzdGF0ZS5tZFwiLFxuICBSRVFVSVJFTUVOVFM6IFwicmVxdWlyZW1lbnRzLm1kXCIsXG4gIE9WRVJSSURFUzogXCJvdmVycmlkZXMubWRcIixcbiAgS05PV0xFREdFOiBcImtub3dsZWRnZS5tZFwiLFxuICBDT0RFQkFTRTogXCJjb2RlYmFzZS5tZFwiLFxufTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEdTRCBSb290IERpc2NvdmVyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLy8gUHJvY2Vzcy1saWZldGltZSBjYWNoZSBmb3IgZ3NkUm9vdCgpIHJlc3VsdHMuXG4vLyBLZXlzIGFyZSByZWFscGF0aC1ub3JtYWxpemVkICh2aWEgbm9ybUNhY2hlS2V5KSBzbyAvZm9vIGFuZCAvZm9vLyBzaGFyZSB0aGVcbi8vIHNhbWUgZW50cnkgYW5kIHNvIGRvIGNhc2UtdmFyaWFudCBwYXRocyBvbiBjYXNlLWluc2Vuc2l0aXZlIHZvbHVtZXMuIFRoaXNcbi8vIG5vcm1hbGl6YXRpb24gaXMgdGhlIHNhZmV0eSBuZXQgdGhhdCBwcmV2ZW50cyBjYWNoZSBwb2lzb25pbmcgZnJvbSB0aGVcbi8vIH4vLmdzZCB3YWxrLXVwIGJ1ZyAoZml4ZWQgaW4gYzQ2Y2Y0Nzg2ICsgYjM1ZTA3MGViKSwgbWFraW5nIGl0IHNhZmUgdG9cbi8vIGhvbGQgdGhpcyBjYWNoZSBmb3IgdGhlIGVudGlyZSBwcm9jZXNzIGxpZmV0aW1lLlxuLy8gVXNlIF9jbGVhckdzZFJvb3RDYWNoZSgpIG9ubHkgYXQgc2Vzc2lvbi1yZXNldCBib3VuZGFyaWVzICh3b3Jrc3BhY2Ugc3dpdGNoLFxuLy8gcHJvY2VzcyBleGl0KSBcdTIwMTQgTk9UIGluc2lkZSBjbGVhclBhdGhDYWNoZSgpLCB3aGljaCBydW5zIG9uIGV2ZXJ5IGFnZW50IHR1cm4uXG5jb25zdCBnc2RSb290Q2FjaGUgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuXG5leHBvcnQgaW50ZXJmYWNlIEdzZFBhdGhDb250cmFjdCB7XG4gIC8qKiBDYW5vbmljYWwgcmVwby9wcm9qZWN0IHJvb3Qgd2hlcmUgYXV0aG9yaXRhdGl2ZSBzdGF0ZSBsaXZlcy4gKi9cbiAgcHJvamVjdFJvb3Q6IHN0cmluZztcbiAgLyoqIEN1cnJlbnQgZXhlY3V0aW9uIHJvb3QsIHdoaWNoIG1heSBiZSBhbiBhdXRvLXdvcmt0cmVlLiAqL1xuICB3b3JrUm9vdDogc3RyaW5nO1xuICAvKiogQ2Fub25pY2FsIGF1dGhvcml0YXRpdmUgLmdzZCBkaXJlY3RvcnkuICovXG4gIHByb2plY3RHc2Q6IHN0cmluZztcbiAgLyoqIExlZ2FjeSB3b3JrdHJlZS1sb2NhbCAuZ3NkIHByb2plY3Rpb24gZGlyZWN0b3J5LCB3aGVuIGFwcGxpY2FibGUuICovXG4gIHdvcmt0cmVlR3NkOiBzdHJpbmcgfCBudWxsO1xuICAvKiogQ2Fub25pY2FsIGF1dGhvcml0YXRpdmUgU1FMaXRlIERCIHBhdGguICovXG4gIHByb2plY3REYjogc3RyaW5nO1xuICAvKiogVHJ1ZSB3aGVuIHdvcmtSb290IGlzIGluc2lkZSBhIEdTRCB3b3JrdHJlZSBsYXlvdXQuICovXG4gIGlzV29ya3RyZWU6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlR3NkUGF0aENvbnRyYWN0KFxuICB3b3JrUm9vdDogc3RyaW5nLFxuICBvcmlnaW5hbFByb2plY3RSb290Pzogc3RyaW5nIHwgbnVsbCxcbik6IEdzZFBhdGhDb250cmFjdCB7XG4gIGNvbnN0IHJlc29sdmVkV29ya1Jvb3QgPSByZXNvbHZlKHdvcmtSb290IHx8IHByb2Nlc3MuY3dkKCkpO1xuICBjb25zdCBpc1dvcmt0cmVlID0gaXNHc2RXb3JrdHJlZVBhdGgocmVzb2x2ZWRXb3JrUm9vdCk7XG4gIGlmIChpc1dvcmt0cmVlICYmICFvcmlnaW5hbFByb2plY3RSb290Py50cmltKCkpIHtcbiAgICBjb25zdCBleHRlcm5hbE1hdGNoID0gL1svXFxcXF1cXC5nc2RbL1xcXFxdcHJvamVjdHNbL1xcXFxdW14vXFxcXF0rWy9cXFxcXXdvcmt0cmVlcyg/OlsvXFxcXF18JCkvLmV4ZWMocmVzb2x2ZWRXb3JrUm9vdCk7XG4gICAgaWYgKGV4dGVybmFsTWF0Y2gpIHtcbiAgICAgIGNvbnN0IHdvcmt0cmVlc0lkeCA9IGV4dGVybmFsTWF0Y2hbMF0uc2VhcmNoKC9bL1xcXFxdd29ya3RyZWVzKD86Wy9cXFxcXXwkKS8pO1xuICAgICAgY29uc3QgcHJvamVjdEdzZCA9IHJlc29sdmVkV29ya1Jvb3Quc2xpY2UoMCwgZXh0ZXJuYWxNYXRjaC5pbmRleCArIHdvcmt0cmVlc0lkeCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwcm9qZWN0Um9vdDogZGlybmFtZShkaXJuYW1lKHByb2plY3RHc2QpKSxcbiAgICAgICAgd29ya1Jvb3Q6IHJlc29sdmVkV29ya1Jvb3QsXG4gICAgICAgIHByb2plY3RHc2QsXG4gICAgICAgIHdvcmt0cmVlR3NkOiBqb2luKHJlc29sdmVkV29ya1Jvb3QsIFwiLmdzZFwiKSxcbiAgICAgICAgcHJvamVjdERiOiBqb2luKHByb2plY3RHc2QsIFwiZ3NkLmRiXCIpLFxuICAgICAgICBpc1dvcmt0cmVlLFxuICAgICAgfTtcbiAgICB9XG4gIH1cbiAgY29uc3QgcHJvamVjdFJvb3QgPSByZXNvbHZlKHJlc29sdmVXb3JrdHJlZVByb2plY3RSb290KHJlc29sdmVkV29ya1Jvb3QsIG9yaWdpbmFsUHJvamVjdFJvb3QpKTtcbiAgY29uc3QgcHJvamVjdEdzZCA9IGpvaW4ocHJvamVjdFJvb3QsIFwiLmdzZFwiKTtcbiAgY29uc3Qgd29ya3RyZWVHc2QgPSBpc1dvcmt0cmVlID8gam9pbihyZXNvbHZlZFdvcmtSb290LCBcIi5nc2RcIikgOiBudWxsO1xuXG4gIHJldHVybiB7XG4gICAgcHJvamVjdFJvb3QsXG4gICAgd29ya1Jvb3Q6IHJlc29sdmVkV29ya1Jvb3QsXG4gICAgcHJvamVjdEdzZCxcbiAgICB3b3JrdHJlZUdzZCxcbiAgICBwcm9qZWN0RGI6IGpvaW4ocHJvamVjdEdzZCwgXCJnc2QuZGJcIiksXG4gICAgaXNXb3JrdHJlZSxcbiAgfTtcbn1cblxuLyoqXG4gKiBJbnZhbGlkYXRlIHRoZSBnc2RSb290IGNhY2hlLlxuICogVXNlIE9OTFkgYXQgc2Vzc2lvbi1yZXNldCBib3VuZGFyaWVzOiB3b3Jrc3BhY2Ugc3dpdGNoLCBwcm9jZXNzIGV4aXQsIG9yXG4gKiBhbnkgY29udGV4dCB3aGVyZSB0aGUgcHJvamVjdCByb290IGl0c2VsZiBtYXkgZ2VudWluZWx5IGNoYW5nZS5cbiAqIERvIE5PVCBjYWxsIHRoaXMgb24gZXZlcnkgYWdlbnQgdHVybiBcdTIwMTQgdXNlIGNsZWFyUGF0aENhY2hlKCkgZm9yIHZvbGF0aWxlXG4gKiBkaXJlY3RvcnkgbGlzdGluZyBpbnZhbGlkYXRpb24gaW5zdGVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9jbGVhckdzZFJvb3RDYWNoZSgpOiB2b2lkIHtcbiAgZ3NkUm9vdENhY2hlLmNsZWFyKCk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBhIHBhdGggdG8gaXRzIGNhbm9uaWNhbCByZWFsIHBhdGggdXNpbmcgdGhlIG5hdGl2ZSByZXNvbHZlci5cbiAqIE9uIG1hY09TIGNhc2UtaW5zZW5zaXRpdmUgKEhGUysvQVBGUykgdm9sdW1lcywgcmVhbHBhdGhTeW5jLm5hdGl2ZSBub3JtYWxpemVzXG4gKiBjYXNlIFx1MjAxNCBlbnN1cmluZyB0aGF0IC9mb28vQmFyIGFuZCAvZm9vL2JhciByZXNvbHZlIHRvIHRoZSBzYW1lIHN0cmluZy5cbiAqIEZhbGxzIGJhY2sgdG8gcmVzb2x2ZShwKSBmb3Igbm9uLWV4aXN0ZW50IHBhdGhzLlxuICpcbiAqIFVzZSB0aGlzIGhlbHBlciBldmVyeXdoZXJlIGEgcGF0aCBpcyB1c2VkIGFzIGFuIGlkZW50aXR5L2NhY2hlIGtleSBzbyB0aGF0XG4gKiBhbGwgY2FsbGVycyBhZ3JlZSBvbiB0aGUgY2Fub25pY2FsIGZvcm0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVSZWFsUGF0aChwOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkgeyByZXR1cm4gcmVhbHBhdGhTeW5jLm5hdGl2ZShwKTsgfSBjYXRjaCB7IHJldHVybiByZXNvbHZlKHApOyB9XG59XG5cbi8qKiBOb3JtYWxpemUgYSBwYXRoIGZvciB1c2UgYXMgYSBnc2RSb290Q2FjaGUga2V5IChyZWFscGF0aCArIHRyYWlsaW5nLXNsYXNoIHN0cmlwKS4gKi9cbmZ1bmN0aW9uIG5vcm1DYWNoZUtleShwOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByID0gbm9ybWFsaXplUmVhbFBhdGgocCk7XG4gIGNvbnN0IHMgPSByLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKS5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xuICByZXR1cm4gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gcy50b0xvd2VyQ2FzZSgpIDogcztcbn1cblxuLyoqXG4gKiBSZXNvbHZlIHRoZSBgLmdzZGAgZGlyZWN0b3J5IGZvciBhIGdpdmVuIHByb2plY3QgYmFzZSBwYXRoLlxuICpcbiAqIFByb2JlIG9yZGVyOlxuICogICAxLiBiYXNlUGF0aC8uZ3NkICAgICAgICAgXHUyMDE0IGZhc3QgcGF0aCAoY29tbW9uIGNhc2UpXG4gKiAgIDIuIGdpdCByZXYtcGFyc2Ugcm9vdCAgICBcdTIwMTQgaGFuZGxlcyBjd2QtaXMtYS1zdWJkaXJlY3RvcnlcbiAqICAgMy4gV2FsayB1cCBmcm9tIGJhc2VQYXRoIFx1MjAxNCBoYW5kbGVzIG1vdmVkIC5nc2QgaW4gYW4gYW5jZXN0b3IgKGJvdW5kZWQgYnkgZ2l0IHJvb3QpXG4gKiAgIDQuIGJhc2VQYXRoLy5nc2QgICAgICAgICBcdTIwMTQgY3JlYXRpb24gZmFsbGJhY2sgKGluaXQgc2NlbmFyaW8pXG4gKlxuICogUmVzdWx0IGlzIGNhY2hlZCBwZXIgbm9ybWFsaXplZCBiYXNlUGF0aCBmb3IgdGhlIHByb2Nlc3MgbGlmZXRpbWUuXG4gKiBLZXlzIGFyZSByZWFscGF0aC1ub3JtYWxpemVkIHNvIC9mb28gYW5kIC9mb28vIHNoYXJlIHRoZSBzYW1lIGNhY2hlIGVudHJ5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ3NkUm9vdChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgY2FjaGVLZXkgPSBub3JtQ2FjaGVLZXkoYmFzZVBhdGgpO1xuICBjb25zdCBjYWNoZWQgPSBnc2RSb290Q2FjaGUuZ2V0KGNhY2hlS2V5KTtcbiAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcblxuICAvLyBDYW5vbmljYWxpemUgcmVzdWx0IHZpYSByZWFscGF0aCBiZWZvcmUgYXNzZXJ0aW5nIGFuZCBjYWNoaW5nIHNvIHRoYXRcbiAgLy8gY2FsbGVycyBhbHdheXMgcmVjZWl2ZSBhIGNhbm9uaWNhbCBwYXRoIHJlZ2FyZGxlc3Mgb2Ygd2hldGhlciBwcm9iZUdzZFJvb3RcbiAgLy8gcmV0dXJuZWQgYSBwYXRoIHRocm91Z2ggYSBzeW1saW5rLiBXaXRob3V0IHRoaXMsIHRoZSBjYWNoZWQgdmFsdWUgY2FuXG4gIC8vIGRpdmVyZ2UgZnJvbSBvdGhlciByZWFscGF0aC1ub3JtYWxpemVkIHBhdGhzIChlLmcuIHdvcmtzcGFjZS5pZGVudGl0eUtleSkuXG4gIGNvbnN0IHJlc3VsdCA9IG5vcm1hbGl6ZVJlYWxQYXRoKHByb2JlR3NkUm9vdChiYXNlUGF0aCkpO1xuXG4gIC8vIERlZmVuc2UtaW4tZGVwdGg6IGlmIGJhc2VQYXRoIHJlc29sdmVzIHRvIHRoZSB1c2VyJ3MgaG9tZSBkaXJlY3RvcnkgYW5kXG4gIC8vIHRoZSByZXN1bHQgZXF1YWxzIGdzZEhvbWUoKSwgcmVmdXNlIFx1MjAxNCBwcm9qZWN0LXNjb3BlZCB3cml0ZXMgbXVzdCBuZXZlclxuICAvLyBsYW5kIGluIHRoZSBnbG9iYWwgfi8uZ3NkLiBQYXRocyB1bmRlciB+Ly5nc2QvcHJvamVjdHMvPGhhc2g+LyBhcmUgc3RpbGxcbiAgLy8gdmFsaWQgKHRoZWlyIGJhc2VQYXRoIGRvZXMgbm90IGVxdWFsIGhvbWVkaXIpLlxuICBhc3NlcnROb3RHbG9iYWxHc2RIb21lKGJhc2VQYXRoLCByZXN1bHQpO1xuXG4gIGdzZFJvb3RDYWNoZS5zZXQoY2FjaGVLZXksIHJlc3VsdCk7XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIGFzc2VydE5vdEdsb2JhbEdzZEhvbWUoYmFzZVBhdGg6IHN0cmluZywgcmVzdWx0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgbm9ybSA9IChwOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGxldCByOiBzdHJpbmc7XG4gICAgdHJ5IHsgciA9IHJlYWxwYXRoU3luYy5uYXRpdmUocCk7IH0gY2F0Y2ggeyByID0gcDsgfVxuICAgIGNvbnN0IHMgPSByLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKS5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xuICAgIHJldHVybiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBzLnRvTG93ZXJDYXNlKCkgOiBzO1xuICB9O1xuICBsZXQgYmFzZU5vcm06IHN0cmluZztcbiAgbGV0IGhvbWVOb3JtOiBzdHJpbmc7XG4gIGxldCByZXN1bHROb3JtOiBzdHJpbmc7XG4gIGxldCBnc2RIb21lTm9ybTogc3RyaW5nO1xuICB0cnkge1xuICAgIGJhc2VOb3JtID0gbm9ybShiYXNlUGF0aCk7XG4gICAgaG9tZU5vcm0gPSBub3JtKGhvbWVkaXIoKSk7XG4gICAgcmVzdWx0Tm9ybSA9IG5vcm0ocmVzdWx0KTtcbiAgICBnc2RIb21lTm9ybSA9IG5vcm0oZ3NkSG9tZSgpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChiYXNlTm9ybSA9PT0gaG9tZU5vcm0gJiYgcmVzdWx0Tm9ybSA9PT0gZ3NkSG9tZU5vcm0pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgUmVmdXNpbmcgdG8gdXNlICR7cmVzdWx0fSBhcyBhIHByb2plY3QgLmdzZCBkaXJlY3RvcnkgXHUyMDE0IHRoYXQgaXMgdGhlIGdsb2JhbCBHU0QgaG9tZS4gYCArXG4gICAgICBgUnVuIEdTRCBmcm9tIGluc2lkZSBhIHByb2plY3QgZGlyZWN0b3J5LmAsXG4gICAgKTtcbiAgfVxufVxuXG4vKipcbiAqIERldGVjdCBpZiBhIHBhdGggaXMgaW5zaWRlIGEgLmdzZC93b3JrdHJlZXMvPG5hbWU+LyBzdHJ1Y3R1cmUuXG4gKlxuICogR1NEIGF1dG8td29ya3RyZWVzIGxpdmUgYXQgPHByb2plY3Q+Ly5nc2Qvd29ya3RyZWVzLzxtaWxlc3RvbmVJZD4vLlxuICogV2hlbiBnc2RSb290KCkgaXMgY2FsbGVkIHdpdGggc3VjaCBhIHBhdGgsIHdlIG11c3QgTk9UIHdhbGsgdXAgdG8gdGhlXG4gKiBwcm9qZWN0IHJvb3QncyAuZ3NkIFx1MjAxNCBlYWNoIHdvcmt0cmVlIG1hbmFnZXMgaXRzIG93biAuZ3NkIHN0YXRlICgjMjU5NCkuXG4gKlxuICogTWF0Y2hlcyBib3RoIGZvcndhcmQtc2xhc2ggYW5kIHBsYXRmb3JtLW5hdGl2ZSBzZXBhcmF0b3JzIHRvIGhhbmRsZVxuICogV2luZG93cyBwYXRocyAocGF0aC5zZXAgPSAnXFxcXCcpIGFuZCBub3JtYWxpemVkIFVuaXggcGF0aHMuXG4gKi9cbmZ1bmN0aW9uIGlzSW5zaWRlR3NkV29ya3RyZWUocDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIC8vIE1hdGNoIC8uZ3NkL3dvcmt0cmVlcy88bmFtZT4gd2hlcmUgPG5hbWU+IGlzIHRoZSBmaW5hbCBzZWdtZW50IG9yXG4gIC8vIGZvbGxvd2VkIGJ5IGEgc2VwYXJhdG9yLiBUaGUgPG5hbWU+IHNlZ21lbnQgbXVzdCBiZSBub24tZW1wdHkuXG4gIGNvbnN0IHNlcEZ3ZCA9IFwiL1wiO1xuICBjb25zdCBzZXBOYXRpdmUgPSBcIlxcXFxcIjtcbiAgY29uc3QgbWFya2VycyA9IFtcbiAgICBgJHtzZXBGd2R9LmdzZCR7c2VwRndkfXdvcmt0cmVlcyR7c2VwRndkfWAsXG4gICAgYCR7c2VwTmF0aXZlfS5nc2Qke3NlcE5hdGl2ZX13b3JrdHJlZXMke3NlcE5hdGl2ZX1gLFxuICBdO1xuICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XG4gICAgY29uc3QgaWR4ID0gcC5pbmRleE9mKG1hcmtlcik7XG4gICAgaWYgKGlkeCA9PT0gLTEpIGNvbnRpbnVlO1xuICAgIC8vIFZlcmlmeSB0aGVyZSdzIGEgbm9uLWVtcHR5IHdvcmt0cmVlIG5hbWUgYWZ0ZXIgdGhlIG1hcmtlclxuICAgIGNvbnN0IGFmdGVyTWFya2VyID0gcC5zbGljZShpZHggKyBtYXJrZXIubGVuZ3RoKTtcbiAgICAvLyBUaGUgbmFtZSBpcyBldmVyeXRoaW5nIHVwIHRvIHRoZSBuZXh0IHNlcGFyYXRvciAob3IgZW5kIG9mIHN0cmluZylcbiAgICBjb25zdCBuYW1lRW5kID0gYWZ0ZXJNYXJrZXIuc2VhcmNoKC9bL1xcXFxdLyk7XG4gICAgY29uc3QgbmFtZSA9IG5hbWVFbmQgPT09IC0xID8gYWZ0ZXJNYXJrZXIgOiBhZnRlck1hcmtlci5zbGljZSgwLCBuYW1lRW5kKTtcbiAgICBpZiAobmFtZS5sZW5ndGggPiAwKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIHByb2JlR3NkUm9vdChyYXdCYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgY29udHJhY3QgPSByZXNvbHZlR3NkUGF0aENvbnRyYWN0KHJhd0Jhc2VQYXRoKTtcbiAgaWYgKGNvbnRyYWN0LmlzV29ya3RyZWUpIHJldHVybiBjb250cmFjdC5wcm9qZWN0R3NkO1xuXG4gIC8vIDEuIEZhc3QgcGF0aCBcdTIwMTQgY2hlY2sgdGhlIGlucHV0IHBhdGggZGlyZWN0bHlcbiAgY29uc3QgbG9jYWwgPSBqb2luKHJhd0Jhc2VQYXRoLCBcIi5nc2RcIik7XG4gIGlmIChleGlzdHNTeW5jKGxvY2FsKSkgcmV0dXJuIGxvY2FsO1xuXG4gIC8vIDFiLiBXb3JrdHJlZSBndWFyZCAoIzI1OTQpIFx1MjAxNCBpZiBiYXNlUGF0aCBpcyBpbnNpZGUgYSAuZ3NkL3dvcmt0cmVlcy88bmFtZT4vXG4gIC8vICAgICBzdHJ1Y3R1cmUsIHJldHVybiB0aGUgd29ya3RyZWUtbG9jYWwgLmdzZCBwYXRoIGltbWVkaWF0ZWx5LiBXaXRob3V0IHRoaXMsXG4gIC8vICAgICB0aGUgZ2l0LXJvb3QgcHJvYmUgKHN0ZXAgMikgb3Igd2Fsay11cCAoc3RlcCAzKSBlc2NhcGVzIHRvIHRoZSBwcm9qZWN0XG4gIC8vICAgICByb290J3MgLmdzZCwgY2F1c2luZyBlbnN1cmVQcmVjb25kaXRpb25zKCkgYW5kIGRlcml2ZVN0YXRlKCkgdG8gcmVhZC93cml0ZVxuICAvLyAgICAgc3RhdGUgaW4gdGhlIHdyb25nIGxvY2F0aW9uLlxuICBpZiAoaXNJbnNpZGVHc2RXb3JrdHJlZShyYXdCYXNlUGF0aCkpIHJldHVybiBsb2NhbDtcblxuICAvLyBSZXNvbHZlIHN5bWxpbmtzIHNvIHBhdGggY29tcGFyaXNvbnMgd29yayBjb3JyZWN0bHkgYWNyb3NzIHBsYXRmb3Jtc1xuICAvLyAoZS5nLiBtYWNPUyAvdmFyIFx1MjE5MiAvcHJpdmF0ZS92YXIpLiBVc2UgcmF3QmFzZVBhdGggYXMgZmFsbGJhY2sgaWYgbm90IHJlc29sdmFibGUuXG4gIGxldCBiYXNlUGF0aDogc3RyaW5nO1xuICB0cnkgeyBiYXNlUGF0aCA9IHJlYWxwYXRoU3luYy5uYXRpdmUocmF3QmFzZVBhdGgpOyB9IGNhdGNoIHsgYmFzZVBhdGggPSByYXdCYXNlUGF0aDsgfVxuXG4gIC8vIEFsc28gY2hlY2sgdGhlIHJlc29sdmVkIHBhdGggZm9yIHRoZSB3b3JrdHJlZSBwYXR0ZXJuIChtYWNPUyAvdG1wIFx1MjE5MiAvcHJpdmF0ZS90bXApXG4gIGlmIChiYXNlUGF0aCAhPT0gcmF3QmFzZVBhdGggJiYgaXNJbnNpZGVHc2RXb3JrdHJlZShiYXNlUGF0aCkpIHJldHVybiBsb2NhbDtcblxuICAvLyAyLiBHaXQgcm9vdCBhbmNob3IgXHUyMDE0IHVzZWQgYXMgYm90aCBwcm9iZSB0YXJnZXQgYW5kIHdhbGstdXAgYm91bmRhcnlcbiAgLy8gICAgT25seSB3YWxrIGlmIHdlJ3JlIGluc2lkZSBhIGdpdCBwcm9qZWN0IFx1MjAxNCBwcmV2ZW50cyBlc2NhcGluZyBpbnRvXG4gIC8vICAgIHVucmVsYXRlZCBmaWxlc3lzdGVtIHRlcnJpdG9yeSB3aGVuIHJ1bm5pbmcgb3V0c2lkZSBhbnkgcmVwby5cbiAgbGV0IGdpdFJvb3Q6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IG91dCA9IHNwYXduU3luYyhcImdpdFwiLCBbXCJyZXYtcGFyc2VcIiwgXCItLXNob3ctdG9wbGV2ZWxcIl0sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgIH0pO1xuICAgIGlmIChvdXQuc3RhdHVzID09PSAwKSB7XG4gICAgICBjb25zdCByID0gb3V0LnN0ZG91dC50cmltKCk7XG4gICAgICBpZiAocikgZ2l0Um9vdCA9IG5vcm1hbGl6ZShyKTtcbiAgICB9XG4gIH0gY2F0Y2ggeyAvKiBnaXQgbm90IGF2YWlsYWJsZSAqLyB9XG5cbiAgLy8gQ29tcHV0ZSBnc2RIb21lIG9uY2UgZm9yIHRoZSBza2lwLWNoZWNrIHVzZWQgaW4gc3RlcHMgMiBhbmQgMy5cbiAgY29uc3Qgbm9ybVBhdGggPSAocDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICBsZXQgcjogc3RyaW5nO1xuICAgIHRyeSB7IHIgPSByZWFscGF0aFN5bmMubmF0aXZlKHApOyB9IGNhdGNoIHsgciA9IHA7IH1cbiAgICBjb25zdCBzID0gci5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIikucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgICByZXR1cm4gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gcy50b0xvd2VyQ2FzZSgpIDogcztcbiAgfTtcbiAgbGV0IGdzZEhvbWVOb3JtOiBzdHJpbmc7XG4gIHRyeSB7IGdzZEhvbWVOb3JtID0gbm9ybVBhdGgoZ3NkSG9tZSgpKTsgfSBjYXRjaCB7IGdzZEhvbWVOb3JtID0gXCJcIjsgfVxuXG4gIGlmIChnaXRSb290KSB7XG4gICAgY29uc3QgY2FuZGlkYXRlID0gam9pbihnaXRSb290LCBcIi5nc2RcIik7XG4gICAgLy8gU2tpcCBpZiB0aGUgY2FuZGlkYXRlIHJlc29sdmVzIHRvIHRoZSBnbG9iYWwgR1NEIGhvbWUgXHUyMDE0IGEgc3ViZGlyIGJhc2VQYXRoXG4gICAgLy8gbXVzdCBub3QgYmUgYW5jaG9yZWQgdG8gfi8uZ3NkIGp1c3QgYmVjYXVzZSAkSE9NRSBpcyBhIGdpdCByZXBvLlxuICAgIGlmIChleGlzdHNTeW5jKGNhbmRpZGF0ZSkgJiYgbm9ybVBhdGgoY2FuZGlkYXRlKSAhPT0gZ3NkSG9tZU5vcm0pIHJldHVybiBjYW5kaWRhdGU7XG4gIH1cblxuICAvLyAzLiBXYWxrIHVwIGZyb20gYmFzZVBhdGggdG8gdGhlIGdpdCByb290IChvbmx5IGlmIHdlIGFyZSBpbiBhIHN1YmRpcmVjdG9yeSlcbiAgaWYgKGdpdFJvb3QgJiYgYmFzZVBhdGggIT09IGdpdFJvb3QpIHtcbiAgICBsZXQgY3VyID0gZGlybmFtZShiYXNlUGF0aCk7XG4gICAgd2hpbGUgKGN1ciAhPT0gYmFzZVBhdGgpIHtcbiAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IGpvaW4oY3VyLCBcIi5nc2RcIik7XG4gICAgICBpZiAoZXhpc3RzU3luYyhjYW5kaWRhdGUpICYmIG5vcm1QYXRoKGNhbmRpZGF0ZSkgIT09IGdzZEhvbWVOb3JtKSByZXR1cm4gY2FuZGlkYXRlO1xuICAgICAgaWYgKGN1ciA9PT0gZ2l0Um9vdCkgYnJlYWs7XG4gICAgICBiYXNlUGF0aCA9IGN1cjtcbiAgICAgIGN1ciA9IGRpcm5hbWUoY3VyKTtcbiAgICB9XG4gIH1cblxuICAvLyA0LiBGYWxsYmFjayBmb3IgaW5pdC9jcmVhdGlvblxuICByZXR1cm4gbG9jYWw7XG59XG5leHBvcnQgZnVuY3Rpb24gbWlsZXN0b25lc0RpcihiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwibWlsZXN0b25lc1wiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVSdW50aW1lRmlsZShiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiUlVOVElNRS5tZFwiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVHc2RSb290RmlsZShiYXNlUGF0aDogc3RyaW5nLCBrZXk6IEdTRFJvb3RGaWxlS2V5KTogc3RyaW5nIHtcbiAgY29uc3Qgcm9vdCA9IGdzZFJvb3QoYmFzZVBhdGgpO1xuICBjb25zdCBjYW5vbmljYWwgPSBqb2luKHJvb3QsIEdTRF9ST09UX0ZJTEVTW2tleV0pO1xuICBpZiAoZXhpc3RzU3luYyhjYW5vbmljYWwpKSByZXR1cm4gY2Fub25pY2FsO1xuICBjb25zdCBsZWdhY3kgPSBqb2luKHJvb3QsIExFR0FDWV9HU0RfUk9PVF9GSUxFU1trZXldKTtcbiAgaWYgKGV4aXN0c1N5bmMobGVnYWN5KSkgcmV0dXJuIGxlZ2FjeTtcbiAgcmV0dXJuIGNhbm9uaWNhbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbEdzZFJvb3RGaWxlKGtleTogR1NEUm9vdEZpbGVLZXkpOiBzdHJpbmcge1xuICByZXR1cm4gYC5nc2QvJHtHU0RfUk9PVF9GSUxFU1trZXldfWA7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZnVsbCBwYXRoIHRvIGEgbWlsZXN0b25lIGRpcmVjdG9yeS5cbiAqIFJldHVybnMgbnVsbCBpZiB0aGUgbWlsZXN0b25lIGRvZXNuJ3QgZXhpc3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlTWlsZXN0b25lUGF0aChiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGRpciA9IHJlc29sdmVEaXIobWlsZXN0b25lc0RpcihiYXNlUGF0aCksIG1pbGVzdG9uZUlkKTtcbiAgcmV0dXJuIGRpciA/IGpvaW4obWlsZXN0b25lc0RpcihiYXNlUGF0aCksIGRpcikgOiBudWxsO1xufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGZ1bGwgcGF0aCB0byBhIG1pbGVzdG9uZSBmaWxlIChlLmcuIFJPQURNQVAsIENPTlRFWFQsIFJFU0VBUkNIKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVNaWxlc3RvbmVGaWxlKFxuICBiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nLCBzdWZmaXg6IHN0cmluZ1xuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG1EaXIgPSByZXNvbHZlTWlsZXN0b25lUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICBpZiAoIW1EaXIpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gcmVzb2x2ZUZpbGUobURpciwgbWlsZXN0b25lSWQsIHN1ZmZpeCk7XG4gIHJldHVybiBmaWxlID8gam9pbihtRGlyLCBmaWxlKSA6IG51bGw7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZnVsbCBwYXRoIHRvIGEgc2xpY2UgZGlyZWN0b3J5IHdpdGhpbiBhIG1pbGVzdG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTbGljZVBhdGgoXG4gIGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZ1xuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG1EaXIgPSByZXNvbHZlTWlsZXN0b25lUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICBpZiAoIW1EaXIpIHJldHVybiBudWxsO1xuICBjb25zdCBzbGljZXNEaXIgPSBqb2luKG1EaXIsIFwic2xpY2VzXCIpO1xuICBjb25zdCBkaXIgPSByZXNvbHZlRGlyKHNsaWNlc0Rpciwgc2xpY2VJZCk7XG4gIHJldHVybiBkaXIgPyBqb2luKHNsaWNlc0RpciwgZGlyKSA6IG51bGw7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgZnVsbCBwYXRoIHRvIGEgc2xpY2UgZmlsZSAoZS5nLiBQTEFOLCBSRVNFQVJDSCwgQ09OVEVYVCwgU1VNTUFSWSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlU2xpY2VGaWxlKFxuICBiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmcsIHN1ZmZpeDogc3RyaW5nXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3Qgc0RpciA9IHJlc29sdmVTbGljZVBhdGgoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkKTtcbiAgaWYgKCFzRGlyKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IHJlc29sdmVGaWxlKHNEaXIsIHNsaWNlSWQsIHN1ZmZpeCk7XG4gIHJldHVybiBmaWxlID8gam9pbihzRGlyLCBmaWxlKSA6IG51bGw7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgdGFza3MgZGlyZWN0b3J5IHdpdGhpbiBhIHNsaWNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVRhc2tzRGlyKFxuICBiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nLCBzbGljZUlkOiBzdHJpbmdcbik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBzRGlyID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBpZiAoIXNEaXIpIHJldHVybiBudWxsO1xuICBjb25zdCB0RGlyID0gam9pbihzRGlyLCBcInRhc2tzXCIpO1xuICByZXR1cm4gZXhpc3RzU3luYyh0RGlyKSA/IHREaXIgOiBudWxsO1xufVxuXG4vKipcbiAqIFJlc29sdmUgYSBzcGVjaWZpYyB0YXNrIGZpbGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlVGFza0ZpbGUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyxcbiAgdGFza0lkOiBzdHJpbmcsIHN1ZmZpeDogc3RyaW5nXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgdERpciA9IHJlc29sdmVUYXNrc0RpcihiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBpZiAoIXREaXIpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gcmVzb2x2ZUZpbGUodERpciwgdGFza0lkLCBzdWZmaXgpO1xuICByZXR1cm4gZmlsZSA/IGpvaW4odERpciwgZmlsZSkgOiBudWxsO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmVsYXRpdmUgUGF0aCBCdWlsZGVycyAoZm9yIHByb21wdHMgXHUyMDE0IC5nc2QvbWlsZXN0b25lcy8uLi4pIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEJ1aWxkIHJlbGF0aXZlIC5nc2QvIHBhdGggdG8gYSBtaWxlc3RvbmUgZGlyZWN0b3J5LlxuICogVXNlcyB0aGUgYWN0dWFsIGRpcmVjdG9yeSBuYW1lIG9uIGRpc2sgaWYgaXQgZXhpc3RzLCBvdGhlcndpc2UgYmFyZSBJRC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbE1pbGVzdG9uZVBhdGgoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGRpciA9IHJlc29sdmVEaXIobWlsZXN0b25lc0RpcihiYXNlUGF0aCksIG1pbGVzdG9uZUlkKTtcbiAgaWYgKGRpcikgcmV0dXJuIGAuZ3NkL21pbGVzdG9uZXMvJHtkaXJ9YDtcbiAgcmV0dXJuIGAuZ3NkL21pbGVzdG9uZXMvJHttaWxlc3RvbmVJZH1gO1xufVxuXG4vKipcbiAqIEJ1aWxkIHJlbGF0aXZlIC5nc2QvIHBhdGggdG8gYSBtaWxlc3RvbmUgZmlsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbE1pbGVzdG9uZUZpbGUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHN1ZmZpeDogc3RyaW5nXG4pOiBzdHJpbmcge1xuICBjb25zdCBtUmVsID0gcmVsTWlsZXN0b25lUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICBjb25zdCBtRGlyID0gcmVzb2x2ZU1pbGVzdG9uZVBhdGgoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgaWYgKG1EaXIpIHtcbiAgICBjb25zdCBmaWxlID0gcmVzb2x2ZUZpbGUobURpciwgbWlsZXN0b25lSWQsIHN1ZmZpeCk7XG4gICAgaWYgKGZpbGUpIHJldHVybiBgJHttUmVsfS8ke2ZpbGV9YDtcbiAgfVxuICByZXR1cm4gYCR7bVJlbH0vJHtidWlsZE1pbGVzdG9uZUZpbGVOYW1lKG1pbGVzdG9uZUlkLCBzdWZmaXgpfWA7XG59XG5cbi8qKlxuICogQnVpbGQgcmVsYXRpdmUgLmdzZC8gcGF0aCB0byBhIHNsaWNlIGRpcmVjdG9yeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbFNsaWNlUGF0aChcbiAgYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nXG4pOiBzdHJpbmcge1xuICBjb25zdCBtUmVsID0gcmVsTWlsZXN0b25lUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICBjb25zdCBtRGlyID0gcmVzb2x2ZU1pbGVzdG9uZVBhdGgoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgaWYgKG1EaXIpIHtcbiAgICBjb25zdCBzbGljZXNEaXIgPSBqb2luKG1EaXIsIFwic2xpY2VzXCIpO1xuICAgIGNvbnN0IGRpciA9IHJlc29sdmVEaXIoc2xpY2VzRGlyLCBzbGljZUlkKTtcbiAgICBpZiAoZGlyKSByZXR1cm4gYCR7bVJlbH0vc2xpY2VzLyR7ZGlyfWA7XG4gIH1cbiAgcmV0dXJuIGAke21SZWx9L3NsaWNlcy8ke3NsaWNlSWR9YDtcbn1cblxuLyoqXG4gKiBCdWlsZCByZWxhdGl2ZSAuZ3NkLyBwYXRoIHRvIGEgc2xpY2UgZmlsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbFNsaWNlRmlsZShcbiAgYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCBzdWZmaXg6IHN0cmluZ1xuKTogc3RyaW5nIHtcbiAgY29uc3Qgc1JlbCA9IHJlbFNsaWNlUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBjb25zdCBzRGlyID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICBpZiAoc0Rpcikge1xuICAgIGNvbnN0IGZpbGUgPSByZXNvbHZlRmlsZShzRGlyLCBzbGljZUlkLCBzdWZmaXgpO1xuICAgIGlmIChmaWxlKSByZXR1cm4gYCR7c1JlbH0vJHtmaWxlfWA7XG4gIH1cbiAgcmV0dXJuIGAke3NSZWx9LyR7YnVpbGRTbGljZUZpbGVOYW1lKHNsaWNlSWQsIHN1ZmZpeCl9YDtcbn1cblxuLyoqXG4gKiBCdWlsZCByZWxhdGl2ZSAuZ3NkLyBwYXRoIHRvIGEgdGFzayBmaWxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVsVGFza0ZpbGUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcsIHNsaWNlSWQ6IHN0cmluZyxcbiAgdGFza0lkOiBzdHJpbmcsIHN1ZmZpeDogc3RyaW5nXG4pOiBzdHJpbmcge1xuICBjb25zdCBzUmVsID0gcmVsU2xpY2VQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gIGNvbnN0IHREaXIgPSByZXNvbHZlVGFza3NEaXIoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkKTtcbiAgaWYgKHREaXIpIHtcbiAgICBjb25zdCBmaWxlID0gcmVzb2x2ZUZpbGUodERpciwgdGFza0lkLCBzdWZmaXgpO1xuICAgIGlmIChmaWxlKSByZXR1cm4gYCR7c1JlbH0vdGFza3MvJHtmaWxlfWA7XG4gIH1cbiAgcmV0dXJuIGAke3NSZWx9L3Rhc2tzLyR7YnVpbGRUYXNrRmlsZU5hbWUodGFza0lkLCBzdWZmaXgpfWA7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFZQSxTQUFTLGFBQWEsWUFBWSxjQUFjLGNBQWM7QUFDOUQsU0FBUyxNQUFNLFNBQVMsV0FBVyxlQUFlO0FBQ2xELFNBQVMsZUFBZTtBQUN4QixTQUFTLGlCQUFpQjtBQUMxQixTQUFTLHlCQUE0QztBQUNyRCxTQUFTLHFCQUFxQjtBQUM5QixTQUFTLGVBQWU7QUFDeEIsU0FBUyxtQkFBbUIsa0NBQWtDO0FBSTlELE1BQU0sZ0JBQWdCLG9CQUFJLElBQXNCO0FBQ2hELE1BQU0sZUFBZSxvQkFBSSxJQUFzQjtBQU0vQyxJQUFJLGtCQUFzRDtB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
