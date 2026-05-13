import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { gsdRoot } from "./paths.js";
import { GIT_NO_PROMPT_ENV } from "./git-constants.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { logWarning } from "./workflow-logger.js";
import {
  detectWorktreeName
} from "./worktree.js";
import { SLICE_BRANCH_RE, QUICK_BRANCH_RE, WORKFLOW_BRANCH_RE } from "./branch-patterns.js";
import {
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeBranchExists,
  nativeHasChanges,
  nativeAddAllWithExclusions,
  nativeHasStagedChanges,
  nativeCommit,
  nativeRmCached,
  nativeUpdateRef,
  nativeAddPaths,
  nativeResetSoft,
  nativeCommitSubject,
  nativeIsIgnored,
  _resetHasChangesCache
} from "./native-git-bridge.js";
import { GSDError, GSD_MERGE_CONFLICT, GSD_GIT_ERROR } from "./errors.js";
import { getErrorMessage } from "./error-utils.js";
import { isInfrastructureError } from "./auto/infra-errors.js";
const VALID_BRANCH_NAME = /^[a-zA-Z0-9_\-\/.]+$/;
function buildTaskCommitMessage(ctx) {
  const description = sanitizeCommitSubjectDescription(ctx.oneLiner || ctx.taskTitle);
  const type = inferCommitType(ctx.taskTitle, ctx.oneLiner);
  const maxDescLen = 70 - type.length;
  const truncated = description.length > maxDescLen ? description.slice(0, maxDescLen - 1).trimEnd() + "\u2026" : description;
  const subject = `${type}: ${truncated}`;
  const bodyParts = [];
  if (ctx.keyFiles && ctx.keyFiles.length > 0) {
    const fileLines = ctx.keyFiles.slice(0, 8).map((f) => `- ${f}`).join("\n");
    bodyParts.push(fileLines);
  }
  const contextLines = buildTaskCommitContextLines(ctx);
  if (contextLines.length > 0) {
    bodyParts.push(`GSD context:
${contextLines.join("\n")}`);
  }
  bodyParts.push(`GSD-Task: ${ctx.taskId}`);
  if (ctx.issueNumber) {
    bodyParts.push(`Resolves #${ctx.issueNumber}`);
  }
  return `${subject}

${bodyParts.join("\n\n")}`;
}
function buildTaskCommitContextLines(ctx) {
  const lines = [];
  const milestone = formatNamedContext(ctx.milestoneId, ctx.milestoneTitle);
  const slice = formatNamedContext(ctx.sliceId, ctx.sliceTitle);
  const taskId = ctx.taskDisplayId ?? ctx.taskId.split("/").pop();
  const task = formatNamedContext(taskId, ctx.taskTitle);
  if (milestone) lines.push(`- Milestone: ${milestone}`);
  if (slice) lines.push(`- Slice: ${slice}`);
  if (task) lines.push(`- Task: ${task}`);
  return lines;
}
function formatNamedContext(id, title) {
  const cleanId = id?.trim();
  const cleanTitle = title?.trim();
  if (!cleanId && !cleanTitle) return null;
  if (!cleanId) return cleanTitle ?? null;
  if (!cleanTitle || cleanTitle === cleanId) return cleanId;
  return `${cleanId} - ${cleanTitle}`;
}
function sanitizeCommitSubjectDescription(value) {
  const cleaned = value.replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "update task";
}
function normalizeRepoRelativePath(basePath, filePath) {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const relPath = isAbsolute(trimmed) ? relative(basePath, trimmed) : normalize(trimmed);
  if (!relPath || relPath === "." || isAbsolute(relPath) || relPath.startsWith(`..${sep}`) || relPath === "..") {
    return null;
  }
  const resolved = resolve(basePath, relPath);
  const relFromBase = relative(basePath, resolved);
  if (!relFromBase || relFromBase === "." || relFromBase.startsWith("..") || isAbsolute(relFromBase)) {
    return null;
  }
  return relFromBase;
}
function pathspecToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
function isExcludedScopedPath(path, exclusions) {
  const normalizedPath = path.replace(/\\/g, "/");
  for (const exclusion of exclusions) {
    const normalizedExclusion = exclusion.replace(/^:!/, "").replace(/\\/g, "/");
    if (!normalizedExclusion) continue;
    if (normalizedExclusion.endsWith("/")) {
      if (normalizedPath === normalizedExclusion.slice(0, -1) || normalizedPath.startsWith(normalizedExclusion)) {
        return true;
      }
      continue;
    }
    if (normalizedExclusion.includes("*")) {
      if (pathspecToRegex(normalizedExclusion).test(normalizedPath)) return true;
      continue;
    }
    if (normalizedPath === normalizedExclusion) return true;
  }
  return false;
}
function submodulePathsFromLsFiles(output) {
  const submodulePaths = /* @__PURE__ */ new Set();
  if (!output) return submodulePaths;
  for (const line of output.split("\n")) {
    const match = line.match(/^160000\s+\S+\s+\d+\t(.+)$/);
    if (!match) continue;
    submodulePaths.add(match[1].replace(/\\/g, "/").replace(/\/+$/, ""));
  }
  return submodulePaths;
}
function isInsideSubmodule(path, submodulePaths) {
  const normalizedPath = path.replace(/\\/g, "/");
  if (submodulePaths.has(normalizedPath)) return true;
  let slashIndex = normalizedPath.lastIndexOf("/");
  while (slashIndex > 0) {
    if (submodulePaths.has(normalizedPath.slice(0, slashIndex))) return true;
    slashIndex = normalizedPath.lastIndexOf("/", slashIndex - 1);
  }
  return false;
}
class MergeConflictError extends GSDError {
  conflictedFiles;
  strategy;
  branch;
  mainBranch;
  constructor(conflictedFiles, strategy, branch, mainBranch) {
    super(
      GSD_MERGE_CONFLICT,
      `${strategy === "merge" ? "Merge" : "Squash-merge"} of "${branch}" into "${mainBranch}" failed with conflicts in ${conflictedFiles.length} non-.gsd file(s): ${conflictedFiles.join(", ")}`
    );
    this.name = "MergeConflictError";
    this.conflictedFiles = conflictedFiles;
    this.strategy = strategy;
    this.branch = branch;
    this.mainBranch = mainBranch;
  }
}
const RUNTIME_EXCLUSION_PATHS = [
  ".gsd/activity/",
  ".gsd/audit/",
  ".gsd/forensics/",
  ".gsd/runtime/",
  ".gsd/worktrees/",
  ".gsd/parallel/",
  ".gsd/auto.lock",
  ".gsd/metrics.json",
  ".gsd/completed-units*.json",
  // covers completed-units.json and archived completed-units-{MID}.json
  ".gsd/state-manifest.json",
  ".gsd/STATE.md",
  ".gsd/gsd.db*",
  ".gsd/journal/",
  ".gsd/doctor-history.jsonl",
  ".gsd/event-log.jsonl",
  ".gsd/DISCUSSION-MANIFEST.json"
];
function milestoneMetaPath(basePath, milestoneId) {
  return join(gsdRoot(basePath), "milestones", milestoneId, `${milestoneId}-META.json`);
}
function readIntegrationBranch(basePath, milestoneId) {
  try {
    const metaFile = milestoneMetaPath(basePath, milestoneId);
    if (!existsSync(metaFile)) return null;
    const data = JSON.parse(readFileSync(metaFile, "utf-8"));
    const branch = data?.integrationBranch;
    if (typeof branch === "string" && branch.trim() !== "" && VALID_BRANCH_NAME.test(branch)) {
      return branch;
    }
    return null;
  } catch {
    return null;
  }
}
import { QUICK_BRANCH_RE as QUICK_BRANCH_RE2, WORKFLOW_BRANCH_RE as WORKFLOW_BRANCH_RE2 } from "./branch-patterns.js";
function writeIntegrationBranch(basePath, milestoneId, branch) {
  if (SLICE_BRANCH_RE.test(branch)) return;
  if (QUICK_BRANCH_RE.test(branch)) return;
  if (WORKFLOW_BRANCH_RE.test(branch)) return;
  if (!VALID_BRANCH_NAME.test(branch)) return;
  const existingBranch = readIntegrationBranch(basePath, milestoneId);
  if (existingBranch === branch) return;
  const metaFile = milestoneMetaPath(basePath, milestoneId);
  mkdirSync(join(gsdRoot(basePath), "milestones", milestoneId), { recursive: true });
  let existing = {};
  try {
    if (existsSync(metaFile)) {
      existing = JSON.parse(readFileSync(metaFile, "utf-8"));
    }
  } catch {
  }
  existing.integrationBranch = branch;
  writeFileSync(metaFile, JSON.stringify(existing, null, 2) + "\n", "utf-8");
}
function resolveMilestoneIntegrationBranch(basePath, milestoneId, prefs = {}) {
  const recordedBranch = readIntegrationBranch(basePath, milestoneId);
  if (!recordedBranch) {
    return {
      recordedBranch: null,
      effectiveBranch: null,
      status: "missing",
      reason: `Milestone ${milestoneId} has no recorded integration branch metadata.`
    };
  }
  if (nativeBranchExists(basePath, recordedBranch)) {
    return {
      recordedBranch,
      effectiveBranch: recordedBranch,
      status: "recorded",
      reason: `Using recorded integration branch "${recordedBranch}" for milestone ${milestoneId}.`
    };
  }
  const configuredBranch = prefs.main_branch && VALID_BRANCH_NAME.test(prefs.main_branch) ? prefs.main_branch : null;
  if (configuredBranch) {
    if (nativeBranchExists(basePath, configuredBranch)) {
      return {
        recordedBranch,
        effectiveBranch: configuredBranch,
        status: "fallback",
        reason: `Recorded integration branch "${recordedBranch}" for milestone ${milestoneId} no longer exists; using configured git.main_branch "${configuredBranch}" instead.`
      };
    }
    return {
      recordedBranch,
      effectiveBranch: null,
      status: "missing",
      reason: `Recorded integration branch "${recordedBranch}" for milestone ${milestoneId} no longer exists, and configured git.main_branch "${configuredBranch}" is unavailable.`
    };
  }
  try {
    const detectedBranch = nativeDetectMainBranch(basePath);
    if (detectedBranch && VALID_BRANCH_NAME.test(detectedBranch) && nativeBranchExists(basePath, detectedBranch)) {
      return {
        recordedBranch,
        effectiveBranch: detectedBranch,
        status: "fallback",
        reason: `Recorded integration branch "${recordedBranch}" for milestone ${milestoneId} no longer exists; using detected fallback branch "${detectedBranch}" instead.`
      };
    }
  } catch {
  }
  return {
    recordedBranch,
    effectiveBranch: null,
    status: "missing",
    reason: `Recorded integration branch "${recordedBranch}" for milestone ${milestoneId} no longer exists, and no safe fallback branch could be determined.`
  };
}
function tokenizePreMergeCommand(input) {
  const tokens = [];
  let current = "";
  let i = 0;
  let quote = "";
  let hasContent = false;
  while (i < input.length) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[i + 1];
        i += 2;
        continue;
      } else {
        current += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
      i++;
      continue;
    }
    if (ch === " " || ch === "	") {
      if (hasContent) {
        tokens.push(current);
        current = "";
        hasContent = false;
      }
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      current += input[i + 1];
      i += 2;
      hasContent = true;
      continue;
    }
    current += ch;
    hasContent = true;
    i++;
  }
  if (quote) {
    throw new Error(`Unterminated ${quote === '"' ? "double" : "single"} quote in pre-merge command`);
  }
  if (hasContent) tokens.push(current);
  return tokens;
}
function containsUnquotedShellControl(input) {
  let i = 0;
  let quote = "";
  while (i < input.length) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "&" || ch === "|" || ch === "`" || ch === "$" || ch === "<" || ch === ">") {
      return true;
    }
    i++;
  }
  return false;
}
function filterGitSvnNoise(message) {
  return message.replace(/Duplicate specification "[^"]*" for option "[^"]*"\n?/g, "").replace(/Unable to determine upstream SVN information from .*\n?/g, "").replace(/Perhaps the repository is empty\. at .*git-svn.*\n?/g, "").trim();
}
function runGit(basePath, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      stdio: [options.input != null ? "pipe" : "ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: GIT_NO_PROMPT_ENV,
      ...options.input != null ? { input: options.input } : {}
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const message = getErrorMessage(error);
    throw new GSDError(GSD_GIT_ERROR, `git ${args.join(" ")} failed in ${basePath}: ${filterGitSvnNoise(message)}`);
  }
}
const COMMIT_TYPE_RULES = [
  [["fix", "fixed", "fixes", "bug", "patch", "hotfix", "repair", "correct"], "fix"],
  [["refactor", "restructure", "reorganize"], "refactor"],
  [["doc", "docs", "documentation", "readme", "changelog"], "docs"],
  [["test", "tests", "testing", "spec", "coverage"], "test"],
  [["perf", "performance", "optimize", "speed", "cache"], "perf"],
  [["chore", "cleanup", "clean up", "dependencies", "deps", "bump", "config", "ci", "archive", "remove", "delete"], "chore"]
];
class GitServiceImpl {
  basePath;
  prefs;
  /** Active milestone ID — used to resolve the integration branch. */
  _milestoneId = null;
  constructor(basePath, prefs = {}) {
    this.basePath = basePath;
    this.prefs = prefs;
  }
  /**
   * Set the active milestone ID for integration branch resolution.
   * When set, getMainBranch() will check the milestone's metadata file
   * for a recorded integration branch before falling back to repo defaults.
   */
  setMilestoneId(milestoneId) {
    this._milestoneId = milestoneId;
  }
  /**
   * Smart staging: `git add -A` excluding GSD runtime paths via pathspec.
   * Falls back to plain `git add -A` if the exclusion pathspec fails.
   * @param extraExclusions Additional pathspec exclusions beyond RUNTIME_EXCLUSION_PATHS.
   */
  smartStage(extraExclusions = []) {
    if (!this._runtimeFilesCleanedUp) {
      let cleaned = false;
      for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
        const removed = nativeRmCached(this.basePath, [exclusion]);
        if (removed.length > 0) cleaned = true;
      }
      if (cleaned) {
        nativeCommit(this.basePath, "chore: untrack .gsd/ runtime files from git index", { allowEmpty: false });
      }
      this._runtimeFilesCleanedUp = true;
    }
    const allExclusions = [...RUNTIME_EXCLUSION_PATHS, ...extraExclusions];
    const milestoneLock = process.env.GSD_MILESTONE_LOCK;
    if (milestoneLock) {
      const msDir = join(gsdRoot(this.basePath), "milestones");
      if (existsSync(msDir)) {
        try {
          const entries = readdirSync(msDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name !== milestoneLock) {
              allExclusions.push(`.gsd/milestones/${entry.name}/`);
            }
          }
        } catch {
        }
      }
    }
    nativeAddAllWithExclusions(this.basePath, allExclusions);
  }
  scopedStageTaskFiles(taskContext, extraExclusions = []) {
    const keyFiles = taskContext.keyFiles ?? [];
    if (keyFiles.length === 0) return false;
    const allExclusions = [...RUNTIME_EXCLUSION_PATHS, ...extraExclusions];
    const normalized = keyFiles.map((file) => normalizeRepoRelativePath(this.basePath, file)).filter((file) => file !== null).filter((file) => !nativeIsIgnored(this.basePath, file)).filter((file) => !isExcludedScopedPath(file, allExclusions));
    const scopedPaths = [];
    const submodulePaths = [];
    const repoSubmodules = submodulePathsFromLsFiles(
      runGit(this.basePath, ["ls-files", "--stage"], { allowFailure: true })
    );
    for (const path of normalized) {
      if (isInsideSubmodule(path, repoSubmodules)) {
        submodulePaths.push(path);
      } else {
        scopedPaths.push(path);
      }
    }
    if (submodulePaths.length > 0) {
      logWarning(
        "engine",
        `scoped stage: dropping ${submodulePaths.length} keyFile(s) inside git submodule(s): ${submodulePaths.join(", ")}`,
        { file: "git-service.ts" }
      );
    }
    const missing = [];
    const existing = [];
    for (const path of scopedPaths) {
      if (existsSync(join(this.basePath, path))) {
        existing.push(path);
      } else {
        missing.push(path);
      }
    }
    if (missing.length > 0) {
      logWarning(
        "engine",
        `scoped stage: dropping ${missing.length} non-existent keyFile(s) from task commit: ${missing.join(", ")}`,
        { file: "git-service.ts" }
      );
    }
    const paths = Array.from(new Set(existing));
    if (paths.length === 0) return false;
    try {
      nativeAddPaths(this.basePath, paths);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarning(
        "engine",
        `scoped stage failed (${msg}); falling back to smartStage`,
        { file: "git-service.ts" }
      );
      return false;
    }
  }
  /** Tracks whether runtime file cleanup has run this session. */
  _runtimeFilesCleanedUp = false;
  /**
   * Stage files (smart staging) and commit.
   * Returns the commit message string on success, or null if nothing to commit.
   * Uses `git commit -F -` with stdin pipe for safe multi-line message handling.
   */
  commit(opts) {
    this.smartStage();
    if (!nativeHasStagedChanges(this.basePath) && !opts.allowEmpty) return null;
    nativeCommit(this.basePath, opts.message, { allowEmpty: opts.allowEmpty ?? false });
    return opts.message;
  }
  /**
   * Auto-commit dirty working tree.
   *
   * When `taskContext` is provided, generates a meaningful conventional commit
   * message from the task execution results (one-liner, title, inferred type).
   * Falls back to a generic `chore()` message when no context is available
   * (e.g. pre-switch commits, stop commits, state rebuild commits).
   *
   * Returns the commit message on success, or null if nothing to commit.
   * @param extraExclusions Additional paths to exclude from staging (e.g. [".gsd/"] for pre-switch commits).
   */
  autoCommit(unitType, unitId, extraExclusions = [], taskContext) {
    if (!nativeHasChanges(this.basePath)) return null;
    const scoped = taskContext ? this.scopedStageTaskFiles(taskContext, extraExclusions) : false;
    if (!scoped) this.smartStage(extraExclusions);
    if (!nativeHasStagedChanges(this.basePath)) return null;
    const message = taskContext ? buildTaskCommitMessage(taskContext) : `chore: auto-commit after ${unitType}

GSD-Unit: ${unitId}`;
    nativeCommit(this.basePath, message, { allowEmpty: false });
    this.absorbSnapshotCommits(message);
    return message;
  }
  /**
   * Squash consecutive `gsd snapshot:` commits that sit immediately below
   * HEAD into the current HEAD commit. This keeps the git history clean
   * after automated snapshot commits are superseded by real work.
   *
   * Guards:
   * - Opt-in via `absorb_snapshot_commits` preference (default: true).
   * - Refuses to rewrite commits that have been pushed to the remote
   *   tracking branch (checks merge-base ancestry).
   * - Saves HEAD SHA before reset; restores it if the re-commit fails.
   *
   * Does nothing if there are no snapshot commits to absorb.
   */
  absorbSnapshotCommits(headMessage) {
    try {
      if (this.prefs.absorb_snapshot_commits === false) return;
      const GSD_SNAPSHOT_PREFIX = "gsd snapshot:";
      let count = 0;
      for (let i = 1; i <= 10; i++) {
        const subject = nativeCommitSubject(this.basePath, `HEAD~${i}`);
        if (!subject.startsWith(GSD_SNAPSHOT_PREFIX)) break;
        count = i;
      }
      if (count === 0) return;
      const resetTarget = `HEAD~${count + 1}`;
      try {
        const branch = nativeGetCurrentBranch(this.basePath);
        if (branch) {
          const remoteBranch = `origin/${branch}`;
          execFileSync("git", ["merge-base", "--is-ancestor", "HEAD~1", remoteBranch], {
            cwd: this.basePath,
            stdio: ["ignore", "pipe", "pipe"]
          });
          return;
        }
      } catch {
      }
      const savedHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: this.basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8"
      }).trim();
      nativeResetSoft(this.basePath, resetTarget);
      this.smartStage();
      try {
        nativeCommit(this.basePath, headMessage, { allowEmpty: false });
      } catch {
        nativeResetSoft(this.basePath, savedHead);
      }
    } catch {
    }
  }
  // ─── Branch Queries ────────────────────────────────────────────────────
  /**
   * Get the integration branch for this repo — the branch that slice
   * branches are created from and merged back into.
   *
   * This is often `main` or `master`, but not necessarily. When a user
   * starts GSD on a feature branch like `f-123-new-thing`, that branch
   * is recorded as the integration target, and all slice branches merge
   * back into it — not the repo's default branch. The name "main branch"
   * in variable names is historical; think of it as "integration branch".
   *
   * Resolution order:
   * 1. Explicit `main_branch` preference (user override, highest priority)
   * 2. Milestone integration branch from metadata file (recorded at milestone start)
   * 3. Worktree base branch (worktree/<name>)
   * 4. origin/HEAD symbolic-ref → main/master fallback → current branch
   */
  getMainBranch() {
    if (this.prefs.main_branch && VALID_BRANCH_NAME.test(this.prefs.main_branch)) {
      return this.prefs.main_branch;
    }
    if (this._milestoneId) {
      const resolved = resolveMilestoneIntegrationBranch(this.basePath, this._milestoneId);
      if (resolved.effectiveBranch) {
        return resolved.effectiveBranch;
      }
    }
    const wtName = detectWorktreeName(this.basePath);
    if (wtName) {
      const milestoneBranch = `milestone/${wtName}`;
      const currentBranch = nativeGetCurrentBranch(this.basePath);
      if (currentBranch.startsWith("milestone/")) {
        return currentBranch;
      }
      const wtBranch = `worktree/${wtName}`;
      if (nativeBranchExists(this.basePath, wtBranch)) return wtBranch;
      return currentBranch;
    }
    return nativeDetectMainBranch(this.basePath);
  }
  /** Get the current branch name. Native libgit2 when available, execSync fallback. */
  getCurrentBranch() {
    return nativeGetCurrentBranch(this.basePath);
  }
  /**
   * Create a snapshot ref for the given label (typically a slice branch name).
   * Enabled by default; opt out with prefs.snapshots === false.
   * Ref path: refs/gsd/snapshots/<label>/<timestamp>
   * The ref points at HEAD, capturing the current commit before destructive operations.
   */
  createSnapshot(label) {
    if (this.prefs.snapshots === false) return;
    const now = /* @__PURE__ */ new Date();
    const ts = now.getFullYear().toString() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0") + "-" + String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0") + String(now.getSeconds()).padStart(2, "0");
    const refPath = `refs/gsd/snapshots/${label}/${ts}`;
    nativeUpdateRef(this.basePath, refPath, "HEAD");
  }
  /**
   * Run pre-merge verification check. Auto-detects test runner from project
   * files, or uses custom command from prefs.pre_merge_check.
   * Gated on prefs.pre_merge_check (false = skip, string = custom command).
   */
  runPreMergeCheck() {
    if (this.prefs.pre_merge_check === false) {
      return { passed: true, skipped: true };
    }
    let command;
    if (typeof this.prefs.pre_merge_check === "string") {
      command = this.prefs.pre_merge_check;
    } else {
      try {
        const pkg = readFileSync(join(this.basePath, "package.json"), "utf-8");
        const parsed = JSON.parse(pkg);
        if (parsed.scripts?.test) {
          command = "npm test";
        } else {
          return { passed: true, skipped: true };
        }
      } catch {
        return { passed: true, skipped: true };
      }
    }
    if (containsUnquotedShellControl(command)) {
      return {
        passed: false,
        skipped: false,
        command,
        error: "pre_merge_check contains shell metacharacters (;, &&, |, $, backticks, redirects). Put complex commands in a script file (e.g. './scripts/pre-merge.sh') and reference the script path instead."
      };
    }
    const tokens = tokenizePreMergeCommand(command);
    if (tokens.length === 0) {
      return { passed: true, skipped: true };
    }
    try {
      execFileSync(tokens[0], tokens.slice(1), {
        cwd: this.basePath,
        stdio: "pipe",
        encoding: "utf-8",
        env: GIT_NO_PROMPT_ENV
      });
      return { passed: true, skipped: false, command };
    } catch (err) {
      const msg = getErrorMessage(err);
      return { passed: false, skipped: false, command, error: msg };
    }
  }
}
function createDraftPR(basePath, milestoneId, title, body, opts) {
  try {
    const args = [
      "pr",
      "create",
      "--draft",
      "--title",
      title,
      "--body",
      body
    ];
    if (opts?.head) args.push("--head", opts.head);
    if (opts?.base) args.push("--base", opts.base);
    const result = execFileSync("gh", args, {
      cwd: basePath,
      encoding: "utf8",
      timeout: 3e4,
      env: opts?.env ?? GIT_NO_PROMPT_ENV
    });
    return result.trim();
  } catch {
    return null;
  }
}
function createGitService(basePath) {
  const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  return new GitServiceImpl(basePath, gitPrefs);
}
function buildTurnSnapshotLabel(unitType, unitId) {
  const raw = `${unitType}/${unitId}`.trim();
  if (!raw) return "turn";
  return raw.replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/\/{2,}/g, "/").replace(/-{2,}/g, "-").replace(/^[-/]+|[-/]+$/g, "") || "turn";
}
function handleTurnGitActionError(action, err) {
  if (isInfrastructureError(err)) {
    throw err;
  }
  return {
    action,
    status: "failed",
    error: getErrorMessage(err)
  };
}
function runTurnGitAction(args) {
  try {
    _resetHasChangesCache();
    if (args.action === "status-only") {
      return {
        action: args.action,
        status: "ok",
        dirty: nativeHasChanges(args.basePath)
      };
    }
    const git = createGitService(args.basePath);
    if (args.action === "snapshot") {
      const label = buildTurnSnapshotLabel(args.unitType, args.unitId);
      git.createSnapshot(label);
      return {
        action: args.action,
        status: "ok",
        snapshotLabel: label,
        dirty: nativeHasChanges(args.basePath)
      };
    }
    const commitMessage = git.autoCommit(args.unitType, args.unitId, [], args.taskContext) ?? void 0;
    return {
      action: args.action,
      status: "ok",
      commitMessage,
      dirty: nativeHasChanges(args.basePath)
    };
  } catch (err) {
    return handleTurnGitActionError(args.action, err);
  }
}
function inferCommitType(title, oneLiner) {
  const lower = `${title} ${oneLiner || ""}`.toLowerCase();
  for (const [keywords, commitType] of COMMIT_TYPE_RULES) {
    for (const keyword of keywords) {
      if (keyword.includes(" ")) {
        if (lower.includes(keyword)) return commitType;
      } else {
        const re = new RegExp(`\\b${keyword}\\b`, "i");
        if (re.test(lower)) return commitType;
      }
    }
  }
  return "feat";
}
export {
  GitServiceImpl,
  MergeConflictError,
  QUICK_BRANCH_RE2 as QUICK_BRANCH_RE,
  RUNTIME_EXCLUSION_PATHS,
  VALID_BRANCH_NAME,
  WORKFLOW_BRANCH_RE2 as WORKFLOW_BRANCH_RE,
  buildTaskCommitMessage,
  createDraftPR,
  createGitService,
  handleTurnGitActionError,
  inferCommitType,
  readIntegrationBranch,
  resolveMilestoneIntegrationBranch,
  runGit,
  runTurnGitAction,
  tokenizePreMergeCommand,
  writeIntegrationBranch
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9naXQtc2VydmljZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEdpdCBvcGVyYXRpb25zLCBjb21taXQtbWVzc2FnZSBmb3JtYXR0aW5nLCBhbmQgdHVybiBnaXQgYWN0aW9ucy5cbi8qKlxuICogR1NEIEdpdCBTZXJ2aWNlXG4gKlxuICogQ29yZSBnaXQgb3BlcmF0aW9ucyBmb3IgR1NEOiB0eXBlcywgY29uc3RhbnRzLCBhbmQgcHVyZSBoZWxwZXJzLlxuICogSGlnaGVyLWxldmVsIG9wZXJhdGlvbnMgKGNvbW1pdCwgc3RhZ2luZywgYnJhbmNoaW5nKSBidWlsZCBvbiB0aGVzZS5cbiAqXG4gKiBUaGlzIG1vZHVsZSBjZW50cmFsaXplcyB0aGUgR2l0UHJlZmVyZW5jZXMgaW50ZXJmYWNlLCBydW50aW1lIGV4Y2x1c2lvblxuICogcGF0aHMsIGNvbW1pdCB0eXBlIGluZmVyZW5jZSwgYW5kIHRoZSBydW5HaXQgc2hlbGwgaGVscGVyLlxuICovXG5cbmltcG9ydCB7IGV4ZWNGaWxlU3luYyB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCByZWFkZGlyU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBpc0Fic29sdXRlLCBqb2luLCBub3JtYWxpemUsIHJlbGF0aXZlLCByZXNvbHZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBnc2RSb290IH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IEdJVF9OT19QUk9NUFRfRU5WIH0gZnJvbSBcIi4vZ2l0LWNvbnN0YW50cy5qc1wiO1xuaW1wb3J0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcblxuXG5pbXBvcnQge1xuICBkZXRlY3RXb3JrdHJlZU5hbWUsXG59IGZyb20gXCIuL3dvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyBTTElDRV9CUkFOQ0hfUkUsIFFVSUNLX0JSQU5DSF9SRSwgV09SS0ZMT1dfQlJBTkNIX1JFIH0gZnJvbSBcIi4vYnJhbmNoLXBhdHRlcm5zLmpzXCI7XG5pbXBvcnQge1xuICBuYXRpdmVHZXRDdXJyZW50QnJhbmNoLFxuICBuYXRpdmVEZXRlY3RNYWluQnJhbmNoLFxuICBuYXRpdmVCcmFuY2hFeGlzdHMsXG4gIG5hdGl2ZUhhc0NoYW5nZXMsXG4gIG5hdGl2ZUFkZEFsbFdpdGhFeGNsdXNpb25zLFxuICBuYXRpdmVSZXNldFBhdGhzLFxuICBuYXRpdmVIYXNTdGFnZWRDaGFuZ2VzLFxuICBuYXRpdmVDb21taXQsXG4gIG5hdGl2ZVJtQ2FjaGVkLFxuICBuYXRpdmVVcGRhdGVSZWYsXG4gIG5hdGl2ZUFkZFBhdGhzLFxuICBuYXRpdmVSZXNldFNvZnQsXG4gIG5hdGl2ZUNvbW1pdFN1YmplY3QsXG4gIG5hdGl2ZUlzSWdub3JlZCxcbiAgX3Jlc2V0SGFzQ2hhbmdlc0NhY2hlLFxufSBmcm9tIFwiLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc1wiO1xuaW1wb3J0IHsgR1NERXJyb3IsIEdTRF9NRVJHRV9DT05GTElDVCwgR1NEX0dJVF9FUlJPUiB9IGZyb20gXCIuL2Vycm9ycy5qc1wiO1xuaW1wb3J0IHsgZ2V0RXJyb3JNZXNzYWdlIH0gZnJvbSBcIi4vZXJyb3ItdXRpbHMuanNcIjtcbmltcG9ydCB7IGlzSW5mcmFzdHJ1Y3R1cmVFcnJvciB9IGZyb20gXCIuL2F1dG8vaW5mcmEtZXJyb3JzLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGludGVyZmFjZSBHaXRQcmVmZXJlbmNlcyB7XG4gIGF1dG9fcHVzaD86IGJvb2xlYW47XG4gIHB1c2hfYnJhbmNoZXM/OiBib29sZWFuO1xuICByZW1vdGU/OiBzdHJpbmc7XG4gIHNuYXBzaG90cz86IGJvb2xlYW47XG4gIC8qKiBEZXByZWNhdGVkLiAuZ3NkLyBpcyBtYW5hZ2VkIGV4dGVybmFsbHk7IHJldGFpbmVkIGZvciBjb21wYXRpYmlsaXR5LiAqL1xuICBjb21taXRfZG9jcz86IGJvb2xlYW47XG4gIHByZV9tZXJnZV9jaGVjaz86IGJvb2xlYW4gfCBzdHJpbmc7XG4gIGNvbW1pdF90eXBlPzogc3RyaW5nO1xuICBtYWluX2JyYW5jaD86IHN0cmluZztcbiAgbWVyZ2Vfc3RyYXRlZ3k/OiBcInNxdWFzaFwiIHwgXCJtZXJnZVwiO1xuICAvKiogQ29udHJvbHMgYXV0by1tb2RlIGdpdCBpc29sYXRpb24gc3RyYXRlZ3kuXG4gICAqICAtIFwid29ya3RyZWVcIjogY3JlYXRlcyBhIG1pbGVzdG9uZSB3b3JrdHJlZSBmb3IgaXNvbGF0ZWQgd29ya1xuICAgKiAgLSBcImJyYW5jaFwiOiB3b3JrcyBkaXJlY3RseSBpbiB0aGUgcHJvamVjdCByb290IChmb3Igc3VibW9kdWxlLWhlYXZ5IHJlcG9zKVxuICAgKiAgLSBcIm5vbmVcIjogKGRlZmF1bHQpIG5vIGdpdCBpc29sYXRpb24gXHUyMDE0IGNvbW1pdHMgbGFuZCBvbiB0aGUgdXNlcidzIGN1cnJlbnQgYnJhbmNoIGRpcmVjdGx5XG4gICAqL1xuICBpc29sYXRpb24/OiBcIndvcmt0cmVlXCIgfCBcImJyYW5jaFwiIHwgXCJub25lXCI7XG4gIC8qKiBXaGVuIGZhbHNlLCBHU0Qgd2lsbCBub3QgbW9kaWZ5IC5naXRpZ25vcmUgYXQgYWxsIFx1MjAxNCBubyBiYXNlbGluZSBwYXR0ZXJuc1xuICAgKiAgYXJlIGFkZGVkIGFuZCBubyBzZWxmLWhlYWxpbmcgb2NjdXJzLiBVc2UgdGhpcyBpZiB5b3UgbWFuYWdlIHlvdXIgb3duXG4gICAqICAuZ2l0aWdub3JlIGFuZCBkb24ndCB3YW50IEdTRCB0b3VjaGluZyBpdC5cbiAgICogIERlZmF1bHQ6IHRydWUgKEdTRCBlbnN1cmVzIGJhc2VsaW5lIHBhdHRlcm5zIGFyZSBwcmVzZW50KS5cbiAgICovXG4gIG1hbmFnZV9naXRpZ25vcmU/OiBib29sZWFuO1xuICAvKiogU2NyaXB0IHRvIHJ1biBhZnRlciBhIHdvcmt0cmVlIGlzIGNyZWF0ZWQgKCM1OTcpLlxuICAgKiAgUmVjZWl2ZXMgU09VUkNFX0RJUiBhbmQgV09SS1RSRUVfRElSIGFzIGVudmlyb25tZW50IHZhcmlhYmxlcy5cbiAgICogIENhbiBiZSBhbiBhYnNvbHV0ZSBwYXRoIG9yIHJlbGF0aXZlIHRvIHRoZSBwcm9qZWN0IHJvb3QuXG4gICAqICBGYWlsdXJlIGlzIG5vbi1mYXRhbCBcdTIwMTQgbG9nZ2VkIGFzIGEgd2FybmluZy5cbiAgICovXG4gIHdvcmt0cmVlX3Bvc3RfY3JlYXRlPzogc3RyaW5nO1xuICAvKiogV2hlbiB0cnVlLCBhdXRvbWF0aWNhbGx5IGNyZWF0ZSBhIHB1bGwgcmVxdWVzdCBhZnRlciBtaWxlc3RvbmUgY29tcGxldGlvbi5cbiAgICogIFRoZSBQUiB0YXJnZXRzIGBwcl90YXJnZXRfYnJhbmNoYCAoZGVmYXVsdDogdGhlIG1haW4gYnJhbmNoKS5cbiAgICogIFJlcXVpcmVzIGBwdXNoX2JyYW5jaGVzOiB0cnVlYCBhbmQgYSBjb25maWd1cmVkIHJlbW90ZS5cbiAgICogIERlZmF1bHQ6IGZhbHNlLlxuICAgKi9cbiAgYXV0b19wcj86IGJvb2xlYW47XG4gIC8qKiBUYXJnZXQgYnJhbmNoIGZvciBhdXRvLWNyZWF0ZWQgUFJzIChlLmcuIFwiZGV2ZWxvcFwiLCBcInFhXCIpLlxuICAgKiAgRGVmYXVsdDogdGhlIG1haW4gYnJhbmNoIChmcm9tIGBtYWluX2JyYW5jaGAgb3IgYXV0by1kZXRlY3RlZCkuXG4gICAqL1xuICBwcl90YXJnZXRfYnJhbmNoPzogc3RyaW5nO1xuICAvKiogV2hldGhlciB0byBzcXVhc2ggYGdzZCBzbmFwc2hvdDpgIGNvbW1pdHMgaW50byB0aGUgbmV4dCByZWFsIGF1dG9Db21taXQuXG4gICAqICBFbmFibGVkIGJ5IGRlZmF1bHQuIFNldCB0byBmYWxzZSB0byBrZWVwIHNuYXBzaG90IGNvbW1pdHMgaW4gaGlzdG9yeVxuICAgKiAgZm9yIGZvcmVuc2ljIGluc3BlY3Rpb24uXG4gICAqL1xuICBhYnNvcmJfc25hcHNob3RfY29tbWl0cz86IGJvb2xlYW47XG4gIC8qKiAjNDc2NSBcdTIwMTQgd2hlbiB0byBjb2xsYXBzZSB3b3JrdHJlZSBjb21taXRzIGJhY2sgdG8gbWFpbi5cbiAgICogIC0gXCJtaWxlc3RvbmVcIiAoZGVmYXVsdCk6IGV4aXN0aW5nIGJlaGF2aW9yIFx1MjAxNCBzcXVhc2gtbWVyZ2UgaGFwcGVucyBvbmNlXG4gICAqICAgIGF0IG1pbGVzdG9uZSBjb21wbGV0aW9uIG9yIHRyYW5zaXRpb24uXG4gICAqICAtIFwic2xpY2VcIjogc3F1YXNoLW1lcmdlIGVhY2ggc2xpY2UncyBjb21taXRzIHRvIG1haW4gYXMgc29vbiBhcyB0aGVcbiAgICogICAgc2xpY2UgcGFzc2VzIHZhbGlkYXRpb24uIFNocmlua3MgdGhlIG9ycGhhbiB3aW5kb3cgZnJvbVxuICAgKiAgICBtaWxlc3RvbmUtc2l6ZSB0byBzbGljZS1zaXplIGFuZCBzdXJmYWNlcyBtZXJnZSBjb25mbGljdHMgcGVyIHNsaWNlXG4gICAqICAgIHJhdGhlciB0aGFuIGFsbCBhdCBvbmNlIGF0IG1pbGVzdG9uZSBlbmQuXG4gICAqL1xuICBjb2xsYXBzZV9jYWRlbmNlPzogXCJtaWxlc3RvbmVcIiB8IFwic2xpY2VcIjtcbiAgLyoqICM0NzY1IFx1MjAxNCB3aGVuIGBjb2xsYXBzZV9jYWRlbmNlOiBcInNsaWNlXCJgLCBvcHRpb25hbGx5IHJlLXNxdWFzaCB0aGUgcGVyLVxuICAgKiAgc2xpY2UgY29tbWl0cyBvbiBtYWluIGludG8gb25lIG1pbGVzdG9uZSBjb21taXQgYXQgbWlsZXN0b25lIGNvbXBsZXRpb24uXG4gICAqICBQcmVzZXJ2ZXMgdGhlIFwib25lIGNvbW1pdCBwZXIgbWlsZXN0b25lIGluIG1haW5cIiBoaXN0b3J5IHNoYXBlIHRoYXRcbiAgICogIGBjb2xsYXBzZV9jYWRlbmNlOiBcIm1pbGVzdG9uZVwiYCBwcm9kdWNlcyB0b2RheS5cbiAgICogIERlZmF1bHQ6IHRydWUgd2hlbiBjb2xsYXBzZV9jYWRlbmNlIGlzIFwic2xpY2VcIiwgaWdub3JlZCBvdGhlcndpc2UuXG4gICAqL1xuICBtaWxlc3RvbmVfcmVzcXVhc2g/OiBib29sZWFuO1xufVxuXG5leHBvcnQgY29uc3QgVkFMSURfQlJBTkNIX05BTUUgPSAvXlthLXpBLVowLTlfXFwtXFwvLl0rJC87XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tbWl0T3B0aW9ucyB7XG4gIG1lc3NhZ2U6IHN0cmluZztcbiAgYWxsb3dFbXB0eT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIFR1cm5HaXRBY3Rpb25Nb2RlID0gXCJjb21taXRcIiB8IFwic25hcHNob3RcIiB8IFwic3RhdHVzLW9ubHlcIjtcblxuZXhwb3J0IGludGVyZmFjZSBUdXJuR2l0QWN0aW9uUmVzdWx0IHtcbiAgYWN0aW9uOiBUdXJuR2l0QWN0aW9uTW9kZTtcbiAgc3RhdHVzOiBcIm9rXCIgfCBcImZhaWxlZFwiO1xuICBjb21taXRNZXNzYWdlPzogc3RyaW5nO1xuICBzbmFwc2hvdExhYmVsPzogc3RyaW5nO1xuICBkaXJ0eT86IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTWVhbmluZ2Z1bCBDb21taXQgTWVzc2FnZSBHZW5lcmF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKiogQ29udGV4dCBmb3IgZ2VuZXJhdGluZyBhIG1lYW5pbmdmdWwgY29tbWl0IG1lc3NhZ2UgZnJvbSB0YXNrIGV4ZWN1dGlvbiByZXN1bHRzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBUYXNrQ29tbWl0Q29udGV4dCB7XG4gIHRhc2tJZDogc3RyaW5nO1xuICB0YXNrVGl0bGU6IHN0cmluZztcbiAgbWlsZXN0b25lSWQ/OiBzdHJpbmc7XG4gIG1pbGVzdG9uZVRpdGxlPzogc3RyaW5nO1xuICBzbGljZUlkPzogc3RyaW5nO1xuICBzbGljZVRpdGxlPzogc3RyaW5nO1xuICB0YXNrRGlzcGxheUlkPzogc3RyaW5nO1xuICAvKiogVGhlIG9uZS1saW5lciBmcm9tIHRoZSB0YXNrIHN1bW1hcnkgKGUuZy4gXCJBZGRlZCByZXRyeS1hd2FyZSB3b3JrZXIgc3RhdHVzIGxvZ2dpbmdcIikgKi9cbiAgb25lTGluZXI/OiBzdHJpbmc7XG4gIC8qKiBGaWxlcyBtb2RpZmllZCBieSB0aGlzIHRhc2sgKGZyb20gdGFzayBzdW1tYXJ5IGZyb250bWF0dGVyKSAqL1xuICBrZXlGaWxlcz86IHN0cmluZ1tdO1xuICAvKiogR2l0SHViIGlzc3VlIG51bWJlciBcdTIwMTQgYXBwZW5kcyBcIlJlc29sdmVzICNOXCIgdHJhaWxlciB3aGVuIHNldC4gKi9cbiAgaXNzdWVOdW1iZXI/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQnVpbGQgYSBtZWFuaW5nZnVsIGNvbnZlbnRpb25hbCBjb21taXQgbWVzc2FnZSBmcm9tIHRhc2sgZXhlY3V0aW9uIGNvbnRleHQuXG4gKiBGb3JtYXQ6IGB7dHlwZX06IHtkZXNjcmlwdGlvbn1gIChjbGVhbiBjb252ZW50aW9uYWwgY29tbWl0IFx1MjAxNCBubyBHU0QgSURzIGluIHN1YmplY3QpLlxuICpcbiAqIEdTRCBtZXRhZGF0YSBpcyBwbGFjZWQgaW4gYSBgR1NELVRhc2s6YCBnaXQgdHJhaWxlciBhdCB0aGUgZW5kIG9mIHRoZSBib2R5LFxuICogZm9sbG93aW5nIHRoZSBzYW1lIGNvbnZlbnRpb24gYXMgYFNpZ25lZC1vZmYtYnk6YCBvciBgQ28tQXV0aG9yZWQtQnk6YC5cbiAqXG4gKiBUaGUgZGVzY3JpcHRpb24gaXMgdGhlIHRhc2sgc3VtbWFyeSBvbmUtbGluZXIgaWYgYXZhaWxhYmxlIChpdCBkZXNjcmliZXNcbiAqIHdoYXQgd2FzIGFjdHVhbGx5IGJ1aWx0KSwgZmFsbGluZyBiYWNrIHRvIHRoZSB0YXNrIHRpdGxlICh3aGF0IHdhcyBwbGFubmVkKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkVGFza0NvbW1pdE1lc3NhZ2UoY3R4OiBUYXNrQ29tbWl0Q29udGV4dCk6IHN0cmluZyB7XG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gc2FuaXRpemVDb21taXRTdWJqZWN0RGVzY3JpcHRpb24oY3R4Lm9uZUxpbmVyIHx8IGN0eC50YXNrVGl0bGUpO1xuICBjb25zdCB0eXBlID0gaW5mZXJDb21taXRUeXBlKGN0eC50YXNrVGl0bGUsIGN0eC5vbmVMaW5lcik7XG5cbiAgLy8gVHJ1bmNhdGUgZGVzY3JpcHRpb24gdG8gfjcyIGNoYXJzIGZvciBzdWJqZWN0IGxpbmUgKGZ1bGwgYnVkZ2V0IHdpdGhvdXQgc2NvcGUpXG4gIGNvbnN0IG1heERlc2NMZW4gPSA3MCAtIHR5cGUubGVuZ3RoO1xuICBjb25zdCB0cnVuY2F0ZWQgPSBkZXNjcmlwdGlvbi5sZW5ndGggPiBtYXhEZXNjTGVuXG4gICAgPyBkZXNjcmlwdGlvbi5zbGljZSgwLCBtYXhEZXNjTGVuIC0gMSkudHJpbUVuZCgpICsgXCJcdTIwMjZcIlxuICAgIDogZGVzY3JpcHRpb247XG5cbiAgY29uc3Qgc3ViamVjdCA9IGAke3R5cGV9OiAke3RydW5jYXRlZH1gO1xuXG4gIC8vIEJ1aWxkIGJvZHkgd2l0aCBrZXkgZmlsZXMgaWYgYXZhaWxhYmxlXG4gIGNvbnN0IGJvZHlQYXJ0czogc3RyaW5nW10gPSBbXTtcblxuICBpZiAoY3R4LmtleUZpbGVzICYmIGN0eC5rZXlGaWxlcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgZmlsZUxpbmVzID0gY3R4LmtleUZpbGVzXG4gICAgICAuc2xpY2UoMCwgOCkgLy8gY2FwIGF0IDggZmlsZXMgdG8ga2VlcCBjb21taXQgY29uY2lzZVxuICAgICAgLm1hcChmID0+IGAtICR7Zn1gKVxuICAgICAgLmpvaW4oXCJcXG5cIik7XG4gICAgYm9keVBhcnRzLnB1c2goZmlsZUxpbmVzKTtcbiAgfVxuXG4gIGNvbnN0IGNvbnRleHRMaW5lcyA9IGJ1aWxkVGFza0NvbW1pdENvbnRleHRMaW5lcyhjdHgpO1xuICBpZiAoY29udGV4dExpbmVzLmxlbmd0aCA+IDApIHtcbiAgICBib2R5UGFydHMucHVzaChgR1NEIGNvbnRleHQ6XFxuJHtjb250ZXh0TGluZXMuam9pbihcIlxcblwiKX1gKTtcbiAgfVxuXG4gIC8vIFRyYWlsZXJzOiBHU0QtVGFzayBmaXJzdCwgdGhlbiBSZXNvbHZlc1xuICBib2R5UGFydHMucHVzaChgR1NELVRhc2s6ICR7Y3R4LnRhc2tJZH1gKTtcblxuICBpZiAoY3R4Lmlzc3VlTnVtYmVyKSB7XG4gICAgYm9keVBhcnRzLnB1c2goYFJlc29sdmVzICMke2N0eC5pc3N1ZU51bWJlcn1gKTtcbiAgfVxuXG4gIHJldHVybiBgJHtzdWJqZWN0fVxcblxcbiR7Ym9keVBhcnRzLmpvaW4oXCJcXG5cXG5cIil9YDtcbn1cblxuZnVuY3Rpb24gYnVpbGRUYXNrQ29tbWl0Q29udGV4dExpbmVzKGN0eDogVGFza0NvbW1pdENvbnRleHQpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBtaWxlc3RvbmUgPSBmb3JtYXROYW1lZENvbnRleHQoY3R4Lm1pbGVzdG9uZUlkLCBjdHgubWlsZXN0b25lVGl0bGUpO1xuICBjb25zdCBzbGljZSA9IGZvcm1hdE5hbWVkQ29udGV4dChjdHguc2xpY2VJZCwgY3R4LnNsaWNlVGl0bGUpO1xuICBjb25zdCB0YXNrSWQgPSBjdHgudGFza0Rpc3BsYXlJZCA/PyBjdHgudGFza0lkLnNwbGl0KFwiL1wiKS5wb3AoKTtcbiAgY29uc3QgdGFzayA9IGZvcm1hdE5hbWVkQ29udGV4dCh0YXNrSWQsIGN0eC50YXNrVGl0bGUpO1xuXG4gIGlmIChtaWxlc3RvbmUpIGxpbmVzLnB1c2goYC0gTWlsZXN0b25lOiAke21pbGVzdG9uZX1gKTtcbiAgaWYgKHNsaWNlKSBsaW5lcy5wdXNoKGAtIFNsaWNlOiAke3NsaWNlfWApO1xuICBpZiAodGFzaykgbGluZXMucHVzaChgLSBUYXNrOiAke3Rhc2t9YCk7XG4gIHJldHVybiBsaW5lcztcbn1cblxuZnVuY3Rpb24gZm9ybWF0TmFtZWRDb250ZXh0KGlkOiBzdHJpbmcgfCB1bmRlZmluZWQsIHRpdGxlOiBzdHJpbmcgfCB1bmRlZmluZWQpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgY2xlYW5JZCA9IGlkPy50cmltKCk7XG4gIGNvbnN0IGNsZWFuVGl0bGUgPSB0aXRsZT8udHJpbSgpO1xuICBpZiAoIWNsZWFuSWQgJiYgIWNsZWFuVGl0bGUpIHJldHVybiBudWxsO1xuICBpZiAoIWNsZWFuSWQpIHJldHVybiBjbGVhblRpdGxlID8/IG51bGw7XG4gIGlmICghY2xlYW5UaXRsZSB8fCBjbGVhblRpdGxlID09PSBjbGVhbklkKSByZXR1cm4gY2xlYW5JZDtcbiAgcmV0dXJuIGAke2NsZWFuSWR9IC0gJHtjbGVhblRpdGxlfWA7XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplQ29tbWl0U3ViamVjdERlc2NyaXB0aW9uKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBjbGVhbmVkID0gdmFsdWVcbiAgICAucmVwbGFjZSgvW1xceDAwLVxceDFGXFx4N0ZdKy9nLCBcIiBcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xuICByZXR1cm4gY2xlYW5lZCB8fCBcInVwZGF0ZSB0YXNrXCI7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJlcG9SZWxhdGl2ZVBhdGgoYmFzZVBhdGg6IHN0cmluZywgZmlsZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCB0cmltbWVkID0gZmlsZVBhdGgudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQgfHwgdHJpbW1lZC5pbmNsdWRlcyhcIlxcMFwiKSkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcmVsUGF0aCA9IGlzQWJzb2x1dGUodHJpbW1lZClcbiAgICA/IHJlbGF0aXZlKGJhc2VQYXRoLCB0cmltbWVkKVxuICAgIDogbm9ybWFsaXplKHRyaW1tZWQpO1xuICBpZiAoIXJlbFBhdGggfHwgcmVsUGF0aCA9PT0gXCIuXCIgfHwgaXNBYnNvbHV0ZShyZWxQYXRoKSB8fCByZWxQYXRoLnN0YXJ0c1dpdGgoYC4uJHtzZXB9YCkgfHwgcmVsUGF0aCA9PT0gXCIuLlwiKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmUoYmFzZVBhdGgsIHJlbFBhdGgpO1xuICBjb25zdCByZWxGcm9tQmFzZSA9IHJlbGF0aXZlKGJhc2VQYXRoLCByZXNvbHZlZCk7XG4gIGlmICghcmVsRnJvbUJhc2UgfHwgcmVsRnJvbUJhc2UgPT09IFwiLlwiIHx8IHJlbEZyb21CYXNlLnN0YXJ0c1dpdGgoXCIuLlwiKSB8fCBpc0Fic29sdXRlKHJlbEZyb21CYXNlKSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgcmV0dXJuIHJlbEZyb21CYXNlO1xufVxuXG5mdW5jdGlvbiBwYXRoc3BlY1RvUmVnZXgocGF0dGVybjogc3RyaW5nKTogUmVnRXhwIHtcbiAgY29uc3QgZXNjYXBlZCA9IHBhdHRlcm5cbiAgICAucmVwbGFjZSgvWy4rXiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKVxuICAgIC5yZXBsYWNlKC9cXCovZywgXCIuKlwiKTtcbiAgcmV0dXJuIG5ldyBSZWdFeHAoYF4ke2VzY2FwZWR9JGApO1xufVxuXG5mdW5jdGlvbiBpc0V4Y2x1ZGVkU2NvcGVkUGF0aChwYXRoOiBzdHJpbmcsIGV4Y2x1c2lvbnM6IHJlYWRvbmx5IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWRQYXRoID0gcGF0aC5yZXBsYWNlKC9cXFxcL2csIFwiL1wiKTtcbiAgZm9yIChjb25zdCBleGNsdXNpb24gb2YgZXhjbHVzaW9ucykge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWRFeGNsdXNpb24gPSBleGNsdXNpb24ucmVwbGFjZSgvXjohLywgXCJcIikucmVwbGFjZSgvXFxcXC9nLCBcIi9cIik7XG4gICAgaWYgKCFub3JtYWxpemVkRXhjbHVzaW9uKSBjb250aW51ZTtcbiAgICBpZiAobm9ybWFsaXplZEV4Y2x1c2lvbi5lbmRzV2l0aChcIi9cIikpIHtcbiAgICAgIGlmIChub3JtYWxpemVkUGF0aCA9PT0gbm9ybWFsaXplZEV4Y2x1c2lvbi5zbGljZSgwLCAtMSkgfHwgbm9ybWFsaXplZFBhdGguc3RhcnRzV2l0aChub3JtYWxpemVkRXhjbHVzaW9uKSkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAobm9ybWFsaXplZEV4Y2x1c2lvbi5pbmNsdWRlcyhcIipcIikpIHtcbiAgICAgIGlmIChwYXRoc3BlY1RvUmVnZXgobm9ybWFsaXplZEV4Y2x1c2lvbikudGVzdChub3JtYWxpemVkUGF0aCkpIHJldHVybiB0cnVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChub3JtYWxpemVkUGF0aCA9PT0gbm9ybWFsaXplZEV4Y2x1c2lvbikgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBzdWJtb2R1bGVQYXRoc0Zyb21Mc0ZpbGVzKG91dHB1dDogc3RyaW5nKTogU2V0PHN0cmluZz4ge1xuICBjb25zdCBzdWJtb2R1bGVQYXRocyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBpZiAoIW91dHB1dCkgcmV0dXJuIHN1Ym1vZHVsZVBhdGhzO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBvdXRwdXQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBtYXRjaCA9IGxpbmUubWF0Y2goL14xNjAwMDBcXHMrXFxTK1xccytcXGQrXFx0KC4rKSQvKTtcbiAgICBpZiAoIW1hdGNoKSBjb250aW51ZTtcbiAgICBzdWJtb2R1bGVQYXRocy5hZGQobWF0Y2hbMV0ucmVwbGFjZSgvXFxcXC9nLCBcIi9cIikucmVwbGFjZSgvXFwvKyQvLCBcIlwiKSk7XG4gIH1cbiAgcmV0dXJuIHN1Ym1vZHVsZVBhdGhzO1xufVxuXG5mdW5jdGlvbiBpc0luc2lkZVN1Ym1vZHVsZShwYXRoOiBzdHJpbmcsIHN1Ym1vZHVsZVBhdGhzOiBSZWFkb25seVNldDxzdHJpbmc+KTogYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWRQYXRoID0gcGF0aC5yZXBsYWNlKC9cXFxcL2csIFwiL1wiKTtcbiAgaWYgKHN1Ym1vZHVsZVBhdGhzLmhhcyhub3JtYWxpemVkUGF0aCkpIHJldHVybiB0cnVlO1xuXG4gIGxldCBzbGFzaEluZGV4ID0gbm9ybWFsaXplZFBhdGgubGFzdEluZGV4T2YoXCIvXCIpO1xuICB3aGlsZSAoc2xhc2hJbmRleCA+IDApIHtcbiAgICBpZiAoc3VibW9kdWxlUGF0aHMuaGFzKG5vcm1hbGl6ZWRQYXRoLnNsaWNlKDAsIHNsYXNoSW5kZXgpKSkgcmV0dXJuIHRydWU7XG4gICAgc2xhc2hJbmRleCA9IG5vcm1hbGl6ZWRQYXRoLmxhc3RJbmRleE9mKFwiL1wiLCBzbGFzaEluZGV4IC0gMSk7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKipcbiAqIFRocm93biB3aGVuIGEgc2xpY2UgbWVyZ2UgaGl0cyBjb2RlIGNvbmZsaWN0cyBpbiBub24tLmdzZCBmaWxlcy5cbiAqIFRoZSB3b3JraW5nIHRyZWUgaXMgbGVmdCBpbiBhIGNvbmZsaWN0ZWQgc3RhdGUgKG5vIHJlc2V0KSBzbyB0aGVcbiAqIGNhbGxlciBjYW4gZGlzcGF0Y2ggYSBmaXgtbWVyZ2Ugc2Vzc2lvbiB0byByZXNvbHZlIGl0LlxuICovXG5leHBvcnQgY2xhc3MgTWVyZ2VDb25mbGljdEVycm9yIGV4dGVuZHMgR1NERXJyb3Ige1xuICByZWFkb25seSBjb25mbGljdGVkRmlsZXM6IHN0cmluZ1tdO1xuICByZWFkb25seSBzdHJhdGVneTogXCJzcXVhc2hcIiB8IFwibWVyZ2VcIjtcbiAgcmVhZG9ubHkgYnJhbmNoOiBzdHJpbmc7XG4gIHJlYWRvbmx5IG1haW5CcmFuY2g6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihcbiAgICBjb25mbGljdGVkRmlsZXM6IHN0cmluZ1tdLFxuICAgIHN0cmF0ZWd5OiBcInNxdWFzaFwiIHwgXCJtZXJnZVwiLFxuICAgIGJyYW5jaDogc3RyaW5nLFxuICAgIG1haW5CcmFuY2g6IHN0cmluZyxcbiAgKSB7XG4gICAgc3VwZXIoXG4gICAgICBHU0RfTUVSR0VfQ09ORkxJQ1QsXG4gICAgICBgJHtzdHJhdGVneSA9PT0gXCJtZXJnZVwiID8gXCJNZXJnZVwiIDogXCJTcXVhc2gtbWVyZ2VcIn0gb2YgXCIke2JyYW5jaH1cIiBpbnRvIFwiJHttYWluQnJhbmNofVwiIGAgK1xuICAgICAgYGZhaWxlZCB3aXRoIGNvbmZsaWN0cyBpbiAke2NvbmZsaWN0ZWRGaWxlcy5sZW5ndGh9IG5vbi0uZ3NkIGZpbGUocyk6ICR7Y29uZmxpY3RlZEZpbGVzLmpvaW4oXCIsIFwiKX1gLFxuICAgICk7XG4gICAgdGhpcy5uYW1lID0gXCJNZXJnZUNvbmZsaWN0RXJyb3JcIjtcbiAgICB0aGlzLmNvbmZsaWN0ZWRGaWxlcyA9IGNvbmZsaWN0ZWRGaWxlcztcbiAgICB0aGlzLnN0cmF0ZWd5ID0gc3RyYXRlZ3k7XG4gICAgdGhpcy5icmFuY2ggPSBicmFuY2g7XG4gICAgdGhpcy5tYWluQnJhbmNoID0gbWFpbkJyYW5jaDtcbiAgfVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIFByZU1lcmdlQ2hlY2tSZXN1bHQge1xuICBwYXNzZWQ6IGJvb2xlYW47XG4gIHNraXBwZWQ/OiBib29sZWFuO1xuICBjb21tYW5kPzogc3RyaW5nO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIENvbnN0YW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBHU0QgcnVudGltZSBwYXRocyB0aGF0IHNob3VsZCBiZSBleGNsdWRlZCBmcm9tIHNtYXJ0IHN0YWdpbmcuXG4gKiBUaGVzZSBhcmUgdHJhbnNpZW50L2dlbmVyYXRlZCBhcnRpZmFjdHMgdGhhdCBzaG91bGQgbmV2ZXIgYmUgY29tbWl0dGVkLlxuICpcbiAqIE5PVEU6IEdTRF9SVU5USU1FX1BBVFRFUk5TIGluIGdpdGlnbm9yZS50cyBpcyB0aGUgY2Fub25pY2FsIHNvdXJjZSBvZiB0cnV0aC5cbiAqIFRoaXMgYXJyYXkgbXVzdCBzdGF5IHN5bmNocm9uaXplZCB3aXRoIGl0LlxuICovXG5leHBvcnQgY29uc3QgUlVOVElNRV9FWENMVVNJT05fUEFUSFM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBcIi5nc2QvYWN0aXZpdHkvXCIsXG4gIFwiLmdzZC9hdWRpdC9cIixcbiAgXCIuZ3NkL2ZvcmVuc2ljcy9cIixcbiAgXCIuZ3NkL3J1bnRpbWUvXCIsXG4gIFwiLmdzZC93b3JrdHJlZXMvXCIsXG4gIFwiLmdzZC9wYXJhbGxlbC9cIixcbiAgXCIuZ3NkL2F1dG8ubG9ja1wiLFxuICBcIi5nc2QvbWV0cmljcy5qc29uXCIsXG4gIFwiLmdzZC9jb21wbGV0ZWQtdW5pdHMqLmpzb25cIiwgLy8gY292ZXJzIGNvbXBsZXRlZC11bml0cy5qc29uIGFuZCBhcmNoaXZlZCBjb21wbGV0ZWQtdW5pdHMte01JRH0uanNvblxuICBcIi5nc2Qvc3RhdGUtbWFuaWZlc3QuanNvblwiLFxuICBcIi5nc2QvU1RBVEUubWRcIixcbiAgXCIuZ3NkL2dzZC5kYipcIixcbiAgXCIuZ3NkL2pvdXJuYWwvXCIsXG4gIFwiLmdzZC9kb2N0b3ItaGlzdG9yeS5qc29ubFwiLFxuICBcIi5nc2QvZXZlbnQtbG9nLmpzb25sXCIsXG4gIFwiLmdzZC9ESVNDVVNTSU9OLU1BTklGRVNULmpzb25cIixcbl07XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBJbnRlZ3JhdGlvbiBCcmFuY2ggTWV0YWRhdGEgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogUGF0aCB0byB0aGUgbWlsZXN0b25lIG1ldGFkYXRhIGZpbGUgdGhhdCBzdG9yZXMgdGhlIGludGVncmF0aW9uIGJyYW5jaC5cbiAqIEZvcm1hdDogLmdzZC9taWxlc3RvbmVzLzxNSUQ+LzxNSUQ+LU1FVEEuanNvblxuICovXG5mdW5jdGlvbiBtaWxlc3RvbmVNZXRhUGF0aChiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwibWlsZXN0b25lc1wiLCBtaWxlc3RvbmVJZCwgYCR7bWlsZXN0b25lSWR9LU1FVEEuanNvbmApO1xufVxuXG4vKipcbiAqIFJlYWQgdGhlIGludGVncmF0aW9uIGJyYW5jaCByZWNvcmRlZCBmb3IgYSBtaWxlc3RvbmUuXG4gKiBSZXR1cm5zIG51bGwgaWYgbm8gbWV0YWRhdGEgZmlsZSBleGlzdHMgb3IgdGhlIGJyYW5jaCBpc24ndCBzZXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkSW50ZWdyYXRpb25CcmFuY2goYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IG1ldGFGaWxlID0gbWlsZXN0b25lTWV0YVBhdGgoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMobWV0YUZpbGUpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobWV0YUZpbGUsIFwidXRmLThcIikpO1xuICAgIGNvbnN0IGJyYW5jaCA9IGRhdGE/LmludGVncmF0aW9uQnJhbmNoO1xuICAgIGlmICh0eXBlb2YgYnJhbmNoID09PSBcInN0cmluZ1wiICYmIGJyYW5jaC50cmltKCkgIT09IFwiXCIgJiYgVkFMSURfQlJBTkNIX05BTUUudGVzdChicmFuY2gpKSB7XG4gICAgICByZXR1cm4gYnJhbmNoO1xuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqXG4gKiBQZXJzaXN0IHRoZSBpbnRlZ3JhdGlvbiBicmFuY2ggZm9yIGEgbWlsZXN0b25lLlxuICpcbiAqIENhbGxlZCB3aGVuIGF1dG8tbW9kZSBzdGFydHMgb24gYSBtaWxlc3RvbmUuIFJlY29yZHMgdGhlIGJyYW5jaCB0aGUgdXNlclxuICogd2FzIG9uIGF0IHRoYXQgcG9pbnQsIHNvIHRoZSBtaWxlc3RvbmUgd29ya3RyZWUgbWVyZ2VzIGJhY2sgdG8gdGhlIGNvcnJlY3RcbiAqIGJyYW5jaC4gSWRlbXBvdGVudCB3aGVuIHRoZSBicmFuY2ggbWF0Y2hlczsgdXBkYXRlcyB0aGUgcmVjb3JkIHdoZW4gdGhlXG4gKiB1c2VyIHN0YXJ0cyBmcm9tIGEgZGlmZmVyZW50IGJyYW5jaC5cbiAqXG4gKiBUaGUgZmlsZSBpcyBjb21taXR0ZWQgaW1tZWRpYXRlbHkgc28gdGhlIG1ldGFkYXRhIGlzIHBlcnNpc3RlZCBpbiBnaXQuXG4gKi9cbi8qKiBSZS1leHBvcnQgZm9yIGJhY2t3YXJkIGNvbXBhdGliaWxpdHkgXHUyMDE0IGNhbm9uaWNhbCBkZWZpbml0aW9ucyBpbiBicmFuY2gtcGF0dGVybnMudHMgKi9cbmV4cG9ydCB7IFFVSUNLX0JSQU5DSF9SRSwgV09SS0ZMT1dfQlJBTkNIX1JFIH0gZnJvbSBcIi4vYnJhbmNoLXBhdHRlcm5zLmpzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUludGVncmF0aW9uQnJhbmNoKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBicmFuY2g6IHN0cmluZyxcbik6IHZvaWQge1xuICAvLyBEb24ndCByZWNvcmQgc2xpY2UgYnJhbmNoZXMgYXMgdGhlIGludGVncmF0aW9uIHRhcmdldFxuICBpZiAoU0xJQ0VfQlJBTkNIX1JFLnRlc3QoYnJhbmNoKSkgcmV0dXJuO1xuICAvLyBEb24ndCByZWNvcmQgcXVpY2stdGFzayBicmFuY2hlcyBcdTIwMTQgdGhleSBhcmUgZXBoZW1lcmFsIGFuZCBtZXJnZSBiYWNrXG4gIC8vIHRvIHRoZWlyIG9yaWdpbiBicmFuY2ggb24gY29tcGxldGlvbi4gUmVjb3JkaW5nIG9uZSBhcyB0aGUgaW50ZWdyYXRpb25cbiAgLy8gdGFyZ2V0IGNhdXNlcyBtaWxlc3RvbmUgbWVyZ2VzIHRvIGxhbmQgb24gdGhlIHdyb25nIGJyYW5jaCAoIzEyOTMpLlxuICBpZiAoUVVJQ0tfQlJBTkNIX1JFLnRlc3QoYnJhbmNoKSkgcmV0dXJuO1xuICAvLyBEb24ndCByZWNvcmQgd29ya2Zsb3ctdGVtcGxhdGUgYnJhbmNoZXMgKGhvdGZpeCwgYnVnZml4LCBzcGlrZSwgZXRjLikgXHUyMDE0XG4gIC8vIHNhbWUgcm9vdCBjYXVzZSBhcyBxdWljay10YXNrIGJyYW5jaGVzICgjMjQ5OCkuIEFsbCB0ZW1wbGF0ZXMgY3JlYXRlXG4gIC8vIGdzZC88dGVtcGxhdGVJZD4vPHNsdWc+IGJyYW5jaGVzIHRoYXQgYXJlIGVwaGVtZXJhbC5cbiAgaWYgKFdPUktGTE9XX0JSQU5DSF9SRS50ZXN0KGJyYW5jaCkpIHJldHVybjtcbiAgLy8gVmFsaWRhdGVcbiAgaWYgKCFWQUxJRF9CUkFOQ0hfTkFNRS50ZXN0KGJyYW5jaCkpIHJldHVybjtcbiAgLy8gU2tpcCBpZiBhbHJlYWR5IHJlY29yZGVkIHdpdGggdGhlIHNhbWUgYnJhbmNoIChpZGVtcG90ZW50IGFjcm9zcyByZXN0YXJ0cykuXG4gIC8vIElmIHJlY29yZGVkIHdpdGggYSBkaWZmZXJlbnQgYnJhbmNoLCB1cGRhdGUgaXQgXHUyMDE0IHRoZSB1c2VyIHN0YXJ0ZWQgYXV0by1tb2RlXG4gIC8vIGZyb20gYSBuZXcgYnJhbmNoIGFuZCBleHBlY3RzIHNsaWNlcyB0byBtZXJnZSBiYWNrIHRoZXJlICgjMzAwKS5cbiAgY29uc3QgZXhpc3RpbmdCcmFuY2ggPSByZWFkSW50ZWdyYXRpb25CcmFuY2goYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgaWYgKGV4aXN0aW5nQnJhbmNoID09PSBicmFuY2gpIHJldHVybjtcblxuICBjb25zdCBtZXRhRmlsZSA9IG1pbGVzdG9uZU1ldGFQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCk7XG4gIG1rZGlyU3luYyhqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIm1pbGVzdG9uZXNcIiwgbWlsZXN0b25lSWQpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAvLyBNZXJnZSB3aXRoIGV4aXN0aW5nIG1ldGFkYXRhIGlmIHByZXNlbnRcbiAgbGV0IGV4aXN0aW5nOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICB0cnkge1xuICAgIGlmIChleGlzdHNTeW5jKG1ldGFGaWxlKSkge1xuICAgICAgZXhpc3RpbmcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhtZXRhRmlsZSwgXCJ1dGYtOFwiKSk7XG4gICAgfVxuICB9IGNhdGNoIHsgLyogY29ycnVwdCBmaWxlIFx1MjAxNCBvdmVyd3JpdGUgKi8gfVxuXG4gIGV4aXN0aW5nLmludGVncmF0aW9uQnJhbmNoID0gYnJhbmNoO1xuICB3cml0ZUZpbGVTeW5jKG1ldGFGaWxlLCBKU09OLnN0cmluZ2lmeShleGlzdGluZywgbnVsbCwgMikgKyBcIlxcblwiLCBcInV0Zi04XCIpO1xuICAvLyAuZ3NkLyBpcyBtYW5hZ2VkIGV4dGVybmFsbHkgKHN5bWxpbmtlZCkgXHUyMDE0IG1ldGFkYXRhIGlzIG5vdCBjb21taXR0ZWQgdG8gZ2l0LlxufVxuXG5leHBvcnQgdHlwZSBJbnRlZ3JhdGlvbkJyYW5jaFJlc29sdXRpb25TdGF0dXMgPSBcInJlY29yZGVkXCIgfCBcImZhbGxiYWNrXCIgfCBcIm1pc3NpbmdcIjtcblxuZXhwb3J0IGludGVyZmFjZSBJbnRlZ3JhdGlvbkJyYW5jaFJlc29sdXRpb24ge1xuICByZWNvcmRlZEJyYW5jaDogc3RyaW5nIHwgbnVsbDtcbiAgZWZmZWN0aXZlQnJhbmNoOiBzdHJpbmcgfCBudWxsO1xuICBzdGF0dXM6IEludGVncmF0aW9uQnJhbmNoUmVzb2x1dGlvblN0YXR1cztcbiAgcmVhc29uOiBzdHJpbmc7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBhIG1pbGVzdG9uZSdzIHJlY29yZGVkIGludGVncmF0aW9uIGJyYW5jaCBpbnRvIGFuIGFjdGlvbmFibGUgc3RhdHVzLlxuICpcbiAqIFRoaXMgaGVscGVyIGlzIGludGVudGlvbmFsbHkgc2NvcGVkIHRvIG1pbGVzdG9uZXMgdGhhdCBhbHJlYWR5IGhhdmUgcmVjb3JkZWRcbiAqIG1ldGFkYXRhLiBJZiBubyBpbnRlZ3JhdGlvbiBicmFuY2ggaXMgcmVjb3JkZWQsIGl0IHJldHVybnMgYG1pc3NpbmdgIHdpdGggbm9cbiAqIGVmZmVjdGl2ZSBicmFuY2ggc28gY2FsbGVycyBjYW4gY29udGludWUgd2l0aCB0aGVpciBleGlzdGluZyBub24tbWlsZXN0b25lXG4gKiBmYWxsYmFjayBsb2dpYyAoZm9yIGV4YW1wbGUgd29ya3RyZWUvY3VycmVudC1icmFuY2ggZGV0ZWN0aW9uIGluIGdldE1haW5CcmFuY2gpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1pbGVzdG9uZUludGVncmF0aW9uQnJhbmNoKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICBwcmVmczogR2l0UHJlZmVyZW5jZXMgPSB7fSxcbik6IEludGVncmF0aW9uQnJhbmNoUmVzb2x1dGlvbiB7XG4gIGNvbnN0IHJlY29yZGVkQnJhbmNoID0gcmVhZEludGVncmF0aW9uQnJhbmNoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCk7XG4gIGlmICghcmVjb3JkZWRCcmFuY2gpIHtcbiAgICByZXR1cm4ge1xuICAgICAgcmVjb3JkZWRCcmFuY2g6IG51bGwsXG4gICAgICBlZmZlY3RpdmVCcmFuY2g6IG51bGwsXG4gICAgICBzdGF0dXM6IFwibWlzc2luZ1wiLFxuICAgICAgcmVhc29uOiBgTWlsZXN0b25lICR7bWlsZXN0b25lSWR9IGhhcyBubyByZWNvcmRlZCBpbnRlZ3JhdGlvbiBicmFuY2ggbWV0YWRhdGEuYCxcbiAgICB9O1xuICB9XG5cbiAgaWYgKG5hdGl2ZUJyYW5jaEV4aXN0cyhiYXNlUGF0aCwgcmVjb3JkZWRCcmFuY2gpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHJlY29yZGVkQnJhbmNoLFxuICAgICAgZWZmZWN0aXZlQnJhbmNoOiByZWNvcmRlZEJyYW5jaCxcbiAgICAgIHN0YXR1czogXCJyZWNvcmRlZFwiLFxuICAgICAgcmVhc29uOiBgVXNpbmcgcmVjb3JkZWQgaW50ZWdyYXRpb24gYnJhbmNoIFwiJHtyZWNvcmRlZEJyYW5jaH1cIiBmb3IgbWlsZXN0b25lICR7bWlsZXN0b25lSWR9LmAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGNvbmZpZ3VyZWRCcmFuY2ggPSBwcmVmcy5tYWluX2JyYW5jaCAmJiBWQUxJRF9CUkFOQ0hfTkFNRS50ZXN0KHByZWZzLm1haW5fYnJhbmNoKVxuICAgID8gcHJlZnMubWFpbl9icmFuY2hcbiAgICA6IG51bGw7XG5cbiAgaWYgKGNvbmZpZ3VyZWRCcmFuY2gpIHtcbiAgICBpZiAobmF0aXZlQnJhbmNoRXhpc3RzKGJhc2VQYXRoLCBjb25maWd1cmVkQnJhbmNoKSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVjb3JkZWRCcmFuY2gsXG4gICAgICAgIGVmZmVjdGl2ZUJyYW5jaDogY29uZmlndXJlZEJyYW5jaCxcbiAgICAgICAgc3RhdHVzOiBcImZhbGxiYWNrXCIsXG4gICAgICAgIHJlYXNvbjogYFJlY29yZGVkIGludGVncmF0aW9uIGJyYW5jaCBcIiR7cmVjb3JkZWRCcmFuY2h9XCIgZm9yIG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBubyBsb25nZXIgZXhpc3RzOyB1c2luZyBjb25maWd1cmVkIGdpdC5tYWluX2JyYW5jaCBcIiR7Y29uZmlndXJlZEJyYW5jaH1cIiBpbnN0ZWFkLmAsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICByZWNvcmRlZEJyYW5jaCxcbiAgICAgIGVmZmVjdGl2ZUJyYW5jaDogbnVsbCxcbiAgICAgIHN0YXR1czogXCJtaXNzaW5nXCIsXG4gICAgICByZWFzb246IGBSZWNvcmRlZCBpbnRlZ3JhdGlvbiBicmFuY2ggXCIke3JlY29yZGVkQnJhbmNofVwiIGZvciBtaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0gbm8gbG9uZ2VyIGV4aXN0cywgYW5kIGNvbmZpZ3VyZWQgZ2l0Lm1haW5fYnJhbmNoIFwiJHtjb25maWd1cmVkQnJhbmNofVwiIGlzIHVuYXZhaWxhYmxlLmAsXG4gICAgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgY29uc3QgZGV0ZWN0ZWRCcmFuY2ggPSBuYXRpdmVEZXRlY3RNYWluQnJhbmNoKGJhc2VQYXRoKTtcbiAgICBpZiAoZGV0ZWN0ZWRCcmFuY2ggJiYgVkFMSURfQlJBTkNIX05BTUUudGVzdChkZXRlY3RlZEJyYW5jaCkgJiYgbmF0aXZlQnJhbmNoRXhpc3RzKGJhc2VQYXRoLCBkZXRlY3RlZEJyYW5jaCkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHJlY29yZGVkQnJhbmNoLFxuICAgICAgICBlZmZlY3RpdmVCcmFuY2g6IGRldGVjdGVkQnJhbmNoLFxuICAgICAgICBzdGF0dXM6IFwiZmFsbGJhY2tcIixcbiAgICAgICAgcmVhc29uOiBgUmVjb3JkZWQgaW50ZWdyYXRpb24gYnJhbmNoIFwiJHtyZWNvcmRlZEJyYW5jaH1cIiBmb3IgbWlsZXN0b25lICR7bWlsZXN0b25lSWR9IG5vIGxvbmdlciBleGlzdHM7IHVzaW5nIGRldGVjdGVkIGZhbGxiYWNrIGJyYW5jaCBcIiR7ZGV0ZWN0ZWRCcmFuY2h9XCIgaW5zdGVhZC5gLFxuICAgICAgfTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIEZhbGwgdGhyb3VnaCB0byB0aGUgZXhwbGljaXQgbWlzc2luZyByZXN1bHQgYmVsb3cuXG4gIH1cblxuICByZXR1cm4ge1xuICAgIHJlY29yZGVkQnJhbmNoLFxuICAgIGVmZmVjdGl2ZUJyYW5jaDogbnVsbCxcbiAgICBzdGF0dXM6IFwibWlzc2luZ1wiLFxuICAgIHJlYXNvbjogYFJlY29yZGVkIGludGVncmF0aW9uIGJyYW5jaCBcIiR7cmVjb3JkZWRCcmFuY2h9XCIgZm9yIG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBubyBsb25nZXIgZXhpc3RzLCBhbmQgbm8gc2FmZSBmYWxsYmFjayBicmFuY2ggY291bGQgYmUgZGV0ZXJtaW5lZC5gLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUHJlLU1lcmdlIENvbW1hbmQgVG9rZW5pemVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFRva2VuaXplIGEgdXNlci1zdXBwbGllZCBwcmUtbWVyZ2UgY29tbWFuZCBzdHJpbmcgaW50byBhcmd2IGZvcm0sIHdpdGhcbiAqIG1pbmltYWwgc3VwcG9ydCBmb3IgZG91YmxlLSBhbmQgc2luZ2xlLXF1b3RlZCBzdHJpbmdzLiBEZXNpZ25lZCB0byBiZVxuICogc3VmZmljaWVudCBmb3IgdHlwaWNhbCBjb21tYW5kcyAoXCJucG0gdGVzdFwiLCBgbnBtIHJ1biBsaW50OmNpYCxcbiAqIGBwbnBtIHJ1biB0c2MgLS1ub0VtaXRgKSB3aXRob3V0IHNwYXduaW5nIGEgc2hlbGwuXG4gKlxuICogUmV0dXJucyBbXSB3aGVuIHRoZSBpbnB1dCBpcyBlbXB0eSBvciB3aGl0ZXNwYWNlLW9ubHkuXG4gKiBUaHJvd3Mgd2hlbiBxdW90aW5nIGlzIG1hbGZvcm1lZC5cbiAqXG4gKiBVc2VkIGJ5IEdpdFNlcnZpY2VJbXBsLnJ1blByZU1lcmdlQ2hlY2sgdG8gZWxpbWluYXRlIHRoZSBzaGVsbC1pbmplY3Rpb25cbiAqIHN1cmZhY2UgdGhhdCBydW5uaW5nIGFuIGFyYml0cmFyeSB1c2VyIHN0cmluZyB0aHJvdWdoIGEgc2hlbGwgd291bGQgY3JlYXRlLlxuICogKElzc3VlICM0OTgwIEhJR0gtMilcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRva2VuaXplUHJlTWVyZ2VDb21tYW5kKGlucHV0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHRva2Vuczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGN1cnJlbnQgPSBcIlwiO1xuICBsZXQgaSA9IDA7XG4gIGxldCBxdW90ZTogXCJcIiB8IFwiJ1wiIHwgJ1wiJyA9IFwiXCI7XG4gIGxldCBoYXNDb250ZW50ID0gZmFsc2U7XG5cbiAgd2hpbGUgKGkgPCBpbnB1dC5sZW5ndGgpIHtcbiAgICBjb25zdCBjaCA9IGlucHV0W2ldITtcbiAgICBpZiAocXVvdGUpIHtcbiAgICAgIGlmIChjaCA9PT0gcXVvdGUpIHtcbiAgICAgICAgcXVvdGUgPSBcIlwiO1xuICAgICAgfSBlbHNlIGlmIChjaCA9PT0gXCJcXFxcXCIgJiYgcXVvdGUgPT09ICdcIicgJiYgaSArIDEgPCBpbnB1dC5sZW5ndGgpIHtcbiAgICAgICAgY3VycmVudCArPSBpbnB1dFtpICsgMV07XG4gICAgICAgIGkgKz0gMjtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdXJyZW50ICs9IGNoO1xuICAgICAgfVxuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaCA9PT0gJ1wiJyB8fCBjaCA9PT0gXCInXCIpIHtcbiAgICAgIHF1b3RlID0gY2g7XG4gICAgICBoYXNDb250ZW50ID0gdHJ1ZTtcbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY2ggPT09IFwiIFwiIHx8IGNoID09PSBcIlxcdFwiKSB7XG4gICAgICBpZiAoaGFzQ29udGVudCkge1xuICAgICAgICB0b2tlbnMucHVzaChjdXJyZW50KTtcbiAgICAgICAgY3VycmVudCA9IFwiXCI7XG4gICAgICAgIGhhc0NvbnRlbnQgPSBmYWxzZTtcbiAgICAgIH1cbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY2ggPT09IFwiXFxcXFwiICYmIGkgKyAxIDwgaW5wdXQubGVuZ3RoKSB7XG4gICAgICBjdXJyZW50ICs9IGlucHV0W2kgKyAxXTtcbiAgICAgIGkgKz0gMjtcbiAgICAgIGhhc0NvbnRlbnQgPSB0cnVlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGN1cnJlbnQgKz0gY2g7XG4gICAgaGFzQ29udGVudCA9IHRydWU7XG4gICAgaSsrO1xuICB9XG5cbiAgaWYgKHF1b3RlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBVbnRlcm1pbmF0ZWQgJHtxdW90ZSA9PT0gJ1wiJyA/IFwiZG91YmxlXCIgOiBcInNpbmdsZVwifSBxdW90ZSBpbiBwcmUtbWVyZ2UgY29tbWFuZGApO1xuICB9XG4gIGlmIChoYXNDb250ZW50KSB0b2tlbnMucHVzaChjdXJyZW50KTtcbiAgcmV0dXJuIHRva2Vucztcbn1cblxuZnVuY3Rpb24gY29udGFpbnNVbnF1b3RlZFNoZWxsQ29udHJvbChpbnB1dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGxldCBpID0gMDtcbiAgbGV0IHF1b3RlOiBcIlwiIHwgXCInXCIgfCAnXCInID0gXCJcIjtcblxuICB3aGlsZSAoaSA8IGlucHV0Lmxlbmd0aCkge1xuICAgIGNvbnN0IGNoID0gaW5wdXRbaV0hO1xuICAgIGlmIChxdW90ZSkge1xuICAgICAgaWYgKGNoID09PSBxdW90ZSkge1xuICAgICAgICBxdW90ZSA9IFwiXCI7XG4gICAgICB9IGVsc2UgaWYgKGNoID09PSBcIlxcXFxcIiAmJiBxdW90ZSA9PT0gJ1wiJyAmJiBpICsgMSA8IGlucHV0Lmxlbmd0aCkge1xuICAgICAgICBpICs9IDI7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgaWYgKGNoID09PSAnXCInIHx8IGNoID09PSBcIidcIikge1xuICAgICAgcXVvdGUgPSBjaDtcbiAgICAgIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY2ggPT09IFwiXFxcXFwiICYmIGkgKyAxIDwgaW5wdXQubGVuZ3RoKSB7XG4gICAgICBpICs9IDI7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNoID09PSBcIjtcIiB8fCBjaCA9PT0gXCImXCIgfHwgY2ggPT09IFwifFwiIHx8IGNoID09PSBcImBcIiB8fCBjaCA9PT0gXCIkXCIgfHwgY2ggPT09IFwiPFwiIHx8IGNoID09PSBcIj5cIikge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGkrKztcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEdpdCBIZWxwZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cblxuLyoqXG4gKiBTdHJpcCBnaXQtc3ZuIG5vaXNlIGZyb20gZXJyb3IgbWVzc2FnZXMuXG4gKiBTb21lIHN5c3RlbXMgKG5vdGFibHkgQXJjaCBMaW51eCkgaGF2ZSBhIGJ1Z2d5IGdpdC1zdm4gUGVybCBtb2R1bGUgdGhhdFxuICogZW1pdHMgd2FybmluZ3Mgb24gZXZlcnkgZ2l0IGludm9jYXRpb24sIGNvbmZ1c2luZyB1c2Vycy4gU2VlICM0MDQuXG4gKi9cbmZ1bmN0aW9uIGZpbHRlckdpdFN2bk5vaXNlKG1lc3NhZ2U6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBtZXNzYWdlXG4gICAgLnJlcGxhY2UoL0R1cGxpY2F0ZSBzcGVjaWZpY2F0aW9uIFwiW15cIl0qXCIgZm9yIG9wdGlvbiBcIlteXCJdKlwiXFxuPy9nLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9VbmFibGUgdG8gZGV0ZXJtaW5lIHVwc3RyZWFtIFNWTiBpbmZvcm1hdGlvbiBmcm9tIC4qXFxuPy9nLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9QZXJoYXBzIHRoZSByZXBvc2l0b3J5IGlzIGVtcHR5XFwuIGF0IC4qZ2l0LXN2bi4qXFxuPy9nLCBcIlwiKVxuICAgIC50cmltKCk7XG59XG5cbi8qKlxuICogUnVuIGEgZ2l0IGNvbW1hbmQgaW4gdGhlIGdpdmVuIGRpcmVjdG9yeS5cbiAqIFJldHVybnMgdHJpbW1lZCBzdGRvdXQuIFRocm93cyBvbiBub24temVybyBleGl0IHVubGVzcyBhbGxvd0ZhaWx1cmUgaXMgc2V0LlxuICogV2hlbiBgaW5wdXRgIGlzIHByb3ZpZGVkLCBpdCBpcyBwaXBlZCB0byBzdGRpbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1bkdpdChiYXNlUGF0aDogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSwgb3B0aW9uczogeyBhbGxvd0ZhaWx1cmU/OiBib29sZWFuOyBpbnB1dD86IHN0cmluZyB9ID0ge30pOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBleGVjRmlsZVN5bmMoXCJnaXRcIiwgYXJncywge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbb3B0aW9ucy5pbnB1dCAhPSBudWxsID8gXCJwaXBlXCIgOiBcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgIGVudjogR0lUX05PX1BST01QVF9FTlYsXG4gICAgICAuLi4ob3B0aW9ucy5pbnB1dCAhPSBudWxsID8geyBpbnB1dDogb3B0aW9ucy5pbnB1dCB9IDoge30pLFxuICAgIH0pLnRyaW0oKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAob3B0aW9ucy5hbGxvd0ZhaWx1cmUpIHJldHVybiBcIlwiO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBnZXRFcnJvck1lc3NhZ2UoZXJyb3IpO1xuICAgIHRocm93IG5ldyBHU0RFcnJvcihHU0RfR0lUX0VSUk9SLCBgZ2l0ICR7YXJncy5qb2luKFwiIFwiKX0gZmFpbGVkIGluICR7YmFzZVBhdGh9OiAke2ZpbHRlckdpdFN2bk5vaXNlKG1lc3NhZ2UpfWApO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb21taXQgVHlwZSBJbmZlcmVuY2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogS2V5d29yZC10by1jb21taXQtdHlwZSBtYXBwaW5nLiBPcmRlciBtYXR0ZXJzIFx1MjAxNCBmaXJzdCBtYXRjaCB3aW5zLlxuICogRWFjaCBlbnRyeTogW2tleXdvcmRzW10sIGNvbW1pdFR5cGVdXG4gKi9cbmNvbnN0IENPTU1JVF9UWVBFX1JVTEVTOiBbc3RyaW5nW10sIHN0cmluZ11bXSA9IFtcbiAgW1tcImZpeFwiLCBcImZpeGVkXCIsIFwiZml4ZXNcIiwgXCJidWdcIiwgXCJwYXRjaFwiLCBcImhvdGZpeFwiLCBcInJlcGFpclwiLCBcImNvcnJlY3RcIl0sIFwiZml4XCJdLFxuICBbW1wicmVmYWN0b3JcIiwgXCJyZXN0cnVjdHVyZVwiLCBcInJlb3JnYW5pemVcIl0sIFwicmVmYWN0b3JcIl0sXG4gIFtbXCJkb2NcIiwgXCJkb2NzXCIsIFwiZG9jdW1lbnRhdGlvblwiLCBcInJlYWRtZVwiLCBcImNoYW5nZWxvZ1wiXSwgXCJkb2NzXCJdLFxuICBbW1widGVzdFwiLCBcInRlc3RzXCIsIFwidGVzdGluZ1wiLCBcInNwZWNcIiwgXCJjb3ZlcmFnZVwiXSwgXCJ0ZXN0XCJdLFxuICBbW1wicGVyZlwiLCBcInBlcmZvcm1hbmNlXCIsIFwib3B0aW1pemVcIiwgXCJzcGVlZFwiLCBcImNhY2hlXCJdLCBcInBlcmZcIl0sXG4gIFtbXCJjaG9yZVwiLCBcImNsZWFudXBcIiwgXCJjbGVhbiB1cFwiLCBcImRlcGVuZGVuY2llc1wiLCBcImRlcHNcIiwgXCJidW1wXCIsIFwiY29uZmlnXCIsIFwiY2lcIiwgXCJhcmNoaXZlXCIsIFwicmVtb3ZlXCIsIFwiZGVsZXRlXCJdLCBcImNob3JlXCJdLFxuXTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEdpdFNlcnZpY2VJbXBsIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgY2xhc3MgR2l0U2VydmljZUltcGwge1xuICByZWFkb25seSBiYXNlUGF0aDogc3RyaW5nO1xuICByZWFkb25seSBwcmVmczogR2l0UHJlZmVyZW5jZXM7XG5cbiAgLyoqIEFjdGl2ZSBtaWxlc3RvbmUgSUQgXHUyMDE0IHVzZWQgdG8gcmVzb2x2ZSB0aGUgaW50ZWdyYXRpb24gYnJhbmNoLiAqL1xuICBwcml2YXRlIF9taWxlc3RvbmVJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3RydWN0b3IoYmFzZVBhdGg6IHN0cmluZywgcHJlZnM6IEdpdFByZWZlcmVuY2VzID0ge30pIHtcbiAgICB0aGlzLmJhc2VQYXRoID0gYmFzZVBhdGg7XG4gICAgdGhpcy5wcmVmcyA9IHByZWZzO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCB0aGUgYWN0aXZlIG1pbGVzdG9uZSBJRCBmb3IgaW50ZWdyYXRpb24gYnJhbmNoIHJlc29sdXRpb24uXG4gICAqIFdoZW4gc2V0LCBnZXRNYWluQnJhbmNoKCkgd2lsbCBjaGVjayB0aGUgbWlsZXN0b25lJ3MgbWV0YWRhdGEgZmlsZVxuICAgKiBmb3IgYSByZWNvcmRlZCBpbnRlZ3JhdGlvbiBicmFuY2ggYmVmb3JlIGZhbGxpbmcgYmFjayB0byByZXBvIGRlZmF1bHRzLlxuICAgKi9cbiAgc2V0TWlsZXN0b25lSWQobWlsZXN0b25lSWQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgICB0aGlzLl9taWxlc3RvbmVJZCA9IG1pbGVzdG9uZUlkO1xuICB9XG5cbiAgLyoqXG4gICAqIFNtYXJ0IHN0YWdpbmc6IGBnaXQgYWRkIC1BYCBleGNsdWRpbmcgR1NEIHJ1bnRpbWUgcGF0aHMgdmlhIHBhdGhzcGVjLlxuICAgKiBGYWxscyBiYWNrIHRvIHBsYWluIGBnaXQgYWRkIC1BYCBpZiB0aGUgZXhjbHVzaW9uIHBhdGhzcGVjIGZhaWxzLlxuICAgKiBAcGFyYW0gZXh0cmFFeGNsdXNpb25zIEFkZGl0aW9uYWwgcGF0aHNwZWMgZXhjbHVzaW9ucyBiZXlvbmQgUlVOVElNRV9FWENMVVNJT05fUEFUSFMuXG4gICAqL1xuICBwcml2YXRlIHNtYXJ0U3RhZ2UoZXh0cmFFeGNsdXNpb25zOiByZWFkb25seSBzdHJpbmdbXSA9IFtdKTogdm9pZCB7XG4gICAgLy8gT25lLXRpbWUgY2xlYW51cDogaWYgcnVudGltZSBmaWxlcyBhcmUgYWxyZWFkeSB0cmFja2VkIGluIHRoZSBpbmRleFxuICAgIC8vIChmcm9tIG9sZGVyIHZlcnNpb25zIHdoZXJlIHRoZSBmYWxsYmFjayBidWcgc3RhZ2VkIHRoZW0pLCB1bnRyYWNrIHRoZW1cbiAgICAvLyBpbiBhIGRlZGljYXRlZCBjb21taXQuIFRoaXMgbXVzdCBoYXBwZW4gYXMgYSBzZXBhcmF0ZSBjb21taXQgYmVjYXVzZVxuICAgIC8vIHRoZSBnaXQgcmVzZXQgSEVBRCBzdGVwIGJlbG93IHdvdWxkIG90aGVyd2lzZSB1bmRvIHRoZSBybSAtLWNhY2hlZC5cbiAgICAvL1xuICAgIC8vIFNBRkVUWTogT25seSB1bnRyYWNrIHRoZSBzcGVjaWZpYyBSVU5USU1FIHBhdGhzIChhY3Rpdml0eS8sIHJ1bnRpbWUvLFxuICAgIC8vIGF1dG8ubG9jaywgZXRjLikgXHUyMDE0IE5PVCBhbGwgb2YgLmdzZC8uIElmIC5nc2QvbWlsZXN0b25lcy8gZmlsZXMgd2VyZVxuICAgIC8vIHByZXZpb3VzbHkgdHJhY2tlZCwgdGhleSBzdGF5IHRyYWNrZWQgdW50aWwgdGhlIG1pbGVzdG9uZSBjb21wbGV0ZXNcbiAgICAvLyBhbmQgdGhlIHdvcmt0cmVlIGlzIHRvcm4gZG93bi4gVGhpcyBwcmV2ZW50cyBhIG1pZC1leGVjdXRpb24gYmVoYXZpb3JhbFxuICAgIC8vIGRpc2NvbnRpbnVpdHkgd2hlcmUgdGhlIGZpcnN0IGhhbGYgb2YgYSBtaWxlc3RvbmUgaGFzIC5nc2QvIGFydGlmYWN0c1xuICAgIC8vIGNvbW1pdHRlZCBidXQgdGhlIHNlY29uZCBoYWxmIGRvZXNuJ3QgKCMxMzI2KS5cbiAgICBpZiAoIXRoaXMuX3J1bnRpbWVGaWxlc0NsZWFuZWRVcCkge1xuICAgICAgbGV0IGNsZWFuZWQgPSBmYWxzZTtcbiAgICAgIGZvciAoY29uc3QgZXhjbHVzaW9uIG9mIFJVTlRJTUVfRVhDTFVTSU9OX1BBVEhTKSB7XG4gICAgICAgIGNvbnN0IHJlbW92ZWQgPSBuYXRpdmVSbUNhY2hlZCh0aGlzLmJhc2VQYXRoLCBbZXhjbHVzaW9uXSk7XG4gICAgICAgIGlmIChyZW1vdmVkLmxlbmd0aCA+IDApIGNsZWFuZWQgPSB0cnVlO1xuICAgICAgfVxuICAgICAgaWYgKGNsZWFuZWQpIHtcbiAgICAgICAgbmF0aXZlQ29tbWl0KHRoaXMuYmFzZVBhdGgsIFwiY2hvcmU6IHVudHJhY2sgLmdzZC8gcnVudGltZSBmaWxlcyBmcm9tIGdpdCBpbmRleFwiLCB7IGFsbG93RW1wdHk6IGZhbHNlIH0pO1xuICAgICAgfVxuICAgICAgdGhpcy5fcnVudGltZUZpbGVzQ2xlYW5lZFVwID0gdHJ1ZTtcbiAgICB9XG5cbiAgICAvLyBTdGFnZSBldmVyeXRoaW5nIHVzaW5nIHBhdGhzcGVjIGV4Y2x1c2lvbnMgc28gZXhjbHVkZWQgcGF0aHMgYXJlIG5ldmVyXG4gICAgLy8gaGFzaGVkIGJ5IGdpdC4gVGhlIG9sZCBhcHByb2FjaCBvZiBgZ2l0IGFkZCAtQWAgZm9sbG93ZWQgYnkgdW5zdGFnaW5nXG4gICAgLy8gaGFuZ3MgaW5kZWZpbml0ZWx5IG9uIHJlcG9zIHdpdGggbGFyZ2UgdW50cmFja2VkIGFydGlmYWN0IHRyZWVzICgjMTYwNSkuXG4gICAgLy9cbiAgICAvLyBFeGNsdWRlIG9ubHkgUlVOVElNRSBwYXRocyBmcm9tIHN0YWdpbmcgXHUyMDE0IG5vdCB0aGUgZW50aXJlIC5nc2QvIGRpcmVjdG9yeS5cbiAgICAvLyBXaGVuIC5nc2QvbWlsZXN0b25lcy8gZmlsZXMgYXJlIGFscmVhZHkgdHJhY2tlZCBpbiB0aGUgaW5kZXggKHByb2plY3RzXG4gICAgLy8gd2hlcmUgLmdzZC8gaXMgbm90IGdpdGlnbm9yZWQsIG9yIFdpbmRvd3MganVuY3Rpb25zIHRoYXQgZ2l0IHNlZXMgYXNcbiAgICAvLyByZWFsIGRpcmVjdG9yaWVzKSwgdGhleSBzaG91bGQgY29udGludWUgdG8gYmUgY29tbWl0dGVkLiBFeGNsdWRpbmcgdGhlXG4gICAgLy8gZW50aXJlIC5nc2QvIGRpcmVjdG9yeSBtaWQtbWlsZXN0b25lIGNhdXNlcyBzaWxlbnQgY29tbWl0IGZhaWx1cmUgd2hlcmVcbiAgICAvLyB0aGUgc2Vjb25kIGhhbGYgb2YgYSBtaWxlc3RvbmUncyBhcnRpZmFjdHMgYXJlIG5ldmVyIGNvbW1pdHRlZCAoIzEzMjYpLlxuICAgIC8vXG4gICAgLy8gSWYgLmdzZC8gSVMgaW4gLmdpdGlnbm9yZSAodGhlIGRlZmF1bHQgZm9yIGV4dGVybmFsIHN0YXRlIHByb2plY3RzKSxcbiAgICAvLyBnaXQgYWRkIC1BIGFscmVhZHkgc2tpcHMgaXQgYW5kIHRoZSBleGNsdXNpb25zIGFyZSBoYXJtbGVzcyBuby1vcHMuXG4gICAgY29uc3QgYWxsRXhjbHVzaW9ucyA9IFsuLi5SVU5USU1FX0VYQ0xVU0lPTl9QQVRIUywgLi4uZXh0cmFFeGNsdXNpb25zXTtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCBQYXJhbGxlbCB3b3JrZXIgbWlsZXN0b25lIHNjb3BlICgjMTk5MSkgXHUyNTAwXHUyNTAwXG4gICAgLy8gV2hlbiBHU0RfTUlMRVNUT05FX0xPQ0sgaXMgc2V0LCB0aGlzIHByb2Nlc3MgaXMgYSBwYXJhbGxlbCB3b3JrZXIgdGhhdFxuICAgIC8vIG11c3Qgb25seSBjb21taXQgZmlsZXMgYmVsb25naW5nIHRvIGl0cyBvd24gbWlsZXN0b25lLiBFeGNsdWRlIGFsbCBvdGhlclxuICAgIC8vIG1pbGVzdG9uZSBkaXJlY3RvcmllcyBmcm9tIHN0YWdpbmcgdG8gcHJldmVudCBjcm9zcy1taWxlc3RvbmUgcG9sbHV0aW9uXG4gICAgLy8gKGUuZy4sIGFuIE0wMzMgd29ya2VyIGZhYnJpY2F0aW5nIE0wMzIgYXJ0aWZhY3RzIGluIHRoZSBzYW1lIGNvbW1pdCkuXG4gICAgY29uc3QgbWlsZXN0b25lTG9jayA9IHByb2Nlc3MuZW52LkdTRF9NSUxFU1RPTkVfTE9DSztcbiAgICBpZiAobWlsZXN0b25lTG9jaykge1xuICAgICAgY29uc3QgbXNEaXIgPSBqb2luKGdzZFJvb3QodGhpcy5iYXNlUGF0aCksIFwibWlsZXN0b25lc1wiKTtcbiAgICAgIGlmIChleGlzdHNTeW5jKG1zRGlyKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGVudHJpZXMgPSByZWFkZGlyU3luYyhtc0RpciwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pO1xuICAgICAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgICAgICAgaWYgKGVudHJ5LmlzRGlyZWN0b3J5KCkgJiYgZW50cnkubmFtZSAhPT0gbWlsZXN0b25lTG9jaykge1xuICAgICAgICAgICAgICBhbGxFeGNsdXNpb25zLnB1c2goYC5nc2QvbWlsZXN0b25lcy8ke2VudHJ5Lm5hbWV9L2ApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gQmVzdC1lZmZvcnQgXHUyMDE0IGlmIHdlIGNhbid0IHJlYWQgdGhlIG1pbGVzdG9uZXMgZGlyLCBwcm9jZWVkIHdpdGhvdXQgc2NvcGluZ1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgbmF0aXZlQWRkQWxsV2l0aEV4Y2x1c2lvbnModGhpcy5iYXNlUGF0aCwgYWxsRXhjbHVzaW9ucyk7XG4gIH1cblxuICBwcml2YXRlIHNjb3BlZFN0YWdlVGFza0ZpbGVzKFxuICAgIHRhc2tDb250ZXh0OiBUYXNrQ29tbWl0Q29udGV4dCxcbiAgICBleHRyYUV4Y2x1c2lvbnM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW10sXG4gICk6IGJvb2xlYW4ge1xuICAgIGNvbnN0IGtleUZpbGVzID0gdGFza0NvbnRleHQua2V5RmlsZXMgPz8gW107XG4gICAgaWYgKGtleUZpbGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgY29uc3QgYWxsRXhjbHVzaW9ucyA9IFsuLi5SVU5USU1FX0VYQ0xVU0lPTl9QQVRIUywgLi4uZXh0cmFFeGNsdXNpb25zXTtcbiAgICBjb25zdCBub3JtYWxpemVkID0ga2V5RmlsZXNcbiAgICAgIC5tYXAoZmlsZSA9PiBub3JtYWxpemVSZXBvUmVsYXRpdmVQYXRoKHRoaXMuYmFzZVBhdGgsIGZpbGUpKVxuICAgICAgLmZpbHRlcigoZmlsZSk6IGZpbGUgaXMgc3RyaW5nID0+IGZpbGUgIT09IG51bGwpXG4gICAgICAuZmlsdGVyKGZpbGUgPT4gIW5hdGl2ZUlzSWdub3JlZCh0aGlzLmJhc2VQYXRoLCBmaWxlKSlcbiAgICAgIC5maWx0ZXIoZmlsZSA9PiAhaXNFeGNsdWRlZFNjb3BlZFBhdGgoZmlsZSwgYWxsRXhjbHVzaW9ucykpO1xuXG4gICAgY29uc3Qgc2NvcGVkUGF0aHM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3Qgc3VibW9kdWxlUGF0aHM6IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgcmVwb1N1Ym1vZHVsZXMgPSBzdWJtb2R1bGVQYXRoc0Zyb21Mc0ZpbGVzKFxuICAgICAgcnVuR2l0KHRoaXMuYmFzZVBhdGgsIFtcImxzLWZpbGVzXCIsIFwiLS1zdGFnZVwiXSwgeyBhbGxvd0ZhaWx1cmU6IHRydWUgfSksXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IHBhdGggb2Ygbm9ybWFsaXplZCkge1xuICAgICAgaWYgKGlzSW5zaWRlU3VibW9kdWxlKHBhdGgsIHJlcG9TdWJtb2R1bGVzKSkge1xuICAgICAgICBzdWJtb2R1bGVQYXRocy5wdXNoKHBhdGgpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2NvcGVkUGF0aHMucHVzaChwYXRoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHN1Ym1vZHVsZVBhdGhzLmxlbmd0aCA+IDApIHtcbiAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgIFwiZW5naW5lXCIsXG4gICAgICAgIGBzY29wZWQgc3RhZ2U6IGRyb3BwaW5nICR7c3VibW9kdWxlUGF0aHMubGVuZ3RofSBrZXlGaWxlKHMpIGluc2lkZSBnaXQgc3VibW9kdWxlKHMpOiAke3N1Ym1vZHVsZVBhdGhzLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgICB7IGZpbGU6IFwiZ2l0LXNlcnZpY2UudHNcIiB9LFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBEcm9wIGVudHJpZXMgdGhhdCBkb24ndCBleGlzdCBvbiBkaXNrLiBUaGUgTExNIG9jY2FzaW9uYWxseSBsaXN0cyBmaWxlc1xuICAgIC8vIGl0IGludGVuZGVkIHRvIHdyaXRlIGJ1dCBkaWRuJ3QgKG9yIG5hbWVzIHRoZW0gd2l0aCB3cm9uZyBjYXNpbmcvcGF0aCkuXG4gICAgLy8gUHJlLWBiMzA0ZjczOGJgIGBnaXQgYWRkIC1BYCBzd2FsbG93ZWQgdGhlc2Ugc2lsZW50bHk7IHRoZSBzY29wZWRcbiAgICAvLyBwYXRoc3BlYyBmb3JtIHBhc3NlcyBlYWNoIHBhdGggZXhwbGljaXRseSwgc28gYSBzaW5nbGUgYmFkIGVudHJ5IG1hZGVcbiAgICAvLyB0aGUgd2hvbGUgY29tbWl0IGZhaWwgKHNlZSAjNTUwMCkuIEZpbHRlciBzbyB2YWxpZCBwYXRocyBzdGlsbCBjb21taXQuXG4gICAgY29uc3QgbWlzc2luZzogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBleGlzdGluZzogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHBhdGggb2Ygc2NvcGVkUGF0aHMpIHtcbiAgICAgIGlmIChleGlzdHNTeW5jKGpvaW4odGhpcy5iYXNlUGF0aCwgcGF0aCkpKSB7XG4gICAgICAgIGV4aXN0aW5nLnB1c2gocGF0aCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBtaXNzaW5nLnB1c2gocGF0aCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChtaXNzaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgIFwiZW5naW5lXCIsXG4gICAgICAgIGBzY29wZWQgc3RhZ2U6IGRyb3BwaW5nICR7bWlzc2luZy5sZW5ndGh9IG5vbi1leGlzdGVudCBrZXlGaWxlKHMpIGZyb20gdGFzayBjb21taXQ6ICR7bWlzc2luZy5qb2luKFwiLCBcIil9YCxcbiAgICAgICAgeyBmaWxlOiBcImdpdC1zZXJ2aWNlLnRzXCIgfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgcGF0aHMgPSBBcnJheS5mcm9tKG5ldyBTZXQoZXhpc3RpbmcpKTtcbiAgICBpZiAocGF0aHMubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG5cbiAgICB0cnkge1xuICAgICAgbmF0aXZlQWRkUGF0aHModGhpcy5iYXNlUGF0aCwgcGF0aHMpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBEZWZlbnNlLWluLWRlcHRoOiBldmVuIGFmdGVyIGV4aXN0ZW5jZSBmaWx0ZXJpbmcsIGxpYmdpdDIvZ2l0IGNhblxuICAgICAgLy8gc3RpbGwgcmVqZWN0IHBhdGhzIChnaXRpZ25vcmUgbWF0Y2hlcywgY2FzZS1vbmx5IGRpZmZlcmVuY2VzIG9uXG4gICAgICAvLyBjYXNlLWluc2Vuc2l0aXZlIEZTLCBzdWJtb2R1bGUgYm91bmRhcmllcykuIFJldHVybmluZyBmYWxzZSBsZXRzXG4gICAgICAvLyBhdXRvQ29tbWl0IGZhbGwgdGhyb3VnaCB0byBzbWFydFN0YWdlIHNvIHRoZSBjb21taXQgc3RpbGwgZ29lcyBvdXRcbiAgICAgIC8vIFx1MjAxNCByZXN0b3JpbmcgdGhlIHJlc2lsaWVuY2UgdGhlIHVuc2NvcGVkIHBhdGggdXNlZCB0byBwcm92aWRlLlxuICAgICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgbG9nV2FybmluZyhcbiAgICAgICAgXCJlbmdpbmVcIixcbiAgICAgICAgYHNjb3BlZCBzdGFnZSBmYWlsZWQgKCR7bXNnfSk7IGZhbGxpbmcgYmFjayB0byBzbWFydFN0YWdlYCxcbiAgICAgICAgeyBmaWxlOiBcImdpdC1zZXJ2aWNlLnRzXCIgfSxcbiAgICAgICk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLyoqIFRyYWNrcyB3aGV0aGVyIHJ1bnRpbWUgZmlsZSBjbGVhbnVwIGhhcyBydW4gdGhpcyBzZXNzaW9uLiAqL1xuICBwcml2YXRlIF9ydW50aW1lRmlsZXNDbGVhbmVkVXAgPSBmYWxzZTtcblxuICAvKipcbiAgICogU3RhZ2UgZmlsZXMgKHNtYXJ0IHN0YWdpbmcpIGFuZCBjb21taXQuXG4gICAqIFJldHVybnMgdGhlIGNvbW1pdCBtZXNzYWdlIHN0cmluZyBvbiBzdWNjZXNzLCBvciBudWxsIGlmIG5vdGhpbmcgdG8gY29tbWl0LlxuICAgKiBVc2VzIGBnaXQgY29tbWl0IC1GIC1gIHdpdGggc3RkaW4gcGlwZSBmb3Igc2FmZSBtdWx0aS1saW5lIG1lc3NhZ2UgaGFuZGxpbmcuXG4gICAqL1xuICBjb21taXQob3B0czogQ29tbWl0T3B0aW9ucyk6IHN0cmluZyB8IG51bGwge1xuICAgIHRoaXMuc21hcnRTdGFnZSgpO1xuXG4gICAgLy8gQ2hlY2sgaWYgYW55dGhpbmcgd2FzIGFjdHVhbGx5IHN0YWdlZFxuICAgIGlmICghbmF0aXZlSGFzU3RhZ2VkQ2hhbmdlcyh0aGlzLmJhc2VQYXRoKSAmJiAhb3B0cy5hbGxvd0VtcHR5KSByZXR1cm4gbnVsbDtcblxuICAgIG5hdGl2ZUNvbW1pdCh0aGlzLmJhc2VQYXRoLCBvcHRzLm1lc3NhZ2UsIHsgYWxsb3dFbXB0eTogb3B0cy5hbGxvd0VtcHR5ID8/IGZhbHNlIH0pO1xuICAgIHJldHVybiBvcHRzLm1lc3NhZ2U7XG4gIH1cblxuICAvKipcbiAgICogQXV0by1jb21taXQgZGlydHkgd29ya2luZyB0cmVlLlxuICAgKlxuICAgKiBXaGVuIGB0YXNrQ29udGV4dGAgaXMgcHJvdmlkZWQsIGdlbmVyYXRlcyBhIG1lYW5pbmdmdWwgY29udmVudGlvbmFsIGNvbW1pdFxuICAgKiBtZXNzYWdlIGZyb20gdGhlIHRhc2sgZXhlY3V0aW9uIHJlc3VsdHMgKG9uZS1saW5lciwgdGl0bGUsIGluZmVycmVkIHR5cGUpLlxuICAgKiBGYWxscyBiYWNrIHRvIGEgZ2VuZXJpYyBgY2hvcmUoKWAgbWVzc2FnZSB3aGVuIG5vIGNvbnRleHQgaXMgYXZhaWxhYmxlXG4gICAqIChlLmcuIHByZS1zd2l0Y2ggY29tbWl0cywgc3RvcCBjb21taXRzLCBzdGF0ZSByZWJ1aWxkIGNvbW1pdHMpLlxuICAgKlxuICAgKiBSZXR1cm5zIHRoZSBjb21taXQgbWVzc2FnZSBvbiBzdWNjZXNzLCBvciBudWxsIGlmIG5vdGhpbmcgdG8gY29tbWl0LlxuICAgKiBAcGFyYW0gZXh0cmFFeGNsdXNpb25zIEFkZGl0aW9uYWwgcGF0aHMgdG8gZXhjbHVkZSBmcm9tIHN0YWdpbmcgKGUuZy4gW1wiLmdzZC9cIl0gZm9yIHByZS1zd2l0Y2ggY29tbWl0cykuXG4gICAqL1xuICBhdXRvQ29tbWl0KFxuICAgIHVuaXRUeXBlOiBzdHJpbmcsXG4gICAgdW5pdElkOiBzdHJpbmcsXG4gICAgZXh0cmFFeGNsdXNpb25zOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuICAgIHRhc2tDb250ZXh0PzogVGFza0NvbW1pdENvbnRleHQsXG4gICk6IHN0cmluZyB8IG51bGwge1xuICAgIC8vIFF1aWNrIGNoZWNrOiBpcyB0aGVyZSBhbnl0aGluZyBkaXJ0eSBhdCBhbGw/XG4gICAgLy8gTmF0aXZlIHBhdGggdXNlcyBsaWJnaXQyIChzaW5nbGUgc3lzY2FsbCksIGZhbGxiYWNrIHNwYXducyBnaXQuXG4gICAgaWYgKCFuYXRpdmVIYXNDaGFuZ2VzKHRoaXMuYmFzZVBhdGgpKSByZXR1cm4gbnVsbDtcblxuICAgIGNvbnN0IHNjb3BlZCA9IHRhc2tDb250ZXh0XG4gICAgICA/IHRoaXMuc2NvcGVkU3RhZ2VUYXNrRmlsZXModGFza0NvbnRleHQsIGV4dHJhRXhjbHVzaW9ucylcbiAgICAgIDogZmFsc2U7XG4gICAgaWYgKCFzY29wZWQpIHRoaXMuc21hcnRTdGFnZShleHRyYUV4Y2x1c2lvbnMpO1xuXG4gICAgLy8gQWZ0ZXIgc21hcnQgc3RhZ2luZywgY2hlY2sgaWYgYW55dGhpbmcgd2FzIGFjdHVhbGx5IHN0YWdlZFxuICAgIC8vIChhbGwgY2hhbmdlcyBtaWdodCBoYXZlIGJlZW4gcnVudGltZSBmaWxlcyB0aGF0IGdvdCBleGNsdWRlZClcbiAgICBpZiAoIW5hdGl2ZUhhc1N0YWdlZENoYW5nZXModGhpcy5iYXNlUGF0aCkpIHJldHVybiBudWxsO1xuXG4gICAgY29uc3QgbWVzc2FnZSA9IHRhc2tDb250ZXh0XG4gICAgICA/IGJ1aWxkVGFza0NvbW1pdE1lc3NhZ2UodGFza0NvbnRleHQpXG4gICAgICA6IGBjaG9yZTogYXV0by1jb21taXQgYWZ0ZXIgJHt1bml0VHlwZX1cXG5cXG5HU0QtVW5pdDogJHt1bml0SWR9YDtcbiAgICBuYXRpdmVDb21taXQodGhpcy5iYXNlUGF0aCwgbWVzc2FnZSwgeyBhbGxvd0VtcHR5OiBmYWxzZSB9KTtcblxuICAgIC8vIEFic29yYiBhbnkgcHJlY2VkaW5nIGdzZCBzbmFwc2hvdCBjb21taXRzIGludG8gdGhpcyByZWFsIGNvbW1pdC5cbiAgICAvLyBXYWxrIGJhY2t3YXJkcyBmcm9tIEhFQUR+MSBjb3VudGluZyBjb25zZWN1dGl2ZSBzbmFwc2hvdCBzdWJqZWN0cyxcbiAgICAvLyB0aGVuIHNvZnQtcmVzZXQgdG8gYmVmb3JlIHRoZW0gYW5kIHJlLWNvbW1pdCB3aXRoIHRoZSBzYW1lIG1lc3NhZ2UuXG4gICAgdGhpcy5hYnNvcmJTbmFwc2hvdENvbW1pdHMobWVzc2FnZSk7XG5cbiAgICByZXR1cm4gbWVzc2FnZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTcXVhc2ggY29uc2VjdXRpdmUgYGdzZCBzbmFwc2hvdDpgIGNvbW1pdHMgdGhhdCBzaXQgaW1tZWRpYXRlbHkgYmVsb3dcbiAgICogSEVBRCBpbnRvIHRoZSBjdXJyZW50IEhFQUQgY29tbWl0LiBUaGlzIGtlZXBzIHRoZSBnaXQgaGlzdG9yeSBjbGVhblxuICAgKiBhZnRlciBhdXRvbWF0ZWQgc25hcHNob3QgY29tbWl0cyBhcmUgc3VwZXJzZWRlZCBieSByZWFsIHdvcmsuXG4gICAqXG4gICAqIEd1YXJkczpcbiAgICogLSBPcHQtaW4gdmlhIGBhYnNvcmJfc25hcHNob3RfY29tbWl0c2AgcHJlZmVyZW5jZSAoZGVmYXVsdDogdHJ1ZSkuXG4gICAqIC0gUmVmdXNlcyB0byByZXdyaXRlIGNvbW1pdHMgdGhhdCBoYXZlIGJlZW4gcHVzaGVkIHRvIHRoZSByZW1vdGVcbiAgICogICB0cmFja2luZyBicmFuY2ggKGNoZWNrcyBtZXJnZS1iYXNlIGFuY2VzdHJ5KS5cbiAgICogLSBTYXZlcyBIRUFEIFNIQSBiZWZvcmUgcmVzZXQ7IHJlc3RvcmVzIGl0IGlmIHRoZSByZS1jb21taXQgZmFpbHMuXG4gICAqXG4gICAqIERvZXMgbm90aGluZyBpZiB0aGVyZSBhcmUgbm8gc25hcHNob3QgY29tbWl0cyB0byBhYnNvcmIuXG4gICAqL1xuICBwcml2YXRlIGFic29yYlNuYXBzaG90Q29tbWl0cyhoZWFkTWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gICAgdHJ5IHtcbiAgICAgIC8vIE9wdC1pbiBndWFyZCBcdTIwMTQgdXNlcnMgY2FuIGRpc2FibGUgdG8ga2VlcCBzbmFwc2hvdCBjb21taXRzIGZvciBmb3JlbnNpY3NcbiAgICAgIGlmICh0aGlzLnByZWZzLmFic29yYl9zbmFwc2hvdF9jb21taXRzID09PSBmYWxzZSkgcmV0dXJuO1xuXG4gICAgICBjb25zdCBHU0RfU05BUFNIT1RfUFJFRklYID0gXCJnc2Qgc25hcHNob3Q6XCI7XG4gICAgICBsZXQgY291bnQgPSAwO1xuXG4gICAgICAvLyBXYWxrIGJhY2sgZnJvbSBIRUFEfjEgY291bnRpbmcgY29uc2VjdXRpdmUgc25hcHNob3QgY29tbWl0cyAoY2FwIGF0IDEwKVxuICAgICAgZm9yIChsZXQgaSA9IDE7IGkgPD0gMTA7IGkrKykge1xuICAgICAgICBjb25zdCBzdWJqZWN0ID0gbmF0aXZlQ29tbWl0U3ViamVjdCh0aGlzLmJhc2VQYXRoLCBgSEVBRH4ke2l9YCk7XG4gICAgICAgIGlmICghc3ViamVjdC5zdGFydHNXaXRoKEdTRF9TTkFQU0hPVF9QUkVGSVgpKSBicmVhaztcbiAgICAgICAgY291bnQgPSBpO1xuICAgICAgfVxuXG4gICAgICBpZiAoY291bnQgPT09IDApIHJldHVybjtcblxuICAgICAgLy8gR3VhcmQ6IGRvbid0IHJld3JpdGUgaGlzdG9yeSB0aGF0IGhhcyBiZWVuIHB1c2hlZCB0byB0aGUgcmVtb3RlLlxuICAgICAgLy8gQ2hlY2sgd2hldGhlciB0aGUgbmV3ZXN0IHNuYXBzaG90IGNvbW1pdCAoSEVBRH4xKSBpcyBhbHJlYWR5XG4gICAgICAvLyByZWFjaGFibGUgZnJvbSB0aGUgcmVtb3RlIHRyYWNraW5nIGJyYW5jaC4gSWYgaXQgaXMsIHRoZSBzbmFwc2hvdHNcbiAgICAgIC8vIGhhdmUgYmVlbiBwdXNoZWQgYW5kIG11c3Qgbm90IGJlIHNxdWFzaGVkIHZpYSBsb2NhbCBoaXN0b3J5IHJld3JpdGUuXG4gICAgICAvLyAoQ2hlY2tpbmcgcmVzZXRUYXJnZXQgaW5zdGVhZCB3b3VsZCBmYWxzZS1wb3NpdGl2ZSB3aGVuIHRoZSByZW1vdGVcbiAgICAgIC8vIGlzIGF0IHRoZSBwcmUtc25hcHNob3QgYmFzZSBidXQgdGhlIHNuYXBzaG90cyB0aGVtc2VsdmVzIGFyZSBsb2NhbC4pXG4gICAgICBjb25zdCByZXNldFRhcmdldCA9IGBIRUFEfiR7Y291bnQgKyAxfWA7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBicmFuY2ggPSBuYXRpdmVHZXRDdXJyZW50QnJhbmNoKHRoaXMuYmFzZVBhdGgpO1xuICAgICAgICBpZiAoYnJhbmNoKSB7XG4gICAgICAgICAgY29uc3QgcmVtb3RlQnJhbmNoID0gYG9yaWdpbi8ke2JyYW5jaH1gO1xuICAgICAgICAgIC8vIG1lcmdlLWJhc2UgLS1pcy1hbmNlc3RvciBleGl0cyAwIGlmIEhFQUR+MSBpcyBhbmNlc3RvciBvZiByZW1vdGVcbiAgICAgICAgICBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wibWVyZ2UtYmFzZVwiLCBcIi0taXMtYW5jZXN0b3JcIiwgXCJIRUFEfjFcIiwgcmVtb3RlQnJhbmNoXSwge1xuICAgICAgICAgICAgY3dkOiB0aGlzLmJhc2VQYXRoLFxuICAgICAgICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIC8vIElmIHdlIGdldCBoZXJlLCBuZXdlc3Qgc25hcHNob3QgSVMgcmVhY2hhYmxlIGZyb20gcmVtb3RlIFx1MjAxNCBhbHJlYWR5IHB1c2hlZFxuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIE5vdCBhbiBhbmNlc3RvciBvciByZW1vdGUgZG9lc24ndCBleGlzdCBcdTIwMTQgc2FmZSB0byBwcm9jZWVkXG4gICAgICB9XG5cbiAgICAgIC8vIFNhdmUgSEVBRCBTSEEgc28gd2UgY2FuIHJlc3RvcmUgaWYgdGhlIHJlLWNvbW1pdCBmYWlsc1xuICAgICAgY29uc3Qgc2F2ZWRIZWFkID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBcIkhFQURcIl0sIHtcbiAgICAgICAgY3dkOiB0aGlzLmJhc2VQYXRoLFxuICAgICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgICB9KS50cmltKCk7XG5cbiAgICAgIG5hdGl2ZVJlc2V0U29mdCh0aGlzLmJhc2VQYXRoLCByZXNldFRhcmdldCk7XG5cbiAgICAgIC8vIFJlLXJ1biBzbWFydFN0YWdlIHNvIHRoZSBzYW1lIFJVTlRJTUVfRVhDTFVTSU9OX1BBVEhTIGFwcGx5LlxuICAgICAgLy8gU25hcHNob3QgY29tbWl0cyB1c2VkIG5hdGl2ZUFkZFRyYWNrZWQgKGdpdCBhZGQgLXUpIHdoaWNoIHN0YWdlc1xuICAgICAgLy8gQUxMIHRyYWNrZWQgbW9kaWZpY2F0aW9ucyBpbmNsdWRpbmcgLmdzZC8gc3RhdGUgZmlsZXMuIFdpdGhvdXRcbiAgICAgIC8vIHJlLXN0YWdpbmcsIHRob3NlIC5nc2QvIGNoYW5nZXMgbGVhayBpbnRvIHRoZSBhYnNvcmJlZCBjb21taXQuXG4gICAgICB0aGlzLnNtYXJ0U3RhZ2UoKTtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgbmF0aXZlQ29tbWl0KHRoaXMuYmFzZVBhdGgsIGhlYWRNZXNzYWdlLCB7IGFsbG93RW1wdHk6IGZhbHNlIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFJlLWNvbW1pdCBmYWlsZWQgXHUyMDE0IHJlc3RvcmUgb3JpZ2luYWwgSEVBRCB0byBhdm9pZCBsZWF2aW5nIHRoZVxuICAgICAgICAvLyByZXBvIGluIGEgcGFydGlhbGx5LXJlc2V0IHN0YXRlIHdpdGggbm8gY29tbWl0XG4gICAgICAgIG5hdGl2ZVJlc2V0U29mdCh0aGlzLmJhc2VQYXRoLCBzYXZlZEhlYWQpO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBpZiBzcXVhc2ggZmFpbHMsIHRoZSBjb21taXRzIHJlbWFpbiB1bnNxdWFzaGVkXG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEJyYW5jaCBRdWVyaWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIC8qKlxuICAgKiBHZXQgdGhlIGludGVncmF0aW9uIGJyYW5jaCBmb3IgdGhpcyByZXBvIFx1MjAxNCB0aGUgYnJhbmNoIHRoYXQgc2xpY2VcbiAgICogYnJhbmNoZXMgYXJlIGNyZWF0ZWQgZnJvbSBhbmQgbWVyZ2VkIGJhY2sgaW50by5cbiAgICpcbiAgICogVGhpcyBpcyBvZnRlbiBgbWFpbmAgb3IgYG1hc3RlcmAsIGJ1dCBub3QgbmVjZXNzYXJpbHkuIFdoZW4gYSB1c2VyXG4gICAqIHN0YXJ0cyBHU0Qgb24gYSBmZWF0dXJlIGJyYW5jaCBsaWtlIGBmLTEyMy1uZXctdGhpbmdgLCB0aGF0IGJyYW5jaFxuICAgKiBpcyByZWNvcmRlZCBhcyB0aGUgaW50ZWdyYXRpb24gdGFyZ2V0LCBhbmQgYWxsIHNsaWNlIGJyYW5jaGVzIG1lcmdlXG4gICAqIGJhY2sgaW50byBpdCBcdTIwMTQgbm90IHRoZSByZXBvJ3MgZGVmYXVsdCBicmFuY2guIFRoZSBuYW1lIFwibWFpbiBicmFuY2hcIlxuICAgKiBpbiB2YXJpYWJsZSBuYW1lcyBpcyBoaXN0b3JpY2FsOyB0aGluayBvZiBpdCBhcyBcImludGVncmF0aW9uIGJyYW5jaFwiLlxuICAgKlxuICAgKiBSZXNvbHV0aW9uIG9yZGVyOlxuICAgKiAxLiBFeHBsaWNpdCBgbWFpbl9icmFuY2hgIHByZWZlcmVuY2UgKHVzZXIgb3ZlcnJpZGUsIGhpZ2hlc3QgcHJpb3JpdHkpXG4gICAqIDIuIE1pbGVzdG9uZSBpbnRlZ3JhdGlvbiBicmFuY2ggZnJvbSBtZXRhZGF0YSBmaWxlIChyZWNvcmRlZCBhdCBtaWxlc3RvbmUgc3RhcnQpXG4gICAqIDMuIFdvcmt0cmVlIGJhc2UgYnJhbmNoICh3b3JrdHJlZS88bmFtZT4pXG4gICAqIDQuIG9yaWdpbi9IRUFEIHN5bWJvbGljLXJlZiBcdTIxOTIgbWFpbi9tYXN0ZXIgZmFsbGJhY2sgXHUyMTkyIGN1cnJlbnQgYnJhbmNoXG4gICAqL1xuICBnZXRNYWluQnJhbmNoKCk6IHN0cmluZyB7XG4gICAgLy8gRXhwbGljaXQgcHJlZmVyZW5jZSB0YWtlcyBwcmlvcml0eSAoZG91YmxlLWNoZWNrIHZhbGlkaXR5IGFzIGRlZmVuc2UtaW4tZGVwdGgpXG4gICAgaWYgKHRoaXMucHJlZnMubWFpbl9icmFuY2ggJiYgVkFMSURfQlJBTkNIX05BTUUudGVzdCh0aGlzLnByZWZzLm1haW5fYnJhbmNoKSkge1xuICAgICAgcmV0dXJuIHRoaXMucHJlZnMubWFpbl9icmFuY2g7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgbWlsZXN0b25lIGludGVncmF0aW9uIGJyYW5jaCBcdTIwMTQgcmVjb3JkZWQgd2hlbiBhdXRvLW1vZGUgc3RhcnRzXG4gICAgaWYgKHRoaXMuX21pbGVzdG9uZUlkKSB7XG4gICAgICBjb25zdCByZXNvbHZlZCA9IHJlc29sdmVNaWxlc3RvbmVJbnRlZ3JhdGlvbkJyYW5jaCh0aGlzLmJhc2VQYXRoLCB0aGlzLl9taWxlc3RvbmVJZCk7XG4gICAgICBpZiAocmVzb2x2ZWQuZWZmZWN0aXZlQnJhbmNoKSB7XG4gICAgICAgIHJldHVybiByZXNvbHZlZC5lZmZlY3RpdmVCcmFuY2g7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3Qgd3ROYW1lID0gZGV0ZWN0V29ya3RyZWVOYW1lKHRoaXMuYmFzZVBhdGgpO1xuICAgIGlmICh3dE5hbWUpIHtcbiAgICAgIC8vIEF1dG8tbW9kZSB3b3JrdHJlZXMgdXNlIG1pbGVzdG9uZS88TUlEPiBicmFuY2hlcyAod3ROYW1lID0gbWlsZXN0b25lIElEKVxuICAgICAgY29uc3QgbWlsZXN0b25lQnJhbmNoID0gYG1pbGVzdG9uZS8ke3d0TmFtZX1gO1xuICAgICAgY29uc3QgY3VycmVudEJyYW5jaCA9IG5hdGl2ZUdldEN1cnJlbnRCcmFuY2godGhpcy5iYXNlUGF0aCk7XG5cbiAgICAgIC8vIElmIHdlJ3JlIG9uIGEgbWlsZXN0b25lLzxNSUQ+IGJyYW5jaCwgdXNlIGl0IChhdXRvLW1vZGUgY2FzZSlcbiAgICAgIGlmIChjdXJyZW50QnJhbmNoLnN0YXJ0c1dpdGgoXCJtaWxlc3RvbmUvXCIpKSB7XG4gICAgICAgIHJldHVybiBjdXJyZW50QnJhbmNoO1xuICAgICAgfVxuXG4gICAgICAvLyBPdGhlcndpc2UgY2hlY2sgZm9yIG1hbnVhbCB3b3JrdHJlZSBicmFuY2ggKHdvcmt0cmVlLzxuYW1lPilcbiAgICAgIGNvbnN0IHd0QnJhbmNoID0gYHdvcmt0cmVlLyR7d3ROYW1lfWA7XG4gICAgICBpZiAobmF0aXZlQnJhbmNoRXhpc3RzKHRoaXMuYmFzZVBhdGgsIHd0QnJhbmNoKSkgcmV0dXJuIHd0QnJhbmNoO1xuXG4gICAgICByZXR1cm4gY3VycmVudEJyYW5jaDtcbiAgICB9XG5cbiAgICAvLyBSZXBvLWxldmVsIGRlZmF1bHQgZGV0ZWN0aW9uOiBvcmlnaW4vSEVBRCBcdTIxOTIgbWFpbiBcdTIxOTIgbWFzdGVyIFx1MjE5MiBjdXJyZW50IGJyYW5jaC5cbiAgICAvLyBOYXRpdmUgcGF0aCB1c2VzIGxpYmdpdDIgKHNpbmdsZSBjYWxsKSwgZmFsbGJhY2sgc3Bhd25zIG11bHRpcGxlIGdpdCBwcm9jZXNzZXMuXG4gICAgcmV0dXJuIG5hdGl2ZURldGVjdE1haW5CcmFuY2godGhpcy5iYXNlUGF0aCk7XG4gIH1cblxuICAvKiogR2V0IHRoZSBjdXJyZW50IGJyYW5jaCBuYW1lLiBOYXRpdmUgbGliZ2l0MiB3aGVuIGF2YWlsYWJsZSwgZXhlY1N5bmMgZmFsbGJhY2suICovXG4gIGdldEN1cnJlbnRCcmFuY2goKTogc3RyaW5nIHtcbiAgICByZXR1cm4gbmF0aXZlR2V0Q3VycmVudEJyYW5jaCh0aGlzLmJhc2VQYXRoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGUgYSBzbmFwc2hvdCByZWYgZm9yIHRoZSBnaXZlbiBsYWJlbCAodHlwaWNhbGx5IGEgc2xpY2UgYnJhbmNoIG5hbWUpLlxuICAgKiBFbmFibGVkIGJ5IGRlZmF1bHQ7IG9wdCBvdXQgd2l0aCBwcmVmcy5zbmFwc2hvdHMgPT09IGZhbHNlLlxuICAgKiBSZWYgcGF0aDogcmVmcy9nc2Qvc25hcHNob3RzLzxsYWJlbD4vPHRpbWVzdGFtcD5cbiAgICogVGhlIHJlZiBwb2ludHMgYXQgSEVBRCwgY2FwdHVyaW5nIHRoZSBjdXJyZW50IGNvbW1pdCBiZWZvcmUgZGVzdHJ1Y3RpdmUgb3BlcmF0aW9ucy5cbiAgICovXG4gIGNyZWF0ZVNuYXBzaG90KGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5wcmVmcy5zbmFwc2hvdHMgPT09IGZhbHNlKSByZXR1cm47XG5cbiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuICAgIGNvbnN0IHRzID0gbm93LmdldEZ1bGxZZWFyKCkudG9TdHJpbmcoKVxuICAgICAgKyBTdHJpbmcobm93LmdldE1vbnRoKCkgKyAxKS5wYWRTdGFydCgyLCBcIjBcIilcbiAgICAgICsgU3RyaW5nKG5vdy5nZXREYXRlKCkpLnBhZFN0YXJ0KDIsIFwiMFwiKVxuICAgICAgKyBcIi1cIlxuICAgICAgKyBTdHJpbmcobm93LmdldEhvdXJzKCkpLnBhZFN0YXJ0KDIsIFwiMFwiKVxuICAgICAgKyBTdHJpbmcobm93LmdldE1pbnV0ZXMoKSkucGFkU3RhcnQoMiwgXCIwXCIpXG4gICAgICArIFN0cmluZyhub3cuZ2V0U2Vjb25kcygpKS5wYWRTdGFydCgyLCBcIjBcIik7XG5cbiAgICBjb25zdCByZWZQYXRoID0gYHJlZnMvZ3NkL3NuYXBzaG90cy8ke2xhYmVsfS8ke3RzfWA7XG4gICAgbmF0aXZlVXBkYXRlUmVmKHRoaXMuYmFzZVBhdGgsIHJlZlBhdGgsIFwiSEVBRFwiKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSdW4gcHJlLW1lcmdlIHZlcmlmaWNhdGlvbiBjaGVjay4gQXV0by1kZXRlY3RzIHRlc3QgcnVubmVyIGZyb20gcHJvamVjdFxuICAgKiBmaWxlcywgb3IgdXNlcyBjdXN0b20gY29tbWFuZCBmcm9tIHByZWZzLnByZV9tZXJnZV9jaGVjay5cbiAgICogR2F0ZWQgb24gcHJlZnMucHJlX21lcmdlX2NoZWNrIChmYWxzZSA9IHNraXAsIHN0cmluZyA9IGN1c3RvbSBjb21tYW5kKS5cbiAgICovXG4gIHJ1blByZU1lcmdlQ2hlY2soKTogUHJlTWVyZ2VDaGVja1Jlc3VsdCB7XG4gICAgaWYgKHRoaXMucHJlZnMucHJlX21lcmdlX2NoZWNrID09PSBmYWxzZSkge1xuICAgICAgcmV0dXJuIHsgcGFzc2VkOiB0cnVlLCBza2lwcGVkOiB0cnVlIH07XG4gICAgfVxuXG4gICAgLy8gRGV0ZXJtaW5lIGNvbW1hbmQ6IGV4cGxpY2l0IHN0cmluZyBvciBhdXRvLWRldGVjdCBmcm9tIHBhY2thZ2UuanNvblxuICAgIGxldCBjb21tYW5kOiBzdHJpbmc7XG4gICAgaWYgKHR5cGVvZiB0aGlzLnByZWZzLnByZV9tZXJnZV9jaGVjayA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgY29tbWFuZCA9IHRoaXMucHJlZnMucHJlX21lcmdlX2NoZWNrO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBBdXRvLWRldGVjdDogbG9vayBmb3IgcGFja2FnZS5qc29uIHdpdGggYSB0ZXN0IHNjcmlwdFxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcGtnID0gcmVhZEZpbGVTeW5jKGpvaW4odGhpcy5iYXNlUGF0aCwgXCJwYWNrYWdlLmpzb25cIiksIFwidXRmLThcIik7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocGtnKTtcbiAgICAgICAgaWYgKHBhcnNlZC5zY3JpcHRzPy50ZXN0KSB7XG4gICAgICAgICAgY29tbWFuZCA9IFwibnBtIHRlc3RcIjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4geyBwYXNzZWQ6IHRydWUsIHNraXBwZWQ6IHRydWUgfTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIHJldHVybiB7IHBhc3NlZDogdHJ1ZSwgc2tpcHBlZDogdHJ1ZSB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRva2VuaXplIGFuZCBydW4gdmlhIGV4ZWNGaWxlU3luYyAobm8gc2hlbGwpLiBTaGVsbCBtZXRhY2hhcmFjdGVycyBpblxuICAgIC8vIHVzZXItc3VwcGxpZWQgcHJlZnMucHJlX21lcmdlX2NoZWNrIHdvdWxkIG90aGVyd2lzZSBiZSBpbnRlcnByZXRlZCBhc1xuICAgIC8vIGNoYWluaW5nL3JlZGlyZWN0aW9uIChlLmcuIGA7YCwgYCYmYCwgYHxgLCBiYWNrdGlja3MpIFx1MjAxNCBhIHByaXZlc2NcbiAgICAvLyBzdXJmYWNlIGluIHJlcG9zIHdpdGggYSBjaGVja2VkLWluIGAuZ3NkL1BSRUZFUkVOQ0VTLm1kYC5cbiAgICAvLyAoSXNzdWUgIzQ5ODAgSElHSC0yKVxuICAgIGlmIChjb250YWluc1VucXVvdGVkU2hlbGxDb250cm9sKGNvbW1hbmQpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwYXNzZWQ6IGZhbHNlLFxuICAgICAgICBza2lwcGVkOiBmYWxzZSxcbiAgICAgICAgY29tbWFuZCxcbiAgICAgICAgZXJyb3I6XG4gICAgICAgICAgXCJwcmVfbWVyZ2VfY2hlY2sgY29udGFpbnMgc2hlbGwgbWV0YWNoYXJhY3RlcnMgKDssICYmLCB8LCAkLCBiYWNrdGlja3MsIHJlZGlyZWN0cykuIFwiICtcbiAgICAgICAgICBcIlB1dCBjb21wbGV4IGNvbW1hbmRzIGluIGEgc2NyaXB0IGZpbGUgKGUuZy4gJy4vc2NyaXB0cy9wcmUtbWVyZ2Uuc2gnKSBhbmQgcmVmZXJlbmNlIHRoZSBzY3JpcHQgcGF0aCBpbnN0ZWFkLlwiLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCB0b2tlbnMgPSB0b2tlbml6ZVByZU1lcmdlQ29tbWFuZChjb21tYW5kKTtcbiAgICBpZiAodG9rZW5zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIHsgcGFzc2VkOiB0cnVlLCBza2lwcGVkOiB0cnVlIH07XG4gICAgfVxuXG4gICAgdHJ5IHtcbiAgICAgIGV4ZWNGaWxlU3luYyh0b2tlbnNbMF0hLCB0b2tlbnMuc2xpY2UoMSksIHtcbiAgICAgICAgY3dkOiB0aGlzLmJhc2VQYXRoLFxuICAgICAgICBzdGRpbzogXCJwaXBlXCIsXG4gICAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgICAgIGVudjogR0lUX05PX1BST01QVF9FTlYsXG4gICAgICB9KTtcbiAgICAgIHJldHVybiB7IHBhc3NlZDogdHJ1ZSwgc2tpcHBlZDogZmFsc2UsIGNvbW1hbmQgfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGdldEVycm9yTWVzc2FnZShlcnIpO1xuICAgICAgcmV0dXJuIHsgcGFzc2VkOiBmYWxzZSwgc2tpcHBlZDogZmFsc2UsIGNvbW1hbmQsIGVycm9yOiBtc2cgfTtcbiAgICB9XG4gIH1cblxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgRHJhZnQgUFIgQ3JlYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQ3JlYXRlIGEgZHJhZnQgcHVsbCByZXF1ZXN0IGZvciBhIGNvbXBsZXRlZCBtaWxlc3RvbmUgdXNpbmcgYGdoIHByIGNyZWF0ZWAuXG4gKiBSZXR1cm5zIHRoZSBQUiBVUkwgb24gc3VjY2Vzcywgb3IgbnVsbCBvbiBmYWlsdXJlLlxuICogTm9uLWZhdGFsOiBjYWxsZXJzIHNob3VsZCB0cmVhdCBmYWlsdXJlIGFzIGJlc3QtZWZmb3J0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRHJhZnRQUihcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgdGl0bGU6IHN0cmluZyxcbiAgYm9keTogc3RyaW5nLFxuICBvcHRzPzogeyBoZWFkPzogc3RyaW5nOyBiYXNlPzogc3RyaW5nOyBlbnY/OiBOb2RlSlMuUHJvY2Vzc0VudiB9LFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgYXJncyA9IFtcbiAgICAgIFwicHJcIiwgXCJjcmVhdGVcIiwgXCItLWRyYWZ0XCIsXG4gICAgICBcIi0tdGl0bGVcIiwgdGl0bGUsXG4gICAgICBcIi0tYm9keVwiLCBib2R5LFxuICAgIF07XG4gICAgaWYgKG9wdHM/LmhlYWQpIGFyZ3MucHVzaChcIi0taGVhZFwiLCBvcHRzLmhlYWQpO1xuICAgIGlmIChvcHRzPy5iYXNlKSBhcmdzLnB1c2goXCItLWJhc2VcIiwgb3B0cy5iYXNlKTtcbiAgICBjb25zdCByZXN1bHQgPSBleGVjRmlsZVN5bmMoXCJnaFwiLCBhcmdzLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmOFwiLFxuICAgICAgdGltZW91dDogMzAwMDAsXG4gICAgICBlbnY6IG9wdHM/LmVudiA/PyBHSVRfTk9fUFJPTVBUX0VOVixcbiAgICB9KTtcbiAgICByZXR1cm4gcmVzdWx0LnRyaW0oKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEZhY3RvcnkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBDcmVhdGUgYSBHaXRTZXJ2aWNlSW1wbCB3aXRoIHRoZSBjdXJyZW50IGVmZmVjdGl2ZSBnaXQgcHJlZmVyZW5jZXMuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlR2l0U2VydmljZShiYXNlUGF0aDogc3RyaW5nKTogR2l0U2VydmljZUltcGwge1xuICBjb25zdCBnaXRQcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpPy5wcmVmZXJlbmNlcz8uZ2l0ID8/IHt9O1xuICByZXR1cm4gbmV3IEdpdFNlcnZpY2VJbXBsKGJhc2VQYXRoLCBnaXRQcmVmcyk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkVHVyblNuYXBzaG90TGFiZWwodW5pdFR5cGU6IHN0cmluZywgdW5pdElkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByYXcgPSBgJHt1bml0VHlwZX0vJHt1bml0SWR9YC50cmltKCk7XG4gIGlmICghcmF3KSByZXR1cm4gXCJ0dXJuXCI7XG4gIHJldHVybiByYXdcbiAgICAucmVwbGFjZSgvW15hLXpBLVowLTkuXy8tXS9nLCBcIi1cIilcbiAgICAucmVwbGFjZSgvXFwvezIsfS9nLCBcIi9cIilcbiAgICAucmVwbGFjZSgvLXsyLH0vZywgXCItXCIpXG4gICAgLnJlcGxhY2UoL15bLS9dK3xbLS9dKyQvZywgXCJcIikgfHwgXCJ0dXJuXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBoYW5kbGVUdXJuR2l0QWN0aW9uRXJyb3IoYWN0aW9uOiBUdXJuR2l0QWN0aW9uTW9kZSwgZXJyOiB1bmtub3duKTogVHVybkdpdEFjdGlvblJlc3VsdCB7XG4gIGlmIChpc0luZnJhc3RydWN0dXJlRXJyb3IoZXJyKSkge1xuICAgIHRocm93IGVycjtcbiAgfVxuICByZXR1cm4ge1xuICAgIGFjdGlvbixcbiAgICBzdGF0dXM6IFwiZmFpbGVkXCIsXG4gICAgZXJyb3I6IGdldEVycm9yTWVzc2FnZShlcnIpLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcnVuVHVybkdpdEFjdGlvbihhcmdzOiB7XG4gIGJhc2VQYXRoOiBzdHJpbmc7XG4gIGFjdGlvbjogVHVybkdpdEFjdGlvbk1vZGU7XG4gIHVuaXRUeXBlOiBzdHJpbmc7XG4gIHVuaXRJZDogc3RyaW5nO1xuICB0YXNrQ29udGV4dD86IFRhc2tDb21taXRDb250ZXh0O1xufSk6IFR1cm5HaXRBY3Rpb25SZXN1bHQge1xuICB0cnkge1xuICAgIC8vIEZvcmNlIGZyZXNoIHdvcmtpbmctdHJlZSBzdGF0dXMgcGVyIHR1cm47IG5hdGl2ZUhhc0NoYW5nZXMgY2FjaGVzIGJyaWVmbHkuXG4gICAgX3Jlc2V0SGFzQ2hhbmdlc0NhY2hlKCk7XG4gICAgaWYgKGFyZ3MuYWN0aW9uID09PSBcInN0YXR1cy1vbmx5XCIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogYXJncy5hY3Rpb24sXG4gICAgICAgIHN0YXR1czogXCJva1wiLFxuICAgICAgICBkaXJ0eTogbmF0aXZlSGFzQ2hhbmdlcyhhcmdzLmJhc2VQYXRoKSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3QgZ2l0ID0gY3JlYXRlR2l0U2VydmljZShhcmdzLmJhc2VQYXRoKTtcbiAgICBpZiAoYXJncy5hY3Rpb24gPT09IFwic25hcHNob3RcIikge1xuICAgICAgY29uc3QgbGFiZWwgPSBidWlsZFR1cm5TbmFwc2hvdExhYmVsKGFyZ3MudW5pdFR5cGUsIGFyZ3MudW5pdElkKTtcbiAgICAgIGdpdC5jcmVhdGVTbmFwc2hvdChsYWJlbCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IGFyZ3MuYWN0aW9uLFxuICAgICAgICBzdGF0dXM6IFwib2tcIixcbiAgICAgICAgc25hcHNob3RMYWJlbDogbGFiZWwsXG4gICAgICAgIGRpcnR5OiBuYXRpdmVIYXNDaGFuZ2VzKGFyZ3MuYmFzZVBhdGgpLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBjb21taXRNZXNzYWdlID0gZ2l0LmF1dG9Db21taXQoYXJncy51bml0VHlwZSwgYXJncy51bml0SWQsIFtdLCBhcmdzLnRhc2tDb250ZXh0KSA/PyB1bmRlZmluZWQ7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGlvbjogYXJncy5hY3Rpb24sXG4gICAgICBzdGF0dXM6IFwib2tcIixcbiAgICAgIGNvbW1pdE1lc3NhZ2UsXG4gICAgICBkaXJ0eTogbmF0aXZlSGFzQ2hhbmdlcyhhcmdzLmJhc2VQYXRoKSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4gaGFuZGxlVHVybkdpdEFjdGlvbkVycm9yKGFyZ3MuYWN0aW9uLCBlcnIpO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBDb21taXQgVHlwZSBJbmZlcmVuY2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogSW5mZXIgYSBjb252ZW50aW9uYWwgY29tbWl0IHR5cGUgZnJvbSBhIHRpdGxlIChhbmQgb3B0aW9uYWwgb25lLWxpbmVyKS5cbiAqIFVzZXMgY2FzZS1pbnNlbnNpdGl2ZSB3b3JkLWJvdW5kYXJ5IG1hdGNoaW5nIGFnYWluc3Qga25vd24ga2V5d29yZHMuXG4gKiBSZXR1cm5zIFwiZmVhdFwiIHdoZW4gbm8ga2V5d29yZHMgbWF0Y2guXG4gKlxuICogVXNlZCBmb3IgYm90aCBzbGljZSBzcXVhc2gtbWVyZ2UgdGl0bGVzIGFuZCB0YXNrIGNvbW1pdCBtZXNzYWdlcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGluZmVyQ29tbWl0VHlwZSh0aXRsZTogc3RyaW5nLCBvbmVMaW5lcj86IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGxvd2VyID0gYCR7dGl0bGV9ICR7b25lTGluZXIgfHwgXCJcIn1gLnRvTG93ZXJDYXNlKCk7XG5cbiAgZm9yIChjb25zdCBba2V5d29yZHMsIGNvbW1pdFR5cGVdIG9mIENPTU1JVF9UWVBFX1JVTEVTKSB7XG4gICAgZm9yIChjb25zdCBrZXl3b3JkIG9mIGtleXdvcmRzKSB7XG4gICAgICAvLyBcImNsZWFuIHVwXCIgaXMgbXVsdGktd29yZCBcdTIwMTQgdXNlIGluZGV4T2YgZm9yIGl0XG4gICAgICBpZiAoa2V5d29yZC5pbmNsdWRlcyhcIiBcIikpIHtcbiAgICAgICAgaWYgKGxvd2VyLmluY2x1ZGVzKGtleXdvcmQpKSByZXR1cm4gY29tbWl0VHlwZTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFdvcmQgYm91bmRhcnkgbWF0Y2g6IGtleXdvcmQgbXVzdCBub3QgYmUgc3Vycm91bmRlZCBieSB3b3JkIGNoYXJzXG4gICAgICAgIGNvbnN0IHJlID0gbmV3IFJlZ0V4cChgXFxcXGIke2tleXdvcmR9XFxcXGJgLCBcImlcIik7XG4gICAgICAgIGlmIChyZS50ZXN0KGxvd2VyKSkgcmV0dXJuIGNvbW1pdFR5cGU7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIFwiZmVhdFwiO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBWUEsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyxZQUFZLFdBQVcsY0FBYyxhQUFhLHFCQUFxQjtBQUNoRixTQUFTLFlBQVksTUFBTSxXQUFXLFVBQVUsU0FBUyxXQUFXO0FBQ3BFLFNBQVMsZUFBZTtBQUN4QixTQUFTLHlCQUF5QjtBQUNsQyxTQUFTLG1DQUFtQztBQUM1QyxTQUFTLGtCQUFrQjtBQUczQjtBQUFBLEVBQ0U7QUFBQSxPQUNLO0FBQ1AsU0FBUyxpQkFBaUIsaUJBQWlCLDBCQUEwQjtBQUNyRTtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsVUFBVSxvQkFBb0IscUJBQXFCO0FBQzVELFNBQVMsdUJBQXVCO0FBQ2hDLFNBQVMsNkJBQTZCO0FBa0UvQixNQUFNLG9CQUFvQjtBQStDMUIsU0FBUyx1QkFBdUIsS0FBZ0M7QUFDckUsUUFBTSxjQUFjLGlDQUFpQyxJQUFJLFlBQVksSUFBSSxTQUFTO0FBQ2xGLFFBQU0sT0FBTyxnQkFBZ0IsSUFBSSxXQUFXLElBQUksUUFBUTtBQUd4RCxRQUFNLGFBQWEsS0FBSyxLQUFLO0FBQzdCLFFBQU0sWUFBWSxZQUFZLFNBQVMsYUFDbkMsWUFBWSxNQUFNLEdBQUcsYUFBYSxDQUFDLEVBQUUsUUFBUSxJQUFJLFdBQ2pEO0FBRUosUUFBTSxVQUFVLEdBQUcsSUFBSSxLQUFLLFNBQVM7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QUNyRyxNQUFJLHNCQUFzQixHQUFHLEdBQUc7QUFDOUIsVUFBTTtBQUFBLEVBQ1I7QUFDQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsUUFBUTtBQUFBLElBQ1IsT0FBTyxnQkFBZ0IsR0FBRztBQUFBLEVBQzVCO0FBQ0Y7QUFFTyxTQUFTLGlCQUFpQixNQU1UO0FBQ3RCLE1BQUk7QUFFRiwwQkFBc0I7QUFDdEIsUUFBSSxLQUFLLFdBQVcsZUFBZTtBQUNqQyxhQUFPO0FBQUEsUUFDTCxRQUFRLEtBQUs7QUFBQSxRQUNiLFFBQVE7QUFBQSxRQUNSLE9BQU8saUJBQWlCLEtBQUssUUFBUTtBQUFBLE1BQ3ZDO0FBQUEsSUFDRjtBQUVBLFVBQU0sTUFBTSxpQkFBaUIsS0FBSyxRQUFRO0FBQzFDLFFBQUksS0FBSyxXQUFXLFlBQVk7QUFDOUIsWUFBTSxRQUFRLHVCQUF1QixLQUFLLFVBQVUsS0FBSyxNQUFNO0FBQy9ELFVBQUksZUFBZSxLQUFLO0FBQ3hCLGFBQU87QUFBQSxRQUNMLFFBQVEsS0FBSztBQUFBLFFBQ2IsUUFBUTtBQUFBLFFBQ1IsZUFBZTtBQUFBLFFBQ2YsT0FBTyxpQkFBaUIsS0FBSyxRQUFRO0FBQUEsTUFDdkM7QUFBQSxJQUNGO0FBRUEsVUFBTSxnQkFBZ0IsSUFBSSxXQUFXLEtBQUssVUFBVSxLQUFLLFFBQVEsQ0FBQyxHQUFHLEtBQUssV0FBVyxLQUFLO0FBQzFGLFdBQU87QUFBQSxNQUNMLFFBQVEsS0FBSztBQUFBLE1BQ2IsUUFBUTtBQUFBLE1BQ1I7QUFBQSxNQUNBLE9BQU8saUJBQWlCLEtBQUssUUFBUTtBQUFBLElBQ3ZDO0FBQUEsRUFDRixTQUFTLEtBQUs7QUFDWixXQUFPLHlCQUF5QixLQUFLLFFBQVEsR0FBRztBQUFBLEVBQ2xEO0FBQ0Y7QUFXTyxTQUFTLGdCQUFnQixPQUFlLFVBQTJCO0FBQ3hFLFFBQU0sUUFBUSxHQUFHLEtBQUssSUFBSSxZQUFZLEVBQUUsR0FBRyxZQUFZO0FBRXZELGFBQVcsQ0FBQyxVQUFVLFVBQVUsS0FBSyxtQkFBbUI7QUFDdEQsZUFBVyxXQUFXLFVBQVU7QUFFOUIsVUFBSSxRQUFRLFNBQVMsR0FBRyxHQUFHO0FBQ3pCLFlBQUksTUFBTSxTQUFTLE9BQU8sRUFBRyxRQUFPO0FBQUEsTUFDdEMsT0FBTztBQUVMLGNBQU0sS0FBSyxJQUFJLE9BQU8sTUFBTSxPQUFPLE9BQU8sR0FBRztBQUM3QyxZQUFJLEdBQUcsS0FBSyxLQUFLLEVBQUcsUUFBTztBQUFBLE1BQzdCO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQ1Q7IiwKICAibmFtZXMiOiBbIlFVSUNLX0JSQU5DSF9SRSIsICJXT1JLRkxPV19CUkFOQ0hfUkUiXQp9Cg==
