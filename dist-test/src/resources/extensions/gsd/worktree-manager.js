import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { GSDError, GSD_PARSE_ERROR, GSD_STALE_STATE, GSD_LOCK_HELD, GSD_GIT_ERROR, GSD_MERGE_CONFLICT } from "./errors.js";
import { logWarning } from "./workflow-logger.js";
import {
  nativeBranchDelete,
  nativeBranchExists,
  nativeBranchForceReset,
  nativeCommit,
  nativeDetectMainBranch,
  nativeDiffContent,
  nativeDiffNameStatus,
  nativeDiffNumstat,
  nativeGetCurrentBranch,
  nativeIsAncestor,
  nativeLogOneline,
  nativeMergeSquash,
  nativeWorktreeAdd,
  nativeWorktreeList,
  nativeWorktreePrune,
  nativeWorktreeRemove
} from "./native-git-bridge.js";
import { emitCanonicalRootRedirect } from "./worktree-telemetry.js";
import {
  isGsdWorktreePath,
  normalizeWorktreePathForCompare,
  resolveWorktreeProjectRoot
} from "./worktree-root.js";
function deleteBranchIfPresent(basePath, branch, warningPrefix) {
  try {
    if (!nativeBranchExists(basePath, branch)) return;
    nativeBranchDelete(basePath, branch, true);
  } catch (e) {
    logWarning("worktree", `${warningPrefix}: ${e.message}`);
  }
}
function normalizePathForComparison(path) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function normalizeBasePathForWorktreeOps(basePath) {
  const resolved = resolveWorktreeProjectRoot(basePath);
  if (isGsdWorktreePath(basePath) && normalizeWorktreePathForCompare(resolved) === normalizeWorktreePathForCompare(basePath)) {
    throw new GSDError(
      GSD_GIT_ERROR,
      `Cannot resolve project root from worktree path: ${basePath}. Run the command from the project root or set GSD_PROJECT_ROOT.`
    );
  }
  return resolved;
}
function resolveGitDir(basePath) {
  const gitPath = join(basePath, ".git");
  if (!existsSync(gitPath)) return gitPath;
  if (lstatSync(gitPath).isDirectory()) return gitPath;
  try {
    const content = readFileSync(gitPath, "utf-8").trim();
    if (content.startsWith("gitdir: ")) {
      return resolve(basePath, content.slice(8));
    }
  } catch (e) {
    logWarning("worktree", `.git file read failed: ${e.message}`);
  }
  return gitPath;
}
function worktreesDir(basePath) {
  return join(resolveWorktreeProjectRoot(basePath), ".gsd", "worktrees");
}
function worktreePath(basePath, name) {
  return join(worktreesDir(basePath), name);
}
function worktreeBranchName(name) {
  return `worktree/${name}`;
}
function isInsideWorktreesDir(basePath, targetPath) {
  const wtDirPath = worktreesDir(basePath);
  const wtDir = existsSync(wtDirPath) ? realpathSync(wtDirPath) : resolve(wtDirPath);
  const resolved = existsSync(targetPath) ? realpathSync(targetPath) : resolve(targetPath);
  return resolved === wtDir || resolved.startsWith(wtDir + sep);
}
function resolveCanonicalMilestoneRoot(basePath, milestoneId) {
  if (!milestoneId || /[\/\\]|\.\./.test(milestoneId)) return basePath;
  const wtPath = worktreePath(basePath, milestoneId);
  if (!existsSync(wtPath)) return basePath;
  const gitPath = join(wtPath, ".git");
  if (!existsSync(gitPath)) return basePath;
  try {
    const stat = lstatSync(gitPath);
    if (!stat.isFile()) return basePath;
  } catch {
    return basePath;
  }
  try {
    emitCanonicalRootRedirect(basePath, milestoneId, wtPath);
  } catch (err) {
    logWarning("worktree", `canonical-root-redirect telemetry failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return wtPath;
}
function createWorktree(basePath, name, opts = {}) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new GSDError(GSD_PARSE_ERROR, `Invalid worktree name "${name}". Use only letters, numbers, hyphens, and underscores.`);
  }
  const wtPath = worktreePath(basePath, name);
  const branch = opts.branch ?? worktreeBranchName(name);
  if (existsSync(wtPath)) {
    const gitFilePath = join(wtPath, ".git");
    if (!existsSync(gitFilePath)) {
      logWarning("reconcile", `Removing stale worktree directory (no .git file): ${wtPath}`, { worktree: name });
      rmSync(wtPath, { recursive: true, force: true });
    } else {
      throw new GSDError(GSD_STALE_STATE, `Worktree "${name}" already exists at ${wtPath}`);
    }
  }
  const wtDir = worktreesDir(basePath);
  mkdirSync(wtDir, { recursive: true });
  nativeWorktreePrune(basePath);
  const startPoint = opts.startPoint ?? nativeDetectMainBranch(basePath);
  if (!startPoint || startPoint.length === 0) {
    throw new GSDError(
      GSD_GIT_ERROR,
      "Repository has no commits yet (unborn branch). Make an initial commit before creating worktrees."
    );
  }
  const branchAlreadyExists = nativeBranchExists(basePath, branch);
  if (branchAlreadyExists) {
    const worktreeEntries = nativeWorktreeList(basePath);
    const branchInUse = worktreeEntries.some((entry) => entry.branch === branch);
    if (branchInUse) {
      throw new GSDError(
        GSD_LOCK_HELD,
        `Branch "${branch}" is already in use by another worktree. Remove the existing worktree first with /worktree remove ${name}.`
      );
    }
    if (opts.reuseExistingBranch) {
      nativeWorktreeAdd(basePath, wtPath, branch);
    } else {
      const branchIsAncestor = nativeIsAncestor(basePath, branch, startPoint);
      if (!branchIsAncestor) {
        throw new GSDError(
          GSD_GIT_ERROR,
          `Branch "${branch}" already exists with commits not reachable from "${startPoint}". Refusing to force-reset \u2014 would orphan prior work. If you intend to keep those commits, retry with reuseExistingBranch=true. If you intend to discard, run \`git branch -D ${branch}\` manually first.`
        );
      }
      nativeBranchForceReset(basePath, branch, startPoint);
      nativeWorktreeAdd(basePath, wtPath, branch);
    }
  } else {
    nativeWorktreeAdd(basePath, wtPath, branch, true, startPoint);
  }
  return {
    name,
    path: wtPath,
    branch,
    exists: true
  };
}
function listWorktrees(basePath) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  const baseVariants = [resolve(basePath)];
  if (existsSync(basePath)) {
    baseVariants.push(realpathSync(basePath));
  }
  const seenRoots = /* @__PURE__ */ new Set();
  const worktreeRoots = baseVariants.map((baseVariant) => {
    const path = join(baseVariant, ".gsd", "worktrees");
    return {
      normalized: normalizePathForComparison(path)
    };
  }).filter((root) => {
    if (seenRoots.has(root.normalized)) return false;
    seenRoots.add(root.normalized);
    return true;
  });
  const entries = nativeWorktreeList(basePath);
  if (!entries.length) return [];
  const worktrees = [];
  for (const entry of entries) {
    if (entry.isBare) continue;
    const entryPath = entry.path;
    const branch = entry.branch;
    if (!branch) continue;
    const branchWorktreeName = branch.startsWith("worktree/") ? branch.slice("worktree/".length) : branch.startsWith("milestone/") ? branch.slice("milestone/".length) : null;
    const entryVariants = [resolve(entryPath)];
    if (existsSync(entryPath)) {
      entryVariants.push(realpathSync(entryPath));
    }
    const normalizedEntryVariants = [...new Set(entryVariants.map(normalizePathForComparison))];
    const matchedRoot = worktreeRoots.find(
      (root) => normalizedEntryVariants.some((entryVariant) => entryVariant.startsWith(`${root.normalized}/`))
    );
    const matchesBranchLeaf = branchWorktreeName ? normalizedEntryVariants.some((entryVariant) => entryVariant.split("/").pop() === branchWorktreeName) : false;
    if (!matchedRoot && !matchesBranchLeaf) continue;
    const matchedEntryPath = normalizedEntryVariants.find(
      (entryVariant) => matchedRoot ? entryVariant.startsWith(`${matchedRoot.normalized}/`) : false
    );
    let name = matchedRoot ? matchedEntryPath?.slice(matchedRoot.normalized.length + 1) ?? "" : "";
    if ((!name || name.includes("/")) && branchWorktreeName && matchesBranchLeaf) {
      name = branchWorktreeName;
    }
    if (!name || name.includes("/")) continue;
    const resolvedEntryPath = existsSync(entryPath) ? realpathSync(entryPath) : resolve(entryPath);
    worktrees.push({
      name,
      path: resolvedEntryPath,
      branch,
      exists: existsSync(resolvedEntryPath)
    });
  }
  return worktrees;
}
const NESTED_GIT_SKIP_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".gsd",
  ".bg-shell",
  "node_modules",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "__pycache__",
  ".tox",
  ".venv",
  "venv",
  "target",
  "vendor"
]);
function findNestedGitDirs(rootPath) {
  const results = [];
  function walk(dir, depth) {
    if (depth > 10) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch (e) {
      logWarning("worktree", `readdirSync failed: ${e.message}`);
      return;
    }
    for (const entry of entries) {
      if (NESTED_GIT_SKIP_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch (e) {
        logWarning("worktree", `lstatSync failed for ${fullPath}: ${e.message}`);
        continue;
      }
      if (!stat.isDirectory()) continue;
      const innerGit = join(fullPath, ".git");
      try {
        const innerStat = lstatSync(innerGit);
        if (innerStat.isDirectory()) {
          results.push(fullPath);
          continue;
        }
      } catch (e) {
        if (e.code !== "ENOENT") {
          logWarning("worktree", `existsSync/.git check failed for ${fullPath}: ${e.message}`);
        }
      }
      walk(fullPath, depth + 1);
    }
  }
  walk(rootPath, 0);
  return results;
}
function removeWorktree(basePath, name, opts = {}) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  let wtPath = worktreePath(basePath, name);
  const branch = opts.branch ?? worktreeBranchName(name);
  const { deleteBranch = true, force = true } = opts;
  let gitReportedPath = null;
  try {
    const entries = nativeWorktreeList(basePath);
    const entry = entries.find((e) => e.branch === branch);
    if (entry?.path) {
      gitReportedPath = entry.path;
    }
  } catch (e) {
    logWarning("worktree", `nativeWorktreeList parse failed: ${e.message}`);
  }
  if (gitReportedPath && isInsideWorktreesDir(basePath, gitReportedPath)) {
    wtPath = gitReportedPath;
  } else if (gitReportedPath) {
    console.error(
      `[GSD] WARNING: git worktree list reported path outside .gsd/worktrees/: ${gitReportedPath}
  Refusing to use it for removal \u2014 falling back to computed path: ${wtPath}`
    );
    try {
      nativeWorktreeRemove(basePath, gitReportedPath, false);
    } catch (e) {
      logWarning("worktree", `non-force worktree remove failed for ${gitReportedPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const resolvedWtPath = existsSync(wtPath) ? realpathSync(wtPath) : wtPath;
  const resolvedPathSafe = isInsideWorktreesDir(basePath, resolvedWtPath);
  const cwd = process.cwd();
  const resolvedCwd = existsSync(cwd) ? realpathSync(cwd) : cwd;
  if (resolvedCwd === resolvedWtPath || resolvedCwd.startsWith(resolvedWtPath + sep)) {
    process.chdir(basePath);
  }
  if (!existsSync(wtPath)) {
    nativeWorktreePrune(basePath);
    if (deleteBranch) {
      deleteBranchIfPresent(basePath, branch, "nativeBranchDelete failed");
    }
    return;
  }
  let hasSubmoduleChanges = false;
  const gitmodulesPath = join(resolvedWtPath, ".gitmodules");
  if (existsSync(gitmodulesPath)) {
    try {
      const submoduleStatus = execFileSync(
        "git",
        ["submodule", "status"],
        { cwd: resolvedWtPath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
      ).trim();
      hasSubmoduleChanges = submoduleStatus.split("\n").some(
        (line) => line.startsWith("+") || line.startsWith("-")
      );
      if (hasSubmoduleChanges) {
        const rescueBranch = `gsd/submodule-rescue/${name}-${Date.now()}`;
        try {
          execFileSync(
            "git",
            ["add", "-A"],
            { cwd: resolvedWtPath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
          );
          execFileSync(
            "git",
            ["commit", "-m", `gsd: rescue submodule changes from worktree ${name}`, "--allow-empty"],
            { cwd: resolvedWtPath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
          );
          execFileSync(
            "git",
            ["branch", rescueBranch, "HEAD"],
            { cwd: resolvedWtPath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
          );
          logWarning(
            "reconcile",
            `Saved uncommitted submodule changes to rescue branch ${rescueBranch}`,
            { worktree: name, path: resolvedWtPath, rescueBranch }
          );
        } catch (err) {
          logWarning(
            "reconcile",
            `Submodule rescue branch creation failed \u2014 changes may be lost during force removal: ${err instanceof Error ? err.message : String(err)}`,
            { worktree: name, path: resolvedWtPath }
          );
        }
      }
    } catch (e) {
      logWarning("worktree", `submodule status check failed: ${e.message}`);
    }
  }
  const nestedGitDirs = findNestedGitDirs(resolvedWtPath);
  if (nestedGitDirs.length > 0) {
    for (const nestedDir of nestedGitDirs) {
      const nestedGitPath = join(nestedDir, ".git");
      try {
        rmSync(nestedGitPath, { recursive: true, force: true });
        logWarning(
          "reconcile",
          `Removed nested .git directory from scaffolded project to prevent data loss (#2616)`,
          { worktree: name, nestedRepo: nestedDir }
        );
      } catch {
        logWarning(
          "reconcile",
          `Failed to remove nested .git directory \u2014 files may be lost as orphaned gitlink`,
          { worktree: name, nestedRepo: nestedDir }
        );
      }
    }
  }
  if (resolvedPathSafe) {
    const useForce = hasSubmoduleChanges ? false : force;
    try {
      nativeWorktreeRemove(basePath, resolvedWtPath, useForce);
    } catch (e) {
      logWarning("worktree", `nativeWorktreeRemove failed: ${e.message}`);
    }
    if (existsSync(resolvedWtPath)) {
      try {
        nativeWorktreeRemove(basePath, resolvedWtPath, true);
      } catch (e) {
        logWarning("worktree", `nativeWorktreeRemove (force) failed: ${e.message}`);
      }
    }
    if (existsSync(resolvedWtPath)) {
      try {
        const wtInternalDir = join(basePath, ".git", "worktrees", name);
        if (existsSync(wtInternalDir)) {
          rmSync(wtInternalDir, { recursive: true, force: true });
        }
        rmSync(resolvedWtPath, { recursive: true, force: true });
        if (wtPath !== resolvedWtPath && existsSync(wtPath)) {
          rmSync(wtPath, { recursive: true, force: true });
        }
      } catch {
        logWarning(
          "reconcile",
          `Worktree directory could not be removed after git internal cleanup: ${resolvedWtPath}. Manual cleanup: rm -rf "${resolvedWtPath.replaceAll("\\", "/")}"`,
          { worktree: name }
        );
      }
    }
  } else {
    console.error(
      `[GSD] WARNING: Resolved worktree path is outside .gsd/worktrees/: ${resolvedWtPath}
  Skipping forced removal to prevent data loss.`
    );
    try {
      nativeWorktreeRemove(basePath, resolvedWtPath, false);
    } catch (e) {
      logWarning("worktree", `non-force worktree remove failed for ${resolvedWtPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  nativeWorktreePrune(basePath);
  if (deleteBranch) {
    deleteBranchIfPresent(basePath, branch, "final branch delete failed");
  }
}
const SKIP_PATHS = [
  ".gsd/worktrees/",
  ".gsd/runtime/",
  ".gsd/activity/",
  ".gsd/audit/",
  ".gsd/forensics/",
  ".gsd/parallel/",
  ".gsd/journal/"
];
const SKIP_EXACT = [
  ".gsd/STATE.md",
  ".gsd/auto.lock",
  ".gsd/metrics.json",
  ".gsd/state-manifest.json",
  ".gsd/doctor-history.jsonl",
  ".gsd/event-log.jsonl"
];
const SKIP_PREFIXES = [
  ".gsd/completed-units",
  ".gsd/gsd.db"
];
function shouldSkipPath(filePath) {
  if (SKIP_PATHS.some((p) => filePath.startsWith(p))) return true;
  if (SKIP_EXACT.includes(filePath)) return true;
  if (SKIP_PREFIXES.some((p) => filePath.startsWith(p))) return true;
  return false;
}
function parseDiffNameStatus(entries) {
  const added = [];
  const modified = [];
  const removed = [];
  for (const { status, path } of entries) {
    if (shouldSkipPath(path)) continue;
    switch (status) {
      case "A":
        added.push(path);
        break;
      case "M":
        modified.push(path);
        break;
      case "D":
        removed.push(path);
        break;
      default:
        if (status?.startsWith("R") || status?.startsWith("C")) {
          modified.push(path);
        }
    }
  }
  return { added, modified, removed };
}
function diffWorktreeGSD(basePath, name) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);
  const entries = nativeDiffNameStatus(basePath, mainBranch, branch, ".gsd/", true);
  return parseDiffNameStatus(entries);
}
function diffWorktreeAll(basePath, name, branchOverride) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  const branch = branchOverride ?? worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);
  const entries = nativeDiffNameStatus(basePath, mainBranch, branch);
  return parseDiffNameStatus(entries);
}
function diffWorktreeNumstat(basePath, name, branchOverride) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  const branch = branchOverride ?? worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);
  const rawStats = nativeDiffNumstat(basePath, mainBranch, branch);
  const stats = [];
  for (const entry of rawStats) {
    if (shouldSkipPath(entry.path)) continue;
    stats.push({ file: entry.path, added: entry.added, removed: entry.removed });
  }
  return stats;
}
function getWorktreeGSDDiff(basePath, name) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);
  return nativeDiffContent(basePath, mainBranch, branch, ".gsd/", void 0, true);
}
function getWorktreeCodeDiff(basePath, name) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);
  return nativeDiffContent(basePath, mainBranch, branch, void 0, ".gsd/", true);
}
function getWorktreeLog(basePath, name) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  const branch = worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);
  const entries = nativeLogOneline(basePath, mainBranch, branch);
  return entries.map((e) => `${e.sha} ${e.message}`).join("\n");
}
function mergeWorktreeToMain(basePath, name, commitMessage, branchOverride) {
  basePath = normalizeBasePathForWorktreeOps(basePath);
  const branch = branchOverride ?? worktreeBranchName(name);
  const mainBranch = nativeDetectMainBranch(basePath);
  const current = nativeGetCurrentBranch(basePath);
  if (current !== mainBranch) {
    throw new GSDError(GSD_GIT_ERROR, `Must be on ${mainBranch} to merge. Currently on ${current}.`);
  }
  const result = nativeMergeSquash(basePath, branch);
  if (!result.success) {
    throw new GSDError(GSD_MERGE_CONFLICT, `Merge conflicts detected in: ${result.conflicts.join(", ")}`);
  }
  nativeCommit(basePath, commitMessage);
  return commitMessage;
}
export {
  createWorktree,
  diffWorktreeAll,
  diffWorktreeGSD,
  diffWorktreeNumstat,
  findNestedGitDirs,
  getWorktreeCodeDiff,
  getWorktreeGSDDiff,
  getWorktreeLog,
  isInsideWorktreesDir,
  listWorktrees,
  mergeWorktreeToMain,
  removeWorktree,
  resolveCanonicalMilestoneRoot,
  resolveGitDir,
  worktreeBranchName,
  worktreePath,
  worktreesDir
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC93b3JrdHJlZS1tYW5hZ2VyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEdTRCBXb3JrdHJlZSBNYW5hZ2VyXG4gKlxuICogQ3JlYXRlcyBhbmQgbWFuYWdlcyBnaXQgd29ya3RyZWVzIHVuZGVyIC5nc2Qvd29ya3RyZWVzLzxuYW1lPi8uXG4gKiBFYWNoIHdvcmt0cmVlIGdldHMgaXRzIG93biBicmFuY2ggKHdvcmt0cmVlLzxuYW1lPikgYW5kIGEgZnVsbFxuICogd29ya2luZyBjb3B5IG9mIHRoZSBwcm9qZWN0LCBlbmFibGluZyBwYXJhbGxlbCB3b3JrIHN0cmVhbXMuXG4gKlxuICogVGhlIG1lcmdlIGhlbHBlciBjb21wYXJlcyAuZ3NkLyBhcnRpZmFjdHMgYmV0d2VlbiBhIHdvcmt0cmVlIGFuZFxuICogdGhlIG1haW4gYnJhbmNoLCB0aGVuIGRpc3BhdGNoZXMgYW4gTExNLWd1aWRlZCBtZXJnZSBmbG93LlxuICpcbiAqIEZsb3c6XG4gKiAgIDEuIGNyZWF0ZSgpICBcdTIwMTQgZ2l0IHdvcmt0cmVlIGFkZCAuZ3NkL3dvcmt0cmVlcy88bmFtZT4gLWIgd29ya3RyZWUvPG5hbWU+XG4gKiAgIDIuIHVzZXIgd29ya3MgaW4gdGhlIHdvcmt0cmVlIChuZXcgcGxhbnMsIG1pbGVzdG9uZXMsIGV0Yy4pXG4gKiAgIDMuIG1lcmdlKCkgICBcdTIwMTQgTExNLWd1aWRlZCByZWNvbmNpbGlhdGlvbiBvZiAuZ3NkLyBhcnRpZmFjdHMgYmFjayB0byBtYWluXG4gKiAgIDQuIHJlbW92ZSgpICBcdTIwMTQgZ2l0IHdvcmt0cmVlIHJlbW92ZSArIGJyYW5jaCBjbGVhbnVwXG4gKi9cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgbHN0YXRTeW5jLCBta2RpclN5bmMsIHJlYWRkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHJlYWxwYXRoU3luYywgcm1TeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGpvaW4sIHJlc29sdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IEdTREVycm9yLCBHU0RfUEFSU0VfRVJST1IsIEdTRF9TVEFMRV9TVEFURSwgR1NEX0xPQ0tfSEVMRCwgR1NEX0dJVF9FUlJPUiwgR1NEX01FUkdFX0NPTkZMSUNUIH0gZnJvbSBcIi4vZXJyb3JzLmpzXCI7XG5pbXBvcnQgeyBsb2dXYXJuaW5nIH0gZnJvbSBcIi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQge1xuICBuYXRpdmVCcmFuY2hEZWxldGUsXG4gIG5hdGl2ZUJyYW5jaEV4aXN0cyxcbiAgbmF0aXZlQnJhbmNoRm9yY2VSZXNldCxcbiAgbmF0aXZlQ29tbWl0LFxuICBuYXRpdmVEZXRlY3RNYWluQnJhbmNoLFxuICBuYXRpdmVEaWZmQ29udGVudCxcbiAgbmF0aXZlRGlmZk5hbWVTdGF0dXMsXG4gIG5hdGl2ZURpZmZOdW1zdGF0LFxuICBuYXRpdmVHZXRDdXJyZW50QnJhbmNoLFxuICBuYXRpdmVJc0FuY2VzdG9yLFxuICBuYXRpdmVMb2dPbmVsaW5lLFxuICBuYXRpdmVNZXJnZVNxdWFzaCxcbiAgbmF0aXZlV29ya3RyZWVBZGQsXG4gIG5hdGl2ZVdvcmt0cmVlTGlzdCxcbiAgbmF0aXZlV29ya3RyZWVQcnVuZSxcbiAgbmF0aXZlV29ya3RyZWVSZW1vdmUsXG59IGZyb20gXCIuL25hdGl2ZS1naXQtYnJpZGdlLmpzXCI7XG5pbXBvcnQgeyBlbWl0Q2Fub25pY2FsUm9vdFJlZGlyZWN0IH0gZnJvbSBcIi4vd29ya3RyZWUtdGVsZW1ldHJ5LmpzXCI7XG5pbXBvcnQge1xuICBpc0dzZFdvcmt0cmVlUGF0aCxcbiAgbm9ybWFsaXplV29ya3RyZWVQYXRoRm9yQ29tcGFyZSxcbiAgcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QsXG59IGZyb20gXCIuL3dvcmt0cmVlLXJvb3QuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmt0cmVlSW5mbyB7XG4gIG5hbWU6IHN0cmluZztcbiAgcGF0aDogc3RyaW5nO1xuICBicmFuY2g6IHN0cmluZztcbiAgZXhpc3RzOiBib29sZWFuO1xufVxuXG4vKiogUGVyLWZpbGUgbGluZSBjaGFuZ2Ugc3RhdHMgZnJvbSBnaXQgZGlmZiAtLW51bXN0YXQuICovXG5leHBvcnQgaW50ZXJmYWNlIEZpbGVMaW5lU3RhdCB7XG4gIGZpbGU6IHN0cmluZztcbiAgYWRkZWQ6IG51bWJlcjtcbiAgcmVtb3ZlZDogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFdvcmt0cmVlRGlmZlN1bW1hcnkge1xuICAvKiogRmlsZXMgb25seSBpbiB0aGUgd29ya3RyZWUgLmdzZC8gKG5ldyBhcnRpZmFjdHMpICovXG4gIGFkZGVkOiBzdHJpbmdbXTtcbiAgLyoqIEZpbGVzIGluIGJvdGggYnV0IHdpdGggZGlmZmVyZW50IGNvbnRlbnQgKi9cbiAgbW9kaWZpZWQ6IHN0cmluZ1tdO1xuICAvKiogRmlsZXMgb25seSBpbiBtYWluIC5nc2QvIChkZWxldGVkIGluIHdvcmt0cmVlKSAqL1xuICByZW1vdmVkOiBzdHJpbmdbXTtcbn1cblxuZnVuY3Rpb24gZGVsZXRlQnJhbmNoSWZQcmVzZW50KGJhc2VQYXRoOiBzdHJpbmcsIGJyYW5jaDogc3RyaW5nLCB3YXJuaW5nUHJlZml4OiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBpZiAoIW5hdGl2ZUJyYW5jaEV4aXN0cyhiYXNlUGF0aCwgYnJhbmNoKSkgcmV0dXJuO1xuICAgIG5hdGl2ZUJyYW5jaERlbGV0ZShiYXNlUGF0aCwgYnJhbmNoLCB0cnVlKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgJHt3YXJuaW5nUHJlZml4fTogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUGF0aCBIZWxwZXJzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBub3JtYWxpemVQYXRoRm9yQ29tcGFyaXNvbihwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gcGF0aFxuICAgIC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIilcbiAgICAucmVwbGFjZSgvXlxcL1xcL1xcP1xcLy8sIFwiXCIpXG4gICAgLnJlcGxhY2UoL1xcLyskLywgXCJcIik7XG4gIHJldHVybiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBub3JtYWxpemVkLnRvTG93ZXJDYXNlKCkgOiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVCYXNlUGF0aEZvcldvcmt0cmVlT3BzKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVXb3JrdHJlZVByb2plY3RSb290KGJhc2VQYXRoKTtcbiAgaWYgKFxuICAgIGlzR3NkV29ya3RyZWVQYXRoKGJhc2VQYXRoKSAmJlxuICAgIG5vcm1hbGl6ZVdvcmt0cmVlUGF0aEZvckNvbXBhcmUocmVzb2x2ZWQpID09PSBub3JtYWxpemVXb3JrdHJlZVBhdGhGb3JDb21wYXJlKGJhc2VQYXRoKVxuICApIHtcbiAgICB0aHJvdyBuZXcgR1NERXJyb3IoXG4gICAgICBHU0RfR0lUX0VSUk9SLFxuICAgICAgYENhbm5vdCByZXNvbHZlIHByb2plY3Qgcm9vdCBmcm9tIHdvcmt0cmVlIHBhdGg6ICR7YmFzZVBhdGh9LiBSdW4gdGhlIGNvbW1hbmQgZnJvbSB0aGUgcHJvamVjdCByb290IG9yIHNldCBHU0RfUFJPSkVDVF9ST09ULmAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcmVzb2x2ZWQ7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCByZXNvbHZlR2l0RGlyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGFjdHVhbCBnaXQgZGlyZWN0b3J5IGZvciBhIGdpdmVuIHJlcG9zaXRvcnkgcGF0aC5cbiAqXG4gKiBJbiBhIG5vcm1hbCByZXBvLCAuZ2l0IGlzIGEgZGlyZWN0b3J5IFx1MjE5MiByZXR1cm5zIGA8YmFzZVBhdGg+Ly5naXRgLlxuICogSW4gYSB3b3JrdHJlZSwgLmdpdCBpcyBhIGZpbGUgY29udGFpbmluZyBgZ2l0ZGlyOiA8cGF0aD5gIFx1MjE5MiByZXNvbHZlc1xuICogYW5kIHJldHVybnMgdGhhdCBwYXRoLlxuICpcbiAqIFRoaXMgaXMgY3JpdGljYWwgZm9yIG9wZXJhdGlvbnMgdGhhdCByZWZlcmVuY2UgZ2l0IG1ldGFkYXRhIGZpbGVzIGxpa2VcbiAqIE1FUkdFX0hFQUQsIFNRVUFTSF9NU0csIGV0Yy4gXHUyMDE0IHRoZXNlIGxpdmUgaW4gdGhlIGdpdCBkaXJlY3RvcnksIG5vdFxuICogaW4gdGhlIHdvcmtpbmcgdHJlZSByb290LiBXaXRob3V0IHRoaXMsIHdvcmt0cmVlIG1lcmdlcyBmYWlsIGJlY2F1c2VcbiAqIHRoZXkgbG9vayBmb3IgTUVSR0VfSEVBRCBpbiB0aGUgd3JvbmcgbG9jYXRpb24uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlR2l0RGlyKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBnaXRQYXRoID0gam9pbihiYXNlUGF0aCwgXCIuZ2l0XCIpO1xuICBpZiAoIWV4aXN0c1N5bmMoZ2l0UGF0aCkpIHJldHVybiBnaXRQYXRoO1xuICAvLyBJbiBhIG5vcm1hbCByZXBvIC5naXQgaXMgYSBkaXJlY3RvcnkgXHUyMDE0IHNraXAgdGhlIGZpbGUgcmVhZCAoIzM1OTcpXG4gIGlmIChsc3RhdFN5bmMoZ2l0UGF0aCkuaXNEaXJlY3RvcnkoKSkgcmV0dXJuIGdpdFBhdGg7XG4gIHRyeSB7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhnaXRQYXRoLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgICBpZiAoY29udGVudC5zdGFydHNXaXRoKFwiZ2l0ZGlyOiBcIikpIHtcbiAgICAgIHJldHVybiByZXNvbHZlKGJhc2VQYXRoLCBjb250ZW50LnNsaWNlKDgpKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYC5naXQgZmlsZSByZWFkIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgfVxuICByZXR1cm4gZ2l0UGF0aDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHdvcmt0cmVlc0RpcihiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4ocmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QoYmFzZVBhdGgpLCBcIi5nc2RcIiwgXCJ3b3JrdHJlZXNcIik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB3b3JrdHJlZVBhdGgoYmFzZVBhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4od29ya3RyZWVzRGlyKGJhc2VQYXRoKSwgbmFtZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB3b3JrdHJlZUJyYW5jaE5hbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGB3b3JrdHJlZS8ke25hbWV9YDtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSB0aGF0IGEgcGF0aCBpcyBpbnNpZGUgdGhlIC5nc2Qvd29ya3RyZWVzLyBkaXJlY3RvcnkuXG4gKiBSZXNvbHZlcyBzeW1saW5rcyBhbmQgbm9ybWFsaXplcyBcIi4uXCIgdHJhdmVyc2FscyBiZWZvcmUgY29tcGFyaXNvblxuICogc28gdGhhdCBhIHN5bWxpbmstcmVzb2x2ZWQgb3IgY3JhZnRlZCBwYXRoIGNhbm5vdCBlc2NhcGUgY29udGFpbm1lbnQuXG4gKlxuICogVXNlZCBhcyBhIHNhZmV0eSBnYXRlIGJlZm9yZSBhbnkgZGVzdHJ1Y3RpdmUgb3BlcmF0aW9uIChybVN5bmMsXG4gKiBuYXRpdmVXb3JrdHJlZVJlbW92ZSAtLWZvcmNlKSB0byBwcmV2ZW50ICMyMzY1LXN0eWxlIGRhdGEgbG9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSW5zaWRlV29ya3RyZWVzRGlyKGJhc2VQYXRoOiBzdHJpbmcsIHRhcmdldFBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCB3dERpclBhdGggPSB3b3JrdHJlZXNEaXIoYmFzZVBhdGgpO1xuICBjb25zdCB3dERpciA9IGV4aXN0c1N5bmMod3REaXJQYXRoKSA/IHJlYWxwYXRoU3luYyh3dERpclBhdGgpIDogcmVzb2x2ZSh3dERpclBhdGgpO1xuICBjb25zdCByZXNvbHZlZCA9IGV4aXN0c1N5bmModGFyZ2V0UGF0aCkgPyByZWFscGF0aFN5bmModGFyZ2V0UGF0aCkgOiByZXNvbHZlKHRhcmdldFBhdGgpO1xuICAvLyBUaGUgcmVzb2x2ZWQgcGF0aCBtdXN0IHN0YXJ0IHdpdGggdGhlIHdvcmt0cmVlcyBkaXIgZm9sbG93ZWQgYnkgYSBzZXBhcmF0b3IsXG4gIC8vIG5vdCBtZXJlbHkgYmUgYSBwcmVmaXggbWF0Y2ggKGUuZy4gXCIuZ3NkL3dvcmt0cmVlcy1leHRyYVwiIG11c3Qgbm90IG1hdGNoKS5cbiAgcmV0dXJuIHJlc29sdmVkID09PSB3dERpciB8fCByZXNvbHZlZC5zdGFydHNXaXRoKHd0RGlyICsgc2VwKTtcbn1cblxuLyoqXG4gKiBSZXR1cm4gdGhlIGNhbm9uaWNhbCBwYXRoIGZyb20gd2hpY2ggYSBtaWxlc3RvbmUncyBhcnRpZmFjdHMgc2hvdWxkIGJlIHJlYWQuXG4gKlxuICogSWYgYSBsaXZlIGdpdCB3b3JrdHJlZSBleGlzdHMgZm9yIHRoaXMgbWlsZXN0b25lIGF0IGAuZ3NkL3dvcmt0cmVlcy88TUlEPi9gXG4gKiAoZGlyZWN0b3J5IHByZXNlbnQgQU5EIGEgYC5naXRgIGZpbGUgaW5kaWNhdGluZyBhIHJlZ2lzdGVyZWQgd29ya3RyZWUpLFxuICogcmV0dXJucyB0aGF0IHdvcmt0cmVlIHBhdGguIE90aGVyd2lzZSByZXR1cm5zIGBiYXNlUGF0aGAgdW5jaGFuZ2VkLlxuICpcbiAqIFJlYWRlcnMgdGhhdCBjcm9zcyB0aGUgc2Vzc2lvbi93b3JrdHJlZSBib3VuZGFyeSAodmFsaWRhdG9ycywgdGhlIGJvb3RzdHJhcFxuICogYXVkaXQsIGNyb3NzLXNlc3Npb24gc3RhdGUgcXVlcmllcykgc2hvdWxkIHJvdXRlIHRocm91Z2ggdGhpcyBoZWxwZXIgc28gdGhleVxuICogZG9uJ3Qgc2lsZW50bHkgcmVhZCBzdGFsZSBwcm9qZWN0LXJvb3Qgc3RhdGUgd2hpbGUgbGl2ZSB3b3JrIHNpdHMgaW4gdGhlXG4gKiB3b3JrdHJlZS4gV3JpdGVycyBhbmQgdG9vbHMgd2hvc2UgY29udHJhY3QgaXMgXCJvcGVyYXRlIG9uIHRoZSBwYXRoIEkgd2FzXG4gKiBnaXZlblwiIHNob3VsZCBOT1QgdXNlIHRoaXMgaGVscGVyIFx1MjAxNCB0aGV5IHByZXNlcnZlIHRoZSBsZWdhY3kgYmVoYXZpb3IuXG4gKlxuICogQSBzdGFsZSB3b3JrdHJlZSBkaXJlY3RvcnkgKG5vIGAuZ2l0YCBmaWxlKSBpcyB0cmVhdGVkIGFzIGFic2VudC4gVGhlXG4gKiBjcmVhdGVXb3JrdHJlZSgpIHBhdGggYWxyZWFkeSBjbGVhbnMgdGhlc2UgdXAsIGJ1dCByZWFkZXJzIG11c3Qgbm90IHRydXN0XG4gKiB0aGVtIGluIHRoZSB3aW5kb3cgYmVmb3JlIGNsZWFudXAgcnVucy5cbiAqXG4gKiBGaXhlcyAjNDc2MS4gVXNlZCBieSB0aGUgIzQ3NjIgYXVkaXQgZm9yIHRoZSBwcmUtY29tcGxldGlvbiBvcnBoYW4gY2FzZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVDYW5vbmljYWxNaWxlc3RvbmVSb290KFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgaWYgKCFtaWxlc3RvbmVJZCB8fCAvW1xcL1xcXFxdfFxcLlxcLi8udGVzdChtaWxlc3RvbmVJZCkpIHJldHVybiBiYXNlUGF0aDtcblxuICBjb25zdCB3dFBhdGggPSB3b3JrdHJlZVBhdGgoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgaWYgKCFleGlzdHNTeW5jKHd0UGF0aCkpIHJldHVybiBiYXNlUGF0aDtcblxuICAvLyBBIHJlZ2lzdGVyZWQgZ2l0IHdvcmt0cmVlIGhhcyBhIC5naXQgKmZpbGUqIChub3QgZGlyZWN0b3J5KSBjb250YWluaW5nXG4gIC8vIFwiZ2l0ZGlyOiA8cGF0aD5cIi4gQSBzdGFuZGFsb25lIC5naXQgZGlyZWN0b3J5IGluZGljYXRlcyBhIGNvcGllZCByZXBvXG4gIC8vIG9yIG5lc3RlZCBzdGFuZGFsb25lIHJlcG8gXHUyMDE0IG5vdCBhIHdvcmt0cmVlIHJlZ2lzdGVyZWQgd2l0aCB0aGlzIHByb2plY3QgXHUyMDE0XG4gIC8vIGFuZCBtdXN0IG5vdCBiZSB0cmVhdGVkIGFzIHRoZSBjYW5vbmljYWwgcm9vdC5cbiAgY29uc3QgZ2l0UGF0aCA9IGpvaW4od3RQYXRoLCBcIi5naXRcIik7XG4gIGlmICghZXhpc3RzU3luYyhnaXRQYXRoKSkgcmV0dXJuIGJhc2VQYXRoO1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXQgPSBsc3RhdFN5bmMoZ2l0UGF0aCk7XG4gICAgaWYgKCFzdGF0LmlzRmlsZSgpKSByZXR1cm4gYmFzZVBhdGg7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBiYXNlUGF0aDtcbiAgfVxuXG4gIC8vICM0NzY0IFx1MjAxNCByZWNvcmQgdGhlIHJlZGlyZWN0IHNvIHdlIGNhbiBtZWFzdXJlIGhvdyBvZnRlbiB0aGUgIzQ3NjEgZml4XG4gIC8vIHdvdWxkIGhhdmUgbWF0dGVyZWQuIEJlc3QtZWZmb3J0OyBlbWl0IGlzIHNpbGVudCBvbiBhbnkgZmFpbHVyZS5cbiAgdHJ5IHtcbiAgICBlbWl0Q2Fub25pY2FsUm9vdFJlZGlyZWN0KGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgd3RQYXRoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBjYW5vbmljYWwtcm9vdC1yZWRpcmVjdCB0ZWxlbWV0cnkgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuXG4gIHJldHVybiB3dFBhdGg7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb3JlIE9wZXJhdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ3JlYXRlIGEgbmV3IGdpdCB3b3JrdHJlZSB1bmRlciAuZ3NkL3dvcmt0cmVlcy88bmFtZT4vIHdpdGggYnJhbmNoIHdvcmt0cmVlLzxuYW1lPi5cbiAqIFRoZSBicmFuY2ggaXMgY3JlYXRlZCBmcm9tIHRoZSBjdXJyZW50IEhFQUQgb2YgdGhlIG1haW4gYnJhbmNoLlxuICpcbiAqIEBwYXJhbSBvcHRzLmJyYW5jaCBcdTIwMTQgb3ZlcnJpZGUgdGhlIGRlZmF1bHQgYHdvcmt0cmVlLzxuYW1lPmAgYnJhbmNoIG5hbWVcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVdvcmt0cmVlKGJhc2VQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgb3B0czogeyBicmFuY2g/OiBzdHJpbmc7IHN0YXJ0UG9pbnQ/OiBzdHJpbmc7IHJldXNlRXhpc3RpbmdCcmFuY2g/OiBib29sZWFuIH0gPSB7fSk6IFdvcmt0cmVlSW5mbyB7XG4gIGJhc2VQYXRoID0gbm9ybWFsaXplQmFzZVBhdGhGb3JXb3JrdHJlZU9wcyhiYXNlUGF0aCk7XG5cbiAgLy8gVmFsaWRhdGUgbmFtZTogYWxwaGFudW1lcmljLCBoeXBoZW5zLCB1bmRlcnNjb3JlcyBvbmx5XG4gIGlmICghL15bYS16QS1aMC05Xy1dKyQvLnRlc3QobmFtZSkpIHtcbiAgICB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1BBUlNFX0VSUk9SLCBgSW52YWxpZCB3b3JrdHJlZSBuYW1lIFwiJHtuYW1lfVwiLiBVc2Ugb25seSBsZXR0ZXJzLCBudW1iZXJzLCBoeXBoZW5zLCBhbmQgdW5kZXJzY29yZXMuYCk7XG4gIH1cblxuICBjb25zdCB3dFBhdGggPSB3b3JrdHJlZVBhdGgoYmFzZVBhdGgsIG5hbWUpO1xuICBjb25zdCBicmFuY2ggPSBvcHRzLmJyYW5jaCA/PyB3b3JrdHJlZUJyYW5jaE5hbWUobmFtZSk7XG5cbiAgaWYgKGV4aXN0c1N5bmMod3RQYXRoKSkge1xuICAgIC8vIEEgdmFsaWQgZ2l0IHdvcmt0cmVlIGhhcyBhIC5naXQgZmlsZSAobm90IGRpcmVjdG9yeSkgY29udGFpbmluZyBhXG4gICAgLy8gXCJnaXRkaXI6XCIgcG9pbnRlci4gIElmIHRoZSBkaXJlY3RvcnkgZXhpc3RzIGJ1dCBoYXMgbm8gLmdpdCBmaWxlLFxuICAgIC8vIGl0IGlzIGEgc3RhbGUgbGVmdG92ZXIgZnJvbSBhIHByaW9yIGNyYXNoIFx1MjAxNCByZW1vdmUgaXQgc28gYSBmcmVzaFxuICAgIC8vIHdvcmt0cmVlIGNhbiBiZSBjcmVhdGVkIGluIGl0cyBwbGFjZS5cbiAgICBjb25zdCBnaXRGaWxlUGF0aCA9IGpvaW4od3RQYXRoLCBcIi5naXRcIik7XG4gICAgaWYgKCFleGlzdHNTeW5jKGdpdEZpbGVQYXRoKSkge1xuICAgICAgbG9nV2FybmluZyhcInJlY29uY2lsZVwiLCBgUmVtb3Zpbmcgc3RhbGUgd29ya3RyZWUgZGlyZWN0b3J5IChubyAuZ2l0IGZpbGUpOiAke3d0UGF0aH1gLCB7IHdvcmt0cmVlOiBuYW1lIH0pO1xuICAgICAgcm1TeW5jKHd0UGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX1NUQUxFX1NUQVRFLCBgV29ya3RyZWUgXCIke25hbWV9XCIgYWxyZWFkeSBleGlzdHMgYXQgJHt3dFBhdGh9YCk7XG4gICAgfVxuICB9XG5cbiAgLy8gRW5zdXJlIHRoZSAuZ3NkL3dvcmt0cmVlcy8gZGlyZWN0b3J5IGV4aXN0c1xuICBjb25zdCB3dERpciA9IHdvcmt0cmVlc0RpcihiYXNlUGF0aCk7XG4gIG1rZGlyU3luYyh3dERpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgLy8gUHJ1bmUgYW55IHN0YWxlIHdvcmt0cmVlIGVudHJpZXMgZnJvbSBhIHByZXZpb3VzIHJlbW92YWxcbiAgbmF0aXZlV29ya3RyZWVQcnVuZShiYXNlUGF0aCk7XG5cbiAgLy8gVXNlIHRoZSBleHBsaWNpdCBzdGFydCBwb2ludCAoZS5nLiBpbnRlZ3JhdGlvbiBicmFuY2gpIGlmIHByb3ZpZGVkLFxuICAvLyBvdGhlcndpc2UgZmFsbCBiYWNrIHRvIHRoZSByZXBvJ3MgZGV0ZWN0ZWQgbWFpbiBicmFuY2guXG4gIGNvbnN0IHN0YXJ0UG9pbnQgPSBvcHRzLnN0YXJ0UG9pbnQgPz8gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG5cbiAgLy8gUmVqZWN0IGVhcmx5IGlmIHN0YXJ0UG9pbnQgcmVzb2x2ZXMgdG8gYW4gZW1wdHkvaW52YWxpZCByZWYuIE9uIGFuXG4gIC8vIHVuYm9ybiBicmFuY2ggKHplcm8tY29tbWl0IHJlcG8pIG5hdGl2ZURldGVjdE1haW5CcmFuY2ggcmV0dXJucyBcIlwiLFxuICAvLyB3aGljaCB3b3VsZCBmbG93IGludG8gYGdpdCB3b3JrdHJlZSBhZGQgLi4uIFwiXCJgIGFuZCBjcmFzaCB3aXRoXG4gIC8vIGBmYXRhbDogbm90IGEgdmFsaWQgb2JqZWN0IG5hbWVgLiAoSXNzdWUgIzQ5ODAgSElHSC05KVxuICBpZiAoIXN0YXJ0UG9pbnQgfHwgc3RhcnRQb2ludC5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgR1NERXJyb3IoXG4gICAgICBHU0RfR0lUX0VSUk9SLFxuICAgICAgXCJSZXBvc2l0b3J5IGhhcyBubyBjb21taXRzIHlldCAodW5ib3JuIGJyYW5jaCkuIE1ha2UgYW4gaW5pdGlhbCBjb21taXQgYmVmb3JlIGNyZWF0aW5nIHdvcmt0cmVlcy5cIixcbiAgICApO1xuICB9XG5cbiAgLy8gQ2hlY2sgaWYgdGhlIGJyYW5jaCBhbHJlYWR5IGV4aXN0cyAobGVmdG92ZXIgZnJvbSBhIHByZXZpb3VzIHdvcmt0cmVlKVxuICBjb25zdCBicmFuY2hBbHJlYWR5RXhpc3RzID0gbmF0aXZlQnJhbmNoRXhpc3RzKGJhc2VQYXRoLCBicmFuY2gpO1xuXG4gIGlmIChicmFuY2hBbHJlYWR5RXhpc3RzKSB7XG4gICAgLy8gQ2hlY2sgaWYgdGhlIGJyYW5jaCBpcyBhY3RpdmVseSB1c2VkIGJ5IGFuIGV4aXN0aW5nIHdvcmt0cmVlLlxuICAgIGNvbnN0IHdvcmt0cmVlRW50cmllcyA9IG5hdGl2ZVdvcmt0cmVlTGlzdChiYXNlUGF0aCk7XG4gICAgY29uc3QgYnJhbmNoSW5Vc2UgPSB3b3JrdHJlZUVudHJpZXMuc29tZShlbnRyeSA9PiBlbnRyeS5icmFuY2ggPT09IGJyYW5jaCk7XG5cbiAgICBpZiAoYnJhbmNoSW5Vc2UpIHtcbiAgICAgIHRocm93IG5ldyBHU0RFcnJvcihcbiAgICAgICAgR1NEX0xPQ0tfSEVMRCxcbiAgICAgICAgYEJyYW5jaCBcIiR7YnJhbmNofVwiIGlzIGFscmVhZHkgaW4gdXNlIGJ5IGFub3RoZXIgd29ya3RyZWUuIGAgK1xuICAgICAgICBgUmVtb3ZlIHRoZSBleGlzdGluZyB3b3JrdHJlZSBmaXJzdCB3aXRoIC93b3JrdHJlZSByZW1vdmUgJHtuYW1lfS5gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAob3B0cy5yZXVzZUV4aXN0aW5nQnJhbmNoKSB7XG4gICAgICAvLyBBdHRhY2ggd29ya3RyZWUgdG8gdGhlIGV4aXN0aW5nIGJyYW5jaCBhcy1pcyAocHJlc2VydmluZyBjb21taXRzKS5cbiAgICAgIC8vIFVzZWQgd2hlbiByZXN1bWluZyBhdXRvLW1vZGU6IHRoZSBtaWxlc3RvbmUgYnJhbmNoIGhhcyB2YWxpZCB3b3JrXG4gICAgICAvLyBmcm9tIHByaW9yIHNlc3Npb25zIHRoYXQgbXVzdCBub3QgYmUgcmVzZXQuXG4gICAgICBuYXRpdmVXb3JrdHJlZUFkZChiYXNlUGF0aCwgd3RQYXRoLCBicmFuY2gpO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBBbmNlc3RyeSBndWFyZDogcmVmdXNlIHRvIGZvcmNlLXJlc2V0IGEgYnJhbmNoIHRoYXQgaGFzIGNvbW1pdHMgbm90XG4gICAgICAvLyByZWFjaGFibGUgZnJvbSBzdGFydFBvaW50LiBBIGNyYXNoLXRoZW4tcmVzdW1lIGN5Y2xlIHRoYXQgZGlkbid0XG4gICAgICAvLyB3cml0ZSB0aGUgcmVzdW1lIGZpbGUgd291bGQgc2lsZW50bHkgb3JwaGFuIHByaW9yLXNlc3Npb24gY29tbWl0c1xuICAgICAgLy8gKHJlY292ZXJhYmxlIGZyb20gcmVmbG9nIGZvciA5MGQsIHRoZW4gZ29uZSBcdTIwMTQgYnJhbmNoIGlzIGFsc29cbiAgICAgIC8vIGRlbGV0ZWQgYXQgdGVhcmRvd24pLiAoSXNzdWUgIzQ5ODAgSElHSC0zKVxuICAgICAgY29uc3QgYnJhbmNoSXNBbmNlc3RvciA9IG5hdGl2ZUlzQW5jZXN0b3IoYmFzZVBhdGgsIGJyYW5jaCwgc3RhcnRQb2ludCk7XG4gICAgICBpZiAoIWJyYW5jaElzQW5jZXN0b3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEdTREVycm9yKFxuICAgICAgICAgIEdTRF9HSVRfRVJST1IsXG4gICAgICAgICAgYEJyYW5jaCBcIiR7YnJhbmNofVwiIGFscmVhZHkgZXhpc3RzIHdpdGggY29tbWl0cyBub3QgcmVhY2hhYmxlIGZyb20gXCIke3N0YXJ0UG9pbnR9XCIuIGAgK1xuICAgICAgICAgIGBSZWZ1c2luZyB0byBmb3JjZS1yZXNldCBcdTIwMTQgd291bGQgb3JwaGFuIHByaW9yIHdvcmsuIGAgK1xuICAgICAgICAgIGBJZiB5b3UgaW50ZW5kIHRvIGtlZXAgdGhvc2UgY29tbWl0cywgcmV0cnkgd2l0aCByZXVzZUV4aXN0aW5nQnJhbmNoPXRydWUuIGAgK1xuICAgICAgICAgIGBJZiB5b3UgaW50ZW5kIHRvIGRpc2NhcmQsIHJ1biBcXGBnaXQgYnJhbmNoIC1EICR7YnJhbmNofVxcYCBtYW51YWxseSBmaXJzdC5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgLy8gUmVzZXQgdGhlIHN0YWxlIGJyYW5jaCB0byB0aGUgc3RhcnQgcG9pbnQsIHRoZW4gYXR0YWNoIHdvcmt0cmVlIHRvIGl0XG4gICAgICBuYXRpdmVCcmFuY2hGb3JjZVJlc2V0KGJhc2VQYXRoLCBicmFuY2gsIHN0YXJ0UG9pbnQpO1xuICAgICAgbmF0aXZlV29ya3RyZWVBZGQoYmFzZVBhdGgsIHd0UGF0aCwgYnJhbmNoKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgbmF0aXZlV29ya3RyZWVBZGQoYmFzZVBhdGgsIHd0UGF0aCwgYnJhbmNoLCB0cnVlLCBzdGFydFBvaW50KTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgbmFtZSxcbiAgICBwYXRoOiB3dFBhdGgsXG4gICAgYnJhbmNoLFxuICAgIGV4aXN0czogdHJ1ZSxcbiAgfTtcbn1cblxuLyoqXG4gKiBMaXN0IGFsbCBHU0QtbWFuYWdlZCB3b3JrdHJlZXMuXG4gKiBVc2VzIG5hdGl2ZSB3b3JrdHJlZSBsaXN0IGFuZCBmaWx0ZXJzIHRvIHRob3NlIHVuZGVyIC5nc2Qvd29ya3RyZWVzLy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3RXb3JrdHJlZXMoYmFzZVBhdGg6IHN0cmluZyk6IFdvcmt0cmVlSW5mb1tdIHtcbiAgYmFzZVBhdGggPSBub3JtYWxpemVCYXNlUGF0aEZvcldvcmt0cmVlT3BzKGJhc2VQYXRoKTtcblxuICBjb25zdCBiYXNlVmFyaWFudHMgPSBbcmVzb2x2ZShiYXNlUGF0aCldO1xuICBpZiAoZXhpc3RzU3luYyhiYXNlUGF0aCkpIHtcbiAgICBiYXNlVmFyaWFudHMucHVzaChyZWFscGF0aFN5bmMoYmFzZVBhdGgpKTtcbiAgfVxuICBjb25zdCBzZWVuUm9vdHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3Qgd29ya3RyZWVSb290cyA9IGJhc2VWYXJpYW50c1xuICAgIC5tYXAoYmFzZVZhcmlhbnQgPT4ge1xuICAgICAgY29uc3QgcGF0aCA9IGpvaW4oYmFzZVZhcmlhbnQsIFwiLmdzZFwiLCBcIndvcmt0cmVlc1wiKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG5vcm1hbGl6ZWQ6IG5vcm1hbGl6ZVBhdGhGb3JDb21wYXJpc29uKHBhdGgpLFxuICAgICAgfTtcbiAgICB9KVxuICAgIC5maWx0ZXIocm9vdCA9PiB7XG4gICAgICBpZiAoc2VlblJvb3RzLmhhcyhyb290Lm5vcm1hbGl6ZWQpKSByZXR1cm4gZmFsc2U7XG4gICAgICBzZWVuUm9vdHMuYWRkKHJvb3Qubm9ybWFsaXplZCk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9KTtcblxuICBjb25zdCBlbnRyaWVzID0gbmF0aXZlV29ya3RyZWVMaXN0KGJhc2VQYXRoKTtcblxuICBpZiAoIWVudHJpZXMubGVuZ3RoKSByZXR1cm4gW107XG5cbiAgY29uc3Qgd29ya3RyZWVzOiBXb3JrdHJlZUluZm9bXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgIGlmIChlbnRyeS5pc0JhcmUpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgZW50cnlQYXRoID0gZW50cnkucGF0aDtcbiAgICBjb25zdCBicmFuY2ggPSBlbnRyeS5icmFuY2g7XG5cbiAgICBpZiAoIWJyYW5jaCkgY29udGludWU7XG5cbiAgICBjb25zdCBicmFuY2hXb3JrdHJlZU5hbWUgPSBicmFuY2guc3RhcnRzV2l0aChcIndvcmt0cmVlL1wiKVxuICAgICAgPyBicmFuY2guc2xpY2UoXCJ3b3JrdHJlZS9cIi5sZW5ndGgpXG4gICAgICA6IGJyYW5jaC5zdGFydHNXaXRoKFwibWlsZXN0b25lL1wiKVxuICAgICAgICA/IGJyYW5jaC5zbGljZShcIm1pbGVzdG9uZS9cIi5sZW5ndGgpXG4gICAgICAgIDogbnVsbDtcblxuICAgIGNvbnN0IGVudHJ5VmFyaWFudHMgPSBbcmVzb2x2ZShlbnRyeVBhdGgpXTtcbiAgICBpZiAoZXhpc3RzU3luYyhlbnRyeVBhdGgpKSB7XG4gICAgICBlbnRyeVZhcmlhbnRzLnB1c2gocmVhbHBhdGhTeW5jKGVudHJ5UGF0aCkpO1xuICAgIH1cbiAgICBjb25zdCBub3JtYWxpemVkRW50cnlWYXJpYW50cyA9IFsuLi5uZXcgU2V0KGVudHJ5VmFyaWFudHMubWFwKG5vcm1hbGl6ZVBhdGhGb3JDb21wYXJpc29uKSldO1xuICAgIGNvbnN0IG1hdGNoZWRSb290ID0gd29ya3RyZWVSb290cy5maW5kKHJvb3QgPT5cbiAgICAgIG5vcm1hbGl6ZWRFbnRyeVZhcmlhbnRzLnNvbWUoZW50cnlWYXJpYW50ID0+IGVudHJ5VmFyaWFudC5zdGFydHNXaXRoKGAke3Jvb3Qubm9ybWFsaXplZH0vYCkpLFxuICAgICk7XG4gICAgY29uc3QgbWF0Y2hlc0JyYW5jaExlYWYgPSBicmFuY2hXb3JrdHJlZU5hbWVcbiAgICAgID8gbm9ybWFsaXplZEVudHJ5VmFyaWFudHMuc29tZShlbnRyeVZhcmlhbnQgPT4gZW50cnlWYXJpYW50LnNwbGl0KFwiL1wiKS5wb3AoKSA9PT0gYnJhbmNoV29ya3RyZWVOYW1lKVxuICAgICAgOiBmYWxzZTtcblxuICAgIC8vIE9ubHkgaW5jbHVkZSB3b3JrdHJlZXMgdW5kZXIgLmdzZC93b3JrdHJlZXMvXG4gICAgaWYgKCFtYXRjaGVkUm9vdCAmJiAhbWF0Y2hlc0JyYW5jaExlYWYpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgbWF0Y2hlZEVudHJ5UGF0aCA9IG5vcm1hbGl6ZWRFbnRyeVZhcmlhbnRzLmZpbmQoZW50cnlWYXJpYW50ID0+XG4gICAgICBtYXRjaGVkUm9vdCA/IGVudHJ5VmFyaWFudC5zdGFydHNXaXRoKGAke21hdGNoZWRSb290Lm5vcm1hbGl6ZWR9L2ApIDogZmFsc2UsXG4gICAgKTtcbiAgICBsZXQgbmFtZSA9IG1hdGNoZWRSb290ID8gbWF0Y2hlZEVudHJ5UGF0aD8uc2xpY2UobWF0Y2hlZFJvb3Qubm9ybWFsaXplZC5sZW5ndGggKyAxKSA/PyBcIlwiIDogXCJcIjtcblxuICAgIC8vIEdpdCBvbiBXaW5kb3dzIGNhbiByZXBvcnQgYSBwYXRoIGZvcm0gdGhhdCBkb2VzIG5vdCBtYXAgY2xlYW5seSBiYWNrIHRvIHRoZVxuICAgIC8vIHJlcG8gcm9vdCBldmVuIHdoZW4gdGhlIGJyYW5jaCBuYW1pbmcgaXMgc3RpbGwgYXV0aG9yaXRhdGl2ZS5cbiAgICBpZiAoKCFuYW1lIHx8IG5hbWUuaW5jbHVkZXMoXCIvXCIpKSAmJiBicmFuY2hXb3JrdHJlZU5hbWUgJiYgbWF0Y2hlc0JyYW5jaExlYWYpIHtcbiAgICAgIG5hbWUgPSBicmFuY2hXb3JrdHJlZU5hbWU7XG4gICAgfVxuXG4gICAgaWYgKCFuYW1lIHx8IG5hbWUuaW5jbHVkZXMoXCIvXCIpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IHJlc29sdmVkRW50cnlQYXRoID0gZXhpc3RzU3luYyhlbnRyeVBhdGgpID8gcmVhbHBhdGhTeW5jKGVudHJ5UGF0aCkgOiByZXNvbHZlKGVudHJ5UGF0aCk7XG5cbiAgICB3b3JrdHJlZXMucHVzaCh7XG4gICAgICBuYW1lLFxuICAgICAgcGF0aDogcmVzb2x2ZWRFbnRyeVBhdGgsXG4gICAgICBicmFuY2gsXG4gICAgICBleGlzdHM6IGV4aXN0c1N5bmMocmVzb2x2ZWRFbnRyeVBhdGgpLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIHdvcmt0cmVlcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE5lc3RlZCAuZ2l0IERldGVjdGlvbiAoIzI2MTYpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy9cbi8vIFNjYWZmb2xkaW5nIHRvb2xzIChjcmVhdGUtbmV4dC1hcHAsIGNhcmdvIGluaXQsIGV0Yy4pIGNyZWF0ZSBuZXN0ZWQgLmdpdFxuLy8gZGlyZWN0b3JpZXMgaW5zaWRlIHdvcmt0cmVlcy4gR2l0IHJlY29yZHMgdGhlc2UgYXMgZ2l0bGlua3MgKG1vZGUgMTYwMDAwKVxuLy8gd2l0aG91dCBhIC5naXRtb2R1bGVzIGVudHJ5IFx1MjAxNCBzbyB3b3JrdHJlZSBjbGVhbnVwIGRlc3Ryb3lzIHRoZSBvbmx5IGNvcHlcbi8vIG9mIHRoZWlyIG9iamVjdCBkYXRhYmFzZSwgY2F1c2luZyBwZXJtYW5lbnQgc2lsZW50IGRhdGEgbG9zcy5cblxuLyoqIERpcmVjdG9yaWVzIHRvIHNraXAgd2hlbiBzY2FubmluZyBmb3IgbmVzdGVkIC5naXQgZGlycy4gKi9cbmNvbnN0IE5FU1RFRF9HSVRfU0tJUF9ESVJTID0gbmV3IFNldChbXG4gIFwiLmdpdFwiLCBcIi5nc2RcIiwgXCIuYmctc2hlbGxcIiwgXCJub2RlX21vZHVsZXNcIiwgXCIubmV4dFwiLCBcIi5udXh0XCIsIFwiZGlzdFwiLCBcImJ1aWxkXCIsXG4gIFwiX19weWNhY2hlX19cIiwgXCIudG94XCIsIFwiLnZlbnZcIiwgXCJ2ZW52XCIsIFwidGFyZ2V0XCIsIFwidmVuZG9yXCIsXG5dKTtcblxuLyoqXG4gKiBSZWN1cnNpdmVseSBmaW5kIG5lc3RlZCAuZ2l0IGRpcmVjdG9yaWVzIGluc2lkZSBhIHdvcmt0cmVlIHJvb3QuXG4gKiBSZXR1cm5zIHBhdGhzIHRvIGRpcmVjdG9yaWVzIHRoYXQgY29udGFpbiB0aGVpciBvd24gLmdpdCAoZGlyZWN0b3J5LCBub3QgZmlsZSkuXG4gKiBTa2lwcyBub2RlX21vZHVsZXMsIC5nc2QsIGFuZCBvdGhlciBub24tcHJvamVjdCBkaXJlY3RvcmllcyBmb3IgcGVyZm9ybWFuY2UuXG4gKlxuICogQSBuZXN0ZWQgLmdpdCAqZGlyZWN0b3J5KiAobm90IGEgLmdpdCBmaWxlIFx1MjAxNCB3aGljaCBpcyBhIGxlZ2l0aW1hdGUgd29ya3RyZWVcbiAqIHBvaW50ZXIpIGluZGljYXRlcyBhIHNjYWZmb2xkZWQgcmVwbyB0aGF0IHdpbGwgYmVjb21lIGFuIG9ycGhhbmVkIGdpdGxpbmsuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTmVzdGVkR2l0RGlycyhyb290UGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCByZXN1bHRzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGZ1bmN0aW9uIHdhbGsoZGlyOiBzdHJpbmcsIGRlcHRoOiBudW1iZXIpOiB2b2lkIHtcbiAgICAvLyBDYXAgcmVjdXJzaW9uIGRlcHRoIHRvIGF2b2lkIHJ1bmF3YXkgc2Nhbm5pbmdcbiAgICBpZiAoZGVwdGggPiAxMCkgcmV0dXJuO1xuXG4gICAgbGV0IGVudHJpZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBlbnRyaWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYHJlYWRkaXJTeW5jIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgIGlmIChORVNURURfR0lUX1NLSVBfRElSUy5oYXMoZW50cnkpKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgZnVsbFBhdGggPSBqb2luKGRpciwgZW50cnkpO1xuXG4gICAgICAvLyBPbmx5IGZvbGxvdyByZWFsIGRpcmVjdG9yaWVzLCBub3Qgc3ltbGlua3NcbiAgICAgIGxldCBzdGF0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3RhdCA9IGxzdGF0U3luYyhmdWxsUGF0aCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgbHN0YXRTeW5jIGZhaWxlZCBmb3IgJHtmdWxsUGF0aH06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKCFzdGF0LmlzRGlyZWN0b3J5KCkpIGNvbnRpbnVlO1xuXG4gICAgICAvLyBDaGVjayBpZiB0aGlzIGRpcmVjdG9yeSBjb250YWlucyBhIC5naXQgKmRpcmVjdG9yeSogKG5vdCBhIC5naXQgZmlsZSkuXG4gICAgICAvLyBBIC5naXQgZmlsZSBpcyBhIHdvcmt0cmVlIHBvaW50ZXIgYW5kIGlzIGxlZ2l0aW1hdGUuXG4gICAgICAvLyBBIC5naXQgZGlyZWN0b3J5IGlzIGEgc3RhbmRhbG9uZSByZXBvIGNyZWF0ZWQgYnkgc2NhZmZvbGRpbmcuXG4gICAgICBjb25zdCBpbm5lckdpdCA9IGpvaW4oZnVsbFBhdGgsIFwiLmdpdFwiKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGlubmVyU3RhdCA9IGxzdGF0U3luYyhpbm5lckdpdCk7XG4gICAgICAgIGlmIChpbm5lclN0YXQuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICAgIHJlc3VsdHMucHVzaChmdWxsUGF0aCk7XG4gICAgICAgICAgLy8gRG9uJ3QgcmVjdXJzZSBpbnRvIHRoZSBuZXN0ZWQgcmVwbyBcdTIwMTQgd2UgZm91bmQgd2hhdCB3ZSBuZWVkXG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSAhPT0gXCJFTk9FTlRcIikge1xuICAgICAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgZXhpc3RzU3luYy8uZ2l0IGNoZWNrIGZhaWxlZCBmb3IgJHtmdWxsUGF0aH06ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgd2FsayhmdWxsUGF0aCwgZGVwdGggKyAxKTtcbiAgICB9XG4gIH1cblxuICB3YWxrKHJvb3RQYXRoLCAwKTtcbiAgcmV0dXJuIHJlc3VsdHM7XG59XG5cbi8qKlxuICogUmVtb3ZlIGEgd29ya3RyZWUgYW5kIG9wdGlvbmFsbHkgZGVsZXRlIGl0cyBicmFuY2guXG4gKiBJZiB0aGUgcHJvY2VzcyBpcyBjdXJyZW50bHkgaW5zaWRlIHRoZSB3b3JrdHJlZSwgY2hkaXIgb3V0IGZpcnN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlV29ya3RyZWUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG5hbWU6IHN0cmluZyxcbiAgb3B0czogeyBkZWxldGVCcmFuY2g/OiBib29sZWFuOyBmb3JjZT86IGJvb2xlYW47IGJyYW5jaD86IHN0cmluZyB9ID0ge30sXG4pOiB2b2lkIHtcbiAgYmFzZVBhdGggPSBub3JtYWxpemVCYXNlUGF0aEZvcldvcmt0cmVlT3BzKGJhc2VQYXRoKTtcblxuICBsZXQgd3RQYXRoID0gd29ya3RyZWVQYXRoKGJhc2VQYXRoLCBuYW1lKTtcbiAgY29uc3QgYnJhbmNoID0gb3B0cy5icmFuY2ggPz8gd29ya3RyZWVCcmFuY2hOYW1lKG5hbWUpO1xuICBjb25zdCB7IGRlbGV0ZUJyYW5jaCA9IHRydWUsIGZvcmNlID0gdHJ1ZSB9ID0gb3B0cztcblxuICAvLyBSZXNvbHZlIHRoZSBBQ1RVQUwgd29ya3RyZWUgcGF0aCBmcm9tIGdpdCdzIHdvcmt0cmVlIGxpc3QuXG4gIC8vIFRoZSBjb21wdXRlZCBwYXRoIG1heSBkaWZmZXIgd2hlbiAuZ3NkLyBpcyAob3Igd2FzKSBhIHN5bWxpbmsgdG8gYW5cbiAgLy8gZXh0ZXJuYWwgc3RhdGUgZGlyZWN0b3J5IFx1MjAxNCBnaXQgcmVzb2x2ZXMgc3ltbGlua3MgYXQgd29ya3RyZWUgY3JlYXRpb25cbiAgLy8gdGltZSwgc28gaXRzIHJlZ2lzdGVyZWQgcGF0aCBwb2ludHMgdG8gdGhlIHJlc29sdmVkIGV4dGVybmFsIGxvY2F0aW9uLlxuICAvLyBJZiBzeW5jU3RhdGVUb1Byb2plY3RSb290IGxhdGVyIGNyZWF0ZXMgYSByZWFsIC5nc2QvIGRpcmVjdG9yeSB0aGF0XG4gIC8vIHNoYWRvd3MgdGhlIHN5bWxpbmssIHRoZSBjb21wdXRlZCBwYXRoIGRpdmVyZ2VzIGZyb20gZ2l0J3MgcmVjb3JkLlxuICBsZXQgZ2l0UmVwb3J0ZWRQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCBlbnRyaWVzID0gbmF0aXZlV29ya3RyZWVMaXN0KGJhc2VQYXRoKTtcbiAgICBjb25zdCBlbnRyeSA9IGVudHJpZXMuZmluZChlID0+IGUuYnJhbmNoID09PSBicmFuY2gpO1xuICAgIGlmIChlbnRyeT8ucGF0aCkge1xuICAgICAgZ2l0UmVwb3J0ZWRQYXRoID0gZW50cnkucGF0aDtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBuYXRpdmVXb3JrdHJlZUxpc3QgcGFyc2UgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG5cbiAgLy8gU2FmZXR5IGdhdGUgKCMyMzY1KTogb25seSB1c2UgdGhlIGdpdC1yZXBvcnRlZCBwYXRoIGlmIGl0IGlzIGFjdHVhbGx5XG4gIC8vIGluc2lkZSAuZ3NkL3dvcmt0cmVlcy8uICBXaGVuIC5nc2QvIHdhcyBhIHN5bWxpbmssIGdpdCBtYXkgaGF2ZSByZXNvbHZlZFxuICAvLyBpdCB0byBhbiBleHRlcm5hbCBkaXJlY3RvcnkgKGUuZy4gYSBwcm9qZWN0IGRhdGEgZm9sZGVyKS4gIFVzaW5nIHRoYXRcbiAgLy8gcGF0aCBmb3IgcmVtb3ZhbCB3b3VsZCBkZXN0cm95IHVzZXIgZGF0YS5cbiAgaWYgKGdpdFJlcG9ydGVkUGF0aCAmJiBpc0luc2lkZVdvcmt0cmVlc0RpcihiYXNlUGF0aCwgZ2l0UmVwb3J0ZWRQYXRoKSkge1xuICAgIHd0UGF0aCA9IGdpdFJlcG9ydGVkUGF0aDtcbiAgfSBlbHNlIGlmIChnaXRSZXBvcnRlZFBhdGgpIHtcbiAgICBjb25zb2xlLmVycm9yKFxuICAgICAgYFtHU0RdIFdBUk5JTkc6IGdpdCB3b3JrdHJlZSBsaXN0IHJlcG9ydGVkIHBhdGggb3V0c2lkZSAuZ3NkL3dvcmt0cmVlcy86ICR7Z2l0UmVwb3J0ZWRQYXRofVxcbmAgK1xuICAgICAgICBgICBSZWZ1c2luZyB0byB1c2UgaXQgZm9yIHJlbW92YWwgXHUyMDE0IGZhbGxpbmcgYmFjayB0byBjb21wdXRlZCBwYXRoOiAke3d0UGF0aH1gLFxuICAgICk7XG4gICAgLy8gU3RpbGwgdGVsbCBnaXQgdG8gdW5yZWdpc3RlciB0aGUgd29ya3RyZWUgZW50cnkgdmlhIGl0cyByZXBvcnRlZCBwYXRoLFxuICAgIC8vIGJ1dCBkbyBOT1QgdXNlIGZvcmNlIGFuZCBkbyBOT1QgZmFsbCBiYWNrIHRvIHJtU3luYyBvbiB0aGlzIHBhdGguXG4gICAgdHJ5IHsgbmF0aXZlV29ya3RyZWVSZW1vdmUoYmFzZVBhdGgsIGdpdFJlcG9ydGVkUGF0aCwgZmFsc2UpOyB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgbm9uLWZvcmNlIHdvcmt0cmVlIHJlbW92ZSBmYWlsZWQgZm9yICR7Z2l0UmVwb3J0ZWRQYXRofTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7IH1cbiAgfVxuXG4gIGNvbnN0IHJlc29sdmVkV3RQYXRoID0gZXhpc3RzU3luYyh3dFBhdGgpID8gcmVhbHBhdGhTeW5jKHd0UGF0aCkgOiB3dFBhdGg7XG5cbiAgLy8gRG91YmxlLWNoZWNrOiB0aGUgcmVzb2x2ZWQgcGF0aCAoYWZ0ZXIgc3ltbGluayByZXNvbHV0aW9uKSBtdXN0IGFsc28gYmVcbiAgLy8gaW5zaWRlIC5nc2Qvd29ya3RyZWVzLyBcdTIwMTQgYSBzeW1saW5rIGluc2lkZSB0aGUgZGlyZWN0b3J5IGNvdWxkIHBvaW50IG91dC5cbiAgY29uc3QgcmVzb2x2ZWRQYXRoU2FmZSA9IGlzSW5zaWRlV29ya3RyZWVzRGlyKGJhc2VQYXRoLCByZXNvbHZlZFd0UGF0aCk7XG5cbiAgLy8gSWYgd2UncmUgaW5zaWRlIHRoZSB3b3JrdHJlZSwgbW92ZSBvdXQgZmlyc3QgXHUyMDE0IGdpdCBjYW4ndCByZW1vdmUgYW4gaW4tdXNlIGRpcmVjdG9yeVxuICBjb25zdCBjd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICBjb25zdCByZXNvbHZlZEN3ZCA9IGV4aXN0c1N5bmMoY3dkKSA/IHJlYWxwYXRoU3luYyhjd2QpIDogY3dkO1xuICBpZiAocmVzb2x2ZWRDd2QgPT09IHJlc29sdmVkV3RQYXRoIHx8IHJlc29sdmVkQ3dkLnN0YXJ0c1dpdGgocmVzb2x2ZWRXdFBhdGggKyBzZXApKSB7XG4gICAgcHJvY2Vzcy5jaGRpcihiYXNlUGF0aCk7XG4gIH1cblxuICBpZiAoIWV4aXN0c1N5bmMod3RQYXRoKSkge1xuICAgIG5hdGl2ZVdvcmt0cmVlUHJ1bmUoYmFzZVBhdGgpO1xuICAgIGlmIChkZWxldGVCcmFuY2gpIHtcbiAgICAgIGRlbGV0ZUJyYW5jaElmUHJlc2VudChiYXNlUGF0aCwgYnJhbmNoLCBcIm5hdGl2ZUJyYW5jaERlbGV0ZSBmYWlsZWRcIik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFN1Ym1vZHVsZSBzYWZldHkgKCMyMzM3KTogZGV0ZWN0IHN1Ym1vZHVsZXMgd2l0aCB1bmNvbW1pdHRlZCBjaGFuZ2VzXG4gIC8vIGJlZm9yZSBmb3JjZS1yZW1vdmluZyB0aGUgd29ya3RyZWUuIEZvcmNlIHJlbW92YWwgZGVzdHJveXMgYWxsIHVuY29tbWl0dGVkXG4gIC8vIHN0YXRlLCB3aGljaCBpcyBlc3BlY2lhbGx5IGRlc3RydWN0aXZlIGZvciBzdWJtb2R1bGUgZGlyZWN0b3JpZXMuXG4gIGxldCBoYXNTdWJtb2R1bGVDaGFuZ2VzID0gZmFsc2U7XG4gIGNvbnN0IGdpdG1vZHVsZXNQYXRoID0gam9pbihyZXNvbHZlZFd0UGF0aCwgXCIuZ2l0bW9kdWxlc1wiKTtcbiAgaWYgKGV4aXN0c1N5bmMoZ2l0bW9kdWxlc1BhdGgpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN1Ym1vZHVsZVN0YXR1cyA9IGV4ZWNGaWxlU3luYyhcbiAgICAgICAgXCJnaXRcIiwgW1wic3VibW9kdWxlXCIsIFwic3RhdHVzXCJdLCBcbiAgICAgICAgeyBjd2Q6IHJlc29sdmVkV3RQYXRoLCBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sIGVuY29kaW5nOiBcInV0Zi04XCIgfSxcbiAgICAgICkudHJpbSgpO1xuICAgICAgLy8gTGluZXMgc3RhcnRpbmcgd2l0aCAnKycgaW5kaWNhdGUgdW5jb21taXR0ZWQgc3VibW9kdWxlIGNoYW5nZXNcbiAgICAgIGhhc1N1Ym1vZHVsZUNoYW5nZXMgPSBzdWJtb2R1bGVTdGF0dXMuc3BsaXQoXCJcXG5cIikuc29tZShcbiAgICAgICAgKGxpbmU6IHN0cmluZykgPT4gbGluZS5zdGFydHNXaXRoKFwiK1wiKSB8fCBsaW5lLnN0YXJ0c1dpdGgoXCItXCIpLFxuICAgICAgKTtcbiAgICAgIGlmIChoYXNTdWJtb2R1bGVDaGFuZ2VzKSB7XG4gICAgICAgIC8vIFNhdmUgc3VibW9kdWxlIGNoYW5nZXMgdG8gYSBsYWJlbGVkIHJlc2N1ZSBicmFuY2ggaW5zdGVhZCBvZiB0aGVcbiAgICAgICAgLy8gc2hhcmVkIHN0YXNoIGxpc3QuIFN0YXNoIGlzIHBlci1yZXBvIChub3QgcGVyLXdvcmt0cmVlKSwgc28gYW5cbiAgICAgICAgLy8gZW50cnkgY3JlYXRlZCBoZXJlIHdvdWxkIGFwcGVhciBpbiB0aGUgdXNlcidzIG1haW4tdHJlZSBzdGFzaFxuICAgICAgICAvLyBsaXN0IGFuZCByZWZlcmVuY2UgcGF0aHMgdGhhdCBkaXNhcHBlYXIgYWZ0ZXIgd29ya3RyZWUgcmVtb3ZhbC5cbiAgICAgICAgLy8gQSBicmFuY2ggcGVyc2lzdHMgaW4gdGhlIHNoYXJlZCAuZ2l0IHJlZnMgYWZ0ZXIgd29ya3RyZWUgcmVtb3ZhbFxuICAgICAgICAvLyBhbmQgaXMgZGlzY292ZXJhYmxlIHZpYSBgZ2l0IGJyYW5jaCAtLWxpc3QgJ2dzZC9zdWJtb2R1bGUtcmVzY3VlLyonYC5cbiAgICAgICAgLy8gKElzc3VlICM0OTgwIEhJR0gtMTEpXG4gICAgICAgIGNvbnN0IHJlc2N1ZUJyYW5jaCA9IGBnc2Qvc3VibW9kdWxlLXJlc2N1ZS8ke25hbWV9LSR7RGF0ZS5ub3coKX1gO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGV4ZWNGaWxlU3luYyhcbiAgICAgICAgICAgIFwiZ2l0XCIsIFtcImFkZFwiLCBcIi1BXCJdLFxuICAgICAgICAgICAgeyBjd2Q6IHJlc29sdmVkV3RQYXRoLCBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sIGVuY29kaW5nOiBcInV0Zi04XCIgfSxcbiAgICAgICAgICApO1xuICAgICAgICAgIGV4ZWNGaWxlU3luYyhcbiAgICAgICAgICAgIFwiZ2l0XCIsIFtcImNvbW1pdFwiLCBcIi1tXCIsIGBnc2Q6IHJlc2N1ZSBzdWJtb2R1bGUgY2hhbmdlcyBmcm9tIHdvcmt0cmVlICR7bmFtZX1gLCBcIi0tYWxsb3ctZW1wdHlcIl0sXG4gICAgICAgICAgICB7IGN3ZDogcmVzb2x2ZWRXdFBhdGgsIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSwgZW5jb2Rpbmc6IFwidXRmLThcIiB9LFxuICAgICAgICAgICk7XG4gICAgICAgICAgZXhlY0ZpbGVTeW5jKFxuICAgICAgICAgICAgXCJnaXRcIiwgW1wiYnJhbmNoXCIsIHJlc2N1ZUJyYW5jaCwgXCJIRUFEXCJdLFxuICAgICAgICAgICAgeyBjd2Q6IHJlc29sdmVkV3RQYXRoLCBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sIGVuY29kaW5nOiBcInV0Zi04XCIgfSxcbiAgICAgICAgICApO1xuICAgICAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgICAgICBcInJlY29uY2lsZVwiLFxuICAgICAgICAgICAgYFNhdmVkIHVuY29tbWl0dGVkIHN1Ym1vZHVsZSBjaGFuZ2VzIHRvIHJlc2N1ZSBicmFuY2ggJHtyZXNjdWVCcmFuY2h9YCxcbiAgICAgICAgICAgIHsgd29ya3RyZWU6IG5hbWUsIHBhdGg6IHJlc29sdmVkV3RQYXRoLCByZXNjdWVCcmFuY2ggfSxcbiAgICAgICAgICApO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICBsb2dXYXJuaW5nKFxuICAgICAgICAgICAgXCJyZWNvbmNpbGVcIixcbiAgICAgICAgICAgIGBTdWJtb2R1bGUgcmVzY3VlIGJyYW5jaCBjcmVhdGlvbiBmYWlsZWQgXHUyMDE0IGNoYW5nZXMgbWF5IGJlIGxvc3QgZHVyaW5nIGZvcmNlIHJlbW92YWw6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICAgICAgICB7IHdvcmt0cmVlOiBuYW1lLCBwYXRoOiByZXNvbHZlZFd0UGF0aCB9LFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYHN1Ym1vZHVsZSBzdGF0dXMgY2hlY2sgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIE5lc3RlZCAuZ2l0IHNhZmV0eSAoIzI2MTYpOiBkZXRlY3QgbmVzdGVkIC5naXQgZGlyZWN0b3JpZXMgY3JlYXRlZCBieVxuICAvLyBzY2FmZm9sZGluZyB0b29scyAoY3JlYXRlLW5leHQtYXBwLCBjYXJnbyBpbml0LCBldGMuKS4gVGhlc2UgcHJvZHVjZVxuICAvLyBnaXRsaW5rIGVudHJpZXMgKG1vZGUgMTYwMDAwKSB3aXRob3V0IC5naXRtb2R1bGVzIFx1MjAxNCBjbGVhbnVwIHdvdWxkIGRlc3Ryb3lcbiAgLy8gdGhlIG9ubHkgY29weSBvZiB0aGUgbmVzdGVkIG9iamVjdCBkYXRhYmFzZSwgY2F1c2luZyBwZXJtYW5lbnQgZGF0YSBsb3NzLlxuICAvLyBGaXg6IHJlbW92ZSB0aGUgbmVzdGVkIC5naXQgZGlycyBzbyBnaXQgdHJhY2tzIHRoZSBmaWxlcyBhcyByZWd1bGFyIGNvbnRlbnQuXG4gIGNvbnN0IG5lc3RlZEdpdERpcnMgPSBmaW5kTmVzdGVkR2l0RGlycyhyZXNvbHZlZFd0UGF0aCk7XG4gIGlmIChuZXN0ZWRHaXREaXJzLmxlbmd0aCA+IDApIHtcbiAgICBmb3IgKGNvbnN0IG5lc3RlZERpciBvZiBuZXN0ZWRHaXREaXJzKSB7XG4gICAgICBjb25zdCBuZXN0ZWRHaXRQYXRoID0gam9pbihuZXN0ZWREaXIsIFwiLmdpdFwiKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJtU3luYyhuZXN0ZWRHaXRQYXRoLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJyZWNvbmNpbGVcIixcbiAgICAgICAgICBgUmVtb3ZlZCBuZXN0ZWQgLmdpdCBkaXJlY3RvcnkgZnJvbSBzY2FmZm9sZGVkIHByb2plY3QgdG8gcHJldmVudCBkYXRhIGxvc3MgKCMyNjE2KWAsXG4gICAgICAgICAgeyB3b3JrdHJlZTogbmFtZSwgbmVzdGVkUmVwbzogbmVzdGVkRGlyIH0sXG4gICAgICAgICk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbG9nV2FybmluZyhcInJlY29uY2lsZVwiLFxuICAgICAgICAgIGBGYWlsZWQgdG8gcmVtb3ZlIG5lc3RlZCAuZ2l0IGRpcmVjdG9yeSBcdTIwMTQgZmlsZXMgbWF5IGJlIGxvc3QgYXMgb3JwaGFuZWQgZ2l0bGlua2AsXG4gICAgICAgICAgeyB3b3JrdHJlZTogbmFtZSwgbmVzdGVkUmVwbzogbmVzdGVkRGlyIH0sXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gUmVtb3ZlIHdvcmt0cmVlIFx1MjAxNCBvbmx5IHVzZSBmb3JjZS9ybVN5bmMgd2hlbiB0aGUgcGF0aCBpcyBzYWZlbHkgY29udGFpbmVkXG4gIGlmIChyZXNvbHZlZFBhdGhTYWZlKSB7XG4gICAgLy8gUmVtb3ZlIHdvcmt0cmVlOiB0cnkgbm9uLWZvcmNlIGZpcnN0IHdoZW4gc3VibW9kdWxlcyBoYXZlIGNoYW5nZXMsXG4gICAgLy8gZmFsbGluZyBiYWNrIHRvIGZvcmNlIG9ubHkgYWZ0ZXIgc3VibW9kdWxlIHN0YXRlIGhhcyBiZWVuIHByZXNlcnZlZC5cbiAgICBjb25zdCB1c2VGb3JjZSA9IGhhc1N1Ym1vZHVsZUNoYW5nZXMgPyBmYWxzZSA6IGZvcmNlO1xuICAgIHRyeSB7IG5hdGl2ZVdvcmt0cmVlUmVtb3ZlKGJhc2VQYXRoLCByZXNvbHZlZFd0UGF0aCwgdXNlRm9yY2UpOyB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgbmF0aXZlV29ya3RyZWVSZW1vdmUgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG5cbiAgICAvLyBJZiB0aGUgZGlyZWN0b3J5IGlzIHN0aWxsIHRoZXJlIChlLmcuIGxvY2tlZCksIHRyeSBoYXJkZXIgd2l0aCBmb3JjZVxuICAgIGlmIChleGlzdHNTeW5jKHJlc29sdmVkV3RQYXRoKSkge1xuICAgICAgdHJ5IHsgbmF0aXZlV29ya3RyZWVSZW1vdmUoYmFzZVBhdGgsIHJlc29sdmVkV3RQYXRoLCB0cnVlKTsgfSBjYXRjaCAoZSkgeyBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYG5hdGl2ZVdvcmt0cmVlUmVtb3ZlIChmb3JjZSkgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG4gICAgfVxuXG4gICAgLy8gKCMyODIxKSBJZiB0aGUgd29ya3RyZWUgZGlyZWN0b3J5IFNUSUxMIGV4aXN0cyBhZnRlciBib3RoIG5hdGl2ZSByZW1vdmFsXG4gICAgLy8gYXR0ZW1wdHMgKGUuZy4gdW50cmFja2VkIGZpbGVzIGxpa2UgQVNTRVNTTUVOVC9VQVQtUkVTVUxUIHByZXZlbnQgZ2l0XG4gICAgLy8gd29ya3RyZWUgcmVtb3ZlKSwgZm9yY2UtcmVtb3ZlIHRoZSBnaXQgaW50ZXJuYWwgd29ya3RyZWUgbWV0YWRhdGEgZmlyc3QsXG4gICAgLy8gdGhlbiByZW1vdmUgdGhlIGZpbGVzeXN0ZW0gZGlyZWN0b3J5LiBXaXRob3V0IHRoaXMsIHRoZSAuZ2l0L3dvcmt0cmVlcy88bmFtZT5cbiAgICAvLyBsb2NrIHByZXZlbnRzIHJtU3luYyBmcm9tIGNsZWFuaW5nIHVwLCBhbmQgdGhlIG9ycGhhbmVkIHdvcmt0cmVlIGRpcmVjdG9yeVxuICAgIC8vIGNhdXNlcyBldmVyeSBzdWJzZXF1ZW50IGAvZ3NkIGF1dG9gIHRvIHJlLWVudGVyIHRoZSBzdGFsZSB3b3JrdHJlZS5cbiAgICBpZiAoZXhpc3RzU3luYyhyZXNvbHZlZFd0UGF0aCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHd0SW50ZXJuYWxEaXIgPSBqb2luKGJhc2VQYXRoLCBcIi5naXRcIiwgXCJ3b3JrdHJlZXNcIiwgbmFtZSk7XG4gICAgICAgIGlmIChleGlzdHNTeW5jKHd0SW50ZXJuYWxEaXIpKSB7XG4gICAgICAgICAgcm1TeW5jKHd0SW50ZXJuYWxEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgICAgfVxuICAgICAgICBybVN5bmMocmVzb2x2ZWRXdFBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgICAgaWYgKHd0UGF0aCAhPT0gcmVzb2x2ZWRXdFBhdGggJiYgZXhpc3RzU3luYyh3dFBhdGgpKSB7XG4gICAgICAgICAgcm1TeW5jKHd0UGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgbG9nV2FybmluZyhcbiAgICAgICAgICBcInJlY29uY2lsZVwiLFxuICAgICAgICAgIGBXb3JrdHJlZSBkaXJlY3RvcnkgY291bGQgbm90IGJlIHJlbW92ZWQgYWZ0ZXIgZ2l0IGludGVybmFsIGNsZWFudXA6ICR7cmVzb2x2ZWRXdFBhdGh9LiBgICtcbiAgICAgICAgICAgIGBNYW51YWwgY2xlYW51cDogcm0gLXJmIFwiJHtyZXNvbHZlZFd0UGF0aC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIil9XCJgLFxuICAgICAgICAgIHsgd29ya3RyZWU6IG5hbWUgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgLy8gUGF0aCBpcyBvdXRzaWRlIGNvbnRhaW5tZW50IFx1MjAxNCBvbmx5IGRvIGEgbm9uLWZvcmNlIGdpdCB3b3JrdHJlZSByZW1vdmVcbiAgICAvLyAod2hpY2ggcmVmdXNlcyB0byBkZWxldGUgZGlydHkgd29ya3RyZWVzKSBhbmQgbmV2ZXIgZmFsbCBiYWNrIHRvIHJtU3luYy5cbiAgICBjb25zb2xlLmVycm9yKFxuICAgICAgYFtHU0RdIFdBUk5JTkc6IFJlc29sdmVkIHdvcmt0cmVlIHBhdGggaXMgb3V0c2lkZSAuZ3NkL3dvcmt0cmVlcy86ICR7cmVzb2x2ZWRXdFBhdGh9XFxuYCArXG4gICAgICAgIGAgIFNraXBwaW5nIGZvcmNlZCByZW1vdmFsIHRvIHByZXZlbnQgZGF0YSBsb3NzLmAsXG4gICAgKTtcbiAgICB0cnkgeyBuYXRpdmVXb3JrdHJlZVJlbW92ZShiYXNlUGF0aCwgcmVzb2x2ZWRXdFBhdGgsIGZhbHNlKTsgfSBjYXRjaCAoZSkgeyBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYG5vbi1mb3JjZSB3b3JrdHJlZSByZW1vdmUgZmFpbGVkIGZvciAke3Jlc29sdmVkV3RQYXRofTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7IH1cbiAgfVxuXG4gIC8vIFBydW5lIHN0YWxlIGVudHJpZXMgc28gZ2l0IGtub3dzIHRoZSB3b3JrdHJlZSBpcyBnb25lXG4gIG5hdGl2ZVdvcmt0cmVlUHJ1bmUoYmFzZVBhdGgpO1xuXG4gIGlmIChkZWxldGVCcmFuY2gpIHtcbiAgICBkZWxldGVCcmFuY2hJZlByZXNlbnQoYmFzZVBhdGgsIGJyYW5jaCwgXCJmaW5hbCBicmFuY2ggZGVsZXRlIGZhaWxlZFwiKTtcbiAgfVxufVxuXG4vKipcbiAqIFBhdGhzIHRvIHNraXAgaW4gYWxsIHdvcmt0cmVlIGRpZmZzIChpbnRlcm5hbC9ydW50aW1lIGFydGlmYWN0cykuXG4gKlxuICogTk9URTogVGhlc2UgYXJyYXlzIG11c3Qgc3RheSBzeW5jaHJvbml6ZWQgd2l0aCBHU0RfUlVOVElNRV9QQVRURVJOUyBpbiBnaXRpZ25vcmUudHMuXG4gKiBUaGF0IGZpbGUgaXMgdGhlIGNhbm9uaWNhbCBzb3VyY2Ugb2YgdHJ1dGggZm9yIHJ1bnRpbWUgaWdub3JlIHBhdHRlcm5zLlxuICogVGhpcyBtb2R1bGUgdXNlcyBhIHNwbGl0IHJlcHJlc2VudGF0aW9uIChwYXRocy9leGFjdC9wcmVmaXhlcykgZm9yIGVmZmljaWVudCBtYXRjaGluZy5cbiAqL1xuY29uc3QgU0tJUF9QQVRIUyA9IFtcbiAgXCIuZ3NkL3dvcmt0cmVlcy9cIixcbiAgXCIuZ3NkL3J1bnRpbWUvXCIsXG4gIFwiLmdzZC9hY3Rpdml0eS9cIixcbiAgXCIuZ3NkL2F1ZGl0L1wiLFxuICBcIi5nc2QvZm9yZW5zaWNzL1wiLFxuICBcIi5nc2QvcGFyYWxsZWwvXCIsXG4gIFwiLmdzZC9qb3VybmFsL1wiLFxuXTtcbmNvbnN0IFNLSVBfRVhBQ1QgPSBbXG4gIFwiLmdzZC9TVEFURS5tZFwiLFxuICBcIi5nc2QvYXV0by5sb2NrXCIsXG4gIFwiLmdzZC9tZXRyaWNzLmpzb25cIixcbiAgXCIuZ3NkL3N0YXRlLW1hbmlmZXN0Lmpzb25cIixcbiAgXCIuZ3NkL2RvY3Rvci1oaXN0b3J5Lmpzb25sXCIsXG4gIFwiLmdzZC9ldmVudC1sb2cuanNvbmxcIixcbl07XG4vKiogRmlsZSBwcmVmaXhlcyB0byBza2lwIChmb3Igd2lsZGNhcmQgcGF0dGVybnMgbGlrZSBjb21wbGV0ZWQtdW5pdHMqLmpzb24sIGdzZC5kYiopLiAqL1xuY29uc3QgU0tJUF9QUkVGSVhFUyA9IFtcbiAgXCIuZ3NkL2NvbXBsZXRlZC11bml0c1wiLFxuICBcIi5nc2QvZ3NkLmRiXCIsXG5dO1xuXG5mdW5jdGlvbiBzaG91bGRTa2lwUGF0aChmaWxlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChTS0lQX1BBVEhTLnNvbWUocCA9PiBmaWxlUGF0aC5zdGFydHNXaXRoKHApKSkgcmV0dXJuIHRydWU7XG4gIGlmIChTS0lQX0VYQUNULmluY2x1ZGVzKGZpbGVQYXRoKSkgcmV0dXJuIHRydWU7XG4gIGlmIChTS0lQX1BSRUZJWEVTLnNvbWUocCA9PiBmaWxlUGF0aC5zdGFydHNXaXRoKHApKSkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gcGFyc2VEaWZmTmFtZVN0YXR1cyhlbnRyaWVzOiB7IHN0YXR1czogc3RyaW5nOyBwYXRoOiBzdHJpbmcgfVtdKTogV29ya3RyZWVEaWZmU3VtbWFyeSB7XG4gIGNvbnN0IGFkZGVkOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBtb2RpZmllZDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgcmVtb3ZlZDogc3RyaW5nW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IHsgc3RhdHVzLCBwYXRoIH0gb2YgZW50cmllcykge1xuICAgIGlmIChzaG91bGRTa2lwUGF0aChwYXRoKSkgY29udGludWU7XG5cbiAgICBzd2l0Y2ggKHN0YXR1cykge1xuICAgICAgY2FzZSBcIkFcIjogYWRkZWQucHVzaChwYXRoKTsgYnJlYWs7XG4gICAgICBjYXNlIFwiTVwiOiBtb2RpZmllZC5wdXNoKHBhdGgpOyBicmVhaztcbiAgICAgIGNhc2UgXCJEXCI6IHJlbW92ZWQucHVzaChwYXRoKTsgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICAvLyBSZW5hbWVzLCBjb3BpZXMgXHUyMDE0IHRyZWF0IGFzIG1vZGlmaWVkXG4gICAgICAgIGlmIChzdGF0dXM/LnN0YXJ0c1dpdGgoXCJSXCIpIHx8IHN0YXR1cz8uc3RhcnRzV2l0aChcIkNcIikpIHtcbiAgICAgICAgICBtb2RpZmllZC5wdXNoKHBhdGgpO1xuICAgICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgYWRkZWQsIG1vZGlmaWVkLCByZW1vdmVkIH07XG59XG5cbi8qKlxuICogRGlmZiB0aGUgLmdzZC8gZGlyZWN0b3J5IGJldHdlZW4gdGhlIHdvcmt0cmVlIGJyYW5jaCBhbmQgbWFpbiBicmFuY2guXG4gKiBSZXR1cm5zIGEgc3VtbWFyeSBvZiBhZGRlZCwgbW9kaWZpZWQsIGFuZCByZW1vdmVkIEdTRCBhcnRpZmFjdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWZmV29ya3RyZWVHU0QoYmFzZVBhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogV29ya3RyZWVEaWZmU3VtbWFyeSB7XG4gIGJhc2VQYXRoID0gbm9ybWFsaXplQmFzZVBhdGhGb3JXb3JrdHJlZU9wcyhiYXNlUGF0aCk7XG5cbiAgY29uc3QgYnJhbmNoID0gd29ya3RyZWVCcmFuY2hOYW1lKG5hbWUpO1xuICBjb25zdCBtYWluQnJhbmNoID0gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG5cbiAgY29uc3QgZW50cmllcyA9IG5hdGl2ZURpZmZOYW1lU3RhdHVzKGJhc2VQYXRoLCBtYWluQnJhbmNoLCBicmFuY2gsIFwiLmdzZC9cIiwgdHJ1ZSk7XG5cbiAgcmV0dXJuIHBhcnNlRGlmZk5hbWVTdGF0dXMoZW50cmllcyk7XG59XG5cbi8qKlxuICogRGlmZiBBTEwgZmlsZXMgYmV0d2VlbiB0aGUgd29ya3RyZWUgYnJhbmNoIGFuZCBtYWluIGJyYW5jaC5cbiAqIFVzZXMgZGlyZWN0IGRpZmYgKG5vIG1lcmdlLWJhc2UpIHRvIHNob3cgd2hhdCB3aWxsIGFjdHVhbGx5IGNoYW5nZVxuICogb24gbWFpbiB3aGVuIHRoZSBtZXJnZSBpcyBhcHBsaWVkLiBJZiBib3RoIGJyYW5jaGVzIGhhdmUgaWRlbnRpY2FsXG4gKiBjb250ZW50LCB0aGlzIGNvcnJlY3RseSByZXR1cm5zIGFuIGVtcHR5IGRpZmYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWZmV29ya3RyZWVBbGwoYmFzZVBhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nLCBicmFuY2hPdmVycmlkZT86IHN0cmluZyk6IFdvcmt0cmVlRGlmZlN1bW1hcnkge1xuICBiYXNlUGF0aCA9IG5vcm1hbGl6ZUJhc2VQYXRoRm9yV29ya3RyZWVPcHMoYmFzZVBhdGgpO1xuXG4gIGNvbnN0IGJyYW5jaCA9IGJyYW5jaE92ZXJyaWRlID8/IHdvcmt0cmVlQnJhbmNoTmFtZShuYW1lKTtcbiAgY29uc3QgbWFpbkJyYW5jaCA9IG5hdGl2ZURldGVjdE1haW5CcmFuY2goYmFzZVBhdGgpO1xuXG4gIGNvbnN0IGVudHJpZXMgPSBuYXRpdmVEaWZmTmFtZVN0YXR1cyhiYXNlUGF0aCwgbWFpbkJyYW5jaCwgYnJhbmNoKTtcblxuICByZXR1cm4gcGFyc2VEaWZmTmFtZVN0YXR1cyhlbnRyaWVzKTtcbn1cblxuLyoqXG4gKiBHZXQgcGVyLWZpbGUgbGluZSBhZGRpdGlvbi9kZWxldGlvbiBzdGF0cyBmb3Igd2hhdCB3aWxsIGNoYW5nZSBvbiBtYWluLlxuICogVXNlcyBkaXJlY3QgZGlmZiAobm90IG1lcmdlLWJhc2UpIHNvIHRoZSBwcmV2aWV3IG1hdGNoZXMgdGhlIGFjdHVhbCBtZXJnZSBvdXRjb21lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGlmZldvcmt0cmVlTnVtc3RhdChiYXNlUGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGJyYW5jaE92ZXJyaWRlPzogc3RyaW5nKTogRmlsZUxpbmVTdGF0W10ge1xuICBiYXNlUGF0aCA9IG5vcm1hbGl6ZUJhc2VQYXRoRm9yV29ya3RyZWVPcHMoYmFzZVBhdGgpO1xuXG4gIGNvbnN0IGJyYW5jaCA9IGJyYW5jaE92ZXJyaWRlID8/IHdvcmt0cmVlQnJhbmNoTmFtZShuYW1lKTtcbiAgY29uc3QgbWFpbkJyYW5jaCA9IG5hdGl2ZURldGVjdE1haW5CcmFuY2goYmFzZVBhdGgpO1xuXG4gIGNvbnN0IHJhd1N0YXRzID0gbmF0aXZlRGlmZk51bXN0YXQoYmFzZVBhdGgsIG1haW5CcmFuY2gsIGJyYW5jaCk7XG5cbiAgY29uc3Qgc3RhdHM6IEZpbGVMaW5lU3RhdFtdID0gW107XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmF3U3RhdHMpIHtcbiAgICBpZiAoc2hvdWxkU2tpcFBhdGgoZW50cnkucGF0aCkpIGNvbnRpbnVlO1xuICAgIHN0YXRzLnB1c2goeyBmaWxlOiBlbnRyeS5wYXRoLCBhZGRlZDogZW50cnkuYWRkZWQsIHJlbW92ZWQ6IGVudHJ5LnJlbW92ZWQgfSk7XG4gIH1cbiAgcmV0dXJuIHN0YXRzO1xufVxuXG4vKipcbiAqIEdldCB0aGUgZnVsbCBkaWZmIGNvbnRlbnQgZm9yIC5nc2QvIGJldHdlZW4gdGhlIHdvcmt0cmVlIGJyYW5jaCBhbmQgbWFpbi5cbiAqIFJldHVybnMgdGhlIHJhdyB1bmlmaWVkIGRpZmYgZm9yIExMTSBjb25zdW1wdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFdvcmt0cmVlR1NERGlmZihiYXNlUGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBiYXNlUGF0aCA9IG5vcm1hbGl6ZUJhc2VQYXRoRm9yV29ya3RyZWVPcHMoYmFzZVBhdGgpO1xuXG4gIGNvbnN0IGJyYW5jaCA9IHdvcmt0cmVlQnJhbmNoTmFtZShuYW1lKTtcbiAgY29uc3QgbWFpbkJyYW5jaCA9IG5hdGl2ZURldGVjdE1haW5CcmFuY2goYmFzZVBhdGgpO1xuXG4gIHJldHVybiBuYXRpdmVEaWZmQ29udGVudChiYXNlUGF0aCwgbWFpbkJyYW5jaCwgYnJhbmNoLCBcIi5nc2QvXCIsIHVuZGVmaW5lZCwgdHJ1ZSk7XG59XG5cbi8qKlxuICogR2V0IHRoZSBmdWxsIGRpZmYgY29udGVudCBmb3Igbm9uLS5nc2QvIGZpbGVzIGJldHdlZW4gdGhlIHdvcmt0cmVlIGJyYW5jaCBhbmQgbWFpbi5cbiAqIFJldHVybnMgdGhlIHJhdyB1bmlmaWVkIGRpZmYgZm9yIExMTSBjb25zdW1wdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFdvcmt0cmVlQ29kZURpZmYoYmFzZVBhdGg6IHN0cmluZywgbmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgYmFzZVBhdGggPSBub3JtYWxpemVCYXNlUGF0aEZvcldvcmt0cmVlT3BzKGJhc2VQYXRoKTtcblxuICBjb25zdCBicmFuY2ggPSB3b3JrdHJlZUJyYW5jaE5hbWUobmFtZSk7XG4gIGNvbnN0IG1haW5CcmFuY2ggPSBuYXRpdmVEZXRlY3RNYWluQnJhbmNoKGJhc2VQYXRoKTtcblxuICByZXR1cm4gbmF0aXZlRGlmZkNvbnRlbnQoYmFzZVBhdGgsIG1haW5CcmFuY2gsIGJyYW5jaCwgdW5kZWZpbmVkLCBcIi5nc2QvXCIsIHRydWUpO1xufVxuXG4vKipcbiAqIEdldCBjb21taXQgbG9nIGZvciB0aGUgd29ya3RyZWUgYnJhbmNoIHNpbmNlIGl0IGRpdmVyZ2VkIGZyb20gbWFpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFdvcmt0cmVlTG9nKGJhc2VQYXRoOiBzdHJpbmcsIG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGJhc2VQYXRoID0gbm9ybWFsaXplQmFzZVBhdGhGb3JXb3JrdHJlZU9wcyhiYXNlUGF0aCk7XG5cbiAgY29uc3QgYnJhbmNoID0gd29ya3RyZWVCcmFuY2hOYW1lKG5hbWUpO1xuICBjb25zdCBtYWluQnJhbmNoID0gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG5cbiAgY29uc3QgZW50cmllcyA9IG5hdGl2ZUxvZ09uZWxpbmUoYmFzZVBhdGgsIG1haW5CcmFuY2gsIGJyYW5jaCk7XG5cbiAgcmV0dXJuIGVudHJpZXMubWFwKGUgPT4gYCR7ZS5zaGF9ICR7ZS5tZXNzYWdlfWApLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogTWVyZ2UgdGhlIHdvcmt0cmVlIGJyYW5jaCBpbnRvIG1haW4gdXNpbmcgc3F1YXNoIG1lcmdlLlxuICogTXVzdCBiZSBjYWxsZWQgZnJvbSB0aGUgbWFpbiB3b3JraW5nIHRyZWUgKG5vdCB0aGUgd29ya3RyZWUgaXRzZWxmKS5cbiAqIFJldHVybnMgdGhlIG1lcmdlIGNvbW1pdCBtZXNzYWdlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWVyZ2VXb3JrdHJlZVRvTWFpbihiYXNlUGF0aDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGNvbW1pdE1lc3NhZ2U6IHN0cmluZywgYnJhbmNoT3ZlcnJpZGU/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBiYXNlUGF0aCA9IG5vcm1hbGl6ZUJhc2VQYXRoRm9yV29ya3RyZWVPcHMoYmFzZVBhdGgpO1xuXG4gIGNvbnN0IGJyYW5jaCA9IGJyYW5jaE92ZXJyaWRlID8/IHdvcmt0cmVlQnJhbmNoTmFtZShuYW1lKTtcbiAgY29uc3QgbWFpbkJyYW5jaCA9IG5hdGl2ZURldGVjdE1haW5CcmFuY2goYmFzZVBhdGgpO1xuICBjb25zdCBjdXJyZW50ID0gbmF0aXZlR2V0Q3VycmVudEJyYW5jaChiYXNlUGF0aCk7XG5cbiAgaWYgKGN1cnJlbnQgIT09IG1haW5CcmFuY2gpIHtcbiAgICB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX0dJVF9FUlJPUiwgYE11c3QgYmUgb24gJHttYWluQnJhbmNofSB0byBtZXJnZS4gQ3VycmVudGx5IG9uICR7Y3VycmVudH0uYCk7XG4gIH1cblxuICBjb25zdCByZXN1bHQgPSBuYXRpdmVNZXJnZVNxdWFzaChiYXNlUGF0aCwgYnJhbmNoKTtcbiAgaWYgKCFyZXN1bHQuc3VjY2Vzcykge1xuICAgIHRocm93IG5ldyBHU0RFcnJvcihHU0RfTUVSR0VfQ09ORkxJQ1QsIGBNZXJnZSBjb25mbGljdHMgZGV0ZWN0ZWQgaW46ICR7cmVzdWx0LmNvbmZsaWN0cy5qb2luKFwiLCBcIil9YCk7XG4gIH1cblxuICBuYXRpdmVDb21taXQoYmFzZVBhdGgsIGNvbW1pdE1lc3NhZ2UpO1xuXG4gIHJldHVybiBjb21taXRNZXNzYWdlO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBaUJBLFNBQVMsWUFBWSxXQUFXLFdBQVcsYUFBYSxjQUFjLGNBQWMsY0FBYztBQUNsRyxTQUFTLG9CQUFvQjtBQUM3QixTQUFTLE1BQU0sU0FBUyxXQUFXO0FBQ25DLFNBQVMsVUFBVSxpQkFBaUIsaUJBQWlCLGVBQWUsZUFBZSwwQkFBMEI7QUFDN0csU0FBUyxrQkFBa0I7QUFDM0I7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsaUNBQWlDO0FBQzFDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQTJCUCxTQUFTLHNCQUFzQixVQUFrQixRQUFnQixlQUE2QjtBQUM1RixNQUFJO0FBQ0YsUUFBSSxDQUFDLG1CQUFtQixVQUFVLE1BQU0sRUFBRztBQUMzQyx1QkFBbUIsVUFBVSxRQUFRLElBQUk7QUFBQSxFQUMzQyxTQUFTLEdBQUc7QUFDVixlQUFXLFlBQVksR0FBRyxhQUFhLEtBQU0sRUFBWSxPQUFPLEVBQUU7QUFBQSxFQUNwRTtBQUNGO0FBSUEsU0FBUywyQkFBMkIsTUFBc0I7QUFDeEQsUUFBTSxhQUFhLEtBQ2hCLFdBQVcsTUFBTSxHQUFHLEVBQ3BCLFFBQVEsYUFBYSxFQUFFLEVBQ3ZCLFFBQVEsUUFBUSxFQUFFO0FBQ3JCLFNB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
