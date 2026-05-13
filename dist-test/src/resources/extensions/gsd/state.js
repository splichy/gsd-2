import {
  parseRoadmap,
  parsePlan
} from "./parsers-legacy.js";
import {
  parseSummary,
  loadFile,
  parseRequirementCounts,
  parseContextDependsOn
} from "./files.js";
import {
  resolveMilestoneFile,
  resolveSlicePath,
  resolveSliceFile,
  resolveTaskFile,
  resolveTasksDir,
  resolveGsdRootFile,
  gsdRoot
} from "./paths.js";
import { findMilestoneIds } from "./milestone-ids.js";
import { loadQueueOrder, sortByQueueOrder } from "./queue-order.js";
import { isClosedStatus, isDeferredStatus } from "./status-guards.js";
import { nativeBatchParseGsdFiles } from "./native-parser-bridge.js";
import { join, resolve } from "path";
import { existsSync, readdirSync } from "node:fs";
import { debugCount, debugTime } from "./debug-logger.js";
import { logWarning } from "./workflow-logger.js";
import { extractVerdict } from "./verdict-parser.js";
import { detectPendingEscalation } from "./escalation.js";
import { isTerminalMilestoneSummaryContent } from "./milestone-summary-classifier.js";
import { incrementLegacyTelemetry } from "./legacy-telemetry.js";
import {
  isDbAvailable,
  wasDbOpenAttempted,
  getAllMilestones,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  getReplanHistory,
  getSlice,
  getRequirementCounts,
  getLatestAssessmentByScope,
  getPendingGateCountForTurn
} from "./gsd-db.js";
function isGhostMilestone(basePath, mid) {
  if (isDbAvailable()) {
    const dbRow = getMilestone(mid);
    if (dbRow) {
      if (dbRow.status === "queued") {
        const hasContent = resolveMilestoneFile(basePath, mid, "CONTEXT") || resolveMilestoneFile(basePath, mid, "ROADMAP") || resolveMilestoneFile(basePath, mid, "SUMMARY");
        return !hasContent;
      }
      return false;
    }
  }
  const root = gsdRoot(basePath);
  const wtPath = join(root, "worktrees", mid);
  if (existsSync(wtPath)) return false;
  const context = resolveMilestoneFile(basePath, mid, "CONTEXT");
  const draft = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const roadmap = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const summary = resolveMilestoneFile(basePath, mid, "SUMMARY");
  return !context && !draft && !roadmap && !summary;
}
function isReusableGhostMilestone(basePath, mid) {
  if (!isDbAvailable()) return false;
  const dbRow = getMilestone(mid);
  if (dbRow != null) return false;
  const root = gsdRoot(basePath);
  const wtPath = join(root, "worktrees", mid);
  if (existsSync(wtPath)) return false;
  const context = resolveMilestoneFile(basePath, mid, "CONTEXT");
  const draft = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
  const roadmap = resolveMilestoneFile(basePath, mid, "ROADMAP");
  const summary = resolveMilestoneFile(basePath, mid, "SUMMARY");
  return !context && !draft && !roadmap && !summary;
}
function isSliceComplete(plan) {
  return plan.tasks.length > 0 && plan.tasks.every((t) => t.done);
}
function isMilestoneComplete(roadmap) {
  return roadmap.slices.length > 0 && roadmap.slices.every((s) => s.done);
}
function isValidationTerminal(validationContent) {
  return extractVerdict(validationContent) != null;
}
async function isTerminalMilestoneSummaryFile(path, loader) {
  const content = await loader(path);
  return content != null && isTerminalMilestoneSummaryContent(content);
}
const CACHE_TTL_MS = 100;
let _stateCache = null;
let _telemetry = { dbDeriveCount: 0, markdownDeriveCount: 0 };
function getDeriveTelemetry() {
  return { ..._telemetry };
}
function resetDeriveTelemetry() {
  _telemetry = { dbDeriveCount: 0, markdownDeriveCount: 0 };
}
function invalidateStateCache() {
  _stateCache = null;
}
async function getActiveMilestoneId(basePath) {
  const milestoneLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK : void 0;
  if (milestoneLock) {
    if (isDbAvailable()) {
      const locked = getAllMilestones().find((m) => m.id === milestoneLock);
      if (!locked || isClosedStatus(locked.status) || locked.status === "parked") return null;
      return locked.id;
    }
    const milestoneIds2 = findMilestoneIds(basePath);
    if (!milestoneIds2.includes(milestoneLock)) return null;
    const lockedParked = resolveMilestoneFile(basePath, milestoneLock, "PARKED");
    if (lockedParked) return null;
    return milestoneLock;
  }
  if (isDbAvailable()) {
    const allMilestones = getAllMilestones();
    if (allMilestones.length > 0) {
      for (const m of allMilestones) {
        if (isClosedStatus(m.status) || m.status === "parked") continue;
        return m.id;
      }
      return null;
    }
  }
  const milestoneIds = findMilestoneIds(basePath);
  for (const mid of milestoneIds) {
    const parkedFile = resolveMilestoneFile(basePath, mid, "PARKED");
    if (parkedFile) continue;
    const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const content = roadmapFile ? await loadFile(roadmapFile) : null;
    if (!content) {
      const summaryFile2 = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile2 && await isTerminalMilestoneSummaryFile(summaryFile2, loadFile)) continue;
      if (isGhostMilestone(basePath, mid)) continue;
      return mid;
    }
    const roadmap = parseRoadmap(content);
    const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
    if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, loadFile)) continue;
    if (!isMilestoneComplete(roadmap)) return mid;
    return mid;
  }
  return null;
}
async function deriveState(basePath, opts) {
  const cacheKey = opts?.projectRootForReads ?? basePath;
  if (_stateCache && _stateCache.basePath === cacheKey && Date.now() - _stateCache.timestamp < CACHE_TTL_MS) {
    return _stateCache.result;
  }
  const stopTimer = debugTime("derive-state-impl");
  let result;
  if (isDbAvailable()) {
    const stopDbTimer = debugTime("derive-state-db");
    result = await deriveStateFromDb(basePath);
    stopDbTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
    _telemetry.dbDeriveCount++;
  } else if (process.env.GSD_ALLOW_MARKDOWN_DERIVE_FALLBACK === "1") {
    if (wasDbOpenAttempted()) {
      logWarning("state", "DB unavailable \u2014 using explicit legacy filesystem state derivation");
    }
    result = await _deriveStateImpl(basePath, opts);
    _telemetry.markdownDeriveCount++;
    incrementLegacyTelemetry("legacy.markdownFallbackUsed");
  } else {
    if (wasDbOpenAttempted()) {
      logWarning("state", "DB unavailable \u2014 refusing implicit markdown state derivation");
    }
    result = {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: "pre-planning",
      recentDecisions: [],
      blockers: ["DB unavailable \u2014 runtime markdown state derivation is disabled"],
      nextAction: "Open or create the canonical GSD database before deriving workflow state.",
      registry: [],
      requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
      progress: { milestones: { done: 0, total: 0 } }
    };
  }
  stopTimer({ phase: result.phase, milestone: result.activeMilestone?.id });
  debugCount("deriveStateCalls");
  _stateCache = { basePath: cacheKey, result, timestamp: Date.now() };
  return result;
}
function stripMilestonePrefix(title) {
  return title.replace(/^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/, "") || title;
}
function extractContextTitle(content, fallback) {
  if (!content) return fallback;
  const h1 = content.split("\n").find((line) => line.startsWith("# "));
  if (!h1) return fallback;
  return stripMilestonePrefix(h1.slice(2).trim()) || fallback;
}
const isStatusDone = isClosedStatus;
function buildCompletenessSet(basePath, milestones) {
  const completeMilestoneIds = /* @__PURE__ */ new Set();
  const parkedMilestoneIds = /* @__PURE__ */ new Set();
  for (const m of milestones) {
    if (m.status === "parked") {
      parkedMilestoneIds.add(m.id);
      continue;
    }
    if (isStatusDone(m.status)) {
      completeMilestoneIds.add(m.id);
      continue;
    }
  }
  return { completeMilestoneIds, parkedMilestoneIds };
}
async function buildRegistryAndFindActive(basePath, milestones, completeMilestoneIds, parkedMilestoneIds) {
  const registry = [];
  let activeMilestone = null;
  let activeMilestoneSlices = [];
  let activeMilestoneFound = false;
  let activeMilestoneHasDraft = false;
  let firstDeferredQueuedShell = null;
  for (const m of milestones) {
    if (parkedMilestoneIds.has(m.id)) {
      registry.push({ id: m.id, title: stripMilestonePrefix(m.title) || m.id, status: "parked" });
      continue;
    }
    const slices = getMilestoneSlices(m.id);
    if (completeMilestoneIds.has(m.id)) {
      const title2 = stripMilestonePrefix(m.title) || m.id;
      registry.push({ id: m.id, title: title2, status: "complete" });
      continue;
    }
    const allSlicesDone = slices.length > 0 && slices.every((s) => isStatusDone(s.status));
    const title = stripMilestonePrefix(m.title) || m.id;
    if (!activeMilestoneFound) {
      const deps = m.depends_on;
      const depsUnmet = deps.some((dep) => !completeMilestoneIds.has(dep));
      if (depsUnmet) {
        registry.push({ id: m.id, title, status: "pending", dependsOn: deps });
        continue;
      }
      if (m.status === "queued" && slices.length === 0) {
        if (!firstDeferredQueuedShell) {
          firstDeferredQueuedShell = { id: m.id, title, deps };
        }
        registry.push({ id: m.id, title, status: "pending", ...deps.length > 0 ? { dependsOn: deps } : {} });
        continue;
      }
      if (allSlicesDone) {
        activeMilestone = { id: m.id, title };
        activeMilestoneSlices = slices;
        activeMilestoneFound = true;
        registry.push({ id: m.id, title, status: "active", ...deps.length > 0 ? { dependsOn: deps } : {} });
        continue;
      }
      if (m.status === "needs-discussion") activeMilestoneHasDraft = true;
      activeMilestone = { id: m.id, title };
      activeMilestoneSlices = slices;
      activeMilestoneFound = true;
      registry.push({ id: m.id, title, status: "active", ...deps.length > 0 ? { dependsOn: deps } : {} });
    } else {
      const deps = m.depends_on;
      registry.push({ id: m.id, title, status: "pending", ...deps.length > 0 ? { dependsOn: deps } : {} });
    }
  }
  if (!activeMilestoneFound && firstDeferredQueuedShell) {
    const shell = firstDeferredQueuedShell;
    activeMilestone = { id: shell.id, title: shell.title };
    activeMilestoneSlices = [];
    activeMilestoneFound = true;
    const entry = registry.find((e) => e.id === shell.id);
    if (entry) entry.status = "active";
  }
  return { registry, activeMilestone, activeMilestoneSlices, activeMilestoneHasDraft };
}
function handleNoActiveMilestone(registry, requirements, milestoneProgress) {
  const pendingEntries = registry.filter((e) => e.status === "pending");
  const parkedEntries = registry.filter((e) => e.status === "parked");
  if (pendingEntries.length > 0) {
    const blockerDetails = pendingEntries.filter((e) => e.dependsOn && e.dependsOn.length > 0).map((e) => `${e.id} is waiting on unmet deps: ${e.dependsOn.join(", ")}`);
    return {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: "blocked",
      recentDecisions: [],
      blockers: blockerDetails.length > 0 ? blockerDetails : ["All remaining milestones are dep-blocked but no deps listed \u2014 check CONTEXT.md files"],
      nextAction: "Resolve milestone dependencies before proceeding.",
      registry,
      requirements,
      progress: { milestones: milestoneProgress }
    };
  }
  if (parkedEntries.length > 0) {
    const parkedIds = parkedEntries.map((e) => e.id).join(", ");
    return {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: "pre-planning",
      recentDecisions: [],
      blockers: [],
      nextAction: `All remaining milestones are parked (${parkedIds}). Run /gsd unpark <id> or create a new milestone.`,
      registry,
      requirements,
      progress: { milestones: milestoneProgress }
    };
  }
  if (registry.length === 0) {
    return {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: "pre-planning",
      recentDecisions: [],
      blockers: [],
      nextAction: "No milestones found. Run /gsd to create one.",
      registry: [],
      requirements,
      progress: { milestones: { done: 0, total: 0 } }
    };
  }
  const lastEntry = registry[registry.length - 1];
  const activeReqs = requirements.active ?? 0;
  const completionNote = activeReqs > 0 ? `All milestones complete. ${activeReqs} active requirement${activeReqs === 1 ? "" : "s"} in REQUIREMENTS.md ${activeReqs === 1 ? "has" : "have"} not been mapped to a milestone.` : "All milestones complete.";
  return {
    activeMilestone: null,
    lastCompletedMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
    activeSlice: null,
    activeTask: null,
    phase: "complete",
    recentDecisions: [],
    blockers: [],
    nextAction: completionNote,
    registry,
    requirements,
    progress: { milestones: milestoneProgress }
  };
}
async function handleAllSlicesDone(basePath, activeMilestone, registry, requirements, milestoneProgress, sliceProgress) {
  const validation = getLatestAssessmentByScope(activeMilestone.id, "milestone-validation");
  const verdict = typeof validation?.status === "string" ? validation.status : void 0;
  const validationTerminal = verdict != null && verdict !== "";
  if (!validationTerminal) {
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: "validating-milestone",
      recentDecisions: [],
      blockers: [],
      nextAction: `Validate milestone ${activeMilestone.id} before completion.`,
      registry,
      requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress }
    };
  }
  if (verdict === "needs-remediation") {
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: "blocked",
      recentDecisions: [],
      blockers: [
        `Milestone ${activeMilestone.id} validation verdict is needs-remediation but all slices are complete. Add remediation slices via gsd_reassess_roadmap or override the verdict manually.`
      ],
      nextAction: `Resolve ${activeMilestone.id} remediation before proceeding.`,
      registry,
      requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress }
    };
  }
  return {
    activeMilestone,
    activeSlice: null,
    activeTask: null,
    phase: "completing-milestone",
    recentDecisions: [],
    blockers: [],
    nextAction: `All slices complete in ${activeMilestone.id}. Write milestone summary.`,
    registry,
    requirements,
    progress: { milestones: milestoneProgress, slices: sliceProgress }
  };
}
function resolveSliceDependencies(activeMilestoneSlices) {
  const doneSliceIds = new Set(
    activeMilestoneSlices.filter((s) => isStatusDone(s.status)).map((s) => s.id)
  );
  const sliceLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_SLICE_LOCK : void 0;
  if (sliceLock) {
    const lockedSlice = activeMilestoneSlices.find((s) => s.id === sliceLock);
    if (lockedSlice) {
      return { activeSlice: { id: lockedSlice.id, title: lockedSlice.title }, activeSliceRow: lockedSlice };
    } else {
      logWarning("state", `GSD_SLICE_LOCK=${sliceLock} not found in active slices \u2014 worker has no assigned work`);
      return { activeSlice: null, activeSliceRow: null };
    }
  }
  for (const s of activeMilestoneSlices) {
    if (isStatusDone(s.status)) continue;
    if (isDeferredStatus(s.status)) continue;
    if (s.depends.every((dep) => doneSliceIds.has(dep))) {
      return { activeSlice: { id: s.id, title: s.title }, activeSliceRow: s };
    }
  }
  return { activeSlice: null, activeSliceRow: null };
}
async function detectBlockers(basePath, milestoneId, sliceId, tasks) {
  const completedTasks = tasks.filter((t) => isStatusDone(t.status));
  for (const ct of completedTasks) {
    if (ct.blocker_discovered) {
      return ct.id;
    }
  }
  return null;
}
function checkReplanTrigger(basePath, milestoneId, sliceId) {
  const sliceRow = getSlice(milestoneId, sliceId);
  return !!sliceRow?.replan_triggered_at;
}
async function deriveStateFromDb(basePath) {
  const requirements = getRequirementCounts();
  const allMilestones = getAllMilestones();
  const milestoneLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK : void 0;
  const milestones = milestoneLock ? allMilestones.filter((m) => m.id === milestoneLock) : allMilestones;
  if (milestones.length === 0) {
    return {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: "pre-planning",
      recentDecisions: [],
      blockers: [],
      nextAction: "No milestones found. Run /gsd to create one.",
      registry: [],
      requirements,
      progress: { milestones: { done: 0, total: 0 } }
    };
  }
  const { completeMilestoneIds, parkedMilestoneIds } = buildCompletenessSet(basePath, milestones);
  const registryContext = await buildRegistryAndFindActive(basePath, milestones, completeMilestoneIds, parkedMilestoneIds);
  const { registry, activeMilestone, activeMilestoneSlices, activeMilestoneHasDraft } = registryContext;
  const milestoneProgress = {
    done: registry.filter((e) => e.status === "complete").length,
    total: registry.length
  };
  if (!activeMilestone) {
    return handleNoActiveMilestone(registry, requirements, milestoneProgress);
  }
  if (activeMilestoneSlices.length === 0) {
    const phase = activeMilestoneHasDraft ? "needs-discussion" : "pre-planning";
    const nextAction = activeMilestoneHasDraft ? `Discuss draft context for milestone ${activeMilestone.id}.` : `Plan milestone ${activeMilestone.id}.`;
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase,
      recentDecisions: [],
      blockers: [],
      nextAction,
      registry,
      requirements,
      progress: { milestones: milestoneProgress }
    };
  }
  const allSlicesDone = activeMilestoneSlices.every((s) => isStatusDone(s.status));
  const sliceProgress = {
    done: activeMilestoneSlices.filter((s) => isStatusDone(s.status)).length,
    total: activeMilestoneSlices.length
  };
  if (allSlicesDone) {
    return handleAllSlicesDone(basePath, activeMilestone, registry, requirements, milestoneProgress, sliceProgress);
  }
  const activeSliceContext = resolveSliceDependencies(activeMilestoneSlices);
  if (!activeSliceContext.activeSlice) {
    const sliceLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_SLICE_LOCK : void 0;
    if (sliceLock) {
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: "blocked",
        recentDecisions: [],
        blockers: [`GSD_SLICE_LOCK=${sliceLock} not found in active milestone slices`],
        nextAction: "Slice lock references a non-existent slice \u2014 check orchestrator dispatch.",
        registry,
        requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress }
      };
    }
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: "blocked",
      recentDecisions: [],
      blockers: ["No slice eligible \u2014 check dependency ordering"],
      nextAction: "Resolve dependency blockers or plan next slice.",
      registry,
      requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress }
    };
  }
  const { activeSlice, activeSliceRow } = activeSliceContext;
  if (activeSliceRow?.is_sketch === 1) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: "refining",
      recentDecisions: [],
      blockers: [],
      nextAction: `Refine sketch slice ${activeSlice.id} (${activeSlice.title}) using prior slice context.`,
      registry,
      requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress }
    };
  }
  const tasks = getSliceTasks(activeMilestone.id, activeSlice.id);
  const taskProgress = {
    done: tasks.filter((t) => isStatusDone(t.status)).length,
    total: tasks.length
  };
  const activeTaskRow = tasks.find((t) => !isStatusDone(t.status));
  if (!activeTaskRow && tasks.length > 0) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: "summarizing",
      recentDecisions: [],
      blockers: [],
      nextAction: `All tasks done in ${activeSlice.id}. Write slice summary and complete slice.`,
      registry,
      requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress }
    };
  }
  if (!activeTaskRow) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: "planning",
      recentDecisions: [],
      blockers: [],
      nextAction: `Slice ${activeSlice.id} has no DB tasks. Plan slice tasks before execution.`,
      registry,
      requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress }
    };
  }
  const activeTask = { id: activeTaskRow.id, title: activeTaskRow.title };
  const pendingGateCount = getPendingGateCountForTurn(
    activeMilestone.id,
    activeSlice.id,
    "gate-evaluate"
  );
  if (pendingGateCount > 0) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: "evaluating-gates",
      recentDecisions: [],
      blockers: [],
      nextAction: `Evaluate ${pendingGateCount} quality gate(s) for ${activeSlice.id} before execution.`,
      registry,
      requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress }
    };
  }
  const blockerTaskId = await detectBlockers(basePath, activeMilestone.id, activeSlice.id, tasks);
  if (blockerTaskId) {
    const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
    if (replanHistory.length === 0) {
      return {
        activeMilestone,
        activeSlice,
        activeTask,
        phase: "replanning-slice",
        recentDecisions: [],
        blockers: [`Task ${blockerTaskId} discovered a blocker requiring slice replan`],
        nextAction: `Task ${blockerTaskId} reported blocker_discovered. Replan slice ${activeSlice.id} before continuing.`,
        activeWorkspace: void 0,
        registry,
        requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress }
      };
    }
  }
  const escalatingTaskId = detectPendingEscalation(tasks, basePath);
  if (escalatingTaskId) {
    return {
      activeMilestone,
      activeSlice,
      activeTask,
      phase: "escalating-task",
      recentDecisions: [],
      blockers: [`Task ${escalatingTaskId} requires a user decision before the loop can proceed`],
      nextAction: `Run /gsd escalate show ${escalatingTaskId} to review, then /gsd escalate resolve ${escalatingTaskId} <choice> to proceed.`,
      activeWorkspace: void 0,
      registry,
      requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress }
    };
  }
  if (!blockerTaskId) {
    const isTriggered = checkReplanTrigger(basePath, activeMilestone.id, activeSlice.id);
    if (isTriggered) {
      const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
      if (replanHistory.length === 0) {
        return {
          activeMilestone,
          activeSlice,
          activeTask,
          phase: "replanning-slice",
          recentDecisions: [],
          blockers: ["Triage replan trigger detected \u2014 slice replan required"],
          nextAction: `Triage replan triggered for slice ${activeSlice.id}. Replan before continuing.`,
          activeWorkspace: void 0,
          registry,
          requirements,
          progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress }
        };
      }
    }
  }
  return {
    activeMilestone,
    activeSlice,
    activeTask,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: `Execute ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}.`,
    registry,
    requirements,
    progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress }
  };
}
async function _deriveStateImpl(basePath, opts) {
  if (opts?.projectRootForReads) {
    basePath = opts.projectRootForReads;
  }
  const diskIds = findMilestoneIds(basePath);
  const customOrder = loadQueueOrder(basePath);
  const milestoneIds = sortByQueueOrder(diskIds, customOrder);
  const milestoneLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_MILESTONE_LOCK : void 0;
  if (milestoneLock && milestoneIds.includes(milestoneLock)) {
    milestoneIds.length = 0;
    milestoneIds.push(milestoneLock);
  }
  const fileContentCache = /* @__PURE__ */ new Map();
  const gsdDir = gsdRoot(basePath);
  const batchFiles = nativeBatchParseGsdFiles(gsdDir);
  if (batchFiles) {
    for (const f of batchFiles) {
      const absPath = resolve(gsdDir, f.path);
      fileContentCache.set(absPath, f.rawContent);
    }
  }
  async function cachedLoadFile(path) {
    const abs = resolve(path);
    const cached = fileContentCache.get(abs);
    if (cached !== void 0) return cached;
    return loadFile(path);
  }
  const requirements = parseRequirementCounts(await cachedLoadFile(resolveGsdRootFile(basePath, "REQUIREMENTS")));
  if (milestoneIds.length === 0) {
    return {
      activeMilestone: null,
      activeSlice: null,
      activeTask: null,
      phase: "pre-planning",
      recentDecisions: [],
      blockers: [],
      nextAction: "No milestones found. Run /gsd to create one.",
      registry: [],
      requirements,
      progress: {
        milestones: { done: 0, total: 0 }
      }
    };
  }
  const roadmapCache = /* @__PURE__ */ new Map();
  const completeMilestoneIds = /* @__PURE__ */ new Set();
  const parkedMilestoneIds = /* @__PURE__ */ new Set();
  for (const mid of milestoneIds) {
    const parkedFile = resolveMilestoneFile(basePath, mid, "PARKED");
    if (parkedFile) {
      parkedMilestoneIds.add(mid);
      const prf = resolveMilestoneFile(basePath, mid, "ROADMAP");
      const prc = prf ? await cachedLoadFile(prf) : null;
      if (prc) roadmapCache.set(mid, parseRoadmap(prc));
      continue;
    }
    const rf = resolveMilestoneFile(basePath, mid, "ROADMAP");
    const rc = rf ? await cachedLoadFile(rf) : null;
    if (!rc) {
      const sf2 = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (sf2 && await isTerminalMilestoneSummaryFile(sf2, cachedLoadFile)) completeMilestoneIds.add(mid);
      continue;
    }
    const rmap = parseRoadmap(rc);
    roadmapCache.set(mid, rmap);
    if (!isMilestoneComplete(rmap)) {
      const sf2 = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (sf2 && await isTerminalMilestoneSummaryFile(sf2, cachedLoadFile)) completeMilestoneIds.add(mid);
      continue;
    }
    const sf = resolveMilestoneFile(basePath, mid, "SUMMARY");
    if (sf && await isTerminalMilestoneSummaryFile(sf, cachedLoadFile)) completeMilestoneIds.add(mid);
  }
  const registry = [];
  let activeMilestone = null;
  let activeRoadmap = null;
  let activeMilestoneFound = false;
  let activeMilestoneHasDraft = false;
  for (const mid of milestoneIds) {
    if (parkedMilestoneIds.has(mid)) {
      const roadmap2 = roadmapCache.get(mid) ?? null;
      const title2 = roadmap2 ? stripMilestonePrefix(roadmap2.title) : mid;
      registry.push({ id: mid, title: title2, status: "parked" });
      continue;
    }
    const roadmap = roadmapCache.get(mid) ?? null;
    if (!roadmap) {
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile) {
        const summaryContent = await cachedLoadFile(summaryFile);
        if (summaryContent != null && isTerminalMilestoneSummaryContent(summaryContent)) {
          const summaryTitle = summaryContent ? parseSummary(summaryContent).title || mid : mid;
          registry.push({ id: mid, title: summaryTitle, status: "complete" });
          completeMilestoneIds.add(mid);
          continue;
        }
      }
      if (isGhostMilestone(basePath, mid)) continue;
      if (!activeMilestoneFound) {
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        if (!contextFile && draftFile) activeMilestoneHasDraft = true;
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const draftContent = draftFile && !contextContent ? await cachedLoadFile(draftFile) : null;
        const title2 = extractContextTitle(contextContent || draftContent, mid);
        const deps = parseContextDependsOn(contextContent ?? draftContent);
        const depsUnmet = deps.some((dep) => !completeMilestoneIds.has(dep));
        if (depsUnmet) {
          registry.push({ id: mid, title: title2, status: "pending", dependsOn: deps });
        } else {
          activeMilestone = { id: mid, title: title2 };
          activeMilestoneFound = true;
          registry.push({ id: mid, title: title2, status: "active", ...deps.length > 0 ? { dependsOn: deps } : {} });
        }
      } else {
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const draftContent = draftFile && !contextContent ? await cachedLoadFile(draftFile) : null;
        const title2 = extractContextTitle(contextContent || draftContent, mid);
        registry.push({ id: mid, title: title2, status: "pending" });
      }
      continue;
    }
    const title = stripMilestonePrefix(roadmap.title);
    const complete = isMilestoneComplete(roadmap);
    if (complete) {
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      const validationFile = resolveMilestoneFile(basePath, mid, "VALIDATION");
      const validationContent = validationFile ? await cachedLoadFile(validationFile) : null;
      const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;
      const verdict = validationContent ? extractVerdict(validationContent) : void 0;
      const needsRevalidation = !validationTerminal || verdict === "needs-remediation";
      if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, cachedLoadFile)) {
        registry.push({ id: mid, title, status: "complete" });
      } else if (needsRevalidation && !activeMilestoneFound) {
        activeMilestone = { id: mid, title };
        activeRoadmap = roadmap;
        activeMilestoneFound = true;
        registry.push({ id: mid, title, status: "active" });
      } else if (needsRevalidation && activeMilestoneFound) {
        registry.push({ id: mid, title, status: "pending" });
      } else if (!activeMilestoneFound) {
        activeMilestone = { id: mid, title };
        activeRoadmap = roadmap;
        activeMilestoneFound = true;
        registry.push({ id: mid, title, status: "active" });
      } else {
        registry.push({ id: mid, title, status: "complete" });
      }
    } else {
      const summaryFile = resolveMilestoneFile(basePath, mid, "SUMMARY");
      if (summaryFile && await isTerminalMilestoneSummaryFile(summaryFile, cachedLoadFile)) {
        registry.push({ id: mid, title, status: "complete" });
      } else if (!activeMilestoneFound) {
        const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFile = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        const contextContent = contextFile ? await cachedLoadFile(contextFile) : null;
        const draftContent = draftFile && !contextContent ? await cachedLoadFile(draftFile) : null;
        const deps = parseContextDependsOn(contextContent ?? draftContent);
        const depsUnmet = deps.some((dep) => !completeMilestoneIds.has(dep));
        if (depsUnmet) {
          registry.push({ id: mid, title, status: "pending", dependsOn: deps });
        } else {
          activeMilestone = { id: mid, title };
          activeRoadmap = roadmap;
          activeMilestoneFound = true;
          registry.push({ id: mid, title, status: "active", ...deps.length > 0 ? { dependsOn: deps } : {} });
        }
      } else {
        const contextFile2 = resolveMilestoneFile(basePath, mid, "CONTEXT");
        const draftFileForDeps3 = resolveMilestoneFile(basePath, mid, "CONTEXT-DRAFT");
        const contextOrDraftContent3 = contextFile2 ? await cachedLoadFile(contextFile2) : draftFileForDeps3 ? await cachedLoadFile(draftFileForDeps3) : null;
        const deps2 = parseContextDependsOn(contextOrDraftContent3);
        registry.push({ id: mid, title, status: "pending", ...deps2.length > 0 ? { dependsOn: deps2 } : {} });
      }
    }
  }
  const milestoneProgress = {
    done: registry.filter((entry) => entry.status === "complete").length,
    total: registry.length
  };
  if (!activeMilestone) {
    const pendingEntries = registry.filter((entry) => entry.status === "pending");
    const parkedEntries = registry.filter((entry) => entry.status === "parked");
    if (pendingEntries.length > 0) {
      const blockerDetails = pendingEntries.filter((entry) => entry.dependsOn && entry.dependsOn.length > 0).map((entry) => `${entry.id} is waiting on unmet deps: ${entry.dependsOn.join(", ")}`);
      return {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: "blocked",
        recentDecisions: [],
        blockers: blockerDetails.length > 0 ? blockerDetails : ["All remaining milestones are dep-blocked but no deps listed \u2014 check CONTEXT.md files"],
        nextAction: "Resolve milestone dependencies before proceeding.",
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress
        }
      };
    }
    if (parkedEntries.length > 0) {
      const parkedIds = parkedEntries.map((e) => e.id).join(", ");
      return {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: "pre-planning",
        recentDecisions: [],
        blockers: [],
        nextAction: `All remaining milestones are parked (${parkedIds}). Run /gsd unpark <id> or create a new milestone.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress
        }
      };
    }
    if (registry.length === 0) {
      return {
        activeMilestone: null,
        activeSlice: null,
        activeTask: null,
        phase: "pre-planning",
        recentDecisions: [],
        blockers: [],
        nextAction: "No milestones found. Run /gsd to create one.",
        registry: [],
        requirements,
        progress: {
          milestones: { done: 0, total: 0 }
        }
      };
    }
    const lastEntry = registry[registry.length - 1];
    const activeReqs = requirements.active ?? 0;
    const completionNote = activeReqs > 0 ? `All milestones complete. ${activeReqs} active requirement${activeReqs === 1 ? "" : "s"} in REQUIREMENTS.md ${activeReqs === 1 ? "has" : "have"} not been mapped to a milestone.` : "All milestones complete.";
    return {
      activeMilestone: null,
      lastCompletedMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
      activeSlice: null,
      activeTask: null,
      phase: "complete",
      recentDecisions: [],
      blockers: [],
      nextAction: completionNote,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress
      }
    };
  }
  if (!activeRoadmap) {
    const phase = activeMilestoneHasDraft ? "needs-discussion" : "pre-planning";
    const nextAction = activeMilestoneHasDraft ? `Discuss draft context for milestone ${activeMilestone.id}.` : `Plan milestone ${activeMilestone.id}.`;
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase,
      recentDecisions: [],
      blockers: [],
      nextAction,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress
      }
    };
  }
  if (activeRoadmap.slices.length === 0) {
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: "pre-planning",
      recentDecisions: [],
      blockers: [],
      nextAction: `Milestone ${activeMilestone.id} has a roadmap but no slices defined. Add slices to the roadmap.`,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: { done: 0, total: 0 }
      }
    };
  }
  if (isMilestoneComplete(activeRoadmap)) {
    const validationFile = resolveMilestoneFile(basePath, activeMilestone.id, "VALIDATION");
    const validationContent = validationFile ? await cachedLoadFile(validationFile) : null;
    const validationTerminal = validationContent ? isValidationTerminal(validationContent) : false;
    const verdict = validationContent ? extractVerdict(validationContent) : void 0;
    const sliceProgress2 = {
      done: activeRoadmap.slices.length,
      total: activeRoadmap.slices.length
    };
    if (!validationTerminal) {
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: "validating-milestone",
        recentDecisions: [],
        blockers: [],
        nextAction: `Validate milestone ${activeMilestone.id} before completion.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress2
        }
      };
    }
    if (verdict === "needs-remediation") {
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: "blocked",
        recentDecisions: [],
        blockers: [
          `Milestone ${activeMilestone.id} validation verdict is needs-remediation but all slices are complete. Add remediation slices via gsd_reassess_roadmap or override the verdict manually.`
        ],
        nextAction: `Resolve ${activeMilestone.id} remediation before proceeding.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress2
        }
      };
    }
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: "completing-milestone",
      recentDecisions: [],
      blockers: [],
      nextAction: `All slices complete in ${activeMilestone.id}. Write milestone summary.`,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress2
      }
    };
  }
  const sliceProgress = {
    done: activeRoadmap.slices.filter((s) => s.done).length,
    total: activeRoadmap.slices.length
  };
  const doneSliceIds = new Set(activeRoadmap.slices.filter((s) => s.done).map((s) => s.id));
  let activeSlice = null;
  const sliceLockLegacy = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_SLICE_LOCK : void 0;
  if (sliceLockLegacy) {
    const lockedSlice = activeRoadmap.slices.find((s) => s.id === sliceLockLegacy);
    if (lockedSlice) {
      activeSlice = { id: lockedSlice.id, title: lockedSlice.title };
    } else {
      logWarning("state", `GSD_SLICE_LOCK=${sliceLockLegacy} not found in active slices \u2014 worker has no assigned work`);
      return {
        activeMilestone,
        activeSlice: null,
        activeTask: null,
        phase: "blocked",
        recentDecisions: [],
        blockers: [`GSD_SLICE_LOCK=${sliceLockLegacy} not found in active milestone slices`],
        nextAction: "Slice lock references a non-existent slice \u2014 check orchestrator dispatch.",
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress
        }
      };
    }
  } else {
    for (const s of activeRoadmap.slices) {
      if (s.done) continue;
      if (s.depends.every((dep) => doneSliceIds.has(dep))) {
        activeSlice = { id: s.id, title: s.title };
        break;
      }
    }
  }
  if (!activeSlice) {
    return {
      activeMilestone,
      activeSlice: null,
      activeTask: null,
      phase: "blocked",
      recentDecisions: [],
      blockers: ["No slice eligible \u2014 check dependency ordering"],
      nextAction: "Resolve dependency blockers or plan next slice.",
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress
      }
    };
  }
  const planFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "PLAN");
  const slicePlanContent = planFile ? await cachedLoadFile(planFile) : null;
  if (!slicePlanContent) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: "planning",
      recentDecisions: [],
      blockers: [],
      nextAction: `Plan slice ${activeSlice.id} (${activeSlice.title}).`,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress
      }
    };
  }
  const slicePlan = parsePlan(slicePlanContent);
  for (const t of slicePlan.tasks) {
    if (t.done) continue;
    const summaryPath = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, t.id, "SUMMARY");
    if (summaryPath && existsSync(summaryPath)) {
      t.done = true;
      logWarning("reconcile", `task ${activeMilestone.id}/${activeSlice.id}/${t.id} reconciled via SUMMARY on disk (#2514)`, { mid: activeMilestone.id, sid: activeSlice.id, tid: t.id });
    }
  }
  const taskProgress = {
    done: slicePlan.tasks.filter((t) => t.done).length,
    total: slicePlan.tasks.length
  };
  const activeTaskEntry = slicePlan.tasks.find((t) => !t.done);
  if (!activeTaskEntry && slicePlan.tasks.length > 0) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: "summarizing",
      recentDecisions: [],
      blockers: [],
      nextAction: `All tasks done in ${activeSlice.id}. Write slice summary and complete slice.`,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
        tasks: taskProgress
      }
    };
  }
  if (!activeTaskEntry) {
    return {
      activeMilestone,
      activeSlice,
      activeTask: null,
      phase: "planning",
      recentDecisions: [],
      blockers: [],
      nextAction: `Slice ${activeSlice.id} has a plan file but no tasks. Add tasks to the plan.`,
      registry,
      requirements,
      progress: {
        milestones: milestoneProgress,
        slices: sliceProgress,
        tasks: taskProgress
      }
    };
  }
  const activeTask = {
    id: activeTaskEntry.id,
    title: activeTaskEntry.title
  };
  const tasksDir = resolveTasksDir(basePath, activeMilestone.id, activeSlice.id);
  if (tasksDir && existsSync(tasksDir) && slicePlan.tasks.length > 0) {
    const allFiles = readdirSync(tasksDir).filter((f) => f.endsWith(".md"));
    if (allFiles.length === 0) {
      return {
        activeMilestone,
        activeSlice,
        activeTask: null,
        phase: "planning",
        recentDecisions: [],
        blockers: [],
        nextAction: `Task plan files missing for ${activeSlice.id}. Run plan-slice to generate task plans.`,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
          tasks: taskProgress
        }
      };
    }
  }
  const completedTasks = slicePlan.tasks.filter((t) => t.done);
  let blockerTaskId = null;
  for (const ct of completedTasks) {
    const summaryFile = resolveTaskFile(basePath, activeMilestone.id, activeSlice.id, ct.id, "SUMMARY");
    if (!summaryFile) continue;
    const summaryContent = await cachedLoadFile(summaryFile);
    if (!summaryContent) continue;
    const summary = parseSummary(summaryContent);
    if (summary.frontmatter.blocker_discovered) {
      blockerTaskId = ct.id;
      break;
    }
  }
  if (blockerTaskId) {
    const replanFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN");
    if (!replanFile) {
      return {
        activeMilestone,
        activeSlice,
        activeTask,
        phase: "replanning-slice",
        recentDecisions: [],
        blockers: [`Task ${blockerTaskId} discovered a blocker requiring slice replan`],
        nextAction: `Task ${blockerTaskId} reported blocker_discovered. Replan slice ${activeSlice.id} before continuing.`,
        activeWorkspace: void 0,
        registry,
        requirements,
        progress: {
          milestones: milestoneProgress,
          slices: sliceProgress,
          tasks: taskProgress
        }
      };
    }
  }
  if (!blockerTaskId) {
    const replanTriggerFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN-TRIGGER");
    if (replanTriggerFile) {
      const replanFile = resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "REPLAN");
      if (!replanFile) {
        return {
          activeMilestone,
          activeSlice,
          activeTask,
          phase: "replanning-slice",
          recentDecisions: [],
          blockers: ["Triage replan trigger detected \u2014 slice replan required"],
          nextAction: `Triage replan triggered for slice ${activeSlice.id}. Replan before continuing.`,
          activeWorkspace: void 0,
          registry,
          requirements,
          progress: {
            milestones: milestoneProgress,
            slices: sliceProgress,
            tasks: taskProgress
          }
        };
      }
    }
  }
  const sDir = resolveSlicePath(basePath, activeMilestone.id, activeSlice.id);
  const continueFile = sDir ? resolveSliceFile(basePath, activeMilestone.id, activeSlice.id, "CONTINUE") : null;
  const hasInterrupted = !!(continueFile && await cachedLoadFile(continueFile)) || !!(sDir && await cachedLoadFile(join(sDir, "continue.md")));
  return {
    activeMilestone,
    activeSlice,
    activeTask,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: hasInterrupted ? `Resume interrupted work on ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}. Read continue.md first.` : `Execute ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}.`,
    registry,
    requirements,
    progress: {
      milestones: milestoneProgress,
      slices: sliceProgress,
      tasks: taskProgress
    }
  };
}
export {
  _deriveStateImpl,
  deriveState,
  deriveStateFromDb,
  getActiveMilestoneId,
  getDeriveTelemetry,
  invalidateStateCache,
  isGhostMilestone,
  isMilestoneComplete,
  isReusableGhostMilestone,
  isSliceComplete,
  isValidationTerminal,
  resetDeriveTelemetry
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9zdGF0ZS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IFJ1bnRpbWUgc3RhdGUgZGVyaXZhdGlvbiBmcm9tIEdTRCB3b3JrZmxvdyBkYXRhYmFzZSBhbmQgbGVnYWN5IGZpbGVzLlxuLy8gR1NEIEV4dGVuc2lvbiBcdTIwMTQgU3RhdGUgRGVyaXZhdGlvblxuLy8gREItYXV0aG9yaXRhdGl2ZSBydW50aW1lIGRlcml2YXRpb24gd2l0aCBleHBsaWNpdCBsZWdhY3kgZmlsZXN5c3RlbSBmYWxsYmFjay5cbi8vIFB1cmUgVHlwZVNjcmlwdCwgemVybyBQaSBkZXBlbmRlbmNpZXMuXG5cbmltcG9ydCB0eXBlIHtcbiAgR1NEU3RhdGUsXG4gIEFjdGl2ZVJlZixcbiAgUm9hZG1hcCxcbiAgUm9hZG1hcFNsaWNlRW50cnksXG4gIFNsaWNlUGxhbixcbiAgTWlsZXN0b25lUmVnaXN0cnlFbnRyeSxcbn0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbmltcG9ydCB7XG4gIHBhcnNlUm9hZG1hcCxcbiAgcGFyc2VQbGFuLFxufSBmcm9tICcuL3BhcnNlcnMtbGVnYWN5LmpzJztcblxuaW1wb3J0IHtcbiAgcGFyc2VTdW1tYXJ5LFxuICBsb2FkRmlsZSxcbiAgcGFyc2VSZXF1aXJlbWVudENvdW50cyxcbiAgcGFyc2VDb250ZXh0RGVwZW5kc09uLFxufSBmcm9tICcuL2ZpbGVzLmpzJztcblxuaW1wb3J0IHtcbiAgcmVzb2x2ZU1pbGVzdG9uZVBhdGgsXG4gIHJlc29sdmVNaWxlc3RvbmVGaWxlLFxuICByZXNvbHZlU2xpY2VQYXRoLFxuICByZXNvbHZlU2xpY2VGaWxlLFxuICByZXNvbHZlVGFza0ZpbGUsXG4gIHJlc29sdmVUYXNrc0RpcixcbiAgcmVzb2x2ZUdzZFJvb3RGaWxlLFxuICBnc2RSb290LFxufSBmcm9tICcuL3BhdGhzLmpzJztcblxuaW1wb3J0IHsgZmluZE1pbGVzdG9uZUlkcyB9IGZyb20gJy4vbWlsZXN0b25lLWlkcy5qcyc7XG5pbXBvcnQgeyBsb2FkUXVldWVPcmRlciwgc29ydEJ5UXVldWVPcmRlciB9IGZyb20gJy4vcXVldWUtb3JkZXIuanMnO1xuaW1wb3J0IHsgaXNDbG9zZWRTdGF0dXMsIGlzRGVmZXJyZWRTdGF0dXMgfSBmcm9tICcuL3N0YXR1cy1ndWFyZHMuanMnO1xuaW1wb3J0IHsgbmF0aXZlQmF0Y2hQYXJzZUdzZEZpbGVzLCB0eXBlIEJhdGNoUGFyc2VkRmlsZSB9IGZyb20gJy4vbmF0aXZlLXBhcnNlci1icmlkZ2UuanMnO1xuXG5pbXBvcnQgeyBqb2luLCByZXNvbHZlIH0gZnJvbSAncGF0aCc7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkZGlyU3luYyB9IGZyb20gJ25vZGU6ZnMnO1xuaW1wb3J0IHsgZGVidWdDb3VudCwgZGVidWdUaW1lIH0gZnJvbSAnLi9kZWJ1Zy1sb2dnZXIuanMnO1xuaW1wb3J0IHsgbG9nV2FybmluZyB9IGZyb20gJy4vd29ya2Zsb3ctbG9nZ2VyLmpzJztcbmltcG9ydCB7IGV4dHJhY3RWZXJkaWN0IH0gZnJvbSAnLi92ZXJkaWN0LXBhcnNlci5qcyc7XG5pbXBvcnQgeyBkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbiB9IGZyb20gJy4vZXNjYWxhdGlvbi5qcyc7XG5pbXBvcnQgeyBpc1Rlcm1pbmFsTWlsZXN0b25lU3VtbWFyeUNvbnRlbnQgfSBmcm9tICcuL21pbGVzdG9uZS1zdW1tYXJ5LWNsYXNzaWZpZXIuanMnO1xuaW1wb3J0IHsgaW5jcmVtZW50TGVnYWN5VGVsZW1ldHJ5IH0gZnJvbSAnLi9sZWdhY3ktdGVsZW1ldHJ5LmpzJztcblxuaW1wb3J0IHtcbiAgaXNEYkF2YWlsYWJsZSxcbiAgd2FzRGJPcGVuQXR0ZW1wdGVkLFxuICBnZXRBbGxNaWxlc3RvbmVzLFxuICBnZXRNaWxlc3RvbmUsXG4gIGdldE1pbGVzdG9uZVNsaWNlcyxcbiAgZ2V0U2xpY2VUYXNrcyxcbiAgZ2V0UmVwbGFuSGlzdG9yeSxcbiAgZ2V0U2xpY2UsXG4gIGdldFJlcXVpcmVtZW50Q291bnRzLFxuICBnZXRMYXRlc3RBc3Nlc3NtZW50QnlTY29wZSxcbiAgZ2V0UGVuZGluZ0dhdGVDb3VudEZvclR1cm4sXG59IGZyb20gJy4vZ3NkLWRiLmpzJztcbmltcG9ydCB0eXBlIHsgTWlsZXN0b25lUm93IH0gZnJvbSAnLi9kYi1taWxlc3RvbmUtYXJ0aWZhY3Qtcm93cy5qcyc7XG5pbXBvcnQgdHlwZSB7IFNsaWNlUm93LCBUYXNrUm93IH0gZnJvbSAnLi9kYi10YXNrLXNsaWNlLXJvd3MuanMnO1xuXG4vKipcbiAqIEEgXCJnaG9zdFwiIG1pbGVzdG9uZSBkaXJlY3RvcnkgY29udGFpbnMgb25seSBNRVRBLmpzb24gKGFuZCBubyBzdWJzdGFudGl2ZVxuICogZmlsZXMgbGlrZSBDT05URVhULCBDT05URVhULURSQUZULCBST0FETUFQLCBvciBTVU1NQVJZKS4gIFRoZXNlIGFwcGVhciB3aGVuXG4gKiBhIG1pbGVzdG9uZSBpcyBjcmVhdGVkIGJ1dCBuZXZlciBpbml0aWFsaXNlZC4gIFRyZWF0aW5nIHRoZW0gYXMgYWN0aXZlIGNhdXNlc1xuICogYXV0by1tb2RlIHRvIHN0YWxsIG9yIGZhbHNlbHkgZGVjbGFyZSBjb21wbGV0aW9uLlxuICpcbiAqIEhvd2V2ZXIsIGEgbWlsZXN0b25lIGlzIE5PVCBhIGdob3N0IGlmOlxuICogLSBJdCBoYXMgYSBEQiByb3cgd2l0aCBhIG1lYW5pbmdmdWwgc3RhdHVzIChxdWV1ZWQsIGFjdGl2ZSwgZXRjLikgXHUyMDE0IHRoZSBEQlxuICogICBrbm93cyBhYm91dCBpdCBldmVuIGlmIGNvbnRlbnQgZmlsZXMgaGF2ZW4ndCBiZWVuIGNyZWF0ZWQgeWV0LlxuICogLSBJdCBoYXMgYSB3b3JrdHJlZSBkaXJlY3RvcnkgXHUyMDE0IGEgd29ya3RyZWUgcHJvdmVzIHRoZSBtaWxlc3RvbmUgd2FzXG4gKiAgIGxlZ2l0aW1hdGVseSBjcmVhdGVkIGFuZCBpcyBleHBlY3RlZCB0byBiZSBwb3B1bGF0ZWQuXG4gKlxuICogRml4ZXMgIzI5MjE6IHF1ZXVlZCBtaWxlc3RvbmVzIHdpdGggd29ya3RyZWVzIHdlcmUgaW5jb3JyZWN0bHkgY2xhc3NpZmllZFxuICogYXMgZ2hvc3RzLCBjYXVzaW5nIGF1dG8tbW9kZSB0byBza2lwIHRoZW0gZW50aXJlbHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0dob3N0TWlsZXN0b25lKGJhc2VQYXRoOiBzdHJpbmcsIG1pZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIC8vIElmIHRoZSBtaWxlc3RvbmUgaGFzIGEgREIgcm93LCBpdCdzIHVzdWFsbHkgYSBrbm93biBtaWxlc3RvbmUgXHUyMDE0IG5vdCBhIGdob3N0LlxuICAvLyBFeGNlcHRpb246IGEgXCJxdWV1ZWRcIiByb3cgd2l0aCBubyBkaXNrIGFydGlmYWN0cyBpcyBhIHBoYW50b20gZnJvbVxuICAvLyBnc2RfbWlsZXN0b25lX2dlbmVyYXRlX2lkIHRoYXQgd2FzIG5ldmVyIHBsYW5uZWQgKCMzNjQ1KS5cbiAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgIGNvbnN0IGRiUm93ID0gZ2V0TWlsZXN0b25lKG1pZCk7XG4gICAgaWYgKGRiUm93KSB7XG4gICAgICBpZiAoZGJSb3cuc3RhdHVzID09PSAncXVldWVkJykge1xuICAgICAgICBjb25zdCBoYXNDb250ZW50ID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJDT05URVhUXCIpXG4gICAgICAgICAgfHwgcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJST0FETUFQXCIpXG4gICAgICAgICAgfHwgcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJTVU1NQVJZXCIpO1xuICAgICAgICByZXR1cm4gIWhhc0NvbnRlbnQ7XG4gICAgICB9XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLy8gSWYgYSB3b3JrdHJlZSBleGlzdHMgZm9yIHRoaXMgbWlsZXN0b25lLCBpdCB3YXMgbGVnaXRpbWF0ZWx5IGNyZWF0ZWQuXG4gIGNvbnN0IHJvb3QgPSBnc2RSb290KGJhc2VQYXRoKTtcbiAgY29uc3Qgd3RQYXRoID0gam9pbihyb290LCAnd29ya3RyZWVzJywgbWlkKTtcbiAgaWYgKGV4aXN0c1N5bmMod3RQYXRoKSkgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIEZhbGwgYmFjayB0byBjb250ZW50LWZpbGUgY2hlY2s6IG5vIHN1YnN0YW50aXZlIGZpbGVzIG1lYW5zIGdob3N0LlxuICBjb25zdCBjb250ZXh0ICAgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIkNPTlRFWFRcIik7XG4gIGNvbnN0IGRyYWZ0ICAgICA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiQ09OVEVYVC1EUkFGVFwiKTtcbiAgY29uc3Qgcm9hZG1hcCAgID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJST0FETUFQXCIpO1xuICBjb25zdCBzdW1tYXJ5ICAgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIlNVTU1BUllcIik7XG4gIHJldHVybiAhY29udGV4dCAmJiAhZHJhZnQgJiYgIXJvYWRtYXAgJiYgIXN1bW1hcnk7XG59XG5cbi8qKlxuICogQSBcInJldXNhYmxlIGdob3N0XCIgbWlsZXN0b25lIGlzIGFuIG9ycGhhbmVkIGZpbGVzeXN0ZW0gc3R1YiB0aGF0IGlzIHNhZmVcbiAqIHRvIHJlY2xhaW0gYXMgdGhlIG5leHQgbWlsZXN0b25lIElELlxuICpcbiAqIFN0cmljdGVyIHRoYW4gYGlzR2hvc3RNaWxlc3RvbmVgOiByZXR1cm5zIHRydWUgT05MWSB3aGVuIEFMTCBvZiB0aGVcbiAqIGZvbGxvd2luZyBob2xkOlxuICogICAxLiBObyBEQiByb3cgZXhpc3RzIGZvciBgbWlkYCAoYW55IHN0YXR1cywgaW5jbHVkaW5nIFwicXVldWVkXCIpIFx1MjAxNCBhIERCIHJvd1xuICogICAgICBtZWFucyB0aGUgbWlsZXN0b25lIHdhcyBpbnRlbnRpb25hbGx5IHJlZ2lzdGVyZWQgYnlcbiAqICAgICAgYGdzZF9taWxlc3RvbmVfZ2VuZXJhdGVfaWRgIGFuZCBtYXkgaGF2ZSBhbiBpbi1mbGlnaHQgZGlzY3VzcyBmbG93LlxuICogICAgICBSZXVzaW5nIGl0IHdvdWxkIGNvbGxpZGUgd2l0aCB0aGF0IGZsb3cuICgjNDk5NiByYWNlIHdpbmRvdylcbiAqICAgMi4gTm8gd29ya3RyZWUgZGlyZWN0b3J5IGV4aXN0cyBhdCBgZ3NkUm9vdC93b3JrdHJlZXMve21pZH1gIFx1MjAxNCBhIHdvcmt0cmVlXG4gKiAgICAgIG1lYW5zIHRoZSBtaWxlc3RvbmUgaXMgbGVnaXRpbWF0ZWx5IGluLWZsaWdodC5cbiAqICAgMy4gTm8gY29udGVudCBmaWxlcyBleGlzdCAoQ09OVEVYVCwgQ09OVEVYVC1EUkFGVCwgUk9BRE1BUCwgU1VNTUFSWSkgXHUyMDE0XG4gKiAgICAgIGFueSBjb250ZW50IG1lYW5zIHRoZSBkaXNjdXNzIGZsb3cgYWxyZWFkeSByYW4uXG4gKlxuICogVGhlIGxvb3NlciBgaXNHaG9zdE1pbGVzdG9uZWAgYWxzbyBjbGFzc2lmaWVzIHF1ZXVlZC1yb3ctd2l0aG91dC1jb250ZW50IGFzXG4gKiBhIGdob3N0IHRvIGhlbHAgc3RhdGUgcXVlcmllcyBmaWx0ZXIgcGhhbnRvbXMuIGBpc1JldXNhYmxlR2hvc3RNaWxlc3RvbmVgXG4gKiBpbnRlbnRpb25hbGx5IGRvZXMgTk9UIHJlY2xhaW0gdGhvc2UgXHUyMDE0IGEgcXVldWVkIHJvdyBpcyBzdWZmaWNpZW50IHByb29mIG9mXG4gKiBhIGxpdmUgaW4tZmxpZ2h0IElEIHJlc2VydmF0aW9uLlxuICpcbiAqIFVzZWQgYnkgYG5leHRNaWxlc3RvbmVJZFJlc2VydmVkYCBhbmQgYm90aCBNQ1AgSUQtZ2VuZXJhdG9yIHRvb2xzIHRvIGZpbGxcbiAqIGdhcHMgbGVmdCBieSBwaGFudG9tIGRpcmVjdG9yaWVzIGJlZm9yZSByZXNvcnRpbmcgdG8gbWF4KzEuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1JldXNhYmxlR2hvc3RNaWxlc3RvbmUoYmFzZVBhdGg6IHN0cmluZywgbWlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgLy8gQ29uZGl0aW9uIDE6IG5vIERCIHJvdyAoYW55IHN0YXR1cykuXG4gIGlmICghaXNEYkF2YWlsYWJsZSgpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGRiUm93ID0gZ2V0TWlsZXN0b25lKG1pZCk7XG4gIGlmIChkYlJvdyAhPSBudWxsKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gQ29uZGl0aW9uIDI6IG5vIHdvcmt0cmVlLlxuICBjb25zdCByb290ID0gZ3NkUm9vdChiYXNlUGF0aCk7XG4gIGNvbnN0IHd0UGF0aCA9IGpvaW4ocm9vdCwgJ3dvcmt0cmVlcycsIG1pZCk7XG4gIGlmIChleGlzdHNTeW5jKHd0UGF0aCkpIHJldHVybiBmYWxzZTtcblxuICAvLyBDb25kaXRpb24gMzogbm8gY29udGVudCBmaWxlcy5cbiAgY29uc3QgY29udGV4dCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiQ09OVEVYVFwiKTtcbiAgY29uc3QgZHJhZnQgICA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiQ09OVEVYVC1EUkFGVFwiKTtcbiAgY29uc3Qgcm9hZG1hcCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiUk9BRE1BUFwiKTtcbiAgY29uc3Qgc3VtbWFyeSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiU1VNTUFSWVwiKTtcbiAgcmV0dXJuICFjb250ZXh0ICYmICFkcmFmdCAmJiAhcm9hZG1hcCAmJiAhc3VtbWFyeTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFF1ZXJ5IEZ1bmN0aW9ucyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBDaGVjayBpZiBhbGwgdGFza3MgaW4gYSBzbGljZSBwbGFuIGFyZSBkb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTbGljZUNvbXBsZXRlKHBsYW46IFNsaWNlUGxhbik6IGJvb2xlYW4ge1xuICByZXR1cm4gcGxhbi50YXNrcy5sZW5ndGggPiAwICYmIHBsYW4udGFza3MuZXZlcnkodCA9PiB0LmRvbmUpO1xufVxuXG4vKipcbiAqIENoZWNrIGlmIGFsbCBzbGljZXMgaW4gYSByb2FkbWFwIGFyZSBkb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNNaWxlc3RvbmVDb21wbGV0ZShyb2FkbWFwOiBSb2FkbWFwKTogYm9vbGVhbiB7XG4gIHJldHVybiByb2FkbWFwLnNsaWNlcy5sZW5ndGggPiAwICYmIHJvYWRtYXAuc2xpY2VzLmV2ZXJ5KHMgPT4gcy5kb25lKTtcbn1cblxuLyoqXG4gKiBDaGVjayB3aGV0aGVyIGEgVkFMSURBVElPTiBmaWxlJ3MgdmVyZGljdCBpcyB0ZXJtaW5hbC5cbiAqIEFueSBzdWNjZXNzZnVsbHkgZXh0cmFjdGVkIHZlcmRpY3QgKHBhc3MsIG5lZWRzLWF0dGVudGlvbiwgbmVlZHMtcmVtZWRpYXRpb24sXG4gKiBmYWlsLCBldGMuKSBtZWFucyB2YWxpZGF0aW9uIGNvbXBsZXRlZC4gT25seSByZXR1cm4gZmFsc2Ugd2hlbiBubyB2ZXJkaWN0XG4gKiBjb3VsZCBiZSBwYXJzZWQgXHUyMDE0IGkuZS4gZXh0cmFjdFZlcmRpY3QoKSByZXR1cm5zIHVuZGVmaW5lZCAoIzI3NjkpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNWYWxpZGF0aW9uVGVybWluYWwodmFsaWRhdGlvbkNvbnRlbnQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gZXh0cmFjdFZlcmRpY3QodmFsaWRhdGlvbkNvbnRlbnQpICE9IG51bGw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGlzVGVybWluYWxNaWxlc3RvbmVTdW1tYXJ5RmlsZShcbiAgcGF0aDogc3RyaW5nLFxuICBsb2FkZXI6IChwYXRoOiBzdHJpbmcpID0+IFByb21pc2U8c3RyaW5nIHwgbnVsbD4sXG4pOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgY29udGVudCA9IGF3YWl0IGxvYWRlcihwYXRoKTtcbiAgcmV0dXJuIGNvbnRlbnQgIT0gbnVsbCAmJiBpc1Rlcm1pbmFsTWlsZXN0b25lU3VtbWFyeUNvbnRlbnQoY29udGVudCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBTdGF0ZSBEZXJpdmF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vLyBcdTI1MDBcdTI1MDAgZGVyaXZlU3RhdGUgbWVtb2l6YXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBDYWNoZSB0aGUgbW9zdCByZWNlbnQgZGVyaXZlU3RhdGUoKSByZXN1bHQga2V5ZWQgYnkgYmFzZVBhdGguIFdpdGhpbiBhIHNpbmdsZVxuLy8gZGlzcGF0Y2ggY3ljbGUgKH4xMDBtcyB3aW5kb3cpLCByZXBlYXRlZCBjYWxscyByZXR1cm4gdGhlIGNhY2hlZCB2YWx1ZSBpbnN0ZWFkXG4vLyBvZiByZS1yZWFkaW5nIHRoZSBlbnRpcmUgLmdzZC8gdHJlZSBmcm9tIGRpc2suXG5cbmludGVyZmFjZSBTdGF0ZUNhY2hlIHtcbiAgYmFzZVBhdGg6IHN0cmluZztcbiAgcmVzdWx0OiBHU0RTdGF0ZTtcbiAgdGltZXN0YW1wOiBudW1iZXI7XG59XG5cbmNvbnN0IENBQ0hFX1RUTF9NUyA9IDEwMDtcbmxldCBfc3RhdGVDYWNoZTogU3RhdGVDYWNoZSB8IG51bGwgPSBudWxsO1xuXG4vLyBcdTI1MDBcdTI1MDAgVGVsZW1ldHJ5IGNvdW50ZXJzIGZvciBkZXJpdmUtcGF0aCBvYnNlcnZhYmlsaXR5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxubGV0IF90ZWxlbWV0cnkgPSB7IGRiRGVyaXZlQ291bnQ6IDAsIG1hcmtkb3duRGVyaXZlQ291bnQ6IDAgfTtcbmV4cG9ydCBmdW5jdGlvbiBnZXREZXJpdmVUZWxlbWV0cnkoKSB7IHJldHVybiB7IC4uLl90ZWxlbWV0cnkgfTsgfVxuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0RGVyaXZlVGVsZW1ldHJ5KCkgeyBfdGVsZW1ldHJ5ID0geyBkYkRlcml2ZUNvdW50OiAwLCBtYXJrZG93bkRlcml2ZUNvdW50OiAwIH07IH1cblxuLyoqXG4gKiBJbnZhbGlkYXRlIHRoZSBkZXJpdmVTdGF0ZSgpIGNhY2hlLiBDYWxsIHRoaXMgd2hlbmV2ZXIgcGxhbm5pbmcgZmlsZXMgb24gZGlza1xuICogbWF5IGhhdmUgY2hhbmdlZCAodW5pdCBjb21wbGV0aW9uLCBtZXJnZXMsIGZpbGUgd3JpdGVzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGludmFsaWRhdGVTdGF0ZUNhY2hlKCk6IHZvaWQge1xuICBfc3RhdGVDYWNoZSA9IG51bGw7XG59XG5cbi8qKlxuICogUmV0dXJucyB0aGUgSUQgb2YgdGhlIGZpcnN0IGluY29tcGxldGUgbWlsZXN0b25lLCBvciBudWxsIGlmIGFsbCBhcmUgY29tcGxldGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRBY3RpdmVNaWxlc3RvbmVJZChiYXNlUGF0aDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIC8vIFBhcmFsbGVsIHdvcmtlciBpc29sYXRpb24uIE5vcm1hbCBEQiBzdGF0ZSBkZXJpdmF0aW9uIHJlbWFpbnMgREItb25seTtcbiAgLy8gbG9jayBlbnYgdmFycyBhcmUgZXhlY3V0aW9uIHJvdXRpbmcgZm9yIGV4cGxpY2l0IHdvcmtlciBwcm9jZXNzZXMuXG4gIGNvbnN0IG1pbGVzdG9uZUxvY2sgPSBwcm9jZXNzLmVudi5HU0RfUEFSQUxMRUxfV09SS0VSID8gcHJvY2Vzcy5lbnYuR1NEX01JTEVTVE9ORV9MT0NLIDogdW5kZWZpbmVkO1xuICBpZiAobWlsZXN0b25lTG9jaykge1xuICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgIGNvbnN0IGxvY2tlZCA9IGdldEFsbE1pbGVzdG9uZXMoKS5maW5kKG0gPT4gbS5pZCA9PT0gbWlsZXN0b25lTG9jayk7XG4gICAgICBpZiAoIWxvY2tlZCB8fCBpc0Nsb3NlZFN0YXR1cyhsb2NrZWQuc3RhdHVzKSB8fCBsb2NrZWQuc3RhdHVzID09PSBcInBhcmtlZFwiKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiBsb2NrZWQuaWQ7XG4gICAgfVxuXG4gICAgY29uc3QgbWlsZXN0b25lSWRzID0gZmluZE1pbGVzdG9uZUlkcyhiYXNlUGF0aCk7XG4gICAgaWYgKCFtaWxlc3RvbmVJZHMuaW5jbHVkZXMobWlsZXN0b25lTG9jaykpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGxvY2tlZFBhcmtlZCA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWxlc3RvbmVMb2NrLCBcIlBBUktFRFwiKTtcbiAgICBpZiAobG9ja2VkUGFya2VkKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gbWlsZXN0b25lTG9jaztcbiAgfVxuXG4gIC8vIERCLWZpcnN0OiBxdWVyeSBtaWxlc3RvbmVzIHRhYmxlIGZvciB0aGUgZmlyc3Qgbm9uLWNvbXBsZXRlLCBub24tcGFya2VkIG1pbGVzdG9uZVxuICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgY29uc3QgYWxsTWlsZXN0b25lcyA9IGdldEFsbE1pbGVzdG9uZXMoKTtcbiAgICBpZiAoYWxsTWlsZXN0b25lcy5sZW5ndGggPiAwKSB7XG4gICAgICBmb3IgKGNvbnN0IG0gb2YgYWxsTWlsZXN0b25lcykge1xuICAgICAgICBpZiAoaXNDbG9zZWRTdGF0dXMobS5zdGF0dXMpIHx8IG0uc3RhdHVzID09PSBcInBhcmtlZFwiKSBjb250aW51ZTtcbiAgICAgICAgcmV0dXJuIG0uaWQ7XG4gICAgICB9XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cblxuICAvLyBGaWxlc3lzdGVtIGZhbGxiYWNrIGZvciB1bm1pZ3JhdGVkIHByb2plY3RzIG9yIGVtcHR5IERCXG4gIGNvbnN0IG1pbGVzdG9uZUlkcyA9IGZpbmRNaWxlc3RvbmVJZHMoYmFzZVBhdGgpO1xuICBmb3IgKGNvbnN0IG1pZCBvZiBtaWxlc3RvbmVJZHMpIHtcbiAgICBjb25zdCBwYXJrZWRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJQQVJLRURcIik7XG4gICAgaWYgKHBhcmtlZEZpbGUpIGNvbnRpbnVlO1xuXG4gICAgY29uc3Qgcm9hZG1hcEZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIlJPQURNQVBcIik7XG4gICAgY29uc3QgY29udGVudCA9IHJvYWRtYXBGaWxlID8gYXdhaXQgbG9hZEZpbGUocm9hZG1hcEZpbGUpIDogbnVsbDtcbiAgICBpZiAoIWNvbnRlbnQpIHtcbiAgICAgIGNvbnN0IHN1bW1hcnlGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJTVU1NQVJZXCIpO1xuICAgICAgaWYgKHN1bW1hcnlGaWxlICYmIGF3YWl0IGlzVGVybWluYWxNaWxlc3RvbmVTdW1tYXJ5RmlsZShzdW1tYXJ5RmlsZSwgbG9hZEZpbGUpKSBjb250aW51ZTtcbiAgICAgIGlmIChpc0dob3N0TWlsZXN0b25lKGJhc2VQYXRoLCBtaWQpKSBjb250aW51ZTtcbiAgICAgIHJldHVybiBtaWQ7XG4gICAgfVxuICAgIGNvbnN0IHJvYWRtYXAgPSBwYXJzZVJvYWRtYXAoY29udGVudCk7XG4gICAgY29uc3Qgc3VtbWFyeUZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIlNVTU1BUllcIik7XG4gICAgaWYgKHN1bW1hcnlGaWxlICYmIGF3YWl0IGlzVGVybWluYWxNaWxlc3RvbmVTdW1tYXJ5RmlsZShzdW1tYXJ5RmlsZSwgbG9hZEZpbGUpKSBjb250aW51ZTtcbiAgICBpZiAoIWlzTWlsZXN0b25lQ29tcGxldGUocm9hZG1hcCkpIHJldHVybiBtaWQ7XG4gICAgcmV0dXJuIG1pZDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPcHRpb25zIGZvciBkZXJpdmVTdGF0ZSByZWFkLXBhdGggcm91dGluZy5cbiAqXG4gKiBgcHJvamVjdFJvb3RGb3JSZWFkc2A6IGNhbm9uaWNhbCBwcm9qZWN0IHJvb3QgKGUuZy4gZnJvbVxuICogYHMuY2Fub25pY2FsUHJvamVjdFJvb3RgKSB1c2VkIGZvciBib3RoIHRoZSBjYWNoZSBrZXkgYW5kIHRoZSBhcnRpZmFjdC1yZWFkXG4gKiByb290IGluIGBfZGVyaXZlU3RhdGVJbXBsYC4gV2hlbiBvbWl0dGVkLCBiZWhhdmlvciBpcyBpZGVudGljYWwgdG8gdGhlXG4gKiBzaW5nbGUtYXJnIHNpZ25hdHVyZSAoYmFjay1jb21wYXQgZm9yIGFsbCBleGlzdGluZyBjYWxsZXJzKS5cbiAqXG4gKiBUeXBlZCBhcyBhbiBvYmplY3QgbGl0ZXJhbCAobm90IGBzdHJpbmcgfCBEZXJpdmVTdGF0ZU9wdGlvbnNgKSBzbyBhY2NpZGVudGFsXG4gKiBgZGVyaXZlU3RhdGUocGF0aCwgXCJzdHJpbmdcIilgIGlzIHJlamVjdGVkIGF0IGNvbXBpbGUgdGltZS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBEZXJpdmVTdGF0ZU9wdGlvbnMge1xuICBwcm9qZWN0Um9vdEZvclJlYWRzPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIFJlY29uc3RydWN0IEdTRCBzdGF0ZSBmcm9tIHRoZSBhdXRob3JpdGF0aXZlIERCLlxuICogU1RBVEUubWQgaXMgYSByZW5kZXJlZCBjYWNoZSBvZiB0aGlzIG91dHB1dC5cbiAqXG4gKiBXaGVuIERCIGlzIGF2YWlsYWJsZSwgcXVlcmllcyBtaWxlc3RvbmUvc2xpY2UvdGFzayB0YWJsZXMgZGlyZWN0bHkuXG4gKiBMZWdhY3kgZmlsZXN5c3RlbSBwYXJzaW5nIGlzIGF2YWlsYWJsZSBvbmx5IHRocm91Z2ggYW4gZXhwbGljaXQgb3B0LWluIGZvclxuICogdGVzdHMvcmVjb3ZlcnkgZmxvd3M7IHJ1bnRpbWUgbXVzdCBub3Qgc2lsZW50bHkgaW5mZXIgc3RhdGUgZnJvbSBtYXJrZG93bi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlcml2ZVN0YXRlKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBvcHRzPzogRGVyaXZlU3RhdGVPcHRpb25zLFxuKTogUHJvbWlzZTxHU0RTdGF0ZT4ge1xuICAvLyBVc2UgdGhlIGNhbm9uaWNhbCBwcm9qZWN0IHJvb3QgKHdoZW4gcHJvdmlkZWQpIGFzIHRoZSBjYWNoZSBrZXkgc28gdGhhdFxuICAvLyB0d28gY2FsbHMgd2l0aCBkaWZmZXJlbnQgYmFzZVBhdGggc3RyaW5ncyAoZS5nLiB3b3JrdHJlZSBwYXRoIHZzIHByb2plY3RcbiAgLy8gcm9vdCkgYnV0IHRoZSBzYW1lIGNhbm9uaWNhbCAuZ3NkLyBzaGFyZSBhIHNpbmdsZSBjYWNoZSBlbnRyeS4gVGhlIHNhbWVcbiAgLy8ga2V5IGlzIHVzZWQgZm9yIGJvdGggdGhlIGxvb2t1cCBBTkQgdGhlIHdyaXRlIGJlbG93IFx1MjAxNCBrZXlpbmcgbG9va3VwIG9uXG4gIC8vIGNhbm9uaWNhbC1yb290IHdoaWxlIHdyaXRpbmcgb24gYmFzZVBhdGggd291bGQgc2lsZW50bHkgcmV0dXJuIHN0YWxlXG4gIC8vIHJlc3VsdHMgYWNyb3NzIHBhdGgtZm9ybSBhbHRlcm5hdGlvbi5cbiAgY29uc3QgY2FjaGVLZXkgPSBvcHRzPy5wcm9qZWN0Um9vdEZvclJlYWRzID8/IGJhc2VQYXRoO1xuXG4gIC8vIFJldHVybiBjYWNoZWQgcmVzdWx0IGlmIHdpdGhpbiB0aGUgVFRMIHdpbmRvdyBmb3IgdGhlIHNhbWUgY2FjaGVLZXlcbiAgaWYgKFxuICAgIF9zdGF0ZUNhY2hlICYmXG4gICAgX3N0YXRlQ2FjaGUuYmFzZVBhdGggPT09IGNhY2hlS2V5ICYmXG4gICAgRGF0ZS5ub3coKSAtIF9zdGF0ZUNhY2hlLnRpbWVzdGFtcCA8IENBQ0hFX1RUTF9NU1xuICApIHtcbiAgICByZXR1cm4gX3N0YXRlQ2FjaGUucmVzdWx0O1xuICB9XG5cbiAgY29uc3Qgc3RvcFRpbWVyID0gZGVidWdUaW1lKFwiZGVyaXZlLXN0YXRlLWltcGxcIik7XG4gIGxldCByZXN1bHQ6IEdTRFN0YXRlO1xuXG4gIC8vIERCLWJhY2tlZCBkZXJpdmF0aW9uIGlzIGF1dGhvcml0YXRpdmUgd2hlbmV2ZXIgdGhlIERCIGlzIG9wZW4uXG4gIC8vIE1hcmtkb3duIGZhbGxiYWNrIGlzIGV4cGxpY2l0LW9ubHk7IHJ1bnRpbWUgZGVncmFkZSBtdXN0IG5vdCBpbmZlciBzdGF0ZVxuICAvLyBmcm9tIFJPQURNQVAubWQsIFBMQU4ubWQsIFNVTU1BUlkubWQsIFJFUVVJUkVNRU5UUy5tZCwgb3IgZmxhZyBmaWxlcy5cbiAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgIGNvbnN0IHN0b3BEYlRpbWVyID0gZGVidWdUaW1lKFwiZGVyaXZlLXN0YXRlLWRiXCIpO1xuICAgIHJlc3VsdCA9IGF3YWl0IGRlcml2ZVN0YXRlRnJvbURiKGJhc2VQYXRoKTtcbiAgICBzdG9wRGJUaW1lcih7IHBoYXNlOiByZXN1bHQucGhhc2UsIG1pbGVzdG9uZTogcmVzdWx0LmFjdGl2ZU1pbGVzdG9uZT8uaWQgfSk7XG4gICAgX3RlbGVtZXRyeS5kYkRlcml2ZUNvdW50Kys7XG4gIH0gZWxzZSBpZiAocHJvY2Vzcy5lbnYuR1NEX0FMTE9XX01BUktET1dOX0RFUklWRV9GQUxMQkFDSyA9PT0gXCIxXCIpIHtcbiAgICBpZiAod2FzRGJPcGVuQXR0ZW1wdGVkKCkpIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJzdGF0ZVwiLCBcIkRCIHVuYXZhaWxhYmxlIFx1MjAxNCB1c2luZyBleHBsaWNpdCBsZWdhY3kgZmlsZXN5c3RlbSBzdGF0ZSBkZXJpdmF0aW9uXCIpO1xuICAgIH1cbiAgICByZXN1bHQgPSBhd2FpdCBfZGVyaXZlU3RhdGVJbXBsKGJhc2VQYXRoLCBvcHRzKTtcbiAgICBfdGVsZW1ldHJ5Lm1hcmtkb3duRGVyaXZlQ291bnQrKztcbiAgICBpbmNyZW1lbnRMZWdhY3lUZWxlbWV0cnkoXCJsZWdhY3kubWFya2Rvd25GYWxsYmFja1VzZWRcIik7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHdhc0RiT3BlbkF0dGVtcHRlZCgpKSB7XG4gICAgICBsb2dXYXJuaW5nKFwic3RhdGVcIiwgXCJEQiB1bmF2YWlsYWJsZSBcdTIwMTQgcmVmdXNpbmcgaW1wbGljaXQgbWFya2Rvd24gc3RhdGUgZGVyaXZhdGlvblwiKTtcbiAgICB9XG4gICAgcmVzdWx0ID0ge1xuICAgICAgYWN0aXZlTWlsZXN0b25lOiBudWxsLFxuICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgcGhhc2U6IFwicHJlLXBsYW5uaW5nXCIsXG4gICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgYmxvY2tlcnM6IFtcIkRCIHVuYXZhaWxhYmxlIFx1MjAxNCBydW50aW1lIG1hcmtkb3duIHN0YXRlIGRlcml2YXRpb24gaXMgZGlzYWJsZWRcIl0sXG4gICAgICBuZXh0QWN0aW9uOiBcIk9wZW4gb3IgY3JlYXRlIHRoZSBjYW5vbmljYWwgR1NEIGRhdGFiYXNlIGJlZm9yZSBkZXJpdmluZyB3b3JrZmxvdyBzdGF0ZS5cIixcbiAgICAgIHJlZ2lzdHJ5OiBbXSxcbiAgICAgIHJlcXVpcmVtZW50czogeyBhY3RpdmU6IDAsIHZhbGlkYXRlZDogMCwgZGVmZXJyZWQ6IDAsIG91dE9mU2NvcGU6IDAsIGJsb2NrZWQ6IDAsIHRvdGFsOiAwIH0sXG4gICAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiB7IGRvbmU6IDAsIHRvdGFsOiAwIH0gfSxcbiAgICB9O1xuICB9XG5cbiAgc3RvcFRpbWVyKHsgcGhhc2U6IHJlc3VsdC5waGFzZSwgbWlsZXN0b25lOiByZXN1bHQuYWN0aXZlTWlsZXN0b25lPy5pZCB9KTtcbiAgZGVidWdDb3VudChcImRlcml2ZVN0YXRlQ2FsbHNcIik7XG4gIF9zdGF0ZUNhY2hlID0geyBiYXNlUGF0aDogY2FjaGVLZXksIHJlc3VsdCwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH07XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKlxuICogRXh0cmFjdCBtaWxlc3RvbmUgdGl0bGUgZnJvbSBDT05URVhULm1kIG9yIENPTlRFWFQtRFJBRlQubWQgaGVhZGluZy5cbiAqIEZhbGxzIGJhY2sgdG8gdGhlIHByb3ZpZGVkIGZhbGxiYWNrICh1c3VhbGx5IHRoZSBtaWxlc3RvbmUgSUQpLlxuICovXG4vKipcbiAqIFN0cmlwIHRoZSBcIk0wMDE6IFwiIHByZWZpeCBmcm9tIGEgbWlsZXN0b25lIHRpdGxlIHRvIGdldCB0aGUgaHVtYW4tcmVhZGFibGUgbmFtZS5cbiAqIFVzZWQgYnkgYm90aCBEQiBhbmQgZmlsZXN5c3RlbSBwYXRocyBmb3IgY29uc2lzdGVuY3kuXG4gKi9cbmZ1bmN0aW9uIHN0cmlwTWlsZXN0b25lUHJlZml4KHRpdGxlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGl0bGUucmVwbGFjZSgvXk1cXGQrKD86LVthLXowLTldezZ9KT9bXjpdKjpcXHMqLywgJycpIHx8IHRpdGxlO1xufVxuXG5mdW5jdGlvbiBleHRyYWN0Q29udGV4dFRpdGxlKGNvbnRlbnQ6IHN0cmluZyB8IG51bGwsIGZhbGxiYWNrOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoIWNvbnRlbnQpIHJldHVybiBmYWxsYmFjaztcbiAgY29uc3QgaDEgPSBjb250ZW50LnNwbGl0KCdcXG4nKS5maW5kKGxpbmUgPT4gbGluZS5zdGFydHNXaXRoKCcjICcpKTtcbiAgaWYgKCFoMSkgcmV0dXJuIGZhbGxiYWNrO1xuICAvLyBFeHRyYWN0IHRpdGxlIGZyb20gXCIjIE0wMDU6IFBsYXRmb3JtIEZvdW5kYXRpb24gJiBTZXBhcmF0aW9uXCIgZm9ybWF0XG4gIHJldHVybiBzdHJpcE1pbGVzdG9uZVByZWZpeChoMS5zbGljZSgyKS50cmltKCkpIHx8IGZhbGxiYWNrO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgREItYmFja2VkIFN0YXRlIERlcml2YXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8vIGlzU3RhdHVzRG9uZSByZXBsYWNlZCBieSBpc0Nsb3NlZFN0YXR1cyBmcm9tIHN0YXR1cy1ndWFyZHMudHMgKHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGgpLlxuLy8gQWxpYXMga2VwdCBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eSB3aXRoaW4gdGhpcyBmaWxlLlxuY29uc3QgaXNTdGF0dXNEb25lID0gaXNDbG9zZWRTdGF0dXM7XG5cbi8qKlxuICogRGVyaXZlIEdTRCBzdGF0ZSBmcm9tIHRoZSBtaWxlc3RvbmVzL3NsaWNlcy90YXNrcyBEQiB0YWJsZXMuXG4gKiBNYXJrZG93biBmaWxlcyBhcmUgcHJvamVjdGlvbnMgb25seSBpbiB0aGlzIHBhdGg7IHRoZXkgYXJlIG5ldmVyIGltcG9ydGVkLFxuICogcmVjb25jaWxlZCwgb3IgdXNlZCBhcyBjb21wbGV0aW9uIHNpZ25hbHMuXG4gKi9cblxuZnVuY3Rpb24gYnVpbGRDb21wbGV0ZW5lc3NTZXQoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lczogTWlsZXN0b25lUm93W10pIHtcbiAgY29uc3QgY29tcGxldGVNaWxlc3RvbmVJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgcGFya2VkTWlsZXN0b25lSWRzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgLy8gREItYXV0aG9yaXRhdGl2ZTogYSBtaWxlc3RvbmUgaXMgb25seSBcImNvbXBsZXRlXCIgd2hlbiBpdHMgREIgcm93IHNheXMgc28uXG4gIC8vIFNVTU1BUlktZmlsZSBwcmVzZW5jZSBpcyBOT1QgYSBjb21wbGV0aW9uIHNpZ25hbCBoZXJlIFx1MjAxNCBhbiBvcnBoYW4gU1VNTUFSWVxuICAvLyAoY3Jhc2hlZCBjb21wbGV0ZS1taWxlc3RvbmUgdHVybiwgcGFydGlhbCBtZXJnZSwgbWFudWFsIGVkaXQpIG11c3Qgbm90XG4gIC8vIGZsaXAgZGVyaXZlZCBzdGF0ZSB0byBjb21wbGV0ZSBhbmQgY2FzY2FkZSBpbnRvIGEgZmFsc2UgYXV0by1tZXJnZSAoIzQxNzkpLlxuICBmb3IgKGNvbnN0IG0gb2YgbWlsZXN0b25lcykge1xuICAgIGlmIChtLnN0YXR1cyA9PT0gJ3BhcmtlZCcpIHtcbiAgICAgIHBhcmtlZE1pbGVzdG9uZUlkcy5hZGQobS5pZCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzU3RhdHVzRG9uZShtLnN0YXR1cykpIHtcbiAgICAgIGNvbXBsZXRlTWlsZXN0b25lSWRzLmFkZChtLmlkKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyBjb21wbGV0ZU1pbGVzdG9uZUlkcywgcGFya2VkTWlsZXN0b25lSWRzIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkUmVnaXN0cnlBbmRGaW5kQWN0aXZlKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBtaWxlc3RvbmVzOiBNaWxlc3RvbmVSb3dbXSxcbiAgY29tcGxldGVNaWxlc3RvbmVJZHM6IFNldDxzdHJpbmc+LFxuICBwYXJrZWRNaWxlc3RvbmVJZHM6IFNldDxzdHJpbmc+XG4pIHtcbiAgY29uc3QgcmVnaXN0cnk6IE1pbGVzdG9uZVJlZ2lzdHJ5RW50cnlbXSA9IFtdO1xuICBsZXQgYWN0aXZlTWlsZXN0b25lOiBBY3RpdmVSZWYgfCBudWxsID0gbnVsbDtcbiAgbGV0IGFjdGl2ZU1pbGVzdG9uZVNsaWNlczogU2xpY2VSb3dbXSA9IFtdO1xuICBsZXQgYWN0aXZlTWlsZXN0b25lRm91bmQgPSBmYWxzZTtcbiAgbGV0IGFjdGl2ZU1pbGVzdG9uZUhhc0RyYWZ0ID0gZmFsc2U7XG4gIGxldCBmaXJzdERlZmVycmVkUXVldWVkU2hlbGw6IHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgZGVwczogc3RyaW5nW10gfSB8IG51bGwgPSBudWxsO1xuXG4gIGZvciAoY29uc3QgbSBvZiBtaWxlc3RvbmVzKSB7XG4gICAgaWYgKHBhcmtlZE1pbGVzdG9uZUlkcy5oYXMobS5pZCkpIHtcbiAgICAgIHJlZ2lzdHJ5LnB1c2goeyBpZDogbS5pZCwgdGl0bGU6IHN0cmlwTWlsZXN0b25lUHJlZml4KG0udGl0bGUpIHx8IG0uaWQsIHN0YXR1czogJ3BhcmtlZCcgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBzbGljZXMgPSBnZXRNaWxlc3RvbmVTbGljZXMobS5pZCk7XG5cbiAgICAvLyBEQi1hdXRob3JpdGF0aXZlIGNvbXBsZXRlbmVzcyAoIzQxNzkpOiBvbmx5IHRydXN0IGNvbXBsZXRlTWlsZXN0b25lSWRzLFxuICAgIC8vIHdoaWNoIGlzIGl0c2VsZiBkZXJpdmVkIGZyb20gREIgc3RhdHVzLiBTVU1NQVJZLWZpbGUgcHJlc2VuY2UgYWxvbmUgbXVzdFxuICAgIC8vIG5vdCBpbXBseSBjb21wbGV0aW9uLlxuICAgIGlmIChjb21wbGV0ZU1pbGVzdG9uZUlkcy5oYXMobS5pZCkpIHtcbiAgICAgIGNvbnN0IHRpdGxlID0gc3RyaXBNaWxlc3RvbmVQcmVmaXgobS50aXRsZSkgfHwgbS5pZDtcbiAgICAgIHJlZ2lzdHJ5LnB1c2goeyBpZDogbS5pZCwgdGl0bGUsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IGFsbFNsaWNlc0RvbmUgPSBzbGljZXMubGVuZ3RoID4gMCAmJiBzbGljZXMuZXZlcnkocyA9PiBpc1N0YXR1c0RvbmUocy5zdGF0dXMpKTtcblxuICAgIGNvbnN0IHRpdGxlID0gc3RyaXBNaWxlc3RvbmVQcmVmaXgobS50aXRsZSkgfHwgbS5pZDtcblxuICAgIGlmICghYWN0aXZlTWlsZXN0b25lRm91bmQpIHtcbiAgICAgIGNvbnN0IGRlcHMgPSBtLmRlcGVuZHNfb247XG4gICAgICBjb25zdCBkZXBzVW5tZXQgPSBkZXBzLnNvbWUoZGVwID0+ICFjb21wbGV0ZU1pbGVzdG9uZUlkcy5oYXMoZGVwKSk7XG5cbiAgICAgIGlmIChkZXBzVW5tZXQpIHtcbiAgICAgICAgcmVnaXN0cnkucHVzaCh7IGlkOiBtLmlkLCB0aXRsZSwgc3RhdHVzOiAncGVuZGluZycsIGRlcGVuZHNPbjogZGVwcyB9KTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmIChtLnN0YXR1cyA9PT0gJ3F1ZXVlZCcgJiYgc2xpY2VzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBpZiAoIWZpcnN0RGVmZXJyZWRRdWV1ZWRTaGVsbCkge1xuICAgICAgICAgIGZpcnN0RGVmZXJyZWRRdWV1ZWRTaGVsbCA9IHsgaWQ6IG0uaWQsIHRpdGxlLCBkZXBzIH07XG4gICAgICAgIH1cbiAgICAgICAgcmVnaXN0cnkucHVzaCh7IGlkOiBtLmlkLCB0aXRsZSwgc3RhdHVzOiAncGVuZGluZycsIC4uLihkZXBzLmxlbmd0aCA+IDAgPyB7IGRlcGVuZHNPbjogZGVwcyB9IDoge30pIH0pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKGFsbFNsaWNlc0RvbmUpIHtcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lID0geyBpZDogbS5pZCwgdGl0bGUgfTtcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lU2xpY2VzID0gc2xpY2VzO1xuICAgICAgICBhY3RpdmVNaWxlc3RvbmVGb3VuZCA9IHRydWU7XG4gICAgICAgIHJlZ2lzdHJ5LnB1c2goeyBpZDogbS5pZCwgdGl0bGUsIHN0YXR1czogJ2FjdGl2ZScsIC4uLihkZXBzLmxlbmd0aCA+IDAgPyB7IGRlcGVuZHNPbjogZGVwcyB9IDoge30pIH0pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgaWYgKG0uc3RhdHVzID09PSAnbmVlZHMtZGlzY3Vzc2lvbicpIGFjdGl2ZU1pbGVzdG9uZUhhc0RyYWZ0ID0gdHJ1ZTtcblxuICAgICAgYWN0aXZlTWlsZXN0b25lID0geyBpZDogbS5pZCwgdGl0bGUgfTtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZVNsaWNlcyA9IHNsaWNlcztcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZUZvdW5kID0gdHJ1ZTtcbiAgICAgIHJlZ2lzdHJ5LnB1c2goeyBpZDogbS5pZCwgdGl0bGUsIHN0YXR1czogJ2FjdGl2ZScsIC4uLihkZXBzLmxlbmd0aCA+IDAgPyB7IGRlcGVuZHNPbjogZGVwcyB9IDoge30pIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBkZXBzID0gbS5kZXBlbmRzX29uO1xuICAgICAgcmVnaXN0cnkucHVzaCh7IGlkOiBtLmlkLCB0aXRsZSwgc3RhdHVzOiAncGVuZGluZycsIC4uLihkZXBzLmxlbmd0aCA+IDAgPyB7IGRlcGVuZHNPbjogZGVwcyB9IDoge30pIH0pO1xuICAgIH1cbiAgfVxuXG4gIGlmICghYWN0aXZlTWlsZXN0b25lRm91bmQgJiYgZmlyc3REZWZlcnJlZFF1ZXVlZFNoZWxsKSB7XG4gICAgY29uc3Qgc2hlbGwgPSBmaXJzdERlZmVycmVkUXVldWVkU2hlbGw7XG4gICAgYWN0aXZlTWlsZXN0b25lID0geyBpZDogc2hlbGwuaWQsIHRpdGxlOiBzaGVsbC50aXRsZSB9O1xuICAgIGFjdGl2ZU1pbGVzdG9uZVNsaWNlcyA9IFtdO1xuICAgIGFjdGl2ZU1pbGVzdG9uZUZvdW5kID0gdHJ1ZTtcbiAgICBjb25zdCBlbnRyeSA9IHJlZ2lzdHJ5LmZpbmQoZSA9PiBlLmlkID09PSBzaGVsbC5pZCk7XG4gICAgaWYgKGVudHJ5KSBlbnRyeS5zdGF0dXMgPSAnYWN0aXZlJztcbiAgfVxuXG4gIHJldHVybiB7IHJlZ2lzdHJ5LCBhY3RpdmVNaWxlc3RvbmUsIGFjdGl2ZU1pbGVzdG9uZVNsaWNlcywgYWN0aXZlTWlsZXN0b25lSGFzRHJhZnQgfTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlTm9BY3RpdmVNaWxlc3RvbmUoXG4gIHJlZ2lzdHJ5OiBNaWxlc3RvbmVSZWdpc3RyeUVudHJ5W10sXG4gIHJlcXVpcmVtZW50czogYW55LFxuICBtaWxlc3RvbmVQcm9ncmVzczogeyBkb25lOiBudW1iZXIsIHRvdGFsOiBudW1iZXIgfVxuKTogR1NEU3RhdGUge1xuICBjb25zdCBwZW5kaW5nRW50cmllcyA9IHJlZ2lzdHJ5LmZpbHRlcihlID0+IGUuc3RhdHVzID09PSAncGVuZGluZycpO1xuICBjb25zdCBwYXJrZWRFbnRyaWVzID0gcmVnaXN0cnkuZmlsdGVyKGUgPT4gZS5zdGF0dXMgPT09ICdwYXJrZWQnKTtcblxuICBpZiAocGVuZGluZ0VudHJpZXMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGJsb2NrZXJEZXRhaWxzID0gcGVuZGluZ0VudHJpZXNcbiAgICAgIC5maWx0ZXIoZSA9PiBlLmRlcGVuZHNPbiAmJiBlLmRlcGVuZHNPbi5sZW5ndGggPiAwKVxuICAgICAgLm1hcChlID0+IGAke2UuaWR9IGlzIHdhaXRpbmcgb24gdW5tZXQgZGVwczogJHtlLmRlcGVuZHNPbiEuam9pbignLCAnKX1gKTtcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aXZlTWlsZXN0b25lOiBudWxsLCBhY3RpdmVTbGljZTogbnVsbCwgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgIHBoYXNlOiAnYmxvY2tlZCcsXG4gICAgICByZWNlbnREZWNpc2lvbnM6IFtdLCBibG9ja2VyczogYmxvY2tlckRldGFpbHMubGVuZ3RoID4gMFxuICAgICAgICA/IGJsb2NrZXJEZXRhaWxzXG4gICAgICAgIDogWydBbGwgcmVtYWluaW5nIG1pbGVzdG9uZXMgYXJlIGRlcC1ibG9ja2VkIGJ1dCBubyBkZXBzIGxpc3RlZCBcdTIwMTQgY2hlY2sgQ09OVEVYVC5tZCBmaWxlcyddLFxuICAgICAgbmV4dEFjdGlvbjogJ1Jlc29sdmUgbWlsZXN0b25lIGRlcGVuZGVuY2llcyBiZWZvcmUgcHJvY2VlZGluZy4nLFxuICAgICAgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzIH0sXG4gICAgfTtcbiAgfVxuXG4gIGlmIChwYXJrZWRFbnRyaWVzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBwYXJrZWRJZHMgPSBwYXJrZWRFbnRyaWVzLm1hcChlID0+IGUuaWQpLmpvaW4oJywgJyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogbnVsbCwgYWN0aXZlU2xpY2U6IG51bGwsIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogJ3ByZS1wbGFubmluZycsXG4gICAgICByZWNlbnREZWNpc2lvbnM6IFtdLCBibG9ja2VyczogW10sXG4gICAgICBuZXh0QWN0aW9uOiBgQWxsIHJlbWFpbmluZyBtaWxlc3RvbmVzIGFyZSBwYXJrZWQgKCR7cGFya2VkSWRzfSkuIFJ1biAvZ3NkIHVucGFyayA8aWQ+IG9yIGNyZWF0ZSBhIG5ldyBtaWxlc3RvbmUuYCxcbiAgICAgIHJlZ2lzdHJ5LCByZXF1aXJlbWVudHMsXG4gICAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcyB9LFxuICAgIH07XG4gIH1cblxuICBpZiAocmVnaXN0cnkubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogbnVsbCwgYWN0aXZlU2xpY2U6IG51bGwsIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogJ3ByZS1wbGFubmluZycsXG4gICAgICByZWNlbnREZWNpc2lvbnM6IFtdLCBibG9ja2VyczogW10sXG4gICAgICBuZXh0QWN0aW9uOiAnTm8gbWlsZXN0b25lcyBmb3VuZC4gUnVuIC9nc2QgdG8gY3JlYXRlIG9uZS4nLFxuICAgICAgcmVnaXN0cnk6IFtdLCByZXF1aXJlbWVudHMsXG4gICAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiB7IGRvbmU6IDAsIHRvdGFsOiAwIH0gfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgbGFzdEVudHJ5ID0gcmVnaXN0cnlbcmVnaXN0cnkubGVuZ3RoIC0gMV07XG4gIGNvbnN0IGFjdGl2ZVJlcXMgPSByZXF1aXJlbWVudHMuYWN0aXZlID8/IDA7XG4gIGNvbnN0IGNvbXBsZXRpb25Ob3RlID0gYWN0aXZlUmVxcyA+IDBcbiAgICA/IGBBbGwgbWlsZXN0b25lcyBjb21wbGV0ZS4gJHthY3RpdmVSZXFzfSBhY3RpdmUgcmVxdWlyZW1lbnQke2FjdGl2ZVJlcXMgPT09IDEgPyAnJyA6ICdzJ30gaW4gUkVRVUlSRU1FTlRTLm1kICR7YWN0aXZlUmVxcyA9PT0gMSA/ICdoYXMnIDogJ2hhdmUnfSBub3QgYmVlbiBtYXBwZWQgdG8gYSBtaWxlc3RvbmUuYFxuICAgIDogJ0FsbCBtaWxlc3RvbmVzIGNvbXBsZXRlLic7XG4gIHJldHVybiB7XG4gICAgYWN0aXZlTWlsZXN0b25lOiBudWxsLFxuICAgIGxhc3RDb21wbGV0ZWRNaWxlc3RvbmU6IGxhc3RFbnRyeSA/IHsgaWQ6IGxhc3RFbnRyeS5pZCwgdGl0bGU6IGxhc3RFbnRyeS50aXRsZSB9IDogbnVsbCxcbiAgICBhY3RpdmVTbGljZTogbnVsbCwgYWN0aXZlVGFzazogbnVsbCxcbiAgICBwaGFzZTogJ2NvbXBsZXRlJyxcbiAgICByZWNlbnREZWNpc2lvbnM6IFtdLCBibG9ja2VyczogW10sXG4gICAgbmV4dEFjdGlvbjogY29tcGxldGlvbk5vdGUsXG4gICAgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcyB9LFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVBbGxTbGljZXNEb25lKFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBhY3RpdmVNaWxlc3RvbmU6IEFjdGl2ZVJlZixcbiAgcmVnaXN0cnk6IE1pbGVzdG9uZVJlZ2lzdHJ5RW50cnlbXSxcbiAgcmVxdWlyZW1lbnRzOiBhbnksXG4gIG1pbGVzdG9uZVByb2dyZXNzOiB7IGRvbmU6IG51bWJlciwgdG90YWw6IG51bWJlciB9LFxuICBzbGljZVByb2dyZXNzOiB7IGRvbmU6IG51bWJlciwgdG90YWw6IG51bWJlciB9XG4pOiBQcm9taXNlPEdTRFN0YXRlPiB7XG4gIGNvbnN0IHZhbGlkYXRpb24gPSBnZXRMYXRlc3RBc3Nlc3NtZW50QnlTY29wZShhY3RpdmVNaWxlc3RvbmUuaWQsIFwibWlsZXN0b25lLXZhbGlkYXRpb25cIik7XG4gIGNvbnN0IHZlcmRpY3QgPSB0eXBlb2YgdmFsaWRhdGlvbj8uc3RhdHVzID09PSBcInN0cmluZ1wiID8gdmFsaWRhdGlvbi5zdGF0dXMgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHZhbGlkYXRpb25UZXJtaW5hbCA9IHZlcmRpY3QgIT0gbnVsbCAmJiB2ZXJkaWN0ICE9PSBcIlwiO1xuXG4gIGlmICghdmFsaWRhdGlvblRlcm1pbmFsKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZSwgYWN0aXZlU2xpY2U6IG51bGwsIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogJ3ZhbGlkYXRpbmctbWlsZXN0b25lJyxcbiAgICAgIHJlY2VudERlY2lzaW9uczogW10sIGJsb2NrZXJzOiBbXSxcbiAgICAgIG5leHRBY3Rpb246IGBWYWxpZGF0ZSBtaWxlc3RvbmUgJHthY3RpdmVNaWxlc3RvbmUuaWR9IGJlZm9yZSBjb21wbGV0aW9uLmAsXG4gICAgICByZWdpc3RyeSwgcmVxdWlyZW1lbnRzLFxuICAgICAgcHJvZ3Jlc3M6IHsgbWlsZXN0b25lczogbWlsZXN0b25lUHJvZ3Jlc3MsIHNsaWNlczogc2xpY2VQcm9ncmVzcyB9LFxuICAgIH07XG4gIH1cblxuICAvLyBBbGwgcm9hZG1hcCBzbGljZXMgYXJlIGRvbmUgKGVuZm9yY2VkIGJ5IGNhbGxlcikgYW5kIHZlcmRpY3QgaXNcbiAgLy8gbmVlZHMtcmVtZWRpYXRpb24gXHUyMDE0IHJlbWVkaWF0aW9uIGNhbm5vdCBwcm9ncmVzcyB3aXRob3V0IG5ldyBzbGljZXMuXG4gIC8vIFJldHVybiBibG9ja2VkIGluc3RlYWQgb2YgcmUtZGlzcGF0Y2hpbmcgdmFsaWRhdGUtbWlsZXN0b25lICgjNDUwNikuXG4gIGlmICh2ZXJkaWN0ID09PSAnbmVlZHMtcmVtZWRpYXRpb24nKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZSwgYWN0aXZlU2xpY2U6IG51bGwsIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogJ2Jsb2NrZWQnLFxuICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgIGJsb2NrZXJzOiBbXG4gICAgICAgIGBNaWxlc3RvbmUgJHthY3RpdmVNaWxlc3RvbmUuaWR9IHZhbGlkYXRpb24gdmVyZGljdCBpcyBuZWVkcy1yZW1lZGlhdGlvbiBidXQgYWxsIHNsaWNlcyBhcmUgY29tcGxldGUuIGAgK1xuICAgICAgICAgIGBBZGQgcmVtZWRpYXRpb24gc2xpY2VzIHZpYSBnc2RfcmVhc3Nlc3Nfcm9hZG1hcCBvciBvdmVycmlkZSB0aGUgdmVyZGljdCBtYW51YWxseS5gLFxuICAgICAgXSxcbiAgICAgIG5leHRBY3Rpb246IGBSZXNvbHZlICR7YWN0aXZlTWlsZXN0b25lLmlkfSByZW1lZGlhdGlvbiBiZWZvcmUgcHJvY2VlZGluZy5gLFxuICAgICAgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLCBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MgfSxcbiAgICB9O1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBhY3RpdmVNaWxlc3RvbmUsIGFjdGl2ZVNsaWNlOiBudWxsLCBhY3RpdmVUYXNrOiBudWxsLFxuICAgIHBoYXNlOiAnY29tcGxldGluZy1taWxlc3RvbmUnLFxuICAgIHJlY2VudERlY2lzaW9uczogW10sIGJsb2NrZXJzOiBbXSxcbiAgICBuZXh0QWN0aW9uOiBgQWxsIHNsaWNlcyBjb21wbGV0ZSBpbiAke2FjdGl2ZU1pbGVzdG9uZS5pZH0uIFdyaXRlIG1pbGVzdG9uZSBzdW1tYXJ5LmAsXG4gICAgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcywgc2xpY2VzOiBzbGljZVByb2dyZXNzIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVTbGljZURlcGVuZGVuY2llcyhhY3RpdmVNaWxlc3RvbmVTbGljZXM6IFNsaWNlUm93W10pOiB7IGFjdGl2ZVNsaWNlOiBBY3RpdmVSZWYgfCBudWxsLCBhY3RpdmVTbGljZVJvdzogU2xpY2VSb3cgfCBudWxsIH0ge1xuICBjb25zdCBkb25lU2xpY2VJZHMgPSBuZXcgU2V0KFxuICAgIGFjdGl2ZU1pbGVzdG9uZVNsaWNlcy5maWx0ZXIocyA9PiBpc1N0YXR1c0RvbmUocy5zdGF0dXMpKS5tYXAocyA9PiBzLmlkKVxuICApO1xuXG4gIGNvbnN0IHNsaWNlTG9jayA9IHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVIgPyBwcm9jZXNzLmVudi5HU0RfU0xJQ0VfTE9DSyA6IHVuZGVmaW5lZDtcbiAgaWYgKHNsaWNlTG9jaykge1xuICAgIGNvbnN0IGxvY2tlZFNsaWNlID0gYWN0aXZlTWlsZXN0b25lU2xpY2VzLmZpbmQocyA9PiBzLmlkID09PSBzbGljZUxvY2spO1xuICAgIGlmIChsb2NrZWRTbGljZSkge1xuICAgICAgcmV0dXJuIHsgYWN0aXZlU2xpY2U6IHsgaWQ6IGxvY2tlZFNsaWNlLmlkLCB0aXRsZTogbG9ja2VkU2xpY2UudGl0bGUgfSwgYWN0aXZlU2xpY2VSb3c6IGxvY2tlZFNsaWNlIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZ1dhcm5pbmcoXCJzdGF0ZVwiLCBgR1NEX1NMSUNFX0xPQ0s9JHtzbGljZUxvY2t9IG5vdCBmb3VuZCBpbiBhY3RpdmUgc2xpY2VzIFx1MjAxNCB3b3JrZXIgaGFzIG5vIGFzc2lnbmVkIHdvcmtgKTtcbiAgICAgIHJldHVybiB7IGFjdGl2ZVNsaWNlOiBudWxsLCBhY3RpdmVTbGljZVJvdzogbnVsbCB9O1xuICAgIH1cbiAgfVxuXG4gIGZvciAoY29uc3QgcyBvZiBhY3RpdmVNaWxlc3RvbmVTbGljZXMpIHtcbiAgICBpZiAoaXNTdGF0dXNEb25lKHMuc3RhdHVzKSkgY29udGludWU7XG4gICAgaWYgKGlzRGVmZXJyZWRTdGF0dXMocy5zdGF0dXMpKSBjb250aW51ZTtcbiAgICBpZiAocy5kZXBlbmRzLmV2ZXJ5KGRlcCA9PiBkb25lU2xpY2VJZHMuaGFzKGRlcCkpKSB7XG4gICAgICByZXR1cm4geyBhY3RpdmVTbGljZTogeyBpZDogcy5pZCwgdGl0bGU6IHMudGl0bGUgfSwgYWN0aXZlU2xpY2VSb3c6IHMgfTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBhY3RpdmVTbGljZTogbnVsbCwgYWN0aXZlU2xpY2VSb3c6IG51bGwgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZGV0ZWN0QmxvY2tlcnMoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nLCB0YXNrczogVGFza1Jvd1tdKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGNvbnN0IGNvbXBsZXRlZFRhc2tzID0gdGFza3MuZmlsdGVyKHQgPT4gaXNTdGF0dXNEb25lKHQuc3RhdHVzKSk7XG4gIGZvciAoY29uc3QgY3Qgb2YgY29tcGxldGVkVGFza3MpIHtcbiAgICBpZiAoY3QuYmxvY2tlcl9kaXNjb3ZlcmVkKSB7XG4gICAgICByZXR1cm4gY3QuaWQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBjaGVja1JlcGxhblRyaWdnZXIoYmFzZVBhdGg6IHN0cmluZywgbWlsZXN0b25lSWQ6IHN0cmluZywgc2xpY2VJZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHNsaWNlUm93ID0gZ2V0U2xpY2UobWlsZXN0b25lSWQsIHNsaWNlSWQpO1xuICByZXR1cm4gISFzbGljZVJvdz8ucmVwbGFuX3RyaWdnZXJlZF9hdDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRlcml2ZVN0YXRlRnJvbURiKGJhc2VQYXRoOiBzdHJpbmcpOiBQcm9taXNlPEdTRFN0YXRlPiB7XG4gIGNvbnN0IHJlcXVpcmVtZW50cyA9IGdldFJlcXVpcmVtZW50Q291bnRzKCk7XG5cbiAgY29uc3QgYWxsTWlsZXN0b25lcyA9IGdldEFsbE1pbGVzdG9uZXMoKTtcblxuICBjb25zdCBtaWxlc3RvbmVMb2NrID0gcHJvY2Vzcy5lbnYuR1NEX1BBUkFMTEVMX1dPUktFUiA/IHByb2Nlc3MuZW52LkdTRF9NSUxFU1RPTkVfTE9DSyA6IHVuZGVmaW5lZDtcbiAgY29uc3QgbWlsZXN0b25lcyA9IG1pbGVzdG9uZUxvY2tcbiAgICA/IGFsbE1pbGVzdG9uZXMuZmlsdGVyKG0gPT4gbS5pZCA9PT0gbWlsZXN0b25lTG9jaylcbiAgICA6IGFsbE1pbGVzdG9uZXM7XG5cbiAgaWYgKG1pbGVzdG9uZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogbnVsbCwgYWN0aXZlU2xpY2U6IG51bGwsIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogJ3ByZS1wbGFubmluZycsIHJlY2VudERlY2lzaW9uczogW10sIGJsb2NrZXJzOiBbXSxcbiAgICAgIG5leHRBY3Rpb246ICdObyBtaWxlc3RvbmVzIGZvdW5kLiBSdW4gL2dzZCB0byBjcmVhdGUgb25lLicsXG4gICAgICByZWdpc3RyeTogW10sIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IHsgZG9uZTogMCwgdG90YWw6IDAgfSB9LFxuICAgIH07XG4gIH1cblxuICBjb25zdCB7IGNvbXBsZXRlTWlsZXN0b25lSWRzLCBwYXJrZWRNaWxlc3RvbmVJZHMgfSA9IGJ1aWxkQ29tcGxldGVuZXNzU2V0KGJhc2VQYXRoLCBtaWxlc3RvbmVzKTtcbiAgXG4gIGNvbnN0IHJlZ2lzdHJ5Q29udGV4dCA9IGF3YWl0IGJ1aWxkUmVnaXN0cnlBbmRGaW5kQWN0aXZlKGJhc2VQYXRoLCBtaWxlc3RvbmVzLCBjb21wbGV0ZU1pbGVzdG9uZUlkcywgcGFya2VkTWlsZXN0b25lSWRzKTtcbiAgY29uc3QgeyByZWdpc3RyeSwgYWN0aXZlTWlsZXN0b25lLCBhY3RpdmVNaWxlc3RvbmVTbGljZXMsIGFjdGl2ZU1pbGVzdG9uZUhhc0RyYWZ0IH0gPSByZWdpc3RyeUNvbnRleHQ7XG4gIFxuICBjb25zdCBtaWxlc3RvbmVQcm9ncmVzcyA9IHtcbiAgICBkb25lOiByZWdpc3RyeS5maWx0ZXIoZSA9PiBlLnN0YXR1cyA9PT0gJ2NvbXBsZXRlJykubGVuZ3RoLFxuICAgIHRvdGFsOiByZWdpc3RyeS5sZW5ndGgsXG4gIH07XG5cbiAgaWYgKCFhY3RpdmVNaWxlc3RvbmUpIHtcbiAgICByZXR1cm4gaGFuZGxlTm9BY3RpdmVNaWxlc3RvbmUocmVnaXN0cnksIHJlcXVpcmVtZW50cywgbWlsZXN0b25lUHJvZ3Jlc3MpO1xuICB9XG5cbiAgaWYgKGFjdGl2ZU1pbGVzdG9uZVNsaWNlcy5sZW5ndGggPT09IDApIHtcbiAgICBjb25zdCBwaGFzZSA9IGFjdGl2ZU1pbGVzdG9uZUhhc0RyYWZ0ID8gJ25lZWRzLWRpc2N1c3Npb24nIGFzIGNvbnN0IDogJ3ByZS1wbGFubmluZycgYXMgY29uc3Q7XG4gICAgY29uc3QgbmV4dEFjdGlvbiA9IGFjdGl2ZU1pbGVzdG9uZUhhc0RyYWZ0XG4gICAgICA/IGBEaXNjdXNzIGRyYWZ0IGNvbnRleHQgZm9yIG1pbGVzdG9uZSAke2FjdGl2ZU1pbGVzdG9uZS5pZH0uYFxuICAgICAgOiBgUGxhbiBtaWxlc3RvbmUgJHthY3RpdmVNaWxlc3RvbmUuaWR9LmA7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZSwgYWN0aXZlU2xpY2U6IG51bGwsIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZSwgcmVjZW50RGVjaXNpb25zOiBbXSwgYmxvY2tlcnM6IFtdLFxuICAgICAgbmV4dEFjdGlvbiwgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGFsbFNsaWNlc0RvbmUgPSBhY3RpdmVNaWxlc3RvbmVTbGljZXMuZXZlcnkocyA9PiBpc1N0YXR1c0RvbmUocy5zdGF0dXMpKTtcbiAgY29uc3Qgc2xpY2VQcm9ncmVzcyA9IHtcbiAgICBkb25lOiBhY3RpdmVNaWxlc3RvbmVTbGljZXMuZmlsdGVyKHMgPT4gaXNTdGF0dXNEb25lKHMuc3RhdHVzKSkubGVuZ3RoLFxuICAgIHRvdGFsOiBhY3RpdmVNaWxlc3RvbmVTbGljZXMubGVuZ3RoLFxuICB9O1xuXG4gIGlmIChhbGxTbGljZXNEb25lKSB7XG4gICAgcmV0dXJuIGhhbmRsZUFsbFNsaWNlc0RvbmUoYmFzZVBhdGgsIGFjdGl2ZU1pbGVzdG9uZSwgcmVnaXN0cnksIHJlcXVpcmVtZW50cywgbWlsZXN0b25lUHJvZ3Jlc3MsIHNsaWNlUHJvZ3Jlc3MpO1xuICB9XG5cbiAgY29uc3QgYWN0aXZlU2xpY2VDb250ZXh0ID0gcmVzb2x2ZVNsaWNlRGVwZW5kZW5jaWVzKGFjdGl2ZU1pbGVzdG9uZVNsaWNlcyk7XG4gIGlmICghYWN0aXZlU2xpY2VDb250ZXh0LmFjdGl2ZVNsaWNlKSB7XG4gICAgLy8gSWYgbG9ja2VkIHNsaWNlIHdhc24ndCBmb3VuZCwgaXQgcmV0dXJucyBudWxsIGJ1dCBsb2dzIHdhcm5pbmcsIHdlIG5lZWQgdG8gcmV0dXJuICdibG9ja2VkJ1xuICAgIGNvbnN0IHNsaWNlTG9jayA9IHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVIgPyBwcm9jZXNzLmVudi5HU0RfU0xJQ0VfTE9DSyA6IHVuZGVmaW5lZDtcbiAgICBpZiAoc2xpY2VMb2NrKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3RpdmVNaWxlc3RvbmUsIGFjdGl2ZVNsaWNlOiBudWxsLCBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgICBwaGFzZTogJ2Jsb2NrZWQnLCByZWNlbnREZWNpc2lvbnM6IFtdLCBibG9ja2VyczogW2BHU0RfU0xJQ0VfTE9DSz0ke3NsaWNlTG9ja30gbm90IGZvdW5kIGluIGFjdGl2ZSBtaWxlc3RvbmUgc2xpY2VzYF0sXG4gICAgICAgIG5leHRBY3Rpb246ICdTbGljZSBsb2NrIHJlZmVyZW5jZXMgYSBub24tZXhpc3RlbnQgc2xpY2UgXHUyMDE0IGNoZWNrIG9yY2hlc3RyYXRvciBkaXNwYXRjaC4nLFxuICAgICAgICByZWdpc3RyeSwgcmVxdWlyZW1lbnRzLFxuICAgICAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcywgc2xpY2VzOiBzbGljZVByb2dyZXNzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgYWN0aXZlTWlsZXN0b25lLCBhY3RpdmVTbGljZTogbnVsbCwgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgIHBoYXNlOiAnYmxvY2tlZCcsIHJlY2VudERlY2lzaW9uczogW10sIGJsb2NrZXJzOiBbJ05vIHNsaWNlIGVsaWdpYmxlIFx1MjAxNCBjaGVjayBkZXBlbmRlbmN5IG9yZGVyaW5nJ10sXG4gICAgICBuZXh0QWN0aW9uOiAnUmVzb2x2ZSBkZXBlbmRlbmN5IGJsb2NrZXJzIG9yIHBsYW4gbmV4dCBzbGljZS4nLFxuICAgICAgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLCBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MgfSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IHsgYWN0aXZlU2xpY2UsIGFjdGl2ZVNsaWNlUm93IH0gPSBhY3RpdmVTbGljZUNvbnRleHQ7XG5cbiAgLy8gQURSLTAxMTogREIgc2xpY2UgbWV0YWRhdGEgaXMgYXV0aG9yaXRhdGl2ZSBmb3Igc2tldGNoIHJlZmluZW1lbnQuXG4gIC8vIFBMQU4ubWQgYW5kIHByZWZlcmVuY2UgZmxhZ3MgYXJlIHByb2plY3Rpb25zL2NvbmZpZ3VyYXRpb24gYW5kIGFyZVxuICAvLyBkZWxpYmVyYXRlbHkgbm90IHVzZWQgdG8gaW5mZXIgd2hldGhlciB0aGUgc2xpY2UgaXRzZWxmIGlzIGEgc2tldGNoLlxuICBpZiAoYWN0aXZlU2xpY2VSb3c/LmlzX3NrZXRjaCA9PT0gMSkge1xuICAgIHJldHVybiB7XG4gICAgICBhY3RpdmVNaWxlc3RvbmUsIGFjdGl2ZVNsaWNlLCBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgcGhhc2U6ICdyZWZpbmluZycsIHJlY2VudERlY2lzaW9uczogW10sIGJsb2NrZXJzOiBbXSxcbiAgICAgIG5leHRBY3Rpb246IGBSZWZpbmUgc2tldGNoIHNsaWNlICR7YWN0aXZlU2xpY2UuaWR9ICgke2FjdGl2ZVNsaWNlLnRpdGxlfSkgdXNpbmcgcHJpb3Igc2xpY2UgY29udGV4dC5gLFxuICAgICAgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLCBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgdGFza3MgPSBnZXRTbGljZVRhc2tzKGFjdGl2ZU1pbGVzdG9uZS5pZCwgYWN0aXZlU2xpY2UuaWQpO1xuICBcbiAgY29uc3QgdGFza1Byb2dyZXNzID0ge1xuICAgIGRvbmU6IHRhc2tzLmZpbHRlcih0ID0+IGlzU3RhdHVzRG9uZSh0LnN0YXR1cykpLmxlbmd0aCxcbiAgICB0b3RhbDogdGFza3MubGVuZ3RoLFxuICB9O1xuXG4gIGNvbnN0IGFjdGl2ZVRhc2tSb3cgPSB0YXNrcy5maW5kKHQgPT4gIWlzU3RhdHVzRG9uZSh0LnN0YXR1cykpO1xuXG4gIGlmICghYWN0aXZlVGFza1JvdyAmJiB0YXNrcy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZSwgYWN0aXZlU2xpY2UsIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogJ3N1bW1hcml6aW5nJywgcmVjZW50RGVjaXNpb25zOiBbXSwgYmxvY2tlcnM6IFtdLFxuICAgICAgbmV4dEFjdGlvbjogYEFsbCB0YXNrcyBkb25lIGluICR7YWN0aXZlU2xpY2UuaWR9LiBXcml0ZSBzbGljZSBzdW1tYXJ5IGFuZCBjb21wbGV0ZSBzbGljZS5gLFxuICAgICAgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLCBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MsIHRhc2tzOiB0YXNrUHJvZ3Jlc3MgfSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKCFhY3RpdmVUYXNrUm93KSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZSwgYWN0aXZlU2xpY2UsIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogJ3BsYW5uaW5nJywgcmVjZW50RGVjaXNpb25zOiBbXSwgYmxvY2tlcnM6IFtdLFxuICAgICAgbmV4dEFjdGlvbjogYFNsaWNlICR7YWN0aXZlU2xpY2UuaWR9IGhhcyBubyBEQiB0YXNrcy4gUGxhbiBzbGljZSB0YXNrcyBiZWZvcmUgZXhlY3V0aW9uLmAsXG4gICAgICByZWdpc3RyeSwgcmVxdWlyZW1lbnRzLFxuICAgICAgcHJvZ3Jlc3M6IHsgbWlsZXN0b25lczogbWlsZXN0b25lUHJvZ3Jlc3MsIHNsaWNlczogc2xpY2VQcm9ncmVzcywgdGFza3M6IHRhc2tQcm9ncmVzcyB9LFxuICAgIH07XG4gIH1cblxuICBjb25zdCBhY3RpdmVUYXNrOiBBY3RpdmVSZWYgPSB7IGlkOiBhY3RpdmVUYXNrUm93LmlkLCB0aXRsZTogYWN0aXZlVGFza1Jvdy50aXRsZSB9O1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBRdWFsaXR5IGdhdGUgZXZhbHVhdGlvbiBjaGVjayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gUGF1c2UgYmVmb3JlIGV4ZWN1dGlvbiBvbmx5IHdoZW4gZ2F0ZXMgb3duZWQgYnkgdGhlIGBnYXRlLWV2YWx1YXRlYFxuICAvLyB0dXJuIChRMy9RNCkgYXJlIHN0aWxsIHBlbmRpbmcuIFE4IGlzIGFsc28gYHNjb3BlOlwic2xpY2VcImAgYnV0IGlzXG4gIC8vIG93bmVkIGJ5IGBjb21wbGV0ZS1zbGljZWAsIHNvIGl0IG11c3QgTk9UIGJsb2NrIHRoZSBldmFsdWF0aW5nLWdhdGVzXG4gIC8vIHBoYXNlIFx1MjAxNCBvdGhlcndpc2UgYXV0by1sb29wIHN0YWxscyBmb3JldmVyIHdhaXRpbmcgZm9yIGEgZ2F0ZSB0aGF0XG4gIC8vIHRoaXMgdHVybiBuZXZlciBldmFsdWF0ZXMuIFNlZSBnYXRlLXJlZ2lzdHJ5LnRzIGZvciB0aGUgb3duZXJzaGlwIG1hcC5cbiAgLy8gU2xpY2VzIHdpdGggemVybyBnYXRlIHJvd3MgKHByZS1mZWF0dXJlIG9yIHNpbXBsZSkgc2tpcCBzdHJhaWdodCB0aHJvdWdoLlxuICBjb25zdCBwZW5kaW5nR2F0ZUNvdW50ID0gZ2V0UGVuZGluZ0dhdGVDb3VudEZvclR1cm4oXG4gICAgYWN0aXZlTWlsZXN0b25lLmlkLFxuICAgIGFjdGl2ZVNsaWNlLmlkLFxuICAgIFwiZ2F0ZS1ldmFsdWF0ZVwiLFxuICApO1xuICBpZiAocGVuZGluZ0dhdGVDb3VudCA+IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aXZlTWlsZXN0b25lLCBhY3RpdmVTbGljZSwgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgIHBoYXNlOiAnZXZhbHVhdGluZy1nYXRlcycsIHJlY2VudERlY2lzaW9uczogW10sIGJsb2NrZXJzOiBbXSxcbiAgICAgIG5leHRBY3Rpb246IGBFdmFsdWF0ZSAke3BlbmRpbmdHYXRlQ291bnR9IHF1YWxpdHkgZ2F0ZShzKSBmb3IgJHthY3RpdmVTbGljZS5pZH0gYmVmb3JlIGV4ZWN1dGlvbi5gLFxuICAgICAgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLCBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MsIHRhc2tzOiB0YXNrUHJvZ3Jlc3MgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgYmxvY2tlclRhc2tJZCA9IGF3YWl0IGRldGVjdEJsb2NrZXJzKGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUuaWQsIGFjdGl2ZVNsaWNlLmlkLCB0YXNrcyk7XG4gIGlmIChibG9ja2VyVGFza0lkKSB7XG4gICAgY29uc3QgcmVwbGFuSGlzdG9yeSA9IGdldFJlcGxhbkhpc3RvcnkoYWN0aXZlTWlsZXN0b25lLmlkLCBhY3RpdmVTbGljZS5pZCk7XG4gICAgaWYgKHJlcGxhbkhpc3RvcnkubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3RpdmVNaWxlc3RvbmUsIGFjdGl2ZVNsaWNlLCBhY3RpdmVUYXNrLFxuICAgICAgICBwaGFzZTogJ3JlcGxhbm5pbmctc2xpY2UnLCByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgICBibG9ja2VyczogW2BUYXNrICR7YmxvY2tlclRhc2tJZH0gZGlzY292ZXJlZCBhIGJsb2NrZXIgcmVxdWlyaW5nIHNsaWNlIHJlcGxhbmBdLFxuICAgICAgICBuZXh0QWN0aW9uOiBgVGFzayAke2Jsb2NrZXJUYXNrSWR9IHJlcG9ydGVkIGJsb2NrZXJfZGlzY292ZXJlZC4gUmVwbGFuIHNsaWNlICR7YWN0aXZlU2xpY2UuaWR9IGJlZm9yZSBjb250aW51aW5nLmAsXG4gICAgICAgIGFjdGl2ZVdvcmtzcGFjZTogdW5kZWZpbmVkLFxuICAgICAgICByZWdpc3RyeSwgcmVxdWlyZW1lbnRzLFxuICAgICAgICBwcm9ncmVzczogeyBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcywgc2xpY2VzOiBzbGljZVByb2dyZXNzLCB0YXNrczogdGFza1Byb2dyZXNzIH0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIC8vIEFEUi0wMTEgUGhhc2UgMjogcGF1c2Utb24tZXNjYWxhdGlvbiB0YWtlcyBwcmVjZWRlbmNlIG92ZXIgZGlzcGF0Y2hpbmcgdGhlXG4gIC8vIG5leHQgdGFzay4gYGF3YWl0aW5nX3Jldmlld2AgdGFza3MgKGNvbnRpbnVlV2l0aERlZmF1bHQ9dHJ1ZSkgYXJlIE5PVFxuICAvLyBzdXJmYWNlZCBoZXJlIFx1MjAxNCB0aGV5IGxldCB0aGUgbG9vcCBjb250aW51ZS5cbiAgLy9cbiAgLy8gV2UgZG8gTk9UIGdhdGUgdGhpcyBvbiBgcGhhc2VzLm1pZF9leGVjdXRpb25fZXNjYWxhdGlvbmAgXHUyMDE0IGNyZWF0aW9uIG9mXG4gIC8vIG5ldyBlc2NhbGF0aW9ucyBpcyBnYXRlZCBhdCB0aGUgd3JpdGUgc2l0ZSAodG9vbHMvY29tcGxldGUtdGFzay50czozMTUpLFxuICAvLyBidXQgYW55IGVzY2FsYXRpb25fcGVuZGluZyByb3cgYWxyZWFkeSBwZXJzaXN0ZWQgaW4gdGhlIERCIG11c3QgYmVcbiAgLy8gaG9ub3JlZCBldmVuIGlmIHRoZSB1c2VyIGxhdGVyIHRvZ2dsZXMgdGhlIGZsYWcgb2ZmLiBPdGhlcndpc2UgdGhvc2VcbiAgLy8gcm93cyB3b3VsZCBzaWxlbnRseSBvcnBoYW4sIHRoZSBsb29wIHdvdWxkIGFkdmFuY2UgcGFzdCB0aGUgcGF1c2VkIHRhc2ssXG4gIC8vIGFuZCB0aGUgdXNlcidzIHByaW9yIHJlc29sdXRpb24gbmV2ZXIgbGFuZHMuXG4gIGNvbnN0IGVzY2FsYXRpbmdUYXNrSWQgPSBkZXRlY3RQZW5kaW5nRXNjYWxhdGlvbih0YXNrcywgYmFzZVBhdGgpO1xuICBpZiAoZXNjYWxhdGluZ1Rhc2tJZCkge1xuICAgIHJldHVybiB7XG4gICAgICBhY3RpdmVNaWxlc3RvbmUsIGFjdGl2ZVNsaWNlLCBhY3RpdmVUYXNrLFxuICAgICAgcGhhc2U6ICdlc2NhbGF0aW5nLXRhc2snLCByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgYmxvY2tlcnM6IFtgVGFzayAke2VzY2FsYXRpbmdUYXNrSWR9IHJlcXVpcmVzIGEgdXNlciBkZWNpc2lvbiBiZWZvcmUgdGhlIGxvb3AgY2FuIHByb2NlZWRgXSxcbiAgICAgIG5leHRBY3Rpb246IGBSdW4gL2dzZCBlc2NhbGF0ZSBzaG93ICR7ZXNjYWxhdGluZ1Rhc2tJZH0gdG8gcmV2aWV3LCB0aGVuIC9nc2QgZXNjYWxhdGUgcmVzb2x2ZSAke2VzY2FsYXRpbmdUYXNrSWR9IDxjaG9pY2U+IHRvIHByb2NlZWQuYCxcbiAgICAgIGFjdGl2ZVdvcmtzcGFjZTogdW5kZWZpbmVkLFxuICAgICAgcmVnaXN0cnksIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLCBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MsIHRhc2tzOiB0YXNrUHJvZ3Jlc3MgfSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKCFibG9ja2VyVGFza0lkKSB7XG4gICAgY29uc3QgaXNUcmlnZ2VyZWQgPSBjaGVja1JlcGxhblRyaWdnZXIoYmFzZVBhdGgsIGFjdGl2ZU1pbGVzdG9uZS5pZCwgYWN0aXZlU2xpY2UuaWQpO1xuICAgIGlmIChpc1RyaWdnZXJlZCkge1xuICAgICAgY29uc3QgcmVwbGFuSGlzdG9yeSA9IGdldFJlcGxhbkhpc3RvcnkoYWN0aXZlTWlsZXN0b25lLmlkLCBhY3RpdmVTbGljZS5pZCk7XG4gICAgICBpZiAocmVwbGFuSGlzdG9yeS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBhY3RpdmVNaWxlc3RvbmUsIGFjdGl2ZVNsaWNlLCBhY3RpdmVUYXNrLFxuICAgICAgICAgIHBoYXNlOiAncmVwbGFubmluZy1zbGljZScsIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICAgICAgYmxvY2tlcnM6IFsnVHJpYWdlIHJlcGxhbiB0cmlnZ2VyIGRldGVjdGVkIFx1MjAxNCBzbGljZSByZXBsYW4gcmVxdWlyZWQnXSxcbiAgICAgICAgICBuZXh0QWN0aW9uOiBgVHJpYWdlIHJlcGxhbiB0cmlnZ2VyZWQgZm9yIHNsaWNlICR7YWN0aXZlU2xpY2UuaWR9LiBSZXBsYW4gYmVmb3JlIGNvbnRpbnVpbmcuYCxcbiAgICAgICAgICBhY3RpdmVXb3Jrc3BhY2U6IHVuZGVmaW5lZCxcbiAgICAgICAgICByZWdpc3RyeSwgcmVxdWlyZW1lbnRzLFxuICAgICAgICAgIHByb2dyZXNzOiB7IG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLCBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MsIHRhc2tzOiB0YXNrUHJvZ3Jlc3MgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGFjdGl2ZU1pbGVzdG9uZSwgYWN0aXZlU2xpY2UsIGFjdGl2ZVRhc2ssXG4gICAgcGhhc2U6ICdleGVjdXRpbmcnLCByZWNlbnREZWNpc2lvbnM6IFtdLCBibG9ja2VyczogW10sXG4gICAgbmV4dEFjdGlvbjogYEV4ZWN1dGUgJHthY3RpdmVUYXNrLmlkfTogJHthY3RpdmVUYXNrLnRpdGxlfSBpbiBzbGljZSAke2FjdGl2ZVNsaWNlLmlkfS5gLFxuICAgIHJlZ2lzdHJ5LCByZXF1aXJlbWVudHMsXG4gICAgcHJvZ3Jlc3M6IHsgbWlsZXN0b25lczogbWlsZXN0b25lUHJvZ3Jlc3MsIHNsaWNlczogc2xpY2VQcm9ncmVzcywgdGFza3M6IHRhc2tQcm9ncmVzcyB9LFxuICB9O1xufVxuXG5cbi8vIExFR0FDWTogRmlsZXN5c3RlbS1iYXNlZCBzdGF0ZSBkZXJpdmF0aW9uIGZvciB1bm1pZ3JhdGVkIHByb2plY3RzLlxuLy8gREItYmFja2VkIHByb2plY3RzIHVzZSBkZXJpdmVTdGF0ZUZyb21EYigpIGFib3ZlLiBUYXJnZXQ6IGV4dHJhY3QgdG9cbi8vIHN0YXRlLWxlZ2FjeS50cyB3aGVuIGFsbCBwcm9qZWN0cyBhcmUgREItYmFja2VkLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIF9kZXJpdmVTdGF0ZUltcGwoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG9wdHM/OiBEZXJpdmVTdGF0ZU9wdGlvbnMsXG4pOiBQcm9taXNlPEdTRFN0YXRlPiB7XG4gIC8vIFdoZW4gdGhlIGNhbGxlciBzdXBwbGllcyBhIGNhbm9uaWNhbCBwcm9qZWN0IHJvb3QgZm9yIHJlYWRzIChlLmcuXG4gIC8vIHMuY2Fub25pY2FsUHJvamVjdFJvb3QgZnJvbSBhdXRvLW1vZGUpLCByb3V0ZSBhbGwgYXJ0aWZhY3QgcmVhZHMgdGhyb3VnaFxuICAvLyBpdC4gVGhpcyBwcmV2ZW50cyB0aGUgd29ya3RyZWUtbG9jYWwgZW1wdHkgYC5nc2QvYCBmcm9tIGJlaW5nIGNvbnN1bHRlZFxuICAvLyB3aGVuIHRoZSBjYW5vbmljYWwgc3RhdGUgbGl2ZXMgYXQgdGhlIHByb2plY3Qgcm9vdCAob3IgdmlhIGEgYC5nc2RgXG4gIC8vIHN5bWxpbmsgaW50byB0aGUgZXh0ZXJuYWwgc3RhdGUgZGlyKS5cbiAgaWYgKG9wdHM/LnByb2plY3RSb290Rm9yUmVhZHMpIHtcbiAgICBiYXNlUGF0aCA9IG9wdHMucHJvamVjdFJvb3RGb3JSZWFkcztcbiAgfVxuXG4gIGNvbnN0IGRpc2tJZHMgPSBmaW5kTWlsZXN0b25lSWRzKGJhc2VQYXRoKTtcbiAgY29uc3QgY3VzdG9tT3JkZXIgPSBsb2FkUXVldWVPcmRlcihiYXNlUGF0aCk7XG4gIGNvbnN0IG1pbGVzdG9uZUlkcyA9IHNvcnRCeVF1ZXVlT3JkZXIoZGlza0lkcywgY3VzdG9tT3JkZXIpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBQYXJhbGxlbCB3b3JrZXIgaXNvbGF0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBXaGVuIEdTRF9QQVJBTExFTF9XT1JLRVIgYW5kIEdTRF9NSUxFU1RPTkVfTE9DSyBhcmUgc2V0LCB0aGlzIHByb2Nlc3MgaXMgYSBwYXJhbGxlbCB3b3JrZXJcbiAgLy8gc2NvcGVkIHRvIGEgc2luZ2xlIG1pbGVzdG9uZS4gRmlsdGVyIHRoZSBtaWxlc3RvbmUgbGlzdCBzbyB0aGlzIHdvcmtlclxuICAvLyBvbmx5IHNlZXMgaXRzIGFzc2lnbmVkIG1pbGVzdG9uZSAoYWxsIG90aGVycyBhcmUgdHJlYXRlZCBhcyBpZiB0aGV5XG4gIC8vIGRvbid0IGV4aXN0KS4gVGhpcyBnaXZlcyBlYWNoIHdvcmtlciBjb21wbGV0ZSBpc29sYXRpb24gd2l0aG91dFxuICAvLyBtb2RpZnlpbmcgYW55IG90aGVyIHN0YXRlIGRlcml2YXRpb24gbG9naWMuXG4gIGNvbnN0IG1pbGVzdG9uZUxvY2sgPSBwcm9jZXNzLmVudi5HU0RfUEFSQUxMRUxfV09SS0VSID8gcHJvY2Vzcy5lbnYuR1NEX01JTEVTVE9ORV9MT0NLIDogdW5kZWZpbmVkO1xuICBpZiAobWlsZXN0b25lTG9jayAmJiBtaWxlc3RvbmVJZHMuaW5jbHVkZXMobWlsZXN0b25lTG9jaykpIHtcbiAgICBtaWxlc3RvbmVJZHMubGVuZ3RoID0gMDtcbiAgICBtaWxlc3RvbmVJZHMucHVzaChtaWxlc3RvbmVMb2NrKTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBCYXRjaC1wYXJzZSBmaWxlIGNhY2hlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBXaGVuIHRoZSBuYXRpdmUgUnVzdCBwYXJzZXIgaXMgYXZhaWxhYmxlLCByZWFkIGV2ZXJ5IC5tZCBmaWxlIHVuZGVyIC5nc2QvXG4gIC8vIGluIG9uZSBjYWxsIGFuZCBidWlsZCBhbiBpbi1tZW1vcnkgY29udGVudCBtYXAga2V5ZWQgYnkgYWJzb2x1dGUgcGF0aC5cbiAgLy8gVGhpcyBlbGltaW5hdGVzIE8oTikgaW5kaXZpZHVhbCBmcy5yZWFkRmlsZSBjYWxscyBkdXJpbmcgdHJhdmVyc2FsLlxuICBjb25zdCBmaWxlQ29udGVudENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgY29uc3QgZ3NkRGlyID0gZ3NkUm9vdChiYXNlUGF0aCk7XG5cbiAgLy8gRmlsZXN5c3RlbSBmYWxsYmFjazogdXNlZCB3aGVuIGRlcml2ZVN0YXRlRnJvbURiKCkgaXMgbm90IGF2YWlsYWJsZVxuICAvLyAocHJlLW1pZ3JhdGlvbiBwcm9qZWN0cykuIFRoZSBEQi1iYWNrZWQgcGF0aCBpcyBwcmVmZXJyZWQgd2hlbiBhdmFpbGFibGVcbiAgLy8gXHUyMDE0IHNlZSBkZXJpdmVTdGF0ZUZyb21EYigpIGFib3ZlLlxuICBjb25zdCBiYXRjaEZpbGVzID0gbmF0aXZlQmF0Y2hQYXJzZUdzZEZpbGVzKGdzZERpcik7XG4gIGlmIChiYXRjaEZpbGVzKSB7XG4gICAgZm9yIChjb25zdCBmIG9mIGJhdGNoRmlsZXMpIHtcbiAgICAgIGNvbnN0IGFic1BhdGggPSByZXNvbHZlKGdzZERpciwgZi5wYXRoKTtcbiAgICAgIGZpbGVDb250ZW50Q2FjaGUuc2V0KGFic1BhdGgsIGYucmF3Q29udGVudCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIExvYWQgZmlsZSBjb250ZW50IGZyb20gYmF0Y2ggY2FjaGUgZmlyc3QsIGZhbGxpbmcgYmFjayB0byBkaXNrIHJlYWQuXG4gICAqIFJlc29sdmVzIHRoZSBwYXRoIHRvIGFic29sdXRlIGJlZm9yZSBjYWNoZSBsb29rdXAuXG4gICAqL1xuICBhc3luYyBmdW5jdGlvbiBjYWNoZWRMb2FkRmlsZShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBhdGgpO1xuICAgIGNvbnN0IGNhY2hlZCA9IGZpbGVDb250ZW50Q2FjaGUuZ2V0KGFicyk7XG4gICAgaWYgKGNhY2hlZCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gY2FjaGVkO1xuICAgIHJldHVybiBsb2FkRmlsZShwYXRoKTtcbiAgfVxuXG4gIGNvbnN0IHJlcXVpcmVtZW50cyA9IHBhcnNlUmVxdWlyZW1lbnRDb3VudHMoYXdhaXQgY2FjaGVkTG9hZEZpbGUocmVzb2x2ZUdzZFJvb3RGaWxlKGJhc2VQYXRoLCBcIlJFUVVJUkVNRU5UU1wiKSkpO1xuXG4gIGlmIChtaWxlc3RvbmVJZHMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZTogbnVsbCxcbiAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgIHBoYXNlOiAncHJlLXBsYW5uaW5nJyxcbiAgICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgICBuZXh0QWN0aW9uOiAnTm8gbWlsZXN0b25lcyBmb3VuZC4gUnVuIC9nc2QgdG8gY3JlYXRlIG9uZS4nLFxuICAgICAgcmVnaXN0cnk6IFtdLFxuICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgbWlsZXN0b25lczogeyBkb25lOiAwLCB0b3RhbDogMCB9LFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFNpbmdsZS1wYXNzIG1pbGVzdG9uZSBzY2FuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBQYXJzZSBlYWNoIG1pbGVzdG9uZSdzIHJvYWRtYXAgb25jZSwgY2FjaGluZyByZXN1bHRzLiBGaXJzdCBwYXNzIGRldGVybWluZXNcbiAgLy8gY29tcGxldGVuZXNzIGZvciBkZXBlbmRlbmN5IHJlc29sdXRpb247IHNlY29uZCBwYXNzIGJ1aWxkcyB0aGUgcmVnaXN0cnkuXG4gIC8vIFdpdGggdGhlIGJhdGNoIGNhY2hlLCBhbGwgZmlsZSByZWFkcyBoaXQgbWVtb3J5IGluc3RlYWQgb2YgZGlzay5cblxuICAvLyBQaGFzZSAxOiBCdWlsZCByb2FkbWFwIGNhY2hlIGFuZCBjb21wbGV0ZW5lc3Mgc2V0XG4gIGNvbnN0IHJvYWRtYXBDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBSb2FkbWFwPigpO1xuICBjb25zdCBjb21wbGV0ZU1pbGVzdG9uZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIC8vIFRyYWNrIHBhcmtlZCBtaWxlc3RvbmUgSURzIHNvIFBoYXNlIDIgY2FuIGNoZWNrIHdpdGhvdXQgcmUtcmVhZGluZyBkaXNrXG4gIGNvbnN0IHBhcmtlZE1pbGVzdG9uZUlkcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGZvciAoY29uc3QgbWlkIG9mIG1pbGVzdG9uZUlkcykge1xuICAgIC8vIFNraXAgcGFya2VkIG1pbGVzdG9uZXMgXHUyMDE0IHRoZXkgZG8gTk9UIGNvdW50IGFzIGNvbXBsZXRlIChkb24ndCBzYXRpc2Z5IGRlcGVuZHNfb24pXG4gICAgLy8gQnV0IHN0aWxsIHBhcnNlIHRoZWlyIHJvYWRtYXAgZm9yIHRpdGxlIGV4dHJhY3Rpb24gaW4gUGhhc2UgMi5cbiAgICBjb25zdCBwYXJrZWRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJQQVJLRURcIik7XG4gICAgaWYgKHBhcmtlZEZpbGUpIHtcbiAgICAgIHBhcmtlZE1pbGVzdG9uZUlkcy5hZGQobWlkKTtcbiAgICAgIC8vIENhY2hlIHJvYWRtYXAgZm9yIHRpdGxlIGV4dHJhY3Rpb24gKGJ1dCBkb24ndCBhZGQgdG8gY29tcGxldGVNaWxlc3RvbmVJZHMpXG4gICAgICBjb25zdCBwcmYgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIlJPQURNQVBcIik7XG4gICAgICBjb25zdCBwcmMgPSBwcmYgPyBhd2FpdCBjYWNoZWRMb2FkRmlsZShwcmYpIDogbnVsbDtcbiAgICAgIGlmIChwcmMpIHJvYWRtYXBDYWNoZS5zZXQobWlkLCBwYXJzZVJvYWRtYXAocHJjKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCByZiA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiUk9BRE1BUFwiKTtcbiAgICBjb25zdCByYyA9IHJmID8gYXdhaXQgY2FjaGVkTG9hZEZpbGUocmYpIDogbnVsbDtcbiAgICBpZiAoIXJjKSB7XG4gICAgICBjb25zdCBzZiA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgIGlmIChzZiAmJiBhd2FpdCBpc1Rlcm1pbmFsTWlsZXN0b25lU3VtbWFyeUZpbGUoc2YsIGNhY2hlZExvYWRGaWxlKSkgY29tcGxldGVNaWxlc3RvbmVJZHMuYWRkKG1pZCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3Qgcm1hcCA9IHBhcnNlUm9hZG1hcChyYyk7XG4gICAgcm9hZG1hcENhY2hlLnNldChtaWQsIHJtYXApO1xuICAgIGlmICghaXNNaWxlc3RvbmVDb21wbGV0ZShybWFwKSkge1xuICAgICAgLy8gU3VtbWFyeSBpcyB0aGUgdGVybWluYWwgYXJ0aWZhY3QgXHUyMDE0IGlmIGl0IGV4aXN0cywgdGhlIG1pbGVzdG9uZSBpc1xuICAgICAgLy8gY29tcGxldGUgZXZlbiB3aGVuIHJvYWRtYXAgY2hlY2tib3hlcyB3ZXJlbid0IHRpY2tlZCAoIzg2NCkuXG4gICAgICBjb25zdCBzZiA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgIGlmIChzZiAmJiBhd2FpdCBpc1Rlcm1pbmFsTWlsZXN0b25lU3VtbWFyeUZpbGUoc2YsIGNhY2hlZExvYWRGaWxlKSkgY29tcGxldGVNaWxlc3RvbmVJZHMuYWRkKG1pZCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3Qgc2YgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIlNVTU1BUllcIik7XG4gICAgaWYgKHNmICYmIGF3YWl0IGlzVGVybWluYWxNaWxlc3RvbmVTdW1tYXJ5RmlsZShzZiwgY2FjaGVkTG9hZEZpbGUpKSBjb21wbGV0ZU1pbGVzdG9uZUlkcy5hZGQobWlkKTtcbiAgfVxuXG4gIC8vIFBoYXNlIDI6IEJ1aWxkIHJlZ2lzdHJ5IHVzaW5nIGNhY2hlZCByb2FkbWFwcyAobm8gcmUtcGFyc2luZyBvciByZS1yZWFkaW5nKVxuICBjb25zdCByZWdpc3RyeTogTWlsZXN0b25lUmVnaXN0cnlFbnRyeVtdID0gW107XG4gIGxldCBhY3RpdmVNaWxlc3RvbmU6IEFjdGl2ZVJlZiB8IG51bGwgPSBudWxsO1xuICBsZXQgYWN0aXZlUm9hZG1hcDogUm9hZG1hcCB8IG51bGwgPSBudWxsO1xuICBsZXQgYWN0aXZlTWlsZXN0b25lRm91bmQgPSBmYWxzZTtcbiAgbGV0IGFjdGl2ZU1pbGVzdG9uZUhhc0RyYWZ0ID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBtaWQgb2YgbWlsZXN0b25lSWRzKSB7XG4gICAgLy8gU2tpcCBwYXJrZWQgbWlsZXN0b25lcyBcdTIwMTQgcmVnaXN0ZXIgdGhlbSBhcyAncGFya2VkJyBhbmQgbW92ZSBvblxuICAgIGlmIChwYXJrZWRNaWxlc3RvbmVJZHMuaGFzKG1pZCkpIHtcbiAgICAgIGNvbnN0IHJvYWRtYXAgPSByb2FkbWFwQ2FjaGUuZ2V0KG1pZCkgPz8gbnVsbDtcbiAgICAgIGNvbnN0IHRpdGxlID0gcm9hZG1hcFxuICAgICAgICA/IHN0cmlwTWlsZXN0b25lUHJlZml4KHJvYWRtYXAudGl0bGUpXG4gICAgICAgIDogbWlkO1xuICAgICAgcmVnaXN0cnkucHVzaCh7IGlkOiBtaWQsIHRpdGxlLCBzdGF0dXM6ICdwYXJrZWQnIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3Qgcm9hZG1hcCA9IHJvYWRtYXBDYWNoZS5nZXQobWlkKSA/PyBudWxsO1xuXG4gICAgaWYgKCFyb2FkbWFwKSB7XG4gICAgICAvLyBObyByb2FkbWFwIFx1MjAxNCBjaGVjayBpZiBhIHN1bW1hcnkgZXhpc3RzIChjb21wbGV0ZWQgbWlsZXN0b25lIHdpdGhvdXQgcm9hZG1hcClcbiAgICAgIGNvbnN0IHN1bW1hcnlGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJTVU1NQVJZXCIpO1xuICAgICAgaWYgKHN1bW1hcnlGaWxlKSB7XG4gICAgICAgIGNvbnN0IHN1bW1hcnlDb250ZW50ID0gYXdhaXQgY2FjaGVkTG9hZEZpbGUoc3VtbWFyeUZpbGUpO1xuICAgICAgICBpZiAoc3VtbWFyeUNvbnRlbnQgIT0gbnVsbCAmJiBpc1Rlcm1pbmFsTWlsZXN0b25lU3VtbWFyeUNvbnRlbnQoc3VtbWFyeUNvbnRlbnQpKSB7XG4gICAgICAgICAgY29uc3Qgc3VtbWFyeVRpdGxlID0gc3VtbWFyeUNvbnRlbnRcbiAgICAgICAgICAgID8gKHBhcnNlU3VtbWFyeShzdW1tYXJ5Q29udGVudCkudGl0bGUgfHwgbWlkKVxuICAgICAgICAgICAgOiBtaWQ7XG4gICAgICAgICAgcmVnaXN0cnkucHVzaCh7IGlkOiBtaWQsIHRpdGxlOiBzdW1tYXJ5VGl0bGUsIHN0YXR1czogJ2NvbXBsZXRlJyB9KTtcbiAgICAgICAgICBjb21wbGV0ZU1pbGVzdG9uZUlkcy5hZGQobWlkKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gR2hvc3QgbWlsZXN0b25lIChvbmx5IE1FVEEuanNvbiwgbm8gQ09OVEVYVC9ST0FETUFQL1NVTU1BUlkpIFx1MjAxNCBza2lwIGVudGlyZWx5XG4gICAgICBpZiAoaXNHaG9zdE1pbGVzdG9uZShiYXNlUGF0aCwgbWlkKSkgY29udGludWU7XG5cbiAgICAgIC8vIE5vIHJvYWRtYXAgYW5kIG5vIHN1bW1hcnkgXHUyMDE0IHRyZWF0IGFzIGluY29tcGxldGUvYWN0aXZlXG4gICAgICBpZiAoIWFjdGl2ZU1pbGVzdG9uZUZvdW5kKSB7XG4gICAgICAgIC8vIENoZWNrIGZvciBDT05URVhULURSQUZULm1kIHRvIGRpc3Rpbmd1aXNoIGRyYWZ0LXNlZWRlZCBmcm9tIGJsYW5rIG1pbGVzdG9uZXMuXG4gICAgICAgIC8vIEEgZHJhZnQgc2VlZCBtZWFucyB0aGUgbWlsZXN0b25lIGhhcyBkaXNjdXNzaW9uIG1hdGVyaWFsIGJ1dCBubyBmdWxsIGNvbnRleHQgeWV0LlxuICAgICAgICBjb25zdCBjb250ZXh0RmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgICAgY29uc3QgZHJhZnRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJDT05URVhULURSQUZUXCIpO1xuICAgICAgICBpZiAoIWNvbnRleHRGaWxlICYmIGRyYWZ0RmlsZSkgYWN0aXZlTWlsZXN0b25lSGFzRHJhZnQgPSB0cnVlO1xuXG4gICAgICAgIC8vIEV4dHJhY3QgdGl0bGUgZnJvbSBDT05URVhULm1kIG9yIENPTlRFWFQtRFJBRlQubWQgaGVhZGluZyBiZWZvcmUgZmFsbGluZyBiYWNrIHRvIG1pZC5cbiAgICAgICAgY29uc3QgY29udGV4dENvbnRlbnQgPSBjb250ZXh0RmlsZSA/IGF3YWl0IGNhY2hlZExvYWRGaWxlKGNvbnRleHRGaWxlKSA6IG51bGw7XG4gICAgICAgIGNvbnN0IGRyYWZ0Q29udGVudCA9IGRyYWZ0RmlsZSAmJiAhY29udGV4dENvbnRlbnQgPyBhd2FpdCBjYWNoZWRMb2FkRmlsZShkcmFmdEZpbGUpIDogbnVsbDtcbiAgICAgICAgY29uc3QgdGl0bGUgPSBleHRyYWN0Q29udGV4dFRpdGxlKGNvbnRleHRDb250ZW50IHx8IGRyYWZ0Q29udGVudCwgbWlkKTtcblxuICAgICAgICAvLyBDaGVjayBtaWxlc3RvbmUtbGV2ZWwgZGVwZW5kZW5jaWVzIGJlZm9yZSBwcm9tb3RpbmcgdG8gYWN0aXZlLlxuICAgICAgICAvLyBXaXRob3V0IHRoaXMsIGEgcXVldWVkIG1pbGVzdG9uZSB3aXRoIGRlcGVuZHNfb24gaW4gaXRzIENPTlRFWFRcbiAgICAgICAgLy8gb3IgQ09OVEVYVC1EUkFGVCBmcm9udG1hdHRlciB3b3VsZCBiZSBwcm9tb3RlZCB0byBhY3RpdmUgZXZlbiB3aGVuXG4gICAgICAgIC8vIGl0cyBkZXBzIGFyZSB1bm1ldC4gRmFsbCBiYWNrIHRvIENPTlRFWFQtRFJBRlQubWQgd2hlbiBhYnNlbnQgKCMxNzI0KS5cbiAgICAgICAgY29uc3QgZGVwcyA9IHBhcnNlQ29udGV4dERlcGVuZHNPbihjb250ZXh0Q29udGVudCA/PyBkcmFmdENvbnRlbnQpO1xuICAgICAgICBjb25zdCBkZXBzVW5tZXQgPSBkZXBzLnNvbWUoZGVwID0+ICFjb21wbGV0ZU1pbGVzdG9uZUlkcy5oYXMoZGVwKSk7XG4gICAgICAgIGlmIChkZXBzVW5tZXQpIHtcbiAgICAgICAgICByZWdpc3RyeS5wdXNoKHsgaWQ6IG1pZCwgdGl0bGUsIHN0YXR1czogJ3BlbmRpbmcnLCBkZXBlbmRzT246IGRlcHMgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgYWN0aXZlTWlsZXN0b25lID0geyBpZDogbWlkLCB0aXRsZSB9O1xuICAgICAgICAgIGFjdGl2ZU1pbGVzdG9uZUZvdW5kID0gdHJ1ZTtcbiAgICAgICAgICByZWdpc3RyeS5wdXNoKHsgaWQ6IG1pZCwgdGl0bGUsIHN0YXR1czogJ2FjdGl2ZScsIC4uLihkZXBzLmxlbmd0aCA+IDAgPyB7IGRlcGVuZHNPbjogZGVwcyB9IDoge30pIH0pO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBGb3IgbWlsZXN0b25lcyBhZnRlciB0aGUgYWN0aXZlIG9uZSwgYWxzbyB0cnkgdG8gZXh0cmFjdCB0aXRsZSBmcm9tIGNvbnRleHQgZmlsZXMuXG4gICAgICAgIGNvbnN0IGNvbnRleHRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJDT05URVhUXCIpO1xuICAgICAgICBjb25zdCBkcmFmdEZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIkNPTlRFWFQtRFJBRlRcIik7XG4gICAgICAgIGNvbnN0IGNvbnRleHRDb250ZW50ID0gY29udGV4dEZpbGUgPyBhd2FpdCBjYWNoZWRMb2FkRmlsZShjb250ZXh0RmlsZSkgOiBudWxsO1xuICAgICAgICBjb25zdCBkcmFmdENvbnRlbnQgPSBkcmFmdEZpbGUgJiYgIWNvbnRleHRDb250ZW50ID8gYXdhaXQgY2FjaGVkTG9hZEZpbGUoZHJhZnRGaWxlKSA6IG51bGw7XG4gICAgICAgIGNvbnN0IHRpdGxlID0gZXh0cmFjdENvbnRleHRUaXRsZShjb250ZXh0Q29udGVudCB8fCBkcmFmdENvbnRlbnQsIG1pZCk7XG4gICAgICAgIHJlZ2lzdHJ5LnB1c2goeyBpZDogbWlkLCB0aXRsZSwgc3RhdHVzOiAncGVuZGluZycgfSk7XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB0aXRsZSA9IHN0cmlwTWlsZXN0b25lUHJlZml4KHJvYWRtYXAudGl0bGUpO1xuICAgIGNvbnN0IGNvbXBsZXRlID0gaXNNaWxlc3RvbmVDb21wbGV0ZShyb2FkbWFwKTtcblxuICAgIGlmIChjb21wbGV0ZSkge1xuICAgICAgLy8gQWxsIHNsaWNlcyBkb25lIFx1MjAxNCBjaGVjayB2YWxpZGF0aW9uIGFuZCBzdW1tYXJ5IHN0YXRlXG4gICAgICBjb25zdCBzdW1tYXJ5RmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgIGNvbnN0IHZhbGlkYXRpb25GaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJWQUxJREFUSU9OXCIpO1xuICAgICAgY29uc3QgdmFsaWRhdGlvbkNvbnRlbnQgPSB2YWxpZGF0aW9uRmlsZSA/IGF3YWl0IGNhY2hlZExvYWRGaWxlKHZhbGlkYXRpb25GaWxlKSA6IG51bGw7XG4gICAgICBjb25zdCB2YWxpZGF0aW9uVGVybWluYWwgPSB2YWxpZGF0aW9uQ29udGVudCA/IGlzVmFsaWRhdGlvblRlcm1pbmFsKHZhbGlkYXRpb25Db250ZW50KSA6IGZhbHNlO1xuICAgICAgY29uc3QgdmVyZGljdCA9IHZhbGlkYXRpb25Db250ZW50ID8gZXh0cmFjdFZlcmRpY3QodmFsaWRhdGlvbkNvbnRlbnQpIDogdW5kZWZpbmVkO1xuICAgICAgLy8gbmVlZHMtcmVtZWRpYXRpb24gaXMgdGVybWluYWwgYnV0IHJlcXVpcmVzIHJlLXZhbGlkYXRpb24gKCMzNTk2KVxuICAgICAgY29uc3QgbmVlZHNSZXZhbGlkYXRpb24gPSAhdmFsaWRhdGlvblRlcm1pbmFsIHx8IHZlcmRpY3QgPT09ICduZWVkcy1yZW1lZGlhdGlvbic7XG5cbiAgICAgIGlmIChzdW1tYXJ5RmlsZSAmJiBhd2FpdCBpc1Rlcm1pbmFsTWlsZXN0b25lU3VtbWFyeUZpbGUoc3VtbWFyeUZpbGUsIGNhY2hlZExvYWRGaWxlKSkge1xuICAgICAgICAvLyBTdW1tYXJ5IGV4aXN0cyBcdTIxOTIgbWlsZXN0b25lIGlzIGNvbXBsZXRlIHJlZ2FyZGxlc3Mgb2YgdmFsaWRhdGlvbiBzdGF0ZS5cbiAgICAgICAgLy8gVGhlIHN1bW1hcnkgaXMgdGhlIHRlcm1pbmFsIGFydGlmYWN0ICgjODY0KS5cbiAgICAgICAgcmVnaXN0cnkucHVzaCh7IGlkOiBtaWQsIHRpdGxlLCBzdGF0dXM6ICdjb21wbGV0ZScgfSk7XG4gICAgICB9IGVsc2UgaWYgKG5lZWRzUmV2YWxpZGF0aW9uICYmICFhY3RpdmVNaWxlc3RvbmVGb3VuZCkge1xuICAgICAgICAvLyBObyBzdW1tYXJ5IGFuZCBuZWVkcyAocmUtKXZhbGlkYXRpb24gXHUyMTkyIHZhbGlkYXRpbmctbWlsZXN0b25lXG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZSA9IHsgaWQ6IG1pZCwgdGl0bGUgfTtcbiAgICAgICAgYWN0aXZlUm9hZG1hcCA9IHJvYWRtYXA7XG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZUZvdW5kID0gdHJ1ZTtcbiAgICAgICAgcmVnaXN0cnkucHVzaCh7IGlkOiBtaWQsIHRpdGxlLCBzdGF0dXM6ICdhY3RpdmUnIH0pO1xuICAgICAgfSBlbHNlIGlmIChuZWVkc1JldmFsaWRhdGlvbiAmJiBhY3RpdmVNaWxlc3RvbmVGb3VuZCkge1xuICAgICAgICAvLyBOZWVkcyAocmUtKXZhbGlkYXRpb24sIGJ1dCBhbm90aGVyIG1pbGVzdG9uZSBpcyBhbHJlYWR5IGFjdGl2ZVxuICAgICAgICByZWdpc3RyeS5wdXNoKHsgaWQ6IG1pZCwgdGl0bGUsIHN0YXR1czogJ3BlbmRpbmcnIH0pO1xuICAgICAgfSBlbHNlIGlmICghYWN0aXZlTWlsZXN0b25lRm91bmQpIHtcbiAgICAgICAgLy8gVGVybWluYWwgdmFsaWRhdGlvbiAocGFzcy9uZWVkcy1hdHRlbnRpb24pIGJ1dCBubyBzdW1tYXJ5IFx1MjE5MiBjb21wbGV0aW5nLW1pbGVzdG9uZVxuICAgICAgICBhY3RpdmVNaWxlc3RvbmUgPSB7IGlkOiBtaWQsIHRpdGxlIH07XG4gICAgICAgIGFjdGl2ZVJvYWRtYXAgPSByb2FkbWFwO1xuICAgICAgICBhY3RpdmVNaWxlc3RvbmVGb3VuZCA9IHRydWU7XG4gICAgICAgIHJlZ2lzdHJ5LnB1c2goeyBpZDogbWlkLCB0aXRsZSwgc3RhdHVzOiAnYWN0aXZlJyB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJlZ2lzdHJ5LnB1c2goeyBpZDogbWlkLCB0aXRsZSwgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBSb2FkbWFwIHNsaWNlcyBub3QgYWxsIGNoZWNrZWQgXHUyMDE0IGJ1dCBpZiBhIHN1bW1hcnkgZXhpc3RzLCB0aGUgbWlsZXN0b25lXG4gICAgICAvLyBpcyBzdGlsbCBjb21wbGV0ZS4gVGhlIHN1bW1hcnkgaXMgdGhlIHRlcm1pbmFsIGFydGlmYWN0ICgjODY0KS5cbiAgICAgIGNvbnN0IHN1bW1hcnlGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJTVU1NQVJZXCIpO1xuICAgICAgaWYgKHN1bW1hcnlGaWxlICYmIGF3YWl0IGlzVGVybWluYWxNaWxlc3RvbmVTdW1tYXJ5RmlsZShzdW1tYXJ5RmlsZSwgY2FjaGVkTG9hZEZpbGUpKSB7XG4gICAgICAgIHJlZ2lzdHJ5LnB1c2goeyBpZDogbWlkLCB0aXRsZSwgc3RhdHVzOiAnY29tcGxldGUnIH0pO1xuICAgICAgfSBlbHNlIGlmICghYWN0aXZlTWlsZXN0b25lRm91bmQpIHtcbiAgICAgICAgLy8gQ2hlY2sgbWlsZXN0b25lLWxldmVsIGRlcGVuZGVuY2llcyBiZWZvcmUgcHJvbW90aW5nIHRvIGFjdGl2ZS5cbiAgICAgICAgLy8gRmFsbCBiYWNrIHRvIENPTlRFWFQtRFJBRlQubWQgd2hlbiBDT05URVhULm1kIGlzIGFic2VudCAoIzE3MjQpLlxuICAgICAgICBjb25zdCBjb250ZXh0RmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgICAgY29uc3QgZHJhZnRGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJDT05URVhULURSQUZUXCIpO1xuICAgICAgICBjb25zdCBjb250ZXh0Q29udGVudCA9IGNvbnRleHRGaWxlID8gYXdhaXQgY2FjaGVkTG9hZEZpbGUoY29udGV4dEZpbGUpIDogbnVsbDtcbiAgICAgICAgY29uc3QgZHJhZnRDb250ZW50ID0gZHJhZnRGaWxlICYmICFjb250ZXh0Q29udGVudCA/IGF3YWl0IGNhY2hlZExvYWRGaWxlKGRyYWZ0RmlsZSkgOiBudWxsO1xuICAgICAgICBjb25zdCBkZXBzID0gcGFyc2VDb250ZXh0RGVwZW5kc09uKGNvbnRleHRDb250ZW50ID8/IGRyYWZ0Q29udGVudCk7XG4gICAgICAgIGNvbnN0IGRlcHNVbm1ldCA9IGRlcHMuc29tZShkZXAgPT4gIWNvbXBsZXRlTWlsZXN0b25lSWRzLmhhcyhkZXApKTtcbiAgICAgICAgaWYgKGRlcHNVbm1ldCkge1xuICAgICAgICAgIHJlZ2lzdHJ5LnB1c2goeyBpZDogbWlkLCB0aXRsZSwgc3RhdHVzOiAncGVuZGluZycsIGRlcGVuZHNPbjogZGVwcyB9KTtcbiAgICAgICAgICAvLyBEbyBOT1Qgc2V0IGFjdGl2ZU1pbGVzdG9uZUZvdW5kIFx1MjAxNCBsZXQgdGhlIGxvb3AgY29udGludWUgdG8gdGhlIG5leHQgbWlsZXN0b25lXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgYWN0aXZlTWlsZXN0b25lID0geyBpZDogbWlkLCB0aXRsZSB9O1xuICAgICAgICAgIGFjdGl2ZVJvYWRtYXAgPSByb2FkbWFwO1xuICAgICAgICAgIGFjdGl2ZU1pbGVzdG9uZUZvdW5kID0gdHJ1ZTtcbiAgICAgICAgICByZWdpc3RyeS5wdXNoKHsgaWQ6IG1pZCwgdGl0bGUsIHN0YXR1czogJ2FjdGl2ZScsIC4uLihkZXBzLmxlbmd0aCA+IDAgPyB7IGRlcGVuZHNPbjogZGVwcyB9IDoge30pIH0pO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBjb250ZXh0RmlsZTIgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgbWlkLCBcIkNPTlRFWFRcIik7XG4gICAgICAgIGNvbnN0IGRyYWZ0RmlsZUZvckRlcHMzID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJDT05URVhULURSQUZUXCIpO1xuICAgICAgICBjb25zdCBjb250ZXh0T3JEcmFmdENvbnRlbnQzID0gY29udGV4dEZpbGUyXG4gICAgICAgICAgICA/IGF3YWl0IGNhY2hlZExvYWRGaWxlKGNvbnRleHRGaWxlMilcbiAgICAgICAgICAgIDogKGRyYWZ0RmlsZUZvckRlcHMzID8gYXdhaXQgY2FjaGVkTG9hZEZpbGUoZHJhZnRGaWxlRm9yRGVwczMpIDogbnVsbCk7XG4gICAgICAgIGNvbnN0IGRlcHMyID0gcGFyc2VDb250ZXh0RGVwZW5kc09uKGNvbnRleHRPckRyYWZ0Q29udGVudDMpO1xuICAgICAgICByZWdpc3RyeS5wdXNoKHsgaWQ6IG1pZCwgdGl0bGUsIHN0YXR1czogJ3BlbmRpbmcnLCAuLi4oZGVwczIubGVuZ3RoID4gMCA/IHsgZGVwZW5kc09uOiBkZXBzMiB9IDoge30pIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IG1pbGVzdG9uZVByb2dyZXNzID0ge1xuICAgIGRvbmU6IHJlZ2lzdHJ5LmZpbHRlcihlbnRyeSA9PiBlbnRyeS5zdGF0dXMgPT09ICdjb21wbGV0ZScpLmxlbmd0aCxcbiAgICB0b3RhbDogcmVnaXN0cnkubGVuZ3RoLFxuICB9O1xuXG4gIGlmICghYWN0aXZlTWlsZXN0b25lKSB7XG4gICAgLy8gQ2hlY2sgd2hldGhlciBhbnkgbWlsZXN0b25lcyBhcmUgcGVuZGluZyAoZGVwLWJsb2NrZWQpIG9yIHBhcmtlZFxuICAgIGNvbnN0IHBlbmRpbmdFbnRyaWVzID0gcmVnaXN0cnkuZmlsdGVyKGVudHJ5ID0+IGVudHJ5LnN0YXR1cyA9PT0gJ3BlbmRpbmcnKTtcbiAgICBjb25zdCBwYXJrZWRFbnRyaWVzID0gcmVnaXN0cnkuZmlsdGVyKGVudHJ5ID0+IGVudHJ5LnN0YXR1cyA9PT0gJ3BhcmtlZCcpO1xuICAgIGlmIChwZW5kaW5nRW50cmllcy5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBBbGwgaW5jb21wbGV0ZSBtaWxlc3RvbmVzIGFyZSBkZXAtYmxvY2tlZCBcdTIwMTQgbm8gcHJvZ3Jlc3MgcG9zc2libGVcbiAgICAgIGNvbnN0IGJsb2NrZXJEZXRhaWxzID0gcGVuZGluZ0VudHJpZXNcbiAgICAgICAgLmZpbHRlcihlbnRyeSA9PiBlbnRyeS5kZXBlbmRzT24gJiYgZW50cnkuZGVwZW5kc09uLmxlbmd0aCA+IDApXG4gICAgICAgIC5tYXAoZW50cnkgPT4gYCR7ZW50cnkuaWR9IGlzIHdhaXRpbmcgb24gdW5tZXQgZGVwczogJHtlbnRyeS5kZXBlbmRzT24hLmpvaW4oJywgJyl9YCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3RpdmVNaWxlc3RvbmU6IG51bGwsXG4gICAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgICBwaGFzZTogJ2Jsb2NrZWQnLFxuICAgICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgICBibG9ja2VyczogYmxvY2tlckRldGFpbHMubGVuZ3RoID4gMFxuICAgICAgICAgID8gYmxvY2tlckRldGFpbHNcbiAgICAgICAgICA6IFsnQWxsIHJlbWFpbmluZyBtaWxlc3RvbmVzIGFyZSBkZXAtYmxvY2tlZCBidXQgbm8gZGVwcyBsaXN0ZWQgXHUyMDE0IGNoZWNrIENPTlRFWFQubWQgZmlsZXMnXSxcbiAgICAgICAgbmV4dEFjdGlvbjogJ1Jlc29sdmUgbWlsZXN0b25lIGRlcGVuZGVuY2llcyBiZWZvcmUgcHJvY2VlZGluZy4nLFxuICAgICAgICByZWdpc3RyeSxcbiAgICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgICBwcm9ncmVzczoge1xuICAgICAgICAgIG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKHBhcmtlZEVudHJpZXMubGVuZ3RoID4gMCkge1xuICAgICAgLy8gQWxsIG5vbi1jb21wbGV0ZSBtaWxlc3RvbmVzIGFyZSBwYXJrZWQgXHUyMDE0IG5vdGhpbmcgYWN0aXZlLCBidXQgbm90IFwiYWxsIGNvbXBsZXRlXCJcbiAgICAgIGNvbnN0IHBhcmtlZElkcyA9IHBhcmtlZEVudHJpZXMubWFwKGUgPT4gZS5pZCkuam9pbignLCAnKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGl2ZU1pbGVzdG9uZTogbnVsbCxcbiAgICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICAgIHBoYXNlOiAncHJlLXBsYW5uaW5nJyxcbiAgICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgICBuZXh0QWN0aW9uOiBgQWxsIHJlbWFpbmluZyBtaWxlc3RvbmVzIGFyZSBwYXJrZWQgKCR7cGFya2VkSWRzfSkuIFJ1biAvZ3NkIHVucGFyayA8aWQ+IG9yIGNyZWF0ZSBhIG5ldyBtaWxlc3RvbmUuYCxcbiAgICAgICAgcmVnaXN0cnksXG4gICAgICAgIHJlcXVpcmVtZW50cyxcbiAgICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgICBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcyxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIEFsbCByZWFsIG1pbGVzdG9uZXMgd2VyZSBnaG9zdHMgKGVtcHR5IHJlZ2lzdHJ5KSBcdTIxOTIgdHJlYXQgYXMgcHJlLXBsYW5uaW5nXG4gICAgaWYgKHJlZ2lzdHJ5Lmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lOiBudWxsLFxuICAgICAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgICAgcGhhc2U6ICdwcmUtcGxhbm5pbmcnLFxuICAgICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgICBibG9ja2VyczogW10sXG4gICAgICAgIG5leHRBY3Rpb246ICdObyBtaWxlc3RvbmVzIGZvdW5kLiBSdW4gL2dzZCB0byBjcmVhdGUgb25lLicsXG4gICAgICAgIHJlZ2lzdHJ5OiBbXSxcbiAgICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgICBwcm9ncmVzczoge1xuICAgICAgICAgIG1pbGVzdG9uZXM6IHsgZG9uZTogMCwgdG90YWw6IDAgfSxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIEFsbCBtaWxlc3RvbmVzIGNvbXBsZXRlXG4gICAgY29uc3QgbGFzdEVudHJ5ID0gcmVnaXN0cnlbcmVnaXN0cnkubGVuZ3RoIC0gMV07XG4gICAgY29uc3QgYWN0aXZlUmVxcyA9IHJlcXVpcmVtZW50cy5hY3RpdmUgPz8gMDtcbiAgICBjb25zdCBjb21wbGV0aW9uTm90ZSA9IGFjdGl2ZVJlcXMgPiAwXG4gICAgICA/IGBBbGwgbWlsZXN0b25lcyBjb21wbGV0ZS4gJHthY3RpdmVSZXFzfSBhY3RpdmUgcmVxdWlyZW1lbnQke2FjdGl2ZVJlcXMgPT09IDEgPyAnJyA6ICdzJ30gaW4gUkVRVUlSRU1FTlRTLm1kICR7YWN0aXZlUmVxcyA9PT0gMSA/ICdoYXMnIDogJ2hhdmUnfSBub3QgYmVlbiBtYXBwZWQgdG8gYSBtaWxlc3RvbmUuYFxuICAgICAgOiAnQWxsIG1pbGVzdG9uZXMgY29tcGxldGUuJztcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aXZlTWlsZXN0b25lOiBudWxsLFxuICAgICAgbGFzdENvbXBsZXRlZE1pbGVzdG9uZTogbGFzdEVudHJ5ID8geyBpZDogbGFzdEVudHJ5LmlkLCB0aXRsZTogbGFzdEVudHJ5LnRpdGxlIH0gOiBudWxsLFxuICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgcGhhc2U6ICdjb21wbGV0ZScsXG4gICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgbmV4dEFjdGlvbjogY29tcGxldGlvbk5vdGUsXG4gICAgICByZWdpc3RyeSxcbiAgICAgIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7XG4gICAgICAgIG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKCFhY3RpdmVSb2FkbWFwKSB7XG4gICAgLy8gQWN0aXZlIG1pbGVzdG9uZSBleGlzdHMgYnV0IGhhcyBubyByb2FkbWFwIHlldC5cbiAgICAvLyBJZiBhIENPTlRFWFQtRFJBRlQubWQgc2VlZCBleGlzdHMsIGl0IG5lZWRzIGRpc2N1c3Npb24gYmVmb3JlIHBsYW5uaW5nLlxuICAgIC8vIE90aGVyd2lzZSwgaXQncyBhIGJsYW5rIG1pbGVzdG9uZSByZWFkeSBmb3IgaW5pdGlhbCBwbGFubmluZy5cbiAgICBjb25zdCBwaGFzZSA9IGFjdGl2ZU1pbGVzdG9uZUhhc0RyYWZ0ID8gJ25lZWRzLWRpc2N1c3Npb24nIGFzIGNvbnN0IDogJ3ByZS1wbGFubmluZycgYXMgY29uc3Q7XG4gICAgY29uc3QgbmV4dEFjdGlvbiA9IGFjdGl2ZU1pbGVzdG9uZUhhc0RyYWZ0XG4gICAgICA/IGBEaXNjdXNzIGRyYWZ0IGNvbnRleHQgZm9yIG1pbGVzdG9uZSAke2FjdGl2ZU1pbGVzdG9uZS5pZH0uYFxuICAgICAgOiBgUGxhbiBtaWxlc3RvbmUgJHthY3RpdmVNaWxlc3RvbmUuaWR9LmA7XG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZSxcbiAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgIHBoYXNlLFxuICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIG5leHRBY3Rpb24sXG4gICAgICByZWdpc3RyeSxcbiAgICAgIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7XG4gICAgICAgIG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFplcm8tc2xpY2Ugcm9hZG1hcCBndWFyZCAoIzE3ODUpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBBIHN0dWIgcm9hZG1hcCAocGxhY2Vob2xkZXIgdGV4dCwgbm8gc2xpY2UgZGVmaW5pdGlvbnMpIGhhcyBhIHRydXRoeVxuICAvLyByb2FkbWFwIG9iamVjdCBidXQgYW4gZW1wdHkgc2xpY2VzIGFycmF5LiBXaXRob3V0IHRoaXMgY2hlY2sgdGhlXG4gIC8vIHNsaWNlLWZpbmRpbmcgbG9vcCBiZWxvdyBmaW5kcyBub3RoaW5nIGFuZCByZXR1cm5zIHBoYXNlOiBcImJsb2NrZWRcIi5cbiAgLy8gQW4gZW1wdHkgc2xpY2VzIGFycmF5IG1lYW5zIHRoZSByb2FkbWFwIHN0aWxsIG5lZWRzIHNsaWNlIGRlZmluaXRpb25zLFxuICAvLyBzbyB0aGUgY29ycmVjdCBwaGFzZSBpcyBwcmUtcGxhbm5pbmcuXG4gIGlmIChhY3RpdmVSb2FkbWFwLnNsaWNlcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aXZlTWlsZXN0b25lLFxuICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgcGhhc2U6ICdwcmUtcGxhbm5pbmcnLFxuICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIG5leHRBY3Rpb246IGBNaWxlc3RvbmUgJHthY3RpdmVNaWxlc3RvbmUuaWR9IGhhcyBhIHJvYWRtYXAgYnV0IG5vIHNsaWNlcyBkZWZpbmVkLiBBZGQgc2xpY2VzIHRvIHRoZSByb2FkbWFwLmAsXG4gICAgICByZWdpc3RyeSxcbiAgICAgIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7XG4gICAgICAgIG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLFxuICAgICAgICBzbGljZXM6IHsgZG9uZTogMCwgdG90YWw6IDAgfSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8vIENoZWNrIGlmIGFjdGl2ZSBtaWxlc3RvbmUgbmVlZHMgdmFsaWRhdGlvbiBvciBjb21wbGV0aW9uIChhbGwgc2xpY2VzIGRvbmUpXG4gIGlmIChpc01pbGVzdG9uZUNvbXBsZXRlKGFjdGl2ZVJvYWRtYXApKSB7XG4gICAgY29uc3QgdmFsaWRhdGlvbkZpbGUgPSByZXNvbHZlTWlsZXN0b25lRmlsZShiYXNlUGF0aCwgYWN0aXZlTWlsZXN0b25lLmlkLCBcIlZBTElEQVRJT05cIik7XG4gICAgY29uc3QgdmFsaWRhdGlvbkNvbnRlbnQgPSB2YWxpZGF0aW9uRmlsZSA/IGF3YWl0IGNhY2hlZExvYWRGaWxlKHZhbGlkYXRpb25GaWxlKSA6IG51bGw7XG4gICAgY29uc3QgdmFsaWRhdGlvblRlcm1pbmFsID0gdmFsaWRhdGlvbkNvbnRlbnQgPyBpc1ZhbGlkYXRpb25UZXJtaW5hbCh2YWxpZGF0aW9uQ29udGVudCkgOiBmYWxzZTtcbiAgICBjb25zdCB2ZXJkaWN0ID0gdmFsaWRhdGlvbkNvbnRlbnQgPyBleHRyYWN0VmVyZGljdCh2YWxpZGF0aW9uQ29udGVudCkgOiB1bmRlZmluZWQ7XG4gICAgY29uc3Qgc2xpY2VQcm9ncmVzcyA9IHtcbiAgICAgIGRvbmU6IGFjdGl2ZVJvYWRtYXAuc2xpY2VzLmxlbmd0aCxcbiAgICAgIHRvdGFsOiBhY3RpdmVSb2FkbWFwLnNsaWNlcy5sZW5ndGgsXG4gICAgfTtcblxuICAgIC8vIEZvcmNlIHJlLXZhbGlkYXRpb24gd2hlbiBWQUxJREFUSU9OLm1kIGlzIGFic2VudCBvciBub24tdGVybWluYWwgXHUyMDE0XG4gICAgLy8gcmVtZWRpYXRpb24gc2xpY2VzIG1heSBoYXZlIGNvbXBsZXRlZCBzaW5jZSB0aGUgc3RhbGUgdmFsaWRhdGlvbiB3YXNcbiAgICAvLyB3cml0dGVuICgjMzU5NikuIEJ1dCBuZWVkcy1yZW1lZGlhdGlvbiB3aXRoIGFsbCBzbGljZXMgZG9uZSBpcyBhIGRlYWRcbiAgICAvLyBlbmQgXHUyMDE0IHJldHVybiBibG9ja2VkIHRvIGF2b2lkIGFuIGluZmluaXRlIGRpc3BhdGNoIGxvb3AgKCM0NTA2KS5cbiAgICBpZiAoIXZhbGlkYXRpb25UZXJtaW5hbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lLFxuICAgICAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgICAgcGhhc2U6ICd2YWxpZGF0aW5nLW1pbGVzdG9uZScsXG4gICAgICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgICAgbmV4dEFjdGlvbjogYFZhbGlkYXRlIG1pbGVzdG9uZSAke2FjdGl2ZU1pbGVzdG9uZS5pZH0gYmVmb3JlIGNvbXBsZXRpb24uYCxcbiAgICAgICAgcmVnaXN0cnksXG4gICAgICAgIHJlcXVpcmVtZW50cyxcbiAgICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgICBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcyxcbiAgICAgICAgICBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmICh2ZXJkaWN0ID09PSAnbmVlZHMtcmVtZWRpYXRpb24nKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3RpdmVNaWxlc3RvbmUsXG4gICAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgICBwaGFzZTogJ2Jsb2NrZWQnLFxuICAgICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgICBibG9ja2VyczogW1xuICAgICAgICAgIGBNaWxlc3RvbmUgJHthY3RpdmVNaWxlc3RvbmUuaWR9IHZhbGlkYXRpb24gdmVyZGljdCBpcyBuZWVkcy1yZW1lZGlhdGlvbiBidXQgYWxsIHNsaWNlcyBhcmUgY29tcGxldGUuIGAgK1xuICAgICAgICAgICAgYEFkZCByZW1lZGlhdGlvbiBzbGljZXMgdmlhIGdzZF9yZWFzc2Vzc19yb2FkbWFwIG9yIG92ZXJyaWRlIHRoZSB2ZXJkaWN0IG1hbnVhbGx5LmAsXG4gICAgICAgIF0sXG4gICAgICAgIG5leHRBY3Rpb246IGBSZXNvbHZlICR7YWN0aXZlTWlsZXN0b25lLmlkfSByZW1lZGlhdGlvbiBiZWZvcmUgcHJvY2VlZGluZy5gLFxuICAgICAgICByZWdpc3RyeSxcbiAgICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgICBwcm9ncmVzczoge1xuICAgICAgICAgIG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLFxuICAgICAgICAgIHNsaWNlczogc2xpY2VQcm9ncmVzcyxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIGFjdGl2ZU1pbGVzdG9uZSxcbiAgICAgIGFjdGl2ZVNsaWNlOiBudWxsLFxuICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgIHBoYXNlOiAnY29tcGxldGluZy1taWxlc3RvbmUnLFxuICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgIG5leHRBY3Rpb246IGBBbGwgc2xpY2VzIGNvbXBsZXRlIGluICR7YWN0aXZlTWlsZXN0b25lLmlkfS4gV3JpdGUgbWlsZXN0b25lIHN1bW1hcnkuYCxcbiAgICAgIHJlZ2lzdHJ5LFxuICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgbWlsZXN0b25lczogbWlsZXN0b25lUHJvZ3Jlc3MsXG4gICAgICAgIHNsaWNlczogc2xpY2VQcm9ncmVzcyxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHNsaWNlUHJvZ3Jlc3MgPSB7XG4gICAgZG9uZTogYWN0aXZlUm9hZG1hcC5zbGljZXMuZmlsdGVyKHMgPT4gcy5kb25lKS5sZW5ndGgsXG4gICAgdG90YWw6IGFjdGl2ZVJvYWRtYXAuc2xpY2VzLmxlbmd0aCxcbiAgfTtcblxuICAvLyBGaW5kIHRoZSBhY3RpdmUgc2xpY2UgKGZpcnN0IGluY29tcGxldGUgd2l0aCBkZXBzIHNhdGlzZmllZClcbiAgY29uc3QgZG9uZVNsaWNlSWRzID0gbmV3IFNldChhY3RpdmVSb2FkbWFwLnNsaWNlcy5maWx0ZXIocyA9PiBzLmRvbmUpLm1hcChzID0+IHMuaWQpKTtcbiAgbGV0IGFjdGl2ZVNsaWNlOiBBY3RpdmVSZWYgfCBudWxsID0gbnVsbDtcblxuICAvLyBcdTI1MDBcdTI1MDAgU2xpY2UtbGV2ZWwgcGFyYWxsZWwgd29ya2VyIGlzb2xhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gV2hlbiBHU0RfUEFSQUxMRUxfV09SS0VSIGFuZCBHU0RfU0xJQ0VfTE9DSyBhcmUgc2V0LCBvdmVycmlkZSBhY3RpdmVTbGljZSB0byBvbmx5IHRoZSBsb2NrZWQgc2xpY2UuXG4gIGNvbnN0IHNsaWNlTG9ja0xlZ2FjeSA9IHByb2Nlc3MuZW52LkdTRF9QQVJBTExFTF9XT1JLRVIgPyBwcm9jZXNzLmVudi5HU0RfU0xJQ0VfTE9DSyA6IHVuZGVmaW5lZDtcbiAgaWYgKHNsaWNlTG9ja0xlZ2FjeSkge1xuICAgIGNvbnN0IGxvY2tlZFNsaWNlID0gYWN0aXZlUm9hZG1hcC5zbGljZXMuZmluZChzID0+IHMuaWQgPT09IHNsaWNlTG9ja0xlZ2FjeSk7XG4gICAgaWYgKGxvY2tlZFNsaWNlKSB7XG4gICAgICBhY3RpdmVTbGljZSA9IHsgaWQ6IGxvY2tlZFNsaWNlLmlkLCB0aXRsZTogbG9ja2VkU2xpY2UudGl0bGUgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgbG9nV2FybmluZyhcInN0YXRlXCIsIGBHU0RfU0xJQ0VfTE9DSz0ke3NsaWNlTG9ja0xlZ2FjeX0gbm90IGZvdW5kIGluIGFjdGl2ZSBzbGljZXMgXHUyMDE0IHdvcmtlciBoYXMgbm8gYXNzaWduZWQgd29ya2ApO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lLFxuICAgICAgICBhY3RpdmVTbGljZTogbnVsbCxcbiAgICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgICAgcGhhc2U6ICdibG9ja2VkJyxcbiAgICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgICAgYmxvY2tlcnM6IFtgR1NEX1NMSUNFX0xPQ0s9JHtzbGljZUxvY2tMZWdhY3l9IG5vdCBmb3VuZCBpbiBhY3RpdmUgbWlsZXN0b25lIHNsaWNlc2BdLFxuICAgICAgICBuZXh0QWN0aW9uOiAnU2xpY2UgbG9jayByZWZlcmVuY2VzIGEgbm9uLWV4aXN0ZW50IHNsaWNlIFx1MjAxNCBjaGVjayBvcmNoZXN0cmF0b3IgZGlzcGF0Y2guJyxcbiAgICAgICAgcmVnaXN0cnksXG4gICAgICAgIHJlcXVpcmVtZW50cyxcbiAgICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgICBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcyxcbiAgICAgICAgICBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBmb3IgKGNvbnN0IHMgb2YgYWN0aXZlUm9hZG1hcC5zbGljZXMpIHtcbiAgICAgIGlmIChzLmRvbmUpIGNvbnRpbnVlO1xuICAgICAgaWYgKHMuZGVwZW5kcy5ldmVyeShkZXAgPT4gZG9uZVNsaWNlSWRzLmhhcyhkZXApKSkge1xuICAgICAgICBhY3RpdmVTbGljZSA9IHsgaWQ6IHMuaWQsIHRpdGxlOiBzLnRpdGxlIH07XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmICghYWN0aXZlU2xpY2UpIHtcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aXZlTWlsZXN0b25lLFxuICAgICAgYWN0aXZlU2xpY2U6IG51bGwsXG4gICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgcGhhc2U6ICdibG9ja2VkJyxcbiAgICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICBibG9ja2VyczogWydObyBzbGljZSBlbGlnaWJsZSBcdTIwMTQgY2hlY2sgZGVwZW5kZW5jeSBvcmRlcmluZyddLFxuICAgICAgbmV4dEFjdGlvbjogJ1Jlc29sdmUgZGVwZW5kZW5jeSBibG9ja2VycyBvciBwbGFuIG5leHQgc2xpY2UuJyxcbiAgICAgIHJlZ2lzdHJ5LFxuICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgbWlsZXN0b25lczogbWlsZXN0b25lUHJvZ3Jlc3MsXG4gICAgICAgIHNsaWNlczogc2xpY2VQcm9ncmVzcyxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8vIENoZWNrIGlmIHRoZSBzbGljZSBoYXMgYSBwbGFuXG4gIGNvbnN0IHBsYW5GaWxlID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgYWN0aXZlTWlsZXN0b25lLmlkLCBhY3RpdmVTbGljZS5pZCwgXCJQTEFOXCIpO1xuICBjb25zdCBzbGljZVBsYW5Db250ZW50ID0gcGxhbkZpbGUgPyBhd2FpdCBjYWNoZWRMb2FkRmlsZShwbGFuRmlsZSkgOiBudWxsO1xuXG4gIGlmICghc2xpY2VQbGFuQ29udGVudCkge1xuICAgIHJldHVybiB7XG4gICAgICBhY3RpdmVNaWxlc3RvbmUsXG4gICAgICBhY3RpdmVTbGljZSxcbiAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogJ3BsYW5uaW5nJyxcbiAgICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgICBuZXh0QWN0aW9uOiBgUGxhbiBzbGljZSAke2FjdGl2ZVNsaWNlLmlkfSAoJHthY3RpdmVTbGljZS50aXRsZX0pLmAsXG5cbiAgICAgIHJlZ2lzdHJ5LFxuICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgbWlsZXN0b25lczogbWlsZXN0b25lUHJvZ3Jlc3MsXG4gICAgICAgIHNsaWNlczogc2xpY2VQcm9ncmVzcyxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHNsaWNlUGxhbiA9IHBhcnNlUGxhbihzbGljZVBsYW5Db250ZW50KTtcblxuICAvLyBcdTI1MDBcdTI1MDAgUmVjb25jaWxlIHN0YWxlIHRhc2sgc3RhdHVzIGZvciBmaWxlc3lzdGVtLWJhc2VkIHByb2plY3RzICgjMjUxNCkgXHUyNTAwXHUyNTAwXG4gIC8vIEhlYWRpbmctc3R5bGUgdGFza3MgKCMjIyBUMDE6KSBhcmUgYWx3YXlzIHBhcnNlZCBhcyBkb25lPWZhbHNlIGJ5XG4gIC8vIHBhcnNlUGxhbiBiZWNhdXNlIHRoZSBoZWFkaW5nIHN5bnRheCBoYXMgbm8gY2hlY2tib3guIFdoZW4gdGhlIGFnZW50XG4gIC8vIHdyaXRlcyBhIFNVTU1BUlkgZmlsZSBidXQgdGhlIHBsYW4ncyBoZWFkaW5nIGlzbid0IGNvbnZlcnRlZCB0byBhXG4gIC8vIGNoZWNrYm94LCB0aGUgdGFzayBhcHBlYXJzIGluY29tcGxldGUgZm9yZXZlciBcdTIwMTQgY2F1c2luZyBpbmZpbml0ZVxuICAvLyByZS1kaXNwYXRjaC4gUmVjb25jaWxlIGJ5IGNoZWNraW5nIFNVTU1BUlkgZmlsZXMgb24gZGlzay5cbiAgZm9yIChjb25zdCB0IG9mIHNsaWNlUGxhbi50YXNrcykge1xuICAgIGlmICh0LmRvbmUpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHN1bW1hcnlQYXRoID0gcmVzb2x2ZVRhc2tGaWxlKGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUuaWQsIGFjdGl2ZVNsaWNlLmlkLCB0LmlkLCBcIlNVTU1BUllcIik7XG4gICAgaWYgKHN1bW1hcnlQYXRoICYmIGV4aXN0c1N5bmMoc3VtbWFyeVBhdGgpKSB7XG4gICAgICB0LmRvbmUgPSB0cnVlO1xuICAgICAgbG9nV2FybmluZyhcInJlY29uY2lsZVwiLCBgdGFzayAke2FjdGl2ZU1pbGVzdG9uZS5pZH0vJHthY3RpdmVTbGljZS5pZH0vJHt0LmlkfSByZWNvbmNpbGVkIHZpYSBTVU1NQVJZIG9uIGRpc2sgKCMyNTE0KWAsIHsgbWlkOiBhY3RpdmVNaWxlc3RvbmUuaWQsIHNpZDogYWN0aXZlU2xpY2UuaWQsIHRpZDogdC5pZCB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCB0YXNrUHJvZ3Jlc3MgPSB7XG4gICAgZG9uZTogc2xpY2VQbGFuLnRhc2tzLmZpbHRlcih0ID0+IHQuZG9uZSkubGVuZ3RoLFxuICAgIHRvdGFsOiBzbGljZVBsYW4udGFza3MubGVuZ3RoLFxuICB9O1xuICBjb25zdCBhY3RpdmVUYXNrRW50cnkgPSBzbGljZVBsYW4udGFza3MuZmluZCh0ID0+ICF0LmRvbmUpO1xuXG4gIGlmICghYWN0aXZlVGFza0VudHJ5ICYmIHNsaWNlUGxhbi50YXNrcy5sZW5ndGggPiAwKSB7XG4gICAgLy8gQWxsIHRhc2tzIGRvbmUgYnV0IHNsaWNlIG5vdCBtYXJrZWQgY29tcGxldGVcbiAgICByZXR1cm4ge1xuICAgICAgYWN0aXZlTWlsZXN0b25lLFxuICAgICAgYWN0aXZlU2xpY2UsXG4gICAgICBhY3RpdmVUYXNrOiBudWxsLFxuICAgICAgcGhhc2U6ICdzdW1tYXJpemluZycsXG4gICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgYmxvY2tlcnM6IFtdLFxuICAgICAgbmV4dEFjdGlvbjogYEFsbCB0YXNrcyBkb25lIGluICR7YWN0aXZlU2xpY2UuaWR9LiBXcml0ZSBzbGljZSBzdW1tYXJ5IGFuZCBjb21wbGV0ZSBzbGljZS5gLFxuXG4gICAgICByZWdpc3RyeSxcbiAgICAgIHJlcXVpcmVtZW50cyxcbiAgICAgIHByb2dyZXNzOiB7XG4gICAgICAgIG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLFxuICAgICAgICBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MsXG4gICAgICAgIHRhc2tzOiB0YXNrUHJvZ3Jlc3MsXG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICAvLyBFbXB0eSBwbGFuIFx1MjAxNCBubyB0YXNrcyBkZWZpbmVkIHlldCwgc3RheSBpbiBwbGFubmluZyBwaGFzZVxuICBpZiAoIWFjdGl2ZVRhc2tFbnRyeSkge1xuICAgIHJldHVybiB7XG4gICAgICBhY3RpdmVNaWxlc3RvbmUsXG4gICAgICBhY3RpdmVTbGljZSxcbiAgICAgIGFjdGl2ZVRhc2s6IG51bGwsXG4gICAgICBwaGFzZTogJ3BsYW5uaW5nJyxcbiAgICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICBibG9ja2VyczogW10sXG4gICAgICBuZXh0QWN0aW9uOiBgU2xpY2UgJHthY3RpdmVTbGljZS5pZH0gaGFzIGEgcGxhbiBmaWxlIGJ1dCBubyB0YXNrcy4gQWRkIHRhc2tzIHRvIHRoZSBwbGFuLmAsXG5cbiAgICAgIHJlZ2lzdHJ5LFxuICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgbWlsZXN0b25lczogbWlsZXN0b25lUHJvZ3Jlc3MsXG4gICAgICAgIHNsaWNlczogc2xpY2VQcm9ncmVzcyxcbiAgICAgICAgdGFza3M6IHRhc2tQcm9ncmVzcyxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGFjdGl2ZVRhc2s6IEFjdGl2ZVJlZiA9IHtcbiAgICBpZDogYWN0aXZlVGFza0VudHJ5LmlkLFxuICAgIHRpdGxlOiBhY3RpdmVUYXNrRW50cnkudGl0bGUsXG4gIH07XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFRhc2sgcGxhbiBmaWxlIGNoZWNrICgjOTA5KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgLy8gVGhlIHNsaWNlIHBsYW4gbWF5IHJlZmVyZW5jZSB0YXNrcyBidXQgcGVyLXRhc2sgcGxhbiBmaWxlcyBtYXkgYmVcbiAgLy8gbWlzc2luZyBcdTIwMTQgZS5nLiB3aGVuIHRoZSBzbGljZSBwbGFuIHdhcyBwcmUtY3JlYXRlZCBkdXJpbmcgcm9hZG1hcHBpbmcuXG4gIC8vIElmIHRoZSB0YXNrcyBkaXIgZXhpc3RzIGJ1dCBoYXMgbGl0ZXJhbGx5IHplcm8gZmlsZXMgKGVtcHR5IGRpciBmcm9tXG4gIC8vIG1rZGlyKSwgZmFsbCBiYWNrIHRvIHBsYW5uaW5nIHNvIHBsYW4tc2xpY2UgZ2VuZXJhdGVzIHRhc2sgcGxhbnMuXG4gIGNvbnN0IHRhc2tzRGlyID0gcmVzb2x2ZVRhc2tzRGlyKGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUuaWQsIGFjdGl2ZVNsaWNlLmlkKTtcbiAgaWYgKHRhc2tzRGlyICYmIGV4aXN0c1N5bmModGFza3NEaXIpICYmIHNsaWNlUGxhbi50YXNrcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgYWxsRmlsZXMgPSByZWFkZGlyU3luYyh0YXNrc0RpcikuZmlsdGVyKGYgPT4gZi5lbmRzV2l0aChcIi5tZFwiKSk7XG4gICAgaWYgKGFsbEZpbGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aXZlTWlsZXN0b25lLFxuICAgICAgICBhY3RpdmVTbGljZSxcbiAgICAgICAgYWN0aXZlVGFzazogbnVsbCxcbiAgICAgICAgcGhhc2U6ICdwbGFubmluZycsXG4gICAgICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgICAgIGJsb2NrZXJzOiBbXSxcbiAgICAgICAgbmV4dEFjdGlvbjogYFRhc2sgcGxhbiBmaWxlcyBtaXNzaW5nIGZvciAke2FjdGl2ZVNsaWNlLmlkfS4gUnVuIHBsYW4tc2xpY2UgdG8gZ2VuZXJhdGUgdGFzayBwbGFucy5gLFxuICAgICAgICByZWdpc3RyeSxcbiAgICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgICBwcm9ncmVzczoge1xuICAgICAgICAgIG1pbGVzdG9uZXM6IG1pbGVzdG9uZVByb2dyZXNzLFxuICAgICAgICAgIHNsaWNlczogc2xpY2VQcm9ncmVzcyxcbiAgICAgICAgICB0YXNrczogdGFza1Byb2dyZXNzLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgQmxvY2tlciBkZXRlY3Rpb246IHNjYW4gY29tcGxldGVkIHRhc2sgc3VtbWFyaWVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBJZiBhbnkgY29tcGxldGVkIHRhc2sgaGFzIGJsb2NrZXJfZGlzY292ZXJlZDogdHJ1ZSBhbmQgbm8gUkVQTEFOLm1kXG4gIC8vIGV4aXN0cyB5ZXQsIHRyYW5zaXRpb24gdG8gcmVwbGFubmluZy1zbGljZSBpbnN0ZWFkIG9mIGV4ZWN1dGluZy5cbiAgY29uc3QgY29tcGxldGVkVGFza3MgPSBzbGljZVBsYW4udGFza3MuZmlsdGVyKHQgPT4gdC5kb25lKTtcbiAgbGV0IGJsb2NrZXJUYXNrSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IGN0IG9mIGNvbXBsZXRlZFRhc2tzKSB7XG4gICAgY29uc3Qgc3VtbWFyeUZpbGUgPSByZXNvbHZlVGFza0ZpbGUoYmFzZVBhdGgsIGFjdGl2ZU1pbGVzdG9uZS5pZCwgYWN0aXZlU2xpY2UuaWQsIGN0LmlkLCBcIlNVTU1BUllcIik7XG4gICAgaWYgKCFzdW1tYXJ5RmlsZSkgY29udGludWU7XG4gICAgY29uc3Qgc3VtbWFyeUNvbnRlbnQgPSBhd2FpdCBjYWNoZWRMb2FkRmlsZShzdW1tYXJ5RmlsZSk7XG4gICAgaWYgKCFzdW1tYXJ5Q29udGVudCkgY29udGludWU7XG4gICAgY29uc3Qgc3VtbWFyeSA9IHBhcnNlU3VtbWFyeShzdW1tYXJ5Q29udGVudCk7XG4gICAgaWYgKHN1bW1hcnkuZnJvbnRtYXR0ZXIuYmxvY2tlcl9kaXNjb3ZlcmVkKSB7XG4gICAgICBibG9ja2VyVGFza0lkID0gY3QuaWQ7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBpZiAoYmxvY2tlclRhc2tJZCkge1xuICAgIC8vIExvb3AgcHJvdGVjdGlvbjogaWYgUkVQTEFOLm1kIGFscmVhZHkgZXhpc3RzLCBhIHJlcGxhbiB3YXMgYWxyZWFkeVxuICAgIC8vIHBlcmZvcm1lZCBmb3IgdGhpcyBzbGljZSBcdTIwMTQgc2tpcCBmdXJ0aGVyIHJlcGxhbm5pbmcgYW5kIGNvbnRpbnVlIGV4ZWN1dGluZy5cbiAgICBjb25zdCByZXBsYW5GaWxlID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgYWN0aXZlTWlsZXN0b25lLmlkLCBhY3RpdmVTbGljZS5pZCwgXCJSRVBMQU5cIik7XG4gICAgaWYgKCFyZXBsYW5GaWxlKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3RpdmVNaWxlc3RvbmUsXG4gICAgICAgIGFjdGl2ZVNsaWNlLFxuICAgICAgICBhY3RpdmVUYXNrLFxuICAgICAgICBwaGFzZTogJ3JlcGxhbm5pbmctc2xpY2UnLFxuICAgICAgICByZWNlbnREZWNpc2lvbnM6IFtdLFxuICAgICAgICBibG9ja2VyczogW2BUYXNrICR7YmxvY2tlclRhc2tJZH0gZGlzY292ZXJlZCBhIGJsb2NrZXIgcmVxdWlyaW5nIHNsaWNlIHJlcGxhbmBdLFxuICAgICAgICBuZXh0QWN0aW9uOiBgVGFzayAke2Jsb2NrZXJUYXNrSWR9IHJlcG9ydGVkIGJsb2NrZXJfZGlzY292ZXJlZC4gUmVwbGFuIHNsaWNlICR7YWN0aXZlU2xpY2UuaWR9IGJlZm9yZSBjb250aW51aW5nLmAsXG4gIFxuICAgICAgICBhY3RpdmVXb3Jrc3BhY2U6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVnaXN0cnksXG4gICAgICAgIHJlcXVpcmVtZW50cyxcbiAgICAgICAgcHJvZ3Jlc3M6IHtcbiAgICAgICAgICBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcyxcbiAgICAgICAgICBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MsXG4gICAgICAgICAgdGFza3M6IHRhc2tQcm9ncmVzcyxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIFJFUExBTi5tZCBleGlzdHMgXHUyMDE0IGxvb3AgcHJvdGVjdGlvbjogZmFsbCB0aHJvdWdoIHRvIG5vcm1hbCBleGVjdXRpbmdcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBSRVBMQU4tVFJJR0dFUiBkZXRlY3Rpb246IHRyaWFnZS1pbml0aWF0ZWQgcmVwbGFuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAvLyBNYW51YWwgYC9nc2QgdHJpYWdlYCB3cml0ZXMgUkVQTEFOLVRSSUdHRVIubWQgd2hlbiBhIGNhcHR1cmUgaXMgY2xhc3NpZmllZFxuICAvLyBhcyBcInJlcGxhblwiLiBEZXRlY3QgaXQgaGVyZSBhbmQgdHJhbnNpdGlvbiB0byByZXBsYW5uaW5nLXNsaWNlIHNvIHRoZVxuICAvLyBkaXNwYXRjaCBsb29wIHBpY2tzIGl0IHVwIChpbnN0ZWFkIG9mIHNpbGVudGx5IGFkdmFuY2luZyBwYXN0IGl0KS5cbiAgaWYgKCFibG9ja2VyVGFza0lkKSB7XG4gICAgY29uc3QgcmVwbGFuVHJpZ2dlckZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUuaWQsIGFjdGl2ZVNsaWNlLmlkLCBcIlJFUExBTi1UUklHR0VSXCIpO1xuICAgIGlmIChyZXBsYW5UcmlnZ2VyRmlsZSkge1xuICAgICAgLy8gU2FtZSBsb29wIHByb3RlY3Rpb246IGlmIFJFUExBTi5tZCBhbHJlYWR5IGV4aXN0cywgYSByZXBsYW4gd2FzXG4gICAgICAvLyBhbHJlYWR5IHBlcmZvcm1lZCBcdTIwMTQgc2tpcCBmdXJ0aGVyIHJlcGxhbm5pbmcgYW5kIGNvbnRpbnVlIGV4ZWN1dGluZy5cbiAgICAgIGNvbnN0IHJlcGxhbkZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUuaWQsIGFjdGl2ZVNsaWNlLmlkLCBcIlJFUExBTlwiKTtcbiAgICAgIGlmICghcmVwbGFuRmlsZSkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGFjdGl2ZU1pbGVzdG9uZSxcbiAgICAgICAgICBhY3RpdmVTbGljZSxcbiAgICAgICAgICBhY3RpdmVUYXNrLFxuICAgICAgICAgIHBoYXNlOiAncmVwbGFubmluZy1zbGljZScsXG4gICAgICAgICAgcmVjZW50RGVjaXNpb25zOiBbXSxcbiAgICAgICAgICBibG9ja2VyczogWydUcmlhZ2UgcmVwbGFuIHRyaWdnZXIgZGV0ZWN0ZWQgXHUyMDE0IHNsaWNlIHJlcGxhbiByZXF1aXJlZCddLFxuICAgICAgICAgIG5leHRBY3Rpb246IGBUcmlhZ2UgcmVwbGFuIHRyaWdnZXJlZCBmb3Igc2xpY2UgJHthY3RpdmVTbGljZS5pZH0uIFJlcGxhbiBiZWZvcmUgY29udGludWluZy5gLFxuXG4gICAgICAgICAgYWN0aXZlV29ya3NwYWNlOiB1bmRlZmluZWQsXG4gICAgICAgICAgcmVnaXN0cnksXG4gICAgICAgICAgcmVxdWlyZW1lbnRzLFxuICAgICAgICAgIHByb2dyZXNzOiB7XG4gICAgICAgICAgICBtaWxlc3RvbmVzOiBtaWxlc3RvbmVQcm9ncmVzcyxcbiAgICAgICAgICAgIHNsaWNlczogc2xpY2VQcm9ncmVzcyxcbiAgICAgICAgICAgIHRhc2tzOiB0YXNrUHJvZ3Jlc3MsXG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvLyBDaGVjayBmb3IgaW50ZXJydXB0ZWQgd29ya1xuICBjb25zdCBzRGlyID0gcmVzb2x2ZVNsaWNlUGF0aChiYXNlUGF0aCwgYWN0aXZlTWlsZXN0b25lLmlkLCBhY3RpdmVTbGljZS5pZCk7XG4gIGNvbnN0IGNvbnRpbnVlRmlsZSA9IHNEaXIgPyByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBhY3RpdmVNaWxlc3RvbmUuaWQsIGFjdGl2ZVNsaWNlLmlkLCBcIkNPTlRJTlVFXCIpIDogbnVsbDtcbiAgLy8gQWxzbyBjaGVjayBsZWdhY3kgY29udGludWUubWRcbiAgY29uc3QgaGFzSW50ZXJydXB0ZWQgPSAhIShjb250aW51ZUZpbGUgJiYgYXdhaXQgY2FjaGVkTG9hZEZpbGUoY29udGludWVGaWxlKSkgfHxcbiAgICAhIShzRGlyICYmIGF3YWl0IGNhY2hlZExvYWRGaWxlKGpvaW4oc0RpciwgXCJjb250aW51ZS5tZFwiKSkpO1xuXG4gIHJldHVybiB7XG4gICAgYWN0aXZlTWlsZXN0b25lLFxuICAgIGFjdGl2ZVNsaWNlLFxuICAgIGFjdGl2ZVRhc2ssXG4gICAgcGhhc2U6ICdleGVjdXRpbmcnLFxuICAgIHJlY2VudERlY2lzaW9uczogW10sXG4gICAgYmxvY2tlcnM6IFtdLFxuICAgIG5leHRBY3Rpb246IGhhc0ludGVycnVwdGVkXG4gICAgICA/IGBSZXN1bWUgaW50ZXJydXB0ZWQgd29yayBvbiAke2FjdGl2ZVRhc2suaWR9OiAke2FjdGl2ZVRhc2sudGl0bGV9IGluIHNsaWNlICR7YWN0aXZlU2xpY2UuaWR9LiBSZWFkIGNvbnRpbnVlLm1kIGZpcnN0LmBcbiAgICAgIDogYEV4ZWN1dGUgJHthY3RpdmVUYXNrLmlkfTogJHthY3RpdmVUYXNrLnRpdGxlfSBpbiBzbGljZSAke2FjdGl2ZVNsaWNlLmlkfS5gLFxuICAgIHJlZ2lzdHJ5LFxuICAgIHJlcXVpcmVtZW50cyxcbiAgICBwcm9ncmVzczoge1xuICAgICAgbWlsZXN0b25lczogbWlsZXN0b25lUHJvZ3Jlc3MsXG4gICAgICBzbGljZXM6IHNsaWNlUHJvZ3Jlc3MsXG4gICAgICB0YXNrczogdGFza1Byb2dyZXNzLFxuICAgIH0sXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFlQTtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFFUDtBQUFBLEVBRUU7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBRVAsU0FBUyx3QkFBd0I7QUFDakMsU0FBUyxnQkFBZ0Isd0JBQXdCO0FBQ2pELFNBQVMsZ0JBQWdCLHdCQUF3QjtBQUNqRCxTQUFTLGdDQUFzRDtBQUUvRCxTQUFTLE1BQU0sZUFBZTtBQUM5QixTQUFTLFlBQVksbUJBQW1CO0FB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TSxvQkFBb0IsaUJBQWlCLFVBQVUsZ0JBQWdCLElBQUksWUFBWSxJQUFJLGdCQUFnQjtBQUN6RyxRQUFJLG1CQUFtQjtBQUdyQixZQUFNLGFBQWEsaUJBQWlCLFVBQVUsZ0JBQWdCLElBQUksWUFBWSxJQUFJLFFBQVE7QUFDMUYsVUFBSSxDQUFDLFlBQVk7QUFDZixlQUFPO0FBQUEsVUFDTDtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQSxPQUFPO0FBQUEsVUFDUCxpQkFBaUIsQ0FBQztBQUFBLFVBQ2xCLFVBQVUsQ0FBQyw2REFBd0Q7QUFBQSxVQUNuRSxZQUFZLHFDQUFxQyxZQUFZLEVBQUU7QUFBQSxVQUUvRCxpQkFBaUI7QUFBQSxVQUNqQjtBQUFBLFVBQ0E7QUFBQSxVQUNBLFVBQVU7QUFBQSxZQUNSLFlBQVk7QUFBQSxZQUNaLFFBQVE7QUFBQSxZQUNSLE9BQU87QUFBQSxVQUNUO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUdBLFFBQU0sT0FBTyxpQkFBaUIsVUFBVSxnQkFBZ0IsSUFBSSxZQUFZLEVBQUU7QUFDMUUsUUFBTSxlQUFlLE9BQU8saUJBQWlCLFVBQVUsZ0JBQWdCLElBQUksWUFBWSxJQUFJLFVBQVUsSUFBSTtBQUV6RyxRQUFNLGlCQUFpQixDQUFDLEVBQUUsZ0JBQWdCLE1BQU0sZUFBZSxZQUFZLE1BQ3pFLENBQUMsRUFBRSxRQUFRLE1BQU0sZUFBZSxLQUFLLE1BQU0sYUFBYSxDQUFDO0FBRTNELFNBQU87QUFBQSxJQUNMO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLE9BQU87QUFBQSxJQUNQLGlCQUFpQixDQUFDO0FBQUEsSUFDbEIsVUFBVSxDQUFDO0FBQUEsSUFDWCxZQUFZLGlCQUNSLDhCQUE4QixXQUFXLEVBQUUsS0FBSyxXQUFXLEtBQUssYUFBYSxZQUFZLEVBQUUsOEJBQzNGLFdBQVcsV0FBVyxFQUFFLEtBQUssV0FBVyxLQUFLLGFBQWEsWUFBWSxFQUFFO0FBQUEsSUFDNUU7QUFBQSxJQUNBO0FBQUEsSUFDQSxVQUFVO0FBQUEsTUFDUixZQUFZO0FBQUEsTUFDWixRQUFRO0FBQUEsTUFDUixPQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0Y7QUFDRjsiLAogICJuYW1lcyI6IFsibWlsZXN0b25lSWRzIiwgInN1bW1hcnlGaWxlIiwgInRpdGxlIiwgInNmIiwgInJvYWRtYXAiLCAic2xpY2VQcm9ncmVzcyJdCn0K
