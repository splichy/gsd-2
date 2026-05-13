import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { debugLog } from "./debug-logger.js";
import { logWarning } from "./workflow-logger.js";
import { emitJournalEvent } from "./journal.js";
import { emitWorktreeCreated, emitWorktreeMerged } from "./worktree-telemetry.js";
import {
  resolveWorktreeProjectRoot,
  normalizeWorktreePathForCompare
} from "./worktree-root.js";
import {
  claimMilestoneLease,
  refreshMilestoneLease,
  releaseMilestoneLease
} from "./db/milestone-leases.js";
import { MergeConflictError } from "./git-service.js";
import {
  getCollapseCadence,
  getMilestoneResquash,
  resquashMilestoneOnMain
} from "./slice-cadence.js";
import { loadEffectiveGSDPreferences, getIsolationMode } from "./preferences.js";
import { invalidateAllCaches } from "./cache.js";
import { resolveMilestoneFile } from "./paths.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";
import {
  autoCommitCurrentBranch,
  getCurrentBranch
} from "./worktree.js";
import { nativeCheckoutBranch } from "./native-git-bridge.js";
import {
  autoWorktreeBranch,
  createAutoWorktree,
  enterAutoWorktree,
  enterBranchModeForMilestone,
  getAutoWorktreePath,
  isInAutoWorktree,
  teardownAutoWorktree
} from "./auto-worktree.js";
const recentWorktreeMergeFailures = /* @__PURE__ */ new Map();
const MERGE_FAILURE_DEDUPE_MS = 6e4;
function resetRecentWorktreeMergeFailuresForTest() {
  recentWorktreeMergeFailures.clear();
}
class UserNotifiedError extends Error {
  cause;
  constructor(message, cause) {
    super(message);
    this.name = "UserNotifiedError";
    this.cause = cause;
  }
}
function isSamePathPhysical(a, b) {
  return normalizeWorktreePathForCompare(a) === normalizeWorktreePathForCompare(b);
}
function isValidMilestoneId(milestoneId) {
  return !/[\/\\]|\.\./.test(milestoneId);
}
function invalidMilestoneIdError(milestoneId) {
  return new Error(
    `Invalid milestoneId: ${milestoneId} \u2014 contains path separators or traversal`
  );
}
function primitiveOverrides(deps) {
  return deps;
}
function readLifecycleFile(deps, path) {
  return primitiveOverrides(deps).readFileSync?.(path, "utf-8") ?? readFileSync(path, "utf-8");
}
function currentLifecycleBranch(deps, basePath) {
  return primitiveOverrides(deps).getCurrentBranch?.(basePath) ?? getCurrentBranch(basePath);
}
function checkoutLifecycleBranch(deps, basePath, branch) {
  const checkoutBranch = primitiveOverrides(deps).checkoutBranch;
  if (checkoutBranch) {
    checkoutBranch(basePath, branch);
    return;
  }
  nativeCheckoutBranch(basePath, branch);
}
function autoCommitLifecycleBranch(deps, basePath, unitType, unitId) {
  return primitiveOverrides(deps).autoCommitCurrentBranch?.(
    basePath,
    unitType,
    unitId
  ) ?? autoCommitCurrentBranch(basePath, unitType, unitId);
}
function lifecycleIsInAutoWorktree(deps, basePath) {
  return primitiveOverrides(deps).isInAutoWorktree?.(basePath) ?? isInAutoWorktree(basePath);
}
function lifecycleAutoWorktreeBranch(deps, milestoneId) {
  return primitiveOverrides(deps).autoWorktreeBranch?.(milestoneId) ?? autoWorktreeBranch(milestoneId);
}
function lifecycleTeardownAutoWorktree(deps, basePath, milestoneId, opts) {
  const override = primitiveOverrides(deps).teardownAutoWorktree;
  if (override) {
    override(basePath, milestoneId, opts);
    return;
  }
  teardownAutoWorktree(basePath, milestoneId, opts);
}
function lifecycleCreateAutoWorktree(deps, basePath, milestoneId) {
  return primitiveOverrides(deps).createAutoWorktree?.(basePath, milestoneId) ?? createAutoWorktree(basePath, milestoneId);
}
function lifecycleEnterAutoWorktree(deps, basePath, milestoneId) {
  return primitiveOverrides(deps).enterAutoWorktree?.(basePath, milestoneId) ?? enterAutoWorktree(basePath, milestoneId);
}
function lifecycleEnterBranchMode(deps, basePath, milestoneId) {
  const override = primitiveOverrides(deps).enterBranchModeForMilestone;
  if (override) {
    override(basePath, milestoneId);
    return;
  }
  enterBranchModeForMilestone(basePath, milestoneId);
}
function lifecycleGetIsolationMode(deps, basePath) {
  return primitiveOverrides(deps).getIsolationMode?.(basePath) ?? getIsolationMode(basePath);
}
function lifecycleInvalidateAllCaches(deps) {
  const override = primitiveOverrides(deps).invalidateAllCaches;
  if (override) {
    override();
    return;
  }
  invalidateAllCaches();
}
function lifecycleResolveMilestoneFile(deps, basePath, milestoneId, fileType) {
  return primitiveOverrides(deps).resolveMilestoneFile?.(
    basePath,
    milestoneId,
    fileType
  ) ?? resolveMilestoneFile(basePath, milestoneId, fileType);
}
function lifecycleLoadPreferences(deps, basePath) {
  const override = primitiveOverrides(deps).loadEffectiveGSDPreferences;
  if (override) return override(basePath);
  return loadEffectiveGSDPreferences(basePath);
}
function validateMilestoneId(milestoneId) {
  if (!isValidMilestoneId(milestoneId)) {
    throw invalidMilestoneIdError(milestoneId);
  }
}
function _enterMilestoneCore(s, deps, milestoneId, ctx) {
  if (!isValidMilestoneId(milestoneId)) {
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      rejected: "invalid-milestone-id"
    });
    return {
      ok: false,
      reason: "invalid-milestone-id",
      cause: invalidMilestoneIdError(milestoneId)
    };
  }
  if (s.isolationDegraded) {
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      skipped: true,
      reason: "isolation-degraded"
    });
    return { ok: false, reason: "isolation-degraded" };
  }
  if (s.workerId) {
    if (s.currentMilestoneId === milestoneId && s.milestoneLeaseToken !== null) {
      const refreshed = refreshMilestoneLease(
        s.workerId,
        milestoneId,
        s.milestoneLeaseToken
      );
      if (refreshed) {
        debugLog("WorktreeLifecycle", {
          action: "enterMilestone",
          milestoneId,
          leaseRefreshed: true,
          fencingToken: s.milestoneLeaseToken
        });
      } else {
        debugLog("WorktreeLifecycle", {
          action: "enterMilestone",
          milestoneId,
          staleLeaseToken: s.milestoneLeaseToken
        });
        s.milestoneLeaseToken = null;
      }
    }
    if (s.currentMilestoneId && s.currentMilestoneId !== milestoneId && s.milestoneLeaseToken !== null) {
      try {
        releaseMilestoneLease(
          s.workerId,
          s.currentMilestoneId,
          s.milestoneLeaseToken
        );
      } catch (err) {
        debugLog("WorktreeLifecycle", {
          action: "enterMilestone",
          milestoneId,
          releasePriorLeaseError: err instanceof Error ? err.message : String(err)
        });
      }
      s.milestoneLeaseToken = null;
    }
    if (s.milestoneLeaseToken === null) {
      try {
        const claim = claimMilestoneLease(s.workerId, milestoneId);
        if (claim.ok) {
          s.milestoneLeaseToken = claim.token;
          debugLog("WorktreeLifecycle", {
            action: "enterMilestone",
            milestoneId,
            leaseAcquired: true,
            fencingToken: claim.token,
            expiresAt: claim.expiresAt
          });
        } else {
          const msg = `Milestone ${milestoneId} is held by worker ${claim.byWorker} until ${claim.expiresAt}.`;
          debugLog("WorktreeLifecycle", {
            action: "enterMilestone",
            milestoneId,
            leaseHeldByOther: claim.byWorker,
            expiresAt: claim.expiresAt
          });
          ctx.notify(
            `${msg} Another auto-mode worker is active. Stop it before entering ${milestoneId}.`,
            "error"
          );
          return { ok: false, reason: "lease-conflict" };
        }
      } catch (err) {
        debugLog("WorktreeLifecycle", {
          action: "enterMilestone",
          milestoneId,
          leaseError: err instanceof Error ? err.message : String(err)
        });
      }
    }
  } else {
    logWarning(
      "worktree",
      `enterMilestone(${milestoneId}) ran before auto worker registration; milestone lease was not claimed.`
    );
  }
  const basePath = resolveWorktreeProjectRoot(s.basePath, s.originalBasePath);
  const mode = getIsolationMode(basePath);
  if (mode === "none") {
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      skipped: true,
      reason: "isolation-disabled"
    });
    emitJournalEvent(s.originalBasePath || s.basePath, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      flowId: randomUUID(),
      seq: 0,
      eventType: "worktree-skip",
      data: { milestoneId, reason: "isolation-disabled" }
    });
    return { ok: true, mode: "none", path: basePath };
  }
  debugLog("WorktreeLifecycle", {
    action: "enterMilestone",
    milestoneId,
    mode,
    basePath
  });
  if (mode === "worktree" && s.currentMilestoneId === milestoneId && s.basePath !== basePath) {
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      mode: "worktree",
      result: "already-entered",
      wtPath: s.basePath
    });
    return { ok: true, mode: "worktree", path: s.basePath };
  }
  if (mode === "branch") {
    try {
      lifecycleEnterBranchMode(deps, basePath, milestoneId);
      rebuildGitService(s, deps);
      invalidateAllCaches();
      debugLog("WorktreeLifecycle", {
        action: "enterMilestone",
        milestoneId,
        mode: "branch",
        result: "success"
      });
      emitJournalEvent(basePath, {
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        flowId: randomUUID(),
        seq: 0,
        eventType: "worktree-skip",
        data: { milestoneId, reason: "branch-mode-no-worktree" }
      });
      ctx.notify(`Switched to branch milestone/${milestoneId}.`, "info");
      return { ok: true, mode: "branch", path: basePath };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog("WorktreeLifecycle", {
        action: "enterMilestone",
        milestoneId,
        mode: "branch",
        result: "error",
        error: msg
      });
      ctx.notify(
        `Branch isolation setup for ${milestoneId} failed: ${msg}. Continuing on current branch.`,
        "warning"
      );
      s.isolationDegraded = true;
      return { ok: false, reason: "creation-failed", cause: err };
    }
  }
  try {
    const existingPath = (primitiveOverrides(deps).getAutoWorktreePath ?? getAutoWorktreePath)(
      basePath,
      milestoneId
    );
    let wtPath;
    if (existingPath) {
      wtPath = lifecycleEnterAutoWorktree(deps, basePath, milestoneId);
    } else {
      wtPath = lifecycleCreateAutoWorktree(deps, basePath, milestoneId);
    }
    s.basePath = wtPath;
    rebuildGitService(s, deps);
    invalidateAllCaches();
    try {
      const enterScope = scopeMilestone(createWorkspace(wtPath), milestoneId);
      deps.worktreeProjection.projectRootToWorktree(enterScope);
    } catch (projErr) {
      debugLog("WorktreeLifecycle", {
        action: "enterMilestone",
        phase: "projection-on-enter",
        error: projErr instanceof Error ? projErr.message : String(projErr)
      });
    }
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      result: "success",
      wtPath
    });
    emitJournalEvent(s.originalBasePath || s.basePath, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      flowId: randomUUID(),
      seq: 0,
      eventType: "worktree-enter",
      data: { milestoneId, wtPath, created: !existingPath }
    });
    try {
      emitWorktreeCreated(s.originalBasePath || s.basePath, milestoneId, {
        reason: existingPath ? "enter-milestone" : "create-milestone"
      });
    } catch (telemetryErr) {
      debugLog("WorktreeLifecycle", {
        action: "enterMilestone",
        phase: "telemetry-emit",
        error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)
      });
    }
    ctx.notify(`Entered worktree for ${milestoneId} at ${wtPath}`, "info");
    return { ok: true, mode: "worktree", path: wtPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog("WorktreeLifecycle", {
      action: "enterMilestone",
      milestoneId,
      result: "error",
      error: msg
    });
    emitJournalEvent(s.originalBasePath || s.basePath, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      flowId: randomUUID(),
      seq: 0,
      eventType: "worktree-create-failed",
      data: { milestoneId, error: msg, fallback: "project-root" }
    });
    ctx.notify(
      `Auto-worktree creation for ${milestoneId} failed: ${msg}. Continuing in project root.`,
      "warning"
    );
    s.isolationDegraded = true;
    return { ok: false, reason: "creation-failed", cause: err };
  }
}
function resolvePausedResumeBasePath(base, persistedWorktreePath, pathExists = existsSync) {
  return persistedWorktreePath && pathExists(persistedWorktreePath) ? persistedWorktreePath : base;
}
function rebuildGitService(s, deps) {
  s.gitService = deps.gitServiceFactory(s.basePath);
}
function emitWorktreeMergeFailedOnce(basePath, milestoneId, err) {
  const msg = err instanceof Error ? err.message : String(err);
  const errorCategory = err instanceof Error ? err.name : "Error";
  const now = Date.now();
  const key = `${basePath}\0${milestoneId}\0${errorCategory}`;
  const previous = recentWorktreeMergeFailures.get(key);
  if (previous && now - previous < MERGE_FAILURE_DEDUPE_MS) return;
  for (const [candidate, ts] of recentWorktreeMergeFailures) {
    if (now - ts >= MERGE_FAILURE_DEDUPE_MS) {
      recentWorktreeMergeFailures.delete(candidate);
    }
  }
  emitJournalEvent(basePath, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    flowId: randomUUID(),
    seq: 0,
    eventType: "worktree-merge-failed",
    data: { milestoneId, error: msg }
  });
  recentWorktreeMergeFailures.set(key, now);
}
function _mergeWorktreeModeImpl(deps, mctx) {
  const { originalBasePath, worktreeBasePath, milestoneId, notify } = mctx;
  if (!originalBasePath) {
    debugLog("WorktreeLifecycle", {
      action: "mergeAndExit",
      milestoneId,
      mode: "worktree",
      skipped: true,
      reason: "missing-original-base"
    });
    return {
      merged: false,
      mode: "worktree",
      codeFilesChanged: false,
      pushed: false
    };
  }
  try {
    const finalScope = scopeMilestone(
      createWorkspace(worktreeBasePath),
      milestoneId
    );
    const { synced } = deps.worktreeProjection.finalizeProjectionForMerge(
      finalScope
    );
    if (synced.length > 0) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        phase: "reverse-sync",
        synced: synced.length
      });
    }
    let roadmapPath = resolveMilestoneFile(
      originalBasePath,
      milestoneId,
      "ROADMAP"
    );
    if (!roadmapPath && !isSamePathPhysical(worktreeBasePath, originalBasePath)) {
      roadmapPath = resolveMilestoneFile(
        worktreeBasePath,
        milestoneId,
        "ROADMAP"
      );
      if (roadmapPath) {
        debugLog("WorktreeLifecycle", {
          action: "mergeAndExit",
          milestoneId,
          phase: "roadmap-fallback",
          note: "resolved from worktree path"
        });
      }
    }
    if (!roadmapPath) {
      lifecycleTeardownAutoWorktree(deps, originalBasePath, milestoneId, {
        preserveBranch: true
      });
      notify(
        `Exited worktree for ${milestoneId} (no roadmap found \u2014 branch preserved for manual merge).`,
        "warning"
      );
      return {
        merged: false,
        mode: "worktree",
        codeFilesChanged: false,
        pushed: false
      };
    }
    const roadmapContent = readLifecycleFile(deps, roadmapPath);
    const mergeResult = deps.mergeMilestoneToMain(
      originalBasePath,
      milestoneId,
      roadmapContent
    );
    try {
      lifecycleTeardownAutoWorktree(deps, originalBasePath, milestoneId);
    } catch {
    }
    if (mergeResult.codeFilesChanged) {
      notify(
        `Milestone ${milestoneId} merged to main.${mergeResult.pushed ? " Pushed to remote." : ""}`,
        "info"
      );
    } else {
      notify(
        `WARNING: Milestone ${milestoneId} merged to main but contained NO code changes \u2014 only .gsd/ metadata files. The milestone summary may describe planned work that was never implemented. Review the milestone output and re-run if code is missing.`,
        "warning"
      );
    }
    return {
      merged: true,
      mode: "worktree",
      codeFilesChanged: mergeResult.codeFilesChanged,
      pushed: mergeResult.pushed,
      commitMessage: mergeResult.commitMessage
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog("WorktreeLifecycle", {
      action: "mergeAndExit",
      milestoneId,
      result: "error",
      error: msg,
      fallback: "chdir-to-project-root"
    });
    emitWorktreeMergeFailedOnce(originalBasePath || worktreeBasePath, milestoneId, err);
    notify(
      `Milestone merge failed: ${msg}. Your worktree and milestone branch are preserved \u2014 retry with \`/gsd dispatch complete-milestone\` or merge manually.`,
      "warning"
    );
    try {
      const gitDir = join(originalBasePath || worktreeBasePath, ".git");
      for (const f of ["SQUASH_MSG", "MERGE_HEAD", "MERGE_MSG"]) {
        const p = join(gitDir, f);
        if (existsSync(p)) unlinkSync(p);
      }
    } catch {
    }
    if (originalBasePath && !worktreeBasePath) {
      try {
        process.chdir(originalBasePath);
      } catch {
      }
    }
    throw err;
  }
}
function _mergeBranchModeImpl(deps, mctx) {
  const { worktreeBasePath, milestoneId, notify } = mctx;
  try {
    const currentBranch = currentLifecycleBranch(deps, worktreeBasePath);
    const milestoneBranch = lifecycleAutoWorktreeBranch(deps, milestoneId);
    if (currentBranch !== milestoneBranch) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        mode: "branch",
        recovery: "checkout-milestone-branch",
        currentBranch,
        milestoneBranch
      });
      try {
        checkoutLifecycleBranch(deps, worktreeBasePath, milestoneBranch);
      } catch (checkoutErr) {
        const checkoutMsg = checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
        notify(
          `Cannot merge milestone ${milestoneId}: working tree is on ${currentBranch} and checkout to ${milestoneBranch} failed (${checkoutMsg}). Resolve manually and run /gsd auto to resume.`,
          "error"
        );
        throw new UserNotifiedError(checkoutMsg, checkoutErr);
      }
      const reverify = currentLifecycleBranch(deps, worktreeBasePath);
      if (reverify !== milestoneBranch) {
        const reverifyMsg = `branch checkout to ${milestoneBranch} reported success but current branch is ${reverify}`;
        notify(
          `Cannot merge milestone ${milestoneId}: ${reverifyMsg}. Resolve manually and run /gsd auto to resume.`,
          "error"
        );
        throw new UserNotifiedError(reverifyMsg);
      }
    }
    const roadmapPath = resolveMilestoneFile(
      worktreeBasePath,
      milestoneId,
      "ROADMAP"
    );
    if (!roadmapPath) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        mode: "branch",
        skipped: true,
        reason: "no-roadmap"
      });
      return {
        merged: false,
        mode: "branch",
        codeFilesChanged: false,
        pushed: false
      };
    }
    const roadmapContent = readLifecycleFile(deps, roadmapPath);
    const mergeResult = deps.mergeMilestoneToMain(
      worktreeBasePath,
      milestoneId,
      roadmapContent
    );
    if (mergeResult.codeFilesChanged) {
      notify(
        `Milestone ${milestoneId} merged (branch mode).${mergeResult.pushed ? " Pushed to remote." : ""}`,
        "info"
      );
    } else {
      notify(
        `WARNING: Milestone ${milestoneId} merged (branch mode) but contained NO code changes \u2014 only .gsd/ metadata. Review the milestone output and re-run if code is missing.`,
        "warning"
      );
    }
    debugLog("WorktreeLifecycle", {
      action: "mergeAndExit",
      milestoneId,
      mode: "branch",
      result: "success"
    });
    return {
      merged: true,
      mode: "branch",
      codeFilesChanged: mergeResult.codeFilesChanged,
      pushed: mergeResult.pushed,
      commitMessage: mergeResult.commitMessage
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog("WorktreeLifecycle", {
      action: "mergeAndExit",
      milestoneId,
      mode: "branch",
      result: "error",
      error: msg
    });
    if (!(err instanceof UserNotifiedError)) {
      notify(`Milestone merge failed (branch mode): ${msg}`, "warning");
    }
    throw err;
  }
}
function mergeMilestoneStandalone(deps, mctx) {
  const { originalBasePath, worktreeBasePath, milestoneId, notify } = mctx;
  validateMilestoneId(milestoneId);
  if (mctx.isolationDegraded) {
    if (originalBasePath) {
      try {
        process.chdir(originalBasePath);
      } catch (err) {
        debugLog("WorktreeLifecycle", {
          action: "mergeAndExit",
          phase: "pre-merge-chdir-failed",
          milestoneId,
          originalBasePath,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    debugLog("WorktreeLifecycle", {
      action: "mergeAndExit",
      milestoneId,
      skipped: true,
      reason: "isolation-degraded"
    });
    notify(
      `Skipping worktree merge for ${milestoneId} \u2014 isolation was degraded (worktree creation failed earlier). Work is on the current branch.`,
      "info"
    );
    return {
      merged: false,
      mode: "skipped",
      codeFilesChanged: false,
      pushed: false
    };
  }
  const mode = getIsolationMode(originalBasePath || worktreeBasePath);
  debugLog("WorktreeLifecycle", {
    action: "mergeAndExit",
    milestoneId,
    mode,
    basePath: worktreeBasePath
  });
  emitJournalEvent(originalBasePath || worktreeBasePath, {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    flowId: randomUUID(),
    seq: 0,
    eventType: "worktree-merge-start",
    data: { milestoneId, mode }
  });
  const inWorktree = lifecycleIsInAutoWorktree(deps, worktreeBasePath) && Boolean(originalBasePath);
  if (mode === "none" && !inWorktree) {
    debugLog("WorktreeLifecycle", {
      action: "mergeAndExit",
      milestoneId,
      skipped: true,
      reason: "mode-none"
    });
    if (originalBasePath) {
      try {
        process.chdir(originalBasePath);
      } catch {
      }
    }
    return {
      merged: false,
      mode: "skipped",
      codeFilesChanged: false,
      pushed: false
    };
  }
  const targetCwd = mode === "worktree" || inWorktree ? worktreeBasePath : originalBasePath;
  if (targetCwd) {
    try {
      process.chdir(targetCwd);
    } catch (err) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        phase: "pre-merge-chdir-failed",
        milestoneId,
        targetCwd,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  if (mode === "worktree" || inWorktree) {
    return _mergeWorktreeModeImpl(deps, mctx);
  }
  if (mode === "branch") {
    return _mergeBranchModeImpl(deps, mctx);
  }
  return {
    merged: false,
    mode: "skipped",
    codeFilesChanged: false,
    pushed: false
  };
}
class WorktreeLifecycle {
  s;
  deps;
  constructor(s, deps) {
    this.s = s;
    this.deps = deps;
  }
  /**
   * Enter or create the auto-worktree for `milestoneId`. Idempotent if
   * already in this milestone (lease refreshed; basePath unchanged).
   *
   * Returns a typed `EnterResult` describing the outcome. Callers may
   * ignore the result if they read `s.basePath` directly afterwards
   * (legacy behaviour); new callers should branch on the result.
   */
  enterMilestone(milestoneId, ctx) {
    return _enterMilestoneCore(this.s, this.deps, milestoneId, ctx);
  }
  /**
   * Exit the current worktree. With `opts.merge === true`, runs the full
   * merge-and-teardown path (worktree-mode or branch-mode auto-detected).
   * With `opts.merge === false`, runs auto-commit and teardown without
   * merging to main.
   *
   * Returns a typed `ExitResult`. `MergeConflictError` is surfaced as
   * `{ ok: false, reason: "merge-conflict", cause }` instead of thrown,
   * giving callers a typed branch for the expected failure path.
   * Unexpected failures (filesystem, git permissions, etc.) are wrapped
   * as `{ ok: false, reason: "teardown-failed", cause }` so callers always
   * receive a discriminated union — no exceptions for any expected outcome.
   */
  exitMilestone(milestoneId, opts, ctx) {
    if (opts.merge) {
      try {
        const merged = this._mergeAndExit(milestoneId, ctx);
        return {
          ok: true,
          merged: merged.merged,
          codeFilesChanged: merged.codeFilesChanged
        };
      } catch (err) {
        if (err instanceof MergeConflictError) {
          return { ok: false, reason: "merge-conflict", cause: err };
        }
        return { ok: false, reason: "teardown-failed", cause: err };
      }
    }
    try {
      this._exitWithoutMerge(milestoneId, ctx, {
        preserveBranch: opts.preserveBranch
      });
      return { ok: true, merged: false, codeFilesChanged: false };
    } catch (err) {
      return { ok: false, reason: "teardown-failed", cause: err };
    }
  }
  /**
   * Milestone transition: merge the current milestone, then enter the next
   * one. Pattern used when the loop detects that the active milestone has
   * changed (current completed, next is now active). Caller is responsible
   * for re-deriving state between the merge and the enter.
   */
  mergeAndEnterNext(currentMilestoneId, nextMilestoneId, ctx) {
    debugLog("WorktreeLifecycle", {
      action: "mergeAndEnterNext",
      currentMilestoneId,
      nextMilestoneId
    });
    let merged = false;
    let mergeThrew = false;
    try {
      merged = this._mergeAndExit(currentMilestoneId, ctx).merged;
    } catch (err) {
      if (err instanceof UserNotifiedError) throw err;
      mergeThrew = true;
      const projectRoot = resolveWorktreeProjectRoot(
        this.s.basePath,
        this.s.originalBasePath
      );
      if (this.s.basePath !== projectRoot) throw err;
    }
    if (!merged && !mergeThrew && !this.s.isolationDegraded) {
      throw new Error(
        `Cannot enter milestone ${nextMilestoneId} because ${currentMilestoneId} was not merged`
      );
    }
    _enterMilestoneCore(this.s, this.deps, nextMilestoneId, ctx);
  }
  // ── Private — exit without merge ─────────────────────────────────────
  _exitWithoutMerge(milestoneId, ctx, opts) {
    validateMilestoneId(milestoneId);
    if (!lifecycleIsInAutoWorktree(this.deps, this.s.basePath)) {
      debugLog("WorktreeLifecycle", {
        action: "exitMilestone",
        milestoneId,
        skipped: true,
        reason: "not-in-worktree"
      });
      return;
    }
    debugLog("WorktreeLifecycle", {
      action: "exitMilestone",
      milestoneId,
      basePath: this.s.basePath
    });
    try {
      autoCommitLifecycleBranch(this.deps, this.s.basePath, "stop", milestoneId);
    } catch (err) {
      debugLog("WorktreeLifecycle", {
        action: "exitMilestone",
        milestoneId,
        phase: "auto-commit-failed",
        error: err instanceof Error ? err.message : String(err)
      });
      ctx.notify(
        `Auto-commit before exiting ${milestoneId} failed: ${err instanceof Error ? err.message : String(err)}. Branch ${lifecycleAutoWorktreeBranch(this.deps, milestoneId)} is preserved for recovery.`,
        "warning"
      );
    }
    if (this.s.originalBasePath) {
      try {
        process.chdir(this.s.originalBasePath);
      } catch (err) {
        debugLog("WorktreeLifecycle", {
          action: "exitMilestone",
          milestoneId,
          phase: "pre-teardown-chdir-failed",
          originalBasePath: this.s.originalBasePath,
          error: err instanceof Error ? err.message : String(err)
        });
        ctx.notify(
          `Could not leave milestone worktree before cleanup: ${err instanceof Error ? err.message : String(err)}. Branch ${lifecycleAutoWorktreeBranch(this.deps, milestoneId)} is preserved for recovery.`,
          "warning"
        );
      }
    }
    let teardownFailed = false;
    try {
      lifecycleTeardownAutoWorktree(this.deps, this.s.originalBasePath, milestoneId, {
        preserveBranch: opts.preserveBranch ?? false
      });
    } catch (err) {
      teardownFailed = true;
      debugLog("WorktreeLifecycle", {
        action: "exitMilestone",
        milestoneId,
        phase: "teardown-failed",
        error: err instanceof Error ? err.message : String(err)
      });
      ctx.notify(
        `Worktree cleanup failed for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}. Branch ${lifecycleAutoWorktreeBranch(this.deps, milestoneId)} is preserved for recovery.`,
        "warning"
      );
    }
    this.restoreToProjectRoot();
    debugLog("WorktreeLifecycle", {
      action: "exitMilestone",
      milestoneId,
      result: "done",
      basePath: this.s.basePath
    });
    ctx.notify(
      teardownFailed ? `Worktree exit for ${milestoneId} needs manual cleanup.` : `Exited worktree for ${milestoneId}`,
      teardownFailed ? "warning" : "info"
    );
  }
  // ── Private — merge and exit (worktree-mode or branch-mode) ──────────
  /**
   * Merge the completed milestone branch back to main and exit the worktree.
   *
   * Session-bound wrapper around `mergeMilestoneStandalone`. Builds a
   * `MergeContext` from `this.s`, layers session-side bookkeeping on top of
   * the result:
   *
   * - resquash-on-merge using `s.milestoneStartShas`
   * - merge-completion telemetry (duration)
   * - mode-specific session restore: worktree-mode → `restoreToProjectRoot`,
   *   branch-mode → `gitService` rebuild
   *
   * Returns the session-less merge result. Errors propagate after
   * `restoreToProjectRoot()` runs so callers always receive a consistent
   * session.
   */
  _mergeAndExit(milestoneId, ctx) {
    const mergeStartedAt = (/* @__PURE__ */ new Date()).toISOString();
    const mergeStartMs = Date.now();
    let result;
    try {
      result = mergeMilestoneStandalone(this.deps, {
        originalBasePath: this.s.originalBasePath,
        worktreeBasePath: this.s.basePath,
        milestoneId,
        isolationDegraded: this.s.isolationDegraded,
        notify: ctx.notify
      });
    } catch (err) {
      this.restoreToProjectRoot();
      throw err;
    }
    if (!result.merged) {
      this.s.milestoneStartShas.delete(milestoneId);
      if (result.mode === "worktree") {
        this.restoreToProjectRoot();
        debugLog("WorktreeLifecycle", {
          action: "mergeAndExit",
          milestoneId,
          result: "done",
          basePath: this.s.basePath
        });
      }
      return result;
    }
    try {
      const startSha = this.s.milestoneStartShas.get(milestoneId);
      if (startSha) {
        const prefs = lifecycleLoadPreferences(
          this.deps,
          this.s.originalBasePath || this.s.basePath
        )?.preferences;
        if (getCollapseCadence(prefs) === "slice" && getMilestoneResquash(prefs)) {
          const resquashResult = resquashMilestoneOnMain(
            this.s.originalBasePath || this.s.basePath,
            milestoneId,
            startSha
          );
          if (resquashResult.resquashed) {
            ctx.notify(
              `slice-cadence: re-squashed slice commits for ${milestoneId} into a single milestone commit.`,
              "info"
            );
          }
        }
        this.s.milestoneStartShas.delete(milestoneId);
      }
    } catch (err) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        phase: "resquash",
        error: err instanceof Error ? err.message : String(err)
      });
    }
    try {
      emitWorktreeMerged(
        this.s.originalBasePath || this.s.basePath,
        milestoneId,
        {
          reason: "milestone-complete",
          startedAt: mergeStartedAt,
          durationMs: Date.now() - mergeStartMs
        }
      );
    } catch (telemetryErr) {
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        phase: "telemetry-emit",
        error: telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr)
      });
    }
    if (result.mode === "worktree") {
      this.restoreToProjectRoot();
      debugLog("WorktreeLifecycle", {
        action: "mergeAndExit",
        milestoneId,
        result: "done",
        basePath: this.s.basePath
      });
    } else if (result.mode === "branch") {
      rebuildGitService(this.s, this.deps);
    }
    return result;
  }
  // ── Removed: _mergeWorktreeMode / _mergeBranchMode bodies ────────────
  // The merge bodies moved to file-scope `_mergeWorktreeModeImpl` and
  // `_mergeBranchModeImpl`, callable from the session-less
  // `mergeMilestoneStandalone` entry. The previous private methods are
  // gone; `_mergeAndExit` above is the only session-bound caller.
  /**
   * Fall back to branch-mode for `milestoneId` after a failed worktree
   * creation, marking the session's isolation as degraded.
   *
   * Currently delegates to `enterBranchModeForMilestone` from auto-worktree.
   * Idempotent: subsequent calls in a degraded session are no-ops.
   *
   * Issue #5587 ships this as a thin adapter; the body extraction joins the
   * other merge-logic move-out in a follow-up cleanup slice.
   */
  degradeToBranchMode(milestoneId, ctx) {
    if (this.s.isolationDegraded) {
      debugLog("WorktreeLifecycle", {
        action: "degradeToBranchMode",
        milestoneId,
        skipped: true,
        reason: "already-degraded"
      });
      return;
    }
    const basePath = resolveWorktreeProjectRoot(
      this.s.basePath,
      this.s.originalBasePath
    );
    try {
      lifecycleEnterBranchMode(this.deps, basePath, milestoneId);
      rebuildGitService(this.s, this.deps);
      invalidateAllCaches();
      this.s.isolationDegraded = true;
      ctx.notify(
        `Switched to branch milestone/${milestoneId} (isolation degraded).`,
        "info"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.notify(
        `Branch isolation setup for ${milestoneId} failed: ${msg}. Continuing on current branch.`,
        "warning"
      );
      this.s.isolationDegraded = true;
    }
  }
  /**
   * Restore `s.basePath` to `s.originalBasePath`, chdir process cwd, and
   * rebuild `s.gitService`. No-op when `originalBasePath` is empty (fresh
   * sessions).
   *
   * Used by error/cleanup paths that need the session to behave as if the
   * worktree was never entered. Does NOT teardown the worktree directory —
   * callers that need teardown go through `exitMilestone({ merge: false })`.
   *
   * ADR-016 phase 3 (#5693): chdir lives inside the verb so callers do not
   * pair `restoreToProjectRoot()` with a redundant `process.chdir`. The
   * chdir runs BEFORE the throwable work (`rebuildGitService`, cache
   * invalidation) so that cleanup-path cwd is restored even if the
   * downstream rebuild throws. The chdir itself is best-effort; failure is
   * logged via debugLog and swallowed.
   */
  restoreToProjectRoot() {
    if (!this.s.originalBasePath) return;
    this.s.basePath = this.s.originalBasePath;
    try {
      process.chdir(this.s.basePath);
    } catch (err) {
      debugLog("WorktreeLifecycle", {
        action: "restoreToProjectRoot",
        result: "chdir-failed",
        basePath: this.s.basePath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    rebuildGitService(this.s, this.deps);
    invalidateAllCaches();
  }
  /**
   * Adopt a session root (ADR-016 phase 2 / B2, issue #5620).
   *
   * Sole owner of `s.basePath` mutation for bootstrap-class transitions:
   * initial session start, paused-resume entry (before persisted-state
   * consultation), and hook-trigger session activation. Defensive about
   * `s.originalBasePath`:
   *
   * - When `originalBase` is explicit: overwrite.
   * - Otherwise, set `s.originalBasePath` only if it is currently empty —
   *   resume paths that already restored `s.originalBasePath` from paused
   *   metadata keep their value.
   *
   * Does NOT chdir; callers that need cwd alignment with the new basePath
   * are responsible for it. Does NOT rebuild `s.gitService` — callers that
   * mutate `s.basePath` to a non-project-root path (e.g. a worktree on a
   * subsequent milestone enter) go through `enterMilestone`, which handles
   * the rebuild.
   */
  adoptSessionRoot(base, originalBase) {
    this.s.basePath = base;
    if (originalBase !== void 0) {
      this.s.originalBasePath = originalBase;
    } else if (!this.s.originalBasePath) {
      this.s.originalBasePath = base;
    }
  }
  /**
   * Resume from a paused session (ADR-016 phase 2 / B3, issue #5621).
   *
   * Adopts `persistedWorktreePath` as `s.basePath` when the path is
   * non-null and exists on disk; otherwise falls back to `base`. Mirrors
   * the resume guard at `auto.ts:2164` — a stale or removed worktree
   * directory must not strand the resumed session in an invalid root.
   *
   * Folds in the body of the legacy `_resolvePausedResumeBasePathForTest`
   * helper (see `resolvePausedResumeBasePath` below). After this verb
   * lands the helper is deleted from `auto.ts` per the slice-7 closure
   * decision to retire `_*ForTest` suffixes from production paths.
   *
   * Like `adoptSessionRoot`, this is a pure session-state mutation — no
   * chdir, no git service rebuild, no cache invalidation.
   */
  resumeFromPausedSession(base, persistedWorktreePath) {
    this.s.basePath = resolvePausedResumeBasePath(base, persistedWorktreePath);
  }
  /**
   * Adopt an orphan worktree for a bootstrap-time merge (ADR-016 phase 2 / B4,
   * issue #5622).
   *
   * Owns the swap-run-revert protocol that bootstrap previously open-coded:
   *
   *   1. Snapshot prior `s.basePath` and `s.originalBasePath`.
   *   2. Resolve `getAutoWorktreePath(base, milestoneId) ?? base` before
   *      mutating session state, then set `s.originalBasePath = base` and
   *      `s.basePath` to the resolved path.
   *   3. Invoke the caller-supplied `run` callback under the swap.
   *   4. On `!result.merged`: revert to `base` and `chdir(base)` so the
   *      caller can return early without leaving the session in a half-
   *      swapped state.
   *   5. On `result.merged && !s.active`: revert to the snapshotted prior
   *      paths (the orphan merge succeeded but bootstrap chose not to keep
   *      the session active).
   *   6. On `result.merged && s.active`: leave the swap in place — the
   *      loop will continue from the worktree path.
   *
   * The callback shape forces every caller through the same revert
   * protocol; an open-coded swap that forgets to revert on failure was the
   * original bug pattern this verb is designed to prevent.
   */
  adoptOrphanWorktree(milestoneId, base, run) {
    validateMilestoneId(milestoneId);
    const priorBasePath = this.s.basePath;
    const priorOriginalBasePath = this.s.originalBasePath;
    const restorePriorPaths = (phase) => {
      this.s.basePath = priorBasePath || base;
      this.s.originalBasePath = priorOriginalBasePath || base;
      try {
        process.chdir(this.s.originalBasePath || base);
      } catch (err) {
        debugLog("WorktreeLifecycle", {
          action: "adoptOrphanWorktree",
          phase,
          base: this.s.originalBasePath || base,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    };
    let adoptedBasePath;
    try {
      const wtPathFn = primitiveOverrides(this.deps).getAutoWorktreePath ?? getAutoWorktreePath;
      adoptedBasePath = wtPathFn(base, milestoneId) ?? base;
    } catch (err) {
      restorePriorPaths("rollback-resolve-worktree-failed");
      throw err;
    }
    this.s.originalBasePath = base;
    this.s.basePath = adoptedBasePath;
    let result;
    try {
      result = run();
    } catch (err) {
      restorePriorPaths("rollback-run-failed");
      throw err;
    }
    if (!result.merged) {
      this.s.basePath = base;
      this.s.originalBasePath = base;
      try {
        process.chdir(base);
      } catch (err) {
        debugLog("WorktreeLifecycle", {
          action: "adoptOrphanWorktree",
          phase: "revert-chdir-failed",
          base,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      return result;
    }
    if (!this.s.active) {
      this.s.basePath = priorBasePath || base;
      this.s.originalBasePath = priorOriginalBasePath || base;
    }
    return result;
  }
  /** True if `milestoneId` is the session's currently-active milestone. */
  isInMilestone(milestoneId) {
    return this.s.currentMilestoneId === milestoneId;
  }
  /** The active milestone id, or `null` if no milestone is active. */
  getCurrentMilestoneIfAny() {
    return this.s.currentMilestoneId;
  }
}
export {
  WorktreeLifecycle,
  _enterMilestoneCore,
  mergeMilestoneStandalone,
  resetRecentWorktreeMergeFailuresForTest,
  resolvePausedResumeBasePath
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC93b3JrdHJlZS1saWZlY3ljbGUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdTRC0yIFx1MjAxNCBXb3JrdHJlZSBMaWZlY3ljbGUgbW9kdWxlOiBvd25zIG1pbGVzdG9uZSBlbnRyeS9leGl0IGxpZmVjeWNsZSBiZWhpbmQgYSBzbWFsbCwgdHlwZWQgSW50ZXJmYWNlLlxuLyoqXG4gKiBXb3JrdHJlZSBMaWZlY3ljbGUgbW9kdWxlIFx1MjAxNCBmaXJzdC1jbGFzcyBNb2R1bGUgZm9yIHdvcmt0cmVlIGNyZWF0ZS9lbnRlci9leGl0L21lcmdlLlxuICpcbiAqIFBlciBBRFItMDE2LCB0aGlzIE1vZHVsZSBpcyB0aGUgc29sZSBvd25lciBvZjpcbiAqICAgLSBgcy5iYXNlUGF0aGAgbXV0YXRpb24gYWNyb3NzIHRoZSBzZXNzaW9uXG4gKiAgIC0gYHByb2Nlc3MuY2hkaXIoKWAgZGlzY2lwbGluZSBmb3Igd29ya3RyZWUgdHJhbnNpdGlvbnMgKGRlbGVnYXRlZCB0b1xuICogICAgIGBlbnRlckF1dG9Xb3JrdHJlZWAvYGNyZWF0ZUF1dG9Xb3JrdHJlZWAsIHdoaWNoIGNoZGlyIGludGVybmFsbHkpXG4gKiAgIC0gbWlsZXN0b25lIGxlYXNlIGNvb3JkaW5hdGlvbiAoY2xhaW0vcmVmcmVzaC9yZWxlYXNlIGZlbmNpbmcgdG9rZW5zKVxuICpcbiAqIFBoYXNlIDEgb2YgdGhlIG1pZ3JhdGlvbiBzaGlwcyBvbmx5IGBlbnRlck1pbGVzdG9uZWAuIFRoZSByZW1haW5pbmcgdmVyYnNcbiAqIChgZXhpdE1pbGVzdG9uZWAsIGBkZWdyYWRlVG9CcmFuY2hNb2RlYCwgYHJlc3RvcmVUb1Byb2plY3RSb290YCwgcXVlcmllcykgYXJlXG4gKiBleHRyYWN0ZWQgZnJvbSBgV29ya3RyZWVSZXNvbHZlcmAgaW4gc3Vic2VxdWVudCBzbGljZXMuXG4gKlxuICogVGhlIGltcGxlbWVudGF0aW9uIGxpdmVzIGluIGBfZW50ZXJNaWxlc3RvbmVDb3JlYCBzbyBgV29ya3RyZWVSZXNvbHZlcmAgY2FuXG4gKiBjYWxsIHRoZSBzYW1lIGJvZHkgZHVyaW5nIGl0cyBpbnRlcm5hbCBgbWVyZ2VBbmRFbnRlck5leHRgIHJlY3Vyc2lvbiB3aXRob3V0XG4gKiBhIGNpcmN1bGFyIHJlZmVyZW5jZS4gQm90aCBjbGFzc2VzIHNoYXJlIHRoZSBib2R5IHVudGlsIHRoZSBSZXNvbHZlciByZXRpcmVzLlxuICovXG5cbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYywgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSBcIm5vZGU6Y3J5cHRvXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgdHlwZSB7IEF1dG9TZXNzaW9uIH0gZnJvbSBcIi4vYXV0by9zZXNzaW9uLmpzXCI7XG5pbXBvcnQgeyBkZWJ1Z0xvZyB9IGZyb20gXCIuL2RlYnVnLWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgbG9nV2FybmluZyB9IGZyb20gXCIuL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgZW1pdEpvdXJuYWxFdmVudCB9IGZyb20gXCIuL2pvdXJuYWwuanNcIjtcbmltcG9ydCB7IGVtaXRXb3JrdHJlZUNyZWF0ZWQsIGVtaXRXb3JrdHJlZU1lcmdlZCB9IGZyb20gXCIuL3dvcmt0cmVlLXRlbGVtZXRyeS5qc1wiO1xuaW1wb3J0IHtcbiAgcmVzb2x2ZVdvcmt0cmVlUHJvamVjdFJvb3QsXG4gIG5vcm1hbGl6ZVdvcmt0cmVlUGF0aEZvckNvbXBhcmUsXG59IGZyb20gXCIuL3dvcmt0cmVlLXJvb3QuanNcIjtcbmltcG9ydCB7XG4gIGNsYWltTWlsZXN0b25lTGVhc2UsXG4gIHJlZnJlc2hNaWxlc3RvbmVMZWFzZSxcbiAgcmVsZWFzZU1pbGVzdG9uZUxlYXNlLFxufSBmcm9tIFwiLi9kYi9taWxlc3RvbmUtbGVhc2VzLmpzXCI7XG5pbXBvcnQgeyBNZXJnZUNvbmZsaWN0RXJyb3IgfSBmcm9tIFwiLi9naXQtc2VydmljZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBHaXRQcmVmZXJlbmNlcyB9IGZyb20gXCIuL2dpdC1zZXJ2aWNlLmpzXCI7XG5pbXBvcnQge1xuICBnZXRDb2xsYXBzZUNhZGVuY2UsXG4gIGdldE1pbGVzdG9uZVJlc3F1YXNoLFxuICByZXNxdWFzaE1pbGVzdG9uZU9uTWFpbixcbn0gZnJvbSBcIi4vc2xpY2UtY2FkZW5jZS5qc1wiO1xuLy8gQURSLTAxNiBwaGFzZSAyIC8gQzMgKCM1NjI2KTogY2FjaGUgKyBwcmVmZXJlbmNlcyArIHBhdGggaGVscGVycyBpbmxpbmVkXG4vLyBhcyBkaXJlY3QgaW1wb3J0cy4gVGhleSBhcmUgbGVhZi1sZXZlbCBmdW5jdGlvbnMgdGhhdCBkbyBub3QgdmFyeSBhY3Jvc3Ncbi8vIGNhbGxlcnMgXHUyMDE0IHByb2R1Y3Rpb24gd2lyaW5nIHByZXZpb3VzbHkgaW5qZWN0ZWQgdGhlbSB2aWEgZGVwczsgdGhlIHNlYW1cbi8vIGFkZGVkIHR5cGUgY2h1cm4gd2l0aG91dCBlbmFibGluZyB0ZXN0IHZhcmlhdGlvbi5cbmltcG9ydCB7IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcywgZ2V0SXNvbGF0aW9uTW9kZSB9IGZyb20gXCIuL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBpbnZhbGlkYXRlQWxsQ2FjaGVzIH0gZnJvbSBcIi4vY2FjaGUuanNcIjtcbmltcG9ydCB7IHJlc29sdmVNaWxlc3RvbmVGaWxlIH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB0eXBlIHsgV29ya3RyZWVTdGF0ZVByb2plY3Rpb24gfSBmcm9tIFwiLi93b3JrdHJlZS1zdGF0ZS1wcm9qZWN0aW9uLmpzXCI7XG5pbXBvcnQgeyBjcmVhdGVXb3Jrc3BhY2UsIHNjb3BlTWlsZXN0b25lIH0gZnJvbSBcIi4vd29ya3NwYWNlLmpzXCI7XG4vLyBBRFItMDE2IHBoYXNlIDIgLyBDMSAoIzU2MjQpOiBmaWxlLXN5c3RlbSArIGdpdC1DTEkgbGVhZiBwcmltaXRpdmVzXG4vLyBpbmxpbmVkIGFzIGRpcmVjdCBpbXBvcnRzIHJhdGhlciB0aGFuIGluamVjdGVkIHRocm91Z2ggYFdvcmt0cmVlTGlmZWN5Y2xlRGVwc2AuXG4vLyBUaGVzZSBmb3VyIHN5bWJvbHMgKGByZWFkRmlsZVN5bmNgIGZyb20gbm9kZTpmcywgYGdldEN1cnJlbnRCcmFuY2hgIGFuZFxuLy8gYGF1dG9Db21taXRDdXJyZW50QnJhbmNoYCBmcm9tIGAuL3dvcmt0cmVlLmpzYCwgYG5hdGl2ZUNoZWNrb3V0QnJhbmNoYCBmcm9tXG4vLyBgLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc2ApIGFyZSBsZWFmLWxldmVsIHByaW1pdGl2ZXMgXHUyMDE0IG5vIGVudmlyb25tZW50IHZhcmllc1xuLy8gYWNyb3NzIGNhbGxlcnMgXHUyMDE0IHNvIHRoZSBkZXBlbmRlbmN5LWluamVjdGlvbiBzZWFtIHRoZXkgdXNlZCB0byBpbmhhYml0IHdhc1xuLy8gYWRkaW5nIHR5cGUgY2h1cm4gd2l0aG91dCBlbmFibGluZyBhbnkgdGVzdCB2YXJpYXRpb24uXG5pbXBvcnQge1xuICBhdXRvQ29tbWl0Q3VycmVudEJyYW5jaCxcbiAgZ2V0Q3VycmVudEJyYW5jaCxcbn0gZnJvbSBcIi4vd29ya3RyZWUuanNcIjtcbmltcG9ydCB7IG5hdGl2ZUNoZWNrb3V0QnJhbmNoIH0gZnJvbSBcIi4vbmF0aXZlLWdpdC1icmlkZ2UuanNcIjtcbi8vIEFEUi0wMTYgcGhhc2UgMiAvIEMyICgjNTYyNSk6IHdvcmt0cmVlLW1hbmFnZXIgaGVscGVycyBpbmxpbmVkIGZyb21cbi8vIGAuL2F1dG8td29ya3RyZWUuanNgLiBUaGVzZSBzZXZlbiBmdW5jdGlvbnMgYXJlIG5vdCByZWFsIHNlYW1zIFx1MjAxNCBMaWZlY3ljbGVcbi8vIGlzIHRoZSBvbmx5IE1vZHVsZSB0aGF0IGNhbGxzIHRoZW0sIGFuZCB0aGV5IGxpdmUgYWxvbmdzaWRlIHRoZSBNb2R1bGUnc1xuLy8gb3RoZXIgcHJpbWl0aXZlcyBpbiBgYXV0by13b3JrdHJlZS50c2AuXG5pbXBvcnQge1xuICBhdXRvV29ya3RyZWVCcmFuY2gsXG4gIGNyZWF0ZUF1dG9Xb3JrdHJlZSxcbiAgZW50ZXJBdXRvV29ya3RyZWUsXG4gIGVudGVyQnJhbmNoTW9kZUZvck1pbGVzdG9uZSxcbiAgZ2V0QXV0b1dvcmt0cmVlUGF0aCxcbiAgaXNJbkF1dG9Xb3JrdHJlZSxcbiAgdGVhcmRvd25BdXRvV29ya3RyZWUsXG59IGZyb20gXCIuL2F1dG8td29ya3RyZWUuanNcIjtcblxuY29uc3QgcmVjZW50V29ya3RyZWVNZXJnZUZhaWx1cmVzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbmNvbnN0IE1FUkdFX0ZBSUxVUkVfREVEVVBFX01TID0gNjBfMDAwO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRSZWNlbnRXb3JrdHJlZU1lcmdlRmFpbHVyZXNGb3JUZXN0KCk6IHZvaWQge1xuICByZWNlbnRXb3JrdHJlZU1lcmdlRmFpbHVyZXMuY2xlYXIoKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFR5cGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgaW50ZXJmYWNlIE5vdGlmeUN0eCB7XG4gIG5vdGlmeTogKFxuICAgIG1zZzogc3RyaW5nLFxuICAgIGxldmVsPzogXCJpbmZvXCIgfCBcIndhcm5pbmdcIiB8IFwiZXJyb3JcIiB8IFwic3VjY2Vzc1wiLFxuICApID0+IHZvaWQ7XG59XG5cbi8qKlxuICogRGVwZW5kZW5jaWVzIHRoZSBXb3JrdHJlZSBMaWZlY3ljbGUgTW9kdWxlIG5lZWRzIGZyb20gYXV0by1tb2RlIHdpcmluZy5cbiAqXG4gKiBTdHJ1Y3R1cmFsbHkgYSBzdWJzZXQgb2YgYFdvcmt0cmVlUmVzb2x2ZXJEZXBzYC4gYFdvcmt0cmVlUmVzb2x2ZXJgIGNhbiBwYXNzXG4gKiBpdHMgb3duIGRlcHMgd2hlcmUgdGhlc2UgYXJlIGV4cGVjdGVkIFx1MjAxNCBUeXBlU2NyaXB0J3Mgc3RydWN0dXJhbCB0eXBpbmdcbiAqIGhhbmRsZXMgdGhlIG5hcnJvd2luZy5cbiAqXG4gKiBUT0RPKCM1NTg2KTogY29sbGFwc2UgdGhpcyB0byB0aGUgQURSIHRhcmdldCBkZXAgc2V0IGFmdGVyIHRoZSByZXNvbHZlclxuICogcmVjdXJzaW9uIHJldGlyZXM7IHNocmlua2luZyBpdCBub3cgd291bGQgZm9yY2UgYSBwYXJhbGxlbCBtaWdyYXRpb24uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgV29ya3RyZWVMaWZlY3ljbGVEZXBzIHtcbiAgLy8gXHUyNTAwXHUyNTAwIEdpdCBzZXJ2aWNlIGZhY3RvcnkgKEFEUi0wMTYgcGhhc2UgMiAvIEM0KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLyoqXG4gICAqIEJ1aWxkIGEgZnJlc2ggYEdpdFNlcnZpY2VgIGluc3RhbmNlIGJvdW5kIHRvIGBiYXNlUGF0aGAuXG4gICAqXG4gICAqIEhpZGVzIHRoZSBjb25zdHJ1Y3RvciBzaGFwZSAobmV3IEdpdFNlcnZpY2VJbXBsKGJhc2VQYXRoLCBnaXRDb25maWcpKVxuICAgKiBhbmQgdGhlIGdpdENvbmZpZyBsb2FkIGZyb20gTGlmZWN5Y2xlLiBUaGUgZmFjdG9yeSB0YWtlcyBvbmx5IGFcbiAgICogYGJhc2VQYXRoYCBhbmQgaXMgcmVzcG9uc2libGUgZm9yIGxvYWRpbmcgYW55IGNvbmZpZyBpdCBuZWVkcy5cbiAgICogVGVzdHMgc3Vic3RpdHV0ZSBmYWtlcyBieSBwYXNzaW5nIGEgZnVuY3Rpb24gdGhhdCByZXR1cm5zIGEgc3R1Yi5cbiAgICovXG4gIGdpdFNlcnZpY2VGYWN0b3J5OiAoYmFzZVBhdGg6IHN0cmluZykgPT4gQXV0b1Nlc3Npb25bXCJnaXRTZXJ2aWNlXCJdO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBTdGF0ZSBQcm9qZWN0aW9uIE1vZHVsZSAoQURSLTAxNiBvbmUtd2F5IGVkZ2UpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvKipcbiAgICogU3RhdGUgUHJvamVjdGlvbiBNb2R1bGUgY2FsbGVkIGJ5IExpZmVjeWNsZSBvbiBlbnRlci9leGl0IHRyYW5zaXRpb25zLlxuICAgKiBQZXIgQURSLTAxNiB0aGUgZGVwZW5kZW5jeSBkaXJlY3Rpb24gaXMgb25lLXdheTogTGlmZWN5Y2xlIFx1MjE5MiBQcm9qZWN0aW9uLlxuICAgKi9cbiAgd29ya3RyZWVQcm9qZWN0aW9uOiBXb3JrdHJlZVN0YXRlUHJvamVjdGlvbjtcblxuICAvLyBcdTI1MDBcdTI1MDAgTWVyZ2UgcHJpbWl0aXZlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvKipcbiAgICogSW5uZXIgc3F1YXNoLW1lcmdlIHByaW1pdGl2ZSAoYGF1dG8td29ya3RyZWUudHM6bWVyZ2VNaWxlc3RvbmVUb01haW5gKS5cbiAgICpcbiAgICogKipNb2R1bGUtaW50ZXJuYWwgc2VhbSBcdTIwMTQgZG8gbm90IGNvbnN0cnVjdCB5b3VyIG93bi4qKiBPbmx5IHRoZSB3aXJpbmdcbiAgICogZmFjdG9yeSBgYXV0by50czpidWlsZFdvcmt0cmVlTGlmZWN5Y2xlRGVwcygpYCBpcyBwZXJtaXR0ZWQgdG8gcG9wdWxhdGVcbiAgICogdGhpcyBmaWVsZC4gVGhlIHByaW1pdGl2ZSBpcyBgQGludGVybmFsYDsgcHJvZHVjdGlvbiBjYWxsZXJzIHJlYWNoIHRoZVxuICAgKiBtZXJnZSBib2R5IHRocm91Z2ggYFdvcmt0cmVlTGlmZWN5Y2xlLmV4aXRNaWxlc3RvbmUoeyBtZXJnZTogdHJ1ZSB9KWAsXG4gICAqIG5ldmVyIGJ5IGNhbGxpbmcgdGhpcyBkZXAgZGlyZWN0bHkuXG4gICAqL1xuICBtZXJnZU1pbGVzdG9uZVRvTWFpbjogKFxuICAgIGJhc2VQYXRoOiBzdHJpbmcsXG4gICAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgICByb2FkbWFwQ29udGVudDogc3RyaW5nLFxuICApID0+IHtcbiAgICBwdXNoZWQ6IGJvb2xlYW47XG4gICAgY29kZUZpbGVzQ2hhbmdlZDogYm9vbGVhbjtcbiAgICBjb21taXRNZXNzYWdlPzogc3RyaW5nO1xuICB9O1xuXG4gIC8vIEFEUi0wMTYgcGhhc2UgMiAvIEMxICsgQzIgKyBDMyArIEM0IGlubGluZWQgdGhlIGZvbGxvd2luZyBmaWVsZHMgYXNcbiAgLy8gZGlyZWN0IGltcG9ydHMgXHUyMDE0IGxlYWYgcHJpbWl0aXZlcyB0aGF0IGRpZCBub3QgdmFyeSBhY3Jvc3MgY2FsbGVyczpcbiAgLy8gICBDMSAoIzU2MjQpOiByZWFkRmlsZVN5bmMsIGdldEN1cnJlbnRCcmFuY2gsIGNoZWNrb3V0QnJhbmNoLFxuICAvLyAgICAgICAgICAgICAgIGF1dG9Db21taXRDdXJyZW50QnJhbmNoXG4gIC8vICAgQzIgKCM1NjI1KTogZW50ZXJBdXRvV29ya3RyZWUsIGNyZWF0ZUF1dG9Xb3JrdHJlZSxcbiAgLy8gICAgICAgICAgICAgICBlbnRlckJyYW5jaE1vZGVGb3JNaWxlc3RvbmUsIGdldEF1dG9Xb3JrdHJlZVBhdGgsXG4gIC8vICAgICAgICAgICAgICAgdGVhcmRvd25BdXRvV29ya3RyZWUsIGlzSW5BdXRvV29ya3RyZWUsIGF1dG9Xb3JrdHJlZUJyYW5jaFxuICAvLyAgIEMzICgjNTYyNik6IGludmFsaWRhdGVBbGxDYWNoZXMsIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyxcbiAgLy8gICAgICAgICAgICAgICBnZXRJc29sYXRpb25Nb2RlLCByZXNvbHZlTWlsZXN0b25lRmlsZVxuICAvLyAgIEM0ICgjNTYyNyk6IEdpdFNlcnZpY2VJbXBsIGNvbnN0cnVjdG9yIFx1MjE5MiBnaXRTZXJ2aWNlRmFjdG9yeSBhYm92ZVxuICAvL1xuICAvLyBBRFItMDE2IHBoYXNlIDMgKCM1NjkzKSBkZWxldGVkIHRoZSBAZGVwcmVjYXRlZCBvcHRpb25hbCBmaWVsZHMgdGhhdFxuICAvLyByZW1haW5lZCBvbiB0aGlzIEludGVyZmFjZSBmb3IgbGVnYWN5IHRlc3QgZml4dHVyZXMuIFRlc3RzIHRoYXQgbmVlZCB0b1xuICAvLyBzdWJzdGl0dXRlIHByaW1pdGl2ZSBpbXBsZW1lbnRhdGlvbnMgY2FzdCB0aGVpciBkZXBzIHRvXG4gIC8vIGBXb3JrdHJlZUxpZmVjeWNsZVRlc3RPdmVycmlkZXNgIChleHBvcnRlZCBiZWxvdykgXHUyMDE0IHRoZSB0ZXN0IHNlYW0gbm93XG4gIC8vIGxpdmVzIG91dHNpZGUgdGhlIHB1YmxpYyBJbnRlcmZhY2UuXG4gIC8vXG4gIC8vIEZpbmFsIGRlcCBiYWc6IDMgZmllbGRzLiBUaGUgQURSJ3MgZW52aXNpb25lZCBzaGFwZSB3YXMgXHUyMjY0Ni5cbn1cblxuLyoqXG4gKiBUZXN0LW9ubHkgb3ZlcnJpZGUgc2hpbS4gUHJvZHVjdGlvbiBjYWxsZXJzIGRvIG5vdCB1c2UgdGhpcyB0eXBlIFx1MjAxNCBpdFxuICogZXhpc3RzIHNvIGxlZ2FjeSB0ZXN0IGZpeHR1cmVzIGNhbiBzdWJzdGl0dXRlIHRoZSBwcmltaXRpdmUgaW1wbGVtZW50YXRpb25zXG4gKiB0aGF0IHdlcmUgaW5saW5lZCBpbnRvIExpZmVjeWNsZSBpbiBBRFItMDE2IHBoYXNlIDIgKEMxLUM0KS4gUGFzcyBhbiBvYmplY3RcbiAqIHR5cGVkIGBXb3JrdHJlZUxpZmVjeWNsZURlcHMgJiBXb3JrdHJlZUxpZmVjeWNsZVRlc3RPdmVycmlkZXNgIHRvIHRoZVxuICogYFdvcmt0cmVlTGlmZWN5Y2xlYCBjb25zdHJ1Y3RvcjsgTGlmZWN5Y2xlIHJlYWRzIHRoZSBvdmVycmlkZXMgdGhyb3VnaCB0aGVcbiAqIHN0cnVjdHVyYWwtdHlwaW5nIGVzY2FwZSBoYXRjaCBpbiBgcHJpbWl0aXZlT3ZlcnJpZGVzKClgLlxuICpcbiAqIFRoZSBmaWVsZHMgaGVyZSBpbnRlbnRpb25hbGx5IGR1cGxpY2F0ZSB0aGUgQzEtQzQtaW5saW5lZCBwcmltaXRpdmVcbiAqIHNpZ25hdHVyZXMuIEFkZGluZyBuZXcgZmllbGRzIGlzIGZpbmUgd2hlbiBhIHRlc3QgbmVlZHMgdG8gdmFyeSBhIHByaW1pdGl2ZVxuICogdGhhdCBoYXMgbm8gb3RoZXIgc2VhbS5cbiAqL1xuZXhwb3J0IHR5cGUgV29ya3RyZWVMaWZlY3ljbGVUZXN0T3ZlcnJpZGVzID0gV29ya3RyZWVMaWZlY3ljbGVQcmltaXRpdmVPdmVycmlkZXM7XG5cbi8qKlxuICogSW50ZXJuYWwgc2VudGluZWwgXHUyMDE0IHRocm93biBieSBgX21lcmdlQnJhbmNoTW9kZWAgd2hlbiBpdCBoYXMgYWxyZWFkeVxuICogZW1pdHRlZCBhIHVzZXItdmlzaWJsZSBlcnJvci4gVGhlIG91dGVyIGBtZXJnZUFuZEV4aXRgIGNhdGNoZXMgdGhlIHR5cGVcbiAqIGFuZCBza2lwcyBpdHMgb3duIHdhcm5pbmcgdG9hc3QgdG8gYXZvaWQgZHVwbGljYXRlIG5vdGlmaWNhdGlvbnMuXG4gKi9cbmNsYXNzIFVzZXJOb3RpZmllZEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBjYXVzZT86IHVua25vd247XG5cbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBjYXVzZT86IHVua25vd24pIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIlVzZXJOb3RpZmllZEVycm9yXCI7XG4gICAgdGhpcy5jYXVzZSA9IGNhdXNlO1xuICB9XG59XG5cbi8qKlxuICogQ29tcGFyZSB0d28gcGF0aHMgZm9yIHBoeXNpY2FsIGlkZW50aXR5LCB0b2xlcmF0aW5nIHRyYWlsaW5nIHNsYXNoZXMsXG4gKiBzeW1saW5rIGRpZmZlcmVuY2VzLCBhbmQgY2FzZSB2YXJpYXRpb25zIG9uIGNhc2UtaW5zZW5zaXRpdmUgdm9sdW1lcy5cbiAqXG4gKiBVc2VkIGluIHBsYWNlIG9mIHN0cmluZyBgPT09YCAvIGAhPT1gIHdoZXJldmVyIG9uZSBvcGVyYW5kIG1heSBiZVxuICogcmVhbHBhdGgtbm9ybWFsaXNlZCBhbmQgdGhlIG90aGVyIG1heSBub3QgYmUgKGUuZy4gcmF3IGNhbGxlci1zdXBwbGllZFxuICogYmFzZVBhdGggdnMuIHJlYWxwYXRoLW5vcm1hbGlzZWQgcHJvamVjdFJvb3QpLlxuICovXG5mdW5jdGlvbiBpc1NhbWVQYXRoUGh5c2ljYWwoYTogc3RyaW5nLCBiOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIG5vcm1hbGl6ZVdvcmt0cmVlUGF0aEZvckNvbXBhcmUoYSkgPT09IG5vcm1hbGl6ZVdvcmt0cmVlUGF0aEZvckNvbXBhcmUoYik7XG59XG5cbmV4cG9ydCB0eXBlIEVudGVyUmVzdWx0ID1cbiAgfCB7IG9rOiB0cnVlOyBtb2RlOiBcIndvcmt0cmVlXCIgfCBcImJyYW5jaFwiIHwgXCJub25lXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwge1xuICAgICAgb2s6IGZhbHNlO1xuICAgICAgcmVhc29uOlxuICAgICAgICB8IFwiaXNvbGF0aW9uLWRlZ3JhZGVkXCJcbiAgICAgICAgfCBcImxlYXNlLWNvbmZsaWN0XCJcbiAgICAgICAgfCBcImNyZWF0aW9uLWZhaWxlZFwiXG4gICAgICAgIHwgXCJpbnZhbGlkLW1pbGVzdG9uZS1pZFwiO1xuICAgICAgY2F1c2U/OiB1bmtub3duO1xuICAgIH07XG5cbmV4cG9ydCB0eXBlIEV4aXRSZXN1bHQgPVxuICB8IHsgb2s6IHRydWU7IG1lcmdlZDogYm9vbGVhbjsgY29kZUZpbGVzQ2hhbmdlZDogYm9vbGVhbiB9XG4gIHwgeyBvazogZmFsc2U7IHJlYXNvbjogXCJtZXJnZS1jb25mbGljdFwiIHwgXCJ0ZWFyZG93bi1mYWlsZWRcIjsgY2F1c2U/OiB1bmtub3duIH07XG5cbi8qKlxuICogU2Vzc2lvbi1sZXNzIG1lcmdlIGVudHJ5IGNvbnRleHQuIFBlciBBRFItMDE2IHBoYXNlIDIgLyBBMSAoIzU2MTYpLCB0aGVcbiAqIG1lcmdlIGJvZHkgaXMgc3RydWN0dXJhbGx5IHNlc3Npb24tbGVzcyBcdTIwMTQgaXQgcmVhZHMgcHJvamVjdCByb290LCB3b3JrdHJlZVxuICogcGF0aCwgYW5kIG1pbGVzdG9uZUlkLiBTaW5nbGUtbG9vcCBjYWxsZXJzIChgX21lcmdlQW5kRXhpdGApIGJ1aWxkIGFcbiAqIE1lcmdlQ29udGV4dCBmcm9tIGB0aGlzLnNgLiBQYXJhbGxlbCBjYWxsZXJzIChgcGFyYWxsZWwtbWVyZ2UudHNgKSBidWlsZFxuICogb25lIGRpcmVjdGx5IHdpdGhvdXQgYW4gYEF1dG9TZXNzaW9uYC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZXJnZUNvbnRleHQge1xuICAvKiogUHJvamVjdCByb290IFx1MjAxNCBtZXJnZSB0YXJnZXQgKHdoZXJlIGBnaXQgbWVyZ2UgLS1zcXVhc2hgIGxhbmRzKS4gKi9cbiAgb3JpZ2luYWxCYXNlUGF0aDogc3RyaW5nO1xuICAvKipcbiAgICogQ3VycmVudCB3b3JrdHJlZSBwYXRoIG9yIHByb2plY3Qgcm9vdCB3aGVuIGluIGJyYW5jaCBtb2RlLiBVc2VkIGFzIHRoZVxuICAgKiBjd2QgYW5jaG9yIGZvciBgbWVyZ2VNaWxlc3RvbmVUb01haW5gIGFuZCB0aGUgc291cmNlIGZvclxuICAgKiBgUHJvamVjdGlvbi5maW5hbGl6ZVByb2plY3Rpb25Gb3JNZXJnZWAuXG4gICAqL1xuICB3b3JrdHJlZUJhc2VQYXRoOiBzdHJpbmc7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGVuIHRydWUsIGBtZXJnZU1pbGVzdG9uZVN0YW5kYWxvbmVgIHJldHVybnMgYHsgbWVyZ2VkOiBmYWxzZSxcbiAgICogbW9kZTogXCJza2lwcGVkXCIgfWAgaW1tZWRpYXRlbHkgKG1pcnJvcnMgdGhlIHNpbmdsZS1sb29wIGd1YXJkKS4gRGVmYXVsdFxuICAgKiBgZmFsc2VgIGZvciBwYXJhbGxlbCBjYWxsZXJzLCB3aGljaCBuZXZlciBydW4gd2l0aCBkZWdyYWRlZCBpc29sYXRpb24uXG4gICAqL1xuICBpc29sYXRpb25EZWdyYWRlZD86IGJvb2xlYW47XG4gIG5vdGlmeTogTm90aWZ5Q3R4W1wibm90aWZ5XCJdO1xufVxuXG4vKipcbiAqIFJlc3VsdCBvZiBgbWVyZ2VNaWxlc3RvbmVTdGFuZGFsb25lYC4gYG1vZGVgIGxldHMgY2FsbGVycyBkZWNpZGUgd2hpY2hcbiAqIHNlc3Npb24tYm91bmQgc2lkZSBlZmZlY3RzIHRvIHJ1biAod29ya3RyZWUtbW9kZSBcdTIxOTIgYHJlc3RvcmVUb1Byb2plY3RSb290YCxcbiAqIGJyYW5jaC1tb2RlIFx1MjE5MiBgcmVidWlsZEdpdFNlcnZpY2VgLCBza2lwcGVkIFx1MjE5MiBub25lKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZXJnZVN0YW5kYWxvbmVSZXN1bHQge1xuICBtZXJnZWQ6IGJvb2xlYW47XG4gIG1vZGU6IFwid29ya3RyZWVcIiB8IFwiYnJhbmNoXCIgfCBcInNraXBwZWRcIjtcbiAgY29kZUZpbGVzQ2hhbmdlZDogYm9vbGVhbjtcbiAgcHVzaGVkOiBib29sZWFuO1xuICAvKipcbiAgICogQ29tbWl0IG1lc3NhZ2UgcHJvZHVjZWQgYnkgdGhlIHNxdWFzaCBtZXJnZSwgaWYgYXZhaWxhYmxlLiBGb3J3YXJkZWRcbiAgICogZnJvbSBgbWVyZ2VNaWxlc3RvbmVUb01haW5gLiBPbmx5IHBvcHVsYXRlZCB3aGVuIGBtZXJnZWQgPT09IHRydWVgLlxuICAgKi9cbiAgY29tbWl0TWVzc2FnZT86IHN0cmluZztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFZhbGlkYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGlzVmFsaWRNaWxlc3RvbmVJZChtaWxlc3RvbmVJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAhL1tcXC9cXFxcXXxcXC5cXC4vLnRlc3QobWlsZXN0b25lSWQpO1xufVxuXG5mdW5jdGlvbiBpbnZhbGlkTWlsZXN0b25lSWRFcnJvcihtaWxlc3RvbmVJZDogc3RyaW5nKTogRXJyb3Ige1xuICByZXR1cm4gbmV3IEVycm9yKFxuICAgIGBJbnZhbGlkIG1pbGVzdG9uZUlkOiAke21pbGVzdG9uZUlkfSBcdTIwMTQgY29udGFpbnMgcGF0aCBzZXBhcmF0b3JzIG9yIHRyYXZlcnNhbGAsXG4gICk7XG59XG5cbnR5cGUgV29ya3RyZWVMaWZlY3ljbGVQcmltaXRpdmVPdmVycmlkZXMgPSB7XG4gIHJlYWRGaWxlU3luYz86IChwYXRoOiBzdHJpbmcsIGVuY29kaW5nOiBCdWZmZXJFbmNvZGluZykgPT4gc3RyaW5nO1xuICBnZXRDdXJyZW50QnJhbmNoPzogKGJhc2VQYXRoOiBzdHJpbmcpID0+IHN0cmluZztcbiAgY2hlY2tvdXRCcmFuY2g/OiAoYmFzZVBhdGg6IHN0cmluZywgYnJhbmNoOiBzdHJpbmcpID0+IHZvaWQ7XG4gIGF1dG9Db21taXRDdXJyZW50QnJhbmNoPzogKFxuICAgIGJhc2VQYXRoOiBzdHJpbmcsXG4gICAgdW5pdFR5cGU6IHN0cmluZyxcbiAgICB1bml0SWQ6IHN0cmluZyxcbiAgICB0YXNrQ29udGV4dD86IHVua25vd24sXG4gICkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgZ2V0QXV0b1dvcmt0cmVlUGF0aD86IChcbiAgICBiYXNlUGF0aDogc3RyaW5nLFxuICAgIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gICkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLy8gQURSLTAxNiBwaGFzZSAyIC8gQzItaW5saW5lZCB3b3JrdHJlZS1tYW5hZ2VyIHByaW1pdGl2ZXMuIFRlc3RzIHN0aWxsXG4gIC8vIHN0dWIgdGhlc2UgdmlhIHRoZSBzdHJ1Y3R1cmFsLXR5cGluZyBlc2NhcGUgaGF0Y2ggb24gYFdvcmt0cmVlTGlmZWN5Y2xlRGVwc2AsXG4gIC8vIHNvIHRoZSBjYWxsIHNpdGVzIGJlbG93IGNoZWNrIGZvciBhbiBvdmVycmlkZSBmaXJzdCBhbmQgZmFsbCBiYWNrIHRvIHRoZVxuICAvLyBpbXBvcnRlZCBkaXJlY3QgcHJpbWl0aXZlLlxuICBpc0luQXV0b1dvcmt0cmVlPzogKGJhc2VQYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIGF1dG9Xb3JrdHJlZUJyYW5jaD86IChtaWxlc3RvbmVJZDogc3RyaW5nKSA9PiBzdHJpbmc7XG4gIHRlYXJkb3duQXV0b1dvcmt0cmVlPzogKFxuICAgIGJhc2VQYXRoOiBzdHJpbmcsXG4gICAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgICBvcHRzPzogeyBwcmVzZXJ2ZUJyYW5jaD86IGJvb2xlYW4gfSxcbiAgKSA9PiB2b2lkO1xuICBjcmVhdGVBdXRvV29ya3RyZWU/OiAoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZykgPT4gc3RyaW5nO1xuICBlbnRlckF1dG9Xb3JrdHJlZT86IChiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKSA9PiBzdHJpbmc7XG4gIGVudGVyQnJhbmNoTW9kZUZvck1pbGVzdG9uZT86IChiYXNlUGF0aDogc3RyaW5nLCBtaWxlc3RvbmVJZDogc3RyaW5nKSA9PiB2b2lkO1xuICAvLyBBRFItMDE2IHBoYXNlIDIgLyBDMy1pbmxpbmVkIGNhY2hlICsgcHJlZmVyZW5jZXMgKyBwYXRoIGhlbHBlcnMuXG4gIGdldElzb2xhdGlvbk1vZGU/OiAoYmFzZVBhdGg/OiBzdHJpbmcpID0+IFwid29ya3RyZWVcIiB8IFwiYnJhbmNoXCIgfCBcIm5vbmVcIjtcbiAgaW52YWxpZGF0ZUFsbENhY2hlcz86ICgpID0+IHZvaWQ7XG4gIHJlc29sdmVNaWxlc3RvbmVGaWxlPzogKFxuICAgIGJhc2VQYXRoOiBzdHJpbmcsXG4gICAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgICBmaWxlVHlwZTogc3RyaW5nLFxuICApID0+IHN0cmluZyB8IG51bGw7XG4gIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcz86IChiYXNlUGF0aD86IHN0cmluZykgPT5cbiAgICB8IHsgcHJlZmVyZW5jZXM/OiB7IGdpdD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0gfVxuICAgIHwgbnVsbFxuICAgIHwgdW5kZWZpbmVkO1xufTtcblxuZnVuY3Rpb24gcHJpbWl0aXZlT3ZlcnJpZGVzKFxuICBkZXBzOiBXb3JrdHJlZUxpZmVjeWNsZURlcHMsXG4pOiBXb3JrdHJlZUxpZmVjeWNsZVByaW1pdGl2ZU92ZXJyaWRlcyB7XG4gIHJldHVybiBkZXBzIGFzIFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyAmIFdvcmt0cmVlTGlmZWN5Y2xlUHJpbWl0aXZlT3ZlcnJpZGVzO1xufVxuXG5mdW5jdGlvbiByZWFkTGlmZWN5Y2xlRmlsZShcbiAgZGVwczogV29ya3RyZWVMaWZlY3ljbGVEZXBzLFxuICBwYXRoOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gcHJpbWl0aXZlT3ZlcnJpZGVzKGRlcHMpLnJlYWRGaWxlU3luYz8uKHBhdGgsIFwidXRmLThcIikgPz9cbiAgICByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKTtcbn1cblxuZnVuY3Rpb24gY3VycmVudExpZmVjeWNsZUJyYW5jaChcbiAgZGVwczogV29ya3RyZWVMaWZlY3ljbGVEZXBzLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIHByaW1pdGl2ZU92ZXJyaWRlcyhkZXBzKS5nZXRDdXJyZW50QnJhbmNoPy4oYmFzZVBhdGgpID8/XG4gICAgZ2V0Q3VycmVudEJyYW5jaChiYXNlUGF0aCk7XG59XG5cbmZ1bmN0aW9uIGNoZWNrb3V0TGlmZWN5Y2xlQnJhbmNoKFxuICBkZXBzOiBXb3JrdHJlZUxpZmVjeWNsZURlcHMsXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGJyYW5jaDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGNvbnN0IGNoZWNrb3V0QnJhbmNoID0gcHJpbWl0aXZlT3ZlcnJpZGVzKGRlcHMpLmNoZWNrb3V0QnJhbmNoO1xuICBpZiAoY2hlY2tvdXRCcmFuY2gpIHtcbiAgICBjaGVja291dEJyYW5jaChiYXNlUGF0aCwgYnJhbmNoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgbmF0aXZlQ2hlY2tvdXRCcmFuY2goYmFzZVBhdGgsIGJyYW5jaCk7XG59XG5cbmZ1bmN0aW9uIGF1dG9Db21taXRMaWZlY3ljbGVCcmFuY2goXG4gIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIHByaW1pdGl2ZU92ZXJyaWRlcyhkZXBzKS5hdXRvQ29tbWl0Q3VycmVudEJyYW5jaD8uKFxuICAgIGJhc2VQYXRoLFxuICAgIHVuaXRUeXBlLFxuICAgIHVuaXRJZCxcbiAgKSA/PyBhdXRvQ29tbWl0Q3VycmVudEJyYW5jaChiYXNlUGF0aCwgdW5pdFR5cGUsIHVuaXRJZCk7XG59XG5cbi8vIEFEUi0wMTYgcGhhc2UgMiAvIEMyLWlubGluZWQgd29ya3RyZWUtbWFuYWdlciBwcmltaXRpdmVzIFx1MjAxNCBoZWxwZXJzIHRoYXRcbi8vIGhvbm91ciB0aGUgc3RydWN0dXJhbC10eXBpbmcgb3ZlcnJpZGUgcGF0dGVybiBzbyBsZWdhY3kgdGVzdCBmaXh0dXJlcyBrZWVwXG4vLyB3b3JraW5nIHdpdGhvdXQgcmV3cml0aW5nIHRoZW0gb250byByZWFsLWdpdCBmaXh0dXJlcy5cbmZ1bmN0aW9uIGxpZmVjeWNsZUlzSW5BdXRvV29ya3RyZWUoXG4gIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gcHJpbWl0aXZlT3ZlcnJpZGVzKGRlcHMpLmlzSW5BdXRvV29ya3RyZWU/LihiYXNlUGF0aCkgPz9cbiAgICBpc0luQXV0b1dvcmt0cmVlKGJhc2VQYXRoKTtcbn1cblxuZnVuY3Rpb24gbGlmZWN5Y2xlQXV0b1dvcmt0cmVlQnJhbmNoKFxuICBkZXBzOiBXb3JrdHJlZUxpZmVjeWNsZURlcHMsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICByZXR1cm4gcHJpbWl0aXZlT3ZlcnJpZGVzKGRlcHMpLmF1dG9Xb3JrdHJlZUJyYW5jaD8uKG1pbGVzdG9uZUlkKSA/P1xuICAgIGF1dG9Xb3JrdHJlZUJyYW5jaChtaWxlc3RvbmVJZCk7XG59XG5cbmZ1bmN0aW9uIGxpZmVjeWNsZVRlYXJkb3duQXV0b1dvcmt0cmVlKFxuICBkZXBzOiBXb3JrdHJlZUxpZmVjeWNsZURlcHMsXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIG9wdHM/OiB7IHByZXNlcnZlQnJhbmNoPzogYm9vbGVhbiB9LFxuKTogdm9pZCB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJpbWl0aXZlT3ZlcnJpZGVzKGRlcHMpLnRlYXJkb3duQXV0b1dvcmt0cmVlO1xuICBpZiAob3ZlcnJpZGUpIHtcbiAgICBvdmVycmlkZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIG9wdHMpO1xuICAgIHJldHVybjtcbiAgfVxuICB0ZWFyZG93bkF1dG9Xb3JrdHJlZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIG9wdHMpO1xufVxuXG5mdW5jdGlvbiBsaWZlY3ljbGVDcmVhdGVBdXRvV29ya3RyZWUoXG4gIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBwcmltaXRpdmVPdmVycmlkZXMoZGVwcykuY3JlYXRlQXV0b1dvcmt0cmVlPy4oYmFzZVBhdGgsIG1pbGVzdG9uZUlkKSA/P1xuICAgIGNyZWF0ZUF1dG9Xb3JrdHJlZShiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xufVxuXG5mdW5jdGlvbiBsaWZlY3ljbGVFbnRlckF1dG9Xb3JrdHJlZShcbiAgZGVwczogV29ya3RyZWVMaWZlY3ljbGVEZXBzLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIHByaW1pdGl2ZU92ZXJyaWRlcyhkZXBzKS5lbnRlckF1dG9Xb3JrdHJlZT8uKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCkgPz9cbiAgICBlbnRlckF1dG9Xb3JrdHJlZShiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xufVxuXG5mdW5jdGlvbiBsaWZlY3ljbGVFbnRlckJyYW5jaE1vZGUoXG4gIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbik6IHZvaWQge1xuICBjb25zdCBvdmVycmlkZSA9IHByaW1pdGl2ZU92ZXJyaWRlcyhkZXBzKS5lbnRlckJyYW5jaE1vZGVGb3JNaWxlc3RvbmU7XG4gIGlmIChvdmVycmlkZSkge1xuICAgIG92ZXJyaWRlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGVudGVyQnJhbmNoTW9kZUZvck1pbGVzdG9uZShiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xufVxuXG4vLyBBRFItMDE2IHBoYXNlIDIgLyBDMy1pbmxpbmVkIGNhY2hlICsgcHJlZmVyZW5jZXMgKyBwYXRoIGhlbHBlcnMuXG5mdW5jdGlvbiBsaWZlY3ljbGVHZXRJc29sYXRpb25Nb2RlKFxuICBkZXBzOiBXb3JrdHJlZUxpZmVjeWNsZURlcHMsXG4gIGJhc2VQYXRoPzogc3RyaW5nLFxuKTogXCJ3b3JrdHJlZVwiIHwgXCJicmFuY2hcIiB8IFwibm9uZVwiIHtcbiAgcmV0dXJuIHByaW1pdGl2ZU92ZXJyaWRlcyhkZXBzKS5nZXRJc29sYXRpb25Nb2RlPy4oYmFzZVBhdGgpID8/XG4gICAgZ2V0SXNvbGF0aW9uTW9kZShiYXNlUGF0aCk7XG59XG5cbmZ1bmN0aW9uIGxpZmVjeWNsZUludmFsaWRhdGVBbGxDYWNoZXMoZGVwczogV29ya3RyZWVMaWZlY3ljbGVEZXBzKTogdm9pZCB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJpbWl0aXZlT3ZlcnJpZGVzKGRlcHMpLmludmFsaWRhdGVBbGxDYWNoZXM7XG4gIGlmIChvdmVycmlkZSkge1xuICAgIG92ZXJyaWRlKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbn1cblxuZnVuY3Rpb24gbGlmZWN5Y2xlUmVzb2x2ZU1pbGVzdG9uZUZpbGUoXG4gIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgZmlsZVR5cGU6IHN0cmluZyxcbik6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gcHJpbWl0aXZlT3ZlcnJpZGVzKGRlcHMpLnJlc29sdmVNaWxlc3RvbmVGaWxlPy4oXG4gICAgYmFzZVBhdGgsXG4gICAgbWlsZXN0b25lSWQsXG4gICAgZmlsZVR5cGUsXG4gICkgPz8gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBmaWxlVHlwZSk7XG59XG5cbmZ1bmN0aW9uIGxpZmVjeWNsZUxvYWRQcmVmZXJlbmNlcyhcbiAgZGVwczogV29ya3RyZWVMaWZlY3ljbGVEZXBzLFxuICBiYXNlUGF0aD86IHN0cmluZyxcbik6XG4gIHwgeyBwcmVmZXJlbmNlcz86IHsgZ2l0PzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfSB9XG4gIHwgbnVsbFxuICB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJpbWl0aXZlT3ZlcnJpZGVzKGRlcHMpLmxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcztcbiAgaWYgKG92ZXJyaWRlKSByZXR1cm4gb3ZlcnJpZGUoYmFzZVBhdGgpO1xuICByZXR1cm4gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKGJhc2VQYXRoKSBhc1xuICAgIHwgeyBwcmVmZXJlbmNlcz86IHsgZ2l0PzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfSB9XG4gICAgfCBudWxsXG4gICAgfCB1bmRlZmluZWQ7XG59XG5cbi8qKlxuICogVGhyb3dpbmcgdmFyaWFudCB1c2VkIGJ5IHRoZSBtZXJnZS9leGl0IHBhdGhzIHRoYXQgc3VyZmFjZSBmYWlsdXJlcyB2aWFcbiAqIHRoZSB0eXBlZCBgRXhpdFJlc3VsdGAgKGNhbGxlcnMgd3JhcCB0aGUgdGhyb3cgXHUyMTkyIGNhdXNlKS4gVGhlIGVudGVyIHBhdGhcbiAqIHVzZXMgYGlzVmFsaWRNaWxlc3RvbmVJZGAgKyB0aGUgdHlwZWQgcmVzdWx0IGRpcmVjdGx5LlxuICovXG5mdW5jdGlvbiB2YWxpZGF0ZU1pbGVzdG9uZUlkKG1pbGVzdG9uZUlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFpc1ZhbGlkTWlsZXN0b25lSWQobWlsZXN0b25lSWQpKSB7XG4gICAgdGhyb3cgaW52YWxpZE1pbGVzdG9uZUlkRXJyb3IobWlsZXN0b25lSWQpO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBJbXBsZW1lbnRhdGlvbiBjb3JlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFNoYXJlZCBpbXBsZW1lbnRhdGlvbiBvZiBtaWxlc3RvbmUgZW50cnkuIENhbGxlZCBieSBib3RoXG4gKiBgV29ya3RyZWVMaWZlY3ljbGUuZW50ZXJNaWxlc3RvbmVgIGFuZCB0aGUgbGVnYWN5XG4gKiBgV29ya3RyZWVSZXNvbHZlci5tZXJnZUFuZEVudGVyTmV4dGAgaW50ZXJuYWwgcmVjdXJzaW9uIHVudGlsIHRoZSBSZXNvbHZlclxuICogcmV0aXJlcyAoc2xpY2UgIzU1ODcpLlxuICpcbiAqIFNpZGUgZWZmZWN0cyAocHJlc2VydmVkIGZyb20gdGhlIG9yaWdpbmFsIGBXb3JrdHJlZVJlc29sdmVyLmVudGVyTWlsZXN0b25lYCk6XG4gKiAgIC0gbXV0YXRlcyBgcy5taWxlc3RvbmVMZWFzZVRva2VuYCBvbiBsZWFzZSBjbGFpbS9yZWxlYXNlL3JlZnJlc2hcbiAqICAgLSBtdXRhdGVzIGBzLmJhc2VQYXRoYCBvbiBzdWNjZXNzZnVsIHdvcmt0cmVlIGVudHJ5XG4gKiAgIC0gbXV0YXRlcyBgcy5naXRTZXJ2aWNlYCAocmVidWlsdCBhZ2FpbnN0IHRoZSBuZXcgYmFzZSBwYXRoKVxuICogICAtIG11dGF0ZXMgYHMuaXNvbGF0aW9uRGVncmFkZWRgIG9uIGhhcmQgZmFpbHVyZSBvZiBicmFuY2gvd29ya3RyZWUgc2V0dXBcbiAqICAgLSBlbWl0cyBqb3VybmFsIGV2ZW50czogd29ya3RyZWUtc2tpcCwgd29ya3RyZWUtZW50ZXIsIHdvcmt0cmVlLWNyZWF0ZS1mYWlsZWRcbiAqICAgLSBlbWl0cyB3b3JrdHJlZS1jcmVhdGVkIHRlbGVtZXRyeSBvbiBzdWNjZXNzZnVsIGVudHJ5XG4gKiAgIC0gbm90aWZpZXMgdGhlIGNhbGxlciB2aWEgYGN0eC5ub3RpZnlgIGZvciBldmVyeSB1c2VyLXZpc2libGUgb3V0Y29tZVxuICovXG5leHBvcnQgZnVuY3Rpb24gX2VudGVyTWlsZXN0b25lQ29yZShcbiAgczogQXV0b1Nlc3Npb24sXG4gIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgY3R4OiBOb3RpZnlDdHgsXG4pOiBFbnRlclJlc3VsdCB7XG4gIGlmICghaXNWYWxpZE1pbGVzdG9uZUlkKG1pbGVzdG9uZUlkKSkge1xuICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgYWN0aW9uOiBcImVudGVyTWlsZXN0b25lXCIsXG4gICAgICBtaWxlc3RvbmVJZCxcbiAgICAgIHJlamVjdGVkOiBcImludmFsaWQtbWlsZXN0b25lLWlkXCIsXG4gICAgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIHJlYXNvbjogXCJpbnZhbGlkLW1pbGVzdG9uZS1pZFwiLFxuICAgICAgY2F1c2U6IGludmFsaWRNaWxlc3RvbmVJZEVycm9yKG1pbGVzdG9uZUlkKSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKHMuaXNvbGF0aW9uRGVncmFkZWQpIHtcbiAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgIGFjdGlvbjogXCJlbnRlck1pbGVzdG9uZVwiLFxuICAgICAgbWlsZXN0b25lSWQsXG4gICAgICBza2lwcGVkOiB0cnVlLFxuICAgICAgcmVhc29uOiBcImlzb2xhdGlvbi1kZWdyYWRlZFwiLFxuICAgIH0pO1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBcImlzb2xhdGlvbi1kZWdyYWRlZFwiIH07XG4gIH1cblxuICAvLyBQaGFzZSBCOiBjbGFpbSBhIG1pbGVzdG9uZSBsZWFzZSBiZWZvcmUgYW55IHdvcmt0cmVlIG11dGF0aW9uLiBUd29cbiAgLy8gd29ya2VycyBjYW5ub3QgZW50ZXIgdGhlIHNhbWUgbWlsZXN0b25lIGNvbmN1cnJlbnRseS4gQmVzdC1lZmZvcnQ6XG4gIC8vIHdhcm4gaWYgbm8gd29ya2VyIHJlZ2lzdGVyZWQgKHNpbmdsZS13b3JrZXIgZmFsbGJhY2spIG9yIHNraXAgaWYgREJcbiAgLy8gdW5hdmFpbGFibGU7IHJldXNlIGV4aXN0aW5nIGxlYXNlIGlmIHdlIGFscmVhZHkgaG9sZCBpdCBvbiB0aGlzXG4gIC8vIG1pbGVzdG9uZSAocmUtZW50cnkgd2l0aGluIHRoZSBzYW1lIHNlc3Npb24pLlxuICBpZiAocy53b3JrZXJJZCkge1xuICAgIGlmIChcbiAgICAgIHMuY3VycmVudE1pbGVzdG9uZUlkID09PSBtaWxlc3RvbmVJZCAmJlxuICAgICAgcy5taWxlc3RvbmVMZWFzZVRva2VuICE9PSBudWxsXG4gICAgKSB7XG4gICAgICBjb25zdCByZWZyZXNoZWQgPSByZWZyZXNoTWlsZXN0b25lTGVhc2UoXG4gICAgICAgIHMud29ya2VySWQsXG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBzLm1pbGVzdG9uZUxlYXNlVG9rZW4sXG4gICAgICApO1xuICAgICAgaWYgKHJlZnJlc2hlZCkge1xuICAgICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgICBhY3Rpb246IFwiZW50ZXJNaWxlc3RvbmVcIixcbiAgICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgICBsZWFzZVJlZnJlc2hlZDogdHJ1ZSxcbiAgICAgICAgICBmZW5jaW5nVG9rZW46IHMubWlsZXN0b25lTGVhc2VUb2tlbixcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgICBhY3Rpb246IFwiZW50ZXJNaWxlc3RvbmVcIixcbiAgICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgICBzdGFsZUxlYXNlVG9rZW46IHMubWlsZXN0b25lTGVhc2VUb2tlbixcbiAgICAgICAgfSk7XG4gICAgICAgIHMubWlsZXN0b25lTGVhc2VUb2tlbiA9IG51bGw7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gSWYgd2UgaGVsZCBhIGRpZmZlcmVudCBtaWxlc3RvbmUsIHJlbGVhc2UgaXQgZmlyc3Qgc28gb3RoZXJcbiAgICAvLyB3b3JrZXJzIGRvbid0IGhhdmUgdG8gd2FpdCBmb3IgVFRMLlxuICAgIGlmIChcbiAgICAgIHMuY3VycmVudE1pbGVzdG9uZUlkICYmXG4gICAgICBzLmN1cnJlbnRNaWxlc3RvbmVJZCAhPT0gbWlsZXN0b25lSWQgJiZcbiAgICAgIHMubWlsZXN0b25lTGVhc2VUb2tlbiAhPT0gbnVsbFxuICAgICkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVsZWFzZU1pbGVzdG9uZUxlYXNlKFxuICAgICAgICAgIHMud29ya2VySWQsXG4gICAgICAgICAgcy5jdXJyZW50TWlsZXN0b25lSWQsXG4gICAgICAgICAgcy5taWxlc3RvbmVMZWFzZVRva2VuLFxuICAgICAgICApO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICAgIGFjdGlvbjogXCJlbnRlck1pbGVzdG9uZVwiLFxuICAgICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICAgIHJlbGVhc2VQcmlvckxlYXNlRXJyb3I6XG4gICAgICAgICAgICBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcy5taWxlc3RvbmVMZWFzZVRva2VuID0gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAocy5taWxlc3RvbmVMZWFzZVRva2VuID09PSBudWxsKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBjbGFpbSA9IGNsYWltTWlsZXN0b25lTGVhc2Uocy53b3JrZXJJZCwgbWlsZXN0b25lSWQpO1xuICAgICAgICBpZiAoY2xhaW0ub2spIHtcbiAgICAgICAgICBzLm1pbGVzdG9uZUxlYXNlVG9rZW4gPSBjbGFpbS50b2tlbjtcbiAgICAgICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgICAgIGFjdGlvbjogXCJlbnRlck1pbGVzdG9uZVwiLFxuICAgICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgICBsZWFzZUFjcXVpcmVkOiB0cnVlLFxuICAgICAgICAgICAgZmVuY2luZ1Rva2VuOiBjbGFpbS50b2tlbixcbiAgICAgICAgICAgIGV4cGlyZXNBdDogY2xhaW0uZXhwaXJlc0F0LFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIExlYXNlIGhlbGQgYnkgYW5vdGhlciB3b3JrZXIgXHUyMDE0IGZhaWwgbG91ZCBzbyB0aGUgdXNlciBjYW5cbiAgICAgICAgICAvLyBzZWUgdGhlIGNvbmZsaWN0IGluc3RlYWQgb2Ygc2lsZW50bHkgZG91YmxlLXJ1bm5pbmcuXG4gICAgICAgICAgY29uc3QgbXNnID0gYE1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBpcyBoZWxkIGJ5IHdvcmtlciAke2NsYWltLmJ5V29ya2VyfSB1bnRpbCAke2NsYWltLmV4cGlyZXNBdH0uYDtcbiAgICAgICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgICAgIGFjdGlvbjogXCJlbnRlck1pbGVzdG9uZVwiLFxuICAgICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgICBsZWFzZUhlbGRCeU90aGVyOiBjbGFpbS5ieVdvcmtlcixcbiAgICAgICAgICAgIGV4cGlyZXNBdDogY2xhaW0uZXhwaXJlc0F0LFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGN0eC5ub3RpZnkoXG4gICAgICAgICAgICBgJHttc2d9IEFub3RoZXIgYXV0by1tb2RlIHdvcmtlciBpcyBhY3RpdmUuIFN0b3AgaXQgYmVmb3JlIGVudGVyaW5nICR7bWlsZXN0b25lSWR9LmAsXG4gICAgICAgICAgICBcImVycm9yXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogXCJsZWFzZS1jb25mbGljdFwiIH07XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAvLyBEQiB1bmF2YWlsYWJsZSBvciBvdGhlciBlcnJvciBcdTIwMTQgbG9nIGFuZCBmYWxsIHRocm91Z2ggdG8gdGhlXG4gICAgICAgIC8vIHByZS1QaGFzZS1CIHNpbmdsZS13b3JrZXIgYmVoYXZpb3Igc28gYSBmcmVzaCBwcm9qZWN0IGJlZm9yZVxuICAgICAgICAvLyBEQiBpbml0IHN0aWxsIHdvcmtzLlxuICAgICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgICBhY3Rpb246IFwiZW50ZXJNaWxlc3RvbmVcIixcbiAgICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgICBsZWFzZUVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBsb2dXYXJuaW5nKFxuICAgICAgXCJ3b3JrdHJlZVwiLFxuICAgICAgYGVudGVyTWlsZXN0b25lKCR7bWlsZXN0b25lSWR9KSByYW4gYmVmb3JlIGF1dG8gd29ya2VyIHJlZ2lzdHJhdGlvbjsgbWlsZXN0b25lIGxlYXNlIHdhcyBub3QgY2xhaW1lZC5gLFxuICAgICk7XG4gIH1cblxuICAvLyBSZXNvbHZlIHRoZSBwcm9qZWN0IHJvb3QgZm9yIHdvcmt0cmVlIG9wZXJhdGlvbnMgdmlhIHNoYXJlZCBoZWxwZXIuXG4gIC8vIEhhbmRsZXMgdGhlIGNhc2Ugd2hlcmUgb3JpZ2luYWxCYXNlUGF0aCBpcyBmYWxzeSBhbmQgYmFzZVBhdGggaXMgaXRzZWxmXG4gIC8vIGEgd29ya3RyZWUgcGF0aCBcdTIwMTQgcHJldmVudHMgZG91YmxlLW5lc3RlZCB3b3JrdHJlZSBwYXRocyAoIzM3MjkpLlxuICBjb25zdCBiYXNlUGF0aCA9IHJlc29sdmVXb3JrdHJlZVByb2plY3RSb290KHMuYmFzZVBhdGgsIHMub3JpZ2luYWxCYXNlUGF0aCk7XG4gIGNvbnN0IG1vZGUgPSBnZXRJc29sYXRpb25Nb2RlKGJhc2VQYXRoKTtcblxuICBpZiAobW9kZSA9PT0gXCJub25lXCIpIHtcbiAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgIGFjdGlvbjogXCJlbnRlck1pbGVzdG9uZVwiLFxuICAgICAgbWlsZXN0b25lSWQsXG4gICAgICBza2lwcGVkOiB0cnVlLFxuICAgICAgcmVhc29uOiBcImlzb2xhdGlvbi1kaXNhYmxlZFwiLFxuICAgIH0pO1xuICAgIGVtaXRKb3VybmFsRXZlbnQocy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGgsIHtcbiAgICAgIHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBmbG93SWQ6IHJhbmRvbVVVSUQoKSxcbiAgICAgIHNlcTogMCxcbiAgICAgIGV2ZW50VHlwZTogXCJ3b3JrdHJlZS1za2lwXCIsXG4gICAgICBkYXRhOiB7IG1pbGVzdG9uZUlkLCByZWFzb246IFwiaXNvbGF0aW9uLWRpc2FibGVkXCIgfSxcbiAgICB9KTtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogXCJub25lXCIsIHBhdGg6IGJhc2VQYXRoIH07XG4gIH1cblxuICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICBhY3Rpb246IFwiZW50ZXJNaWxlc3RvbmVcIixcbiAgICBtaWxlc3RvbmVJZCxcbiAgICBtb2RlLFxuICAgIGJhc2VQYXRoLFxuICB9KTtcblxuICBpZiAoXG4gICAgbW9kZSA9PT0gXCJ3b3JrdHJlZVwiICYmXG4gICAgcy5jdXJyZW50TWlsZXN0b25lSWQgPT09IG1pbGVzdG9uZUlkICYmXG4gICAgcy5iYXNlUGF0aCAhPT0gYmFzZVBhdGhcbiAgKSB7XG4gICAgZGVidWdMb2coXCJXb3JrdHJlZUxpZmVjeWNsZVwiLCB7XG4gICAgICBhY3Rpb246IFwiZW50ZXJNaWxlc3RvbmVcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgbW9kZTogXCJ3b3JrdHJlZVwiLFxuICAgICAgcmVzdWx0OiBcImFscmVhZHktZW50ZXJlZFwiLFxuICAgICAgd3RQYXRoOiBzLmJhc2VQYXRoLFxuICAgIH0pO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBcIndvcmt0cmVlXCIsIHBhdGg6IHMuYmFzZVBhdGggfTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBCcmFuY2ggbW9kZTogY3JlYXRlL2NoZWNrb3V0IG1pbGVzdG9uZSBicmFuY2gsIHN0YXkgaW4gcHJvamVjdCByb290IFx1MjUwMFx1MjUwMFxuICBpZiAobW9kZSA9PT0gXCJicmFuY2hcIikge1xuICAgIHRyeSB7XG4gICAgICBsaWZlY3ljbGVFbnRlckJyYW5jaE1vZGUoZGVwcywgYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgICAgIC8vIGJhc2VQYXRoIGRvZXMgbm90IGNoYW5nZSBcdTIwMTQgbm8gd29ya3RyZWUsIG5vIGNoZGlyLlxuICAgICAgLy8gUmVidWlsZCBHaXRTZXJ2aWNlIHNvIHRoZSBuZXcgSEVBRCBpcyByZWZsZWN0ZWQsIHRoZW4gZmx1c2ggYW55XG4gICAgICAvLyBwYXRoLWtleWVkIGNhY2hlcyB0aGF0IG1heSBoYXZlIGJlZW4gcG9wdWxhdGVkIGJlZm9yZSB0aGUgY2hlY2tvdXQuXG4gICAgICByZWJ1aWxkR2l0U2VydmljZShzLCBkZXBzKTtcbiAgICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICBhY3Rpb246IFwiZW50ZXJNaWxlc3RvbmVcIixcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIG1vZGU6IFwiYnJhbmNoXCIsXG4gICAgICAgIHJlc3VsdDogXCJzdWNjZXNzXCIsXG4gICAgICB9KTtcbiAgICAgIGVtaXRKb3VybmFsRXZlbnQoYmFzZVBhdGgsIHtcbiAgICAgICAgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgZmxvd0lkOiByYW5kb21VVUlEKCksXG4gICAgICAgIHNlcTogMCxcbiAgICAgICAgZXZlbnRUeXBlOiBcIndvcmt0cmVlLXNraXBcIixcbiAgICAgICAgZGF0YTogeyBtaWxlc3RvbmVJZCwgcmVhc29uOiBcImJyYW5jaC1tb2RlLW5vLXdvcmt0cmVlXCIgfSxcbiAgICAgIH0pO1xuICAgICAgY3R4Lm5vdGlmeShgU3dpdGNoZWQgdG8gYnJhbmNoIG1pbGVzdG9uZS8ke21pbGVzdG9uZUlkfS5gLCBcImluZm9cIik7XG4gICAgICByZXR1cm4geyBvazogdHJ1ZSwgbW9kZTogXCJicmFuY2hcIiwgcGF0aDogYmFzZVBhdGggfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICBhY3Rpb246IFwiZW50ZXJNaWxlc3RvbmVcIixcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIG1vZGU6IFwiYnJhbmNoXCIsXG4gICAgICAgIHJlc3VsdDogXCJlcnJvclwiLFxuICAgICAgICBlcnJvcjogbXNnLFxuICAgICAgfSk7XG4gICAgICBjdHgubm90aWZ5KFxuICAgICAgICBgQnJhbmNoIGlzb2xhdGlvbiBzZXR1cCBmb3IgJHttaWxlc3RvbmVJZH0gZmFpbGVkOiAke21zZ30uIENvbnRpbnVpbmcgb24gY3VycmVudCBicmFuY2guYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgICAgcy5pc29sYXRpb25EZWdyYWRlZCA9IHRydWU7XG4gICAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogXCJjcmVhdGlvbi1mYWlsZWRcIiwgY2F1c2U6IGVyciB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBXb3JrdHJlZSBtb2RlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICB0cnkge1xuICAgIGNvbnN0IGV4aXN0aW5nUGF0aCA9XG4gICAgICAocHJpbWl0aXZlT3ZlcnJpZGVzKGRlcHMpLmdldEF1dG9Xb3JrdHJlZVBhdGggPz8gZ2V0QXV0b1dvcmt0cmVlUGF0aCkoXG4gICAgICAgIGJhc2VQYXRoLFxuICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICk7XG4gICAgbGV0IHd0UGF0aDogc3RyaW5nO1xuXG4gICAgaWYgKGV4aXN0aW5nUGF0aCkge1xuICAgICAgd3RQYXRoID0gbGlmZWN5Y2xlRW50ZXJBdXRvV29ya3RyZWUoZGVwcywgYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgICB9IGVsc2Uge1xuICAgICAgd3RQYXRoID0gbGlmZWN5Y2xlQ3JlYXRlQXV0b1dvcmt0cmVlKGRlcHMsIGJhc2VQYXRoLCBtaWxlc3RvbmVJZCk7XG4gICAgfVxuXG4gICAgcy5iYXNlUGF0aCA9IHd0UGF0aDtcbiAgICByZWJ1aWxkR2l0U2VydmljZShzLCBkZXBzKTtcbiAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG5cbiAgICAvLyBQZXIgQURSLTAxNjogTGlmZWN5Y2xlIGNhbGxzIFByb2plY3Rpb24gb24gZW50cnksIGJlZm9yZSBhbnkgVW5pdFxuICAgIC8vIGRpc3BhdGNoZXMuIEJ1aWxkIGEgdGVtcG9yYXJ5IHNjb3BlIGZyb20gdGhlIG5ldyBiYXNlUGF0aDsgY2FsbGVycyBtYXlcbiAgICAvLyBsYXRlciBzZXQgcy5zY29wZSB2aWEgdGhlaXIgb3duIHJlYnVpbGRTY29wZSBob29rICh0aGUgdHdvIGFyZVxuICAgIC8vIGluZGVwZW5kZW50IFx1MjAxNCB0aGlzIHNjb3BlIGlzIG9ubHkgdXNlZCB0byBkcml2ZSB0aGUgcHJvamVjdGlvbiBydWxlcykuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGVudGVyU2NvcGUgPSBzY29wZU1pbGVzdG9uZShjcmVhdGVXb3Jrc3BhY2Uod3RQYXRoKSwgbWlsZXN0b25lSWQpO1xuICAgICAgZGVwcy53b3JrdHJlZVByb2plY3Rpb24ucHJvamVjdFJvb3RUb1dvcmt0cmVlKGVudGVyU2NvcGUpO1xuICAgIH0gY2F0Y2ggKHByb2pFcnIpIHtcbiAgICAgIC8vIE5vbi1mYXRhbDogcHJvamVjdGlvbiBmYWlsdXJlcyBtdXN0IG5vdCBibG9jayB3b3JrdHJlZSBlbnRyeS5cbiAgICAgIC8vIFRoZSBwcmUtZGlzcGF0Y2ggcGF0aCBpbiBhdXRvL3BoYXNlcy50cyBwZXJmb3JtcyB0aGUgc2FtZSBwcm9qZWN0aW9uXG4gICAgICAvLyBvbiBldmVyeSBpdGVyYXRpb24sIHNvIGEgdHJhbnNpZW50IGZhaWx1cmUgaGVyZSBzZWxmLWhlYWxzIG9uIHRoZVxuICAgICAgLy8gbmV4dCBsb29wIHBhc3MuXG4gICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImVudGVyTWlsZXN0b25lXCIsXG4gICAgICAgIHBoYXNlOiBcInByb2plY3Rpb24tb24tZW50ZXJcIixcbiAgICAgICAgZXJyb3I6IHByb2pFcnIgaW5zdGFuY2VvZiBFcnJvciA/IHByb2pFcnIubWVzc2FnZSA6IFN0cmluZyhwcm9qRXJyKSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgYWN0aW9uOiBcImVudGVyTWlsZXN0b25lXCIsXG4gICAgICBtaWxlc3RvbmVJZCxcbiAgICAgIHJlc3VsdDogXCJzdWNjZXNzXCIsXG4gICAgICB3dFBhdGgsXG4gICAgfSk7XG4gICAgZW1pdEpvdXJuYWxFdmVudChzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCwge1xuICAgICAgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIGZsb3dJZDogcmFuZG9tVVVJRCgpLFxuICAgICAgc2VxOiAwLFxuICAgICAgZXZlbnRUeXBlOiBcIndvcmt0cmVlLWVudGVyXCIsXG4gICAgICBkYXRhOiB7IG1pbGVzdG9uZUlkLCB3dFBhdGgsIGNyZWF0ZWQ6ICFleGlzdGluZ1BhdGggfSxcbiAgICB9KTtcbiAgICAvLyAjNDc2NCBcdTIwMTQgcmVjb3JkIGNyZWF0aW9uL2VudGVyIGFzIGEgbGlmZWN5Y2xlIGV2ZW50IHNvIHRoZSB0ZWxlbWV0cnlcbiAgICAvLyBhZ2dyZWdhdG9yIGNhbiBwYWlyIGl0IHdpdGggdGhlIGV2ZW50dWFsIHdvcmt0cmVlLW1lcmdlZCBldmVudC5cbiAgICB0cnkge1xuICAgICAgZW1pdFdvcmt0cmVlQ3JlYXRlZChzLm9yaWdpbmFsQmFzZVBhdGggfHwgcy5iYXNlUGF0aCwgbWlsZXN0b25lSWQsIHtcbiAgICAgICAgcmVhc29uOiBleGlzdGluZ1BhdGggPyBcImVudGVyLW1pbGVzdG9uZVwiIDogXCJjcmVhdGUtbWlsZXN0b25lXCIsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoICh0ZWxlbWV0cnlFcnIpIHtcbiAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICBhY3Rpb246IFwiZW50ZXJNaWxlc3RvbmVcIixcbiAgICAgICAgcGhhc2U6IFwidGVsZW1ldHJ5LWVtaXRcIixcbiAgICAgICAgZXJyb3I6XG4gICAgICAgICAgdGVsZW1ldHJ5RXJyIGluc3RhbmNlb2YgRXJyb3JcbiAgICAgICAgICAgID8gdGVsZW1ldHJ5RXJyLm1lc3NhZ2VcbiAgICAgICAgICAgIDogU3RyaW5nKHRlbGVtZXRyeUVyciksXG4gICAgICB9KTtcbiAgICB9XG4gICAgY3R4Lm5vdGlmeShgRW50ZXJlZCB3b3JrdHJlZSBmb3IgJHttaWxlc3RvbmVJZH0gYXQgJHt3dFBhdGh9YCwgXCJpbmZvXCIpO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCBtb2RlOiBcIndvcmt0cmVlXCIsIHBhdGg6IHd0UGF0aCB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgZGVidWdMb2coXCJXb3JrdHJlZUxpZmVjeWNsZVwiLCB7XG4gICAgICBhY3Rpb246IFwiZW50ZXJNaWxlc3RvbmVcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgcmVzdWx0OiBcImVycm9yXCIsXG4gICAgICBlcnJvcjogbXNnLFxuICAgIH0pO1xuICAgIGVtaXRKb3VybmFsRXZlbnQocy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGgsIHtcbiAgICAgIHRzOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBmbG93SWQ6IHJhbmRvbVVVSUQoKSxcbiAgICAgIHNlcTogMCxcbiAgICAgIGV2ZW50VHlwZTogXCJ3b3JrdHJlZS1jcmVhdGUtZmFpbGVkXCIsXG4gICAgICBkYXRhOiB7IG1pbGVzdG9uZUlkLCBlcnJvcjogbXNnLCBmYWxsYmFjazogXCJwcm9qZWN0LXJvb3RcIiB9LFxuICAgIH0pO1xuICAgIGN0eC5ub3RpZnkoXG4gICAgICBgQXV0by13b3JrdHJlZSBjcmVhdGlvbiBmb3IgJHttaWxlc3RvbmVJZH0gZmFpbGVkOiAke21zZ30uIENvbnRpbnVpbmcgaW4gcHJvamVjdCByb290LmAsXG4gICAgICBcIndhcm5pbmdcIixcbiAgICApO1xuICAgIC8vIERlZ3JhZGUgaXNvbGF0aW9uIGZvciB0aGUgcmVzdCBvZiB0aGlzIHNlc3Npb24gc28gbWVyZ2VBbmRFeGl0XG4gICAgLy8gZG9lc24ndCB0cnkgdG8gbWVyZ2UgYSBub25leGlzdGVudCB3b3JrdHJlZSBicmFuY2ggKCMyNDgzKVxuICAgIHMuaXNvbGF0aW9uRGVncmFkZWQgPSB0cnVlO1xuICAgIC8vIERvIE5PVCB1cGRhdGUgcy5iYXNlUGF0aCBcdTIwMTQgc3RheSBpbiBwcm9qZWN0IHJvb3RcbiAgICByZXR1cm4geyBvazogZmFsc2UsIHJlYXNvbjogXCJjcmVhdGlvbi1mYWlsZWRcIiwgY2F1c2U6IGVyciB9O1xuICB9XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgYmFzZVBhdGggdG8gYWRvcHQgb24gcmVzdW1lIGZyb20gYSBwYXVzZWQgc2Vzc2lvbi5cbiAqXG4gKiBSZXR1cm5zIGBwZXJzaXN0ZWRXb3JrdHJlZVBhdGhgIHdoZW4gdGhlIHBhdGggaXMgbm9uLW51bGwgYW5kIGV4aXN0cyBvblxuICogZGlzazsgb3RoZXJ3aXNlIGZhbGxzIGJhY2sgdG8gYGJhc2VgLiBVc2VkIGJ5XG4gKiBgV29ya3RyZWVMaWZlY3ljbGUucmVzdW1lRnJvbVBhdXNlZFNlc3Npb25gICgjNTYyMSkuIEV4cG9ydGVkIGFzIGEgcHVyZVxuICogZnVuY3Rpb24gc28gdW5pdCB0ZXN0cyBjYW4gZXhlcmNpc2UgdGhlIHBhdGgtcmVzb2x1dGlvbiBsb2dpYyB3aXRob3V0XG4gKiBjb25zdHJ1Y3RpbmcgYSBgV29ya3RyZWVMaWZlY3ljbGVgIGluc3RhbmNlLlxuICpcbiAqIFRoZSBvcHRpb25hbCBgcGF0aEV4aXN0c2AgcGFyYW1ldGVyIGV4aXN0cyBvbmx5IGZvciB0ZXN0cyB0aGF0IG5lZWQgdG9cbiAqIHN1YnN0aXR1dGUgYSBzdHViIGZvciBgZXhpc3RzU3luY2AuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlUGF1c2VkUmVzdW1lQmFzZVBhdGgoXG4gIGJhc2U6IHN0cmluZyxcbiAgcGVyc2lzdGVkV29ya3RyZWVQYXRoOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuICBwYXRoRXhpc3RzOiAocDogc3RyaW5nKSA9PiBib29sZWFuID0gZXhpc3RzU3luYyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBwZXJzaXN0ZWRXb3JrdHJlZVBhdGggJiYgcGF0aEV4aXN0cyhwZXJzaXN0ZWRXb3JrdHJlZVBhdGgpXG4gICAgPyBwZXJzaXN0ZWRXb3JrdHJlZVBhdGhcbiAgICA6IGJhc2U7XG59XG5cbmZ1bmN0aW9uIHJlYnVpbGRHaXRTZXJ2aWNlKFxuICBzOiBBdXRvU2Vzc2lvbixcbiAgZGVwczogV29ya3RyZWVMaWZlY3ljbGVEZXBzLFxuKTogdm9pZCB7XG4gIC8vIEFEUi0wMTYgcGhhc2UgMiAvIEM0ICgjNTYyNyk6IHRoZSBnaXRDb25maWcgbG9hZCBhbmQgY29uc3RydWN0b3JcbiAgLy8gY29uc3RydWN0aW9uIGxpdmUgYmVoaW5kIGBnaXRTZXJ2aWNlRmFjdG9yeWAuIExpZmVjeWNsZSBubyBsb25nZXJcbiAgLy8gc2VlcyB0aGUgY29uc3RydWN0b3Igc2hhcGUsIHRoZSBnaXRDb25maWcgdHlwZSwgb3IgdGhlIHVua25vd25cdTIxOTJcbiAgLy8gR2l0U2VydmljZSBjYXN0LlxuICBzLmdpdFNlcnZpY2UgPSBkZXBzLmdpdFNlcnZpY2VGYWN0b3J5KHMuYmFzZVBhdGgpO1xufVxuXG5mdW5jdGlvbiBlbWl0V29ya3RyZWVNZXJnZUZhaWxlZE9uY2UoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIGVycjogdW5rbm93bixcbik6IHZvaWQge1xuICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gIGNvbnN0IGVycm9yQ2F0ZWdvcnkgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5uYW1lIDogXCJFcnJvclwiO1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCBrZXkgPSBgJHtiYXNlUGF0aH1cXDAke21pbGVzdG9uZUlkfVxcMCR7ZXJyb3JDYXRlZ29yeX1gO1xuICBjb25zdCBwcmV2aW91cyA9IHJlY2VudFdvcmt0cmVlTWVyZ2VGYWlsdXJlcy5nZXQoa2V5KTtcbiAgaWYgKHByZXZpb3VzICYmIG5vdyAtIHByZXZpb3VzIDwgTUVSR0VfRkFJTFVSRV9ERURVUEVfTVMpIHJldHVybjtcbiAgZm9yIChjb25zdCBbY2FuZGlkYXRlLCB0c10gb2YgcmVjZW50V29ya3RyZWVNZXJnZUZhaWx1cmVzKSB7XG4gICAgaWYgKG5vdyAtIHRzID49IE1FUkdFX0ZBSUxVUkVfREVEVVBFX01TKSB7XG4gICAgICByZWNlbnRXb3JrdHJlZU1lcmdlRmFpbHVyZXMuZGVsZXRlKGNhbmRpZGF0ZSk7XG4gICAgfVxuICB9XG4gIGVtaXRKb3VybmFsRXZlbnQoYmFzZVBhdGgsIHtcbiAgICB0czogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIGZsb3dJZDogcmFuZG9tVVVJRCgpLFxuICAgIHNlcTogMCxcbiAgICBldmVudFR5cGU6IFwid29ya3RyZWUtbWVyZ2UtZmFpbGVkXCIsXG4gICAgZGF0YTogeyBtaWxlc3RvbmVJZCwgZXJyb3I6IG1zZyB9LFxuICB9KTtcbiAgcmVjZW50V29ya3RyZWVNZXJnZUZhaWx1cmVzLnNldChrZXksIG5vdyk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTZXNzaW9uLWxlc3MgbWVyZ2UgZW50cnkgKEFEUi0wMTYgcGhhc2UgMiAvIEExKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBXb3JrdHJlZS1tb2RlIG1lcmdlIGJvZHkuIFNlc3Npb24tbGVzcyBcdTIwMTQgb3BlcmF0ZXMgb24gYSBgTWVyZ2VDb250ZXh0YC5cbiAqXG4gKiBPbiBlcnJvcjogZW1pdHMgdGhlIFwid29ya3RyZWUtbWVyZ2UtZmFpbGVkXCIgam91cm5hbCBldmVudCwgbm90aWZpZXMgdGhlXG4gKiB1c2VyLCBjbGVhbnMgdXAgc3RhbGUgYFNRVUFTSF9NU0dgIC8gYE1FUkdFX0hFQURgIC8gYE1FUkdFX01TR2AgZmlsZXNcbiAqICgjMTM4OSksIGFuZCBjaGRpcnMgYmFjayB0byBwcm9qZWN0IHJvb3QgYmVmb3JlIHJldGhyb3dpbmcuIFNlc3Npb24tc2lkZVxuICogY2xlYW51cCAoYHJlc3RvcmVUb1Byb2plY3RSb290YCwgYGdpdFNlcnZpY2VgIHJlYnVpbGQpIGlzIHRoZSBjYWxsZXInc1xuICogcmVzcG9uc2liaWxpdHkuXG4gKi9cbmZ1bmN0aW9uIF9tZXJnZVdvcmt0cmVlTW9kZUltcGwoXG4gIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyxcbiAgbWN0eDogTWVyZ2VDb250ZXh0LFxuKTogTWVyZ2VTdGFuZGFsb25lUmVzdWx0IHtcbiAgY29uc3QgeyBvcmlnaW5hbEJhc2VQYXRoLCB3b3JrdHJlZUJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgbm90aWZ5IH0gPSBtY3R4O1xuICBpZiAoIW9yaWdpbmFsQmFzZVBhdGgpIHtcbiAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgIGFjdGlvbjogXCJtZXJnZUFuZEV4aXRcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgbW9kZTogXCJ3b3JrdHJlZVwiLFxuICAgICAgc2tpcHBlZDogdHJ1ZSxcbiAgICAgIHJlYXNvbjogXCJtaXNzaW5nLW9yaWdpbmFsLWJhc2VcIixcbiAgICB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgbWVyZ2VkOiBmYWxzZSxcbiAgICAgIG1vZGU6IFwid29ya3RyZWVcIixcbiAgICAgIGNvZGVGaWxlc0NoYW5nZWQ6IGZhbHNlLFxuICAgICAgcHVzaGVkOiBmYWxzZSxcbiAgICB9O1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBBRFItMDE2OiBmaW5hbCBwcm9qZWN0aW9uIGJlZm9yZSB0ZWFyZG93bi4gUmVwbGFjZXMgdGhlIGxlZ2FjeVxuICAgIC8vIHN5bmNXb3JrdHJlZVN0YXRlQmFjayhvcmlnaW5hbEJhc2UsIGJhc2VQYXRoLCBtaWxlc3RvbmVJZCkgY2FsbC5cbiAgICBjb25zdCBmaW5hbFNjb3BlID0gc2NvcGVNaWxlc3RvbmUoXG4gICAgICBjcmVhdGVXb3Jrc3BhY2Uod29ya3RyZWVCYXNlUGF0aCksXG4gICAgICBtaWxlc3RvbmVJZCxcbiAgICApO1xuICAgIGNvbnN0IHsgc3luY2VkIH0gPSBkZXBzLndvcmt0cmVlUHJvamVjdGlvbi5maW5hbGl6ZVByb2plY3Rpb25Gb3JNZXJnZShcbiAgICAgIGZpbmFsU2NvcGUsXG4gICAgKTtcbiAgICBpZiAoc3luY2VkLmxlbmd0aCA+IDApIHtcbiAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICBhY3Rpb246IFwibWVyZ2VBbmRFeGl0XCIsXG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBwaGFzZTogXCJyZXZlcnNlLXN5bmNcIixcbiAgICAgICAgc3luY2VkOiBzeW5jZWQubGVuZ3RoLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gUmVzb2x2ZSByb2FkbWFwIFx1MjAxNCB0cnkgcHJvamVjdCByb290IGZpcnN0LCB0aGVuIHdvcmt0cmVlIHBhdGggYXNcbiAgICAvLyBmYWxsYmFjay4gVGhlIHdvcmt0cmVlIG1heSBob2xkIHRoZSBvbmx5IGNvcHkgd2hlbiBzdGF0ZS1iYWNrXG4gICAgLy8gcHJvamVjdGlvbiBzaWxlbnRseSBkcm9wcGVkIGl0IG9yIC5nc2QvIGlzIG5vdCBzeW1saW5rZWQuIFdpdGhvdXRcbiAgICAvLyB0aGUgZmFsbGJhY2ssIGEgbWlzc2luZyByb2FkbWFwIHRyaWdnZXJzIGJhcmUgdGVhcmRvd24gd2hpY2hcbiAgICAvLyBkZWxldGVzIHRoZSBicmFuY2ggYW5kIG9ycGhhbnMgYWxsIG1pbGVzdG9uZSBjb21taXRzICgjMTU3MykuXG4gICAgbGV0IHJvYWRtYXBQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoXG4gICAgICBvcmlnaW5hbEJhc2VQYXRoLFxuICAgICAgbWlsZXN0b25lSWQsXG4gICAgICBcIlJPQURNQVBcIixcbiAgICApO1xuICAgIGlmIChcbiAgICAgICFyb2FkbWFwUGF0aCAmJlxuICAgICAgIWlzU2FtZVBhdGhQaHlzaWNhbCh3b3JrdHJlZUJhc2VQYXRoLCBvcmlnaW5hbEJhc2VQYXRoKVxuICAgICkge1xuICAgICAgcm9hZG1hcFBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShcbiAgICAgICAgd29ya3RyZWVCYXNlUGF0aCxcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIFwiUk9BRE1BUFwiLFxuICAgICAgKTtcbiAgICAgIGlmIChyb2FkbWFwUGF0aCkge1xuICAgICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgICBhY3Rpb246IFwibWVyZ2VBbmRFeGl0XCIsXG4gICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgcGhhc2U6IFwicm9hZG1hcC1mYWxsYmFja1wiLFxuICAgICAgICAgIG5vdGU6IFwicmVzb2x2ZWQgZnJvbSB3b3JrdHJlZSBwYXRoXCIsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghcm9hZG1hcFBhdGgpIHtcbiAgICAgIC8vIE5vIHJvYWRtYXAgYXQgZWl0aGVyIGxvY2F0aW9uIFx1MjAxNCB0ZWFyZG93biBidXQgUFJFU0VSVkUgdGhlIGJyYW5jaFxuICAgICAgLy8gc28gY29tbWl0cyBhcmUgbm90IG9ycGhhbmVkICgjMTU3MykuXG4gICAgICBsaWZlY3ljbGVUZWFyZG93bkF1dG9Xb3JrdHJlZShkZXBzLCBvcmlnaW5hbEJhc2VQYXRoLCBtaWxlc3RvbmVJZCwge1xuICAgICAgICBwcmVzZXJ2ZUJyYW5jaDogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgbm90aWZ5KFxuICAgICAgICBgRXhpdGVkIHdvcmt0cmVlIGZvciAke21pbGVzdG9uZUlkfSAobm8gcm9hZG1hcCBmb3VuZCBcdTIwMTQgYnJhbmNoIHByZXNlcnZlZCBmb3IgbWFudWFsIG1lcmdlKS5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBtZXJnZWQ6IGZhbHNlLFxuICAgICAgICBtb2RlOiBcIndvcmt0cmVlXCIsXG4gICAgICAgIGNvZGVGaWxlc0NoYW5nZWQ6IGZhbHNlLFxuICAgICAgICBwdXNoZWQ6IGZhbHNlLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCByb2FkbWFwQ29udGVudCA9IHJlYWRMaWZlY3ljbGVGaWxlKGRlcHMsIHJvYWRtYXBQYXRoKTtcbiAgICBjb25zdCBtZXJnZVJlc3VsdCA9IGRlcHMubWVyZ2VNaWxlc3RvbmVUb01haW4oXG4gICAgICBvcmlnaW5hbEJhc2VQYXRoLFxuICAgICAgbWlsZXN0b25lSWQsXG4gICAgICByb2FkbWFwQ29udGVudCxcbiAgICApO1xuXG4gICAgLy8gIzI5NDUgQnVnIDM6IG1lcmdlTWlsZXN0b25lVG9NYWluIHBlcmZvcm1zIGJlc3QtZWZmb3J0IHdvcmt0cmVlXG4gICAgLy8gY2xlYW51cCBpbnRlcm5hbGx5IChzdGVwIDEyKSwgYnV0IGl0IGNhbiBzaWxlbnRseSBmYWlsIG9uIFdpbmRvd3NcbiAgICAvLyBvciB3aGVuIHRoZSB3b3JrdHJlZSBkaXJlY3RvcnkgaXMgbG9ja2VkLiBQZXJmb3JtIGEgc2Vjb25kYXJ5XG4gICAgLy8gdGVhcmRvd24gaGVyZSB0byBlbnN1cmUgdGhlIHdvcmt0cmVlIGlzIHByb3Blcmx5IGNsZWFuZWQgdXAuXG4gICAgLy8gSWRlbXBvdGVudCBcdTIwMTQgaWYgYWxyZWFkeSByZW1vdmVkLCB0ZWFyZG93bkF1dG9Xb3JrdHJlZSBuby1vcHMuXG4gICAgdHJ5IHtcbiAgICAgIGxpZmVjeWNsZVRlYXJkb3duQXV0b1dvcmt0cmVlKGRlcHMsIG9yaWdpbmFsQmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEJlc3QtZWZmb3J0IFx1MjAxNCBwcmltYXJ5IGNsZWFudXAgaW4gbWVyZ2VNaWxlc3RvbmVUb01haW4gbWF5IGhhdmVcbiAgICAgIC8vIGFscmVhZHkgcmVtb3ZlZCB0aGUgd29ya3RyZWUuXG4gICAgfVxuXG4gICAgaWYgKG1lcmdlUmVzdWx0LmNvZGVGaWxlc0NoYW5nZWQpIHtcbiAgICAgIG5vdGlmeShcbiAgICAgICAgYE1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBtZXJnZWQgdG8gbWFpbi4ke21lcmdlUmVzdWx0LnB1c2hlZCA/IFwiIFB1c2hlZCB0byByZW1vdGUuXCIgOiBcIlwifWAsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gIzE5MDYgXHUyMDE0IG1pbGVzdG9uZSBwcm9kdWNlZCBvbmx5IC5nc2QvIG1ldGFkYXRhLiBTdXJmYWNlXG4gICAgICAvLyBjbGVhcmx5IHNvIHRoZSB1c2VyIGtub3dzIHRoZSBtaWxlc3RvbmUgaXMgbm90IHRydWx5IGNvbXBsZXRlLlxuICAgICAgbm90aWZ5KFxuICAgICAgICBgV0FSTklORzogTWlsZXN0b25lICR7bWlsZXN0b25lSWR9IG1lcmdlZCB0byBtYWluIGJ1dCBjb250YWluZWQgTk8gY29kZSBjaGFuZ2VzIFx1MjAxNCBvbmx5IC5nc2QvIG1ldGFkYXRhIGZpbGVzLiBgICtcbiAgICAgICAgICBgVGhlIG1pbGVzdG9uZSBzdW1tYXJ5IG1heSBkZXNjcmliZSBwbGFubmVkIHdvcmsgdGhhdCB3YXMgbmV2ZXIgaW1wbGVtZW50ZWQuIGAgK1xuICAgICAgICAgIGBSZXZpZXcgdGhlIG1pbGVzdG9uZSBvdXRwdXQgYW5kIHJlLXJ1biBpZiBjb2RlIGlzIG1pc3NpbmcuYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBtZXJnZWQ6IHRydWUsXG4gICAgICBtb2RlOiBcIndvcmt0cmVlXCIsXG4gICAgICBjb2RlRmlsZXNDaGFuZ2VkOiBtZXJnZVJlc3VsdC5jb2RlRmlsZXNDaGFuZ2VkLFxuICAgICAgcHVzaGVkOiBtZXJnZVJlc3VsdC5wdXNoZWQsXG4gICAgICBjb21taXRNZXNzYWdlOiBtZXJnZVJlc3VsdC5jb21taXRNZXNzYWdlLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgIGFjdGlvbjogXCJtZXJnZUFuZEV4aXRcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgcmVzdWx0OiBcImVycm9yXCIsXG4gICAgICBlcnJvcjogbXNnLFxuICAgICAgZmFsbGJhY2s6IFwiY2hkaXItdG8tcHJvamVjdC1yb290XCIsXG4gICAgfSk7XG4gICAgZW1pdFdvcmt0cmVlTWVyZ2VGYWlsZWRPbmNlKG9yaWdpbmFsQmFzZVBhdGggfHwgd29ya3RyZWVCYXNlUGF0aCwgbWlsZXN0b25lSWQsIGVycik7XG4gICAgLy8gU3VyZmFjZSBhIGNsZWFyLCBhY3Rpb25hYmxlIGVycm9yLiBXb3JrdHJlZSBhbmQgbWlsZXN0b25lIGJyYW5jaFxuICAgIC8vIGFyZSBpbnRlbnRpb25hbGx5IHByZXNlcnZlZCBcdTIwMTQgbm90aGluZyBoYXMgYmVlbiBkZWxldGVkLiBVc2VyIGNhblxuICAgIC8vIHJldHJ5IC9nc2QgZGlzcGF0Y2ggY29tcGxldGUtbWlsZXN0b25lIG9yIG1lcmdlIG1hbnVhbGx5IG9uY2UgdGhlXG4gICAgLy8gdW5kZXJseWluZyBpc3N1ZSBpcyBmaXhlZCAoIzE2NjgsICMxODkxKS5cbiAgICBub3RpZnkoXG4gICAgICBgTWlsZXN0b25lIG1lcmdlIGZhaWxlZDogJHttc2d9LiBZb3VyIHdvcmt0cmVlIGFuZCBtaWxlc3RvbmUgYnJhbmNoIGFyZSBwcmVzZXJ2ZWQgXHUyMDE0IHJldHJ5IHdpdGggXFxgL2dzZCBkaXNwYXRjaCBjb21wbGV0ZS1taWxlc3RvbmVcXGAgb3IgbWVyZ2UgbWFudWFsbHkuYCxcbiAgICAgIFwid2FybmluZ1wiLFxuICAgICk7XG5cbiAgICAvLyBDbGVhbiB1cCBzdGFsZSBtZXJnZSBzdGF0ZSBsZWZ0IGJ5IGZhaWxlZCBzcXVhc2gtbWVyZ2UgKCMxMzg5KVxuICAgIHRyeSB7XG4gICAgICBjb25zdCBnaXREaXIgPSBqb2luKG9yaWdpbmFsQmFzZVBhdGggfHwgd29ya3RyZWVCYXNlUGF0aCwgXCIuZ2l0XCIpO1xuICAgICAgZm9yIChjb25zdCBmIG9mIFtcIlNRVUFTSF9NU0dcIiwgXCJNRVJHRV9IRUFEXCIsIFwiTUVSR0VfTVNHXCJdKSB7XG4gICAgICAgIGNvbnN0IHAgPSBqb2luKGdpdERpciwgZik7XG4gICAgICAgIGlmIChleGlzdHNTeW5jKHApKSB1bmxpbmtTeW5jKHApO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgICB9XG5cbiAgICAvLyBFcnJvciByZWNvdmVyeTogY2hkaXIgYmFjayB0byBwcm9qZWN0IHJvb3Qgb25seSB3aGVuIG5vIHJlYWwgd29ya3RyZWVcbiAgICAvLyBwYXRoIGlzIGF2YWlsYWJsZS4gU2Vzc2lvbi1zaWRlIGNsZWFudXAgKHJlc3RvcmVUb1Byb2plY3RSb290LFxuICAgIC8vIGdpdFNlcnZpY2UgcmVidWlsZCkgaXMgdGhlIGNhbGxlcidzIHJlc3BvbnNpYmlsaXR5LlxuICAgIGlmIChvcmlnaW5hbEJhc2VQYXRoICYmICF3b3JrdHJlZUJhc2VQYXRoKSB7XG4gICAgICB0cnkge1xuICAgICAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQmFzZVBhdGgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGJlc3QtZWZmb3J0ICovXG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gUmUtdGhyb3c6IE1lcmdlQ29uZmxpY3RFcnJvciBzdG9wcyB0aGUgYXV0byBsb29wICgjMjMzMCk7XG4gICAgLy8gbm9uLWNvbmZsaWN0IGVycm9ycyBtdXN0IGFsc28gcHJvcGFnYXRlIHNvIGJyb2tlbiBzdGF0ZXMgYXJlXG4gICAgLy8gZGlhZ25vc2FibGUgKCM0MzgwKS5cbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLyoqXG4gKiBCcmFuY2gtbW9kZSBtZXJnZSBib2R5LiBTZXNzaW9uLWxlc3MuXG4gKlxuICogU2Vzc2lvbi1zaWRlIGBnaXRTZXJ2aWNlYCByZWJ1aWxkIGFmdGVyIEhFQUQgY2hhbmdlcyBpcyB0aGUgY2FsbGVyJ3NcbiAqIHJlc3BvbnNpYmlsaXR5LiBUaGUgYnJhbmNoLW1vZGUgYFVzZXJOb3RpZmllZEVycm9yYCBzZW50aW5lbCBzdGlsbCBmbG93c1xuICogdGhyb3VnaCB1bmNoYW5nZWQgc28gdGhlIG91dGVyIGNhbGxlciBjYW4gc3VwcHJlc3MgZHVwbGljYXRlIHRvYXN0cy5cbiAqL1xuZnVuY3Rpb24gX21lcmdlQnJhbmNoTW9kZUltcGwoXG4gIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyxcbiAgbWN0eDogTWVyZ2VDb250ZXh0LFxuKTogTWVyZ2VTdGFuZGFsb25lUmVzdWx0IHtcbiAgY29uc3QgeyB3b3JrdHJlZUJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgbm90aWZ5IH0gPSBtY3R4O1xuICB0cnkge1xuICAgIGNvbnN0IGN1cnJlbnRCcmFuY2ggPSBjdXJyZW50TGlmZWN5Y2xlQnJhbmNoKGRlcHMsIHdvcmt0cmVlQmFzZVBhdGgpO1xuICAgIGNvbnN0IG1pbGVzdG9uZUJyYW5jaCA9IGxpZmVjeWNsZUF1dG9Xb3JrdHJlZUJyYW5jaChkZXBzLCBtaWxlc3RvbmVJZCk7XG5cbiAgICBpZiAoY3VycmVudEJyYW5jaCAhPT0gbWlsZXN0b25lQnJhbmNoKSB7XG4gICAgICAvLyAjNTUzOC1mb2xsb3d1cDogcHJldmlvdXMgYmVoYXZpb3VyIHdhcyB0byBzaWxlbnRseSBgcmV0dXJuIGZhbHNlYFxuICAgICAgLy8gd2hlbiBIRUFEIHdhc24ndCBvbiB0aGUgbWlsZXN0b25lIGJyYW5jaCBcdTIwMTQgdGhhdCBsZXQgdGhlIGxvb3BcbiAgICAgIC8vIGFkdmFuY2Ugd2l0aCB0aGUgbWlsZXN0b25lJ3MgY29tbWl0cyBzdHJhbmRlZCBvbiB0aGUgYnJhbmNoLlxuICAgICAgLy8gQXR0ZW1wdCByZWNvdmVyeSBieSBmb3JjZS1jaGVja2luZy1vdXQgdGhlIG1pbGVzdG9uZSBicmFuY2g7IGlmXG4gICAgICAvLyB0aGF0IGZhaWxzLCB0aHJvdyBzbyB0aGUgY2FsbGVyIHBhdXNlcyBhdXRvLW1vZGUgYW5kIHRoZSB1c2VyXG4gICAgICAvLyBzZWVzIHRoZSBmYWlsdXJlIGluc3RlYWQgb2YgYSBzaWxlbnQgbWVyZ2Ugc2tpcC5cbiAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICBhY3Rpb246IFwibWVyZ2VBbmRFeGl0XCIsXG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBtb2RlOiBcImJyYW5jaFwiLFxuICAgICAgICByZWNvdmVyeTogXCJjaGVja291dC1taWxlc3RvbmUtYnJhbmNoXCIsXG4gICAgICAgIGN1cnJlbnRCcmFuY2gsXG4gICAgICAgIG1pbGVzdG9uZUJyYW5jaCxcbiAgICAgIH0pO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2hlY2tvdXRMaWZlY3ljbGVCcmFuY2goZGVwcywgd29ya3RyZWVCYXNlUGF0aCwgbWlsZXN0b25lQnJhbmNoKTtcbiAgICAgIH0gY2F0Y2ggKGNoZWNrb3V0RXJyKSB7XG4gICAgICAgIGNvbnN0IGNoZWNrb3V0TXNnID1cbiAgICAgICAgICBjaGVja291dEVyciBpbnN0YW5jZW9mIEVycm9yXG4gICAgICAgICAgICA/IGNoZWNrb3V0RXJyLm1lc3NhZ2VcbiAgICAgICAgICAgIDogU3RyaW5nKGNoZWNrb3V0RXJyKTtcbiAgICAgICAgbm90aWZ5KFxuICAgICAgICAgIGBDYW5ub3QgbWVyZ2UgbWlsZXN0b25lICR7bWlsZXN0b25lSWR9OiB3b3JraW5nIHRyZWUgaXMgb24gJHtjdXJyZW50QnJhbmNofSBhbmQgY2hlY2tvdXQgdG8gJHttaWxlc3RvbmVCcmFuY2h9IGZhaWxlZCAoJHtjaGVja291dE1zZ30pLiBSZXNvbHZlIG1hbnVhbGx5IGFuZCBydW4gL2dzZCBhdXRvIHRvIHJlc3VtZS5gLFxuICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgKTtcbiAgICAgICAgdGhyb3cgbmV3IFVzZXJOb3RpZmllZEVycm9yKGNoZWNrb3V0TXNnLCBjaGVja291dEVycik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJldmVyaWZ5ID0gY3VycmVudExpZmVjeWNsZUJyYW5jaChkZXBzLCB3b3JrdHJlZUJhc2VQYXRoKTtcbiAgICAgIGlmIChyZXZlcmlmeSAhPT0gbWlsZXN0b25lQnJhbmNoKSB7XG4gICAgICAgIGNvbnN0IHJldmVyaWZ5TXNnID0gYGJyYW5jaCBjaGVja291dCB0byAke21pbGVzdG9uZUJyYW5jaH0gcmVwb3J0ZWQgc3VjY2VzcyBidXQgY3VycmVudCBicmFuY2ggaXMgJHtyZXZlcmlmeX1gO1xuICAgICAgICBub3RpZnkoXG4gICAgICAgICAgYENhbm5vdCBtZXJnZSBtaWxlc3RvbmUgJHttaWxlc3RvbmVJZH06ICR7cmV2ZXJpZnlNc2d9LiBSZXNvbHZlIG1hbnVhbGx5IGFuZCBydW4gL2dzZCBhdXRvIHRvIHJlc3VtZS5gLFxuICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgKTtcbiAgICAgICAgdGhyb3cgbmV3IFVzZXJOb3RpZmllZEVycm9yKHJldmVyaWZ5TXNnKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCByb2FkbWFwUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKFxuICAgICAgd29ya3RyZWVCYXNlUGF0aCxcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgXCJST0FETUFQXCIsXG4gICAgKTtcbiAgICBpZiAoIXJvYWRtYXBQYXRoKSB7XG4gICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcIm1lcmdlQW5kRXhpdFwiLFxuICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgbW9kZTogXCJicmFuY2hcIixcbiAgICAgICAgc2tpcHBlZDogdHJ1ZSxcbiAgICAgICAgcmVhc29uOiBcIm5vLXJvYWRtYXBcIixcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgbWVyZ2VkOiBmYWxzZSxcbiAgICAgICAgbW9kZTogXCJicmFuY2hcIixcbiAgICAgICAgY29kZUZpbGVzQ2hhbmdlZDogZmFsc2UsXG4gICAgICAgIHB1c2hlZDogZmFsc2UsXG4gICAgICB9O1xuICAgIH1cblxuICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gcmVhZExpZmVjeWNsZUZpbGUoZGVwcywgcm9hZG1hcFBhdGgpO1xuICAgIGNvbnN0IG1lcmdlUmVzdWx0ID0gZGVwcy5tZXJnZU1pbGVzdG9uZVRvTWFpbihcbiAgICAgIHdvcmt0cmVlQmFzZVBhdGgsXG4gICAgICBtaWxlc3RvbmVJZCxcbiAgICAgIHJvYWRtYXBDb250ZW50LFxuICAgICk7XG5cbiAgICBpZiAobWVyZ2VSZXN1bHQuY29kZUZpbGVzQ2hhbmdlZCkge1xuICAgICAgbm90aWZ5KFxuICAgICAgICBgTWlsZXN0b25lICR7bWlsZXN0b25lSWR9IG1lcmdlZCAoYnJhbmNoIG1vZGUpLiR7bWVyZ2VSZXN1bHQucHVzaGVkID8gXCIgUHVzaGVkIHRvIHJlbW90ZS5cIiA6IFwiXCJ9YCxcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBub3RpZnkoXG4gICAgICAgIGBXQVJOSU5HOiBNaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0gbWVyZ2VkIChicmFuY2ggbW9kZSkgYnV0IGNvbnRhaW5lZCBOTyBjb2RlIGNoYW5nZXMgXHUyMDE0IG9ubHkgLmdzZC8gbWV0YWRhdGEuIGAgK1xuICAgICAgICAgIGBSZXZpZXcgdGhlIG1pbGVzdG9uZSBvdXRwdXQgYW5kIHJlLXJ1biBpZiBjb2RlIGlzIG1pc3NpbmcuYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgIGFjdGlvbjogXCJtZXJnZUFuZEV4aXRcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgbW9kZTogXCJicmFuY2hcIixcbiAgICAgIHJlc3VsdDogXCJzdWNjZXNzXCIsXG4gICAgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIG1lcmdlZDogdHJ1ZSxcbiAgICAgIG1vZGU6IFwiYnJhbmNoXCIsXG4gICAgICBjb2RlRmlsZXNDaGFuZ2VkOiBtZXJnZVJlc3VsdC5jb2RlRmlsZXNDaGFuZ2VkLFxuICAgICAgcHVzaGVkOiBtZXJnZVJlc3VsdC5wdXNoZWQsXG4gICAgICBjb21taXRNZXNzYWdlOiBtZXJnZVJlc3VsdC5jb21taXRNZXNzYWdlLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgIGFjdGlvbjogXCJtZXJnZUFuZEV4aXRcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgbW9kZTogXCJicmFuY2hcIixcbiAgICAgIHJlc3VsdDogXCJlcnJvclwiLFxuICAgICAgZXJyb3I6IG1zZyxcbiAgICB9KTtcbiAgICBpZiAoIShlcnIgaW5zdGFuY2VvZiBVc2VyTm90aWZpZWRFcnJvcikpIHtcbiAgICAgIG5vdGlmeShgTWlsZXN0b25lIG1lcmdlIGZhaWxlZCAoYnJhbmNoIG1vZGUpOiAke21zZ31gLCBcIndhcm5pbmdcIik7XG4gICAgfVxuICAgIC8vIFJlLXRocm93IGFsbCBlcnJvcnMgc28gY2FsbGVycyBjYW4gYXBwbHkgdGhlaXIgb3duIHJlY292ZXJ5ICgjNDM4MCkuXG4gICAgdGhyb3cgZXJyO1xuICB9XG59XG5cbi8qKlxuICogU2Vzc2lvbi1sZXNzIG1lcmdlIGVudHJ5IChBRFItMDE2IHBoYXNlIDIgLyBBMSwgaXNzdWUgIzU2MTgpLlxuICpcbiAqIFJ1bnMgdGhlIHdvcmt0cmVlLW1vZGUgb3IgYnJhbmNoLW1vZGUgbWVyZ2UgYm9keSB3aXRob3V0IHRvdWNoaW5nIHNlc3Npb25cbiAqIHN0YXRlLiBVc2VkIGRpcmVjdGx5IGJ5IGBwYXJhbGxlbC1tZXJnZS50c2AgYW5kIGluZGlyZWN0bHkgKHZpYVxuICogYF9tZXJnZUFuZEV4aXRgKSBieSB0aGUgc2luZ2xlLWxvb3AgcGF0aC4gQ2FsbGVyIGlzIHJlc3BvbnNpYmxlIGZvciBhbnlcbiAqIHNlc3Npb24tc2lkZSBjbGVhbnVwIGJhc2VkIG9uIHRoZSByZXR1cm5lZCBgbW9kZWAuXG4gKlxuICogKipDV0QgYW5jaG9yKio6IGFuY2hvcnMgYHByb2Nlc3MuY3dkKClgIGF0IGBvcmlnaW5hbEJhc2VQYXRoYCBiZWZvcmVcbiAqIG5vbi13b3JrdHJlZSBtZXJnZSBwYXRocyB0byBtaXJyb3IgdGhlIHNpbmdsZS1sb29wIGd1YXJkIGFnYWluc3QgRU5PRU5UXG4gKiBhZnRlciB0ZWFyZG93biAoZGU3M2ZiNDNkKS4gV29ya3RyZWUtbW9kZSBtZXJnZSBwYXRocyBrZWVwIHRoZSByZWFsXG4gKiB3b3JrdHJlZSBhcyBjd2QgYmVjYXVzZSBgbWVyZ2VNaWxlc3RvbmVUb01haW4oKWAgaW5mZXJzIHNvdXJjZSB3b3JrdHJlZVxuICogc3RhdGUgZnJvbSBgcHJvY2Vzcy5jd2QoKWAuIEJlc3QtZWZmb3J0OyBzaWxlbnQgb24gZmFpbHVyZS5cbiAqXG4gKiAqKkZhaWx1cmUgaGFuZGxpbmcqKjogYE1lcmdlQ29uZmxpY3RFcnJvcmAgYW5kIG90aGVyIHVucmVjb3ZlcmFibGUgZXJyb3JzXG4gKiBwcm9wYWdhdGUgdG8gdGhlIGNhbGxlci4gVGhlIGNhbGxlciBpcyByZXNwb25zaWJsZSBmb3IgYW55IHN0YXRlIHJlc3RvcmVcbiAqIChzaW5nbGUtbG9vcCBjYWxsZXJzIHJlLWBjaGRpcmAgYW5kIGByZXN0b3JlVG9Qcm9qZWN0Um9vdGA7IHBhcmFsbGVsXG4gKiBjYWxsZXJzIHN1cmZhY2UgdG8gdGhlIHVzZXIgYXMgYSBgTWVyZ2VSZXN1bHRgIHdpdGggYHN1Y2Nlc3M6IGZhbHNlYCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtZXJnZU1pbGVzdG9uZVN0YW5kYWxvbmUoXG4gIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcyxcbiAgbWN0eDogTWVyZ2VDb250ZXh0LFxuKTogTWVyZ2VTdGFuZGFsb25lUmVzdWx0IHtcbiAgY29uc3QgeyBvcmlnaW5hbEJhc2VQYXRoLCB3b3JrdHJlZUJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgbm90aWZ5IH0gPSBtY3R4O1xuICB2YWxpZGF0ZU1pbGVzdG9uZUlkKG1pbGVzdG9uZUlkKTtcblxuICBpZiAobWN0eC5pc29sYXRpb25EZWdyYWRlZCkge1xuICAgIGlmIChvcmlnaW5hbEJhc2VQYXRoKSB7XG4gICAgICB0cnkge1xuICAgICAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQmFzZVBhdGgpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICAgIGFjdGlvbjogXCJtZXJnZUFuZEV4aXRcIixcbiAgICAgICAgICBwaGFzZTogXCJwcmUtbWVyZ2UtY2hkaXItZmFpbGVkXCIsXG4gICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgb3JpZ2luYWxCYXNlUGF0aCxcbiAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgZGVidWdMb2coXCJXb3JrdHJlZUxpZmVjeWNsZVwiLCB7XG4gICAgICBhY3Rpb246IFwibWVyZ2VBbmRFeGl0XCIsXG4gICAgICBtaWxlc3RvbmVJZCxcbiAgICAgIHNraXBwZWQ6IHRydWUsXG4gICAgICByZWFzb246IFwiaXNvbGF0aW9uLWRlZ3JhZGVkXCIsXG4gICAgfSk7XG4gICAgbm90aWZ5KFxuICAgICAgYFNraXBwaW5nIHdvcmt0cmVlIG1lcmdlIGZvciAke21pbGVzdG9uZUlkfSBcdTIwMTQgaXNvbGF0aW9uIHdhcyBkZWdyYWRlZCAod29ya3RyZWUgY3JlYXRpb24gZmFpbGVkIGVhcmxpZXIpLiBXb3JrIGlzIG9uIHRoZSBjdXJyZW50IGJyYW5jaC5gLFxuICAgICAgXCJpbmZvXCIsXG4gICAgKTtcbiAgICByZXR1cm4ge1xuICAgICAgbWVyZ2VkOiBmYWxzZSxcbiAgICAgIG1vZGU6IFwic2tpcHBlZFwiLFxuICAgICAgY29kZUZpbGVzQ2hhbmdlZDogZmFsc2UsXG4gICAgICBwdXNoZWQ6IGZhbHNlLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBtb2RlID0gZ2V0SXNvbGF0aW9uTW9kZShvcmlnaW5hbEJhc2VQYXRoIHx8IHdvcmt0cmVlQmFzZVBhdGgpO1xuICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICBhY3Rpb246IFwibWVyZ2VBbmRFeGl0XCIsXG4gICAgbWlsZXN0b25lSWQsXG4gICAgbW9kZSxcbiAgICBiYXNlUGF0aDogd29ya3RyZWVCYXNlUGF0aCxcbiAgfSk7XG4gIGVtaXRKb3VybmFsRXZlbnQob3JpZ2luYWxCYXNlUGF0aCB8fCB3b3JrdHJlZUJhc2VQYXRoLCB7XG4gICAgdHM6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICBmbG93SWQ6IHJhbmRvbVVVSUQoKSxcbiAgICBzZXE6IDAsXG4gICAgZXZlbnRUeXBlOiBcIndvcmt0cmVlLW1lcmdlLXN0YXJ0XCIsXG4gICAgZGF0YTogeyBtaWxlc3RvbmVJZCwgbW9kZSB9LFxuICB9KTtcblxuICAvLyAjMjYyNTogSWYgd2UgYXJlIHBoeXNpY2FsbHkgaW5zaWRlIGFuIGF1dG8td29ya3RyZWUsIHdlIE1VU1QgbWVyZ2VcbiAgLy8gcmVnYXJkbGVzcyBvZiB0aGUgY3VycmVudCBpc29sYXRpb24gY29uZmlnLiBUaGlzIHByZXZlbnRzIGRhdGEgbG9zc1xuICAvLyB3aGVuIHRoZSBkZWZhdWx0IGlzb2xhdGlvbiBtb2RlIGNoYW5nZXMgYmV0d2VlbiB2ZXJzaW9ucy5cbiAgY29uc3QgaW5Xb3JrdHJlZSA9XG4gICAgbGlmZWN5Y2xlSXNJbkF1dG9Xb3JrdHJlZShkZXBzLCB3b3JrdHJlZUJhc2VQYXRoKSAmJiBCb29sZWFuKG9yaWdpbmFsQmFzZVBhdGgpO1xuXG4gIGlmIChtb2RlID09PSBcIm5vbmVcIiAmJiAhaW5Xb3JrdHJlZSkge1xuICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgYWN0aW9uOiBcIm1lcmdlQW5kRXhpdFwiLFxuICAgICAgbWlsZXN0b25lSWQsXG4gICAgICBza2lwcGVkOiB0cnVlLFxuICAgICAgcmVhc29uOiBcIm1vZGUtbm9uZVwiLFxuICAgIH0pO1xuICAgIC8vIEFuY2hvciBjd2QgYXQgcHJvamVjdCByb290IGJlZm9yZSB0aGUgZWFybHkgcmV0dXJuIHNvIHN1YnNlcXVlbnRcbiAgICAvLyBwcm9jZXNzLmN3ZCgpIGNhbGxzIGFmdGVyIHRoZSBza2lwIGRvbid0IEVOT0VOVCBpZiB3ZSB3ZXJlIGluc2lkZSBhXG4gICAgLy8gd29ya3RyZWUgZGlyZWN0b3J5IHRoYXQgZ2V0cyB0b3JuIGRvd24gbGF0ZXIuIEJlc3QtZWZmb3J0LlxuICAgIGlmIChvcmlnaW5hbEJhc2VQYXRoKSB7XG4gICAgICB0cnkge1xuICAgICAgICBwcm9jZXNzLmNoZGlyKG9yaWdpbmFsQmFzZVBhdGgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGJlc3QtZWZmb3J0ICovXG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBtZXJnZWQ6IGZhbHNlLFxuICAgICAgbW9kZTogXCJza2lwcGVkXCIsXG4gICAgICBjb2RlRmlsZXNDaGFuZ2VkOiBmYWxzZSxcbiAgICAgIHB1c2hlZDogZmFsc2UsXG4gICAgfTtcbiAgfVxuXG4gIC8vIFNldCBjd2QgdG8gdGhlIGNvcnJlY3QgYW5jaG9yIGJlZm9yZSBkaXNwYXRjaGluZyB0byBtb2RlIGltcGxlbWVudGF0aW9ucy5cbiAgLy8gV29ya3RyZWUgbW9kZSAvIGluLXdvcmt0cmVlIG92ZXJyaWRlIG11c3QgcnVuIGZyb20gdGhlIGxpdmUgd29ya3RyZWUgc29cbiAgLy8gbWVyZ2VNaWxlc3RvbmVUb01haW4gY2FuIGZpbmQgd29ya3RyZWUtbG9jYWwgc3RhdGU7IGJyYW5jaCBtb2RlIHJ1bnMgZnJvbVxuICAvLyB0aGUgb3JpZ2luYWwgcHJvamVjdCByb290LiBCZXN0LWVmZm9ydCBmb3Igc3ludGhldGljIHRlc3QgcGF0aHMuXG4gIGNvbnN0IHRhcmdldEN3ZCA9IG1vZGUgPT09IFwid29ya3RyZWVcIiB8fCBpbldvcmt0cmVlXG4gICAgPyB3b3JrdHJlZUJhc2VQYXRoXG4gICAgOiBvcmlnaW5hbEJhc2VQYXRoO1xuICBpZiAodGFyZ2V0Q3dkKSB7XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3MuY2hkaXIodGFyZ2V0Q3dkKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICBhY3Rpb246IFwibWVyZ2VBbmRFeGl0XCIsXG4gICAgICAgIHBoYXNlOiBcInByZS1tZXJnZS1jaGRpci1mYWlsZWRcIixcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIHRhcmdldEN3ZCxcbiAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIGlmIChtb2RlID09PSBcIndvcmt0cmVlXCIgfHwgaW5Xb3JrdHJlZSkge1xuICAgIHJldHVybiBfbWVyZ2VXb3JrdHJlZU1vZGVJbXBsKGRlcHMsIG1jdHgpO1xuICB9XG4gIGlmIChtb2RlID09PSBcImJyYW5jaFwiKSB7XG4gICAgcmV0dXJuIF9tZXJnZUJyYW5jaE1vZGVJbXBsKGRlcHMsIG1jdHgpO1xuICB9XG4gIC8vIERlZmVuc2l2ZSBmYWxsYmFjayBcdTIwMTQgc2hvdWxkIG5vdCByZWFjaCBoZXJlIGdpdmVuIHRoZSBtb2RlLW5vbmUgZ3VhcmQgYWJvdmUuXG4gIHJldHVybiB7XG4gICAgbWVyZ2VkOiBmYWxzZSxcbiAgICBtb2RlOiBcInNraXBwZWRcIixcbiAgICBjb2RlRmlsZXNDaGFuZ2VkOiBmYWxzZSxcbiAgICBwdXNoZWQ6IGZhbHNlLFxuICB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgTW9kdWxlIGNsYXNzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIFdvcmt0cmVlIExpZmVjeWNsZSBtb2R1bGUgaW5zdGFuY2UuXG4gKlxuICogQ29uc3RydWN0ZWQgb25jZSBwZXIgYXV0by1tb2RlIHNlc3Npb24uIEhvbGRzIHRoZSBzZXNzaW9uIHJlZmVyZW5jZSBzb1xuICogdmVyYnMgY2FuIG11dGF0ZSBgcy5iYXNlUGF0aGAgYW5kIHJlbGF0ZWQgY29vcmRpbmF0aW9uIHN0YXRlIGRpcmVjdGx5XG4gKiB3aXRob3V0IHJvdW5kLXRyaXBwaW5nIHRocm91Z2ggY2FsbGVycy5cbiAqL1xuZXhwb3J0IGNsYXNzIFdvcmt0cmVlTGlmZWN5Y2xlIHtcbiAgcHJpdmF0ZSByZWFkb25seSBzOiBBdXRvU2Vzc2lvbjtcbiAgcHJpdmF0ZSByZWFkb25seSBkZXBzOiBXb3JrdHJlZUxpZmVjeWNsZURlcHM7XG5cbiAgY29uc3RydWN0b3IoczogQXV0b1Nlc3Npb24sIGRlcHM6IFdvcmt0cmVlTGlmZWN5Y2xlRGVwcykge1xuICAgIHRoaXMucyA9IHM7XG4gICAgdGhpcy5kZXBzID0gZGVwcztcbiAgfVxuXG4gIC8qKlxuICAgKiBFbnRlciBvciBjcmVhdGUgdGhlIGF1dG8td29ya3RyZWUgZm9yIGBtaWxlc3RvbmVJZGAuIElkZW1wb3RlbnQgaWZcbiAgICogYWxyZWFkeSBpbiB0aGlzIG1pbGVzdG9uZSAobGVhc2UgcmVmcmVzaGVkOyBiYXNlUGF0aCB1bmNoYW5nZWQpLlxuICAgKlxuICAgKiBSZXR1cm5zIGEgdHlwZWQgYEVudGVyUmVzdWx0YCBkZXNjcmliaW5nIHRoZSBvdXRjb21lLiBDYWxsZXJzIG1heVxuICAgKiBpZ25vcmUgdGhlIHJlc3VsdCBpZiB0aGV5IHJlYWQgYHMuYmFzZVBhdGhgIGRpcmVjdGx5IGFmdGVyd2FyZHNcbiAgICogKGxlZ2FjeSBiZWhhdmlvdXIpOyBuZXcgY2FsbGVycyBzaG91bGQgYnJhbmNoIG9uIHRoZSByZXN1bHQuXG4gICAqL1xuICBlbnRlck1pbGVzdG9uZShtaWxlc3RvbmVJZDogc3RyaW5nLCBjdHg6IE5vdGlmeUN0eCk6IEVudGVyUmVzdWx0IHtcbiAgICByZXR1cm4gX2VudGVyTWlsZXN0b25lQ29yZSh0aGlzLnMsIHRoaXMuZGVwcywgbWlsZXN0b25lSWQsIGN0eCk7XG4gIH1cblxuICAvKipcbiAgICogRXhpdCB0aGUgY3VycmVudCB3b3JrdHJlZS4gV2l0aCBgb3B0cy5tZXJnZSA9PT0gdHJ1ZWAsIHJ1bnMgdGhlIGZ1bGxcbiAgICogbWVyZ2UtYW5kLXRlYXJkb3duIHBhdGggKHdvcmt0cmVlLW1vZGUgb3IgYnJhbmNoLW1vZGUgYXV0by1kZXRlY3RlZCkuXG4gICAqIFdpdGggYG9wdHMubWVyZ2UgPT09IGZhbHNlYCwgcnVucyBhdXRvLWNvbW1pdCBhbmQgdGVhcmRvd24gd2l0aG91dFxuICAgKiBtZXJnaW5nIHRvIG1haW4uXG4gICAqXG4gICAqIFJldHVybnMgYSB0eXBlZCBgRXhpdFJlc3VsdGAuIGBNZXJnZUNvbmZsaWN0RXJyb3JgIGlzIHN1cmZhY2VkIGFzXG4gICAqIGB7IG9rOiBmYWxzZSwgcmVhc29uOiBcIm1lcmdlLWNvbmZsaWN0XCIsIGNhdXNlIH1gIGluc3RlYWQgb2YgdGhyb3duLFxuICAgKiBnaXZpbmcgY2FsbGVycyBhIHR5cGVkIGJyYW5jaCBmb3IgdGhlIGV4cGVjdGVkIGZhaWx1cmUgcGF0aC5cbiAgICogVW5leHBlY3RlZCBmYWlsdXJlcyAoZmlsZXN5c3RlbSwgZ2l0IHBlcm1pc3Npb25zLCBldGMuKSBhcmUgd3JhcHBlZFxuICAgKiBhcyBgeyBvazogZmFsc2UsIHJlYXNvbjogXCJ0ZWFyZG93bi1mYWlsZWRcIiwgY2F1c2UgfWAgc28gY2FsbGVycyBhbHdheXNcbiAgICogcmVjZWl2ZSBhIGRpc2NyaW1pbmF0ZWQgdW5pb24gXHUyMDE0IG5vIGV4Y2VwdGlvbnMgZm9yIGFueSBleHBlY3RlZCBvdXRjb21lLlxuICAgKi9cbiAgZXhpdE1pbGVzdG9uZShcbiAgICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICAgIG9wdHM6IHsgbWVyZ2U6IGJvb2xlYW47IHByZXNlcnZlQnJhbmNoPzogYm9vbGVhbiB9LFxuICAgIGN0eDogTm90aWZ5Q3R4LFxuICApOiBFeGl0UmVzdWx0IHtcbiAgICBpZiAob3B0cy5tZXJnZSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWVyZ2VkID0gdGhpcy5fbWVyZ2VBbmRFeGl0KG1pbGVzdG9uZUlkLCBjdHgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiB0cnVlLFxuICAgICAgICAgIG1lcmdlZDogbWVyZ2VkLm1lcmdlZCxcbiAgICAgICAgICBjb2RlRmlsZXNDaGFuZ2VkOiBtZXJnZWQuY29kZUZpbGVzQ2hhbmdlZCxcbiAgICAgICAgfTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoZXJyIGluc3RhbmNlb2YgTWVyZ2VDb25mbGljdEVycm9yKSB7XG4gICAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IFwibWVyZ2UtY29uZmxpY3RcIiwgY2F1c2U6IGVyciB9O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB7IG9rOiBmYWxzZSwgcmVhc29uOiBcInRlYXJkb3duLWZhaWxlZFwiLCBjYXVzZTogZXJyIH07XG4gICAgICB9XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICB0aGlzLl9leGl0V2l0aG91dE1lcmdlKG1pbGVzdG9uZUlkLCBjdHgsIHtcbiAgICAgICAgcHJlc2VydmVCcmFuY2g6IG9wdHMucHJlc2VydmVCcmFuY2gsXG4gICAgICB9KTtcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBtZXJnZWQ6IGZhbHNlLCBjb2RlRmlsZXNDaGFuZ2VkOiBmYWxzZSB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCByZWFzb246IFwidGVhcmRvd24tZmFpbGVkXCIsIGNhdXNlOiBlcnIgfTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogTWlsZXN0b25lIHRyYW5zaXRpb246IG1lcmdlIHRoZSBjdXJyZW50IG1pbGVzdG9uZSwgdGhlbiBlbnRlciB0aGUgbmV4dFxuICAgKiBvbmUuIFBhdHRlcm4gdXNlZCB3aGVuIHRoZSBsb29wIGRldGVjdHMgdGhhdCB0aGUgYWN0aXZlIG1pbGVzdG9uZSBoYXNcbiAgICogY2hhbmdlZCAoY3VycmVudCBjb21wbGV0ZWQsIG5leHQgaXMgbm93IGFjdGl2ZSkuIENhbGxlciBpcyByZXNwb25zaWJsZVxuICAgKiBmb3IgcmUtZGVyaXZpbmcgc3RhdGUgYmV0d2VlbiB0aGUgbWVyZ2UgYW5kIHRoZSBlbnRlci5cbiAgICovXG4gIG1lcmdlQW5kRW50ZXJOZXh0KFxuICAgIGN1cnJlbnRNaWxlc3RvbmVJZDogc3RyaW5nLFxuICAgIG5leHRNaWxlc3RvbmVJZDogc3RyaW5nLFxuICAgIGN0eDogTm90aWZ5Q3R4LFxuICApOiB2b2lkIHtcbiAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgIGFjdGlvbjogXCJtZXJnZUFuZEVudGVyTmV4dFwiLFxuICAgICAgY3VycmVudE1pbGVzdG9uZUlkLFxuICAgICAgbmV4dE1pbGVzdG9uZUlkLFxuICAgIH0pO1xuICAgIGxldCBtZXJnZWQgPSBmYWxzZTtcbiAgICBsZXQgbWVyZ2VUaHJldyA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBtZXJnZWQgPSB0aGlzLl9tZXJnZUFuZEV4aXQoY3VycmVudE1pbGVzdG9uZUlkLCBjdHgpLm1lcmdlZDtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGlmIChlcnIgaW5zdGFuY2VvZiBVc2VyTm90aWZpZWRFcnJvcikgdGhyb3cgZXJyO1xuICAgICAgbWVyZ2VUaHJldyA9IHRydWU7XG4gICAgICAvLyBfbWVyZ2VBbmRFeGl0IGVtaXRzIGEgd2FybmluZyBhbmQgcmVzdG9yZXMgc3RhdGUgb24gZmFpbHVyZSBkdXJpbmdcbiAgICAgIC8vIG1lcmdlL2NsZWFudXAuIElmIGl0IHRocm93cyBiZWZvcmUgcmVjb3ZlcnkgcnVucyAoZS5nLiB2YWxpZGF0aW9uLFxuICAgICAgLy8gZW1pdEpvdXJuYWxFdmVudCksIGJhc2VQYXRoIGlzbid0IHJlc3RvcmVkIFx1MjAxNCByZS10aHJvdyBzbyB3ZSBkb24ndFxuICAgICAgLy8gZW50ZXIgdGhlIG5leHQgbWlsZXN0b25lIHdpdGggdGhlIGN1cnJlbnQgb25lIHVubWVyZ2VkLlxuICAgICAgY29uc3QgcHJvamVjdFJvb3QgPSByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdChcbiAgICAgICAgdGhpcy5zLmJhc2VQYXRoLFxuICAgICAgICB0aGlzLnMub3JpZ2luYWxCYXNlUGF0aCxcbiAgICAgICk7XG4gICAgICBpZiAodGhpcy5zLmJhc2VQYXRoICE9PSBwcm9qZWN0Um9vdCkgdGhyb3cgZXJyO1xuICAgICAgLy8gT3RoZXJ3aXNlOiBtZXJnZSBhdHRlbXB0ZWQsIGZhaWxlZCBjbGVhbmx5IHdpdGggc3RhdGUgcmVzdG9yZWQuXG4gICAgICAvLyBUaGUgbG9vcCBpbnRlbnRpb25hbGx5IGNvbnRpbnVlcyB0byB0aGUgbmV4dCBtaWxlc3RvbmUgXHUyMDE0IHRoZVxuICAgICAgLy8gZmFpbGVkIG1pbGVzdG9uZSdzIGJyYW5jaCBpcyBwcmVzZXJ2ZWQgZm9yIG1hbnVhbCByZWNvdmVyeS5cbiAgICB9XG4gICAgaWYgKCFtZXJnZWQgJiYgIW1lcmdlVGhyZXcgJiYgIXRoaXMucy5pc29sYXRpb25EZWdyYWRlZCkge1xuICAgICAgLy8gX21lcmdlQW5kRXhpdCByZXR1cm5lZCB3aXRob3V0IGF0dGVtcHRpbmcgYSBtZXJnZSAobm8gcm9hZG1hcFxuICAgICAgLy8gXHUyMTkyIHByZXNlcnZlQnJhbmNoIHBhdGgpIGFuZCBzdGF0ZSBpcyByZXN0b3JlZC4gVGhlIGN1cnJlbnRcbiAgICAgIC8vIG1pbGVzdG9uZSB3YXMgZGVsaWJlcmF0ZWx5IE5PVCBtZXJnZWQ7IGhhbHQgYmVmb3JlIGVudGVyaW5nIHRoZVxuICAgICAgLy8gbmV4dCBzbyB3ZSBkb24ndCBzaWxlbnRseSBzdHJhbmQgY29tbWl0cyBvbiB0aGUgcHJlc2VydmVkXG4gICAgICAvLyBicmFuY2guICgjNTYwMiBoYWx0LW9uLW5vLW1lcmdlIHJlZ3Jlc3Npb24gY292ZXJhZ2UuKVxuICAgICAgLy9cbiAgICAgIC8vIG1lcmdlVGhyZXc9dHJ1ZSBtZWFucyBhIG1lcmdlIHdhcyBhdHRlbXB0ZWQgYnV0IGZhaWxlZCBcdTIwMTQgdGhhdFxuICAgICAgLy8gcGF0aCBwcm9jZWVkcyAoZXhpc3RpbmcgdGVzdCBcImVudGVycyBuZXh0IGV2ZW4gaWYgbWVyZ2UgZmFpbHNcIikuXG4gICAgICAvLyBpc29sYXRpb25EZWdyYWRlZD10cnVlIG1lYW5zIHRoZSBsb29wIGludGVudGlvbmFsbHkgY29udGludWVzXG4gICAgICAvLyB3aXRob3V0IG1lcmdpbmcgXHUyMDE0IHRoYXQgcGF0aCBwcm9jZWVkcyB0b28uXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBDYW5ub3QgZW50ZXIgbWlsZXN0b25lICR7bmV4dE1pbGVzdG9uZUlkfSBiZWNhdXNlICR7Y3VycmVudE1pbGVzdG9uZUlkfSB3YXMgbm90IG1lcmdlZGAsXG4gICAgICApO1xuICAgIH1cbiAgICBfZW50ZXJNaWxlc3RvbmVDb3JlKHRoaXMucywgdGhpcy5kZXBzLCBuZXh0TWlsZXN0b25lSWQsIGN0eCk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgUHJpdmF0ZSBcdTIwMTQgZXhpdCB3aXRob3V0IG1lcmdlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gIHByaXZhdGUgX2V4aXRXaXRob3V0TWVyZ2UoXG4gICAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgICBjdHg6IE5vdGlmeUN0eCxcbiAgICBvcHRzOiB7IHByZXNlcnZlQnJhbmNoPzogYm9vbGVhbiB9LFxuICApOiB2b2lkIHtcbiAgICB2YWxpZGF0ZU1pbGVzdG9uZUlkKG1pbGVzdG9uZUlkKTtcbiAgICBpZiAoIWxpZmVjeWNsZUlzSW5BdXRvV29ya3RyZWUodGhpcy5kZXBzLCB0aGlzLnMuYmFzZVBhdGgpKSB7XG4gICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImV4aXRNaWxlc3RvbmVcIixcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIHNraXBwZWQ6IHRydWUsXG4gICAgICAgIHJlYXNvbjogXCJub3QtaW4td29ya3RyZWVcIixcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgYWN0aW9uOiBcImV4aXRNaWxlc3RvbmVcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgYmFzZVBhdGg6IHRoaXMucy5iYXNlUGF0aCxcbiAgICB9KTtcblxuICAgIHRyeSB7XG4gICAgICBhdXRvQ29tbWl0TGlmZWN5Y2xlQnJhbmNoKHRoaXMuZGVwcywgdGhpcy5zLmJhc2VQYXRoLCBcInN0b3BcIiwgbWlsZXN0b25lSWQpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgZGVidWdMb2coXCJXb3JrdHJlZUxpZmVjeWNsZVwiLCB7XG4gICAgICAgIGFjdGlvbjogXCJleGl0TWlsZXN0b25lXCIsXG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBwaGFzZTogXCJhdXRvLWNvbW1pdC1mYWlsZWRcIixcbiAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgIH0pO1xuICAgICAgY3R4Lm5vdGlmeShcbiAgICAgICAgYEF1dG8tY29tbWl0IGJlZm9yZSBleGl0aW5nICR7bWlsZXN0b25lSWR9IGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9LiBCcmFuY2ggJHtsaWZlY3ljbGVBdXRvV29ya3RyZWVCcmFuY2godGhpcy5kZXBzLCBtaWxlc3RvbmVJZCl9IGlzIHByZXNlcnZlZCBmb3IgcmVjb3ZlcnkuYCxcbiAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmICh0aGlzLnMub3JpZ2luYWxCYXNlUGF0aCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgcHJvY2Vzcy5jaGRpcih0aGlzLnMub3JpZ2luYWxCYXNlUGF0aCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgZGVidWdMb2coXCJXb3JrdHJlZUxpZmVjeWNsZVwiLCB7XG4gICAgICAgICAgYWN0aW9uOiBcImV4aXRNaWxlc3RvbmVcIixcbiAgICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgICBwaGFzZTogXCJwcmUtdGVhcmRvd24tY2hkaXItZmFpbGVkXCIsXG4gICAgICAgICAgb3JpZ2luYWxCYXNlUGF0aDogdGhpcy5zLm9yaWdpbmFsQmFzZVBhdGgsXG4gICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGN0eC5ub3RpZnkoXG4gICAgICAgICAgYENvdWxkIG5vdCBsZWF2ZSBtaWxlc3RvbmUgd29ya3RyZWUgYmVmb3JlIGNsZWFudXA6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfS4gQnJhbmNoICR7bGlmZWN5Y2xlQXV0b1dvcmt0cmVlQnJhbmNoKHRoaXMuZGVwcywgbWlsZXN0b25lSWQpfSBpcyBwcmVzZXJ2ZWQgZm9yIHJlY292ZXJ5LmAsXG4gICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGV0IHRlYXJkb3duRmFpbGVkID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGxpZmVjeWNsZVRlYXJkb3duQXV0b1dvcmt0cmVlKHRoaXMuZGVwcywgdGhpcy5zLm9yaWdpbmFsQmFzZVBhdGgsIG1pbGVzdG9uZUlkLCB7XG4gICAgICAgIHByZXNlcnZlQnJhbmNoOiBvcHRzLnByZXNlcnZlQnJhbmNoID8/IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICB0ZWFyZG93bkZhaWxlZCA9IHRydWU7XG4gICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImV4aXRNaWxlc3RvbmVcIixcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIHBoYXNlOiBcInRlYXJkb3duLWZhaWxlZFwiLFxuICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgfSk7XG4gICAgICBjdHgubm90aWZ5KFxuICAgICAgICBgV29ya3RyZWUgY2xlYW51cCBmYWlsZWQgZm9yICR7bWlsZXN0b25lSWR9OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX0uIEJyYW5jaCAke2xpZmVjeWNsZUF1dG9Xb3JrdHJlZUJyYW5jaCh0aGlzLmRlcHMsIG1pbGVzdG9uZUlkKX0gaXMgcHJlc2VydmVkIGZvciByZWNvdmVyeS5gLFxuICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgdGhpcy5yZXN0b3JlVG9Qcm9qZWN0Um9vdCgpO1xuICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgYWN0aW9uOiBcImV4aXRNaWxlc3RvbmVcIixcbiAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgcmVzdWx0OiBcImRvbmVcIixcbiAgICAgIGJhc2VQYXRoOiB0aGlzLnMuYmFzZVBhdGgsXG4gICAgfSk7XG4gICAgY3R4Lm5vdGlmeShcbiAgICAgIHRlYXJkb3duRmFpbGVkXG4gICAgICAgID8gYFdvcmt0cmVlIGV4aXQgZm9yICR7bWlsZXN0b25lSWR9IG5lZWRzIG1hbnVhbCBjbGVhbnVwLmBcbiAgICAgICAgOiBgRXhpdGVkIHdvcmt0cmVlIGZvciAke21pbGVzdG9uZUlkfWAsXG4gICAgICB0ZWFyZG93bkZhaWxlZCA/IFwid2FybmluZ1wiIDogXCJpbmZvXCIsXG4gICAgKTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBQcml2YXRlIFx1MjAxNCBtZXJnZSBhbmQgZXhpdCAod29ya3RyZWUtbW9kZSBvciBicmFuY2gtbW9kZSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgLyoqXG4gICAqIE1lcmdlIHRoZSBjb21wbGV0ZWQgbWlsZXN0b25lIGJyYW5jaCBiYWNrIHRvIG1haW4gYW5kIGV4aXQgdGhlIHdvcmt0cmVlLlxuICAgKlxuICAgKiBTZXNzaW9uLWJvdW5kIHdyYXBwZXIgYXJvdW5kIGBtZXJnZU1pbGVzdG9uZVN0YW5kYWxvbmVgLiBCdWlsZHMgYVxuICAgKiBgTWVyZ2VDb250ZXh0YCBmcm9tIGB0aGlzLnNgLCBsYXllcnMgc2Vzc2lvbi1zaWRlIGJvb2trZWVwaW5nIG9uIHRvcCBvZlxuICAgKiB0aGUgcmVzdWx0OlxuICAgKlxuICAgKiAtIHJlc3F1YXNoLW9uLW1lcmdlIHVzaW5nIGBzLm1pbGVzdG9uZVN0YXJ0U2hhc2BcbiAgICogLSBtZXJnZS1jb21wbGV0aW9uIHRlbGVtZXRyeSAoZHVyYXRpb24pXG4gICAqIC0gbW9kZS1zcGVjaWZpYyBzZXNzaW9uIHJlc3RvcmU6IHdvcmt0cmVlLW1vZGUgXHUyMTkyIGByZXN0b3JlVG9Qcm9qZWN0Um9vdGAsXG4gICAqICAgYnJhbmNoLW1vZGUgXHUyMTkyIGBnaXRTZXJ2aWNlYCByZWJ1aWxkXG4gICAqXG4gICAqIFJldHVybnMgdGhlIHNlc3Npb24tbGVzcyBtZXJnZSByZXN1bHQuIEVycm9ycyBwcm9wYWdhdGUgYWZ0ZXJcbiAgICogYHJlc3RvcmVUb1Byb2plY3RSb290KClgIHJ1bnMgc28gY2FsbGVycyBhbHdheXMgcmVjZWl2ZSBhIGNvbnNpc3RlbnRcbiAgICogc2Vzc2lvbi5cbiAgICovXG4gIHByaXZhdGUgX21lcmdlQW5kRXhpdChcbiAgICBtaWxlc3RvbmVJZDogc3RyaW5nLFxuICAgIGN0eDogTm90aWZ5Q3R4LFxuICApOiBNZXJnZVN0YW5kYWxvbmVSZXN1bHQge1xuICAgIC8vICM0NzY0IFx1MjAxNCB0ZWxlbWV0cnk6IHJlY29yZCBzdGFydCB0aW1lc3RhbXAgc28gd2UgY2FuIGVtaXQgbWVyZ2UgZHVyYXRpb24uXG4gICAgY29uc3QgbWVyZ2VTdGFydGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgbWVyZ2VTdGFydE1zID0gRGF0ZS5ub3coKTtcblxuICAgIGxldCByZXN1bHQ6IE1lcmdlU3RhbmRhbG9uZVJlc3VsdDtcbiAgICB0cnkge1xuICAgICAgcmVzdWx0ID0gbWVyZ2VNaWxlc3RvbmVTdGFuZGFsb25lKHRoaXMuZGVwcywge1xuICAgICAgICBvcmlnaW5hbEJhc2VQYXRoOiB0aGlzLnMub3JpZ2luYWxCYXNlUGF0aCxcbiAgICAgICAgd29ya3RyZWVCYXNlUGF0aDogdGhpcy5zLmJhc2VQYXRoLFxuICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgaXNvbGF0aW9uRGVncmFkZWQ6IHRoaXMucy5pc29sYXRpb25EZWdyYWRlZCxcbiAgICAgICAgbm90aWZ5OiBjdHgubm90aWZ5LFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBTdGFuZGFsb25lIGhhcyBhbHJlYWR5IGRvbmUgaXRzIHNlc3Npb24tbGVzcyBjbGVhbnVwXG4gICAgICAvLyAoY2hkaXIsIFNRVUFTSF9NU0cgY2xlYW51cCwgam91cm5hbCBldmVudCkuIExheWVyIHNlc3Npb24tc2lkZVxuICAgICAgLy8gcmVzdG9yZSBvbiB0b3Agc28gY2FsbGVycyBnZXQgYSBjb25zaXN0ZW50IHNlc3Npb24uXG4gICAgICB0aGlzLnJlc3RvcmVUb1Byb2plY3RSb290KCk7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuXG4gICAgaWYgKCFyZXN1bHQubWVyZ2VkKSB7XG4gICAgICAvLyBTa2lwIC8gbm8tcm9hZG1hcCAvIG1vZGUtbm9uZSBwYXRocy4gbWlsZXN0b25lU3RhcnRTaGFzIGhvdXNla2VlcGluZ1xuICAgICAgLy8gaXMgdW5jb25kaXRpb25hbDsgbW9kZS1zcGVjaWZpYyBzZXNzaW9uIHJlc3RvcmUgaGFwcGVucyBmb3JcbiAgICAgIC8vIHdvcmt0cmVlLW1vZGUgKHByZXNlcnZlLWJyYW5jaCBwYXRoIHRvcmUgZG93biB0aGUgd29ya3RyZWUsIHNvXG4gICAgICAvLyBiYXNlUGF0aCBtdXN0IHJlc3RvcmUpIGFuZCBub3QgZm9yIGJyYW5jaC1tb2RlIChubyBiYXNlUGF0aCBjaGFuZ2UpLlxuICAgICAgdGhpcy5zLm1pbGVzdG9uZVN0YXJ0U2hhcy5kZWxldGUobWlsZXN0b25lSWQpO1xuICAgICAgaWYgKHJlc3VsdC5tb2RlID09PSBcIndvcmt0cmVlXCIpIHtcbiAgICAgICAgdGhpcy5yZXN0b3JlVG9Qcm9qZWN0Um9vdCgpO1xuICAgICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgICBhY3Rpb246IFwibWVyZ2VBbmRFeGl0XCIsXG4gICAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgICAgcmVzdWx0OiBcImRvbmVcIixcbiAgICAgICAgICBiYXNlUGF0aDogdGhpcy5zLmJhc2VQYXRoLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLy8gIzQ3NjUgXHUyMDE0IHdoZW4gY29sbGFwc2VfY2FkZW5jZT1zbGljZSBBTkQgbWlsZXN0b25lX3Jlc3F1YXNoPXRydWUsIHRoZVxuICAgIC8vIE4gcGVyLXNsaWNlIGNvbW1pdHMgb24gbWFpbiBzaG91bGQgYmUgY29sbGFwc2VkIGludG8gb25lIG1pbGVzdG9uZVxuICAgIC8vIGNvbW1pdC4gRG9uZSBBRlRFUiB0aGUgcHJpbWFyeSBtZXJnZS1hbmQtdGVhcmRvd24gc28gdGhlIGJyYW5jaCBhbmRcbiAgICAvLyB3b3JrdHJlZSBhcmUgYWxyZWFkeSBjbGVhbmVkIHVwOyB3ZSBvcGVyYXRlIG9uIG1haW4gZGlyZWN0bHkuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN0YXJ0U2hhID0gdGhpcy5zLm1pbGVzdG9uZVN0YXJ0U2hhcy5nZXQobWlsZXN0b25lSWQpO1xuICAgICAgaWYgKHN0YXJ0U2hhKSB7XG4gICAgICAgIGNvbnN0IHByZWZzID0gbGlmZWN5Y2xlTG9hZFByZWZlcmVuY2VzKFxuICAgICAgICAgIHRoaXMuZGVwcyxcbiAgICAgICAgICB0aGlzLnMub3JpZ2luYWxCYXNlUGF0aCB8fCB0aGlzLnMuYmFzZVBhdGgsXG4gICAgICAgICk/LnByZWZlcmVuY2VzO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgZ2V0Q29sbGFwc2VDYWRlbmNlKHByZWZzKSA9PT0gXCJzbGljZVwiICYmXG4gICAgICAgICAgZ2V0TWlsZXN0b25lUmVzcXVhc2gocHJlZnMpXG4gICAgICAgICkge1xuICAgICAgICAgIGNvbnN0IHJlc3F1YXNoUmVzdWx0ID0gcmVzcXVhc2hNaWxlc3RvbmVPbk1haW4oXG4gICAgICAgICAgICB0aGlzLnMub3JpZ2luYWxCYXNlUGF0aCB8fCB0aGlzLnMuYmFzZVBhdGgsXG4gICAgICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgICAgIHN0YXJ0U2hhLFxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKHJlc3F1YXNoUmVzdWx0LnJlc3F1YXNoZWQpIHtcbiAgICAgICAgICAgIGN0eC5ub3RpZnkoXG4gICAgICAgICAgICAgIGBzbGljZS1jYWRlbmNlOiByZS1zcXVhc2hlZCBzbGljZSBjb21taXRzIGZvciAke21pbGVzdG9uZUlkfSBpbnRvIGEgc2luZ2xlIG1pbGVzdG9uZSBjb21taXQuYCxcbiAgICAgICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICB0aGlzLnMubWlsZXN0b25lU3RhcnRTaGFzLmRlbGV0ZShtaWxlc3RvbmVJZCk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcIm1lcmdlQW5kRXhpdFwiLFxuICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgcGhhc2U6IFwicmVzcXVhc2hcIixcbiAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vICM0NzY0IFx1MjAxNCByZWNvcmQgbWVyZ2UgY29tcGxldGlvbi4gT25seSByZWFjaGVzIGhlcmUgd2hlbiBhbiBhY3R1YWxcbiAgICAvLyBtZXJnZSByYW47IGZhaWx1cmUgcGF0aHMgdGhyb3cgb3V0IGJlZm9yZSB0aGlzIHBvaW50LlxuICAgIHRyeSB7XG4gICAgICBlbWl0V29ya3RyZWVNZXJnZWQoXG4gICAgICAgIHRoaXMucy5vcmlnaW5hbEJhc2VQYXRoIHx8IHRoaXMucy5iYXNlUGF0aCxcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIHtcbiAgICAgICAgICByZWFzb246IFwibWlsZXN0b25lLWNvbXBsZXRlXCIsXG4gICAgICAgICAgc3RhcnRlZEF0OiBtZXJnZVN0YXJ0ZWRBdCxcbiAgICAgICAgICBkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gbWVyZ2VTdGFydE1zLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9IGNhdGNoICh0ZWxlbWV0cnlFcnIpIHtcbiAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICBhY3Rpb246IFwibWVyZ2VBbmRFeGl0XCIsXG4gICAgICAgIHBoYXNlOiBcInRlbGVtZXRyeS1lbWl0XCIsXG4gICAgICAgIGVycm9yOlxuICAgICAgICAgIHRlbGVtZXRyeUVyciBpbnN0YW5jZW9mIEVycm9yXG4gICAgICAgICAgICA/IHRlbGVtZXRyeUVyci5tZXNzYWdlXG4gICAgICAgICAgICA6IFN0cmluZyh0ZWxlbWV0cnlFcnIpLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gTW9kZS1zcGVjaWZpYyBzZXNzaW9uIHJlc3RvcmUuXG4gICAgaWYgKHJlc3VsdC5tb2RlID09PSBcIndvcmt0cmVlXCIpIHtcbiAgICAgIHRoaXMucmVzdG9yZVRvUHJvamVjdFJvb3QoKTtcbiAgICAgIGRlYnVnTG9nKFwiV29ya3RyZWVMaWZlY3ljbGVcIiwge1xuICAgICAgICBhY3Rpb246IFwibWVyZ2VBbmRFeGl0XCIsXG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICByZXN1bHQ6IFwiZG9uZVwiLFxuICAgICAgICBiYXNlUGF0aDogdGhpcy5zLmJhc2VQYXRoLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmIChyZXN1bHQubW9kZSA9PT0gXCJicmFuY2hcIikge1xuICAgICAgLy8gUmVidWlsZCBHaXRTZXJ2aWNlIGFmdGVyIG1lcmdlIChicmFuY2ggSEVBRCBjaGFuZ2VkKVxuICAgICAgcmVidWlsZEdpdFNlcnZpY2UodGhpcy5zLCB0aGlzLmRlcHMpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFJlbW92ZWQ6IF9tZXJnZVdvcmt0cmVlTW9kZSAvIF9tZXJnZUJyYW5jaE1vZGUgYm9kaWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBUaGUgbWVyZ2UgYm9kaWVzIG1vdmVkIHRvIGZpbGUtc2NvcGUgYF9tZXJnZVdvcmt0cmVlTW9kZUltcGxgIGFuZFxuICAvLyBgX21lcmdlQnJhbmNoTW9kZUltcGxgLCBjYWxsYWJsZSBmcm9tIHRoZSBzZXNzaW9uLWxlc3NcbiAgLy8gYG1lcmdlTWlsZXN0b25lU3RhbmRhbG9uZWAgZW50cnkuIFRoZSBwcmV2aW91cyBwcml2YXRlIG1ldGhvZHMgYXJlXG4gIC8vIGdvbmU7IGBfbWVyZ2VBbmRFeGl0YCBhYm92ZSBpcyB0aGUgb25seSBzZXNzaW9uLWJvdW5kIGNhbGxlci5cblxuICAvKipcbiAgICogRmFsbCBiYWNrIHRvIGJyYW5jaC1tb2RlIGZvciBgbWlsZXN0b25lSWRgIGFmdGVyIGEgZmFpbGVkIHdvcmt0cmVlXG4gICAqIGNyZWF0aW9uLCBtYXJraW5nIHRoZSBzZXNzaW9uJ3MgaXNvbGF0aW9uIGFzIGRlZ3JhZGVkLlxuICAgKlxuICAgKiBDdXJyZW50bHkgZGVsZWdhdGVzIHRvIGBlbnRlckJyYW5jaE1vZGVGb3JNaWxlc3RvbmVgIGZyb20gYXV0by13b3JrdHJlZS5cbiAgICogSWRlbXBvdGVudDogc3Vic2VxdWVudCBjYWxscyBpbiBhIGRlZ3JhZGVkIHNlc3Npb24gYXJlIG5vLW9wcy5cbiAgICpcbiAgICogSXNzdWUgIzU1ODcgc2hpcHMgdGhpcyBhcyBhIHRoaW4gYWRhcHRlcjsgdGhlIGJvZHkgZXh0cmFjdGlvbiBqb2lucyB0aGVcbiAgICogb3RoZXIgbWVyZ2UtbG9naWMgbW92ZS1vdXQgaW4gYSBmb2xsb3ctdXAgY2xlYW51cCBzbGljZS5cbiAgICovXG4gIGRlZ3JhZGVUb0JyYW5jaE1vZGUobWlsZXN0b25lSWQ6IHN0cmluZywgY3R4OiBOb3RpZnlDdHgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5zLmlzb2xhdGlvbkRlZ3JhZGVkKSB7XG4gICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcImRlZ3JhZGVUb0JyYW5jaE1vZGVcIixcbiAgICAgICAgbWlsZXN0b25lSWQsXG4gICAgICAgIHNraXBwZWQ6IHRydWUsXG4gICAgICAgIHJlYXNvbjogXCJhbHJlYWR5LWRlZ3JhZGVkXCIsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgYmFzZVBhdGggPSByZXNvbHZlV29ya3RyZWVQcm9qZWN0Um9vdChcbiAgICAgIHRoaXMucy5iYXNlUGF0aCxcbiAgICAgIHRoaXMucy5vcmlnaW5hbEJhc2VQYXRoLFxuICAgICk7XG4gICAgdHJ5IHtcbiAgICAgIGxpZmVjeWNsZUVudGVyQnJhbmNoTW9kZSh0aGlzLmRlcHMsIGJhc2VQYXRoLCBtaWxlc3RvbmVJZCk7XG4gICAgICByZWJ1aWxkR2l0U2VydmljZSh0aGlzLnMsIHRoaXMuZGVwcyk7XG4gICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICB0aGlzLnMuaXNvbGF0aW9uRGVncmFkZWQgPSB0cnVlO1xuICAgICAgY3R4Lm5vdGlmeShcbiAgICAgICAgYFN3aXRjaGVkIHRvIGJyYW5jaCBtaWxlc3RvbmUvJHttaWxlc3RvbmVJZH0gKGlzb2xhdGlvbiBkZWdyYWRlZCkuYCxcbiAgICAgICAgXCJpbmZvXCIsXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgICAgY3R4Lm5vdGlmeShcbiAgICAgICAgYEJyYW5jaCBpc29sYXRpb24gc2V0dXAgZm9yICR7bWlsZXN0b25lSWR9IGZhaWxlZDogJHttc2d9LiBDb250aW51aW5nIG9uIGN1cnJlbnQgYnJhbmNoLmAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICAgIHRoaXMucy5pc29sYXRpb25EZWdyYWRlZCA9IHRydWU7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJlc3RvcmUgYHMuYmFzZVBhdGhgIHRvIGBzLm9yaWdpbmFsQmFzZVBhdGhgLCBjaGRpciBwcm9jZXNzIGN3ZCwgYW5kXG4gICAqIHJlYnVpbGQgYHMuZ2l0U2VydmljZWAuIE5vLW9wIHdoZW4gYG9yaWdpbmFsQmFzZVBhdGhgIGlzIGVtcHR5IChmcmVzaFxuICAgKiBzZXNzaW9ucykuXG4gICAqXG4gICAqIFVzZWQgYnkgZXJyb3IvY2xlYW51cCBwYXRocyB0aGF0IG5lZWQgdGhlIHNlc3Npb24gdG8gYmVoYXZlIGFzIGlmIHRoZVxuICAgKiB3b3JrdHJlZSB3YXMgbmV2ZXIgZW50ZXJlZC4gRG9lcyBOT1QgdGVhcmRvd24gdGhlIHdvcmt0cmVlIGRpcmVjdG9yeSBcdTIwMTRcbiAgICogY2FsbGVycyB0aGF0IG5lZWQgdGVhcmRvd24gZ28gdGhyb3VnaCBgZXhpdE1pbGVzdG9uZSh7IG1lcmdlOiBmYWxzZSB9KWAuXG4gICAqXG4gICAqIEFEUi0wMTYgcGhhc2UgMyAoIzU2OTMpOiBjaGRpciBsaXZlcyBpbnNpZGUgdGhlIHZlcmIgc28gY2FsbGVycyBkbyBub3RcbiAgICogcGFpciBgcmVzdG9yZVRvUHJvamVjdFJvb3QoKWAgd2l0aCBhIHJlZHVuZGFudCBgcHJvY2Vzcy5jaGRpcmAuIFRoZVxuICAgKiBjaGRpciBydW5zIEJFRk9SRSB0aGUgdGhyb3dhYmxlIHdvcmsgKGByZWJ1aWxkR2l0U2VydmljZWAsIGNhY2hlXG4gICAqIGludmFsaWRhdGlvbikgc28gdGhhdCBjbGVhbnVwLXBhdGggY3dkIGlzIHJlc3RvcmVkIGV2ZW4gaWYgdGhlXG4gICAqIGRvd25zdHJlYW0gcmVidWlsZCB0aHJvd3MuIFRoZSBjaGRpciBpdHNlbGYgaXMgYmVzdC1lZmZvcnQ7IGZhaWx1cmUgaXNcbiAgICogbG9nZ2VkIHZpYSBkZWJ1Z0xvZyBhbmQgc3dhbGxvd2VkLlxuICAgKi9cbiAgcmVzdG9yZVRvUHJvamVjdFJvb3QoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnMub3JpZ2luYWxCYXNlUGF0aCkgcmV0dXJuO1xuICAgIHRoaXMucy5iYXNlUGF0aCA9IHRoaXMucy5vcmlnaW5hbEJhc2VQYXRoO1xuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmNoZGlyKHRoaXMucy5iYXNlUGF0aCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgYWN0aW9uOiBcInJlc3RvcmVUb1Byb2plY3RSb290XCIsXG4gICAgICAgIHJlc3VsdDogXCJjaGRpci1mYWlsZWRcIixcbiAgICAgICAgYmFzZVBhdGg6IHRoaXMucy5iYXNlUGF0aCxcbiAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZWJ1aWxkR2l0U2VydmljZSh0aGlzLnMsIHRoaXMuZGVwcyk7XG4gICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICB9XG5cbiAgLyoqXG4gICAqIEFkb3B0IGEgc2Vzc2lvbiByb290IChBRFItMDE2IHBoYXNlIDIgLyBCMiwgaXNzdWUgIzU2MjApLlxuICAgKlxuICAgKiBTb2xlIG93bmVyIG9mIGBzLmJhc2VQYXRoYCBtdXRhdGlvbiBmb3IgYm9vdHN0cmFwLWNsYXNzIHRyYW5zaXRpb25zOlxuICAgKiBpbml0aWFsIHNlc3Npb24gc3RhcnQsIHBhdXNlZC1yZXN1bWUgZW50cnkgKGJlZm9yZSBwZXJzaXN0ZWQtc3RhdGVcbiAgICogY29uc3VsdGF0aW9uKSwgYW5kIGhvb2stdHJpZ2dlciBzZXNzaW9uIGFjdGl2YXRpb24uIERlZmVuc2l2ZSBhYm91dFxuICAgKiBgcy5vcmlnaW5hbEJhc2VQYXRoYDpcbiAgICpcbiAgICogLSBXaGVuIGBvcmlnaW5hbEJhc2VgIGlzIGV4cGxpY2l0OiBvdmVyd3JpdGUuXG4gICAqIC0gT3RoZXJ3aXNlLCBzZXQgYHMub3JpZ2luYWxCYXNlUGF0aGAgb25seSBpZiBpdCBpcyBjdXJyZW50bHkgZW1wdHkgXHUyMDE0XG4gICAqICAgcmVzdW1lIHBhdGhzIHRoYXQgYWxyZWFkeSByZXN0b3JlZCBgcy5vcmlnaW5hbEJhc2VQYXRoYCBmcm9tIHBhdXNlZFxuICAgKiAgIG1ldGFkYXRhIGtlZXAgdGhlaXIgdmFsdWUuXG4gICAqXG4gICAqIERvZXMgTk9UIGNoZGlyOyBjYWxsZXJzIHRoYXQgbmVlZCBjd2QgYWxpZ25tZW50IHdpdGggdGhlIG5ldyBiYXNlUGF0aFxuICAgKiBhcmUgcmVzcG9uc2libGUgZm9yIGl0LiBEb2VzIE5PVCByZWJ1aWxkIGBzLmdpdFNlcnZpY2VgIFx1MjAxNCBjYWxsZXJzIHRoYXRcbiAgICogbXV0YXRlIGBzLmJhc2VQYXRoYCB0byBhIG5vbi1wcm9qZWN0LXJvb3QgcGF0aCAoZS5nLiBhIHdvcmt0cmVlIG9uIGFcbiAgICogc3Vic2VxdWVudCBtaWxlc3RvbmUgZW50ZXIpIGdvIHRocm91Z2ggYGVudGVyTWlsZXN0b25lYCwgd2hpY2ggaGFuZGxlc1xuICAgKiB0aGUgcmVidWlsZC5cbiAgICovXG4gIGFkb3B0U2Vzc2lvblJvb3QoYmFzZTogc3RyaW5nLCBvcmlnaW5hbEJhc2U/OiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLnMuYmFzZVBhdGggPSBiYXNlO1xuICAgIGlmIChvcmlnaW5hbEJhc2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhpcy5zLm9yaWdpbmFsQmFzZVBhdGggPSBvcmlnaW5hbEJhc2U7XG4gICAgfSBlbHNlIGlmICghdGhpcy5zLm9yaWdpbmFsQmFzZVBhdGgpIHtcbiAgICAgIHRoaXMucy5vcmlnaW5hbEJhc2VQYXRoID0gYmFzZTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmVzdW1lIGZyb20gYSBwYXVzZWQgc2Vzc2lvbiAoQURSLTAxNiBwaGFzZSAyIC8gQjMsIGlzc3VlICM1NjIxKS5cbiAgICpcbiAgICogQWRvcHRzIGBwZXJzaXN0ZWRXb3JrdHJlZVBhdGhgIGFzIGBzLmJhc2VQYXRoYCB3aGVuIHRoZSBwYXRoIGlzXG4gICAqIG5vbi1udWxsIGFuZCBleGlzdHMgb24gZGlzazsgb3RoZXJ3aXNlIGZhbGxzIGJhY2sgdG8gYGJhc2VgLiBNaXJyb3JzXG4gICAqIHRoZSByZXN1bWUgZ3VhcmQgYXQgYGF1dG8udHM6MjE2NGAgXHUyMDE0IGEgc3RhbGUgb3IgcmVtb3ZlZCB3b3JrdHJlZVxuICAgKiBkaXJlY3RvcnkgbXVzdCBub3Qgc3RyYW5kIHRoZSByZXN1bWVkIHNlc3Npb24gaW4gYW4gaW52YWxpZCByb290LlxuICAgKlxuICAgKiBGb2xkcyBpbiB0aGUgYm9keSBvZiB0aGUgbGVnYWN5IGBfcmVzb2x2ZVBhdXNlZFJlc3VtZUJhc2VQYXRoRm9yVGVzdGBcbiAgICogaGVscGVyIChzZWUgYHJlc29sdmVQYXVzZWRSZXN1bWVCYXNlUGF0aGAgYmVsb3cpLiBBZnRlciB0aGlzIHZlcmJcbiAgICogbGFuZHMgdGhlIGhlbHBlciBpcyBkZWxldGVkIGZyb20gYGF1dG8udHNgIHBlciB0aGUgc2xpY2UtNyBjbG9zdXJlXG4gICAqIGRlY2lzaW9uIHRvIHJldGlyZSBgXypGb3JUZXN0YCBzdWZmaXhlcyBmcm9tIHByb2R1Y3Rpb24gcGF0aHMuXG4gICAqXG4gICAqIExpa2UgYGFkb3B0U2Vzc2lvblJvb3RgLCB0aGlzIGlzIGEgcHVyZSBzZXNzaW9uLXN0YXRlIG11dGF0aW9uIFx1MjAxNCBub1xuICAgKiBjaGRpciwgbm8gZ2l0IHNlcnZpY2UgcmVidWlsZCwgbm8gY2FjaGUgaW52YWxpZGF0aW9uLlxuICAgKi9cbiAgcmVzdW1lRnJvbVBhdXNlZFNlc3Npb24oXG4gICAgYmFzZTogc3RyaW5nLFxuICAgIHBlcnNpc3RlZFdvcmt0cmVlUGF0aDogc3RyaW5nIHwgbnVsbCxcbiAgKTogdm9pZCB7XG4gICAgdGhpcy5zLmJhc2VQYXRoID0gcmVzb2x2ZVBhdXNlZFJlc3VtZUJhc2VQYXRoKGJhc2UsIHBlcnNpc3RlZFdvcmt0cmVlUGF0aCk7XG4gIH1cblxuICAvKipcbiAgICogQWRvcHQgYW4gb3JwaGFuIHdvcmt0cmVlIGZvciBhIGJvb3RzdHJhcC10aW1lIG1lcmdlIChBRFItMDE2IHBoYXNlIDIgLyBCNCxcbiAgICogaXNzdWUgIzU2MjIpLlxuICAgKlxuICAgKiBPd25zIHRoZSBzd2FwLXJ1bi1yZXZlcnQgcHJvdG9jb2wgdGhhdCBib290c3RyYXAgcHJldmlvdXNseSBvcGVuLWNvZGVkOlxuICAgKlxuICAgKiAgIDEuIFNuYXBzaG90IHByaW9yIGBzLmJhc2VQYXRoYCBhbmQgYHMub3JpZ2luYWxCYXNlUGF0aGAuXG4gICAqICAgMi4gUmVzb2x2ZSBgZ2V0QXV0b1dvcmt0cmVlUGF0aChiYXNlLCBtaWxlc3RvbmVJZCkgPz8gYmFzZWAgYmVmb3JlXG4gICAqICAgICAgbXV0YXRpbmcgc2Vzc2lvbiBzdGF0ZSwgdGhlbiBzZXQgYHMub3JpZ2luYWxCYXNlUGF0aCA9IGJhc2VgIGFuZFxuICAgKiAgICAgIGBzLmJhc2VQYXRoYCB0byB0aGUgcmVzb2x2ZWQgcGF0aC5cbiAgICogICAzLiBJbnZva2UgdGhlIGNhbGxlci1zdXBwbGllZCBgcnVuYCBjYWxsYmFjayB1bmRlciB0aGUgc3dhcC5cbiAgICogICA0LiBPbiBgIXJlc3VsdC5tZXJnZWRgOiByZXZlcnQgdG8gYGJhc2VgIGFuZCBgY2hkaXIoYmFzZSlgIHNvIHRoZVxuICAgKiAgICAgIGNhbGxlciBjYW4gcmV0dXJuIGVhcmx5IHdpdGhvdXQgbGVhdmluZyB0aGUgc2Vzc2lvbiBpbiBhIGhhbGYtXG4gICAqICAgICAgc3dhcHBlZCBzdGF0ZS5cbiAgICogICA1LiBPbiBgcmVzdWx0Lm1lcmdlZCAmJiAhcy5hY3RpdmVgOiByZXZlcnQgdG8gdGhlIHNuYXBzaG90dGVkIHByaW9yXG4gICAqICAgICAgcGF0aHMgKHRoZSBvcnBoYW4gbWVyZ2Ugc3VjY2VlZGVkIGJ1dCBib290c3RyYXAgY2hvc2Ugbm90IHRvIGtlZXBcbiAgICogICAgICB0aGUgc2Vzc2lvbiBhY3RpdmUpLlxuICAgKiAgIDYuIE9uIGByZXN1bHQubWVyZ2VkICYmIHMuYWN0aXZlYDogbGVhdmUgdGhlIHN3YXAgaW4gcGxhY2UgXHUyMDE0IHRoZVxuICAgKiAgICAgIGxvb3Agd2lsbCBjb250aW51ZSBmcm9tIHRoZSB3b3JrdHJlZSBwYXRoLlxuICAgKlxuICAgKiBUaGUgY2FsbGJhY2sgc2hhcGUgZm9yY2VzIGV2ZXJ5IGNhbGxlciB0aHJvdWdoIHRoZSBzYW1lIHJldmVydFxuICAgKiBwcm90b2NvbDsgYW4gb3Blbi1jb2RlZCBzd2FwIHRoYXQgZm9yZ2V0cyB0byByZXZlcnQgb24gZmFpbHVyZSB3YXMgdGhlXG4gICAqIG9yaWdpbmFsIGJ1ZyBwYXR0ZXJuIHRoaXMgdmVyYiBpcyBkZXNpZ25lZCB0byBwcmV2ZW50LlxuICAgKi9cbiAgYWRvcHRPcnBoYW5Xb3JrdHJlZTxUIGV4dGVuZHMgeyBtZXJnZWQ6IGJvb2xlYW4gfT4oXG4gICAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgICBiYXNlOiBzdHJpbmcsXG4gICAgcnVuOiAoKSA9PiBULFxuICApOiBUIHtcbiAgICB2YWxpZGF0ZU1pbGVzdG9uZUlkKG1pbGVzdG9uZUlkKTtcblxuICAgIGNvbnN0IHByaW9yQmFzZVBhdGggPSB0aGlzLnMuYmFzZVBhdGg7XG4gICAgY29uc3QgcHJpb3JPcmlnaW5hbEJhc2VQYXRoID0gdGhpcy5zLm9yaWdpbmFsQmFzZVBhdGg7XG4gICAgY29uc3QgcmVzdG9yZVByaW9yUGF0aHMgPSAocGhhc2U6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgICAgdGhpcy5zLmJhc2VQYXRoID0gcHJpb3JCYXNlUGF0aCB8fCBiYXNlO1xuICAgICAgdGhpcy5zLm9yaWdpbmFsQmFzZVBhdGggPSBwcmlvck9yaWdpbmFsQmFzZVBhdGggfHwgYmFzZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHByb2Nlc3MuY2hkaXIodGhpcy5zLm9yaWdpbmFsQmFzZVBhdGggfHwgYmFzZSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgZGVidWdMb2coXCJXb3JrdHJlZUxpZmVjeWNsZVwiLCB7XG4gICAgICAgICAgYWN0aW9uOiBcImFkb3B0T3JwaGFuV29ya3RyZWVcIixcbiAgICAgICAgICBwaGFzZSxcbiAgICAgICAgICBiYXNlOiB0aGlzLnMub3JpZ2luYWxCYXNlUGF0aCB8fCBiYXNlLFxuICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBsZXQgYWRvcHRlZEJhc2VQYXRoOiBzdHJpbmc7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHd0UGF0aEZuID1cbiAgICAgICAgcHJpbWl0aXZlT3ZlcnJpZGVzKHRoaXMuZGVwcykuZ2V0QXV0b1dvcmt0cmVlUGF0aCA/PyBnZXRBdXRvV29ya3RyZWVQYXRoO1xuICAgICAgYWRvcHRlZEJhc2VQYXRoID0gd3RQYXRoRm4oYmFzZSwgbWlsZXN0b25lSWQpID8/IGJhc2U7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZXN0b3JlUHJpb3JQYXRocyhcInJvbGxiYWNrLXJlc29sdmUtd29ya3RyZWUtZmFpbGVkXCIpO1xuICAgICAgdGhyb3cgZXJyO1xuICAgIH1cblxuICAgIC8vIFN3YXAgaW50byB0aGUgb3JwaGFuIHdvcmt0cmVlLlxuICAgIHRoaXMucy5vcmlnaW5hbEJhc2VQYXRoID0gYmFzZTtcbiAgICB0aGlzLnMuYmFzZVBhdGggPSBhZG9wdGVkQmFzZVBhdGg7XG5cbiAgICBsZXQgcmVzdWx0OiBUO1xuICAgIHRyeSB7XG4gICAgICByZXN1bHQgPSBydW4oKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIHJlc3RvcmVQcmlvclBhdGhzKFwicm9sbGJhY2stcnVuLWZhaWxlZFwiKTtcbiAgICAgIHRocm93IGVycjtcbiAgICB9XG5cbiAgICBpZiAoIXJlc3VsdC5tZXJnZWQpIHtcbiAgICAgIC8vIEZhaWxlZCBvcnBoYW4gbWVyZ2UgXHUyMDE0IHJldmVydCB0byBwcm9qZWN0IHJvb3Qgc28gdGhlIGNhbGxlciBjYW5cbiAgICAgIC8vIHNhZmVseSByZXR1cm4gZWFybHkgd2l0aG91dCBsZWF2aW5nIHRoZSBzZXNzaW9uIGluIGFuIGludmFsaWRcbiAgICAgIC8vIGJhc2VQYXRoLiBNaXJyb3IgdGhlIGNoZGlyIHRoYXQgYm9vdHN0cmFwIHBlcmZvcm1lZCBpbmxpbmUuXG4gICAgICB0aGlzLnMuYmFzZVBhdGggPSBiYXNlO1xuICAgICAgdGhpcy5zLm9yaWdpbmFsQmFzZVBhdGggPSBiYXNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcHJvY2Vzcy5jaGRpcihiYXNlKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBkZWJ1Z0xvZyhcIldvcmt0cmVlTGlmZWN5Y2xlXCIsIHtcbiAgICAgICAgICBhY3Rpb246IFwiYWRvcHRPcnBoYW5Xb3JrdHJlZVwiLFxuICAgICAgICAgIHBoYXNlOiBcInJldmVydC1jaGRpci1mYWlsZWRcIixcbiAgICAgICAgICBiYXNlLFxuICAgICAgICAgIGVycm9yOiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMucy5hY3RpdmUpIHtcbiAgICAgIC8vIE1lcmdlIHN1Y2NlZWRlZCBidXQgdGhlIHNlc3Npb24gd2FzIG5vdCAocmUpYWN0aXZhdGVkIFx1MjAxNCByZXN0b3JlXG4gICAgICAvLyB0aGUgc25hcHNob3R0ZWQgcGF0aHMgc28gdGhlIGNhbGxpbmcgY29udGV4dCByZXN1bWVzIHdoZXJlIGl0XG4gICAgICAvLyB3YXMsIHdpdGggdGhlIG9ycGhhbiBicmFuY2ggbm93IG1lcmdlZCBvbiBtYWluLlxuICAgICAgdGhpcy5zLmJhc2VQYXRoID0gcHJpb3JCYXNlUGF0aCB8fCBiYXNlO1xuICAgICAgdGhpcy5zLm9yaWdpbmFsQmFzZVBhdGggPSBwcmlvck9yaWdpbmFsQmFzZVBhdGggfHwgYmFzZTtcbiAgICB9XG4gICAgLy8gZWxzZTogbWVyZ2VkICYmIGFjdGl2ZSBcdTIwMTQgbGVhdmUgdGhlIHN3YXA7IHRoZSBsb29wIGNvbnRpbnVlcyBmcm9tXG4gICAgLy8gdGhlIHdvcmt0cmVlIHBhdGguIFN1YnNlcXVlbnQgbWlsZXN0b25lIGVudGVycyBtdXRhdGUgYHMuYmFzZVBhdGhgXG4gICAgLy8gdGhyb3VnaCB0aGVpciBvd24gTGlmZWN5Y2xlIHZlcmJzLlxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8qKiBUcnVlIGlmIGBtaWxlc3RvbmVJZGAgaXMgdGhlIHNlc3Npb24ncyBjdXJyZW50bHktYWN0aXZlIG1pbGVzdG9uZS4gKi9cbiAgaXNJbk1pbGVzdG9uZShtaWxlc3RvbmVJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMucy5jdXJyZW50TWlsZXN0b25lSWQgPT09IG1pbGVzdG9uZUlkO1xuICB9XG5cbiAgLyoqIFRoZSBhY3RpdmUgbWlsZXN0b25lIGlkLCBvciBgbnVsbGAgaWYgbm8gbWlsZXN0b25lIGlzIGFjdGl2ZS4gKi9cbiAgZ2V0Q3VycmVudE1pbGVzdG9uZUlmQW55KCk6IHN0cmluZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLnMuY3VycmVudE1pbGVzdG9uZUlkO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFt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
