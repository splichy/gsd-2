import {
  existsSync,
  cpSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  lstatSync as lstatSyncFn
} from "node:fs";
import { isAbsolute, join, relative, sep as pathSep } from "node:path";
import { GSDError, GSD_IO_ERROR, GSD_GIT_ERROR } from "./errors.js";
import {
  reconcileWorktreeDb,
  isDbAvailable,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  closeDatabase,
  openDatabase,
  getDbPath
} from "./gsd-db.js";
import { execFileSync } from "node:child_process";
import { gsdRoot, resolveGsdPathContract } from "./paths.js";
import {
  createWorktree,
  removeWorktree,
  resolveGitDir,
  worktreePath,
  isInsideWorktreesDir
} from "./worktree-manager.js";
import {
  detectWorktreeName,
  nudgeGitBranchCache
} from "./worktree.js";
import {
  isGsdWorktreePath,
  normalizeWorktreePathForCompare,
  resolveWorktreeProjectRoot
} from "./worktree-root.js";
import { MergeConflictError, createDraftPR, readIntegrationBranch, RUNTIME_EXCLUSION_PATHS } from "./git-service.js";
import { buildPrEvidence } from "./pr-evidence.js";
import { debugLog } from "./debug-logger.js";
import { logWarning, logError } from "./workflow-logger.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import {
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeWorkingTreeStatus,
  nativeAddAllWithExclusions,
  nativeCommit,
  nativeCheckoutBranch,
  nativeMergeSquash,
  nativeConflictFiles,
  nativeCheckoutTheirs,
  nativeAddPaths,
  nativeRmForce,
  nativeBranchDelete,
  nativeBranchForceReset,
  nativeBranchExists,
  nativeDiffNumstat,
  nativeUpdateRef,
  nativeIsAncestor,
  nativeMergeAbort,
  nativeWorktreeList
} from "./native-git-bridge.js";
import { gsdHome } from "./gsd-home.js";
import { createWorkspace } from "./workspace.js";
import {
  _finalizeProjectionForMergeImpl,
  _projectRootToWorktreeImpl,
  _projectWorktreeToRootImpl
} from "./worktree-state-projection.js";
const PROJECT_PREFERENCES_FILE = "PREFERENCES.md";
const LEGACY_PROJECT_PREFERENCES_FILE = "preferences.md";
const LEGACY_DEEP_SETUP_RUNTIME_UNIT_FILES = /* @__PURE__ */ new Set([
  "workflow-preferences-WORKFLOW-PREFS.json",
  "discuss-project-PROJECT.json",
  "discuss-requirements-REQUIREMENTS.json",
  "research-decision-RESEARCH-DECISION.json",
  "research-project-RESEARCH-PROJECT.json"
]);
const ROOT_STATE_FILES = [
  "DECISIONS.md",
  "REQUIREMENTS.md",
  "PROJECT.md",
  "KNOWLEDGE.md",
  "OVERRIDES.md",
  "QUEUE.md",
  "completed-units.json",
  "metrics.json",
  "mcp.json"
  // NOTE: project preferences are intentionally NOT in ROOT_STATE_FILES.
  // Forward-sync (main → worktree) is handled explicitly in syncGsdStateToWorktree().
  // Back-sync (worktree → main) must NEVER overwrite the project root's copy
  // because the project root is authoritative for preferences (#2684).
];
function popStashByRef(basePath, stashMarker) {
  let popArg = null;
  if (stashMarker) {
    try {
      const list = execFileSync("git", ["stash", "list", "--format=%gd%x00%s"], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8"
      }).trim().split("\n").filter(Boolean);
      for (const entry of list) {
        const [ref, subject] = entry.split("\0");
        if (ref && subject?.includes(stashMarker)) {
          popArg = ref;
          break;
        }
      }
    } catch (err) {
      logWarning("worktree", `stash list lookup failed; leaving stash untouched: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!popArg) {
    logWarning("worktree", "recorded stash entry could not be resolved; skipping automatic pop");
    return null;
  }
  try {
    execFileSync("git", ["stash", "pop", popArg], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    });
  } catch (err) {
    if (err && typeof err === "object") {
      err.stashRef = popArg;
    }
    throw err;
  }
  return popArg;
}
function stashRefFromError(err) {
  if (!err || typeof err !== "object") return null;
  const stashRef = err.stashRef;
  return typeof stashRef === "string" && stashRef.length > 0 ? stashRef : null;
}
function isSamePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch (e) {
    if (e.code === "ENOENT") return false;
    logWarning("worktree", `isSamePath failed: ${e.message}`);
    return false;
  }
}
function _isSamePath(a, b) {
  return isSamePath(a, b);
}
function _resolveAutoWorktreeStartPoint(integrationBranch, gitMainBranch, branchExists) {
  if (integrationBranch) return integrationBranch;
  return gitMainBranch && typeof gitMainBranch === "string" && gitMainBranch.length > 0 && branchExists(gitMainBranch) ? gitMainBranch : void 0;
}
function _shouldReconcileWorktreeDb(worktreeDbPath, mainDbPath, pathExists = existsSync, samePath = isSamePath) {
  return pathExists(worktreeDbPath) && !samePath(worktreeDbPath, mainDbPath);
}
function _isExpectedWorktreeUnlinkError(code) {
  return code === "ENOENT" || code === "EISDIR";
}
function stripGsdDisplayPrefix(value, id) {
  const raw = String(value ?? "").trim();
  if (!raw) return void 0;
  const lower = raw.toLowerCase();
  const idLower = id.toLowerCase();
  if (lower.startsWith(`${idLower}:`)) return raw.slice(id.length + 1).trim() || void 0;
  return raw;
}
let activeWorkspace = null;
function setActiveWorkspace(ws) {
  activeWorkspace = ws;
}
function getActiveWorkspace() {
  return activeWorkspace;
}
function gitPathspecForWorktreePath(basePath, targetPath) {
  let base = basePath;
  let target = targetPath;
  try {
    base = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8"
    }).trim() || basePath;
  } catch {
    void base;
  }
  try {
    base = realpathSync.native(base);
  } catch {
    void base;
  }
  try {
    target = realpathSync.native(targetPath);
  } catch {
    void target;
  }
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.replaceAll("\\", "/");
}
function _gitPathspecForWorktreePath(basePath, targetPath) {
  return gitPathspecForWorktreePath(basePath, targetPath);
}
function gitRemoteExists(basePath, remote) {
  try {
    execFileSync("git", ["remote", "get-url", remote], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    });
    return true;
  } catch {
    return false;
  }
}
function findRegularMergeChangedPaths(basePath, milestoneBranch, mainBranch) {
  const changedPaths = /* @__PURE__ */ new Set();
  let mergeLog = "";
  try {
    mergeLog = execFileSync("git", ["rev-list", "--merges", "--parents", mainBranch], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    }).trim();
  } catch (err) {
    logWarning("worktree", `regular merge lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return changedPaths;
  }
  for (const line of mergeLog.split("\n").filter(Boolean)) {
    const [mergeCommit, firstParent, ...otherParents] = line.split(" ");
    if (!mergeCommit || !firstParent || otherParents.length === 0) continue;
    const mergedMilestone = otherParents.some((parent) => {
      try {
        return nativeIsAncestor(basePath, milestoneBranch, parent);
      } catch {
        return false;
      }
    });
    if (!mergedMilestone) continue;
    try {
      const output = execFileSync("git", ["diff", "--name-only", firstParent, mergeCommit], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8"
      }).trim();
      for (const path of output.split("\n").filter(Boolean)) {
        if (!path.startsWith(".gsd/")) changedPaths.add(path);
      }
    } catch (err) {
      logWarning("worktree", `regular merge diff lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return changedPaths;
  }
  return changedPaths;
}
function clearProjectRootStateFiles(basePath, milestoneId) {
  const gsdDir = gsdRoot(basePath);
  const transientFiles = [
    join(gsdDir, "STATE.md"),
    join(gsdDir, "milestones", milestoneId, `${milestoneId}-META.json`)
  ];
  for (const file of transientFiles) {
    try {
      unlinkSync(file);
    } catch (err) {
      if (err.code !== "ENOENT") {
        logWarning("worktree", `file unlink failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const syncedDirs = [
    join(gsdDir, "milestones", milestoneId),
    join(gsdDir, "runtime", "units")
  ];
  for (const dir of syncedDirs) {
    try {
      if (existsSync(dir)) {
        const pathspec = gitPathspecForWorktreePath(basePath, dir);
        if (!pathspec) continue;
        const untrackedOutput = execFileSync(
          "git",
          ["ls-files", "--others", "--exclude-standard", pathspec],
          { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
        ).trim();
        if (untrackedOutput) {
          for (const f of untrackedOutput.split("\n").filter(Boolean)) {
            try {
              unlinkSync(join(basePath, f));
            } catch (err) {
              const code = err.code;
              if (!_isExpectedWorktreeUnlinkError(code)) {
                logWarning("worktree", `untracked file unlink failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
      }
    } catch (err) {
      logWarning("worktree", `untracked file cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
const SAFE_AUTO_RESOLVE_PATTERNS = [
  /\.tsbuildinfo$/,
  /\.pyc$/,
  /\/__pycache__\//,
  /\.DS_Store$/,
  /\.map$/
];
const isSafeToAutoResolve = (filePath) => filePath.startsWith(".gsd/") || SAFE_AUTO_RESOLVE_PATTERNS.some((re) => re.test(filePath));
function removeMergeStateFiles(basePath, contextLabel) {
  try {
    const gitDir_ = resolveGitDir(basePath);
    for (const f of ["SQUASH_MSG", "MERGE_MSG", "MERGE_HEAD"]) {
      const p = join(gitDir_, f);
      if (existsSync(p)) unlinkSync(p);
    }
  } catch (err) {
    logError("worktree", `${contextLabel} merge state cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function cleanupSquashConflictState(basePath) {
  try {
    nativeMergeAbort(basePath);
  } catch (err) {
    debugLog("squash-conflict-cleanup:merge-abort-skipped", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
  try {
    execFileSync("git", ["reset", "--merge"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    });
  } catch (err) {
    logError("worktree", `git reset --merge failed after squash conflict: ${err instanceof Error ? err.message : String(err)}`);
  }
  removeMergeStateFiles(basePath, "squash conflict");
}
function syncProjectRootToWorktree(projectRoot, worktreePath_, milestoneId) {
  _projectRootToWorktreeImpl(projectRoot, worktreePath_, milestoneId);
}
function syncStateToProjectRoot(worktreePath_, projectRoot, milestoneId) {
  _projectWorktreeToRootImpl(worktreePath_, projectRoot, milestoneId);
}
function readResourceVersion() {
  const agentDir = process.env.GSD_CODING_AGENT_DIR || join(gsdHome(), "agent");
  const manifestPath = join(agentDir, "managed-resources.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return typeof manifest?.gsdVersion === "string" ? manifest.gsdVersion : null;
  } catch (e) {
    logWarning("worktree", `readResourceVersion failed: ${e.message}`);
    return null;
  }
}
function checkResourcesStale(versionOnStart) {
  if (versionOnStart === null) return null;
  const current = readResourceVersion();
  if (current === null) return null;
  if (current !== versionOnStart) {
    return "GSD resources were updated since this session started. Restart gsd to load the new code.";
  }
  return null;
}
function escapeStaleWorktree(base) {
  const directMarker = `${pathSep}.gsd${pathSep}worktrees${pathSep}`;
  let idx = base.indexOf(directMarker);
  if (idx === -1) {
    const symlinkRe = new RegExp(
      `\\${pathSep}\\.gsd\\${pathSep}projects\\${pathSep}[a-f0-9]+\\${pathSep}worktrees\\${pathSep}`
    );
    const match = base.match(symlinkRe);
    if (!match || match.index === void 0) return base;
    idx = match.index;
  }
  const projectRoot = base.slice(0, idx);
  const candidateGsd = normalizeWorktreePathForCompare(join(projectRoot, ".gsd"));
  const gsdHomeNorm = normalizeWorktreePathForCompare(gsdHome());
  if (candidateGsd === gsdHomeNorm || candidateGsd.startsWith(gsdHomeNorm + "/")) {
    return base;
  }
  try {
    process.chdir(projectRoot);
  } catch (e) {
    logWarning("worktree", `escapeStaleWorktree chdir failed: ${e.message}`);
    return base;
  }
  return projectRoot;
}
function cleanStaleRuntimeUnits(gsdRootPath, hasMilestoneSummary) {
  const runtimeUnitsDir = join(gsdRootPath, "runtime", "units");
  if (!existsSync(runtimeUnitsDir)) return 0;
  let cleaned = 0;
  try {
    for (const file of readdirSync(runtimeUnitsDir)) {
      if (!file.endsWith(".json")) continue;
      if (LEGACY_DEEP_SETUP_RUNTIME_UNIT_FILES.has(file)) {
        try {
          unlinkSync(join(runtimeUnitsDir, file));
          cleaned++;
        } catch (err) {
          logWarning("worktree", `stale runtime unit unlink failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      const staleDiscussMatch = file.match(/^discuss-milestone-(.+)\.json$/);
      if (staleDiscussMatch && !MILESTONE_ID_RE.test(staleDiscussMatch[1])) {
        try {
          unlinkSync(join(runtimeUnitsDir, file));
          cleaned++;
        } catch (err) {
          logWarning("worktree", `stale runtime unit unlink failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      const midMatch = file.match(/(M\d+(?:-[a-z0-9]{6})?)/);
      if (!midMatch) continue;
      if (hasMilestoneSummary(midMatch[1])) {
        try {
          unlinkSync(join(runtimeUnitsDir, file));
          cleaned++;
        } catch (err) {
          logWarning("worktree", `stale runtime unit unlink failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    logWarning("worktree", `stale runtime unit cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return cleaned;
}
function syncGsdStateToWorktreeByScope(rootScope, worktreeScope) {
  if (rootScope.workspace.identityKey !== worktreeScope.workspace.identityKey) {
    throw new Error(
      `syncGsdStateToWorktreeByScope: scope identity mismatch \u2014 rootScope.identityKey="${rootScope.workspace.identityKey}" worktreeScope.identityKey="${worktreeScope.workspace.identityKey}"`
    );
  }
  const mainBasePath = rootScope.workspace.projectRoot;
  const worktreePath_ = worktreeScope.workspace.worktreeRoot ?? worktreeScope.workspace.projectRoot;
  return syncGsdStateToWorktree(mainBasePath, worktreePath_);
}
function syncGsdStateToWorktree(mainBasePath, worktreePath_) {
  const contract = resolveGsdPathContract(worktreePath_, mainBasePath);
  const mainGsd = contract.projectGsd;
  const wtGsd = contract.worktreeGsd ?? join(worktreePath_, ".gsd");
  const synced = [];
  if (isSamePath(mainGsd, wtGsd)) return { synced };
  if (!existsSync(mainGsd) || !existsSync(wtGsd)) return { synced };
  for (const f of ROOT_STATE_FILES) {
    const src = join(mainGsd, f);
    const dst = join(wtGsd, f);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        cpSync(src, dst);
        synced.push(f);
      } catch (err) {
        logWarning("worktree", `file copy failed (${f}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  {
    const worktreeHasPreferences = existsSync(join(wtGsd, PROJECT_PREFERENCES_FILE)) || existsSync(join(wtGsd, LEGACY_PROJECT_PREFERENCES_FILE));
    if (!worktreeHasPreferences) {
      for (const file of [PROJECT_PREFERENCES_FILE, LEGACY_PROJECT_PREFERENCES_FILE]) {
        const src = join(mainGsd, file);
        const dst = join(wtGsd, file);
        if (existsSync(src)) {
          try {
            cpSync(src, dst);
            synced.push(file);
          } catch (err) {
            logWarning("worktree", `preferences copy failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
      }
    }
  }
  const mainMilestonesDir = join(mainGsd, "milestones");
  const wtMilestonesDir = join(wtGsd, "milestones");
  if (existsSync(mainMilestonesDir)) {
    try {
      mkdirSync(wtMilestonesDir, { recursive: true });
      const mainMilestones = readdirSync(mainMilestonesDir, {
        withFileTypes: true
      }).filter((d) => d.isDirectory()).map((d) => d.name);
      for (const mid of mainMilestones) {
        const srcDir = join(mainMilestonesDir, mid);
        const dstDir = join(wtMilestonesDir, mid);
        if (!existsSync(dstDir)) {
          try {
            cpSync(srcDir, dstDir, { recursive: true });
            synced.push(`milestones/${mid}/`);
          } catch (err) {
            logWarning("worktree", `milestone copy failed (${mid}): ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          try {
            const srcFiles = readdirSync(srcDir).filter(
              (f) => f.endsWith(".md") || f.endsWith(".json")
            );
            for (const f of srcFiles) {
              const srcFile = join(srcDir, f);
              const dstFile = join(dstDir, f);
              if (!existsSync(dstFile)) {
                try {
                  const srcStat = lstatSyncFn(srcFile);
                  if (srcStat.isFile()) {
                    cpSync(srcFile, dstFile);
                    synced.push(`milestones/${mid}/${f}`);
                  }
                } catch (err) {
                  logWarning("worktree", `milestone file copy failed (${mid}/${f}): ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
            const srcSlicesDir = join(srcDir, "slices");
            const dstSlicesDir = join(dstDir, "slices");
            if (existsSync(srcSlicesDir) && !existsSync(dstSlicesDir)) {
              try {
                cpSync(srcSlicesDir, dstSlicesDir, { recursive: true });
                synced.push(`milestones/${mid}/slices/`);
              } catch (err) {
                logWarning("worktree", `slices copy failed (${mid}): ${err instanceof Error ? err.message : String(err)}`);
              }
            } else if (existsSync(srcSlicesDir) && existsSync(dstSlicesDir)) {
              const srcSlices = readdirSync(srcSlicesDir, {
                withFileTypes: true
              }).filter((d) => d.isDirectory()).map((d) => d.name);
              for (const sid of srcSlices) {
                const srcSlice = join(srcSlicesDir, sid);
                const dstSlice = join(dstSlicesDir, sid);
                if (!existsSync(dstSlice)) {
                  try {
                    cpSync(srcSlice, dstSlice, { recursive: true });
                    synced.push(`milestones/${mid}/slices/${sid}/`);
                  } catch (err) {
                    logWarning("worktree", `slice copy failed (${mid}/${sid}): ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              }
            }
          } catch (err) {
            logWarning("worktree", `milestone file sync failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } catch (err) {
      logWarning("worktree", `milestone directory sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { synced };
}
function syncWorktreeStateBack(mainBasePath, worktreePath2, milestoneId) {
  return _finalizeProjectionForMergeImpl(mainBasePath, worktreePath2, milestoneId);
}
function runWorktreePostCreateHook(sourceDir, worktreeDir, hookPath) {
  if (hookPath === void 0) {
    const prefs = loadEffectiveGSDPreferences()?.preferences?.git;
    hookPath = prefs?.worktree_post_create;
  }
  if (!hookPath) return null;
  let resolved = isAbsolute(hookPath) ? hookPath : join(sourceDir, hookPath);
  if (!existsSync(resolved)) {
    return `Worktree post-create hook not found: ${resolved}`;
  }
  if (process.platform === "win32") {
    try {
      resolved = realpathSync.native(resolved);
    } catch (err) {
      logWarning("worktree", `realpath failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const needsShell = process.platform === "win32" && /\.(bat|cmd)$/i.test(resolved);
    execFileSync(resolved, [], {
      cwd: worktreeDir,
      env: {
        ...process.env,
        SOURCE_DIR: sourceDir,
        WORKTREE_DIR: worktreeDir
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 3e4,
      // 30 second timeout
      shell: needsShell
    });
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Worktree post-create hook failed: ${msg}`;
  }
}
function autoWorktreeBranch(milestoneId) {
  return `milestone/${milestoneId}`;
}
function normalizeLocalBranchRef(branch) {
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}
function enterBranchModeForMilestone(basePath, milestoneId) {
  const branch = autoWorktreeBranch(milestoneId);
  const branchExists = nativeBranchExists(basePath, branch);
  if (!branchExists) {
    const integrationBranch = readIntegrationBranch(basePath, milestoneId) ?? void 0;
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
    const startPoint = _resolveAutoWorktreeStartPoint(
      integrationBranch,
      gitPrefs?.main_branch,
      (branchName) => nativeBranchExists(basePath, branchName)
    ) ?? nativeDetectMainBranch(basePath);
    const concurrentlyCreated = nativeBranchExists(basePath, branch);
    if (concurrentlyCreated && !nativeIsAncestor(basePath, branch, startPoint)) {
      throw new GSDError(
        GSD_GIT_ERROR,
        `Branch "${branch}" was created concurrently with commits not reachable from "${startPoint}". Refusing to force-reset \u2014 would orphan prior work. Resume the existing milestone or run \`git branch -D ${branch}\` to discard.`
      );
    }
    nativeBranchForceReset(basePath, branch, startPoint);
    debugLog("auto-worktree", {
      action: "enterBranchMode",
      milestoneId,
      branch,
      startPoint,
      created: true
    });
  } else {
    debugLog("auto-worktree", {
      action: "enterBranchMode",
      milestoneId,
      branch,
      reused: true
    });
  }
  nativeCheckoutBranch(basePath, branch);
}
function _isBranchCheckedOutElsewhere(basePath, branch) {
  try {
    const entries = nativeWorktreeList(basePath);
    return entries.some((entry) => entry.branch === branch);
  } catch {
    return true;
  }
}
function _resolveIntegrationBranchForReuse(basePath, milestoneId) {
  const fromMeta = readIntegrationBranch(basePath, milestoneId);
  if (fromMeta) return fromMeta;
  const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
  const fromPref = gitPrefs?.main_branch && typeof gitPrefs.main_branch === "string" && gitPrefs.main_branch.length > 0 && nativeBranchExists(basePath, gitPrefs.main_branch) ? gitPrefs.main_branch : null;
  if (fromPref) return fromPref;
  try {
    return nativeDetectMainBranch(basePath);
  } catch {
    return null;
  }
}
function fastForwardReusedMilestoneBranchIfSafe(basePath, milestoneId, branch) {
  try {
    const integrationBranch = _resolveIntegrationBranchForReuse(basePath, milestoneId);
    if (!integrationBranch || integrationBranch === branch) return;
    if (!nativeBranchExists(basePath, integrationBranch)) return;
    if (!nativeIsAncestor(basePath, branch, integrationBranch)) {
      debugLog("createAutoWorktree", {
        phase: "skip-ff-branch-not-ancestor",
        milestoneId,
        branch,
        integration: integrationBranch
      });
      return;
    }
    if (_isBranchCheckedOutElsewhere(basePath, branch)) {
      debugLog("createAutoWorktree", {
        phase: "skip-ff-branch-checked-out-elsewhere",
        milestoneId,
        branch
      });
      return;
    }
    nativeUpdateRef(basePath, `refs/heads/${branch}`, integrationBranch);
    debugLog("createAutoWorktree", {
      phase: "fast-forward-reused-branch",
      milestoneId,
      branch,
      integration: integrationBranch
    });
  } catch (err) {
    debugLog("createAutoWorktree", {
      phase: "fast-forward-reused-branch-failed",
      milestoneId,
      branch,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
function createAutoWorktree(basePath, milestoneId) {
  basePath = resolveWorktreeProjectRoot(basePath);
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: basePath, stdio: "pipe" });
  } catch {
    throw new GSDError(
      GSD_GIT_ERROR,
      `Cannot create worktree: repository has no commits yet. Worktree isolation requires at least one commit.`
    );
  }
  const branch = autoWorktreeBranch(milestoneId);
  const branchExists = nativeBranchExists(basePath, branch);
  let info;
  if (branchExists) {
    fastForwardReusedMilestoneBranchIfSafe(basePath, milestoneId, branch);
    info = createWorktree(basePath, milestoneId, {
      branch,
      reuseExistingBranch: true
    });
  } else {
    const integrationBranch = readIntegrationBranch(basePath, milestoneId) ?? void 0;
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
    const startPoint = _resolveAutoWorktreeStartPoint(
      integrationBranch,
      gitPrefs?.main_branch,
      (branchName) => nativeBranchExists(basePath, branchName)
    );
    info = createWorktree(basePath, milestoneId, {
      branch,
      startPoint
    });
  }
  const hookError = runWorktreePostCreateHook(basePath, info.path);
  if (hookError) {
    logWarning("reconcile", hookError, { worktree: info.name });
  }
  const previousCwd = process.cwd();
  try {
    process.chdir(info.path);
    setActiveWorkspace(createWorkspace(basePath));
  } catch (err) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree created at ${info.path} but chdir failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  nudgeGitBranchCache(previousCwd);
  return info.path;
}
function teardownAutoWorktree(originalBasePath, milestoneId, opts = {}) {
  originalBasePath = resolveWorktreeProjectRoot(originalBasePath);
  const branch = autoWorktreeBranch(milestoneId);
  const { preserveBranch = false } = opts;
  const previousCwd = process.cwd();
  try {
    try {
      process.chdir(originalBasePath);
    } catch (err) {
      throw new GSDError(
        GSD_IO_ERROR,
        `Failed to chdir back to ${originalBasePath} during teardown: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      clearProjectRootStateFiles(originalBasePath, milestoneId);
    } catch (err) {
      logWarning("worktree", `clearProjectRootStateFiles failed during teardown: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (isDbAvailable()) {
      try {
        const contract = resolveGsdPathContract(previousCwd, originalBasePath);
        const worktreeDbPath = join(contract.worktreeGsd ?? join(previousCwd, ".gsd"), "gsd.db");
        const mainDbPath = contract.projectDb;
        if (_shouldReconcileWorktreeDb(worktreeDbPath, mainDbPath)) {
          reconcileWorktreeDb(mainDbPath, worktreeDbPath);
        }
      } catch (err) {
        logError("worktree", `DB reconciliation failed during teardown: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    nudgeGitBranchCache(previousCwd);
    removeWorktree(originalBasePath, milestoneId, {
      branch,
      deleteBranch: !preserveBranch
    });
    const wtDir = worktreePath(originalBasePath, milestoneId);
    if (existsSync(wtDir)) {
      logWarning(
        "reconcile",
        `Worktree directory still exists after teardown: ${wtDir}. This is likely an orphaned directory consuming disk space. Remove it manually with: rm -rf "${wtDir.replaceAll("\\", "/")}"`,
        { worktree: milestoneId }
      );
      if (isInsideWorktreesDir(originalBasePath, wtDir)) {
        try {
          rmSync(wtDir, { recursive: true, force: true });
        } catch (err) {
          logWarning("worktree", `worktree directory removal failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        console.error(
          `[GSD] REFUSING fallback rmSync \u2014 path is outside .gsd/worktrees/: ${wtDir}`
        );
      }
    }
  } finally {
    setActiveWorkspace(null);
  }
}
function isInAutoWorktree(basePath) {
  const targetPath = isGsdWorktreePath(basePath) ? basePath : process.cwd();
  if (!isGsdWorktreePath(targetPath)) return false;
  const storedBase = getAutoWorktreeOriginalBase();
  const projectRoot = resolveWorktreeProjectRoot(basePath, storedBase);
  const targetProjectRoot = resolveWorktreeProjectRoot(targetPath, storedBase);
  if (normalizeWorktreePathForCompare(projectRoot) !== normalizeWorktreePathForCompare(targetProjectRoot)) {
    return false;
  }
  try {
    const branch = nativeGetCurrentBranch(targetPath);
    return branch.startsWith("milestone/");
  } catch {
    return false;
  }
}
function getAutoWorktreePath(basePath, milestoneId) {
  basePath = resolveWorktreeProjectRoot(basePath);
  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) return null;
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) return null;
  } catch (e) {
    logWarning("worktree", `getAutoWorktreePath .git read failed: ${e.message}`);
    return null;
  }
  return p;
}
function enterAutoWorktree(basePath, milestoneId) {
  basePath = resolveWorktreeProjectRoot(basePath);
  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree for ${milestoneId} does not exist at ${p}`
    );
  }
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) {
    throw new GSDError(
      GSD_GIT_ERROR,
      `Auto-worktree path ${p} exists but is not a git worktree (no .git)`
    );
  }
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) {
      throw new GSDError(
        GSD_GIT_ERROR,
        `Auto-worktree path ${p} has a .git but it is not a worktree gitdir pointer`
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("worktree")) throw err;
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree path ${p} exists but .git is unreadable`
    );
  }
  const previousCwd = process.cwd();
  try {
    process.chdir(p);
    setActiveWorkspace(createWorkspace(basePath));
  } catch (err) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Failed to enter auto-worktree at ${p}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  nudgeGitBranchCache(previousCwd);
  return p;
}
function getAutoWorktreeOriginalBase() {
  return getActiveWorkspace()?.projectRoot ?? null;
}
function _resetAutoWorktreeOriginalBaseForTests() {
  setActiveWorkspace(null);
}
function getActiveAutoWorktreeContext() {
  const ws = getActiveWorkspace();
  if (!ws) return null;
  const originalBase = ws.projectRoot;
  const cwd = process.cwd();
  if (!isGsdWorktreePath(cwd)) return null;
  const cwdProjectRoot = resolveWorktreeProjectRoot(cwd, originalBase);
  if (normalizeWorktreePathForCompare(cwdProjectRoot) !== normalizeWorktreePathForCompare(originalBase)) {
    return null;
  }
  const worktreeName = detectWorktreeName(cwd);
  if (!worktreeName) return null;
  const branch = nativeGetCurrentBranch(cwd);
  if (!branch.startsWith("milestone/")) return null;
  return {
    originalBase,
    worktreeName,
    branch
  };
}
function autoCommitDirtyState(cwd) {
  try {
    const status = nativeWorkingTreeStatus(cwd);
    if (!status) return false;
    nativeAddAllWithExclusions(cwd, RUNTIME_EXCLUSION_PATHS);
    const result = nativeCommit(
      cwd,
      "chore: auto-commit before milestone merge"
    );
    return result !== null;
  } catch (e) {
    debugLog("autoCommitDirtyState", { error: String(e) });
    throw new GSDError(
      GSD_GIT_ERROR,
      `Failed to auto-commit dirty worktree state before milestone merge: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
function mergeMilestoneToMain(originalBasePath_, milestoneId, roadmapContent) {
  const worktreeCwd = process.cwd();
  const milestoneBranch = autoWorktreeBranch(milestoneId);
  {
    let shouldAutoCommit = true;
    if (getActiveWorkspace() !== null) {
      try {
        const currentBranch = nativeGetCurrentBranch(worktreeCwd);
        shouldAutoCommit = currentBranch === milestoneBranch;
      } catch {
        shouldAutoCommit = false;
      }
    }
    if (shouldAutoCommit) {
      autoCommitDirtyState(worktreeCwd);
    }
  }
  if (isDbAvailable()) {
    try {
      const contract = resolveGsdPathContract(worktreeCwd, originalBasePath_);
      const worktreeDbPath = join(contract.worktreeGsd ?? join(worktreeCwd, ".gsd"), "gsd.db");
      const mainDbPath = contract.projectDb;
      if (_shouldReconcileWorktreeDb(worktreeDbPath, mainDbPath)) {
        reconcileWorktreeDb(mainDbPath, worktreeDbPath);
      }
    } catch (err) {
      logError("worktree", `DB reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let completedSlices = [];
  if (isDbAvailable()) {
    completedSlices = getMilestoneSlices(milestoneId).filter((s) => s.status === "complete").map((s) => ({
      id: s.id,
      title: stripGsdDisplayPrefix(s.title, s.id) ?? s.id,
      tasks: getSliceTasks(milestoneId, s.id).filter((task) => task.status === "complete").map((task) => ({
        id: task.id,
        title: stripGsdDisplayPrefix(task.title, task.id) ?? task.id
      }))
    }));
  }
  if (completedSlices.length === 0 && roadmapContent) {
    const sliceRe = /- \[x\] \*\*(\w+):\s*(.+?)\*\*/gi;
    let m;
    while ((m = sliceRe.exec(roadmapContent)) !== null) {
      completedSlices.push({ id: m[1], title: m[2], tasks: [] });
    }
  }
  const previousCwd = process.cwd();
  process.chdir(originalBasePath_);
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const integrationBranch = readIntegrationBranch(
    originalBasePath_,
    milestoneId
  );
  const validatedPrefBranch = prefs.main_branch && nativeBranchExists(originalBasePath_, prefs.main_branch) ? prefs.main_branch : void 0;
  const mainBranch = integrationBranch ?? validatedPrefBranch ?? nativeDetectMainBranch(originalBasePath_);
  if (normalizeLocalBranchRef(mainBranch) === milestoneBranch) {
    process.chdir(previousCwd);
    throw new GSDError(
      GSD_GIT_ERROR,
      `Resolved integration branch "${mainBranch}" is the same ref as milestone branch "${milestoneBranch}" \u2014 refusing to self-merge. Integration branch metadata is invalid; set a distinct main_branch in GSD preferences or repair the milestone integration record before retrying milestone completion.`
    );
  }
  clearProjectRootStateFiles(originalBasePath_, milestoneId);
  const currentBranchAtBase = nativeGetCurrentBranch(originalBasePath_);
  if (!currentBranchAtBase || currentBranchAtBase.length === 0) {
    process.chdir(previousCwd);
    throw new GSDError(
      GSD_GIT_ERROR,
      `Project root is in detached HEAD state \u2014 cannot perform milestone merge. Checkout an integration branch (e.g. \`git checkout ${mainBranch}\`) before resuming.`
    );
  }
  if (currentBranchAtBase !== mainBranch) {
    nativeCheckoutBranch(originalBasePath_, mainBranch);
  }
  const dbMilestone = getMilestone(milestoneId);
  let milestoneTitle = stripGsdDisplayPrefix(dbMilestone?.title, milestoneId) ?? "";
  if (!milestoneTitle && roadmapContent) {
    const titleMatch = roadmapContent.match(new RegExp(`^#\\s+${milestoneId}:\\s*(.+)`, "m"));
    if (titleMatch) milestoneTitle = titleMatch[1].trim();
  }
  milestoneTitle = milestoneTitle || milestoneId;
  const subject = `feat: ${milestoneTitle}`;
  const milestoneContext = milestoneTitle === milestoneId ? `Milestone: ${milestoneId}` : `Milestone: ${milestoneId} - ${milestoneTitle}`;
  let body = "";
  if (completedSlices.length > 0) {
    const sliceLines = completedSlices.map((s) => `- ${s.id}: ${s.title}`).join("\n");
    const taskLines = completedSlices.flatMap((s) => s.tasks.map((task) => `- ${s.id}/${task.id}: ${task.title}`)).join("\n");
    const taskBlock = taskLines ? `

Completed tasks:
${taskLines}` : "";
    body = `

Completed slices:
${sliceLines}${taskBlock}

${milestoneContext}
GSD-Milestone: ${milestoneId}
Branch: ${milestoneBranch}`;
  } else {
    body = `

${milestoneContext}
GSD-Milestone: ${milestoneId}
Branch: ${milestoneBranch}`;
  }
  const commitMessage = subject + body;
  if (worktreeCwd !== originalBasePath_) {
    try {
      const worktreeHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktreeCwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8"
      }).trim();
      const branchHead = execFileSync("git", ["rev-parse", milestoneBranch], {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8"
      }).trim();
      if (worktreeHead && branchHead && worktreeHead !== branchHead) {
        if (nativeIsAncestor(originalBasePath_, branchHead, worktreeHead)) {
          nativeUpdateRef(
            originalBasePath_,
            `refs/heads/${milestoneBranch}`,
            worktreeHead
          );
          debugLog("mergeMilestoneToMain", {
            action: "fast-forward-branch-ref",
            milestoneBranch,
            oldRef: branchHead.slice(0, 8),
            newRef: worktreeHead.slice(0, 8)
          });
        } else {
          process.chdir(previousCwd);
          throw new GSDError(
            GSD_GIT_ERROR,
            `Worktree HEAD (${worktreeHead.slice(0, 8)}) diverged from ${milestoneBranch} (${branchHead.slice(0, 8)}). Manual reconciliation required before merge.`
          );
        }
      }
    } catch (err) {
      if (err instanceof GSDError) throw err;
      debugLog("mergeMilestoneToMain", {
        action: "reconcile-skipped",
        reason: String(err)
      });
    }
  }
  if (nativeIsAncestor(originalBasePath_, milestoneBranch, mainBranch)) {
    const codeChanges = nativeDiffNumstat(
      originalBasePath_,
      mainBranch,
      milestoneBranch
    ).filter((entry) => !entry.path.startsWith(".gsd/"));
    if (codeChanges.length > 0) {
      const regularMergeChangedPaths = findRegularMergeChangedPaths(
        originalBasePath_,
        milestoneBranch,
        mainBranch
      );
      const unanchoredCodeChanges = codeChanges.filter(
        (entry) => regularMergeChangedPaths.has(entry.path)
      );
      if (unanchoredCodeChanges.length > 0) {
        process.chdir(previousCwd);
        throw new GSDError(
          GSD_GIT_ERROR,
          `Milestone branch "${milestoneBranch}" is reachable from "${mainBranch}" but has ${unanchoredCodeChanges.length} milestone-touched code file(s) not on current "${mainBranch}". Aborting worktree teardown to prevent data loss.`
        );
      }
    }
    debugLog("mergeMilestoneToMain", {
      action: "skip-squash-already-merged",
      milestoneId,
      milestoneBranch,
      mainBranch
    });
    try {
      clearProjectRootStateFiles(originalBasePath_, milestoneId);
    } catch (err) {
      logWarning("worktree", `clearProjectRootStateFiles failed during already-merged cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      removeWorktree(originalBasePath_, milestoneId, {
        branch: milestoneBranch,
        deleteBranch: false
      });
    } catch (err) {
      logWarning("worktree", `worktree removal failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      nativeBranchDelete(originalBasePath_, milestoneBranch);
    } catch (err) {
      logWarning("worktree", `git branch-delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setActiveWorkspace(null);
    nudgeGitBranchCache(previousCwd);
    try {
      process.chdir(originalBasePath_);
    } catch (err) {
      logWarning("worktree", `chdir to project root after already-merged cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { commitMessage, pushed: false, prCreated: false, codeFilesChanged: true };
  }
  const milestonesDir = join(gsdRoot(originalBasePath_), "milestones");
  const shelterDir = join(gsdRoot(originalBasePath_), ".milestone-shelter");
  const shelteredDirs = [];
  let shelterRestored = false;
  const restoreShelter = () => {
    if (shelterRestored) return;
    shelterRestored = true;
    if (shelteredDirs.length === 0) return;
    let restoreFailed = false;
    for (const dirName of shelteredDirs) {
      const src = join(shelterDir, dirName);
      if (!existsSync(src)) {
        logWarning(
          "worktree",
          `shelter source missing for ${dirName}; skipping restore (shelter already cleaned or entry never staged)`
        );
        continue;
      }
      try {
        mkdirSync(milestonesDir, { recursive: true });
        cpSync(src, join(milestonesDir, dirName), { recursive: true, force: true });
      } catch (err) {
        restoreFailed = true;
        logError("worktree", `shelter restore failed (${dirName}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (restoreFailed) {
      logWarning("worktree", `shelter retained at ${shelterDir} \u2014 manual recovery required for unrestored entries`);
      return;
    }
    if (existsSync(shelterDir)) {
      try {
        rmSync(shelterDir, { recursive: true, force: true });
      } catch (err) {
        logWarning("worktree", `shelter cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  try {
    if (existsSync(milestonesDir)) {
      const entries = readdirSync(milestonesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === milestoneId) continue;
        const srcDir = join(milestonesDir, entry.name);
        const dstDir = join(shelterDir, entry.name);
        try {
          mkdirSync(shelterDir, { recursive: true });
          cpSync(srcDir, dstDir, { recursive: true, force: true });
          rmSync(srcDir, { recursive: true, force: true });
          shelteredDirs.push(entry.name);
        } catch (err) {
          logWarning("worktree", `milestone shelter failed (${entry.name}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    logWarning("worktree", `milestone shelter operation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const needsDbCycle = process.platform === "win32" && isDbAvailable();
  const dbPathToReopen = needsDbCycle ? getDbPath() : null;
  if (needsDbCycle) {
    try {
      closeDatabase();
    } catch (err) {
      logWarning("worktree", `pre-stash db close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let stashed = false;
  let stashMarker = null;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: originalBasePath_,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    }).trim();
    if (status) {
      stashMarker = `gsd-pre-merge:${milestoneId}:${process.pid}:${Date.now()}:${process.hrtime.bigint().toString(36)}`;
      execFileSync(
        "git",
        ["stash", "push", "--include-untracked", "-m", `gsd: pre-merge stash for ${milestoneId} [${stashMarker}]`],
        { cwd: originalBasePath_, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
      );
      stashed = true;
    }
  } catch (err) {
    logWarning("worktree", `git stash failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (needsDbCycle && dbPathToReopen) {
    try {
      openDatabase(dbPathToReopen);
    } catch (err) {
      logWarning("worktree", `post-stash db reopen failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  removeMergeStateFiles(originalBasePath_, "pre-merge");
  const mergeResult = nativeMergeSquash(originalBasePath_, milestoneBranch);
  if (!mergeResult.success) {
    if (mergeResult.conflicts.includes("__dirty_working_tree__")) {
      removeMergeStateFiles(originalBasePath_, "dirty-tree rejection");
      if (stashed) {
        try {
          popStashByRef(originalBasePath_, stashMarker);
        } catch (err) {
          logWarning("worktree", `git stash pop failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      restoreShelter();
      process.chdir(previousCwd);
      const fileList = mergeResult.dirtyFiles?.length ? `Dirty files:
${mergeResult.dirtyFiles.map((f) => `  ${f}`).join("\n")}` : `Check \`git status\` in the project root for details.`;
      throw new GSDError(
        GSD_GIT_ERROR,
        `Squash merge of ${milestoneBranch} rejected: working tree has dirty or untracked files that conflict with the merge. ${fileList}`
      );
    }
    const conflictedFiles = mergeResult.conflicts.length > 0 ? mergeResult.conflicts : nativeConflictFiles(originalBasePath_);
    if (conflictedFiles.length > 0) {
      const autoResolvable = conflictedFiles.filter(isSafeToAutoResolve);
      const codeConflicts = conflictedFiles.filter(
        (f) => !isSafeToAutoResolve(f)
      );
      if (autoResolvable.length > 0) {
        for (const safeFile of autoResolvable) {
          try {
            nativeCheckoutTheirs(originalBasePath_, [safeFile]);
            nativeAddPaths(originalBasePath_, [safeFile]);
          } catch (e) {
            logWarning("worktree", `checkout --theirs failed for ${safeFile}, removing: ${e.message}`);
            nativeRmForce(originalBasePath_, [safeFile]);
          }
        }
      }
      if (codeConflicts.length > 0) {
        cleanupSquashConflictState(originalBasePath_);
        if (stashed) {
          try {
            popStashByRef(originalBasePath_, stashMarker);
          } catch (err) {
            logWarning("worktree", `git stash pop failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        restoreShelter();
        process.chdir(previousCwd);
        throw new MergeConflictError(
          codeConflicts,
          "squash",
          milestoneBranch,
          mainBranch
        );
      }
    }
  }
  const commitResult = nativeCommit(originalBasePath_, commitMessage);
  const nothingToCommit = commitResult === null;
  removeMergeStateFiles(originalBasePath_, "post-commit");
  if (stashed) {
    let stashRefForDrop = null;
    try {
      stashRefForDrop = popStashByRef(originalBasePath_, stashMarker);
    } catch (e) {
      stashRefForDrop = stashRefFromError(e);
      logWarning("worktree", `git stash pop failed, attempting conflict resolution: ${e.message}`);
      const uu = nativeConflictFiles(originalBasePath_);
      const gsdUU = uu.filter((f) => f.startsWith(".gsd/"));
      const nonGsdUU = uu.filter((f) => !f.startsWith(".gsd/"));
      if (gsdUU.length > 0) {
        for (const f of gsdUU) {
          try {
            execFileSync("git", ["checkout", "HEAD", "--", f], {
              cwd: originalBasePath_,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8"
            });
            nativeAddPaths(originalBasePath_, [f]);
          } catch (e2) {
            logWarning("worktree", `checkout HEAD failed for ${f}, removing: ${e2.message}`);
            nativeRmForce(originalBasePath_, [f]);
          }
        }
      }
      if (gsdUU.length > 0 && nonGsdUU.length === 0) {
        if (stashRefForDrop) {
          try {
            execFileSync("git", ["stash", "drop", stashRefForDrop], {
              cwd: originalBasePath_,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8"
            });
          } catch (err) {
            logWarning("worktree", `git stash drop failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          logWarning("worktree", "recorded stash entry could not be resolved; skipping automatic drop");
        }
      } else if (nonGsdUU.length > 0) {
        logWarning("reconcile", "Stash pop conflict on non-.gsd files after merge", {
          files: nonGsdUU.join(", ")
        });
      } else {
        logWarning(
          "worktree",
          "git stash pop failed without resolvable conflict files; leaving stash for manual recovery"
        );
      }
    }
  }
  restoreShelter();
  if (nothingToCommit) {
    const numstat = nativeDiffNumstat(
      originalBasePath_,
      mainBranch,
      milestoneBranch
    );
    const codeChanges = numstat.filter(
      (entry) => !entry.path.startsWith(".gsd/")
    );
    if (codeChanges.length > 0) {
      process.chdir(previousCwd);
      throw new GSDError(
        GSD_GIT_ERROR,
        `Squash merge produced nothing to commit but milestone branch "${milestoneBranch}" has ${codeChanges.length} code file(s) not on "${mainBranch}". Aborting worktree teardown to prevent data loss.`
      );
    }
  }
  const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  let codeFilesChanged = false;
  if (!nothingToCommit) {
    try {
      const diffTreeOutput = execFileSync(
        "git",
        ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "HEAD"],
        { cwd: originalBasePath_, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
      ).trim();
      const mergedFiles = diffTreeOutput ? diffTreeOutput.split("\n").filter(Boolean) : [];
      codeFilesChanged = mergedFiles.some((f) => !f.startsWith(".gsd/"));
    } catch (e) {
      try {
        const fallbackOutput = execFileSync(
          "git",
          ["diff", "--name-only", GIT_EMPTY_TREE, "HEAD"],
          { cwd: originalBasePath_, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
        ).trim();
        const fallbackFiles = fallbackOutput ? fallbackOutput.split("\n").filter(Boolean) : [];
        codeFilesChanged = fallbackFiles.some((f) => !f.startsWith(".gsd/"));
      } catch {
        logWarning("worktree", `diff-tree and empty-tree fallback both failed (assuming code changed): ${e.message}`);
        codeFilesChanged = true;
      }
    }
  }
  let pushed = false;
  if (prefs.auto_push === true && prefs.auto_pr !== true && !nothingToCommit) {
    const remote = prefs.remote ?? "origin";
    if (gitRemoteExists(originalBasePath_, remote)) {
      try {
        execFileSync("git", ["push", remote, mainBranch], {
          cwd: originalBasePath_,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8"
        });
        pushed = true;
      } catch (err) {
        logWarning("worktree", `git push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  let prCreated = false;
  if (prefs.auto_pr === true && !nothingToCommit) {
    const remote = prefs.remote ?? "origin";
    const prTarget = prefs.pr_target_branch ?? mainBranch;
    if (gitRemoteExists(originalBasePath_, remote)) {
      try {
        execFileSync("git", ["push", remote, milestoneBranch], {
          cwd: originalBasePath_,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf-8"
        });
        const prEvidence = buildPrEvidence({
          milestoneId,
          milestoneTitle,
          changeType: "feat",
          summaries: completedSlices.map((slice) => `### ${slice.id}
${slice.title}`),
          testsRun: ["Auto-created after milestone merge. Run `npm run verify:pr` before marking this draft ready."],
          rollbackNotes: ["Close the draft PR or revert the merge commit if review finds a behavior regression."],
          how: "Generated by git.auto_pr after the milestone branch was pushed and merged locally."
        });
        const prUrl = createDraftPR(originalBasePath_, milestoneId, prEvidence.title, prEvidence.body, {
          head: milestoneBranch,
          base: prTarget
        });
        if (!prUrl) {
          throw new Error("gh pr create returned no URL");
        }
        prCreated = true;
      } catch (err) {
        logWarning("worktree", `PR creation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (existsSync(worktreeCwd)) {
    let preTeardownBranch = null;
    try {
      preTeardownBranch = nativeGetCurrentBranch(worktreeCwd);
    } catch (err) {
      debugLog("mergeMilestoneToMain", { phase: "pre-teardown-branch-detect-failed", error: String(err) });
    }
    const isOnMilestoneBranch = preTeardownBranch === milestoneBranch;
    if (isOnMilestoneBranch) {
      try {
        const dirtyCheck = nativeWorkingTreeStatus(worktreeCwd);
        if (dirtyCheck) {
          process.chdir(previousCwd);
          throw new GSDError(
            GSD_GIT_ERROR,
            `Milestone worktree still has uncommitted changes after squash merge. Aborting teardown to preserve ${milestoneBranch}. Status:
${dirtyCheck}`
          );
        }
      } catch (e) {
        if (e instanceof GSDError) throw e;
        debugLog("mergeMilestoneToMain", {
          phase: "pre-teardown-dirty-check-error",
          error: String(e)
        });
      }
    }
  }
  try {
    removeWorktree(originalBasePath_, milestoneId, {
      branch: milestoneBranch,
      deleteBranch: false
    });
  } catch (err) {
    logWarning("worktree", `worktree removal failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    nativeBranchDelete(originalBasePath_, milestoneBranch);
  } catch (err) {
    logWarning("worktree", `git branch-delete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  setActiveWorkspace(null);
  nudgeGitBranchCache(previousCwd);
  try {
    process.chdir(originalBasePath_);
  } catch (err) {
    logWarning("worktree", `chdir to project root after merge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { commitMessage, pushed, prCreated, codeFilesChanged };
}
export {
  SAFE_AUTO_RESOLVE_PATTERNS,
  _gitPathspecForWorktreePath,
  _isBranchCheckedOutElsewhere,
  _isExpectedWorktreeUnlinkError,
  _isSamePath,
  _resetAutoWorktreeOriginalBaseForTests,
  _resolveAutoWorktreeStartPoint,
  _shouldReconcileWorktreeDb,
  autoWorktreeBranch,
  checkResourcesStale,
  cleanStaleRuntimeUnits,
  createAutoWorktree,
  enterAutoWorktree,
  enterBranchModeForMilestone,
  escapeStaleWorktree,
  fastForwardReusedMilestoneBranchIfSafe,
  getActiveAutoWorktreeContext,
  getAutoWorktreeOriginalBase,
  getAutoWorktreePath,
  isInAutoWorktree,
  isSafeToAutoResolve,
  mergeMilestoneToMain,
  readResourceVersion,
  runWorktreePostCreateHook,
  syncGsdStateToWorktree,
  syncGsdStateToWorktreeByScope,
  syncProjectRootToWorktree,
  syncStateToProjectRoot,
  syncWorktreeStateBack,
  teardownAutoWorktree
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXdvcmt0cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogQXV0by1tb2RlIHdvcmt0cmVlIGxpZmVjeWNsZSwgbWVyZ2UsIGFuZCBjbGVhbnVwIG1hbmFnZW1lbnQuXG5cbi8qKlxuICogR1NEIEF1dG8tV29ya3RyZWUgLS0gbGlmZWN5Y2xlIG1hbmFnZW1lbnQgZm9yIGF1dG8tbW9kZSB3b3JrdHJlZXMuXG4gKlxuICogQXV0by1tb2RlIGNyZWF0ZXMgd29ya3RyZWVzIHdpdGggYG1pbGVzdG9uZS88TUlEPmAgYnJhbmNoZXMgKGRpc3RpbmN0IGZyb21cbiAqIG1hbnVhbCBgL3dvcmt0cmVlYCB3aGljaCB1c2VzIGB3b3JrdHJlZS88bmFtZT5gIGJyYW5jaGVzKS4gVGhpcyBtb2R1bGVcbiAqIG1hbmFnZXMgY3JlYXRlLCBlbnRlciwgZGV0ZWN0LCBhbmQgdGVhcmRvd24gZm9yIGF1dG8tbW9kZSB3b3JrdHJlZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgY3BTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWxwYXRoU3luYyxcbiAgcm1TeW5jLFxuICB1bmxpbmtTeW5jLFxuICBsc3RhdFN5bmMgYXMgbHN0YXRTeW5jRm4sXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgc2VwIGFzIHBhdGhTZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBHU0RFcnJvciwgR1NEX0lPX0VSUk9SLCBHU0RfR0lUX0VSUk9SIH0gZnJvbSBcIi4vZXJyb3JzLmpzXCI7XG5pbXBvcnQge1xuICByZWNvbmNpbGVXb3JrdHJlZURiLFxuICBpc0RiQXZhaWxhYmxlLFxuICBnZXRNaWxlc3RvbmUsXG4gIGdldE1pbGVzdG9uZVNsaWNlcyxcbiAgZ2V0U2xpY2VUYXNrcyxcbiAgY2xvc2VEYXRhYmFzZSxcbiAgb3BlbkRhdGFiYXNlLFxuICBnZXREYlBhdGgsXG59IGZyb20gXCIuL2dzZC1kYi5qc1wiO1xuaW1wb3J0IHsgYXRvbWljV3JpdGVTeW5jIH0gZnJvbSBcIi4vYXRvbWljLXdyaXRlLmpzXCI7XG5pbXBvcnQgeyBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBnc2RSb290LCByZXNvbHZlR3NkUGF0aENvbnRyYWN0IH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7XG4gIGNyZWF0ZVdvcmt0cmVlLFxuICByZW1vdmVXb3JrdHJlZSxcbiAgcmVzb2x2ZUdpdERpcixcbiAgd29ya3RyZWVQYXRoLFxuICBpc0luc2lkZVdvcmt0cmVlc0Rpcixcbn0gZnJvbSBcIi4vd29ya3RyZWUtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHtcbiAgZGV0ZWN0V29ya3RyZWVOYW1lLFxuICByZXNvbHZlR2l0SGVhZFBhdGgsXG4gIG51ZGdlR2l0QnJhbmNoQ2FjaGUsXG59IGZyb20gXCIuL3dvcmt0cmVlLmpzXCI7XG5pbXBvcnQge1xuICBpc0dzZFdvcmt0cmVlUGF0aCxcbiAgbm9ybWFsaXplV29ya3RyZWVQYXRoRm9yQ29tcGFyZSxcbiAgcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QsXG59IGZyb20gXCIuL3dvcmt0cmVlLXJvb3QuanNcIjtcbmltcG9ydCB7IE1lcmdlQ29uZmxpY3RFcnJvciwgY3JlYXRlRHJhZnRQUiwgcmVhZEludGVncmF0aW9uQnJhbmNoLCBSVU5USU1FX0VYQ0xVU0lPTl9QQVRIUyB9IGZyb20gXCIuL2dpdC1zZXJ2aWNlLmpzXCI7XG5pbXBvcnQgeyBidWlsZFByRXZpZGVuY2UgfSBmcm9tIFwiLi9wci1ldmlkZW5jZS5qc1wiO1xuaW1wb3J0IHsgZGVidWdMb2cgfSBmcm9tIFwiLi9kZWJ1Zy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcsIGxvZ0Vycm9yIH0gZnJvbSBcIi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgTUlMRVNUT05FX0lEX1JFIH0gZnJvbSBcIi4vbWlsZXN0b25lLWlkcy5qc1wiO1xuaW1wb3J0IHtcbiAgbmF0aXZlR2V0Q3VycmVudEJyYW5jaCxcbiAgbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaCxcbiAgbmF0aXZlV29ya2luZ1RyZWVTdGF0dXMsXG4gIG5hdGl2ZUFkZEFsbFdpdGhFeGNsdXNpb25zLFxuICBuYXRpdmVDb21taXQsXG4gIG5hdGl2ZUNoZWNrb3V0QnJhbmNoLFxuICBuYXRpdmVNZXJnZVNxdWFzaCxcbiAgbmF0aXZlQ29uZmxpY3RGaWxlcyxcbiAgbmF0aXZlQ2hlY2tvdXRUaGVpcnMsXG4gIG5hdGl2ZUFkZFBhdGhzLFxuICBuYXRpdmVSbUZvcmNlLFxuICBuYXRpdmVCcmFuY2hEZWxldGUsXG4gIG5hdGl2ZUJyYW5jaEZvcmNlUmVzZXQsXG4gIG5hdGl2ZUJyYW5jaEV4aXN0cyxcbiAgbmF0aXZlRGlmZk51bXN0YXQsXG4gIG5hdGl2ZVVwZGF0ZVJlZixcbiAgbmF0aXZlSXNBbmNlc3RvcixcbiAgbmF0aXZlTWVyZ2VBYm9ydCxcbiAgbmF0aXZlV29ya3RyZWVMaXN0LFxufSBmcm9tIFwiLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc1wiO1xuaW1wb3J0IHsgZ3NkSG9tZSB9IGZyb20gXCIuL2dzZC1ob21lLmpzXCI7XG5pbXBvcnQgeyB0eXBlIE1pbGVzdG9uZVNjb3BlLCB0eXBlIEdzZFdvcmtzcGFjZSwgY3JlYXRlV29ya3NwYWNlIH0gZnJvbSBcIi4vd29ya3NwYWNlLmpzXCI7XG5pbXBvcnQge1xuICBfZmluYWxpemVQcm9qZWN0aW9uRm9yTWVyZ2VJbXBsLFxuICBfcHJvamVjdFJvb3RUb1dvcmt0cmVlSW1wbCxcbiAgX3Byb2plY3RXb3JrdHJlZVRvUm9vdEltcGwsXG59IGZyb20gXCIuL3dvcmt0cmVlLXN0YXRlLXByb2plY3Rpb24uanNcIjtcblxuY29uc3QgUFJPSkVDVF9QUkVGRVJFTkNFU19GSUxFID0gXCJQUkVGRVJFTkNFUy5tZFwiO1xuY29uc3QgTEVHQUNZX1BST0pFQ1RfUFJFRkVSRU5DRVNfRklMRSA9IFwicHJlZmVyZW5jZXMubWRcIjtcbmNvbnN0IExFR0FDWV9ERUVQX1NFVFVQX1JVTlRJTUVfVU5JVF9GSUxFUyA9IG5ldyBTZXQoW1xuICBcIndvcmtmbG93LXByZWZlcmVuY2VzLVdPUktGTE9XLVBSRUZTLmpzb25cIixcbiAgXCJkaXNjdXNzLXByb2plY3QtUFJPSkVDVC5qc29uXCIsXG4gIFwiZGlzY3Vzcy1yZXF1aXJlbWVudHMtUkVRVUlSRU1FTlRTLmpzb25cIixcbiAgXCJyZXNlYXJjaC1kZWNpc2lvbi1SRVNFQVJDSC1ERUNJU0lPTi5qc29uXCIsXG4gIFwicmVzZWFyY2gtcHJvamVjdC1SRVNFQVJDSC1QUk9KRUNULmpzb25cIixcbl0pO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU2hhcmVkIENvbnN0YW50cyAmIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUm9vdC1sZXZlbCAuZ3NkLyBwcm9qZWN0aW9ucyBjb3BpZWQgZnJvbSBwcm9qZWN0IHJvb3QgaW50byB3b3JrdHJlZXMgZm9yXG4gKiBjb21wYXRpYmlsaXR5LiBQcm9qZWN0IHJvb3QgcmVtYWlucyB0aGUgY2Fub25pY2FsIHN0YXRlL3Byb2plY3Rpb24gcm9vdC5cbiAqL1xuY29uc3QgUk9PVF9TVEFURV9GSUxFUyA9IFtcbiAgXCJERUNJU0lPTlMubWRcIixcbiAgXCJSRVFVSVJFTUVOVFMubWRcIixcbiAgXCJQUk9KRUNULm1kXCIsXG4gIFwiS05PV0xFREdFLm1kXCIsXG4gIFwiT1ZFUlJJREVTLm1kXCIsXG4gIFwiUVVFVUUubWRcIixcbiAgXCJjb21wbGV0ZWQtdW5pdHMuanNvblwiLFxuICBcIm1ldHJpY3MuanNvblwiLFxuICBcIm1jcC5qc29uXCIsXG4gIC8vIE5PVEU6IHByb2plY3QgcHJlZmVyZW5jZXMgYXJlIGludGVudGlvbmFsbHkgTk9UIGluIFJPT1RfU1RBVEVfRklMRVMuXG4gIC8vIEZvcndhcmQtc3luYyAobWFpbiBcdTIxOTIgd29ya3RyZWUpIGlzIGhhbmRsZWQgZXhwbGljaXRseSBpbiBzeW5jR3NkU3RhdGVUb1dvcmt0cmVlKCkuXG4gIC8vIEJhY2stc3luYyAod29ya3RyZWUgXHUyMTkyIG1haW4pIG11c3QgTkVWRVIgb3ZlcndyaXRlIHRoZSBwcm9qZWN0IHJvb3QncyBjb3B5XG4gIC8vIGJlY2F1c2UgdGhlIHByb2plY3Qgcm9vdCBpcyBhdXRob3JpdGF0aXZlIGZvciBwcmVmZXJlbmNlcyAoIzI2ODQpLlxuXSBhcyBjb25zdDtcblxuLyoqXG4gKiBQb3AgYSBzdGFzaCBlbnRyeSBieSB0cmFja2luZyB0aGUgdW5pcXVlIG1hcmtlciBlbWJlZGRlZCBpbiBpdHMgbWVzc2FnZSBzb1xuICogY29uY3VycmVudCBzdGFzaCBvcGVyYXRpb25zIGFnYWluc3QgdGhlIHNhbWUgcHJvamVjdCByb290IGNhbm5vdCBjYXVzZSB1cyB0b1xuICogcG9wIHRoZSB3cm9uZyBlbnRyeS5cbiAqXG4gKiBJZiBgc3Rhc2hNYXJrZXJgIGlzIG51bGwgb3Igbm8gbG9uZ2VyIHByZXNlbnQgaW4gdGhlIHN0YXNoIGxpc3QgKGUuZy4gYVxuICogY29uY3VycmVudCBwcm9jZXNzIHBvcHBlZC9kcm9wcGVkIGl0KSwgbGVhdmVzIHRoZSBzdGFzaCBsaXN0IHVudG91Y2hlZCBhbmRcbiAqIHJldHVybnMgbnVsbC5cbiAqXG4gKiBUaHJvd3Mgb24gcG9wIGZhaWx1cmUgc28gY2FsbGVycyBjYW4gaGFuZGxlIGNvbmZsaWN0IGNhc2VzIHRoZSBzYW1lIHdheVxuICogdGhleSB3b3VsZCB3aXRoIHRoZSBwcmlvciBgZ2l0IHN0YXNoIHBvcGAgZm9ybS4gV2hlbiB0aHJvd2luZyBhZnRlciBhXG4gKiB0YXJnZXRlZCBwb3AgYXR0ZW1wdCwgdGhlIGVycm9yIGlzIGFubm90YXRlZCB3aXRoIHRoZSB0YXJnZXRlZCBzdGFzaCByZWYuXG4gKlxuICogKElzc3VlICM0OTgwIEhJR0gtNilcbiAqL1xuZnVuY3Rpb24gcG9wU3Rhc2hCeVJlZihiYXNlUGF0aDogc3RyaW5nLCBzdGFzaE1hcmtlcjogc3RyaW5nIHwgbnVsbCk6IHN0cmluZyB8IG51bGwge1xuICBsZXQgcG9wQXJnOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgaWYgKHN0YXNoTWFya2VyKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGxpc3QgPSBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wic3Rhc2hcIiwgXCJsaXN0XCIsIFwiLS1mb3JtYXQ9JWdkJXgwMCVzXCJdLCB7XG4gICAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIH0pLnRyaW0oKS5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGxpc3QpIHtcbiAgICAgICAgY29uc3QgW3JlZiwgc3ViamVjdF0gPSBlbnRyeS5zcGxpdChcIlxcMFwiKTtcbiAgICAgICAgaWYgKHJlZiAmJiBzdWJqZWN0Py5pbmNsdWRlcyhzdGFzaE1hcmtlcikpIHtcbiAgICAgICAgICBwb3BBcmcgPSByZWY7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgc3Rhc2ggbGlzdCBsb29rdXAgZmFpbGVkOyBsZWF2aW5nIHN0YXNoIHVudG91Y2hlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgfVxuICB9XG4gIGlmICghcG9wQXJnKSB7XG4gICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIFwicmVjb3JkZWQgc3Rhc2ggZW50cnkgY291bGQgbm90IGJlIHJlc29sdmVkOyBza2lwcGluZyBhdXRvbWF0aWMgcG9wXCIpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHRyeSB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInN0YXNoXCIsIFwicG9wXCIsIHBvcEFyZ10sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoZXJyICYmIHR5cGVvZiBlcnIgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgIChlcnIgYXMgeyBzdGFzaFJlZj86IHN0cmluZyB9KS5zdGFzaFJlZiA9IHBvcEFyZztcbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIHJldHVybiBwb3BBcmc7XG59XG5cbmZ1bmN0aW9uIHN0YXNoUmVmRnJvbUVycm9yKGVycjogdW5rbm93bik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWVyciB8fCB0eXBlb2YgZXJyICE9PSBcIm9iamVjdFwiKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc3Rhc2hSZWYgPSAoZXJyIGFzIHsgc3Rhc2hSZWY/OiB1bmtub3duIH0pLnN0YXNoUmVmO1xuICByZXR1cm4gdHlwZW9mIHN0YXNoUmVmID09PSBcInN0cmluZ1wiICYmIHN0YXNoUmVmLmxlbmd0aCA+IDAgPyBzdGFzaFJlZiA6IG51bGw7XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgdHdvIGZpbGVzeXN0ZW0gcGF0aHMgcmVzb2x2ZSB0byB0aGUgc2FtZSByZWFsIGxvY2F0aW9uLlxuICogUmV0dXJucyBmYWxzZSBpZiBlaXRoZXIgcGF0aCBjYW5ub3QgYmUgcmVzb2x2ZWQgKGUuZy4gZG9lc24ndCBleGlzdCkuXG4gKi9cbmZ1bmN0aW9uIGlzU2FtZVBhdGgoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhbHBhdGhTeW5jKGEpID09PSByZWFscGF0aFN5bmMoYik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gZmFsc2U7XG4gICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBpc1NhbWVQYXRoIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9pc1NhbWVQYXRoKGE6IHN0cmluZywgYjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBpc1NhbWVQYXRoKGEsIGIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3Jlc29sdmVBdXRvV29ya3RyZWVTdGFydFBvaW50KFxuICBpbnRlZ3JhdGlvbkJyYW5jaDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbiAgZ2l0TWFpbkJyYW5jaDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbiAgYnJhbmNoRXhpc3RzOiAoYnJhbmNoOiBzdHJpbmcpID0+IGJvb2xlYW4sXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoaW50ZWdyYXRpb25CcmFuY2gpIHJldHVybiBpbnRlZ3JhdGlvbkJyYW5jaDtcbiAgcmV0dXJuIGdpdE1haW5CcmFuY2ggJiZcbiAgICB0eXBlb2YgZ2l0TWFpbkJyYW5jaCA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIGdpdE1haW5CcmFuY2gubGVuZ3RoID4gMCAmJlxuICAgIGJyYW5jaEV4aXN0cyhnaXRNYWluQnJhbmNoKVxuICAgID8gZ2l0TWFpbkJyYW5jaFxuICAgIDogdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3Nob3VsZFJlY29uY2lsZVdvcmt0cmVlRGIoXG4gIHdvcmt0cmVlRGJQYXRoOiBzdHJpbmcsXG4gIG1haW5EYlBhdGg6IHN0cmluZyxcbiAgcGF0aEV4aXN0czogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbiA9IGV4aXN0c1N5bmMsXG4gIHNhbWVQYXRoOiAoYTogc3RyaW5nLCBiOiBzdHJpbmcpID0+IGJvb2xlYW4gPSBpc1NhbWVQYXRoLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiBwYXRoRXhpc3RzKHdvcmt0cmVlRGJQYXRoKSAmJiAhc2FtZVBhdGgod29ya3RyZWVEYlBhdGgsIG1haW5EYlBhdGgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX2lzRXhwZWN0ZWRXb3JrdHJlZVVubGlua0Vycm9yKFxuICBjb2RlOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuIGNvZGUgPT09IFwiRU5PRU5UXCIgfHwgY29kZSA9PT0gXCJFSVNESVJcIjtcbn1cblxuZnVuY3Rpb24gc3RyaXBHc2REaXNwbGF5UHJlZml4KHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQgfCBudWxsLCBpZDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcmF3ID0gU3RyaW5nKHZhbHVlID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCFyYXcpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IGxvd2VyID0gcmF3LnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IGlkTG93ZXIgPSBpZC50b0xvd2VyQ2FzZSgpO1xuICBpZiAobG93ZXIuc3RhcnRzV2l0aChgJHtpZExvd2VyfTpgKSkgcmV0dXJuIHJhdy5zbGljZShpZC5sZW5ndGggKyAxKS50cmltKCkgfHwgdW5kZWZpbmVkO1xuICByZXR1cm4gcmF3O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTW9kdWxlIFN0YXRlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogQWN0aXZlIHdvcmtzcGFjZSByZWdpc3RyeSBcdTIwMTQgcmVwbGFjZXMgdGhlIGxlZ2FjeSBgb3JpZ2luYWxCYXNlYCBzaW5nbGV0b24uICovXG5sZXQgYWN0aXZlV29ya3NwYWNlOiBHc2RXb3Jrc3BhY2UgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gc2V0QWN0aXZlV29ya3NwYWNlKHdzOiBHc2RXb3Jrc3BhY2UgfCBudWxsKTogdm9pZCB7XG4gIGFjdGl2ZVdvcmtzcGFjZSA9IHdzO1xufVxuXG5mdW5jdGlvbiBnZXRBY3RpdmVXb3Jrc3BhY2UoKTogR3NkV29ya3NwYWNlIHwgbnVsbCB7XG4gIHJldHVybiBhY3RpdmVXb3Jrc3BhY2U7XG59XG5cbmZ1bmN0aW9uIGdpdFBhdGhzcGVjRm9yV29ya3RyZWVQYXRoKGJhc2VQYXRoOiBzdHJpbmcsIHRhcmdldFBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBsZXQgYmFzZSA9IGJhc2VQYXRoO1xuICBsZXQgdGFyZ2V0ID0gdGFyZ2V0UGF0aDtcbiAgdHJ5IHtcbiAgICBiYXNlID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBcIi0tc2hvdy10b3BsZXZlbFwiXSwge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICB9KS50cmltKCkgfHwgYmFzZVBhdGg7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGtlZXAgb3JpZ2luYWwgKi9cbiAgICB2b2lkIGJhc2U7XG4gIH1cbiAgdHJ5IHtcbiAgICBiYXNlID0gcmVhbHBhdGhTeW5jLm5hdGl2ZShiYXNlKTtcbiAgfSBjYXRjaCB7XG4gICAgLyoga2VlcCBvcmlnaW5hbCAqL1xuICAgIHZvaWQgYmFzZTtcbiAgfVxuICB0cnkge1xuICAgIHRhcmdldCA9IHJlYWxwYXRoU3luYy5uYXRpdmUodGFyZ2V0UGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGtlZXAgb3JpZ2luYWwgKi9cbiAgICB2b2lkIHRhcmdldDtcbiAgfVxuXG4gIGNvbnN0IHJlbCA9IHJlbGF0aXZlKGJhc2UsIHRhcmdldCk7XG4gIGlmIChyZWwgPT09IFwiXCIgfHwgcmVsLnN0YXJ0c1dpdGgoXCIuLlwiKSB8fCBpc0Fic29sdXRlKHJlbCkpIHJldHVybiBudWxsO1xuICByZXR1cm4gcmVsLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9naXRQYXRoc3BlY0Zvcldvcmt0cmVlUGF0aChiYXNlUGF0aDogc3RyaW5nLCB0YXJnZXRQYXRoOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGdpdFBhdGhzcGVjRm9yV29ya3RyZWVQYXRoKGJhc2VQYXRoLCB0YXJnZXRQYXRoKTtcbn1cblxuZnVuY3Rpb24gZ2l0UmVtb3RlRXhpc3RzKGJhc2VQYXRoOiBzdHJpbmcsIHJlbW90ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJlbW90ZVwiLCBcImdldC11cmxcIiwgcmVtb3RlXSwge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaW5kUmVndWxhck1lcmdlQ2hhbmdlZFBhdGhzKGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUJyYW5jaDogc3RyaW5nLCBtYWluQnJhbmNoOiBzdHJpbmcpOiBTZXQ8c3RyaW5nPiB7XG4gIGNvbnN0IGNoYW5nZWRQYXRocyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBsZXQgbWVyZ2VMb2cgPSBcIlwiO1xuICB0cnkge1xuICAgIG1lcmdlTG9nID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1saXN0XCIsIFwiLS1tZXJnZXNcIiwgXCItLXBhcmVudHNcIiwgbWFpbkJyYW5jaF0sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgIH0pLnRyaW0oKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGByZWd1bGFyIG1lcmdlIGxvb2t1cCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgIHJldHVybiBjaGFuZ2VkUGF0aHM7XG4gIH1cblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbWVyZ2VMb2cuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pKSB7XG4gICAgY29uc3QgW21lcmdlQ29tbWl0LCBmaXJzdFBhcmVudCwgLi4ub3RoZXJQYXJlbnRzXSA9IGxpbmUuc3BsaXQoXCIgXCIpO1xuICAgIGlmICghbWVyZ2VDb21taXQgfHwgIWZpcnN0UGFyZW50IHx8IG90aGVyUGFyZW50cy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgIGNvbnN0IG1lcmdlZE1pbGVzdG9uZSA9IG90aGVyUGFyZW50cy5zb21lKChwYXJlbnQpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJldHVybiBuYXRpdmVJc0FuY2VzdG9yKGJhc2VQYXRoLCBtaWxlc3RvbmVCcmFuY2gsIHBhcmVudCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGlmICghbWVyZ2VkTWlsZXN0b25lKSBjb250aW51ZTtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBvdXRwdXQgPSBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wiZGlmZlwiLCBcIi0tbmFtZS1vbmx5XCIsIGZpcnN0UGFyZW50LCBtZXJnZUNvbW1pdF0sIHtcbiAgICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgfSkudHJpbSgpO1xuICAgICAgZm9yIChjb25zdCBwYXRoIG9mIG91dHB1dC5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbikpIHtcbiAgICAgICAgaWYgKCFwYXRoLnN0YXJ0c1dpdGgoXCIuZ3NkL1wiKSkgY2hhbmdlZFBhdGhzLmFkZChwYXRoKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgcmVndWxhciBtZXJnZSBkaWZmIGxvb2t1cCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgIH1cbiAgICByZXR1cm4gY2hhbmdlZFBhdGhzO1xuICB9XG5cbiAgcmV0dXJuIGNoYW5nZWRQYXRocztcbn1cblxuZnVuY3Rpb24gY2xlYXJQcm9qZWN0Um9vdFN0YXRlRmlsZXMoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBnc2REaXIgPSBnc2RSb290KGJhc2VQYXRoKTtcbiAgLy8gUGhhc2UgQyBwdCAyOiBhdXRvLmxvY2sgcmVtb3ZlZCBmcm9tIHRoaXMgbGlzdCBcdTIwMTQgdGhlIGZpbGUgaXMgZ29uZVxuICAvLyAobWlncmF0ZWQgdG8gdGhlIHdvcmtlcnMgKyB1bml0X2Rpc3BhdGNoZXMgKyBydW50aW1lX2t2IHRhYmxlcykuIFRoZVxuICAvLyByZW1haW5pbmcgdHJhbnNpZW50IGZpbGVzIChTVEFURS5tZCwge01JRH0tTUVUQS5qc29uKSBhcmUgc3RpbGxcbiAgLy8gd29ydGggcmVtb3Zpbmcgb24gdGVhcmRvd24uXG4gIGNvbnN0IHRyYW5zaWVudEZpbGVzID0gW1xuICAgIGpvaW4oZ3NkRGlyLCBcIlNUQVRFLm1kXCIpLFxuICAgIGpvaW4oZ3NkRGlyLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQsIGAke21pbGVzdG9uZUlkfS1NRVRBLmpzb25gKSxcbiAgXTtcblxuICBmb3IgKGNvbnN0IGZpbGUgb2YgdHJhbnNpZW50RmlsZXMpIHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhmaWxlKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIC8vIEVOT0VOVCBpcyBleHBlY3RlZCBcdTIwMTQgZmlsZSBtYXkgbm90IGV4aXN0ICgjMzU5NylcbiAgICAgIGlmICgoZXJyIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZSAhPT0gXCJFTk9FTlRcIikge1xuICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYGZpbGUgdW5saW5rIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gQ2xlYW4gdXAgbGVnYWN5IHN5bmNlZCBtaWxlc3RvbmUgZGlyZWN0b3JpZXMgYW5kIHJ1bnRpbWUvdW5pdHMuXG4gIC8vIE9sZGVyIHZlcnNpb25zIGNvcGllZCB0aGVzZSBpbnRvIHRoZSBwcm9qZWN0IHJvb3QgZHVyaW5nIGV4ZWN1dGlvbi5cbiAgLy8gSWYgdGhleSByZW1haW4gYXMgdW50cmFja2VkIGZpbGVzIHdoZW4gd2UgYXR0ZW1wdFxuICAvLyBgZ2l0IG1lcmdlIC0tc3F1YXNoYCwgZ2l0IHJlamVjdHMgdGhlIG1lcmdlIHdpdGggXCJsb2NhbCBjaGFuZ2VzIHdvdWxkXG4gIC8vIGJlIG92ZXJ3cml0dGVuXCIsIGNhdXNpbmcgc2lsZW50IGRhdGEgbG9zcyAoIzE3MzgpLlxuICBjb25zdCBzeW5jZWREaXJzID0gW1xuICAgIGpvaW4oZ3NkRGlyLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQpLFxuICAgIGpvaW4oZ3NkRGlyLCBcInJ1bnRpbWVcIiwgXCJ1bml0c1wiKSxcbiAgXTtcblxuICBmb3IgKGNvbnN0IGRpciBvZiBzeW5jZWREaXJzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChleGlzdHNTeW5jKGRpcikpIHtcbiAgICAgICAgY29uc3QgcGF0aHNwZWMgPSBnaXRQYXRoc3BlY0Zvcldvcmt0cmVlUGF0aChiYXNlUGF0aCwgZGlyKTtcbiAgICAgICAgaWYgKCFwYXRoc3BlYykgY29udGludWU7XG5cbiAgICAgICAgLy8gT25seSByZW1vdmUgZmlsZXMgdGhhdCBhcmUgdW50cmFja2VkIGJ5IGdpdCBcdTIwMTQgdHJhY2tlZCBmaWxlcyBhcmVcbiAgICAgICAgLy8gbWFuYWdlZCBieSB0aGUgYnJhbmNoIGNoZWNrb3V0IGFuZCBzaG91bGQgbm90IGJlIGRlbGV0ZWQuXG4gICAgICAgIGNvbnN0IHVudHJhY2tlZE91dHB1dCA9IGV4ZWNGaWxlU3luYyhcbiAgICAgICAgICBcImdpdFwiLFxuICAgICAgICAgIFtcImxzLWZpbGVzXCIsIFwiLS1vdGhlcnNcIiwgXCItLWV4Y2x1ZGUtc3RhbmRhcmRcIiwgcGF0aHNwZWNdLFxuICAgICAgICAgIHsgY3dkOiBiYXNlUGF0aCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0sXG4gICAgICAgICkudHJpbSgpO1xuICAgICAgICBpZiAodW50cmFja2VkT3V0cHV0KSB7XG4gICAgICAgICAgZm9yIChjb25zdCBmIG9mIHVudHJhY2tlZE91dHB1dC5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbikpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHVubGlua1N5bmMoam9pbihiYXNlUGF0aCwgZikpO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICAgIC8vIEVOT0VOVC9FSVNESVIgYXJlIGV4cGVjdGVkIGZvciBhbHJlYWR5LXJlbW92ZWQgb3IgZGlyZWN0b3J5IGVudHJpZXMgKCMzNTk3KVxuICAgICAgICAgICAgICBjb25zdCBjb2RlID0gKGVyciBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgICAgICAgICAgIGlmICghX2lzRXhwZWN0ZWRXb3JrdHJlZVVubGlua0Vycm9yKGNvZGUpKSB7XG4gICAgICAgICAgICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGB1bnRyYWNrZWQgZmlsZSB1bmxpbmsgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgLyogbm9uLWZhdGFsIFx1MjAxNCBnaXQgY29tbWFuZCBtYXkgZmFpbCBpZiBub3QgaW4gcmVwbyAqL1xuICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGB1bnRyYWNrZWQgZmlsZSBjbGVhbnVwIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgfVxuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBCdWlsZCBBcnRpZmFjdCBBdXRvLVJlc29sdmUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBQYXR0ZXJucyBmb3IgbWFjaGluZS1nZW5lcmF0ZWQgYnVpbGQgYXJ0aWZhY3RzIHRoYXQgY2FuIGJlIHNhZmVseVxuICogYXV0by1yZXNvbHZlZCBieSBhY2NlcHRpbmcgLS10aGVpcnMgZHVyaW5nIG1lcmdlLiBUaGVzZSBmaWxlcyBhcmVcbiAqIHJlZ2VuZXJhYmxlIGFuZCBuZXZlciBjb250YWluIG1lYW5pbmdmdWwgbWFudWFsIGVkaXRzLiAqL1xuZXhwb3J0IGNvbnN0IFNBRkVfQVVUT19SRVNPTFZFX1BBVFRFUk5TOiBSZWdFeHBbXSA9IFtcbiAgL1xcLnRzYnVpbGRpbmZvJC8sXG4gIC9cXC5weWMkLyxcbiAgL1xcL19fcHljYWNoZV9fXFwvLyxcbiAgL1xcLkRTX1N0b3JlJC8sXG4gIC9cXC5tYXAkLyxcbl07XG5cbi8qKiBSZXR1cm5zIHRydWUgaWYgdGhlIGZpbGUgcGF0aCBpcyBzYWZlIHRvIGF1dG8tcmVzb2x2ZSBkdXJpbmcgbWVyZ2UuXG4gKiBDb3ZlcnMgYC5nc2QvYCBzdGF0ZSBmaWxlcyBhbmQgY29tbW9uIGJ1aWxkIGFydGlmYWN0cy4gKi9cbmV4cG9ydCBjb25zdCBpc1NhZmVUb0F1dG9SZXNvbHZlID0gKGZpbGVQYXRoOiBzdHJpbmcpOiBib29sZWFuID0+XG4gIGZpbGVQYXRoLnN0YXJ0c1dpdGgoXCIuZ3NkL1wiKSB8fFxuICBTQUZFX0FVVE9fUkVTT0xWRV9QQVRURVJOUy5zb21lKChyZSkgPT4gcmUudGVzdChmaWxlUGF0aCkpO1xuXG5mdW5jdGlvbiByZW1vdmVNZXJnZVN0YXRlRmlsZXMoYmFzZVBhdGg6IHN0cmluZywgY29udGV4dExhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBnaXREaXJfID0gcmVzb2x2ZUdpdERpcihiYXNlUGF0aCk7XG4gICAgZm9yIChjb25zdCBmIG9mIFtcIlNRVUFTSF9NU0dcIiwgXCJNRVJHRV9NU0dcIiwgXCJNRVJHRV9IRUFEXCJdKSB7XG4gICAgICBjb25zdCBwID0gam9pbihnaXREaXJfLCBmKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKHApKSB1bmxpbmtTeW5jKHApO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgbG9nRXJyb3IoXCJ3b3JrdHJlZVwiLCBgJHtjb250ZXh0TGFiZWx9IG1lcmdlIHN0YXRlIGNsZWFudXAgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjbGVhbnVwU3F1YXNoQ29uZmxpY3RTdGF0ZShiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIC8vIGBnaXQgbWVyZ2UgLS1zcXVhc2hgIGNvbmZsaWN0cyBjYW4gbGVhdmUgdW5tZXJnZWQgaW5kZXggZW50cmllcyB3aXRob3V0XG4gIC8vIE1FUkdFX0hFQUQsIHNvIG1lcmdlLWFib3J0IGFsb25lIGlzIG5vdCBlbm91Z2guIFJlc2V0IHRoZSBtZXJnZSBpbmRleCwgdGhlblxuICAvLyByZW1vdmUgbWVyZ2UgbWVzc2FnZSBmaWxlcyB0aGF0IG5hdGl2ZS9saWJnaXQyIHBhdGhzIG1heSBoYXZlIGNyZWF0ZWQuXG4gIHRyeSB7XG4gICAgbmF0aXZlTWVyZ2VBYm9ydChiYXNlUGF0aCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIEV4cGVjdGVkIGZvciBzcXVhc2ggY29uZmxpY3RzIHdoZW4gTUVSR0VfSEVBRCB3YXMgbmV2ZXIgd3JpdHRlbi5cbiAgICBkZWJ1Z0xvZyhcInNxdWFzaC1jb25mbGljdC1jbGVhbnVwOm1lcmdlLWFib3J0LXNraXBwZWRcIiwge1xuICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICB9KTtcbiAgfVxuICB0cnkge1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJyZXNldFwiLCBcIi0tbWVyZ2VcIl0sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgIH0pO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dFcnJvcihcIndvcmt0cmVlXCIsIGBnaXQgcmVzZXQgLS1tZXJnZSBmYWlsZWQgYWZ0ZXIgc3F1YXNoIGNvbmZsaWN0OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuICByZW1vdmVNZXJnZVN0YXRlRmlsZXMoYmFzZVBhdGgsIFwic3F1YXNoIGNvbmZsaWN0XCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRGlzcGF0Y2gtTGV2ZWwgU3luYyAocHJvamVjdCByb290IFx1MjE5NCB3b3JrdHJlZSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogU3luYyBtaWxlc3RvbmUgYXJ0aWZhY3RzIGZyb20gcHJvamVjdCByb290IElOVE8gd29ya3RyZWUgYmVmb3JlIGRlcml2ZVN0YXRlLlxuICogQ292ZXJzIHRoZSBjYXNlIHdoZXJlIHRoZSBMTE0gd3JvdGUgYXJ0aWZhY3RzIHRvIHRoZSBtYWluIHJlcG8gZmlsZXN5c3RlbVxuICogKGUuZy4gdmlhIGFic29sdXRlIHBhdGhzKSBidXQgdGhlIHdvcmt0cmVlIGhhcyBzdGFsZSBkYXRhLiBBbHNvIGRlbGV0ZXNcbiAqIGdzZC5kYiBpbiB0aGUgd29ya3RyZWUgc28gaXQgcmVidWlsZHMgZnJvbSBmcmVzaCBkaXNrIHN0YXRlICgjODUzKS5cbiAqIE5vbi1mYXRhbCBcdTIwMTQgc3luYyBmYWlsdXJlIHNob3VsZCBuZXZlciBibG9jayBkaXNwYXRjaC5cbiAqL1xuLyoqXG4gKiBQYXRoLXN0cmluZyBlbnRyeSBwb2ludCB0byBXb3JrdHJlZVN0YXRlUHJvamVjdGlvbi5wcm9qZWN0Um9vdFRvV29ya3RyZWUuXG4gKiBQcm9kdWN0aW9uIGNvZGUgZ29lcyB0aHJvdWdoIHRoZSBNb2R1bGUgY2xhc3M7IHRoaXMgZGVsZWdhdG9yIHN1cnZpdmVzIHNvXG4gKiB0aGUgcHJvamVjdGlvbi1pbnZhcmlhbnQgdGVzdHMgKCMxODg2LCAjMjE4NCwgIzI0NzgsICMyODIxKSBjYW4gZXhlcmNpc2VcbiAqIHRoZSBib2RpZXMgd2l0aCByYXcgcGF0aHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jUHJvamVjdFJvb3RUb1dvcmt0cmVlKFxuICBwcm9qZWN0Um9vdDogc3RyaW5nLFxuICB3b3JrdHJlZVBhdGhfOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcgfCBudWxsLFxuKTogdm9pZCB7XG4gIF9wcm9qZWN0Um9vdFRvV29ya3RyZWVJbXBsKHByb2plY3RSb290LCB3b3JrdHJlZVBhdGhfLCBtaWxlc3RvbmVJZCk7XG59XG5cbi8qKlxuICogUGF0aC1zdHJpbmcgZW50cnkgcG9pbnQgdG8gV29ya3RyZWVTdGF0ZVByb2plY3Rpb24ucHJvamVjdFdvcmt0cmVlVG9Sb290LlxuICogUHJvZHVjdGlvbiBjb2RlIGdvZXMgdGhyb3VnaCB0aGUgTW9kdWxlIGNsYXNzOyB0aGlzIGRlbGVnYXRvciBzdXJ2aXZlcyBzb1xuICogdGhlIHByb2plY3Rpb24taW52YXJpYW50IHRlc3RzIGNhbiBleGVyY2lzZSB0aGUgYm9keSB3aXRoIHJhdyBwYXRocy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdGF0ZVRvUHJvamVjdFJvb3QoXG4gIHdvcmt0cmVlUGF0aF86IHN0cmluZyxcbiAgcHJvamVjdFJvb3Q6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyB8IG51bGwsXG4pOiB2b2lkIHtcbiAgX3Byb2plY3RXb3JrdHJlZVRvUm9vdEltcGwod29ya3RyZWVQYXRoXywgcHJvamVjdFJvb3QsIG1pbGVzdG9uZUlkKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlc291cmNlIFN0YWxlbmVzcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZWFkIHRoZSByZXNvdXJjZSB2ZXJzaW9uIChzZW12ZXIpIGZyb20gdGhlIG1hbmFnZWQtcmVzb3VyY2VzIG1hbmlmZXN0LlxuICogVXNlcyBnc2RWZXJzaW9uIGluc3RlYWQgb2Ygc3luY2VkQXQgc28gdGhhdCBsYXVuY2hpbmcgYSBzZWNvbmQgc2Vzc2lvblxuICogZG9lc24ndCBmYWxzZWx5IHRyaWdnZXIgc3RhbGVuZXNzICgjODA0KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRSZXNvdXJjZVZlcnNpb24oKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGFnZW50RGlyID1cbiAgICBwcm9jZXNzLmVudi5HU0RfQ09ESU5HX0FHRU5UX0RJUiB8fCBqb2luKGdzZEhvbWUoKSwgXCJhZ2VudFwiKTtcbiAgY29uc3QgbWFuaWZlc3RQYXRoID0gam9pbihhZ2VudERpciwgXCJtYW5hZ2VkLXJlc291cmNlcy5qc29uXCIpO1xuICB0cnkge1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobWFuaWZlc3RQYXRoLCBcInV0Zi04XCIpKTtcbiAgICByZXR1cm4gdHlwZW9mIG1hbmlmZXN0Py5nc2RWZXJzaW9uID09PSBcInN0cmluZ1wiXG4gICAgICA/IG1hbmlmZXN0LmdzZFZlcnNpb25cbiAgICAgIDogbnVsbDtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgcmVhZFJlc291cmNlVmVyc2lvbiBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVjayBpZiBtYW5hZ2VkIHJlc291cmNlcyBoYXZlIGJlZW4gdXBkYXRlZCBzaW5jZSBzZXNzaW9uIHN0YXJ0LlxuICogUmV0dXJucyBhIHdhcm5pbmcgbWVzc2FnZSBpZiBzdGFsZSwgbnVsbCBvdGhlcndpc2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja1Jlc291cmNlc1N0YWxlKFxuICB2ZXJzaW9uT25TdGFydDogc3RyaW5nIHwgbnVsbCxcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAodmVyc2lvbk9uU3RhcnQgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBjb25zdCBjdXJyZW50ID0gcmVhZFJlc291cmNlVmVyc2lvbigpO1xuICBpZiAoY3VycmVudCA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGlmIChjdXJyZW50ICE9PSB2ZXJzaW9uT25TdGFydCkge1xuICAgIHJldHVybiBcIkdTRCByZXNvdXJjZXMgd2VyZSB1cGRhdGVkIHNpbmNlIHRoaXMgc2Vzc2lvbiBzdGFydGVkLiBSZXN0YXJ0IGdzZCB0byBsb2FkIHRoZSBuZXcgY29kZS5cIjtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFN0YWxlIFdvcmt0cmVlIEVzY2FwZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBEZXRlY3QgYW5kIGVzY2FwZSBhIHN0YWxlIHdvcmt0cmVlIGN3ZCAoIzYwOCkuXG4gKlxuICogQWZ0ZXIgbWlsZXN0b25lIGNvbXBsZXRpb24gKyBtZXJnZSwgdGhlIHdvcmt0cmVlIGRpcmVjdG9yeSBpcyByZW1vdmVkIGJ1dFxuICogdGhlIHByb2Nlc3MgY3dkIG1heSBzdGlsbCBwb2ludCBpbnNpZGUgYC5nc2Qvd29ya3RyZWVzLzxNSUQ+L2AuXG4gKiBXaGVuIGEgbmV3IHNlc3Npb24gc3RhcnRzLCBgcHJvY2Vzcy5jd2QoKWAgaXMgcGFzc2VkIGFzIGBiYXNlYCB0byBzdGFydEF1dG9cbiAqIGFuZCBhbGwgc3Vic2VxdWVudCB3cml0ZXMgbGFuZCBpbiB0aGUgd3JvbmcgZGlyZWN0b3J5LiBUaGlzIGZ1bmN0aW9uIGRldGVjdHNcbiAqIHRoYXQgc2NlbmFyaW8gYW5kIGNoZGlyIGJhY2sgdG8gdGhlIHByb2plY3Qgcm9vdC5cbiAqXG4gKiBSZXR1cm5zIHRoZSBjb3JyZWN0ZWQgYmFzZSBwYXRoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXNjYXBlU3RhbGVXb3JrdHJlZShiYXNlOiBzdHJpbmcpOiBzdHJpbmcge1xuICAvLyBEaXJlY3QgbGF5b3V0OiAvLmdzZC93b3JrdHJlZXMvXG4gIGNvbnN0IGRpcmVjdE1hcmtlciA9IGAke3BhdGhTZXB9LmdzZCR7cGF0aFNlcH13b3JrdHJlZXMke3BhdGhTZXB9YDtcbiAgbGV0IGlkeCA9IGJhc2UuaW5kZXhPZihkaXJlY3RNYXJrZXIpO1xuICBpZiAoaWR4ID09PSAtMSkge1xuICAgIC8vIFN5bWxpbmstcmVzb2x2ZWQgbGF5b3V0OiAvLmdzZC9wcm9qZWN0cy88aGFzaD4vd29ya3RyZWVzL1xuICAgIGNvbnN0IHN5bWxpbmtSZSA9IG5ldyBSZWdFeHAoXG4gICAgICBgXFxcXCR7cGF0aFNlcH1cXFxcLmdzZFxcXFwke3BhdGhTZXB9cHJvamVjdHNcXFxcJHtwYXRoU2VwfVthLWYwLTldK1xcXFwke3BhdGhTZXB9d29ya3RyZWVzXFxcXCR7cGF0aFNlcH1gLFxuICAgICk7XG4gICAgY29uc3QgbWF0Y2ggPSBiYXNlLm1hdGNoKHN5bWxpbmtSZSk7XG4gICAgaWYgKCFtYXRjaCB8fCBtYXRjaC5pbmRleCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gYmFzZTtcbiAgICBpZHggPSBtYXRjaC5pbmRleDtcbiAgfVxuXG4gIC8vIGJhc2UgaXMgaW5zaWRlIC5nc2Qvd29ya3RyZWVzLzxzb21ldGhpbmc+IFx1MjAxNCBleHRyYWN0IHRoZSBwcm9qZWN0IHJvb3RcbiAgY29uc3QgcHJvamVjdFJvb3QgPSBiYXNlLnNsaWNlKDAsIGlkeCk7XG5cbiAgLy8gR3VhcmQ6IElmIHRoZSBjYW5kaWRhdGUgcHJvamVjdCByb290J3MgLmdzZCBJUyB0aGUgdXNlci1sZXZlbCB+Ly5nc2QsXG4gIC8vIHRoZSBzdHJpbmctc2xpY2UgaGV1cmlzdGljIG1hdGNoZWQgdGhlIHdyb25nIC8uZ3NkLyBib3VuZGFyeS4gVGhpcyBoYXBwZW5zXG4gIC8vIHdoZW4gLmdzZCBpcyBhIHN5bWxpbmsgaW50byB+Ly5nc2QvcHJvamVjdHMvPGhhc2g+IGFuZCBwcm9jZXNzLmN3ZCgpXG4gIC8vIHJlc29sdmVkIHRocm91Z2ggdGhlIHN5bWxpbmsuIFJldHVybmluZyB+IHdvdWxkIGJlIGNhdGFzdHJvcGhpYyAoIzE2NzYpLlxuICBjb25zdCBjYW5kaWRhdGVHc2QgPSBub3JtYWxpemVXb3JrdHJlZVBhdGhGb3JDb21wYXJlKGpvaW4ocHJvamVjdFJvb3QsIFwiLmdzZFwiKSk7XG4gIGNvbnN0IGdzZEhvbWVOb3JtID0gbm9ybWFsaXplV29ya3RyZWVQYXRoRm9yQ29tcGFyZShnc2RIb21lKCkpO1xuICBpZiAoY2FuZGlkYXRlR3NkID09PSBnc2RIb21lTm9ybSB8fCBjYW5kaWRhdGVHc2Quc3RhcnRzV2l0aChnc2RIb21lTm9ybSArIFwiL1wiKSkge1xuICAgIC8vIERvbid0IGNoZGlyIHRvIGhvbWUgXHUyMDE0IHJldHVybiBiYXNlIHVuY2hhbmdlZC5cbiAgICAvLyByZXNvbHZlUHJvamVjdFJvb3QoKSBpbiB3b3JrdHJlZS50cyBoYXMgdGhlIGZ1bGwgZ2l0LWZpbGUtYmFzZWQgcmVjb3ZlcnlcbiAgICAvLyBhbmQgd2lsbCBiZSBjYWxsZWQgYnkgdGhlIGNhbGxlciAoc3RhcnRBdXRvIFx1MjE5MiBwcm9qZWN0Um9vdCgpKS5cbiAgICByZXR1cm4gYmFzZTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5jaGRpcihwcm9qZWN0Um9vdCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICAvLyBJZiBjaGRpciBmYWlscywgcmV0dXJuIHRoZSBvcmlnaW5hbCBcdTIwMTQgY2FsbGVyIHdpbGwgaGFuZGxlIGVycm9ycyBkb3duc3RyZWFtXG4gICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBlc2NhcGVTdGFsZVdvcmt0cmVlIGNoZGlyIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4gYmFzZTtcbiAgfVxuICByZXR1cm4gcHJvamVjdFJvb3Q7XG59XG5cbi8qKlxuICogQ2xlYW4gc3RhbGUgcnVudGltZSB1bml0IGZpbGVzIGZvciBjb21wbGV0ZWQgbWlsZXN0b25lcy5cbiAqXG4gKiBBZnRlciByZXN0YXJ0LCBzdGFsZSBydW50aW1lL3VuaXRzLyouanNvbiBmcm9tIHByaW9yIG1pbGVzdG9uZXMgY2FuXG4gKiBjYXVzZSBkZXJpdmVTdGF0ZSB0byByZXN1bWUgdGhlIHdyb25nIG1pbGVzdG9uZSAoIzg4NykuIFJlbW92ZXMgZmlsZXNcbiAqIGZvciBtaWxlc3RvbmVzIHRoYXQgaGF2ZSBhIFNVTU1BUlkgKGZ1bGx5IGNvbXBsZXRlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsZWFuU3RhbGVSdW50aW1lVW5pdHMoXG4gIGdzZFJvb3RQYXRoOiBzdHJpbmcsXG4gIGhhc01pbGVzdG9uZVN1bW1hcnk6IChtaWQ6IHN0cmluZykgPT4gYm9vbGVhbixcbik6IG51bWJlciB7XG4gIGNvbnN0IHJ1bnRpbWVVbml0c0RpciA9IGpvaW4oZ3NkUm9vdFBhdGgsIFwicnVudGltZVwiLCBcInVuaXRzXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMocnVudGltZVVuaXRzRGlyKSkgcmV0dXJuIDA7XG5cbiAgbGV0IGNsZWFuZWQgPSAwO1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgZmlsZSBvZiByZWFkZGlyU3luYyhydW50aW1lVW5pdHNEaXIpKSB7XG4gICAgICBpZiAoIWZpbGUuZW5kc1dpdGgoXCIuanNvblwiKSkgY29udGludWU7XG4gICAgICBpZiAoTEVHQUNZX0RFRVBfU0VUVVBfUlVOVElNRV9VTklUX0ZJTEVTLmhhcyhmaWxlKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHVubGlua1N5bmMoam9pbihydW50aW1lVW5pdHNEaXIsIGZpbGUpKTtcbiAgICAgICAgICBjbGVhbmVkKys7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIC8qIG5vbi1mYXRhbCAqL1xuICAgICAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgc3RhbGUgcnVudGltZSB1bml0IHVubGluayBmYWlsZWQgKCR7ZmlsZX0pOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHN0YWxlRGlzY3Vzc01hdGNoID0gZmlsZS5tYXRjaCgvXmRpc2N1c3MtbWlsZXN0b25lLSguKylcXC5qc29uJC8pO1xuICAgICAgaWYgKHN0YWxlRGlzY3Vzc01hdGNoICYmICFNSUxFU1RPTkVfSURfUkUudGVzdChzdGFsZURpc2N1c3NNYXRjaFsxXSkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB1bmxpbmtTeW5jKGpvaW4ocnVudGltZVVuaXRzRGlyLCBmaWxlKSk7XG4gICAgICAgICAgY2xlYW5lZCsrO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAvKiBub24tZmF0YWwgKi9cbiAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYHN0YWxlIHJ1bnRpbWUgdW5pdCB1bmxpbmsgZmFpbGVkICgke2ZpbGV9KTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICAgIH1cbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBtaWRNYXRjaCA9IGZpbGUubWF0Y2goLyhNXFxkKyg/Oi1bYS16MC05XXs2fSk/KS8pO1xuICAgICAgaWYgKCFtaWRNYXRjaCkgY29udGludWU7XG4gICAgICBpZiAoaGFzTWlsZXN0b25lU3VtbWFyeShtaWRNYXRjaFsxXSkpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB1bmxpbmtTeW5jKGpvaW4ocnVudGltZVVuaXRzRGlyLCBmaWxlKSk7XG4gICAgICAgICAgY2xlYW5lZCsrO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAvKiBub24tZmF0YWwgKi9cbiAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYHN0YWxlIHJ1bnRpbWUgdW5pdCB1bmxpbmsgZmFpbGVkICgke2ZpbGV9KTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8qIG5vbi1mYXRhbCAqL1xuICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgc3RhbGUgcnVudGltZSB1bml0IGNsZWFudXAgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgfVxuICByZXR1cm4gY2xlYW5lZDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFdvcmt0cmVlIFx1MjE5NCBNYWluIFJlcG8gU3luYyAoIzEzMTEpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFNjb3BlLXR5cGVkIHZhcmlhbnQgb2Ygc3luY0dzZFN0YXRlVG9Xb3JrdHJlZS5cbiAqXG4gKiBUYWtlcyBhbiBleHBsaWNpdCAocm9vdFNjb3BlLCB3b3JrdHJlZVNjb3BlKSBwYWlyLiBOb3RlOiBtaWxlc3RvbmVJZCBpcyBub3RcbiAqIHVzZWQgYnkgc3luY0dzZFN0YXRlVG9Xb3JrdHJlZSBcdTIwMTQgdGhpcyB2YXJpYW50IG9ubHkgcmVxdWlyZXMgd29ya3NwYWNlXG4gKiBpZGVudGl0eS4gQXNzZXJ0cyBib3RoIHNjb3BlcyBiZWxvbmcgdG8gdGhlIHNhbWUgd29ya3NwYWNlIGlkZW50aXR5IHRvXG4gKiBwcmV2ZW50IHNpbGVudCBtaXNtYXRjaCBidWdzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3luY0dzZFN0YXRlVG9Xb3JrdHJlZUJ5U2NvcGUoXG4gIHJvb3RTY29wZTogTWlsZXN0b25lU2NvcGUsXG4gIHdvcmt0cmVlU2NvcGU6IE1pbGVzdG9uZVNjb3BlLFxuKTogeyBzeW5jZWQ6IHN0cmluZ1tdIH0ge1xuICBpZiAocm9vdFNjb3BlLndvcmtzcGFjZS5pZGVudGl0eUtleSAhPT0gd29ya3RyZWVTY29wZS53b3Jrc3BhY2UuaWRlbnRpdHlLZXkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgc3luY0dzZFN0YXRlVG9Xb3JrdHJlZUJ5U2NvcGU6IHNjb3BlIGlkZW50aXR5IG1pc21hdGNoIFx1MjAxNCBgICtcbiAgICAgIGByb290U2NvcGUuaWRlbnRpdHlLZXk9XCIke3Jvb3RTY29wZS53b3Jrc3BhY2UuaWRlbnRpdHlLZXl9XCIgYCArXG4gICAgICBgd29ya3RyZWVTY29wZS5pZGVudGl0eUtleT1cIiR7d29ya3RyZWVTY29wZS53b3Jrc3BhY2UuaWRlbnRpdHlLZXl9XCJgLFxuICAgICk7XG4gIH1cbiAgY29uc3QgbWFpbkJhc2VQYXRoID0gcm9vdFNjb3BlLndvcmtzcGFjZS5wcm9qZWN0Um9vdDtcbiAgY29uc3Qgd29ya3RyZWVQYXRoXyA9IHdvcmt0cmVlU2NvcGUud29ya3NwYWNlLndvcmt0cmVlUm9vdCA/PyB3b3JrdHJlZVNjb3BlLndvcmtzcGFjZS5wcm9qZWN0Um9vdDtcbiAgcmV0dXJuIHN5bmNHc2RTdGF0ZVRvV29ya3RyZWUobWFpbkJhc2VQYXRoLCB3b3JrdHJlZVBhdGhfKTtcbn1cblxuLyoqXG4gKiBTeW5jIC5nc2QvIHN0YXRlIGZyb20gdGhlIG1haW4gcmVwbyBpbnRvIHRoZSB3b3JrdHJlZS5cbiAqXG4gKiBXaGVuIC5nc2QvIGlzIGEgc3ltbGluayB0byB0aGUgZXh0ZXJuYWwgc3RhdGUgZGlyZWN0b3J5LCBib3RoIHRoZSBtYWluXG4gKiByZXBvIGFuZCB3b3JrdHJlZSBzaGFyZSB0aGUgc2FtZSBkaXJlY3RvcnkgXHUyMDE0IG5vIHN5bmMgbmVlZGVkLlxuICpcbiAqIFdoZW4gLmdzZC8gaXMgYSByZWFsIGRpcmVjdG9yeSAoZS5nLiwgZ2l0LXRyYWNrZWQgb3IgbWFuYWdlX2dpdGlnbm9yZTpmYWxzZSksXG4gKiB0aGUgd29ya3RyZWUgaGFzIGl0cyBvd24gY29weSB0aGF0IG1heSBiZSBzdGFsZS4gVGhpcyBmdW5jdGlvbiBjb3BpZXNcbiAqIG1pc3NpbmcgbWlsZXN0b25lcywgQ09OVEVYVCwgUk9BRE1BUCwgREVDSVNJT05TLCBSRVFVSVJFTUVOVFMsIGFuZFxuICogUFJPSkVDVCBmaWxlcyBmcm9tIHRoZSBtYWluIHJlcG8ncyAuZ3NkLyBpbnRvIHRoZSB3b3JrdHJlZSdzIC5nc2QvLlxuICpcbiAqIE9ubHkgYWRkcyBtaXNzaW5nIGNvbnRlbnQgXHUyMDE0IG5ldmVyIG92ZXJ3cml0ZXMgZXhpc3RpbmcgZmlsZXMgaW4gdGhlIHdvcmt0cmVlLlxuICogV29ya3RyZWUgZmlsZXMgYXJlIGNvbXBhdGliaWxpdHkgcHJvamVjdGlvbnM7IERCL3Byb2plY3Qgcm9vdCByZW1haW5zXG4gKiBhdXRob3JpdGF0aXZlIGZvciBydW50aW1lIHN0YXRlLlxuICogQGRlcHJlY2F0ZWQgVXNlIHN5bmNHc2RTdGF0ZVRvV29ya3RyZWVCeVNjb3BlIGluc3RlYWQuXG4gKiBUT0RPKEMtZnV0dXJlKTogcmVtb3ZlIG9uY2UgYWxsIGNhbGxlcnMgbWlncmF0ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jR3NkU3RhdGVUb1dvcmt0cmVlKFxuICBtYWluQmFzZVBhdGg6IHN0cmluZyxcbiAgd29ya3RyZWVQYXRoXzogc3RyaW5nLFxuKTogeyBzeW5jZWQ6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb250cmFjdCA9IHJlc29sdmVHc2RQYXRoQ29udHJhY3Qod29ya3RyZWVQYXRoXywgbWFpbkJhc2VQYXRoKTtcbiAgY29uc3QgbWFpbkdzZCA9IGNvbnRyYWN0LnByb2plY3RHc2Q7XG4gIGNvbnN0IHd0R3NkID0gY29udHJhY3Qud29ya3RyZWVHc2QgPz8gam9pbih3b3JrdHJlZVBhdGhfLCBcIi5nc2RcIik7XG4gIGNvbnN0IHN5bmNlZDogc3RyaW5nW10gPSBbXTtcblxuICAvLyBJZiBib3RoIHJlc29sdmUgdG8gdGhlIHNhbWUgZGlyZWN0b3J5IChzeW1saW5rKSwgbm8gc3luYyBuZWVkZWRcbiAgaWYgKGlzU2FtZVBhdGgobWFpbkdzZCwgd3RHc2QpKSByZXR1cm4geyBzeW5jZWQgfTtcblxuICBpZiAoIWV4aXN0c1N5bmMobWFpbkdzZCkgfHwgIWV4aXN0c1N5bmMod3RHc2QpKSByZXR1cm4geyBzeW5jZWQgfTtcblxuICAvLyBTeW5jIHJvb3QtbGV2ZWwgLmdzZC8gZmlsZXMgKERFQ0lTSU9OUywgUkVRVUlSRU1FTlRTLCBQUk9KRUNULCBLTk9XTEVER0UsIGV0Yy4pXG4gIGZvciAoY29uc3QgZiBvZiBST09UX1NUQVRFX0ZJTEVTKSB7XG4gICAgY29uc3Qgc3JjID0gam9pbihtYWluR3NkLCBmKTtcbiAgICBjb25zdCBkc3QgPSBqb2luKHd0R3NkLCBmKTtcbiAgICBpZiAoZXhpc3RzU3luYyhzcmMpICYmICFleGlzdHNTeW5jKGRzdCkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNwU3luYyhzcmMsIGRzdCk7XG4gICAgICAgIHN5bmNlZC5wdXNoKGYpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIC8qIG5vbi1mYXRhbCAqL1xuICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYGZpbGUgY29weSBmYWlsZWQgKCR7Zn0pOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBGb3J3YXJkLXN5bmMgcHJvamVjdCBwcmVmZXJlbmNlcyBmcm9tIHByb2plY3Qgcm9vdCB0byB3b3JrdHJlZSAoYWRkaXRpdmUgb25seSkuXG4gIC8vIFByZWZlciB0aGUgY2Fub25pY2FsIHVwcGVyY2FzZSBmaWxlIG5hbWUsIGJ1dCBrZWVwIHRoZSBsZWdhY3kgbG93ZXJjYXNlXG4gIC8vIGZhbGxiYWNrIHNvIG9sZGVyIHJlcG9zIHN0aWxsIHdvcmsgb24gY2FzZS1zZW5zaXRpdmUgZmlsZXN5c3RlbXMuXG4gIHtcbiAgICBjb25zdCB3b3JrdHJlZUhhc1ByZWZlcmVuY2VzID0gZXhpc3RzU3luYyhqb2luKHd0R3NkLCBQUk9KRUNUX1BSRUZFUkVOQ0VTX0ZJTEUpKVxuICAgICAgfHwgZXhpc3RzU3luYyhqb2luKHd0R3NkLCBMRUdBQ1lfUFJPSkVDVF9QUkVGRVJFTkNFU19GSUxFKSk7XG4gICAgaWYgKCF3b3JrdHJlZUhhc1ByZWZlcmVuY2VzKSB7XG4gICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgW1BST0pFQ1RfUFJFRkVSRU5DRVNfRklMRSwgTEVHQUNZX1BST0pFQ1RfUFJFRkVSRU5DRVNfRklMRV0gYXMgY29uc3QpIHtcbiAgICAgICAgY29uc3Qgc3JjID0gam9pbihtYWluR3NkLCBmaWxlKTtcbiAgICAgICAgY29uc3QgZHN0ID0gam9pbih3dEdzZCwgZmlsZSk7XG4gICAgICAgIGlmIChleGlzdHNTeW5jKHNyYykpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY3BTeW5jKHNyYywgZHN0KTtcbiAgICAgICAgICAgIHN5bmNlZC5wdXNoKGZpbGUpO1xuICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgLyogbm9uLWZhdGFsICovXG4gICAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYHByZWZlcmVuY2VzIGNvcHkgZmFpbGVkICgke2ZpbGV9KTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gU3luYyBtaWxlc3RvbmVzOiBjb3B5IGVudGlyZSBtaWxlc3RvbmUgZGlyZWN0b3JpZXMgdGhhdCBhcmUgbWlzc2luZ1xuICBjb25zdCBtYWluTWlsZXN0b25lc0RpciA9IGpvaW4obWFpbkdzZCwgXCJtaWxlc3RvbmVzXCIpO1xuICBjb25zdCB3dE1pbGVzdG9uZXNEaXIgPSBqb2luKHd0R3NkLCBcIm1pbGVzdG9uZXNcIik7XG4gIGlmIChleGlzdHNTeW5jKG1haW5NaWxlc3RvbmVzRGlyKSkge1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMod3RNaWxlc3RvbmVzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGNvbnN0IG1haW5NaWxlc3RvbmVzID0gcmVhZGRpclN5bmMobWFpbk1pbGVzdG9uZXNEaXIsIHtcbiAgICAgICAgd2l0aEZpbGVUeXBlczogdHJ1ZSxcbiAgICAgIH0pXG4gICAgICAgIC5maWx0ZXIoKGQpID0+IGQuaXNEaXJlY3RvcnkoKSlcbiAgICAgICAgLm1hcCgoZCkgPT4gZC5uYW1lKTtcblxuICAgICAgZm9yIChjb25zdCBtaWQgb2YgbWFpbk1pbGVzdG9uZXMpIHtcbiAgICAgICAgY29uc3Qgc3JjRGlyID0gam9pbihtYWluTWlsZXN0b25lc0RpciwgbWlkKTtcbiAgICAgICAgY29uc3QgZHN0RGlyID0gam9pbih3dE1pbGVzdG9uZXNEaXIsIG1pZCk7XG5cbiAgICAgICAgaWYgKCFleGlzdHNTeW5jKGRzdERpcikpIHtcbiAgICAgICAgICAvLyBFbnRpcmUgbWlsZXN0b25lIG1pc3NpbmcgZnJvbSB3b3JrdHJlZSBcdTIwMTQgY29weSBpdFxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjcFN5bmMoc3JjRGlyLCBkc3REaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgICAgc3luY2VkLnB1c2goYG1pbGVzdG9uZXMvJHttaWR9L2ApO1xuICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgLyogbm9uLWZhdGFsICovXG4gICAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYG1pbGVzdG9uZSBjb3B5IGZhaWxlZCAoJHttaWR9KTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIE1pbGVzdG9uZSBkaXJlY3RvcnkgZXhpc3RzIGJ1dCBtYXkgYmUgbWlzc2luZyBmaWxlcyAoc3RhbGUgc25hcHNob3QpLlxuICAgICAgICAgIC8vIFN5bmMgaW5kaXZpZHVhbCB0b3AtbGV2ZWwgbWlsZXN0b25lIGZpbGVzIChDT05URVhULCBST0FETUFQLCBSRVNFQVJDSCwgZXRjLilcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgc3JjRmlsZXMgPSByZWFkZGlyU3luYyhzcmNEaXIpLmZpbHRlcihcbiAgICAgICAgICAgICAgKGYpID0+IGYuZW5kc1dpdGgoXCIubWRcIikgfHwgZi5lbmRzV2l0aChcIi5qc29uXCIpLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgZiBvZiBzcmNGaWxlcykge1xuICAgICAgICAgICAgICBjb25zdCBzcmNGaWxlID0gam9pbihzcmNEaXIsIGYpO1xuICAgICAgICAgICAgICBjb25zdCBkc3RGaWxlID0gam9pbihkc3REaXIsIGYpO1xuICAgICAgICAgICAgICBpZiAoIWV4aXN0c1N5bmMoZHN0RmlsZSkpIHtcbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgY29uc3Qgc3JjU3RhdCA9IGxzdGF0U3luY0ZuKHNyY0ZpbGUpO1xuICAgICAgICAgICAgICAgICAgaWYgKHNyY1N0YXQuaXNGaWxlKCkpIHtcbiAgICAgICAgICAgICAgICAgICAgY3BTeW5jKHNyY0ZpbGUsIGRzdEZpbGUpO1xuICAgICAgICAgICAgICAgICAgICBzeW5jZWQucHVzaChgbWlsZXN0b25lcy8ke21pZH0vJHtmfWApO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgICAgLyogbm9uLWZhdGFsICovXG4gICAgICAgICAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYG1pbGVzdG9uZSBmaWxlIGNvcHkgZmFpbGVkICgke21pZH0vJHtmfSk6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBTeW5jIHNsaWNlcyBkaXJlY3RvcnkgaWYgaXQgZXhpc3RzIGluIG1haW4gYnV0IG5vdCBpbiB3b3JrdHJlZVxuICAgICAgICAgICAgY29uc3Qgc3JjU2xpY2VzRGlyID0gam9pbihzcmNEaXIsIFwic2xpY2VzXCIpO1xuICAgICAgICAgICAgY29uc3QgZHN0U2xpY2VzRGlyID0gam9pbihkc3REaXIsIFwic2xpY2VzXCIpO1xuICAgICAgICAgICAgaWYgKGV4aXN0c1N5bmMoc3JjU2xpY2VzRGlyKSAmJiAhZXhpc3RzU3luYyhkc3RTbGljZXNEaXIpKSB7XG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY3BTeW5jKHNyY1NsaWNlc0RpciwgZHN0U2xpY2VzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICAgICAgICBzeW5jZWQucHVzaChgbWlsZXN0b25lcy8ke21pZH0vc2xpY2VzL2ApO1xuICAgICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgICAvKiBub24tZmF0YWwgKi9cbiAgICAgICAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYHNsaWNlcyBjb3B5IGZhaWxlZCAoJHttaWR9KTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXhpc3RzU3luYyhzcmNTbGljZXNEaXIpICYmIGV4aXN0c1N5bmMoZHN0U2xpY2VzRGlyKSkge1xuICAgICAgICAgICAgICAvLyBCb3RoIGV4aXN0IFx1MjAxNCBzeW5jIG1pc3Npbmcgc2xpY2UgZGlyZWN0b3JpZXNcbiAgICAgICAgICAgICAgY29uc3Qgc3JjU2xpY2VzID0gcmVhZGRpclN5bmMoc3JjU2xpY2VzRGlyLCB7XG4gICAgICAgICAgICAgICAgd2l0aEZpbGVUeXBlczogdHJ1ZSxcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAuZmlsdGVyKChkKSA9PiBkLmlzRGlyZWN0b3J5KCkpXG4gICAgICAgICAgICAgICAgLm1hcCgoZCkgPT4gZC5uYW1lKTtcbiAgICAgICAgICAgICAgZm9yIChjb25zdCBzaWQgb2Ygc3JjU2xpY2VzKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgc3JjU2xpY2UgPSBqb2luKHNyY1NsaWNlc0Rpciwgc2lkKTtcbiAgICAgICAgICAgICAgICBjb25zdCBkc3RTbGljZSA9IGpvaW4oZHN0U2xpY2VzRGlyLCBzaWQpO1xuICAgICAgICAgICAgICAgIGlmICghZXhpc3RzU3luYyhkc3RTbGljZSkpIHtcbiAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIGNwU3luYyhzcmNTbGljZSwgZHN0U2xpY2UsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgICAgICAgICAgICBzeW5jZWQucHVzaChgbWlsZXN0b25lcy8ke21pZH0vc2xpY2VzLyR7c2lkfS9gKTtcbiAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgICAgICAgICAvKiBub24tZmF0YWwgKi9cbiAgICAgICAgICAgICAgICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBzbGljZSBjb3B5IGZhaWxlZCAoJHttaWR9LyR7c2lkfSk6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgLyogbm9uLWZhdGFsICovXG4gICAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYG1pbGVzdG9uZSBmaWxlIHN5bmMgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIC8qIG5vbi1mYXRhbCAqL1xuICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBtaWxlc3RvbmUgZGlyZWN0b3J5IHN5bmMgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBzeW5jZWQgfTtcbn1cblxuLyoqXG4gKiBTeW5jIGNvbXBhdGliaWxpdHkgYXJ0aWZhY3RzIGZyb20gd29ya3RyZWUgYmFjayB0byB0aGUgbWFpbiBleHRlcm5hbCBzdGF0ZVxuICogZGlyZWN0b3J5LiBDYW5vbmljYWwgd29ya2Zsb3cgc3RhdGUgbGl2ZXMgaW4gdGhlIHByb2plY3QgREI7IHdvcmt0cmVlIC5nc2RcbiAqIGNvbnRlbnQgaXMgbGVnYWN5IHByb2plY3Rpb24vZGlhZ25vc3RpYyBkYXRhIG9ubHkuXG4gKlxuICogU3luY3M6XG4gKiAgIDEuIExlZ2FjeSB3b3JrdHJlZSBEQnMgYXJlIHJlY29uY2lsZWQgaW50byB0aGUgY2Fub25pY2FsIHByb2plY3QgREIuXG4gKiAgIDIuIFJ1bnRpbWUgZGlhZ25vc3RpYyBmaWxlcyBtYXkgYmUgY29waWVkIGZvciBvcGVyYXRvciB2aXNpYmlsaXR5LlxuICpcbiAqIE1hcmtkb3duIG1pbGVzdG9uZSBkaXJlY3RvcmllcyBhcmUgcHJvamVjdGlvbnMgYW5kIGFyZSBub3QgY29waWVkIGZyb21cbiAqIHdvcmt0cmVlcyBpbnRvIHRoZSBwcm9qZWN0IHJvb3QuIEN1cnJlbnQgd29ya2Zsb3cgc3RhdGUgbXVzdCBhcnJpdmUgdGhyb3VnaFxuICogdGhlIHNoYXJlZCBwcm9qZWN0IERCIG9yIHRoZSBwcmUtdXBncmFkZSBEQiByZWNvbmNpbGlhdGlvbiBwYXRoIGFib3ZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3luY1dvcmt0cmVlU3RhdGVCYWNrKFxuICBtYWluQmFzZVBhdGg6IHN0cmluZyxcbiAgd29ya3RyZWVQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4pOiB7IHN5bmNlZDogc3RyaW5nW10gfSB7XG4gIHJldHVybiBfZmluYWxpemVQcm9qZWN0aW9uRm9yTWVyZ2VJbXBsKG1haW5CYXNlUGF0aCwgd29ya3RyZWVQYXRoLCBtaWxlc3RvbmVJZCk7XG59XG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgV29ya3RyZWUgUG9zdC1DcmVhdGUgSG9vayAoIzU5NykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUnVuIHRoZSB1c2VyLWNvbmZpZ3VyZWQgcG9zdC1jcmVhdGUgaG9vayBzY3JpcHQgYWZ0ZXIgd29ya3RyZWUgY3JlYXRpb24uXG4gKiBUaGUgc2NyaXB0IHJlY2VpdmVzIFNPVVJDRV9ESVIgYW5kIFdPUktUUkVFX0RJUiBhcyBlbnZpcm9ubWVudCB2YXJpYWJsZXMuXG4gKiBGYWlsdXJlIGlzIG5vbi1mYXRhbCBcdTIwMTQgcmV0dXJucyB0aGUgZXJyb3IgbWVzc2FnZSBvciBudWxsIG9uIHN1Y2Nlc3MuXG4gKlxuICogUmVhZHMgdGhlIGhvb2sgcGF0aCBmcm9tIGdpdC53b3JrdHJlZV9wb3N0X2NyZWF0ZSBpbiBwcmVmZXJlbmNlcy5cbiAqIFBhc3MgaG9va1BhdGggZGlyZWN0bHkgdG8gYnlwYXNzIHByZWZlcmVuY2UgbG9hZGluZyAodXNlZnVsIGZvciB0ZXN0aW5nKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1bldvcmt0cmVlUG9zdENyZWF0ZUhvb2soXG4gIHNvdXJjZURpcjogc3RyaW5nLFxuICB3b3JrdHJlZURpcjogc3RyaW5nLFxuICBob29rUGF0aD86IHN0cmluZyxcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoaG9va1BhdGggPT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy5naXQ7XG4gICAgaG9va1BhdGggPSBwcmVmcz8ud29ya3RyZWVfcG9zdF9jcmVhdGU7XG4gIH1cbiAgaWYgKCFob29rUGF0aCkgcmV0dXJuIG51bGw7XG5cbiAgLy8gUmVzb2x2ZSByZWxhdGl2ZSBwYXRocyBhZ2FpbnN0IHRoZSBzb3VyY2UgcHJvamVjdCByb290LlxuICAvLyBPbiBXaW5kb3dzLCBjb252ZXJ0IDguMyBzaG9ydCBwYXRocyAoZS5nLiBSVU5ORVJ+MSkgdG8gbG9uZyBwYXRoc1xuICAvLyBzbyBleGVjRmlsZVN5bmMgY2FuIGxvY2F0ZSB0aGUgZmlsZSBjb3JyZWN0bHkuXG4gIGxldCByZXNvbHZlZCA9IGlzQWJzb2x1dGUoaG9va1BhdGgpID8gaG9va1BhdGggOiBqb2luKHNvdXJjZURpciwgaG9va1BhdGgpO1xuICBpZiAoIWV4aXN0c1N5bmMocmVzb2x2ZWQpKSB7XG4gICAgcmV0dXJuIGBXb3JrdHJlZSBwb3N0LWNyZWF0ZSBob29rIG5vdCBmb3VuZDogJHtyZXNvbHZlZH1gO1xuICB9XG4gIGlmIChwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIpIHtcbiAgICB0cnkgeyByZXNvbHZlZCA9IHJlYWxwYXRoU3luYy5uYXRpdmUocmVzb2x2ZWQpOyB9IGNhdGNoIChlcnIpIHsgLyoga2VlcCBvcmlnaW5hbCAqL1xuICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGByZWFscGF0aCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgIH1cbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gLmJhdC8uY21kIGZpbGVzIG9uIFdpbmRvd3MgcmVxdWlyZSBzaGVsbCBtb2RlIFx1MjAxNCBleGVjRmlsZVN5bmMgY2Fubm90XG4gICAgLy8gc3Bhd24gdGhlbSBkaXJlY3RseSAoRUlOVkFMKS5cbiAgICBjb25zdCBuZWVkc1NoZWxsID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiICYmIC9cXC4oYmF0fGNtZCkkL2kudGVzdChyZXNvbHZlZCk7XG4gICAgZXhlY0ZpbGVTeW5jKHJlc29sdmVkLCBbXSwge1xuICAgICAgY3dkOiB3b3JrdHJlZURpcixcbiAgICAgIGVudjoge1xuICAgICAgICAuLi5wcm9jZXNzLmVudixcbiAgICAgICAgU09VUkNFX0RJUjogc291cmNlRGlyLFxuICAgICAgICBXT1JLVFJFRV9ESVI6IHdvcmt0cmVlRGlyLFxuICAgICAgfSxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgICB0aW1lb3V0OiAzMF8wMDAsIC8vIDMwIHNlY29uZCB0aW1lb3V0XG4gICAgICBzaGVsbDogbmVlZHNTaGVsbCxcbiAgICB9KTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIHJldHVybiBgV29ya3RyZWUgcG9zdC1jcmVhdGUgaG9vayBmYWlsZWQ6ICR7bXNnfWA7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEF1dG8tV29ya3RyZWUgQnJhbmNoIE5hbWluZyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIFJldHVybnMgdGhlIGdpdCBicmFuY2ggbmFtZSBmb3IgYSBtaWxlc3RvbmUgd29ya3RyZWUgKGBtaWxlc3RvbmUvPE1JRD5gKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhdXRvV29ya3RyZWVCcmFuY2gobWlsZXN0b25lSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgbWlsZXN0b25lLyR7bWlsZXN0b25lSWR9YDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTG9jYWxCcmFuY2hSZWYoYnJhbmNoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYnJhbmNoLnN0YXJ0c1dpdGgoXCJyZWZzL2hlYWRzL1wiKVxuICAgID8gYnJhbmNoLnNsaWNlKFwicmVmcy9oZWFkcy9cIi5sZW5ndGgpXG4gICAgOiBicmFuY2g7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBCcmFuY2gtbW9kZSBFbnRyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBFbnRlciBicmFuY2ggaXNvbGF0aW9uIG1vZGUgZm9yIGEgbWlsZXN0b25lLlxuICpcbiAqIENyZWF0ZXMgYG1pbGVzdG9uZS88TUlEPmAgZnJvbSB0aGUgaW50ZWdyYXRpb24gYnJhbmNoIChpZiBpdCBkb2Vzbid0XG4gKiBleGlzdCB5ZXQpIGFuZCBjaGVja3Mgb3V0IHRvIGl0LiAgTm8gd29ya3RyZWUgZGlyZWN0b3J5IGlzIGNyZWF0ZWQgXHUyMDE0IHRoZVxuICogcHJvamVjdCByb290IGlzIHRoZSB3b3JraW5nIGNvcHk7IG9ubHkgSEVBRCBjaGFuZ2VzLlxuICpcbiAqIFVzZXMgdGhlIHNhbWUgMy10aWVyIGludGVncmF0aW9uLWJyYW5jaCBmYWxsYmFjayBhcyBjcmVhdGVBdXRvV29ya3RyZWU6XG4gKiAgIDEuIE1FVEEuanNvbiByZWNvcmRlZCBpbnRlZ3JhdGlvbiBicmFuY2hcbiAqICAgMi4gZ2l0Lm1haW5fYnJhbmNoIHByZWZlcmVuY2VcbiAqICAgMy4gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaCAob3JpZ2luL0hFQUQgYXV0by1kZXRlY3Rpb24pXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRlckJyYW5jaE1vZGVGb3JNaWxlc3RvbmUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgY29uc3QgYnJhbmNoID0gYXV0b1dvcmt0cmVlQnJhbmNoKG1pbGVzdG9uZUlkKTtcbiAgY29uc3QgYnJhbmNoRXhpc3RzID0gbmF0aXZlQnJhbmNoRXhpc3RzKGJhc2VQYXRoLCBicmFuY2gpO1xuXG4gIGlmICghYnJhbmNoRXhpc3RzKSB7XG4gICAgLy8gQ3JlYXRlIHRoZSBtaWxlc3RvbmUgYnJhbmNoIGZyb20gdGhlIGludGVncmF0aW9uIGJyYW5jaCBzdGFydC1wb2ludC5cbiAgICBjb25zdCBpbnRlZ3JhdGlvbkJyYW5jaCA9XG4gICAgICByZWFkSW50ZWdyYXRpb25CcmFuY2goYmFzZVBhdGgsIG1pbGVzdG9uZUlkKSA/PyB1bmRlZmluZWQ7XG4gICAgY29uc3QgZ2l0UHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM/LmdpdDtcbiAgICBjb25zdCBzdGFydFBvaW50ID1cbiAgICAgIF9yZXNvbHZlQXV0b1dvcmt0cmVlU3RhcnRQb2ludChcbiAgICAgICAgaW50ZWdyYXRpb25CcmFuY2gsXG4gICAgICAgIGdpdFByZWZzPy5tYWluX2JyYW5jaCxcbiAgICAgICAgKGJyYW5jaE5hbWUpID0+IG5hdGl2ZUJyYW5jaEV4aXN0cyhiYXNlUGF0aCwgYnJhbmNoTmFtZSksXG4gICAgICApID8/XG4gICAgICBuYXRpdmVEZXRlY3RNYWluQnJhbmNoKGJhc2VQYXRoKTtcblxuICAgIC8vIFRPQ1RPVSBhbmNlc3RyeSBndWFyZCAoSXNzdWUgIzQ5ODAgSElHSC0zKS5cbiAgICAvL1xuICAgIC8vIFRoZSBvdXRlciBgYnJhbmNoRXhpc3RzYCBjaGVjayBhdCBsaW5lIDEwMTIgaXMgcmFjeTogYSBjb25jdXJyZW50XG4gICAgLy8gcHJvY2VzcyAocGFyYWxsZWwtb3JjaGVzdHJhdG9yIHdvcmtlciwgc2lkZS1ieS1zaWRlIGBnc2RgIGluc3RhbmNlLFxuICAgIC8vIG9yIG1hbnVhbCBgZ2l0IGJyYW5jaGAgaW52b2NhdGlvbikgbWF5IGhhdmUgY3JlYXRlZCB0aGUgYnJhbmNoIHdpdGhcbiAgICAvLyByZWFsIGNvbW1pdHMgYmV0d2VlbiB0aGF0IGNoZWNrIGFuZCB0aGlzIHBvaW50LiBgbmF0aXZlQnJhbmNoRm9yY2VSZXNldGBcbiAgICAvLyBkb2VzIGBnaXQgYnJhbmNoIC1mYCwgd2hpY2ggc2lsZW50bHkgb3ZlcndyaXRlcyB0aGUgYnJhbmNoIHJlZiBcdTIwMTRcbiAgICAvLyBvcnBoYW5pbmcgYW55IGNvbW1pdHMgbm90IHJlYWNoYWJsZSBmcm9tIGBzdGFydFBvaW50YC4gUmUtY2hlY2tcbiAgICAvLyBpbW1lZGlhdGVseSBiZWZvcmUgdGhlIGRlc3RydWN0aXZlIGNhbGwgYW5kIHJlZnVzZSBpZiB0aGUgYnJhbmNoXG4gICAgLy8gc3VkZGVubHkgZXhpc3RzIHdpdGggbm9uLWFuY2VzdG9yIGNvbW1pdHMuXG4gICAgLy9cbiAgICAvLyBOb3RlOiB1bmRlciBzaW5nbGUtdGhyZWFkZWQgZXhlY3V0aW9uIHRoaXMgaXMgcmFyZWx5IHJlYWNoZWQsIGJ1dCBpdFxuICAgIC8vIGlzIE5PVCBkZWFkIGNvZGUgXHUyMDE0IGl0IGlzIHRoZSBvbmx5IGJhcnJpZXIgYWdhaW5zdCBhIFRPQ1RPVS1pbmR1Y2VkXG4gICAgLy8gY29tbWl0IGxvc3MgaW4gdGhpcyBjb2RlIHBhdGguXG4gICAgY29uc3QgY29uY3VycmVudGx5Q3JlYXRlZCA9IG5hdGl2ZUJyYW5jaEV4aXN0cyhiYXNlUGF0aCwgYnJhbmNoKTtcbiAgICBpZiAoXG4gICAgICBjb25jdXJyZW50bHlDcmVhdGVkICYmXG4gICAgICAhbmF0aXZlSXNBbmNlc3RvcihiYXNlUGF0aCwgYnJhbmNoLCBzdGFydFBvaW50KVxuICAgICkge1xuICAgICAgdGhyb3cgbmV3IEdTREVycm9yKFxuICAgICAgICBHU0RfR0lUX0VSUk9SLFxuICAgICAgICBgQnJhbmNoIFwiJHticmFuY2h9XCIgd2FzIGNyZWF0ZWQgY29uY3VycmVudGx5IHdpdGggY29tbWl0cyBub3QgcmVhY2hhYmxlIGZyb20gXCIke3N0YXJ0UG9pbnR9XCIuIGAgK1xuICAgICAgICBgUmVmdXNpbmcgdG8gZm9yY2UtcmVzZXQgXHUyMDE0IHdvdWxkIG9ycGhhbiBwcmlvciB3b3JrLiBgICtcbiAgICAgICAgYFJlc3VtZSB0aGUgZXhpc3RpbmcgbWlsZXN0b25lIG9yIHJ1biBcXGBnaXQgYnJhbmNoIC1EICR7YnJhbmNofVxcYCB0byBkaXNjYXJkLmAsXG4gICAgICApO1xuICAgIH1cbiAgICAvLyBuYXRpdmVCcmFuY2hGb3JjZVJlc2V0IGNyZWF0ZXMgKG9yIHJlc2V0cykgYnJhbmNoIGF0IHN0YXJ0UG9pbnQsXG4gICAgLy8gdGhlbiBjaGVja291dCBzd2l0Y2hlcyBIRUFEIHRvIGl0LlxuICAgIG5hdGl2ZUJyYW5jaEZvcmNlUmVzZXQoYmFzZVBhdGgsIGJyYW5jaCwgc3RhcnRQb2ludCk7XG4gICAgZGVidWdMb2coXCJhdXRvLXdvcmt0cmVlXCIsIHtcbiAgICAgIGFjdGlvbjogXCJlbnRlckJyYW5jaE1vZGVcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgYnJhbmNoLFxuICAgICAgc3RhcnRQb2ludCxcbiAgICAgIGNyZWF0ZWQ6IHRydWUsXG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgZGVidWdMb2coXCJhdXRvLXdvcmt0cmVlXCIsIHtcbiAgICAgIGFjdGlvbjogXCJlbnRlckJyYW5jaE1vZGVcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgYnJhbmNoLFxuICAgICAgcmV1c2VkOiB0cnVlLFxuICAgIH0pO1xuICB9XG5cbiAgbmF0aXZlQ2hlY2tvdXRCcmFuY2goYmFzZVBhdGgsIGJyYW5jaCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBQdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIENyZWF0ZSBhIG5ldyBhdXRvLXdvcmt0cmVlIGZvciBhIG1pbGVzdG9uZSwgY2hkaXIgaW50byBpdCwgYW5kIHN0b3JlXG4gKiB0aGUgb3JpZ2luYWwgYmFzZSBwYXRoIGZvciBsYXRlciB0ZWFyZG93bi5cbiAqXG4gKiBBdG9taWM6IGNoZGlyICsgb3JpZ2luYWxCYXNlIHVwZGF0ZSBoYXBwZW4gaW4gdGhlIHNhbWUgdHJ5IGJsb2NrXG4gKiB0byBwcmV2ZW50IHNwbGl0LWJyYWluLlxuICovXG5cbi8qKlxuICogRm9yd2FyZC1tZXJnZSBwbGFuIGNoZWNrYm94IHN0YXRlIGZyb20gdGhlIHByb2plY3Qgcm9vdCBpbnRvIGEgZnJlc2hseVxuICogcmUtYXR0YWNoZWQgd29ya3RyZWUgKCM3NzgpLlxuICpcbiAqIFBoYXNlIEM6IGRlbGV0ZWQuIFdyaXRlcnMgaW4gd29ya2Zsb3ctcHJvamVjdGlvbnMudHMsIHRyaWFnZS1yZXNvbHV0aW9uLnRzLFxuICogcnVsZS1yZWdpc3RyeS50cywgYW5kIGF1dG8tcG9zdC11bml0LnRzIG5vdyByb3V0ZSB0aHJvdWdoXG4gKiBzLmNhbm9uaWNhbFByb2plY3RSb290LCBzbyBub24tc3ltbGlua2VkIHdvcmt0cmVlcyBubyBsb25nZXIgbmVlZCBhIGxvY2FsXG4gKiAuZ3NkLyBwcm9qZWN0aW9uIFx1MjAxNCB0aGUgcHJvamVjdC1yb290IC5nc2QvIGlzIHRoZSBvbmx5IGF1dGhvcml0YXRpdmUgc291cmNlXG4gKiBmb3IgYm90aCByZWFkcyBhbmQgd3JpdGVzLiBjb3B5UGxhbm5pbmdBcnRpZmFjdHMgYW5kIHJlY29uY2lsZVBsYW5DaGVja2JveGVzXG4gKiAoYm90aCBmb3JtZXJseSBoZXJlKSBiZWNhbWUgZGVhZC5cbiAqL1xuXG4vKipcbiAqIFRydWUgd2hlbiBgYnJhbmNoYCBpcyBjaGVja2VkIG91dCBpbiBhbnkgd29ya3RyZWUgbGlzdGVkIGJ5XG4gKiBgZ2l0IHdvcmt0cmVlIGxpc3QgLS1wb3JjZWxhaW5gLiBVc2VkIHRvIGdhdGUgcmVmIHVwZGF0ZXMgdGhhdCB3b3VsZFxuICogb3RoZXJ3aXNlIGxlYXZlIGEgY29uY3VycmVudCB3b3JrdHJlZSdzIEhFQUQgaW5jb25zaXN0ZW50IHdpdGggaXRzXG4gKiBpbmRleC93b3JraW5nIHRyZWUgKENvZGV4IHBlZXItcmV2aWV3IG9mICM1NTM4LWZvbGxvd3VwKS5cbiAqXG4gKiBCZXN0LWVmZm9ydDogYSBgbmF0aXZlV29ya3RyZWVMaXN0YCBmYWlsdXJlIHJldHVybnMgdHJ1ZSBzbyB3ZSBlcnIgb25cbiAqIHRoZSBzaWRlIG9mIE5PVCBtb3ZpbmcgdGhlIHJlZi4gQmV0dGVyIHRvIHNraXAgYSBmYXN0LWZvcndhcmQgdGhhbiB0b1xuICogc2lsZW50bHkgY29ycnVwdCBhbm90aGVyIHdvcmt0cmVlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gX2lzQnJhbmNoQ2hlY2tlZE91dEVsc2V3aGVyZShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgYnJhbmNoOiBzdHJpbmcsXG4pOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBlbnRyaWVzID0gbmF0aXZlV29ya3RyZWVMaXN0KGJhc2VQYXRoKTtcbiAgICByZXR1cm4gZW50cmllcy5zb21lKChlbnRyeSkgPT4gZW50cnkuYnJhbmNoID09PSBicmFuY2gpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxufVxuXG4vKipcbiAqIFJlc29sdmUgdGhlIGludGVncmF0aW9uIGJyYW5jaCB1c2luZyB0aGUgc2FtZSAzLXRpZXIgZmFsbGJhY2sgYXMgdGhlXG4gKiBmcmVzaC1jcmVhdGUgcGF0aDogTUVUQS5qc29uIFx1MjE5MiBnaXQubWFpbl9icmFuY2ggcHJlZmVyZW5jZSBcdTIxOTIgZGV0ZWN0ZWRcbiAqIG1haW4gYnJhbmNoLiBSZXR1cm5zIG51bGwgd2hlbiBubyB1c2FibGUgdGFyZ2V0IGV4aXN0cy5cbiAqL1xuZnVuY3Rpb24gX3Jlc29sdmVJbnRlZ3JhdGlvbkJyYW5jaEZvclJldXNlKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGZyb21NZXRhID0gcmVhZEludGVncmF0aW9uQnJhbmNoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCk7XG4gIGlmIChmcm9tTWV0YSkgcmV0dXJuIGZyb21NZXRhO1xuXG4gIGNvbnN0IGdpdFByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy5naXQ7XG4gIGNvbnN0IGZyb21QcmVmID0gZ2l0UHJlZnM/Lm1haW5fYnJhbmNoICYmXG4gICAgdHlwZW9mIGdpdFByZWZzLm1haW5fYnJhbmNoID09PSBcInN0cmluZ1wiICYmXG4gICAgZ2l0UHJlZnMubWFpbl9icmFuY2gubGVuZ3RoID4gMCAmJlxuICAgIG5hdGl2ZUJyYW5jaEV4aXN0cyhiYXNlUGF0aCwgZ2l0UHJlZnMubWFpbl9icmFuY2gpXG4gICAgPyBnaXRQcmVmcy5tYWluX2JyYW5jaFxuICAgIDogbnVsbDtcbiAgaWYgKGZyb21QcmVmKSByZXR1cm4gZnJvbVByZWY7XG5cbiAgdHJ5IHtcbiAgICByZXR1cm4gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKlxuICogV2hlbiByZXVzaW5nIGFuIGV4aXN0aW5nIG1pbGVzdG9uZSBicmFuY2gsIGZhc3QtZm9yd2FyZCBpdCBvbnRvIHRoZVxuICogaW50ZWdyYXRpb24gYnJhbmNoIHdoZW4gdGhhdCdzIHNhZmUgKGJyYW5jaCBpcyBhIHN0cmljdCBhbmNlc3RvciBvZlxuICogaW50ZWdyYXRpb24gXHUyMDE0IG5vIGNvbW1pdHMgd291bGQgYmUgbG9zdCkuIFNraXBzIHdoZW4gdGhlIGJyYW5jaCBoYXMgaXRzXG4gKiBvd24gY29tbWl0cyBhaGVhZCBvZiBpbnRlZ3JhdGlvbiwgd2hlbiB0aGUgaW50ZWdyYXRpb24gYnJhbmNoIGNhbid0IGJlXG4gKiByZXNvbHZlZCwgb3Igd2hlbiBhbnkgZ2l0IG9wZXJhdGlvbiBmYWlscyBcdTIwMTQgdGhlIG1lcmdlIGdhdGUgYXQgbWlsZXN0b25lXG4gKiBjb21wbGV0aW9uIHdpbGwgc3VyZmFjZSByZWFsIGRpdmVyZ2VuY2UgYXMgYSBjb25mbGljdC5cbiAqXG4gKiBUaGUgcHJldmlvdXMgYmVoYXZpb3IgcmUtYXR0YWNoZWQgdGhlIHdvcmt0cmVlIHRvIHdoYXRldmVyIHN0YWxlIHRpcFxuICogdGhlIGJyYW5jaCBoZWxkLCB3aGljaCBjYXVzZWQgbmV3IG1pbGVzdG9uZSB3b3JrIHRvIGZvcmsgZnJvbSBhIGJhc2VcbiAqIG1pc3NpbmcgcHJpb3IgbWlsZXN0b25lcycgbWVyZ2VzICgjNTUzOC1mb2xsb3d1cCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmYXN0Rm9yd2FyZFJldXNlZE1pbGVzdG9uZUJyYW5jaElmU2FmZShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgYnJhbmNoOiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBpbnRlZ3JhdGlvbkJyYW5jaCA9IF9yZXNvbHZlSW50ZWdyYXRpb25CcmFuY2hGb3JSZXVzZShiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgIGlmICghaW50ZWdyYXRpb25CcmFuY2ggfHwgaW50ZWdyYXRpb25CcmFuY2ggPT09IGJyYW5jaCkgcmV0dXJuO1xuICAgIGlmICghbmF0aXZlQnJhbmNoRXhpc3RzKGJhc2VQYXRoLCBpbnRlZ3JhdGlvbkJyYW5jaCkpIHJldHVybjtcblxuICAgIC8vIFB1cmUgZmFzdC1mb3J3YXJkIG9ubHk6IGJyYW5jaCBtdXN0IGJlIGEgc3RyaWN0IGFuY2VzdG9yIG9mIGludGVncmF0aW9uLlxuICAgIC8vIElmIHRoZSBicmFuY2ggaGFzIGl0cyBvd24gY29tbWl0cyBhaGVhZCwgbGVhdmUgaXQgYWxvbmUuXG4gICAgaWYgKCFuYXRpdmVJc0FuY2VzdG9yKGJhc2VQYXRoLCBicmFuY2gsIGludGVncmF0aW9uQnJhbmNoKSkge1xuICAgICAgZGVidWdMb2coXCJjcmVhdGVBdXRvV29ya3RyZWVcIiwge1xuICAgICAgICBwaGFzZTogXCJza2lwLWZmLWJyYW5jaC1ub3QtYW5jZXN0b3JcIixcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIGJyYW5jaCxcbiAgICAgICAgaW50ZWdyYXRpb246IGludGVncmF0aW9uQnJhbmNoLFxuICAgICAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gQ29kZXggcGVlci1yZXZpZXc6IGBuYXRpdmVVcGRhdGVSZWZgIHN1Y2NlZWRzIGV2ZW4gd2hlbiB0aGUgYnJhbmNoIGlzXG4gICAgLy8gY3VycmVudGx5IGNoZWNrZWQgb3V0IGluIGFub3RoZXIgd29ya3RyZWUsIGxlYXZpbmcgdGhhdCB3b3JrdHJlZSdzIEhFQURcbiAgICAvLyBpbmNvbnNpc3RlbnQgd2l0aCBpdHMgaW5kZXgvd29yayB0cmVlLiBTa2lwIHRoZSBmYXN0LWZvcndhcmQgaWYgYW55XG4gICAgLy8gbGlzdGVkIHdvcmt0cmVlIGhhcyB0aGlzIGJyYW5jaCBjaGVja2VkIG91dCBcdTIwMTQgdGhlIG1lcmdlIGdhdGUgYXRcbiAgICAvLyBtaWxlc3RvbmUtY29tcGxldGlvbiB3aWxsIHN1cmZhY2Ugc3RhbGUtYmFzZSBkaXZlcmdlbmNlIGFzIGEgY29uZmxpY3RcbiAgICAvLyBpbnN0ZWFkIG9mIHNpbGVudGx5IGNvcnJ1cHRpbmcgdGhlIG90aGVyIHdvcmt0cmVlJ3Mgc3RhdGUuXG4gICAgaWYgKF9pc0JyYW5jaENoZWNrZWRPdXRFbHNld2hlcmUoYmFzZVBhdGgsIGJyYW5jaCkpIHtcbiAgICAgIGRlYnVnTG9nKFwiY3JlYXRlQXV0b1dvcmt0cmVlXCIsIHtcbiAgICAgICAgcGhhc2U6IFwic2tpcC1mZi1icmFuY2gtY2hlY2tlZC1vdXQtZWxzZXdoZXJlXCIsXG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBicmFuY2gsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBuYXRpdmVVcGRhdGVSZWYoYmFzZVBhdGgsIGByZWZzL2hlYWRzLyR7YnJhbmNofWAsIGludGVncmF0aW9uQnJhbmNoKTtcbiAgICBkZWJ1Z0xvZyhcImNyZWF0ZUF1dG9Xb3JrdHJlZVwiLCB7XG4gICAgICBwaGFzZTogXCJmYXN0LWZvcndhcmQtcmV1c2VkLWJyYW5jaFwiLFxuICAgICAgbWlsZXN0b25lSWQsXG4gICAgICBicmFuY2gsXG4gICAgICBpbnRlZ3JhdGlvbjogaW50ZWdyYXRpb25CcmFuY2gsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGRlYnVnTG9nKFwiY3JlYXRlQXV0b1dvcmt0cmVlXCIsIHtcbiAgICAgIHBoYXNlOiBcImZhc3QtZm9yd2FyZC1yZXVzZWQtYnJhbmNoLWZhaWxlZFwiLFxuICAgICAgbWlsZXN0b25lSWQsXG4gICAgICBicmFuY2gsXG4gICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVBdXRvV29ya3RyZWUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBiYXNlUGF0aCA9IHJlc29sdmVXb3JrdHJlZVByb2plY3RSb290KGJhc2VQYXRoKTtcblxuICAvLyBDaGVjayBpZiByZXBvIGhhcyBjb21taXRzIFx1MjAxNCBnaXQgd29ya3RyZWUgcmVxdWlyZXMgYSB2YWxpZCBIRUFEXG4gIHRyeSB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBcIi0tdmVyaWZ5XCIsIFwiSEVBRFwiXSwgeyBjd2Q6IGJhc2VQYXRoLCBzdGRpbzogXCJwaXBlXCIgfSk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBHU0RFcnJvcihcbiAgICAgIEdTRF9HSVRfRVJST1IsXG4gICAgICBgQ2Fubm90IGNyZWF0ZSB3b3JrdHJlZTogcmVwb3NpdG9yeSBoYXMgbm8gY29tbWl0cyB5ZXQuIFdvcmt0cmVlIGlzb2xhdGlvbiByZXF1aXJlcyBhdCBsZWFzdCBvbmUgY29tbWl0LmAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGJyYW5jaCA9IGF1dG9Xb3JrdHJlZUJyYW5jaChtaWxlc3RvbmVJZCk7XG5cbiAgLy8gQ2hlY2sgaWYgdGhlIG1pbGVzdG9uZSBicmFuY2ggYWxyZWFkeSBleGlzdHMgXHUyMDE0IGl0IHN1cnZpdmVzIGF1dG8tbW9kZVxuICAvLyBzdG9wL3BhdXNlIGFuZCBjb250YWlucyBjb21taXR0ZWQgd29yayBmcm9tIHByaW9yIHNlc3Npb25zLiBJZiBpdCBleGlzdHMsXG4gIC8vIHJlLWF0dGFjaCB0aGUgd29ya3RyZWUgdG8gaXQgV0lUSE9VVCByZXNldHRpbmcuIE9ubHkgY3JlYXRlIGEgZnJlc2ggYnJhbmNoXG4gIC8vIGZyb20gdGhlIGludGVncmF0aW9uIGJyYW5jaCB3aGVuIG5vIHByaW9yIHdvcmsgZXhpc3RzLlxuICBjb25zdCBicmFuY2hFeGlzdHMgPSBuYXRpdmVCcmFuY2hFeGlzdHMoYmFzZVBhdGgsIGJyYW5jaCk7XG5cbiAgbGV0IGluZm86IHsgbmFtZTogc3RyaW5nOyBwYXRoOiBzdHJpbmc7IGJyYW5jaDogc3RyaW5nOyBleGlzdHM6IGJvb2xlYW4gfTtcbiAgaWYgKGJyYW5jaEV4aXN0cykge1xuICAgIC8vICM1NTM4LWZvbGxvd3VwOiBmYXN0LWZvcndhcmQgdGhlIHJldXNlZCBicmFuY2ggb250byB0aGUgaW50ZWdyYXRpb25cbiAgICAvLyBicmFuY2ggd2hlbiBzYWZlIHNvIHRoZSBuZXh0IG1pbGVzdG9uZSBmb3JrcyBmcm9tIHVwLXRvLWRhdGUgY29kZS5cbiAgICAvLyBXaXRob3V0IHRoaXMsIGEgbWlsZXN0b25lIHRoYXQgd2FzIGNyZWF0ZWQgYmVmb3JlIGFub3RoZXIgbWlsZXN0b25lXG4gICAgLy8gbWVyZ2VkIGludG8gbWFpbiB3b3VsZCBjYXJyeSBhIHN0YWxlIGJhc2UgaW50byBpdHMgd29ya3RyZWUuXG4gICAgZmFzdEZvcndhcmRSZXVzZWRNaWxlc3RvbmVCcmFuY2hJZlNhZmUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBicmFuY2gpO1xuXG4gICAgLy8gUmUtYXR0YWNoIHdvcmt0cmVlIHRvIHRoZSBleGlzdGluZyBtaWxlc3RvbmUgYnJhbmNoIChwcmVzZXJ2aW5nIGNvbW1pdHMpXG4gICAgaW5mbyA9IGNyZWF0ZVdvcmt0cmVlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwge1xuICAgICAgYnJhbmNoLFxuICAgICAgcmV1c2VFeGlzdGluZ0JyYW5jaDogdHJ1ZSxcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICAvLyBGcmVzaCBzdGFydCBcdTIwMTQgY3JlYXRlIGJyYW5jaCBmcm9tIGludGVncmF0aW9uIGJyYW5jaC5cbiAgICAvLyBVc2UgdGhlIHNhbWUgMy10aWVyIGZhbGxiYWNrIGFzIG1lcmdlTWlsZXN0b25lVG9NYWluICgjMzQ2MSk6XG4gICAgLy8gICAxLiBNRVRBLmpzb24gaW50ZWdyYXRpb24gYnJhbmNoIChleHBsaWNpdCBwZXItbWlsZXN0b25lIG92ZXJyaWRlKVxuICAgIC8vICAgMi4gZ2l0Lm1haW5fYnJhbmNoIHByZWZlcmVuY2UgKHVzZXIncyBjb25maWd1cmVkIHdvcmtpbmcgYnJhbmNoKVxuICAgIC8vICAgMy4gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaCAob3JpZ2luL0hFQUQgYXV0by1kZXRlY3Rpb24pXG4gICAgLy8gV2l0aG91dCB0aWVyIDIsIHByb2plY3RzIHdpdGggbWFpbl9icmFuY2g9ZGV2IGJ1dCBvcmlnaW4vSEVBRFx1MjE5Mm1hc3RlclxuICAgIC8vIHdvdWxkIGZvcmsgd29ya3RyZWVzIGZyb20gdGhlIHdyb25nIChzdGFsZSkgYnJhbmNoLlxuICAgIGNvbnN0IGludGVncmF0aW9uQnJhbmNoID1cbiAgICAgIHJlYWRJbnRlZ3JhdGlvbkJyYW5jaChiYXNlUGF0aCwgbWlsZXN0b25lSWQpID8/IHVuZGVmaW5lZDtcbiAgICBjb25zdCBnaXRQcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpPy5wcmVmZXJlbmNlcz8uZ2l0O1xuICAgIGNvbnN0IHN0YXJ0UG9pbnQgPSBfcmVzb2x2ZUF1dG9Xb3JrdHJlZVN0YXJ0UG9pbnQoXG4gICAgICBpbnRlZ3JhdGlvbkJyYW5jaCxcbiAgICAgIGdpdFByZWZzPy5tYWluX2JyYW5jaCxcbiAgICAgIChicmFuY2hOYW1lKSA9PiBuYXRpdmVCcmFuY2hFeGlzdHMoYmFzZVBhdGgsIGJyYW5jaE5hbWUpLFxuICAgICk7XG4gICAgaW5mbyA9IGNyZWF0ZVdvcmt0cmVlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwge1xuICAgICAgYnJhbmNoLFxuICAgICAgc3RhcnRQb2ludCxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFBoYXNlIEM6IGNvcHlQbGFubmluZ0FydGlmYWN0cyBhbmQgcmVjb25jaWxlUGxhbkNoZWNrYm94ZXMgd2VyZVxuICAvLyBkZWxldGVkLiBCb3RoIGFkZHJlc3NlZCB0aGUgc2FtZSBwcm9ibGVtICh3b3JrdHJlZS1sb2NhbCAuZ3NkL1xuICAvLyBwcm9qZWN0aW9uIGxhZ2dpbmcgYmVoaW5kIHByb2plY3Qtcm9vdCBzdGF0ZSkgYnkgbWFpbnRhaW5pbmcgYSBzdGFsZVxuICAvLyBjb3B5LiBOb3cgdGhhdCBhdXRvLW1vZGUgd3JpdGVycyBpbiB3b3JrZmxvdy1wcm9qZWN0aW9ucy50cyxcbiAgLy8gdHJpYWdlLXJlc29sdXRpb24udHMsIHJ1bGUtcmVnaXN0cnkudHMsIGFuZCBhdXRvLXBvc3QtdW5pdC50cyByb3V0ZVxuICAvLyB0aHJvdWdoIHMuY2Fub25pY2FsUHJvamVjdFJvb3QsIHRoZSB3b3JrdHJlZSBuZXZlciBuZWVkcyBhIGxvY2FsXG4gIC8vIC5nc2QvIFx1MjAxNCBib3RoIHJlYWRzIGFuZCB3cml0ZXMgY29udmVyZ2Ugb24gdGhlIHByb2plY3Qtcm9vdCAuZ3NkLy5cbiAgLy8gVGhlIG9yaWdpbmFsIGNvbmNlcm5zICgjNzU5LCAjNzc4KSBubyBsb25nZXIgYXBwbHkgYmVjYXVzZSB0aGVyZSBpc1xuICAvLyBubyBzZWNvbmQgY29weSB0byBkcmlmdC5cblxuICAvLyBSdW4gdXNlci1jb25maWd1cmVkIHBvc3QtY3JlYXRlIGhvb2sgKCM1OTcpIFx1MjAxNCBlLmcuIGNvcHkgLmVudiwgc3ltbGluayBhc3NldHNcbiAgY29uc3QgaG9va0Vycm9yID0gcnVuV29ya3RyZWVQb3N0Q3JlYXRlSG9vayhiYXNlUGF0aCwgaW5mby5wYXRoKTtcbiAgaWYgKGhvb2tFcnJvcikge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgbG9nIGJ1dCBkb24ndCBwcmV2ZW50IHdvcmt0cmVlIHVzYWdlXG4gICAgbG9nV2FybmluZyhcInJlY29uY2lsZVwiLCBob29rRXJyb3IsIHsgd29ya3RyZWU6IGluZm8ubmFtZSB9KTtcbiAgfVxuXG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcblxuICB0cnkge1xuICAgIHByb2Nlc3MuY2hkaXIoaW5mby5wYXRoKTtcbiAgICBzZXRBY3RpdmVXb3Jrc3BhY2UoY3JlYXRlV29ya3NwYWNlKGJhc2VQYXRoKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIElmIGNoZGlyIGZhaWxzLCB0aGUgd29ya3RyZWUgd2FzIGNyZWF0ZWQgYnV0IHdlIGNvdWxkbid0IGVudGVyIGl0LlxuICAgIC8vIERvbid0IHNldCBhY3RpdmVXb3Jrc3BhY2UgLS0gY2FsbGVyIGNhbiByZXRyeSBvciBjbGVhbiB1cC5cbiAgICB0aHJvdyBuZXcgR1NERXJyb3IoXG4gICAgICBHU0RfSU9fRVJST1IsXG4gICAgICBgQXV0by13b3JrdHJlZSBjcmVhdGVkIGF0ICR7aW5mby5wYXRofSBidXQgY2hkaXIgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICk7XG4gIH1cblxuICBudWRnZUdpdEJyYW5jaENhY2hlKHByZXZpb3VzQ3dkKTtcbiAgcmV0dXJuIGluZm8ucGF0aDtcbn1cblxuLy8gUGhhc2UgQzogY29weVBsYW5uaW5nQXJ0aWZhY3RzIHJlbW92ZWQuIFBsYW5uaW5nIGFydGlmYWN0cyBub3cgbGl2ZVxuLy8gb25seSBhdCB0aGUgcHJvamVjdCByb290IC5nc2QvOyBhdXRvLW1vZGUgd3JpdGVycyAod29ya2Zsb3ctcHJvamVjdGlvbnMsXG4vLyB0cmlhZ2UtcmVzb2x1dGlvbiwgcnVsZS1yZWdpc3RyeSwgcmVnZW5lcmF0ZUlmTWlzc2luZyxcbi8vIHJlc29sdmVIb29rQXJ0aWZhY3RQYXRoKSBhbGwgcm91dGUgdGhyb3VnaCBzLmNhbm9uaWNhbFByb2plY3RSb290LlxuLy8gV29ya3RyZWVzIGFyZSBwdXJlIGdpdCBjaGVja291dHMgXHUyMDE0IHRoZXkgbm8gbG9uZ2VyIG1haW50YWluIGEgcGFyYWxsZWxcbi8vIC5nc2QvIHByb2plY3Rpb24uIFRoZSBnc2QuZGIgaGFzIGFsd2F5cyBsaXZlZCBhdCB0aGUgcHJvamVjdCByb290IHZpYVxuLy8gdGhlIHNoYXJlZC1XQUwgUjAxMiBjb250cmFjdDsgdGhhdCBpcyB1bmNoYW5nZWQuXG5cbi8qKlxuICogVGVhcmRvd24gYW4gYXV0by13b3JrdHJlZTogY2hkaXIgYmFjayB0byBvcmlnaW5hbCBiYXNlLCB0aGVuIHJlbW92ZVxuICogdGhlIHdvcmt0cmVlIGFuZCBpdHMgYnJhbmNoLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGVhcmRvd25BdXRvV29ya3RyZWUoXG4gIG9yaWdpbmFsQmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgb3B0czogeyBwcmVzZXJ2ZUJyYW5jaD86IGJvb2xlYW4gfSA9IHt9LFxuKTogdm9pZCB7XG4gIG9yaWdpbmFsQmFzZVBhdGggPSByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdChvcmlnaW5hbEJhc2VQYXRoKTtcblxuICBjb25zdCBicmFuY2ggPSBhdXRvV29ya3RyZWVCcmFuY2gobWlsZXN0b25lSWQpO1xuICBjb25zdCB7IHByZXNlcnZlQnJhbmNoID0gZmFsc2UgfSA9IG9wdHM7XG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcblxuICAvLyBXcmFwIHRoZSBlbnRpcmUgdGVhcmRvd24gYm9keSBpbiBhIHNpbmdsZSB0cnkvZmluYWxseSBzbyBhY3RpdmVXb3Jrc3BhY2VcbiAgLy8gaXMgQUxXQVlTIGNsZWFyZWQgXHUyMDE0IGV2ZW4gaWYgcHJvY2Vzcy5jaGRpciB0aHJvd3MgKGUuZy4gb3JpZ2luYWxCYXNlUGF0aFxuICAvLyB3YXMgZGVsZXRlZCBiZWZvcmUgdGVhcmRvd24gcmFuKS4gUHJldmlvdXNseSB0aGUgZmluYWxseSBvbmx5IGNvdmVyZWRcbiAgLy8gcmVtb3ZlV29ya3RyZWUsIGxlYXZpbmcgdGhlIHJlZ2lzdHJ5IHN0YWxlIG9uIGEgY2hkaXIgZmFpbHVyZSAoSDMgZml4KS5cbiAgdHJ5IHtcbiAgICB0cnkge1xuICAgICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEJhc2VQYXRoKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHRocm93IG5ldyBHU0RFcnJvcihcbiAgICAgICAgR1NEX0lPX0VSUk9SLFxuICAgICAgICBgRmFpbGVkIHRvIGNoZGlyIGJhY2sgdG8gJHtvcmlnaW5hbEJhc2VQYXRofSBkdXJpbmcgdGVhcmRvd246ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIE1pcnJvciBjbGVhbnVwIHN0ZXBzIGZyb20gbWVyZ2VNaWxlc3RvbmVUb01haW4gYWJvcnQgcGF0aDpcblxuICAgIC8vIDEuIFJlbW92ZSB0cmFuc2llbnQgc3RhdGUgZmlsZXMgKFNUQVRFLm1kLCBhdXRvLmxvY2ssIHtNSUR9LU1FVEEuanNvbikuXG4gICAgLy8gICAgTm9uLWZhdGFsIFx1MjAxNCBtdXN0IG5vdCBibG9jayB0ZWFyZG93bi5cbiAgICB0cnkge1xuICAgICAgY2xlYXJQcm9qZWN0Um9vdFN0YXRlRmlsZXMob3JpZ2luYWxCYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBjbGVhclByb2plY3RSb290U3RhdGVGaWxlcyBmYWlsZWQgZHVyaW5nIHRlYXJkb3duOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICB9XG5cbiAgICAvLyAyLiBSZWNvbmNpbGUgd29ya3RyZWUtbG9jYWwgZ3NkLmRiIGludG8gcHJvamVjdCByb290IERCIGlmIGJvdGggZXhpc3QuXG4gICAgLy8gICAgTm9uLWZhdGFsIFx1MjAxNCBoYW5kbGVzIGxlZ2FjeSB3b3JrdHJlZXMgdGhhdCBoYXZlIGEgbG9jYWwgY29weS5cbiAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBjb250cmFjdCA9IHJlc29sdmVHc2RQYXRoQ29udHJhY3QocHJldmlvdXNDd2QsIG9yaWdpbmFsQmFzZVBhdGgpO1xuICAgICAgICBjb25zdCB3b3JrdHJlZURiUGF0aCA9IGpvaW4oY29udHJhY3Qud29ya3RyZWVHc2QgPz8gam9pbihwcmV2aW91c0N3ZCwgXCIuZ3NkXCIpLCBcImdzZC5kYlwiKTtcbiAgICAgICAgY29uc3QgbWFpbkRiUGF0aCA9IGNvbnRyYWN0LnByb2plY3REYjtcbiAgICAgICAgaWYgKF9zaG91bGRSZWNvbmNpbGVXb3JrdHJlZURiKHdvcmt0cmVlRGJQYXRoLCBtYWluRGJQYXRoKSkge1xuICAgICAgICAgIHJlY29uY2lsZVdvcmt0cmVlRGIobWFpbkRiUGF0aCwgd29ya3RyZWVEYlBhdGgpO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgLyogbm9uLWZhdGFsICovXG4gICAgICAgIGxvZ0Vycm9yKFwid29ya3RyZWVcIiwgYERCIHJlY29uY2lsaWF0aW9uIGZhaWxlZCBkdXJpbmcgdGVhcmRvd246ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIG51ZGdlR2l0QnJhbmNoQ2FjaGUocHJldmlvdXNDd2QpO1xuXG4gICAgLy8gMy4gUmVtb3ZlIHRoZSB3b3JrdHJlZS4gRXJyb3JzIHByb3BhZ2F0ZSBuYXR1cmFsbHkgXHUyMDE0IHRoZSBvdXRlciBmaW5hbGx5XG4gICAgLy8gICAgZW5zdXJlcyBhY3RpdmVXb3Jrc3BhY2UgaXMgY2xlYXJlZCByZWdhcmRsZXNzLlxuICAgIHJlbW92ZVdvcmt0cmVlKG9yaWdpbmFsQmFzZVBhdGgsIG1pbGVzdG9uZUlkLCB7XG4gICAgICBicmFuY2gsXG4gICAgICBkZWxldGVCcmFuY2g6ICFwcmVzZXJ2ZUJyYW5jaCxcbiAgICB9KTtcblxuICAgIC8vIFZlcmlmeSBjbGVhbnVwIHN1Y2NlZWRlZCBcdTIwMTQgd2FybiBpZiB0aGUgd29ya3RyZWUgZGlyZWN0b3J5IGlzIHN0aWxsIG9uIGRpc2suXG4gICAgLy8gT24gV2luZG93cywgYmFzaC1iYXNlZCBjbGVhbnVwIGNhbiBzaWxlbnRseSBmYWlsIHdoZW4gcGF0aHMgY29udGFpblxuICAgIC8vIGJhY2tzbGFzaGVzICgjMTQzNiksIGxlYXZpbmcgfjEgR0IrIG9ycGhhbmVkIGRpcmVjdG9yaWVzLlxuICAgIGNvbnN0IHd0RGlyID0gd29ya3RyZWVQYXRoKG9yaWdpbmFsQmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgICBpZiAoZXhpc3RzU3luYyh3dERpcikpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgIFwicmVjb25jaWxlXCIsXG4gICAgICAgIGBXb3JrdHJlZSBkaXJlY3Rvcnkgc3RpbGwgZXhpc3RzIGFmdGVyIHRlYXJkb3duOiAke3d0RGlyfS4gYCArXG4gICAgICAgICAgYFRoaXMgaXMgbGlrZWx5IGFuIG9ycGhhbmVkIGRpcmVjdG9yeSBjb25zdW1pbmcgZGlzayBzcGFjZS4gYCArXG4gICAgICAgICAgYFJlbW92ZSBpdCBtYW51YWxseSB3aXRoOiBybSAtcmYgXCIke3d0RGlyLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKX1cImAsXG4gICAgICAgIHsgd29ya3RyZWU6IG1pbGVzdG9uZUlkIH0sXG4gICAgICApO1xuICAgICAgLy8gQXR0ZW1wdCBhIGRpcmVjdCBmaWxlc3lzdGVtIHJlbW92YWwgYXMgYSBmYWxsYmFjayBcdTIwMTQgYnV0IE9OTFkgaWYgdGhlXG4gICAgICAvLyBwYXRoIGlzIHNhZmVseSBpbnNpZGUgLmdzZC93b3JrdHJlZXMvIHRvIHByZXZlbnQgIzIzNjUgZGF0YSBsb3NzLlxuICAgICAgaWYgKGlzSW5zaWRlV29ya3RyZWVzRGlyKG9yaWdpbmFsQmFzZVBhdGgsIHd0RGlyKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJtU3luYyh3dERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAvLyBOb24tZmF0YWwgXHUyMDE0IHRoZSB3YXJuaW5nIGFib3ZlIHRlbGxzIHRoZSB1c2VyIGhvdyB0byBjbGVhbiB1cFxuICAgICAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgd29ya3RyZWUgZGlyZWN0b3J5IHJlbW92YWwgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICBgW0dTRF0gUkVGVVNJTkcgZmFsbGJhY2sgcm1TeW5jIFx1MjAxNCBwYXRoIGlzIG91dHNpZGUgLmdzZC93b3JrdHJlZXMvOiAke3d0RGlyfWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9IGZpbmFsbHkge1xuICAgIC8vIENsZWFyIG1vZHVsZSBzdGF0ZSB1bmNvbmRpdGlvbmFsbHkgXHUyMDE0IHJlZ2FyZGxlc3Mgb2Ygd2hpY2ggc3RlcCBhYm92ZVxuICAgIC8vIGZhaWxlZC4gQSBzdGFsZSBhY3RpdmVXb3Jrc3BhY2UgY2F1c2VzIGdldEFjdGl2ZUF1dG9Xb3JrdHJlZUNvbnRleHQoKVxuICAgIC8vIHRvIHJldHVybiB3cm9uZyBkYXRhIGZvciBzdWJzZXF1ZW50IG9wZXJhdGlvbnMuXG4gICAgc2V0QWN0aXZlV29ya3NwYWNlKG51bGwpO1xuICB9XG59XG5cbi8qKlxuICogRGV0ZWN0IGlmIHRoZSBwcm9jZXNzIGlzIGN1cnJlbnRseSBpbnNpZGUgYW4gYXV0by13b3JrdHJlZS5cbiAqIFVzZXMgdGhlIGN1cnJlbnQgZGlyZWN0b3J5IHN0cnVjdHVyZSBwbHVzIGdpdCBicmFuY2ggcHJlZml4IHNvIGRldGVjdGlvblxuICogc3RpbGwgd29ya3MgYWZ0ZXIgcHJvY2VzcyByZXN0YXJ0IHdoZW4gbW9kdWxlIHN0YXRlIGhhcyBiZWVuIHJlc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNJbkF1dG9Xb3JrdHJlZShiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHRhcmdldFBhdGggPSBpc0dzZFdvcmt0cmVlUGF0aChiYXNlUGF0aCkgPyBiYXNlUGF0aCA6IHByb2Nlc3MuY3dkKCk7XG4gIGlmICghaXNHc2RXb3JrdHJlZVBhdGgodGFyZ2V0UGF0aCkpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBzdG9yZWRCYXNlID0gZ2V0QXV0b1dvcmt0cmVlT3JpZ2luYWxCYXNlKCk7XG4gIGNvbnN0IHByb2plY3RSb290ID0gcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QoYmFzZVBhdGgsIHN0b3JlZEJhc2UpO1xuICBjb25zdCB0YXJnZXRQcm9qZWN0Um9vdCA9IHJlc29sdmVXb3JrdHJlZVByb2plY3RSb290KHRhcmdldFBhdGgsIHN0b3JlZEJhc2UpO1xuICBpZiAoXG4gICAgbm9ybWFsaXplV29ya3RyZWVQYXRoRm9yQ29tcGFyZShwcm9qZWN0Um9vdCkgIT09XG4gICAgbm9ybWFsaXplV29ya3RyZWVQYXRoRm9yQ29tcGFyZSh0YXJnZXRQcm9qZWN0Um9vdClcbiAgKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBicmFuY2ggPSBuYXRpdmVHZXRDdXJyZW50QnJhbmNoKHRhcmdldFBhdGgpO1xuICAgIHJldHVybiBicmFuY2guc3RhcnRzV2l0aChcIm1pbGVzdG9uZS9cIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIEdldCB0aGUgZmlsZXN5c3RlbSBwYXRoIGZvciBhbiBhdXRvLXdvcmt0cmVlLCBvciBudWxsIGlmIGl0IGRvZXNuJ3QgZXhpc3RcbiAqIG9yIGlzIG5vdCBhIHZhbGlkIGdpdCB3b3JrdHJlZS5cbiAqXG4gKiBWYWxpZGF0ZXMgdGhhdCB0aGUgcGF0aCBpcyBhIHJlYWwgZ2l0IHdvcmt0cmVlIChoYXMgYSAuZ2l0IGZpbGUgd2l0aCBhXG4gKiBnaXRkaXI6IHBvaW50ZXIpIHJhdGhlciB0aGFuIGp1c3QgYSBzdHJheSBkaXJlY3RvcnkuIFRoaXMgcHJldmVudHNcbiAqIG1pcy1kZXRlY3Rpb24gb2YgbGVmdG92ZXIgZGlyZWN0b3JpZXMgYXMgYWN0aXZlIHdvcmt0cmVlcyAoIzY5NSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRBdXRvV29ya3RyZWVQYXRoKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGJhc2VQYXRoID0gcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QoYmFzZVBhdGgpO1xuXG4gIGNvbnN0IHAgPSB3b3JrdHJlZVBhdGgoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgaWYgKCFleGlzdHNTeW5jKHApKSByZXR1cm4gbnVsbDtcblxuICAvLyBWYWxpZGF0ZSB0aGlzIGlzIGEgcmVhbCBnaXQgd29ya3RyZWUsIG5vdCBhIHN0cmF5IGRpcmVjdG9yeS5cbiAgLy8gQSBnaXQgd29ya3RyZWUgaGFzIGEgLmdpdCAqZmlsZSogKG5vdCBkaXJlY3RvcnkpIGNvbnRhaW5pbmcgXCJnaXRkaXI6IDxwYXRoPlwiLlxuICBjb25zdCBnaXRQYXRoID0gam9pbihwLCBcIi5naXRcIik7XG4gIGlmICghZXhpc3RzU3luYyhnaXRQYXRoKSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhnaXRQYXRoLCBcInV0ZjhcIikudHJpbSgpO1xuICAgIGlmICghY29udGVudC5zdGFydHNXaXRoKFwiZ2l0ZGlyOiBcIikpIHJldHVybiBudWxsO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBnZXRBdXRvV29ya3RyZWVQYXRoIC5naXQgcmVhZCBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICByZXR1cm4gcDtcbn1cblxuLyoqXG4gKiBFbnRlciBhbiBleGlzdGluZyBhdXRvLXdvcmt0cmVlIChjaGRpciBpbnRvIGl0LCBzdG9yZSBvcmlnaW5hbEJhc2UpLlxuICogVXNlIGZvciByZXN1bWUgLS0gdGhlIHdvcmt0cmVlIGFscmVhZHkgZXhpc3RzIGZyb20gYSBwcmlvciBjcmVhdGUuXG4gKlxuICogQXRvbWljOiBjaGRpciArIG9yaWdpbmFsQmFzZSB1cGRhdGUgaW4gc2FtZSB0cnkgYmxvY2suXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRlckF1dG9Xb3JrdHJlZShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGJhc2VQYXRoID0gcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QoYmFzZVBhdGgpO1xuXG4gIGNvbnN0IHAgPSB3b3JrdHJlZVBhdGgoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgaWYgKCFleGlzdHNTeW5jKHApKSB7XG4gICAgdGhyb3cgbmV3IEdTREVycm9yKFxuICAgICAgR1NEX0lPX0VSUk9SLFxuICAgICAgYEF1dG8td29ya3RyZWUgZm9yICR7bWlsZXN0b25lSWR9IGRvZXMgbm90IGV4aXN0IGF0ICR7cH1gLFxuICAgICk7XG4gIH1cblxuICAvLyBWYWxpZGF0ZSB0aGlzIGlzIGEgcmVhbCBnaXQgd29ya3RyZWUsIG5vdCBhIHN0cmF5IGRpcmVjdG9yeSAoIzY5NSlcbiAgY29uc3QgZ2l0UGF0aCA9IGpvaW4ocCwgXCIuZ2l0XCIpO1xuICBpZiAoIWV4aXN0c1N5bmMoZ2l0UGF0aCkpIHtcbiAgICB0aHJvdyBuZXcgR1NERXJyb3IoXG4gICAgICBHU0RfR0lUX0VSUk9SLFxuICAgICAgYEF1dG8td29ya3RyZWUgcGF0aCAke3B9IGV4aXN0cyBidXQgaXMgbm90IGEgZ2l0IHdvcmt0cmVlIChubyAuZ2l0KWAsXG4gICAgKTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMoZ2l0UGF0aCwgXCJ1dGY4XCIpLnRyaW0oKTtcbiAgICBpZiAoIWNvbnRlbnQuc3RhcnRzV2l0aChcImdpdGRpcjogXCIpKSB7XG4gICAgICB0aHJvdyBuZXcgR1NERXJyb3IoXG4gICAgICAgIEdTRF9HSVRfRVJST1IsXG4gICAgICAgIGBBdXRvLXdvcmt0cmVlIHBhdGggJHtwfSBoYXMgYSAuZ2l0IGJ1dCBpdCBpcyBub3QgYSB3b3JrdHJlZSBnaXRkaXIgcG9pbnRlcmAsXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKGVyciBpbnN0YW5jZW9mIEVycm9yICYmIGVyci5tZXNzYWdlLmluY2x1ZGVzKFwid29ya3RyZWVcIikpIHRocm93IGVycjtcbiAgICB0aHJvdyBuZXcgR1NERXJyb3IoXG4gICAgICBHU0RfSU9fRVJST1IsXG4gICAgICBgQXV0by13b3JrdHJlZSBwYXRoICR7cH0gZXhpc3RzIGJ1dCAuZ2l0IGlzIHVucmVhZGFibGVgLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBwcmV2aW91c0N3ZCA9IHByb2Nlc3MuY3dkKCk7XG5cbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmNoZGlyKHApO1xuICAgIHNldEFjdGl2ZVdvcmtzcGFjZShjcmVhdGVXb3Jrc3BhY2UoYmFzZVBhdGgpKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgdGhyb3cgbmV3IEdTREVycm9yKFxuICAgICAgR1NEX0lPX0VSUk9SLFxuICAgICAgYEZhaWxlZCB0byBlbnRlciBhdXRvLXdvcmt0cmVlIGF0ICR7cH06ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgKTtcbiAgfVxuXG4gIG51ZGdlR2l0QnJhbmNoQ2FjaGUocHJldmlvdXNDd2QpO1xuICByZXR1cm4gcDtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIG9yaWdpbmFsIHByb2plY3Qgcm9vdCBzdG9yZWQgd2hlbiBlbnRlcmluZyBhbiBhdXRvLXdvcmt0cmVlLlxuICogUmV0dXJucyBudWxsIGlmIG5vdCBjdXJyZW50bHkgaW4gYW4gYXV0by13b3JrdHJlZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEF1dG9Xb3JrdHJlZU9yaWdpbmFsQmFzZSgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGdldEFjdGl2ZVdvcmtzcGFjZSgpPy5wcm9qZWN0Um9vdCA/PyBudWxsO1xufVxuXG4vKipcbiAqIFRlc3Qtb25seSBcdTIwMTQgcmVzZXRzIHRoZSBtb2R1bGUtbGV2ZWwgYGFjdGl2ZVdvcmtzcGFjZWAgcmVnaXN0cnkgYmV0d2VlblxuICogcnVucy4gUHJvZHVjdGlvbiBjb2RlIG5ldmVyIGNsZWFycyB0aGUgcmVnaXN0cnkgZGlyZWN0bHk7IHRlc3RzIGNhbGwgdGhpc1xuICogaW4gYGJlZm9yZUVhY2hgL2BhZnRlckVhY2hgIHRvIGlzb2xhdGUgcmVnaXN0cnktbXV0YXRpbmcgY2FzZXMuIFJlbmFtaW5nXG4gKiB0aGUgdW5kZXJzY29yZS1wcmVmaXhlZCBgXypGb3JUZXN0YCBleHBvcnRzIGl0IGpvaW5zIChzbGljZSA3IC8gc3RlcCBHIG9mXG4gKiBBRFItMDE2KSB3YXMgZGVsaWJlcmF0ZTogdGhvc2Ugd3JhcHBlZCByZWFsIHByb2R1Y3Rpb24gaGVscGVycyBhbmQgbG9zdFxuICogdGhlIHN1ZmZpeDsgdGhpcyBvbmUgc3RheXMgYXMgdGhlIG9ubHkgbGVnaXRpbWF0ZSB0ZXN0LXNjYWZmb2xkaW5nIGV4cG9ydFxuICogYmVjYXVzZSBpdCBoYXMgbm8gcHJvZHVjdGlvbiBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfcmVzZXRBdXRvV29ya3RyZWVPcmlnaW5hbEJhc2VGb3JUZXN0cygpOiB2b2lkIHtcbiAgc2V0QWN0aXZlV29ya3NwYWNlKG51bGwpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlQXV0b1dvcmt0cmVlQ29udGV4dCgpOiB7XG4gIG9yaWdpbmFsQmFzZTogc3RyaW5nO1xuICB3b3JrdHJlZU5hbWU6IHN0cmluZztcbiAgYnJhbmNoOiBzdHJpbmc7XG59IHwgbnVsbCB7XG4gIGNvbnN0IHdzID0gZ2V0QWN0aXZlV29ya3NwYWNlKCk7XG4gIGlmICghd3MpIHJldHVybiBudWxsO1xuICBjb25zdCBvcmlnaW5hbEJhc2UgPSB3cy5wcm9qZWN0Um9vdDtcbiAgY29uc3QgY3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgaWYgKCFpc0dzZFdvcmt0cmVlUGF0aChjd2QpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgY3dkUHJvamVjdFJvb3QgPSByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdChjd2QsIG9yaWdpbmFsQmFzZSk7XG4gIGlmIChcbiAgICBub3JtYWxpemVXb3JrdHJlZVBhdGhGb3JDb21wYXJlKGN3ZFByb2plY3RSb290KSAhPT1cbiAgICBub3JtYWxpemVXb3JrdHJlZVBhdGhGb3JDb21wYXJlKG9yaWdpbmFsQmFzZSlcbiAgKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY29uc3Qgd29ya3RyZWVOYW1lID0gZGV0ZWN0V29ya3RyZWVOYW1lKGN3ZCk7XG4gIGlmICghd29ya3RyZWVOYW1lKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgYnJhbmNoID0gbmF0aXZlR2V0Q3VycmVudEJyYW5jaChjd2QpO1xuICBpZiAoIWJyYW5jaC5zdGFydHNXaXRoKFwibWlsZXN0b25lL1wiKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7XG4gICAgb3JpZ2luYWxCYXNlLFxuICAgIHdvcmt0cmVlTmFtZSxcbiAgICBicmFuY2gsXG4gIH07XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNZXJnZSBNaWxlc3RvbmUgLT4gTWFpbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBBdXRvLWNvbW1pdCBhbnkgZGlydHkgKHVuY29tbWl0dGVkKSBzdGF0ZSBpbiB0aGUgZ2l2ZW4gZGlyZWN0b3J5LlxuICogUmV0dXJucyB0cnVlIGlmIGEgY29tbWl0IHdhcyBtYWRlLCBmYWxzZSBpZiB3b3JraW5nIHRyZWUgd2FzIGNsZWFuLlxuICovXG5mdW5jdGlvbiBhdXRvQ29tbWl0RGlydHlTdGF0ZShjd2Q6IHN0cmluZyk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXR1cyA9IG5hdGl2ZVdvcmtpbmdUcmVlU3RhdHVzKGN3ZCk7XG4gICAgaWYgKCFzdGF0dXMpIHJldHVybiBmYWxzZTtcbiAgICBuYXRpdmVBZGRBbGxXaXRoRXhjbHVzaW9ucyhjd2QsIFJVTlRJTUVfRVhDTFVTSU9OX1BBVEhTKTtcbiAgICBjb25zdCByZXN1bHQgPSBuYXRpdmVDb21taXQoXG4gICAgICBjd2QsXG4gICAgICBcImNob3JlOiBhdXRvLWNvbW1pdCBiZWZvcmUgbWlsZXN0b25lIG1lcmdlXCIsXG4gICAgKTtcbiAgICByZXR1cm4gcmVzdWx0ICE9PSBudWxsO1xuICB9IGNhdGNoIChlKSB7XG4gICAgZGVidWdMb2coXCJhdXRvQ29tbWl0RGlydHlTdGF0ZVwiLCB7IGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgdGhyb3cgbmV3IEdTREVycm9yKFxuICAgICAgR1NEX0dJVF9FUlJPUixcbiAgICAgIGBGYWlsZWQgdG8gYXV0by1jb21taXQgZGlydHkgd29ya3RyZWUgc3RhdGUgYmVmb3JlIG1pbGVzdG9uZSBtZXJnZTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCxcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICogU3F1YXNoLW1lcmdlIHRoZSBtaWxlc3RvbmUgYnJhbmNoIGludG8gbWFpbiB3aXRoIGEgcmljaCBjb21taXQgbWVzc2FnZVxuICogbGlzdGluZyBhbGwgY29tcGxldGVkIHNsaWNlcywgdGhlbiB0ZWFyIGRvd24gdGhlIHdvcmt0cmVlLlxuICpcbiAqIFNlcXVlbmNlOlxuICogIDEuIEF1dG8tY29tbWl0IGRpcnR5IHdvcmt0cmVlIHN0YXRlXG4gKiAgMi4gY2hkaXIgdG8gb3JpZ2luYWxCYXNlUGF0aFxuICogIDMuIGdpdCBjaGVja291dCBtYWluXG4gKiAgNC4gZ2l0IG1lcmdlIC0tc3F1YXNoIG1pbGVzdG9uZS88TUlEPlxuICogIDUuIGdpdCBjb21taXQgd2l0aCByaWNoIG1lc3NhZ2VcbiAqICA2LiBBdXRvLXB1c2ggaWYgZW5hYmxlZFxuICogIDcuIERlbGV0ZSBtaWxlc3RvbmUgYnJhbmNoXG4gKiAgOC4gUmVtb3ZlIHdvcmt0cmVlIGRpcmVjdG9yeVxuICogIDkuIENsZWFyIG9yaWdpbmFsQmFzZVxuICpcbiAqIE9uIG1lcmdlIGNvbmZsaWN0OiB0aHJvd3MgTWVyZ2VDb25mbGljdEVycm9yLlxuICogT24gXCJub3RoaW5nIHRvIGNvbW1pdFwiIGFmdGVyIHNxdWFzaDogc2FmZSBvbmx5IGlmIG1pbGVzdG9uZSB3b3JrIGlzIGFscmVhZHlcbiAqIG9uIHRoZSBpbnRlZ3JhdGlvbiBicmFuY2guICBUaHJvd3MgaWYgdW5hbmNob3JlZCBjb2RlIGNoYW5nZXMgd291bGQgYmUgbG9zdC5cbiAqXG4gKiBAaW50ZXJuYWwgKipEbyBub3QgY2FsbCBkaXJlY3RseS4qKiBUaGlzIGlzIHRoZSBpbm5lciBzcXVhc2gtbWVyZ2UgcHJpbWl0aXZlXG4gKiBmb3IgdGhlIFdvcmt0cmVlIExpZmVjeWNsZSBNb2R1bGUgKEFEUi0wMTYgcGhhc2UgMiAvIEEzLCBpc3N1ZSAjNTYxOSkuXG4gKiBQcm9kdWN0aW9uIGNhbGxlcnMgbXVzdCBnbyB0aHJvdWdoIGBXb3JrdHJlZUxpZmVjeWNsZS5tZXJnZU1pbGVzdG9uZVN0YW5kYWxvbmVgXG4gKiBvciBgV29ya3RyZWVMaWZlY3ljbGUuZXhpdE1pbGVzdG9uZSh7IG1lcmdlOiB0cnVlIH0pYC4gVGhlIGV4cG9ydCBrZXl3b3JkXG4gKiBpcyBwcmVzZXJ2ZWQgb25seSBzbyBgYXV0by50czpidWlsZFdvcmt0cmVlTGlmZWN5Y2xlRGVwcygpYCBjYW4gd2lyZSB0aGlzXG4gKiBmdW5jdGlvbiB0aHJvdWdoIHRoZSBNb2R1bGUncyBkZXBzIHNlYW0gXHUyMDE0IHRoYXQgaXMgdGhlIGNvbnN0cnVjdGlvbiBvZiB0aGVcbiAqIHNlYW0sIG5vdCBhIGJ5cGFzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlTWlsZXN0b25lVG9NYWluKFxuICBvcmlnaW5hbEJhc2VQYXRoXzogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICByb2FkbWFwQ29udGVudDogc3RyaW5nLFxuKTogeyBjb21taXRNZXNzYWdlOiBzdHJpbmc7IHB1c2hlZDogYm9vbGVhbjsgcHJDcmVhdGVkOiBib29sZWFuOyBjb2RlRmlsZXNDaGFuZ2VkOiBib29sZWFuIH0ge1xuICBjb25zdCB3b3JrdHJlZUN3ZCA9IHByb2Nlc3MuY3dkKCk7XG4gIGNvbnN0IG1pbGVzdG9uZUJyYW5jaCA9IGF1dG9Xb3JrdHJlZUJyYW5jaChtaWxlc3RvbmVJZCk7XG5cbiAgLy8gMS4gQXV0by1jb21taXQgZGlydHkgc3RhdGUgYmVmb3JlIGxlYXZpbmcuXG4gIC8vICAgIEd1YXJkOiB3aGVuIHdlIGVudGVyZWQgdGhyb3VnaCBhbiBhdXRvLXdvcmt0cmVlIChvcmlnaW5hbEJhc2UgaXMgc2V0KSxcbiAgLy8gICAgb25seSBhdXRvLWNvbW1pdCB3aGVuIGN3ZCBpcyBvbiB0aGUgbWlsZXN0b25lIGJyYW5jaC4gSW4gcGFyYWxsZWwgbW9kZSxcbiAgLy8gICAgY3dkIG1heSBiZSBvbiB0aGUgaW50ZWdyYXRpb24gYnJhbmNoIGFmdGVyIGEgcHJpb3IgbWVyZ2Unc1xuICAvLyAgICBNZXJnZUNvbmZsaWN0RXJyb3IgbGVmdCBjd2QgdW5yZXN0b3JlZC4gQXV0by1jb21taXR0aW5nIG9uIHRoZVxuICAvLyAgICBpbnRlZ3JhdGlvbiBicmFuY2ggY2FwdHVyZXMgZGlydHkgZmlsZXMgZnJvbSBPVEhFUiBtaWxlc3RvbmVzIHVuZGVyIGFcbiAgLy8gICAgbWlzbGVhZGluZyBjb21taXQgbWVzc2FnZSwgY29udGFtaW5hdGluZyB0aGUgbWFpbiBicmFuY2ggKCMyOTI5KS5cbiAgLy9cbiAgLy8gICAgV2hlbiBhY3RpdmVXb3Jrc3BhY2UgaXMgbnVsbCAoYnJhbmNoIG1vZGUsIG5vIHdvcmt0cmVlKSwgYXV0b0NvbW1pdERpcnR5U3RhdGVcbiAgLy8gICAgcnVucyB1bmNvbmRpdGlvbmFsbHkgXHUyMDE0IHRoZSBjYWxsZXIgaXMgcmVzcG9uc2libGUgZm9yIGN3ZCBwbGFjZW1lbnQuXG4gIHtcbiAgICBsZXQgc2hvdWxkQXV0b0NvbW1pdCA9IHRydWU7XG4gICAgaWYgKGdldEFjdGl2ZVdvcmtzcGFjZSgpICE9PSBudWxsKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBjdXJyZW50QnJhbmNoID0gbmF0aXZlR2V0Q3VycmVudEJyYW5jaCh3b3JrdHJlZUN3ZCk7XG4gICAgICAgIHNob3VsZEF1dG9Db21taXQgPSBjdXJyZW50QnJhbmNoID09PSBtaWxlc3RvbmVCcmFuY2g7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gSWYgd2UgY2FuJ3QgZGV0ZXJtaW5lIHRoZSBicmFuY2gsIHNraXAgdGhlIGF1dG8tY29tbWl0IHRvIGJlIHNhZmVcbiAgICAgICAgc2hvdWxkQXV0b0NvbW1pdCA9IGZhbHNlO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoc2hvdWxkQXV0b0NvbW1pdCkge1xuICAgICAgYXV0b0NvbW1pdERpcnR5U3RhdGUod29ya3RyZWVDd2QpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFJlY29uY2lsZSB3b3JrdHJlZSBEQiBpbnRvIG1haW4gREIgYmVmb3JlIGxlYXZpbmcgd29ya3RyZWUgY29udGV4dC5cbiAgLy8gU2tpcCB3aGVuIGJvdGggcGF0aHMgcmVzb2x2ZSB0byB0aGUgc2FtZSBwaHlzaWNhbCBmaWxlIChzaGFyZWQgV0FMIC9cbiAgLy8gc3ltbGluayBsYXlvdXQpIFx1MjAxNCBBVFRBQ0hpbmcgYSBXQUwtbW9kZSBmaWxlIHRvIGl0c2VsZiBjb3JydXB0cyB0aGVcbiAgLy8gZGF0YWJhc2UgKCMyODIzKS5cbiAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjb250cmFjdCA9IHJlc29sdmVHc2RQYXRoQ29udHJhY3Qod29ya3RyZWVDd2QsIG9yaWdpbmFsQmFzZVBhdGhfKTtcbiAgICAgIGNvbnN0IHdvcmt0cmVlRGJQYXRoID0gam9pbihjb250cmFjdC53b3JrdHJlZUdzZCA/PyBqb2luKHdvcmt0cmVlQ3dkLCBcIi5nc2RcIiksIFwiZ3NkLmRiXCIpO1xuICAgICAgY29uc3QgbWFpbkRiUGF0aCA9IGNvbnRyYWN0LnByb2plY3REYjtcbiAgICAgIGlmIChfc2hvdWxkUmVjb25jaWxlV29ya3RyZWVEYih3b3JrdHJlZURiUGF0aCwgbWFpbkRiUGF0aCkpIHtcbiAgICAgICAgcmVjb25jaWxlV29ya3RyZWVEYihtYWluRGJQYXRoLCB3b3JrdHJlZURiUGF0aCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvKiBub24tZmF0YWwgKi9cbiAgICAgIGxvZ0Vycm9yKFwid29ya3RyZWVcIiwgYERCIHJlY29uY2lsaWF0aW9uIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgfVxuICB9XG5cbiAgLy8gMi4gR2V0IGNvbXBsZXRlZCBzbGljZXMgZm9yIGNvbW1pdCBtZXNzYWdlXG4gIGxldCBjb21wbGV0ZWRTbGljZXM6IHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFza3M6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZyB9PiB9W10gPSBbXTtcbiAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgIGNvbXBsZXRlZFNsaWNlcyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWxlc3RvbmVJZClcbiAgICAgIC5maWx0ZXIocyA9PiBzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKVxuICAgICAgLm1hcChzID0+ICh7XG4gICAgICAgIGlkOiBzLmlkLFxuICAgICAgICB0aXRsZTogc3RyaXBHc2REaXNwbGF5UHJlZml4KHMudGl0bGUsIHMuaWQpID8/IHMuaWQsXG4gICAgICAgIHRhc2tzOiBnZXRTbGljZVRhc2tzKG1pbGVzdG9uZUlkLCBzLmlkKVxuICAgICAgICAgIC5maWx0ZXIoKHRhc2spID0+IHRhc2suc3RhdHVzID09PSBcImNvbXBsZXRlXCIpXG4gICAgICAgICAgLm1hcCgodGFzaykgPT4gKHtcbiAgICAgICAgICAgIGlkOiB0YXNrLmlkLFxuICAgICAgICAgICAgdGl0bGU6IHN0cmlwR3NkRGlzcGxheVByZWZpeCh0YXNrLnRpdGxlLCB0YXNrLmlkKSA/PyB0YXNrLmlkLFxuICAgICAgICAgIH0pKSxcbiAgICAgIH0pKTtcbiAgfVxuICAvLyBGYWxsYmFjazogcGFyc2Ugcm9hZG1hcCBjb250ZW50IHdoZW4gREIgaXMgdW5hdmFpbGFibGVcbiAgaWYgKGNvbXBsZXRlZFNsaWNlcy5sZW5ndGggPT09IDAgJiYgcm9hZG1hcENvbnRlbnQpIHtcbiAgICBjb25zdCBzbGljZVJlID0gLy0gXFxbeFxcXSBcXCpcXCooXFx3Kyk6XFxzKiguKz8pXFwqXFwqL2dpO1xuICAgIGxldCBtOiBSZWdFeHBFeGVjQXJyYXkgfCBudWxsO1xuICAgIHdoaWxlICgobSA9IHNsaWNlUmUuZXhlYyhyb2FkbWFwQ29udGVudCkpICE9PSBudWxsKSB7XG4gICAgICBjb21wbGV0ZWRTbGljZXMucHVzaCh7IGlkOiBtWzFdLCB0aXRsZTogbVsyXSwgdGFza3M6IFtdIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIDMuIGNoZGlyIHRvIG9yaWdpbmFsIGJhc2VcbiAgLy8gTm90ZTogcHJldmlvdXNDd2QgY2FwdHVyZXMgdGhlIGN3ZCBhdCB0aGlzIHBvaW50IFx1MjAxNCBpLmUuIHRoZSB3b3JrdHJlZSBjd2RcbiAgLy8gZW50ZXJpbmcgdGhlIGZ1bmN0aW9uLiBTdWJzZXF1ZW50IHRocm93cyByZXN0b3JlIHRvIHByZXZpb3VzQ3dkLCBsZWF2aW5nXG4gIC8vIHRoZSBjYWxsZXIgaW4gd29ya3RyZWUtY3dkOyBjYWxsZXJzICh3b3JrdHJlZS1yZXNvbHZlcikgYXJlIHJlc3BvbnNpYmxlXG4gIC8vIGZvciBhbnkgZnVydGhlciBjd2QgbW92ZW1lbnQgb24gdGhlIGVycm9yIHBhdGguXG4gIGNvbnN0IHByZXZpb3VzQ3dkID0gcHJvY2Vzcy5jd2QoKTtcbiAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEJhc2VQYXRoXyk7XG5cbiAgLy8gNC4gUmVzb2x2ZSBpbnRlZ3JhdGlvbiBicmFuY2ggXHUyMDE0IHByZWZlciBtaWxlc3RvbmUgbWV0YWRhdGEsIHRoZW4gcHJlZmVyZW5jZXMsXG4gIC8vICAgIHRoZW4gYXV0by1kZXRlY3QgKG9yaWdpbi9IRUFEIFx1MjE5MiBtYWluIFx1MjE5MiBtYXN0ZXIgXHUyMTkyIGN1cnJlbnQpLiBOZXZlciBoYXJkY29kZVxuICAvLyAgICBcIm1haW5cIjogcmVwb3MgdXNpbmcgXCJtYXN0ZXJcIiBvciBhIGN1c3RvbSBkZWZhdWx0IGJyYW5jaCB3b3VsZCBmYWlsIGF0XG4gIC8vICAgIGNoZWNrb3V0IGFuZCBsZWF2ZSB0aGUgdXNlciB3aXRoIGEgYnJva2VuIG1lcmdlIHN0YXRlICgjMTY2OCkuXG4gIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy5naXQgPz8ge307XG4gIGNvbnN0IGludGVncmF0aW9uQnJhbmNoID0gcmVhZEludGVncmF0aW9uQnJhbmNoKFxuICAgIG9yaWdpbmFsQmFzZVBhdGhfLFxuICAgIG1pbGVzdG9uZUlkLFxuICApO1xuICAvLyBWYWxpZGF0ZSBwcmVmcy5tYWluX2JyYW5jaCBleGlzdHMgYmVmb3JlIHVzaW5nIGl0IFx1MjAxNCBhIHN0YWxlIHByZWZlcmVuY2VcbiAgLy8gKGUuZy4gXCJtYXN0ZXJcIiB3aGVuIHJlcG8gdXNlcyBcIm1haW5cIikgY2F1c2VzIG1lcmdlIGZhaWx1cmUgKCMzNTg5KS5cbiAgY29uc3QgdmFsaWRhdGVkUHJlZkJyYW5jaCA9IHByZWZzLm1haW5fYnJhbmNoICYmIG5hdGl2ZUJyYW5jaEV4aXN0cyhvcmlnaW5hbEJhc2VQYXRoXywgcHJlZnMubWFpbl9icmFuY2gpXG4gICAgPyBwcmVmcy5tYWluX2JyYW5jaFxuICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCBtYWluQnJhbmNoID1cbiAgICBpbnRlZ3JhdGlvbkJyYW5jaCA/PyB2YWxpZGF0ZWRQcmVmQnJhbmNoID8/IG5hdGl2ZURldGVjdE1haW5CcmFuY2gob3JpZ2luYWxCYXNlUGF0aF8pO1xuXG4gIC8vIEZhaWwgY2xvc2VkIHdoZW4gdGhlIHJlc29sdmVkIGludGVncmF0aW9uIGJyYW5jaCBpcyB0aGUgbWlsZXN0b25lIGJyYW5jaFxuICAvLyBpdHNlbGYgKCM1MDI0KS4gU3RhbGUgb3IgY29ycnVwdCBtZXRhZGF0YSAoZS5nLiBpbnRlZ3JhdGlvbkJyYW5jaCByZWNvcmRlZFxuICAvLyBhcyBcIm1pbGVzdG9uZS88TUlEPlwiKSB3b3VsZCBvdGhlcndpc2UgbGV0IHRoZSBzcXVhc2ggbWVyZ2UgcmVzb2x2ZSB0byBhXG4gIC8vIHNlbGYtbWVyZ2U6IG5vdGhpbmctdG8tY29tbWl0ICsgZW1wdHkgc2VsZi1kaWZmIGluIHRoZSBwb3N0LW1lcmdlIHNhZmV0eVxuICAvLyBjaGVjayAoIzE3OTIpIGNvbGxhcHNlIHRvIGEgZmFsc2Ugc3VjY2VzcywgYW5kIHRoZSB3b3JrdHJlZS1yZXNvbHZlclxuICAvLyBlbWl0cyB3b3JrdHJlZS1tZXJnZWQgZm9yIHdvcmsgdGhhdCBuZXZlciBsYW5kZWQgb24gYSBkaXN0aW5jdFxuICAvLyBpbnRlZ3JhdGlvbiBicmFuY2guXG4gIGlmIChub3JtYWxpemVMb2NhbEJyYW5jaFJlZihtYWluQnJhbmNoKSA9PT0gbWlsZXN0b25lQnJhbmNoKSB7XG4gICAgcHJvY2Vzcy5jaGRpcihwcmV2aW91c0N3ZCk7XG4gICAgdGhyb3cgbmV3IEdTREVycm9yKFxuICAgICAgR1NEX0dJVF9FUlJPUixcbiAgICAgIGBSZXNvbHZlZCBpbnRlZ3JhdGlvbiBicmFuY2ggXCIke21haW5CcmFuY2h9XCIgaXMgdGhlIHNhbWUgcmVmIGFzIG1pbGVzdG9uZSBicmFuY2ggYCArXG4gICAgICBgXCIke21pbGVzdG9uZUJyYW5jaH1cIiBcdTIwMTQgcmVmdXNpbmcgdG8gc2VsZi1tZXJnZS4gSW50ZWdyYXRpb24gYnJhbmNoIG1ldGFkYXRhIGlzIGludmFsaWQ7IGAgK1xuICAgICAgYHNldCBhIGRpc3RpbmN0IG1haW5fYnJhbmNoIGluIEdTRCBwcmVmZXJlbmNlcyBvciByZXBhaXIgdGhlIG1pbGVzdG9uZSBpbnRlZ3JhdGlvbiByZWNvcmQgYCArXG4gICAgICBgYmVmb3JlIHJldHJ5aW5nIG1pbGVzdG9uZSBjb21wbGV0aW9uLmAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIFJlbW92ZSB0cmFuc2llbnQgcHJvamVjdC1yb290IHN0YXRlIGZpbGVzIGJlZm9yZSBhbnkgYnJhbmNoIG9yIG1lcmdlXG4gIC8vIG9wZXJhdGlvbi4gVW50cmFja2VkIG1pbGVzdG9uZSBtZXRhZGF0YSBjYW4gb3RoZXJ3aXNlIGJsb2NrIHNxdWFzaCBtZXJnZXMuXG4gIGNsZWFyUHJvamVjdFJvb3RTdGF0ZUZpbGVzKG9yaWdpbmFsQmFzZVBhdGhfLCBtaWxlc3RvbmVJZCk7XG5cbiAgLy8gNS4gQ2hlY2tvdXQgaW50ZWdyYXRpb24gYnJhbmNoIChza2lwIGlmIGFscmVhZHkgY3VycmVudCBcdTIwMTQgYXZvaWRzIGdpdCBlcnJvclxuICAvLyAgICB3aGVuIG1haW4gaXMgYWxyZWFkeSBjaGVja2VkIG91dCBpbiB0aGUgcHJvamVjdC1yb290IHdvcmt0cmVlLCAjNzU3KVxuICAvL1xuICAvLyBSZWZ1c2UgdG8gcHJvY2VlZCBpZiB0aGUgcHJvamVjdCByb290IGlzIGluIGRldGFjaGVkIEhFQUQgc3RhdGUuIFNpbGVudGx5XG4gIC8vIHJ1bm5pbmcgYG5hdGl2ZUNoZWNrb3V0QnJhbmNoKG1haW5CcmFuY2gpYCBvbiBhIGRldGFjaGVkIEhFQUQgd291bGRcbiAgLy8gYWJhbmRvbiB0aGUgdXNlcidzIGRlbGliZXJhdGVseS1jaGVja2VkLW91dCBjb21taXQgKG1pZC1iaXNlY3QsIHJldmlld2luZ1xuICAvLyBhIHRhZywgQ0kgY2hlY2tvdXQtc2hhKSB3aXRob3V0IHdhcm5pbmcuIChJc3N1ZSAjNDk4MCBISUdILTEwKVxuICBjb25zdCBjdXJyZW50QnJhbmNoQXRCYXNlID0gbmF0aXZlR2V0Q3VycmVudEJyYW5jaChvcmlnaW5hbEJhc2VQYXRoXyk7XG4gIGlmICghY3VycmVudEJyYW5jaEF0QmFzZSB8fCBjdXJyZW50QnJhbmNoQXRCYXNlLmxlbmd0aCA9PT0gMCkge1xuICAgIHByb2Nlc3MuY2hkaXIocHJldmlvdXNDd2QpO1xuICAgIHRocm93IG5ldyBHU0RFcnJvcihcbiAgICAgIEdTRF9HSVRfRVJST1IsXG4gICAgICBgUHJvamVjdCByb290IGlzIGluIGRldGFjaGVkIEhFQUQgc3RhdGUgXHUyMDE0IGNhbm5vdCBwZXJmb3JtIG1pbGVzdG9uZSBtZXJnZS4gYCArXG4gICAgICBgQ2hlY2tvdXQgYW4gaW50ZWdyYXRpb24gYnJhbmNoIChlLmcuIFxcYGdpdCBjaGVja291dCAke21haW5CcmFuY2h9XFxgKSBiZWZvcmUgcmVzdW1pbmcuYCxcbiAgICApO1xuICB9XG4gIGlmIChjdXJyZW50QnJhbmNoQXRCYXNlICE9PSBtYWluQnJhbmNoKSB7XG4gICAgbmF0aXZlQ2hlY2tvdXRCcmFuY2gob3JpZ2luYWxCYXNlUGF0aF8sIG1haW5CcmFuY2gpO1xuICB9XG5cbiAgLy8gNi4gQnVpbGQgcmljaCBjb21taXQgbWVzc2FnZVxuICBjb25zdCBkYk1pbGVzdG9uZSA9IGdldE1pbGVzdG9uZShtaWxlc3RvbmVJZCk7XG4gIGxldCBtaWxlc3RvbmVUaXRsZSA9IHN0cmlwR3NkRGlzcGxheVByZWZpeChkYk1pbGVzdG9uZT8udGl0bGUsIG1pbGVzdG9uZUlkKSA/PyBcIlwiO1xuICAvLyBGYWxsYmFjazogcGFyc2UgdGl0bGUgZnJvbSByb2FkbWFwIGNvbnRlbnQgaGVhZGVyIChlLmcuIFwiIyBNMDIwOiBCYWNrZW5kIGZvdW5kYXRpb25cIilcbiAgaWYgKCFtaWxlc3RvbmVUaXRsZSAmJiByb2FkbWFwQ29udGVudCkge1xuICAgIGNvbnN0IHRpdGxlTWF0Y2ggPSByb2FkbWFwQ29udGVudC5tYXRjaChuZXcgUmVnRXhwKGBeI1xcXFxzKyR7bWlsZXN0b25lSWR9OlxcXFxzKiguKylgLCBcIm1cIikpO1xuICAgIGlmICh0aXRsZU1hdGNoKSBtaWxlc3RvbmVUaXRsZSA9IHRpdGxlTWF0Y2hbMV0udHJpbSgpO1xuICB9XG4gIG1pbGVzdG9uZVRpdGxlID0gbWlsZXN0b25lVGl0bGUgfHwgbWlsZXN0b25lSWQ7XG4gIGNvbnN0IHN1YmplY3QgPSBgZmVhdDogJHttaWxlc3RvbmVUaXRsZX1gO1xuICBjb25zdCBtaWxlc3RvbmVDb250ZXh0ID0gbWlsZXN0b25lVGl0bGUgPT09IG1pbGVzdG9uZUlkXG4gICAgPyBgTWlsZXN0b25lOiAke21pbGVzdG9uZUlkfWBcbiAgICA6IGBNaWxlc3RvbmU6ICR7bWlsZXN0b25lSWR9IC0gJHttaWxlc3RvbmVUaXRsZX1gO1xuICBsZXQgYm9keSA9IFwiXCI7XG4gIGlmIChjb21wbGV0ZWRTbGljZXMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHNsaWNlTGluZXMgPSBjb21wbGV0ZWRTbGljZXNcbiAgICAgIC5tYXAoKHMpID0+IGAtICR7cy5pZH06ICR7cy50aXRsZX1gKVxuICAgICAgLmpvaW4oXCJcXG5cIik7XG4gICAgY29uc3QgdGFza0xpbmVzID0gY29tcGxldGVkU2xpY2VzXG4gICAgICAuZmxhdE1hcCgocykgPT4gcy50YXNrcy5tYXAoKHRhc2spID0+IGAtICR7cy5pZH0vJHt0YXNrLmlkfTogJHt0YXNrLnRpdGxlfWApKVxuICAgICAgLmpvaW4oXCJcXG5cIik7XG4gICAgY29uc3QgdGFza0Jsb2NrID0gdGFza0xpbmVzID8gYFxcblxcbkNvbXBsZXRlZCB0YXNrczpcXG4ke3Rhc2tMaW5lc31gIDogXCJcIjtcbiAgICBib2R5ID0gYFxcblxcbkNvbXBsZXRlZCBzbGljZXM6XFxuJHtzbGljZUxpbmVzfSR7dGFza0Jsb2NrfVxcblxcbiR7bWlsZXN0b25lQ29udGV4dH1cXG5HU0QtTWlsZXN0b25lOiAke21pbGVzdG9uZUlkfVxcbkJyYW5jaDogJHttaWxlc3RvbmVCcmFuY2h9YDtcbiAgfSBlbHNlIHtcbiAgICBib2R5ID0gYFxcblxcbiR7bWlsZXN0b25lQ29udGV4dH1cXG5HU0QtTWlsZXN0b25lOiAke21pbGVzdG9uZUlkfVxcbkJyYW5jaDogJHttaWxlc3RvbmVCcmFuY2h9YDtcbiAgfVxuICBjb25zdCBjb21taXRNZXNzYWdlID0gc3ViamVjdCArIGJvZHk7XG5cbiAgLy8gNmIuIFJlY29uY2lsZSB3b3JrdHJlZSBIRUFEIHdpdGggbWlsZXN0b25lIGJyYW5jaCByZWYgKCMxODQ2KS5cbiAgLy8gICAgIFdoZW4gdGhlIHdvcmt0cmVlIEhFQUQgZGV0YWNoZXMgYW5kIGFkdmFuY2VzIHBhc3QgdGhlIG5hbWVkIGJyYW5jaCxcbiAgLy8gICAgIHRoZSBicmFuY2ggcmVmIGJlY29tZXMgc3RhbGUuIFNxdWFzaC1tZXJnaW5nIHRoZSBzdGFsZSByZWYgc2lsZW50bHlcbiAgLy8gICAgIG9ycGhhbnMgYWxsIGNvbW1pdHMgYmV0d2VlbiB0aGUgYnJhbmNoIHJlZiBhbmQgdGhlIGFjdHVhbCB3b3JrdHJlZSBIRUFELlxuICAvLyAgICAgRml4OiBmYXN0LWZvcndhcmQgdGhlIGJyYW5jaCByZWYgdG8gdGhlIHdvcmt0cmVlIEhFQUQgYmVmb3JlIG1lcmdpbmcuXG4gIC8vICAgICBPbmx5IGFwcGxpZXMgd2hlbiBtZXJnaW5nIGZyb20gYW4gYWN0dWFsIHdvcmt0cmVlICh3b3JrdHJlZUN3ZCBkaWZmZXJzXG4gIC8vICAgICBmcm9tIG9yaWdpbmFsQmFzZVBhdGhfKS5cbiAgaWYgKHdvcmt0cmVlQ3dkICE9PSBvcmlnaW5hbEJhc2VQYXRoXykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB3b3JrdHJlZUhlYWQgPSBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2LXBhcnNlXCIsIFwiSEVBRFwiXSwge1xuICAgICAgICBjd2Q6IHdvcmt0cmVlQ3dkLFxuICAgICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgICB9KS50cmltKCk7XG4gICAgICBjb25zdCBicmFuY2hIZWFkID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBtaWxlc3RvbmVCcmFuY2hdLCB7XG4gICAgICAgIGN3ZDogb3JpZ2luYWxCYXNlUGF0aF8sXG4gICAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIH0pLnRyaW0oKTtcblxuICAgICAgaWYgKHdvcmt0cmVlSGVhZCAmJiBicmFuY2hIZWFkICYmIHdvcmt0cmVlSGVhZCAhPT0gYnJhbmNoSGVhZCkge1xuICAgICAgICBpZiAobmF0aXZlSXNBbmNlc3RvcihvcmlnaW5hbEJhc2VQYXRoXywgYnJhbmNoSGVhZCwgd29ya3RyZWVIZWFkKSkge1xuICAgICAgICAgIC8vIFdvcmt0cmVlIEhFQUQgaXMgc3RyaWN0bHkgYWhlYWQgXHUyMDE0IGZhc3QtZm9yd2FyZCB0aGUgYnJhbmNoIHJlZlxuICAgICAgICAgIG5hdGl2ZVVwZGF0ZVJlZihcbiAgICAgICAgICAgIG9yaWdpbmFsQmFzZVBhdGhfLFxuICAgICAgICAgICAgYHJlZnMvaGVhZHMvJHttaWxlc3RvbmVCcmFuY2h9YCxcbiAgICAgICAgICAgIHdvcmt0cmVlSGVhZCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGRlYnVnTG9nKFwibWVyZ2VNaWxlc3RvbmVUb01haW5cIiwge1xuICAgICAgICAgICAgYWN0aW9uOiBcImZhc3QtZm9yd2FyZC1icmFuY2gtcmVmXCIsXG4gICAgICAgICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICAgICAgICBvbGRSZWY6IGJyYW5jaEhlYWQuc2xpY2UoMCwgOCksXG4gICAgICAgICAgICBuZXdSZWY6IHdvcmt0cmVlSGVhZC5zbGljZSgwLCA4KSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBEaXZlcmdlZCBcdTIwMTQgZmFpbCBsb3VkbHkgcmF0aGVyIHRoYW4gc2lsZW50bHkgbG9zaW5nIGNvbW1pdHNcbiAgICAgICAgICBwcm9jZXNzLmNoZGlyKHByZXZpb3VzQ3dkKTtcbiAgICAgICAgICB0aHJvdyBuZXcgR1NERXJyb3IoXG4gICAgICAgICAgICBHU0RfR0lUX0VSUk9SLFxuICAgICAgICAgICAgYFdvcmt0cmVlIEhFQUQgKCR7d29ya3RyZWVIZWFkLnNsaWNlKDAsIDgpfSkgZGl2ZXJnZWQgZnJvbSBgICtcbiAgICAgICAgICAgICAgYCR7bWlsZXN0b25lQnJhbmNofSAoJHticmFuY2hIZWFkLnNsaWNlKDAsIDgpfSkuIGAgK1xuICAgICAgICAgICAgICBgTWFudWFsIHJlY29uY2lsaWF0aW9uIHJlcXVpcmVkIGJlZm9yZSBtZXJnZS5gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIC8vIFJlLXRocm93IEdTREVycm9yIChkaXZlcmdlbmNlKTsgc3dhbGxvdyByZXYtcGFyc2UgZmFpbHVyZXNcbiAgICAgIC8vIChlLmcuIHdvcmt0cmVlIGRpciBhbHJlYWR5IHJlbW92ZWQgYnkgZXh0ZXJuYWwgY2xlYW51cClcbiAgICAgIGlmIChlcnIgaW5zdGFuY2VvZiBHU0RFcnJvcikgdGhyb3cgZXJyO1xuICAgICAgZGVidWdMb2coXCJtZXJnZU1pbGVzdG9uZVRvTWFpblwiLCB7XG4gICAgICAgIGFjdGlvbjogXCJyZWNvbmNpbGUtc2tpcHBlZFwiLFxuICAgICAgICByZWFzb246IFN0cmluZyhlcnIpLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gQWxyZWFkeSByZWd1bGFyLW1lcmdlZCBtaWxlc3RvbmVzIGNhbiBza2lwIHRoZSBzcXVhc2ggcGF0aCBhbmQgcHJvY2VlZCB0byBjbGVhbnVwICgjNTgzMSkuXG4gIGlmIChuYXRpdmVJc0FuY2VzdG9yKG9yaWdpbmFsQmFzZVBhdGhfLCBtaWxlc3RvbmVCcmFuY2gsIG1haW5CcmFuY2gpKSB7XG4gICAgY29uc3QgY29kZUNoYW5nZXMgPSBuYXRpdmVEaWZmTnVtc3RhdChcbiAgICAgIG9yaWdpbmFsQmFzZVBhdGhfLFxuICAgICAgbWFpbkJyYW5jaCxcbiAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICApLmZpbHRlcigoZW50cnkpID0+ICFlbnRyeS5wYXRoLnN0YXJ0c1dpdGgoXCIuZ3NkL1wiKSk7XG4gICAgaWYgKGNvZGVDaGFuZ2VzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IHJlZ3VsYXJNZXJnZUNoYW5nZWRQYXRocyA9IGZpbmRSZWd1bGFyTWVyZ2VDaGFuZ2VkUGF0aHMoXG4gICAgICAgIG9yaWdpbmFsQmFzZVBhdGhfLFxuICAgICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICAgIG1haW5CcmFuY2gsXG4gICAgICApO1xuICAgICAgY29uc3QgdW5hbmNob3JlZENvZGVDaGFuZ2VzID0gY29kZUNoYW5nZXMuZmlsdGVyKChlbnRyeSkgPT5cbiAgICAgICAgcmVndWxhck1lcmdlQ2hhbmdlZFBhdGhzLmhhcyhlbnRyeS5wYXRoKVxuICAgICAgKTtcbiAgICAgIGlmICh1bmFuY2hvcmVkQ29kZUNoYW5nZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBwcm9jZXNzLmNoZGlyKHByZXZpb3VzQ3dkKTtcbiAgICAgICAgdGhyb3cgbmV3IEdTREVycm9yKFxuICAgICAgICAgIEdTRF9HSVRfRVJST1IsXG4gICAgICAgICAgYE1pbGVzdG9uZSBicmFuY2ggXCIke21pbGVzdG9uZUJyYW5jaH1cIiBpcyByZWFjaGFibGUgZnJvbSBcIiR7bWFpbkJyYW5jaH1cIiBgICtcbiAgICAgICAgICAgIGBidXQgaGFzICR7dW5hbmNob3JlZENvZGVDaGFuZ2VzLmxlbmd0aH0gbWlsZXN0b25lLXRvdWNoZWQgY29kZSBmaWxlKHMpIG5vdCBvbiBjdXJyZW50IFwiJHttYWluQnJhbmNofVwiLiBgICtcbiAgICAgICAgICAgIGBBYm9ydGluZyB3b3JrdHJlZSB0ZWFyZG93biB0byBwcmV2ZW50IGRhdGEgbG9zcy5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBkZWJ1Z0xvZyhcIm1lcmdlTWlsZXN0b25lVG9NYWluXCIsIHtcbiAgICAgIGFjdGlvbjogXCJza2lwLXNxdWFzaC1hbHJlYWR5LW1lcmdlZFwiLFxuICAgICAgbWlsZXN0b25lSWQsXG4gICAgICBtaWxlc3RvbmVCcmFuY2gsXG4gICAgICBtYWluQnJhbmNoLFxuICAgIH0pO1xuICAgIHRyeSB7XG4gICAgICBjbGVhclByb2plY3RSb290U3RhdGVGaWxlcyhvcmlnaW5hbEJhc2VQYXRoXywgbWlsZXN0b25lSWQpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBjbGVhclByb2plY3RSb290U3RhdGVGaWxlcyBmYWlsZWQgZHVyaW5nIGFscmVhZHktbWVyZ2VkIGNsZWFudXA6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgcmVtb3ZlV29ya3RyZWUob3JpZ2luYWxCYXNlUGF0aF8sIG1pbGVzdG9uZUlkLCB7XG4gICAgICAgIGJyYW5jaDogbWlsZXN0b25lQnJhbmNoLFxuICAgICAgICBkZWxldGVCcmFuY2g6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYHdvcmt0cmVlIHJlbW92YWwgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIG5hdGl2ZUJyYW5jaERlbGV0ZShvcmlnaW5hbEJhc2VQYXRoXywgbWlsZXN0b25lQnJhbmNoKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgZ2l0IGJyYW5jaC1kZWxldGUgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICB9XG4gICAgc2V0QWN0aXZlV29ya3NwYWNlKG51bGwpO1xuICAgIG51ZGdlR2l0QnJhbmNoQ2FjaGUocHJldmlvdXNDd2QpO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQmFzZVBhdGhfKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgY2hkaXIgdG8gcHJvamVjdCByb290IGFmdGVyIGFscmVhZHktbWVyZ2VkIGNsZWFudXAgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgY29tbWl0TWVzc2FnZSwgcHVzaGVkOiBmYWxzZSwgcHJDcmVhdGVkOiBmYWxzZSwgY29kZUZpbGVzQ2hhbmdlZDogdHJ1ZSB9O1xuICB9XG5cbiAgLy8gNy4gU2hlbHRlciBxdWV1ZWQgbWlsZXN0b25lIGRpcmVjdG9yaWVzIGJlZm9yZSB0aGUgc3F1YXNoIG1lcmdlICgjMjUwNSkuXG4gIC8vIFRoZSBtaWxlc3RvbmUgYnJhbmNoIG1heSBjb250YWluIGNvcGllcyBvZiBxdWV1ZWQgbWlsZXN0b25lIGRpcnMgKHZpYVxuICAvLyBjb3B5UGxhbm5pbmdBcnRpZmFjdHMpLCBzbyBgZ2l0IG1lcmdlIC0tc3F1YXNoYCByZWplY3RzIHdoZW4gdGhvc2Ugc2FtZVxuICAvLyBmaWxlcyBleGlzdCBhcyB1bnRyYWNrZWQgaW4gdGhlIHdvcmtpbmcgdHJlZS4gVGVtcG9yYXJpbHkgbW92ZSB0aGVtIHRvXG4gIC8vIGEgYmFja3VwIGxvY2F0aW9uLCB0aGVuIHJlc3RvcmUgYWZ0ZXIgdGhlIG1lcmdlK2NvbW1pdC5cbiAgLy9cbiAgLy8gTVVTVCBydW4gQkVGT1JFIHRoZSBwcmUtbWVyZ2Ugc3Rhc2ggKHN0ZXAgN2EpIHNvIGAtLWluY2x1ZGUtdW50cmFja2VkYFxuICAvLyBkb2VzIG5vdCBzd2VlcCBxdWV1ZWQgQ09OVEVYVCBmaWxlcyBpbnRvIHRoZSBzdGFzaC4gSWYgc3Rhc2ggcG9wIGxhdGVyXG4gIC8vIGZhaWxzLCBmaWxlcyB0cmFwcGVkIGluc2lkZSB0aGUgc3Rhc2ggYXJlIHBlcm1hbmVudGx5IGxvc3QgKCMyNTA1KS5cbiAgY29uc3QgbWlsZXN0b25lc0RpciA9IGpvaW4oZ3NkUm9vdChvcmlnaW5hbEJhc2VQYXRoXyksIFwibWlsZXN0b25lc1wiKTtcbiAgY29uc3Qgc2hlbHRlckRpciA9IGpvaW4oZ3NkUm9vdChvcmlnaW5hbEJhc2VQYXRoXyksIFwiLm1pbGVzdG9uZS1zaGVsdGVyXCIpO1xuICBjb25zdCBzaGVsdGVyZWREaXJzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgc2hlbHRlclJlc3RvcmVkID0gZmFsc2U7XG5cbiAgLy8gSGVscGVyOiByZXN0b3JlIHNoZWx0ZXJlZCBtaWxlc3RvbmUgZGlyZWN0b3JpZXMgKCMyNTA1KS5cbiAgLy8gQ2FsbGVkIG9uIGJvdGggc3VjY2VzcyBhbmQgZXJyb3IgcGF0aHMgdG8gZW5zdXJlIHF1ZXVlZCBDT05URVhUIGZpbGVzXG4gIC8vIGFyZSBuZXZlciBwZXJtYW5lbnRseSBsb3N0LiBJZGVtcG90ZW50IFx1MjAxNCB0aGUgZXJyb3IgcGF0aCBtYXkgZmlyZSBhZnRlclxuICAvLyB0aGUgc3VjY2VzcyBwYXRoIGhhcyBhbHJlYWR5IHJlc3RvcmVkIGFuZCByZW1vdmVkIHRoZSBzaGVsdGVyIGRpcjsgYVxuICAvLyBzZWNvbmQgY2FsbCBpcyBhIG5vLW9wIGluc3RlYWQgb2YgbG9nZ2luZyBhIG1pc2xlYWRpbmcgXCJzaGVsdGVyIHJlc3RvcmVcbiAgLy8gZmFpbGVkOiBFTk9FTlRcIiBlcnJvciBmb3Igc2hlbHRlciBzb3VyY2VzIHRoYXQgd2VyZSBjbGVhbmVkIHVwIGxlZ2l0aW1hdGVseS5cbiAgY29uc3QgcmVzdG9yZVNoZWx0ZXIgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKHNoZWx0ZXJSZXN0b3JlZCkgcmV0dXJuO1xuICAgIHNoZWx0ZXJSZXN0b3JlZCA9IHRydWU7XG4gICAgaWYgKHNoZWx0ZXJlZERpcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgbGV0IHJlc3RvcmVGYWlsZWQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IGRpck5hbWUgb2Ygc2hlbHRlcmVkRGlycykge1xuICAgICAgY29uc3Qgc3JjID0gam9pbihzaGVsdGVyRGlyLCBkaXJOYW1lKTtcbiAgICAgIC8vIElmIHRoZSBzaGVsdGVyIHNvdXJjZSBpcyBtaXNzaW5nIHRoZSByZXN0b3JlIGNhbm5vdCBwcm9jZWVkIGZvciB0aGlzXG4gICAgICAvLyBlbnRyeS4gRGlzdGluZ3Vpc2ggXCJsZWdpdGltYXRlbHkgbWlzc2luZ1wiIChzaGVsdGVyIGRpciByZW1vdmVkIGJ5IGFcbiAgICAgIC8vIHByaW9yIHN1Y2Nlc3NmdWwgcmVzdG9yZSBvciBuZXZlciBjb3BpZWQpIGZyb20gYSBzdXJwcmlzaW5nIEVOT0VOVFxuICAgICAgLy8gaW5zaWRlIGFuIG90aGVyd2lzZS1wb3B1bGF0ZWQgc2hlbHRlci5cbiAgICAgIGlmICghZXhpc3RzU3luYyhzcmMpKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgICAgXCJ3b3JrdHJlZVwiLFxuICAgICAgICAgIGBzaGVsdGVyIHNvdXJjZSBtaXNzaW5nIGZvciAke2Rpck5hbWV9OyBza2lwcGluZyByZXN0b3JlIChzaGVsdGVyIGFscmVhZHkgY2xlYW5lZCBvciBlbnRyeSBuZXZlciBzdGFnZWQpYCxcbiAgICAgICAgKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICBta2RpclN5bmMobWlsZXN0b25lc0RpciwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICAgIGNwU3luYyhzcmMsIGpvaW4obWlsZXN0b25lc0RpciwgZGlyTmFtZSksIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgIH0gY2F0Y2ggKGVycikgeyAvKiBiZXN0LWVmZm9ydCAqL1xuICAgICAgICByZXN0b3JlRmFpbGVkID0gdHJ1ZTtcbiAgICAgICAgbG9nRXJyb3IoXCJ3b3JrdHJlZVwiLCBgc2hlbHRlciByZXN0b3JlIGZhaWxlZCAoJHtkaXJOYW1lfSk6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgfVxuICAgIH1cbiAgICAvLyBQcmVzZXJ2ZSB0aGUgc2hlbHRlciBpZiBhbnkgcGVyLWVudHJ5IHJlc3RvcmUgZmFpbGVkIFx1MjAxNCBpdCBpcyB0aGUgb25seVxuICAgIC8vIHN1cnZpdmluZyBjb3B5IG9mIHRoZSBxdWV1ZWQgbWlsZXN0b25lIGRpcnMgKHNvdXJjZXMgd2VyZSBkZWxldGVkIGR1cmluZ1xuICAgIC8vIHNoZWx0ZXIpLiBEZWxldGluZyBpdCBoZXJlIHdvdWxkIHBlcm1hbmVudGx5IGxvc2UgdGhvc2UgZmlsZXMgKCMyNTA1KS5cbiAgICBpZiAocmVzdG9yZUZhaWxlZCkge1xuICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBzaGVsdGVyIHJldGFpbmVkIGF0ICR7c2hlbHRlckRpcn0gXHUyMDE0IG1hbnVhbCByZWNvdmVyeSByZXF1aXJlZCBmb3IgdW5yZXN0b3JlZCBlbnRyaWVzYCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChleGlzdHNTeW5jKHNoZWx0ZXJEaXIpKSB7XG4gICAgICB0cnkgeyBybVN5bmMoc2hlbHRlckRpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pOyB9IGNhdGNoIChlcnIpIHsgLyogYmVzdC1lZmZvcnQgKi9cbiAgICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBzaGVsdGVyIGNsZWFudXAgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH07XG5cbiAgdHJ5IHtcbiAgICBpZiAoZXhpc3RzU3luYyhtaWxlc3RvbmVzRGlyKSkge1xuICAgICAgY29uc3QgZW50cmllcyA9IHJlYWRkaXJTeW5jKG1pbGVzdG9uZXNEaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KTtcbiAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICBpZiAoIWVudHJ5LmlzRGlyZWN0b3J5KCkpIGNvbnRpbnVlO1xuICAgICAgICAvLyBPbmx5IHNoZWx0ZXIgZGlyZWN0b3JpZXMgdGhhdCBkbyBOT1QgYmVsb25nIHRvIHRoZSBtaWxlc3RvbmUgYmVpbmcgbWVyZ2VkXG4gICAgICAgIGlmIChlbnRyeS5uYW1lID09PSBtaWxlc3RvbmVJZCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHNyY0RpciA9IGpvaW4obWlsZXN0b25lc0RpciwgZW50cnkubmFtZSk7XG4gICAgICAgIGNvbnN0IGRzdERpciA9IGpvaW4oc2hlbHRlckRpciwgZW50cnkubmFtZSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbWtkaXJTeW5jKHNoZWx0ZXJEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgIGNwU3luYyhzcmNEaXIsIGRzdERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICAgIHJtU3luYyhzcmNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAgICAgICBzaGVsdGVyZWREaXJzLnB1c2goZW50cnkubmFtZSk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgaWYgc2hlbHRlciBmYWlscywgdGhlIG1lcmdlIG1heSBzdGlsbCBzdWNjZWVkXG4gICAgICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBtaWxlc3RvbmUgc2hlbHRlciBmYWlsZWQgKCR7ZW50cnkubmFtZX0pOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBwcm9jZWVkIHdpdGggbWVyZ2U7IHVudHJhY2tlZCBmaWxlcyBtYXkgYmxvY2sgaXRcbiAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYG1pbGVzdG9uZSBzaGVsdGVyIG9wZXJhdGlvbiBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICB9XG5cbiAgLy8gN2EuIFN0YXNoIHByZS1leGlzdGluZyBkaXJ0eSBmaWxlcyBzbyB0aGUgc3F1YXNoIG1lcmdlIGlzIG5vdCBibG9ja2VkIGJ5XG4gIC8vICAgICB1bnJlbGF0ZWQgbG9jYWwgY2hhbmdlcyAoIzIxNTEpLiBJbmNsdWRlcyB1bnRyYWNrZWQgZmlsZXMgdG8gaGFuZGxlXG4gIC8vICAgICBsb2NhbGx5LWFkZGVkIGZpbGVzIHRoYXQgY29uZmxpY3Qgd2l0aCB0cmFja2VkIGZpbGVzIG9uIHRoZSBtaWxlc3RvbmVcbiAgLy8gICAgIGJyYW5jaC4gUGFzc2luZyBOTyBwYXRoc3BlYyBsZXRzIGdpdCBza2lwIGdpdGlnbm9yZWQgcGF0aHMgc2lsZW50bHk7XG4gIC8vICAgICBhZGRpbmcgYW4gZXhwbGljaXQgcGF0aHNwZWMgdHJpcHMgYSBgZ2l0IGFkZGAtc3R5bGUgZmF0YWwgb24gaWdub3JlZFxuICAvLyAgICAgZW50cmllcyAoZS5nLiBhIGdpdGlnbm9yZWQgYC5nc2RgIHN5bWxpbmsgdW5kZXIgQURSLTAwMikgKCM0NTczKS5cbiAgLy8gICAgIFF1ZXVlZCBDT05URVhUIGZpbGVzIHVuZGVyIGAuZ3NkL21pbGVzdG9uZXMvKmAgYXJlIGFscmVhZHkgc2hlbHRlcmVkXG4gIC8vICAgICBpbiBzdGVwIDcgYWJvdmUsIHNvIHRoZXkgd29uJ3QgYmUgc3dlcHQgaW50byB0aGUgc3Rhc2guXG4gIC8vIE9uIFdpbmRvd3MsIFNRTGl0ZSBob2xkcyBtYW5kYXRvcnkgZmlsZSBsb2NrcyBvbiB0aGUgZ3NkLmRiIFdBTC9TSE1cbiAgLy8gc2lkZWNhcnMgd2hpbGUgdGhlIGNvbm5lY3Rpb24gaXMgb3Blbi4gYGdpdCBzdGFzaCAtLWluY2x1ZGUtdW50cmFja2VkYFxuICAvLyB3YWxrcyB0aG9zZSBmaWxlcyBhbmQgZmFpbHMgd2l0aCBFQlVTWSAoIzQ3MDQpLiBDbG9zZSB0aGUgREIgYmVmb3JlXG4gIC8vIHN0YXNoaW5nIHNvIFdpbmRvd3MgcmVsZWFzZXMgdGhlIGhhbmRsZXM7IHJlb3BlbiBhZnRlci4gTm8tb3Agb25cbiAgLy8gUE9TSVgsIHdoZXJlIGFkdmlzb3J5IGxvY2tzIGRvbid0IGJsb2NrIGdpdC5cbiAgY29uc3QgbmVlZHNEYkN5Y2xlID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiICYmIGlzRGJBdmFpbGFibGUoKTtcbiAgY29uc3QgZGJQYXRoVG9SZW9wZW4gPSBuZWVkc0RiQ3ljbGUgPyBnZXREYlBhdGgoKSA6IG51bGw7XG4gIGlmIChuZWVkc0RiQ3ljbGUpIHtcbiAgICB0cnkge1xuICAgICAgY2xvc2VEYXRhYmFzZSgpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBwcmUtc3Rhc2ggZGIgY2xvc2UgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICB9XG4gIH1cblxuICBsZXQgc3Rhc2hlZCA9IGZhbHNlO1xuICAvLyBFbWJlZCBhIHVuaXF1ZSBtYXJrZXIgaW4gdGhlIHN0YXNoIG1lc3NhZ2Ugc28gc3Vic2VxdWVudCBwb3AvZHJvcCB0YXJnZXRzXG4gIC8vIHRoZSBlbnRyeSB3ZSBjcmVhdGVkLCBub3Qgd2hhdGV2ZXIgaGFwcGVucyB0byBiZSBhdCBzdGFzaEB7MH0gKGNvbmN1cnJlbnRcbiAgLy8gbWlsZXN0b25lIG1lcmdlcyBzaGFyZSB0aGUgcHJvamVjdC1yb290IHN0YXNoIGxpc3QgYW5kIGNhbiBzaGlmdCBwb3NpdGlvbnMpLlxuICAvLyAoSXNzdWUgIzQ5ODAgSElHSC02KVxuICBsZXQgc3Rhc2hNYXJrZXI6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHN0YXR1cyA9IGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJzdGF0dXNcIiwgXCItLXBvcmNlbGFpblwiXSwge1xuICAgICAgY3dkOiBvcmlnaW5hbEJhc2VQYXRoXyxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgfSkudHJpbSgpO1xuICAgIGlmIChzdGF0dXMpIHtcbiAgICAgIHN0YXNoTWFya2VyID0gYGdzZC1wcmUtbWVyZ2U6JHttaWxlc3RvbmVJZH06JHtwcm9jZXNzLnBpZH06JHtEYXRlLm5vdygpfToke3Byb2Nlc3MuaHJ0aW1lLmJpZ2ludCgpLnRvU3RyaW5nKDM2KX1gO1xuICAgICAgZXhlY0ZpbGVTeW5jKFxuICAgICAgICBcImdpdFwiLFxuICAgICAgICBbXCJzdGFzaFwiLCBcInB1c2hcIiwgXCItLWluY2x1ZGUtdW50cmFja2VkXCIsIFwiLW1cIiwgYGdzZDogcHJlLW1lcmdlIHN0YXNoIGZvciAke21pbGVzdG9uZUlkfSBbJHtzdGFzaE1hcmtlcn1dYF0sXG4gICAgICAgIHsgY3dkOiBvcmlnaW5hbEJhc2VQYXRoXywgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0sXG4gICAgICApO1xuICAgICAgc3Rhc2hlZCA9IHRydWU7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBTdGFzaCBmYWlsdXJlIGlzIG5vbi1mYXRhbCBcdTIwMTQgcHJvY2VlZCB3aXRob3V0IHN0YXNoIGFuZCBsZXQgdGhlIG1lcmdlXG4gICAgLy8gcmVwb3J0IHRoZSBkaXJ0eSB0cmVlIGlmIGl0IGZhaWxzLlxuICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgZ2l0IHN0YXNoIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cblxuICBpZiAobmVlZHNEYkN5Y2xlICYmIGRiUGF0aFRvUmVvcGVuKSB7XG4gICAgdHJ5IHtcbiAgICAgIG9wZW5EYXRhYmFzZShkYlBhdGhUb1Jlb3Blbik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYHBvc3Qtc3Rhc2ggZGIgcmVvcGVuIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgfVxuICB9XG5cbiAgLy8gN2IuIENsZWFuIHVwIHN0YWxlIG1lcmdlIHN0YXRlIGJlZm9yZSBhdHRlbXB0aW5nIHNxdWFzaCBtZXJnZSAoIzI5MTIpLlxuICAvLyBBIGxlZnRvdmVyIE1FUkdFX0hFQUQgKGZyb20gYSBwcmV2aW91cyBmYWlsZWQgbWVyZ2UsIGxpYmdpdDIgbmF0aXZlIHBhdGgsXG4gIC8vIG9yIGludGVycnVwdGVkIG9wZXJhdGlvbikgY2F1c2VzIGBnaXQgbWVyZ2UgLS1zcXVhc2hgIHRvIHJlZnVzZSB3aXRoXG4gIC8vIFwiZmF0YWw6IFlvdSBoYXZlIG5vdCBjb25jbHVkZWQgeW91ciBtZXJnZSAoTUVSR0VfSEVBRCBleGlzdHMpXCIuXG4gIC8vIERlZmVuc2l2ZWx5IHJlbW92ZSBtZXJnZSBhcnRpZmFjdHMgYmVmb3JlIHN0YXJ0aW5nLlxuICByZW1vdmVNZXJnZVN0YXRlRmlsZXMob3JpZ2luYWxCYXNlUGF0aF8sIFwicHJlLW1lcmdlXCIpO1xuXG4gIC8vIDguIFNxdWFzaCBtZXJnZSBcdTIwMTQgYXV0by1yZXNvbHZlIC5nc2QvIHN0YXRlIGZpbGUgY29uZmxpY3RzICgjNTMwKVxuICBjb25zdCBtZXJnZVJlc3VsdCA9IG5hdGl2ZU1lcmdlU3F1YXNoKG9yaWdpbmFsQmFzZVBhdGhfLCBtaWxlc3RvbmVCcmFuY2gpO1xuXG4gIGlmICghbWVyZ2VSZXN1bHQuc3VjY2Vzcykge1xuICAgIC8vIERpcnR5IHdvcmtpbmcgdHJlZSBcdTIwMTQgdGhlIG1lcmdlIHdhcyByZWplY3RlZCBiZWZvcmUgaXQgc3RhcnRlZCAoZS5nLlxuICAgIC8vIHVudHJhY2tlZCAuZ3NkLyBmaWxlcyBsZWZ0IGJ5IHN5bmNTdGF0ZVRvUHJvamVjdFJvb3QpLiAgUHJlc2VydmUgdGhlXG4gICAgLy8gbWlsZXN0b25lIGJyYW5jaCBzbyBjb21taXRzIGFyZSBub3QgbG9zdC5cbiAgICBpZiAobWVyZ2VSZXN1bHQuY29uZmxpY3RzLmluY2x1ZGVzKFwiX19kaXJ0eV93b3JraW5nX3RyZWVfX1wiKSkge1xuICAgICAgLy8gRGVmZW5zaXZlbHkgY2xlYW4gbWVyZ2Ugc3RhdGUgXHUyMDE0IHRoZSBuYXRpdmUgcGF0aCBtYXkgbGVhdmUgTUVSR0VfSEVBRFxuICAgICAgLy8gZXZlbiB3aGVuIHRoZSBtZXJnZSBpcyByZWplY3RlZCAoIzI5MTIpLlxuICAgICAgcmVtb3ZlTWVyZ2VTdGF0ZUZpbGVzKG9yaWdpbmFsQmFzZVBhdGhfLCBcImRpcnR5LXRyZWUgcmVqZWN0aW9uXCIpO1xuXG4gICAgICAvLyBQb3Agc3Rhc2ggYmVmb3JlIHRocm93aW5nIHNvIGxvY2FsIHdvcmsgaXMgbm90IGxvc3QuXG4gICAgICBpZiAoc3Rhc2hlZCkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBvcFN0YXNoQnlSZWYob3JpZ2luYWxCYXNlUGF0aF8sIHN0YXNoTWFya2VyKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7IC8qIHN0YXNoIHBvcCBjb25mbGljdCBpcyBub24tZmF0YWwgKi9cbiAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYGdpdCBzdGFzaCBwb3AgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmVzdG9yZVNoZWx0ZXIoKTtcbiAgICAgIC8vIFJlc3RvcmUgY3dkIHNvIHRoZSBjYWxsZXIgaXMgbm90IHN0cmFuZGVkIG9uIHRoZSBpbnRlZ3JhdGlvbiBicmFuY2hcbiAgICAgIHByb2Nlc3MuY2hkaXIocHJldmlvdXNDd2QpO1xuICAgICAgLy8gU3VyZmFjZSB0aGUgYWN0dWFsIGRpcnR5IGZpbGVuYW1lcyBmcm9tIGdpdCBzdGRlcnIgaW5zdGVhZCBvZlxuICAgICAgLy8gZ2VuZXJpY2FsbHkgYmxhbWluZyAuZ3NkLyAoIzIxNTEpLlxuICAgICAgY29uc3QgZmlsZUxpc3QgPSBtZXJnZVJlc3VsdC5kaXJ0eUZpbGVzPy5sZW5ndGhcbiAgICAgICAgPyBgRGlydHkgZmlsZXM6XFxuJHttZXJnZVJlc3VsdC5kaXJ0eUZpbGVzLm1hcCgoZikgPT4gYCAgJHtmfWApLmpvaW4oXCJcXG5cIil9YFxuICAgICAgICA6IGBDaGVjayBcXGBnaXQgc3RhdHVzXFxgIGluIHRoZSBwcm9qZWN0IHJvb3QgZm9yIGRldGFpbHMuYDtcbiAgICAgIHRocm93IG5ldyBHU0RFcnJvcihcbiAgICAgICAgR1NEX0dJVF9FUlJPUixcbiAgICAgICAgYFNxdWFzaCBtZXJnZSBvZiAke21pbGVzdG9uZUJyYW5jaH0gcmVqZWN0ZWQ6IHdvcmtpbmcgdHJlZSBoYXMgZGlydHkgb3IgdW50cmFja2VkIGZpbGVzIGAgK1xuICAgICAgICAgIGB0aGF0IGNvbmZsaWN0IHdpdGggdGhlIG1lcmdlLiAke2ZpbGVMaXN0fWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGZvciBjb25mbGljdHMgXHUyMDE0IHVzZSBtZXJnZSByZXN1bHQgZmlyc3QsIGZhbGwgYmFjayB0byBuYXRpdmVDb25mbGljdEZpbGVzXG4gICAgY29uc3QgY29uZmxpY3RlZEZpbGVzID1cbiAgICAgIG1lcmdlUmVzdWx0LmNvbmZsaWN0cy5sZW5ndGggPiAwXG4gICAgICAgID8gbWVyZ2VSZXN1bHQuY29uZmxpY3RzXG4gICAgICAgIDogbmF0aXZlQ29uZmxpY3RGaWxlcyhvcmlnaW5hbEJhc2VQYXRoXyk7XG5cbiAgICBpZiAoY29uZmxpY3RlZEZpbGVzLmxlbmd0aCA+IDApIHtcbiAgICAgIC8vIFNlcGFyYXRlIGF1dG8tcmVzb2x2YWJsZSBjb25mbGljdHMgKEdTRCBzdGF0ZSBmaWxlcyArIGJ1aWxkIGFydGlmYWN0cylcbiAgICAgIC8vIGZyb20gcmVhbCBjb2RlIGNvbmZsaWN0cy4gR1NEIHN0YXRlIGZpbGVzIGRpdmVyZ2UgYmV0d2VlbiBicmFuY2hlc1xuICAgICAgLy8gZHVyaW5nIG5vcm1hbCBvcGVyYXRpb24uIEJ1aWxkIGFydGlmYWN0cyBhcmUgbWFjaGluZS1nZW5lcmF0ZWQgYW5kXG4gICAgICAvLyByZWdlbmVyYWJsZS4gQm90aCBhcmUgc2FmZSB0byBhY2NlcHQgZnJvbSB0aGUgbWlsZXN0b25lIGJyYW5jaC5cbiAgICAgIGNvbnN0IGF1dG9SZXNvbHZhYmxlID0gY29uZmxpY3RlZEZpbGVzLmZpbHRlcihpc1NhZmVUb0F1dG9SZXNvbHZlKTtcbiAgICAgIGNvbnN0IGNvZGVDb25mbGljdHMgPSBjb25mbGljdGVkRmlsZXMuZmlsdGVyKFxuICAgICAgICAoZikgPT4gIWlzU2FmZVRvQXV0b1Jlc29sdmUoZiksXG4gICAgICApO1xuXG4gICAgICAvLyBBdXRvLXJlc29sdmUgc2FmZSBjb25mbGljdHMgYnkgYWNjZXB0aW5nIHRoZSBtaWxlc3RvbmUgYnJhbmNoIHZlcnNpb25cbiAgICAgIGlmIChhdXRvUmVzb2x2YWJsZS5sZW5ndGggPiAwKSB7XG4gICAgICAgIGZvciAoY29uc3Qgc2FmZUZpbGUgb2YgYXV0b1Jlc29sdmFibGUpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbmF0aXZlQ2hlY2tvdXRUaGVpcnMob3JpZ2luYWxCYXNlUGF0aF8sIFtzYWZlRmlsZV0pO1xuICAgICAgICAgICAgbmF0aXZlQWRkUGF0aHMob3JpZ2luYWxCYXNlUGF0aF8sIFtzYWZlRmlsZV0pO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIElmIGNoZWNrb3V0IC0tdGhlaXJzIGZhaWxzLCB0cnkgcmVtb3ZpbmcgdGhlIGZpbGUgZnJvbSB0aGUgbWVyZ2VcbiAgICAgICAgICAgIC8vIChpdCdzIGEgcnVudGltZSBmaWxlIHRoYXQgc2hvdWxkbid0IGJlIGNvbW1pdHRlZCBhbnl3YXkpXG4gICAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYGNoZWNrb3V0IC0tdGhlaXJzIGZhaWxlZCBmb3IgJHtzYWZlRmlsZX0sIHJlbW92aW5nOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgICAgICAgbmF0aXZlUm1Gb3JjZShvcmlnaW5hbEJhc2VQYXRoXywgW3NhZmVGaWxlXSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIElmIHRoZXJlIGFyZSBzdGlsbCByZWFsIGNvZGUgY29uZmxpY3RzLCBlc2NhbGF0ZVxuICAgICAgaWYgKGNvZGVDb25mbGljdHMubGVuZ3RoID4gMCkge1xuICAgICAgICBjbGVhbnVwU3F1YXNoQ29uZmxpY3RTdGF0ZShvcmlnaW5hbEJhc2VQYXRoXyk7XG5cbiAgICAgICAgLy8gUG9wIHN0YXNoIGJlZm9yZSB0aHJvd2luZyBzbyBsb2NhbCB3b3JrIGlzIG5vdCBsb3N0ICgjMjE1MSkuXG4gICAgICAgIGlmIChzdGFzaGVkKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHBvcFN0YXNoQnlSZWYob3JpZ2luYWxCYXNlUGF0aF8sIHN0YXNoTWFya2VyKTtcbiAgICAgICAgICB9IGNhdGNoIChlcnIpIHsgLyogc3Rhc2ggcG9wIGNvbmZsaWN0IGlzIG5vbi1mYXRhbCAqL1xuICAgICAgICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBnaXQgc3Rhc2ggcG9wIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJlc3RvcmVTaGVsdGVyKCk7XG4gICAgICAgIC8vIFJlc3RvcmUgY3dkIHNvIHRoZSBjYWxsZXIgaXMgbm90IHN0cmFuZGVkIG9uIHRoZSBpbnRlZ3JhdGlvbiBicmFuY2guXG4gICAgICAgIC8vIFdpdGhvdXQgdGhpcywgdGhlIG5leHQgbWVyZ2VNaWxlc3RvbmVUb01haW4gY2FsbCBpbiBhIHBhcmFsbGVsIG1lcmdlXG4gICAgICAgIC8vIHNlcXVlbmNlIHVzZXMgcHJvY2Vzcy5jd2QoKSAobm93IHRoZSBwcm9qZWN0IHJvb3QpIGFzIHdvcmt0cmVlQ3dkLFxuICAgICAgICAvLyBjYXVzaW5nIGF1dG9Db21taXREaXJ0eVN0YXRlIHRvIGNvbW1pdCB1bnJlbGF0ZWQgbWlsZXN0b25lIGZpbGVzIHRvXG4gICAgICAgIC8vIHRoZSBpbnRlZ3JhdGlvbiBicmFuY2ggKCMyOTI5KS5cbiAgICAgICAgcHJvY2Vzcy5jaGRpcihwcmV2aW91c0N3ZCk7XG4gICAgICAgIHRocm93IG5ldyBNZXJnZUNvbmZsaWN0RXJyb3IoXG4gICAgICAgICAgY29kZUNvbmZsaWN0cyxcbiAgICAgICAgICBcInNxdWFzaFwiLFxuICAgICAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICAgICAgICBtYWluQnJhbmNoLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICAvLyBObyBjb25mbGljdHMgZGV0ZWN0ZWQgXHUyMDE0IHBvc3NpYmx5IFwiYWxyZWFkeSB1cCB0byBkYXRlXCIsIGZhbGwgdGhyb3VnaCB0byBjb21taXRcbiAgfVxuXG4gIC8vIDkuIENvbW1pdCAoaGFuZGxlIG5vdGhpbmctdG8tY29tbWl0IGdyYWNlZnVsbHkpXG4gIGNvbnN0IGNvbW1pdFJlc3VsdCA9IG5hdGl2ZUNvbW1pdChvcmlnaW5hbEJhc2VQYXRoXywgY29tbWl0TWVzc2FnZSk7XG4gIGNvbnN0IG5vdGhpbmdUb0NvbW1pdCA9IGNvbW1pdFJlc3VsdCA9PT0gbnVsbDtcblxuICAvLyA5YS4gQ2xlYW4gdXAgbWVyZ2Ugc3RhdGUgZmlsZXMgbGVmdCBieSBnaXQgbWVyZ2UgLS1zcXVhc2ggKCMxODUzLCAjMjkxMikuXG4gIC8vIGdpdCBvbmx5IHJlbW92ZXMgU1FVQVNIX01TRyB3aGVuIHRoZSBjb21taXQgcmVhZHMgaXQgZGlyZWN0bHkgKHBsYWluXG4gIC8vIGBnaXQgY29tbWl0YCkuICBuYXRpdmVDb21taXQgdXNlcyBgLUYgLWAgKHN0ZGluKSBvciBsaWJnaXQyLCBuZWl0aGVyXG4gIC8vIG9mIHdoaWNoIHRyaWdnZXIgZ2l0J3MgU1FVQVNIX01TRyBjbGVhbnVwLiAgTUVSR0VfSEVBRCBpcyBjcmVhdGVkIGJ5XG4gIC8vIGxpYmdpdDIncyBtZXJnZSBldmVuIGluIHNxdWFzaCBtb2RlIGFuZCBpcyBub3QgcmVtb3ZlZCBieSBuYXRpdmVDb21taXQuXG4gIC8vIElmIGxlZnQgb24gZGlzaywgZG9jdG9yIHJlcG9ydHMgYGNvcnJ1cHRfbWVyZ2Vfc3RhdGVgIG9uIGV2ZXJ5IHN1YnNlcXVlbnQgcnVuLlxuICByZW1vdmVNZXJnZVN0YXRlRmlsZXMob3JpZ2luYWxCYXNlUGF0aF8sIFwicG9zdC1jb21taXRcIik7XG5cbiAgLy8gOWEtaWkuIFJlc3RvcmUgc3Rhc2hlZCBmaWxlcyBub3cgdGhhdCB0aGUgbWVyZ2UrY29tbWl0IGlzIGNvbXBsZXRlICgjMjE1MSkuXG4gIC8vIFBvcCBhZnRlciBjb21taXQgc28gc3Rhc2hlZCBjaGFuZ2VzIGRvIG5vdCBpbnRlcmZlcmUgd2l0aCB0aGUgc3F1YXNoIG1lcmdlXG4gIC8vIG9yIHRoZSBjb21taXQgY29udGVudC4gIENvbmZsaWN0IG9uIHBvcCBpcyBub24tZmF0YWwgXHUyMDE0IHRoZSBzdGFzaCBlbnRyeSBpc1xuICAvLyBwcmVzZXJ2ZWQgYW5kIHRoZSB1c2VyIGNhbiByZXNvbHZlIG1hbnVhbGx5IHdpdGggYGdpdCBzdGFzaCBwb3BgLlxuICBpZiAoc3Rhc2hlZCkge1xuICAgIGxldCBzdGFzaFJlZkZvckRyb3A6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBzdGFzaFJlZkZvckRyb3AgPSBwb3BTdGFzaEJ5UmVmKG9yaWdpbmFsQmFzZVBhdGhfLCBzdGFzaE1hcmtlcik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgc3Rhc2hSZWZGb3JEcm9wID0gc3Rhc2hSZWZGcm9tRXJyb3IoZSk7XG4gICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYGdpdCBzdGFzaCBwb3AgZmFpbGVkLCBhdHRlbXB0aW5nIGNvbmZsaWN0IHJlc29sdXRpb246ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAvLyBTdGFzaCBwb3AgYWZ0ZXIgc3F1YXNoIG1lcmdlIGNhbiBjb25mbGljdCBvbiAuZ3NkLyBzdGF0ZSBmaWxlcyB0aGF0XG4gICAgICAvLyBkaXZlcmdlZCBiZXR3ZWVuIGJyYW5jaGVzLiAgTGVmdCB1bnJlc29sdmVkLCB0aGVzZSBVVSBlbnRyaWVzIGJsb2NrXG4gICAgICAvLyBldmVyeSBzdWJzZXF1ZW50IG1lcmdlLiAgQXV0by1yZXNvbHZlIHRoZW0gdGhlIHNhbWUgd2F5IHdlIGhhbmRsZVxuICAgICAgLy8gLmdzZC8gY29uZmxpY3RzIGR1cmluZyB0aGUgbWVyZ2UgaXRzZWxmOiBhY2NlcHQgSEVBRCAodGhlIGp1c3QtY29tbWl0dGVkXG4gICAgICAvLyB2ZXJzaW9uKSBhbmQgZHJvcCB0aGUgbm93LWFwcGxpZWQgc3Rhc2guXG4gICAgICBjb25zdCB1dSA9IG5hdGl2ZUNvbmZsaWN0RmlsZXMob3JpZ2luYWxCYXNlUGF0aF8pO1xuICAgICAgY29uc3QgZ3NkVVUgPSB1dS5maWx0ZXIoKGYpID0+IGYuc3RhcnRzV2l0aChcIi5nc2QvXCIpKTtcbiAgICAgIGNvbnN0IG5vbkdzZFVVID0gdXUuZmlsdGVyKChmKSA9PiAhZi5zdGFydHNXaXRoKFwiLmdzZC9cIikpO1xuXG4gICAgICBpZiAoZ3NkVVUubGVuZ3RoID4gMCkge1xuICAgICAgICBmb3IgKGNvbnN0IGYgb2YgZ3NkVVUpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgLy8gQWNjZXB0IHRoZSBjb21taXR0ZWQgKEhFQUQpIHZlcnNpb24gb2YgdGhlIHN0YXRlIGZpbGVcbiAgICAgICAgICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVja291dFwiLCBcIkhFQURcIiwgXCItLVwiLCBmXSwge1xuICAgICAgICAgICAgICBjd2Q6IG9yaWdpbmFsQmFzZVBhdGhfLFxuICAgICAgICAgICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICAgICAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIG5hdGl2ZUFkZFBhdGhzKG9yaWdpbmFsQmFzZVBhdGhfLCBbZl0pO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIExhc3QgcmVzb3J0OiByZW1vdmUgdGhlIGNvbmZsaWN0ZWQgc3RhdGUgZmlsZVxuICAgICAgICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBjaGVja291dCBIRUFEIGZhaWxlZCBmb3IgJHtmfSwgcmVtb3Zpbmc6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAgICAgICBuYXRpdmVSbUZvcmNlKG9yaWdpbmFsQmFzZVBhdGhfLCBbZl0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoZ3NkVVUubGVuZ3RoID4gMCAmJiBub25Hc2RVVS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgLy8gQWxsIGNvbmZsaWN0cyB3ZXJlIC5nc2QvIGZpbGVzIFx1MjAxNCBzYWZlIHRvIGRyb3AgdGhlIHN0YXNoXG4gICAgICAgIGlmIChzdGFzaFJlZkZvckRyb3ApIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInN0YXNoXCIsIFwiZHJvcFwiLCBzdGFzaFJlZkZvckRyb3BdLCB7XG4gICAgICAgICAgICAgIGN3ZDogb3JpZ2luYWxCYXNlUGF0aF8sXG4gICAgICAgICAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgICAgICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gY2F0Y2ggKGVycikgeyAvKiBzdGFzaCBtYXkgYWxyZWFkeSBiZSBjb25zdW1lZCAqL1xuICAgICAgICAgICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGBnaXQgc3Rhc2ggZHJvcCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgXCJyZWNvcmRlZCBzdGFzaCBlbnRyeSBjb3VsZCBub3QgYmUgcmVzb2x2ZWQ7IHNraXBwaW5nIGF1dG9tYXRpYyBkcm9wXCIpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKG5vbkdzZFVVLmxlbmd0aCA+IDApIHtcbiAgICAgICAgLy8gTm9uLS5nc2QgY29uZmxpY3RzIHJlbWFpbiBcdTIwMTQgbGVhdmUgc3Rhc2ggZm9yIG1hbnVhbCByZXNvbHV0aW9uXG4gICAgICAgIGxvZ1dhcm5pbmcoXCJyZWNvbmNpbGVcIiwgXCJTdGFzaCBwb3AgY29uZmxpY3Qgb24gbm9uLS5nc2QgZmlsZXMgYWZ0ZXIgbWVyZ2VcIiwge1xuICAgICAgICAgIGZpbGVzOiBub25Hc2RVVS5qb2luKFwiLCBcIiksXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9nV2FybmluZyhcbiAgICAgICAgICBcIndvcmt0cmVlXCIsXG4gICAgICAgICAgXCJnaXQgc3Rhc2ggcG9wIGZhaWxlZCB3aXRob3V0IHJlc29sdmFibGUgY29uZmxpY3QgZmlsZXM7IGxlYXZpbmcgc3Rhc2ggZm9yIG1hbnVhbCByZWNvdmVyeVwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIDlhLWlpaS4gUmVzdG9yZSBzaGVsdGVyZWQgcXVldWVkIG1pbGVzdG9uZSBkaXJlY3RvcmllcyAoIzI1MDUpLlxuICByZXN0b3JlU2hlbHRlcigpO1xuXG4gIC8vIDliLiBTYWZldHkgY2hlY2sgKCMxNzkyKTogaWYgbm90aGluZyB3YXMgY29tbWl0dGVkLCB2ZXJpZnkgdGhlIG1pbGVzdG9uZVxuICAvLyB3b3JrIGlzIGFscmVhZHkgb24gdGhlIGludGVncmF0aW9uIGJyYW5jaCBiZWZvcmUgYWxsb3dpbmcgdGVhcmRvd24uXG4gIC8vIENvbXBhcmUgb25seSBub24tLmdzZC8gcGF0aHMgXHUyMDE0IC5nc2QvIHN0YXRlIGZpbGVzIGRpdmVyZ2Ugbm9ybWFsbHkgYW5kXG4gIC8vIGFyZSBhdXRvLXJlc29sdmVkIGR1cmluZyB0aGUgc3F1YXNoIG1lcmdlLlxuICBpZiAobm90aGluZ1RvQ29tbWl0KSB7XG4gICAgY29uc3QgbnVtc3RhdCA9IG5hdGl2ZURpZmZOdW1zdGF0KFxuICAgICAgb3JpZ2luYWxCYXNlUGF0aF8sXG4gICAgICBtYWluQnJhbmNoLFxuICAgICAgbWlsZXN0b25lQnJhbmNoLFxuICAgICk7XG4gICAgY29uc3QgY29kZUNoYW5nZXMgPSBudW1zdGF0LmZpbHRlcihcbiAgICAgIChlbnRyeSkgPT4gIWVudHJ5LnBhdGguc3RhcnRzV2l0aChcIi5nc2QvXCIpLFxuICAgICk7XG4gICAgaWYgKGNvZGVDaGFuZ2VzLmxlbmd0aCA+IDApIHtcbiAgICAgIC8vIE1pbGVzdG9uZSBoYXMgdW5hbmNob3JlZCBjb2RlIGNoYW5nZXMgXHUyMDE0IGFib3J0IHRlYXJkb3duLlxuICAgICAgcHJvY2Vzcy5jaGRpcihwcmV2aW91c0N3ZCk7XG4gICAgICB0aHJvdyBuZXcgR1NERXJyb3IoXG4gICAgICAgIEdTRF9HSVRfRVJST1IsXG4gICAgICAgIGBTcXVhc2ggbWVyZ2UgcHJvZHVjZWQgbm90aGluZyB0byBjb21taXQgYnV0IG1pbGVzdG9uZSBicmFuY2ggXCIke21pbGVzdG9uZUJyYW5jaH1cIiBgICtcbiAgICAgICAgICBgaGFzICR7Y29kZUNoYW5nZXMubGVuZ3RofSBjb2RlIGZpbGUocykgbm90IG9uIFwiJHttYWluQnJhbmNofVwiLiBgICtcbiAgICAgICAgICBgQWJvcnRpbmcgd29ya3RyZWUgdGVhcmRvd24gdG8gcHJldmVudCBkYXRhIGxvc3MuYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgLy8gOWMuIERldGVjdCB3aGV0aGVyIGFueSBub24tLmdzZC8gY29kZSBmaWxlcyB3ZXJlIGFjdHVhbGx5IG1lcmdlZCAoIzE5MDYpLlxuICAvLyBXaGVuIGEgbWlsZXN0b25lIG9ubHkgcHJvZHVjZWQgLmdzZC8gbWV0YWRhdGEgKHN1bW1hcmllcywgcm9hZG1hcHMpIGJ1dCBub1xuICAvLyByZWFsIGNvZGUsIHRoZSB1c2VyIHNlZXMgXCJtaWxlc3RvbmUgY29tcGxldGVcIiBidXQgbm90aGluZyBjaGFuZ2VkIGluIHRoZWlyXG4gIC8vIGNvZGViYXNlLiBTdXJmYWNlIHRoaXMgc28gdGhlIGNhbGxlciBjYW4gd2FybiB0aGUgdXNlci5cbiAgLy9cbiAgLy8gQnVnICM0Mzg1IGZpeDogdXNlIGBnaXQgZGlmZi10cmVlIC0tcm9vdGAgaW5zdGVhZCBvZiBgZ2l0IGRpZmYgSEVBRH4xIEhFQURgLlxuICAvLyBgSEVBRH4xYCBkb2VzIG5vdCBleGlzdCBvbiBpbml0aWFsIGNvbW1pdHMgYW5kIGlzIHVucmVsaWFibGUgb24gc2hhbGxvdyBjbG9uZXNcbiAgLy8gYW5kIG1lcmdlIGNvbW1pdHMuIGBkaWZmLXRyZWUgLS1yb290YCBoYW5kbGVzIGFsbCB0aHJlZSBjYXNlcyBjb3JyZWN0bHkuXG4gIC8vIFRoZSBlbXB0eS10cmVlIGhhc2ggKDRiODI1ZGNcdTIwMjYpIGlzIHRoZSB1bml2ZXJzYWwgZmFsbGJhY2sgZm9yIHJlZnMgdGhhdCBkb24ndCBleGlzdC5cbiAgY29uc3QgR0lUX0VNUFRZX1RSRUUgPSBcIjRiODI1ZGM2NDJjYjZlYjlhMDYwZTU0YmY4ZDY5Mjg4ZmJlZTQ5MDRcIjtcbiAgbGV0IGNvZGVGaWxlc0NoYW5nZWQgPSBmYWxzZTtcbiAgaWYgKCFub3RoaW5nVG9Db21taXQpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgZGlmZlRyZWVPdXRwdXQgPSBleGVjRmlsZVN5bmMoXG4gICAgICAgIFwiZ2l0XCIsXG4gICAgICAgIFtcImRpZmYtdHJlZVwiLCBcIi0tcm9vdFwiLCBcIi0tbm8tY29tbWl0LWlkXCIsIFwiLXJcIiwgXCItLW5hbWUtb25seVwiLCBcIkhFQURcIl0sXG4gICAgICAgIHsgY3dkOiBvcmlnaW5hbEJhc2VQYXRoXywgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0sXG4gICAgICApLnRyaW0oKTtcbiAgICAgIGNvbnN0IG1lcmdlZEZpbGVzID0gZGlmZlRyZWVPdXRwdXQgPyBkaWZmVHJlZU91dHB1dC5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbikgOiBbXTtcbiAgICAgIGNvZGVGaWxlc0NoYW5nZWQgPSBtZXJnZWRGaWxlcy5zb21lKChmKSA9PiAhZi5zdGFydHNXaXRoKFwiLmdzZC9cIikpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIC8vIGRpZmYtdHJlZSBmYWlsZWQgKGUuZy4gdW5ib3JuIEhFQUQgaW4gYSBicmFuZC1uZXcgcmVwbykgXHUyMDE0IGZhbGwgYmFjayB0b1xuICAgICAgLy8gY29tcGFyaW5nIGFnYWluc3QgdGhlIGVtcHR5IHRyZWUgc28gaW5pdGlhbC1jb21taXQgcmVwb3Mgc3RpbGwgcmVwb3J0IGNoYW5nZXMuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBmYWxsYmFja091dHB1dCA9IGV4ZWNGaWxlU3luYyhcbiAgICAgICAgICBcImdpdFwiLFxuICAgICAgICAgIFtcImRpZmZcIiwgXCItLW5hbWUtb25seVwiLCBHSVRfRU1QVFlfVFJFRSwgXCJIRUFEXCJdLFxuICAgICAgICAgIHsgY3dkOiBvcmlnaW5hbEJhc2VQYXRoXywgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0sXG4gICAgICAgICkudHJpbSgpO1xuICAgICAgICBjb25zdCBmYWxsYmFja0ZpbGVzID0gZmFsbGJhY2tPdXRwdXQgPyBmYWxsYmFja091dHB1dC5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbikgOiBbXTtcbiAgICAgICAgY29kZUZpbGVzQ2hhbmdlZCA9IGZhbGxiYWNrRmlsZXMuc29tZSgoZikgPT4gIWYuc3RhcnRzV2l0aChcIi5nc2QvXCIpKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBUcnVseSB1bmFibGUgdG8gZGV0ZXJtaW5lIFx1MjAxNCBhc3N1bWUgY29kZSB3YXMgY2hhbmdlZCB0byBhdm9pZCBzaWxlbnQgZGF0YSBsb3NzXG4gICAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgZGlmZi10cmVlIGFuZCBlbXB0eS10cmVlIGZhbGxiYWNrIGJvdGggZmFpbGVkIChhc3N1bWluZyBjb2RlIGNoYW5nZWQpOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgICBjb2RlRmlsZXNDaGFuZ2VkID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyAxMC4gQXV0by1wdXNoIGlmIGVuYWJsZWRcbiAgbGV0IHB1c2hlZCA9IGZhbHNlO1xuICBpZiAocHJlZnMuYXV0b19wdXNoID09PSB0cnVlICYmIHByZWZzLmF1dG9fcHIgIT09IHRydWUgJiYgIW5vdGhpbmdUb0NvbW1pdCkge1xuICAgIGNvbnN0IHJlbW90ZSA9IHByZWZzLnJlbW90ZSA/PyBcIm9yaWdpblwiO1xuICAgIGlmIChnaXRSZW1vdGVFeGlzdHMob3JpZ2luYWxCYXNlUGF0aF8sIHJlbW90ZSkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJwdXNoXCIsIHJlbW90ZSwgbWFpbkJyYW5jaF0sIHtcbiAgICAgICAgICBjd2Q6IG9yaWdpbmFsQmFzZVBhdGhfLFxuICAgICAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgcHVzaGVkID0gdHJ1ZTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAvLyBQdXNoIGZhaWx1cmUgaXMgbm9uLWZhdGFsXG4gICAgICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgZ2l0IHB1c2ggZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyA5Yi4gQXV0by1jcmVhdGUgUFIgaWYgZW5hYmxlZCAoIzIzMDI6IG5vIGxvbmdlciBnYXRlZCBvbiBwdXNoZWQvYXV0b19wdXNoKVxuICBsZXQgcHJDcmVhdGVkID0gZmFsc2U7XG4gIGlmIChwcmVmcy5hdXRvX3ByID09PSB0cnVlICYmICFub3RoaW5nVG9Db21taXQpIHtcbiAgICBjb25zdCByZW1vdGUgPSBwcmVmcy5yZW1vdGUgPz8gXCJvcmlnaW5cIjtcbiAgICBjb25zdCBwclRhcmdldCA9IHByZWZzLnByX3RhcmdldF9icmFuY2ggPz8gbWFpbkJyYW5jaDtcbiAgICBpZiAoZ2l0UmVtb3RlRXhpc3RzKG9yaWdpbmFsQmFzZVBhdGhfLCByZW1vdGUpKSB7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBQdXNoIHRoZSBtaWxlc3RvbmUgYnJhbmNoIHRvIHJlbW90ZSBmaXJzdFxuICAgICAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicHVzaFwiLCByZW1vdGUsIG1pbGVzdG9uZUJyYW5jaF0sIHtcbiAgICAgICAgICBjd2Q6IG9yaWdpbmFsQmFzZVBhdGhfLFxuICAgICAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgcHJFdmlkZW5jZSA9IGJ1aWxkUHJFdmlkZW5jZSh7XG4gICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgbWlsZXN0b25lVGl0bGUsXG4gICAgICAgICAgY2hhbmdlVHlwZTogXCJmZWF0XCIsXG4gICAgICAgICAgc3VtbWFyaWVzOiBjb21wbGV0ZWRTbGljZXMubWFwKChzbGljZSkgPT4gYCMjIyAke3NsaWNlLmlkfVxcbiR7c2xpY2UudGl0bGV9YCksXG4gICAgICAgICAgdGVzdHNSdW46IFtcIkF1dG8tY3JlYXRlZCBhZnRlciBtaWxlc3RvbmUgbWVyZ2UuIFJ1biBgbnBtIHJ1biB2ZXJpZnk6cHJgIGJlZm9yZSBtYXJraW5nIHRoaXMgZHJhZnQgcmVhZHkuXCJdLFxuICAgICAgICAgIHJvbGxiYWNrTm90ZXM6IFtcIkNsb3NlIHRoZSBkcmFmdCBQUiBvciByZXZlcnQgdGhlIG1lcmdlIGNvbW1pdCBpZiByZXZpZXcgZmluZHMgYSBiZWhhdmlvciByZWdyZXNzaW9uLlwiXSxcbiAgICAgICAgICBob3c6IFwiR2VuZXJhdGVkIGJ5IGdpdC5hdXRvX3ByIGFmdGVyIHRoZSBtaWxlc3RvbmUgYnJhbmNoIHdhcyBwdXNoZWQgYW5kIG1lcmdlZCBsb2NhbGx5LlwiLFxuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgcHJVcmwgPSBjcmVhdGVEcmFmdFBSKG9yaWdpbmFsQmFzZVBhdGhfLCBtaWxlc3RvbmVJZCwgcHJFdmlkZW5jZS50aXRsZSwgcHJFdmlkZW5jZS5ib2R5LCB7XG4gICAgICAgICAgaGVhZDogbWlsZXN0b25lQnJhbmNoLFxuICAgICAgICAgIGJhc2U6IHByVGFyZ2V0LFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFwclVybCkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcImdoIHByIGNyZWF0ZSByZXR1cm5lZCBubyBVUkxcIik7XG4gICAgICAgIH1cbiAgICAgICAgcHJDcmVhdGVkID0gdHJ1ZTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAvLyBQUiBjcmVhdGlvbiBmYWlsdXJlIGlzIG5vbi1mYXRhbCBcdTIwMTQgZ2ggbWF5IG5vdCBiZSBpbnN0YWxsZWQgb3IgYXV0aGVudGljYXRlZFxuICAgICAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYFBSIGNyZWF0aW9uIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gMTEuIEd1YXJkIHJlbW92ZWQgXHUyMDE0IHN0ZXAgOWIgKCMxNzkyKSBub3cgaGFuZGxlcyB0aGlzIHdpdGggYSBzbWFydGVyIGNoZWNrOlxuICAvLyAgICAgdGhyb3dzIG9ubHkgd2hlbiB0aGUgbWlsZXN0b25lIGhhcyB1bmFuY2hvcmVkIGNvZGUgY2hhbmdlcywgcGFzc2VzXG4gIC8vICAgICB0aHJvdWdoIHdoZW4gdGhlIGNvZGUgaXMgZ2VudWluZWx5IGFscmVhZHkgb24gdGhlIGludGVncmF0aW9uIGJyYW5jaC5cblxuICAvLyAxMWEuIFByZS10ZWFyZG93biBzYWZldHkgbmV0ICgjMTg1Myk6IGlmIHRoZSB3b3JrdHJlZSBzdGlsbCBoYXMgdW5jb21taXR0ZWRcbiAgLy8gY2hhbmdlcyAoZS5nLiBuYXRpdmVIYXNDaGFuZ2VzIGNhY2hlIHJldHVybmVkIHN0YWxlIGZhbHNlKSwgYWJvcnQgdGVhcmRvd24uXG4gIC8vIENvbW1pdHRpbmcgaGVyZSB3b3VsZCBiZSB0b28gbGF0ZTogdGhlIHNxdWFzaCBtZXJnZSB0byB0aGUgaW50ZWdyYXRpb25cbiAgLy8gYnJhbmNoIGFscmVhZHkgaGFwcGVuZWQsIHNvIGEgbmV3IG1pbGVzdG9uZS1icmFuY2ggY29tbWl0IHdvdWxkIG5vdCBiZVxuICAvLyBpbmNsdWRlZCBhbmQgYnJhbmNoIGRlbGV0aW9uIGNvdWxkIGRyb3AgdGhlIG9ubHkgcmVmIHRvIHRoYXQgd29yay5cbiAgLy9cbiAgLy8gR3VhcmQ6IG9ubHkgcnVuIHdoZW4gd29ya3RyZWVDd2QgaXMgb24gdGhlIG1pbGVzdG9uZSBicmFuY2ggKCMyOTI5KS5cbiAgLy8gSW4gcGFyYWxsZWwgbW9kZSBvciBicmFuY2gtbW9kZSBtZXJnZXMsIHdvcmt0cmVlQ3dkIG1heSBiZSB0aGUgcHJvamVjdFxuICAvLyByb290IG9uIHRoZSBpbnRlZ3JhdGlvbiBicmFuY2guIENvbW1pdHRpbmcgZGlydHkgc3RhdGUgdGhlcmUgd291bGRcbiAgLy8gY2FwdHVyZSB1bnJlbGF0ZWQgZmlsZXMgZnJvbSBvdGhlciBtaWxlc3RvbmVzLlxuICBpZiAoZXhpc3RzU3luYyh3b3JrdHJlZUN3ZCkpIHtcbiAgICBsZXQgcHJlVGVhcmRvd25CcmFuY2g6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgIHRyeSB7XG4gICAgICBwcmVUZWFyZG93bkJyYW5jaCA9IG5hdGl2ZUdldEN1cnJlbnRCcmFuY2god29ya3RyZWVDd2QpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgZGVidWdMb2coXCJtZXJnZU1pbGVzdG9uZVRvTWFpblwiLCB7IHBoYXNlOiBcInByZS10ZWFyZG93bi1icmFuY2gtZGV0ZWN0LWZhaWxlZFwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgfVxuICAgIGNvbnN0IGlzT25NaWxlc3RvbmVCcmFuY2ggPSBwcmVUZWFyZG93bkJyYW5jaCA9PT0gbWlsZXN0b25lQnJhbmNoO1xuXG4gICAgaWYgKGlzT25NaWxlc3RvbmVCcmFuY2gpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGRpcnR5Q2hlY2sgPSBuYXRpdmVXb3JraW5nVHJlZVN0YXR1cyh3b3JrdHJlZUN3ZCk7XG4gICAgICAgIGlmIChkaXJ0eUNoZWNrKSB7XG4gICAgICAgICAgcHJvY2Vzcy5jaGRpcihwcmV2aW91c0N3ZCk7XG4gICAgICAgICAgdGhyb3cgbmV3IEdTREVycm9yKFxuICAgICAgICAgICAgR1NEX0dJVF9FUlJPUixcbiAgICAgICAgICAgIGBNaWxlc3RvbmUgd29ya3RyZWUgc3RpbGwgaGFzIHVuY29tbWl0dGVkIGNoYW5nZXMgYWZ0ZXIgc3F1YXNoIG1lcmdlLiBgICtcbiAgICAgICAgICAgICAgYEFib3J0aW5nIHRlYXJkb3duIHRvIHByZXNlcnZlICR7bWlsZXN0b25lQnJhbmNofS4gU3RhdHVzOlxcbiR7ZGlydHlDaGVja31gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKGUgaW5zdGFuY2VvZiBHU0RFcnJvcikgdGhyb3cgZTtcbiAgICAgICAgZGVidWdMb2coXCJtZXJnZU1pbGVzdG9uZVRvTWFpblwiLCB7XG4gICAgICAgICAgcGhhc2U6IFwicHJlLXRlYXJkb3duLWRpcnR5LWNoZWNrLWVycm9yXCIsXG4gICAgICAgICAgZXJyb3I6IFN0cmluZyhlKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gMTIuIFJlbW92ZSB3b3JrdHJlZSBkaXJlY3RvcnkgZmlyc3QgKG11c3QgaGFwcGVuIGJlZm9yZSBicmFuY2ggZGVsZXRpb24pXG4gIHRyeSB7XG4gICAgcmVtb3ZlV29ya3RyZWUob3JpZ2luYWxCYXNlUGF0aF8sIG1pbGVzdG9uZUlkLCB7XG4gICAgICBicmFuY2g6IG1pbGVzdG9uZUJyYW5jaCxcbiAgICAgIGRlbGV0ZUJyYW5jaDogZmFsc2UsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIEJlc3QtZWZmb3J0IC0tIHdvcmt0cmVlIGRpciBtYXkgYWxyZWFkeSBiZSBnb25lXG4gICAgbG9nV2FybmluZyhcIndvcmt0cmVlXCIsIGB3b3JrdHJlZSByZW1vdmFsIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cblxuICAvLyAxMy4gRGVsZXRlIG1pbGVzdG9uZSBicmFuY2ggKGFmdGVyIHdvcmt0cmVlIHJlbW92YWwgc28gcmVmIGlzIHVubG9ja2VkKVxuICB0cnkge1xuICAgIG5hdGl2ZUJyYW5jaERlbGV0ZShvcmlnaW5hbEJhc2VQYXRoXywgbWlsZXN0b25lQnJhbmNoKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gQmVzdC1lZmZvcnRcbiAgICBsb2dXYXJuaW5nKFwid29ya3RyZWVcIiwgYGdpdCBicmFuY2gtZGVsZXRlIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cblxuICAvLyAxNC4gQ2xlYXIgbW9kdWxlIHN0YXRlXG4gIHNldEFjdGl2ZVdvcmtzcGFjZShudWxsKTtcbiAgbnVkZ2VHaXRCcmFuY2hDYWNoZShwcmV2aW91c0N3ZCk7XG5cbiAgLy8gMTUuIEFuY2hvciBjd2QgYXQgdGhlIHByb2plY3Qgcm9vdCBvbiBzdWNjZXNzLXJldHVybi4gU3RlcCAxMiByZW1vdmVkXG4gIC8vIHRoZSB3b3JrdHJlZSBkaXI7IGlmIGN3ZCB3YXMgaW5zaWRlIGl0LCBldmVyeSBzdWJzZXF1ZW50IHByb2Nlc3MuY3dkKClcbiAgLy8gd291bGQgdGhyb3cgRU5PRU5UIGFuZCB0cmlwIGF1dG8vcnVuLXVuaXQudHM6NTAncyBzZXNzaW9uLWZhaWxlZCBjYW5jZWxcbiAgLy8gcGF0aCAodGhlIGRlNzNmYjQzZCByZWdyZXNzaW9uIHRoYXQgY2xvc2VzIGhlYWRsZXNzIGdzZCBhdXRvKS4gU3RlcCAzXG4gIC8vIGFscmVhZHkgY2hkaXInZCBoZXJlLCBidXQgZGVmZW5kaW5nIHRoZSBzdWNjZXNzLXJldHVybiBjb250cmFjdCBtYWtlc1xuICAvLyBmdXR1cmUgbWFpbnRhaW5lcnMgc2FmZSBhZ2FpbnN0IGludGVydmVuaW5nIGNoZGlyJ3MgYmV0d2VlbiBzdGVwIDMgYW5kXG4gIC8vIGhlcmUuXG4gIHRyeSB7XG4gICAgLy8gcHJvY2Vzcy5jd2QoKSBjYW4gdGhyb3cgRU5PRU5UIHdoZW4gY3dkIHdhcyByZW1vdmVkLCBzbyBhdHRlbXB0XG4gICAgLy8gcmVjb3ZlcnkgZGlyZWN0bHkuXG4gICAgcHJvY2Vzcy5jaGRpcihvcmlnaW5hbEJhc2VQYXRoXyk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJ3b3JrdHJlZVwiLCBgY2hkaXIgdG8gcHJvamVjdCByb290IGFmdGVyIG1lcmdlIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cblxuICByZXR1cm4geyBjb21taXRNZXNzYWdlLCBwdXNoZWQsIHByQ3JlYXRlZCwgY29kZUZpbGVzQ2hhbmdlZCB9O1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBV0E7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0EsYUFBYTtBQUFBLE9BQ1I7QUFDUCxTQUFTLFlBQVksTUFBTSxVQUFVLE9BQU8sZUFBZTtBQUMzRCxTQUFTLFVBQVUsY0FBYyxxQkFBcUI7QUFDdEQ7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFF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
