import { ensureDbOpen } from "../bootstrap/dynamic-tools.js";
import { sanitizeCompleteMilestoneParams } from "../bootstrap/sanitize-complete-milestone.js";
import { loadWriteGateSnapshot, shouldBlockContextArtifactSaveInSnapshot, shouldBlockRootArtifactSaveInSnapshot } from "../bootstrap/write-gate.js";
import {
  getActiveRequirements,
  insertMilestone,
  getMilestone,
  getSliceStatusSummary,
  getSliceTaskCounts,
  readTransaction,
  saveGateResult
} from "../gsd-db.js";
import { GATE_REGISTRY } from "../gate-registry.js";
import { generateRequirementsMd, saveArtifactToDb } from "../db-writer.js";
import { resolveMilestoneFile, resolveSliceFile } from "../paths.js";
import { unlinkSync } from "node:fs";
import { handleCompleteMilestone } from "./complete-milestone.js";
import { handleCompleteTask } from "./complete-task.js";
import { handleCompleteSlice } from "./complete-slice.js";
import { handlePlanMilestone } from "./plan-milestone.js";
import { handlePlanSlice } from "./plan-slice.js";
import { handleReplanSlice } from "./replan-slice.js";
import { handleReopenMilestone } from "./reopen-milestone.js";
import { handleReopenSlice } from "./reopen-slice.js";
import { handleReopenTask } from "./reopen-task.js";
import { handleReassessRoadmap } from "./reassess-roadmap.js";
import { handleValidateMilestone } from "./validate-milestone.js";
import { logError, logWarning } from "../workflow-logger.js";
import { invalidateStateCache } from "../state.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { parseProject } from "../schemas/parsers.js";
const SUPPORTED_SUMMARY_ARTIFACT_TYPES = [
  "SUMMARY",
  "RESEARCH",
  "CONTEXT",
  "ASSESSMENT",
  "CONTEXT-DRAFT",
  "PROJECT",
  "PROJECT-DRAFT",
  "REQUIREMENTS",
  "REQUIREMENTS-DRAFT"
];
function isSupportedSummaryArtifactType(artifactType) {
  return SUPPORTED_SUMMARY_ARTIFACT_TYPES.includes(artifactType);
}
function isRootSummaryArtifactType(artifactType) {
  return artifactType === "PROJECT" || artifactType === "PROJECT-DRAFT" || artifactType === "REQUIREMENTS" || artifactType === "REQUIREMENTS-DRAFT";
}
function registerProjectMilestoneSequence(content) {
  const parsed = parseProject(content);
  const registered = [];
  for (const milestone of parsed.milestones) {
    insertMilestone({
      id: milestone.id,
      title: milestone.title,
      status: milestone.done ? "complete" : "queued"
    });
    registered.push(milestone.id);
  }
  return registered;
}
async function executeSummarySave(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot save artifact." }],
      details: { operation: "save_summary", error: "db_unavailable" },
      isError: true
    };
  }
  if (!isSupportedSummaryArtifactType(params.artifact_type)) {
    return {
      content: [{ type: "text", text: `Error: Invalid artifact_type "${params.artifact_type}". Must be one of: ${SUPPORTED_SUMMARY_ARTIFACT_TYPES.join(", ")}` }],
      details: { operation: "save_summary", error: "invalid_artifact_type" },
      isError: true
    };
  }
  if (!isRootSummaryArtifactType(params.artifact_type) && !params.milestone_id) {
    return {
      content: [{ type: "text", text: `Error: milestone_id is required for artifact_type "${params.artifact_type}". Root-level artifacts must use PROJECT, PROJECT-DRAFT, REQUIREMENTS, or REQUIREMENTS-DRAFT.` }],
      details: { operation: "save_summary", error: "missing_milestone_id" },
      isError: true
    };
  }
  const writeGateSnapshot = loadWriteGateSnapshot(basePath);
  const prefs = loadEffectiveGSDPreferences(basePath)?.preferences;
  const rootArtifactGuard = shouldBlockRootArtifactSaveInSnapshot(
    writeGateSnapshot,
    params.artifact_type,
    { requireVerifiedApproval: prefs?.planning_depth === "deep" }
  );
  if (rootArtifactGuard.block) {
    return {
      content: [{ type: "text", text: `Error saving artifact: ${rootArtifactGuard.reason ?? "root artifact write blocked"}` }],
      details: { operation: "save_summary", error: "root_artifact_write_blocked" },
      isError: true
    };
  }
  const contextGuard = shouldBlockContextArtifactSaveInSnapshot(
    writeGateSnapshot,
    params.artifact_type,
    params.milestone_id ?? null,
    params.slice_id ?? null
  );
  if (contextGuard.block) {
    return {
      content: [{ type: "text", text: `Error saving artifact: ${contextGuard.reason ?? "context write blocked"}` }],
      details: { operation: "save_summary", error: "context_write_blocked" },
      isError: true
    };
  }
  try {
    let relativePath;
    if (params.artifact_type === "PROJECT") {
      relativePath = "PROJECT.md";
    } else if (params.artifact_type === "PROJECT-DRAFT") {
      relativePath = "PROJECT-DRAFT.md";
    } else if (params.artifact_type === "REQUIREMENTS") {
      relativePath = "REQUIREMENTS.md";
    } else if (params.artifact_type === "REQUIREMENTS-DRAFT") {
      relativePath = "REQUIREMENTS-DRAFT.md";
    } else if (params.task_id && params.slice_id) {
      relativePath = `milestones/${params.milestone_id}/slices/${params.slice_id}/tasks/${params.task_id}-${params.artifact_type}.md`;
    } else if (params.slice_id) {
      relativePath = `milestones/${params.milestone_id}/slices/${params.slice_id}/${params.slice_id}-${params.artifact_type}.md`;
    } else {
      relativePath = `milestones/${params.milestone_id}/${params.milestone_id}-${params.artifact_type}.md`;
    }
    const activeRequirements = params.artifact_type === "REQUIREMENTS" ? getActiveRequirements() : null;
    if (params.artifact_type === "REQUIREMENTS" && activeRequirements?.length === 0) {
      return {
        content: [{ type: "text", text: "Error: Cannot save REQUIREMENTS artifact \u2014 no active requirements found in the database. Call gsd_requirement_save for each requirement before calling gsd_summary_save(REQUIREMENTS)." }],
        details: { operation: "save_summary", error: "no_active_requirements" },
        isError: true
      };
    }
    const contentToSave = params.artifact_type === "REQUIREMENTS" ? generateRequirementsMd(activeRequirements ?? []) : params.content;
    const contentSource = params.artifact_type === "REQUIREMENTS" ? "requirements_table" : "provided_content";
    const isRootArtifact = isRootSummaryArtifactType(params.artifact_type);
    await saveArtifactToDb(
      {
        path: relativePath,
        artifact_type: params.artifact_type,
        content: contentToSave,
        milestone_id: isRootArtifact ? void 0 : params.milestone_id,
        slice_id: isRootArtifact ? void 0 : params.slice_id,
        task_id: isRootArtifact ? void 0 : params.task_id
      },
      basePath
    );
    let registeredMilestones = [];
    if (params.artifact_type === "PROJECT") {
      try {
        registeredMilestones = registerProjectMilestoneSequence(contentToSave);
        if (registeredMilestones.length > 0) invalidateStateCache();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError("tool", `gsd_summary_save: PROJECT artifact persisted but milestone registration threw: ${msg}`, {
          tool: "gsd_summary_save",
          error: String(err),
          stack: err instanceof Error ? err.stack ?? "" : ""
        });
        invalidateStateCache();
        return {
          content: [{
            type: "text",
            text: `Error: PROJECT.md was saved to ${relativePath} but milestone registration failed: ${msg}. The DB has no milestone rows for this project, so /gsd will report "No Active Milestone". Re-call gsd_summary_save(PROJECT) once the underlying error is resolved \u2014 INSERT OR IGNORE makes registration idempotent.`
          }],
          details: {
            operation: "save_summary",
            path: relativePath,
            artifact_type: params.artifact_type,
            error: "milestone_registration_threw",
            registration_error: msg
          },
          isError: true
        };
      }
      if (registeredMilestones.length === 0) {
        logError("tool", `gsd_summary_save: PROJECT.md saved to ${relativePath} but parsed zero milestones \u2014 registration produced no DB rows`, {
          tool: "gsd_summary_save"
        });
        invalidateStateCache();
        return {
          content: [{
            type: "text",
            text: `Error: PROJECT.md was saved to ${relativePath} but contains zero parseable milestone lines, so no milestones were registered in the DB. /gsd will report "No Active Milestone". Rewrite PROJECT.md so the "Milestone Sequence" section uses canonical lines: \`- [ ] M001: <Title> \u2014 <One-liner>\` (em-dash, double-dash \`--\`, or single-dash \`-\` separator), then re-call gsd_summary_save(PROJECT).`
          }],
          details: {
            operation: "save_summary",
            path: relativePath,
            artifact_type: params.artifact_type,
            error: "milestone_registration_empty_parse"
          },
          isError: true
        };
      }
    }
    if (params.artifact_type === "CONTEXT" && !params.task_id) {
      try {
        const draftFile = params.slice_id ? resolveSliceFile(basePath, params.milestone_id, params.slice_id, "CONTEXT-DRAFT") : resolveMilestoneFile(basePath, params.milestone_id, "CONTEXT-DRAFT");
        if (draftFile) unlinkSync(draftFile);
      } catch (e) {
        logWarning("tool", `CONTEXT-DRAFT.md unlink failed: ${e.message}`);
      }
    }
    return {
      content: [{ type: "text", text: `Saved ${params.artifact_type} artifact to ${relativePath}` }],
      details: {
        operation: "save_summary",
        path: relativePath,
        artifact_type: params.artifact_type,
        content_source: contentSource,
        ...registeredMilestones.length > 0 ? { registeredMilestones } : {}
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `gsd_summary_save tool failed: ${msg}`, { tool: "gsd_summary_save", error: String(err) });
    return {
      content: [{ type: "text", text: `Error saving artifact: ${msg}` }],
      details: { operation: "save_summary", error: msg },
      isError: true
    };
  }
}
async function executeTaskComplete(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot complete task." }],
      details: { operation: "complete_task", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const coerced = { ...params };
    coerced.verificationEvidence = (params.verificationEvidence ?? []).map(
      (v) => typeof v === "string" ? { command: v, exitCode: -1, verdict: "unknown (coerced from string)", durationMs: 0 } : v
    );
    const result = await handleCompleteTask(coerced, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error completing task: ${result.error}` }],
        details: { operation: "complete_task", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Completed task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
      details: {
        operation: "complete_task",
        taskId: result.taskId,
        sliceId: result.sliceId,
        milestoneId: result.milestoneId,
        summaryPath: result.summaryPath
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `complete_task tool failed: ${msg}`, { tool: "gsd_task_complete", error: String(err) });
    return {
      content: [{ type: "text", text: `Error completing task: ${msg}` }],
      details: { operation: "complete_task", error: msg },
      isError: true
    };
  }
}
async function executeTaskReopen(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot reopen task." }],
      details: { operation: "reopen_task", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const result = await handleReopenTask(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error reopening task: ${result.error}` }],
        details: { operation: "reopen_task", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Reopened task ${result.taskId} (${result.sliceId}/${result.milestoneId})` }],
      details: {
        operation: "reopen_task",
        taskId: result.taskId,
        sliceId: result.sliceId,
        milestoneId: result.milestoneId
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `reopen_task tool failed: ${msg}`, { tool: "gsd_task_reopen", error: String(err) });
    return {
      content: [{ type: "text", text: `Error reopening task: ${msg}` }],
      details: { operation: "reopen_task", error: msg },
      isError: true
    };
  }
}
async function executeSliceReopen(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot reopen slice." }],
      details: { operation: "reopen_slice", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const result = await handleReopenSlice(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error reopening slice: ${result.error}` }],
        details: { operation: "reopen_slice", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Reopened slice ${result.sliceId} (${result.milestoneId})` }],
      details: {
        operation: "reopen_slice",
        sliceId: result.sliceId,
        milestoneId: result.milestoneId,
        tasksReset: result.tasksReset
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `reopen_slice tool failed: ${msg}`, { tool: "gsd_slice_reopen", error: String(err) });
    return {
      content: [{ type: "text", text: `Error reopening slice: ${msg}` }],
      details: { operation: "reopen_slice", error: msg },
      isError: true
    };
  }
}
async function executeMilestoneReopen(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot reopen milestone." }],
      details: { operation: "reopen_milestone", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const result = await handleReopenMilestone(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error reopening milestone: ${result.error}` }],
        details: { operation: "reopen_milestone", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Reopened milestone ${result.milestoneId}` }],
      details: {
        operation: "reopen_milestone",
        milestoneId: result.milestoneId,
        slicesReset: result.slicesReset,
        tasksReset: result.tasksReset
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `reopen_milestone tool failed: ${msg}`, { tool: "gsd_milestone_reopen", error: String(err) });
    return {
      content: [{ type: "text", text: `Error reopening milestone: ${msg}` }],
      details: { operation: "reopen_milestone", error: msg },
      isError: true
    };
  }
}
async function executeSliceComplete(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot complete slice." }],
      details: { operation: "complete_slice", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const splitPair = (s) => {
      const m = s.match(/^(.+?)\s*(?:—|-)\s+(.+)$/);
      return m ? [m[1].trim(), m[2].trim()] : [s.trim(), ""];
    };
    const wrapArray = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
    const coerced = { ...params };
    coerced.provides = wrapArray(params.provides);
    coerced.keyFiles = wrapArray(params.keyFiles);
    coerced.keyDecisions = wrapArray(params.keyDecisions);
    coerced.patternsEstablished = wrapArray(params.patternsEstablished);
    coerced.observabilitySurfaces = wrapArray(params.observabilitySurfaces);
    coerced.requirementsSurfaced = wrapArray(params.requirementsSurfaced);
    coerced.drillDownPaths = wrapArray(params.drillDownPaths);
    coerced.affects = wrapArray(params.affects);
    coerced.filesModified = wrapArray(params.filesModified).map((f) => {
      if (typeof f !== "string") return f;
      const [path, description] = splitPair(f);
      return { path, description };
    });
    coerced.requires = wrapArray(params.requires).map((r) => {
      if (typeof r !== "string") return r;
      const [slice, provides] = splitPair(r);
      return { slice, provides };
    });
    coerced.requirementsAdvanced = wrapArray(params.requirementsAdvanced).map((r) => {
      if (typeof r !== "string") return r;
      const [id, how] = splitPair(r);
      return { id, how };
    });
    coerced.requirementsValidated = wrapArray(params.requirementsValidated).map((r) => {
      if (typeof r !== "string") return r;
      const [id, proof] = splitPair(r);
      return { id, proof };
    });
    coerced.requirementsInvalidated = wrapArray(params.requirementsInvalidated).map((r) => {
      if (typeof r !== "string") return r;
      const [id, what] = splitPair(r);
      return { id, what };
    });
    const result = await handleCompleteSlice(coerced, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error completing slice: ${result.error}` }],
        details: { operation: "complete_slice", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Completed slice ${result.sliceId} (${result.milestoneId})` }],
      details: {
        operation: "complete_slice",
        sliceId: result.sliceId,
        milestoneId: result.milestoneId,
        summaryPath: result.summaryPath,
        uatPath: result.uatPath
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `complete_slice tool failed: ${msg}`, { tool: "gsd_slice_complete", error: String(err) });
    return {
      content: [{ type: "text", text: `Error completing slice: ${msg}` }],
      details: { operation: "complete_slice", error: msg },
      isError: true
    };
  }
}
async function executeCompleteMilestone(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot complete milestone." }],
      details: { operation: "complete_milestone", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const sanitized = sanitizeCompleteMilestoneParams(params);
    const result = await handleCompleteMilestone(sanitized, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error completing milestone: ${result.error}` }],
        details: { operation: "complete_milestone", error: result.error },
        isError: true
      };
    }
    const message = result.alreadyComplete ? `Milestone ${result.milestoneId} is already complete. Summary available at ${result.summaryPath}` : `Completed milestone ${result.milestoneId}. Summary written to ${result.summaryPath}`;
    return {
      content: [{ type: "text", text: message }],
      details: {
        operation: "complete_milestone",
        milestoneId: result.milestoneId,
        summaryPath: result.summaryPath,
        ...result.alreadyComplete ? { alreadyComplete: true } : {},
        ...result.stale ? { stale: true } : {}
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `complete_milestone tool failed: ${msg}`, { tool: "gsd_complete_milestone", error: String(err) });
    return {
      content: [{ type: "text", text: `Error completing milestone: ${msg}` }],
      details: { operation: "complete_milestone", error: msg },
      isError: true
    };
  }
}
async function executeValidateMilestone(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot validate milestone." }],
      details: { operation: "validate_milestone", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const result = await handleValidateMilestone(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error validating milestone: ${result.error}` }],
        details: { operation: "validate_milestone", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Validated milestone ${result.milestoneId} \u2014 verdict: ${result.verdict}. Written to ${result.validationPath}` }],
      details: {
        operation: "validate_milestone",
        milestoneId: result.milestoneId,
        verdict: result.verdict,
        validationPath: result.validationPath
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `validate_milestone tool failed: ${msg}`, { tool: "gsd_validate_milestone", error: String(err) });
    return {
      content: [{ type: "text", text: `Error validating milestone: ${msg}` }],
      details: { operation: "validate_milestone", error: msg },
      isError: true
    };
  }
}
async function executeReassessRoadmap(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot reassess roadmap." }],
      details: { operation: "reassess_roadmap", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const result = await handleReassessRoadmap(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error reassessing roadmap: ${result.error}` }],
        details: { operation: "reassess_roadmap", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Reassessed roadmap for milestone ${result.milestoneId} after ${result.completedSliceId}` }],
      details: {
        operation: "reassess_roadmap",
        milestoneId: result.milestoneId,
        completedSliceId: result.completedSliceId,
        assessmentPath: result.assessmentPath,
        roadmapPath: result.roadmapPath
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `reassess_roadmap tool failed: ${msg}`, { tool: "gsd_reassess_roadmap", error: String(err) });
    return {
      content: [{ type: "text", text: `Error reassessing roadmap: ${msg}` }],
      details: { operation: "reassess_roadmap", error: msg },
      isError: true
    };
  }
}
async function executeSaveGateResult(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available." }],
      details: { operation: "save_gate_result", error: "db_unavailable" },
      isError: true
    };
  }
  const validGates = Object.keys(GATE_REGISTRY);
  if (!validGates.includes(params.gateId)) {
    return {
      content: [{ type: "text", text: `Error: Invalid gateId "${params.gateId}". Must be one of: ${validGates.join(", ")}` }],
      details: { operation: "save_gate_result", error: "invalid_gate_id" },
      isError: true
    };
  }
  const validVerdicts = ["pass", "flag", "omitted"];
  if (!validVerdicts.includes(params.verdict)) {
    return {
      content: [{ type: "text", text: `Error: Invalid verdict "${params.verdict}". Must be one of: ${validVerdicts.join(", ")}` }],
      details: { operation: "save_gate_result", error: "invalid_verdict" },
      isError: true
    };
  }
  try {
    saveGateResult({
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      gateId: params.gateId,
      taskId: params.taskId ?? "",
      verdict: params.verdict,
      rationale: params.rationale,
      findings: params.findings ?? ""
    });
    invalidateStateCache();
    return {
      content: [{ type: "text", text: `Gate ${params.gateId} result saved: verdict=${params.verdict}` }],
      details: { operation: "save_gate_result", gateId: params.gateId, verdict: params.verdict }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `gsd_save_gate_result failed: ${msg}`, { tool: "gsd_save_gate_result", error: String(err) });
    return {
      content: [{ type: "text", text: `Error saving gate result: ${msg}` }],
      details: { operation: "save_gate_result", error: msg },
      isError: true
    };
  }
}
async function executePlanMilestone(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot plan milestone." }],
      details: { operation: "plan_milestone", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const result = await handlePlanMilestone(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error planning milestone: ${result.error}` }],
        details: { operation: "plan_milestone", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Planned milestone ${result.milestoneId}` }],
      details: {
        operation: "plan_milestone",
        milestoneId: result.milestoneId,
        roadmapPath: result.roadmapPath
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `plan_milestone tool failed: ${msg}`, { tool: "gsd_plan_milestone", error: String(err) });
    return {
      content: [{ type: "text", text: `Error planning milestone: ${msg}` }],
      details: { operation: "plan_milestone", error: msg },
      isError: true
    };
  }
}
async function executePlanSlice(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot plan slice." }],
      details: { operation: "plan_slice", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const result = await handlePlanSlice(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error planning slice: ${result.error}` }],
        details: { operation: "plan_slice", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Planned slice ${result.sliceId} (${result.milestoneId})` }],
      details: {
        operation: "plan_slice",
        milestoneId: result.milestoneId,
        sliceId: result.sliceId,
        planPath: result.planPath,
        taskPlanPaths: result.taskPlanPaths
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `plan_slice tool failed: ${msg}`, { tool: "gsd_plan_slice", error: String(err) });
    return {
      content: [{ type: "text", text: `Error planning slice: ${msg}` }],
      details: { operation: "plan_slice", error: msg },
      isError: true
    };
  }
}
async function executeReplanSlice(params, basePath = process.cwd()) {
  const dbAvailable = await ensureDbOpen(basePath);
  if (!dbAvailable) {
    return {
      content: [{ type: "text", text: "Error: GSD database is not available. Cannot replan slice." }],
      details: { operation: "replan_slice", error: "db_unavailable" },
      isError: true
    };
  }
  try {
    const result = await handleReplanSlice(params, basePath);
    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error replanning slice: ${result.error}` }],
        details: { operation: "replan_slice", error: result.error },
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: `Replanned slice ${result.sliceId} (${result.milestoneId})` }],
      details: {
        operation: "replan_slice",
        milestoneId: result.milestoneId,
        sliceId: result.sliceId,
        replanPath: result.replanPath,
        planPath: result.planPath
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("tool", `replan_slice tool failed: ${msg}`, { tool: "gsd_replan_slice", error: String(err) });
    return {
      content: [{ type: "text", text: `Error replanning slice: ${msg}` }],
      details: { operation: "replan_slice", error: msg },
      isError: true
    };
  }
}
async function executeMilestoneStatus(params, basePath = process.cwd()) {
  try {
    const dbAvailable = await ensureDbOpen(basePath);
    if (!dbAvailable) {
      return {
        content: [{ type: "text", text: "Error: GSD database is not available." }],
        details: { operation: "milestone_status", error: "db_unavailable" },
        isError: true
      };
    }
    return readTransaction(() => {
      const milestone = getMilestone(params.milestoneId);
      if (!milestone) {
        return {
          content: [{ type: "text", text: `Milestone ${params.milestoneId} not found in database.` }],
          details: { operation: "milestone_status", milestoneId: params.milestoneId, found: false }
        };
      }
      const sliceStatuses = getSliceStatusSummary(params.milestoneId);
      const slices = sliceStatuses.map((s) => ({
        id: s.id,
        status: s.status,
        taskCounts: getSliceTaskCounts(params.milestoneId, s.id)
      }));
      const result = {
        milestoneId: milestone.id,
        title: milestone.title,
        status: milestone.status,
        createdAt: milestone.created_at,
        completedAt: milestone.completed_at,
        sliceCount: slices.length,
        slices
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { operation: "milestone_status", ...result }
      };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("tool", `gsd_milestone_status tool failed: ${msg}`);
    return {
      content: [{ type: "text", text: `Error querying milestone status: ${msg}` }],
      details: { operation: "milestone_status", error: msg },
      isError: true
    };
  }
}
export {
  SUPPORTED_SUMMARY_ARTIFACT_TYPES,
  executeCompleteMilestone,
  executeMilestoneReopen,
  executeMilestoneStatus,
  executePlanMilestone,
  executePlanSlice,
  executeReassessRoadmap,
  executeReplanSlice,
  executeSaveGateResult,
  executeSliceComplete,
  executeSliceReopen,
  executeSummarySave,
  executeTaskComplete,
  executeTaskReopen,
  executeValidateMilestone,
  isSupportedSummaryArtifactType
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL3Jlc291cmNlcy9leHRlbnNpb25zL2dzZC90b29scy93b3JrZmxvdy10b29sLWV4ZWN1dG9ycy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUHJvamVjdC9BcHA6IEdTRC0yXG4vLyBGaWxlIFB1cnBvc2U6IEFkYXB0cyBzaGFyZWQgR1NEIHdvcmtmbG93IGhhbmRsZXJzIGZvciBNQ1AgZXhlY3V0b3IgY2FsbHMuXG5cbmltcG9ydCB7IGVuc3VyZURiT3BlbiB9IGZyb20gXCIuLi9ib290c3RyYXAvZHluYW1pYy10b29scy5qc1wiO1xuaW1wb3J0IHsgc2FuaXRpemVDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcyB9IGZyb20gXCIuLi9ib290c3RyYXAvc2FuaXRpemUtY29tcGxldGUtbWlsZXN0b25lLmpzXCI7XG5pbXBvcnQgeyBsb2FkV3JpdGVHYXRlU25hcHNob3QsIHNob3VsZEJsb2NrQ29udGV4dEFydGlmYWN0U2F2ZUluU25hcHNob3QsIHNob3VsZEJsb2NrUm9vdEFydGlmYWN0U2F2ZUluU25hcHNob3QgfSBmcm9tIFwiLi4vYm9vdHN0cmFwL3dyaXRlLWdhdGUuanNcIjtcbmltcG9ydCB7XG4gIGdldEFjdGl2ZVJlcXVpcmVtZW50cyxcbiAgaW5zZXJ0TWlsZXN0b25lLFxuICBnZXRNaWxlc3RvbmUsXG4gIGdldFNsaWNlU3RhdHVzU3VtbWFyeSxcbiAgZ2V0U2xpY2VUYXNrQ291bnRzLFxuICByZWFkVHJhbnNhY3Rpb24sXG4gIHNhdmVHYXRlUmVzdWx0LFxufSBmcm9tIFwiLi4vZ3NkLWRiLmpzXCI7XG5pbXBvcnQgeyBHQVRFX1JFR0lTVFJZIH0gZnJvbSBcIi4uL2dhdGUtcmVnaXN0cnkuanNcIjtcbmltcG9ydCB7IGdlbmVyYXRlUmVxdWlyZW1lbnRzTWQsIHNhdmVBcnRpZmFjdFRvRGIgfSBmcm9tIFwiLi4vZGItd3JpdGVyLmpzXCI7XG5pbXBvcnQgeyByZXNvbHZlTWlsZXN0b25lRmlsZSwgcmVzb2x2ZVNsaWNlRmlsZSB9IGZyb20gXCIuLi9wYXRocy5qc1wiO1xuaW1wb3J0IHsgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgdHlwZSB7IENvbXBsZXRlTWlsZXN0b25lUGFyYW1zIH0gZnJvbSBcIi4vY29tcGxldGUtbWlsZXN0b25lLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZSB9IGZyb20gXCIuL2NvbXBsZXRlLW1pbGVzdG9uZS5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlQ29tcGxldGVUYXNrIH0gZnJvbSBcIi4vY29tcGxldGUtdGFzay5qc1wiO1xuaW1wb3J0IHR5cGUgeyBDb21wbGV0ZVNsaWNlUGFyYW1zIH0gZnJvbSBcIi4uL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVDb21wbGV0ZVNsaWNlIH0gZnJvbSBcIi4vY29tcGxldGUtc2xpY2UuanNcIjtcbmltcG9ydCB0eXBlIHsgUGxhbk1pbGVzdG9uZVBhcmFtcyB9IGZyb20gXCIuL3BsYW4tbWlsZXN0b25lLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVQbGFuTWlsZXN0b25lIH0gZnJvbSBcIi4vcGxhbi1taWxlc3RvbmUuanNcIjtcbmltcG9ydCB0eXBlIHsgUGxhblNsaWNlUGFyYW1zIH0gZnJvbSBcIi4vcGxhbi1zbGljZS5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlUGxhblNsaWNlIH0gZnJvbSBcIi4vcGxhbi1zbGljZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBSZXBsYW5TbGljZVBhcmFtcyB9IGZyb20gXCIuL3JlcGxhbi1zbGljZS5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlUmVwbGFuU2xpY2UgfSBmcm9tIFwiLi9yZXBsYW4tc2xpY2UuanNcIjtcbmltcG9ydCB0eXBlIHsgUmVvcGVuTWlsZXN0b25lUGFyYW1zIH0gZnJvbSBcIi4vcmVvcGVuLW1pbGVzdG9uZS5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlUmVvcGVuTWlsZXN0b25lIH0gZnJvbSBcIi4vcmVvcGVuLW1pbGVzdG9uZS5qc1wiO1xuaW1wb3J0IHR5cGUgeyBSZW9wZW5TbGljZVBhcmFtcyB9IGZyb20gXCIuL3Jlb3Blbi1zbGljZS5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlUmVvcGVuU2xpY2UgfSBmcm9tIFwiLi9yZW9wZW4tc2xpY2UuanNcIjtcbmltcG9ydCB0eXBlIHsgUmVvcGVuVGFza1BhcmFtcyB9IGZyb20gXCIuL3Jlb3Blbi10YXNrLmpzXCI7XG5pbXBvcnQgeyBoYW5kbGVSZW9wZW5UYXNrIH0gZnJvbSBcIi4vcmVvcGVuLXRhc2suanNcIjtcbmltcG9ydCB0eXBlIHsgUmVhc3Nlc3NSb2FkbWFwUGFyYW1zIH0gZnJvbSBcIi4vcmVhc3Nlc3Mtcm9hZG1hcC5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlUmVhc3Nlc3NSb2FkbWFwIH0gZnJvbSBcIi4vcmVhc3Nlc3Mtcm9hZG1hcC5qc1wiO1xuaW1wb3J0IHR5cGUgeyBWYWxpZGF0ZU1pbGVzdG9uZVBhcmFtcyB9IGZyb20gXCIuL3ZhbGlkYXRlLW1pbGVzdG9uZS5qc1wiO1xuaW1wb3J0IHsgaGFuZGxlVmFsaWRhdGVNaWxlc3RvbmUgfSBmcm9tIFwiLi92YWxpZGF0ZS1taWxlc3RvbmUuanNcIjtcbmltcG9ydCB7IGxvZ0Vycm9yLCBsb2dXYXJuaW5nIH0gZnJvbSBcIi4uL3dvcmtmbG93LWxvZ2dlci5qc1wiO1xuaW1wb3J0IHsgaW52YWxpZGF0ZVN0YXRlQ2FjaGUgfSBmcm9tIFwiLi4vc3RhdGUuanNcIjtcbmltcG9ydCB7IGxvYWRFZmZlY3RpdmVHU0RQcmVmZXJlbmNlcyB9IGZyb20gXCIuLi9wcmVmZXJlbmNlcy5qc1wiO1xuaW1wb3J0IHsgcGFyc2VQcm9qZWN0IH0gZnJvbSBcIi4uL3NjaGVtYXMvcGFyc2Vycy5qc1wiO1xuXG5leHBvcnQgY29uc3QgU1VQUE9SVEVEX1NVTU1BUllfQVJUSUZBQ1RfVFlQRVMgPSBbXG4gIFwiU1VNTUFSWVwiLFxuICBcIlJFU0VBUkNIXCIsXG4gIFwiQ09OVEVYVFwiLFxuICBcIkFTU0VTU01FTlRcIixcbiAgXCJDT05URVhULURSQUZUXCIsXG4gIFwiUFJPSkVDVFwiLFxuICBcIlBST0pFQ1QtRFJBRlRcIixcbiAgXCJSRVFVSVJFTUVOVFNcIixcbiAgXCJSRVFVSVJFTUVOVFMtRFJBRlRcIixcbl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1N1cHBvcnRlZFN1bW1hcnlBcnRpZmFjdFR5cGUoXG4gIGFydGlmYWN0VHlwZTogc3RyaW5nLFxuKTogYXJ0aWZhY3RUeXBlIGlzICh0eXBlb2YgU1VQUE9SVEVEX1NVTU1BUllfQVJUSUZBQ1RfVFlQRVMpW251bWJlcl0ge1xuICByZXR1cm4gKFNVUFBPUlRFRF9TVU1NQVJZX0FSVElGQUNUX1RZUEVTIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyhhcnRpZmFjdFR5cGUpO1xufVxuXG5mdW5jdGlvbiBpc1Jvb3RTdW1tYXJ5QXJ0aWZhY3RUeXBlKGFydGlmYWN0VHlwZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBhcnRpZmFjdFR5cGUgPT09IFwiUFJPSkVDVFwiIHx8XG4gICAgYXJ0aWZhY3RUeXBlID09PSBcIlBST0pFQ1QtRFJBRlRcIiB8fFxuICAgIGFydGlmYWN0VHlwZSA9PT0gXCJSRVFVSVJFTUVOVFNcIiB8fFxuICAgIGFydGlmYWN0VHlwZSA9PT0gXCJSRVFVSVJFTUVOVFMtRFJBRlRcIjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUb29sRXhlY3V0aW9uUmVzdWx0IHtcbiAgY29udGVudDogQXJyYXk8eyB0eXBlOiBcInRleHRcIjsgdGV4dDogc3RyaW5nIH0+O1xuICBkZXRhaWxzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgaXNFcnJvcj86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3VtbWFyeVNhdmVQYXJhbXMge1xuICBtaWxlc3RvbmVfaWQ/OiBzdHJpbmc7XG4gIHNsaWNlX2lkPzogc3RyaW5nO1xuICB0YXNrX2lkPzogc3RyaW5nO1xuICBhcnRpZmFjdF90eXBlOiBzdHJpbmc7XG4gIGNvbnRlbnQ6IHN0cmluZztcbn1cblxuZnVuY3Rpb24gcmVnaXN0ZXJQcm9qZWN0TWlsZXN0b25lU2VxdWVuY2UoY29udGVudDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZVByb2plY3QoY29udGVudCk7XG4gIGNvbnN0IHJlZ2lzdGVyZWQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgbWlsZXN0b25lIG9mIHBhcnNlZC5taWxlc3RvbmVzKSB7XG4gICAgaW5zZXJ0TWlsZXN0b25lKHtcbiAgICAgIGlkOiBtaWxlc3RvbmUuaWQsXG4gICAgICB0aXRsZTogbWlsZXN0b25lLnRpdGxlLFxuICAgICAgc3RhdHVzOiBtaWxlc3RvbmUuZG9uZSA/IFwiY29tcGxldGVcIiA6IFwicXVldWVkXCIsXG4gICAgfSk7XG4gICAgcmVnaXN0ZXJlZC5wdXNoKG1pbGVzdG9uZS5pZCk7XG4gIH1cbiAgcmV0dXJuIHJlZ2lzdGVyZWQ7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlU3VtbWFyeVNhdmUoXG4gIHBhcmFtczogU3VtbWFyeVNhdmVQYXJhbXMsXG4gIGJhc2VQYXRoOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpLFxuKTogUHJvbWlzZTxUb29sRXhlY3V0aW9uUmVzdWx0PiB7XG4gIGNvbnN0IGRiQXZhaWxhYmxlID0gYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgaWYgKCFkYkF2YWlsYWJsZSkge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvcjogR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGUuIENhbm5vdCBzYXZlIGFydGlmYWN0LlwiIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwic2F2ZV9zdW1tYXJ5XCIsIGVycm9yOiBcImRiX3VuYXZhaWxhYmxlXCIgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxuICBpZiAoIWlzU3VwcG9ydGVkU3VtbWFyeUFydGlmYWN0VHlwZShwYXJhbXMuYXJ0aWZhY3RfdHlwZSkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvcjogSW52YWxpZCBhcnRpZmFjdF90eXBlIFwiJHtwYXJhbXMuYXJ0aWZhY3RfdHlwZX1cIi4gTXVzdCBiZSBvbmUgb2Y6ICR7U1VQUE9SVEVEX1NVTU1BUllfQVJUSUZBQ1RfVFlQRVMuam9pbihcIiwgXCIpfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJzYXZlX3N1bW1hcnlcIiwgZXJyb3I6IFwiaW52YWxpZF9hcnRpZmFjdF90eXBlXCIgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxuICBpZiAoIWlzUm9vdFN1bW1hcnlBcnRpZmFjdFR5cGUocGFyYW1zLmFydGlmYWN0X3R5cGUpICYmICFwYXJhbXMubWlsZXN0b25lX2lkKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3I6IG1pbGVzdG9uZV9pZCBpcyByZXF1aXJlZCBmb3IgYXJ0aWZhY3RfdHlwZSBcIiR7cGFyYW1zLmFydGlmYWN0X3R5cGV9XCIuIFJvb3QtbGV2ZWwgYXJ0aWZhY3RzIG11c3QgdXNlIFBST0pFQ1QsIFBST0pFQ1QtRFJBRlQsIFJFUVVJUkVNRU5UUywgb3IgUkVRVUlSRU1FTlRTLURSQUZULmAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJzYXZlX3N1bW1hcnlcIiwgZXJyb3I6IFwibWlzc2luZ19taWxlc3RvbmVfaWRcIiB9LFxuICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IHdyaXRlR2F0ZVNuYXBzaG90ID0gbG9hZFdyaXRlR2F0ZVNuYXBzaG90KGJhc2VQYXRoKTtcbiAgY29uc3QgcHJlZnMgPSBsb2FkRWZmZWN0aXZlR1NEUHJlZmVyZW5jZXMoYmFzZVBhdGgpPy5wcmVmZXJlbmNlcztcbiAgY29uc3Qgcm9vdEFydGlmYWN0R3VhcmQgPSBzaG91bGRCbG9ja1Jvb3RBcnRpZmFjdFNhdmVJblNuYXBzaG90KFxuICAgIHdyaXRlR2F0ZVNuYXBzaG90LFxuICAgIHBhcmFtcy5hcnRpZmFjdF90eXBlLFxuICAgIHsgcmVxdWlyZVZlcmlmaWVkQXBwcm92YWw6IHByZWZzPy5wbGFubmluZ19kZXB0aCA9PT0gXCJkZWVwXCIgfSxcbiAgKTtcbiAgaWYgKHJvb3RBcnRpZmFjdEd1YXJkLmJsb2NrKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3Igc2F2aW5nIGFydGlmYWN0OiAke3Jvb3RBcnRpZmFjdEd1YXJkLnJlYXNvbiA/PyBcInJvb3QgYXJ0aWZhY3Qgd3JpdGUgYmxvY2tlZFwifWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJzYXZlX3N1bW1hcnlcIiwgZXJyb3I6IFwicm9vdF9hcnRpZmFjdF93cml0ZV9ibG9ja2VkXCIgfSxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgfTtcbiAgfVxuICBjb25zdCBjb250ZXh0R3VhcmQgPSBzaG91bGRCbG9ja0NvbnRleHRBcnRpZmFjdFNhdmVJblNuYXBzaG90KFxuICAgIHdyaXRlR2F0ZVNuYXBzaG90LFxuICAgIHBhcmFtcy5hcnRpZmFjdF90eXBlLFxuICAgIHBhcmFtcy5taWxlc3RvbmVfaWQgPz8gbnVsbCxcbiAgICBwYXJhbXMuc2xpY2VfaWQgPz8gbnVsbCxcbiAgKTtcbiAgaWYgKGNvbnRleHRHdWFyZC5ibG9jaykge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yIHNhdmluZyBhcnRpZmFjdDogJHtjb250ZXh0R3VhcmQucmVhc29uID8/IFwiY29udGV4dCB3cml0ZSBibG9ja2VkXCJ9YCB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInNhdmVfc3VtbWFyeVwiLCBlcnJvcjogXCJjb250ZXh0X3dyaXRlX2Jsb2NrZWRcIiB9LFxuICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICB9XG4gIHRyeSB7XG4gICAgbGV0IHJlbGF0aXZlUGF0aDogc3RyaW5nO1xuICAgIGlmIChwYXJhbXMuYXJ0aWZhY3RfdHlwZSA9PT0gXCJQUk9KRUNUXCIpIHtcbiAgICAgIHJlbGF0aXZlUGF0aCA9IFwiUFJPSkVDVC5tZFwiO1xuICAgIH0gZWxzZSBpZiAocGFyYW1zLmFydGlmYWN0X3R5cGUgPT09IFwiUFJPSkVDVC1EUkFGVFwiKSB7XG4gICAgICByZWxhdGl2ZVBhdGggPSBcIlBST0pFQ1QtRFJBRlQubWRcIjtcbiAgICB9IGVsc2UgaWYgKHBhcmFtcy5hcnRpZmFjdF90eXBlID09PSBcIlJFUVVJUkVNRU5UU1wiKSB7XG4gICAgICByZWxhdGl2ZVBhdGggPSBcIlJFUVVJUkVNRU5UUy5tZFwiO1xuICAgIH0gZWxzZSBpZiAocGFyYW1zLmFydGlmYWN0X3R5cGUgPT09IFwiUkVRVUlSRU1FTlRTLURSQUZUXCIpIHtcbiAgICAgIHJlbGF0aXZlUGF0aCA9IFwiUkVRVUlSRU1FTlRTLURSQUZULm1kXCI7XG4gICAgfSBlbHNlIGlmIChwYXJhbXMudGFza19pZCAmJiBwYXJhbXMuc2xpY2VfaWQpIHtcbiAgICAgIHJlbGF0aXZlUGF0aCA9IGBtaWxlc3RvbmVzLyR7cGFyYW1zLm1pbGVzdG9uZV9pZH0vc2xpY2VzLyR7cGFyYW1zLnNsaWNlX2lkfS90YXNrcy8ke3BhcmFtcy50YXNrX2lkfS0ke3BhcmFtcy5hcnRpZmFjdF90eXBlfS5tZGA7XG4gICAgfSBlbHNlIGlmIChwYXJhbXMuc2xpY2VfaWQpIHtcbiAgICAgIHJlbGF0aXZlUGF0aCA9IGBtaWxlc3RvbmVzLyR7cGFyYW1zLm1pbGVzdG9uZV9pZH0vc2xpY2VzLyR7cGFyYW1zLnNsaWNlX2lkfS8ke3BhcmFtcy5zbGljZV9pZH0tJHtwYXJhbXMuYXJ0aWZhY3RfdHlwZX0ubWRgO1xuICAgIH0gZWxzZSB7XG4gICAgICByZWxhdGl2ZVBhdGggPSBgbWlsZXN0b25lcy8ke3BhcmFtcy5taWxlc3RvbmVfaWR9LyR7cGFyYW1zLm1pbGVzdG9uZV9pZH0tJHtwYXJhbXMuYXJ0aWZhY3RfdHlwZX0ubWRgO1xuICAgIH1cblxuICAgIGNvbnN0IGFjdGl2ZVJlcXVpcmVtZW50cyA9IHBhcmFtcy5hcnRpZmFjdF90eXBlID09PSBcIlJFUVVJUkVNRU5UU1wiXG4gICAgICA/IGdldEFjdGl2ZVJlcXVpcmVtZW50cygpXG4gICAgICA6IG51bGw7XG4gICAgaWYgKHBhcmFtcy5hcnRpZmFjdF90eXBlID09PSBcIlJFUVVJUkVNRU5UU1wiICYmIGFjdGl2ZVJlcXVpcmVtZW50cz8ubGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvcjogQ2Fubm90IHNhdmUgUkVRVUlSRU1FTlRTIGFydGlmYWN0IFx1MjAxNCBubyBhY3RpdmUgcmVxdWlyZW1lbnRzIGZvdW5kIGluIHRoZSBkYXRhYmFzZS4gQ2FsbCBnc2RfcmVxdWlyZW1lbnRfc2F2ZSBmb3IgZWFjaCByZXF1aXJlbWVudCBiZWZvcmUgY2FsbGluZyBnc2Rfc3VtbWFyeV9zYXZlKFJFUVVJUkVNRU5UUykuXCIgfV0sXG4gICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInNhdmVfc3VtbWFyeVwiLCBlcnJvcjogXCJub19hY3RpdmVfcmVxdWlyZW1lbnRzXCIgfSxcbiAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgY29uc3QgY29udGVudFRvU2F2ZSA9IHBhcmFtcy5hcnRpZmFjdF90eXBlID09PSBcIlJFUVVJUkVNRU5UU1wiXG4gICAgICA/IGdlbmVyYXRlUmVxdWlyZW1lbnRzTWQoYWN0aXZlUmVxdWlyZW1lbnRzID8/IFtdKVxuICAgICAgOiBwYXJhbXMuY29udGVudDtcbiAgICBjb25zdCBjb250ZW50U291cmNlID0gcGFyYW1zLmFydGlmYWN0X3R5cGUgPT09IFwiUkVRVUlSRU1FTlRTXCJcbiAgICAgID8gXCJyZXF1aXJlbWVudHNfdGFibGVcIlxuICAgICAgOiBcInByb3ZpZGVkX2NvbnRlbnRcIjtcbiAgICBjb25zdCBpc1Jvb3RBcnRpZmFjdCA9IGlzUm9vdFN1bW1hcnlBcnRpZmFjdFR5cGUocGFyYW1zLmFydGlmYWN0X3R5cGUpO1xuXG4gICAgYXdhaXQgc2F2ZUFydGlmYWN0VG9EYihcbiAgICAgIHtcbiAgICAgICAgcGF0aDogcmVsYXRpdmVQYXRoLFxuICAgICAgICBhcnRpZmFjdF90eXBlOiBwYXJhbXMuYXJ0aWZhY3RfdHlwZSxcbiAgICAgICAgY29udGVudDogY29udGVudFRvU2F2ZSxcbiAgICAgICAgbWlsZXN0b25lX2lkOiBpc1Jvb3RBcnRpZmFjdCA/IHVuZGVmaW5lZCA6IHBhcmFtcy5taWxlc3RvbmVfaWQsXG4gICAgICAgIHNsaWNlX2lkOiBpc1Jvb3RBcnRpZmFjdCA/IHVuZGVmaW5lZCA6IHBhcmFtcy5zbGljZV9pZCxcbiAgICAgICAgdGFza19pZDogaXNSb290QXJ0aWZhY3QgPyB1bmRlZmluZWQgOiBwYXJhbXMudGFza19pZCxcbiAgICAgIH0sXG4gICAgICBiYXNlUGF0aCxcbiAgICApO1xuXG4gICAgbGV0IHJlZ2lzdGVyZWRNaWxlc3RvbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChwYXJhbXMuYXJ0aWZhY3RfdHlwZSA9PT0gXCJQUk9KRUNUXCIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlZ2lzdGVyZWRNaWxlc3RvbmVzID0gcmVnaXN0ZXJQcm9qZWN0TWlsZXN0b25lU2VxdWVuY2UoY29udGVudFRvU2F2ZSk7XG4gICAgICAgIGlmIChyZWdpc3RlcmVkTWlsZXN0b25lcy5sZW5ndGggPiAwKSBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICAgICAgbG9nRXJyb3IoXCJ0b29sXCIsIGBnc2Rfc3VtbWFyeV9zYXZlOiBQUk9KRUNUIGFydGlmYWN0IHBlcnNpc3RlZCBidXQgbWlsZXN0b25lIHJlZ2lzdHJhdGlvbiB0aHJldzogJHttc2d9YCwge1xuICAgICAgICAgIHRvb2w6IFwiZ3NkX3N1bW1hcnlfc2F2ZVwiLFxuICAgICAgICAgIGVycm9yOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICBzdGFjazogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgPz8gXCJcIiA6IFwiXCIsXG4gICAgICAgIH0pO1xuICAgICAgICAvLyBQUk9KRUNULm1kIHdhcyBwZXJzaXN0ZWQgYnkgc2F2ZUFydGlmYWN0VG9EYiBhYm92ZTsgdGhlIGFydGlmYWN0cyByb3dcbiAgICAgICAgLy8gY2hhbmdlZCBldmVuIHRob3VnaCBubyBtaWxlc3RvbmVzIHJlZ2lzdGVyZWQuIEludmFsaWRhdGUgc28gc3Vic2VxdWVudFxuICAgICAgICAvLyAvZ3NkIHJlYWRzIHNlZSB0aGUgcGVyc2lzdGVkIGFydGlmYWN0IGluc3RlYWQgb2YgdGhlIHByZS1zYXZlIGNhY2hlLlxuICAgICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7XG4gICAgICAgICAgICB0eXBlOiBcInRleHRcIixcbiAgICAgICAgICAgIHRleHQ6XG4gICAgICAgICAgICAgIGBFcnJvcjogUFJPSkVDVC5tZCB3YXMgc2F2ZWQgdG8gJHtyZWxhdGl2ZVBhdGh9IGJ1dCBtaWxlc3RvbmUgcmVnaXN0cmF0aW9uIGZhaWxlZDogJHttc2d9LiBgICtcbiAgICAgICAgICAgICAgYFRoZSBEQiBoYXMgbm8gbWlsZXN0b25lIHJvd3MgZm9yIHRoaXMgcHJvamVjdCwgc28gL2dzZCB3aWxsIHJlcG9ydCBcIk5vIEFjdGl2ZSBNaWxlc3RvbmVcIi4gYCArXG4gICAgICAgICAgICAgIGBSZS1jYWxsIGdzZF9zdW1tYXJ5X3NhdmUoUFJPSkVDVCkgb25jZSB0aGUgdW5kZXJseWluZyBlcnJvciBpcyByZXNvbHZlZCBcdTIwMTQgSU5TRVJUIE9SIElHTk9SRSBtYWtlcyByZWdpc3RyYXRpb24gaWRlbXBvdGVudC5gLFxuICAgICAgICAgIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgICAgIG9wZXJhdGlvbjogXCJzYXZlX3N1bW1hcnlcIixcbiAgICAgICAgICAgIHBhdGg6IHJlbGF0aXZlUGF0aCxcbiAgICAgICAgICAgIGFydGlmYWN0X3R5cGU6IHBhcmFtcy5hcnRpZmFjdF90eXBlLFxuICAgICAgICAgICAgZXJyb3I6IFwibWlsZXN0b25lX3JlZ2lzdHJhdGlvbl90aHJld1wiLFxuICAgICAgICAgICAgcmVnaXN0cmF0aW9uX2Vycm9yOiBtc2csXG4gICAgICAgICAgfSxcbiAgICAgICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKHJlZ2lzdGVyZWRNaWxlc3RvbmVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBsb2dFcnJvcihcInRvb2xcIiwgYGdzZF9zdW1tYXJ5X3NhdmU6IFBST0pFQ1QubWQgc2F2ZWQgdG8gJHtyZWxhdGl2ZVBhdGh9IGJ1dCBwYXJzZWQgemVybyBtaWxlc3RvbmVzIFx1MjAxNCByZWdpc3RyYXRpb24gcHJvZHVjZWQgbm8gREIgcm93c2AsIHtcbiAgICAgICAgICB0b29sOiBcImdzZF9zdW1tYXJ5X3NhdmVcIixcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIFBST0pFQ1QubWQgd2FzIHBlcnNpc3RlZDsgaW52YWxpZGF0ZSBzbyBzdWJzZXF1ZW50IHJlYWRzIHNlZSB0aGUgbmV3XG4gICAgICAgIC8vIGFydGlmYWN0cyByb3cgZXZlbiB0aG91Z2ggbm8gbWlsZXN0b25lcyByZWdpc3RlcmVkLlxuICAgICAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIGNvbnRlbnQ6IFt7XG4gICAgICAgICAgICB0eXBlOiBcInRleHRcIixcbiAgICAgICAgICAgIHRleHQ6XG4gICAgICAgICAgICAgIGBFcnJvcjogUFJPSkVDVC5tZCB3YXMgc2F2ZWQgdG8gJHtyZWxhdGl2ZVBhdGh9IGJ1dCBjb250YWlucyB6ZXJvIHBhcnNlYWJsZSBtaWxlc3RvbmUgbGluZXMsIGAgK1xuICAgICAgICAgICAgICBgc28gbm8gbWlsZXN0b25lcyB3ZXJlIHJlZ2lzdGVyZWQgaW4gdGhlIERCLiAvZ3NkIHdpbGwgcmVwb3J0IFwiTm8gQWN0aXZlIE1pbGVzdG9uZVwiLiBgICtcbiAgICAgICAgICAgICAgYFJld3JpdGUgUFJPSkVDVC5tZCBzbyB0aGUgXCJNaWxlc3RvbmUgU2VxdWVuY2VcIiBzZWN0aW9uIHVzZXMgY2Fub25pY2FsIGxpbmVzOiBgICtcbiAgICAgICAgICAgICAgYFxcYC0gWyBdIE0wMDE6IDxUaXRsZT4gXHUyMDE0IDxPbmUtbGluZXI+XFxgIChlbS1kYXNoLCBkb3VibGUtZGFzaCBcXGAtLVxcYCwgb3Igc2luZ2xlLWRhc2ggXFxgLVxcYCBzZXBhcmF0b3IpLCB0aGVuIHJlLWNhbGwgZ3NkX3N1bW1hcnlfc2F2ZShQUk9KRUNUKS5gLFxuICAgICAgICAgIH1dLFxuICAgICAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgICAgIG9wZXJhdGlvbjogXCJzYXZlX3N1bW1hcnlcIixcbiAgICAgICAgICAgIHBhdGg6IHJlbGF0aXZlUGF0aCxcbiAgICAgICAgICAgIGFydGlmYWN0X3R5cGU6IHBhcmFtcy5hcnRpZmFjdF90eXBlLFxuICAgICAgICAgICAgZXJyb3I6IFwibWlsZXN0b25lX3JlZ2lzdHJhdGlvbl9lbXB0eV9wYXJzZVwiLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocGFyYW1zLmFydGlmYWN0X3R5cGUgPT09IFwiQ09OVEVYVFwiICYmICFwYXJhbXMudGFza19pZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZHJhZnRGaWxlID0gcGFyYW1zLnNsaWNlX2lkXG4gICAgICAgICAgPyByZXNvbHZlU2xpY2VGaWxlKGJhc2VQYXRoLCBwYXJhbXMubWlsZXN0b25lX2lkISwgcGFyYW1zLnNsaWNlX2lkLCBcIkNPTlRFWFQtRFJBRlRcIilcbiAgICAgICAgICA6IHJlc29sdmVNaWxlc3RvbmVGaWxlKGJhc2VQYXRoLCBwYXJhbXMubWlsZXN0b25lX2lkISwgXCJDT05URVhULURSQUZUXCIpO1xuICAgICAgICBpZiAoZHJhZnRGaWxlKSB1bmxpbmtTeW5jKGRyYWZ0RmlsZSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGxvZ1dhcm5pbmcoXCJ0b29sXCIsIGBDT05URVhULURSQUZULm1kIHVubGluayBmYWlsZWQ6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgU2F2ZWQgJHtwYXJhbXMuYXJ0aWZhY3RfdHlwZX0gYXJ0aWZhY3QgdG8gJHtyZWxhdGl2ZVBhdGh9YCB9XSxcbiAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgb3BlcmF0aW9uOiBcInNhdmVfc3VtbWFyeVwiLFxuICAgICAgICBwYXRoOiByZWxhdGl2ZVBhdGgsXG4gICAgICAgIGFydGlmYWN0X3R5cGU6IHBhcmFtcy5hcnRpZmFjdF90eXBlLFxuICAgICAgICBjb250ZW50X3NvdXJjZTogY29udGVudFNvdXJjZSxcbiAgICAgICAgLi4uKHJlZ2lzdGVyZWRNaWxlc3RvbmVzLmxlbmd0aCA+IDAgPyB7IHJlZ2lzdGVyZWRNaWxlc3RvbmVzIH0gOiB7fSksXG4gICAgICB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dFcnJvcihcInRvb2xcIiwgYGdzZF9zdW1tYXJ5X3NhdmUgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2Rfc3VtbWFyeV9zYXZlXCIsIGVycm9yOiBTdHJpbmcoZXJyKSB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvciBzYXZpbmcgYXJ0aWZhY3Q6ICR7bXNnfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJzYXZlX3N1bW1hcnlcIiwgZXJyb3I6IG1zZyB9LFxuICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICB9XG59XG5cbnR5cGUgVmVyaWZpY2F0aW9uRXZpZGVuY2VJbnB1dCA9XG4gIHwge1xuICAgICAgY29tbWFuZDogc3RyaW5nO1xuICAgICAgZXhpdENvZGU6IG51bWJlcjtcbiAgICAgIHZlcmRpY3Q6IHN0cmluZztcbiAgICAgIGR1cmF0aW9uTXM6IG51bWJlcjtcbiAgICB9XG4gIHwgc3RyaW5nO1xuXG5leHBvcnQgaW50ZXJmYWNlIFRhc2tDb21wbGV0ZVBhcmFtcyB7XG4gIHRhc2tJZDogc3RyaW5nO1xuICBzbGljZUlkOiBzdHJpbmc7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIG9uZUxpbmVyOiBzdHJpbmc7XG4gIG5hcnJhdGl2ZTogc3RyaW5nO1xuICB2ZXJpZmljYXRpb246IHN0cmluZztcbiAgZGV2aWF0aW9ucz86IHN0cmluZztcbiAga25vd25Jc3N1ZXM/OiBzdHJpbmc7XG4gIGtleUZpbGVzPzogc3RyaW5nW107XG4gIGtleURlY2lzaW9ucz86IHN0cmluZ1tdO1xuICBibG9ja2VyRGlzY292ZXJlZD86IGJvb2xlYW47XG4gIHZlcmlmaWNhdGlvbkV2aWRlbmNlPzogVmVyaWZpY2F0aW9uRXZpZGVuY2VJbnB1dFtdO1xufVxuXG5leHBvcnQgdHlwZSBDb21wbGV0ZU1pbGVzdG9uZUV4ZWN1dG9yUGFyYW1zID0gUGFydGlhbDxDb21wbGV0ZU1pbGVzdG9uZVBhcmFtcz4gJiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbmV4cG9ydCB0eXBlIFNsaWNlQ29tcGxldGVFeGVjdXRvclBhcmFtcyA9IENvbXBsZXRlU2xpY2VQYXJhbXM7XG5leHBvcnQgdHlwZSBQbGFuTWlsZXN0b25lRXhlY3V0b3JQYXJhbXMgPSBQbGFuTWlsZXN0b25lUGFyYW1zO1xuZXhwb3J0IHR5cGUgUGxhblNsaWNlRXhlY3V0b3JQYXJhbXMgPSBQbGFuU2xpY2VQYXJhbXM7XG5leHBvcnQgdHlwZSBSZXBsYW5TbGljZUV4ZWN1dG9yUGFyYW1zID0gUmVwbGFuU2xpY2VQYXJhbXM7XG5leHBvcnQgdHlwZSBSZW9wZW5UYXNrRXhlY3V0b3JQYXJhbXMgPSBSZW9wZW5UYXNrUGFyYW1zO1xuZXhwb3J0IHR5cGUgUmVvcGVuU2xpY2VFeGVjdXRvclBhcmFtcyA9IFJlb3BlblNsaWNlUGFyYW1zO1xuZXhwb3J0IHR5cGUgUmVvcGVuTWlsZXN0b25lRXhlY3V0b3JQYXJhbXMgPSBSZW9wZW5NaWxlc3RvbmVQYXJhbXM7XG5leHBvcnQgdHlwZSBWYWxpZGF0ZU1pbGVzdG9uZUV4ZWN1dG9yUGFyYW1zID0gVmFsaWRhdGVNaWxlc3RvbmVQYXJhbXM7XG5leHBvcnQgdHlwZSBSZWFzc2Vzc1JvYWRtYXBFeGVjdXRvclBhcmFtcyA9IFJlYXNzZXNzUm9hZG1hcFBhcmFtcztcblxuZXhwb3J0IGludGVyZmFjZSBTYXZlR2F0ZVJlc3VsdFBhcmFtcyB7XG4gIG1pbGVzdG9uZUlkOiBzdHJpbmc7XG4gIHNsaWNlSWQ6IHN0cmluZztcbiAgZ2F0ZUlkOiBzdHJpbmc7XG4gIHRhc2tJZD86IHN0cmluZztcbiAgdmVyZGljdDogXCJwYXNzXCIgfCBcImZsYWdcIiB8IFwib21pdHRlZFwiO1xuICByYXRpb25hbGU6IHN0cmluZztcbiAgZmluZGluZ3M/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlVGFza0NvbXBsZXRlKFxuICBwYXJhbXM6IFRhc2tDb21wbGV0ZVBhcmFtcyxcbiAgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4pOiBQcm9taXNlPFRvb2xFeGVjdXRpb25SZXN1bHQ+IHtcbiAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICBpZiAoIWRiQXZhaWxhYmxlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS4gQ2Fubm90IGNvbXBsZXRlIHRhc2suXCIgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJjb21wbGV0ZV90YXNrXCIsIGVycm9yOiBcImRiX3VuYXZhaWxhYmxlXCIgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IGNvZXJjZWQgPSB7IC4uLnBhcmFtcyB9O1xuICAgIGNvZXJjZWQudmVyaWZpY2F0aW9uRXZpZGVuY2UgPSAocGFyYW1zLnZlcmlmaWNhdGlvbkV2aWRlbmNlID8/IFtdKS5tYXAoKHYpID0+XG4gICAgICB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IHsgY29tbWFuZDogdiwgZXhpdENvZGU6IC0xLCB2ZXJkaWN0OiBcInVua25vd24gKGNvZXJjZWQgZnJvbSBzdHJpbmcpXCIsIGR1cmF0aW9uTXM6IDAgfSA6IHYsXG4gICAgKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZUNvbXBsZXRlVGFzayhjb2VyY2VkIGFzIGFueSwgYmFzZVBhdGgpO1xuICAgIGlmIChcImVycm9yXCIgaW4gcmVzdWx0KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yIGNvbXBsZXRpbmcgdGFzazogJHtyZXN1bHQuZXJyb3J9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiY29tcGxldGVfdGFza1wiLCBlcnJvcjogcmVzdWx0LmVycm9yIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQ29tcGxldGVkIHRhc2sgJHtyZXN1bHQudGFza0lkfSAoJHtyZXN1bHQuc2xpY2VJZH0vJHtyZXN1bHQubWlsZXN0b25lSWR9KWAgfV0sXG4gICAgICBkZXRhaWxzOiB7XG4gICAgICAgIG9wZXJhdGlvbjogXCJjb21wbGV0ZV90YXNrXCIsXG4gICAgICAgIHRhc2tJZDogcmVzdWx0LnRhc2tJZCxcbiAgICAgICAgc2xpY2VJZDogcmVzdWx0LnNsaWNlSWQsXG4gICAgICAgIG1pbGVzdG9uZUlkOiByZXN1bHQubWlsZXN0b25lSWQsXG4gICAgICAgIHN1bW1hcnlQYXRoOiByZXN1bHQuc3VtbWFyeVBhdGgsXG4gICAgICB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dFcnJvcihcInRvb2xcIiwgYGNvbXBsZXRlX3Rhc2sgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2RfdGFza19jb21wbGV0ZVwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgY29tcGxldGluZyB0YXNrOiAke21zZ31gIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiY29tcGxldGVfdGFza1wiLCBlcnJvcjogbXNnIH0sXG4gICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVUYXNrUmVvcGVuKFxuICBwYXJhbXM6IFJlb3BlblRhc2tFeGVjdXRvclBhcmFtcyxcbiAgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4pOiBQcm9taXNlPFRvb2xFeGVjdXRpb25SZXN1bHQ+IHtcbiAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICBpZiAoIWRiQXZhaWxhYmxlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS4gQ2Fubm90IHJlb3BlbiB0YXNrLlwiIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVvcGVuX3Rhc2tcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9LFxuICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICB9O1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVvcGVuVGFzayhwYXJhbXMsIGJhc2VQYXRoKTtcbiAgICBpZiAoXCJlcnJvclwiIGluIHJlc3VsdCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvciByZW9wZW5pbmcgdGFzazogJHtyZXN1bHQuZXJyb3J9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVvcGVuX3Rhc2tcIiwgZXJyb3I6IHJlc3VsdC5lcnJvciB9LFxuICAgICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgUmVvcGVuZWQgdGFzayAke3Jlc3VsdC50YXNrSWR9ICgke3Jlc3VsdC5zbGljZUlkfS8ke3Jlc3VsdC5taWxlc3RvbmVJZH0pYCB9XSxcbiAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgb3BlcmF0aW9uOiBcInJlb3Blbl90YXNrXCIsXG4gICAgICAgIHRhc2tJZDogcmVzdWx0LnRhc2tJZCxcbiAgICAgICAgc2xpY2VJZDogcmVzdWx0LnNsaWNlSWQsXG4gICAgICAgIG1pbGVzdG9uZUlkOiByZXN1bHQubWlsZXN0b25lSWQsXG4gICAgICB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dFcnJvcihcInRvb2xcIiwgYHJlb3Blbl90YXNrIHRvb2wgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX3Rhc2tfcmVvcGVuXCIsIGVycm9yOiBTdHJpbmcoZXJyKSB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvciByZW9wZW5pbmcgdGFzazogJHttc2d9YCB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInJlb3Blbl90YXNrXCIsIGVycm9yOiBtc2cgfSxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgfTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVNsaWNlUmVvcGVuKFxuICBwYXJhbXM6IFJlb3BlblNsaWNlRXhlY3V0b3JQYXJhbXMsXG4gIGJhc2VQYXRoOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpLFxuKTogUHJvbWlzZTxUb29sRXhlY3V0aW9uUmVzdWx0PiB7XG4gIGNvbnN0IGRiQXZhaWxhYmxlID0gYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgaWYgKCFkYkF2YWlsYWJsZSkge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvcjogR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGUuIENhbm5vdCByZW9wZW4gc2xpY2UuXCIgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJyZW9wZW5fc2xpY2VcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9LFxuICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICB9O1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVvcGVuU2xpY2UocGFyYW1zLCBiYXNlUGF0aCk7XG4gICAgaWYgKFwiZXJyb3JcIiBpbiByZXN1bHQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgcmVvcGVuaW5nIHNsaWNlOiAke3Jlc3VsdC5lcnJvcn1gIH1dLFxuICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJyZW9wZW5fc2xpY2VcIiwgZXJyb3I6IHJlc3VsdC5lcnJvciB9LFxuICAgICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgUmVvcGVuZWQgc2xpY2UgJHtyZXN1bHQuc2xpY2VJZH0gKCR7cmVzdWx0Lm1pbGVzdG9uZUlkfSlgIH1dLFxuICAgICAgZGV0YWlsczoge1xuICAgICAgICBvcGVyYXRpb246IFwicmVvcGVuX3NsaWNlXCIsXG4gICAgICAgIHNsaWNlSWQ6IHJlc3VsdC5zbGljZUlkLFxuICAgICAgICBtaWxlc3RvbmVJZDogcmVzdWx0Lm1pbGVzdG9uZUlkLFxuICAgICAgICB0YXNrc1Jlc2V0OiByZXN1bHQudGFza3NSZXNldCxcbiAgICAgIH0sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgcmVvcGVuX3NsaWNlIHRvb2wgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX3NsaWNlX3Jlb3BlblwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgcmVvcGVuaW5nIHNsaWNlOiAke21zZ31gIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVvcGVuX3NsaWNlXCIsIGVycm9yOiBtc2cgfSxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgfTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZU1pbGVzdG9uZVJlb3BlbihcbiAgcGFyYW1zOiBSZW9wZW5NaWxlc3RvbmVFeGVjdXRvclBhcmFtcyxcbiAgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4pOiBQcm9taXNlPFRvb2xFeGVjdXRpb25SZXN1bHQ+IHtcbiAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICBpZiAoIWRiQXZhaWxhYmxlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS4gQ2Fubm90IHJlb3BlbiBtaWxlc3RvbmUuXCIgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJyZW9wZW5fbWlsZXN0b25lXCIsIGVycm9yOiBcImRiX3VuYXZhaWxhYmxlXCIgfSxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgfTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVJlb3Blbk1pbGVzdG9uZShwYXJhbXMsIGJhc2VQYXRoKTtcbiAgICBpZiAoXCJlcnJvclwiIGluIHJlc3VsdCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvciByZW9wZW5pbmcgbWlsZXN0b25lOiAke3Jlc3VsdC5lcnJvcn1gIH1dLFxuICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJyZW9wZW5fbWlsZXN0b25lXCIsIGVycm9yOiByZXN1bHQuZXJyb3IgfSxcbiAgICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFJlb3BlbmVkIG1pbGVzdG9uZSAke3Jlc3VsdC5taWxlc3RvbmVJZH1gIH1dLFxuICAgICAgZGV0YWlsczoge1xuICAgICAgICBvcGVyYXRpb246IFwicmVvcGVuX21pbGVzdG9uZVwiLFxuICAgICAgICBtaWxlc3RvbmVJZDogcmVzdWx0Lm1pbGVzdG9uZUlkLFxuICAgICAgICBzbGljZXNSZXNldDogcmVzdWx0LnNsaWNlc1Jlc2V0LFxuICAgICAgICB0YXNrc1Jlc2V0OiByZXN1bHQudGFza3NSZXNldCxcbiAgICAgIH0sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgcmVvcGVuX21pbGVzdG9uZSB0b29sIGZhaWxlZDogJHttc2d9YCwgeyB0b29sOiBcImdzZF9taWxlc3RvbmVfcmVvcGVuXCIsIGVycm9yOiBTdHJpbmcoZXJyKSB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvciByZW9wZW5pbmcgbWlsZXN0b25lOiAke21zZ31gIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVvcGVuX21pbGVzdG9uZVwiLCBlcnJvcjogbXNnIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgIH07XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVTbGljZUNvbXBsZXRlKFxuICBwYXJhbXM6IFNsaWNlQ29tcGxldGVFeGVjdXRvclBhcmFtcyxcbiAgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4pOiBQcm9taXNlPFRvb2xFeGVjdXRpb25SZXN1bHQ+IHtcbiAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICBpZiAoIWRiQXZhaWxhYmxlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS4gQ2Fubm90IGNvbXBsZXRlIHNsaWNlLlwiIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiY29tcGxldGVfc2xpY2VcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9LFxuICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3Qgc3BsaXRQYWlyID0gKHM6IHN0cmluZyk6IFtzdHJpbmcsIHN0cmluZ10gPT4ge1xuICAgICAgY29uc3QgbSA9IHMubWF0Y2goL14oLis/KVxccyooPzpcdTIwMTR8LSlcXHMrKC4rKSQvKTtcbiAgICAgIHJldHVybiBtID8gW21bMV0udHJpbSgpLCBtWzJdLnRyaW0oKV0gOiBbcy50cmltKCksIFwiXCJdO1xuICAgIH07XG4gICAgY29uc3Qgd3JhcEFycmF5ID0gKHY6IHVua25vd24pOiB1bmtub3duW10gPT5cbiAgICAgIHYgPT0gbnVsbCA/IFtdIDogQXJyYXkuaXNBcnJheSh2KSA/IHYgOiBbdl07XG5cbiAgICBjb25zdCBjb2VyY2VkID0geyAuLi5wYXJhbXMgfSBhcyBDb21wbGV0ZVNsaWNlUGFyYW1zICYgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgY29lcmNlZC5wcm92aWRlcyA9IHdyYXBBcnJheShwYXJhbXMucHJvdmlkZXMpIGFzIHN0cmluZ1tdO1xuICAgIGNvZXJjZWQua2V5RmlsZXMgPSB3cmFwQXJyYXkocGFyYW1zLmtleUZpbGVzKSBhcyBzdHJpbmdbXTtcbiAgICBjb2VyY2VkLmtleURlY2lzaW9ucyA9IHdyYXBBcnJheShwYXJhbXMua2V5RGVjaXNpb25zKSBhcyBzdHJpbmdbXTtcbiAgICBjb2VyY2VkLnBhdHRlcm5zRXN0YWJsaXNoZWQgPSB3cmFwQXJyYXkocGFyYW1zLnBhdHRlcm5zRXN0YWJsaXNoZWQpIGFzIHN0cmluZ1tdO1xuICAgIGNvZXJjZWQub2JzZXJ2YWJpbGl0eVN1cmZhY2VzID0gd3JhcEFycmF5KHBhcmFtcy5vYnNlcnZhYmlsaXR5U3VyZmFjZXMpIGFzIHN0cmluZ1tdO1xuICAgIGNvZXJjZWQucmVxdWlyZW1lbnRzU3VyZmFjZWQgPSB3cmFwQXJyYXkocGFyYW1zLnJlcXVpcmVtZW50c1N1cmZhY2VkKSBhcyBzdHJpbmdbXTtcbiAgICBjb2VyY2VkLmRyaWxsRG93blBhdGhzID0gd3JhcEFycmF5KHBhcmFtcy5kcmlsbERvd25QYXRocykgYXMgc3RyaW5nW107XG4gICAgY29lcmNlZC5hZmZlY3RzID0gd3JhcEFycmF5KHBhcmFtcy5hZmZlY3RzKSBhcyBzdHJpbmdbXTtcbiAgICBjb2VyY2VkLmZpbGVzTW9kaWZpZWQgPSB3cmFwQXJyYXkocGFyYW1zLmZpbGVzTW9kaWZpZWQpLm1hcCgoZikgPT4ge1xuICAgICAgaWYgKHR5cGVvZiBmICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZjtcbiAgICAgIGNvbnN0IFtwYXRoLCBkZXNjcmlwdGlvbl0gPSBzcGxpdFBhaXIoZik7XG4gICAgICByZXR1cm4geyBwYXRoLCBkZXNjcmlwdGlvbiB9O1xuICAgIH0pIGFzIEFycmF5PHsgcGF0aDogc3RyaW5nOyBkZXNjcmlwdGlvbjogc3RyaW5nIH0+O1xuICAgIGNvZXJjZWQucmVxdWlyZXMgPSB3cmFwQXJyYXkocGFyYW1zLnJlcXVpcmVzKS5tYXAoKHIpID0+IHtcbiAgICAgIGlmICh0eXBlb2YgciAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIHI7XG4gICAgICBjb25zdCBbc2xpY2UsIHByb3ZpZGVzXSA9IHNwbGl0UGFpcihyKTtcbiAgICAgIHJldHVybiB7IHNsaWNlLCBwcm92aWRlcyB9O1xuICAgIH0pIGFzIEFycmF5PHsgc2xpY2U6IHN0cmluZzsgcHJvdmlkZXM6IHN0cmluZyB9PjtcbiAgICBjb2VyY2VkLnJlcXVpcmVtZW50c0FkdmFuY2VkID0gd3JhcEFycmF5KHBhcmFtcy5yZXF1aXJlbWVudHNBZHZhbmNlZCkubWFwKChyKSA9PiB7XG4gICAgICBpZiAodHlwZW9mIHIgIT09IFwic3RyaW5nXCIpIHJldHVybiByO1xuICAgICAgY29uc3QgW2lkLCBob3ddID0gc3BsaXRQYWlyKHIpO1xuICAgICAgcmV0dXJuIHsgaWQsIGhvdyB9O1xuICAgIH0pIGFzIEFycmF5PHsgaWQ6IHN0cmluZzsgaG93OiBzdHJpbmcgfT47XG4gICAgY29lcmNlZC5yZXF1aXJlbWVudHNWYWxpZGF0ZWQgPSB3cmFwQXJyYXkocGFyYW1zLnJlcXVpcmVtZW50c1ZhbGlkYXRlZCkubWFwKChyKSA9PiB7XG4gICAgICBpZiAodHlwZW9mIHIgIT09IFwic3RyaW5nXCIpIHJldHVybiByO1xuICAgICAgY29uc3QgW2lkLCBwcm9vZl0gPSBzcGxpdFBhaXIocik7XG4gICAgICByZXR1cm4geyBpZCwgcHJvb2YgfTtcbiAgICB9KSBhcyBBcnJheTx7IGlkOiBzdHJpbmc7IHByb29mOiBzdHJpbmcgfT47XG4gICAgY29lcmNlZC5yZXF1aXJlbWVudHNJbnZhbGlkYXRlZCA9IHdyYXBBcnJheShwYXJhbXMucmVxdWlyZW1lbnRzSW52YWxpZGF0ZWQpLm1hcCgocikgPT4ge1xuICAgICAgaWYgKHR5cGVvZiByICE9PSBcInN0cmluZ1wiKSByZXR1cm4gcjtcbiAgICAgIGNvbnN0IFtpZCwgd2hhdF0gPSBzcGxpdFBhaXIocik7XG4gICAgICByZXR1cm4geyBpZCwgd2hhdCB9O1xuICAgIH0pIGFzIEFycmF5PHsgaWQ6IHN0cmluZzsgd2hhdDogc3RyaW5nIH0+O1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlQ29tcGxldGVTbGljZShjb2VyY2VkIGFzIENvbXBsZXRlU2xpY2VQYXJhbXMsIGJhc2VQYXRoKTtcbiAgICBpZiAoXCJlcnJvclwiIGluIHJlc3VsdCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvciBjb21wbGV0aW5nIHNsaWNlOiAke3Jlc3VsdC5lcnJvcn1gIH1dLFxuICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJjb21wbGV0ZV9zbGljZVwiLCBlcnJvcjogcmVzdWx0LmVycm9yIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgQ29tcGxldGVkIHNsaWNlICR7cmVzdWx0LnNsaWNlSWR9ICgke3Jlc3VsdC5taWxlc3RvbmVJZH0pYCB9XSxcbiAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgb3BlcmF0aW9uOiBcImNvbXBsZXRlX3NsaWNlXCIsXG4gICAgICAgIHNsaWNlSWQ6IHJlc3VsdC5zbGljZUlkLFxuICAgICAgICBtaWxlc3RvbmVJZDogcmVzdWx0Lm1pbGVzdG9uZUlkLFxuICAgICAgICBzdW1tYXJ5UGF0aDogcmVzdWx0LnN1bW1hcnlQYXRoLFxuICAgICAgICB1YXRQYXRoOiByZXN1bHQudWF0UGF0aCxcbiAgICAgIH0sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgY29tcGxldGVfc2xpY2UgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2Rfc2xpY2VfY29tcGxldGVcIiwgZXJyb3I6IFN0cmluZyhlcnIpIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yIGNvbXBsZXRpbmcgc2xpY2U6ICR7bXNnfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJjb21wbGV0ZV9zbGljZVwiLCBlcnJvcjogbXNnIH0sXG4gICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVDb21wbGV0ZU1pbGVzdG9uZShcbiAgcGFyYW1zOiBDb21wbGV0ZU1pbGVzdG9uZUV4ZWN1dG9yUGFyYW1zLFxuICBiYXNlUGF0aDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKSxcbik6IFByb21pc2U8VG9vbEV4ZWN1dGlvblJlc3VsdD4ge1xuICBjb25zdCBkYkF2YWlsYWJsZSA9IGF3YWl0IGVuc3VyZURiT3BlbihiYXNlUGF0aCk7XG4gIGlmICghZGJBdmFpbGFibGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRXJyb3I6IEdTRCBkYXRhYmFzZSBpcyBub3QgYXZhaWxhYmxlLiBDYW5ub3QgY29tcGxldGUgbWlsZXN0b25lLlwiIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiY29tcGxldGVfbWlsZXN0b25lXCIsIGVycm9yOiBcImRiX3VuYXZhaWxhYmxlXCIgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHNhbml0aXplZCA9IHNhbml0aXplQ29tcGxldGVNaWxlc3RvbmVQYXJhbXMocGFyYW1zKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVDb21wbGV0ZU1pbGVzdG9uZShzYW5pdGl6ZWQsIGJhc2VQYXRoKTtcbiAgICBpZiAoXCJlcnJvclwiIGluIHJlc3VsdCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvciBjb21wbGV0aW5nIG1pbGVzdG9uZTogJHtyZXN1bHQuZXJyb3J9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwiY29tcGxldGVfbWlsZXN0b25lXCIsIGVycm9yOiByZXN1bHQuZXJyb3IgfSxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCBtZXNzYWdlID0gcmVzdWx0LmFscmVhZHlDb21wbGV0ZVxuICAgICAgPyBgTWlsZXN0b25lICR7cmVzdWx0Lm1pbGVzdG9uZUlkfSBpcyBhbHJlYWR5IGNvbXBsZXRlLiBTdW1tYXJ5IGF2YWlsYWJsZSBhdCAke3Jlc3VsdC5zdW1tYXJ5UGF0aH1gXG4gICAgICA6IGBDb21wbGV0ZWQgbWlsZXN0b25lICR7cmVzdWx0Lm1pbGVzdG9uZUlkfS4gU3VtbWFyeSB3cml0dGVuIHRvICR7cmVzdWx0LnN1bW1hcnlQYXRofWA7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBtZXNzYWdlIH1dLFxuICAgICAgZGV0YWlsczoge1xuICAgICAgICBvcGVyYXRpb246IFwiY29tcGxldGVfbWlsZXN0b25lXCIsXG4gICAgICAgIG1pbGVzdG9uZUlkOiByZXN1bHQubWlsZXN0b25lSWQsXG4gICAgICAgIHN1bW1hcnlQYXRoOiByZXN1bHQuc3VtbWFyeVBhdGgsXG4gICAgICAgIC4uLihyZXN1bHQuYWxyZWFkeUNvbXBsZXRlID8geyBhbHJlYWR5Q29tcGxldGU6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgLi4uKHJlc3VsdC5zdGFsZSA/IHsgc3RhbGU6IHRydWUgfSA6IHt9KSxcbiAgICAgIH0sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgY29tcGxldGVfbWlsZXN0b25lIHRvb2wgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX2NvbXBsZXRlX21pbGVzdG9uZVwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgY29tcGxldGluZyBtaWxlc3RvbmU6ICR7bXNnfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJjb21wbGV0ZV9taWxlc3RvbmVcIiwgZXJyb3I6IG1zZyB9LFxuICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlVmFsaWRhdGVNaWxlc3RvbmUoXG4gIHBhcmFtczogVmFsaWRhdGVNaWxlc3RvbmVFeGVjdXRvclBhcmFtcyxcbiAgYmFzZVBhdGg6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4pOiBQcm9taXNlPFRvb2xFeGVjdXRpb25SZXN1bHQ+IHtcbiAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICBpZiAoIWRiQXZhaWxhYmxlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS4gQ2Fubm90IHZhbGlkYXRlIG1pbGVzdG9uZS5cIiB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInZhbGlkYXRlX21pbGVzdG9uZVwiLCBlcnJvcjogXCJkYl91bmF2YWlsYWJsZVwiIH0sXG4gICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVWYWxpZGF0ZU1pbGVzdG9uZShwYXJhbXMsIGJhc2VQYXRoKTtcbiAgICBpZiAoXCJlcnJvclwiIGluIHJlc3VsdCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvciB2YWxpZGF0aW5nIG1pbGVzdG9uZTogJHtyZXN1bHQuZXJyb3J9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwidmFsaWRhdGVfbWlsZXN0b25lXCIsIGVycm9yOiByZXN1bHQuZXJyb3IgfSxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBWYWxpZGF0ZWQgbWlsZXN0b25lICR7cmVzdWx0Lm1pbGVzdG9uZUlkfSBcdTIwMTQgdmVyZGljdDogJHtyZXN1bHQudmVyZGljdH0uIFdyaXR0ZW4gdG8gJHtyZXN1bHQudmFsaWRhdGlvblBhdGh9YCB9XSxcbiAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgb3BlcmF0aW9uOiBcInZhbGlkYXRlX21pbGVzdG9uZVwiLFxuICAgICAgICBtaWxlc3RvbmVJZDogcmVzdWx0Lm1pbGVzdG9uZUlkLFxuICAgICAgICB2ZXJkaWN0OiByZXN1bHQudmVyZGljdCxcbiAgICAgICAgdmFsaWRhdGlvblBhdGg6IHJlc3VsdC52YWxpZGF0aW9uUGF0aCxcbiAgICAgIH0sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgdmFsaWRhdGVfbWlsZXN0b25lIHRvb2wgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX3ZhbGlkYXRlX21pbGVzdG9uZVwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgdmFsaWRhdGluZyBtaWxlc3RvbmU6ICR7bXNnfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJ2YWxpZGF0ZV9taWxlc3RvbmVcIiwgZXJyb3I6IG1zZyB9LFxuICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlUmVhc3Nlc3NSb2FkbWFwKFxuICBwYXJhbXM6IFJlYXNzZXNzUm9hZG1hcEV4ZWN1dG9yUGFyYW1zLFxuICBiYXNlUGF0aDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKSxcbik6IFByb21pc2U8VG9vbEV4ZWN1dGlvblJlc3VsdD4ge1xuICBjb25zdCBkYkF2YWlsYWJsZSA9IGF3YWl0IGVuc3VyZURiT3BlbihiYXNlUGF0aCk7XG4gIGlmICghZGJBdmFpbGFibGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRXJyb3I6IEdTRCBkYXRhYmFzZSBpcyBub3QgYXZhaWxhYmxlLiBDYW5ub3QgcmVhc3Nlc3Mgcm9hZG1hcC5cIiB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInJlYXNzZXNzX3JvYWRtYXBcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9LFxuICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVhc3Nlc3NSb2FkbWFwKHBhcmFtcywgYmFzZVBhdGgpO1xuICAgIGlmIChcImVycm9yXCIgaW4gcmVzdWx0KSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yIHJlYXNzZXNzaW5nIHJvYWRtYXA6ICR7cmVzdWx0LmVycm9yfWAgfV0sXG4gICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInJlYXNzZXNzX3JvYWRtYXBcIiwgZXJyb3I6IHJlc3VsdC5lcnJvciB9LFxuICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFJlYXNzZXNzZWQgcm9hZG1hcCBmb3IgbWlsZXN0b25lICR7cmVzdWx0Lm1pbGVzdG9uZUlkfSBhZnRlciAke3Jlc3VsdC5jb21wbGV0ZWRTbGljZUlkfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7XG4gICAgICAgIG9wZXJhdGlvbjogXCJyZWFzc2Vzc19yb2FkbWFwXCIsXG4gICAgICAgIG1pbGVzdG9uZUlkOiByZXN1bHQubWlsZXN0b25lSWQsXG4gICAgICAgIGNvbXBsZXRlZFNsaWNlSWQ6IHJlc3VsdC5jb21wbGV0ZWRTbGljZUlkLFxuICAgICAgICBhc3Nlc3NtZW50UGF0aDogcmVzdWx0LmFzc2Vzc21lbnRQYXRoLFxuICAgICAgICByb2FkbWFwUGF0aDogcmVzdWx0LnJvYWRtYXBQYXRoLFxuICAgICAgfSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgbG9nRXJyb3IoXCJ0b29sXCIsIGByZWFzc2Vzc19yb2FkbWFwIHRvb2wgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX3JlYXNzZXNzX3JvYWRtYXBcIiwgZXJyb3I6IFN0cmluZyhlcnIpIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yIHJlYXNzZXNzaW5nIHJvYWRtYXA6ICR7bXNnfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJyZWFzc2Vzc19yb2FkbWFwXCIsIGVycm9yOiBtc2cgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVNhdmVHYXRlUmVzdWx0KFxuICBwYXJhbXM6IFNhdmVHYXRlUmVzdWx0UGFyYW1zLFxuICBiYXNlUGF0aDogc3RyaW5nID0gcHJvY2Vzcy5jd2QoKSxcbik6IFByb21pc2U8VG9vbEV4ZWN1dGlvblJlc3VsdD4ge1xuICBjb25zdCBkYkF2YWlsYWJsZSA9IGF3YWl0IGVuc3VyZURiT3BlbihiYXNlUGF0aCk7XG4gIGlmICghZGJBdmFpbGFibGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IFwiRXJyb3I6IEdTRCBkYXRhYmFzZSBpcyBub3QgYXZhaWxhYmxlLlwiIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwic2F2ZV9nYXRlX3Jlc3VsdFwiLCBlcnJvcjogXCJkYl91bmF2YWlsYWJsZVwiIH0sXG4gICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gIH1cblxuICAvLyBTb3VyY2Ugb2YgdHJ1dGg6IGdhdGUtcmVnaXN0cnkudHMuIEV2ZXJ5IGRlY2xhcmVkIEdhdGVJZCBpcyBhY2NlcHRlZCxcbiAgLy8gc28gYWRkaW5nIGEgbmV3IGdhdGUgaW4gb25lIHBsYWNlIGF1dG9tYXRpY2FsbHkgZmxvd3MgdGhyb3VnaCBoZXJlLlxuICBjb25zdCB2YWxpZEdhdGVzID0gT2JqZWN0LmtleXMoR0FURV9SRUdJU1RSWSk7XG4gIGlmICghdmFsaWRHYXRlcy5pbmNsdWRlcyhwYXJhbXMuZ2F0ZUlkKSkge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yOiBJbnZhbGlkIGdhdGVJZCBcIiR7cGFyYW1zLmdhdGVJZH1cIi4gTXVzdCBiZSBvbmUgb2Y6ICR7dmFsaWRHYXRlcy5qb2luKFwiLCBcIil9YCB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInNhdmVfZ2F0ZV9yZXN1bHRcIiwgZXJyb3I6IFwiaW52YWxpZF9nYXRlX2lkXCIgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxuXG4gIGNvbnN0IHZhbGlkVmVyZGljdHMgPSBbXCJwYXNzXCIsIFwiZmxhZ1wiLCBcIm9taXR0ZWRcIl07XG4gIGlmICghdmFsaWRWZXJkaWN0cy5pbmNsdWRlcyhwYXJhbXMudmVyZGljdCkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvcjogSW52YWxpZCB2ZXJkaWN0IFwiJHtwYXJhbXMudmVyZGljdH1cIi4gTXVzdCBiZSBvbmUgb2Y6ICR7dmFsaWRWZXJkaWN0cy5qb2luKFwiLCBcIil9YCB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInNhdmVfZ2F0ZV9yZXN1bHRcIiwgZXJyb3I6IFwiaW52YWxpZF92ZXJkaWN0XCIgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgc2F2ZUdhdGVSZXN1bHQoe1xuICAgICAgbWlsZXN0b25lSWQ6IHBhcmFtcy5taWxlc3RvbmVJZCxcbiAgICAgIHNsaWNlSWQ6IHBhcmFtcy5zbGljZUlkLFxuICAgICAgZ2F0ZUlkOiBwYXJhbXMuZ2F0ZUlkLFxuICAgICAgdGFza0lkOiBwYXJhbXMudGFza0lkID8/IFwiXCIsXG4gICAgICB2ZXJkaWN0OiBwYXJhbXMudmVyZGljdCxcbiAgICAgIHJhdGlvbmFsZTogcGFyYW1zLnJhdGlvbmFsZSxcbiAgICAgIGZpbmRpbmdzOiBwYXJhbXMuZmluZGluZ3MgPz8gXCJcIixcbiAgICB9KTtcbiAgICBpbnZhbGlkYXRlU3RhdGVDYWNoZSgpO1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEdhdGUgJHtwYXJhbXMuZ2F0ZUlkfSByZXN1bHQgc2F2ZWQ6IHZlcmRpY3Q9JHtwYXJhbXMudmVyZGljdH1gIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwic2F2ZV9nYXRlX3Jlc3VsdFwiLCBnYXRlSWQ6IHBhcmFtcy5nYXRlSWQsIHZlcmRpY3Q6IHBhcmFtcy52ZXJkaWN0IH0sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgZ3NkX3NhdmVfZ2F0ZV9yZXN1bHQgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX3NhdmVfZ2F0ZV9yZXN1bHRcIiwgZXJyb3I6IFN0cmluZyhlcnIpIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yIHNhdmluZyBnYXRlIHJlc3VsdDogJHttc2d9YCB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInNhdmVfZ2F0ZV9yZXN1bHRcIiwgZXJyb3I6IG1zZyB9LFxuICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBleGVjdXRlUGxhbk1pbGVzdG9uZShcbiAgcGFyYW1zOiBQbGFuTWlsZXN0b25lRXhlY3V0b3JQYXJhbXMsXG4gIGJhc2VQYXRoOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpLFxuKTogUHJvbWlzZTxUb29sRXhlY3V0aW9uUmVzdWx0PiB7XG4gIGNvbnN0IGRiQXZhaWxhYmxlID0gYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgaWYgKCFkYkF2YWlsYWJsZSkge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvcjogR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGUuIENhbm5vdCBwbGFuIG1pbGVzdG9uZS5cIiB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInBsYW5fbWlsZXN0b25lXCIsIGVycm9yOiBcImRiX3VuYXZhaWxhYmxlXCIgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGhhbmRsZVBsYW5NaWxlc3RvbmUocGFyYW1zLCBiYXNlUGF0aCk7XG4gICAgaWYgKFwiZXJyb3JcIiBpbiByZXN1bHQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgcGxhbm5pbmcgbWlsZXN0b25lOiAke3Jlc3VsdC5lcnJvcn1gIH1dLFxuICAgICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJwbGFuX21pbGVzdG9uZVwiLCBlcnJvcjogcmVzdWx0LmVycm9yIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgUGxhbm5lZCBtaWxlc3RvbmUgJHtyZXN1bHQubWlsZXN0b25lSWR9YCB9XSxcbiAgICAgIGRldGFpbHM6IHtcbiAgICAgICAgb3BlcmF0aW9uOiBcInBsYW5fbWlsZXN0b25lXCIsXG4gICAgICAgIG1pbGVzdG9uZUlkOiByZXN1bHQubWlsZXN0b25lSWQsXG4gICAgICAgIHJvYWRtYXBQYXRoOiByZXN1bHQucm9hZG1hcFBhdGgsXG4gICAgICB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dFcnJvcihcInRvb2xcIiwgYHBsYW5fbWlsZXN0b25lIHRvb2wgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX3BsYW5fbWlsZXN0b25lXCIsIGVycm9yOiBTdHJpbmcoZXJyKSB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBFcnJvciBwbGFubmluZyBtaWxlc3RvbmU6ICR7bXNnfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJwbGFuX21pbGVzdG9uZVwiLCBlcnJvcjogbXNnIH0sXG4gICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGV4ZWN1dGVQbGFuU2xpY2UoXG4gIHBhcmFtczogUGxhblNsaWNlRXhlY3V0b3JQYXJhbXMsXG4gIGJhc2VQYXRoOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpLFxuKTogUHJvbWlzZTxUb29sRXhlY3V0aW9uUmVzdWx0PiB7XG4gIGNvbnN0IGRiQXZhaWxhYmxlID0gYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgaWYgKCFkYkF2YWlsYWJsZSkge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvcjogR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGUuIENhbm5vdCBwbGFuIHNsaWNlLlwiIH1dLFxuICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicGxhbl9zbGljZVwiLCBlcnJvcjogXCJkYl91bmF2YWlsYWJsZVwiIH0sXG4gICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBoYW5kbGVQbGFuU2xpY2UocGFyYW1zLCBiYXNlUGF0aCk7XG4gICAgaWYgKFwiZXJyb3JcIiBpbiByZXN1bHQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgcGxhbm5pbmcgc2xpY2U6ICR7cmVzdWx0LmVycm9yfWAgfV0sXG4gICAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInBsYW5fc2xpY2VcIiwgZXJyb3I6IHJlc3VsdC5lcnJvciB9LFxuICAgICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYFBsYW5uZWQgc2xpY2UgJHtyZXN1bHQuc2xpY2VJZH0gKCR7cmVzdWx0Lm1pbGVzdG9uZUlkfSlgIH1dLFxuICAgICAgZGV0YWlsczoge1xuICAgICAgICBvcGVyYXRpb246IFwicGxhbl9zbGljZVwiLFxuICAgICAgICBtaWxlc3RvbmVJZDogcmVzdWx0Lm1pbGVzdG9uZUlkLFxuICAgICAgICBzbGljZUlkOiByZXN1bHQuc2xpY2VJZCxcbiAgICAgICAgcGxhblBhdGg6IHJlc3VsdC5wbGFuUGF0aCxcbiAgICAgICAgdGFza1BsYW5QYXRoczogcmVzdWx0LnRhc2tQbGFuUGF0aHMsXG4gICAgICB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dFcnJvcihcInRvb2xcIiwgYHBsYW5fc2xpY2UgdG9vbCBmYWlsZWQ6ICR7bXNnfWAsIHsgdG9vbDogXCJnc2RfcGxhbl9zbGljZVwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgcGxhbm5pbmcgc2xpY2U6ICR7bXNnfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJwbGFuX3NsaWNlXCIsIGVycm9yOiBtc2cgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZVJlcGxhblNsaWNlKFxuICBwYXJhbXM6IFJlcGxhblNsaWNlRXhlY3V0b3JQYXJhbXMsXG4gIGJhc2VQYXRoOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpLFxuKTogUHJvbWlzZTxUb29sRXhlY3V0aW9uUmVzdWx0PiB7XG4gIGNvbnN0IGRiQXZhaWxhYmxlID0gYXdhaXQgZW5zdXJlRGJPcGVuKGJhc2VQYXRoKTtcbiAgaWYgKCFkYkF2YWlsYWJsZSkge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogXCJFcnJvcjogR1NEIGRhdGFiYXNlIGlzIG5vdCBhdmFpbGFibGUuIENhbm5vdCByZXBsYW4gc2xpY2UuXCIgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJyZXBsYW5fc2xpY2VcIiwgZXJyb3I6IFwiZGJfdW5hdmFpbGFibGVcIiB9LFxuICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaGFuZGxlUmVwbGFuU2xpY2UocGFyYW1zLCBiYXNlUGF0aCk7XG4gICAgaWYgKFwiZXJyb3JcIiBpbiByZXN1bHQpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgcmVwbGFubmluZyBzbGljZTogJHtyZXN1bHQuZXJyb3J9YCB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwicmVwbGFuX3NsaWNlXCIsIGVycm9yOiByZXN1bHQuZXJyb3IgfSxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgICB9O1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgY29udGVudDogW3sgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IGBSZXBsYW5uZWQgc2xpY2UgJHtyZXN1bHQuc2xpY2VJZH0gKCR7cmVzdWx0Lm1pbGVzdG9uZUlkfSlgIH1dLFxuICAgICAgZGV0YWlsczoge1xuICAgICAgICBvcGVyYXRpb246IFwicmVwbGFuX3NsaWNlXCIsXG4gICAgICAgIG1pbGVzdG9uZUlkOiByZXN1bHQubWlsZXN0b25lSWQsXG4gICAgICAgIHNsaWNlSWQ6IHJlc3VsdC5zbGljZUlkLFxuICAgICAgICByZXBsYW5QYXRoOiByZXN1bHQucmVwbGFuUGF0aCxcbiAgICAgICAgcGxhblBhdGg6IHJlc3VsdC5wbGFuUGF0aCxcbiAgICAgIH0sXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc3QgbXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGxvZ0Vycm9yKFwidG9vbFwiLCBgcmVwbGFuX3NsaWNlIHRvb2wgZmFpbGVkOiAke21zZ31gLCB7IHRvb2w6IFwiZ3NkX3JlcGxhbl9zbGljZVwiLCBlcnJvcjogU3RyaW5nKGVycikgfSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBgRXJyb3IgcmVwbGFubmluZyBzbGljZTogJHttc2d9YCB9XSxcbiAgICAgIGRldGFpbHM6IHsgb3BlcmF0aW9uOiBcInJlcGxhbl9zbGljZVwiLCBlcnJvcjogbXNnIH0sXG4gICAgaXNFcnJvcjogdHJ1ZSxcbiAgICAgIH07XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBNaWxlc3RvbmVTdGF0dXNQYXJhbXMge1xuICBtaWxlc3RvbmVJZDogc3RyaW5nO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXhlY3V0ZU1pbGVzdG9uZVN0YXR1cyhcbiAgcGFyYW1zOiBNaWxlc3RvbmVTdGF0dXNQYXJhbXMsXG4gIGJhc2VQYXRoOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpLFxuKTogUHJvbWlzZTxUb29sRXhlY3V0aW9uUmVzdWx0PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgZGJBdmFpbGFibGUgPSBhd2FpdCBlbnN1cmVEYk9wZW4oYmFzZVBhdGgpO1xuICAgIGlmICghZGJBdmFpbGFibGUpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6IFt7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBcIkVycm9yOiBHU0QgZGF0YWJhc2UgaXMgbm90IGF2YWlsYWJsZS5cIiB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwibWlsZXN0b25lX3N0YXR1c1wiLCBlcnJvcjogXCJkYl91bmF2YWlsYWJsZVwiIH0sXG4gICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVhZFRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICAgIGNvbnN0IG1pbGVzdG9uZSA9IGdldE1pbGVzdG9uZShwYXJhbXMubWlsZXN0b25lSWQpO1xuICAgICAgaWYgKCFtaWxlc3RvbmUpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYE1pbGVzdG9uZSAke3BhcmFtcy5taWxlc3RvbmVJZH0gbm90IGZvdW5kIGluIGRhdGFiYXNlLmAgfV0sXG4gICAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwibWlsZXN0b25lX3N0YXR1c1wiLCBtaWxlc3RvbmVJZDogcGFyYW1zLm1pbGVzdG9uZUlkLCBmb3VuZDogZmFsc2UgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cblxuICAgICAgY29uc3Qgc2xpY2VTdGF0dXNlcyA9IGdldFNsaWNlU3RhdHVzU3VtbWFyeShwYXJhbXMubWlsZXN0b25lSWQpO1xuICAgICAgY29uc3Qgc2xpY2VzID0gc2xpY2VTdGF0dXNlcy5tYXAoKHMpID0+ICh7XG4gICAgICAgIGlkOiBzLmlkLFxuICAgICAgICBzdGF0dXM6IHMuc3RhdHVzLFxuICAgICAgICB0YXNrQ291bnRzOiBnZXRTbGljZVRhc2tDb3VudHMocGFyYW1zLm1pbGVzdG9uZUlkLCBzLmlkKSxcbiAgICAgIH0pKTtcblxuICAgICAgY29uc3QgcmVzdWx0ID0ge1xuICAgICAgICBtaWxlc3RvbmVJZDogbWlsZXN0b25lLmlkLFxuICAgICAgICB0aXRsZTogbWlsZXN0b25lLnRpdGxlLFxuICAgICAgICBzdGF0dXM6IG1pbGVzdG9uZS5zdGF0dXMsXG4gICAgICAgIGNyZWF0ZWRBdDogbWlsZXN0b25lLmNyZWF0ZWRfYXQsXG4gICAgICAgIGNvbXBsZXRlZEF0OiBtaWxlc3RvbmUuY29tcGxldGVkX2F0LFxuICAgICAgICBzbGljZUNvdW50OiBzbGljZXMubGVuZ3RoLFxuICAgICAgICBzbGljZXMsXG4gICAgICB9O1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogSlNPTi5zdHJpbmdpZnkocmVzdWx0LCBudWxsLCAyKSB9XSxcbiAgICAgICAgZGV0YWlsczogeyBvcGVyYXRpb246IFwibWlsZXN0b25lX3N0YXR1c1wiLCAuLi5yZXN1bHQgfSxcbiAgICAgIH07XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnN0IG1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBsb2dXYXJuaW5nKFwidG9vbFwiLCBgZ3NkX21pbGVzdG9uZV9zdGF0dXMgdG9vbCBmYWlsZWQ6ICR7bXNnfWApO1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OiBbeyB0eXBlOiBcInRleHRcIiwgdGV4dDogYEVycm9yIHF1ZXJ5aW5nIG1pbGVzdG9uZSBzdGF0dXM6ICR7bXNnfWAgfV0sXG4gICAgICBkZXRhaWxzOiB7IG9wZXJhdGlvbjogXCJtaWxlc3RvbmVfc3RhdHVzXCIsIGVycm9yOiBtc2cgfSxcbiAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBR0EsU0FBUyxvQkFBb0I7QUFDN0IsU0FBUyx1Q0FBdUM7QUFDaEQsU0FBUyx1QkFBdUIsMENBQTBDLDZDQUE2QztBQUN2SDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxPQUNLO0FBQ1AsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyx3QkFBd0Isd0JBQXdCO0FBQ3pELFNBQVMsc0JBQXNCLHdCQUF3QjtBQUN2RCxTQUFTLGtCQUFrQjtBQUUzQixTQUFTLCtCQUErQjtBQUN4QyxTQUFTLDBCQUEwQjtBQUVuQyxTQUFTLDJCQUEyQjtBQUVwQyxTQUFTLDJCQUEyQjtBQUVwQyxTQUFTLHVCQUF1QjtBQUVoQyxTQUFTLHlCQUF5QjtBQUVs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
