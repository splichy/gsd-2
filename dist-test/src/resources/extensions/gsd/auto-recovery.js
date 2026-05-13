import { parseUnitId } from "./unit-id.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import { appendEvent } from "./workflow-events.js";
import { atomicWriteSync } from "./atomic-write.js";
import { clearParseCache } from "./files.js";
import { parseRoadmap as parseLegacyRoadmap, parsePlan as parseLegacyPlan } from "./parsers-legacy.js";
import { isDbAvailable, getTask, getSlice, getSliceTasks, getPendingGates, updateTaskStatus, updateSliceStatus, insertSlice, getMilestone, refreshOpenDatabaseFromDisk, getCompletedMilestoneTaskFileHints, getMilestoneCommitAttributionShas, recordMilestoneCommitAttribution } from "./gsd-db.js";
import { isValidationTerminal } from "./state.js";
import { getErrorMessage } from "./error-utils.js";
import { logWarning, logError } from "./workflow-logger.js";
import { readIntegrationBranch } from "./git-service.js";
import { isClosedStatus } from "./status-guards.js";
import {
  resolveSlicePath,
  resolveSliceFile,
  resolveTasksDir,
  resolveTaskFiles,
  relMilestoneFile,
  relSliceFile,
  buildSliceFileName,
  resolveMilestoneFile,
  clearPathCache,
  resolveGsdRootFile
} from "./paths.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import {
  resolveExpectedArtifactPath,
  diagnoseExpectedArtifact
} from "./auto-artifact-paths.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import { validateArtifact } from "./schemas/validate.js";
import { getProjectResearchStatus } from "./project-research-policy.js";
import { isGsdWorktreePath } from "./worktree-root.js";
import {
  classifyMilestoneSummaryContent as classifyMilestoneSummaryContent2
} from "./milestone-summary-classifier.js";
function diagnoseWorktreeIntegrityFailure(basePath) {
  if (!isGsdWorktreePath(basePath)) return null;
  if (!existsSync(basePath)) {
    return `Worktree integrity failure: ${basePath} does not exist. Repair or recreate the worktree before retrying.`;
  }
  const gitPath = join(basePath, ".git");
  if (!existsSync(gitPath)) {
    return `Worktree integrity failure: ${basePath} is not a valid git worktree (.git missing). Repair or recreate the worktree before retrying.`;
  }
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    });
    return null;
  } catch (err) {
    return `Worktree integrity failure: ${basePath} is not a valid git worktree (git rev-parse failed: ${getErrorMessage(err).split("\n")[0]}). Repair or recreate the worktree before retrying.`;
  }
}
function refreshRecoveryDbForArtifact(unitType, unitId) {
  if (unitType !== "plan-slice" && unitType !== "execute-task") return { ok: true };
  if (!isDbAvailable()) return { ok: true };
  if (!refreshOpenDatabaseFromDisk()) {
    return {
      ok: false,
      fatal: unitType === "execute-task",
      reason: `${unitType}-db-refresh-failed`,
      message: `Stuck recovery found ${unitType} ${unitId} artifacts, but the DB refresh failed.`
    };
  }
  if (unitType !== "execute-task") return { ok: true };
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  if (!mid || !sid || !tid) {
    return {
      ok: false,
      fatal: true,
      reason: "execute-task-invalid-unit-id",
      message: `Stuck recovery found execute-task ${unitId} artifacts, but the unit id could not be parsed for DB verification.`
    };
  }
  const task = getTask(mid, sid, tid);
  if (!task) {
    return {
      ok: false,
      fatal: true,
      reason: "execute-task-artifact-db-missing",
      message: `Stuck recovery found execute-task ${unitId} artifacts, but no matching DB task row exists after refresh.`
    };
  }
  if (!isClosedStatus(task.status)) {
    return {
      ok: false,
      fatal: true,
      reason: "execute-task-artifact-db-mismatch",
      message: `Stuck recovery found execute-task ${unitId} artifacts, but the DB task status is still '${task.status}' after refresh.`
    };
  }
  return { ok: true };
}
function hasCapturedWorkflowPrefs(base) {
  const prefsPath = resolveExpectedArtifactPath("workflow-preferences", "WORKFLOW-PREFS", base);
  if (!prefsPath || !existsSync(prefsPath)) return false;
  const content = readFileSync(prefsPath, "utf-8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!match && /^workflow_prefs_captured:\s*true\s*$/m.test(match[1]);
}
function hasValidResearchDecision(base) {
  const decisionPath = resolveExpectedArtifactPath("research-decision", "RESEARCH-DECISION", base);
  if (!decisionPath || !existsSync(decisionPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(decisionPath, "utf-8"));
    return cfg.decision === "research" || cfg.decision === "skip";
  } catch {
    return false;
  }
}
function hasCompleteProjectResearch(base) {
  return getProjectResearchStatus(base).complete;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hasCheckedTaskCompletionOnDisk(base, mid, sid, tid) {
  const tasksDir = resolveTasksDir(base, mid, sid);
  if (!tasksDir) return false;
  if (!existsSync(join(tasksDir, `${tid}-SUMMARY.md`))) return false;
  const planAbs = resolveSliceFile(base, mid, sid, "PLAN");
  if (!planAbs || !existsSync(planAbs)) return false;
  const planContent = readFileSync(planAbs, "utf-8");
  const cbRe = new RegExp(`^\\s*-\\s+\\[[xX]\\]\\s+\\*\\*${escapeRegExp(tid)}:`, "m");
  return cbRe.test(planContent);
}
function hasImplementationArtifacts(basePath, milestoneId) {
  try {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8"
      });
    } catch (e) {
      logWarning("recovery", `git rev-parse check failed: ${e.message}`);
      return "unknown";
    }
    const integrationBranch = milestoneId ? readIntegrationBranch(basePath, milestoneId) ?? detectMainBranch(basePath) : detectMainBranch(basePath);
    const currentBranch = getCurrentBranch(basePath);
    const branchDiff = getChangedFilesSinceBranch(basePath, integrationBranch);
    if (!branchDiff.ok) return "unknown";
    const changedFiles = branchDiff.files;
    if (changedFiles.length === 0) {
      if (milestoneId && currentBranch === integrationBranch) {
        const milestoneEvidence = getChangedFilesFromMilestoneEvidence(basePath, milestoneId);
        if (!milestoneEvidence.ok) return "unknown";
        if (milestoneEvidence.matched) return classifyImplementationFiles(milestoneEvidence.files);
      }
      if (currentBranch && currentBranch !== "HEAD") return "absent";
      return "unknown";
    }
    const branchClassification = classifyImplementationFiles(changedFiles);
    if (branchClassification === "present") return "present";
    if (milestoneId) {
      const milestoneEvidence = getChangedFilesFromMilestoneEvidence(basePath, milestoneId);
      if (!milestoneEvidence.ok) return "unknown";
      if (milestoneEvidence.matched) return classifyImplementationFiles(milestoneEvidence.files);
    }
    return "absent";
  } catch (e) {
    logWarning("recovery", `implementation artifact check failed: ${e.message}`);
    return "unknown";
  }
}
function getCurrentBranch(basePath) {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}
function classifyImplementationFiles(files) {
  const implFiles = files.filter(isImplementationPath);
  return implFiles.length > 0 ? "present" : "absent";
}
function isImplementationPath(file) {
  return !file.startsWith(".gsd/") && !file.startsWith(".gsd\\");
}
function normalizeRepoPath(file) {
  return file.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}
