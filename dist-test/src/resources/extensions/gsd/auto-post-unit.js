import { deriveState } from "./state.js";
import { logWarning, logError } from "./workflow-logger.js";
import { loadFile, parseSummary, resolveAllOverrides } from "./files.js";
import { loadPrompt } from "./prompt-loader.js";
import { isAwaitingUserInput } from "./user-input-boundary.js";
import {
  resolveSliceFile,
  resolveSlicePath,
  resolveTaskFile,
  resolveMilestoneFile,
  resolveTasksDir,
  buildTaskFileName
} from "./paths.js";
import { invalidateAllCaches } from "./cache.js";
import { rebuildState } from "./doctor.js";
import { parseUnitId } from "./unit-id.js";
import { closeoutUnit } from "./auto-unit-closeout.js";
import {
  runTurnGitAction
} from "./git-service.js";
import {
  verifyExpectedArtifact,
  resolveExpectedArtifactPath,
  writeBlockerPlaceholder,
  diagnoseExpectedArtifact,
  diagnoseWorktreeIntegrityFailure
} from "./auto-recovery.js";
import { regenerateIfMissing } from "./workflow-projections.js";
import { WorktreeStateProjection } from "./worktree-state-projection.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";
import { normalizeWorktreePathForCompare } from "./worktree-root.js";
import { isDbAvailable, getTask, getSlice, getMilestone, updateTaskStatus, _getAdapter, getVerificationEvidence } from "./gsd-db.js";
import { renderPlanCheckboxes } from "./markdown-renderer.js";
import { consumeSignal } from "./session-status-io.js";
import {
  checkPostUnitHooks,
  isRetryPending,
  consumeRetryTrigger,
  persistHookState,
  resolveHookArtifactPath
} from "./post-unit-hooks.js";
import { hasPendingCaptures, loadPendingCaptures, revertExecutorResolvedCaptures } from "./captures.js";
import { debugLog } from "./debug-logger.js";
import { runSafely } from "./auto-utils.js";
import { getEvidence, clearEvidenceFromDisk } from "./safety/evidence-collector.js";
import { validateFileChanges } from "./safety/file-change-validator.js";
import { crossReferenceEvidence } from "./safety/evidence-cross-ref.js";
import { validateContent } from "./safety/content-validator.js";
import { resolveSafetyHarnessConfig } from "./safety/safety-harness.js";
import { resolveExpectedArtifactPath as resolveArtifactForContent } from "./auto-artifact-paths.js";
import { getIsolationMode, loadEffectiveGSDPreferences } from "./preferences.js";
import { getSliceTasks } from "./gsd-db.js";
import { runPreExecutionChecks } from "./pre-execution-checks.js";
import { writePreExecutionEvidence } from "./verification-evidence.js";
import { ensureCodebaseMapFresh } from "./codebase-generator.js";
import { resolveUokFlags } from "./uok/flags.js";
import { UokGateRunner } from "./uok/gate-runner.js";
import { writeTurnGitTransaction } from "./uok/gitops.js";
import { isClosedStatus } from "./status-guards.js";
import { detectAbandonMilestone } from "./abandon-detect.js";
import { isDeterministicPolicyError } from "./auto-tool-tracking.js";
import {
  clearProjectResearchInflightMarker,
  finalizeProjectResearchTimeout
} from "./project-research-policy.js";
import { validateArtifact } from "./schemas/validate.js";
import { verificationRetryKey } from "./auto/verification-retry-policy.js";
function isSamePathLocal(a, b) {
  return normalizeWorktreePathForCompare(a) === normalizeWorktreePathForCompare(b);
}
const _worktreeProjection = new WorktreeStateProjection();
const MAX_VERIFICATION_RETRIES = 3;
const MAX_NOTIFICATION_DETAILS = 3;
const NOTIFICATION_BULLET = "\u2022";
function formatPreExecutionCheckDetail(check) {
  const category = check.category?.trim() || "unknown category";
  const target = check.target?.trim() || "unknown target";
  const message = check.message.split(/\r?\n/, 1)[0]?.trim() || "No details provided";
  return `  ${NOTIFICATION_BULLET} [${category}] ${target}: ${message}`;
}
const COMPLETE_MILESTONE_DB_SETTLE_MS = 1500;
const COMPLETE_MILESTONE_DB_SETTLE_POLL_MS = 100;
function stripKnownIdPrefix(value, id) {
  const raw = String(value ?? "").trim();
  if (!raw) return void 0;
  const lower = raw.toLowerCase();
  const idLower = id.toLowerCase();
  if (lower.startsWith(`${idLower}:`)) return raw.slice(id.length + 1).trim() || void 0;
  return raw;
}
async function buildTaskCommitContextForUnit(basePath, unitId) {
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  if (!mid || !sid || !tid) return void 0;
  const milestone = isDbAvailable() ? getMilestone(mid) : null;
  const slice = isDbAvailable() ? getSlice(mid, sid) : null;
  const task = isDbAvailable() ? getTask(mid, sid, tid) : null;
  let summary = null;
  const summaryPath = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
  if (summaryPath) {
    try {
      const summaryContent = await loadFile(summaryPath);
      if (summaryContent) summary = parseSummary(summaryContent);
    } catch (e) {
      debugLog("postUnit", { phase: "task-summary-parse", error: String(e) });
    }
  }
  if (!summary && !task) return void 0;
  let ghIssueNumber;
  try {
    const { getTaskIssueNumberForCommit } = await import("../github-sync/sync.js");
    ghIssueNumber = getTaskIssueNumberForCommit(basePath, mid, sid, tid) ?? void 0;
  } catch (err) {
    logWarning("engine", `GitHub issue lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    taskId: `${sid}/${tid}`,
    taskDisplayId: tid,
    taskTitle: stripKnownIdPrefix(summary?.title, tid) ?? stripKnownIdPrefix(task?.title, tid) ?? tid,
    milestoneId: mid,
    milestoneTitle: stripKnownIdPrefix(milestone?.title, mid),
    sliceId: sid,
    sliceTitle: stripKnownIdPrefix(slice?.title, sid),
    oneLiner: summary?.oneLiner || task?.one_liner || void 0,
    keyFiles: summary?.frontmatter.key_files?.filter((f) => !f.includes("{{") && f.trim() !== "(none)") ?? task?.key_files ?? void 0,
    issueNumber: ghIssueNumber
  };
}
async function waitForMilestoneDbClose(mid) {
  const deadline = Date.now() + COMPLETE_MILESTONE_DB_SETTLE_MS;
  while (Date.now() < deadline) {
    if (!isDbAvailable()) return false;
    const milestone = getMilestone(mid);
    if (milestone && isClosedStatus(milestone.status)) return true;
    await new Promise((resolve) => setTimeout(resolve, COMPLETE_MILESTONE_DB_SETTLE_POLL_MS));
  }
  return false;
}
function enqueueSidecar(s, ctx, entry, debugExtra, notification) {
  s.sidecarQueue.push(entry);
  debugLog("postUnitPostVerification", {
    phase: "sidecar-enqueue",
    kind: entry.kind,
    unitId: entry.unitId,
    ...debugExtra
  });
  if (notification) ctx.ui.notify(notification, "info");
  return "continue";
}
function _shouldDispatchTriageForTest(state) {
  return !state.stepMode && !!state.currentUnit && !state.currentUnit.type.startsWith("hook/") && state.currentUnit.type !== "triage-captures" && state.currentUnit.type !== "quick-task";
}
function _shouldDispatchQuickTaskForTest(state) {
  return !state.stepMode && state.pendingQuickTasks.length > 0 && !!state.currentUnit && state.currentUnit.type !== "quick-task";
}
function shouldDeferCloseoutGitAction(unitType) {
  return unitType === "execute-task";
}
const LIFECYCLE_ONLY_UNITS = /* @__PURE__ */ new Set([
  "research-milestone",
  "discuss-milestone",
  "discuss-slice",
  "plan-milestone",
  "validate-milestone",
  "research-slice",
  "plan-slice",
  "refine-slice",
  "replan-slice",
  "complete-slice",
  "run-uat",
  "reassess-roadmap",
  "rewrite-docs"
]);
import {
  describeNextUnit
} from "./auto-dashboard.js";
import { existsSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { _resetHasChangesCache } from "./native-git-bridge.js";
import { autoCommitCurrentBranch } from "./worktree.js";
function hasNonEmptyFields(row, fields) {
  if (!row) return false;
  return fields.some((f) => String(row[f] || "").trim().length > 0);
}
const MILESTONE_PLANNING_FIELDS = ["title", "vision", "requirement_coverage", "boundary_map_markdown"];
const SLICE_PLANNING_FIELDS = ["title", "demo", "risk", "depends"];
function detectRogueFileWrites(unitType, unitId, basePath) {
  if (!isDbAvailable()) return [];
  const { milestone: mid, slice: sid, task: tid } = parseUnitId(unitId);
  const rogues = [];
  if (unitType === "execute-task") {
    if (!mid || !sid || !tid) return [];
    const summaryPath = resolveTaskFile(basePath, mid, sid, tid, "SUMMARY");
    if (!summaryPath || !existsSync(summaryPath)) return [];
    const dbRow = getTask(mid, sid, tid);
    if (!dbRow || dbRow.status !== "complete") {
      rogues.push({ path: summaryPath, unitType, unitId });
    }
  } else if (unitType === "complete-slice") {
    if (!mid || !sid) return [];
    const summaryPath = resolveSliceFile(basePath, mid, sid, "SUMMARY");
    if (!summaryPath || !existsSync(summaryPath)) return [];
    const dbRow = getSlice(mid, sid);
    if (!dbRow || dbRow.status !== "complete") {
      rogues.push({ path: summaryPath, unitType, unitId });
    }
  } else if (unitType === "plan-milestone") {
    if (!mid) return [];
    const roadmapPath = resolveMilestoneFile(basePath, mid, "ROADMAP");
    if (!roadmapPath || !existsSync(roadmapPath)) return [];
    const dbRow = getMilestone(mid);
    const hasPlanningState = hasNonEmptyFields(dbRow, MILESTONE_PLANNING_FIELDS);
    if (!hasPlanningState) {
      rogues.push({ path: roadmapPath, unitType, unitId });
    }
  } else if (unitType === "plan-slice" || unitType === "refine-slice" || unitType === "replan-slice") {
    if (!mid || !sid) return [];
    const planPath = resolveSliceFile(basePath, mid, sid, "PLAN");
    if (!planPath || !existsSync(planPath)) return [];
    const dbRow = getSlice(mid, sid);
    const hasPlanningState = hasNonEmptyFields(dbRow, SLICE_PLANNING_FIELDS);
    if (!hasPlanningState) {
      rogues.push({ path: planPath, unitType, unitId });
    }
    const replanPath = resolveSliceFile(basePath, mid, sid, "REPLAN");
    if (replanPath && existsSync(replanPath) && !hasPlanningState) {
      rogues.push({ path: replanPath, unitType, unitId });
    }
  } else if (unitType === "reassess-roadmap") {
    if (!mid || !sid) return [];
    const assessPath = resolveSliceFile(basePath, mid, sid, "ASSESSMENT");
    if (!assessPath || !existsSync(assessPath)) return [];
    const adapter = _getAdapter();
    if (adapter) {
      const row = adapter.prepare(
        `SELECT 1 FROM artifacts WHERE path LIKE :pattern AND artifact_type = 'ASSESSMENT' LIMIT 1`
      ).get({ ":pattern": `%${sid}-ASSESSMENT.md` });
      if (!row) {
        rogues.push({ path: assessPath, unitType, unitId });
      }
    }
  } else if (unitType === "plan-task") {
    if (!mid || !sid || !tid) return [];
    const taskPlanPath = resolveTaskFile(basePath, mid, sid, tid, "PLAN");
    if (!taskPlanPath || !existsSync(taskPlanPath)) return [];
    const dbRow = getTask(mid, sid, tid);
    if (!dbRow) {
      rogues.push({ path: taskPlanPath, unitType, unitId });
    }
  }
  return rogues;
}
const MAX_ARTIFACT_VERIFICATION_RETRIES = 3;
const STEP_COMPLETE_FALLBACK_MESSAGE = "Step complete. Run /clear, then /gsd to continue (or /gsd auto to run continuously).";
function buildStepCompleteMessage(nextState) {
  if (nextState.phase === "complete") {
    return "Step complete \u2014 milestone finished. Run /gsd status to review, or start the next milestone.";
  }
  const next = describeNextUnit(nextState);
  return `Step complete. Next: ${next.label}
Run /clear, then /gsd to continue (or /gsd auto to run continuously).`;
}
function shouldReturnStepWizardAfterUnit(currentUnitType, phaseAfterUnit) {
  return currentUnitType !== "complete-milestone" && phaseAfterUnit !== "complete";
}
const USER_DRIVEN_DEEP_UNITS = /* @__PURE__ */ new Set([
  "discuss-project",
  "discuss-requirements",
  "discuss-milestone",
  "research-decision"
]);
import { isAwaitingUserInput as isAwaitingUserInput2 } from "./user-input-boundary.js";
function artifactValidationKind(unitType) {
  if (unitType === "discuss-project") return "project";
  if (unitType === "discuss-requirements") return "requirements";
  return null;
}
function describeArtifactVerificationFailure(unitType, unitId, basePath) {
  const worktreeFailure = diagnoseWorktreeIntegrityFailure(basePath);
  if (worktreeFailure) {
    return `${worktreeFailure} Unit: ${unitType} ${unitId}.`;
  }
  const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
  if (!artifactPath) {
    return `Artifact verification failed: ${unitType} "${unitId}" has no resolvable artifact path.`;
  }
  const relPath = relative(basePath, artifactPath);
  if (!existsSync(artifactPath)) {
    return `Artifact verification failed: ${relPath} was not found on disk after unit execution.`;
  }
  const validationKind = artifactValidationKind(unitType);
  if (validationKind) {
    const result = validateArtifact(artifactPath, validationKind);
    if (!result.ok) {
      const errors = result.errors.slice(0, MAX_NOTIFICATION_DETAILS).map((error) => `${error.code}: ${error.message}`).join("; ");
      return `Artifact verification failed: ${relPath} exists but is invalid${errors ? ` (${errors})` : ""}.`;
    }
  }
  const expected = diagnoseExpectedArtifact(unitType, unitId, basePath);
  return `Artifact verification failed: ${relPath} exists but did not satisfy the ${unitType} completion contract${expected ? ` (${expected})` : ""}.`;
}
async function autoCommitUnit(basePath, unitType, unitId, ctx) {
  try {
    let taskContext;
    if (unitType === "execute-task") {
      taskContext = await buildTaskCommitContextForUnit(basePath, unitId);
    }
    _resetHasChangesCache();
    if (LIFECYCLE_ONLY_UNITS.has(unitType)) {
      return null;
    }
    const commitMsg = autoCommitCurrentBranch(basePath, unitType, unitId, taskContext);
    if (commitMsg) {
      ctx?.ui.notify(`Committed: ${commitMsg.split("\n")[0]}`, "info");
    }
    return commitMsg;
  } catch (e) {
    debugLog("postUnit", { phase: "auto-commit", error: String(e) });
    ctx?.ui.notify(`Auto-commit failed: ${String(e).split("\n")[0]}`, "warning");
    return null;
  }
}
async function runCloseoutGitAction(pctx, unit, opts) {
  const { s, ctx, pi, pauseAuto } = pctx;
  const prefs = loadEffectiveGSDPreferences()?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  const turnAction = uokFlags.gitops ? uokFlags.gitopsTurnAction : "commit";
  const traceId = s.currentTraceId ?? `turn:${unit.startedAt}`;
  const turnId = s.currentTurnId ?? `${unit.type}/${unit.id}/${unit.startedAt}`;
  s.lastGitActionFailure = null;
  s.lastGitActionStatus = null;
  try {
    let taskContext;
    if (turnAction === "commit" && unit.type === "execute-task") {
      taskContext = await buildTaskCommitContextForUnit(s.basePath, unit.id);
    }
    _resetHasChangesCache();
    const skipLifecycleCommit = turnAction === "commit" && LIFECYCLE_ONLY_UNITS.has(unit.type);
    if (skipLifecycleCommit) {
      debugLog("postUnit", {
        phase: "git-action-skipped",
        reason: "lifecycle-only-unit",
        unitType: unit.type,
        unitId: unit.id
      });
    } else {
      const maxAttempts = opts?.softFailure ? 3 : 1;
      let gitResult = runTurnGitAction({
        basePath: s.basePath,
        action: turnAction,
        unitType: unit.type,
        unitId: unit.id,
        taskContext
      });
      for (let attempt = 1; gitResult.status === "failed" && attempt < maxAttempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        gitResult = runTurnGitAction({
          basePath: s.basePath,
          action: turnAction,
          unitType: unit.type,
          unitId: unit.id,
          taskContext
        });
      }
      if (uokFlags.gitops) {
        writeTurnGitTransaction({
          basePath: s.basePath,
          traceId,
          turnId,
          unitType: unit.type,
          unitId: unit.id,
          stage: "publish",
          action: turnAction,
          push: uokFlags.gitopsTurnPush,
          status: gitResult.status,
          error: gitResult.error,
          metadata: {
            dirty: gitResult.dirty,
            commitMessage: gitResult.commitMessage,
            snapshotLabel: gitResult.snapshotLabel
          }
        });
      }
      if (gitResult.status === "failed") {
        s.lastGitActionFailure = gitResult.error ?? `git ${turnAction} failed`;
        s.lastGitActionStatus = "failed";
        if (uokFlags.gitops && uokFlags.gates) {
          const parsed = parseUnitId(unit.id);
          const gateRunner = new UokGateRunner();
          gateRunner.register({
            id: "closeout-git-action",
            type: "closeout",
            execute: async () => ({
              outcome: "fail",
              failureClass: "git",
              rationale: `turn git action "${turnAction}" failed`,
              findings: gitResult.error ?? "unknown git failure"
            })
          });
          await gateRunner.run("closeout-git-action", {
            basePath: s.basePath,
            traceId,
            turnId,
            milestoneId: parsed.milestone ?? void 0,
            sliceId: parsed.slice ?? void 0,
            taskId: parsed.task ?? void 0,
            unitType: unit.type,
            unitId: unit.id
          });
        }
        const failureMsg = `Git ${turnAction} failed: ${(gitResult.error ?? "unknown error").split("\n")[0]}`;
        ctx.ui.notify(failureMsg, opts?.softFailure ? "warning" : "error");
        debugLog("postUnit", {
          phase: opts?.softFailure ? "git-action-failed-soft" : "git-action-failed-blocking",
          action: turnAction,
          error: gitResult.error ?? "unknown error"
        });
        if (opts?.softFailure) {
          return "continue";
        }
        await pauseAuto(ctx, pi);
        return "dispatched";
      }
      s.lastGitActionStatus = "ok";
      if (turnAction === "commit" && gitResult.commitMessage) {
        ctx.ui.notify(`Committed: ${gitResult.commitMessage.split("\n")[0]}`, "info");
      } else if (turnAction === "snapshot" && gitResult.snapshotLabel) {
        ctx.ui.notify(`Snapshot recorded: ${gitResult.snapshotLabel}`, "info");
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    s.lastGitActionFailure = message;
    s.lastGitActionStatus = "failed";
    debugLog("postUnit", { phase: "git-action", error: message, action: turnAction });
    ctx.ui.notify(`Git ${turnAction} failed: ${message.split("\n")[0]}`, opts?.softFailure ? "warning" : "error");
    if (opts?.softFailure) {
      return "continue";
    }
    if (uokFlags.gitops) {
      await pauseAuto(ctx, pi);
      return "dispatched";
    }
  }
  await runSafely("postUnit", "github-sync", async () => {
    const { runGitHubSync } = await import("../github-sync/sync.js");
    await runGitHubSync(s.basePath, unit.type, unit.id);
  });
  return "continue";
}
async function postUnitPreVerification(pctx, opts) {
  const { s, ctx, pi, stopAuto, pauseAuto } = pctx;
  const milestoneLock = process.env.GSD_MILESTONE_LOCK;
  if (milestoneLock) {
    const signal = consumeSignal(s.basePath, milestoneLock);
    if (signal) {
      if (signal.signal === "stop") {
        await stopAuto(ctx, pi);
        return "dispatched";
      }
      if (signal.signal === "pause") {
        await pauseAuto(ctx, pi);
        return "dispatched";
      }
    }
  }
  invalidateAllCaches();
  if (!opts?.skipSettleDelay) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (s.currentUnit) {
    const unit = s.currentUnit;
    if (shouldDeferCloseoutGitAction(unit.type)) {
      debugLog("postUnit", {
        phase: "git-action-deferred-until-verification",
        unitType: unit.type,
        unitId: unit.id
      });
    } else {
      const gitActionResult = await runCloseoutGitAction(pctx, unit);
      if (gitActionResult === "dispatched") {
        return "dispatched";
      }
    }
    await runSafely("postUnit", "prune-bg-shell", async () => {
      const { pruneDeadProcesses } = await import("../bg-shell/process-manager.js");
      pruneDeadProcesses();
    });
    await runSafely("postUnit", "browser-teardown", async () => {
      const { getBrowser } = await import("../browser-tools/state.js");
      if (getBrowser()) {
        const { closeBrowser } = await import("../browser-tools/lifecycle.js");
        await closeBrowser();
        debugLog("postUnit", { phase: "browser-teardown", status: "closed" });
      }
    });
    await runSafely("postUnit", "state-rebuild", async () => {
      await rebuildState(s.basePath);
    });
    if (!opts?.skipWorktreeSync && s.originalBasePath && !isSamePathLocal(s.originalBasePath, s.basePath)) {
      await runSafely("postUnit", "worktree-sync", () => {
        let scope = s.scope;
        if (!scope && s.currentMilestoneId) {
          try {
            scope = scopeMilestone(createWorkspace(s.basePath), s.currentMilestoneId);
          } catch {
            scope = null;
          }
        }
        if (scope) _worktreeProjection.projectWorktreeToRoot(scope);
      });
    }
    if (s.currentUnit.type === "rewrite-docs") {
      await runSafely("postUnit", "rewrite-docs-resolve", async () => {
        try {
          const { loadActiveOverrides } = await import("./files.js");
          const overrides = await loadActiveOverrides(s.basePath);
          const decision = detectAbandonMilestone(overrides, s.currentMilestoneId);
          if (decision.shouldPark && s.currentMilestoneId) {
            const { parkMilestone } = await import("./milestone-actions.js");
            const parked = parkMilestone(s.basePath, s.currentMilestoneId, decision.reason);
            if (parked) {
              ctx.ui.notify(`Milestone ${s.currentMilestoneId} parked: "${decision.reason}"`, "info");
            } else {
              const msg = `Abandon detected for ${s.currentMilestoneId} but park refused (milestone is completed, already parked, or missing). Override will be resolved anyway \u2014 verify state is correct.`;
              logError("engine", msg);
              ctx.ui.notify(msg, "warning");
            }
          }
        } catch (err) {
          logError("engine", `abandon-detect failed: ${err.message}`);
          ctx.ui.notify(`Abandon detection failed \u2014 check logs. Overrides will still be resolved.`, "warning");
        }
        await resolveAllOverrides(s.basePath);
        const { setRewriteCount } = await import("./auto-dispatch.js");
        setRewriteCount(s.basePath, 0);
        s.rewriteAttemptCount = 0;
        ctx.ui.notify("Override(s) resolved \u2014 rewrite-docs completed.", "info");
      });
    }
    if (s.currentUnit.type === "complete-slice") {
      await runSafely("postUnit", "reactive-state-cleanup", async () => {
        const { milestone: mid, slice: sid } = parseUnitId(unit.id);
        if (mid && sid) {
          const { clearReactiveState } = await import("./reactive-graph.js");
          clearReactiveState(s.basePath, mid, sid);
        }
      });
      let sliceMergeStopped = false;
      await runSafely("postUnit", "slice-cadence-merge", async () => {
        const prefsResult = loadEffectiveGSDPreferences(s.basePath);
        const prefs = prefsResult?.preferences;
        const { getCollapseCadence, mergeSliceToMain } = await import("./slice-cadence.js");
        if (getCollapseCadence(prefs) !== "slice") return;
        if (getIsolationMode(s.originalBasePath || s.basePath) !== "worktree") return;
        if (s.isolationDegraded) return;
        const projectRoot = s.originalBasePath || s.basePath;
        const { milestone: mid, slice: sid } = parseUnitId(unit.id);
        if (!mid || !sid) return;
        if (!s.milestoneStartShas.has(mid)) {
          try {
            const { nativeDetectMainBranch } = await import("./native-git-bridge.js");
            const mainBranch = nativeDetectMainBranch(projectRoot);
            const { execFileSync } = await import("node:child_process");
            const sha = execFileSync("git", ["rev-parse", mainBranch], {
              cwd: projectRoot,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8"
            }).trim();
            if (sha) s.milestoneStartShas.set(mid, sha);
          } catch (err) {
            logWarning("engine", `slice-cadence: failed to record milestone start SHA: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        try {
          const result = mergeSliceToMain(projectRoot, mid, sid);
          if (result.skipped) {
            logWarning("engine", `slice-cadence: merge skipped for ${sid} \u2014 ${result.skippedReason}`);
            return;
          }
          ctx.ui.notify(
            `slice-cadence: ${sid} merged to main (${result.durationMs}ms).`,
            "info"
          );
        } catch (err) {
          const { MergeConflictError } = await import("./git-service.js");
          if (err instanceof MergeConflictError) {
            ctx.ui.notify(
              `slice-cadence merge conflict in ${sid}: ${err.conflictedFiles.join(", ")}. Resolve manually on main and run \`/gsd auto\` to resume.`,
              "error"
            );
            const { stopAuto: stopAuto3 } = await import("./auto.js");
            await stopAuto3(ctx, void 0, `slice-merge-conflict on ${sid}`);
            sliceMergeStopped = true;
            return;
          }
          logError("engine", `slice-cadence merge failed for ${sid}`, {
            error: err instanceof Error ? err.message : String(err)
          });
          const { stopAuto: stopAuto2 } = await import("./auto.js");
          await stopAuto2(ctx, void 0, `slice-merge-error on ${sid}`);
          sliceMergeStopped = true;
        }
      });
      if (sliceMergeStopped) return "dispatched";
    }
    if (s.currentUnit.type === "triage-captures") {
      try {
        const { executeTriageResolutions } = await import("./triage-resolution.js");
        const state = await deriveState(s.canonicalProjectRoot);
        const mid = state.activeMilestone?.id ?? "";
        const sid = state.activeSlice?.id ?? "";
        const triageResult = executeTriageResolutions(s.canonicalProjectRoot, mid, sid);
        if (triageResult.injected > 0) {
          ctx.ui.notify(
            `Triage: injected ${triageResult.injected} task${triageResult.injected === 1 ? "" : "s"} into ${sid} plan.`,
            "info"
          );
        }
        if (triageResult.replanned > 0) {
          ctx.ui.notify(
            `Triage: replan trigger written for ${sid} \u2014 next dispatch will enter replanning.`,
            "info"
          );
        }
        if (triageResult.deferredMilestones > 0) {
          ctx.ui.notify(
            `Triage: created ${triageResult.deferredMilestones} deferred milestone director${triageResult.deferredMilestones === 1 ? "y" : "ies"}.`,
            "info"
          );
        }
        if (triageResult.quickTasks.length > 0) {
          for (const qt of triageResult.quickTasks) {
            s.pendingQuickTasks.push(qt);
          }
          ctx.ui.notify(
            `Triage: ${triageResult.quickTasks.length} quick-task${triageResult.quickTasks.length === 1 ? "" : "s"} queued for execution.`,
            "info"
          );
        }
        for (const action of triageResult.actions) {
          logWarning("engine", `triage resolution: ${action}`);
        }
      } catch (err) {
        logError("engine", "triage resolution failed", { error: err.message });
      }
    }
    try {
      const { loadEffectiveGSDPreferences: loadEffectiveGSDPreferences2 } = await import("./preferences.js");
      const prefs = loadEffectiveGSDPreferences2()?.preferences;
      const safetyConfig = resolveSafetyHarnessConfig(
        prefs?.safety_harness
      );
      if (safetyConfig.enabled) {
        const { milestone: sMid, slice: sSid, task: sTid } = parseUnitId(s.currentUnit.id);
        if (safetyConfig.file_change_validation && s.currentUnit.type === "execute-task" && sMid && sSid && sTid && isDbAvailable()) {
          try {
            const taskRow = getTask(sMid, sSid, sTid);
            if (taskRow) {
              const expectedOutput = taskRow.expected_output ?? [];
              const plannedFiles = taskRow.files ?? [];
              const audit = validateFileChanges(s.basePath, expectedOutput, plannedFiles, safetyConfig.file_change_allowlist);
              if (audit && audit.violations.length > 0) {
                const warnings = audit.violations.filter((v) => v.severity === "warning");
                for (const v of warnings) {
                  logWarning("safety", `file-change: ${v.file} \u2014 ${v.reason}`);
                }
                if (warnings.length > 0) {
                  ctx.ui.notify(
                    `Safety: ${warnings.length} unexpected file change(s) outside task plan`,
                    "warning"
                  );
                }
              }
            }
          } catch (e) {
            debugLog("postUnit", { phase: "safety-file-change", error: String(e) });
          }
        }
        if (safetyConfig.evidence_cross_reference && s.currentUnit.type === "execute-task") {
          try {
            const actual = getEvidence();
            const bashCalls = actual.filter((e) => e.kind === "bash");
            if (sMid && sSid && sTid && isDbAvailable()) {
              const taskRow = getTask(sMid, sSid, sTid);
              if (taskRow?.status === "complete") {
                const claimedEvidence = getVerificationEvidence(sMid, sSid, sTid).map((row) => ({
                  command: row.command,
                  exitCode: row.exit_code,
                  verdict: row.verdict
                })).filter((row) => typeof row.command === "string" && row.command.trim().length > 0);
                const mismatches = crossReferenceEvidence(claimedEvidence, actual);
                for (const mismatch of mismatches) {
                  const logMessage = `evidence-xref: ${mismatch.reason}`;
                  if (mismatch.severity === "error") {
                    logError("safety", logMessage);
                  } else {
                    logWarning("safety", logMessage);
                  }
                }
                if (claimedEvidence.length > 0 && bashCalls.length === 0) {
                  logWarning("safety", "task claimed verification command evidence but no execution tool calls were recorded");
                  ctx.ui.notify(
                    `Safety: task ${sTid} claimed command evidence but no execution tool calls were recorded`,
                    "warning"
                  );
                }
                const blockingMismatch = mismatches.find((mismatch) => mismatch.severity === "error");
                if (blockingMismatch) {
                  ctx.ui.notify(
                    `Safety: task ${sTid} claimed passing verification that failed in recorded execution`,
                    "error"
                  );
                  await pauseAuto(ctx, pi);
                  return "dispatched";
                }
              }
            }
          } catch (e) {
            debugLog("postUnit", { phase: "safety-evidence-xref", error: String(e) });
          }
        }
        if (safetyConfig.content_validation) {
          try {
            const artifactPath = resolveArtifactForContent(s.currentUnit.type, s.currentUnit.id, s.basePath);
            const contentViolations = validateContent(s.currentUnit.type, artifactPath);
            for (const v of contentViolations) {
              logWarning("safety", `content: ${v.reason}`);
              ctx.ui.notify(`Content validation: ${v.reason}`, "warning");
            }
          } catch (e) {
            debugLog("postUnit", { phase: "safety-content-validation", error: String(e) });
          }
        }
        if (safetyConfig.evidence_collection && s.currentUnit.type === "execute-task" && sMid && sSid && sTid) {
          try {
            clearEvidenceFromDisk(s.basePath, sMid, sSid, sTid);
          } catch (e) {
            debugLog("postUnit", { phase: "safety-evidence-clear", error: String(e) });
          }
        }
      }
    } catch (e) {
      debugLog("postUnit", { phase: "safety-harness", error: String(e) });
    }
    let triggerArtifactVerified = false;
    if (!s.currentUnit.type.startsWith("hook/")) {
      try {
        triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
        if (triggerArtifactVerified) {
          invalidateAllCaches();
        }
      } catch (e) {
        debugLog("postUnit", { phase: "artifact-verify", error: String(e) });
      }
      if (!triggerArtifactVerified) {
        if (s.currentUnit.type === "complete-milestone") {
          try {
            const { milestone: mid } = parseUnitId(s.currentUnit.id);
            if (mid) {
              const settled = await waitForMilestoneDbClose(mid);
              if (settled) {
                triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
                if (triggerArtifactVerified) {
                  invalidateAllCaches();
                }
              }
            }
          } catch (e) {
            debugLog("postUnit", { phase: "artifact-verify-settle-db", error: String(e) });
          }
        }
      }
      if (!triggerArtifactVerified) {
        try {
          const { milestone: mid, slice: sid } = parseUnitId(s.currentUnit.id);
          if (mid && sid) {
            const regenerated = await regenerateIfMissing(s.canonicalProjectRoot, mid, sid, "PLAN");
            if (regenerated) {
              triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.canonicalProjectRoot);
              if (triggerArtifactVerified) {
                invalidateAllCaches();
              }
            }
          }
        } catch (e) {
          debugLog("postUnit", { phase: "regenerate-projection", error: String(e) });
        }
      }
      if (s.currentUnit.type === "research-project") {
        try {
          clearProjectResearchInflightMarker(s.basePath);
        } catch (e) {
          debugLog("postUnit", { phase: "research-project-inflight-cleanup", error: String(e) });
        }
      }
      if (!triggerArtifactVerified && s.currentUnit.type === "research-project") {
        const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
        const outcome = finalizeProjectResearchTimeout(
          s.basePath,
          "Project research unit ended before all required dimensions produced durable files."
        );
        s.pendingVerificationRetry = null;
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
        triggerArtifactVerified = verifyExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
        if (triggerArtifactVerified) {
          invalidateAllCaches();
          ctx.ui.notify(
            outcome.kind === "partial-blockers" ? "Project research finished partially; wrote blockers for missing dimensions and advancing without rerunning all scouts." : "Project research artifacts are now terminal.",
            "warning"
          );
        } else {
          ctx.ui.notify(
            "Project research produced no usable research files; wrote PROJECT-RESEARCH-BLOCKER.md and continuing fail-closed.",
            "error"
          );
          return "continue";
        }
      }
      if (!triggerArtifactVerified && USER_DRIVEN_DEEP_UNITS.has(s.currentUnit.type) && isAwaitingUserInput(opts?.agentEndMessages)) {
        debugLog("postUnit", {
          phase: "artifact-verify-awaiting-user",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id
        });
        ctx.ui.notify(
          `${s.currentUnit.type} ${s.currentUnit.id} is waiting for your input \u2014 pausing auto-mode instead of retrying the missing artifact.`,
          "info"
        );
        s.lastToolInvocationError = null;
        await pauseAuto(ctx, pi);
        return "dispatched";
      } else if (!triggerArtifactVerified && s.lastToolInvocationError && isDeterministicPolicyError(s.lastToolInvocationError)) {
        const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
        debugLog("postUnit", { phase: "deterministic-policy-error-placeholder", unitType: s.currentUnit.type, unitId: s.currentUnit.id, error: s.lastToolInvocationError });
        const reason = `Deterministic policy rejection for ${s.currentUnit.type} "${s.currentUnit.id}": ${s.lastToolInvocationError}. Retrying cannot resolve this gate \u2014 writing blocker placeholder to advance pipeline.`;
        s.lastToolInvocationError = null;
        s.pendingVerificationRetry = null;
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
        writeBlockerPlaceholder(s.currentUnit.type, s.currentUnit.id, s.basePath, reason);
        ctx.ui.notify(
          `${s.currentUnit.type} ${s.currentUnit.id} \u2014 deterministic policy rejection, wrote blocker placeholder (no retries) (#4973)`,
          "warning"
        );
      } else if (!triggerArtifactVerified && diagnoseWorktreeIntegrityFailure(s.basePath)) {
        const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
        const worktreeFailure = diagnoseWorktreeIntegrityFailure(s.basePath);
        s.pendingVerificationRetry = null;
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
        debugLog("postUnit", {
          phase: "worktree-integrity-failure",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
          basePath: s.basePath
        });
        ctx.ui.notify(
          `${worktreeFailure} Retry ${s.currentUnit.id} after repair.`,
          "error"
        );
        await pauseAuto(ctx, pi);
        return "dispatched";
      } else if (!triggerArtifactVerified && !isDbAvailable()) {
        debugLog("postUnit", { phase: "artifact-verify-skip-db-unavailable", unitType: s.currentUnit.type, unitId: s.currentUnit.id });
        const dbSkipDiag = diagnoseExpectedArtifact(s.currentUnit.type, s.currentUnit.id, s.basePath);
        ctx.ui.notify(
          `Artifact missing for ${s.currentUnit.type} ${s.currentUnit.id} \u2014 DB unavailable, skipping retry.${dbSkipDiag ? ` Expected: ${dbSkipDiag}` : ""}`,
          "error"
        );
      } else if (!triggerArtifactVerified) {
        if (s.lastToolInvocationError) {
          const isUserSkip = /queued user message/i.test(s.lastToolInvocationError);
          const errMsg = isUserSkip ? `Tool skipped for ${s.currentUnit.type}: ${s.lastToolInvocationError}. Queued user message interrupted the turn \u2014 pausing auto-mode.` : `Tool invocation failed for ${s.currentUnit.type}: ${s.lastToolInvocationError}. Structured argument generation failed \u2014 pausing auto-mode.`;
          debugLog("postUnit", { phase: "tool-invocation-error-pause", unitType: s.currentUnit.type, unitId: s.currentUnit.id, error: s.lastToolInvocationError });
          ctx.ui.notify(errMsg, "error");
          s.lastToolInvocationError = null;
          await pauseAuto(ctx, pi);
          return "dispatched";
        }
        const hasExpectedArtifact = resolveExpectedArtifactPath(s.currentUnit.type, s.currentUnit.id, s.basePath) !== null;
        if (hasExpectedArtifact) {
          const retryKey = `${s.currentUnit.type}:${s.currentUnit.id}`;
          const attempt = (s.verificationRetryCount.get(retryKey) ?? 0) + 1;
          const failureDetails = describeArtifactVerificationFailure(
            s.currentUnit.type,
            s.currentUnit.id,
            s.basePath
          );
          if (attempt > MAX_ARTIFACT_VERIFICATION_RETRIES) {
            s.verificationRetryCount.delete(retryKey);
            s.verificationRetryFailureHashes.delete(retryKey);
            debugLog("postUnit", { phase: "artifact-verify-exhausted", unitType: s.currentUnit.type, unitId: s.currentUnit.id, attempt });
            ctx.ui.notify(
              `${failureDetails} Pausing auto-mode after ${MAX_ARTIFACT_VERIFICATION_RETRIES} retries.`,
              "error"
            );
            await pauseAuto(ctx, pi);
            return "dispatched";
          }
          s.verificationRetryCount.set(retryKey, attempt);
          s.pendingVerificationRetry = {
            unitId: s.currentUnit.id,
            failureContext: `${failureDetails} (attempt ${attempt}/${MAX_ARTIFACT_VERIFICATION_RETRIES}).`,
            attempt
          };
          debugLog("postUnit", { phase: "artifact-verify-retry", unitType: s.currentUnit.type, unitId: s.currentUnit.id, attempt });
          ctx.ui.notify(
            `${failureDetails} Retrying (attempt ${attempt}/${MAX_ARTIFACT_VERIFICATION_RETRIES}).`,
            "warning"
          );
          return "retry";
        }
      }
      if (triggerArtifactVerified) {
        const retryKey = verificationRetryKey(s.currentUnit.type, s.currentUnit.id);
        s.verificationRetryCount.delete(retryKey);
        s.verificationRetryFailureHashes.delete(retryKey);
      }
    } else {
    }
  }
  return "continue";
}
async function postUnitPostVerification(pctx) {
  const { s, ctx, pi, buildSnapshotOpts, lockBase, stopAuto, pauseAuto, updateProgressWidget } = pctx;
  if (s.currentUnit) {
    if (shouldDeferCloseoutGitAction(s.currentUnit.type)) {
      const gitActionResult = await runCloseoutGitAction(pctx, s.currentUnit, { softFailure: true });
      if (gitActionResult === "dispatched") {
        return "stopped";
      }
    }
    try {
      const codebasePrefs = loadEffectiveGSDPreferences()?.preferences?.codebase;
      const refresh = ensureCodebaseMapFresh(
        s.basePath,
        codebasePrefs ? {
          excludePatterns: codebasePrefs.exclude_patterns,
          maxFiles: codebasePrefs.max_files,
          collapseThreshold: codebasePrefs.collapse_threshold
        } : void 0,
        { force: true, ttlMs: 0 }
      );
      if (refresh.status === "generated" || refresh.status === "updated") {
        debugLog("postUnit", {
          phase: "codebase-refresh",
          unitType: s.currentUnit.type,
          unitId: s.currentUnit.id,
          status: refresh.status,
          fileCount: refresh.fileCount,
          reason: refresh.reason
        });
      }
    } catch (e) {
      logWarning("engine", `CODEBASE refresh failed: ${e.message}`);
    }
  }
  if (s.currentUnit && !s.stepMode) {
    const hookUnit = checkPostUnitHooks(s.currentUnit.type, s.currentUnit.id, s.basePath);
    if (hookUnit) {
      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt, buildSnapshotOpts(s.currentUnit.type, s.currentUnit.id));
      }
      persistHookState(s.basePath);
      return enqueueSidecar(
        s,
        ctx,
        { kind: "hook", unitType: hookUnit.unitType, unitId: hookUnit.unitId, prompt: hookUnit.prompt, model: hookUnit.model },
        { hookName: hookUnit.hookName }
      );
    }
    if (isRetryPending()) {
      const trigger = consumeRetryTrigger();
      if (trigger) {
        ctx.ui.notify(
          `Hook requested retry of ${trigger.unitType} ${trigger.unitId} \u2014 resetting task state.`,
          "info"
        );
        try {
          const { milestone: mid, slice: sid, task: tid } = parseUnitId(trigger.unitId);
          if (mid && sid && tid) {
            try {
              updateTaskStatus(mid, sid, tid, "pending");
              await renderPlanCheckboxes(s.canonicalProjectRoot, mid, sid);
            } catch (dbErr) {
              logError("engine", `retry state-reset failed (DB unavailable): ${dbErr.message}. Run 'gsd recover' to reconcile.`);
            }
          }
          if (mid && sid && tid) {
            const tasksDir = resolveTasksDir(s.canonicalProjectRoot, mid, sid);
            if (tasksDir) {
              const summaryFile = join(tasksDir, buildTaskFileName(tid, "SUMMARY"));
              if (existsSync(summaryFile)) {
                unlinkSync(summaryFile);
              }
            }
          }
          if (trigger.retryArtifact) {
            const retryArtifactPath = resolveHookArtifactPath(s.canonicalProjectRoot, trigger.unitId, trigger.retryArtifact);
            if (existsSync(retryArtifactPath)) {
              unlinkSync(retryArtifactPath);
            }
          }
          invalidateAllCaches();
        } catch (e) {
          debugLog("postUnitPostVerification", { phase: "retry-state-reset", error: String(e) });
        }
      }
    }
  }
  if (s.currentUnit && s.currentUnit.type !== "triage-captures") {
    try {
      const pending = loadPendingCaptures(s.basePath);
      const STOP_PATTERN = /^(stop|halt|abort|don'?t continue|pause|cease)\b/i;
      const stopCapture = pending.find((c) => STOP_PATTERN.test(c.text.trim()));
      if (stopCapture) {
        ctx.ui.notify(
          `Stop directive detected in pending capture ${stopCapture.id}: "${stopCapture.text}" \u2014 pausing auto-mode.`,
          "warning"
        );
        debugLog("postUnit", { phase: "fast-stop", captureId: stopCapture.id });
        await pauseAuto(ctx, pi);
        return "stopped";
      }
    } catch (e) {
      debugLog("postUnit", { phase: "fast-stop-error", error: String(e) });
    }
  }
  if (s.currentUnit && s.currentUnit.type !== "triage-captures") {
    try {
      const reverted = revertExecutorResolvedCaptures(s.basePath);
      if (reverted > 0) {
        debugLog("postUnit", { phase: "capture-protection", reverted });
        ctx.ui.notify(
          `Reverted ${reverted} capture${reverted === 1 ? "" : "s"} silenced by executor \u2014 re-queuing for triage.`,
          "warning"
        );
      }
    } catch (e) {
      debugLog("postUnit", { phase: "capture-protection-error", error: String(e) });
    }
  }
  if (s.currentUnit && (s.currentUnit.type === "plan-slice" || s.currentUnit.type === "refine-slice")) {
    const currentUnit = s.currentUnit;
    let preExecPauseNeeded = false;
    await runSafely("postUnitPostVerification", "pre-execution-checks", async () => {
      const prefs = loadEffectiveGSDPreferences()?.preferences;
      const uokFlags = resolveUokFlags(prefs);
      try {
        const enhancedEnabled = prefs?.enhanced_verification !== false;
        const preEnabled = prefs?.enhanced_verification_pre !== false;
        if (!enhancedEnabled || !preEnabled) {
          debugLog("postUnitPostVerification", {
            phase: "pre-execution-checks",
            skipped: true,
            reason: "disabled by preferences"
          });
          return;
        }
        const { milestone: mid, slice: sid } = parseUnitId(currentUnit.id);
        if (!mid || !sid) {
          debugLog("postUnitPostVerification", {
            phase: "pre-execution-checks",
            skipped: true,
            reason: "could not parse milestone/slice from unit ID"
          });
          return;
        }
        const tasks = getSliceTasks(mid, sid);
        if (tasks.length === 0) {
          debugLog("postUnitPostVerification", {
            phase: "pre-execution-checks",
            skipped: true,
            reason: "no tasks found for slice"
          });
          return;
        }
        const strictMode = prefs?.enhanced_verification_strict === true;
        const preExecutionBasePath = s.basePath;
        const result = await runPreExecutionChecks(tasks, preExecutionBasePath);
        const emoji = result.status === "pass" ? "\u2705" : result.status === "warn" ? "\u26A0\uFE0F" : "\u274C";
        process.stderr.write(
          `gsd-pre-exec: ${emoji} Pre-execution checks ${result.status} for ${mid}/${sid} (${result.durationMs}ms)
`
        );
        for (const check of result.checks) {
          const checkEmoji = check.passed ? "\u2713" : check.blocking ? "\u2717" : "\u26A0";
          process.stderr.write(
            `gsd-pre-exec:   ${checkEmoji} [${check.category}] ${check.target}: ${check.message}
`
          );
        }
        const slicePath = resolveSlicePath(preExecutionBasePath, mid, sid);
        const evidenceFileName = `${sid}-PRE-EXEC-VERIFY.json`;
        let evidencePath = join(".gsd", "milestones", mid, "slices", sid, evidenceFileName);
        if (slicePath) {
          writePreExecutionEvidence(result, slicePath, mid, sid);
          evidencePath = relative(preExecutionBasePath, join(slicePath, evidenceFileName)) || evidenceFileName;
        }
        if (uokFlags.gates) {
          const failedChecks = result.checks.filter((check) => !check.passed).map((check) => `[${check.category}] ${check.target}: ${check.message}`);
          const warnEscalated = result.status === "warn" && strictMode;
          const blockingFailure = result.status === "fail" || warnEscalated;
          const gateRunner = new UokGateRunner();
          gateRunner.register({
            id: "pre-execution-checks",
            type: "input",
            execute: async () => ({
              outcome: blockingFailure ? "fail" : "pass",
              failureClass: result.status === "fail" ? "input" : warnEscalated ? "policy" : "none",
              rationale: blockingFailure ? `pre-execution checks ${result.status}${warnEscalated ? " (strict)" : ""}` : "pre-execution checks passed",
              findings: failedChecks.join("\n")
            })
          });
          await gateRunner.run("pre-execution-checks", {
            basePath: s.basePath,
            traceId: `pre-execution:${currentUnit.id}`,
            turnId: currentUnit.id,
            milestoneId: mid,
            sliceId: sid,
            unitType: currentUnit.type,
            unitId: currentUnit.id
          });
        }
        if (result.status === "fail") {
          const blockingChecks = result.checks.filter((c) => !c.passed && c.blocking);
          const blockingCount = blockingChecks.length;
          const details = blockingChecks.slice(0, MAX_NOTIFICATION_DETAILS).map(formatPreExecutionCheckDetail).join("\n");
          const suffix = blockingChecks.length > MAX_NOTIFICATION_DETAILS ? `
  ${NOTIFICATION_BULLET} ...and ${blockingChecks.length - MAX_NOTIFICATION_DETAILS} more` : "";
          const evidenceNote = `
See ${evidencePath} for full details.`;
          ctx.ui.notify(
            `Pre-execution checks failed: ${blockingCount} blocking issue${blockingCount === 1 ? "" : "s"} found
${details}${suffix}${evidenceNote}`,
            "error"
          );
          s.lastPreExecFailure = {
            unitId: currentUnit.id,
            blockingFindings: blockingChecks.map(
              (c) => `[${c.category}] ${c.target}: ${c.message}`
            ),
            verdictExcerpt: `status=${result.status}; ${blockingCount} blocking issue${blockingCount === 1 ? "" : "s"} detected`
          };
          const retryKey = currentUnit.id;
          s.preExecRetryCount.set(retryKey, (s.preExecRetryCount.get(retryKey) ?? 0) + 1);
          preExecPauseNeeded = true;
        } else if (result.status === "warn") {
          ctx.ui.notify(
            `Pre-execution checks passed with warnings`,
            "warning"
          );
          if (prefs?.enhanced_verification_strict === true) {
            const warnChecks = result.checks.filter((c) => !c.passed);
            s.lastPreExecFailure = {
              unitId: currentUnit.id,
              blockingFindings: warnChecks.map(
                (c) => `[${c.category}] ${c.target}: ${c.message}`
              ),
              verdictExcerpt: `status=${result.status} (strict mode); ${warnChecks.length} warning${warnChecks.length === 1 ? "" : "s"} treated as blocking`
            };
            const retryKey = currentUnit.id;
            s.preExecRetryCount.set(retryKey, (s.preExecRetryCount.get(retryKey) ?? 0) + 1);
            preExecPauseNeeded = true;
          }
        }
        if (result.status === "pass") {
          s.preExecRetryCount.delete(currentUnit.id);
        }
        debugLog("postUnitPostVerification", {
          phase: "pre-execution-checks",
          status: result.status,
          checkCount: result.checks.length,
          durationMs: result.durationMs
        });
      } catch (preExecError) {
        const errorMessage = preExecError instanceof Error ? preExecError.message : String(preExecError);
        debugLog("postUnitPostVerification", {
          phase: "pre-execution-checks",
          error: errorMessage,
          failClosed: true
        });
        logError("engine", `gsd-pre-exec: Pre-execution checks threw an error: ${errorMessage}`);
        ctx.ui.notify(
          `Pre-execution checks error: ${errorMessage} \u2014 pausing for human review`,
          "error"
        );
        if (uokFlags.gates && s.currentUnit) {
          const { milestone: mid, slice: sid } = parseUnitId(s.currentUnit.id);
          const gateRunner = new UokGateRunner();
          gateRunner.register({
            id: "pre-execution-checks",
            type: "input",
            execute: async () => ({
              outcome: "manual-attention",
              failureClass: "manual-attention",
              rationale: "pre-execution checks threw before completion",
              findings: errorMessage
            })
          });
          await gateRunner.run("pre-execution-checks", {
            basePath: s.basePath,
            traceId: `pre-execution:${s.currentUnit.id}`,
            turnId: s.currentUnit.id,
            milestoneId: mid ?? void 0,
            sliceId: sid ?? void 0,
            unitType: s.currentUnit.type,
            unitId: s.currentUnit.id
          });
        }
        preExecPauseNeeded = true;
      }
    });
    if (preExecPauseNeeded) {
      debugLog("postUnitPostVerification", { phase: "pre-execution-checks", pausing: true, reason: "blocking failures detected" });
      await pauseAuto(ctx, pi);
      return "stopped";
    }
  }
  if (_shouldDispatchTriageForTest(s)) {
    try {
      if (hasPendingCaptures(s.basePath)) {
        const pending = loadPendingCaptures(s.basePath);
        if (pending.length > 0) {
          const readRoot = s.canonicalProjectRoot;
          const state = await deriveState(readRoot);
          const mid = state.activeMilestone?.id;
          const sid = state.activeSlice?.id;
          if (mid && sid) {
            let currentPlan = "";
            let roadmapContext = "";
            const planFile = resolveSliceFile(readRoot, mid, sid, "PLAN");
            if (planFile) currentPlan = await loadFile(planFile) ?? "";
            const roadmapFile = resolveMilestoneFile(readRoot, mid, "ROADMAP");
            if (roadmapFile) roadmapContext = await loadFile(roadmapFile) ?? "";
            const capturesList = pending.map(
              (c) => `- **${c.id}**: "${c.text}" (captured: ${c.timestamp})`
            ).join("\n");
            const prompt = loadPrompt("triage-captures", {
              pendingCaptures: capturesList,
              currentPlan: currentPlan || "(no active slice plan)",
              roadmapContext: roadmapContext || "(no active roadmap)"
            });
            if (s.currentUnit) {
              await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
            }
            const triageUnitId = `${mid}/${sid}/triage`;
            return enqueueSidecar(
              s,
              ctx,
              { kind: "triage", unitType: "triage-captures", unitId: triageUnitId, prompt },
              { pendingCount: pending.length },
              `Triaging ${pending.length} pending capture${pending.length === 1 ? "" : "s"}...`
            );
          }
        }
      }
    } catch (e) {
      debugLog("postUnit", { phase: "triage-check", error: String(e) });
    }
  }
  if (_shouldDispatchQuickTaskForTest(s)) {
    try {
      const capture = s.pendingQuickTasks.shift();
      const { buildQuickTaskPrompt } = await import("./triage-resolution.js");
      const { markCaptureExecuted } = await import("./captures.js");
      const prompt = buildQuickTaskPrompt(capture);
      if (s.currentUnit) {
        await closeoutUnit(ctx, s.basePath, s.currentUnit.type, s.currentUnit.id, s.currentUnit.startedAt);
      }
      markCaptureExecuted(s.basePath, capture.id);
      const qtUnitId = `${s.currentMilestoneId}/${capture.id}`;
      return enqueueSidecar(
        s,
        ctx,
        { kind: "quick-task", unitType: "quick-task", unitId: qtUnitId, prompt, captureId: capture.id },
        { captureId: capture.id },
        `Executing quick-task: ${capture.id} \u2014 "${capture.text}"`
      );
    } catch (e) {
      debugLog("postUnit", { phase: "quick-task-dispatch", error: String(e) });
    }
  }
  if (s.stepMode) {
    let phaseAfterUnit = null;
    try {
      const nextState = await deriveState(s.canonicalProjectRoot);
      phaseAfterUnit = nextState.phase;
      ctx.ui.notify(buildStepCompleteMessage(nextState), "info");
    } catch (e) {
      debugLog("postUnit", { phase: "step-wizard-notify", error: String(e) });
      ctx.ui.notify(STEP_COMPLETE_FALLBACK_MESSAGE, "info");
    }
    return shouldReturnStepWizardAfterUnit(s.currentUnit?.type, phaseAfterUnit) ? "step-wizard" : "continue";
  }
  return "continue";
}
export {
  MAX_ARTIFACT_VERIFICATION_RETRIES,
  STEP_COMPLETE_FALLBACK_MESSAGE,
  USER_DRIVEN_DEEP_UNITS,
  _shouldDispatchQuickTaskForTest,
  _shouldDispatchTriageForTest,
  autoCommitUnit,
  buildStepCompleteMessage,
  detectRogueFileWrites,
  isAwaitingUserInput2 as isAwaitingUserInput,
  postUnitPostVerification,
  postUnitPreVerification,
  shouldDeferCloseoutGitAction,
  shouldReturnStepWizardAfterUnit
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLXBvc3QtdW5pdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEF1dG8tbW9kZSBwb3N0LXVuaXQgZ2l0LCB2ZXJpZmljYXRpb24sIHByb2plY3Rpb24sIGFuZCBob29rIHByb2Nlc3NpbmcuXG4vKipcbiAqIFBvc3QtdW5pdCBwcm9jZXNzaW5nIGZvciBhdXRvLWxvb3AgXHUyMDE0IGF1dG8tY29tbWl0LCBkb2N0b3IgcnVuLFxuICogc3RhdGUgcmVidWlsZCwgcHJvamVjdGlvbiBjaGVja3MsIERCIHRvb2wgY2xvc2VvdXQsIGhvb2tzLCB0cmlhZ2UsIGFuZFxuICogcXVpY2stdGFzayBkaXNwYXRjaC5cbiAqXG4gKiBTcGxpdCBpbnRvIHR3byBmdW5jdGlvbnMgY2FsbGVkIHNlcXVlbnRpYWxseSBieSBhdXRvLWxvb3Agd2l0aFxuICogdGhlIHZlcmlmaWNhdGlvbiBnYXRlIGJldHdlZW4gdGhlbTpcbiAqICAgMS4gcG9zdFVuaXRQcmVWZXJpZmljYXRpb24oKSBcdTIwMTQgY2xvc2VvdXQgZ2l0IGZvciBub24tdGFzayB1bml0cywgZG9jdG9yLCBzdGF0ZSByZWJ1aWxkLCB3b3JrdHJlZSBzeW5jLCBhcnRpZmFjdCB2ZXJpZmljYXRpb25cbiAqICAgMi4gcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uKCkgXHUyMDE0IHBvc3QtdmVyaWZpZWQgdGFzayBnaXQsIERCIGR1YWwtd3JpdGUsIGhvb2tzLCB0cmlhZ2UsIHF1aWNrLXRhc2tzXG4gKlxuICogRXh0cmFjdGVkIGZyb20gdGhlIHByZS1sb29wIGFnZW50X2VuZCBoYW5kbGVyIGluIGF1dG8udHMuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBFeHRlbnNpb25Db250ZXh0LCBFeHRlbnNpb25BUEkgfSBmcm9tIFwiQGdzZC9waS1jb2RpbmctYWdlbnRcIjtcbmltcG9ydCB7IGRlcml2ZVN0YXRlIH0gZnJvbSBcIi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcsIGxvZ0Vycm9yIH0gZnJvbSBcIi4vd29ya2Zsb3ctbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyBsb2FkRmlsZSwgcGFyc2VTdW1tYXJ5LCByZXNvbHZlQWxsT3ZlcnJpZGVzIH0gZnJvbSBcIi4vZmlsZXMuanNcIjtcbmltcG9ydCB7IGxvYWRQcm9tcHQgfSBmcm9tIFwiLi9wcm9tcHQtbG9hZGVyLmpzXCI7XG5pbXBvcnQgeyBpc0F3YWl0aW5nVXNlcklucHV0IH0gZnJvbSBcIi4vdXNlci1pbnB1dC1ib3VuZGFyeS5qc1wiO1xuaW1wb3J0IHtcbiAgcmVzb2x2ZVNsaWNlRmlsZSxcbiAgcmVzb2x2ZVNsaWNlUGF0aCxcbiAgcmVzb2x2ZVRhc2tGaWxlLFxuICByZXNvbHZlTWlsZXN0b25lRmlsZSxcbiAgcmVzb2x2ZVRhc2tzRGlyLFxuICBidWlsZFRhc2tGaWxlTmFtZSxcbn0gZnJvbSBcIi4vcGF0aHMuanNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVBbGxDYWNoZXMgfSBmcm9tIFwiLi9jYWNoZS5qc1wiO1xuaW1wb3J0IHsgcmVidWlsZFN0YXRlIH0gZnJvbSBcIi4vZG9jdG9yLmpzXCI7XG5pbXBvcnQgeyBwYXJzZVVuaXRJZCB9IGZyb20gXCIuL3VuaXQtaWQuanNcIjtcbmltcG9ydCB7IGNsb3Nlb3V0VW5pdCwgdHlwZSBDbG9zZW91dE9wdGlvbnMgfSBmcm9tIFwiLi9hdXRvLXVuaXQtY2xvc2VvdXQuanNcIjtcbmltcG9ydCB7XG4gIHJ1blR1cm5HaXRBY3Rpb24sXG4gIHR5cGUgVGFza0NvbW1pdENvbnRleHQsXG4gIHR5cGUgVHVybkdpdEFjdGlvbk1vZGUsXG59IGZyb20gXCIuL2dpdC1zZXJ2aWNlLmpzXCI7XG5pbXBvcnQge1xuICB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0LFxuICByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGgsXG4gIHdyaXRlQmxvY2tlclBsYWNlaG9sZGVyLFxuICBkaWFnbm9zZUV4cGVjdGVkQXJ0aWZhY3QsXG4gIGRpYWdub3NlV29ya3RyZWVJbnRlZ3JpdHlGYWlsdXJlLFxufSBmcm9tIFwiLi9hdXRvLXJlY292ZXJ5LmpzXCI7XG5pbXBvcnQgeyByZWdlbmVyYXRlSWZNaXNzaW5nIH0gZnJvbSBcIi4vd29ya2Zsb3ctcHJvamVjdGlvbnMuanNcIjtcbmltcG9ydCB7IFdvcmt0cmVlU3RhdGVQcm9qZWN0aW9uIH0gZnJvbSBcIi4vd29ya3RyZWUtc3RhdGUtcHJvamVjdGlvbi5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlV29ya3NwYWNlLCBzY29wZU1pbGVzdG9uZSB9IGZyb20gXCIuL3dvcmtzcGFjZS5qc1wiO1xuaW1wb3J0IHsgbm9ybWFsaXplV29ya3RyZWVQYXRoRm9yQ29tcGFyZSB9IGZyb20gXCIuL3dvcmt0cmVlLXJvb3QuanNcIjtcbmltcG9ydCB7IGlzRGJBdmFpbGFibGUsIGdldFRhc2ssIGdldFNsaWNlLCBnZXRNaWxlc3RvbmUsIHVwZGF0ZVRhc2tTdGF0dXMsIF9nZXRBZGFwdGVyLCBnZXRWZXJpZmljYXRpb25FdmlkZW5jZSB9IGZyb20gXCIuL2dzZC1kYi5qc1wiO1xuaW1wb3J0IHsgcmVuZGVyUGxhbkNoZWNrYm94ZXMgfSBmcm9tIFwiLi9tYXJrZG93bi1yZW5kZXJlci5qc1wiO1xuaW1wb3J0IHsgY29uc3VtZVNpZ25hbCB9IGZyb20gXCIuL3Nlc3Npb24tc3RhdHVzLWlvLmpzXCI7XG5pbXBvcnQge1xuICBjaGVja1Bvc3RVbml0SG9va3MsXG4gIGlzUmV0cnlQZW5kaW5nLFxuICBjb25zdW1lUmV0cnlUcmlnZ2VyLFxuICBwZXJzaXN0SG9va1N0YXRlLFxuICByZXNvbHZlSG9va0FydGlmYWN0UGF0aCxcbn0gZnJvbSBcIi4vcG9zdC11bml0LWhvb2tzLmpzXCI7XG5pbXBvcnQgeyBoYXNQZW5kaW5nQ2FwdHVyZXMsIGxvYWRQZW5kaW5nQ2FwdHVyZXMsIHJldmVydEV4ZWN1dG9yUmVzb2x2ZWRDYXB0dXJlcyB9IGZyb20gXCIuL2NhcHR1cmVzLmpzXCI7XG5pbXBvcnQgeyBkZWJ1Z0xvZyB9IGZyb20gXCIuL2RlYnVnLWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgcnVuU2FmZWx5IH0gZnJvbSBcIi4vYXV0by11dGlscy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBBdXRvU2Vzc2lvbiwgU2lkZWNhckl0ZW0gfSBmcm9tIFwiLi9hdXRvL3Nlc3Npb24uanNcIjtcbmltcG9ydCB7IGdldEV2aWRlbmNlLCBjbGVhckV2aWRlbmNlRnJvbURpc2sgfSBmcm9tIFwiLi9zYWZldHkvZXZpZGVuY2UtY29sbGVjdG9yLmpzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZUZpbGVDaGFuZ2VzIH0gZnJvbSBcIi4vc2FmZXR5L2ZpbGUtY2hhbmdlLXZhbGlkYXRvci5qc1wiO1xuaW1wb3J0IHsgY3Jvc3NSZWZlcmVuY2VFdmlkZW5jZSwgdHlwZSBDbGFpbWVkRXZpZGVuY2UgfSBmcm9tIFwiLi9zYWZldHkvZXZpZGVuY2UtY3Jvc3MtcmVmLmpzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZUNvbnRlbnQgfSBmcm9tIFwiLi9zYWZldHkvY29udGVudC12YWxpZGF0b3IuanNcIjtcbmltcG9ydCB7IHJlc29sdmVTYWZldHlIYXJuZXNzQ29uZmlnIH0gZnJvbSBcIi4vc2FmZXR5L3NhZmV0eS1oYXJuZXNzLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlRXhwZWN0ZWRBcnRpZmFjdFBhdGggYXMgcmVzb2x2ZUFydGlmYWN0Rm9yQ29udGVudCB9IGZyb20gXCIuL2F1dG8tYXJ0aWZhY3QtcGF0aHMuanNcIjtcbmltcG9ydCB7IGdldElzb2xhdGlvbk1vZGUsIGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyB9IGZyb20gXCIuL3ByZWZlcmVuY2VzLmpzXCI7XG5pbXBvcnQgeyBnZXRTbGljZVRhc2tzIH0gZnJvbSBcIi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyBydW5QcmVFeGVjdXRpb25DaGVja3MsIHR5cGUgUHJlRXhlY3V0aW9uUmVzdWx0IH0gZnJvbSBcIi4vcHJlLWV4ZWN1dGlvbi1jaGVja3MuanNcIjtcbmltcG9ydCB7IHdyaXRlUHJlRXhlY3V0aW9uRXZpZGVuY2UsIHR5cGUgUHJlRXhlY3V0aW9uQ2hlY2tKU09OIH0gZnJvbSBcIi4vdmVyaWZpY2F0aW9uLWV2aWRlbmNlLmpzXCI7XG5pbXBvcnQgeyBlbnN1cmVDb2RlYmFzZU1hcEZyZXNoIH0gZnJvbSBcIi4vY29kZWJhc2UtZ2VuZXJhdG9yLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlVW9rRmxhZ3MgfSBmcm9tIFwiLi91b2svZmxhZ3MuanNcIjtcbmltcG9ydCB7IFVva0dhdGVSdW5uZXIgfSBmcm9tIFwiLi91b2svZ2F0ZS1ydW5uZXIuanNcIjtcbmltcG9ydCB7IHdyaXRlVHVybkdpdFRyYW5zYWN0aW9uIH0gZnJvbSBcIi4vdW9rL2dpdG9wcy5qc1wiO1xuaW1wb3J0IHsgaXNDbG9zZWRTdGF0dXMgfSBmcm9tIFwiLi9zdGF0dXMtZ3VhcmRzLmpzXCI7XG5pbXBvcnQgeyBkZXRlY3RBYmFuZG9uTWlsZXN0b25lIH0gZnJvbSBcIi4vYWJhbmRvbi1kZXRlY3QuanNcIjtcbmltcG9ydCB7IGlzRGV0ZXJtaW5pc3RpY1BvbGljeUVycm9yIH0gZnJvbSBcIi4vYXV0by10b29sLXRyYWNraW5nLmpzXCI7XG5pbXBvcnQge1xuICBjbGVhclByb2plY3RSZXNlYXJjaEluZmxpZ2h0TWFya2VyLFxuICBmaW5hbGl6ZVByb2plY3RSZXNlYXJjaFRpbWVvdXQsXG59IGZyb20gXCIuL3Byb2plY3QtcmVzZWFyY2gtcG9saWN5LmpzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZUFydGlmYWN0IH0gZnJvbSBcIi4vc2NoZW1hcy92YWxpZGF0ZS5qc1wiO1xuaW1wb3J0IHsgdmVyaWZpY2F0aW9uUmV0cnlLZXkgfSBmcm9tIFwiLi9hdXRvL3ZlcmlmaWNhdGlvbi1yZXRyeS1wb2xpY3kuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFBhdGggQ29tcGFyaXNvbiBIZWxwZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vKiogQ29tcGFyZSB0d28gcGF0aHMgZm9yIHBoeXNpY2FsIGlkZW50aXR5LCB0b2xlcmF0aW5nIHRyYWlsaW5nIHNsYXNoZXMgYW5kIHN5bWxpbmtzLiAqL1xuZnVuY3Rpb24gaXNTYW1lUGF0aExvY2FsKGE6IHN0cmluZywgYjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBub3JtYWxpemVXb3JrdHJlZVBhdGhGb3JDb21wYXJlKGEpID09PSBub3JtYWxpemVXb3JrdHJlZVBhdGhGb3JDb21wYXJlKGIpO1xufVxuXG4vKiogU3RhdGVsZXNzIFdvcmt0cmVlU3RhdGVQcm9qZWN0aW9uIFx1MjAxNCBtZXRob2RzIGFyZSBwdXJlIGZ1bmN0aW9ucyBvZiBNaWxlc3RvbmVTY29wZS4gKi9cbmNvbnN0IF93b3JrdHJlZVByb2plY3Rpb24gPSBuZXcgV29ya3RyZWVTdGF0ZVByb2plY3Rpb24oKTtcblxuLyoqIE1heGltdW0gdmVyaWZpY2F0aW9uIHJldHJ5IGF0dGVtcHRzIGJlZm9yZSBlc2NhbGF0aW5nIHRvIGJsb2NrZXIgcGxhY2Vob2xkZXIgKCMyNjUzKS4gKi9cbmNvbnN0IE1BWF9WRVJJRklDQVRJT05fUkVUUklFUyA9IDM7XG4vKiogS2VlcCBmYWlsdXJlIHRvYXN0cyBzaG9ydCB3aGlsZSBzdGlsbCBzaG93aW5nIGNvbmNyZXRlIGV4YW1wbGVzLiAqL1xuY29uc3QgTUFYX05PVElGSUNBVElPTl9ERVRBSUxTID0gMztcbmNvbnN0IE5PVElGSUNBVElPTl9CVUxMRVQgPSBcIlx1MjAyMlwiO1xuXG5mdW5jdGlvbiBmb3JtYXRQcmVFeGVjdXRpb25DaGVja0RldGFpbChjaGVjazogUHJlRXhlY3V0aW9uQ2hlY2tKU09OKTogc3RyaW5nIHtcbiAgY29uc3QgY2F0ZWdvcnkgPSBjaGVjay5jYXRlZ29yeT8udHJpbSgpIHx8IFwidW5rbm93biBjYXRlZ29yeVwiO1xuICBjb25zdCB0YXJnZXQgPSBjaGVjay50YXJnZXQ/LnRyaW0oKSB8fCBcInVua25vd24gdGFyZ2V0XCI7XG4gIGNvbnN0IG1lc3NhZ2UgPSBjaGVjay5tZXNzYWdlLnNwbGl0KC9cXHI/XFxuLywgMSlbMF0/LnRyaW0oKSB8fCBcIk5vIGRldGFpbHMgcHJvdmlkZWRcIjtcbiAgcmV0dXJuIGAgICR7Tk9USUZJQ0FUSU9OX0JVTExFVH0gWyR7Y2F0ZWdvcnl9XSAke3RhcmdldH06ICR7bWVzc2FnZX1gO1xufVxuXG5jb25zdCBDT01QTEVURV9NSUxFU1RPTkVfREJfU0VUVExFX01TID0gMTUwMDtcbmNvbnN0IENPTVBMRVRFX01JTEVTVE9ORV9EQl9TRVRUTEVfUE9MTF9NUyA9IDEwMDtcblxuZnVuY3Rpb24gc3RyaXBLbm93bklkUHJlZml4KHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQgfCBudWxsLCBpZDogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcmF3ID0gU3RyaW5nKHZhbHVlID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCFyYXcpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IGxvd2VyID0gcmF3LnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IGlkTG93ZXIgPSBpZC50b0xvd2VyQ2FzZSgpO1xuICBpZiAobG93ZXIuc3RhcnRzV2l0aChgJHtpZExvd2VyfTpgKSkgcmV0dXJuIHJhdy5zbGljZShpZC5sZW5ndGggKyAxKS50cmltKCkgfHwgdW5kZWZpbmVkO1xuICByZXR1cm4gcmF3O1xufVxuXG5hc3luYyBmdW5jdGlvbiBidWlsZFRhc2tDb21taXRDb250ZXh0Rm9yVW5pdChcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4pOiBQcm9taXNlPFRhc2tDb21taXRDb250ZXh0IHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQsIHRhc2s6IHRpZCB9ID0gcGFyc2VVbml0SWQodW5pdElkKTtcbiAgaWYgKCFtaWQgfHwgIXNpZCB8fCAhdGlkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IG1pbGVzdG9uZSA9IGlzRGJBdmFpbGFibGUoKSA/IGdldE1pbGVzdG9uZShtaWQpIDogbnVsbDtcbiAgY29uc3Qgc2xpY2UgPSBpc0RiQXZhaWxhYmxlKCkgPyBnZXRTbGljZShtaWQsIHNpZCkgOiBudWxsO1xuICBjb25zdCB0YXNrID0gaXNEYkF2YWlsYWJsZSgpID8gZ2V0VGFzayhtaWQsIHNpZCwgdGlkKSA6IG51bGw7XG4gIGxldCBzdW1tYXJ5OiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZVN1bW1hcnk+IHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3Qgc3VtbWFyeVBhdGggPSByZXNvbHZlVGFza0ZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCB0aWQsIFwiU1VNTUFSWVwiKTtcbiAgaWYgKHN1bW1hcnlQYXRoKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN1bW1hcnlDb250ZW50ID0gYXdhaXQgbG9hZEZpbGUoc3VtbWFyeVBhdGgpO1xuICAgICAgaWYgKHN1bW1hcnlDb250ZW50KSBzdW1tYXJ5ID0gcGFyc2VTdW1tYXJ5KHN1bW1hcnlDb250ZW50KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHsgcGhhc2U6IFwidGFzay1zdW1tYXJ5LXBhcnNlXCIsIGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKCFzdW1tYXJ5ICYmICF0YXNrKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGxldCBnaElzc3VlTnVtYmVyOiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBnZXRUYXNrSXNzdWVOdW1iZXJGb3JDb21taXQgfSA9IGF3YWl0IGltcG9ydChcIi4uL2dpdGh1Yi1zeW5jL3N5bmMuanNcIik7XG4gICAgZ2hJc3N1ZU51bWJlciA9IGdldFRhc2tJc3N1ZU51bWJlckZvckNvbW1pdChiYXNlUGF0aCwgbWlkLCBzaWQsIHRpZCkgPz8gdW5kZWZpbmVkO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBHaXRIdWIgaXNzdWUgbG9va3VwIGZhaWxlZDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHRhc2tJZDogYCR7c2lkfS8ke3RpZH1gLFxuICAgIHRhc2tEaXNwbGF5SWQ6IHRpZCxcbiAgICB0YXNrVGl0bGU6XG4gICAgICBzdHJpcEtub3duSWRQcmVmaXgoc3VtbWFyeT8udGl0bGUsIHRpZCkgPz9cbiAgICAgIHN0cmlwS25vd25JZFByZWZpeCh0YXNrPy50aXRsZSwgdGlkKSA/P1xuICAgICAgdGlkLFxuICAgIG1pbGVzdG9uZUlkOiBtaWQsXG4gICAgbWlsZXN0b25lVGl0bGU6IHN0cmlwS25vd25JZFByZWZpeChtaWxlc3RvbmU/LnRpdGxlLCBtaWQpLFxuICAgIHNsaWNlSWQ6IHNpZCxcbiAgICBzbGljZVRpdGxlOiBzdHJpcEtub3duSWRQcmVmaXgoc2xpY2U/LnRpdGxlLCBzaWQpLFxuICAgIG9uZUxpbmVyOiBzdW1tYXJ5Py5vbmVMaW5lciB8fCB0YXNrPy5vbmVfbGluZXIgfHwgdW5kZWZpbmVkLFxuICAgIGtleUZpbGVzOlxuICAgICAgc3VtbWFyeT8uZnJvbnRtYXR0ZXIua2V5X2ZpbGVzPy5maWx0ZXIoZiA9PiAhZi5pbmNsdWRlcyhcInt7XCIpICYmIGYudHJpbSgpICE9PSBcIihub25lKVwiKSA/P1xuICAgICAgdGFzaz8ua2V5X2ZpbGVzID8/XG4gICAgICB1bmRlZmluZWQsXG4gICAgaXNzdWVOdW1iZXI6IGdoSXNzdWVOdW1iZXIsXG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JNaWxlc3RvbmVEYkNsb3NlKG1pZDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIENPTVBMRVRFX01JTEVTVE9ORV9EQl9TRVRUTEVfTVM7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBpZiAoIWlzRGJBdmFpbGFibGUoKSkgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IG1pbGVzdG9uZSA9IGdldE1pbGVzdG9uZShtaWQpO1xuICAgIGlmIChtaWxlc3RvbmUgJiYgaXNDbG9zZWRTdGF0dXMobWlsZXN0b25lLnN0YXR1cykpIHJldHVybiB0cnVlO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIENPTVBMRVRFX01JTEVTVE9ORV9EQl9TRVRUTEVfUE9MTF9NUykpO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuXG4vKiogRW5xdWV1ZSBhIHNpZGVjYXIgaXRlbSAoaG9vaywgdHJpYWdlLCBvciBxdWljay10YXNrKSBmb3IgdGhlIG1haW4gbG9vcCB0b1xuICogIGRyYWluIHZpYSBydW5Vbml0LiBMb2dzIHRoZSBlbnF1ZXVlIGV2ZW50IGFuZCBub3RpZmllcyB0aGUgVUkuICovXG5mdW5jdGlvbiBlbnF1ZXVlU2lkZWNhcihcbiAgczogQXV0b1Nlc3Npb24sXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCxcbiAgZW50cnk6IFNpZGVjYXJJdGVtLFxuICBkZWJ1Z0V4dHJhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgbm90aWZpY2F0aW9uPzogc3RyaW5nLFxuKTogXCJjb250aW51ZVwiIHtcbiAgcy5zaWRlY2FyUXVldWUucHVzaChlbnRyeSk7XG4gIGRlYnVnTG9nKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIsIHtcbiAgICBwaGFzZTogXCJzaWRlY2FyLWVucXVldWVcIixcbiAgICBraW5kOiBlbnRyeS5raW5kLFxuICAgIHVuaXRJZDogZW50cnkudW5pdElkLFxuICAgIC4uLmRlYnVnRXh0cmEsXG4gIH0pO1xuICBpZiAobm90aWZpY2F0aW9uKSBjdHgudWkubm90aWZ5KG5vdGlmaWNhdGlvbiwgXCJpbmZvXCIpO1xuICByZXR1cm4gXCJjb250aW51ZVwiO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gX3Nob3VsZERpc3BhdGNoVHJpYWdlRm9yVGVzdChcbiAgc3RhdGU6IFBpY2s8QXV0b1Nlc3Npb24sIFwic3RlcE1vZGVcIiB8IFwiY3VycmVudFVuaXRcIj4sXG4pOiBib29sZWFuIHtcbiAgcmV0dXJuICFzdGF0ZS5zdGVwTW9kZSAmJlxuICAgICEhc3RhdGUuY3VycmVudFVuaXQgJiZcbiAgICAhc3RhdGUuY3VycmVudFVuaXQudHlwZS5zdGFydHNXaXRoKFwiaG9vay9cIikgJiZcbiAgICBzdGF0ZS5jdXJyZW50VW5pdC50eXBlICE9PSBcInRyaWFnZS1jYXB0dXJlc1wiICYmXG4gICAgc3RhdGUuY3VycmVudFVuaXQudHlwZSAhPT0gXCJxdWljay10YXNrXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBfc2hvdWxkRGlzcGF0Y2hRdWlja1Rhc2tGb3JUZXN0KFxuICBzdGF0ZTogUGljazxBdXRvU2Vzc2lvbiwgXCJzdGVwTW9kZVwiIHwgXCJjdXJyZW50VW5pdFwiIHwgXCJwZW5kaW5nUXVpY2tUYXNrc1wiPixcbik6IGJvb2xlYW4ge1xuICByZXR1cm4gIXN0YXRlLnN0ZXBNb2RlICYmXG4gICAgc3RhdGUucGVuZGluZ1F1aWNrVGFza3MubGVuZ3RoID4gMCAmJlxuICAgICEhc3RhdGUuY3VycmVudFVuaXQgJiZcbiAgICBzdGF0ZS5jdXJyZW50VW5pdC50eXBlICE9PSBcInF1aWNrLXRhc2tcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZERlZmVyQ2xvc2VvdXRHaXRBY3Rpb24odW5pdFR5cGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gdW5pdFR5cGUgPT09IFwiZXhlY3V0ZS10YXNrXCI7XG59XG5cbi8qKiBVbml0IHR5cGVzIHRoYXQgb25seSB0b3VjaCBgLmdzZC9gIGludGVybmFsIHN0YXRlIGZpbGVzIChubyBjb2RlIGNoYW5nZXMpLlxuICogIEF1dG8tY29tbWl0IGlzIHNraXBwZWQgZm9yIHRoZXNlIFx1MjAxNCB0aGVpciBzdGF0ZSBmaWxlcyBhcmUgcGlja2VkIHVwIGJ5IHRoZVxuICogIG5leHQgYWN0dWFsIHRhc2sgY29tbWl0IHZpYSBgc21hcnRTdGFnZSgpYC4gKi9cbmNvbnN0IExJRkVDWUNMRV9PTkxZX1VOSVRTID0gbmV3IFNldChbXG4gIFwicmVzZWFyY2gtbWlsZXN0b25lXCIsIFwiZGlzY3Vzcy1taWxlc3RvbmVcIiwgXCJkaXNjdXNzLXNsaWNlXCIsIFwicGxhbi1taWxlc3RvbmVcIixcbiAgXCJ2YWxpZGF0ZS1taWxlc3RvbmVcIiwgXCJyZXNlYXJjaC1zbGljZVwiLCBcInBsYW4tc2xpY2VcIiwgXCJyZWZpbmUtc2xpY2VcIixcbiAgXCJyZXBsYW4tc2xpY2VcIiwgXCJjb21wbGV0ZS1zbGljZVwiLCBcInJ1bi11YXRcIixcbiAgXCJyZWFzc2Vzcy1yb2FkbWFwXCIsIFwicmV3cml0ZS1kb2NzXCIsXG5dKTtcbmltcG9ydCB7XG4gIHVwZGF0ZVByb2dyZXNzV2lkZ2V0IGFzIF91cGRhdGVQcm9ncmVzc1dpZGdldCxcbiAgdXBkYXRlU2xpY2VQcm9ncmVzc0NhY2hlLFxuICB1bml0VmVyYixcbiAgZGVzY3JpYmVOZXh0VW5pdCxcbn0gZnJvbSBcIi4vYXV0by1kYXNoYm9hcmQuanNcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiwgcmVsYXRpdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBfcmVzZXRIYXNDaGFuZ2VzQ2FjaGUgfSBmcm9tIFwiLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc1wiO1xuaW1wb3J0IHsgYXV0b0NvbW1pdEN1cnJlbnRCcmFuY2ggfSBmcm9tIFwiLi93b3JrdHJlZS5qc1wiO1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUm9ndWUgRmlsZSBEZXRlY3Rpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBpbnRlcmZhY2UgUm9ndWVGaWxlV3JpdGUge1xuICBwYXRoOiBzdHJpbmc7XG4gIHVuaXRUeXBlOiBzdHJpbmc7XG4gIHVuaXRJZDogc3RyaW5nO1xufVxuXG4vKipcbiAqIERldGVjdCBzdW1tYXJ5IGZpbGVzIHdyaXR0ZW4gZGlyZWN0bHkgdG8gZGlzayB3aXRob3V0IHRoZSBMTE0gY2FsbGluZ1xuICogdGhlIGNvbXBsZXRpb24gdG9vbC4gQSBcInJvZ3VlXCIgZmlsZSBpcyBvbmUgdGhhdCBleGlzdHMgb24gZGlzayBidXQgaGFzXG4gKiBubyBjb3JyZXNwb25kaW5nIERCIHJvdyB3aXRoIHN0YXR1cyBcImNvbXBsZXRlXCIuXG4gKlxuICogVGhpcyBpcyBhIHNhZmV0eS1uZXQgZGlhZ25vc3RpYyAoRDAwMykuIFJ1bnRpbWUgZGV0ZWN0aW9uIG5ldmVyIGltcG9ydHNcbiAqIG1hcmtkb3duIGludG8gdGhlIERCOyBleHBsaWNpdCBtaWdyYXRpb24vaW1wb3J0L3JlY292ZXJ5IGNvbW1hbmRzIG93biB0aGF0LlxuICovXG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuZnVuY3Rpb24gaGFzTm9uRW1wdHlGaWVsZHMocm93OiBSZWNvcmQ8c3RyaW5nLCBhbnk+IHwgbnVsbCwgZmllbGRzOiBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICBpZiAoIXJvdykgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gZmllbGRzLnNvbWUoZiA9PiBTdHJpbmcocm93W2ZdIHx8IFwiXCIpLnRyaW0oKS5sZW5ndGggPiAwKTtcbn1cblxuY29uc3QgTUlMRVNUT05FX1BMQU5OSU5HX0ZJRUxEUyA9IFtcInRpdGxlXCIsIFwidmlzaW9uXCIsIFwicmVxdWlyZW1lbnRfY292ZXJhZ2VcIiwgXCJib3VuZGFyeV9tYXBfbWFya2Rvd25cIl07XG5jb25zdCBTTElDRV9QTEFOTklOR19GSUVMRFMgPSBbXCJ0aXRsZVwiLCBcImRlbW9cIiwgXCJyaXNrXCIsIFwiZGVwZW5kc1wiXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdFJvZ3VlRmlsZVdyaXRlcyhcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4pOiBSb2d1ZUZpbGVXcml0ZVtdIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybiBbXTtcblxuICBjb25zdCB7IG1pbGVzdG9uZTogbWlkLCBzbGljZTogc2lkLCB0YXNrOiB0aWQgfSA9IHBhcnNlVW5pdElkKHVuaXRJZCk7XG4gIGNvbnN0IHJvZ3VlczogUm9ndWVGaWxlV3JpdGVbXSA9IFtdO1xuXG4gIGlmICh1bml0VHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIikge1xuICAgIGlmICghbWlkIHx8ICFzaWQgfHwgIXRpZCkgcmV0dXJuIFtdO1xuXG4gICAgY29uc3Qgc3VtbWFyeVBhdGggPSByZXNvbHZlVGFza0ZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCB0aWQsIFwiU1VNTUFSWVwiKTtcbiAgICBpZiAoIXN1bW1hcnlQYXRoIHx8ICFleGlzdHNTeW5jKHN1bW1hcnlQYXRoKSkgcmV0dXJuIFtdO1xuXG4gICAgY29uc3QgZGJSb3cgPSBnZXRUYXNrKG1pZCwgc2lkLCB0aWQpO1xuICAgIGlmICghZGJSb3cgfHwgZGJSb3cuc3RhdHVzICE9PSBcImNvbXBsZXRlXCIpIHtcbiAgICAgIHJvZ3Vlcy5wdXNoKHsgcGF0aDogc3VtbWFyeVBhdGgsIHVuaXRUeXBlLCB1bml0SWQgfSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKHVuaXRUeXBlID09PSBcImNvbXBsZXRlLXNsaWNlXCIpIHtcbiAgICBpZiAoIW1pZCB8fCAhc2lkKSByZXR1cm4gW107XG5cbiAgICBjb25zdCBzdW1tYXJ5UGF0aCA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCBcIlNVTU1BUllcIik7XG4gICAgaWYgKCFzdW1tYXJ5UGF0aCB8fCAhZXhpc3RzU3luYyhzdW1tYXJ5UGF0aCkpIHJldHVybiBbXTtcblxuICAgIGNvbnN0IGRiUm93ID0gZ2V0U2xpY2UobWlkLCBzaWQpO1xuICAgIGlmICghZGJSb3cgfHwgZGJSb3cuc3RhdHVzICE9PSBcImNvbXBsZXRlXCIpIHtcbiAgICAgIHJvZ3Vlcy5wdXNoKHsgcGF0aDogc3VtbWFyeVBhdGgsIHVuaXRUeXBlLCB1bml0SWQgfSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKHVuaXRUeXBlID09PSBcInBsYW4tbWlsZXN0b25lXCIpIHtcbiAgICBpZiAoIW1pZCkgcmV0dXJuIFtdO1xuXG4gICAgY29uc3Qgcm9hZG1hcFBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIlJPQURNQVBcIik7XG4gICAgaWYgKCFyb2FkbWFwUGF0aCB8fCAhZXhpc3RzU3luYyhyb2FkbWFwUGF0aCkpIHJldHVybiBbXTtcblxuICAgIGNvbnN0IGRiUm93ID0gZ2V0TWlsZXN0b25lKG1pZCk7XG4gICAgY29uc3QgaGFzUGxhbm5pbmdTdGF0ZSA9IGhhc05vbkVtcHR5RmllbGRzKGRiUm93LCBNSUxFU1RPTkVfUExBTk5JTkdfRklFTERTKTtcblxuICAgIGlmICghaGFzUGxhbm5pbmdTdGF0ZSkge1xuICAgICAgcm9ndWVzLnB1c2goeyBwYXRoOiByb2FkbWFwUGF0aCwgdW5pdFR5cGUsIHVuaXRJZCB9KTtcbiAgICB9XG4gIH0gZWxzZSBpZiAodW5pdFR5cGUgPT09IFwicGxhbi1zbGljZVwiIHx8IHVuaXRUeXBlID09PSBcInJlZmluZS1zbGljZVwiIHx8IHVuaXRUeXBlID09PSBcInJlcGxhbi1zbGljZVwiKSB7XG4gICAgaWYgKCFtaWQgfHwgIXNpZCkgcmV0dXJuIFtdO1xuXG4gICAgY29uc3QgcGxhblBhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWQsIHNpZCwgXCJQTEFOXCIpO1xuICAgIGlmICghcGxhblBhdGggfHwgIWV4aXN0c1N5bmMocGxhblBhdGgpKSByZXR1cm4gW107XG5cbiAgICBjb25zdCBkYlJvdyA9IGdldFNsaWNlKG1pZCwgc2lkKTtcbiAgICBjb25zdCBoYXNQbGFubmluZ1N0YXRlID0gaGFzTm9uRW1wdHlGaWVsZHMoZGJSb3csIFNMSUNFX1BMQU5OSU5HX0ZJRUxEUyk7XG5cbiAgICBpZiAoIWhhc1BsYW5uaW5nU3RhdGUpIHtcbiAgICAgIHJvZ3Vlcy5wdXNoKHsgcGF0aDogcGxhblBhdGgsIHVuaXRUeXBlLCB1bml0SWQgfSk7XG4gICAgfVxuXG4gICAgLy8gQWxzbyBjaGVjayBmb3Igcm9ndWUgUkVQTEFOLm1kXG4gICAgY29uc3QgcmVwbGFuUGF0aCA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCBcIlJFUExBTlwiKTtcbiAgICBpZiAocmVwbGFuUGF0aCAmJiBleGlzdHNTeW5jKHJlcGxhblBhdGgpICYmICFoYXNQbGFubmluZ1N0YXRlKSB7XG4gICAgICByb2d1ZXMucHVzaCh7IHBhdGg6IHJlcGxhblBhdGgsIHVuaXRUeXBlLCB1bml0SWQgfSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKHVuaXRUeXBlID09PSBcInJlYXNzZXNzLXJvYWRtYXBcIikge1xuICAgIGlmICghbWlkIHx8ICFzaWQpIHJldHVybiBbXTtcblxuICAgIGNvbnN0IGFzc2Vzc1BhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWQsIHNpZCwgXCJBU1NFU1NNRU5UXCIpO1xuICAgIGlmICghYXNzZXNzUGF0aCB8fCAhZXhpc3RzU3luYyhhc3Nlc3NQYXRoKSkgcmV0dXJuIFtdO1xuXG4gICAgLy8gQXNzZXNzbWVudCBmaWxlIGV4aXN0cyBvbiBkaXNrIFx1MjAxNCBjaGVjayBpZiBEQiBrbm93cyBhYm91dCBpdCB2aWEgdGhlIGFydGlmYWN0cyB0YWJsZVxuICAgIGNvbnN0IGFkYXB0ZXIgPSBfZ2V0QWRhcHRlcigpO1xuICAgIGlmIChhZGFwdGVyKSB7XG4gICAgICBjb25zdCByb3cgPSBhZGFwdGVyLnByZXBhcmUoXG4gICAgICAgIGBTRUxFQ1QgMSBGUk9NIGFydGlmYWN0cyBXSEVSRSBwYXRoIExJS0UgOnBhdHRlcm4gQU5EIGFydGlmYWN0X3R5cGUgPSAnQVNTRVNTTUVOVCcgTElNSVQgMWAsXG4gICAgICApLmdldCh7IFwiOnBhdHRlcm5cIjogYCUke3NpZH0tQVNTRVNTTUVOVC5tZGAgfSk7XG4gICAgICBpZiAoIXJvdykge1xuICAgICAgICByb2d1ZXMucHVzaCh7IHBhdGg6IGFzc2Vzc1BhdGgsIHVuaXRUeXBlLCB1bml0SWQgfSk7XG4gICAgICB9XG4gICAgfVxuICB9IGVsc2UgaWYgKHVuaXRUeXBlID09PSBcInBsYW4tdGFza1wiKSB7XG4gICAgaWYgKCFtaWQgfHwgIXNpZCB8fCAhdGlkKSByZXR1cm4gW107XG5cbiAgICBjb25zdCB0YXNrUGxhblBhdGggPSByZXNvbHZlVGFza0ZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCB0aWQsIFwiUExBTlwiKTtcbiAgICBpZiAoIXRhc2tQbGFuUGF0aCB8fCAhZXhpc3RzU3luYyh0YXNrUGxhblBhdGgpKSByZXR1cm4gW107XG5cbiAgICBjb25zdCBkYlJvdyA9IGdldFRhc2sobWlkLCBzaWQsIHRpZCk7XG4gICAgaWYgKCFkYlJvdykge1xuICAgICAgcm9ndWVzLnB1c2goeyBwYXRoOiB0YXNrUGxhblBhdGgsIHVuaXRUeXBlLCB1bml0SWQgfSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJvZ3Vlcztcbn1cblxuLyoqXG4gKiBNYXhpbXVtIG51bWJlciBvZiB0aW1lcyB0byByZXRyeSBhIHVuaXQgd2hvc2UgZXhwZWN0ZWQgYXJ0aWZhY3QgaXMgbWlzc2luZ1xuICogYWZ0ZXIgZXhlY3V0aW9uLiBNYXRjaGVzIHRoZSBib3VuZGVkIHBhdHRlcm4gdXNlZCBieSBydW5Qb3N0VW5pdFZlcmlmaWNhdGlvblxuICogaW4gYXV0by12ZXJpZmljYXRpb24udHMuIEV4Y2VlZGluZyB0aGlzIGxpbWl0IHBhdXNlcyBhdXRvLW1vZGUgaW5zdGVhZCBvZlxuICogbG9vcGluZyBpbmRlZmluaXRlbHkgKCMyMDA3KS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9BUlRJRkFDVF9WRVJJRklDQVRJT05fUkVUUklFUyA9IDM7XG5cbmV4cG9ydCBjb25zdCBTVEVQX0NPTVBMRVRFX0ZBTExCQUNLX01FU1NBR0UgPVxuICBcIlN0ZXAgY29tcGxldGUuIFJ1biAvY2xlYXIsIHRoZW4gL2dzZCB0byBjb250aW51ZSAob3IgL2dzZCBhdXRvIHRvIHJ1biBjb250aW51b3VzbHkpLlwiO1xuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTdGVwQ29tcGxldGVNZXNzYWdlKG5leHRTdGF0ZTogaW1wb3J0KFwiLi90eXBlcy5qc1wiKS5HU0RTdGF0ZSk6IHN0cmluZyB7XG4gIGlmIChuZXh0U3RhdGUucGhhc2UgPT09IFwiY29tcGxldGVcIikge1xuICAgIHJldHVybiBcIlN0ZXAgY29tcGxldGUgXHUyMDE0IG1pbGVzdG9uZSBmaW5pc2hlZC4gUnVuIC9nc2Qgc3RhdHVzIHRvIHJldmlldywgb3Igc3RhcnQgdGhlIG5leHQgbWlsZXN0b25lLlwiO1xuICB9XG4gIGNvbnN0IG5leHQgPSBkZXNjcmliZU5leHRVbml0KG5leHRTdGF0ZSk7XG4gIHJldHVybiBgU3RlcCBjb21wbGV0ZS4gTmV4dDogJHtuZXh0LmxhYmVsfVxcbmBcbiAgICArIGBSdW4gL2NsZWFyLCB0aGVuIC9nc2QgdG8gY29udGludWUgKG9yIC9nc2QgYXV0byB0byBydW4gY29udGludW91c2x5KS5gO1xufVxuXG4vKipcbiAqIERlY2lkZSB3aGV0aGVyIHN0ZXAgbW9kZSBzaG91bGQgc3RvcCBhdCB0aGUgc3RlcCB3aXphcmQgYWZ0ZXIgYSB1bml0IGZpbmlzaGVzLlxuICpcbiAqIEBwYXJhbSBjdXJyZW50VW5pdFR5cGUgVGhlIGp1c3QtZmluaXNoZWQgdW5pdCB0eXBlLCBzdWNoIGFzIFwiZXhlY3V0ZS10YXNrXCIgb3JcbiAqICAgXCJjb21wbGV0ZS1taWxlc3RvbmVcIjsgbWF5IGJlIG51bGwvdW5kZWZpbmVkIHdoZW4gbm8gY3VycmVudCB1bml0IGlzIGtub3duLlxuICogQHBhcmFtIHBoYXNlQWZ0ZXJVbml0IFRoZSBmcmVzaGx5IGRlcml2ZWQgbmV4dCBwaGFzZSwgc3VjaCBhcyBcImV4ZWN1dGluZ1wiIG9yXG4gKiAgIFwiY29tcGxldGVcIjsgbWF5IGJlIG51bGwvdW5kZWZpbmVkIGlmIHN0YXRlIGRlcml2YXRpb24gZmFpbGVkLlxuICogQHJldHVybnMgdHJ1ZSB0byBzaG93IHRoZSBzdGVwIHdpemFyZDsgZmFsc2UgdG8ga2VlcCB0aGUgbG9vcCBydW5uaW5nIHNvXG4gKiAgIHRlcm1pbmFsIG1pbGVzdG9uZSBjb21wbGV0aW9uIGNhbiByZWFjaCB0aGUgbWVyZ2UvZmluYWxpemF0aW9uIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRSZXR1cm5TdGVwV2l6YXJkQWZ0ZXJVbml0KFxuICBjdXJyZW50VW5pdFR5cGU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQsXG4gIHBoYXNlQWZ0ZXJVbml0OiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiBjdXJyZW50VW5pdFR5cGUgIT09IFwiY29tcGxldGUtbWlsZXN0b25lXCIgJiYgcGhhc2VBZnRlclVuaXQgIT09IFwiY29tcGxldGVcIjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBQcmVWZXJpZmljYXRpb25PcHRzIHtcbiAgc2tpcFNldHRsZURlbGF5PzogYm9vbGVhbjtcbiAgc2tpcFdvcmt0cmVlU3luYz86IGJvb2xlYW47XG4gIGFnZW50RW5kTWVzc2FnZXM/OiB1bmtub3duW107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUG9zdFVuaXRDb250ZXh0IHtcbiAgczogQXV0b1Nlc3Npb247XG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dDtcbiAgcGk6IEV4dGVuc2lvbkFQSTtcbiAgYnVpbGRTbmFwc2hvdE9wdHM6ICh1bml0VHlwZTogc3RyaW5nLCB1bml0SWQ6IHN0cmluZykgPT4gQ2xvc2VvdXRPcHRpb25zICYgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGxvY2tCYXNlOiAoKSA9PiBzdHJpbmc7XG4gIHN0b3BBdXRvOiAoY3R4PzogRXh0ZW5zaW9uQ29udGV4dCwgcGk/OiBFeHRlbnNpb25BUEksIHJlYXNvbj86IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPjtcbiAgcGF1c2VBdXRvOiAoY3R4PzogRXh0ZW5zaW9uQ29udGV4dCwgcGk/OiBFeHRlbnNpb25BUEkpID0+IFByb21pc2U8dm9pZD47XG4gIHVwZGF0ZVByb2dyZXNzV2lkZ2V0OiAoY3R4OiBFeHRlbnNpb25Db250ZXh0LCB1bml0VHlwZTogc3RyaW5nLCB1bml0SWQ6IHN0cmluZywgc3RhdGU6IGltcG9ydChcIi4vdHlwZXMuanNcIikuR1NEU3RhdGUpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBjb25zdCBVU0VSX0RSSVZFTl9ERUVQX1VOSVRTID0gbmV3IFNldChbXG4gIFwiZGlzY3Vzcy1wcm9qZWN0XCIsXG4gIFwiZGlzY3Vzcy1yZXF1aXJlbWVudHNcIixcbiAgXCJkaXNjdXNzLW1pbGVzdG9uZVwiLFxuICBcInJlc2VhcmNoLWRlY2lzaW9uXCIsXG5dKTtcbmV4cG9ydCB7IGlzQXdhaXRpbmdVc2VySW5wdXQgfSBmcm9tIFwiLi91c2VyLWlucHV0LWJvdW5kYXJ5LmpzXCI7XG5cbmZ1bmN0aW9uIGFydGlmYWN0VmFsaWRhdGlvbktpbmQodW5pdFR5cGU6IHN0cmluZyk6IFwicHJvamVjdFwiIHwgXCJyZXF1aXJlbWVudHNcIiB8IG51bGwge1xuICBpZiAodW5pdFR5cGUgPT09IFwiZGlzY3Vzcy1wcm9qZWN0XCIpIHJldHVybiBcInByb2plY3RcIjtcbiAgaWYgKHVuaXRUeXBlID09PSBcImRpc2N1c3MtcmVxdWlyZW1lbnRzXCIpIHJldHVybiBcInJlcXVpcmVtZW50c1wiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gZGVzY3JpYmVBcnRpZmFjdFZlcmlmaWNhdGlvbkZhaWx1cmUodW5pdFR5cGU6IHN0cmluZywgdW5pdElkOiBzdHJpbmcsIGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB3b3JrdHJlZUZhaWx1cmUgPSBkaWFnbm9zZVdvcmt0cmVlSW50ZWdyaXR5RmFpbHVyZShiYXNlUGF0aCk7XG4gIGlmICh3b3JrdHJlZUZhaWx1cmUpIHtcbiAgICByZXR1cm4gYCR7d29ya3RyZWVGYWlsdXJlfSBVbml0OiAke3VuaXRUeXBlfSAke3VuaXRJZH0uYDtcbiAgfVxuXG4gIGNvbnN0IGFydGlmYWN0UGF0aCA9IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCh1bml0VHlwZSwgdW5pdElkLCBiYXNlUGF0aCk7XG4gIGlmICghYXJ0aWZhY3RQYXRoKSB7XG4gICAgcmV0dXJuIGBBcnRpZmFjdCB2ZXJpZmljYXRpb24gZmFpbGVkOiAke3VuaXRUeXBlfSBcIiR7dW5pdElkfVwiIGhhcyBubyByZXNvbHZhYmxlIGFydGlmYWN0IHBhdGguYDtcbiAgfVxuICBjb25zdCByZWxQYXRoID0gcmVsYXRpdmUoYmFzZVBhdGgsIGFydGlmYWN0UGF0aCk7XG4gIGlmICghZXhpc3RzU3luYyhhcnRpZmFjdFBhdGgpKSB7XG4gICAgcmV0dXJuIGBBcnRpZmFjdCB2ZXJpZmljYXRpb24gZmFpbGVkOiAke3JlbFBhdGh9IHdhcyBub3QgZm91bmQgb24gZGlzayBhZnRlciB1bml0IGV4ZWN1dGlvbi5gO1xuICB9XG5cbiAgY29uc3QgdmFsaWRhdGlvbktpbmQgPSBhcnRpZmFjdFZhbGlkYXRpb25LaW5kKHVuaXRUeXBlKTtcbiAgaWYgKHZhbGlkYXRpb25LaW5kKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gdmFsaWRhdGVBcnRpZmFjdChhcnRpZmFjdFBhdGgsIHZhbGlkYXRpb25LaW5kKTtcbiAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgY29uc3QgZXJyb3JzID0gcmVzdWx0LmVycm9yc1xuICAgICAgICAuc2xpY2UoMCwgTUFYX05PVElGSUNBVElPTl9ERVRBSUxTKVxuICAgICAgICAubWFwKChlcnJvcikgPT4gYCR7ZXJyb3IuY29kZX06ICR7ZXJyb3IubWVzc2FnZX1gKVxuICAgICAgICAuam9pbihcIjsgXCIpO1xuICAgICAgcmV0dXJuIGBBcnRpZmFjdCB2ZXJpZmljYXRpb24gZmFpbGVkOiAke3JlbFBhdGh9IGV4aXN0cyBidXQgaXMgaW52YWxpZCR7ZXJyb3JzID8gYCAoJHtlcnJvcnN9KWAgOiBcIlwifS5gO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGV4cGVjdGVkID0gZGlhZ25vc2VFeHBlY3RlZEFydGlmYWN0KHVuaXRUeXBlLCB1bml0SWQsIGJhc2VQYXRoKTtcbiAgcmV0dXJuIGBBcnRpZmFjdCB2ZXJpZmljYXRpb24gZmFpbGVkOiAke3JlbFBhdGh9IGV4aXN0cyBidXQgZGlkIG5vdCBzYXRpc2Z5IHRoZSAke3VuaXRUeXBlfSBjb21wbGV0aW9uIGNvbnRyYWN0JHtleHBlY3RlZCA/IGAgKCR7ZXhwZWN0ZWR9KWAgOiBcIlwifS5gO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYXV0b0NvbW1pdFVuaXQoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuICBjdHg/OiBFeHRlbnNpb25Db250ZXh0LFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgbGV0IHRhc2tDb250ZXh0OiBUYXNrQ29tbWl0Q29udGV4dCB8IHVuZGVmaW5lZDtcblxuICAgIGlmICh1bml0VHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIikge1xuICAgICAgdGFza0NvbnRleHQgPSBhd2FpdCBidWlsZFRhc2tDb21taXRDb250ZXh0Rm9yVW5pdChiYXNlUGF0aCwgdW5pdElkKTtcbiAgICB9XG5cbiAgICBfcmVzZXRIYXNDaGFuZ2VzQ2FjaGUoKTtcblxuICAgIGlmIChMSUZFQ1lDTEVfT05MWV9VTklUUy5oYXModW5pdFR5cGUpKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBjb25zdCBjb21taXRNc2cgPSBhdXRvQ29tbWl0Q3VycmVudEJyYW5jaChiYXNlUGF0aCwgdW5pdFR5cGUsIHVuaXRJZCwgdGFza0NvbnRleHQpO1xuICAgIGlmIChjb21taXRNc2cpIHtcbiAgICAgIGN0eD8udWkubm90aWZ5KGBDb21taXR0ZWQ6ICR7Y29tbWl0TXNnLnNwbGl0KFwiXFxuXCIpWzBdfWAsIFwiaW5mb1wiKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvbW1pdE1zZztcbiAgfSBjYXRjaCAoZSkge1xuICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwgeyBwaGFzZTogXCJhdXRvLWNvbW1pdFwiLCBlcnJvcjogU3RyaW5nKGUpIH0pO1xuICAgIGN0eD8udWkubm90aWZ5KGBBdXRvLWNvbW1pdCBmYWlsZWQ6ICR7U3RyaW5nKGUpLnNwbGl0KFwiXFxuXCIpWzBdfWAsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIEV4ZWN1dGUgdGhlIHR1cm4tbGV2ZWwgZ2l0IGFjdGlvbiAoY29tbWl0LCBzbmFwc2hvdCwgb3Igc3RhdHVzLW9ubHkpLlxuICpcbiAqIEBwYXJhbSBvcHRzLnNvZnRGYWlsdXJlIC0gRGVmYXVsdHMgdG8gZmFsc2UuIFdoZW4gdHJ1ZSwgcmV0cnkgZ2l0IGZhaWx1cmVzLFxuICogd2FybiwgYW5kIGNvbnRpbnVlIHdpdGhvdXQgcGF1c2luZyBhdXRvLW1vZGU7IHVzZSBmb3IgYmVzdC1lZmZvcnQgZGVmZXJyZWRcbiAqIGNsb3Nlb3V0IHdvcmsgd2hlcmUgYSBnaXQgZmFpbHVyZSBzaG91bGQgbm90IGJsb2NrIHRoZSBydW4uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJ1bkNsb3Nlb3V0R2l0QWN0aW9uKFxuICBwY3R4OiBQb3N0VW5pdENvbnRleHQsXG4gIHVuaXQ6IE5vbk51bGxhYmxlPEF1dG9TZXNzaW9uW1wiY3VycmVudFVuaXRcIl0+LFxuICBvcHRzPzogeyBzb2Z0RmFpbHVyZT86IGJvb2xlYW4gfSxcbik6IFByb21pc2U8XCJjb250aW51ZVwiIHwgXCJkaXNwYXRjaGVkXCI+IHtcbiAgY29uc3QgeyBzLCBjdHgsIHBpLCBwYXVzZUF1dG8gfSA9IHBjdHg7XG4gIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzO1xuICBjb25zdCB1b2tGbGFncyA9IHJlc29sdmVVb2tGbGFncyhwcmVmcyk7XG4gIGNvbnN0IHR1cm5BY3Rpb246IFR1cm5HaXRBY3Rpb25Nb2RlID0gdW9rRmxhZ3MuZ2l0b3BzID8gdW9rRmxhZ3MuZ2l0b3BzVHVybkFjdGlvbiA6IFwiY29tbWl0XCI7XG4gIGNvbnN0IHRyYWNlSWQgPSBzLmN1cnJlbnRUcmFjZUlkID8/IGB0dXJuOiR7dW5pdC5zdGFydGVkQXR9YDtcbiAgY29uc3QgdHVybklkID0gcy5jdXJyZW50VHVybklkID8/IGAke3VuaXQudHlwZX0vJHt1bml0LmlkfS8ke3VuaXQuc3RhcnRlZEF0fWA7XG5cbiAgcy5sYXN0R2l0QWN0aW9uRmFpbHVyZSA9IG51bGw7XG4gIHMubGFzdEdpdEFjdGlvblN0YXR1cyA9IG51bGw7XG5cbiAgdHJ5IHtcbiAgICBsZXQgdGFza0NvbnRleHQ6IFRhc2tDb21taXRDb250ZXh0IHwgdW5kZWZpbmVkO1xuXG4gICAgaWYgKHR1cm5BY3Rpb24gPT09IFwiY29tbWl0XCIgJiYgdW5pdC50eXBlID09PSBcImV4ZWN1dGUtdGFza1wiKSB7XG4gICAgICB0YXNrQ29udGV4dCA9IGF3YWl0IGJ1aWxkVGFza0NvbW1pdENvbnRleHRGb3JVbml0KHMuYmFzZVBhdGgsIHVuaXQuaWQpO1xuICAgIH1cblxuICAgIC8vIEludmFsaWRhdGUgdGhlIG5hdGl2ZUhhc0NoYW5nZXMgY2FjaGUgYmVmb3JlIGF1dG8tY29tbWl0ICgjMTg1MykuXG4gICAgLy8gVGhlIGNhY2hlIGhhcyBhIDEwLXNlY29uZCBUVEwgYW5kIGlzIGtleWVkIGJ5IGJhc2VQYXRoLiBBIHN0YWxlXG4gICAgLy8gYGZhbHNlYCByZXN1bHQgY2F1c2VzIGF1dG9Db21taXQgdG8gc2tpcCBzdGFnaW5nIGVudGlyZWx5LlxuICAgIF9yZXNldEhhc0NoYW5nZXNDYWNoZSgpO1xuXG4gICAgY29uc3Qgc2tpcExpZmVjeWNsZUNvbW1pdCA9XG4gICAgICB0dXJuQWN0aW9uID09PSBcImNvbW1pdFwiICYmIExJRkVDWUNMRV9PTkxZX1VOSVRTLmhhcyh1bml0LnR5cGUpO1xuXG4gICAgaWYgKHNraXBMaWZlY3ljbGVDb21taXQpIHtcbiAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwge1xuICAgICAgICBwaGFzZTogXCJnaXQtYWN0aW9uLXNraXBwZWRcIixcbiAgICAgICAgcmVhc29uOiBcImxpZmVjeWNsZS1vbmx5LXVuaXRcIixcbiAgICAgICAgdW5pdFR5cGU6IHVuaXQudHlwZSxcbiAgICAgICAgdW5pdElkOiB1bml0LmlkLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IG1heEF0dGVtcHRzID0gb3B0cz8uc29mdEZhaWx1cmUgPyAzIDogMTtcbiAgICAgIGxldCBnaXRSZXN1bHQgPSBydW5UdXJuR2l0QWN0aW9uKHtcbiAgICAgICAgYmFzZVBhdGg6IHMuYmFzZVBhdGgsXG4gICAgICAgIGFjdGlvbjogdHVybkFjdGlvbixcbiAgICAgICAgdW5pdFR5cGU6IHVuaXQudHlwZSxcbiAgICAgICAgdW5pdElkOiB1bml0LmlkLFxuICAgICAgICB0YXNrQ29udGV4dCxcbiAgICAgIH0pO1xuICAgICAgZm9yIChsZXQgYXR0ZW1wdCA9IDE7IGdpdFJlc3VsdC5zdGF0dXMgPT09IFwiZmFpbGVkXCIgJiYgYXR0ZW1wdCA8IG1heEF0dGVtcHRzOyBhdHRlbXB0KyspIHtcbiAgICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMjUwICogYXR0ZW1wdCkpO1xuICAgICAgICBnaXRSZXN1bHQgPSBydW5UdXJuR2l0QWN0aW9uKHtcbiAgICAgICAgICBiYXNlUGF0aDogcy5iYXNlUGF0aCxcbiAgICAgICAgICBhY3Rpb246IHR1cm5BY3Rpb24sXG4gICAgICAgICAgdW5pdFR5cGU6IHVuaXQudHlwZSxcbiAgICAgICAgICB1bml0SWQ6IHVuaXQuaWQsXG4gICAgICAgICAgdGFza0NvbnRleHQsXG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICBpZiAodW9rRmxhZ3MuZ2l0b3BzKSB7XG4gICAgICAgIHdyaXRlVHVybkdpdFRyYW5zYWN0aW9uKHtcbiAgICAgICAgICBiYXNlUGF0aDogcy5iYXNlUGF0aCxcbiAgICAgICAgICB0cmFjZUlkLFxuICAgICAgICAgIHR1cm5JZCxcbiAgICAgICAgICB1bml0VHlwZTogdW5pdC50eXBlLFxuICAgICAgICAgIHVuaXRJZDogdW5pdC5pZCxcbiAgICAgICAgICBzdGFnZTogXCJwdWJsaXNoXCIsXG4gICAgICAgICAgYWN0aW9uOiB0dXJuQWN0aW9uLFxuICAgICAgICAgIHB1c2g6IHVva0ZsYWdzLmdpdG9wc1R1cm5QdXNoLFxuICAgICAgICAgIHN0YXR1czogZ2l0UmVzdWx0LnN0YXR1cyxcbiAgICAgICAgICBlcnJvcjogZ2l0UmVzdWx0LmVycm9yLFxuICAgICAgICAgIG1ldGFkYXRhOiB7XG4gICAgICAgICAgICBkaXJ0eTogZ2l0UmVzdWx0LmRpcnR5LFxuICAgICAgICAgICAgY29tbWl0TWVzc2FnZTogZ2l0UmVzdWx0LmNvbW1pdE1lc3NhZ2UsXG4gICAgICAgICAgICBzbmFwc2hvdExhYmVsOiBnaXRSZXN1bHQuc25hcHNob3RMYWJlbCxcbiAgICAgICAgICB9LFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgaWYgKGdpdFJlc3VsdC5zdGF0dXMgPT09IFwiZmFpbGVkXCIpIHtcbiAgICAgICAgcy5sYXN0R2l0QWN0aW9uRmFpbHVyZSA9IGdpdFJlc3VsdC5lcnJvciA/PyBgZ2l0ICR7dHVybkFjdGlvbn0gZmFpbGVkYDtcbiAgICAgICAgcy5sYXN0R2l0QWN0aW9uU3RhdHVzID0gXCJmYWlsZWRcIjtcbiAgICAgICAgaWYgKHVva0ZsYWdzLmdpdG9wcyAmJiB1b2tGbGFncy5nYXRlcykge1xuICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVW5pdElkKHVuaXQuaWQpO1xuICAgICAgICAgIGNvbnN0IGdhdGVSdW5uZXIgPSBuZXcgVW9rR2F0ZVJ1bm5lcigpO1xuICAgICAgICAgIGdhdGVSdW5uZXIucmVnaXN0ZXIoe1xuICAgICAgICAgICAgaWQ6IFwiY2xvc2VvdXQtZ2l0LWFjdGlvblwiLFxuICAgICAgICAgICAgdHlwZTogXCJjbG9zZW91dFwiLFxuICAgICAgICAgICAgZXhlY3V0ZTogYXN5bmMgKCkgPT4gKHtcbiAgICAgICAgICAgICAgb3V0Y29tZTogXCJmYWlsXCIsXG4gICAgICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJnaXRcIixcbiAgICAgICAgICAgICAgcmF0aW9uYWxlOiBgdHVybiBnaXQgYWN0aW9uIFwiJHt0dXJuQWN0aW9ufVwiIGZhaWxlZGAsXG4gICAgICAgICAgICAgIGZpbmRpbmdzOiBnaXRSZXN1bHQuZXJyb3IgPz8gXCJ1bmtub3duIGdpdCBmYWlsdXJlXCIsXG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBhd2FpdCBnYXRlUnVubmVyLnJ1bihcImNsb3Nlb3V0LWdpdC1hY3Rpb25cIiwge1xuICAgICAgICAgICAgYmFzZVBhdGg6IHMuYmFzZVBhdGgsXG4gICAgICAgICAgICB0cmFjZUlkLFxuICAgICAgICAgICAgdHVybklkLFxuICAgICAgICAgICAgbWlsZXN0b25lSWQ6IHBhcnNlZC5taWxlc3RvbmUgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgc2xpY2VJZDogcGFyc2VkLnNsaWNlID8/IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHRhc2tJZDogcGFyc2VkLnRhc2sgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgdW5pdFR5cGU6IHVuaXQudHlwZSxcbiAgICAgICAgICAgIHVuaXRJZDogdW5pdC5pZCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGZhaWx1cmVNc2cgPSBgR2l0ICR7dHVybkFjdGlvbn0gZmFpbGVkOiAkeyhnaXRSZXN1bHQuZXJyb3IgPz8gXCJ1bmtub3duIGVycm9yXCIpLnNwbGl0KFwiXFxuXCIpWzBdfWA7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoZmFpbHVyZU1zZywgb3B0cz8uc29mdEZhaWx1cmUgPyBcIndhcm5pbmdcIiA6IFwiZXJyb3JcIik7XG4gICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwge1xuICAgICAgICAgIHBoYXNlOiBvcHRzPy5zb2Z0RmFpbHVyZSA/IFwiZ2l0LWFjdGlvbi1mYWlsZWQtc29mdFwiIDogXCJnaXQtYWN0aW9uLWZhaWxlZC1ibG9ja2luZ1wiLFxuICAgICAgICAgIGFjdGlvbjogdHVybkFjdGlvbixcbiAgICAgICAgICBlcnJvcjogZ2l0UmVzdWx0LmVycm9yID8/IFwidW5rbm93biBlcnJvclwiLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKG9wdHM/LnNvZnRGYWlsdXJlKSB7XG4gICAgICAgICAgcmV0dXJuIFwiY29udGludWVcIjtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgIHJldHVybiBcImRpc3BhdGNoZWRcIjtcbiAgICAgIH1cblxuICAgICAgcy5sYXN0R2l0QWN0aW9uU3RhdHVzID0gXCJva1wiO1xuXG4gICAgICBpZiAodHVybkFjdGlvbiA9PT0gXCJjb21taXRcIiAmJiBnaXRSZXN1bHQuY29tbWl0TWVzc2FnZSkge1xuICAgICAgICBjdHgudWkubm90aWZ5KGBDb21taXR0ZWQ6ICR7Z2l0UmVzdWx0LmNvbW1pdE1lc3NhZ2Uuc3BsaXQoXCJcXG5cIilbMF19YCwgXCJpbmZvXCIpO1xuICAgICAgfSBlbHNlIGlmICh0dXJuQWN0aW9uID09PSBcInNuYXBzaG90XCIgJiYgZ2l0UmVzdWx0LnNuYXBzaG90TGFiZWwpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShgU25hcHNob3QgcmVjb3JkZWQ6ICR7Z2l0UmVzdWx0LnNuYXBzaG90TGFiZWx9YCwgXCJpbmZvXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgcy5sYXN0R2l0QWN0aW9uRmFpbHVyZSA9IG1lc3NhZ2U7XG4gICAgcy5sYXN0R2l0QWN0aW9uU3RhdHVzID0gXCJmYWlsZWRcIjtcbiAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHsgcGhhc2U6IFwiZ2l0LWFjdGlvblwiLCBlcnJvcjogbWVzc2FnZSwgYWN0aW9uOiB0dXJuQWN0aW9uIH0pO1xuICAgIGN0eC51aS5ub3RpZnkoYEdpdCAke3R1cm5BY3Rpb259IGZhaWxlZDogJHttZXNzYWdlLnNwbGl0KFwiXFxuXCIpWzBdfWAsIG9wdHM/LnNvZnRGYWlsdXJlID8gXCJ3YXJuaW5nXCIgOiBcImVycm9yXCIpO1xuICAgIGlmIChvcHRzPy5zb2Z0RmFpbHVyZSkge1xuICAgICAgcmV0dXJuIFwiY29udGludWVcIjtcbiAgICB9XG4gICAgaWYgKHVva0ZsYWdzLmdpdG9wcykge1xuICAgICAgYXdhaXQgcGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgcmV0dXJuIFwiZGlzcGF0Y2hlZFwiO1xuICAgIH1cbiAgfVxuXG4gIC8vIEdpdEh1YiBzeW5jIChub24tYmxvY2tpbmcsIG9wdC1pbilcbiAgYXdhaXQgcnVuU2FmZWx5KFwicG9zdFVuaXRcIiwgXCJnaXRodWItc3luY1wiLCBhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgeyBydW5HaXRIdWJTeW5jIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9naXRodWItc3luYy9zeW5jLmpzXCIpO1xuICAgIGF3YWl0IHJ1bkdpdEh1YlN5bmMocy5iYXNlUGF0aCwgdW5pdC50eXBlLCB1bml0LmlkKTtcbiAgfSk7XG5cbiAgcmV0dXJuIFwiY29udGludWVcIjtcbn1cblxuLyoqXG4gKiBQcmUtdmVyaWZpY2F0aW9uIHByb2Nlc3Npbmc6IHBhcmFsbGVsIHdvcmtlciBzaWduYWwgY2hlY2ssIGNhY2hlIGludmFsaWRhdGlvbixcbiAqIGF1dG8tY29tbWl0LCBkb2N0b3IgcnVuLCBzdGF0ZSByZWJ1aWxkLCB3b3JrdHJlZSBzeW5jLCBhcnRpZmFjdCB2ZXJpZmljYXRpb24uXG4gKlxuICogUmV0dXJuczpcbiAqIC0gXCJkaXNwYXRjaGVkXCIgXHUyMDE0IGEgc2lnbmFsIGNhdXNlZCBzdG9wL3BhdXNlXG4gKiAtIFwiY29udGludWVcIiBcdTIwMTQgcHJvY2VlZCBub3JtYWxseVxuICogLSBcInJldHJ5XCIgXHUyMDE0IGFydGlmYWN0IHZlcmlmaWNhdGlvbiBmYWlsZWQsIHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5IHNldCBmb3IgbG9vcCByZS1pdGVyYXRpb25cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBvc3RVbml0UHJlVmVyaWZpY2F0aW9uKHBjdHg6IFBvc3RVbml0Q29udGV4dCwgb3B0cz86IFByZVZlcmlmaWNhdGlvbk9wdHMpOiBQcm9taXNlPFwiZGlzcGF0Y2hlZFwiIHwgXCJjb250aW51ZVwiIHwgXCJyZXRyeVwiPiB7XG4gIGNvbnN0IHsgcywgY3R4LCBwaSwgc3RvcEF1dG8sIHBhdXNlQXV0byB9ID0gcGN0eDtcblxuICAvLyBcdTI1MDBcdTI1MDAgUGFyYWxsZWwgd29ya2VyIHNpZ25hbCBjaGVjayBcdTI1MDBcdTI1MDBcbiAgY29uc3QgbWlsZXN0b25lTG9jayA9IHByb2Nlc3MuZW52LkdTRF9NSUxFU1RPTkVfTE9DSztcbiAgaWYgKG1pbGVzdG9uZUxvY2spIHtcbiAgICBjb25zdCBzaWduYWwgPSBjb25zdW1lU2lnbmFsKHMuYmFzZVBhdGgsIG1pbGVzdG9uZUxvY2spO1xuICAgIGlmIChzaWduYWwpIHtcbiAgICAgIGlmIChzaWduYWwuc2lnbmFsID09PSBcInN0b3BcIikge1xuICAgICAgICBhd2FpdCBzdG9wQXV0byhjdHgsIHBpKTtcbiAgICAgICAgcmV0dXJuIFwiZGlzcGF0Y2hlZFwiO1xuICAgICAgfVxuICAgICAgaWYgKHNpZ25hbC5zaWduYWwgPT09IFwicGF1c2VcIikge1xuICAgICAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgIHJldHVybiBcImRpc3BhdGNoZWRcIjtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBJbnZhbGlkYXRlIGFsbCBjYWNoZXNcbiAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuXG4gIC8vIFNtYWxsIGRlbGF5IHRvIGxldCBmaWxlcyBzZXR0bGUgKHNraXBwZWQgZm9yIHNpZGVjYXJzIHdoZXJlIGxhdGVuY3kgbWF0dGVycyBtb3JlKVxuICBpZiAoIW9wdHM/LnNraXBTZXR0bGVEZWxheSkge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCAxMDApKTtcbiAgfVxuXG4gIC8vIFR1cm4tbGV2ZWwgZ2l0IGFjdGlvbiAoY29tbWl0IHwgc25hcHNob3QgfCBzdGF0dXMtb25seSlcbiAgaWYgKHMuY3VycmVudFVuaXQpIHtcbiAgICBjb25zdCB1bml0ID0gcy5jdXJyZW50VW5pdDtcbiAgICBpZiAoc2hvdWxkRGVmZXJDbG9zZW91dEdpdEFjdGlvbih1bml0LnR5cGUpKSB7XG4gICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHtcbiAgICAgICAgcGhhc2U6IFwiZ2l0LWFjdGlvbi1kZWZlcnJlZC11bnRpbC12ZXJpZmljYXRpb25cIixcbiAgICAgICAgdW5pdFR5cGU6IHVuaXQudHlwZSxcbiAgICAgICAgdW5pdElkOiB1bml0LmlkLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGdpdEFjdGlvblJlc3VsdCA9IGF3YWl0IHJ1bkNsb3Nlb3V0R2l0QWN0aW9uKHBjdHgsIHVuaXQpO1xuICAgICAgaWYgKGdpdEFjdGlvblJlc3VsdCA9PT0gXCJkaXNwYXRjaGVkXCIpIHtcbiAgICAgICAgcmV0dXJuIFwiZGlzcGF0Y2hlZFwiO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFBydW5lIGRlYWQgYmctc2hlbGwgcHJvY2Vzc2VzXG4gICAgYXdhaXQgcnVuU2FmZWx5KFwicG9zdFVuaXRcIiwgXCJwcnVuZS1iZy1zaGVsbFwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IHBydW5lRGVhZFByb2Nlc3NlcyB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYmctc2hlbGwvcHJvY2Vzcy1tYW5hZ2VyLmpzXCIpO1xuICAgICAgcHJ1bmVEZWFkUHJvY2Vzc2VzKCk7XG4gICAgfSk7XG5cbiAgICAvLyBUZWFyIGRvd24gYnJvd3NlciBiZXR3ZWVuIHVuaXRzIHRvIHByZXZlbnQgQ2hyb21lIHByb2Nlc3MgYWNjdW11bGF0aW9uICgjMTczMylcbiAgICBhd2FpdCBydW5TYWZlbHkoXCJwb3N0VW5pdFwiLCBcImJyb3dzZXItdGVhcmRvd25cIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBnZXRCcm93c2VyIH0gPSBhd2FpdCBpbXBvcnQoXCIuLi9icm93c2VyLXRvb2xzL3N0YXRlLmpzXCIpO1xuICAgICAgaWYgKGdldEJyb3dzZXIoKSkge1xuICAgICAgICBjb25zdCB7IGNsb3NlQnJvd3NlciB9ID0gYXdhaXQgaW1wb3J0KFwiLi4vYnJvd3Nlci10b29scy9saWZlY3ljbGUuanNcIik7XG4gICAgICAgIGF3YWl0IGNsb3NlQnJvd3NlcigpO1xuICAgICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHsgcGhhc2U6IFwiYnJvd3Nlci10ZWFyZG93blwiLCBzdGF0dXM6IFwiY2xvc2VkXCIgfSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAvLyBLZWVwIHRoZSBvbi1kaXNrIFNUQVRFLm1kIGFsaWduZWQgd2l0aCB0aGUgbGl2ZSBkZXJpdmVkIHN0YXRlIGFmdGVyXG4gICAgLy8gb3JkaW5hcnkgdW5pdCBjb21wbGV0aW9uLCBiZWZvcmUgYW55IHdvcmt0cmVlIHN0YXRlIGlzIHN5bmNlZCBiYWNrLlxuICAgIGF3YWl0IHJ1blNhZmVseShcInBvc3RVbml0XCIsIFwic3RhdGUtcmVidWlsZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCByZWJ1aWxkU3RhdGUocy5iYXNlUGF0aCk7XG4gICAgfSk7XG5cbiAgICAvLyBTeW5jIHdvcmt0cmVlIHN0YXRlIGJhY2sgdG8gcHJvamVjdCByb290IChza2lwcGVkIGZvciBsaWdodHdlaWdodCBzaWRlY2FycylcbiAgICBpZiAoIW9wdHM/LnNraXBXb3JrdHJlZVN5bmMgJiYgcy5vcmlnaW5hbEJhc2VQYXRoICYmICFpc1NhbWVQYXRoTG9jYWwocy5vcmlnaW5hbEJhc2VQYXRoLCBzLmJhc2VQYXRoKSkge1xuICAgICAgYXdhaXQgcnVuU2FmZWx5KFwicG9zdFVuaXRcIiwgXCJ3b3JrdHJlZS1zeW5jXCIsICgpID0+IHtcbiAgICAgICAgbGV0IHNjb3BlID0gcy5zY29wZTtcbiAgICAgICAgaWYgKCFzY29wZSAmJiBzLmN1cnJlbnRNaWxlc3RvbmVJZCkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBzY29wZSA9IHNjb3BlTWlsZXN0b25lKGNyZWF0ZVdvcmtzcGFjZShzLmJhc2VQYXRoKSwgcy5jdXJyZW50TWlsZXN0b25lSWQpO1xuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLy8gTm9uLWZhdGFsOiBzY29wZSBjb25zdHJ1Y3Rpb24gY2FuIGZhaWwgb24gc3ludGhldGljIHRlc3QgcGF0aHM7XG4gICAgICAgICAgICAvLyBza2lwcGluZyB0aGUgcHJvamVjdGlvbiBtaXJyb3JzIHRoZSBwcmlvciBwYXRoLXN0cmluZyB2YXJpYW50J3NcbiAgICAgICAgICAgIC8vIGVhcmx5LXJldHVybiBiZWhhdmlvdXIgZm9yIG1pc3NpbmcgbWlsZXN0b25lL3BhdGggaW5wdXRzLlxuICAgICAgICAgICAgc2NvcGUgPSBudWxsO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoc2NvcGUpIF93b3JrdHJlZVByb2plY3Rpb24ucHJvamVjdFdvcmt0cmVlVG9Sb290KHNjb3BlKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIFJld3JpdGUtZG9jcyBjb21wbGV0aW9uXG4gICAgaWYgKHMuY3VycmVudFVuaXQudHlwZSA9PT0gXCJyZXdyaXRlLWRvY3NcIikge1xuICAgICAgYXdhaXQgcnVuU2FmZWx5KFwicG9zdFVuaXRcIiwgXCJyZXdyaXRlLWRvY3MtcmVzb2x2ZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIC8vIERldGVjdCBhYmFuZG9uL2Rlc2NvcGUgb3ZlcnJpZGVzIEJFRk9SRSByZXNvbHZpbmcgdGhlbSAoIzM0OTApLlxuICAgICAgICAvLyBJZiBhbiBvdmVycmlkZSBpcyBhYm91dCBhYmFuZG9uaW5nIHRoZSBtaWxlc3RvbmUsIHBhcmsgaXQgc28gdGhlXG4gICAgICAgIC8vIHN0YXRlIGVuZ2luZSBza2lwcyBpdC4gV2l0aG91dCB0aGlzLCByZXdyaXRlLWRvY3Mgb25seSBlZGl0c1xuICAgICAgICAvLyBtYXJrZG93biBidXQgdGhlIERCIHN0aWxsIGhhcyB0aGUgbWlsZXN0b25lIGFzIGFjdGl2ZS5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCB7IGxvYWRBY3RpdmVPdmVycmlkZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vZmlsZXMuanNcIik7XG4gICAgICAgICAgY29uc3Qgb3ZlcnJpZGVzID0gYXdhaXQgbG9hZEFjdGl2ZU92ZXJyaWRlcyhzLmJhc2VQYXRoKTtcbiAgICAgICAgICBjb25zdCBkZWNpc2lvbiA9IGRldGVjdEFiYW5kb25NaWxlc3RvbmUob3ZlcnJpZGVzLCBzLmN1cnJlbnRNaWxlc3RvbmVJZCk7XG4gICAgICAgICAgaWYgKGRlY2lzaW9uLnNob3VsZFBhcmsgJiYgcy5jdXJyZW50TWlsZXN0b25lSWQpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgcGFya01pbGVzdG9uZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9taWxlc3RvbmUtYWN0aW9ucy5qc1wiKTtcbiAgICAgICAgICAgIGNvbnN0IHBhcmtlZCA9IHBhcmtNaWxlc3RvbmUocy5iYXNlUGF0aCwgcy5jdXJyZW50TWlsZXN0b25lSWQsIGRlY2lzaW9uLnJlYXNvbik7XG4gICAgICAgICAgICBpZiAocGFya2VkKSB7XG4gICAgICAgICAgICAgIGN0eC51aS5ub3RpZnkoYE1pbGVzdG9uZSAke3MuY3VycmVudE1pbGVzdG9uZUlkfSBwYXJrZWQ6IFwiJHtkZWNpc2lvbi5yZWFzb259XCJgLCBcImluZm9cIik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBQYXJrIHJlZnVzZWQ6IG1pbGVzdG9uZSBkaXJlY3RvcnkgbWlzc2luZywgbWlsZXN0b25lIGFscmVhZHlcbiAgICAgICAgICAgICAgLy8gY29tcGxldGVkIChTVU1NQVJZIHByZXNlbnQpLCBvciBQQVJLRUQubWQgYWxyZWFkeSBleGlzdHMuXG4gICAgICAgICAgICAgIC8vIHJlc29sdmVBbGxPdmVycmlkZXMgYmVsb3cgd2lsbCBzdGlsbCBjb25zdW1lIHRoZSBvdmVycmlkZSBcdTIwMTRcbiAgICAgICAgICAgICAgLy8gc3VyZmFjZSB0aGlzIGxvdWRseSBzbyB0aGUgdXNlciBub3RpY2VzIHN0YXRlIGRyaWZ0IHJhdGhlclxuICAgICAgICAgICAgICAvLyB0aGFuIHNpbGVudGx5IGxvc2luZyB0aGUgYWJhbmRvbiBkaXJlY3RpdmUuXG4gICAgICAgICAgICAgIGNvbnN0IG1zZyA9IGBBYmFuZG9uIGRldGVjdGVkIGZvciAke3MuY3VycmVudE1pbGVzdG9uZUlkfSBidXQgcGFyayByZWZ1c2VkIChtaWxlc3RvbmUgaXMgY29tcGxldGVkLCBhbHJlYWR5IHBhcmtlZCwgb3IgbWlzc2luZykuIE92ZXJyaWRlIHdpbGwgYmUgcmVzb2x2ZWQgYW55d2F5IFx1MjAxNCB2ZXJpZnkgc3RhdGUgaXMgY29ycmVjdC5gO1xuICAgICAgICAgICAgICBsb2dFcnJvcihcImVuZ2luZVwiLCBtc2cpO1xuICAgICAgICAgICAgICBjdHgudWkubm90aWZ5KG1zZywgXCJ3YXJuaW5nXCIpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgbG9nRXJyb3IoXCJlbmdpbmVcIiwgYGFiYW5kb24tZGV0ZWN0IGZhaWxlZDogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoYEFiYW5kb24gZGV0ZWN0aW9uIGZhaWxlZCBcdTIwMTQgY2hlY2sgbG9ncy4gT3ZlcnJpZGVzIHdpbGwgc3RpbGwgYmUgcmVzb2x2ZWQuYCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgcmVzb2x2ZUFsbE92ZXJyaWRlcyhzLmJhc2VQYXRoKTtcbiAgICAgICAgLy8gUmVzZXQgYm90aCBkaXNrIGFuZCBpbi1tZW1vcnkgY291bnRlcnMuIERpc2sgY291bnRlciBpcyBhdXRob3JpdGF0aXZlXG4gICAgICAgIC8vIChzdXJ2aXZlcyByZXN0YXJ0cyk7IGluLW1lbW9yeSBpcyBrZXB0IGluIHN5bmMgZm9yIHRoZSBjdXJyZW50IHNlc3Npb24uXG4gICAgICAgIGNvbnN0IHsgc2V0UmV3cml0ZUNvdW50IH0gPSBhd2FpdCBpbXBvcnQoXCIuL2F1dG8tZGlzcGF0Y2guanNcIik7XG4gICAgICAgIHNldFJld3JpdGVDb3VudChzLmJhc2VQYXRoLCAwKTtcbiAgICAgICAgcy5yZXdyaXRlQXR0ZW1wdENvdW50ID0gMDtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcIk92ZXJyaWRlKHMpIHJlc29sdmVkIFx1MjAxNCByZXdyaXRlLWRvY3MgY29tcGxldGVkLlwiLCBcImluZm9cIik7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBSZWFjdGl2ZSBzdGF0ZSBjbGVhbnVwIG9uIHNsaWNlIGNvbXBsZXRpb25cbiAgICBpZiAocy5jdXJyZW50VW5pdC50eXBlID09PSBcImNvbXBsZXRlLXNsaWNlXCIpIHtcbiAgICAgIGF3YWl0IHJ1blNhZmVseShcInBvc3RVbml0XCIsIFwicmVhY3RpdmUtc3RhdGUtY2xlYW51cFwiLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQgfSA9IHBhcnNlVW5pdElkKHVuaXQuaWQpO1xuICAgICAgICBpZiAobWlkICYmIHNpZCkge1xuICAgICAgICAgIGNvbnN0IHsgY2xlYXJSZWFjdGl2ZVN0YXRlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3JlYWN0aXZlLWdyYXBoLmpzXCIpO1xuICAgICAgICAgIGNsZWFyUmVhY3RpdmVTdGF0ZShzLmJhc2VQYXRoLCBtaWQsIHNpZCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICAvLyAjNDc2NSBcdTIwMTQgc2xpY2UtY2FkZW5jZSBjb2xsYXBzZS4gV2hlbiBgZ2l0LmNvbGxhcHNlX2NhZGVuY2U6IFwic2xpY2VcImBcbiAgICAgIC8vIGlzIHNldCwgc3F1YXNoLW1lcmdlIHRoZSBzbGljZSdzIGNvbW1pdHMgZnJvbSB0aGUgbWlsZXN0b25lIGJyYW5jaFxuICAgICAgLy8gb250byBtYWluIHJpZ2h0IGhlcmUsIHNvIG9ycGhhbiByaXNrIHNocmlua3MgZnJvbSBtaWxlc3RvbmUtc2l6ZSB0b1xuICAgICAgLy8gc2xpY2Utc2l6ZS4gT25seSBydW5zIGluIHdvcmt0cmVlIGlzb2xhdGlvbiBtb2RlIFx1MjAxNCB0aGUgZmVhdHVyZSBuZWVkc1xuICAgICAgLy8gYSBtaWxlc3RvbmUgYnJhbmNoIHRvIHNxdWFzaCBmcm9tLlxuICAgICAgbGV0IHNsaWNlTWVyZ2VTdG9wcGVkID0gZmFsc2U7XG4gICAgICBhd2FpdCBydW5TYWZlbHkoXCJwb3N0VW5pdFwiLCBcInNsaWNlLWNhZGVuY2UtbWVyZ2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBwcmVmc1Jlc3VsdCA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhzLmJhc2VQYXRoKTtcbiAgICAgICAgY29uc3QgcHJlZnMgPSBwcmVmc1Jlc3VsdD8ucHJlZmVyZW5jZXM7XG4gICAgICAgIGNvbnN0IHsgZ2V0Q29sbGFwc2VDYWRlbmNlLCBtZXJnZVNsaWNlVG9NYWluIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3NsaWNlLWNhZGVuY2UuanNcIik7XG4gICAgICAgIGlmIChnZXRDb2xsYXBzZUNhZGVuY2UocHJlZnMpICE9PSBcInNsaWNlXCIpIHJldHVybjtcbiAgICAgICAgaWYgKGdldElzb2xhdGlvbk1vZGUocy5vcmlnaW5hbEJhc2VQYXRoIHx8IHMuYmFzZVBhdGgpICE9PSBcIndvcmt0cmVlXCIpIHJldHVybjtcbiAgICAgICAgaWYgKHMuaXNvbGF0aW9uRGVncmFkZWQpIHJldHVybjtcblxuICAgICAgICBjb25zdCBwcm9qZWN0Um9vdCA9IHMub3JpZ2luYWxCYXNlUGF0aCB8fCBzLmJhc2VQYXRoO1xuICAgICAgICBjb25zdCB7IG1pbGVzdG9uZTogbWlkLCBzbGljZTogc2lkIH0gPSBwYXJzZVVuaXRJZCh1bml0LmlkKTtcbiAgICAgICAgaWYgKCFtaWQgfHwgIXNpZCkgcmV0dXJuO1xuXG4gICAgICAgIC8vIFJlY29yZCB0aGUgbWlsZXN0b25lIHN0YXJ0IFNIQSBiZWZvcmUgdGhlIGZpcnN0IHNsaWNlIG1lcmdlLCBzb1xuICAgICAgICAvLyByZXNxdWFzaE1pbGVzdG9uZU9uTWFpbiBoYXMgYSB0YXJnZXQgYXQgbWlsZXN0b25lIGNvbXBsZXRpb24uXG4gICAgICAgIC8vIFJlc29sdmUgbWFpbiBicmFuY2ggZHluYW1pY2FsbHkgXHUyMDE0IGhhcmQtY29kaW5nIFwibWFpblwiIGJyZWFrcyByZXBvc1xuICAgICAgICAvLyB0aGF0IHVzZSBcIm1hc3RlclwiIG9yIGEgY3VzdG9tIGRlZmF1bHQgYnJhbmNoLlxuICAgICAgICBpZiAoIXMubWlsZXN0b25lU3RhcnRTaGFzLmhhcyhtaWQpKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHsgbmF0aXZlRGV0ZWN0TWFpbkJyYW5jaCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9uYXRpdmUtZ2l0LWJyaWRnZS5qc1wiKTtcbiAgICAgICAgICAgIGNvbnN0IG1haW5CcmFuY2ggPSBuYXRpdmVEZXRlY3RNYWluQnJhbmNoKHByb2plY3RSb290KTtcbiAgICAgICAgICAgIGNvbnN0IHsgZXhlY0ZpbGVTeW5jIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOmNoaWxkX3Byb2Nlc3NcIik7XG4gICAgICAgICAgICBjb25zdCBzaGEgPSBleGVjRmlsZVN5bmMoXCJnaXRcIiwgW1wicmV2LXBhcnNlXCIsIG1haW5CcmFuY2hdLCB7XG4gICAgICAgICAgICAgIGN3ZDogcHJvamVjdFJvb3QsIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwicGlwZVwiXSwgZW5jb2Rpbmc6IFwidXRmLThcIixcbiAgICAgICAgICAgIH0pLnRyaW0oKTtcbiAgICAgICAgICAgIGlmIChzaGEpIHMubWlsZXN0b25lU3RhcnRTaGFzLnNldChtaWQsIHNoYSk7XG4gICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGBzbGljZS1jYWRlbmNlOiBmYWlsZWQgdG8gcmVjb3JkIG1pbGVzdG9uZSBzdGFydCBTSEE6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gbWVyZ2VTbGljZVRvTWFpbihwcm9qZWN0Um9vdCwgbWlkLCBzaWQpO1xuICAgICAgICAgIGlmIChyZXN1bHQuc2tpcHBlZCkge1xuICAgICAgICAgICAgbG9nV2FybmluZyhcImVuZ2luZVwiLCBgc2xpY2UtY2FkZW5jZTogbWVyZ2Ugc2tpcHBlZCBmb3IgJHtzaWR9IFx1MjAxNCAke3Jlc3VsdC5za2lwcGVkUmVhc29ufWApO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYHNsaWNlLWNhZGVuY2U6ICR7c2lkfSBtZXJnZWQgdG8gbWFpbiAoJHtyZXN1bHQuZHVyYXRpb25Nc31tcykuYCxcbiAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIGNvbnN0IHsgTWVyZ2VDb25mbGljdEVycm9yIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2dpdC1zZXJ2aWNlLmpzXCIpO1xuICAgICAgICAgIGlmIChlcnIgaW5zdGFuY2VvZiBNZXJnZUNvbmZsaWN0RXJyb3IpIHtcbiAgICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICAgIGBzbGljZS1jYWRlbmNlIG1lcmdlIGNvbmZsaWN0IGluICR7c2lkfTogJHtlcnIuY29uZmxpY3RlZEZpbGVzLmpvaW4oXCIsIFwiKX0uIGAgK1xuICAgICAgICAgICAgICBgUmVzb2x2ZSBtYW51YWxseSBvbiBtYWluIGFuZCBydW4gXFxgL2dzZCBhdXRvXFxgIHRvIHJlc3VtZS5gLFxuICAgICAgICAgICAgICBcImVycm9yXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgLy8gU3RvcCBhdXRvIEFORCBzaWduYWwgdGhlIG91dGVyIHBvc3RVbml0IGZsb3cgdG8gZXhpdCBlYXJseS5cbiAgICAgICAgICAgIC8vIFdpdGhvdXQgdGhlIGZsYWcsIHN1YnNlcXVlbnQgaG9va3MgKHRyaWFnZSxcbiAgICAgICAgICAgIC8vIERCIHdyaXRlcykgd291bGQga2VlcCBydW5uaW5nIGFnYWluc3QgYSBjb25mbGljdGVkIG1haW5cbiAgICAgICAgICAgIC8vIGNoZWNrb3V0IGFmdGVyIHRoZSBsb29wIHdhcyBhbHJlYWR5IHRvbGQgdG8gc3RvcC5cbiAgICAgICAgICAgIGNvbnN0IHsgc3RvcEF1dG8gfSA9IGF3YWl0IGltcG9ydChcIi4vYXV0by5qc1wiKTtcbiAgICAgICAgICAgIGF3YWl0IHN0b3BBdXRvKGN0eCwgdW5kZWZpbmVkLCBgc2xpY2UtbWVyZ2UtY29uZmxpY3Qgb24gJHtzaWR9YCk7XG4gICAgICAgICAgICBzbGljZU1lcmdlU3RvcHBlZCA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIGxvZ0Vycm9yKFwiZW5naW5lXCIsIGBzbGljZS1jYWRlbmNlIG1lcmdlIGZhaWxlZCBmb3IgJHtzaWR9YCwge1xuICAgICAgICAgICAgZXJyb3I6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICAvLyBOb24tY29uZmxpY3QgZmFpbHVyZXMgKGRpcnR5IG1haW4sIHJldi13YWxrIGVycm9yLCBldGMuKSBjYW5cbiAgICAgICAgICAvLyBsZWF2ZSB0aGUgY2hlY2tvdXQgaW4gYW4gdW5leHBlY3RlZCBzdGF0ZS4gU3RvcCBhdXRvLW1vZGUgc29cbiAgICAgICAgICAvLyB0aGUgbmV4dCBzbGljZSBkb2Vzbid0IGRpc3BhdGNoIG9uIHRvcCBvZiBpdC5cbiAgICAgICAgICBjb25zdCB7IHN0b3BBdXRvIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2F1dG8uanNcIik7XG4gICAgICAgICAgYXdhaXQgc3RvcEF1dG8oY3R4LCB1bmRlZmluZWQsIGBzbGljZS1tZXJnZS1lcnJvciBvbiAke3NpZH1gKTtcbiAgICAgICAgICBzbGljZU1lcmdlU3RvcHBlZCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgLy8gRXhpdCBlYXJseSBhZnRlciBzdG9wQXV0byBzbyB0aGUgcmVzdCBvZiBwb3N0LXVuaXQgcHJvY2Vzc2luZ1xuICAgICAgLy8gKHRyaWFnZSwgaG9vayBkaXNwYXRjaCwgREIgd3JpdGVzKSBkb2Vzbid0IHJ1blxuICAgICAgLy8gYWdhaW5zdCBhIGNvbmZsaWN0ZWQgbWFpbiBjaGVja291dC4gUmV0dXJuIFwiZGlzcGF0Y2hlZFwiIHRvIG1hdGNoXG4gICAgICAvLyB0aGUgY29udmVudGlvbiB1c2VkIGJ5IG90aGVyIHN0b3AvcGF1c2VBdXRvIHBhdGhzIGluIHRoaXMgZnVuY3Rpb25cbiAgICAgIC8vIChzZWUgc2lnbmFsIGhhbmRsaW5nIGVhcmxpZXI6IHN0b3AvcGF1c2UgYWxzbyByZXR1cm4gXCJkaXNwYXRjaGVkXCIpLlxuICAgICAgaWYgKHNsaWNlTWVyZ2VTdG9wcGVkKSByZXR1cm4gXCJkaXNwYXRjaGVkXCI7XG4gICAgfVxuXG4gICAgLy8gUG9zdC10cmlhZ2U6IGV4ZWN1dGUgYWN0aW9uYWJsZSByZXNvbHV0aW9uc1xuICAgIGlmIChzLmN1cnJlbnRVbml0LnR5cGUgPT09IFwidHJpYWdlLWNhcHR1cmVzXCIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgZXhlY3V0ZVRyaWFnZVJlc29sdXRpb25zIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3RyaWFnZS1yZXNvbHV0aW9uLmpzXCIpO1xuICAgICAgICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKHMuY2Fub25pY2FsUHJvamVjdFJvb3QpO1xuICAgICAgICBjb25zdCBtaWQgPSBzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkID8/IFwiXCI7XG4gICAgICAgIGNvbnN0IHNpZCA9IHN0YXRlLmFjdGl2ZVNsaWNlPy5pZCA/PyBcIlwiO1xuXG4gICAgICAgIC8vIGV4ZWN1dGVUcmlhZ2VSZXNvbHV0aW9ucyBoYW5kbGVzIGRlZmVyIG1pbGVzdG9uZSBjcmVhdGlvbiBldmVuXG4gICAgICAgIC8vIHdpdGhvdXQgYW4gYWN0aXZlIG1pbGVzdG9uZS9zbGljZSAodGhlIFwiYWxsIG1pbGVzdG9uZXMgY29tcGxldGVcIlxuICAgICAgICAvLyBzY2VuYXJpbyBmcm9tICMxNTYyKS4gaW5qZWN0L3JlcGxhbi9xdWljay10YXNrIHN0aWxsIHJlcXVpcmUgbWlkK3NpZC5cbiAgICAgICAgLy8gUGhhc2UgQzogd3JpdGUgdG8gY2Fub25pY2FsIHByb2plY3Qgcm9vdC4gY29weVBsYW5uaW5nQXJ0aWZhY3RzXG4gICAgICAgIC8vIGhhcyBiZWVuIGRlbGV0ZWQsIHNvIHRyaWFnZSB3cml0ZXMgbGFuZCB3aGVyZSByZWFkZXJzIGNvbnN1bHQuXG4gICAgICAgIGNvbnN0IHRyaWFnZVJlc3VsdCA9IGV4ZWN1dGVUcmlhZ2VSZXNvbHV0aW9ucyhzLmNhbm9uaWNhbFByb2plY3RSb290LCBtaWQsIHNpZCk7XG5cbiAgICAgICAgaWYgKHRyaWFnZVJlc3VsdC5pbmplY3RlZCA+IDApIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYFRyaWFnZTogaW5qZWN0ZWQgJHt0cmlhZ2VSZXN1bHQuaW5qZWN0ZWR9IHRhc2ske3RyaWFnZVJlc3VsdC5pbmplY3RlZCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gaW50byAke3NpZH0gcGxhbi5gLFxuICAgICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodHJpYWdlUmVzdWx0LnJlcGxhbm5lZCA+IDApIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYFRyaWFnZTogcmVwbGFuIHRyaWdnZXIgd3JpdHRlbiBmb3IgJHtzaWR9IFx1MjAxNCBuZXh0IGRpc3BhdGNoIHdpbGwgZW50ZXIgcmVwbGFubmluZy5gLFxuICAgICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodHJpYWdlUmVzdWx0LmRlZmVycmVkTWlsZXN0b25lcyA+IDApIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYFRyaWFnZTogY3JlYXRlZCAke3RyaWFnZVJlc3VsdC5kZWZlcnJlZE1pbGVzdG9uZXN9IGRlZmVycmVkIG1pbGVzdG9uZSBkaXJlY3RvciR7dHJpYWdlUmVzdWx0LmRlZmVycmVkTWlsZXN0b25lcyA9PT0gMSA/IFwieVwiIDogXCJpZXNcIn0uYCxcbiAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHRyaWFnZVJlc3VsdC5xdWlja1Rhc2tzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IHF0IG9mIHRyaWFnZVJlc3VsdC5xdWlja1Rhc2tzKSB7XG4gICAgICAgICAgICBzLnBlbmRpbmdRdWlja1Rhc2tzLnB1c2gocXQpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYFRyaWFnZTogJHt0cmlhZ2VSZXN1bHQucXVpY2tUYXNrcy5sZW5ndGh9IHF1aWNrLXRhc2ske3RyaWFnZVJlc3VsdC5xdWlja1Rhc2tzLmxlbmd0aCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gcXVldWVkIGZvciBleGVjdXRpb24uYCxcbiAgICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBhY3Rpb24gb2YgdHJpYWdlUmVzdWx0LmFjdGlvbnMpIHtcbiAgICAgICAgICBsb2dXYXJuaW5nKFwiZW5naW5lXCIsIGB0cmlhZ2UgcmVzb2x1dGlvbjogJHthY3Rpb259YCk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBsb2dFcnJvcihcImVuZ2luZVwiLCBcInRyaWFnZSByZXNvbHV0aW9uIGZhaWxlZFwiLCB7IGVycm9yOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFx1MjUwMFx1MjUwMCBTYWZldHkgaGFybmVzczogcG9zdC11bml0IHZhbGlkYXRpb24gXHUyNTAwXHUyNTAwXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3ByZWZlcmVuY2VzLmpzXCIpO1xuICAgICAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM7XG4gICAgICBjb25zdCBzYWZldHlDb25maWcgPSByZXNvbHZlU2FmZXR5SGFybmVzc0NvbmZpZyhcbiAgICAgICAgcHJlZnM/LnNhZmV0eV9oYXJuZXNzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkLFxuICAgICAgKTtcblxuICAgICAgaWYgKHNhZmV0eUNvbmZpZy5lbmFibGVkKSB7XG4gICAgICAgIGNvbnN0IHsgbWlsZXN0b25lOiBzTWlkLCBzbGljZTogc1NpZCwgdGFzazogc1RpZCB9ID0gcGFyc2VVbml0SWQocy5jdXJyZW50VW5pdC5pZCk7XG5cbiAgICAgICAgLy8gRmlsZSBjaGFuZ2UgdmFsaWRhdGlvbiAoZXhlY3V0ZS10YXNrIG9ubHksIGFmdGVyIHVuaXQgZXhlY3V0aW9uKVxuICAgICAgICBpZiAoc2FmZXR5Q29uZmlnLmZpbGVfY2hhbmdlX3ZhbGlkYXRpb24gJiYgcy5jdXJyZW50VW5pdC50eXBlID09PSBcImV4ZWN1dGUtdGFza1wiICYmIHNNaWQgJiYgc1NpZCAmJiBzVGlkICYmIGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCB0YXNrUm93ID0gZ2V0VGFzayhzTWlkLCBzU2lkLCBzVGlkKTtcbiAgICAgICAgICAgIGlmICh0YXNrUm93KSB7XG4gICAgICAgICAgICAgIGNvbnN0IGV4cGVjdGVkT3V0cHV0ID0gdGFza1Jvdy5leHBlY3RlZF9vdXRwdXQgPz8gW107XG4gICAgICAgICAgICAgIGNvbnN0IHBsYW5uZWRGaWxlcyA9IHRhc2tSb3cuZmlsZXMgPz8gW107XG4gICAgICAgICAgICAgIGNvbnN0IGF1ZGl0ID0gdmFsaWRhdGVGaWxlQ2hhbmdlcyhzLmJhc2VQYXRoLCBleHBlY3RlZE91dHB1dCwgcGxhbm5lZEZpbGVzLCBzYWZldHlDb25maWcuZmlsZV9jaGFuZ2VfYWxsb3dsaXN0KTtcbiAgICAgICAgICAgICAgaWYgKGF1ZGl0ICYmIGF1ZGl0LnZpb2xhdGlvbnMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHdhcm5pbmdzID0gYXVkaXQudmlvbGF0aW9ucy5maWx0ZXIodiA9PiB2LnNldmVyaXR5ID09PSBcIndhcm5pbmdcIik7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCB2IG9mIHdhcm5pbmdzKSB7XG4gICAgICAgICAgICAgICAgICBsb2dXYXJuaW5nKFwic2FmZXR5XCIsIGBmaWxlLWNoYW5nZTogJHt2LmZpbGV9IFx1MjAxNCAke3YucmVhc29ufWApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAod2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgICAgICAgYFNhZmV0eTogJHt3YXJuaW5ncy5sZW5ndGh9IHVuZXhwZWN0ZWQgZmlsZSBjaGFuZ2Uocykgb3V0c2lkZSB0YXNrIHBsYW5gLFxuICAgICAgICAgICAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcInNhZmV0eS1maWxlLWNoYW5nZVwiLCBlcnJvcjogU3RyaW5nKGUpIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEV2aWRlbmNlIGNyb3NzLXJlZmVyZW5jZSAoZXhlY3V0ZS10YXNrIG9ubHkpXG4gICAgICAgIC8vIE9ubHkgY29tcGFyZSBhZ2FpbnN0IGNvbmNyZXRlIGNvbW1hbmQgZXZpZGVuY2UgcGVyc2lzdGVkIGJ5IHRoZSB0YXNrXG4gICAgICAgIC8vIGNvbXBsZXRpb24gdG9vbC4gQSBwcm9zZSBWZXJpZnkgZmllbGQgY2FuIGJlIHNhdGlzZmllZCBsYXRlciBieSB0aGVcbiAgICAgICAgLy8gaG9zdCB2ZXJpZmljYXRpb24gZ2F0ZSwgc28gaXQgaXMgbm90IGVub3VnaCB0byBhY2N1c2UgdGhlIHVuaXQuXG4gICAgICAgIGlmIChzYWZldHlDb25maWcuZXZpZGVuY2VfY3Jvc3NfcmVmZXJlbmNlICYmIHMuY3VycmVudFVuaXQudHlwZSA9PT0gXCJleGVjdXRlLXRhc2tcIikge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBhY3R1YWwgPSBnZXRFdmlkZW5jZSgpO1xuICAgICAgICAgICAgY29uc3QgYmFzaENhbGxzID0gYWN0dWFsLmZpbHRlcihlID0+IGUua2luZCA9PT0gXCJiYXNoXCIpO1xuICAgICAgICAgICAgaWYgKHNNaWQgJiYgc1NpZCAmJiBzVGlkICYmIGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICAgICAgICBjb25zdCB0YXNrUm93ID0gZ2V0VGFzayhzTWlkLCBzU2lkLCBzVGlkKTtcbiAgICAgICAgICAgICAgaWYgKHRhc2tSb3c/LnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiKSB7XG4gICAgICAgICAgICAgICAgY29uc3QgY2xhaW1lZEV2aWRlbmNlOiBDbGFpbWVkRXZpZGVuY2VbXSA9IGdldFZlcmlmaWNhdGlvbkV2aWRlbmNlKHNNaWQsIHNTaWQsIHNUaWQpXG4gICAgICAgICAgICAgICAgICAubWFwKChyb3cpID0+ICh7XG4gICAgICAgICAgICAgICAgICAgIGNvbW1hbmQ6IHJvdy5jb21tYW5kLFxuICAgICAgICAgICAgICAgICAgICBleGl0Q29kZTogcm93LmV4aXRfY29kZSxcbiAgICAgICAgICAgICAgICAgICAgdmVyZGljdDogcm93LnZlcmRpY3QsXG4gICAgICAgICAgICAgICAgICB9KSlcbiAgICAgICAgICAgICAgICAgIC5maWx0ZXIoKHJvdykgPT4gdHlwZW9mIHJvdy5jb21tYW5kID09PSBcInN0cmluZ1wiICYmIHJvdy5jb21tYW5kLnRyaW0oKS5sZW5ndGggPiAwKTtcbiAgICAgICAgICAgICAgICBjb25zdCBtaXNtYXRjaGVzID0gY3Jvc3NSZWZlcmVuY2VFdmlkZW5jZShjbGFpbWVkRXZpZGVuY2UsIGFjdHVhbCk7XG5cbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IG1pc21hdGNoIG9mIG1pc21hdGNoZXMpIHtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxvZ01lc3NhZ2UgPSBgZXZpZGVuY2UteHJlZjogJHttaXNtYXRjaC5yZWFzb259YDtcbiAgICAgICAgICAgICAgICAgIGlmIChtaXNtYXRjaC5zZXZlcml0eSA9PT0gXCJlcnJvclwiKSB7XG4gICAgICAgICAgICAgICAgICAgIGxvZ0Vycm9yKFwic2FmZXR5XCIsIGxvZ01lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbG9nV2FybmluZyhcInNhZmV0eVwiLCBsb2dNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoY2xhaW1lZEV2aWRlbmNlLmxlbmd0aCA+IDAgJiYgYmFzaENhbGxzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgICAgbG9nV2FybmluZyhcInNhZmV0eVwiLCBcInRhc2sgY2xhaW1lZCB2ZXJpZmljYXRpb24gY29tbWFuZCBldmlkZW5jZSBidXQgbm8gZXhlY3V0aW9uIHRvb2wgY2FsbHMgd2VyZSByZWNvcmRlZFwiKTtcbiAgICAgICAgICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICAgICAgICAgIGBTYWZldHk6IHRhc2sgJHtzVGlkfSBjbGFpbWVkIGNvbW1hbmQgZXZpZGVuY2UgYnV0IG5vIGV4ZWN1dGlvbiB0b29sIGNhbGxzIHdlcmUgcmVjb3JkZWRgLFxuICAgICAgICAgICAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3QgYmxvY2tpbmdNaXNtYXRjaCA9IG1pc21hdGNoZXMuZmluZCgobWlzbWF0Y2gpID0+IG1pc21hdGNoLnNldmVyaXR5ID09PSBcImVycm9yXCIpO1xuICAgICAgICAgICAgICAgIGlmIChibG9ja2luZ01pc21hdGNoKSB7XG4gICAgICAgICAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgICAgICAgICBgU2FmZXR5OiB0YXNrICR7c1RpZH0gY2xhaW1lZCBwYXNzaW5nIHZlcmlmaWNhdGlvbiB0aGF0IGZhaWxlZCBpbiByZWNvcmRlZCBleGVjdXRpb25gLFxuICAgICAgICAgICAgICAgICAgICBcImVycm9yXCIsXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgYXdhaXQgcGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFwiZGlzcGF0Y2hlZFwiO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwgeyBwaGFzZTogXCJzYWZldHktZXZpZGVuY2UteHJlZlwiLCBlcnJvcjogU3RyaW5nKGUpIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENvbnRlbnQgdmFsaWRhdGlvbiAocGxhbi1zbGljZSwgcGxhbi1taWxlc3RvbmUpXG4gICAgICAgIGlmIChzYWZldHlDb25maWcuY29udGVudF92YWxpZGF0aW9uKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGFydGlmYWN0UGF0aCA9IHJlc29sdmVBcnRpZmFjdEZvckNvbnRlbnQocy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkLCBzLmJhc2VQYXRoKTtcbiAgICAgICAgICAgIGNvbnN0IGNvbnRlbnRWaW9sYXRpb25zID0gdmFsaWRhdGVDb250ZW50KHMuY3VycmVudFVuaXQudHlwZSwgYXJ0aWZhY3RQYXRoKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdiBvZiBjb250ZW50VmlvbGF0aW9ucykge1xuICAgICAgICAgICAgICBsb2dXYXJuaW5nKFwic2FmZXR5XCIsIGBjb250ZW50OiAke3YucmVhc29ufWApO1xuICAgICAgICAgICAgICBjdHgudWkubm90aWZ5KGBDb250ZW50IHZhbGlkYXRpb246ICR7di5yZWFzb259YCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwgeyBwaGFzZTogXCJzYWZldHktY29udGVudC12YWxpZGF0aW9uXCIsIGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ2xlYXIgcGVyc2lzdGVkIGV2aWRlbmNlIGZpbGUgbm93IHRoYXQgcG9zdC11bml0IHByb2Nlc3NpbmcgaXMgY29tcGxldGVcbiAgICAgICAgLy8gKEJ1ZyAjNDM4NSBcdTIwMTQgcHJldmVudHMgc3RhbGUgZXZpZGVuY2UgZnJvbSBhZmZlY3RpbmcgcmV0cmllcyBvZiBzYW1lIHVuaXQgSUQpLlxuICAgICAgICBpZiAoc2FmZXR5Q29uZmlnLmV2aWRlbmNlX2NvbGxlY3Rpb24gJiYgcy5jdXJyZW50VW5pdC50eXBlID09PSBcImV4ZWN1dGUtdGFza1wiICYmIHNNaWQgJiYgc1NpZCAmJiBzVGlkKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNsZWFyRXZpZGVuY2VGcm9tRGlzayhzLmJhc2VQYXRoLCBzTWlkLCBzU2lkLCBzVGlkKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHsgcGhhc2U6IFwic2FmZXR5LWV2aWRlbmNlLWNsZWFyXCIsIGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcInNhZmV0eS1oYXJuZXNzXCIsIGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuXG4gICAgLy8gQXJ0aWZhY3QgdmVyaWZpY2F0aW9uXG4gICAgbGV0IHRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkID0gZmFsc2U7XG4gICAgaWYgKCFzLmN1cnJlbnRVbml0LnR5cGUuc3RhcnRzV2l0aChcImhvb2svXCIpKSB7XG4gICAgICB0cnkge1xuICAgICAgICB0cmlnZ2VyQXJ0aWZhY3RWZXJpZmllZCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3Qocy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkLCBzLmJhc2VQYXRoKTtcbiAgICAgICAgaWYgKHRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkKSB7XG4gICAgICAgICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwgeyBwaGFzZTogXCJhcnRpZmFjdC12ZXJpZnlcIiwgZXJyb3I6IFN0cmluZyhlKSB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gSWYgdmVyaWZpY2F0aW9uIGZhaWxlZCwgYXR0ZW1wdCB0byByZWdlbmVyYXRlIG1pc3NpbmcgcHJvamVjdGlvbiBmaWxlc1xuICAgICAgLy8gZnJvbSBEQiBkYXRhIGJlZm9yZSBnaXZpbmcgdXAgKGUuZy4gcmVzZWFyY2gtc2xpY2UgcHJvZHVjZXMgUExBTiBmcm9tIGVuZ2luZSkuXG4gICAgICBpZiAoIXRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkKSB7XG4gICAgICAgIGlmIChzLmN1cnJlbnRVbml0LnR5cGUgPT09IFwiY29tcGxldGUtbWlsZXN0b25lXCIpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgeyBtaWxlc3RvbmU6IG1pZCB9ID0gcGFyc2VVbml0SWQocy5jdXJyZW50VW5pdC5pZCk7XG4gICAgICAgICAgICBpZiAobWlkKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCB3YWl0Rm9yTWlsZXN0b25lRGJDbG9zZShtaWQpO1xuICAgICAgICAgICAgICBpZiAoc2V0dGxlZCkge1xuICAgICAgICAgICAgICAgIHRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkID0gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdChzLmN1cnJlbnRVbml0LnR5cGUsIHMuY3VycmVudFVuaXQuaWQsIHMuYmFzZVBhdGgpO1xuICAgICAgICAgICAgICAgIGlmICh0cmlnZ2VyQXJ0aWZhY3RWZXJpZmllZCkge1xuICAgICAgICAgICAgICAgICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwgeyBwaGFzZTogXCJhcnRpZmFjdC12ZXJpZnktc2V0dGxlLWRiXCIsIGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmICghdHJpZ2dlckFydGlmYWN0VmVyaWZpZWQpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCB7IG1pbGVzdG9uZTogbWlkLCBzbGljZTogc2lkIH0gPSBwYXJzZVVuaXRJZChzLmN1cnJlbnRVbml0LmlkKTtcbiAgICAgICAgICBpZiAobWlkICYmIHNpZCkge1xuICAgICAgICAgICAgLy8gUGhhc2UgQzogd3JpdGUgdG8gdGhlIGNhbm9uaWNhbCBwcm9qZWN0IHJvb3QgKCM1MjM2IHNjb3BlKVxuICAgICAgICAgICAgLy8gc28gbm9uLXN5bWxpbmtlZCB3b3JrdHJlZXMgbm8gbG9uZ2VyIG1haW50YWluIGEgc2VwYXJhdGVcbiAgICAgICAgICAgIC8vIGxvY2FsIC5nc2QvIHByb2plY3Rpb24uIGNvcHlQbGFubmluZ0FydGlmYWN0cyBoYXMgYmVlblxuICAgICAgICAgICAgLy8gZGVsZXRlZDsgcmVhZHMgKyB3cml0ZXMgY29udmVyZ2UgYXQgcHJvamVjdFJvb3QuXG4gICAgICAgICAgICBjb25zdCByZWdlbmVyYXRlZCA9IGF3YWl0IHJlZ2VuZXJhdGVJZk1pc3Npbmcocy5jYW5vbmljYWxQcm9qZWN0Um9vdCwgbWlkLCBzaWQsIFwiUExBTlwiKTtcbiAgICAgICAgICAgIGlmIChyZWdlbmVyYXRlZCkge1xuICAgICAgICAgICAgICAvLyBSZS1jaGVjayBhZnRlciByZWdlbmVyYXRpb25cbiAgICAgICAgICAgICAgdHJpZ2dlckFydGlmYWN0VmVyaWZpZWQgPSB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KHMuY3VycmVudFVuaXQudHlwZSwgcy5jdXJyZW50VW5pdC5pZCwgcy5jYW5vbmljYWxQcm9qZWN0Um9vdCk7XG4gICAgICAgICAgICAgIGlmICh0cmlnZ2VyQXJ0aWZhY3RWZXJpZmllZCkge1xuICAgICAgICAgICAgICAgIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwgeyBwaGFzZTogXCJyZWdlbmVyYXRlLXByb2plY3Rpb25cIiwgZXJyb3I6IFN0cmluZyhlKSB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAocy5jdXJyZW50VW5pdC50eXBlID09PSBcInJlc2VhcmNoLXByb2plY3RcIikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNsZWFyUHJvamVjdFJlc2VhcmNoSW5mbGlnaHRNYXJrZXIocy5iYXNlUGF0aCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHsgcGhhc2U6IFwicmVzZWFyY2gtcHJvamVjdC1pbmZsaWdodC1jbGVhbnVwXCIsIGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgaWYgKCF0cmlnZ2VyQXJ0aWZhY3RWZXJpZmllZCAmJiBzLmN1cnJlbnRVbml0LnR5cGUgPT09IFwicmVzZWFyY2gtcHJvamVjdFwiKSB7XG4gICAgICAgIGNvbnN0IHJldHJ5S2V5ID0gYCR7cy5jdXJyZW50VW5pdC50eXBlfToke3MuY3VycmVudFVuaXQuaWR9YDtcbiAgICAgICAgY29uc3Qgb3V0Y29tZSA9IGZpbmFsaXplUHJvamVjdFJlc2VhcmNoVGltZW91dChcbiAgICAgICAgICBzLmJhc2VQYXRoLFxuICAgICAgICAgIFwiUHJvamVjdCByZXNlYXJjaCB1bml0IGVuZGVkIGJlZm9yZSBhbGwgcmVxdWlyZWQgZGltZW5zaW9ucyBwcm9kdWNlZCBkdXJhYmxlIGZpbGVzLlwiLFxuICAgICAgICApO1xuICAgICAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IG51bGw7XG4gICAgICAgIHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5kZWxldGUocmV0cnlLZXkpO1xuICAgICAgICBzLnZlcmlmaWNhdGlvblJldHJ5RmFpbHVyZUhhc2hlcy5kZWxldGUocmV0cnlLZXkpO1xuICAgICAgICB0cmlnZ2VyQXJ0aWZhY3RWZXJpZmllZCA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3Qocy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkLCBzLmJhc2VQYXRoKTtcbiAgICAgICAgaWYgKHRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkKSB7XG4gICAgICAgICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICBvdXRjb21lLmtpbmQgPT09IFwicGFydGlhbC1ibG9ja2Vyc1wiXG4gICAgICAgICAgICAgID8gXCJQcm9qZWN0IHJlc2VhcmNoIGZpbmlzaGVkIHBhcnRpYWxseTsgd3JvdGUgYmxvY2tlcnMgZm9yIG1pc3NpbmcgZGltZW5zaW9ucyBhbmQgYWR2YW5jaW5nIHdpdGhvdXQgcmVydW5uaW5nIGFsbCBzY291dHMuXCJcbiAgICAgICAgICAgICAgOiBcIlByb2plY3QgcmVzZWFyY2ggYXJ0aWZhY3RzIGFyZSBub3cgdGVybWluYWwuXCIsXG4gICAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgICBcIlByb2plY3QgcmVzZWFyY2ggcHJvZHVjZWQgbm8gdXNhYmxlIHJlc2VhcmNoIGZpbGVzOyB3cm90ZSBQUk9KRUNULVJFU0VBUkNILUJMT0NLRVIubWQgYW5kIGNvbnRpbnVpbmcgZmFpbC1jbG9zZWQuXCIsXG4gICAgICAgICAgICBcImVycm9yXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4gXCJjb250aW51ZVwiO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFdoZW4gYXJ0aWZhY3QgdmVyaWZpY2F0aW9uIGZhaWxzIGZvciBhIHVuaXQgdHlwZSB0aGF0IGhhcyBhIGtub3duIGV4cGVjdGVkXG4gICAgICAvLyBhcnRpZmFjdCwgYXNrIHRoZSBjYWxsZXIgdG8gcmV0cnkgc28gaXQgcmUtZGlzcGF0Y2hlcyB3aXRoIGZhaWx1cmUgY29udGV4dFxuICAgICAgLy8gaW5zdGVhZCBvZiBibGluZGx5IHJlLWRpc3BhdGNoaW5nIHRoZSBzYW1lIHVuaXQgKCMxNTcxKS5cbiAgICAgIC8vIFJldHJpZXMgYXJlIGNhcHBlZCBhdCBNQVhfQVJUSUZBQ1RfVkVSSUZJQ0FUSU9OX1JFVFJJRVMgdG8gcHJldmVudFxuICAgICAgLy8gdW5ib3VuZGVkIGxvb3BzICgjMjAwNykuXG4gICAgICAvL1xuICAgICAgLy8gUHJlLWNoZWNrcyBzaG9ydC1jaXJjdWl0IHJldHJ5IGZvciBrbm93bi11bnJlY292ZXJhYmxlIGZhaWx1cmVzOlxuICAgICAgLy8gLSBVc2VyLWlucHV0IHdhaXRzIGluIGRlZXAgc2V0dXA6IHBhdXNlIGluc3RlYWQgb2YgcmV0cnlpbmcgb3Igd3JpdGluZ1xuICAgICAgLy8gICBwbGFjZWhvbGRlcnMgd2hpbGUgdGhlIGFnZW50IGlzIHdhaXRpbmcgZm9yIGFwcHJvdmFsLlxuICAgICAgLy8gLSBEZXRlcm1pbmlzdGljIHBvbGljeSByZWplY3Rpb24gKCM0OTczKTogc3RydWN0dXJhbCB3cml0ZS1nYXRlIGZhaWx1cmVcbiAgICAgIC8vICAgdGhhdCB3aWxsIHJlY3VyIG9uIGV2ZXJ5IHJldHJ5LCBzbyB3cml0ZSBhIGJsb2NrZXIgcGxhY2Vob2xkZXIuXG4gICAgICAvLyAtIERCIGluZnJhIGZhaWx1cmUgKCMyNTE3KTogY29tcGxldGlvbiB0b29sIHJldHVybmVkIGRiX3VuYXZhaWxhYmxlLCBzb1xuICAgICAgLy8gICB0aGUgYXJ0aWZhY3Qgd2FzIG5ldmVyIHdyaXR0ZW4uIFJldHJ5aW5nIGNhbiBuZXZlciBzdWNjZWVkLlxuICAgICAgLy8gLSBUb29sIGludm9jYXRpb24gZXJyb3IgKCMyODgzLyMzNTk1KTogbWFsZm9ybWVkIEpTT04gYXJncyBvciBxdWV1ZWRcbiAgICAgIC8vICAgdXNlciBtZXNzYWdlIFx1MjAxNCByZXRyeSB3aWxsIHByb2R1Y2UgdGhlIHNhbWUgZmFpbHVyZS5cbiAgICAgIC8vXG4gICAgICAvLyBVc2VyLWRyaXZlbiBkZWVwIHNldHVwIHByb21wdHMgbWF5IGFzayBmb3IgYXBwcm92YWwgYmVmb3JlIHRoZSBmaW5hbFxuICAgICAgLy8gcm9vdCBhcnRpZmFjdCB3cml0ZS4gSWYgYSBwcmVtYXR1cmUgd3JpdGUgaGl0cyB0aGUgd3JpdGUgZ2F0ZSBpbiB0aGVcbiAgICAgIC8vIHNhbWUgdHVybiwgdGhlIHVzZXIgd2FpdCBpcyB0aGUgbWVhbmluZ2Z1bCBzdGF0ZTsgcGF1c2UgaW5zdGVhZCBvZlxuICAgICAgLy8gd3JpdGluZyBhIHBsYWNlaG9sZGVyIG92ZXIgUFJPSkVDVC9SRVFVSVJFTUVOVFMuXG4gICAgICBpZiAoIXRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkICYmIFVTRVJfRFJJVkVOX0RFRVBfVU5JVFMuaGFzKHMuY3VycmVudFVuaXQudHlwZSkgJiYgaXNBd2FpdGluZ1VzZXJJbnB1dChvcHRzPy5hZ2VudEVuZE1lc3NhZ2VzKSkge1xuICAgICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHtcbiAgICAgICAgICBwaGFzZTogXCJhcnRpZmFjdC12ZXJpZnktYXdhaXRpbmctdXNlclwiLFxuICAgICAgICAgIHVuaXRUeXBlOiBzLmN1cnJlbnRVbml0LnR5cGUsXG4gICAgICAgICAgdW5pdElkOiBzLmN1cnJlbnRVbml0LmlkLFxuICAgICAgICB9KTtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgJHtzLmN1cnJlbnRVbml0LnR5cGV9ICR7cy5jdXJyZW50VW5pdC5pZH0gaXMgd2FpdGluZyBmb3IgeW91ciBpbnB1dCBcdTIwMTQgcGF1c2luZyBhdXRvLW1vZGUgaW5zdGVhZCBvZiByZXRyeWluZyB0aGUgbWlzc2luZyBhcnRpZmFjdC5gLFxuICAgICAgICAgIFwiaW5mb1wiLFxuICAgICAgICApO1xuICAgICAgICBzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yID0gbnVsbDtcbiAgICAgICAgYXdhaXQgcGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgICByZXR1cm4gXCJkaXNwYXRjaGVkXCI7XG4gICAgICB9IGVsc2UgaWYgKCF0cmlnZ2VyQXJ0aWZhY3RWZXJpZmllZCAmJiBzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yICYmIGlzRGV0ZXJtaW5pc3RpY1BvbGljeUVycm9yKHMubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IpKSB7XG4gICAgICAgIGNvbnN0IHJldHJ5S2V5ID0gYCR7cy5jdXJyZW50VW5pdC50eXBlfToke3MuY3VycmVudFVuaXQuaWR9YDtcbiAgICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcImRldGVybWluaXN0aWMtcG9saWN5LWVycm9yLXBsYWNlaG9sZGVyXCIsIHVuaXRUeXBlOiBzLmN1cnJlbnRVbml0LnR5cGUsIHVuaXRJZDogcy5jdXJyZW50VW5pdC5pZCwgZXJyb3I6IHMubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3IgfSk7XG4gICAgICAgIGNvbnN0IHJlYXNvbiA9IGBEZXRlcm1pbmlzdGljIHBvbGljeSByZWplY3Rpb24gZm9yICR7cy5jdXJyZW50VW5pdC50eXBlfSBcIiR7cy5jdXJyZW50VW5pdC5pZH1cIjogJHtzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yfS4gUmV0cnlpbmcgY2Fubm90IHJlc29sdmUgdGhpcyBnYXRlIFx1MjAxNCB3cml0aW5nIGJsb2NrZXIgcGxhY2Vob2xkZXIgdG8gYWR2YW5jZSBwaXBlbGluZS5gO1xuICAgICAgICBzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yID0gbnVsbDtcbiAgICAgICAgcy5wZW5kaW5nVmVyaWZpY2F0aW9uUmV0cnkgPSBudWxsO1xuICAgICAgICBzLnZlcmlmaWNhdGlvblJldHJ5Q291bnQuZGVsZXRlKHJldHJ5S2V5KTtcbiAgICAgICAgcy52ZXJpZmljYXRpb25SZXRyeUZhaWx1cmVIYXNoZXMuZGVsZXRlKHJldHJ5S2V5KTtcbiAgICAgICAgd3JpdGVCbG9ja2VyUGxhY2Vob2xkZXIocy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkLCBzLmJhc2VQYXRoLCByZWFzb24pO1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIGAke3MuY3VycmVudFVuaXQudHlwZX0gJHtzLmN1cnJlbnRVbml0LmlkfSBcdTIwMTQgZGV0ZXJtaW5pc3RpYyBwb2xpY3kgcmVqZWN0aW9uLCB3cm90ZSBibG9ja2VyIHBsYWNlaG9sZGVyIChubyByZXRyaWVzKSAoIzQ5NzMpYCxcbiAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgKTtcbiAgICAgICAgLy8gRmFsbCB0aHJvdWdoIHRvIFwiY29udGludWVcIiBcdTIwMTQgZG8gTk9UIGVudGVyIHRoZSByZXRyeSBvciBkYi11bmF2YWlsYWJsZSBwYXRocy5cbiAgICAgIH0gZWxzZSBpZiAoIXRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkICYmIGRpYWdub3NlV29ya3RyZWVJbnRlZ3JpdHlGYWlsdXJlKHMuYmFzZVBhdGgpKSB7XG4gICAgICAgIGNvbnN0IHJldHJ5S2V5ID0gYCR7cy5jdXJyZW50VW5pdC50eXBlfToke3MuY3VycmVudFVuaXQuaWR9YDtcbiAgICAgICAgY29uc3Qgd29ya3RyZWVGYWlsdXJlID0gZGlhZ25vc2VXb3JrdHJlZUludGVncml0eUZhaWx1cmUocy5iYXNlUGF0aCkhO1xuICAgICAgICBzLnBlbmRpbmdWZXJpZmljYXRpb25SZXRyeSA9IG51bGw7XG4gICAgICAgIHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5kZWxldGUocmV0cnlLZXkpO1xuICAgICAgICBzLnZlcmlmaWNhdGlvblJldHJ5RmFpbHVyZUhhc2hlcy5kZWxldGUocmV0cnlLZXkpO1xuICAgICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHtcbiAgICAgICAgICBwaGFzZTogXCJ3b3JrdHJlZS1pbnRlZ3JpdHktZmFpbHVyZVwiLFxuICAgICAgICAgIHVuaXRUeXBlOiBzLmN1cnJlbnRVbml0LnR5cGUsXG4gICAgICAgICAgdW5pdElkOiBzLmN1cnJlbnRVbml0LmlkLFxuICAgICAgICAgIGJhc2VQYXRoOiBzLmJhc2VQYXRoLFxuICAgICAgICB9KTtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgJHt3b3JrdHJlZUZhaWx1cmV9IFJldHJ5ICR7cy5jdXJyZW50VW5pdC5pZH0gYWZ0ZXIgcmVwYWlyLmAsXG4gICAgICAgICAgXCJlcnJvclwiLFxuICAgICAgICApO1xuICAgICAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgIHJldHVybiBcImRpc3BhdGNoZWRcIjtcbiAgICAgIH0gZWxzZSBpZiAoIXRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkICYmICFpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcImFydGlmYWN0LXZlcmlmeS1za2lwLWRiLXVuYXZhaWxhYmxlXCIsIHVuaXRUeXBlOiBzLmN1cnJlbnRVbml0LnR5cGUsIHVuaXRJZDogcy5jdXJyZW50VW5pdC5pZCB9KTtcbiAgICAgICAgY29uc3QgZGJTa2lwRGlhZyA9IGRpYWdub3NlRXhwZWN0ZWRBcnRpZmFjdChzLmN1cnJlbnRVbml0LnR5cGUsIHMuY3VycmVudFVuaXQuaWQsIHMuYmFzZVBhdGgpO1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIGBBcnRpZmFjdCBtaXNzaW5nIGZvciAke3MuY3VycmVudFVuaXQudHlwZX0gJHtzLmN1cnJlbnRVbml0LmlkfSBcdTIwMTQgREIgdW5hdmFpbGFibGUsIHNraXBwaW5nIHJldHJ5LiR7ZGJTa2lwRGlhZyA/IGAgRXhwZWN0ZWQ6ICR7ZGJTa2lwRGlhZ31gIDogXCJcIn1gLFxuICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSBpZiAoIXRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkKSB7XG4gICAgICAgIGlmIChzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yKSB7XG4gICAgICAgICAgY29uc3QgaXNVc2VyU2tpcCA9IC9xdWV1ZWQgdXNlciBtZXNzYWdlL2kudGVzdChzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yKTtcbiAgICAgICAgICBjb25zdCBlcnJNc2cgPSBpc1VzZXJTa2lwXG4gICAgICAgICAgICA/IGBUb29sIHNraXBwZWQgZm9yICR7cy5jdXJyZW50VW5pdC50eXBlfTogJHtzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yfS4gUXVldWVkIHVzZXIgbWVzc2FnZSBpbnRlcnJ1cHRlZCB0aGUgdHVybiBcdTIwMTQgcGF1c2luZyBhdXRvLW1vZGUuYFxuICAgICAgICAgICAgOiBgVG9vbCBpbnZvY2F0aW9uIGZhaWxlZCBmb3IgJHtzLmN1cnJlbnRVbml0LnR5cGV9OiAke3MubGFzdFRvb2xJbnZvY2F0aW9uRXJyb3J9LiBTdHJ1Y3R1cmVkIGFyZ3VtZW50IGdlbmVyYXRpb24gZmFpbGVkIFx1MjAxNCBwYXVzaW5nIGF1dG8tbW9kZS5gO1xuICAgICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwgeyBwaGFzZTogXCJ0b29sLWludm9jYXRpb24tZXJyb3ItcGF1c2VcIiwgdW5pdFR5cGU6IHMuY3VycmVudFVuaXQudHlwZSwgdW5pdElkOiBzLmN1cnJlbnRVbml0LmlkLCBlcnJvcjogcy5sYXN0VG9vbEludm9jYXRpb25FcnJvciB9KTtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KGVyck1zZywgXCJlcnJvclwiKTtcbiAgICAgICAgICBzLmxhc3RUb29sSW52b2NhdGlvbkVycm9yID0gbnVsbDtcbiAgICAgICAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgICAgcmV0dXJuIFwiZGlzcGF0Y2hlZFwiO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgaGFzRXhwZWN0ZWRBcnRpZmFjdCA9IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aChzLmN1cnJlbnRVbml0LnR5cGUsIHMuY3VycmVudFVuaXQuaWQsIHMuYmFzZVBhdGgpICE9PSBudWxsO1xuICAgICAgICBpZiAoaGFzRXhwZWN0ZWRBcnRpZmFjdCkge1xuICAgICAgICAgIGNvbnN0IHJldHJ5S2V5ID0gYCR7cy5jdXJyZW50VW5pdC50eXBlfToke3MuY3VycmVudFVuaXQuaWR9YDtcbiAgICAgICAgICBjb25zdCBhdHRlbXB0ID0gKHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5nZXQocmV0cnlLZXkpID8/IDApICsgMTtcbiAgICAgICAgICBjb25zdCBmYWlsdXJlRGV0YWlscyA9IGRlc2NyaWJlQXJ0aWZhY3RWZXJpZmljYXRpb25GYWlsdXJlKFxuICAgICAgICAgICAgcy5jdXJyZW50VW5pdC50eXBlLFxuICAgICAgICAgICAgcy5jdXJyZW50VW5pdC5pZCxcbiAgICAgICAgICAgIHMuYmFzZVBhdGgsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBpZiAoYXR0ZW1wdCA+IE1BWF9BUlRJRkFDVF9WRVJJRklDQVRJT05fUkVUUklFUykge1xuICAgICAgICAgICAgcy52ZXJpZmljYXRpb25SZXRyeUNvdW50LmRlbGV0ZShyZXRyeUtleSk7XG4gICAgICAgICAgICBzLnZlcmlmaWNhdGlvblJldHJ5RmFpbHVyZUhhc2hlcy5kZWxldGUocmV0cnlLZXkpO1xuICAgICAgICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcImFydGlmYWN0LXZlcmlmeS1leGhhdXN0ZWRcIiwgdW5pdFR5cGU6IHMuY3VycmVudFVuaXQudHlwZSwgdW5pdElkOiBzLmN1cnJlbnRVbml0LmlkLCBhdHRlbXB0IH0pO1xuICAgICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgICAgYCR7ZmFpbHVyZURldGFpbHN9IFBhdXNpbmcgYXV0by1tb2RlIGFmdGVyICR7TUFYX0FSVElGQUNUX1ZFUklGSUNBVElPTl9SRVRSSUVTfSByZXRyaWVzLmAsXG4gICAgICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgICAgICByZXR1cm4gXCJkaXNwYXRjaGVkXCI7XG4gICAgICAgICAgfVxuICAgICAgICAgIHMudmVyaWZpY2F0aW9uUmV0cnlDb3VudC5zZXQocmV0cnlLZXksIGF0dGVtcHQpO1xuICAgICAgICAgIHMucGVuZGluZ1ZlcmlmaWNhdGlvblJldHJ5ID0ge1xuICAgICAgICAgICAgdW5pdElkOiBzLmN1cnJlbnRVbml0LmlkLFxuICAgICAgICAgICAgZmFpbHVyZUNvbnRleHQ6IGAke2ZhaWx1cmVEZXRhaWxzfSAoYXR0ZW1wdCAke2F0dGVtcHR9LyR7TUFYX0FSVElGQUNUX1ZFUklGSUNBVElPTl9SRVRSSUVTfSkuYCxcbiAgICAgICAgICAgIGF0dGVtcHQsXG4gICAgICAgICAgfTtcbiAgICAgICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHsgcGhhc2U6IFwiYXJ0aWZhY3QtdmVyaWZ5LXJldHJ5XCIsIHVuaXRUeXBlOiBzLmN1cnJlbnRVbml0LnR5cGUsIHVuaXRJZDogcy5jdXJyZW50VW5pdC5pZCwgYXR0ZW1wdCB9KTtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYCR7ZmFpbHVyZURldGFpbHN9IFJldHJ5aW5nIChhdHRlbXB0ICR7YXR0ZW1wdH0vJHtNQVhfQVJUSUZBQ1RfVkVSSUZJQ0FUSU9OX1JFVFJJRVN9KS5gLFxuICAgICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFZlcmlmaWNhdGlvbiBzdWNjZWVkZWQgXHUyMDE0IGNsZWFyIHRoZSByZXRyeSBjb3VudGVyIHNvIGEgZnV0dXJlIGZhaWx1cmVcbiAgICAgIC8vIG9mIHRoZSBzYW1lIHVuaXQgZ2V0cyBhIGZ1bGwgcmV0cnkgYnVkZ2V0IGluc3RlYWQgb2YgdGhlIHN0YWxlIGNvdW50LlxuICAgICAgaWYgKHRyaWdnZXJBcnRpZmFjdFZlcmlmaWVkKSB7XG4gICAgICAgIGNvbnN0IHJldHJ5S2V5ID0gdmVyaWZpY2F0aW9uUmV0cnlLZXkocy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkKTtcbiAgICAgICAgcy52ZXJpZmljYXRpb25SZXRyeUNvdW50LmRlbGV0ZShyZXRyeUtleSk7XG4gICAgICAgIHMudmVyaWZpY2F0aW9uUmV0cnlGYWlsdXJlSGFzaGVzLmRlbGV0ZShyZXRyeUtleSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEhvb2sgdW5pdCBjb21wbGV0ZWQgXHUyMDE0IG5vIGFkZGl0aW9uYWwgcHJvY2Vzc2luZyBuZWVkZWRcbiAgICB9XG4gIH1cblxuICByZXR1cm4gXCJjb250aW51ZVwiO1xufVxuXG4vKipcbiAqIFBvc3QtdmVyaWZpY2F0aW9uIHByb2Nlc3Npbmc6IERCIGR1YWwtd3JpdGUsIHBvc3QtdW5pdCBob29rcywgdHJpYWdlXG4gKiBjYXB0dXJlIGRpc3BhdGNoLCBxdWljay10YXNrIGRpc3BhdGNoLlxuICpcbiAqIFNpZGVjYXIgd29yayAoaG9va3MsIHRyaWFnZSwgcXVpY2stdGFza3MpIGlzIGVucXVldWVkIG9uIGBzLnNpZGVjYXJRdWV1ZWBcbiAqIGZvciB0aGUgbWFpbiBsb29wIHRvIGRyYWluIHZpYSBgcnVuVW5pdCgpYC5cbiAqXG4gKiBSZXR1cm5zOlxuICogLSBcImNvbnRpbnVlXCIgXHUyMDE0IHByb2NlZWQgdG8gc2lkZWNhciBkcmFpbiAvIG5vcm1hbCBkaXNwYXRjaFxuICogLSBcInN0ZXAtd2l6YXJkXCIgXHUyMDE0IHN0ZXAgbW9kZSwgc2hvdyB3aXphcmQgaW5zdGVhZFxuICogLSBcInN0b3BwZWRcIiBcdTIwMTQgc3RvcEF1dG8gd2FzIGNhbGxlZFxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uKHBjdHg6IFBvc3RVbml0Q29udGV4dCk6IFByb21pc2U8XCJjb250aW51ZVwiIHwgXCJzdGVwLXdpemFyZFwiIHwgXCJzdG9wcGVkXCI+IHtcbiAgY29uc3QgeyBzLCBjdHgsIHBpLCBidWlsZFNuYXBzaG90T3B0cywgbG9ja0Jhc2UsIHN0b3BBdXRvLCBwYXVzZUF1dG8sIHVwZGF0ZVByb2dyZXNzV2lkZ2V0IH0gPSBwY3R4O1xuXG4gIGlmIChzLmN1cnJlbnRVbml0KSB7XG4gICAgaWYgKHNob3VsZERlZmVyQ2xvc2VvdXRHaXRBY3Rpb24ocy5jdXJyZW50VW5pdC50eXBlKSkge1xuICAgICAgY29uc3QgZ2l0QWN0aW9uUmVzdWx0ID0gYXdhaXQgcnVuQ2xvc2VvdXRHaXRBY3Rpb24ocGN0eCwgcy5jdXJyZW50VW5pdCwgeyBzb2Z0RmFpbHVyZTogdHJ1ZSB9KTtcbiAgICAgIGlmIChnaXRBY3Rpb25SZXN1bHQgPT09IFwiZGlzcGF0Y2hlZFwiKSB7XG4gICAgICAgIHJldHVybiBcInN0b3BwZWRcIjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgY29kZWJhc2VQcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpPy5wcmVmZXJlbmNlcz8uY29kZWJhc2U7XG4gICAgICBjb25zdCByZWZyZXNoID0gZW5zdXJlQ29kZWJhc2VNYXBGcmVzaChcbiAgICAgICAgcy5iYXNlUGF0aCxcbiAgICAgICAgY29kZWJhc2VQcmVmc1xuICAgICAgICAgID8ge1xuICAgICAgICAgICAgICBleGNsdWRlUGF0dGVybnM6IGNvZGViYXNlUHJlZnMuZXhjbHVkZV9wYXR0ZXJucyxcbiAgICAgICAgICAgICAgbWF4RmlsZXM6IGNvZGViYXNlUHJlZnMubWF4X2ZpbGVzLFxuICAgICAgICAgICAgICBjb2xsYXBzZVRocmVzaG9sZDogY29kZWJhc2VQcmVmcy5jb2xsYXBzZV90aHJlc2hvbGQsXG4gICAgICAgICAgICB9XG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIHsgZm9yY2U6IHRydWUsIHR0bE1zOiAwIH0sXG4gICAgICApO1xuICAgICAgaWYgKHJlZnJlc2guc3RhdHVzID09PSBcImdlbmVyYXRlZFwiIHx8IHJlZnJlc2guc3RhdHVzID09PSBcInVwZGF0ZWRcIikge1xuICAgICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHtcbiAgICAgICAgICBwaGFzZTogXCJjb2RlYmFzZS1yZWZyZXNoXCIsXG4gICAgICAgICAgdW5pdFR5cGU6IHMuY3VycmVudFVuaXQudHlwZSxcbiAgICAgICAgICB1bml0SWQ6IHMuY3VycmVudFVuaXQuaWQsXG4gICAgICAgICAgc3RhdHVzOiByZWZyZXNoLnN0YXR1cyxcbiAgICAgICAgICBmaWxlQ291bnQ6IHJlZnJlc2guZmlsZUNvdW50LFxuICAgICAgICAgIHJlYXNvbjogcmVmcmVzaC5yZWFzb24sXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJlbmdpbmVcIiwgYENPREVCQVNFIHJlZnJlc2ggZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBQb3N0LXVuaXQgaG9va3MgXHUyNTAwXHUyNTAwXG4gIGlmIChzLmN1cnJlbnRVbml0ICYmICFzLnN0ZXBNb2RlKSB7XG4gICAgY29uc3QgaG9va1VuaXQgPSBjaGVja1Bvc3RVbml0SG9va3Mocy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkLCBzLmJhc2VQYXRoKTtcbiAgICBpZiAoaG9va1VuaXQpIHtcbiAgICAgIGlmIChzLmN1cnJlbnRVbml0KSB7XG4gICAgICAgIGF3YWl0IGNsb3Nlb3V0VW5pdChjdHgsIHMuYmFzZVBhdGgsIHMuY3VycmVudFVuaXQudHlwZSwgcy5jdXJyZW50VW5pdC5pZCwgcy5jdXJyZW50VW5pdC5zdGFydGVkQXQsIGJ1aWxkU25hcHNob3RPcHRzKHMuY3VycmVudFVuaXQudHlwZSwgcy5jdXJyZW50VW5pdC5pZCkpO1xuICAgICAgfVxuICAgICAgcGVyc2lzdEhvb2tTdGF0ZShzLmJhc2VQYXRoKTtcblxuICAgICAgcmV0dXJuIGVucXVldWVTaWRlY2FyKFxuICAgICAgICBzLCBjdHgsXG4gICAgICAgIHsga2luZDogXCJob29rXCIsIHVuaXRUeXBlOiBob29rVW5pdC51bml0VHlwZSwgdW5pdElkOiBob29rVW5pdC51bml0SWQsIHByb21wdDogaG9va1VuaXQucHJvbXB0LCBtb2RlbDogaG9va1VuaXQubW9kZWwgfSxcbiAgICAgICAgeyBob29rTmFtZTogaG9va1VuaXQuaG9va05hbWUgfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgaWYgYSBob29rIHJlcXVlc3RlZCBhIHJldHJ5IG9mIHRoZSB0cmlnZ2VyIHVuaXRcbiAgICBpZiAoaXNSZXRyeVBlbmRpbmcoKSkge1xuICAgICAgY29uc3QgdHJpZ2dlciA9IGNvbnN1bWVSZXRyeVRyaWdnZXIoKTtcbiAgICAgIGlmICh0cmlnZ2VyKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYEhvb2sgcmVxdWVzdGVkIHJldHJ5IG9mICR7dHJpZ2dlci51bml0VHlwZX0gJHt0cmlnZ2VyLnVuaXRJZH0gXHUyMDE0IHJlc2V0dGluZyB0YXNrIHN0YXRlLmAsXG4gICAgICAgICAgXCJpbmZvXCIsXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0YXRlIHJlc2V0OiB1bmRvIHRoZSBjb21wbGV0aW9uIHNvIGRlcml2ZVN0YXRlIHJlLWRlcml2ZXMgdGhlIHVuaXQgXHUyNTAwXHUyNTAwXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgeyBtaWxlc3RvbmU6IG1pZCwgc2xpY2U6IHNpZCwgdGFzazogdGlkIH0gPSBwYXJzZVVuaXRJZCh0cmlnZ2VyLnVuaXRJZCk7XG5cbiAgICAgICAgICAvLyAxLiBSZXNldCB0YXNrIHN0YXR1cyBpbiBEQiBhbmQgcmUtcmVuZGVyIHBsYW4gY2hlY2tib3hlc1xuICAgICAgICAgIGlmIChtaWQgJiYgc2lkICYmIHRpZCkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgdXBkYXRlVGFza1N0YXR1cyhtaWQsIHNpZCwgdGlkLCBcInBlbmRpbmdcIik7XG4gICAgICAgICAgICAgIGF3YWl0IHJlbmRlclBsYW5DaGVja2JveGVzKHMuY2Fub25pY2FsUHJvamVjdFJvb3QsIG1pZCwgc2lkKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGRiRXJyKSB7XG4gICAgICAgICAgICAgIC8vIERCIHVuYXZhaWxhYmxlIFx1MjAxNCBmYWlsIGV4cGxpY2l0bHkgcmF0aGVyIHRoYW4gc2lsZW50bHkgcmV2ZXJ0aW5nIHRvIG1hcmtkb3duIG11dGF0aW9uLlxuICAgICAgICAgICAgICAvLyBVc2UgJ2dzZCByZWNvdmVyJyB0byByZWJ1aWxkIERCIHN0YXRlIGZyb20gZGlzayBpZiBuZWVkZWQuXG4gICAgICAgICAgICAgIGxvZ0Vycm9yKFwiZW5naW5lXCIsIGByZXRyeSBzdGF0ZS1yZXNldCBmYWlsZWQgKERCIHVuYXZhaWxhYmxlKTogJHsoZGJFcnIgYXMgRXJyb3IpLm1lc3NhZ2V9LiBSdW4gJ2dzZCByZWNvdmVyJyB0byByZWNvbmNpbGUuYCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gMi4gRGVsZXRlIFNVTU1BUlkubWQgZm9yIHRoZSB0YXNrXG4gICAgICAgICAgaWYgKG1pZCAmJiBzaWQgJiYgdGlkKSB7XG4gICAgICAgICAgICAvLyBQaGFzZSBDOiByZWFkK2RlbGV0ZSB2aWEgY2Fub25pY2FsIHByb2plY3Qgcm9vdC5cbiAgICAgICAgICAgIGNvbnN0IHRhc2tzRGlyID0gcmVzb2x2ZVRhc2tzRGlyKHMuY2Fub25pY2FsUHJvamVjdFJvb3QsIG1pZCwgc2lkKTtcbiAgICAgICAgICAgIGlmICh0YXNrc0Rpcikge1xuICAgICAgICAgICAgICBjb25zdCBzdW1tYXJ5RmlsZSA9IGpvaW4odGFza3NEaXIsIGJ1aWxkVGFza0ZpbGVOYW1lKHRpZCwgXCJTVU1NQVJZXCIpKTtcbiAgICAgICAgICAgICAgaWYgKGV4aXN0c1N5bmMoc3VtbWFyeUZpbGUpKSB7XG4gICAgICAgICAgICAgICAgdW5saW5rU3luYyhzdW1tYXJ5RmlsZSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyAzLiBEZWxldGUgdGhlIHJldHJ5X29uIGFydGlmYWN0IChlLmcuIE5FRURTLVJFV09SSy5tZClcbiAgICAgICAgICBpZiAodHJpZ2dlci5yZXRyeUFydGlmYWN0KSB7XG4gICAgICAgICAgICBjb25zdCByZXRyeUFydGlmYWN0UGF0aCA9IHJlc29sdmVIb29rQXJ0aWZhY3RQYXRoKHMuY2Fub25pY2FsUHJvamVjdFJvb3QsIHRyaWdnZXIudW5pdElkLCB0cmlnZ2VyLnJldHJ5QXJ0aWZhY3QpO1xuICAgICAgICAgICAgaWYgKGV4aXN0c1N5bmMocmV0cnlBcnRpZmFjdFBhdGgpKSB7XG4gICAgICAgICAgICAgIHVubGlua1N5bmMocmV0cnlBcnRpZmFjdFBhdGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIDUuIEludmFsaWRhdGUgY2FjaGVzIHNvIGRlcml2ZVN0YXRlIHJlYWRzIGZyZXNoIGRpc2sgc3RhdGVcbiAgICAgICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblwiLCB7IHBoYXNlOiBcInJldHJ5LXN0YXRlLXJlc2V0XCIsIGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGYWxsIHRocm91Z2ggdG8gbm9ybWFsIGRpc3BhdGNoIFx1MjAxNCBkZXJpdmVTdGF0ZSB3aWxsIHJlLWRlcml2ZSB0aGUgdW5pdFxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBGYXN0LXBhdGggc3RvcCBkZXRlY3Rpb24gKCMzNDg3KSBcdTI1MDBcdTI1MDBcbiAgLy8gQmVmb3JlIHdhaXRpbmcgZm9yIHRyaWFnZSwgY2hlY2sgaWYgYW55IFBFTkRJTkcgY2FwdHVyZXMgY29udGFpbiBleHBsaWNpdFxuICAvLyBzdG9wL2hhbHQgbGFuZ3VhZ2UuIElmIHNvLCBwYXVzZSBpbW1lZGlhdGVseSBcdTIwMTQgZG9uJ3Qgd2FpdCBmb3IgdHJpYWdlLlxuICBpZiAocy5jdXJyZW50VW5pdCAmJiBzLmN1cnJlbnRVbml0LnR5cGUgIT09IFwidHJpYWdlLWNhcHR1cmVzXCIpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcGVuZGluZyA9IGxvYWRQZW5kaW5nQ2FwdHVyZXMocy5iYXNlUGF0aCk7XG4gICAgICAvLyBNYXRjaCBvbmx5IHdoZW4gdGhlIGNhcHR1cmUgdGV4dCBzdGFydHMgd2l0aCBhIHN0b3AvaGFsdCBkaXJlY3RpdmUgd29yZCxcbiAgICAgIC8vIG9yIHRoZSBlbnRpcmUgdGV4dCBpcyBzaG9ydCBhbmQgZG9taW5hdGVkIGJ5IHN1Y2ggYSB3b3JkLiBUaGlzIGF2b2lkc1xuICAgICAgLy8gZmFsc2UgcG9zaXRpdmVzIG9uIGNhcHR1cmVzIGxpa2UgXCJhZGQgYSBwYXVzZSBidXR0b25cIiBvciBcInN0b3AgdGhlIHRpbWVyXG4gICAgICAvLyBmcm9tIHJlLXJlbmRlcmluZ1wiIFx1MjAxNCB0aG9zZSBhcmUgZmVhdHVyZSBkZXNjcmlwdGlvbnMsIG5vdCBoYWx0IGRpcmVjdGl2ZXMuXG4gICAgICBjb25zdCBTVE9QX1BBVFRFUk4gPSAvXihzdG9wfGhhbHR8YWJvcnR8ZG9uJz90IGNvbnRpbnVlfHBhdXNlfGNlYXNlKVxcYi9pO1xuICAgICAgY29uc3Qgc3RvcENhcHR1cmUgPSBwZW5kaW5nLmZpbmQoYyA9PiBTVE9QX1BBVFRFUk4udGVzdChjLnRleHQudHJpbSgpKSk7XG4gICAgICBpZiAoc3RvcENhcHR1cmUpIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgU3RvcCBkaXJlY3RpdmUgZGV0ZWN0ZWQgaW4gcGVuZGluZyBjYXB0dXJlICR7c3RvcENhcHR1cmUuaWR9OiBcIiR7c3RvcENhcHR1cmUudGV4dH1cIiBcdTIwMTQgcGF1c2luZyBhdXRvLW1vZGUuYCxcbiAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgKTtcbiAgICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcImZhc3Qtc3RvcFwiLCBjYXB0dXJlSWQ6IHN0b3BDYXB0dXJlLmlkIH0pO1xuICAgICAgICBhd2FpdCBwYXVzZUF1dG8oY3R4LCBwaSk7XG4gICAgICAgIHJldHVybiBcInN0b3BwZWRcIjtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0XCIsIHsgcGhhc2U6IFwiZmFzdC1zdG9wLWVycm9yXCIsIGVycm9yOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIENhcHR1cmUgcHJvdGVjdGlvbjogcmV2ZXJ0IGV4ZWN1dG9yLXNpbGVuY2VkIGNhcHR1cmVzICgjMzQ4NykgXHUyNTAwXHUyNTAwXG4gIC8vIE5vbi10cmlhZ2UgYWdlbnRzIGNhbiB3cml0ZSAqKlN0YXR1czoqKiByZXNvbHZlZCB0byBDQVBUVVJFUy5tZCwgYnlwYXNzaW5nXG4gIC8vIHRoZSB0cmlhZ2UgcGlwZWxpbmUuIFJldmVydCB0aG9zZSB0byBwZW5kaW5nIGJlZm9yZSB0aGUgdHJpYWdlIGNoZWNrLlxuICBpZiAoXG4gICAgcy5jdXJyZW50VW5pdCAmJlxuICAgIHMuY3VycmVudFVuaXQudHlwZSAhPT0gXCJ0cmlhZ2UtY2FwdHVyZXNcIlxuICApIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmV2ZXJ0ZWQgPSByZXZlcnRFeGVjdXRvclJlc29sdmVkQ2FwdHVyZXMocy5iYXNlUGF0aCk7XG4gICAgICBpZiAocmV2ZXJ0ZWQgPiAwKSB7XG4gICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRcIiwgeyBwaGFzZTogXCJjYXB0dXJlLXByb3RlY3Rpb25cIiwgcmV2ZXJ0ZWQgfSk7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYFJldmVydGVkICR7cmV2ZXJ0ZWR9IGNhcHR1cmUke3JldmVydGVkID09PSAxID8gXCJcIiA6IFwic1wifSBzaWxlbmNlZCBieSBleGVjdXRvciBcdTIwMTQgcmUtcXVldWluZyBmb3IgdHJpYWdlLmAsXG4gICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcImNhcHR1cmUtcHJvdGVjdGlvbi1lcnJvclwiLCBlcnJvcjogU3RyaW5nKGUpIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBQcmUtZXhlY3V0aW9uIGNoZWNrcyAoYWZ0ZXIgcGxhbi1zbGljZSBvciBBRFItMDExIHJlZmluZS1zbGljZSBjb21wbGV0ZXMpIFx1MjUwMFx1MjUwMFxuICAvLyBCb3RoIGVtaXQgdGhlIHNhbWUgUExBTi5tZCArIHRhc2sgYXJ0aWZhY3RzIHZpYSBnc2RfcGxhbl9zbGljZSwgc28gdGhlXG4gIC8vIHNhbWUgc3RydWN0dXJhbCB2YWxpZGF0aW9uIGFwcGxpZXMgdG8gYm90aC5cbiAgaWYgKFxuICAgIHMuY3VycmVudFVuaXQgJiZcbiAgICAocy5jdXJyZW50VW5pdC50eXBlID09PSBcInBsYW4tc2xpY2VcIiB8fCBzLmN1cnJlbnRVbml0LnR5cGUgPT09IFwicmVmaW5lLXNsaWNlXCIpXG4gICkge1xuICAgIGNvbnN0IGN1cnJlbnRVbml0ID0gcy5jdXJyZW50VW5pdDtcbiAgICBsZXQgcHJlRXhlY1BhdXNlTmVlZGVkID0gZmFsc2U7XG4gICAgYXdhaXQgcnVuU2FmZWx5KFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIsIFwicHJlLWV4ZWN1dGlvbi1jaGVja3NcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM7XG4gICAgICBjb25zdCB1b2tGbGFncyA9IHJlc29sdmVVb2tGbGFncyhwcmVmcyk7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBDaGVjayBwcmVmZXJlbmNlcyBcdTIwMTQgcmVzcGVjdCBlbmhhbmNlZF92ZXJpZmljYXRpb24gYW5kIGVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wcmVcbiAgICAgICAgY29uc3QgZW5oYW5jZWRFbmFibGVkID0gcHJlZnM/LmVuaGFuY2VkX3ZlcmlmaWNhdGlvbiAhPT0gZmFsc2U7IC8vIGRlZmF1bHQgdHJ1ZVxuICAgICAgICBjb25zdCBwcmVFbmFibGVkID0gcHJlZnM/LmVuaGFuY2VkX3ZlcmlmaWNhdGlvbl9wcmUgIT09IGZhbHNlOyAgLy8gZGVmYXVsdCB0cnVlXG5cbiAgICAgICAgaWYgKCFlbmhhbmNlZEVuYWJsZWQgfHwgIXByZUVuYWJsZWQpIHtcbiAgICAgICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblwiLCB7XG4gICAgICAgICAgICBwaGFzZTogXCJwcmUtZXhlY3V0aW9uLWNoZWNrc1wiLFxuICAgICAgICAgICAgc2tpcHBlZDogdHJ1ZSxcbiAgICAgICAgICAgIHJlYXNvbjogXCJkaXNhYmxlZCBieSBwcmVmZXJlbmNlc1wiLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFBhcnNlIHRoZSB1bml0IElEIHRvIGdldCBtaWxlc3RvbmUvc2xpY2UgSURzXG4gICAgICAgIGNvbnN0IHsgbWlsZXN0b25lOiBtaWQsIHNsaWNlOiBzaWQgfSA9IHBhcnNlVW5pdElkKGN1cnJlbnRVbml0LmlkKTtcbiAgICAgICAgaWYgKCFtaWQgfHwgIXNpZCkge1xuICAgICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIsIHtcbiAgICAgICAgICAgIHBoYXNlOiBcInByZS1leGVjdXRpb24tY2hlY2tzXCIsXG4gICAgICAgICAgICBza2lwcGVkOiB0cnVlLFxuICAgICAgICAgICAgcmVhc29uOiBcImNvdWxkIG5vdCBwYXJzZSBtaWxlc3RvbmUvc2xpY2UgZnJvbSB1bml0IElEXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gR2V0IHRhc2tzIGZvciB0aGlzIHNsaWNlIGZyb20gREJcbiAgICAgICAgY29uc3QgdGFza3MgPSBnZXRTbGljZVRhc2tzKG1pZCwgc2lkKTtcbiAgICAgICAgaWYgKHRhc2tzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIsIHtcbiAgICAgICAgICAgIHBoYXNlOiBcInByZS1leGVjdXRpb24tY2hlY2tzXCIsXG4gICAgICAgICAgICBza2lwcGVkOiB0cnVlLFxuICAgICAgICAgICAgcmVhc29uOiBcIm5vIHRhc2tzIGZvdW5kIGZvciBzbGljZVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHN0cmljdE1vZGUgPSBwcmVmcz8uZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdCA9PT0gdHJ1ZTtcblxuICAgICAgICAvLyBSdW4gcHJlLWV4ZWN1dGlvbiBjaGVja3MgYWdhaW5zdCBzLmJhc2VQYXRoIFx1MjAxNCB0aGUgYWN0dWFsIGNoZWNrb3V0XG4gICAgICAgIC8vIHdoZXJlIHByaW9yLXNsaWNlIGZpbGVzIHdlcmUgY3JlYXRlZC4gIEluIHdvcmt0cmVlIGlzb2xhdGlvbixcbiAgICAgICAgLy8gcy5jYW5vbmljYWxQcm9qZWN0Um9vdCBpcyB0aGUgcHJvamVjdCByb290IGFuZCBsYWNrcyBmaWxlcyB0aGF0IGFcbiAgICAgICAgLy8gcHJpb3Igc2xpY2Ugd3JvdGUgdG8gdGhlIHdvcmt0cmVlIGJ1dCBoYXNuJ3QgbWVyZ2VkIHRvIG1haW4geWV0LlxuICAgICAgICBjb25zdCBwcmVFeGVjdXRpb25CYXNlUGF0aCA9IHMuYmFzZVBhdGg7XG4gICAgICAgIGNvbnN0IHJlc3VsdDogUHJlRXhlY3V0aW9uUmVzdWx0ID0gYXdhaXQgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzKHRhc2tzLCBwcmVFeGVjdXRpb25CYXNlUGF0aCk7XG5cbiAgICAgICAgLy8gTG9nIHN1bW1hcnkgdG8gc3RkZXJyIGluIGV4aXN0aW5nIHZlcmlmaWNhdGlvbiBvdXRwdXQgZm9ybWF0XG4gICAgICAgIGNvbnN0IGVtb2ppID0gcmVzdWx0LnN0YXR1cyA9PT0gXCJwYXNzXCIgPyBcIlx1MjcwNVwiIDogcmVzdWx0LnN0YXR1cyA9PT0gXCJ3YXJuXCIgPyBcIlx1MjZBMFx1RkUwRlwiIDogXCJcdTI3NENcIjtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgYGdzZC1wcmUtZXhlYzogJHtlbW9qaX0gUHJlLWV4ZWN1dGlvbiBjaGVja3MgJHtyZXN1bHQuc3RhdHVzfSBmb3IgJHttaWR9LyR7c2lkfSAoJHtyZXN1bHQuZHVyYXRpb25Nc31tcylcXG5gLFxuICAgICAgICApO1xuXG4gICAgICAgIC8vIExvZyBpbmRpdmlkdWFsIGNoZWNrIHJlc3VsdHNcbiAgICAgICAgZm9yIChjb25zdCBjaGVjayBvZiByZXN1bHQuY2hlY2tzKSB7XG4gICAgICAgICAgY29uc3QgY2hlY2tFbW9qaSA9IGNoZWNrLnBhc3NlZCA/IFwiXHUyNzEzXCIgOiBjaGVjay5ibG9ja2luZyA/IFwiXHUyNzE3XCIgOiBcIlx1MjZBMFwiO1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgYGdzZC1wcmUtZXhlYzogICAke2NoZWNrRW1vaml9IFske2NoZWNrLmNhdGVnb3J5fV0gJHtjaGVjay50YXJnZXR9OiAke2NoZWNrLm1lc3NhZ2V9XFxuYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gV3JpdGUgZXZpZGVuY2UgSlNPTiB0byBzbGljZSBhcnRpZmFjdHMgZGlyZWN0b3J5XG4gICAgICAgIGNvbnN0IHNsaWNlUGF0aCA9IHJlc29sdmVTbGljZVBhdGgocHJlRXhlY3V0aW9uQmFzZVBhdGgsIG1pZCwgc2lkKTtcbiAgICAgICAgY29uc3QgZXZpZGVuY2VGaWxlTmFtZSA9IGAke3NpZH0tUFJFLUVYRUMtVkVSSUZZLmpzb25gO1xuICAgICAgICBsZXQgZXZpZGVuY2VQYXRoID0gam9pbihcIi5nc2RcIiwgXCJtaWxlc3RvbmVzXCIsIG1pZCwgXCJzbGljZXNcIiwgc2lkLCBldmlkZW5jZUZpbGVOYW1lKTtcbiAgICAgICAgaWYgKHNsaWNlUGF0aCkge1xuICAgICAgICAgIHdyaXRlUHJlRXhlY3V0aW9uRXZpZGVuY2UocmVzdWx0LCBzbGljZVBhdGgsIG1pZCwgc2lkKTtcbiAgICAgICAgICBldmlkZW5jZVBhdGggPSByZWxhdGl2ZShwcmVFeGVjdXRpb25CYXNlUGF0aCwgam9pbihzbGljZVBhdGgsIGV2aWRlbmNlRmlsZU5hbWUpKSB8fCBldmlkZW5jZUZpbGVOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHVva0ZsYWdzLmdhdGVzKSB7XG4gICAgICAgICAgY29uc3QgZmFpbGVkQ2hlY2tzID0gcmVzdWx0LmNoZWNrc1xuICAgICAgICAgICAgLmZpbHRlcigoY2hlY2spID0+ICFjaGVjay5wYXNzZWQpXG4gICAgICAgICAgICAubWFwKChjaGVjaykgPT4gYFske2NoZWNrLmNhdGVnb3J5fV0gJHtjaGVjay50YXJnZXR9OiAke2NoZWNrLm1lc3NhZ2V9YCk7XG4gICAgICAgICAgY29uc3Qgd2FybkVzY2FsYXRlZCA9IHJlc3VsdC5zdGF0dXMgPT09IFwid2FyblwiICYmIHN0cmljdE1vZGU7XG4gICAgICAgICAgY29uc3QgYmxvY2tpbmdGYWlsdXJlID0gcmVzdWx0LnN0YXR1cyA9PT0gXCJmYWlsXCIgfHwgd2FybkVzY2FsYXRlZDtcbiAgICAgICAgICBjb25zdCBnYXRlUnVubmVyID0gbmV3IFVva0dhdGVSdW5uZXIoKTtcbiAgICAgICAgICBnYXRlUnVubmVyLnJlZ2lzdGVyKHtcbiAgICAgICAgICAgIGlkOiBcInByZS1leGVjdXRpb24tY2hlY2tzXCIsXG4gICAgICAgICAgICB0eXBlOiBcImlucHV0XCIsXG4gICAgICAgICAgICBleGVjdXRlOiBhc3luYyAoKSA9PiAoe1xuICAgICAgICAgICAgICBvdXRjb21lOiBibG9ja2luZ0ZhaWx1cmUgPyBcImZhaWxcIiA6IFwicGFzc1wiLFxuICAgICAgICAgICAgICBmYWlsdXJlQ2xhc3M6IHJlc3VsdC5zdGF0dXMgPT09IFwiZmFpbFwiID8gXCJpbnB1dFwiIDogd2FybkVzY2FsYXRlZCA/IFwicG9saWN5XCIgOiBcIm5vbmVcIixcbiAgICAgICAgICAgICAgcmF0aW9uYWxlOiBibG9ja2luZ0ZhaWx1cmVcbiAgICAgICAgICAgICAgICA/IGBwcmUtZXhlY3V0aW9uIGNoZWNrcyAke3Jlc3VsdC5zdGF0dXN9JHt3YXJuRXNjYWxhdGVkID8gXCIgKHN0cmljdClcIiA6IFwiXCJ9YFxuICAgICAgICAgICAgICAgIDogXCJwcmUtZXhlY3V0aW9uIGNoZWNrcyBwYXNzZWRcIixcbiAgICAgICAgICAgICAgZmluZGluZ3M6IGZhaWxlZENoZWNrcy5qb2luKFwiXFxuXCIpLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYXdhaXQgZ2F0ZVJ1bm5lci5ydW4oXCJwcmUtZXhlY3V0aW9uLWNoZWNrc1wiLCB7XG4gICAgICAgICAgICBiYXNlUGF0aDogcy5iYXNlUGF0aCxcbiAgICAgICAgICAgIHRyYWNlSWQ6IGBwcmUtZXhlY3V0aW9uOiR7Y3VycmVudFVuaXQuaWR9YCxcbiAgICAgICAgICAgIHR1cm5JZDogY3VycmVudFVuaXQuaWQsXG4gICAgICAgICAgICBtaWxlc3RvbmVJZDogbWlkLFxuICAgICAgICAgICAgc2xpY2VJZDogc2lkLFxuICAgICAgICAgICAgdW5pdFR5cGU6IGN1cnJlbnRVbml0LnR5cGUsXG4gICAgICAgICAgICB1bml0SWQ6IGN1cnJlbnRVbml0LmlkLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gTm90aWZ5IFVJIFx1MjAxNCBzdXJmYWNlIGFjdGlvbmFibGUgZGV0YWlscyAoIzQyNTkpXG4gICAgICAgIGlmIChyZXN1bHQuc3RhdHVzID09PSBcImZhaWxcIikge1xuICAgICAgICAgIGNvbnN0IGJsb2NraW5nQ2hlY2tzID0gcmVzdWx0LmNoZWNrcy5maWx0ZXIoYyA9PiAhYy5wYXNzZWQgJiYgYy5ibG9ja2luZyk7XG4gICAgICAgICAgY29uc3QgYmxvY2tpbmdDb3VudCA9IGJsb2NraW5nQ2hlY2tzLmxlbmd0aDtcbiAgICAgICAgICBjb25zdCBkZXRhaWxzID0gYmxvY2tpbmdDaGVja3Muc2xpY2UoMCwgTUFYX05PVElGSUNBVElPTl9ERVRBSUxTKS5tYXAoZm9ybWF0UHJlRXhlY3V0aW9uQ2hlY2tEZXRhaWwpLmpvaW4oXCJcXG5cIik7XG4gICAgICAgICAgY29uc3Qgc3VmZml4ID0gYmxvY2tpbmdDaGVja3MubGVuZ3RoID4gTUFYX05PVElGSUNBVElPTl9ERVRBSUxTXG4gICAgICAgICAgICA/IGBcXG4gICR7Tk9USUZJQ0FUSU9OX0JVTExFVH0gLi4uYW5kICR7YmxvY2tpbmdDaGVja3MubGVuZ3RoIC0gTUFYX05PVElGSUNBVElPTl9ERVRBSUxTfSBtb3JlYFxuICAgICAgICAgICAgOiBcIlwiO1xuICAgICAgICAgIGNvbnN0IGV2aWRlbmNlTm90ZSA9IGBcXG5TZWUgJHtldmlkZW5jZVBhdGh9IGZvciBmdWxsIGRldGFpbHMuYDtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYFByZS1leGVjdXRpb24gY2hlY2tzIGZhaWxlZDogJHtibG9ja2luZ0NvdW50fSBibG9ja2luZyBpc3N1ZSR7YmxvY2tpbmdDb3VudCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gZm91bmRcXG4ke2RldGFpbHN9JHtzdWZmaXh9JHtldmlkZW5jZU5vdGV9YCxcbiAgICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgICApO1xuICAgICAgICAgIC8vIFBlcnNpc3QgZmFpbHVyZSBjb250ZXh0IHNvIHRoZSBuZXh0IHBsYW4tc2xpY2UgcmUtZGlzcGF0Y2ggY2FuIGluamVjdFxuICAgICAgICAgIC8vIGl0IGludG8gdGhlIHByb21wdCBhbmQgYnJlYWsgdGhlIGluZmluaXRlIGxvb3AgKCM0NTUxKS5cbiAgICAgICAgICBzLmxhc3RQcmVFeGVjRmFpbHVyZSA9IHtcbiAgICAgICAgICAgIHVuaXRJZDogY3VycmVudFVuaXQuaWQsXG4gICAgICAgICAgICBibG9ja2luZ0ZpbmRpbmdzOiBibG9ja2luZ0NoZWNrcy5tYXAoXG4gICAgICAgICAgICAgIGMgPT4gYFske2MuY2F0ZWdvcnl9XSAke2MudGFyZ2V0fTogJHtjLm1lc3NhZ2V9YCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICB2ZXJkaWN0RXhjZXJwdDogYHN0YXR1cz0ke3Jlc3VsdC5zdGF0dXN9OyAke2Jsb2NraW5nQ291bnR9IGJsb2NraW5nIGlzc3VlJHtibG9ja2luZ0NvdW50ID09PSAxID8gXCJcIiA6IFwic1wifSBkZXRlY3RlZGAsXG4gICAgICAgICAgfTtcbiAgICAgICAgICAvLyBUcmFjayBjb25zZWN1dGl2ZSBwcmUtZXhlYyBmYWlsdXJlcyBwZXIgc2xpY2UgZm9yIGxvb3AgZGV0ZWN0aW9uLlxuICAgICAgICAgIGNvbnN0IHJldHJ5S2V5ID0gY3VycmVudFVuaXQuaWQ7XG4gICAgICAgICAgcy5wcmVFeGVjUmV0cnlDb3VudC5zZXQocmV0cnlLZXksIChzLnByZUV4ZWNSZXRyeUNvdW50LmdldChyZXRyeUtleSkgPz8gMCkgKyAxKTtcbiAgICAgICAgICBwcmVFeGVjUGF1c2VOZWVkZWQgPSB0cnVlO1xuICAgICAgICB9IGVsc2UgaWYgKHJlc3VsdC5zdGF0dXMgPT09IFwid2FyblwiKSB7XG4gICAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICAgIGBQcmUtZXhlY3V0aW9uIGNoZWNrcyBwYXNzZWQgd2l0aCB3YXJuaW5nc2AsXG4gICAgICAgICAgICBcIndhcm5pbmdcIixcbiAgICAgICAgICApO1xuICAgICAgICAgIC8vIFN0cmljdCBtb2RlOiB0cmVhdCB3YXJuaW5ncyBhcyBibG9ja2luZ1xuICAgICAgICAgIGlmIChwcmVmcz8uZW5oYW5jZWRfdmVyaWZpY2F0aW9uX3N0cmljdCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgY29uc3Qgd2FybkNoZWNrcyA9IHJlc3VsdC5jaGVja3MuZmlsdGVyKGMgPT4gIWMucGFzc2VkKTtcbiAgICAgICAgICAgIHMubGFzdFByZUV4ZWNGYWlsdXJlID0ge1xuICAgICAgICAgICAgICB1bml0SWQ6IGN1cnJlbnRVbml0LmlkLFxuICAgICAgICAgICAgICBibG9ja2luZ0ZpbmRpbmdzOiB3YXJuQ2hlY2tzLm1hcChcbiAgICAgICAgICAgICAgICBjID0+IGBbJHtjLmNhdGVnb3J5fV0gJHtjLnRhcmdldH06ICR7Yy5tZXNzYWdlfWAsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIHZlcmRpY3RFeGNlcnB0OiBgc3RhdHVzPSR7cmVzdWx0LnN0YXR1c30gKHN0cmljdCBtb2RlKTsgJHt3YXJuQ2hlY2tzLmxlbmd0aH0gd2FybmluZyR7d2FybkNoZWNrcy5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9IHRyZWF0ZWQgYXMgYmxvY2tpbmdgLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGNvbnN0IHJldHJ5S2V5ID0gY3VycmVudFVuaXQuaWQ7XG4gICAgICAgICAgICBzLnByZUV4ZWNSZXRyeUNvdW50LnNldChyZXRyeUtleSwgKHMucHJlRXhlY1JldHJ5Q291bnQuZ2V0KHJldHJ5S2V5KSA/PyAwKSArIDEpO1xuICAgICAgICAgICAgcHJlRXhlY1BhdXNlTmVlZGVkID0gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBSZXNldCB0aGUgcmV0cnkgY291bnRlciB3aGVuIGNoZWNrcyBwYXNzIFx1MjAxNCBhIHN1Y2Nlc3NmdWwgcmUtcGxhblxuICAgICAgICAvLyBzaG91bGQgbm90IGNhcnJ5IG92ZXIgYSBzdGFsZSBmYWlsdXJlIGNvdW50IGludG8gZnV0dXJlIHNsaWNlcy5cbiAgICAgICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09IFwicGFzc1wiKSB7XG4gICAgICAgICAgcy5wcmVFeGVjUmV0cnlDb3VudC5kZWxldGUoY3VycmVudFVuaXQuaWQpO1xuICAgICAgICB9XG5cbiAgICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFBvc3RWZXJpZmljYXRpb25cIiwge1xuICAgICAgICAgIHBoYXNlOiBcInByZS1leGVjdXRpb24tY2hlY2tzXCIsXG4gICAgICAgICAgc3RhdHVzOiByZXN1bHQuc3RhdHVzLFxuICAgICAgICAgIGNoZWNrQ291bnQ6IHJlc3VsdC5jaGVja3MubGVuZ3RoLFxuICAgICAgICAgIGR1cmF0aW9uTXM6IHJlc3VsdC5kdXJhdGlvbk1zLFxuICAgICAgICB9KTtcbiAgICAgIH0gY2F0Y2ggKHByZUV4ZWNFcnJvcikge1xuICAgICAgICAvLyBGYWlsLWNsb3NlZDogaWYgcnVuUHJlRXhlY3V0aW9uQ2hlY2tzIHRocm93cywgcGF1c2UgYXV0by1tb2RlIGluc3RlYWQgb2Ygc2lsZW50bHkgY29udGludWluZ1xuICAgICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSBwcmVFeGVjRXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IHByZUV4ZWNFcnJvci5tZXNzYWdlIDogU3RyaW5nKHByZUV4ZWNFcnJvcik7XG4gICAgICAgIGRlYnVnTG9nKFwicG9zdFVuaXRQb3N0VmVyaWZpY2F0aW9uXCIsIHtcbiAgICAgICAgICBwaGFzZTogXCJwcmUtZXhlY3V0aW9uLWNoZWNrc1wiLFxuICAgICAgICAgIGVycm9yOiBlcnJvck1lc3NhZ2UsXG4gICAgICAgICAgZmFpbENsb3NlZDogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGxvZ0Vycm9yKFwiZW5naW5lXCIsIGBnc2QtcHJlLWV4ZWM6IFByZS1leGVjdXRpb24gY2hlY2tzIHRocmV3IGFuIGVycm9yOiAke2Vycm9yTWVzc2FnZX1gKTtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgICBgUHJlLWV4ZWN1dGlvbiBjaGVja3MgZXJyb3I6ICR7ZXJyb3JNZXNzYWdlfSBcdTIwMTQgcGF1c2luZyBmb3IgaHVtYW4gcmV2aWV3YCxcbiAgICAgICAgICBcImVycm9yXCIsXG4gICAgICAgICk7XG4gICAgICAgIGlmICh1b2tGbGFncy5nYXRlcyAmJiBzLmN1cnJlbnRVbml0KSB7XG4gICAgICAgICAgY29uc3QgeyBtaWxlc3RvbmU6IG1pZCwgc2xpY2U6IHNpZCB9ID0gcGFyc2VVbml0SWQocy5jdXJyZW50VW5pdC5pZCk7XG4gICAgICAgICAgY29uc3QgZ2F0ZVJ1bm5lciA9IG5ldyBVb2tHYXRlUnVubmVyKCk7XG4gICAgICAgICAgZ2F0ZVJ1bm5lci5yZWdpc3Rlcih7XG4gICAgICAgICAgICBpZDogXCJwcmUtZXhlY3V0aW9uLWNoZWNrc1wiLFxuICAgICAgICAgICAgdHlwZTogXCJpbnB1dFwiLFxuICAgICAgICAgICAgZXhlY3V0ZTogYXN5bmMgKCkgPT4gKHtcbiAgICAgICAgICAgICAgb3V0Y29tZTogXCJtYW51YWwtYXR0ZW50aW9uXCIsXG4gICAgICAgICAgICAgIGZhaWx1cmVDbGFzczogXCJtYW51YWwtYXR0ZW50aW9uXCIsXG4gICAgICAgICAgICAgIHJhdGlvbmFsZTogXCJwcmUtZXhlY3V0aW9uIGNoZWNrcyB0aHJldyBiZWZvcmUgY29tcGxldGlvblwiLFxuICAgICAgICAgICAgICBmaW5kaW5nczogZXJyb3JNZXNzYWdlLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgYXdhaXQgZ2F0ZVJ1bm5lci5ydW4oXCJwcmUtZXhlY3V0aW9uLWNoZWNrc1wiLCB7XG4gICAgICAgICAgICBiYXNlUGF0aDogcy5iYXNlUGF0aCxcbiAgICAgICAgICAgIHRyYWNlSWQ6IGBwcmUtZXhlY3V0aW9uOiR7cy5jdXJyZW50VW5pdC5pZH1gLFxuICAgICAgICAgICAgdHVybklkOiBzLmN1cnJlbnRVbml0LmlkLFxuICAgICAgICAgICAgbWlsZXN0b25lSWQ6IG1pZCA/PyB1bmRlZmluZWQsXG4gICAgICAgICAgICBzbGljZUlkOiBzaWQgPz8gdW5kZWZpbmVkLFxuICAgICAgICAgICAgdW5pdFR5cGU6IHMuY3VycmVudFVuaXQudHlwZSxcbiAgICAgICAgICAgIHVuaXRJZDogcy5jdXJyZW50VW5pdC5pZCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICBwcmVFeGVjUGF1c2VOZWVkZWQgPSB0cnVlO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gQ2hlY2sgZm9yIGJsb2NraW5nIGZhaWx1cmVzIGFmdGVyIHJ1blNhZmVseSBjb21wbGV0ZXNcbiAgICBpZiAocHJlRXhlY1BhdXNlTmVlZGVkKSB7XG4gICAgICBkZWJ1Z0xvZyhcInBvc3RVbml0UG9zdFZlcmlmaWNhdGlvblwiLCB7IHBoYXNlOiBcInByZS1leGVjdXRpb24tY2hlY2tzXCIsIHBhdXNpbmc6IHRydWUsIHJlYXNvbjogXCJibG9ja2luZyBmYWlsdXJlcyBkZXRlY3RlZFwiIH0pO1xuICAgICAgYXdhaXQgcGF1c2VBdXRvKGN0eCwgcGkpO1xuICAgICAgcmV0dXJuIFwic3RvcHBlZFwiO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBUcmlhZ2UgY2hlY2sgXHUyNTAwXHUyNTAwXG4gIGlmIChfc2hvdWxkRGlzcGF0Y2hUcmlhZ2VGb3JUZXN0KHMpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGlmIChoYXNQZW5kaW5nQ2FwdHVyZXMocy5iYXNlUGF0aCkpIHtcbiAgICAgICAgY29uc3QgcGVuZGluZyA9IGxvYWRQZW5kaW5nQ2FwdHVyZXMocy5iYXNlUGF0aCk7XG4gICAgICAgIGlmIChwZW5kaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjb25zdCByZWFkUm9vdCA9IHMuY2Fub25pY2FsUHJvamVjdFJvb3Q7XG4gICAgICAgICAgY29uc3Qgc3RhdGUgPSBhd2FpdCBkZXJpdmVTdGF0ZShyZWFkUm9vdCk7XG4gICAgICAgICAgY29uc3QgbWlkID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lPy5pZDtcbiAgICAgICAgICBjb25zdCBzaWQgPSBzdGF0ZS5hY3RpdmVTbGljZT8uaWQ7XG5cbiAgICAgICAgICBpZiAobWlkICYmIHNpZCkge1xuICAgICAgICAgICAgbGV0IGN1cnJlbnRQbGFuID0gXCJcIjtcbiAgICAgICAgICAgIGxldCByb2FkbWFwQ29udGV4dCA9IFwiXCI7XG4gICAgICAgICAgICBjb25zdCBwbGFuRmlsZSA9IHJlc29sdmVTbGljZUZpbGUocmVhZFJvb3QsIG1pZCwgc2lkLCBcIlBMQU5cIik7XG4gICAgICAgICAgICBpZiAocGxhbkZpbGUpIGN1cnJlbnRQbGFuID0gKGF3YWl0IGxvYWRGaWxlKHBsYW5GaWxlKSkgPz8gXCJcIjtcbiAgICAgICAgICAgIGNvbnN0IHJvYWRtYXBGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUocmVhZFJvb3QsIG1pZCwgXCJST0FETUFQXCIpO1xuICAgICAgICAgICAgaWYgKHJvYWRtYXBGaWxlKSByb2FkbWFwQ29udGV4dCA9IChhd2FpdCBsb2FkRmlsZShyb2FkbWFwRmlsZSkpID8/IFwiXCI7XG5cbiAgICAgICAgICAgIGNvbnN0IGNhcHR1cmVzTGlzdCA9IHBlbmRpbmcubWFwKGMgPT5cbiAgICAgICAgICAgICAgYC0gKioke2MuaWR9Kio6IFwiJHtjLnRleHR9XCIgKGNhcHR1cmVkOiAke2MudGltZXN0YW1wfSlgXG4gICAgICAgICAgICApLmpvaW4oXCJcXG5cIik7XG5cbiAgICAgICAgICAgIGNvbnN0IHByb21wdCA9IGxvYWRQcm9tcHQoXCJ0cmlhZ2UtY2FwdHVyZXNcIiwge1xuICAgICAgICAgICAgICBwZW5kaW5nQ2FwdHVyZXM6IGNhcHR1cmVzTGlzdCxcbiAgICAgICAgICAgICAgY3VycmVudFBsYW46IGN1cnJlbnRQbGFuIHx8IFwiKG5vIGFjdGl2ZSBzbGljZSBwbGFuKVwiLFxuICAgICAgICAgICAgICByb2FkbWFwQ29udGV4dDogcm9hZG1hcENvbnRleHQgfHwgXCIobm8gYWN0aXZlIHJvYWRtYXApXCIsXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHMuY3VycmVudFVuaXQpIHtcbiAgICAgICAgICAgICAgYXdhaXQgY2xvc2VvdXRVbml0KGN0eCwgcy5iYXNlUGF0aCwgcy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkLCBzLmN1cnJlbnRVbml0LnN0YXJ0ZWRBdCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHRyaWFnZVVuaXRJZCA9IGAke21pZH0vJHtzaWR9L3RyaWFnZWA7XG4gICAgICAgICAgICByZXR1cm4gZW5xdWV1ZVNpZGVjYXIoXG4gICAgICAgICAgICAgIHMsIGN0eCxcbiAgICAgICAgICAgICAgeyBraW5kOiBcInRyaWFnZVwiLCB1bml0VHlwZTogXCJ0cmlhZ2UtY2FwdHVyZXNcIiwgdW5pdElkOiB0cmlhZ2VVbml0SWQsIHByb21wdCB9LFxuICAgICAgICAgICAgICB7IHBlbmRpbmdDb3VudDogcGVuZGluZy5sZW5ndGggfSxcbiAgICAgICAgICAgICAgYFRyaWFnaW5nICR7cGVuZGluZy5sZW5ndGh9IHBlbmRpbmcgY2FwdHVyZSR7cGVuZGluZy5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9Li4uYCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcInRyaWFnZS1jaGVja1wiLCBlcnJvcjogU3RyaW5nKGUpIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBRdWljay10YXNrIGRpc3BhdGNoIFx1MjUwMFx1MjUwMFxuICBpZiAoX3Nob3VsZERpc3BhdGNoUXVpY2tUYXNrRm9yVGVzdChzKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBjYXB0dXJlID0gcy5wZW5kaW5nUXVpY2tUYXNrcy5zaGlmdCgpITtcbiAgICAgIGNvbnN0IHsgYnVpbGRRdWlja1Rhc2tQcm9tcHQgfSA9IGF3YWl0IGltcG9ydChcIi4vdHJpYWdlLXJlc29sdXRpb24uanNcIik7XG4gICAgICBjb25zdCB7IG1hcmtDYXB0dXJlRXhlY3V0ZWQgfSA9IGF3YWl0IGltcG9ydChcIi4vY2FwdHVyZXMuanNcIik7XG4gICAgICBjb25zdCBwcm9tcHQgPSBidWlsZFF1aWNrVGFza1Byb21wdChjYXB0dXJlKTtcblxuICAgICAgaWYgKHMuY3VycmVudFVuaXQpIHtcbiAgICAgICAgYXdhaXQgY2xvc2VvdXRVbml0KGN0eCwgcy5iYXNlUGF0aCwgcy5jdXJyZW50VW5pdC50eXBlLCBzLmN1cnJlbnRVbml0LmlkLCBzLmN1cnJlbnRVbml0LnN0YXJ0ZWRBdCk7XG4gICAgICB9XG5cbiAgICAgIG1hcmtDYXB0dXJlRXhlY3V0ZWQocy5iYXNlUGF0aCwgY2FwdHVyZS5pZCk7XG5cbiAgICAgIGNvbnN0IHF0VW5pdElkID0gYCR7cy5jdXJyZW50TWlsZXN0b25lSWR9LyR7Y2FwdHVyZS5pZH1gO1xuICAgICAgcmV0dXJuIGVucXVldWVTaWRlY2FyKFxuICAgICAgICBzLCBjdHgsXG4gICAgICAgIHsga2luZDogXCJxdWljay10YXNrXCIsIHVuaXRUeXBlOiBcInF1aWNrLXRhc2tcIiwgdW5pdElkOiBxdFVuaXRJZCwgcHJvbXB0LCBjYXB0dXJlSWQ6IGNhcHR1cmUuaWQgfSxcbiAgICAgICAgeyBjYXB0dXJlSWQ6IGNhcHR1cmUuaWQgfSxcbiAgICAgICAgYEV4ZWN1dGluZyBxdWljay10YXNrOiAke2NhcHR1cmUuaWR9IFx1MjAxNCBcIiR7Y2FwdHVyZS50ZXh0fVwiYCxcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcInF1aWNrLXRhc2stZGlzcGF0Y2hcIiwgZXJyb3I6IFN0cmluZyhlKSB9KTtcbiAgICB9XG4gIH1cblxuICAvLyBTdGVwIG1vZGUgXHUyMTkyIHNob3cgd2l6YXJkIGluc3RlYWQgb2YgZGlzcGF0Y2guXG4gIC8vIFdpdGhvdXQgdGhpcyBub3RpZnkoKSwgL2dzZCBpbiBzdGVwIG1vZGUgZmluaXNoZXMgYSB1bml0IGFuZCBzaWxlbnRseVxuICAvLyBleGl0cyB0aGUgbG9vcCwgbGVhdmluZyB0aGUgdXNlciB3aXRoIG5vIGhpbnQgdG8gL2NsZWFyIGFuZCAvZ3NkIGFnYWluLlxuICBpZiAocy5zdGVwTW9kZSkge1xuICAgIGxldCBwaGFzZUFmdGVyVW5pdDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG5leHRTdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKHMuY2Fub25pY2FsUHJvamVjdFJvb3QpO1xuICAgICAgcGhhc2VBZnRlclVuaXQgPSBuZXh0U3RhdGUucGhhc2U7XG4gICAgICBjdHgudWkubm90aWZ5KGJ1aWxkU3RlcENvbXBsZXRlTWVzc2FnZShuZXh0U3RhdGUpLCBcImluZm9cIik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZGVidWdMb2coXCJwb3N0VW5pdFwiLCB7IHBoYXNlOiBcInN0ZXAtd2l6YXJkLW5vdGlmeVwiLCBlcnJvcjogU3RyaW5nKGUpIH0pO1xuICAgICAgY3R4LnVpLm5vdGlmeShTVEVQX0NPTVBMRVRFX0ZBTExCQUNLX01FU1NBR0UsIFwiaW5mb1wiKTtcbiAgICB9XG4gICAgcmV0dXJuIHNob3VsZFJldHVyblN0ZXBXaXphcmRBZnRlclVuaXQocy5jdXJyZW50VW5pdD8udHlwZSwgcGhhc2VBZnRlclVuaXQpXG4gICAgICA/IFwic3RlcC13aXphcmRcIlxuICAgICAgOiBcImNvbnRpbnVlXCI7XG4gIH1cblxuICByZXR1cm4gXCJjb250aW51ZVwiO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBZ0JBLFNBQVMsbUJBQW1CO0FBQzVCLFNBQVMsWUFBWSxnQkFBZ0I7QUFDckMsU0FBUyxVQUFVLGNBQWMsMkJBQTJCO0FBQzVE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USxVQUFVLFFBQVEsV0FBVyxRQUFRLEdBQUc7QUFBQSxRQUM5RixFQUFFLFdBQVcsUUFBUSxHQUFHO0FBQUEsUUFDeEIseUJBQXlCLFFBQVEsRUFBRSxZQUFPLFFBQVEsSUFBSTtBQUFBLE1BQ3hEO0FBQUEsSUFDRixTQUFTLEdBQUc7QUFDVixlQUFTLFlBQVksRUFBRSxPQUFPLHVCQUF1QixPQUFPLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxJQUN6RTtBQUFBLEVBQ0Y7QUFLQSxNQUFJLEVBQUUsVUFBVTtBQUNkLFFBQUksaUJBQWdDO0FBQ3BDLFFBQUk7QUFDRixZQUFNLFlBQVksTUFBTSxZQUFZLEVBQUUsb0JBQW9CO0FBQzFELHVCQUFpQixVQUFVO0FBQzNCLFVBQUksR0FBRyxPQUFPLHlCQUF5QixTQUFTLEdBQUcsTUFBTTtBQUFBLElBQzNELFNBQVMsR0FBRztBQUNWLGVBQVMsWUFBWSxFQUFFLE9BQU8sc0JBQXNCLE9BQU8sT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUN0RSxVQUFJLEdBQUcsT0FBTyxnQ0FBZ0MsTUFBTTtBQUFBLElBQ3REO0FBQ0EsV0FBTyxnQ0FBZ0MsRUFBRSxhQUFhLE1BQU0sY0FBYyxJQUN0RSxnQkFDQTtBQUFBLEVBQ047QUFFQSxTQUFPO0FBQ1Q7IiwKICAibmFtZXMiOiBbImlzQXdhaXRpbmdVc2VySW5wdXQiLCAic3RvcEF1dG8iLCAibG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzIl0KfQo=
