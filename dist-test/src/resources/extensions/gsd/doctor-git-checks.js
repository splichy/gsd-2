import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { loadFile } from "./files.js";
import { parseRoadmap as parseLegacyRoadmap } from "./parsers-legacy.js";
import { isDbAvailable, getMilestone } from "./gsd-db.js";
import { resolveMilestoneFile } from "./paths.js";
import { deriveState, isMilestoneComplete } from "./state.js";
import { listWorktrees, resolveGitDir, worktreesDir } from "./worktree-manager.js";
import { abortAndReset } from "./git-self-heal.js";
import { RUNTIME_EXCLUSION_PATHS, resolveMilestoneIntegrationBranch, writeIntegrationBranch } from "./git-service.js";
import { nativeIsRepo, nativeWorktreeList, nativeWorktreeRemove, nativeBranchList, nativeBranchDelete, nativeLsFiles, nativeRmCached, nativeHasChanges, nativeLastCommitEpoch, nativeGetCurrentBranch, nativeAddTracked, nativeCommit } from "./native-git-bridge.js";
import { getAllWorktreeHealth } from "./worktree-health.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
function isDoctorArtifactOnly(dirPath) {
  try {
    const entries = readdirSync(dirPath);
    if (entries.length === 0) return false;
    if (entries.length === 1 && entries[0] === ".gsd") {
      const gsdEntries = readdirSync(join(dirPath, ".gsd"));
      return gsdEntries.length <= 1 && gsdEntries.every((e) => e === "doctor-history.jsonl");
    }
    return false;
  } catch {
    return false;
  }
}
function normalizePathForComparison(path) {
  const resolved = existsSync(path) ? realpathSync(path) : path;
  const normalized = resolved.replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function isSameOrNestedPath(candidate, container) {
  const normalizedCandidate = normalizePathForComparison(candidate);
  const normalizedContainer = normalizePathForComparison(container);
  return normalizedCandidate === normalizedContainer || normalizedCandidate.startsWith(`${normalizedContainer}/`);
}
function getSnapshotDiffCheckFailure(basePath) {
  const failures = [];
  for (const args of [["--cached"], []]) {
    const result = spawnSync("git", ["diff", "--check", ...args], {
      cwd: basePath,
      encoding: "utf-8"
    });
    if (result.status === 0) continue;
    const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n").trim();
    failures.push(output || `git diff --check ${args.join(" ")} failed`);
  }
  return failures.length > 0 ? failures.join("\n") : null;
}
async function isCompletedMilestoneTerminal(basePath, milestoneId) {
  const summaryPath = resolveMilestoneFile(basePath, milestoneId, "SUMMARY");
  if (!summaryPath) return false;
  if (isDbAvailable()) {
    const milestone = getMilestone(milestoneId);
    return !!milestone && milestone.status === "complete";
  }
  const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
  if (!roadmapContent) return false;
  const roadmap = parseLegacyRoadmap(roadmapContent);
  return isMilestoneComplete(roadmap);
}
async function checkGitHealth(basePath, issues, fixesApplied, shouldFix, isolationMode = "none") {
  if (!nativeIsRepo(basePath)) {
    return;
  }
  const gitDir = resolveGitDir(basePath);
  if (isolationMode !== "none") {
    try {
      const worktrees = listWorktrees(basePath);
      const milestoneWorktrees = worktrees.filter((wt) => wt.branch.startsWith("milestone/"));
      const state = await deriveState(basePath);
      for (const wt of milestoneWorktrees) {
        const milestoneId = wt.branch.replace(/^milestone\//, "");
        const milestoneEntry = state.registry.find((m) => m.id === milestoneId);
        const isComplete = milestoneEntry ? await isCompletedMilestoneTerminal(basePath, milestoneId) : false;
        if (isComplete) {
          issues.push({
            severity: "warning",
            code: "orphaned_auto_worktree",
            scope: "milestone",
            unitId: milestoneId,
            message: `Worktree for completed milestone ${milestoneId} still exists at ${wt.path}`,
            fixable: true
          });
          if (shouldFix("orphaned_auto_worktree")) {
            let cwd = basePath;
            try {
              cwd = process.cwd();
            } catch {
              cwd = basePath;
            }
            if (isSameOrNestedPath(cwd, wt.path)) {
              try {
                process.chdir(basePath);
              } catch {
                fixesApplied.push(`skipped removing worktree at ${wt.path} (cannot chdir to basePath)`);
                continue;
              }
            }
            try {
              nativeWorktreeRemove(basePath, wt.path, true);
              fixesApplied.push(`removed orphaned worktree ${wt.path}`);
            } catch {
              fixesApplied.push(`failed to remove worktree ${wt.path}`);
            }
          }
        }
      }
      try {
        const branches = nativeBranchList(basePath, "milestone/*");
        if (branches.length > 0) {
          const worktreeBranches = new Set(milestoneWorktrees.map((wt) => wt.branch));
          for (const branch of branches) {
            if (worktreeBranches.has(branch)) continue;
            const milestoneId = branch.replace(/^milestone\//, "");
            const roadmapPath = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
            let branchMilestoneComplete = false;
            const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
            if (!roadmapContent) continue;
            branchMilestoneComplete = await isCompletedMilestoneTerminal(basePath, milestoneId);
            if (branchMilestoneComplete) {
              issues.push({
                severity: "info",
                code: "stale_milestone_branch",
                scope: "milestone",
                unitId: milestoneId,
                message: `Branch ${branch} exists for completed milestone ${milestoneId}`,
                fixable: true
              });
              if (shouldFix("stale_milestone_branch")) {
                try {
                  nativeBranchDelete(basePath, branch, true);
                  fixesApplied.push(`deleted stale branch ${branch}`);
                } catch {
                  fixesApplied.push(`failed to delete branch ${branch}`);
                }
              }
            }
          }
        }
      } catch {
      }
    } catch {
    }
  }
  try {
    const mergeStateFiles = ["MERGE_HEAD", "SQUASH_MSG"];
    const mergeStateDirs = ["rebase-apply", "rebase-merge"];
    const found = [];
    for (const f of mergeStateFiles) {
      if (existsSync(join(gitDir, f))) found.push(f);
    }
    for (const d of mergeStateDirs) {
      if (existsSync(join(gitDir, d))) found.push(d);
    }
    if (found.length > 0) {
      issues.push({
        severity: "error",
        code: "corrupt_merge_state",
        scope: "project",
        unitId: "project",
        message: `Corrupt merge/rebase state detected: ${found.join(", ")}`,
        fixable: true
      });
      if (shouldFix("corrupt_merge_state")) {
        const result = abortAndReset(basePath);
        fixesApplied.push(`cleaned merge state: ${result.cleaned.join(", ")}`);
      }
    }
  } catch {
  }
  try {
    const trackedPaths = [];
    for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
      try {
        const files = nativeLsFiles(basePath, exclusion);
        if (files.length > 0) {
          trackedPaths.push(...files);
        }
      } catch {
      }
    }
    if (trackedPaths.length > 0) {
      issues.push({
        severity: "warning",
        code: "tracked_runtime_files",
        scope: "project",
        unitId: "project",
        message: `${trackedPaths.length} runtime file(s) are tracked by git: ${trackedPaths.slice(0, 5).join(", ")}${trackedPaths.length > 5 ? "..." : ""}`,
        fixable: true
      });
      if (shouldFix("tracked_runtime_files")) {
        try {
          for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
            nativeRmCached(basePath, [exclusion]);
          }
          fixesApplied.push(`untracked ${trackedPaths.length} runtime file(s)`);
        } catch {
          fixesApplied.push("failed to untrack runtime files");
        }
      }
    }
  } catch {
  }
  try {
    const branchList = nativeBranchList(basePath, "gsd/*/*").filter((branch) => !branch.startsWith("gsd/quick/"));
    if (branchList.length > 0) {
      issues.push({
        severity: "info",
        code: "legacy_slice_branches",
        scope: "project",
        unitId: "project",
        message: `${branchList.length} legacy slice branch(es) found: ${branchList.slice(0, 3).join(", ")}${branchList.length > 3 ? "..." : ""}. These are no longer used (branchless architecture).`,
        fixable: true
      });
      if (shouldFix("legacy_slice_branches")) {
        let deleted = 0;
        for (const branch of branchList) {
          try {
            nativeBranchDelete(basePath, branch, true);
            deleted++;
          } catch {
          }
        }
        if (deleted > 0) {
          fixesApplied.push(`deleted ${deleted} legacy slice branch(es)`);
        }
      }
    }
  } catch {
  }
  try {
    const state = await deriveState(basePath);
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
    for (const milestone of state.registry) {
      if (milestone.status === "complete") continue;
      const resolution = resolveMilestoneIntegrationBranch(basePath, milestone.id, gitPrefs);
      if (!resolution.recordedBranch) continue;
      if (resolution.status === "fallback" && resolution.effectiveBranch) {
        issues.push({
          severity: "warning",
          code: "integration_branch_missing",
          scope: "milestone",
          unitId: milestone.id,
          message: resolution.reason,
          fixable: true
        });
        if (shouldFix("integration_branch_missing")) {
          writeIntegrationBranch(basePath, milestone.id, resolution.effectiveBranch);
          fixesApplied.push(`updated integration branch for ${milestone.id} to "${resolution.effectiveBranch}"`);
        }
        continue;
      }
      if (resolution.status === "missing") {
        issues.push({
          severity: "error",
          code: "integration_branch_missing",
          scope: "milestone",
          unitId: milestone.id,
          message: resolution.reason,
          fixable: false
        });
      }
    }
  } catch {
  }
  try {
    const wtDir = worktreesDir(basePath);
    if (existsSync(wtDir)) {
      const normalizePath = (p) => {
        try {
          p = realpathSync(p);
        } catch {
        }
        return p.replaceAll("\\", "/");
      };
      const registeredPaths = new Set(
        nativeWorktreeList(basePath).map((entry) => normalizePath(entry.path))
      );
      for (const entry of readdirSync(wtDir)) {
        const fullPath = join(wtDir, entry);
        try {
          if (!statSync(fullPath).isDirectory()) continue;
        } catch {
          continue;
        }
        const normalizedFullPath = normalizePath(fullPath);
        if (!registeredPaths.has(normalizedFullPath)) {
          if (isDoctorArtifactOnly(fullPath)) continue;
          issues.push({
            severity: "warning",
            code: "worktree_directory_orphaned",
            scope: "project",
            unitId: entry,
            message: `Worktree directory ${fullPath} exists on disk but is not registered with git. Run "git worktree prune" or doctor --fix to remove it.`,
            fixable: true
          });
          if (shouldFix("worktree_directory_orphaned")) {
            try {
              rmSync(fullPath, { recursive: true, force: true });
              fixesApplied.push(`removed orphaned worktree directory ${fullPath}`);
            } catch {
              fixesApplied.push(`failed to remove orphaned worktree directory ${fullPath}`);
            }
          }
        }
      }
    }
  } catch {
  }
  try {
    const prefs = loadEffectiveGSDPreferences()?.preferences ?? {};
    const snapshotsEnabled = prefs.git?.snapshots !== false;
    const thresholdMinutes = prefs.stale_commit_threshold_minutes ?? 30;
    if (snapshotsEnabled && thresholdMinutes > 0) {
      const dirty = nativeHasChanges(basePath);
      if (dirty) {
        const branch = nativeGetCurrentBranch(basePath);
        const lastEpoch = nativeLastCommitEpoch(basePath, branch || "HEAD");
        const nowEpoch = Math.floor(Date.now() / 1e3);
        const minutesSinceCommit = lastEpoch > 0 ? (nowEpoch - lastEpoch) / 60 : Infinity;
        if (minutesSinceCommit >= thresholdMinutes) {
          const mins = Math.floor(minutesSinceCommit);
          issues.push({
            severity: "warning",
            code: "stale_uncommitted_changes",
            scope: "project",
            unitId: "project",
            message: `Uncommitted changes detected with no commit in ${mins} minute${mins === 1 ? "" : "s"} (threshold: ${thresholdMinutes}m). Snapshotting tracked files.`,
            fixable: true
          });
          const diffCheckFailure = getSnapshotDiffCheckFailure(basePath);
          if (diffCheckFailure) {
            issues.push({
              severity: "error",
              code: "conflict_markers_in_tracked_files",
              scope: "project",
              unitId: "project",
              message: `Cannot create gsd snapshot: tracked changes contain conflict markers or whitespace errors. Resolve conflicts manually before auto-mode can proceed.
${diffCheckFailure}`,
              fixable: false
            });
          }
          if (shouldFix("stale_uncommitted_changes")) {
            try {
              if (diffCheckFailure) {
                fixesApplied.push("gsd snapshot skipped - conflict markers detected in tracked files");
              } else {
                nativeAddTracked(basePath);
                const commitMsg = `gsd snapshot: uncommitted changes after ${mins}m inactivity`;
                const result = nativeCommit(basePath, commitMsg);
                if (result) {
                  fixesApplied.push(`created gsd snapshot after ${mins}m of uncommitted changes`);
                } else {
                  fixesApplied.push("gsd snapshot skipped \u2014 nothing to commit after staging tracked files");
                }
              }
            } catch {
              fixesApplied.push("failed to create gsd snapshot commit");
            }
          }
        }
      }
    }
  } catch {
  }
  try {
    const healthStatuses = getAllWorktreeHealth(basePath);
    const cwd = process.cwd();
    for (const health of healthStatuses) {
      const wt = health.worktree;
      const isCwd = wt.path === cwd || cwd.startsWith(wt.path + sep);
      if (health.mergedIntoMain) {
        issues.push({
          severity: "info",
          code: "worktree_branch_merged",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" (branch ${wt.branch}) is fully merged into main${health.safeToRemove ? " \u2014 safe to remove" : ""}`,
          fixable: health.safeToRemove
        });
        if (health.safeToRemove && shouldFix("worktree_branch_merged") && !isCwd) {
          try {
            const { removeWorktree } = await import("./worktree-manager.js");
            removeWorktree(basePath, wt.name, { deleteBranch: true, branch: wt.branch });
            fixesApplied.push(`removed merged worktree "${wt.name}" and deleted branch ${wt.branch}`);
          } catch {
            fixesApplied.push(`failed to remove merged worktree "${wt.name}"`);
          }
        }
        continue;
      }
      if (health.stale) {
        const days = Math.floor(health.lastCommitAgeDays);
        issues.push({
          severity: "warning",
          code: "worktree_stale",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" has had no commits in ${days} day${days === 1 ? "" : "s"}`,
          fixable: false
        });
      }
      if (health.dirty && health.stale) {
        issues.push({
          severity: "warning",
          code: "worktree_dirty",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" has ${health.dirtyFileCount} uncommitted file${health.dirtyFileCount === 1 ? "" : "s"} and is stale`,
          fixable: false
        });
      }
      if (health.unpushedCommits > 0 && health.stale) {
        issues.push({
          severity: "warning",
          code: "worktree_unpushed",
          scope: "project",
          unitId: wt.name,
          message: `Worktree "${wt.name}" has ${health.unpushedCommits} unpushed commit${health.unpushedCommits === 1 ? "" : "s"}`,
          fixable: false
        });
      }
    }
  } catch {
  }
}
export {
  checkGitHealth
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9kb2N0b3ItZ2l0LWNoZWNrcy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gR1NELTIgZG9jdG9yIGdpdCBoZWFsdGggY2hlY2tzXG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkZGlyU3luYywgcmVhbHBhdGhTeW5jLCBybVN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4sIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcblxuaW1wb3J0IHR5cGUgeyBEb2N0b3JJc3N1ZSwgRG9jdG9ySXNzdWVDb2RlIH0gZnJvbSBcIi4vZG9jdG9yLXR5cGVzLmpzXCI7XG5pbXBvcnQgeyBsb2FkRmlsZSB9IGZyb20gXCIuL2ZpbGVzLmpzXCI7XG5pbXBvcnQgeyBwYXJzZVJvYWRtYXAgYXMgcGFyc2VMZWdhY3lSb2FkbWFwIH0gZnJvbSBcIi4vcGFyc2Vycy1sZWdhY3kuanNcIjtcbmltcG9ydCB7IGlzRGJBdmFpbGFibGUsIGdldE1pbGVzdG9uZSB9IGZyb20gXCIuL2dzZC1kYi5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZU1pbGVzdG9uZUZpbGUgfSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgZGVyaXZlU3RhdGUsIGlzTWlsZXN0b25lQ29tcGxldGUgfSBmcm9tIFwiLi9zdGF0ZS5qc1wiO1xuaW1wb3J0IHsgbGlzdFdvcmt0cmVlcywgcmVzb2x2ZUdpdERpciwgd29ya3RyZWVzRGlyIH0gZnJvbSBcIi4vd29ya3RyZWUtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgYWJvcnRBbmRSZXNldCB9IGZyb20gXCIuL2dpdC1zZWxmLWhlYWwuanNcIjtcbmltcG9ydCB7IFJVTlRJTUVfRVhDTFVTSU9OX1BBVEhTLCByZXNvbHZlTWlsZXN0b25lSW50ZWdyYXRpb25CcmFuY2gsIHdyaXRlSW50ZWdyYXRpb25CcmFuY2ggfSBmcm9tIFwiLi9naXQtc2VydmljZS5qc1wiO1xuaW1wb3J0IHsgbmF0aXZlSXNSZXBvLCBuYXRpdmVXb3JrdHJlZUxpc3QsIG5hdGl2ZVdvcmt0cmVlUmVtb3ZlLCBuYXRpdmVCcmFuY2hMaXN0LCBuYXRpdmVCcmFuY2hEZWxldGUsIG5hdGl2ZUxzRmlsZXMsIG5hdGl2ZVJtQ2FjaGVkLCBuYXRpdmVIYXNDaGFuZ2VzLCBuYXRpdmVMYXN0Q29tbWl0RXBvY2gsIG5hdGl2ZUdldEN1cnJlbnRCcmFuY2gsIG5hdGl2ZUFkZFRyYWNrZWQsIG5hdGl2ZUNvbW1pdCB9IGZyb20gXCIuL25hdGl2ZS1naXQtYnJpZGdlLmpzXCI7XG5pbXBvcnQgeyBnZXRBbGxXb3JrdHJlZUhlYWx0aCB9IGZyb20gXCIuL3dvcmt0cmVlLWhlYWx0aC5qc1wiO1xuaW1wb3J0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMuanNcIjtcblxuLyoqXG4gKiBSZXR1cm5zIHRydWUgaWYgdGhlIGRpcmVjdG9yeSBjb250YWlucyBvbmx5IGRvY3RvciBhcnRpZmFjdHNcbiAqIChlLmcuIGAuZ3NkL2RvY3Rvci1oaXN0b3J5Lmpzb25sYCkuIFRoZXNlIGRpcnMgYXJlIGNyZWF0ZWQgYnlcbiAqIGFwcGVuZERvY3Rvckhpc3RvcnkoKSB3cml0aW5nIHRvIHdvcmt0cmVlLXNjb3BlZCBwYXRocyBkdXJpbmcgdGhlIGF1ZGl0XG4gKiBhbmQgc2hvdWxkIG5vdCBiZSBmbGFnZ2VkIGFzIG9ycGhhbmVkIHdvcmt0cmVlcyAoIzMxMDUpLlxuICovXG5mdW5jdGlvbiBpc0RvY3RvckFydGlmYWN0T25seShkaXJQYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoZGlyUGF0aCk7XG4gICAgLy8gRW1wdHkgZGlyIFx1MjAxNCBub3QgYSBkb2N0b3IgYXJ0aWZhY3QsIHN0aWxsIG9ycGhhbmVkXG4gICAgaWYgKGVudHJpZXMubGVuZ3RoID09PSAwKSByZXR1cm4gZmFsc2U7XG4gICAgLy8gT25seSBhIC5nc2Qgc3ViZGlyZWN0b3J5XG4gICAgaWYgKGVudHJpZXMubGVuZ3RoID09PSAxICYmIGVudHJpZXNbMF0gPT09IFwiLmdzZFwiKSB7XG4gICAgICBjb25zdCBnc2RFbnRyaWVzID0gcmVhZGRpclN5bmMoam9pbihkaXJQYXRoLCBcIi5nc2RcIikpO1xuICAgICAgcmV0dXJuIGdzZEVudHJpZXMubGVuZ3RoIDw9IDEgJiYgZ3NkRW50cmllcy5ldmVyeShlID0+IGUgPT09IFwiZG9jdG9yLWhpc3RvcnkuanNvbmxcIik7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVBhdGhGb3JDb21wYXJpc29uKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJlc29sdmVkID0gZXhpc3RzU3luYyhwYXRoKSA/IHJlYWxwYXRoU3luYyhwYXRoKSA6IHBhdGg7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSByZXNvbHZlZFxuICAgIC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIilcbiAgICAucmVwbGFjZSgvXlxcL1xcL1xcP1xcLy8sIFwiXCIpXG4gICAgLnJlcGxhY2UoL1xcLyskLywgXCJcIik7XG4gIHJldHVybiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBub3JtYWxpemVkLnRvTG93ZXJDYXNlKCkgOiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBpc1NhbWVPck5lc3RlZFBhdGgoY2FuZGlkYXRlOiBzdHJpbmcsIGNvbnRhaW5lcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWRDYW5kaWRhdGUgPSBub3JtYWxpemVQYXRoRm9yQ29tcGFyaXNvbihjYW5kaWRhdGUpO1xuICBjb25zdCBub3JtYWxpemVkQ29udGFpbmVyID0gbm9ybWFsaXplUGF0aEZvckNvbXBhcmlzb24oY29udGFpbmVyKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWRDYW5kaWRhdGUgPT09IG5vcm1hbGl6ZWRDb250YWluZXIgfHxcbiAgICBub3JtYWxpemVkQ2FuZGlkYXRlLnN0YXJ0c1dpdGgoYCR7bm9ybWFsaXplZENvbnRhaW5lcn0vYCk7XG59XG5cbmZ1bmN0aW9uIGdldFNuYXBzaG90RGlmZkNoZWNrRmFpbHVyZShiYXNlUGF0aDogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGZhaWx1cmVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgYXJncyBvZiBbW1wiLS1jYWNoZWRcIl0sIFtdXSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IHNwYXduU3luYyhcImdpdFwiLCBbXCJkaWZmXCIsIFwiLS1jaGVja1wiLCAuLi5hcmdzXSwge1xuICAgICAgY3dkOiBiYXNlUGF0aCxcbiAgICAgIGVuY29kaW5nOiBcInV0Zi04XCIsXG4gICAgfSk7XG4gICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09IDApIGNvbnRpbnVlO1xuXG4gICAgY29uc3Qgb3V0cHV0ID0gW3Jlc3VsdC5zdGRvdXQsIHJlc3VsdC5zdGRlcnIsIHJlc3VsdC5lcnJvcj8ubWVzc2FnZV1cbiAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgIC5qb2luKFwiXFxuXCIpXG4gICAgICAudHJpbSgpO1xuICAgIGZhaWx1cmVzLnB1c2gob3V0cHV0IHx8IGBnaXQgZGlmZiAtLWNoZWNrICR7YXJncy5qb2luKFwiIFwiKX0gZmFpbGVkYCk7XG4gIH1cblxuICByZXR1cm4gZmFpbHVyZXMubGVuZ3RoID4gMCA/IGZhaWx1cmVzLmpvaW4oXCJcXG5cIikgOiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBpc0NvbXBsZXRlZE1pbGVzdG9uZVRlcm1pbmFsKGJhc2VQYXRoOiBzdHJpbmcsIG1pbGVzdG9uZUlkOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3Qgc3VtbWFyeVBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiU1VNTUFSWVwiKTtcbiAgaWYgKCFzdW1tYXJ5UGF0aCkgcmV0dXJuIGZhbHNlO1xuXG4gIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICBjb25zdCBtaWxlc3RvbmUgPSBnZXRNaWxlc3RvbmUobWlsZXN0b25lSWQpO1xuICAgIHJldHVybiAhIW1pbGVzdG9uZSAmJiBtaWxlc3RvbmUuc3RhdHVzID09PSBcImNvbXBsZXRlXCI7XG4gIH1cblxuICBjb25zdCByb2FkbWFwUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgXCJST0FETUFQXCIpO1xuICBjb25zdCByb2FkbWFwQ29udGVudCA9IHJvYWRtYXBQYXRoID8gYXdhaXQgbG9hZEZpbGUocm9hZG1hcFBhdGgpIDogbnVsbDtcbiAgaWYgKCFyb2FkbWFwQ29udGVudCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCByb2FkbWFwID0gcGFyc2VMZWdhY3lSb2FkbWFwKHJvYWRtYXBDb250ZW50KTtcbiAgcmV0dXJuIGlzTWlsZXN0b25lQ29tcGxldGUocm9hZG1hcCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjaGVja0dpdEhlYWx0aChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgaXNzdWVzOiBEb2N0b3JJc3N1ZVtdLFxuICBmaXhlc0FwcGxpZWQ6IHN0cmluZ1tdLFxuICBzaG91bGRGaXg6IChjb2RlOiBEb2N0b3JJc3N1ZUNvZGUpID0+IGJvb2xlYW4sXG4gIGlzb2xhdGlvbk1vZGU6IFwibm9uZVwiIHwgXCJ3b3JrdHJlZVwiIHwgXCJicmFuY2hcIiA9IFwibm9uZVwiLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIERlZ3JhZGUgZ3JhY2VmdWxseSBpZiBub3QgYSBnaXQgcmVwb1xuICBpZiAoIW5hdGl2ZUlzUmVwbyhiYXNlUGF0aCkpIHtcbiAgICByZXR1cm47IC8vIE5vdCBhIGdpdCByZXBvIFx1MjAxNCBza2lwIGFsbCBnaXQgaGVhbHRoIGNoZWNrc1xuICB9XG5cbiAgY29uc3QgZ2l0RGlyID0gcmVzb2x2ZUdpdERpcihiYXNlUGF0aCk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIE9ycGhhbmVkIGF1dG8td29ya3RyZWVzICYgU3RhbGUgbWlsZXN0b25lIGJyYW5jaGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBUaGVzZSBjaGVja3Mgb25seSBhcHBseSBpbiB3b3JrdHJlZS9icmFuY2ggbW9kZXMgXHUyMDE0IHNraXAgaW4gbm9uZSBtb2RlXG4gIC8vIHdoZXJlIG5vIG1pbGVzdG9uZSB3b3JrdHJlZXMgb3IgYnJhbmNoZXMgYXJlIGNyZWF0ZWQuXG4gIGlmIChpc29sYXRpb25Nb2RlICE9PSBcIm5vbmVcIikge1xuICB0cnkge1xuICAgIGNvbnN0IHdvcmt0cmVlcyA9IGxpc3RXb3JrdHJlZXMoYmFzZVBhdGgpO1xuICAgIGNvbnN0IG1pbGVzdG9uZVdvcmt0cmVlcyA9IHdvcmt0cmVlcy5maWx0ZXIod3QgPT4gd3QuYnJhbmNoLnN0YXJ0c1dpdGgoXCJtaWxlc3RvbmUvXCIpKTtcblxuICAgIC8vIExvYWQgcm9hZG1hcCBzdGF0ZSBvbmNlIGZvciBjcm9zcy1yZWZlcmVuY2luZ1xuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZVBhdGgpO1xuXG4gICAgZm9yIChjb25zdCB3dCBvZiBtaWxlc3RvbmVXb3JrdHJlZXMpIHtcbiAgICAgIC8vIEV4dHJhY3QgbWlsZXN0b25lIElEIGZyb20gYnJhbmNoIG5hbWUgXCJtaWxlc3RvbmUvTTAwMVwiIFx1MjE5MiBcIk0wMDFcIlxuICAgICAgY29uc3QgbWlsZXN0b25lSWQgPSB3dC5icmFuY2gucmVwbGFjZSgvXm1pbGVzdG9uZVxcLy8sIFwiXCIpO1xuICAgICAgY29uc3QgbWlsZXN0b25lRW50cnkgPSBzdGF0ZS5yZWdpc3RyeS5maW5kKG0gPT4gbS5pZCA9PT0gbWlsZXN0b25lSWQpO1xuICAgICAgY29uc3QgaXNDb21wbGV0ZSA9IG1pbGVzdG9uZUVudHJ5XG4gICAgICAgID8gYXdhaXQgaXNDb21wbGV0ZWRNaWxlc3RvbmVUZXJtaW5hbChiYXNlUGF0aCwgbWlsZXN0b25lSWQpXG4gICAgICAgIDogZmFsc2U7XG5cbiAgICAgIGlmIChpc0NvbXBsZXRlKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJvcnBoYW5lZF9hdXRvX3dvcmt0cmVlXCIsXG4gICAgICAgICAgc2NvcGU6IFwibWlsZXN0b25lXCIsXG4gICAgICAgICAgdW5pdElkOiBtaWxlc3RvbmVJZCxcbiAgICAgICAgICBtZXNzYWdlOiBgV29ya3RyZWUgZm9yIGNvbXBsZXRlZCBtaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0gc3RpbGwgZXhpc3RzIGF0ICR7d3QucGF0aH1gLFxuICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChzaG91bGRGaXgoXCJvcnBoYW5lZF9hdXRvX3dvcmt0cmVlXCIpKSB7XG4gICAgICAgICAgLy8gSWYgY3dkIGlzIGluc2lkZSB0aGUgd29ya3RyZWUsIGNoZGlyIG91dCBmaXJzdCBcdTIwMTQgbWF0Y2hpbmcgdGhlXG4gICAgICAgICAgLy8gcGF0dGVybiBpbiByZW1vdmVXb3JrdHJlZSgpICgjMTk0NikuIFdpdGhvdXQgdGhpcywgZ2l0IGNhbm5vdFxuICAgICAgICAgIC8vIHJlbW92ZSB0aGUgd29ya3RyZWUgYW5kIHRoZSBkb2N0b3IgZW50ZXJzIGEgZGVhZGxvY2sgd2hlcmUgaXRcbiAgICAgICAgICAvLyBkZXRlY3RzIHRoZSBvcnBoYW4gZXZlcnkgcnVuIGJ1dCBuZXZlciBjbGVhbnMgaXQgdXAuXG4gICAgICAgICAgbGV0IGN3ZCA9IGJhc2VQYXRoO1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjd2QgPSBwcm9jZXNzLmN3ZCgpO1xuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgY3dkID0gYmFzZVBhdGg7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChpc1NhbWVPck5lc3RlZFBhdGgoY3dkLCB3dC5wYXRoKSkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgcHJvY2Vzcy5jaGRpcihiYXNlUGF0aCk7XG4gICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYHNraXBwZWQgcmVtb3Zpbmcgd29ya3RyZWUgYXQgJHt3dC5wYXRofSAoY2Fubm90IGNoZGlyIHRvIGJhc2VQYXRoKWApO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIG5hdGl2ZVdvcmt0cmVlUmVtb3ZlKGJhc2VQYXRoLCB3dC5wYXRoLCB0cnVlKTtcbiAgICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKGByZW1vdmVkIG9ycGhhbmVkIHdvcmt0cmVlICR7d3QucGF0aH1gKTtcbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKGBmYWlsZWQgdG8gcmVtb3ZlIHdvcmt0cmVlICR7d3QucGF0aH1gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgU3RhbGUgbWlsZXN0b25lIGJyYW5jaGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgIHRyeSB7XG4gICAgICBjb25zdCBicmFuY2hlcyA9IG5hdGl2ZUJyYW5jaExpc3QoYmFzZVBhdGgsIFwibWlsZXN0b25lLypcIik7XG4gICAgICBpZiAoYnJhbmNoZXMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zdCB3b3JrdHJlZUJyYW5jaGVzID0gbmV3IFNldChtaWxlc3RvbmVXb3JrdHJlZXMubWFwKHd0ID0+IHd0LmJyYW5jaCkpO1xuXG4gICAgICAgIGZvciAoY29uc3QgYnJhbmNoIG9mIGJyYW5jaGVzKSB7XG4gICAgICAgICAgLy8gU2tpcCBicmFuY2hlcyB0aGF0IGhhdmUgYSB3b3JrdHJlZSAoaGFuZGxlZCBhYm92ZSlcbiAgICAgICAgICBpZiAod29ya3RyZWVCcmFuY2hlcy5oYXMoYnJhbmNoKSkgY29udGludWU7XG5cbiAgICAgICAgICBjb25zdCBtaWxlc3RvbmVJZCA9IGJyYW5jaC5yZXBsYWNlKC9ebWlsZXN0b25lXFwvLywgXCJcIik7XG4gICAgICAgICAgY29uc3Qgcm9hZG1hcFBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiUk9BRE1BUFwiKTtcbiAgICAgICAgICBsZXQgYnJhbmNoTWlsZXN0b25lQ29tcGxldGUgPSBmYWxzZTtcbiAgICAgICAgICBjb25zdCByb2FkbWFwQ29udGVudCA9IHJvYWRtYXBQYXRoID8gYXdhaXQgbG9hZEZpbGUocm9hZG1hcFBhdGgpIDogbnVsbDtcbiAgICAgICAgICBpZiAoIXJvYWRtYXBDb250ZW50KSBjb250aW51ZTtcbiAgICAgICAgICBicmFuY2hNaWxlc3RvbmVDb21wbGV0ZSA9IGF3YWl0IGlzQ29tcGxldGVkTWlsZXN0b25lVGVybWluYWwoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgICAgICAgICBpZiAoYnJhbmNoTWlsZXN0b25lQ29tcGxldGUpIHtcbiAgICAgICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICAgICAgc2V2ZXJpdHk6IFwiaW5mb1wiLFxuICAgICAgICAgICAgICBjb2RlOiBcInN0YWxlX21pbGVzdG9uZV9icmFuY2hcIixcbiAgICAgICAgICAgICAgc2NvcGU6IFwibWlsZXN0b25lXCIsXG4gICAgICAgICAgICAgIHVuaXRJZDogbWlsZXN0b25lSWQsXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IGBCcmFuY2ggJHticmFuY2h9IGV4aXN0cyBmb3IgY29tcGxldGVkIG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfWAsXG4gICAgICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHNob3VsZEZpeChcInN0YWxlX21pbGVzdG9uZV9icmFuY2hcIikpIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBuYXRpdmVCcmFuY2hEZWxldGUoYmFzZVBhdGgsIGJyYW5jaCwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYGRlbGV0ZWQgc3RhbGUgYnJhbmNoICR7YnJhbmNofWApO1xuICAgICAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgZmFpbGVkIHRvIGRlbGV0ZSBicmFuY2ggJHticmFuY2h9YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGdpdCBicmFuY2ggbGlzdCBmYWlsZWQgXHUyMDE0IHNraXAgc3RhbGUgYnJhbmNoIGNoZWNrXG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBsaXN0V29ya3RyZWVzIG9yIGRlcml2ZVN0YXRlIGZhaWxlZCBcdTIwMTQgc2tpcCB3b3JrdHJlZS9icmFuY2ggY2hlY2tzXG4gIH1cbiAgfSAvLyBlbmQgaXNvbGF0aW9uTW9kZSAhPT0gXCJub25lXCJcblxuICAvLyBcdTI1MDBcdTI1MDAgQ29ycnVwdCBtZXJnZSBzdGF0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdHJ5IHtcbiAgICBjb25zdCBtZXJnZVN0YXRlRmlsZXMgPSBbXCJNRVJHRV9IRUFEXCIsIFwiU1FVQVNIX01TR1wiXTtcbiAgICBjb25zdCBtZXJnZVN0YXRlRGlycyA9IFtcInJlYmFzZS1hcHBseVwiLCBcInJlYmFzZS1tZXJnZVwiXTtcbiAgICBjb25zdCBmb3VuZDogc3RyaW5nW10gPSBbXTtcblxuICAgIGZvciAoY29uc3QgZiBvZiBtZXJnZVN0YXRlRmlsZXMpIHtcbiAgICAgIGlmIChleGlzdHNTeW5jKGpvaW4oZ2l0RGlyLCBmKSkpIGZvdW5kLnB1c2goZik7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZCBvZiBtZXJnZVN0YXRlRGlycykge1xuICAgICAgaWYgKGV4aXN0c1N5bmMoam9pbihnaXREaXIsIGQpKSkgZm91bmQucHVzaChkKTtcbiAgICB9XG5cbiAgICBpZiAoZm91bmQubGVuZ3RoID4gMCkge1xuICAgICAgaXNzdWVzLnB1c2goe1xuICAgICAgICBzZXZlcml0eTogXCJlcnJvclwiLFxuICAgICAgICBjb2RlOiBcImNvcnJ1cHRfbWVyZ2Vfc3RhdGVcIixcbiAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICB1bml0SWQ6IFwicHJvamVjdFwiLFxuICAgICAgICBtZXNzYWdlOiBgQ29ycnVwdCBtZXJnZS9yZWJhc2Ugc3RhdGUgZGV0ZWN0ZWQ6ICR7Zm91bmQuam9pbihcIiwgXCIpfWAsXG4gICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICB9KTtcblxuICAgICAgaWYgKHNob3VsZEZpeChcImNvcnJ1cHRfbWVyZ2Vfc3RhdGVcIikpIHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYWJvcnRBbmRSZXNldChiYXNlUGF0aCk7XG4gICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKGBjbGVhbmVkIG1lcmdlIHN0YXRlOiAke3Jlc3VsdC5jbGVhbmVkLmpvaW4oXCIsIFwiKX1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIENhbid0IGNoZWNrIC5naXQgZGlyIFx1MjAxNCBza2lwXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgVHJhY2tlZCBydW50aW1lIGZpbGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGNvbnN0IHRyYWNrZWRQYXRoczogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGV4Y2x1c2lvbiBvZiBSVU5USU1FX0VYQ0xVU0lPTl9QQVRIUykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZmlsZXMgPSBuYXRpdmVMc0ZpbGVzKGJhc2VQYXRoLCBleGNsdXNpb24pO1xuICAgICAgICBpZiAoZmlsZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIHRyYWNrZWRQYXRocy5wdXNoKC4uLmZpbGVzKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIEluZGl2aWR1YWwgbHMtZmlsZXMgY2FuIGZhaWwgXHUyMDE0IGNvbnRpbnVlXG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRyYWNrZWRQYXRocy5sZW5ndGggPiAwKSB7XG4gICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgIHNldmVyaXR5OiBcIndhcm5pbmdcIixcbiAgICAgICAgY29kZTogXCJ0cmFja2VkX3J1bnRpbWVfZmlsZXNcIixcbiAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICB1bml0SWQ6IFwicHJvamVjdFwiLFxuICAgICAgICBtZXNzYWdlOiBgJHt0cmFja2VkUGF0aHMubGVuZ3RofSBydW50aW1lIGZpbGUocykgYXJlIHRyYWNrZWQgYnkgZ2l0OiAke3RyYWNrZWRQYXRocy5zbGljZSgwLCA1KS5qb2luKFwiLCBcIil9JHt0cmFja2VkUGF0aHMubGVuZ3RoID4gNSA/IFwiLi4uXCIgOiBcIlwifWAsXG4gICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICB9KTtcblxuICAgICAgaWYgKHNob3VsZEZpeChcInRyYWNrZWRfcnVudGltZV9maWxlc1wiKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGZvciAoY29uc3QgZXhjbHVzaW9uIG9mIFJVTlRJTUVfRVhDTFVTSU9OX1BBVEhTKSB7XG4gICAgICAgICAgICBuYXRpdmVSbUNhY2hlZChiYXNlUGF0aCwgW2V4Y2x1c2lvbl0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgdW50cmFja2VkICR7dHJhY2tlZFBhdGhzLmxlbmd0aH0gcnVudGltZSBmaWxlKHMpYCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKFwiZmFpbGVkIHRvIHVudHJhY2sgcnVudGltZSBmaWxlc1wiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gZ2l0IGxzLWZpbGVzIGZhaWxlZCBcdTIwMTQgc2tpcFxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIExlZ2FjeSBzbGljZSBicmFuY2hlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgdHJ5IHtcbiAgICBjb25zdCBicmFuY2hMaXN0ID0gbmF0aXZlQnJhbmNoTGlzdChiYXNlUGF0aCwgXCJnc2QvKi8qXCIpXG4gICAgICAuZmlsdGVyKChicmFuY2gpID0+ICFicmFuY2guc3RhcnRzV2l0aChcImdzZC9xdWljay9cIikpO1xuICAgIGlmIChicmFuY2hMaXN0Lmxlbmd0aCA+IDApIHtcbiAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgc2V2ZXJpdHk6IFwiaW5mb1wiLFxuICAgICAgICBjb2RlOiBcImxlZ2FjeV9zbGljZV9icmFuY2hlc1wiLFxuICAgICAgICBzY29wZTogXCJwcm9qZWN0XCIsXG4gICAgICAgIHVuaXRJZDogXCJwcm9qZWN0XCIsXG4gICAgICAgIG1lc3NhZ2U6IGAke2JyYW5jaExpc3QubGVuZ3RofSBsZWdhY3kgc2xpY2UgYnJhbmNoKGVzKSBmb3VuZDogJHticmFuY2hMaXN0LnNsaWNlKDAsIDMpLmpvaW4oXCIsIFwiKX0ke2JyYW5jaExpc3QubGVuZ3RoID4gMyA/IFwiLi4uXCIgOiBcIlwifS4gVGhlc2UgYXJlIG5vIGxvbmdlciB1c2VkIChicmFuY2hsZXNzIGFyY2hpdGVjdHVyZSkuYCxcbiAgICAgICAgZml4YWJsZTogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoc2hvdWxkRml4KFwibGVnYWN5X3NsaWNlX2JyYW5jaGVzXCIpKSB7XG4gICAgICAgIGxldCBkZWxldGVkID0gMDtcbiAgICAgICAgZm9yIChjb25zdCBicmFuY2ggb2YgYnJhbmNoTGlzdCkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBuYXRpdmVCcmFuY2hEZWxldGUoYmFzZVBhdGgsIGJyYW5jaCwgdHJ1ZSk7XG4gICAgICAgICAgICBkZWxldGVkKys7XG4gICAgICAgICAgfSBjYXRjaCB7IC8qIHNraXAgYnJhbmNoZXMgdGhhdCBjYW4ndCBiZSBkZWxldGVkICovIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoZGVsZXRlZCA+IDApIHtcbiAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgZGVsZXRlZCAke2RlbGV0ZWR9IGxlZ2FjeSBzbGljZSBicmFuY2goZXMpYCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIGdpdCBicmFuY2ggbGlzdCBmYWlsZWQgXHUyMDE0IHNraXBcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBJbnRlZ3JhdGlvbiBicmFuY2ggZXhpc3RlbmNlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBGb3IgZWFjaCBhY3RpdmUgKG5vbi1jb21wbGV0ZSkgbWlsZXN0b25lLCB2ZXJpZnkgdGhlIHN0b3JlZCBpbnRlZ3JhdGlvblxuICAvLyBicmFuY2ggc3RpbGwgZXhpc3RzIGluIGdpdC4gQSBtaXNzaW5nIGludGVncmF0aW9uIGJyYW5jaCBibG9ja3MgbWVyZ2UtYmFja1xuICAvLyBhbmQgY2F1c2VzIHRoZSBuZXh0IG1lcmdlIG9wZXJhdGlvbiB0byBmYWlsIHNpbGVudGx5LlxuICB0cnkge1xuICAgIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZVBhdGgpO1xuICAgIGNvbnN0IGdpdFByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy5naXQgPz8ge307XG4gICAgZm9yIChjb25zdCBtaWxlc3RvbmUgb2Ygc3RhdGUucmVnaXN0cnkpIHtcbiAgICAgIGlmIChtaWxlc3RvbmUuc3RhdHVzID09PSBcImNvbXBsZXRlXCIpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgcmVzb2x1dGlvbiA9IHJlc29sdmVNaWxlc3RvbmVJbnRlZ3JhdGlvbkJyYW5jaChiYXNlUGF0aCwgbWlsZXN0b25lLmlkLCBnaXRQcmVmcyk7XG4gICAgICBpZiAoIXJlc29sdXRpb24ucmVjb3JkZWRCcmFuY2gpIGNvbnRpbnVlOyAvLyBObyBzdG9yZWQgYnJhbmNoIFx1MjAxNCBza2lwIChub3QgeWV0IHNldClcbiAgICAgIGlmIChyZXNvbHV0aW9uLnN0YXR1cyA9PT0gXCJmYWxsYmFja1wiICYmIHJlc29sdXRpb24uZWZmZWN0aXZlQnJhbmNoKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJpbnRlZ3JhdGlvbl9icmFuY2hfbWlzc2luZ1wiLFxuICAgICAgICAgIHNjb3BlOiBcIm1pbGVzdG9uZVwiLFxuICAgICAgICAgIHVuaXRJZDogbWlsZXN0b25lLmlkLFxuICAgICAgICAgIG1lc3NhZ2U6IHJlc29sdXRpb24ucmVhc29uLFxuICAgICAgICAgIGZpeGFibGU6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoc2hvdWxkRml4KFwiaW50ZWdyYXRpb25fYnJhbmNoX21pc3NpbmdcIikpIHtcbiAgICAgICAgICB3cml0ZUludGVncmF0aW9uQnJhbmNoKGJhc2VQYXRoLCBtaWxlc3RvbmUuaWQsIHJlc29sdXRpb24uZWZmZWN0aXZlQnJhbmNoKTtcbiAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgdXBkYXRlZCBpbnRlZ3JhdGlvbiBicmFuY2ggZm9yICR7bWlsZXN0b25lLmlkfSB0byBcIiR7cmVzb2x1dGlvbi5lZmZlY3RpdmVCcmFuY2h9XCJgKTtcbiAgICAgICAgfVxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKHJlc29sdXRpb24uc3RhdHVzID09PSBcIm1pc3NpbmdcIikge1xuICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgc2V2ZXJpdHk6IFwiZXJyb3JcIixcbiAgICAgICAgICBjb2RlOiBcImludGVncmF0aW9uX2JyYW5jaF9taXNzaW5nXCIsXG4gICAgICAgICAgc2NvcGU6IFwibWlsZXN0b25lXCIsXG4gICAgICAgICAgdW5pdElkOiBtaWxlc3RvbmUuaWQsXG4gICAgICAgICAgbWVzc2FnZTogcmVzb2x1dGlvbi5yZWFzb24sXG4gICAgICAgICAgZml4YWJsZTogZmFsc2UsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBpbnRlZ3JhdGlvbiBicmFuY2ggY2hlY2sgZmFpbGVkXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgT3JwaGFuZWQgd29ya3RyZWUgZGlyZWN0b3JpZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIFdvcmt0cmVlIHJlbW92YWwgY2FuIGZhaWwgYWZ0ZXIgYSBicmFuY2ggZGVsZXRlLCBsZWF2aW5nIGEgZGlyZWN0b3J5XG4gIC8vIHRoYXQgaXMgbm8gbG9uZ2VyIHJlZ2lzdGVyZWQgd2l0aCBnaXQuIFRoZXNlIG9ycGhhbmVkIGRpcnMgY2F1c2VcbiAgLy8gXCJhbHJlYWR5IGV4aXN0c1wiIGVycm9ycyB3aGVuIHJlLWNyZWF0aW5nIHRoZSBzYW1lIHdvcmt0cmVlIG5hbWUuXG4gIHRyeSB7XG4gICAgY29uc3Qgd3REaXIgPSB3b3JrdHJlZXNEaXIoYmFzZVBhdGgpO1xuICAgIGlmIChleGlzdHNTeW5jKHd0RGlyKSkge1xuICAgICAgLy8gUmVzb2x2ZSBzeW1saW5rcyBhbmQgbm9ybWFsaXplIHNlcGFyYXRvcnMgc28gdGhhdCBzeW1saW5rZWQgLmdzZFxuICAgICAgLy8gcGF0aHMgKGUuZy4gfi8uZ3NkL3Byb2plY3RzLzxoYXNoPi93b3JrdHJlZXMvXHUyMDI2KSBtYXRjaCB0aGUgcGF0aHNcbiAgICAgIC8vIHJldHVybmVkIGJ5IGBnaXQgd29ya3RyZWUgbGlzdGAuXG4gICAgICBjb25zdCBub3JtYWxpemVQYXRoID0gKHA6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgICAgIHRyeSB7IHAgPSByZWFscGF0aFN5bmMocCk7IH0gY2F0Y2ggeyAvKiBwYXRoIG1heSBub3QgZXhpc3QgKi8gfVxuICAgICAgICByZXR1cm4gcC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIik7XG4gICAgICB9O1xuICAgICAgY29uc3QgcmVnaXN0ZXJlZFBhdGhzID0gbmV3IFNldChcbiAgICAgICAgbmF0aXZlV29ya3RyZWVMaXN0KGJhc2VQYXRoKS5tYXAoZW50cnkgPT4gbm9ybWFsaXplUGF0aChlbnRyeS5wYXRoKSksXG4gICAgICApO1xuICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyh3dERpcikpIHtcbiAgICAgICAgY29uc3QgZnVsbFBhdGggPSBqb2luKHd0RGlyLCBlbnRyeSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaWYgKCFzdGF0U3luYyhmdWxsUGF0aCkuaXNEaXJlY3RvcnkoKSkgY29udGludWU7XG4gICAgICAgIH0gY2F0Y2ggeyBjb250aW51ZTsgfVxuICAgICAgICBjb25zdCBub3JtYWxpemVkRnVsbFBhdGggPSBub3JtYWxpemVQYXRoKGZ1bGxQYXRoKTtcbiAgICAgICAgaWYgKCFyZWdpc3RlcmVkUGF0aHMuaGFzKG5vcm1hbGl6ZWRGdWxsUGF0aCkpIHtcbiAgICAgICAgICAvLyBTa2lwIGRpcmVjdG9yaWVzIHRoYXQgb25seSBjb250YWluIGRvY3RvciBhcnRpZmFjdHMgKC5nc2QvZG9jdG9yLWhpc3RvcnkuanNvbmwpLlxuICAgICAgICAgIC8vIGFwcGVuZERvY3Rvckhpc3RvcnkoKSBjYW4gcmVjcmVhdGUgdGhlc2UgZGlycyBkdXJpbmcgdGhlIGF1ZGl0IGl0c2VsZixcbiAgICAgICAgICAvLyBjYXVzaW5nIGEgY2lyY3VsYXIgZmFsc2UgcG9zaXRpdmUgKCMzMTA1IEJ1ZyAxKS5cbiAgICAgICAgICBpZiAoaXNEb2N0b3JBcnRpZmFjdE9ubHkoZnVsbFBhdGgpKSBjb250aW51ZTtcbiAgICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgICBjb2RlOiBcIndvcmt0cmVlX2RpcmVjdG9yeV9vcnBoYW5lZFwiLFxuICAgICAgICAgICAgc2NvcGU6IFwicHJvamVjdFwiLFxuICAgICAgICAgICAgdW5pdElkOiBlbnRyeSxcbiAgICAgICAgICAgIG1lc3NhZ2U6IGBXb3JrdHJlZSBkaXJlY3RvcnkgJHtmdWxsUGF0aH0gZXhpc3RzIG9uIGRpc2sgYnV0IGlzIG5vdCByZWdpc3RlcmVkIHdpdGggZ2l0LiBSdW4gXCJnaXQgd29ya3RyZWUgcHJ1bmVcIiBvciBkb2N0b3IgLS1maXggdG8gcmVtb3ZlIGl0LmAsXG4gICAgICAgICAgICBmaXhhYmxlOiB0cnVlLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGlmIChzaG91bGRGaXgoXCJ3b3JrdHJlZV9kaXJlY3Rvcnlfb3JwaGFuZWRcIikpIHtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIHJtU3luYyhmdWxsUGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgcmVtb3ZlZCBvcnBoYW5lZCB3b3JrdHJlZSBkaXJlY3RvcnkgJHtmdWxsUGF0aH1gKTtcbiAgICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgZmFpbGVkIHRvIHJlbW92ZSBvcnBoYW5lZCB3b3JrdHJlZSBkaXJlY3RvcnkgJHtmdWxsUGF0aH1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgb3JwaGFuZWQgd29ya3RyZWUgZGlyZWN0b3J5IGNoZWNrIGZhaWxlZFxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFN0YWxlIHVuY29tbWl0dGVkIGNoYW5nZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIElmIHRoZSB3b3JraW5nIHRyZWUgaGFzIHVuY29tbWl0dGVkIGNoYW5nZXMgYW5kIHRoZSBsYXN0IGNvbW1pdCB3YXNcbiAgLy8gbG9uZ2VyIGFnbyB0aGFuIHRoZSBjb25maWd1cmVkIHRocmVzaG9sZCwgZmxhZyBpdCBhbmQgb3B0aW9uYWxseVxuICAvLyBhdXRvLWNvbW1pdCBhIHNhZmV0eSBzbmFwc2hvdCBzbyB3b3JrIGlzbid0IGxvc3QuXG4gIHRyeSB7XG4gICAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXMgPz8ge307XG4gICAgLy8gYGdpdC5zbmFwc2hvdHM6IGZhbHNlYCBpcyB0aGUgY2Fub25pY2FsIHRvZ2dsZSB0aGF0IGRpc2FibGVzIFdJUFxuICAgIC8vIHNuYXBzaG90IGNvbW1pdHMgXHUyMDE0IGhvbm91ciBpdCBoZXJlIGFzIHdlbGwgc28gYm90aCB0aGUgcHJvYWN0aXZlIGdhdGVcbiAgICAvLyBhbmQgdGhlIGRvY3Rvci1ydW4gcGF0aCBzdGF5IGNvbnNpc3RlbnQgKCM0NDIwKS5cbiAgICBjb25zdCBzbmFwc2hvdHNFbmFibGVkID0gcHJlZnMuZ2l0Py5zbmFwc2hvdHMgIT09IGZhbHNlO1xuICAgIGNvbnN0IHRocmVzaG9sZE1pbnV0ZXMgPSBwcmVmcy5zdGFsZV9jb21taXRfdGhyZXNob2xkX21pbnV0ZXMgPz8gMzA7XG5cbiAgICBpZiAoc25hcHNob3RzRW5hYmxlZCAmJiB0aHJlc2hvbGRNaW51dGVzID4gMCkge1xuICAgICAgY29uc3QgZGlydHkgPSBuYXRpdmVIYXNDaGFuZ2VzKGJhc2VQYXRoKTtcbiAgICAgIGlmIChkaXJ0eSkge1xuICAgICAgICBjb25zdCBicmFuY2ggPSBuYXRpdmVHZXRDdXJyZW50QnJhbmNoKGJhc2VQYXRoKTtcbiAgICAgICAgY29uc3QgbGFzdEVwb2NoID0gbmF0aXZlTGFzdENvbW1pdEVwb2NoKGJhc2VQYXRoLCBicmFuY2ggfHwgXCJIRUFEXCIpO1xuICAgICAgICBjb25zdCBub3dFcG9jaCA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApO1xuICAgICAgICBjb25zdCBtaW51dGVzU2luY2VDb21taXQgPSBsYXN0RXBvY2ggPiAwID8gKG5vd0Vwb2NoIC0gbGFzdEVwb2NoKSAvIDYwIDogSW5maW5pdHk7XG5cbiAgICAgICAgaWYgKG1pbnV0ZXNTaW5jZUNvbW1pdCA+PSB0aHJlc2hvbGRNaW51dGVzKSB7XG4gICAgICAgICAgY29uc3QgbWlucyA9IE1hdGguZmxvb3IobWludXRlc1NpbmNlQ29tbWl0KTtcbiAgICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgICBjb2RlOiBcInN0YWxlX3VuY29tbWl0dGVkX2NoYW5nZXNcIixcbiAgICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICAgIHVuaXRJZDogXCJwcm9qZWN0XCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgVW5jb21taXR0ZWQgY2hhbmdlcyBkZXRlY3RlZCB3aXRoIG5vIGNvbW1pdCBpbiAke21pbnN9IG1pbnV0ZSR7bWlucyA9PT0gMSA/IFwiXCIgOiBcInNcIn0gKHRocmVzaG9sZDogJHt0aHJlc2hvbGRNaW51dGVzfW0pLiBTbmFwc2hvdHRpbmcgdHJhY2tlZCBmaWxlcy5gLFxuICAgICAgICAgICAgZml4YWJsZTogdHJ1ZSxcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIGNvbnN0IGRpZmZDaGVja0ZhaWx1cmUgPSBnZXRTbmFwc2hvdERpZmZDaGVja0ZhaWx1cmUoYmFzZVBhdGgpO1xuICAgICAgICAgIGlmIChkaWZmQ2hlY2tGYWlsdXJlKSB7XG4gICAgICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgICAgIHNldmVyaXR5OiBcImVycm9yXCIsXG4gICAgICAgICAgICAgIGNvZGU6IFwiY29uZmxpY3RfbWFya2Vyc19pbl90cmFja2VkX2ZpbGVzXCIsXG4gICAgICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICAgICAgdW5pdElkOiBcInByb2plY3RcIixcbiAgICAgICAgICAgICAgbWVzc2FnZTogYENhbm5vdCBjcmVhdGUgZ3NkIHNuYXBzaG90OiB0cmFja2VkIGNoYW5nZXMgY29udGFpbiBjb25mbGljdCBtYXJrZXJzIG9yIHdoaXRlc3BhY2UgZXJyb3JzLiBSZXNvbHZlIGNvbmZsaWN0cyBtYW51YWxseSBiZWZvcmUgYXV0by1tb2RlIGNhbiBwcm9jZWVkLlxcbiR7ZGlmZkNoZWNrRmFpbHVyZX1gLFxuICAgICAgICAgICAgICBmaXhhYmxlOiBmYWxzZSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChzaG91bGRGaXgoXCJzdGFsZV91bmNvbW1pdHRlZF9jaGFuZ2VzXCIpKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBpZiAoZGlmZkNoZWNrRmFpbHVyZSkge1xuICAgICAgICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKFwiZ3NkIHNuYXBzaG90IHNraXBwZWQgLSBjb25mbGljdCBtYXJrZXJzIGRldGVjdGVkIGluIHRyYWNrZWQgZmlsZXNcIik7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbmF0aXZlQWRkVHJhY2tlZChiYXNlUGF0aCk7XG4gICAgICAgICAgICAgICAgY29uc3QgY29tbWl0TXNnID0gYGdzZCBzbmFwc2hvdDogdW5jb21taXR0ZWQgY2hhbmdlcyBhZnRlciAke21pbnN9bSBpbmFjdGl2aXR5YDtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBuYXRpdmVDb21taXQoYmFzZVBhdGgsIGNvbW1pdE1zZyk7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goYGNyZWF0ZWQgZ3NkIHNuYXBzaG90IGFmdGVyICR7bWluc31tIG9mIHVuY29tbWl0dGVkIGNoYW5nZXNgKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgZml4ZXNBcHBsaWVkLnB1c2goXCJnc2Qgc25hcHNob3Qgc2tpcHBlZCBcdTIwMTQgbm90aGluZyB0byBjb21taXQgYWZ0ZXIgc3RhZ2luZyB0cmFja2VkIGZpbGVzXCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKFwiZmFpbGVkIHRvIGNyZWF0ZSBnc2Qgc25hcHNob3QgY29tbWl0XCIpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gTm9uLWZhdGFsIFx1MjAxNCBzdGFsZSBjb21taXQgY2hlY2sgZmFpbGVkXG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgV29ya3RyZWUgbGlmZWN5Y2xlIGNoZWNrcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gQ2hlY2sgR1NELW1hbmFnZWQgd29ya3RyZWVzIGZvcjogbWVyZ2VkIGJyYW5jaGVzLCBzdGFsZSB3b3JrLCBkaXJ0eVxuICAvLyBzdGF0ZSwgYW5kIHVucHVzaGVkIGNvbW1pdHMuIE9ubHkgd29ya3RyZWVzIHVuZGVyIC5nc2Qvd29ya3RyZWVzLy5cbiAgdHJ5IHtcbiAgICBjb25zdCBoZWFsdGhTdGF0dXNlcyA9IGdldEFsbFdvcmt0cmVlSGVhbHRoKGJhc2VQYXRoKTtcbiAgICBjb25zdCBjd2QgPSBwcm9jZXNzLmN3ZCgpO1xuXG4gICAgZm9yIChjb25zdCBoZWFsdGggb2YgaGVhbHRoU3RhdHVzZXMpIHtcbiAgICAgIGNvbnN0IHd0ID0gaGVhbHRoLndvcmt0cmVlO1xuICAgICAgY29uc3QgaXNDd2QgPSB3dC5wYXRoID09PSBjd2QgfHwgY3dkLnN0YXJ0c1dpdGgod3QucGF0aCArIHNlcCk7XG5cbiAgICAgIC8vIEJyYW5jaCBmdWxseSBtZXJnZWQgaW50byBtYWluIFx1MjAxNCBzYWZlIHRvIHJlbW92ZVxuICAgICAgaWYgKGhlYWx0aC5tZXJnZWRJbnRvTWFpbikge1xuICAgICAgICBpc3N1ZXMucHVzaCh7XG4gICAgICAgICAgc2V2ZXJpdHk6IFwiaW5mb1wiLFxuICAgICAgICAgIGNvZGU6IFwid29ya3RyZWVfYnJhbmNoX21lcmdlZFwiLFxuICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICB1bml0SWQ6IHd0Lm5hbWUsXG4gICAgICAgICAgbWVzc2FnZTogYFdvcmt0cmVlIFwiJHt3dC5uYW1lfVwiIChicmFuY2ggJHt3dC5icmFuY2h9KSBpcyBmdWxseSBtZXJnZWQgaW50byBtYWluJHtoZWFsdGguc2FmZVRvUmVtb3ZlID8gXCIgXHUyMDE0IHNhZmUgdG8gcmVtb3ZlXCIgOiBcIlwifWAsXG4gICAgICAgICAgZml4YWJsZTogaGVhbHRoLnNhZmVUb1JlbW92ZSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKGhlYWx0aC5zYWZlVG9SZW1vdmUgJiYgc2hvdWxkRml4KFwid29ya3RyZWVfYnJhbmNoX21lcmdlZFwiKSAmJiAhaXNDd2QpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgeyByZW1vdmVXb3JrdHJlZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi93b3JrdHJlZS1tYW5hZ2VyLmpzXCIpO1xuICAgICAgICAgICAgcmVtb3ZlV29ya3RyZWUoYmFzZVBhdGgsIHd0Lm5hbWUsIHsgZGVsZXRlQnJhbmNoOiB0cnVlLCBicmFuY2g6IHd0LmJyYW5jaCB9KTtcbiAgICAgICAgICAgIGZpeGVzQXBwbGllZC5wdXNoKGByZW1vdmVkIG1lcmdlZCB3b3JrdHJlZSBcIiR7d3QubmFtZX1cIiBhbmQgZGVsZXRlZCBicmFuY2ggJHt3dC5icmFuY2h9YCk7XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICBmaXhlc0FwcGxpZWQucHVzaChgZmFpbGVkIHRvIHJlbW92ZSBtZXJnZWQgd29ya3RyZWUgXCIke3d0Lm5hbWV9XCJgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gSWYgbWVyZ2VkLCBza2lwIHRoZSBzdGFsZS9kaXJ0eS91bnB1c2hlZCBjaGVja3MgXHUyMDE0IHRoZXkncmUgaXJyZWxldmFudFxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gU3RhbGU6IG5vIGNvbW1pdHMgaW4gTiBkYXlzLCBub3QgbWVyZ2VkXG4gICAgICBpZiAoaGVhbHRoLnN0YWxlKSB7XG4gICAgICAgIGNvbnN0IGRheXMgPSBNYXRoLmZsb29yKGhlYWx0aC5sYXN0Q29tbWl0QWdlRGF5cyk7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJ3b3JrdHJlZV9zdGFsZVwiLFxuICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICB1bml0SWQ6IHd0Lm5hbWUsXG4gICAgICAgICAgbWVzc2FnZTogYFdvcmt0cmVlIFwiJHt3dC5uYW1lfVwiIGhhcyBoYWQgbm8gY29tbWl0cyBpbiAke2RheXN9IGRheSR7ZGF5cyA9PT0gMSA/IFwiXCIgOiBcInNcIn1gLFxuICAgICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gRGlydHk6IHVuY29tbWl0dGVkIGNoYW5nZXMgaW4gYSB3b3JrdHJlZSAob25seSBmbGFnIG9uIHN0YWxlIHdvcmt0cmVlcyB0byBhdm9pZCBub2lzZSlcbiAgICAgIGlmIChoZWFsdGguZGlydHkgJiYgaGVhbHRoLnN0YWxlKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJ3b3JrdHJlZV9kaXJ0eVwiLFxuICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICB1bml0SWQ6IHd0Lm5hbWUsXG4gICAgICAgICAgbWVzc2FnZTogYFdvcmt0cmVlIFwiJHt3dC5uYW1lfVwiIGhhcyAke2hlYWx0aC5kaXJ0eUZpbGVDb3VudH0gdW5jb21taXR0ZWQgZmlsZSR7aGVhbHRoLmRpcnR5RmlsZUNvdW50ID09PSAxID8gXCJcIiA6IFwic1wifSBhbmQgaXMgc3RhbGVgLFxuICAgICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gVW5wdXNoZWQ6IGNvbW1pdHMgbm90IG9uIGFueSByZW1vdGUgKG9ubHkgZmxhZyBvbiBzdGFsZSB3b3JrdHJlZXMgdG8gYXZvaWQgbm9pc2UpXG4gICAgICBpZiAoaGVhbHRoLnVucHVzaGVkQ29tbWl0cyA+IDAgJiYgaGVhbHRoLnN0YWxlKSB7XG4gICAgICAgIGlzc3Vlcy5wdXNoKHtcbiAgICAgICAgICBzZXZlcml0eTogXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgY29kZTogXCJ3b3JrdHJlZV91bnB1c2hlZFwiLFxuICAgICAgICAgIHNjb3BlOiBcInByb2plY3RcIixcbiAgICAgICAgICB1bml0SWQ6IHd0Lm5hbWUsXG4gICAgICAgICAgbWVzc2FnZTogYFdvcmt0cmVlIFwiJHt3dC5uYW1lfVwiIGhhcyAke2hlYWx0aC51bnB1c2hlZENvbW1pdHN9IHVucHVzaGVkIGNvbW1pdCR7aGVhbHRoLnVucHVzaGVkQ29tbWl0cyA9PT0gMSA/IFwiXCIgOiBcInNcIn1gLFxuICAgICAgICAgIGZpeGFibGU6IGZhbHNlLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIE5vbi1mYXRhbCBcdTIwMTQgd29ya3RyZWUgbGlmZWN5Y2xlIGNoZWNrIGZhaWxlZFxuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFDQSxTQUFTLGlCQUFpQjtBQUMxQixTQUFTLFlBQVksYUFBYSxjQUFjLFFBQVEsZ0JBQWdCO0FBQ3hFLFNBQVMsTUFBTSxXQUFXO0FBRzFCLFNBQVMsZ0JBQWdCO0FBQ3pCLFNBQVMsZ0JBQWdCLDBCQUEwQjtBQUNuRCxTQUFTLGVBQWUsb0JBQW9CO0FBQzVDLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsYUFBYSwyQkFBMkI7QUFDakQsU0FBUyxlQUFlLGVBQWUsb0JBQW9CO0FBQzNELFNBQVMscUJBQXFCO0FBQzlCLFNBQVMseUJBQXlCLG1DQUFtQyw4QkFBOEI7QUFDbkcsU0FBUyxjQUFjLG9CQUFvQixzQkFBc0Isa0JBQWtCLG9CQUFvQixlQUFlLGdCQUFnQixrQkFBa0IsdUJBQXVCLHdCQUF3QixrQkFBa0Isb0JBQW9CO0FBQzdPLFNBQVMsNEJBQTRCO0FBQ3JDLFNBQVMsbUNBQW1DO0FBUTVDLFNBQVMscUJBQXFCLFNBQTBCO0FBQ3RELE1BQUk7QUFDRixVQUFNLFVBQVUsWUFBWSxPQUFPO0FBRW5DLFFBQUksUUFBUSxXQUFXLEVBQUcsUUFBTztBQUVqQyxRQUFJLFFBQVEsV0FBVyxLQUFLLFFBQVEsQ0FBQyxNQUFNLFFBQVE7QUFDakQsWUFBTSxhQUFhLFlBQVksS0FBSyxTQUFTLE1BQU0sQ0FBQztBQUNwRCxhQUFPLFdBQVcsVUFBVSxLQUFLLFdBQVcsTUFBTSxPQUFLLE1BQU0sc0JBQXNCO0FBQUEsSUFDckY7QUFDQSxXQUFPO0FBQUEsRUFDVCxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLFNBQVMsMkJBQTJCLE1BQXNCO0FBQ3hELFFBQU0sV0FBVyxXQUFXLElBQUksSUFB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
