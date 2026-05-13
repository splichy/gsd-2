import { loadFile, extractUatType, loadActiveOverrides } from "./files.js";
import { isDbAvailable, getMilestoneSlices, getPendingGates, markAllGatesOmitted, getMilestone, insertAssessment, transaction } from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";
import { extractVerdict, isAcceptableUatVerdict } from "./verdict-parser.js";
import {
  gsdRoot,
  resolveMilestoneFile,
  resolveMilestonePath,
  resolveSliceFile,
  resolveTaskFile,
  relSliceFile,
  buildMilestoneFileName
} from "./paths.js";
import { parseRoadmap } from "./parsers-legacy.js";
import { validateArtifact } from "./schemas/validate.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { logWarning, logError } from "./workflow-logger.js";
import { join } from "node:path";
import { hasImplementationArtifacts } from "./auto-recovery.js";
import {
  buildDiscussMilestonePrompt,
  buildDiscussProjectPrompt,
  buildDiscussRequirementsPrompt,
  buildResearchDecisionPrompt,
  buildResearchProjectPrompt,
  buildResearchMilestonePrompt,
  buildPlanMilestonePrompt,
  buildResearchSlicePrompt,
  buildPlanSlicePrompt,
  buildRefineSlicePrompt,
  buildExecuteTaskPrompt,
  buildCompleteSlicePrompt,
  buildCompleteMilestonePrompt,
  buildValidateMilestonePrompt,
  buildReplanSlicePrompt,
  buildRunUatPrompt,
  buildReassessRoadmapPrompt,
  buildRewriteDocsPrompt,
  buildReactiveExecutePrompt,
  buildGateEvaluatePrompt,
  buildParallelResearchSlicesPrompt,
  checkNeedsReassessment,
  checkNeedsRunUat
} from "./auto-prompts.js";
import { resolveModelWithFallbacksForUnit } from "./preferences-models.js";
import { resolveUokFlags } from "./uok/flags.js";
import { selectReactiveDispatchBatch } from "./uok/execution-graph.js";
import { getMilestonePipelineVariant } from "./milestone-scope-classifier.js";
import { EXECUTION_ENTRY_PHASES, hasFinalizedMilestoneContext } from "./uok/plan-v2.js";
import { isAutoActive } from "./auto.js";
import { markDepthVerified } from "./bootstrap/write-gate.js";
import { ensureWorkflowPreferencesCaptured } from "./planning-depth.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import {
  PROJECT_RESEARCH_INFLIGHT_MARKER
} from "./project-research-policy.js";
import {
  isWorkflowPrefsCaptured,
  resolveDeepProjectSetupState
} from "./deep-project-setup-policy.js";
import { annotateBackgroundable } from "./delegation-policy.js";
import { invalidateAllCaches } from "./cache.js";
import { insertMilestoneValidationGates } from "./milestone-validation-gates.js";
let reassessmentChecker = checkNeedsReassessment;
let researchProjectPromptBuilder = buildResearchProjectPrompt;
function shouldBypassMilestoneDepthGateInAuto(prefs) {
  return isAutoActive() && prefs?.planning_depth !== "deep";
}
function setReassessmentCheckerForTest(checker) {
  const previous = reassessmentChecker;
  reassessmentChecker = checker;
  return () => {
    reassessmentChecker = previous;
  };
}
function setResearchProjectPromptBuilderForTest(builder) {
  const previous = researchProjectPromptBuilder;
  researchProjectPromptBuilder = builder;
  return () => {
    researchProjectPromptBuilder = previous;
  };
}
async function readUatGateVerdict(basePath, mid, sliceId) {
  const uatFile = resolveSliceFile(basePath, mid, sliceId, "UAT");
  const assessmentFile = resolveSliceFile(basePath, mid, sliceId, "ASSESSMENT");
  const uatContent = uatFile ? await loadFile(uatFile) : null;
  const uatType = uatContent ? extractUatType(uatContent) : void 0;
  const assessmentContent = assessmentFile ? await loadFile(assessmentFile) : null;
  if (assessmentContent) {
    const assessmentVerdict = extractVerdict(assessmentContent);
    if (assessmentVerdict) {
      return {
        verdict: assessmentVerdict,
        uatType: uatType ?? extractUatType(assessmentContent)
      };
    }
  }
  if (uatContent) {
    const legacyUatVerdict = extractVerdict(uatContent);
    if (legacyUatVerdict) {
      return { verdict: legacyUatVerdict, uatType };
    }
  }
  return null;
}
function getDeepStageGate(prefs, basePath) {
  return resolveDeepProjectSetupState(prefs, basePath);
}
function hasPendingDeepStage(prefs, basePath) {
  const gate = getDeepStageGate(prefs, basePath);
  return gate.status === "pending" || gate.status === "blocked";
}
function shouldRunDeepProjectSetup(state, prefs, basePath, options = {}) {
  if (options.hasSurvivorBranch === true) return false;
  if (state.phase !== "pre-planning" && state.phase !== "needs-discussion" && state.phase !== "planning") {
    return false;
  }
  return hasPendingDeepStage(prefs, basePath);
}
function missingSliceStop(mid, phase) {
  return {
    action: "stop",
    reason: `${mid}: phase "${phase}" has no active slice \u2014 run /gsd doctor.`,
    level: "error"
  };
}
function isRegistryMilestoneComplete(state, mid) {
  return state.registry.some(
    (milestone) => milestone.id === mid && milestone.status === "complete"
  );
}
function findMissingSummaries(basePath, mid) {
  if (!isDbAvailable()) return [];
  const slices = getMilestoneSlices(mid);
  const CLOSED_STATUSES = /* @__PURE__ */ new Set(["skipped", "complete", "done"]);
  return slices.filter((s) => !CLOSED_STATUSES.has(s.status)).filter((s) => {
    const summaryPath = resolveSliceFile(basePath, mid, s.id, "SUMMARY");
    return !summaryPath || !existsSync(summaryPath);
  }).map((s) => s.id);
}
const MAX_REWRITE_ATTEMPTS = 3;
function rewriteCountPath(basePath) {
  return join(gsdRoot(basePath), "runtime", "rewrite-count.json");
}
function getRewriteCount(basePath) {
  try {
    const data = JSON.parse(readFileSync(rewriteCountPath(basePath), "utf-8"));
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}
function setRewriteCount(basePath, count) {
  const filePath = rewriteCountPath(basePath);
  mkdirSync(join(gsdRoot(basePath), "runtime"), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ count, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }) + "\n");
}
const MAX_UAT_ATTEMPTS = 3;
function uatCountPath(basePath, mid, sid) {
  return join(gsdRoot(basePath), "runtime", `uat-count-${mid}-${sid}.json`);
}
function getUatCount(basePath, mid, sid) {
  try {
    const data = JSON.parse(readFileSync(uatCountPath(basePath, mid, sid), "utf-8"));
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}
function incrementUatCount(basePath, mid, sid) {
  const count = getUatCount(basePath, mid, sid) + 1;
  const filePath = uatCountPath(basePath, mid, sid);
  mkdirSync(join(gsdRoot(basePath), "runtime"), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ count, updatedAt: (/* @__PURE__ */ new Date()).toISOString() }) + "\n");
  return count;
}
function isVerificationNotApplicable(value) {
  const v = (value ?? "").toLowerCase().trim().replace(/[.\s]+$/, "");
  if (!v || v === "none") return true;
  return /^(?:none(?:[\s._\u2014-]+[\s\S]*)?|n\/?a|not[\s._-]+(?:applicable|required|needed|provided)|no[\s._-]+operational[\s\S]*)$/i.test(v);
}
const DISPATCH_RULES = [
  {
    // ADR-011 Phase 2: pause-for-escalation must evaluate FIRST so phase-
    // agnostic rules (rewrite-docs gate, UAT checks, reassess) cannot bypass
    // the user's pending decision. Only fires for continueWithDefault=false
    // escalations (those set escalation_pending=1); awaiting-review artifacts
    // never enter the 'escalating-task' phase.
    name: "escalating-task \u2192 pause-for-escalation",
    match: async ({ state, mid }) => {
      if (state.phase !== "escalating-task") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      return {
        action: "stop",
        reason: state.nextAction || `${mid}: task escalation awaits user resolution. Run /gsd escalate list to see pending items.`,
        level: "info"
      };
    }
  },
  {
    name: "rewrite-docs (override gate)",
    match: async ({ mid, midTitle, state, basePath, session }) => {
      const pendingOverrides = await loadActiveOverrides(basePath);
      if (pendingOverrides.length === 0) return null;
      const count = getRewriteCount(basePath);
      if (count >= MAX_REWRITE_ATTEMPTS) {
        const { resolveAllOverrides } = await import("./files.js");
        await resolveAllOverrides(basePath);
        setRewriteCount(basePath, 0);
        return null;
      }
      setRewriteCount(basePath, count + 1);
      const unitId = state.activeSlice ? `${mid}/${state.activeSlice.id}` : mid;
      return {
        action: "dispatch",
        unitType: "rewrite-docs",
        unitId,
        prompt: await buildRewriteDocsPrompt(
          mid,
          midTitle,
          state.activeSlice,
          basePath,
          pendingOverrides
        )
      };
    }
  },
  {
    // #4671 — Recovery path for execution-entry phases with missing CONTEXT.md.
    //
    // Once `deriveStateFromDb` returns an execution-entry phase (executing /
    // summarizing / validating-milestone / completing-milestone), the
    // pre-planning guard at `pre-planning (no context) → discuss-milestone`
    // no longer fires. The plan-v2 gate correctly detects the missing context
    // but can only block — it cannot redispatch. Without this rule the
    // milestone is stuck until `/gsd doctor heal` repairs it (and heal
    // historically missed this check too).
    //
    // Fire BEFORE the execution-entry phase rules so we redispatch to
    // `discuss-milestone` instead of hitting the plan-v2 gate.
    name: "execution-entry phase (no context) \u2192 discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs, structuredQuestionsAvailable }) => {
      if (!EXECUTION_ENTRY_PHASES.has(state.phase)) return null;
      if (!MILESTONE_ID_RE.test(mid)) return null;
      if (isRegistryMilestoneComplete(state, mid)) return null;
      if (hasFinalizedMilestoneContext(basePath, mid)) return null;
      if (shouldBypassMilestoneDepthGateInAuto(prefs)) {
        markDepthVerified(mid, basePath);
      }
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(
          mid,
          midTitle,
          basePath,
          structuredQuestionsAvailable
        )
      };
    }
  },
  {
    name: "summarizing \u2192 complete-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "summarizing") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      return {
        action: "dispatch",
        unitType: "complete-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildCompleteSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath
        )
      };
    }
  },
  {
    name: "run-uat (post-completion)",
    match: async ({ state, mid, basePath, prefs }) => {
      const needsRunUat = await checkNeedsRunUat(basePath, mid, state, prefs);
      if (!needsRunUat) return null;
      const { sliceId, uatType } = needsRunUat;
      const attempts = incrementUatCount(basePath, mid, sliceId);
      if (attempts > MAX_UAT_ATTEMPTS) {
        return {
          action: "stop",
          reason: `run-uat for ${mid}/${sliceId} has been dispatched ${attempts - 1} times without producing a verdict. Verification commands may be broken \u2014 fix the UAT spec or manually write an ASSESSMENT verdict.`,
          level: "warning"
        };
      }
      const uatFile = resolveSliceFile(basePath, mid, sliceId, "UAT");
      const uatContent = await loadFile(uatFile);
      return {
        action: "dispatch",
        unitType: "run-uat",
        unitId: `${mid}/${sliceId}`,
        prompt: await buildRunUatPrompt(
          mid,
          sliceId,
          relSliceFile(basePath, mid, sliceId, "UAT"),
          uatContent ?? "",
          basePath
        ),
        pauseAfterDispatch: !process.env.GSD_HEADLESS && uatType !== "artifact-driven" && uatType !== "browser-executable" && uatType !== "runtime-executable"
      };
    }
  },
  {
    name: "uat-verdict-gate (non-PASS blocks progression)",
    match: async ({ mid, basePath, prefs }) => {
      if (!prefs?.uat_dispatch) return null;
      let closedSliceIds;
      if (isDbAvailable()) {
        closedSliceIds = getMilestoneSlices(mid).filter((s) => isClosedStatus(s.status)).map((s) => s.id);
      } else {
        const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
        const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
        if (!roadmapContent) return null;
        const roadmap = parseRoadmap(roadmapContent);
        closedSliceIds = roadmap.slices.filter((s) => s.done).map((s) => s.id);
      }
      for (const sliceId of closedSliceIds) {
        const result = await readUatGateVerdict(basePath, mid, sliceId);
        if (!result) continue;
        const { verdict, uatType } = result;
        if (!isAcceptableUatVerdict(verdict, uatType)) {
          return {
            action: "stop",
            reason: `UAT verdict for ${sliceId} is "${verdict}" \u2014 blocking progression until resolved.
Review the UAT result and update the verdict to PASS, or re-run /gsd auto after fixing.`,
            level: "warning"
          };
        }
      }
      return null;
    }
  },
  {
    name: "reassess-roadmap (post-completion)",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (prefs?.phases?.skip_reassess) return null;
      const reassessEnabled = prefs?.phases?.reassess_after_slice ?? false;
      if (!reassessEnabled) return null;
      const needsReassess = await reassessmentChecker(basePath, mid, state);
      if (!needsReassess) return null;
      return {
        action: "dispatch",
        unitType: "reassess-roadmap",
        unitId: `${mid}/${needsReassess.sliceId}`,
        prompt: await buildReassessRoadmapPrompt(
          mid,
          midTitle,
          needsReassess.sliceId,
          basePath
        )
      };
    }
  },
  {
    name: "needs-discussion \u2192 discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs, structuredQuestionsAvailable }) => {
      if (state.phase !== "needs-discussion") return null;
      if (hasPendingDeepStage(prefs, basePath)) return null;
      if (shouldBypassMilestoneDepthGateInAuto(prefs)) {
        markDepthVerified(mid, basePath);
      }
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(
          mid,
          midTitle,
          basePath,
          structuredQuestionsAvailable
        )
      };
    }
  },
  {
    // Deep mode stage gate: workflow preferences not yet captured.
    // This used to dispatch an agent unit, but the step is deterministic
    // defaults-writing. Keep it in-process so missing preferences cannot loop
    // on the same no-input unit until stuck detection fires.
    name: "deep: pre-planning (no workflow prefs) \u2192 workflow-preferences",
    match: async ({ state, basePath, prefs }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      if (isWorkflowPrefsCaptured(basePath)) return null;
      ensureWorkflowPreferencesCaptured(basePath);
      return null;
    }
  },
  {
    // Deep mode stage gate: PROJECT.md missing or invalid.
    // Fires only when planning_depth === "deep" and PROJECT.md is missing/invalid.
    // Project-level interview must complete before any milestone-level discussion.
    // Light mode (default) skips this rule entirely — falls through to milestone rules.
    name: "deep: pre-planning (no PROJECT) \u2192 discuss-project",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const projectPath = join(gsdRoot(basePath), "PROJECT.md");
      if (existsSync(projectPath) && validateArtifact(projectPath, "project").ok) return null;
      return {
        action: "dispatch",
        unitType: "discuss-project",
        unitId: "PROJECT",
        prompt: await buildDiscussProjectPrompt(basePath, structuredQuestionsAvailable)
      };
    }
  },
  {
    // Deep mode stage gate: REQUIREMENTS.md missing or invalid.
    // Fires only when planning_depth === "deep", PROJECT.md is valid, and
    // REQUIREMENTS.md is missing/invalid.
    // Falls through in light mode or when REQUIREMENTS.md already exists and is valid.
    name: "deep: pre-planning (no REQUIREMENTS) \u2192 discuss-requirements",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const projectPath = join(gsdRoot(basePath), "PROJECT.md");
      if (!existsSync(projectPath) || !validateArtifact(projectPath, "project").ok) return null;
      const requirementsPath = join(gsdRoot(basePath), "REQUIREMENTS.md");
      if (existsSync(requirementsPath) && validateArtifact(requirementsPath, "requirements").ok) return null;
      return {
        action: "dispatch",
        unitType: "discuss-requirements",
        unitId: "REQUIREMENTS",
        prompt: await buildDiscussRequirementsPrompt(basePath, structuredQuestionsAvailable)
      };
    }
  },
  {
    // Deep mode research gate: capture user's research decision.
    // Fires after discuss-requirements (REQUIREMENTS.md exists) when no decision
    // marker has been written yet. Asks one yes/no question via ask_user_questions
    // and writes .gsd/runtime/research-decision.json. Downstream research-project
    // rule reads the marker to decide whether to fan out 4 parallel research subagents.
    // Light mode skips entirely.
    name: "deep: pre-planning (no research decision) \u2192 research-decision",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const gate = resolveDeepProjectSetupState(prefs, basePath);
      if (gate.status !== "pending" || gate.stage !== "research-decision") return null;
      return {
        action: "dispatch",
        unitType: "research-decision",
        unitId: "RESEARCH-DECISION",
        prompt: await buildResearchDecisionPrompt(basePath, structuredQuestionsAvailable)
      };
    }
  },
  {
    // Deep mode parallel research.
    // Fires when planning_depth === "deep", REQUIREMENTS.md exists,
    // research-decision marker says "research", and any of the 4 project
    // research files is missing. Spawns one orchestrator session that fans
    // out 4 parallel subagents (stack, features, architecture, pitfalls).
    // Skipped entirely when user chose "skip" at the research-decision gate.
    name: "deep: pre-planning (research approved, files missing) \u2192 research-project",
    match: async ({ state, basePath, prefs, structuredQuestionsAvailable }) => {
      if (prefs?.planning_depth !== "deep") return null;
      if (state.phase !== "pre-planning" && state.phase !== "needs-discussion") return null;
      const gate = resolveDeepProjectSetupState(prefs, basePath);
      if (gate.status === "blocked" && gate.stage === "project-research") {
        return {
          action: "stop",
          reason: gate.reason,
          level: "warning"
        };
      }
      if (gate.status !== "pending" || gate.stage !== "project-research") return null;
      const runtimeDir = join(gsdRoot(basePath), "runtime");
      const inflightMarkerPath = join(runtimeDir, PROJECT_RESEARCH_INFLIGHT_MARKER);
      const researchInFlightStop = {
        action: "stop",
        reason: "Project research is already in progress. Wait for it to finish, or clear `.gsd/runtime/research-project-inflight` if the prior run crashed.",
        level: "info"
      };
      if (existsSync(inflightMarkerPath)) return researchInFlightStop;
      mkdirSync(runtimeDir, { recursive: true });
      try {
        writeFileSync(
          inflightMarkerPath,
          JSON.stringify({ started: (/* @__PURE__ */ new Date()).toISOString() }) + "\n",
          { encoding: "utf-8", flag: "wx" }
        );
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
          return researchInFlightStop;
        }
        throw err;
      }
      try {
        const prompt = await researchProjectPromptBuilder(basePath, structuredQuestionsAvailable);
        return {
          action: "dispatch",
          unitType: "research-project",
          unitId: "RESEARCH-PROJECT",
          prompt
        };
      } catch (err) {
        try {
          if (existsSync(inflightMarkerPath)) unlinkSync(inflightMarkerPath);
        } catch (cleanupErr) {
          logWarning(
            "dispatch",
            `failed to remove research-project in-flight marker after prompt assembly error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
          );
        }
        throw err;
      }
    }
  },
  {
    name: "pre-planning (no context) \u2192 discuss-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs, structuredQuestionsAvailable }) => {
      if (state.phase !== "pre-planning") return null;
      if (isRegistryMilestoneComplete(state, mid)) return null;
      const contextFile = resolveMilestoneFile(basePath, mid, "CONTEXT");
      const hasContext = !!(contextFile && await loadFile(contextFile));
      if (hasContext) return null;
      if (prefs?.planning_depth === "deep") return null;
      if (shouldBypassMilestoneDepthGateInAuto(prefs)) {
        markDepthVerified(mid, basePath);
      }
      return {
        action: "dispatch",
        unitType: "discuss-milestone",
        unitId: mid,
        prompt: await buildDiscussMilestonePrompt(
          mid,
          midTitle,
          basePath,
          structuredQuestionsAvailable
        )
      };
    }
  },
  {
    name: "pre-planning (no research) \u2192 research-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "pre-planning") return null;
      if (prefs?.phases?.skip_research) return null;
      const researchFile = resolveMilestoneFile(basePath, mid, "RESEARCH");
      if (researchFile) return null;
      return {
        action: "dispatch",
        unitType: "research-milestone",
        unitId: mid,
        prompt: await buildResearchMilestonePrompt(mid, midTitle, basePath)
      };
    }
  },
  {
    name: "pre-planning (has research) \u2192 plan-milestone",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "pre-planning") return null;
      return {
        action: "dispatch",
        unitType: "plan-milestone",
        unitId: mid,
        prompt: await buildPlanMilestonePrompt(mid, midTitle, basePath)
      };
    }
  },
  {
    name: "planning (require_slice_discussion) \u2192 pause for discussion (#3454)",
    match: async ({ state, mid, basePath, prefs }) => {
      if (state.phase !== "planning") return null;
      if (!prefs?.phases?.require_slice_discussion) return null;
      if (!state.activeSlice) return null;
      const sliceContextFile = resolveSliceFile(basePath, mid, state.activeSlice.id, "CONTEXT");
      if (sliceContextFile && existsSync(sliceContextFile)) return null;
      return {
        action: "stop",
        reason: `Slice ${state.activeSlice.id} requires discussion before planning (require_slice_discussion is enabled). Run /gsd discuss to discuss this slice, then /gsd auto to resume.`,
        level: "info"
      };
    }
  },
  {
    // Keep this rule before the single-slice research rule so the multi-slice
    // path wins whenever 2+ slices are ready.
    name: "planning (multiple slices need research) \u2192 parallel-research-slices",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "planning") return null;
      if (prefs?.phases?.skip_research || prefs?.phases?.skip_slice_research) return null;
      if (await getMilestonePipelineVariant(mid) === "trivial") return null;
      const roadmapFile = resolveMilestoneFile(basePath, mid, "ROADMAP");
      const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
      if (!roadmapContent) return null;
      const roadmap = parseRoadmap(roadmapContent);
      const milestoneResearchFile = resolveMilestoneFile(basePath, mid, "RESEARCH");
      const researchReadySlices = [];
      for (const slice of roadmap.slices) {
        if (slice.done) continue;
        if (milestoneResearchFile && slice.id === "S01") continue;
        if (resolveSliceFile(basePath, mid, slice.id, "RESEARCH")) continue;
        const depsComplete = (slice.depends ?? []).every(
          (depId) => !!resolveSliceFile(basePath, mid, depId, "SUMMARY")
        );
        if (!depsComplete) continue;
        researchReadySlices.push({ id: slice.id, title: slice.title });
      }
      if (researchReadySlices.length < 2) return null;
      const parallelBlocker = resolveMilestoneFile(basePath, mid, "PARALLEL-BLOCKER");
      if (parallelBlocker) return null;
      return {
        action: "dispatch",
        unitType: "research-slice",
        unitId: `${mid}/parallel-research`,
        prompt: await buildParallelResearchSlicesPrompt(
          mid,
          midTitle,
          researchReadySlices,
          basePath,
          resolveModelWithFallbacksForUnit("subagent")?.primary
        )
      };
    }
  },
  {
    name: "planning (no research, not S01) \u2192 research-slice",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "planning") return null;
      if (prefs?.phases?.skip_research || prefs?.phases?.skip_slice_research)
        return null;
      if (await getMilestonePipelineVariant(mid) === "trivial") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const researchFile = resolveSliceFile(basePath, mid, sid, "RESEARCH");
      if (researchFile) return null;
      const milestoneResearchFile = resolveMilestoneFile(
        basePath,
        mid,
        "RESEARCH"
      );
      if (milestoneResearchFile && sid === "S01") return null;
      return {
        action: "dispatch",
        unitType: "research-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildResearchSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath
        )
      };
    }
  },
  {
    // ADR-011: sketch-then-refine. When `refining` phase fires, expand the
    // sketch into a full plan using the prior slice's SUMMARY and the current
    // codebase. If the user flipped `progressive_planning` off mid-milestone
    // while a slice is still `is_sketch=1`, fall through to a standard
    // plan-slice so the loop doesn't dead-end.
    //
    // Note on the flag-OFF downgrade: DB slice metadata is authoritative.
    // PLAN.md is only a projection, so plan-slice/refine-slice handlers must
    // explicitly clear `is_sketch` when a sketch becomes a full plan.
    name: "refining \u2192 refine-slice",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (state.phase !== "refining") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const progressiveOn = prefs?.phases?.progressive_planning === true;
      if (!progressiveOn) {
        let softScopeHint = "";
        try {
          const { isDbAvailable: isDbAvailable2, getSlice } = await import("./gsd-db.js");
          if (isDbAvailable2()) {
            softScopeHint = getSlice(mid, sid)?.sketch_scope ?? "";
          }
        } catch {
          softScopeHint = "";
        }
        return {
          action: "dispatch",
          unitType: "plan-slice",
          unitId: `${mid}/${sid}`,
          prompt: await buildPlanSlicePrompt(
            mid,
            midTitle,
            sid,
            sTitle,
            basePath,
            void 0,
            { ...softScopeHint ? { softScopeHint } : {}, sessionContextWindow, modelRegistry, sessionProvider }
          )
        };
      }
      return {
        action: "dispatch",
        unitType: "refine-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildRefineSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
          void 0,
          { sessionContextWindow, modelRegistry, sessionProvider }
        )
      };
    }
  },
  {
    name: "planning \u2192 plan-slice",
    match: async ({ state, mid, midTitle, basePath, sessionContextWindow, modelRegistry, sessionProvider, session }) => {
      if (state.phase !== "planning") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const unitId = `${mid}/${sid}`;
      let priorPreExecFailure;
      if (session?.lastPreExecFailure?.unitId === unitId) {
        const MAX_PRE_EXEC_RETRIES = 2;
        const retryCount = session.preExecRetryCount?.get(unitId) ?? 0;
        if (retryCount >= MAX_PRE_EXEC_RETRIES) {
          const findings = session.lastPreExecFailure.blockingFindings.join("; ");
          session.lastPreExecFailure = null;
          session.preExecRetryCount?.delete(unitId);
          return {
            action: "stop",
            reason: `Pre-execution checks failed ${retryCount} times for ${unitId} \u2014 manual intervention required. Blocking findings: ${findings}. Fix the plan manually, then run /gsd auto to resume.`,
            level: "error",
            matchedRule: "planning \u2192 plan-slice"
          };
        }
        priorPreExecFailure = {
          blockingFindings: session.lastPreExecFailure.blockingFindings,
          verdictExcerpt: session.lastPreExecFailure.verdictExcerpt
        };
        session.lastPreExecFailure = null;
      }
      return {
        action: "dispatch",
        unitType: "plan-slice",
        unitId,
        prompt: await buildPlanSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
          void 0,
          { sessionContextWindow, modelRegistry, sessionProvider, priorPreExecFailure }
        )
      };
    }
  },
  {
    name: "evaluating-gates \u2192 gate-evaluate",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "evaluating-gates") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const gateConfig = prefs?.gate_evaluation;
      if (!gateConfig?.enabled) {
        markAllGatesOmitted(mid, sid);
        return { action: "skip" };
      }
      const pending = getPendingGates(mid, sid, "slice");
      if (pending.length === 0) return { action: "skip" };
      return {
        action: "dispatch",
        unitType: "gate-evaluate",
        unitId: `${mid}/${sid}/gates+${pending.map((g) => g.gate_id).join(",")}`,
        prompt: await buildGateEvaluatePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath,
          resolveModelWithFallbacksForUnit("subagent")?.primary
        )
      };
    }
  },
  {
    name: "replanning-slice \u2192 replan-slice",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "replanning-slice") return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      return {
        action: "dispatch",
        unitType: "replan-slice",
        unitId: `${mid}/${sid}`,
        prompt: await buildReplanSlicePrompt(
          mid,
          midTitle,
          sid,
          sTitle,
          basePath
        )
      };
    }
  },
  {
    name: "executing \u2192 reactive-execute (parallel dispatch)",
    match: async ({ state, mid, midTitle, basePath, prefs, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return null;
      const reactiveConfig = prefs?.reactive_execution;
      if (reactiveConfig?.enabled === false) return null;
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const maxParallel = reactiveConfig?.max_parallel ?? 2;
      const subagentModel = reactiveConfig?.subagent_model ?? resolveModelWithFallbacksForUnit("subagent")?.primary;
      const minReadyTasksForReactive = reactiveConfig?.enabled === true ? 2 : 3;
      if (maxParallel <= 1) return null;
      try {
        const {
          loadSliceTaskIO,
          deriveTaskGraph,
          isGraphAmbiguous,
          getReadyTasks,
          chooseNonConflictingSubset,
          graphMetrics
        } = await import("./reactive-graph.js");
        const taskIO = await loadSliceTaskIO(basePath, mid, sid);
        if (taskIO.length < 2) return null;
        const graph = deriveTaskGraph(taskIO);
        if (isGraphAmbiguous(graph)) return null;
        const completed = new Set(graph.filter((n) => n.done).map((n) => n.id));
        const readyIds = getReadyTasks(graph, completed, /* @__PURE__ */ new Set());
        if (readyIds.length < minReadyTasksForReactive) return null;
        const uokFlags = resolveUokFlags(prefs);
        const selected = uokFlags.executionGraph ? selectReactiveDispatchBatch({
          graph,
          readyIds,
          maxParallel,
          inFlightOutputs: /* @__PURE__ */ new Set()
        }).selected : chooseNonConflictingSubset(
          readyIds,
          graph,
          maxParallel,
          /* @__PURE__ */ new Set()
        );
        if (selected.length <= 1) return null;
        const metrics = graphMetrics(graph);
        process.stderr.write(
          `gsd-reactive: ${mid}/${sid} graph \u2014 tasks:${metrics.taskCount} edges:${metrics.edgeCount} ready:${metrics.readySetSize} dispatching:${selected.length} ambiguous:${metrics.ambiguous}
`
        );
        const { saveReactiveState } = await import("./reactive-graph.js");
        saveReactiveState(basePath, mid, sid, {
          sliceId: sid,
          completed: [...completed],
          dispatched: selected,
          graphSnapshot: metrics,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        const batchSuffix = selected.join(",");
        return {
          action: "dispatch",
          unitType: "reactive-execute",
          unitId: `${mid}/${sid}/reactive+${batchSuffix}`,
          prompt: await buildReactiveExecutePrompt(
            mid,
            midTitle,
            sid,
            sTitle,
            selected,
            basePath,
            subagentModel,
            { sessionContextWindow, modelRegistry, sessionProvider }
          )
        };
      } catch (err) {
        logError("dispatch", "reactive graph derivation failed", { error: err.message });
        return null;
      }
    }
  },
  {
    name: "executing \u2192 execute-task (recover missing task plan \u2192 plan-slice)",
    match: async ({ state, mid, midTitle, basePath, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const tid = state.activeTask.id;
      const taskPlanPath = resolveTaskFile(basePath, mid, sid, tid, "PLAN");
      if (!taskPlanPath || !existsSync(taskPlanPath)) {
        return {
          action: "dispatch",
          unitType: "plan-slice",
          unitId: `${mid}/${sid}`,
          prompt: await buildPlanSlicePrompt(
            mid,
            midTitle,
            sid,
            sTitle,
            basePath,
            void 0,
            { sessionContextWindow, modelRegistry, sessionProvider }
          )
        };
      }
      return null;
    }
  },
  {
    name: "executing \u2192 execute-task",
    match: async ({ state, mid, basePath, sessionContextWindow, modelRegistry, sessionProvider }) => {
      if (state.phase !== "executing" || !state.activeTask) return null;
      if (!state.activeSlice) return missingSliceStop(mid, state.phase);
      const sid = state.activeSlice.id;
      const sTitle = state.activeSlice.title;
      const tid = state.activeTask.id;
      const tTitle = state.activeTask.title;
      return {
        action: "dispatch",
        unitType: "execute-task",
        unitId: `${mid}/${sid}/${tid}`,
        prompt: await buildExecuteTaskPrompt(
          mid,
          sid,
          sTitle,
          tid,
          tTitle,
          basePath,
          { sessionContextWindow, modelRegistry, sessionProvider }
        )
      };
    }
  },
  {
    name: "validating-milestone \u2192 validate-milestone",
    match: async ({ state, mid, midTitle, basePath, prefs }) => {
      if (state.phase !== "validating-milestone") return null;
      const missingSlices = findMissingSummaries(basePath, mid);
      if (missingSlices.length > 0) {
        return {
          action: "stop",
          reason: `Cannot validate milestone ${mid}: slices ${missingSlices.join(", ")} are missing SUMMARY files. These slices may have been skipped.`,
          level: "error"
        };
      }
      const trivialVariant = await getMilestonePipelineVariant(mid) === "trivial";
      if (prefs?.phases?.skip_milestone_validation || trivialVariant) {
        const mDir = resolveMilestonePath(basePath, mid);
        if (mDir) {
          if (!existsSync(mDir)) mkdirSync(mDir, { recursive: true });
          const validationPath = join(
            mDir,
            buildMilestoneFileName(mid, "VALIDATION")
          );
          const skipSource = trivialVariant ? "trivial-scope pipeline variant (#4781)" : "`skip_milestone_validation` preference";
          const skipValidationReason = trivialVariant ? "trivial-scope" : "preference";
          const content = [
            "---",
            "verdict: pass",
            "skip_validation: true",
            `skip_validation_reason: ${skipValidationReason}`,
            "remediation_round: 0",
            "---",
            "",
            "# Milestone Validation (skipped)",
            "",
            `Milestone validation was skipped via ${skipSource}.`
          ].join("\n");
          writeFileSync(validationPath, content, "utf-8");
          try {
            if (isDbAvailable()) {
              transaction(() => {
                insertAssessment({
                  path: validationPath,
                  milestoneId: mid,
                  sliceId: null,
                  taskId: null,
                  status: "pass",
                  scope: "milestone-validation",
                  fullContent: content
                });
                const gateSliceId = getMilestoneSlices(mid)[0]?.id;
                if (gateSliceId) {
                  insertMilestoneValidationGates(
                    mid,
                    gateSliceId,
                    "pass",
                    (/* @__PURE__ */ new Date()).toISOString()
                  );
                }
              });
            }
          } catch (err) {
            try {
              unlinkSync(validationPath);
            } catch (unlinkErr) {
              logWarning(
                "dispatch",
                `failed to remove skipped validation file after DB write failure for ${mid}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}`
              );
            }
            throw err;
          }
          invalidateAllCaches();
        }
        return { action: "skip" };
      }
      return {
        action: "dispatch",
        unitType: "validate-milestone",
        unitId: mid,
        prompt: await buildValidateMilestonePrompt(mid, midTitle, basePath)
      };
    }
  },
  {
    name: "completing-milestone \u2192 complete-milestone",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "completing-milestone") return null;
      if (isDbAvailable()) {
        const milestone = getMilestone(mid);
        if (milestone && isClosedStatus(milestone.status)) {
          return { action: "skip" };
        }
      }
      const validationFile = resolveMilestoneFile(basePath, mid, "VALIDATION");
      if (validationFile) {
        const validationContent = await loadFile(validationFile);
        if (validationContent) {
          const verdict = extractVerdict(validationContent);
          if (verdict === "needs-remediation" || verdict === "needs-attention") {
            return {
              action: "stop",
              reason: `Cannot complete milestone ${mid}: VALIDATION verdict is "${verdict}". Address the validation findings and re-run validation, or update the verdict manually.`,
              level: "warning"
            };
          }
        }
      }
      const missingSlices = findMissingSummaries(basePath, mid);
      if (missingSlices.length > 0) {
        return {
          action: "stop",
          reason: `Cannot complete milestone ${mid}: slices ${missingSlices.join(", ")} are missing SUMMARY files. Run /gsd doctor to diagnose.`,
          level: "error"
        };
      }
      const artifactCheck = hasImplementationArtifacts(basePath, mid);
      if (artifactCheck === "absent") {
        return {
          action: "stop",
          reason: `Cannot complete milestone ${mid}: no implementation files found outside .gsd/. The milestone has only plan files \u2014 actual code changes are required.`,
          level: "error"
        };
      }
      if (artifactCheck === "unknown") {
        logWarning("dispatch", `Implementation artifact check inconclusive for ${mid} \u2014 proceeding (git context unavailable)`);
      }
      try {
        if (isDbAvailable()) {
          const milestone = getMilestone(mid);
          if (milestone?.verification_operational && !isVerificationNotApplicable(milestone.verification_operational)) {
            const validationPath = resolveMilestoneFile(basePath, mid, "VALIDATION");
            if (validationPath) {
              const validationContent = await loadFile(validationPath);
              if (validationContent) {
                const skippedByMarker = /^skip_validation:\s*true$/im.test(validationContent);
                const skippedByPreference = /skip(?:ped)?[\s\-]+(?:by|per|due to)\s+(?:preference|budget|profile)/i.test(validationContent);
                const skippedByTrivialVariant = /trivial-scope pipeline variant/i.test(validationContent);
                const structuredMatch = validationContent.includes("Operational") && (validationContent.includes("MET") || validationContent.includes("N/A") || validationContent.includes("SATISFIED"));
                const proseMatch = /[Oo]perational[\s\S]{0,500}?(?:✅|pass|verified|confirmed|met|complete|true|yes|addressed|covered|satisfied|partially|n\/a|not[\s-]+applicable)/i.test(validationContent);
                const hasOperationalCheck = skippedByMarker || skippedByPreference || skippedByTrivialVariant || structuredMatch || proseMatch;
                if (!hasOperationalCheck) {
                  return {
                    action: "stop",
                    reason: `Milestone ${mid} has planned operational verification ("${milestone.verification_operational.substring(0, 100)}") but the validation output does not address it. Re-run validation with verification class awareness, or update the validation to document operational compliance.`,
                    level: "warning"
                  };
                }
              }
            }
          }
        }
      } catch (err) {
        logWarning("dispatch", `verification class check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return {
        action: "dispatch",
        unitType: "complete-milestone",
        unitId: mid,
        prompt: await buildCompleteMilestonePrompt(mid, midTitle, basePath)
      };
    }
  },
  {
    name: "complete \u2192 stop",
    match: async ({ state, mid, midTitle, basePath }) => {
      if (state.phase !== "complete") return null;
      if (mid && isDbAvailable()) {
        const milestone = getMilestone(mid);
        if (milestone && !isClosedStatus(milestone.status)) {
          return {
            action: "dispatch",
            unitType: "complete-milestone",
            unitId: mid,
            prompt: await buildCompleteMilestonePrompt(mid, midTitle, basePath)
          };
        }
      }
      return {
        action: "stop",
        reason: "All milestones complete.",
        level: "info"
      };
    }
  }
];
import { getRegistry } from "./rule-registry.js";
async function resolveDispatch(ctx) {
  const activeMid = ctx.state.activeMilestone?.id;
  if (activeMid && ctx.mid !== activeMid) {
    return {
      action: "stop",
      reason: `Dispatch milestone mismatch: context mid "${ctx.mid}" does not match active milestone "${activeMid}". This usually means a project-level deep setup pseudo-id leaked into milestone dispatch; rerun /gsd auto after setup state is reconciled.`,
      level: "warning"
    };
  }
  try {
    const registry = getRegistry();
    return annotateBackgroundable(await registry.evaluateDispatch(ctx));
  } catch (err) {
    logWarning("dispatch", `registry dispatch failed, falling back to inline rules: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const rule of DISPATCH_RULES) {
    const result = await rule.match(ctx);
    if (result) {
      if (result.action !== "skip") result.matchedRule = rule.name;
      return annotateBackgroundable(result);
    }
  }
  return {
    action: "stop",
    reason: `Unhandled phase "${ctx.state.phase}" \u2014 run /gsd doctor to diagnose.`,
    level: "warning",
    matchedRule: "<no-match>"
  };
}
function getDispatchRuleNames() {
  return DISPATCH_RULES.map((r) => r.name);
}
export {
  DISPATCH_RULES,
  getDeepStageGate,
  getDispatchRuleNames,
  getRewriteCount,
  getUatCount,
  hasPendingDeepStage,
  incrementUatCount,
  isVerificationNotApplicable,
  resolveDispatch,
  setReassessmentCheckerForTest,
  setResearchProjectPromptBuilderForTest,
  setRewriteCount,
  shouldRunDeepProjectSetup
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC9hdXRvLWRpc3BhdGNoLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQcm9qZWN0L0FwcDogR1NELTJcbi8vIEZpbGUgUHVycG9zZTogRGVjbGFyYXRpdmUgYXV0by1tb2RlIGRpc3BhdGNoIHJ1bGVzIGFuZCBkaXNwYXRjaCByZXNvbHZlci5cblxuLyoqXG4gKiBBdXRvLW1vZGUgRGlzcGF0Y2ggVGFibGUgXHUyMDE0IGRlY2xhcmF0aXZlIHBoYXNlIFx1MjE5MiB1bml0IG1hcHBpbmcuXG4gKlxuICogRWFjaCBydWxlIG1hcHMgYSBHU0Qgc3RhdGUgdG8gdGhlIHVuaXQgdHlwZSwgdW5pdCBJRCwgYW5kIHByb21wdCBidWlsZGVyXG4gKiB0aGF0IHNob3VsZCBiZSBkaXNwYXRjaGVkLiBSdWxlcyBhcmUgZXZhbHVhdGVkIGluIG9yZGVyOyB0aGUgZmlyc3QgbWF0Y2ggd2lucy5cbiAqXG4gKiBUaGlzIHJlcGxhY2VzIHRoZSAxMzAtbGluZSBpZi1lbHNlIGNoYWluIGluIGRpc3BhdGNoTmV4dFVuaXQgd2l0aCBhXG4gKiBkYXRhIHN0cnVjdHVyZSB0aGF0IGlzIGluc3BlY3RhYmxlLCB0ZXN0YWJsZSBwZXItcnVsZSwgYW5kIGV4dGVuc2libGVcbiAqIHdpdGhvdXQgbW9kaWZ5aW5nIG9yY2hlc3RyYXRpb24gY29kZS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEdTRFN0YXRlIH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgR1NEUHJlZmVyZW5jZXMgfSBmcm9tIFwiLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBVYXRUeXBlIH0gZnJvbSBcIi4vZmlsZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgTWluaW1hbE1vZGVsUmVnaXN0cnkgfSBmcm9tIFwiLi9jb250ZXh0LWJ1ZGdldC5qc1wiO1xuaW1wb3J0IHsgbG9hZEZpbGUsIGV4dHJhY3RVYXRUeXBlLCBsb2FkQWN0aXZlT3ZlcnJpZGVzIH0gZnJvbSBcIi4vZmlsZXMuanNcIjtcbmltcG9ydCB7IGlzRGJBdmFpbGFibGUsIGdldE1pbGVzdG9uZVNsaWNlcywgZ2V0UGVuZGluZ0dhdGVzLCBtYXJrQWxsR2F0ZXNPbWl0dGVkLCBnZXRNaWxlc3RvbmUsIGluc2VydEFzc2Vzc21lbnQsIHRyYW5zYWN0aW9uIH0gZnJvbSBcIi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyBpc0Nsb3NlZFN0YXR1cyB9IGZyb20gXCIuL3N0YXR1cy1ndWFyZHMuanNcIjtcbmltcG9ydCB7IGV4dHJhY3RWZXJkaWN0LCBpc0FjY2VwdGFibGVVYXRWZXJkaWN0IH0gZnJvbSBcIi4vdmVyZGljdC1wYXJzZXIuanNcIjtcblxuaW1wb3J0IHtcbiAgZ3NkUm9vdCxcbiAgcmVzb2x2ZU1pbGVzdG9uZUZpbGUsXG4gIHJlc29sdmVNaWxlc3RvbmVQYXRoLFxuICByZXNvbHZlU2xpY2VGaWxlLFxuICByZXNvbHZlU2xpY2VQYXRoLFxuICByZXNvbHZlVGFza0ZpbGUsXG4gIHJlbFNsaWNlRmlsZSxcbiAgYnVpbGRNaWxlc3RvbmVGaWxlTmFtZSxcbiAgYnVpbGRTbGljZUZpbGVOYW1lLFxufSBmcm9tIFwiLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgcGFyc2VSb2FkbWFwIH0gZnJvbSBcIi4vcGFyc2Vycy1sZWdhY3kuanNcIjtcbmltcG9ydCB7IHZhbGlkYXRlQXJ0aWZhY3QgfSBmcm9tIFwiLi9zY2hlbWFzL3ZhbGlkYXRlLmpzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRGaWxlU3luYywgd3JpdGVGaWxlU3luYywgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBsb2dXYXJuaW5nLCBsb2dFcnJvciB9IGZyb20gXCIuL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGhhc0ltcGxlbWVudGF0aW9uQXJ0aWZhY3RzIH0gZnJvbSBcIi4vYXV0by1yZWNvdmVyeS5qc1wiO1xuaW1wb3J0IHtcbiAgYnVpbGREaXNjdXNzTWlsZXN0b25lUHJvbXB0LFxuICBidWlsZERpc2N1c3NQcm9qZWN0UHJvbXB0LFxuICBidWlsZERpc2N1c3NSZXF1aXJlbWVudHNQcm9tcHQsXG4gIGJ1aWxkUmVzZWFyY2hEZWNpc2lvblByb21wdCxcbiAgYnVpbGRSZXNlYXJjaFByb2plY3RQcm9tcHQsXG4gIGJ1aWxkUmVzZWFyY2hNaWxlc3RvbmVQcm9tcHQsXG4gIGJ1aWxkUGxhbk1pbGVzdG9uZVByb21wdCxcbiAgYnVpbGRSZXNlYXJjaFNsaWNlUHJvbXB0LFxuICBidWlsZFBsYW5TbGljZVByb21wdCxcbiAgYnVpbGRSZWZpbmVTbGljZVByb21wdCxcbiAgYnVpbGRFeGVjdXRlVGFza1Byb21wdCxcbiAgYnVpbGRDb21wbGV0ZVNsaWNlUHJvbXB0LFxuICBidWlsZENvbXBsZXRlTWlsZXN0b25lUHJvbXB0LFxuICBidWlsZFZhbGlkYXRlTWlsZXN0b25lUHJvbXB0LFxuICBidWlsZFJlcGxhblNsaWNlUHJvbXB0LFxuICBidWlsZFJ1blVhdFByb21wdCxcbiAgYnVpbGRSZWFzc2Vzc1JvYWRtYXBQcm9tcHQsXG4gIGJ1aWxkUmV3cml0ZURvY3NQcm9tcHQsXG4gIGJ1aWxkUmVhY3RpdmVFeGVjdXRlUHJvbXB0LFxuICBidWlsZEdhdGVFdmFsdWF0ZVByb21wdCxcbiAgYnVpbGRQYXJhbGxlbFJlc2VhcmNoU2xpY2VzUHJvbXB0LFxuICBjaGVja05lZWRzUmVhc3Nlc3NtZW50LFxuICBjaGVja05lZWRzUnVuVWF0LFxufSBmcm9tIFwiLi9hdXRvLXByb21wdHMuanNcIjtcbmltcG9ydCB7IHJlc29sdmVNb2RlbFdpdGhGYWxsYmFja3NGb3JVbml0IH0gZnJvbSBcIi4vcHJlZmVyZW5jZXMtbW9kZWxzLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlVW9rRmxhZ3MgfSBmcm9tIFwiLi91b2svZmxhZ3MuanNcIjtcbmltcG9ydCB7IHNlbGVjdFJlYWN0aXZlRGlzcGF0Y2hCYXRjaCB9IGZyb20gXCIuL3Vvay9leGVjdXRpb24tZ3JhcGguanNcIjtcbmltcG9ydCB7IGdldE1pbGVzdG9uZVBpcGVsaW5lVmFyaWFudCB9IGZyb20gXCIuL21pbGVzdG9uZS1zY29wZS1jbGFzc2lmaWVyLmpzXCI7XG5pbXBvcnQgeyBFWEVDVVRJT05fRU5UUllfUEhBU0VTLCBoYXNGaW5hbGl6ZWRNaWxlc3RvbmVDb250ZXh0IH0gZnJvbSBcIi4vdW9rL3BsYW4tdjIuanNcIjtcbmltcG9ydCB7IGlzQXV0b0FjdGl2ZSB9IGZyb20gXCIuL2F1dG8uanNcIjtcbmltcG9ydCB7IG1hcmtEZXB0aFZlcmlmaWVkIH0gZnJvbSBcIi4vYm9vdHN0cmFwL3dyaXRlLWdhdGUuanNcIjtcbmltcG9ydCB7IGVuc3VyZVdvcmtmbG93UHJlZmVyZW5jZXNDYXB0dXJlZCB9IGZyb20gXCIuL3BsYW5uaW5nLWRlcHRoLmpzXCI7XG5pbXBvcnQgeyBNSUxFU1RPTkVfSURfUkUgfSBmcm9tIFwiLi9taWxlc3RvbmUtaWRzLmpzXCI7XG5pbXBvcnQge1xuICBQUk9KRUNUX1JFU0VBUkNIX0lORkxJR0hUX01BUktFUixcbn0gZnJvbSBcIi4vcHJvamVjdC1yZXNlYXJjaC1wb2xpY3kuanNcIjtcbmltcG9ydCB7XG4gIGlzV29ya2Zsb3dQcmVmc0NhcHR1cmVkLFxuICByZXNvbHZlRGVlcFByb2plY3RTZXR1cFN0YXRlLFxuICB0eXBlIERlZXBQcm9qZWN0U2V0dXBTdGFnZSxcbn0gZnJvbSBcIi4vZGVlcC1wcm9qZWN0LXNldHVwLXBvbGljeS5qc1wiO1xuaW1wb3J0IHsgYW5ub3RhdGVCYWNrZ3JvdW5kYWJsZSB9IGZyb20gXCIuL2RlbGVnYXRpb24tcG9saWN5LmpzXCI7XG5pbXBvcnQgeyBpbnZhbGlkYXRlQWxsQ2FjaGVzIH0gZnJvbSBcIi4vY2FjaGUuanNcIjtcbmltcG9ydCB7IGluc2VydE1pbGVzdG9uZVZhbGlkYXRpb25HYXRlcyB9IGZyb20gXCIuL21pbGVzdG9uZS12YWxpZGF0aW9uLWdhdGVzLmpzXCI7XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMCBUeXBlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IHR5cGUgRGlzcGF0Y2hBY3Rpb24gPVxuICB8IHtcbiAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiO1xuICAgICAgdW5pdFR5cGU6IHN0cmluZztcbiAgICAgIHVuaXRJZDogc3RyaW5nO1xuICAgICAgcHJvbXB0OiBzdHJpbmc7XG4gICAgICBwYXVzZUFmdGVyRGlzcGF0Y2g/OiBib29sZWFuO1xuICAgICAgLyoqIE5hbWUgb2YgdGhlIG1hdGNoZWQgZGlzcGF0Y2ggcnVsZSBmcm9tIHRoZSB1bmlmaWVkIHJlZ2lzdHJ5IChqb3VybmFsIHByb3ZlbmFuY2UpLiAqL1xuICAgICAgbWF0Y2hlZFJ1bGU/OiBzdHJpbmc7XG4gICAgICAvKipcbiAgICAgICAqIFRydWUgd2hlbiB0aGUgbWF0Y2hlZCB1bml0IHR5cGUgaGFzIGEgYGdvb2RgIHZlcmRpY3QgaW4gZGVsZWdhdGlvbi1wb2xpY3kudHMuXG4gICAgICAgKiBBbm5vdGF0ZWQgaW4gYHJlc29sdmVEaXNwYXRjaGAuIENvbnN1bWVycyBtYXkgdXNlIHRoaXMgdG8gZm9yayB0aGUgcHJvbXB0XG4gICAgICAgKiB0byBhIGJhY2tncm91bmQgc3ViLWFnZW50OyBkZWZhdWx0IGJlaGF2aW9yIGlzIHVuY2hhbmdlZCAoc3luY2hyb25vdXMpLlxuICAgICAgICovXG4gICAgICBiYWNrZ3JvdW5kYWJsZT86IGJvb2xlYW47XG4gICAgfVxuICB8IHsgYWN0aW9uOiBcInN0b3BcIjsgcmVhc29uOiBzdHJpbmc7IGxldmVsOiBcImluZm9cIiB8IFwid2FybmluZ1wiIHwgXCJlcnJvclwiOyBtYXRjaGVkUnVsZT86IHN0cmluZyB9XG4gIHwgeyBhY3Rpb246IFwic2tpcFwiOyBtYXRjaGVkUnVsZT86IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIERpc3BhdGNoQ29udGV4dCB7XG4gIGJhc2VQYXRoOiBzdHJpbmc7XG4gIG1pZDogc3RyaW5nO1xuICBtaWRUaXRsZTogc3RyaW5nO1xuICBzdGF0ZTogR1NEU3RhdGU7XG4gIHByZWZzOiBHU0RQcmVmZXJlbmNlcyB8IHVuZGVmaW5lZDtcbiAgc2Vzc2lvbj86IGltcG9ydChcIi4vYXV0by9zZXNzaW9uLmpzXCIpLkF1dG9TZXNzaW9uO1xuICBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlPzogXCJ0cnVlXCIgfCBcImZhbHNlXCI7XG4gIC8qKiBTZXNzaW9uIG1vZGVsIGNvbnRleHQgd2luZG93IGluIHRva2VucywgZm9yd2FyZGVkIHRvIHRoZSBidWRnZXQgZW5naW5lJ3MgcHJvbXB0IGJ1aWxkZXJzLiAqL1xuICBzZXNzaW9uQ29udGV4dFdpbmRvdz86IG51bWJlcjtcbiAgLyoqIE1vZGVsIHJlZ2lzdHJ5IGZvcndhcmRlZCB0byB0aGUgYnVkZ2V0IGVuZ2luZSBzbyBpdCBjYW4gbG9vayB1cCB0aGUgY29uZmlndXJlZCBleGVjdXRvciBtb2RlbC4gKi9cbiAgbW9kZWxSZWdpc3RyeT86IE1pbmltYWxNb2RlbFJlZ2lzdHJ5O1xuICAvKiogU2Vzc2lvbiBtb2RlbCBwcm92aWRlciwgdXNlZCBmb3IgcHJvdmlkZXItc3BlY2lmaWMgZWZmZWN0aXZlIGNvbnRleHQgd2luZG93cy4gKi9cbiAgc2Vzc2lvblByb3ZpZGVyPzogc3RyaW5nO1xufVxuXG50eXBlIFJlYXNzZXNzbWVudENoZWNrZXIgPSB0eXBlb2YgY2hlY2tOZWVkc1JlYXNzZXNzbWVudDtcbnR5cGUgUmVzZWFyY2hQcm9qZWN0UHJvbXB0QnVpbGRlciA9IHR5cGVvZiBidWlsZFJlc2VhcmNoUHJvamVjdFByb21wdDtcblxubGV0IHJlYXNzZXNzbWVudENoZWNrZXI6IFJlYXNzZXNzbWVudENoZWNrZXIgPSBjaGVja05lZWRzUmVhc3Nlc3NtZW50O1xubGV0IHJlc2VhcmNoUHJvamVjdFByb21wdEJ1aWxkZXI6IFJlc2VhcmNoUHJvamVjdFByb21wdEJ1aWxkZXIgPSBidWlsZFJlc2VhcmNoUHJvamVjdFByb21wdDtcblxuZnVuY3Rpb24gc2hvdWxkQnlwYXNzTWlsZXN0b25lRGVwdGhHYXRlSW5BdXRvKHByZWZzOiBHU0RQcmVmZXJlbmNlcyB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICByZXR1cm4gaXNBdXRvQWN0aXZlKCkgJiYgcHJlZnM/LnBsYW5uaW5nX2RlcHRoICE9PSBcImRlZXBcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFJlYXNzZXNzbWVudENoZWNrZXJGb3JUZXN0KGNoZWNrZXI6IFJlYXNzZXNzbWVudENoZWNrZXIpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgcHJldmlvdXMgPSByZWFzc2Vzc21lbnRDaGVja2VyO1xuICByZWFzc2Vzc21lbnRDaGVja2VyID0gY2hlY2tlcjtcbiAgcmV0dXJuICgpID0+IHtcbiAgICByZWFzc2Vzc21lbnRDaGVja2VyID0gcHJldmlvdXM7XG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRSZXNlYXJjaFByb2plY3RQcm9tcHRCdWlsZGVyRm9yVGVzdChidWlsZGVyOiBSZXNlYXJjaFByb2plY3RQcm9tcHRCdWlsZGVyKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHByZXZpb3VzID0gcmVzZWFyY2hQcm9qZWN0UHJvbXB0QnVpbGRlcjtcbiAgcmVzZWFyY2hQcm9qZWN0UHJvbXB0QnVpbGRlciA9IGJ1aWxkZXI7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgcmVzZWFyY2hQcm9qZWN0UHJvbXB0QnVpbGRlciA9IHByZXZpb3VzO1xuICB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERpc3BhdGNoUnVsZSB7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBuYW1lIGZvciBkZWJ1Z2dpbmcgYW5kIHRlc3QgaWRlbnRpZmljYXRpb24gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogUmV0dXJuIGEgRGlzcGF0Y2hBY3Rpb24gaWYgdGhpcyBydWxlIG1hdGNoZXMsIG51bGwgdG8gZmFsbCB0aHJvdWdoICovXG4gIG1hdGNoOiAoY3R4OiBEaXNwYXRjaENvbnRleHQpID0+IFByb21pc2U8RGlzcGF0Y2hBY3Rpb24gfCBudWxsPjtcbn1cblxuZXhwb3J0IHR5cGUgRGVlcFByb2plY3RTdGFnZSA9XG4gIERlZXBQcm9qZWN0U2V0dXBTdGFnZTtcblxuZXhwb3J0IHR5cGUgRGVlcFN0YWdlR2F0ZSA9XG4gIHwgeyBzdGF0dXM6IFwibm90LWFwcGxpY2FibGVcIjsgc3RhZ2U6IG51bGw7IHJlYXNvbjogc3RyaW5nIH1cbiAgfCB7IHN0YXR1czogXCJjb21wbGV0ZVwiOyBzdGFnZTogbnVsbDsgcmVhc29uOiBzdHJpbmcgfVxuICB8IHsgc3RhdHVzOiBcInBlbmRpbmdcIjsgc3RhZ2U6IERlZXBQcm9qZWN0U3RhZ2U7IHJlYXNvbjogc3RyaW5nIH1cbiAgfCB7IHN0YXR1czogXCJibG9ja2VkXCI7IHN0YWdlOiBEZWVwUHJvamVjdFN0YWdlOyByZWFzb246IHN0cmluZyB9O1xuXG5hc3luYyBmdW5jdGlvbiByZWFkVWF0R2F0ZVZlcmRpY3QoXG4gIGJhc2VQYXRoOiBzdHJpbmcsXG4gIG1pZDogc3RyaW5nLFxuICBzbGljZUlkOiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgdmVyZGljdDogc3RyaW5nOyB1YXRUeXBlOiBVYXRUeXBlIHwgdW5kZWZpbmVkIH0gfCBudWxsPiB7XG4gIGNvbnN0IHVhdEZpbGUgPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWQsIHNsaWNlSWQsIFwiVUFUXCIpO1xuICBjb25zdCBhc3Nlc3NtZW50RmlsZSA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pZCwgc2xpY2VJZCwgXCJBU1NFU1NNRU5UXCIpO1xuXG4gIGNvbnN0IHVhdENvbnRlbnQgPSB1YXRGaWxlID8gYXdhaXQgbG9hZEZpbGUodWF0RmlsZSkgOiBudWxsO1xuICBjb25zdCB1YXRUeXBlID0gdWF0Q29udGVudCA/IGV4dHJhY3RVYXRUeXBlKHVhdENvbnRlbnQpIDogdW5kZWZpbmVkO1xuXG4gIGNvbnN0IGFzc2Vzc21lbnRDb250ZW50ID0gYXNzZXNzbWVudEZpbGUgPyBhd2FpdCBsb2FkRmlsZShhc3Nlc3NtZW50RmlsZSkgOiBudWxsO1xuICBpZiAoYXNzZXNzbWVudENvbnRlbnQpIHtcbiAgICBjb25zdCBhc3Nlc3NtZW50VmVyZGljdCA9IGV4dHJhY3RWZXJkaWN0KGFzc2Vzc21lbnRDb250ZW50KTtcbiAgICBpZiAoYXNzZXNzbWVudFZlcmRpY3QpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHZlcmRpY3Q6IGFzc2Vzc21lbnRWZXJkaWN0LFxuICAgICAgICB1YXRUeXBlOiB1YXRUeXBlID8/IGV4dHJhY3RVYXRUeXBlKGFzc2Vzc21lbnRDb250ZW50KSxcbiAgICAgIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKHVhdENvbnRlbnQpIHtcbiAgICBjb25zdCBsZWdhY3lVYXRWZXJkaWN0ID0gZXh0cmFjdFZlcmRpY3QodWF0Q29udGVudCk7XG4gICAgaWYgKGxlZ2FjeVVhdFZlcmRpY3QpIHtcbiAgICAgIHJldHVybiB7IHZlcmRpY3Q6IGxlZ2FjeVVhdFZlcmRpY3QsIHVhdFR5cGUgfTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBEZWVwIHBsYW5uaW5nIG1vZGU6IGNoZWNrIHdoZXRoZXIgYW55IHByb2plY3QtbGV2ZWwgc3RhZ2UgZ2F0ZVxuICogKHdvcmtmbG93LXByZWZlcmVuY2VzLCBkaXNjdXNzLXByb2plY3QsIGRpc2N1c3MtcmVxdWlyZW1lbnRzLFxuICogcmVzZWFyY2gtZGVjaXNpb24sIHJlc2VhcmNoLXByb2plY3QpIHN0aWxsIGhhcyB3b3JrIHBlbmRpbmcuXG4gKlxuICogVXNlZCBieSB0aGUgbWlsZXN0b25lLWxldmVsIGRpc2N1c3MgcnVsZXMgdG8geWllbGQgdG8gcHJvamVjdC1sZXZlbFxuICogZGVlcC1tb2RlIHJ1bGVzIHdoZW4gdGhlIHByb2plY3QgaGFzbid0IGZpbmlzaGVkIGl0cyBzZXR1cCBpbnRlcnZpZXcuXG4gKiBSZXR1cm5zIGZhbHNlIGluIGxpZ2h0IG1vZGUgKG9yIHdoZW4gcHJlZnMgYWJzZW50KSBzbyB0aGUgbWlsZXN0b25lXG4gKiBydWxlcyBiZWhhdmUgZXhhY3RseSBhcyBiZWZvcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXREZWVwU3RhZ2VHYXRlKHByZWZzOiBHU0RQcmVmZXJlbmNlcyB8IHVuZGVmaW5lZCwgYmFzZVBhdGg6IHN0cmluZyk6IERlZXBTdGFnZUdhdGUge1xuICByZXR1cm4gcmVzb2x2ZURlZXBQcm9qZWN0U2V0dXBTdGF0ZShwcmVmcywgYmFzZVBhdGgpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaGFzUGVuZGluZ0RlZXBTdGFnZShwcmVmczogR1NEUHJlZmVyZW5jZXMgfCB1bmRlZmluZWQsIGJhc2VQYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgZ2F0ZSA9IGdldERlZXBTdGFnZUdhdGUocHJlZnMsIGJhc2VQYXRoKTtcbiAgcmV0dXJuIGdhdGUuc3RhdHVzID09PSBcInBlbmRpbmdcIiB8fCBnYXRlLnN0YXR1cyA9PT0gXCJibG9ja2VkXCI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRSdW5EZWVwUHJvamVjdFNldHVwKFxuICBzdGF0ZTogUGljazxHU0RTdGF0ZSwgXCJwaGFzZVwiPixcbiAgcHJlZnM6IEdTRFByZWZlcmVuY2VzIHwgdW5kZWZpbmVkLFxuICBiYXNlUGF0aDogc3RyaW5nLFxuICBvcHRpb25zOiB7IGhhc1N1cnZpdm9yQnJhbmNoPzogYm9vbGVhbiB9ID0ge30sXG4pOiBib29sZWFuIHtcbiAgaWYgKG9wdGlvbnMuaGFzU3Vydml2b3JCcmFuY2ggPT09IHRydWUpIHJldHVybiBmYWxzZTtcbiAgaWYgKFxuICAgIHN0YXRlLnBoYXNlICE9PSBcInByZS1wbGFubmluZ1wiICYmXG4gICAgc3RhdGUucGhhc2UgIT09IFwibmVlZHMtZGlzY3Vzc2lvblwiICYmXG4gICAgc3RhdGUucGhhc2UgIT09IFwicGxhbm5pbmdcIlxuICApIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIGhhc1BlbmRpbmdEZWVwU3RhZ2UocHJlZnMsIGJhc2VQYXRoKTtcbn1cblxuZnVuY3Rpb24gbWlzc2luZ1NsaWNlU3RvcChtaWQ6IHN0cmluZywgcGhhc2U6IHN0cmluZyk6IERpc3BhdGNoQWN0aW9uIHtcbiAgcmV0dXJuIHtcbiAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgIHJlYXNvbjogYCR7bWlkfTogcGhhc2UgXCIke3BoYXNlfVwiIGhhcyBubyBhY3RpdmUgc2xpY2UgXHUyMDE0IHJ1biAvZ3NkIGRvY3Rvci5gLFxuICAgIGxldmVsOiBcImVycm9yXCIsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGlzUmVnaXN0cnlNaWxlc3RvbmVDb21wbGV0ZShzdGF0ZTogR1NEU3RhdGUsIG1pZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBzdGF0ZS5yZWdpc3RyeS5zb21lKChtaWxlc3RvbmUpID0+XG4gICAgbWlsZXN0b25lLmlkID09PSBtaWQgJiYgbWlsZXN0b25lLnN0YXR1cyA9PT0gXCJjb21wbGV0ZVwiXG4gICk7XG59XG5cbi8qKlxuICogQ2hlY2sgZm9yIG1pbGVzdG9uZSBzbGljZXMgbWlzc2luZyBTVU1NQVJZIGZpbGVzLlxuICogUmV0dXJucyBhcnJheSBvZiBtaXNzaW5nIHNsaWNlIElEcywgb3IgZW1wdHkgYXJyYXkgaWYgYWxsIHByZXNlbnQgb3IgREIgdW5hdmFpbGFibGUuXG4gKlxuICogRXhjbHVkZXMgc2tpcHBlZCBzbGljZXMgKGludGVudGlvbmFsbHkgc3VtbWFyeS1sZXNzKSBhbmQgbGVnYWN5LWNvbXBsZXRlXG4gKiBzbGljZXMgd2hvc2UgREIgc3RhdHVzIGlzIGF1dGhvcml0YXRpdmUgZXZlbiB3aXRob3V0IG9uLWRpc2sgU1VNTUFSWSAoIzM2MjApLlxuICovXG5mdW5jdGlvbiBmaW5kTWlzc2luZ1N1bW1hcmllcyhiYXNlUGF0aDogc3RyaW5nLCBtaWQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgaWYgKCFpc0RiQXZhaWxhYmxlKCkpIHJldHVybiBbXTtcbiAgY29uc3Qgc2xpY2VzID0gZ2V0TWlsZXN0b25lU2xpY2VzKG1pZCk7XG4gIC8vIFNraXBwZWQgc2xpY2VzIG5ldmVyIHByb2R1Y2UgU1VNTUFSWXM7IGxlZ2FjeS1jb21wbGV0ZSBzbGljZXMgbWF5IGxhY2sgdGhlbVxuICBjb25zdCBDTE9TRURfU1RBVFVTRVMgPSBuZXcgU2V0KFtcInNraXBwZWRcIiwgXCJjb21wbGV0ZVwiLCBcImRvbmVcIl0pO1xuICByZXR1cm4gc2xpY2VzXG4gICAgLmZpbHRlcihzID0+ICFDTE9TRURfU1RBVFVTRVMuaGFzKHMuc3RhdHVzKSlcbiAgICAuZmlsdGVyKHMgPT4ge1xuICAgICAgY29uc3Qgc3VtbWFyeVBhdGggPSByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWQsIHMuaWQsIFwiU1VNTUFSWVwiKTtcbiAgICAgIHJldHVybiAhc3VtbWFyeVBhdGggfHwgIWV4aXN0c1N5bmMoc3VtbWFyeVBhdGgpO1xuICAgIH0pXG4gICAgLm1hcChzID0+IHMuaWQpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgUmV3cml0ZSBDaXJjdWl0IEJyZWFrZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmNvbnN0IE1BWF9SRVdSSVRFX0FUVEVNUFRTID0gMztcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIERpc2stcGVyc2lzdGVkIHJld3JpdGUgYXR0ZW1wdCBjb3VudGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gVGhlIGNvdW50ZXIgbXVzdCBzdXJ2aXZlIHNlc3Npb24gcmVzdGFydHMgKGNyYXNoIHJlY292ZXJ5LCBwYXVzZS9yZXN1bWUsXG4vLyBzdGVwLW1vZGUpLiBTdG9yaW5nIGl0IG9uIHRoZSBpbi1tZW1vcnkgc2Vzc2lvbiBvYmplY3QgY2F1c2VkIHRoZSBjaXJjdWl0XG4vLyBicmVha2VyIHRvIG5ldmVyIHRyaXAgXHUyMDE0IHNlZSBodHRwczovL2dpdGh1Yi5jb20vZ3NkLWJ1aWxkL2dzZC0yL2lzc3Vlcy8yMjAzXG5mdW5jdGlvbiByZXdyaXRlQ291bnRQYXRoKGJhc2VQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJydW50aW1lXCIsIFwicmV3cml0ZS1jb3VudC5qc29uXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0UmV3cml0ZUNvdW50KGJhc2VQYXRoOiBzdHJpbmcpOiBudW1iZXIge1xuICB0cnkge1xuICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhyZXdyaXRlQ291bnRQYXRoKGJhc2VQYXRoKSwgXCJ1dGYtOFwiKSk7XG4gICAgcmV0dXJuIHR5cGVvZiBkYXRhLmNvdW50ID09PSBcIm51bWJlclwiID8gZGF0YS5jb3VudCA6IDA7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiAwO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRSZXdyaXRlQ291bnQoYmFzZVBhdGg6IHN0cmluZywgY291bnQ6IG51bWJlcik6IHZvaWQge1xuICBjb25zdCBmaWxlUGF0aCA9IHJld3JpdGVDb3VudFBhdGgoYmFzZVBhdGgpO1xuICBta2RpclN5bmMoam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgSlNPTi5zdHJpbmdpZnkoeyBjb3VudCwgdXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSkgKyBcIlxcblwiKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJ1bi1VQVQgZGlzcGF0Y2ggY291bnRlciAocGVyLXNsaWNlKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIENhcHMgcnVuLXVhdCBkaXNwYXRjaGVzIHRvIHByZXZlbnQgaW5maW5pdGUgcmVwbGF5IHdoZW4gdmVyaWZpY2F0aW9uXG4vLyBjb21tYW5kcyBmYWlsIGJlZm9yZSB3cml0aW5nIGEgdmVyZGljdCAoIzM2MjQpLlxuY29uc3QgTUFYX1VBVF9BVFRFTVBUUyA9IDM7XG5cbmZ1bmN0aW9uIHVhdENvdW50UGF0aChiYXNlUGF0aDogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJydW50aW1lXCIsIGB1YXQtY291bnQtJHttaWR9LSR7c2lkfS5qc29uYCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRVYXRDb3VudChiYXNlUGF0aDogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcpOiBudW1iZXIge1xuICB0cnkge1xuICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyh1YXRDb3VudFBhdGgoYmFzZVBhdGgsIG1pZCwgc2lkKSwgXCJ1dGYtOFwiKSk7XG4gICAgcmV0dXJuIHR5cGVvZiBkYXRhLmNvdW50ID09PSBcIm51bWJlclwiID8gZGF0YS5jb3VudCA6IDA7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiAwO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbmNyZW1lbnRVYXRDb3VudChiYXNlUGF0aDogc3RyaW5nLCBtaWQ6IHN0cmluZywgc2lkOiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCBjb3VudCA9IGdldFVhdENvdW50KGJhc2VQYXRoLCBtaWQsIHNpZCkgKyAxO1xuICBjb25zdCBmaWxlUGF0aCA9IHVhdENvdW50UGF0aChiYXNlUGF0aCwgbWlkLCBzaWQpO1xuICBta2RpclN5bmMoam9pbihnc2RSb290KGJhc2VQYXRoKSwgXCJydW50aW1lXCIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgSlNPTi5zdHJpbmdpZnkoeyBjb3VudCwgdXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkgfSkgKyBcIlxcblwiKTtcbiAgcmV0dXJuIGNvdW50O1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDAgSGVscGVycyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuLyoqXG4gKiBSZXR1cm5zIHRydWUgd2hlbiB0aGUgdmVyaWZpY2F0aW9uX29wZXJhdGlvbmFsIHZhbHVlIGluZGljYXRlcyB0aGF0IG5vXG4gKiBvcGVyYXRpb25hbCB2ZXJpZmljYXRpb24gaXMgbmVlZGVkLiAgQ292ZXJzIGNvbW1vbiBwaHJhc2luZ3MgdGhlIHBsYW5uaW5nXG4gKiBhZ2VudCBtYXkgdXNlOiBcIk5vbmVcIiwgXCJOb25lIHJlcXVpcmVkXCIsIFwiTi9BXCIsIFwiTm90IGFwcGxpY2FibGVcIiwgZXRjLlxuICpcbiAqIEBzZWUgaHR0cHM6Ly9naXRodWIuY29tL2dzZC1idWlsZC9nc2QtMi9pc3N1ZXMvMjkzMVxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNWZXJpZmljYXRpb25Ob3RBcHBsaWNhYmxlKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgdiA9ICh2YWx1ZSA/PyBcIlwiKS50b0xvd2VyQ2FzZSgpLnRyaW0oKS5yZXBsYWNlKC9bLlxcc10rJC8sIFwiXCIpO1xuICBpZiAoIXYgfHwgdiA9PT0gXCJub25lXCIpIHJldHVybiB0cnVlO1xuICByZXR1cm4gL14oPzpub25lKD86W1xccy5fXFx1MjAxNC1dK1tcXHNcXFNdKik/fG5cXC8/YXxub3RbXFxzLl8tXSsoPzphcHBsaWNhYmxlfHJlcXVpcmVkfG5lZWRlZHxwcm92aWRlZCl8bm9bXFxzLl8tXStvcGVyYXRpb25hbFtcXHNcXFNdKikkL2kudGVzdCh2KTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJ1bGVzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgY29uc3QgRElTUEFUQ0hfUlVMRVM6IERpc3BhdGNoUnVsZVtdID0gW1xuICB7XG4gICAgLy8gQURSLTAxMSBQaGFzZSAyOiBwYXVzZS1mb3ItZXNjYWxhdGlvbiBtdXN0IGV2YWx1YXRlIEZJUlNUIHNvIHBoYXNlLVxuICAgIC8vIGFnbm9zdGljIHJ1bGVzIChyZXdyaXRlLWRvY3MgZ2F0ZSwgVUFUIGNoZWNrcywgcmVhc3Nlc3MpIGNhbm5vdCBieXBhc3NcbiAgICAvLyB0aGUgdXNlcidzIHBlbmRpbmcgZGVjaXNpb24uIE9ubHkgZmlyZXMgZm9yIGNvbnRpbnVlV2l0aERlZmF1bHQ9ZmFsc2VcbiAgICAvLyBlc2NhbGF0aW9ucyAodGhvc2Ugc2V0IGVzY2FsYXRpb25fcGVuZGluZz0xKTsgYXdhaXRpbmctcmV2aWV3IGFydGlmYWN0c1xuICAgIC8vIG5ldmVyIGVudGVyIHRoZSAnZXNjYWxhdGluZy10YXNrJyBwaGFzZS5cbiAgICBuYW1lOiBcImVzY2FsYXRpbmctdGFzayBcdTIxOTIgcGF1c2UtZm9yLWVzY2FsYXRpb25cIixcbiAgICBtYXRjaDogYXN5bmMgKHsgc3RhdGUsIG1pZCB9KSA9PiB7XG4gICAgICBpZiAoc3RhdGUucGhhc2UgIT09IFwiZXNjYWxhdGluZy10YXNrXCIpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFzdGF0ZS5hY3RpdmVTbGljZSkgcmV0dXJuIG1pc3NpbmdTbGljZVN0b3AobWlkLCBzdGF0ZS5waGFzZSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgICByZWFzb246XG4gICAgICAgICAgc3RhdGUubmV4dEFjdGlvbiB8fFxuICAgICAgICAgIGAke21pZH06IHRhc2sgZXNjYWxhdGlvbiBhd2FpdHMgdXNlciByZXNvbHV0aW9uLiBSdW4gL2dzZCBlc2NhbGF0ZSBsaXN0IHRvIHNlZSBwZW5kaW5nIGl0ZW1zLmAsXG4gICAgICAgIGxldmVsOiBcImluZm9cIixcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmV3cml0ZS1kb2NzIChvdmVycmlkZSBnYXRlKVwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBtaWQsIG1pZFRpdGxlLCBzdGF0ZSwgYmFzZVBhdGgsIHNlc3Npb24gfSkgPT4ge1xuICAgICAgY29uc3QgcGVuZGluZ092ZXJyaWRlcyA9IGF3YWl0IGxvYWRBY3RpdmVPdmVycmlkZXMoYmFzZVBhdGgpO1xuICAgICAgaWYgKHBlbmRpbmdPdmVycmlkZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IGNvdW50ID0gZ2V0UmV3cml0ZUNvdW50KGJhc2VQYXRoKTtcbiAgICAgIGlmIChjb3VudCA+PSBNQVhfUkVXUklURV9BVFRFTVBUUykge1xuICAgICAgICBjb25zdCB7IHJlc29sdmVBbGxPdmVycmlkZXMgfSA9IGF3YWl0IGltcG9ydChcIi4vZmlsZXMuanNcIik7XG4gICAgICAgIGF3YWl0IHJlc29sdmVBbGxPdmVycmlkZXMoYmFzZVBhdGgpO1xuICAgICAgICBzZXRSZXdyaXRlQ291bnQoYmFzZVBhdGgsIDApO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICAgIHNldFJld3JpdGVDb3VudChiYXNlUGF0aCwgY291bnQgKyAxKTtcbiAgICAgIGNvbnN0IHVuaXRJZCA9IHN0YXRlLmFjdGl2ZVNsaWNlID8gYCR7bWlkfS8ke3N0YXRlLmFjdGl2ZVNsaWNlLmlkfWAgOiBtaWQ7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgdW5pdFR5cGU6IFwicmV3cml0ZS1kb2NzXCIsXG4gICAgICAgIHVuaXRJZCxcbiAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZFJld3JpdGVEb2NzUHJvbXB0KFxuICAgICAgICAgIG1pZCxcbiAgICAgICAgICBtaWRUaXRsZSxcbiAgICAgICAgICBzdGF0ZS5hY3RpdmVTbGljZSxcbiAgICAgICAgICBiYXNlUGF0aCxcbiAgICAgICAgICBwZW5kaW5nT3ZlcnJpZGVzLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgLy8gIzQ2NzEgXHUyMDE0IFJlY292ZXJ5IHBhdGggZm9yIGV4ZWN1dGlvbi1lbnRyeSBwaGFzZXMgd2l0aCBtaXNzaW5nIENPTlRFWFQubWQuXG4gICAgLy9cbiAgICAvLyBPbmNlIGBkZXJpdmVTdGF0ZUZyb21EYmAgcmV0dXJucyBhbiBleGVjdXRpb24tZW50cnkgcGhhc2UgKGV4ZWN1dGluZyAvXG4gICAgLy8gc3VtbWFyaXppbmcgLyB2YWxpZGF0aW5nLW1pbGVzdG9uZSAvIGNvbXBsZXRpbmctbWlsZXN0b25lKSwgdGhlXG4gICAgLy8gcHJlLXBsYW5uaW5nIGd1YXJkIGF0IGBwcmUtcGxhbm5pbmcgKG5vIGNvbnRleHQpIFx1MjE5MiBkaXNjdXNzLW1pbGVzdG9uZWBcbiAgICAvLyBubyBsb25nZXIgZmlyZXMuIFRoZSBwbGFuLXYyIGdhdGUgY29ycmVjdGx5IGRldGVjdHMgdGhlIG1pc3NpbmcgY29udGV4dFxuICAgIC8vIGJ1dCBjYW4gb25seSBibG9jayBcdTIwMTQgaXQgY2Fubm90IHJlZGlzcGF0Y2guIFdpdGhvdXQgdGhpcyBydWxlIHRoZVxuICAgIC8vIG1pbGVzdG9uZSBpcyBzdHVjayB1bnRpbCBgL2dzZCBkb2N0b3IgaGVhbGAgcmVwYWlycyBpdCAoYW5kIGhlYWxcbiAgICAvLyBoaXN0b3JpY2FsbHkgbWlzc2VkIHRoaXMgY2hlY2sgdG9vKS5cbiAgICAvL1xuICAgIC8vIEZpcmUgQkVGT1JFIHRoZSBleGVjdXRpb24tZW50cnkgcGhhc2UgcnVsZXMgc28gd2UgcmVkaXNwYXRjaCB0b1xuICAgIC8vIGBkaXNjdXNzLW1pbGVzdG9uZWAgaW5zdGVhZCBvZiBoaXR0aW5nIHRoZSBwbGFuLXYyIGdhdGUuXG4gICAgbmFtZTogXCJleGVjdXRpb24tZW50cnkgcGhhc2UgKG5vIGNvbnRleHQpIFx1MjE5MiBkaXNjdXNzLW1pbGVzdG9uZVwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgbWlkLCBtaWRUaXRsZSwgYmFzZVBhdGgsIHByZWZzLCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlIH0pID0+IHtcbiAgICAgIGlmICghRVhFQ1VUSU9OX0VOVFJZX1BIQVNFUy5oYXMoc3RhdGUucGhhc2UpKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghTUlMRVNUT05FX0lEX1JFLnRlc3QobWlkKSkgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoaXNSZWdpc3RyeU1pbGVzdG9uZUNvbXBsZXRlKHN0YXRlLCBtaWQpKSByZXR1cm4gbnVsbDtcbiAgICAgIC8vIEFsaWduIHdpdGggdGhlIHBsYW4tdjIgZ2F0ZSdzIGxvb2t1cCBzZW1hbnRpY3M6IHdoaXRlc3BhY2Utb25seSBjb3VudHNcbiAgICAgIC8vIGFzIG1pc3NpbmcsIGFuZCBhbiBhdXRvIHdvcmt0cmVlIG1heSBmYWxsIGJhY2sgdG8gR1NEX1BST0pFQ1RfUk9PVC5cbiAgICAgIGlmIChoYXNGaW5hbGl6ZWRNaWxlc3RvbmVDb250ZXh0KGJhc2VQYXRoLCBtaWQpKSByZXR1cm4gbnVsbDtcbiAgICAgIC8vIEg2IGZpeCAoIzQ5NzMpOiBub24tZGVlcCBhdXRvLW1vZGUgaGFzIG5vIGh1bWFuIHRvIGFuc3dlciB0aGVcbiAgICAgIC8vIGRlcHRoLXZlcmlmaWNhdGlvbiBxdWVzdGlvbiwgc28gcHJlLW1hcmtpbmcgYXZvaWRzIGEgd3JpdGUtZ2F0ZVxuICAgICAgLy8gZGVhZGxvY2suIERlZXAgcGxhbm5pbmcgaXMgc3RpbGwgdXNlci1kcml2ZW4gZXZlbiBpbnNpZGUgYXV0by1tb2RlLFxuICAgICAgLy8gc28gaXQgbXVzdCB3YWl0IGZvciBleHBsaWNpdCBhcHByb3ZhbCBpbnN0ZWFkIG9mIHRha2luZyB0aGlzIGJ5cGFzcy5cbiAgICAgIGlmIChzaG91bGRCeXBhc3NNaWxlc3RvbmVEZXB0aEdhdGVJbkF1dG8ocHJlZnMpKSB7XG4gICAgICAgIG1hcmtEZXB0aFZlcmlmaWVkKG1pZCwgYmFzZVBhdGgpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIsXG4gICAgICAgIHVuaXRUeXBlOiBcImRpc2N1c3MtbWlsZXN0b25lXCIsXG4gICAgICAgIHVuaXRJZDogbWlkLFxuICAgICAgICBwcm9tcHQ6IGF3YWl0IGJ1aWxkRGlzY3Vzc01pbGVzdG9uZVByb21wdChcbiAgICAgICAgICBtaWQsXG4gICAgICAgICAgbWlkVGl0bGUsXG4gICAgICAgICAgYmFzZVBhdGgsXG4gICAgICAgICAgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3VtbWFyaXppbmcgXHUyMTkyIGNvbXBsZXRlLXNsaWNlXCIsXG4gICAgbWF0Y2g6IGFzeW5jICh7IHN0YXRlLCBtaWQsIG1pZFRpdGxlLCBiYXNlUGF0aCB9KSA9PiB7XG4gICAgICBpZiAoc3RhdGUucGhhc2UgIT09IFwic3VtbWFyaXppbmdcIikgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoIXN0YXRlLmFjdGl2ZVNsaWNlKSByZXR1cm4gbWlzc2luZ1NsaWNlU3RvcChtaWQsIHN0YXRlLnBoYXNlKTtcbiAgICAgIGNvbnN0IHNpZCA9IHN0YXRlLmFjdGl2ZVNsaWNlIS5pZDtcbiAgICAgIGNvbnN0IHNUaXRsZSA9IHN0YXRlLmFjdGl2ZVNsaWNlIS50aXRsZTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiLFxuICAgICAgICB1bml0VHlwZTogXCJjb21wbGV0ZS1zbGljZVwiLFxuICAgICAgICB1bml0SWQ6IGAke21pZH0vJHtzaWR9YCxcbiAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZENvbXBsZXRlU2xpY2VQcm9tcHQoXG4gICAgICAgICAgbWlkLFxuICAgICAgICAgIG1pZFRpdGxlLFxuICAgICAgICAgIHNpZCxcbiAgICAgICAgICBzVGl0bGUsXG4gICAgICAgICAgYmFzZVBhdGgsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJ1bi11YXQgKHBvc3QtY29tcGxldGlvbilcIixcbiAgICBtYXRjaDogYXN5bmMgKHsgc3RhdGUsIG1pZCwgYmFzZVBhdGgsIHByZWZzIH0pID0+IHtcbiAgICAgIGNvbnN0IG5lZWRzUnVuVWF0ID0gYXdhaXQgY2hlY2tOZWVkc1J1blVhdChiYXNlUGF0aCwgbWlkLCBzdGF0ZSwgcHJlZnMpO1xuICAgICAgaWYgKCFuZWVkc1J1blVhdCkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCB7IHNsaWNlSWQsIHVhdFR5cGUgfSA9IG5lZWRzUnVuVWF0O1xuXG4gICAgICAvLyBDYXAgcnVuLXVhdCBkaXNwYXRjaCBhdHRlbXB0cyB0byBwcmV2ZW50IGluZmluaXRlIHJlcGxheSAoIzM2MjQpXG4gICAgICBjb25zdCBhdHRlbXB0cyA9IGluY3JlbWVudFVhdENvdW50KGJhc2VQYXRoLCBtaWQsIHNsaWNlSWQpO1xuICAgICAgaWYgKGF0dGVtcHRzID4gTUFYX1VBVF9BVFRFTVBUUykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGFjdGlvbjogXCJzdG9wXCIgYXMgY29uc3QsXG4gICAgICAgICAgcmVhc29uOiBgcnVuLXVhdCBmb3IgJHttaWR9LyR7c2xpY2VJZH0gaGFzIGJlZW4gZGlzcGF0Y2hlZCAke2F0dGVtcHRzIC0gMX0gdGltZXMgd2l0aG91dCBwcm9kdWNpbmcgYSB2ZXJkaWN0LiBWZXJpZmljYXRpb24gY29tbWFuZHMgbWF5IGJlIGJyb2tlbiBcdTIwMTQgZml4IHRoZSBVQVQgc3BlYyBvciBtYW51YWxseSB3cml0ZSBhbiBBU1NFU1NNRU5UIHZlcmRpY3QuYCxcbiAgICAgICAgICBsZXZlbDogXCJ3YXJuaW5nXCIgYXMgY29uc3QsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBjb25zdCB1YXRGaWxlID0gcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgbWlkLCBzbGljZUlkLCBcIlVBVFwiKSE7XG4gICAgICBjb25zdCB1YXRDb250ZW50ID0gYXdhaXQgbG9hZEZpbGUodWF0RmlsZSk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgdW5pdFR5cGU6IFwicnVuLXVhdFwiLFxuICAgICAgICB1bml0SWQ6IGAke21pZH0vJHtzbGljZUlkfWAsXG4gICAgICAgIHByb21wdDogYXdhaXQgYnVpbGRSdW5VYXRQcm9tcHQoXG4gICAgICAgICAgbWlkLFxuICAgICAgICAgIHNsaWNlSWQsXG4gICAgICAgICAgcmVsU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWQsIHNsaWNlSWQsIFwiVUFUXCIpLFxuICAgICAgICAgIHVhdENvbnRlbnQgPz8gXCJcIixcbiAgICAgICAgICBiYXNlUGF0aCxcbiAgICAgICAgKSxcbiAgICAgICAgcGF1c2VBZnRlckRpc3BhdGNoOiAhcHJvY2Vzcy5lbnYuR1NEX0hFQURMRVNTICYmIHVhdFR5cGUgIT09IFwiYXJ0aWZhY3QtZHJpdmVuXCIgJiYgdWF0VHlwZSAhPT0gXCJicm93c2VyLWV4ZWN1dGFibGVcIiAmJiB1YXRUeXBlICE9PSBcInJ1bnRpbWUtZXhlY3V0YWJsZVwiLFxuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1YXQtdmVyZGljdC1nYXRlIChub24tUEFTUyBibG9ja3MgcHJvZ3Jlc3Npb24pXCIsXG4gICAgbWF0Y2g6IGFzeW5jICh7IG1pZCwgYmFzZVBhdGgsIHByZWZzIH0pID0+IHtcbiAgICAgIC8vIE9ubHkgYXBwbGllcyB3aGVuIFVBVCBkaXNwYXRjaCBpcyBlbmFibGVkXG4gICAgICBpZiAoIXByZWZzPy51YXRfZGlzcGF0Y2gpIHJldHVybiBudWxsO1xuXG4gICAgICAvLyBEQi1maXJzdDogcHJlZmVyIGNsb3NlZCBzbGljZXMgZnJvbSBEQjsgZmFsbCBiYWNrIHRvIFJPQURNQVAgb24gZGlzay5cbiAgICAgIGxldCBjbG9zZWRTbGljZUlkczogc3RyaW5nW107XG4gICAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgIGNsb3NlZFNsaWNlSWRzID0gZ2V0TWlsZXN0b25lU2xpY2VzKG1pZClcbiAgICAgICAgICAuZmlsdGVyKHMgPT4gaXNDbG9zZWRTdGF0dXMocy5zdGF0dXMpKVxuICAgICAgICAgIC5tYXAocyA9PiBzLmlkKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEZpbGVzeXN0ZW0gZmFsbGJhY2sgZm9yIGRlZ3JhZGVkIC8gdW5taWdyYXRlZCBwcm9qZWN0cy5cbiAgICAgICAgLy8gYHNsaWNlLmRvbmVgIGluIHRoZSBwYXJzZWQgUk9BRE1BUCBpcyB0aGUgZGlzay1sZXZlbCBjbG9zZWQgc2lnbmFsLlxuICAgICAgICBjb25zdCByb2FkbWFwRmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiUk9BRE1BUFwiKTtcbiAgICAgICAgY29uc3Qgcm9hZG1hcENvbnRlbnQgPSByb2FkbWFwRmlsZSA/IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBGaWxlKSA6IG51bGw7XG4gICAgICAgIGlmICghcm9hZG1hcENvbnRlbnQpIHJldHVybiBudWxsO1xuICAgICAgICBjb25zdCByb2FkbWFwID0gcGFyc2VSb2FkbWFwKHJvYWRtYXBDb250ZW50KTtcbiAgICAgICAgY2xvc2VkU2xpY2VJZHMgPSByb2FkbWFwLnNsaWNlcy5maWx0ZXIocyA9PiBzLmRvbmUpLm1hcChzID0+IHMuaWQpO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGNvbnN0IHNsaWNlSWQgb2YgY2xvc2VkU2xpY2VJZHMpIHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVhZFVhdEdhdGVWZXJkaWN0KGJhc2VQYXRoLCBtaWQsIHNsaWNlSWQpO1xuICAgICAgICBpZiAoIXJlc3VsdCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHsgdmVyZGljdCwgdWF0VHlwZSB9ID0gcmVzdWx0O1xuXG4gICAgICAgIGlmICghaXNBY2NlcHRhYmxlVWF0VmVyZGljdCh2ZXJkaWN0LCB1YXRUeXBlKSkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBhY3Rpb246IFwic3RvcFwiIGFzIGNvbnN0LFxuICAgICAgICAgICAgcmVhc29uOiBgVUFUIHZlcmRpY3QgZm9yICR7c2xpY2VJZH0gaXMgXCIke3ZlcmRpY3R9XCIgXHUyMDE0IGJsb2NraW5nIHByb2dyZXNzaW9uIHVudGlsIHJlc29sdmVkLlxcblJldmlldyB0aGUgVUFUIHJlc3VsdCBhbmQgdXBkYXRlIHRoZSB2ZXJkaWN0IHRvIFBBU1MsIG9yIHJlLXJ1biAvZ3NkIGF1dG8gYWZ0ZXIgZml4aW5nLmAsXG4gICAgICAgICAgICBsZXZlbDogXCJ3YXJuaW5nXCIgYXMgY29uc3QsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVhc3Nlc3Mtcm9hZG1hcCAocG9zdC1jb21wbGV0aW9uKVwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgbWlkLCBtaWRUaXRsZSwgYmFzZVBhdGgsIHByZWZzIH0pID0+IHtcbiAgICAgIGlmIChwcmVmcz8ucGhhc2VzPy5za2lwX3JlYXNzZXNzKSByZXR1cm4gbnVsbDtcbiAgICAgIC8vIERlZmF1bHQgcmVhc3Nlc3NfYWZ0ZXJfc2xpY2UgdG8gZmFsc2UgcGVyIEFEUi0wMDMgXHUwMEE3NCBcdTIwMTQgbW9zdCByZWFzc2Vzc1xuICAgICAgLy8gdW5pdHMgY29uY2x1ZGUgXCJyb2FkbWFwIGlzIGZpbmVcIiBhbmQgYnVybiBhIHNlc3Npb24gZm9yIG5vIGNoYW5nZS5cbiAgICAgIC8vIFRoZSBwbGFuLXNsaWNlIHByb21wdCBub3cgY2FycmllcyBhIHJlYXNzZXNzbWVudCBwcmVhbWJsZSBzbyB0aGVcbiAgICAgIC8vIG5leHQgc2xpY2UncyBwbGFubmVyIGRvZXMgSklUIHJvYWRtYXAgdmVyaWZpY2F0aW9uIGF0IHplcm8gZXh0cmFcbiAgICAgIC8vIGNvc3QuIE9wdC1pbiB2aWEgZXhwbGljaXQgYHJlYXNzZXNzX2FmdGVyX3NsaWNlOiB0cnVlYCAoZS5nLlxuICAgICAgLy8gYnVybi1tYXggcHJvZmlsZSkgd2hlbiB5b3Ugd2FudCB0aGUgZGVkaWNhdGVkIHJlYXNzZXNzIHNlc3Npb24uXG4gICAgICBjb25zdCByZWFzc2Vzc0VuYWJsZWQgPSBwcmVmcz8ucGhhc2VzPy5yZWFzc2Vzc19hZnRlcl9zbGljZSA/PyBmYWxzZTtcbiAgICAgIGlmICghcmVhc3Nlc3NFbmFibGVkKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IG5lZWRzUmVhc3Nlc3MgPSBhd2FpdCByZWFzc2Vzc21lbnRDaGVja2VyKGJhc2VQYXRoLCBtaWQsIHN0YXRlKTtcbiAgICAgIGlmICghbmVlZHNSZWFzc2VzcykgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgdW5pdFR5cGU6IFwicmVhc3Nlc3Mtcm9hZG1hcFwiLFxuICAgICAgICB1bml0SWQ6IGAke21pZH0vJHtuZWVkc1JlYXNzZXNzLnNsaWNlSWR9YCxcbiAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZFJlYXNzZXNzUm9hZG1hcFByb21wdChcbiAgICAgICAgICBtaWQsXG4gICAgICAgICAgbWlkVGl0bGUsXG4gICAgICAgICAgbmVlZHNSZWFzc2Vzcy5zbGljZUlkLFxuICAgICAgICAgIGJhc2VQYXRoLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJuZWVkcy1kaXNjdXNzaW9uIFx1MjE5MiBkaXNjdXNzLW1pbGVzdG9uZVwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgbWlkLCBtaWRUaXRsZSwgYmFzZVBhdGgsIHByZWZzLCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlIH0pID0+IHtcbiAgICAgIGlmIChzdGF0ZS5waGFzZSAhPT0gXCJuZWVkcy1kaXNjdXNzaW9uXCIpIHJldHVybiBudWxsO1xuICAgICAgLy8gRGVlcCBtb2RlIGJ5cGFzczogeWllbGQgdG8gdGhlIHByb2plY3QtbGV2ZWwgZGVlcCBzdGFnZSBnYXRlc1xuICAgICAgLy8gKHdvcmtmbG93LXByZWZzLCBkaXNjdXNzLXByb2plY3QsIGRpc2N1c3MtcmVxdWlyZW1lbnRzLFxuICAgICAgLy8gcmVzZWFyY2gtZGVjaXNpb24sIHJlc2VhcmNoLXByb2plY3QpIHdoZW4gYW55IG9mIHRoZW0gc3RpbGwgaGF2ZVxuICAgICAgLy8gd29yayBwZW5kaW5nLiBXaXRob3V0IHRoaXMgZ3VhcmQsIHRoZSBtaWxlc3RvbmUgZGlzY3VzcyBydWxlIHdpbnNcbiAgICAgIC8vIGJlZm9yZSB0aGUgZGVlcCBydWxlcyBldmVyIGdldCBhIGNoYW5jZSB0byBmaXJlLlxuICAgICAgaWYgKGhhc1BlbmRpbmdEZWVwU3RhZ2UocHJlZnMsIGJhc2VQYXRoKSkgcmV0dXJuIG51bGw7XG4gICAgICAvLyBINiBmaXggKCM0OTczKToga2VlcCB0aGUgbm9uLWRlZXAgYXV0by1tb2RlIGJ5cGFzcywgYnV0IGRvIG5vdFxuICAgICAgLy8gcHJlLXZlcmlmeSBkZWVwIHBsYW5uaW5nJ3MgdXNlci1mYWNpbmcgbWlsZXN0b25lIGFwcHJvdmFsIGdhdGUuXG4gICAgICBpZiAoc2hvdWxkQnlwYXNzTWlsZXN0b25lRGVwdGhHYXRlSW5BdXRvKHByZWZzKSkge1xuICAgICAgICBtYXJrRGVwdGhWZXJpZmllZChtaWQsIGJhc2VQYXRoKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiLFxuICAgICAgICB1bml0VHlwZTogXCJkaXNjdXNzLW1pbGVzdG9uZVwiLFxuICAgICAgICB1bml0SWQ6IG1pZCxcbiAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZERpc2N1c3NNaWxlc3RvbmVQcm9tcHQoXG4gICAgICAgICAgbWlkLFxuICAgICAgICAgIG1pZFRpdGxlLFxuICAgICAgICAgIGJhc2VQYXRoLFxuICAgICAgICAgIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUsXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICAvLyBEZWVwIG1vZGUgc3RhZ2UgZ2F0ZTogd29ya2Zsb3cgcHJlZmVyZW5jZXMgbm90IHlldCBjYXB0dXJlZC5cbiAgICAvLyBUaGlzIHVzZWQgdG8gZGlzcGF0Y2ggYW4gYWdlbnQgdW5pdCwgYnV0IHRoZSBzdGVwIGlzIGRldGVybWluaXN0aWNcbiAgICAvLyBkZWZhdWx0cy13cml0aW5nLiBLZWVwIGl0IGluLXByb2Nlc3Mgc28gbWlzc2luZyBwcmVmZXJlbmNlcyBjYW5ub3QgbG9vcFxuICAgIC8vIG9uIHRoZSBzYW1lIG5vLWlucHV0IHVuaXQgdW50aWwgc3R1Y2sgZGV0ZWN0aW9uIGZpcmVzLlxuICAgIG5hbWU6IFwiZGVlcDogcHJlLXBsYW5uaW5nIChubyB3b3JrZmxvdyBwcmVmcykgXHUyMTkyIHdvcmtmbG93LXByZWZlcmVuY2VzXCIsXG4gICAgbWF0Y2g6IGFzeW5jICh7IHN0YXRlLCBiYXNlUGF0aCwgcHJlZnMgfSkgPT4ge1xuICAgICAgaWYgKHByZWZzPy5wbGFubmluZ19kZXB0aCAhPT0gXCJkZWVwXCIpIHJldHVybiBudWxsO1xuICAgICAgaWYgKHN0YXRlLnBoYXNlICE9PSBcInByZS1wbGFubmluZ1wiICYmIHN0YXRlLnBoYXNlICE9PSBcIm5lZWRzLWRpc2N1c3Npb25cIikgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoaXNXb3JrZmxvd1ByZWZzQ2FwdHVyZWQoYmFzZVBhdGgpKSByZXR1cm4gbnVsbDsgLy8gYWxyZWFkeSBjYXB0dXJlZCBcdTIwMTQgZmFsbCB0aHJvdWdoXG4gICAgICBlbnN1cmVXb3JrZmxvd1ByZWZlcmVuY2VzQ2FwdHVyZWQoYmFzZVBhdGgpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIC8vIERlZXAgbW9kZSBzdGFnZSBnYXRlOiBQUk9KRUNULm1kIG1pc3Npbmcgb3IgaW52YWxpZC5cbiAgICAvLyBGaXJlcyBvbmx5IHdoZW4gcGxhbm5pbmdfZGVwdGggPT09IFwiZGVlcFwiIGFuZCBQUk9KRUNULm1kIGlzIG1pc3NpbmcvaW52YWxpZC5cbiAgICAvLyBQcm9qZWN0LWxldmVsIGludGVydmlldyBtdXN0IGNvbXBsZXRlIGJlZm9yZSBhbnkgbWlsZXN0b25lLWxldmVsIGRpc2N1c3Npb24uXG4gICAgLy8gTGlnaHQgbW9kZSAoZGVmYXVsdCkgc2tpcHMgdGhpcyBydWxlIGVudGlyZWx5IFx1MjAxNCBmYWxscyB0aHJvdWdoIHRvIG1pbGVzdG9uZSBydWxlcy5cbiAgICBuYW1lOiBcImRlZXA6IHByZS1wbGFubmluZyAobm8gUFJPSkVDVCkgXHUyMTkyIGRpc2N1c3MtcHJvamVjdFwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgYmFzZVBhdGgsIHByZWZzLCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlIH0pID0+IHtcbiAgICAgIGlmIChwcmVmcz8ucGxhbm5pbmdfZGVwdGggIT09IFwiZGVlcFwiKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmIChzdGF0ZS5waGFzZSAhPT0gXCJwcmUtcGxhbm5pbmdcIiAmJiBzdGF0ZS5waGFzZSAhPT0gXCJuZWVkcy1kaXNjdXNzaW9uXCIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgcHJvamVjdFBhdGggPSBqb2luKGdzZFJvb3QoYmFzZVBhdGgpLCBcIlBST0pFQ1QubWRcIik7XG4gICAgICBpZiAoZXhpc3RzU3luYyhwcm9qZWN0UGF0aCkgJiYgdmFsaWRhdGVBcnRpZmFjdChwcm9qZWN0UGF0aCwgXCJwcm9qZWN0XCIpLm9rKSByZXR1cm4gbnVsbDsgLy8gUFJPSkVDVC5tZCB2YWxpZCBcdTIwMTQgZmFsbCB0aHJvdWdoXG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgdW5pdFR5cGU6IFwiZGlzY3Vzcy1wcm9qZWN0XCIsXG4gICAgICAgIHVuaXRJZDogXCJQUk9KRUNUXCIsXG4gICAgICAgIHByb21wdDogYXdhaXQgYnVpbGREaXNjdXNzUHJvamVjdFByb21wdChiYXNlUGF0aCwgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSksXG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICAvLyBEZWVwIG1vZGUgc3RhZ2UgZ2F0ZTogUkVRVUlSRU1FTlRTLm1kIG1pc3Npbmcgb3IgaW52YWxpZC5cbiAgICAvLyBGaXJlcyBvbmx5IHdoZW4gcGxhbm5pbmdfZGVwdGggPT09IFwiZGVlcFwiLCBQUk9KRUNULm1kIGlzIHZhbGlkLCBhbmRcbiAgICAvLyBSRVFVSVJFTUVOVFMubWQgaXMgbWlzc2luZy9pbnZhbGlkLlxuICAgIC8vIEZhbGxzIHRocm91Z2ggaW4gbGlnaHQgbW9kZSBvciB3aGVuIFJFUVVJUkVNRU5UUy5tZCBhbHJlYWR5IGV4aXN0cyBhbmQgaXMgdmFsaWQuXG4gICAgbmFtZTogXCJkZWVwOiBwcmUtcGxhbm5pbmcgKG5vIFJFUVVJUkVNRU5UUykgXHUyMTkyIGRpc2N1c3MtcmVxdWlyZW1lbnRzXCIsXG4gICAgbWF0Y2g6IGFzeW5jICh7IHN0YXRlLCBiYXNlUGF0aCwgcHJlZnMsIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUgfSkgPT4ge1xuICAgICAgaWYgKHByZWZzPy5wbGFubmluZ19kZXB0aCAhPT0gXCJkZWVwXCIpIHJldHVybiBudWxsO1xuICAgICAgaWYgKHN0YXRlLnBoYXNlICE9PSBcInByZS1wbGFubmluZ1wiICYmIHN0YXRlLnBoYXNlICE9PSBcIm5lZWRzLWRpc2N1c3Npb25cIikgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBwcm9qZWN0UGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiUFJPSkVDVC5tZFwiKTtcbiAgICAgIGlmICghZXhpc3RzU3luYyhwcm9qZWN0UGF0aCkgfHwgIXZhbGlkYXRlQXJ0aWZhY3QocHJvamVjdFBhdGgsIFwicHJvamVjdFwiKS5vaykgcmV0dXJuIG51bGw7IC8vIFBST0pFQ1QubWQgbWlzc2luZy9pbnZhbGlkIFx1MjAxNCBlYXJsaWVyIHJ1bGUgaGFuZGxlc1xuICAgICAgY29uc3QgcmVxdWlyZW1lbnRzUGF0aCA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwiUkVRVUlSRU1FTlRTLm1kXCIpO1xuICAgICAgaWYgKGV4aXN0c1N5bmMocmVxdWlyZW1lbnRzUGF0aCkgJiYgdmFsaWRhdGVBcnRpZmFjdChyZXF1aXJlbWVudHNQYXRoLCBcInJlcXVpcmVtZW50c1wiKS5vaykgcmV0dXJuIG51bGw7IC8vIFJFUVVJUkVNRU5UUy5tZCB2YWxpZCBcdTIwMTQgZmFsbCB0aHJvdWdoXG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgdW5pdFR5cGU6IFwiZGlzY3Vzcy1yZXF1aXJlbWVudHNcIixcbiAgICAgICAgdW5pdElkOiBcIlJFUVVJUkVNRU5UU1wiLFxuICAgICAgICBwcm9tcHQ6IGF3YWl0IGJ1aWxkRGlzY3Vzc1JlcXVpcmVtZW50c1Byb21wdChiYXNlUGF0aCwgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSksXG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICAvLyBEZWVwIG1vZGUgcmVzZWFyY2ggZ2F0ZTogY2FwdHVyZSB1c2VyJ3MgcmVzZWFyY2ggZGVjaXNpb24uXG4gICAgLy8gRmlyZXMgYWZ0ZXIgZGlzY3Vzcy1yZXF1aXJlbWVudHMgKFJFUVVJUkVNRU5UUy5tZCBleGlzdHMpIHdoZW4gbm8gZGVjaXNpb25cbiAgICAvLyBtYXJrZXIgaGFzIGJlZW4gd3JpdHRlbiB5ZXQuIEFza3Mgb25lIHllcy9ubyBxdWVzdGlvbiB2aWEgYXNrX3VzZXJfcXVlc3Rpb25zXG4gICAgLy8gYW5kIHdyaXRlcyAuZ3NkL3J1bnRpbWUvcmVzZWFyY2gtZGVjaXNpb24uanNvbi4gRG93bnN0cmVhbSByZXNlYXJjaC1wcm9qZWN0XG4gICAgLy8gcnVsZSByZWFkcyB0aGUgbWFya2VyIHRvIGRlY2lkZSB3aGV0aGVyIHRvIGZhbiBvdXQgNCBwYXJhbGxlbCByZXNlYXJjaCBzdWJhZ2VudHMuXG4gICAgLy8gTGlnaHQgbW9kZSBza2lwcyBlbnRpcmVseS5cbiAgICBuYW1lOiBcImRlZXA6IHByZS1wbGFubmluZyAobm8gcmVzZWFyY2ggZGVjaXNpb24pIFx1MjE5MiByZXNlYXJjaC1kZWNpc2lvblwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgYmFzZVBhdGgsIHByZWZzLCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlIH0pID0+IHtcbiAgICAgIGlmIChwcmVmcz8ucGxhbm5pbmdfZGVwdGggIT09IFwiZGVlcFwiKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmIChzdGF0ZS5waGFzZSAhPT0gXCJwcmUtcGxhbm5pbmdcIiAmJiBzdGF0ZS5waGFzZSAhPT0gXCJuZWVkcy1kaXNjdXNzaW9uXCIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgZ2F0ZSA9IHJlc29sdmVEZWVwUHJvamVjdFNldHVwU3RhdGUocHJlZnMsIGJhc2VQYXRoKTtcbiAgICAgIGlmIChnYXRlLnN0YXR1cyAhPT0gXCJwZW5kaW5nXCIgfHwgZ2F0ZS5zdGFnZSAhPT0gXCJyZXNlYXJjaC1kZWNpc2lvblwiKSByZXR1cm4gbnVsbDtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiLFxuICAgICAgICB1bml0VHlwZTogXCJyZXNlYXJjaC1kZWNpc2lvblwiLFxuICAgICAgICB1bml0SWQ6IFwiUkVTRUFSQ0gtREVDSVNJT05cIixcbiAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZFJlc2VhcmNoRGVjaXNpb25Qcm9tcHQoYmFzZVBhdGgsIHN0cnVjdHVyZWRRdWVzdGlvbnNBdmFpbGFibGUpLFxuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgLy8gRGVlcCBtb2RlIHBhcmFsbGVsIHJlc2VhcmNoLlxuICAgIC8vIEZpcmVzIHdoZW4gcGxhbm5pbmdfZGVwdGggPT09IFwiZGVlcFwiLCBSRVFVSVJFTUVOVFMubWQgZXhpc3RzLFxuICAgIC8vIHJlc2VhcmNoLWRlY2lzaW9uIG1hcmtlciBzYXlzIFwicmVzZWFyY2hcIiwgYW5kIGFueSBvZiB0aGUgNCBwcm9qZWN0XG4gICAgLy8gcmVzZWFyY2ggZmlsZXMgaXMgbWlzc2luZy4gU3Bhd25zIG9uZSBvcmNoZXN0cmF0b3Igc2Vzc2lvbiB0aGF0IGZhbnNcbiAgICAvLyBvdXQgNCBwYXJhbGxlbCBzdWJhZ2VudHMgKHN0YWNrLCBmZWF0dXJlcywgYXJjaGl0ZWN0dXJlLCBwaXRmYWxscykuXG4gICAgLy8gU2tpcHBlZCBlbnRpcmVseSB3aGVuIHVzZXIgY2hvc2UgXCJza2lwXCIgYXQgdGhlIHJlc2VhcmNoLWRlY2lzaW9uIGdhdGUuXG4gICAgbmFtZTogXCJkZWVwOiBwcmUtcGxhbm5pbmcgKHJlc2VhcmNoIGFwcHJvdmVkLCBmaWxlcyBtaXNzaW5nKSBcdTIxOTIgcmVzZWFyY2gtcHJvamVjdFwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgYmFzZVBhdGgsIHByZWZzLCBzdHJ1Y3R1cmVkUXVlc3Rpb25zQXZhaWxhYmxlIH0pID0+IHtcbiAgICAgIGlmIChwcmVmcz8ucGxhbm5pbmdfZGVwdGggIT09IFwiZGVlcFwiKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmIChzdGF0ZS5waGFzZSAhPT0gXCJwcmUtcGxhbm5pbmdcIiAmJiBzdGF0ZS5waGFzZSAhPT0gXCJuZWVkcy1kaXNjdXNzaW9uXCIpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgZ2F0ZSA9IHJlc29sdmVEZWVwUHJvamVjdFNldHVwU3RhdGUocHJlZnMsIGJhc2VQYXRoKTtcbiAgICAgIGlmIChnYXRlLnN0YXR1cyA9PT0gXCJibG9ja2VkXCIgJiYgZ2F0ZS5zdGFnZSA9PT0gXCJwcm9qZWN0LXJlc2VhcmNoXCIpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBhY3Rpb246IFwic3RvcFwiIGFzIGNvbnN0LFxuICAgICAgICAgIHJlYXNvbjogZ2F0ZS5yZWFzb24sXG4gICAgICAgICAgbGV2ZWw6IFwid2FybmluZ1wiIGFzIGNvbnN0LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKGdhdGUuc3RhdHVzICE9PSBcInBlbmRpbmdcIiB8fCBnYXRlLnN0YWdlICE9PSBcInByb2plY3QtcmVzZWFyY2hcIikgcmV0dXJuIG51bGw7XG4gICAgICAvLyBJZGVtcG90ZW5jeSBndWFyZDogb25lIG9yY2hlc3RyYXRvciBvd25zIHRoZSBwcm9qZWN0IHJlc2VhcmNoIGZhbi1vdXRcbiAgICAgIC8vIHVudGlsIGd1aWRlZC1yZXNlYXJjaC1wcm9qZWN0Lm1kIGRlbGV0ZXMgdGhpcyBtYXJrZXIgZHVyaW5nIGNsb3Nlb3V0LlxuICAgICAgY29uc3QgcnVudGltZURpciA9IGpvaW4oZ3NkUm9vdChiYXNlUGF0aCksIFwicnVudGltZVwiKTtcbiAgICAgIGNvbnN0IGluZmxpZ2h0TWFya2VyUGF0aCA9IGpvaW4ocnVudGltZURpciwgUFJPSkVDVF9SRVNFQVJDSF9JTkZMSUdIVF9NQVJLRVIpO1xuICAgICAgY29uc3QgcmVzZWFyY2hJbkZsaWdodFN0b3AgPSB7XG4gICAgICAgIGFjdGlvbjogXCJzdG9wXCIgYXMgY29uc3QsXG4gICAgICAgIHJlYXNvbjpcbiAgICAgICAgICBcIlByb2plY3QgcmVzZWFyY2ggaXMgYWxyZWFkeSBpbiBwcm9ncmVzcy4gV2FpdCBmb3IgaXQgdG8gZmluaXNoLCBvciBjbGVhciBgLmdzZC9ydW50aW1lL3Jlc2VhcmNoLXByb2plY3QtaW5mbGlnaHRgIGlmIHRoZSBwcmlvciBydW4gY3Jhc2hlZC5cIixcbiAgICAgICAgbGV2ZWw6IFwiaW5mb1wiIGFzIGNvbnN0LFxuICAgICAgfTtcbiAgICAgIGlmIChleGlzdHNTeW5jKGluZmxpZ2h0TWFya2VyUGF0aCkpIHJldHVybiByZXNlYXJjaEluRmxpZ2h0U3RvcDtcbiAgICAgIG1rZGlyU3luYyhydW50aW1lRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHdyaXRlRmlsZVN5bmMoXG4gICAgICAgICAgaW5mbGlnaHRNYXJrZXJQYXRoLFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHsgc3RhcnRlZDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpIH0pICsgXCJcXG5cIixcbiAgICAgICAgICB7IGVuY29kaW5nOiBcInV0Zi04XCIsIGZsYWc6IFwid3hcIiB9LFxuICAgICAgICApO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChlcnIgJiYgdHlwZW9mIGVyciA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlcnIgJiYgZXJyLmNvZGUgPT09IFwiRUVYSVNUXCIpIHtcbiAgICAgICAgICByZXR1cm4gcmVzZWFyY2hJbkZsaWdodFN0b3A7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfVxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcHJvbXB0ID0gYXdhaXQgcmVzZWFyY2hQcm9qZWN0UHJvbXB0QnVpbGRlcihiYXNlUGF0aCwgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIsXG4gICAgICAgICAgdW5pdFR5cGU6IFwicmVzZWFyY2gtcHJvamVjdFwiLFxuICAgICAgICAgIHVuaXRJZDogXCJSRVNFQVJDSC1QUk9KRUNUXCIsXG4gICAgICAgICAgcHJvbXB0LFxuICAgICAgICB9O1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaWYgKGV4aXN0c1N5bmMoaW5mbGlnaHRNYXJrZXJQYXRoKSkgdW5saW5rU3luYyhpbmZsaWdodE1hcmtlclBhdGgpO1xuICAgICAgICB9IGNhdGNoIChjbGVhbnVwRXJyKSB7XG4gICAgICAgICAgbG9nV2FybmluZyhcbiAgICAgICAgICAgIFwiZGlzcGF0Y2hcIixcbiAgICAgICAgICAgIGBmYWlsZWQgdG8gcmVtb3ZlIHJlc2VhcmNoLXByb2plY3QgaW4tZmxpZ2h0IG1hcmtlciBhZnRlciBwcm9tcHQgYXNzZW1ibHkgZXJyb3I6ICR7Y2xlYW51cEVyciBpbnN0YW5jZW9mIEVycm9yID8gY2xlYW51cEVyci5tZXNzYWdlIDogU3RyaW5nKGNsZWFudXBFcnIpfWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHJlLXBsYW5uaW5nIChubyBjb250ZXh0KSBcdTIxOTIgZGlzY3Vzcy1taWxlc3RvbmVcIixcbiAgICBtYXRjaDogYXN5bmMgKHsgc3RhdGUsIG1pZCwgbWlkVGl0bGUsIGJhc2VQYXRoLCBwcmVmcywgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSB9KSA9PiB7XG4gICAgICBpZiAoc3RhdGUucGhhc2UgIT09IFwicHJlLXBsYW5uaW5nXCIpIHJldHVybiBudWxsO1xuICAgICAgaWYgKGlzUmVnaXN0cnlNaWxlc3RvbmVDb21wbGV0ZShzdGF0ZSwgbWlkKSkgcmV0dXJuIG51bGw7XG4gICAgICBjb25zdCBjb250ZXh0RmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgIGNvbnN0IGhhc0NvbnRleHQgPSAhIShjb250ZXh0RmlsZSAmJiAoYXdhaXQgbG9hZEZpbGUoY29udGV4dEZpbGUpKSk7XG4gICAgICBpZiAoaGFzQ29udGV4dCkgcmV0dXJuIG51bGw7IC8vIGZhbGwgdGhyb3VnaCB0byBuZXh0IHJ1bGVcbiAgICAgIGlmIChwcmVmcz8ucGxhbm5pbmdfZGVwdGggPT09IFwiZGVlcFwiKSByZXR1cm4gbnVsbDtcbiAgICAgIC8vIEg2IGZpeCAoIzQ5NzMpOiBrZWVwIHRoZSBub24tZGVlcCBhdXRvLW1vZGUgYnlwYXNzLCBidXQgZG8gbm90XG4gICAgICAvLyBwcmUtdmVyaWZ5IGRlZXAgcGxhbm5pbmcncyB1c2VyLWZhY2luZyBtaWxlc3RvbmUgYXBwcm92YWwgZ2F0ZS5cbiAgICAgIGlmIChzaG91bGRCeXBhc3NNaWxlc3RvbmVEZXB0aEdhdGVJbkF1dG8ocHJlZnMpKSB7XG4gICAgICAgIG1hcmtEZXB0aFZlcmlmaWVkKG1pZCwgYmFzZVBhdGgpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIsXG4gICAgICAgIHVuaXRUeXBlOiBcImRpc2N1c3MtbWlsZXN0b25lXCIsXG4gICAgICAgIHVuaXRJZDogbWlkLFxuICAgICAgICBwcm9tcHQ6IGF3YWl0IGJ1aWxkRGlzY3Vzc01pbGVzdG9uZVByb21wdChcbiAgICAgICAgICBtaWQsXG4gICAgICAgICAgbWlkVGl0bGUsXG4gICAgICAgICAgYmFzZVBhdGgsXG4gICAgICAgICAgc3RydWN0dXJlZFF1ZXN0aW9uc0F2YWlsYWJsZSxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHJlLXBsYW5uaW5nIChubyByZXNlYXJjaCkgXHUyMTkyIHJlc2VhcmNoLW1pbGVzdG9uZVwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgbWlkLCBtaWRUaXRsZSwgYmFzZVBhdGgsIHByZWZzIH0pID0+IHtcbiAgICAgIGlmIChzdGF0ZS5waGFzZSAhPT0gXCJwcmUtcGxhbm5pbmdcIikgcmV0dXJuIG51bGw7XG4gICAgICAvLyBQaGFzZSBza2lwOiBza2lwIHJlc2VhcmNoIHdoZW4gcHJlZmVyZW5jZSBvciBwcm9maWxlIHNheXMgc29cbiAgICAgIGlmIChwcmVmcz8ucGhhc2VzPy5za2lwX3Jlc2VhcmNoKSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2VhcmNoRmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiUkVTRUFSQ0hcIik7XG4gICAgICBpZiAocmVzZWFyY2hGaWxlKSByZXR1cm4gbnVsbDsgLy8gaGFzIHJlc2VhcmNoLCBmYWxsIHRocm91Z2hcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiLFxuICAgICAgICB1bml0VHlwZTogXCJyZXNlYXJjaC1taWxlc3RvbmVcIixcbiAgICAgICAgdW5pdElkOiBtaWQsXG4gICAgICAgIHByb21wdDogYXdhaXQgYnVpbGRSZXNlYXJjaE1pbGVzdG9uZVByb21wdChtaWQsIG1pZFRpdGxlLCBiYXNlUGF0aCksXG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByZS1wbGFubmluZyAoaGFzIHJlc2VhcmNoKSBcdTIxOTIgcGxhbi1taWxlc3RvbmVcIixcbiAgICBtYXRjaDogYXN5bmMgKHsgc3RhdGUsIG1pZCwgbWlkVGl0bGUsIGJhc2VQYXRoIH0pID0+IHtcbiAgICAgIGlmIChzdGF0ZS5waGFzZSAhPT0gXCJwcmUtcGxhbm5pbmdcIikgcmV0dXJuIG51bGw7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgdW5pdFR5cGU6IFwicGxhbi1taWxlc3RvbmVcIixcbiAgICAgICAgdW5pdElkOiBtaWQsXG4gICAgICAgIHByb21wdDogYXdhaXQgYnVpbGRQbGFuTWlsZXN0b25lUHJvbXB0KG1pZCwgbWlkVGl0bGUsIGJhc2VQYXRoKSxcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicGxhbm5pbmcgKHJlcXVpcmVfc2xpY2VfZGlzY3Vzc2lvbikgXHUyMTkyIHBhdXNlIGZvciBkaXNjdXNzaW9uICgjMzQ1NClcIixcbiAgICBtYXRjaDogYXN5bmMgKHsgc3RhdGUsIG1pZCwgYmFzZVBhdGgsIHByZWZzIH0pID0+IHtcbiAgICAgIGlmIChzdGF0ZS5waGFzZSAhPT0gXCJwbGFubmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghcHJlZnM/LnBoYXNlcz8ucmVxdWlyZV9zbGljZV9kaXNjdXNzaW9uKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghc3RhdGUuYWN0aXZlU2xpY2UpIHJldHVybiBudWxsO1xuICAgICAgLy8gT25seSBwYXVzZSBpZiB0aGUgc2xpY2UgaGFzIG5vIGNvbnRleHQgZmlsZSB5ZXQgKGRpc2N1c3Npb24gbm90IGRvbmUpLlxuICAgICAgLy8gcmVzb2x2ZVNsaWNlRmlsZSByZXR1cm5zIG51bGwgd2hlbiB0aGUgZmlsZSBkb2VzIG5vdCBleGlzdCBvbiBkaXNrLFxuICAgICAgLy8gYnV0IGNhY2hlZFJlYWRkaXIgY291bGQgcmV0dXJuIGEgc3RhbGUgaGl0IFx1MjAxNCB2ZXJpZnkgd2l0aCBleGlzdHNTeW5jXG4gICAgICAvLyBzbyB0aGUgZ3VhcmQgaXMgZGVmZW5jZS1pbi1kZXB0aCBhbmQgdGhlIGNvbnRyYWN0IGlzIGV4cGxpY2l0IGF0IHRoZVxuICAgICAgLy8gY2FsbCBzaXRlLlxuICAgICAgY29uc3Qgc2xpY2VDb250ZXh0RmlsZSA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pZCwgc3RhdGUuYWN0aXZlU2xpY2UuaWQsIFwiQ09OVEVYVFwiKTtcbiAgICAgIGlmIChzbGljZUNvbnRleHRGaWxlICYmIGV4aXN0c1N5bmMoc2xpY2VDb250ZXh0RmlsZSkpIHJldHVybiBudWxsOyAvLyBkaXNjdXNzaW9uIGFscmVhZHkgZG9uZSwgcHJvY2VlZFxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcInN0b3BcIiBhcyBjb25zdCxcbiAgICAgICAgcmVhc29uOiBgU2xpY2UgJHtzdGF0ZS5hY3RpdmVTbGljZS5pZH0gcmVxdWlyZXMgZGlzY3Vzc2lvbiBiZWZvcmUgcGxhbm5pbmcgKHJlcXVpcmVfc2xpY2VfZGlzY3Vzc2lvbiBpcyBlbmFibGVkKS4gUnVuIC9nc2QgZGlzY3VzcyB0byBkaXNjdXNzIHRoaXMgc2xpY2UsIHRoZW4gL2dzZCBhdXRvIHRvIHJlc3VtZS5gLFxuICAgICAgICBsZXZlbDogXCJpbmZvXCIgYXMgY29uc3QsXG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICAvLyBLZWVwIHRoaXMgcnVsZSBiZWZvcmUgdGhlIHNpbmdsZS1zbGljZSByZXNlYXJjaCBydWxlIHNvIHRoZSBtdWx0aS1zbGljZVxuICAgIC8vIHBhdGggd2lucyB3aGVuZXZlciAyKyBzbGljZXMgYXJlIHJlYWR5LlxuICAgIG5hbWU6IFwicGxhbm5pbmcgKG11bHRpcGxlIHNsaWNlcyBuZWVkIHJlc2VhcmNoKSBcdTIxOTIgcGFyYWxsZWwtcmVzZWFyY2gtc2xpY2VzXCIsXG4gICAgbWF0Y2g6IGFzeW5jICh7IHN0YXRlLCBtaWQsIG1pZFRpdGxlLCBiYXNlUGF0aCwgcHJlZnMgfSkgPT4ge1xuICAgICAgaWYgKHN0YXRlLnBoYXNlICE9PSBcInBsYW5uaW5nXCIpIHJldHVybiBudWxsO1xuICAgICAgaWYgKHByZWZzPy5waGFzZXM/LnNraXBfcmVzZWFyY2ggfHwgcHJlZnM/LnBoYXNlcz8uc2tpcF9zbGljZV9yZXNlYXJjaCkgcmV0dXJuIG51bGw7XG4gICAgICAvLyAjNDc4MSBwaGFzZSAyOiB0cml2aWFsLXNjb3BlIG1pbGVzdG9uZXMgc2tpcCBkZWRpY2F0ZWQgc2xpY2UgcmVzZWFyY2guXG4gICAgICAvLyBwbGFuLXNsaWNlIGFic29yYnMgdGhlIGxpZ2h0d2VpZ2h0IGRpc2NvdmVyeSBhIHRyaXZpYWwgZGVsaXZlcmFibGVcbiAgICAgIC8vIG5lZWRzLiBOdWxsIHJlc3VsdCAoREIgdW5hdmFpbGFibGUgLyB1bmtub3duKSBmYWxscyB0aHJvdWdoIHRvIHRvZGF5J3NcbiAgICAgIC8vIGJlaGF2aW9yLlxuICAgICAgaWYgKGF3YWl0IGdldE1pbGVzdG9uZVBpcGVsaW5lVmFyaWFudChtaWQpID09PSBcInRyaXZpYWxcIikgcmV0dXJuIG51bGw7XG5cbiAgICAgIC8vIExvYWQgcm9hZG1hcCB0byBmaW5kIGFsbCBzbGljZXNcbiAgICAgIGNvbnN0IHJvYWRtYXBGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJST0FETUFQXCIpO1xuICAgICAgY29uc3Qgcm9hZG1hcENvbnRlbnQgPSByb2FkbWFwRmlsZSA/IGF3YWl0IGxvYWRGaWxlKHJvYWRtYXBGaWxlKSA6IG51bGw7XG4gICAgICBpZiAoIXJvYWRtYXBDb250ZW50KSByZXR1cm4gbnVsbDtcbiAgICAgIGNvbnN0IHJvYWRtYXAgPSBwYXJzZVJvYWRtYXAocm9hZG1hcENvbnRlbnQpO1xuXG4gICAgICAvLyBGaW5kIHNsaWNlcyB0aGF0IG5lZWQgcmVzZWFyY2ggKG5vIFJFU0VBUkNIIGZpbGUsIGRlcGVuZGVuY2llcyBkb25lKVxuICAgICAgY29uc3QgbWlsZXN0b25lUmVzZWFyY2hGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJSRVNFQVJDSFwiKTtcbiAgICAgIGNvbnN0IHJlc2VhcmNoUmVhZHlTbGljZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZyB9PiA9IFtdO1xuXG4gICAgICBmb3IgKGNvbnN0IHNsaWNlIG9mIHJvYWRtYXAuc2xpY2VzKSB7XG4gICAgICAgIGlmIChzbGljZS5kb25lKSBjb250aW51ZTtcbiAgICAgICAgLy8gU2tpcCBTMDEgd2hlbiBtaWxlc3RvbmUgcmVzZWFyY2ggZXhpc3RzXG4gICAgICAgIGlmIChtaWxlc3RvbmVSZXNlYXJjaEZpbGUgJiYgc2xpY2UuaWQgPT09IFwiUzAxXCIpIGNvbnRpbnVlO1xuICAgICAgICAvLyBTa2lwIGlmIGFscmVhZHkgaGFzIHJlc2VhcmNoXG4gICAgICAgIGlmIChyZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBtaWQsIHNsaWNlLmlkLCBcIlJFU0VBUkNIXCIpKSBjb250aW51ZTtcbiAgICAgICAgLy8gU2tpcCBpZiBkZXBlbmRlbmNpZXMgYXJlbid0IGRvbmUgKGNoZWNrIGZvciBTVU1NQVJZIGZpbGVzKVxuICAgICAgICBjb25zdCBkZXBzQ29tcGxldGUgPSAoc2xpY2UuZGVwZW5kcyA/PyBbXSkuZXZlcnkoKGRlcElkKSA9PlxuICAgICAgICAgICEhcmVzb2x2ZVNsaWNlRmlsZShiYXNlUGF0aCwgbWlkLCBkZXBJZCwgXCJTVU1NQVJZXCIpLFxuICAgICAgICApO1xuICAgICAgICBpZiAoIWRlcHNDb21wbGV0ZSkgY29udGludWU7XG5cbiAgICAgICAgcmVzZWFyY2hSZWFkeVNsaWNlcy5wdXNoKHsgaWQ6IHNsaWNlLmlkLCB0aXRsZTogc2xpY2UudGl0bGUgfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIE9ubHkgZGlzcGF0Y2ggcGFyYWxsZWwgaWYgMisgc2xpY2VzIGFyZSByZWFkeVxuICAgICAgaWYgKHJlc2VhcmNoUmVhZHlTbGljZXMubGVuZ3RoIDwgMikgcmV0dXJuIG51bGw7XG5cbiAgICAgIC8vICM0NDE0OiBJZiBhIHByZXZpb3VzIHBhcmFsbGVsLXJlc2VhcmNoIGF0dGVtcHQgZXNjYWxhdGVkIHRvIGEgYmxvY2tlclxuICAgICAgLy8gcGxhY2Vob2xkZXIsIHNraXAgdGhpcyBydWxlIGFuZCBmYWxsIHRocm91Z2ggdG8gcGVyLXNsaWNlIHJlc2VhcmNoXG4gICAgICAvLyAob3Igb3RoZXIgcnVsZXMpIHJhdGhlciB0aGFuIHJlLWRpc3BhdGNoaW5nIHRoZSBzYW1lIGZhaWxpbmcgdW5pdC5cbiAgICAgIGNvbnN0IHBhcmFsbGVsQmxvY2tlciA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiUEFSQUxMRUwtQkxPQ0tFUlwiKTtcbiAgICAgIGlmIChwYXJhbGxlbEJsb2NrZXIpIHJldHVybiBudWxsO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgdW5pdFR5cGU6IFwicmVzZWFyY2gtc2xpY2VcIixcbiAgICAgICAgdW5pdElkOiBgJHttaWR9L3BhcmFsbGVsLXJlc2VhcmNoYCxcbiAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZFBhcmFsbGVsUmVzZWFyY2hTbGljZXNQcm9tcHQoXG4gICAgICAgICAgbWlkLFxuICAgICAgICAgIG1pZFRpdGxlLFxuICAgICAgICAgIHJlc2VhcmNoUmVhZHlTbGljZXMsXG4gICAgICAgICAgYmFzZVBhdGgsXG4gICAgICAgICAgcmVzb2x2ZU1vZGVsV2l0aEZhbGxiYWNrc0ZvclVuaXQoXCJzdWJhZ2VudFwiKT8ucHJpbWFyeSxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicGxhbm5pbmcgKG5vIHJlc2VhcmNoLCBub3QgUzAxKSBcdTIxOTIgcmVzZWFyY2gtc2xpY2VcIixcbiAgICBtYXRjaDogYXN5bmMgKHsgc3RhdGUsIG1pZCwgbWlkVGl0bGUsIGJhc2VQYXRoLCBwcmVmcyB9KSA9PiB7XG4gICAgICBpZiAoc3RhdGUucGhhc2UgIT09IFwicGxhbm5pbmdcIikgcmV0dXJuIG51bGw7XG4gICAgICAvLyBQaGFzZSBza2lwOiBza2lwIHJlc2VhcmNoIHdoZW4gcHJlZmVyZW5jZSBvciBwcm9maWxlIHNheXMgc29cbiAgICAgIGlmIChwcmVmcz8ucGhhc2VzPy5za2lwX3Jlc2VhcmNoIHx8IHByZWZzPy5waGFzZXM/LnNraXBfc2xpY2VfcmVzZWFyY2gpXG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgLy8gIzQ3ODEgcGhhc2UgMjogdHJpdmlhbC1zY29wZSBtaWxlc3RvbmVzIHNraXAgZGVkaWNhdGVkIHNsaWNlIHJlc2VhcmNoLlxuICAgICAgaWYgKGF3YWl0IGdldE1pbGVzdG9uZVBpcGVsaW5lVmFyaWFudChtaWQpID09PSBcInRyaXZpYWxcIikgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoIXN0YXRlLmFjdGl2ZVNsaWNlKSByZXR1cm4gbWlzc2luZ1NsaWNlU3RvcChtaWQsIHN0YXRlLnBoYXNlKTtcbiAgICAgIGNvbnN0IHNpZCA9IHN0YXRlLmFjdGl2ZVNsaWNlIS5pZDtcbiAgICAgIGNvbnN0IHNUaXRsZSA9IHN0YXRlLmFjdGl2ZVNsaWNlIS50aXRsZTtcbiAgICAgIGNvbnN0IHJlc2VhcmNoRmlsZSA9IHJlc29sdmVTbGljZUZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCBcIlJFU0VBUkNIXCIpO1xuICAgICAgaWYgKHJlc2VhcmNoRmlsZSkgcmV0dXJuIG51bGw7IC8vIGhhcyByZXNlYXJjaCwgZmFsbCB0aHJvdWdoXG4gICAgICAvLyBTa2lwIHNsaWNlIHJlc2VhcmNoIGZvciBTMDEgd2hlbiBtaWxlc3RvbmUgcmVzZWFyY2ggYWxyZWFkeSBleGlzdHMgXHUyMDE0XG4gICAgICAvLyB0aGUgbWlsZXN0b25lIHJlc2VhcmNoIGFscmVhZHkgY292ZXJzIHRoZSBzYW1lIGdyb3VuZCBmb3IgdGhlIGZpcnN0IHNsaWNlLlxuICAgICAgY29uc3QgbWlsZXN0b25lUmVzZWFyY2hGaWxlID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoXG4gICAgICAgIGJhc2VQYXRoLFxuICAgICAgICBtaWQsXG4gICAgICAgIFwiUkVTRUFSQ0hcIixcbiAgICAgICk7XG4gICAgICBpZiAobWlsZXN0b25lUmVzZWFyY2hGaWxlICYmIHNpZCA9PT0gXCJTMDFcIikgcmV0dXJuIG51bGw7IC8vIGZhbGwgdGhyb3VnaCB0byBwbGFuLXNsaWNlXG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgdW5pdFR5cGU6IFwicmVzZWFyY2gtc2xpY2VcIixcbiAgICAgICAgdW5pdElkOiBgJHttaWR9LyR7c2lkfWAsXG4gICAgICAgIHByb21wdDogYXdhaXQgYnVpbGRSZXNlYXJjaFNsaWNlUHJvbXB0KFxuICAgICAgICAgIG1pZCxcbiAgICAgICAgICBtaWRUaXRsZSxcbiAgICAgICAgICBzaWQsXG4gICAgICAgICAgc1RpdGxlLFxuICAgICAgICAgIGJhc2VQYXRoLFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgLy8gQURSLTAxMTogc2tldGNoLXRoZW4tcmVmaW5lLiBXaGVuIGByZWZpbmluZ2AgcGhhc2UgZmlyZXMsIGV4cGFuZCB0aGVcbiAgICAvLyBza2V0Y2ggaW50byBhIGZ1bGwgcGxhbiB1c2luZyB0aGUgcHJpb3Igc2xpY2UncyBTVU1NQVJZIGFuZCB0aGUgY3VycmVudFxuICAgIC8vIGNvZGViYXNlLiBJZiB0aGUgdXNlciBmbGlwcGVkIGBwcm9ncmVzc2l2ZV9wbGFubmluZ2Agb2ZmIG1pZC1taWxlc3RvbmVcbiAgICAvLyB3aGlsZSBhIHNsaWNlIGlzIHN0aWxsIGBpc19za2V0Y2g9MWAsIGZhbGwgdGhyb3VnaCB0byBhIHN0YW5kYXJkXG4gICAgLy8gcGxhbi1zbGljZSBzbyB0aGUgbG9vcCBkb2Vzbid0IGRlYWQtZW5kLlxuICAgIC8vXG4gICAgLy8gTm90ZSBvbiB0aGUgZmxhZy1PRkYgZG93bmdyYWRlOiBEQiBzbGljZSBtZXRhZGF0YSBpcyBhdXRob3JpdGF0aXZlLlxuICAgIC8vIFBMQU4ubWQgaXMgb25seSBhIHByb2plY3Rpb24sIHNvIHBsYW4tc2xpY2UvcmVmaW5lLXNsaWNlIGhhbmRsZXJzIG11c3RcbiAgICAvLyBleHBsaWNpdGx5IGNsZWFyIGBpc19za2V0Y2hgIHdoZW4gYSBza2V0Y2ggYmVjb21lcyBhIGZ1bGwgcGxhbi5cbiAgICBuYW1lOiBcInJlZmluaW5nIFx1MjE5MiByZWZpbmUtc2xpY2VcIixcbiAgICBtYXRjaDogYXN5bmMgKHsgc3RhdGUsIG1pZCwgbWlkVGl0bGUsIGJhc2VQYXRoLCBwcmVmcywgc2Vzc2lvbkNvbnRleHRXaW5kb3csIG1vZGVsUmVnaXN0cnksIHNlc3Npb25Qcm92aWRlciB9KSA9PiB7XG4gICAgICBpZiAoc3RhdGUucGhhc2UgIT09IFwicmVmaW5pbmdcIikgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoIXN0YXRlLmFjdGl2ZVNsaWNlKSByZXR1cm4gbWlzc2luZ1NsaWNlU3RvcChtaWQsIHN0YXRlLnBoYXNlKTtcbiAgICAgIGNvbnN0IHNpZCA9IHN0YXRlLmFjdGl2ZVNsaWNlLmlkO1xuICAgICAgY29uc3Qgc1RpdGxlID0gc3RhdGUuYWN0aXZlU2xpY2UudGl0bGU7XG4gICAgICBjb25zdCBwcm9ncmVzc2l2ZU9uID0gcHJlZnM/LnBoYXNlcz8ucHJvZ3Jlc3NpdmVfcGxhbm5pbmcgPT09IHRydWU7XG4gICAgICBpZiAoIXByb2dyZXNzaXZlT24pIHtcbiAgICAgICAgLy8gR3JhY2VmdWwgZG93bmdyYWRlOiB0cmVhdCB0aGUgc2tldGNoIGFzIGEgbm9ybWFsIHNsaWNlIG5lZWRpbmcgYSBwbGFuLFxuICAgICAgICAvLyBidXQgZm9yd2FyZCB0aGUgc3RvcmVkIHNrZXRjaF9zY29wZSBhcyBhIFNPRlQgaGludCBzbyB0aGUgc2NvcGVcbiAgICAgICAgLy8gc2lnbmFsIGlzbid0IHNpbGVudGx5IGxvc3QuIFRoZSBwbGFubmVyIG1heSBleHBhbmQgYmV5b25kIGl0LlxuICAgICAgICBsZXQgc29mdFNjb3BlSGludCA9IFwiXCI7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgeyBpc0RiQXZhaWxhYmxlLCBnZXRTbGljZSB9ID0gYXdhaXQgaW1wb3J0KFwiLi9nc2QtZGIuanNcIik7XG4gICAgICAgICAgaWYgKGlzRGJBdmFpbGFibGUoKSkge1xuICAgICAgICAgICAgc29mdFNjb3BlSGludCA9IGdldFNsaWNlKG1pZCwgc2lkKT8uc2tldGNoX3Njb3BlID8/IFwiXCI7XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICBzb2Z0U2NvcGVIaW50ID0gXCJcIjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiLFxuICAgICAgICAgIHVuaXRUeXBlOiBcInBsYW4tc2xpY2VcIixcbiAgICAgICAgICB1bml0SWQ6IGAke21pZH0vJHtzaWR9YCxcbiAgICAgICAgICBwcm9tcHQ6IGF3YWl0IGJ1aWxkUGxhblNsaWNlUHJvbXB0KFxuICAgICAgICAgICAgbWlkLCBtaWRUaXRsZSwgc2lkLCBzVGl0bGUsIGJhc2VQYXRoLCB1bmRlZmluZWQsXG4gICAgICAgICAgICB7IC4uLihzb2Z0U2NvcGVIaW50ID8geyBzb2Z0U2NvcGVIaW50IH0gOiB7fSksIHNlc3Npb25Db250ZXh0V2luZG93LCBtb2RlbFJlZ2lzdHJ5LCBzZXNzaW9uUHJvdmlkZXIgfSxcbiAgICAgICAgICApLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIsXG4gICAgICAgIHVuaXRUeXBlOiBcInJlZmluZS1zbGljZVwiLFxuICAgICAgICB1bml0SWQ6IGAke21pZH0vJHtzaWR9YCxcbiAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZFJlZmluZVNsaWNlUHJvbXB0KFxuICAgICAgICAgIG1pZCwgbWlkVGl0bGUsIHNpZCwgc1RpdGxlLCBiYXNlUGF0aCwgdW5kZWZpbmVkLFxuICAgICAgICAgIHsgc2Vzc2lvbkNvbnRleHRXaW5kb3csIG1vZGVsUmVnaXN0cnksIHNlc3Npb25Qcm92aWRlciB9LFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwbGFubmluZyBcdTIxOTIgcGxhbi1zbGljZVwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgbWlkLCBtaWRUaXRsZSwgYmFzZVBhdGgsIHNlc3Npb25Db250ZXh0V2luZG93LCBtb2RlbFJlZ2lzdHJ5LCBzZXNzaW9uUHJvdmlkZXIsIHNlc3Npb24gfSkgPT4ge1xuICAgICAgaWYgKHN0YXRlLnBoYXNlICE9PSBcInBsYW5uaW5nXCIpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFzdGF0ZS5hY3RpdmVTbGljZSkgcmV0dXJuIG1pc3NpbmdTbGljZVN0b3AobWlkLCBzdGF0ZS5waGFzZSk7XG4gICAgICBjb25zdCBzaWQgPSBzdGF0ZS5hY3RpdmVTbGljZSEuaWQ7XG4gICAgICBjb25zdCBzVGl0bGUgPSBzdGF0ZS5hY3RpdmVTbGljZSEudGl0bGU7XG4gICAgICAvLyAjNDU1MTogQ29uc3VtZSBhbnkgcGVyc2lzdGVkIHByZS1leGVjIGZhaWx1cmUgZm9yIHRoaXMgc2xpY2Ugc28gdGhlXG4gICAgICAvLyByZS1kaXNwYXRjaGVkIHByb21wdCBpbmNsdWRlcyB0aGUgZXhhY3QgYmxvY2tlZCByZWZlcmVuY2VzLiBDbGVhciB0aGVcbiAgICAgIC8vIGZpZWxkIGltbWVkaWF0ZWx5IGFmdGVyIHJlYWRpbmcgdG8gcHJldmVudCBzdGFsZSBjb250ZXh0IGxlYWtpbmcgaW50b1xuICAgICAgLy8gYSBsYXRlciwgdW5yZWxhdGVkIHBsYW4tc2xpY2UgcnVuLlxuICAgICAgY29uc3QgdW5pdElkID0gYCR7bWlkfS8ke3NpZH1gO1xuICAgICAgbGV0IHByaW9yUHJlRXhlY0ZhaWx1cmU6IHsgYmxvY2tpbmdGaW5kaW5nczogc3RyaW5nW107IHZlcmRpY3RFeGNlcnB0OiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcbiAgICAgIGlmIChzZXNzaW9uPy5sYXN0UHJlRXhlY0ZhaWx1cmU/LnVuaXRJZCA9PT0gdW5pdElkKSB7XG4gICAgICAgIC8vIENpcmN1aXQgYnJlYWtlcjogc3RvcCByZS1kaXNwYXRjaGluZyBhZnRlciAyIGZhaWxlZCByZXRyaWVzLiBUaGVcbiAgICAgICAgLy8gcGxhbm5lciBoYXMgaGFkIG11bHRpcGxlIGF0dGVtcHRzIHdpdGggaW5qZWN0ZWQgZmFpbHVyZSBjb250ZXh0IGFuZFxuICAgICAgICAvLyBzdGlsbCBjYW5ub3QgcHJvZHVjZSBhIHZhbGlkIHBsYW4gXHUyMDE0IGh1bWFuIHJldmlldyBpcyByZXF1aXJlZC5cbiAgICAgICAgY29uc3QgTUFYX1BSRV9FWEVDX1JFVFJJRVMgPSAyO1xuICAgICAgICBjb25zdCByZXRyeUNvdW50ID0gc2Vzc2lvbi5wcmVFeGVjUmV0cnlDb3VudD8uZ2V0KHVuaXRJZCkgPz8gMDtcbiAgICAgICAgaWYgKHJldHJ5Q291bnQgPj0gTUFYX1BSRV9FWEVDX1JFVFJJRVMpIHtcbiAgICAgICAgICBjb25zdCBmaW5kaW5ncyA9IHNlc3Npb24ubGFzdFByZUV4ZWNGYWlsdXJlLmJsb2NraW5nRmluZGluZ3Muam9pbihcIjsgXCIpO1xuICAgICAgICAgIHNlc3Npb24ubGFzdFByZUV4ZWNGYWlsdXJlID0gbnVsbDtcbiAgICAgICAgICBzZXNzaW9uLnByZUV4ZWNSZXRyeUNvdW50Py5kZWxldGUodW5pdElkKTtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgYWN0aW9uOiBcInN0b3BcIixcbiAgICAgICAgICAgIHJlYXNvbjogYFByZS1leGVjdXRpb24gY2hlY2tzIGZhaWxlZCAke3JldHJ5Q291bnR9IHRpbWVzIGZvciAke3VuaXRJZH0gXHUyMDE0IG1hbnVhbCBpbnRlcnZlbnRpb24gcmVxdWlyZWQuIEJsb2NraW5nIGZpbmRpbmdzOiAke2ZpbmRpbmdzfS4gRml4IHRoZSBwbGFuIG1hbnVhbGx5LCB0aGVuIHJ1biAvZ3NkIGF1dG8gdG8gcmVzdW1lLmAsXG4gICAgICAgICAgICBsZXZlbDogXCJlcnJvclwiLFxuICAgICAgICAgICAgbWF0Y2hlZFJ1bGU6IFwicGxhbm5pbmcgXHUyMTkyIHBsYW4tc2xpY2VcIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICAgIHByaW9yUHJlRXhlY0ZhaWx1cmUgPSB7XG4gICAgICAgICAgYmxvY2tpbmdGaW5kaW5nczogc2Vzc2lvbi5sYXN0UHJlRXhlY0ZhaWx1cmUuYmxvY2tpbmdGaW5kaW5ncyxcbiAgICAgICAgICB2ZXJkaWN0RXhjZXJwdDogc2Vzc2lvbi5sYXN0UHJlRXhlY0ZhaWx1cmUudmVyZGljdEV4Y2VycHQsXG4gICAgICAgIH07XG4gICAgICAgIHNlc3Npb24ubGFzdFByZUV4ZWNGYWlsdXJlID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiLFxuICAgICAgICB1bml0VHlwZTogXCJwbGFuLXNsaWNlXCIsXG4gICAgICAgIHVuaXRJZCxcbiAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZFBsYW5TbGljZVByb21wdChcbiAgICAgICAgICBtaWQsXG4gICAgICAgICAgbWlkVGl0bGUsXG4gICAgICAgICAgc2lkLFxuICAgICAgICAgIHNUaXRsZSxcbiAgICAgICAgICBiYXNlUGF0aCxcbiAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgeyBzZXNzaW9uQ29udGV4dFdpbmRvdywgbW9kZWxSZWdpc3RyeSwgc2Vzc2lvblByb3ZpZGVyLCBwcmlvclByZUV4ZWNGYWlsdXJlIH0sXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImV2YWx1YXRpbmctZ2F0ZXMgXHUyMTkyIGdhdGUtZXZhbHVhdGVcIixcbiAgICBtYXRjaDogYXN5bmMgKHsgc3RhdGUsIG1pZCwgbWlkVGl0bGUsIGJhc2VQYXRoLCBwcmVmcyB9KSA9PiB7XG4gICAgICBpZiAoc3RhdGUucGhhc2UgIT09IFwiZXZhbHVhdGluZy1nYXRlc1wiKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghc3RhdGUuYWN0aXZlU2xpY2UpIHJldHVybiBtaXNzaW5nU2xpY2VTdG9wKG1pZCwgc3RhdGUucGhhc2UpO1xuICAgICAgY29uc3Qgc2lkID0gc3RhdGUuYWN0aXZlU2xpY2UuaWQ7XG4gICAgICBjb25zdCBzVGl0bGUgPSBzdGF0ZS5hY3RpdmVTbGljZS50aXRsZTtcblxuICAgICAgLy8gR2F0ZSBldmFsdWF0aW9uIGlzIG9wdC1pbiB2aWEgcHJlZmVyZW5jZXNcbiAgICAgIGNvbnN0IGdhdGVDb25maWcgPSBwcmVmcz8uZ2F0ZV9ldmFsdWF0aW9uO1xuICAgICAgaWYgKCFnYXRlQ29uZmlnPy5lbmFibGVkKSB7XG4gICAgICAgIG1hcmtBbGxHYXRlc09taXR0ZWQobWlkLCBzaWQpO1xuICAgICAgICByZXR1cm4geyBhY3Rpb246IFwic2tpcFwiIH07XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHBlbmRpbmcgPSBnZXRQZW5kaW5nR2F0ZXMobWlkLCBzaWQsIFwic2xpY2VcIik7XG4gICAgICBpZiAocGVuZGluZy5sZW5ndGggPT09IDApIHJldHVybiB7IGFjdGlvbjogXCJza2lwXCIgfTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIsXG4gICAgICAgIHVuaXRUeXBlOiBcImdhdGUtZXZhbHVhdGVcIixcbiAgICAgICAgdW5pdElkOiBgJHttaWR9LyR7c2lkfS9nYXRlcyske3BlbmRpbmcubWFwKGcgPT4gZy5nYXRlX2lkKS5qb2luKFwiLFwiKX1gLFxuICAgICAgICBwcm9tcHQ6IGF3YWl0IGJ1aWxkR2F0ZUV2YWx1YXRlUHJvbXB0KFxuICAgICAgICAgIG1pZCxcbiAgICAgICAgICBtaWRUaXRsZSxcbiAgICAgICAgICBzaWQsXG4gICAgICAgICAgc1RpdGxlLFxuICAgICAgICAgIGJhc2VQYXRoLFxuICAgICAgICAgIHJlc29sdmVNb2RlbFdpdGhGYWxsYmFja3NGb3JVbml0KFwic3ViYWdlbnRcIik/LnByaW1hcnksXG4gICAgICAgICksXG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlcGxhbm5pbmctc2xpY2UgXHUyMTkyIHJlcGxhbi1zbGljZVwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgbWlkLCBtaWRUaXRsZSwgYmFzZVBhdGggfSkgPT4ge1xuICAgICAgaWYgKHN0YXRlLnBoYXNlICE9PSBcInJlcGxhbm5pbmctc2xpY2VcIikgcmV0dXJuIG51bGw7XG4gICAgICBpZiAoIXN0YXRlLmFjdGl2ZVNsaWNlKSByZXR1cm4gbWlzc2luZ1NsaWNlU3RvcChtaWQsIHN0YXRlLnBoYXNlKTtcbiAgICAgIGNvbnN0IHNpZCA9IHN0YXRlLmFjdGl2ZVNsaWNlIS5pZDtcbiAgICAgIGNvbnN0IHNUaXRsZSA9IHN0YXRlLmFjdGl2ZVNsaWNlIS50aXRsZTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiLFxuICAgICAgICB1bml0VHlwZTogXCJyZXBsYW4tc2xpY2VcIixcbiAgICAgICAgdW5pdElkOiBgJHttaWR9LyR7c2lkfWAsXG4gICAgICAgIHByb21wdDogYXdhaXQgYnVpbGRSZXBsYW5TbGljZVByb21wdChcbiAgICAgICAgICBtaWQsXG4gICAgICAgICAgbWlkVGl0bGUsXG4gICAgICAgICAgc2lkLFxuICAgICAgICAgIHNUaXRsZSxcbiAgICAgICAgICBiYXNlUGF0aCxcbiAgICAgICAgKSxcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZXhlY3V0aW5nIFx1MjE5MiByZWFjdGl2ZS1leGVjdXRlIChwYXJhbGxlbCBkaXNwYXRjaClcIixcbiAgICBtYXRjaDogYXN5bmMgKHsgc3RhdGUsIG1pZCwgbWlkVGl0bGUsIGJhc2VQYXRoLCBwcmVmcywgc2Vzc2lvbkNvbnRleHRXaW5kb3csIG1vZGVsUmVnaXN0cnksIHNlc3Npb25Qcm92aWRlciB9KSA9PiB7XG4gICAgICBpZiAoc3RhdGUucGhhc2UgIT09IFwiZXhlY3V0aW5nXCIgfHwgIXN0YXRlLmFjdGl2ZVRhc2spIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFzdGF0ZS5hY3RpdmVTbGljZSkgcmV0dXJuIG51bGw7IC8vIGZhbGwgdGhyb3VnaFxuXG4gICAgICAvLyBSZWFjdGl2ZSBkaXNwYXRjaCBpcyBvbiBieSBkZWZhdWx0IHdoZW4gdGhlcmUgYXJlIGVub3VnaCByZWFkeSB0YXNrcyB0b1xuICAgICAgLy8gYmVuZWZpdCBmcm9tIHBhcmFsbGVsaXNtLiBVc2VycyBvcHQgb3V0IGV4cGxpY2l0bHkgdmlhXG4gICAgICAvLyBgcmVhY3RpdmVfZXhlY3V0aW9uLmVuYWJsZWQ6IGZhbHNlYC4gVGhlIGRvd25zdHJlYW0gc2FmZXR5IGNoZWNrc1xuICAgICAgLy8gKGdyYXBoIGFtYmlndWl0eSwgcmVhZHktdGFzayBjb3VudCwgY29uZmxpY3QtZnJlZSBzZWxlY3Rpb24pIHN0aWxsIGdhdGVcbiAgICAgIC8vIGV2ZXJ5IGFjdHVhbCBkaXNwYXRjaCwgc28gdGhlIHdvcnN0LWNhc2UgXCJkZWZhdWx0LW9uXCIgb3V0Y29tZSBpcyB0aGVcbiAgICAgIC8vIHNhbWUgZmFsbC10aHJvdWdoIHRvIHNlcXVlbnRpYWwgZXhlY3V0aW9uIGFzIGJlZm9yZS5cbiAgICAgIGNvbnN0IHJlYWN0aXZlQ29uZmlnID0gcHJlZnM/LnJlYWN0aXZlX2V4ZWN1dGlvbjtcbiAgICAgIGlmIChyZWFjdGl2ZUNvbmZpZz8uZW5hYmxlZCA9PT0gZmFsc2UpIHJldHVybiBudWxsO1xuXG4gICAgICBjb25zdCBzaWQgPSBzdGF0ZS5hY3RpdmVTbGljZS5pZDtcbiAgICAgIGNvbnN0IHNUaXRsZSA9IHN0YXRlLmFjdGl2ZVNsaWNlLnRpdGxlO1xuICAgICAgY29uc3QgbWF4UGFyYWxsZWwgPSByZWFjdGl2ZUNvbmZpZz8ubWF4X3BhcmFsbGVsID8/IDI7XG4gICAgICBjb25zdCBzdWJhZ2VudE1vZGVsID0gcmVhY3RpdmVDb25maWc/LnN1YmFnZW50X21vZGVsID8/IHJlc29sdmVNb2RlbFdpdGhGYWxsYmFja3NGb3JVbml0KFwic3ViYWdlbnRcIik/LnByaW1hcnk7XG4gICAgICAvLyBEZWZhdWx0LW9uIHNhZmV0eSB0aHJlc2hvbGQ6IG9ubHkgYWN0aXZhdGUgcmVhY3RpdmUgZGlzcGF0Y2ggd2hlbiBhdFxuICAgICAgLy8gbGVhc3QgTiB0YXNrcyBhcmUgcmVhZHkuIFVzZXJzIHdobyBleHBsaWNpdGx5IGVuYWJsZWQgcmVhY3RpdmVfZXhlY3V0aW9uXG4gICAgICAvLyBrZWVwIHRoZSBsZWdhY3kgdGhyZXNob2xkIG9mIDIgKG1hdGNoZXMgdGhlIHByaW9yIFwiYW55IHBhcmFsbGVsaXNtIGlzXG4gICAgICAvLyBiZXR0ZXIgdGhhbiBub25lXCIgaW50ZW50KS4gRGVmYXVsdC1vbiBpbnN0YWxscyByZXF1aXJlID49MyB0byBhdm9pZFxuICAgICAgLy8gc3VycHJpc2luZyB1c2VycyB3aXRoIHBhcmFsbGVsaXNtIG9uIHNtYWxsIHNsaWNlcy5cbiAgICAgIGNvbnN0IG1pblJlYWR5VGFza3NGb3JSZWFjdGl2ZSA9IHJlYWN0aXZlQ29uZmlnPy5lbmFibGVkID09PSB0cnVlID8gMiA6IDM7XG5cbiAgICAgIC8vIERyeS1ydW4gbW9kZTogbWF4X3BhcmFsbGVsPTEgbWVhbnMgZ3JhcGggaXMgZGVyaXZlZCBhbmQgbG9nZ2VkIGJ1dFxuICAgICAgLy8gZXhlY3V0aW9uIHJlbWFpbnMgc2VxdWVudGlhbFxuICAgICAgaWYgKG1heFBhcmFsbGVsIDw9IDEpIHJldHVybiBudWxsO1xuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCB7XG4gICAgICAgICAgbG9hZFNsaWNlVGFza0lPLFxuICAgICAgICAgIGRlcml2ZVRhc2tHcmFwaCxcbiAgICAgICAgICBpc0dyYXBoQW1iaWd1b3VzLFxuICAgICAgICAgIGdldFJlYWR5VGFza3MsXG4gICAgICAgICAgY2hvb3NlTm9uQ29uZmxpY3RpbmdTdWJzZXQsXG4gICAgICAgICAgZ3JhcGhNZXRyaWNzLFxuICAgICAgICB9ID0gYXdhaXQgaW1wb3J0KFwiLi9yZWFjdGl2ZS1ncmFwaC5qc1wiKTtcblxuICAgICAgICBjb25zdCB0YXNrSU8gPSBhd2FpdCBsb2FkU2xpY2VUYXNrSU8oYmFzZVBhdGgsIG1pZCwgc2lkKTtcbiAgICAgICAgaWYgKHRhc2tJTy5sZW5ndGggPCAyKSByZXR1cm4gbnVsbDsgLy8gc2luZ2xlIHRhc2ssIG5vIHBvaW50XG5cbiAgICAgICAgY29uc3QgZ3JhcGggPSBkZXJpdmVUYXNrR3JhcGgodGFza0lPKTtcblxuICAgICAgICAvLyBBbWJpZ3VvdXMgZ3JhcGggXHUyMTkyIGZhbGwgdGhyb3VnaCB0byBzZXF1ZW50aWFsXG4gICAgICAgIGlmIChpc0dyYXBoQW1iaWd1b3VzKGdyYXBoKSkgcmV0dXJuIG51bGw7XG5cbiAgICAgICAgY29uc3QgY29tcGxldGVkID0gbmV3IFNldChncmFwaC5maWx0ZXIoKG4pID0+IG4uZG9uZSkubWFwKChuKSA9PiBuLmlkKSk7XG4gICAgICAgIGNvbnN0IHJlYWR5SWRzID0gZ2V0UmVhZHlUYXNrcyhncmFwaCwgY29tcGxldGVkLCBuZXcgU2V0KCkpO1xuXG4gICAgICAgIC8vIE9ubHkgYWN0aXZhdGUgcmVhY3RpdmUgZGlzcGF0Y2ggd2hlbiBlbm91Z2ggdGFza3MgYXJlIHJlYWR5LlxuICAgICAgICAvLyBUaHJlc2hvbGQgaXMgMiB3aGVuIGV4cGxpY2l0bHkgb3B0ZWQgaW4sIDMgd2hlbiBkZWZhdWx0LW9uLlxuICAgICAgICBpZiAocmVhZHlJZHMubGVuZ3RoIDwgbWluUmVhZHlUYXNrc0ZvclJlYWN0aXZlKSByZXR1cm4gbnVsbDtcblxuICAgICAgICBjb25zdCB1b2tGbGFncyA9IHJlc29sdmVVb2tGbGFncyhwcmVmcyk7XG4gICAgICAgIGNvbnN0IHNlbGVjdGVkID0gdW9rRmxhZ3MuZXhlY3V0aW9uR3JhcGhcbiAgICAgICAgICA/IHNlbGVjdFJlYWN0aXZlRGlzcGF0Y2hCYXRjaCh7XG4gICAgICAgICAgICAgIGdyYXBoLFxuICAgICAgICAgICAgICByZWFkeUlkcyxcbiAgICAgICAgICAgICAgbWF4UGFyYWxsZWwsXG4gICAgICAgICAgICAgIGluRmxpZ2h0T3V0cHV0czogbmV3IFNldCgpLFxuICAgICAgICAgICAgfSkuc2VsZWN0ZWRcbiAgICAgICAgICA6IGNob29zZU5vbkNvbmZsaWN0aW5nU3Vic2V0KFxuICAgICAgICAgICAgICByZWFkeUlkcyxcbiAgICAgICAgICAgICAgZ3JhcGgsXG4gICAgICAgICAgICAgIG1heFBhcmFsbGVsLFxuICAgICAgICAgICAgICBuZXcgU2V0KCksXG4gICAgICAgICAgICApO1xuICAgICAgICBpZiAoc2VsZWN0ZWQubGVuZ3RoIDw9IDEpIHJldHVybiBudWxsO1xuXG4gICAgICAgIC8vIExvZyBncmFwaCBtZXRyaWNzIGZvciBvYnNlcnZhYmlsaXR5XG4gICAgICAgIGNvbnN0IG1ldHJpY3MgPSBncmFwaE1ldHJpY3MoZ3JhcGgpO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICBgZ3NkLXJlYWN0aXZlOiAke21pZH0vJHtzaWR9IGdyYXBoIFx1MjAxNCB0YXNrczoke21ldHJpY3MudGFza0NvdW50fSBlZGdlczoke21ldHJpY3MuZWRnZUNvdW50fSBgICtcbiAgICAgICAgICBgcmVhZHk6JHttZXRyaWNzLnJlYWR5U2V0U2l6ZX0gZGlzcGF0Y2hpbmc6JHtzZWxlY3RlZC5sZW5ndGh9IGFtYmlndW91czoke21ldHJpY3MuYW1iaWd1b3VzfVxcbmAsXG4gICAgICAgICk7XG5cbiAgICAgICAgLy8gUGVyc2lzdCBkaXNwYXRjaGVkIGJhdGNoIHNvIHZlcmlmaWNhdGlvbiBhbmQgcmVjb3ZlcnkgY2FuIGNoZWNrXG4gICAgICAgIC8vIGV4YWN0bHkgd2hpY2ggdGFza3Mgd2VyZSBzZW50LlxuICAgICAgICBjb25zdCB7IHNhdmVSZWFjdGl2ZVN0YXRlIH0gPSBhd2FpdCBpbXBvcnQoXCIuL3JlYWN0aXZlLWdyYXBoLmpzXCIpO1xuICAgICAgICBzYXZlUmVhY3RpdmVTdGF0ZShiYXNlUGF0aCwgbWlkLCBzaWQsIHtcbiAgICAgICAgICBzbGljZUlkOiBzaWQsXG4gICAgICAgICAgY29tcGxldGVkOiBbLi4uY29tcGxldGVkXSxcbiAgICAgICAgICBkaXNwYXRjaGVkOiBzZWxlY3RlZCxcbiAgICAgICAgICBncmFwaFNuYXBzaG90OiBtZXRyaWNzLFxuICAgICAgICAgIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBFbmNvZGUgc2VsZWN0ZWQgdGFzayBJRHMgaW4gdW5pdElkIGZvciBhcnRpZmFjdCB2ZXJpZmljYXRpb24uXG4gICAgICAgIC8vIEZvcm1hdDogTTAwMS9TMDEvcmVhY3RpdmUrVDAyLFQwM1xuICAgICAgICBjb25zdCBiYXRjaFN1ZmZpeCA9IHNlbGVjdGVkLmpvaW4oXCIsXCIpO1xuXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIsXG4gICAgICAgICAgdW5pdFR5cGU6IFwicmVhY3RpdmUtZXhlY3V0ZVwiLFxuICAgICAgICAgIHVuaXRJZDogYCR7bWlkfS8ke3NpZH0vcmVhY3RpdmUrJHtiYXRjaFN1ZmZpeH1gLFxuICAgICAgICAgIHByb21wdDogYXdhaXQgYnVpbGRSZWFjdGl2ZUV4ZWN1dGVQcm9tcHQoXG4gICAgICAgICAgICBtaWQsXG4gICAgICAgICAgICBtaWRUaXRsZSxcbiAgICAgICAgICAgIHNpZCxcbiAgICAgICAgICAgIHNUaXRsZSxcbiAgICAgICAgICAgIHNlbGVjdGVkLFxuICAgICAgICAgICAgYmFzZVBhdGgsXG4gICAgICAgICAgICBzdWJhZ2VudE1vZGVsLFxuICAgICAgICAgICAgeyBzZXNzaW9uQ29udGV4dFdpbmRvdywgbW9kZWxSZWdpc3RyeSwgc2Vzc2lvblByb3ZpZGVyIH0sXG4gICAgICAgICAgKSxcbiAgICAgICAgfTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAvLyBOb24tZmF0YWwgXHUyMDE0IGZhbGwgdGhyb3VnaCB0byBzZXF1ZW50aWFsIGV4ZWN1dGlvblxuICAgICAgICBsb2dFcnJvcihcImRpc3BhdGNoXCIsIFwicmVhY3RpdmUgZ3JhcGggZGVyaXZhdGlvbiBmYWlsZWRcIiwgeyBlcnJvcjogKGVyciBhcyBFcnJvcikubWVzc2FnZSB9KTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZXhlY3V0aW5nIFx1MjE5MiBleGVjdXRlLXRhc2sgKHJlY292ZXIgbWlzc2luZyB0YXNrIHBsYW4gXHUyMTkyIHBsYW4tc2xpY2UpXCIsXG4gICAgbWF0Y2g6IGFzeW5jICh7IHN0YXRlLCBtaWQsIG1pZFRpdGxlLCBiYXNlUGF0aCwgc2Vzc2lvbkNvbnRleHRXaW5kb3csIG1vZGVsUmVnaXN0cnksIHNlc3Npb25Qcm92aWRlciB9KSA9PiB7XG4gICAgICBpZiAoc3RhdGUucGhhc2UgIT09IFwiZXhlY3V0aW5nXCIgfHwgIXN0YXRlLmFjdGl2ZVRhc2spIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFzdGF0ZS5hY3RpdmVTbGljZSkgcmV0dXJuIG1pc3NpbmdTbGljZVN0b3AobWlkLCBzdGF0ZS5waGFzZSk7XG4gICAgICBjb25zdCBzaWQgPSBzdGF0ZS5hY3RpdmVTbGljZSEuaWQ7XG4gICAgICBjb25zdCBzVGl0bGUgPSBzdGF0ZS5hY3RpdmVTbGljZSEudGl0bGU7XG4gICAgICBjb25zdCB0aWQgPSBzdGF0ZS5hY3RpdmVUYXNrLmlkO1xuXG4gICAgICAvLyBHdWFyZDogaWYgdGhlIHNsaWNlIHBsYW4gZXhpc3RzIGJ1dCB0aGUgaW5kaXZpZHVhbCB0YXNrIHBsYW4gZmlsZXMgYXJlXG4gICAgICAvLyBtaXNzaW5nLCB0aGUgcGxhbm5lciBjcmVhdGVkIFMjIy1QTEFOLm1kIHdpdGggdGFzayBlbnRyaWVzIGJ1dCBuZXZlclxuICAgICAgLy8gd3JvdGUgdGhlIHRhc2tzLyBkaXJlY3RvcnkgZmlsZXMuIERpc3BhdGNoIHBsYW4tc2xpY2UgdG8gcmVnZW5lcmF0ZVxuICAgICAgLy8gdGhlbSByYXRoZXIgdGhhbiBoYXJkLXN0b3BwaW5nIFx1MjAxNCBmaXhlcyB0aGUgaW5maW5pdGUtbG9vcCBkZXNjcmliZWQgaW5cbiAgICAgIC8vIGlzc3VlICM5MDkuXG4gICAgICBjb25zdCB0YXNrUGxhblBhdGggPSByZXNvbHZlVGFza0ZpbGUoYmFzZVBhdGgsIG1pZCwgc2lkLCB0aWQsIFwiUExBTlwiKTtcbiAgICAgIGlmICghdGFza1BsYW5QYXRoIHx8ICFleGlzdHNTeW5jKHRhc2tQbGFuUGF0aCkpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgICB1bml0VHlwZTogXCJwbGFuLXNsaWNlXCIsXG4gICAgICAgICAgdW5pdElkOiBgJHttaWR9LyR7c2lkfWAsXG4gICAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZFBsYW5TbGljZVByb21wdChcbiAgICAgICAgICAgIG1pZCxcbiAgICAgICAgICAgIG1pZFRpdGxlLFxuICAgICAgICAgICAgc2lkLFxuICAgICAgICAgICAgc1RpdGxlLFxuICAgICAgICAgICAgYmFzZVBhdGgsXG4gICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICB7IHNlc3Npb25Db250ZXh0V2luZG93LCBtb2RlbFJlZ2lzdHJ5LCBzZXNzaW9uUHJvdmlkZXIgfSxcbiAgICAgICAgICApLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJleGVjdXRpbmcgXHUyMTkyIGV4ZWN1dGUtdGFza1wiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgbWlkLCBiYXNlUGF0aCwgc2Vzc2lvbkNvbnRleHRXaW5kb3csIG1vZGVsUmVnaXN0cnksIHNlc3Npb25Qcm92aWRlciB9KSA9PiB7XG4gICAgICBpZiAoc3RhdGUucGhhc2UgIT09IFwiZXhlY3V0aW5nXCIgfHwgIXN0YXRlLmFjdGl2ZVRhc2spIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFzdGF0ZS5hY3RpdmVTbGljZSkgcmV0dXJuIG1pc3NpbmdTbGljZVN0b3AobWlkLCBzdGF0ZS5waGFzZSk7XG4gICAgICBjb25zdCBzaWQgPSBzdGF0ZS5hY3RpdmVTbGljZSEuaWQ7XG4gICAgICBjb25zdCBzVGl0bGUgPSBzdGF0ZS5hY3RpdmVTbGljZSEudGl0bGU7XG4gICAgICBjb25zdCB0aWQgPSBzdGF0ZS5hY3RpdmVUYXNrLmlkO1xuICAgICAgY29uc3QgdFRpdGxlID0gc3RhdGUuYWN0aXZlVGFzay50aXRsZTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIsXG4gICAgICAgIHVuaXRUeXBlOiBcImV4ZWN1dGUtdGFza1wiLFxuICAgICAgICB1bml0SWQ6IGAke21pZH0vJHtzaWR9LyR7dGlkfWAsXG4gICAgICAgIHByb21wdDogYXdhaXQgYnVpbGRFeGVjdXRlVGFza1Byb21wdChcbiAgICAgICAgICBtaWQsXG4gICAgICAgICAgc2lkLFxuICAgICAgICAgIHNUaXRsZSxcbiAgICAgICAgICB0aWQsXG4gICAgICAgICAgdFRpdGxlLFxuICAgICAgICAgIGJhc2VQYXRoLFxuICAgICAgICAgIHsgc2Vzc2lvbkNvbnRleHRXaW5kb3csIG1vZGVsUmVnaXN0cnksIHNlc3Npb25Qcm92aWRlciB9LFxuICAgICAgICApLFxuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2YWxpZGF0aW5nLW1pbGVzdG9uZSBcdTIxOTIgdmFsaWRhdGUtbWlsZXN0b25lXCIsXG4gICAgbWF0Y2g6IGFzeW5jICh7IHN0YXRlLCBtaWQsIG1pZFRpdGxlLCBiYXNlUGF0aCwgcHJlZnMgfSkgPT4ge1xuICAgICAgaWYgKHN0YXRlLnBoYXNlICE9PSBcInZhbGlkYXRpbmctbWlsZXN0b25lXCIpIHJldHVybiBudWxsO1xuXG4gICAgICAvLyBTYWZldHkgZ3VhcmQgKCMxMzY4KTogdmVyaWZ5IGFsbCByb2FkbWFwIHNsaWNlcyBoYXZlIFNVTU1BUlkgZmlsZXMgYmVmb3JlXG4gICAgICAvLyBhbGxvd2luZyBtaWxlc3RvbmUgdmFsaWRhdGlvbi5cbiAgICAgIGNvbnN0IG1pc3NpbmdTbGljZXMgPSBmaW5kTWlzc2luZ1N1bW1hcmllcyhiYXNlUGF0aCwgbWlkKTtcbiAgICAgIGlmIChtaXNzaW5nU2xpY2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgICAgIHJlYXNvbjogYENhbm5vdCB2YWxpZGF0ZSBtaWxlc3RvbmUgJHttaWR9OiBzbGljZXMgJHttaXNzaW5nU2xpY2VzLmpvaW4oXCIsIFwiKX0gYXJlIG1pc3NpbmcgU1VNTUFSWSBmaWxlcy4gVGhlc2Ugc2xpY2VzIG1heSBoYXZlIGJlZW4gc2tpcHBlZC5gLFxuICAgICAgICAgIGxldmVsOiBcImVycm9yXCIsXG4gICAgICAgIH07XG4gICAgICB9XG5cbiAgICAgIC8vICM0NzgxIHBoYXNlIDI6IHRyaXZpYWwtc2NvcGUgbWlsZXN0b25lcyBza2lwIHRoZSBkZWRpY2F0ZWQgdmFsaWRhdGVcbiAgICAgIC8vIHVuaXQgXHUyMDE0IGNvbXBsZXRlLW1pbGVzdG9uZSdzIG93biB2ZXJpZmljYXRpb24gc3RlcHMgKDMvNC81IGluIHRoZVxuICAgICAgLy8gY2xvc2VyIHByb21wdCkgYXJlIHN1ZmZpY2llbnQgcHJvb2YgZm9yIGNvbnRhaW5lZCBkZWxpdmVyYWJsZXMuXG4gICAgICBjb25zdCB0cml2aWFsVmFyaWFudCA9IGF3YWl0IGdldE1pbGVzdG9uZVBpcGVsaW5lVmFyaWFudChtaWQpID09PSBcInRyaXZpYWxcIjtcblxuICAgICAgLy8gU2tpcCBwcmVmZXJlbmNlIE9SIHRyaXZpYWwgc2NvcGU6IHdyaXRlIGEgbWluaW1hbCBwYXNzLXRocm91Z2ggVkFMSURBVElPTiBmaWxlLlxuICAgICAgaWYgKHByZWZzPy5waGFzZXM/LnNraXBfbWlsZXN0b25lX3ZhbGlkYXRpb24gfHwgdHJpdmlhbFZhcmlhbnQpIHtcbiAgICAgICAgY29uc3QgbURpciA9IHJlc29sdmVNaWxlc3RvbmVQYXRoKGJhc2VQYXRoLCBtaWQpO1xuICAgICAgICBpZiAobURpcikge1xuICAgICAgICAgIGlmICghZXhpc3RzU3luYyhtRGlyKSkgbWtkaXJTeW5jKG1EaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgIGNvbnN0IHZhbGlkYXRpb25QYXRoID0gam9pbihcbiAgICAgICAgICAgIG1EaXIsXG4gICAgICAgICAgICBidWlsZE1pbGVzdG9uZUZpbGVOYW1lKG1pZCwgXCJWQUxJREFUSU9OXCIpLFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29uc3Qgc2tpcFNvdXJjZSA9IHRyaXZpYWxWYXJpYW50XG4gICAgICAgICAgICA/IFwidHJpdmlhbC1zY29wZSBwaXBlbGluZSB2YXJpYW50ICgjNDc4MSlcIlxuICAgICAgICAgICAgOiBcImBza2lwX21pbGVzdG9uZV92YWxpZGF0aW9uYCBwcmVmZXJlbmNlXCI7XG4gICAgICAgICAgY29uc3Qgc2tpcFZhbGlkYXRpb25SZWFzb24gPSB0cml2aWFsVmFyaWFudCA/IFwidHJpdmlhbC1zY29wZVwiIDogXCJwcmVmZXJlbmNlXCI7XG4gICAgICAgICAgY29uc3QgY29udGVudCA9IFtcbiAgICAgICAgICAgIFwiLS0tXCIsXG4gICAgICAgICAgICBcInZlcmRpY3Q6IHBhc3NcIixcbiAgICAgICAgICAgIFwic2tpcF92YWxpZGF0aW9uOiB0cnVlXCIsXG4gICAgICAgICAgICBgc2tpcF92YWxpZGF0aW9uX3JlYXNvbjogJHtza2lwVmFsaWRhdGlvblJlYXNvbn1gLFxuICAgICAgICAgICAgXCJyZW1lZGlhdGlvbl9yb3VuZDogMFwiLFxuICAgICAgICAgICAgXCItLS1cIixcbiAgICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgICBcIiMgTWlsZXN0b25lIFZhbGlkYXRpb24gKHNraXBwZWQpXCIsXG4gICAgICAgICAgICBcIlwiLFxuICAgICAgICAgICAgYE1pbGVzdG9uZSB2YWxpZGF0aW9uIHdhcyBza2lwcGVkIHZpYSAke3NraXBTb3VyY2V9LmAsXG4gICAgICAgICAgXS5qb2luKFwiXFxuXCIpO1xuICAgICAgICAgIHdyaXRlRmlsZVN5bmModmFsaWRhdGlvblBhdGgsIGNvbnRlbnQsIFwidXRmLThcIik7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIC8vIERCLWJhY2tlZCBzdGF0ZSBkZXJpdmF0aW9uIGtleXMgb2ZmIGFzc2Vzc21lbnRzLCBub3Qgb25seSB0aGUgZmlsZVxuICAgICAgICAgICAgLy8gcHJvamVjdGlvbi4gUGVyc2lzdCB0aGUgc2tpcHBlZCB2YWxpZGF0aW9uIHRoZXJlIHRvbyBzbyB0aGUgbmV4dFxuICAgICAgICAgICAgLy8gbG9vcCBpdGVyYXRpb24gYWR2YW5jZXMgdG8gY29tcGxldGluZy1taWxlc3RvbmUgaW5zdGVhZCBvZlxuICAgICAgICAgICAgLy8gcmUtZW50ZXJpbmcgdmFsaWRhdGluZy1taWxlc3RvbmUuXG4gICAgICAgICAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgICAgICAgIHRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICAgICAgICAgICAgICBpbnNlcnRBc3Nlc3NtZW50KHtcbiAgICAgICAgICAgICAgICAgIHBhdGg6IHZhbGlkYXRpb25QYXRoLFxuICAgICAgICAgICAgICAgICAgbWlsZXN0b25lSWQ6IG1pZCxcbiAgICAgICAgICAgICAgICAgIHNsaWNlSWQ6IG51bGwsXG4gICAgICAgICAgICAgICAgICB0YXNrSWQ6IG51bGwsXG4gICAgICAgICAgICAgICAgICBzdGF0dXM6IFwicGFzc1wiLFxuICAgICAgICAgICAgICAgICAgc2NvcGU6IFwibWlsZXN0b25lLXZhbGlkYXRpb25cIixcbiAgICAgICAgICAgICAgICAgIGZ1bGxDb250ZW50OiBjb250ZW50LFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGNvbnN0IGdhdGVTbGljZUlkID0gZ2V0TWlsZXN0b25lU2xpY2VzKG1pZClbMF0/LmlkO1xuICAgICAgICAgICAgICAgIGlmIChnYXRlU2xpY2VJZCkge1xuICAgICAgICAgICAgICAgICAgaW5zZXJ0TWlsZXN0b25lVmFsaWRhdGlvbkdhdGVzKFxuICAgICAgICAgICAgICAgICAgICBtaWQsXG4gICAgICAgICAgICAgICAgICAgIGdhdGVTbGljZUlkLFxuICAgICAgICAgICAgICAgICAgICBcInBhc3NcIixcbiAgICAgICAgICAgICAgICAgICAgbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgdW5saW5rU3luYyh2YWxpZGF0aW9uUGF0aCk7XG4gICAgICAgICAgICB9IGNhdGNoICh1bmxpbmtFcnIpIHtcbiAgICAgICAgICAgICAgbG9nV2FybmluZyhcbiAgICAgICAgICAgICAgICBcImRpc3BhdGNoXCIsXG4gICAgICAgICAgICAgICAgYGZhaWxlZCB0byByZW1vdmUgc2tpcHBlZCB2YWxpZGF0aW9uIGZpbGUgYWZ0ZXIgREIgd3JpdGUgZmFpbHVyZSBmb3IgJHttaWR9OiAke3VubGlua0VyciBpbnN0YW5jZW9mIEVycm9yID8gdW5saW5rRXJyLm1lc3NhZ2UgOiBTdHJpbmcodW5saW5rRXJyKX1gLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpbnZhbGlkYXRlQWxsQ2FjaGVzKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgYWN0aW9uOiBcInNraXBcIiB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcImRpc3BhdGNoXCIsXG4gICAgICAgIHVuaXRUeXBlOiBcInZhbGlkYXRlLW1pbGVzdG9uZVwiLFxuICAgICAgICB1bml0SWQ6IG1pZCxcbiAgICAgICAgcHJvbXB0OiBhd2FpdCBidWlsZFZhbGlkYXRlTWlsZXN0b25lUHJvbXB0KG1pZCwgbWlkVGl0bGUsIGJhc2VQYXRoKSxcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiY29tcGxldGluZy1taWxlc3RvbmUgXHUyMTkyIGNvbXBsZXRlLW1pbGVzdG9uZVwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgbWlkLCBtaWRUaXRsZSwgYmFzZVBhdGggfSkgPT4ge1xuICAgICAgaWYgKHN0YXRlLnBoYXNlICE9PSBcImNvbXBsZXRpbmctbWlsZXN0b25lXCIpIHJldHVybiBudWxsO1xuXG4gICAgICAvLyBEZWZlbnNlLWluLWRlcHRoICgjNDMyNCk6IHNraXAgZGlzcGF0Y2ggaWYgdGhlIERCIGFscmVhZHkgbWFya3NcbiAgICAgIC8vIHRoaXMgbWlsZXN0b25lIGFzIGNvbXBsZXRlLiBQcmV2ZW50cyByZS1lbnF1ZXVlIHdoZW4gdGhlIGxlZ2FjeVxuICAgICAgLy8gZmlsZXN5c3RlbSBzdGF0ZS1kZXJpdmF0aW9uIHBhdGggcnVucyAoZS5nLiB0cmFuc2llbnQgREJcbiAgICAgIC8vIHVuYXZhaWxhYmlsaXR5KSBhbmQgcHJvZHVjZXMgYSBzdGFsZSBjb21wbGV0aW5nLW1pbGVzdG9uZSBwaGFzZS5cbiAgICAgIGlmIChpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgY29uc3QgbWlsZXN0b25lID0gZ2V0TWlsZXN0b25lKG1pZCk7XG4gICAgICAgIGlmIChtaWxlc3RvbmUgJiYgaXNDbG9zZWRTdGF0dXMobWlsZXN0b25lLnN0YXR1cykpIHtcbiAgICAgICAgICByZXR1cm4geyBhY3Rpb246IFwic2tpcFwiIH07XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gU2FmZXR5IGd1YXJkICgjMjY3NSwgIzU3NDcpOiBibG9jayBjb21wbGV0aW9uIHdoZW4gVkFMSURBVElPTlxuICAgICAgLy8gdmVyZGljdCBpcyBub24tcGFzc2luZy4gVGhlIHN0YXRlIG1hY2hpbmUgdHJlYXRzIHRoZXNlIHZlcmRpY3RzIGFzXG4gICAgICAvLyB0ZXJtaW5hbCwgYnV0IGNvbXBsZXRpbmctbWlsZXN0b25lIHNob3VsZCBOT1QgcHJvY2VlZCBcdTIwMTQgcmVtZWRpYXRpb25cbiAgICAgIC8vIG9yIGh1bWFuIGF0dGVudGlvbiBpcyBuZWVkZWQuXG4gICAgICBjb25zdCB2YWxpZGF0aW9uRmlsZSA9IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBtaWQsIFwiVkFMSURBVElPTlwiKTtcbiAgICAgIGlmICh2YWxpZGF0aW9uRmlsZSkge1xuICAgICAgICBjb25zdCB2YWxpZGF0aW9uQ29udGVudCA9IGF3YWl0IGxvYWRGaWxlKHZhbGlkYXRpb25GaWxlKTtcbiAgICAgICAgaWYgKHZhbGlkYXRpb25Db250ZW50KSB7XG4gICAgICAgICAgY29uc3QgdmVyZGljdCA9IGV4dHJhY3RWZXJkaWN0KHZhbGlkYXRpb25Db250ZW50KTtcbiAgICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJuZWVkcy1yZW1lZGlhdGlvblwiIHx8IHZlcmRpY3QgPT09IFwibmVlZHMtYXR0ZW50aW9uXCIpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIGFjdGlvbjogXCJzdG9wXCIsXG4gICAgICAgICAgICAgIHJlYXNvbjogYENhbm5vdCBjb21wbGV0ZSBtaWxlc3RvbmUgJHttaWR9OiBWQUxJREFUSU9OIHZlcmRpY3QgaXMgXCIke3ZlcmRpY3R9XCIuIEFkZHJlc3MgdGhlIHZhbGlkYXRpb24gZmluZGluZ3MgYW5kIHJlLXJ1biB2YWxpZGF0aW9uLCBvciB1cGRhdGUgdGhlIHZlcmRpY3QgbWFudWFsbHkuYCxcbiAgICAgICAgICAgICAgbGV2ZWw6IFwid2FybmluZ1wiLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gU2FmZXR5IGd1YXJkICgjMTM2OCk6IHZlcmlmeSBhbGwgcm9hZG1hcCBzbGljZXMgaGF2ZSBTVU1NQVJZIGZpbGVzLlxuICAgICAgY29uc3QgbWlzc2luZ1NsaWNlcyA9IGZpbmRNaXNzaW5nU3VtbWFyaWVzKGJhc2VQYXRoLCBtaWQpO1xuICAgICAgaWYgKG1pc3NpbmdTbGljZXMubGVuZ3RoID4gMCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGFjdGlvbjogXCJzdG9wXCIsXG4gICAgICAgICAgcmVhc29uOiBgQ2Fubm90IGNvbXBsZXRlIG1pbGVzdG9uZSAke21pZH06IHNsaWNlcyAke21pc3NpbmdTbGljZXMuam9pbihcIiwgXCIpfSBhcmUgbWlzc2luZyBTVU1NQVJZIGZpbGVzLiBSdW4gL2dzZCBkb2N0b3IgdG8gZGlhZ25vc2UuYCxcbiAgICAgICAgICBsZXZlbDogXCJlcnJvclwiLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICAvLyBTYWZldHkgZ3VhcmQgKCMxNzAzKTogdmVyaWZ5IHRoZSBtaWxlc3RvbmUgcHJvZHVjZWQgaW1wbGVtZW50YXRpb25cbiAgICAgIC8vIGFydGlmYWN0cyAobm9uLS5nc2QvIGZpbGVzKS4gQSBtaWxlc3RvbmUgd2l0aCBvbmx5IHBsYW4gZmlsZXMgYW5kXG4gICAgICAvLyB6ZXJvIGltcGxlbWVudGF0aW9uIGNvZGUgc2hvdWxkIG5vdCBiZSBtYXJrZWQgY29tcGxldGUuXG4gICAgICBjb25zdCBhcnRpZmFjdENoZWNrID0gaGFzSW1wbGVtZW50YXRpb25BcnRpZmFjdHMoYmFzZVBhdGgsIG1pZCk7XG4gICAgICBpZiAoYXJ0aWZhY3RDaGVjayA9PT0gXCJhYnNlbnRcIikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGFjdGlvbjogXCJzdG9wXCIsXG4gICAgICAgICAgcmVhc29uOiBgQ2Fubm90IGNvbXBsZXRlIG1pbGVzdG9uZSAke21pZH06IG5vIGltcGxlbWVudGF0aW9uIGZpbGVzIGZvdW5kIG91dHNpZGUgLmdzZC8uIFRoZSBtaWxlc3RvbmUgaGFzIG9ubHkgcGxhbiBmaWxlcyBcdTIwMTQgYWN0dWFsIGNvZGUgY2hhbmdlcyBhcmUgcmVxdWlyZWQuYCxcbiAgICAgICAgICBsZXZlbDogXCJlcnJvclwiLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKGFydGlmYWN0Q2hlY2sgPT09IFwidW5rbm93blwiKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJkaXNwYXRjaFwiLCBgSW1wbGVtZW50YXRpb24gYXJ0aWZhY3QgY2hlY2sgaW5jb25jbHVzaXZlIGZvciAke21pZH0gXHUyMDE0IHByb2NlZWRpbmcgKGdpdCBjb250ZXh0IHVuYXZhaWxhYmxlKWApO1xuICAgICAgfVxuXG4gICAgICAvLyBWZXJpZmljYXRpb24gY2xhc3MgY29tcGxpYW5jZTogaWYgb3BlcmF0aW9uYWwgdmVyaWZpY2F0aW9uIHdhcyBwbGFubmVkLFxuICAgICAgLy8gZW5zdXJlIHRoZSB2YWxpZGF0aW9uIG91dHB1dCBkb2N1bWVudHMgaXQgYmVmb3JlIGFsbG93aW5nIGNvbXBsZXRpb24uXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoaXNEYkF2YWlsYWJsZSgpKSB7XG4gICAgICAgICAgY29uc3QgbWlsZXN0b25lID0gZ2V0TWlsZXN0b25lKG1pZCk7XG4gICAgICAgICAgaWYgKG1pbGVzdG9uZT8udmVyaWZpY2F0aW9uX29wZXJhdGlvbmFsICYmXG4gICAgICAgICAgICAgICFpc1ZlcmlmaWNhdGlvbk5vdEFwcGxpY2FibGUobWlsZXN0b25lLnZlcmlmaWNhdGlvbl9vcGVyYXRpb25hbCkpIHtcbiAgICAgICAgICAgIGNvbnN0IHZhbGlkYXRpb25QYXRoID0gcmVzb2x2ZU1pbGVzdG9uZUZpbGUoYmFzZVBhdGgsIG1pZCwgXCJWQUxJREFUSU9OXCIpO1xuICAgICAgICAgICAgaWYgKHZhbGlkYXRpb25QYXRoKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHZhbGlkYXRpb25Db250ZW50ID0gYXdhaXQgbG9hZEZpbGUodmFsaWRhdGlvblBhdGgpO1xuICAgICAgICAgICAgICBpZiAodmFsaWRhdGlvbkNvbnRlbnQpIHtcbiAgICAgICAgICAgICAgICAvLyBBbGxvdyBjb21wbGV0aW9uIHdoZW4gdmFsaWRhdGlvbiB3YXMgaW50ZW50aW9uYWxseSBza2lwcGVkIGJ5XG4gICAgICAgICAgICAgICAgLy8gcHJlZmVyZW5jZS9idWRnZXQgcHJvZmlsZSAoIzMzOTksICMzMzQ0KS5cbiAgICAgICAgICAgICAgICBjb25zdCBza2lwcGVkQnlNYXJrZXIgPSAvXnNraXBfdmFsaWRhdGlvbjpcXHMqdHJ1ZSQvaW0udGVzdCh2YWxpZGF0aW9uQ29udGVudCk7XG4gICAgICAgICAgICAgICAgY29uc3Qgc2tpcHBlZEJ5UHJlZmVyZW5jZSA9IC9za2lwKD86cGVkKT9bXFxzXFwtXSsoPzpieXxwZXJ8ZHVlIHRvKVxccysoPzpwcmVmZXJlbmNlfGJ1ZGdldHxwcm9maWxlKS9pLnRlc3QodmFsaWRhdGlvbkNvbnRlbnQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IHNraXBwZWRCeVRyaXZpYWxWYXJpYW50ID0gL3RyaXZpYWwtc2NvcGUgcGlwZWxpbmUgdmFyaWFudC9pLnRlc3QodmFsaWRhdGlvbkNvbnRlbnQpO1xuXG4gICAgICAgICAgICAgICAgLy8gQWNjZXB0IGVpdGhlciB0aGUgc3RydWN0dXJlZCB0ZW1wbGF0ZSBmb3JtYXQgKHRhYmxlIHdpdGggTUVUL04vQS9TQVRJU0ZJRUQpXG4gICAgICAgICAgICAgICAgLy8gb3IgcHJvc2UgZXZpZGVuY2UgcGF0dGVybnMgdGhlIHZhbGlkYXRpb24gYWdlbnQgbWF5IGVtaXQuXG4gICAgICAgICAgICAgICAgY29uc3Qgc3RydWN0dXJlZE1hdGNoID1cbiAgICAgICAgICAgICAgICAgIHZhbGlkYXRpb25Db250ZW50LmluY2x1ZGVzKFwiT3BlcmF0aW9uYWxcIikgJiZcbiAgICAgICAgICAgICAgICAgICh2YWxpZGF0aW9uQ29udGVudC5pbmNsdWRlcyhcIk1FVFwiKSB8fCB2YWxpZGF0aW9uQ29udGVudC5pbmNsdWRlcyhcIk4vQVwiKSB8fCB2YWxpZGF0aW9uQ29udGVudC5pbmNsdWRlcyhcIlNBVElTRklFRFwiKSk7XG4gICAgICAgICAgICAgICAgY29uc3QgcHJvc2VNYXRjaCA9XG4gICAgICAgICAgICAgICAgICAvW09vXXBlcmF0aW9uYWxbXFxzXFxTXXswLDUwMH0/KD86XHUyNzA1fHBhc3N8dmVyaWZpZWR8Y29uZmlybWVkfG1ldHxjb21wbGV0ZXx0cnVlfHllc3xhZGRyZXNzZWR8Y292ZXJlZHxzYXRpc2ZpZWR8cGFydGlhbGx5fG5cXC9hfG5vdFtcXHMtXSthcHBsaWNhYmxlKS9pLnRlc3QodmFsaWRhdGlvbkNvbnRlbnQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGhhc09wZXJhdGlvbmFsQ2hlY2sgPVxuICAgICAgICAgICAgICAgICAgc2tpcHBlZEJ5TWFya2VyIHx8XG4gICAgICAgICAgICAgICAgICBza2lwcGVkQnlQcmVmZXJlbmNlIHx8XG4gICAgICAgICAgICAgICAgICBza2lwcGVkQnlUcml2aWFsVmFyaWFudCB8fFxuICAgICAgICAgICAgICAgICAgc3RydWN0dXJlZE1hdGNoIHx8XG4gICAgICAgICAgICAgICAgICBwcm9zZU1hdGNoO1xuICAgICAgICAgICAgICAgIGlmICghaGFzT3BlcmF0aW9uYWxDaGVjaykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgYWN0aW9uOiBcInN0b3BcIiBhcyBjb25zdCxcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiBgTWlsZXN0b25lICR7bWlkfSBoYXMgcGxhbm5lZCBvcGVyYXRpb25hbCB2ZXJpZmljYXRpb24gKFwiJHttaWxlc3RvbmUudmVyaWZpY2F0aW9uX29wZXJhdGlvbmFsLnN1YnN0cmluZygwLCAxMDApfVwiKSBidXQgdGhlIHZhbGlkYXRpb24gb3V0cHV0IGRvZXMgbm90IGFkZHJlc3MgaXQuIFJlLXJ1biB2YWxpZGF0aW9uIHdpdGggdmVyaWZpY2F0aW9uIGNsYXNzIGF3YXJlbmVzcywgb3IgdXBkYXRlIHRoZSB2YWxpZGF0aW9uIHRvIGRvY3VtZW50IG9wZXJhdGlvbmFsIGNvbXBsaWFuY2UuYCxcbiAgICAgICAgICAgICAgICAgICAgbGV2ZWw6IFwid2FybmluZ1wiIGFzIGNvbnN0LFxuICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycikgeyAvKiBmYWxsIHRocm91Z2ggXHUyMDE0IGRvbid0IGJsb2NrIG9uIERCIGVycm9ycyAqL1xuICAgICAgICBsb2dXYXJuaW5nKFwiZGlzcGF0Y2hcIiwgYHZlcmlmaWNhdGlvbiBjbGFzcyBjaGVjayBmYWlsZWQ6ICR7ZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpfWApO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBhY3Rpb246IFwiZGlzcGF0Y2hcIixcbiAgICAgICAgdW5pdFR5cGU6IFwiY29tcGxldGUtbWlsZXN0b25lXCIsXG4gICAgICAgIHVuaXRJZDogbWlkLFxuICAgICAgICBwcm9tcHQ6IGF3YWl0IGJ1aWxkQ29tcGxldGVNaWxlc3RvbmVQcm9tcHQobWlkLCBtaWRUaXRsZSwgYmFzZVBhdGgpLFxuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjb21wbGV0ZSBcdTIxOTIgc3RvcFwiLFxuICAgIG1hdGNoOiBhc3luYyAoeyBzdGF0ZSwgbWlkLCBtaWRUaXRsZSwgYmFzZVBhdGggfSkgPT4ge1xuICAgICAgaWYgKHN0YXRlLnBoYXNlICE9PSBcImNvbXBsZXRlXCIpIHJldHVybiBudWxsO1xuICAgICAgaWYgKG1pZCAmJiBpc0RiQXZhaWxhYmxlKCkpIHtcbiAgICAgICAgY29uc3QgbWlsZXN0b25lID0gZ2V0TWlsZXN0b25lKG1pZCk7XG4gICAgICAgIGlmIChtaWxlc3RvbmUgJiYgIWlzQ2xvc2VkU3RhdHVzKG1pbGVzdG9uZS5zdGF0dXMpKSB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGFjdGlvbjogXCJkaXNwYXRjaFwiLFxuICAgICAgICAgICAgdW5pdFR5cGU6IFwiY29tcGxldGUtbWlsZXN0b25lXCIsXG4gICAgICAgICAgICB1bml0SWQ6IG1pZCxcbiAgICAgICAgICAgIHByb21wdDogYXdhaXQgYnVpbGRDb21wbGV0ZU1pbGVzdG9uZVByb21wdChtaWQsIG1pZFRpdGxlLCBiYXNlUGF0aCksXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgYWN0aW9uOiBcInN0b3BcIixcbiAgICAgICAgcmVhc29uOiBcIkFsbCBtaWxlc3RvbmVzIGNvbXBsZXRlLlwiLFxuICAgICAgICBsZXZlbDogXCJpbmZvXCIsXG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG5dO1xuXG5pbXBvcnQgeyBnZXRSZWdpc3RyeSB9IGZyb20gXCIuL3J1bGUtcmVnaXN0cnkuanNcIjtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwIFJlc29sdmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEV2YWx1YXRlIGRpc3BhdGNoIHJ1bGVzIGluIG9yZGVyLiBSZXR1cm5zIHRoZSBmaXJzdCBtYXRjaGluZyBhY3Rpb24sXG4gKiBvciBhIFwic3RvcFwiIGFjdGlvbiBpZiBubyBydWxlIG1hdGNoZXMgKHVuaGFuZGxlZCBwaGFzZSkuXG4gKlxuICogRGVsZWdhdGVzIHRvIHRoZSBSdWxlUmVnaXN0cnkgd2hlbiBpbml0aWFsaXplZDsgZmFsbHMgYmFjayB0byBpbmxpbmVcbiAqIGxvb3Agb3ZlciBESVNQQVRDSF9SVUxFUyBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eSAodGVzdHMgdGhhdCBpbXBvcnRcbiAqIHJlc29sdmVEaXNwYXRjaCBkaXJlY3RseSB3aXRob3V0IHJlZ2lzdHJ5IGluaXRpYWxpemF0aW9uKS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc29sdmVEaXNwYXRjaChcbiAgY3R4OiBEaXNwYXRjaENvbnRleHQsXG4pOiBQcm9taXNlPERpc3BhdGNoQWN0aW9uPiB7XG4gIGNvbnN0IGFjdGl2ZU1pZCA9IGN0eC5zdGF0ZS5hY3RpdmVNaWxlc3RvbmU/LmlkO1xuICBpZiAoYWN0aXZlTWlkICYmIGN0eC5taWQgIT09IGFjdGl2ZU1pZCkge1xuICAgIHJldHVybiB7XG4gICAgICBhY3Rpb246IFwic3RvcFwiLFxuICAgICAgcmVhc29uOlxuICAgICAgICBgRGlzcGF0Y2ggbWlsZXN0b25lIG1pc21hdGNoOiBjb250ZXh0IG1pZCBcIiR7Y3R4Lm1pZH1cIiBkb2VzIG5vdCBtYXRjaCBhY3RpdmUgbWlsZXN0b25lIFwiJHthY3RpdmVNaWR9XCIuIGAgK1xuICAgICAgICBcIlRoaXMgdXN1YWxseSBtZWFucyBhIHByb2plY3QtbGV2ZWwgZGVlcCBzZXR1cCBwc2V1ZG8taWQgbGVha2VkIGludG8gbWlsZXN0b25lIGRpc3BhdGNoOyByZXJ1biAvZ3NkIGF1dG8gYWZ0ZXIgc2V0dXAgc3RhdGUgaXMgcmVjb25jaWxlZC5cIixcbiAgICAgIGxldmVsOiBcIndhcm5pbmdcIixcbiAgICB9O1xuICB9XG5cbiAgLy8gRGVsZWdhdGUgdG8gcmVnaXN0cnkgd2hlbiBhdmFpbGFibGVcbiAgdHJ5IHtcbiAgICBjb25zdCByZWdpc3RyeSA9IGdldFJlZ2lzdHJ5KCk7XG4gICAgcmV0dXJuIGFubm90YXRlQmFja2dyb3VuZGFibGUoYXdhaXQgcmVnaXN0cnkuZXZhbHVhdGVEaXNwYXRjaChjdHgpKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gUmVnaXN0cnkgbm90IGluaXRpYWxpemVkIFx1MjAxNCBmYWxsIGJhY2sgdG8gaW5saW5lIGxvb3BcbiAgICBsb2dXYXJuaW5nKFwiZGlzcGF0Y2hcIiwgYHJlZ2lzdHJ5IGRpc3BhdGNoIGZhaWxlZCwgZmFsbGluZyBiYWNrIHRvIGlubGluZSBydWxlczogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCk7XG4gIH1cblxuICBmb3IgKGNvbnN0IHJ1bGUgb2YgRElTUEFUQ0hfUlVMRVMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydWxlLm1hdGNoKGN0eCk7XG4gICAgaWYgKHJlc3VsdCkge1xuICAgICAgaWYgKHJlc3VsdC5hY3Rpb24gIT09IFwic2tpcFwiKSByZXN1bHQubWF0Y2hlZFJ1bGUgPSBydWxlLm5hbWU7XG4gICAgICByZXR1cm4gYW5ub3RhdGVCYWNrZ3JvdW5kYWJsZShyZXN1bHQpO1xuICAgIH1cbiAgfVxuXG4gIC8vIE5vIHJ1bGUgbWF0Y2hlZCBcdTIwMTQgdW5oYW5kbGVkIHBoYXNlLlxuICAvLyBVc2UgbGV2ZWwgXCJ3YXJuaW5nXCIgc28gdGhlIGxvb3AgcGF1c2VzIChyZXN1bWFibGUpIGluc3RlYWQgb2YgaGFyZC1zdG9wcGluZy5cbiAgLy8gSGFyZC1zdG9wIGhlcmUgd2FzIGNhdXNpbmcgcHJlbWF0dXJlIHRlcm1pbmF0aW9uIGZvciB0cmFuc2llbnQgcGhhc2UgZ2Fwc1xuICAvLyAoZS5nLiBhZnRlciByZWFzc2Vzc21lbnQgbW9kaWZpZXMgdGhlIHJvYWRtYXAgYW5kIHN0YXRlIG5lZWRzIHJlLWRlcml2YXRpb24pLlxuICByZXR1cm4ge1xuICAgIGFjdGlvbjogXCJzdG9wXCIsXG4gICAgcmVhc29uOiBgVW5oYW5kbGVkIHBoYXNlIFwiJHtjdHguc3RhdGUucGhhc2V9XCIgXHUyMDE0IHJ1biAvZ3NkIGRvY3RvciB0byBkaWFnbm9zZS5gLFxuICAgIGxldmVsOiBcIndhcm5pbmdcIixcbiAgICBtYXRjaGVkUnVsZTogXCI8bm8tbWF0Y2g+XCIsXG4gIH07XG59XG5cblxuLyoqIEV4cG9zZWQgZm9yIHRlc3RpbmcgXHUyMDE0IHJldHVybnMgdGhlIHJ1bGUgbmFtZXMgaW4gZXZhbHVhdGlvbiBvcmRlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXREaXNwYXRjaFJ1bGVOYW1lcygpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBESVNQQVRDSF9SVUxFUy5tYXAoKHIpID0+IHIubmFtZSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFrQkEsU0FBUyxVQUFVLGdCQUFnQiwyQkFBMkI7QUFDOUQsU0FBUyxlQUFlLG9CQUFvQixpQkFBaUIscUJBQXFCLGNBQWMsa0JBQWtCLG1CQUFtQjtBQUNySSxTQUFTLHNCQUFzQjtBQUMvQixTQUFTLGdCQUFnQiw4QkFBOEI7QUFFdkQ7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFFQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FFSztBQUNQLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsWUFBWSxXQUFXLGNBQWMsZUFBZSxrQkFBa0I7QUFDL0UsU0FBUyxZQUFZLGdCQUFnQjtBQUNyQyxTQUFTLFlBQVk7QUFDckIsU0FBUyxrQ0FBa0M7QUFDM0M7QUFBQSxFQUNFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLE9BQ0s7QUFDUCxTQUFTLHdDQUF3QztBQUNqRCxTQUFTLHVCQUF1QjtBQUNoQyxTQUFTLG1DQUFtQztBQUM1QyxTQUFTLG1DQUFtQztBQUM1QyxTQUFTLHdCQUF3QixvQ0FBb0M7QUFDckUsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyx5QkFBeUI7QUFDbEMsU0FBUyx5Q0FBeUM7QUFDbEQsU0FBUyx1QkFBdUI7QUFDaEM7QUFBQSxFQUNFO0FBQUEsT0FDSztBQUNQO0FBQUEsRUFDRTtBQUFBLEVBQ0E7QUFBQSxPQUVLO0FBQ1AsU0FBUyw4QkFBOEI7QUFDdkMsU0FBUywyQkFBMkI7QUFDcEMsU0FBUyxzQ0FBc0M7QUEwQy9DLElBQUksc0JBQTJDO0FBQy9DLElBQUksK0JBQTZEO0FBRWpFLFNBQVMscUNBQXFDLE9BQTRDO0FBQ3hGLFNBQU8sYUFBYSxLQUFLLE9BQU8sbUJBQW1CO0FBQ3JEO0FBRU8sU0FBUyw4QkFBOEIsU0FBMEM7QUFDdEYsUUFBTSxXQUFXO0FBQ2pCLHdCQUFzQjtBQUN0QixTQUFPLE1BQU07QUFDWCwwQkFBc0I7QUFBQSxFQUN4QjtBQUNGO0FBRU8sU0FBUyx1Q0FBdUMsU0FBbUQ7QUFDeEcsUUFBTSxXQUFXO0FBQ2pCLGlDQUErQjtBQUMvQixTQUFPLE1BQU07QUFDWCxtQ0FBK0I7QUFBQSxFQUNqQztBQUNGO0FBa0JBLGVBQWUsbUJBQ2IsVUFDQSxLQUNBLFNBQ21FO0FBQ25FLFFBQU0sVUFBVSxpQkFBaUIsVUFBVSxLQUFLLFNBQVMsS0FBSztBQUM5RCxRQUFNLGlCQUFpQixpQkFBaUIsVUFBVSxLQUFLLFNBQVMsWUFBWTtBQUU1RSxRQUFNLGFBQWEsVUFBVSxNQUFNLFNBQVMsT0FBTyxJQUFJO0FBQ3ZELFFBQU0sVUFBVSxhQUFhLGVBQWUsVUFBVSxJQUFJO0FBRTFELFFBQU0sb0JBQW9CLGlCQUFpQixNQUFNLFNBQVMsY0FBYyxJQUFJO0FBQzVFLE1BQUksbUJBQW1CO0FBQ3JCLFVBQU0sb0JBQW9CLGVBQWUsaUJBQWlCO0FBQzFELFFBQUksbUJBQW1CO0FBQ3JCLGFBQU87QUFBQSxRQUNMLFNBQVM7QUFBQSxRQUNULFNBQVMsV0FBVyxlQUFlLGlCQUFpQjtBQUFBLE1BQ3REO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxNQUFJLFlBQVk7QUFDZCxVQUFNLG1CQUFtQixlQUFlLFVBQVU7QUFDbEQsUUFBSSxrQkFBa0I7QUFDcEIsYUFBTyxFQUFFLFNBQVMsa0JBQWtCLFFBQVE7QUFBQSxJQUM5QztBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQ1Q7QUFZTyxTQUFTLGlCQUFpQixPQUFtQyxVQUFpQztBQUNuRyxTQUFPLDZCQUE2QixPQUFPLFFBQVE7QUFDckQ7QUFFTyxTQUFTLG9CQUFvQixPQUFtQyxVQUEyQjtBQUNoRyxRQUFNLE9BQU8saUJBQWlCLE9BQU8sUUFBUTtBQUM3QyxTQUFPLEtBQUssV0FBVyxhQUFhLEtBQUssV0FBVztBQUN0RDtBQUVPLFNBQVMsMEJBQ2QsT0FDQSxPQUNBLFVBQ0EsVUFBMkMsQ0FBQyxHQUNuQztBQUNULE1BQUksUUFBUSxzQkFBc0IsS0FBTSxRQUFPO0FBQy9DLE1BQ0UsTUFBTSxVQUFVLGtCQUNoQixNQUFNLFVBQVUsc0JBQ2hCLE1BQU0sVUFBVSxZQUNoQjtBQUNBLFdBQU87QUFBQSxFQUNUO0FBQ0EsU0FBTyxvQkFBb0IsT0FBTyxRQUFRO0FBQzVDO0FBRUEsU0FBUyxpQkFBaUIsS0FBYSxPQUErQjtBQUNwRSxTQUFPO0FBQUEsSUFDTCxRQUFRO0FBQUEsSUFDUixRQUFRLEdBQUcsR0FBRyxZQUFZLEtBQUs7QUFBQSxJQUMvQixPQUFPO0FBQUEsRUFDVDtBQUNGO0FBRUEsU0FBUyw0QkFBNEIsT0FBaUIsS0FBc0I7QUFDMUUsU0FBTyxNQUFNLFNBQVM7QUFBQSxJQUFLLENBQUMsY0FDMUIsVUFBVSxPQUFPLE9BQU8sVUFBVSxXQUFXO0FBQUEsRUFDL0M7QUFDRjtBQVNBLFNBQVMscUJBQXFCLFVBQWtCLEtBQXVCO0FBQ3JFLE1BQUksQ0FBQyxjQUFjLEVBQUcsUUFBTyxDQUFDO0FBQzlCLFFBQU0sU0FBUyxtQkFBbUIsR0FBRztBQUVyQyxRQUFNLGtCQUFrQixvQkFBSSxJQUFJLENBQUMsV0FBVyxZQUFZLE1BQU0sQ0FBQztBQUMvRCxTQUFPLE9BQ0osT0FBTyxPQUFLLENBQUMsZ0JBQWdCLElBQUksRUFBRSxNQUFNLENBQUMsRUFDMUMsT0FBTyxPQUFLO0FBQ1gsVUFBTSxjQUFjLGlCQUFpQixVQUFVLEtBQUssRUFBRSxJQUFJLFNBQVM7QUFDbkUsV0FBTyxDQUFDLGVBQWUsQ0FBQyxXQUFXLFdBQVc7QUFBQSxFQUNoRCxDQUFDLEVBQ0EsSUFBSSxPQUFLLEVBQUUsRUFBRTtBQUNsQjtBQUlBLE1BQU0sdUJBQXVCO0FBTTdCLFNBQVMsaUJBQWlCLFVBQTBCO0FBQ2xELFNBQU8sS0FBSyxRQUFRLFFBQVEsR0FBRyxXQUFXLG9CQUFvQjtBQUNoRTtBQUVPLFNBQVMsZ0JBQWdCLFVBQTBCO0FBQ3hELE1BQUk7QUFDRixVQUFNLE9BQU8sS0FBSyxNQUFNLGFBQWEsaUJBQWlCLFFBQVEsR0FBRyxPQUFPLENBQUM7QUFDekUsV0FBTyxPQUFPLEtBQUssVUFBVSxXQUFXLEtBQUssUUFBUTtBQUFBLEVBQ3ZELFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBRU8sU0FBUyxnQkFBZ0IsVUFBa0IsT0FBcUI7QUFDckUsUUFBTSxXQUFXLGlCQUFpQixRQUFRO0FBQzFDLFlBQVUsS0FBSyxRQUFRLFFBQVEsR0FBRyxTQUFTLEdBQUcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUNqRSxnQkFBYyxVQUFVLEtBQUssVUFBVSxFQUFFLE9BQU8sWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWSxFQUFFLENBQUMsSUFBSSxJQUFJO0FBQy9GO0FBS0EsTUFBTSxtQkFBbUI7QUFFekIsU0FBUyxhQUFhLFVBQWtCLEtBQWEsS0FBcUI7QUFDeEUsU0FBTyxLQUFLLFFBQVEsUUFBUSxHQUFHLFdBQVcsYUFBYSxHQUFHLElBQUksR0FBRyxPQUFPO0FBQzFFO0FBRU8sU0FBUyxZQUFZLFVBQWtCLEtBQWEsS0FBcUI7QUFDOUUsTUFBSTtBQUNGLFVBQU0sT0FBTyxLQUFLLE1BQU0sYUFBYSxhQUFhLFVBQVUsS0FBSyxHQUFHLEdBQUcsT0FBTyxDQUFDO0FBQy9FLFdBQU8sT0FBTyxLQUFLLFVBQVUsV0FBVyxLQUFLLFFBQVE7QUFBQSxFQUN2RCxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVPLFNBQVMsa0JBQWtCLFVBQWtCLEtBQWEsS0FBcUI7QUFDcEYsUUFBTSxRQUFRLFlBQVksVUFBVSxLQUFLLEdBQUcsSUFBSTtBQUNoRCxRQUFNLFdBQVcsYUFBYSxVQUFVLEtBQUssR0FBRztBQUNoRCxZQUFVLEtBQUssUUFBUSxRQUFRLEdBQUcsU0FBUyxHQUFHLEVBQUUsV0FBVyxLQUFLLENBQUM7QUFDakUsZ0JBQWMsVUFBVSxLQUFLLFVBQVUsRUFBRSxPQUFPLFlBQVcsb0JBQUksS0FBSyxHQUFFLFlBQVksRUFBRSxDQUFDLElBQUksSUFBSTtBQUM3RixTQUFPO0FBQ1Q7QUFXTyxTQUFTLDRCQUE0QixPQUF3QjtBQUNsRSxRQUFNLEtBQUssU0FBUyxJQUFJLFlBQVksRUFBRSxLQUFLLEVBQUUsUUFBUSxXQUFXLEVBQUU7QUFDbEUsTUFBSSxDQUFDLEtBQUssTUFBTSxPQUFRLFFBQU87QUFDL0IsU0FBTyw4SEFBOEgsS0FBSyxDQUFDO0FBQzdJO0FBSU8sTUFBTSxpQkFBaUM7QUFBQSxFQUM1QztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQU1FLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sSUFBSSxNQUFNO0FBQy9CLFVBQUksTUFBTSxVQUFVLGtCQUFtQixRQUFPO0FBQzlDLFVBQUksQ0FBQyxNQUFNLFlBQWEsUUFBTyxpQkFBaUIsS0FBSyxNQUFNLEtBQUs7QUFDaEUsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsUUFDRSxNQUFNLGNBQ04sR0FBRyxHQUFHO0FBQUEsUUFDUixPQUFPO0FBQUEsTUFDVDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsS0FBSyxVQUFVLE9BQU8sVUFBVSxRQUFRLE1BQU07QUFDNUQsWUFBTSxtQkFBbUIsTUFBTSxvQkFBb0IsUUFBUTtBQUMzRCxVQUFJLGlCQUFpQixXQUFXLEVBQUcsUUFBTztBQUMxQyxZQUFNLFFBQVEsZ0JBQWdCLFFBQVE7QUFDdEMsVUFBSSxTQUFTLHNCQUFzQjtBQUNqQyxjQUFNLEVBQUUsb0JBQW9CLElBQUksTUFBTSxPQUFPLFlBQVk7QUFDekQsY0FBTSxvQkFBb0IsUUFBUTtBQUNsQyx3QkFBZ0IsVUFBVSxDQUFDO0FBQzNCLGVBQU87QUFBQSxNQUNUO0FBQ0Esc0JBQWdCLFVBQVUsUUFBUSxDQUFDO0FBQ25DLFlBQU0sU0FBUyxNQUFNLGNBQWMsR0FBRyxHQUFHLElBQUksTUFBTSxZQUFZLEVBQUUsS0FBSztBQUN0RSxhQUFPO0FBQUEsUUFDTCxRQUFRO0FBQUEsUUFDUixVQUFVO0FBQUEsUUFDVjtBQUFBLFFBQ0EsUUFBUSxNQUFNO0FBQUEsVUFDWjtBQUFBLFVBQ0E7QUFBQSxVQUNBLE1BQU07QUFBQSxVQUNOO0FBQUEsVUFDQTtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFhRSxNQUFNO0FBQUEsSUFDTixPQUFPLE9BQU8sRUFBRSxPQUFPLEtBQUssVUFBVSxVQUFVLE9BQU8sNkJBQTZCLE1BQU07QUFDeEYsVUFBSSxDQUFDLHVCQUF1QixJQUFJLE1BQU0sS0FBSyxFQUFHLFFBQU87QUFDckQsVUFBSSxDQUFDLGdCQUFnQixLQUFLLEdBQUcsRUFBRyxRQUFPO0FBQ3ZDLFVBQUksNEJBQTRCLE9BQU8sR0FBRyxFQUFHLFFBQU87QUFHcEQsVUFBSSw2QkFBNkIsVUFBVSxHQUFHLEVBQUcsUUFBTztBQUt4RCxVQUFJLHFDQUFxQyxLQUFLLEdBQUc7QUFDL0MsMEJBQWtCLEtBQUssUUFBUTtBQUFBLE1BQ2pDO0FBQ0EsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsUUFBUTtBQUFBLFFBQ1IsUUFBUSxNQUFNO0FBQUEsVUFDWjtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLE9BQU8sRUFBRSxPQUFPLEtBQUssVUFBVSxTQUFTLE1BQU07QUFDbkQsVUFBSSxNQUFNLFVBQVUsY0FBZSxRQUFPO0FBQzFDLFVBQUksQ0FBQyxNQUFNLFlBQWEsUUFBTyxpQkFBaUIsS0FBSyxNQUFNLEtBQUs7QUFDaEUsWUFBTSxNQUFNLE1BQU0sWUFBYTtBQUMvQixZQUFNLFNBQVMsTUFBTSxZQUFhO0FBQ2xDLGFBQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFFBQVEsR0FBRyxHQUFHLElBQUksR0FBRztBQUFBLFFBQ3JCLFFBQVEsTUFBTTtBQUFBLFVBQ1o7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sS0FBSyxVQUFVLE1BQU0sTUFBTTtBQUNoRCxZQUFNLGNBQWMsTUFBTSxpQkFBaUIsVUFBVSxLQUFLLE9BQU8sS0FBSztBQUN0RSxVQUFJLENBQUMsWUFBYSxRQUFPO0FBQ3pCLFlBQU0sRUFBRSxTQUFTLFFBQVEsSUFBSTtBQUc3QixZQUFNLFdBQVcsa0JBQWtCLFVBQVUsS0FBSyxPQUFPO0FBQ3pELFVBQUksV0FBVyxrQkFBa0I7QUFDL0IsZUFBTztBQUFBLFVBQ0wsUUFBUTtBQUFBLFVBQ1IsUUFBUSxlQUFlLEdBQUcsSUFBSSxPQUFPLHdCQUF3QixXQUFXLENBQUM7QUFBQSxVQUN6RSxPQUFPO0FBQUEsUUFDVDtBQUFBLE1BQ0Y7QUFDQSxZQUFNLFVBQVUsaUJBQWlCLFVBQVUsS0FBSyxTQUFTLEtBQUs7QUFDOUQsWUFBTSxhQUFhLE1BQU0sU0FBUyxPQUFPO0FBQ3pDLGFBQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFFBQVEsR0FBRyxHQUFHLElBQUksT0FBTztBQUFBLFFBQ3pCLFFBQVEsTUFBTTtBQUFBLFVBQ1o7QUFBQSxVQUNBO0FBQUEsVUFDQSxhQUFhLFVBQVUsS0FBSyxTQUFTLEtBQUs7QUFBQSxVQUMxQyxjQUFjO0FBQUEsVUFDZDtBQUFBLFFBQ0Y7QUFBQSxRQUNBLG9CQUFvQixDQUFDLFFBQVEsSUFBSSxnQkFBZ0IsWUFBWSxxQkFBcUIsWUFBWSx3QkFBd0IsWUFBWTtBQUFBLE1BQ3BJO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLE9BQU8sRUFBRSxLQUFLLFVBQVUsTUFBTSxNQUFNO0FBRXpDLFVBQUksQ0FBQyxPQUFPLGFBQWMsUUFBTztBQUdqQyxVQUFJO0FBQ0osVUFBSSxjQUFjLEdBQUc7QUFDbkIseUJBQWlCLG1CQUFtQixHQUFHLEVBQ3BDLE9BQU8sT0FBSyxlQUFlLEVBQUUsTUFBTSxDQUFDLEVBQ3BDLElBQUksT0FBSyxFQUFFLEVBQUU7QUFBQSxNQUNsQixPQUFPO0FBR0wsY0FBTSxjQUFjLHFCQUFxQixVQUFVLEtBQUssU0FBUztBQUNqRSxjQUFNLGlCQUFpQixjQUFjLE1BQU0sU0FBUyxXQUFXLElBQUk7QUFDbkUsWUFBSSxDQUFDLGVBQWdCLFFBQU87QUFDNUIsY0FBTSxVQUFVLGFBQWEsY0FBYztBQUMzQyx5QkFBaUIsUUFBUSxPQUFPLE9BQU8sT0FBSyxFQUFFLElBQUksRUFBRSxJQUFJLE9BQUssRUFBRSxFQUFFO0FBQUEsTUFDbkU7QUFFQSxpQkFBVyxXQUFXLGdCQUFnQjtBQUNwQyxjQUFNLFNBQVMsTUFBTSxtQkFBbUIsVUFBVSxLQUFLLE9BQU87QUFDOUQsWUFBSSxDQUFDLE9BQVE7QUFDYixjQUFNLEVBQUUsU0FBUyxRQUFRLElBQUk7QUFFN0IsWUFBSSxDQUFDLHVCQUF1QixTQUFTLE9BQU8sR0FBRztBQUM3QyxpQkFBTztBQUFBLFlBQ0wsUUFBUTtBQUFBLFlBQ1IsUUFBUSxtQkFBbUIsT0FBTyxRQUFRLE9BQU87QUFBQTtBQUFBLFlBQ2pELE9BQU87QUFBQSxVQUNUO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFDQSxhQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLE9BQU8sRUFBRSxPQUFPLEtBQUssVUFBVSxVQUFVLE1BQU0sTUFBTTtBQUMxRCxVQUFJLE9BQU8sUUFBUSxjQUFlLFFBQU87QUFPekMsWUFBTSxrQkFBa0IsT0FBTyxRQUFRLHdCQUF3QjtBQUMvRCxVQUFJLENBQUMsZ0JBQWlCLFFBQU87QUFDN0IsWUFBTSxnQkFBZ0IsTUFBTSxvQkFBb0IsVUFBVSxLQUFLLEtBQUs7QUFDcEUsVUFBSSxDQUFDLGNBQWUsUUFBTztBQUMzQixhQUFPO0FBQUEsUUFDTCxRQUFRO0FBQUEsUUFDUixVQUFVO0FBQUEsUUFDVixRQUFRLEdBQUcsR0FBRyxJQUFJLGNBQWMsT0FBTztBQUFBLFFBQ3ZDLFFBQVEsTUFBTTtBQUFBLFVBQ1o7QUFBQSxVQUNBO0FBQUEsVUFDQSxjQUFjO0FBQUEsVUFDZDtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLE9BQU8sRUFBRSxPQUFPLEtBQUssVUFBVSxVQUFVLE9BQU8sNkJBQTZCLE1BQU07QUFDeEYsVUFBSSxNQUFNLFVBQVUsbUJBQW9CLFFBQU87QUFNL0MsVUFBSSxvQkFBb0IsT0FBTyxRQUFRLEVBQUcsUUFBTztBQUdqRCxVQUFJLHFDQUFxQyxLQUFLLEdBQUc7QUFDL0MsMEJBQWtCLEtBQUssUUFBUTtBQUFBLE1BQ2pDO0FBQ0EsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsUUFBUTtBQUFBLFFBQ1IsUUFBUSxNQUFNO0FBQUEsVUFDWjtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUtFLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sVUFBVSxNQUFNLE1BQU07QUFDM0MsVUFBSSxPQUFPLG1CQUFtQixPQUFRLFFBQU87QUFDN0MsVUFBSSxNQUFNLFVBQVUsa0JBQWtCLE1BQU0sVUFBVSxtQkFBb0IsUUFBTztBQUNqRixVQUFJLHdCQUF3QixRQUFRLEVBQUcsUUFBTztBQUM5Qyx3Q0FBa0MsUUFBUTtBQUMxQyxhQUFPO0FBQUEsSUFDVDtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUtFLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sVUFBVSxPQUFPLDZCQUE2QixNQUFNO0FBQ3pFLFVBQUksT0FBTyxtQkFBbUIsT0FBUSxRQUFPO0FBQzdDLFVBQUksTUFBTSxVQUFVLGtCQUFrQixNQUFNLFVBQVUsbUJBQW9CLFFBQU87QUFDakYsWUFBTSxjQUFjLEtBQUssUUFBUSxRQUFRLEdBQUcsWUFBWTtBQUN4RCxVQUFJLFdBQVcsV0FBVyxLQUFLLGlCQUFpQixhQUFhLFNBQVMsRUFBRSxHQUFJLFFBQU87QUFDbkYsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsUUFBUTtBQUFBLFFBQ1IsUUFBUSxNQUFNLDBCQUEwQixVQUFVLDRCQUE0QjtBQUFBLE1BQ2hGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQUtFLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sVUFBVSxPQUFPLDZCQUE2QixNQUFNO0FBQ3pFLFVBQUksT0FBTyxtQkFBbUIsT0FBUSxRQUFPO0FBQzdDLFVBQUksTUFBTSxVQUFVLGtCQUFrQixNQUFNLFVBQVUsbUJBQW9CLFFBQU87QUFDakYsWUFBTSxjQUFjLEtBQUssUUFBUSxRQUFRLEdBQUcsWUFBWTtBQUN4RCxVQUFJLENBQUMsV0FBVyxXQUFXLEtBQUssQ0FBQyxpQkFBaUIsYUFBYSxTQUFTLEVBQUUsR0FBSSxRQUFPO0FBQ3JGLFlBQU0sbUJBQW1CLEtBQUssUUFBUSxRQUFRLEdBQUcsaUJBQWlCO0FBQ2xFLFVBQUksV0FBVyxnQkFBZ0IsS0FBSyxpQkFBaUIsa0JBQWtCLGNBQWMsRUFBRSxHQUFJLFFBQU87QUFDbEcsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsUUFBUTtBQUFBLFFBQ1IsUUFBUSxNQUFNLCtCQUErQixVQUFVLDRCQUE0QjtBQUFBLE1BQ3JGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFPRSxNQUFNO0FBQUEsSUFDTixPQUFPLE9BQU8sRUFBRSxPQUFPLFVBQVUsT0FBTyw2QkFBNkIsTUFBTTtBQUN6RSxVQUFJLE9BQU8sbUJBQW1CLE9BQVEsUUFBTztBQUM3QyxVQUFJLE1BQU0sVUFBVSxrQkFBa0IsTUFBTSxVQUFVLG1CQUFvQixRQUFPO0FBQ2pGLFlBQU0sT0FBTyw2QkFBNkIsT0FBTyxRQUFRO0FBQ3pELFVBQUksS0FBSyxXQUFXLGFBQWEsS0FBSyxVQUFVLG9CQUFxQixRQUFPO0FBQzVFLGFBQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFFBQVE7QUFBQSxRQUNSLFFBQVEsTUFBTSw0QkFBNEIsVUFBVSw0QkFBNEI7QUFBQSxNQUNsRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBT0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsT0FBTyxVQUFVLE9BQU8sNkJBQTZCLE1BQU07QUFDekUsVUFBSSxPQUFPLG1CQUFtQixPQUFRLFFBQU87QUFDN0MsVUFBSSxNQUFNLFVBQVUsa0JBQWtCLE1BQU0sVUFBVSxtQkFBb0IsUUFBTztBQUNqRixZQUFNLE9BQU8sNkJBQTZCLE9BQU8sUUFBUTtBQUN6RCxVQUFJLEtBQUssV0FBVyxhQUFhLEtBQUssVUFBVSxvQkFBb0I7QUFDbEUsZUFBTztBQUFBLFVBQ0wsUUFBUTtBQUFBLFVBQ1IsUUFBUSxLQUFLO0FBQUEsVUFDYixPQUFPO0FBQUEsUUFDVDtBQUFBLE1BQ0Y7QUFDQSxVQUFJLEtBQUssV0FBVyxhQUFhLEtBQUssVUFBVSxtQkFBb0IsUUFBTztBQUczRSxZQUFNLGFBQWEsS0FBSyxRQUFRLFFBQVEsR0FBRyxTQUFTO0FBQ3BELFlBQU0scUJBQXFCLEtBQUssWUFBWSxnQ0FBZ0M7QUFDNUUsWUFBTSx1QkFBdUI7QUFBQSxRQUMzQixRQUFRO0FBQUEsUUFDUixRQUNFO0FBQUEsUUFDRixPQUFPO0FBQUEsTUFDVDtBQUNBLFVBQUksV0FBVyxrQkFBa0IsRUFBRyxRQUFPO0FBQzNDLGdCQUFVLFlBQVksRUFBRSxXQUFXLEtBQUssQ0FBQztBQUN6QyxVQUFJO0FBQ0Y7QUFBQSxVQUNFO0FBQUEsVUFDQSxLQUFLLFVBQVUsRUFBRSxVQUFTLG9CQUFJLEtBQUssR0FBRSxZQUFZLEVBQUUsQ0FBQyxJQUFJO0FBQUEsVUFDeEQsRUFBRSxVQUFVLFNBQVMsTUFBTSxLQUFLO0FBQUEsUUFDbEM7QUFBQSxNQUNGLFNBQVMsS0FBSztBQUNaLFlBQUksT0FBTyxPQUFPLFFBQVEsWUFBWSxVQUFVLE9BQU8sSUFBSSxTQUFTLFVBQVU7QUFDNUUsaUJBQU87QUFBQSxRQUNUO0FBQ0EsY0FBTTtBQUFBLE1BQ1I7QUFDQSxVQUFJO0FBQ0YsY0FBTSxTQUFTLE1BQU0sNkJBQTZCLFVBQVUsNEJBQTRCO0FBQ3hGLGVBQU87QUFBQSxVQUNMLFFBQVE7QUFBQSxVQUNSLFVBQVU7QUFBQSxVQUNWLFFBQVE7QUFBQSxVQUNSO0FBQUEsUUFDRjtBQUFBLE1BQ0YsU0FBUyxLQUFLO0FBQ1osWUFBSTtBQUNGLGNBQUksV0FBVyxrQkFBa0IsRUFBRyxZQUFXLGtCQUFrQjtBQUFBLFFBQ25FLFNBQVMsWUFBWTtBQUNuQjtBQUFBLFlBQ0U7QUFBQSxZQUNBLG1GQUFtRixzQkFBc0IsUUFBUSxXQUFXLFVBQVUsT0FBTyxVQUFVLENBQUM7QUFBQSxVQUMxSjtBQUFBLFFBQ0Y7QUFDQSxjQUFNO0FBQUEsTUFDUjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsT0FBTyxLQUFLLFVBQVUsVUFBVSxPQUFPLDZCQUE2QixNQUFNO0FBQ3hGLFVBQUksTUFBTSxVQUFVLGVBQWdCLFFBQU87QUFDM0MsVUFBSSw0QkFBNEIsT0FBTyxHQUFHLEVBQUcsUUFBTztBQUNwRCxZQUFNLGNBQWMscUJBQXFCLFVBQVUsS0FBSyxTQUFTO0FBQ2pFLFlBQU0sYUFBYSxDQUFDLEVBQUUsZUFBZ0IsTUFBTSxTQUFTLFdBQVc7QUFDaEUsVUFBSSxXQUFZLFFBQU87QUFDdkIsVUFBSSxPQUFPLG1CQUFtQixPQUFRLFFBQU87QUFHN0MsVUFBSSxxQ0FBcUMsS0FBSyxHQUFHO0FBQy9DLDBCQUFrQixLQUFLLFFBQVE7QUFBQSxNQUNqQztBQUNBLGFBQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFFBQVE7QUFBQSxRQUNSLFFBQVEsTUFBTTtBQUFBLFVBQ1o7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsT0FBTyxLQUFLLFVBQVUsVUFBVSxNQUFNLE1BQU07QUFDMUQsVUFBSSxNQUFNLFVBQVUsZUFBZ0IsUUFBTztBQUUzQyxVQUFJLE9BQU8sUUFBUSxjQUFlLFFBQU87QUFDekMsWUFBTSxlQUFlLHFCQUFxQixVQUFVLEtBQUssVUFBVTtBQUNuRSxVQUFJLGFBQWMsUUFBTztBQUN6QixhQUFPO0FBQUEsUUFDTCxRQUFRO0FBQUEsUUFDUixVQUFVO0FBQUEsUUFDVixRQUFRO0FBQUEsUUFDUixRQUFRLE1BQU0sNkJBQTZCLEtBQUssVUFBVSxRQUFRO0FBQUEsTUFDcEU7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sS0FBSyxVQUFVLFNBQVMsTUFBTTtBQUNuRCxVQUFJLE1BQU0sVUFBVSxlQUFnQixRQUFPO0FBQzNDLGFBQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFFBQVE7QUFBQSxRQUNSLFFBQVEsTUFBTSx5QkFBeUIsS0FBSyxVQUFVLFFBQVE7QUFBQSxNQUNoRTtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsT0FBTyxLQUFLLFVBQVUsTUFBTSxNQUFNO0FBQ2hELFVBQUksTUFBTSxVQUFVLFdBQVksUUFBTztBQUN2QyxVQUFJLENBQUMsT0FBTyxRQUFRLHlCQUEwQixRQUFPO0FBQ3JELFVBQUksQ0FBQyxNQUFNLFlBQWEsUUFBTztBQU0vQixZQUFNLG1CQUFtQixpQkFBaUIsVUFBVSxLQUFLLE1BQU0sWUFBWSxJQUFJLFNBQVM7QUFDeEYsVUFBSSxvQkFBb0IsV0FBVyxnQkFBZ0IsRUFBRyxRQUFPO0FBQzdELGFBQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLFFBQVEsU0FBUyxNQUFNLFlBQVksRUFBRTtBQUFBLFFBQ3JDLE9BQU87QUFBQSxNQUNUO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUE7QUFBQTtBQUFBLElBR0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsT0FBTyxLQUFLLFVBQVUsVUFBVSxNQUFNLE1BQU07QUFDMUQsVUFBSSxNQUFNLFVBQVUsV0FBWSxRQUFPO0FBQ3ZDLFVBQUksT0FBTyxRQUFRLGlCQUFpQixPQUFPLFFBQVEsb0JBQXFCLFFBQU87QUFLL0UsVUFBSSxNQUFNLDRCQUE0QixHQUFHLE1BQU0sVUFBVyxRQUFPO0FBR2pFLFlBQU0sY0FBYyxxQkFBcUIsVUFBVSxLQUFLLFNBQVM7QUFDakUsWUFBTSxpQkFBaUIsY0FBYyxNQUFNLFNBQVMsV0FBVyxJQUFJO0FBQ25FLFVBQUksQ0FBQyxlQUFnQixRQUFPO0FBQzVCLFlBQU0sVUFBVSxhQUFhLGNBQWM7QUFHM0MsWUFBTSx3QkFBd0IscUJBQXFCLFVBQVUsS0FBSyxVQUFVO0FBQzVFLFlBQU0sc0JBQTRELENBQUM7QUFFbkUsaUJBQVcsU0FBUyxRQUFRLFFBQVE7QUFDbEMsWUFBSSxNQUFNLEtBQU07QUFFaEIsWUFBSSx5QkFBeUIsTUFBTSxPQUFPLE1BQU87QUFFakQsWUFBSSxpQkFBaUIsVUFBVSxLQUFLLE1BQU0sSUFBSSxVQUFVLEVBQUc7QUFFM0QsY0FBTSxnQkFBZ0IsTUFBTSxXQUFXLENBQUMsR0FBRztBQUFBLFVBQU0sQ0FBQyxVQUNoRCxDQUFDLENBQUMsaUJBQWlCLFVBQVUsS0FBSyxPQUFPLFNBQVM7QUFBQSxRQUNwRDtBQUNBLFlBQUksQ0FBQyxhQUFjO0FBRW5CLDRCQUFvQixLQUFLLEVBQUUsSUFBSSxNQUFNLElBQUksT0FBTyxNQUFNLE1BQU0sQ0FBQztBQUFBLE1BQy9EO0FBR0EsVUFBSSxvQkFBb0IsU0FBUyxFQUFHLFFBQU87QUFLM0MsWUFBTSxrQkFBa0IscUJBQXFCLFVBQVUsS0FBSyxrQkFBa0I7QUFDOUUsVUFBSSxnQkFBaUIsUUFBTztBQUU1QixhQUFPO0FBQUEsUUFDTCxRQUFRO0FBQUEsUUFDUixVQUFVO0FBQUEsUUFDVixRQUFRLEdBQUcsR0FBRztBQUFBLFFBQ2QsUUFBUSxNQUFNO0FBQUEsVUFDWjtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0EsaUNBQWlDLFVBQVUsR0FBRztBQUFBLFFBQ2hEO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsT0FBTyxLQUFLLFVBQVUsVUFBVSxNQUFNLE1BQU07QUFDMUQsVUFBSSxNQUFNLFVBQVUsV0FBWSxRQUFPO0FBRXZDLFVBQUksT0FBTyxRQUFRLGlCQUFpQixPQUFPLFFBQVE7QUFDakQsZUFBTztBQUVULFVBQUksTUFBTSw0QkFBNEIsR0FBRyxNQUFNLFVBQVcsUUFBTztBQUNqRSxVQUFJLENBQUMsTUFBTSxZQUFhLFFBQU8saUJBQWlCLEtBQUssTUFBTSxLQUFLO0FBQ2hFLFlBQU0sTUFBTSxNQUFNLFlBQWE7QUFDL0IsWUFBTSxTQUFTLE1BQU0sWUFBYTtBQUNsQyxZQUFNLGVBQWUsaUJBQWlCLFVBQVUsS0FBSyxLQUFLLFVBQVU7QUFDcEUsVUFBSSxhQUFjLFFBQU87QUFHekIsWUFBTSx3QkFBd0I7QUFBQSxRQUM1QjtBQUFBLFFBQ0E7QUFBQSxRQUNBO0FBQUEsTUFDRjtBQUNBLFVBQUkseUJBQXlCLFFBQVEsTUFBTyxRQUFPO0FBQ25ELGFBQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFFBQVEsR0FBRyxHQUFHLElBQUksR0FBRztBQUFBLFFBQ3JCLFFBQVEsTUFBTTtBQUFBLFVBQ1o7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQVVFLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sS0FBSyxVQUFVLFVBQVUsT0FBTyxzQkFBc0IsZUFBZSxnQkFBZ0IsTUFBTTtBQUNoSCxVQUFJLE1BQU0sVUFBVSxXQUFZLFFBQU87QUFDdkMsVUFBSSxDQUFDLE1BQU0sWUFBYSxRQUFPLGlCQUFpQixLQUFLLE1BQU0sS0FBSztBQUNoRSxZQUFNLE1BQU0sTUFBTSxZQUFZO0FBQzlCLFlBQU0sU0FBUyxNQUFNLFlBQVk7QUFDakMsWUFBTSxnQkFBZ0IsT0FBTyxRQUFRLHlCQUF5QjtBQUM5RCxVQUFJLENBQUMsZUFBZTtBQUlsQixZQUFJLGdCQUFnQjtBQUNwQixZQUFJO0FBQ0YsZ0JBQU0sRUFBRSxlQUFBQSxnQkFBZSxTQUFTLElBQUksTUFBTSxPQUFPLGFBQWE7QUFDOUQsY0FBSUEsZUFBYyxHQUFHO0FBQ25CLDRCQUFnQixTQUFTLEtBQUssR0FBRyxHQUFHLGdCQUFnQjtBQUFBLFVBQ3REO0FBQUEsUUFDRixRQUFRO0FBQ04sMEJBQWdCO0FBQUEsUUFDbEI7QUFDQSxlQUFPO0FBQUEsVUFDTCxRQUFRO0FBQUEsVUFDUixVQUFVO0FBQUEsVUFDVixRQUFRLEdBQUcsR0FBRyxJQUFJLEdBQUc7QUFBQSxVQUNyQixRQUFRLE1BQU07QUFBQSxZQUNaO0FBQUEsWUFBSztBQUFBLFlBQVU7QUFBQSxZQUFLO0FBQUEsWUFBUTtBQUFBLFlBQVU7QUFBQSxZQUN0QyxFQUFFLEdBQUksZ0JBQWdCLEVBQUUsY0FBYyxJQUFJLENBQUMsR0FBSSxzQkFBc0IsZUFBZSxnQkFBZ0I7QUFBQSxVQUN0RztBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBQ0EsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsUUFBUSxHQUFHLEdBQUcsSUFBSSxHQUFHO0FBQUEsUUFDckIsUUFBUSxNQUFNO0FBQUEsVUFDWjtBQUFBLFVBQUs7QUFBQSxVQUFVO0FBQUEsVUFBSztBQUFBLFVBQVE7QUFBQSxVQUFVO0FBQUEsVUFDdEMsRUFBRSxzQkFBc0IsZUFBZSxnQkFBZ0I7QUFBQSxRQUN6RDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sS0FBSyxVQUFVLFVBQVUsc0JBQXNCLGVBQWUsaUJBQWlCLFFBQVEsTUFBTTtBQUNsSCxVQUFJLE1BQU0sVUFBVSxXQUFZLFFBQU87QUFDdkMsVUFBSSxDQUFDLE1BQU0sWUFBYSxRQUFPLGlCQUFpQixLQUFLLE1BQU0sS0FBSztBQUNoRSxZQUFNLE1BQU0sTUFBTSxZQUFhO0FBQy9CLFlBQU0sU0FBUyxNQUFNLFlBQWE7QUFLbEMsWUFBTSxTQUFTLEdBQUcsR0FBRyxJQUFJLEdBQUc7QUFDNUIsVUFBSTtBQUNKLFVBQUksU0FBUyxvQkFBb0IsV0FBVyxRQUFRO0FBSWxELGNBQU0sdUJBQXVCO0FBQzdCLGNBQU0sYUFBYSxRQUFRLG1CQUFtQixJQUFJLE1BQU0sS0FBSztBQUM3RCxZQUFJLGNBQWMsc0JBQXNCO0FBQ3RDLGdCQUFNLFdBQVcsUUFBUSxtQkFBbUIsaUJBQWlCLEtBQUssSUFBSTtBQUN0RSxrQkFBUSxxQkFBcUI7QUFDN0Isa0JBQVEsbUJBQW1CLE9BQU8sTUFBTTtBQUN4QyxpQkFBTztBQUFBLFlBQ0wsUUFBUTtBQUFBLFlBQ1IsUUFBUSwrQkFBK0IsVUFBVSxjQUFjLE1BQU0sNERBQXVELFFBQVE7QUFBQSxZQUNwSSxPQUFPO0FBQUEsWUFDUCxhQUFhO0FBQUEsVUFDZjtBQUFBLFFBQ0Y7QUFDQSw4QkFBc0I7QUFBQSxVQUNwQixrQkFBa0IsUUFBUSxtQkFBbUI7QUFBQSxVQUM3QyxnQkFBZ0IsUUFBUSxtQkFBbUI7QUFBQSxRQUM3QztBQUNBLGdCQUFRLHFCQUFxQjtBQUFBLE1BQy9CO0FBQ0EsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1Y7QUFBQSxRQUNBLFFBQVEsTUFBTTtBQUFBLFVBQ1o7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0EsRUFBRSxzQkFBc0IsZUFBZSxpQkFBaUIsb0JBQW9CO0FBQUEsUUFDOUU7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLE9BQU8sRUFBRSxPQUFPLEtBQUssVUFBVSxVQUFVLE1BQU0sTUFBTTtBQUMxRCxVQUFJLE1BQU0sVUFBVSxtQkFBb0IsUUFBTztBQUMvQyxVQUFJLENBQUMsTUFBTSxZQUFhLFFBQU8saUJBQWlCLEtBQUssTUFBTSxLQUFLO0FBQ2hFLFlBQU0sTUFBTSxNQUFNLFlBQVk7QUFDOUIsWUFBTSxTQUFTLE1BQU0sWUFBWTtBQUdqQyxZQUFNLGFBQWEsT0FBTztBQUMxQixVQUFJLENBQUMsWUFBWSxTQUFTO0FBQ3hCLDRCQUFvQixLQUFLLEdBQUc7QUFDNUIsZUFBTyxFQUFFLFFBQVEsT0FBTztBQUFBLE1BQzFCO0FBRUEsWUFBTSxVQUFVLGdCQUFnQixLQUFLLEtBQUssT0FBTztBQUNqRCxVQUFJLFFBQVEsV0FBVyxFQUFHLFFBQU8sRUFBRSxRQUFRLE9BQU87QUFFbEQsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsUUFBUSxHQUFHLEdBQUcsSUFBSSxHQUFHLFVBQVUsUUFBUSxJQUFJLE9BQUssRUFBRSxPQUFPLEVBQUUsS0FBSyxHQUFHLENBQUM7QUFBQSxRQUNwRSxRQUFRLE1BQU07QUFBQSxVQUNaO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0EsaUNBQWlDLFVBQVUsR0FBRztBQUFBLFFBQ2hEO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsT0FBTyxLQUFLLFVBQVUsU0FBUyxNQUFNO0FBQ25ELFVBQUksTUFBTSxVQUFVLG1CQUFvQixRQUFPO0FBQy9DLFVBQUksQ0FBQyxNQUFNLFlBQWEsUUFBTyxpQkFBaUIsS0FBSyxNQUFNLEtBQUs7QUFDaEUsWUFBTSxNQUFNLE1BQU0sWUFBYTtBQUMvQixZQUFNLFNBQVMsTUFBTSxZQUFhO0FBQ2xDLGFBQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLFVBQVU7QUFBQSxRQUNWLFFBQVEsR0FBRyxHQUFHLElBQUksR0FBRztBQUFBLFFBQ3JCLFFBQVEsTUFBTTtBQUFBLFVBQ1o7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsUUFDRjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sS0FBSyxVQUFVLFVBQVUsT0FBTyxzQkFBc0IsZUFBZSxnQkFBZ0IsTUFBTTtBQUNoSCxVQUFJLE1BQU0sVUFBVSxlQUFlLENBQUMsTUFBTSxXQUFZLFFBQU87QUFDN0QsVUFBSSxDQUFDLE1BQU0sWUFBYSxRQUFPO0FBUS9CLFlBQU0saUJBQWlCLE9BQU87QUFDOUIsVUFBSSxnQkFBZ0IsWUFBWSxNQUFPLFFBQU87QUFFOUMsWUFBTSxNQUFNLE1BQU0sWUFBWTtBQUM5QixZQUFNLFNBQVMsTUFBTSxZQUFZO0FBQ2pDLFlBQU0sY0FBYyxnQkFBZ0IsZ0JBQWdCO0FBQ3BELFlBQU0sZ0JBQWdCLGdCQUFnQixrQkFBa0IsaUNBQWlDLFVBQVUsR0FBRztBQU10RyxZQUFNLDJCQUEyQixnQkFBZ0IsWUFBWSxPQUFPLElBQUk7QUFJeEUsVUFBSSxlQUFlLEVBQUcsUUFBTztBQUU3QixVQUFJO0FBQ0YsY0FBTTtBQUFBLFVBQ0o7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFFBQ0YsSUFBSSxNQUFNLE9BQU8scUJBQXFCO0FBRXRDLGNBQU0sU0FBUyxNQUFNLGdCQUFnQixVQUFVLEtBQUssR0FBRztBQUN2RCxZQUFJLE9BQU8sU0FBUyxFQUFHLFFBQU87QUFFOUIsY0FBTSxRQUFRLGdCQUFnQixNQUFNO0FBR3BDLFlBQUksaUJBQWlCLEtBQUssRUFBRyxRQUFPO0FBRXBDLGNBQU0sWUFBWSxJQUFJLElBQUksTUFBTSxPQUFPLENBQUMsTUFBTSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQztBQUN0RSxjQUFNLFdBQVcsY0FBYyxPQUFPLFdBQVcsb0JBQUksSUFBSSxDQUFDO0FBSTFELFlBQUksU0FBUyxTQUFTLHlCQUEwQixRQUFPO0FBRXZELGNBQU0sV0FBVyxnQkFBZ0IsS0FBSztBQUN0QyxjQUFNLFdBQVcsU0FBUyxpQkFDdEIsNEJBQTRCO0FBQUEsVUFDMUI7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0EsaUJBQWlCLG9CQUFJLElBQUk7QUFBQSxRQUMzQixDQUFDLEVBQUUsV0FDSDtBQUFBLFVBQ0U7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0Esb0JBQUksSUFBSTtBQUFBLFFBQ1Y7QUFDSixZQUFJLFNBQVMsVUFBVSxFQUFHLFFBQU87QUFHakMsY0FBTSxVQUFVLGFBQWEsS0FBSztBQUNsQyxnQkFBUSxPQUFPO0FBQUEsVUFDYixpQkFBaUIsR0FBRyxJQUFJLEdBQUcsdUJBQWtCLFFBQVEsU0FBUyxVQUFVLFFBQVEsU0FBUyxVQUNoRixRQUFRLFlBQVksZ0JBQWdCLFNBQVMsTUFBTSxjQUFjLFFBQVEsU0FBUztBQUFBO0FBQUEsUUFDN0Y7QUFJQSxjQUFNLEVBQUUsa0JBQWtCLElBQUksTUFBTSxPQUFPLHFCQUFxQjtBQUNoRSwwQkFBa0IsVUFBVSxLQUFLLEtBQUs7QUFBQSxVQUNwQyxTQUFTO0FBQUEsVUFDVCxXQUFXLENBQUMsR0FBRyxTQUFTO0FBQUEsVUFDeEIsWUFBWTtBQUFBLFVBQ1osZUFBZTtBQUFBLFVBQ2YsWUFBVyxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLFFBQ3BDLENBQUM7QUFJRCxjQUFNLGNBQWMsU0FBUyxLQUFLLEdBQUc7QUFFckMsZUFBTztBQUFBLFVBQ0wsUUFBUTtBQUFBLFVBQ1IsVUFBVTtBQUFBLFVBQ1YsUUFBUSxHQUFHLEdBQUcsSUFBSSxHQUFHLGFBQWEsV0FBVztBQUFBLFVBQzdDLFFBQVEsTUFBTTtBQUFBLFlBQ1o7QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBLEVBQUUsc0JBQXNCLGVBQWUsZ0JBQWdCO0FBQUEsVUFDekQ7QUFBQSxRQUNGO0FBQUEsTUFDRixTQUFTLEtBQUs7QUFFWixpQkFBUyxZQUFZLG9DQUFvQyxFQUFFLE9BQVEsSUFBYyxRQUFRLENBQUM7QUFDMUYsZUFBTztBQUFBLE1BQ1Q7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sT0FBTyxFQUFFLE9BQU8sS0FBSyxVQUFVLFVBQVUsc0JBQXNCLGVBQWUsZ0JBQWdCLE1BQU07QUFDekcsVUFBSSxNQUFNLFVBQVUsZUFBZSxDQUFDLE1BQU0sV0FBWSxRQUFPO0FBQzdELFVBQUksQ0FBQyxNQUFNLFlBQWEsUUFBTyxpQkFBaUIsS0FBSyxNQUFNLEtBQUs7QUFDaEUsWUFBTSxNQUFNLE1BQU0sWUFBYTtBQUMvQixZQUFNLFNBQVMsTUFBTSxZQUFhO0FBQ2xDLFlBQU0sTUFBTSxNQUFNLFdBQVc7QUFPN0IsWUFBTSxlQUFlLGdCQUFnQixVQUFVLEtBQUssS0FBSyxLQUFLLE1BQU07QUFDcEUsVUFBSSxDQUFDLGdCQUFnQixDQUFDLFdBQVcsWUFBWSxHQUFHO0FBQzlDLGVBQU87QUFBQSxVQUNMLFFBQVE7QUFBQSxVQUNSLFVBQVU7QUFBQSxVQUNWLFFBQVEsR0FBRyxHQUFHLElBQUksR0FBRztBQUFBLFVBQ3JCLFFBQVEsTUFBTTtBQUFBLFlBQ1o7QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0EsRUFBRSxzQkFBc0IsZUFBZSxnQkFBZ0I7QUFBQSxVQUN6RDtBQUFBLFFBQ0Y7QUFBQSxNQUNGO0FBRUEsYUFBTztBQUFBLElBQ1Q7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsT0FBTyxLQUFLLFVBQVUsc0JBQXNCLGVBQWUsZ0JBQWdCLE1BQU07QUFDL0YsVUFBSSxNQUFNLFVBQVUsZUFBZSxDQUFDLE1BQU0sV0FBWSxRQUFPO0FBQzdELFVBQUksQ0FBQyxNQUFNLFlBQWEsUUFBTyxpQkFBaUIsS0FBSyxNQUFNLEtBQUs7QUFDaEUsWUFBTSxNQUFNLE1BQU0sWUFBYTtBQUMvQixZQUFNLFNBQVMsTUFBTSxZQUFhO0FBQ2xDLFlBQU0sTUFBTSxNQUFNLFdBQVc7QUFDN0IsWUFBTSxTQUFTLE1BQU0sV0FBVztBQUVoQyxhQUFPO0FBQUEsUUFDTCxRQUFRO0FBQUEsUUFDUixVQUFVO0FBQUEsUUFDVixRQUFRLEdBQUcsR0FBRyxJQUFJLEdBQUcsSUFBSSxHQUFHO0FBQUEsUUFDNUIsUUFBUSxNQUFNO0FBQUEsVUFDWjtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQSxFQUFFLHNCQUFzQixlQUFlLGdCQUFnQjtBQUFBLFFBQ3pEO0FBQUEsTUFDRjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxPQUFPLEVBQUUsT0FBTyxLQUFLLFVBQVUsVUFBVSxNQUFNLE1BQU07QUFDMUQsVUFBSSxNQUFNLFVBQVUsdUJBQXdCLFFBQU87QUFJbkQsWUFBTSxnQkFBZ0IscUJBQXFCLFVBQVUsR0FBRztBQUN4RCxVQUFJLGNBQWMsU0FBUyxHQUFHO0FBQzVCLGVBQU87QUFBQSxVQUNMLFFBQVE7QUFBQSxVQUNSLFFBQVEsNkJBQTZCLEdBQUcsWUFBWSxjQUFjLEtBQUssSUFBSSxDQUFDO0FBQUEsVUFDNUUsT0FBTztBQUFBLFFBQ1Q7QUFBQSxNQUNGO0FBS0EsWUFBTSxpQkFBaUIsTUFBTSw0QkFBNEIsR0FBRyxNQUFNO0FBR2xFLFVBQUksT0FBTyxRQUFRLDZCQUE2QixnQkFBZ0I7QUFDOUQsY0FBTSxPQUFPLHFCQUFxQixVQUFVLEdBQUc7QUFDL0MsWUFBSSxNQUFNO0FBQ1IsY0FBSSxDQUFDLFdBQVcsSUFBSSxFQUFHLFdBQVUsTUFBTSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQzFELGdCQUFNLGlCQUFpQjtBQUFBLFlBQ3JCO0FBQUEsWUFDQSx1QkFBdUIsS0FBSyxZQUFZO0FBQUEsVUFDMUM7QUFDQSxnQkFBTSxhQUFhLGlCQUNmLDJDQUNBO0FBQ0osZ0JBQU0sdUJBQXVCLGlCQUFpQixrQkFBa0I7QUFDaEUsZ0JBQU0sVUFBVTtBQUFBLFlBQ2Q7QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0EsMkJBQTJCLG9CQUFvQjtBQUFBLFlBQy9DO0FBQUEsWUFDQTtBQUFBLFlBQ0E7QUFBQSxZQUNBO0FBQUEsWUFDQTtBQUFBLFlBQ0Esd0NBQXdDLFVBQVU7QUFBQSxVQUNwRCxFQUFFLEtBQUssSUFBSTtBQUNYLHdCQUFjLGdCQUFnQixTQUFTLE9BQU87QUFDOUMsY0FBSTtBQUtGLGdCQUFJLGNBQWMsR0FBRztBQUNuQiwwQkFBWSxNQUFNO0FBQ2hCLGlDQUFpQjtBQUFBLGtCQUNmLE1BQU07QUFBQSxrQkFDTixhQUFhO0FBQUEsa0JBQ2IsU0FBUztBQUFBLGtCQUNULFFBQVE7QUFBQSxrQkFDUixRQUFRO0FBQUEsa0JBQ1IsT0FBTztBQUFBLGtCQUNQLGFBQWE7QUFBQSxnQkFDZixDQUFDO0FBQ0Qsc0JBQU0sY0FBYyxtQkFBbUIsR0FBRyxFQUFFLENBQUMsR0FBRztBQUNoRCxvQkFBSSxhQUFhO0FBQ2Y7QUFBQSxvQkFDRTtBQUFBLG9CQUNBO0FBQUEsb0JBQ0E7QUFBQSxxQkFDQSxvQkFBSSxLQUFLLEdBQUUsWUFBWTtBQUFBLGtCQUN6QjtBQUFBLGdCQUNGO0FBQUEsY0FDRixDQUFDO0FBQUEsWUFDSDtBQUFBLFVBQ0YsU0FBUyxLQUFLO0FBQ1osZ0JBQUk7QUFDRix5QkFBVyxjQUFjO0FBQUEsWUFDM0IsU0FBUyxXQUFXO0FBQ2xCO0FBQUEsZ0JBQ0U7QUFBQSxnQkFDQSx1RUFBdUUsR0FBRyxLQUFLLHFCQUFxQixRQUFRLFVBQVUsVUFBVSxPQUFPLFNBQVMsQ0FBQztBQUFBLGNBQ25KO0FBQUEsWUFDRjtBQUNBLGtCQUFNO0FBQUEsVUFDUjtBQUNBLDhCQUFvQjtBQUFBLFFBQ3RCO0FBQ0EsZUFBTyxFQUFFLFFBQVEsT0FBTztBQUFBLE1BQzFCO0FBQ0EsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsUUFBUTtBQUFBLFFBQ1IsUUFBUSxNQUFNLDZCQUE2QixLQUFLLFVBQVUsUUFBUTtBQUFBLE1BQ3BFO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLE9BQU8sRUFBRSxPQUFPLEtBQUssVUFBVSxTQUFTLE1BQU07QUFDbkQsVUFBSSxNQUFNLFVBQVUsdUJBQXdCLFFBQU87QUFNbkQsVUFBSSxjQUFjLEdBQUc7QUFDbkIsY0FBTSxZQUFZLGFBQWEsR0FBRztBQUNsQyxZQUFJLGFBQWEsZUFBZSxVQUFVLE1BQU0sR0FBRztBQUNqRCxpQkFBTyxFQUFFLFFBQVEsT0FBTztBQUFBLFFBQzFCO0FBQUEsTUFDRjtBQU1BLFlBQU0saUJBQWlCLHFCQUFxQixVQUFVLEtBQUssWUFBWTtBQUN2RSxVQUFJLGdCQUFnQjtBQUNsQixjQUFNLG9CQUFvQixNQUFNLFNBQVMsY0FBYztBQUN2RCxZQUFJLG1CQUFtQjtBQUNyQixnQkFBTSxVQUFVLGVBQWUsaUJBQWlCO0FBQ2hELGNBQUksWUFBWSx1QkFBdUIsWUFBWSxtQkFBbUI7QUFDcEUsbUJBQU87QUFBQSxjQUNMLFFBQVE7QUFBQSxjQUNSLFFBQVEsNkJBQTZCLEdBQUcsNEJBQTRCLE9BQU87QUFBQSxjQUMzRSxPQUFPO0FBQUEsWUFDVDtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUdBLFlBQU0sZ0JBQWdCLHFCQUFxQixVQUFVLEdBQUc7QUFDeEQsVUFBSSxjQUFjLFNBQVMsR0FBRztBQUM1QixlQUFPO0FBQUEsVUFDTCxRQUFRO0FBQUEsVUFDUixRQUFRLDZCQUE2QixHQUFHLFlBQVksY0FBYyxLQUFLLElBQUksQ0FBQztBQUFBLFVBQzVFLE9BQU87QUFBQSxRQUNUO0FBQUEsTUFDRjtBQUtBLFlBQU0sZ0JBQWdCLDJCQUEyQixVQUFVLEdBQUc7QUFDOUQsVUFBSSxrQkFBa0IsVUFBVTtBQUM5QixlQUFPO0FBQUEsVUFDTCxRQUFRO0FBQUEsVUFDUixRQUFRLDZCQUE2QixHQUFHO0FBQUEsVUFDeEMsT0FBTztBQUFBLFFBQ1Q7QUFBQSxNQUNGO0FBQ0EsVUFBSSxrQkFBa0IsV0FBVztBQUMvQixtQkFBVyxZQUFZLGtEQUFrRCxHQUFHLDhDQUF5QztBQUFBLE1BQ3ZIO0FBSUEsVUFBSTtBQUNGLFlBQUksY0FBYyxHQUFHO0FBQ25CLGdCQUFNLFlBQVksYUFBYSxHQUFHO0FBQ2xDLGNBQUksV0FBVyw0QkFDWCxDQUFDLDRCQUE0QixVQUFVLHdCQUF3QixHQUFHO0FBQ3BFLGtCQUFNLGlCQUFpQixxQkFBcUIsVUFBVSxLQUFLLFlBQVk7QUFDdkUsZ0JBQUksZ0JBQWdCO0FBQ2xCLG9CQUFNLG9CQUFvQixNQUFNLFNBQVMsY0FBYztBQUN2RCxrQkFBSSxtQkFBbUI7QUFHckIsc0JBQU0sa0JBQWtCLDhCQUE4QixLQUFLLGlCQUFpQjtBQUM1RSxzQkFBTSxzQkFBc0Isd0VBQXdFLEtBQUssaUJBQWlCO0FBQzFILHNCQUFNLDBCQUEwQixrQ0FBa0MsS0FBSyxpQkFBaUI7QUFJeEYsc0JBQU0sa0JBQ0osa0JBQWtCLFNBQVMsYUFBYSxNQUN2QyxrQkFBa0IsU0FBUyxLQUFLLEtBQUssa0JBQWtCLFNBQVMsS0FBSyxLQUFLLGtCQUFrQixTQUFTLFdBQVc7QUFDbkgsc0JBQU0sYUFDSixrSkFBa0osS0FBSyxpQkFBaUI7QUFDMUssc0JBQU0sc0JBQ0osbUJBQ0EsdUJBQ0EsMkJBQ0EsbUJBQ0E7QUFDRixvQkFBSSxDQUFDLHFCQUFxQjtBQUN4Qix5QkFBTztBQUFBLG9CQUNMLFFBQVE7QUFBQSxvQkFDUixRQUFRLGFBQWEsR0FBRywyQ0FBMkMsVUFBVSx5QkFBeUIsVUFBVSxHQUFHLEdBQUcsQ0FBQztBQUFBLG9CQUN2SCxPQUFPO0FBQUEsa0JBQ1Q7QUFBQSxnQkFDRjtBQUFBLGNBQ0Y7QUFBQSxZQUNGO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxNQUNGLFNBQVMsS0FBSztBQUNaLG1CQUFXLFlBQVksb0NBQW9DLGVBQWUsUUFBUSxJQUFJLFVBQVUsT0FBTyxHQUFHLENBQUMsRUFBRTtBQUFBLE1BQy9HO0FBRUEsYUFBTztBQUFBLFFBQ0wsUUFBUTtBQUFBLFFBQ1IsVUFBVTtBQUFBLFFBQ1YsUUFBUTtBQUFBLFFBQ1IsUUFBUSxNQUFNLDZCQUE2QixLQUFLLFVBQVUsUUFBUTtBQUFBLE1BQ3BFO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLE9BQU8sRUFBRSxPQUFPLEtBQUssVUFBVSxTQUFTLE1BQU07QUFDbkQsVUFBSSxNQUFNLFVBQVUsV0FBWSxRQUFPO0FBQ3ZDLFVBQUksT0FBTyxjQUFjLEdBQUc7QUFDMUIsY0FBTSxZQUFZLGFBQWEsR0FBRztBQUNsQyxZQUFJLGFBQWEsQ0FBQyxlQUFlLFVBQVUsTUFBTSxHQUFHO0FBQ2xELGlCQUFPO0FBQUEsWUFDTCxRQUFRO0FBQUEsWUFDUixVQUFVO0FBQUEsWUFDVixRQUFRO0FBQUEsWUFDUixRQUFRLE1BQU0sNkJBQTZCLEtBQUssVUFBVSxRQUFRO0FBQUEsVUFDcEU7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUNBLGFBQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxRQUNSLFFBQVE7QUFBQSxRQUNSLE9BQU87QUFBQSxNQUNUO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRjtBQUVBLFNBQVMsbUJBQW1CO0FBWTVCLGVBQXNCLGdCQUNwQixLQUN5QjtBQUN6QixRQUFNLFlBQVksSUFBSSxNQUFNLGlCQUFpQjtBQUM3QyxNQUFJLGFBQWEsSUFBSSxRQUFRLFdBQVc7QUFDdEMsV0FBTztBQUFBLE1BQ0wsUUFBUTtBQUFBLE1BQ1IsUUFDRSw2Q0FBNkMsSUFBSSxHQUFHLHNDQUFzQyxTQUFTO0FBQUEsTUFFckcsT0FBTztBQUFBLElBQ1Q7QUFBQSxFQUNGO0FBR0EsTUFBSTtBQUNGLFVBQU0sV0FBVyxZQUFZO0FBQzdCLFdBQU8sdUJBQXVCLE1BQU0sU0FBUyxpQkFBaUIsR0FBRyxDQUFDO0FBQUEsRUFDcEUsU0FBUyxLQUFLO0FBRVosZUFBVyxZQUFZLDJEQUEyRCxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRyxDQUFDLEVBQUU7QUFBQSxFQUN0STtBQUVBLGFBQVcsUUFBUSxnQkFBZ0I7QUFDakMsVUFBTSxTQUFTLE1BQU0sS0FBSyxNQUFNLEdBQUc7QUFDbkMsUUFBSSxRQUFRO0FBQ1YsVUFBSSxPQUFPLFdBQVcsT0FBUSxRQUFPLGNBQWMsS0FBSztBQUN4RCxhQUFPLHVCQUF1QixNQUFNO0FBQUEsSUFDdEM7QUFBQSxFQUNGO0FBTUEsU0FBTztBQUFBLElBQ0wsUUFBUTtBQUFBLElBQ1IsUUFBUSxvQkFBb0IsSUFBSSxNQUFNLEtBQUs7QUFBQSxJQUMzQyxPQUFPO0FBQUEsSUFDUCxhQUFhO0FBQUEsRUFDZjtBQUNGO0FBSU8sU0FBUyx1QkFBaUM7QUFDL0MsU0FBTyxlQUFlLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSTtBQUN6QzsiLAogICJuYW1lcyI6IFsiaXNEYkF2YWlsYWJsZSJdCn0K