function detectMainBranch(basePath) {
  try {
    const result = execFileSync("git", ["rev-parse", "--verify", "main"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    });
    if (result.trim()) return "main";
  } catch (_) {
    void _;
  }
  try {
    const result = execFileSync("git", ["rev-parse", "--verify", "master"], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    });
    if (result.trim()) return "master";
  } catch (_) {
    void _;
  }
  logWarning("recovery", "neither main nor master branch found, defaulting to main");
  return "main";
}
function getChangedFilesSinceBranch(basePath, targetBranch) {
  try {
    const mergeBase = execFileSync(
      "git",
      ["merge-base", targetBranch, "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
    ).trim();
    if (mergeBase) {
      const result = execFileSync(
        "git",
        ["diff", "--name-only", mergeBase, "HEAD"],
        { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
      ).trim();
      return { ok: true, files: result ? result.split("\n").filter(Boolean) : [] };
    }
  } catch (err) {
    logWarning("recovery", `merge-base detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const result = execFileSync(
      "git",
      ["log", "--name-only", "--pretty=format:", "-20", "HEAD"],
      { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
    ).trim();
    return { ok: true, files: result ? [...new Set(result.split("\n").filter(Boolean))] : [] };
  } catch (e) {
    logWarning("recovery", `git log fallback failed: ${e.message}`);
    return { ok: false, files: [] };
  }
}
function getChangedFilesFromMilestoneTaggedCommits(basePath, milestoneId) {
  const scoped = scanGsdTaggedCommits(basePath, milestoneId, [
    "log",
    "--format=%H%x1f%B%x1e",
    "HEAD",
    "--",
    `.gsd/milestones/${milestoneId}`
  ]);
  if (!scoped.ok) return scoped;
  if (scoped.matched && classifyImplementationFiles(scoped.files) === "present") return scoped;
  const unscoped = scanGsdTaggedCommits(basePath, milestoneId, [
    "log",
    "--format=%H%x1f%B%x1e",
    "HEAD"
  ]);
  if (!unscoped.ok) return scoped.matched ? scoped : unscoped;
  if (!unscoped.matched) return scoped;
  return {
    ok: true,
    matched: true,
    files: [.../* @__PURE__ */ new Set([...scoped.files, ...unscoped.files])]
  };
}
function getChangedFilesFromMilestoneEvidence(basePath, milestoneId) {
  const tagged = getChangedFilesFromMilestoneTaggedCommits(basePath, milestoneId);
  if (!tagged.ok) return tagged;
  if (tagged.matched && classifyImplementationFiles(tagged.files) === "present") return tagged;
  const attributed = getChangedFilesFromAttributedMilestoneCommits(basePath, milestoneId);
  if (!attributed.ok) return tagged.matched ? tagged : attributed;
  if (attributed.matched && classifyImplementationFiles(attributed.files) === "present") return attributed;
  const backfilled = backfillChangedFilesFromUntaggedMilestoneCommits(basePath, milestoneId);
  if (!backfilled.ok) return tagged.matched ? tagged : attributed.matched ? attributed : backfilled;
  if (!backfilled.matched) {
    if (tagged.matched) return tagged;
    return attributed.matched ? attributed : backfilled;
  }
  return {
    ok: true,
    matched: true,
    files: [.../* @__PURE__ */ new Set([...tagged.files, ...attributed.files, ...backfilled.files])]
  };
}
function getChangedFilesFromAttributedMilestoneCommits(basePath, milestoneId) {
  try {
    const shas = getMilestoneCommitAttributionShas(milestoneId);
    if (shas.length === 0) return { ok: true, matched: false, files: [] };
    const files = /* @__PURE__ */ new Set();
    let matched = false;
    for (const sha of shas) {
      if (!isFullCommitSha(sha)) continue;
      const commitFiles = getChangedFilesForCommit(basePath, sha);
      if (commitFiles.length === 0) continue;
      matched = true;
      for (const file of commitFiles) files.add(file);
    }
    return { ok: true, matched, files: [...files] };
  } catch (e) {
    logWarning("recovery", `milestone attribution scan failed: ${e.message}`);
    return { ok: false, matched: false, files: [] };
  }
}
function backfillChangedFilesFromUntaggedMilestoneCommits(basePath, milestoneId) {
  try {
    const milestone = getMilestone(milestoneId);
    const milestoneStartedAt = milestone?.created_at ? Math.floor(Date.parse(milestone.created_at) / 1e3) * 1e3 : NaN;
    if (!Number.isFinite(milestoneStartedAt)) return { ok: true, matched: false, files: [] };
    const taskFileHints = getCompletedMilestoneTaskFileHints(milestoneId);
    if (taskFileHints.length === 0) return { ok: true, matched: false, files: [] };
    const hintSet = new Set(taskFileHints.map(normalizeRepoPath).filter(Boolean));
    if (hintSet.size === 0) return { ok: true, matched: false, files: [] };
    const records = getCommitRecords(basePath);
    const files = /* @__PURE__ */ new Set();
    let matched = false;
    for (const record of records) {
      if (!isFullCommitSha(record.hash)) continue;
      if (Date.parse(record.committedAt) < milestoneStartedAt) continue;
      if (record.parents.trim().split(/\s+/).filter(Boolean).length > 1) continue;
      if (commitMessageHasGsdTrailer(record.message)) continue;
      const commitFiles = getChangedFilesForCommit(basePath, record.hash);
      const implementationFiles = commitFiles.map(normalizeRepoPath).filter(isImplementationPath);
      if (implementationFiles.length === 0) continue;
      if (!implementationFiles.some((file) => hintSet.has(file))) continue;
      matched = true;
      for (const file of implementationFiles) files.add(file);
      recordMilestoneCommitAttribution({
        commitSha: record.hash,
        milestoneId,
        source: "backfill",
        confidence: 0.8,
        files: implementationFiles,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    return { ok: true, matched, files: [...files] };
  } catch (e) {
    logWarning("recovery", `milestone attribution backfill failed: ${e.message}`);
    return { ok: false, matched: false, files: [] };
  }
}
function getCommitRecords(basePath) {
  const logOutput = execFileSync("git", ["log", "--format=%H%x1f%P%x1f%cI%x1f%B%x1e", "HEAD"], {
    cwd: basePath,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8"
  });
  return logOutput.split("").map((record) => record.trim()).filter(Boolean).flatMap((record) => {
    const parts = record.split("");
    if (parts.length < 4) return [];
    const [hash, parents, committedAt, ...messageParts] = parts;
    return [{ hash: hash.trim(), parents: parents.trim(), committedAt: committedAt.trim(), message: messageParts.join("") }];
  });
}
function isFullCommitSha(value) {
  return /^[0-9a-f]{40}$/i.test(value);
}
function scanGsdTaggedCommits(basePath, milestoneId, gitArgs) {
  try {
    const logOutput = execFileSync("git", [...gitArgs], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8"
    });
    const records = logOutput.split("").map((record) => record.trim()).filter(Boolean).flatMap((record) => {
      const sep = record.indexOf("");
      if (sep === -1) return [];
      const hash = record.slice(0, sep).trim();
      const message = record.slice(sep + 1);
      return [{ hash, message }];
    });
    const files = /* @__PURE__ */ new Set();
    let matched = false;
    for (const { hash, message } of records) {
      if (!commitMessageHasGsdTrailer(message)) continue;
      const commitFiles = getChangedFilesForCommit(basePath, hash);
      if (!commitMatchesMilestone(basePath, message, milestoneId, commitFiles)) continue;
      matched = true;
      for (const file of commitFiles) {
        files.add(file);
      }
    }
    return { ok: true, matched, files: [...files] };
  } catch (e) {
    logWarning("recovery", `milestone-tagged commit scan failed: ${e.message}`);
    return { ok: false, matched: false, files: [] };
  }
}
function getChangedFilesForCommit(basePath, hash) {
  const fileOutput = execFileSync(
    "git",
    ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", hash],
    { cwd: basePath, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }
  ).trim();
  return fileOutput.split("\n").map((f) => f.trim()).filter(Boolean);
}
function commitMessageHasGsdTrailer(message) {
  return /^GSD-(?:Task|Unit):\s*\S+/m.test(message);
}
function commitMatchesMilestone(basePath, message, milestoneId, files) {
  if (commitTrailerStartsWithMilestone(message, milestoneId)) return true;
  if (/^GSD-Task:\s*S[^/\s]+\/T\S+/m.test(message)) {
    if (files.some((file) => isMilestoneArtifactPath(file, milestoneId))) return true;
    if (commitMessageMentionsMilestone(message, milestoneId)) return true;
    if (commitTaskTrailerBelongsToMilestone(basePath, message, milestoneId)) return true;
  }
  return false;
}
function commitTaskTrailerBelongsToMilestone(basePath, message, milestoneId) {
  const match = message.match(/^GSD-Task:\s*(S[^/\s]+)\/(T[^\s]+)/m);
  if (!match) return false;
  const [, sliceId, taskId] = match;
  if (getTask(milestoneId, sliceId, taskId)) return true;
  const tasksDir = resolveTasksDir(basePath, milestoneId, sliceId);
  if (!tasksDir) return false;
  return existsSync(join(tasksDir, `${taskId}-PLAN.md`)) || existsSync(join(tasksDir, `${taskId}-SUMMARY.md`));
}
function commitMessageMentionsMilestone(message, milestoneId) {
  if (!MILESTONE_ID_RE.test(milestoneId)) return false;
  const escapedMilestone = milestoneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escapedMilestone}\\b`).test(message);
}
function commitTrailerStartsWithMilestone(message, milestoneId) {
  const escapedMilestone = milestoneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailerPattern = new RegExp(
    `^GSD-(?:Task|Unit):\\s*${escapedMilestone}(?:$|[\\s/])`,
    "m"
  );
  return trailerPattern.test(message);
}
function isMilestoneArtifactPath(file, milestoneId) {
  return file.startsWith(`.gsd/milestones/${milestoneId}/`) || file.startsWith(`.gsd\\milestones\\${milestoneId}\\`);
}
function verifyExpectedArtifact(unitType, unitId, base) {
  if (unitType.startsWith("hook/")) return true;
  clearPathCache();
  clearParseCache();
  if (unitType === "rewrite-docs") {
    const overridesPath = resolveGsdRootFile(base, "OVERRIDES");
    if (!existsSync(overridesPath)) return true;
    const content = readFileSync(overridesPath, "utf-8");
    return !content.includes("**Scope:** active");
  }
  if (unitType === "workflow-preferences") {
    return hasCapturedWorkflowPrefs(base);
  }
  if (unitType === "discuss-project") {
    const projectPath = resolveExpectedArtifactPath(unitType, unitId, base);
    return !!projectPath && existsSync(projectPath) && validateArtifact(projectPath, "project").ok;
  }
  if (unitType === "discuss-requirements") {
    const requirementsPath = resolveExpectedArtifactPath(unitType, unitId, base);
    return !!requirementsPath && existsSync(requirementsPath) && validateArtifact(requirementsPath, "requirements").ok;
  }
  if (unitType === "research-decision") {
    return hasValidResearchDecision(base);
  }
  if (unitType === "research-project") {
    return hasCompleteProjectResearch(base);
  }
  if (unitType === "reactive-execute") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;
    const plusIdx = batchPart.indexOf("+");
    if (plusIdx === -1) {
      const tDir2 = resolveTasksDir(base, mid, sid);
      if (!tDir2) return false;
      const summaryFiles = resolveTaskFiles(tDir2, "SUMMARY");
      return summaryFiles.length > 0;
    }
    const batchIds = batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (batchIds.length === 0) return false;
    const tDir = resolveTasksDir(base, mid, sid);
    if (!tDir) return false;
    const existingSummaries = new Set(
      resolveTaskFiles(tDir, "SUMMARY").map(
        (f) => f.replace(/-SUMMARY\.md$/i, "").toUpperCase()
      )
    );
    for (const tid of batchIds) {
      if (!existingSummaries.has(tid.toUpperCase())) return false;
    }
    return true;
  }
  if (unitType === "gate-evaluate") {
    const { milestone: mid, slice: sid, task: batchPart } = parseUnitId(unitId);
    if (!mid || !sid || !batchPart) return false;
    const plusIdx = batchPart.indexOf("+");
    if (plusIdx === -1) return true;
    const gateIds = batchPart.slice(plusIdx + 1).split(",").filter(Boolean);
    if (gateIds.length === 0) return true;
    try {
      const pending = getPendingGates(mid, sid, "slice");
      const pendingIds = new Set(pending.map((g) => g.gate_id));
      for (const gid of gateIds) {
        if (pendingIds.has(gid)) return false;
      }
    } catch (err) {
      logWarning("recovery", `gate-evaluate DB check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }
  if (unitType === "research-slice" && unitId.endsWith("/parallel-research")) {
    const { milestone: mid } = parseUnitId(unitId);
    if (!mid) return false;
    const blockerPath = resolveExpectedArtifactPath(unitType, unitId, base);
    if (blockerPath && existsSync(blockerPath)) {
      return true;
    }
    const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
    if (!roadmapFile || !existsSync(roadmapFile)) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: roadmap missing`);
      return false;
    }
    try {
      const roadmap = parseLegacyRoadmap(readFileSync(roadmapFile, "utf-8"));
      const milestoneResearchFile = resolveMilestoneFile(base, mid, "RESEARCH");
      for (const slice of roadmap.slices) {
        if (slice.done) continue;
        if (milestoneResearchFile && slice.id === "S01") continue;
        const depsComplete = (slice.depends ?? []).every(
          (depId) => !!resolveSliceFile(base, mid, depId, "SUMMARY")
        );
        if (!depsComplete) continue;
        if (!resolveSliceFile(base, mid, slice.id, "RESEARCH")) {
          logWarning("recovery", `verify-fail ${unitType} ${unitId}: slice ${slice.id} missing RESEARCH`);
          return false;
        }
      }
      return true;
    } catch (err) {
      logWarning("recovery", `parallel-research verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  const absPath = resolveExpectedArtifactPath(unitType, unitId, base);
  if (!absPath) {
    logWarning("recovery", `verify-fail ${unitType} ${unitId}: resolveExpectedArtifactPath returned null (parent dir missing)`);
    return false;
  }
  if (!existsSync(absPath)) {
    const worktreeFailure = diagnoseWorktreeIntegrityFailure(base);
    if (worktreeFailure) {
      logError("recovery", `${worktreeFailure} Unit: ${unitType} ${unitId}.`);
      return false;
    }
    logWarning("recovery", `verify-fail ${unitType} ${unitId}: existsSync false for ${absPath}`);
    return false;
  }
  if (unitType === "validate-milestone") {
    const validationContent = readFileSync(absPath, "utf-8");
    if (!isValidationTerminal(validationContent)) {
      logWarning("recovery", `verify-fail ${unitType} ${unitId}: validation not terminal (len=${validationContent.length}) at ${absPath}`);
      return false;
    }
  }
  if (unitType === "plan-milestone") {
    try {
      const roadmap = parseLegacyRoadmap(readFileSync(absPath, "utf-8"));
      if (roadmap.slices.length === 0) {
        logWarning("recovery", `verify-fail ${unitType} ${unitId}: roadmap has zero slices at ${absPath}`);
        return false;
      }
    } catch (err) {
      logWarning("recovery", `plan-milestone roadmap verification failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  if (unitType === "plan-slice") {
    const { milestone: mid, slice: sid } = parseUnitId(unitId);
    if (mid && sid) {
      try {
        let taskIds = null;
        if (isDbAvailable()) {
          const refreshed = refreshOpenDatabaseFromDisk();
          if (refreshed) {
            const tasks = getSliceTasks(mid, sid);
            if (tasks.length > 0) taskIds = tasks.map((t) => t.id);
          }
        }
        if (!taskIds) {
          const planContent = readFileSync(absPath, "utf-8");
          const hasCheckboxTask = /^\s*- \[[xX ]\] \*\*T\d+:/m.test(planContent);
          const hasHeadingTask = /^\s*#{2,4}\s+T\d+\s*(?:--|—|:)/m.test(planContent);
          if (!hasCheckboxTask && !hasHeadingTask) {
            logWarning("recovery", `verify-fail ${unitType} ${unitId}: plan has no task checkbox/heading (len=${planContent.length}) at ${absPath}`);
            return false;
          }
          const plan = parseLegacyPlan(planContent);
          if (plan.tasks.length > 0) taskIds = plan.tasks.map((t) => t.id);
        }
        if (taskIds && taskIds.length > 0) {
          const tasksDir = resolveTasksDir(base, mid, sid);
          if (!tasksDir) {
            logWarning("recovery", `verify-fail ${unitType} ${unitId}: resolveTasksDir returned null for ${mid}/${sid}`);
            return false;
          }
          for (const tid of taskIds) {
            const taskPlanFile = join(tasksDir, `${tid}-PLAN.md`);
            if (!existsSync(taskPlanFile)) {
              logWarning("recovery", `verify-fail ${unitType} ${unitId}: task plan missing ${taskPlanFile}`);
              return false;
            }
          }
        }
      } catch (err) {
        logWarning("recovery", `plan-slice task plan verification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (unitType === "execute-task") {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    if (mid && sid && tid) {
      const dbTask = getTask(mid, sid, tid);
      if (dbTask) {
        if (dbTask.status !== "complete" && dbTask.status !== "done" && !hasCheckedTaskCompletionOnDisk(base, mid, sid, tid)) {
          return false;
        }
      } else if (!isDbAvailable()) {
        if (!hasCheckedTaskCompletionOnDisk(base, mid, sid, tid)) return false;
      } else {
        return false;
      }
    }
  }
  if (unitType === "complete-slice") {
    const { milestone: mid, slice: sid } = parseUnitId(unitId);
    if (mid && sid) {
      const dir = resolveSlicePath(base, mid, sid);
      if (dir) {
        const uatPath = join(dir, buildSliceFileName(sid, "UAT"));
        if (!existsSync(uatPath)) return false;
      }
      const dbSlice = getSlice(mid, sid);
      if (dbSlice) {
        if (dbSlice.status !== "complete") return false;
      } else if (!isDbAvailable()) {
        const roadmapFile = resolveMilestoneFile(base, mid, "ROADMAP");
        if (roadmapFile && existsSync(roadmapFile)) {
          try {
            const roadmapContent = readFileSync(roadmapFile, "utf-8");
            const roadmap = parseLegacyRoadmap(roadmapContent);
            const slice = roadmap.slices.find((s) => s.id === sid);
            if (slice && !slice.done) return false;
          } catch (e) {
            logWarning("recovery", `roadmap parse failed: ${e.message}`);
            return false;
          }
        }
      }
    }
  }
  if (unitType === "complete-milestone") {
    const summaryOutcome = classifyMilestoneSummaryContent(readFileSync(absPath, "utf-8"));
    if (summaryOutcome === "failure") return false;
    const { milestone: mid } = parseUnitId(unitId);
    if (mid && isDbAvailable()) {
      const dbMilestone = getMilestone(mid);
      if (!dbMilestone) return false;
      if (!isClosedStatus(dbMilestone.status) && summaryOutcome !== "success") return false;
    }
    if (hasImplementationArtifacts(base, mid) === "absent") return false;
  }
  return true;
}
function writeBlockerPlaceholder(unitType, unitId, base, reason) {
  const absPath = resolveExpectedArtifactPath(unitType, unitId, base);
  if (!absPath) return null;
  const dir = dirname(absPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const recoveryLine = unitType === "research-project" ? "This placeholder was written by auto-mode so the project research gate can stop fail-closed." : "This placeholder was written by auto-mode so the pipeline can advance.";
  const content = [
    `# BLOCKER \u2014 auto-mode recovery failed`,
    ``,
    `Unit \`${unitType}\` for \`${unitId}\` failed to produce this artifact after idle recovery exhausted all retries.`,
    ``,
    `**Reason**: ${reason}`,
    ``,
    recoveryLine,
    `Review and replace this file before relying on downstream artifacts.`
  ].join("\n");
  writeFileSync(absPath, content, "utf-8");
  clearPathCache();
  clearParseCache();
  if (isDbAvailable()) {
    const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    if (unitType === "execute-task" && mid && sid && tid) {
      try {
        updateTaskStatus(mid, sid, tid, "complete", ts);
        const planPath = resolveSliceFile(base, mid, sid, "PLAN");
        if (planPath && existsSync(planPath)) {
          const planContent = readFileSync(planPath, "utf-8");
          const updatedPlan = planContent.replace(
            new RegExp(`^(\\s*-\\s+)\\[ \\]\\s+\\*\\*${tid}:`, "m"),
            `$1[x] **${tid}:`
          );
          if (updatedPlan !== planContent) {
            atomicWriteSync(planPath, updatedPlan);
          }
        }
      } catch (e) {
        logWarning("recovery", `updateTaskStatus failed during context exhaustion: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        appendEvent(base, { cmd: "complete-task", params: { milestoneId: mid, sliceId: sid, taskId: tid }, ts, actor: "system", trigger_reason: "blocker-placeholder-recovery" });
      } catch (e) {
        logWarning("recovery", `appendEvent failed for task recovery: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (unitType === "complete-slice" && mid && sid) {
      try {
        updateSliceStatus(mid, sid, "complete", ts);
      } catch (e) {
        logWarning("recovery", `updateSliceStatus failed during context exhaustion: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        appendEvent(base, { cmd: "complete-slice", params: { milestoneId: mid, sliceId: sid }, ts, actor: "system", trigger_reason: "blocker-placeholder-recovery" });
      } catch (e) {
        logWarning("recovery", `appendEvent failed for slice recovery: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (unitType === "plan-milestone" && mid) {
      try {
        insertSlice({ id: "S00-blocker", milestoneId: mid, title: "Blocker placeholder \u2014 planning failed", status: "complete", sequence: 0 });
      } catch (e) {
        logWarning("recovery", `insertSlice placeholder failed for plan-milestone recovery: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        appendEvent(base, { cmd: "plan-milestone", params: { milestoneId: mid }, ts, actor: "system", trigger_reason: "blocker-placeholder-recovery" });
      } catch (e) {
        logWarning("recovery", `appendEvent failed for plan-milestone recovery: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return diagnoseExpectedArtifact(unitType, unitId, base);
}
import {
  reconcileMergeState
} from "./state-reconciliation/drift/merge-state.js";
function buildLoopRemediationSteps(unitType, unitId, base) {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  switch (unitType) {
    case "execute-task": {
      if (!mid || !sid || !tid) break;
      return [
        `   1. Run \`gsd undo-task ${tid}\` to reset the task state`,
        `   2. Resume auto-mode \u2014 it will re-execute the task`,
        `   3. If the task keeps failing, run \`gsd recover\` to rebuild DB state from disk`
      ].join("\n");
    }
    case "plan-slice":
    case "research-slice": {
      if (!mid || !sid) break;
      const artifactRel = unitType === "plan-slice" ? relSliceFile(base, mid, sid, "PLAN") : relSliceFile(base, mid, sid, "RESEARCH");
      return [
        `   1. Write ${artifactRel} manually (or with the LLM in interactive mode)`,
        `   2. Run \`gsd recover\` to rebuild DB state from disk`,
        `   3. Resume auto-mode`
      ].join("\n");
    }
    case "complete-slice": {
      if (!mid || !sid) break;
      return [
        `   1. Run \`gsd reset-slice ${sid}\` to reset the slice and all its tasks`,
        `   2. Resume auto-mode \u2014 it will re-execute incomplete tasks and re-complete the slice`,
        `   3. If the slice keeps failing, run \`gsd recover\` to rebuild DB state from disk`
      ].join("\n");
    }
    case "validate-milestone": {
      if (!mid) break;
      const artifactRel = relMilestoneFile(base, mid, "VALIDATION");
      return [
        `   1. Write ${artifactRel} with verdict: pass`,
        `   2. Run \`gsd recover\` to rebuild DB state from disk`,
        `   3. Resume auto-mode`
      ].join("\n");
    }
    default:
      break;
  }
  return null;
}
export {
  buildLoopRemediationSteps,
  classifyMilestoneSummaryContent2 as classifyMilestoneSummaryContent,
  diagnoseExpectedArtifact,
  diagnoseWorktreeIntegrityFailure,
  hasImplementationArtifacts,
  reconcileMergeState,
  refreshRecoveryDbForArtifact,
  resolveExpectedArtifactPath,
  verifyExpectedArtifact,
  writeBlockerPlaceholder
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXJlY292ZXJ5LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIEF1dG8tbW9kZSBSZWNvdmVyeSBcdTIwMTQgYXJ0aWZhY3QgcmVzb2x1dGlvbiwgdmVyaWZpY2F0aW9uLCBibG9ja2VyIHBsYWNlaG9sZGVycyxcbiAqIHNraXAgYXJ0aWZhY3RzLCBtZXJnZSBzdGF0ZSByZWNvbmNpbGlhdGlvbixcbiAqIHNlbGYtaGVhbCBydW50aW1lIHJlY29yZHMsIGFuZCBsb29wIHJlbWVkaWF0aW9uIHN0ZXBzLlxuICpcbiAqIFB1cmUgZnVuY3Rpb25zIHRoYXQgcmVjZWl2ZSBhbGwgbmVlZGVkIHN0YXRlIGFzIHBhcmFtZXRlcnMgXHUyMDE0IG5vIG1vZHVsZS1sZXZlbFxuICogZ2xvYmFscyBvciBBdXRvQ29udGV4dCBkZXBlbmRlbmN5LlxuICovXG5cbmltcG9ydCB7IHBhcnNlVW5pdElkIH0gZnJvbSBcIi4vdW5pdC1pZC5qc1wiO1xuaW1wb3J0IHsgTUlMRVNUT05FX0lEX1JFIH0gZnJvbSBcIi4vbWlsZXN0b25lLWlkcy5qc1wiO1xuaW1wb3J0IHsgYXBwZW5kRXZlbnQgfSBmcm9tIFwiLi93b3JrZmxvdy1ldmVudHMuanNcIjtcbmltcG9ydCB7IGF0b21pY1dyaXRlU3luYyB9IGZyb20gXCIuL2F0b21pYy13cml0ZS5qc1wiO1xuaW1wb3J0IHsgY2xlYXJQYXJzZUNhY2hlIH0gZnJvbSBcIi4vZmlsZXMuanNcIjtcbmltcG9ydCB7IHBhcnNlUm9hZG1hcCBhcyBwYXJzZUxlZ2FjeVJvYWRtYXAsIHBhcnNlUGxhbiBhcyBwYXJzZUxlZ2FjeVBsYW4gfSBmcm9tIFwiLi9wYXJzZXJzLWxlZ2FjeS5qc1wiO1xuaW1wb3J0IHsgaXNEYkF2YWlsYWJsZSwgZ2V0VGFzaywgZ2V0U2xpY2UsIGdldFNsaWNlVGFza3MsIGdldFBlbmRpbmdHYXRlcywgdXBkYXRlVGFza1N0YXR1cywgdXBkYXRlU2xpY2VTdGF0dXMsIGluc2VydFNsaWNlLCBnZXRNaWxlc3RvbmUsIHJlZnJlc2hPcGVuRGF0YWJhc2VGcm9tRGlzaywgZ2V0Q29tcGxldGVkTWlsZXN0b25lVGFza0ZpbGVIaW50cywgZ2V0TWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb25TaGFzLCByZWNvcmRNaWxlc3RvbmVDb21taXRBdHRyaWJ1dGlvbiB9IGZyb20gXCIuL2dzZC1kYi5qc1wiO1xuaW1wb3J0IHsgaXNWYWxpZGF0aW9uVGVybWluYWwgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgZ2V0RXJyb3JNZXNzYWdlIH0gZnJvbSBcIi4vZXJyb3ItdXRpbHMuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcsIGxvZ0Vycm9yIH0gZnJvbSBcIi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyByZWFkSW50ZWdyYXRpb25CcmFuY2ggfSBmcm9tIFwiLi9naXQtc2VydmljZS5qc1wiO1xuaW1wb3J0IHsgaXNDbG9zZWRTdGF0dXMgfSBmcm9tIFwiLi9zdGF0dXMtZ3VhcmRzLmpzXCI7XG5pbXBvcnQge1xuICByZXNvbHZlU2xpY2VQYXRoLFxuICByZXNvbHZlU2xpY2VGaWxlLFxuICByZXNvbHZlVGFza3NEaXIsXG4gIHJlc29sdmVUYXNrRmlsZXMsXG4gIHJlbE1pbGVzdG9uZUZpbGUsXG4gIHJlbFNsaWNlRmlsZSxcbiAgYnVpbGRTbGljZUZpbGVOYW1lLFxuICByZXNvbHZlTWlsZXN0b25lRmlsZSxcbiAgY2xlYXJQYXRoQ2FjaGUsXG4gIHJlc29sdmVHc2RSb290RmlsZSxcbn0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgZXhlY0ZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHsgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7XG4gIHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCxcbiAgZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0LFxufSBmcm9tIFwiLi9hdXRvLWFydGlmYWN0LXBhdGhzLmpzXCI7XG5pbXBvcnQgeyBjbGFzc2lmeU1pbGVzdG9uZVN1bW1hcnlDb250ZW50IH0gZnJvbSBcIi4vbWlsZXN0b25lLXN1bW1hcnktY2xhc3NpZmllci5qc1wiO1xuaW1wb3J0IHsgdmFsaWRhdGVBcnRpZmFjdCB9IGZyb20gXCIuL3NjaGVtYXMvdmFsaWRhdGUuanNcIjtcbmltcG9ydCB7IGdldFByb2plY3RSZXNlYXJjaFN0YXR1cyB9IGZyb20gXCIuL3Byb2plY3QtcmVzZWFyY2gtcG9saWN5LmpzXCI7XG5pbXBvcnQgeyBpc0dzZFdvcmt0cmVlUGF0aCB9IGZyb20gXCIuL3dvcmt0cmVlLXJvb3QuanNcIjtcblxuLy8gUmUtZXhwb3J0IHNvIGV4aXN0aW5nIGNvbnN1bWVycyBvZiBhdXRvLXJlY292ZXJ5LnRzIGtlZXAgd29ya2luZy5cbmV4cG9ydCB7IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCwgZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0IH07XG5leHBvcnQge1xuICBjbGFzc2lmeU1pbGVzdG9uZVN1bW1hcnlDb250ZW50LFxuICB0eXBlIE1pbGVzdG9uZVN1bW1hcnlPdXRjb21lLFxufSBmcm9tIFwiLi9taWxlc3RvbmUtc3VtbWFyeS1jbGFzc2lmaWVyLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBBcnRpZmFjdCBSZXNvbHV0aW9uICYgVmVyaWZpY2F0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gZGlhZ25vc2VXb3JrdHJlZUludGVncml0eUZhaWx1cmUoYmFzZVBhdGg6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWlzR3NkV29ya3RyZWVQYXRoKGJhc2VQYXRoKSkgcmV0dXJuIG51bGw7XG4gIGlmICghZXhpc3RzU3luYyhiYXNlUGF0aCkpIHtcbiAgICByZXR1cm4gYFdvcmt0cmVlIGludGVncml0eSBmYWlsdXJlOiAke2Jhc2VQYXRofSBkb2VzIG5vdCBleGlzdC4gUmVwYWlyIG9yIHJlY3JlYXRlIHRoZSB3b3JrdHJlZSBiZWZvcmUgcmV0cnlpbmcuYDtcbiAgfVxuXG4gIGNvbnN0IGdpdFBhdGggPSBqb2luKGJhc2VQYXRoLCBcIi5naXRcIik7XG4gIGlmICghZXhpc3RzU3luYyhnaXRQYXRoKSkge1xuICAgIHJldHVybiBgV29ya3RyZWUgaW50ZWdyaXR5IGZhaWx1cmU6ICR7YmFzZVBhdGh9IGlzIG5vdCBhIHZhbGlkIGdpdCB3b3JrdHJlZSAoLmdpdCBtaXNzaW5nKS4gUmVwYWlyIG9yIHJlY3JlYXRlIHRoZSB3b3JrdHJlZSBiZWZvcmUgcmV0cnlpbmcuYDtcbiAgfVxuXG4gIHRyeSB7XG4gICAgZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBcIi0tZ2l0LWRpclwiXSwge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIHJldHVybiBgV29ya3RyZWUgaW50ZWdyaXR5IGZhaWx1cmU6ICR7YmFzZVBhdGh9IGlzIG5vdCBhIHZhbGlkIGdpdCB3b3JrdHJlZSAoZ2l0IHJldi1wYXJzZSBmYWlsZWQ6ICR7Z2V0RXJyb3JNZXNzYWdlKGVycikuc3BsaXQoXCJcXG5cIilbMF19KS4gUmVwYWlyIG9yIHJlY3JlYXRlIHRoZSB3b3JrdHJlZSBiZWZvcmUgcmV0cnlpbmcuYDtcbiAgfVxufVxuXG5leHBvcnQgdHlwZSBBcnRpZmFjdFJlY292ZXJ5RGJSZWZyZXNoUmVzdWx0ID1cbiAgfCB7IG9rOiB0cnVlIH1cbiAgfCB7IG9rOiBmYWxzZTsgZmF0YWw6IGJvb2xlYW47IG1lc3NhZ2U6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfTtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlZnJlc2hSZWNvdmVyeURiRm9yQXJ0aWZhY3QoXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuKTogQXJ0aWZhY3RSZWNvdmVyeURiUmVmcmVzaFJlc3VsdCB7XG4gIGlmICh1bml0VHlwZSAhPT0gXCJwbGFuLXNsaWNlXCIgJiYgdW5pdFR5cGUgIT09IFwiZXhlY3V0ZS10YXNrXCIpIHJldHVybiB7IG9rOiB0cnVlIH07XG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm4geyBvazogdHJ1ZSB9O1xuXG4gIGlmICghcmVmcmVzaE9wZW5EYXRhYmFzZUZyb21EaXNrKCkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgZmF0YWw6IHVuaXRUeXBlID09PSBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgcmVhc29uOiBgJHt1bml0VHlwZX0tZGItcmVmcmVzaC1mYWlsZWRgLFxuICAgICAgbWVzc2FnZTogYFN0dWNrIHJlY292ZXJ5IGZvdW5kICR7dW5pdFR5cGV9ICR7dW5pdElkfSBhcnRpZmFjdHMsIGJ1dCB0aGUgREIgcmVmcmVzaCBmYWlsZWQuYCxcbiAgICB9O1xuICB9XG5cbiAgaWYgKHVuaXRUeXBlICE9PSBcImV4ZWN1dGUtdGFza1wiKSByZXR1cm4geyBvazogdHJ1ZSB9O1xuXG4gIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQsIHRhc2s6IHRpZCB9ID0gcGFyc2VVbml0SWQodW5pdElkKTtcbiAgaWYgKCFtaWQgfHwgIXNpZCB8fCAhdGlkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGZhdGFsOiB0cnVlLFxuICAgICAgcmVhc29uOiBcImV4ZWN1dGUtdGFzay1pbnZhbGlkLXVuaXQtaWRcIixcbiAgICAgIG1lc3NhZ2U6IGBTdHVjayByZWNvdmVyeSBmb3VuZCBleGVjdXRlLXRhc2sgJHt1bml0SWR9IGFydGlmYWN0cywgYnV0IHRoZSB1bml0IGlkIGNvdWxkIG5vdCBiZSBwYXJzZWQgZm9yIERCIHZlcmlmaWNhdGlvbi5gLFxuICAgIH07XG4gIH1cblxuICBjb25zdCB0YXNrID0gZ2V0VGFzayhtaWQsIHNpZCwgdGlkKTtcbiAgaWYgKCF0YXNrKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGZhdGFsOiB0cnVlLFxuICAgICAgcmVhc29uOiBcImV4ZWN1dGUtdGFzay1hcnRpZmFjdC1kYi1taXNzaW5nXCIsXG4gICAgICBtZXNzYWdlOiBgU3R1Y2sgcmVjb3ZlcnkgZm91bmQgZXhlY3V0ZS10YXNrICR7dW5pdElkfSBhcnRpZmFjdHMsIGJ1dCBubyBtYXRjaGluZyBEQiB0YXNrIHJvdyBleGlzdHMgYWZ0ZXIgcmVmcmVzaC5gLFxuICAgIH07XG4gIH1cblxuICBpZiAoIWlzQ2xvc2VkU3RhdHVzKHRhc2suc3RhdHVzKSkge1xuICAgIHJldHVybiB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBmYXRhbDogdHJ1ZSxcbiAgICAgIHJlYXNvbjogXCJleGVjdXRlLXRhc2stYXJ0aWZhY3QtZGItbWlzbWF0Y2hcIixcbiAgICAgIG1lc3NhZ2U6IGBTdHVjayByZWNvdmVyeSBmb3VuZCBleGVjdXRlLXRhc2sgJHt1bml0SWR9IGFydGlmYWN0cywgYnV0IHRoZSBEQiB0YXNrIHN0YXR1cyBpcyBzdGlsbCAnJHt0YXNrLnN0YXR1c30nIGFmdGVyIHJlZnJlc2guYCxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbn1cblxuZnVuY3Rpb24gaGFzQ2FwdHVyZWRXb3JrZmxvd1ByZWZzKGJhc2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBwcmVmc1BhdGggPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgoXCJ3b3JrZmxvdy1wcmVmZXJlbmNlc1wiLCBcIldPUktGTE9XLVBSRUZTXCIsIGJhc2UpO1xuICBpZiAoIXByZWZzUGF0aCB8fCAhZXhpc3RzU3luYyhwcmVmc1BhdGgpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGNvbnRlbnQgPSByZWFkRmlsZVN5bmMocHJlZnNQYXRoLCBcInV0Zi04XCIpO1xuICBjb25zdCBtYXRjaCA9IGNvbnRlbnQubWF0Y2goL14tLS1cXHI/XFxuKFtcXHNcXFNdKj8pXFxyP1xcbi0tLS8pO1xuICByZXR1cm4gISFtYXRjaCAmJiAvXndvcmtmbG93X3ByZWZzX2NhcHR1cmVkOlxccyp0cnVlXFxzKiQvbS50ZXN0KG1hdGNoWzFdKTtcbn1cblxuZnVuY3Rpb24gaGFzVmFsaWRSZXNlYXJjaERlY2lzaW9uKGJhc2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBkZWNpc2lvblBhdGggPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgoXCJyZXNlYXJjaC1kZWNpc2lvblwiLCBcIlJFU0VBUkNILURFQ0lTSU9OXCIsIGJhc2UpO1xuICBpZiAoIWRlY2lzaW9uUGF0aCB8fCAhZXhpc3RzU3luYyhkZWNpc2lvblBhdGgpKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgY29uc3QgY2ZnID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoZGVjaXNpb25QYXRoLCBcInV0Zi04XCIpKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICByZXR1cm4gY2ZnLmRlY2lzaW9uID09PSBcInJlc2VhcmNoXCIgfHwgY2ZnLmRlY2lzaW9uID09PSBcInNraXBcIjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmZ1bmN0aW9uIGhhc0NvbXBsZXRlUHJvamVjdFJlc2VhcmNoKGJhc2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZ2V0UHJvamVjdFJlc2VhcmNoU3RhdHVzKGJhc2UpLmNvbXBsZXRlO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVSZWdFeHAodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIik7XG59XG5cbmZ1bmN0aW9uIGhhc0NoZWNrZWRUYXNrQ29tcGxldGlvbk9uRGlzayhiYXNlOiBzdHJpbmcsIG1pZDogc3RyaW5nLCBzaWQ6IHN0cmluZywgdGlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgdGFza3NEaXIgPSByZXNvbHZlVGFza3NEaXIoYmFzZSwgbWlkLCBzaWQpO1xuICBpZiAoIXRhc2tzRGlyKSByZXR1cm4gZmFsc2U7XG4gIGlmICghZXhpc3RzU3luYyhqb2luKHRhc2tzRGlyLCBgJHt0aWR9LVNVTU1BUlkubWRgKSkpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBwbGFuQWJzID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJQTEFOXCIpO1xuICBpZiAoIXBsYW5BYnMgfHwgIWV4aXN0c1N5bmMocGxhbkFicykpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBwbGFuQ29udGVudCA9IHJlYWRGaWxlU3luYyhwbGFuQWJzLCBcInV0Zi04XCIpO1xuICBjb25zdCBjYlJlID0gbmV3IFJlZ0V4cChgXlxcXFxzKi1cXFxccytcXFxcW1t4WF1cXFxcXVxcXFxzK1xcXFwqXFxcXCoke2VzY2FwZVJlZ0V4cCh0aWQpfTpgLCBcIm1cIik7XG4gIHJldHVybiBjYlJlLnRlc3QocGxhbkNvbnRlbnQpO1xufVxuXG4vKipcbiAqIENoZWNrIHdoZXRoZXIgYSBtaWxlc3RvbmUgcHJvZHVjZWQgaW1wbGVtZW50YXRpb24gYXJ0aWZhY3RzIChub24tYC5nc2QvYFxuICogZmlsZXMpIGluIGdpdCBoaXN0b3J5LiBUaGUgcHJpbWFyeSBzaWduYWwgaXMgdGhlIGJyYW5jaCBkaWZmIGFnYWluc3QgdGhlXG4gKiBpbnRlZ3JhdGlvbiBicmFuY2guIFdoZW4gYSByZXRyeSBpcyBhbHJlYWR5IG9uIHRoZSBpbnRlZ3JhdGlvbiBicmFuY2gsIHRoYXRcbiAqIGRpZmYgaXMgYSBzZWxmLWRpZmY7IGlmIGEgbWlsZXN0b25lIElEIGlzIGF2YWlsYWJsZSwgZmFsbCBiYWNrIHRvIHJlY2VudFxuICogR1NELXRhZ2dlZCBjb21taXRzIGZvciB0aGF0IG1pbGVzdG9uZS5cbiAqXG4gKiBSZXR1cm5zIFwicHJlc2VudFwiIGlmIGltcGxlbWVudGF0aW9uIGZpbGVzIGZvdW5kLCBcImFic2VudFwiIGlmIG9ubHkgLmdzZC8gZmlsZXMsXG4gKiBcInVua25vd25cIiBpZiBnaXQgaXMgdW5hdmFpbGFibGUgb3IgY2hlY2sgZmFpbGVkIChjYWxsZXJzIGRlY2lkZSBob3cgdG8gaGFuZGxlKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzKGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkPzogc3RyaW5nKTogXCJwcmVzZW50XCIgfCBcImFic2VudFwiIHwgXCJ1bmtub3duXCIge1xuICB0cnkge1xuICAgIC8vIFZlcmlmeSB3ZSdyZSBpbiBhIGdpdCByZXBvXG4gICAgdHJ5IHtcbiAgICAgIGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbXCJyZXYtcGFyc2VcIiwgXCItLWlzLWluc2lkZS13b3JrLXRyZWVcIl0sIHtcbiAgICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGBnaXQgcmV2LXBhcnNlIGNoZWNrIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgIHJldHVybiBcInVua25vd25cIjtcbiAgICB9XG5cbiAgICAvLyBTdHJhdGVneTogY2hlY2sgYGdpdCBkaWZmIC0tbmFtZS1vbmx5YCBhZ2FpbnN0IHRoZSBtZXJnZS1iYXNlIHdpdGggdGhlXG4gICAgLy8gbWFpbiBicmFuY2guIFRoaXMgY2FwdHVyZXMgQUxMIGZpbGVzIGNoYW5nZWQgZHVyaW5nIHRoZSBtaWxlc3RvbmUnc1xuICAgIC8vIGxpZmV0aW1lIHdoaWxlIHJ1bm5pbmcgb24gYSBtaWxlc3RvbmUgYnJhbmNoLlxuICAgIGNvbnN0IGludGVncmF0aW9uQnJhbmNoID0gbWlsZXN0b25lSWRcbiAgICAgID8gcmVhZEludGVncmF0aW9uQnJhbmNoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCkgPz8gZGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aClcbiAgICAgIDogZGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG4gICAgY29uc3QgY3VycmVudEJyYW5jaCA9IGdldEN1cnJlbnRCcmFuY2goYmFzZVBhdGgpO1xuICAgIGNvbnN0IGJyYW5jaERpZmYgPSBnZXRDaGFuZ2VkRmlsZXNTaW5jZUJyYW5jaChiYXNlUGF0aCwgaW50ZWdyYXRpb25CcmFuY2gpO1xuICAgIGlmICghYnJhbmNoRGlmZi5vaykgcmV0dXJuIFwidW5rbm93blwiO1xuICAgIGNvbnN0IGNoYW5nZWRGaWxlcyA9IGJyYW5jaERpZmYuZmlsZXM7XG5cbiAgICAvLyBObyBicmFuY2gtZGlmZiBmaWxlcyBjYW4gbWVhbiB0aGUgdW5pdCByZXRyaWVkIG9uIG1haW4gYWZ0ZXIgbWlsZXN0b25lXG4gICAgLy8gY29tbWl0cyBhbHJlYWR5IGxhbmRlZCB0aGVyZS4gSW4gdGhhdCB0b3BvbG9neSwgaW5zcGVjdCBHU0QtdGFnZ2VkXG4gICAgLy8gbWlsZXN0b25lIGNvbW1pdHMgaW5zdGVhZCBvZiB0cmVhdGluZyB0aGUgc2VsZi1kaWZmIGFzIHByb29mIG9mIG5vIHdvcmsuXG4gICAgaWYgKGNoYW5nZWRGaWxlcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGlmIChtaWxlc3RvbmVJZCAmJiBjdXJyZW50QnJhbmNoID09PSBpbnRlZ3JhdGlvbkJyYW5jaCkge1xuICAgICAgICBjb25zdCBtaWxlc3RvbmVFdmlkZW5jZSA9IGdldENoYW5nZWRGaWxlc0Zyb21NaWxlc3RvbmVFdmlkZW5jZShiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgICAgICBpZiAoIW1pbGVzdG9uZUV2aWRlbmNlLm9rKSByZXR1cm4gXCJ1bmtub3duXCI7XG4gICAgICAgIGlmIChtaWxlc3RvbmVFdmlkZW5jZS5tYXRjaGVkKSByZXR1cm4gY2xhc3NpZnlJbXBsZW1lbnRhdGlvbkZpbGVzKG1pbGVzdG9uZUV2aWRlbmNlLmZpbGVzKTtcbiAgICAgIH1cbiAgICAgIGlmIChjdXJyZW50QnJhbmNoICYmIGN1cnJlbnRCcmFuY2ggIT09IFwiSEVBRFwiKSByZXR1cm4gXCJhYnNlbnRcIjtcbiAgICAgIHJldHVybiBcInVua25vd25cIjtcbiAgICB9XG5cbiAgICBjb25zdCBicmFuY2hDbGFzc2lmaWNhdGlvbiA9IGNsYXNzaWZ5SW1wbGVtZW50YXRpb25GaWxlcyhjaGFuZ2VkRmlsZXMpO1xuICAgIGlmIChicmFuY2hDbGFzc2lmaWNhdGlvbiA9PT0gXCJwcmVzZW50XCIpIHJldHVybiBcInByZXNlbnRcIjtcblxuICAgIC8vIEEgY29tcGxldGluZyBtaWxlc3RvbmUgYnJhbmNoIGNhbiBoYXZlIGEgbm9uLWVtcHR5IGRpZmYgY29udGFpbmluZyBvbmx5XG4gICAgLy8gLmdzZC8gY2xvc2VvdXQgZmlsZXMgYWZ0ZXIgaW1wbGVtZW50YXRpb24gY29tbWl0cyBhbHJlYWR5IGxhbmRlZCBvbiB0aGVcbiAgICAvLyByZWNvcmRlZCBpbnRlZ3JhdGlvbiBicmFuY2guIEluIHRoYXQgdG9wb2xvZ3ksIHRoZSBicmFuY2ggZGlmZiBhbG9uZSBpc1xuICAgIC8vIGluc3VmZmljaWVudDsgdXNlIHRoZSBzYW1lIG1pbGVzdG9uZS10YWdnZWQgZXZpZGVuY2UgZmFsbGJhY2sgYXMgdGhlXG4gICAgLy8gc2VsZi1kaWZmIHJldHJ5IHBhdGggYmVmb3JlIGRlY2xhcmluZyB0aGUgbWlsZXN0b25lIGltcGxlbWVudGF0aW9uLWZyZWUuXG4gICAgaWYgKG1pbGVzdG9uZUlkKSB7XG4gICAgICBjb25zdCBtaWxlc3RvbmVFdmlkZW5jZSA9IGdldENoYW5nZWRGaWxlc0Zyb21NaWxlc3RvbmVFdmlkZW5jZShiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgICAgaWYgKCFtaWxlc3RvbmVFdmlkZW5jZS5vaykgcmV0dXJuIFwidW5rbm93blwiO1xuICAgICAgaWYgKG1pbGVzdG9uZUV2aWRlbmNlLm1hdGNoZWQpIHJldHVybiBjbGFzc2lmeUltcGxlbWVudGF0aW9uRmlsZXMobWlsZXN0b25lRXZpZGVuY2UuZmlsZXMpO1xuICAgIH1cblxuICAgIHJldHVybiBcImFic2VudFwiO1xuICB9IGNhdGNoIChlKSB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBpZiBnaXQgb3BlcmF0aW9ucyBmYWlsLCByZXR1cm4gdW5rbm93biBzbyBjYWxsZXJzIGNhbiBkZWNpZGVcbiAgICBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYGltcGxlbWVudGF0aW9uIGFydGlmYWN0IGNoZWNrIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4gXCJ1bmtub3duXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gZ2V0Q3VycmVudEJyYW5jaChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgYnJhbmNoID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBcIi0tYWJicmV2LXJlZlwiLCBcIkhFQURcIl0sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgIH0pLnRyaW0oKTtcbiAgICByZXR1cm4gYnJhbmNoIHx8IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNsYXNzaWZ5SW1wbGVtZW50YXRpb25GaWxlcyhmaWxlczogcmVhZG9ubHkgc3RyaW5nW10pOiBcInByZXNlbnRcIiB8IFwiYWJzZW50XCIge1xuICBjb25zdCBpbXBsRmlsZXMgPSBmaWxlcy5maWx0ZXIoaXNJbXBsZW1lbnRhdGlvblBhdGgpO1xuICByZXR1cm4gaW1wbEZpbGVzLmxlbmd0aCA+IDAgPyBcInByZXNlbnRcIiA6IFwiYWJzZW50XCI7XG59XG5cbmZ1bmN0aW9uIGlzSW1wbGVtZW50YXRpb25QYXRoKGZpbGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gIWZpbGUuc3RhcnRzV2l0aChcIi5nc2QvXCIpICYmICFmaWxlLnN0YXJ0c1dpdGgoXCIuZ3NkXFxcXFwiKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUmVwb1BhdGgoZmlsZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGZpbGUudHJpbSgpLnJlcGxhY2UoL1xcXFwvZywgXCIvXCIpLnJlcGxhY2UoL15cXC5cXC8rLywgXCJcIik7XG59XG5cbi8qKlxuICogRGV0ZWN0IHRoZSBtYWluL21hc3RlciBicmFuY2ggbmFtZS5cbiAqL1xuZnVuY3Rpb24gZGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2LXBhcnNlXCIsIFwiLS12ZXJpZnlcIiwgXCJtYWluXCJdLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICB9KTtcbiAgICBpZiAocmVzdWx0LnRyaW0oKSkgcmV0dXJuIFwibWFpblwiO1xuICB9IGNhdGNoIChfKSB7XG4gICAgLy8gRXhwZWN0ZWQgXHUyMDE0IG1haW4gZG9lc24ndCBleGlzdCwgdHJ5IG1hc3RlciBuZXh0XG4gICAgdm9pZCBfO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcInJldi1wYXJzZVwiLCBcIi0tdmVyaWZ5XCIsIFwibWFzdGVyXCJdLCB7XG4gICAgICBjd2Q6IGJhc2VQYXRoLFxuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLFxuICAgICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICB9KTtcbiAgICBpZiAocmVzdWx0LnRyaW0oKSkgcmV0dXJuIFwibWFzdGVyXCI7XG4gIH0gY2F0Y2ggKF8pIHtcbiAgICAvLyBFeHBlY3RlZCBcdTIwMTQgbWFzdGVyIGRvZXNuJ3QgZXhpc3QgZWl0aGVyXG4gICAgdm9pZCBfO1xuICB9XG4gIC8vIE5laXRoZXIgbWFpbiBub3IgbWFzdGVyIGZvdW5kIFx1MjAxNCB3YXJuIGFuZCBmYWxsIGJhY2tcbiAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIFwibmVpdGhlciBtYWluIG5vciBtYXN0ZXIgYnJhbmNoIGZvdW5kLCBkZWZhdWx0aW5nIHRvIG1haW5cIik7XG4gIHJldHVybiBcIm1haW5cIjtcbn1cblxuLyoqXG4gKiBHZXQgZmlsZXMgY2hhbmdlZCBzaW5jZSB0aGUgYnJhbmNoIGRpdmVyZ2VkIGZyb20gdGhlIHRhcmdldCBicmFuY2guXG4gKiBGYWxscyBiYWNrIHRvIGNoZWNraW5nIEhFQUR+MjAgaWYgbWVyZ2UtYmFzZSBkZXRlY3Rpb24gZmFpbHMuXG4gKi9cbmZ1bmN0aW9uIGdldENoYW5nZWRGaWxlc1NpbmNlQnJhbmNoKGJhc2VQYXRoOiBzdHJpbmcsIHRhcmdldEJyYW5jaDogc3RyaW5nKTogeyBvazogYm9vbGVhbjsgZmlsZXM6IHN0cmluZ1tdIH0ge1xuICB0cnkge1xuICAgIC8vIFRyeSBtZXJnZS1iYXNlIGFwcHJvYWNoIGZpcnN0XG4gICAgY29uc3QgbWVyZ2VCYXNlID0gZXhlY0ZpbGVTeW5jKFxuICAgICAgXCJnaXRcIiwgW1wibWVyZ2UtYmFzZVwiLCB0YXJnZXRCcmFuY2gsIFwiSEVBRFwiXSxcbiAgICAgIHsgY3dkOiBiYXNlUGF0aCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0sXG4gICAgKS50cmltKCk7XG5cbiAgICBpZiAobWVyZ2VCYXNlKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBleGVjRmlsZVN5bmMoXG4gICAgICAgIFwiZ2l0XCIsIFtcImRpZmZcIiwgXCItLW5hbWUtb25seVwiLCBtZXJnZUJhc2UsIFwiSEVBRFwiXSxcbiAgICAgICAgeyBjd2Q6IGJhc2VQYXRoLCBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sIGVuY29kaW5nOiBcInV0Zi04XCIgfSxcbiAgICAgICkudHJpbSgpO1xuICAgICAgcmV0dXJuIHsgb2s6IHRydWUsIGZpbGVzOiByZXN1bHQgPyByZXN1bHQuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pIDogW10gfTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIG1lcmdlLWJhc2UgZmFpbGVkIFx1MjAxNCBmYWxsIGJhY2tcbiAgICBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYG1lcmdlLWJhc2UgZGV0ZWN0aW9uIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cblxuICAvLyBGYWxsYmFjazogY2hlY2sgbGFzdCAyMCBjb21taXRzXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gZXhlY0ZpbGVTeW5jKFxuICAgICAgXCJnaXRcIiwgW1wibG9nXCIsIFwiLS1uYW1lLW9ubHlcIiwgXCItLXByZXR0eT1mb3JtYXQ6XCIsIFwiLTIwXCIsIFwiSEVBRFwiXSxcbiAgICAgIHsgY3dkOiBiYXNlUGF0aCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0sXG4gICAgKS50cmltKCk7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIGZpbGVzOiByZXN1bHQgPyBbLi4ubmV3IFNldChyZXN1bHQuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pKV0gOiBbXSB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGBnaXQgbG9nIGZhbGxiYWNrIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIGZpbGVzOiBbXSB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIGdldENoYW5nZWRGaWxlc0Zyb21NaWxlc3RvbmVUYWdnZWRDb21taXRzKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuKTogeyBvazogYm9vbGVhbjsgbWF0Y2hlZDogYm9vbGVhbjsgZmlsZXM6IHN0cmluZ1tdIH0ge1xuICAvLyBQcmltYXJ5OiBwYXRoLXNjb3BlZCBsb2cgYWdhaW5zdCAuZ3NkL21pbGVzdG9uZXMvPGlkPi4gRmFzdCBhbmQgdW5ib3VuZGVkXG4gIC8vIGJ5IGRlcHRoIHdoZW4gLmdzZC8gaXMgdHJhY2tlZCBpbiBnaXQuXG4gIGNvbnN0IHNjb3BlZCA9IHNjYW5Hc2RUYWdnZWRDb21taXRzKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgW1xuICAgIFwibG9nXCIsIFwiLS1mb3JtYXQ9JUgleDFmJUIleDFlXCIsIFwiSEVBRFwiLCBcIi0tXCIsIGAuZ3NkL21pbGVzdG9uZXMvJHttaWxlc3RvbmVJZH1gLFxuICBdKTtcbiAgaWYgKCFzY29wZWQub2spIHJldHVybiBzY29wZWQ7XG4gIGlmIChzY29wZWQubWF0Y2hlZCAmJiBjbGFzc2lmeUltcGxlbWVudGF0aW9uRmlsZXMoc2NvcGVkLmZpbGVzKSA9PT0gXCJwcmVzZW50XCIpIHJldHVybiBzY29wZWQ7XG5cbiAgLy8gRmFsbGJhY2sgKCM1MDMzKTogd2hlbiAuZ3NkLyBpcyBnaXRpZ25vcmVkIC8gZXh0ZXJuYWwgLyB1bnRyYWNrZWQsIHRoZVxuICAvLyBwYXRoLXNjb3BlZCBzY2FuIG1hdGNoZXMgbm8gY29tbWl0cyBldmVuIHRob3VnaCBHU0QtdGFnZ2VkIGNvbW1pdHNcbiAgLy8gcmVmZXJlbmNpbmcgdGhlIG1pbGVzdG9uZSBleGlzdCBvbiB0aGUgaW50ZWdyYXRpb24gYnJhbmNoLiBSZS1zY2FuIGFsbFxuICAvLyBvZiBIRUFEJ3MgaGlzdG9yeSBhbmQgcmVseSBvbiBjb21taXRNYXRjaGVzTWlsZXN0b25lIHRvIGJpbmQgYnlcbiAgLy8gZXhwbGljaXQgbWlsZXN0b25lIG1lbnRpb24gaW4gdGhlIG1lc3NhZ2UgYm9keS5cbiAgLy9cbiAgLy8gSW50ZW50aW9uYWxseSB1bmJvdW5kZWQgXHUyMDE0IHN5bW1ldHJpYyB3aXRoIHRoZSBwcmltYXJ5IHNjYW4sIGFuZCBhdm9pZHNcbiAgLy8gcmVpbnRyb2R1Y2luZyB0aGUgcm9sbGluZy1kZXB0aCBmYWlsdXJlIGNsYXNzIHJlbW92ZWQgaW4gIzQ2OTkgd2hlcmVcbiAgLy8gbWlsZXN0b25lIGV2aWRlbmNlIGFnZWQgb3V0IGJlaGluZCB1bnJlbGF0ZWQgYWN0aXZpdHkuXG4gIGNvbnN0IHVuc2NvcGVkID0gc2NhbkdzZFRhZ2dlZENvbW1pdHMoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBbXG4gICAgXCJsb2dcIiwgXCItLWZvcm1hdD0lSCV4MWYlQiV4MWVcIiwgXCJIRUFEXCIsXG4gIF0pO1xuICBpZiAoIXVuc2NvcGVkLm9rKSByZXR1cm4gc2NvcGVkLm1hdGNoZWQgPyBzY29wZWQgOiB1bnNjb3BlZDtcbiAgaWYgKCF1bnNjb3BlZC5tYXRjaGVkKSByZXR1cm4gc2NvcGVkO1xuXG4gIHJldHVybiB7XG4gICAgb2s6IHRydWUsXG4gICAgbWF0Y2hlZDogdHJ1ZSxcbiAgICBmaWxlczogWy4uLm5ldyBTZXQoWy4uLnNjb3BlZC5maWxlcywgLi4udW5zY29wZWQuZmlsZXNdKV0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGdldENoYW5nZWRGaWxlc0Zyb21NaWxlc3RvbmVFdmlkZW5jZShcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbik6IHsgb2s6IGJvb2xlYW47IG1hdGNoZWQ6IGJvb2xlYW47IGZpbGVzOiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgdGFnZ2VkID0gZ2V0Q2hhbmdlZEZpbGVzRnJvbU1pbGVzdG9uZVRhZ2dlZENvbW1pdHMoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgaWYgKCF0YWdnZWQub2spIHJldHVybiB0YWdnZWQ7XG4gIGlmICh0YWdnZWQubWF0Y2hlZCAmJiBjbGFzc2lmeUltcGxlbWVudGF0aW9uRmlsZXModGFnZ2VkLmZpbGVzKSA9PT0gXCJwcmVzZW50XCIpIHJldHVybiB0YWdnZWQ7XG5cbiAgY29uc3QgYXR0cmlidXRlZCA9IGdldENoYW5nZWRGaWxlc0Zyb21BdHRyaWJ1dGVkTWlsZXN0b25lQ29tbWl0cyhiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICBpZiAoIWF0dHJpYnV0ZWQub2spIHJldHVybiB0YWdnZWQubWF0Y2hlZCA/IHRhZ2dlZCA6IGF0dHJpYnV0ZWQ7XG4gIGlmIChhdHRyaWJ1dGVkLm1hdGNoZWQgJiYgY2xhc3NpZnlJbXBsZW1lbnRhdGlvbkZpbGVzKGF0dHJpYnV0ZWQuZmlsZXMpID09PSBcInByZXNlbnRcIikgcmV0dXJuIGF0dHJpYnV0ZWQ7XG5cbiAgY29uc3QgYmFja2ZpbGxlZCA9IGJhY2tmaWxsQ2hhbmdlZEZpbGVzRnJvbVVudGFnZ2VkTWlsZXN0b25lQ29tbWl0cyhiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICBpZiAoIWJhY2tmaWxsZWQub2spIHJldHVybiB0YWdnZWQubWF0Y2hlZCA/IHRhZ2dlZCA6IGF0dHJpYnV0ZWQubWF0Y2hlZCA/IGF0dHJpYnV0ZWQgOiBiYWNrZmlsbGVkO1xuICBpZiAoIWJhY2tmaWxsZWQubWF0Y2hlZCkge1xuICAgIGlmICh0YWdnZWQubWF0Y2hlZCkgcmV0dXJuIHRhZ2dlZDtcbiAgICByZXR1cm4gYXR0cmlidXRlZC5tYXRjaGVkID8gYXR0cmlidXRlZCA6IGJhY2tmaWxsZWQ7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG9rOiB0cnVlLFxuICAgIG1hdGNoZWQ6IHRydWUsXG4gICAgZmlsZXM6IFsuLi5uZXcgU2V0KFsuLi50YWdnZWQuZmlsZXMsIC4uLmF0dHJpYnV0ZWQuZmlsZXMsIC4uLmJhY2tmaWxsZWQuZmlsZXNdKV0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGdldENoYW5nZWRGaWxlc0Zyb21BdHRyaWJ1dGVkTWlsZXN0b25lQ29tbWl0cyhcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbik6IHsgb2s6IGJvb2xlYW47IG1hdGNoZWQ6IGJvb2xlYW47IGZpbGVzOiBzdHJpbmdbXSB9IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzaGFzID0gZ2V0TWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb25TaGFzKG1pbGVzdG9uZUlkKTtcbiAgICBpZiAoc2hhcy5sZW5ndGggPT09IDApIHJldHVybiB7IG9rOiB0cnVlLCBtYXRjaGVkOiBmYWxzZSwgZmlsZXM6IFtdIH07XG5cbiAgICBjb25zdCBmaWxlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGxldCBtYXRjaGVkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBzaGEgb2Ygc2hhcykge1xuICAgICAgaWYgKCFpc0Z1bGxDb21taXRTaGEoc2hhKSkgY29udGludWU7XG4gICAgICBjb25zdCBjb21taXRGaWxlcyA9IGdldENoYW5nZWRGaWxlc0ZvckNvbW1pdChiYXNlUGF0aCwgc2hhKTtcbiAgICAgIGlmIChjb21taXRGaWxlcy5sZW5ndGggPT09IDApIGNvbnRpbnVlO1xuICAgICAgbWF0Y2hlZCA9IHRydWU7XG4gICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgY29tbWl0RmlsZXMpIGZpbGVzLmFkZChmaWxlKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIG1hdGNoZWQsIGZpbGVzOiBbLi4uZmlsZXNdIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYG1pbGVzdG9uZSBhdHRyaWJ1dGlvbiBzY2FuIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIG1hdGNoZWQ6IGZhbHNlLCBmaWxlczogW10gfTtcbiAgfVxufVxuXG5mdW5jdGlvbiBiYWNrZmlsbENoYW5nZWRGaWxlc0Zyb21VbnRhZ2dlZE1pbGVzdG9uZUNvbW1pdHMoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4pOiB7IG9rOiBib29sZWFuOyBtYXRjaGVkOiBib29sZWFuOyBmaWxlczogc3RyaW5nW10gfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgbWlsZXN0b25lID0gZ2V0TWlsZXN0b25lKG1pbGVzdG9uZUlkKTtcbiAgICBjb25zdCBtaWxlc3RvbmVTdGFydGVkQXQgPSBtaWxlc3RvbmU/LmNyZWF0ZWRfYXQgPyBNYXRoLmZsb29yKERhdGUucGFyc2UobWlsZXN0b25lLmNyZWF0ZWRfYXQpIC8gMTAwMCkgKiAxMDAwIDogTmFOO1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKG1pbGVzdG9uZVN0YXJ0ZWRBdCkpIHJldHVybiB7IG9rOiB0cnVlLCBtYXRjaGVkOiBmYWxzZSwgZmlsZXM6IFtdIH07XG5cbiAgICBjb25zdCB0YXNrRmlsZUhpbnRzID0gZ2V0Q29tcGxldGVkTWlsZXN0b25lVGFza0ZpbGVIaW50cyhtaWxlc3RvbmVJZCk7XG4gICAgaWYgKHRhc2tGaWxlSGludHMubGVuZ3RoID09PSAwKSByZXR1cm4geyBvazogdHJ1ZSwgbWF0Y2hlZDogZmFsc2UsIGZpbGVzOiBbXSB9O1xuXG4gICAgY29uc3QgaGludFNldCA9IG5ldyBTZXQodGFza0ZpbGVIaW50cy5tYXAobm9ybWFsaXplUmVwb1BhdGgpLmZpbHRlcihCb29sZWFuKSk7XG4gICAgaWYgKGhpbnRTZXQuc2l6ZSA9PT0gMCkgcmV0dXJuIHsgb2s6IHRydWUsIG1hdGNoZWQ6IGZhbHNlLCBmaWxlczogW10gfTtcblxuICAgIGNvbnN0IHJlY29yZHMgPSBnZXRDb21taXRSZWNvcmRzKGJhc2VQYXRoKTtcbiAgICBjb25zdCBmaWxlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGxldCBtYXRjaGVkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCByZWNvcmQgb2YgcmVjb3Jkcykge1xuICAgICAgaWYgKCFpc0Z1bGxDb21taXRTaGEocmVjb3JkLmhhc2gpKSBjb250aW51ZTtcbiAgICAgIGlmIChEYXRlLnBhcnNlKHJlY29yZC5jb21taXR0ZWRBdCkgPCBtaWxlc3RvbmVTdGFydGVkQXQpIGNvbnRpbnVlO1xuICAgICAgaWYgKHJlY29yZC5wYXJlbnRzLnRyaW0oKS5zcGxpdCgvXFxzKy8pLmZpbHRlcihCb29sZWFuKS5sZW5ndGggPiAxKSBjb250aW51ZTtcbiAgICAgIGlmIChjb21taXRNZXNzYWdlSGFzR3NkVHJhaWxlcihyZWNvcmQubWVzc2FnZSkpIGNvbnRpbnVlO1xuXG4gICAgICBjb25zdCBjb21taXRGaWxlcyA9IGdldENoYW5nZWRGaWxlc0ZvckNvbW1pdChiYXNlUGF0aCwgcmVjb3JkLmhhc2gpO1xuICAgICAgY29uc3QgaW1wbGVtZW50YXRpb25GaWxlcyA9IGNvbW1pdEZpbGVzLm1hcChub3JtYWxpemVSZXBvUGF0aCkuZmlsdGVyKGlzSW1wbGVtZW50YXRpb25QYXRoKTtcbiAgICAgIGlmIChpbXBsZW1lbnRhdGlvbkZpbGVzLmxlbmd0aCA9PT0gMCkgY29udGludWU7XG4gICAgICBpZiAoIWltcGxlbWVudGF0aW9uRmlsZXMuc29tZSgoZmlsZSkgPT4gaGludFNldC5oYXMoZmlsZSkpKSBjb250aW51ZTtcblxuICAgICAgbWF0Y2hlZCA9IHRydWU7XG4gICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgaW1wbGVtZW50YXRpb25GaWxlcykgZmlsZXMuYWRkKGZpbGUpO1xuICAgICAgcmVjb3JkTWlsZXN0b25lQ29tbWl0QXR0cmlidXRpb24oe1xuICAgICAgICBjb21taXRTaGE6IHJlY29yZC5oYXNoLFxuICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgc291cmNlOiBcImJhY2tmaWxsXCIsXG4gICAgICAgIGNvbmZpZGVuY2U6IDAuOCxcbiAgICAgICAgZmlsZXM6IGltcGxlbWVudGF0aW9uRmlsZXMsXG4gICAgICAgIGNyZWF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIG1hdGNoZWQsIGZpbGVzOiBbLi4uZmlsZXNdIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYG1pbGVzdG9uZSBhdHRyaWJ1dGlvbiBiYWNrZmlsbCBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBtYXRjaGVkOiBmYWxzZSwgZmlsZXM6IFtdIH07XG4gIH1cbn1cblxuZnVuY3Rpb24gZ2V0Q29tbWl0UmVjb3JkcyhiYXNlUGF0aDogc3RyaW5nKTogQXJyYXk8eyBoYXNoOiBzdHJpbmc7IHBhcmVudHM6IHN0cmluZzsgY29tbWl0dGVkQXQ6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0+IHtcbiAgY29uc3QgbG9nT3V0cHV0ID0gZXhlY0ZpbGVTeW5jKFwiZ2l0XCIsIFtcImxvZ1wiLCBcIi0tZm9ybWF0PSVIJXgxZiVQJXgxZiVjSSV4MWYlQiV4MWVcIiwgXCJIRUFEXCJdLCB7XG4gICAgY3dkOiBiYXNlUGF0aCxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgfSk7XG4gIHJldHVybiBsb2dPdXRwdXRcbiAgICAuc3BsaXQoXCJcXHgxZVwiKVxuICAgIC5tYXAoKHJlY29yZCkgPT4gcmVjb3JkLnRyaW0oKSlcbiAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgLmZsYXRNYXAoKHJlY29yZCkgPT4ge1xuICAgICAgY29uc3QgcGFydHMgPSByZWNvcmQuc3BsaXQoXCJcXHgxZlwiKTtcbiAgICAgIGlmIChwYXJ0cy5sZW5ndGggPCA0KSByZXR1cm4gW107XG4gICAgICBjb25zdCBbaGFzaCwgcGFyZW50cywgY29tbWl0dGVkQXQsIC4uLm1lc3NhZ2VQYXJ0c10gPSBwYXJ0cztcbiAgICAgIHJldHVybiBbeyBoYXNoOiBoYXNoLnRyaW0oKSwgcGFyZW50czogcGFyZW50cy50cmltKCksIGNvbW1pdHRlZEF0OiBjb21taXR0ZWRBdC50cmltKCksIG1lc3NhZ2U6IG1lc3NhZ2VQYXJ0cy5qb2luKFwiXFx4MWZcIikgfV07XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGlzRnVsbENvbW1pdFNoYSh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAvXlswLTlhLWZdezQwfSQvaS50ZXN0KHZhbHVlKTtcbn1cblxuZnVuY3Rpb24gc2NhbkdzZFRhZ2dlZENvbW1pdHMoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIGdpdEFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdLFxuKTogeyBvazogYm9vbGVhbjsgbWF0Y2hlZDogYm9vbGVhbjsgZmlsZXM6IHN0cmluZ1tdIH0ge1xuICB0cnkge1xuICAgIGNvbnN0IGxvZ091dHB1dCA9IGV4ZWNGaWxlU3luYyhcImdpdFwiLCBbLi4uZ2l0QXJnc10sIHtcbiAgICAgIGN3ZDogYmFzZVBhdGgsXG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcInBpcGVcIl0sXG4gICAgICBlbmNvZGluZzogXCJ1dGYtOFwiLFxuICAgIH0pO1xuICAgIGNvbnN0IHJlY29yZHMgPSBsb2dPdXRwdXRcbiAgICAgIC5zcGxpdChcIlxceDFlXCIpXG4gICAgICAubWFwKChyZWNvcmQpID0+IHJlY29yZC50cmltKCkpXG4gICAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgICAuZmxhdE1hcCgocmVjb3JkKSA9PiB7XG4gICAgICAgIGNvbnN0IHNlcCA9IHJlY29yZC5pbmRleE9mKFwiXFx4MWZcIik7XG4gICAgICAgIGlmIChzZXAgPT09IC0xKSByZXR1cm4gW107XG4gICAgICAgIGNvbnN0IGhhc2ggPSByZWNvcmQuc2xpY2UoMCwgc2VwKS50cmltKCk7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSByZWNvcmQuc2xpY2Uoc2VwICsgMSk7XG4gICAgICAgIHJldHVybiBbeyBoYXNoLCBtZXNzYWdlIH1dO1xuICAgICAgfSk7XG5cbiAgICBjb25zdCBmaWxlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGxldCBtYXRjaGVkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCB7IGhhc2gsIG1lc3NhZ2UgfSBvZiByZWNvcmRzKSB7XG4gICAgICBpZiAoIWNvbW1pdE1lc3NhZ2VIYXNHc2RUcmFpbGVyKG1lc3NhZ2UpKSBjb250aW51ZTtcblxuICAgICAgY29uc3QgY29tbWl0RmlsZXMgPSBnZXRDaGFuZ2VkRmlsZXNGb3JDb21taXQoYmFzZVBhdGgsIGhhc2gpO1xuICAgICAgaWYgKCFjb21taXRNYXRjaGVzTWlsZXN0b25lKGJhc2VQYXRoLCBtZXNzYWdlLCBtaWxlc3RvbmVJZCwgY29tbWl0RmlsZXMpKSBjb250aW51ZTtcblxuICAgICAgbWF0Y2hlZCA9IHRydWU7XG4gICAgICBmb3IgKGNvbnN0IGZpbGUgb2YgY29tbWl0RmlsZXMpIHtcbiAgICAgICAgZmlsZXMuYWRkKGZpbGUpO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBtYXRjaGVkLCBmaWxlczogWy4uLmZpbGVzXSB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGBtaWxlc3RvbmUtdGFnZ2VkIGNvbW1pdCBzY2FuIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIG1hdGNoZWQ6IGZhbHNlLCBmaWxlczogW10gfTtcbiAgfVxufVxuXG5mdW5jdGlvbiBnZXRDaGFuZ2VkRmlsZXNGb3JDb21taXQoYmFzZVBhdGg6IHN0cmluZywgaGFzaDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBmaWxlT3V0cHV0ID0gZXhlY0ZpbGVTeW5jKFxuICAgIFwiZ2l0XCIsXG4gICAgW1wiZGlmZi10cmVlXCIsIFwiLS1yb290XCIsIFwiLS1uby1jb21taXQtaWRcIiwgXCItclwiLCBcIi0tbmFtZS1vbmx5XCIsIGhhc2hdLFxuICAgIHsgY3dkOiBiYXNlUGF0aCwgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJwaXBlXCJdLCBlbmNvZGluZzogXCJ1dGYtOFwiIH0sXG4gICkudHJpbSgpO1xuICByZXR1cm4gZmlsZU91dHB1dC5zcGxpdChcIlxcblwiKS5tYXAoKGYpID0+IGYudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7XG59XG5cbmZ1bmN0aW9uIGNvbW1pdE1lc3NhZ2VIYXNHc2RUcmFpbGVyKG1lc3NhZ2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gL15HU0QtKD86VGFza3xVbml0KTpcXHMqXFxTKy9tLnRlc3QobWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIGNvbW1pdE1hdGNoZXNNaWxlc3RvbmUoYmFzZVBhdGg6IHN0cmluZywgbWVzc2FnZTogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nLCBmaWxlczogcmVhZG9ubHkgc3RyaW5nW10pOiBib29sZWFuIHtcbiAgaWYgKGNvbW1pdFRyYWlsZXJTdGFydHNXaXRoTWlsZXN0b25lKG1lc3NhZ2UsIG1pbGVzdG9uZUlkKSkgcmV0dXJuIHRydWU7XG5cbiAgLy8gTWVhbmluZ2Z1bCBleGVjdXRlLXRhc2sgY29tbWl0cyBjdXJyZW50bHkgc3RvcmUgdGFzayBzY29wZSBhcyBTeHgvVHl5XG4gIC8vIHJhdGhlciB0aGFuIE14eC9TeHgvVHl5LiBCaW5kIHRob3NlIGNvbW1pdHMgYmFjayB0byB0aGUgbWlsZXN0b25lIHdoZW5cbiAgLy8gZWl0aGVyIHRoZSBjb21taXQgdG91Y2hlZCB0aGlzIG1pbGVzdG9uZSdzIGFydGlmYWN0cywgb3IgXHUyMDE0IGZvciBwcm9qZWN0c1xuICAvLyB3aGVyZSAuZ3NkLyBpcyBnaXRpZ25vcmVkL2V4dGVybmFsICgjNTAzMykgXHUyMDE0IHRoZSBtZXNzYWdlIGV4cGxpY2l0bHlcbiAgLy8gbmFtZXMgdGhlIG1pbGVzdG9uZSBvciBsb2NhbCBHU0Qgc3RhdGUgcHJvdmVzIHRoZSB0YXNrIGJlbG9uZ3MgaGVyZS5cbiAgaWYgKC9eR1NELVRhc2s6XFxzKlNbXi9cXHNdK1xcL1RcXFMrL20udGVzdChtZXNzYWdlKSkge1xuICAgIGlmIChmaWxlcy5zb21lKChmaWxlKSA9PiBpc01pbGVzdG9uZUFydGlmYWN0UGF0aChmaWxlLCBtaWxlc3RvbmVJZCkpKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAoY29tbWl0TWVzc2FnZU1lbnRpb25zTWlsZXN0b25lKG1lc3NhZ2UsIG1pbGVzdG9uZUlkKSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKGNvbW1pdFRhc2tUcmFpbGVyQmVsb25nc1RvTWlsZXN0b25lKGJhc2VQYXRoLCBtZXNzYWdlLCBtaWxlc3RvbmVJZCkpIHJldHVybiB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBjb21taXRUYXNrVHJhaWxlckJlbG9uZ3NUb01pbGVzdG9uZShiYXNlUGF0aDogc3RyaW5nLCBtZXNzYWdlOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbWF0Y2ggPSBtZXNzYWdlLm1hdGNoKC9eR1NELVRhc2s6XFxzKihTW14vXFxzXSspXFwvKFRbXlxcc10rKS9tKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBbLCBzbGljZUlkLCB0YXNrSWRdID0gbWF0Y2g7XG5cbiAgaWYgKGdldFRhc2sobWlsZXN0b25lSWQsIHNsaWNlSWQsIHRhc2tJZCkpIHJldHVybiB0cnVlO1xuXG4gIGNvbnN0IHRhc2tzRGlyID0gcmVzb2x2ZVRhc2tzRGlyKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCk7XG4gIGlmICghdGFza3NEaXIpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbih0YXNrc0RpciwgYCR7dGFza0lkfS1QTEFOLm1kYCkpXG4gICAgfHwgZXhpc3RzU3luYyhqb2luKHRhc2tzRGlyLCBgJHt0YXNrSWR9LVNVTU1BUlkubWRgKSk7XG59XG5cbmZ1bmN0aW9uIGNvbW1pdE1lc3NhZ2VNZW50aW9uc01pbGVzdG9uZShtZXNzYWdlOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKCFNSUxFU1RPTkVfSURfUkUudGVzdChtaWxlc3RvbmVJZCkpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBlc2NhcGVkTWlsZXN0b25lID0gbWlsZXN0b25lSWQucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xuICByZXR1cm4gbmV3IFJlZ0V4cChgXFxcXGIke2VzY2FwZWRNaWxlc3RvbmV9XFxcXGJgKS50ZXN0KG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiBjb21taXRUcmFpbGVyU3RhcnRzV2l0aE1pbGVzdG9uZShtZXNzYWdlOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgZXNjYXBlZE1pbGVzdG9uZSA9IG1pbGVzdG9uZUlkLnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXF1cXFxcXS9nLCBcIlxcXFwkJlwiKTtcbiAgY29uc3QgdHJhaWxlclBhdHRlcm4gPSBuZXcgUmVnRXhwKFxuICAgIGBeR1NELSg/OlRhc2t8VW5pdCk6XFxcXHMqJHtlc2NhcGVkTWlsZXN0b25lfSg/OiR8W1xcXFxzL10pYCxcbiAgICBcIm1cIixcbiAgKTtcbiAgcmV0dXJuIHRyYWlsZXJQYXR0ZXJuLnRlc3QobWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIGlzTWlsZXN0b25lQXJ0aWZhY3RQYXRoKGZpbGU6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZmlsZS5zdGFydHNXaXRoKGAuZ3NkL21pbGVzdG9uZXMvJHttaWxlc3RvbmVJZH0vYClcbiAgICB8fCBmaWxlLnN0YXJ0c1dpdGgoYC5nc2RcXFxcbWlsZXN0b25lc1xcXFwke21pbGVzdG9uZUlkfVxcXFxgKTtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIHRoZSBleHBlY3RlZCBhcnRpZmFjdChzKSBmb3IgYSB1bml0IGV4aXN0IG9uIGRpc2suXG4gKiBSZXR1cm5zIHRydWUgaWYgYWxsIHJlcXVpcmVkIGFydGlmYWN0cyBleGlzdCwgb3IgaWYgdGhlIHVuaXQgdHlwZSBoYXMgbm9cbiAqIHNpbmdsZSB2ZXJpZmlhYmxlIGFydGlmYWN0IChlLmcuLCByZXBsYW4tc2xpY2UpLlxuICpcbiAqIGNvbXBsZXRlLXNsaWNlIHJlcXVpcmVzIGJvdGggU1VNTUFSWSBhbmQgVUFUIGZpbGVzIFx1MjAxNCB2ZXJpZnlpbmcgb25seVxuICogdGhlIHN1bW1hcnkgYWxsb3dlZCB0aGUgdW5pdCB0byBiZSBtYXJrZWQgY29tcGxldGUgd2hlbiB0aGUgTExNXG4gKiBza2lwcGVkIHdyaXRpbmcgdGhlIFVBVCBmaWxlIChzZWUgIzE3NikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KFxuICB1bml0VHlwZTogc3RyaW5nLFxuICB1bml0SWQ6IHN0cmluZyxcbiAgYmFzZTogc3RyaW5nLFxuKTogYm9vbGVhbiB7XG4gIC8vIEhvb2sgdW5pdHMgaGF2ZSBubyBzdGFuZGFyZCBhcnRpZmFjdCBcdTIwMTQgYWx3YXlzIHBhc3MuIFRoZWlyIGxpZmVjeWNsZVxuICAvLyBpcyBtYW5hZ2VkIGJ5IHRoZSBob29rIGVuZ2luZSwgbm90IHRoZSBhcnRpZmFjdCB2ZXJpZmljYXRpb24gc3lzdGVtLlxuICBpZiAodW5pdFR5cGUuc3RhcnRzV2l0aChcImhvb2svXCIpKSByZXR1cm4gdHJ1ZTtcblxuICAvLyBDbGVhciBzdGFsZSBkaXJlY3RvcnkgbGlzdGluZyBjYWNoZSBBTkQgcGFyc2UgY2FjaGUgc28gYXJ0aWZhY3QgY2hlY2tzIHNlZVxuICAvLyBmcmVzaCBkaXNrIHN0YXRlICgjNDMxKS4gVGhlIHBhcnNlIGNhY2hlIG11c3QgYWxzbyBiZSBjbGVhcmVkIGJlY2F1c2VcbiAgLy8gY2FjaGVLZXkoKSB1c2VzIGxlbmd0aCArIGZpcnN0L2xhc3QgMTAwIGNoYXJzIFx1MjAxNCB3aGVuIGEgY2hlY2tib3ggY2hhbmdlc1xuICAvLyBmcm9tIFsgXSB0byBbeF0sIHRoZSBrZXkgY29sbGlkZXMgd2l0aCB0aGUgcHJlLWVkaXQgdmVyc2lvbiwgcmV0dXJuaW5nXG4gIC8vIHN0YWxlIHBhcnNlZCByZXN1bHRzIChlLmcuLCBzbGljZS5kb25lID0gZmFsc2Ugd2hlbiBpdCdzIGFjdHVhbGx5IHRydWUpLlxuICBjbGVhclBhdGhDYWNoZSgpO1xuICBjbGVhclBhcnNlQ2FjaGUoKTtcblxuICBpZiAodW5pdFR5cGUgPT09IFwicmV3cml0ZS1kb2NzXCIpIHtcbiAgICBjb25zdCBvdmVycmlkZXNQYXRoID0gcmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2UsIFwiT1ZFUlJJREVTXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhvdmVycmlkZXNQYXRoKSkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgY29udGVudCA9IHJlYWRGaWxlU3luYyhvdmVycmlkZXNQYXRoLCBcInV0Zi04XCIpO1xuICAgIHJldHVybiAhY29udGVudC5pbmNsdWRlcyhcIioqU2NvcGU6KiogYWN0aXZlXCIpO1xuICB9XG5cbiAgaWYgKHVuaXRUeXBlID09PSBcIndvcmtmbG93LXByZWZlcmVuY2VzXCIpIHtcbiAgICByZXR1cm4gaGFzQ2FwdHVyZWRXb3JrZmxvd1ByZWZzKGJhc2UpO1xuICB9XG5cbiAgaWYgKHVuaXRUeXBlID09PSBcImRpc2N1c3MtcHJvamVjdFwiKSB7XG4gICAgY29uc3QgcHJvamVjdFBhdGggPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgodW5pdFR5cGUsIHVuaXRJZCwgYmFzZSk7XG4gICAgcmV0dXJuICEhcHJvamVjdFBhdGggJiYgZXhpc3RzU3luYyhwcm9qZWN0UGF0aCkgJiYgdmFsaWRhdGVBcnRpZmFjdChwcm9qZWN0UGF0aCwgXCJwcm9qZWN0XCIpLm9rO1xuICB9XG5cbiAgaWYgKHVuaXRUeXBlID09PSBcImRpc2N1c3MtcmVxdWlyZW1lbnRzXCIpIHtcbiAgICBjb25zdCByZXF1aXJlbWVudHNQYXRoID0gcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoKHVuaXRUeXBlLCB1bml0SWQsIGJhc2UpO1xuICAgIHJldHVybiAhIXJlcXVpcmVtZW50c1BhdGggJiYgZXhpc3RzU3luYyhyZXF1aXJlbWVudHNQYXRoKSAmJiB2YWxpZGF0ZUFydGlmYWN0KHJlcXVpcmVtZW50c1BhdGgsIFwicmVxdWlyZW1lbnRzXCIpLm9rO1xuICB9XG5cbiAgaWYgKHVuaXRUeXBlID09PSBcInJlc2VhcmNoLWRlY2lzaW9uXCIpIHtcbiAgICByZXR1cm4gaGFzVmFsaWRSZXNlYXJjaERlY2lzaW9uKGJhc2UpO1xuICB9XG5cbiAgaWYgKHVuaXRUeXBlID09PSBcInJlc2VhcmNoLXByb2plY3RcIikge1xuICAgIHJldHVybiBoYXNDb21wbGV0ZVByb2plY3RSZXNlYXJjaChiYXNlKTtcbiAgfVxuXG4gIC8vIFJlYWN0aXZlLWV4ZWN1dGU6IHZlcmlmeSB0aGF0IGVhY2ggZGlzcGF0Y2hlZCB0YXNrJ3Mgc3VtbWFyeSBleGlzdHMuXG4gIC8vIFRoZSB1bml0SWQgZW5jb2RlcyB0aGUgYmF0Y2g6IFwie21pZH0ve3NpZH0vcmVhY3RpdmUrVDAyLFQwM1wiXG4gIGlmICh1bml0VHlwZSA9PT0gXCJyZWFjdGl2ZS1leGVjdXRlXCIpIHtcbiAgICBjb25zdCB7IG1pbGVzdG9uZTogbWlkLCBzbGljZTogc2lkLCB0YXNrOiBiYXRjaFBhcnQgfSA9IHBhcnNlVW5pdElkKHVuaXRJZCk7XG4gICAgaWYgKCFtaWQgfHwgIXNpZCB8fCAhYmF0Y2hQYXJ0KSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgcGx1c0lkeCA9IGJhdGNoUGFydC5pbmRleE9mKFwiK1wiKTtcbiAgICBpZiAocGx1c0lkeCA9PT0gLTEpIHtcbiAgICAgIC8vIExlZ2FjeSBmb3JtYXQgXCJyZWFjdGl2ZVwiIHdpdGhvdXQgYmF0Y2ggSURzIFx1MjAxNCBmYWxsIGJhY2sgdG8gXCJhbnkgc3VtbWFyeVwiXG4gICAgICBjb25zdCB0RGlyID0gcmVzb2x2ZVRhc2tzRGlyKGJhc2UsIG1pZCwgc2lkKTtcbiAgICAgIGlmICghdERpcikgcmV0dXJuIGZhbHNlO1xuICAgICAgY29uc3Qgc3VtbWFyeUZpbGVzID0gcmVzb2x2ZVRhc2tGaWxlcyh0RGlyLCBcIlNVTU1BUllcIik7XG4gICAgICByZXR1cm4gc3VtbWFyeUZpbGVzLmxlbmd0aCA+IDA7XG4gICAgfVxuXG4gICAgY29uc3QgYmF0Y2hJZHMgPSBiYXRjaFBhcnQuc2xpY2UocGx1c0lkeCArIDEpLnNwbGl0KFwiLFwiKS5maWx0ZXIoQm9vbGVhbik7XG4gICAgaWYgKGJhdGNoSWRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgY29uc3QgdERpciA9IHJlc29sdmVUYXNrc0RpcihiYXNlLCBtaWQsIHNpZCk7XG4gICAgaWYgKCF0RGlyKSByZXR1cm4gZmFsc2U7XG5cbiAgICBjb25zdCBleGlzdGluZ1N1bW1hcmllcyA9IG5ldyBTZXQoXG4gICAgICByZXNvbHZlVGFza0ZpbGVzKHREaXIsIFwiU1VNTUFSWVwiKS5tYXAoKGYpID0+XG4gICAgICAgIGYucmVwbGFjZSgvLVNVTU1BUllcXC5tZCQvaSwgXCJcIikudG9VcHBlckNhc2UoKSxcbiAgICAgICksXG4gICAgKTtcblxuICAgIC8vIEV2ZXJ5IGRpc3BhdGNoZWQgdGFzayBtdXN0IGhhdmUgYSBzdW1tYXJ5IGZpbGVcbiAgICBmb3IgKGNvbnN0IHRpZCBvZiBiYXRjaElkcykge1xuICAgICAgaWYgKCFleGlzdGluZ1N1bW1hcmllcy5oYXModGlkLnRvVXBwZXJDYXNlKCkpKSByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gR2F0ZS1ldmFsdWF0ZTogdmVyaWZ5IHRoYXQgZWFjaCBkaXNwYXRjaGVkIGdhdGUgaGFzIGJlZW4gcmVzb2x2ZWQgaW4gdGhlIERCLlxuICAvLyBUaGUgdW5pdElkIGVuY29kZXMgdGhlIGJhdGNoOiBcInttaWR9L3tzaWR9L2dhdGVzK1EzLFE0XCJcbiAgaWYgKHVuaXRUeXBlID09PSBcImdhdGUtZXZhbHVhdGVcIikge1xuICAgIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQsIHRhc2s6IGJhdGNoUGFydCB9ID0gcGFyc2VVbml0SWQodW5pdElkKTtcbiAgICBpZiAoIW1pZCB8fCAhc2lkIHx8ICFiYXRjaFBhcnQpIHJldHVybiBmYWxzZTtcblxuICAgIGNvbnN0IHBsdXNJZHggPSBiYXRjaFBhcnQuaW5kZXhPZihcIitcIik7XG4gICAgaWYgKHBsdXNJZHggPT09IC0xKSByZXR1cm4gdHJ1ZTsgLy8gbm8gc3BlY2lmaWMgZ2F0ZXMgZW5jb2RlZCBcdTIwMTQgcGFzc1xuXG4gICAgY29uc3QgZ2F0ZUlkcyA9IGJhdGNoUGFydC5zbGljZShwbHVzSWR4ICsgMSkuc3BsaXQoXCIsXCIpLmZpbHRlcihCb29sZWFuKTtcbiAgICBpZiAoZ2F0ZUlkcy5sZW5ndGggPT09IDApIHJldHVybiB0cnVlO1xuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBlbmRpbmcgPSBnZXRQZW5kaW5nR2F0ZXMobWlkLCBzaWQsIFwic2xpY2VcIik7XG4gICAgICBjb25zdCBwZW5kaW5nSWRzID0gbmV3IFNldChwZW5kaW5nLm1hcCgoZzogYW55KSA9PiBnLmdhdGVfaWQpKTtcbiAgICAgIC8vIEFsbCBkaXNwYXRjaGVkIGdhdGVzIG11c3Qgbm8gbG9uZ2VyIGJlIHBlbmRpbmdcbiAgICAgIGZvciAoY29uc3QgZ2lkIG9mIGdhdGVJZHMpIHtcbiAgICAgICAgaWYgKHBlbmRpbmdJZHMuaGFzKGdpZCkpIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIC8vIERCIHVuYXZhaWxhYmxlIFx1MjAxNCB0cmVhdCBhcyB2ZXJpZmllZCB0byBhdm9pZCBibG9ja2luZ1xuICAgICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGBnYXRlLWV2YWx1YXRlIERCIGNoZWNrIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgLy8gIzQ0MTQ6IHJlc2VhcmNoLXNsaWNlIHBhcmFsbGVsLXJlc2VhcmNoIHNlbnRpbmVsLiBUaGUgdW5pdElkXG4gIC8vIGB7bWlkfS9wYXJhbGxlbC1yZXNlYXJjaGAgaXMgbm90IGEgcmVhbCBzbGljZSBcdTIwMTQgaXQgdHJpZ2dlcnMgYSBzaW5nbGUgYWdlbnRcbiAgLy8gdGhhdCBmYW5zIG91dCByZXNlYXJjaCBhY3Jvc3MgbXVsdGlwbGUgc2xpY2VzLiBWZXJpZnkgc3VjY2VzcyBieSBjaGVja2luZ1xuICAvLyB0aGF0IGV2ZXJ5IHNsaWNlIHdoaWNoIHdhcyBcInJlc2VhcmNoLXJlYWR5XCIgaW4gdGhlIHJvYWRtYXAgbm93IGhhcyBhXG4gIC8vIFJFU0VBUkNIIGZpbGUuIFdpdGhvdXQgdGhpcywgcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoIHJldHVybnMgbnVsbCBhbmRcbiAgLy8gdGhlIHJldHJ5L2VzY2FsYXRpb24gbWFjaGluZXJ5IHNpbGVudGx5IHJlLWRpc3BhdGNoZXMgZm9yZXZlci5cbiAgLy9cbiAgLy8gIzQwNjg6IEFsc28gdHJlYXQgYSBQQVJBTExFTC1CTE9DS0VSIHBsYWNlaG9sZGVyIGFzIGEgdGVybWluYWwgY29tcGxldGlvblxuICAvLyBzbyB0aGF0IHRpbWVvdXQtcmVjb3ZlcnkgY2FuIHdyaXRlIHRoZSBibG9ja2VyLCBoYXZlIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3RcbiAgLy8gcmV0dXJuIHRydWUsIGFuZCBsZXQgdGhlIGRpc3BhdGNoIGxvb3AgYWR2YW5jZSBwYXN0IHRoaXMgdW5pdC4gIFdpdGhvdXRcbiAgLy8gdGhpcywgdGhlIGJsb2NrZXIgaXMgd3JpdHRlbiBidXQgdmVyaWZpY2F0aW9uIHN0aWxsIHJldHVybnMgZmFsc2UsIHRoZSB1bml0XG4gIC8vIGlzIG5ldmVyIGNsZWFyZWQgZnJvbSB1bml0RGlzcGF0Y2hDb3VudCwgYW5kIG9uIHRoZSBuZXh0IGl0ZXJhdGlvbiB0aGVcbiAgLy8gZGlzcGF0Y2ggcnVsZSAod2hpY2ggY29ycmVjdGx5IHNraXBzIHBhcmFsbGVsLXJlc2VhcmNoIHdoZW4gUEFSQUxMRUwtQkxPQ0tFUlxuICAvLyBleGlzdHMpIHJldHVybnMgbnVsbCBcdTIwMTQgbGVhdmluZyB0aGUgbG9vcCBzdHVjayByZS1kZXJpdmluZyBpbmRlZmluaXRlbHkuXG4gIC8vXG4gIC8vIE5PVEU6IHRoaXMgcHJlZGljYXRlIG1pcnJvcnMgdGhlIGRpc3BhdGNoIHJ1bGUgYXRcbiAgLy8gYXV0by1kaXNwYXRjaC50cyBwYXJhbGxlbC1yZXNlYXJjaC1zbGljZXMgXHUyMDE0IGtlZXAgdGhlIHR3byBpbiBzeW5jLlxuICBpZiAodW5pdFR5cGUgPT09IFwicmVzZWFyY2gtc2xpY2VcIiAmJiB1bml0SWQuZW5kc1dpdGgoXCIvcGFyYWxsZWwtcmVzZWFyY2hcIikpIHtcbiAgICBjb25zdCB7IG1pbGVzdG9uZTogbWlkIH0gPSBwYXJzZVVuaXRJZCh1bml0SWQpO1xuICAgIGlmICghbWlkKSByZXR1cm4gZmFsc2U7XG5cbiAgICAvLyAjNDA2ODogUEFSQUxMRUwtQkxPQ0tFUiB3cml0dGVuIGJ5IHRpbWVvdXQtcmVjb3ZlcnkgaXMgYSB0ZXJtaW5hbCBzdGF0ZS5cbiAgICBjb25zdCBibG9ja2VyUGF0aCA9IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCh1bml0VHlwZSwgdW5pdElkLCBiYXNlKTtcbiAgICBpZiAoYmxvY2tlclBhdGggJiYgZXhpc3RzU3luYyhibG9ja2VyUGF0aCkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHJvYWRtYXBGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlJPQURNQVBcIik7XG4gICAgaWYgKCFyb2FkbWFwRmlsZSB8fCAhZXhpc3RzU3luYyhyb2FkbWFwRmlsZSkpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJyZWNvdmVyeVwiLCBgdmVyaWZ5LWZhaWwgJHt1bml0VHlwZX0gJHt1bml0SWR9OiByb2FkbWFwIG1pc3NpbmdgKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJvYWRtYXAgPSBwYXJzZUxlZ2FjeVJvYWRtYXAocmVhZEZpbGVTeW5jKHJvYWRtYXBGaWxlLCBcInV0Zi04XCIpKTtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZVJlc2VhcmNoRmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJSRVNFQVJDSFwiKTtcbiAgICAgIGZvciAoY29uc3Qgc2xpY2Ugb2Ygcm9hZG1hcC5zbGljZXMpIHtcbiAgICAgICAgaWYgKHNsaWNlLmRvbmUpIGNvbnRpbnVlO1xuICAgICAgICBpZiAobWlsZXN0b25lUmVzZWFyY2hGaWxlICYmIHNsaWNlLmlkID09PSBcIlMwMVwiKSBjb250aW51ZTtcbiAgICAgICAgY29uc3QgZGVwc0NvbXBsZXRlID0gKHNsaWNlLmRlcGVuZHMgPz8gW10pLmV2ZXJ5KChkZXBJZCkgPT5cbiAgICAgICAgICAhIXJlc29sdmVTbGljZUZpbGUoYmFzZSwgbWlkLCBkZXBJZCwgXCJTVU1NQVJZXCIpLFxuICAgICAgICApO1xuICAgICAgICBpZiAoIWRlcHNDb21wbGV0ZSkgY29udGludWU7XG4gICAgICAgIGlmICghcmVzb2x2ZVNsaWNlRmlsZShiYXNlLCBtaWQsIHNsaWNlLmlkLCBcIlJFU0VBUkNIXCIpKSB7XG4gICAgICAgICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGB2ZXJpZnktZmFpbCAke3VuaXRUeXBlfSAke3VuaXRJZH06IHNsaWNlICR7c2xpY2UuaWR9IG1pc3NpbmcgUkVTRUFSQ0hgKTtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGBwYXJhbGxlbC1yZXNlYXJjaCB2ZXJpZmljYXRpb24gZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBhYnNQYXRoID0gcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoKHVuaXRUeXBlLCB1bml0SWQsIGJhc2UpO1xuICAvLyBGb3IgdW5pdCB0eXBlcyB3aXRoIG5vIHZlcmlmaWFibGUgYXJ0aWZhY3QgKG51bGwgcGF0aCksIHRoZSBwYXJlbnQgZGlyZWN0b3J5XG4gIC8vIGlzIG1pc3Npbmcgb24gZGlzayBcdTIwMTQgdHJlYXQgYXMgc3RhbGUgY29tcGxldGlvbiBzdGF0ZSBzbyB0aGUga2V5IGdldHMgZXZpY3RlZCAoIzMxMykuXG4gIGlmICghYWJzUGF0aCkge1xuICAgIGxvZ1dhcm5pbmcoXCJyZWNvdmVyeVwiLCBgdmVyaWZ5LWZhaWwgJHt1bml0VHlwZX0gJHt1bml0SWR9OiByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGggcmV0dXJuZWQgbnVsbCAocGFyZW50IGRpciBtaXNzaW5nKWApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAoIWV4aXN0c1N5bmMoYWJzUGF0aCkpIHtcbiAgICBjb25zdCB3b3JrdHJlZUZhaWx1cmUgPSBkaWFnbm9zZVdvcmt0cmVlSW50ZWdyaXR5RmFpbHVyZShiYXNlKTtcbiAgICBpZiAod29ya3RyZWVGYWlsdXJlKSB7XG4gICAgICBsb2dFcnJvcihcInJlY292ZXJ5XCIsIGAke3dvcmt0cmVlRmFpbHVyZX0gVW5pdDogJHt1bml0VHlwZX0gJHt1bml0SWR9LmApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYHZlcmlmeS1mYWlsICR7dW5pdFR5cGV9ICR7dW5pdElkfTogZXhpc3RzU3luYyBmYWxzZSBmb3IgJHthYnNQYXRofWApO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmICh1bml0VHlwZSA9PT0gXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIikge1xuICAgIGNvbnN0IHZhbGlkYXRpb25Db250ZW50ID0gcmVhZEZpbGVTeW5jKGFic1BhdGgsIFwidXRmLThcIik7XG4gICAgaWYgKCFpc1ZhbGlkYXRpb25UZXJtaW5hbCh2YWxpZGF0aW9uQ29udGVudCkpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJyZWNvdmVyeVwiLCBgdmVyaWZ5LWZhaWwgJHt1bml0VHlwZX0gJHt1bml0SWR9OiB2YWxpZGF0aW9uIG5vdCB0ZXJtaW5hbCAobGVuPSR7dmFsaWRhdGlvbkNvbnRlbnQubGVuZ3RofSkgYXQgJHthYnNQYXRofWApO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIGlmICh1bml0VHlwZSA9PT0gXCJwbGFuLW1pbGVzdG9uZVwiKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJvYWRtYXAgPSBwYXJzZUxlZ2FjeVJvYWRtYXAocmVhZEZpbGVTeW5jKGFic1BhdGgsIFwidXRmLThcIikpO1xuICAgICAgaWYgKHJvYWRtYXAuc2xpY2VzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYHZlcmlmeS1mYWlsICR7dW5pdFR5cGV9ICR7dW5pdElkfTogcm9hZG1hcCBoYXMgemVybyBzbGljZXMgYXQgJHthYnNQYXRofWApO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYHBsYW4tbWlsZXN0b25lIHJvYWRtYXAgdmVyaWZpY2F0aW9uIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLy8gcGxhbi1zbGljZSB2ZXJpZmljYXRpb24gaXMgREItcHJpbWFyeS4gVGhlIHNsaWNlIHBsYW4gaXMgYSBwcm9qZWN0aW9uLCBzb1xuICAvLyBEQiB0YXNrIHJvd3MgcHJvdmUgdGhlIHNsaWNlIHdhcyBwbGFubmVkIGV2ZW4gaWYgdGhlIHJlbmRlcmVkIG1hcmtkb3duIG5vXG4gIC8vIGxvbmdlciB1c2VzIGxlZ2FjeSBjaGVja2JveC9oZWFkaW5nIHN5bnRheC5cbiAgaWYgKHVuaXRUeXBlID09PSBcInBsYW4tc2xpY2VcIikge1xuICAgIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQgfSA9IHBhcnNlVW5pdElkKHVuaXRJZCk7XG4gICAgaWYgKG1pZCAmJiBzaWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGxldCB0YXNrSWRzOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuICAgICAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgICAgY29uc3QgcmVmcmVzaGVkID0gcmVmcmVzaE9wZW5EYXRhYmFzZUZyb21EaXNrKCk7XG4gICAgICAgICAgaWYgKHJlZnJlc2hlZCkge1xuICAgICAgICAgICAgY29uc3QgdGFza3MgPSBnZXRTbGljZVRhc2tzKG1pZCwgc2lkKTtcbiAgICAgICAgICAgIGlmICh0YXNrcy5sZW5ndGggPiAwKSB0YXNrSWRzID0gdGFza3MubWFwKHQgPT4gdC5pZCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0YXNrSWRzKSB7XG4gICAgICAgICAgLy8gTEVHQUNZOiBEQiB1bmF2YWlsYWJsZSBvciBubyB0YXNrcyBpbiBEQi4gUmVxdWlyZSBhY3R1YWwgdGFza1xuICAgICAgICAgIC8vIGVudHJpZXMgc28gYW4gZW1wdHkgc2NhZmZvbGQgY2Fubm90IGFkdmFuY2UgdGhlIHBpcGVsaW5lICgjNjk5KS5cbiAgICAgICAgICBjb25zdCBwbGFuQ29udGVudCA9IHJlYWRGaWxlU3luYyhhYnNQYXRoLCBcInV0Zi04XCIpO1xuICAgICAgICAgIGNvbnN0IGhhc0NoZWNrYm94VGFzayA9IC9eXFxzKi0gXFxbW3hYIF1cXF0gXFwqXFwqVFxcZCs6L20udGVzdChwbGFuQ29udGVudCk7XG4gICAgICAgICAgY29uc3QgaGFzSGVhZGluZ1Rhc2sgPSAvXlxccyojezIsNH1cXHMrVFxcZCtcXHMqKD86LS18XHUyMDE0fDopL20udGVzdChwbGFuQ29udGVudCk7XG4gICAgICAgICAgaWYgKCFoYXNDaGVja2JveFRhc2sgJiYgIWhhc0hlYWRpbmdUYXNrKSB7XG4gICAgICAgICAgICBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYHZlcmlmeS1mYWlsICR7dW5pdFR5cGV9ICR7dW5pdElkfTogcGxhbiBoYXMgbm8gdGFzayBjaGVja2JveC9oZWFkaW5nIChsZW49JHtwbGFuQ29udGVudC5sZW5ndGh9KSBhdCAke2Fic1BhdGh9YCk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHBsYW4gPSBwYXJzZUxlZ2FjeVBsYW4ocGxhbkNvbnRlbnQpO1xuICAgICAgICAgIGlmIChwbGFuLnRhc2tzLmxlbmd0aCA+IDApIHRhc2tJZHMgPSBwbGFuLnRhc2tzLm1hcCgodDogeyBpZDogc3RyaW5nIH0pID0+IHQuaWQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHRhc2tJZHMgJiYgdGFza0lkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY29uc3QgdGFza3NEaXIgPSByZXNvbHZlVGFza3NEaXIoYmFzZSwgbWlkLCBzaWQpO1xuICAgICAgICAgIGlmICghdGFza3NEaXIpIHtcbiAgICAgICAgICAgIGxvZ1dhcm5pbmcoXCJyZWNvdmVyeVwiLCBgdmVyaWZ5LWZhaWwgJHt1bml0VHlwZX0gJHt1bml0SWR9OiByZXNvbHZlVGFza3NEaXIgcmV0dXJuZWQgbnVsbCBmb3IgJHttaWR9LyR7c2lkfWApO1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBmb3IgKGNvbnN0IHRpZCBvZiB0YXNrSWRzKSB7XG4gICAgICAgICAgICBjb25zdCB0YXNrUGxhbkZpbGUgPSBqb2luKHRhc2tzRGlyLCBgJHt0aWR9LVBMQU4ubWRgKTtcbiAgICAgICAgICAgIGlmICghZXhpc3RzU3luYyh0YXNrUGxhbkZpbGUpKSB7XG4gICAgICAgICAgICAgIGxvZ1dhcm5pbmcoXCJyZWNvdmVyeVwiLCBgdmVyaWZ5LWZhaWwgJHt1bml0VHlwZX0gJHt1bml0SWR9OiB0YXNrIHBsYW4gbWlzc2luZyAke3Rhc2tQbGFuRmlsZX1gKTtcbiAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIC8vIFBhcnNlIGZhaWx1cmUgXHUyMDE0IGRvbid0IGJsb2NrOyBzbGljZSBwbGFuIG1heSBoYXZlIG5vbi1zdGFuZGFyZCBmb3JtYXRcbiAgICAgICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGBwbGFuLXNsaWNlIHRhc2sgcGxhbiB2ZXJpZmljYXRpb24gZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBleGVjdXRlLXRhc2s6IERCIHN0YXR1cyBpcyBhdXRob3JpdGF0aXZlLiBGYWxsIGJhY2sgdG8gY2hlY2tlZC1jaGVja2JveFxuICAvLyBkZXRlY3Rpb24gd2hlbiB0aGUgREIgaXMgdW5hdmFpbGFibGUgKHVubWlncmF0ZWQgcHJvamVjdHMpLCBvciB3aGVuIHRoZVxuICAvLyBkaXNrIGFydGlmYWN0cyBhbHJlYWR5IHJlZmxlY3QgY29tcGxldGlvbiBidXQgdGhlIERCIHJlcGxheSBpcyBvbmUgYmVhdFxuICAvLyBiZWhpbmQgdGhlIGNvbXBsZXRpb24gd3JpdGUuXG4gIGlmICh1bml0VHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIikge1xuICAgIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQsIHRhc2s6IHRpZCB9ID0gcGFyc2VVbml0SWQodW5pdElkKTtcbiAgICBpZiAobWlkICYmIHNpZCAmJiB0aWQpIHtcbiAgICAgIGNvbnN0IGRiVGFzayA9IGdldFRhc2sobWlkLCBzaWQsIHRpZCk7XG4gICAgICBpZiAoZGJUYXNrKSB7XG4gICAgICAgIGlmIChkYlRhc2suc3RhdHVzICE9PSBcImNvbXBsZXRlXCIgJiYgZGJUYXNrLnN0YXR1cyAhPT0gXCJkb25lXCIgJiYgIWhhc0NoZWNrZWRUYXNrQ29tcGxldGlvbk9uRGlzayhiYXNlLCBtaWQsIHNpZCwgdGlkKSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmICghaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgIC8vIExFR0FDWTogUHJlLW1pZ3JhdGlvbiBmYWxsYmFjayBmb3IgcHJvamVjdHMgd2l0aG91dCBEQi5cbiAgICAgICAgLy8gUmVxdWlyZSBhIENIRUNLRUQgY2hlY2tib3ggXHUyMDE0IGEgYmFyZSBoZWFkaW5nIG9yIHVuY2hlY2tlZCBjaGVja2JveFxuICAgICAgICAvLyBkb2VzIG5vdCBwcm92ZSBnc2RfY29tcGxldGVfdGFzayByYW4uIFN1bW1hcnkgZmlsZSBvbiBkaXNrIGFsb25lXG4gICAgICAgIC8vIGlzIG5vdCBzdWZmaWNpZW50IGV2aWRlbmNlIChjb3VsZCBiZSBhIHJvZ3VlIHdyaXRlKSAoIzM2MDcpLlxuICAgICAgICBpZiAoIWhhc0NoZWNrZWRUYXNrQ29tcGxldGlvbk9uRGlzayhiYXNlLCBtaWQsIHNpZCwgdGlkKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gREIgYXZhaWxhYmxlIGJ1dCB0YXNrIHJvdyBub3QgZm91bmQgXHUyMDE0IGNvbXBsZXRpb24gdG9vbCBuZXZlciByYW4gKCMzNjA3KVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gY29tcGxldGUtc2xpY2U6IERCIHN0YXR1cyBpcyBhdXRob3JpdGF0aXZlIGZvciB3aGV0aGVyIHRoZSBzbGljZSBpcyBkb25lLlxuICAvLyBGYWxsIGJhY2sgdG8gZmlsZS1iYXNlZCBjaGVjayAocm9hZG1hcCBbeF0pIHdoZW4gREIgaXMgdW5hdmFpbGFibGUuXG4gIGlmICh1bml0VHlwZSA9PT0gXCJjb21wbGV0ZS1zbGljZVwiKSB7XG4gICAgY29uc3QgeyBtaWxlc3RvbmU6IG1pZCwgc2xpY2U6IHNpZCB9ID0gcGFyc2VVbml0SWQodW5pdElkKTtcbiAgICBpZiAobWlkICYmIHNpZCkge1xuICAgICAgY29uc3QgZGlyID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlLCBtaWQsIHNpZCk7XG4gICAgICBpZiAoZGlyKSB7XG4gICAgICAgIGNvbnN0IHVhdFBhdGggPSBqb2luKGRpciwgYnVpbGRTbGljZUZpbGVOYW1lKHNpZCwgXCJVQVRcIikpO1xuICAgICAgICBpZiAoIWV4aXN0c1N5bmModWF0UGF0aCkpIHJldHVybiBmYWxzZTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZGJTbGljZSA9IGdldFNsaWNlKG1pZCwgc2lkKTtcbiAgICAgIGlmIChkYlNsaWNlKSB7XG4gICAgICAgIC8vIERCIGF2YWlsYWJsZSBcdTIwMTQgdHJ1c3QgaXRcbiAgICAgICAgaWYgKGRiU2xpY2Uuc3RhdHVzICE9PSBcImNvbXBsZXRlXCIpIHJldHVybiBmYWxzZTtcbiAgICAgIH0gZWxzZSBpZiAoIWlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICAvLyBMRUdBQ1k6IFByZS1taWdyYXRpb24gZmFsbGJhY2sgZm9yIHByb2plY3RzIHdpdGhvdXQgREIuXG4gICAgICAgIC8vIEZhbGwgYmFjayB0byByb2FkbWFwIGNoZWNrYm94IGNoZWNrIHZpYSBwYXJzZXJzLWxlZ2FjeVxuICAgICAgICBjb25zdCByb2FkbWFwRmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICAgICAgICBpZiAocm9hZG1hcEZpbGUgJiYgZXhpc3RzU3luYyhyb2FkbWFwRmlsZSkpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgcm9hZG1hcENvbnRlbnQgPSByZWFkRmlsZVN5bmMocm9hZG1hcEZpbGUsIFwidXRmLThcIik7XG4gICAgICAgICAgICBjb25zdCByb2FkbWFwID0gcGFyc2VMZWdhY3lSb2FkbWFwKHJvYWRtYXBDb250ZW50KTtcbiAgICAgICAgICAgIGNvbnN0IHNsaWNlID0gcm9hZG1hcC5zbGljZXMuZmluZCgocykgPT4gcy5pZCA9PT0gc2lkKTtcbiAgICAgICAgICAgIGlmIChzbGljZSAmJiAhc2xpY2UuZG9uZSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGxvZ1dhcm5pbmcoXCJyZWNvdmVyeVwiLCBgcm9hZG1hcCBwYXJzZSBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBlbHNlOiBEQiBhdmFpbGFibGUgYnV0IHNsaWNlIG5vdCBmb3VuZCBcdTIwMTQgc3VtbWFyeSArIFVBVCBleGlzdCxcbiAgICAgIC8vIHRyZWF0IGFzIHZlcmlmaWVkIChzbGljZSBtYXkgbm90IGJlIGltcG9ydGVkIHlldClcbiAgICB9XG4gIH1cblxuICAvLyBjb21wbGV0ZS1taWxlc3RvbmUgbXVzdCBoYXZlIHByb2R1Y2VkIGltcGxlbWVudGF0aW9uIGFydGlmYWN0cyAoIzE3MDMpLlxuICAvLyBBIG1pbGVzdG9uZSB3aXRoIG9ubHkgLmdzZC8gcGxhbiBmaWxlcyBhbmQgemVybyBpbXBsZW1lbnRhdGlvbiBjb2RlIGlzXG4gIC8vIG5vdCBnZW51aW5lbHkgY29tcGxldGUgXHUyMDE0IHRoZSBMTE0gd3JvdGUgcGxhbiBmaWxlcyBidXQgc2tpcHBlZCBhY3R1YWwgd29yay5cbiAgaWYgKHVuaXRUeXBlID09PSBcImNvbXBsZXRlLW1pbGVzdG9uZVwiKSB7XG4gICAgY29uc3Qgc3VtbWFyeU91dGNvbWUgPSBjbGFzc2lmeU1pbGVzdG9uZVN1bW1hcnlDb250ZW50KHJlYWRGaWxlU3luYyhhYnNQYXRoLCBcInV0Zi04XCIpKTtcbiAgICBpZiAoc3VtbWFyeU91dGNvbWUgPT09IFwiZmFpbHVyZVwiKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgeyBtaWxlc3RvbmU6IG1pZCB9ID0gcGFyc2VVbml0SWQodW5pdElkKTtcbiAgICBpZiAobWlkICYmIGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgY29uc3QgZGJNaWxlc3RvbmUgPSBnZXRNaWxlc3RvbmUobWlkKTtcbiAgICAgIGlmICghZGJNaWxlc3RvbmUpIHJldHVybiBmYWxzZTtcbiAgICAgIGlmICghaXNDbG9zZWRTdGF0dXMoZGJNaWxlc3RvbmUuc3RhdHVzKSAmJiBzdW1tYXJ5T3V0Y29tZSAhPT0gXCJzdWNjZXNzXCIpIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKGhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzKGJhc2UsIG1pZCkgPT09IFwiYWJzZW50XCIpIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHJldHVybiB0cnVlO1xufVxuXG4vKipcbiAqIFdyaXRlIGEgcGxhY2Vob2xkZXIgYXJ0aWZhY3Qgc28gdGhlIHBpcGVsaW5lIGNhbiBhZHZhbmNlIHBhc3QgYSBzdHVjayB1bml0LlxuICogUmV0dXJucyB0aGUgcmVsYXRpdmUgcGF0aCB3cml0dGVuLCBvciBudWxsIGlmIHRoZSBwYXRoIGNvdWxkbid0IGJlIHJlc29sdmVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gd3JpdGVCbG9ja2VyUGxhY2Vob2xkZXIoXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICBiYXNlOiBzdHJpbmcsXG4gIHJlYXNvbjogc3RyaW5nLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGFic1BhdGggPSByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgodW5pdFR5cGUsIHVuaXRJZCwgYmFzZSk7XG4gIGlmICghYWJzUGF0aCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGRpciA9IGRpcm5hbWUoYWJzUGF0aCk7XG4gIGlmICghZXhpc3RzU3luYyhkaXIpKSBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgY29uc3QgcmVjb3ZlcnlMaW5lID0gdW5pdFR5cGUgPT09IFwicmVzZWFyY2gtcHJvamVjdFwiXG4gICAgPyBcIlRoaXMgcGxhY2Vob2xkZXIgd2FzIHdyaXR0ZW4gYnkgYXV0by1tb2RlIHNvIHRoZSBwcm9qZWN0IHJlc2VhcmNoIGdhdGUgY2FuIHN0b3AgZmFpbC1jbG9zZWQuXCJcbiAgICA6IFwiVGhpcyBwbGFjZWhvbGRlciB3YXMgd3JpdHRlbiBieSBhdXRvLW1vZGUgc28gdGhlIHBpcGVsaW5lIGNhbiBhZHZhbmNlLlwiO1xuICBjb25zdCBjb250ZW50ID0gW1xuICAgIGAjIEJMT0NLRVIgXHUyMDE0IGF1dG8tbW9kZSByZWNvdmVyeSBmYWlsZWRgLFxuICAgIGBgLFxuICAgIGBVbml0IFxcYCR7dW5pdFR5cGV9XFxgIGZvciBcXGAke3VuaXRJZH1cXGAgZmFpbGVkIHRvIHByb2R1Y2UgdGhpcyBhcnRpZmFjdCBhZnRlciBpZGxlIHJlY292ZXJ5IGV4aGF1c3RlZCBhbGwgcmV0cmllcy5gLFxuICAgIGBgLFxuICAgIGAqKlJlYXNvbioqOiAke3JlYXNvbn1gLFxuICAgIGBgLFxuICAgIHJlY292ZXJ5TGluZSxcbiAgICBgUmV2aWV3IGFuZCByZXBsYWNlIHRoaXMgZmlsZSBiZWZvcmUgcmVseWluZyBvbiBkb3duc3RyZWFtIGFydGlmYWN0cy5gLFxuICBdLmpvaW4oXCJcXG5cIik7XG4gIHdyaXRlRmlsZVN5bmMoYWJzUGF0aCwgY29udGVudCwgXCJ1dGYtOFwiKTtcblxuICAvLyAjNDQxNDogQ2xlYXIgY2FjaGVzIHNvIHN1YnNlcXVlbnQgZGlzcGF0Y2ggZ3VhcmRzIChlLmcuXG4gIC8vIHJlc29sdmVNaWxlc3RvbmVGaWxlKSBzZWUgdGhlIHBsYWNlaG9sZGVyIGZpbGUuIFdpdGhvdXQgdGhpcywgdGhlXG4gIC8vIGNhY2hlZCBkaXJlY3RvcnkgbGlzdGluZyBpcyBzdGFsZSBhbmQgdGhlIGRpc3BhdGNoIHJ1bGUgcmUtZmlyZXMsXG4gIC8vIHByb2R1Y2luZyBhbiBpbmZpbml0ZSBsb29wIGRlc3BpdGUgdGhlIHBsYWNlaG9sZGVyIGJlaW5nIG9uIGRpc2suXG4gIC8vIE1hdGNoZXMgdGhlIHBhdHRlcm4gdXNlZCBpbiB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IGFib3ZlLlxuICBjbGVhclBhdGhDYWNoZSgpO1xuICBjbGVhclBhcnNlQ2FjaGUoKTtcblxuICAvLyBNYXJrIHRoZSB0YXNrL3NsaWNlIGFzIGNvbXBsZXRlIGluIHRoZSBEQiBzbyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IHBhc3Nlcy5cbiAgLy8gV2l0aG91dCB0aGlzLCB0aGUgREIgc3RhdHVzIHN0YXlzIFwicGVuZGluZ1wiIGFuZCB0aGUgZGlzcGF0Y2ggbG9vcFxuICAvLyByZS1kZXJpdmVzIHRoZSBzYW1lIHVuaXQgaW5kZWZpbml0ZWx5ICgjMjUzMSwgIzI2NTMpLlxuICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgY29uc3QgeyBtaWxlc3RvbmU6IG1pZCwgc2xpY2U6IHNpZCwgdGFzazogdGlkIH0gPSBwYXJzZVVuaXRJZCh1bml0SWQpO1xuICAgIGNvbnN0IHRzID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuICAgIGlmICh1bml0VHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIiAmJiBtaWQgJiYgc2lkICYmIHRpZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgdXBkYXRlVGFza1N0YXR1cyhtaWQsIHNpZCwgdGlkLCBcImNvbXBsZXRlXCIsIHRzKTtcbiAgICAgICAgY29uc3QgcGxhblBhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgc2lkLCBcIlBMQU5cIik7XG4gICAgICAgIGlmIChwbGFuUGF0aCAmJiBleGlzdHNTeW5jKHBsYW5QYXRoKSkge1xuICAgICAgICAgIGNvbnN0IHBsYW5Db250ZW50ID0gcmVhZEZpbGVTeW5jKHBsYW5QYXRoLCBcInV0Zi04XCIpO1xuICAgICAgICAgIGNvbnN0IHVwZGF0ZWRQbGFuID0gcGxhbkNvbnRlbnQucmVwbGFjZShcbiAgICAgICAgICAgIG5ldyBSZWdFeHAoYF4oXFxcXHMqLVxcXFxzKylcXFxcWyBcXFxcXVxcXFxzK1xcXFwqXFxcXCoke3RpZH06YCwgXCJtXCIpLFxuICAgICAgICAgICAgYCQxW3hdICoqJHt0aWR9OmAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBpZiAodXBkYXRlZFBsYW4gIT09IHBsYW5Db250ZW50KSB7XG4gICAgICAgICAgICBhdG9taWNXcml0ZVN5bmMocGxhblBhdGgsIHVwZGF0ZWRQbGFuKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGB1cGRhdGVUYXNrU3RhdHVzIGZhaWxlZCBkdXJpbmcgY29udGV4dCBleGhhdXN0aW9uOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gKTtcbiAgICAgIH1cbiAgICAgIC8vIEFwcGVuZCBldmVudCBzbyB3b3JrdHJlZSByZWNvbmNpbGlhdGlvbiBjYW4gcmVwbGF5IHRoaXMgcmVjb3ZlcnkgY29tcGxldGlvblxuICAgICAgdHJ5IHsgYXBwZW5kRXZlbnQoYmFzZSwgeyBjbWQ6IFwiY29tcGxldGUtdGFza1wiLCBwYXJhbXM6IHsgbWlsZXN0b25lSWQ6IG1pZCwgc2xpY2VJZDogc2lkLCB0YXNrSWQ6IHRpZCB9LCB0cywgYWN0b3I6IFwic3lzdGVtXCIsIHRyaWdnZXJfcmVhc29uOiBcImJsb2NrZXItcGxhY2Vob2xkZXItcmVjb3ZlcnlcIiB9KTsgfSBjYXRjaCAoZSkgeyBsb2dXYXJuaW5nKFwicmVjb3ZlcnlcIiwgYGFwcGVuZEV2ZW50IGZhaWxlZCBmb3IgdGFzayByZWNvdmVyeTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7IH1cbiAgICB9XG4gICAgaWYgKHVuaXRUeXBlID09PSBcImNvbXBsZXRlLXNsaWNlXCIgJiYgbWlkICYmIHNpZCkge1xuICAgICAgdHJ5IHsgdXBkYXRlU2xpY2VTdGF0dXMobWlkLCBzaWQsIFwiY29tcGxldGVcIiwgdHMpOyB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJyZWNvdmVyeVwiLCBgdXBkYXRlU2xpY2VTdGF0dXMgZmFpbGVkIGR1cmluZyBjb250ZXh0IGV4aGF1c3Rpb246ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWApOyB9XG4gICAgICB0cnkgeyBhcHBlbmRFdmVudChiYXNlLCB7IGNtZDogXCJjb21wbGV0ZS1zbGljZVwiLCBwYXJhbXM6IHsgbWlsZXN0b25lSWQ6IG1pZCwgc2xpY2VJZDogc2lkIH0sIHRzLCBhY3RvcjogXCJzeXN0ZW1cIiwgdHJpZ2dlcl9yZWFzb246IFwiYmxvY2tlci1wbGFjZWhvbGRlci1yZWNvdmVyeVwiIH0pOyB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJyZWNvdmVyeVwiLCBgYXBwZW5kRXZlbnQgZmFpbGVkIGZvciBzbGljZSByZWNvdmVyeTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7IH1cbiAgICB9XG4gICAgLy8gSW5zZXJ0IGEgcGxhY2Vob2xkZXIgY29tcGxldGUgc2xpY2Ugc28gZGVyaXZlU3RhdGUgc2VlcyBhY3RpdmVNaWxlc3RvbmVTbGljZXMubGVuZ3RoID4gMFxuICAgIC8vIGFuZCBleGl0cyB0aGUgcHJlLXBsYW5uaW5nIHBoYXNlLiBXaXRob3V0IHRoaXMsIGFjdGl2ZU1pbGVzdG9uZVNsaWNlcyBzdGF5cyBlbXB0eVxuICAgIC8vIGFmdGVyIHRoZSBibG9ja2VyIFJPQURNQVAubWQgaXMgd3JpdHRlbiwgY2F1c2luZyBkZXJpdmVTdGF0ZSB0byByZXR1cm4gcGhhc2U6J3ByZS1wbGFubmluZydcbiAgICAvLyBpbmRlZmluaXRlbHkgYW5kIHJlLWRpc3BhdGNoaW5nIHBsYW4tbWlsZXN0b25lIGluIGFuIGluZmluaXRlIGxvb3AgKCM0Mzc4KS5cbiAgICBpZiAodW5pdFR5cGUgPT09IFwicGxhbi1taWxlc3RvbmVcIiAmJiBtaWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGluc2VydFNsaWNlKHsgaWQ6IFwiUzAwLWJsb2NrZXJcIiwgbWlsZXN0b25lSWQ6IG1pZCwgdGl0bGU6IFwiQmxvY2tlciBwbGFjZWhvbGRlciBcdTIwMTQgcGxhbm5pbmcgZmFpbGVkXCIsIHN0YXR1czogXCJjb21wbGV0ZVwiLCBzZXF1ZW5jZTogMCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGBpbnNlcnRTbGljZSBwbGFjZWhvbGRlciBmYWlsZWQgZm9yIHBsYW4tbWlsZXN0b25lIHJlY292ZXJ5OiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gKTsgfVxuICAgICAgdHJ5IHsgYXBwZW5kRXZlbnQoYmFzZSwgeyBjbWQ6IFwicGxhbi1taWxlc3RvbmVcIiwgcGFyYW1zOiB7IG1pbGVzdG9uZUlkOiBtaWQgfSwgdHMsIGFjdG9yOiBcInN5c3RlbVwiLCB0cmlnZ2VyX3JlYXNvbjogXCJibG9ja2VyLXBsYWNlaG9sZGVyLXJlY292ZXJ5XCIgfSk7IH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcInJlY292ZXJ5XCIsIGBhcHBlbmRFdmVudCBmYWlsZWQgZm9yIHBsYW4tbWlsZXN0b25lIHJlY292ZXJ5OiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1gKTsgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3QodW5pdFR5cGUsIHVuaXRJZCwgYmFzZSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBNZXJnZSBTdGF0ZSBSZWNvbmNpbGlhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIEJvZHkgcmVsb2NhdGVkIHRvIHN0YXRlLXJlY29uY2lsaWF0aW9uL2RyaWZ0L21lcmdlLXN0YXRlLnRzIChBRFItMDE3ICM1NzAxKS5cbi8vIFJlLWV4cG9ydGVkIGhlcmUgZm9yIGJhY2t3YXJkIGNvbXBhdGliaWxpdHkgd2l0aCBleGlzdGluZyBjYWxsIHNpdGVzOlxuLy8gYXV0by50cywgYXV0by9sb29wLWRlcHMudHMsIHRlc3RzL2ludGVncmF0aW9uL2F1dG8tcmVjb3ZlcnkudGVzdC50cy5cblxuZXhwb3J0IHtcbiAgcmVjb25jaWxlTWVyZ2VTdGF0ZSxcbiAgdHlwZSBNZXJnZVJlY29uY2lsZVJlc3VsdCxcbn0gZnJvbSBcIi4vc3RhdGUtcmVjb25jaWxpYXRpb24vZHJpZnQvbWVyZ2Utc3RhdGUuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIExvb3AgUmVtZWRpYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQnVpbGQgY29uY3JldGUsIG1hbnVhbCByZW1lZGlhdGlvbiBzdGVwcyBmb3IgYSBsb29wLWRldGVjdGVkIHVuaXQgZmFpbHVyZS5cbiAqIFRoZXNlIGFyZSBzaG93biB3aGVuIGF1dG9tYXRpYyByZWNvbmNpbGlhdGlvbiBpcyBub3QgcG9zc2libGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZExvb3BSZW1lZGlhdGlvblN0ZXBzKFxuICB1bml0VHlwZTogc3RyaW5nLFxuICB1bml0SWQ6IHN0cmluZyxcbiAgYmFzZTogc3RyaW5nLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQsIHRhc2s6IHRpZCB9ID0gcGFyc2VVbml0SWQodW5pdElkKTtcbiAgc3dpdGNoICh1bml0VHlwZSkge1xuICAgIGNhc2UgXCJleGVjdXRlLXRhc2tcIjoge1xuICAgICAgaWYgKCFtaWQgfHwgIXNpZCB8fCAhdGlkKSBicmVhaztcbiAgICAgIHJldHVybiBbXG4gICAgICAgIGAgICAxLiBSdW4gXFxgZ3NkIHVuZG8tdGFzayAke3RpZH1cXGAgdG8gcmVzZXQgdGhlIHRhc2sgc3RhdGVgLFxuICAgICAgICBgICAgMi4gUmVzdW1lIGF1dG8tbW9kZSBcdTIwMTQgaXQgd2lsbCByZS1leGVjdXRlIHRoZSB0YXNrYCxcbiAgICAgICAgYCAgIDMuIElmIHRoZSB0YXNrIGtlZXBzIGZhaWxpbmcsIHJ1biBcXGBnc2QgcmVjb3ZlclxcYCB0byByZWJ1aWxkIERCIHN0YXRlIGZyb20gZGlza2AsXG4gICAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgfVxuICAgIGNhc2UgXCJwbGFuLXNsaWNlXCI6XG4gICAgY2FzZSBcInJlc2VhcmNoLXNsaWNlXCI6IHtcbiAgICAgIGlmICghbWlkIHx8ICFzaWQpIGJyZWFrO1xuICAgICAgY29uc3QgYXJ0aWZhY3RSZWwgPVxuICAgICAgICB1bml0VHlwZSA9PT0gXCJwbGFuLXNsaWNlXCJcbiAgICAgICAgICA/IHJlbFNsaWNlRmlsZShiYXNlLCBtaWQsIHNpZCwgXCJQTEFOXCIpXG4gICAgICAgICAgOiByZWxTbGljZUZpbGUoYmFzZSwgbWlkLCBzaWQsIFwiUkVTRUFSQ0hcIik7XG4gICAgICByZXR1cm4gW1xuICAgICAgICBgICAgMS4gV3JpdGUgJHthcnRpZmFjdFJlbH0gbWFudWFsbHkgKG9yIHdpdGggdGhlIExMTSBpbiBpbnRlcmFjdGl2ZSBtb2RlKWAsXG4gICAgICAgIGAgICAyLiBSdW4gXFxgZ3NkIHJlY292ZXJcXGAgdG8gcmVidWlsZCBEQiBzdGF0ZSBmcm9tIGRpc2tgLFxuICAgICAgICBgICAgMy4gUmVzdW1lIGF1dG8tbW9kZWAsXG4gICAgICBdLmpvaW4oXCJcXG5cIik7XG4gICAgfVxuICAgIGNhc2UgXCJjb21wbGV0ZS1zbGljZVwiOiB7XG4gICAgICBpZiAoIW1pZCB8fCAhc2lkKSBicmVhaztcbiAgICAgIHJldHVybiBbXG4gICAgICAgIGAgICAxLiBSdW4gXFxgZ3NkIHJlc2V0LXNsaWNlICR7c2lkfVxcYCB0byByZXNldCB0aGUgc2xpY2UgYW5kIGFsbCBpdHMgdGFza3NgLFxuICAgICAgICBgICAgMi4gUmVzdW1lIGF1dG8tbW9kZSBcdTIwMTQgaXQgd2lsbCByZS1leGVjdXRlIGluY29tcGxldGUgdGFza3MgYW5kIHJlLWNvbXBsZXRlIHRoZSBzbGljZWAsXG4gICAgICAgIGAgICAzLiBJZiB0aGUgc2xpY2Uga2VlcHMgZmFpbGluZywgcnVuIFxcYGdzZCByZWNvdmVyXFxgIHRvIHJlYnVpbGQgREIgc3RhdGUgZnJvbSBkaXNrYCxcbiAgICAgIF0uam9pbihcIlxcblwiKTtcbiAgICB9XG4gICAgY2FzZSBcInZhbGlkYXRlLW1pbGVzdG9uZVwiOiB7XG4gICAgICBpZiAoIW1pZCkgYnJlYWs7XG4gICAgICBjb25zdCBhcnRpZmFjdFJlbCA9IHJlbE1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIlZBTElEQVRJT05cIik7XG4gICAgICByZXR1cm4gW1xuICAgICAgICBgICAgMS4gV3JpdGUgJHthcnRpZmFjdFJlbH0gd2l0aCB2ZXJkaWN0OiBwYXNzYCxcbiAgICAgICAgYCAgIDIuIFJ1biBcXGBnc2QgcmVjb3ZlclxcYCB0byByZWJ1aWxkIERCIHN0YXRlIGZyb20gZGlza2AsXG4gICAgICAgIGAgICAzLiBSZXN1bWUgYXV0by1tb2RlYCxcbiAgICAgIF0uam9pbihcIlxcblwiKTtcbiAgICB9XG4gICAgZGVmYXVsdDpcbiAgICAgIGJyZWFrO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBU0EsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxtQkFBbUI7QUFDNUIsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyx1QkFBdUI7QUFDaEMsU0FBUyxnQkFBZ0Isb0JBQW9CLGFBQWEsdUJBQXVCO0FBQ2pGLFNBQVMs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
