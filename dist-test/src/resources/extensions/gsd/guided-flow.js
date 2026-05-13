import { showNextAction } from "../shared/tui.js";
import { loadFile, saveFile } from "./files.js";
import { isDbAvailable, getMilestone, getMilestoneSlices } from "./gsd-db.js";
import { parseRoadmapSlices } from "./roadmap-slices.js";
import { loadPrompt, inlineTemplate } from "./prompt-loader.js";
import {
  buildCompleteSlicePrompt,
  buildDiscussMilestonePrompt,
  buildExecuteTaskPrompt,
  buildPlanMilestonePrompt,
  buildPlanSlicePrompt,
  buildSkillActivationBlock
} from "./auto-prompts.js";
import { deriveState, isGhostMilestone } from "./state.js";
import { invalidateAllCaches } from "./cache.js";
import { startAutoDetached } from "./auto.js";
import { clearLock } from "./crash-recovery.js";
import {
  assessInterruptedSession,
  formatInterruptedSessionRunningMessage,
  formatInterruptedSessionSummary
} from "./interrupted-session.js";
import { listUnitRuntimeRecords, clearUnitRuntimeRecord, isInFlightRuntimePhase } from "./unit-runtime.js";
import { resolveExpectedArtifactPath } from "./auto.js";
import { gsdHome } from "./gsd-home.js";
import {
  gsdRoot,
  milestonesDir,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveSlicePath,
  resolveGsdRootFile,
  relGsdRootFile,
  relMilestoneFile,
  relSliceFile,
  clearPathCache
} from "./paths.js";
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { readSessionLockData, isSessionLockProcessAlive } from "./session-lock.js";
import { nativeAddAll, nativeCommit, nativeHasCommittedHead, nativeIsRepo, nativeInit } from "./native-git-bridge.js";
import { isInheritedRepo } from "./repo-identity.js";
import { ensureGitignore, ensurePreferences, untrackRuntimeFiles } from "./gitignore.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { resolveUokFlags } from "./uok/flags.js";
import { ensurePlanV2Graph, isMissingFinalizedContextResult } from "./uok/plan-v2.js";
import { detectProjectState, hasGsdBootstrapArtifacts } from "./detection.js";
import { showProjectInit, offerMigration } from "./init-wizard.js";
import { validateDirectory } from "./validate-directory.js";
import { showConfirm } from "../shared/tui.js";
import { debugLog } from "./debug-logger.js";
import { findMilestoneIds, clearReservedMilestoneIds } from "./milestone-ids.js";
import { nextMilestoneIdReserved } from "./milestone-id-reservation.js";
import { nextMilestoneIdReserved as nextMilestoneIdReserved2 } from "./milestone-id-reservation.js";
import { parkMilestone, discardMilestone } from "./milestone-actions.js";
import { selectAndApplyModel } from "./auto-model-selection.js";
import { DISCUSS_TOOLS_ALLOWLIST } from "./constants.js";
import {
  getWorkflowTransportSupportError,
  getRequiredWorkflowToolsForGuidedUnit,
  supportsStructuredQuestions
} from "./workflow-mcp.js";
import {
  runPreparation,
  formatCodebaseBrief,
  formatPriorContextBrief
} from "./preparation.js";
import { verifyExpectedArtifact } from "./auto-recovery.js";
import { createWorkspace, scopeMilestone } from "./workspace.js";
import { getPendingGate, extractDepthVerificationMilestoneId } from "./bootstrap/write-gate.js";
function shouldSkipGitBootstrapAfterInit(result) {
  return result.gitEnabled === false;
}
import {
  MILESTONE_ID_RE,
  generateMilestoneSuffix,
  nextMilestoneId,
  extractMilestoneSeq,
  parseMilestoneId,
  milestoneIdSort,
  maxMilestoneNum,
  findMilestoneIds as findMilestoneIds2,
  reserveMilestoneId,
  claimReservedId,
  getReservedMilestoneIds,
  clearReservedMilestoneIds as clearReservedMilestoneIds2
} from "./milestone-ids.js";
import {
  showQueue,
  handleQueueReorder,
  showQueueAdd,
  buildExistingMilestonesContext
} from "./guided-flow-queue.js";
import { logWarning } from "./workflow-logger.js";
import { deleteRuntimeKv } from "./db/runtime-kv.js";
import { PAUSED_SESSION_KV_KEY } from "./interrupted-session.js";
import { buildWorkflowDispatchContent } from "./workflow-protocol.js";
import { isFullGsdToolSurfaceRequested, restoreGsdWorkflowTools, scopeGsdWorkflowToolsForDispatch } from "./bootstrap/register-hooks.js";
function scheduleAutoStartAfterIdle(ctx, pi, basePath, verboseMode, options, launch = startAutoDetached) {
  const waitForIdle = typeof ctx.waitForIdle === "function" ? ctx.waitForIdle.bind(ctx) : async () => {
  };
  void waitForIdle().then(() => {
    setTimeout(() => launch(ctx, pi, basePath, verboseMode, options), 0);
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Auto-start failed while waiting for the prior turn to settle: ${message}`, "error");
    logWarning("guided", `auto-start idle wait failed: ${message}`);
  });
}
const _scheduleAutoStartAfterIdleForTest = scheduleAutoStartAfterIdle;
function verifyExpectedArtifactForScope(scope, unitType, unitId) {
  return verifyExpectedArtifact(unitType, unitId, scope.workspace.projectRoot);
}
function resolveExpectedArtifactPathForScope(scope, unitType, unitId) {
  return resolveExpectedArtifactPath(unitType, unitId, scope.workspace.projectRoot);
}
async function runQuickTaskChoice(ctx, pi) {
  if (!ctx.hasUI) {
    ctx.ui.notify("Run /gsd quick <task> for small bounded work, or /gsd do <task> for natural-language routing.", "info");
    return;
  }
  const task = (await ctx.ui.input("Quick task", "Describe the small task to run with /gsd quick"))?.trim();
  if (!task) {
    ctx.ui.notify("Quick task cancelled.", "info");
    return;
  }
  const { handleQuick } = await import("./quick.js");
  await handleQuick(task, ctx, pi);
}
function isGhostMilestoneByScope(scope) {
  return isGhostMilestone(scope.workspace.projectRoot, scope.milestoneId);
}
function needsPlanV2Gate(state) {
  return state.phase === "executing" || state.phase === "summarizing" || state.phase === "validating-milestone" || state.phase === "completing-milestone";
}
function runPlanV2Gate(ctx, basePath, state) {
  const prefs = loadEffectiveGSDPreferences(basePath)?.preferences;
  const uokFlags = resolveUokFlags(prefs);
  if (!uokFlags.planV2 || !needsPlanV2Gate(state)) return "pass";
  const compiled = ensurePlanV2Graph(basePath, state);
  if (!compiled.ok) {
    if (isMissingFinalizedContextResult(compiled)) {
      return "recover-missing-context";
    }
    const reason = compiled.reason ?? "plan-v2 compilation failed";
    ctx.ui.notify(
      `Plan gate failed-closed: ${reason}. Complete plan/discuss artifacts before execution.

If this keeps happening, try: /gsd doctor heal`,
      "error"
    );
    return "block";
  }
  return "pass";
}
const _needsPlanV2GateForTest = needsPlanV2Gate;
const _runPlanV2GateForTest = runPlanV2Gate;
function _roadmapHasParseableSlicesForTest(roadmapContent) {
  if (!roadmapContent) return false;
  return parseRoadmapSlices(roadmapContent).length > 0;
}
function buildDocsCommitInstruction(_message) {
  return "Do not commit planning artifacts \u2014 .gsd/ is managed externally.";
}
const MAX_READY_REJECTS = 2;
const MAX_PLAN_BLOCKED_RECOVERIES = 3;
const READY_PHRASE_RE = /\bMilestone\s+M\d{3}[A-Z0-9-]*\s+ready\.?/i;
const pendingAutoStartMap = /* @__PURE__ */ new Map();
const pendingDeepProjectSetupMap = /* @__PURE__ */ new Map();
const USER_DRIVEN_DEEP_SETUP_UNITS = /* @__PURE__ */ new Set([
  "discuss-project",
  "discuss-requirements",
  "research-decision"
]);
const FOREGROUND_DEEP_SETUP_RULE_NAMES = /* @__PURE__ */ new Set([
  "deep: pre-planning (no workflow prefs) \u2192 workflow-preferences",
  "deep: pre-planning (no PROJECT) \u2192 discuss-project",
  "deep: pre-planning (no REQUIREMENTS) \u2192 discuss-requirements",
  "deep: pre-planning (no research decision) \u2192 research-decision"
]);
const LEGACY_DEEP_SETUP_PSEUDO_MILESTONE_DIRS = /* @__PURE__ */ new Set([
  "PROJECT",
  "REQUIREMENTS",
  "RESEARCH-DECISION",
  "RESEARCH-PROJECT",
  "WORKFLOW-PREFS"
]);
const FOREGROUND_DEEP_SETUP_QUESTION_POLICY = `## Foreground Deep Setup Question Policy

This stage is running inside the foreground \`/gsd new-project --deep\` interview. Ask user questions in plain chat only.

- Do NOT call \`ask_user_questions\`, \`AskUserQuestion\`, or ToolSearch to discover user-input tools.
- Ask one focused round, then stop and wait for the user's normal chat response.`;
function _getPendingAutoStart(basePath) {
  if (basePath) return pendingAutoStartMap.get(basePath) ?? null;
  if (pendingAutoStartMap.size === 1) return pendingAutoStartMap.values().next().value;
  return null;
}
function hasNestedFileOrSymlink(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() || entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && hasNestedFileOrSymlink(join(dir, entry.name))) return true;
  }
  return false;
}
function clearEmptyLegacyDeepSetupPseudoMilestones(basePath, entries) {
  const mDir = milestonesDir(basePath);
  const remaining = [];
  for (const entry of entries) {
    if (!LEGACY_DEEP_SETUP_PSEUDO_MILESTONE_DIRS.has(entry)) {
      remaining.push(entry);
      continue;
    }
    const entryPath = join(mDir, entry);
    try {
      if (hasNestedFileOrSymlink(entryPath)) {
        remaining.push(entry);
        continue;
      }
      rmSync(entryPath, { recursive: true, force: true });
      logWarning("guided", `Self-heal: removed empty legacy deep setup pseudo-milestone directory ${entry}`);
    } catch (err) {
      remaining.push(entry);
      logWarning("guided", `legacy deep setup pseudo-milestone cleanup failed for ${entry}: ${err.message}`);
    }
  }
  return remaining;
}
function setPendingAutoStart(basePath, entry) {
  const ws = createWorkspace(entry.basePath);
  const scope = scopeMilestone(ws, entry.milestoneId);
  pendingAutoStartMap.set(basePath, { createdAt: Date.now(), planBlockedRecoveryCount: 0, ...entry, scope });
}
function clearPendingAutoStart(basePath) {
  if (basePath) {
    pendingAutoStartMap.delete(basePath);
  } else {
    pendingAutoStartMap.clear();
  }
}
function clearPendingDeepProjectSetup(basePath) {
  if (basePath) {
    pendingDeepProjectSetupMap.delete(basePath);
  } else {
    pendingDeepProjectSetupMap.clear();
  }
}
function getDiscussionMilestoneId(basePath) {
  if (basePath) {
    return pendingAutoStartMap.get(basePath)?.milestoneId ?? null;
  }
  if (pendingAutoStartMap.size === 1) {
    return pendingAutoStartMap.values().next().value.milestoneId;
  }
  return null;
}
function _getPendingDeepProjectSetup(basePath) {
  if (basePath) return pendingDeepProjectSetupMap.get(basePath) ?? null;
  if (pendingDeepProjectSetupMap.size === 1) return pendingDeepProjectSetupMap.values().next().value;
  return null;
}
function getDeepSetupSessionId(ctx) {
  return ctx?.sessionManager?.getSessionId?.();
}
function _getPendingDeepProjectSetupForContext(ctx, basePath) {
  if (basePath) {
    const direct = pendingDeepProjectSetupMap.get(basePath);
    if (direct) return direct;
  }
  if (!ctx) return _getPendingDeepProjectSetup();
  const sessionId = getDeepSetupSessionId(ctx);
  if (sessionId) {
    const matches2 = [...pendingDeepProjectSetupMap.values()].filter((entry) => entry.sessionId === sessionId);
    if (matches2.length === 1) return matches2[0];
  }
  const matches = [...pendingDeepProjectSetupMap.values()].filter((entry) => entry.ctx === ctx);
  return matches.length === 1 ? matches[0] : null;
}
function getPendingDeepProjectSetupUnitForContext(ctx, basePath) {
  const entry = _getPendingDeepProjectSetupForContext(ctx, basePath);
  if (!entry?.currentUnitType || !entry.currentUnitId) return null;
  return {
    unitType: entry.currentUnitType,
    unitId: entry.currentUnitId
  };
}
async function startDeepProjectSetupForeground(ctx, pi, basePath, step) {
  const entry = {
    ctx,
    pi,
    basePath,
    step,
    createdAt: Date.now(),
    sessionId: getDeepSetupSessionId(ctx)
  };
  pendingDeepProjectSetupMap.set(basePath, entry);
  await dispatchNextDeepProjectSetupStage(entry);
}
async function checkDeepProjectSetupAfterTurn(_event, ctx, basePath) {
  const entry = _getPendingDeepProjectSetupForContext(ctx, basePath);
  if (!entry) return false;
  if (entry.currentUnitType && entry.currentUnitId) {
    const artifactReady = verifyExpectedArtifact(entry.currentUnitType, entry.currentUnitId, entry.basePath);
    if (!artifactReady) {
      return false;
    }
  }
  const pendingGateId = getPendingGate(entry.basePath);
  if (pendingGateId) {
    return false;
  }
  return dispatchNextDeepProjectSetupStage(entry);
}
async function dispatchNextDeepProjectSetupStage(entry) {
  invalidateAllCaches();
  const prefs = loadEffectiveGSDPreferences(entry.basePath)?.preferences;
  const { DISPATCH_RULES, hasPendingDeepStage } = await import("./auto-dispatch.js");
  if (!hasPendingDeepStage(prefs, entry.basePath)) {
    pendingDeepProjectSetupMap.delete(entry.basePath);
    scheduleAutoStartAfterIdle(entry.ctx, entry.pi, entry.basePath, false, { step: entry.step });
    return true;
  }
  const state = await deriveState(entry.basePath);
  const dispatchCtx = {
    basePath: entry.basePath,
    mid: "PROJECT",
    midTitle: "Project setup",
    state,
    prefs,
    // Claude Code currently surfaces workflow-MCP question calls as tool-request
    // UI that can be cancelled outside the normal chat flow. During the
    // foreground deep project setup interview, keep user input in plain chat so
    // `/gsd new-project --deep` cannot bounce through cancelled tool requests.
    structuredQuestionsAvailable: "false"
  };
  let result = null;
  for (const rule of DISPATCH_RULES) {
    if (!FOREGROUND_DEEP_SETUP_RULE_NAMES.has(rule.name)) continue;
    result = await rule.match(dispatchCtx);
    if (result) break;
  }
  if (!result || result.action !== "dispatch") {
    if (result?.action === "stop") {
      entry.ctx.ui.notify(result.reason, result.level);
    } else if (hasPendingDeepStage(prefs, entry.basePath)) {
      pendingDeepProjectSetupMap.delete(entry.basePath);
      scheduleAutoStartAfterIdle(entry.ctx, entry.pi, entry.basePath, false, { step: entry.step });
      return true;
    }
    return false;
  }
  if (!USER_DRIVEN_DEEP_SETUP_UNITS.has(result.unitType)) {
    pendingDeepProjectSetupMap.delete(entry.basePath);
    scheduleAutoStartAfterIdle(entry.ctx, entry.pi, entry.basePath, false, { step: entry.step });
    return true;
  }
  entry.currentUnitType = result.unitType;
  entry.currentUnitId = result.unitId;
  entry.createdAt = Date.now();
  await dispatchWorkflow(
    entry.pi,
    `${result.prompt}

${FOREGROUND_DEEP_SETUP_QUESTION_POLICY}`,
    "gsd-run",
    entry.ctx,
    result.unitType
  );
  return true;
}
function checkAutoStartAfterDiscuss() {
  const entry = _getPendingAutoStart();
  if (!entry) return false;
  const { ctx, pi, basePath, milestoneId, step } = entry;
  const contextFilePath = entry.scope.contextFile();
  const roadmapFilePath = entry.scope.roadmapFile();
  const contextFile = existsSync(contextFilePath) ? contextFilePath : null;
  const roadmapFile = existsSync(roadmapFilePath) ? roadmapFilePath : null;
  if (!contextFile && !roadmapFile) return false;
  const basePathForGate = entry.scope.workspace.projectRoot;
  const pendingGateId = getPendingGate(basePathForGate);
  if (pendingGateId) {
    const pendingMilestoneId = extractDepthVerificationMilestoneId(pendingGateId);
    const isProjectGate = pendingGateId === "depth_verification_project_confirm" || pendingGateId === "depth_verification_requirements_confirm" || pendingGateId === "depth_verification_research_decision_confirm";
    if (pendingMilestoneId === milestoneId || isProjectGate) {
      return false;
    }
  }
  if (isDbAvailable()) {
    const dbRow = getMilestone(milestoneId);
    if (dbRow?.status === "queued" && contextFile) {
      if (entry.planBlockedRecoveryCount >= MAX_PLAN_BLOCKED_RECOVERIES) {
        logWarning(
          "guided",
          `Gate 1b: milestone ${milestoneId} plan-blocked recovery limit reached (${entry.planBlockedRecoveryCount}/${MAX_PLAN_BLOCKED_RECOVERIES}); escalating to user`
        );
        ctx.ui.notify(
          `Milestone ${milestoneId} plan_milestone has been blocked ${entry.planBlockedRecoveryCount} times. Re-run /gsd to reset the recovery counter, or run /gsd-debug to diagnose without resetting.`,
          "error"
        );
        return false;
      }
      logWarning(
        "guided",
        `Gate 1b: milestone ${milestoneId} queued with CONTEXT.md present \u2014 plan_milestone was blocked; emitting recovery hint (attempt ${entry.planBlockedRecoveryCount + 1}/${MAX_PLAN_BLOCKED_RECOVERIES})`
      );
      ctx.ui.notify(
        `Milestone ${milestoneId}: context file exists but milestone is still queued. Retrying gsd_plan_milestone to complete the blocked planning step.`,
        "warning"
      );
      try {
        pi.sendMessage(
          {
            customType: "gsd-plan-milestone-blocked-recovery",
            content: `Milestone ${milestoneId} has ${contextFile} on disk but its DB row is still "queued". The gsd_plan_milestone tool was previously blocked by the depth-verification gate. Call gsd_plan_milestone now to complete the planning phase.`,
            display: false
          },
          { triggerTurn: true }
        );
        entry.planBlockedRecoveryCount += 1;
      } catch (e) {
        logWarning("guided", `Gate 1b recovery sendMessage failed: ${e.message}`);
      }
      return false;
    }
  }
  const stateFilePath = entry.scope.stateFile();
  if (!existsSync(stateFilePath)) return false;
  const projectFile = resolveGsdRootFile(basePath, "PROJECT");
  let projectIds = [];
  if (projectFile) {
    try {
      const projectContent = readFileSync(projectFile, "utf-8");
      projectIds = parseMilestoneSequenceFromProject(projectContent);
      if (projectIds.length > 1) {
        const missing = projectIds.filter((id) => {
          const hasContext = !!resolveMilestoneFile(basePath, id, "CONTEXT");
          const hasDraft = !!resolveMilestoneFile(basePath, id, "CONTEXT-DRAFT");
          const hasDir = existsSync(join(gsdRoot(basePath), "milestones", id));
          return !hasContext && !hasDraft && !hasDir;
        });
        if (missing.length > 0) {
          ctx.ui.notify(
            `Multi-milestone validation: ${missing.join(", ")} not found in filesystem. Discussion may not have completed all readiness gates.`,
            "warning"
          );
        }
      }
    } catch (e) {
      logWarning("guided", `PROJECT.md parsing failed: ${e.message}`);
    }
  }
  const manifestPath = join(entry.scope.workspace.contract.projectGsd, "DISCUSSION-MANIFEST.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const total = typeof manifest.total === "number" ? manifest.total : 0;
      const completed = typeof manifest.gates_completed === "number" ? manifest.gates_completed : 0;
      if (total > 1 && completed < total) {
        return false;
      }
      if (projectIds.length > 0) {
        const manifestIds = Object.keys(manifest.milestones ?? {});
        const untracked = projectIds.filter((id) => !manifestIds.includes(id));
        if (untracked.length > 0) {
          ctx.ui.notify(
            `Discussion manifest missing gates for: ${untracked.join(", ")}`,
            "warning"
          );
        }
      }
    } catch (e) {
      logWarning("guided", `discussion manifest verification failed: ${e.message}`);
    }
  }
  try {
    const draftFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT-DRAFT");
    if (draftFile) unlinkSync(draftFile);
  } catch (e) {
    logWarning("guided", `CONTEXT-DRAFT.md unlink failed: ${e.message}`);
  }
  if (existsSync(manifestPath)) {
    try {
      unlinkSync(manifestPath);
    } catch (e) {
      logWarning("guided", `manifest unlink failed: ${e.message}`);
    }
  }
  if (isDbAvailable()) {
    const milestoneRow = getMilestone(milestoneId);
    if (!milestoneRow) {
      ctx.ui.notify(
        `Milestone ${milestoneId}: discuss artifacts on disk but no DB row exists. PROJECT.md may have failed to register milestones. Re-save PROJECT.md with canonical "- [ ] M001: Title \u2014 One-liner" lines, then re-run /gsd to recover.`,
        "error"
      );
      return false;
    }
  }
  pendingAutoStartMap.delete(basePath);
  ctx.ui.notify(`Milestone ${milestoneId} ready.`, "success");
  scheduleAutoStartAfterIdle(ctx, pi, basePath, false, { step });
  return true;
}
function extractAssistantText(msg) {
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}
function hasToolUse(msg) {
  if (!msg) return false;
  const content = msg.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && typeof b === "object" && (b.type === "toolCall" || b.type === "serverToolUse")
  );
}
function maybeHandleReadyPhraseWithoutFiles(event) {
  const entry = _getPendingAutoStart();
  if (!entry) return false;
  const { ctx, pi, basePath, milestoneId } = entry;
  const lastMsg = event.messages[event.messages.length - 1];
  const text = extractAssistantText(lastMsg);
  if (!READY_PHRASE_RE.test(text)) return false;
  clearPathCache();
  const contextFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
  const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  if (contextFile || roadmapFile) return false;
  try {
    const mDir = resolveMilestonePath(basePath, milestoneId);
    const canonicalCtx = mDir ? join(mDir, `${milestoneId}-CONTEXT.md`) : null;
    const canonicalRoadmap = mDir ? join(mDir, `${milestoneId}-ROADMAP.md`) : null;
    logWarning(
      "guided",
      `ready-phrase-reject diagnostic mid=${milestoneId} basePath=${basePath} mDir=${mDir ?? "null"} canonical-ctx=${canonicalCtx ?? "null"} ctx-exists=${canonicalCtx ? existsSync(canonicalCtx) : "n/a"} canonical-roadmap=${canonicalRoadmap ?? "null"} roadmap-exists=${canonicalRoadmap ? existsSync(canonicalRoadmap) : "n/a"}`
    );
  } catch (e) {
    logWarning("guided", `ready-phrase-reject diagnostic failed: ${e.message}`);
  }
  entry.readyRejectCount = (entry.readyRejectCount ?? 0) + 1;
  if (entry.readyRejectCount > MAX_READY_REJECTS) {
    pendingAutoStartMap.delete(basePath);
    ctx.ui.notify(
      `Milestone ${milestoneId}: LLM signaled "ready" ${entry.readyRejectCount} times without writing files. Stopping auto-nudge. Run /gsd to try again.`,
      "error"
    );
    return true;
  }
  const contextRel = relMilestoneFile(basePath, milestoneId, "CONTEXT");
  const roadmapRel = relMilestoneFile(basePath, milestoneId, "ROADMAP");
  ctx.ui.notify(
    `Milestone ${milestoneId}: "ready" signal rejected \u2014 ${contextRel} and ${roadmapRel} are missing. Asking the LLM to complete the writes.`,
    "warning"
  );
  const nudge = `You emitted "Milestone ${milestoneId} ready." but neither ${contextRel} nor ${roadmapRel} exists on disk. The ready phrase is a POST-WRITE signal and has been rejected. In this turn: (1) write PROJECT.md, REQUIREMENTS.md, and the milestone CONTEXT.md, (2) call gsd_plan_milestone, then (3) emit the ready phrase. Do not describe these steps \u2014 execute them as tool calls. This is retry ${entry.readyRejectCount}/${MAX_READY_REJECTS}; further premature signals will clear the session.`;
  try {
    pi.sendMessage(
      { customType: "gsd-ready-no-files", content: nudge, display: false },
      { triggerTurn: true }
    );
  } catch (e) {
    logWarning("guided", `ready-phrase nudge sendMessage failed: ${e.message}`);
    return false;
  }
  return true;
}
const emptyTurnCounterByBase = /* @__PURE__ */ new Map();
const MAX_EMPTY_TURN_RETRIES = 2;
const COMMIT_INTENT_RE = /\b(?:I['’]ll|I will|Next,? I['’]ll|Now I['’]ll|Let me|I['’]m going to|I am going to)\s+(?:now\s+)?(?:write|create|call|invoke|update|add|run|execute|generate|produce|emit|compose|implement|save|apply|commit)\b/i;
function resetEmptyTurnCounter(basePath) {
  if (basePath) emptyTurnCounterByBase.delete(basePath);
  else emptyTurnCounterByBase.clear();
}
function maybeHandleEmptyIntentTurn(event, isAuto) {
  if (!isAuto && pendingAutoStartMap.size === 0) return false;
  const lastMsg = event.messages[event.messages.length - 1];
  if (!lastMsg) return false;
  if (hasToolUse(lastMsg)) return false;
  const text = extractAssistantText(lastMsg).trim();
  if (!text) return false;
  if (READY_PHRASE_RE.test(text)) return false;
  if (/\?(?:\s|$)/.test(text)) return false;
  if (!COMMIT_INTENT_RE.test(text)) return false;
  const entry = _getPendingAutoStart();
  if (!entry) return false;
  const { ctx, pi, basePath } = entry;
  const count = (emptyTurnCounterByBase.get(basePath) ?? 0) + 1;
  emptyTurnCounterByBase.set(basePath, count);
  if (count > MAX_EMPTY_TURN_RETRIES) {
    ctx.ui.notify(
      `Empty-turn recovery: LLM announced intent ${count} times without calling any tool. Stopping auto-nudge.`,
      "error"
    );
    return false;
  }
  ctx.ui.notify(
    `Empty-turn detected: LLM announced intent but called no tool. Prompting it to execute.`,
    "info"
  );
  const nudge = `Your last turn announced an action (e.g. "I'll write\u2026" or "Let me call\u2026") but contained no tool call. The system records zero tool-use blocks for that turn. Execute the announced action NOW as a tool call in this turn. Do not describe it again. Retry ${count}/${MAX_EMPTY_TURN_RETRIES}.`;
  try {
    pi.sendMessage(
      { customType: "gsd-empty-turn-recovery", content: nudge, display: false },
      { triggerTurn: true }
    );
  } catch (e) {
    logWarning("guided", `empty-turn nudge sendMessage failed: ${e.message}`);
    return false;
  }
  return true;
}
function parseMilestoneSequenceFromProject(content) {
  const ids = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\|\s*(M\d{3}[A-Z0-9-]*)\s*\|/);
    if (match) ids.push(match[1]);
  }
  return ids;
}
async function dispatchWorkflow(pi, note, customType = "gsd-run", ctx, unitType) {
  if (ctx && unitType) {
    const prefs = loadEffectiveGSDPreferences()?.preferences;
    const result = await selectAndApplyModel(
      ctx,
      pi,
      unitType,
      /* unitId */
      "",
      /* basePath */
      process.cwd(),
      prefs,
      /* verbose */
      false,
      /* autoModeStartModel */
      null,
      /* retryContext */
      void 0,
      /* isAutoMode */
      false
    );
    if (result.appliedModel) {
      debugLog("guided-flow-model-applied", {
        unitType,
        model: `${result.appliedModel.provider}/${result.appliedModel.id}`,
        routing: result.routing
      });
    }
    const compatibilityError = getWorkflowTransportSupportError(
      result.appliedModel?.provider ?? ctx.model?.provider,
      getRequiredWorkflowToolsForGuidedUnit(unitType),
      {
        projectRoot: process.cwd(),
        surface: "guided flow",
        unitType,
        authMode: result.appliedModel?.provider ? ctx.modelRegistry.getProviderAuthMode(result.appliedModel.provider) : ctx.model?.provider ? ctx.modelRegistry.getProviderAuthMode(ctx.model.provider) : void 0,
        baseUrl: result.appliedModel?.baseUrl ?? ctx.model?.baseUrl
      }
    );
    if (compatibilityError) {
      ctx.ui.notify(compatibilityError, "error");
      return;
    }
  }
  let savedTools = null;
  try {
    const currentTools = pi.getActiveTools();
    savedTools = {
      tools: currentTools,
      visibleSkills: typeof pi.getVisibleSkills === "function" ? pi.getVisibleSkills() : void 0,
      restoreVisibleSkills: typeof pi.setVisibleSkills === "function"
    };
    if (unitType?.startsWith("discuss-") && !isFullGsdToolSurfaceRequested()) {
      const scopedTools = currentTools.filter(
        (t) => !t.startsWith("gsd_") || DISCUSS_TOOLS_ALLOWLIST.includes(t)
      );
      pi.setActiveTools(scopedTools);
      const scopedState = scopeGsdWorkflowToolsForDispatch(pi, unitType);
      savedTools = {
        tools: currentTools,
        visibleSkills: scopedState?.visibleSkills ?? savedTools.visibleSkills,
        restoreVisibleSkills: scopedState?.restoreVisibleSkills ?? savedTools.restoreVisibleSkills
      };
      debugLog("discuss-tool-scoping", {
        unitType,
        before: currentTools.length,
        after: pi.getActiveTools().length,
        removed: currentTools.length - pi.getActiveTools().length
      });
    } else {
      savedTools = scopeGsdWorkflowToolsForDispatch(pi, unitType) ?? savedTools;
    }
    const workflowPath = process.env.GSD_WORKFLOW_PATH ?? join(gsdHome(), "agent", "GSD-WORKFLOW.md");
    const workflow = readFileSync(workflowPath, "utf-8");
    pi.sendMessage(
      {
        customType,
        content: buildWorkflowDispatchContent({ workflow, workflowPath, task: note }),
        display: false
      },
      { triggerTurn: true }
    );
  } finally {
    restoreGsdWorkflowTools(pi, savedTools);
  }
}
const _dispatchWorkflowForTest = dispatchWorkflow;
function getStructuredQuestionsAvailability(pi, ctx) {
  if (!ctx) return "false";
  const provider = ctx.model?.provider;
  const authMode = provider ? ctx.modelRegistry.getProviderAuthMode(provider) : void 0;
  return supportsStructuredQuestions(pi.getActiveTools(), {
    authMode,
    baseUrl: ctx.model?.baseUrl
  }) ? "true" : "false";
}
function resolveAvailableModel(modelId, availableModels, currentProvider) {
  const slashIdx = modelId.indexOf("/");
  if (slashIdx !== -1) {
    const maybeProvider = modelId.substring(0, slashIdx);
    const id = modelId.substring(slashIdx + 1);
    const knownProviders = new Set(availableModels.map((m) => m.provider.toLowerCase()));
    if (knownProviders.has(maybeProvider.toLowerCase())) {
      const match = availableModels.find(
        (m) => m.provider.toLowerCase() === maybeProvider.toLowerCase() && m.id.toLowerCase() === id.toLowerCase()
      );
      if (match) return match;
    }
    const lower = modelId.toLowerCase();
    return availableModels.find(
      (m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower
    );
  }
  const exactProviderMatch = availableModels.find(
    (m) => m.id === modelId && m.provider === currentProvider
  );
  return exactProviderMatch ?? availableModels.find((m) => m.id === modelId);
}
function buildDiscussPrompt(nextId, preamble, _basePath, pi, ctx, preparationContext) {
  const milestoneRel = `.gsd/milestones/${nextId}`;
  const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
  const inlinedTemplates = [
    inlineTemplate("project", "Project"),
    inlineTemplate("requirements", "Requirements"),
    inlineTemplate("context", "Context"),
    inlineTemplate("roadmap", "Roadmap"),
    inlineTemplate("decisions", "Decisions")
  ].join("\n\n---\n\n");
  return loadPrompt("discuss", {
    milestoneId: nextId,
    preamble,
    preparationContext: preparationContext ?? "",
    structuredQuestionsAvailable,
    contextPath: `${milestoneRel}/${nextId}-CONTEXT.md`,
    roadmapPath: `${milestoneRel}/${nextId}-ROADMAP.md`,
    inlinedTemplates,
    commitInstruction: buildDocsCommitInstruction(`docs(${nextId}): context, requirements, and roadmap`),
    multiMilestoneCommitInstruction: buildDocsCommitInstruction("docs: project plan \u2014 N milestones")
  });
}
function buildHeadlessDiscussPrompt(nextId, seedContext, _basePath) {
  const milestoneRel = `.gsd/milestones/${nextId}`;
  const inlinedTemplates = [
    inlineTemplate("project", "Project"),
    inlineTemplate("requirements", "Requirements"),
    inlineTemplate("context", "Context"),
    inlineTemplate("roadmap", "Roadmap"),
    inlineTemplate("decisions", "Decisions")
  ].join("\n\n---\n\n");
  return loadPrompt("discuss-headless", {
    milestoneId: nextId,
    seedContext,
    contextPath: `${milestoneRel}/${nextId}-CONTEXT.md`,
    roadmapPath: `${milestoneRel}/${nextId}-ROADMAP.md`,
    inlinedTemplates,
    commitInstruction: buildDocsCommitInstruction(`docs(${nextId}): context, requirements, and roadmap`),
    multiMilestoneCommitInstruction: buildDocsCommitInstruction("docs: project plan \u2014 N milestones")
  });
}
async function prepareAndBuildDiscussPrompt(ctx, pi, nextId, preamble, basePath) {
  const prefs = loadEffectiveGSDPreferences()?.preferences ?? {};
  let preparationContext = "";
  if (prefs.discuss_preparation !== false) {
    try {
      const prepResult = await runPreparation(basePath, ctx.ui, {
        discuss_preparation: prefs.discuss_preparation,
        discuss_web_research: prefs.discuss_web_research,
        discuss_depth: prefs.discuss_depth
      });
      if (prepResult.enabled) {
        const codebaseBrief = prepResult.codebaseBrief || formatCodebaseBrief(prepResult.codebase);
        const priorContextBrief = prepResult.priorContextBrief || formatPriorContextBrief(prepResult.priorContext);
        const parts = [];
        if (codebaseBrief) parts.push(`### Codebase Brief

${codebaseBrief}`);
        if (priorContextBrief) parts.push(`### Prior Context Brief

${priorContextBrief}`);
        if (parts.length > 0) {
          preparationContext = `

## Preparation Context

The system analyzed the codebase before this discussion. Use these findings as background context \u2014 they describe what already exists, NOT what the user wants to build. Always ask the user what they want to build first.

${parts.join("\n\n")}`;
        }
      }
    } catch (err) {
      logWarning("guided", `preparation failed, proceeding without context: ${err.message}`);
    }
  }
  return buildDiscussPrompt(nextId, preamble, basePath, pi, ctx, preparationContext);
}
function bootstrapGsdProject(basePath) {
  if (!nativeIsRepo(basePath) || isInheritedRepo(basePath)) {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    nativeInit(basePath, mainBranch);
  }
  const root = gsdRoot(basePath);
  mkdirSync(join(root, "milestones"), { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });
  ensureGitignore(basePath);
  ensurePreferences(basePath);
  untrackRuntimeFiles(basePath);
}
async function showHeadlessMilestoneCreation(ctx, pi, basePath, seedContext) {
  clearReservedMilestoneIds();
  bootstrapGsdProject(basePath);
  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  await ensureDbOpen(basePath);
  const existingIds = findMilestoneIds(basePath);
  const prefs = loadEffectiveGSDPreferences();
  const nextId = nextMilestoneIdReserved(existingIds, prefs?.preferences?.unique_milestone_ids ?? false, basePath);
  const prompt = buildHeadlessDiscussPrompt(nextId, seedContext, basePath);
  setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId });
  await dispatchWorkflow(pi, prompt, "gsd-run", ctx, "discuss-milestone");
}
async function buildDiscussSlicePrompt(mid, sid, sTitle, base, options) {
  const inlined = [];
  const roadmapPath = resolveMilestoneFile(base, mid, "ROADMAP");
  const roadmapRel = relMilestoneFile(base, mid, "ROADMAP");
  const roadmapContent = roadmapPath ? await loadFile(roadmapPath) : null;
  if (roadmapContent) {
    inlined.push(`### Milestone Roadmap
Source: \`${roadmapRel}\`

${roadmapContent.trim()}`);
  }
  const contextPath = resolveMilestoneFile(base, mid, "CONTEXT");
  const contextRel = relMilestoneFile(base, mid, "CONTEXT");
  const contextContent = contextPath ? await loadFile(contextPath) : null;
  if (contextContent) {
    inlined.push(`### Milestone Context
Source: \`${contextRel}\`

${contextContent.trim()}`);
  }
  const researchPath = resolveMilestoneFile(base, mid, "RESEARCH");
  const researchRel = relMilestoneFile(base, mid, "RESEARCH");
  const researchContent = researchPath ? await loadFile(researchPath) : null;
  if (researchContent) {
    inlined.push(`### Milestone Research
Source: \`${researchRel}\`

${researchContent.trim()}`);
  }
  const decisionsPath = resolveGsdRootFile(base, "DECISIONS");
  if (existsSync(decisionsPath)) {
    const decisionsContent = await loadFile(decisionsPath);
    if (decisionsContent) {
      inlined.push(`### Decisions Register
Source: \`${relGsdRootFile("DECISIONS")}\`

${decisionsContent.trim()}`);
    }
  }
  {
    const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
    await ensureDbOpen();
    let normSlices = [];
    if (isDbAvailable()) {
      normSlices = getMilestoneSlices(mid).map((s) => ({ id: s.id, done: s.status === "complete" }));
    }
    for (const s of normSlices) {
      if (!s.done || s.id === sid) continue;
      const summaryPath = resolveSliceFile(base, mid, s.id, "SUMMARY");
      const summaryRel = relSliceFile(base, mid, s.id, "SUMMARY");
      const summaryContent = summaryPath ? await loadFile(summaryPath) : null;
      if (summaryContent) {
        inlined.push(`### ${s.id} Summary (completed)
Source: \`${summaryRel}\`

${summaryContent.trim()}`);
      }
    }
  }
  const inlinedContext = inlined.length > 0 ? `## Inlined Context (preloaded \u2014 do not re-read these files)

${inlined.join("\n\n---\n\n")}` : `## Inlined Context

_(no context files found yet \u2014 go in blind and ask broad questions)_`;
  const sliceDirPath = `.gsd/milestones/${mid}/slices/${sid}`;
  const sliceContextPath = `${sliceDirPath}/${sid}-CONTEXT.md`;
  const rediscussPreamble = options?.rediscuss ? `

## Re-discuss Mode

This slice already has an existing context file (\`${sliceContextPath}\`) from a prior discussion. The user has chosen to re-discuss it. Read the existing context file, interview for any updates, changes, or new decisions, and rewrite the file with merged findings. Do NOT skip the interview \u2014 the user explicitly asked to revisit this slice.
` : "";
  const inlinedTemplates = inlineTemplate("slice-context", "Slice Context");
  return loadPrompt("guided-discuss-slice", {
    milestoneId: mid,
    sliceId: sid,
    sliceTitle: sTitle,
    inlinedContext: inlinedContext + rediscussPreamble,
    sliceDirPath,
    contextPath: sliceContextPath,
    projectRoot: base,
    inlinedTemplates,
    structuredQuestionsAvailable: options?.structuredQuestionsAvailable ?? "false",
    commitInstruction: buildDocsCommitInstruction(`docs(${mid}/${sid}): slice context from discuss`)
  });
}
async function showDiscuss(ctx, pi, basePath) {
  if (!existsSync(gsdRoot(basePath))) {
    ctx.ui.notify("No GSD project found. Run /gsd to start one first.", "warning");
    return;
  }
  invalidateAllCaches();
  const state = await deriveState(basePath);
  try {
    const { buildStateMarkdown } = await import("./doctor.js");
    await saveFile(resolveGsdRootFile(basePath, "STATE"), buildStateMarkdown(state));
  } catch (err) {
    logWarning("guided", `STATE.md rebuild failed: ${err.message}`);
  }
  if (!state.activeMilestone?.id) {
    const pendingMilestones = state.registry.filter((m) => m.status === "pending");
    if (pendingMilestones.length === 0) {
      ctx.ui.notify("No active milestone. Run /gsd to create one first.", "warning");
      return;
    }
    await showDiscussQueuedMilestone(ctx, pi, basePath, pendingMilestones);
    return;
  }
  const mid = state.activeMilestone.id;
  const milestoneTitle = state.activeMilestone.title;
  if (state.phase === "needs-discussion") {
    const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
    const draftContent = draftFile ? await loadFile(draftFile) : null;
    const choice = await showNextAction(ctx, {
      title: `GSD \u2014 ${mid}: ${milestoneTitle}`,
      summary: ["This milestone has a draft context from a prior discussion.", "It needs a dedicated discussion before auto-planning can begin."],
      actions: [
        {
          id: "discuss_draft",
          label: "Discuss from draft",
          description: "Continue where the prior discussion left off \u2014 seed material is loaded automatically.",
          recommended: true
        },
        {
          id: "discuss_fresh",
          label: "Start fresh discussion",
          description: "Discard the draft and start a new discussion from scratch."
        },
        {
          id: "skip_milestone",
          label: "Skip \u2014 create new milestone",
          description: "Leave this milestone as-is and start something new."
        }
      ],
      notYetMessage: "Run /gsd discuss when ready to discuss this milestone."
    });
    if (choice === "discuss_draft") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      const basePrompt = loadPrompt("guided-discuss-milestone", {
        workingDirectory: basePath,
        milestoneId: mid,
        milestoneTitle,
        inlinedTemplates: discussMilestoneTemplates,
        structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
        fastPathInstruction: ""
      });
      const seed = draftContent ? `${basePrompt}

## Prior Discussion (Draft Seed)

${draftContent}` : basePrompt;
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: mid, step: false });
      await dispatchWorkflow(pi, seed, "gsd-discuss", ctx, "discuss-milestone");
    } else if (choice === "discuss_fresh") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: mid, step: false });
      await dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
        workingDirectory: basePath,
        milestoneId: mid,
        milestoneTitle,
        inlinedTemplates: discussMilestoneTemplates,
        structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
        fastPathInstruction: ""
      }), "gsd-discuss", ctx, "discuss-milestone");
    } else if (choice === "skip_milestone") {
      const { ensureDbOpen: ensureDbOpen2 } = await import("./bootstrap/dynamic-tools.js");
      await ensureDbOpen2(basePath);
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId, step: false });
      await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(ctx, pi, nextId, `New milestone ${nextId}.`, basePath), "gsd-run", ctx, "discuss-milestone");
    }
    return;
  }
  const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
  await ensureDbOpen();
  const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
  if (!roadmapContent && !isDbAvailable()) {
    ctx.ui.notify("No roadmap yet for this milestone. Run /gsd to plan first.", "warning");
    return;
  }
  let normSlices;
  if (isDbAvailable()) {
    normSlices = getMilestoneSlices(mid).map((s) => ({ id: s.id, done: s.status === "complete", title: s.title }));
  } else {
    normSlices = [];
  }
  if (normSlices.length === 0 && roadmapContent) {
    normSlices = parseRoadmapSlices(roadmapContent).map((s) => ({ id: s.id, done: s.done, title: s.title }));
  }
  const pendingSlices = normSlices.filter((s) => !s.done);
  if (pendingSlices.length === 0) {
    const pendingMilestones = state.registry.filter((m) => m.status === "pending");
    if (pendingMilestones.length > 0) {
      await showDiscussQueuedMilestone(ctx, pi, basePath, pendingMilestones);
      return;
    }
    ctx.ui.notify("All slices are complete \u2014 nothing to discuss.", "info");
    return;
  }
  while (true) {
    invalidateAllCaches();
    const discussedMap = /* @__PURE__ */ new Map();
    for (const s of pendingSlices) {
      const contextFile = resolveSliceFile(basePath, mid, s.id, "CONTEXT");
      discussedMap.set(s.id, !!contextFile);
    }
    const allDiscussed = pendingSlices.every((s) => discussedMap.get(s.id));
    if (allDiscussed) {
      const pendingMilestones2 = state.registry.filter((m) => m.status === "pending");
      if (pendingMilestones2.length > 0) {
        await showDiscussQueuedMilestone(ctx, pi, basePath, pendingMilestones2);
        return;
      }
      const lockData = readSessionLockData(basePath);
      const remoteAutoRunning = lockData && lockData.pid !== process.pid && isSessionLockProcessAlive(lockData);
      const nextStep = remoteAutoRunning ? "Auto-mode is already running \u2014 use /gsd status to check progress." : "Run /gsd to start planning.";
      ctx.ui.notify(
        `All ${pendingSlices.length} slices discussed. ${nextStep}`,
        "info"
      );
      return;
    }
    const firstUndiscussedId = pendingSlices.find((s) => !discussedMap.get(s.id))?.id;
    const actions = pendingSlices.map((s) => {
      const discussed = discussedMap.get(s.id) ?? false;
      const statusParts = [];
      if (state.activeSlice?.id === s.id) statusParts.push("active");
      else statusParts.push("upcoming");
      statusParts.push(discussed ? "discussed \u2713" : "not discussed");
      return {
        id: s.id,
        label: `${s.id}: ${s.title}`,
        description: statusParts.join(" \xB7 "),
        recommended: s.id === firstUndiscussedId
      };
    });
    const pendingMilestones = state.registry.filter((m) => m.status === "pending");
    if (pendingMilestones.length > 0) {
      actions.push({
        id: "discuss_queued_milestone",
        label: "Discuss a queued milestone",
        description: `Refine context for ${pendingMilestones.length} queued milestone(s). Does not affect current execution.`,
        recommended: false
      });
    }
    const choice = await showNextAction(ctx, {
      title: "GSD \u2014 Discuss a slice",
      summary: [
        `${mid}: ${milestoneTitle}`,
        "Pick a slice to interview. Context file will be written when done."
      ],
      actions,
      notYetMessage: "Run /gsd discuss when ready."
    });
    if (choice === "not_yet") return;
    if (choice === "discuss_queued_milestone") {
      await showDiscussQueuedMilestone(ctx, pi, basePath, pendingMilestones);
      return;
    }
    const chosen = pendingSlices.find((s) => s.id === choice);
    if (!chosen) return;
    const isRediscuss = discussedMap.get(chosen.id) ?? false;
    if (isRediscuss) {
      const confirm = await showNextAction(ctx, {
        title: `Re-discuss ${chosen.id}?`,
        summary: [
          `${chosen.id} already has a context file from a prior discussion.`,
          "Re-discussing will interview for updates and rewrite the context file."
        ],
        actions: [
          { id: "rediscuss", label: "Re-discuss to update context", description: "Interview for changes and rewrite", recommended: true },
          { id: "cancel", label: "Cancel", description: "Go back to slice picker" }
        ]
      });
      if (confirm !== "rediscuss") continue;
    }
    const sqAvail = getStructuredQuestionsAvailability(pi, ctx);
    const prompt = await buildDiscussSlicePrompt(mid, chosen.id, chosen.title, basePath, { rediscuss: isRediscuss, structuredQuestionsAvailable: sqAvail });
    await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-slice");
    await ctx.waitForIdle();
    invalidateAllCaches();
  }
}
async function showDiscussQueuedMilestone(ctx, pi, basePath, pendingMilestones) {
  const actions = pendingMilestones.map((m, i) => {
    const hasContext = !!resolveMilestoneFile(basePath, m.id, "CONTEXT");
    const hasDraft2 = !hasContext && !!resolveMilestoneFile(basePath, m.id, "CONTEXT-DRAFT");
    const contextStatus = hasContext ? "context \u2713" : hasDraft2 ? "draft context" : "no context yet";
    return {
      id: m.id,
      label: `${m.id}: ${m.title}`,
      description: `[queued] \xB7 ${contextStatus}`,
      recommended: i === 0
    };
  });
  const choice = await showNextAction(ctx, {
    title: "GSD \u2014 Discuss a queued milestone",
    summary: [
      "Select a queued milestone to discuss.",
      "Discussing will update its context file. It will not be activated."
    ],
    actions,
    notYetMessage: "Run /gsd discuss when ready."
  });
  if (choice === "not_yet") return;
  const chosen = pendingMilestones.find((m) => m.id === choice);
  if (!chosen) return;
  const hasDraft = !!resolveMilestoneFile(basePath, chosen.id, "CONTEXT-DRAFT");
  let fastPath = hasDraft;
  if (!hasDraft) {
    const mode = await showNextAction(ctx, {
      title: `Discuss ${chosen.id}`,
      summary: [
        "Choose how to start the discussion.",
        "Fast path skips generic scouting \u2014 use it when you already know the scope."
      ],
      actions: [
        {
          id: "full",
          label: "Full discussion",
          description: "Scout the codebase, ask open-ended questions, explore deeply",
          recommended: true
        },
        {
          id: "fast",
          label: "I have the scope \u2014 fast path",
          description: "Treat your first message as authoritative seed context; skip scouting"
        }
      ],
      notYetMessage: "Run /gsd discuss when ready."
    });
    if (mode === "not_yet") return;
    fastPath = mode === "fast";
  }
  await dispatchDiscussForMilestone(ctx, pi, basePath, chosen.id, chosen.title, { fastPath });
}
async function dispatchDiscussForMilestone(ctx, pi, basePath, mid, milestoneTitle, opts = {}) {
  const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const draftContent = draftFile ? await loadFile(draftFile) : null;
  const hasSeed = !!(draftContent || opts.fastPath);
  const fastPathInstruction = hasSeed ? [
    "> **Fast path active \u2014 scope provided.**",
    "> Do NOT perform a generic codebase scouting pass.",
    "> Do at most 2 targeted reads to check for obvious conflicts with existing work.",
    "> Treat the seed context or the operator's first message as authoritative.",
    "> Move directly to the depth summary and write step.",
    "> Ask only questions where the answer would materially change scope."
  ].join("\n") : "";
  const discussMilestoneTemplates = inlineTemplate("context", "Context");
  const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
  const basePrompt = loadPrompt("guided-discuss-milestone", {
    workingDirectory: basePath,
    milestoneId: mid,
    milestoneTitle,
    inlinedTemplates: discussMilestoneTemplates,
    structuredQuestionsAvailable,
    commitInstruction: buildDocsCommitInstruction(`docs(${mid}): milestone context from discuss`),
    fastPathInstruction
  });
  const prompt = draftContent ? `${basePrompt}

## Prior Discussion (Draft Seed)

${draftContent}` : basePrompt;
  await dispatchWorkflow(pi, prompt, "gsd-discuss", ctx, "discuss-milestone");
}
function selfHealRuntimeRecords(basePath, ctx) {
  try {
    const records = listUnitRuntimeRecords(basePath);
    let cleared = 0;
    for (const record of records) {
      const { unitType, unitId, phase } = record;
      const artifactPath = resolveExpectedArtifactPath(unitType, unitId, basePath);
      if (artifactPath && existsSync(artifactPath)) {
        clearUnitRuntimeRecord(basePath, unitType, unitId);
        cleared++;
        continue;
      }
      if (isInFlightRuntimePhase(phase)) {
        clearUnitRuntimeRecord(basePath, unitType, unitId);
        cleared++;
      }
    }
    if (cleared > 0) {
      ctx.ui.notify(`Self-heal: cleared ${cleared} stale runtime record(s) from a previous session.`, "info");
    }
    return { cleared };
  } catch (e) {
    logWarning("guided", `self-heal stale runtime records failed: ${e.message}`);
    return { cleared: 0 };
  }
}
async function handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options) {
  const stepMode = options?.step;
  const choice = await showNextAction(ctx, {
    title: `Milestone Actions \u2014 ${milestoneId}`,
    summary: [`${milestoneId}: ${milestoneTitle}`],
    actions: [
      {
        id: "park",
        label: "Park milestone",
        description: "Pause this milestone \u2014 it stays on disk but is skipped."
      },
      {
        id: "discard",
        label: "Discard milestone",
        description: "Permanently delete this milestone and all its contents."
      },
      {
        id: "skip",
        label: "Skip \u2014 create new milestone",
        description: "Leave this milestone and start a fresh one."
      },
      {
        id: "back",
        label: "Back",
        description: "Return to the previous menu."
      }
    ],
    notYetMessage: "Run /gsd when ready."
  });
  if (choice === "park") {
    const reason = await showNextAction(ctx, {
      title: `Park ${milestoneId}`,
      summary: ["Why is this milestone being parked?"],
      actions: [
        { id: "priority_shift", label: "Priority shift", description: "Other work is more important right now." },
        { id: "blocked_external", label: "Blocked externally", description: "Waiting on an external dependency or decision." },
        { id: "needs_rethink", label: "Needs rethinking", description: "The approach needs to be reconsidered." }
      ],
      notYetMessage: "Run /gsd when ready."
    });
    if (!reason || reason === "not_yet") return false;
    const reasonText = reason === "priority_shift" ? "Priority shift \u2014 other work is more important" : reason === "blocked_external" ? "Blocked externally \u2014 waiting on external dependency" : reason === "needs_rethink" ? "Needs rethinking \u2014 approach needs reconsideration" : "Parked by user";
    const success = parkMilestone(basePath, milestoneId, reasonText);
    if (success) {
      ctx.ui.notify(`Parked ${milestoneId}. Run /gsd unpark ${milestoneId} to reactivate.`, "info");
    } else {
      ctx.ui.notify(`Could not park ${milestoneId} \u2014 milestone not found or already parked.`, "warning");
    }
    return true;
  }
  if (choice === "discard") {
    const confirmed = await showConfirm(ctx, {
      title: "Discard milestone?",
      message: `This will permanently delete ${milestoneId} and all its contents (roadmap, plans, task summaries).`,
      confirmLabel: "Discard",
      declineLabel: "Cancel"
    });
    if (confirmed) {
      discardMilestone(basePath, milestoneId);
      ctx.ui.notify(`Discarded ${milestoneId}.`, "info");
      return true;
    }
    return false;
  }
  if (choice === "skip") {
    const milestoneIds = findMilestoneIds(basePath);
    const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
    const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
    setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode });
    await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(
      ctx,
      pi,
      nextId,
      `New milestone ${nextId}.`,
      basePath
    ), "gsd-run", ctx, "discuss-milestone");
    return true;
  }
  return false;
}
async function showSmartEntry(ctx, pi, basePath, options) {
  const stepMode = options?.step;
  clearReservedMilestoneIds();
  const dirCheck = validateDirectory(basePath);
  if (dirCheck.severity === "blocked") {
    ctx.ui.notify(dirCheck.reason, "error");
    return;
  }
  if (dirCheck.severity === "warning") {
    const proceed = await showConfirm(ctx, {
      title: "GSD \u2014 Unusual Directory",
      message: dirCheck.reason,
      confirmLabel: "Continue anyway",
      declineLabel: "Cancel"
    });
    if (!proceed) return;
  }
  const gsdPath = gsdRoot(basePath);
  const hasBootstrapArtifacts = hasGsdBootstrapArtifacts(gsdPath);
  let skipGitBootstrap = false;
  if (!hasBootstrapArtifacts) {
    const detection = detectProjectState(basePath);
    if (detection.state === "v1-planning" && detection.v1) {
      const migrationChoice = await offerMigration(ctx, detection.v1);
      if (migrationChoice === "cancel") return;
      if (migrationChoice === "migrate") {
        const { handleMigrate } = await import("./migrate/command.js");
        await handleMigrate("", ctx, pi);
        return;
      }
    }
    const result = await showProjectInit(ctx, pi, basePath, detection);
    if (!result.completed) return;
    skipGitBootstrap = shouldSkipGitBootstrapAfterInit(result);
  }
  if (!skipGitBootstrap && (!nativeIsRepo(basePath) || isInheritedRepo(basePath))) {
    const mainBranch = loadEffectiveGSDPreferences()?.preferences?.git?.main_branch || "main";
    nativeInit(basePath, mainBranch);
  }
  if (!skipGitBootstrap && nativeIsRepo(basePath)) {
    ensureGitignore(basePath);
    untrackRuntimeFiles(basePath);
  }
  if (!skipGitBootstrap && nativeIsRepo(basePath) && !nativeHasCommittedHead(basePath)) {
    try {
      nativeAddAll(basePath);
      nativeCommit(basePath, "chore: init project");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarning("guided", `initial git commit failed; worktree isolation will remain disabled until HEAD exists: ${message}`);
    }
  }
  {
    const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
    await ensureDbOpen(basePath);
  }
  selfHealRuntimeRecords(basePath, ctx);
  const interrupted = await assessInterruptedSession(basePath);
  if (interrupted.classification === "running") {
    ctx.ui.notify(formatInterruptedSessionRunningMessage(interrupted), "error");
    return;
  }
  if (interrupted.classification === "stale") {
    clearLock(basePath);
    if (interrupted.pausedSession) {
      try {
        deleteRuntimeKv("global", "", PAUSED_SESSION_KV_KEY);
      } catch (e) {
        logWarning("guided", `stale paused-session DB cleanup failed: ${e.message}`, { file: "guided-flow.ts" });
      }
    }
  } else if (interrupted.classification === "recoverable") {
    if (interrupted.lock) clearLock(basePath);
    const resumeLabel = interrupted.pausedSession?.stepMode ? "Resume with /gsd next" : "Resume with /gsd auto";
    const resume = await showNextAction(ctx, {
      title: "GSD \u2014 Interrupted Session Detected",
      summary: formatInterruptedSessionSummary(interrupted),
      actions: [
        { id: "resume", label: resumeLabel, description: "Pick up where it left off", recommended: true },
        { id: "continue", label: "Continue manually", description: "Open the wizard as normal" }
      ]
    });
    if (resume === "resume") {
      startAutoDetached(ctx, pi, basePath, false, {
        interrupted,
        step: interrupted.pausedSession?.stepMode ?? false
      });
      return;
    }
  }
  if (interrupted.classification !== "recoverable") {
    try {
      const { autoImportMarkdownHierarchyIfDbMismatch } = await import("./migration-auto-check.js");
      const result = await autoImportMarkdownHierarchyIfDbMismatch(basePath);
      if (result.action === "imported") {
        ctx.ui.notify(
          `Recovered migrated planning state into gsd.db (${result.reason}): ${result.afterDb.milestones} milestone(s), ${result.afterDb.slices} slice(s), ${result.afterDb.tasks} task(s).`,
          "info"
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`GSD could not auto-import existing planning state into gsd.db: ${message}`, "warning");
      logWarning("guided", `planning state auto-import failed: ${message}`, { file: "guided-flow.ts" });
    }
  }
  const state = await deriveState(basePath);
  try {
    const { buildStateMarkdown } = await import("./doctor.js");
    await saveFile(resolveGsdRootFile(basePath, "STATE"), buildStateMarkdown(state));
  } catch (err) {
    logWarning("guided", `STATE.md rebuild failed: ${err.message}`);
  }
  {
    const prefs = loadEffectiveGSDPreferences(basePath)?.preferences;
    const { shouldRunDeepProjectSetup } = await import("./auto-dispatch.js");
    if (shouldRunDeepProjectSetup(state, prefs, basePath)) {
      await startDeepProjectSetupForeground(ctx, pi, basePath, stepMode);
      return;
    }
  }
  const planV2GateDecision = runPlanV2Gate(ctx, basePath, state);
  if (planV2GateDecision === "block") return;
  if (!state.activeMilestone?.id) {
    if (pendingAutoStartMap.has(basePath)) {
      const entry = pendingAutoStartMap.get(basePath);
      const ageMs = Date.now() - (entry.createdAt || 0);
      const manifestExists = existsSync(join(gsdRoot(basePath), "DISCUSSION-MANIFEST.json"));
      const milestoneHasContext = !!resolveMilestoneFile(basePath, entry.milestoneId, "CONTEXT");
      if (!manifestExists && !milestoneHasContext && ageMs > 3e4) {
        pendingAutoStartMap.delete(basePath);
      } else {
        ctx.ui.notify("Discussion already in progress \u2014 answer the question above to continue.", "info");
        return;
      }
    }
    const milestoneIds = findMilestoneIds(basePath);
    if (milestoneIds.length === 0) {
      const mDir = milestonesDir(basePath);
      if (existsSync(mDir)) {
        try {
          const entries = clearEmptyLegacyDeepSetupPseudoMilestones(basePath, readdirSync(mDir));
          if (entries.length > 0) {
            ctx.ui.notify(
              `Milestone directory has ${entries.length} entries but none were recognized as milestones. This may indicate a corrupted state or wrong working directory. Run \`/gsd doctor\` to diagnose.`,
              "warning"
            );
            return;
          }
        } catch (e) {
          logWarning("guided", `directory read failed: ${e.message}`);
        }
      }
    }
    const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
    const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
    const isFirst = milestoneIds.length === 0;
    if (isFirst) {
      ctx.ui.setStatus("gsd-step", "New Milestone \xB7 answer the questions above to plan");
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode });
      await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(
        ctx,
        pi,
        nextId,
        `New project, milestone ${nextId}. Do NOT read or explore .gsd/ \u2014 it's empty scaffolding.`,
        basePath
      ), "gsd-run", ctx, "discuss-milestone");
    } else {
      const choice = await showNextAction(ctx, {
        title: "GSD \u2014 Get Shit Done",
        summary: ["No active milestone."],
        actions: [
          {
            id: "quick_task",
            label: "Quick task",
            description: "For small bounded work, run /gsd quick <task> or /gsd do <task>.",
            recommended: true
          },
          {
            id: "new_milestone",
            label: "Create next milestone",
            description: "Define a larger body of work with planning artifacts."
          }
        ],
        notYetMessage: "Run /gsd when ready."
      });
      if (choice === "quick_task") {
        await runQuickTaskChoice(ctx, pi);
      } else if (choice === "new_milestone") {
        ctx.ui.setStatus("gsd-step", "New Milestone \xB7 answer the questions above to plan");
        setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode });
        await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(
          ctx,
          pi,
          nextId,
          `New milestone ${nextId}.`,
          basePath
        ), "gsd-run", ctx, "discuss-milestone");
      }
    }
    return;
  }
  const milestoneId = state.activeMilestone.id;
  const milestoneTitle = state.activeMilestone.title;
  if (planV2GateDecision === "recover-missing-context") {
    setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId, step: stepMode });
    await dispatchWorkflow(
      pi,
      await buildDiscussMilestonePrompt(
        milestoneId,
        milestoneTitle,
        basePath,
        getStructuredQuestionsAvailability(pi, ctx)
      ),
      "gsd-discuss",
      ctx,
      "discuss-milestone"
    );
    return;
  }
  if (state.phase === "complete") {
    const choice = await showNextAction(ctx, {
      title: `GSD \u2014 ${milestoneId}: ${milestoneTitle}`,
      summary: ["All milestones complete."],
      actions: [
        {
          id: "quick_task",
          label: "Quick task",
          description: "Do a small bounded task without opening a milestone.",
          recommended: true
        },
        {
          id: "new_milestone",
          label: "Start new milestone",
          description: "Define and plan the next milestone."
        },
        {
          id: "status",
          label: "View status",
          description: "Review what was built."
        }
      ],
      notYetMessage: "Run /gsd when ready."
    });
    if (choice === "quick_task") {
      await runQuickTaskChoice(ctx, pi);
    } else if (choice === "new_milestone") {
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode });
      await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(
        ctx,
        pi,
        nextId,
        `New milestone ${nextId}.`,
        basePath
      ), "gsd-run", ctx, "discuss-milestone");
    } else if (choice === "status") {
      const { fireStatusViaCommand: fireStatusViaCommand2 } = await import("./commands.js");
      await fireStatusViaCommand2(ctx);
    }
    return;
  }
  if (state.phase === "needs-discussion") {
    const draftFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT-DRAFT");
    const draftContent = draftFile ? await loadFile(draftFile) : null;
    const choice = await showNextAction(ctx, {
      title: `GSD \u2014 ${milestoneId}: ${milestoneTitle}`,
      summary: ["This milestone has a draft context from a prior discussion.", "It needs a dedicated discussion before auto-planning can begin."],
      actions: [
        {
          id: "discuss_draft",
          label: "Discuss from draft",
          description: "Continue where the prior discussion left off \u2014 seed material is loaded automatically.",
          recommended: true
        },
        {
          id: "discuss_fresh",
          label: "Start fresh discussion",
          description: "Discard the draft and start a new discussion from scratch."
        },
        {
          id: "skip_milestone",
          label: "Skip \u2014 create new milestone",
          description: "Leave this milestone as-is and start something new."
        }
      ],
      notYetMessage: "Run /gsd when ready to discuss this milestone."
    });
    if (choice === "discuss_draft") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      const basePrompt = loadPrompt("guided-discuss-milestone", {
        workingDirectory: basePath,
        milestoneId,
        milestoneTitle,
        inlinedTemplates: discussMilestoneTemplates,
        structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
        fastPathInstruction: ""
      });
      const seed = draftContent ? `${basePrompt}

## Prior Discussion (Draft Seed)

${draftContent}` : basePrompt;
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId, step: stepMode });
      await dispatchWorkflow(pi, seed, "gsd-discuss", ctx, "discuss-milestone");
    } else if (choice === "discuss_fresh") {
      const discussMilestoneTemplates = inlineTemplate("context", "Context");
      const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId, step: stepMode });
      await dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
        workingDirectory: basePath,
        milestoneId,
        milestoneTitle,
        inlinedTemplates: discussMilestoneTemplates,
        structuredQuestionsAvailable,
        commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
        fastPathInstruction: ""
      }), "gsd-discuss", ctx, "discuss-milestone");
    } else if (choice === "skip_milestone") {
      const milestoneIds = findMilestoneIds(basePath);
      const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
      const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
      setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode });
      await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(
        ctx,
        pi,
        nextId,
        `New milestone ${nextId}.`,
        basePath
      ), "gsd-run", ctx, "discuss-milestone");
    }
    return;
  }
  if (!state.activeSlice) {
    const roadmapFile = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
    const hasRoadmap = !!(roadmapFile && await loadFile(roadmapFile));
    let roadmapHasSlices = false;
    if (hasRoadmap) {
      const roadmapContent = await loadFile(roadmapFile);
      if (roadmapContent) {
        roadmapHasSlices = _roadmapHasParseableSlicesForTest(roadmapContent);
      }
    }
    if (!hasRoadmap || !roadmapHasSlices) {
      const contextFile = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
      const hasContext = !!(contextFile && await loadFile(contextFile));
      const actions = [
        {
          id: "quick_task",
          label: "Quick task instead",
          description: "Use this when the work is small and should not become a milestone.",
          recommended: true
        },
        {
          id: "plan",
          label: "Create roadmap",
          description: hasContext ? "Context captured. Decompose into slices with a boundary map." : "Decompose the milestone into slices with a boundary map."
        },
        ...!hasContext ? [{
          id: "discuss",
          label: "Discuss first",
          description: "Capture decisions on gray areas before planning."
        }] : [],
        {
          id: "skip_milestone",
          label: "Skip \u2014 create new milestone",
          description: "Leave this milestone on disk and start a fresh one."
        },
        {
          id: "discard_milestone",
          label: "Discard this milestone",
          description: "Delete the milestone directory and start over."
        }
      ];
      const choice = await showNextAction(ctx, {
        title: `GSD \u2014 ${milestoneId}: ${milestoneTitle}`,
        summary: [hasContext ? "Context captured. Ready to create roadmap." : "New milestone \u2014 no roadmap yet."],
        actions,
        notYetMessage: "Run /gsd when ready."
      });
      if (choice === "quick_task") {
        await runQuickTaskChoice(ctx, pi);
      } else if (choice === "plan") {
        ctx.ui.setStatus("gsd-step", "Planning Milestone \xB7 decomposing into slices");
        setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId, step: stepMode });
        await dispatchWorkflow(
          pi,
          await buildPlanMilestonePrompt(milestoneId, milestoneTitle, basePath),
          "gsd-run",
          ctx,
          "plan-milestone"
        );
      } else if (choice === "discuss") {
        const discussMilestoneTemplates = inlineTemplate("context", "Context");
        const structuredQuestionsAvailable = getStructuredQuestionsAvailability(pi, ctx);
        await dispatchWorkflow(pi, loadPrompt("guided-discuss-milestone", {
          workingDirectory: basePath,
          milestoneId,
          milestoneTitle,
          inlinedTemplates: discussMilestoneTemplates,
          structuredQuestionsAvailable,
          commitInstruction: buildDocsCommitInstruction(`docs(${milestoneId}): milestone context from discuss`),
          fastPathInstruction: ""
        }), "gsd-run", ctx, "discuss-milestone");
      } else if (choice === "skip_milestone") {
        const milestoneIds = findMilestoneIds(basePath);
        const uniqueMilestoneIds = !!loadEffectiveGSDPreferences()?.preferences?.unique_milestone_ids;
        const nextId = nextMilestoneIdReserved(milestoneIds, uniqueMilestoneIds, basePath);
        setPendingAutoStart(basePath, { ctx, pi, basePath, milestoneId: nextId, step: stepMode });
        await dispatchWorkflow(pi, await prepareAndBuildDiscussPrompt(
          ctx,
          pi,
          nextId,
          `New milestone ${nextId}.`,
          basePath
        ), "gsd-run", ctx, "discuss-milestone");
      } else if (choice === "discard_milestone") {
        const confirmed = await showConfirm(ctx, {
          title: "Discard milestone?",
          message: `This will permanently delete ${milestoneId} and all its contents.`,
          confirmLabel: "Discard",
          declineLabel: "Cancel"
        });
        if (confirmed) {
          discardMilestone(basePath, milestoneId);
          return showSmartEntry(ctx, pi, basePath, options);
        }
      }
    } else {
      const actions = [
        {
          id: "auto",
          label: "Go auto",
          description: "Execute everything automatically until milestone complete.",
          recommended: true
        },
        {
          id: "status",
          label: "View status",
          description: "See milestone progress and blockers."
        },
        {
          id: "milestone_actions",
          label: "Milestone actions",
          description: "Park, discard, or skip this milestone."
        }
      ];
      const choice = await showNextAction(ctx, {
        title: `GSD \u2014 ${milestoneId}: ${milestoneTitle}`,
        summary: ["Roadmap exists. Ready to execute."],
        actions,
        notYetMessage: "Run /gsd status for details."
      });
      if (choice === "auto") {
        startAutoDetached(ctx, pi, basePath, false);
      } else if (choice === "status") {
        const { fireStatusViaCommand: fireStatusViaCommand2 } = await import("./commands.js");
        await fireStatusViaCommand2(ctx);
      } else if (choice === "milestone_actions") {
        const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
        if (acted) return showSmartEntry(ctx, pi, basePath, options);
      }
    }
    return;
  }
  const sliceId = state.activeSlice.id;
  const sliceTitle = state.activeSlice.title;
  if (state.phase === "planning") {
    const contextFile = resolveSliceFile(basePath, milestoneId, sliceId, "CONTEXT");
    const researchFile = resolveSliceFile(basePath, milestoneId, sliceId, "RESEARCH");
    const hasContext = !!(contextFile && await loadFile(contextFile));
    const hasResearch = !!(researchFile && await loadFile(researchFile));
    const actions = [
      {
        id: "plan",
        label: `Plan ${sliceId}`,
        description: `Decompose "${sliceTitle}" into tasks with must-haves.`,
        recommended: true
      },
      ...!hasContext ? [{
        id: "discuss",
        label: `Discuss ${sliceId} first`,
        description: "Capture context and decisions for this slice."
      }] : [],
      ...!hasResearch ? [{
        id: "research",
        label: `Research ${sliceId} first`,
        description: "Scout codebase and relevant docs."
      }] : [],
      {
        id: "status",
        label: "View status",
        description: "See milestone progress."
      },
      {
        id: "milestone_actions",
        label: "Milestone actions",
        description: "Park, discard, or skip this milestone."
      }
    ];
    const summaryParts = [];
    if (hasContext) summaryParts.push("context \u2713");
    if (hasResearch) summaryParts.push("research \u2713");
    const summaryLine = summaryParts.length > 0 ? `${sliceId}: ${sliceTitle} (${summaryParts.join(", ")})` : `${sliceId}: ${sliceTitle} \u2014 ready for planning.`;
    const choice = await showNextAction(ctx, {
      title: `GSD \u2014 ${milestoneId} / ${sliceId}: ${sliceTitle}`,
      summary: [summaryLine],
      actions,
      notYetMessage: "Run /gsd when ready."
    });
    if (choice === "plan") {
      ctx.ui.setStatus("gsd-step", "Slice Planning \xB7 answer the questions above");
      await dispatchWorkflow(
        pi,
        await buildPlanSlicePrompt(milestoneId, milestoneTitle, sliceId, sliceTitle, basePath),
        "gsd-run",
        ctx,
        "plan-slice"
      );
    } else if (choice === "discuss") {
      const sqAvail = getStructuredQuestionsAvailability(pi, ctx);
      await dispatchWorkflow(pi, await buildDiscussSlicePrompt(milestoneId, sliceId, sliceTitle, basePath, { rediscuss: hasContext, structuredQuestionsAvailable: sqAvail }), "gsd-run", ctx, "discuss-slice");
    } else if (choice === "research") {
      const researchTemplates = inlineTemplate("research", "Research");
      await dispatchWorkflow(pi, loadPrompt("guided-research-slice", {
        milestoneId,
        sliceId,
        sliceTitle,
        inlinedTemplates: researchTemplates,
        skillActivation: buildSkillActivationBlock({
          base: basePath,
          milestoneId,
          sliceId,
          sliceTitle,
          extraContext: [researchTemplates]
        })
      }), "gsd-run", ctx, "research-slice");
    } else if (choice === "status") {
      const { fireStatusViaCommand: fireStatusViaCommand2 } = await import("./commands.js");
      await fireStatusViaCommand2(ctx);
    } else if (choice === "milestone_actions") {
      const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
      if (acted) return showSmartEntry(ctx, pi, basePath, options);
    }
    return;
  }
  if (state.phase === "summarizing") {
    const choice = await showNextAction(ctx, {
      title: `GSD \u2014 ${milestoneId} / ${sliceId}: ${sliceTitle}`,
      summary: ["All tasks complete. Ready for slice summary."],
      actions: [
        {
          id: "complete",
          label: `Complete ${sliceId}`,
          description: "Write slice summary, UAT, mark done, and squash-merge to main.",
          recommended: true
        },
        {
          id: "status",
          label: "View status",
          description: "Review tasks before completing."
        },
        {
          id: "milestone_actions",
          label: "Milestone actions",
          description: "Park, discard, or skip this milestone."
        }
      ],
      notYetMessage: "Run /gsd when ready."
    });
    if (choice === "complete") {
      ctx.ui.setStatus("gsd-step", "Completing Slice \xB7 review changes above");
      await dispatchWorkflow(
        pi,
        await buildCompleteSlicePrompt(milestoneId, milestoneTitle, sliceId, sliceTitle, basePath),
        "gsd-run",
        ctx,
        "complete-slice"
      );
    } else if (choice === "status") {
      const { fireStatusViaCommand: fireStatusViaCommand2 } = await import("./commands.js");
      await fireStatusViaCommand2(ctx);
    } else if (choice === "milestone_actions") {
      const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
      if (acted) return showSmartEntry(ctx, pi, basePath, options);
    }
    return;
  }
  if (state.activeTask) {
    const taskId = state.activeTask.id;
    const taskTitle = state.activeTask.title;
    const continueFile = resolveSliceFile(basePath, milestoneId, sliceId, "CONTINUE");
    const sDir = resolveSlicePath(basePath, milestoneId, sliceId);
    const hasInterrupted = !!(continueFile && await loadFile(continueFile)) || !!(sDir && await loadFile(join(sDir, "continue.md")));
    const choice = await showNextAction(ctx, {
      title: `GSD \u2014 ${milestoneId} / ${sliceId}: ${sliceTitle}`,
      summary: [
        hasInterrupted ? `Resuming: ${taskId} \u2014 ${taskTitle}` : `Next: ${taskId} \u2014 ${taskTitle}`
      ],
      actions: [
        {
          id: "execute",
          label: hasInterrupted ? `Resume ${taskId}` : `Execute ${taskId}`,
          description: hasInterrupted ? "Continue from where you left off." : `Start working on "${taskTitle}".`,
          recommended: true
        },
        {
          id: "auto",
          label: "Go auto",
          description: "Execute this and all remaining tasks automatically."
        },
        {
          id: "status",
          label: "View status",
          description: "See slice progress before starting."
        },
        {
          id: "milestone_actions",
          label: "Milestone actions",
          description: "Park, discard, or skip this milestone."
        }
      ],
      notYetMessage: "Run /gsd when ready."
    });
    if (choice === "auto") {
      startAutoDetached(ctx, pi, basePath, false);
      return;
    }
    if (choice === "execute") {
      ctx.ui.setStatus("gsd-step", "Executing Task \xB7 follow progress above");
      if (hasInterrupted) {
        await dispatchWorkflow(pi, loadPrompt("guided-resume-task", {
          milestoneId,
          sliceId,
          skillActivation: buildSkillActivationBlock({
            base: basePath,
            milestoneId,
            sliceId,
            taskId,
            taskTitle
          })
        }), "gsd-run", ctx, "execute-task");
      } else {
        await dispatchWorkflow(
          pi,
          await buildExecuteTaskPrompt(milestoneId, sliceId, sliceTitle, taskId, taskTitle, basePath),
          "gsd-run",
          ctx,
          "execute-task"
        );
      }
    } else if (choice === "status") {
      const { fireStatusViaCommand: fireStatusViaCommand2 } = await import("./commands.js");
      await fireStatusViaCommand2(ctx);
    } else if (choice === "milestone_actions") {
      const acted = await handleMilestoneActions(ctx, pi, basePath, milestoneId, milestoneTitle, options);
      if (acted) return showSmartEntry(ctx, pi, basePath, options);
    }
    return;
  }
  const { fireStatusViaCommand } = await import("./commands.js");
  await fireStatusViaCommand(ctx);
}
export {
  FOREGROUND_DEEP_SETUP_RULE_NAMES,
  MILESTONE_ID_RE,
  _dispatchWorkflowForTest,
  _getPendingAutoStart,
  _needsPlanV2GateForTest,
  _roadmapHasParseableSlicesForTest,
  _runPlanV2GateForTest,
  _scheduleAutoStartAfterIdleForTest,
  buildExistingMilestonesContext,
  checkAutoStartAfterDiscuss,
  checkDeepProjectSetupAfterTurn,
  claimReservedId,
  clearPendingAutoStart,
  clearPendingDeepProjectSetup,
  clearReservedMilestoneIds2 as clearReservedMilestoneIds,
  extractMilestoneSeq,
  findMilestoneIds2 as findMilestoneIds,
  generateMilestoneSuffix,
  getDiscussionMilestoneId,
  getPendingDeepProjectSetupUnitForContext,
  getReservedMilestoneIds,
  handleQueueReorder,
  isGhostMilestoneByScope,
  maxMilestoneNum,
  maybeHandleEmptyIntentTurn,
  maybeHandleReadyPhraseWithoutFiles,
  milestoneIdSort,
  nextMilestoneId,
  nextMilestoneIdReserved2 as nextMilestoneIdReserved,
  parseMilestoneId,
  reserveMilestoneId,
  resetEmptyTurnCounter,
  resolveExpectedArtifactPathForScope,
  setPendingAutoStart,
  shouldSkipGitBootstrapAfterInit,
  showDiscuss,
  showHeadlessMilestoneCreation,
  showQueue,
  showQueueAdd,
  showSmartEntry,
  startDeepProjectSetupForeground,
  verifyExpectedArtifactForScope
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9ndWlkZWQtZmxvdy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBHU0QgR3VpZGVkIEZsb3cgXHUyMDE0IFNtYXJ0IEVudHJ5IFdpemFyZFxuICpcbiAqIE9uZSBmdW5jdGlvbjogc2hvd1NtYXJ0RW50cnkoKS4gUmVhZHMgc3RhdGUgZnJvbSBkaXNrLCBzaG93cyBhIGNvbnRleHR1YWxcbiAqIHdpemFyZCB2aWEgc2hvd05leHRBY3Rpb24oKSwgYW5kIGRpc3BhdGNoZXMgdGhyb3VnaCBHU0QtV09SS0ZMT1cubWQuXG4gKiBObyBleGVjdXRpb24gc3RhdGUsIG5vIGhvb2tzLCBubyB0b29scyBcdTIwMTQgdGhlIExMTSBkb2VzIHRoZSByZXN0LlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXh0ZW5zaW9uQVBJLCBFeHRlbnNpb25Db250ZXh0LCBFeHRlbnNpb25Db21tYW5kQ29udGV4dCB9IGZyb20gXCJAZ3NkL3BpLWNvZGluZy1hZ2VudFwiO1xuaW1wb3J0IHR5cGUgeyBHU0RTdGF0ZSB9IGZyb20gXCIuL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBzaG93TmV4dEFjdGlvbiB9IGZyb20gXCIuLi9zaGFyZWQvdHVpLmpzXCI7XG5pbXBvcnQgeyBsb2FkRmlsZSwgc2F2ZUZpbGUgfSBmcm9tIFwiLi9maWxlcy5qc1wiO1xuaW1wb3J0IHsgaXNEYkF2YWlsYWJsZSwgZ2V0TWlsZXN0b25lLCBnZXRNaWxlc3RvbmVTbGljZXMgfSBmcm9tIFwiLi9nc2QtZGIuanNcIjtcbmltcG9ydCB7IHBhcnNlUm9hZG1hcFNsaWNlcyB9IGZyb20gXCIuL3JvYWRtYXAtc2xpY2VzLmpzXCI7XG5pbXBvcnQgeyBsb2FkUHJvbXB0LCBpbmxpbmVUZW1wbGF0ZSB9IGZyb20gXCIuL3Byb21wdC1sb2FkZXIuanNcIjtcbmltcG9ydCB7XG4gIGJ1aWxkQ29tcGxldGVTbGljZVByb21wdCxcbiAgYnVpbGREaXNjdXNzTWlsZXN0b25lUHJvbXB0LFxuICBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0LFxuICBidWlsZFBsYW5NaWxlc3RvbmVQcm9tcHQsXG4gIGJ1aWxkUGxhblNsaWNlUHJvbXB0LFxuICBidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrLFxufSBmcm9tIFwiLi9hdXRvLXByb21wdHMuanNcIjtcbmltcG9ydCB7IGRlcml2ZVN0YXRlLCBpc0dob3N0TWlsZXN0b25lIH0gZnJvbSBcIi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IGludmFsaWRhdGVBbGxDYWNoZXMgfSBmcm9tIFwiLi9jYWNoZS5qc1wiO1xuaW1wb3J0IHsgc3RhcnRBdXRvRGV0YWNoZWQgfSBmcm9tIFwiLi9hdXRvLmpzXCI7XG5pbXBvcnQgeyBjbGVhckxvY2sgfSBmcm9tIFwiLi9jcmFzaC1yZWNvdmVyeS5qc1wiO1xuaW1wb3J0IHtcbiAgYXNzZXNzSW50ZXJydXB0ZWRTZXNzaW9uLFxuICBmb3JtYXRJbnRlcnJ1cHRlZFNlc3Npb25SdW5uaW5nTWVzc2FnZSxcbiAgZm9ybWF0SW50ZXJydXB0ZWRTZXNzaW9uU3VtbWFyeSxcbn0gZnJvbSBcIi4vaW50ZXJydXB0ZWQtc2Vzc2lvbi5qc1wiO1xuaW1wb3J0IHsgbGlzdFVuaXRSdW50aW1lUmVjb3JkcywgY2xlYXJVbml0UnVudGltZVJlY29yZCwgaXNJbkZsaWdodFJ1bnRpbWVQaGFzZSB9IGZyb20gXCIuL3VuaXQtcnVudGltZS5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoIH0gZnJvbSBcIi4vYXV0by5qc1wiO1xuaW1wb3J0IHsgZ3NkSG9tZSB9IGZyb20gXCIuL2dzZC1ob21lLmpzXCI7XG5pbXBvcnQge1xuICBnc2RSb290LCBtaWxlc3RvbmVzRGlyLCByZXNvbHZlTWlsZXN0b25lRmlsZSwgcmVzb2x2ZU1pbGVzdG9uZVBhdGgsXG4gIHJlc29sdmVTbGljZUZpbGUsIHJlc29sdmVTbGljZVBhdGgsIHJlc29sdmVHc2RSb290RmlsZSwgcmVsR3NkUm9vdEZpbGUsXG4gIHJlbE1pbGVzdG9uZUZpbGUsIHJlbFNsaWNlRmlsZSwgY2xlYXJQYXRoQ2FjaGUsXG59IGZyb20gXCIuL3BhdGhzLmpzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgcmVhZEZpbGVTeW5jLCBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRkaXJTeW5jLCBybVN5bmMsIHVubGlua1N5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgcmVhZFNlc3Npb25Mb2NrRGF0YSwgaXNTZXNzaW9uTG9ja1Byb2Nlc3NBbGl2ZSB9IGZyb20gXCIuL3Nlc3Npb24tbG9jay5qc1wiO1xuaW1wb3J0IHsgbmF0aXZlQWRkQWxsLCBuYXRpdmVDb21taXQsIG5hdGl2ZUhhc0NvbW1pdHRlZEhlYWQsIG5hdGl2ZUlzUmVwbywgbmF0aXZlSW5pdCB9IGZyb20gXCIuL25hdGl2ZS1naXQtYnJpZGdlLmpzXCI7XG5pbXBvcnQgeyBpc0luaGVyaXRlZFJlcG8gfSBmcm9tIFwiLi9yZXBvLWlkZW50aXR5LmpzXCI7XG5pbXBvcnQgeyBlbnN1cmVHaXRpZ25vcmUsIGVuc3VyZVByZWZlcmVuY2VzLCB1bnRyYWNrUnVudGltZUZpbGVzIH0gZnJvbSBcIi4vZ2l0aWdub3JlLmpzXCI7XG5pbXBvcnQgeyBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVVva0ZsYWdzIH0gZnJvbSBcIi4vdW9rL2ZsYWdzLmpzXCI7XG5pbXBvcnQgeyBlbnN1cmVQbGFuVjJHcmFwaCwgaXNNaXNzaW5nRmluYWxpemVkQ29udGV4dFJlc3VsdCB9IGZyb20gXCIuL3Vvay9wbGFuLXYyLmpzXCI7XG5pbXBvcnQgeyBkZXRlY3RQcm9qZWN0U3RhdGUsIGhhc0dzZEJvb3RzdHJhcEFydGlmYWN0cyB9IGZyb20gXCIuL2RldGVjdGlvbi5qc1wiO1xuaW1wb3J0IHsgc2hvd1Byb2plY3RJbml0LCBvZmZlck1pZ3JhdGlvbiB9IGZyb20gXCIuL2luaXQtd2l6YXJkLmpzXCI7XG5pbXBvcnQgeyB2YWxpZGF0ZURpcmVjdG9yeSB9IGZyb20gXCIuL3ZhbGlkYXRlLWRpcmVjdG9yeS5qc1wiO1xuaW1wb3J0IHsgc2hvd0NvbmZpcm0gfSBmcm9tIFwiLi4vc2hhcmVkL3R1aS5qc1wiO1xuaW1wb3J0IHsgZGVidWdMb2cgfSBmcm9tIFwiLi9kZWJ1Zy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IGZpbmRNaWxlc3RvbmVJZHMsIGNsZWFyUmVzZXJ2ZWRNaWxlc3RvbmVJZHMgfSBmcm9tIFwiLi9taWxlc3RvbmUtaWRzLmpzXCI7XG5pbXBvcnQgeyBuZXh0TWlsZXN0b25lSWRSZXNlcnZlZCB9IGZyb20gXCIuL21pbGVzdG9uZS1pZC1yZXNlcnZhdGlvbi5qc1wiO1xuZXhwb3J0IHsgbmV4dE1pbGVzdG9uZUlkUmVzZXJ2ZWQgfSBmcm9tIFwiLi9taWxlc3RvbmUtaWQtcmVzZXJ2YXRpb24uanNcIjtcbmltcG9ydCB7IHBhcmtNaWxlc3RvbmUsIGRpc2NhcmRNaWxlc3RvbmUgfSBmcm9tIFwiLi9taWxlc3RvbmUtYWN0aW9ucy5qc1wiO1xuaW1wb3J0IHsgc2VsZWN0QW5kQXBwbHlNb2RlbCB9IGZyb20gXCIuL2F1dG8tbW9kZWwtc2VsZWN0aW9uLmpzXCI7XG5pbXBvcnQgeyBESVNDVVNTX1RPT0xTX0FMTE9XTElTVCB9IGZyb20gXCIuL2NvbnN0YW50cy5qc1wiO1xuaW1wb3J0IHtcbiAgZ2V0V29ya2Zsb3dUcmFuc3BvcnRTdXBwb3J0RXJyb3IsXG4gIGdldFJlcXVpcmVkV29ya2Zsb3dUb29sc0Zvckd1aWRlZFVuaXQsXG4gIHN1cHBvcnRzU3RydWN0dXJlZFF1ZXN0aW9ucyxcbn0gZnJvbSBcIi4vd29ya2Zsb3ctbWNwLmpzXCI7XG5pbXBvcnQge1xuICBydW5QcmVwYXJhdGlvbixcbiAgZm9ybWF0Q29kZWJhc2VCcmllZixcbiAgZm9ybWF0UHJpb3JDb250ZXh0QnJpZWYsXG59IGZyb20gXCIuL3ByZXBhcmF0aW9uLmpzXCI7XG5pbXBvcnQgeyB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0IH0gZnJvbSBcIi4vYXV0by1yZWNvdmVyeS5qc1wiO1xuaW1wb3J0IHsgY3JlYXRlV29ya3NwYWNlLCBzY29wZU1pbGVzdG9uZSwgdHlwZSBNaWxlc3RvbmVTY29wZSB9IGZyb20gXCIuL3dvcmtzcGFjZS5qc1wiO1xuaW1wb3J0IHsgZ2V0UGVuZGluZ0dhdGUsIGV4dHJhY3REZXB0aFZlcmlmaWNhdGlvbk1pbGVzdG9uZUlkIH0gZnJvbSBcIi4vYm9vdHN0cmFwL3dyaXRlLWdhdGUuanNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFNraXBHaXRCb290c3RyYXBBZnRlckluaXQocmVzdWx0OiB7IGdpdEVuYWJsZWQ/OiBib29sZWFuIH0pOiBib29sZWFuIHtcbiAgcmV0dXJuIHJlc3VsdC5naXRFbmFibGVkID09PSBmYWxzZTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlLWV4cG9ydHMgKHByZXNlcnZlIHB1YmxpYyBBUEkgZm9yIGV4aXN0aW5nIGltcG9ydGVycykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5leHBvcnQge1xuICBNSUxFU1RPTkVfSURfUkUsIGdlbmVyYXRlTWlsZXN0b25lU3VmZml4LCBuZXh0TWlsZXN0b25lSWQsXG4gIGV4dHJhY3RNaWxlc3RvbmVTZXEsIHBhcnNlTWlsZXN0b25lSWQsIG1pbGVzdG9uZUlkU29ydCxcbiAgbWF4TWlsZXN0b25lTnVtLCBmaW5kTWlsZXN0b25lSWRzLFxuICByZXNlcnZlTWlsZXN0b25lSWQsIGNsYWltUmVzZXJ2ZWRJZCwgZ2V0UmVzZXJ2ZWRNaWxlc3RvbmVJZHMsIGNsZWFyUmVzZXJ2ZWRNaWxlc3RvbmVJZHMsXG59IGZyb20gXCIuL21pbGVzdG9uZS1pZHMuanNcIjtcbmV4cG9ydCB7XG4gIHNob3dRdWV1ZSwgaGFuZGxlUXVldWVSZW9yZGVyLCBzaG93UXVldWVBZGQsXG4gIGJ1aWxkRXhpc3RpbmdNaWxlc3RvbmVzQ29udGV4dCxcbn0gZnJvbSBcIi4vZ3VpZGVkLWZsb3ctcXVldWUuanNcIjtcbmltcG9ydCB7IGxvZ1dhcm5pbmcgfSBmcm9tIFwiLi93b3JrZmxvdy1sb2dnZXIuanNcIjtcbmltcG9ydCB7IGRlbGV0ZVJ1bnRpbWVLdiB9IGZyb20gXCIuL2RiL3J1bnRpbWUta3YuanNcIjtcbmltcG9ydCB7IFBBVVNFRF9TRVNTSU9OX0tWX0tFWSB9IGZyb20gXCIuL2ludGVycnVwdGVkLXNlc3Npb24uanNcIjtcbmltcG9ydCB7IGJ1aWxkV29ya2Zsb3dEaXNwYXRjaENvbnRlbnQgfSBmcm9tIFwiLi93b3JrZmxvdy1wcm90b2NvbC5qc1wiO1xuaW1wb3J0IHsgaXNGdWxsR3NkVG9vbFN1cmZhY2VSZXF1ZXN0ZWQsIHJlc3RvcmVHc2RXb3JrZmxvd1Rvb2xzLCBzY29wZUdzZFdvcmtmbG93VG9vbHNGb3JEaXNwYXRjaCB9IGZyb20gXCIuL2Jvb3RzdHJhcC9yZWdpc3Rlci1ob29rcy5qc1wiO1xuXG50eXBlIEF1dG9TdGFydE9wdGlvbnMgPSBQYXJhbWV0ZXJzPHR5cGVvZiBzdGFydEF1dG9EZXRhY2hlZD5bNF07XG50eXBlIEF1dG9TdGFydExhdW5jaGVyID0gdHlwZW9mIHN0YXJ0QXV0b0RldGFjaGVkO1xuXG5mdW5jdGlvbiBzY2hlZHVsZUF1dG9TdGFydEFmdGVySWRsZShcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgdmVyYm9zZU1vZGU6IGJvb2xlYW4sXG4gIG9wdGlvbnM/OiBBdXRvU3RhcnRPcHRpb25zLFxuICBsYXVuY2g6IEF1dG9TdGFydExhdW5jaGVyID0gc3RhcnRBdXRvRGV0YWNoZWQsXG4pOiB2b2lkIHtcbiAgY29uc3Qgd2FpdEZvcklkbGUgPVxuICAgIHR5cGVvZiAoY3R4IGFzIHsgd2FpdEZvcklkbGU/OiB1bmtub3duIH0pLndhaXRGb3JJZGxlID09PSBcImZ1bmN0aW9uXCJcbiAgICAgID8gY3R4LndhaXRGb3JJZGxlLmJpbmQoY3R4KVxuICAgICAgOiBhc3luYyAoKSA9PiB7fTtcbiAgdm9pZCB3YWl0Rm9ySWRsZSgpXG4gICAgLnRoZW4oKCkgPT4ge1xuICAgICAgc2V0VGltZW91dCgoKSA9PiBsYXVuY2goY3R4LCBwaSwgYmFzZVBhdGgsIHZlcmJvc2VNb2RlLCBvcHRpb25zKSwgMCk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIGN0eC51aS5ub3RpZnkoYEF1dG8tc3RhcnQgZmFpbGVkIHdoaWxlIHdhaXRpbmcgZm9yIHRoZSBwcmlvciB0dXJuIHRvIHNldHRsZTogJHttZXNzYWdlfWAsIFwiZXJyb3JcIik7XG4gICAgICBsb2dXYXJuaW5nKFwiZ3VpZGVkXCIsIGBhdXRvLXN0YXJ0IGlkbGUgd2FpdCBmYWlsZWQ6ICR7bWVzc2FnZX1gKTtcbiAgICB9KTtcbn1cblxuZXhwb3J0IGNvbnN0IF9zY2hlZHVsZUF1dG9TdGFydEFmdGVySWRsZUZvclRlc3QgPSBzY2hlZHVsZUF1dG9TdGFydEFmdGVySWRsZTtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFNjb3BlLWJhc2VkIHZhbGlkYXRvciB3cmFwcGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFRoZXNlIHRoaW4gd3JhcHBlcnMgYWNjZXB0IGEgTWlsZXN0b25lU2NvcGUgc28gY2FsbGVycyB0aGF0IGFscmVhZHkgaG9sZCBhXG4vLyBwaW5uZWQgc2NvcGUgbmV2ZXIgaGF2ZSB0byByZS1kZXJpdmUgKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCkgc2VwYXJhdGVseS5cbi8vIFRoZSB1bmRlcmx5aW5nIGltcGxlbWVudGF0aW9ucyBpbiBhdXRvLXJlY292ZXJ5LnRzIC8gYXV0by1hcnRpZmFjdC1wYXRocy50cyAvXG4vLyBzdGF0ZS50cyBhcmUgdW5jaGFuZ2VkIFx1MjAxNCBvbmx5IHRoZSBjYWxsIHN1cmZhY2UgaW4gZ3VpZGVkLWZsb3cudHMgaXMgbWlncmF0ZWQuXG5cbi8qKlxuICogU2NvcGUtYmFzZWQgb3ZlcmxvYWQgb2YgdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdC5cbiAqIFVzZXMgc2NvcGUud29ya3NwYWNlLnByb2plY3RSb290IGFzIHRoZSBhdXRob3JpdGF0aXZlIGJhc2UgcGF0aCwgbWFraW5nXG4gKiB0aGUgY2hlY2sgaW1tdW5lIHRvIGN3ZC1kcmlmdCBhbmQgd29ya3RyZWUtcGF0aCBkaXZlcmdlbmNlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmVyaWZ5RXhwZWN0ZWRBcnRpZmFjdEZvclNjb3BlKFxuICBzY29wZTogTWlsZXN0b25lU2NvcGUsXG4gIHVuaXRUeXBlOiBzdHJpbmcsXG4gIHVuaXRJZDogc3RyaW5nLFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiB2ZXJpZnlFeHBlY3RlZEFydGlmYWN0KHVuaXRUeXBlLCB1bml0SWQsIHNjb3BlLndvcmtzcGFjZS5wcm9qZWN0Um9vdCk7XG59XG5cbi8qKlxuICogU2NvcGUtYmFzZWQgb3ZlcmxvYWQgb2YgcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoLlxuICogUmV0dXJucyB0aGUgY2Fub25pY2FsIGFic29sdXRlIHBhdGggKG9yIG51bGwpIHVzaW5nIHRoZSBzY29wZSdzIHByb2plY3RSb290LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUV4cGVjdGVkQXJ0aWZhY3RQYXRoRm9yU2NvcGUoXG4gIHNjb3BlOiBNaWxlc3RvbmVTY29wZSxcbiAgdW5pdFR5cGU6IHN0cmluZyxcbiAgdW5pdElkOiBzdHJpbmcsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCh1bml0VHlwZSwgdW5pdElkLCBzY29wZS53b3Jrc3BhY2UucHJvamVjdFJvb3QpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5RdWlja1Rhc2tDaG9pY2UoY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCwgcGk6IEV4dGVuc2lvbkFQSSk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoIWN0eC5oYXNVSSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJSdW4gL2dzZCBxdWljayA8dGFzaz4gZm9yIHNtYWxsIGJvdW5kZWQgd29yaywgb3IgL2dzZCBkbyA8dGFzaz4gZm9yIG5hdHVyYWwtbGFuZ3VhZ2Ugcm91dGluZy5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRhc2sgPSAoYXdhaXQgY3R4LnVpLmlucHV0KFwiUXVpY2sgdGFza1wiLCBcIkRlc2NyaWJlIHRoZSBzbWFsbCB0YXNrIHRvIHJ1biB3aXRoIC9nc2QgcXVpY2tcIikpPy50cmltKCk7XG4gIGlmICghdGFzaykge1xuICAgIGN0eC51aS5ub3RpZnkoXCJRdWljayB0YXNrIGNhbmNlbGxlZC5cIiwgXCJpbmZvXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHsgaGFuZGxlUXVpY2sgfSA9IGF3YWl0IGltcG9ydChcIi4vcXVpY2suanNcIik7XG4gIGF3YWl0IGhhbmRsZVF1aWNrKHRhc2ssIGN0eCwgcGkpO1xufVxuXG4vKipcbiAqIFNjb3BlLWJhc2VkIG92ZXJsb2FkIG9mIGlzR2hvc3RNaWxlc3RvbmUuXG4gKiBCaW5kcyBiYXNlUGF0aCBhbmQgbWlsZXN0b25lSWQgZnJvbSB0aGUgc2NvcGUsIGVuc3VyaW5nIHBhdGggcmVzb2x1dGlvblxuICogdXNlcyB0aGUgY2Fub25pY2FsIHByb2plY3Qgcm9vdCByZWdhcmRsZXNzIG9mIHRoZSBjd2QgYXQgY2FsbCB0aW1lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNHaG9zdE1pbGVzdG9uZUJ5U2NvcGUoc2NvcGU6IE1pbGVzdG9uZVNjb3BlKTogYm9vbGVhbiB7XG4gIHJldHVybiBpc0dob3N0TWlsZXN0b25lKHNjb3BlLndvcmtzcGFjZS5wcm9qZWN0Um9vdCwgc2NvcGUubWlsZXN0b25lSWQpO1xufVxuXG5mdW5jdGlvbiBuZWVkc1BsYW5WMkdhdGUoc3RhdGU6IEdTRFN0YXRlKTogYm9vbGVhbiB7XG4gIHJldHVybiBzdGF0ZS5waGFzZSA9PT0gXCJleGVjdXRpbmdcIlxuICAgIHx8IHN0YXRlLnBoYXNlID09PSBcInN1bW1hcml6aW5nXCJcbiAgICB8fCBzdGF0ZS5waGFzZSA9PT0gXCJ2YWxpZGF0aW5nLW1pbGVzdG9uZVwiXG4gICAgfHwgc3RhdGUucGhhc2UgPT09IFwiY29tcGxldGluZy1taWxlc3RvbmVcIjtcbn1cblxudHlwZSBQbGFuVjJHYXRlRGVjaXNpb24gPSBcInBhc3NcIiB8IFwicmVjb3Zlci1taXNzaW5nLWNvbnRleHRcIiB8IFwiYmxvY2tcIjtcblxuZnVuY3Rpb24gcnVuUGxhblYyR2F0ZShcbiAgY3R4OiBFeHRlbnNpb25Db250ZXh0LFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBzdGF0ZTogR1NEU3RhdGUsXG4pOiBQbGFuVjJHYXRlRGVjaXNpb24ge1xuICBjb25zdCBwcmVmcyA9IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyhiYXNlUGF0aCk/LnByZWZlcmVuY2VzO1xuICBjb25zdCB1b2tGbGFncyA9IHJlc29sdmVVb2tGbGFncyhwcmVmcyk7XG4gIGlmICghdW9rRmxhZ3MucGxhblYyIHx8ICFuZWVkc1BsYW5WMkdhdGUoc3RhdGUpKSByZXR1cm4gXCJwYXNzXCI7XG4gIGNvbnN0IGNvbXBpbGVkID0gZW5zdXJlUGxhblYyR3JhcGgoYmFzZVBhdGgsIHN0YXRlKTtcbiAgaWYgKCFjb21waWxlZC5vaykge1xuICAgIGlmIChpc01pc3NpbmdGaW5hbGl6ZWRDb250ZXh0UmVzdWx0KGNvbXBpbGVkKSkge1xuICAgICAgcmV0dXJuIFwicmVjb3Zlci1taXNzaW5nLWNvbnRleHRcIjtcbiAgICB9XG4gICAgY29uc3QgcmVhc29uID0gY29tcGlsZWQucmVhc29uID8/IFwicGxhbi12MiBjb21waWxhdGlvbiBmYWlsZWRcIjtcbiAgICBjdHgudWkubm90aWZ5KFxuICAgICAgYFBsYW4gZ2F0ZSBmYWlsZWQtY2xvc2VkOiAke3JlYXNvbn0uIENvbXBsZXRlIHBsYW4vZGlzY3VzcyBhcnRpZmFjdHMgYmVmb3JlIGV4ZWN1dGlvbi5cXG5cXG5JZiB0aGlzIGtlZXBzIGhhcHBlbmluZywgdHJ5OiAvZ3NkIGRvY3RvciBoZWFsYCxcbiAgICAgIFwiZXJyb3JcIixcbiAgICApO1xuICAgIHJldHVybiBcImJsb2NrXCI7XG4gIH1cbiAgcmV0dXJuIFwicGFzc1wiO1xufVxuXG5leHBvcnQgY29uc3QgX25lZWRzUGxhblYyR2F0ZUZvclRlc3QgPSBuZWVkc1BsYW5WMkdhdGU7XG5leHBvcnQgY29uc3QgX3J1blBsYW5WMkdhdGVGb3JUZXN0ID0gcnVuUGxhblYyR2F0ZTtcblxuZXhwb3J0IGZ1bmN0aW9uIF9yb2FkbWFwSGFzUGFyc2VhYmxlU2xpY2VzRm9yVGVzdChcbiAgcm9hZG1hcENvbnRlbnQ6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQsXG4pOiBib29sZWFuIHtcbiAgaWYgKCFyb2FkbWFwQ29udGVudCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gcGFyc2VSb2FkbWFwU2xpY2VzKHJvYWRtYXBDb250ZW50KS5sZW5ndGggPiAwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgQ29tbWl0IEluc3RydWN0aW9uIEhlbHBlcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKiBCdWlsZCBjb21taXQgaW5zdHJ1Y3Rpb24gZm9yIHBsYW5uaW5nIHByb21wdHMuIC5nc2QvIGlzIG1hbmFnZWQgZXh0ZXJuYWxseSBhbmQgYWx3YXlzIGdpdGlnbm9yZWQuICovXG5mdW5jdGlvbiBidWlsZERvY3NDb21taXRJbnN0cnVjdGlvbihfbWVzc2FnZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIFwiRG8gbm90IGNvbW1pdCBwbGFubmluZyBhcnRpZmFjdHMgXHUyMDE0IC5nc2QvIGlzIG1hbmFnZWQgZXh0ZXJuYWxseS5cIjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIEF1dG8tc3RhcnQgYWZ0ZXIgZGlzY3VzcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqIFBlbmRpbmcgYXV0by1zdGFydCBjb250ZXh0LCBrZXllZCBieSBiYXNlUGF0aCBmb3Igc2Vzc2lvbiBpc29sYXRpb24gKCMyOTg1KS4gKi9cbmludGVyZmFjZSBQZW5kaW5nQXV0b1N0YXJ0RW50cnkge1xuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0O1xuICBwaTogRXh0ZW5zaW9uQVBJO1xuICBiYXNlUGF0aDogc3RyaW5nO1xuICBtaWxlc3RvbmVJZDogc3RyaW5nOyAvLyB0aGUgbWlsZXN0b25lIGJlaW5nIGRpc2N1c3NlZFxuICBzdGVwPzogYm9vbGVhbjsgLy8gcHJlc2VydmUgc3RlcCBtb2RlIHRocm91Z2ggZGlzY3VzcyBcdTIxOTIgYXV0byB0cmFuc2l0aW9uXG4gIGNyZWF0ZWRBdDogbnVtYmVyOyAvLyB0aW1lc3RhbXAgZm9yIHN0YWxlbmVzcyBkZXRlY3Rpb24gKCMzMjc0KVxuICAvLyAjNDU3MzogY291bnRlciBmb3IgaG93IG1hbnkgdGltZXMgdGhlIExMTSBlbWl0dGVkIHRoZSByZWFkeSBwaHJhc2VcbiAgLy8gd2l0aG91dCB3cml0aW5nIHRoZSByZXF1aXJlZCBhcnRpZmFjdHMuIENsZWFyZWQgb24gZW50cnkgZGVsZXRlL3JlY3JlYXRlLlxuICByZWFkeVJlamVjdENvdW50PzogbnVtYmVyO1xuICAvLyBDMTogc2NvcGUgaXMgcGlubmVkIGF0IHJlc2VydmF0aW9uIHRpbWUgc28gcGF0aCByZXNvbHV0aW9uIGlzIGltbXVuZSB0b1xuICAvLyBjd2QtZHJpZnQgYmV0d2VlbiBkaXNjdXNzIGFuZCBjaGVja0F1dG9TdGFydEFmdGVyRGlzY3Vzcy5cbiAgLy8gVE9ETyhDMyk6IGJhc2VQYXRoIGJlY29tZXMgcmVkdW5kYW50IG9uY2UgYWxsIGNvbnN1bWVycyBtaWdyYXRlIHRvIHNjb3BlLlxuICBzY29wZTogTWlsZXN0b25lU2NvcGU7XG4gIC8vIEgxOiByZXRyeSBjb3VudGVyIGZvciBHYXRlIDFiIHBsYW4tYmxvY2tlZCByZWNvdmVyeS4gQ2FwcGVkIGF0XG4gIC8vIE1BWF9QTEFOX0JMT0NLRURfUkVDT1ZFUklFUyB0byBwcmV2ZW50IGluZmluaXRlIHJlY292ZXJ5IGxvb3BzICgjNTAxMikuXG4gIHBsYW5CbG9ja2VkUmVjb3ZlcnlDb3VudDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ0RlZXBQcm9qZWN0U2V0dXBFbnRyeSB7XG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQ7XG4gIHBpOiBFeHRlbnNpb25BUEk7XG4gIGJhc2VQYXRoOiBzdHJpbmc7XG4gIHN0ZXA/OiBib29sZWFuO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgc2Vzc2lvbklkPzogc3RyaW5nO1xuICBjdXJyZW50VW5pdFR5cGU/OiBzdHJpbmc7XG4gIGN1cnJlbnRVbml0SWQ/OiBzdHJpbmc7XG59XG5cbi8vICM0NTczOiBjYXAgZm9yIGhvdyBtYW55IHRpbWVzIHdlIG51ZGdlIHRoZSBMTE0gYWZ0ZXIgYSBwcmVtYXR1cmUgcmVhZHlcbi8vIHBocmFzZSBiZWZvcmUgZ2l2aW5nIHVwIGFuZCBhc2tpbmcgdGhlIHVzZXIgdG8gcmUtcnVuIC9nc2QuXG5jb25zdCBNQVhfUkVBRFlfUkVKRUNUUyA9IDI7XG5cbi8vIEgxICgjNTAxMik6IGNhcCBmb3IgR2F0ZSAxYiBwbGFuLWJsb2NrZWQgcmVjb3ZlcnkgaGludHMuIEFmdGVyIHRoaXMgbWFueVxuLy8gY29uc2VjdXRpdmUgcmVjb3ZlcnkgYXR0ZW1wdHMgdGhlIGxvb3AgaXMgc3RvcHBlZCBhbmQgdGhlIHVzZXIgaXMgZGlyZWN0ZWRcbi8vIHRvIGludmVzdGlnYXRlIG1hbnVhbGx5LlxuY29uc3QgTUFYX1BMQU5fQkxPQ0tFRF9SRUNPVkVSSUVTID0gMztcblxuLy8gIzQ1NzM6IG1hdGNoZXMgdGhlIGNhbm9uaWNhbCByZWFkeSBwaHJhc2UgdGhlIGRpc2N1c3MgcHJvbXB0IGFza3MgdGhlIExMTVxuLy8gdG8gZW1pdC4gQWNjZXB0cyBhbnkgTS1wcmVmaXhlZCBtaWxlc3RvbmUgSUQgKHRocmVlIGRpZ2l0cyArIG9wdGlvbmFsXG4vLyBzdWZmaXgpIHdpdGggb3B0aW9uYWwgdHJhaWxpbmcgcHVuY3R1YXRpb24uXG5jb25zdCBSRUFEWV9QSFJBU0VfUkUgPSAvXFxiTWlsZXN0b25lXFxzK01cXGR7M31bQS1aMC05LV0qXFxzK3JlYWR5XFwuPy9pO1xuXG5jb25zdCBwZW5kaW5nQXV0b1N0YXJ0TWFwID0gbmV3IE1hcDxzdHJpbmcsIFBlbmRpbmdBdXRvU3RhcnRFbnRyeT4oKTtcbmNvbnN0IHBlbmRpbmdEZWVwUHJvamVjdFNldHVwTWFwID0gbmV3IE1hcDxzdHJpbmcsIFBlbmRpbmdEZWVwUHJvamVjdFNldHVwRW50cnk+KCk7XG5jb25zdCBVU0VSX0RSSVZFTl9ERUVQX1NFVFVQX1VOSVRTID0gbmV3IFNldChbXG4gIFwiZGlzY3Vzcy1wcm9qZWN0XCIsXG4gIFwiZGlzY3Vzcy1yZXF1aXJlbWVudHNcIixcbiAgXCJyZXNlYXJjaC1kZWNpc2lvblwiLFxuXSk7XG5leHBvcnQgY29uc3QgRk9SRUdST1VORF9ERUVQX1NFVFVQX1JVTEVfTkFNRVMgPSBuZXcgU2V0KFtcbiAgXCJkZWVwOiBwcmUtcGxhbm5pbmcgKG5vIHdvcmtmbG93IHByZWZzKSBcdTIxOTIgd29ya2Zsb3ctcHJlZmVyZW5jZXNcIixcbiAgXCJkZWVwOiBwcmUtcGxhbm5pbmcgKG5vIFBST0pFQ1QpIFx1MjE5MiBkaXNjdXNzLXByb2plY3RcIixcbiAgXCJkZWVwOiBwcmUtcGxhbm5pbmcgKG5vIFJFUVVJUkVNRU5UUykgXHUyMTkyIGRpc2N1c3MtcmVxdWlyZW1lbnRzXCIsXG4gIFwiZGVlcDogcHJlLXBsYW5uaW5nIChubyByZXNlYXJjaCBkZWNpc2lvbikgXHUyMTkyIHJlc2VhcmNoLWRlY2lzaW9uXCIsXG5dKTtcbmNvbnN0IExFR0FDWV9ERUVQX1NFVFVQX1BTRVVET19NSUxFU1RPTkVfRElSUyA9IG5ldyBTZXQoW1xuICBcIlBST0pFQ1RcIixcbiAgXCJSRVFVSVJFTUVOVFNcIixcbiAgXCJSRVNFQVJDSC1ERUNJU0lPTlwiLFxuICBcIlJFU0VBUkNILVBST0pFQ1RcIixcbiAgXCJXT1JLRkxPVy1QUkVGU1wiLFxuXSk7XG5jb25zdCBGT1JFR1JPVU5EX0RFRVBfU0VUVVBfUVVFU1RJT05fUE9MSUNZID0gYCMjIEZvcmVncm91bmQgRGVlcCBTZXR1cCBRdWVzdGlvbiBQb2xpY3lcblxuVGhpcyBzdGFnZSBpcyBydW5uaW5nIGluc2lkZSB0aGUgZm9yZWdyb3VuZCBcXGAvZ3NkIG5ldy1wcm9qZWN0IC0tZGVlcFxcYCBpbnRlcnZpZXcuIEFzayB1c2VyIHF1ZXN0aW9ucyBpbiBwbGFpbiBjaGF0IG9ubHkuXG5cbi0gRG8gTk9UIGNhbGwgXFxgYXNrX3VzZXJfcXVlc3Rpb25zXFxgLCBcXGBBc2tVc2VyUXVlc3Rpb25cXGAsIG9yIFRvb2xTZWFyY2ggdG8gZGlzY292ZXIgdXNlci1pbnB1dCB0b29scy5cbi0gQXNrIG9uZSBmb2N1c2VkIHJvdW5kLCB0aGVuIHN0b3AgYW5kIHdhaXQgZm9yIHRoZSB1c2VyJ3Mgbm9ybWFsIGNoYXQgcmVzcG9uc2UuYDtcblxuLyoqXG4gKiBCYWNrd2FyZC1jb21wYXQgYnJpZGdlOiByZXR1cm5zIGEgbXV0YWJsZSByZWZlcmVuY2UgdG8gdGhlIGVudHJ5IG1hdGNoaW5nXG4gKiBiYXNlUGF0aCwgb3IgdGhlIHNvbGUgZW50cnkgd2hlbiBvbmx5IG9uZSBzZXNzaW9uIGV4aXN0cy5cbiAqIEV4cG9ydGVkIGZvciB0ZXN0aW5nIFx1MjAxNCBpbnRlcm5hbCB1c2Ugb25seSBpbiBwcm9kdWN0aW9uIGNvZGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfZ2V0UGVuZGluZ0F1dG9TdGFydChiYXNlUGF0aD86IHN0cmluZyk6IFBlbmRpbmdBdXRvU3RhcnRFbnRyeSB8IG51bGwge1xuICBpZiAoYmFzZVBhdGgpIHJldHVybiBwZW5kaW5nQXV0b1N0YXJ0TWFwLmdldChiYXNlUGF0aCkgPz8gbnVsbDtcbiAgaWYgKHBlbmRpbmdBdXRvU3RhcnRNYXAuc2l6ZSA9PT0gMSkgcmV0dXJuIHBlbmRpbmdBdXRvU3RhcnRNYXAudmFsdWVzKCkubmV4dCgpLnZhbHVlITtcbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGhhc05lc3RlZEZpbGVPclN5bWxpbmsoZGlyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByZWFkZGlyU3luYyhkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KSkge1xuICAgIGlmIChlbnRyeS5pc0ZpbGUoKSB8fCBlbnRyeS5pc1N5bWJvbGljTGluaygpKSByZXR1cm4gdHJ1ZTtcbiAgICBpZiAoZW50cnkuaXNEaXJlY3RvcnkoKSAmJiBoYXNOZXN0ZWRGaWxlT3JTeW1saW5rKGpvaW4oZGlyLCBlbnRyeS5uYW1lKSkpIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gY2xlYXJFbXB0eUxlZ2FjeURlZXBTZXR1cFBzZXVkb01pbGVzdG9uZXMoYmFzZVBhdGg6IHN0cmluZywgZW50cmllczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG1EaXIgPSBtaWxlc3RvbmVzRGlyKGJhc2VQYXRoKTtcbiAgY29uc3QgcmVtYWluaW5nOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICBpZiAoIUxFR0FDWV9ERUVQX1NFVFVQX1BTRVVET19NSUxFU1RPTkVfRElSUy5oYXMoZW50cnkpKSB7XG4gICAgICByZW1haW5pbmcucHVzaChlbnRyeSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBlbnRyeVBhdGggPSBqb2luKG1EaXIsIGVudHJ5KTtcbiAgICB0cnkge1xuICAgICAgaWYgKGhhc05lc3RlZEZpbGVPclN5bWxpbmsoZW50cnlQYXRoKSkge1xuICAgICAgICByZW1haW5pbmcucHVzaChlbnRyeSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgcm1TeW5jKGVudHJ5UGF0aCwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgICAgbG9nV2FybmluZyhcImd1aWRlZFwiLCBgU2VsZi1oZWFsOiByZW1vdmVkIGVtcHR5IGxlZ2FjeSBkZWVwIHNldHVwIHBzZXVkby1taWxlc3RvbmUgZGlyZWN0b3J5ICR7ZW50cnl9YCk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICByZW1haW5pbmcucHVzaChlbnRyeSk7XG4gICAgICBsb2dXYXJuaW5nKFwiZ3VpZGVkXCIsIGBsZWdhY3kgZGVlcCBzZXR1cCBwc2V1ZG8tbWlsZXN0b25lIGNsZWFudXAgZmFpbGVkIGZvciAke2VudHJ5fTogJHsoZXJyIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVtYWluaW5nO1xufVxuXG4vKipcbiAqIFN0b3JlIHBlbmRpbmcgYXV0by1zdGFydCBzdGF0ZSBmb3IgYSBwcm9qZWN0LlxuICogRXhwb3J0ZWQgZm9yIHRlc3RpbmcgKCMyOTg1KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZVBhdGg6IHN0cmluZywgZW50cnk6IHsgYmFzZVBhdGg6IHN0cmluZzsgbWlsZXN0b25lSWQ6IHN0cmluZzsgY3R4PzogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQ7IHBpPzogRXh0ZW5zaW9uQVBJOyBzdGVwPzogYm9vbGVhbjsgY3JlYXRlZEF0PzogbnVtYmVyIH0pOiB2b2lkIHtcbiAgY29uc3Qgd3MgPSBjcmVhdGVXb3Jrc3BhY2UoZW50cnkuYmFzZVBhdGgpO1xuICBjb25zdCBzY29wZSA9IHNjb3BlTWlsZXN0b25lKHdzLCBlbnRyeS5taWxlc3RvbmVJZCk7XG4gIHBlbmRpbmdBdXRvU3RhcnRNYXAuc2V0KGJhc2VQYXRoLCB7IGNyZWF0ZWRBdDogRGF0ZS5ub3coKSwgcGxhbkJsb2NrZWRSZWNvdmVyeUNvdW50OiAwLCAuLi5lbnRyeSwgc2NvcGUgfSBhcyBQZW5kaW5nQXV0b1N0YXJ0RW50cnkpO1xufVxuXG4vKipcbiAqIENsZWFyIHBlbmRpbmcgYXV0by1zdGFydCBzdGF0ZS5cbiAqIElmIGJhc2VQYXRoIGlzIGdpdmVuLCBjbGVhcnMgb25seSB0aGF0IHByb2plY3QuICBPdGhlcndpc2UgY2xlYXJzIGFsbC5cbiAqIEV4cG9ydGVkIGZvciB0ZXN0aW5nICgjMjk4NSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGVhclBlbmRpbmdBdXRvU3RhcnQoYmFzZVBhdGg/OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKGJhc2VQYXRoKSB7XG4gICAgcGVuZGluZ0F1dG9TdGFydE1hcC5kZWxldGUoYmFzZVBhdGgpO1xuICB9IGVsc2Uge1xuICAgIHBlbmRpbmdBdXRvU3RhcnRNYXAuY2xlYXIoKTtcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJQZW5kaW5nRGVlcFByb2plY3RTZXR1cChiYXNlUGF0aD86IHN0cmluZyk6IHZvaWQge1xuICBpZiAoYmFzZVBhdGgpIHtcbiAgICBwZW5kaW5nRGVlcFByb2plY3RTZXR1cE1hcC5kZWxldGUoYmFzZVBhdGgpO1xuICB9IGVsc2Uge1xuICAgIHBlbmRpbmdEZWVwUHJvamVjdFNldHVwTWFwLmNsZWFyKCk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZXR1cm5zIHRoZSBtaWxlc3RvbmVJZCBiZWluZyBkaXNjdXNzZWQgZm9yIHRoZSBnaXZlbiBwcm9qZWN0LlxuICogV2hlbiBiYXNlUGF0aCBpcyBvbWl0dGVkIGFuZCBvbmx5IG9uZSBzZXNzaW9uIGlzIGFjdGl2ZSwgcmV0dXJucyB0aGF0XG4gKiBzZXNzaW9uJ3MgbWlsZXN0b25lSWQgZm9yIGJhY2t3YXJkIGNvbXBhdGliaWxpdHkuICBSZXR1cm5zIG51bGwgd2hlblxuICogbXVsdGlwbGUgc2Vzc2lvbnMgZXhpc3QgYW5kIGJhc2VQYXRoIGlzIG5vdCBzcGVjaWZpZWQgKCMyOTg1IEJ1ZyA0KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldERpc2N1c3Npb25NaWxlc3RvbmVJZChiYXNlUGF0aD86IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoYmFzZVBhdGgpIHtcbiAgICByZXR1cm4gcGVuZGluZ0F1dG9TdGFydE1hcC5nZXQoYmFzZVBhdGgpPy5taWxlc3RvbmVJZCA/PyBudWxsO1xuICB9XG4gIC8vIEJhY2t3YXJkIGNvbXBhdDogcmV0dXJuIHRoZSBzb2xlIGVudHJ5J3MgbWlsZXN0b25lSWQsIG9yIG51bGwgaWYgYW1iaWd1b3VzXG4gIGlmIChwZW5kaW5nQXV0b1N0YXJ0TWFwLnNpemUgPT09IDEpIHtcbiAgICByZXR1cm4gcGVuZGluZ0F1dG9TdGFydE1hcC52YWx1ZXMoKS5uZXh0KCkudmFsdWUhLm1pbGVzdG9uZUlkO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBfZ2V0UGVuZGluZ0RlZXBQcm9qZWN0U2V0dXAoYmFzZVBhdGg/OiBzdHJpbmcpOiBQZW5kaW5nRGVlcFByb2plY3RTZXR1cEVudHJ5IHwgbnVsbCB7XG4gIGlmIChiYXNlUGF0aCkgcmV0dXJuIHBlbmRpbmdEZWVwUHJvamVjdFNldHVwTWFwLmdldChiYXNlUGF0aCkgPz8gbnVsbDtcbiAgaWYgKHBlbmRpbmdEZWVwUHJvamVjdFNldHVwTWFwLnNpemUgPT09IDEpIHJldHVybiBwZW5kaW5nRGVlcFByb2plY3RTZXR1cE1hcC52YWx1ZXMoKS5uZXh0KCkudmFsdWUhO1xuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gZ2V0RGVlcFNldHVwU2Vzc2lvbklkKGN0eDogRXh0ZW5zaW9uQ29udGV4dCB8IHVuZGVmaW5lZCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBjdHg/LnNlc3Npb25NYW5hZ2VyPy5nZXRTZXNzaW9uSWQ/LigpO1xufVxuXG5mdW5jdGlvbiBfZ2V0UGVuZGluZ0RlZXBQcm9qZWN0U2V0dXBGb3JDb250ZXh0KFxuICBjdHg6IEV4dGVuc2lvbkNvbnRleHQgfCB1bmRlZmluZWQsXG4gIGJhc2VQYXRoPzogc3RyaW5nLFxuKTogUGVuZGluZ0RlZXBQcm9qZWN0U2V0dXBFbnRyeSB8IG51bGwge1xuICBpZiAoYmFzZVBhdGgpIHtcbiAgICBjb25zdCBkaXJlY3QgPSBwZW5kaW5nRGVlcFByb2plY3RTZXR1cE1hcC5nZXQoYmFzZVBhdGgpO1xuICAgIGlmIChkaXJlY3QpIHJldHVybiBkaXJlY3Q7XG4gIH1cbiAgaWYgKCFjdHgpIHJldHVybiBfZ2V0UGVuZGluZ0RlZXBQcm9qZWN0U2V0dXAoKTtcblxuICBjb25zdCBzZXNzaW9uSWQgPSBnZXREZWVwU2V0dXBTZXNzaW9uSWQoY3R4KTtcbiAgaWYgKHNlc3Npb25JZCkge1xuICAgIGNvbnN0IG1hdGNoZXMgPSBbLi4ucGVuZGluZ0RlZXBQcm9qZWN0U2V0dXBNYXAudmFsdWVzKCldLmZpbHRlcihlbnRyeSA9PiBlbnRyeS5zZXNzaW9uSWQgPT09IHNlc3Npb25JZCk7XG4gICAgaWYgKG1hdGNoZXMubGVuZ3RoID09PSAxKSByZXR1cm4gbWF0Y2hlc1swXSE7XG4gIH1cblxuICBjb25zdCBtYXRjaGVzID0gWy4uLnBlbmRpbmdEZWVwUHJvamVjdFNldHVwTWFwLnZhbHVlcygpXS5maWx0ZXIoZW50cnkgPT4gZW50cnkuY3R4ID09PSBjdHgpO1xuICByZXR1cm4gbWF0Y2hlcy5sZW5ndGggPT09IDEgPyBtYXRjaGVzWzBdISA6IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRQZW5kaW5nRGVlcFByb2plY3RTZXR1cFVuaXRGb3JDb250ZXh0KFxuICBjdHg6IEV4dGVuc2lvbkNvbnRleHQgfCB1bmRlZmluZWQsXG4gIGJhc2VQYXRoPzogc3RyaW5nLFxuKTogeyB1bml0VHlwZTogc3RyaW5nOyB1bml0SWQ6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IGVudHJ5ID0gX2dldFBlbmRpbmdEZWVwUHJvamVjdFNldHVwRm9yQ29udGV4dChjdHgsIGJhc2VQYXRoKTtcbiAgaWYgKCFlbnRyeT8uY3VycmVudFVuaXRUeXBlIHx8ICFlbnRyeS5jdXJyZW50VW5pdElkKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICB1bml0VHlwZTogZW50cnkuY3VycmVudFVuaXRUeXBlLFxuICAgIHVuaXRJZDogZW50cnkuY3VycmVudFVuaXRJZCxcbiAgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0RGVlcFByb2plY3RTZXR1cEZvcmVncm91bmQoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIHN0ZXA/OiBib29sZWFuLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGVudHJ5OiBQZW5kaW5nRGVlcFByb2plY3RTZXR1cEVudHJ5ID0ge1xuICAgIGN0eCxcbiAgICBwaSxcbiAgICBiYXNlUGF0aCxcbiAgICBzdGVwLFxuICAgIGNyZWF0ZWRBdDogRGF0ZS5ub3coKSxcbiAgICBzZXNzaW9uSWQ6IGdldERlZXBTZXR1cFNlc3Npb25JZChjdHgpLFxuICB9O1xuICBwZW5kaW5nRGVlcFByb2plY3RTZXR1cE1hcC5zZXQoYmFzZVBhdGgsIGVudHJ5KTtcbiAgYXdhaXQgZGlzcGF0Y2hOZXh0RGVlcFByb2plY3RTZXR1cFN0YWdlKGVudHJ5KTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNoZWNrRGVlcFByb2plY3RTZXR1cEFmdGVyVHVybihcbiAgX2V2ZW50OiB7IG1lc3NhZ2VzOiBhbnlbXSB9LFxuICBjdHg/OiBFeHRlbnNpb25Db250ZXh0LFxuICBiYXNlUGF0aD86IHN0cmluZyxcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBlbnRyeSA9IF9nZXRQZW5kaW5nRGVlcFByb2plY3RTZXR1cEZvckNvbnRleHQoY3R4LCBiYXNlUGF0aCk7XG4gIGlmICghZW50cnkpIHJldHVybiBmYWxzZTtcblxuICBpZiAoZW50cnkuY3VycmVudFVuaXRUeXBlICYmIGVudHJ5LmN1cnJlbnRVbml0SWQpIHtcbiAgICAvLyBUT0RPKEMtZnV0dXJlKTogUGVuZGluZ0RlZXBQcm9qZWN0U2V0dXBFbnRyeSBkb2VzIG5vdCBjYXJyeSBhIE1pbGVzdG9uZVNjb3BlXG4gICAgLy8gYmVjYXVzZSBkZWVwLXByb2plY3Qtc2V0dXAgdW5pdHMgc3BhbiBub24tbWlsZXN0b25lIHVuaXQgdHlwZXMgKGRpc2N1c3MtcHJvamVjdCxcbiAgICAvLyBkaXNjdXNzLXJlcXVpcmVtZW50cywgZXRjLikuICBNaWdyYXRlIHRvIHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3RGb3JTY29wZSBvbmNlXG4gICAgLy8gUGVuZGluZ0RlZXBQcm9qZWN0U2V0dXBFbnRyeSBpcyBleHRlbmRlZCB3aXRoIGEgc2NvcGUgZmllbGQuXG4gICAgY29uc3QgYXJ0aWZhY3RSZWFkeSA9IHZlcmlmeUV4cGVjdGVkQXJ0aWZhY3QoZW50cnkuY3VycmVudFVuaXRUeXBlLCBlbnRyeS5jdXJyZW50VW5pdElkLCBlbnRyeS5iYXNlUGF0aCk7XG4gICAgaWYgKCFhcnRpZmFjdFJlYWR5KSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLy8gUjI6IGEgZGVwdGgtdmVyaWZpY2F0aW9uIGdhdGUgaXMgc3RpbGwgcGVuZGluZyBcdTIwMTQgdGhlIExMTSBlbWl0dGVkIHRoZVxuICAvLyBjb25maXJtYXRpb24gcXVlc3Rpb24gKHZpYSBhc2tfdXNlcl9xdWVzdGlvbnMgb3IgcGxhaW4gY2hhdCkgYnV0IHRoZSB1c2VyXG4gIC8vIGhhcyBub3QgYXBwcm92ZWQgeWV0LiBSZXR1cm5pbmcgZmFsc2Uga2VlcHMgdGhlIGVudHJ5IGluIHRoZVxuICAvLyBwZW5kaW5nRGVlcFByb2plY3RTZXR1cE1hcCBzbyB0aGUgbmV4dCB1c2VyIG1lc3NhZ2UgY2FuIHJlc3VtZS5cbiAgY29uc3QgcGVuZGluZ0dhdGVJZCA9IGdldFBlbmRpbmdHYXRlKGVudHJ5LmJhc2VQYXRoKTtcbiAgaWYgKHBlbmRpbmdHYXRlSWQpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICByZXR1cm4gZGlzcGF0Y2hOZXh0RGVlcFByb2plY3RTZXR1cFN0YWdlKGVudHJ5KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2hOZXh0RGVlcFByb2plY3RTZXR1cFN0YWdlKGVudHJ5OiBQZW5kaW5nRGVlcFByb2plY3RTZXR1cEVudHJ5KTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoZW50cnkuYmFzZVBhdGgpPy5wcmVmZXJlbmNlcztcbiAgY29uc3QgeyBESVNQQVRDSF9SVUxFUywgaGFzUGVuZGluZ0RlZXBTdGFnZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9hdXRvLWRpc3BhdGNoLmpzXCIpO1xuXG4gIGlmICghaGFzUGVuZGluZ0RlZXBTdGFnZShwcmVmcywgZW50cnkuYmFzZVBhdGgpKSB7XG4gICAgcGVuZGluZ0RlZXBQcm9qZWN0U2V0dXBNYXAuZGVsZXRlKGVudHJ5LmJhc2VQYXRoKTtcbiAgICBzY2hlZHVsZUF1dG9TdGFydEFmdGVySWRsZShlbnRyeS5jdHgsIGVudHJ5LnBpLCBlbnRyeS5iYXNlUGF0aCwgZmFsc2UsIHsgc3RlcDogZW50cnkuc3RlcCB9KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGNvbnN0IHN0YXRlID0gYXdhaXQgZGVyaXZlU3RhdGUoZW50cnkuYmFzZVBhdGgpO1xuICBjb25zdCBkaXNwYXRjaEN0eCA9IHtcbiAgICBiYXNlUGF0aDogZW50cnkuYmFzZVBhdGgsXG4gICAgbWlkOiBcIlBST0pFQ1RcIixcbiAgICBtaWRUaXRsZTogXCJQcm9qZWN0IHNldHVwXCIsXG4gICAgc3RhdGUsXG4gICAgcHJlZnMsXG4gICAgLy8gQ2xhdWRlIENvZGUgY3VycmVudGx5IHN1cmZhY2VzIHdvcmtmbG93LU1DUCBxdWVzdGlvbiBjYWxscyBhcyB0b29sLXJlcXVlc3RcbiAgICAvLyBVSSB0aGF0IGNhbiBiZSBjYW5jZWxsZWQgb3V0c2lkZSB0aGUgbm9ybWFsIGNoYXQgZmxvdy4gRHVyaW5nIHRoZVxuICAgIC8vIGZvcmVncm91bmQgZGVlcCBwcm9qZWN0IHNldHVwIGludGVydmlldywga2VlcCB1c2VyIGlucHV0IGluIHBsYWluIGNoYXQgc29cbiAgICAvLyBgL2dzZCBuZXctcHJvamVjdCAtLWRlZXBgIGNhbm5vdCBib3VuY2UgdGhyb3VnaCBjYW5jZWxsZWQgdG9vbCByZXF1ZXN0cy5cbiAgICBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlOiBcImZhbHNlXCIgYXMgY29uc3QsXG4gIH07XG4gIGxldCByZXN1bHQ6IEF3YWl0ZWQ8UmV0dXJuVHlwZTwodHlwZW9mIERJU1BBVENIX1JVTEVTKVtudW1iZXJdW1wibWF0Y2hcIl0+PiA9IG51bGw7XG4gIGZvciAoY29uc3QgcnVsZSBvZiBESVNQQVRDSF9SVUxFUykge1xuICAgIC8vIE9ubHkgZXZhbHVhdGUgZm9yZWdyb3VuZCBzZXR1cCBnYXRlcyBoZXJlLiBMYXRlciBkZWVwIHJ1bGVzIHN1Y2ggYXNcbiAgICAvLyByZXNlYXJjaC1wcm9qZWN0IGhhdmUgZGlzcGF0Y2gtdGltZSBzaWRlIGVmZmVjdHMgKGUuZy4gY2xhaW1pbmcgYW5cbiAgICAvLyBpbmZsaWdodCBtYXJrZXIpIGFuZCBtdXN0IGJlIGxlZnQgdG8gYXV0by1tb2RlIG9uY2UgdGhlIGludGVydmlldyBpc1xuICAgIC8vIGNvbXBsZXRlLlxuICAgIGlmICghRk9SRUdST1VORF9ERUVQX1NFVFVQX1JVTEVfTkFNRVMuaGFzKHJ1bGUubmFtZSkpIGNvbnRpbnVlO1xuICAgIHJlc3VsdCA9IGF3YWl0IHJ1bGUubWF0Y2goZGlzcGF0Y2hDdHgpO1xuICAgIGlmIChyZXN1bHQpIGJyZWFrO1xuICB9XG5cbiAgaWYgKCFyZXN1bHQgfHwgcmVzdWx0LmFjdGlvbiAhPT0gXCJkaXNwYXRjaFwiKSB7XG4gICAgaWYgKHJlc3VsdD8uYWN0aW9uID09PSBcInN0b3BcIikge1xuICAgICAgZW50cnkuY3R4LnVpLm5vdGlmeShyZXN1bHQucmVhc29uLCByZXN1bHQubGV2ZWwpO1xuICAgIH0gZWxzZSBpZiAoaGFzUGVuZGluZ0RlZXBTdGFnZShwcmVmcywgZW50cnkuYmFzZVBhdGgpKSB7XG4gICAgICBwZW5kaW5nRGVlcFByb2plY3RTZXR1cE1hcC5kZWxldGUoZW50cnkuYmFzZVBhdGgpO1xuICAgICAgc2NoZWR1bGVBdXRvU3RhcnRBZnRlcklkbGUoZW50cnkuY3R4LCBlbnRyeS5waSwgZW50cnkuYmFzZVBhdGgsIGZhbHNlLCB7IHN0ZXA6IGVudHJ5LnN0ZXAgfSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgaWYgKCFVU0VSX0RSSVZFTl9ERUVQX1NFVFVQX1VOSVRTLmhhcyhyZXN1bHQudW5pdFR5cGUpKSB7XG4gICAgcGVuZGluZ0RlZXBQcm9qZWN0U2V0dXBNYXAuZGVsZXRlKGVudHJ5LmJhc2VQYXRoKTtcbiAgICBzY2hlZHVsZUF1dG9TdGFydEFmdGVySWRsZShlbnRyeS5jdHgsIGVudHJ5LnBpLCBlbnRyeS5iYXNlUGF0aCwgZmFsc2UsIHsgc3RlcDogZW50cnkuc3RlcCB9KTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGVudHJ5LmN1cnJlbnRVbml0VHlwZSA9IHJlc3VsdC51bml0VHlwZTtcbiAgZW50cnkuY3VycmVudFVuaXRJZCA9IHJlc3VsdC51bml0SWQ7XG4gIGVudHJ5LmNyZWF0ZWRBdCA9IERhdGUubm93KCk7XG4gIGF3YWl0IGRpc3BhdGNoV29ya2Zsb3coXG4gICAgZW50cnkucGksXG4gICAgYCR7cmVzdWx0LnByb21wdH1cXG5cXG4ke0ZPUkVHUk9VTkRfREVFUF9TRVRVUF9RVUVTVElPTl9QT0xJQ1l9YCxcbiAgICBcImdzZC1ydW5cIixcbiAgICBlbnRyeS5jdHgsXG4gICAgcmVzdWx0LnVuaXRUeXBlLFxuICApO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIENhbGxlZCBmcm9tIGFnZW50X2VuZCB0byBjaGVjayBpZiBhdXRvLW1vZGUgc2hvdWxkIHN0YXJ0IGFmdGVyIGRpc2N1c3MgKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja0F1dG9TdGFydEFmdGVyRGlzY3VzcygpOiBib29sZWFuIHtcbiAgY29uc3QgZW50cnkgPSBfZ2V0UGVuZGluZ0F1dG9TdGFydCgpO1xuICBpZiAoIWVudHJ5KSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgeyBjdHgsIHBpLCBiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHN0ZXAgfSA9IGVudHJ5O1xuXG4gIC8vIEdhdGUgMTogUHJpbWFyeSBtaWxlc3RvbmUgbXVzdCBoYXZlIENPTlRFWFQubWQgb3IgUk9BRE1BUC5tZFxuICAvLyBUaGUgXCJkaXNjdXNzXCIgcGF0aCBjcmVhdGVzIENPTlRFWFQubWQ7IHRoZSBcInBsYW5cIiBwYXRoIGNyZWF0ZXMgUk9BRE1BUC5tZC5cbiAgLy8gVXNlIHBpbm5lZCBzY29wZSAoaW1tdW5lIHRvIGN3ZC1kcmlmdCkgZm9yIGV4aXN0ZW5jZSBjaGVja3MuXG4gIGNvbnN0IGNvbnRleHRGaWxlUGF0aCA9IGVudHJ5LnNjb3BlLmNvbnRleHRGaWxlKCk7XG4gIGNvbnN0IHJvYWRtYXBGaWxlUGF0aCA9IGVudHJ5LnNjb3BlLnJvYWRtYXBGaWxlKCk7XG4gIGNvbnN0IGNvbnRleHRGaWxlID0gZXhpc3RzU3luYyhjb250ZXh0RmlsZVBhdGgpID8gY29udGV4dEZpbGVQYXRoIDogbnVsbDtcbiAgY29uc3Qgcm9hZG1hcEZpbGUgPSBleGlzdHNTeW5jKHJvYWRtYXBGaWxlUGF0aCkgPyByb2FkbWFwRmlsZVBhdGggOiBudWxsO1xuICBpZiAoIWNvbnRleHRGaWxlICYmICFyb2FkbWFwRmlsZSkgcmV0dXJuIGZhbHNlOyAvLyBuZWl0aGVyIGFydGlmYWN0IHlldCBcdTIwMTQga2VlcCB3YWl0aW5nXG5cbiAgLy8gR2F0ZSAxYTogYSBkZXB0aC12ZXJpZmljYXRpb24gZ2F0ZSBpcyBzdGlsbCBwZW5kaW5nIGZvciBUSElTIG1pbGVzdG9uZSBcdTIwMTQgdGhlXG4gIC8vIExMTSBlbWl0dGVkIHRoZSBjb25maXJtYXRpb24gcXVlc3Rpb24gKHZpYSBhc2tfdXNlcl9xdWVzdGlvbnMgb3IgcGxhaW4gY2hhdClcbiAgLy8gYnV0IHRoZSB1c2VyIGhhcyBub3QgYW5zd2VyZWQgeWV0LiBBZHZhbmNpbmcgbm93IHdvdWxkIHNraXAgdGhlIGdhdGUgYW5kXG4gIC8vIHJhY2UgYWhlYWQgd2l0aCB1bnZlcmlmaWVkIGNvbnRleHQuXG4gIGNvbnN0IGJhc2VQYXRoRm9yR2F0ZSA9IGVudHJ5LnNjb3BlLndvcmtzcGFjZS5wcm9qZWN0Um9vdDtcbiAgY29uc3QgcGVuZGluZ0dhdGVJZCA9IGdldFBlbmRpbmdHYXRlKGJhc2VQYXRoRm9yR2F0ZSk7XG4gIGlmIChwZW5kaW5nR2F0ZUlkKSB7XG4gICAgY29uc3QgcGVuZGluZ01pbGVzdG9uZUlkID0gZXh0cmFjdERlcHRoVmVyaWZpY2F0aW9uTWlsZXN0b25lSWQocGVuZGluZ0dhdGVJZCk7XG4gICAgLy8gQmxvY2sgYWR2YW5jZW1lbnQgaWYgdGhlIGdhdGUgaXMgZm9yIFRISVMgbWlsZXN0b25lLCBPUiBpZiBpdCdzIGFcbiAgICAvLyBwcm9qZWN0L3JlcXVpcmVtZW50cyBnYXRlIChubyBtaWxlc3RvbmUgaWQgZW5jb2RlZCkgZm9yIHRoZSBkZWVwIHNldHVwIGZsb3cuXG4gICAgY29uc3QgaXNQcm9qZWN0R2F0ZSA9XG4gICAgICBwZW5kaW5nR2F0ZUlkID09PSBcImRlcHRoX3ZlcmlmaWNhdGlvbl9wcm9qZWN0X2NvbmZpcm1cIiB8fFxuICAgICAgcGVuZGluZ0dhdGVJZCA9PT0gXCJkZXB0aF92ZXJpZmljYXRpb25fcmVxdWlyZW1lbnRzX2NvbmZpcm1cIiB8fFxuICAgICAgcGVuZGluZ0dhdGVJZCA9PT0gXCJkZXB0aF92ZXJpZmljYXRpb25fcmVzZWFyY2hfZGVjaXNpb25fY29uZmlybVwiO1xuICAgIGlmIChwZW5kaW5nTWlsZXN0b25lSWQgPT09IG1pbGVzdG9uZUlkIHx8IGlzUHJvamVjdEdhdGUpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICAvLyBHYXRlIDFiOiBEaXNjcmltaW5hdGUgcGxhbi1ibG9ja2VkIGZyb20gZGlzY3Vzcy1pbmNvbXBsZXRlIHdoZW4gdGhlIERCIHJvdyBpcyBxdWV1ZWQuXG4gIC8vIElmIHRoZSBEQiBpcyBhdmFpbGFibGUgYW5kIHRoZSByb3cgaXMgc3RpbGwgXCJxdWV1ZWRcIiBidXQgQ09OVEVYVC5tZCBhbHJlYWR5IGV4aXN0cyBvblxuICAvLyBkaXNrLCB0aGUgZGlzY3VzcyBwaGFzZSBjb21wbGV0ZWQgYnV0IGdzZF9wbGFuX21pbGVzdG9uZSB3YXMgaGFyZC1ibG9ja2VkIGJ5IHRoZVxuICAvLyBkZXB0aC12ZXJpZmljYXRpb24gZ2F0ZS4gIEVtaXQgYSByZWNvdmVyeSBoaW50IHNvIHRoZSBuZXh0IGFnZW50IHR1cm4gY2FuIHJldHJ5XG4gIC8vIGdzZF9wbGFuX21pbGVzdG9uZSwgdGhlbiByZXR1cm4gZmFsc2UgKGtlZXAgYmxvY2tpbmcgYXV0by1zdGFydCkuXG4gIC8vIElmIENPTlRFWFQubWQgZG9lcyBub3QgZXhpc3QgKGRpc2N1c3MtaW5jb21wbGV0ZSksIEdhdGUgMSBhbHJlYWR5IGJsb2NrZWQgYWJvdmUuXG4gIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICBjb25zdCBkYlJvdyA9IGdldE1pbGVzdG9uZShtaWxlc3RvbmVJZCk7XG4gICAgaWYgKGRiUm93Py5zdGF0dXMgPT09IFwicXVldWVkXCIgJiYgY29udGV4dEZpbGUpIHtcbiAgICAgIGlmIChlbnRyeS5wbGFuQmxvY2tlZFJlY292ZXJ5Q291bnQgPj0gTUFYX1BMQU5fQkxPQ0tFRF9SRUNPVkVSSUVTKSB7XG4gICAgICAgIC8vIEgxOiByZWNvdmVyeSBsb29wIGNhcCByZWFjaGVkIFx1MjAxNCBzdG9wIHRyaWdnZXJpbmcgbmV3IHR1cm5zLCBlc2NhbGF0ZSB0byB1c2VyLlxuICAgICAgICBsb2dXYXJuaW5nKFxuICAgICAgICAgIFwiZ3VpZGVkXCIsXG4gICAgICAgICAgYEdhdGUgMWI6IG1pbGVzdG9uZSAke21pbGVzdG9uZUlkfSBwbGFuLWJsb2NrZWQgcmVjb3ZlcnkgbGltaXQgcmVhY2hlZCBgICtcbiAgICAgICAgICBgKCR7ZW50cnkucGxhbkJsb2NrZWRSZWNvdmVyeUNvdW50fS8ke01BWF9QTEFOX0JMT0NLRURfUkVDT1ZFUklFU30pOyBlc2NhbGF0aW5nIHRvIHVzZXJgLFxuICAgICAgICApO1xuICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgIGBNaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0gcGxhbl9taWxlc3RvbmUgaGFzIGJlZW4gYmxvY2tlZCAke2VudHJ5LnBsYW5CbG9ja2VkUmVjb3ZlcnlDb3VudH0gdGltZXMuIGAgK1xuICAgICAgICAgIGBSZS1ydW4gL2dzZCB0byByZXNldCB0aGUgcmVjb3ZlcnkgY291bnRlciwgb3IgcnVuIC9nc2QtZGVidWcgdG8gZGlhZ25vc2Ugd2l0aG91dCByZXNldHRpbmcuYCxcbiAgICAgICAgICBcImVycm9yXCIsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICAgIGxvZ1dhcm5pbmcoXG4gICAgICAgIFwiZ3VpZGVkXCIsXG4gICAgICAgIGBHYXRlIDFiOiBtaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0gcXVldWVkIHdpdGggQ09OVEVYVC5tZCBwcmVzZW50IFx1MjAxNCBgICtcbiAgICAgICAgYHBsYW5fbWlsZXN0b25lIHdhcyBibG9ja2VkOyBlbWl0dGluZyByZWNvdmVyeSBoaW50IGAgK1xuICAgICAgICBgKGF0dGVtcHQgJHtlbnRyeS5wbGFuQmxvY2tlZFJlY292ZXJ5Q291bnQgKyAxfS8ke01BWF9QTEFOX0JMT0NLRURfUkVDT1ZFUklFU30pYCxcbiAgICAgICk7XG4gICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICBgTWlsZXN0b25lICR7bWlsZXN0b25lSWR9OiBjb250ZXh0IGZpbGUgZXhpc3RzIGJ1dCBtaWxlc3RvbmUgaXMgc3RpbGwgcXVldWVkLiBgICtcbiAgICAgICAgYFJldHJ5aW5nIGdzZF9wbGFuX21pbGVzdG9uZSB0byBjb21wbGV0ZSB0aGUgYmxvY2tlZCBwbGFubmluZyBzdGVwLmAsXG4gICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHBpLnNlbmRNZXNzYWdlKFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGN1c3RvbVR5cGU6IFwiZ3NkLXBsYW4tbWlsZXN0b25lLWJsb2NrZWQtcmVjb3ZlcnlcIixcbiAgICAgICAgICAgIGNvbnRlbnQ6XG4gICAgICAgICAgICAgIGBNaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0gaGFzICR7Y29udGV4dEZpbGV9IG9uIGRpc2sgYnV0IGl0cyBEQiByb3cgaXMgc3RpbGwgYCArXG4gICAgICAgICAgICAgIGBcInF1ZXVlZFwiLiBUaGUgZ3NkX3BsYW5fbWlsZXN0b25lIHRvb2wgd2FzIHByZXZpb3VzbHkgYmxvY2tlZCBieSB0aGUgYCArXG4gICAgICAgICAgICAgIGBkZXB0aC12ZXJpZmljYXRpb24gZ2F0ZS4gQ2FsbCBnc2RfcGxhbl9taWxlc3RvbmUgbm93IHRvIGNvbXBsZXRlIHRoZSBgICtcbiAgICAgICAgICAgICAgYHBsYW5uaW5nIHBoYXNlLmAsXG4gICAgICAgICAgICBkaXNwbGF5OiBmYWxzZSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgICAgICAgKTtcbiAgICAgICAgLy8gSW5jcmVtZW50IG9ubHkgYWZ0ZXIgYSBzdWNjZXNzZnVsIGRpc3BhdGNoIHNvIHRyYW5zaWVudCBzZW5kTWVzc2FnZVxuICAgICAgICAvLyBmYWlsdXJlcyBkbyBub3QgY29uc3VtZSByZWNvdmVyeSBidWRnZXQuXG4gICAgICAgIGVudHJ5LnBsYW5CbG9ja2VkUmVjb3ZlcnlDb3VudCArPSAxO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dXYXJuaW5nKFwiZ3VpZGVkXCIsIGBHYXRlIDFiIHJlY292ZXJ5IHNlbmRNZXNzYWdlIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICAvLyBHYXRlIDI6IFNUQVRFLm1kIG11c3QgZXhpc3QgXHUyMDE0IHdyaXR0ZW4gYXMgdGhlIGxhc3Qgc3RlcCBpbiB0aGUgZGlzY3Vzc1xuICAvLyBvdXRwdXQgcGhhc2UuIFRoaXMgcHJldmVudHMgYXV0by1zdGFydCBmcm9tIGZpcmluZyBkdXJpbmcgUGhhc2UgM1xuICAvLyAoc2VxdWVudGlhbCByZWFkaW5lc3MgZ2F0ZXMgZm9yIHJlbWFpbmluZyBtaWxlc3RvbmVzKSBpbiBtdWx0aS1taWxlc3RvbmVcbiAgLy8gZGlzY3Vzc2lvbnMsIHdoZXJlIE0wMDEtQ09OVEVYVC5tZCBleGlzdHMgYnV0IE0wMDIvTTAwMyBoYXZlbid0IGJlZW5cbiAgLy8gcHJvY2Vzc2VkIHlldC5cbiAgY29uc3Qgc3RhdGVGaWxlUGF0aCA9IGVudHJ5LnNjb3BlLnN0YXRlRmlsZSgpO1xuICBpZiAoIWV4aXN0c1N5bmMoc3RhdGVGaWxlUGF0aCkpIHJldHVybiBmYWxzZTsgLy8gZGlzY3Vzc2lvbiBub3QgZmluYWxpemVkIHlldFxuXG4gIC8vIEdhdGUgMzogTXVsdGktbWlsZXN0b25lIGNvbXBsZXRlbmVzcyB3YXJuaW5nXG4gIC8vIFBhcnNlIFBST0pFQ1QubWQgZm9yIG1pbGVzdG9uZSBzZXF1ZW5jZSwgd2FybiBpZiBhbnkgYXJlIG1pc3NpbmcgY29udGV4dC5cbiAgLy8gRG9uJ3QgYmxvY2sgXHUyMDE0IG1pbGVzdG9uZXMgY2FuIGJlIGludGVudGlvbmFsbHkgcXVldWVkIHdpdGhvdXQgY29udGV4dC5cbiAgY29uc3QgcHJvamVjdEZpbGUgPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZVBhdGgsIFwiUFJPSkVDVFwiKTtcbiAgbGV0IHByb2plY3RJZHM6IHN0cmluZ1tdID0gW107XG4gIGlmIChwcm9qZWN0RmlsZSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwcm9qZWN0Q29udGVudCA9IHJlYWRGaWxlU3luYyhwcm9qZWN0RmlsZSwgXCJ1dGYtOFwiKTtcbiAgICAgIHByb2plY3RJZHMgPSBwYXJzZU1pbGVzdG9uZVNlcXVlbmNlRnJvbVByb2plY3QocHJvamVjdENvbnRlbnQpO1xuICAgICAgaWYgKHByb2plY3RJZHMubGVuZ3RoID4gMSkge1xuICAgICAgICBjb25zdCBtaXNzaW5nID0gcHJvamVjdElkcy5maWx0ZXIoaWQgPT4ge1xuICAgICAgICAgIGNvbnN0IGhhc0NvbnRleHQgPSAhIXJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBpZCwgXCJDT05URVhUXCIpO1xuICAgICAgICAgIGNvbnN0IGhhc0RyYWZ0ID0gISFyZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgaWQsIFwiQ09OVEVYVC1EUkFGVFwiKTtcbiAgICAgICAgICBjb25zdCBoYXNEaXIgPSBleGlzdHNTeW5jKGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwibWlsZXN0b25lc1wiLCBpZCkpO1xuICAgICAgICAgIHJldHVybiAhaGFzQ29udGV4dCAmJiAhaGFzRHJhZnQgJiYgIWhhc0RpcjtcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChtaXNzaW5nLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYE11bHRpLW1pbGVzdG9uZSB2YWxpZGF0aW9uOiAke21pc3Npbmcuam9pbihcIiwgXCIpfSBub3QgZm91bmQgaW4gZmlsZXN5c3RlbS4gYCArXG4gICAgICAgICAgICBgRGlzY3Vzc2lvbiBtYXkgbm90IGhhdmUgY29tcGxldGVkIGFsbCByZWFkaW5lc3MgZ2F0ZXMuYCxcbiAgICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJndWlkZWRcIiwgYFBST0pFQ1QubWQgcGFyc2luZyBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7IH1cbiAgfVxuXG4gIC8vIEdhdGUgNDogRGlzY3Vzc2lvbiBtYW5pZmVzdCBwcm9jZXNzIHZlcmlmaWNhdGlvbiAobXVsdGktbWlsZXN0b25lIG9ubHkpXG4gIC8vIFRoZSBMTE0gd3JpdGVzIERJU0NVU1NJT04tTUFOSUZFU1QuanNvbiBhZnRlciBlYWNoIFBoYXNlIDMgZ2F0ZSBkZWNpc2lvbi5cbiAgLy8gV2hlbiBpdCBleGlzdHMsIHZhbGlkYXRlIGl0IGJlZm9yZSBhdXRvLXN0YXJ0aW5nLiBQcm9qZWN0IGhpc3RvcnkgYWxvbmUgaXNcbiAgLy8gbm90IGEgcmVsaWFibGUgc2lnbmFsIGZvciB0aGUgY3VycmVudCBkaXNjdXNzaW9uIG1vZGUuXG4gIGNvbnN0IG1hbmlmZXN0UGF0aCA9IGpvaW4oZW50cnkuc2NvcGUud29ya3NwYWNlLmNvbnRyYWN0LnByb2plY3RHc2QsIFwiRElTQ1VTU0lPTi1NQU5JRkVTVC5qc29uXCIpO1xuICBpZiAoZXhpc3RzU3luYyhtYW5pZmVzdFBhdGgpKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IG1hbmlmZXN0ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobWFuaWZlc3RQYXRoLCBcInV0Zi04XCIpKTtcbiAgICAgIGNvbnN0IHRvdGFsID0gdHlwZW9mIG1hbmlmZXN0LnRvdGFsID09PSBcIm51bWJlclwiID8gbWFuaWZlc3QudG90YWwgOiAwO1xuICAgICAgY29uc3QgY29tcGxldGVkID0gdHlwZW9mIG1hbmlmZXN0LmdhdGVzX2NvbXBsZXRlZCA9PT0gXCJudW1iZXJcIiA/IG1hbmlmZXN0LmdhdGVzX2NvbXBsZXRlZCA6IDA7XG5cbiAgICAgIGlmICh0b3RhbCA+IDEgJiYgY29tcGxldGVkIDwgdG90YWwpIHtcbiAgICAgICAgLy8gRGlzY3Vzc2lvbiBub3QgY29tcGxldGUgXHUyMDE0IGJsb2NrIGF1dG8tc3RhcnQgdW50aWwgYWxsIGdhdGVzIGFyZSBkb25lXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ3Jvc3MtY2hlY2sgbWFuaWZlc3QgbWlsZXN0b25lcyBhZ2FpbnN0IFBST0pFQ1QubWQgaWYgYXZhaWxhYmxlXG4gICAgICBpZiAocHJvamVjdElkcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGNvbnN0IG1hbmlmZXN0SWRzID0gT2JqZWN0LmtleXMobWFuaWZlc3QubWlsZXN0b25lcyA/PyB7fSk7XG4gICAgICAgIGNvbnN0IHVudHJhY2tlZCA9IHByb2plY3RJZHMuZmlsdGVyKGlkID0+ICFtYW5pZmVzdElkcy5pbmNsdWRlcyhpZCkpO1xuICAgICAgICBpZiAodW50cmFja2VkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgYERpc2N1c3Npb24gbWFuaWZlc3QgbWlzc2luZyBnYXRlcyBmb3I6ICR7dW50cmFja2VkLmpvaW4oXCIsIFwiKX1gLFxuICAgICAgICAgICAgXCJ3YXJuaW5nXCIsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImd1aWRlZFwiLCBgZGlzY3Vzc2lvbiBtYW5pZmVzdCB2ZXJpZmljYXRpb24gZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG4gIH1cblxuICAvLyBEcmFmdCBwcm9tb3Rpb24gY2xlYW51cDogaWYgYSBDT05URVhULURSQUZULm1kIGV4aXN0cyBhbG9uZ3NpZGUgdGhlIG5ld1xuICAvLyBDT05URVhULm1kLCBkZWxldGUgdGhlIGRyYWZ0IFx1MjAxNCBpdCdzIGJlZW4gY29uc3VtZWQgYnkgdGhlIGRpc2N1c3Npb24uXG4gIHRyeSB7XG4gICAgY29uc3QgZHJhZnRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBcIkNPTlRFWFQtRFJBRlRcIik7XG4gICAgaWYgKGRyYWZ0RmlsZSkgdW5saW5rU3luYyhkcmFmdEZpbGUpO1xuICB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJndWlkZWRcIiwgYENPTlRFWFQtRFJBRlQubWQgdW5saW5rIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTsgfVxuXG4gIC8vIENsZWFudXA6IHJlbW92ZSBkaXNjdXNzaW9uIG1hbmlmZXN0IGFmdGVyIGF1dG8tc3RhcnQgKG9ubHkgbmVlZGVkIGR1cmluZyBkaXNjdXNzaW9uKVxuICBpZiAoZXhpc3RzU3luYyhtYW5pZmVzdFBhdGgpKSB7XG4gICAgdHJ5IHsgdW5saW5rU3luYyhtYW5pZmVzdFBhdGgpOyB9IGNhdGNoIChlKSB7IGxvZ1dhcm5pbmcoXCJndWlkZWRcIiwgYG1hbmlmZXN0IHVubGluayBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7IH1cbiAgfVxuXG4gIC8vIFIzYjogYmVsdC1hbmQtc3VzcGVuZGVycyBmb3Igc2lsZW50IHJlZ2lzdHJhdGlvbiBmYWlsdXJlLiBUaGUgZGlzY3VzcyBmbG93XG4gIC8vIGZpbmlzaGVkIGFuZCBTVEFURS5tZCBleGlzdHMsIGJ1dCB0aGUgbWlsZXN0b25lIG1heSBuZXZlciBoYXZlIGxhbmRlZCBpblxuICAvLyB0aGUgREIuIFdpdGhvdXQgdGhpcyBndWFyZCwgdGhlIHVzZXIgc2VlcyBcIk1pbGVzdG9uZSBNMDAxIHJlYWR5LlwiIGFuZCB0aGVuXG4gIC8vIC9nc2QgcmVwb3J0cyBcIk5vIEFjdGl2ZSBNaWxlc3RvbmVcIi5cbiAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgIGNvbnN0IG1pbGVzdG9uZVJvdyA9IGdldE1pbGVzdG9uZShtaWxlc3RvbmVJZCk7XG4gICAgaWYgKCFtaWxlc3RvbmVSb3cpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgIGBNaWxlc3RvbmUgJHttaWxlc3RvbmVJZH06IGRpc2N1c3MgYXJ0aWZhY3RzIG9uIGRpc2sgYnV0IG5vIERCIHJvdyBleGlzdHMuIGAgK1xuICAgICAgICBgUFJPSkVDVC5tZCBtYXkgaGF2ZSBmYWlsZWQgdG8gcmVnaXN0ZXIgbWlsZXN0b25lcy4gYCArXG4gICAgICAgIGBSZS1zYXZlIFBST0pFQ1QubWQgd2l0aCBjYW5vbmljYWwgXCItIFsgXSBNMDAxOiBUaXRsZSBcdTIwMTQgT25lLWxpbmVyXCIgbGluZXMsIGAgK1xuICAgICAgICBgdGhlbiByZS1ydW4gL2dzZCB0byByZWNvdmVyLmAsXG4gICAgICAgIFwiZXJyb3JcIixcbiAgICAgICk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgcGVuZGluZ0F1dG9TdGFydE1hcC5kZWxldGUoYmFzZVBhdGgpO1xuICBjdHgudWkubm90aWZ5KGBNaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0gcmVhZHkuYCwgXCJzdWNjZXNzXCIpO1xuICBzY2hlZHVsZUF1dG9TdGFydEFmdGVySWRsZShjdHgsIHBpLCBiYXNlUGF0aCwgZmFsc2UsIHsgc3RlcCB9KTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogRXh0cmFjdCB0aGUgY29uY2F0ZW5hdGVkIHRleHQgY29udGVudCBmcm9tIGFuIGFzc2lzdGFudCBtZXNzYWdlLCB3aGV0aGVyIGl0XG4gKiBzdG9yZXMgY29udGVudCBhcyBhIHN0cmluZyBvciBhcyBhbiBhcnJheSBvZiB0ZXh0IGJsb2Nrcy5cbiAqL1xuZnVuY3Rpb24gZXh0cmFjdEFzc2lzdGFudFRleHQobXNnOiBhbnkpOiBzdHJpbmcge1xuICBpZiAoIW1zZykgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IGNvbnRlbnQgPSBtc2cuY29udGVudDtcbiAgaWYgKHR5cGVvZiBjb250ZW50ID09PSBcInN0cmluZ1wiKSByZXR1cm4gY29udGVudDtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGNvbnRlbnQpKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgYmxvY2sgb2YgY29udGVudCkge1xuICAgIGlmICghYmxvY2sgfHwgdHlwZW9mIGJsb2NrICE9PSBcIm9iamVjdFwiKSBjb250aW51ZTtcbiAgICBpZiAoYmxvY2sudHlwZSA9PT0gXCJ0ZXh0XCIgJiYgdHlwZW9mIGJsb2NrLnRleHQgPT09IFwic3RyaW5nXCIpIHBhcnRzLnB1c2goYmxvY2sudGV4dCk7XG4gIH1cbiAgcmV0dXJuIHBhcnRzLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogUmV0dXJuIHRydWUgaWYgdGhlIGFzc2lzdGFudCBtZXNzYWdlIGNvbnRhaW5zIGFueSB0b29sLXVzZSBibG9jay5cbiAqXG4gKiBUaGUgY2Fub25pY2FsIHBpLWFpIGBBc3Npc3RhbnRNZXNzYWdlLmNvbnRlbnRgIChzZWUgcGFja2FnZXMvcGktYWkvc3JjL3R5cGVzLnRzKVxuICogdXNlcyBgdHlwZTogXCJ0b29sQ2FsbFwiYCBhbmQgYHR5cGU6IFwic2VydmVyVG9vbFVzZVwiYCBmb3IgdG9vbCBpbnZvY2F0aW9ucyBcdTIwMTRcbiAqIGV2ZXJ5IHByb3ZpZGVyIChhbnRocm9waWMtZGlyZWN0LCBjbGF1ZGUtY29kZS1jbGksIG9wZW5haSwgZXRjLikgbm9ybWFsaXplc1xuICogaW5jb21pbmcgdG9vbCBibG9ja3MgaW50byB0aGVzZSB0d28gc2hhcGVzIGJlZm9yZSB0aGV5IHJlYWNoIGd1aWRlZC1mbG93LlxuICpcbiAqIFRoZSBBbnRocm9waWMgQVBJIHdpcmUgc2hhcGUgYFwidG9vbF91c2VcImAgLyBgXCJzZXJ2ZXJfdG9vbF91c2VcImAgZG9lcyBOT1QgYXBwZWFyXG4gKiBpbiB0aGUgaW50ZXJuYWwgQXNzaXN0YW50TWVzc2FnZSBcdTIwMTQgdGhvc2UgbGl0ZXJhbHMgYXJlIG9ubHkgdXNlZCB3aGVuIHNlbmRpbmdcbiAqIG1lc3NhZ2VzIGJhY2sgb3V0IHRvIHRoZSBBbnRocm9waWMgQVBJLiBNYXRjaGluZyB0aGVtIGhlcmUgd2FzIGEgbGF0ZW50IGJ1ZzpcbiAqIGBoYXNUb29sVXNlYCByZXR1cm5lZCBgZmFsc2VgIGZvciBldmVyeSByZWFsIHRvb2wgY2FsbCwgd2hpY2ggbGV0IHRoZVxuICogZW1wdHktdHVybiBudWRnZSBmaXJlIGFuZCBwcmUtZW1wdCBNQ1AgdG9vbHMgdGhhdCBibG9jayBvbiB0aGUgdXNlclxuICogKGUuZy4gYGFza191c2VyX3F1ZXN0aW9uc2ApLiBTZWUgaW52ZXN0aWdhdGlvbiBpbiBQUiBmb3IgIzQ2NTguXG4gKi9cbmZ1bmN0aW9uIGhhc1Rvb2xVc2UobXNnOiBhbnkpOiBib29sZWFuIHtcbiAgaWYgKCFtc2cpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgY29udGVudCA9IG1zZy5jb250ZW50O1xuICBpZiAoIUFycmF5LmlzQXJyYXkoY29udGVudCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGNvbnRlbnQuc29tZShcbiAgICAoYjogYW55KSA9PlxuICAgICAgYiAmJlxuICAgICAgdHlwZW9mIGIgPT09IFwib2JqZWN0XCIgJiZcbiAgICAgIChiLnR5cGUgPT09IFwidG9vbENhbGxcIiB8fCBiLnR5cGUgPT09IFwic2VydmVyVG9vbFVzZVwiKSxcbiAgKTtcbn1cblxuLyoqXG4gKiAjNDU3MyBcdTIwMTQgRGV0ZWN0IGFuZCByZWNvdmVyIGZyb20gdGhlIFwicmVhZHkgcGhyYXNlIHdpdGhvdXQgZmlsZXNcIiBmYWlsdXJlIG1vZGUuXG4gKlxuICogV2hlbiB0aGUgTExNIGVtaXRzIFwiTWlsZXN0b25lIHt7aWR9fSByZWFkeS5cIiBidXQgaGFzIG5vdCB3cml0dGVuIHRoZVxuICogbWlsZXN0b25lIENPTlRFWFQvUk9BRE1BUCBhcnRpZmFjdHMsIGBjaGVja0F1dG9TdGFydEFmdGVyRGlzY3VzcygpYCBzaWxlbnRseVxuICogcmV0dXJucyBmYWxzZSBhbmQgdGhlIG5leHQgL2dzZCBpbnZvY2F0aW9uIGxvb3BzIGludG8gdGhlIFwiQWxsIG1pbGVzdG9uZXNcbiAqIGNvbXBsZXRlXCIgd2FybmluZy5cbiAqXG4gKiBUaGlzIGZ1bmN0aW9uLCBjYWxsZWQgZnJvbSBgaGFuZGxlQWdlbnRFbmRgIGFmdGVyIGBjaGVja0F1dG9TdGFydEFmdGVyRGlzY3Vzc2BcbiAqIHJldHVybnMgZmFsc2UsIHBhdHRlcm4tbWF0Y2hlcyB0aGUgcmVhZHkgcGhyYXNlIG9uIHRoZSBsYXN0IGFzc2lzdGFudCBtZXNzYWdlLlxuICogSWYgaXQgZmlyZWQgQU5EIG5laXRoZXIgdGhlIGNhbm9uaWNhbCBNIyMjLUNPTlRFWFQubWQvTSMjIy1ST0FETUFQLm1kIG5vclxuICogbGVnYWN5IENPTlRFWFQubWQvUk9BRE1BUC5tZCBmaWxlcyBleGlzdCwgaXQ6XG4gKiAgIDEuIE5vdGlmaWVzIHRoZSB1c2VyIHRoYXQgdGhlIHNpZ25hbCB3YXMgcmVqZWN0ZWQuXG4gKiAgIDIuIEluamVjdHMgYSBzeXN0ZW0gbWVzc2FnZSB2aWEgYHBpLnNlbmRNZXNzYWdlKC4uLiwge3RyaWdnZXJUdXJuOnRydWV9KWBcbiAqICAgICAgdGVsbGluZyB0aGUgTExNIHRoZSBzaWduYWwgd2FzIHByZW1hdHVyZSBhbmQgdG8gZW1pdCB0aGUgd3JpdGVzIG5vdy5cbiAqICAgMy4gQ2FwcyBhdCBgTUFYX1JFQURZX1JFSkVDVFNgIHBlci1lbnRyeTsgYmV5b25kIHRoYXQsIGdpdmVzIHVwIGFuZCBhc2tzXG4gKiAgICAgIHRoZSB1c2VyIHRvIHJlLXJ1biAvZ3NkLlxuICpcbiAqIFJldHVybnMgdHJ1ZSB3aGVuIGEgbnVkZ2UgKG9yIGdpdmUtdXApIHdhcyBlbWl0dGVkLCBzaWduYWxpbmcgdGhlIGNhbGxlciB0b1xuICogc2tpcCBgcmVzb2x2ZUFnZW50RW5kYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1heWJlSGFuZGxlUmVhZHlQaHJhc2VXaXRob3V0RmlsZXMoZXZlbnQ6IHsgbWVzc2FnZXM6IGFueVtdIH0pOiBib29sZWFuIHtcbiAgY29uc3QgZW50cnkgPSBfZ2V0UGVuZGluZ0F1dG9TdGFydCgpO1xuICBpZiAoIWVudHJ5KSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHsgY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkIH0gPSBlbnRyeTtcblxuICAvLyBHYXRlOiBsYXN0IGFzc2lzdGFudCBtZXNzYWdlIG11c3QgY29udGFpbiB0aGUgcmVhZHkgcGhyYXNlXG4gIGNvbnN0IGxhc3RNc2cgPSBldmVudC5tZXNzYWdlc1tldmVudC5tZXNzYWdlcy5sZW5ndGggLSAxXTtcbiAgY29uc3QgdGV4dCA9IGV4dHJhY3RBc3Npc3RhbnRUZXh0KGxhc3RNc2cpO1xuICBpZiAoIVJFQURZX1BIUkFTRV9SRS50ZXN0KHRleHQpKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gQnVzdCBwYXRocy50cyBjYWNoZWQgZGlyIGxpc3RpbmdzIGJlZm9yZSBjaGVja2luZyBmb3IgZnJlc2ggd3JpdGVzLiBUaGVcbiAgLy8gTExNJ3MgV3JpdGUgdG9vbCBjYWxscyBkbyBub3QgaW52YWxpZGF0ZSBwYXRocy50cyBjYWNoZXMsIHNvIGEgc3RhbGVcbiAgLy8gbGlzdGluZyB0YWtlbiBiZWZvcmUgdGhlIG1pbGVzdG9uZSBkaXIgb3IgaXRzIENPTlRFWFQvUk9BRE1BUCBmaWxlc1xuICAvLyBleGlzdGVkIHdvdWxkIGZhbHNlbHkgcmVwb3J0IHRoZSBhcnRpZmFjdHMgYXMgbWlzc2luZyBhbmQgdHJpZ2dlciB0aGVcbiAgLy8gMy1zdHJpa2UgXCJyZWFkeSB3aXRob3V0IGZpbGVzXCIgYWJvcnQgZXZlbiB0aG91Z2ggdGhlIHdyaXRlcyBzdWNjZWVkZWQuXG4gIGNsZWFyUGF0aENhY2hlKCk7XG5cbiAgLy8gR2F0ZTogYXJ0aWZhY3RzIG11c3Qgc3RpbGwgYmUgbWlzc2luZyBcdTIwMTQgaWYgdGhleSBleGlzdCwgdGhlIGhhcHB5IHBhdGhcbiAgLy8gYWxyZWFkeSBmaXJlZCBhbmQgd2UgaGF2ZSBub3RoaW5nIHRvIGRvLlxuICBjb25zdCBjb250ZXh0RmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgXCJDT05URVhUXCIpO1xuICBjb25zdCByb2FkbWFwRmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgXCJST0FETUFQXCIpO1xuICBpZiAoY29udGV4dEZpbGUgfHwgcm9hZG1hcEZpbGUpIHJldHVybiBmYWxzZTtcblxuICAvLyBEaWFnbm9zdGljOiB3aGVuIHRoZSBjYWNoZWQgcmVzb2x2ZXIgcmVwb3J0cyBib3RoIGZpbGVzIG1pc3NpbmcsIGFsc28gcHJvYmVcbiAgLy8gdGhlIGNhbm9uaWNhbCBwYXRocyB3aXRoIHVuY2FjaGVkIGV4aXN0c1N5bmMgc28gd2UgY2FuIHRlbGwgd2hldGhlciB0aGVcbiAgLy8gcmVjb3ZlcnkgaXMgZmlyaW5nIG9uIHJlYWwtbWlzc2luZyBmaWxlcyBvciBhIHBhdGgtcmVzb2x1dGlvbiBtaXNzXG4gIC8vIChiYXNlUGF0aC9zeW1saW5rIG1pc21hdGNoLCBzdGFsZSBjYWNoZSBkZXNwaXRlIGFnZW50LWVuZC1yZWNvdmVyeSBmbHVzaCxcbiAgLy8gbGVnYWN5IGRlc2NyaXB0b3IgZGlyIG5vdCBtYXRjaGluZywgZXRjLikuXG4gIHRyeSB7XG4gICAgY29uc3QgbURpciA9IHJlc29sdmVNaWxlc3RvbmVQYXRoKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCk7XG4gICAgY29uc3QgY2Fub25pY2FsQ3R4ID0gbURpciA/IGpvaW4obURpciwgYCR7bWlsZXN0b25lSWR9LUNPTlRFWFQubWRgKSA6IG51bGw7XG4gICAgY29uc3QgY2Fub25pY2FsUm9hZG1hcCA9IG1EaXIgPyBqb2luKG1EaXIsIGAke21pbGVzdG9uZUlkfS1ST0FETUFQLm1kYCkgOiBudWxsO1xuICAgIGxvZ1dhcm5pbmcoXG4gICAgICBcImd1aWRlZFwiLFxuICAgICAgYHJlYWR5LXBocmFzZS1yZWplY3QgZGlhZ25vc3RpYyBtaWQ9JHttaWxlc3RvbmVJZH0gYmFzZVBhdGg9JHtiYXNlUGF0aH0gYCArXG4gICAgICBgbURpcj0ke21EaXIgPz8gXCJudWxsXCJ9IGAgK1xuICAgICAgYGNhbm9uaWNhbC1jdHg9JHtjYW5vbmljYWxDdHggPz8gXCJudWxsXCJ9IGN0eC1leGlzdHM9JHtjYW5vbmljYWxDdHggPyBleGlzdHNTeW5jKGNhbm9uaWNhbEN0eCkgOiBcIm4vYVwifSBgICtcbiAgICAgIGBjYW5vbmljYWwtcm9hZG1hcD0ke2Nhbm9uaWNhbFJvYWRtYXAgPz8gXCJudWxsXCJ9IHJvYWRtYXAtZXhpc3RzPSR7Y2Fub25pY2FsUm9hZG1hcCA/IGV4aXN0c1N5bmMoY2Fub25pY2FsUm9hZG1hcCkgOiBcIm4vYVwifWAsXG4gICAgKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ1dhcm5pbmcoXCJndWlkZWRcIiwgYHJlYWR5LXBocmFzZS1yZWplY3QgZGlhZ25vc3RpYyBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cblxuICBlbnRyeS5yZWFkeVJlamVjdENvdW50ID0gKGVudHJ5LnJlYWR5UmVqZWN0Q291bnQgPz8gMCkgKyAxO1xuXG4gIGlmIChlbnRyeS5yZWFkeVJlamVjdENvdW50ID4gTUFYX1JFQURZX1JFSkVDVFMpIHtcbiAgICAvLyBHaXZlIHVwOiBjbGVhciBzdGF0ZSBhbmQgdGVsbCB0aGUgdXNlciB0byByZS1ydW4gL2dzZC4gQXZvaWRzIGFuXG4gICAgLy8gaW5maW5pdGUgbnVkZ2UgbG9vcCB3aGVuIHRoZSBMTE0gbmV2ZXIgcHJvZHVjZXMgdGhlIHdyaXRlcy5cbiAgICBwZW5kaW5nQXV0b1N0YXJ0TWFwLmRlbGV0ZShiYXNlUGF0aCk7XG4gICAgY3R4LnVpLm5vdGlmeShcbiAgICAgIGBNaWxlc3RvbmUgJHttaWxlc3RvbmVJZH06IExMTSBzaWduYWxlZCBcInJlYWR5XCIgJHtlbnRyeS5yZWFkeVJlamVjdENvdW50fSB0aW1lcyB3aXRob3V0IHdyaXRpbmcgZmlsZXMuIGAgK1xuICAgICAgYFN0b3BwaW5nIGF1dG8tbnVkZ2UuIFJ1biAvZ3NkIHRvIHRyeSBhZ2Fpbi5gLFxuICAgICAgXCJlcnJvclwiLFxuICAgICk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBjb25zdCBjb250ZXh0UmVsID0gcmVsTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiQ09OVEVYVFwiKTtcbiAgY29uc3Qgcm9hZG1hcFJlbCA9IHJlbE1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBcIlJPQURNQVBcIik7XG4gIGN0eC51aS5ub3RpZnkoXG4gICAgYE1pbGVzdG9uZSAke21pbGVzdG9uZUlkfTogXCJyZWFkeVwiIHNpZ25hbCByZWplY3RlZCBcdTIwMTQgJHtjb250ZXh0UmVsfSBhbmQgJHtyb2FkbWFwUmVsfSBhcmUgbWlzc2luZy4gQXNraW5nIHRoZSBMTE0gdG8gY29tcGxldGUgdGhlIHdyaXRlcy5gLFxuICAgIFwid2FybmluZ1wiLFxuICApO1xuXG4gIGNvbnN0IG51ZGdlID1cbiAgICBgWW91IGVtaXR0ZWQgXCJNaWxlc3RvbmUgJHttaWxlc3RvbmVJZH0gcmVhZHkuXCIgYnV0IG5laXRoZXIgYCArXG4gICAgYCR7Y29udGV4dFJlbH0gbm9yICR7cm9hZG1hcFJlbH0gZXhpc3RzIG9uIGRpc2suIGAgK1xuICAgIGBUaGUgcmVhZHkgcGhyYXNlIGlzIGEgUE9TVC1XUklURSBzaWduYWwgYW5kIGhhcyBiZWVuIHJlamVjdGVkLiBgICtcbiAgICBgSW4gdGhpcyB0dXJuOiAoMSkgd3JpdGUgUFJPSkVDVC5tZCwgUkVRVUlSRU1FTlRTLm1kLCBhbmQgdGhlIG1pbGVzdG9uZSBgICtcbiAgICBgQ09OVEVYVC5tZCwgKDIpIGNhbGwgZ3NkX3BsYW5fbWlsZXN0b25lLCB0aGVuICgzKSBlbWl0IHRoZSByZWFkeSBwaHJhc2UuIGAgK1xuICAgIGBEbyBub3QgZGVzY3JpYmUgdGhlc2Ugc3RlcHMgXHUyMDE0IGV4ZWN1dGUgdGhlbSBhcyB0b29sIGNhbGxzLiBgICtcbiAgICBgVGhpcyBpcyByZXRyeSAke2VudHJ5LnJlYWR5UmVqZWN0Q291bnR9LyR7TUFYX1JFQURZX1JFSkVDVFN9OyBmdXJ0aGVyIGAgK1xuICAgIGBwcmVtYXR1cmUgc2lnbmFscyB3aWxsIGNsZWFyIHRoZSBzZXNzaW9uLmA7XG5cbiAgdHJ5IHtcbiAgICBwaS5zZW5kTWVzc2FnZShcbiAgICAgIHsgY3VzdG9tVHlwZTogXCJnc2QtcmVhZHktbm8tZmlsZXNcIiwgY29udGVudDogbnVkZ2UsIGRpc3BsYXk6IGZhbHNlIH0sXG4gICAgICB7IHRyaWdnZXJUdXJuOiB0cnVlIH0sXG4gICAgKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZ1dhcm5pbmcoXCJndWlkZWRcIiwgYHJlYWR5LXBocmFzZSBudWRnZSBzZW5kTWVzc2FnZSBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKipcbiAqICM0NTczIFx1MjAxNCBEZXRlY3QgYW5kIHJlY292ZXIgZnJvbSB0aGUgXCJhbm5vdW5jZXMgdG9vbCwgbmV2ZXIgY2FsbHMgaXRcIiBzdGFsbC5cbiAqXG4gKiBUaGUgTExNIGVtaXRzIHRleHQgbGlrZSBcIkknbGwgbm93IHdyaXRlIHRoZSBDT05URVhULm1kIGZpbGVcIiBidXQgdGhlIHR1cm5cbiAqIGVuZHMgd2l0aCB6ZXJvIHRvb2wtdXNlIGJsb2Nrcy4gVGhlIGhhcm5lc3MgaGFzIG5vIHBvc3QtdHVybiB0b29sLWNhbGxcbiAqIHZhbGlkYXRpb24sIHNvIHRoZSB1bml0IHByb21pc2UgcmVzb2x2ZXMgYW5kIHRoZSB1c2VyIHNlZXMgYSBzdGFsbGVkIHN0YXRlLlxuICpcbiAqIFRoaXMgZnVuY3Rpb24sIGNhbGxlZCBmcm9tIGBoYW5kbGVBZ2VudEVuZGAsIGluc3BlY3RzIHRoZSBsYXN0IGFzc2lzdGFudFxuICogbWVzc2FnZS4gSWYgQUxMIG9mIHRoZSBmb2xsb3dpbmcgYXJlIHRydWUsIGl0IGluamVjdHMgYSByZWNvdmVyeSBtZXNzYWdlOlxuICogICAtIFRleHQtb25seSAobm8gdG9vbC11c2UgYmxvY2tzKVxuICogICAtIENvbnRhaW5zIGEgY29tbWl0LWludGVudCBwaHJhc2UgKFwiSSdsbCB3cml0ZVwiLCBcIkknbGwgY2FsbFwiLCBldGMuKVxuICogICAtIEF1dG8tbW9kZSBpcyBhY3RpdmUgT1IgYSBkaXNjdXNzaW9uIGF1dG9zdGFydCBpcyBwZW5kaW5nXG4gKiAgIC0gYGVtcHR5VHVyblJldHJ5Q291bnRgIGlzIHVuZGVyIHRoZSBjYXBcbiAqXG4gKiBQZXItaGFuZGxlciBzdGF0ZSBpcyBoZWxkIG9uIHRoZSBgUGVuZGluZ0F1dG9TdGFydEVudHJ5YCB3aGVuIHByZXNlbnQsIGFuZFxuICogb24gYSBtb2R1bGUtbGV2ZWwgbWFwIG90aGVyd2lzZS4gVGhlIGNvdW50ZXIgcmVzZXRzIG9uIGFueSBzdWNjZXNzZnVsXG4gKiB0b29sLXVzZSB0dXJuIHZpYSBgcmVzZXRFbXB0eVR1cm5Db3VudGVyYC5cbiAqL1xuY29uc3QgZW1wdHlUdXJuQ291bnRlckJ5QmFzZSA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5jb25zdCBNQVhfRU1QVFlfVFVSTl9SRVRSSUVTID0gMjtcblxuLy8gUGhyYXNlcyB0aGF0IGluZGljYXRlIHRoZSBMTE0gaXMgYWJvdXQgdG8gZG8gc29tZXRoaW5nIGJ1dCBoYXMgbm90IHlldC5cbi8vIEtlcHQgdGlnaHQgdG8gYXZvaWQgZmxhZ2dpbmcgbGVnaXRpbWF0ZSBuYXJyYXRpb24gbGlrZSBcIkknbGwgd2FpdCBmb3IgeW91ciBhbnN3ZXIuXCJcbi8vXG4vLyBcIm1ha2VcIiB3YXMgcHJldmlvdXNseSBpbiB0aGUgdmVyYiBsaXN0IGJ1dCBtYXRjaGVzIGNvbnZlcnNhdGlvbmFsIG1ldGEgcGhyYXNlc1xuLy8gbGlrZSBcIkxldCBtZSBtYWtlIHN1cmUgSSB1bmRlcnN0YW5kXHUyMDI2XCIgd2hpY2ggYXJlIE5PVCBhY3Rpb24gYW5ub3VuY2VtZW50cyBcdTIwMTRcbi8vIHJlbW92ZWQgdG8gcHJldmVudCB0aGUgZW1wdHktdHVybiBudWRnZSBmcm9tIGF1dG8tcmVwbHlpbmcgdG8gdXNlciBxdWVzdGlvbnNcbi8vIGluIGRpc2N1c3MgZmxvd3MuXG5jb25zdCBDT01NSVRfSU5URU5UX1JFID1cbiAgL1xcYig/OklbJ1x1MjAxOV1sbHxJIHdpbGx8TmV4dCw/IElbJ1x1MjAxOV1sbHxOb3cgSVsnXHUyMDE5XWxsfExldCBtZXxJWydcdTIwMTldbSBnb2luZyB0b3xJIGFtIGdvaW5nIHRvKVxccysoPzpub3dcXHMrKT8oPzp3cml0ZXxjcmVhdGV8Y2FsbHxpbnZva2V8dXBkYXRlfGFkZHxydW58ZXhlY3V0ZXxnZW5lcmF0ZXxwcm9kdWNlfGVtaXR8Y29tcG9zZXxpbXBsZW1lbnR8c2F2ZXxhcHBseXxjb21taXQpXFxiL2k7XG5cbi8qKlxuICogUmVzZXQgdGhlIGVtcHR5LXR1cm4gY291bnRlciBmb3IgYSBiYXNlUGF0aCBhZnRlciBhIHN1Y2Nlc3NmdWwgdG9vbC11c2UgdHVybi5cbiAqIENhbGxlZCBmcm9tIGhhbmRsZUFnZW50RW5kIHdoZW4gdGhlIGxhc3QgbWVzc2FnZSBjb250YWlucyB0b29sX3VzZSBibG9ja3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldEVtcHR5VHVybkNvdW50ZXIoYmFzZVBhdGg/OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKGJhc2VQYXRoKSBlbXB0eVR1cm5Db3VudGVyQnlCYXNlLmRlbGV0ZShiYXNlUGF0aCk7XG4gIGVsc2UgZW1wdHlUdXJuQ291bnRlckJ5QmFzZS5jbGVhcigpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF5YmVIYW5kbGVFbXB0eUludGVudFR1cm4oXG4gIGV2ZW50OiB7IG1lc3NhZ2VzOiBhbnlbXSB9LFxuICBpc0F1dG86IGJvb2xlYW4sXG4pOiBib29sZWFuIHtcbiAgLy8gR2F0ZTogb25seSBmaXJlIHdoZW4gdGhlcmUgaXMgc3lzdGVtLWRyaXZlbiB3b3JrIGluIGZsaWdodC4gSW50ZXJhY3RpdmVcbiAgLy8gL2dzZCBkaXNjdXNzICh1c2VyLWRyaXZlbikgcHJvZHVjZXMgbGVnaXRpbWF0ZSB0ZXh0LW9ubHkgdHVybnMuXG4gIGlmICghaXNBdXRvICYmIHBlbmRpbmdBdXRvU3RhcnRNYXAuc2l6ZSA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IGxhc3RNc2cgPSBldmVudC5tZXNzYWdlc1tldmVudC5tZXNzYWdlcy5sZW5ndGggLSAxXTtcbiAgaWYgKCFsYXN0TXNnKSByZXR1cm4gZmFsc2U7XG4gIGlmIChoYXNUb29sVXNlKGxhc3RNc2cpKSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgdGV4dCA9IGV4dHJhY3RBc3Npc3RhbnRUZXh0KGxhc3RNc2cpLnRyaW0oKTtcbiAgaWYgKCF0ZXh0KSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gU2tpcCBpZiB0aGUgTExNIGlzIGVtaXR0aW5nIHRoZSByZWFkeSBwaHJhc2UgXHUyMDE0IHRoYXQgaXMgdGhlIHJlYWR5LW5vLWZpbGVzXG4gIC8vIHBhdGgsIGhhbmRsZWQgYnkgbWF5YmVIYW5kbGVSZWFkeVBocmFzZVdpdGhvdXRGaWxlcy5cbiAgaWYgKFJFQURZX1BIUkFTRV9SRS50ZXN0KHRleHQpKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gU2tpcCBpZiB0aGUgTExNIGlzIGNsZWFybHkgaGFuZGluZyBiYWNrIHRvIHRoZSB1c2VyLiBEaXNjdXNzIGZsb3dzXG4gIC8vIG9mdGVuIHBvc2UgYSBxdWVzdGlvbiBhbmQgZm9sbG93IGl0IHdpdGggYSBjb25kaXRpb25hbCBpbnRlbnQgb24gdGhlXG4gIC8vIHNhbWUgbGluZSAoXCJEaWQgSSBjYXB0dXJlIHRoYXQgY29ycmVjdGx5PyBJZiBzbywgSSdsbCB3cml0ZSB0aGVcbiAgLy8gcmVxdWlyZW1lbnRzLlwiKS4gQSBsaW5lLXRyYWlsaW5nIGA/YCBjaGVjayBtaXNzZXMgdGhlc2UgYmVjYXVzZSB0aGVcbiAgLy8gbGluZSBlbmRzIGluIGAuYC4gTWF0Y2ggYW55IHNlbnRlbmNlLXRlcm1pbmF0aW5nIGA/YCAoZm9sbG93ZWQgYnlcbiAgLy8gd2hpdGVzcGFjZSBvciBlbmQtb2YtdGV4dCkgXHUyMDE0IGZhbHNlIG5lZ2F0aXZlcyBoZXJlIGF1dG8tcmVwbHkgdG8gdGhlXG4gIC8vIHVzZXIsIHdoaWNoIGlzIGEgbXVjaCB3b3JzZSBmYWlsdXJlIG1vZGUgdGhhbiBhIG1pc3NlZCBudWRnZS5cbiAgaWYgKC9cXD8oPzpcXHN8JCkvLnRlc3QodGV4dCkpIHJldHVybiBmYWxzZTtcblxuICAvLyBNdXN0IGNvbnRhaW4gYSBjb21taXQtaW50ZW50IHBocmFzZSBcdTIwMTQgdGhpcyBpcyB0aGUgc3RhbGwgd2UgY2FyZSBhYm91dC5cbiAgaWYgKCFDT01NSVRfSU5URU5UX1JFLnRlc3QodGV4dCkpIHJldHVybiBmYWxzZTtcblxuICAvLyBSZXNvbHZlIHRoZSB0YXJnZXQgYmFzZVBhdGggKyBwaSBmb3IgaW5qZWN0aW9uLiBQcmVmZXIgdGhlIHBlbmRpbmdcbiAgLy8gYXV0b3N0YXJ0IGVudHJ5IChkaXNjdXNzIGZsb3cpOyBvdGhlcndpc2Ugd2UgY2Fubm90IGluamVjdC5cbiAgY29uc3QgZW50cnkgPSBfZ2V0UGVuZGluZ0F1dG9TdGFydCgpO1xuICBpZiAoIWVudHJ5KSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHsgY3R4LCBwaSwgYmFzZVBhdGggfSA9IGVudHJ5O1xuXG4gIGNvbnN0IGNvdW50ID0gKGVtcHR5VHVybkNvdW50ZXJCeUJhc2UuZ2V0KGJhc2VQYXRoKSA/PyAwKSArIDE7XG4gIGVtcHR5VHVybkNvdW50ZXJCeUJhc2Uuc2V0KGJhc2VQYXRoLCBjb3VudCk7XG5cbiAgaWYgKGNvdW50ID4gTUFYX0VNUFRZX1RVUk5fUkVUUklFUykge1xuICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICBgRW1wdHktdHVybiByZWNvdmVyeTogTExNIGFubm91bmNlZCBpbnRlbnQgJHtjb3VudH0gdGltZXMgd2l0aG91dCBjYWxsaW5nIGFueSB0b29sLiBgICtcbiAgICAgIGBTdG9wcGluZyBhdXRvLW51ZGdlLmAsXG4gICAgICBcImVycm9yXCIsXG4gICAgKTtcbiAgICByZXR1cm4gZmFsc2U7IC8vIGxldCB0aGUgbm9ybWFsIGZsb3cgcmVzb2x2ZS9wYXVzZSB0aGUgdW5pdFxuICB9XG5cbiAgY3R4LnVpLm5vdGlmeShcbiAgICBgRW1wdHktdHVybiBkZXRlY3RlZDogTExNIGFubm91bmNlZCBpbnRlbnQgYnV0IGNhbGxlZCBubyB0b29sLiBQcm9tcHRpbmcgaXQgdG8gZXhlY3V0ZS5gLFxuICAgIFwiaW5mb1wiLFxuICApO1xuXG4gIGNvbnN0IG51ZGdlID1cbiAgICBgWW91ciBsYXN0IHR1cm4gYW5ub3VuY2VkIGFuIGFjdGlvbiAoZS5nLiBcIkknbGwgd3JpdGVcdTIwMjZcIiBvciBcIkxldCBtZSBjYWxsXHUyMDI2XCIpIGAgK1xuICAgIGBidXQgY29udGFpbmVkIG5vIHRvb2wgY2FsbC4gVGhlIHN5c3RlbSByZWNvcmRzIHplcm8gdG9vbC11c2UgYmxvY2tzIGZvciBgICtcbiAgICBgdGhhdCB0dXJuLiBFeGVjdXRlIHRoZSBhbm5vdW5jZWQgYWN0aW9uIE5PVyBhcyBhIHRvb2wgY2FsbCBpbiB0aGlzIHR1cm4uIGAgK1xuICAgIGBEbyBub3QgZGVzY3JpYmUgaXQgYWdhaW4uIFJldHJ5ICR7Y291bnR9LyR7TUFYX0VNUFRZX1RVUk5fUkVUUklFU30uYDtcblxuICB0cnkge1xuICAgIHBpLnNlbmRNZXNzYWdlKFxuICAgICAgeyBjdXN0b21UeXBlOiBcImdzZC1lbXB0eS10dXJuLXJlY292ZXJ5XCIsIGNvbnRlbnQ6IG51ZGdlLCBkaXNwbGF5OiBmYWxzZSB9LFxuICAgICAgeyB0cmlnZ2VyVHVybjogdHJ1ZSB9LFxuICAgICk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2dXYXJuaW5nKFwiZ3VpZGVkXCIsIGBlbXB0eS10dXJuIG51ZGdlIHNlbmRNZXNzYWdlIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogRXh0cmFjdCBtaWxlc3RvbmUgSURzIGZyb20gUFJPSkVDVC5tZCBtaWxlc3RvbmUgc2VxdWVuY2UgdGFibGUuXG4gKiBMb29rcyBmb3Igcm93cyBsaWtlIFwifCBNMDAxIHwgTmFtZSB8IFN0YXR1cyB8XCIgYW5kIGV4dHJhY3RzIHRoZSBJRCBjb2x1bW4uXG4gKi9cbmZ1bmN0aW9uIHBhcnNlTWlsZXN0b25lU2VxdWVuY2VGcm9tUHJvamVjdChjb250ZW50OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGlkczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgbGluZXMgPSBjb250ZW50LnNwbGl0KC9cXHI/XFxuLyk7XG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGNvbnN0IG1hdGNoID0gbGluZS5tYXRjaCgvXlxcfFxccyooTVxcZHszfVtBLVowLTktXSopXFxzKlxcfC8pO1xuICAgIGlmIChtYXRjaCkgaWRzLnB1c2gobWF0Y2hbMV0pO1xuICB9XG4gIHJldHVybiBpZHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxudHlwZSBVSUNvbnRleHQgPSBFeHRlbnNpb25Db250ZXh0O1xuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZWFkIEdTRC1XT1JLRkxPVy5tZCBhbmQgZGlzcGF0Y2ggaXQgdG8gdGhlIExMTSB3aXRoIGEgY29udGV4dHVhbCBub3RlLlxuICogVGhpcyBpcyB0aGUgb25seSB3YXkgdGhlIHdpemFyZCB0cmlnZ2VycyB3b3JrIFx1MjAxNCBldmVyeXRoaW5nIGVsc2UgaXMgdGhlIExMTSdzIGpvYi5cbiAqXG4gKiBXaGVuIGEgdW5pdFR5cGUgaXMgcHJvdmlkZWQsIHJlc29sdmVzIHRoZSB1c2VyJ3MgbW9kZWwgcHJlZmVyZW5jZSBmb3IgdGhhdFxuICogcGhhc2UgKGUuZy4sIG1vZGVscy5wbGFubmluZyBcdTIxOTIgXCJwbGFuLW1pbGVzdG9uZVwiLCBtb2RlbHMuZGlzY3VzcyBcdTIxOTIgXCJkaXNjdXNzLW1pbGVzdG9uZVwiKSBhbmQgYXBwbGllcyBpdCBiZWZvcmVcbiAqIGRpc3BhdGNoaW5nLiBUaGlzIGVuc3VyZXMgZ3VpZGVkLWZsb3cgZGlzcGF0Y2hlcyByZXNwZWN0IHRoZSBzYW1lXG4gKiBwZXItcGhhc2UgbW9kZWwgcHJlZmVyZW5jZXMgdGhhdCBhdXRvLW1vZGUgdXNlcy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2hXb3JrZmxvdyhcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgbm90ZTogc3RyaW5nLFxuICBjdXN0b21UeXBlID0gXCJnc2QtcnVuXCIsXG4gIGN0eD86IEV4dGVuc2lvbkNvbnRleHQsXG4gIHVuaXRUeXBlPzogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIFJvdXRlIHRocm91Z2ggdGhlIGR5bmFtaWMgcm91dGluZyBwaXBlbGluZSAoY29tcGxleGl0eSBjbGFzc2lmaWNhdGlvbixcbiAgLy8gdGllciBkb3duZ3JhZGUsIGZhbGxiYWNrIGNoYWlucykgXHUyMDE0IHNhbWUgcGF0aCBhcyBhdXRvLW1vZGUgZGlzcGF0Y2hlcyAoIzI5NTgpLlxuICBpZiAoY3R4ICYmIHVuaXRUeXBlKSB7XG4gICAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgc2VsZWN0QW5kQXBwbHlNb2RlbChcbiAgICAgIGN0eCwgcGksIHVuaXRUeXBlLCAvKiB1bml0SWQgKi8gXCJcIiwgLyogYmFzZVBhdGggKi8gcHJvY2Vzcy5jd2QoKSxcbiAgICAgIHByZWZzLCAvKiB2ZXJib3NlICovIGZhbHNlLCAvKiBhdXRvTW9kZVN0YXJ0TW9kZWwgKi8gbnVsbCxcbiAgICAgIC8qIHJldHJ5Q29udGV4dCAqLyB1bmRlZmluZWQsIC8qIGlzQXV0b01vZGUgKi8gZmFsc2UsXG4gICAgKTtcbiAgICBpZiAocmVzdWx0LmFwcGxpZWRNb2RlbCkge1xuICAgICAgZGVidWdMb2coXCJndWlkZWQtZmxvdy1tb2RlbC1hcHBsaWVkXCIsIHtcbiAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgIG1vZGVsOiBgJHtyZXN1bHQuYXBwbGllZE1vZGVsLnByb3ZpZGVyfS8ke3Jlc3VsdC5hcHBsaWVkTW9kZWwuaWR9YCxcbiAgICAgICAgcm91dGluZzogcmVzdWx0LnJvdXRpbmcsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBjb21wYXRpYmlsaXR5RXJyb3IgPSBnZXRXb3JrZmxvd1RyYW5zcG9ydFN1cHBvcnRFcnJvcihcbiAgICAgIHJlc3VsdC5hcHBsaWVkTW9kZWw/LnByb3ZpZGVyID8/IGN0eC5tb2RlbD8ucHJvdmlkZXIsXG4gICAgICBnZXRSZXF1aXJlZFdvcmtmbG93VG9vbHNGb3JHdWlkZWRVbml0KHVuaXRUeXBlKSxcbiAgICAgIHtcbiAgICAgICAgcHJvamVjdFJvb3Q6IHByb2Nlc3MuY3dkKCksXG4gICAgICAgIHN1cmZhY2U6IFwiZ3VpZGVkIGZsb3dcIixcbiAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgIGF1dGhNb2RlOiByZXN1bHQuYXBwbGllZE1vZGVsPy5wcm92aWRlclxuICAgICAgICAgID8gY3R4Lm1vZGVsUmVnaXN0cnkuZ2V0UHJvdmlkZXJBdXRoTW9kZShyZXN1bHQuYXBwbGllZE1vZGVsLnByb3ZpZGVyKVxuICAgICAgICAgIDogY3R4Lm1vZGVsPy5wcm92aWRlclxuICAgICAgICAgICAgPyBjdHgubW9kZWxSZWdpc3RyeS5nZXRQcm92aWRlckF1dGhNb2RlKGN0eC5tb2RlbC5wcm92aWRlcilcbiAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICBiYXNlVXJsOiByZXN1bHQuYXBwbGllZE1vZGVsPy5iYXNlVXJsID8/IGN0eC5tb2RlbD8uYmFzZVVybCxcbiAgICAgIH0sXG4gICAgKTtcbiAgICBpZiAoY29tcGF0aWJpbGl0eUVycm9yKSB7XG4gICAgICBjdHgudWkubm90aWZ5KGNvbXBhdGliaWxpdHlFcnJvciwgXCJlcnJvclwiKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICAvLyBTY29wZSB0b29scyBmb3IgZ3VpZGVkIHdvcmtmbG93IHR1cm5zICgjMjk0OSwgdG9rZW4tY29uc3VtcHRpb24gc2F2aW5ncykuXG4gIC8vIFByb3ZpZGVycyB3aXRoIGdyYW1tYXItYmFzZWQgY29uc3RyYWluZWQgZGVjb2RpbmcgKHhBSS9Hcm9rKSByZXR1cm5cbiAgLy8gXCJHcmFtbWFyIGlzIHRvbyBjb21wbGV4XCIgd2hlbiB0aGUgY29tYmluZWQgdG9vbCBzY2hlbWEgaXMgdG9vIGxhcmdlLlxuICAvLyBHdWlkZWQgd29ya2Zsb3cgdHVybnMgb25seSBuZWVkIHRoZSBhY3RpdmUgdW5pdCdzIHRvb2wgc3VyZmFjZTsgc3RyaXBcbiAgLy8gdW5yZWxhdGVkIEdTRCB0b29scyBhbmQgYnJvYWQgbm9uLUdTRCB0b29scyBmb3IgdGhpcyBxdWV1ZWQgdHVybiwgdGhlblxuICAvLyByZXN0b3JlIHNvIHRoZSBuYXJyb3dlZCBzdXJmYWNlIGRvZXMgbm90IGxlYWsgaW50byBmdXR1cmUgZGlzcGF0Y2hlcy5cbiAgbGV0IHNhdmVkVG9vbHM6IFJldHVyblR5cGU8dHlwZW9mIHNjb3BlR3NkV29ya2Zsb3dUb29sc0ZvckRpc3BhdGNoPiA9IG51bGw7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjdXJyZW50VG9vbHMgPSBwaS5nZXRBY3RpdmVUb29scygpO1xuICAgIHNhdmVkVG9vbHMgPSB7XG4gICAgICB0b29sczogY3VycmVudFRvb2xzLFxuICAgICAgdmlzaWJsZVNraWxsczogdHlwZW9mIHBpLmdldFZpc2libGVTa2lsbHMgPT09IFwiZnVuY3Rpb25cIiA/IHBpLmdldFZpc2libGVTa2lsbHMoKSA6IHVuZGVmaW5lZCxcbiAgICAgIHJlc3RvcmVWaXNpYmxlU2tpbGxzOiB0eXBlb2YgcGkuc2V0VmlzaWJsZVNraWxscyA9PT0gXCJmdW5jdGlvblwiLFxuICAgIH07XG4gICAgaWYgKHVuaXRUeXBlPy5zdGFydHNXaXRoKFwiZGlzY3Vzcy1cIikgJiYgIWlzRnVsbEdzZFRvb2xTdXJmYWNlUmVxdWVzdGVkKCkpIHtcbiAgICAgIC8vIEtlZXAgYWxsIG5vbi1HU0QgdG9vbHMgKGJ1aWx0aW5zLCBvdGhlciBleHRlbnNpb25zKSBhbmQgb25seSB0aGVcbiAgICAgIC8vIEdTRCB0b29scyBvbiB0aGUgZGlzY3VzcyBhbGxvd2xpc3QuXG4gICAgICBjb25zdCBzY29wZWRUb29scyA9IGN1cnJlbnRUb29scy5maWx0ZXIoXG4gICAgICAgICh0KSA9PiAhdC5zdGFydHNXaXRoKFwiZ3NkX1wiKSB8fCBESVNDVVNTX1RPT0xTX0FMTE9XTElTVC5pbmNsdWRlcyh0KSxcbiAgICAgICk7XG4gICAgICBwaS5zZXRBY3RpdmVUb29scyhzY29wZWRUb29scyk7XG4gICAgICBjb25zdCBzY29wZWRTdGF0ZSA9IHNjb3BlR3NkV29ya2Zsb3dUb29sc0ZvckRpc3BhdGNoKHBpLCB1bml0VHlwZSk7XG4gICAgICBzYXZlZFRvb2xzID0ge1xuICAgICAgICB0b29sczogY3VycmVudFRvb2xzLFxuICAgICAgICB2aXNpYmxlU2tpbGxzOiBzY29wZWRTdGF0ZT8udmlzaWJsZVNraWxscyA/PyBzYXZlZFRvb2xzLnZpc2libGVTa2lsbHMsXG4gICAgICAgIHJlc3RvcmVWaXNpYmxlU2tpbGxzOiBzY29wZWRTdGF0ZT8ucmVzdG9yZVZpc2libGVTa2lsbHMgPz8gc2F2ZWRUb29scy5yZXN0b3JlVmlzaWJsZVNraWxscyxcbiAgICAgIH07XG4gICAgICBkZWJ1Z0xvZyhcImRpc2N1c3MtdG9vbC1zY29waW5nXCIsIHtcbiAgICAgICAgdW5pdFR5cGUsXG4gICAgICAgIGJlZm9yZTogY3VycmVudFRvb2xzLmxlbmd0aCxcbiAgICAgICAgYWZ0ZXI6IHBpLmdldEFjdGl2ZVRvb2xzKCkubGVuZ3RoLFxuICAgICAgICByZW1vdmVkOiBjdXJyZW50VG9vbHMubGVuZ3RoIC0gcGkuZ2V0QWN0aXZlVG9vbHMoKS5sZW5ndGgsXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgc2F2ZWRUb29scyA9IHNjb3BlR3NkV29ya2Zsb3dUb29sc0ZvckRpc3BhdGNoKHBpLCB1bml0VHlwZSkgPz8gc2F2ZWRUb29scztcbiAgICB9XG5cbiAgICBjb25zdCB3b3JrZmxvd1BhdGggPSBwcm9jZXNzLmVudi5HU0RfV09SS0ZMT1dfUEFUSCA/PyBqb2luKGdzZEhvbWUoKSwgXCJhZ2VudFwiLCBcIkdTRC1XT1JLRkxPVy5tZFwiKTtcbiAgICBjb25zdCB3b3JrZmxvdyA9IHJlYWRGaWxlU3luYyh3b3JrZmxvd1BhdGgsIFwidXRmLThcIik7XG5cbiAgICBwaS5zZW5kTWVzc2FnZShcbiAgICAgIHtcbiAgICAgICAgY3VzdG9tVHlwZSxcbiAgICAgICAgY29udGVudDogYnVpbGRXb3JrZmxvd0Rpc3BhdGNoQ29udGVudCh7IHdvcmtmbG93LCB3b3JrZmxvd1BhdGgsIHRhc2s6IG5vdGUgfSksXG4gICAgICAgIGRpc3BsYXk6IGZhbHNlLFxuICAgICAgfSxcbiAgICAgIHsgdHJpZ2dlclR1cm46IHRydWUgfSxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIC8vIFJlc3RvcmUgZnVsbCB0b29sIHNldCBhZnRlciB0aGUgbWVzc2FnZSBpcyBxdWV1ZWQuIFRoZSBMTE0gdHVybiBoYXNcbiAgICAvLyBhbHJlYWR5IGNhcHR1cmVkIHRoZSBzY29wZWQgc2V0IFx1MjAxNCByZXN0b3JpbmcgcHJldmVudHMgdGhlIG5hcnJvd2VkXG4gICAgLy8gdG9vbHMgZnJvbSBsZWFraW5nIGludG8gc3Vic2VxdWVudCBkaXNwYXRjaGVzICgjMzYyOCkuIFRoZSBmaW5hbGx5XG4gICAgLy8gYmxvY2sgZW5zdXJlcyByZXN0b3JhdGlvbiBldmVuIGlmIHNlbmRNZXNzYWdlIHRocm93cy5cbiAgICByZXN0b3JlR3NkV29ya2Zsb3dUb29scyhwaSwgc2F2ZWRUb29scyk7XG4gIH1cbn1cblxuZXhwb3J0IGNvbnN0IF9kaXNwYXRjaFdvcmtmbG93Rm9yVGVzdCA9IGRpc3BhdGNoV29ya2Zsb3c7XG5cbmZ1bmN0aW9uIGdldFN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFiaWxpdHkoXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGN0eDogRXh0ZW5zaW9uQ29udGV4dCB8IHVuZGVmaW5lZCxcbik6IFwidHJ1ZVwiIHwgXCJmYWxzZVwiIHtcbiAgaWYgKCFjdHgpIHJldHVybiBcImZhbHNlXCI7XG5cbiAgY29uc3QgcHJvdmlkZXIgPSBjdHgubW9kZWw/LnByb3ZpZGVyO1xuICBjb25zdCBhdXRoTW9kZSA9IHByb3ZpZGVyID8gY3R4Lm1vZGVsUmVnaXN0cnkuZ2V0UHJvdmlkZXJBdXRoTW9kZShwcm92aWRlcikgOiB1bmRlZmluZWQ7XG4gIHJldHVybiBzdXBwb3J0c1N0cnVjdHVyZWRRdWVzdGlvbnMocGkuZ2V0QWN0aXZlVG9vbHMoKSwge1xuICAgIGF1dGhNb2RlLFxuICAgIGJhc2VVcmw6IGN0eC5tb2RlbD8uYmFzZVVybCxcbiAgfSkgPyBcInRydWVcIiA6IFwiZmFsc2VcIjtcbn1cblxuLyoqXG4gKiBSZXNvbHZlIGEgbW9kZWwgSUQgc3RyaW5nIHRvIGEgbW9kZWwgb2JqZWN0IGZyb20gYXZhaWxhYmxlIG1vZGVscy5cbiAqIEhhbmRsZXMgXCJwcm92aWRlci9tb2RlbFwiIGFuZCBiYXJlIElEIGZvcm1hdHMuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVBdmFpbGFibGVNb2RlbDxUIGV4dGVuZHMgeyBpZDogc3RyaW5nOyBwcm92aWRlcjogc3RyaW5nIH0+KFxuICBtb2RlbElkOiBzdHJpbmcsXG4gIGF2YWlsYWJsZU1vZGVsczogVFtdLFxuICBjdXJyZW50UHJvdmlkZXI6IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IFQgfCB1bmRlZmluZWQge1xuICBjb25zdCBzbGFzaElkeCA9IG1vZGVsSWQuaW5kZXhPZihcIi9cIik7XG5cbiAgaWYgKHNsYXNoSWR4ICE9PSAtMSkge1xuICAgIGNvbnN0IG1heWJlUHJvdmlkZXIgPSBtb2RlbElkLnN1YnN0cmluZygwLCBzbGFzaElkeCk7XG4gICAgY29uc3QgaWQgPSBtb2RlbElkLnN1YnN0cmluZyhzbGFzaElkeCArIDEpO1xuXG4gICAgY29uc3Qga25vd25Qcm92aWRlcnMgPSBuZXcgU2V0KGF2YWlsYWJsZU1vZGVscy5tYXAobSA9PiBtLnByb3ZpZGVyLnRvTG93ZXJDYXNlKCkpKTtcbiAgICBpZiAoa25vd25Qcm92aWRlcnMuaGFzKG1heWJlUHJvdmlkZXIudG9Mb3dlckNhc2UoKSkpIHtcbiAgICAgIGNvbnN0IG1hdGNoID0gYXZhaWxhYmxlTW9kZWxzLmZpbmQoXG4gICAgICAgIG0gPT4gbS5wcm92aWRlci50b0xvd2VyQ2FzZSgpID09PSBtYXliZVByb3ZpZGVyLnRvTG93ZXJDYXNlKClcbiAgICAgICAgICAmJiBtLmlkLnRvTG93ZXJDYXNlKCkgPT09IGlkLnRvTG93ZXJDYXNlKCksXG4gICAgICApO1xuICAgICAgaWYgKG1hdGNoKSByZXR1cm4gbWF0Y2g7XG4gICAgfVxuXG4gICAgLy8gVHJ5IG1hdGNoaW5nIHRoZSBmdWxsIHN0cmluZyBhcyBhIG1vZGVsIElEIChPcGVuUm91dGVyLXN0eWxlKVxuICAgIGNvbnN0IGxvd2VyID0gbW9kZWxJZC50b0xvd2VyQ2FzZSgpO1xuICAgIHJldHVybiBhdmFpbGFibGVNb2RlbHMuZmluZChcbiAgICAgIG0gPT4gbS5pZC50b0xvd2VyQ2FzZSgpID09PSBsb3dlclxuICAgICAgICB8fCBgJHttLnByb3ZpZGVyfS8ke20uaWR9YC50b0xvd2VyQ2FzZSgpID09PSBsb3dlcixcbiAgICApO1xuICB9XG5cbiAgLy8gQmFyZSBJRCBcdTIwMTQgcHJlZmVyIGN1cnJlbnQgcHJvdmlkZXIsIHRoZW4gZmlyc3QgYXZhaWxhYmxlXG4gIGNvbnN0IGV4YWN0UHJvdmlkZXJNYXRjaCA9IGF2YWlsYWJsZU1vZGVscy5maW5kKFxuICAgIG0gPT4gbS5pZCA9PT0gbW9kZWxJZCAmJiBtLnByb3ZpZGVyID09PSBjdXJyZW50UHJvdmlkZXIsXG4gICk7XG4gIHJldHVybiBleGFjdFByb3ZpZGVyTWF0Y2ggPz8gYXZhaWxhYmxlTW9kZWxzLmZpbmQobSA9PiBtLmlkID09PSBtb2RlbElkKTtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgZGlzY3Vzcy1hbmQtcGxhbiBwcm9tcHQgZm9yIGEgbmV3IG1pbGVzdG9uZS5cbiAqIFVzZWQgYnkgYWxsIHRocmVlIFwibmV3IG1pbGVzdG9uZVwiIHBhdGhzIChmaXJzdCBldmVyLCBubyBhY3RpdmUsIGFsbCBjb21wbGV0ZSkuXG4gKi9cbmZ1bmN0aW9uIGJ1aWxkRGlzY3Vzc1Byb21wdChuZXh0SWQ6IHN0cmluZywgcHJlYW1ibGU6IHN0cmluZywgX2Jhc2VQYXRoOiBzdHJpbmcsIHBpOiBFeHRlbnNpb25BUEksIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsIHByZXBhcmF0aW9uQ29udGV4dD86IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG1pbGVzdG9uZVJlbCA9IGAuZ3NkL21pbGVzdG9uZXMvJHtuZXh0SWR9YDtcbiAgY29uc3Qgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSA9IGdldFN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFiaWxpdHkocGksIGN0eCk7XG4gIGNvbnN0IGlubGluZWRUZW1wbGF0ZXMgPSBbXG4gICAgaW5saW5lVGVtcGxhdGUoXCJwcm9qZWN0XCIsIFwiUHJvamVjdFwiKSxcbiAgICBpbmxpbmVUZW1wbGF0ZShcInJlcXVpcmVtZW50c1wiLCBcIlJlcXVpcmVtZW50c1wiKSxcbiAgICBpbmxpbmVUZW1wbGF0ZShcImNvbnRleHRcIiwgXCJDb250ZXh0XCIpLFxuICAgIGlubGluZVRlbXBsYXRlKFwicm9hZG1hcFwiLCBcIlJvYWRtYXBcIiksXG4gICAgaW5saW5lVGVtcGxhdGUoXCJkZWNpc2lvbnNcIiwgXCJEZWNpc2lvbnNcIiksXG4gIF0uam9pbihcIlxcblxcbi0tLVxcblxcblwiKTtcbiAgcmV0dXJuIGxvYWRQcm9tcHQoXCJkaXNjdXNzXCIsIHtcbiAgICBtaWxlc3RvbmVJZDogbmV4dElkLFxuICAgIHByZWFtYmxlLFxuICAgIHByZXBhcmF0aW9uQ29udGV4dDogcHJlcGFyYXRpb25Db250ZXh0ID8/IFwiXCIsXG4gICAgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSxcbiAgICBjb250ZXh0UGF0aDogYCR7bWlsZXN0b25lUmVsfS8ke25leHRJZH0tQ09OVEVYVC5tZGAsXG4gICAgcm9hZG1hcFBhdGg6IGAke21pbGVzdG9uZVJlbH0vJHtuZXh0SWR9LVJPQURNQVAubWRgLFxuICAgIGlubGluZWRUZW1wbGF0ZXMsXG4gICAgY29tbWl0SW5zdHJ1Y3Rpb246IGJ1aWxkRG9jc0NvbW1pdEluc3RydWN0aW9uKGBkb2NzKCR7bmV4dElkfSk6IGNvbnRleHQsIHJlcXVpcmVtZW50cywgYW5kIHJvYWRtYXBgKSxcbiAgICBtdWx0aU1pbGVzdG9uZUNvbW1pdEluc3RydWN0aW9uOiBidWlsZERvY3NDb21taXRJbnN0cnVjdGlvbihcImRvY3M6IHByb2plY3QgcGxhbiBcdTIwMTQgTiBtaWxlc3RvbmVzXCIpLFxuICB9KTtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgZGlzY3VzcyBwcm9tcHQgZm9yIGhlYWRsZXNzIG1pbGVzdG9uZSBjcmVhdGlvbi5cbiAqIFVzZXMgdGhlIGRpc2N1c3MtaGVhZGxlc3MgcHJvbXB0IHRlbXBsYXRlIHdpdGggc2VlZCBjb250ZXh0IGluamVjdGVkLlxuICovXG5mdW5jdGlvbiBidWlsZEhlYWRsZXNzRGlzY3Vzc1Byb21wdChuZXh0SWQ6IHN0cmluZywgc2VlZENvbnRleHQ6IHN0cmluZywgX2Jhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtaWxlc3RvbmVSZWwgPSBgLmdzZC9taWxlc3RvbmVzLyR7bmV4dElkfWA7XG4gIGNvbnN0IGlubGluZWRUZW1wbGF0ZXMgPSBbXG4gICAgaW5saW5lVGVtcGxhdGUoXCJwcm9qZWN0XCIsIFwiUHJvamVjdFwiKSxcbiAgICBpbmxpbmVUZW1wbGF0ZShcInJlcXVpcmVtZW50c1wiLCBcIlJlcXVpcmVtZW50c1wiKSxcbiAgICBpbmxpbmVUZW1wbGF0ZShcImNvbnRleHRcIiwgXCJDb250ZXh0XCIpLFxuICAgIGlubGluZVRlbXBsYXRlKFwicm9hZG1hcFwiLCBcIlJvYWRtYXBcIiksXG4gICAgaW5saW5lVGVtcGxhdGUoXCJkZWNpc2lvbnNcIiwgXCJEZWNpc2lvbnNcIiksXG4gIF0uam9pbihcIlxcblxcbi0tLVxcblxcblwiKTtcbiAgcmV0dXJuIGxvYWRQcm9tcHQoXCJkaXNjdXNzLWhlYWRsZXNzXCIsIHtcbiAgICBtaWxlc3RvbmVJZDogbmV4dElkLFxuICAgIHNlZWRDb250ZXh0LFxuICAgIGNvbnRleHRQYXRoOiBgJHttaWxlc3RvbmVSZWx9LyR7bmV4dElkfS1DT05URVhULm1kYCxcbiAgICByb2FkbWFwUGF0aDogYCR7bWlsZXN0b25lUmVsfS8ke25leHRJZH0tUk9BRE1BUC5tZGAsXG4gICAgaW5saW5lZFRlbXBsYXRlcyxcbiAgICBjb21taXRJbnN0cnVjdGlvbjogYnVpbGREb2NzQ29tbWl0SW5zdHJ1Y3Rpb24oYGRvY3MoJHtuZXh0SWR9KTogY29udGV4dCwgcmVxdWlyZW1lbnRzLCBhbmQgcm9hZG1hcGApLFxuICAgIG11bHRpTWlsZXN0b25lQ29tbWl0SW5zdHJ1Y3Rpb246IGJ1aWxkRG9jc0NvbW1pdEluc3RydWN0aW9uKFwiZG9jczogcHJvamVjdCBwbGFuIFx1MjAxNCBOIG1pbGVzdG9uZXNcIiksXG4gIH0pO1xufVxuXG4vKipcbiAqIFJ1biBwcmVwYXJhdGlvbiBwaGFzZSBpZiBlbmFibGVkLCB0aGVuIGJ1aWxkIHRoZSBkaXNjdXNzIHByb21wdC5cbiAqIFByZXBhcmF0aW9uIGFuYWx5emVzIHRoZSBjb2RlYmFzZSBhbmQgcHJpb3IgY29udGV4dCwgaW5qZWN0aW5nIHRoZSByZXN1bHRzXG4gKiBhcyBzdXBwbGVtZW50YXJ5IGNvbnRleHQgaW50byB0aGUgc3RhbmRhcmQgZGlzY3VzcyB0ZW1wbGF0ZS4gVGhlIGRpc2N1c3NcbiAqIHRlbXBsYXRlIGRyaXZlcyB0aGUgY29udmVyc2F0aW9uIChhc2tzIFwiV2hhdCdzIHRoZSB2aXNpb24/XCIgZmlyc3QpLCB3aGlsZVxuICogdGhlIHByZXBhcmF0aW9uIGJyaWVmcyBnaXZlIHRoZSBhZ2VudCBncm91bmRpbmcgaW4gdGhlIGV4aXN0aW5nIGNvZGViYXNlLlxuICpcbiAqIEBwYXJhbSBjdHggLSBFeHRlbnNpb24gY29tbWFuZCBjb250ZXh0IHdpdGggVUkgZm9yIHByb2dyZXNzIG5vdGlmaWNhdGlvbnNcbiAqIEBwYXJhbSBuZXh0SWQgLSBUaGUgbWlsZXN0b25lIElEIGJlaW5nIGRpc2N1c3NlZFxuICogQHBhcmFtIHByZWFtYmxlIC0gUHJlYW1ibGUgdGV4dCBmb3IgdGhlIGRpc2N1c3MgcHJvbXB0XG4gKiBAcGFyYW0gYmFzZVBhdGggLSBSb290IGRpcmVjdG9yeSBvZiB0aGUgcHJvamVjdFxuICogQHJldHVybnMgVGhlIGRpc2N1c3MgcHJvbXB0IHN0cmluZ1xuICovXG5hc3luYyBmdW5jdGlvbiBwcmVwYXJlQW5kQnVpbGREaXNjdXNzUHJvbXB0KFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuICBuZXh0SWQ6IHN0cmluZyxcbiAgcHJlYW1ibGU6IHN0cmluZyxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzID8/IHt9O1xuXG4gIC8vIFJ1biBwcmVwYXJhdGlvbiBpZiBlbmFibGVkIChkZWZhdWx0OiB0cnVlKSBcdTIwMTQgcmVzdWx0cyBhcmUgaW5qZWN0ZWQgYXNcbiAgLy8gc3VwcGxlbWVudGFyeSBjb250ZXh0IGludG8gdGhlIHN0YW5kYXJkIGRpc2N1c3MgcHJvbXB0LCBOT1QgYXMgYVxuICAvLyByZXBsYWNlbWVudCB0ZW1wbGF0ZS4gVGhlIGRpc2N1c3MgcHJvbXB0IGFsd2F5cyBsZWFkcyB3aXRoIFwiV2hhdCdzIHRoZVxuICAvLyB2aXNpb24/XCIgc28gdGhlIHVzZXIgZGVmaW5lcyB0aGUgc2NvcGUsIG5vdCB0aGUgY29kZWJhc2UgYW5hbHlzaXMuXG4gIGxldCBwcmVwYXJhdGlvbkNvbnRleHQgPSBcIlwiO1xuICBpZiAocHJlZnMuZGlzY3Vzc19wcmVwYXJhdGlvbiAhPT0gZmFsc2UpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcHJlcFJlc3VsdCA9IGF3YWl0IHJ1blByZXBhcmF0aW9uKGJhc2VQYXRoLCBjdHgudWksIHtcbiAgICAgICAgZGlzY3Vzc19wcmVwYXJhdGlvbjogcHJlZnMuZGlzY3Vzc19wcmVwYXJhdGlvbixcbiAgICAgICAgZGlzY3Vzc193ZWJfcmVzZWFyY2g6IHByZWZzLmRpc2N1c3Nfd2ViX3Jlc2VhcmNoLFxuICAgICAgICBkaXNjdXNzX2RlcHRoOiBwcmVmcy5kaXNjdXNzX2RlcHRoLFxuICAgICAgfSk7XG5cbiAgICAgIGlmIChwcmVwUmVzdWx0LmVuYWJsZWQpIHtcbiAgICAgICAgY29uc3QgY29kZWJhc2VCcmllZiA9IHByZXBSZXN1bHQuY29kZWJhc2VCcmllZiB8fCBmb3JtYXRDb2RlYmFzZUJyaWVmKHByZXBSZXN1bHQuY29kZWJhc2UpO1xuICAgICAgICBjb25zdCBwcmlvckNvbnRleHRCcmllZiA9IHByZXBSZXN1bHQucHJpb3JDb250ZXh0QnJpZWYgfHwgZm9ybWF0UHJpb3JDb250ZXh0QnJpZWYocHJlcFJlc3VsdC5wcmlvckNvbnRleHQpO1xuICAgICAgICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgaWYgKGNvZGViYXNlQnJpZWYpIHBhcnRzLnB1c2goYCMjIyBDb2RlYmFzZSBCcmllZlxcblxcbiR7Y29kZWJhc2VCcmllZn1gKTtcbiAgICAgICAgaWYgKHByaW9yQ29udGV4dEJyaWVmKSBwYXJ0cy5wdXNoKGAjIyMgUHJpb3IgQ29udGV4dCBCcmllZlxcblxcbiR7cHJpb3JDb250ZXh0QnJpZWZ9YCk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgcHJlcGFyYXRpb25Db250ZXh0ID0gYFxcblxcbiMjIFByZXBhcmF0aW9uIENvbnRleHRcXG5cXG5UaGUgc3lzdGVtIGFuYWx5emVkIHRoZSBjb2RlYmFzZSBiZWZvcmUgdGhpcyBkaXNjdXNzaW9uLiBVc2UgdGhlc2UgZmluZGluZ3MgYXMgYmFja2dyb3VuZCBjb250ZXh0IFx1MjAxNCB0aGV5IGRlc2NyaWJlIHdoYXQgYWxyZWFkeSBleGlzdHMsIE5PVCB3aGF0IHRoZSB1c2VyIHdhbnRzIHRvIGJ1aWxkLiBBbHdheXMgYXNrIHRoZSB1c2VyIHdoYXQgdGhleSB3YW50IHRvIGJ1aWxkIGZpcnN0LlxcblxcbiR7cGFydHMuam9pbihcIlxcblxcblwiKX1gO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2dXYXJuaW5nKFwiZ3VpZGVkXCIsIGBwcmVwYXJhdGlvbiBmYWlsZWQsIHByb2NlZWRpbmcgd2l0aG91dCBjb250ZXh0OiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGJ1aWxkRGlzY3Vzc1Byb21wdChuZXh0SWQsIHByZWFtYmxlLCBiYXNlUGF0aCwgcGksIGN0eCwgcHJlcGFyYXRpb25Db250ZXh0KTtcbn1cblxuLyoqXG4gKiBCb290c3RyYXAgYSAuZ3NkLyBwcm9qZWN0IGZyb20gc2NyYXRjaCBmb3IgaGVhZGxlc3MgdXNlLlxuICogRW5zdXJlcyBnaXQgcmVwbywgLmdzZC8gc3RydWN0dXJlLCBnaXRpZ25vcmUsIGFuZCBwcmVmZXJlbmNlcyBhbGwgZXhpc3QuXG4gKi9cbmZ1bmN0aW9uIGJvb3RzdHJhcEdzZFByb2plY3QoYmFzZVBhdGg6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoIW5hdGl2ZUlzUmVwbyhiYXNlUGF0aCkgfHwgaXNJbmhlcml0ZWRSZXBvKGJhc2VQYXRoKSkge1xuICAgIGNvbnN0IG1haW5CcmFuY2ggPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM/LmdpdD8ubWFpbl9icmFuY2ggfHwgXCJtYWluXCI7XG4gICAgbmF0aXZlSW5pdChiYXNlUGF0aCwgbWFpbkJyYW5jaCk7XG4gIH1cblxuICBjb25zdCByb290ID0gZ3NkUm9vdChiYXNlUGF0aCk7XG4gIG1rZGlyU3luYyhqb2luKHJvb3QsIFwibWlsZXN0b25lc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIG1rZGlyU3luYyhqb2luKHJvb3QsIFwicnVudGltZVwiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG5cbiAgZW5zdXJlR2l0aWdub3JlKGJhc2VQYXRoKTtcbiAgZW5zdXJlUHJlZmVyZW5jZXMoYmFzZVBhdGgpO1xuICB1bnRyYWNrUnVudGltZUZpbGVzKGJhc2VQYXRoKTtcbn1cblxuLyoqXG4gKiBIZWFkbGVzcyBtaWxlc3RvbmUgY3JlYXRpb24gZnJvbSBhIHNlZWQgc3BlY2lmaWNhdGlvbiBkb2N1bWVudC5cbiAqIEJvb3RzdHJhcHMgdGhlIHByb2plY3QgaWYgbmVlZGVkLCBnZW5lcmF0ZXMgdGhlIG5leHQgbWlsZXN0b25lIElELFxuICogYW5kIGRpc3BhdGNoZXMgdGhlIGhlYWRsZXNzIGRpc2N1c3MgcHJvbXB0IChubyBRJkEgcm91bmRzKS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNob3dIZWFkbGVzc01pbGVzdG9uZUNyZWF0aW9uKFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBzZWVkQ29udGV4dDogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIENsZWFyIHN0YWxlIHJlc2VydmF0aW9ucyBmcm9tIHByZXZpb3VzIGNhbmNlbGxlZCBzZXNzaW9ucyAoIzI0ODgpXG4gIGNsZWFyUmVzZXJ2ZWRNaWxlc3RvbmVJZHMoKTtcblxuICAvLyBFbnN1cmUgLmdzZC8gaXMgYm9vdHN0cmFwcGVkXG4gIGJvb3RzdHJhcEdzZFByb2plY3QoYmFzZVBhdGgpO1xuXG4gIGNvbnN0IHsgZW5zdXJlRGJPcGVuIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2Jvb3RzdHJhcC9keW5hbWljLXRvb2xzLmpzXCIpO1xuICBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuXG4gIC8vIEdlbmVyYXRlIG5leHQgbWlsZXN0b25lIElEXG4gIGNvbnN0IGV4aXN0aW5nSWRzID0gZmluZE1pbGVzdG9uZUlkcyhiYXNlUGF0aCk7XG4gIGNvbnN0IHByZWZzID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk7XG4gIGNvbnN0IG5leHRJZCA9IG5leHRNaWxlc3RvbmVJZFJlc2VydmVkKGV4aXN0aW5nSWRzLCBwcmVmcz8ucHJlZmVyZW5jZXM/LnVuaXF1ZV9taWxlc3RvbmVfaWRzID8/IGZhbHNlLCBiYXNlUGF0aCk7XG5cbiAgLy8gRml4ICM0OTk2OiBEbyBOT1QgcHJlLWNyZWF0ZSB0aGUgbWlsZXN0b25lIGRpcmVjdG9yeSBoZXJlLlxuICAvLyBhdG9taWNXcml0ZUFzeW5jICh1c2VkIGJ5IGFsbCBhcnRpZmFjdCB3cml0ZXJzKSBjYWxscyBta2RpciBsYXppbHkgYmVmb3JlXG4gIC8vIGVhY2ggd3JpdGUsIHNvIGV2ZXJ5IHBhdGggdGhyb3VnaCBzYXZlQXJ0aWZhY3RUb0RiIC8gc2F2ZUZpbGUgaXMgYWxyZWFkeVxuICAvLyBsYXp5LW1rZGlyLXNhZmUuIFByZS1jcmVhdGluZyB0aGUgZGlyIGJlZm9yZSB0aGUgZGlzY3VzcyBmbG93IHJ1bnMgbGVhdmVzXG4gIC8vIGFuIG9ycGhhbiBzdHViIGlmIGRpc2N1c3MgaXMgYWJhbmRvbmVkIFx1MjAxNCB0aGF0IHN0dWIgbGF0ZXIgc2tld3MgbmV4dE1pbGVzdG9uZUlkLlxuXG4gIC8vIEJ1aWxkIGFuZCBkaXNwYXRjaCB0aGUgaGVhZGxlc3MgZGlzY3VzcyBwcm9tcHRcbiAgY29uc3QgcHJvbXB0ID0gYnVpbGRIZWFkbGVzc0Rpc2N1c3NQcm9tcHQobmV4dElkLCBzZWVkQ29udGV4dCwgYmFzZVBhdGgpO1xuXG4gIC8vIFNldCBwZW5kaW5nIGF1dG8gc3RhcnQgKGF1dG8tbW9kZSB0cmlnZ2VycyBvbiBcIk1pbGVzdG9uZSBYIHJlYWR5LlwiIHZpYSBjaGVja0F1dG9TdGFydEFmdGVyRGlzY3VzcylcbiAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlUGF0aCwgeyBjdHgsIHBpLCBiYXNlUGF0aCwgbWlsZXN0b25lSWQ6IG5leHRJZCB9KTtcblxuICAvLyBEaXNwYXRjaCBhcyBkaXNjdXNzLW1pbGVzdG9uZS4gVGhlIExMTSB3cml0ZXMgUFJPSkVDVC5tZCwgUkVRVUlSRU1FTlRTLm1kLFxuICAvLyBhbmQgQ09OVEVYVC5tZCwgdGhlbiBjYWxscyBnc2RfcGxhbl9taWxlc3RvbmUgXHUyMDE0IHRoaXMgaXMgc2VtYW50aWNhbGx5IHRoZVxuICAvLyBkaXNjdXNzIHBhdGgsIGp1c3Qgbm9uLWludGVyYWN0aXZlLiBVc2luZyBcInBsYW4tbWlsZXN0b25lXCIgaGVyZSBjYXVzZWRcbiAgLy8gbW9kZWwvdG9vbCByb3V0aW5nIHRvIHNraXAgZGlzY3Vzcy1mbG93IHRvb2wgc2NvcGluZyBhbmRcbiAgLy8gYGNoZWNrQXV0b1N0YXJ0QWZ0ZXJEaXNjdXNzYCBndWFyZHJhaWxzIHRoYXQgcmVseSBvbiB0aGVcbiAgLy8gXCJkaXNjdXNzLVwiLXByZWZpeGVkIHVuaXRUeXBlLlxuICBhd2FpdCBkaXNwYXRjaFdvcmtmbG93KHBpLCBwcm9tcHQsIFwiZ3NkLXJ1blwiLCBjdHgsIFwiZGlzY3Vzcy1taWxlc3RvbmVcIik7XG59XG5cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERpc2N1c3MgRmxvdyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBCdWlsZCBhIHJpY2ggaW5saW5lZC1jb250ZXh0IHByb21wdCBmb3IgZGlzY3Vzc2luZyBhIHNwZWNpZmljIHNsaWNlLlxuICogUHJlbG9hZHMgcm9hZG1hcCwgbWlsZXN0b25lIGNvbnRleHQsIHJlc2VhcmNoLCBkZWNpc2lvbnMsIGFuZCBjb21wbGV0ZWRcbiAqIHNsaWNlIHN1bW1hcmllcyBzbyB0aGUgYWdlbnQgY2FuIGFzayBncm91bmRlZCBVWC9iZWhhdmlvdXIgcXVlc3Rpb25zXG4gKiB3aXRob3V0IHdhc3RpbmcgYSB0dXJuIHJlYWRpbmcgZmlsZXMuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkRGlzY3Vzc1NsaWNlUHJvbXB0KFxuICBtaWQ6IHN0cmluZyxcbiAgc2lkOiBzdHJpbmcsXG4gIHNUaXRsZTogc3RyaW5nLFxuICBiYXNlOiBzdHJpbmcsXG4gIG9wdGlvbnM/OiB7IHJlZGlzY3Vzcz86IGJvb2xlYW47IHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGU/OiBzdHJpbmcgfSxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGlubGluZWQ6IHN0cmluZ1tdID0gW107XG5cbiAgLy8gUm9hZG1hcCBcdTIwMTQgYWx3YXlzIGluY2x1ZGVkIHNvIHRoZSBhZ2VudCBzZWVzIHN1cnJvdW5kaW5nIHNsaWNlc1xuICBjb25zdCByb2FkbWFwUGF0aCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJST0FETUFQXCIpO1xuICBjb25zdCByb2FkbWFwUmVsID0gcmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUk9BRE1BUFwiKTtcbiAgY29uc3Qgcm9hZG1hcENvbnRlbnQgPSByb2FkbWFwUGF0aCA/IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBQYXRoKSA6IG51bGw7XG4gIGlmIChyb2FkbWFwQ29udGVudCkge1xuICAgIGlubGluZWQucHVzaChgIyMjIE1pbGVzdG9uZSBSb2FkbWFwXFxuU291cmNlOiBcXGAke3JvYWRtYXBSZWx9XFxgXFxuXFxuJHtyb2FkbWFwQ29udGVudC50cmltKCl9YCk7XG4gIH1cblxuICAvLyBNaWxlc3RvbmUgY29udGV4dCBcdTIwMTQgdW5kZXJzdGFuZGluZyB0aGUgZnVsbCBtaWxlc3RvbmUgaW50ZW50XG4gIGNvbnN0IGNvbnRleHRQYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZSwgbWlkLCBcIkNPTlRFWFRcIik7XG4gIGNvbnN0IGNvbnRleHRSZWwgPSByZWxNaWxlc3RvbmVGaWxlKGJhc2UsIG1pZCwgXCJDT05URVhUXCIpO1xuICBjb25zdCBjb250ZXh0Q29udGVudCA9IGNvbnRleHRQYXRoID8gYXdhaXQgbG9hZEZpbGUoY29udGV4dFBhdGgpIDogbnVsbDtcbiAgaWYgKGNvbnRleHRDb250ZW50KSB7XG4gICAgaW5saW5lZC5wdXNoKGAjIyMgTWlsZXN0b25lIENvbnRleHRcXG5Tb3VyY2U6IFxcYCR7Y29udGV4dFJlbH1cXGBcXG5cXG4ke2NvbnRleHRDb250ZW50LnRyaW0oKX1gKTtcbiAgfVxuXG4gIC8vIE1pbGVzdG9uZSByZXNlYXJjaCBcdTIwMTQgdGVjaG5pY2FsIGdyb3VuZGluZ1xuICBjb25zdCByZXNlYXJjaFBhdGggPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUkVTRUFSQ0hcIik7XG4gIGNvbnN0IHJlc2VhcmNoUmVsID0gcmVsTWlsZXN0b25lRmlsZShiYXNlLCBtaWQsIFwiUkVTRUFSQ0hcIik7XG4gIGNvbnN0IHJlc2VhcmNoQ29udGVudCA9IHJlc2VhcmNoUGF0aCA/IGF3YWl0IGxvYWRGaWxlKHJlc2VhcmNoUGF0aCkgOiBudWxsO1xuICBpZiAocmVzZWFyY2hDb250ZW50KSB7XG4gICAgaW5saW5lZC5wdXNoKGAjIyMgTWlsZXN0b25lIFJlc2VhcmNoXFxuU291cmNlOiBcXGAke3Jlc2VhcmNoUmVsfVxcYFxcblxcbiR7cmVzZWFyY2hDb250ZW50LnRyaW0oKX1gKTtcbiAgfVxuXG4gIC8vIERlY2lzaW9ucyBcdTIwMTQgYXJjaGl0ZWN0dXJhbCBjb250ZXh0IHRoYXQgY29uc3RyYWlucyB0aGlzIHNsaWNlXG4gIGNvbnN0IGRlY2lzaW9uc1BhdGggPSByZXNvbHZlR3NkUm9vdEZpbGUoYmFzZSwgXCJERUNJU0lPTlNcIik7XG4gIGlmIChleGlzdHNTeW5jKGRlY2lzaW9uc1BhdGgpKSB7XG4gICAgY29uc3QgZGVjaXNpb25zQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKGRlY2lzaW9uc1BhdGgpO1xuICAgIGlmIChkZWNpc2lvbnNDb250ZW50KSB7XG4gICAgICBpbmxpbmVkLnB1c2goYCMjIyBEZWNpc2lvbnMgUmVnaXN0ZXJcXG5Tb3VyY2U6IFxcYCR7cmVsR3NkUm9vdEZpbGUoXCJERUNJU0lPTlNcIil9XFxgXFxuXFxuJHtkZWNpc2lvbnNDb250ZW50LnRyaW0oKX1gKTtcbiAgICB9XG4gIH1cblxuICAvLyBDb21wbGV0ZWQgc2xpY2Ugc3VtbWFyaWVzIFx1MjAxNCB3aGF0IHdhcyBhbHJlYWR5IGJ1aWx0IHRoYXQgdGhpcyBzbGljZSBidWlsZHMgb25cbiAgLy8gRW5zdXJlIERCIGlzIG9wZW4gc28gZ2V0TWlsZXN0b25lU2xpY2VzIHJldHVybnMgcmVhbCBkYXRhICgjMjU2MCkuXG4gIHtcbiAgICBjb25zdCB7IGVuc3VyZURiT3BlbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi9ib290c3RyYXAvZHluYW1pYy10b29scy5qc1wiKTtcbiAgICBhd2FpdCBlbnN1cmVEYk9wZW4oKTtcbiAgICB0eXBlIE5vcm1TbGljZSA9IHsgaWQ6IHN0cmluZzsgZG9uZTogYm9vbGVhbiB9O1xuICAgIGxldCBub3JtU2xpY2VzOiBOb3JtU2xpY2VbXSA9IFtdO1xuICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgIG5vcm1TbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMobWlkKS5tYXAocyA9PiAoeyBpZDogcy5pZCwgZG9uZTogcy5zdGF0dXMgPT09IFwiY29tcGxldGVcIiB9KSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgcyBvZiBub3JtU2xpY2VzKSB7XG4gICAgICBpZiAoIXMuZG9uZSB8fCBzLmlkID09PSBzaWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc3VtbWFyeVBhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2UsIG1pZCwgcy5pZCwgXCJTVU1NQVJZXCIpO1xuICAgICAgY29uc3Qgc3VtbWFyeVJlbCA9IHJlbFNsaWNlRmlsZShiYXNlLCBtaWQsIHMuaWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgIGNvbnN0IHN1bW1hcnlDb250ZW50ID0gc3VtbWFyeVBhdGggPyBhd2FpdCBsb2FkRmlsZShzdW1tYXJ5UGF0aCkgOiBudWxsO1xuICAgICAgaWYgKHN1bW1hcnlDb250ZW50KSB7XG4gICAgICAgIGlubGluZWQucHVzaChgIyMjICR7cy5pZH0gU3VtbWFyeSAoY29tcGxldGVkKVxcblNvdXJjZTogXFxgJHtzdW1tYXJ5UmVsfVxcYFxcblxcbiR7c3VtbWFyeUNvbnRlbnQudHJpbSgpfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGlubGluZWRDb250ZXh0ID0gaW5saW5lZC5sZW5ndGggPiAwXG4gICAgPyBgIyMgSW5saW5lZCBDb250ZXh0IChwcmVsb2FkZWQgXHUyMDE0IGRvIG5vdCByZS1yZWFkIHRoZXNlIGZpbGVzKVxcblxcbiR7aW5saW5lZC5qb2luKFwiXFxuXFxuLS0tXFxuXFxuXCIpfWBcbiAgICA6IGAjIyBJbmxpbmVkIENvbnRleHRcXG5cXG5fKG5vIGNvbnRleHQgZmlsZXMgZm91bmQgeWV0IFx1MjAxNCBnbyBpbiBibGluZCBhbmQgYXNrIGJyb2FkIHF1ZXN0aW9ucylfYDtcblxuICBjb25zdCBzbGljZURpclBhdGggPSBgLmdzZC9taWxlc3RvbmVzLyR7bWlkfS9zbGljZXMvJHtzaWR9YDtcbiAgY29uc3Qgc2xpY2VDb250ZXh0UGF0aCA9IGAke3NsaWNlRGlyUGF0aH0vJHtzaWR9LUNPTlRFWFQubWRgO1xuXG4gIC8vIFdoZW4gcmUtZGlzY3Vzc2luZywgaW5qZWN0IGEgcHJlYW1ibGUgc28gdGhlIGFnZW50IHRyZWF0cyB0aGlzIGFzIGFuIHVwZGF0ZSBpbnRlcnZpZXdcbiAgY29uc3QgcmVkaXNjdXNzUHJlYW1ibGUgPSBvcHRpb25zPy5yZWRpc2N1c3NcbiAgICA/IGBcXG5cXG4jIyBSZS1kaXNjdXNzIE1vZGVcXG5cXG5UaGlzIHNsaWNlIGFscmVhZHkgaGFzIGFuIGV4aXN0aW5nIGNvbnRleHQgZmlsZSAoXFxgJHtzbGljZUNvbnRleHRQYXRofVxcYCkgZnJvbSBhIHByaW9yIGRpc2N1c3Npb24uIFRoZSB1c2VyIGhhcyBjaG9zZW4gdG8gcmUtZGlzY3VzcyBpdC4gUmVhZCB0aGUgZXhpc3RpbmcgY29udGV4dCBmaWxlLCBpbnRlcnZpZXcgZm9yIGFueSB1cGRhdGVzLCBjaGFuZ2VzLCBvciBuZXcgZGVjaXNpb25zLCBhbmQgcmV3cml0ZSB0aGUgZmlsZSB3aXRoIG1lcmdlZCBmaW5kaW5ncy4gRG8gTk9UIHNraXAgdGhlIGludGVydmlldyBcdTIwMTQgdGhlIHVzZXIgZXhwbGljaXRseSBhc2tlZCB0byByZXZpc2l0IHRoaXMgc2xpY2UuXFxuYFxuICAgIDogXCJcIjtcblxuICBjb25zdCBpbmxpbmVkVGVtcGxhdGVzID0gaW5saW5lVGVtcGxhdGUoXCJzbGljZS1jb250ZXh0XCIsIFwiU2xpY2UgQ29udGV4dFwiKTtcbiAgcmV0dXJuIGxvYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1zbGljZVwiLCB7XG4gICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICBzbGljZUlkOiBzaWQsXG4gICAgc2xpY2VUaXRsZTogc1RpdGxlLFxuICAgIGlubGluZWRDb250ZXh0OiBpbmxpbmVkQ29udGV4dCArIHJlZGlzY3Vzc1ByZWFtYmxlLFxuICAgIHNsaWNlRGlyUGF0aCxcbiAgICBjb250ZXh0UGF0aDogc2xpY2VDb250ZXh0UGF0aCxcbiAgICBwcm9qZWN0Um9vdDogYmFzZSxcbiAgICBpbmxpbmVkVGVtcGxhdGVzLFxuICAgIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGU6IG9wdGlvbnM/LnN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUgPz8gXCJmYWxzZVwiLFxuICAgIGNvbW1pdEluc3RydWN0aW9uOiBidWlsZERvY3NDb21taXRJbnN0cnVjdGlvbihgZG9jcygke21pZH0vJHtzaWR9KTogc2xpY2UgY29udGV4dCBmcm9tIGRpc2N1c3NgKSxcbiAgfSk7XG59XG5cbi8qKlxuICogL2dzZCBkaXNjdXNzIFx1MjAxNCBzaG93IGEgcGlja2VyIG9mIG5vbi1kb25lIHNsaWNlcyBhbmQgcnVuIGEgc2xpY2UgaW50ZXJ2aWV3LlxuICogTG9vcHMgYmFjayB0byB0aGUgcGlja2VyIGFmdGVyIGVhY2ggZGlzY3Vzc2lvbiBzbyB0aGUgdXNlciBjYW4gY2hhaW5cbiAqIG11bHRpcGxlIHNsaWNlIGludGVydmlld3MgaW4gb25lIHNlc3Npb24uXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzaG93RGlzY3VzcyhcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICAvLyBHdWFyZDogbm8gLmdzZC8gcHJvamVjdFxuICBpZiAoIWV4aXN0c1N5bmMoZ3NkUm9vdChiYXNlUGF0aCkpKSB7XG4gICAgY3R4LnVpLm5vdGlmeShcIk5vIEdTRCBwcm9qZWN0IGZvdW5kLiBSdW4gL2dzZCB0byBzdGFydCBvbmUgZmlyc3QuXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBJbnZhbGlkYXRlIGNhY2hlcyB0byBwaWNrIHVwIGFydGlmYWN0cyB3cml0dGVuIGJ5IGEganVzdC1jb21wbGV0ZWQgZGlzY3Vzcy9wbGFuXG4gIGludmFsaWRhdGVBbGxDYWNoZXMoKTtcblxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcblxuICAvLyBSZWJ1aWxkIFNUQVRFLm1kIGZyb20gZGVyaXZlZCBzdGF0ZSBiZWZvcmUgYW55IGRpc3BhdGNoICgjMzQ3NSkuXG4gIC8vIFdpdGhvdXQgdGhpcywgZ3VpZGVkIHByb21wdHMgcmVhZCBhIHN0YWxlIFNUQVRFLm1kIGNhY2hlIGFuZCB0aGVcbiAgLy8gYWdlbnQgYm9vdHN0cmFwcyBmcm9tIHRoZSB3cm9uZyBtaWxlc3RvbmUuXG4gIHRyeSB7XG4gICAgY29uc3QgeyBidWlsZFN0YXRlTWFya2Rvd24gfSA9IGF3YWl0IGltcG9ydChcIi4vZG9jdG9yLmpzXCIpO1xuICAgIGF3YWl0IHNhdmVGaWxlKHJlc29sdmVHc2RSb290RmlsZShiYXNlUGF0aCwgXCJTVEFURVwiKSwgYnVpbGRTdGF0ZU1hcmtkb3duKHN0YXRlKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJndWlkZWRcIiwgYFNUQVRFLm1kIHJlYnVpbGQgZmFpbGVkOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cblxuICAvLyBObyBhY3RpdmUgbWlsZXN0b25lIChvciBjb3JydXB0ZWQgbWlsZXN0b25lIHdpdGggdW5kZWZpbmVkIGlkKSBcdTIwMTRcbiAgLy8gY2hlY2sgZm9yIHBlbmRpbmcgbWlsZXN0b25lcyB0byBkaXNjdXNzIGluc3RlYWRcbiAgaWYgKCFzdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkKSB7XG4gICAgY29uc3QgcGVuZGluZ01pbGVzdG9uZXMgPSBzdGF0ZS5yZWdpc3RyeS5maWx0ZXIobSA9PiBtLnN0YXR1cyA9PT0gXCJwZW5kaW5nXCIpO1xuICAgIGlmIChwZW5kaW5nTWlsZXN0b25lcy5sZW5ndGggPT09IDApIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoXCJObyBhY3RpdmUgbWlsZXN0b25lLiBSdW4gL2dzZCB0byBjcmVhdGUgb25lIGZpcnN0LlwiLCBcIndhcm5pbmdcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGF3YWl0IHNob3dEaXNjdXNzUXVldWVkTWlsZXN0b25lKGN0eCwgcGksIGJhc2VQYXRoLCBwZW5kaW5nTWlsZXN0b25lcyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbWlkID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lLmlkO1xuICBjb25zdCBtaWxlc3RvbmVUaXRsZSA9IHN0YXRlLmFjdGl2ZU1pbGVzdG9uZS50aXRsZTtcblxuICAvLyBTcGVjaWFsIGNhc2U6IG1pbGVzdG9uZSBpcyBpbiBuZWVkcy1kaXNjdXNzaW9uIHBoYXNlIChoYXMgQ09OVEVYVC1EUkFGVC5tZCBidXQgbm8gcm9hZG1hcCB5ZXQpLlxuICAvLyBSb3V0ZSB0byB0aGUgZHJhZnQgZGlzY3Vzc2lvbiBmbG93IGluc3RlYWQgb2YgZXJyb3JpbmcgXHUyMDE0IHRoZSBkaXNjdXNzaW9uIElTIGhvdyB0aGUgcm9hZG1hcCBnZXRzIGNyZWF0ZWQuXG4gIGlmIChzdGF0ZS5waGFzZSA9PT0gXCJuZWVkcy1kaXNjdXNzaW9uXCIpIHtcbiAgICBjb25zdCBkcmFmdEZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIkNPTlRFWFQtRFJBRlRcIik7XG4gICAgY29uc3QgZHJhZnRDb250ZW50ID0gZHJhZnRGaWxlID8gYXdhaXQgbG9hZEZpbGUoZHJhZnRGaWxlKSA6IG51bGw7XG5cbiAgICBjb25zdCBjaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICAgIHRpdGxlOiBgR1NEIFx1MjAxNCAke21pZH06ICR7bWlsZXN0b25lVGl0bGV9YCxcbiAgICAgIHN1bW1hcnk6IFtcIlRoaXMgbWlsZXN0b25lIGhhcyBhIGRyYWZ0IGNvbnRleHQgZnJvbSBhIHByaW9yIGRpc2N1c3Npb24uXCIsIFwiSXQgbmVlZHMgYSBkZWRpY2F0ZWQgZGlzY3Vzc2lvbiBiZWZvcmUgYXV0by1wbGFubmluZyBjYW4gYmVnaW4uXCJdLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiZGlzY3Vzc19kcmFmdFwiLFxuICAgICAgICAgIGxhYmVsOiBcIkRpc2N1c3MgZnJvbSBkcmFmdFwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkNvbnRpbnVlIHdoZXJlIHRoZSBwcmlvciBkaXNjdXNzaW9uIGxlZnQgb2ZmIFx1MjAxNCBzZWVkIG1hdGVyaWFsIGlzIGxvYWRlZCBhdXRvbWF0aWNhbGx5LlwiLFxuICAgICAgICAgIHJlY29tbWVuZGVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiZGlzY3Vzc19mcmVzaFwiLFxuICAgICAgICAgIGxhYmVsOiBcIlN0YXJ0IGZyZXNoIGRpc2N1c3Npb25cIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJEaXNjYXJkIHRoZSBkcmFmdCBhbmQgc3RhcnQgYSBuZXcgZGlzY3Vzc2lvbiBmcm9tIHNjcmF0Y2guXCIsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJza2lwX21pbGVzdG9uZVwiLFxuICAgICAgICAgIGxhYmVsOiBcIlNraXAgXHUyMDE0IGNyZWF0ZSBuZXcgbWlsZXN0b25lXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiTGVhdmUgdGhpcyBtaWxlc3RvbmUgYXMtaXMgYW5kIHN0YXJ0IHNvbWV0aGluZyBuZXcuXCIsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgbm90WWV0TWVzc2FnZTogXCJSdW4gL2dzZCBkaXNjdXNzIHdoZW4gcmVhZHkgdG8gZGlzY3VzcyB0aGlzIG1pbGVzdG9uZS5cIixcbiAgICB9KTtcblxuICAgIGlmIChjaG9pY2UgPT09IFwiZGlzY3Vzc19kcmFmdFwiKSB7XG4gICAgICBjb25zdCBkaXNjdXNzTWlsZXN0b25lVGVtcGxhdGVzID0gaW5saW5lVGVtcGxhdGUoXCJjb250ZXh0XCIsIFwiQ29udGV4dFwiKTtcbiAgICAgIGNvbnN0IHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUgPSBnZXRTdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmlsaXR5KHBpLCBjdHgpO1xuICAgICAgY29uc3QgYmFzZVByb21wdCA9IGxvYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1taWxlc3RvbmVcIiwge1xuICAgICAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlUGF0aCxcbiAgICAgICAgbWlsZXN0b25lSWQ6IG1pZCwgbWlsZXN0b25lVGl0bGUsIGlubGluZWRUZW1wbGF0ZXM6IGRpc2N1c3NNaWxlc3RvbmVUZW1wbGF0ZXMsIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUsXG4gICAgICAgIGNvbW1pdEluc3RydWN0aW9uOiBidWlsZERvY3NDb21taXRJbnN0cnVjdGlvbihgZG9jcygke21pZH0pOiBtaWxlc3RvbmUgY29udGV4dCBmcm9tIGRpc2N1c3NgKSxcbiAgICAgICAgZmFzdFBhdGhJbnN0cnVjdGlvbjogXCJcIixcbiAgICAgIH0pO1xuICAgICAgY29uc3Qgc2VlZCA9IGRyYWZ0Q29udGVudFxuICAgICAgICA/IGAke2Jhc2VQcm9tcHR9XFxuXFxuIyMgUHJpb3IgRGlzY3Vzc2lvbiAoRHJhZnQgU2VlZClcXG5cXG4ke2RyYWZ0Q29udGVudH1gXG4gICAgICAgIDogYmFzZVByb21wdDtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZVBhdGgsIHsgY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkOiBtaWQsIHN0ZXA6IGZhbHNlIH0pO1xuICAgICAgYXdhaXQgZGlzcGF0Y2hXb3JrZmxvdyhwaSwgc2VlZCwgXCJnc2QtZGlzY3Vzc1wiLCBjdHgsIFwiZGlzY3Vzcy1taWxlc3RvbmVcIik7XG4gICAgfSBlbHNlIGlmIChjaG9pY2UgPT09IFwiZGlzY3Vzc19mcmVzaFwiKSB7XG4gICAgICBjb25zdCBkaXNjdXNzTWlsZXN0b25lVGVtcGxhdGVzID0gaW5saW5lVGVtcGxhdGUoXCJjb250ZXh0XCIsIFwiQ29udGV4dFwiKTtcbiAgICAgIGNvbnN0IHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUgPSBnZXRTdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmlsaXR5KHBpLCBjdHgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlUGF0aCwgeyBjdHgsIHBpLCBiYXNlUGF0aCwgbWlsZXN0b25lSWQ6IG1pZCwgc3RlcDogZmFsc2UgfSk7XG4gICAgICBhd2FpdCBkaXNwYXRjaFdvcmtmbG93KHBpLCBsb2FkUHJvbXB0KFwiZ3VpZGVkLWRpc2N1c3MtbWlsZXN0b25lXCIsIHtcbiAgICAgICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZVBhdGgsXG4gICAgICAgIG1pbGVzdG9uZUlkOiBtaWQsIG1pbGVzdG9uZVRpdGxlLCBpbmxpbmVkVGVtcGxhdGVzOiBkaXNjdXNzTWlsZXN0b25lVGVtcGxhdGVzLCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlLFxuICAgICAgICBjb21taXRJbnN0cnVjdGlvbjogYnVpbGREb2NzQ29tbWl0SW5zdHJ1Y3Rpb24oYGRvY3MoJHttaWR9KTogbWlsZXN0b25lIGNvbnRleHQgZnJvbSBkaXNjdXNzYCksXG4gICAgICAgIGZhc3RQYXRoSW5zdHJ1Y3Rpb246IFwiXCIsXG4gICAgICB9KSwgXCJnc2QtZGlzY3Vzc1wiLCBjdHgsIFwiZGlzY3Vzcy1taWxlc3RvbmVcIik7XG4gICAgfSBlbHNlIGlmIChjaG9pY2UgPT09IFwic2tpcF9taWxlc3RvbmVcIikge1xuICAgICAgY29uc3QgeyBlbnN1cmVEYk9wZW4gfSA9IGF3YWl0IGltcG9ydChcIi4vYm9vdHN0cmFwL2R5bmFtaWMtdG9vbHMuanNcIik7XG4gICAgICBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICAgICAgY29uc3QgbWlsZXN0b25lSWRzID0gZmluZE1pbGVzdG9uZUlkcyhiYXNlUGF0aCk7XG4gICAgICBjb25zdCB1bmlxdWVNaWxlc3RvbmVJZHMgPSAhIWxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcygpPy5wcmVmZXJlbmNlcz8udW5pcXVlX21pbGVzdG9uZV9pZHM7XG4gICAgICBjb25zdCBuZXh0SWQgPSBuZXh0TWlsZXN0b25lSWRSZXNlcnZlZChtaWxlc3RvbmVJZHMsIHVuaXF1ZU1pbGVzdG9uZUlkcywgYmFzZVBhdGgpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlUGF0aCwgeyBjdHgsIHBpLCBiYXNlUGF0aCwgbWlsZXN0b25lSWQ6IG5leHRJZCwgc3RlcDogZmFsc2UgfSk7XG4gICAgICBhd2FpdCBkaXNwYXRjaFdvcmtmbG93KHBpLCBhd2FpdCBwcmVwYXJlQW5kQnVpbGREaXNjdXNzUHJvbXB0KGN0eCwgcGksIG5leHRJZCwgYE5ldyBtaWxlc3RvbmUgJHtuZXh0SWR9LmAsIGJhc2VQYXRoKSwgXCJnc2QtcnVuXCIsIGN0eCwgXCJkaXNjdXNzLW1pbGVzdG9uZVwiKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gRW5zdXJlIERCIGlzIG9wZW4gYmVmb3JlIHF1ZXJ5aW5nIHNsaWNlcyAoIzI1NjApLlxuICAvLyBzaG93RGlzY3VzcygpIGlzIGEgY29tbWFuZCBoYW5kbGVyIFx1MjAxNCB1bmxpa2UgdG9vbCBoYW5kbGVycywgaXQgaGFzIG5vXG4gIC8vIGF1dG9tYXRpYyBlbnN1cmVEYk9wZW4oKSBjYWxsLiBXaXRob3V0IHRoaXMsIGlzRGJBdmFpbGFibGUoKSByZXR1cm5zXG4gIC8vIGZhbHNlIG9uIGNvbGQtc3RhcnQgc2Vzc2lvbnMgYW5kIG5vcm1TbGljZXMgZmFsbHMgdG8gW10gXHUyMTkyIGZhbHNlXG4gIC8vIFwiQWxsIHNsaWNlcyBjb21wbGV0ZVwiIGV4aXQuXG4gIGNvbnN0IHsgZW5zdXJlRGJPcGVuIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2Jvb3RzdHJhcC9keW5hbWljLXRvb2xzLmpzXCIpO1xuICBhd2FpdCBlbnN1cmVEYk9wZW4oKTtcblxuICAvLyBHdWFyZDogbm8gcm9hZG1hcCB5ZXQgKHVubGVzcyBEQiBoYXMgc2xpY2VzKVxuICBjb25zdCByb2FkbWFwRmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiUk9BRE1BUFwiKTtcbiAgY29uc3Qgcm9hZG1hcENvbnRlbnQgPSByb2FkbWFwRmlsZSA/IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBGaWxlKSA6IG51bGw7XG4gIGlmICghcm9hZG1hcENvbnRlbnQgJiYgIWlzRGJBdmFpbGFibGUoKSkge1xuICAgIGN0eC51aS5ub3RpZnkoXCJObyByb2FkbWFwIHlldCBmb3IgdGhpcyBtaWxlc3RvbmUuIFJ1biAvZ3NkIHRvIHBsYW4gZmlyc3QuXCIsIFwid2FybmluZ1wiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBOb3JtYWxpemUgc2xpY2VzOiBwcmVmZXIgREIsIGZhbGwgYmFjayB0byBwYXJzZXJcbiAgdHlwZSBOb3JtU2xpY2UgPSB7IGlkOiBzdHJpbmc7IGRvbmU6IGJvb2xlYW47IHRpdGxlOiBzdHJpbmcgfTtcbiAgbGV0IG5vcm1TbGljZXM6IE5vcm1TbGljZVtdO1xuICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgbm9ybVNsaWNlcyA9IGdldE1pbGVzdG9uZVNsaWNlcyhtaWQpLm1hcChzID0+ICh7IGlkOiBzLmlkLCBkb25lOiBzLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiLCB0aXRsZTogcy50aXRsZSB9KSk7XG4gIH0gZWxzZSB7XG4gICAgbm9ybVNsaWNlcyA9IFtdO1xuICB9XG4gIC8vIERCIGlzIG9wZW4gYnV0IHJldHVybmVkIHplcm8gc2xpY2VzIGRlc3BpdGUgYSByb2FkbWFwIGV4aXN0aW5nIFx1MjAxNFxuICAvLyB0aGUgREIgbWF5IGJlIGVtcHR5IGR1ZSB0byBXQUwgbG9zcyBvciB0cnVuY2F0aW9uIChzZWUgIzI4MTUsICMyODkyKS5cbiAgLy8gRmFsbCBiYWNrIHRvIHJvYWRtYXAgcGFyc2luZyB0byBwcmV2ZW50IGZhbHNlIFwiYWxsIGNvbXBsZXRlXCIgZXhpdC5cbiAgaWYgKG5vcm1TbGljZXMubGVuZ3RoID09PSAwICYmIHJvYWRtYXBDb250ZW50KSB7XG4gICAgbm9ybVNsaWNlcyA9IHBhcnNlUm9hZG1hcFNsaWNlcyhyb2FkbWFwQ29udGVudCkubWFwKHMgPT4gKHsgaWQ6IHMuaWQsIGRvbmU6IHMuZG9uZSwgdGl0bGU6IHMudGl0bGUgfSkpO1xuICB9XG4gIGNvbnN0IHBlbmRpbmdTbGljZXMgPSBub3JtU2xpY2VzLmZpbHRlcihzID0+ICFzLmRvbmUpO1xuXG4gIGlmIChwZW5kaW5nU2xpY2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIC8vIEFsbCBzbGljZXMgY29tcGxldGUgXHUyMDE0IGJ1dCBxdWV1ZWQgbWlsZXN0b25lcyBtYXkgc3RpbGwgbmVlZCBkaXNjdXNzaW9uICgjMzE1MClcbiAgICBjb25zdCBwZW5kaW5nTWlsZXN0b25lcyA9IHN0YXRlLnJlZ2lzdHJ5LmZpbHRlcihtID0+IG0uc3RhdHVzID09PSBcInBlbmRpbmdcIik7XG4gICAgaWYgKHBlbmRpbmdNaWxlc3RvbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IHNob3dEaXNjdXNzUXVldWVkTWlsZXN0b25lKGN0eCwgcGksIGJhc2VQYXRoLCBwZW5kaW5nTWlsZXN0b25lcyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGN0eC51aS5ub3RpZnkoXCJBbGwgc2xpY2VzIGFyZSBjb21wbGV0ZSBcdTIwMTQgbm90aGluZyB0byBkaXNjdXNzLlwiLCBcImluZm9cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gTG9vcDogc2hvdyBwaWNrZXIsIGRpc3BhdGNoIGRpc2N1c3MsIHJlcGVhdCB1bnRpbCBcIm5vdF95ZXRcIlxuICB3aGlsZSAodHJ1ZSkge1xuICAgIC8vIEludmFsaWRhdGUgY2FjaGVzIHNvIHdlIHBpY2sgdXAgQ09OVEVYVCBmaWxlcyB3cml0dGVuIGJ5IHRoZSBqdXN0LWNvbXBsZXRlZCBkaXNjdXNzaW9uXG4gICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuXG4gICAgLy8gQnVpbGQgZGlzY3Vzc2lvbi1zdGF0ZSBtYXA6IHdoaWNoIHNsaWNlcyBoYXZlIENPTlRFWFQgZmlsZXMgYWxyZWFkeT9cbiAgICBjb25zdCBkaXNjdXNzZWRNYXAgPSBuZXcgTWFwPHN0cmluZywgYm9vbGVhbj4oKTtcbiAgICBmb3IgKGNvbnN0IHMgb2YgcGVuZGluZ1NsaWNlcykge1xuICAgICAgY29uc3QgY29udGV4dEZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWQsIHMuaWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgIGRpc2N1c3NlZE1hcC5zZXQocy5pZCwgISFjb250ZXh0RmlsZSk7XG4gICAgfVxuXG4gICAgLy8gSWYgYWxsIHBlbmRpbmcgc2xpY2VzIGFyZSBkaXNjdXNzZWQsIGNoZWNrIGZvciBxdWV1ZWQgbWlsZXN0b25lcyBiZWZvcmUgZXhpdGluZyAoIzMxNTApXG4gICAgY29uc3QgYWxsRGlzY3Vzc2VkID0gcGVuZGluZ1NsaWNlcy5ldmVyeShzID0+IGRpc2N1c3NlZE1hcC5nZXQocy5pZCkpO1xuICAgIGlmIChhbGxEaXNjdXNzZWQpIHtcbiAgICAgIGNvbnN0IHBlbmRpbmdNaWxlc3RvbmVzID0gc3RhdGUucmVnaXN0cnkuZmlsdGVyKG0gPT4gbS5zdGF0dXMgPT09IFwicGVuZGluZ1wiKTtcbiAgICAgIGlmIChwZW5kaW5nTWlsZXN0b25lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgIGF3YWl0IHNob3dEaXNjdXNzUXVldWVkTWlsZXN0b25lKGN0eCwgcGksIGJhc2VQYXRoLCBwZW5kaW5nTWlsZXN0b25lcyk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxvY2tEYXRhID0gcmVhZFNlc3Npb25Mb2NrRGF0YShiYXNlUGF0aCk7XG4gICAgICBjb25zdCByZW1vdGVBdXRvUnVubmluZyA9IGxvY2tEYXRhICYmIGxvY2tEYXRhLnBpZCAhPT0gcHJvY2Vzcy5waWQgJiYgaXNTZXNzaW9uTG9ja1Byb2Nlc3NBbGl2ZShsb2NrRGF0YSk7XG4gICAgICBjb25zdCBuZXh0U3RlcCA9IHJlbW90ZUF1dG9SdW5uaW5nXG4gICAgICAgID8gXCJBdXRvLW1vZGUgaXMgYWxyZWFkeSBydW5uaW5nIFx1MjAxNCB1c2UgL2dzZCBzdGF0dXMgdG8gY2hlY2sgcHJvZ3Jlc3MuXCJcbiAgICAgICAgOiBcIlJ1biAvZ3NkIHRvIHN0YXJ0IHBsYW5uaW5nLlwiO1xuICAgICAgY3R4LnVpLm5vdGlmeShcbiAgICAgICAgYEFsbCAke3BlbmRpbmdTbGljZXMubGVuZ3RofSBzbGljZXMgZGlzY3Vzc2VkLiAke25leHRTdGVwfWAsXG4gICAgICAgIFwiaW5mb1wiLFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBGaW5kIHRoZSBmaXJzdCB1bmRpc2N1c3NlZCBzbGljZSB0byByZWNvbW1lbmRcbiAgICBjb25zdCBmaXJzdFVuZGlzY3Vzc2VkSWQgPSBwZW5kaW5nU2xpY2VzLmZpbmQocyA9PiAhZGlzY3Vzc2VkTWFwLmdldChzLmlkKSk/LmlkO1xuXG4gICAgY29uc3QgYWN0aW9ucyA9IHBlbmRpbmdTbGljZXMubWFwKChzKSA9PiB7XG4gICAgICBjb25zdCBkaXNjdXNzZWQgPSBkaXNjdXNzZWRNYXAuZ2V0KHMuaWQpID8/IGZhbHNlO1xuICAgICAgY29uc3Qgc3RhdHVzUGFydHM6IHN0cmluZ1tdID0gW107XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlU2xpY2U/LmlkID09PSBzLmlkKSBzdGF0dXNQYXJ0cy5wdXNoKFwiYWN0aXZlXCIpO1xuICAgICAgZWxzZSBzdGF0dXNQYXJ0cy5wdXNoKFwidXBjb21pbmdcIik7XG4gICAgICBzdGF0dXNQYXJ0cy5wdXNoKGRpc2N1c3NlZCA/IFwiZGlzY3Vzc2VkIFx1MjcxM1wiIDogXCJub3QgZGlzY3Vzc2VkXCIpO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBpZDogcy5pZCxcbiAgICAgICAgbGFiZWw6IGAke3MuaWR9OiAke3MudGl0bGV9YCxcbiAgICAgICAgZGVzY3JpcHRpb246IHN0YXR1c1BhcnRzLmpvaW4oXCIgXHUwMEI3IFwiKSxcbiAgICAgICAgcmVjb21tZW5kZWQ6IHMuaWQgPT09IGZpcnN0VW5kaXNjdXNzZWRJZCxcbiAgICAgIH07XG4gICAgfSk7XG5cbiAgICAvLyBPZmZlciBhY2Nlc3MgdG8gcXVldWVkIG1pbGVzdG9uZXMgd2hlbiBhbnkgZXhpc3RcbiAgICBjb25zdCBwZW5kaW5nTWlsZXN0b25lcyA9IHN0YXRlLnJlZ2lzdHJ5LmZpbHRlcihtID0+IG0uc3RhdHVzID09PSBcInBlbmRpbmdcIik7XG4gICAgaWYgKHBlbmRpbmdNaWxlc3RvbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgIGFjdGlvbnMucHVzaCh7XG4gICAgICAgIGlkOiBcImRpc2N1c3NfcXVldWVkX21pbGVzdG9uZVwiLFxuICAgICAgICBsYWJlbDogXCJEaXNjdXNzIGEgcXVldWVkIG1pbGVzdG9uZVwiLFxuICAgICAgICBkZXNjcmlwdGlvbjogYFJlZmluZSBjb250ZXh0IGZvciAke3BlbmRpbmdNaWxlc3RvbmVzLmxlbmd0aH0gcXVldWVkIG1pbGVzdG9uZShzKS4gRG9lcyBub3QgYWZmZWN0IGN1cnJlbnQgZXhlY3V0aW9uLmAsXG4gICAgICAgIHJlY29tbWVuZGVkOiBmYWxzZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGNob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgICAgdGl0bGU6IFwiR1NEIFx1MjAxNCBEaXNjdXNzIGEgc2xpY2VcIixcbiAgICAgIHN1bW1hcnk6IFtcbiAgICAgICAgYCR7bWlkfTogJHttaWxlc3RvbmVUaXRsZX1gLFxuICAgICAgICBcIlBpY2sgYSBzbGljZSB0byBpbnRlcnZpZXcuIENvbnRleHQgZmlsZSB3aWxsIGJlIHdyaXR0ZW4gd2hlbiBkb25lLlwiLFxuICAgICAgXSxcbiAgICAgIGFjdGlvbnMsXG4gICAgICBub3RZZXRNZXNzYWdlOiBcIlJ1biAvZ3NkIGRpc2N1c3Mgd2hlbiByZWFkeS5cIixcbiAgICB9KTtcblxuICAgIGlmIChjaG9pY2UgPT09IFwibm90X3lldFwiKSByZXR1cm47XG5cbiAgICBpZiAoY2hvaWNlID09PSBcImRpc2N1c3NfcXVldWVkX21pbGVzdG9uZVwiKSB7XG4gICAgICBhd2FpdCBzaG93RGlzY3Vzc1F1ZXVlZE1pbGVzdG9uZShjdHgsIHBpLCBiYXNlUGF0aCwgcGVuZGluZ01pbGVzdG9uZXMpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGNob3NlbiA9IHBlbmRpbmdTbGljZXMuZmluZChzID0+IHMuaWQgPT09IGNob2ljZSk7XG4gICAgaWYgKCFjaG9zZW4pIHJldHVybjtcblxuICAgIC8vIElmIHRoZSBzbGljZSBhbHJlYWR5IGhhcyBhIENPTlRFWFQgZmlsZSwgY29uZmlybSByZS1kaXNjdXNzIGludGVudFxuICAgIGNvbnN0IGlzUmVkaXNjdXNzID0gZGlzY3Vzc2VkTWFwLmdldChjaG9zZW4uaWQpID8/IGZhbHNlO1xuICAgIGlmIChpc1JlZGlzY3Vzcykge1xuICAgICAgY29uc3QgY29uZmlybSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgICAgICB0aXRsZTogYFJlLWRpc2N1c3MgJHtjaG9zZW4uaWR9P2AsXG4gICAgICAgIHN1bW1hcnk6IFtcbiAgICAgICAgICBgJHtjaG9zZW4uaWR9IGFscmVhZHkgaGFzIGEgY29udGV4dCBmaWxlIGZyb20gYSBwcmlvciBkaXNjdXNzaW9uLmAsXG4gICAgICAgICAgXCJSZS1kaXNjdXNzaW5nIHdpbGwgaW50ZXJ2aWV3IGZvciB1cGRhdGVzIGFuZCByZXdyaXRlIHRoZSBjb250ZXh0IGZpbGUuXCIsXG4gICAgICAgIF0sXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICB7IGlkOiBcInJlZGlzY3Vzc1wiLCBsYWJlbDogXCJSZS1kaXNjdXNzIHRvIHVwZGF0ZSBjb250ZXh0XCIsIGRlc2NyaXB0aW9uOiBcIkludGVydmlldyBmb3IgY2hhbmdlcyBhbmQgcmV3cml0ZVwiLCByZWNvbW1lbmRlZDogdHJ1ZSB9LFxuICAgICAgICAgIHsgaWQ6IFwiY2FuY2VsXCIsIGxhYmVsOiBcIkNhbmNlbFwiLCBkZXNjcmlwdGlvbjogXCJHbyBiYWNrIHRvIHNsaWNlIHBpY2tlclwiIH0sXG4gICAgICAgIF0sXG4gICAgICB9KTtcbiAgICAgIGlmIChjb25maXJtICE9PSBcInJlZGlzY3Vzc1wiKSBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBzcUF2YWlsID0gZ2V0U3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJpbGl0eShwaSwgY3R4KTtcbiAgICBjb25zdCBwcm9tcHQgPSBhd2FpdCBidWlsZERpc2N1c3NTbGljZVByb21wdChtaWQsIGNob3Nlbi5pZCwgY2hvc2VuLnRpdGxlLCBiYXNlUGF0aCwgeyByZWRpc2N1c3M6IGlzUmVkaXNjdXNzLCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlOiBzcUF2YWlsIH0pO1xuICAgIGF3YWl0IGRpc3BhdGNoV29ya2Zsb3cocGksIHByb21wdCwgXCJnc2QtZGlzY3Vzc1wiLCBjdHgsIFwiZGlzY3Vzcy1zbGljZVwiKTtcblxuICAgIC8vIFdhaXQgZm9yIHRoZSBkaXNjdXNzIHNlc3Npb24gdG8gZmluaXNoLCB0aGVuIGxvb3AgYmFjayB0byB0aGUgcGlja2VyXG4gICAgYXdhaXQgY3R4LndhaXRGb3JJZGxlKCk7XG4gICAgaW52YWxpZGF0ZUFsbENhY2hlcygpO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBRdWV1ZWQgTWlsZXN0b25lIERpc2N1c3Npb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogU2hvdyBhIHBpY2tlciBvZiBxdWV1ZWQgKHBlbmRpbmcpIG1pbGVzdG9uZXMgYW5kIGRpc3BhdGNoIGEgZGlzY3VzcyBmbG93IGZvclxuICogdGhlIGNob3NlbiBvbmUuIERpc2N1c3NpbmcgYSBxdWV1ZWQgbWlsZXN0b25lIGRvZXMgTk9UIGFjdGl2YXRlIGl0IFx1MjAxNCBpdCBvbmx5XG4gKiByZWZpbmVzIHRoZSBDT05URVhULm1kIGFydGlmYWN0IHNvIGl0IGlzIGJldHRlciBwcmVwYXJlZCB3aGVuIGF1dG8tbW9kZVxuICogZXZlbnR1YWxseSByZWFjaGVzIGl0LlxuICovXG5hc3luYyBmdW5jdGlvbiBzaG93RGlzY3Vzc1F1ZXVlZE1pbGVzdG9uZShcbiAgY3R4OiBFeHRlbnNpb25Db21tYW5kQ29udGV4dCxcbiAgcGk6IEV4dGVuc2lvbkFQSSxcbiAgYmFzZVBhdGg6IHN0cmluZyxcbiAgcGVuZGluZ01pbGVzdG9uZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgc3RhdHVzOiBzdHJpbmcgfT4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgYWN0aW9ucyA9IHBlbmRpbmdNaWxlc3RvbmVzLm1hcCgobSwgaSkgPT4ge1xuICAgIGNvbnN0IGhhc0NvbnRleHQgPSAhIXJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtLmlkLCBcIkNPTlRFWFRcIik7XG4gICAgY29uc3QgaGFzRHJhZnQgPSAhaGFzQ29udGV4dCAmJiAhIXJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtLmlkLCBcIkNPTlRFWFQtRFJBRlRcIik7XG4gICAgY29uc3QgY29udGV4dFN0YXR1cyA9IGhhc0NvbnRleHQgPyBcImNvbnRleHQgXHUyNzEzXCIgOiBoYXNEcmFmdCA/IFwiZHJhZnQgY29udGV4dFwiIDogXCJubyBjb250ZXh0IHlldFwiO1xuICAgIHJldHVybiB7XG4gICAgICBpZDogbS5pZCxcbiAgICAgIGxhYmVsOiBgJHttLmlkfTogJHttLnRpdGxlfWAsXG4gICAgICBkZXNjcmlwdGlvbjogYFtxdWV1ZWRdIFx1MDBCNyAke2NvbnRleHRTdGF0dXN9YCxcbiAgICAgIHJlY29tbWVuZGVkOiBpID09PSAwLFxuICAgIH07XG4gIH0pO1xuXG4gIGNvbnN0IGNob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgRGlzY3VzcyBhIHF1ZXVlZCBtaWxlc3RvbmVcIixcbiAgICBzdW1tYXJ5OiBbXG4gICAgICBcIlNlbGVjdCBhIHF1ZXVlZCBtaWxlc3RvbmUgdG8gZGlzY3Vzcy5cIixcbiAgICAgIFwiRGlzY3Vzc2luZyB3aWxsIHVwZGF0ZSBpdHMgY29udGV4dCBmaWxlLiBJdCB3aWxsIG5vdCBiZSBhY3RpdmF0ZWQuXCIsXG4gICAgXSxcbiAgICBhY3Rpb25zLFxuICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2QgZGlzY3VzcyB3aGVuIHJlYWR5LlwiLFxuICB9KTtcblxuICBpZiAoY2hvaWNlID09PSBcIm5vdF95ZXRcIikgcmV0dXJuO1xuXG4gIGNvbnN0IGNob3NlbiA9IHBlbmRpbmdNaWxlc3RvbmVzLmZpbmQobSA9PiBtLmlkID09PSBjaG9pY2UpO1xuICBpZiAoIWNob3NlbikgcmV0dXJuO1xuXG4gIGNvbnN0IGhhc0RyYWZ0ID0gISFyZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgY2hvc2VuLmlkLCBcIkNPTlRFWFQtRFJBRlRcIik7XG4gIGxldCBmYXN0UGF0aCA9IGhhc0RyYWZ0O1xuXG4gIGlmICghaGFzRHJhZnQpIHtcbiAgICBjb25zdCBtb2RlID0gYXdhaXQgc2hvd05leHRBY3Rpb24oY3R4LCB7XG4gICAgICB0aXRsZTogYERpc2N1c3MgJHtjaG9zZW4uaWR9YCxcbiAgICAgIHN1bW1hcnk6IFtcbiAgICAgICAgXCJDaG9vc2UgaG93IHRvIHN0YXJ0IHRoZSBkaXNjdXNzaW9uLlwiLFxuICAgICAgICBcIkZhc3QgcGF0aCBza2lwcyBnZW5lcmljIHNjb3V0aW5nIFx1MjAxNCB1c2UgaXQgd2hlbiB5b3UgYWxyZWFkeSBrbm93IHRoZSBzY29wZS5cIixcbiAgICAgIF0sXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJmdWxsXCIsXG4gICAgICAgICAgbGFiZWw6IFwiRnVsbCBkaXNjdXNzaW9uXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiU2NvdXQgdGhlIGNvZGViYXNlLCBhc2sgb3Blbi1lbmRlZCBxdWVzdGlvbnMsIGV4cGxvcmUgZGVlcGx5XCIsXG4gICAgICAgICAgcmVjb21tZW5kZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJmYXN0XCIsXG4gICAgICAgICAgbGFiZWw6IFwiSSBoYXZlIHRoZSBzY29wZSBcdTIwMTQgZmFzdCBwYXRoXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiVHJlYXQgeW91ciBmaXJzdCBtZXNzYWdlIGFzIGF1dGhvcml0YXRpdmUgc2VlZCBjb250ZXh0OyBza2lwIHNjb3V0aW5nXCIsXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgbm90WWV0TWVzc2FnZTogXCJSdW4gL2dzZCBkaXNjdXNzIHdoZW4gcmVhZHkuXCIsXG4gICAgfSk7XG4gICAgaWYgKG1vZGUgPT09IFwibm90X3lldFwiKSByZXR1cm47XG4gICAgZmFzdFBhdGggPSBtb2RlID09PSBcImZhc3RcIjtcbiAgfVxuXG4gIGF3YWl0IGRpc3BhdGNoRGlzY3Vzc0Zvck1pbGVzdG9uZShjdHgsIHBpLCBiYXNlUGF0aCwgY2hvc2VuLmlkLCBjaG9zZW4udGl0bGUsIHsgZmFzdFBhdGggfSk7XG59XG5cbi8qKlxuICogRGlzcGF0Y2ggdGhlIGd1aWRlZC1kaXNjdXNzLW1pbGVzdG9uZSBwcm9tcHQgZm9yIGEgbWlsZXN0b25lIHdpdGhvdXRcbiAqIHNldHRpbmcgcGVuZGluZ0F1dG9TdGFydCBcdTIwMTQgc28gZGlzY3Vzc2luZyBhIHF1ZXVlZCBtaWxlc3RvbmUgZG9lcyBub3RcbiAqIGltcGxpY2l0bHkgYWN0aXZhdGUgaXQgd2hlbiB0aGUgc2Vzc2lvbiBlbmRzLlxuICovXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaERpc2N1c3NGb3JNaWxlc3RvbmUoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pZDogc3RyaW5nLFxuICBtaWxlc3RvbmVUaXRsZTogc3RyaW5nLFxuICBvcHRzOiB7IGZhc3RQYXRoPzogYm9vbGVhbiB9ID0ge30sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZHJhZnRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJDT05URVhULURSQUZUXCIpO1xuICBjb25zdCBkcmFmdENvbnRlbnQgPSBkcmFmdEZpbGUgPyBhd2FpdCBsb2FkRmlsZShkcmFmdEZpbGUpIDogbnVsbDtcbiAgY29uc3QgaGFzU2VlZCA9ICEhKGRyYWZ0Q29udGVudCB8fCBvcHRzLmZhc3RQYXRoKTtcbiAgY29uc3QgZmFzdFBhdGhJbnN0cnVjdGlvbiA9IGhhc1NlZWRcbiAgICA/IFtcbiAgICAgICAgXCI+ICoqRmFzdCBwYXRoIGFjdGl2ZSBcdTIwMTQgc2NvcGUgcHJvdmlkZWQuKipcIixcbiAgICAgICAgXCI+IERvIE5PVCBwZXJmb3JtIGEgZ2VuZXJpYyBjb2RlYmFzZSBzY291dGluZyBwYXNzLlwiLFxuICAgICAgICBcIj4gRG8gYXQgbW9zdCAyIHRhcmdldGVkIHJlYWRzIHRvIGNoZWNrIGZvciBvYnZpb3VzIGNvbmZsaWN0cyB3aXRoIGV4aXN0aW5nIHdvcmsuXCIsXG4gICAgICAgIFwiPiBUcmVhdCB0aGUgc2VlZCBjb250ZXh0IG9yIHRoZSBvcGVyYXRvcidzIGZpcnN0IG1lc3NhZ2UgYXMgYXV0aG9yaXRhdGl2ZS5cIixcbiAgICAgICAgXCI+IE1vdmUgZGlyZWN0bHkgdG8gdGhlIGRlcHRoIHN1bW1hcnkgYW5kIHdyaXRlIHN0ZXAuXCIsXG4gICAgICAgIFwiPiBBc2sgb25seSBxdWVzdGlvbnMgd2hlcmUgdGhlIGFuc3dlciB3b3VsZCBtYXRlcmlhbGx5IGNoYW5nZSBzY29wZS5cIixcbiAgICAgIF0uam9pbihcIlxcblwiKVxuICAgIDogXCJcIjtcbiAgY29uc3QgZGlzY3Vzc01pbGVzdG9uZVRlbXBsYXRlcyA9IGlubGluZVRlbXBsYXRlKFwiY29udGV4dFwiLCBcIkNvbnRleHRcIik7XG4gIGNvbnN0IHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUgPSBnZXRTdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmlsaXR5KHBpLCBjdHgpO1xuICBjb25zdCBiYXNlUHJvbXB0ID0gbG9hZFByb21wdChcImd1aWRlZC1kaXNjdXNzLW1pbGVzdG9uZVwiLCB7XG4gICAgd29ya2luZ0RpcmVjdG9yeTogYmFzZVBhdGgsXG4gICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICBtaWxlc3RvbmVUaXRsZSxcbiAgICBpbmxpbmVkVGVtcGxhdGVzOiBkaXNjdXNzTWlsZXN0b25lVGVtcGxhdGVzLFxuICAgIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUsXG4gICAgY29tbWl0SW5zdHJ1Y3Rpb246IGJ1aWxkRG9jc0NvbW1pdEluc3RydWN0aW9uKGBkb2NzKCR7bWlkfSk6IG1pbGVzdG9uZSBjb250ZXh0IGZyb20gZGlzY3Vzc2ApLFxuICAgIGZhc3RQYXRoSW5zdHJ1Y3Rpb24sXG4gIH0pO1xuICBjb25zdCBwcm9tcHQgPSBkcmFmdENvbnRlbnRcbiAgICA/IGAke2Jhc2VQcm9tcHR9XFxuXFxuIyMgUHJpb3IgRGlzY3Vzc2lvbiAoRHJhZnQgU2VlZClcXG5cXG4ke2RyYWZ0Q29udGVudH1gXG4gICAgOiBiYXNlUHJvbXB0O1xuICBhd2FpdCBkaXNwYXRjaFdvcmtmbG93KHBpLCBwcm9tcHQsIFwiZ3NkLWRpc2N1c3NcIiwgY3R4LCBcImRpc2N1c3MtbWlsZXN0b25lXCIpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgU21hcnQgRW50cnkgUG9pbnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogVGhlIG9uZSB3aXphcmQuIFJlYWRzIHN0YXRlLCBzaG93cyBjb250ZXh0dWFsIG9wdGlvbnMsIGRpc3BhdGNoZXMgaW50byB0aGUgd29ya2Zsb3cgZG9jLlxuICovXG4vKipcbiAqIFNlbGYtaGVhbDogc2NhbiBydW50aW1lIHJlY29yZHMgYW5kIGNsZWFyIHN0YWxlIG9uZXMgbGVmdCBiZWhpbmQgd2hlblxuICogYXV0by1tb2RlIGNyYXNoZWQgbWlkLXVuaXQuIGF1dG8udHMgaGFzIGl0cyBvd24gc2VsZkhlYWxSdW50aW1lUmVjb3JkcygpXG4gKiBidXQgZ3VpZGVkLWZsb3cgKG1hbnVhbCAvZ3NkIG1vZGUpIG5ldmVyIGNhbGxlZCBpdCBcdTIwMTQgbWVhbmluZyBzdGFsZSByZWNvcmRzXG4gKiBwZXJzaXN0ZWQgdW50aWwgdGhlIG5leHQgL2dzZCBhdXRvIHJ1bi4gIFRoaXMgZW5zdXJlcyB0aGUgd2l6YXJkIGFsd2F5c1xuICogc3RhcnRzIGZyb20gYSBjbGVhbiBzdGF0ZSByZWdhcmRsZXNzIG9mIGhvdyB0aGUgcHJldmlvdXMgc2Vzc2lvbiBlbmRlZC5cbiAqL1xuZnVuY3Rpb24gc2VsZkhlYWxSdW50aW1lUmVjb3JkcyhiYXNlUGF0aDogc3RyaW5nLCBjdHg6IEV4dGVuc2lvbkNvbnRleHQpOiB7IGNsZWFyZWQ6IG51bWJlciB9IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZWNvcmRzID0gbGlzdFVuaXRSdW50aW1lUmVjb3JkcyhiYXNlUGF0aCk7XG4gICAgbGV0IGNsZWFyZWQgPSAwO1xuICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIHJlY29yZHMpIHtcbiAgICAgIGNvbnN0IHsgdW5pdFR5cGUsIHVuaXRJZCwgcGhhc2UgfSA9IHJlY29yZDtcbiAgICAgIC8vIENsZWFyIHJlY29yZHMgd2hvc2UgZXhwZWN0ZWQgYXJ0aWZhY3QgYWxyZWFkeSBleGlzdHMgKGNvbXBsZXRlZCBidXQgbm90IGNsZWFuZWQgdXApXG4gICAgICAvLyBUT0RPKEMtZnV0dXJlKTogc2VsZkhlYWxSdW50aW1lUmVjb3JkcyBpdGVyYXRlcyBhY3Jvc3MgYWxsIHVuaXQgdHlwZXMgKG5vdCBqdXN0IG1pbGVzdG9uZVxuICAgICAgLy8gdW5pdHMpLCBzbyBpdCBjYW5ub3QgYmUgY29udmVydGVkIHRvIHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aEZvclNjb3BlIHdpdGhvdXRcbiAgICAgIC8vIGZpcnN0IGVzdGFibGlzaGluZyBhIHBlci1yZWNvcmQgc2NvcGUuICBNaWdyYXRlIG9uY2UgdW5pdCBydW50aW1lIHJlY29yZHMgY2Fycnkgc2NvcGUgaW5mby5cbiAgICAgIGNvbnN0IGFydGlmYWN0UGF0aCA9IHJlc29sdmVFeHBlY3RlZEFydGlmYWN0UGF0aCh1bml0VHlwZSwgdW5pdElkLCBiYXNlUGF0aCk7XG4gICAgICBpZiAoYXJ0aWZhY3RQYXRoICYmIGV4aXN0c1N5bmMoYXJ0aWZhY3RQYXRoKSkge1xuICAgICAgICBjbGVhclVuaXRSdW50aW1lUmVjb3JkKGJhc2VQYXRoLCB1bml0VHlwZSwgdW5pdElkKTtcbiAgICAgICAgY2xlYXJlZCsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIENsZWFyIHJlY29yZHMgc3R1Y2sgaW4gYW4gaW4tZmxpZ2h0IHBoYXNlIChwcm9jZXNzIGRpZWQgbWlkLXVuaXQpLlxuICAgICAgaWYgKGlzSW5GbGlnaHRSdW50aW1lUGhhc2UocGhhc2UpKSB7XG4gICAgICAgIGNsZWFyVW5pdFJ1bnRpbWVSZWNvcmQoYmFzZVBhdGgsIHVuaXRUeXBlLCB1bml0SWQpO1xuICAgICAgICBjbGVhcmVkKys7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChjbGVhcmVkID4gMCkge1xuICAgICAgY3R4LnVpLm5vdGlmeShgU2VsZi1oZWFsOiBjbGVhcmVkICR7Y2xlYXJlZH0gc3RhbGUgcnVudGltZSByZWNvcmQocykgZnJvbSBhIHByZXZpb3VzIHNlc3Npb24uYCwgXCJpbmZvXCIpO1xuICAgIH1cbiAgICByZXR1cm4geyBjbGVhcmVkIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2dXYXJuaW5nKFwiZ3VpZGVkXCIsIGBzZWxmLWhlYWwgc3RhbGUgcnVudGltZSByZWNvcmRzIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gKTtcbiAgICByZXR1cm4geyBjbGVhcmVkOiAwIH07XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIE1pbGVzdG9uZSBBY3Rpb25zIFN1Ym1lbnUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogU2hvd3MgYSBzdWJtZW51IHdpdGggUGFyayAvIERpc2NhcmQgLyBTa2lwIC8gQmFjayBvcHRpb25zIGZvciB0aGUgYWN0aXZlIG1pbGVzdG9uZS5cbiAqIFJldHVybnMgdHJ1ZSBpZiBhbiBhY3Rpb24gd2FzIHRha2VuIChjYWxsZXIgc2hvdWxkIHJlLWVudGVyIHNob3dTbWFydEVudHJ5IG9yXG4gKiBkaXNwYXRjaCBhIG5ldyB3b3JrZmxvdykuIFJldHVybnMgZmFsc2UgaWYgdGhlIHVzZXIgY2hvc2UgXCJCYWNrXCIuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZU1pbGVzdG9uZUFjdGlvbnMoXG4gIGN0eDogRXh0ZW5zaW9uQ29tbWFuZENvbnRleHQsXG4gIHBpOiBFeHRlbnNpb25BUEksXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pbGVzdG9uZUlkOiBzdHJpbmcsXG4gIG1pbGVzdG9uZVRpdGxlOiBzdHJpbmcsXG4gIG9wdGlvbnM/OiB7IHN0ZXA/OiBib29sZWFuIH0sXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3Qgc3RlcE1vZGUgPSBvcHRpb25zPy5zdGVwO1xuICBjb25zdCBjaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICB0aXRsZTogYE1pbGVzdG9uZSBBY3Rpb25zIFx1MjAxNCAke21pbGVzdG9uZUlkfWAsXG4gICAgc3VtbWFyeTogW2Ake21pbGVzdG9uZUlkfTogJHttaWxlc3RvbmVUaXRsZX1gXSxcbiAgICBhY3Rpb25zOiBbXG4gICAgICB7XG4gICAgICAgIGlkOiBcInBhcmtcIixcbiAgICAgICAgbGFiZWw6IFwiUGFyayBtaWxlc3RvbmVcIixcbiAgICAgICAgZGVzY3JpcHRpb246IFwiUGF1c2UgdGhpcyBtaWxlc3RvbmUgXHUyMDE0IGl0IHN0YXlzIG9uIGRpc2sgYnV0IGlzIHNraXBwZWQuXCIsXG4gICAgICB9LFxuICAgICAge1xuICAgICAgICBpZDogXCJkaXNjYXJkXCIsXG4gICAgICAgIGxhYmVsOiBcIkRpc2NhcmQgbWlsZXN0b25lXCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIlBlcm1hbmVudGx5IGRlbGV0ZSB0aGlzIG1pbGVzdG9uZSBhbmQgYWxsIGl0cyBjb250ZW50cy5cIixcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGlkOiBcInNraXBcIixcbiAgICAgICAgbGFiZWw6IFwiU2tpcCBcdTIwMTQgY3JlYXRlIG5ldyBtaWxlc3RvbmVcIixcbiAgICAgICAgZGVzY3JpcHRpb246IFwiTGVhdmUgdGhpcyBtaWxlc3RvbmUgYW5kIHN0YXJ0IGEgZnJlc2ggb25lLlwiLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwiYmFja1wiLFxuICAgICAgICBsYWJlbDogXCJCYWNrXCIsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIlJldHVybiB0byB0aGUgcHJldmlvdXMgbWVudS5cIixcbiAgICAgIH0sXG4gICAgXSxcbiAgICBub3RZZXRNZXNzYWdlOiBcIlJ1biAvZ3NkIHdoZW4gcmVhZHkuXCIsXG4gIH0pO1xuXG4gIGlmIChjaG9pY2UgPT09IFwicGFya1wiKSB7XG4gICAgY29uc3QgcmVhc29uID0gYXdhaXQgc2hvd05leHRBY3Rpb24oY3R4LCB7XG4gICAgICB0aXRsZTogYFBhcmsgJHttaWxlc3RvbmVJZH1gLFxuICAgICAgc3VtbWFyeTogW1wiV2h5IGlzIHRoaXMgbWlsZXN0b25lIGJlaW5nIHBhcmtlZD9cIl0sXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgIHsgaWQ6IFwicHJpb3JpdHlfc2hpZnRcIiwgbGFiZWw6IFwiUHJpb3JpdHkgc2hpZnRcIiwgZGVzY3JpcHRpb246IFwiT3RoZXIgd29yayBpcyBtb3JlIGltcG9ydGFudCByaWdodCBub3cuXCIgfSxcbiAgICAgICAgeyBpZDogXCJibG9ja2VkX2V4dGVybmFsXCIsIGxhYmVsOiBcIkJsb2NrZWQgZXh0ZXJuYWxseVwiLCBkZXNjcmlwdGlvbjogXCJXYWl0aW5nIG9uIGFuIGV4dGVybmFsIGRlcGVuZGVuY3kgb3IgZGVjaXNpb24uXCIgfSxcbiAgICAgICAgeyBpZDogXCJuZWVkc19yZXRoaW5rXCIsIGxhYmVsOiBcIk5lZWRzIHJldGhpbmtpbmdcIiwgZGVzY3JpcHRpb246IFwiVGhlIGFwcHJvYWNoIG5lZWRzIHRvIGJlIHJlY29uc2lkZXJlZC5cIiB9LFxuICAgICAgXSxcbiAgICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2Qgd2hlbiByZWFkeS5cIixcbiAgICB9KTtcblxuICAgIC8vIFVzZXIgcHJlc3NlZCBcIk5vdCB5ZXRcIiAvIEVzY2FwZSBcdTIwMTQgY2FuY2VsIHRoZSBwYXJrIG9wZXJhdGlvblxuICAgIGlmICghcmVhc29uIHx8IHJlYXNvbiA9PT0gXCJub3RfeWV0XCIpIHJldHVybiBmYWxzZTtcblxuICAgIGNvbnN0IHJlYXNvblRleHQgPSByZWFzb24gPT09IFwicHJpb3JpdHlfc2hpZnRcIiA/IFwiUHJpb3JpdHkgc2hpZnQgXHUyMDE0IG90aGVyIHdvcmsgaXMgbW9yZSBpbXBvcnRhbnRcIlxuICAgICAgOiByZWFzb24gPT09IFwiYmxvY2tlZF9leHRlcm5hbFwiID8gXCJCbG9ja2VkIGV4dGVybmFsbHkgXHUyMDE0IHdhaXRpbmcgb24gZXh0ZXJuYWwgZGVwZW5kZW5jeVwiXG4gICAgICA6IHJlYXNvbiA9PT0gXCJuZWVkc19yZXRoaW5rXCIgPyBcIk5lZWRzIHJldGhpbmtpbmcgXHUyMDE0IGFwcHJvYWNoIG5lZWRzIHJlY29uc2lkZXJhdGlvblwiXG4gICAgICA6IFwiUGFya2VkIGJ5IHVzZXJcIjtcblxuICAgIGNvbnN0IHN1Y2Nlc3MgPSBwYXJrTWlsZXN0b25lKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgcmVhc29uVGV4dCk7XG4gICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgIGN0eC51aS5ub3RpZnkoYFBhcmtlZCAke21pbGVzdG9uZUlkfS4gUnVuIC9nc2QgdW5wYXJrICR7bWlsZXN0b25lSWR9IHRvIHJlYWN0aXZhdGUuYCwgXCJpbmZvXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjdHgudWkubm90aWZ5KGBDb3VsZCBub3QgcGFyayAke21pbGVzdG9uZUlkfSBcdTIwMTQgbWlsZXN0b25lIG5vdCBmb3VuZCBvciBhbHJlYWR5IHBhcmtlZC5gLCBcIndhcm5pbmdcIik7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaWYgKGNob2ljZSA9PT0gXCJkaXNjYXJkXCIpIHtcbiAgICBjb25zdCBjb25maXJtZWQgPSBhd2FpdCBzaG93Q29uZmlybShjdHgsIHtcbiAgICAgIHRpdGxlOiBcIkRpc2NhcmQgbWlsZXN0b25lP1wiLFxuICAgICAgbWVzc2FnZTogYFRoaXMgd2lsbCBwZXJtYW5lbnRseSBkZWxldGUgJHttaWxlc3RvbmVJZH0gYW5kIGFsbCBpdHMgY29udGVudHMgKHJvYWRtYXAsIHBsYW5zLCB0YXNrIHN1bW1hcmllcykuYCxcbiAgICAgIGNvbmZpcm1MYWJlbDogXCJEaXNjYXJkXCIsXG4gICAgICBkZWNsaW5lTGFiZWw6IFwiQ2FuY2VsXCIsXG4gICAgfSk7XG4gICAgaWYgKGNvbmZpcm1lZCkge1xuICAgICAgZGlzY2FyZE1pbGVzdG9uZShiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgICAgY3R4LnVpLm5vdGlmeShgRGlzY2FyZGVkICR7bWlsZXN0b25lSWR9LmAsIFwiaW5mb1wiKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBpZiAoY2hvaWNlID09PSBcInNraXBcIikge1xuICAgIGNvbnN0IG1pbGVzdG9uZUlkcyA9IGZpbmRNaWxlc3RvbmVJZHMoYmFzZVBhdGgpO1xuICAgIGNvbnN0IHVuaXF1ZU1pbGVzdG9uZUlkcyA9ICEhbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy51bmlxdWVfbWlsZXN0b25lX2lkcztcbiAgICBjb25zdCBuZXh0SWQgPSBuZXh0TWlsZXN0b25lSWRSZXNlcnZlZChtaWxlc3RvbmVJZHMsIHVuaXF1ZU1pbGVzdG9uZUlkcywgYmFzZVBhdGgpO1xuICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZVBhdGgsIHsgY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkOiBuZXh0SWQsIHN0ZXA6IHN0ZXBNb2RlIH0pO1xuICAgIGF3YWl0IGRpc3BhdGNoV29ya2Zsb3cocGksIGF3YWl0IHByZXBhcmVBbmRCdWlsZERpc2N1c3NQcm9tcHQoY3R4LCBwaSwgbmV4dElkLFxuICAgICAgYE5ldyBtaWxlc3RvbmUgJHtuZXh0SWR9LmAsXG4gICAgICBiYXNlUGF0aFxuICAgICksIFwiZ3NkLXJ1blwiLCBjdHgsIFwiZGlzY3Vzcy1taWxlc3RvbmVcIik7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICAvLyBcImJhY2tcIiBvciBudWxsXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNob3dTbWFydEVudHJ5KFxuICBjdHg6IEV4dGVuc2lvbkNvbW1hbmRDb250ZXh0LFxuICBwaTogRXh0ZW5zaW9uQVBJLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBvcHRpb25zPzogeyBzdGVwPzogYm9vbGVhbiB9LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHN0ZXBNb2RlID0gb3B0aW9ucz8uc3RlcDtcblxuICAvLyBcdTI1MDBcdTI1MDAgQ2xlYXIgc3RhbGUgbWlsZXN0b25lIElEIHJlc2VydmF0aW9ucyBmcm9tIHByZXZpb3VzIGNhbmNlbGxlZCBzZXNzaW9ucyBcdTI1MDBcdTI1MDBcbiAgLy8gUmVzZXJ2YXRpb25zIG9ubHkgbmVlZCB0byBzdXJ2aXZlIHdpdGhpbiBhIHNpbmdsZSAvZ3NkIGludGVyYWN0aW9uLlxuICAvLyBXaXRob3V0IHRoaXMsIGVhY2ggY2FuY2VsbGVkIHNlc3Npb24gcGVybWFuZW50bHkgYnVtcHMgdGhlIG5leHQgSUQuICgjMjQ4OClcbiAgY2xlYXJSZXNlcnZlZE1pbGVzdG9uZUlkcygpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBEaXJlY3Rvcnkgc2FmZXR5IGNoZWNrIFx1MjAxNCByZWZ1c2UgdG8gb3BlcmF0ZSBpbiBzeXN0ZW0vaG9tZSBkaXJzIFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBkaXJDaGVjayA9IHZhbGlkYXRlRGlyZWN0b3J5KGJhc2VQYXRoKTtcbiAgaWYgKGRpckNoZWNrLnNldmVyaXR5ID09PSBcImJsb2NrZWRcIikge1xuICAgIGN0eC51aS5ub3RpZnkoZGlyQ2hlY2sucmVhc29uISwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGRpckNoZWNrLnNldmVyaXR5ID09PSBcIndhcm5pbmdcIikge1xuICAgIGNvbnN0IHByb2NlZWQgPSBhd2FpdCBzaG93Q29uZmlybShjdHgsIHtcbiAgICAgIHRpdGxlOiBcIkdTRCBcdTIwMTQgVW51c3VhbCBEaXJlY3RvcnlcIixcbiAgICAgIG1lc3NhZ2U6IGRpckNoZWNrLnJlYXNvbiEsXG4gICAgICBjb25maXJtTGFiZWw6IFwiQ29udGludWUgYW55d2F5XCIsXG4gICAgICBkZWNsaW5lTGFiZWw6IFwiQ2FuY2VsXCIsXG4gICAgfSk7XG4gICAgaWYgKCFwcm9jZWVkKSByZXR1cm47XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgRGV0ZWN0aW9uIHByZWFtYmxlIFx1MjAxNCBydW4gYmVmb3JlIGFueSBib290c3RyYXAgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIENoZWNrIGJvb3RzdHJhcCBjb21wbGV0ZW5lc3MsIG5vdCBqdXN0IC5nc2QvIGRpcmVjdG9yeSBleGlzdGVuY2UuXG4gIC8vIEEgem9tYmllIC5nc2QvIHN0YXRlIChzeW1saW5rIGV4aXN0cyBidXQgbWlzc2luZyBQUkVGRVJFTkNFUy5tZCBhbmRcbiAgLy8gbWlsZXN0b25lcy8pIG11c3QgdHJpZ2dlciB0aGUgaW5pdCB3aXphcmQsIG5vdCBza2lwIGl0ICgjMjk0MikuXG4gIGNvbnN0IGdzZFBhdGggPSBnc2RSb290KGJhc2VQYXRoKTtcbiAgY29uc3QgaGFzQm9vdHN0cmFwQXJ0aWZhY3RzID0gaGFzR3NkQm9vdHN0cmFwQXJ0aWZhY3RzKGdzZFBhdGgpO1xuICBsZXQgc2tpcEdpdEJvb3RzdHJhcCA9IGZhbHNlO1xuXG4gIGlmICghaGFzQm9vdHN0cmFwQXJ0aWZhY3RzKSB7XG4gICAgY29uc3QgZGV0ZWN0aW9uID0gZGV0ZWN0UHJvamVjdFN0YXRlKGJhc2VQYXRoKTtcblxuICAgIC8vIHYxIC5wbGFubmluZy8gZGV0ZWN0ZWQgXHUyMDE0IG9mZmVyIG1pZ3JhdGlvbiBiZWZvcmUgYW55dGhpbmcgZWxzZVxuICAgIGlmIChkZXRlY3Rpb24uc3RhdGUgPT09IFwidjEtcGxhbm5pbmdcIiAmJiBkZXRlY3Rpb24udjEpIHtcbiAgICAgIGNvbnN0IG1pZ3JhdGlvbkNob2ljZSA9IGF3YWl0IG9mZmVyTWlncmF0aW9uKGN0eCwgZGV0ZWN0aW9uLnYxKTtcbiAgICAgIGlmIChtaWdyYXRpb25DaG9pY2UgPT09IFwiY2FuY2VsXCIpIHJldHVybjtcbiAgICAgIGlmIChtaWdyYXRpb25DaG9pY2UgPT09IFwibWlncmF0ZVwiKSB7XG4gICAgICAgIGNvbnN0IHsgaGFuZGxlTWlncmF0ZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9taWdyYXRlL2NvbW1hbmQuanNcIik7XG4gICAgICAgIGF3YWl0IGhhbmRsZU1pZ3JhdGUoXCJcIiwgY3R4LCBwaSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIC8vIFwiZnJlc2hcIiBcdTIwMTQgZmFsbCB0aHJvdWdoIHRvIGluaXQgd2l6YXJkXG4gICAgfVxuXG4gICAgLy8gTm8gLmdzZC8gb3Igem9tYmllIC5nc2QvIFx1MjAxNCBydW4gdGhlIHByb2plY3QgaW5pdCB3aXphcmRcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzaG93UHJvamVjdEluaXQoY3R4LCBwaSwgYmFzZVBhdGgsIGRldGVjdGlvbik7XG4gICAgaWYgKCFyZXN1bHQuY29tcGxldGVkKSByZXR1cm47IC8vIFVzZXIgY2FuY2VsbGVkXG4gICAgc2tpcEdpdEJvb3RzdHJhcCA9IHNob3VsZFNraXBHaXRCb290c3RyYXBBZnRlckluaXQocmVzdWx0KTtcblxuICAgIC8vIEluaXQgd2l6YXJkIGJvb3RzdHJhcHBlZCAuZ3NkLyBcdTIwMTQgZmFsbCB0aHJvdWdoIHRvIHRoZSBub3JtYWwgZmxvdyBiZWxvd1xuICAgIC8vIHdoaWNoIHdpbGwgZGV0ZWN0IFwibm8gbWlsZXN0b25lc1wiIGFuZCBzdGFydCB0aGUgZGlzY3VzcyBwcm9tcHRcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBFbnN1cmUgZ2l0IHJlcG8gZXhpc3RzIFx1MjAxNCBHU0QgbmVlZHMgaXQgZm9yIHdvcmt0cmVlIGlzb2xhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gQWxzbyBoYW5kbGUgaW5oZXJpdGVkIHJlcG9zOiBpZiBiYXNlUGF0aCBpcyBhIHN1YmRpcmVjdG9yeSBvZiBhbm90aGVyXG4gIC8vIGdpdCByZXBvIHRoYXQgaGFzIG5vIC5nc2QsIGNyZWF0ZSBhIGZyZXNoIHJlcG8gdG8gcHJldmVudCBjcm9zcy1wcm9qZWN0XG4gIC8vIHN0YXRlIGxlYWtzICgjMTYzOSkuXG4gIGlmICghc2tpcEdpdEJvb3RzdHJhcCAmJiAoIW5hdGl2ZUlzUmVwbyhiYXNlUGF0aCkgfHwgaXNJbmhlcml0ZWRSZXBvKGJhc2VQYXRoKSkpIHtcbiAgICBjb25zdCBtYWluQnJhbmNoID0gbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy5naXQ/Lm1haW5fYnJhbmNoIHx8IFwibWFpblwiO1xuICAgIG5hdGl2ZUluaXQoYmFzZVBhdGgsIG1haW5CcmFuY2gpO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEVuc3VyZSAuZ2l0aWdub3JlIGhhcyBiYXNlbGluZSBwYXR0ZXJucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKCFza2lwR2l0Qm9vdHN0cmFwICYmIG5hdGl2ZUlzUmVwbyhiYXNlUGF0aCkpIHtcbiAgICBlbnN1cmVHaXRpZ25vcmUoYmFzZVBhdGgpO1xuICAgIHVudHJhY2tSdW50aW1lRmlsZXMoYmFzZVBhdGgpO1xuICB9XG5cbiAgLy8gRGVlcCBzZXR1cCBjYW4gcHJlLWNyZWF0ZSAuZ3NkL1BSRUZFUkVOQ0VTLm1kIGJlZm9yZSB0aGUgbm9ybWFsIGluaXRcbiAgLy8gd2l6YXJkIHBhdGggcnVucy4gSWYgdGhhdCBwYXRoIGFsc28gaW5pdGlhbGl6ZWQgZ2l0LCBtYWtlIEhFQUQgcmVhY2hhYmxlXG4gIC8vIG5vdyBzbyBsYXRlciB3b3JrdHJlZS9naXQtbG9nIG9wZXJhdGlvbnMgZG8gbm90IHJ1biBvbiBhbiB1bmJvcm4gYnJhbmNoLlxuICBpZiAoIXNraXBHaXRCb290c3RyYXAgJiYgbmF0aXZlSXNSZXBvKGJhc2VQYXRoKSAmJiAhbmF0aXZlSGFzQ29tbWl0dGVkSGVhZChiYXNlUGF0aCkpIHtcbiAgICB0cnkge1xuICAgICAgbmF0aXZlQWRkQWxsKGJhc2VQYXRoKTtcbiAgICAgIG5hdGl2ZUNvbW1pdChiYXNlUGF0aCwgXCJjaG9yZTogaW5pdCBwcm9qZWN0XCIpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgIGxvZ1dhcm5pbmcoXCJndWlkZWRcIiwgYGluaXRpYWwgZ2l0IGNvbW1pdCBmYWlsZWQ7IHdvcmt0cmVlIGlzb2xhdGlvbiB3aWxsIHJlbWFpbiBkaXNhYmxlZCB1bnRpbCBIRUFEIGV4aXN0czogJHttZXNzYWdlfWApO1xuICAgIH1cbiAgfVxuXG4gIHtcbiAgICBjb25zdCB7IGVuc3VyZURiT3BlbiB9ID0gYXdhaXQgaW1wb3J0KFwiLi9ib290c3RyYXAvZHluYW1pYy10b29scy5qc1wiKTtcbiAgICBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFNlbGYtaGVhbCBzdGFsZSBydW50aW1lIHJlY29yZHMgZnJvbSBjcmFzaGVkIGF1dG8tbW9kZSBzZXNzaW9ucyBcdTI1MDBcdTI1MDBcbiAgc2VsZkhlYWxSdW50aW1lUmVjb3JkcyhiYXNlUGF0aCwgY3R4KTtcblxuICBjb25zdCBpbnRlcnJ1cHRlZCA9IGF3YWl0IGFzc2Vzc0ludGVycnVwdGVkU2Vzc2lvbihiYXNlUGF0aCk7XG4gIGlmIChpbnRlcnJ1cHRlZC5jbGFzc2lmaWNhdGlvbiA9PT0gXCJydW5uaW5nXCIpIHtcbiAgICBjdHgudWkubm90aWZ5KGZvcm1hdEludGVycnVwdGVkU2Vzc2lvblJ1bm5pbmdNZXNzYWdlKGludGVycnVwdGVkKSwgXCJlcnJvclwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoaW50ZXJydXB0ZWQuY2xhc3NpZmljYXRpb24gPT09IFwic3RhbGVcIikge1xuICAgIGNsZWFyTG9jayhiYXNlUGF0aCk7XG4gICAgaWYgKGludGVycnVwdGVkLnBhdXNlZFNlc3Npb24pIHtcbiAgICAgIC8vIFBoYXNlIEMgcHQgMjogcGF1c2VkLXNlc3Npb24uanNvbiBtaWdyYXRlZCB0byBydW50aW1lX2t2XG4gICAgICAvLyAoZ2xvYmFsIHNjb3BlLCBrZXkgUEFVU0VEX1NFU1NJT05fS1ZfS0VZKS5cbiAgICAgIHRyeSB7XG4gICAgICAgIGRlbGV0ZVJ1bnRpbWVLdihcImdsb2JhbFwiLCBcIlwiLCBQQVVTRURfU0VTU0lPTl9LVl9LRVkpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dXYXJuaW5nKFwiZ3VpZGVkXCIsIGBzdGFsZSBwYXVzZWQtc2Vzc2lvbiBEQiBjbGVhbnVwIGZhaWxlZDogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gLCB7IGZpbGU6IFwiZ3VpZGVkLWZsb3cudHNcIiB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH0gZWxzZSBpZiAoaW50ZXJydXB0ZWQuY2xhc3NpZmljYXRpb24gPT09IFwicmVjb3ZlcmFibGVcIikge1xuICAgIGlmIChpbnRlcnJ1cHRlZC5sb2NrKSBjbGVhckxvY2soYmFzZVBhdGgpO1xuICAgIGNvbnN0IHJlc3VtZUxhYmVsID0gaW50ZXJydXB0ZWQucGF1c2VkU2Vzc2lvbj8uc3RlcE1vZGVcbiAgICAgID8gXCJSZXN1bWUgd2l0aCAvZ3NkIG5leHRcIlxuICAgICAgOiBcIlJlc3VtZSB3aXRoIC9nc2QgYXV0b1wiO1xuICAgIGNvbnN0IHJlc3VtZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgICAgdGl0bGU6IFwiR1NEIFx1MjAxNCBJbnRlcnJ1cHRlZCBTZXNzaW9uIERldGVjdGVkXCIsXG4gICAgICBzdW1tYXJ5OiBmb3JtYXRJbnRlcnJ1cHRlZFNlc3Npb25TdW1tYXJ5KGludGVycnVwdGVkKSxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgeyBpZDogXCJyZXN1bWVcIiwgbGFiZWw6IHJlc3VtZUxhYmVsLCBkZXNjcmlwdGlvbjogXCJQaWNrIHVwIHdoZXJlIGl0IGxlZnQgb2ZmXCIsIHJlY29tbWVuZGVkOiB0cnVlIH0sXG4gICAgICAgIHsgaWQ6IFwiY29udGludWVcIiwgbGFiZWw6IFwiQ29udGludWUgbWFudWFsbHlcIiwgZGVzY3JpcHRpb246IFwiT3BlbiB0aGUgd2l6YXJkIGFzIG5vcm1hbFwiIH0sXG4gICAgICBdLFxuICAgIH0pO1xuICAgIGlmIChyZXN1bWUgPT09IFwicmVzdW1lXCIpIHtcbiAgICAgIHN0YXJ0QXV0b0RldGFjaGVkKGN0eCwgcGksIGJhc2VQYXRoLCBmYWxzZSwge1xuICAgICAgICBpbnRlcnJ1cHRlZCxcbiAgICAgICAgc3RlcDogaW50ZXJydXB0ZWQucGF1c2VkU2Vzc2lvbj8uc3RlcE1vZGUgPz8gZmFsc2UsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBpZiAoaW50ZXJydXB0ZWQuY2xhc3NpZmljYXRpb24gIT09IFwicmVjb3ZlcmFibGVcIikge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IGF1dG9JbXBvcnRNYXJrZG93bkhpZXJhcmNoeUlmRGJNaXNtYXRjaCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9taWdyYXRpb24tYXV0by1jaGVjay5qc1wiKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGF1dG9JbXBvcnRNYXJrZG93bkhpZXJhcmNoeUlmRGJNaXNtYXRjaChiYXNlUGF0aCk7XG4gICAgICBpZiAocmVzdWx0LmFjdGlvbiA9PT0gXCJpbXBvcnRlZFwiKSB7XG4gICAgICAgIGN0eC51aS5ub3RpZnkoXG4gICAgICAgICAgYFJlY292ZXJlZCBtaWdyYXRlZCBwbGFubmluZyBzdGF0ZSBpbnRvIGdzZC5kYiAoJHtyZXN1bHQucmVhc29ufSk6ICR7cmVzdWx0LmFmdGVyRGIubWlsZXN0b25lc30gbWlsZXN0b25lKHMpLCAke3Jlc3VsdC5hZnRlckRiLnNsaWNlc30gc2xpY2UocyksICR7cmVzdWx0LmFmdGVyRGIudGFza3N9IHRhc2socykuYCxcbiAgICAgICAgICBcImluZm9cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgICBjdHgudWkubm90aWZ5KGBHU0QgY291bGQgbm90IGF1dG8taW1wb3J0IGV4aXN0aW5nIHBsYW5uaW5nIHN0YXRlIGludG8gZ3NkLmRiOiAke21lc3NhZ2V9YCwgXCJ3YXJuaW5nXCIpO1xuICAgICAgbG9nV2FybmluZyhcImd1aWRlZFwiLCBgcGxhbm5pbmcgc3RhdGUgYXV0by1pbXBvcnQgZmFpbGVkOiAke21lc3NhZ2V9YCwgeyBmaWxlOiBcImd1aWRlZC1mbG93LnRzXCIgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gQWx3YXlzIGRlcml2ZSBmcm9tIHRoZSBwcm9qZWN0IHJvb3QgXHUyMDE0IHRoZSBhc3Nlc3NtZW50IG1heSBoYXZlIGRlcml2ZWRcbiAgLy8gc3RhdGUgZnJvbSBhIHdvcmt0cmVlIHBhdGggdGhhdCB3YXMgY2xlYW5lZCB1cCBpbiB0aGUgc3RhbGUgYnJhbmNoIGFib3ZlLlxuICBjb25zdCBzdGF0ZSA9IGF3YWl0IGRlcml2ZVN0YXRlKGJhc2VQYXRoKTtcblxuICAvLyBSZWJ1aWxkIFNUQVRFLm1kIGZyb20gZGVyaXZlZCBzdGF0ZSBiZWZvcmUgYW55IGRpc3BhdGNoICgjMzQ3NSkuXG4gIHRyeSB7XG4gICAgY29uc3QgeyBidWlsZFN0YXRlTWFya2Rvd24gfSA9IGF3YWl0IGltcG9ydChcIi4vZG9jdG9yLmpzXCIpO1xuICAgIGF3YWl0IHNhdmVGaWxlKHJlc29sdmVHc2RSb290RmlsZShiYXNlUGF0aCwgXCJTVEFURVwiKSwgYnVpbGRTdGF0ZU1hcmtkb3duKHN0YXRlKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ1dhcm5pbmcoXCJndWlkZWRcIiwgYFNUQVRFLm1kIHJlYnVpbGQgZmFpbGVkOiAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgRGVlcCBwbGFubmluZyBtb2RlIGtpY2tvZmYgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIC8vIFdoZW4gYHBsYW5uaW5nX2RlcHRoOiBkZWVwYCBpcyBzZXQgKGUuZy4gdmlhIGAvZ3NkIG5ldy1wcm9qZWN0IC0tZGVlcGApXG4gIC8vIGFuZCBhbnkgcHJvamVjdC1sZXZlbCBzdGFnZSBnYXRlIGlzIHN0aWxsIHBlbmRpbmcsIGtlZXAgdGhlIHVzZXItcXVlc3Rpb25cbiAgLy8gc3RhZ2VzIGluIHRoZSBmb3JlZ3JvdW5kIGNvbnZlcnNhdGlvbi4gQXV0by1tb2RlIGlzIHJlc3VtZWQgb25seSBhZnRlclxuICAvLyB0aGUgcHJvamVjdCBpbnRlcnZpZXcgYXJ0aWZhY3RzIGV4aXN0LCBzbyBxdWVzdGlvbnMgZG8gbm90IGxvb2sgbGlrZVxuICAvLyBjYW5jZWxsZWQgYXV0by1tb2RlIHJ1bnMuXG4gIC8vIExpZ2h0IG1vZGUgYW5kIGZ1bGx5LWNvbXBsZXRlZCBkZWVwIHByb2plY3RzIGZhbGwgdGhyb3VnaCB0byB0aGVcbiAgLy8gc3RhbmRhcmQgd2l6YXJkIGJlbG93LlxuICB7XG4gICAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoYmFzZVBhdGgpPy5wcmVmZXJlbmNlcztcbiAgICBjb25zdCB7IHNob3VsZFJ1bkRlZXBQcm9qZWN0U2V0dXAgfSA9IGF3YWl0IGltcG9ydChcIi4vYXV0by1kaXNwYXRjaC5qc1wiKTtcbiAgICBpZiAoc2hvdWxkUnVuRGVlcFByb2plY3RTZXR1cChzdGF0ZSwgcHJlZnMsIGJhc2VQYXRoKSkge1xuICAgICAgYXdhaXQgc3RhcnREZWVwUHJvamVjdFNldHVwRm9yZWdyb3VuZChjdHgsIHBpLCBiYXNlUGF0aCwgc3RlcE1vZGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHBsYW5WMkdhdGVEZWNpc2lvbiA9IHJ1blBsYW5WMkdhdGUoY3R4LCBiYXNlUGF0aCwgc3RhdGUpO1xuICBpZiAocGxhblYyR2F0ZURlY2lzaW9uID09PSBcImJsb2NrXCIpIHJldHVybjtcblxuICBpZiAoIXN0YXRlLmFjdGl2ZU1pbGVzdG9uZT8uaWQpIHtcbiAgICAvLyBHdWFyZDogaWYgYSBkaXNjdXNzIHNlc3Npb24gaXMgYWxyZWFkeSBpbiBmbGlnaHQsIGRvbid0IHJlLWluamVjdCB0aGUgcHJvbXB0LlxuICAgIC8vIEJvdGggL2dzZCBhbmQgL2dzZCBhdXRvIHJlYWNoIHRoaXMgYnJhbmNoIHdoZW4gbm8gbWlsZXN0b25lIGV4aXN0cyB5ZXQuXG4gICAgLy8gV2l0aG91dCB0aGlzIGd1YXJkLCBldmVyeSBzdWJzZXF1ZW50IC9nc2QgY2FsbCBvdmVyd3JpdGVzIHRoZSBwZW5kaW5nIGF1dG8tc3RhcnRcbiAgICAvLyBhbmQgZmlyZXMgYW5vdGhlciBkaXNwYXRjaFdvcmtmbG93LCByZXNldHRpbmcgdGhlIGNvbnZlcnNhdGlvbiBtaWQtaW50ZXJ2aWV3LlxuICAgIGlmIChwZW5kaW5nQXV0b1N0YXJ0TWFwLmhhcyhiYXNlUGF0aCkpIHtcbiAgICAgIC8vICMzMjc0OiBJZiAvY2xlYXIgaW50ZXJydXB0ZWQgdGhlIGRpc2N1c3Npb24sIHRoZSBwZW5kaW5nIGVudHJ5IGlzIHN0YWxlLlxuICAgICAgLy8gRGV0ZWN0IHN0YWxlbmVzczogbm8gbWFuaWZlc3QsIG5vIG1pbGVzdG9uZSBDT05URVhUIGFydGlmYWN0LCBBTkQgZW50cnkgaXMgb2xkZXIgdGhhblxuICAgICAgLy8gMzBzIChhdm9pZHMgcmFjZSBiZXR3ZWVuIC5zZXQoKSBhbmQgTExNIHdyaXRpbmcgZmlyc3QgYXJ0aWZhY3QpLlxuICAgICAgY29uc3QgZW50cnkgPSBwZW5kaW5nQXV0b1N0YXJ0TWFwLmdldChiYXNlUGF0aCkhO1xuICAgICAgY29uc3QgYWdlTXMgPSBEYXRlLm5vdygpIC0gKGVudHJ5LmNyZWF0ZWRBdCB8fCAwKTtcbiAgICAgIGNvbnN0IG1hbmlmZXN0RXhpc3RzID0gZXhpc3RzU3luYyhqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIkRJU0NVU1NJT04tTUFOSUZFU1QuanNvblwiKSk7XG4gICAgICBjb25zdCBtaWxlc3RvbmVIYXNDb250ZXh0ID0gISFyZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgZW50cnkubWlsZXN0b25lSWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgIGlmICghbWFuaWZlc3RFeGlzdHMgJiYgIW1pbGVzdG9uZUhhc0NvbnRleHQgJiYgYWdlTXMgPiAzMF8wMDApIHtcbiAgICAgICAgLy8gU3RhbGUgZW50cnkgZnJvbSBhbiBpbnRlcnJ1cHRlZCBkaXNjdXNzaW9uIFx1MjAxNCBjbGVhciBhbmQgY29udGludWVcbiAgICAgICAgcGVuZGluZ0F1dG9TdGFydE1hcC5kZWxldGUoYmFzZVBhdGgpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY3R4LnVpLm5vdGlmeShcIkRpc2N1c3Npb24gYWxyZWFkeSBpbiBwcm9ncmVzcyBcdTIwMTQgYW5zd2VyIHRoZSBxdWVzdGlvbiBhYm92ZSB0byBjb250aW51ZS5cIiwgXCJpbmZvXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgbWlsZXN0b25lSWRzID0gZmluZE1pbGVzdG9uZUlkcyhiYXNlUGF0aCk7XG5cbiAgICAvLyBTYW5pdHkgY2hlY2sgKCM0NTYpOiBpZiBmaW5kTWlsZXN0b25lSWRzIHJldHVybnMgW10gYnV0IHRoZSBtaWxlc3RvbmVzXG4gICAgLy8gZGlyZWN0b3J5IGhhcyBjb250ZW50cywgc29tZXRoaW5nIHdlbnQgd3JvbmcgKHBlcm1pc3Npb25zLCBzdGFsZSB3b3JrdHJlZVxuICAgIC8vIGN3ZCwgZXRjKS4gV2FybiBpbnN0ZWFkIG9mIHNpbGVudGx5IHN0YXJ0aW5nIGEgbmV3LXByb2plY3QgZmxvdy5cbiAgICBpZiAobWlsZXN0b25lSWRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29uc3QgbURpciA9IG1pbGVzdG9uZXNEaXIoYmFzZVBhdGgpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMobURpcikpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBlbnRyaWVzID0gY2xlYXJFbXB0eUxlZ2FjeURlZXBTZXR1cFBzZXVkb01pbGVzdG9uZXMoYmFzZVBhdGgsIHJlYWRkaXJTeW5jKG1EaXIpKTtcbiAgICAgICAgICBpZiAoZW50cmllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjdHgudWkubm90aWZ5KFxuICAgICAgICAgICAgICBgTWlsZXN0b25lIGRpcmVjdG9yeSBoYXMgJHtlbnRyaWVzLmxlbmd0aH0gZW50cmllcyBidXQgbm9uZSB3ZXJlIHJlY29nbml6ZWQgYXMgbWlsZXN0b25lcy4gYCArXG4gICAgICAgICAgICAgIGBUaGlzIG1heSBpbmRpY2F0ZSBhIGNvcnJ1cHRlZCBzdGF0ZSBvciB3cm9uZyB3b3JraW5nIGRpcmVjdG9yeS4gUnVuIFxcYC9nc2QgZG9jdG9yXFxgIHRvIGRpYWdub3NlLmAsXG4gICAgICAgICAgICAgIFwid2FybmluZ1wiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGUpIHsgbG9nV2FybmluZyhcImd1aWRlZFwiLCBgZGlyZWN0b3J5IHJlYWQgZmFpbGVkOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWApOyB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgdW5pcXVlTWlsZXN0b25lSWRzID0gISFsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoKT8ucHJlZmVyZW5jZXM/LnVuaXF1ZV9taWxlc3RvbmVfaWRzO1xuICAgIGNvbnN0IG5leHRJZCA9IG5leHRNaWxlc3RvbmVJZFJlc2VydmVkKG1pbGVzdG9uZUlkcywgdW5pcXVlTWlsZXN0b25lSWRzLCBiYXNlUGF0aCk7XG4gICAgY29uc3QgaXNGaXJzdCA9IG1pbGVzdG9uZUlkcy5sZW5ndGggPT09IDA7XG5cbiAgICBpZiAoaXNGaXJzdCkge1xuICAgICAgLy8gRmlyc3QgZXZlciBcdTIwMTQgc2tpcCB3aXphcmQsIGp1c3QgYXNrIGRpcmVjdGx5XG4gICAgICBjdHgudWkuc2V0U3RhdHVzKFwiZ3NkLXN0ZXBcIiwgXCJOZXcgTWlsZXN0b25lIFx1MDBCNyBhbnN3ZXIgdGhlIHF1ZXN0aW9ucyBhYm92ZSB0byBwbGFuXCIpO1xuICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlUGF0aCwgeyBjdHgsIHBpLCBiYXNlUGF0aCwgbWlsZXN0b25lSWQ6IG5leHRJZCwgc3RlcDogc3RlcE1vZGUgfSk7XG4gICAgICBhd2FpdCBkaXNwYXRjaFdvcmtmbG93KHBpLCBhd2FpdCBwcmVwYXJlQW5kQnVpbGREaXNjdXNzUHJvbXB0KGN0eCwgcGksIG5leHRJZCxcbiAgICAgICAgYE5ldyBwcm9qZWN0LCBtaWxlc3RvbmUgJHtuZXh0SWR9LiBEbyBOT1QgcmVhZCBvciBleHBsb3JlIC5nc2QvIFx1MjAxNCBpdCdzIGVtcHR5IHNjYWZmb2xkaW5nLmAsXG4gICAgICAgIGJhc2VQYXRoXG4gICAgICApLCBcImdzZC1ydW5cIiwgY3R4LCBcImRpc2N1c3MtbWlsZXN0b25lXCIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBjaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICAgICAgdGl0bGU6IFwiR1NEIFx1MjAxNCBHZXQgU2hpdCBEb25lXCIsXG4gICAgICAgIHN1bW1hcnk6IFtcIk5vIGFjdGl2ZSBtaWxlc3RvbmUuXCJdLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgaWQ6IFwicXVpY2tfdGFza1wiLFxuICAgICAgICAgICAgbGFiZWw6IFwiUXVpY2sgdGFza1wiLFxuICAgICAgICAgICAgZGVzY3JpcHRpb246IFwiRm9yIHNtYWxsIGJvdW5kZWQgd29yaywgcnVuIC9nc2QgcXVpY2sgPHRhc2s+IG9yIC9nc2QgZG8gPHRhc2s+LlwiLFxuICAgICAgICAgICAgcmVjb21tZW5kZWQ6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBpZDogXCJuZXdfbWlsZXN0b25lXCIsXG4gICAgICAgICAgICBsYWJlbDogXCJDcmVhdGUgbmV4dCBtaWxlc3RvbmVcIixcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkRlZmluZSBhIGxhcmdlciBib2R5IG9mIHdvcmsgd2l0aCBwbGFubmluZyBhcnRpZmFjdHMuXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgXSxcbiAgICAgICAgbm90WWV0TWVzc2FnZTogXCJSdW4gL2dzZCB3aGVuIHJlYWR5LlwiLFxuICAgICAgfSk7XG5cbiAgICAgIGlmIChjaG9pY2UgPT09IFwicXVpY2tfdGFza1wiKSB7XG4gICAgICAgIGF3YWl0IHJ1blF1aWNrVGFza0Nob2ljZShjdHgsIHBpKTtcbiAgICAgIH0gZWxzZSBpZiAoY2hvaWNlID09PSBcIm5ld19taWxlc3RvbmVcIikge1xuICAgICAgICBjdHgudWkuc2V0U3RhdHVzKFwiZ3NkLXN0ZXBcIiwgXCJOZXcgTWlsZXN0b25lIFx1MDBCNyBhbnN3ZXIgdGhlIHF1ZXN0aW9ucyBhYm92ZSB0byBwbGFuXCIpO1xuICAgICAgICBzZXRQZW5kaW5nQXV0b1N0YXJ0KGJhc2VQYXRoLCB7IGN0eCwgcGksIGJhc2VQYXRoLCBtaWxlc3RvbmVJZDogbmV4dElkLCBzdGVwOiBzdGVwTW9kZSB9KTtcbiAgICAgICAgYXdhaXQgZGlzcGF0Y2hXb3JrZmxvdyhwaSwgYXdhaXQgcHJlcGFyZUFuZEJ1aWxkRGlzY3Vzc1Byb21wdChjdHgsIHBpLCBuZXh0SWQsXG4gICAgICAgICAgYE5ldyBtaWxlc3RvbmUgJHtuZXh0SWR9LmAsXG4gICAgICAgICAgYmFzZVBhdGhcbiAgICAgICAgKSwgXCJnc2QtcnVuXCIsIGN0eCwgXCJkaXNjdXNzLW1pbGVzdG9uZVwiKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbWlsZXN0b25lSWQgPSBzdGF0ZS5hY3RpdmVNaWxlc3RvbmUuaWQ7XG4gIGNvbnN0IG1pbGVzdG9uZVRpdGxlID0gc3RhdGUuYWN0aXZlTWlsZXN0b25lLnRpdGxlO1xuXG4gIGlmIChwbGFuVjJHYXRlRGVjaXNpb24gPT09IFwicmVjb3Zlci1taXNzaW5nLWNvbnRleHRcIikge1xuICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZVBhdGgsIHsgY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzdGVwOiBzdGVwTW9kZSB9KTtcbiAgICBhd2FpdCBkaXNwYXRjaFdvcmtmbG93KFxuICAgICAgcGksXG4gICAgICBhd2FpdCBidWlsZERpc2N1c3NNaWxlc3RvbmVQcm9tcHQoXG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBtaWxlc3RvbmVUaXRsZSxcbiAgICAgICAgYmFzZVBhdGgsXG4gICAgICAgIGdldFN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFiaWxpdHkocGksIGN0eCksXG4gICAgICApLFxuICAgICAgXCJnc2QtZGlzY3Vzc1wiLFxuICAgICAgY3R4LFxuICAgICAgXCJkaXNjdXNzLW1pbGVzdG9uZVwiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEFsbCBtaWxlc3RvbmVzIGNvbXBsZXRlIFx1MjE5MiBOZXcgbWlsZXN0b25lIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAoc3RhdGUucGhhc2UgPT09IFwiY29tcGxldGVcIikge1xuICAgIGNvbnN0IGNob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgICAgdGl0bGU6IGBHU0QgXHUyMDE0ICR7bWlsZXN0b25lSWR9OiAke21pbGVzdG9uZVRpdGxlfWAsXG4gICAgICBzdW1tYXJ5OiBbXCJBbGwgbWlsZXN0b25lcyBjb21wbGV0ZS5cIl0sXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJxdWlja190YXNrXCIsXG4gICAgICAgICAgbGFiZWw6IFwiUXVpY2sgdGFza1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkRvIGEgc21hbGwgYm91bmRlZCB0YXNrIHdpdGhvdXQgb3BlbmluZyBhIG1pbGVzdG9uZS5cIixcbiAgICAgICAgICByZWNvbW1lbmRlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIm5ld19taWxlc3RvbmVcIixcbiAgICAgICAgICBsYWJlbDogXCJTdGFydCBuZXcgbWlsZXN0b25lXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiRGVmaW5lIGFuZCBwbGFuIHRoZSBuZXh0IG1pbGVzdG9uZS5cIixcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcInN0YXR1c1wiLFxuICAgICAgICAgIGxhYmVsOiBcIlZpZXcgc3RhdHVzXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiUmV2aWV3IHdoYXQgd2FzIGJ1aWx0LlwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2Qgd2hlbiByZWFkeS5cIixcbiAgICB9KTtcblxuICAgIGlmIChjaG9pY2UgPT09IFwicXVpY2tfdGFza1wiKSB7XG4gICAgICBhd2FpdCBydW5RdWlja1Rhc2tDaG9pY2UoY3R4LCBwaSk7XG4gICAgfSBlbHNlIGlmIChjaG9pY2UgPT09IFwibmV3X21pbGVzdG9uZVwiKSB7XG4gICAgICBjb25zdCBtaWxlc3RvbmVJZHMgPSBmaW5kTWlsZXN0b25lSWRzKGJhc2VQYXRoKTtcbiAgICAgIGNvbnN0IHVuaXF1ZU1pbGVzdG9uZUlkcyA9ICEhbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy51bmlxdWVfbWlsZXN0b25lX2lkcztcbiAgICAgIGNvbnN0IG5leHRJZCA9IG5leHRNaWxlc3RvbmVJZFJlc2VydmVkKG1pbGVzdG9uZUlkcywgdW5pcXVlTWlsZXN0b25lSWRzLCBiYXNlUGF0aCk7XG5cbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZVBhdGgsIHsgY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkOiBuZXh0SWQsIHN0ZXA6IHN0ZXBNb2RlIH0pO1xuICAgICAgYXdhaXQgZGlzcGF0Y2hXb3JrZmxvdyhwaSwgYXdhaXQgcHJlcGFyZUFuZEJ1aWxkRGlzY3Vzc1Byb21wdChjdHgsIHBpLCBuZXh0SWQsXG4gICAgICAgIGBOZXcgbWlsZXN0b25lICR7bmV4dElkfS5gLFxuICAgICAgICBiYXNlUGF0aFxuICAgICAgKSwgXCJnc2QtcnVuXCIsIGN0eCwgXCJkaXNjdXNzLW1pbGVzdG9uZVwiKTtcbiAgICB9IGVsc2UgaWYgKGNob2ljZSA9PT0gXCJzdGF0dXNcIikge1xuICAgICAgY29uc3QgeyBmaXJlU3RhdHVzVmlhQ29tbWFuZCB9ID0gYXdhaXQgaW1wb3J0KFwiLi9jb21tYW5kcy5qc1wiKTtcbiAgICAgIGF3YWl0IGZpcmVTdGF0dXNWaWFDb21tYW5kKGN0eCk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBEcmFmdCBtaWxlc3RvbmUgXHUyMDE0IG5lZWRzIGRpc2N1c3Npb24gYmVmb3JlIHBsYW5uaW5nIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBpZiAoc3RhdGUucGhhc2UgPT09IFwibmVlZHMtZGlzY3Vzc2lvblwiKSB7XG4gICAgY29uc3QgZHJhZnRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBcIkNPTlRFWFQtRFJBRlRcIik7XG4gICAgY29uc3QgZHJhZnRDb250ZW50ID0gZHJhZnRGaWxlID8gYXdhaXQgbG9hZEZpbGUoZHJhZnRGaWxlKSA6IG51bGw7XG5cbiAgICBjb25zdCBjaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICAgIHRpdGxlOiBgR1NEIFx1MjAxNCAke21pbGVzdG9uZUlkfTogJHttaWxlc3RvbmVUaXRsZX1gLFxuICAgICAgc3VtbWFyeTogW1wiVGhpcyBtaWxlc3RvbmUgaGFzIGEgZHJhZnQgY29udGV4dCBmcm9tIGEgcHJpb3IgZGlzY3Vzc2lvbi5cIiwgXCJJdCBuZWVkcyBhIGRlZGljYXRlZCBkaXNjdXNzaW9uIGJlZm9yZSBhdXRvLXBsYW5uaW5nIGNhbiBiZWdpbi5cIl0sXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJkaXNjdXNzX2RyYWZ0XCIsXG4gICAgICAgICAgbGFiZWw6IFwiRGlzY3VzcyBmcm9tIGRyYWZ0XCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiQ29udGludWUgd2hlcmUgdGhlIHByaW9yIGRpc2N1c3Npb24gbGVmdCBvZmYgXHUyMDE0IHNlZWQgbWF0ZXJpYWwgaXMgbG9hZGVkIGF1dG9tYXRpY2FsbHkuXCIsXG4gICAgICAgICAgcmVjb21tZW5kZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJkaXNjdXNzX2ZyZXNoXCIsXG4gICAgICAgICAgbGFiZWw6IFwiU3RhcnQgZnJlc2ggZGlzY3Vzc2lvblwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIkRpc2NhcmQgdGhlIGRyYWZ0IGFuZCBzdGFydCBhIG5ldyBkaXNjdXNzaW9uIGZyb20gc2NyYXRjaC5cIixcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcInNraXBfbWlsZXN0b25lXCIsXG4gICAgICAgICAgbGFiZWw6IFwiU2tpcCBcdTIwMTQgY3JlYXRlIG5ldyBtaWxlc3RvbmVcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJMZWF2ZSB0aGlzIG1pbGVzdG9uZSBhcy1pcyBhbmQgc3RhcnQgc29tZXRoaW5nIG5ldy5cIixcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBub3RZZXRNZXNzYWdlOiBcIlJ1biAvZ3NkIHdoZW4gcmVhZHkgdG8gZGlzY3VzcyB0aGlzIG1pbGVzdG9uZS5cIixcbiAgICB9KTtcblxuICAgIGlmIChjaG9pY2UgPT09IFwiZGlzY3Vzc19kcmFmdFwiKSB7XG4gICAgICBjb25zdCBkaXNjdXNzTWlsZXN0b25lVGVtcGxhdGVzID0gaW5saW5lVGVtcGxhdGUoXCJjb250ZXh0XCIsIFwiQ29udGV4dFwiKTtcbiAgICAgIGNvbnN0IHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUgPSBnZXRTdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmlsaXR5KHBpLCBjdHgpO1xuICAgICAgY29uc3QgYmFzZVByb21wdCA9IGxvYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1taWxlc3RvbmVcIiwge1xuICAgICAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlUGF0aCxcbiAgICAgICAgbWlsZXN0b25lSWQsIG1pbGVzdG9uZVRpdGxlLCBpbmxpbmVkVGVtcGxhdGVzOiBkaXNjdXNzTWlsZXN0b25lVGVtcGxhdGVzLCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlLFxuICAgICAgICBjb21taXRJbnN0cnVjdGlvbjogYnVpbGREb2NzQ29tbWl0SW5zdHJ1Y3Rpb24oYGRvY3MoJHttaWxlc3RvbmVJZH0pOiBtaWxlc3RvbmUgY29udGV4dCBmcm9tIGRpc2N1c3NgKSxcbiAgICAgICAgZmFzdFBhdGhJbnN0cnVjdGlvbjogXCJcIixcbiAgICAgIH0pO1xuICAgICAgY29uc3Qgc2VlZCA9IGRyYWZ0Q29udGVudFxuICAgICAgICA/IGAke2Jhc2VQcm9tcHR9XFxuXFxuIyMgUHJpb3IgRGlzY3Vzc2lvbiAoRHJhZnQgU2VlZClcXG5cXG4ke2RyYWZ0Q29udGVudH1gXG4gICAgICAgIDogYmFzZVByb21wdDtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZVBhdGgsIHsgY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzdGVwOiBzdGVwTW9kZSB9KTtcbiAgICAgIGF3YWl0IGRpc3BhdGNoV29ya2Zsb3cocGksIHNlZWQsIFwiZ3NkLWRpc2N1c3NcIiwgY3R4LCBcImRpc2N1c3MtbWlsZXN0b25lXCIpO1xuICAgIH0gZWxzZSBpZiAoY2hvaWNlID09PSBcImRpc2N1c3NfZnJlc2hcIikge1xuICAgICAgY29uc3QgZGlzY3Vzc01pbGVzdG9uZVRlbXBsYXRlcyA9IGlubGluZVRlbXBsYXRlKFwiY29udGV4dFwiLCBcIkNvbnRleHRcIik7XG4gICAgICBjb25zdCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlID0gZ2V0U3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJpbGl0eShwaSwgY3R4KTtcbiAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZVBhdGgsIHsgY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzdGVwOiBzdGVwTW9kZSB9KTtcbiAgICAgIGF3YWl0IGRpc3BhdGNoV29ya2Zsb3cocGksIGxvYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1taWxlc3RvbmVcIiwge1xuICAgICAgICB3b3JraW5nRGlyZWN0b3J5OiBiYXNlUGF0aCxcbiAgICAgICAgbWlsZXN0b25lSWQsIG1pbGVzdG9uZVRpdGxlLCBpbmxpbmVkVGVtcGxhdGVzOiBkaXNjdXNzTWlsZXN0b25lVGVtcGxhdGVzLCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlLFxuICAgICAgICBjb21taXRJbnN0cnVjdGlvbjogYnVpbGREb2NzQ29tbWl0SW5zdHJ1Y3Rpb24oYGRvY3MoJHttaWxlc3RvbmVJZH0pOiBtaWxlc3RvbmUgY29udGV4dCBmcm9tIGRpc2N1c3NgKSxcbiAgICAgICAgZmFzdFBhdGhJbnN0cnVjdGlvbjogXCJcIixcbiAgICAgIH0pLCBcImdzZC1kaXNjdXNzXCIsIGN0eCwgXCJkaXNjdXNzLW1pbGVzdG9uZVwiKTtcbiAgICB9IGVsc2UgaWYgKGNob2ljZSA9PT0gXCJza2lwX21pbGVzdG9uZVwiKSB7XG4gICAgICBjb25zdCBtaWxlc3RvbmVJZHMgPSBmaW5kTWlsZXN0b25lSWRzKGJhc2VQYXRoKTtcbiAgICAgIGNvbnN0IHVuaXF1ZU1pbGVzdG9uZUlkcyA9ICEhbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy51bmlxdWVfbWlsZXN0b25lX2lkcztcbiAgICAgIGNvbnN0IG5leHRJZCA9IG5leHRNaWxlc3RvbmVJZFJlc2VydmVkKG1pbGVzdG9uZUlkcywgdW5pcXVlTWlsZXN0b25lSWRzLCBiYXNlUGF0aCk7XG4gICAgICBzZXRQZW5kaW5nQXV0b1N0YXJ0KGJhc2VQYXRoLCB7IGN0eCwgcGksIGJhc2VQYXRoLCBtaWxlc3RvbmVJZDogbmV4dElkLCBzdGVwOiBzdGVwTW9kZSB9KTtcbiAgICAgIGF3YWl0IGRpc3BhdGNoV29ya2Zsb3cocGksIGF3YWl0IHByZXBhcmVBbmRCdWlsZERpc2N1c3NQcm9tcHQoY3R4LCBwaSwgbmV4dElkLFxuICAgICAgICBgTmV3IG1pbGVzdG9uZSAke25leHRJZH0uYCxcbiAgICAgICAgYmFzZVBhdGhcbiAgICAgICksIFwiZ3NkLXJ1blwiLCBjdHgsIFwiZGlzY3Vzcy1taWxlc3RvbmVcIik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBObyBhY3RpdmUgc2xpY2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmICghc3RhdGUuYWN0aXZlU2xpY2UpIHtcbiAgICBjb25zdCByb2FkbWFwRmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgXCJST0FETUFQXCIpO1xuICAgIGNvbnN0IGhhc1JvYWRtYXAgPSAhIShyb2FkbWFwRmlsZSAmJiBhd2FpdCBsb2FkRmlsZShyb2FkbWFwRmlsZSkpO1xuXG4gICAgLy8gQSByb2FkbWFwIGZpbGUgd2l0aCB6ZXJvIHBhcnNlYWJsZSBzbGljZXMgKHBsYWNlaG9sZGVyIHRleHQpIHNob3VsZCBiZVxuICAgIC8vIHRyZWF0ZWQgdGhlIHNhbWUgYXMgbm8gcm9hZG1hcCBcdTIwMTQgb2ZmZXIgXCJDcmVhdGUgcm9hZG1hcFwiIGluc3RlYWQgb2YgXCJHbyBhdXRvXCJcbiAgICAvLyB3aGljaCB3b3VsZCBpbW1lZGlhdGVseSBnZXQgc3R1Y2sgaW4gYmxvY2tlZCBzdGF0ZSAoIzM0NDEpLlxuICAgIGxldCByb2FkbWFwSGFzU2xpY2VzID0gZmFsc2U7XG4gICAgaWYgKGhhc1JvYWRtYXApIHtcbiAgICAgIGNvbnN0IHJvYWRtYXBDb250ZW50ID0gYXdhaXQgbG9hZEZpbGUocm9hZG1hcEZpbGUhKTtcbiAgICAgIGlmIChyb2FkbWFwQ29udGVudCkge1xuICAgICAgICByb2FkbWFwSGFzU2xpY2VzID0gX3JvYWRtYXBIYXNQYXJzZWFibGVTbGljZXNGb3JUZXN0KHJvYWRtYXBDb250ZW50KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIWhhc1JvYWRtYXAgfHwgIXJvYWRtYXBIYXNTbGljZXMpIHtcbiAgICAgIC8vIE5vIHJvYWRtYXAgXHUyMTkyIGRpc2N1c3Mgb3IgcGxhblxuICAgICAgY29uc3QgY29udGV4dEZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlsZXN0b25lSWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgIGNvbnN0IGhhc0NvbnRleHQgPSAhIShjb250ZXh0RmlsZSAmJiBhd2FpdCBsb2FkRmlsZShjb250ZXh0RmlsZSkpO1xuXG4gICAgICBjb25zdCBhY3Rpb25zID0gW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwicXVpY2tfdGFza1wiLFxuICAgICAgICAgIGxhYmVsOiBcIlF1aWNrIHRhc2sgaW5zdGVhZFwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlVzZSB0aGlzIHdoZW4gdGhlIHdvcmsgaXMgc21hbGwgYW5kIHNob3VsZCBub3QgYmVjb21lIGEgbWlsZXN0b25lLlwiLFxuICAgICAgICAgIHJlY29tbWVuZGVkOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwicGxhblwiLFxuICAgICAgICAgIGxhYmVsOiBcIkNyZWF0ZSByb2FkbWFwXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IGhhc0NvbnRleHRcbiAgICAgICAgICAgID8gXCJDb250ZXh0IGNhcHR1cmVkLiBEZWNvbXBvc2UgaW50byBzbGljZXMgd2l0aCBhIGJvdW5kYXJ5IG1hcC5cIlxuICAgICAgICAgICAgOiBcIkRlY29tcG9zZSB0aGUgbWlsZXN0b25lIGludG8gc2xpY2VzIHdpdGggYSBib3VuZGFyeSBtYXAuXCIsXG4gICAgICAgIH0sXG4gICAgICAgIC4uLighaGFzQ29udGV4dCA/IFt7XG4gICAgICAgICAgaWQ6IFwiZGlzY3Vzc1wiLFxuICAgICAgICAgIGxhYmVsOiBcIkRpc2N1c3MgZmlyc3RcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJDYXB0dXJlIGRlY2lzaW9ucyBvbiBncmF5IGFyZWFzIGJlZm9yZSBwbGFubmluZy5cIixcbiAgICAgICAgfV0gOiBbXSksXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJza2lwX21pbGVzdG9uZVwiLFxuICAgICAgICAgIGxhYmVsOiBcIlNraXAgXHUyMDE0IGNyZWF0ZSBuZXcgbWlsZXN0b25lXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiTGVhdmUgdGhpcyBtaWxlc3RvbmUgb24gZGlzayBhbmQgc3RhcnQgYSBmcmVzaCBvbmUuXCIsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJkaXNjYXJkX21pbGVzdG9uZVwiLFxuICAgICAgICAgIGxhYmVsOiBcIkRpc2NhcmQgdGhpcyBtaWxlc3RvbmVcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJEZWxldGUgdGhlIG1pbGVzdG9uZSBkaXJlY3RvcnkgYW5kIHN0YXJ0IG92ZXIuXCIsXG4gICAgICAgIH0sXG4gICAgICBdO1xuXG4gICAgICBjb25zdCBjaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICAgICAgdGl0bGU6IGBHU0QgXHUyMDE0ICR7bWlsZXN0b25lSWR9OiAke21pbGVzdG9uZVRpdGxlfWAsXG4gICAgICAgIHN1bW1hcnk6IFtoYXNDb250ZXh0ID8gXCJDb250ZXh0IGNhcHR1cmVkLiBSZWFkeSB0byBjcmVhdGUgcm9hZG1hcC5cIiA6IFwiTmV3IG1pbGVzdG9uZSBcdTIwMTQgbm8gcm9hZG1hcCB5ZXQuXCJdLFxuICAgICAgICBhY3Rpb25zLFxuICAgICAgICBub3RZZXRNZXNzYWdlOiBcIlJ1biAvZ3NkIHdoZW4gcmVhZHkuXCIsXG4gICAgICB9KTtcblxuICAgICAgaWYgKGNob2ljZSA9PT0gXCJxdWlja190YXNrXCIpIHtcbiAgICAgICAgYXdhaXQgcnVuUXVpY2tUYXNrQ2hvaWNlKGN0eCwgcGkpO1xuICAgICAgfSBlbHNlIGlmIChjaG9pY2UgPT09IFwicGxhblwiKSB7XG4gICAgICAgIGN0eC51aS5zZXRTdGF0dXMoXCJnc2Qtc3RlcFwiLCBcIlBsYW5uaW5nIE1pbGVzdG9uZSBcdTAwQjcgZGVjb21wb3NpbmcgaW50byBzbGljZXNcIik7XG4gICAgICAgIHNldFBlbmRpbmdBdXRvU3RhcnQoYmFzZVBhdGgsIHsgY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzdGVwOiBzdGVwTW9kZSB9KTtcbiAgICAgICAgYXdhaXQgZGlzcGF0Y2hXb3JrZmxvdyhcbiAgICAgICAgICBwaSxcbiAgICAgICAgICBhd2FpdCBidWlsZFBsYW5NaWxlc3RvbmVQcm9tcHQobWlsZXN0b25lSWQsIG1pbGVzdG9uZVRpdGxlLCBiYXNlUGF0aCksXG4gICAgICAgICAgXCJnc2QtcnVuXCIsXG4gICAgICAgICAgY3R4LFxuICAgICAgICAgIFwicGxhbi1taWxlc3RvbmVcIixcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSBpZiAoY2hvaWNlID09PSBcImRpc2N1c3NcIikge1xuICAgICAgICBjb25zdCBkaXNjdXNzTWlsZXN0b25lVGVtcGxhdGVzID0gaW5saW5lVGVtcGxhdGUoXCJjb250ZXh0XCIsIFwiQ29udGV4dFwiKTtcbiAgICAgICAgY29uc3Qgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSA9IGdldFN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFiaWxpdHkocGksIGN0eCk7XG4gICAgICAgIGF3YWl0IGRpc3BhdGNoV29ya2Zsb3cocGksIGxvYWRQcm9tcHQoXCJndWlkZWQtZGlzY3Vzcy1taWxlc3RvbmVcIiwge1xuICAgICAgICAgIHdvcmtpbmdEaXJlY3Rvcnk6IGJhc2VQYXRoLFxuICAgICAgICAgIG1pbGVzdG9uZUlkLCBtaWxlc3RvbmVUaXRsZSwgaW5saW5lZFRlbXBsYXRlczogZGlzY3Vzc01pbGVzdG9uZVRlbXBsYXRlcywgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSxcbiAgICAgICAgICBjb21taXRJbnN0cnVjdGlvbjogYnVpbGREb2NzQ29tbWl0SW5zdHJ1Y3Rpb24oYGRvY3MoJHttaWxlc3RvbmVJZH0pOiBtaWxlc3RvbmUgY29udGV4dCBmcm9tIGRpc2N1c3NgKSxcbiAgICAgICAgICBmYXN0UGF0aEluc3RydWN0aW9uOiBcIlwiLFxuICAgICAgICB9KSwgXCJnc2QtcnVuXCIsIGN0eCwgXCJkaXNjdXNzLW1pbGVzdG9uZVwiKTtcbiAgICAgIH0gZWxzZSBpZiAoY2hvaWNlID09PSBcInNraXBfbWlsZXN0b25lXCIpIHtcbiAgICAgICAgY29uc3QgbWlsZXN0b25lSWRzID0gZmluZE1pbGVzdG9uZUlkcyhiYXNlUGF0aCk7XG4gICAgICAgIGNvbnN0IHVuaXF1ZU1pbGVzdG9uZUlkcyA9ICEhbG9hZEVmZmVjdGl2ZUdTRFByZWZlcmVuY2VzKCk/LnByZWZlcmVuY2VzPy51bmlxdWVfbWlsZXN0b25lX2lkcztcbiAgICAgICAgY29uc3QgbmV4dElkID0gbmV4dE1pbGVzdG9uZUlkUmVzZXJ2ZWQobWlsZXN0b25lSWRzLCB1bmlxdWVNaWxlc3RvbmVJZHMsIGJhc2VQYXRoKTtcbiAgICAgICAgc2V0UGVuZGluZ0F1dG9TdGFydChiYXNlUGF0aCwgeyBjdHgsIHBpLCBiYXNlUGF0aCwgbWlsZXN0b25lSWQ6IG5leHRJZCwgc3RlcDogc3RlcE1vZGUgfSk7XG4gICAgICAgIGF3YWl0IGRpc3BhdGNoV29ya2Zsb3cocGksIGF3YWl0IHByZXBhcmVBbmRCdWlsZERpc2N1c3NQcm9tcHQoY3R4LCBwaSwgbmV4dElkLFxuICAgICAgICAgIGBOZXcgbWlsZXN0b25lICR7bmV4dElkfS5gLFxuICAgICAgICAgIGJhc2VQYXRoXG4gICAgICAgICksIFwiZ3NkLXJ1blwiLCBjdHgsIFwiZGlzY3Vzcy1taWxlc3RvbmVcIik7XG4gICAgICB9IGVsc2UgaWYgKGNob2ljZSA9PT0gXCJkaXNjYXJkX21pbGVzdG9uZVwiKSB7XG4gICAgICAgIGNvbnN0IGNvbmZpcm1lZCA9IGF3YWl0IHNob3dDb25maXJtKGN0eCwge1xuICAgICAgICAgIHRpdGxlOiBcIkRpc2NhcmQgbWlsZXN0b25lP1wiLFxuICAgICAgICAgIG1lc3NhZ2U6IGBUaGlzIHdpbGwgcGVybWFuZW50bHkgZGVsZXRlICR7bWlsZXN0b25lSWR9IGFuZCBhbGwgaXRzIGNvbnRlbnRzLmAsXG4gICAgICAgICAgY29uZmlybUxhYmVsOiBcIkRpc2NhcmRcIixcbiAgICAgICAgICBkZWNsaW5lTGFiZWw6IFwiQ2FuY2VsXCIsXG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoY29uZmlybWVkKSB7XG4gICAgICAgICAgZGlzY2FyZE1pbGVzdG9uZShiYXNlUGF0aCwgbWlsZXN0b25lSWQpO1xuICAgICAgICAgIHJldHVybiBzaG93U21hcnRFbnRyeShjdHgsIHBpLCBiYXNlUGF0aCwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gUm9hZG1hcCBleGlzdHMgXHUyMDE0IGVpdGhlciBibG9ja2VkIG9yIHJlYWR5IGZvciBhdXRvXG4gICAgICBjb25zdCBhY3Rpb25zID0gW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiYXV0b1wiLFxuICAgICAgICAgIGxhYmVsOiBcIkdvIGF1dG9cIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJFeGVjdXRlIGV2ZXJ5dGhpbmcgYXV0b21hdGljYWxseSB1bnRpbCBtaWxlc3RvbmUgY29tcGxldGUuXCIsXG4gICAgICAgICAgcmVjb21tZW5kZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJzdGF0dXNcIixcbiAgICAgICAgICBsYWJlbDogXCJWaWV3IHN0YXR1c1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlNlZSBtaWxlc3RvbmUgcHJvZ3Jlc3MgYW5kIGJsb2NrZXJzLlwiLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwibWlsZXN0b25lX2FjdGlvbnNcIixcbiAgICAgICAgICBsYWJlbDogXCJNaWxlc3RvbmUgYWN0aW9uc1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlBhcmssIGRpc2NhcmQsIG9yIHNraXAgdGhpcyBtaWxlc3RvbmUuXCIsXG4gICAgICAgIH0sXG4gICAgICBdO1xuXG4gICAgICBjb25zdCBjaG9pY2UgPSBhd2FpdCBzaG93TmV4dEFjdGlvbihjdHgsIHtcbiAgICAgICAgdGl0bGU6IGBHU0QgXHUyMDE0ICR7bWlsZXN0b25lSWR9OiAke21pbGVzdG9uZVRpdGxlfWAsXG4gICAgICAgIHN1bW1hcnk6IFtcIlJvYWRtYXAgZXhpc3RzLiBSZWFkeSB0byBleGVjdXRlLlwiXSxcbiAgICAgICAgYWN0aW9ucyxcbiAgICAgICAgbm90WWV0TWVzc2FnZTogXCJSdW4gL2dzZCBzdGF0dXMgZm9yIGRldGFpbHMuXCIsXG4gICAgICB9KTtcblxuICAgICAgaWYgKGNob2ljZSA9PT0gXCJhdXRvXCIpIHtcbiAgICAgICAgc3RhcnRBdXRvRGV0YWNoZWQoY3R4LCBwaSwgYmFzZVBhdGgsIGZhbHNlKTtcbiAgICAgIH0gZWxzZSBpZiAoY2hvaWNlID09PSBcInN0YXR1c1wiKSB7XG4gICAgICAgIGNvbnN0IHsgZmlyZVN0YXR1c1ZpYUNvbW1hbmQgfSA9IGF3YWl0IGltcG9ydChcIi4vY29tbWFuZHMuanNcIik7XG4gICAgICAgIGF3YWl0IGZpcmVTdGF0dXNWaWFDb21tYW5kKGN0eCk7XG4gICAgICB9IGVsc2UgaWYgKGNob2ljZSA9PT0gXCJtaWxlc3RvbmVfYWN0aW9uc1wiKSB7XG4gICAgICAgIGNvbnN0IGFjdGVkID0gYXdhaXQgaGFuZGxlTWlsZXN0b25lQWN0aW9ucyhjdHgsIHBpLCBiYXNlUGF0aCwgbWlsZXN0b25lSWQsIG1pbGVzdG9uZVRpdGxlLCBvcHRpb25zKTtcbiAgICAgICAgaWYgKGFjdGVkKSByZXR1cm4gc2hvd1NtYXJ0RW50cnkoY3R4LCBwaSwgYmFzZVBhdGgsIG9wdGlvbnMpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBzbGljZUlkID0gc3RhdGUuYWN0aXZlU2xpY2UuaWQ7XG4gIGNvbnN0IHNsaWNlVGl0bGUgPSBzdGF0ZS5hY3RpdmVTbGljZS50aXRsZTtcblxuICAvLyBcdTI1MDBcdTI1MDAgU2xpY2UgbmVlZHMgcGxhbm5pbmcgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChzdGF0ZS5waGFzZSA9PT0gXCJwbGFubmluZ1wiKSB7XG4gICAgY29uc3QgY29udGV4dEZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgXCJDT05URVhUXCIpO1xuICAgIGNvbnN0IHJlc2VhcmNoRmlsZSA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBzbGljZUlkLCBcIlJFU0VBUkNIXCIpO1xuICAgIGNvbnN0IGhhc0NvbnRleHQgPSAhIShjb250ZXh0RmlsZSAmJiBhd2FpdCBsb2FkRmlsZShjb250ZXh0RmlsZSkpO1xuICAgIGNvbnN0IGhhc1Jlc2VhcmNoID0gISEocmVzZWFyY2hGaWxlICYmIGF3YWl0IGxvYWRGaWxlKHJlc2VhcmNoRmlsZSkpO1xuXG4gICAgY29uc3QgYWN0aW9ucyA9IFtcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwicGxhblwiLFxuICAgICAgICBsYWJlbDogYFBsYW4gJHtzbGljZUlkfWAsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBgRGVjb21wb3NlIFwiJHtzbGljZVRpdGxlfVwiIGludG8gdGFza3Mgd2l0aCBtdXN0LWhhdmVzLmAsXG4gICAgICAgIHJlY29tbWVuZGVkOiB0cnVlLFxuICAgICAgfSxcbiAgICAgIC4uLighaGFzQ29udGV4dCA/IFt7XG4gICAgICAgIGlkOiBcImRpc2N1c3NcIixcbiAgICAgICAgbGFiZWw6IGBEaXNjdXNzICR7c2xpY2VJZH0gZmlyc3RgLFxuICAgICAgICBkZXNjcmlwdGlvbjogXCJDYXB0dXJlIGNvbnRleHQgYW5kIGRlY2lzaW9ucyBmb3IgdGhpcyBzbGljZS5cIixcbiAgICAgIH1dIDogW10pLFxuICAgICAgLi4uKCFoYXNSZXNlYXJjaCA/IFt7XG4gICAgICAgIGlkOiBcInJlc2VhcmNoXCIsXG4gICAgICAgIGxhYmVsOiBgUmVzZWFyY2ggJHtzbGljZUlkfSBmaXJzdGAsXG4gICAgICAgIGRlc2NyaXB0aW9uOiBcIlNjb3V0IGNvZGViYXNlIGFuZCByZWxldmFudCBkb2NzLlwiLFxuICAgICAgfV0gOiBbXSksXG4gICAgICB7XG4gICAgICAgIGlkOiBcInN0YXR1c1wiLFxuICAgICAgICBsYWJlbDogXCJWaWV3IHN0YXR1c1wiLFxuICAgICAgICBkZXNjcmlwdGlvbjogXCJTZWUgbWlsZXN0b25lIHByb2dyZXNzLlwiLFxuICAgICAgfSxcbiAgICAgIHtcbiAgICAgICAgaWQ6IFwibWlsZXN0b25lX2FjdGlvbnNcIixcbiAgICAgICAgbGFiZWw6IFwiTWlsZXN0b25lIGFjdGlvbnNcIixcbiAgICAgICAgZGVzY3JpcHRpb246IFwiUGFyaywgZGlzY2FyZCwgb3Igc2tpcCB0aGlzIG1pbGVzdG9uZS5cIixcbiAgICAgIH0sXG4gICAgXTtcblxuICAgIGNvbnN0IHN1bW1hcnlQYXJ0cyA9IFtdO1xuICAgIGlmIChoYXNDb250ZXh0KSBzdW1tYXJ5UGFydHMucHVzaChcImNvbnRleHQgXHUyNzEzXCIpO1xuICAgIGlmIChoYXNSZXNlYXJjaCkgc3VtbWFyeVBhcnRzLnB1c2goXCJyZXNlYXJjaCBcdTI3MTNcIik7XG4gICAgY29uc3Qgc3VtbWFyeUxpbmUgPSBzdW1tYXJ5UGFydHMubGVuZ3RoID4gMFxuICAgICAgPyBgJHtzbGljZUlkfTogJHtzbGljZVRpdGxlfSAoJHtzdW1tYXJ5UGFydHMuam9pbihcIiwgXCIpfSlgXG4gICAgICA6IGAke3NsaWNlSWR9OiAke3NsaWNlVGl0bGV9IFx1MjAxNCByZWFkeSBmb3IgcGxhbm5pbmcuYDtcblxuICAgIGNvbnN0IGNob2ljZSA9IGF3YWl0IHNob3dOZXh0QWN0aW9uKGN0eCwge1xuICAgICAgdGl0bGU6IGBHU0QgXHUyMDE0ICR7bWlsZXN0b25lSWR9IC8gJHtzbGljZUlkfTogJHtzbGljZVRpdGxlfWAsXG4gICAgICBzdW1tYXJ5OiBbc3VtbWFyeUxpbmVdLFxuICAgICAgYWN0aW9ucyxcbiAgICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2Qgd2hlbiByZWFkeS5cIixcbiAgICB9KTtcblxuICAgIGlmIChjaG9pY2UgPT09IFwicGxhblwiKSB7XG4gICAgICBjdHgudWkuc2V0U3RhdHVzKFwiZ3NkLXN0ZXBcIiwgXCJTbGljZSBQbGFubmluZyBcdTAwQjcgYW5zd2VyIHRoZSBxdWVzdGlvbnMgYWJvdmVcIik7XG4gICAgICBhd2FpdCBkaXNwYXRjaFdvcmtmbG93KFxuICAgICAgICBwaSxcbiAgICAgICAgYXdhaXQgYnVpbGRQbGFuU2xpY2VQcm9tcHQobWlsZXN0b25lSWQsIG1pbGVzdG9uZVRpdGxlLCBzbGljZUlkLCBzbGljZVRpdGxlLCBiYXNlUGF0aCksXG4gICAgICAgIFwiZ3NkLXJ1blwiLFxuICAgICAgICBjdHgsXG4gICAgICAgIFwicGxhbi1zbGljZVwiLFxuICAgICAgKTtcbiAgICB9IGVsc2UgaWYgKGNob2ljZSA9PT0gXCJkaXNjdXNzXCIpIHtcbiAgICAgIGNvbnN0IHNxQXZhaWwgPSBnZXRTdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmlsaXR5KHBpLCBjdHgpO1xuICAgICAgYXdhaXQgZGlzcGF0Y2hXb3JrZmxvdyhwaSwgYXdhaXQgYnVpbGREaXNjdXNzU2xpY2VQcm9tcHQobWlsZXN0b25lSWQsIHNsaWNlSWQsIHNsaWNlVGl0bGUsIGJhc2VQYXRoLCB7IHJlZGlzY3VzczogaGFzQ29udGV4dCwgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZTogc3FBdmFpbCB9KSwgXCJnc2QtcnVuXCIsIGN0eCwgXCJkaXNjdXNzLXNsaWNlXCIpO1xuICAgIH0gZWxzZSBpZiAoY2hvaWNlID09PSBcInJlc2VhcmNoXCIpIHtcbiAgICAgIGNvbnN0IHJlc2VhcmNoVGVtcGxhdGVzID0gaW5saW5lVGVtcGxhdGUoXCJyZXNlYXJjaFwiLCBcIlJlc2VhcmNoXCIpO1xuICAgICAgYXdhaXQgZGlzcGF0Y2hXb3JrZmxvdyhwaSwgbG9hZFByb21wdChcImd1aWRlZC1yZXNlYXJjaC1zbGljZVwiLCB7XG4gICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICBzbGljZUlkLFxuICAgICAgICBzbGljZVRpdGxlLFxuICAgICAgICBpbmxpbmVkVGVtcGxhdGVzOiByZXNlYXJjaFRlbXBsYXRlcyxcbiAgICAgICAgc2tpbGxBY3RpdmF0aW9uOiBidWlsZFNraWxsQWN0aXZhdGlvbkJsb2NrKHtcbiAgICAgICAgICBiYXNlOiBiYXNlUGF0aCxcbiAgICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgICBzbGljZUlkLFxuICAgICAgICAgIHNsaWNlVGl0bGUsXG4gICAgICAgICAgZXh0cmFDb250ZXh0OiBbcmVzZWFyY2hUZW1wbGF0ZXNdLFxuICAgICAgICB9KSxcbiAgICAgIH0pLCBcImdzZC1ydW5cIiwgY3R4LCBcInJlc2VhcmNoLXNsaWNlXCIpO1xuICAgIH0gZWxzZSBpZiAoY2hvaWNlID09PSBcInN0YXR1c1wiKSB7XG4gICAgICBjb25zdCB7IGZpcmVTdGF0dXNWaWFDb21tYW5kIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2NvbW1hbmRzLmpzXCIpO1xuICAgICAgYXdhaXQgZmlyZVN0YXR1c1ZpYUNvbW1hbmQoY3R4KTtcbiAgICB9IGVsc2UgaWYgKGNob2ljZSA9PT0gXCJtaWxlc3RvbmVfYWN0aW9uc1wiKSB7XG4gICAgICBjb25zdCBhY3RlZCA9IGF3YWl0IGhhbmRsZU1pbGVzdG9uZUFjdGlvbnMoY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBtaWxlc3RvbmVUaXRsZSwgb3B0aW9ucyk7XG4gICAgICBpZiAoYWN0ZWQpIHJldHVybiBzaG93U21hcnRFbnRyeShjdHgsIHBpLCBiYXNlUGF0aCwgb3B0aW9ucyk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBBbGwgdGFza3MgZG9uZSBcdTIxOTIgQ29tcGxldGUgc2xpY2UgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGlmIChzdGF0ZS5waGFzZSA9PT0gXCJzdW1tYXJpemluZ1wiKSB7XG4gICAgY29uc3QgY2hvaWNlID0gYXdhaXQgc2hvd05leHRBY3Rpb24oY3R4LCB7XG4gICAgICB0aXRsZTogYEdTRCBcdTIwMTQgJHttaWxlc3RvbmVJZH0gLyAke3NsaWNlSWR9OiAke3NsaWNlVGl0bGV9YCxcbiAgICAgIHN1bW1hcnk6IFtcIkFsbCB0YXNrcyBjb21wbGV0ZS4gUmVhZHkgZm9yIHNsaWNlIHN1bW1hcnkuXCJdLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICB7XG4gICAgICAgICAgaWQ6IFwiY29tcGxldGVcIixcbiAgICAgICAgICBsYWJlbDogYENvbXBsZXRlICR7c2xpY2VJZH1gLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIldyaXRlIHNsaWNlIHN1bW1hcnksIFVBVCwgbWFyayBkb25lLCBhbmQgc3F1YXNoLW1lcmdlIHRvIG1haW4uXCIsXG4gICAgICAgICAgcmVjb21tZW5kZWQ6IHRydWUsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJzdGF0dXNcIixcbiAgICAgICAgICBsYWJlbDogXCJWaWV3IHN0YXR1c1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlJldmlldyB0YXNrcyBiZWZvcmUgY29tcGxldGluZy5cIixcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcIm1pbGVzdG9uZV9hY3Rpb25zXCIsXG4gICAgICAgICAgbGFiZWw6IFwiTWlsZXN0b25lIGFjdGlvbnNcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogXCJQYXJrLCBkaXNjYXJkLCBvciBza2lwIHRoaXMgbWlsZXN0b25lLlwiLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIG5vdFlldE1lc3NhZ2U6IFwiUnVuIC9nc2Qgd2hlbiByZWFkeS5cIixcbiAgICB9KTtcblxuICAgIGlmIChjaG9pY2UgPT09IFwiY29tcGxldGVcIikge1xuICAgICAgY3R4LnVpLnNldFN0YXR1cyhcImdzZC1zdGVwXCIsIFwiQ29tcGxldGluZyBTbGljZSBcdTAwQjcgcmV2aWV3IGNoYW5nZXMgYWJvdmVcIik7XG4gICAgICBhd2FpdCBkaXNwYXRjaFdvcmtmbG93KFxuICAgICAgICBwaSxcbiAgICAgICAgYXdhaXQgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0KG1pbGVzdG9uZUlkLCBtaWxlc3RvbmVUaXRsZSwgc2xpY2VJZCwgc2xpY2VUaXRsZSwgYmFzZVBhdGgpLFxuICAgICAgICBcImdzZC1ydW5cIixcbiAgICAgICAgY3R4LFxuICAgICAgICBcImNvbXBsZXRlLXNsaWNlXCIsXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAoY2hvaWNlID09PSBcInN0YXR1c1wiKSB7XG4gICAgICBjb25zdCB7IGZpcmVTdGF0dXNWaWFDb21tYW5kIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2NvbW1hbmRzLmpzXCIpO1xuICAgICAgYXdhaXQgZmlyZVN0YXR1c1ZpYUNvbW1hbmQoY3R4KTtcbiAgICB9IGVsc2UgaWYgKGNob2ljZSA9PT0gXCJtaWxlc3RvbmVfYWN0aW9uc1wiKSB7XG4gICAgICBjb25zdCBhY3RlZCA9IGF3YWl0IGhhbmRsZU1pbGVzdG9uZUFjdGlvbnMoY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBtaWxlc3RvbmVUaXRsZSwgb3B0aW9ucyk7XG4gICAgICBpZiAoYWN0ZWQpIHJldHVybiBzaG93U21hcnRFbnRyeShjdHgsIHBpLCBiYXNlUGF0aCwgb3B0aW9ucyk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBBY3RpdmUgdGFzayBcdTIxOTIgRXhlY3V0ZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgaWYgKHN0YXRlLmFjdGl2ZVRhc2spIHtcbiAgICBjb25zdCB0YXNrSWQgPSBzdGF0ZS5hY3RpdmVUYXNrLmlkO1xuICAgIGNvbnN0IHRhc2tUaXRsZSA9IHN0YXRlLmFjdGl2ZVRhc2sudGl0bGU7XG5cbiAgICBjb25zdCBjb250aW51ZUZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVJZCwgc2xpY2VJZCwgXCJDT05USU5VRVwiKTtcbiAgICBjb25zdCBzRGlyID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlUGF0aCwgbWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICAgIGNvbnN0IGhhc0ludGVycnVwdGVkID0gISEoY29udGludWVGaWxlICYmIGF3YWl0IGxvYWRGaWxlKGNvbnRpbnVlRmlsZSkpIHx8XG4gICAgICAhIShzRGlyICYmIGF3YWl0IGxvYWRGaWxlKGpvaW4oc0RpciwgXCJjb250aW51ZS5tZFwiKSkpO1xuXG4gICAgY29uc3QgY2hvaWNlID0gYXdhaXQgc2hvd05leHRBY3Rpb24oY3R4LCB7XG4gICAgICB0aXRsZTogYEdTRCBcdTIwMTQgJHttaWxlc3RvbmVJZH0gLyAke3NsaWNlSWR9OiAke3NsaWNlVGl0bGV9YCxcbiAgICAgIHN1bW1hcnk6IFtcbiAgICAgICAgaGFzSW50ZXJydXB0ZWRcbiAgICAgICAgICA/IGBSZXN1bWluZzogJHt0YXNrSWR9IFx1MjAxNCAke3Rhc2tUaXRsZX1gXG4gICAgICAgICAgOiBgTmV4dDogJHt0YXNrSWR9IFx1MjAxNCAke3Rhc2tUaXRsZX1gLFxuICAgICAgXSxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcImV4ZWN1dGVcIixcbiAgICAgICAgICBsYWJlbDogaGFzSW50ZXJydXB0ZWQgPyBgUmVzdW1lICR7dGFza0lkfWAgOiBgRXhlY3V0ZSAke3Rhc2tJZH1gLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBoYXNJbnRlcnJ1cHRlZFxuICAgICAgICAgICAgPyBcIkNvbnRpbnVlIGZyb20gd2hlcmUgeW91IGxlZnQgb2ZmLlwiXG4gICAgICAgICAgICA6IGBTdGFydCB3b3JraW5nIG9uIFwiJHt0YXNrVGl0bGV9XCIuYCxcbiAgICAgICAgICByZWNvbW1lbmRlZDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGlkOiBcImF1dG9cIixcbiAgICAgICAgICBsYWJlbDogXCJHbyBhdXRvXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiRXhlY3V0ZSB0aGlzIGFuZCBhbGwgcmVtYWluaW5nIHRhc2tzIGF1dG9tYXRpY2FsbHkuXCIsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJzdGF0dXNcIixcbiAgICAgICAgICBsYWJlbDogXCJWaWV3IHN0YXR1c1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBcIlNlZSBzbGljZSBwcm9ncmVzcyBiZWZvcmUgc3RhcnRpbmcuXCIsXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBpZDogXCJtaWxlc3RvbmVfYWN0aW9uc1wiLFxuICAgICAgICAgIGxhYmVsOiBcIk1pbGVzdG9uZSBhY3Rpb25zXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IFwiUGFyaywgZGlzY2FyZCwgb3Igc2tpcCB0aGlzIG1pbGVzdG9uZS5cIixcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBub3RZZXRNZXNzYWdlOiBcIlJ1biAvZ3NkIHdoZW4gcmVhZHkuXCIsXG4gICAgfSk7XG5cbiAgICBpZiAoY2hvaWNlID09PSBcImF1dG9cIikge1xuICAgICAgc3RhcnRBdXRvRGV0YWNoZWQoY3R4LCBwaSwgYmFzZVBhdGgsIGZhbHNlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoY2hvaWNlID09PSBcImV4ZWN1dGVcIikge1xuICAgICAgY3R4LnVpLnNldFN0YXR1cyhcImdzZC1zdGVwXCIsIFwiRXhlY3V0aW5nIFRhc2sgXHUwMEI3IGZvbGxvdyBwcm9ncmVzcyBhYm92ZVwiKTtcbiAgICAgIGlmIChoYXNJbnRlcnJ1cHRlZCkge1xuICAgICAgICBhd2FpdCBkaXNwYXRjaFdvcmtmbG93KHBpLCBsb2FkUHJvbXB0KFwiZ3VpZGVkLXJlc3VtZS10YXNrXCIsIHtcbiAgICAgICAgICBtaWxlc3RvbmVJZCxcbiAgICAgICAgICBzbGljZUlkLFxuICAgICAgICAgIHNraWxsQWN0aXZhdGlvbjogYnVpbGRTa2lsbEFjdGl2YXRpb25CbG9jayh7XG4gICAgICAgICAgICBiYXNlOiBiYXNlUGF0aCxcbiAgICAgICAgICAgIG1pbGVzdG9uZUlkLFxuICAgICAgICAgICAgc2xpY2VJZCxcbiAgICAgICAgICAgIHRhc2tJZCxcbiAgICAgICAgICAgIHRhc2tUaXRsZSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSksIFwiZ3NkLXJ1blwiLCBjdHgsIFwiZXhlY3V0ZS10YXNrXCIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXdhaXQgZGlzcGF0Y2hXb3JrZmxvdyhcbiAgICAgICAgICBwaSxcbiAgICAgICAgICBhd2FpdCBidWlsZEV4ZWN1dGVUYXNrUHJvbXB0KG1pbGVzdG9uZUlkLCBzbGljZUlkLCBzbGljZVRpdGxlLCB0YXNrSWQsIHRhc2tUaXRsZSwgYmFzZVBhdGgpLFxuICAgICAgICAgIFwiZ3NkLXJ1blwiLFxuICAgICAgICAgIGN0eCxcbiAgICAgICAgICBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoY2hvaWNlID09PSBcInN0YXR1c1wiKSB7XG4gICAgICBjb25zdCB7IGZpcmVTdGF0dXNWaWFDb21tYW5kIH0gPSBhd2FpdCBpbXBvcnQoXCIuL2NvbW1hbmRzLmpzXCIpO1xuICAgICAgYXdhaXQgZmlyZVN0YXR1c1ZpYUNvbW1hbmQoY3R4KTtcbiAgICB9IGVsc2UgaWYgKGNob2ljZSA9PT0gXCJtaWxlc3RvbmVfYWN0aW9uc1wiKSB7XG4gICAgICBjb25zdCBhY3RlZCA9IGF3YWl0IGhhbmRsZU1pbGVzdG9uZUFjdGlvbnMoY3R4LCBwaSwgYmFzZVBhdGgsIG1pbGVzdG9uZUlkLCBtaWxlc3RvbmVUaXRsZSwgb3B0aW9ucyk7XG4gICAgICBpZiAoYWN0ZWQpIHJldHVybiBzaG93U21hcnRFbnRyeShjdHgsIHBpLCBiYXNlUGF0aCwgb3B0aW9ucyk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBGYWxsYmFjazogc2hvdyBzdGF0dXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IHsgZmlyZVN0YXR1c1ZpYUNvbW1hbmQgfSA9IGF3YWl0IGltcG9ydChcIi4vY29tbWFuZHMuanNcIik7XG4gIGF3YWl0IGZpcmVTdGF0dXNWaWFDb21tYW5kKGN0eCk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFVQSxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLFVBQVUsZ0JBQWdCO0FBQ25DLFNBQVMsZUFBZSxjQUFjLDBCQUEwQjtBQUNoRSxTQUFTLDBCQUEwQjtBQUNuQyxTQUFTLFlBQVksc0JBQXNCO0FBQzNDO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUNQLFNBQVMsYUFBYSx3QkFBd0I7QUFDOUMsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyxpQkFBaUI7QUFDMUI7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyx3QkFBd0Isd0JBQXdCLDhCQUE4QjtBQUN2RixTQUFTLG1DQUFtQztBQUM1QyxTQUFTLGVBQWU7QUFDeEI7QUFBQSxF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LElBQ0YsV0FBVyxXQUFXLFVBQVU7QUFDOUIsWUFBTSxFQUFFLHNCQUFBQSxzQkFBcUIsSUFBSSxNQUFNLE9BQU8sZUFBZTtBQUM3RCxZQUFNQSxzQkFBcUIsR0FBRztBQUFBLElBQ2hDLFdBQVcsV0FBVyxxQkFBcUI7QUFDekMsWUFBTSxRQUFRLE1BQU0sdUJBQXVCLEtBQUssSUFBSSxVQUFVLGFBQWEsZ0JBQWdCLE9BQU87QUFDbEcsVUFBSSxNQUFPLFFBQU8sZUFBZSxLQUFLLElBQUksVUFBVSxPQUFPO0FBQUEsSUFDN0Q7QUFDQTtBQUFBLEVBQ0Y7QUFHQSxRQUFNLEVBQUUscUJBQXFCLElBQUksTUFBTSxPQUFPLGVBQWU7QUFDN0QsUUFBTSxxQkFBcUIsR0FBRztBQUNoQzsiLAogICJuYW1lcyI6IFsibmV4dE1pbGVzdG9uZUlkUmVzZXJ2ZWQiLCAiZmluZE1pbGVzdG9uZUlkcyIsICJjbGVhclJlc2VydmVkTWlsZXN0b25lSWRzIiwgIm1hdGNoZXMiLCAiZW5zdXJlRGJPcGVuIiwgInBlbmRpbmdNaWxlc3RvbmVzIiwgImhhc0RyYWZ0IiwgImZpcmVTdGF0dXNWaWFDb21tYW5kIl0KfQo=
