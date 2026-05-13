import { deriveState } from "./state.js";
import { loadFile, getManifestStatus } from "./files.js";
import {
  loadEffectiveGSDPreferences,
  resolveSkillDiscoveryMode,
  getIsolationMode
} from "./preferences.js";
import { ensureGsdSymlink, isInheritedRepo, validateProjectId } from "./repo-identity.js";
import { migrateToExternalState, recoverFailedMigration } from "./migrate-external.js";
import { collectSecretsFromManifest } from "../get-secrets-from-user.js";
import { gsdRoot, resolveMilestoneFile } from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { writeLock, clearLock } from "./crash-recovery.js";
import {
  acquireSessionLock,
  releaseSessionLock,
  updateSessionLock
} from "./session-lock.js";
import { ensureGitignore, untrackRuntimeFiles } from "./gitignore.js";
import {
  nativeIsRepo,
  nativeInit,
  nativeAddAll,
  nativeCommit,
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeCheckoutBranch,
  nativeBranchList,
  nativeBranchExists,
  nativeBranchListMerged,
  nativeBranchDelete,
  nativeWorktreeRemove,
  nativeCommitCountBetween
} from "./native-git-bridge.js";
import { GitServiceImpl } from "./git-service.js";
import {
  captureIntegrationBranch,
  detectWorktreeName,
  setActiveMilestoneId
} from "./worktree.js";
import { getAutoWorktreePath } from "./auto-worktree.js";
import { readResourceVersion, cleanStaleRuntimeUnits } from "./auto-worktree.js";
import { worktreePath as getWorktreeDir, isInsideWorktreesDir } from "./worktree-manager.js";
import { emitWorktreeOrphaned } from "./worktree-telemetry.js";
import { initMetrics } from "./metrics.js";
import { initRoutingHistory } from "./routing-history.js";
import { restoreHookState, resetHookState } from "./post-unit-hooks.js";
import { resetProactiveHealing, setLevelChangeCallback } from "./doctor-proactive.js";
import { snapshotSkills } from "./skill-discovery.js";
import { isDbAvailable, getMilestone, getAllMilestones, openDatabase, getDbStatus } from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { classifyMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import { auditOrphanedPreflightStashes } from "./orphan-stash-audit.js";
import {
  debugLog,
  enableDebug,
  isDebugEnabled,
  getDebugLogPath
} from "./debug-logger.js";
import { logWarning, logError } from "./workflow-logger.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { join } from "node:path";
import { sep as pathSep } from "node:path";
import { resolveProjectRootDbPath } from "./bootstrap/dynamic-tools.js";
import { validateDirectory } from "./validate-directory.js";
import {
  isCustomProvider,
  resolveDefaultSessionModel,
  resolveDynamicRoutingConfig
} from "./preferences-models.js";
import { getSessionModelOverride } from "./session-model-override.js";
function resolveIsolationNoneBranchCheckout(currentBranch, integrationBranch, isolationMode, isRepo) {
  if (!isRepo || isolationMode !== "none") return null;
  return currentBranch.startsWith("milestone/") ? integrationBranch : null;
}
const MAX_CONSECUTIVE_COMPLETE_BOOTSTRAPS = 2;
function hasGitIndexLockForTest(basePath) {
  return existsSync(join(basePath, ".git", "index.lock"));
}
function _shouldAbortBootstrapForUnavailableDbForTest(gsdDbPath, dbAvailable, pathExists = existsSync) {
  return pathExists(gsdDbPath) && !dbAvailable;
}
async function openProjectDbIfPresent(basePath) {
  const gsdDbPath = resolveProjectRootDbPath(basePath);
  if (!existsSync(gsdDbPath) || isDbAvailable()) return;
  try {
    openDatabase(gsdDbPath);
  } catch (err) {
    logWarning("engine", `gsd-db: failed to open existing database: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function decideSurvivorAction(hasSurvivorBranch, phase) {
  if (!hasSurvivorBranch) return "none";
  if (phase === "needs-discussion") return "discuss";
  if (phase === "complete") return "finalize";
  return "none";
}
function auditOrphanedMilestoneBranches(basePath, isolationMode, gitDeps = {}) {
  const recovered = [];
  const warnings = [];
  const branchList = gitDeps.branchList ?? nativeBranchList;
  const branchExists = gitDeps.branchExists ?? nativeBranchExists;
  if (isolationMode === "none") return { recovered, warnings };
  if (!isDbAvailable()) return { recovered, warnings };
  let milestoneBranches;
  let milestoneBranchListAvailable = true;
  try {
    milestoneBranches = branchList(basePath, "milestone/*");
  } catch {
    milestoneBranchListAvailable = false;
    milestoneBranches = [];
  }
  let mainBranch;
  try {
    mainBranch = nativeDetectMainBranch(basePath);
  } catch {
    mainBranch = "main";
  }
  let mergedBranches;
  try {
    mergedBranches = new Set(nativeBranchListMerged(basePath, mainBranch, "milestone/*"));
  } catch {
    mergedBranches = /* @__PURE__ */ new Set();
  }
  for (const branch of milestoneBranches) {
    const milestoneId = branch.replace(/^milestone\//, "");
    const milestone = getMilestone(milestoneId);
    if (!milestone) continue;
    const isMerged = mergedBranches.has(branch);
    if (!isClosedStatus(milestone.status)) {
      if (isMerged) continue;
      let commitsAhead = 0;
      try {
        commitsAhead = nativeCommitCountBetween(basePath, mainBranch, branch);
      } catch {
        continue;
      }
      if (commitsAhead === 0) continue;
      const wtDir = getWorktreeDir(basePath, milestoneId);
      const wtDirExists = existsSync(wtDir);
      const wtSuffix = wtDirExists ? ` Worktree directory at .gsd/worktrees/${milestoneId}/ holds the live work.` : "";
      warnings.push(
        `Branch ${branch} has ${commitsAhead} commit(s) ahead of ${mainBranch} for in-progress milestone ${milestoneId}.` + wtSuffix + ` Run \`/gsd auto\` to resume, or merge manually if abandoning.`
      );
      try {
        emitWorktreeOrphaned(basePath, milestoneId, {
          reason: "in-progress-unmerged",
          commitsAhead,
          worktreeDirExists: wtDirExists
        });
      } catch (err) {
        logWarning("engine", `worktree-orphaned telemetry failed for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (milestone.status !== "complete") continue;
    if (isMerged) {
      try {
        nativeBranchDelete(basePath, branch, true);
        recovered.push(`Deleted merged branch ${branch} for completed milestone ${milestoneId}.`);
      } catch (err) {
        warnings.push(`Failed to delete merged branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const wtDir = getWorktreeDir(basePath, milestoneId);
      if (existsSync(wtDir)) {
        try {
          nativeWorktreeRemove(basePath, wtDir, true);
        } catch (e) {
          logWarning("engine", `worktree remove failed (expected for orphaned dirs): ${e instanceof Error ? e.message : String(e)}`);
        }
        if (existsSync(wtDir)) {
          if (isInsideWorktreesDir(basePath, wtDir)) {
            try {
              rmSync(wtDir, { recursive: true, force: true });
              recovered.push(`Removed orphaned worktree directory for ${milestoneId}.`);
            } catch (err2) {
              warnings.push(`Failed to remove worktree directory for ${milestoneId}: ${err2 instanceof Error ? err2.message : String(err2)}`);
            }
          } else {
            warnings.push(`Orphaned worktree directory for ${milestoneId} is outside .gsd/worktrees/ \u2014 skipping removal for safety.`);
          }
        } else {
          recovered.push(`Removed orphaned worktree directory for ${milestoneId}.`);
        }
      }
    } else {
      warnings.push(
        `Branch ${branch} exists for completed milestone ${milestoneId} but is NOT merged into ${mainBranch}. This may contain unmerged work. Merge manually or run \`/gsd doctor fix\` to resolve.`
      );
      try {
        emitWorktreeOrphaned(basePath, milestoneId, {
          reason: "complete-unmerged",
          worktreeDirExists: existsSync(getWorktreeDir(basePath, milestoneId))
        });
      } catch (err) {
        logWarning("engine", `worktree-orphaned telemetry failed for ${milestoneId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const seenMilestoneIds = new Set(
    milestoneBranches.map((branch) => branch.replace(/^milestone\//, ""))
  );
  let completedMilestones = [];
  try {
    completedMilestones = getAllMilestones();
  } catch {
    completedMilestones = [];
  }
  for (const m of completedMilestones) {
    if (m.status !== "complete") continue;
    if (seenMilestoneIds.has(m.id)) continue;
    if (!milestoneBranchListAvailable) {
      try {
        if (branchExists(basePath, `milestone/${m.id}`)) continue;
      } catch (err) {
        warnings.push(
          `Could not verify whether milestone/${m.id} still exists; skipping branch-less worktree cleanup for safety: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
    }
    const wtDir = getWorktreeDir(basePath, m.id);
    if (!existsSync(wtDir)) continue;
    if (!isInsideWorktreesDir(basePath, wtDir)) {
      warnings.push(
        `Orphaned worktree directory for ${m.id} is outside .gsd/worktrees/ \u2014 skipping removal for safety.`
      );
      continue;
    }
    try {
      nativeWorktreeRemove(basePath, wtDir, true);
    } catch (e) {
      logWarning(
        "engine",
        `worktree remove failed (expected for branch-less orphans): ${e instanceof Error ? e.message : String(e)}`
      );
    }
    if (existsSync(wtDir)) {
      try {
        rmSync(wtDir, { recursive: true, force: true });
        recovered.push(`Removed orphaned worktree directory for ${m.id} (branch already deleted).`);
      } catch (err) {
        warnings.push(
          `Failed to remove orphaned worktree directory for ${m.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      recovered.push(`Removed orphaned worktree directory for ${m.id} (branch already deleted).`);
    }
  }
  return { recovered, warnings };
}
function _selectResumableMilestone(branchNames, mergedBranches, isComplete, commitsAhead) {
  const candidates = [];
  for (const branch of branchNames) {
    if (!branch.startsWith("milestone/")) continue;
    const milestoneId = branch.slice("milestone/".length);
    if (mergedBranches.has(branch)) continue;
    if (!isComplete(milestoneId)) continue;
    let ahead = 0;
    try {
      ahead = commitsAhead(branch);
    } catch {
      continue;
    }
    if (ahead <= 0) continue;
    candidates.push(milestoneId);
  }
  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[candidates.length - 1];
}
function findUnmergedCompletedMilestone(basePath, isolationMode) {
  if (isolationMode === "none") return null;
  if (!isDbAvailable()) return null;
  let milestoneBranches;
  try {
    milestoneBranches = nativeBranchList(basePath, "milestone/*");
  } catch {
    return null;
  }
  if (milestoneBranches.length === 0) return null;
  let mainBranch;
  try {
    mainBranch = nativeDetectMainBranch(basePath);
  } catch {
    mainBranch = "main";
  }
  let mergedBranches;
  try {
    mergedBranches = new Set(
      nativeBranchListMerged(basePath, mainBranch, "milestone/*")
    );
  } catch {
    mergedBranches = /* @__PURE__ */ new Set();
  }
  return _selectResumableMilestone(
    milestoneBranches,
    mergedBranches,
    (milestoneId) => {
      const row = getMilestone(milestoneId);
      return !!row && row.status === "complete";
    },
    (branch) => nativeCommitCountBetween(basePath, mainBranch, branch)
  );
}
function _finalizeSurvivorBranch(lifecycle, milestoneId, ui) {
  ui.notify(
    `Milestone ${milestoneId} is complete but branch/worktree was not finalized. Running merge now.`,
    "info"
  );
  const result = lifecycle.exitMilestone(
    milestoneId,
    { merge: true },
    { notify: ui.notify.bind(ui) }
  );
  if (result.ok) return { merged: true };
  const err = result.cause instanceof Error ? result.cause : new Error(String(result.cause));
  const msg = err.message;
  ui.notify(
    `Survivor-branch finalization for ${milestoneId} failed: ${msg}. Resolve manually and re-run /gsd auto.`,
    "error"
  );
  return { merged: false, error: err };
}
function _mergeOrphanCompletedMilestone(lifecycle, orphanId, ui) {
  ui.notify(`Detected unmerged completed milestone ${orphanId}. Merging now.`, "info");
  const result = lifecycle.exitMilestone(
    orphanId,
    { merge: true },
    { notify: ui.notify.bind(ui) }
  );
  if (result.ok) return { merged: true };
  const err = result.cause instanceof Error ? result.cause : new Error(String(result.cause));
  const msg = err.message;
  ui.notify(
    `Could not merge orphan milestone ${orphanId}: ${msg}. Resolve manually and re-run /gsd auto.`,
    "warning"
  );
  return { merged: false, error: err };
}
async function bootstrapAutoSession(s, ctx, pi, base, verboseMode, requestedStepMode, deps, interrupted) {
  const {
    shouldUseWorktreeIsolation,
    registerSigtermHandler,
    registerAutoWorkerForSession,
    lockBase,
    buildLifecycle
  } = deps;
  const dirCheck = validateDirectory(base);
  if (dirCheck.severity === "blocked") {
    ctx.ui.notify(dirCheck.reason, "error");
    return false;
  }
  const lockResult = acquireSessionLock(base);
  if (!lockResult.acquired) {
    ctx.ui.notify(lockResult.reason, "error");
    return false;
  }
  function releaseLockAndReturn() {
    releaseSessionLock(base);
    clearLock(base);
    return false;
  }
  const manualSessionOverride = getSessionModelOverride(ctx.sessionManager.getSessionId());
  const sessionProviderIsCustom = isCustomProvider(ctx.model?.provider);
  const preferredModel = sessionProviderIsCustom ? null : resolveDefaultSessionModel(ctx.model?.provider);
  let validatedPreferredModel;
  if (preferredModel) {
    const { resolveModelId } = await import("./auto-model-selection.js");
    const available = ctx.modelRegistry.getAvailable();
    const match = resolveModelId(
      `${preferredModel.provider}/${preferredModel.id}`,
      available,
      ctx.model?.provider
    );
    if (match) {
      validatedPreferredModel = { provider: match.provider, id: match.id };
    } else {
      ctx.ui.notify(
        `Preferred model ${preferredModel.provider}/${preferredModel.id} from PREFERENCES.md is not configured; falling back to session default.`,
        "warning"
      );
    }
  }
  const sessionModelReady = ctx.model && ctx.modelRegistry.isProviderRequestReady(ctx.model.provider);
  const currentSessionModel = sessionModelReady && ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
  const startThinkingSnapshot = pi.getThinkingLevel();
  const startModelSnapshot = manualSessionOverride ?? currentSessionModel ?? validatedPreferredModel ?? null;
  try {
    const customProjectId = process.env.GSD_PROJECT_ID;
    if (customProjectId && !validateProjectId(customProjectId)) {
      ctx.ui.notify(
        `GSD_PROJECT_ID must contain only alphanumeric characters, hyphens, and underscores. Got: "${customProjectId}"`,
        "error"
      );
      return releaseLockAndReturn();
    }
    const gitLockFile = join(base, ".git", "index.lock");
    if (existsSync(gitLockFile)) {
      ctx.ui.notify(
        "Git index lock is present at .git/index.lock. Another git process may be running; resolve the lock before starting GSD.",
        "error"
      );
      debugLog("git-index-lock-present-preflight", { path: gitLockFile });
      return releaseLockAndReturn();
    }
    const hasLocalGit = existsSync(join(base, ".git"));
    if (!hasLocalGit || isInheritedRepo(base)) {
      const mainBranch = loadEffectiveGSDPreferences(base)?.preferences?.git?.main_branch || "main";
      nativeInit(base, mainBranch);
    }
    recoverFailedMigration(base);
    const migration = migrateToExternalState(base);
    if (migration.error) {
      ctx.ui.notify(`External state migration warning: ${migration.error}`, "warning");
    }
    ensureGsdSymlink(base);
    const gitPrefs = loadEffectiveGSDPreferences(base)?.preferences?.git;
    const manageGitignore = gitPrefs?.manage_gitignore;
    ensureGitignore(base, { manageGitignore });
    if (manageGitignore !== false) untrackRuntimeFiles(base);
    const gsdDir = join(base, ".gsd");
    const milestonesPath = join(gsdDir, "milestones");
    if (!existsSync(milestonesPath)) {
      mkdirSync(milestonesPath, { recursive: true });
      try {
        nativeAddAll(base);
        nativeCommit(base, "chore: init gsd");
      } catch (err) {
        logWarning("engine", `mkdir failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    {
      const { prepareWorkflowMcpForProject } = await import("./workflow-mcp-auto-prep.js");
      prepareWorkflowMcpForProject(ctx, base);
    }
    s.gitService = new GitServiceImpl(
      s.basePath,
      loadEffectiveGSDPreferences(base)?.preferences?.git ?? {}
    );
    if (!isDebugEnabled() && process.env.GSD_DEBUG === "1") {
      enableDebug(base);
    }
    if (isDebugEnabled()) {
      const { isNativeParserAvailable } = await import("./native-parser-bridge.js");
      debugLog("debug-start", {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        model: ctx.model?.id ?? "unknown",
        provider: ctx.model?.provider ?? "unknown",
        nativeParser: isNativeParserAvailable(),
        cwd: base
      });
      ctx.ui.notify(`Debug logging enabled \u2192 ${getDebugLogPath()}`, "info");
    }
    if (interrupted.classification !== "recoverable") {
      s.pendingCrashRecovery = null;
    }
    invalidateAllCaches();
    await openProjectDbIfPresent(base);
    registerAutoWorkerForSession(base);
    cleanStaleRuntimeUnits(
      gsdRoot(base),
      (mid2) => {
        if (isDbAvailable()) {
          const row = getMilestone(mid2);
          return !!row && isClosedStatus(row.status);
        }
        const summaryFile = resolveMilestoneFile(base, mid2, "SUMMARY");
        if (!summaryFile) return false;
        try {
          return classifyMilestoneSummaryContent(readFileSync(summaryFile, "utf-8")) !== "failure";
        } catch {
          return false;
        }
      }
    );
    try {
      const auditResult = auditOrphanedMilestoneBranches(base, getIsolationMode(base));
      for (const msg of auditResult.recovered) {
        ctx.ui.notify(`Orphan audit: ${msg}`, "info");
      }
      for (const msg of auditResult.warnings) {
        ctx.ui.notify(`Orphan audit: ${msg}`, "warning");
      }
      if (auditResult.recovered.length > 0) {
        debugLog("orphan-audit", { recovered: auditResult.recovered, warnings: auditResult.warnings });
      }
    } catch (err) {
      logWarning("bootstrap", `orphaned milestone branch audit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      if (isDbAvailable()) {
        const stashAudit = auditOrphanedPreflightStashes(base, (milestoneId) => {
          const row = getMilestone(milestoneId);
          return !!row && isClosedStatus(row.status);
        });
        for (const entry of stashAudit.applied) {
          ctx.ui.notify(
            `Orphan audit: applied preflight stash ${entry.stashRef} for completed milestone ${entry.milestoneId}. The stash entry is preserved as a backup.`,
            "info"
          );
        }
        for (const msg of stashAudit.warnings) {
          ctx.ui.notify(`Orphan audit: ${msg}`, "warning");
        }
        if (stashAudit.applied.length > 0) {
          debugLog("orphan-stash-audit", {
            applied: stashAudit.applied,
            warnings: stashAudit.warnings
          });
        }
      }
    } catch (err) {
      logWarning(
        "bootstrap",
        `orphaned preflight-stash audit failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    let state = await deriveState(base);
    if (state.activeMilestone && shouldUseWorktreeIsolation(base) && !detectWorktreeName(base)) {
      const wtPath = getAutoWorktreePath(base, state.activeMilestone.id);
      if (wtPath) {
        state = await deriveState(wtPath);
      }
    }
    let hasSurvivorBranch = false;
    let survivorMilestoneId = state.activeMilestone?.id ?? null;
    if (!survivorMilestoneId && state.phase === "complete") {
      survivorMilestoneId = findUnmergedCompletedMilestone(base, getIsolationMode(base));
    }
    if (survivorMilestoneId && (state.phase === "pre-planning" || state.phase === "complete") && getIsolationMode(base) !== "none" && !detectWorktreeName(base) && !base.includes(`${pathSep}.gsd${pathSep}worktrees${pathSep}`)) {
      const milestoneBranch = `milestone/${survivorMilestoneId}`;
      const { nativeBranchExists: nativeBranchExists2 } = await import("./native-git-bridge.js");
      hasSurvivorBranch = nativeBranchExists2(base, milestoneBranch);
      if (hasSurvivorBranch) {
        ctx.ui.notify(
          `Found prior session branch ${milestoneBranch}. Resuming.`,
          "info"
        );
      }
    }
    if (decideSurvivorAction(hasSurvivorBranch, state.phase) === "discuss") {
      const { showSmartEntry } = await import("./guided-flow.js");
      await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
      invalidateAllCaches();
      const postState = await deriveState(base);
      if (postState.activeMilestone && postState.phase !== "needs-discussion") {
        state = postState;
        hasSurvivorBranch = false;
      } else {
        ctx.ui.notify(
          "Discussion completed but milestone draft was not promoted. Run /gsd to try again.",
          "warning"
        );
        return releaseLockAndReturn();
      }
    }
    if (decideSurvivorAction(hasSurvivorBranch, state.phase) === "finalize") {
      const mid2 = survivorMilestoneId;
      const finalize = _finalizeSurvivorBranch(buildLifecycle(), mid2, ctx.ui);
      if (!finalize.merged) {
        return releaseLockAndReturn();
      }
      invalidateAllCaches();
      state = await deriveState(base);
      hasSurvivorBranch = false;
    }
    {
      const orphan = findUnmergedCompletedMilestone(base, getIsolationMode(base));
      if (orphan && orphan !== state.activeMilestone?.id) {
        const lifecycle = buildLifecycle();
        const result = lifecycle.adoptOrphanWorktree(
          orphan,
          base,
          () => _mergeOrphanCompletedMilestone(lifecycle, orphan, ctx.ui)
        );
        if (!result.merged) {
          return releaseLockAndReturn();
        }
        invalidateAllCaches();
        state = await deriveState(base);
      }
    }
    const effectivePrefs = loadEffectiveGSDPreferences(base)?.preferences;
    const { shouldRunDeepProjectSetup } = await import("./auto-dispatch.js");
    const deepProjectStagePending = shouldRunDeepProjectSetup(
      state,
      effectivePrefs,
      base,
      { hasSurvivorBranch }
    );
    if (deepProjectStagePending) {
      s.currentMilestoneId = null;
    }
    if (!hasSurvivorBranch && !deepProjectStagePending) {
      if (!state.activeMilestone || state.phase === "complete") {
        s.consecutiveCompleteBootstraps++;
        if (s.consecutiveCompleteBootstraps > MAX_CONSECUTIVE_COMPLETE_BOOTSTRAPS) {
          s.consecutiveCompleteBootstraps = 0;
          ctx.ui.notify(
            "All milestones are complete and the discussion didn't produce a new one. Run /gsd to start a new milestone manually.",
            "warning"
          );
          return releaseLockAndReturn();
        }
        const { showSmartEntry } = await import("./guided-flow.js");
        await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
        return releaseLockAndReturn();
      }
      if (state.phase === "pre-planning") {
        const mid2 = state.activeMilestone.id;
        const contextFile = resolveMilestoneFile(base, mid2, "CONTEXT");
        const hasContext = !!(contextFile && await loadFile(contextFile));
        if (!hasContext && effectivePrefs?.planning_depth !== "deep") {
          const { showSmartEntry } = await import("./guided-flow.js");
          await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
          return releaseLockAndReturn();
        }
      }
      if (state.phase === "needs-discussion") {
        const { showSmartEntry } = await import("./guided-flow.js");
        await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
        invalidateAllCaches();
        const postState = await deriveState(base);
        if (postState.activeMilestone && postState.phase !== "needs-discussion") {
          state = postState;
        } else {
          ctx.ui.notify(
            "Discussion completed but milestone draft was not promoted. Run /gsd to try again.",
            "warning"
          );
          return releaseLockAndReturn();
        }
      }
    }
    if (!state.activeMilestone && !deepProjectStagePending) {
      const { showSmartEntry } = await import("./guided-flow.js");
      await showSmartEntry(ctx, pi, base, { step: requestedStepMode });
      return releaseLockAndReturn();
    }
    s.consecutiveCompleteBootstraps = 0;
    const { activateGSD: activateGSDPhaseState } = await import("../shared/gsd-phase-state.js");
    activateGSDPhaseState();
    s.active = true;
    s.stepMode = requestedStepMode;
    s.verbose = verboseMode;
    s.cmdCtx = ctx;
    buildLifecycle().adoptSessionRoot(base);
    s.unitDispatchCount.clear();
    s.unitRecoveryCount.clear();
    s.lastBudgetAlertLevel = 0;
    s.unitLifetimeDispatches.clear();
    resetHookState();
    restoreHookState(base);
    resetProactiveHealing();
    setLevelChangeCallback((_from, to, summary) => {
      const level = to === "red" ? "error" : to === "yellow" ? "warning" : "info";
      ctx.ui.notify(summary, level);
    });
    s.autoStartTime = Date.now();
    s.resourceVersionOnStart = readResourceVersion();
    s.pendingQuickTasks = [];
    s.currentUnit = null;
    s.currentMilestoneId ??= deepProjectStagePending ? null : state.activeMilestone?.id ?? null;
    s.originalModelId = startModelSnapshot?.id ?? ctx.model?.id ?? null;
    s.originalModelProvider = startModelSnapshot?.provider ?? ctx.model?.provider ?? null;
    s.originalThinkingLevel = startThinkingSnapshot ?? null;
    registerSigtermHandler(base);
    if (s.currentMilestoneId) {
      if (getIsolationMode(base) !== "none") {
        captureIntegrationBranch(base, s.currentMilestoneId);
      }
      setActiveMilestoneId(base, s.currentMilestoneId);
    }
    const isolationMode = getIsolationMode(base);
    const isRepo = nativeIsRepo(base);
    if (isolationMode === "none" && isRepo) {
      try {
        const currentBranch = nativeGetCurrentBranch(base);
        const integrationBranch = nativeDetectMainBranch(base);
        const branchToCheckout = resolveIsolationNoneBranchCheckout(
          currentBranch,
          integrationBranch,
          isolationMode,
          isRepo
        );
        if (branchToCheckout) {
          nativeCheckoutBranch(base, branchToCheckout);
          logWarning("bootstrap", `Returned to "${branchToCheckout}" \u2014 HEAD was on stale milestone branch "${currentBranch}" (isolation: none does not use milestone branches).`);
        }
      } catch (err) {
        logWarning("bootstrap", `Could not auto-checkout from stale milestone branch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const isUnderGsdWorktrees = (p) => {
      const marker = `${pathSep}.gsd${pathSep}worktrees${pathSep}`;
      if (p.includes(marker)) return true;
      const worktreesSuffix = `${pathSep}.gsd${pathSep}worktrees`;
      if (p.endsWith(worktreesSuffix)) return true;
      const symlinkRe = new RegExp(
        `\\${pathSep}\\.gsd\\${pathSep}projects\\${pathSep}[a-f0-9]+\\${pathSep}worktrees(?:\\${pathSep}|$)`
      );
      return symlinkRe.test(p);
    };
    if (s.currentMilestoneId && getIsolationMode(base) !== "none" && !detectWorktreeName(base) && !isUnderGsdWorktrees(base)) {
      const enterResult = buildLifecycle().enterMilestone(s.currentMilestoneId, {
        notify: ctx.ui.notify.bind(ctx.ui)
      });
      if (!enterResult.ok) {
        s.active = false;
        if (enterResult.reason === "lease-conflict") {
          ctx.ui.notify(
            `Cannot enter milestone ${s.currentMilestoneId}: lease is held by another worker.`,
            "error"
          );
        } else if (enterResult.reason === "creation-failed") {
          ctx.ui.notify(
            `Cannot enter milestone ${s.currentMilestoneId}: worktree/branch creation failed. Isolation is degraded.`,
            "error"
          );
        } else if (enterResult.reason === "invalid-milestone-id") {
          ctx.ui.notify(
            `Cannot enter milestone ${s.currentMilestoneId}: milestone id is invalid.`,
            "error"
          );
        } else {
          ctx.ui.notify(
            `Auto-mode bootstrap stopped: failed to enter milestone ${s.currentMilestoneId} (${enterResult.reason}).`,
            "error"
          );
        }
        return releaseLockAndReturn();
      }
      if (s.basePath !== base) {
        registerSigtermHandler(s.originalBasePath);
      }
    }
    const gsdDbPath = resolveProjectRootDbPath(s.basePath);
    const gsdDirPath = join(s.basePath, ".gsd");
    if (existsSync(gsdDirPath) && !existsSync(gsdDbPath)) {
      try {
        const { openDatabase: openDb } = await import("./gsd-db.js");
        openDb(gsdDbPath);
      } catch (err) {
        logError("engine", `failed to initialize project database: ${err.message}`);
      }
    }
    if (_shouldAbortBootstrapForUnavailableDbForTest(gsdDbPath, isDbAvailable())) {
      try {
        const { openDatabase: openDb } = await import("./gsd-db.js");
        openDb(gsdDbPath);
      } catch (err) {
        logError("engine", `failed to open existing database: ${err.message}`);
      }
    }
    if (existsSync(gsdDbPath) && !isDbAvailable()) {
      const dbStatus = getDbStatus();
      const phaseHint = dbStatus.lastPhase === "open" ? "The database file could not be opened" : dbStatus.lastPhase === "initSchema" ? "The database schema could not be initialized" : dbStatus.lastPhase === "vacuum-recovery" ? "Corruption recovery (VACUUM) failed" : dbStatus.attempted ? "The database could not be opened (phase unknown)" : "The database provider could not be loaded";
      const errorDetail = dbStatus.lastError ? ` (${dbStatus.lastError.message})` : "";
      const providerHint = dbStatus.provider ? ` Provider: ${dbStatus.provider}.` : " No SQLite provider available \u2014 check Node >= 22 or install better-sqlite3.";
      ctx.ui.notify(
        `SQLite database exists but failed to open: ${gsdDbPath}. ${phaseHint}${errorDetail}.${providerHint}`,
        "error"
      );
      return releaseLockAndReturn();
    }
    initMetrics(s.basePath);
    initRoutingHistory(s.basePath);
    if (startModelSnapshot) {
      s.autoModeStartModel = {
        provider: startModelSnapshot.provider,
        id: startModelSnapshot.id
      };
    }
    s.autoModeStartThinkingLevel = startThinkingSnapshot ?? null;
    s.manualSessionModelOverride = manualSessionOverride ?? null;
    const workerModelOverride = process.env.GSD_WORKER_MODEL;
    if (workerModelOverride && process.env.GSD_PARALLEL_WORKER === "1") {
      const availableModels = ctx.modelRegistry.getAvailable();
      const { resolveModelId } = await import("./auto-model-selection.js");
      const overrideModel = resolveModelId(workerModelOverride, availableModels, ctx.model?.provider);
      if (overrideModel) {
        const ok = await pi.setModel(overrideModel, { persist: false });
        if (ok) {
          s.autoModeStartModel = { provider: overrideModel.provider, id: overrideModel.id };
          ctx.ui.notify(`Worker model override: ${overrideModel.provider}/${overrideModel.id}`, "info");
        }
      }
    }
    if (resolveSkillDiscoveryMode(base) !== "off") {
      snapshotSkills();
    }
    ctx.ui.setStatus("gsd-auto", s.stepMode ? "next" : "auto");
    ctx.ui.setWidget("gsd-health", void 0);
    const modeLabel = s.stepMode ? "Step-mode" : "Auto-mode";
    const pendingCount = (state.registry ?? []).filter(
      (m) => m.status !== "complete" && m.status !== "parked"
    ).length;
    const scopeMsg = deepProjectStagePending ? "Will run project setup before milestone planning." : pendingCount > 1 ? `Will loop through ${pendingCount} milestones.` : "Will loop until milestone complete.";
    ctx.ui.notify(`${modeLabel} started. ${scopeMsg}`, "info");
    const providerReportedWindow = ctx.model?.contextWindow ?? 0;
    const contextOverride = loadEffectiveGSDPreferences(base)?.preferences.context_window_override;
    if (providerReportedWindow > 5e5 && contextOverride === void 0) {
      ctx.ui.notify(
        `Model reports a ${Math.round(providerReportedWindow / 1e3)}K context window. If the provider's real API limit is lower, set context_window_override in .gsd/PREFERENCES.md so wrap-up signals fire before context overflow.`,
        "warning"
      );
    }
    const routingConfig = resolveDynamicRoutingConfig();
    const startModelLabel = s.autoModeStartModel ? `${s.autoModeStartModel.provider}/${s.autoModeStartModel.id}` : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "default";
    const { isFlatRateProvider, buildFlatRateContext } = await import("./auto-model-selection.js");
    const bannerPrefs = loadEffectiveGSDPreferences(base)?.preferences;
    const effectiveProvider = s.autoModeStartModel?.provider ?? ctx.model?.provider;
    const effectivelyEnabled = routingConfig.enabled && (routingConfig.allow_flat_rate_providers || !(effectiveProvider && isFlatRateProvider(
      effectiveProvider,
      buildFlatRateContext(effectiveProvider, ctx, bannerPrefs)
    )));
    const effectiveCeiling = routingConfig.enabled && routingConfig.tier_models?.heavy ? routingConfig.tier_models.heavy : startModelLabel;
    if (effectivelyEnabled) {
      ctx.ui.notify(
        `Dynamic routing: enabled \u2014 simple tasks may use cheaper models (ceiling: ${effectiveCeiling})`,
        "info"
      );
    } else {
      ctx.ui.notify(
        `Dynamic routing: disabled \u2014 all tasks will use ${startModelLabel}`,
        "info"
      );
    }
    updateSessionLock(
      lockBase(),
      "starting",
      s.currentMilestoneId ?? "unknown"
    );
    writeLock(lockBase(), "starting", s.currentMilestoneId ?? "unknown");
    const mid = state.activeMilestone?.id;
    if (mid) {
      try {
        const manifestStatus = await getManifestStatus(base, mid, s.originalBasePath || base);
        if (manifestStatus && manifestStatus.pending.length > 0) {
          const result = await collectSecretsFromManifest(base, mid, ctx);
          if (result && result.applied && result.skipped && result.existingSkipped) {
            ctx.ui.notify(
              `Secrets collected: ${result.applied.length} applied, ${result.skipped.length} skipped, ${result.existingSkipped.length} already set.`,
              "info"
            );
          } else {
            ctx.ui.notify("Secrets collection skipped.", "info");
          }
        }
      } catch (err) {
        ctx.ui.notify(
          `Secrets collection error: ${err instanceof Error ? err.message : String(err)}. Continuing with next task.`,
          "warning"
        );
      }
    }
    try {
      const msDir = join(base, ".gsd", "milestones");
      if (existsSync(msDir)) {
        const milestoneIds = readdirSync(msDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^M\d{3}/.test(d.name)).map((d) => d.name.match(/^(M\d{3})/)?.[1] ?? d.name);
        if (milestoneIds.length > 1) {
          const issues = [];
          for (const id of milestoneIds) {
            if (isDbAvailable()) {
              const ms = getMilestone(id);
              if (ms?.status === "complete" || ms?.status === "parked") continue;
            }
            const draft = resolveMilestoneFile(base, id, "CONTEXT-DRAFT");
            if (draft)
              issues.push(
                `${id}: has CONTEXT-DRAFT.md (will pause for discussion)`
              );
          }
          if (issues.length > 0) {
            ctx.ui.notify(
              `Pre-flight: ${milestoneIds.length} milestones queued.
${issues.map((i) => `  \u26A0 ${i}`).join("\n")}`,
              "warning"
            );
          } else {
            ctx.ui.notify(
              `Pre-flight: ${milestoneIds.length} milestones queued. All have full context.`,
              "info"
            );
          }
        }
      }
    } catch (err) {
      logWarning("engine", `preflight validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  } catch (err) {
    releaseSessionLock(base);
    clearLock(base);
    throw err;
  }
}
export {
  _finalizeSurvivorBranch,
  _mergeOrphanCompletedMilestone,
  _selectResumableMilestone,
  _shouldAbortBootstrapForUnavailableDbForTest,
  auditOrphanedMilestoneBranches,
  bootstrapAutoSession,
  decideSurvivorAction,
  findUnmergedCompletedMilestone,
  hasGitIndexLockForTest,
  openProjectDbIfPresent,
  resolveIsolationNoneBranchCheckout
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXN0YXJ0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogQXV0by1tb2RlIGJvb3RzdHJhcCwgd29ya3RyZWUgcmVjb3ZlcnksIGFuZCBmcmVzaC1zdGFydCBpbml0aWFsaXphdGlvbi5cbi8qKlxuICogQXV0by1tb2RlIGJvb3RzdHJhcCBcdTIwMTQgZnJlc2gtc3RhcnQgaW5pdGlhbGl6YXRpb24gcGF0aC5cbiAqXG4gKiBHaXQvc3RhdGUgYm9vdHN0cmFwLCBjcmFzaCBsb2NrIGRldGVjdGlvbiwgZGVidWcgaW5pdCwgd29ya3RyZWUgcmVjb3ZlcnksXG4gKiBndWlkZWQgZmxvdyBnYXRlLCBzZXNzaW9uIGluaXQsIHdvcmt0cmVlIGxpZmVjeWNsZSwgREIgbGlmZWN5Y2xlLFxuICogcHJlZmxpZ2h0IHZhbGlkYXRpb24uXG4gKlxuICogRXh0cmFjdGVkIGZyb20gc3RhcnRBdXRvKCkgaW4gYXV0by50cy4gVGhlIHJlc3VtZSBwYXRoIChzLnBhdXNlZClcbiAqIHJlbWFpbnMgaW4gYXV0by50cyBcdTIwMTQgdGhpcyBtb2R1bGUgaGFuZGxlcyBvbmx5IHRoZSBmcmVzaC1zdGFydCBwYXRoLlxuICovXG5cbmltcG9ydCB0eXBlIHtcbiAgRXh0ZW5zaW9uQVBJLFxuICBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbn0gZnJvbSBcIkBnc2QvcGktY29kaW5nLWFnZW50XCI7XG5pbXBvcnQgeyBkZXJpdmVTdGF0ZSB9IGZyb20gXCIuL3N0YXRlLmpzXCI7XG5pbXBvcnQgeyBsb2FkRmlsZSwgZ2V0TWFuaWZlc3RTdGF0dXMgfSBmcm9tIFwiLi9maWxlcy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBJbnRlcnJ1cHRlZFNlc3Npb25Bc3Nlc3NtZW50IH0gZnJvbSBcIi4vaW50ZXJydXB0ZWQtc2Vzc2lvbi5qc1wiO1xuaW1wb3J0IHtcbiAgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzLFxuICByZXNvbHZlU2tpbGxEaXNjb3ZlcnlNb2RlLFxuICBnZXRJc29sYXRpb25Nb2RlLFxufSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgZW5zdXJlR3NkU3ltbGluaywgaXNJbmhlcml0ZWRSZXBvLCB2YWxpZGF0ZVByb2plY3RJZCB9IGZyb20gXCIuL3JlcG8taWRlbnRpdHkuanNcIjtcbmltcG9ydCB7IG1pZ3JhdGVUb0V4dGVybmFsU3RhdGUsIHJlY292ZXJGYWlsZWRNaWdyYXRpb24gfSBmcm9tIFwiLi9taWdyYXRlLWV4dGVybmFsLmpzXCI7XG5pbXBvcnQgeyBjb2xsZWN0U2VjcmV0c0Zyb21NYW5pZmVzdCB9IGZyb20gXCIuLi9nZXQtc2VjcmV0cy1mcm9tLXVzZXIuanNcIjtcbmltcG9ydCB7IGdzZFJvb3QsIHJlc29sdmVNaWxlc3RvbmVGaWxlIH0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVBbGxDYWNoZXMgfSBmcm9tIFwiLi9jYWNoZS5qc1wiO1xuaW1wb3J0IHsgd3JpdGVMb2NrLCBjbGVhckxvY2sgfSBmcm9tIFwiLi9jcmFzaC1yZWNvdmVyeS5qc1wiO1xuaW1wb3J0IHtcbiAgYWNxdWlyZVNlc3Npb25Mb2NrLFxuICByZWxlYXNlU2Vzc2lvbkxvY2ssXG4gIHVwZGF0ZVNlc3Npb25Mb2NrLFxufSBmcm9tIFwiLi9zZXNzaW9uLWxvY2suanNcIjtcbmltcG9ydCB7IGVuc3VyZUdpdGlnbm9yZSwgdW50cmFja1J1bnRpbWVGaWxlcyB9IGZyb20gXCIuL2dpdGlnbm9yZS5qc1wiO1xuaW1wb3J0IHtcbiAgbmF0aXZlSXNSZXBvLFxuICBuYXRpdmVJbml0LFxuICBuYXRpdmVBZGRBbGwsXG4gIG5hdGl2ZUNvbW1pdCxcbiAgbmF0aXZlR2V0Q3VycmVudEJyYW5jaCxcbiAgbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaCxcbiAgbmF0aXZlQ2hlY2tvdXRCcmFuY2gsXG4gIG5hdGl2ZUJyYW5jaExpc3QsXG4gIG5hdGl2ZUJyYW5jaEV4aXN0cyxcbiAgbmF0aXZlQnJhbmNoTGlzdE1lcmdlZCxcbiAgbmF0aXZlQnJhbmNoRGVsZXRlLFxuICBuYXRpdmVXb3JrdHJlZVJlbW92ZSxcbiAgbmF0aXZlQ29tbWl0Q291bnRCZXR3ZWVuLFxufSBmcm9tIFwiLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc1wiO1xuaW1wb3J0IHsgR2l0U2VydmljZUltcGwgfSBmcm9tIFwiLi9naXQtc2VydmljZS5qc1wiO1xuaW1wb3J0IHtcbiAgY2FwdHVyZUludGVncmF0aW9uQnJhbmNoLFxuICBkZXRlY3RXb3JrdHJlZU5hbWUsXG4gIHNldEFjdGl2ZU1pbGVzdG9uZUlkLFxufSBmcm9tIFwiLi93b3JrdHJlZS5qc1wiO1xuaW1wb3J0IHsgZ2V0QXV0b1dvcmt0cmVlUGF0aCwgaXNJbkF1dG9Xb3JrdHJlZSB9IGZyb20gXCIuL2F1dG8td29ya3RyZWUuanNcIjtcbmltcG9ydCB7IHJlYWRSZXNvdXJjZVZlcnNpb24sIGNsZWFuU3RhbGVSdW50aW1lVW5pdHMgfSBmcm9tIFwiLi9hdXRvLXdvcmt0cmVlLmpzXCI7XG5pbXBvcnQgeyB3b3JrdHJlZVBhdGggYXMgZ2V0V29ya3RyZWVEaXIsIGlzSW5zaWRlV29ya3RyZWVzRGlyIH0gZnJvbSBcIi4vd29ya3RyZWUtbWFuYWdlci5qc1wiO1xuaW1wb3J0IHsgZW1pdFdvcmt0cmVlT3JwaGFuZWQgfSBmcm9tIFwiLi93b3JrdHJlZS10ZWxlbWV0cnkuanNcIjtcbmltcG9ydCB7IGluaXRNZXRyaWNzIH0gZnJvbSBcIi4vbWV0cmljcy5qc1wiO1xuaW1wb3J0IHsgaW5pdFJvdXRpbmdIaXN0b3J5IH0gZnJvbSBcIi4vcm91dGluZy1oaXN0b3J5LmpzXCI7XG5pbXBvcnQgeyByZXN0b3JlSG9va1N0YXRlLCByZXNldEhvb2tTdGF0ZSB9IGZyb20gXCIuL3Bvc3QtdW5pdC1ob29rcy5qc1wiO1xuaW1wb3J0IHsgcmVzZXRQcm9hY3RpdmVIZWFsaW5nLCBzZXRMZXZlbENoYW5nZUNhbGxiYWNrIH0gZnJvbSBcIi4vZG9jdG9yLXByb2FjdGl2ZS5qc1wiO1xuaW1wb3J0IHsgc25hcHNob3RTa2lsbHMgfSBmcm9tIFwiLi9za2lsbC1kaXNjb3ZlcnkuanNcIjtcbmltcG9ydCB7IGlzRGJBdmFpbGFibGUsIGdldE1pbGVzdG9uZSwgZ2V0QWxsTWlsZXN0b25lcywgb3BlbkRhdGFiYXNlLCBnZXREYlN0YXR1cyB9IGZyb20gXCIuL2dzZC1kYi5qc1wiO1xuaW1wb3J0IHsgaXNDbG9zZWRTdGF0dXMgfSBmcm9tIFwiLi9zdGF0dXMtZ3VhcmRzLmpzXCI7XG5pbXBvcnQgeyBjbGFzc2lmeU1pbGVzdG9uZVN1bW1hcnlDb250ZW50IH0gZnJvbSBcIi4vbWlsZXN0b25lLXN1bW1hcnktY2xhc3NpZmllci5qc1wiO1xuaW1wb3J0IHsgYXVkaXRPcnBoYW5lZFByZWZsaWdodFN0YXNoZXMgfSBmcm9tIFwiLi9vcnBoYW4tc3Rhc2gtYXVkaXQuanNcIjtcblxuaW1wb3J0IHtcbiAgZGVidWdMb2csXG4gIGVuYWJsZURlYnVnLFxuICBpc0RlYnVnRW5hYmxlZCxcbiAgZ2V0RGVidWdMb2dQYXRoLFxufSBmcm9tIFwiLi9kZWJ1Zy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcsIGxvZ0Vycm9yIH0gZnJvbSBcIi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyBwYXJzZVVuaXRJZCB9IGZyb20gXCIuL3VuaXQtaWQuanNcIjtcbmltcG9ydCB0eXBlIHsgQXV0b1Nlc3Npb24gfSBmcm9tIFwiLi9hdXRvL3Nlc3Npb24uanNcIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcm1TeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHNlcCBhcyBwYXRoU2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuXG5pbXBvcnQgeyByZXNvbHZlUHJvamVjdFJvb3REYlBhdGggfSBmcm9tIFwiLi9ib290c3RyYXAvZHluYW1pYy10b29scy5qc1wiO1xuaW1wb3J0IHsgdmFsaWRhdGVEaXJlY3RvcnkgfSBmcm9tIFwiLi92YWxpZGF0ZS1kaXJlY3RvcnkuanNcIjtcbmltcG9ydCB7XG4gIGlzQ3VzdG9tUHJvdmlkZXIsXG4gIHJlc29sdmVEZWZhdWx0U2Vzc2lvbk1vZGVsLFxuICByZXNvbHZlRHluYW1pY1JvdXRpbmdDb25maWcsXG59IGZyb20gXCIuL3ByZWZlcmVuY2VzLW1vZGVscy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBXb3JrdHJlZUxpZmVjeWNsZSB9IGZyb20gXCIuL3dvcmt0cmVlLWxpZmVjeWNsZS5qc1wiO1xuaW1wb3J0IHsgZ2V0U2Vzc2lvbk1vZGVsT3ZlcnJpZGUgfSBmcm9tIFwiLi9zZXNzaW9uLW1vZGVsLW92ZXJyaWRlLmpzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQm9vdHN0cmFwRGVwcyB7XG4gIHNob3VsZFVzZVdvcmt0cmVlSXNvbGF0aW9uOiAoYmFzZVBhdGg/OiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIHJlZ2lzdGVyU2lndGVybUhhbmRsZXI6IChiYXNlUGF0aDogc3RyaW5nKSA9PiB2b2lkO1xuICByZWdpc3RlckF1dG9Xb3JrZXJGb3JTZXNzaW9uOiAoYmFzZVBhdGg6IHN0cmluZykgPT4gdm9pZDtcbiAgbG9ja0Jhc2U6ICgpID0+IHN0cmluZztcbiAgYnVpbGRMaWZlY3ljbGU6ICgpID0+IFdvcmt0cmVlTGlmZWN5Y2xlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUlzb2xhdGlvbk5vbmVCcmFuY2hDaGVja291dChcbiAgY3VycmVudEJyYW5jaDogc3RyaW5nLFxuICBpbnRlZ3JhdGlvbkJyYW5jaDogc3RyaW5nLFxuICBpc29sYXRpb25Nb2RlOiBzdHJpbmcsXG4gIGlzUmVwbzogYm9vbGVhbixcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWlzUmVwbyB8fCBpc29sYXRpb25Nb2RlICE9PSBcIm5vbmVcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiBjdXJyZW50QnJhbmNoLnN0YXJ0c1dpdGgoXCJtaWxlc3RvbmUvXCIpID8gaW50ZWdyYXRpb25CcmFuY2ggOiBudWxsO1xufVxuXG4vKipcbiAqIEJvb3RzdHJhcCBhIGZyZXNoIGF1dG8tbW9kZSBzZXNzaW9uLiBIYW5kbGVzIGV2ZXJ5dGhpbmcgZnJvbSBnaXQgaW5pdFxuICogdGhyb3VnaCBzZWNyZXRzIGNvbGxlY3Rpb24sIHJldHVybmluZyB3aGVuIHJlYWR5IGZvciB0aGUgZmlyc3RcbiAqIGRpc3BhdGNoTmV4dFVuaXQgY2FsbC5cbiAqXG4gKiBSZXR1cm5zIGZhbHNlIGlmIHRoZSBib290c3RyYXAgYWJvcnRlZCAoZS5nLiwgZ3VpZGVkIGZsb3cgcmV0dXJuZWQsXG4gKiBjb25jdXJyZW50IHNlc3Npb24gZGV0ZWN0ZWQpLiBSZXR1cm5zIHRydWUgd2hlbiByZWFkeSB0byBkaXNwYXRjaC5cbiAqL1xuXG4vLyBHdWFyZCBjb25zdGFudCBmb3IgY29uc2VjdXRpdmUgYm9vdHN0cmFwIGF0dGVtcHRzIHRoYXQgZm91bmQgcGhhc2UgPT09IFwiY29tcGxldGVcIi5cbi8vIENvdW50ZXIgbW92ZWQgdG8gQXV0b1Nlc3Npb24uY29uc2VjdXRpdmVDb21wbGV0ZUJvb3RzdHJhcHMgc28gcy5yZXNldCgpIGNsZWFycyBpdC5cbmNvbnN0IE1BWF9DT05TRUNVVElWRV9DT01QTEVURV9CT09UU1RSQVBTID0gMjtcblxuZXhwb3J0IGZ1bmN0aW9uIGhhc0dpdEluZGV4TG9ja0ZvclRlc3QoYmFzZVBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKGJhc2VQYXRoLCBcIi5naXRcIiwgXCJpbmRleC5sb2NrXCIpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIF9zaG91bGRBYm9ydEJvb3RzdHJhcEZvclVuYXZhaWxhYmxlRGJGb3JUZXN0KFxuICBnc2REYlBhdGg6IHN0cmluZyxcbiAgZGJBdmFpbGFibGU6IGJvb2xlYW4sXG4gIHBhdGhFeGlzdHM6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW4gPSBleGlzdHNTeW5jLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiBwYXRoRXhpc3RzKGdzZERiUGF0aCkgJiYgIWRiQXZhaWxhYmxlO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3BlblByb2plY3REYklmUHJlc2VudChiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGdzZERiUGF0aCA9IHJlc29sdmVQcm9qZWN0Um9vdERiUGF0aChiYXNlUGF0aCk7XG4gIGlmICghZXhpc3RzU3luYyhnc2REYlBhdGgpIHx8IGlzRGJBdmFpbGFibGUoKSkgcmV0dXJuO1xuXG4gIHRyeSB7XG4gICAgb3BlbkRhdGFiYXNlKGdzZERiUGF0aCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYGdzZC1kYjogZmFpbGVkIHRvIG9wZW4gZXhpc3RpbmcgZGF0YWJhc2U6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICB9XG59XG5cbi8qKlxuICogQXVkaXQgZm9yIG9ycGhhbmVkIG1pbGVzdG9uZSBicmFuY2hlcyBhdCBib290c3RyYXAuXG4gKlxuICogQWZ0ZXIgYSBtaWxlc3RvbmUgY29tcGxldGVzLCB0aGUgdGVhcmRvd24gc3RlcCAobWVyZ2UgYnJhbmNoIFx1MjE5MiBtYWluLFxuICogZGVsZXRlIGJyYW5jaCwgcmVtb3ZlIHdvcmt0cmVlKSBydW5zIGFzIGEgcG9zdC1jb21wbGV0aW9uIGVuZ2luZSBzdGVwLlxuICogSWYgdGhlIHNlc3Npb24gZW5kcyBiZXR3ZWVuIGNvbXBsZXRpb24gYW5kIHRlYXJkb3duLCB0aGUgYnJhbmNoIGFuZFxuICogd29ya3RyZWUgYXJlIG9ycGhhbmVkIFx1MjAxNCB0aGUgREIgc2F5cyBcImNvbXBsZXRlXCIgc28gYXV0by1tb2RlIHdvbid0XG4gKiByZS1lbnRlciB0aGUgbWlsZXN0b25lLCBhbmQgdGhlIHRlYXJkb3duIGlzIG5ldmVyIHJldHJpZWQuXG4gKlxuICogVGhpcyBhdWRpdCBydW5zIG9uIGV2ZXJ5IGZyZXNoIGJvb3RzdHJhcCB0byBjYXRjaCB0aGF0IGdhcDpcbiAqIDEuIExpc3RzIGFsbCBsb2NhbCBgbWlsZXN0b25lLypgIGJyYW5jaGVzLlxuICogMi4gRm9yIGVhY2gsIGNoZWNrcyBpZiB0aGUgbWlsZXN0b25lJ3MgREIgc3RhdHVzIGlzIFwiY29tcGxldGVcIi5cbiAqIDMuIElmIHRoZSBicmFuY2ggaXMgYWxyZWFkeSBtZXJnZWQgaW50byBtYWluIFx1MjE5MiBkZWxldGVzIHRoZSBicmFuY2hcbiAqICAgIGFuZCBjbGVhbnMgdXAgYW55IG9ycGhhbmVkIHdvcmt0cmVlIGRpcmVjdG9yeSAoc2FmZSwgbm8gZGF0YSBsb3NzKS5cbiAqIDQuIElmIHRoZSBicmFuY2ggaXMgTk9UIG1lcmdlZCBcdTIxOTIgcHJlc2VydmVzIGl0IGFuZCB3YXJucyB0aGUgdXNlclxuICogICAgc28gdGhleSBjYW4gbWVyZ2UgbWFudWFsbHkgKGRhdGEgc2FmZXR5IGZpcnN0KS5cbiAqXG4gKiBSZXR1cm5zIGEgc3VtbWFyeSBvZiBhY3Rpb25zIHRha2VuIGZvciB0aGUgY2FsbGVyIHRvIHN1cmZhY2UgdmlhIG5vdGlmeS5cbiAqL1xuLyoqXG4gKiBEZWNpZGUgd2hpY2ggc3Vydml2b3ItYnJhbmNoIHJlY292ZXJ5IGFjdGlvbiBib290c3RyYXBBdXRvU2Vzc2lvbiBtdXN0XG4gKiBydW4gZm9yIHRoZSBjdXJyZW50IChoYXNTdXJ2aXZvckJyYW5jaCwgcGhhc2UpIGNvbWJpbmF0aW9uLiBFeHRyYWN0ZWRcbiAqIGZyb20gdGhlIGlubGluZSBjaGFpbiBhdCBgYm9vdHN0cmFwQXV0b1Nlc3Npb25gIChhcm91bmQgbGluZSA2MDQpIHNvXG4gKiB0aGUgZGVjaXNpb24gdGFibGUgaXMgdGVzdGFibGUgd2l0aG91dCBjb25zdHJ1Y3RpbmcgYSBmdWxsIHNlc3Npb24uXG4gKlxuICogLSBgbm9uZWAgICAgIFx1MjAxNCBubyBzdXJ2aXZvciwgb3IgcGhhc2UgZG9lc24ndCBjYWxsIGZvciByZWNvdmVyeS4gRmFsbFxuICogICAgICAgICAgICAgICAgdGhyb3VnaCB0byBub3JtYWwgYm9vdHN0cmFwIGZsb3cuXG4gKiAtIGBkaXNjdXNzYCAgXHUyMDE0IHN1cnZpdm9yICsgcGhhc2U9bmVlZHMtZGlzY3Vzc2lvbiAoIzE3MjYpLiBSb3V0ZSB0b1xuICogICAgICAgICAgICAgICAgc2hvd1NtYXJ0RW50cnkuXG4gKiAtIGBmaW5hbGl6ZWAgXHUyMDE0IHN1cnZpdm9yICsgcGhhc2U9Y29tcGxldGUgKCMyMzU4KS4gUnVuIG1lcmdlQW5kRXhpdCB0b1xuICogICAgICAgICAgICAgICAgbWVyZ2UgdGhlIG1pbGVzdG9uZSBicmFuY2ggYW5kIGNsZWFyIHRoZSB3b3JrdHJlZS5cbiAqXG4gKiBBbnkgb3RoZXIgcGhhc2Ugd2l0aCBhIHN1cnZpdm9yIChwcmUtcGxhbm5pbmcsIHBsYW5uaW5nLCBleGVjdXRpbmdcdTIwMjYpXG4gKiByZXR1cm5zIGBub25lYCBcdTIwMTQgdGhlIGNhbGxlciBjb250aW51ZXMgaXRzIG5vcm1hbCBmbG93IGFuZCB0aGVcbiAqIHN1cnZpdm9yIGJyYW5jaCBwYXJ0aWNpcGF0ZXMgaW4gd2hhdGV2ZXIgYXV0by1tb2RlIGhhcHBlbnMgbmV4dC5cbiAqL1xuZXhwb3J0IHR5cGUgU3Vydml2b3JBY3Rpb24gPSBcIm5vbmVcIiB8IFwiZGlzY3Vzc1wiIHwgXCJmaW5hbGl6ZVwiO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVjaWRlU3Vydml2b3JBY3Rpb24oXG4gIGhhc1N1cnZpdm9yQnJhbmNoOiBib29sZWFuLFxuICBwaGFzZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IFN1cnZpdm9yQWN0aW9uIHtcbiAgaWYgKCFoYXNTdXJ2aXZvckJyYW5jaCkgcmV0dXJuIFwibm9uZVwiO1xuICBpZiAocGhhc2UgPT09IFwibmVlZHMtZGlzY3Vzc2lvblwiKSByZXR1cm4gXCJkaXNjdXNzXCI7XG4gIGlmIChwaGFzZSA9PT0gXCJjb21wbGV0ZVwiKSByZXR1cm4gXCJmaW5hbGl6ZVwiO1xuICByZXR1cm4gXCJub25lXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhdWRpdE9ycGhhbmVkTWlsZXN0b25lQnJhbmNoZXMoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGlzb2xhdGlvbk1vZGU6IFwid29ya3RyZWVcIiB8IFwiYnJhbmNoXCIgfCBcIm5vbmVcIixcbiAgZ2l0RGVwczoge1xuICAgIGJyYW5jaExpc3Q/OiB0eXBlb2YgbmF0aXZlQnJhbmNoTGlzdDtcbiAgICBicmFuY2hFeGlzdHM/OiB0eXBlb2YgbmF0aXZlQnJhbmNoRXhpc3RzO1xuICB9ID0ge30sXG4pOiB7IHJlY292ZXJlZDogc3RyaW5nW107IHdhcm5pbmdzOiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgcmVjb3ZlcmVkOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YXJuaW5nczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgYnJhbmNoTGlzdCA9IGdpdERlcHMuYnJhbmNoTGlzdCA/PyBuYXRpdmVCcmFuY2hMaXN0O1xuICBjb25zdCBicmFuY2hFeGlzdHMgPSBnaXREZXBzLmJyYW5jaEV4aXN0cyA/PyBuYXRpdmVCcmFuY2hFeGlzdHM7XG5cbiAgLy8gU2tpcCBpbiBub25lIG1vZGUgXHUyMDE0IG5vIG1pbGVzdG9uZSBicmFuY2hlcyBhcmUgY3JlYXRlZFxuICBpZiAoaXNvbGF0aW9uTW9kZSA9PT0gXCJub25lXCIpIHJldHVybiB7IHJlY292ZXJlZCwgd2FybmluZ3MgfTtcblxuICAvLyBTa2lwIGlmIERCIG5vdCBhdmFpbGFibGUgXHUyMDE0IGNhbid0IGRldGVybWluZSBjb21wbGV0aW9uIHN0YXR1c1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIHsgcmVjb3ZlcmVkLCB3YXJuaW5ncyB9O1xuXG4gIGxldCBtaWxlc3RvbmVCcmFuY2hlczogc3RyaW5nW107XG4gIGxldCBtaWxlc3RvbmVCcmFuY2hMaXN0QXZhaWxhYmxlID0gdHJ1ZTtcbiAgdHJ5IHtcbiAgICBtaWxlc3RvbmVCcmFuY2hlcyA9IGJyYW5jaExpc3QoYmFzZVBhdGgsIFwibWlsZXN0b25lLypcIik7XG4gIH0gY2F0Y2gge1xuICAgIG1pbGVzdG9uZUJyYW5jaExpc3RBdmFpbGFibGUgPSBmYWxzZTtcbiAgICAvLyBnaXQgYnJhbmNoIGxpc3QgZmFpbGVkIFx1MjAxNCBmYWxsIHRocm91Z2ggd2l0aCBhbiBlbXB0eSBicmFuY2ggc2V0IHNvIHRoZVxuICAgIC8vIGJyYW5jaC1sZXNzIG9ycGhhbiBwYXNzIGNhbiBzdGlsbCBydW4gYWZ0ZXIgcGVyLW1pbGVzdG9uZSB2ZXJpZmljYXRpb24uXG4gICAgbWlsZXN0b25lQnJhbmNoZXMgPSBbXTtcbiAgfVxuXG4gIC8vIERldGVjdCBtYWluIGJyYW5jaCBmb3IgbWVyZ2UtY2hlY2tcbiAgbGV0IG1haW5CcmFuY2g6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBtYWluQnJhbmNoID0gbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaChiYXNlUGF0aCk7XG4gIH0gY2F0Y2gge1xuICAgIG1haW5CcmFuY2ggPSBcIm1haW5cIjtcbiAgfVxuXG4gIC8vIEdldCBicmFuY2hlcyBhbHJlYWR5IG1lcmdlZCBpbnRvIG1haW5cbiAgbGV0IG1lcmdlZEJyYW5jaGVzOiBTZXQ8c3RyaW5nPjtcbiAgdHJ5IHtcbiAgICBtZXJnZWRCcmFuY2hlcyA9IG5ldyBTZXQobmF0aXZlQnJhbmNoTGlzdE1lcmdlZChiYXNlUGF0aCwgbWFpbkJyYW5jaCwgXCJtaWxlc3RvbmUvKlwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIG1lcmdlZEJyYW5jaGVzID0gbmV3IFNldCgpO1xuICB9XG5cbiAgZm9yIChjb25zdCBicmFuY2ggb2YgbWlsZXN0b25lQnJhbmNoZXMpIHtcbiAgICBjb25zdCBtaWxlc3RvbmVJZCA9IGJyYW5jaC5yZXBsYWNlKC9ebWlsZXN0b25lXFwvLywgXCJcIik7XG4gICAgY29uc3QgbWlsZXN0b25lID0gZ2V0TWlsZXN0b25lKG1pbGVzdG9uZUlkKTtcblxuICAgIGlmICghbWlsZXN0b25lKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGlzTWVyZ2VkID0gbWVyZ2VkQnJhbmNoZXMuaGFzKGJyYW5jaCk7XG5cbiAgICAvLyAjNDc2MiBcdTIwMTQgaW4tcHJvZ3Jlc3MgbWlsZXN0b25lIGJyYW5jaCB3aXRoIHVubWVyZ2VkIGNvbW1pdHMgYWhlYWQgb2ZcbiAgICAvLyBtYWluLiBUaGlzIGlzIHRoZSBwcmUtY29tcGxldGlvbiBvcnBoYW4gY2FzZTogYXV0by1tb2RlIGV4aXRlZCB3aXRob3V0XG4gICAgLy8gY29tcGxldGluZyB0aGUgbWlsZXN0b25lIChwYXVzZSwgc3RvcCwgY3Jhc2gsIG1lcmdlIGVycm9yLCBibG9ja2VyKSBhbmRcbiAgICAvLyB3b3JrIGlzIHN0cmFuZGVkIG9uIHRoZSBicmFuY2ggb3IgaW4gdGhlIHdvcmt0cmVlLiBEYXRhIHNhZmV0eSBmaXJzdDpcbiAgICAvLyB3ZSBuZXZlciBkZWxldGUgb3IgdG91Y2g7IHdlIGp1c3Qgc3VyZmFjZSBhIHdhcm5pbmcgc28gdGhlIHVzZXIga25vd3NcbiAgICAvLyB3aGVyZSB0byBsb29rLlxuICAgIC8vXG4gICAgLy8gR2F0ZSBvbiBpc0Nsb3NlZFN0YXR1cyBzbyB3ZSBvbmx5IHdhcm4gYWJvdXQgZ2VudWluZWx5IG9wZW4gbWlsZXN0b25lcy5cbiAgICAvLyBQYXJrZWQvb3RoZXIgY2xvc2VkIHN0YXR1c2VzIGdvIHRocm91Z2ggdGhlIGxlZ2FjeSBjb21wbGV0ZS91bm1lcmdlZFxuICAgIC8vIHBhdGggYmVsb3cgd2hlcmUgYXBwcm9wcmlhdGUuXG4gICAgaWYgKCFpc0Nsb3NlZFN0YXR1cyhtaWxlc3RvbmUuc3RhdHVzKSkge1xuICAgICAgaWYgKGlzTWVyZ2VkKSBjb250aW51ZTsgLy8gbm90aGluZyB0byByZWNvdmVyXG4gICAgICBsZXQgY29tbWl0c0FoZWFkID0gMDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbW1pdHNBaGVhZCA9IG5hdGl2ZUNvbW1pdENvdW50QmV0d2VlbihiYXNlUGF0aCwgbWFpbkJyYW5jaCwgYnJhbmNoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBSZXYtd2FsayBmYWlsdXJlIFx1MjAxNCBza2lwIHJhdGhlciB0aGFuIG5vaXNlXG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGNvbW1pdHNBaGVhZCA9PT0gMCkgY29udGludWU7XG5cbiAgICAgIGNvbnN0IHd0RGlyID0gZ2V0V29ya3RyZWVEaXIoYmFzZVBhdGgsIG1pbGVzdG9uZUlkKTtcbiAgICAgIGNvbnN0IHd0RGlyRXhpc3RzID0gZXhpc3RzU3luYyh3dERpcik7XG4gICAgICBjb25zdCB3dFN1ZmZpeCA9IHd0RGlyRXhpc3RzXG4gICAgICAgID8gYCBXb3JrdHJlZSBkaXJlY3RvcnkgYXQgLmdzZC93b3JrdHJlZXMvJHttaWxlc3RvbmVJZH0vIGhvbGRzIHRoZSBsaXZlIHdvcmsuYFxuICAgICAgICA6IFwiXCI7XG4gICAgICB3YXJuaW5ncy5wdXNoKFxuICAgICAgICBgQnJhbmNoICR7YnJhbmNofSBoYXMgJHtjb21taXRzQWhlYWR9IGNvbW1pdChzKSBhaGVhZCBvZiAke21haW5CcmFuY2h9IGZvciBpbi1wcm9ncmVzcyBtaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0uYCArXG4gICAgICAgIHd0U3VmZml4ICtcbiAgICAgICAgYCBSdW4gXFxgL2dzZCBhdXRvXFxgIHRvIHJlc3VtZSwgb3IgbWVyZ2UgbWFudWFsbHkgaWYgYWJhbmRvbmluZy5gLFxuICAgICAgKTtcblxuICAgICAgLy8gIzQ3NjQgdGVsZW1ldHJ5XG4gICAgICB0cnkge1xuICAgICAgICBlbWl0V29ya3RyZWVPcnBoYW5lZChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHtcbiAgICAgICAgICByZWFzb246IFwiaW4tcHJvZ3Jlc3MtdW5tZXJnZWRcIixcbiAgICAgICAgICBjb21taXRzQWhlYWQsXG4gICAgICAgICAgd29ya3RyZWVEaXJFeGlzdHM6IHd0RGlyRXhpc3RzLFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGB3b3JrdHJlZS1vcnBoYW5lZCB0ZWxlbWV0cnkgZmFpbGVkIGZvciAke21pbGVzdG9uZUlkfTogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIE9ubHkgdGhlIFwiY29tcGxldGVcIiBzdGF0dXMgcGFydGljaXBhdGVzIGluIHRoZSBtZXJnZWQvdW5tZXJnZWQgY2xlYW51cFxuICAgIC8vIHBhdGhzIGJlbG93IFx1MjAxNCBvdGhlciBjbG9zZWQgc3RhdHVzZXMgKHBhcmtlZCwgZXRjLikgYXJlIGludGVudGlvbmFsbHlcbiAgICAvLyBsZWZ0IGFsb25lLlxuICAgIGlmIChtaWxlc3RvbmUuc3RhdHVzICE9PSBcImNvbXBsZXRlXCIpIGNvbnRpbnVlO1xuXG4gICAgaWYgKGlzTWVyZ2VkKSB7XG4gICAgICAvLyBCcmFuY2ggaXMgbWVyZ2VkIFx1MjAxNCBzYWZlIHRvIGRlbGV0ZSBicmFuY2ggYW5kIGNsZWFuIHVwIHdvcmt0cmVlIGRpclxuICAgICAgdHJ5IHtcbiAgICAgICAgbmF0aXZlQnJhbmNoRGVsZXRlKGJhc2VQYXRoLCBicmFuY2gsIHRydWUpO1xuICAgICAgICByZWNvdmVyZWQucHVzaChgRGVsZXRlZCBtZXJnZWQgYnJhbmNoICR7YnJhbmNofSBmb3IgY29tcGxldGVkIG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfS5gKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB3YXJuaW5ncy5wdXNoKGBGYWlsZWQgdG8gZGVsZXRlIG1lcmdlZCBicmFuY2ggJHticmFuY2h9OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2xlYW4gdXAgb3JwaGFuZWQgd29ya3RyZWUgZGlyZWN0b3J5IGlmIGl0IGV4aXN0c1xuICAgICAgY29uc3Qgd3REaXIgPSBnZXRXb3JrdHJlZURpcihiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMod3REaXIpKSB7XG4gICAgICAgIC8vIFRyeSBnaXQgd29ya3RyZWUgcmVtb3ZlIGZpcnN0IChoYW5kbGVzIHJlZ2lzdGVyZWQgd29ya3RyZWVzKVxuICAgICAgICB0cnkge1xuICAgICAgICAgIG5hdGl2ZVdvcmt0cmVlUmVtb3ZlKGJhc2VQYXRoLCB3dERpciwgdHJ1ZSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBOb3QgYSByZWdpc3RlcmVkIHdvcmt0cmVlIFx1MjAxNCBleHBlY3RlZCBmb3Igb3JwaGFuZWQgZGlyc1xuICAgICAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYHdvcmt0cmVlIHJlbW92ZSBmYWlsZWQgKGV4cGVjdGVkIGZvciBvcnBoYW5lZCBkaXJzKTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB0aGUgZGlyZWN0b3J5IHN0aWxsIGV4aXN0cyBhZnRlciBnaXQgd29ya3RyZWUgcmVtb3ZlIChlaXRoZXIgaXRcbiAgICAgICAgLy8gd2Fzbid0IHJlZ2lzdGVyZWQgb3IgdGhlIHJlbW92ZSB3YXMgYSBub29wKSwgZmFsbCBiYWNrIHRvIGRpcmVjdFxuICAgICAgICAvLyBmaWxlc3lzdGVtIHJlbW92YWwgXHUyMDE0IGJ1dCBvbmx5IGluc2lkZSAuZ3NkL3dvcmt0cmVlcy8gZm9yIHNhZmV0eSAoIzIzNjUpLlxuICAgICAgICBpZiAoZXhpc3RzU3luYyh3dERpcikpIHtcbiAgICAgICAgICBpZiAoaXNJbnNpZGVXb3JrdHJlZXNEaXIoYmFzZVBhdGgsIHd0RGlyKSkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgcm1TeW5jKHd0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgICAgICAgICAgIHJlY292ZXJlZC5wdXNoKGBSZW1vdmVkIG9ycGhhbmVkIHdvcmt0cmVlIGRpcmVjdG9yeSBmb3IgJHttaWxlc3RvbmVJZH0uYCk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnIyKSB7XG4gICAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goYEZhaWxlZCB0byByZW1vdmUgd29ya3RyZWUgZGlyZWN0b3J5IGZvciAke21pbGVzdG9uZUlkfTogJHtlcnIyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyMil9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHdhcm5pbmdzLnB1c2goYE9ycGhhbmVkIHdvcmt0cmVlIGRpcmVjdG9yeSBmb3IgJHttaWxlc3RvbmVJZH0gaXMgb3V0c2lkZSAuZ3NkL3dvcmt0cmVlcy8gXHUyMDE0IHNraXBwaW5nIHJlbW92YWwgZm9yIHNhZmV0eS5gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVjb3ZlcmVkLnB1c2goYFJlbW92ZWQgb3JwaGFuZWQgd29ya3RyZWUgZGlyZWN0b3J5IGZvciAke21pbGVzdG9uZUlkfS5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBCcmFuY2ggaXMgTk9UIG1lcmdlZCBcdTIwMTQgcHJlc2VydmUgZm9yIHNhZmV0eSwgd2FybiB0aGUgdXNlclxuICAgICAgd2FybmluZ3MucHVzaChcbiAgICAgICAgYEJyYW5jaCAke2JyYW5jaH0gZXhpc3RzIGZvciBjb21wbGV0ZWQgbWlsZXN0b25lICR7bWlsZXN0b25lSWR9IGJ1dCBpcyBOT1QgbWVyZ2VkIGludG8gJHttYWluQnJhbmNofS4gYCArXG4gICAgICAgIGBUaGlzIG1heSBjb250YWluIHVubWVyZ2VkIHdvcmsuIE1lcmdlIG1hbnVhbGx5IG9yIHJ1biBcXGAvZ3NkIGRvY3RvciBmaXhcXGAgdG8gcmVzb2x2ZS5gLFxuICAgICAgKTtcblxuICAgICAgLy8gIzQ3NjQgdGVsZW1ldHJ5XG4gICAgICB0cnkge1xuICAgICAgICBlbWl0V29ya3RyZWVPcnBoYW5lZChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHtcbiAgICAgICAgICByZWFzb246IFwiY29tcGxldGUtdW5tZXJnZWRcIixcbiAgICAgICAgICB3b3JrdHJlZURpckV4aXN0czogZXhpc3RzU3luYyhnZXRXb3JrdHJlZURpcihiYXNlUGF0aCwgbWlsZXN0b25lSWQpKSxcbiAgICAgICAgfSk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgd29ya3RyZWUtb3JwaGFuZWQgdGVsZW1ldHJ5IGZhaWxlZCBmb3IgJHttaWxlc3RvbmVJZH06ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFNlY29uZCBwYXNzICgjNTg3OSk6IGNhdGNoIHdvcmt0cmVlIGRpcmVjdG9yaWVzIHN0cmFuZGVkIGJ5IGEgcHJldmlvdXNcbiAgLy8gYXVkaXQgdGhhdCBkZWxldGVkIHRoZSBtaWxlc3RvbmUvKiBicmFuY2ggYnV0IGZhaWxlZCB0byByZW1vdmUgdGhlXG4gIC8vIGRpcmVjdG9yeSAob3IgdGhlIGRpciB3YXMgb3JwaGFuZWQgYnkgYSBzZXBhcmF0ZSBwYXRoIGVudGlyZWx5LCBlLmcuXG4gIC8vIHBvc3RmbGlnaHQtc3Rhc2gtcmVzdG9yZS1mYWlsZWQgZHVyaW5nIGNsb3Nlb3V0KS4gVGhlIGJyYW5jaC1rZXllZCBsb29wXG4gIC8vIGFib3ZlIGlzIGludmlzaWJsZSB0byB0aGVzZSBjYXNlcyBcdTIwMTQgYG5hdGl2ZUJyYW5jaExpc3RgIHJldHVybnMgbm90aGluZ1xuICAvLyBmb3IgdGhlIG1pbGVzdG9uZSwgc28gdGhlIGRpci1jbGVhbnVwIGJsb2NrIGF0IGxpbmUgfjMxMCBpcyBuZXZlclxuICAvLyByZWFjaGVkLlxuICAvL1xuICAvLyBLZXllZCBvbiBtaWxlc3RvbmVzIHdob3NlIERCIHN0YXR1cyBpcyBgY29tcGxldGVgLiBXZSBkbyBub3QgaXRlcmF0ZVxuICAvLyBvdmVyIGFyYml0cmFyeSBkaXJlY3RvcmllcyB1bmRlciAuZ3NkL3dvcmt0cmVlcy8gdG8gYXZvaWQgdG91Y2hpbmdcbiAgLy8gZGlycyB0aGF0IGJlbG9uZyB0byBhbiBpbi1wcm9ncmVzcyBtaWxlc3RvbmUgd2hvc2UgYnJhbmNoIHdhcyBkZWxldGVkXG4gIC8vIHNlcGFyYXRlbHkgXHUyMDE0IHRob3NlIGFyZSBoYW5kbGVkIGJ5IHRoZSBpbi1wcm9ncmVzcyBvcnBoYW4gcGF0aCBhYm92ZVxuICAvLyB3aGVuIHRoZSBicmFuY2ggaXMgcHJlc2VudCwgYW5kIGJ5IGAvZ3NkIGRvY3RvcmAgd2hlbiBpdCBpcyBub3QuXG4gIGNvbnN0IHNlZW5NaWxlc3RvbmVJZHMgPSBuZXcgU2V0KFxuICAgIG1pbGVzdG9uZUJyYW5jaGVzLm1hcCgoYnJhbmNoKSA9PiBicmFuY2gucmVwbGFjZSgvXm1pbGVzdG9uZVxcLy8sIFwiXCIpKSxcbiAgKTtcbiAgbGV0IGNvbXBsZXRlZE1pbGVzdG9uZXM6IHJlYWRvbmx5IHsgaWQ6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmcgfVtdID0gW107XG4gIHRyeSB7XG4gICAgY29tcGxldGVkTWlsZXN0b25lcyA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gREIgcmVhZCBmYWlsdXJlIFx1MjAxNCBza2lwIHRoZSBzZWNvbmQgcGFzczsgdGhlIGZpcnN0IHBhc3MgaXMgc3RpbGwgdXNlZnVsLlxuICAgIGNvbXBsZXRlZE1pbGVzdG9uZXMgPSBbXTtcbiAgfVxuICBmb3IgKGNvbnN0IG0gb2YgY29tcGxldGVkTWlsZXN0b25lcykge1xuICAgIGlmIChtLnN0YXR1cyAhPT0gXCJjb21wbGV0ZVwiKSBjb250aW51ZTtcbiAgICBpZiAoc2Vlbk1pbGVzdG9uZUlkcy5oYXMobS5pZCkpIGNvbnRpbnVlOyAvLyBhbHJlYWR5IHByb2Nlc3NlZCBpbiB0aGUgYnJhbmNoIGxvb3BcbiAgICBpZiAoIW1pbGVzdG9uZUJyYW5jaExpc3RBdmFpbGFibGUpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChicmFuY2hFeGlzdHMoYmFzZVBhdGgsIGBtaWxlc3RvbmUvJHttLmlkfWApKSBjb250aW51ZTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICB3YXJuaW5ncy5wdXNoKFxuICAgICAgICAgIGBDb3VsZCBub3QgdmVyaWZ5IHdoZXRoZXIgbWlsZXN0b25lLyR7bS5pZH0gc3RpbGwgZXhpc3RzOyBza2lwcGluZyBicmFuY2gtbGVzcyB3b3JrdHJlZSBjbGVhbnVwIGZvciBzYWZldHk6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICAgICk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCB3dERpciA9IGdldFdvcmt0cmVlRGlyKGJhc2VQYXRoLCBtLmlkKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMod3REaXIpKSBjb250aW51ZTtcbiAgICBpZiAoIWlzSW5zaWRlV29ya3RyZWVzRGlyKGJhc2VQYXRoLCB3dERpcikpIHtcbiAgICAgIHdhcm5pbmdzLnB1c2goXG4gICAgICAgIGBPcnBoYW5lZCB3b3JrdHJlZSBkaXJlY3RvcnkgZm9yICR7bS5pZH0gaXMgb3V0c2lkZSAuZ3NkL3dvcmt0cmVlcy8gXHUyMDE0IHNraXBwaW5nIHJlbW92YWwgZm9yIHNhZmV0eS5gLFxuICAgICAgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBUcnkgYGdpdCB3b3JrdHJlZSByZW1vdmVgIGZpcnN0IGluIGNhc2UgdGhlIGRpciBpcyBzdGlsbCByZWdpc3RlcmVkXG4gICAgLy8gKGRlZmVuc2l2ZSBcdTIwMTQgdXN1YWxseSBpdCBpcyBub3Qgd2hlbiB3ZSByZWFjaCB0aGlzIGJyYW5jaC1sZXNzIHBhc3MpLlxuICAgIHRyeSB7XG4gICAgICBuYXRpdmVXb3JrdHJlZVJlbW92ZShiYXNlUGF0aCwgd3REaXIsIHRydWUpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgIFwiZW5naW5lXCIsXG4gICAgICAgIGB3b3JrdHJlZSByZW1vdmUgZmFpbGVkIChleHBlY3RlZCBmb3IgYnJhbmNoLWxlc3Mgb3JwaGFucyk6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoZXhpc3RzU3luYyh3dERpcikpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJtU3luYyh3dERpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgICByZWNvdmVyZWQucHVzaChgUmVtb3ZlZCBvcnBoYW5lZCB3b3JrdHJlZSBkaXJlY3RvcnkgZm9yICR7bS5pZH0gKGJyYW5jaCBhbHJlYWR5IGRlbGV0ZWQpLmApO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHdhcm5pbmdzLnB1c2goXG4gICAgICAgICAgYEZhaWxlZCB0byByZW1vdmUgb3JwaGFuZWQgd29ya3RyZWUgZGlyZWN0b3J5IGZvciAke20uaWR9OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICByZWNvdmVyZWQucHVzaChgUmVtb3ZlZCBvcnBoYW5lZCB3b3JrdHJlZSBkaXJlY3RvcnkgZm9yICR7bS5pZH0gKGJyYW5jaCBhbHJlYWR5IGRlbGV0ZWQpLmApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IHJlY292ZXJlZCwgd2FybmluZ3MgfTtcbn1cblxuLyoqXG4gKiBQdXJlIGRlY2lzaW9uIGZ1bmN0aW9uIGZvciBwaWNraW5nIHdoaWNoIG9ycGhhbiBtaWxlc3RvbmUgdGhlIGF1dG8tbG9vcFxuICogc2hvdWxkIHJlc3VtZSB0aGUgbWVyZ2UgdHJhbnNpdGlvbiBmb3IuIEV4dHJhY3RlZCBzbyBpdCBjYW4gYmUgdW5pdC10ZXN0ZWRcbiAqIHdpdGhvdXQgc3Bpbm5pbmcgdXAgYSBnaXQgcmVwbyBvciBhIFNRTGl0ZSBEQi5cbiAqXG4gKiBSZXR1cm5zIHRoZSBsZXhpY29ncmFwaGljYWxseS1ncmVhdGVzdCBtaWxlc3RvbmUgaWQgKGUuZy4gXCJNMDAyXCIgYmVhdHNcbiAqIFwiTTAwMVwiKSB3aG9zZSBicmFuY2ggaXMgdW5tZXJnZWQgQU5EIGhhcyBjb21taXRzIGFoZWFkIG9mIG1haW4gQU5EIHdob3NlXG4gKiBzdGF0dXMgaXMgYGNvbXBsZXRlYC4gTGV4LW9yZGVyaW5nIG1hdGNoZXMgdGhlIHByb2plY3QncyBNMDB4IGNvbnZlbnRpb24sXG4gKiB3aGljaCBpcyB0aGUgbW9zdC1yZWNlbnRseS1jb21wbGV0ZWQgbWlsZXN0b25lIGluIHByYWN0aWNlLlxuICogYGlzQ29tcGxldGVgIGVycm9ycyBwcm9wYWdhdGU7IGBjb21taXRzQWhlYWRgIGVycm9ycyBhcmUgdHJlYXRlZCBhcyAwLlxuICovXG5leHBvcnQgZnVuY3Rpb24gX3NlbGVjdFJlc3VtYWJsZU1pbGVzdG9uZShcbiAgYnJhbmNoTmFtZXM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBtZXJnZWRCcmFuY2hlczogUmVhZG9ubHlTZXQ8c3RyaW5nPixcbiAgaXNDb21wbGV0ZTogKG1pbGVzdG9uZUlkOiBzdHJpbmcpID0+IGJvb2xlYW4sXG4gIGNvbW1pdHNBaGVhZDogKGJyYW5jaDogc3RyaW5nKSA9PiBudW1iZXIsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgY2FuZGlkYXRlczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBicmFuY2ggb2YgYnJhbmNoTmFtZXMpIHtcbiAgICBpZiAoIWJyYW5jaC5zdGFydHNXaXRoKFwibWlsZXN0b25lL1wiKSkgY29udGludWU7XG4gICAgY29uc3QgbWlsZXN0b25lSWQgPSBicmFuY2guc2xpY2UoXCJtaWxlc3RvbmUvXCIubGVuZ3RoKTtcbiAgICBpZiAobWVyZ2VkQnJhbmNoZXMuaGFzKGJyYW5jaCkpIGNvbnRpbnVlO1xuICAgIGlmICghaXNDb21wbGV0ZShtaWxlc3RvbmVJZCkpIGNvbnRpbnVlO1xuICAgIGxldCBhaGVhZCA9IDA7XG4gICAgdHJ5IHtcbiAgICAgIGFoZWFkID0gY29tbWl0c0FoZWFkKGJyYW5jaCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGFoZWFkIDw9IDApIGNvbnRpbnVlO1xuICAgIGNhbmRpZGF0ZXMucHVzaChtaWxlc3RvbmVJZCk7XG4gIH1cbiAgaWYgKGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgY2FuZGlkYXRlcy5zb3J0KCk7XG4gIHJldHVybiBjYW5kaWRhdGVzW2NhbmRpZGF0ZXMubGVuZ3RoIC0gMV07XG59XG5cbi8qKlxuICogRmluZCB0aGUgbW9zdC1yZWNlbnQgY29tcGxldGVkIG1pbGVzdG9uZSB3aG9zZSBicmFuY2ggc3RpbGwgaGFzIHVubWVyZ2VkXG4gKiBjb21taXRzIGFoZWFkIG9mIHRoZSBpbnRlZ3JhdGlvbiBicmFuY2guIFVzZWQgYnkgYGJvb3RzdHJhcEF1dG9TZXNzaW9uYFxuICogdG8gc2VlZCBgcy5jdXJyZW50TWlsZXN0b25lSWRgIHNvIHRoZSBhdXRvLWxvb3AncyB0cmFuc2l0aW9uIGd1YXJkIGF0XG4gKiBgcGhhc2VzLnRzOjczMGAgZmlyZXMgb24gdGhlIGZpcnN0IGl0ZXJhdGlvbiBhZnRlciBhIHByb2Nlc3MgcmVzdGFydCBcdTIwMTRcbiAqIHdpdGhvdXQgdGhpcywgdGhlIGluLW1lbW9yeS1vbmx5IGBzLmN1cnJlbnRNaWxlc3RvbmVJZGAgaXMgYG51bGxgIGFmdGVyXG4gKiByZXN0YXJ0LCB0aGUgZ3VhcmQgc2hvcnQtY2lyY3VpdHMsIGFuZCB0aGUgb3JwaGFuZWQgbWlsZXN0b25lIGJyYW5jaFxuICogbmV2ZXIgZ2V0cyBtZXJnZWQgaW50byBtYWluICgjNTUzOC1mb2xsb3d1cCkuXG4gKlxuICogUmV0dXJucyBudWxsIHdoZW4gaXNvbGF0aW9uIGlzIGBub25lYCwgdGhlIERCIGlzIHVuYXZhaWxhYmxlLCBvciBub1xuICogb3JwaGFuIGNhbmRpZGF0ZSBleGlzdHMuIEFsbCBnaXQgZmFpbHVyZXMgZGVncmFkZSBzaWxlbnRseSBcdTIwMTQgc3RhcnR1cFxuICogbXVzdCBuZXZlciBibG9jayBvbiB0aGlzIGRlZmVuc2l2ZSBsb29rdXAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kVW5tZXJnZWRDb21wbGV0ZWRNaWxlc3RvbmUoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIGlzb2xhdGlvbk1vZGU6IFwid29ya3RyZWVcIiB8IFwiYnJhbmNoXCIgfCBcIm5vbmVcIixcbik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoaXNvbGF0aW9uTW9kZSA9PT0gXCJub25lXCIpIHJldHVybiBudWxsO1xuICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIG51bGw7XG5cbiAgbGV0IG1pbGVzdG9uZUJyYW5jaGVzOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBtaWxlc3RvbmVCcmFuY2hlcyA9IG5hdGl2ZUJyYW5jaExpc3QoYmFzZVBhdGgsIFwibWlsZXN0b25lLypcIik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmIChtaWxlc3RvbmVCcmFuY2hlcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuXG4gIGxldCBtYWluQnJhbmNoOiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgbWFpbkJyYW5jaCA9IG5hdGl2ZURldGVjdE1haW5CcmFuY2goYmFzZVBhdGgpO1xuICB9IGNhdGNoIHtcbiAgICBtYWluQnJhbmNoID0gXCJtYWluXCI7XG4gIH1cblxuICBsZXQgbWVyZ2VkQnJhbmNoZXM6IFNldDxzdHJpbmc+O1xuICB0cnkge1xuICAgIG1lcmdlZEJyYW5jaGVzID0gbmV3IFNldChcbiAgICAgIG5hdGl2ZUJyYW5jaExpc3RNZXJnZWQoYmFzZVBhdGgsIG1haW5CcmFuY2gsIFwibWlsZXN0b25lLypcIiksXG4gICAgKTtcbiAgfSBjYXRjaCB7XG4gICAgbWVyZ2VkQnJhbmNoZXMgPSBuZXcgU2V0KCk7XG4gIH1cblxuICByZXR1cm4gX3NlbGVjdFJlc3VtYWJsZU1pbGVzdG9uZShcbiAgICBtaWxlc3RvbmVCcmFuY2hlcyxcbiAgICBtZXJnZWRCcmFuY2hlcyxcbiAgICAobWlsZXN0b25lSWQpID0+IHtcbiAgICAgIGNvbnN0IHJvdyA9IGdldE1pbGVzdG9uZShtaWxlc3RvbmVJZCk7XG4gICAgICByZXR1cm4gISFyb3cgJiYgcm93LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiO1xuICAgIH0sXG4gICAgKGJyYW5jaCkgPT4gbmF0aXZlQ29tbWl0Q291bnRCZXR3ZWVuKGJhc2VQYXRoLCBtYWluQnJhbmNoLCBicmFuY2gpLFxuICApO1xufVxuXG4vKipcbiAqIFJ1biBgbWVyZ2VBbmRFeGl0YCBmb3IgYSBtaWxlc3RvbmUgd2hvc2Ugd29ya3RyZWUvYnJhbmNoIGZpbmFsaXphdGlvblxuICogbmV2ZXIgY29tcGxldGVkIGluIGEgcHJpb3Igc2Vzc2lvbiBcdTIwMTQgdGhlIGFjdGl2ZS1taWxlc3RvbmUgaW4gcGhhc2VcbiAqIGBjb21wbGV0ZWAgd2l0aCBhIHN1cnZpdm9yIGBtaWxlc3RvbmUvPGlkPmAgYnJhbmNoIHN0aWxsIGFyb3VuZC5cbiAqXG4gKiBXcmFwcyB0aGUgY2FsbCBpbiB0cnkvY2F0Y2ggc28gYSB0aHJvd24gZXJyb3IgZnJvbSBgX21lcmdlQnJhbmNoTW9kZWBcbiAqIChtYWRlIGZhaWwtbG91ZCBpbiBjb21taXQgNjhlZjU4YTNjKSBpcyBjb252ZXJ0ZWQgaW50byBhIHVzZXItZmFjaW5nXG4gKiBlcnJvciBub3RpZnkgaW5zdGVhZCBvZiBhbiB1bmhhbmRsZWQgZXhjZXB0aW9uIHRoYXQgcHJvcGFnYXRlcyB0aHJvdWdoXG4gKiBgYm9vdHN0cmFwQXV0b1Nlc3Npb25gIHRvIHRoZSBzbGFzaC1jb21tYW5kIGNhbGxlcidzIGAuY2F0Y2hgIGJsb2NrLlxuICpcbiAqIFJldHVybnMgYHsgbWVyZ2VkOiB0cnVlIH1gIG9uIHN1Y2Nlc3M7IGB7IG1lcmdlZDogZmFsc2UsIGVycm9yIH1gIG9uXG4gKiB0aHJvdyBcdTIwMTQgY2FsbGVyIGRlY2lkZXMgd2hldGhlciB0byBhYm9ydCBib290c3RyYXAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfZmluYWxpemVTdXJ2aXZvckJyYW5jaChcbiAgbGlmZWN5Y2xlOiBXb3JrdHJlZUxpZmVjeWNsZSxcbiAgbWlsZXN0b25lSWQ6IHN0cmluZyxcbiAgdWk6IHsgbm90aWZ5OiAobXNnOiBzdHJpbmcsIGxldmVsPzogXCJpbmZvXCIgfCBcIndhcm5pbmdcIiB8IFwiZXJyb3JcIiB8IFwic3VjY2Vzc1wiKSA9PiB2b2lkIH0sXG4pOiB7IG1lcmdlZDogYm9vbGVhbjsgZXJyb3I/OiB1bmtub3duIH0ge1xuICB1aS5ub3RpZnkoXG4gICAgYE1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBpcyBjb21wbGV0ZSBidXQgYnJhbmNoL3dvcmt0cmVlIHdhcyBub3QgZmluYWxpemVkLiBSdW5uaW5nIG1lcmdlIG5vdy5gLFxuICAgIFwiaW5mb1wiLFxuICApO1xuICBjb25zdCByZXN1bHQgPSBsaWZlY3ljbGUuZXhpdE1pbGVzdG9uZShcbiAgICBtaWxlc3RvbmVJZCxcbiAgICB7IG1lcmdlOiB0cnVlIH0sXG4gICAgeyBub3RpZnk6IHVpLm5vdGlmeS5iaW5kKHVpKSB9LFxuICApO1xuICBpZiAocmVzdWx0Lm9rKSByZXR1cm4geyBtZXJnZWQ6IHRydWUgfTtcbiAgY29uc3QgZXJyID0gcmVzdWx0LmNhdXNlIGluc3RhbmNlb2YgRXJyb3IgPyByZXN1bHQuY2F1c2UgOiBuZXcgRXJyb3IoU3RyaW5nKHJlc3VsdC5jYXVzZSkpO1xuICBjb25zdCBtc2cgPSBlcnIubWVzc2FnZTtcbiAgdWkubm90aWZ5KFxuICAgIGBTdXJ2aXZvci1icmFuY2ggZmluYWxpemF0aW9uIGZvciAke21pbGVzdG9uZUlkfSBmYWlsZWQ6ICR7bXNnfS4gUmVzb2x2ZSBtYW51YWxseSBhbmQgcmUtcnVuIC9nc2QgYXV0by5gLFxuICAgIFwiZXJyb3JcIixcbiAgKTtcbiAgcmV0dXJuIHsgbWVyZ2VkOiBmYWxzZSwgZXJyb3I6IGVyciB9O1xufVxuXG4vKipcbiAqIE1lcmdlIGEgbWlsZXN0b25lIHdob3NlIERCIHJvdyBpcyBgY29tcGxldGVgIGJ1dCB3aG9zZSBicmFuY2ggaXMgc3RpbGxcbiAqIHVubWVyZ2VkIGludG8gdGhlIGludGVncmF0aW9uIGJyYW5jaC4gQ2FsbGVkIGZyb20gYGJvb3RzdHJhcEF1dG9TZXNzaW9uYFxuICogZm9yIG9ycGhhbnMgc3VyZmFjZWQgYnkgYGZpbmRVbm1lcmdlZENvbXBsZXRlZE1pbGVzdG9uZWAuXG4gKlxuICogTm90aWZpZXMgdGhlIHVzZXIgYmVmb3JlIGFuZCBhZnRlciwgc3dhbGxvd2luZyBlcnJvcnMgc28gYSB0cmFuc2llbnQgZ2l0XG4gKiBmYWlsdXJlIG5ldmVyIGJsb2NrcyBib290c3RyYXAuIFJldHVybnMgYHsgbWVyZ2VkOiB0cnVlIH1gIHdoZW4gdGhlXG4gKiB1bmRlcmx5aW5nIGBtZXJnZUFuZEV4aXRgIGNvbXBsZXRlczsgYHsgbWVyZ2VkOiBmYWxzZSwgZXJyb3IgfWAgb24gdGhyb3cuXG4gKlxuICogRXh0cmFjdGVkIHRvIGtlZXAgYGJvb3RzdHJhcEF1dG9TZXNzaW9uYCB0ZXN0YWJsZTogdGhlIG1lcmdlIGNhbGwgYW5kIHRoZVxuICogbm90aWZ5IHNoYXBlIGFyZSBleGVyY2lzZWQgYWdhaW5zdCBhIG1vY2sgcmVzb2x2ZXIgaW5cbiAqIGB0ZXN0cy9vcnBoYW4tbWVyZ2UtYm9vdHN0cmFwLnRlc3QudHNgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gX21lcmdlT3JwaGFuQ29tcGxldGVkTWlsZXN0b25lKFxuICBsaWZlY3ljbGU6IFdvcmt0cmVlTGlmZWN5Y2xlLFxuICBvcnBoYW5JZDogc3RyaW5nLFxuICB1aTogeyBub3RpZnk6IChtc2c6IHN0cmluZywgbGV2ZWw/OiBcImluZm9cIiB8IFwid2FybmluZ1wiIHwgXCJlcnJvclwiIHwgXCJzdWNjZXNzXCIpID0+IHZvaWQgfSxcbik6IHsgbWVyZ2VkOiBib29sZWFuOyBlcnJvcj86IHVua25vd24gfSB7XG4gIHVpLm5vdGlmeShgRGV0ZWN0ZWQgdW5tZXJnZWQgY29tcGxldGVkIG1pbGVzdG9uZSAke29ycGhhbklkfS4gTWVyZ2luZyBub3cuYCwgXCJpbmZvXCIpO1xuICBjb25zdCByZXN1bHQgPSBsaWZlY3ljbGUuZXhpdE1pbGVzdG9uZShcbiAgICBvcnBoYW5JZCxcbiAgICB7IG1lcmdlOiB0cnVlIH0sXG4gICAgeyBub3RpZnk6IHVpLm5vdGlmeS5iaW5kKHVpKSB9LFxuICApO1xuICBpZiAocmVzdWx0Lm9rKSByZXR1cm4geyBtZXJnZWQ6IHRydWUgfTtcbiAgY29uc3QgZXJyID0gcmVzdWx0LmNhdXNlIGluc3RhbmNlb2YgRXJyb3IgPyByZXN1bHQuY2F1c2UgOiBuZXcgRXJyb3IoU3RyaW5nKHJlc3VsdC5jYXVzZSkpO1xuICBjb25zdCBtc2cgPSBlcnIubWVzc2FnZTtcbiAgdWkubm90aWZ5KFxuICAgIGBDb3VsZCBub3QgbWVyZ2Ugb3JwaGFuIG1pbGVzdG9uZSAke29ycGhhbklkfTogJHttc2d9LiBSZXNvbHZlIG1hbnVhbGx5IGFuZCByZS1ydW4gL2dzZCBhdXRvLmAsXG4gICAgXCJ3YXJuaW5nXCIsXG4gICk7XG4gIHJldHVybiB7IG1lcmdlZDogZmFsc2UsIGVycm9yOiBlcnIgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGJvb3RzdHJhcEF1dG9TZXNzaW9uKFxuICBzOiBBdXRvU2Vzc2lvbixcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgYmFzZTogc3RyaW5nLFxuICB2ZXJib3NlTW9kZTogYm9vbGVhbixcbiAgcmVxdWVzdGVkU3RlcE1vZGU6IGJvb2xlYW4sXG4gIGRlcHM6IEJvb3RzdHJhcERlcHMsXG4gIGludGVycnVwdGVkOiBJbnRlcnJ1cHRlZFNlc3Npb25Bc3Nlc3NtZW50LFxuKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHtcbiAgICBzaG91bGRVc2VXb3JrdHJlZUlzb2xhdGlvbixcbiAgICByZWdpc3RlclNpZ3Rlcm1IYW5kbGVyLFxuICAgIHJlZ2lzdGVyQXV0b1dvcmtlckZvclNlc3Npb24sXG4gICAgbG9ja0Jhc2UsXG4gICAgYnVpbGRMaWZlY3ljbGUsXG4gIH0gPSBkZXBzO1xuXG4gIGNvbnN0IGRpckNoZWNrID0gdmFsaWRhdGVEaXJlY3RvcnkoYmFzZSk7XG4gIGlmIChkaXJDaGVjay5zZXZlcml0eSA9PT0gXCJibG9ja2VkXCIpIHtcbiAgICBjdHgudWkubm90aWZ5KGRpckNoZWNrLnJlYXNvbiEsIFwiZXJyb3JcIik7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgY29uc3QgbG9ja1Jlc3VsdCA9IGFjcXVpcmVTZXNzaW9uTG9jayhiYXNlKTtcbiAgaWYgKCFsb2NrUmVzdWx0LmFjcXVpcmVkKSB7XG4gICAgY3R4LnVpLm5vdGlmeShsb2NrUmVzdWx0LnJlYXNvbiwgXCJlcnJvclwiKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBmdW5jdGlvbiByZWxlYXNlTG9ja0FuZFJldHVybigpOiBmYWxzZSB7XG4gICAgcmVsZWFzZVNlc3Npb25Mb2NrKGJhc2UpO1xuICAgIGNsZWFyTG9jayhiYXNlKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBDYXB0dXJlIHRoZSB1c2VyJ3Mgc2Vzc2lvbiBtb2RlbCBiZWZvcmUgZ3VpZGVkLWZsb3cgZGlzcGF0Y2ggY2FuIGFwcGx5IGFcbiAgLy8gcGhhc2Utc3BlY2lmaWMgcGxhbm5pbmcgbW9kZWwgZm9yIGEgZGlzY3VzcyB0dXJuICgjMjgyOSkuXG4gIC8vXG4gIC8vIFByZWNlZGVuY2U6XG4gIC8vIDEpIEV4cGxpY2l0IHNlc3Npb24gb3ZlcnJpZGUgdmlhIC9nc2QgbW9kZWwgKHRoaXMgc2Vzc2lvbilcbiAgLy8gMikgQ3VycmVudCBzZXNzaW9uIG1vZGVsIGZyb20gc2V0dGluZ3Mvc2Vzc2lvbiByZXN0b3JlIChpZiBwcm92aWRlciByZWFkeSlcbiAgLy8gMykgR1NEIG1vZGVsIHByZWZlcmVuY2VzIGZyb20gUFJFRkVSRU5DRVMubWQgKHZhbGlkYXRlZCBhZ2FpbnN0IGxpdmUgYXV0aClcbiAgLy9cbiAgLy8gVGhpcyBwcmVzZXJ2ZXMgIzM1MTcgZGVmYXVsdHMgd2hpbGUgaG9ub3JpbmcgZXhwbGljaXQgcnVudGltZSBtb2RlbFxuICAvLyBzZWxlY3Rpb24gZm9yIHN1YnNlcXVlbnQgL2dzZCBydW5zIGluIHRoZSBzYW1lIHNlc3Npb24uXG4gIC8vXG4gIC8vIEV4Y2VwdGlvbiAoIzQxMjIpOiB3aGVuIHRoZSBzZXNzaW9uIHByb3ZpZGVyIGlzIGEgY3VzdG9tIHByb3ZpZGVyIGRlY2xhcmVkXG4gIC8vIGluIH4vLmdzZC9hZ2VudC9tb2RlbHMuanNvbiAoT2xsYW1hLCB2TExNLCBPcGVuQUktY29tcGF0aWJsZSBwcm94eSwgZXRjLiksXG4gIC8vIFBSRUZFUkVOQ0VTLm1kIGlzIHNraXBwZWQgZW50aXJlbHkuIFBSRUZFUkVOQ0VTLm1kIGNhbm5vdCByZWZlcmVuY2UgY3VzdG9tXG4gIC8vIHByb3ZpZGVycywgc28gaG9ub3JpbmcgaXQgd291bGQgc2lsZW50bHkgcmVyb3V0ZSBhdXRvLW1vZGUgdG8gYSBidWlsdC1pblxuICAvLyBwcm92aWRlciB0aGUgdXNlciBpcyBub3QgbG9nZ2VkIGludG8gYW5kIHN1cmZhY2UgYXMgXCJOb3QgbG9nZ2VkIGluIFx1MDBCNyBQbGVhc2VcbiAgLy8gcnVuIC9sb2dpblwiIGJlZm9yZSBwYXVzaW5nIGFuZCByZXNldHRpbmcgdG8gY2xhdWRlLWNvZGUvY2xhdWRlLXNvbm5ldC00LTYuXG4gIGNvbnN0IG1hbnVhbFNlc3Npb25PdmVycmlkZSA9IGdldFNlc3Npb25Nb2RlbE92ZXJyaWRlKGN0eC5zZXNzaW9uTWFuYWdlci5nZXRTZXNzaW9uSWQoKSk7XG4gIGNvbnN0IHNlc3Npb25Qcm92aWRlcklzQ3VzdG9tID0gaXNDdXN0b21Qcm92aWRlcihjdHgubW9kZWw/LnByb3ZpZGVyKTtcbiAgY29uc3QgcHJlZmVycmVkTW9kZWwgPSBzZXNzaW9uUHJvdmlkZXJJc0N1c3RvbVxuICAgID8gbnVsbFxuICAgIDogcmVzb2x2ZURlZmF1bHRTZXNzaW9uTW9kZWwoY3R4Lm1vZGVsPy5wcm92aWRlcik7XG4gIC8vIFZhbGlkYXRlIHRoZSBwcmVmZXJyZWQgbW9kZWwgYWdhaW5zdCB0aGUgbGl2ZSByZWdpc3RyeSArIHByb3ZpZGVyIGF1dGggc29cbiAgLy8gYW4gdW5jb25maWd1cmVkIFBSRUZFUkVOQ0VTLm1kIGVudHJ5IChubyBBUEkga2V5IC8gT0F1dGgpIGNhbid0IGJlY29tZSB0aGVcbiAgLy8gc3RhcnQtbW9kZWwgc25hcHNob3QuIFdpdGhvdXQgdGhpcywgZXZlcnkgc3Vic2VxdWVudCB1bml0IHdvdWxkIHRyeSB0b1xuICAvLyBmYWxsIGJhY2sgdG8gYW4gdW51c2FibGUgbW9kZWwuXG4gIGxldCB2YWxpZGF0ZWRQcmVmZXJyZWRNb2RlbDogeyBwcm92aWRlcjogc3RyaW5nOyBpZDogc3RyaW5nIH0gfCB1bmRlZmluZWQ7XG4gIGlmIChwcmVmZXJyZWRNb2RlbCkge1xuICAgIGNvbnN0IHsgcmVzb2x2ZU1vZGVsSWQgfSA9IGF3YWl0IGltcG9ydChcIi4vYXV0by1tb2RlbC1zZWxlY3Rpb24uanNcIik7XG4gICAgY29uc3QgYXZhaWxhYmxlID0gY3R4Lm1vZGVsUmVnaXN0cnkuZ2V0QXZhaWxhYmxlKCk7XG4gICAgY29uc3QgbWF0Y2ggPSByZXNvbHZlTW9kZWxJZChcbiAgICAgIGAke3ByZWZlcnJlZE1vZGVsLnByb3ZpZGVyfS8ke3ByZWZlcnJlZE1vZGVsLmlkfWAsXG4gICAgICBhdmFpbGFibGUsXG4gICAgICBjdHgubW9kZWw/LnByb3ZpZGVyLFxuICAgICk7XG4gICAgaWYgKG1hdGNoKSB7XG4gICAgICB2YWxpZGF0ZWRQcmVmZXJyZWRNb2RlbCA9IHsgcHJvdmlkZXI6IG1hdGNoLnByb3ZpZGVyLCBpZDogbWF0Y2guaWQgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYFByZWZlcnJlZCBtb2RlbCAke3ByZWZlcnJlZE1vZGVsLnByb3ZpZGVyfS8ke3ByZWZlcnJlZE1vZGVsLmlkfSBmcm9tIFBSRUZFUkVOQ0VTLm1kIGlzIG5vdCBjb25maWd1cmVkOyBmYWxsaW5nIGJhY2sgdG8gc2Vzc2lvbiBkZWZhdWx0LmAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgc2Vzc2lvbk1vZGVsUmVhZHkgPVxuICAgIGN0eC5tb2RlbCAmJiBjdHgubW9kZWxSZWdpc3RyeS5pc1Byb3ZpZGVyUmVxdWVzdFJlYWR5KGN0eC5tb2RlbC5wcm92aWRlcik7XG4gIGNvbnN0IGN1cnJlbnRTZXNzaW9uTW9kZWwgPSAoc2Vzc2lvbk1vZGVsUmVhZHkgJiYgY3R4Lm1vZGVsKVxuICAgID8geyBwcm92aWRlcjogY3R4Lm1vZGVsLnByb3ZpZGVyLCBpZDogY3R4Lm1vZGVsLmlkIH1cbiAgICA6IG51bGw7XG4gIGNvbnN0IHN0YXJ0VGhpbmtpbmdTbmFwc2hvdCA9IHBpLmdldFRoaW5raW5nTGV2ZWwoKTtcbiAgY29uc3Qgc3RhcnRNb2RlbFNuYXBzaG90ID0gbWFudWFsU2Vzc2lvbk92ZXJyaWRlXG4gICAgPz8gY3VycmVudFNlc3Npb25Nb2RlbFxuICAgID8/IHZhbGlkYXRlZFByZWZlcnJlZE1vZGVsXG4gICAgPz8gbnVsbDtcblxuICB0cnkge1xuICAgIC8vIFZhbGlkYXRlIEdTRF9QUk9KRUNUX0lEIGVhcmx5IHNvIHRoZSB1c2VyIGdldHMgaW1tZWRpYXRlIGZlZWRiYWNrXG4gICAgY29uc3QgY3VzdG9tUHJvamVjdElkID0gcHJvY2Vzcy5lbnYuR1NEX1BST0pFQ1RfSUQ7XG4gICAgaWYgKGN1c3RvbVByb2plY3RJZCAmJiAhdmFsaWRhdGVQcm9qZWN0SWQoY3VzdG9tUHJvamVjdElkKSkge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYEdTRF9QUk9KRUNUX0lEIG11c3QgY29udGFpbiBvbmx5IGFscGhhbnVtZXJpYyBjaGFyYWN0ZXJzLCBoeXBoZW5zLCBhbmQgdW5kZXJzY29yZXMuIEdvdDogXCIke2N1c3RvbVByb2plY3RJZH1cImAsXG4gICAgICAgIFwiZXJyb3JcIixcbiAgICAgICk7XG4gICAgICByZXR1cm4gcmVsZWFzZUxvY2tBbmRSZXR1cm4oKTtcbiAgICB9XG5cbiAgICBjb25zdCBnaXRMb2NrRmlsZSA9IGpvaW4oYmFzZSwgXCIuZ2l0XCIsIFwiaW5kZXgubG9ja1wiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhnaXRMb2NrRmlsZSkpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIFwiR2l0IGluZGV4IGxvY2sgaXMgcHJlc2VudCBhdCAuZ2l0L2luZGV4LmxvY2suIEFub3RoZXIgZ2l0IHByb2Nlc3MgbWF5IGJlIHJ1bm5pbmc7IHJlc29sdmUgdGhlIGxvY2sgYmVmb3JlIHN0YXJ0aW5nIEdTRC5cIixcbiAgICAgICAgXCJlcnJvclwiLFxuICAgICAgKTtcbiAgICAgIGRlYnVnTG9nKFwiZ2l0LWluZGV4LWxvY2stcHJlc2VudC1wcmVmbGlnaHRcIiwgeyBwYXRoOiBnaXRMb2NrRmlsZSB9KTtcbiAgICAgIHJldHVybiByZWxlYXNlTG9ja0FuZFJldHVybigpO1xuICAgIH1cblxuICAgIC8vIEVuc3VyZSBnaXQgcmVwbyBleGlzdHMgKmxvY2FsbHkqIGF0IGJhc2UuXG4gICAgLy8gbmF0aXZlSXNSZXBvKCkgdXNlcyBgZ2l0IHJldi1wYXJzZWAgd2hpY2ggdHJhdmVyc2VzIHVwIHRvIHBhcmVudCBkaXJzLFxuICAgIC8vIHNvIGEgcGFyZW50IHJlcG8gY2FuIG1ha2UgaXQgcmV0dXJuIHRydWUgZXZlbiB3aGVuIGJhc2UgaGFzIG5vIC5naXQgb2ZcbiAgICAvLyBpdHMgb3duLiBDaGVjayBmb3IgYSBsb2NhbCAuZ2l0IGluc3RlYWQgKGRlZmVuc2UtaW4tZGVwdGggZm9yIHRoZSBjYXNlXG4gICAgLy8gd2hlcmUgaXNJbmhlcml0ZWRSZXBvKCkgcmV0dXJucyBhIGZhbHNlIG5lZ2F0aXZlLCBlLmcuIHN0YWxlIC5nc2QgYXRcbiAgICAvLyB0aGUgcGFyZW50IGdpdCByb290KS4gU2VlICMyMzkzIGFuZCByZWxhdGVkIGlzc3VlLlxuICAgIGNvbnN0IGhhc0xvY2FsR2l0ID0gZXhpc3RzU3luYyhqb2luKGJhc2UsIFwiLmdpdFwiKSk7XG4gICAgaWYgKCFoYXNMb2NhbEdpdCB8fCBpc0luaGVyaXRlZFJlcG8oYmFzZSkpIHtcbiAgICAgIGNvbnN0IG1haW5CcmFuY2ggPVxuICAgICAgICBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoYmFzZSk/LnByZWZlcmVuY2VzPy5naXQ/Lm1haW5fYnJhbmNoIHx8IFwibWFpblwiO1xuICAgICAgbmF0aXZlSW5pdChiYXNlLCBtYWluQnJhbmNoKTtcbiAgICB9XG5cbiAgICAvLyBNaWdyYXRlIGxlZ2FjeSBpbi1wcm9qZWN0IC5nc2QvIHRvIGV4dGVybmFsIHN0YXRlIGRpcmVjdG9yeS5cbiAgICAvLyBNaWdyYXRpb24gTVVTVCBydW4gYmVmb3JlIGVuc3VyZUdpdGlnbm9yZSB0byBhdm9pZCBhZGRpbmcgXCIuZ3NkXCIgdG9cbiAgICAvLyAuZ2l0aWdub3JlIHdoZW4gLmdzZC8gaXMgZ2l0LXRyYWNrZWQgKGRhdGEtbG9zcyBidWcgIzEzNjQpLlxuICAgIHJlY292ZXJGYWlsZWRNaWdyYXRpb24oYmFzZSk7XG4gICAgY29uc3QgbWlncmF0aW9uID0gbWlncmF0ZVRvRXh0ZXJuYWxTdGF0ZShiYXNlKTtcbiAgICBpZiAobWlncmF0aW9uLmVycm9yKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBFeHRlcm5hbCBzdGF0ZSBtaWdyYXRpb24gd2FybmluZzogJHttaWdyYXRpb24uZXJyb3J9YCwgXCJ3YXJuaW5nXCIpO1xuICAgIH1cbiAgICAvLyBFbnN1cmUgc3ltbGluayBleGlzdHMgKGhhbmRsZXMgZnJlc2ggcHJvamVjdHMgYW5kIHBvc3QtbWlncmF0aW9uKVxuICAgIGVuc3VyZUdzZFN5bWxpbmsoYmFzZSk7XG5cbiAgICAvLyBFbnN1cmUgLmdpdGlnbm9yZSBoYXMgYmFzZWxpbmUgcGF0dGVybnMuXG4gICAgLy8gZW5zdXJlR2l0aWdub3JlIGNoZWNrcyBmb3IgZ2l0LXRyYWNrZWQgLmdzZC8gZmlsZXMgYW5kIHNraXBzIHRoZVxuICAgIC8vIFwiLmdzZFwiIHBhdHRlcm4gaWYgdGhlIHByb2plY3QgaW50ZW50aW9uYWxseSB0cmFja3MgLmdzZC8gaW4gZ2l0LlxuICAgIGNvbnN0IGdpdFByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKGJhc2UpPy5wcmVmZXJlbmNlcz8uZ2l0O1xuICAgIGNvbnN0IG1hbmFnZUdpdGlnbm9yZSA9IGdpdFByZWZzPy5tYW5hZ2VfZ2l0aWdub3JlO1xuICAgIGVuc3VyZUdpdGlnbm9yZShiYXNlLCB7IG1hbmFnZUdpdGlnbm9yZSB9KTtcbiAgICBpZiAobWFuYWdlR2l0aWdub3JlICE9PSBmYWxzZSkgdW50cmFja1J1bnRpbWVGaWxlcyhiYXNlKTtcblxuICAgIC8vIEJvb3RzdHJhcCBtaWxlc3RvbmVzLyBpZiBpdCBkb2Vzbid0IGV4aXN0LlxuICAgIC8vIENoZWNrIG1pbGVzdG9uZXMvIGRpcmVjdGx5IFx1MjAxNCBlbnN1cmVHc2RTeW1saW5rIGFib3ZlIGFscmVhZHkgY3JlYXRlZCAuZ3NkLyxcbiAgICAvLyBzbyBjaGVja2luZyAuZ3NkLyBleGlzdGVuY2Ugd291bGQgYmUgZGVhZCBjb2RlICgjMjk0MikuXG4gICAgY29uc3QgZ3NkRGlyID0gam9pbihiYXNlLCBcIi5nc2RcIik7XG4gICAgY29uc3QgbWlsZXN0b25lc1BhdGggPSBqb2luKGdzZERpciwgXCJtaWxlc3RvbmVzXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhtaWxlc3RvbmVzUGF0aCkpIHtcbiAgICAgIG1rZGlyU3luYyhtaWxlc3RvbmVzUGF0aCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICB0cnkge1xuICAgICAgICBuYXRpdmVBZGRBbGwoYmFzZSk7XG4gICAgICAgIG5hdGl2ZUNvbW1pdChiYXNlLCBcImNob3JlOiBpbml0IGdzZFwiKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAvKiBub3RoaW5nIHRvIGNvbW1pdCAqL1xuICAgICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBta2RpciBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIHtcbiAgICAgIGNvbnN0IHsgcHJlcGFyZVdvcmtmbG93TWNwRm9yUHJvamVjdCB9ID0gYXdhaXQgaW1wb3J0KFwiLi93b3JrZmxvdy1tY3AtYXV0by1wcmVwLmpzXCIpO1xuICAgICAgcHJlcGFyZVdvcmtmbG93TWNwRm9yUHJvamVjdChjdHgsIGJhc2UpO1xuICAgIH1cblxuICAgIC8vIEluaXRpYWxpemUgR2l0U2VydmljZUltcGxcbiAgICBzLmdpdFNlcnZpY2UgPSBuZXcgR2l0U2VydmljZUltcGwoXG4gICAgICBzLmJhc2VQYXRoLFxuICAgICAgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKGJhc2UpPy5wcmVmZXJlbmNlcz8uZ2l0ID8/IHt9LFxuICAgICk7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgRGVidWcgbW9kZSBcdTI1MDBcdTI1MDBcbiAgICBpZiAoIWlzRGVidWdFbmFibGVkKCkgJiYgcHJvY2Vzcy5lbnYuR1NEX0RFQlVHID09PSBcIjFcIikge1xuICAgICAgZW5hYmxlRGVidWcoYmFzZSk7XG4gICAgfVxuICAgIGlmIChpc0RlYnVnRW5hYmxlZCgpKSB7XG4gICAgICBjb25zdCB7IGlzTmF0aXZlUGFyc2VyQXZhaWxhYmxlIH0gPVxuICAgICAgICBhd2FpdCBpbXBvcnQoXCIuL25hdGl2ZS1wYXJzZXItYnJpZGdlLmpzXCIpO1xuICAgICAgZGVidWdMb2coXCJkZWJ1Zy1zdGFydFwiLCB7XG4gICAgICAgIHBsYXRmb3JtOiBwcm9jZXNzLnBsYXRmb3JtLFxuICAgICAgICBhcmNoOiBwcm9jZXNzLmFyY2gsXG4gICAgICAgIG5vZGU6IHByb2Nlc3MudmVyc2lvbixcbiAgICAgICAgbW9kZWw6IGN0eC5tb2RlbD8uaWQgPz8gXCJ1bmtub3duXCIsXG4gICAgICAgIHByb3ZpZGVyOiBjdHgubW9kZWw/LnByb3ZpZGVyID8/IFwidW5rbm93blwiLFxuICAgICAgICBuYXRpdmVQYXJzZXI6IGlzTmF0aXZlUGFyc2VyQXZhaWxhYmxlKCksXG4gICAgICAgIGN3ZDogYmFzZSxcbiAgICAgIH0pO1xuICAgICAgY3R4LnVpLm5vdGlmeShgRGVidWcgbG9nZ2luZyBlbmFibGVkIFx1MjE5MiAke2dldERlYnVnTG9nUGF0aCgpfWAsIFwiaW5mb1wiKTtcbiAgICB9XG5cbiAgICBpZiAoaW50ZXJydXB0ZWQuY2xhc3NpZmljYXRpb24gIT09IFwicmVjb3ZlcmFibGVcIikge1xuICAgICAgcy5wZW5kaW5nQ3Jhc2hSZWNvdmVyeSA9IG51bGw7XG4gICAgfVxuXG4gICAgLy8gSW52YWxpZGF0ZSBjYWNoZXMgYmVmb3JlIGluaXRpYWwgc3RhdGUgZGVyaXZhdGlvblxuICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICAgIC8vIE9wZW4gdGhlIHByb2plY3Qtcm9vdCBEQiBiZWZvcmUgZGVyaXZlU3RhdGUgc28gREItYmFja2VkIHN0YXRlXG4gICAgLy8gZGVyaXZhdGlvbiAocXVldWUtb3JkZXIsIHRhc2sgc3RhdHVzKSB3b3JrcyBvbiBhIGNvbGQgc3RhcnQgKCMyODQxKS5cbiAgICAvLyBNdXN0IGhhcHBlbiBiZWZvcmUgY2xlYW5TdGFsZVJ1bnRpbWVVbml0cyBzbyB0aGUgY2xlYW51cCBwcmVkaWNhdGUgY2FuXG4gICAgLy8gY29uc3VsdCBEQiBzdGF0dXMgYW5kIGF2b2lkIGNsZWFyaW5nIHJ1bnRpbWUgdW5pdHMgZm9yIG1pbGVzdG9uZXMgdGhhdFxuICAgIC8vIG9ubHkgaGF2ZSBhIGZhaWx1cmUtcGF0aCBTVU1NQVJZIG9uIGRpc2sgKCM0NjYzKS5cbiAgICBhd2FpdCBvcGVuUHJvamVjdERiSWZQcmVzZW50KGJhc2UpO1xuICAgIHJlZ2lzdGVyQXV0b1dvcmtlckZvclNlc3Npb24oYmFzZSk7XG5cbiAgICAvLyBDbGVhbiBzdGFsZSBydW50aW1lIHVuaXQgZmlsZXMgZm9yIGNvbXBsZXRlZCBtaWxlc3RvbmVzICgjODg3KS5cbiAgICAvLyBEQi1hdXRob3JpdGF0aXZlOiB3aGVuIERCIGlzIGF2YWlsYWJsZSwgcmVxdWlyZSBEQiBzdGF0dXMgdG8gYmUgY2xvc2VkXG4gICAgLy8gYmVmb3JlIGNsZWFyaW5nIHJ1bnRpbWUgdW5pdHMuIEEgU1VNTUFSWSBmaWxlIGFsb25lIGlzIG5vIGxvbmdlclxuICAgIC8vIHRydXN0ZWQgYXMgcHJvb2Ygb2YgY29tcGxldGlvbiAoIzQ2NjMpLiBGYWxsIGJhY2sgdG8gU1VNTUFSWS1maWxlXG4gICAgLy8gcHJlc2VuY2Ugb25seSB3aGVuIERCIGlzIHVuYXZhaWxhYmxlIChsZWdhY3kvcHJlLW1pZ3JhdGlvbikuXG4gICAgY2xlYW5TdGFsZVJ1bnRpbWVVbml0cyhcbiAgICAgIGdzZFJvb3QoYmFzZSksXG4gICAgICAobWlkKSA9PiB7XG4gICAgICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgICBjb25zdCByb3cgPSBnZXRNaWxlc3RvbmUobWlkKTtcbiAgICAgICAgICByZXR1cm4gISFyb3cgJiYgaXNDbG9zZWRTdGF0dXMocm93LnN0YXR1cyk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc3VtbWFyeUZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgICAgaWYgKCFzdW1tYXJ5RmlsZSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJldHVybiBjbGFzc2lmeU1pbGVzdG9uZVN1bW1hcnlDb250ZW50KHJlYWRGaWxlU3luYyhzdW1tYXJ5RmlsZSwgXCJ1dGYtOFwiKSkgIT09IFwiZmFpbHVyZVwiO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgKTtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCBPcnBoYW5lZCBtaWxlc3RvbmUgYnJhbmNoIGF1ZGl0IFx1MjUwMFx1MjUwMFxuICAgIC8vIENhdGNoZXMgY29tcGxldGVkIG1pbGVzdG9uZXMgd2hvc2UgdGVhcmRvd24gKG1lcmdlICsgYnJhbmNoIGRlbGV0ZSlcbiAgICAvLyB3YXMgbG9zdCBkdWUgdG8gc2Vzc2lvbiBlbmRpbmcgYmV0d2VlbiBjb21wbGV0aW9uIGFuZCB0ZWFyZG93bi5cbiAgICAvLyBNdXN0IHJ1biBhZnRlciBEQiBvcGVuIGFuZCBiZWZvcmUgd29ya3RyZWUgZW50cnkuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGF1ZGl0UmVzdWx0ID0gYXVkaXRPcnBoYW5lZE1pbGVzdG9uZUJyYW5jaGVzKGJhc2UsIGdldElzb2xhdGlvbk1vZGUoYmFzZSkpO1xuICAgICAgZm9yIChjb25zdCBtc2cgb2YgYXVkaXRSZXN1bHQucmVjb3ZlcmVkKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoYE9ycGhhbiBhdWRpdDogJHttc2d9YCwgXCJpbmZvXCIpO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBtc2cgb2YgYXVkaXRSZXN1bHQud2FybmluZ3MpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShgT3JwaGFuIGF1ZGl0OiAke21zZ31gLCBcIndhcm5pbmdcIik7XG4gICAgICB9XG4gICAgICBpZiAoYXVkaXRSZXN1bHQucmVjb3ZlcmVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZGVidWdMb2coXCJvcnBoYW4tYXVkaXRcIiwgeyByZWNvdmVyZWQ6IGF1ZGl0UmVzdWx0LnJlY292ZXJlZCwgd2FybmluZ3M6IGF1ZGl0UmVzdWx0Lndhcm5pbmdzIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgLy8gTm9uLWZhdGFsIFx1MjAxNCB0aGUgYXVkaXQgaXMgZGVmZW5zaXZlLCBuZXZlciBibG9jayBib290c3RyYXBcbiAgICAgIGxvZ1dhcm5pbmcoXCJib290c3RyYXBcIiwgYG9ycGhhbmVkIG1pbGVzdG9uZSBicmFuY2ggYXVkaXQgZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgT3JwaGFuZWQgcHJlZmxpZ2h0LXN0YXNoIGF1ZGl0ICgjNTUzOC1mb2xsb3d1cCkgXHUyNTAwXHUyNTAwXG4gICAgLy8gUmVhcHBsaWVzIHByZS1tZXJnZSBzdGFzaGVzIHdob3NlIG1pbGVzdG9uZSBpcyBub3cgY29tcGxldGUgYnV0IHdob3NlXG4gICAgLy8gcG9zdGZsaWdodCBwb3Agd2FzIHNraXBwZWQgYnkgYW4gaW50ZXJydXB0ZWQgbWVyZ2UgaW4gYSBwcmlvciBzZXNzaW9uLlxuICAgIC8vIFVzZXMgYGdpdCBzdGFzaCBhcHBseWAgKG5vdCBwb3ApIHNvIHRoZSBlbnRyeSByZW1haW5zIGFzIGEgYmFja3VwLlxuICAgIHRyeSB7XG4gICAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgIGNvbnN0IHN0YXNoQXVkaXQgPSBhdWRpdE9ycGhhbmVkUHJlZmxpZ2h0U3Rhc2hlcyhiYXNlLCAobWlsZXN0b25lSWQpID0+IHtcbiAgICAgICAgICBjb25zdCByb3cgPSBnZXRNaWxlc3RvbmUobWlsZXN0b25lSWQpO1xuICAgICAgICAgIHJldHVybiAhIXJvdyAmJiBpc0Nsb3NlZFN0YXR1cyhyb3cuc3RhdHVzKTtcbiAgICAgICAgfSk7XG4gICAgICAgIGZvciAoY29uc3QgZW50cnkgb2Ygc3Rhc2hBdWRpdC5hcHBsaWVkKSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBPcnBoYW4gYXVkaXQ6IGFwcGxpZWQgcHJlZmxpZ2h0IHN0YXNoICR7ZW50cnkuc3Rhc2hSZWZ9IGZvciBjb21wbGV0ZWQgbWlsZXN0b25lICR7ZW50cnkubWlsZXN0b25lSWR9LiBUaGUgc3Rhc2ggZW50cnkgaXMgcHJlc2VydmVkIGFzIGEgYmFja3VwLmAsXG4gICAgICAgICAgICBcImluZm9cIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgbXNnIG9mIHN0YXNoQXVkaXQud2FybmluZ3MpIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KGBPcnBoYW4gYXVkaXQ6ICR7bXNnfWAsIFwid2FybmluZ1wiKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoc3Rhc2hBdWRpdC5hcHBsaWVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBkZWJ1Z0xvZyhcIm9ycGhhbi1zdGFzaC1hdWRpdFwiLCB7XG4gICAgICAgICAgICBhcHBsaWVkOiBzdGFzaEF1ZGl0LmFwcGxpZWQsXG4gICAgICAgICAgICB3YXJuaW5nczogc3Rhc2hBdWRpdC53YXJuaW5ncyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgbG9nV2FybmluZyhcbiAgICAgICAgXCJib290c3RyYXBcIixcbiAgICAgICAgYG9ycGhhbmVkIHByZWZsaWdodC1zdGFzaCBhdWRpdCBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIGxldCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuXG4gICAgLy8gU3RhbGUgd29ya3RyZWUgc3RhdGUgcmVjb3ZlcnkgKCM2NTQpXG4gICAgaWYgKFxuICAgICAgc3RhdGUuYWN0aXZlTWlsZXN0b25lICYmXG4gICAgICBzaG91bGRVc2VXb3JrdHJlZUlzb2xhdGlvbihiYXNlKSAmJlxuICAgICAgIWRldGVjdFdvcmt0cmVlTmFtZShiYXNlKVxuICAgICkge1xuICAgICAgY29uc3Qgd3RQYXRoID0gZ2V0QXV0b1dvcmt0cmVlUGF0aChiYXNlLCBzdGF0ZS5hY3RpdmVNaWxlc3RvbmUuaWQpO1xuICAgICAgaWYgKHd0UGF0aCkge1xuICAgICAgICBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKHd0UGF0aCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gTWlsZXN0b25lIGJyYW5jaCByZWNvdmVyeSAoIzYwMSwgIzIzNTgpXG4gICAgLy8gRGV0ZWN0IHN1cnZpdm9yIG1pbGVzdG9uZSBicmFuY2hlcyBpbiBib3RoIHByZS1wbGFubmluZyBhbmQgY29tcGxldGUgcGhhc2VzLlxuICAgIC8vIEluIHBoYXNlPWNvbXBsZXRlLCB0aGUgbWlsZXN0b25lIGFydGlmYWN0cyBleGlzdCBidXQgZmluYWxpemF0aW9uIChtZXJnZSxcbiAgICAvLyB3b3JrdHJlZSBjbGVhbnVwKSB3YXMgbmV2ZXIgcnVuIFx1MjAxNCB0aGUgc3Vydml2b3IgYnJhbmNoIG11c3QgYmUgbWVyZ2VkLlxuICAgIC8vIEFwcGxpZXMgdG8gYm90aCB3b3JrdHJlZSBhbmQgYnJhbmNoIGlzb2xhdGlvbiBtb2Rlcy5cbiAgICBsZXQgaGFzU3Vydml2b3JCcmFuY2ggPSBmYWxzZTtcbiAgICBsZXQgc3Vydml2b3JNaWxlc3RvbmVJZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQgPz8gbnVsbDtcbiAgICBpZiAoIXN1cnZpdm9yTWlsZXN0b25lSWQgJiYgc3RhdGUucGhhc2UgPT09IFwiY29tcGxldGVcIikge1xuICAgICAgc3Vydml2b3JNaWxlc3RvbmVJZCA9IGZpbmRVbm1lcmdlZENvbXBsZXRlZE1pbGVzdG9uZShiYXNlLCBnZXRJc29sYXRpb25Nb2RlKGJhc2UpKTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgc3Vydml2b3JNaWxlc3RvbmVJZCAmJlxuICAgICAgKHN0YXRlLnBoYXNlID09PSBcInByZS1wbGFubmluZ1wiIHx8IHN0YXRlLnBoYXNlID09PSBcImNvbXBsZXRlXCIpICYmXG4gICAgICBnZXRJc29sYXRpb25Nb2RlKGJhc2UpICE9PSBcIm5vbmVcIiAmJlxuICAgICAgIWRldGVjdFdvcmt0cmVlTmFtZShiYXNlKSAmJlxuICAgICAgIWJhc2UuaW5jbHVkZXMoYCR7cGF0aFNlcH0uZ3NkJHtwYXRoU2VwfXdvcmt0cmVlcyR7cGF0aFNlcH1gKVxuICAgICkge1xuICAgICAgY29uc3QgbWlsZXN0b25lQnJhbmNoID0gYG1pbGVzdG9uZS8ke3N1cnZpdm9yTWlsZXN0b25lSWR9YDtcbiAgICAgIGNvbnN0IHsgbmF0aXZlQnJhbmNoRXhpc3RzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL25hdGl2ZS1naXQtYnJpZGdlLmpzXCIpO1xuICAgICAgaGFzU3Vydml2b3JCcmFuY2ggPSBuYXRpdmVCcmFuY2hFeGlzdHMoYmFzZSwgbWlsZXN0b25lQnJhbmNoKTtcbiAgICAgIGlmIChoYXNTdXJ2aXZvckJyYW5jaCkge1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIGBGb3VuZCBwcmlvciBzZXNzaW9uIGJyYW5jaCAke21pbGVzdG9uZUJyYW5jaH0uIFJlc3VtaW5nLmAsXG4gICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gU3Vydml2b3IgYnJhbmNoIGV4aXN0cyBidXQgbWlsZXN0b25lIHN0aWxsIG5lZWRzIGRpc2N1c3Npb24gKCMxNzI2KTpcbiAgICAvLyBUaGUgd29ya3RyZWUvYnJhbmNoIHdhcyBjcmVhdGVkIGJ1dCB0aGUgbWlsZXN0b25lIG9ubHkgaGFzIENPTlRFWFQtRFJBRlQubWQuXG4gICAgLy8gUm91dGUgdG8gdGhlIGludGVyYWN0aXZlIGRpc2N1c3Npb24gaGFuZGxlciBpbnN0ZWFkIG9mIGZhbGxpbmcgdGhyb3VnaCB0b1xuICAgIC8vIGF1dG8tbW9kZSwgd2hpY2ggd291bGQgaW1tZWRpYXRlbHkgc3RvcCB3aXRoIFwibmVlZHMgZGlzY3Vzc2lvblwiLlxuICAgIGlmIChkZWNpZGVTdXJ2aXZvckFjdGlvbihoYXNTdXJ2aXZvckJyYW5jaCwgc3RhdGUucGhhc2UpID09PSBcImRpc2N1c3NcIikge1xuICAgICAgY29uc3QgeyBzaG93U21hcnRFbnRyeSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9ndWlkZWQtZmxvdy5qc1wiKTtcbiAgICAgIGF3YWl0IHNob3dTbWFydEVudHJ5KGN0eCwgcGksIGJhc2UsIHsgc3RlcDogcmVxdWVzdGVkU3RlcE1vZGUgfSk7XG5cbiAgICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgICAgIGNvbnN0IHBvc3RTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgaWYgKFxuICAgICAgICBwb3N0U3RhdGUuYWN0aXZlTWlsZXN0b25lICYmXG4gICAgICAgIHBvc3RTdGF0ZS5waGFzZSAhPT0gXCJuZWVkcy1kaXNjdXNzaW9uXCJcbiAgICAgICkge1xuICAgICAgICBzdGF0ZSA9IHBvc3RTdGF0ZTtcbiAgICAgICAgLy8gRGlzY3Vzc2lvbiBzdWNjZWVkZWQgXHUyMDE0IGNsZWFyIHN1cnZpdm9yIGZsYWcgc28gbm9ybWFsIGZsb3cgY29udGludWVzXG4gICAgICAgIGhhc1N1cnZpdm9yQnJhbmNoID0gZmFsc2U7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIFwiRGlzY3Vzc2lvbiBjb21wbGV0ZWQgYnV0IG1pbGVzdG9uZSBkcmFmdCB3YXMgbm90IHByb21vdGVkLiBSdW4gL2dzZCB0byB0cnkgYWdhaW4uXCIsXG4gICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiByZWxlYXNlTG9ja0FuZFJldHVybigpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFN1cnZpdm9yIGJyYW5jaCBleGlzdHMgYW5kIG1pbGVzdG9uZSBpcyBjb21wbGV0ZSAoIzIzNTgpOlxuICAgIC8vIFRoZSBtaWxlc3RvbmUgYXJ0aWZhY3RzIHdlcmUgd3JpdHRlbiBidXQgZmluYWxpemF0aW9uIChtZXJnZSwgd29ya3RyZWVcbiAgICAvLyBjbGVhbnVwKSBuZXZlciByYW4uIFJ1biBtZXJnZUFuZEV4aXQgdG8gZmluYWxpemUsIHRoZW4gcmUtZGVyaXZlIHN0YXRlXG4gICAgLy8gc28gdGhlIG5vcm1hbCBcImFsbCBtaWxlc3RvbmVzIGNvbXBsZXRlXCIgb3IgXCJuZXh0IG1pbGVzdG9uZVwiIHBhdGggcnVucy5cbiAgICAvLyBSZS1ldmFsdWF0ZSB2aWEgdGhlIGhlbHBlciBcdTIwMTQgdGhlIGRpc2N1c3MgYnJhbmNoIGFib3ZlIG1heSBoYXZlIGNsZWFyZWRcbiAgICAvLyBoYXNTdXJ2aXZvckJyYW5jaCBhZnRlciBhIHN1Y2Nlc3NmdWwgcHJvbW90aW9uLlxuICAgIGlmIChkZWNpZGVTdXJ2aXZvckFjdGlvbihoYXNTdXJ2aXZvckJyYW5jaCwgc3RhdGUucGhhc2UpID09PSBcImZpbmFsaXplXCIpIHtcbiAgICAgIGNvbnN0IG1pZCA9IHN1cnZpdm9yTWlsZXN0b25lSWQhO1xuICAgICAgLy8gQ29tbWl0IDY4ZWY1OGEzYyBtYWRlIGBfbWVyZ2VCcmFuY2hNb2RlYCB0aHJvdyBvbiB3cm9uZy1icmFuY2hcbiAgICAgIC8vIGluc3RlYWQgb2YgcmV0dXJuaW5nIGZhbHNlIHNpbGVudGx5LiBXcmFwIHRoZSBjYWxsIHNvIHRoZSB0aHJvdyBpc1xuICAgICAgLy8gY29udmVydGVkIGludG8gYW4gZXJyb3Igbm90aWZ5ICsgY2xlYW4gYm9vdHN0cmFwIGFib3J0LCBub3QgYW5cbiAgICAgIC8vIHVuaGFuZGxlZCBleGNlcHRpb24gcHJvcGFnYXRpbmcgdG8gdGhlIHNsYXNoLWNvbW1hbmQgY2FsbGVyICgjNTU0OVxuICAgICAgLy8gcG9zdC1tZXJnZSBhdWRpdCwgUjIpLlxuICAgICAgY29uc3QgZmluYWxpemUgPSBfZmluYWxpemVTdXJ2aXZvckJyYW5jaChidWlsZExpZmVjeWNsZSgpLCBtaWQsIGN0eC51aSk7XG4gICAgICBpZiAoIWZpbmFsaXplLm1lcmdlZCkge1xuICAgICAgICByZXR1cm4gcmVsZWFzZUxvY2tBbmRSZXR1cm4oKTtcbiAgICAgIH1cbiAgICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgICAgIHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoYmFzZSk7XG4gICAgICAvLyBDbGVhciBzdXJ2aXZvciBmbGFnIFx1MjAxNCBmaW5hbGl6YXRpb24gaXMgZG9uZVxuICAgICAgaGFzU3Vydml2b3JCcmFuY2ggPSBmYWxzZTtcbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgT3JwaGFuLWNvbXBsZXRlZC1taWxlc3RvbmUgbWVyZ2UgKCM1NTM4LWZvbGxvd3VwKSBcdTI1MDBcdTI1MDBcbiAgICAvLyBBIHByb2Nlc3Mga2lsbGVkIGJldHdlZW4gYGNvbXBsZXRlLW1pbGVzdG9uZWAgKERCIGZsaXAgKyBTVU1NQVJZIHdyaXRlKVxuICAgIC8vIGFuZCB0aGUgbG9vcCdzIHRyYW5zaXRpb24tZ3VhcmQgbWVyZ2Ugc3RyYW5kcyB0aGUgbWlsZXN0b25lIGJyYW5jaFxuICAgIC8vIGZvcmV2ZXI6IGBzLmN1cnJlbnRNaWxlc3RvbmVJZGAgaXMgaW4tbWVtb3J5IG9ubHksIHNvIG9uIHRoZSBuZXh0XG4gICAgLy8gYm9vdHN0cmFwIHRoZSBndWFyZCBhdCBwaGFzZXMudHM6NzMwIHNlZXMgYG1pZCA9PT0gcy5jdXJyZW50TWlsZXN0b25lSWRgXG4gICAgLy8gYW5kIHNob3J0LWNpcmN1aXRzLlxuICAgIC8vXG4gICAgLy8gVGhlIGVhcmxpZXIgYXR0ZW1wdCBhdCB0aGlzIGZpeCBzZWVkZWQgYHMuY3VycmVudE1pbGVzdG9uZUlkYCB0byB0aGVcbiAgICAvLyBvcnBoYW4gaWQgcHJlLXN0YXRlLWRlcml2YXRpb24sIGJ1dCB0aGUgdW5jb25kaXRpb25hbCBhc3NpZ25tZW50IGF0XG4gICAgLy8gbGluZSA5NDggKGBzLmN1cnJlbnRNaWxlc3RvbmVJZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQgPz8gbnVsbGApXG4gICAgLy8gaW1tZWRpYXRlbHkgb3Zlcndyb3RlIHRoZSBzZWVkLiBBY3RpdmUtbWVyZ2UgaXMgdGhlIG1vcmUgZHVyYWJsZSBmaXg6XG4gICAgLy8gY2FsbCBgbWVyZ2VBbmRFeGl0YCBkaXJlY3RseSBkdXJpbmcgYm9vdHN0cmFwLCB0aGVuIHJlLWRlcml2ZSBzdGF0ZSBzb1xuICAgIC8vIHRoZSBsb29wJ3Mgbm9ybWFsIGZsb3cgY29udGludWVzIHdpdGhvdXQgYW4gaW4tbWVtb3J5IGhpbnQuXG4gICAgLy9cbiAgICAvLyBNaXJyb3JzIHRoZSBzdXJ2aXZvci1maW5hbGl6ZSBibG9jayBhYm92ZS4gRmFpbHVyZXMgZGVncmFkZSB0byBhXG4gICAgLy8gd2FybmluZyBub3RpZnkgc28gYSB0cmFuc2llbnQgZ2l0IGVycm9yIGRvZXNuJ3QgYmxvY2sgYm9vdHN0cmFwLlxuICAgIHtcbiAgICAgIGNvbnN0IG9ycGhhbiA9IGZpbmRVbm1lcmdlZENvbXBsZXRlZE1pbGVzdG9uZShiYXNlLCBnZXRJc29sYXRpb25Nb2RlKGJhc2UpKTtcbiAgICAgIGlmIChvcnBoYW4gJiYgb3JwaGFuICE9PSBzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkKSB7XG4gICAgICAgIC8vIEFEUi0wMTYgcGhhc2UgMiAvIEI0ICgjNTYyMik6IHRoZSBzd2FwLXJ1bi1yZXZlcnQgcHJvdG9jb2wgZm9yXG4gICAgICAgIC8vIHRoZSBvcnBoYW4tbWVyZ2UgZGFuY2UgaXMgb3duZWQgYnkgYGFkb3B0T3JwaGFuV29ya3RyZWVgLiBUaGVcbiAgICAgICAgLy8gdmVyYiBzbmFwc2hvdHMgcHJpb3IgYHMuYmFzZVBhdGhgIC8gYHMub3JpZ2luYWxCYXNlUGF0aGAsIHN3YXBzXG4gICAgICAgIC8vIGludG8gdGhlIG9ycGhhbiB3b3JrdHJlZSwgcnVucyB0aGUgbWVyZ2UgY2FsbGJhY2sgdW5kZXIgdGhlXG4gICAgICAgIC8vIHN3YXAsIGFuZCByZXZlcnRzIChvciBob2xkcyB0aGUgc3dhcCkgYmFzZWQgb24gdGhlIHJlc3VsdC5cbiAgICAgICAgLy8gQ2FsbGVycyBjYW4gbm8gbG9uZ2VyIGZvcmdldCB0aGUgcmV2ZXJ0IHN0ZXAgb24gZmFpbHVyZSBcdTIwMTQgdGhlXG4gICAgICAgIC8vIHBhdHRlcm4gdGhhdCBvcmlnaW5hbGx5IG1vdGl2YXRlZCB0aGlzIHZlcmIuXG4gICAgICAgIGNvbnN0IGxpZmVjeWNsZSA9IGJ1aWxkTGlmZWN5Y2xlKCk7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IGxpZmVjeWNsZS5hZG9wdE9ycGhhbldvcmt0cmVlKG9ycGhhbiwgYmFzZSwgKCkgPT5cbiAgICAgICAgICBfbWVyZ2VPcnBoYW5Db21wbGV0ZWRNaWxlc3RvbmUobGlmZWN5Y2xlLCBvcnBoYW4sIGN0eC51aSksXG4gICAgICAgICk7XG4gICAgICAgIGlmICghcmVzdWx0Lm1lcmdlZCkge1xuICAgICAgICAgIC8vIFZlcmIgYWxyZWFkeSByZXN0b3JlZCBiYXNlUGF0aC9vcmlnaW5hbEJhc2VQYXRoIHRvIGBiYXNlYCBhbmRcbiAgICAgICAgICAvLyBjaGRpcidkIHRoZXJlLiBSZXR1cm4gZWFybHkuXG4gICAgICAgICAgcmV0dXJuIHJlbGVhc2VMb2NrQW5kUmV0dXJuKCk7XG4gICAgICAgIH1cbiAgICAgICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgICBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2UpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGVmZmVjdGl2ZVByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKGJhc2UpPy5wcmVmZXJlbmNlcztcbiAgICBjb25zdCB7IHNob3VsZFJ1bkRlZXBQcm9qZWN0U2V0dXAgfSA9IGF3YWl0IGltcG9ydChcIi4vYXV0by1kaXNwYXRjaC5qc1wiKTtcbiAgICBjb25zdCBkZWVwUHJvamVjdFN0YWdlUGVuZGluZyA9IHNob3VsZFJ1bkRlZXBQcm9qZWN0U2V0dXAoXG4gICAgICBzdGF0ZSxcbiAgICAgIGVmZmVjdGl2ZVByZWZzLFxuICAgICAgYmFzZSxcbiAgICAgIHsgaGFzU3Vydml2b3JCcmFuY2ggfSxcbiAgICApO1xuXG4gICAgaWYgKGRlZXBQcm9qZWN0U3RhZ2VQZW5kaW5nKSB7XG4gICAgICAvLyBEZWVwIHByb2plY3QtbGV2ZWwgc2V0dXAgcnVucyBiZWZvcmUgdGhlIGZpcnN0IG1pbGVzdG9uZSBleGlzdHMuIExldFxuICAgICAgLy8gdGhlIGF1dG8gbG9vcCBkaXNwYXRjaCB3b3JrZmxvdy1wcmVmZXJlbmNlcyAvIHByb2plY3QgLyByZXF1aXJlbWVudHNcbiAgICAgIC8vIHVuaXRzIGluc3RlYWQgb2YgcmVjdXJzaW5nIGJhY2sgdGhyb3VnaCBzaG93U21hcnRFbnRyeSB3aGlsZSB0aGlzXG4gICAgICAvLyBib290c3RyYXAgc3RpbGwgaG9sZHMgdGhlIHNlc3Npb24gbG9jay5cbiAgICAgIHMuY3VycmVudE1pbGVzdG9uZUlkID0gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAoIWhhc1N1cnZpdm9yQnJhbmNoICYmICFkZWVwUHJvamVjdFN0YWdlUGVuZGluZykge1xuICAgICAgLy8gTm8gYWN0aXZlIHdvcmsgXHUyMDE0IHN0YXJ0IGEgbmV3IG1pbGVzdG9uZSB2aWEgZGlzY3VzcyBmbG93XG4gICAgICBpZiAoIXN0YXRlLmFjdGl2ZU1pbGVzdG9uZSB8fCBzdGF0ZS5waGFzZSA9PT0gXCJjb21wbGV0ZVwiKSB7XG4gICAgICAgIC8vIEd1YXJkIGFnYWluc3QgcmVjdXJzaXZlIGRpYWxvZyBsb29wICgjMTM0OCk6XG4gICAgICAgIC8vIElmIHdlJ3ZlIGVudGVyZWQgdGhpcyBicmFuY2ggbXVsdGlwbGUgdGltZXMgaW4gcXVpY2sgc3VjY2Vzc2lvbixcbiAgICAgICAgLy8gdGhlIGRpc2N1c3Mgd29ya2Zsb3cgaXNuJ3QgcHJvZHVjaW5nIGEgbWlsZXN0b25lLiBCcmVhayB0aGUgY3ljbGUuXG4gICAgICAgIHMuY29uc2VjdXRpdmVDb21wbGV0ZUJvb3RzdHJhcHMrKztcbiAgICAgICAgaWYgKHMuY29uc2VjdXRpdmVDb21wbGV0ZUJvb3RzdHJhcHMgPiBNQVhfQ09OU0VDVVRJVkVfQ09NUExFVEVfQk9PVFNUUkFQUykge1xuICAgICAgICAgIHMuY29uc2VjdXRpdmVDb21wbGV0ZUJvb3RzdHJhcHMgPSAwO1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICBcIkFsbCBtaWxlc3RvbmVzIGFyZSBjb21wbGV0ZSBhbmQgdGhlIGRpc2N1c3Npb24gZGlkbid0IHByb2R1Y2UgYSBuZXcgb25lLiBcIiArXG4gICAgICAgICAgICBcIlJ1biAvZ3NkIHRvIHN0YXJ0IGEgbmV3IG1pbGVzdG9uZSBtYW51YWxseS5cIixcbiAgICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIHJlbGVhc2VMb2NrQW5kUmV0dXJuKCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IHNob3dTbWFydEVudHJ5IH0gPSBhd2FpdCBpbXBvcnQoXCIuL2d1aWRlZC1mbG93LmpzXCIpO1xuICAgICAgICBhd2FpdCBzaG93U21hcnRFbnRyeShjdHgsIHBpLCBiYXNlLCB7IHN0ZXA6IHJlcXVlc3RlZFN0ZXBNb2RlIH0pO1xuXG4gICAgICAgIC8vIHNob3dTbWFydEVudHJ5IGRpc3BhdGNoZXMgdmlhIHBpLnNlbmRNZXNzYWdlKCkgd2hpY2ggaXMgZmlyZS1hbmQtZm9yZ2V0OlxuICAgICAgICAvLyBpdCBxdWV1ZXMgdGhlIG1lc3NhZ2UgYW5kIHJldHVybnMgaW1tZWRpYXRlbHksIGJlZm9yZSB0aGUgTExNIHR1cm4gcnVucy5cbiAgICAgICAgLy8gQ2hlY2tpbmcgcG9zdFN0YXRlIGhlcmUgd291bGQgYWx3YXlzIHNlZSB0aGUgcHJlLWRpc3BhdGNoIHN0YXRlLCBjYXVzaW5nXG4gICAgICAgIC8vIHRoZSBwcmVtYXR1cmUgXCJEaXNjdXNzaW9uIGNvbXBsZXRlZCBidXQuLi5cIiB3YXJuaW5nICgjMzQyMCkuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIGNoZWNrQXV0b1N0YXJ0QWZ0ZXJEaXNjdXNzIChpbiBndWlkZWQtZmxvdy50cykgYWxyZWFkeSBoYW5kbGVzIHJlLWVudGVyaW5nXG4gICAgICAgIC8vIGF1dG8tbW9kZSBieSBjYWxsaW5nIHN0YXJ0QXV0b0RldGFjaGVkIGFmdGVyIHRoZSBkaXNjdXNzaW9uIGNvbXBsZXRlcy5cbiAgICAgICAgLy8gUmVsZWFzZSB0aGUgbG9jayBhbmQgbGV0IHRoZSBhc3luYyBkaXNwYXRjaCBwcm9jZWVkLlxuICAgICAgICByZXR1cm4gcmVsZWFzZUxvY2tBbmRSZXR1cm4oKTtcbiAgICAgIH1cblxuICAgICAgLy8gQWN0aXZlIG1pbGVzdG9uZSBleGlzdHMgYnV0IGhhcyBubyByb2FkbWFwXG4gICAgICBpZiAoc3RhdGUucGhhc2UgPT09IFwicHJlLXBsYW5uaW5nXCIpIHtcbiAgICAgICAgY29uc3QgbWlkID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lIS5pZDtcbiAgICAgICAgY29uc3QgY29udGV4dEZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgICAgY29uc3QgaGFzQ29udGV4dCA9ICEhKGNvbnRleHRGaWxlICYmIChhd2FpdCBsb2FkRmlsZShjb250ZXh0RmlsZSkpKTtcbiAgICAgICAgaWYgKCFoYXNDb250ZXh0ICYmIGVmZmVjdGl2ZVByZWZzPy5wbGFubmluZ19kZXB0aCAhPT0gXCJkZWVwXCIpIHtcbiAgICAgICAgICBjb25zdCB7IHNob3dTbWFydEVudHJ5IH0gPSBhd2FpdCBpbXBvcnQoXCIuL2d1aWRlZC1mbG93LmpzXCIpO1xuICAgICAgICAgIGF3YWl0IHNob3dTbWFydEVudHJ5KGN0eCwgcGksIGJhc2UsIHsgc3RlcDogcmVxdWVzdGVkU3RlcE1vZGUgfSk7XG5cbiAgICAgICAgICAvLyBzaG93U21hcnRFbnRyeSBkaXNwYXRjaGVzIHZpYSBwaS5zZW5kTWVzc2FnZSgpIHdoaWNoIGlzIGZpcmUtYW5kLWZvcmdldDpcbiAgICAgICAgICAvLyBpdCBxdWV1ZXMgdGhlIG1lc3NhZ2UgYW5kIHJldHVybnMgaW1tZWRpYXRlbHksIGJlZm9yZSB0aGUgTExNIHR1cm4gcnVucy5cbiAgICAgICAgICAvLyBDaGVja2luZyBwb3N0U3RhdGUgaGVyZSBmaXJlcyBiZWZvcmUgdGhlIExMTSBoYXMgaGFkIGEgdHVybiwgc28gdGhlXG4gICAgICAgICAgLy8gcHJlLXBsYW5uaW5nIHBoYXNlIHdvdWxkIHN0aWxsIGFwcGVhciB1bmNoYW5nZWQgYW5kIGEgcHJlbWF0dXJlIHdhcm5pbmdcbiAgICAgICAgICAvLyB3b3VsZCBiZSBlbWl0dGVkICgjMzQyMCkuXG4gICAgICAgICAgLy9cbiAgICAgICAgICAvLyBjaGVja0F1dG9TdGFydEFmdGVyRGlzY3VzcyAoaW4gZ3VpZGVkLWZsb3cudHMpIGFscmVhZHkgaGFuZGxlcyByZS1lbnRlcmluZ1xuICAgICAgICAgIC8vIGF1dG8tbW9kZSBieSBjYWxsaW5nIHN0YXJ0QXV0b0RldGFjaGVkIGFmdGVyIHRoZSBkaXNjdXNzaW9uIGNvbXBsZXRlcy5cbiAgICAgICAgICAvLyBSZWxlYXNlIHRoZSBsb2NrIGFuZCBsZXQgdGhlIGFzeW5jIGRpc3BhdGNoIHByb2NlZWQuXG4gICAgICAgICAgcmV0dXJuIHJlbGVhc2VMb2NrQW5kUmV0dXJuKCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gQWN0aXZlIG1pbGVzdG9uZSBoYXMgQ09OVEVYVC1EUkFGVCBidXQgbm8gZnVsbCBjb250ZXh0IFx1MjAxNCBuZWVkcyBkaXNjdXNzaW9uXG4gICAgICBpZiAoc3RhdGUucGhhc2UgPT09IFwibmVlZHMtZGlzY3Vzc2lvblwiKSB7XG4gICAgICAgIGNvbnN0IHsgc2hvd1NtYXJ0RW50cnkgfSA9IGF3YWl0IGltcG9ydChcIi4vZ3VpZGVkLWZsb3cuanNcIik7XG4gICAgICAgIGF3YWl0IHNob3dTbWFydEVudHJ5KGN0eCwgcGksIGJhc2UsIHsgc3RlcDogcmVxdWVzdGVkU3RlcE1vZGUgfSk7XG5cbiAgICAgICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgICBjb25zdCBwb3N0U3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShiYXNlKTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHBvc3RTdGF0ZS5hY3RpdmVNaWxlc3RvbmUgJiZcbiAgICAgICAgICBwb3N0U3RhdGUucGhhc2UgIT09IFwibmVlZHMtZGlzY3Vzc2lvblwiXG4gICAgICAgICkge1xuICAgICAgICAgIHN0YXRlID0gcG9zdFN0YXRlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICBcIkRpc2N1c3Npb24gY29tcGxldGVkIGJ1dCBtaWxlc3RvbmUgZHJhZnQgd2FzIG5vdCBwcm9tb3RlZC4gUnVuIC9nc2QgdG8gdHJ5IGFnYWluLlwiLFxuICAgICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4gcmVsZWFzZUxvY2tBbmRSZXR1cm4oKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFVucmVhY2hhYmxlIHNhZmV0eSBjaGVja1xuICAgIGlmICghc3RhdGUuYWN0aXZlTWlsZXN0b25lICYmICFkZWVwUHJvamVjdFN0YWdlUGVuZGluZykge1xuICAgICAgY29uc3QgeyBzaG93U21hcnRFbnRyeSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9ndWlkZWQtZmxvdy5qc1wiKTtcbiAgICAgIGF3YWl0IHNob3dTbWFydEVudHJ5KGN0eCwgcGksIGJhc2UsIHsgc3RlcDogcmVxdWVzdGVkU3RlcE1vZGUgfSk7XG4gICAgICByZXR1cm4gcmVsZWFzZUxvY2tBbmRSZXR1cm4oKTtcbiAgICB9XG5cbiAgICAvLyBTdWNjZXNzZnVsbHkgcmVzb2x2ZWQgYW4gYWN0aXZlIG1pbGVzdG9uZSBcdTIwMTQgcmVzZXQgdGhlIHJlLWVudHJ5IGd1YXJkXG4gICAgcy5jb25zZWN1dGl2ZUNvbXBsZXRlQm9vdHN0cmFwcyA9IDA7XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgSW5pdGlhbGl6ZSBzZXNzaW9uIHN0YXRlIFx1MjUwMFx1MjUwMFxuICAgIC8vIE5vdGlmeSBzaGFyZWQgcGhhc2Ugc3RhdGUgc28gc3ViYWdlbnQgY29uZmxpY3QgY2hlY2tzIGNhbiBmaXJlXG4gICAgY29uc3QgeyBhY3RpdmF0ZUdTRDogYWN0aXZhdGVHU0RQaGFzZVN0YXRlIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9zaGFyZWQvZ3NkLXBoYXNlLXN0YXRlLmpzXCIpO1xuICAgIGFjdGl2YXRlR1NEUGhhc2VTdGF0ZSgpO1xuICAgIHMuYWN0aXZlID0gdHJ1ZTtcbiAgICBzLnN0ZXBNb2RlID0gcmVxdWVzdGVkU3RlcE1vZGU7XG4gICAgcy52ZXJib3NlID0gdmVyYm9zZU1vZGU7XG4gICAgcy5jbWRDdHggPSBjdHg7XG4gICAgLy8gQURSLTAxNiBwaGFzZSAyIC8gQjIgKCM1NjIwKTogc2luZ2xlIG93bmVyIG9mIGJvb3RzdHJhcCBiYXNlUGF0aFxuICAgIC8vIG11dGF0aW9uLiBTZXRzIHMuYmFzZVBhdGggPSBiYXNlIGFuZCBzLm9yaWdpbmFsQmFzZVBhdGggPSBiYXNlXG4gICAgLy8gKG9yaWdpbmFsQmFzZVBhdGggaXMgZW1wdHkgb24gYSBmcmVzaCBib290c3RyYXApLlxuICAgIGJ1aWxkTGlmZWN5Y2xlKCkuYWRvcHRTZXNzaW9uUm9vdChiYXNlKTtcbiAgICBzLnVuaXREaXNwYXRjaENvdW50LmNsZWFyKCk7XG4gICAgcy51bml0UmVjb3ZlcnlDb3VudC5jbGVhcigpO1xuICAgIHMubGFzdEJ1ZGdldEFsZXJ0TGV2ZWwgPSAwO1xuICAgIHMudW5pdExpZmV0aW1lRGlzcGF0Y2hlcy5jbGVhcigpO1xuICAgIHJlc2V0SG9va1N0YXRlKCk7XG4gICAgcmVzdG9yZUhvb2tTdGF0ZShiYXNlKTtcbiAgICByZXNldFByb2FjdGl2ZUhlYWxpbmcoKTtcbiAgICAvLyBOb3RpZnkgdXNlciBvbiBoZWFsdGggbGV2ZWwgdHJhbnNpdGlvbnMgKGdyZWVuXHUyMTkyeWVsbG93XHUyMTkycmVkIGFuZCBiYWNrKVxuICAgIHNldExldmVsQ2hhbmdlQ2FsbGJhY2soKF9mcm9tLCB0bywgc3VtbWFyeSkgPT4ge1xuICAgICAgY29uc3QgbGV2ZWwgPSB0byA9PT0gXCJyZWRcIiA/IFwiZXJyb3JcIiA6IHRvID09PSBcInllbGxvd1wiID8gXCJ3YXJuaW5nXCIgOiBcImluZm9cIjtcbiAgICAgIGN0eC51aS5ub3RpZnkoc3VtbWFyeSwgbGV2ZWwgYXMgXCJpbmZvXCIgfCBcIndhcm5pbmdcIiB8IFwiZXJyb3JcIik7XG4gICAgfSk7XG4gICAgcy5hdXRvU3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcbiAgICBzLnJlc291cmNlVmVyc2lvbk9uU3RhcnQgPSByZWFkUmVzb3VyY2VWZXJzaW9uKCk7XG4gICAgcy5wZW5kaW5nUXVpY2tUYXNrcyA9IFtdO1xuICAgIHMuY3VycmVudFVuaXQgPSBudWxsO1xuICAgIHMuY3VycmVudE1pbGVzdG9uZUlkID8/PSBkZWVwUHJvamVjdFN0YWdlUGVuZGluZyA/IG51bGwgOiBzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkID8/IG51bGw7XG4gICAgcy5vcmlnaW5hbE1vZGVsSWQgPSBzdGFydE1vZGVsU25hcHNob3Q/LmlkID8/IGN0eC5tb2RlbD8uaWQgPz8gbnVsbDtcbiAgICBzLm9yaWdpbmFsTW9kZWxQcm92aWRlciA9IHN0YXJ0TW9kZWxTbmFwc2hvdD8ucHJvdmlkZXIgPz8gY3R4Lm1vZGVsPy5wcm92aWRlciA/PyBudWxsO1xuICAgIHMub3JpZ2luYWxUaGlua2luZ0xldmVsID0gc3RhcnRUaGlua2luZ1NuYXBzaG90ID8/IG51bGw7XG5cbiAgICAvLyBSZWdpc3RlciBTSUdURVJNIGhhbmRsZXJcbiAgICByZWdpc3RlclNpZ3Rlcm1IYW5kbGVyKGJhc2UpO1xuXG4gICAgLy8gQ2FwdHVyZSBpbnRlZ3JhdGlvbiBicmFuY2hcbiAgICBpZiAocy5jdXJyZW50TWlsZXN0b25lSWQpIHtcbiAgICAgIGlmIChnZXRJc29sYXRpb25Nb2RlKGJhc2UpICE9PSBcIm5vbmVcIikge1xuICAgICAgICBjYXB0dXJlSW50ZWdyYXRpb25CcmFuY2goYmFzZSwgcy5jdXJyZW50TWlsZXN0b25lSWQpO1xuICAgICAgfVxuICAgICAgc2V0QWN0aXZlTWlsZXN0b25lSWQoYmFzZSwgcy5jdXJyZW50TWlsZXN0b25lSWQpO1xuICAgIH1cblxuICAgIC8vIEd1YXJkIGFnYWluc3Qgc3RhbGUgbWlsZXN0b25lIGJyYW5jaCB3aGVuIGlzb2xhdGlvbjpub25lICgjMzYxMykuXG4gICAgLy8gQSBwcmlvciBzZXNzaW9uIHdpdGggaXNvbGF0aW9uOmJyYW5jaC93b3JrdHJlZSBtYXkgaGF2ZSBsZWZ0IEhFQUQgb25cbiAgICAvLyBtaWxlc3RvbmUvPE1JRD4uIEF1dG8tY2hlY2tvdXQgYmFjayB0byB0aGUgaW50ZWdyYXRpb24gYnJhbmNoLlxuICAgIGNvbnN0IGlzb2xhdGlvbk1vZGUgPSBnZXRJc29sYXRpb25Nb2RlKGJhc2UpO1xuICAgIGNvbnN0IGlzUmVwbyA9IG5hdGl2ZUlzUmVwbyhiYXNlKTtcbiAgICBpZiAoaXNvbGF0aW9uTW9kZSA9PT0gXCJub25lXCIgJiYgaXNSZXBvKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBjdXJyZW50QnJhbmNoID0gbmF0aXZlR2V0Q3VycmVudEJyYW5jaChiYXNlKTtcbiAgICAgICAgY29uc3QgaW50ZWdyYXRpb25CcmFuY2ggPSBuYXRpdmVEZXRlY3RNYWluQnJhbmNoKGJhc2UpO1xuICAgICAgICBjb25zdCBicmFuY2hUb0NoZWNrb3V0ID0gcmVzb2x2ZUlzb2xhdGlvbk5vbmVCcmFuY2hDaGVja291dChcbiAgICAgICAgICBjdXJyZW50QnJhbmNoLFxuICAgICAgICAgIGludGVncmF0aW9uQnJhbmNoLFxuICAgICAgICAgIGlzb2xhdGlvbk1vZGUsXG4gICAgICAgICAgaXNSZXBvLFxuICAgICAgICApO1xuICAgICAgICBpZiAoYnJhbmNoVG9DaGVja291dCkge1xuICAgICAgICAgIG5hdGl2ZUNoZWNrb3V0QnJhbmNoKGJhc2UsIGJyYW5jaFRvQ2hlY2tvdXQpO1xuICAgICAgICAgIGxvZ1dhcm5pbmcoXCJib290c3RyYXBcIiwgYFJldHVybmVkIHRvIFwiJHticmFuY2hUb0NoZWNrb3V0fVwiIFx1MjAxNCBIRUFEIHdhcyBvbiBzdGFsZSBtaWxlc3RvbmUgYnJhbmNoIFwiJHtjdXJyZW50QnJhbmNofVwiIChpc29sYXRpb246IG5vbmUgZG9lcyBub3QgdXNlIG1pbGVzdG9uZSBicmFuY2hlcykuYCk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBsb2dXYXJuaW5nKFwiYm9vdHN0cmFwXCIsIGBDb3VsZCBub3QgYXV0by1jaGVja291dCBmcm9tIHN0YWxlIG1pbGVzdG9uZSBicmFuY2g6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBBdXRvLXdvcmt0cmVlIHNldHVwIFx1MjUwMFx1MjUwMFxuICAgIC8vIHMub3JpZ2luYWxCYXNlUGF0aCB3YXMgc2V0IHRvIGBiYXNlYCBieSBgYWRvcHRTZXNzaW9uUm9vdChiYXNlKWAgYWJvdmVcbiAgICAvLyAoQURSLTAxNiBwaGFzZSAyIC8gQjIsICM1NjIwKS4gVGhlIHJlZHVuZGFudCBhc3NpZ25tZW50IHRoYXQgdXNlZCB0b1xuICAgIC8vIGxpdmUgaGVyZSBpcyBnb25lLlxuXG4gICAgY29uc3QgaXNVbmRlckdzZFdvcmt0cmVlcyA9IChwOiBzdHJpbmcpOiBib29sZWFuID0+IHtcbiAgICAgIC8vIERpcmVjdCBsYXlvdXQ6IC8uZ3NkL3dvcmt0cmVlcy9cbiAgICAgIGNvbnN0IG1hcmtlciA9IGAke3BhdGhTZXB9LmdzZCR7cGF0aFNlcH13b3JrdHJlZXMke3BhdGhTZXB9YDtcbiAgICAgIGlmIChwLmluY2x1ZGVzKG1hcmtlcikpIHJldHVybiB0cnVlO1xuICAgICAgY29uc3Qgd29ya3RyZWVzU3VmZml4ID0gYCR7cGF0aFNlcH0uZ3NkJHtwYXRoU2VwfXdvcmt0cmVlc2A7XG4gICAgICBpZiAocC5lbmRzV2l0aCh3b3JrdHJlZXNTdWZmaXgpKSByZXR1cm4gdHJ1ZTtcbiAgICAgIC8vIFN5bWxpbmstcmVzb2x2ZWQgbGF5b3V0OiAvLmdzZC9wcm9qZWN0cy88aGFzaD4vd29ya3RyZWVzL1xuICAgICAgY29uc3Qgc3ltbGlua1JlID0gbmV3IFJlZ0V4cChcbiAgICAgICAgYFxcXFwke3BhdGhTZXB9XFxcXC5nc2RcXFxcJHtwYXRoU2VwfXByb2plY3RzXFxcXCR7cGF0aFNlcH1bYS1mMC05XStcXFxcJHtwYXRoU2VwfXdvcmt0cmVlcyg/OlxcXFwke3BhdGhTZXB9fCQpYCxcbiAgICAgICk7XG4gICAgICByZXR1cm4gc3ltbGlua1JlLnRlc3QocCk7XG4gICAgfTtcblxuICAgIGlmIChcbiAgICAgIHMuY3VycmVudE1pbGVzdG9uZUlkICYmXG4gICAgICBnZXRJc29sYXRpb25Nb2RlKGJhc2UpICE9PSBcIm5vbmVcIiAmJlxuICAgICAgIWRldGVjdFdvcmt0cmVlTmFtZShiYXNlKSAmJlxuICAgICAgIWlzVW5kZXJHc2RXb3JrdHJlZXMoYmFzZSlcbiAgICApIHtcbiAgICAgIGNvbnN0IGVudGVyUmVzdWx0ID0gYnVpbGRMaWZlY3ljbGUoKS5lbnRlck1pbGVzdG9uZShzLmN1cnJlbnRNaWxlc3RvbmVJZCwge1xuICAgICAgICBub3RpZnk6IGN0eC51aS5ub3RpZnkuYmluZChjdHgudWkpLFxuICAgICAgfSk7XG4gICAgICBpZiAoIWVudGVyUmVzdWx0Lm9rKSB7XG4gICAgICAgIHMuYWN0aXZlID0gZmFsc2U7XG4gICAgICAgIGlmIChlbnRlclJlc3VsdC5yZWFzb24gPT09IFwibGVhc2UtY29uZmxpY3RcIikge1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICBgQ2Fubm90IGVudGVyIG1pbGVzdG9uZSAke3MuY3VycmVudE1pbGVzdG9uZUlkfTogbGVhc2UgaXMgaGVsZCBieSBhbm90aGVyIHdvcmtlci5gLFxuICAgICAgICAgICAgXCJlcnJvclwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSBpZiAoZW50ZXJSZXN1bHQucmVhc29uID09PSBcImNyZWF0aW9uLWZhaWxlZFwiKSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBDYW5ub3QgZW50ZXIgbWlsZXN0b25lICR7cy5jdXJyZW50TWlsZXN0b25lSWR9OiB3b3JrdHJlZS9icmFuY2ggY3JlYXRpb24gZmFpbGVkLiBJc29sYXRpb24gaXMgZGVncmFkZWQuYCxcbiAgICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2UgaWYgKGVudGVyUmVzdWx0LnJlYXNvbiA9PT0gXCJpbnZhbGlkLW1pbGVzdG9uZS1pZFwiKSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBDYW5ub3QgZW50ZXIgbWlsZXN0b25lICR7cy5jdXJyZW50TWlsZXN0b25lSWR9OiBtaWxlc3RvbmUgaWQgaXMgaW52YWxpZC5gLFxuICAgICAgICAgICAgXCJlcnJvclwiLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBBdXRvLW1vZGUgYm9vdHN0cmFwIHN0b3BwZWQ6IGZhaWxlZCB0byBlbnRlciBtaWxlc3RvbmUgJHtzLmN1cnJlbnRNaWxlc3RvbmVJZH0gKCR7ZW50ZXJSZXN1bHQucmVhc29ufSkuYCxcbiAgICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZWxlYXNlTG9ja0FuZFJldHVybigpO1xuICAgICAgfVxuICAgICAgaWYgKHMuYmFzZVBhdGggIT09IGJhc2UpIHtcbiAgICAgICAgLy8gU3VjY2Vzc2Z1bGx5IGVudGVyZWQgd29ya3RyZWUgXHUyMDE0IHJlLXJlZ2lzdGVyIFNJR1RFUk0gaGFuZGxlciBhdCBvcmlnaW5hbCBiYXNlXG4gICAgICAgIHJlZ2lzdGVyU2lndGVybUhhbmRsZXIocy5vcmlnaW5hbEJhc2VQYXRoKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBcdTI1MDBcdTI1MDAgREIgbGlmZWN5Y2xlIFx1MjUwMFx1MjUwMFxuICAgIGNvbnN0IGdzZERiUGF0aCA9IHJlc29sdmVQcm9qZWN0Um9vdERiUGF0aChzLmJhc2VQYXRoKTtcbiAgICBjb25zdCBnc2REaXJQYXRoID0gam9pbihzLmJhc2VQYXRoLCBcIi5nc2RcIik7XG4gICAgaWYgKGV4aXN0c1N5bmMoZ3NkRGlyUGF0aCkgJiYgIWV4aXN0c1N5bmMoZ3NkRGJQYXRoKSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyBvcGVuRGF0YWJhc2U6IG9wZW5EYiB9ID0gYXdhaXQgaW1wb3J0KFwiLi9nc2QtZGIuanNcIik7XG4gICAgICAgIG9wZW5EYihnc2REYlBhdGgpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGxvZ0Vycm9yKFwiZW5naW5lXCIsIGBmYWlsZWQgdG8gaW5pdGlhbGl6ZSBwcm9qZWN0IGRhdGFiYXNlOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChfc2hvdWxkQWJvcnRCb290c3RyYXBGb3JVbmF2YWlsYWJsZURiRm9yVGVzdChnc2REYlBhdGgsIGlzRGJBdmFpbGFibGUoKSkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgb3BlbkRhdGFiYXNlOiBvcGVuRGIgfSA9IGF3YWl0IGltcG9ydChcIi4vZ3NkLWRiLmpzXCIpO1xuICAgICAgICBvcGVuRGIoZ3NkRGJQYXRoKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBsb2dFcnJvcihcImVuZ2luZVwiLCBgZmFpbGVkIHRvIG9wZW4gZXhpc3RpbmcgZGF0YWJhc2U6ICR7KGVyciBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBHYXRlOiBhYm9ydCBib290c3RyYXAgaWYgdGhlIERCIGZpbGUgZXhpc3RzIGJ1dCB0aGUgcHJvdmlkZXIgaXNcbiAgICAvLyBzdGlsbCB1bmF2YWlsYWJsZSBhZnRlciBib3RoIG9wZW4gYXR0ZW1wdHMgYWJvdmUuIFdpdGhvdXQgdGhpcyxcbiAgICAvLyBhdXRvLW1vZGUgc3RhcnRzIGJ1dCBldmVyeSBnc2RfdGFza19jb21wbGV0ZSAvIGdzZF9zbGljZV9jb21wbGV0ZVxuICAgIC8vIGNhbGwgcmV0dXJucyBcImRiX3VuYXZhaWxhYmxlXCIsIHRyaWdnZXJpbmcgYXJ0aWZhY3QtcmV0cnkgd2hpY2hcbiAgICAvLyByZS1kaXNwYXRjaGVzIHRoZSBzYW1lIHRhc2sgXHUyMDE0IHByb2R1Y2luZyBhbiBpbmZpbml0ZSBsb29wICgjMjQxOSkuXG4gICAgaWYgKGV4aXN0c1N5bmMoZ3NkRGJQYXRoKSAmJiAhaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICBjb25zdCBkYlN0YXR1cyA9IGdldERiU3RhdHVzKCk7XG4gICAgICBjb25zdCBwaGFzZUhpbnQgPSBkYlN0YXR1cy5sYXN0UGhhc2UgPT09IFwib3BlblwiXG4gICAgICAgID8gXCJUaGUgZGF0YWJhc2UgZmlsZSBjb3VsZCBub3QgYmUgb3BlbmVkXCJcbiAgICAgICAgOiBkYlN0YXR1cy5sYXN0UGhhc2UgPT09IFwiaW5pdFNjaGVtYVwiXG4gICAgICAgICAgPyBcIlRoZSBkYXRhYmFzZSBzY2hlbWEgY291bGQgbm90IGJlIGluaXRpYWxpemVkXCJcbiAgICAgICAgICA6IGRiU3RhdHVzLmxhc3RQaGFzZSA9PT0gXCJ2YWN1dW0tcmVjb3ZlcnlcIlxuICAgICAgICAgICAgPyBcIkNvcnJ1cHRpb24gcmVjb3ZlcnkgKFZBQ1VVTSkgZmFpbGVkXCJcbiAgICAgICAgICAgIDogZGJTdGF0dXMuYXR0ZW1wdGVkXG4gICAgICAgICAgICAgID8gXCJUaGUgZGF0YWJhc2UgY291bGQgbm90IGJlIG9wZW5lZCAocGhhc2UgdW5rbm93bilcIlxuICAgICAgICAgICAgICA6IFwiVGhlIGRhdGFiYXNlIHByb3ZpZGVyIGNvdWxkIG5vdCBiZSBsb2FkZWRcIjtcbiAgICAgIGNvbnN0IGVycm9yRGV0YWlsID0gZGJTdGF0dXMubGFzdEVycm9yID8gYCAoJHtkYlN0YXR1cy5sYXN0RXJyb3IubWVzc2FnZX0pYCA6IFwiXCI7XG4gICAgICBjb25zdCBwcm92aWRlckhpbnQgPSBkYlN0YXR1cy5wcm92aWRlclxuICAgICAgICA/IGAgUHJvdmlkZXI6ICR7ZGJTdGF0dXMucHJvdmlkZXJ9LmBcbiAgICAgICAgOiBcIiBObyBTUUxpdGUgcHJvdmlkZXIgYXZhaWxhYmxlIFx1MjAxNCBjaGVjayBOb2RlID49IDIyIG9yIGluc3RhbGwgYmV0dGVyLXNxbGl0ZTMuXCI7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgU1FMaXRlIGRhdGFiYXNlIGV4aXN0cyBidXQgZmFpbGVkIHRvIG9wZW46ICR7Z3NkRGJQYXRofS4gJHtwaGFzZUhpbnR9JHtlcnJvckRldGFpbH0uJHtwcm92aWRlckhpbnR9YCxcbiAgICAgICAgXCJlcnJvclwiLFxuICAgICAgKTtcbiAgICAgIHJldHVybiByZWxlYXNlTG9ja0FuZFJldHVybigpO1xuICAgIH1cblxuICAgIC8vIEluaXRpYWxpemUgbWV0cmljc1xuICAgIGluaXRNZXRyaWNzKHMuYmFzZVBhdGgpO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSByb3V0aW5nIGhpc3RvcnlcbiAgICBpbml0Um91dGluZ0hpc3Rvcnkocy5iYXNlUGF0aCk7XG5cbiAgICAvLyBSZXN0b3JlIHRoZSBtb2RlbCB0aGF0IHdhcyBhY3RpdmUgd2hlbiBhdXRvIGJvb3RzdHJhcCBiZWdhbiAoIzY1MCwgIzI4MjkpLlxuICAgIGlmIChzdGFydE1vZGVsU25hcHNob3QpIHtcbiAgICAgIHMuYXV0b01vZGVTdGFydE1vZGVsID0ge1xuICAgICAgICBwcm92aWRlcjogc3RhcnRNb2RlbFNuYXBzaG90LnByb3ZpZGVyLFxuICAgICAgICBpZDogc3RhcnRNb2RlbFNuYXBzaG90LmlkLFxuICAgICAgfTtcbiAgICB9XG4gICAgcy5hdXRvTW9kZVN0YXJ0VGhpbmtpbmdMZXZlbCA9IHN0YXJ0VGhpbmtpbmdTbmFwc2hvdCA/PyBudWxsO1xuICAgIHMubWFudWFsU2Vzc2lvbk1vZGVsT3ZlcnJpZGUgPSBtYW51YWxTZXNzaW9uT3ZlcnJpZGUgPz8gbnVsbDtcblxuICAgIC8vIEFwcGx5IHdvcmtlciBtb2RlbCBvdmVycmlkZSBmcm9tIHBhcmFsbGVsIG9yY2hlc3RyYXRvciAoI3dvcmtlci1tb2RlbCkuXG4gICAgLy8gR1NEX1dPUktFUl9NT0RFTCBpcyBpbmplY3RlZCBieSB0aGUgY29vcmRpbmF0b3Igd2hlbiBwYXJhbGxlbC53b3JrZXJfbW9kZWxcbiAgICAvLyBpcyBjb25maWd1cmVkLCBzbyBwYXJhbGxlbCBtaWxlc3RvbmUgd29ya2VycyB1c2UgYSBjaGVhcGVyIG1vZGVsIHRoYW4gdGhlXG4gICAgLy8gY29vcmRpbmF0b3Igc2Vzc2lvbiAoZS5nLiBIYWlrdSBmb3IgZXhlY3V0aW9uLCBTb25uZXQgZm9yIHBsYW5uaW5nKS5cbiAgICBjb25zdCB3b3JrZXJNb2RlbE92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuR1NEX1dPUktFUl9NT0RFTDtcbiAgICBpZiAod29ya2VyTW9kZWxPdmVycmlkZSAmJiBwcm9jZXNzLmVudi5HU0RfUEFSQUxMRUxfV09SS0VSID09PSBcIjFcIikge1xuICAgICAgY29uc3QgYXZhaWxhYmxlTW9kZWxzID0gY3R4Lm1vZGVsUmVnaXN0cnkuZ2V0QXZhaWxhYmxlKCk7XG4gICAgICBjb25zdCB7IHJlc29sdmVNb2RlbElkIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2F1dG8tbW9kZWwtc2VsZWN0aW9uLmpzXCIpO1xuICAgICAgY29uc3Qgb3ZlcnJpZGVNb2RlbCA9IHJlc29sdmVNb2RlbElkKHdvcmtlck1vZGVsT3ZlcnJpZGUsIGF2YWlsYWJsZU1vZGVscywgY3R4Lm1vZGVsPy5wcm92aWRlcik7XG4gICAgICBpZiAob3ZlcnJpZGVNb2RlbCkge1xuICAgICAgICBjb25zdCBvayA9IGF3YWl0IHBpLnNldE1vZGVsKG92ZXJyaWRlTW9kZWwsIHsgcGVyc2lzdDogZmFsc2UgfSk7XG4gICAgICAgIGlmIChvaykge1xuICAgICAgICAgIC8vIFVwZGF0ZSBzdGFydCBtb2RlbCBzbyBhbGwgc3Vic2VxdWVudCB1bml0cyB1c2UgdGhpcyBhcyB0aGUgYmFzZWxpbmVcbiAgICAgICAgICBzLmF1dG9Nb2RlU3RhcnRNb2RlbCA9IHsgcHJvdmlkZXI6IG92ZXJyaWRlTW9kZWwucHJvdmlkZXIsIGlkOiBvdmVycmlkZU1vZGVsLmlkIH07XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShgV29ya2VyIG1vZGVsIG92ZXJyaWRlOiAke292ZXJyaWRlTW9kZWwucHJvdmlkZXJ9LyR7b3ZlcnJpZGVNb2RlbC5pZH1gLCBcImluZm9cIik7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBTbmFwc2hvdCBpbnN0YWxsZWQgc2tpbGxzXG4gICAgaWYgKHJlc29sdmVTa2lsbERpc2NvdmVyeU1vZGUoYmFzZSkgIT09IFwib2ZmXCIpIHtcbiAgICAgIHNuYXBzaG90U2tpbGxzKCk7XG4gICAgfVxuXG4gICAgY3R4LnVpLnNldFN0YXR1cyhcImdzZC1hdXRvXCIsIHMuc3RlcE1vZGUgPyBcIm5leHRcIiA6IFwiYXV0b1wiKTtcbiAgICBjdHgudWkuc2V0V2lkZ2V0KFwiZ3NkLWhlYWx0aFwiLCB1bmRlZmluZWQpO1xuICAgIGNvbnN0IG1vZGVMYWJlbCA9IHMuc3RlcE1vZGUgPyBcIlN0ZXAtbW9kZVwiIDogXCJBdXRvLW1vZGVcIjtcbiAgICBjb25zdCBwZW5kaW5nQ291bnQgPSAoc3RhdGUucmVnaXN0cnkgPz8gW10pLmZpbHRlcihcbiAgICAgIChtKSA9PiBtLnN0YXR1cyAhPT0gXCJjb21wbGV0ZVwiICYmIG0uc3RhdHVzICE9PSBcInBhcmtlZFwiLFxuICAgICkubGVuZ3RoO1xuICAgIGNvbnN0IHNjb3BlTXNnID1cbiAgICAgIGRlZXBQcm9qZWN0U3RhZ2VQZW5kaW5nXG4gICAgICAgID8gXCJXaWxsIHJ1biBwcm9qZWN0IHNldHVwIGJlZm9yZSBtaWxlc3RvbmUgcGxhbm5pbmcuXCJcbiAgICAgICAgOiBwZW5kaW5nQ291bnQgPiAxXG4gICAgICAgID8gYFdpbGwgbG9vcCB0aHJvdWdoICR7cGVuZGluZ0NvdW50fSBtaWxlc3RvbmVzLmBcbiAgICAgICAgOiBcIldpbGwgbG9vcCB1bnRpbCBtaWxlc3RvbmUgY29tcGxldGUuXCI7XG4gICAgY3R4LnVpLm5vdGlmeShgJHttb2RlTGFiZWx9IHN0YXJ0ZWQuICR7c2NvcGVNc2d9YCwgXCJpbmZvXCIpO1xuXG4gICAgY29uc3QgcHJvdmlkZXJSZXBvcnRlZFdpbmRvdyA9IGN0eC5tb2RlbD8uY29udGV4dFdpbmRvdyA/PyAwO1xuICAgIGNvbnN0IGNvbnRleHRPdmVycmlkZSA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhiYXNlKT8ucHJlZmVyZW5jZXMuY29udGV4dF93aW5kb3dfb3ZlcnJpZGU7XG4gICAgaWYgKHByb3ZpZGVyUmVwb3J0ZWRXaW5kb3cgPiA1MDBfMDAwICYmIGNvbnRleHRPdmVycmlkZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgTW9kZWwgcmVwb3J0cyBhICR7TWF0aC5yb3VuZChwcm92aWRlclJlcG9ydGVkV2luZG93IC8gMTAwMCl9SyBjb250ZXh0IHdpbmRvdy4gSWYgdGhlIHByb3ZpZGVyJ3MgcmVhbCBBUEkgbGltaXQgaXMgbG93ZXIsIHNldCBjb250ZXh0X3dpbmRvd19vdmVycmlkZSBpbiAuZ3NkL1BSRUZFUkVOQ0VTLm1kIHNvIHdyYXAtdXAgc2lnbmFscyBmaXJlIGJlZm9yZSBjb250ZXh0IG92ZXJmbG93LmAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBTaG93IGR5bmFtaWMgcm91dGluZyBzdGF0dXMgc28gdXNlcnMga25vdyB1cGZyb250IGlmIG1vZGVscyB3aWxsIGJlXG4gICAgLy8gZG93bmdyYWRlZCBmb3Igc2ltcGxlIHRhc2tzICgjMzk2MikuXG4gICAgLy8gVXNlIHRoZSBzYW1lIGVmZmVjdGl2ZSBsb2dpYyBhcyBzZWxlY3RBbmRBcHBseU1vZGVsOiBjaGVjayBmbGF0LXJhdGVcbiAgICAvLyBwcm92aWRlciBzdXBwcmVzc2lvbiBhbmQgcmVzb2x2ZSB0aGUgYWN0dWFsIGNlaWxpbmcgbW9kZWwuXG4gICAgY29uc3Qgcm91dGluZ0NvbmZpZyA9IHJlc29sdmVEeW5hbWljUm91dGluZ0NvbmZpZygpO1xuICAgIGNvbnN0IHN0YXJ0TW9kZWxMYWJlbCA9IHMuYXV0b01vZGVTdGFydE1vZGVsXG4gICAgICA/IGAke3MuYXV0b01vZGVTdGFydE1vZGVsLnByb3ZpZGVyfS8ke3MuYXV0b01vZGVTdGFydE1vZGVsLmlkfWBcbiAgICAgIDogY3R4Lm1vZGVsID8gYCR7Y3R4Lm1vZGVsLnByb3ZpZGVyfS8ke2N0eC5tb2RlbC5pZH1gIDogXCJkZWZhdWx0XCI7XG5cbiAgICAvLyBGbGF0LXJhdGUgcHJvdmlkZXJzIChlLmcuIEdpdEh1YiBDb3BpbG90LCBjbGF1ZGUtY29kZSwgdXNlci1kZWNsYXJlZFxuICAgIC8vIHN1YnNjcmlwdGlvbiBwcm94aWVzLCBleHRlcm5hbENsaSBDTElzKSBzdXBwcmVzcyByb3V0aW5nIGF0IGRpc3BhdGNoXG4gICAgLy8gdGltZSAoIzM0NTMpIFx1MjAxNCByZWZsZWN0IHRoYXQgaW4gdGhlIGJhbm5lci4gIFRocmVhZCB0aGUgc2FtZVxuICAgIC8vIEZsYXRSYXRlQ29udGV4dCB1c2VkIGJ5IHNlbGVjdEFuZEFwcGx5TW9kZWwgc28gdXNlci1kZWNsYXJlZFxuICAgIC8vIGZsYXQtcmF0ZSBwcm92aWRlcnMgYW5kIGV4dGVybmFsQ2xpIGF1dG8tZGV0ZWN0aW9uIGFyZSByZXNwZWN0ZWQuXG4gICAgY29uc3QgeyBpc0ZsYXRSYXRlUHJvdmlkZXIsIGJ1aWxkRmxhdFJhdGVDb250ZXh0IH0gPSBhd2FpdCBpbXBvcnQoXCIuL2F1dG8tbW9kZWwtc2VsZWN0aW9uLmpzXCIpO1xuICAgIGNvbnN0IGJhbm5lclByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKGJhc2UpPy5wcmVmZXJlbmNlcztcbiAgICBjb25zdCBlZmZlY3RpdmVQcm92aWRlciA9IHMuYXV0b01vZGVTdGFydE1vZGVsPy5wcm92aWRlciA/PyBjdHgubW9kZWw/LnByb3ZpZGVyO1xuICAgIGNvbnN0IGVmZmVjdGl2ZWx5RW5hYmxlZCA9IHJvdXRpbmdDb25maWcuZW5hYmxlZFxuICAgICAgJiYgKHJvdXRpbmdDb25maWcuYWxsb3dfZmxhdF9yYXRlX3Byb3ZpZGVyc1xuICAgICAgICB8fCAhKGVmZmVjdGl2ZVByb3ZpZGVyICYmIGlzRmxhdFJhdGVQcm92aWRlcihcbiAgICAgICAgICBlZmZlY3RpdmVQcm92aWRlcixcbiAgICAgICAgICBidWlsZEZsYXRSYXRlQ29udGV4dChlZmZlY3RpdmVQcm92aWRlciwgY3R4LCBiYW5uZXJQcmVmcyksXG4gICAgICAgICkpKTtcblxuICAgIC8vIFRoZSBhY3R1YWwgY2VpbGluZyBtYXkgY29tZSBmcm9tIHRpZXJfbW9kZWxzLmhlYXZ5LCBub3QgdGhlIHN0YXJ0IG1vZGVsLlxuICAgIGNvbnN0IGVmZmVjdGl2ZUNlaWxpbmcgPSAocm91dGluZ0NvbmZpZy5lbmFibGVkICYmIHJvdXRpbmdDb25maWcudGllcl9tb2RlbHM/LmhlYXZ5KVxuICAgICAgPyByb3V0aW5nQ29uZmlnLnRpZXJfbW9kZWxzLmhlYXZ5XG4gICAgICA6IHN0YXJ0TW9kZWxMYWJlbDtcblxuICAgIGlmIChlZmZlY3RpdmVseUVuYWJsZWQpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBEeW5hbWljIHJvdXRpbmc6IGVuYWJsZWQgXHUyMDE0IHNpbXBsZSB0YXNrcyBtYXkgdXNlIGNoZWFwZXIgbW9kZWxzIChjZWlsaW5nOiAke2VmZmVjdGl2ZUNlaWxpbmd9KWAsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYER5bmFtaWMgcm91dGluZzogZGlzYWJsZWQgXHUyMDE0IGFsbCB0YXNrcyB3aWxsIHVzZSAke3N0YXJ0TW9kZWxMYWJlbH1gLFxuICAgICAgICBcImluZm9cIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgdXBkYXRlU2Vzc2lvbkxvY2soXG4gICAgICBsb2NrQmFzZSgpLFxuICAgICAgXCJzdGFydGluZ1wiLFxuICAgICAgcy5jdXJyZW50TWlsZXN0b25lSWQgPz8gXCJ1bmtub3duXCIsXG4gICAgKTtcbiAgICB3cml0ZUxvY2sobG9ja0Jhc2UoKSwgXCJzdGFydGluZ1wiLCBzLmN1cnJlbnRNaWxlc3RvbmVJZCA/PyBcInVua25vd25cIik7XG5cbiAgICAvLyBTZWNyZXRzIGNvbGxlY3Rpb24gZ2F0ZVxuICAgIGNvbnN0IG1pZCA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQ7XG4gICAgaWYgKG1pZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWFuaWZlc3RTdGF0dXMgPSBhd2FpdCBnZXRNYW5pZmVzdFN0YXR1cyhiYXNlLCBtaWQsIHMub3JpZ2luYWxCYXNlUGF0aCB8fCBiYXNlKTtcbiAgICAgICAgaWYgKG1hbmlmZXN0U3RhdHVzICYmIG1hbmlmZXN0U3RhdHVzLnBlbmRpbmcubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNvbGxlY3RTZWNyZXRzRnJvbU1hbmlmZXN0KGJhc2UsIG1pZCwgY3R4KTtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICByZXN1bHQgJiZcbiAgICAgICAgICAgIHJlc3VsdC5hcHBsaWVkICYmXG4gICAgICAgICAgICByZXN1bHQuc2tpcHBlZCAmJlxuICAgICAgICAgICAgcmVzdWx0LmV4aXN0aW5nU2tpcHBlZFxuICAgICAgICAgICkge1xuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgYFNlY3JldHMgY29sbGVjdGVkOiAke3Jlc3VsdC5hcHBsaWVkLmxlbmd0aH0gYXBwbGllZCwgJHtyZXN1bHQuc2tpcHBlZC5sZW5ndGh9IHNraXBwZWQsICR7cmVzdWx0LmV4aXN0aW5nU2tpcHBlZC5sZW5ndGh9IGFscmVhZHkgc2V0LmAsXG4gICAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcIlNlY3JldHMgY29sbGVjdGlvbiBza2lwcGVkLlwiLCBcImluZm9cIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgU2VjcmV0cyBjb2xsZWN0aW9uIGVycm9yOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX0uIENvbnRpbnVpbmcgd2l0aCBuZXh0IHRhc2suYCxcbiAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBQcmUtZmxpZ2h0OiB2YWxpZGF0ZSBtaWxlc3RvbmUgcXVldWVcbiAgICB0cnkge1xuICAgICAgY29uc3QgbXNEaXIgPSBqb2luKGJhc2UsIFwiLmdzZFwiLCBcIm1pbGVzdG9uZXNcIik7XG4gICAgICBpZiAoZXhpc3RzU3luYyhtc0RpcikpIHtcbiAgICAgICAgY29uc3QgbWlsZXN0b25lSWRzID0gcmVhZGRpclN5bmMobXNEaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgICAgIC5maWx0ZXIoKGQpID0+IGQuaXNEaXJlY3RvcnkoKSAmJiAvXk1cXGR7M30vLnRlc3QoZC5uYW1lKSlcbiAgICAgICAgICAubWFwKChkKSA9PiBkLm5hbWUubWF0Y2goL14oTVxcZHszfSkvKT8uWzFdID8/IGQubmFtZSk7XG4gICAgICAgIGlmIChtaWxlc3RvbmVJZHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgIGNvbnN0IGlzc3Vlczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgICBmb3IgKGNvbnN0IGlkIG9mIG1pbGVzdG9uZUlkcykge1xuICAgICAgICAgICAgLy8gU2tpcCBjb21wbGV0ZWQvcGFya2VkIG1pbGVzdG9uZXMgXHUyMDE0IGEgbGVmdG92ZXIgQ09OVEVYVC1EUkFGVC5tZFxuICAgICAgICAgICAgLy8gb24gYSBmaW5pc2hlZCBtaWxlc3RvbmUgaXMgaGFybWxlc3MgcmVzaWR1ZSwgbm90IGFuIGFjdGlvbmFibGUgd2FybmluZy5cbiAgICAgICAgICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbXMgPSBnZXRNaWxlc3RvbmUoaWQpO1xuICAgICAgICAgICAgICBpZiAobXM/LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiIHx8IG1zPy5zdGF0dXMgPT09IFwicGFya2VkXCIpIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgZHJhZnQgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBpZCwgXCJDT05URVhULURSQUZUXCIpO1xuICAgICAgICAgICAgaWYgKGRyYWZ0KVxuICAgICAgICAgICAgICBpc3N1ZXMucHVzaChcbiAgICAgICAgICAgICAgICBgJHtpZH06IGhhcyBDT05URVhULURSQUZULm1kICh3aWxsIHBhdXNlIGZvciBkaXNjdXNzaW9uKWAsXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChpc3N1ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgYFByZS1mbGlnaHQ6ICR7bWlsZXN0b25lSWRzLmxlbmd0aH0gbWlsZXN0b25lcyBxdWV1ZWQuXFxuJHtpc3N1ZXMubWFwKChpKSA9PiBgICBcdTI2QTAgJHtpfWApLmpvaW4oXCJcXG5cIil9YCxcbiAgICAgICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgICBgUHJlLWZsaWdodDogJHttaWxlc3RvbmVJZHMubGVuZ3RofSBtaWxlc3RvbmVzIHF1ZXVlZC4gQWxsIGhhdmUgZnVsbCBjb250ZXh0LmAsXG4gICAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIC8qIG5vbi1mYXRhbCAqL1xuICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgcHJlZmxpZ2h0IHZhbGlkYXRpb24gZmFpbGVkOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmVsZWFzZVNlc3Npb25Mb2NrKGJhc2UpO1xuICAgIGNsZWFyTG9jayhiYXNlKTtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cbiJdLAogICJtYXBwaW5ncyI6ICJBQWlCQSxTQUFTLG1CQUFtQjtBQUM1QixTQUFTLFVBQVUseUJBQXlCO0FBRTVDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsa0JBQWtCLGlCQUFpQix5QkFBeUI7QUFDckUsU0FBUyx3QkFBd0IsOEJBQThCO0FBQy9ELFNBQVMsa0NBQWtDO0FBQzNDLFNBQVMsU0FBUyw0QkFBNEI7QUFDOUMsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyxXQUFXLGlCQUFpQjtBQUNyQztBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLGlCQUFpQiwyQkFBMkI7QUFDckQ7QUFBQSxFQUNFO0FB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
