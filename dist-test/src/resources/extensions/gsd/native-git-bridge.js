import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { getErrorMessage } from "./error-utils.js";
import { isInfrastructureError } from "./auto/infra-errors.js";
const NATIVE_GSD_GIT_ENABLED = process.env.GSD_ENABLE_NATIVE_GSD_GIT === "1";
const TRANSIENT_GIT_RETRY_CODES = /* @__PURE__ */ new Set(["ENOBUFS", "EAGAIN"]);
const GIT_RETRY_DELAY_MS = 200;
let nativeModule = null;
let loadAttempted = false;
function loadNative() {
  if (loadAttempted) return nativeModule;
  loadAttempted = true;
  if (!NATIVE_GSD_GIT_ENABLED) return nativeModule;
  try {
    const mod = require("@gsd/native");
    if (mod.gitCurrentBranch && mod.gitHasChanges) {
      nativeModule = mod;
    }
  } catch {
  }
  return nativeModule;
}
function gitExec(basePath, args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV
    }).trim();
  } catch (err) {
    if (allowFailure) return "";
    throw new GSDError(GSD_GIT_ERROR, `git ${args.join(" ")} failed in ${basePath}: ${getErrorMessage(err)}`);
  }
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function isRetryableGitError(err) {
  const code = isInfrastructureError(err) ?? isInfrastructureError(err?.stderr ?? "");
  return code !== null && TRANSIENT_GIT_RETRY_CODES.has(code);
}
function execGitFileSyncWithRetry(basePath, args, options) {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
      ...options
    }).trim();
  } catch (err) {
    if (!isRetryableGitError(err)) throw err;
    sleepSync(GIT_RETRY_DELAY_MS);
    return execFileSync("git", args, {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
      ...options
    }).trim();
  }
}
function gitFileExec(basePath, args, allowFailure = false) {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV
    }).trim();
  } catch (err) {
    if (allowFailure) return "";
    throw new GSDError(GSD_GIT_ERROR, `git ${args.join(" ")} failed in ${basePath}: ${getErrorMessage(err)}`);
  }
}
function nativeGetCurrentBranch(basePath) {
  const native = loadNative();
  if (native) {
    const branch = native.gitCurrentBranch(basePath);
    return branch ?? "";
  }
  return gitExec(basePath, ["branch", "--show-current"]);
}
function nativeDetectMainBranch(basePath) {
  const native = loadNative();
  if (native) {
    return native.gitMainBranch(basePath);
  }
  const symbolic = gitExec(basePath, ["symbolic-ref", "refs/remotes/origin/HEAD"], true);
  if (symbolic) {
    const match = symbolic.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  }
  const mainExists = gitExec(basePath, ["show-ref", "--verify", "refs/heads/main"], true);
  if (mainExists) return "main";
  const masterExists = gitExec(basePath, ["show-ref", "--verify", "refs/heads/master"], true);
  if (masterExists) return "master";
  return gitExec(basePath, ["branch", "--show-current"]);
}
function nativeBranchExists(basePath, branch) {
  const native = loadNative();
  if (native) {
    return native.gitBranchExists(basePath, branch);
  }
  const result = gitExec(basePath, ["show-ref", "--verify", `refs/heads/${branch}`], true);
  if (result !== "") return true;
  const current = gitExec(basePath, ["branch", "--show-current"], true);
  return current === branch;
}
function nativeHasMergeConflicts(basePath) {
  const native = loadNative();
  if (native) {
    return native.gitHasMergeConflicts(basePath);
  }
  const result = gitExec(basePath, ["diff", "--name-only", "--diff-filter=U"], true);
  return result !== "";
}
function nativeWorkingTreeStatus(basePath) {
  const native = loadNative();
  if (native) {
    return native.gitWorkingTreeStatus(basePath);
  }
  return gitExec(basePath, ["status", "--porcelain"], true);
}
let _hasChangesCachedResult = false;
let _hasChangesCachedAt = 0;
let _hasChangesCachedPath = "";
const HAS_CHANGES_CACHE_TTL_MS = 1e4;
function nativeHasChanges(basePath) {
  const native = loadNative();
  if (native) {
    return native.gitHasChanges(basePath);
  }
  const now = Date.now();
  if (basePath === _hasChangesCachedPath && now - _hasChangesCachedAt < HAS_CHANGES_CACHE_TTL_MS) {
    return _hasChangesCachedResult;
  }
  const result = gitExec(basePath, ["status", "--short"], true);
  const hasChanges = result !== "";
  _hasChangesCachedResult = hasChanges;
  _hasChangesCachedAt = now;
  _hasChangesCachedPath = basePath;
  return hasChanges;
}
function _resetHasChangesCache() {
  _hasChangesCachedResult = false;
  _hasChangesCachedAt = 0;
  _hasChangesCachedPath = "";
}
function nativeCommitCountBetween(basePath, fromRef, toRef) {
  const native = loadNative();
  if (native) {
    return native.gitCommitCountBetween(basePath, fromRef, toRef);
  }
  const result = gitExec(basePath, ["rev-list", "--count", `${fromRef}..${toRef}`], true);
  return parseInt(result, 10) || 0;
}
function nativeIsRepo(basePath) {
  const native = loadNative();
  if (native) {
    return native.gitIsRepo(basePath);
  }
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: basePath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
function nativeHasCommittedHead(basePath) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: basePath,
      stdio: ["ignore", "ignore", "ignore"],
      env: GIT_NO_PROMPT_ENV
    });
    return true;
  } catch {
    return false;
  }
}
function nativeHasStagedChanges(basePath) {
  const native = loadNative();
  if (native) {
    return native.gitHasStagedChanges(basePath);
  }
  const result = gitExec(basePath, ["diff", "--cached", "--stat"], true);
  return result !== "";
}
function nativeDiffStat(basePath, fromRef, toRef) {
  const native = loadNative();
  if (native) {
    return native.gitDiffStat(basePath, fromRef, toRef);
  }
  let args;
  if (fromRef === "HEAD" && toRef === "WORKDIR") {
    args = ["diff", "--stat", "HEAD"];
  } else if (fromRef === "HEAD" && toRef === "INDEX") {
    args = ["diff", "--stat", "--cached", "HEAD"];
  } else {
    args = ["diff", "--stat", fromRef, toRef];
  }
  const result = gitExec(basePath, args, true);
  let filesChanged = 0, insertions = 0, deletions = 0;
  const statsMatch = result.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  if (statsMatch) {
    filesChanged = parseInt(statsMatch[1] ?? "0", 10);
    insertions = parseInt(statsMatch[2] ?? "0", 10);
    deletions = parseInt(statsMatch[3] ?? "0", 10);
  }
  return { filesChanged, insertions, deletions, summary: result };
}
function nativeDiffNameStatus(basePath, fromRef, toRef, pathspec, useMergeBase) {
  const native = loadNative();
  if (native) {
    return native.gitDiffNameStatus(basePath, fromRef, toRef, pathspec, useMergeBase);
  }
  const separator = useMergeBase ? "..." : " ";
  const args = ["diff", "--name-status", `${fromRef}${separator}${toRef}`];
  if (pathspec) args.push("--", pathspec);
  const result = gitExec(basePath, args, true);
  if (!result) return [];
  return result.split("\n").filter(Boolean).map((line) => {
    const [status, ...pathParts] = line.split("	");
    return { status: status ?? "", path: pathParts.join("	") };
  });
}
function nativeDiffNumstat(basePath, fromRef, toRef, useMergeBase) {
  const native = loadNative();
  if (native && !useMergeBase) {
    return native.gitDiffNumstat(basePath, fromRef, toRef);
  }
  const refspec = useMergeBase ? `${fromRef}...${toRef}` : void 0;
  const args = refspec ? ["diff", "--numstat", refspec] : ["diff", "--numstat", fromRef, toRef];
  const result = gitExec(basePath, args, true);
  if (!result) return [];
  return result.split("\n").filter(Boolean).map((line) => {
    const [a, r, ...pathParts] = line.split("	");
    return {
      added: a === "-" ? 0 : parseInt(a ?? "0", 10),
      removed: r === "-" ? 0 : parseInt(r ?? "0", 10),
      path: pathParts.join("	")
    };
  });
}
function nativeDiffContent(basePath, fromRef, toRef, pathspec, exclude, useMergeBase) {
  const native = loadNative();
  if (native) {
    return native.gitDiffContent(basePath, fromRef, toRef, pathspec, exclude, useMergeBase);
  }
  const separator = useMergeBase ? "..." : " ";
  const args = ["diff", `${fromRef}${separator}${toRef}`];
  if (pathspec) {
    args.push("--", pathspec);
  } else if (exclude) {
    args.push("--", ".", `:(exclude)${exclude}`);
  }
  return gitExec(basePath, args, true);
}
function nativeLogOneline(basePath, fromRef, toRef) {
  const native = loadNative();
  if (native) {
    return native.gitLogOneline(basePath, fromRef, toRef);
  }
  const result = gitExec(basePath, ["log", "--oneline", `${fromRef}..${toRef}`], true);
  if (!result) return [];
  return result.split("\n").filter(Boolean).map((line) => {
    const sha = line.substring(0, 7);
    const message = line.substring(8);
    return { sha, message };
  });
}
function nativeWorktreeList(basePath) {
  const native = loadNative();
  if (native) {
    return native.gitWorktreeList(basePath);
  }
  const result = gitExec(basePath, ["worktree", "list", "--porcelain"], true);
  if (!result) return [];
  const entries = [];
  const blocks = result.replaceAll("\r\n", "\n").split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    const wtLine = lines.find((l) => l.startsWith("worktree "));
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const isBare = lines.some((l) => l === "bare");
    if (wtLine) {
      entries.push({
        path: wtLine.replace("worktree ", ""),
        branch: branchLine ? branchLine.replace("branch refs/heads/", "") : "",
        isBare
      });
    }
  }
  return entries;
}
function nativeBranchList(basePath, pattern) {
  const native = loadNative();
  if (native) {
    return native.gitBranchList(basePath, pattern);
  }
  const args = ["branch", "--list"];
  if (pattern) args.push(pattern);
  const result = gitFileExec(basePath, args, true);
  if (!result) return [];
  return result.split("\n").map((b) => b.trim().replace(/^\* /, "")).filter(Boolean);
}
function nativeBranchListMerged(basePath, target, pattern) {
  const native = loadNative();
  if (native) {
    return native.gitBranchListMerged(basePath, target, pattern);
  }
  const args = ["branch", "--merged", target];
  if (pattern) args.push("--list", pattern);
  const result = gitFileExec(basePath, args, true);
  if (!result) return [];
  return result.split("\n").map((b) => b.trim()).filter(Boolean);
}
function nativeLsFiles(basePath, pathspec) {
  const native = loadNative();
  if (native) {
    return native.gitLsFiles(basePath, pathspec);
  }
  const result = gitFileExec(basePath, ["ls-files", pathspec], true);
  if (!result) return [];
  return result.split("\n").filter(Boolean);
}
function nativeForEachRef(basePath, prefix) {
  const native = loadNative();
  if (native) {
    return native.gitForEachRef(basePath, prefix);
  }
  const result = gitFileExec(basePath, ["for-each-ref", prefix, "--format=%(refname)"], true);
  if (!result) return [];
  return result.split("\n").filter(Boolean);
}
function nativeConflictFiles(basePath) {
  const native = loadNative();
  if (native) {
    return native.gitConflictFiles(basePath);
  }
  const result = gitExec(basePath, ["diff", "--name-only", "--diff-filter=U"], true);
  if (!result) return [];
  return result.split("\n").filter(Boolean);
}
function nativeBatchInfo(basePath) {
  const native = loadNative();
  if (native) {
    return native.gitBatchInfo(basePath);
  }
  const branch = gitExec(basePath, ["branch", "--show-current"], true);
  const status = gitExec(basePath, ["status", "--porcelain"], true);
  const hasChanges = status !== "";
  let stagedCount = 0;
  let unstagedCount = 0;
  if (status) {
    for (const line of status.split("\n")) {
      if (!line || line.length < 2) continue;
      const x = line[0];
      const y = line[1];
      if (x !== " " && x !== "?") stagedCount++;
      if (y !== " " && y !== "?") unstagedCount++;
      if (x === "?" && y === "?") unstagedCount++;
    }
  }
  return {
    branch,
    hasChanges,
    status,
    stagedCount,
    unstagedCount
  };
}
function nativeInit(basePath, initialBranch) {
  const native = loadNative();
  if (native) {
    native.gitInit(basePath, initialBranch);
    return;
  }
  const args = ["init"];
  if (initialBranch) args.push("-b", initialBranch);
  gitFileExec(basePath, args);
}
function nativeAddAll(basePath) {
  const native = loadNative();
  if (native) {
    native.gitAddAll(basePath);
    return;
  }
  gitFileExec(basePath, ["add", "-A"]);
}
function nativeAddTracked(basePath) {
  gitFileExec(basePath, ["add", "-u"]);
}
function nativeIsIgnored(basePath, path) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], {
      cwd: basePath,
      stdio: "pipe",
      env: GIT_NO_PROMPT_ENV
    });
    return true;
  } catch {
    return false;
  }
}
function isDotGsdIgnored(basePath) {
  return [".gsd", ".gsd/"].some((path) => nativeIsIgnored(basePath, path));
}
function isGitignoreManagementDisabled(basePath) {
  const prefsPath = join(basePath, ".gsd", "PREFERENCES.md");
  if (!existsSync(prefsPath)) return false;
  try {
    const content = readFileSync(prefsPath, "utf-8");
    return /^\s*manage_gitignore\s*:\s*false\s*$/m.test(content);
  } catch {
    return false;
  }
}
function trySelfHealGsdGitignore(basePath) {
  if (isGitignoreManagementDisabled(basePath)) return false;
  const gitignorePath = join(basePath, ".gitignore");
  try {
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    const lines = new Set(
      existing.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    );
    if (lines.has(".gsd") || lines.has(".gsd/")) return true;
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const block = `${prefix}
# \u2500\u2500 GSD self-heal: .gsd is a symlink to external state \u2500\u2500
.gsd
`;
    writeFileSync(gitignorePath, existing + block, "utf-8");
    return true;
  } catch {
    return false;
  }
}
function stageUntrackedExcludingDotGsd(basePath) {
  gitFileExec(basePath, ["add", "-u"]);
  const status = gitFileExec(basePath, ["status", "--porcelain=v1", "-z"], true);
  if (!status) return;
  const untracked = [];
  for (const entry of status.split("\0")) {
    if (!entry) continue;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code !== "??") continue;
    if (path === ".gsd" || path.startsWith(".gsd/")) continue;
    if (path === ".gsd-id" || path === ".gsd.migrating") continue;
    if (path === ".bg-shell" || path.startsWith(".bg-shell/")) continue;
    untracked.push(path);
  }
  if (untracked.length === 0) return;
  const CHUNK = 200;
  for (let i = 0; i < untracked.length; i += CHUNK) {
    gitFileExec(basePath, ["add", "--", ...untracked.slice(i, i + CHUNK)]);
  }
}
function fallbackStageWithSymlinkedDotGsd(basePath) {
  if (isDotGsdIgnored(basePath)) {
    gitFileExec(basePath, ["add", "-A"]);
    return;
  }
  if (trySelfHealGsdGitignore(basePath)) {
    gitFileExec(basePath, ["add", "-A"]);
    return;
  }
  stageUntrackedExcludingDotGsd(basePath);
}
function nativeAddAllWithExclusions(basePath, exclusions) {
  if (exclusions.length === 0) {
    nativeAddAll(basePath);
    return;
  }
  const pathspecs = exclusions.map((e) => `:!${e}`);
  try {
    execFileSync("git", ["add", "-A", "--", ...pathspecs], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV
    });
  } catch (err) {
    const stderr = err?.stderr ?? "";
    const infraCode = isInfrastructureError(err) ?? isInfrastructureError(stderr);
    if (infraCode) {
      throw err;
    }
    if (stderr.includes("ignored by one of your .gitignore files")) {
      return;
    }
    if (stderr.includes("beyond a symbolic link")) {
      fallbackStageWithSymlinkedDotGsd(basePath);
      return;
    }
    const stderrDetail = stderr.trim() ? `; stderr: ${stderr.trim()}` : "";
    throw new GSDError(GSD_GIT_ERROR, `git add -A with exclusions failed in ${basePath}: ${getErrorMessage(err)}${stderrDetail}`);
  }
}
function nativeAddPaths(basePath, paths) {
  const native = loadNative();
  if (native) {
    native.gitAddPaths(basePath, paths);
    return;
  }
  gitFileExec(basePath, ["add", "--", ...paths]);
}
function nativeResetPaths(basePath, paths) {
  const native = loadNative();
  if (native) {
    native.gitResetPaths(basePath, paths);
    return;
  }
  for (const p of paths) {
    gitExec(basePath, ["reset", "HEAD", "--", p], true);
  }
}
function nativeCommit(basePath, message, options) {
  try {
    const args = ["commit", "-F", "-"];
    if (options?.allowEmpty) args.push("--allow-empty");
    const result = execGitFileSyncWithRetry(basePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      input: message
    });
    return result;
  } catch (err) {
    const errObj = err;
    const combined = [errObj.stdout, errObj.stderr, errObj.message].filter(Boolean).join(" ");
    if (combined.includes("nothing to commit") || combined.includes("nothing added to commit") || combined.includes("no changes added")) {
      return null;
    }
    throw err;
  }
}
function nativeCheckoutBranch(basePath, branch) {
  const native = loadNative();
  if (native) {
    native.gitCheckoutBranch(basePath, branch);
    return;
  }
  execFileSync("git", ["checkout", branch], {
    cwd: basePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8"
  });
}
function nativeCheckoutTheirs(basePath, paths) {
  const native = loadNative();
  if (native) {
    native.gitCheckoutTheirs(basePath, paths);
    return;
  }
  for (const path of paths) {
    gitFileExec(basePath, ["checkout", "--theirs", "--", path]);
  }
}
function nativeMergeSquash(basePath, branch) {
  const native = loadNative();
  if (native) {
    return native.gitMergeSquash(basePath, branch);
  }
  try {
    execFileSync("git", ["merge", "--squash", branch], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV
    });
    return { success: true, conflicts: [] };
  } catch (err) {
    const stderr = err instanceof Error ? err.stderr ?? err.message : String(err);
    if (stderr.includes("local changes would be overwritten") || stderr.includes("not possible because you have unmerged files") || stderr.includes("overwritten by merge")) {
      const dirtyFiles = stderr.split("\n").filter((line) => line.startsWith("	")).map((line) => line.trim()).filter(Boolean);
      return { success: false, conflicts: ["__dirty_working_tree__"], dirtyFiles };
    }
    const conflictOutput = gitExec(basePath, ["diff", "--name-only", "--diff-filter=U"], true);
    const conflicts = conflictOutput ? conflictOutput.split("\n").filter(Boolean) : [];
    if (conflicts.length > 0) {
      return { success: false, conflicts };
    }
    throw err;
  }
}
function nativeMergeAbort(basePath) {
  const native = loadNative();
  if (native) {
    native.gitMergeAbort(basePath);
    return;
  }
  gitExec(basePath, ["merge", "--abort"], true);
}
function nativeRebaseAbort(basePath) {
  const native = loadNative();
  if (native) {
    native.gitRebaseAbort(basePath);
    return;
  }
  gitExec(basePath, ["rebase", "--abort"], true);
}
function nativeResetHard(basePath) {
  const native = loadNative();
  if (native) {
    native.gitResetHard(basePath);
    return;
  }
  execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: basePath, stdio: "pipe" });
}
function nativeResetSoft(basePath, target) {
  execFileSync("git", ["reset", "--soft", target], {
    cwd: basePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: GIT_NO_PROMPT_ENV
  });
}
function nativeCommitSubject(basePath, ref) {
  try {
    return execFileSync("git", ["log", "-1", "--format=%s", ref], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV
    }).trim();
  } catch {
    return "";
  }
}
function nativeBranchDelete(basePath, branch, force = true) {
  const native = loadNative();
  if (native) {
    native.gitBranchDelete(basePath, branch, force);
    return;
  }
  gitFileExec(basePath, ["branch", force ? "-D" : "-d", branch]);
}
function nativeBranchForceReset(basePath, branch, target) {
  const native = loadNative();
  if (native) {
    native.gitBranchForceReset(basePath, branch, target);
    return;
  }
  gitExec(basePath, ["branch", "-f", branch, target]);
}
function nativeRmCached(basePath, paths, recursive = true) {
  const native = loadNative();
  if (native) {
    return native.gitRmCached(basePath, paths, recursive);
  }
  const removed = [];
  for (const path of paths) {
    const result = gitExec(
      basePath,
      ["rm", "--cached", ...recursive ? ["-r"] : [], "--ignore-unmatch", path],
      true
    );
    if (result) removed.push(result);
  }
  return removed;
}
function nativeRmForce(basePath, paths) {
  const native = loadNative();
  if (native) {
    native.gitRmForce(basePath, paths);
    return;
  }
  for (const path of paths) {
    gitFileExec(basePath, ["rm", "--force", "--", path], true);
  }
}
function runGitWorktreeAdd(basePath, wtPath, branch, createBranch, startPoint) {
  if (createBranch) {
    const branchRef = gitExec(basePath, ["show-ref", "--verify", `refs/heads/${branch}`], true);
    if (branchRef) {
      gitExec(basePath, ["worktree", "add", wtPath, branch]);
      return;
    }
    gitExec(basePath, ["worktree", "add", "-b", branch, wtPath, startPoint ?? "HEAD"]);
  } else {
    gitExec(basePath, ["worktree", "add", wtPath, branch]);
  }
}
function assertWorktreeMaterialized(wtPath) {
  if (existsSync(join(wtPath, ".git"))) return;
  throw new GSDError(
    GSD_GIT_ERROR,
    `git worktree add did not materialize a valid worktree at ${wtPath}: missing .git file`
  );
}
function nativeWorktreeAdd(basePath, wtPath, branch, createBranch, startPoint) {
  const native = loadNative();
  if (native) {
    native.gitWorktreeAdd(basePath, wtPath, branch, createBranch, startPoint);
    try {
      assertWorktreeMaterialized(wtPath);
      return;
    } catch {
      rmSync(wtPath, { recursive: true, force: true });
      gitExec(basePath, ["worktree", "prune"], true);
      runGitWorktreeAdd(basePath, wtPath, branch, createBranch, startPoint);
      assertWorktreeMaterialized(wtPath);
      return;
    }
  }
  runGitWorktreeAdd(basePath, wtPath, branch, createBranch, startPoint);
  assertWorktreeMaterialized(wtPath);
}
function nativeWorktreeRemove(basePath, wtPath, force = false) {
  const native = loadNative();
  if (native) {
    native.gitWorktreeRemove(basePath, wtPath, force);
    return;
  }
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(wtPath);
  gitExec(basePath, args, true);
}
function nativeWorktreePrune(basePath) {
  const native = loadNative();
  if (native) {
    native.gitWorktreePrune(basePath);
    return;
  }
  gitExec(basePath, ["worktree", "prune"], true);
}
function nativeRevertCommit(basePath, sha) {
  const native = loadNative();
  if (native) {
    native.gitRevertCommit(basePath, sha);
    return;
  }
  gitFileExec(basePath, ["revert", "--no-commit", sha]);
}
function nativeRevertAbort(basePath) {
  const native = loadNative();
  if (native) {
    native.gitRevertAbort(basePath);
    return;
  }
  gitFileExec(basePath, ["revert", "--abort"], true);
}
function nativeUpdateRef(basePath, refname, target) {
  const native = loadNative();
  if (native) {
    native.gitUpdateRef(basePath, refname, target);
    return;
  }
  if (target !== void 0) {
    gitExec(basePath, ["update-ref", refname, target]);
  } else {
    gitExec(basePath, ["update-ref", "-d", refname], true);
  }
}
function isNativeGitAvailable() {
  return loadNative() !== null;
}
function nativeIsAncestor(basePath, ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: GIT_NO_PROMPT_ENV
    });
    return true;
  } catch {
    return false;
  }
}
function nativeLastCommitEpoch(basePath, ref) {
  try {
    const result = execFileSync("git", ["log", "-1", "--format=%ct", ref], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV
    }).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return 0;
  }
}
function nativeUnpushedCount(basePath, branch) {
  try {
    const result = execFileSync("git", ["rev-list", branch, "--not", "--remotes", "--count"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV
    }).trim();
    return parseInt(result, 10) || 0;
  } catch {
    return -1;
  }
}
export {
  _resetHasChangesCache,
  assertWorktreeMaterialized,
  isNativeGitAvailable,
  nativeAddAll,
  nativeAddAllWithExclusions,
  nativeAddPaths,
  nativeAddTracked,
  nativeBatchInfo,
  nativeBranchDelete,
  nativeBranchExists,
  nativeBranchForceReset,
  nativeBranchList,
  nativeBranchListMerged,
  nativeCheckoutBranch,
  nativeCheckoutTheirs,
  nativeCommit,
  nativeCommitCountBetween,
  nativeCommitSubject,
  nativeConflictFiles,
  nativeDetectMainBranch,
  nativeDiffContent,
  nativeDiffNameStatus,
  nativeDiffNumstat,
  nativeDiffStat,
  nativeForEachRef,
  nativeGetCurrentBranch,
  nativeHasChanges,
  nativeHasCommittedHead,
  nativeHasMergeConflicts,
  nativeHasStagedChanges,
  nativeInit,
  nativeIsAncestor,
  nativeIsIgnored,
  nativeIsRepo,
  nativeLastCommitEpoch,
  nativeLogOneline,
  nativeLsFiles,
  nativeMergeAbort,
  nativeMergeSquash,
  nativeRebaseAbort,
  nativeResetHard,
  nativeResetPaths,
  nativeResetSoft,
  nativeRevertAbort,
  nativeRevertCommit,
  nativeRmCached,
  nativeRmForce,
  nativeUnpushedCount,
  nativeUpdateRef,
  nativeWorkingTreeStatus,
  nativeWorktreeAdd,
  nativeWorktreeList,
  nativeWorktreePrune,
  nativeWorktreeRemove
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9uYXRpdmUtZ2l0LWJyaWRnZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gTmF0aXZlIEdpdCBCcmlkZ2Vcbi8vIFByb3ZpZGVzIGhpZ2gtcGVyZm9ybWFuY2UgZ2l0IG9wZXJhdGlvbnMgYmFja2VkIGJ5IGxpYmdpdDIgdmlhIHRoZSBSdXN0IG5hdGl2ZSBtb2R1bGUuXG4vLyBGYWxscyBiYWNrIHRvIGV4ZWNTeW5jL2V4ZWNGaWxlU3luYyBnaXQgY29tbWFuZHMgd2hlbiB0aGUgbmF0aXZlIG1vZHVsZSBpcyB1bmF2YWlsYWJsZS5cbi8vXG4vLyBCb3RoIFJFQUQgYW5kIFdSSVRFIG9wZXJhdGlvbnMgYXJlIG5hdGl2ZSBcdTIwMTQgcHVzaCBvcGVyYXRpb25zIHJlbWFpbiBhc1xuLy8gZXhlY1N5bmMgY2FsbHMgYmVjYXVzZSBnaXQyIGNyZWRlbnRpYWwgaGFuZGxpbmcgaXMgdG9vIGNvbXBsZXguXG5cbmltcG9ydCB7IGV4ZWNTeW5jLCBleGVjRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgdHlwZSB7IEV4ZWNGaWxlU3luY09wdGlvbnNXaXRoU3RyaW5nRW5jb2RpbmcgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMsIHVubGlua1N5bmMsIHJtU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgR1NERXJyb3IsIEdTRF9HSVRfRVJST1IgfSBmcm9tIFwiLi9lcnJvcnMuanNcIjtcbmltcG9ydCB7IEdJVF9OT19QUk9NUFRfRU5WIH0gZnJvbSBcIi4vZ2l0LWNvbnN0YW50cy5qc1wiO1xuaW1wb3J0IHsgZ2V0RXJyb3JNZXNzYWdlIH0gZnJvbSBcIi4vZXJyb3ItdXRpbHMuanNcIjtcbmltcG9ydCB7IGlzSW5mcmFzdHJ1Y3R1cmVFcnJvciB9IGZyb20gXCIuL2F1dG8vaW5mcmEtZXJyb3JzLmpzXCI7XG5cbi8vIElzc3VlICM0NTM6IGtlZXAgYXV0by1tb2RlIGJvb2trZWVwaW5nIG9uIHRoZSBzdGFibGUgZ2l0IENMSSBwYXRoIHVubGVzcyBhXG4vLyBjYWxsZXIgZXhwbGljaXRseSBvcHRzIGludG8gdGhlIG5hdGl2ZSBoZWxwZXIuXG5jb25zdCBOQVRJVkVfR1NEX0dJVF9FTkFCTEVEID0gcHJvY2Vzcy5lbnYuR1NEX0VOQUJMRV9OQVRJVkVfR1NEX0dJVCA9PT0gXCIxXCI7XG5jb25zdCBUUkFOU0lFTlRfR0lUX1JFVFJZX0NPREVTID0gbmV3IFNldChbXCJFTk9CVUZTXCIsIFwiRUFHQUlOXCJdKTtcbmNvbnN0IEdJVF9SRVRSWV9ERUxBWV9NUyA9IDIwMDtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE5hdGl2ZSBNb2R1bGUgVHlwZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmludGVyZmFjZSBHaXREaWZmU3RhdCB7XG4gIGZpbGVzQ2hhbmdlZDogbnVtYmVyO1xuICBpbnNlcnRpb25zOiBudW1iZXI7XG4gIGRlbGV0aW9uczogbnVtYmVyO1xuICBzdW1tYXJ5OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBHaXROYW1lU3RhdHVzIHtcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIHBhdGg6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIEdpdE51bXN0YXQge1xuICBhZGRlZDogbnVtYmVyO1xuICByZW1vdmVkOiBudW1iZXI7XG4gIHBhdGg6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIEdpdExvZ0VudHJ5IHtcbiAgc2hhOiBzdHJpbmc7XG4gIG1lc3NhZ2U6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIEdpdFdvcmt0cmVlRW50cnkge1xuICBwYXRoOiBzdHJpbmc7XG4gIGJyYW5jaDogc3RyaW5nO1xuICBpc0JhcmU6IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBHaXRCYXRjaEluZm8ge1xuICBicmFuY2g6IHN0cmluZztcbiAgaGFzQ2hhbmdlczogYm9vbGVhbjtcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIHN0YWdlZENvdW50OiBudW1iZXI7XG4gIHVuc3RhZ2VkQ291bnQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEdpdE1lcmdlUmVzdWx0IHtcbiAgc3VjY2VzczogYm9vbGVhbjtcbiAgY29uZmxpY3RzOiBzdHJpbmdbXTtcbiAgLyoqIEZpbGVuYW1lcyBleHRyYWN0ZWQgZnJvbSBnaXQgc3RkZXJyIHdoZW4gYSBkaXJ0eSB3b3JraW5nIHRyZWUgYmxvY2tzIHRoZSBtZXJnZSAoIzIxNTEpLiAqL1xuICBkaXJ0eUZpbGVzPzogc3RyaW5nW107XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBOYXRpdmUgTW9kdWxlIExvYWRpbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmxldCBuYXRpdmVNb2R1bGU6IHtcbiAgLy8gRXhpc3RpbmcgcmVhZCBmdW5jdGlvbnNcbiAgZ2l0Q3VycmVudEJyYW5jaDogKHJlcG9QYXRoOiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIGdpdE1haW5CcmFuY2g6IChyZXBvUGF0aDogc3RyaW5nKSA9PiBzdHJpbmc7XG4gIGdpdEJyYW5jaEV4aXN0czogKHJlcG9QYXRoOiBzdHJpbmcsIGJyYW5jaDogc3RyaW5nKSA9PiBib29sZWFuO1xuICBnaXRIYXNNZXJnZUNvbmZsaWN0czogKHJlcG9QYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIGdpdFdvcmtpbmdUcmVlU3RhdHVzOiAocmVwb1BhdGg6IHN0cmluZykgPT4gc3RyaW5nO1xuICBnaXRIYXNDaGFuZ2VzOiAocmVwb1BhdGg6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgZ2l0Q29tbWl0Q291bnRCZXR3ZWVuOiAocmVwb1BhdGg6IHN0cmluZywgZnJvbVJlZjogc3RyaW5nLCB0b1JlZjogc3RyaW5nKSA9PiBudW1iZXI7XG4gIC8vIE5ldyByZWFkIGZ1bmN0aW9uc1xuICBnaXRJc1JlcG86IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIGdpdEhhc1N0YWdlZENoYW5nZXM6IChyZXBvUGF0aDogc3RyaW5nKSA9PiBib29sZWFuO1xuICBnaXREaWZmU3RhdDogKHJlcG9QYXRoOiBzdHJpbmcsIGZyb21SZWY6IHN0cmluZywgdG9SZWY6IHN0cmluZykgPT4gR2l0RGlmZlN0YXQ7XG4gIGdpdERpZmZOYW1lU3RhdHVzOiAocmVwb1BhdGg6IHN0cmluZywgZnJvbVJlZjogc3RyaW5nLCB0b1JlZjogc3RyaW5nLCBwYXRoc3BlYz86IHN0cmluZywgdXNlTWVyZ2VCYXNlPzogYm9vbGVhbikgPT4gR2l0TmFtZVN0YXR1c1tdO1xuICBnaXREaWZmTnVtc3RhdDogKHJlcG9QYXRoOiBzdHJpbmcsIGZyb21SZWY6IHN0cmluZywgdG9SZWY6IHN0cmluZykgPT4gR2l0TnVtc3RhdFtdO1xuICBnaXREaWZmQ29udGVudDogKHJlcG9QYXRoOiBzdHJpbmcsIGZyb21SZWY6IHN0cmluZywgdG9SZWY6IHN0cmluZywgcGF0aHNwZWM/OiBzdHJpbmcsIGV4Y2x1ZGU/OiBzdHJpbmcsIHVzZU1lcmdlQmFzZT86IGJvb2xlYW4pID0+IHN0cmluZztcbiAgZ2l0TG9nT25lbGluZTogKHJlcG9QYXRoOiBzdHJpbmcsIGZyb21SZWY6IHN0cmluZywgdG9SZWY6IHN0cmluZykgPT4gR2l0TG9nRW50cnlbXTtcbiAgZ2l0V29ya3RyZWVMaXN0OiAocmVwb1BhdGg6IHN0cmluZykgPT4gR2l0V29ya3RyZWVFbnRyeVtdO1xuICBnaXRCcmFuY2hMaXN0OiAocmVwb1BhdGg6IHN0cmluZywgcGF0dGVybj86IHN0cmluZykgPT4gc3RyaW5nW107XG4gIGdpdEJyYW5jaExpc3RNZXJnZWQ6IChyZXBvUGF0aDogc3RyaW5nLCB0YXJnZXQ6IHN0cmluZywgcGF0dGVybj86IHN0cmluZykgPT4gc3RyaW5nW107XG4gIGdpdExzRmlsZXM6IChyZXBvUGF0aDogc3RyaW5nLCBwYXRoc3BlYzogc3RyaW5nKSA9PiBzdHJpbmdbXTtcbiAgZ2l0Rm9yRWFjaFJlZjogKHJlcG9QYXRoOiBzdHJpbmcsIHByZWZpeDogc3RyaW5nKSA9PiBzdHJpbmdbXTtcbiAgZ2l0Q29uZmxpY3RGaWxlczogKHJlcG9QYXRoOiBzdHJpbmcpID0+IHN0cmluZ1tdO1xuICBnaXRCYXRjaEluZm86IChyZXBvUGF0aDogc3RyaW5nKSA9PiBHaXRCYXRjaEluZm87XG4gIC8vIFdyaXRlIGZ1bmN0aW9uc1xuICBnaXRJbml0OiAocGF0aDogc3RyaW5nLCBpbml0aWFsQnJhbmNoPzogc3RyaW5nKSA9PiB2b2lkO1xuICBnaXRBZGRBbGw6IChyZXBvUGF0aDogc3RyaW5nKSA9PiB2b2lkO1xuICBnaXRBZGRQYXRoczogKHJlcG9QYXRoOiBzdHJpbmcsIHBhdGhzOiBzdHJpbmdbXSkgPT4gdm9pZDtcbiAgZ2l0UmVzZXRQYXRoczogKHJlcG9QYXRoOiBzdHJpbmcsIHBhdGhzOiBzdHJpbmdbXSkgPT4gdm9pZDtcbiAgZ2l0Q29tbWl0OiAocmVwb1BhdGg6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nLCBhbGxvd0VtcHR5PzogYm9vbGVhbikgPT4gc3RyaW5nO1xuICBnaXRDaGVja291dEJyYW5jaDogKHJlcG9QYXRoOiBzdHJpbmcsIGJyYW5jaDogc3RyaW5nKSA9PiB2b2lkO1xuICBnaXRDaGVja291dFRoZWlyczogKHJlcG9QYXRoOiBzdHJpbmcsIHBhdGhzOiBzdHJpbmdbXSkgPT4gdm9pZDtcbiAgZ2l0TWVyZ2VTcXVhc2g6IChyZXBvUGF0aDogc3RyaW5nLCBicmFuY2g6IHN0cmluZykgPT4gR2l0TWVyZ2VSZXN1bHQ7XG4gIGdpdE1lcmdlQWJvcnQ6IChyZXBvUGF0aDogc3RyaW5nKSA9PiB2b2lkO1xuICBnaXRSZWJhc2VBYm9ydDogKHJlcG9QYXRoOiBzdHJpbmcpID0+IHZvaWQ7XG4gIGdpdFJlc2V0SGFyZDogKHJlcG9QYXRoOiBzdHJpbmcpID0+IHZvaWQ7XG4gIGdpdEJyYW5jaERlbGV0ZTogKHJlcG9QYXRoOiBzdHJpbmcsIGJyYW5jaDogc3RyaW5nLCBmb3JjZT86IGJvb2xlYW4pID0+IHZvaWQ7XG4gIGdpdEJyYW5jaEZvcmNlUmVzZXQ6IChyZXBvUGF0aDogc3RyaW5nLCBicmFuY2g6IHN0cmluZywgdGFyZ2V0OiBzdHJpbmcpID0+IHZvaWQ7XG4gIGdpdFJtQ2FjaGVkOiAocmVwb1BhdGg6IHN0cmluZywgcGF0aHM6IHN0cmluZ1tdLCByZWN1cnNpdmU/OiBib29sZWFuKSA9PiBzdHJpbmdbXTtcbiAgZ2l0Um1Gb3JjZTogKHJlcG9QYXRoOiBzdHJpbmcsIHBhdGhzOiBzdHJpbmdbXSkgPT4gdm9pZDtcbiAgZ2l0V29ya3RyZWVBZGQ6IChyZXBvUGF0aDogc3RyaW5nLCB3dFBhdGg6IHN0cmluZywgYnJhbmNoOiBzdHJpbmcsIGNyZWF0ZUJyYW5jaD86IGJvb2xlYW4sIHN0YXJ0UG9pbnQ/OiBzdHJpbmcpID0+IHZvaWQ7XG4gIGdpdFdvcmt0cmVlUmVtb3ZlOiAocmVwb1BhdGg6IHN0cmluZywgd3RQYXRoOiBzdHJpbmcsIGZvcmNlPzogYm9vbGVhbikgPT4gdm9pZDtcbiAgZ2l0V29ya3RyZWVQcnVuZTogKHJlcG9QYXRoOiBzdHJpbmcpID0+IHZvaWQ7XG4gIGdpdFJldmVydENvbW1pdDogKHJlcG9QYXRoOiBzdHJpbmcsIHNoYTogc3RyaW5nKSA9PiB2b2lkO1xuICBnaXRSZXZlcnRBYm9ydDogKHJlcG9QYXRoOiBzdHJpbmcpID0+IHZvaWQ7XG4gIGdpdFVwZGF0ZVJlZjogKHJlcG9QYXRoOiBzdHJpbmcsIHJlZm5hbWU6IHN0cmluZywgdGFyZ2V0Pzogc3RyaW5nKSA9PiB2b2lkO1xufSB8IG51bGwgPSBudWxsO1xuXG5sZXQgbG9hZEF0dGVtcHRlZCA9IGZhbHNlO1xuXG5mdW5jdGlvbiBsb2FkTmF0aXZlKCk6IHR5cGVvZiBuYXRpdmVNb2R1bGUge1xuICBpZiAobG9hZEF0dGVtcHRlZCkgcmV0dXJuIG5hdGl2ZU1vZHVsZTtcbiAgbG9hZEF0dGVtcHRlZCA9IHRydWU7XG4gIGlmICghTkFUSVZFX0dTRF9HSVRfRU5BQkxFRCkgcmV0dXJuIG5hdGl2ZU1vZHVsZTtcblxuICB0cnkge1xuICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzXG4gICAgY29uc3QgbW9kID0gcmVxdWlyZShcIkBnc2QvbmF0aXZlXCIpO1xuICAgIGlmIChtb2QuZ2l0Q3VycmVudEJyYW5jaCAmJiBtb2QuZ2l0SGFzQ2hhbmdlcykge1xuICAgICAgbmF0aXZlTW9kdWxlID0gbW9kO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTmF0aXZlIG1vZHVsZSBub3QgYXZhaWxhYmxlIFx1MjAxNCBhbGwgZnVuY3Rpb25zIGZhbGwgYmFjayB0byBnaXQgQ0xJXG4gIH1cblxuICByZXR1cm4gbmF0aXZlTW9kdWxlO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRmFsbGJhY2sgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIFJ1biBhIGdpdCBjb21tYW5kIHZpYSBleGVjRmlsZVN5bmMuIFJldHVybnMgdHJpbW1lZCBzdGRvdXQuICovXG5mdW5jdGlvbiBnaXRFeGVjKGJhc2VQYXRoOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdLCBhbGxvd0ZhaWx1cmUgPSBmYWxzZSk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBhcmdzLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIGVudjogR0lUX05PX1BST01QVF9FTlYsXG4gICAgfSkudHJpbSgpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoYWxsb3dGYWlsdXJlKSByZXR1cm4gXCJcIjtcbiAgICB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX0dJVF9FUlJPUiwgYGdpdCAke2FyZ3Muam9pbihcIiBcIil9IGZhaWxlZCBpbiAke2Jhc2VQYXRofTogJHtnZXRFcnJvck1lc3NhZ2UoZXJyKX1gKTtcbiAgfVxufVxuXG4vKiogc2xlZXBTeW5jIHVzZXMgQXRvbWljcy53YWl0IGZvciBhIGJsb2NraW5nIHBhdXNlIHdpdGhvdXQgYnVzeS13YWl0aW5nOyBpdCBibG9ja3MgdGhlIGN1cnJlbnQgdGhyZWFkIGFuZCByZXF1aXJlcyBBdG9taWNzLndhaXQgc3VwcG9ydC4gKi9cbmZ1bmN0aW9uIHNsZWVwU3luYyhtczogbnVtYmVyKTogdm9pZCB7XG4gIEF0b21pY3Mud2FpdChuZXcgSW50MzJBcnJheShuZXcgU2hhcmVkQXJyYXlCdWZmZXIoNCkpLCAwLCAwLCBtcyk7XG59XG5cbmZ1bmN0aW9uIGlzUmV0cnlhYmxlR2l0RXJyb3IoZXJyOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGNvbnN0IGNvZGUgPSBpc0luZnJhc3RydWN0dXJlRXJyb3IoZXJyKVxuICAgID8/IGlzSW5mcmFzdHJ1Y3R1cmVFcnJvcigoZXJyIGFzIHsgc3RkZXJyPzogc3RyaW5nIH0pPy5zdGRlcnIgPz8gXCJcIik7XG4gIHJldHVybiBjb2RlICE9PSBudWxsICYmIFRSQU5TSUVOVF9HSVRfUkVUUllfQ09ERVMuaGFzKGNvZGUpO1xufVxuXG5mdW5jdGlvbiBleGVjR2l0RmlsZVN5bmNXaXRoUmV0cnkoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICBvcHRpb25zOiBQYXJ0aWFsPEV4ZWNGaWxlU3luY09wdGlvbnNXaXRoU3RyaW5nRW5jb2Rpbmc+LFxuKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIGFyZ3MsIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgZW52OiBHSVRfTk9fUFJPTVBUX0VOVixcbiAgICAgIC4uLm9wdGlvbnMsXG4gICAgfSkudHJpbSgpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBpZiAoIWlzUmV0cnlhYmxlR2l0RXJyb3IoZXJyKSkgdGhyb3cgZXJyO1xuICAgIHNsZWVwU3luYyhHSVRfUkVUUllfREVMQVlfTVMpO1xuICAgIHJldHVybiBleGVjRmlsZVN5bmMoXCJnaXRcIiwgYXJncywge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgICBlbnY6IEdJVF9OT19QUk9NUFRfRU5WLFxuICAgICAgLi4ub3B0aW9ucyxcbiAgICB9KS50cmltKCk7XG4gIH1cbn1cblxuLyoqIFJ1biBhIGdpdCBjb21tYW5kIHZpYSBleGVjRmlsZVN5bmMuIFJldHVybnMgdHJpbW1lZCBzdGRvdXQuICovXG5mdW5jdGlvbiBnaXRGaWxlRXhlYyhiYXNlUGF0aDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSwgYWxsb3dGYWlsdXJlID0gZmFsc2UpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBleGVjRmlsZVN5bmMoXCJnaXRcIiwgYXJncywge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgICBlbnY6IEdJVF9OT19QUk9NUFRfRU5WLFxuICAgIH0pLnRyaW0oKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKGFsbG93RmFpbHVyZSkgcmV0dXJuIFwiXCI7XG4gICAgdGhyb3cgbmV3IEdTREVycm9yKEdTRF9HSVRfRVJST1IsIGBnaXQgJHthcmdzLmpvaW4oXCIgXCIpfSBmYWlsZWQgaW4gJHtiYXNlUGF0aH06ICR7Z2V0RXJyb3JNZXNzYWdlKGVycil9YCk7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEV4aXN0aW5nIFJlYWQgRnVuY3Rpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEdldCB0aGUgY3VycmVudCBicmFuY2ggbmFtZS5cbiAqIE5hdGl2ZTogcmVhZHMgSEVBRCBzeW1ib2xpYyByZWYgdmlhIGxpYmdpdDIuXG4gKiBGYWxsYmFjazogYGdpdCBicmFuY2ggLS1zaG93LWN1cnJlbnRgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlR2V0Q3VycmVudEJyYW5jaChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgY29uc3QgYnJhbmNoID0gbmF0aXZlLmdpdEN1cnJlbnRCcmFuY2goYmFzZVBhdGgpO1xuICAgIHJldHVybiBicmFuY2ggPz8gXCJcIjtcbiAgfVxuICByZXR1cm4gZ2l0RXhlYyhiYXNlUGF0aCwgW1wiYnJhbmNoXCIsIFwiLS1zaG93LWN1cnJlbnRcIl0pO1xufVxuXG4vKipcbiAqIERldGVjdCB0aGUgcmVwby1sZXZlbCBtYWluIGJyYW5jaCAob3JpZ2luL0hFQUQgXHUyMTkyIG1haW4gXHUyMTkyIG1hc3RlciBcdTIxOTIgY3VycmVudCkuXG4gKiBOYXRpdmU6IGNoZWNrcyByZWZzIHZpYSBsaWJnaXQyLlxuICogRmFsbGJhY2s6IGBnaXQgc3ltYm9saWMtcmVmYCArIGBnaXQgc2hvdy1yZWZgIGNoYWluLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgcmV0dXJuIG5hdGl2ZS5naXRNYWluQnJhbmNoKGJhc2VQYXRoKTtcbiAgfVxuXG4gIGNvbnN0IHN5bWJvbGljID0gZ2l0RXhlYyhiYXNlUGF0aCwgW1wic3ltYm9saWMtcmVmXCIsIFwicmVmcy9yZW1vdGVzL29yaWdpbi9IRUFEXCJdLCB0cnVlKTtcbiAgaWYgKHN5bWJvbGljKSB7XG4gICAgY29uc3QgbWF0Y2ggPSBzeW1ib2xpYy5tYXRjaCgvcmVmc1xcL3JlbW90ZXNcXC9vcmlnaW5cXC8oLispJC8pO1xuICAgIGlmIChtYXRjaCkgcmV0dXJuIG1hdGNoWzFdITtcbiAgfVxuXG4gIGNvbnN0IG1haW5FeGlzdHMgPSBnaXRFeGVjKGJhc2VQYXRoLCBbXCJzaG93LXJlZlwiLCBcIi0tdmVyaWZ5XCIsIFwicmVmcy9oZWFkcy9tYWluXCJdLCB0cnVlKTtcbiAgaWYgKG1haW5FeGlzdHMpIHJldHVybiBcIm1haW5cIjtcblxuICBjb25zdCBtYXN0ZXJFeGlzdHMgPSBnaXRFeGVjKGJhc2VQYXRoLCBbXCJzaG93LXJlZlwiLCBcIi0tdmVyaWZ5XCIsIFwicmVmcy9oZWFkcy9tYXN0ZXJcIl0sIHRydWUpO1xuICBpZiAobWFzdGVyRXhpc3RzKSByZXR1cm4gXCJtYXN0ZXJcIjtcblxuICByZXR1cm4gZ2l0RXhlYyhiYXNlUGF0aCwgW1wiYnJhbmNoXCIsIFwiLS1zaG93LWN1cnJlbnRcIl0pO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGEgbG9jYWwgYnJhbmNoIGV4aXN0cy5cbiAqIE5hdGl2ZTogY2hlY2tzIHJlZnMvaGVhZHMvPG5hbWU+IHZpYSBsaWJnaXQyLlxuICogRmFsbGJhY2s6IGBnaXQgc2hvdy1yZWYgLS12ZXJpZnlgLCB3aXRoIHVuYm9ybi1icmFuY2ggZGV0ZWN0aW9uXG4gKiBzbyB0aGF0IHRoZSBjdXJyZW50IGJyYW5jaCBpbiBhIHplcm8tY29tbWl0IHJlcG8gaXMgdHJlYXRlZCBhc1xuICogZXhpc3RpbmcgKGZpeGVzICMxNzcxKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUJyYW5jaEV4aXN0cyhiYXNlUGF0aDogc3RyaW5nLCBicmFuY2g6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICByZXR1cm4gbmF0aXZlLmdpdEJyYW5jaEV4aXN0cyhiYXNlUGF0aCwgYnJhbmNoKTtcbiAgfVxuICBjb25zdCByZXN1bHQgPSBnaXRFeGVjKGJhc2VQYXRoLCBbXCJzaG93LXJlZlwiLCBcIi0tdmVyaWZ5XCIsIGByZWZzL2hlYWRzLyR7YnJhbmNofWBdLCB0cnVlKTtcbiAgaWYgKHJlc3VsdCAhPT0gXCJcIikgcmV0dXJuIHRydWU7XG5cbiAgLy8gc2hvdy1yZWYgZmFpbHMgZm9yIHVuYm9ybiBicmFuY2hlcyAoemVybyBjb21taXRzKS4gRmFsbCBiYWNrIHRvIGNoZWNraW5nXG4gIC8vIHdoZXRoZXIgdGhlIHJlcXVlc3RlZCBicmFuY2ggaXMgdGhlIGN1cnJlbnQgKHVuYm9ybikgYnJhbmNoLlxuICBjb25zdCBjdXJyZW50ID0gZ2l0RXhlYyhiYXNlUGF0aCwgW1wiYnJhbmNoXCIsIFwiLS1zaG93LWN1cnJlbnRcIl0sIHRydWUpO1xuICByZXR1cm4gY3VycmVudCA9PT0gYnJhbmNoO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIHRoZSBpbmRleCBoYXMgdW5tZXJnZWQgZW50cmllcyAobWVyZ2UgY29uZmxpY3RzKS5cbiAqIE5hdGl2ZTogcmVhZHMgaW5kZXggY29uZmxpY3Qgc3RhdGUgdmlhIGxpYmdpdDIuXG4gKiBGYWxsYmFjazogYGdpdCBkaWZmIC0tbmFtZS1vbmx5IC0tZGlmZi1maWx0ZXI9VWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVIYXNNZXJnZUNvbmZsaWN0cyhiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIHJldHVybiBuYXRpdmUuZ2l0SGFzTWVyZ2VDb25mbGljdHMoYmFzZVBhdGgpO1xuICB9XG4gIGNvbnN0IHJlc3VsdCA9IGdpdEV4ZWMoYmFzZVBhdGgsIFtcImRpZmZcIiwgXCItLW5hbWUtb25seVwiLCBcIi0tZGlmZi1maWx0ZXI9VVwiXSwgdHJ1ZSk7XG4gIHJldHVybiByZXN1bHQgIT09IFwiXCI7XG59XG5cbi8qKlxuICogR2V0IHdvcmtpbmcgdHJlZSBzdGF0dXMgKHBvcmNlbGFpbiBmb3JtYXQpLlxuICogTmF0aXZlOiByZWFkcyBzdGF0dXMgdmlhIGxpYmdpdDIuXG4gKiBGYWxsYmFjazogYGdpdCBzdGF0dXMgLS1wb3JjZWxhaW5gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlV29ya2luZ1RyZWVTdGF0dXMoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIHJldHVybiBuYXRpdmUuZ2l0V29ya2luZ1RyZWVTdGF0dXMoYmFzZVBhdGgpO1xuICB9XG4gIHJldHVybiBnaXRFeGVjKGJhc2VQYXRoLCBbXCJzdGF0dXNcIiwgXCItLXBvcmNlbGFpblwiXSwgdHJ1ZSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBuYXRpdmVIYXNDaGFuZ2VzIGZhbGxiYWNrIGNhY2hlICgxMHMgVFRMKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmxldCBfaGFzQ2hhbmdlc0NhY2hlZFJlc3VsdDogYm9vbGVhbiA9IGZhbHNlO1xubGV0IF9oYXNDaGFuZ2VzQ2FjaGVkQXQ6IG51bWJlciA9IDA7XG5sZXQgX2hhc0NoYW5nZXNDYWNoZWRQYXRoOiBzdHJpbmcgPSBcIlwiO1xuY29uc3QgSEFTX0NIQU5HRVNfQ0FDSEVfVFRMX01TID0gMTBfMDAwOyAvLyAxMCBzZWNvbmRzXG5cbi8qKlxuICogUXVpY2sgY2hlY2s6IGFueSBzdGFnZWQgb3IgdW5zdGFnZWQgY2hhbmdlcz9cbiAqIE5hdGl2ZTogbGliZ2l0MiBzdGF0dXMgY2hlY2sgKHNpbmdsZSBzeXNjYWxsKS5cbiAqIEZhbGxiYWNrOiBgZ2l0IHN0YXR1cyAtLXNob3J0YCAoY2FjaGVkIGZvciAxMHMgcGVyIGJhc2VQYXRoKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUhhc0NoYW5nZXMoYmFzZVBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICByZXR1cm4gbmF0aXZlLmdpdEhhc0NoYW5nZXMoYmFzZVBhdGgpO1xuICB9XG5cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgaWYgKFxuICAgIGJhc2VQYXRoID09PSBfaGFzQ2hhbmdlc0NhY2hlZFBhdGggJiZcbiAgICBub3cgLSBfaGFzQ2hhbmdlc0NhY2hlZEF0IDwgSEFTX0NIQU5HRVNfQ0FDSEVfVFRMX01TXG4gICkge1xuICAgIHJldHVybiBfaGFzQ2hhbmdlc0NhY2hlZFJlc3VsdDtcbiAgfVxuXG4gIGNvbnN0IHJlc3VsdCA9IGdpdEV4ZWMoYmFzZVBhdGgsIFtcInN0YXR1c1wiLCBcIi0tc2hvcnRcIl0sIHRydWUpO1xuICBjb25zdCBoYXNDaGFuZ2VzID0gcmVzdWx0ICE9PSBcIlwiO1xuXG4gIF9oYXNDaGFuZ2VzQ2FjaGVkUmVzdWx0ID0gaGFzQ2hhbmdlcztcbiAgX2hhc0NoYW5nZXNDYWNoZWRBdCA9IG5vdztcbiAgX2hhc0NoYW5nZXNDYWNoZWRQYXRoID0gYmFzZVBhdGg7XG5cbiAgcmV0dXJuIGhhc0NoYW5nZXM7XG59XG5cbi8qKiBSZXNldCB0aGUgbmF0aXZlSGFzQ2hhbmdlcyBmYWxsYmFjayBjYWNoZSAoZXhwb3J0ZWQgZm9yIHRlc3RpbmcpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9yZXNldEhhc0NoYW5nZXNDYWNoZSgpOiB2b2lkIHtcbiAgX2hhc0NoYW5nZXNDYWNoZWRSZXN1bHQgPSBmYWxzZTtcbiAgX2hhc0NoYW5nZXNDYWNoZWRBdCA9IDA7XG4gIF9oYXNDaGFuZ2VzQ2FjaGVkUGF0aCA9IFwiXCI7XG59XG5cbi8qKlxuICogQ291bnQgY29tbWl0cyBiZXR3ZWVuIHR3byByZWZzIChmcm9tLi50bykuXG4gKiBOYXRpdmU6IGxpYmdpdDIgcmV2d2Fsay5cbiAqIEZhbGxiYWNrOiBgZ2l0IHJldi1saXN0IC0tY291bnQgZnJvbS4udG9gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlQ29tbWl0Q291bnRCZXR3ZWVuKGJhc2VQYXRoOiBzdHJpbmcsIGZyb21SZWY6IHN0cmluZywgdG9SZWY6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIHJldHVybiBuYXRpdmUuZ2l0Q29tbWl0Q291bnRCZXR3ZWVuKGJhc2VQYXRoLCBmcm9tUmVmLCB0b1JlZik7XG4gIH1cbiAgY29uc3QgcmVzdWx0ID0gZ2l0RXhlYyhiYXNlUGF0aCwgW1wicmV2LWxpc3RcIiwgXCItLWNvdW50XCIsIGAke2Zyb21SZWZ9Li4ke3RvUmVmfWBdLCB0cnVlKTtcbiAgcmV0dXJuIHBhcnNlSW50KHJlc3VsdCwgMTApIHx8IDA7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBOZXcgUmVhZCBGdW5jdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ2hlY2sgaWYgYSBwYXRoIGlzIGluc2lkZSBhIGdpdCByZXBvc2l0b3J5LlxuICogTmF0aXZlOiBSZXBvc2l0b3J5OjpvcGVuKCkgY2hlY2suXG4gKiBGYWxsYmFjazogYGdpdCByZXYtcGFyc2UgLS1naXQtZGlyYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUlzUmVwbyhiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIHJldHVybiBuYXRpdmUuZ2l0SXNSZXBvKGJhc2VQYXRoKTtcbiAgfVxuICB0cnkge1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJyZXYtcGFyc2VcIiwgXCItLWdpdC1kaXJcIl0sIHsgY3dkOiBiYXNlUGF0aCwgc3RkaW86IFwicGlwZVwiIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFJldHVybiB0cnVlIG9ubHkgd2hlbiB0aGUgcmVwb3NpdG9yeSBoYXMgYSByZWFjaGFibGUgY29tbWl0dGVkIEhFQUQuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlSGFzQ29tbWl0dGVkSGVhZChiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBcIi0tdmVyaWZ5XCIsIFwiSEVBRFwiXSwge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgICBlbnY6IEdJVF9OT19QUk9NUFRfRU5WLFxuICAgIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVjayBpZiB0aGVyZSBhcmUgc3RhZ2VkIGNoYW5nZXMgKGluZGV4IGRpZmZlcnMgZnJvbSBIRUFEKS5cbiAqIE5hdGl2ZTogbGliZ2l0MiB0cmVlLXRvLWluZGV4IGRpZmYuXG4gKiBGYWxsYmFjazogYGdpdCBkaWZmIC0tY2FjaGVkIC0tc3RhdGAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVIYXNTdGFnZWRDaGFuZ2VzKGJhc2VQYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgcmV0dXJuIG5hdGl2ZS5naXRIYXNTdGFnZWRDaGFuZ2VzKGJhc2VQYXRoKTtcbiAgfVxuICBjb25zdCByZXN1bHQgPSBnaXRFeGVjKGJhc2VQYXRoLCBbXCJkaWZmXCIsIFwiLS1jYWNoZWRcIiwgXCItLXN0YXRcIl0sIHRydWUpO1xuICByZXR1cm4gcmVzdWx0ICE9PSBcIlwiO1xufVxuXG4vKipcbiAqIEdldCBkaWZmIHN0YXRpc3RpY3MuXG4gKiBVc2UgZnJvbVJlZj1cIkhFQURcIiwgdG9SZWY9XCJXT1JLRElSXCIgZm9yIHdvcmtpbmcgdHJlZSBkaWZmLlxuICogVXNlIGZyb21SZWY9XCJIRUFEXCIsIHRvUmVmPVwiSU5ERVhcIiBmb3Igc3RhZ2VkIGRpZmYuXG4gKiBOYXRpdmU6IGxpYmdpdDIgZGlmZiBzdGF0cy5cbiAqIEZhbGxiYWNrOiBgZ2l0IGRpZmYgLS1zdGF0YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZURpZmZTdGF0KGJhc2VQYXRoOiBzdHJpbmcsIGZyb21SZWY6IHN0cmluZywgdG9SZWY6IHN0cmluZyk6IEdpdERpZmZTdGF0IHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgcmV0dXJuIG5hdGl2ZS5naXREaWZmU3RhdChiYXNlUGF0aCwgZnJvbVJlZiwgdG9SZWYpO1xuICB9XG5cbiAgLy8gRmFsbGJhY2tcbiAgbGV0IGFyZ3M6IHN0cmluZ1tdO1xuICBpZiAoZnJvbVJlZiA9PT0gXCJIRUFEXCIgJiYgdG9SZWYgPT09IFwiV09SS0RJUlwiKSB7XG4gICAgYXJncyA9IFtcImRpZmZcIiwgXCItLXN0YXRcIiwgXCJIRUFEXCJdO1xuICB9IGVsc2UgaWYgKGZyb21SZWYgPT09IFwiSEVBRFwiICYmIHRvUmVmID09PSBcIklOREVYXCIpIHtcbiAgICBhcmdzID0gW1wiZGlmZlwiLCBcIi0tc3RhdFwiLCBcIi0tY2FjaGVkXCIsIFwiSEVBRFwiXTtcbiAgfSBlbHNlIHtcbiAgICBhcmdzID0gW1wiZGlmZlwiLCBcIi0tc3RhdFwiLCBmcm9tUmVmLCB0b1JlZl07XG4gIH1cblxuICBjb25zdCByZXN1bHQgPSBnaXRFeGVjKGJhc2VQYXRoLCBhcmdzLCB0cnVlKTtcbiAgLy8gUGFyc2UgbnVtZXJpYyBzdGF0cyBmcm9tIHRoZSBzdW1tYXJ5IGxpbmUgKGUuZy4gXCIzIGZpbGVzIGNoYW5nZWQsIDEwIGluc2VydGlvbnMoKyksIDIgZGVsZXRpb25zKC0pXCIpXG4gIGxldCBmaWxlc0NoYW5nZWQgPSAwLCBpbnNlcnRpb25zID0gMCwgZGVsZXRpb25zID0gMDtcbiAgY29uc3Qgc3RhdHNNYXRjaCA9IHJlc3VsdC5tYXRjaCgvKFxcZCspIGZpbGVzPyBjaGFuZ2VkKD86LCAoXFxkKykgaW5zZXJ0aW9ucz9cXChcXCtcXCkpPyg/OiwgKFxcZCspIGRlbGV0aW9ucz9cXCgtXFwpKT8vKTtcbiAgaWYgKHN0YXRzTWF0Y2gpIHtcbiAgICBmaWxlc0NoYW5nZWQgPSBwYXJzZUludChzdGF0c01hdGNoWzFdID8/IFwiMFwiLCAxMCk7XG4gICAgaW5zZXJ0aW9ucyA9IHBhcnNlSW50KHN0YXRzTWF0Y2hbMl0gPz8gXCIwXCIsIDEwKTtcbiAgICBkZWxldGlvbnMgPSBwYXJzZUludChzdGF0c01hdGNoWzNdID8/IFwiMFwiLCAxMCk7XG4gIH1cbiAgcmV0dXJuIHsgZmlsZXNDaGFuZ2VkLCBpbnNlcnRpb25zLCBkZWxldGlvbnMsIHN1bW1hcnk6IHJlc3VsdCB9O1xufVxuXG4vKipcbiAqIEdldCBuYW1lLXN0YXR1cyBkaWZmIGJldHdlZW4gdHdvIHJlZnMgd2l0aCBvcHRpb25hbCBwYXRoc3BlYyBmaWx0ZXIuXG4gKiB1c2VNZXJnZUJhc2U6IGlmIHRydWUsIHVzZXMgdGhyZWUtZG90IHNlbWFudGljcyAobWFpbi4uLmJyYW5jaCkuXG4gKiBOYXRpdmU6IGxpYmdpdDIgdHJlZS10by10cmVlIGRpZmYuXG4gKiBGYWxsYmFjazogYGdpdCBkaWZmIC0tbmFtZS1zdGF0dXNgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlRGlmZk5hbWVTdGF0dXMoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGZyb21SZWY6IHN0cmluZyxcbiAgdG9SZWY6IHN0cmluZyxcbiAgcGF0aHNwZWM/OiBzdHJpbmcsXG4gIHVzZU1lcmdlQmFzZT86IGJvb2xlYW4sXG4pOiBHaXROYW1lU3RhdHVzW10ge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICByZXR1cm4gbmF0aXZlLmdpdERpZmZOYW1lU3RhdHVzKGJhc2VQYXRoLCBmcm9tUmVmLCB0b1JlZiwgcGF0aHNwZWMsIHVzZU1lcmdlQmFzZSk7XG4gIH1cblxuICAvLyBGYWxsYmFja1xuICBjb25zdCBzZXBhcmF0b3IgPSB1c2VNZXJnZUJhc2UgPyBcIi4uLlwiIDogXCIgXCI7XG4gIGNvbnN0IGFyZ3MgPSBbXCJkaWZmXCIsIFwiLS1uYW1lLXN0YXR1c1wiLCBgJHtmcm9tUmVmfSR7c2VwYXJhdG9yfSR7dG9SZWZ9YF07XG4gIGlmIChwYXRoc3BlYykgYXJncy5wdXNoKFwiLS1cIiwgcGF0aHNwZWMpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGdpdEV4ZWMoYmFzZVBhdGgsIGFyZ3MsIHRydWUpO1xuICBpZiAoIXJlc3VsdCkgcmV0dXJuIFtdO1xuXG4gIHJldHVybiByZXN1bHQuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pLm1hcChsaW5lID0+IHtcbiAgICBjb25zdCBbc3RhdHVzLCAuLi5wYXRoUGFydHNdID0gbGluZS5zcGxpdChcIlxcdFwiKTtcbiAgICByZXR1cm4geyBzdGF0dXM6IHN0YXR1cyA/PyBcIlwiLCBwYXRoOiBwYXRoUGFydHMuam9pbihcIlxcdFwiKSB9O1xuICB9KTtcbn1cblxuLyoqXG4gKiBHZXQgbnVtc3RhdCBkaWZmIGJldHdlZW4gdHdvIHJlZnMuXG4gKiB1c2VNZXJnZUJhc2U6IGlmIHRydWUsIHVzZXMgdGhyZWUtZG90IHNlbWFudGljcy5cbiAqIE5hdGl2ZTogbGliZ2l0MiBwYXRjaCBsaW5lIHN0YXRzLlxuICogRmFsbGJhY2s6IGBnaXQgZGlmZiAtLW51bXN0YXRgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlRGlmZk51bXN0YXQoYmFzZVBhdGg6IHN0cmluZywgZnJvbVJlZjogc3RyaW5nLCB0b1JlZjogc3RyaW5nLCB1c2VNZXJnZUJhc2U/OiBib29sZWFuKTogR2l0TnVtc3RhdFtdIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlICYmICF1c2VNZXJnZUJhc2UpIHtcbiAgICByZXR1cm4gbmF0aXZlLmdpdERpZmZOdW1zdGF0KGJhc2VQYXRoLCBmcm9tUmVmLCB0b1JlZik7XG4gIH1cblxuICBjb25zdCByZWZzcGVjID0gdXNlTWVyZ2VCYXNlID8gYCR7ZnJvbVJlZn0uLi4ke3RvUmVmfWAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGFyZ3MgPSByZWZzcGVjXG4gICAgPyBbXCJkaWZmXCIsIFwiLS1udW1zdGF0XCIsIHJlZnNwZWNdXG4gICAgOiBbXCJkaWZmXCIsIFwiLS1udW1zdGF0XCIsIGZyb21SZWYsIHRvUmVmXTtcbiAgY29uc3QgcmVzdWx0ID0gZ2l0RXhlYyhiYXNlUGF0aCwgYXJncywgdHJ1ZSk7XG4gIGlmICghcmVzdWx0KSByZXR1cm4gW107XG5cbiAgcmV0dXJuIHJlc3VsdC5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbikubWFwKGxpbmUgPT4ge1xuICAgIGNvbnN0IFthLCByLCAuLi5wYXRoUGFydHNdID0gbGluZS5zcGxpdChcIlxcdFwiKTtcbiAgICByZXR1cm4ge1xuICAgICAgYWRkZWQ6IGEgPT09IFwiLVwiID8gMCA6IHBhcnNlSW50KGEgPz8gXCIwXCIsIDEwKSxcbiAgICAgIHJlbW92ZWQ6IHIgPT09IFwiLVwiID8gMCA6IHBhcnNlSW50KHIgPz8gXCIwXCIsIDEwKSxcbiAgICAgIHBhdGg6IHBhdGhQYXJ0cy5qb2luKFwiXFx0XCIpLFxuICAgIH07XG4gIH0pO1xufVxuXG4vKipcbiAqIEdldCB1bmlmaWVkIGRpZmYgY29udGVudCBiZXR3ZWVuIHR3byByZWZzLlxuICogdXNlTWVyZ2VCYXNlOiBpZiB0cnVlLCB1c2VzIHRocmVlLWRvdCBzZW1hbnRpY3MuXG4gKiBOYXRpdmU6IGxpYmdpdDIgZGlmZiBwcmludC5cbiAqIEZhbGxiYWNrOiBgZ2l0IGRpZmZgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlRGlmZkNvbnRlbnQoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGZyb21SZWY6IHN0cmluZyxcbiAgdG9SZWY6IHN0cmluZyxcbiAgcGF0aHNwZWM/OiBzdHJpbmcsXG4gIGV4Y2x1ZGU/OiBzdHJpbmcsXG4gIHVzZU1lcmdlQmFzZT86IGJvb2xlYW4sXG4pOiBzdHJpbmcge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICByZXR1cm4gbmF0aXZlLmdpdERpZmZDb250ZW50KGJhc2VQYXRoLCBmcm9tUmVmLCB0b1JlZiwgcGF0aHNwZWMsIGV4Y2x1ZGUsIHVzZU1lcmdlQmFzZSk7XG4gIH1cblxuICBjb25zdCBzZXBhcmF0b3IgPSB1c2VNZXJnZUJhc2UgPyBcIi4uLlwiIDogXCIgXCI7XG4gIGNvbnN0IGFyZ3MgPSBbXCJkaWZmXCIsIGAke2Zyb21SZWZ9JHtzZXBhcmF0b3J9JHt0b1JlZn1gXTtcbiAgaWYgKHBhdGhzcGVjKSB7XG4gICAgYXJncy5wdXNoKFwiLS1cIiwgcGF0aHNwZWMpO1xuICB9IGVsc2UgaWYgKGV4Y2x1ZGUpIHtcbiAgICBhcmdzLnB1c2goXCItLVwiLCBcIi5cIiwgYDooZXhjbHVkZSkke2V4Y2x1ZGV9YCk7XG4gIH1cblxuICByZXR1cm4gZ2l0RXhlYyhiYXNlUGF0aCwgYXJncywgdHJ1ZSk7XG59XG5cbi8qKlxuICogR2V0IGNvbW1pdCBsb2cgYmV0d2VlbiB0d28gcmVmcyAoZnJvbS4udG8pLlxuICogTmF0aXZlOiBsaWJnaXQyIHJldndhbGsuXG4gKiBGYWxsYmFjazogYGdpdCBsb2cgLS1vbmVsaW5lIGZyb20uLnRvYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUxvZ09uZWxpbmUoYmFzZVBhdGg6IHN0cmluZywgZnJvbVJlZjogc3RyaW5nLCB0b1JlZjogc3RyaW5nKTogR2l0TG9nRW50cnlbXSB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIHJldHVybiBuYXRpdmUuZ2l0TG9nT25lbGluZShiYXNlUGF0aCwgZnJvbVJlZiwgdG9SZWYpO1xuICB9XG5cbiAgY29uc3QgcmVzdWx0ID0gZ2l0RXhlYyhiYXNlUGF0aCwgW1wibG9nXCIsIFwiLS1vbmVsaW5lXCIsIGAke2Zyb21SZWZ9Li4ke3RvUmVmfWBdLCB0cnVlKTtcbiAgaWYgKCFyZXN1bHQpIHJldHVybiBbXTtcblxuICByZXR1cm4gcmVzdWx0LnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKS5tYXAobGluZSA9PiB7XG4gICAgY29uc3Qgc2hhID0gbGluZS5zdWJzdHJpbmcoMCwgNyk7XG4gICAgY29uc3QgbWVzc2FnZSA9IGxpbmUuc3Vic3RyaW5nKDgpO1xuICAgIHJldHVybiB7IHNoYSwgbWVzc2FnZSB9O1xuICB9KTtcbn1cblxuLyoqXG4gKiBMaXN0IGdpdCB3b3JrdHJlZXMuXG4gKiBOYXRpdmU6IGxpYmdpdDIgd29ya3RyZWUgQVBJLlxuICogRmFsbGJhY2s6IGBnaXQgd29ya3RyZWUgbGlzdCAtLXBvcmNlbGFpbmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVXb3JrdHJlZUxpc3QoYmFzZVBhdGg6IHN0cmluZyk6IEdpdFdvcmt0cmVlRW50cnlbXSB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIHJldHVybiBuYXRpdmUuZ2l0V29ya3RyZWVMaXN0KGJhc2VQYXRoKTtcbiAgfVxuXG4gIGNvbnN0IHJlc3VsdCA9IGdpdEV4ZWMoYmFzZVBhdGgsIFtcIndvcmt0cmVlXCIsIFwibGlzdFwiLCBcIi0tcG9yY2VsYWluXCJdLCB0cnVlKTtcbiAgaWYgKCFyZXN1bHQpIHJldHVybiBbXTtcblxuICBjb25zdCBlbnRyaWVzOiBHaXRXb3JrdHJlZUVudHJ5W10gPSBbXTtcbiAgY29uc3QgYmxvY2tzID0gcmVzdWx0LnJlcGxhY2VBbGwoXCJcXHJcXG5cIiwgXCJcXG5cIikuc3BsaXQoXCJcXG5cXG5cIikuZmlsdGVyKEJvb2xlYW4pO1xuXG4gIGZvciAoY29uc3QgYmxvY2sgb2YgYmxvY2tzKSB7XG4gICAgY29uc3QgbGluZXMgPSBibG9jay5zcGxpdChcIlxcblwiKTtcbiAgICBjb25zdCB3dExpbmUgPSBsaW5lcy5maW5kKGwgPT4gbC5zdGFydHNXaXRoKFwid29ya3RyZWUgXCIpKTtcbiAgICBjb25zdCBicmFuY2hMaW5lID0gbGluZXMuZmluZChsID0+IGwuc3RhcnRzV2l0aChcImJyYW5jaCBcIikpO1xuICAgIGNvbnN0IGlzQmFyZSA9IGxpbmVzLnNvbWUobCA9PiBsID09PSBcImJhcmVcIik7XG5cbiAgICBpZiAod3RMaW5lKSB7XG4gICAgICBlbnRyaWVzLnB1c2goe1xuICAgICAgICBwYXRoOiB3dExpbmUucmVwbGFjZShcIndvcmt0cmVlIFwiLCBcIlwiKSxcbiAgICAgICAgYnJhbmNoOiBicmFuY2hMaW5lID8gYnJhbmNoTGluZS5yZXBsYWNlKFwiYnJhbmNoIHJlZnMvaGVhZHMvXCIsIFwiXCIpIDogXCJcIixcbiAgICAgICAgaXNCYXJlLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGVudHJpZXM7XG59XG5cbi8qKlxuICogTGlzdCBicmFuY2hlcyBtYXRjaGluZyBhbiBvcHRpb25hbCBwYXR0ZXJuLlxuICogTmF0aXZlOiBsaWJnaXQyIGJyYW5jaCBpdGVyYXRvci5cbiAqIEZhbGxiYWNrOiBgZ2l0IGJyYW5jaCAtLWxpc3QgPHBhdHRlcm4+YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUJyYW5jaExpc3QoYmFzZVBhdGg6IHN0cmluZywgcGF0dGVybj86IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgcmV0dXJuIG5hdGl2ZS5naXRCcmFuY2hMaXN0KGJhc2VQYXRoLCBwYXR0ZXJuKTtcbiAgfVxuXG4gIGNvbnN0IGFyZ3MgPSBbXCJicmFuY2hcIiwgXCItLWxpc3RcIl07XG4gIGlmIChwYXR0ZXJuKSBhcmdzLnB1c2gocGF0dGVybik7XG5cbiAgY29uc3QgcmVzdWx0ID0gZ2l0RmlsZUV4ZWMoYmFzZVBhdGgsIGFyZ3MsIHRydWUpO1xuICBpZiAoIXJlc3VsdCkgcmV0dXJuIFtdO1xuXG4gIHJldHVybiByZXN1bHQuc3BsaXQoXCJcXG5cIikubWFwKGIgPT4gYi50cmltKCkucmVwbGFjZSgvXlxcKiAvLCBcIlwiKSkuZmlsdGVyKEJvb2xlYW4pO1xufVxuXG4vKipcbiAqIExpc3QgYnJhbmNoZXMgbWVyZ2VkIGludG8gdGFyZ2V0LlxuICogTmF0aXZlOiBsaWJnaXQyIG1lcmdlLWJhc2UgY2hlY2suXG4gKiBGYWxsYmFjazogYGdpdCBicmFuY2ggLS1tZXJnZWQgPHRhcmdldD4gLS1saXN0IDxwYXR0ZXJuPmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVCcmFuY2hMaXN0TWVyZ2VkKGJhc2VQYXRoOiBzdHJpbmcsIHRhcmdldDogc3RyaW5nLCBwYXR0ZXJuPzogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICByZXR1cm4gbmF0aXZlLmdpdEJyYW5jaExpc3RNZXJnZWQoYmFzZVBhdGgsIHRhcmdldCwgcGF0dGVybik7XG4gIH1cblxuICBjb25zdCBhcmdzID0gW1wiYnJhbmNoXCIsIFwiLS1tZXJnZWRcIiwgdGFyZ2V0XTtcbiAgaWYgKHBhdHRlcm4pIGFyZ3MucHVzaChcIi0tbGlzdFwiLCBwYXR0ZXJuKTtcblxuICBjb25zdCByZXN1bHQgPSBnaXRGaWxlRXhlYyhiYXNlUGF0aCwgYXJncywgdHJ1ZSk7XG4gIGlmICghcmVzdWx0KSByZXR1cm4gW107XG5cbiAgcmV0dXJuIHJlc3VsdC5zcGxpdChcIlxcblwiKS5tYXAoYiA9PiBiLnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pO1xufVxuXG4vKipcbiAqIExpc3QgdHJhY2tlZCBmaWxlcyBtYXRjaGluZyBhIHBhdGhzcGVjLlxuICogTmF0aXZlOiBsaWJnaXQyIGluZGV4IGl0ZXJhdGlvbi5cbiAqIEZhbGxiYWNrOiBgZ2l0IGxzLWZpbGVzIDxwYXRoc3BlYz5gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlTHNGaWxlcyhiYXNlUGF0aDogc3RyaW5nLCBwYXRoc3BlYzogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICByZXR1cm4gbmF0aXZlLmdpdExzRmlsZXMoYmFzZVBhdGgsIHBhdGhzcGVjKTtcbiAgfVxuXG4gIGNvbnN0IHJlc3VsdCA9IGdpdEZpbGVFeGVjKGJhc2VQYXRoLCBbXCJscy1maWxlc1wiLCBwYXRoc3BlY10sIHRydWUpO1xuICBpZiAoIXJlc3VsdCkgcmV0dXJuIFtdO1xuICByZXR1cm4gcmVzdWx0LnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKTtcbn1cblxuLyoqXG4gKiBMaXN0IHJlZmVyZW5jZXMgbWF0Y2hpbmcgYSBwcmVmaXguXG4gKiBOYXRpdmU6IGxpYmdpdDIgcmVmZXJlbmNlc19nbG9iLlxuICogRmFsbGJhY2s6IGBnaXQgZm9yLWVhY2gtcmVmIDxwcmVmaXg+IC0tZm9ybWF0PSUocmVmbmFtZSlgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlRm9yRWFjaFJlZihiYXNlUGF0aDogc3RyaW5nLCBwcmVmaXg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgcmV0dXJuIG5hdGl2ZS5naXRGb3JFYWNoUmVmKGJhc2VQYXRoLCBwcmVmaXgpO1xuICB9XG5cbiAgY29uc3QgcmVzdWx0ID0gZ2l0RmlsZUV4ZWMoYmFzZVBhdGgsIFtcImZvci1lYWNoLXJlZlwiLCBwcmVmaXgsIFwiLS1mb3JtYXQ9JShyZWZuYW1lKVwiXSwgdHJ1ZSk7XG4gIGlmICghcmVzdWx0KSByZXR1cm4gW107XG4gIHJldHVybiByZXN1bHQuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pO1xufVxuXG4vKipcbiAqIEdldCBsaXN0IG9mIGZpbGVzIHdpdGggdW5tZXJnZWQgKGNvbmZsaWN0KSBlbnRyaWVzLlxuICogTmF0aXZlOiBsaWJnaXQyIGluZGV4IGNvbmZsaWN0cy5cbiAqIEZhbGxiYWNrOiBgZ2l0IGRpZmYgLS1uYW1lLW9ubHkgLS1kaWZmLWZpbHRlcj1VYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUNvbmZsaWN0RmlsZXMoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgcmV0dXJuIG5hdGl2ZS5naXRDb25mbGljdEZpbGVzKGJhc2VQYXRoKTtcbiAgfVxuXG4gIGNvbnN0IHJlc3VsdCA9IGdpdEV4ZWMoYmFzZVBhdGgsIFtcImRpZmZcIiwgXCItLW5hbWUtb25seVwiLCBcIi0tZGlmZi1maWx0ZXI9VVwiXSwgdHJ1ZSk7XG4gIGlmICghcmVzdWx0KSByZXR1cm4gW107XG4gIHJldHVybiByZXN1bHQuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pO1xufVxuXG4vKipcbiAqIEdldCBiYXRjaCBpbmZvOiBicmFuY2ggKyBzdGF0dXMgKyBjaGFuZ2UgY291bnRzIGluIE9ORSBjYWxsLlxuICogTmF0aXZlOiBzaW5nbGUgbGliZ2l0MiBjYWxsIHJlcGxhY2VzIDMtNCBzZXF1ZW50aWFsIGV4ZWNTeW5jIGNhbGxzLlxuICogRmFsbGJhY2s6IG11bHRpcGxlIGdpdCBjb21tYW5kcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUJhdGNoSW5mbyhiYXNlUGF0aDogc3RyaW5nKTogR2l0QmF0Y2hJbmZvIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgcmV0dXJuIG5hdGl2ZS5naXRCYXRjaEluZm8oYmFzZVBhdGgpO1xuICB9XG5cbiAgY29uc3QgYnJhbmNoID0gZ2l0RXhlYyhiYXNlUGF0aCwgW1wiYnJhbmNoXCIsIFwiLS1zaG93LWN1cnJlbnRcIl0sIHRydWUpO1xuICBjb25zdCBzdGF0dXMgPSBnaXRFeGVjKGJhc2VQYXRoLCBbXCJzdGF0dXNcIiwgXCItLXBvcmNlbGFpblwiXSwgdHJ1ZSk7XG4gIGNvbnN0IGhhc0NoYW5nZXMgPSBzdGF0dXMgIT09IFwiXCI7XG5cbiAgLy8gUGFyc2UgcG9yY2VsYWluIHN0YXR1cyB0byBjb3VudCBzdGFnZWQgdnMgdW5zdGFnZWQgY2hhbmdlc1xuICBsZXQgc3RhZ2VkQ291bnQgPSAwO1xuICBsZXQgdW5zdGFnZWRDb3VudCA9IDA7XG4gIGlmIChzdGF0dXMpIHtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2Ygc3RhdHVzLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICBpZiAoIWxpbmUgfHwgbGluZS5sZW5ndGggPCAyKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHggPSBsaW5lWzBdOyAvLyBpbmRleCAoc3RhZ2VkKSBzdGF0dXNcbiAgICAgIGNvbnN0IHkgPSBsaW5lWzFdOyAvLyB3b3JrdHJlZSAodW5zdGFnZWQpIHN0YXR1c1xuICAgICAgaWYgKHggIT09IFwiIFwiICYmIHggIT09IFwiP1wiKSBzdGFnZWRDb3VudCsrO1xuICAgICAgaWYgKHkgIT09IFwiIFwiICYmIHkgIT09IFwiP1wiKSB1bnN0YWdlZENvdW50Kys7XG4gICAgICBpZiAoeCA9PT0gXCI/XCIgJiYgeSA9PT0gXCI/XCIpIHVuc3RhZ2VkQ291bnQrKzsgLy8gdW50cmFja2VkIGZpbGVzXG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBicmFuY2gsXG4gICAgaGFzQ2hhbmdlcyxcbiAgICBzdGF0dXMsXG4gICAgc3RhZ2VkQ291bnQsXG4gICAgdW5zdGFnZWRDb3VudCxcbiAgfTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFdyaXRlIEZ1bmN0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBJbml0aWFsaXplIGEgbmV3IGdpdCByZXBvc2l0b3J5LlxuICogTmF0aXZlOiBsaWJnaXQyIFJlcG9zaXRvcnk6OmluaXQuXG4gKiBGYWxsYmFjazogYGdpdCBpbml0IC1iIDxicmFuY2g+YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUluaXQoYmFzZVBhdGg6IHN0cmluZywgaW5pdGlhbEJyYW5jaD86IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICBuYXRpdmUuZ2l0SW5pdChiYXNlUGF0aCwgaW5pdGlhbEJyYW5jaCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYXJncyA9IFtcImluaXRcIl07XG4gIGlmIChpbml0aWFsQnJhbmNoKSBhcmdzLnB1c2goXCItYlwiLCBpbml0aWFsQnJhbmNoKTtcbiAgZ2l0RmlsZUV4ZWMoYmFzZVBhdGgsIGFyZ3MpO1xufVxuXG4vKipcbiAqIFN0YWdlIGFsbCBmaWxlcyAoZ2l0IGFkZCAtQSkuXG4gKiBOYXRpdmU6IGxpYmdpdDIgaW5kZXggYWRkX2FsbCArIHVwZGF0ZV9hbGwuXG4gKiBGYWxsYmFjazogYGdpdCBhZGQgLUFgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlQWRkQWxsKGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgbmF0aXZlLmdpdEFkZEFsbChiYXNlUGF0aCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGdpdEZpbGVFeGVjKGJhc2VQYXRoLCBbXCJhZGRcIiwgXCItQVwiXSk7XG59XG5cbi8qKlxuICogU3RhZ2Ugb25seSBhbHJlYWR5LXRyYWNrZWQgZmlsZXMgKGdpdCBhZGQgLXUpLlxuICogRG9lcyBOT1QgYWRkIG5ldyB1bnRyYWNrZWQgZmlsZXMgXHUyMDE0IG9ubHkgdXBkYXRlcyBtb2RpZmljYXRpb25zIGFuZCBkZWxldGlvbnNcbiAqIGZvciBmaWxlcyBnaXQgYWxyZWFkeSBrbm93cyBhYm91dC4gU2FmZSBmb3IgYXV0b21hdGVkIHNuYXBzaG90cyB3aGVyZVxuICogcHVsbGluZyBpbiB1bmtub3duIHVudHJhY2tlZCBmaWxlcyAoc2VjcmV0cywgYmluYXJpZXMpIHdvdWxkIGJlIGRhbmdlcm91cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUFkZFRyYWNrZWQoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBnaXRGaWxlRXhlYyhiYXNlUGF0aCwgW1wiYWRkXCIsIFwiLXVcIl0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlSXNJZ25vcmVkKGJhc2VQYXRoOiBzdHJpbmcsIHBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVjay1pZ25vcmVcIiwgXCItcVwiLCBcIi0tXCIsIHBhdGhdLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgc3RkaW86IFwicGlwZVwiLFxuICAgICAgZW52OiBHSVRfTk9fUFJPTVBUX0VOVixcbiAgICB9KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmZ1bmN0aW9uIGlzRG90R3NkSWdub3JlZChiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBbXCIuZ3NkXCIsIFwiLmdzZC9cIl0uc29tZShwYXRoID0+IG5hdGl2ZUlzSWdub3JlZChiYXNlUGF0aCwgcGF0aCkpO1xufVxuXG4vKipcbiAqIERldGVybWluZSB3aGV0aGVyIHRoZSBwcm9qZWN0IG9wdHMgb3V0IG9mIEdTRC1tYW5hZ2VkIGAuZ2l0aWdub3JlYCB2aWFcbiAqIGBnaXQubWFuYWdlX2dpdGlnbm9yZTogZmFsc2VgIGluIGAuZ3NkL1BSRUZFUkVOQ0VTLm1kYC4gVXNlcyBhIG1pbmltYWxcbiAqIGlubGluZSBwYXJzZXIgdG8gYXZvaWQgaW1wb3J0aW5nIHRoZSBmdWxsIHByZWZlcmVuY2VzIG1vZHVsZSAod2hpY2ggd291bGRcbiAqIGludHJvZHVjZSBhIGNpcmN1bGFyIGRlcGVuZGVuY3kgYmFjayBpbnRvIHRoaXMgbG93LWxldmVsIGJyaWRnZSkuXG4gKlxuICogUmV0dXJucyB0cnVlIHdoZW4gbWFuYWdlbWVudCBpcyBkaXNhYmxlZC4gQW55IHBhcnNlIGZhaWx1cmUgb3IgbWlzc2luZ1xuICogZmlsZSByZXR1cm5zIGZhbHNlIChkZWZhdWx0OiBHU0QgbWF5IG1hbmFnZSBgLmdpdGlnbm9yZWApLlxuICovXG5mdW5jdGlvbiBpc0dpdGlnbm9yZU1hbmFnZW1lbnREaXNhYmxlZChiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHByZWZzUGF0aCA9IGpvaW4oYmFzZVBhdGgsIFwiLmdzZFwiLCBcIlBSRUZFUkVOQ0VTLm1kXCIpO1xuICBpZiAoIWV4aXN0c1N5bmMocHJlZnNQYXRoKSkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMocHJlZnNQYXRoLCBcInV0Zi04XCIpO1xuICAgIC8vIExvb2sgZm9yIGBtYW5hZ2VfZ2l0aWdub3JlOiBmYWxzZWAgdW5kZXIgYSBgZ2l0OmAgYmxvY2suIFRoZSBwcmVmZXJlbmNlXG4gICAgLy8gaXMgaW5kZW50ZWQ7IGEgbG9vc2UgcmVnZXggaXMgc3VmZmljaWVudCBzaW5jZSB3ZSBvbmx5IGNhcmUgYWJvdXQgdGhlXG4gICAgLy8gZXhwbGljaXQgb3B0LW91dCBjYXNlLlxuICAgIHJldHVybiAvXlxccyptYW5hZ2VfZ2l0aWdub3JlXFxzKjpcXHMqZmFsc2VcXHMqJC9tLnRlc3QoY29udGVudCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIFNlbGYtaGVhbCBwYXRoIGZvciB0aGUgc3ltbGlua2VkLWAuZ3NkYCBzdGFnaW5nIGZhaWx1cmU6IGFwcGVuZCBgLmdzZGAgdG9cbiAqIGAuZ2l0aWdub3JlYCBzbyBzdWJzZXF1ZW50IGBnaXQgYWRkIC1BYCBjYWxscyBzdWNjZWVkIHdpdGhvdXQgdGhlIHN5bWxpbmtcbiAqIHBhdGhzcGVjIGVycm9yLiBIb25vcnMgdGhlIGBnaXQubWFuYWdlX2dpdGlnbm9yZTogZmFsc2VgIG9wdC1vdXQuXG4gKlxuICogUmV0dXJucyB0cnVlIHdoZW4gYC5naXRpZ25vcmVgIG5vdyBjb250YWlucyBhbiBlbnRyeSBjb3ZlcmluZyBgLmdzZGBcbiAqIChlaXRoZXIgcHJlLWV4aXN0aW5nIG9yIG5ld2x5IGFwcGVuZGVkKS4gUmV0dXJucyBmYWxzZSB3aGVuIHRoZSBvcHQtb3V0XG4gKiBpcyBzZXQgb3IgdGhlIHdyaXRlIGZhaWxzLlxuICovXG5mdW5jdGlvbiB0cnlTZWxmSGVhbEdzZEdpdGlnbm9yZShiYXNlUGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGlmIChpc0dpdGlnbm9yZU1hbmFnZW1lbnREaXNhYmxlZChiYXNlUGF0aCkpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBnaXRpZ25vcmVQYXRoID0gam9pbihiYXNlUGF0aCwgXCIuZ2l0aWdub3JlXCIpO1xuICB0cnkge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gZXhpc3RzU3luYyhnaXRpZ25vcmVQYXRoKSA/IHJlYWRGaWxlU3luYyhnaXRpZ25vcmVQYXRoLCBcInV0Zi04XCIpIDogXCJcIjtcbiAgICBjb25zdCBsaW5lcyA9IG5ldyBTZXQoXG4gICAgICBleGlzdGluZy5zcGxpdChcIlxcblwiKS5tYXAobCA9PiBsLnRyaW0oKSkuZmlsdGVyKGwgPT4gbCAmJiAhbC5zdGFydHNXaXRoKFwiI1wiKSksXG4gICAgKTtcbiAgICBpZiAobGluZXMuaGFzKFwiLmdzZFwiKSB8fCBsaW5lcy5oYXMoXCIuZ3NkL1wiKSkgcmV0dXJuIHRydWU7XG5cbiAgICBjb25zdCBwcmVmaXggPSBleGlzdGluZy5sZW5ndGggPiAwICYmICFleGlzdGluZy5lbmRzV2l0aChcIlxcblwiKSA/IFwiXFxuXCIgOiBcIlwiO1xuICAgIGNvbnN0IGJsb2NrID0gYCR7cHJlZml4fVxcbiMgXHUyNTAwXHUyNTAwIEdTRCBzZWxmLWhlYWw6IC5nc2QgaXMgYSBzeW1saW5rIHRvIGV4dGVybmFsIHN0YXRlIFx1MjUwMFx1MjUwMFxcbi5nc2RcXG5gO1xuICAgIHdyaXRlRmlsZVN5bmMoZ2l0aWdub3JlUGF0aCwgZXhpc3RpbmcgKyBibG9jaywgXCJ1dGYtOFwiKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogU3RhZ2UgdW50cmFja2VkIGZpbGVzIGluZGl2aWR1YWxseSB3aGlsZSBza2lwcGluZyBhbnl0aGluZyB1bmRlciBgLmdzZGAuXG4gKiBVc2VkIGFzIGEgbGFzdC1yZXNvcnQgd2hlbiBgLmdzZGAgaXMgYSBzeW1saW5rLCBub3QgZ2l0aWdub3JlZCwgYW5kXG4gKiBgZ2l0Lm1hbmFnZV9naXRpZ25vcmU6IGZhbHNlYCBmb3JiaWRzIHRoZSBzZWxmLWhlYWwgcGF0aC4gUHJvdGVjdHMgdXNlclxuICogd29yayBieSBuZXZlciBzaWxlbnRseSBkcm9wcGluZyBuZXcgcmVhbCBmaWxlcy5cbiAqL1xuZnVuY3Rpb24gc3RhZ2VVbnRyYWNrZWRFeGNsdWRpbmdEb3RHc2QoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICAvLyBTdGFnZSB0cmFja2VkIG1vZGlmaWNhdGlvbnMgZmlyc3QuIGBnaXQgYWRkIC11YCBuZXZlciBmYWlscyBvbiBwYXRoc3BlY1xuICAvLyBpc3N1ZXMgYmVjYXVzZSBpdCBkb2Vzbid0IHdhbGsgdW50cmFja2VkIHRyZWVzLlxuICBnaXRGaWxlRXhlYyhiYXNlUGF0aCwgW1wiYWRkXCIsIFwiLXVcIl0pO1xuXG4gIC8vIEVudW1lcmF0ZSB1bnRyYWNrZWQgcGF0aHMgdmlhIHBvcmNlbGFpbiBvdXRwdXQuIGA/PyBgIHByZWZpeCBtYXJrc1xuICAvLyB1bnRyYWNrZWQgZmlsZXMgKHN0YXR1cyByZXNwZWN0cyBgLmdpdGlnbm9yZWApLlxuICBjb25zdCBzdGF0dXMgPSBnaXRGaWxlRXhlYyhiYXNlUGF0aCwgW1wic3RhdHVzXCIsIFwiLS1wb3JjZWxhaW49djFcIiwgXCItelwiXSwgdHJ1ZSk7XG4gIGlmICghc3RhdHVzKSByZXR1cm47XG5cbiAgY29uc3QgdW50cmFja2VkOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHN0YXR1cy5zcGxpdChcIlxcMFwiKSkge1xuICAgIGlmICghZW50cnkpIGNvbnRpbnVlO1xuICAgIC8vIFBvcmNlbGFpbiBmb3JtYXQ6IFwiWFkgcGF0aFwiIHdoZXJlIFhZIGlzIHRoZSAyLWNoYXIgc3RhdHVzIGNvZGUuXG4gICAgaWYgKGVudHJ5Lmxlbmd0aCA8IDQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNvZGUgPSBlbnRyeS5zbGljZSgwLCAyKTtcbiAgICBjb25zdCBwYXRoID0gZW50cnkuc2xpY2UoMyk7XG4gICAgaWYgKGNvZGUgIT09IFwiPz9cIikgY29udGludWU7XG4gICAgLy8gU2tpcCBHU0QgcnVudGltZSBhcnRpZmFjdHMuIFVuZGVyIGBtYW5hZ2VfZ2l0aWdub3JlOiBmYWxzZWAgdGhlIHVzZXJcbiAgICAvLyBtYXkgbm90IGhhdmUgdGhlc2UgaW4gYC5naXRpZ25vcmVgLCBzbyB3ZSBmaWx0ZXIgZXhwbGljaXRseSB0byBhdm9pZFxuICAgIC8vIGNvbW1pdHRpbmcgdHJhbnNpZW50IHN0YXRlICguZ3NkIGV4dGVybmFsIGxpbmssIG1pZ3JhdGlvbiBsb2NrLFxuICAgIC8vIGJhY2tncm91bmQgc2hlbGwgc2NyYXRjaCBkaXIpLlxuICAgIGlmIChwYXRoID09PSBcIi5nc2RcIiB8fCBwYXRoLnN0YXJ0c1dpdGgoXCIuZ3NkL1wiKSkgY29udGludWU7XG4gICAgaWYgKHBhdGggPT09IFwiLmdzZC1pZFwiIHx8IHBhdGggPT09IFwiLmdzZC5taWdyYXRpbmdcIikgY29udGludWU7XG4gICAgaWYgKHBhdGggPT09IFwiLmJnLXNoZWxsXCIgfHwgcGF0aC5zdGFydHNXaXRoKFwiLmJnLXNoZWxsL1wiKSkgY29udGludWU7XG4gICAgdW50cmFja2VkLnB1c2gocGF0aCk7XG4gIH1cblxuICBpZiAodW50cmFja2VkLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAvLyBTdGFnZSBpbiBjaHVua3MgdG8gYXZvaWQgZXhjZWVkaW5nIEFSR19NQVggb24gbGFyZ2UgY2hhbmdlIHNldHMuXG4gIGNvbnN0IENIVU5LID0gMjAwO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHVudHJhY2tlZC5sZW5ndGg7IGkgKz0gQ0hVTkspIHtcbiAgICBnaXRGaWxlRXhlYyhiYXNlUGF0aCwgW1wiYWRkXCIsIFwiLS1cIiwgLi4udW50cmFja2VkLnNsaWNlKGksIGkgKyBDSFVOSyldKTtcbiAgfVxufVxuXG4vKipcbiAqIEhhbmRsZSBgbmF0aXZlQWRkQWxsV2l0aEV4Y2x1c2lvbnNgIGZhaWxpbmcgd2l0aCBcImJleW9uZCBhIHN5bWJvbGljIGxpbmtcIlxuICogd2hlbiBgLmdzZGAgaXMgYSBzeW1saW5rLiBTZWxmLWhlYWxzIGJ5IGFkZGluZyBgLmdzZGAgdG8gYC5naXRpZ25vcmVgLCBvclxuICogZmFsbHMgYmFjayB0byBleHBsaWNpdCBwZXItZmlsZSBzdGFnaW5nIHNvIHVzZXIgd29yayBpcyBuZXZlciBkcm9wcGVkLlxuICovXG5mdW5jdGlvbiBmYWxsYmFja1N0YWdlV2l0aFN5bWxpbmtlZERvdEdzZChiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGlmIChpc0RvdEdzZElnbm9yZWQoYmFzZVBhdGgpKSB7XG4gICAgZ2l0RmlsZUV4ZWMoYmFzZVBhdGgsIFtcImFkZFwiLCBcIi1BXCJdKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHRyeVNlbGZIZWFsR3NkR2l0aWdub3JlKGJhc2VQYXRoKSkge1xuICAgIGdpdEZpbGVFeGVjKGJhc2VQYXRoLCBbXCJhZGRcIiwgXCItQVwiXSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIGBtYW5hZ2VfZ2l0aWdub3JlOiBmYWxzZWAgXHUyMDE0IHByb3RlY3Qgd29yayBieSBzdGFnaW5nIGZpbGVzIGV4cGxpY2l0bHkuXG4gIHN0YWdlVW50cmFja2VkRXhjbHVkaW5nRG90R3NkKGJhc2VQYXRoKTtcbn1cblxuLyoqXG4gKiBTdGFnZSBhbGwgZmlsZXMgd2l0aCBwYXRoc3BlYyBleGNsdXNpb25zIChnaXQgYWRkIC1BIC0tICc6IXBhdHRlcm4nIC4uLikuXG4gKiBFeGNsdWRlZCBwYXRocyBhcmUgbmV2ZXIgaGFzaGVkIGJ5IGdpdCwgcHJldmVudGluZyBoYW5ncyBvbiBsYXJnZVxuICogdW50cmFja2VkIGFydGlmYWN0IHRyZWVzICg1N0dCKywgMTFLKyBmaWxlcykuIFNlZSAjMTYwNS5cbiAqXG4gKiBGYWxscyBiYWNrIHRvIHBsYWluIGBnaXQgYWRkIC1BYCB3aGVuIG5vIGV4Y2x1c2lvbnMgYXJlIHByb3ZpZGVkLlxuICogQWx3YXlzIHVzZXMgdGhlIENMSSBwYXRoIChub3QgbGliZ2l0MikgYmVjYXVzZSBsaWJnaXQyJ3MgYWRkX2FsbFxuICogZG9lcyBub3Qgc3VwcG9ydCBwYXRoc3BlYyBleGNsdXNpb24gc3ludGF4LlxuICpcbiAqIFdoZW4gZXhjbHVkZWQgcGF0aHMgYXJlIGFscmVhZHkgY292ZXJlZCBieSAuZ2l0aWdub3JlLCBnaXQgbWF5IGV4aXRcbiAqIHdpdGggY29kZSAxIGFuZCBhbiBcImlnbm9yZWQgYnkgLmdpdGlnbm9yZVwiIHdhcm5pbmcuIFRoaXMgaXMgaGFybWxlc3NcbiAqICh0aGUgc3RhZ2luZyBzdWNjZWVkcyBmb3IgYWxsIG5vbi1pZ25vcmVkIGZpbGVzKSBhbmQgaXMgc3VwcHJlc3NlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUFkZEFsbFdpdGhFeGNsdXNpb25zKGJhc2VQYXRoOiBzdHJpbmcsIGV4Y2x1c2lvbnM6IHJlYWRvbmx5IHN0cmluZ1tdKTogdm9pZCB7XG4gIGlmIChleGNsdXNpb25zLmxlbmd0aCA9PT0gMCkge1xuICAgIG5hdGl2ZUFkZEFsbChiYXNlUGF0aCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHBhdGhzcGVjcyA9IGV4Y2x1c2lvbnMubWFwKGUgPT4gYDohJHtlfWApO1xuICB0cnkge1xuICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJhZGRcIiwgXCItQVwiLCBcIi0tXCIsIC4uLnBhdGhzcGVjc10sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgZW52OiBHSVRfTk9fUFJPTVBUX0VOVixcbiAgICB9KTtcbiAgfSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG4gICAgY29uc3Qgc3RkZXJyID0gKGVyciBhcyB7IHN0ZGVycj86IHN0cmluZyB9KT8uc3RkZXJyID8/IFwiXCI7XG4gICAgY29uc3QgaW5mcmFDb2RlID0gaXNJbmZyYXN0cnVjdHVyZUVycm9yKGVycikgPz8gaXNJbmZyYXN0cnVjdHVyZUVycm9yKHN0ZGVycik7XG4gICAgaWYgKGluZnJhQ29kZSkge1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cbiAgICAvLyBnaXQgZXhpdHMgMSB3aGVuIHBhdGhzcGVjIGV4Y2x1c2lvbnMgcmVmZXJlbmNlIHBhdGhzIGFscmVhZHkgY292ZXJlZFxuICAgIC8vIGJ5IC5naXRpZ25vcmUuIFRoZSBzdGFnaW5nIGl0c2VsZiBzdWNjZWVkcyBcdTIwMTQgb25seSBzdXBwcmVzcyB0aGF0IGNhc2UuXG4gICAgaWYgKHN0ZGVyci5pbmNsdWRlcyhcImlnbm9yZWQgYnkgb25lIG9mIHlvdXIgLmdpdGlnbm9yZSBmaWxlc1wiKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICAvLyBXaGVuIC5nc2QgaXMgYSBzeW1saW5rLCBnaXQgcmVqZWN0cyBgOiEuZ3NkLy4uLmAgcGF0aHNwZWNzIHdpdGhcbiAgICAvLyBcImJleW9uZCBhIHN5bWJvbGljIGxpbmtcIi4gSGFuZCBvZmYgdG8gdGhlIHNlbGYtaGVhbCBmYWxsYmFjayB3aGljaFxuICAgIC8vIGVpdGhlciBhZGRzIGAuZ3NkYCB0byBgLmdpdGlnbm9yZWAgYW5kIHJldHJpZXMgYGdpdCBhZGQgLUFgLCBvciBzdGFnZXNcbiAgICAvLyByZWFsIGZpbGVzIGV4cGxpY2l0bHkgd2hlbiBgZ2l0Lm1hbmFnZV9naXRpZ25vcmU6IGZhbHNlYCBmb3JiaWRzIHRoZVxuICAgIC8vIHNlbGYtaGVhbCBwYXRoLiBFaXRoZXIgd2F5LCB1c2VyIHdvcmsgaXMgcHJvdGVjdGVkIGZyb20gc2lsZW50IGRyb3BzLlxuICAgIGlmIChzdGRlcnIuaW5jbHVkZXMoXCJiZXlvbmQgYSBzeW1ib2xpYyBsaW5rXCIpKSB7XG4gICAgICBmYWxsYmFja1N0YWdlV2l0aFN5bWxpbmtlZERvdEdzZChiYXNlUGF0aCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHN0ZGVyckRldGFpbCA9IHN0ZGVyci50cmltKCkgPyBgOyBzdGRlcnI6ICR7c3RkZXJyLnRyaW0oKX1gIDogXCJcIjtcbiAgICB0aHJvdyBuZXcgR1NERXJyb3IoR1NEX0dJVF9FUlJPUiwgYGdpdCBhZGQgLUEgd2l0aCBleGNsdXNpb25zIGZhaWxlZCBpbiAke2Jhc2VQYXRofTogJHtnZXRFcnJvck1lc3NhZ2UoZXJyKX0ke3N0ZGVyckRldGFpbH1gKTtcbiAgfVxufVxuXG4vKipcbiAqIFN0YWdlIHNwZWNpZmljIGZpbGVzLlxuICogTmF0aXZlOiBsaWJnaXQyIGluZGV4IGFkZC5cbiAqIEZhbGxiYWNrOiBgZ2l0IGFkZCAtLSA8cGF0aHM+YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUFkZFBhdGhzKGJhc2VQYXRoOiBzdHJpbmcsIHBhdGhzOiBzdHJpbmdbXSk6IHZvaWQge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICBuYXRpdmUuZ2l0QWRkUGF0aHMoYmFzZVBhdGgsIHBhdGhzKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZ2l0RmlsZUV4ZWMoYmFzZVBhdGgsIFtcImFkZFwiLCBcIi0tXCIsIC4uLnBhdGhzXSk7XG59XG5cbi8qKlxuICogVW5zdGFnZSBmaWxlcyAocmVzZXQgaW5kZXggZW50cmllcyB0byBIRUFEKS5cbiAqIE5hdGl2ZTogbGliZ2l0MiByZXNldF9kZWZhdWx0LlxuICogRmFsbGJhY2s6IGBnaXQgcmVzZXQgSEVBRCAtLSA8cGF0aHM+YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZVJlc2V0UGF0aHMoYmFzZVBhdGg6IHN0cmluZywgcGF0aHM6IHN0cmluZ1tdKTogdm9pZCB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIG5hdGl2ZS5naXRSZXNldFBhdGhzKGJhc2VQYXRoLCBwYXRocyk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3QgcCBvZiBwYXRocykge1xuICAgIGdpdEV4ZWMoYmFzZVBhdGgsIFtcInJlc2V0XCIsIFwiSEVBRFwiLCBcIi0tXCIsIHBdLCB0cnVlKTtcbiAgfVxufVxuXG4vKipcbiAqIENyZWF0ZSBhIGNvbW1pdCBmcm9tIHRoZSBjdXJyZW50IGluZGV4LlxuICogUmV0dXJucyB0aGUgY29tbWl0IFNIQSBvbiBzdWNjZXNzLCBvciBudWxsIGlmIG5vdGhpbmcgdG8gY29tbWl0LlxuICogVXNlcyBgZ2l0IGNvbW1pdCAtRiAtYCBzbyBub3JtYWwgdXNlciBob29rcyBydW4gYW5kIGNvbW1pdC5ncGdzaWduIGlzIGhvbm9yZWQuXG4gKlxuICogVGhlIGZhbGxiYWNrIGludGVudGlvbmFsbHkgZG9lcyBOT1QgdXNlIC0tbm8tdmVyaWZ5IFx1MjAxNCB1c2VyIHByZS1jb21taXQgL1xuICogY29tbWl0LW1zZyAvIHByZXBhcmUtY29tbWl0LW1zZyBob29rcyBtdXN0IGZpcmUgb24gZXZlcnkgR1NELWF1dG9tYXRlZFxuICogY29tbWl0LiAoSXNzdWUgIzQ5ODAgQ1JJVC0xKVxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlQ29tbWl0KFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtZXNzYWdlOiBzdHJpbmcsXG4gIG9wdGlvbnM/OiB7IGFsbG93RW1wdHk/OiBib29sZWFuOyBpbnB1dD86IHN0cmluZyB9LFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIC8vIFVzZSBnaXQgQ0xJIHdpdGggc3RkaW4gcGlwZSBmb3Igc2FmZSBtdWx0aS1saW5lIG1lc3NhZ2VzLiBIb29rcyBydW47XG4gIC8vIGNvbW1pdC5ncGdzaWduIGhvbm9yZWQuIGxpYmdpdDIgY29tbWl0LWNyZWF0ZSBieXBhc3NlcyBob29rcywgc28gYXV0b21hdGVkXG4gIC8vIEdTRCBjb21taXRzIGludGVudGlvbmFsbHkgc3RheSBvbiB0aGUgQ0xJIHBhdGggZXZlbiB3aGVuIG5hdGl2ZSBnaXQgaXMgb24uXG4gIHRyeSB7XG4gICAgY29uc3QgYXJncyA9IFtcImNvbW1pdFwiLCBcIi1GXCIsIFwiLVwiXTtcbiAgICBpZiAob3B0aW9ucz8uYWxsb3dFbXB0eSkgYXJncy5wdXNoKFwiLS1hbGxvdy1lbXB0eVwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBleGVjR2l0RmlsZVN5bmNXaXRoUmV0cnkoYmFzZVBhdGgsIGFyZ3MsIHtcbiAgICAgIHN0ZGlvOiBbXCJwaXBlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBpbnB1dDogbWVzc2FnZSxcbiAgICB9KTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9IGNhdGNoIChlcnI6IHVua25vd24pIHtcbiAgICBjb25zdCBlcnJPYmogPSBlcnIgYXMgeyBzdGRvdXQ/OiBzdHJpbmc7IHN0ZGVycj86IHN0cmluZzsgbWVzc2FnZT86IHN0cmluZyB9O1xuICAgIGNvbnN0IGNvbWJpbmVkID0gW2Vyck9iai5zdGRvdXQsIGVyck9iai5zdGRlcnIsIGVyck9iai5tZXNzYWdlXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG4gICAgaWYgKGNvbWJpbmVkLmluY2x1ZGVzKFwibm90aGluZyB0byBjb21taXRcIikgfHwgY29tYmluZWQuaW5jbHVkZXMoXCJub3RoaW5nIGFkZGVkIHRvIGNvbW1pdFwiKSB8fCBjb21iaW5lZC5pbmNsdWRlcyhcIm5vIGNoYW5nZXMgYWRkZWRcIikpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLyoqXG4gKiBDaGVja291dCBhIGJyYW5jaCAoc3dpdGNoIEhFQUQgYW5kIHVwZGF0ZSB3b3JraW5nIHRyZWUpLlxuICogTmF0aXZlOiBsaWJnaXQyIGNoZWNrb3V0ICsgc2V0X2hlYWQuXG4gKiBGYWxsYmFjazogYGdpdCBjaGVja291dCA8YnJhbmNoPmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVDaGVja291dEJyYW5jaChiYXNlUGF0aDogc3RyaW5nLCBicmFuY2g6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICBuYXRpdmUuZ2l0Q2hlY2tvdXRCcmFuY2goYmFzZVBhdGgsIGJyYW5jaCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJjaGVja291dFwiLCBicmFuY2hdLCB7XG4gICAgY3dkOiBiYXNlUGF0aCxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgfSk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBpbmRleCBjb25mbGljdHMgYnkgYWNjZXB0aW5nIFwidGhlaXJzXCIgdmVyc2lvbi5cbiAqIE5hdGl2ZTogbGliZ2l0MiBpbmRleCBjb25mbGljdCByZXNvbHV0aW9uLlxuICogRmFsbGJhY2s6IGBnaXQgY2hlY2tvdXQgLS10aGVpcnMgLS0gPGZpbGU+YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUNoZWNrb3V0VGhlaXJzKGJhc2VQYXRoOiBzdHJpbmcsIHBhdGhzOiBzdHJpbmdbXSk6IHZvaWQge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICBuYXRpdmUuZ2l0Q2hlY2tvdXRUaGVpcnMoYmFzZVBhdGgsIHBhdGhzKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBwYXRoIG9mIHBhdGhzKSB7XG4gICAgZ2l0RmlsZUV4ZWMoYmFzZVBhdGgsIFtcImNoZWNrb3V0XCIsIFwiLS10aGVpcnNcIiwgXCItLVwiLCBwYXRoXSk7XG4gIH1cbn1cblxuLyoqXG4gKiBTcXVhc2gtbWVyZ2UgYSBicmFuY2ggKHN0YWdlcyBjaGFuZ2VzLCBkb2VzIE5PVCBjb21taXQpLlxuICogTmF0aXZlOiBsaWJnaXQyIG1lcmdlIHdpdGggc3F1YXNoIHNlbWFudGljcy5cbiAqIEZhbGxiYWNrOiBgZ2l0IG1lcmdlIC0tc3F1YXNoIDxicmFuY2g+YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZU1lcmdlU3F1YXNoKGJhc2VQYXRoOiBzdHJpbmcsIGJyYW5jaDogc3RyaW5nKTogR2l0TWVyZ2VSZXN1bHQge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICByZXR1cm4gbmF0aXZlLmdpdE1lcmdlU3F1YXNoKGJhc2VQYXRoLCBicmFuY2gpO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wibWVyZ2VcIiwgXCItLXNxdWFzaFwiLCBicmFuY2hdLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIGVudjogR0lUX05PX1BST01QVF9FTlYsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgc3VjY2VzczogdHJ1ZSwgY29uZmxpY3RzOiBbXSB9O1xuICB9IGNhdGNoIChlcnI6IHVua25vd24pIHtcbiAgICAvLyBEaXN0aW5ndWlzaCBwcmUtbWVyZ2UgcmVqZWN0aW9ucyAoZGlydHkgd29ya2luZyB0cmVlKSBmcm9tIGFjdHVhbFxuICAgIC8vIGNvbnRlbnQgY29uZmxpY3RzLiAgV2hlbiBnaXQgcmVqZWN0cyB0aGUgbWVyZ2UgYmVmb3JlIHN0YWdpbmdcbiAgICAvLyAoXCJsb2NhbCBjaGFuZ2VzIHdvdWxkIGJlIG92ZXJ3cml0dGVuXCIpLCB0aGVyZSBhcmUgbm8gY29uZmxpY3QgbWFya2Vyc1xuICAgIC8vIHRvIGRldGVjdCwgc28gdGhlIG9sZCAtLWRpZmYtZmlsdGVyPVUgY2hlY2sgd291bGQgcmV0dXJuIGFuIGVtcHR5XG4gICAgLy8gbGlzdCBhbmQgaW5jb3JyZWN0bHkgcmVwb3J0IHN1Y2Nlc3MgKCMxNjcyLCAjMTczOCkuXG4gICAgY29uc3Qgc3RkZXJyID1cbiAgICAgIGVyciBpbnN0YW5jZW9mIEVycm9yID8gKGVyciBhcyBFcnJvciAmIHsgc3RkZXJyPzogc3RyaW5nIH0pLnN0ZGVyciA/PyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGlmIChcbiAgICAgIHN0ZGVyci5pbmNsdWRlcyhcImxvY2FsIGNoYW5nZXMgd291bGQgYmUgb3ZlcndyaXR0ZW5cIikgfHxcbiAgICAgIHN0ZGVyci5pbmNsdWRlcyhcIm5vdCBwb3NzaWJsZSBiZWNhdXNlIHlvdSBoYXZlIHVubWVyZ2VkIGZpbGVzXCIpIHx8XG4gICAgICBzdGRlcnIuaW5jbHVkZXMoXCJvdmVyd3JpdHRlbiBieSBtZXJnZVwiKVxuICAgICkge1xuICAgICAgLy8gRXh0cmFjdCBmaWxlbmFtZXMgZnJvbSBnaXQgc3RkZXJyIHNvIGNhbGxlcnMgY2FuIHJlcG9ydCB3aGljaCBmaWxlc1xuICAgICAgLy8gYXJlIGRpcnR5IGluc3RlYWQgb2YgZ2VuZXJpY2FsbHkgYmxhbWluZyAuZ3NkLyAoIzIxNTEpLlxuICAgICAgLy8gR2l0IGxpc3RzIHRoZW0gYXMgdGFiLWluZGVudGVkIGxpbmVzIGJldHdlZW4gdGhlIFwid291bGQgYmUgb3ZlcndyaXR0ZW5cIlxuICAgICAgLy8gaGVhZGVyIGFuZCB0aGUgXCJQbGVhc2UgY29tbWl0XCIgZm9vdGVyLlxuICAgICAgY29uc3QgZGlydHlGaWxlcyA9IHN0ZGVyclxuICAgICAgICAuc3BsaXQoXCJcXG5cIilcbiAgICAgICAgLmZpbHRlcigobGluZSkgPT4gbGluZS5zdGFydHNXaXRoKFwiXFx0XCIpKVxuICAgICAgICAubWFwKChsaW5lKSA9PiBsaW5lLnRyaW0oKSlcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIHJldHVybiB7IHN1Y2Nlc3M6IGZhbHNlLCBjb25mbGljdHM6IFtcIl9fZGlydHlfd29ya2luZ190cmVlX19cIl0sIGRpcnR5RmlsZXMgfTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBmb3IgcmVhbCBjb250ZW50IGNvbmZsaWN0c1xuICAgIGNvbnN0IGNvbmZsaWN0T3V0cHV0ID0gZ2l0RXhlYyhiYXNlUGF0aCwgW1wiZGlmZlwiLCBcIi0tbmFtZS1vbmx5XCIsIFwiLS1kaWZmLWZpbHRlcj1VXCJdLCB0cnVlKTtcbiAgICBjb25zdCBjb25mbGljdHMgPSBjb25mbGljdE91dHB1dCA/IGNvbmZsaWN0T3V0cHV0LnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKSA6IFtdO1xuICAgIGlmIChjb25mbGljdHMubGVuZ3RoID4gMCkge1xuICAgICAgcmV0dXJuIHsgc3VjY2VzczogZmFsc2UsIGNvbmZsaWN0cyB9O1xuICAgIH1cbiAgICAvLyBObyBjb25mbGljdHMgZGV0ZWN0ZWQgXHUyMDE0IHRoaXMgaXMgYSBub24tY29uZmxpY3QgZmFpbHVyZTsgcmUtdGhyb3dcbiAgICAvLyBzbyB0aGUgY2FsbGVyIGtub3dzIHRoZSBtZXJnZSBkaWQgbm90IHN1Y2NlZWQuXG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogQWJvcnQgYW4gaW4tcHJvZ3Jlc3MgbWVyZ2UuXG4gKiBOYXRpdmU6IGxpYmdpdDIgcmVzZXQgKyBjbGVhbnVwLlxuICogRmFsbGJhY2s6IGBnaXQgbWVyZ2UgLS1hYm9ydGAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVNZXJnZUFib3J0KGJhc2VQYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgbmF0aXZlLmdpdE1lcmdlQWJvcnQoYmFzZVBhdGgpO1xuICAgIHJldHVybjtcbiAgfVxuICBnaXRFeGVjKGJhc2VQYXRoLCBbXCJtZXJnZVwiLCBcIi0tYWJvcnRcIl0sIHRydWUpO1xufVxuXG4vKipcbiAqIEFib3J0IGFuIGluLXByb2dyZXNzIHJlYmFzZS5cbiAqIE5hdGl2ZTogbGliZ2l0MiByZXNldCArIGNsZWFudXAuXG4gKiBGYWxsYmFjazogYGdpdCByZWJhc2UgLS1hYm9ydGAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVSZWJhc2VBYm9ydChiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIG5hdGl2ZS5naXRSZWJhc2VBYm9ydChiYXNlUGF0aCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGdpdEV4ZWMoYmFzZVBhdGgsIFtcInJlYmFzZVwiLCBcIi0tYWJvcnRcIl0sIHRydWUpO1xufVxuXG4vKipcbiAqIEhhcmQgcmVzZXQgdG8gSEVBRC5cbiAqIE5hdGl2ZTogbGliZ2l0MiByZXNldChIYXJkKS5cbiAqIEZhbGxiYWNrOiBgZ2l0IHJlc2V0IC0taGFyZCBIRUFEYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZVJlc2V0SGFyZChiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIG5hdGl2ZS5naXRSZXNldEhhcmQoYmFzZVBhdGgpO1xuICAgIHJldHVybjtcbiAgfVxuICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmVzZXRcIiwgXCItLWhhcmRcIiwgXCJIRUFEXCJdLCB7IGN3ZDogYmFzZVBhdGgsIHN0ZGlvOiBcInBpcGVcIiB9KTtcbn1cblxuLyoqXG4gKiBTb2Z0IHJlc2V0IHRvIGEgdGFyZ2V0IHJlZiAoZ2l0IHJlc2V0IC0tc29mdCA8cmVmPikuXG4gKiBNb3ZlcyBIRUFEIHRvIGB0YXJnZXRgIHdoaWxlIGtlZXBpbmcgYWxsIGNoYW5nZXMgc3RhZ2VkIGluIHRoZSBpbmRleC5cbiAqIFVzZWQgdG8gc3F1YXNoIHNuYXBzaG90IGNvbW1pdHMgYmFjayBpbnRvIGEgc2luZ2xlIHJlYWwgY29tbWl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlUmVzZXRTb2Z0KGJhc2VQYXRoOiBzdHJpbmcsIHRhcmdldDogc3RyaW5nKTogdm9pZCB7XG4gIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJyZXNldFwiLCBcIi0tc29mdFwiLCB0YXJnZXRdLCB7XG4gICAgY3dkOiBiYXNlUGF0aCxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICBlbnY6IEdJVF9OT19QUk9NUFRfRU5WLFxuICB9KTtcbn1cblxuLyoqXG4gKiBHZXQgdGhlIHN1YmplY3QgbGluZSBvZiBhIGNvbW1pdCAoZ2l0IGxvZyAtMSAtLWZvcm1hdD0lcyA8cmVmPikuXG4gKiBSZXR1cm5zIGVtcHR5IHN0cmluZyBpZiB0aGUgcmVmIGRvZXNuJ3QgZXhpc3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVDb21taXRTdWJqZWN0KGJhc2VQYXRoOiBzdHJpbmcsIHJlZjogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImxvZ1wiLCBcIi0xXCIsIFwiLS1mb3JtYXQ9JXNcIiwgcmVmXSwge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgICBlbnY6IEdJVF9OT19QUk9NUFRfRU5WLFxuICAgIH0pLnRyaW0oKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiXCI7XG4gIH1cbn1cblxuLyoqXG4gKiBEZWxldGUgYSBicmFuY2guXG4gKiBOYXRpdmU6IGxpYmdpdDIgYnJhbmNoIGRlbGV0ZS5cbiAqIEZhbGxiYWNrOiBgZ2l0IGJyYW5jaCAtRC8tZCA8YnJhbmNoPmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVCcmFuY2hEZWxldGUoYmFzZVBhdGg6IHN0cmluZywgYnJhbmNoOiBzdHJpbmcsIGZvcmNlID0gdHJ1ZSk6IHZvaWQge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICBuYXRpdmUuZ2l0QnJhbmNoRGVsZXRlKGJhc2VQYXRoLCBicmFuY2gsIGZvcmNlKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZ2l0RmlsZUV4ZWMoYmFzZVBhdGgsIFtcImJyYW5jaFwiLCBmb3JjZSA/IFwiLURcIiA6IFwiLWRcIiwgYnJhbmNoXSk7XG59XG5cbi8qKlxuICogRm9yY2UtcmVzZXQgYSBicmFuY2ggdG8gcG9pbnQgYXQgYSB0YXJnZXQgcmVmLlxuICogTmF0aXZlOiBsaWJnaXQyIGJyYW5jaCBjcmVhdGUgd2l0aCBmb3JjZS5cbiAqIEZhbGxiYWNrOiBgZ2l0IGJyYW5jaCAtZiA8YnJhbmNoPiA8dGFyZ2V0PmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVCcmFuY2hGb3JjZVJlc2V0KGJhc2VQYXRoOiBzdHJpbmcsIGJyYW5jaDogc3RyaW5nLCB0YXJnZXQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICBuYXRpdmUuZ2l0QnJhbmNoRm9yY2VSZXNldChiYXNlUGF0aCwgYnJhbmNoLCB0YXJnZXQpO1xuICAgIHJldHVybjtcbiAgfVxuICBnaXRFeGVjKGJhc2VQYXRoLCBbXCJicmFuY2hcIiwgXCItZlwiLCBicmFuY2gsIHRhcmdldF0pO1xufVxuXG4vKipcbiAqIFJlbW92ZSBmaWxlcyBmcm9tIHRoZSBpbmRleCAoY2FjaGUpIHdpdGhvdXQgdG91Y2hpbmcgdGhlIHdvcmtpbmcgdHJlZS5cbiAqIFJldHVybnMgbGlzdCBvZiByZW1vdmVkIGZpbGVzLlxuICogTmF0aXZlOiBsaWJnaXQyIGluZGV4IHJlbW92ZS5cbiAqIEZhbGxiYWNrOiBgZ2l0IHJtIC0tY2FjaGVkIC1yIC0taWdub3JlLXVubWF0Y2ggPHBhdGg+YC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZVJtQ2FjaGVkKGJhc2VQYXRoOiBzdHJpbmcsIHBhdGhzOiBzdHJpbmdbXSwgcmVjdXJzaXZlID0gdHJ1ZSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgcmV0dXJuIG5hdGl2ZS5naXRSbUNhY2hlZChiYXNlUGF0aCwgcGF0aHMsIHJlY3Vyc2l2ZSk7XG4gIH1cblxuICBjb25zdCByZW1vdmVkOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBnaXRFeGVjKFxuICAgICAgYmFzZVBhdGgsXG4gICAgICBbXCJybVwiLCBcIi0tY2FjaGVkXCIsIC4uLihyZWN1cnNpdmUgPyBbXCItclwiXSA6IFtdKSwgXCItLWlnbm9yZS11bm1hdGNoXCIsIHBhdGhdLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIGlmIChyZXN1bHQpIHJlbW92ZWQucHVzaChyZXN1bHQpO1xuICB9XG4gIHJldHVybiByZW1vdmVkO1xufVxuXG4vKipcbiAqIEZvcmNlLXJlbW92ZSBmaWxlcyBmcm9tIGJvdGggaW5kZXggYW5kIHdvcmtpbmcgdHJlZS5cbiAqIE5hdGl2ZTogbGliZ2l0MiBpbmRleCByZW1vdmUgKyBmcyBkZWxldGUuXG4gKiBGYWxsYmFjazogYGdpdCBybSAtLWZvcmNlIC0tIDxmaWxlPmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVSbUZvcmNlKGJhc2VQYXRoOiBzdHJpbmcsIHBhdGhzOiBzdHJpbmdbXSk6IHZvaWQge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICBuYXRpdmUuZ2l0Um1Gb3JjZShiYXNlUGF0aCwgcGF0aHMpO1xuICAgIHJldHVybjtcbiAgfVxuICBmb3IgKGNvbnN0IHBhdGggb2YgcGF0aHMpIHtcbiAgICBnaXRGaWxlRXhlYyhiYXNlUGF0aCwgW1wicm1cIiwgXCItLWZvcmNlXCIsIFwiLS1cIiwgcGF0aF0sIHRydWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJ1bkdpdFdvcmt0cmVlQWRkKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICB3dFBhdGg6IHN0cmluZyxcbiAgYnJhbmNoOiBzdHJpbmcsXG4gIGNyZWF0ZUJyYW5jaD86IGJvb2xlYW4sXG4gIHN0YXJ0UG9pbnQ/OiBzdHJpbmcsXG4pOiB2b2lkIHtcbiAgaWYgKGNyZWF0ZUJyYW5jaCkge1xuICAgIGNvbnN0IGJyYW5jaFJlZiA9IGdpdEV4ZWMoYmFzZVBhdGgsIFtcInNob3ctcmVmXCIsIFwiLS12ZXJpZnlcIiwgYHJlZnMvaGVhZHMvJHticmFuY2h9YF0sIHRydWUpO1xuICAgIGlmIChicmFuY2hSZWYpIHtcbiAgICAgIGdpdEV4ZWMoYmFzZVBhdGgsIFtcIndvcmt0cmVlXCIsIFwiYWRkXCIsIHd0UGF0aCwgYnJhbmNoXSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGdpdEV4ZWMoYmFzZVBhdGgsIFtcIndvcmt0cmVlXCIsIFwiYWRkXCIsIFwiLWJcIiwgYnJhbmNoLCB3dFBhdGgsIHN0YXJ0UG9pbnQgPz8gXCJIRUFEXCJdKTtcbiAgfSBlbHNlIHtcbiAgICBnaXRFeGVjKGJhc2VQYXRoLCBbXCJ3b3JrdHJlZVwiLCBcImFkZFwiLCB3dFBhdGgsIGJyYW5jaF0pO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhc3NlcnRXb3JrdHJlZU1hdGVyaWFsaXplZCh3dFBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoZXhpc3RzU3luYyhqb2luKHd0UGF0aCwgXCIuZ2l0XCIpKSkgcmV0dXJuO1xuICB0aHJvdyBuZXcgR1NERXJyb3IoXG4gICAgR1NEX0dJVF9FUlJPUixcbiAgICBgZ2l0IHdvcmt0cmVlIGFkZCBkaWQgbm90IG1hdGVyaWFsaXplIGEgdmFsaWQgd29ya3RyZWUgYXQgJHt3dFBhdGh9OiBtaXNzaW5nIC5naXQgZmlsZWAsXG4gICk7XG59XG5cbi8qKlxuICogQWRkIGEgbmV3IGdpdCB3b3JrdHJlZS5cbiAqIE5hdGl2ZTogbGliZ2l0MiB3b3JrdHJlZSBBUEkuXG4gKiBGYWxsYmFjazogYGdpdCB3b3JrdHJlZSBhZGRgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlV29ya3RyZWVBZGQoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIHd0UGF0aDogc3RyaW5nLFxuICBicmFuY2g6IHN0cmluZyxcbiAgY3JlYXRlQnJhbmNoPzogYm9vbGVhbixcbiAgc3RhcnRQb2ludD86IHN0cmluZyxcbik6IHZvaWQge1xuICBjb25zdCBuYXRpdmUgPSBsb2FkTmF0aXZlKCk7XG4gIGlmIChuYXRpdmUpIHtcbiAgICBuYXRpdmUuZ2l0V29ya3RyZWVBZGQoYmFzZVBhdGgsIHd0UGF0aCwgYnJhbmNoLCBjcmVhdGVCcmFuY2gsIHN0YXJ0UG9pbnQpO1xuICAgIHRyeSB7XG4gICAgICBhc3NlcnRXb3JrdHJlZU1hdGVyaWFsaXplZCh3dFBhdGgpO1xuICAgICAgcmV0dXJuO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcm1TeW5jKHd0UGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgZ2l0RXhlYyhiYXNlUGF0aCwgW1wid29ya3RyZWVcIiwgXCJwcnVuZVwiXSwgdHJ1ZSk7XG4gICAgICBydW5HaXRXb3JrdHJlZUFkZChiYXNlUGF0aCwgd3RQYXRoLCBicmFuY2gsIGNyZWF0ZUJyYW5jaCwgc3RhcnRQb2ludCk7XG4gICAgICBhc3NlcnRXb3JrdHJlZU1hdGVyaWFsaXplZCh3dFBhdGgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIHJ1bkdpdFdvcmt0cmVlQWRkKGJhc2VQYXRoLCB3dFBhdGgsIGJyYW5jaCwgY3JlYXRlQnJhbmNoLCBzdGFydFBvaW50KTtcbiAgYXNzZXJ0V29ya3RyZWVNYXRlcmlhbGl6ZWQod3RQYXRoKTtcbn1cblxuLyoqXG4gKiBSZW1vdmUgYSBnaXQgd29ya3RyZWUuXG4gKiBOYXRpdmU6IGxpYmdpdDIgd29ya3RyZWUgcHJ1bmUgKyBmcyBjbGVhbnVwLlxuICogRmFsbGJhY2s6IGBnaXQgd29ya3RyZWUgcmVtb3ZlIFstLWZvcmNlXSA8cGF0aD5gLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlV29ya3RyZWVSZW1vdmUoYmFzZVBhdGg6IHN0cmluZywgd3RQYXRoOiBzdHJpbmcsIGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgbmF0aXZlLmdpdFdvcmt0cmVlUmVtb3ZlKGJhc2VQYXRoLCB3dFBhdGgsIGZvcmNlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBhcmdzID0gW1wid29ya3RyZWVcIiwgXCJyZW1vdmVcIl07XG4gIGlmIChmb3JjZSkgYXJncy5wdXNoKFwiLS1mb3JjZVwiKTtcbiAgYXJncy5wdXNoKHd0UGF0aCk7XG4gIGdpdEV4ZWMoYmFzZVBhdGgsIGFyZ3MsIHRydWUpO1xufVxuXG4vKipcbiAqIFBydW5lIHN0YWxlIHdvcmt0cmVlIGVudHJpZXMuXG4gKiBOYXRpdmU6IGxpYmdpdDIgd29ya3RyZWUgdmFsaWRhdGlvbiArIHBydW5lLlxuICogRmFsbGJhY2s6IGBnaXQgd29ya3RyZWUgcHJ1bmVgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlV29ya3RyZWVQcnVuZShiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIG5hdGl2ZS5naXRXb3JrdHJlZVBydW5lKGJhc2VQYXRoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZ2l0RXhlYyhiYXNlUGF0aCwgW1wid29ya3RyZWVcIiwgXCJwcnVuZVwiXSwgdHJ1ZSk7XG59XG5cbi8qKlxuICogUmV2ZXJ0IGEgY29tbWl0IHdpdGhvdXQgYXV0by1jb21taXR0aW5nLlxuICogTmF0aXZlOiBsaWJnaXQyIHJldmVydC5cbiAqIEZhbGxiYWNrOiBgZ2l0IHJldmVydCAtLW5vLWNvbW1pdCA8c2hhPmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVSZXZlcnRDb21taXQoYmFzZVBhdGg6IHN0cmluZywgc2hhOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgbmF0aXZlID0gbG9hZE5hdGl2ZSgpO1xuICBpZiAobmF0aXZlKSB7XG4gICAgbmF0aXZlLmdpdFJldmVydENvbW1pdChiYXNlUGF0aCwgc2hhKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZ2l0RmlsZUV4ZWMoYmFzZVBhdGgsIFtcInJldmVydFwiLCBcIi0tbm8tY29tbWl0XCIsIHNoYV0pO1xufVxuXG4vKipcbiAqIEFib3J0IGFuIGluLXByb2dyZXNzIHJldmVydC5cbiAqIE5hdGl2ZTogbGliZ2l0MiByZXNldCArIGNsZWFudXAuXG4gKiBGYWxsYmFjazogYGdpdCByZXZlcnQgLS1hYm9ydGAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVSZXZlcnRBYm9ydChiYXNlUGF0aDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIG5hdGl2ZS5naXRSZXZlcnRBYm9ydChiYXNlUGF0aCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGdpdEZpbGVFeGVjKGJhc2VQYXRoLCBbXCJyZXZlcnRcIiwgXCItLWFib3J0XCJdLCB0cnVlKTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgb3IgZGVsZXRlIGEgcmVmLlxuICogV2hlbiB0YXJnZXQgaXMgcHJvdmlkZWQsIGNyZWF0ZXMvdXBkYXRlcyB0aGUgcmVmLiBXaGVuIHVuZGVmaW5lZCwgZGVsZXRlcyBpdC5cbiAqIE5hdGl2ZTogbGliZ2l0MiByZWZlcmVuY2UgY3JlYXRlL2RlbGV0ZS5cbiAqIEZhbGxiYWNrOiBgZ2l0IHVwZGF0ZS1yZWZgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlVXBkYXRlUmVmKGJhc2VQYXRoOiBzdHJpbmcsIHJlZm5hbWU6IHN0cmluZywgdGFyZ2V0Pzogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IG5hdGl2ZSA9IGxvYWROYXRpdmUoKTtcbiAgaWYgKG5hdGl2ZSkge1xuICAgIG5hdGl2ZS5naXRVcGRhdGVSZWYoYmFzZVBhdGgsIHJlZm5hbWUsIHRhcmdldCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHRhcmdldCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgZ2l0RXhlYyhiYXNlUGF0aCwgW1widXBkYXRlLXJlZlwiLCByZWZuYW1lLCB0YXJnZXRdKTtcbiAgfSBlbHNlIHtcbiAgICBnaXRFeGVjKGJhc2VQYXRoLCBbXCJ1cGRhdGUtcmVmXCIsIFwiLWRcIiwgcmVmbmFtZV0sIHRydWUpO1xuICB9XG59XG5cbi8qKlxuICogQ2hlY2sgaWYgdGhlIG5hdGl2ZSBnaXQgbW9kdWxlIGlzIGF2YWlsYWJsZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzTmF0aXZlR2l0QXZhaWxhYmxlKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gbG9hZE5hdGl2ZSgpICE9PSBudWxsO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGEgY29tbWl0L2JyYW5jaCBpcyBhbiBhbmNlc3RvciBvZiBhbm90aGVyLlxuICogUmV0dXJucyB0cnVlIGlmIGBhbmNlc3RvcmAgaXMgcmVhY2hhYmxlIGZyb20gYGRlc2NlbmRhbnRgLlxuICogRmFsbGJhY2s6IGBnaXQgbWVyZ2UtYmFzZSAtLWlzLWFuY2VzdG9yYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5hdGl2ZUlzQW5jZXN0b3IoYmFzZVBhdGg6IHN0cmluZywgYW5jZXN0b3I6IHN0cmluZywgZGVzY2VuZGFudDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcIm1lcmdlLWJhc2VcIiwgXCItLWlzLWFuY2VzdG9yXCIsIGFuY2VzdG9yLCBkZXNjZW5kYW50XSwge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIGVudjogR0lUX05PX1BST01QVF9FTlYsXG4gICAgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIEdldCB0aGUgVW5peCBlcG9jaCAoc2Vjb25kcykgb2YgdGhlIGxhdGVzdCBjb21taXQgb24gYSByZWYuXG4gKiBSZXR1cm5zIDAgaWYgdGhlIHJlZiBkb2Vzbid0IGV4aXN0IG9yIGhhcyBubyBjb21taXRzLlxuICogRmFsbGJhY2s6IGBnaXQgbG9nIC0xIC0tZm9ybWF0PSVjdCA8cmVmPmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBuYXRpdmVMYXN0Q29tbWl0RXBvY2goYmFzZVBhdGg6IHN0cmluZywgcmVmOiBzdHJpbmcpOiBudW1iZXIge1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJsb2dcIiwgXCItMVwiLCBcIi0tZm9ybWF0PSVjdFwiLCByZWZdLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIGVudjogR0lUX05PX1BST01QVF9FTlYsXG4gICAgfSkudHJpbSgpO1xuICAgIHJldHVybiBwYXJzZUludChyZXN1bHQsIDEwKSB8fCAwO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gMDtcbiAgfVxufVxuXG4vKipcbiAqIENvdW50IGNvbW1pdHMgb24gYGJyYW5jaGAgdGhhdCBhcmUgbm90IG9uIGFueSByZW1vdGUgdHJhY2tpbmcgYnJhbmNoLlxuICogUmV0dXJucyB0aGUgY291bnQgb2YgdW5wdXNoZWQgY29tbWl0cywgb3IgLTEgaWYgdGhlIGJyYW5jaCBoYXMgbm8gdXBzdHJlYW0uXG4gKiBGYWxsYmFjazogYGdpdCByZXYtbGlzdCA8YnJhbmNoPiAtLW5vdCAtLXJlbW90ZXNgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbmF0aXZlVW5wdXNoZWRDb3VudChiYXNlUGF0aDogc3RyaW5nLCBicmFuY2g6IHN0cmluZyk6IG51bWJlciB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1saXN0XCIsIGJyYW5jaCwgXCItLW5vdFwiLCBcIi0tcmVtb3Rlc1wiLCBcIi0tY291bnRcIl0sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgZW52OiBHSVRfTk9fUFJPTVBUX0VOVixcbiAgICB9KS50cmltKCk7XG4gICAgcmV0dXJuIHBhcnNlSW50KHJlc3VsdCwgMTApIHx8IDA7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiAtMTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmUtZXhwb3J0cyBmb3IgdHlwZSBjb25zdW1lcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCB0eXBlIHtcbiAgR2l0RGlmZlN0YXQsXG4gIEdpdE5hbWVTdGF0dXMsXG4gIEdpdE51bXN0YXQsXG4gIEdpdExvZ0VudHJ5LFxuICBHaXRXb3JrdHJlZUVudHJ5LFxuICBHaXRCYXRjaEluZm8sXG4gIEdpdE1lcmdlUmVzdWx0LFxufTtcbiJdLAogICJtYXBwaW5ncyI6ICJBQU9BLFNBQW1CLG9CQUFvQjtBQUV2QyxTQUFTLFlBQVksY0FBMEIsUUFBUSxxQkFBcUI7QUFDNUUsU0FBUyxZQUFZO0FBQ3JCLFNBQVMsVUFBVSxxQkFBcUI7QUFDeEMsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyw2QkFBNkI7QUFJdEMsTUFBTSx5QkFBeUIsUUFBUSxJQUFJLDhCQUE4QjtBQUN6RSxNQUFNLDRCQUE0QixvQkFBSSxJQUFJLENBQUMsV0FBVyxRQUFRLENBQUM7QUFDL0QsTUFBTSxxQkFBcUI7QUFrRDNCLElBQUksZUE4Q087QUFFWCxJQUFJLGdCQUFnQjtBQUVwQixTQUFTLGFBQWtDO0FBQ3pDLE1BQUksY0FBZSxRQUFPO0FBQzFCLGtCQUFnQjtBQUNoQixNQUFJLENBQUMsdUJBQXdCLFFBQU87QUFFcEMsTUFBSTtBQUVGLFVBQU0sTUFBTSxRQUFRLGFBQWE7QUFDakMsUUFBSSxJQUFJLG9CQUFvQixJQUFJLGVBQWU7QUFDN0MscUJBQWU7QUFBQSxJQUNqQjtBQUFBLEVBQ0YsUUFBUTtBQUFBLEVBRVI7QUFFQSxTQUFPO0FBQ1Q7QUFLQSxTQUFTLFFBQVEsVUFBa0IsTUFBZ0IsZUFBZSxPQUFlO0FBQy9FLE1BQUk7QUFDRixXQUFPLGFBQWEsT0FBTyxNQUFNO0FBQUEsTUFDL0IsS0FBSztBQUFBLE1BQ0wsT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNO0FBQUEsTUFDaEMsVUFBVTtBQUFBLE1BQ1YsS0FBSztBQUFBLElBQ1AsQ0FBQyxFQUFFLEtBQUs7QUFBQSxFQUNWLFNBQVMsS0FBSztBQUNaLFFBQUksYUFBYyxRQUFPO0FBQ3pCLFVBQU0sSUFBSSxTQUFTLGVBQWUsT0FBTyxLQUFLLEtBQUssR0FBRyxDQUFDLGNBQWMsUUFBUSxLQUFLLGdCQUFnQixHQUFHLENBQUMsRUFBRTtBQUFBLEVBQzFHO0FBQ0Y7QUFHQSxTQUFTLFVBQVUsSUFBa0I7QUFDbkMsVUFBUSxLQUFLLElBQUksV0FBVyxJQUFJLGtCQUFrQixDQUFDLENBQUMsR0FBRyxHQUFHLEdBQUcsRUFBRTtBQUNqRTtBQUVBLFNBQVMsb0JBQW9CLEtBQXVCO0FBQ2xELFFBQU0sT0FBTyxzQkFBc0IsR0FBRyxLQUNqQyxzQkFBdUIsS0FBNkIsVUFBVSxFQUFFO0FBQ3JFLFNBQU8sU0FBUyxRQUFRLDBCQUEwQixJQUFJLElBQUk7QUFDNUQ7QUFFQSxTQUFTLHlCQUNQLFVBQ0EsTUFDQSxTQUNRO0FBQ1IsTUFBSTtBQUNGLFdBQU8sYUFBYSxPQUFPLE1BQU07QUFBQSxNQUMvQixLQUFLO0FBQUEsTUFDTCxPQUFPLENBQUMsVUFBVSxRQUFRLE1BQU07QUFBQSxNQUNoQyxVQUFVO0FBQUEsTUFDVixLQUFLO0FBQUEsTUFDTCxHQUFHO0FBQUEsSUFDTCxDQUFDLEVBQUUsS0FBSztBQUFBLEVBQ1YsU0FBUyxLQUFLO0FBQ1osUUFBSSxDQUFDLG9CQUFvQixHQUFHLEVBQUcsT0FBTTtBQUNyQyxjQUFVLGtCQUFrQjtBQUM1QixXQUFPLGFBQWEsT0FBTyxNQUFNO0FBQUEsTUFDL0IsS0FBSztBQUFBLE1BQ0wsT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNO0FBQUEsTUFDaEMsVUFBVTtBQUFBLE1BQ1YsS0FBSztBQUFBLE1BQ0wsR0FBRztBQUFBLElBQ0wsQ0FBQyxFQUFFLEtBQUs7QUFBQSxFQUNWO0FBQ0Y7QUFHQSxTQUFTLFlBQVksVUFBa0IsTUFBZ0IsZUFBZSxPQUFlO0FBQ25GLE1BQUk7QUFDRixXQUFPLGFBQWEsT0FBTyxNQUFNO0FBQUEsTUFDL0IsS0FBSztBQUFBLE1BQ0wsT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNO0FBQUEsTUFDaEMsVUFBVTtBQUFBLE1BQ1YsS0FBSztBQUFBLElBQ1AsQ0FBQyxFQUFFLEtBQUs7QUFBQSxFQUNWLFNBQVMsS0FBSztBQUNaLFFBQUksYUFBYyxRQUFPO0FBQ3pCLFVBQU0sSUFBSSxTQUFTLGVBQWUsT0FBTyxLQUFLLEtBQUssR0FBRyxDQUFDLGNBQWMsUUFBUSxLQUFLLGdCQUFnQixHQUFHLENBQUMsRUFBRTtBQUFBLEVBQzFHO0FBQ0Y7QUFTTyxTQUFTLHVCQUF1QixVQUEwQjtBQUMvRCxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixVQUFNLFNBQVMsT0FBTyxpQkFBaUIsUUFBUTtBQUMvQyxXQUFPLFVBQVU7QUFBQSxFQUNuQjtBQUNBLFNBQU8sUUFBUSxVQUFVLENBQUMsVUFBVSxnQkFBZ0IsQ0FBQztBQUN2RDtBQU9PLFNBQVMsdUJBQXVCLFVBQTBCO0FBQy9ELFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sT0FBTyxjQUFjLFFBQVE7QUFBQSxFQUN0QztBQUVBLFFBQU0sV0FBVyxRQUFRLFVBQVUsQ0FBQyxnQkFBZ0IsMEJBQTBCLEdBQUcsSUFBSTtBQUNyRixNQUFJLFVBQVU7QUFDWixVQUFNLFFBQVEsU0FBUyxNQUFNLDhCQUE4QjtBQUMzRCxRQUFJLE1BQU8sUUFBTyxNQUFNLENBQUM7QUFBQSxFQUMzQjtBQUVBLFFBQU0sYUFBYSxRQUFRLFVBQVUsQ0FBQyxZQUFZLFlBQVksaUJBQWlCLEdBQUcsSUFBSTtBQUN0RixNQUFJLFdBQVksUUFBTztBQUV2QixRQUFNLGVBQWUsUUFBUSxVQUFVLENBQUMsWUFBWSxZQUFZLG1CQUFtQixHQUFHLElBQUk7QUFDMUYsTUFBSSxhQUFjLFFBQU87QUFFekIsU0FBTyxRQUFRLFVBQVUsQ0FBQyxVQUFVLGdCQUFnQixDQUFDO0FBQ3ZEO0FBU08sU0FBUyxtQkFBbUIsVUFBa0IsUUFBeUI7QUFDNUUsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxPQUFPLGdCQUFnQixVQUFVLE1BQU07QUFBQSxFQUNoRDtBQUNBLFFBQU0sU0FBUyxRQUFRLFVBQVUsQ0FBQyxZQUFZLFlBQVksY0FBYyxNQUFNLEVBQUUsR0FBRyxJQUFJO0FBQ3ZGLE1BQUksV0FBVyxHQUFJLFFBQU87QUFJMUIsUUFBTSxVQUFVLFFBQVEsVUFBVSxDQUFDLFVBQVUsZ0JBQWdCLEdBQUcsSUFBSTtBQUNwRSxTQUFPLFlBQVk7QUFDckI7QUFPTyxTQUFTLHdCQUF3QixVQUEyQjtBQUNqRSxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLE9BQU8scUJBQXFCLFFBQVE7QUFBQSxFQUM3QztBQUNBLFFBQU0sU0FBUyxRQUFRLFVBQVUsQ0FBQyxRQUFRLGVBQWUsaUJBQWlCLEdBQUcsSUFBSTtBQUNqRixTQUFPLFdBQVc7QUFDcEI7QUFPTyxTQUFTLHdCQUF3QixVQUEwQjtBQUNoRSxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLE9BQU8scUJBQXFCLFFBQVE7QUFBQSxFQUM3QztBQUNBLFNBQU8sUUFBUSxVQUFVLENBQUMsVUFBVSxhQUFhLEdBQUcsSUFBSTtBQUMxRDtBQUdBLElBQUksMEJBQW1DO0FBQ3ZDLElBQUksc0JBQThCO0FBQ2xDLElBQUksd0JBQWdDO0FBQ3BDLE1BQU0sMkJBQTJCO0FBTzFCLFNBQVMsaUJBQWlCLFVBQTJCO0FBQzFELFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sT0FBTyxjQUFjLFFBQVE7QUFBQSxFQUN0QztBQUVBLFFBQU0sTUFBTSxLQUFLLElBQUk7QUFDckIsTUFDRSxhQUFhLHlCQUNiLE1BQU0sc0JBQXNCLDBCQUM1QjtBQUNBLFdBQU87QUFBQSxFQUNUO0FBRUEsUUFBTSxTQUFTLFFBQVEsVUFBVSxDQUFDLFVBQVUsU0FBUyxHQUFHLElBQUk7QUFDNUQsUUFBTSxhQUFhLFdBQVc7QUFFOUIsNEJBQTBCO0FBQzFCLHdCQUFzQjtBQUN0QiwwQkFBd0I7QUFFeEIsU0FBTztBQUNUO0FBR08sU0FBUyx3QkFBOEI7QUFDNUMsNEJBQTBCO0FBQzFCLHdCQUFzQjtBQUN0QiwwQkFBd0I7QUFDMUI7QUFPTyxTQUFTLHlCQUF5QixVQUFrQixTQUFpQixPQUF1QjtBQUNqRyxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLE9BQU8sc0JBQXNCLFVBQVUsU0FBUyxLQUFLO0FBQUEsRUFDOUQ7QUFDQSxRQUFNLFNBQVMsUUFBUSxVQUFVLENBQUMsWUFBWSxXQUFXLEdBQUcsT0FBTyxLQUFLLEtBQUssRUFBRSxHQUFHLElBQUk7QUFDdEYsU0FBTyxTQUFTLFFBQVEsRUFBRSxLQUFLO0FBQ2pDO0FBU08sU0FBUyxhQUFhLFVBQTJCO0FBQ3RELFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sT0FBTyxVQUFVLFFBQVE7QUFBQSxFQUNsQztBQUNBLE1BQUk7QUFDRixpQkFBYSxPQUFPLENBQUMsYUFBYSxXQUFXLEdBQUcsRUFBRSxLQUFLLFVBQVUsT0FBTyxPQUFPLENBQUM7QUFDaEYsV0FBTztBQUFBLEVBQ1QsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFHTyxTQUFTLHVCQUF1QixVQUEyQjtBQUNoRSxNQUFJO0FBQ0YsaUJBQWEsT0FBTyxDQUFDLGFBQWEsWUFBWSxNQUFNLEdBQUc7QUFBQSxNQUNyRCxLQUFLO0FBQUEsTUFDTCxPQUFPLENBQUMsVUFBVSxVQUFVLFFBQVE7QUFBQSxNQUNwQyxLQUFLO0FBQUEsSUFDUCxDQUFDO0FBQ0QsV0FBTztBQUFBLEVBQ1QsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFPTyxTQUFTLHVCQUF1QixVQUEyQjtBQUNoRSxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLE9BQU8sb0JBQW9CLFFBQVE7QUFBQSxFQUM1QztBQUNBLFFBQU0sU0FBUyxRQUFRLFVBQVUsQ0FBQyxRQUFRLFlBQVksUUFBUSxHQUFHLElBQUk7QUFDckUsU0FBTyxXQUFXO0FBQ3BCO0FBU08sU0FBUyxlQUFlLFVBQWtCLFNBQWlCLE9BQTRCO0FBQzVGLFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sT0FBTyxZQUFZLFVBQVUsU0FBUyxLQUFLO0FBQUEsRUFDcEQ7QUFHQSxNQUFJO0FBQ0osTUFBSSxZQUFZLFVBQVUsVUFBVSxXQUFXO0FBQzdDLFdBQU8sQ0FBQyxRQUFRLFVBQVUsTUFBTTtBQUFBLEVBQ2xDLFdBQVcsWUFBWSxVQUFVLFVBQVUsU0FBUztBQUNsRCxXQUFPLENBQUMsUUFBUSxVQUFVLFlBQVksTUFBTTtBQUFBLEVBQzlDLE9BQU87QUFDTCxXQUFPLENBQUMsUUFBUSxVQUFVLFNBQVMsS0FBSztBQUFBLEVBQzFDO0FBRUEsUUFBTSxTQUFTLFFBQVEsVUFBVSxNQUFNLElBQUk7QUFFM0MsTUFBSSxlQUFlLEdBQUcsYUFBYSxHQUFHLFlBQVk7QUFDbEQsUUFBTSxhQUFhLE9BQU8sTUFBTSxnRkFBZ0Y7QUFDaEgsTUFBSSxZQUFZO0FBQ2QsbUJBQWUsU0FBUyxXQUFXLENBQUMsS0FBSyxLQUFLLEVBQUU7QUFDaEQsaUJBQWEsU0FBUyxXQUFXLENBQUMsS0FBSyxLQUFLLEVBQUU7QUFDOUMsZ0JBQVksU0FBUyxXQUFXLENBQUMsS0FBSyxLQUFLLEVBQUU7QUFBQSxFQUMvQztBQUNBLFNBQU8sRUFBRSxjQUFjLFlBQVksV0FBVyxTQUFTLE9BQU87QUFDaEU7QUFRTyxTQUFTLHFCQUNkLFVBQ0EsU0FDQSxPQUNBLFVBQ0EsY0FDaUI7QUFDakIsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxPQUFPLGtCQUFrQixVQUFVLFNBQVMsT0FBTyxVQUFVLFlBQVk7QUFBQSxFQUNsRjtBQUdBLFFBQU0sWUFBWSxlQUFlLFFBQVE7QUFDekMsUUFBTSxPQUFPLENBQUMsUUFBUSxpQkFBaUIsR0FBRyxPQUFPLEdBQUcsU0FBUyxHQUFHLEtBQUssRUFBRTtBQUN2RSxNQUFJLFNBQVUsTUFBSyxLQUFLLE1BQU0sUUFBUTtBQUV0QyxRQUFNLFNBQVMsUUFBUSxVQUFVLE1BQU0sSUFBSTtBQUMzQyxNQUFJLENBQUMsT0FBUSxRQUFPLENBQUM7QUFFckIsU0FBTyxPQUFPLE1BQU0sSUFBSSxFQUFFLE9BQU8sT0FBTyxFQUFFLElBQUksVUFBUTtBQUNwRCxVQUFNLENBQUMsUUFBUSxHQUFHLFNBQVMsSUFBSSxLQUFLLE1BQU0sR0FBSTtBQUM5QyxXQUFPLEVBQUUsUUFBUSxVQUFVLElBQUksTUFBTSxVQUFVLEtBQUssR0FBSSxFQUFFO0FBQUEsRUFDNUQsQ0FBQztBQUNIO0FBUU8sU0FBUyxrQkFBa0IsVUFBa0IsU0FBaUIsT0FBZSxjQUFzQztBQUN4SCxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFVBQVUsQ0FBQyxjQUFjO0FBQzNCLFdBQU8sT0FBTyxlQUFlLFVBQVUsU0FBUyxLQUFLO0FBQUEsRUFDdkQ7QUFFQSxRQUFNLFVBQVUsZUFBZSxHQUFHLE9BQU8sTUFBTSxLQUFLLEtBQUs7QUFDekQsUUFBTSxPQUFPLFVBQ1QsQ0FBQyxRQUFRLGFBQWEsT0FBTyxJQUM3QixDQUFDLFFBQVEsYUFBYSxTQUFTLEtBQUs7QUFDeEMsUUFBTSxTQUFTLFFBQVEsVUFBVSxNQUFNLElBQUk7QUFDM0MsTUFBSSxDQUFDLE9BQVEsUUFBTyxDQUFDO0FBRXJCLFNBQU8sT0FBTyxNQUFNLElBQUksRUFBRSxPQUFPLE9BQU8sRUFBRSxJQUFJLFVBQVE7QUFDcEQsVUFBTSxDQUFDLEdBQUcsR0FBRyxHQUFHLFNBQVMsSUFBSSxLQUFLLE1BQU0sR0FBSTtBQUM1QyxXQUFPO0FBQUEsTUFDTCxPQUFPLE1BQU0sTUFBTSxJQUFJLFNBQVMsS0FBSyxLQUFLLEVBQUU7QUFBQSxNQUM1QyxTQUFTLE1BQU0sTUFBTSxJQUFJLFNBQVMsS0FBSyxLQUFLLEVBQUU7QUFBQSxNQUM5QyxNQUFNLFVBQVUsS0FBSyxHQUFJO0FBQUEsSUFDM0I7QUFBQSxFQUNGLENBQUM7QUFDSDtBQVFPLFNBQVMsa0JBQ2QsVUFDQSxTQUNBLE9BQ0EsVUFDQSxTQUNBLGNBQ1E7QUFDUixRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLE9BQU8sZUFBZSxVQUFVLFNBQVMsT0FBTyxVQUFVLFNBQVMsWUFBWTtBQUFBLEVBQ3hGO0FBRUEsUUFBTSxZQUFZLGVBQWUsUUFBUTtBQUN6QyxRQUFNLE9BQU8sQ0FBQyxRQUFRLEdBQUcsT0FBTyxHQUFHLFNBQVMsR0FBRyxLQUFLLEVBQUU7QUFDdEQsTUFBSSxVQUFVO0FBQ1osU0FBSyxLQUFLLE1BQU0sUUFBUTtBQUFBLEVBQzFCLFdBQVcsU0FBUztBQUNsQixTQUFLLEtBQUssTUFBTSxLQUFLLGFBQWEsT0FBTyxFQUFFO0FBQUEsRUFDN0M7QUFFQSxTQUFPLFFBQVEsVUFBVSxNQUFNLElBQUk7QUFDckM7QUFPTyxTQUFTLGlCQUFpQixVQUFrQixTQUFpQixPQUE4QjtBQUNoRyxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLE9BQU8sY0FBYyxVQUFVLFNBQVMsS0FBSztBQUFBLEVBQ3REO0FBRUEsUUFBTSxTQUFTLFFBQVEsVUFBVSxDQUFDLE9BQU8sYUFBYSxHQUFHLE9BQU8sS0FBSyxLQUFLLEVBQUUsR0FBRyxJQUFJO0FBQ25GLE1BQUksQ0FBQyxPQUFRLFFBQU8sQ0FBQztBQUVyQixTQUFPLE9BQU8sTUFBTSxJQUFJLEVBQUUsT0FBTyxPQUFPLEVBQUUsSUFBSSxVQUFRO0FBQ3BELFVBQU0sTUFBTSxLQUFLLFVBQVUsR0FBRyxDQUFDO0FBQy9CLFVBQU0sVUFBVSxLQUFLLFVBQVUsQ0FBQztBQUNoQyxXQUFPLEVBQUUsS0FBSyxRQUFRO0FBQUEsRUFDeEIsQ0FBQztBQUNIO0FBT08sU0FBUyxtQkFBbUIsVUFBc0M7QUFDdkUsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxPQUFPLGdCQUFnQixRQUFRO0FBQUEsRUFDeEM7QUFFQSxRQUFNLFNBQVMsUUFBUSxVQUFVLENBQUMsWUFBWSxRQUFRLGFBQWEsR0FBRyxJQUFJO0FBQzFFLE1BQUksQ0FBQyxPQUFRLFFBQU8sQ0FBQztBQUVyQixRQUFNLFVBQThCLENBQUM7QUFDckMsUUFBTSxTQUFTLE9BQU8sV0FBVyxRQUFRLElBQUksRUFBRSxNQUFNLE1BQU0sRUFBRSxPQUFPLE9BQU87QUFFM0UsYUFBVyxTQUFTLFFBQVE7QUFDMUIsVUFBTSxRQUFRLE1BQU0sTUFBTSxJQUFJO0FBQzlCLFVBQU0sU0FBUyxNQUFNLEtBQUssT0FBSyxFQUFFLFdBQVcsV0FBVyxDQUFDO0FBQ3hELFVBQU0sYUFBYSxNQUFNLEtBQUssT0FBSyxFQUFFLFdBQVcsU0FBUyxDQUFDO0FBQzFELFVBQU0sU0FBUyxNQUFNLEtBQUssT0FBSyxNQUFNLE1BQU07QUFFM0MsUUFBSSxRQUFRO0FBQ1YsY0FBUSxLQUFLO0FBQUEsUUFDWCxNQUFNLE9BQU8sUUFBUSxhQUFhLEVBQUU7QUFBQSxRQUNwQyxRQUFRLGFBQWEsV0FBVyxRQUFRLHNCQUFzQixFQUFFLElBQUk7QUFBQSxRQUNwRTtBQUFBLE1BQ0YsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUNUO0FBT08sU0FBUyxpQkFBaUIsVUFBa0IsU0FBNEI7QUFDN0UsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxPQUFPLGNBQWMsVUFBVSxPQUFPO0FBQUEsRUFDL0M7QUFFQSxRQUFNLE9BQU8sQ0FBQyxVQUFVLFFBQVE7QUFDaEMsTUFBSSxRQUFTLE1BQUssS0FBSyxPQUFPO0FBRTlCLFFBQU0sU0FBUyxZQUFZLFVBQVUsTUFBTSxJQUFJO0FBQy9DLE1BQUksQ0FBQyxPQUFRLFFBQU8sQ0FBQztBQUVyQixTQUFPLE9BQU8sTUFBTSxJQUFJLEVBQUUsSUFBSSxPQUFLLEVBQUUsS0FBSyxFQUFFLFFBQVEsUUFBUSxFQUFFLENBQUMsRUFBRSxPQUFPLE9BQU87QUFDakY7QUFPTyxTQUFTLHVCQUF1QixVQUFrQixRQUFnQixTQUE0QjtBQUNuRyxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLE9BQU8sb0JBQW9CLFVBQVUsUUFBUSxPQUFPO0FBQUEsRUFDN0Q7QUFFQSxRQUFNLE9BQU8sQ0FBQyxVQUFVLFlBQVksTUFBTTtBQUMxQyxNQUFJLFFBQVMsTUFBSyxLQUFLLFVBQVUsT0FBTztBQUV4QyxRQUFNLFNBQVMsWUFBWSxVQUFVLE1BQU0sSUFBSTtBQUMvQyxNQUFJLENBQUMsT0FBUSxRQUFPLENBQUM7QUFFckIsU0FBTyxPQUFPLE1BQU0sSUFBSSxFQUFFLElBQUksT0FBSyxFQUFFLEtBQUssQ0FBQyxFQUFFLE9BQU8sT0FBTztBQUM3RDtBQU9PLFNBQVMsY0FBYyxVQUFrQixVQUE0QjtBQUMxRSxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLE9BQU8sV0FBVyxVQUFVLFFBQVE7QUFBQSxFQUM3QztBQUVBLFFBQU0sU0FBUyxZQUFZLFVBQVUsQ0FBQyxZQUFZLFFBQVEsR0FBRyxJQUFJO0FBQ2pFLE1BQUksQ0FBQyxPQUFRLFFBQU8sQ0FBQztBQUNyQixTQUFPLE9BQU8sTUFBTSxJQUFJLEVBQUUsT0FBTyxPQUFPO0FBQzFDO0FBT08sU0FBUyxpQkFBaUIsVUFBa0IsUUFBMEI7QUFDM0UsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxPQUFPLGNBQWMsVUFBVSxNQUFNO0FBQUEsRUFDOUM7QUFFQSxRQUFNLFNBQVMsWUFBWSxVQUFVLENBQUMsZ0JBQWdCLFFBQVEscUJBQXFCLEdBQUcsSUFBSTtBQUMxRixNQUFJLENBQUMsT0FBUSxRQUFPLENBQUM7QUFDckIsU0FBTyxPQUFPLE1BQU0sSUFBSSxFQUFFLE9BQU8sT0FBTztBQUMxQztBQU9PLFNBQVMsb0JBQW9CLFVBQTRCO0FBQzlELFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sT0FBTyxpQkFBaUIsUUFBUTtBQUFBLEVBQ3pDO0FBRUEsUUFBTSxTQUFTLFFBQVEsVUFBVSxDQUFDLFFBQVEsZUFBZSxpQkFBaUIsR0FBRyxJQUFJO0FBQ2pGLE1BQUksQ0FBQyxPQUFRLFFBQU8sQ0FBQztBQUNyQixTQUFPLE9BQU8sTUFBTSxJQUFJLEVBQUUsT0FBTyxPQUFPO0FBQzFDO0FBT08sU0FBUyxnQkFBZ0IsVUFBZ0M7QUFDOUQsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxPQUFPLGFBQWEsUUFBUTtBQUFBLEVBQ3JDO0FBRUEsUUFBTSxTQUFTLFFBQVEsVUFBVSxDQUFDLFVBQVUsZ0JBQWdCLEdBQUcsSUFBSTtBQUNuRSxRQUFNLFNBQVMsUUFBUSxVQUFVLENBQUMsVUFBVSxhQUFhLEdBQUcsSUFBSTtBQUNoRSxRQUFNLGFBQWEsV0FBVztBQUc5QixNQUFJLGNBQWM7QUFDbEIsTUFBSSxnQkFBZ0I7QUFDcEIsTUFBSSxRQUFRO0FBQ1YsZUFBVyxRQUFRLE9BQU8sTUFBTSxJQUFJLEdBQUc7QUFDckMsVUFBSSxDQUFDLFFBQVEsS0FBSyxTQUFTLEVBQUc7QUFDOUIsWUFBTSxJQUFJLEtBQUssQ0FBQztBQUNoQixZQUFNLElBQUksS0FBSyxDQUFDO0FBQ2hCLFVBQUksTUFBTSxPQUFPLE1BQU0sSUFBSztBQUM1QixVQUFJLE1BQU0sT0FBTyxNQUFNLElBQUs7QUFDNUIsVUFBSSxNQUFNLE9BQU8sTUFBTSxJQUFLO0FBQUEsSUFDOUI7QUFBQSxFQUNGO0FBRUEsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUNGO0FBU08sU0FBUyxXQUFXLFVBQWtCLGVBQThCO0FBQ3pFLFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sUUFBUSxVQUFVLGFBQWE7QUFDdEM7QUFBQSxFQUNGO0FBRUEsUUFBTSxPQUFPLENBQUMsTUFBTTtBQUNwQixNQUFJLGNBQWUsTUFBSyxLQUFLLE1BQU0sYUFBYTtBQUNoRCxjQUFZLFVBQVUsSUFBSTtBQUM1QjtBQU9PLFNBQVMsYUFBYSxVQUF3QjtBQUNuRCxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLFVBQVUsUUFBUTtBQUN6QjtBQUFBLEVBQ0Y7QUFDQSxjQUFZLFVBQVUsQ0FBQyxPQUFPLElBQUksQ0FBQztBQUNyQztBQVFPLFNBQVMsaUJBQWlCLFVBQXdCO0FBQ3ZELGNBQVksVUFBVSxDQUFDLE9BQU8sSUFBSSxDQUFDO0FBQ3JDO0FBRU8sU0FBUyxnQkFBZ0IsVUFBa0IsTUFBdUI7QUFDdkUsTUFBSTtBQUNGLGlCQUFhLE9BQU8sQ0FBQyxnQkFBZ0IsTUFBTSxNQUFNLElBQUksR0FBRztBQUFBLE1BQ3RELEtBQUs7QUFBQSxNQUNMLE9BQU87QUFBQSxNQUNQLEtBQUs7QUFBQSxJQUNQLENBQUM7QUFDRCxXQUFPO0FBQUEsRUFDVCxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLFNBQVMsZ0JBQWdCLFVBQTJCO0FBQ2xELFNBQU8sQ0FBQyxRQUFRLE9BQU8sRUFBRSxLQUFLLFVBQVEsZ0JBQWdCLFVBQVUsSUFBSSxDQUFDO0FBQ3ZFO0FBV0EsU0FBUyw4QkFBOEIsVUFBMkI7QUFDaEUsUUFBTSxZQUFZLEtBQUssVUFBVSxRQUFRLGdCQUFnQjtBQUN6RCxNQUFJLENBQUMsV0FBVyxTQUFTLEVBQUcsUUFBTztBQUNuQyxNQUFJO0FBQ0YsVUFBTSxVQUFVLGFBQWEsV0FBVyxPQUFPO0FBSS9DLFdBQU8sd0NBQXdDLEtBQUssT0FBTztBQUFBLEVBQzdELFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBV0EsU0FBUyx3QkFBd0IsVUFBMkI7QUFDMUQsTUFBSSw4QkFBOEIsUUFBUSxFQUFHLFFBQU87QUFFcEQsUUFBTSxnQkFBZ0IsS0FBSyxVQUFVLFlBQVk7QUFDakQsTUFBSTtBQUNGLFVBQU0sV0FBVyxXQUFXLGFBQWEsSUFBSSxhQUFhLGVBQWUsT0FBTyxJQUFJO0FBQ3BGLFVBQU0sUUFBUSxJQUFJO0FBQUEsTUFDaEIsU0FBUyxNQUFNLElBQUksRUFBRSxJQUFJLE9BQUssRUFBRSxLQUFLLENBQUMsRUFBRSxPQUFPLE9BQUssS0FBSyxDQUFDLEVBQUUsV0FBVyxHQUFHLENBQUM7QUFBQSxJQUM3RTtBQUNBLFFBQUksTUFBTSxJQUFJLE1BQU0sS0FBSyxNQUFNLElBQUksT0FBTyxFQUFHLFFBQU87QUFFcEQsVUFBTSxTQUFTLFNBQVMsU0FBUyxLQUFLLENBQUMsU0FBUyxTQUFTLElBQUksSUFBSSxPQUFPO0FBQ3hFLFVBQU0sUUFBUSxHQUFHLE1BQU07QUFBQTtBQUFBO0FBQUE7QUFDdkIsa0JBQWMsZUFBZSxXQUFXLE9BQU8sT0FBTztBQUN0RCxXQUFPO0FBQUEsRUFDVCxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQVFBLFNBQVMsOEJBQThCLFVBQXdCO0FBRzdELGNBQVksVUFBVSxDQUFDLE9BQU8sSUFBSSxDQUFDO0FBSW5DLFFBQU0sU0FBUyxZQUFZLFVBQVUsQ0FBQyxVQUFVLGtCQUFrQixJQUFJLEdBQUcsSUFBSTtBQUM3RSxNQUFJLENBQUMsT0FBUTtBQUViLFFBQU0sWUFBc0IsQ0FBQztBQUM3QixhQUFXLFNBQVMsT0FBTyxNQUFNLElBQUksR0FBRztBQUN0QyxRQUFJLENBQUMsTUFBTztBQUVaLFFBQUksTUFBTSxTQUFTLEVBQUc7QUFDdEIsVUFBTSxPQUFPLE1BQU0sTUFBTSxHQUFHLENBQUM7QUFDN0IsVUFBTSxPQUFPLE1BQU0sTUFBTSxDQUFDO0FBQzFCLFFBQUksU0FBUyxLQUFNO0FBS25CLFFBQUksU0FBUyxVQUFVLEtBQUssV0FBVyxPQUFPLEVBQUc7QUFDakQsUUFBSSxTQUFTLGFBQWEsU0FBUyxpQkFBa0I7QUFDckQsUUFBSSxTQUFTLGVBQWUsS0FBSyxXQUFXLFlBQVksRUFBRztBQUMzRCxjQUFVLEtBQUssSUFBSTtBQUFBLEVBQ3JCO0FBRUEsTUFBSSxVQUFVLFdBQVcsRUFBRztBQUU1QixRQUFNLFFBQVE7QUFDZCxXQUFTLElBQUksR0FBRyxJQUFJLFVBQVUsUUFBUSxLQUFLLE9BQU87QUFDaEQsZ0JBQVksVUFBVSxDQUFDLE9BQU8sTUFBTSxHQUFHLFVBQVUsTUFBTSxHQUFHLElBQUksS0FBSyxDQUFDLENBQUM7QUFBQSxFQUN2RTtBQUNGO0FBT0EsU0FBUyxpQ0FBaUMsVUFBd0I7QUFDaEUsTUFBSSxnQkFBZ0IsUUFBUSxHQUFHO0FBQzdCLGdCQUFZLFVBQVUsQ0FBQyxPQUFPLElBQUksQ0FBQztBQUNuQztBQUFBLEVBQ0Y7QUFDQSxNQUFJLHdCQUF3QixRQUFRLEdBQUc7QUFDckMsZ0JBQVksVUFBVSxDQUFDLE9BQU8sSUFBSSxDQUFDO0FBQ25DO0FBQUEsRUFDRjtBQUVBLGdDQUE4QixRQUFRO0FBQ3hDO0FBZU8sU0FBUywyQkFBMkIsVUFBa0IsWUFBcUM7QUFDaEcsTUFBSSxXQUFXLFdBQVcsR0FBRztBQUMzQixpQkFBYSxRQUFRO0FBQ3JCO0FBQUEsRUFDRjtBQUNBLFFBQU0sWUFBWSxXQUFXLElBQUksT0FBSyxLQUFLLENBQUMsRUFBRTtBQUM5QyxNQUFJO0FBQ0YsaUJBQWEsT0FBTyxDQUFDLE9BQU8sTUFBTSxNQUFNLEdBQUcsU0FBUyxHQUFHO0FBQUEsTUFDckQsS0FBSztBQUFBLE1BQ0wsT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNO0FBQUEsTUFDaEMsVUFBVTtBQUFBLE1BQ1YsS0FBSztBQUFBLElBQ1AsQ0FBQztBQUFBLEVBQ0gsU0FBUyxLQUFjO0FBQ3JCLFVBQU0sU0FBVSxLQUE2QixVQUFVO0FBQ3ZELFVBQU0sWUFBWSxzQkFBc0IsR0FBRyxLQUFLLHNCQUFzQixNQUFNO0FBQzVFLFFBQUksV0FBVztBQUNiLFlBQU07QUFBQSxJQUNSO0FBR0EsUUFBSSxPQUFPLFNBQVMseUNBQXlDLEdBQUc7QUFDOUQ7QUFBQSxJQUNGO0FBTUEsUUFBSSxPQUFPLFNBQVMsd0JBQXdCLEdBQUc7QUFDN0MsdUNBQWlDLFFBQVE7QUFDekM7QUFBQSxJQUNGO0FBQ0EsVUFBTSxlQUFlLE9BQU8sS0FBSyxJQUFJLGFBQWEsT0FBTyxLQUFLLENBQUMsS0FBSztBQUNwRSxVQUFNLElBQUksU0FBUyxlQUFlLHdDQUF3QyxRQUFRLEtBQUssZ0JBQWdCLEdBQUcsQ0FBQyxHQUFHLFlBQVksRUFBRTtBQUFBLEVBQzlIO0FBQ0Y7QUFPTyxTQUFTLGVBQWUsVUFBa0IsT0FBdUI7QUFDdEUsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxZQUFZLFVBQVUsS0FBSztBQUNsQztBQUFBLEVBQ0Y7QUFDQSxjQUFZLFVBQVUsQ0FBQyxPQUFPLE1BQU0sR0FBRyxLQUFLLENBQUM7QUFDL0M7QUFPTyxTQUFTLGlCQUFpQixVQUFrQixPQUF1QjtBQUN4RSxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLGNBQWMsVUFBVSxLQUFLO0FBQ3BDO0FBQUEsRUFDRjtBQUNBLGFBQVcsS0FBSyxPQUFPO0FBQ3JCLFlBQVEsVUFBVSxDQUFDLFNBQVMsUUFBUSxNQUFNLENBQUMsR0FBRyxJQUFJO0FBQUEsRUFDcEQ7QUFDRjtBQVdPLFNBQVMsYUFDZCxVQUNBLFNBQ0EsU0FDZTtBQUlmLE1BQUk7QUFDRixVQUFNLE9BQU8sQ0FBQyxVQUFVLE1BQU0sR0FBRztBQUNqQyxRQUFJLFNBQVMsV0FBWSxNQUFLLEtBQUssZUFBZTtBQUNsRCxVQUFNLFNBQVMseUJBQXlCLFVBQVUsTUFBTTtBQUFBLE1BQ3RELE9BQU8sQ0FBQyxRQUFRLFFBQVEsTUFBTTtBQUFBLE1BQzlCLE9BQU87QUFBQSxJQUNULENBQUM7QUFDRCxXQUFPO0FBQUEsRUFDVCxTQUFTLEtBQWM7QUFDckIsVUFBTSxTQUFTO0FBQ2YsVUFBTSxXQUFXLENBQUMsT0FBTyxRQUFRLE9BQU8sUUFBUSxPQUFPLE9BQU8sRUFBRSxPQUFPLE9BQU8sRUFBRSxLQUFLLEdBQUc7QUFDeEYsUUFBSSxTQUFTLFNBQVMsbUJBQW1CLEtBQUssU0FBUyxTQUFTLHlCQUF5QixLQUFLLFNBQVMsU0FBUyxrQkFBa0IsR0FBRztBQUNuSSxhQUFPO0FBQUEsSUFDVDtBQUNBLFVBQU07QUFBQSxFQUNSO0FBQ0Y7QUFPTyxTQUFTLHFCQUFxQixVQUFrQixRQUFzQjtBQUMzRSxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLGtCQUFrQixVQUFVLE1BQU07QUFDekM7QUFBQSxFQUNGO0FBQ0EsZUFBYSxPQUFPLENBQUMsWUFBWSxNQUFNLEdBQUc7QUFBQSxJQUN4QyxLQUFLO0FBQUEsSUFDTCxPQUFPLENBQUMsVUFBVSxRQUFRLE1BQU07QUFBQSxJQUNoQyxVQUFVO0FBQUEsRUFDWixDQUFDO0FBQ0g7QUFPTyxTQUFTLHFCQUFxQixVQUFrQixPQUF1QjtBQUM1RSxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLGtCQUFrQixVQUFVLEtBQUs7QUFDeEM7QUFBQSxFQUNGO0FBQ0EsYUFBVyxRQUFRLE9BQU87QUFDeEIsZ0JBQVksVUFBVSxDQUFDLFlBQVksWUFBWSxNQUFNLElBQUksQ0FBQztBQUFBLEVBQzVEO0FBQ0Y7QUFPTyxTQUFTLGtCQUFrQixVQUFrQixRQUFnQztBQUNsRixRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLE9BQU8sZUFBZSxVQUFVLE1BQU07QUFBQSxFQUMvQztBQUVBLE1BQUk7QUFDRixpQkFBYSxPQUFPLENBQUMsU0FBUyxZQUFZLE1BQU0sR0FBRztBQUFBLE1BQ2pELEtBQUs7QUFBQSxNQUNMLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTTtBQUFBLE1BQ2hDLFVBQVU7QUFBQSxNQUNWLEtBQUs7QUFBQSxJQUNQLENBQUM7QUFDRCxXQUFPLEVBQUUsU0FBUyxNQUFNLFdBQVcsQ0FBQyxFQUFFO0FBQUEsRUFDeEMsU0FBUyxLQUFjO0FBTXJCLFVBQU0sU0FDSixlQUFlLFFBQVMsSUFBb0MsVUFBVSxJQUFJLFVBQVUsT0FBTyxHQUFHO0FBQ2hHLFFBQ0UsT0FBTyxTQUFTLG9DQUFvQyxLQUNwRCxPQUFPLFNBQVMsOENBQThDLEtBQzlELE9BQU8sU0FBUyxzQkFBc0IsR0FDdEM7QUFLQSxZQUFNLGFBQWEsT0FDaEIsTUFBTSxJQUFJLEVBQ1YsT0FBTyxDQUFDLFNBQVMsS0FBSyxXQUFXLEdBQUksQ0FBQyxFQUN0QyxJQUFJLENBQUMsU0FBUyxLQUFLLEtBQUssQ0FBQyxFQUN6QixPQUFPLE9BQU87QUFDakIsYUFBTyxFQUFFLFNBQVMsT0FBTyxXQUFXLENBQUMsd0JBQXdCLEdBQUcsV0FBVztBQUFBLElBQzdFO0FBR0EsVUFBTSxpQkFBaUIsUUFBUSxVQUFVLENBQUMsUUFBUSxlQUFlLGlCQUFpQixHQUFHLElBQUk7QUFDekYsVUFBTSxZQUFZLGlCQUFpQixlQUFlLE1BQU0sSUFBSSxFQUFFLE9BQU8sT0FBTyxJQUFJLENBQUM7QUFDakYsUUFBSSxVQUFVLFNBQVMsR0FBRztBQUN4QixhQUFPLEVBQUUsU0FBUyxPQUFPLFVBQVU7QUFBQSxJQUNyQztBQUdBLFVBQU07QUFBQSxFQUNSO0FBQ0Y7QUFPTyxTQUFTLGlCQUFpQixVQUF3QjtBQUN2RCxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLGNBQWMsUUFBUTtBQUM3QjtBQUFBLEVBQ0Y7QUFDQSxVQUFRLFVBQVUsQ0FBQyxTQUFTLFNBQVMsR0FBRyxJQUFJO0FBQzlDO0FBT08sU0FBUyxrQkFBa0IsVUFBd0I7QUFDeEQsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxlQUFlLFFBQVE7QUFDOUI7QUFBQSxFQUNGO0FBQ0EsVUFBUSxVQUFVLENBQUMsVUFBVSxTQUFTLEdBQUcsSUFBSTtBQUMvQztBQU9PLFNBQVMsZ0JBQWdCLFVBQXdCO0FBQ3RELFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sYUFBYSxRQUFRO0FBQzVCO0FBQUEsRUFDRjtBQUNBLGVBQWEsT0FBTyxDQUFDLFNBQVMsVUFBVSxNQUFNLEdBQUcsRUFBRSxLQUFLLFVBQVUsT0FBTyxPQUFPLENBQUM7QUFDbkY7QUFPTyxTQUFTLGdCQUFnQixVQUFrQixRQUFzQjtBQUN0RSxlQUFhLE9BQU8sQ0FBQyxTQUFTLFVBQVUsTUFBTSxHQUFHO0FBQUEsSUFDL0MsS0FBSztBQUFBLElBQ0wsT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNO0FBQUEsSUFDaEMsVUFBVTtBQUFBLElBQ1YsS0FBSztBQUFBLEVBQ1AsQ0FBQztBQUNIO0FBTU8sU0FBUyxvQkFBb0IsVUFBa0IsS0FBcUI7QUFDekUsTUFBSTtBQUNGLFdBQU8sYUFBYSxPQUFPLENBQUMsT0FBTyxNQUFNLGVBQWUsR0FBRyxHQUFHO0FBQUEsTUFDNUQsS0FBSztBQUFBLE1BQ0wsT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNO0FBQUEsTUFDaEMsVUFBVTtBQUFBLE1BQ1YsS0FBSztBQUFBLElBQ1AsQ0FBQyxFQUFFLEtBQUs7QUFBQSxFQUNWLFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBT08sU0FBUyxtQkFBbUIsVUFBa0IsUUFBZ0IsUUFBUSxNQUFZO0FBQ3ZGLFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sZ0JBQWdCLFVBQVUsUUFBUSxLQUFLO0FBQzlDO0FBQUEsRUFDRjtBQUNBLGNBQVksVUFBVSxDQUFDLFVBQVUsUUFBUSxPQUFPLE1BQU0sTUFBTSxDQUFDO0FBQy9EO0FBT08sU0FBUyx1QkFBdUIsVUFBa0IsUUFBZ0IsUUFBc0I7QUFDN0YsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxvQkFBb0IsVUFBVSxRQUFRLE1BQU07QUFDbkQ7QUFBQSxFQUNGO0FBQ0EsVUFBUSxVQUFVLENBQUMsVUFBVSxNQUFNLFFBQVEsTUFBTSxDQUFDO0FBQ3BEO0FBUU8sU0FBUyxlQUFlLFVBQWtCLE9BQWlCLFlBQVksTUFBZ0I7QUFDNUYsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxPQUFPLFlBQVksVUFBVSxPQUFPLFNBQVM7QUFBQSxFQUN0RDtBQUVBLFFBQU0sVUFBb0IsQ0FBQztBQUMzQixhQUFXLFFBQVEsT0FBTztBQUN4QixVQUFNLFNBQVM7QUFBQSxNQUNiO0FBQUEsTUFDQSxDQUFDLE1BQU0sWUFBWSxHQUFJLFlBQVksQ0FBQyxJQUFJLElBQUksQ0FBQyxHQUFJLG9CQUFvQixJQUFJO0FBQUEsTUFDekU7QUFBQSxJQUNGO0FBQ0EsUUFBSSxPQUFRLFNBQVEsS0FBSyxNQUFNO0FBQUEsRUFDakM7QUFDQSxTQUFPO0FBQ1Q7QUFPTyxTQUFTLGNBQWMsVUFBa0IsT0FBdUI7QUFDckUsUUFBTSxTQUFTLFdBQVc7QUFDMUIsTUFBSSxRQUFRO0FBQ1YsV0FBTyxXQUFXLFVBQVUsS0FBSztBQUNqQztBQUFBLEVBQ0Y7QUFDQSxhQUFXLFFBQVEsT0FBTztBQUN4QixnQkFBWSxVQUFVLENBQUMsTUFBTSxXQUFXLE1BQU0sSUFBSSxHQUFHLElBQUk7QUFBQSxFQUMzRDtBQUNGO0FBRUEsU0FBUyxrQkFDUCxVQUNBLFFBQ0EsUUFDQSxjQUNBLFlBQ007QUFDTixNQUFJLGNBQWM7QUFDaEIsVUFBTSxZQUFZLFFBQVEsVUFBVSxDQUFDLFlBQVksWUFBWSxjQUFjLE1BQU0sRUFBRSxHQUFHLElBQUk7QUFDMUYsUUFBSSxXQUFXO0FBQ2IsY0FBUSxVQUFVLENBQUMsWUFBWSxPQUFPLFFBQVEsTUFBTSxDQUFDO0FBQ3JEO0FBQUEsSUFDRjtBQUNBLFlBQVEsVUFBVSxDQUFDLFlBQVksT0FBTyxNQUFNLFFBQVEsUUFBUSxjQUFjLE1BQU0sQ0FBQztBQUFBLEVBQ25GLE9BQU87QUFDTCxZQUFRLFVBQVUsQ0FBQyxZQUFZLE9BQU8sUUFBUSxNQUFNLENBQUM7QUFBQSxFQUN2RDtBQUNGO0FBRU8sU0FBUywyQkFBMkIsUUFBc0I7QUFDL0QsTUFBSSxXQUFXLEtBQUssUUFBUSxNQUFNLENBQUMsRUFBRztBQUN0QyxRQUFNLElBQUk7QUFBQSxJQUNSO0FBQUEsSUFDQSw0REFBNEQsTUFBTTtBQUFBLEVBQ3BFO0FBQ0Y7QUFPTyxTQUFTLGtCQUNkLFVBQ0EsUUFDQSxRQUNBLGNBQ0EsWUFDTTtBQUNOLFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sZUFBZSxVQUFVLFFBQVEsUUFBUSxjQUFjLFVBQVU7QUFDeEUsUUFBSTtBQUNGLGlDQUEyQixNQUFNO0FBQ2pDO0FBQUEsSUFDRixRQUFRO0FBQ04sYUFBTyxRQUFRLEVBQUUsV0FBVyxNQUFNLE9BQU8sS0FBSyxDQUFDO0FBQy9DLGNBQVEsVUFBVSxDQUFDLFlBQVksT0FBTyxHQUFHLElBQUk7QUFDN0Msd0JBQWtCLFVBQVUsUUFBUSxRQUFRLGNBQWMsVUFBVTtBQUNwRSxpQ0FBMkIsTUFBTTtBQUNqQztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsb0JBQWtCLFVBQVUsUUFBUSxRQUFRLGNBQWMsVUFBVTtBQUNwRSw2QkFBMkIsTUFBTTtBQUNuQztBQU9PLFNBQVMscUJBQXFCLFVBQWtCLFFBQWdCLFFBQVEsT0FBYTtBQUMxRixRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLGtCQUFrQixVQUFVLFFBQVEsS0FBSztBQUNoRDtBQUFBLEVBQ0Y7QUFFQSxRQUFNLE9BQU8sQ0FBQyxZQUFZLFFBQVE7QUFDbEMsTUFBSSxNQUFPLE1BQUssS0FBSyxTQUFTO0FBQzlCLE9BQUssS0FBSyxNQUFNO0FBQ2hCLFVBQVEsVUFBVSxNQUFNLElBQUk7QUFDOUI7QUFPTyxTQUFTLG9CQUFvQixVQUF3QjtBQUMxRCxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLGlCQUFpQixRQUFRO0FBQ2hDO0FBQUEsRUFDRjtBQUNBLFVBQVEsVUFBVSxDQUFDLFlBQVksT0FBTyxHQUFHLElBQUk7QUFDL0M7QUFPTyxTQUFTLG1CQUFtQixVQUFrQixLQUFtQjtBQUN0RSxRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLGdCQUFnQixVQUFVLEdBQUc7QUFDcEM7QUFBQSxFQUNGO0FBQ0EsY0FBWSxVQUFVLENBQUMsVUFBVSxlQUFlLEdBQUcsQ0FBQztBQUN0RDtBQU9PLFNBQVMsa0JBQWtCLFVBQXdCO0FBQ3hELFFBQU0sU0FBUyxXQUFXO0FBQzFCLE1BQUksUUFBUTtBQUNWLFdBQU8sZUFBZSxRQUFRO0FBQzlCO0FBQUEsRUFDRjtBQUNBLGNBQVksVUFBVSxDQUFDLFVBQVUsU0FBUyxHQUFHLElBQUk7QUFDbkQ7QUFRTyxTQUFTLGdCQUFnQixVQUFrQixTQUFpQixRQUF1QjtBQUN4RixRQUFNLFNBQVMsV0FBVztBQUMxQixNQUFJLFFBQVE7QUFDVixXQUFPLGFBQWEsVUFBVSxTQUFTLE1BQU07QUFDN0M7QUFBQSxFQUNGO0FBRUEsTUFBSSxXQUFXLFFBQVc7QUFDeEIsWUFBUSxVQUFVLENBQUMsY0FBYyxTQUFTLE1BQU0sQ0FBQztBQUFBLEVBQ25ELE9BQU87QUFDTCxZQUFRLFVBQVUsQ0FBQyxjQUFjLE1BQU0sT0FBTyxHQUFHLElBQUk7QUFBQSxFQUN2RDtBQUNGO0FBS08sU0FBUyx1QkFBZ0M7QUFDOUMsU0FBTyxXQUFXLE1BQU07QUFDMUI7QUFPTyxTQUFTLGlCQUFpQixVQUFrQixVQUFrQixZQUE2QjtBQUNoRyxNQUFJO0FBQ0YsaUJBQWEsT0FBTyxDQUFDLGNBQWMsaUJBQWlCLFVBQVUsVUFBVSxHQUFHO0FBQUEsTUFDekUsS0FBSztBQUFBLE1BQ0wsT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNO0FBQUEsTUFDaEMsS0FBSztBQUFBLElBQ1AsQ0FBQztBQUNELFdBQU87QUFBQSxFQUNULFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBT08sU0FBUyxzQkFBc0IsVUFBa0IsS0FBcUI7QUFDM0UsTUFBSTtBQUNGLFVBQU0sU0FBUyxhQUFhLE9BQU8sQ0FBQyxPQUFPLE1BQU0sZ0JBQWdCLEdBQUcsR0FBRztBQUFBLE1BQ3JFLEtBQUs7QUFBQSxNQUNMLE9BQU8sQ0FBQyxVQUFVLFFBQVEsTUFBTTtBQUFBLE1BQ2hDLFVBQVU7QUFBQSxNQUNWLEtBQUs7QUFBQSxJQUNQLENBQUMsRUFBRSxLQUFLO0FBQ1IsV0FBTyxTQUFTLFFBQVEsRUFBRSxLQUFLO0FBQUEsRUFDakMsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFPTyxTQUFTLG9CQUFvQixVQUFrQixRQUF3QjtBQUM1RSxNQUFJO0FBQ0YsVUFBTSxTQUFTLGFBQWEsT0FBTyxDQUFDLFlBQVksUUFBUSxTQUFTLGFBQWEsU0FBUyxHQUFHO0FBQUEsTUFDeEYsS0FBSztBQUFBLE1BQ0wsT0FBTyxDQUFDLFVBQVUsUUFBUSxNQUFNO0FBQUEsTUFDaEMsVUFBVTtBQUFBLE1BQ1YsS0FBSztBQUFBLElBQ1AsQ0FBQyxFQUFFLEtBQUs7QUFDUixXQUFPLFNBQVMsUUFBUSxFQUFFLEtBQUs7QUFBQSxFQUNqQyxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K
